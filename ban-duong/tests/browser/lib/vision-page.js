// Mã chạy trong trang kiểm thử của tests/browser/vision-smoke.mjs: dựng khung hình tổng hợp 1920×1080, chạy Vision
// thật (worker, LiteRT.js, mô hình giả) và trả số liệu cho Playwright qua window.visionTest.

import { Vision } from '../../../js/vision.js';

const W = 1920;
const H = 1080;

/** Cảnh tổng hợp: trời, mặt đường, vạch kẻ và vài biển tròn/tam giác/xanh dịch dần theo khung thứ k. */
function scene(ctx, k) {
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.45);
  sky.addColorStop(0, '#7fa6d6');
  sky.addColorStop(1, '#dfe8f2');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5a5d60';
  ctx.beginPath();
  ctx.moveTo(W * 0.48, H * 0.42);
  ctx.lineTo(W * 0.52, H * 0.42);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 6;
  ctx.setLineDash([40, 40]);
  ctx.lineDashOffset = -k * 12;
  ctx.beginPath();
  ctx.moveTo(W / 2, H * 0.42);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
  const grow = 1 + (k % 30) * 0.04;
  const signs = [
    { x: 1180, y: 380, r: 18, kind: 'ring' },
    { x: 760, y: 420, r: 12, kind: 'triangle' },
    { x: 1500, y: 300, r: 40, kind: 'ring' },
    { x: 1250, y: 480, r: 26, kind: 'blue' },
  ];
  for (const s of signs) {
    const r = s.r * grow;
    const x = W / 2 + (s.x - W / 2) * grow;
    const y = H * 0.42 + (s.y - H * 0.42) * grow;
    ctx.fillStyle = '#888';
    ctx.fillRect(x - 2, y, 4, H * 0.3 * grow);
    if (s.kind === 'ring') {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#d0021b';
      ctx.lineWidth = r * 0.2;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = `bold ${Math.round(r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('50', x, y);
    } else if (s.kind === 'triangle') {
      ctx.fillStyle = '#f5c400';
      ctx.strokeStyle = '#d0021b';
      ctx.lineWidth = r * 0.18;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r * 0.75);
      ctx.lineTo(x - r, y + r * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = '#1f5fbf';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function makeCanvas() {
  const c = new OffscreenCanvas(W, H);
  return { c, ctx: c.getContext('2d') };
}

function brief(r) {
  return r && { t: r.t, ms: r.ms, lum: r.lum, boxes: r.boxes };
}

async function run({ manifest, build, frames = 100, warm = 5, passes = ['A', 'B'] }) {
  const v = new Vision();
  let progress = null;
  let progressCalls = 0;
  const t0 = performance.now();
  const info = await v.load({
    manifest,
    build,
    onProgress: (p) => {
      progress = p;
      progressCalls++;
    },
  });
  const loadMs = performance.now() - t0;
  const { c, ctx } = makeCanvas();
  const rows = [];
  const samples = [];
  let detachedAll = true;
  let nulls = 0;
  for (let i = 0; i < warm + frames; i++) {
    scene(ctx, i);
    const bmp = await createImageBitmap(c);
    const t = performance.now();
    const r = await v.process({ bitmap: bmp, t }, { passes });
    if (bmp.width !== 0) detachedAll = false;
    if (!r) {
      nulls++;
      continue;
    }
    if (r.t !== t) throw new Error('t not echoed');
    if (i >= warm) rows.push({ ms: r.ms, n: r.boxes.length, ncls: r.boxes.filter((b) => b.cls).length });
    if (samples.length < 3) samples.push(brief(r));
  }

  // Ưu tiên khung gợi ý: khung đủ cỡ nhưng chưa được phân loại vì hết suất, gửi lại làm gợi ý trên cùng cảnh.
  scene(ctx, 0);
  const base = await v.process(await createImageBitmap(c), { passes });
  const unclassified = base.boxes.filter((b) => b.cls === null && b.w >= 20 && b.w <= 400);
  let hint = null;
  if (unclassified.length) {
    const hints = unclassified.slice(0, 2).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
    const again = await v.process(await createImageBitmap(c), { passes, hints });
    const match = (h) => again.boxes.find((b) => Math.abs(b.x - h.x) < 0.5 && Math.abs(b.y - h.y) < 0.5);
    hint = { tried: hints.length, classifiedNow: hints.filter((h) => match(h) && match(h).cls).length };
  }

  // Đang bận: khung thứ hai bị bỏ (null) và bitmap của nó bị đóng ngay.
  scene(ctx, 1);
  const b1 = await createImageBitmap(c);
  const b2 = await createImageBitmap(c);
  const p1 = v.process(b1, { passes });
  const p2 = v.process(b2, { passes });
  const r2 = await p2;
  const r1 = await p1;
  const busy = { secondNull: r2 === null, secondClosed: b2.width === 0, firstOk: !!r1 };

  const counts = await v.bitmapCounts();
  const stats = v.stats();
  v.terminate();
  return { info, loadMs, progress, progressCalls, rows, samples, detachedAll, nulls, hint, busy, counts, stats };
}

async function loadError({ manifest, build }) {
  const v = new Vision();
  try {
    await v.load({ manifest, build });
    v.terminate();
    return null;
  } catch (err) {
    v.terminate();
    return { code: err.code, message: String(err.message) };
  }
}

/** Gửi thẳng thông điệp vào worker: kiểu lạ bị bỏ qua, khung trước khi sẵn sàng hay khung sai đều bị đóng, và worker
 *  tự kiểm SHA-256 (sai một mã băm → 'integrity'). */
async function workerDirect({ manifest, build }) {
  const w = new Worker(new URL('../../../js/vision-worker.js', import.meta.url));
  const replies = [];
  let wake = null;
  w.onmessage = (e) => {
    replies.push(e.data);
    if (wake) wake();
  };
  const next = async () => {
    const until = performance.now() + 30e3;
    while (!replies.length) {
      if (performance.now() > until) throw new Error('worker silent');
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 200);
      });
    }
    return replies.shift();
  };
  const out = {};
  w.postMessage({ type: 'zzz', bitmap: null });
  w.postMessage({ type: 'stats' });
  out.unknownIgnored = await next();
  const { c, ctx } = makeCanvas();
  scene(ctx, 0);
  // Thông điệp hợp lệ nhưng không phải 'frame' mà mang bitmap: worker vẫn phải đóng nó.
  const b0 = await createImageBitmap(c);
  w.postMessage({ type: 'stats', bitmap: b0 }, [b0]);
  out.statsWithBitmap = await next();
  const b = await createImageBitmap(c);
  w.postMessage({ type: 'frame', id: 7, t: 1, bitmap: b, passes: ['A'], foe: { x: 960, y: 450 } }, [b]);
  out.frameBeforeReady = await next();
  const b2 = await createImageBitmap(c);
  w.postMessage({ type: 'frame', id: 8, t: 1, bitmap: b2, passes: ['C'], foe: { x: 960, y: 450 } }, [b2]);
  out.badPasses = await next();
  w.postMessage({ type: 'stats' });
  out.countsAfter = await next();

  const paths = {
    iife: 'vendor/litert/litert.iife.min.js',
    loader: build === 'relaxed' ? 'vendor/litert/litert_wasm_internal.js' : 'vendor/litert/litert_wasm_compat_internal.js',
    wasm: build === 'relaxed' ? 'vendor/litert/litert_wasm_internal.wasm' : 'vendor/litert/litert_wasm_compat_internal.wasm',
    det: 'models/sign-det.int8.tflite',
    cls: 'models/sign-cls.int8.tflite',
  };
  const root = new URL('../../../', import.meta.url);
  const files = {};
  const sha256 = {};
  for (const [k, p] of Object.entries(paths)) {
    files[k] = await (await fetch(new URL(p, root))).arrayBuffer();
    sha256[k] = manifest.files[p].sha256;
  }
  sha256.wasm = sha256.wasm.replace(/^./, (ch) => (ch === '0' ? '1' : '0'));
  const labels = await (await fetch(new URL('models/labels.json', root))).json();
  w.postMessage({ type: 'init', base: root.href, build, files, sha256, labels }, Object.values(files));
  out.tamperedInit = await next();
  w.terminate();
  return out;
}

/** Chạy vectơ mẫu (từ trình thông dịch TFLite của TF) qua worker; trả sai lệch lớn nhất theo từng đầu ra. */
async function parity({ manifest, build, golden }) {
  const v = new Vision();
  await v.load({ manifest, build });
  const f32 = async (name) => new Float32Array(await (await fetch(`${golden}${name}`)).arrayBuffer());
  const out = {};
  for (const [model, chans] of [['det', [11, 4]], ['cls', [181]]]) {
    const outs = await v.runTensor(model, await f32(`${model}-in.f32`));
    out[model] = { shapes: outs.map((o) => o.shape) };
    for (const ch of chans) {
      const want = await f32(`${model}-out-${ch}.f32`);
      const got = outs.find((o) => o.shape[o.shape.length - 1] === ch);
      let max = 0;
      let range = 0;
      for (let i = 0; i < want.length; i++) {
        max = Math.max(max, Math.abs(want[i] - got.data[i]));
        range = Math.max(range, Math.abs(want[i]));
      }
      out[model][ch] = { maxAbsDiff: max, maxAbs: range, n: want.length, same: got.data.length === want.length };
    }
  }
  v.terminate();
  return out;
}

/**
 * Đường đi của khung hình, lượt A: điểm ảnh của ô cắt 640×352 (đọc thẳng từ canvas) chạy qua runTensor rồi giải mã
 * bằng VisionProto phải ra đúng các khung mà process() trả về. Kiểm cách cắt, thứ tự kênh, /255, giải mã, đổi toạ độ
 * và việc bỏ khung bị ô cắt xén: dò điểm tụ trên một lưới cho tới khi giải mã thô có ít nhất một khung bị xén.
 */
async function framePath({ manifest, build }) {
  const P = globalThis.VisionProto;
  const v = new Vision();
  await v.load({ manifest, build });
  const { c, ctx } = makeCanvas();
  const labels = await (await fetch(new URL('../../../models/labels.json', import.meta.url))).json().catch(() => null);
  const fam = labels ? labels.families : null;
  let best = null;
  let tried = 0;
  search: for (const k of [3, 0, 7, 12]) {
    scene(ctx, k);
    for (let fy = 200; fy <= 880; fy += 85) {
      for (let fx = 340; fx <= 1580; fx += 62) {
        tried++;
        const foe = { x: fx, y: fy };
        const g = P.passGeometry('A', W, H, foe);
        const rgba = ctx.getImageData(g.src[0], g.src[1], g.src[2], g.src[3]).data;
        const input = P.rgbaToRgb(rgba, new Float32Array(P.DET_W * P.DET_H * 3));
        const outs = await v.runTensor('det', input);
        const heat = outs.find((o) => o.shape[3] === P.FAMILIES).data;
        const reg = outs.find((o) => o.shape[3] === 4).data;
        const raw = P.decodePeaks(heat, reg).map((p) => ({ ...P.toFrame(p, g), family: p.family, s: p.s }));
        const cut = raw.filter((b) => P.cutByCrop(b, g, W, H)).length;
        best = { k, foe, g, raw, cut };
        if (cut > 0) break search;
      }
    }
  }
  scene(ctx, best.k);
  const want = P.nms(best.raw.filter((b) => !P.cutByCrop(b, best.g, W, H)));
  const r = await v.process(await createImageBitmap(c), { passes: ['A'], foe: best.foe });
  v.terminate();
  let maxDiff = 0;
  const same = want.length === r.boxes.length && want.every((w, i) => {
    const b = r.boxes[i];
    maxDiff = Math.max(maxDiff, Math.abs(w.x - b.x), Math.abs(w.y - b.y), Math.abs(w.w - b.w), Math.abs(w.h - b.h), Math.abs(w.s - b.s));
    return !fam || fam[w.family] === b.family;
  });
  const leaked = r.boxes.filter((b) => P.cutByCrop(b, best.g, W, H)).length;
  return { n: want.length, got: r.boxes.length, same, maxDiff, crop: best.g.src, foe: best.foe, tried, cutRaw: best.cut, leaked };
}

/**
 * Tải Vision với một worker "có cổng": thông điệp init chỉ được gửi khi Playwright gọi openGate(), để kịp gắn bộ đếm
 * navigator.gpu.requestAdapter vào worker trước khi LiteRT chạy.
 */
let openGate = null;
async function gpuLoad({ manifest, build }) {
  const gate = new Promise((r) => {
    openGate = r;
  });
  const createWorker = (url) => {
    const real = new Worker(url, { name: 'ban-duong-vision' });
    return {
      set onmessage(f) {
        real.onmessage = f;
      },
      set onerror(f) {
        real.onerror = f;
      },
      set onmessageerror(f) {
        real.onmessageerror = f;
      },
      postMessage(m, t) {
        gate.then(() => real.postMessage(m, t));
      },
      terminate() {
        real.terminate();
      },
    };
  };
  const v = new Vision({ createWorker });
  const info = await v.load({ manifest, build });
  window.__gpuVision = v;
  return info;
}

window.visionTest = {
  run,
  loadError,
  workerDirect,
  parity,
  framePath,
  gpuLoad,
  openGate: () => openGate && openGate(),
  stopGpu: () => window.__gpuVision && window.__gpuVision.terminate(),
};
window.visionTestReady = true;
