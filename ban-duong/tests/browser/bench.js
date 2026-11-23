// Đo bộ nhận diện thật (js/vision.js, LiteRT.js, mô hình trong models/) trên trình duyệt: độ trễ mỗi khung cho từng
// bản dựng wasm và từng tổ hợp lượt quét, chạy dài (soak), và so đầu ra với vectơ mẫu models/golden/index.json.
// Dùng chung cho trang đo trên máy (device-bench.html) và kịch bản S10, S11 của tests/browser/run.mjs.
// Cần scene.js đã nạp (globalThis.BDScene) cho cảnh tổng hợp. Khung hình chỉ đi thẳng vào bộ nhận diện (worker đóng
// từng khung); không lưu, không gửi đi đâu.

import { planFiles, Vision } from '../../js/vision.js';
import { ML_MANIFEST } from '../../js/mlmanifest.js';
import { signSvg } from '../../js/signart.js';
import { lookupSign } from '../../js/signs.js';

const S = globalThis.BDScene;
const ROOT = new URL('../../', import.meta.url);

export const BUILDS = Object.freeze(['compat', 'relaxed']);
export const PASS_SETS = Object.freeze({ A: ['A'], AB: ['A', 'B'] }); // hai tổ hợp lượt quét mà bộ chọn mức tải dùng
export const DEFAULT_FRAMES = 200; // số khung đo mỗi tổ hợp (PLAN §8.2: ≥ 200)
export const WARM_FRAMES = 5; // khung chạy trước, không tính (wasm còn đang khởi động)
export const SOAK_MINUTES = 30; // thời gian chạy dài (phút)
export const SOAK_TICK_MS = 60e3; // chạy dài: tổng kết mỗi chừng này (ms)
export const SOAK_FPS = 3; // chạy dài: nhịp khung như mức tải mặc định (mức 2)
export const LOAD_DUTY = 0.5; // tải nền giả lập: phần thời gian một worker bận
const SPEED = 13.8; // m/s, xe trong cảnh tổng hợp
const LOOP = Object.freeze({ from: 250, to: 700 }); // m, đoạn đường cảnh tổng hợp chạy lặp (qua cả ba biển)
const SIGNS = Object.freeze([
  { label: 'P.127[50]', code: 'P.127', value: '50', s: 350, family: 'ring' },
  { label: 'W.224', code: 'W.224', value: null, s: 520, family: 'triangle' },
  { label: 'R.122', code: 'R.122', value: null, s: 690, family: 'octagon' },
]);

/** Các tệp mô hình đã có trong bản cài chưa (theo js/mlmanifest.js). */
export function modelsReady(manifest = ML_MANIFEST) {
  const c = planFiles(manifest, 'compat');
  return { ok: c.ok, missing: c.missing };
}

/** Phân vị q của một dãy đã sắp xếp (nội suy tuyến tính), làm tròn 0,1 ms. */
export function quantileOf(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 10) / 10;
}

export function summarize(values) {
  const s = values.slice().sort((a, b) => a - b);
  return { n: s.length, p50: quantileOf(s, 0.5), p90: quantileOf(s, 0.9), p99: quantileOf(s, 0.99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null };
}

// ---------------------------------------------------------------------------------------------
// Nguồn khung hình: cảnh tổng hợp (scene.js) hoặc camera sau
// ---------------------------------------------------------------------------------------------

async function faces() {
  const out = new Map();
  for (const sg of SIGNS) {
    const svg = signSvg(lookupSign(sg.code)?.art, { size: 256, value: sg.value });
    const img = new Image(256, 256);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const c = new OffscreenCanvas(256, 256);
    c.getContext('2d').drawImage(img, 0, 0);
    out.set(sg.label, c);
  }
  return out;
}

/** Cảnh tổng hợp 1920×1080: xe chạy lặp qua ba biển; next() → { bitmap, t }. */
export async function syntheticSource() {
  if (!S) throw new Error('thiếu scene.js');
  const canvas = new OffscreenCanvas(S.W, S.H);
  const scene = { signs: SIGNS.map((x) => ({ ...x, lat: S.LANE_W / 2 + S.SIGN_RIGHT, dir: 1, shape: x.family === 'triangle' ? 'triangle' : 'round' })), junction: { s: 700 }, seed: 7 };
  const r = S.createRenderer(canvas, scene, { faces: await faces() });
  let s = LOOP.from;
  return {
    kind: 'synthetic',
    width: S.W,
    height: S.H,
    async next() {
      s += SPEED / SOAK_FPS;
      if (s > LOOP.to) s = LOOP.from;
      r.draw({ s, lat: S.LANE_W / 2, dir: 1 });
      return { bitmap: await createImageBitmap(canvas), t: performance.now() };
    },
    close() {},
  };
}

/** Camera sau (chỉ gọi trong lần bấm của người dùng). */
export async function cameraSource() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
  });
  const track = stream.getVideoTracks()[0];
  const st = track.getSettings();
  let grab;
  if (typeof ImageCapture === 'function') {
    const ic = new ImageCapture(track);
    grab = () => ic.grabFrame();
  } else {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play();
    grab = () => createImageBitmap(v);
  }
  return {
    kind: 'camera',
    width: st.width || null,
    height: st.height || null,
    label: track.label || '',
    async next() {
      const bitmap = await grab();
      return { bitmap, t: performance.now() };
    },
    close() {
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tải nền giả lập (đo "khi máy đang bận")
// ---------------------------------------------------------------------------------------------

export function startLoad(duty = LOAD_DUTY) {
  const src = `let on=true;onmessage=()=>{on=false};(function spin(){if(!on)return;const t=performance.now();while(performance.now()-t<${Math.round(duty * 100)}){}setTimeout(spin,${Math.round((1 - duty) * 100)})})();`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return () => {
    w.postMessage('stop');
    w.terminate();
  };
}

// ---------------------------------------------------------------------------------------------
// Độ trễ
// ---------------------------------------------------------------------------------------------

async function loaded(build) {
  const v = new Vision();
  const t0 = performance.now();
  const info = await v.load({ build });
  return { v, loadMs: Math.round(performance.now() - t0), build: info?.build || v.build || build };
}

/**
 * Đo `frames` khung cho mỗi tổ hợp lượt quét với một bản dựng. → { build, source, width, height, loadMs,
 * passes: { A: {n,p50,p90,p99,max}, AB: {…} }, det, cls }
 */
export async function latency({ build = 'compat', frames = DEFAULT_FRAMES, source = null, onProgress = null, stop = () => false } = {}) {
  const src = source || (await syntheticSource());
  const { v, loadMs, build: used } = await loaded(build);
  const out = { build: used, source: src.kind, width: src.width, height: src.height, loadMs, passes: {}, det: {}, cls: {} };
  try {
    for (const [key, passes] of Object.entries(PASS_SETS)) {
      const total = [];
      const det = [];
      const cls = [];
      for (let i = 0; i < WARM_FRAMES + frames && !stop(); i++) {
        const f = await src.next();
        const r = await v.process(f, { passes });
        if (!r || i < WARM_FRAMES) continue;
        total.push(r.ms.total);
        det.push(r.ms.det);
        cls.push(r.ms.cls);
        onProgress?.({ build: used, key, done: total.length, frames });
      }
      out.passes[key] = summarize(total);
      out.det[key] = summarize(det);
      out.cls[key] = summarize(cls);
    }
  } finally {
    v.terminate();
    if (!source) src.close();
  }
  return out;
}

/**
 * Chạy dài ở nhịp SOAK_FPS (mức tải 2: lượt A mọi khung, thêm lượt B mỗi khung thứ hai). Mỗi phút gọi onTick({ minute,
 * p50, p90, fps, slower }) với slower = p50 phút này / p50 phút đầu (máy nóng lên thì tăng).
 */
export async function soak({ build = 'compat', minutes = SOAK_MINUTES, source = null, onTick = null, stop = () => false } = {}) {
  const src = source || (await syntheticSource());
  const { v, build: used } = await loaded(build);
  const rows = [];
  let first = null;
  let k = 0;
  try {
    const end = performance.now() + minutes * 60e3;
    while (performance.now() < end && !stop()) {
      const t0 = performance.now();
      const ms = [];
      while (performance.now() - t0 < SOAK_TICK_MS && performance.now() < end && !stop()) {
        const ts = performance.now();
        const f = await src.next();
        const r = await v.process(f, { passes: k++ % 2 ? ['A', 'B'] : ['A'] });
        if (r) ms.push(r.ms.total);
        const wait = 1000 / SOAK_FPS - (performance.now() - ts);
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      }
      const sum = summarize(ms);
      first = first ?? sum.p50;
      const row = { minute: rows.length + 1, ...sum, fps: Math.round((ms.length / ((performance.now() - t0) / 1000)) * 10) / 10, slower: first ? Math.round((sum.p50 / first) * 100) / 100 : null };
      rows.push(row);
      onTick?.(row);
    }
  } finally {
    v.terminate();
    if (!source) src.close();
  }
  return { build: used, rows };
}

// ---------------------------------------------------------------------------------------------
// So với vectơ mẫu
// ---------------------------------------------------------------------------------------------

async function pngTensor(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height * 3);
  for (let i = 0, j = 0; i < d.length; i += 4) {
    out[j++] = d[i] / 255;
    out[j++] = d[i + 1] / 255;
    out[j++] = d[i + 2] / 255;
  }
  return out;
}

const f32 = async (url) => new Float32Array(await (await fetch(url)).arrayBuffer());

/**
 * Chạy mọi trường hợp của models/golden/index.json qua bản dựng `build`, so từng đầu ra với tol của nó.
 * → { ok, build, cases, worst: { tên đầu ra: sai khác lớn nhất }, tol, failed: [{ model, case, output, diff, tol }] }
 */
export async function parity({ build = 'compat' } = {}) {
  const golden = new URL('models/golden/', ROOT);
  const idx = await (await fetch(new URL('index.json', golden))).json();
  const { v, build: used } = await loaded(build);
  const worst = {};
  const tol = {};
  const failed = [];
  let cases = 0;
  try {
    for (const model of ['det', 'cls']) {
      const m = idx.models[model];
      for (const [name, shape] of Object.entries(m.outputs)) tol[name] = m.tol[name];
      for (const [k, c] of m.cases.entries()) {
        const outs = await v.runTensor(model, await pngTensor(new URL(c.input, golden)));
        cases++;
        for (const [name, shape] of Object.entries(m.outputs)) {
          const want = await f32(new URL(c.outputs[name], golden));
          const got = outs.find((o) => o.shape.length === shape.length && o.shape.every((d, i) => d === shape[i]));
          let diff = Infinity;
          if (got && got.data.length === want.length) {
            diff = 0;
            for (let i = 0; i < want.length; i++) diff = Math.max(diff, Math.abs(want[i] - got.data[i]));
          }
          worst[name] = Math.max(worst[name] ?? 0, diff);
          if (!(diff <= m.tol[name])) failed.push({ model, case: k, output: name, diff, tol: m.tol[name] });
        }
      }
    }
  } finally {
    v.terminate();
  }
  return { ok: failed.length === 0, build: used, cases, worst, tol, failed };
}
