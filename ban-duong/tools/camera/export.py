# Xuất hai mô hình sang TFLite int8 bằng bộ chuyển đổi của TensorFlow (đầu vào/ra float32, lượng tử hoá bằng tập
# đại diện là ảnh kiểm định tổng hợp), kiểm tra kích thước vào/ra theo hợp đồng 2 và 3, ghi cặp vào/ra mẫu (golden)
# để kiểm tra lúc chạy, nguồn gốc bản dựng, SHA256SUMS và tệp ghi công Open Images.
#
#   python -I tools/camera/export.py --runs $BANDUONG_CACHE/run --crops $BANDUONG_CACHE/crops \
#          --scenes $BANDUONG_CACHE/scenes --bg $BANDUONG_CACHE/bg --out $BANDUONG_CACHE/models-staging
#   python -I tools/camera/export.py --out $BANDUONG_CACHE/models-staging --sums-only   # chỉ tính lại SHA256SUMS
#
# Ghi vào thư mục chờ (không phải models/ của ứng dụng); tools/camera/install-models.mjs chép sang models/, cập nhật
# js/mlmanifest.js và chạy bộ kiểm thử. Cặp vào/ra mẫu chỉ dùng ảnh nền vẽ thủ tục (tập "golden" của
# render-crops.mjs và render-scenes.mjs chạy với --bg rỗng): không ảnh Open Images nào nằm trong models/.
import argparse
import datetime
import hashlib
import os
import shutil
import sys

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import bdcommon as B  # noqa: E402

REP_CLS = 300  # số ảnh đại diện để lượng tử hoá bộ phân loại
REP_DET = 120  # số ảnh đại diện cho bộ dò
GOLDEN_CLS = 20  # số cặp vào/ra mẫu của bộ phân loại
GOLDEN_DET = 4  # của bộ dò (ảnh vào lớn: giữ ít cho kho mã nhỏ)
GOLDEN_SEED = 7  # hạt giống chọn ảnh đại diện và cặp mẫu
TOL_STEPS = 2  # sai khác cho phép khi so cặp mẫu: 2 bước lượng tử int8 của đầu ra (bdcommon.output_scale)
GOLDEN_SET = "golden"  # tên tập ảnh cắt và ảnh ghép dùng cho cặp mẫu (chỉ nền vẽ thủ tục)
CLS_FILE = "sign-cls.int8.tflite"
DET_FILE = "sign-det.int8.tflite"


def convert(tf, model, shape, rep, tmpdir):
    """Keras → SavedModel (chữ ký đầu vào cố định) → TFLite int8, vào/ra float32."""
    sm = os.path.join(tmpdir, model.name + "_saved")
    if os.path.isdir(sm):
        shutil.rmtree(sm)
    model.export(sm, format="tf_saved_model", input_signature=[tf.TensorSpec(shape, tf.float32)], verbose=False)
    conv = tf.lite.TFLiteConverter.from_saved_model(sm)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = lambda: ([r[None].astype(np.float32)] for r in rep)
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.float32
    conv.inference_output_type = tf.float32
    data = conv.convert()
    shutil.rmtree(sm, ignore_errors=True)
    return data


def interpreter(tf, data):
    it = tf.lite.Interpreter(model_content=data, num_threads=1)
    it.allocate_tensors()
    return it


def run(it, x):
    it.set_tensor(it.get_input_details()[0]["index"], x[None].astype(np.float32))
    it.invoke()
    return [it.get_tensor(d["index"])[0] for d in it.get_output_details()]


def check_shapes(it, inp, outs):
    """Đầu vào/ra đúng hợp đồng; trả về chỉ số đầu ra theo tên ("heat", "reg" hoặc "logits")."""
    di = it.get_input_details()
    assert len(di) == 1 and list(di[0]["shape"]) == inp and di[0]["dtype"] == np.float32, di
    do = it.get_output_details()
    assert len(do) == len(outs), do
    names = {}
    for i, d in enumerate(do):
        assert d["dtype"] == np.float32, d
        shape = list(d["shape"])
        match = [n for n, s in outs.items() if s == shape]
        assert len(match) == 1 and match[0] not in names, (shape, outs)
        names[match[0]] = i
    return names


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_sums(out):
    rows = []
    for root, _, files in os.walk(out):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, out).replace(os.sep, "/")
            if rel == "SHA256SUMS" or ".tmp" in f:
                continue
            rows.append(f"{sha256(p)}  {rel}")
    rows.sort(key=lambda r: r.split("  ", 1)[1])
    with open(os.path.join(out, "SHA256SUMS.tmp"), "w") as f:
        f.write("\n".join(rows) + "\n")
    os.replace(os.path.join(out, "SHA256SUMS.tmp"), os.path.join(out, "SHA256SUMS"))
    B.log(f"SHA256SUMS: {len(rows)} tệp")


def golden_crops(crops):
    """Ảnh cắt của tập golden; mọi ảnh phải dùng nền vẽ thủ tục (photo = 0)."""
    X, y, _, _ = B.load_crops(crops, GOLDEN_SET)
    photo = B.load_crop_field(crops, GOLDEN_SET, "photo")
    if len(photo) != len(X) or photo.any():
        raise SystemExit("tập golden có ảnh cắt dùng ảnh nền thật: vẽ lại với --bg ''")
    return X, y


def golden_scenes(scenes):
    """Ảnh ghép của tập golden; mọi ảnh phải dùng nền vẽ thủ tục (bg = null)."""
    recs = B.load_scenes(scenes, GOLDEN_SET)
    if any(r.get("bg", "?") is not None for r in recs):
        raise SystemExit("tập golden có ảnh ghép dùng ảnh nền thật: vẽ lại với --bg ''")
    return recs


def save_png(path, rgb_u8):
    Image.fromarray(rgb_u8).save(path, format="PNG", optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--runs")
    ap.add_argument("--crops")
    ap.add_argument("--scenes")
    ap.add_argument("--bg")
    ap.add_argument("--labels")
    ap.add_argument("--alpha", type=float, default=0.35)
    ap.add_argument("--sums-only", action="store_true")
    args = ap.parse_args()
    out = args.out
    os.makedirs(out, exist_ok=True)
    if os.path.realpath(out) == os.path.realpath(os.path.join(B.APP_ROOT, "models")):
        raise SystemExit("--out phải là thư mục chờ, không phải models/ của ứng dụng (dùng install-models.mjs)")
    if args.sums_only:
        write_sums(out)
        return

    import tensorflow as tf
    labels_path = args.labels or os.path.join(out, "labels.json")
    lj = B.load_json(labels_path)
    n_cls = len(lj["labels"])
    rng = np.random.default_rng(GOLDEN_SEED)

    # --------------------------------------------------------------- bộ phân loại
    cls = B.build_classifier(n_cls)
    cls.load_weights(os.path.join(args.runs, "cls", "best.weights.h5"))
    Xv, _, _, _ = B.load_crops(args.crops, "val")
    rep = Xv[rng.choice(len(Xv), min(REP_CLS, len(Xv)), replace=False)].astype(np.float32) / 255.0
    data = convert(tf, cls, [1, B.CLS_SIZE, B.CLS_SIZE, 3], rep, args.runs)
    it = interpreter(tf, data)
    names = check_shapes(it, [1, B.CLS_SIZE, B.CLS_SIZE, 3], {"logits": [1, n_cls]})
    with open(os.path.join(out, CLS_FILE + ".tmp"), "wb") as f:
        f.write(data)
    os.replace(os.path.join(out, CLS_FILE + ".tmp"), os.path.join(out, CLS_FILE))
    B.log(f"{CLS_FILE}: {len(data)} byte")

    # --------------------------------------------------------------- bộ dò
    det_train = B.build_detector((320, 320, 3), alpha=args.alpha)
    det_train.load_weights(os.path.join(args.runs, "det", "best.weights.h5"))
    det = B.build_detector((B.DET_H, B.DET_W, 3), alpha=args.alpha, export=True)
    B.copy_weights(det_train, det)
    vrecs = B.load_scenes(args.scenes, "val")
    pick = rng.choice(len(vrecs), min(REP_DET, len(vrecs)), replace=False)
    rep_d = [np.asarray(Image.open(vrecs[i]["path"]).convert("RGB"), np.float32) / 255.0 for i in pick]
    data_d = convert(tf, det, [1, B.DET_H, B.DET_W, 3], rep_d, args.runs)
    itd = interpreter(tf, data_d)
    out_h, out_w = B.DET_H // B.STRIDE, B.DET_W // B.STRIDE
    names_d = check_shapes(itd, [1, B.DET_H, B.DET_W, 3],
                           {"heat": [1, out_h, out_w, len(B.FAMILIES)], "reg": [1, out_h, out_w, 4]})
    with open(os.path.join(out, DET_FILE + ".tmp"), "wb") as f:
        f.write(data_d)
    os.replace(os.path.join(out, DET_FILE + ".tmp"), os.path.join(out, DET_FILE))
    B.log(f"{DET_FILE}: {len(data_d)} byte")

    # --------------------------------------------------------------- cặp vào/ra mẫu
    gdir = os.path.join(out, "golden")
    if os.path.isdir(gdir):
        shutil.rmtree(gdir)
    os.makedirs(gdir)
    Xg, yg = golden_crops(args.crops)
    od = it.get_output_details()
    cls_tol = TOL_STEPS * B.output_scale(it, od[names["logits"]]["index"])
    cases = []
    for k, i in enumerate(rng.choice(len(Xg), min(GOLDEN_CLS, len(Xg)), replace=False)):
        x = Xg[i]
        o = run(it, x.astype(np.float32) / 255.0)[names["logits"]]
        save_png(os.path.join(gdir, f"cls-{k:02d}.png"), x)
        o.astype("<f4").tofile(os.path.join(gdir, f"cls-{k:02d}.logits.bin"))
        cases.append({"input": f"cls-{k:02d}.png", "outputs": {"logits": f"cls-{k:02d}.logits.bin"}, "label": int(yg[i])})
    grecs = golden_scenes(args.scenes)
    odd = itd.get_output_details()
    det_tol = {n: TOL_STEPS * B.output_scale(itd, odd[i]["index"]) for n, i in names_d.items()}
    dcases = []
    for k, i in enumerate(rng.choice(len(grecs), min(GOLDEN_DET, len(grecs)), replace=False)):
        x = np.asarray(Image.open(grecs[i]["path"]).convert("RGB"))
        o = run(itd, x.astype(np.float32) / 255.0)
        save_png(os.path.join(gdir, f"det-{k:02d}.png"), x)
        o[names_d["heat"]].astype("<f4").tofile(os.path.join(gdir, f"det-{k:02d}.heat.bin"))
        o[names_d["reg"]].astype("<f4").tofile(os.path.join(gdir, f"det-{k:02d}.reg.bin"))
        dcases.append({"input": f"det-{k:02d}.png", "outputs": {"heat": f"det-{k:02d}.heat.bin", "reg": f"det-{k:02d}.reg.bin"},
                       "boxes": [b[:4] + [B.FAMILIES[int(b[4])]] for b in grecs[i]["boxes"]], "geo": grecs[i]["geo"]})
    index = {
        "version": 1,
        "background": "procedural",
        "note": "Ảnh vào là PNG RGB 8 bit, nền vẽ thủ tục (không có ảnh chụp nào); giá trị đưa vào mô hình = byte / 255 "
                "(float32). Đầu ra float32 little-endian, không có phần đầu, theo thứ tự hàng (C). So sánh từng phần tử "
                f"với sai khác tuyệt đối ≤ tol = {TOL_STEPS} bước lượng tử int8 của đầu ra đó.",
        "models": {
            "cls": {"file": CLS_FILE, "input": [1, B.CLS_SIZE, B.CLS_SIZE, 3],
                    "outputs": {"logits": [1, n_cls]}, "tol": {"logits": cls_tol}, "cases": cases},
            "det": {"file": DET_FILE, "input": [1, B.DET_H, B.DET_W, 3],
                    "outputs": {"heat": [1, out_h, out_w, len(B.FAMILIES)], "reg": [1, out_h, out_w, 4]},
                    "tol": det_tol, "cases": dcases},
        },
    }
    B.save_json_atomic(os.path.join(gdir, "index.json"), index, indent=1)

    # --------------------------------------------------------------- nguồn gốc, ghi công, mã băm
    if args.bg and os.path.exists(os.path.join(args.bg, "attribution.csv")):
        shutil.copyfile(os.path.join(args.bg, "attribution.csv"), os.path.join(out, "ATTRIBUTION-openimages.csv"))
    hc = B.load_json(os.path.join(args.runs, "cls", "history.json"))
    hd = B.load_json(os.path.join(args.runs, "det", "history.json"))
    lj = B.load_json(labels_path)
    prov = B.provenance()
    lj["build"] = {
        **{k: v for k, v in lj.get("build", {}).items() if k in ("generator", "catalogueCodes", "pruned", "calibration")},
        "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gitCommit": prov["gitCommit"],
        "gitDirty": prov["gitDirty"],
        "provenance": prov,
        "versions": B.versions(),
        "classifier": {"params": hc["params"], "bestValAcc": hc["best_val_acc"], "epochs": hc["epochs_run"],
                       "seed": hc["seed"], "nTrain": hc["n_train"], "bytes": len(data)},
        "detector": {"params": hd["params"], "alpha": hd["alpha"], "bestValLoss": hd["best_val_loss"],
                     "epochs": hd["epochs"], "seed": hd["seed"], "nTrain": hd["n_train"], "bytes": len(data_d)},
        "quantization": "int8 (TFLiteConverter, Optimize.DEFAULT, tập đại diện), đầu vào/ra float32",
    }
    B.write_labels(labels_path, lj)
    write_sums(out)
    B.log("xuất xong")


if __name__ == "__main__":
    main()
