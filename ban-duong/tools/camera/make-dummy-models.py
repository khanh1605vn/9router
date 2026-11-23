# Builds random-weight TFLite models with exactly the runtime I/O contract of the real ones, for browser tests of
# the vision worker (shapes, decoding, timing). They recognise nothing. Never copy them into the app.
#
#   $VENV/bin/python -I tools/camera/make-dummy-models.py [--out ~/.cache/ban-duong-train/dummy] [--labels 181] [--seed 7]
#
# Contract (labels.json / PLAN §4.2):
#   sign-det.int8.tflite  input float32 [1,352,640,3] RGB in [0,1]; int8 inside; exactly two float32 outputs:
#                         heat [1,44,80,11] (sigmoid applied) and reg [1,44,80,4] = [log_w, log_h, off_x, off_y]
#                         (offsets sigmoid-applied, in [0,1]); stride 8.
#   sign-cls.int8.tflite  input float32 [1,48,48,3]; float32 logits [1,N] (no softmax).
# The detector is a MobileNetV2-style backbone (width 0.35) fused to one stride-8 map, so its cost is close to the
# planned real detector; the classifier is a ~0.37 M-parameter CNN, the planned size class.
import argparse
import hashlib
import json
import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import numpy as np  # noqa: E402
import tensorflow as tf  # noqa: E402
from tensorflow import keras  # noqa: E402
from tensorflow.keras import layers  # noqa: E402

DET_H, DET_W, STRIDE, FAMILIES = 352, 640, 8, 11
CLS_SIZE = 48
# Head biases chosen so random weights still give a few heat peaks and box sizes the classifier accepts (18-49 px).
HEAT_BIAS, HEAT_GAIN = -2.5, 2.5
LOGWH_BIAS, LOGWH_GAIN = 3.4, 0.5
REP_SAMPLES = 16  # representative inputs for int8 calibration


def detector(alpha):
    inp = keras.Input((DET_H, DET_W, 3), batch_size=1)  # fixed batch: the runtime wants static shapes
    base = keras.applications.MobileNetV2(input_tensor=inp, alpha=alpha, include_top=False, weights=None)
    c3 = base.get_layer("block_6_expand_relu").output  # stride 8
    c4 = base.get_layer("block_13_expand_relu").output  # stride 16
    c5 = base.output  # stride 32

    def lat(x):
        x = layers.Conv2D(48, 1, use_bias=False)(x)
        x = layers.BatchNormalization()(x)
        return layers.ReLU(6.0)(x)

    p = layers.Add()([lat(c3), layers.UpSampling2D(2)(lat(c4)), layers.UpSampling2D(4)(lat(c5))])
    p = layers.DepthwiseConv2D(3, padding="same", use_bias=False)(p)
    p = layers.BatchNormalization()(p)
    p = layers.ReLU(6.0)(p)
    p = layers.Conv2D(48, 1, use_bias=False)(p)
    p = layers.BatchNormalization()(p)
    p = layers.ReLU(6.0)(p)
    heat = layers.Conv2D(FAMILIES, 1, activation="tanh")(p)
    heat = layers.Activation("sigmoid", name="heat")(layers.Rescaling(HEAT_GAIN, HEAT_BIAS)(heat))
    wh = layers.Conv2D(2, 1, activation="tanh")(p)
    wh = layers.Rescaling(LOGWH_GAIN, LOGWH_BIAS)(wh)
    off = layers.Conv2D(2, 1, activation="sigmoid")(p)
    reg = layers.Concatenate(name="reg")([wh, off])
    return keras.Model(base.input, [heat, reg], name="dummy_det")


def settle_batchnorm(model, rng):
    # Random init leaves BatchNorm at mean 0 / var 1, so activations vanish through the backbone and every output is
    # constant. One training-mode pass with momentum 0 sets the moving statistics to real ones.
    for layer in model.layers:
        if isinstance(layer, layers.BatchNormalization):
            layer.momentum = 0.0
    model(rng.random(tuple(model.inputs[0].shape), dtype=np.float32), training=True)


def classifier(n):
    x = inp = keras.Input((CLS_SIZE, CLS_SIZE, 3), batch_size=1)
    for f in (32, 64, 128):
        x = layers.Conv2D(f, 3, padding="same", activation="relu")(x)
        x = layers.Conv2D(f, 3, strides=2, padding="same", activation="relu")(x)
    x = layers.GlobalAveragePooling2D()(x)
    x = layers.Dense(256, activation="relu")(x)
    out = layers.Dense(n, name="logits")(x)
    return keras.Model(inp, out, name="dummy_cls")


def to_int8(model, shape, rng):
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.float32
    conv.inference_output_type = tf.float32
    conv.representative_dataset = lambda: ([rng.random(shape, dtype=np.float32)] for _ in range(REP_SAMPLES))
    return conv.convert()


def check(blob, want_in, want_outs):
    it = tf.lite.Interpreter(model_content=blob)
    it.allocate_tensors()
    ins, outs = it.get_input_details(), it.get_output_details()
    assert len(ins) == 1 and list(ins[0]["shape"]) == want_in and ins[0]["dtype"] == np.float32, ins
    got = sorted([list(o["shape"]) for o in outs])
    assert got == sorted(want_outs), got
    assert all(o["dtype"] == np.float32 for o in outs), outs
    int8 = sum(1 for t in it.get_tensor_details() if t["dtype"] == np.int8)
    assert int8 > 0, "model is not int8 inside"
    return it, int8


def main():
    ap = argparse.ArgumentParser()
    cache = os.environ.get("BANDUONG_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "ban-duong-train")
    ap.add_argument("--out", default=os.path.join(cache, "dummy"))
    ap.add_argument("--labels", type=int, default=181)
    ap.add_argument("--alpha", type=float, default=0.35)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    out = os.path.realpath(a.out)
    app = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    if out == app or out.startswith(app + os.sep):
        sys.exit("refusing to write dummy models inside the app")
    os.makedirs(out, exist_ok=True)
    keras.utils.set_random_seed(a.seed)
    rng = np.random.default_rng(a.seed)

    det_model = detector(a.alpha)
    settle_batchnorm(det_model, rng)
    det = to_int8(det_model, (1, DET_H, DET_W, 3), rng)
    hh, ww = DET_H // STRIDE, DET_W // STRIDE
    it, det_int8 = check(det, [1, DET_H, DET_W, 3], [[1, hh, ww, FAMILIES], [1, hh, ww, 4]])
    it.set_tensor(it.get_input_details()[0]["index"], rng.random((1, DET_H, DET_W, 3), dtype=np.float32))
    it.invoke()
    o = {tuple(d["shape"])[-1]: it.get_tensor(d["index"]) for d in it.get_output_details()}
    heat, reg = o[FAMILIES], o[4]
    assert 0 <= heat.min() and heat.max() <= 1 and 0 <= reg[..., 2:].min() and reg[..., 2:].max() <= 1

    cls = to_int8(classifier(a.labels), (1, CLS_SIZE, CLS_SIZE, 3), rng)
    _, cls_int8 = check(cls, [1, CLS_SIZE, CLS_SIZE, 3], [[1, a.labels]])

    report = {"note": "random weights; test fixtures only", "seed": a.seed, "alpha": a.alpha, "labels": a.labels,
              "tensorflow": tf.__version__, "files": {}}
    for name, blob, n8 in (("sign-det.int8.tflite", det, det_int8), ("sign-cls.int8.tflite", cls, cls_int8)):
        with open(os.path.join(out, name), "wb") as f:
            f.write(blob)
        report["files"][name] = {"size": len(blob), "sha256": hashlib.sha256(blob).hexdigest(), "int8_tensors": n8}
    # Golden input/output pairs from TF's own interpreter, so the browser test can check that the worker feeds and
    # reads tensors the same way (layout, output order).
    gold = os.path.join(out, "golden")
    os.makedirs(gold, exist_ok=True)
    for name, blob, shape in (("det", det, (1, DET_H, DET_W, 3)), ("cls", cls, (1, CLS_SIZE, CLS_SIZE, 3))):
        gi = tf.lite.Interpreter(model_content=blob)
        gi.allocate_tensors()
        x = rng.random(shape, dtype=np.float32)
        gi.set_tensor(gi.get_input_details()[0]["index"], x)
        gi.invoke()
        x.tofile(os.path.join(gold, f"{name}-in.f32"))
        for d in gi.get_output_details():
            gi.get_tensor(d["index"]).astype(np.float32).tofile(os.path.join(gold, f"{name}-out-{d['shape'][-1]}.f32"))
    report["det_heat_ge_0.30_on_noise"] = int((heat >= 0.30).sum())
    report["det_w_px_range_on_noise"] = [float(np.exp(reg[..., 0].min())), float(np.exp(reg[..., 0].max()))]
    with open(os.path.join(out, "dummy-report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
