# Huấn luyện bộ phân loại 48×48 từ đầu (không dùng trọng số có sẵn) trên ảnh cắt của render-crops.mjs.
#
#   python -I tools/camera/train_classifier.py --data $BANDUONG_CACHE/crops --out $BANDUONG_CACHE/run/cls \
#          [--labels models/labels.json] [--epochs 36] [--batch 128] [--seed 1]
#
# tf.data với tăng cường nhẹ (độ sáng, tương phản, bão hoà, sắc độ, dịch ±2 điểm ảnh) dùng phép ngẫu nhiên
# không trạng thái (hạt giống theo epoch và bước), cân bằng lớp bằng trọng số mẫu, dừng sớm theo độ chính xác
# trên tập kiểm định, tf.config.experimental.enable_op_determinism(). Lưu trạng thái sau mỗi epoch (last.weights.h5,
# optimizer.npz, state.json): chạy lại cùng lệnh thì làm tiếp từ epoch kế. Kết quả: best.weights.h5, history.json.
import argparse
import os
import signal
import sys
import time

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402

import bdcommon as B  # noqa: E402

PATIENCE = 6  # dừng khi độ chính xác kiểm định không tăng sau chừng này epoch
LR_PEAK = 2e-3  # tốc độ học lớn nhất (Adam)
WARMUP_EPOCHS = 1  # tăng dần tốc độ học trong epoch đầu
WEIGHT_DECAY = 1e-4  # suy giảm trọng số của AdamW
REJECT_WEIGHT = 1.5  # nhân thêm trọng số cho "background" và "other-sign" (từ chối nhầm tốn ít hơn nhận nhầm)
SHIFT_PX = 2.0  # dịch ảnh tối đa khi tăng cường (điểm ảnh)


def lr_at(epoch, epochs):
    if epoch < WARMUP_EPOCHS:
        return LR_PEAK * (epoch + 1) / (WARMUP_EPOCHS + 1)
    t = (epoch - WARMUP_EPOCHS) / max(1, epochs - WARMUP_EPOCHS)
    return LR_PEAK * 0.5 * (1 + np.cos(np.pi * min(1.0, t)))


def class_weights(y, labels):
    n = len(labels)
    cnt = np.bincount(y, minlength=n).astype(np.float64)
    present = cnt > 0
    w = np.zeros(n)
    w[present] = cnt[present].mean() / cnt[present]
    for l in labels:
        if l["label"] in ("background", "other-sign"):
            w[l["i"]] *= REJECT_WEIGHT
    w[present] /= np.average(w[present], weights=cnt[present])  # trung bình theo mẫu = 1
    return w.astype(np.float32)


def make_dataset(tf, X, y, sw, batch, seed, epoch, start_step=0, train=True):
    n = len(X)
    idx = np.arange(n)
    if train:
        idx = np.random.default_rng([seed, epoch]).permutation(n)
    steps = n // batch if train else -(-n // batch)
    idx = idx[: steps * batch] if train else idx
    idx = idx[start_step * batch:]
    ds = tf.data.Dataset.from_tensor_slices(idx.astype(np.int64)).batch(batch)
    Xc, yc, swc = X, y, sw

    def gather(i):
        return Xc[i], yc[i], swc[i]

    def load(ib):
        x, t, w = tf.numpy_function(gather, [ib], [tf.uint8, tf.int32, tf.float32])
        x.set_shape([None, B.CLS_SIZE, B.CLS_SIZE, 3])
        t.set_shape([None])
        w.set_shape([None])
        return x, t, w

    ds = ds.map(load, num_parallel_calls=4, deterministic=True)
    if train:
        steps_ds = tf.data.Dataset.range(start_step, steps)
        ds = tf.data.Dataset.zip((ds, steps_ds))

        def aug(data, step):
            x, t, w = data
            x = tf.cast(x, tf.float32) / 255.0
            bs = tf.shape(x)[0]
            s = tf.stack([tf.cast(seed * 100003 + epoch, tf.int64), step])
            k = lambda j: tf.random.experimental.stateless_fold_in(s, j)  # noqa: E731
            x = x + tf.random.stateless_uniform([bs, 1, 1, 1], k(1), -0.12, 0.12)
            mean = tf.reduce_mean(x, axis=[1, 2, 3], keepdims=True)
            x = (x - mean) * tf.random.stateless_uniform([bs, 1, 1, 1], k(2), 0.75, 1.25) + mean
            grey = tf.reduce_mean(x, axis=3, keepdims=True)
            x = (x - grey) * tf.random.stateless_uniform([bs, 1, 1, 1], k(3), 0.7, 1.3) + grey
            x = tf.image.adjust_hue(tf.clip_by_value(x, 0, 1), tf.random.stateless_uniform([], k(4), -0.03, 0.03))
            d = tf.random.stateless_uniform([bs, 2], k(5), -SHIFT_PX, SHIFT_PX)
            tr = tf.concat([tf.ones([bs, 1]), tf.zeros([bs, 1]), d[:, :1], tf.zeros([bs, 1]), tf.ones([bs, 1]),
                            d[:, 1:], tf.zeros([bs, 2])], axis=1)
            x = tf.raw_ops.ImageProjectiveTransformV3(images=x, transforms=tr, output_shape=[B.CLS_SIZE, B.CLS_SIZE],
                                                       fill_value=0.0, interpolation="BILINEAR", fill_mode="REFLECT")
            return tf.clip_by_value(x, 0.0, 1.0), t, w

        ds = ds.map(aug, num_parallel_calls=4, deterministic=True)
    else:
        ds = ds.map(lambda x, t, w: (tf.cast(x, tf.float32) / 255.0, t), num_parallel_calls=4, deterministic=True)
    return ds.prefetch(4), steps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--labels", default=B.DEFAULT_LABELS)
    ap.add_argument("--epochs", type=int, default=36)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    B.set_determinism(args.seed)
    import tensorflow as tf
    import keras

    labels = B.load_json(args.labels)["labels"]
    X, y, _, _ = B.load_crops(args.data, "train")
    Xv, yv, _, _ = B.load_crops(args.data, "val")
    cw = class_weights(y, labels)
    sw = cw[y]
    B.log(f"bộ phân loại: {len(X)} ảnh huấn luyện, {len(Xv)} ảnh kiểm định, {int((cw > 0).sum())} lớp có ảnh")

    model = B.build_classifier(len(labels))
    opt = keras.optimizers.AdamW(learning_rate=LR_PEAK, weight_decay=WEIGHT_DECAY)
    model.compile(optimizer=opt, loss=keras.losses.SparseCategoricalCrossentropy(from_logits=True),
                  weighted_metrics=[], metrics=["accuracy"])
    state_p = os.path.join(args.out, "state.json")
    state = {"epoch": 0, "best": -1.0, "best_epoch": -1, "wait": 0, "history": [], "params": model.count_params()}
    if os.path.exists(state_p):
        state = B.load_json(state_p)
        model.load_weights(os.path.join(args.out, "last.weights.h5"))
        opt.build(model.trainable_variables)
        saved = np.load(os.path.join(args.out, "optimizer.npz"))
        for v, k in zip(opt.variables, sorted(saved.files, key=lambda s: int(s[1:]))):
            v.assign(saved[k])
        B.log(f"làm tiếp từ epoch {state['epoch']}")
    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("flag", True))
    val_ds, _ = make_dataset(tf, Xv, yv, np.ones(len(yv), np.float32), 512, args.seed, 0, train=False)

    while state["epoch"] < args.epochs and state["wait"] < PATIENCE and not stop["flag"]:
        e = state["epoch"]
        opt.learning_rate.assign(lr_at(e, args.epochs))
        ds, steps = make_dataset(tf, X, y, sw, args.batch, args.seed, e)
        t0 = time.time()
        h = model.fit(ds, epochs=1, steps_per_epoch=steps, verbose=2)
        dt = time.time() - t0
        _, vacc = model.evaluate(val_ds, verbose=0)
        rec = {"epoch": e, "loss": float(h.history["loss"][-1]), "acc": float(h.history["accuracy"][-1]),
               "val_acc": float(vacc), "sec": round(dt, 1), "img_per_s": round(steps * args.batch / dt, 1),
               "lr": float(lr_at(e, args.epochs))}
        state["history"].append(rec)
        B.log(f"epoch {e}: {rec}")
        if vacc > state["best"]:
            state.update(best=float(vacc), best_epoch=e, wait=0)
            model.save_weights(os.path.join(args.out, "best.tmp.weights.h5"))
            os.replace(os.path.join(args.out, "best.tmp.weights.h5"), os.path.join(args.out, "best.weights.h5"))
        else:
            state["wait"] += 1
        state["epoch"] = e + 1
        model.save_weights(os.path.join(args.out, "last.tmp.weights.h5"))
        np.savez(os.path.join(args.out, "optimizer.tmp.npz"), **{f"v{i}": v.numpy() for i, v in enumerate(opt.variables)})
        os.replace(os.path.join(args.out, "last.tmp.weights.h5"), os.path.join(args.out, "last.weights.h5"))
        os.replace(os.path.join(args.out, "optimizer.tmp.npz"), os.path.join(args.out, "optimizer.npz"))
        B.save_json_atomic(state_p, state, indent=1)
    if stop["flag"]:
        B.log("dừng theo tín hiệu; chạy lại để làm tiếp")
        sys.exit(3)
    B.save_json_atomic(os.path.join(args.out, "history.json"), {
        "best_val_acc": state["best"], "best_epoch": state["best_epoch"], "epochs_run": state["epoch"],
        "params": state["params"], "history": state["history"], "seed": args.seed, "batch": args.batch,
        "n_train": int(len(X)), "n_val": int(len(Xv))}, indent=1)
    B.log(f"xong: độ chính xác kiểm định tốt nhất {state['best']:.4f} ở epoch {state['best_epoch']}")


if __name__ == "__main__":
    main()
