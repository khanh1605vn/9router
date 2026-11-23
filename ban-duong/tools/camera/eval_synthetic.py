# Đánh giá E1 (PLAN §8.3) trên dữ liệu tổng hợp để riêng (hạt giống và ảnh nền tách rời khỏi tập huấn luyện), chạy
# đúng hai mô hình int8 đã xuất, rồi viết MODEL_CARD.md. Đây là giới hạn trên trên dữ liệu tổng hợp, không phải độ
# chính xác trên đường thật.
#
#   python -I tools/camera/eval_synthetic.py --models $BANDUONG_CACHE/models-staging --crops $BANDUONG_CACHE/crops \
#          --scenes $BANDUONG_CACHE/scenes --runs $BANDUONG_CACHE/run --bg $BANDUONG_CACHE/bg \
#          --out $BANDUONG_CACHE/models-staging/MODEL_CARD.md [--prune] [--prune-max 5]
#
# Ngưỡng E1 (PLAN §8.4) cho mỗi nhãn được học, trên tập testw (ảnh cắt vẽ ở cạnh 20/24/32/48 điểm ảnh): gộp các cạnh
# ≥ 24 điểm ảnh, top-1 ≥ 97 %; và không cạnh nào thấp hơn 97 % một cách có ý nghĩa thống kê (cận trên Wilson một
# phía 95 % của cạnh đó < 97 %). Cần ít nhất GATE_MIN_N ảnh mỗi cạnh (train-all.sh vẽ 200 ảnh mỗi cạnh cho nhãn
# được học): với 25 ảnh, một ảnh sai đã là 96 % và nhãn đúng 98 % chỉ qua được khoảng 22 % số lần.
#
# --prune: đặt learn:false trong labels.json cho các nhãn không qua ngưỡng và ghi chúng vào build.pruned. Kết quả
# chỉ phụ thuộc lần đánh giá này (chạy lại không có --prune thì trả lại cờ learn). Dừng với mã 4 và không gỡ gì nếu
# hơn --prune-max nhãn không qua (mô hình có vấn đề, cần người xem), với mã 2 nếu số ảnh mỗi cạnh quá ít.
import argparse
import datetime
import json
import math
import os
import sys
from collections import Counter

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402

import bdcommon as B  # noqa: E402

GATE_TOP1 = 0.97  # ngưỡng top-1 cho nhãn được học (PLAN §8.4)
GATE_MIN_WIDTH = 24  # áp ngưỡng cho các cạnh từ chừng này điểm ảnh trở lên
GATE_Z = 1.645  # cận trên Wilson một phía 95 % khi xét từng cạnh
GATE_MIN_N = 100  # số ảnh tối thiểu mỗi cạnh để ngưỡng có nghĩa (ít hơn thì không được gỡ nhãn)
PRUNE_MAX = 5  # gỡ nhiều nhãn hơn chừng này thì dừng lại cho người xem thay vì gỡ âm thầm
CLS_WIDTHS = (20, 24, 32, 48)  # cạnh thật của biển khi đánh giá bộ phân loại
DET_WIDTHS = (8, 10, 12, 16, 20)  # cạnh biển ở ảnh vào bộ dò khi đánh giá bộ dò
ACCEPT_P = 0.85  # xác suất đã hiệu chỉnh để một khung được tính là "nhận" (cổng 3, PLAN §5.5)
MATCH_CENTRE = 0.5  # khung dò trúng nếu tâm lệch ≤ 0,5 cạnh biển (tối thiểu MATCH_MIN_PX)
MATCH_MIN_PX = 3.0  # độ lệch tâm luôn cho phép (điểm ảnh), cho biển rất nhỏ
MATCH_SIZE = (0.5, 2.0)  # và tỉ lệ cạnh dò/cạnh thật trong khoảng này
EXIT_TOO_FEW = 2  # mã thoát: quá ít ảnh mỗi cạnh để gỡ nhãn
EXIT_TOO_MANY = 4  # mã thoát: quá nhiều nhãn không qua ngưỡng


# ------------------------------------------------------------------------------------------------ định dạng số
def vn_int(n):
    """Số nguyên theo cách viết tiếng Việt: 309.807."""
    return f"{int(n):,}".replace(",", ".")


def vn_num(x, digits):
    """Số thực: dấu phẩy thập phân, dấu chấm hàng nghìn (0,35; 1.234,5)."""
    s = f"{float(x):,.{digits}f}"
    return s.replace(",", "\0").replace(".", ",").replace("\0", ".")


def vn_pct(v, digits=1):
    """Tỉ lệ 0–1 → "97,0 %" (có dấu cách trước %); None → "–"."""
    return "–" if v is None else f"{vn_num(100 * v, digits)} %"


# ------------------------------------------------------------------------------------------------ ngưỡng E1
def wilson_upper(k, n, z=GATE_Z):
    """Cận trên Wilson (một phía) của tỉ lệ k/n."""
    if n <= 0:
        return 1.0
    ph = k / n
    d = 1 + z * z / n
    c = ph + z * z / (2 * n)
    r = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return min(1.0, (c + r) / d)


def gate_label(counts):
    """
    counts: {cạnh: (số đúng, số ảnh)}. Xét các cạnh ≥ GATE_MIN_WIDTH. Trả về
    { "pass": True | False | None (không đủ ảnh), "acc": top-1 gộp, "n": số ảnh gộp, "low": [cạnh thấp rõ rệt] }.
    """
    ws = sorted(c for c in counts if c >= GATE_MIN_WIDTH)
    k = sum(counts[c][0] for c in ws)
    n = sum(counts[c][1] for c in ws)
    if not ws or any(counts[c][1] < GATE_MIN_N for c in ws):
        return {"pass": None, "acc": (k / n) if n else None, "n": n, "low": []}
    low = [c for c in ws if wilson_upper(*counts[c]) < GATE_TOP1]
    acc = k / n
    return {"pass": acc >= GATE_TOP1 and not low, "acc": acc, "n": n, "low": low}


def whitelist_of(lj):
    """Nhãn được học trước mọi lần gỡ: learn hiện tại cộng các nhãn đã gỡ ở lần đánh giá trước."""
    was = set(lj.get("build", {}).get("pruned", []))
    return [l["label"] for l in lj["labels"] if l["learn"] or l["label"] in was]


def apply_gate(lj, failing, prune):
    """Đặt cờ learn theo kết quả lần này (không phụ thuộc lần trước). Trả về danh sách nhãn bị gỡ."""
    wl = set(whitelist_of(lj))
    pruned = sorted(set(failing) & wl) if prune else []
    for l in lj["labels"]:
        l["learn"] = l["label"] in wl and l["label"] not in pruned
    b = lj.setdefault("build", {})
    b["pruned"] = pruned
    return pruned


# ------------------------------------------------------------------------------------------------ đánh giá
def interp(tf, path):
    it = tf.lite.Interpreter(model_path=path, num_threads=4)
    it.allocate_tensors()
    return it


def run(it, x):
    it.set_tensor(it.get_input_details()[0]["index"], x[None].astype(np.float32))
    it.invoke()
    return [it.get_tensor(d["index"])[0] for d in it.get_output_details()]


def logits_of(it, X):
    return np.stack([run(it, x.astype(np.float32) / 255.0)[0] for x in X]).astype(np.float64)


def eval_classifier(tf, models, crops, labels):
    """Top-1 theo nhãn và cạnh trên testw: {nhãn: {cạnh: (số đúng, số ảnh)}}, bảng nhầm lẫn, số ảnh."""
    it = interp(tf, os.path.join(models, "sign-cls.int8.tflite"))
    X, y, _, _ = B.load_crops(crops, "testw")
    # cạnh yêu cầu khi vẽ (biển nhìn thẳng); khung thật hẹp hơn khi biển nghiêng
    wi = B.load_crop_field(crops, "testw", "req").astype(np.int64)
    pred = logits_of(it, X).argmax(1)
    counts = {}
    for l in labels:
        m = y == l["i"]
        if not m.any():
            continue
        counts[l["label"]] = {c: (int((pred[m & (wi == c)] == l["i"]).sum()), int((m & (wi == c)).sum()))
                              for c in CLS_WIDTHS}
    conf = Counter()
    for t, p in zip(y, pred):
        if t != p:
            conf[(int(t), int(p))] += 1
    return it, counts, conf, len(X)


def eval_calibration(it, crops, labels, T):
    """Hiệu chỉnh và tỉ lệ nhận/nhận nhầm trên tập test (cạnh ngẫu nhiên), với cờ learn cuối cùng."""
    Xt, yt, _, _ = B.load_crops(crops, "test")
    lt = logits_of(it, Xt)
    cal = {"T": T, "n": int(len(yt)), "acc": float((lt.argmax(1) == yt).mean()),
           "ece_before": B.ece(B.softmax(lt), yt), "ece_after": B.ece(B.softmax(lt / T), yt)}
    p = B.softmax(lt / T)
    learn = np.array([l["learn"] for l in labels])
    reject = {l["i"] for l in labels if l["label"] in ("background", "other-sign")}
    is_rej = np.array([t in reject for t in yt])
    top = p.argmax(1)
    acc_learn = learn[top] & (p.max(1) >= ACCEPT_P)
    cal["false_accept_reject_classes"] = float(acc_learn[is_rej].mean()) if is_rej.any() else None
    ok = acc_learn & ~is_rej
    cal["accept_precision"] = float((top[ok] == yt[ok]).mean()) if ok.any() else None
    cal["accept_rate_learnable"] = float(acc_learn[learn[yt]].mean()) if learn[yt].any() else None
    return cal


def match(dets, gts, family_aware):
    used = set()
    hit = []
    for g in gts:
        gx, gy, gw, gh, gf = g
        gcx, gcy = gx + gw / 2, gy + gh / 2
        best = None
        for j, d in enumerate(dets):
            if j in used or (family_aware and d[4] != gf):
                continue
            dcx, dcy = d[0] + d[2] / 2, d[1] + d[3] / 2
            dist = np.hypot(dcx - gcx, dcy - gcy)
            ratio = d[2] / max(gw, 1e-6)
            if dist <= max(MATCH_MIN_PX, MATCH_CENTRE * gw) and MATCH_SIZE[0] <= ratio <= MATCH_SIZE[1]:
                if best is None or dist < best[1]:
                    best = (j, dist)
        if best:
            used.add(best[0])
        hit.append(best is not None)
    return hit, used


def eval_detector(tf, models, scenes):
    from PIL import Image
    it = interp(tf, os.path.join(models, "sign-det.int8.tflite"))
    od = it.get_output_details()
    hi = [i for i, d in enumerate(od) if d["shape"][-1] == len(B.FAMILIES)][0]
    ri = [i for i, d in enumerate(od) if d["shape"][-1] == 4][0]
    res = {}
    for geo in ("A", "B"):
        try:
            recs = B.load_scenes(scenes, f"test-eval{geo}")
        except FileNotFoundError:
            continue
        stat = {w: [0, 0, 0] for w in DET_WIDTHS}  # [số biển, trúng đúng họ, trúng bất kể họ]
        fp = {"all": [0, 0], "clean": [0, 0]}  # [khung sai, số ảnh]
        for r in recs:
            x = np.asarray(Image.open(r["path"]).convert("RGB"), np.float32) / 255.0
            out = run(it, x)
            dets = B.decode(out[hi], out[ri])
            gts = [tuple(b) for b in r["boxes"]]
            w = r.get("evalWidth")
            hit_f, _ = match(dets, gts, True)
            hit_a, used = match(dets, gts, False)
            if w in stat:
                stat[w][0] += len(gts)
                stat[w][1] += sum(hit_f)
                stat[w][2] += sum(hit_a)
            n_fp = 0
            for j, d in enumerate(dets):
                if j in used:
                    continue
                cx, cy = d[0] + d[2] / 2, d[1] + d[3] / 2
                if any(ix <= cx <= ix + iw and iy <= cy <= iy + ih for ix, iy, iw, ih in r["ignore"]):
                    continue
                n_fp += 1
            for key in ("all", "clean") if r.get("bgClean", True) else ("all",):
                fp[key][0] += n_fp
                fp[key][1] += 1
        res[geo] = {"recall_family": {w: (s[1] / s[0] if s[0] else None) for w, s in stat.items()},
                    "recall_any": {w: (s[2] / s[0] if s[0] else None) for w, s in stat.items()},
                    "n_signs": {w: s[0] for w, s in stat.items()},
                    "fp_per_image": fp["all"][0] / max(1, fp["all"][1]), "n_images": fp["all"][1],
                    "fp_per_clean_image": (fp["clean"][0] / fp["clean"][1]) if fp["clean"][1] else None,
                    "n_clean_images": fp["clean"][1]}
    return res


def read_done(d, name):
    p = os.path.join(d, f"{name}.done")
    return B.load_json(p) if os.path.exists(p) else None


# ------------------------------------------------------------------------------------------------ thẻ mô hình
def model_card(c):
    """Nội dung MODEL_CARD.md từ kết quả đánh giá c (dict). Số viết theo kiểu Việt Nam (vn_int, vn_num, vn_pct)."""
    labels, gates, failing = c["labels"], c["gates"], c["failing"]
    hc, hd, cal, calib, det, build = c["hc"], c["hd"], c["cal"], c["calib"], c["det"], c["build"]
    T = c["T"]
    prov = build.get("provenance") or {}
    L = []
    w = L.append
    w("# Thẻ mô hình: nhận diện biển báo bằng camera (thử nghiệm)\n")
    w("> **Mọi con số dưới đây đo trên dữ liệu tổng hợp** (hình biển giản lược của ứng dụng dán lên ảnh đường phố "
      "nước ngoài), nên chỉ là **giới hạn trên**, **không phải độ chính xác trên đường thật ở Việt Nam**. Độ chính "
      "xác thật chưa đo được (PLAN §8.3, E2). Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.\n")
    dirty = prov.get("gitDirty")
    w(f"Ngày tạo: {c['date']} · commit: `{build.get('gitCommit') or '?'}`"
      + (" (có thay đổi chưa commit, xem `build.provenance` trong labels.json)" if dirty else "")
      + f" · dấu hình vẽ: `{(prov.get('artDigest') or '?')[:16]}`\n")
    w("## Mô hình\n")
    w("| Tệp | Kiến trúc | Tham số | Vào | Ra |\n|---|---|---|---|---|")
    w(f"| `sign-det.int8.tflite` | MobileNetV2 α {vn_num(hd['alpha'], 2)} (khởi tạo ngẫu nhiên) + cổ FPN gọn bước 8 "
      f"+ đầu CenterNet | {vn_int(hd['params'])} | float32 [1,352,640,3], RGB 0–1 | heat [1,44,80,11] (đã sigmoid), "
      "reg [1,44,80,4] |")
    w(f"| `sign-cls.int8.tflite` | CNN 4 tầng tích chập + GAP + Dense, từ đầu | {vn_int(hc['params'])} | "
      f"float32 [1,48,48,3], RGB 0–1 | logit [1,{len(labels)}] (chưa softmax) |\n")
    w("Lượng tử hoá int8 bằng TFLiteConverter (tập đại diện là ảnh kiểm định tổng hợp), vào/ra float32. "
      f"Nhiệt độ hiệu chỉnh T = {vn_num(T, 4)} (labels.json); lúc chạy p = softmax(logit / T).\n")
    w("## Dữ liệu\n")
    w("- Hình biển: 169 mã của `SIGN_CATALOGUE` vẽ bằng `signSvg()` (js/signart.js), hình giản lược tự vẽ, giấy "
      "phép của kho mã (MIT). P.127 tách thành 11 lớp trị số 20–120. Các mã có hình vẽ giống hệt nhau được gom về "
      "một nhãn gốc khi tạo dữ liệu (xem tools/camera/README.md); W.201d, W.202b, W.223b vẽ bằng hình lật gương.")
    w("- \"other-sign\": biển tự sinh không có trong danh mục (vòng/đĩa/chữ nhật có chữ hay ký hiệu lạ, hình lạ, "
      "biển phụ; không dùng ký hiệu gần giống một mã trong danh mục). Không dùng ảnh biển thật của Open Images.")
    w("- \"background\": mảng ảnh nền (tránh các hộp biển có sẵn) và vật gây nhiễu tự vẽ (cột sọc đỏ trắng, thùng "
      "vàng đen, biển hiệu cửa hàng có chữ tiếng Việt, mảng màu, mặt sau biển).")
    bg_n = c["bg_n"]
    bg_txt = ", ".join(f"{k} {vn_int(v)}" for k, v in sorted(bg_n.items())) or "không có"
    w(f"- Ảnh nền: Open Images V7 (tập validation và test), chỉ ảnh giấy phép CC BY 2.0, chia theo tác giả: {bg_txt}. "
      f"Trong đó {vn_int(c['bg_verified'])} ảnh đã được người kiểm có/không có biển ({vn_int(c['bg_clean'])} ảnh xác "
      "nhận không có biển). Ghi công từng ảnh (tên ảnh, tác "
      "giả, đường dẫn, giấy phép, ghi chú đã cắt và chỉnh sửa) trong `ATTRIBUTION-openimages.csv`. Chú thích Open "
      "Images: CC BY 4.0. Ảnh chỉ dùng để huấn luyện; trong `models/` không có ảnh chụp nào, chỉ trọng số, nhãn, "
      "thẻ này và cặp vào/ra mẫu vẽ trên nền thủ tục (`golden/`).")
    w("- Hộp \"Traffic sign\" và \"Stop sign\" có sẵn là vùng bỏ qua khi huấn luyện bộ dò. **Giới hạn**: gần hết ảnh "
      "nền chưa được người kiểm có biển hay không, và ảnh đã xác nhận có biển vẫn có biển sót hộp, nên có thể có "
      "biển thật không có hộp; trên mọi ảnh trừ ảnh xác nhận không có biển, lỗi âm của "
      f"bộ dò chỉ tính {vn_num(B.NEG_W_UNVERIFIED, 2)} phần, nhưng biển thật vẫn có thể bị dạy thành nền một phần, và "
      "một ít ảnh cắt \"background\" có thể chứa biển thật. Điều này làm giảm khả năng thấy biển, không làm tăng "
      "nhận nhầm.")
    for nm in ("train", "val", "test", "testw"):
        dn = c["done_crops"].get(nm)
        if dn:
            w(f"- Ảnh cắt `{nm}`: {vn_int(dn['n'])} ảnh.")
    for nm in ("train", "val", "test-evalA", "test-evalB"):
        dn = c["done_scenes"].get(nm)
        if dn:
            w(f"- Ảnh ghép `{nm}`: {vn_int(dn['n'])} ảnh.")
    w("")
    w("## Huấn luyện và khả năng tái lập\n")
    ver = build.get("versions") or {}
    w(f"- Phiên bản: {', '.join(f'{k} {v}' for k, v in ver.items())}.")
    w(f"- Bộ phân loại: {hc['epochs_run']} epoch, lô {hc['batch']}, hạt giống {hc['seed']}, độ chính xác kiểm định "
      f"tốt nhất {vn_pct(hc['best_val_acc'])} (epoch {hc['best_epoch']}).")
    w(f"- Bộ dò: {hd['epochs']} epoch, lô {hd['batch']}, ô cắt {hd['crop']}×{hd['crop']}, hạt giống {hd['seed']}, "
      f"mất mát kiểm định tốt nhất {vn_num(hd['best_val_loss'], 3)} (epoch {hd.get('best_epoch')}), "
      f"{vn_num(hd['train_sec'] / 3600, 2)} giờ CPU.")
    if prov.get("sources"):
        w("- SHA-256 của mã và hình vẽ dùng để tạo dữ liệu nằm trong `build.provenance.sources` của labels.json; "
          "`tests/models.test.mjs` báo lỗi khi hình vẽ biển đổi sau khi huấn luyện.")
    w("- Op determinism của TensorFlow bật; dữ liệu vẽ theo hạt giống của từng mẫu. Kết quả tái lập trong biên độ "
      "nhiễu đo; trọng số giống hệt từng bit trên CPU khác nhau thì không bảo đảm.\n")
    w("## Bộ phân loại: top-1 theo cạnh biển thật (tập test để riêng)\n")
    w(f"Ngưỡng của PLAN §8.4 cho mỗi nhãn được học: gộp các cạnh ≥ {GATE_MIN_WIDTH} điểm ảnh, top-1 ≥ "
      f"{vn_pct(GATE_TOP1, 0)}, và không cạnh nào thấp hơn rõ rệt (cận trên Wilson một phía 95 % < "
      f"{vn_pct(GATE_TOP1, 0)}). {vn_int(c['n_testw'])} ảnh, khung bộ dò lệch ±15 % kích thước và ±10 % vị trí.\n")
    w("| Nhãn | " + " | ".join(f"{cw} px" for cw in CLS_WIDTHS) + " | Gộp ≥ 24 px (số ảnh) | Qua ngưỡng |")
    w("|---|" + "---|" * (len(CLS_WIDTHS) + 2))
    counts = c["counts"]
    for lab in c["whitelist"]:
        r = counts.get(lab, {})
        g = gates.get(lab, {"pass": None, "acc": None, "n": 0})
        verdict = "chưa đủ ảnh" if g["pass"] is None else ("có" if g["pass"] else "không")
        cells = [vn_pct(r[cw][0] / r[cw][1]) if r.get(cw) and r[cw][1] else "–" for cw in CLS_WIDTHS]
        w(f"| {lab} | " + " | ".join(cells) + f" | {vn_pct(g['acc'])} ({vn_int(g['n'])}) | {verdict} |")
    others = [k for k in counts if k not in c["whitelist"]]
    if others:
        avg = []
        for cw in CLS_WIDTHS:
            vals = [counts[k][cw][0] / counts[k][cw][1] for k in others if counts[k][cw][1]]
            avg.append(vn_pct(float(np.mean(vals))) if vals else "–")
        w(f"| *{len(others)} nhãn khác (trung bình)* | " + " | ".join(avg) + " | | |")
    w("")
    w("### Nhầm lẫn thường gặp\n")
    w("| Nhãn thật | Đoán thành | Số ảnh |\n|---|---|---|")
    for (t, p), n in c["conf"].most_common(15):
        w(f"| {labels[t]['label']} | {labels[p]['label']} | {vn_int(n)} |")
    w("")
    w("### Hiệu chỉnh (tập test, cạnh ngẫu nhiên)\n")
    w(f"- ECE (15 ngăn) trước hiệu chỉnh: {vn_num(cal['ece_before'], 4)}; sau (T = {vn_num(T, 4)}): "
      f"{vn_num(cal['ece_after'], 4)}. Trên tập kiểm định lúc tìm T: {vn_num(calib.get('ece_before', float('nan')), 4)}"
      f" → {vn_num(calib.get('ece_after', float('nan')), 4)}.")
    w(f"- Top-1 trên {vn_int(cal['n'])} ảnh: {vn_pct(cal['acc'])}.")
    w(f"- Ảnh \"background\"/\"other-sign\" bị nhận nhầm thành nhãn được học với p ≥ {vn_num(ACCEPT_P, 2)}: "
      f"{vn_pct(cal['false_accept_reject_classes'])}; độ chính xác của các lần nhận đó trên ảnh biển: "
      f"{vn_pct(cal['accept_precision'])}; tỉ lệ ảnh biển được học đạt p ≥ {vn_num(ACCEPT_P, 2)}: "
      f"{vn_pct(cal['accept_rate_learnable'])}.\n")
    w("## Bộ dò: độ phủ theo cạnh biển ở ảnh vào bộ dò\n")
    w(f"Trúng khi tâm lệch ≤ max({vn_num(MATCH_MIN_PX, 0)} px, {vn_num(MATCH_CENTRE, 1)} × cạnh) và tỉ lệ cạnh trong "
      f"{vn_num(MATCH_SIZE[0], 1)}–{vn_num(MATCH_SIZE[1], 1)}; điểm đỉnh ≥ {vn_num(B.PEAK_THRESHOLD, 2)}. Lượt A: cắt "
      "640×352 đúng độ phân giải camera; lượt B: cả khung hình camera (chủ yếu 1920×1080) thu nhỏ cho vừa 640×352 "
      "và thêm viền đen như lúc chạy. \"Khung sai/ảnh\" tính trên mọi ảnh và riêng ảnh có nền sạch (nền vẽ thủ tục "
      "hoặc ảnh xác nhận không có biển; biển thật không có hộp trên nền khác bị tính là khung sai).\n")
    w("| Lượt | " + " | ".join(f"{cw} px" for cw in DET_WIDTHS) + " | Khung sai/ảnh | Khung sai/ảnh nền sạch |")
    w("|---|" + "---|" * (len(DET_WIDTHS) + 2))
    for geo, r in det.items():
        fpc = "–" if r["fp_per_clean_image"] is None else f"{vn_num(r['fp_per_clean_image'], 2)} ({vn_int(r['n_clean_images'])} ảnh)"
        w(f"| {geo}, đúng họ | " + " | ".join(vn_pct(r["recall_family"][cw]) for cw in DET_WIDTHS)
          + f" | {vn_num(r['fp_per_image'], 2)} | {fpc} |")
        w(f"| {geo}, bất kể họ | " + " | ".join(vn_pct(r["recall_any"][cw]) for cw in DET_WIDTHS) + " | | |")
    w("")
    w("## Nhãn được học không qua ngưỡng\n")
    if failing:
        w(", ".join(f"`{f}`" for f in failing) + ".")
        if c["prune"] and c["pruned"]:
            w(f"\nĐã đặt `learn: false` cho: {', '.join(c['pruned'])}.")
        elif c["prune_refused"]:
            w(f"\nKhông gỡ nhãn nào: {c['prune_refused']}")
        else:
            w("\nChưa gỡ nhãn nào (chạy không có `--prune`).")
    elif any(g["pass"] is None for g in gates.values()):
        w("Chưa đủ ảnh để xét ngưỡng.")
    else:
        w("Không có.")
    w("\n## Giới hạn\n")
    w("- Huấn luyện chỉ bằng hình vẽ giản lược của ứng dụng, chưa so với ảnh biển thật; khoảng cách giữa dữ liệu "
      "tổng hợp và đường thật chưa đo được, có thể lớn.")
    w("- Ảnh nền chủ yếu là đường phố nước ngoài; ít cảnh xe máy dày đặc và mặt tiền cửa hàng như ở Việt Nam. Phần "
      "lớn ảnh nền chưa được kiểm có biển thật hay không (xem mục Dữ liệu).")
    w("- Biển chữ, biển phụ, mũi tên R.301 và trị số tải trọng/chiều cao không được đọc.")
    w("- Tốc độ, nhiệt độ và pin trên điện thoại chưa đo.")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--scenes", required=True)
    ap.add_argument("--runs", required=True)
    ap.add_argument("--bg")
    ap.add_argument("--out", required=True)
    ap.add_argument("--prune", action="store_true")
    ap.add_argument("--prune-max", type=int, default=PRUNE_MAX)
    args = ap.parse_args()
    import tensorflow as tf
    lpath = os.path.join(args.models, "labels.json")
    lj = B.load_json(lpath)
    labels = lj["labels"]
    T = float(lj.get("T", 1.0))
    it, counts, conf, n_testw = eval_classifier(tf, args.models, args.crops, labels)
    whitelist = whitelist_of(lj)
    gates = {lab: gate_label(counts.get(lab, {})) for lab in whitelist}
    failing = [lab for lab in whitelist if gates[lab]["pass"] is False]
    unknown = [lab for lab in whitelist if gates[lab]["pass"] is None]
    exit_code, refused = 0, None
    prune = args.prune
    if prune and unknown:
        refused = (f"{len(unknown)} nhãn có dưới {GATE_MIN_N} ảnh mỗi cạnh (cần nhiều ảnh testw hơn, ví dụ "
                   "BD_TESTW_TIER_A=200, hoặc chạy với BD_PRUNE=0).")
        exit_code, prune = EXIT_TOO_FEW, False
    elif prune and len(failing) > args.prune_max:
        refused = (f"{len(failing)} nhãn không qua ngưỡng, nhiều hơn giới hạn {args.prune_max}: cần người xem "
                   "MODEL_CARD.md; chạy lại với BD_PRUNE_MAX lớn hơn hoặc BD_PRUNE=0.")
        exit_code, prune = EXIT_TOO_MANY, False
    pruned = apply_gate(lj, failing, prune)
    B.write_labels(lpath, lj)
    cal = eval_calibration(it, args.crops, labels, T)
    det = eval_detector(tf, args.models, args.scenes)

    bg_n, bg_clean, bg_verified = {}, 0, 0
    if args.bg and os.path.exists(os.path.join(args.bg, "index.json")):
        for im in B.load_json(os.path.join(args.bg, "index.json"))["images"]:
            bg_n[im["split"]] = bg_n.get(im["split"], 0) + 1
            bg_verified += im.get("status") in ("present", "absent")
            bg_clean += im.get("status") == "absent"
    calib_p = os.path.join(args.runs, "calib.json")
    ctx = {
        "labels": labels, "gates": gates, "failing": failing, "whitelist": whitelist, "counts": counts, "conf": conf,
        "n_testw": n_testw, "cal": cal, "det": det, "T": T, "build": lj.get("build", {}),
        "hc": B.load_json(os.path.join(args.runs, "cls", "history.json")),
        "hd": B.load_json(os.path.join(args.runs, "det", "history.json")),
        "calib": B.load_json(calib_p) if os.path.exists(calib_p) else {},
        "bg_n": bg_n, "bg_clean": bg_clean, "bg_verified": bg_verified, "prune": prune, "pruned": pruned, "prune_refused": refused,
        "done_crops": {nm: read_done(args.crops, nm) for nm in ("train", "val", "test", "testw")},
        "done_scenes": {nm: read_done(args.scenes, nm) for nm in ("train", "val", "test-evalA", "test-evalB")},
        "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }
    with open(args.out + ".tmp", "w", encoding="utf-8") as f:
        f.write(model_card(ctx))
    os.replace(args.out + ".tmp", args.out)
    B.save_json_atomic(os.path.join(args.runs, "eval.json"), {
        "classifier_counts": {k: {str(cw): list(v) for cw, v in r.items()} for k, r in counts.items()},
        "gates": gates, "calibration": cal, "detector": det, "failing": failing, "pruned": pruned,
        "prune_refused": refused}, indent=1)
    B.log(f"MODEL_CARD: {args.out}; nhãn không qua ngưỡng: {len(failing)}; đã gỡ: {len(pruned)}")
    if refused:
        B.log(f"không gỡ nhãn: {refused}")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
