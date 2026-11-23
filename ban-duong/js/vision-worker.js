// Worker nhận diện biển: chạy bộ dò (heatmap theo 11 nhóm hình dạng) và bộ phân loại bằng LiteRT.js (WebAssembly,
// một luồng) trên từng khung hình camera mà trang chuyển sang. Không giữ, không gửi đi khung hình nào: mọi ImageBitmap
// nhận được đều bị đóng ngay khi xử lý xong, kể cả khi lỗi.
//
// Là worker CỔ ĐIỂN vì trình nạp của LiteRT.js dùng importScripts. Mã LiteRT (tệp IIFE và tệp nạp wasm) cùng tệp wasm
// và hai mô hình đều do trang tải, kiểm SHA-256 rồi chuyển sang dưới dạng byte; worker kiểm lại một lần nữa rồi chỉ chạy
// đúng những byte đó (tệp .js nạp qua blob:, tệp wasm qua Module.instantiateWasm), không tự tải gì từ mạng.
//
// Giao thức (mọi thông điệp được kiểm bằng VisionProto; kiểu lạ bị bỏ qua):
//   → { type:'init', base, build:'compat'|'relaxed', files:{ iife, loader, wasm, det, cls }, sha256:{…}, labels }
//   ← { type:'ready', build, input:[640,352], labels:n }
//   → { type:'frame', id, t, bitmap (chuyển quyền), passes:['A'|'B',…], foe:{x,y}, hints?:[{x,y,w,h}], evalCrops?:true }
//   ← { type:'result', id, t, ms:{pre,det,cls,total[,crop]}, lum:{mean,std}, boxes:[…][, crops:[{ i, blob, w, h }]] }
//     (crops và ms.crop chỉ có khi khung gửi evalCrops: true, tức người dùng bật "Lưu ảnh biển để kiểm tra độ chính
//     xác": mỗi khung đã phân loại cho một ảnh PNG nhỏ, khung + 15 %, cạnh dài ≤ 96 px. Khung hình gốc vẫn bị đóng.)
//   → { type:'stats' }   ← { type:'stats', frames, closed }   (đếm khung đã nhận / đã đóng, để kiểm thử)
//   → { type:'run', id, model:'det'|'cls', input:Float32Array }   ← { type:'outputs', id, outputs:[{ shape, data }] }
//     (chạy thẳng một tensor, để so với vectơ mẫu models/golden/ khi kiểm thử)
//   ← { type:'error', code:'integrity'|'load'|'unsupported'|'worker', id?, reason? }

'use strict';

importScripts('./visionproto.js');
const P = self.VisionProto;

const LOADER_NAME = { compat: 'litert_wasm_compat_internal.js', relaxed: 'litert_wasm_internal.js' };
const SMOOTHING = 'medium'; // chất lượng thu nhỏ khi vẽ (lượt B thu nhỏ ~3 lần, ô phân loại tới ~10 lần)
// Lời cảnh báo LiteRT in ra khi không xin được WebGPU. Ở đây là cố ý (xem hideWebGpu) nên không in ra.
const WEBGPU_WARNING = 'Failed to create default WebGPU device';

let state = 'idle'; // 'loading' | 'ready' | 'failed'
let busy = false;
let det = null;
let cls = null;
let names = null;
let families = null;
let T = 1;
let frames = 0;
let closed = 0;
let detCtx = null;
let clsCtx = null;
let lumCtx = null;
let evalCanvas = null; // canvas cho ảnh cắt kiểm tra độ chính xác, tạo khi cần lần đầu
// Mảng dùng lại giữa các khung hình.
const detIn = new Float32Array(P.DET_W * P.DET_H * 3);
const clsIn = new Float32Array(P.CLS_SIZE * P.CLS_SIZE * 3);
const heat = new Float32Array(P.GRID_W * P.GRID_H * P.FAMILIES);
const reg = new Float32Array(P.GRID_W * P.GRID_H * 4);

const post = (m) => self.postMessage(m);
const fail = (code, reason, id) => post(id == null ? { type: 'error', code, reason } : { type: 'error', code, reason, id });

function closeBitmap(m) {
  const b = m && typeof m === 'object' ? m.bitmap : null;
  if (b && typeof b.close === 'function') {
    try {
      b.close();
    } catch {
      // đã đóng hoặc đã bị tách: không còn gì để giải phóng
    }
    closed++;
    m.bitmap = null; // mỗi bitmap chỉ đóng và đếm một lần
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m && typeof m === 'object' && m.bitmap) frames++;
  const v = P.checkWorkerMessage(m);
  // Chỉ một khung 'frame' hợp lệ được giữ bitmap tới khi xử lý xong; mọi thông điệp khác mang bitmap (sai, kiểu lạ,
  // 'stats', 'run', 'init') đóng nó ngay.
  if (!v.ok || m.type !== 'frame') closeBitmap(m);
  if (!v.ok) {
    const id = m && Number.isInteger(m.id) && m.id >= 0 && m.id <= P.MAX_ID ? m.id : undefined;
    if (!v.ignore) fail('worker', `bad-message:${v.reason}`, id);
    return;
  }
  if (m.type === 'stats') {
    post({ type: 'stats', frames, closed });
    return;
  }
  if (m.type === 'init') {
    if (state !== 'idle') return fail('load', 'already-initialised');
    state = 'loading';
    init(m).then(
      (ready) => {
        state = 'ready';
        post(ready);
      },
      (err) => {
        state = 'failed';
        fail(err && err.code ? err.code : 'load', String((err && err.message) || err).slice(0, 300));
      }
    );
    return;
  }
  // frame, run
  if (state !== 'ready' || busy) {
    closeBitmap(m);
    fail('worker', state !== 'ready' ? 'not-ready' : 'busy', m.id);
    return;
  }
  busy = true;
  (m.type === 'run' ? onRun(m) : onFrame(m))
    .then(post, (err) => fail('worker', String((err && err.message) || err).slice(0, 300), m.id))
    .finally(() => {
      busy = false;
    });
};

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * LiteRT.loadLiteRt luôn tạo môi trường mặc định, và nếu trình duyệt có WebGPU thì xin một GPU 'high-performance'
 * giữ suốt đời worker, dù ở đây chỉ chạy bằng wasm: tốn pin và nóng máy ngoài ngân sách tính toán (PLAN §5.6).
 * Giấu navigator.gpu trong worker này để nó không xin. Không giấu được thì vẫn chạy đúng, chỉ tốn hơn.
 */
function hideWebGpu() {
  try {
    Object.defineProperty(self.navigator, 'gpu', { value: undefined, configurable: true });
  } catch {
    // trình duyệt không cho định nghĩa lại
  }
}

/** Chạy fn() mà bỏ lời cảnh báo WEBGPU_WARNING (và chỉ lời đó) LiteRT in ra trong lúc ấy. */
async function withoutWebGpuWarning(fn) {
  const warn = console.warn;
  console.warn = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith(WEBGPU_WARNING)) return;
    warn.apply(console, a);
  };
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

function scriptUrl(buf, name) {
  // Fragment giữ đuôi tên tệp để LiteRT nhận ra đây là đường dẫn đầy đủ tới tệp nạp (không phải thư mục) và nạp
  // đúng bản dựng đã chọn; khi tra blob: trình duyệt bỏ qua fragment.
  return `${URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }))}#${name}`;
}

async function init(m) {
  if (typeof OffscreenCanvas === 'undefined' || !self.crypto || !crypto.subtle || typeof WebAssembly === 'undefined') {
    throw codeError('unsupported', 'missing OffscreenCanvas, crypto.subtle or WebAssembly');
  }
  for (const k of P.INIT_FILES) {
    if ((await sha256Hex(m.files[k])) !== m.sha256[k]) throw codeError('integrity', k);
  }
  const lab = P.checkLabels(m.labels);
  names = lab.names;
  families = lab.families;
  T = lab.T;

  const iife = scriptUrl(m.files.iife, 'litert.iife.min.js');
  importScripts(iife);
  URL.revokeObjectURL(iife.split('#')[0]);
  const LiteRT = self.LiteRT;
  if (!LiteRT || typeof LiteRT.loadLiteRt !== 'function') throw codeError('load', 'LiteRT global missing');

  const wasm = m.files.wasm;
  let instFail;
  const instFailed = new Promise((resolve, reject) => {
    instFail = reject;
  });
  // Trình nạp Emscripten đọc self.Module: locateFile chỉ là lối dự phòng (trỏ vào vendor/litert/ của ứng dụng);
  // instantiateWasm khiến nó dùng đúng byte wasm đã kiểm thay vì tự tải tệp .wasm.
  self.Module = {
    locateFile: (f) => new URL(`vendor/litert/${f}`, m.base).href,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasm, imports).then(
        (r) => done(r.instance),
        // Byte đã kiểm SHA-256 nên lỗi biên dịch nghĩa là máy thiếu tính năng wasm mà bản dựng cần.
        (err) => instFail(codeError(err instanceof WebAssembly.CompileError ? 'unsupported' : 'load', String(err)))
      );
      return {};
    },
  };
  const loader = scriptUrl(m.files.loader, LOADER_NAME[m.build]);
  hideWebGpu();
  try {
    await withoutWebGpuWarning(() => Promise.race([LiteRT.loadLiteRt(loader), instFailed]));
  } finally {
    URL.revokeObjectURL(loader.split('#')[0]);
  }
  const opts = { accelerator: 'wasm', cpuOptions: { numThreads: 1 } };
  det = await LiteRT.loadAndCompile(new Uint8Array(m.files.det), opts);
  cls = await LiteRT.loadAndCompile(new Uint8Array(m.files.cls), opts);
  const dio = P.checkModelIO('det', det.getInputDetails(), det.getOutputDetails());
  if (!dio.ok) throw codeError('load', `detector I/O: ${dio.reason}`);
  const cio = P.checkModelIO('cls', cls.getInputDetails(), cls.getOutputDetails(), names.length);
  if (!cio.ok) throw codeError('load', `classifier I/O: ${cio.reason}`);

  detCtx = context(P.DET_W, P.DET_H);
  clsCtx = context(P.CLS_SIZE, P.CLS_SIZE);
  lumCtx = context(P.LUM_W, P.LUM_H);
  return { type: 'ready', build: m.build, input: [P.DET_W, P.DET_H], labels: names.length };
}

function context(w, h) {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) throw codeError('unsupported', 'OffscreenCanvas 2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = SMOOTHING;
  return ctx;
}

function readOut(t) {
  try {
    return Promise.resolve(t.toTypedArray());
  } catch {
    // Tensor không nằm trong bộ nhớ thường: chuyển về rồi đọc.
    return t.moveTo('wasm').then((h) => {
      try {
        return h.toTypedArray();
      } finally {
        h.delete();
      }
    });
  }
}

async function onRun(m) {
  const model = m.model === 'det' ? det : cls;
  const shape = m.model === 'det' ? [1, P.DET_H, P.DET_W, 3] : [1, P.CLS_SIZE, P.CLS_SIZE, 3];
  const t = new self.LiteRT.Tensor(m.input, shape);
  let outs;
  try {
    outs = await model.run(t);
  } finally {
    t.delete();
  }
  const outputs = [];
  try {
    for (const o of outs) outputs.push({ shape: Array.from(o.shape), data: Float32Array.from(await readOut(o)) });
  } finally {
    for (const o of outs) o.delete();
  }
  return { type: 'outputs', id: m.id, outputs };
}

async function runModel(model, input, shape, sinks) {
  const t = new self.LiteRT.Tensor(input, shape);
  let outs;
  try {
    outs = await model.run(t);
  } finally {
    t.delete();
  }
  try {
    for (const o of outs) {
      const sh = o.shape;
      const sink = sinks(sh[sh.length - 1]);
      if (sink) sink.set(await readOut(o));
    }
  } finally {
    for (const o of outs) o.delete();
  }
}

function draw(ctx, bmp, g, w, h) {
  if (!g.cover) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, g.src[0], g.src[1], g.src[2], g.src[3], g.dst[0], g.dst[1], g.dst[2], g.dst[3]);
  return ctx.getImageData(0, 0, w, h).data;
}

let logits = null;

/**
 * Ảnh PNG cắt sát khung (VisionProto.evalCropRect) cho tập kiểm tra độ chính xác → { blob, w, h } hoặc null. Lỗi ở
 * đây không làm hỏng khung: ảnh cắt chỉ là phần thêm.
 */
async function evalCrop(bmp, box, W, H) {
  const r = P.evalCropRect(box, W, H);
  if (!r) return null;
  try {
    if (!evalCanvas) evalCanvas = new OffscreenCanvas(r.w, r.h);
    evalCanvas.width = r.w; // đổi cỡ cũng xoá nội dung và đặt lại trạng thái của ngữ cảnh
    evalCanvas.height = r.h;
    const ctx = evalCanvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = SMOOTHING;
    ctx.drawImage(bmp, r.src[0], r.src[1], r.src[2], r.src[3], 0, 0, r.w, r.h);
    const blob = await evalCanvas.convertToBlob({ type: P.EVAL_CROP_TYPE });
    if (!blob || blob.type !== P.EVAL_CROP_TYPE || !(blob.size > 0 && blob.size <= P.EVAL_CROP_MAX_BYTES)) return null;
    return { blob, w: r.w, h: r.h };
  } catch {
    return null;
  }
}

async function onFrame(m) {
  const bmp = m.bitmap;
  const t0 = performance.now();
  let pre = 0;
  let detMs = 0;
  let clsMs = 0;
  try {
    const W = bmp.width;
    const H = bmp.height;
    const cands = [];
    for (const pass of m.passes) {
      const a = performance.now();
      const g = P.passGeometry(pass, W, H, m.foe);
      P.rgbaToRgb(draw(detCtx, bmp, g, P.DET_W, P.DET_H), detIn);
      const b = performance.now();
      pre += b - a;
      await runModel(det, detIn, [1, P.DET_H, P.DET_W, 3], (ch) => (ch === P.FAMILIES ? heat : ch === 4 ? reg : null));
      detMs += performance.now() - b;
      for (const k of P.decodePeaks(heat, reg)) {
        const b = P.toFrame(k, g);
        // Biển đang rời ô lượt A: khung bị xén, bề rộng sai. Bỏ đi; lượt B (nếu chạy) báo khung đầy đủ.
        if (P.cutByCrop(b, g, W, H)) continue;
        cands.push({ ...b, family: k.family, s: k.s, pass });
      }
    }
    const a = performance.now();
    const lum = P.lumStats(draw(lumCtx, bmp, { src: [0, 0, W, H], dst: [0, 0, P.LUM_W, P.LUM_H], cover: true }, P.LUM_W, P.LUM_H));
    pre += performance.now() - a;

    const kept = P.nms(cands);
    const boxes = kept.map((k) => ({ x: k.x, y: k.y, w: k.w, h: k.h, family: families[k.family], s: k.s, pass: k.pass, cls: null }));
    const c0 = performance.now();
    const classified = [];
    for (const i of P.pickForClassifier(kept, m.hints)) {
      const r = P.cropRect(kept[i], W, H);
      if (!r) continue;
      clsCtx.fillStyle = '#000';
      clsCtx.fillRect(0, 0, P.CLS_SIZE, P.CLS_SIZE);
      clsCtx.drawImage(bmp, r.src[0], r.src[1], r.src[2], r.src[3], r.dst[0], r.dst[1], r.dst[2], r.dst[3]);
      P.rgbaToRgb(clsCtx.getImageData(0, 0, P.CLS_SIZE, P.CLS_SIZE).data, clsIn);
      if (!logits) logits = new Float32Array(names.length);
      await runModel(cls, clsIn, [1, P.CLS_SIZE, P.CLS_SIZE, 3], (ch) => (ch === names.length ? logits : null));
      boxes[i].cls = P.topK(P.softmaxT(logits, T), names, P.TOP_K);
      classified.push(i);
    }
    clsMs = performance.now() - c0;
    const ms = { pre, det: detMs, cls: clsMs, total: 0 };
    const out = { type: 'result', id: m.id, t: m.t, ms, lum, boxes };
    if (m.evalCrops === true) {
      // Chỉ khi được yêu cầu, và trước khi bitmap bị đóng (finally bên dưới).
      const e0 = performance.now();
      out.crops = [];
      for (const i of classified) {
        const c = await evalCrop(bmp, boxes[i], W, H);
        if (c) out.crops.push({ i, ...c });
      }
      ms.crop = performance.now() - e0;
    }
    ms.total = performance.now() - t0;
    return out;
  } finally {
    closeBitmap(m);
  }
}
