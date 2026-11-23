import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../js/visionproto.js';
import {
  chooseBuild,
  clipHints,
  planFiles,
  quantile,
  RollingStats,
  toHex,
  verifyBytes,
  Vision,
  VISION_LIMITS,
  VISION_ERROR_CODES,
  VisionError,
  visionSupport,
  WASM_PROBES,
  wasmFeatures,
} from '../js/vision.js';
import { ML_MANIFEST } from '../js/mlmanifest.js';
import { nextVersion, parseManifest, render, scan } from '../tools/camera/write-manifest.mjs';
import { checkOutDir, inside, OUTPUTS, parseArgs } from '../tools/camera/vendor-litert.mjs';

const P = globalThis.VisionProto;
const APP = fileURLToPath(new URL('..', import.meta.url));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ---- Hình học hai lượt quét -------------------------------------------------------------------------------------

test('điểm tụ mặc định: giữa khung, 42 % chiều cao', () => {
  assert.equal(P.FOE_Y, 0.42);
  assert.deepEqual(P.defaultFoe(1920, 1080), { x: 960, y: 0.42 * 1080 });
});

test('lượt A: ô 640×352 đúng độ phân giải gốc, tâm ở điểm tụ, dịch vào trong khi chạm mép', () => {
  assert.deepEqual(P.passGeometry('A', 1920, 1080, P.defaultFoe(1920, 1080)), { src: [640, 278, 640, 352], dst: [0, 0, 640, 352], cover: true });
  assert.deepEqual(P.passGeometry('A', 1920, 1080, { x: 10, y: 10 }).src, [0, 0, 640, 352]);
  assert.deepEqual(P.passGeometry('A', 1920, 1080, { x: 1915, y: 1075 }).src, [1280, 728, 640, 352]);
  assert.deepEqual(P.passGeometry('A', 1920, 1080, { x: 1000.4, y: 500.6 }).src, [680, 325, 640, 352]);
  // Khung nhỏ hơn ô: lấy cả khung, phần còn lại để đen.
  assert.deepEqual(P.passGeometry('A', 640, 360, { x: 320, y: 151 }), { src: [0, 0, 640, 352], dst: [0, 0, 640, 352], cover: true });
  assert.deepEqual(P.passGeometry('A', 320, 240, { x: 160, y: 100 }), { src: [0, 0, 320, 240], dst: [0, 0, 320, 240], cover: false });
});

test('lượt B: cả khung thu nhỏ vừa 640×352, giữ tỉ lệ, letterbox căn giữa', () => {
  assert.deepEqual(P.passGeometry('B', 1920, 1080), { src: [0, 0, 1920, 1080], dst: [7, 0, 626, 352], cover: false });
  assert.deepEqual(P.passGeometry('B', 1920, 1056), { src: [0, 0, 1920, 1056], dst: [0, 0, 640, 352], cover: true });
  assert.deepEqual(P.passGeometry('B', 1280, 720).dst, [7, 0, 626, 352]);
  assert.deepEqual(P.passGeometry('B', 2560, 1080).dst, [0, 41, 640, 270]);
  assert.deepEqual(P.passGeometry('B', 1080, 1920).dst, [221, 0, 198, 352]); // máy dựng đứng
  assert.deepEqual(P.passGeometry('B', 320, 176).dst, [0, 0, 640, 352]); // khung nhỏ: phóng to
});

test('đổi toạ độ ô đầu vào → khung gốc cho lượt A và lượt B', () => {
  const gA = P.passGeometry('A', 1920, 1080, P.defaultFoe(1920, 1080));
  assert.deepEqual(P.toFrame({ x: 10, y: 20, w: 30, h: 40 }, gA), { x: 650, y: 298, w: 30, h: 40 });
  const gB3 = P.passGeometry('B', 1920, 1056);
  assert.deepEqual(P.toFrame({ x: 10, y: 20, w: 30, h: 40 }, gB3), { x: 30, y: 60, w: 90, h: 120 });
  const gB = P.passGeometry('B', 1920, 1080);
  const b = P.toFrame({ x: 7, y: 0, w: 626, h: 352 }, gB); // phần ảnh thật của ô = cả khung gốc
  near(b.x, 0);
  near(b.y, 0);
  near(b.w, 1920);
  near(b.h, 1080);
  const k = P.toFrame({ x: 107, y: 100, w: 10, h: 10 }, gB);
  near(k.x, (100 * 1920) / 626);
  near(k.y, (100 * 1080) / 352);
  near(k.w, (10 * 1920) / 626);
});

// ---- Giải mã heatmap ---------------------------------------------------------------------------------------------

function maps() {
  return { heat: new Float32Array(P.GRID_W * P.GRID_H * P.FAMILIES), reg: new Float32Array(P.GRID_W * P.GRID_H * 4) };
}
function setPeak(m, x, y, c, s, { w = 24, h = 24, ox = 0.5, oy = 0.5 } = {}) {
  m.heat[(y * P.GRID_W + x) * P.FAMILIES + c] = s;
  const r = (y * P.GRID_W + x) * 4;
  m.reg.set([Math.log(w), Math.log(h), ox, oy], r);
}

test('đỉnh heatmap: ngưỡng 0,30, tâm = (ô + lệch) × 8, cỡ = exp(log)', () => {
  assert.equal(P.SCORE_MIN, 0.3);
  assert.equal(P.STRIDE, 8);
  const m = maps();
  setPeak(m, 10, 5, 2, 0.3, { w: 40, h: 20, ox: 0.25, oy: 0.75 });
  setPeak(m, 30, 20, 0, 0.2999);
  const out = P.decodePeaks(m.heat, m.reg);
  assert.equal(out.length, 1);
  const b = out[0];
  near(b.x + b.w / 2, (10 + 0.25) * 8, 1e-4);
  near(b.y + b.h / 2, (5 + 0.75) * 8, 1e-4);
  near(b.w, 40, 1e-4);
  near(b.h, 20, 1e-4);
  assert.equal(b.family, 2);
  near(b.s, 0.3, 1e-6);
});

test('đỉnh heatmap: max-pool 3×3 theo từng kênh, bằng nhau thì giữ cả hai, mép lưới không lỗi', () => {
  const m = maps();
  setPeak(m, 10, 10, 0, 0.9);
  setPeak(m, 11, 11, 0, 0.8); // kề và thấp hơn: bị nén
  setPeak(m, 11, 10, 1, 0.8); // kênh khác: giữ
  setPeak(m, 20, 20, 0, 0.7);
  setPeak(m, 21, 20, 0, 0.7); // bằng nhau: giữ cả hai (NMS lo phần trùng)
  setPeak(m, 0, 0, 3, 0.5);
  setPeak(m, P.GRID_W - 1, P.GRID_H - 1, 10, 0.6);
  const out = P.decodePeaks(m.heat, m.reg);
  const key = (b) => `${b.family}@${Math.floor((b.x + b.w / 2) / 8)},${Math.floor((b.y + b.h / 2) / 8)}`;
  assert.deepEqual(out.map(key).sort(), ['0@10,10', '0@20,20', '0@21,20', '10@79,43', '1@11,10', '3@0,0'].sort());
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].s >= out[i].s, 'giảm dần theo điểm');
});

test('đỉnh heatmap: chỉ giữ 64 đỉnh cao nhất mỗi lượt; đầu ra hỏng bị bỏ', () => {
  assert.equal(P.MAX_CANDIDATES, 64);
  const m = maps();
  let n = 0;
  for (let y = 0; y < P.GRID_H; y += 2) for (let x = 0; x < P.GRID_W; x += 2) setPeak(m, x, y, 0, 0.31 + (n++ % 50) / 100);
  const out = P.decodePeaks(m.heat, m.reg);
  assert.equal(out.length, 64);
  near(out[0].s, 0.8, 1e-6);
  const bad = maps();
  setPeak(bad, 5, 5, 0, 0.9, { w: Infinity });
  setPeak(bad, 15, 5, 0, 0.9, { w: 0.5 }); // dưới 1 px
  setPeak(bad, 25, 5, 0, 0.9, { w: P.MAX_BOX_SIDE * 1.01 });
  setPeak(bad, 35, 5, 0, 0.9, { ox: NaN });
  setPeak(bad, 45, 5, 0, 0.9, { ox: 1.7, oy: -0.2 }); // lệch ngoài [0,1] bị kẹp
  const ok = P.decodePeaks(bad.heat, bad.reg);
  assert.equal(ok.length, 1);
  near(ok[0].x + ok[0].w / 2, 46 * 8, 1e-4);
  near(ok[0].y + ok[0].h / 2, 5 * 8, 1e-4);
  assert.equal(P.MAX_BOX_SIDE, 1280);
});

// ---- IoU và NMS ------------------------------------------------------------------------------------------------

test('IoU', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(P.iou(a, a), 1);
  assert.equal(P.iou(a, { x: 10, y: 0, w: 10, h: 10 }), 0);
  near(P.iou(a, { x: 5, y: 0, w: 10, h: 10 }), 50 / 150);
  near(P.iou(a, { x: 0, y: 0, w: 5, h: 10 }), 0.5);
});

test('NMS: bỏ khung chồng IoU > 0,5 lên khung điểm cao hơn (kể cả khác lượt), tối đa 12 khung', () => {
  assert.equal(P.NMS_IOU, 0.5);
  assert.equal(P.MAX_BOXES, 12);
  const A = { x: 0, y: 0, w: 10, h: 10, s: 0.9, pass: 'A' };
  const dupB = { x: 1, y: 0, w: 10, h: 10, s: 0.6, pass: 'B' }; // IoU 0,82
  const half = { x: 0, y: 0, w: 5, h: 10, s: 0.5, pass: 'A' }; // IoU đúng 0,5: giữ
  const far = { x: 100, y: 0, w: 10, h: 10, s: 0.95, pass: 'B' };
  assert.deepEqual(P.nms([A, dupB, half, far]), [far, A, half]);
  const many = Array.from({ length: 20 }, (_, i) => ({ x: i * 20, y: 0, w: 10, h: 10, s: i / 20 }));
  const kept = P.nms(many);
  assert.equal(kept.length, 12);
  assert.equal(kept[0].s, 19 / 20);
});

test('khung lượt A chạm mép trong của ô cắt bị bỏ; mép trùng mép khung hình và lượt B không tính', () => {
  assert.equal(P.CUT_MARGIN, 8);
  assert.equal(P.CUT_MARGIN, P.STRIDE);
  const W = 1920;
  const H = 1080;
  const gA = P.passGeometry('A', W, H, P.defaultFoe(W, H)); // ô cắt x 640–1280, y 278–630
  const box = (x, y, w, h = w) => ({ x, y, w, h });
  assert.equal(P.cutByCrop(box(1000, 400, 30), gA, W, H), false);
  assert.equal(P.cutByCrop(box(1250, 400, 30), gA, W, H), true, 'chạm mép phải (1280)');
  assert.equal(P.cutByCrop(box(1241, 400, 30), gA, W, H), false, 'cách mép phải 9 px');
  assert.equal(P.cutByCrop(box(1242, 400, 30), gA, W, H), true, 'cách mép phải 8 px');
  assert.equal(P.cutByCrop(box(648, 400, 30), gA, W, H), true, 'mép trái');
  assert.equal(P.cutByCrop(box(649, 400, 30), gA, W, H), false);
  assert.equal(P.cutByCrop(box(900, 280, 30), gA, W, H), true, 'mép trên');
  assert.equal(P.cutByCrop(box(900, 600, 30), gA, W, H), true, 'mép dưới (630)');
  // Ô cắt dồn vào góc trên trái: mép trái và trên là mép khung hình, không tính.
  const gTL = P.passGeometry('A', W, H, { x: 10, y: 10 });
  assert.equal(P.cutByCrop(box(0, 0, 40), gTL, W, H), false);
  assert.equal(P.cutByCrop(box(610, 100, 30), gTL, W, H), true, 'mép phải 640 vẫn là mép trong');
  // Khung hình nhỏ hơn ô theo chiều ngang: hai mép ngang đều là mép khung hình.
  const gS = P.passGeometry('A', 640, 400, { x: 320, y: 168 });
  assert.equal(P.cutByCrop(box(0, 100, 40), gS, 640, 400), false);
  assert.equal(P.cutByCrop(box(600, 100, 40), gS, 640, 400), false);
  assert.equal(P.cutByCrop(box(300, 320, 40), gS, 640, 400), true, 'mép dưới 352 < 400');
  const gB = P.passGeometry('B', W, H);
  assert.equal(P.cutByCrop(box(0, 0, 40), gB, W, H), false);
  assert.equal(P.cutByCrop(box(1880, 1040, 40), gB, W, H), false);
  // Tình huống của người rà soát: khung A bị xén (30 px) và khung B đầy đủ (60 px) của cùng một biển. Trước đây NMS
  // giữ cả hai (IoU đúng 0,5) hoặc để khung xén điểm cao hơn thay khung đầy đủ; nay chỉ còn khung B.
  for (const wA of [30, 40]) {
    const truncA = { x: 1250, y: 400, w: wA, h: 60, s: 0.62, pass: 'A' };
    const fullB = { x: 1250, y: 400, w: 60, h: 60, s: 0.55, pass: 'B' };
    const kept = P.nms([truncA, fullB].filter((b) => !(b.pass === 'A' && P.cutByCrop(b, gA, W, H))));
    assert.deepEqual(kept, [fullB]);
  }
});

// ---- Bộ phân loại -----------------------------------------------------------------------------------------------

test('chọn khung để phân loại: rộng 20–400 px, tối đa 8, khung trùng gợi ý được ưu tiên', () => {
  assert.equal(P.CLS_MIN_W, 20);
  assert.equal(P.CLS_MAX_W, 400);
  assert.equal(P.CLS_MAX, 8);
  assert.equal(P.HINT_IOU, 0.05);
  const b = (x, w, s) => ({ x, y: 0, w, h: w, s });
  const boxes = [b(0, 19.99, 0.9), b(500, 20, 0.5), b(1000, 400, 0.4), b(2000, 400.01, 0.95)];
  assert.deepEqual(P.pickForClassifier(boxes), [1, 2]);
  const ten = Array.from({ length: 10 }, (_, i) => b(i * 100, 30, 0.3 + i / 100));
  assert.deepEqual(P.pickForClassifier(ten), [9, 8, 7, 6, 5, 4, 3, 2]);
  // Hai khung điểm thấp nhất trùng gợi ý: được xếp lên đầu, đẩy khung điểm cao ra ngoài.
  const hints = [{ x: 0, y: 0, w: 30, h: 30 }, { x: 105, y: 5, w: 30, h: 30 }];
  assert.deepEqual(P.pickForClassifier(ten, hints), [1, 0, 9, 8, 7, 6, 5, 4]);
  // Chồng quá ít (IoU < 0,05) thì không tính là gợi ý.
  assert.deepEqual(P.pickForClassifier(ten, [{ x: 29, y: 29, w: 30, h: 30 }]).slice(0, 1), [9]);
  assert.deepEqual(P.pickForClassifier(ten, [{ x: 25, y: 0, w: 30, h: 30 }]).slice(0, 1), [0]); // IoU ≈ 0,09
});

test('ô cắt cho bộ phân loại: khung + 15 % mỗi bên, kéo thành 48×48, phần ngoài khung hình để đen', () => {
  assert.equal(P.CROP_MARGIN, 0.15);
  assert.equal(P.CLS_SIZE, 48);
  const r = P.cropRect({ x: 100, y: 100, w: 40, h: 20 }, 1920, 1080);
  r.src.forEach((v, i) => near(v, [94, 97, 52, 26][i]));
  r.dst.forEach((v, i) => near(v, [0, 0, 48, 48][i]));
  const e = P.cropRect({ x: 0, y: 0, w: 40, h: 40 }, 1920, 1080); // chạm góc trên trái: 6 px lề nằm ngoài
  e.src.forEach((v, i) => near(v, [0, 0, 46, 46][i]));
  e.dst.forEach((v, i) => near(v, [(6 / 52) * 48, (6 / 52) * 48, (46 / 52) * 48, (46 / 52) * 48][i]));
  const br = P.cropRect({ x: 1900, y: 1060, w: 40, h: 40 }, 1920, 1080);
  br.src.forEach((v, i) => near(v, [1894, 1054, 26, 26][i]));
  near(br.dst[2], (26 / 52) * 48);
  assert.equal(P.cropRect({ x: 3000, y: 0, w: 40, h: 40 }, 1920, 1080), null);
});

test('softmax có nhiệt độ T: tổng 1, T lớn thì phẳng hơn, ổn định với logit lớn', () => {
  const p1 = P.softmaxT([1, 2, 3], 1);
  near(p1.reduce((a, b) => a + b, 0), 1, 1e-12);
  const e = [Math.exp(1), Math.exp(2), Math.exp(3)];
  const z = e[0] + e[1] + e[2];
  p1.forEach((v, i) => near(v, e[i] / z, 1e-12));
  const p2 = P.softmaxT([1, 2, 3], 2);
  const e2 = [Math.exp(0.5), Math.exp(1), Math.exp(1.5)];
  p2.forEach((v, i) => near(v, e2[i] / (e2[0] + e2[1] + e2[2]), 1e-12));
  assert.ok(p2[2] < p1[2]);
  const big = P.softmaxT(Float32Array.from([1000, 1001]), 1);
  near(big[1], 1 / (1 + Math.exp(-1)), 1e-12);
  assert.deepEqual(Array.from(P.softmaxT([NaN, NaN], 1)), [0.5, 0.5]);
  near(P.softmaxT([0, Math.log(3)], 0)[1], 0.75, 1e-12); // T không hợp lệ: dùng 1
});

test('top-3: xác suất giảm dần, bằng nhau thì nhãn đứng trước trước', () => {
  assert.equal(P.TOP_K, 3);
  const names = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(P.topK([0.1, 0.4, 0.05, 0.3, 0.15], names), [['b', 0.4], ['d', 0.3], ['e', 0.15]]);
  assert.deepEqual(P.topK([0.2, 0.2, 0.2, 0.2, 0.2], names), [['a', 0.2], ['b', 0.2], ['c', 0.2]]);
  assert.deepEqual(P.topK([0.6, 0.4], ['x', 'y']), [['x', 0.6], ['y', 0.4]]);
  assert.deepEqual(P.topK([0.1, 0.2, 0.7], ['x', 'y', 'z'], 1), [['z', 0.7]]);
});

// ---- Điểm ảnh ------------------------------------------------------------------------------------------------------

test('RGBA → RGB float [0,1], bỏ kênh alpha, ghi vào mảng có sẵn', () => {
  const out = new Float32Array(6);
  const r = P.rgbaToRgb(Uint8ClampedArray.from([255, 0, 51, 7, 0, 255, 102, 9]), out);
  assert.equal(r, out);
  [1, 0, 0.2, 0, 1, 0.4].forEach((v, i) => near(out[i], v, 1e-6));
});

test('độ sáng: trung bình và độ lệch chuẩn theo luma BT.601 trên thang 0–255', () => {
  assert.equal(P.LUM_W, 64);
  assert.equal(P.LUM_H, 36);
  const px = (rgb, n) => Uint8ClampedArray.from(Array.from({ length: n }, () => [...rgb, 255]).flat());
  const g = P.lumStats(px([128, 128, 128], 10));
  near(g.mean, 128, 1e-9);
  near(g.std, 0, 1e-4);
  const bw = new Uint8ClampedArray([...px([0, 0, 0], 2), ...px([255, 255, 255], 2)]);
  const s = P.lumStats(bw);
  near(s.mean, 127.5, 1e-9);
  near(s.std, 127.5, 1e-9);
  near(P.lumStats(px([255, 0, 0], 1)).mean, 0.299 * 255, 1e-9);
  assert.deepEqual(P.lumStats(new Uint8ClampedArray(0)), { mean: 0, std: 0 });
});

// ---- Tính năng WebAssembly và lựa chọn bản dựng ---------------------------------------------------------------------

test('mô-đun dò SIMD128 và relaxed SIMD là wasm hợp lệ; tính năng đọc từ WebAssembly.validate', () => {
  assert.equal(WebAssembly.validate(WASM_PROBES.simd), true);
  assert.equal(WebAssembly.validate(WASM_PROBES.relaxed), true);
  // Lệnh cuối của mô-đun relaxed là 0xfd 0x100 (i8x16.relaxed_swizzle, LEB128 0x80 0x02).
  assert.deepEqual(Array.from(WASM_PROBES.relaxed.slice(-4)), [253, 128, 2, 11]);
  assert.deepEqual(wasmFeatures(WebAssembly), { wasm: true, simd: true, relaxed: true });
  const only = (ok) => ({ validate: (b) => ok.includes(b) });
  assert.deepEqual(wasmFeatures(only([WASM_PROBES.simd])), { wasm: true, simd: true, relaxed: false });
  assert.deepEqual(wasmFeatures(only([])), { wasm: true, simd: false, relaxed: false });
  assert.deepEqual(wasmFeatures(null), { wasm: false, simd: false, relaxed: false });
  assert.deepEqual(wasmFeatures({ validate: () => { throw new Error('x'); } }), { wasm: true, simd: false, relaxed: false });
});

test('visionSupport báo lý do đầu tiên còn thiếu', () => {
  const env = {
    Worker: function Worker() {},
    OffscreenCanvas: function OffscreenCanvas() {},
    createImageBitmap: () => {},
    crypto: { subtle: {} },
    WebAssembly,
  };
  assert.deepEqual(visionSupport(env), { ok: true, reason: null, simd: true, relaxed: true });
  assert.equal(visionSupport({ ...env, Worker: undefined }).reason, 'no-worker');
  assert.equal(visionSupport({ ...env, OffscreenCanvas: undefined }).reason, 'no-offscreen');
  assert.equal(visionSupport({ ...env, createImageBitmap: undefined }).reason, 'no-bitmap');
  assert.equal(visionSupport({ ...env, crypto: {} }).reason, 'insecure');
  assert.equal(visionSupport({ ...env, WebAssembly: undefined }).reason, 'no-wasm');
  assert.equal(visionSupport({ ...env, WebAssembly: { validate: () => false } }).reason, 'no-simd');
});

test('chọn bản dựng: auto → relaxed nếu có, không thì compat; thiếu SIMD128 thì không chạy', () => {
  assert.equal(chooseBuild('auto', { simd: true, relaxed: true }), 'relaxed');
  assert.equal(chooseBuild(undefined, { simd: true, relaxed: false }), 'compat');
  assert.equal(chooseBuild('compat', { simd: true, relaxed: true }), 'compat');
  assert.equal(chooseBuild('relaxed', { simd: true, relaxed: true }), 'relaxed');
  assert.throws(() => chooseBuild('relaxed', { simd: true, relaxed: false }), { code: 'unsupported' });
  assert.throws(() => chooseBuild('auto', { simd: false, relaxed: false }), { code: 'unsupported' });
  assert.throws(() => chooseBuild('threaded', { simd: true, relaxed: true }), { code: 'load' });
});

// ---- Manifest và kiểm toàn vẹn ---------------------------------------------------------------------------------

const ent = (bytes) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

function fixture(build = 'compat', over = {}) {
  const enc = new TextEncoder();
  const labelsObj = {
    version: 1,
    families: ['ring', 'noentry', 'bluering', 'end', 'triangle', 'invtriangle', 'octagon', 'bluedisc', 'bluerect', 'diamond', 'plate'],
    det: { input: [352, 640, 3], stride: 8, out: [44, 80] },
    cls: { input: [48, 48, 3] },
    T: 1.5,
    labels: [{ i: 0, label: 'P.101', family: 'ring' }, { i: 1, label: 'other-sign', family: null }, { i: 2, label: 'background', family: null }],
  };
  const loader = build === 'relaxed' ? 'litert_wasm_internal' : 'litert_wasm_compat_internal';
  const bytes = {
    'vendor/litert/litert.iife.min.js': enc.encode('var LiteRT={};'),
    [`vendor/litert/${loader}.js`]: enc.encode('var ModuleFactory;'),
    [`vendor/litert/${loader}.wasm`]: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    'models/labels.json': enc.encode(JSON.stringify(labelsObj)),
    'models/sign-det.int8.tflite': new Uint8Array(300).fill(7),
    'models/sign-cls.int8.tflite': new Uint8Array(200).fill(9),
    ...over,
  };
  const files = {};
  for (const [p, b] of Object.entries(bytes)) files[p] = ent(b);
  return { bytes, manifest: { version: 3, files } };
}

test('planFiles: đủ sáu tệp của bản dựng; thiếu hay mục hỏng → danh sách tệp thiếu', () => {
  const { manifest } = fixture('compat');
  const p = planFiles(manifest, 'compat');
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.files).sort(), ['cls', 'det', 'iife', 'labels', 'loader', 'wasm']);
  assert.equal(p.files.wasm.path, 'vendor/litert/litert_wasm_compat_internal.wasm');
  assert.deepEqual(planFiles(manifest, 'relaxed').missing, ['vendor/litert/litert_wasm_internal.js', 'vendor/litert/litert_wasm_internal.wasm']);
  const noDet = { version: 1, files: { ...manifest.files } };
  delete noDet.files['models/sign-det.int8.tflite'];
  assert.deepEqual(planFiles(noDet, 'compat').missing, ['models/sign-det.int8.tflite']);
  const badSha = { files: { ...manifest.files, 'models/labels.json': { sha256: 'XYZ', size: 5 } } };
  assert.deepEqual(planFiles(badSha, 'compat').missing, ['models/labels.json']);
  const huge = { files: { ...manifest.files, 'models/sign-cls.int8.tflite': { sha256: 'a'.repeat(64), size: P.MAX_FILE_BYTES + 1 } } };
  assert.deepEqual(planFiles(huge, 'compat').missing, ['models/sign-cls.int8.tflite']);
  assert.equal(planFiles(null, 'compat').missing.length, 6);
  // Khoá thừa kế từ prototype không được tính là có tệp.
  assert.equal(planFiles({ files: Object.create({ 'models/labels.json': { sha256: 'a'.repeat(64), size: 1 } }) }, 'compat').files.labels, undefined);
});

test('verifyBytes: kiểm kích thước rồi SHA-256 qua hàm băm được truyền vào', async () => {
  const bytes = new TextEncoder().encode('abc').buffer;
  const entry = { path: 'x', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', size: 3 };
  assert.equal(await verifyBytes(bytes, entry), true); // crypto.subtle thật
  const calls = [];
  const fake = async (b) => {
    calls.push(b.byteLength);
    return Uint8Array.from(Buffer.from(entry.sha256, 'hex')).buffer;
  };
  assert.equal(await verifyBytes(bytes, entry, fake), true);
  assert.deepEqual(calls, [3]);
  await assert.rejects(verifyBytes(bytes, { ...entry, size: 4 }, fake), { code: 'integrity' });
  assert.deepEqual(calls, [3], 'sai kích thước thì không cần băm');
  await assert.rejects(verifyBytes(bytes, entry, async () => new ArrayBuffer(32)), { code: 'integrity' });
  assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), '000fff');
});

test('js/mlmanifest.js khớp từng byte với các tệp đang có trên đĩa (chạy lại write-manifest khi đổi mô hình)', () => {
  assert.ok(Number.isInteger(ML_MANIFEST.version) && ML_MANIFEST.version >= 1);
  assert.deepEqual(ML_MANIFEST.files, scan(APP));
  assert.deepEqual(Object.keys(ML_MANIFEST.files), Object.keys(ML_MANIFEST.files).slice().sort());
  for (const f of ['vendor/litert/litert.iife.min.js', 'vendor/litert/litert_wasm_compat_internal.wasm', 'vendor/litert/litert_wasm_internal.wasm']) {
    assert.ok(Object.hasOwn(ML_MANIFEST.files, f), f);
  }
});

test('vendor/litert/SHA256SUMS khớp các tệp đã đưa vào; có giấy phép Apache-2.0 và XNNPACK', () => {
  const dir = new URL('../vendor/litert/', import.meta.url);
  const lines = readFileSync(new URL('SHA256SUMS', dir), 'utf8').trim().split('\n');
  const names = [];
  for (const line of lines) {
    const [hash, name] = line.split(/\s+/);
    names.push(name);
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, dir))).digest('hex'), hash, name);
  }
  assert.deepEqual(names, names.slice().sort());
  assert.ok(names.includes('LICENSE') && names.includes('NOTICE-XNNPACK') && names.includes('VERSIONS.json'));
  assert.match(readFileSync(new URL('LICENSE', dir), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.match(readFileSync(new URL('NOTICE-XNNPACK', dir), 'utf8'), /Redistribution and use in source and binary forms/);
  const v = JSON.parse(readFileSync(new URL('VERSIONS.json', dir), 'utf8'));
  assert.equal(v.packages['@litertjs/core'].version, '2.6.0');
  assert.equal(v.packages['@litertjs/wasm-utils'].version, '2.6.0');
  assert.match(v.packages['@litertjs/core'].integrity, /^sha512-/);
});

test('write-manifest: xác định, đọc lại được, phiên bản chỉ tăng khi nội dung đổi', () => {
  const files = { 'models/labels.json': { sha256: 'a'.repeat(64), size: 3 } };
  const text = render({ version: 4, files });
  assert.equal(render({ version: 4, files }), text);
  assert.deepEqual(parseManifest(text), { version: 4, files });
  assert.equal(nextVersion(null, files), 1);
  assert.equal(nextVersion({ version: 4, files }, files), 4);
  assert.equal(nextVersion({ version: 4, files }, { ...files, x: { sha256: 'b'.repeat(64), size: 1 } }), 5);
  assert.equal(parseManifest('export const X = 1;'), null);
  assert.deepEqual(parseManifest(readFileSync(new URL('../js/mlmanifest.js', import.meta.url), 'utf8')), ML_MANIFEST);
});

test('vendor-litert: từ chối tham số lạ, thiếu giá trị, --keep lạ', () => {
  assert.deepEqual(parseArgs(['--out', 'vendor/litert', '--keep', 'yes']), { out: 'vendor/litert', keep: 'yes' });
  assert.deepEqual(parseArgs([]), {});
  assert.throws(() => parseArgs(['--from', '/tmp/litert-npm', '--out', 'vendor/litert']), /--from/);
  assert.throws(() => parseArgs(['--out']), /thiếu giá trị/);
  assert.throws(() => parseArgs(['--out', '--keep', 'yes']), /thiếu giá trị/);
  assert.throws(() => parseArgs(['--keep', 'maybe']), /--keep/);
  assert.throws(() => parseArgs(['--out', 'a', '--out', 'b']), /hai lần/);
  assert.throws(() => parseArgs(['vendor/litert']), /Tham số lạ/);
});

test('vendor-litert: chỉ ghi vào vendor/litert, thư mục mới/rỗng hay thư mục LiteRT của nó; không bao giờ vào ứng dụng', () => {
  assert.deepEqual(OUTPUTS, ['LICENSE', 'NOTICE-XNNPACK', 'SHA256SUMS', 'VERSIONS.json', 'litert.iife.min.js',
    'litert_wasm_compat_internal.js', 'litert_wasm_compat_internal.wasm', 'litert_wasm_internal.js', 'litert_wasm_internal.wasm']);
  assert.equal(inside('/a/b/c', '/a/b'), true);
  assert.equal(inside('/a/b', '/a/b'), true);
  assert.equal(inside('/a/bc', '/a/b'), false);
  assert.equal(inside('/a/b/..x', '/a/b'), true);
  assert.equal(inside('/a', '/a/b'), false);
  // Thư mục vendor/litert thật của ứng dụng: được, và chỉ chứa tệp đầu ra.
  assert.equal(checkOutDir(join(APP, 'vendor/litert'), APP), 'ours');
  for (const bad of [APP, join(APP, '..'), '/', join(APP, 'js'), join(APP, 'models')]) assert.throws(() => checkOutDir(bad, APP), Error, bad);
  const tmp = mkdtempSync(join(tmpdir(), 'bd-vendor-test-'));
  try {
    assert.equal(checkOutDir(join(tmp, 'new'), APP), 'new');
    mkdirSync(join(tmp, 'empty'));
    assert.equal(checkOutDir(join(tmp, 'empty'), APP), 'empty');
    mkdirSync(join(tmp, 'other'));
    writeFileSync(join(tmp, 'other', 'notes.txt'), 'x');
    assert.throws(() => checkOutDir(join(tmp, 'other'), APP), /không rỗng/);
    mkdirSync(join(tmp, 'prev'));
    writeFileSync(join(tmp, 'prev', 'VERSIONS.json'), JSON.stringify({ globalName: 'LiteRT' }));
    writeFileSync(join(tmp, 'prev', 'litert.iife.min.js'), 'x');
    assert.equal(checkOutDir(join(tmp, 'prev'), APP), 'ours');
    writeFileSync(join(tmp, 'prev', 'keep-me.txt'), 'x');
    assert.throws(() => checkOutDir(join(tmp, 'prev'), APP), /keep-me\.txt/);
    writeFileSync(join(tmp, 'file'), 'x');
    assert.throws(() => checkOutDir(join(tmp, 'file'), APP), /không phải thư mục/);
    // Thư mục chứa ứng dụng (vd. --out ..) bị từ chối dù có VERSIONS.json.
    const fakeApp = join(tmp, 'prev', 'app');
    assert.throws(() => checkOutDir(join(tmp, 'prev'), fakeApp), /ứng dụng/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- Thống kê trượt ---------------------------------------------------------------------------------------------

test('phân vị nội suy tuyến tính', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  near(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.5), null);
});

test('thống kê trượt: cửa sổ 60 khung, trung vị, p90, số khung mỗi giây, theo tổ hợp lượt', () => {
  assert.equal(VISION_LIMITS.STATS_WINDOW, 60);
  const s = new RollingStats();
  for (let i = 0; i < 70; i++) s.add(i < 10 ? 1000 : 10 + (i % 10), 12, i * 200, i % 2 ? 'A' : 'AB');
  const r = s.summary();
  assert.equal(r.n, 60, 'chỉ giữ 60 khung gần nhất');
  assert.equal(r.median, 14.5);
  near(r.p90, 18.1);
  assert.equal(r.rtt, 12);
  near(r.fps, 5); // 59 khoảng trong 11,8 s
  assert.deepEqual(Object.keys(r.byPasses), ['A', 'AB']);
  assert.equal(r.byPasses.A.n, 30);
  const one = new RollingStats();
  one.add(5, 6, 100, 'B');
  assert.equal(one.summary().fps, 0);
});

// ---- Vision với worker, fetch và đồng hồ giả -------------------------------------------------------------------------

class FakeWorker {
  constructor(url, script) {
    this.url = String(url);
    this.sent = [];
    this.terminated = false;
    this.script = script || {};
    FakeWorker.last = this;
  }
  postMessage(msg, transfer) {
    this.sent.push({ msg, transfer });
    const h = this.script[msg.type];
    if (h) queueMicrotask(() => h.call(this, msg));
  }
  reply(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

function fakeFetch(bytes, { tamper = null, status = 200, chunk = 7, log = [] } = {}) {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    const path = Object.keys(bytes).find((k) => u.pathname.endsWith(`/${k}`));
    if (status !== 200) return { ok: false, status };
    let b = bytes[path];
    if (!b) return { ok: false, status: 404 };
    if (tamper && tamper(path)) b = tamper(path)(b);
    const data = new Uint8Array(b);
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (i >= data.length) return { done: true };
              const v = data.slice(i, i + chunk);
              i += chunk;
              return { done: false, value: v };
            },
            async cancel() {},
          };
        },
      },
    };
  };
}

const ready = { init(m) { this.reply({ type: 'ready', build: m.build, input: [640, 352], labels: m.labels.labels.length }); } };
const supportAll = () => ({ ok: true, reason: null, simd: true, relaxed: true });
const supportCompat = () => ({ ok: true, reason: null, simd: true, relaxed: false });

function vision({ bytes, manifest, script = ready, support = supportAll, fetchOpts = {}, ...deps } = {}) {
  const fx = bytes ? { bytes, manifest } : fixture(support().relaxed ? 'relaxed' : 'compat');
  const log = [];
  const v = new Vision({
    createWorker: (url) => new FakeWorker(url, script),
    fetch: fakeFetch(fx.bytes, { ...fetchOpts, log }),
    support,
    ...deps,
  });
  return { v, fx, log };
}

test('load: tải đủ tệp, kiểm mã băm, gửi byte và mã băm sang worker (chuyển quyền), trả bản dựng và số nhãn', async () => {
  const { v, fx, log } = vision();
  const progress = [];
  const r = await v.load({ base: 'https://app.test/ban-duong/', manifest: fx.manifest, onProgress: (p) => progress.push(p) });
  assert.deepEqual(r, { build: 'relaxed', labels: 3 });
  assert.equal(v.ready, true);
  assert.equal(v.build, 'relaxed');
  assert.deepEqual(v.labels, ['P.101', 'other-sign', 'background']);
  const w = FakeWorker.last;
  assert.ok(w.url.endsWith('/js/vision-worker.js'));
  const { msg, transfer } = w.sent[0];
  assert.equal(msg.type, 'init');
  assert.equal(msg.build, 'relaxed');
  assert.equal(msg.base, 'https://app.test/ban-duong/');
  assert.equal(P.checkInit(msg).ok, true);
  assert.equal(transfer.length, 5);
  assert.ok(transfer.every((b) => b instanceof ArrayBuffer));
  assert.equal(msg.sha256.wasm, fx.manifest.files['vendor/litert/litert_wasm_internal.wasm'].sha256);
  assert.equal(new Uint8Array(msg.files.det)[0], 7);
  // Mỗi URL nằm dưới base và mang 16 ký tự đầu của SHA-256 để cache cũ không che bản mới.
  assert.equal(VISION_LIMITS.HASH_QUERY, 16);
  assert.equal(log.length, 6);
  for (const u of log) {
    const url = new URL(u);
    assert.ok(url.href.startsWith('https://app.test/ban-duong/'));
    const path = url.pathname.replace('/ban-duong/', '');
    assert.equal(url.search, `?v=${fx.manifest.files[path].sha256.slice(0, 16)}`);
  }
  const last = progress[progress.length - 1];
  assert.equal(last.loaded, last.total);
  assert.equal(last.total, Object.values(fx.manifest.files).reduce((s, e) => s + e.size, 0));
  assert.equal(progress[0].loaded, 0);
  assert.deepEqual(await v.load(), { build: 'relaxed', labels: 3 }, 'gọi lại khi đã sẵn sàng thì không tải lại');
});

test('load: máy chỉ có SIMD128 → compat; thiếu tính năng → unsupported, không tải gì', async () => {
  const a = vision({ support: supportCompat });
  assert.equal((await a.v.load({ base: 'https://app.test/', manifest: a.fx.manifest })).build, 'compat');
  const b = vision({ support: () => ({ ok: false, reason: 'no-simd', simd: false, relaxed: false }) });
  await assert.rejects(b.v.load({ base: 'https://app.test/', manifest: b.fx.manifest }), { name: 'VisionError', code: 'unsupported' });
  assert.equal(b.log.length, 0);
});

test('load: chưa cài mô hình → no-models, không tải gì', async () => {
  const { v, fx, log } = vision();
  const m = { version: 1, files: { ...fx.manifest.files } };
  delete m.files['models/sign-cls.int8.tflite'];
  await assert.rejects(v.load({ base: 'https://app.test/', manifest: m }), { code: 'no-models' });
  assert.equal(log.length, 0);
  assert.equal(v.ready, false);
});

test('load: một byte bị sửa, tệp dài hơn hay ngắn hơn → integrity, không khởi động worker', async () => {
  const flip = (b) => {
    const c = new Uint8Array(b);
    c[c.length >> 1] ^= 1;
    return c;
  };
  for (const tamper of [
    (p) => p.endsWith('.tflite') && flip,
    (p) => p.endsWith('.wasm') && ((b) => new Uint8Array([...b, 0])),
    (p) => p.endsWith('labels.json') && ((b) => b.slice(0, b.length - 1)),
  ]) {
    FakeWorker.last = null;
    const { v, fx } = vision({ fetchOpts: { tamper } });
    await assert.rejects(v.load({ base: 'https://app.test/', manifest: fx.manifest }), { code: 'integrity' });
    assert.equal(FakeWorker.last, null);
  }
});

test('load: lỗi mạng hay HTTP → load; worker báo integrity → integrity và worker bị dừng', async () => {
  const a = vision({ fetchOpts: { status: 404 } });
  await assert.rejects(a.v.load({ base: 'https://app.test/', manifest: a.fx.manifest }), { code: 'load' });
  const b = vision({ script: { init() { this.reply({ type: 'error', code: 'integrity', reason: 'wasm' }); } } });
  await assert.rejects(b.v.load({ base: 'https://app.test/', manifest: b.fx.manifest }), { code: 'integrity' });
  assert.equal(FakeWorker.last.terminated, true);
  const c = vision({ script: { init() { this.reply({ type: 'ready', build: 'compat', input: [1, 2], labels: 3 }); } } });
  await assert.rejects(c.v.load({ base: 'https://app.test/', manifest: c.fx.manifest }), { code: 'load' });
});

test('load: labels.json sai hợp đồng → load', async () => {
  const bad = new TextEncoder().encode(JSON.stringify({ version: 1, families: [] }));
  const fx = fixture('relaxed', { 'models/labels.json': bad });
  const { v } = vision({ bytes: fx.bytes, manifest: fx.manifest });
  await assert.rejects(v.load({ base: 'https://app.test/', manifest: fx.manifest }), { code: 'load' });
});

test('load: worker không trả lời trong 60 s → load', async () => {
  assert.equal(VISION_LIMITS.LOAD_TIMEOUT, 60e3);
  FakeWorker.last = null;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { v, fx } = vision({ script: {} });
    const p = v.load({ base: 'https://app.test/', manifest: fx.manifest });
    while (!FakeWorker.last || !FakeWorker.last.sent.length) await new Promise((r) => setImmediate(r));
    mock.timers.tick(VISION_LIMITS.LOAD_TIMEOUT - 1);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1);
    await assert.rejects(p, { code: 'load' });
    assert.equal(FakeWorker.last.terminated, true);
  } finally {
    mock.timers.reset();
  }
});

/**
 * fetch giả cho các tình huống tải: mode(path) → 'ok' | 'stall-body' (đọc mãi không xong) | 'stall-headers' (không bao
 * giờ trả phản hồi) | 404. Ghi lại từng lần gọi cùng signal; không tự tôn trọng signal (như một máy chủ treo hẳn).
 */
function scriptedFetch(bytes, mode) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = Object.keys(bytes).find((k) => new URL(url).pathname.endsWith(`/${k}`));
    const how = mode(path);
    calls.push({ path, signal: init && init.signal, how });
    if (how === 404) return { ok: false, status: 404 };
    if (how === 'stall-headers') return new Promise(() => {});
    const data = new Uint8Array(bytes[path]);
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (how === 'stall-body') return new Promise(() => {});
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            return Promise.resolve({ done: false, value: data });
          },
          cancel: async () => {
            calls.find((c) => c.path === path).cancelled = true;
          },
        }),
      },
    };
  };
  return { fetch, calls };
}

const until = async (cond) => {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), 'điều kiện chờ không xảy ra');
};

test('load: một tệp không nhận thêm byte nào trong 30 s → load (stalled), các tệp khác bị huỷ, tải lại được', async () => {
  assert.equal(VISION_LIMITS.LOAD_IDLE, 30e3);
  const fx = fixture('relaxed');
  let stall = true;
  const net = scriptedFetch(fx.bytes, (p) => (stall && p.endsWith('.wasm') ? 'stall-body' : 'ok'));
  const v = new Vision({ createWorker: (u) => new FakeWorker(u, ready), fetch: net.fetch, support: supportAll });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = null;
    const p = v.load({ base: 'https://app.test/', manifest: fx.manifest });
    p.then(() => (settled = 'ok'), (e) => (settled = e));
    await until(() => net.calls.length === 6);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    mock.timers.tick(VISION_LIMITS.LOAD_IDLE - 1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, null, 'chưa tới 30 s thì vẫn chờ');
    mock.timers.tick(1);
    await until(() => settled !== null);
    assert.equal(settled.code, 'load');
    assert.match(settled.message, /wasm: stalled/);
    assert.ok(net.calls.every((c) => c.signal && c.signal.aborted), 'mọi lần tải nhận signal và đều bị huỷ');
    assert.equal(net.calls.find((c) => c.how === 'stall-body').cancelled, true, 'luồng đọc treo bị huỷ');
    assert.equal(v.ready, false);
  } finally {
    mock.timers.reset();
  }
  stall = false;
  assert.deepEqual(await v.load({ base: 'https://app.test/', manifest: fx.manifest }), { build: 'relaxed', labels: 3 });
  assert.equal(net.calls.length, 12);
});

test('load: máy chủ không trả phản hồi cũng bị tính là treo', async () => {
  const fx = fixture('relaxed');
  const net = scriptedFetch(fx.bytes, (p) => (p.endsWith('.tflite') ? 'stall-headers' : 'ok'));
  const v = new Vision({ createWorker: (u) => new FakeWorker(u, ready), fetch: net.fetch, support: supportAll, idleTimeout: 20 });
  await assert.rejects(v.load({ base: 'https://app.test/', manifest: fx.manifest }), (e) => e.code === 'load' && /stalled/.test(e.message));
  assert.ok(net.calls.every((c) => c.signal.aborted));
});

test('load: một tệp hỏng ngay → các tệp đang tải bị huỷ; tải lại không chạy song song với lần cũ', async () => {
  const fx = fixture('relaxed');
  let broken = true;
  const net = scriptedFetch(fx.bytes, (p) => (broken && p.endsWith('det.int8.tflite') ? 404 : broken && p.endsWith('.wasm') ? 'stall-body' : 'ok'));
  const v = new Vision({ createWorker: (u) => new FakeWorker(u, ready), fetch: net.fetch, support: supportAll });
  await assert.rejects(v.load({ base: 'https://app.test/', manifest: fx.manifest }), (e) => e.code === 'load' && /HTTP 404/.test(e.message));
  const first = net.calls.slice();
  assert.equal(first.length, 6);
  assert.ok(first.every((c) => c.signal.aborted), 'tệp wasm đang tải dở bị huỷ ngay, không chờ 30 s');
  assert.equal(first.find((c) => c.how === 'stall-body').cancelled, true);
  broken = false;
  assert.ok(await v.load({ base: 'https://app.test/', manifest: fx.manifest }));
  assert.equal(net.calls.filter((c) => c.path.endsWith('.wasm') && !c.signal.aborted).length, 1, 'chỉ một lần tải wasm còn sống');
});

test('terminate() khi đang tải: promise đang chờ thua (worker), load() sau đó tải lại từ đầu', async () => {
  const fx = fixture('relaxed');
  let stall = true;
  const net = scriptedFetch(fx.bytes, (p) => (stall && p.endsWith('.wasm') ? 'stall-body' : 'ok'));
  const v = new Vision({ createWorker: (u) => new FakeWorker(u, ready), fetch: net.fetch, support: supportAll });
  FakeWorker.last = null;
  const p1 = v.load({ base: 'https://app.test/', manifest: fx.manifest });
  await until(() => net.calls.length === 6);
  v.terminate();
  await assert.rejects(p1, { code: 'worker' });
  assert.ok(net.calls.every((c) => c.signal.aborted));
  assert.equal(FakeWorker.last, null, 'không tạo worker cho lần tải đã huỷ');
  stall = false;
  const p2 = v.load({ base: 'https://app.test/', manifest: fx.manifest });
  assert.notEqual(p2, p1);
  assert.deepEqual(await p2, { build: 'relaxed', labels: 3 });
  assert.equal(v.ready, true);
  assert.equal(FakeWorker.last.terminated, false);
});

test('terminate() khi worker đang khởi động, rồi load() lại: lần cũ không đụng tới worker mới', async () => {
  const fx = fixture('relaxed');
  let answer = false;
  const workers = [];
  const script = { init(m) { if (answer) ready.init.call(this, m); } };
  const v = new Vision({
    createWorker: (u) => {
      const w = new FakeWorker(u, script);
      workers.push(w);
      return w;
    },
    fetch: fakeFetch(fx.bytes),
    support: supportAll,
  });
  const p1 = v.load({ base: 'https://app.test/', manifest: fx.manifest });
  await until(() => workers.length === 1 && workers[0].sent.length === 1);
  v.terminate();
  answer = true;
  const p2 = v.load({ base: 'https://app.test/', manifest: fx.manifest });
  await assert.rejects(p1, { code: 'worker' });
  assert.ok(await p2);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, false);
  assert.equal(v.ready, true);
});

test('load: base phải cùng nguồn gốc với trang và là http(s); sai thì load, không tải gì', async () => {
  const location = { href: 'https://app.test/ban-duong/index.html', origin: 'https://app.test' };
  for (const base of ['https://evil.example/', '//evil.example/', 'http://app.test/ban-duong/', 'https://app.test:8443/', 'data:text/plain,x', 'blob:https://app.test/0f0f']) {
    const { v, fx, log } = vision({ location });
    await assert.rejects(v.load({ base, manifest: fx.manifest }), { code: 'load' }, base);
    assert.equal(log.length, 0, `${base}: không có yêu cầu nào`);
  }
  const ok = vision({ location });
  await ok.v.load({ base: 'models-root/', manifest: ok.fx.manifest });
  assert.ok(ok.log.every((u) => u.startsWith('https://app.test/ban-duong/models-root/')), 'base tương đối tính từ trang');
  const same = vision({ location });
  await same.v.load({ base: 'https://app.test/ban-duong/', manifest: same.fx.manifest });
  assert.equal(same.log.length, 6);
});

function bitmap(width = 1920, height = 1080) {
  return { width, height, closed: false, close() { this.closed = true; this.width = 0; this.height = 0; } };
}

const resultFor = (m, extra = {}) => ({
  type: 'result',
  id: m.id,
  t: m.t,
  ms: { pre: 3, det: 20, cls: 2, total: 25 },
  lum: { mean: 100, std: 40 },
  boxes: [{ x: 1, y: 2, w: 30, h: 30, family: 'ring', s: 0.7, pass: 'A', cls: [['P.101', 0.8], ['other-sign', 0.1], ['background', 0.05]] }],
  ...extra,
});

async function loaded(script = {}, deps = {}) {
  let clock = 1000;
  const { v, fx } = vision({ script: { ...ready, ...script }, now: () => clock, ...deps });
  await v.load({ base: 'https://app.test/', manifest: fx.manifest });
  return { v, w: FakeWorker.last, tick: (ms) => (clock += ms) };
}

test('process: chưa tải thì từ chối và đóng bitmap', async () => {
  const { v } = vision();
  const b = bitmap();
  await assert.rejects(v.process(b), { code: 'load' });
  assert.equal(b.closed, true);
});

test('process: gửi khung (chuyển quyền bitmap), trả đúng { t, ms, lum, boxes }, cập nhật thống kê', async () => {
  const { v, w } = await loaded({ frame(m) { this.reply(resultFor(m)); } });
  const b = bitmap();
  const r = await v.process({ bitmap: b, t: 5000.5 }, { passes: ['A'], foe: { x: 2500, y: -3 } });
  assert.deepEqual(Object.keys(r).sort(), ['boxes', 'lum', 'ms', 't']);
  assert.equal(r.t, 5000.5);
  assert.equal(r.boxes[0].cls[0][0], 'P.101');
  const { msg, transfer } = w.sent[1];
  assert.equal(msg.type, 'frame');
  assert.deepEqual(transfer, [b]);
  assert.deepEqual(msg.passes, ['A']);
  assert.deepEqual(msg.foe, { x: 1920, y: 0 }, 'điểm tụ bị kẹp vào trong khung');
  assert.equal(msg.hints, undefined);
  const r2 = await v.process(bitmap(1280, 720));
  assert.ok(r2);
  assert.deepEqual(w.sent[2].msg.passes, ['A', 'B'], 'mặc định cả hai lượt');
  assert.deepEqual(w.sent[2].msg.foe, { x: 640, y: 0.42 * 720 }, 'điểm tụ mặc định');
  const s = v.stats();
  assert.equal(s.n, 2);
  assert.equal(s.median, 25);
  assert.deepEqual(Object.keys(s.byPasses), ['A', 'AB']);
  assert.equal(s.level, 2);
  assert.equal(s.build, 'relaxed');
  v.level = 1;
  assert.equal(v.stats().level, 1);
});

test('process: đang có khung chưa xong thì khung mới bị đóng và trả null', async () => {
  let pending;
  const { v } = await loaded({ frame(m) { pending = m; } });
  const b1 = bitmap();
  const b2 = bitmap();
  const p1 = v.process(b1);
  assert.equal(await v.process(b2), null);
  assert.equal(b2.closed, true);
  assert.equal(b1.closed, false, 'bitmap đã gửi đi do worker đóng');
  await new Promise((r) => setImmediate(r));
  FakeWorker.last.reply(resultFor(pending));
  assert.ok(await p1);
  // Khung trước đã xong: khung sau được gửi đi bình thường.
  const p3 = v.process(bitmap());
  await new Promise((r) => setImmediate(r));
  FakeWorker.last.reply(resultFor(pending));
  assert.notEqual(pending.id, undefined);
  assert.ok(await p3);
});

test('process: gợi ý hợp lệ được gửi kèm (tối đa 16), gợi ý hỏng bị lọc', async () => {
  const { v, w } = await loaded({ frame(m) { this.reply(resultFor(m)); } });
  const hints = [{ x: 1, y: 2, w: 3, h: 4, extra: 'x' }, { x: NaN, y: 0, w: 1, h: 1 }, null, ...Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0, w: 5, h: 5 }))];
  await v.process(bitmap(), { hints });
  const sent = w.sent[1].msg.hints;
  assert.equal(sent.length, 16);
  assert.deepEqual(sent[0], { x: 1, y: 2, w: 3, h: 4 });
});

test('process: tham số sai → args (không phải worker hỏng), bitmap bị đóng, không gửi gì, worker vẫn dùng được', async () => {
  assert.ok(VISION_ERROR_CODES.includes('args'));
  const { v, w } = await loaded({ frame(m) { this.reply(resultFor(m)); } });
  const b = bitmap();
  await assert.rejects(v.process(b, { passes: ['C'] }), { code: 'args' });
  assert.equal(b.closed, true);
  assert.equal(w.sent.length, 1);
  const closedBmp = bitmap();
  closedBmp.close();
  await assert.rejects(v.process(closedBmp), { code: 'args' });
  await assert.rejects(v.process(bitmap(5000, 1080)), { code: 'args' }, 'khung quá cỡ');
  assert.equal(v.ready, true);
  assert.equal(w.terminated, false);
  assert.ok(await v.process(bitmap()), 'khung kế tiếp chạy bình thường');
});

test('process: gợi ý nằm ngoài khung hay to quá cỡ không làm hỏng khung (bị cắt vào khung hoặc bỏ)', async () => {
  const { v, w } = await loaded({ frame(m) { this.reply(resultFor(m)); } });
  const b = bitmap();
  // Như dự đoán của js/signtrack.js: rộng tới 4 lần khung, cao = rộng × tỉ lệ, tâm trượt ra ngoài.
  const hints = [{ x: 100, y: 100, w: 600, h: 8500 }, { x: -5000, y: 100, w: 60, h: 60 }, { x: 1900, y: -40, w: 7680, h: 7680 }, { x: 10, y: 10, w: 50, h: 50 }];
  const r = await v.process(b, { hints });
  assert.ok(r, 'khung vẫn được xử lý');
  const sent = w.sent[1].msg;
  assert.equal(P.checkFrame(sent).ok, true);
  assert.deepEqual(sent.hints, [{ x: 100, y: 100, w: 600, h: 980 }, { x: 1900, y: 0, w: 20, h: 1080 }, { x: 10, y: 10, w: 50, h: 50 }]);
  // Gợi ý nào cũng nằm ngoài khung: không gửi trường hints.
  await v.process(bitmap(), { hints: [{ x: -5000, y: 0, w: 10, h: 10 }, { x: 0, y: 99999, w: 1e6, h: 1 }] });
  assert.equal(w.sent[2].msg.hints, undefined);
});

test('clipHints: bỏ gợi ý hỏng, cắt phần ngoài khung W×H, tối đa 16', () => {
  assert.deepEqual(clipHints(null, 100, 100), []);
  assert.deepEqual(clipHints([{ x: -10, y: -10, w: 30, h: 20 }], 100, 100), [{ x: 0, y: 0, w: 20, h: 10 }]);
  assert.deepEqual(clipHints([{ x: 90, y: 95, w: 30, h: 30 }], 100, 100), [{ x: 90, y: 95, w: 10, h: 5 }]);
  assert.deepEqual(clipHints([{ x: 100, y: 0, w: 5, h: 5 }, { x: 0, y: 0, w: 0, h: 5 }, { x: 0, y: 0, w: Infinity, h: 5 }, { x: 1, y: 1, w: 1, h: 1, extra: 1 }], 100, 100), [{ x: 1, y: 1, w: 1, h: 1 }]);
  assert.deepEqual(clipHints([{ x: 0, y: 0, w: 5, h: 5 }], 0, 0), [], 'bitmap đã đóng (0×0)');
  const many = clipHints(Array.from({ length: 40 }, (_, i) => ({ x: i, y: 0, w: 5, h: 5 })), 100, 100);
  assert.equal(many.length, P.MAX_HINTS);
  assert.equal(P.MAX_HINTS, 16);
  for (const h of clipHints([{ x: -9000, y: -9000, w: 30000, h: 30000 }], 4096, 4096)) assert.ok(P.checkFrame({ type: 'frame', id: 1, t: 0, bitmap: bitmap(4096, 4096), passes: ['A'], foe: { x: 1, y: 1 }, hints: [h] }).ok);
});

test('process: worker báo lỗi cho khung đang chạy → lỗi có mã đó; phản hồi hỏng → worker, ngừng dùng', async () => {
  const a = await loaded({ frame(m) { this.reply({ type: 'error', code: 'worker', id: m.id, reason: 'x' }); } });
  await assert.rejects(a.v.process(bitmap()), { code: 'worker' });
  assert.equal(a.v.ready, true, 'lỗi một khung không làm hỏng worker');
  const b = await loaded({ frame(m) { this.reply(resultFor(m, { boxes: 'nope' })); } });
  await assert.rejects(b.v.process(bitmap()), { code: 'worker' });
  assert.equal(b.v.ready, false);
  assert.equal(b.w.terminated, true);
  await assert.rejects(b.v.process(bitmap()), { code: 'worker' });
});

test('process: phản hồi của khung khác (id khác) và thông điệp lạ bị bỏ qua', async () => {
  let pending;
  const { v, w } = await loaded({ frame(m) { pending = m; } });
  const p = v.process(bitmap());
  await new Promise((r) => setImmediate(r));
  w.reply(resultFor({ ...pending, id: pending.id + 1 }));
  w.reply({ type: 'hello' });
  w.reply('noise');
  w.reply(resultFor(pending));
  assert.ok(await p);
});

test('process: worker treo quá 10 s → worker, worker bị dừng', async () => {
  assert.equal(VISION_LIMITS.FRAME_TIMEOUT, 10e3);
  const { v, w } = await loaded({ frame() {} });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = v.process(bitmap());
    mock.timers.tick(VISION_LIMITS.FRAME_TIMEOUT);
    await assert.rejects(p, { code: 'worker' });
    assert.equal(w.terminated, true);
    assert.equal(v.ready, false);
  } finally {
    mock.timers.reset();
  }
});

test('terminate: khung đang chạy trả null, worker dừng, sau đó không nhận khung', async () => {
  const { v, w } = await loaded({ frame() {} });
  const p = v.process(bitmap());
  v.terminate();
  assert.equal(await p, null);
  assert.equal(w.terminated, true);
  const b = bitmap();
  await assert.rejects(v.process(b), { code: 'worker' });
  assert.equal(b.closed, true);
});

test('runTensor: kiểm kích thước, chuyển quyền bộ đệm, trả đầu ra', async () => {
  const { v, w } = await loaded({
    run(m) {
      this.reply({ type: 'outputs', id: m.id, outputs: [{ shape: [1, 3], data: Float32Array.from([1, 2, 3]) }] });
    },
  });
  const out = await v.runTensor('cls', new Float32Array(48 * 48 * 3));
  assert.deepEqual(out[0].shape, [1, 3]);
  assert.equal(w.sent[1].transfer[0], w.sent[1].msg.input.buffer);
  await assert.rejects(v.runTensor('det', new Float32Array(5)), { code: 'args' });
  assert.equal(v.ready, true);
});

test('bitmapCounts: hỏi worker số khung đã nhận và đã đóng', async () => {
  const { v } = await loaded({ stats() { this.reply({ type: 'stats', frames: 4, closed: 4 }); } });
  assert.deepEqual(await v.bitmapCounts(), { frames: 4, closed: 4 });
  v.terminate();
  assert.equal(await v.bitmapCounts(), null);
});

test('VisionError mang mã lỗi', () => {
  const e = new VisionError('integrity', 'models/x');
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'integrity');
  assert.equal(e.name, 'VisionError');
  assert.match(e.message, /integrity: models\/x/);
});
