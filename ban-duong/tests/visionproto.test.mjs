import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import '../js/visionproto.js';

const P = globalThis.VisionProto;
const read = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');

function bitmap(width = 1920, height = 1080) {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
      this.width = 0;
      this.height = 0;
    },
  };
}

const frame = (over = {}) => ({ type: 'frame', id: 1, t: 1234.5, bitmap: bitmap(), passes: ['A', 'B'], foe: { x: 960, y: 453.6 }, ...over });

function labels(over = {}) {
  const families = ['ring', 'noentry', 'bluering', 'end', 'triangle', 'invtriangle', 'octagon', 'bluedisc', 'bluerect', 'diamond', 'plate'];
  const list = [
    { i: 0, label: 'P.127[50]', family: 'ring' },
    { i: 1, label: 'other-sign', family: null },
    { i: 2, label: 'background', family: null },
  ];
  return { version: 1, families, det: { input: [352, 640, 3], stride: 8, out: [44, 80] }, cls: { input: [48, 48, 3] }, T: 1, labels: list, ...over };
}

const buf = (n = 8) => new ArrayBuffer(n);
const HEX = 'a'.repeat(64);
function init(over = {}) {
  return {
    type: 'init',
    base: 'https://app.test/',
    build: 'compat',
    files: { iife: buf(), loader: buf(), wasm: buf(), det: buf(), cls: buf() },
    sha256: { iife: HEX, loader: HEX, wasm: HEX, det: HEX, cls: HEX },
    labels: labels(),
    ...over,
  };
}

test('visionproto.js và vision-worker.js là script cổ điển hợp lệ (importScripts nạp được)', () => {
  for (const f of ['visionproto.js', 'vision-worker.js']) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
  // Chạy lại tệp như một script cổ điển trong ngữ cảnh mới: gắn đúng biến toàn cục VisionProto, đã đóng băng.
  const ctx = vm.createContext({});
  vm.runInContext(read('visionproto.js'), ctx);
  assert.equal(typeof ctx.VisionProto.checkFrame, 'function');
  assert.ok(Object.isFrozen(ctx.VisionProto));
  assert.ok(Object.isFrozen(P));
});

test('thông điệp lạ bị bỏ qua, không báo lỗi', () => {
  for (const m of [null, undefined, 1, 'frame', [], [{ type: 'frame' }], {}, { type: 'zzz' }, { type: 'FRAME' }, { type: 'ready' }]) {
    const v = P.checkWorkerMessage(m);
    assert.equal(v.ok, false);
    assert.equal(v.ignore, true, JSON.stringify(m));
  }
  assert.equal(P.checkWorkerMessage({ type: 'stats' }).ok, true);
  // Kiểu quen nhưng sai trường: báo lỗi (không ignore).
  const bad = P.checkWorkerMessage({ type: 'frame' });
  assert.equal(bad.ok, false);
  assert.notEqual(bad.ignore, true);
});

test('khung hình hợp lệ được nhận', () => {
  assert.deepEqual(P.checkFrame(frame()), { ok: true });
  assert.equal(P.checkFrame(frame({ passes: ['B'] })).ok, true);
  assert.equal(P.checkFrame(frame({ passes: ['B', 'A'] })).ok, true);
  assert.equal(P.checkFrame(frame({ hints: [] })).ok, true);
  assert.equal(P.checkFrame(frame({ hints: null })).ok, true);
  assert.equal(P.checkFrame(frame({ hints: [{ x: -10, y: 5, w: 30, h: 30 }] })).ok, true);
  assert.equal(P.checkFrame(frame({ foe: { x: 0, y: 0 } })).ok, true);
  assert.equal(P.checkFrame(frame({ foe: { x: 1920, y: 1080 } })).ok, true);
  assert.equal(P.checkFrame(frame({ id: 0 })).ok, true);
  assert.equal(P.checkFrame(frame({ id: P.MAX_ID })).ok, true);
});

test('khung hình sai kiểu hay ngoài khoảng bị từ chối, kèm tên trường', () => {
  const cases = [
    [{ id: -1 }, 'id'],
    [{ id: 1.5 }, 'id'],
    [{ id: '1' }, 'id'],
    [{ id: P.MAX_ID + 1 }, 'id'],
    [{ t: NaN }, 't'],
    [{ t: Infinity }, 't'],
    [{ t: '5' }, 't'],
    [{ bitmap: null }, 'bitmap'],
    [{ bitmap: { width: 10, height: 10 } }, 'bitmap'],
    [{ bitmap: bitmap(0, 1080) }, 'bitmap.size'],
    [{ bitmap: bitmap(P.MAX_FRAME_SIDE + 1, 1080) }, 'bitmap.size'],
    [{ bitmap: bitmap(19.5, 1080) }, 'bitmap.size'],
    [{ passes: [] }, 'passes'],
    [{ passes: ['C'] }, 'passes'],
    [{ passes: ['A', 'A'] }, 'passes'],
    [{ passes: ['A', 'B', 'A'] }, 'passes'],
    [{ passes: 'AB' }, 'passes'],
    [{ passes: ['a'] }, 'passes'],
    [{ foe: null }, 'foe'],
    [{ foe: { x: -1, y: 10 } }, 'foe'],
    [{ foe: { x: 1921, y: 10 } }, 'foe'],
    [{ foe: { x: 10, y: 1081 } }, 'foe'],
    [{ foe: { x: NaN, y: 10 } }, 'foe'],
    [{ foe: [960, 450] }, 'foe'],
    [{ hints: {} }, 'hints'],
    [{ hints: Array.from({ length: P.MAX_HINTS + 1 }, () => ({ x: 1, y: 1, w: 5, h: 5 })) }, 'hints'],
    [{ hints: [{ x: 1, y: 1, w: 0, h: 5 }] }, 'hints'],
    [{ hints: [{ x: 1, y: 1, w: 5, h: -5 }] }, 'hints'],
    [{ hints: [{ x: NaN, y: 1, w: 5, h: 5 }] }, 'hints'],
    [{ hints: [{ x: 1, y: 1, w: P.MAX_FRAME_SIDE * 3, h: 5 }] }, 'hints'],
    [{ hints: [null] }, 'hints'],
  ];
  for (const [over, reason] of cases) assert.deepEqual(P.checkFrame(frame(over)), { ok: false, reason }, JSON.stringify(over));
  assert.equal(P.MAX_HINTS, 16);
  assert.equal(P.checkFrame(frame({ hints: Array.from({ length: 16 }, () => ({ x: 1, y: 1, w: 5, h: 5 })) })).ok, true);
});

test('khởi tạo: kiểm base, bản dựng, đủ năm tệp (ArrayBuffer), mã băm hex và labels.json', () => {
  assert.deepEqual(P.checkInit(init()), { ok: true });
  assert.equal(P.checkInit(init({ build: 'relaxed' })).ok, true);
  const cases = [
    [{ base: 'models/' }, 'base'],
    [{ base: 'javascript:alert(1)' }, 'base'],
    [{ base: `https://a.test/${'x'.repeat(2048)}` }, 'base'],
    [{ base: 5 }, 'base'],
    [{ build: 'auto' }, 'build'],
    [{ build: 'threaded' }, 'build'],
    [{ files: null }, 'files'],
    [{ files: { iife: buf(), loader: buf(), wasm: buf(), det: buf() } }, 'files.cls'],
    [{ files: { iife: buf(0), loader: buf(), wasm: buf(), det: buf(), cls: buf() } }, 'files.iife'],
    [{ files: { iife: new Uint8Array(8), loader: buf(), wasm: buf(), det: buf(), cls: buf() } }, 'files.iife'],
    [{ files: { iife: buf(), loader: buf(), wasm: buf(P.MAX_FILE_BYTES + 1), det: buf(), cls: buf() } }, 'files.wasm'],
    [{ sha256: { iife: HEX, loader: HEX, wasm: 'A'.repeat(64), det: HEX, cls: HEX } }, 'sha256.wasm'],
    [{ sha256: { iife: HEX, loader: HEX, wasm: HEX, det: 'abc', cls: HEX } }, 'sha256.det'],
    [{ labels: labels({ T: 0 }) }, 'labels.T'],
  ];
  for (const [over, reason] of cases) assert.deepEqual(P.checkInit(init(over)), { ok: false, reason }, JSON.stringify(Object.keys(over)));
  assert.equal(P.MAX_FILE_BYTES, 32 * 1024 * 1024);
});

test('chạy thẳng tensor: đúng mô hình và đúng kích thước đầu vào', () => {
  const ok = { type: 'run', id: 3, model: 'cls', input: new Float32Array(48 * 48 * 3) };
  assert.deepEqual(P.checkRun(ok), { ok: true });
  assert.equal(P.checkRun({ ...ok, model: 'det', input: new Float32Array(352 * 640 * 3) }).ok, true);
  assert.equal(P.checkRun({ ...ok, model: 'x' }).reason, 'model');
  assert.equal(P.checkRun({ ...ok, input: new Float32Array(10) }).reason, 'input');
  assert.equal(P.checkRun({ ...ok, input: new Float64Array(48 * 48 * 3) }).reason, 'input');
  assert.equal(P.checkRun({ ...ok, id: -2 }).reason, 'id');
  assert.equal(P.checkWorkerMessage(ok).ok, true);
});

const box = (over = {}) => ({ x: 10, y: 20, w: 30, h: 30, family: 'ring', s: 0.8, pass: 'A', cls: [['P.127[50]', 0.9], ['P.127[60]', 0.05], ['other-sign', 0.01]], ...over });
const result = (over = {}) => ({ type: 'result', id: 4, t: 99, ms: { pre: 1, det: 2, cls: 3, total: 7 }, lum: { mean: 120, std: 30 }, boxes: [box()], ...over });

test('phản hồi của worker: ready, result, error, stats, outputs; kiểu lạ bị bỏ qua', () => {
  assert.equal(P.checkResponse({ type: 'ready', build: 'compat', input: [640, 352], labels: 181 }).ok, true);
  assert.equal(P.checkResponse({ type: 'ready', build: 'auto', input: [640, 352], labels: 181 }).reason, 'build');
  assert.equal(P.checkResponse({ type: 'ready', build: 'compat', input: [352, 640], labels: 181 }).reason, 'input');
  assert.equal(P.checkResponse({ type: 'ready', build: 'compat', input: [640, 352], labels: 1 }).reason, 'labels');
  assert.equal(P.checkResponse(result()).ok, true);
  assert.equal(P.checkResponse(result({ boxes: [box({ cls: null })] })).ok, true);
  assert.equal(P.checkResponse(result({ boxes: [] })).ok, true);
  assert.equal(P.checkResponse(result({ id: -1 })).reason, 'id');
  assert.equal(P.checkResponse(result({ ms: { pre: 1, det: 2, cls: 3 } })).reason, 'ms');
  assert.equal(P.checkResponse(result({ ms: { pre: -1, det: 2, cls: 3, total: 4 } })).reason, 'ms');
  assert.equal(P.checkResponse(result({ lum: { mean: 256, std: 1 } })).reason, 'lum');
  assert.equal(P.checkResponse(result({ boxes: Array.from({ length: 13 }, () => box()) })).reason, 'boxes');
  for (const b of [
    box({ s: 1.01 }),
    box({ pass: 'C' }),
    box({ w: 0 }),
    box({ x: NaN }),
    box({ family: 3 }),
    box({ cls: [] }),
    box({ cls: [['a', 0.5], ['b', 0.2], ['c', 0.1], ['d', 0.1]] }),
    box({ cls: [['a', 1.5]] }),
    box({ cls: [[1, 0.5]] }),
  ]) {
    assert.equal(P.checkResponse(result({ boxes: [b] })).reason, 'boxes', JSON.stringify(b));
  }
  assert.equal(P.checkResponse({ type: 'error', code: 'integrity' }).ok, true);
  assert.equal(P.checkResponse({ type: 'error', code: 'worker', id: 5 }).ok, true);
  assert.equal(P.checkResponse({ type: 'error', code: 'oops' }).reason, 'code');
  assert.equal(P.checkResponse({ type: 'error', code: 'worker', id: 'x' }).reason, 'id');
  assert.equal(P.checkResponse({ type: 'stats', frames: 3, closed: 3 }).ok, true);
  assert.equal(P.checkResponse({ type: 'stats', frames: -1, closed: 3 }).reason, 'stats');
  const outputs = (o) => ({ type: 'outputs', id: 2, outputs: o });
  assert.equal(P.checkResponse(outputs([{ shape: [1, 4], data: new Float32Array(4) }])).ok, true);
  assert.equal(P.checkResponse(outputs([{ shape: [1, 4], data: new Float32Array(5) }])).reason, 'outputs');
  assert.equal(P.checkResponse(outputs([])).reason, 'outputs');
  for (const m of [null, 'x', { type: 'frame' }, { type: 'init' }, { type: 'zzz' }]) assert.equal(P.checkResponse(m).ignore, true);
});

test('labels.json: hợp đồng phiên bản 1, 11 nhóm, đầu vào 640×352 bước 8, ô 48×48, nhiệt độ hợp lệ', () => {
  const l = P.checkLabels(labels());
  assert.equal(l.ok, true);
  assert.deepEqual(l.names, ['P.127[50]', 'other-sign', 'background']);
  assert.equal(l.families.length, 11);
  assert.equal(l.T, 1);
  const cases = [
    [{ version: 2 }, 'version'],
    [{ families: ['ring'] }, 'families'],
    [{ families: Array(11).fill('ring') }, 'families'],
    [{ det: { input: [320, 320, 3], stride: 8, out: [44, 80] } }, 'det'],
    [{ det: { input: [352, 640, 3], stride: 16, out: [22, 40] } }, 'det'],
    [{ cls: { input: [32, 32, 3] } }, 'cls'],
    [{ T: P.T_MIN - 0.001 }, 'T'],
    [{ T: P.T_MAX + 0.001 }, 'T'],
    [{ T: '1' }, 'T'],
    [{ labels: [{ i: 0, label: 'a', family: null }] }, 'labels'],
    [{ labels: [{ i: 0, label: 'a', family: null }, { i: 2, label: 'b', family: null }] }, 'labels'],
    [{ labels: [{ i: 0, label: 'a', family: null }, { i: 1, label: 'a', family: null }] }, 'labels'],
    [{ labels: [{ i: 0, label: 'a', family: 'square' }, { i: 1, label: 'b', family: null }] }, 'labels'],
    [{ labels: [{ i: 0, label: 'x'.repeat(41), family: null }, { i: 1, label: 'b', family: null }] }, 'labels'],
  ];
  for (const [over, reason] of cases) assert.equal(P.checkLabels(labels(over)).reason, reason, JSON.stringify(over).slice(0, 80));
  const many = (n) => Array.from({ length: n }, (_, i) => ({ i, label: `L${i}`, family: null }));
  assert.equal(P.MAX_LABELS, 1000);
  assert.equal(P.checkLabels(labels({ labels: many(P.MAX_LABELS) })).ok, true);
  assert.equal(P.checkLabels(labels({ labels: many(P.MAX_LABELS + 1) })).reason, 'labels');
  assert.equal(P.checkLabels(labels({ T: P.T_MIN })).ok, true);
  assert.equal(P.checkLabels(labels({ T: P.T_MAX })).ok, true);
  assert.equal(P.T_MIN, 0.05);
  assert.equal(P.T_MAX, 20);
});

test('labels.json thật của ứng dụng (nếu đã sinh) qua được bộ kiểm tra của runtime', { skip: !existsSync(new URL('../models/labels.json', import.meta.url)) }, () => {
  const j = JSON.parse(readFileSync(new URL('../models/labels.json', import.meta.url), 'utf8'));
  const l = P.checkLabels(j);
  assert.equal(l.ok, true, l.reason);
  assert.equal(l.names.length, 181);
});

test('vào/ra của mô hình: bộ dò hai đầu ra phân biệt bằng số kênh, bộ phân loại [1, số nhãn]', () => {
  const d = (shape, dtype = 'float32') => ({ shape: Int32Array.from(shape), dtype });
  const detIn = [d([1, 352, 640, 3])];
  assert.equal(P.checkModelIO('det', detIn, [d([1, 44, 80, 11]), d([1, 44, 80, 4])]).ok, true);
  assert.equal(P.checkModelIO('det', detIn, [d([1, 44, 80, 4]), d([1, 44, 80, 11])]).ok, true);
  assert.equal(P.checkModelIO('det', detIn, [d([1, 44, 80, 11])]).reason, 'outputs');
  assert.equal(P.checkModelIO('det', detIn, [d([1, 44, 80, 11]), d([1, 22, 40, 4])]).reason, 'outputs');
  assert.equal(P.checkModelIO('det', [d([1, 320, 320, 3])], [d([1, 44, 80, 11]), d([1, 44, 80, 4])]).reason, 'input');
  assert.equal(P.checkModelIO('det', [d([1, 352, 640, 3], 'int8')], [d([1, 44, 80, 11]), d([1, 44, 80, 4])]).reason, 'dtype');
  assert.equal(P.checkModelIO('det', [], []).reason, 'count');
  const clsIn = [d([1, 48, 48, 3])];
  assert.equal(P.checkModelIO('cls', clsIn, [d([1, 181])], 181).ok, true);
  assert.equal(P.checkModelIO('cls', clsIn, [d([1, 180])], 181).reason, 'outputs');
  assert.equal(P.checkModelIO('cls', [d([10, 48, 48, 3])], [d([10, 181])], 181).reason, 'input');
  assert.equal(P.checkModelIO('cls', clsIn, [d([1, 181], 'int8')], 181).reason, 'dtype');
});

// ---- Worker chạy trong ngữ cảnh vm (không có trình duyệt): đường đi của thông điệp và bitmap -------------------------

/** Nạp js/vision-worker.js như một worker cổ điển: self, importScripts (đọc từ js/), postMessage ghi lại. */
function workerSandbox() {
  const posted = [];
  const ctx = vm.createContext({ console });
  vm.runInContext('var self = globalThis;', ctx);
  ctx.postMessage = (m) => posted.push(m);
  ctx.importScripts = (...names) => {
    for (const n of names) vm.runInContext(read(n.replace(/^\.\//, '')), ctx, { filename: n });
  };
  vm.runInContext(read('vision-worker.js'), ctx, { filename: 'vision-worker.js' });
  const send = (m) => ctx.onmessage({ data: m });
  const stats = () => {
    send({ type: 'stats' });
    return posted.pop();
  };
  return { ctx, posted, send, stats };
}

test('worker: đóng mọi bitmap nhận được, kể cả trong stats, run, init và thông điệp lạ; mỗi bitmap đếm một lần', async () => {
  const w = workerSandbox();
  const bitmaps = [];
  const b = (wd, ht) => {
    const x = bitmap(wd, ht);
    bitmaps.push(x);
    return x;
  };
  w.send({ type: 'stats', bitmap: b() });
  assert.deepEqual({ ...w.posted.pop() }, { type: 'stats', frames: 1, closed: 1 });
  w.send({ type: 'zzz', bitmap: b() });
  assert.equal(w.posted.length, 0, 'kiểu lạ bị bỏ qua, không trả lời');
  // 'run' hợp lệ mang theo bitmap: bị đóng, rồi báo chưa sẵn sàng (không đóng lần hai).
  const input = vm.runInContext(`new Float32Array(${P.INPUT_SIZE.cls})`, w.ctx);
  w.send({ type: 'run', id: 3, model: 'cls', input, bitmap: b() });
  assert.deepEqual({ ...w.posted.pop() }, { type: 'error', code: 'worker', reason: 'not-ready', id: 3 });
  w.send({ type: 'init', bitmap: b() }); // thiếu trường: báo lỗi, đóng bitmap
  assert.equal(w.posted.pop().code, 'worker');
  w.send(frame({ id: 9, bitmap: b() })); // khung hợp lệ trước khi sẵn sàng
  assert.deepEqual({ ...w.posted.pop() }, { type: 'error', code: 'worker', reason: 'not-ready', id: 9 });
  w.send(frame({ id: 10, bitmap: b(), passes: ['C'] }));
  assert.match(w.posted.pop().reason, /passes/);
  w.send(frame({ id: 11, bitmap: b(5000, 100) }));
  assert.match(w.posted.pop().reason, /bitmap\.size/);
  assert.ok(bitmaps.every((x) => x.closed), 'mọi bitmap đã bị đóng');
  assert.deepEqual({ ...w.stats() }, { type: 'stats', frames: bitmaps.length, closed: bitmaps.length });
});

test('worker: init trên máy thiếu OffscreenCanvas → unsupported, sau đó từ chối init lần hai', async () => {
  const w = workerSandbox();
  // ArrayBuffer phải thuộc ngữ cảnh của worker (như sau structured clone), không thì bộ kiểm tra từ chối.
  const files = {};
  for (const k of P.INIT_FILES) files[k] = vm.runInContext('new ArrayBuffer(8)', w.ctx);
  w.send(init({ files }));
  await new Promise((r) => setImmediate(r));
  const e = w.posted.pop();
  assert.equal(e.type, 'error');
  assert.equal(e.code, 'unsupported');
  w.send(init({ files }));
  assert.deepEqual({ ...w.posted.pop() }, { type: 'error', code: 'load', reason: 'already-initialised' });
});

// ---- Ảnh cắt để kiểm tra độ chính xác (camEval, PLAN §6.5) ------------------------------------------------------------

test('ảnh cắt kiểm tra: khung + 15 %, chỉ phần trong khung hình, cạnh dài ≤ 96 px, giữ tỉ lệ, không phóng to', () => {
  assert.equal(P.EVAL_CROP_MARGIN, 0.15);
  assert.equal(P.EVAL_CROP_MARGIN, P.CROP_MARGIN, 'cùng lề với ô của bộ phân loại');
  assert.equal(P.EVAL_CROP_MAX, 96);
  assert.equal(P.EVAL_CROP_MAX_BYTES, 64 * 1024);
  assert.ok(P.EVAL_CROP_MAX_BYTES > P.EVAL_CROP_MAX * P.EVAL_CROP_MAX * 4, 'đủ cho cả ảnh 96×96 không nén được');
  assert.equal(P.EVAL_CROP_TYPE, 'image/png');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  // Khung nhỏ: giữ nguyên độ phân giải gốc.
  const a = P.evalCropRect({ x: 100, y: 200, w: 40, h: 40 }, 1920, 1080);
  a.src.forEach((v, i) => near(v, [94, 194, 52, 52][i]));
  assert.deepEqual([a.w, a.h], [52, 52]);
  // Khung lớn: thu nhỏ về 96 px theo cạnh dài, giữ tỉ lệ.
  const b = P.evalCropRect({ x: 500, y: 300, w: 200, h: 100 }, 1920, 1080);
  assert.deepEqual(b.src, [470, 285, 260, 130]);
  assert.deepEqual([b.w, b.h], [96, 48]);
  // Sát mép: chỉ phần trong khung hình.
  const c = P.evalCropRect({ x: 0, y: 1050, w: 40, h: 30 }, 1920, 1080);
  c.src.forEach((v, i) => near(v, [0, 1045.5, 46, 34.5][i]));
  assert.deepEqual([c.w, c.h], [46, 35]);
  assert.equal(P.evalCropRect({ x: 3000, y: 10, w: 40, h: 40 }, 1920, 1080), null);
  const d = P.evalCropRect({ x: 10, y: 10, w: 0.2, h: 0.2 }, 1920, 1080);
  assert.deepEqual([d.w, d.h], [1, 1], 'ít nhất 1 px');
});

test('khung hình: evalCrops là tuỳ chọn, chỉ nhận true/false', () => {
  assert.equal(P.checkFrame(frame()).ok, true);
  assert.equal(P.checkFrame(frame({ evalCrops: true })).ok, true);
  assert.equal(P.checkFrame(frame({ evalCrops: false })).ok, true);
  for (const v of ['true', 1, {}]) assert.deepEqual(P.checkFrame(frame({ evalCrops: v })), { ok: false, reason: 'evalCrops' });
});

test('phản hồi: result.crops tuỳ chọn, mỗi ảnh ứng với một khung đã phân loại, PNG nhỏ, cỡ 1…96 px', () => {
  const box = (cls = [['P.127[50]', 0.9]]) => ({ x: 1, y: 2, w: 30, h: 30, family: 'ring', s: 0.7, pass: 'A', cls });
  const blob = (size = 500, type = 'image/png') => new Blob([new Uint8Array(size)], { type });
  const result = (crops, boxes = [box(), box(null)]) => ({
    type: 'result', id: 1, t: 5, ms: { pre: 1, det: 2, cls: 3, total: 7 }, lum: { mean: 100, std: 30 }, boxes, crops,
  });
  assert.equal(P.checkResponse(result(undefined)).ok, true, 'không có crops: như cũ');
  assert.equal(P.checkResponse(result([])).ok, true);
  assert.equal(P.checkResponse(result([{ i: 0, blob: blob(), w: 39, h: 39 }])).ok, true);
  for (const bad of [
    [{ i: 1, blob: blob(), w: 39, h: 39 }], // khung chưa phân loại
    [{ i: 2, blob: blob(), w: 39, h: 39 }], // ngoài danh sách
    [{ i: 0, blob: blob(), w: 39, h: 39 }, { i: 0, blob: blob(), w: 39, h: 39 }], // trùng
    [{ i: 0, blob: blob(500, 'image/jpeg'), w: 39, h: 39 }],
    [{ i: 0, blob: blob(P.EVAL_CROP_MAX_BYTES + 1), w: 39, h: 39 }],
    [{ i: 0, blob: blob(0), w: 39, h: 39 }],
    [{ i: 0, blob: 'data:image/png;base64,AA==', w: 39, h: 39 }],
    [{ i: 0, blob: blob(), w: 97, h: 39 }],
    [{ i: 0, blob: blob(), w: 0, h: 39 }],
    [{ i: 0.5, blob: blob(), w: 39, h: 39 }],
    { 0: 1 },
  ]) {
    assert.deepEqual(P.checkResponse(result(bad)), { ok: false, reason: 'crops' }, JSON.stringify(bad));
  }
  assert.equal(P.checkResponse(result(Array.from({ length: 9 }, (_, i) => ({ i, blob: blob(), w: 9, h: 9 })), Array.from({ length: 9 }, () => box()))).ok, false, 'tối đa CLS_MAX ảnh');
});

/**
 * Worker đã khởi tạo với LiteRT giả (bộ dò trả một đỉnh ở giữa ô lượt A, khung 40×40; bộ phân loại chọn nhãn 0) và
 * OffscreenCanvas giả (ghi lại drawImage, convertToBlob trả PNG).
 */
async function readyWorker() {
  const posted = [];
  const ctx = vm.createContext({ console, performance, Blob, WebAssembly, crypto: globalThis.crypto });
  vm.runInContext('var self = globalThis;', ctx);
  let blobN = 0;
  ctx.URL = { createObjectURL: () => `blob:fake/${++blobN}`, revokeObjectURL() {} };
  const canvases = [];
  const toBlob = [];
  ctx.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.draws = [];
      canvases.push(this);
      const c = this;
      this.ctx = {
        fillRect() {},
        drawImage: (...a) => c.draws.push({ a, size: [c.width, c.height] }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128) }),
      };
    }
    getContext() {
      return this.ctx;
    }
    async convertToBlob(opts) {
      toBlob.push({ opts, size: [this.width, this.height] });
      return new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0])], { type: opts.type });
    }
  };
  const P0 = P;
  const heat = new Float32Array(P0.GRID_W * P0.GRID_H * P0.FAMILIES);
  const reg = new Float32Array(P0.GRID_W * P0.GRID_H * 4);
  const gx = 40;
  const gy = 22;
  heat[(gy * P0.GRID_W + gx) * P0.FAMILIES] = 0.9;
  reg.set([Math.log(40), Math.log(40), 0.5, 0.5], (gy * P0.GRID_W + gx) * 4);
  const tensor = (shape, data) => ({ shape, toTypedArray: () => data, delete() {} });
  let compiled = 0;
  const LiteRT = {
    Tensor: class { delete() {} },
    loadLiteRt: async () => {},
    loadAndCompile: async () => {
      const det = compiled++ === 0;
      return det
        ? {
            getInputDetails: () => [{ dtype: 'float32', shape: [1, 352, 640, 3] }],
            getOutputDetails: () => [{ dtype: 'float32', shape: [1, 44, 80, 4] }, { dtype: 'float32', shape: [1, 44, 80, 11] }],
            run: async () => [tensor([1, 44, 80, 4], reg), tensor([1, 44, 80, 11], heat)],
          }
        : {
            getInputDetails: () => [{ dtype: 'float32', shape: [1, 48, 48, 3] }],
            getOutputDetails: () => [{ dtype: 'float32', shape: [1, 3] }],
            run: async () => [tensor([1, 3], Float32Array.from([5, 0, 0]))],
          };
    },
  };
  ctx.postMessage = (m) => posted.push(m);
  ctx.importScripts = (...names) => {
    for (const n of names) {
      if (String(n).startsWith('blob:')) ctx.LiteRT = LiteRT;
      else vm.runInContext(read(n.replace(/^\.\//, '')), ctx, { filename: n });
    }
  };
  vm.runInContext(read('vision-worker.js'), ctx, { filename: 'vision-worker.js' });
  const send = (m) => ctx.onmessage({ data: m });
  const files = {};
  const sha256 = {};
  for (const k of P.INIT_FILES) {
    files[k] = vm.runInContext('new Uint8Array([1, 2, 3]).buffer', ctx);
    sha256[k] = createHash('sha256').update(new Uint8Array(files[k])).digest('hex');
  }
  send(init({ files, sha256 }));
  const next = async () => {
    for (let i = 0; i < 200 && !posted.length; i++) await new Promise((r) => setImmediate(r));
    return posted.shift();
  };
  const ready = await next();
  assert.equal(ready.type, 'ready', JSON.stringify(ready));
  return { send, next, canvases, toBlob };
}

test('worker: evalCrops → một ảnh PNG cho mỗi khung đã phân loại (khung + 15 %), bitmap vẫn bị đóng; không bật thì không cắt', async () => {
  const w = await readyWorker();
  const b1 = bitmap();
  w.send(frame({ id: 21, bitmap: b1, passes: ['A'] }));
  const r1 = await w.next();
  assert.equal(r1.type, 'result');
  assert.equal(P.checkResponse(r1).ok, true);
  assert.equal(r1.boxes.length, 1);
  assert.deepEqual(r1.boxes[0].cls[0][0], 'P.127[50]');
  assert.equal('crops' in r1, false, 'không yêu cầu: không có crops');
  assert.equal('crop' in r1.ms, false);
  assert.equal(w.toBlob.length, 0, 'không cắt ảnh nào');
  assert.equal(b1.closed, true);

  const b2 = bitmap();
  w.send(frame({ id: 22, bitmap: b2, passes: ['A'], evalCrops: true }));
  const r2 = await w.next();
  assert.equal(P.checkResponse(r2).ok, true, JSON.stringify(P.checkResponse(r2)));
  // Ô lượt A ở (640, 278); đỉnh ở ô (40, 22) + 0,5 → tâm (324, 180) trong ô, khung 40×40 → (944, 438) trên khung gốc.
  [r2.boxes[0].x, r2.boxes[0].y, r2.boxes[0].w].forEach((v, i) => assert.ok(Math.abs(v - [944, 438, 40][i]) < 1e-3, `${v}`));
  assert.equal(r2.crops.length, 1);
  const c = r2.crops[0];
  assert.equal(c.i, 0);
  assert.deepEqual([c.w, c.h], [52, 52]);
  assert.equal(c.blob.type, 'image/png');
  assert.equal(JSON.stringify(w.toBlob), JSON.stringify([{ opts: { type: 'image/png' }, size: [52, 52] }]));
  const ev = w.canvases.find((cv) => cv.draws.some((d) => d.size[0] === 52));
  const draw = ev.draws[ev.draws.length - 1];
  assert.equal(draw.a[0], b2, 'cắt từ chính khung hình, trước khi đóng');
  draw.a.slice(1, 5).forEach((v, i) => assert.ok(Math.abs(v - [938, 432, 52, 52][i]) < 1e-3, `${v}`));
  assert.deepEqual([...draw.a.slice(5)], [0, 0, 52, 52]);
  assert.ok(r2.ms.crop >= 0 && r2.ms.total >= r2.ms.crop);
  assert.equal(b2.closed, true, 'bitmap vẫn luôn bị đóng');
  // Lỗi khi cắt ảnh không làm hỏng khung: chỉ không có ảnh.
  for (const cv of w.canvases) cv.convertToBlob = async () => { throw new Error('hết bộ nhớ'); };
  const b3 = bitmap();
  w.send(frame({ id: 23, bitmap: b3, passes: ['A'], evalCrops: true }));
  const r3 = await w.next();
  assert.equal(r3.type, 'result');
  assert.deepEqual([...r3.crops], []);
  assert.equal(b3.closed, true);
});
