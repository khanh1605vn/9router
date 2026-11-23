# Huấn luyện bộ dò biển (MobileNetV2 α 0,35 khởi tạo ngẫu nhiên + cổ FPN gọn về một đầu ra bước 8 + đầu CenterNet)
# trên ảnh ghép của render-scenes.mjs. Học trên ô cắt ngẫu nhiên 320×320; xuất (export.py) ở 352×640.
#
#   python -I tools/camera/train_detector.py --data $BANDUONG_CACHE/scenes --out $BANDUONG_CACHE/run/det \
#          [--epochs 30] [--batch 16] [--alpha 0.35] [--seed 2] [--resume] [--ckpt-minutes 20]
#
# Hàm mất mát: focal loss giảm phạt quanh tâm (CenterNet) cho heat, bỏ qua các ô trong vùng bỏ qua, lỗi âm trên ảnh
# nền không chắc sạch (bgClean false) chỉ tính bdcommon.NEG_W_UNVERIFIED phần (trừ quanh vật tự vẽ); L1 cho log cạnh
# và độ lệch tâm tại ô tâm. Lưu điểm khôi phục mỗi --ckpt-minutes phút và cuối mỗi epoch (trọng số, trạng thái
# bộ tối ưu, vị trí trong epoch); --resume làm tiếp từ đó, kể cả khi tiến trình bị giết đột ngột. Nhận SIGTERM thì
# lưu rồi thoát với mã 3.
import argparse
import os
import signal
import sys
import time

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import bdcommon as B  # noqa: E402

CROP = 320  # cạnh ô cắt khi huấn luyện
SCALE_JITTER = (0.85, 1.2)  # phóng/thu ảnh trước khi cắt
LR_PEAK = 2e-3  # tốc độ học lớn nhất (AdamW)
WARMUP_STEPS = 300  # số bước tăng dần tốc độ học lúc đầu
WEIGHT_DECAY = 4e-5  # suy giảm trọng số của AdamW
SIZE_W = 1.0  # trọng số L1 của log cạnh
OFF_W = 1.0  # trọng số L1 của độ lệch tâm
FOCAL_ALPHA, FOCAL_BETA = 2.0, 4.0  # tham số focal loss của CenterNet
MIN_VISIBLE = 0.5  # biển bị ô cắt cắt mất hơn nửa thì thành vùng bỏ qua
VAL_MAX = 400  # số ảnh kiểm định mỗi epoch
LOG_EVERY = 50  # ghi nhật ký sau chừng này bước


def lr_at(step, total):
    if step < WARMUP_STEPS:
        return LR_PEAK * (step + 1) / WARMUP_STEPS
    t = (step - WARMUP_STEPS) / max(1, total - WARMUP_STEPS)
    return LR_PEAK * (0.02 + 0.98 * 0.5 * (1 + np.cos(np.pi * min(1.0, t))))


def load_example(rec, rng, train=True):
    """Ảnh 320×320 (float32 0–1) và đích CenterNet cho một bản ghi."""
    im = Image.open(rec["path"]).convert("RGB")
    W, H = im.size
    boxes = [list(b) for b in rec["boxes"]]
    ign = [list(b) for b in rec["ignore"]]
    synth = [list(b) for b in rec.get("synth", [])]
    # bản ghi cũ không có bgClean: giữ cách cũ (đủ trọng số)
    neg_w = 1.0 if rec.get("bgClean", True) else B.NEG_W_UNVERIFIED
    s = rng.uniform(*SCALE_JITTER) if train else 1.0
    if s != 1.0:
        W2, H2 = int(round(W * s)), int(round(H * s))
        im = im.resize((W2, H2), Image.BILINEAR)
        boxes = [[b[0] * s, b[1] * s, b[2] * s, b[3] * s, b[4]] for b in boxes]
        ign = [[b[0] * s, b[1] * s, b[2] * s, b[3] * s] for b in ign]
        synth = [[b[0] * s, b[1] * s, b[2] * s, b[3] * s] for b in synth]
        W, H = W2, H2
    a = np.asarray(im, np.float32) / 255.0
    canvas = np.full((max(H, CROP), max(W, CROP), 3), 0.45, np.float32)
    canvas[:H, :W] = a
    x0 = int(rng.integers(0, max(W, CROP) - CROP + 1)) if train else (max(W, CROP) - CROP) // 2
    y0 = int(rng.integers(0, max(H, CROP) - CROP + 1)) if train else (max(H, CROP) - CROP) // 2
    img = canvas[y0:y0 + CROP, x0:x0 + CROP]
    flip = train and rng.random() < 0.5  # mọi họ đều đối xứng trái-phải
    if flip:
        img = img[:, ::-1]
    tb, ti = [], []
    for x, y, w, h, f in boxes:
        x, y = x - x0, y - y0
        if flip:
            x = CROP - x - w
        vis_w = min(x + w, CROP) - max(x, 0)
        vis_h = min(y + h, CROP) - max(y, 0)
        if vis_w <= 0 or vis_h <= 0:
            continue
        cx, cy = x + w / 2, y + h / 2
        if vis_w * vis_h >= MIN_VISIBLE * w * h and 0 <= cx < CROP and 0 <= cy < CROP:
            tb.append([x, y, w, h, f])
        else:
            ti.append([max(x, 0), max(y, 0), vis_w, vis_h])
    for x, y, w, h in ign:
        x, y = x - x0, y - y0
        if flip:
            x = CROP - x - w
        ti.append([x, y, w, h])
    ts = []
    for x, y, w, h in synth:
        x, y = x - x0, y - y0
        if flip:
            x = CROP - x - w
        ts.append([x, y, w, h])
    if train:
        img = img * rng.uniform(0.8, 1.2) + rng.uniform(-0.06, 0.06)
        img = np.clip(img, 0, 1)
    out = CROP // B.STRIDE
    heat, size, off, pos, mask = B.make_targets(tb, ti, out, out, neg_weight=neg_w, full=ts)
    return np.ascontiguousarray(img, np.float32), heat, size, off, pos, mask


def load_batch(recs, order, b, batch, seed, epoch, train=True):
    """Lô thứ b theo thứ tự của epoch; mỗi ảnh có bộ sinh ngẫu nhiên riêng (hạt giống, epoch, chỉ số ảnh) nên
    đọc song song hay chạy lại đều cho đúng dữ liệu cũ."""
    items = [load_example(recs[i], np.random.default_rng([seed, epoch, int(i)]), train)
             for i in order[b * batch:(b + 1) * batch]]
    return b, [np.stack([it[k] for it in items]) for k in range(6)]


PREFETCH = 6  # số lô đọc trước trong luồng phụ


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--alpha", type=float, default=0.35)
    ap.add_argument("--seed", type=int, default=2)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--ckpt-minutes", type=float, default=20.0)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    B.set_determinism(args.seed)
    import tensorflow as tf
    import keras
    from collections import deque
    from concurrent.futures import ThreadPoolExecutor

    recs = B.load_scenes(args.data, "train")
    vrecs = B.load_scenes(args.data, "val")[:VAL_MAX]
    model = B.build_detector((CROP, CROP, 3), alpha=args.alpha)
    opt = keras.optimizers.AdamW(learning_rate=LR_PEAK, weight_decay=WEIGHT_DECAY, clipnorm=5.0)
    opt.build(model.trainable_variables)
    steps_per_epoch = len(recs) // args.batch
    total = steps_per_epoch * args.epochs
    B.log(f"bộ dò: {len(recs)} ảnh huấn luyện, {len(vrecs)} ảnh kiểm định, {model.count_params()} tham số, "
          f"{steps_per_epoch} bước/epoch × {args.epochs} epoch")

    state_p = os.path.join(args.out, "state.json")
    state = {"epoch": 0, "step": 0, "gstep": 0, "best": None, "history": [], "alpha": args.alpha,
             "params": model.count_params(), "train_sec": 0.0}
    if args.resume and os.path.exists(state_p):
        state = B.load_json(state_p)
        model.load_weights(os.path.join(args.out, "last.weights.h5"))
        saved = np.load(os.path.join(args.out, "optimizer.npz"))
        for i, v in enumerate(opt.variables):
            v.assign(saved[f"v{i}"])
        B.log(f"làm tiếp từ epoch {state['epoch']} bước {state['step']}")

    def save():
        model.save_weights(os.path.join(args.out, "last.tmp.weights.h5"))
        np.savez(os.path.join(args.out, "optimizer.tmp.npz"), **{f"v{i}": v.numpy() for i, v in enumerate(opt.variables)})
        os.replace(os.path.join(args.out, "last.tmp.weights.h5"), os.path.join(args.out, "last.weights.h5"))
        os.replace(os.path.join(args.out, "optimizer.tmp.npz"), os.path.join(args.out, "optimizer.npz"))
        B.save_json_atomic(state_p, state, indent=1)

    def losses(heat_logit, reg, heat, size, off, pos, mask):
        p = tf.sigmoid(heat_logit)
        logp = tf.math.log_sigmoid(heat_logit)
        log1mp = tf.math.log_sigmoid(-heat_logit)
        is_pos = tf.cast(tf.equal(heat, 1.0), tf.float32)
        npos = tf.maximum(1.0, tf.reduce_sum(is_pos))
        m = mask[..., None]
        pos_l = -logp * tf.pow(1 - p, FOCAL_ALPHA) * is_pos
        neg_l = -log1mp * tf.pow(p, FOCAL_ALPHA) * tf.pow(1 - heat, FOCAL_BETA) * (1 - is_pos) * m
        l_heat = (tf.reduce_sum(pos_l) + tf.reduce_sum(neg_l)) / npos
        pm = pos[..., None]
        npc = tf.maximum(1.0, tf.reduce_sum(pos))
        l_size = tf.reduce_sum(tf.abs(reg[..., :2] - size) * pm) / npc
        l_off = tf.reduce_sum(tf.abs(reg[..., 2:] - off) * pm) / npc
        return l_heat, l_size, l_off

    @tf.function(reduce_retracing=True)
    def train_step(x, heat, size, off, pos, mask):
        with tf.GradientTape() as tape:
            hl, reg = model(x, training=True)
            lh, ls, lo = losses(hl, reg, heat, size, off, pos, mask)
            loss = lh + SIZE_W * ls + OFF_W * lo
        grads = tape.gradient(loss, model.trainable_variables)
        opt.apply_gradients(zip(grads, model.trainable_variables))
        return loss, lh, ls, lo

    @tf.function(reduce_retracing=True)
    def val_step(x, heat, size, off, pos, mask):
        hl, reg = model(x, training=False)
        return losses(hl, reg, heat, size, off, pos, mask)

    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("flag", True))
    last_ckpt = time.time()
    pool = ThreadPoolExecutor(max(1, args.workers))
    while state["epoch"] < args.epochs:
        e = state["epoch"]
        order = np.random.default_rng([args.seed, e]).permutation(len(recs))
        nb = len(order) // args.batch
        pending = deque()
        nxt = state["step"]
        t_ep = time.time()
        n_img = 0
        acc = np.zeros(4)
        k = 0
        while True:
            while len(pending) < PREFETCH and nxt < nb:
                pending.append(pool.submit(load_batch, recs, order, nxt, args.batch, args.seed, e))
                nxt += 1
            if not pending:
                break
            item = pending.popleft().result()
            b, (x, heat, size, off, pos, mask) = item
            opt.learning_rate.assign(lr_at(state["gstep"], total))
            out = train_step(x, heat, size, off, pos, mask)
            acc += np.array([float(v) for v in out])
            k += 1
            n_img += len(x)
            state["step"] = b + 1
            state["gstep"] += 1
            if state["gstep"] % LOG_EVERY == 0:
                el = time.time() - t_ep
                B.log(f"epoch {e} bước {b + 1}/{steps_per_epoch}: loss {acc[0] / k:.3f} (heat {acc[1] / k:.3f}, "
                      f"size {acc[2] / k:.3f}, off {acc[3] / k:.3f}), {n_img / el:.1f} ảnh/s")
            if stop["flag"] or time.time() - last_ckpt > args.ckpt_minutes * 60:
                state["train_sec"] += time.time() - t_ep
                t_ep = time.time()
                save()
                last_ckpt = time.time()
                B.log(f"đã lưu điểm khôi phục (epoch {e}, bước {state['step']})")
                if stop["flag"]:
                    pool.shutdown(wait=False, cancel_futures=True)
                    B.log("dừng theo tín hiệu; chạy lại với --resume để làm tiếp")
                    sys.exit(3)
                n_img = 0
                acc[:] = 0
                k = 0
        state["train_sec"] += time.time() - t_ep
        # kiểm định: ô giữa 320×320 của ảnh kiểm định
        vl = np.zeros(3)
        vb = 0
        for vb_i in range(len(vrecs) // args.batch):
            _, (x, heat, size, off, pos, mask) = load_batch(vrecs, np.arange(len(vrecs)), vb_i, args.batch, args.seed, 0,
                                                            train=False)
            vl += np.array([float(v) for v in val_step(x, heat, size, off, pos, mask)])
            vb += 1
        vl /= max(1, vb)
        vloss = float(vl[0] + SIZE_W * vl[1] + OFF_W * vl[2])
        rec = {"epoch": e, "val_loss": vloss, "val_heat": float(vl[0]), "val_size": float(vl[1]),
               "val_off": float(vl[2]), "train_sec_total": round(state["train_sec"], 1),
               "img_per_s": round(state["gstep"] * args.batch / max(1.0, state["train_sec"]), 2)}
        state["history"].append(rec)
        B.log(f"epoch {e}: {rec}")
        if state["best"] is None or vloss < state["best"]:
            state["best"] = vloss
            state["best_epoch"] = e
            model.save_weights(os.path.join(args.out, "best.tmp.weights.h5"))
            os.replace(os.path.join(args.out, "best.tmp.weights.h5"), os.path.join(args.out, "best.weights.h5"))
        state["epoch"] = e + 1
        state["step"] = 0
        save()
        last_ckpt = time.time()
    pool.shutdown(wait=False, cancel_futures=True)
    B.save_json_atomic(os.path.join(args.out, "history.json"), {
        "best_val_loss": state["best"], "best_epoch": state.get("best_epoch"), "epochs": args.epochs,
        "alpha": args.alpha, "params": state["params"], "seed": args.seed, "batch": args.batch, "crop": CROP,
        "n_train": len(recs), "history": state["history"], "train_sec": state["train_sec"]}, indent=1)
    B.log("xong")


if __name__ == "__main__":
    main()
