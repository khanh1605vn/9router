# Hiệu chỉnh nhiệt độ (temperature scaling) cho bộ phân loại trên ảnh kiểm định tổng hợp (không dùng để huấn
# luyện): tìm T > 0 cực tiểu NLL của softmax(logit / T), ghi T vào labels.json; lúc chạy p = softmax(logit / T).
#
#   python -I tools/camera/calibrate.py --runs $BANDUONG_CACHE/run --crops $BANDUONG_CACHE/crops \
#          [--labels models/labels.json]
#
# Ghi thêm <runs>/calib.json: T, NLL và sai số hiệu chỉnh (ECE, 15 ngăn) trước và sau.
import argparse
import os
import sys

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402

import bdcommon as B  # noqa: E402


T_MIN, T_MAX = 0.25, 10.0  # khoảng tìm nhiệt độ


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--labels", default=B.DEFAULT_LABELS)
    args = ap.parse_args()
    lj = B.load_json(args.labels)
    model = B.build_classifier(len(lj["labels"]))
    model.load_weights(os.path.join(args.runs, "cls", "best.weights.h5"))
    X, y, _, _ = B.load_crops(args.crops, "val")
    logits = model.predict(X.astype(np.float32) / 255.0, batch_size=512, verbose=0).astype(np.float64)
    T = B.fit_temperature(logits, y, lo=T_MIN, hi=T_MAX)
    if T < T_MIN * 1.05 or T > T_MAX * 0.95:
        B.log(f"cảnh báo: T = {T:.3f} chạm biên tìm kiếm; mô hình có thể chưa học xong")
    res = {
        "T": T, "n": int(len(y)),
        "acc": float((logits.argmax(1) == y).mean()),
        "nll_before": B.nll(logits, y, 1.0), "nll_after": B.nll(logits, y, T),
        "ece_before": B.ece(B.softmax(logits), y), "ece_after": B.ece(B.softmax(logits / T), y),
    }
    B.save_json_atomic(os.path.join(args.runs, "calib.json"), res, indent=1)
    lj["T"] = round(T, 4)
    lj.setdefault("build", {})["calibration"] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in res.items()}
    B.write_labels(args.labels, lj)
    B.log(f"T = {T:.4f}; ECE {res['ece_before']:.4f} → {res['ece_after']:.4f} trên {len(y)} ảnh kiểm định")


if __name__ == "__main__":
    main()
