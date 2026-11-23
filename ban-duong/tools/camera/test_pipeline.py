# Kiểm thử các phần thuần tính toán của bộ công cụ Python: đích CenterNet và giải mã (khớp js/visionproto.js), trọng
# số lỗi âm, hiệu chỉnh nhiệt độ, ngưỡng E1, định dạng số của MODEL_CARD, bước lượng tử của mô hình int8.
# Chỉ dùng unittest của thư viện chuẩn (cần numpy; phần TFLite và phần so với Node tự bỏ qua nếu thiếu).
#
#   $BANDUONG_CACHE/venv/bin/python -I -B -m unittest discover -s tools/camera -p 'test_*.py' -v
# (train-all.sh chạy ở bước "selftest").
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True  # không để lại __pycache__ trong kho mã
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402

import bdcommon as B  # noqa: E402
import eval_synthetic as E  # noqa: E402


def peaks_from(boxes, h=44, w=80):
    """Đích heat/reg hoàn hảo cho các khung → đầu ra mô hình giả (heat đã sigmoid, reg đúng hợp đồng 2)."""
    heat, size, off, pos, _ = B.make_targets(boxes, [], h, w)
    reg = np.concatenate([size, off], axis=-1)
    return heat, reg, pos


class TargetsAndDecode(unittest.TestCase):
    def test_round_trip(self):
        boxes = [[100.0, 50.0, 24.0, 24.0, 0], [300.5, 120.25, 12.0, 14.0, 4], [500.0, 200.0, 60.0, 40.0, 8]]
        heat, reg, pos = peaks_from(boxes)
        self.assertEqual(int(pos.sum()), 3)
        dets = B.decode(heat, reg)
        self.assertEqual(len(dets), 3)
        got = sorted((round(d[0], 3), round(d[1], 3), round(d[2], 3), round(d[3], 3), d[4]) for d in dets)
        want = sorted((b[0], b[1], b[2], b[3], b[4]) for b in boxes)
        for g, t in zip(got, want):
            for a, b in zip(g, t):
                self.assertAlmostEqual(a, b, places=3)

    def test_threshold_cap_and_nms(self):
        heat = np.zeros((44, 80, 11), np.float32)
        reg = np.zeros((44, 80, 4), np.float32)
        reg[..., :2] = math.log(20.0)
        reg[..., 2:] = 0.5
        heat[10, 10, 0] = 0.31  # trên ngưỡng
        heat[20, 20, 0] = 0.29  # dưới ngưỡng
        heat[30, 40, 3] = 0.9
        heat[30, 40, 5] = 0.8  # cùng khung, họ khác: NMS không phân họ bỏ khung điểm thấp
        dets = B.decode(heat, reg)
        self.assertEqual([(d[4], round(d[5], 2)) for d in dets], [(3, 0.9), (0, 0.31)])
        # hơn MAX_BOXES đỉnh tách rời → chỉ giữ MAX_BOXES
        heat[:] = 0
        reg[..., :2] = math.log(4.0)
        for i in range(30):
            heat[2 + (i // 10) * 6, 2 + (i % 10) * 7, 1] = 0.5 + i / 100
        self.assertEqual(len(B.decode(heat, reg)), B.MAX_BOXES)
        # cạnh ngoài [1, MAX_BOX_SIDE] là đầu ra hỏng
        heat[:] = 0
        heat[5, 5, 2] = 0.8
        reg[5, 5, :2] = math.log(B.MAX_BOX_SIDE * 2)
        self.assertEqual(B.decode(heat, reg), [])

    def test_constants_match_runtime(self):
        self.assertEqual(B.PEAK_THRESHOLD, 0.30)
        self.assertEqual(B.NMS_IOU, 0.5)
        self.assertEqual(B.MAX_BOXES, 12)
        self.assertEqual(B.MAX_CANDIDATES, 64)
        self.assertEqual(B.MAX_BOX_SIDE, 1280)
        self.assertEqual((B.DET_H, B.DET_W, B.STRIDE, B.CLS_SIZE), (352, 640, 8, 48))

    @unittest.skipUnless(shutil.which("node"), "cần node để so với js/visionproto.js")
    def test_decoder_matches_visionproto(self):
        rng = np.random.default_rng(3)
        heat = (rng.random((44, 80, 11)) ** 6).astype(np.float32)  # thưa, nhiều đỉnh gần ngưỡng
        reg = np.concatenate([rng.uniform(np.log(3), np.log(90), (44, 80, 2)),
                              rng.uniform(-0.1, 1.1, (44, 80, 2))], axis=-1).astype(np.float32)
        py = B.decode(heat, reg)
        with tempfile.TemporaryDirectory() as d:
            heat.astype("<f4").tofile(os.path.join(d, "heat.bin"))
            reg.astype("<f4").tofile(os.path.join(d, "reg.bin"))
            js = (
                "const fs = require('fs'); const vm = require('vm');"
                "const ctx = { self: {}, globalThis: {} }; ctx.self = ctx;"
                "vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), ctx);"
                "const V = ctx.VisionProto || ctx.self.VisionProto || ctx.globalThis.VisionProto;"
                "const rd = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };"
                "const out = V.nms(V.decodePeaks(rd(process.argv[2]), rd(process.argv[3])));"
                "process.stdout.write(JSON.stringify(out.map((b) => [b.x, b.y, b.w, b.h, b.family, b.s])));"
            )
            r = subprocess.run(["node", "-e", js, os.path.join(B.APP_ROOT, "js", "visionproto.js"),
                                os.path.join(d, "heat.bin"), os.path.join(d, "reg.bin")],
                               capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        jsb = json.loads(r.stdout)
        self.assertGreater(len(py), 3)
        self.assertEqual(len(py), len(jsb))
        for a, b in zip(py, jsb):
            self.assertEqual(a[4], b[4])
            for u, v in zip(a[:4] + (a[5],), b[:4] + [b[5]]):
                self.assertAlmostEqual(u, v, places=3)

    def test_negative_weights(self):
        _, _, _, _, m = B.make_targets([[100, 100, 16, 16, 0]], [[300, 100, 20, 20]], 44, 80,
                                       neg_weight=B.NEG_W_UNVERIFIED, full=[[500, 200, 30, 30]])
        self.assertAlmostEqual(float(m[5, 5]), B.NEG_W_UNVERIFIED)  # ảnh nền chưa kiểm
        self.assertEqual(float(m[13, 13]), 1.0)  # quanh biển tự vẽ
        self.assertEqual(float(m[26, 64]), 1.0)  # quanh vật tự vẽ khác
        self.assertEqual(float(m[13, 38]), 0.0)  # vùng bỏ qua thắng
        _, _, _, _, m1 = B.make_targets([], [], 44, 80)
        self.assertTrue(np.all(m1 == 1.0))
        self.assertEqual(B.NEG_W_UNVERIFIED, 0.25)
        self.assertEqual(B.SYNTH_PAD, 4.0)
        self.assertEqual(B.IGNORE_PAD, 2.0)


class Calibration(unittest.TestCase):
    def test_fit_temperature_recovers_T(self):
        rng = np.random.default_rng(0)
        n, k = 4000, 10
        true = rng.normal(0, 3, (n, k))
        p = B.softmax(true)
        y = np.array([rng.choice(k, p=row) for row in p])
        T = B.fit_temperature(true * 2.0, y)  # logit bị phóng 2 lần → T ≈ 2
        self.assertAlmostEqual(T, 2.0, delta=0.15)
        self.assertLess(B.nll(true * 2.0, y, T), B.nll(true * 2.0, y, 1.0))

    def test_ece(self):
        probs = np.array([[0.9, 0.1], [0.9, 0.1], [0.6, 0.4], [0.6, 0.4]])
        y = np.array([0, 0, 0, 1])
        # ngăn 0,9: đúng 2/2 → |1 − 0,9| = 0,1; ngăn 0,6: đúng 1/2 → 0,1
        self.assertAlmostEqual(B.ece(probs, y), 0.1, places=6)
        self.assertEqual(B.ECE_BINS, 15)


class Gate(unittest.TestCase):
    def test_constants(self):
        self.assertEqual((E.GATE_TOP1, E.GATE_MIN_WIDTH, E.GATE_Z, E.GATE_MIN_N, E.PRUNE_MAX), (0.97, 24, 1.645, 100, 5))
        self.assertEqual(E.CLS_WIDTHS, (20, 24, 32, 48))
        self.assertEqual(E.DET_WIDTHS, (8, 10, 12, 16, 20))

    def test_wilson(self):
        self.assertAlmostEqual(E.wilson_upper(191, 200), 0.9736, places=3)
        self.assertLess(E.wilson_upper(190, 200), 0.97)
        self.assertEqual(E.wilson_upper(0, 0), 1.0)

    def test_gate_label(self):
        ok = {20: (150, 200), 24: (196, 200), 32: (197, 200), 48: (199, 200)}
        self.assertTrue(E.gate_label(ok)["pass"])  # 20 px không tính
        low = {24: (189, 200), 32: (200, 200), 48: (200, 200)}  # gộp 98,2 % nhưng 24 px thấp rõ rệt
        g = E.gate_label(low)
        self.assertFalse(g["pass"])
        self.assertEqual(g["low"], [24])
        dip = {24: (192, 200), 32: (195, 200), 48: (198, 200)}  # 96 % ở 24 px là dao động, gộp 97,5 %
        self.assertTrue(E.gate_label(dip)["pass"])
        under = {24: (193, 200), 32: (193, 200), 48: (194, 200)}  # gộp 96,7 %
        self.assertFalse(E.gate_label(under)["pass"])
        few = {24: (25, 25), 32: (25, 25), 48: (25, 25)}
        self.assertIsNone(E.gate_label(few)["pass"])
        self.assertIsNone(E.gate_label({})["pass"])

    def test_gate_power(self):
        """Với 200 ảnh mỗi cạnh: nhãn đúng 98 % qua ≥ 90 % số lần, nhãn đúng 95 % hầu như không qua."""
        rng = np.random.default_rng(1)

        def rate(p, trials=400):
            ok = 0
            for _ in range(trials):
                ok += bool(E.gate_label({c: (int(rng.binomial(200, p)), 200) for c in (24, 32, 48)})["pass"])
            return ok / trials
        self.assertGreater(rate(0.98), 0.9)
        self.assertLess(rate(0.95), 0.05)

    def test_apply_gate_idempotent(self):
        lj = {"labels": [{"label": "A", "learn": True}, {"label": "B", "learn": True}, {"label": "C", "learn": False}],
              "build": {}}
        self.assertEqual(E.apply_gate(lj, ["B"], True), ["B"])
        self.assertEqual([l["learn"] for l in lj["labels"]], [True, False, False])
        self.assertEqual(lj["build"]["pruned"], ["B"])
        self.assertEqual(E.whitelist_of(lj), ["A", "B"])
        self.assertEqual(E.apply_gate(lj, ["B"], False), [])  # chạy lại không --prune: trả lại cờ learn
        self.assertEqual([l["learn"] for l in lj["labels"]], [True, True, False])
        self.assertEqual(E.apply_gate(lj, ["C"], True), [])  # nhãn ngoài danh sách học không bị đụng tới


class NumberFormat(unittest.TestCase):
    def test_helpers(self):
        self.assertEqual(E.vn_int(309807), "309.807")
        self.assertEqual(E.vn_int(3200), "3.200")
        self.assertEqual(E.vn_int(12), "12")
        self.assertEqual(E.vn_num(0.35, 2), "0,35")
        self.assertEqual(E.vn_num(1234.5, 1), "1.234,5")
        self.assertEqual(E.vn_pct(0.97, 0), "97 %")
        self.assertEqual(E.vn_pct(0.9734), "97,3 %")
        self.assertEqual(E.vn_pct(None), "–")

    def test_model_card_numbers(self):
        from collections import Counter
        labels = [{"i": 0, "label": "P.127[50]", "learn": True}, {"i": 1, "label": "background", "learn": False}]
        counts = {"P.127[50]": {20: (180, 200), 24: (196, 200), 32: (198, 200), 48: (200, 200)},
                  "background": {20: (20, 25), 24: (24, 25), 32: (25, 25), 48: (25, 25)}}
        ctx = {
            "labels": labels, "whitelist": ["P.127[50]"], "counts": counts, "conf": Counter({(0, 1): 1234}),
            "gates": {"P.127[50]": E.gate_label(counts["P.127[50]"])}, "failing": [], "n_testw": 3200,
            "cal": {"ece_before": 0.05, "ece_after": 0.0123, "n": 7240, "acc": 0.95, "false_accept_reject_classes": 0.001,
                    "accept_precision": 0.995, "accept_rate_learnable": 0.9},
            "det": {"A": {"recall_family": {w: 0.5 for w in E.DET_WIDTHS}, "recall_any": {w: 0.6 for w in E.DET_WIDTHS},
                          "fp_per_image": 0.25, "fp_per_clean_image": None, "n_clean_images": 0}},
            "T": 1.2345, "build": {"gitCommit": "abc", "provenance": {"gitDirty": True, "artDigest": "f" * 64}},
            "hc": {"params": 350805, "epochs_run": 36, "batch": 128, "seed": 1, "best_val_acc": 0.95, "best_epoch": 30},
            "hd": {"params": 309807, "alpha": 0.35, "epochs": 30, "batch": 16, "crop": 320, "seed": 2,
                   "best_val_loss": 1.2345, "best_epoch": 29, "train_sec": 14000.0},
            "calib": {"ece_before": 0.04, "ece_after": 0.01}, "bg_n": {"train": 6400, "val": 800, "test": 800},
            "bg_clean": 44, "bg_verified": 160, "prune": True, "pruned": [], "prune_refused": None,
            "done_crops": {"train": {"n": 124000}}, "done_scenes": {"train": {"n": 12000}}, "date": "2026-11-23 12:00 UTC",
        }
        card = E.model_card(ctx)
        for s in ("309.807", "350.805", "α 0,35", "3.200 ảnh", "124.000 ảnh", "train 6.400", "97 %", "T = 1,2345",
                  "| 1.234 |", "3,89 giờ", "có thay đổi chưa commit"):
            self.assertIn(s, card)
        for bad in ("309,807", "0.35", "3,200 ảnh", "97%", "1.2345"):
            self.assertNotIn(bad, card)
        self.assertNotIn("LỖI", card)


@unittest.skipUnless(shutil.which("node") is not None, "cần node")
class Provenance(unittest.TestCase):
    def test_provenance_from_node(self):
        p = B.provenance()
        self.assertIn("js/signart.js", p["sources"])
        self.assertRegex(p["sources"]["js/signart.js"], r"^[0-9a-f]{64}$")
        self.assertRegex(p["artDigest"], r"^[0-9a-f]{64}$")
        self.assertIn("gitDirty", p)


class OutputScale(unittest.TestCase):
    def test_scale_of_int8_outputs(self):
        try:
            import tensorflow as tf
            import keras
        except ImportError:
            self.skipTest("không có TensorFlow")
        inp = keras.Input((8, 8, 3))
        x = keras.layers.Conv2D(4, 3, padding="same")(inp)
        a = keras.layers.Activation("sigmoid")(x)
        b = keras.layers.Conv2D(2, 1)(x)
        m = keras.Model(inp, [a, b])
        rng = np.random.default_rng(0)
        rep = [rng.random((1, 8, 8, 3)).astype(np.float32) for _ in range(16)]
        with tempfile.TemporaryDirectory() as d:
            sm = os.path.join(d, "sm")
            m.export(sm, format="tf_saved_model", input_signature=[tf.TensorSpec([1, 8, 8, 3], tf.float32)], verbose=False)
            conv = tf.lite.TFLiteConverter.from_saved_model(sm)
            conv.optimizations = [tf.lite.Optimize.DEFAULT]
            conv.representative_dataset = lambda: ([r] for r in rep)
            conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
            conv.inference_input_type = tf.float32
            conv.inference_output_type = tf.float32
            data = conv.convert()
        it = tf.lite.Interpreter(model_content=data)
        it.allocate_tensors()
        scales = {}
        for o in it.get_output_details():
            scales[int(o["shape"][-1])] = B.output_scale(it, o["index"])
        self.assertAlmostEqual(scales[4], 1 / 256, places=6)  # sigmoid int8: bước 1/256
        self.assertGreater(scales[2], 0)
        # bước thật = khoảng cách nhỏ nhất có thể giữa hai giá trị ra
        it.set_tensor(it.get_input_details()[0]["index"], rep[0])
        it.invoke()
        for o in it.get_output_details():
            v = it.get_tensor(o["index"]).astype(np.float64).ravel()
            q = v / scales[int(o["shape"][-1])]
            self.assertTrue(np.allclose(q - q.min(), np.round(q - q.min()), atol=1e-3))
        with self.assertRaises(ValueError):
            B.output_scale(it, 10 ** 6)


if __name__ == "__main__":
    unittest.main()
