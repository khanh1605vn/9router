// Bộ nhận diện biển bằng camera, phía trang: tải mô hình và LiteRT.js khi người dùng bật tính năng, kiểm SHA-256 từng
// tệp với js/mlmanifest.js, chọn bản dựng wasm, chạy worker (js/vision-worker.js) và gửi khung hình sang, mỗi lần đúng
// một khung. Chỉ đo và báo thời gian xử lý; nhịp chạy (mấy khung mỗi giây, lượt quét nào) do js/camsched.js quyết định.
//
// Lỗi luôn là VisionError với `code`:
//   'unsupported' máy thiếu Worker, OffscreenCanvas, createImageBitmap, crypto.subtle hay WebAssembly SIMD128
//   'no-models'   chưa cài mô hình (tệp vắng mặt trong ML_MANIFEST): coi như tính năng không có
//   'integrity'   tệp tải về không khớp SHA-256 hay kích thước đã ghi (bản lưu hỏng hoặc bị sửa): từ chối chạy
//   'load'        không tải hay không khởi động được (mạng, tải treo, labels.json, mô hình sai hợp đồng, worker quá giờ)
//   'worker'      worker hỏng hoặc treo khi đang chạy, hoặc terminate() khi đang tải: gọi load() lại
//   'args'        tham số của process()/runTensor() sai (lượt quét lạ, bitmap đã đóng hay quá lớn…); worker vẫn
//                 chạy tốt, không cần tải lại

import './visionproto.js';
import { ML_MANIFEST } from './mlmanifest.js';

const P = globalThis.VisionProto;

export const VISION_ERROR_CODES = ['unsupported', 'no-models', 'integrity', 'load', 'worker', 'args'];
export const DEFAULT_PASSES = ['A', 'B'];
export const LITERT_IIFE = 'vendor/litert/litert.iife.min.js';
export const BUILD_FILES = {
  compat: { loader: 'vendor/litert/litert_wasm_compat_internal.js', wasm: 'vendor/litert/litert_wasm_compat_internal.wasm' },
  relaxed: { loader: 'vendor/litert/litert_wasm_internal.js', wasm: 'vendor/litert/litert_wasm_internal.wasm' },
};
export const MODEL_FILES = {
  labels: 'models/labels.json',
  det: 'models/sign-det.int8.tflite',
  cls: 'models/sign-cls.int8.tflite',
};
const LOAD_TIMEOUT = 60e3; // worker phải dịch xong wasm và hai mô hình trong chừng này (ms)
// Một tệp đang tải mà chừng này (ms) không nhận thêm byte nào thì coi là treo: huỷ cả lần tải ('load'). Không đặt hạn
// cho cả lần tải vì 22 MB qua mạng di động chậm có thể mất vài phút mà vẫn đang chạy tốt.
const LOAD_IDLE = 30e3;
// Một khung hình chưa xong sau chừng này (ms) thì coi worker đã treo. Máy chậm nhất dự kiến ~100 ms mỗi khung.
const FRAME_TIMEOUT = 10e3;
const STATS_WINDOW = 60; // số khung gần nhất dùng cho trung vị, p90 và số khung mỗi giây
const HASH_QUERY = 16; // số ký tự SHA-256 gắn vào URL (?v=…) để bản lưu cũ trong cache không che bản mới
export const VISION_LIMITS = Object.freeze({ LOAD_TIMEOUT, LOAD_IDLE, FRAME_TIMEOUT, STATS_WINDOW, HASH_QUERY });

// Mô-đun wasm nhỏ nhất dùng lệnh v128 (SIMD128), và một mô-đun dùng i8x16.relaxed_swizzle (relaxed SIMD).
// Chỉ đưa vào WebAssembly.validate, không chạy.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 11,
]);
const RELAXED_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 43, 1, 41, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 128, 2, 11,
]);
export const WASM_PROBES = { simd: SIMD_PROBE, relaxed: RELAXED_PROBE };

export class VisionError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'VisionError';
    this.code = code;
  }
}

function validates(WA, bytes) {
  try {
    return !!WA && typeof WA.validate === 'function' && WA.validate(bytes);
  } catch {
    return false;
  }
}

/** Tính năng WebAssembly của trình duyệt: { wasm, simd, relaxed }. */
export function wasmFeatures(WA = globalThis.WebAssembly) {
  const wasm = !!WA && typeof WA.validate === 'function';
  const simd = wasm && validates(WA, SIMD_PROBE);
  return { wasm, simd, relaxed: simd && validates(WA, RELAXED_PROBE) };
}

/**
 * Máy có chạy được bộ nhận diện không (không xét camera: xem cameraSupport trong js/camera.js).
 * Trả { ok, reason: null|'no-worker'|'no-offscreen'|'no-bitmap'|'insecure'|'no-wasm'|'no-simd', simd, relaxed }.
 * LiteRT.js không có bản dựng nào chạy được khi thiếu SIMD128.
 */
export function visionSupport(env = globalThis) {
  const f = wasmFeatures(env.WebAssembly || null);
  let reason = null;
  if (typeof env.Worker !== 'function') reason = 'no-worker';
  else if (typeof env.OffscreenCanvas !== 'function') reason = 'no-offscreen';
  else if (typeof env.createImageBitmap !== 'function') reason = 'no-bitmap';
  else if (!env.crypto || !env.crypto.subtle) reason = 'insecure'; // crypto.subtle chỉ có trên HTTPS hoặc localhost
  else if (!f.wasm) reason = 'no-wasm';
  else if (!f.simd) reason = 'no-simd';
  return { ok: !reason, reason, simd: f.simd, relaxed: f.relaxed };
}

/** 'auto' → 'relaxed' nếu trình duyệt có relaxed SIMD, không thì 'compat'. Thiếu tính năng cần thiết: 'unsupported'. */
export function chooseBuild(requested, feats) {
  if (!feats || !feats.simd) throw new VisionError('unsupported', 'no-simd');
  if (requested === 'compat') return 'compat';
  if (requested === 'relaxed') {
    if (!feats.relaxed) throw new VisionError('unsupported', 'no-relaxed-simd');
    return 'relaxed';
  }
  if (requested == null || requested === 'auto') return feats.relaxed ? 'relaxed' : 'compat';
  throw new VisionError('load', `build ${requested}`);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Các tệp cần cho một bản dựng, lấy từ manifest: { ok, files: { iife, loader, wasm, labels, det, cls: { path, sha256,
 * size } }, missing: [đường dẫn] }. Thiếu tệp (hoặc mục hỏng) nghĩa là tính năng chưa được cài.
 */
export function planFiles(manifest, build) {
  const want = { iife: LITERT_IIFE, ...BUILD_FILES[build], ...MODEL_FILES };
  const files = {};
  const missing = [];
  const list = manifest && typeof manifest === 'object' ? manifest.files : null;
  for (const [key, path] of Object.entries(want)) {
    const e = list && Object.hasOwn(list, path) ? list[path] : null;
    if (!e || typeof e.sha256 !== 'string' || !HEX64.test(e.sha256) || !Number.isInteger(e.size) || e.size < 1 || e.size > P.MAX_FILE_BYTES) {
      missing.push(path);
      continue;
    }
    files[key] = { path, sha256: e.sha256, size: e.size };
  }
  return { ok: missing.length === 0, files, missing };
}

export function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

const subtleDigest = (buf) => globalThis.crypto.subtle.digest('SHA-256', buf);

/** Kiểm kích thước và SHA-256 của một tệp đã tải; sai thì ném VisionError('integrity'). `digest` trả ArrayBuffer. */
export async function verifyBytes(buf, entry, digest = subtleDigest) {
  if (!buf || buf.byteLength !== entry.size) throw new VisionError('integrity', `${entry.path}: size`);
  const hex = toHex(await digest(buf));
  if (hex !== entry.sha256) throw new VisionError('integrity', `${entry.path}: sha256`);
  return true;
}

const asLoadError = (path, err) =>
  err instanceof VisionError ? err : new VisionError('load', `${path}: ${err && err.message ? err.message : err}`);

/**
 * Canh một tệp đang tải: race(p) thua ngay khi `signal` bị huỷ (lý do của signal, hoặc 'load') hay khi quá `idleMs`
 * không có byte mới (kick() sau mỗi phần nhận được); done() gỡ hẹn giờ và trình nghe.
 */
function watchdog(signal, idleMs, path) {
  let timer = null;
  let fail = null;
  const lost = new Promise((_, reject) => {
    fail = reject;
  });
  lost.catch(() => {}); // chỉ dùng trong Promise.race; không để thành lỗi "chưa xử lý" khi không ai còn chờ
  const onAbort = () => fail(signal.reason instanceof VisionError ? signal.reason : new VisionError('load', `${path}: aborted`));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new VisionError('load', `${path}: stalled`)), idleMs);
  };
  kick();
  return {
    race: (p) => Promise.race([p, lost]),
    kick,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Tải một tệp, báo tiến độ theo từng phần; không đọc quá kích thước đã ghi trong manifest. `signal` huỷ việc tải
 * (terminate() hay một tệp khác hỏng); quá `idleMs` không có byte mới thì thua với VisionError('load', '…: stalled').
 */
async function fetchBytes(fetchFn, url, entry, onChunk, { signal = null, idleMs = LOAD_IDLE } = {}) {
  const dog = watchdog(signal, idleMs, entry.path);
  let rd = null;
  try {
    let res;
    try {
      res = await dog.race(Promise.resolve().then(() => fetchFn(url, signal ? { credentials: 'same-origin', signal } : { credentials: 'same-origin' })));
    } catch (err) {
      throw asLoadError(entry.path, err);
    }
    if (!res || !res.ok) throw new VisionError('load', `${entry.path}: HTTP ${res ? res.status : '?'}`);
    dog.kick();
    const out = new Uint8Array(entry.size);
    let n = 0;
    const take = (chunk) => {
      if (n + chunk.length > entry.size) throw new VisionError('integrity', `${entry.path}: size`);
      out.set(chunk, n);
      n += chunk.length;
      dog.kick();
      onChunk(chunk.length);
    };
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        rd = res.body.getReader();
        for (;;) {
          const { done, value } = await dog.race(rd.read());
          if (done) break;
          take(value);
        }
        rd = null;
      } else {
        take(new Uint8Array(await dog.race(res.arrayBuffer())));
      }
    } catch (err) {
      throw asLoadError(entry.path, err);
    }
    if (n !== entry.size) throw new VisionError('integrity', `${entry.path}: size`);
    return out.buffer;
  } finally {
    dog.done();
    if (rd) {
      try {
        rd.cancel().catch(() => {});
      } catch {
        // đã huỷ
      }
    }
  }
}

/** Phân vị q (0–1) của một dãy đã sắp tăng dần, nội suy tuyến tính giữa hai phần tử kề. */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const rtt = rows.map((r) => r.rtt).sort((a, b) => a - b);
  const span = rows.length > 1 ? rows[rows.length - 1].at - rows[0].at : 0;
  return {
    n: rows.length,
    median: quantile(ms, 0.5),
    p90: quantile(ms, 0.9),
    rtt: quantile(rtt, 0.5),
    fps: span > 0 ? ((rows.length - 1) * 1000) / span : 0,
  };
}

/**
 * Thống kê trượt của các khung đã xử lý: thời gian trong worker (ms.total), thời gian khứ hồi, số khung mỗi giây,
 * gộp chung và theo tổ hợp lượt quét ('A', 'B', 'AB').
 */
export class RollingStats {
  constructor(size = STATS_WINDOW) {
    this.size = size;
    this.rows = [];
  }

  add(ms, rtt, at, key) {
    this.rows.push({ ms, rtt, at, key });
    if (this.rows.length > this.size) this.rows.shift();
  }

  summary() {
    const out = summarise(this.rows);
    out.byPasses = {};
    for (const key of [...new Set(this.rows.map((r) => r.key))].sort()) {
      const s = summarise(this.rows.filter((r) => r.key === key));
      out.byPasses[key] = { n: s.n, median: s.median, p90: s.p90 };
    }
    return out;
  }

  reset() {
    this.rows = [];
  }
}

function closeQuietly(bitmap) {
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    // đã đóng
  }
}

const finiteRect = (h) =>
  h && Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.w) && Number.isFinite(h.h) && h.w > 0 && h.h > 0;

/**
 * Gợi ý chỉ để xếp thứ tự cho bộ phân loại, nên không bao giờ làm hỏng một khung: gợi ý hỏng bị bỏ, phần nằm ngoài
 * khung hình W×H bị cắt đi (dự đoán của vệt theo dõi có thể trượt ra ngoài hay to quá cỡ), tối đa MAX_HINTS.
 */
export function clipHints(hints, W, H) {
  if (!Array.isArray(hints)) return [];
  const out = [];
  for (const h of hints) {
    if (out.length >= P.MAX_HINTS) break;
    if (!finiteRect(h)) continue;
    const x0 = Math.max(0, h.x);
    const y0 = Math.max(0, h.y);
    const x1 = Math.min(W, h.x + h.w);
    const y1 = Math.min(H, h.y + h.h);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

export class Vision {
  /**
   * Mọi phụ thuộc bên ngoài có thể thay khi kiểm thử: createWorker(url), fetch, digest(buf) → ArrayBuffer SHA-256,
   * now() (ms, đồng hồ đơn điệu), support() (như visionSupport), workerUrl, location ({ href, origin } của trang;
   * mặc định globalThis.location), frameTimeout, loadTimeout, idleTimeout (ms), statsWindow.
   */
  constructor(deps = {}) {
    this._createWorker = deps.createWorker || ((url) => new Worker(url, { name: 'ban-duong-vision' }));
    this._fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this._digest = deps.digest || subtleDigest;
    this._now = deps.now || (() => performance.now());
    this._support = deps.support || (() => visionSupport());
    this._workerUrl = deps.workerUrl || new URL('./vision-worker.js', import.meta.url);
    this._frameTimeout = deps.frameTimeout || FRAME_TIMEOUT;
    this._loadTimeout = deps.loadTimeout || LOAD_TIMEOUT;
    this._idleTimeout = deps.idleTimeout || LOAD_IDLE;
    this._location = deps.location !== undefined ? deps.location : globalThis.location || null;
    this._stats = new RollingStats(deps.statsWindow || STATS_WINDOW);
    this._state = 'idle'; // 'loading' | 'ready' | 'failed' | 'terminated'
    this._worker = null;
    this._inflight = null;
    this._initWait = null;
    this._countsWait = [];
    this._id = 0;
    this._loading = null;
    this._abort = null; // AbortController của lần tải đang chạy
    this._gen = 0; // tăng mỗi lần load() mới và mỗi lần terminate(): việc của lần tải cũ không được đụng tới trạng thái
    /** Mức tải hiện tại (0 tạm dừng … 3), do bộ lập lịch đặt; Vision chỉ giữ giá trị. */
    this.level = 2;
    this.build = null;
    this.labels = null;
  }

  get ready() {
    return this._state === 'ready';
  }

  /**
   * Tải và kiểm mọi tệp rồi khởi động worker. onProgress({ loaded, total, file }) tính theo byte.
   * base: thư mục gốc của ứng dụng (mặc định thư mục cha của js/); phải cùng nguồn gốc với trang.
   * manifest: mặc định ML_MANIFEST (kiểm thử có thể đưa bản khác vào đây).
   * Trả { build, labels } (số nhãn). Gọi lại khi đang tải thì nhận cùng promise; khi đã sẵn sàng thì xong ngay; sau
   * lỗi hay terminate() thì tải lại từ đầu. Một tệp hỏng hay treo (LOAD_IDLE) huỷ mọi tệp còn đang tải.
   */
  load(opts = {}) {
    if (this._state === 'ready') return Promise.resolve({ build: this.build, labels: this.labels.length });
    if (this._loading) return this._loading;
    const gen = ++this._gen;
    const current = () => this._gen === gen;
    const ac = new AbortController();
    this._abort = ac;
    this._state = 'loading';
    const p = this._load(opts, ac.signal, current).then(
      (r) => {
        if (!current()) throw new VisionError('worker', 'terminated');
        this._loading = null;
        this._abort = null;
        this._state = 'ready';
        return r;
      },
      (err) => {
        const e = err instanceof VisionError ? err : new VisionError('load', String((err && err.message) || err));
        ac.abort(e); // một tệp hỏng: dừng ngay các tệp còn đang tải
        if (!current()) throw new VisionError('worker', 'terminated');
        this._loading = null;
        this._abort = null;
        this._state = 'failed';
        this._killWorker();
        throw e;
      }
    );
    this._loading = p;
    return p;
  }

  async _load({ onProgress = null, base = null, manifest = ML_MANIFEST, build = 'auto' } = {}, signal, current) {
    const sup = this._support();
    if (!sup || !sup.ok) throw new VisionError('unsupported', sup ? sup.reason : null);
    const chosen = chooseBuild(build, sup);
    const plan = planFiles(manifest, chosen);
    if (!plan.ok) throw new VisionError('no-models', plan.missing.join(', '));
    const loc = this._location;
    let baseUrl;
    try {
      baseUrl = new URL(base || new URL('../', import.meta.url).href, loc ? loc.href : undefined);
    } catch {
      throw new VisionError('load', 'bad base');
    }
    // Mô hình và wasm chỉ được tải từ chính nguồn gốc của ứng dụng (PLAN §7).
    if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') throw new VisionError('load', 'bad base');
    if (loc && baseUrl.origin !== loc.origin) throw new VisionError('load', 'cross-origin base');

    const entries = Object.entries(plan.files);
    const total = entries.reduce((s, [, e]) => s + e.size, 0);
    let loaded = 0;
    const report = (file) => {
      if (!onProgress) return;
      try {
        onProgress({ loaded, total, file });
      } catch {
        // lỗi ở hàm báo tiến độ không được làm hỏng việc tải
      }
    };
    report(null);
    const bytes = {};
    await Promise.all(
      entries.map(async ([key, e]) => {
        const url = new URL(`${e.path}?v=${e.sha256.slice(0, HASH_QUERY)}`, baseUrl).href;
        const buf = await fetchBytes(
          this._fetch,
          url,
          e,
          (n) => {
            loaded += n;
            report(e.path);
          },
          { signal, idleMs: this._idleTimeout }
        );
        await verifyBytes(buf, e, this._digest);
        bytes[key] = buf;
      })
    );
    if (!current()) throw new VisionError('worker', 'terminated');

    let labels;
    try {
      labels = JSON.parse(new TextDecoder().decode(bytes.labels));
    } catch {
      throw new VisionError('load', 'labels.json');
    }
    const lab = P.checkLabels(labels);
    if (!lab.ok) throw new VisionError('load', `labels.json: ${lab.reason}`);

    const files = {};
    const sha256 = {};
    for (const k of P.INIT_FILES) {
      files[k] = bytes[k];
      sha256[k] = plan.files[k].sha256;
    }
    const w = this._createWorker(this._workerUrl);
    this._worker = w;
    w.onmessage = (ev) => this._onMessage(ev.data);
    w.onerror = (ev) => this._onWorkerError(ev && ev.message ? ev.message : 'error');
    w.onmessageerror = () => this._onWorkerError('messageerror');
    let wait = null;
    const ready = new Promise((resolve, reject) => {
      wait = { resolve, reject, timer: setTimeout(() => reject(new VisionError('load', 'timeout')), this._loadTimeout) };
    });
    this._initWait = wait;
    w.postMessage({ type: 'init', base: baseUrl.href, build: chosen, files, sha256, labels }, P.INIT_FILES.map((k) => files[k]));
    let msg;
    try {
      msg = await ready;
    } finally {
      clearTimeout(wait.timer);
      if (this._initWait === wait) this._initWait = null;
    }
    if (!current()) throw new VisionError('worker', 'terminated');
    this.build = msg.build;
    this.labels = lab.names;
    this._stats.reset();
    return { build: msg.build, labels: msg.labels };
  }

  /**
   * Gửi một khung hình (ImageBitmap, hoặc { bitmap, t } như CameraService.grab() trả) sang worker.
   * passes: ['A'], ['B'] hoặc ['A','B']; foe: điểm tụ { x, y } theo px khung (mặc định giữa, 42 % chiều cao);
   * hints: khung dự đoán của các vệt đang theo dõi, được phân loại trước.
   * Mỗi lúc chỉ một khung: đang bận thì đóng bitmap và trả null. Kết quả { t, ms, lum, boxes } (xem VisionProto).
   * Gợi ý hỏng hay nằm ngoài khung không làm hỏng khung (xem clipHints); tham số khác sai → VisionError('args').
   * evalCrops: true (chỉ khi người dùng bật camEval) thì kết quả có thêm crops: [{ i, blob (PNG), w, h }], ảnh cắt sát
   * của từng khung đã phân loại boxes[i] (xem VisionProto.evalCropRect). Không bật thì kết quả không có trường này.
   * Bitmap luôn được đóng (ở worker, hoặc ở đây nếu không gửi đi được).
   */
  process(frame, { passes = DEFAULT_PASSES, foe = null, hints = null, evalCrops = false } = {}) {
    const wrapped = frame && typeof frame === 'object' && 'bitmap' in frame;
    const bitmap = wrapped ? frame.bitmap : frame;
    if (this._inflight) {
      closeQuietly(bitmap);
      return Promise.resolve(null);
    }
    if (this._state !== 'ready') {
      closeQuietly(bitmap);
      const code = this._state === 'idle' || this._state === 'loading' ? 'load' : 'worker';
      return Promise.reject(new VisionError(code, 'not ready'));
    }
    const t = wrapped && Number.isFinite(frame.t) ? frame.t : this._now();
    const W = bitmap && bitmap.width;
    const H = bitmap && bitmap.height;
    const f =
      foe && Number.isFinite(foe.x) && Number.isFinite(foe.y)
        ? { x: Math.min(W, Math.max(0, foe.x)), y: Math.min(H, Math.max(0, foe.y)) }
        : P.defaultFoe(W, H);
    this._id = this._id >= P.MAX_ID ? 1 : this._id + 1;
    const msg = { type: 'frame', id: this._id, t, bitmap, passes: Array.isArray(passes) ? passes.slice() : passes, foe: f };
    if (Array.isArray(hints) && hints.length) {
      const kept = clipHints(hints, W, H);
      if (kept.length) msg.hints = kept;
    }
    if (evalCrops === true) msg.evalCrops = true;
    const v = P.checkFrame(msg);
    if (!v.ok) {
      closeQuietly(bitmap);
      return Promise.reject(new VisionError('args', `bad frame: ${v.reason}`));
    }
    return new Promise((resolve, reject) => {
      const job = { id: msg.id, resolve, reject, sent: this._now(), key: msg.passes.join(''), evalCrops: msg.evalCrops === true };
      job.timer = setTimeout(() => this._stuck(job), this._frameTimeout);
      this._inflight = job;
      try {
        this._worker.postMessage(msg, [bitmap]);
      } catch (err) {
        clearTimeout(job.timer);
        this._inflight = null;
        closeQuietly(bitmap);
        reject(new VisionError('worker', String((err && err.message) || err)));
      }
    });
  }

  /**
   * Chạy thẳng một tensor (Float32Array, lô 1, đúng kích thước đầu vào) qua mô hình 'det' hoặc 'cls'; trả
   * [{ shape, data }] theo thứ tự đầu ra của mô hình. Dùng để so với vectơ mẫu khi kiểm thử. Đang bận thì trả null.
   */
  runTensor(model, input) {
    if (this._inflight) return Promise.resolve(null);
    if (this._state !== 'ready') return Promise.reject(new VisionError('worker', 'not ready'));
    this._id = this._id >= P.MAX_ID ? 1 : this._id + 1;
    const msg = { type: 'run', id: this._id, model, input: input instanceof Float32Array ? Float32Array.from(input) : input };
    const v = P.checkRun(msg);
    if (!v.ok) return Promise.reject(new VisionError('args', `bad tensor: ${v.reason}`));
    return new Promise((resolve, reject) => {
      const job = { id: msg.id, resolve, reject, sent: this._now(), key: null };
      job.timer = setTimeout(() => this._stuck(job), this._frameTimeout);
      this._inflight = job;
      this._worker.postMessage(msg, [msg.input.buffer]);
    });
  }

  /** { n, median, p90, rtt, fps, byPasses: { A|B|AB: { n, median, p90 } }, build, level } (ms trong worker). */
  stats() {
    return { ...this._stats.summary(), build: this.build, level: this.level };
  }

  /** Số khung worker đã nhận và đã đóng (để kiểm thử rằng không giữ khung nào). */
  bitmapCounts() {
    if (!this._worker || this._state === 'terminated') return Promise.resolve(null);
    return new Promise((resolve) => {
      this._countsWait.push(resolve);
      this._worker.postMessage({ type: 'stats' });
    });
  }

  /** Dừng hẳn: huỷ lần tải đang chạy (promise của nó thua với 'worker'), bỏ khung đang chạy (null), dừng worker.
   *  Gọi load() sau đó thì tải lại từ đầu. */
  terminate() {
    this._gen++;
    this._state = 'terminated';
    this._loading = null;
    if (this._abort) {
      this._abort.abort(new VisionError('worker', 'terminated'));
      this._abort = null;
    }
    if (this._initWait) {
      clearTimeout(this._initWait.timer);
      this._initWait.reject(new VisionError('worker', 'terminated'));
      this._initWait = null;
    }
    this._finish(null);
    this._killWorker();
  }

  _killWorker() {
    if (this._worker) {
      this._worker.onmessage = this._worker.onerror = this._worker.onmessageerror = null;
      try {
        this._worker.terminate();
      } catch {
        // đã dừng
      }
    }
    this._worker = null;
    for (const r of this._countsWait.splice(0)) r(null);
  }

  /** Kết thúc khung đang chạy: value là kết quả, null (bỏ) hoặc một VisionError. */
  _finish(value) {
    const job = this._inflight;
    if (!job) return;
    this._inflight = null;
    clearTimeout(job.timer);
    if (value instanceof VisionError) job.reject(value);
    else job.resolve(value);
  }

  _stuck(job) {
    if (this._inflight !== job) return;
    this._finish(new VisionError('worker', 'timeout'));
    this._state = 'failed';
    this._killWorker();
  }

  _fatal(code, reason) {
    const err = new VisionError(code, reason);
    if (this._initWait) {
      this._initWait.reject(err);
      return;
    }
    if (this._state === 'ready') this._state = 'failed';
    this._finish(err.code === 'worker' ? err : new VisionError('worker', reason));
    this._killWorker();
  }

  _onWorkerError(reason) {
    this._fatal(this._initWait ? 'load' : 'worker', reason);
  }

  _onMessage(m) {
    const v = P.checkResponse(m);
    if (!v.ok) {
      if (!v.ignore) this._fatal(this._initWait ? 'load' : 'worker', `bad response: ${v.reason}`);
      return;
    }
    if (m.type === 'ready') {
      if (this._initWait) this._initWait.resolve(m);
      return;
    }
    if (m.type === 'stats') {
      const r = this._countsWait.shift();
      if (r) r({ frames: m.frames, closed: m.closed });
      return;
    }
    if (m.type === 'error') {
      if (this._initWait) {
        this._initWait.reject(new VisionError(m.code, m.reason));
        return;
      }
      if (this._inflight && m.id === this._inflight.id) this._finish(new VisionError(m.code, m.reason));
      return;
    }
    const job = this._inflight;
    if (!job || m.id !== job.id) return;
    if (m.type === 'outputs') {
      this._finish(m.outputs);
      return;
    }
    // result
    const at = this._now();
    this._stats.add(m.ms.total, at - job.sent, at, job.key);
    const out = { t: m.t, ms: m.ms, lum: m.lum, boxes: m.boxes };
    // Ảnh cắt chỉ đi tiếp khi chính khung này yêu cầu (camEval bật); không thì bỏ, không giữ lại.
    if (job.evalCrops && Array.isArray(m.crops)) out.crops = m.crops;
    this._finish(out);
  }
}
