# Phần dùng chung của các bước Python (huấn luyện, hiệu chỉnh, xuất, đánh giá). Chạy với `python -I`; các
# script tự thêm thư mục tools/camera vào sys.path để nạp tệp này.
import json
import os
import platform
import subprocess
import sys

import numpy as np

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.abspath(os.path.join(TOOLS_DIR, "..", ".."))
DEFAULT_LABELS = os.path.join(APP_ROOT, "models", "labels.json")

FAMILIES = ["ring", "noentry", "bluering", "end", "triangle", "invtriangle", "octagon", "bluedisc", "bluerect",
            "diamond", "plate"]
DET_H, DET_W = 352, 640  # ảnh vào bộ dò khi chạy (hợp đồng 2)
STRIDE = 8  # ô đầu ra ứng với 8×8 điểm ảnh
CLS_SIZE = 48  # ảnh vào bộ phân loại (hợp đồng 3)
LOG_SIZE_MIN = float(np.log(4.0))  # cạnh khung nhỏ nhất bộ dò trả về được: 4 điểm ảnh
LOG_SIZE_MAX = float(np.log(400.0))  # lớn nhất: 400 điểm ảnh (giữ dải lượng tử hoá int8 hẹp)
# Giải mã giống hệt js/visionproto.js (SCORE_MIN, MAX_CANDIDATES, MAX_BOX_SIDE, NMS_IOU, MAX_BOXES); kiểm bằng
# tests/models.test.mjs (hằng số) và tools/camera/test_pipeline.py (chạy cả hai bộ giải mã trên cùng đầu ra).
PEAK_THRESHOLD = 0.30  # điểm đỉnh tối thiểu khi giải mã (PLAN §5.2)
MAX_CANDIDATES = 64  # số đỉnh điểm cao nhất giữ lại trước NMS
MAX_BOX_SIDE = 2 * DET_W  # cạnh khung lớn hơn chừng này (điểm ảnh ảnh vào) là đầu ra hỏng: bỏ
MAX_BOXES = 12  # số khung tối đa mỗi ảnh
NMS_IOU = 0.5  # bỏ khung chồng lên khung điểm cao hơn quá mức này (IoU)
ECE_BINS = 15  # số ngăn khi tính sai số hiệu chỉnh


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json_atomic(path, obj, indent=None):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
        f.write("\n")
    os.replace(tmp, path)


def write_labels(path, obj):
    """Ghi labels.json theo đúng dạng của labels.mjs (mỗi nhãn một dòng)."""
    head = {k: v for k, v in obj.items() if k != "labels"}
    text = json.dumps({**head, "labels": []}, ensure_ascii=False, indent=2)
    rows = ",\n".join("    " + json.dumps(l, ensure_ascii=False, separators=(",", ":")) for l in obj["labels"])
    text = text.replace('"labels": []', '"labels": [\n' + rows + "\n  ]") + "\n"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def set_determinism(seed):
    import tensorflow as tf
    import keras
    keras.utils.set_random_seed(seed)
    tf.config.experimental.enable_op_determinism()


# ------------------------------------------------------------------------------------------------ dữ liệu
def load_crops(data_dir, name):
    """Mọi phân đoạn <name>-<i>.u8/.json → (X uint8 [N,48,48,3], y int32, w float32, night uint8)."""
    xs, ys, ws, ns = [], [], [], []
    i = 0
    while os.path.exists(os.path.join(data_dir, f"{name}-{i}.json")):
        meta = load_json(os.path.join(data_dir, f"{name}-{i}.json"))
        x = np.fromfile(os.path.join(data_dir, f"{name}-{i}.u8"), dtype=np.uint8)
        x = x.reshape(-1, CLS_SIZE, CLS_SIZE, 3)
        if len(x) != meta["n"]:
            raise ValueError(f"{name}-{i}: số ảnh không khớp")
        xs.append(x)
        ys.append(np.asarray(meta["labels"], np.int32))
        ws.append(np.asarray(meta["w"], np.float32))
        ns.append(np.asarray(meta["night"], np.uint8))
        i += 1
    if not xs:
        raise FileNotFoundError(f"không có dữ liệu {name} trong {data_dir}")
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(ws), np.concatenate(ns)


def load_crop_field(data_dir, name, field):
    """Một trường phụ của các phân đoạn ảnh cắt (ví dụ "req": cạnh yêu cầu của tập testw)."""
    out = []
    i = 0
    while os.path.exists(os.path.join(data_dir, f"{name}-{i}.json")):
        out.extend(load_json(os.path.join(data_dir, f"{name}-{i}.json"))[field])
        i += 1
    return np.asarray(out)


def load_scenes(data_dir, name):
    """Mọi phân đoạn <name>-<i>.json → danh sách bản ghi { path, geo, boxes, ignore }."""
    recs = []
    i = 0
    while os.path.exists(os.path.join(data_dir, f"{name}-{i}.json")):
        for r in load_json(os.path.join(data_dir, f"{name}-{i}.json")):
            r["path"] = os.path.join(data_dir, "img", r["f"])
            recs.append(r)
        i += 1
    if not recs:
        raise FileNotFoundError(f"không có ảnh {name} trong {data_dir}")
    return recs


# ------------------------------------------------------------------------------------------------ mô hình
def build_classifier(n_classes):
    """CNN nhỏ cho ảnh 48×48 (khoảng 0,35 triệu tham số, khoảng 31 triệu phép nhân-cộng), trả về logit."""
    import keras
    from keras import layers
    inp = keras.Input((CLS_SIZE, CLS_SIZE, 3), name="crop")
    x = inp
    for i, ch in enumerate((32, 64, 128)):
        x = layers.Conv2D(ch, 3, padding="same", use_bias=False, name=f"c{i}")(x)
        x = layers.BatchNormalization(name=f"bn{i}")(x)
        x = layers.ReLU(name=f"r{i}")(x)
        x = layers.MaxPooling2D(2, name=f"p{i}")(x)
    x = layers.Conv2D(192, 3, padding="same", use_bias=False, name="c3")(x)
    x = layers.BatchNormalization(name="bn3")(x)
    x = layers.ReLU(name="r3")(x)
    x = layers.GlobalAveragePooling2D(name="gap")(x)
    x = layers.Dropout(0.3, name="drop")(x)
    out = layers.Dense(n_classes, name="logits")(x)
    return keras.Model(inp, out, name="sign_cls")


# MobileNetV2 của Keras dùng momentum 0,999 cho BatchNorm: trung bình trượt cần vài nghìn bước mới bám được, nên mô
# hình ở chế độ suy luận cho kết quả sai hẳn khi huấn luyện ngắn. 0,99 (cửa sổ khoảng 100 bước) như các lớp còn lại.
BN_MOMENTUM = 0.99  # momentum của mọi lớp BatchNorm trong bộ dò
HEAT_PRIOR_BIAS = -2.19  # log(0.1/0.9): xác suất ban đầu 0,1 cho mỗi ô (ổn định focal loss)


def build_detector(input_shape, alpha=0.35, n_fam=len(FAMILIES), export=False):
    """
    MobileNetV2 (khởi tạo ngẫu nhiên, không dùng trọng số ImageNet) + cổ FPN gọn gộp về một đầu ra bước 8 +
    đầu CenterNet. Khi huấn luyện trả về [logit heat, reg]; export=True trả về [sigmoid(heat), reg].
    reg = [log_w, log_h, off_x, off_y]: log cạnh bị chặn trong [LOG_SIZE_MIN, LOG_SIZE_MAX], độ lệch trong [0, 1].
    """
    import keras
    from keras import layers
    base = keras.applications.MobileNetV2(input_shape=input_shape, alpha=alpha, include_top=False, weights=None)
    for layer in base.layers:
        if isinstance(layer, layers.BatchNormalization):
            layer.momentum = BN_MOMENTUM
    c3 = base.get_layer("block_6_expand_relu").output  # bước 8
    c4 = base.get_layer("block_13_expand_relu").output  # bước 16
    c5 = base.get_layer("block_16_project_BN").output  # bước 32

    def cbr(x, ch, name, k=1):
        x = layers.Conv2D(ch, k, padding="same", use_bias=False, name=name)(x)
        x = layers.BatchNormalization(name=name + "_bn")(x)
        return layers.ReLU(6.0, name=name + "_relu")(x)

    def sep(x, ch, name):
        x = layers.DepthwiseConv2D(3, padding="same", use_bias=False, name=name + "_dw")(x)
        x = layers.BatchNormalization(name=name + "_dwbn")(x)
        x = layers.ReLU(6.0, name=name + "_dwrelu")(x)
        return cbr(x, ch, name + "_pw")

    p5 = cbr(c5, 64, "lat5")
    p4 = layers.Add(name="td4")([cbr(c4, 64, "lat4"), layers.UpSampling2D(2, interpolation="bilinear", name="up5")(p5)])
    p4 = sep(p4, 64, "fuse4")
    p3 = layers.Add(name="td3")([cbr(c3, 64, "lat3"), layers.UpSampling2D(2, interpolation="bilinear", name="up4")(p4)])
    p3 = sep(p3, 64, "fuse3")
    h = sep(p3, 64, "head1")
    h = sep(h, 64, "head2")
    heat = layers.Conv2D(n_fam, 1, name="heat", bias_initializer=keras.initializers.Constant(HEAT_PRIOR_BIAS))(h)
    size = layers.Conv2D(2, 1, activation="sigmoid", name="size_raw")(h)
    size = layers.Rescaling(LOG_SIZE_MAX - LOG_SIZE_MIN, offset=LOG_SIZE_MIN, name="size")(size)
    off = layers.Conv2D(2, 1, activation="sigmoid", name="off")(h)
    reg = layers.Concatenate(name="reg")([size, off])
    if export:
        heat = layers.Activation("sigmoid", name="heat_sig")(heat)
    return keras.Model(base.input, [heat, reg], name=f"sign_det_a{alpha}")


def copy_weights(src, dst):
    """Chép trọng số theo tên lớp (mô hình huấn luyện 320×320 → mô hình xuất 352×640)."""
    by_name = {l.name: l for l in src.layers}
    n = 0
    for l in dst.layers:
        if l.weights:
            l.set_weights(by_name[l.name].get_weights())
            n += 1
    return n


# ------------------------------------------------------------------------------------------------ đích CenterNet
def gaussian_radius(h, w, min_overlap=0.7):
    """Bán kính đỉnh Gauss theo CenterNet (đơn vị ô)."""
    a1, b1, c1 = 1, (h + w), w * h * (1 - min_overlap) / (1 + min_overlap)
    r1 = (b1 + np.sqrt(b1 ** 2 - 4 * a1 * c1)) / 2
    a2, b2, c2 = 4, 2 * (h + w), (1 - min_overlap) * w * h
    r2 = (b2 + np.sqrt(b2 ** 2 - 4 * a2 * c2)) / 2
    a3, b3, c3 = 4 * min_overlap, -2 * min_overlap * (h + w), (min_overlap - 1) * w * h
    r3 = (b3 + np.sqrt(b3 ** 2 - 4 * a3 * c3)) / 2
    return min(r1, r2, r3)


IGNORE_PAD = 2.0  # nới vùng bỏ qua thêm chừng này điểm ảnh mỗi phía
# Ảnh nền không được người kiểm xác nhận là không có biển (gần hết ảnh Open Images; cả ảnh xác nhận có biển, vì
# vẫn có biển sót hộp) có thể có biển thật không có hộp: lỗi âm của heat trên phần ảnh thật đó chỉ tính chừng này
# phần (biển thật bị kéo về "nền" yếu đi 4 lần), trong khi cảnh vật thật vẫn dạy bộ dò không báo nhầm. Vật tự vẽ
# (synth), nền vẽ thủ tục và ảnh sạch luôn đủ trọng số.
NEG_W_UNVERIFIED = 0.25
SYNTH_PAD = 4.0  # nới vùng vật tự vẽ thêm chừng này điểm ảnh mỗi phía khi trả lại đủ trọng số


def _cells_in(cxs, cys, x, y, w, h, pad):
    xs = (cxs >= x - pad) & (cxs <= x + w + pad)
    ys = (cys >= y - pad) & (cys <= y + h + pad)
    return np.ix_(ys, xs)


def make_targets(boxes, ignores, out_h, out_w, n_fam=len(FAMILIES), stride=STRIDE, neg_weight=1.0, full=()):
    """
    boxes: [[x, y, w, h, họ]] (điểm ảnh của ảnh vào), ignores: [[x, y, w, h]].
    neg_weight: trọng số lỗi âm cho phần còn lại của ảnh (NEG_W_UNVERIFIED với ảnh nền chưa kiểm), full: các vùng
    [[x, y, w, h]] luôn đủ trọng số (vật tự vẽ).
    → heat [out_h,out_w,n_fam], size [out_h,out_w,2] (log cạnh), off [out_h,out_w,2], pos [out_h,out_w],
      mask [out_h,out_w] (trọng số lỗi âm của heat: 0 = vùng bỏ qua, neg_weight, hoặc 1).
    """
    heat = np.zeros((out_h, out_w, n_fam), np.float32)
    size = np.zeros((out_h, out_w, 2), np.float32)
    off = np.zeros((out_h, out_w, 2), np.float32)
    pos = np.zeros((out_h, out_w), np.float32)
    mask = np.full((out_h, out_w), float(neg_weight), np.float32)
    cxs = (np.arange(out_w) + 0.5) * stride
    cys = (np.arange(out_h) + 0.5) * stride
    if neg_weight != 1.0:
        for x, y, w, h in list(full) + [b[:4] for b in boxes]:
            mask[_cells_in(cxs, cys, x, y, w, h, SYNTH_PAD)] = 1.0
    for x, y, w, h in ignores:
        xs = (cxs >= x - IGNORE_PAD) & (cxs <= x + w + IGNORE_PAD)
        ys = (cys >= y - IGNORE_PAD) & (cys <= y + h + IGNORE_PAD)
        mask[np.ix_(ys, xs)] = 0.0
    gy, gx = np.mgrid[0:out_h, 0:out_w]
    for x, y, w, h, f in boxes:
        cx, cy = (x + w / 2) / stride, (y + h / 2) / stride
        ix, iy = int(np.floor(cx)), int(np.floor(cy))
        if not (0 <= ix < out_w and 0 <= iy < out_h):
            continue
        r = max(0.0, gaussian_radius(h / stride, w / stride))
        sigma = (2 * int(r) + 1) / 6.0
        g = np.exp(-((gx - ix) ** 2 + (gy - iy) ** 2) / (2 * sigma * sigma))
        g[g < 1e-4] = 0
        heat[..., int(f)] = np.maximum(heat[..., int(f)], g)
        heat[iy, ix, int(f)] = 1.0
        size[iy, ix] = (np.log(max(w, 1.0)), np.log(max(h, 1.0)))
        off[iy, ix] = (cx - ix, cy - iy)
        pos[iy, ix] = 1.0
        mask[iy, ix] = 1.0
    return heat, size, off, pos, mask


# ------------------------------------------------------------------------------------------------ giải mã
def _iou(a, b):
    ix = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    iy = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if ix <= 0 or iy <= 0:
        return 0.0
    inter = ix * iy
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def decode(heat, reg, thr=PEAK_THRESHOLD, max_boxes=MAX_BOXES, nms_iou=NMS_IOU, stride=STRIDE,
           max_cand=MAX_CANDIDATES):
    """
    heat [H,W,F] (đã sigmoid), reg [H,W,4] → [(x, y, w, h, họ, điểm)] theo điểm giảm dần. Giống decodePeaks + nms
    của js/visionproto.js: đỉnh = không ô kề nào cùng kênh lớn hơn hẳn, điểm ≥ thr, độ lệch kẹp về [0, 1], bỏ cạnh
    ngoài [1, MAX_BOX_SIDE], giữ max_cand đỉnh cao nhất, rồi NMS bỏ khung có IoU > nms_iou với khung đã giữ.
    """
    H, W, F = heat.shape
    pad = np.pad(heat, ((1, 1), (1, 1), (0, 0)), constant_values=-1)
    mx = np.max(np.stack([pad[dy:dy + H, dx:dx + W] for dy in range(3) for dx in range(3)]), axis=0)
    peaks = np.argwhere((heat >= mx) & (heat >= thr))
    cand = []
    for iy, ix, f in peaks:
        lw, lh, ox, oy = (float(v) for v in reg[iy, ix])
        w, h = float(np.exp(lw)), float(np.exp(lh))
        if not (1 <= w <= MAX_BOX_SIDE and 1 <= h <= MAX_BOX_SIDE):
            continue
        ox, oy = min(1.0, max(0.0, ox)), min(1.0, max(0.0, oy))
        cx, cy = (ix + ox) * stride, (iy + oy) * stride
        cand.append((cx - w / 2, cy - h / 2, w, h, int(f), min(1.0, float(heat[iy, ix, f]))))
    cand.sort(key=lambda c: -c[5])
    cand = cand[:max_cand]
    out = []
    for c in cand:
        if len(out) >= max_boxes:
            break
        if all(_iou(c, o) <= nms_iou for o in out):
            out.append(c)
    return out


# ------------------------------------------------------------------------------------------------ hiệu chỉnh
def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def ece(probs, y, bins=ECE_BINS):
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    acc = (pred == y).astype(np.float64)
    edges = np.linspace(0, 1, bins + 1)
    e = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            e += m.mean() * abs(acc[m].mean() - conf[m].mean())
    return float(e)


def nll(logits, y, T):
    p = softmax(logits / T)
    return float(-np.mean(np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1.0))))


def fit_temperature(logits, y, lo=0.25, hi=10.0, iters=60):
    """T > 0 cực tiểu NLL của softmax(logit / T), tìm theo lát cắt vàng trên log T."""
    a, b = np.log(lo), np.log(hi)
    g = (np.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = nll(logits, y, np.exp(c)), nll(logits, y, np.exp(d))
    for _ in range(iters):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = nll(logits, y, np.exp(c))
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = nll(logits, y, np.exp(d))
    return float(np.exp((a + b) / 2))


# ------------------------------------------------------------------------------------------------ lượng tử
def output_scale(it, out_index):
    """
    Bước lượng tử (scale) của một đầu ra float32 của mô hình int8: scale của tensor int8 đi vào phép DEQUANTIZE tạo
    ra đầu ra đó. Không tìm được thì báo lỗi (không đoán).
    """
    by_index = {d["index"]: d for d in it.get_tensor_details()}
    for op in it._get_ops_details():
        if op["op_name"] == "DEQUANTIZE" and out_index in [int(o) for o in op["outputs"]]:
            src = by_index.get(int(op["inputs"][0]))
            if src is not None and src["dtype"] == np.int8 and float(src["quantization"][0]) > 0:
                return float(src["quantization"][0])
    raise ValueError(f"không tìm được bước lượng tử của đầu ra {out_index}")


# ------------------------------------------------------------------------------------------------ nguồn gốc
def git_commit():
    try:
        return subprocess.run(["git", "-C", APP_ROOT, "rev-parse", "HEAD"], capture_output=True, text=True,
                              timeout=10).stdout.strip() or None
    except Exception:
        return None


def provenance():
    """Nguồn gốc bản dựng (commit, thay đổi chưa commit, SHA-256 mã nguồn và hình vẽ) từ tools/camera/labels.mjs."""
    r = subprocess.run(["node", os.path.join(TOOLS_DIR, "labels.mjs"), "--provenance"], capture_output=True,
                       text=True, timeout=60, cwd=APP_ROOT)
    if r.returncode != 0:
        raise RuntimeError(f"labels.mjs --provenance thất bại: {r.stderr.strip()}")
    return json.loads(r.stdout)


def versions():
    import tensorflow as tf
    import keras
    import PIL
    return {"python": platform.python_version(), "tensorflow": tf.__version__, "keras": keras.__version__,
            "numpy": np.__version__, "pillow": PIL.__version__, "platform": platform.platform()}


def log(msg):
    print(msg, file=sys.stderr, flush=True)
