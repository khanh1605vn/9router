// Bộ điều phối camera nhận diện biển (js/camctl.js): quy tắc an toàn (chỉ khi đỗ, không tự hỏi quyền), vòng lấy khung
// (đúng một khung, đọc cỡ khung trước khi chuyển), vòng đời ẩn/hiện, khi không có mô hình, và các văn bản tiếng Việt.
// Camera thật là CameraService (js/camera.js) chạy trên navigator/document giả; bộ nhận diện là bản giả.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { DEFAULT_SETTINGS } from '../js/store.js';
import { CAMERA_ERROR_CODES, CAMERA_ERROR_TEXT, SUPPORT_TEXT } from '../js/camera.js';
import { VISION_ERROR_CODES, VISION_LIMITS } from '../js/vision.js';
import { dayNumber, memoryBackend } from '../js/learnedsigns.js';
import { memoryBackend as evalMemoryBackend } from '../js/evalcrops.js';
import { PARK_STILL_MS, PARK_RECENT_MS, FAST_P90_MS, IDLE_RELEASE_MS } from '../js/camsched.js';
import {
  CameraController,
  CHECK_FRAMES,
  CHECK_FRAMES_MAX,
  CHECK_GRAB_FAILS,
  EVAL_EXPIRE_MS,
  EXPORT_WARNING,
  GRAB_RETRY_MS,
  importText,
  LABELS_PATH,
  learnedCaption,
  PAUSE_POLL_MS,
  PROGRESS_STEP,
  RANGE_STEP_M,
  rangeText,
  readRange,
  stateText,
  TEXT,
  VISION_FATAL,
  VISION_RETRY_MS,
  VISION_STABLE_FRAMES,
  VISION_TEXT,
} from '../js/camctl.js';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------------------------------------------
// labels.json và manifest giả (mô hình chỉ có tên và mã băm giả: bộ nhận diện là bản giả)

const LABELS = buildLabels(SIGN_CATALOGUE);
const LABEL_BYTES = new TextEncoder().encode(JSON.stringify(LABELS));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const FAKE_HASH = 'a'.repeat(64);
const RUNTIME = [
  'vendor/litert/litert.iife.min.js',
  'vendor/litert/litert_wasm_compat_internal.js',
  'vendor/litert/litert_wasm_compat_internal.wasm',
  'vendor/litert/litert_wasm_internal.js',
  'vendor/litert/litert_wasm_internal.wasm',
];
const MODELS = ['models/sign-det.int8.tflite', 'models/sign-cls.int8.tflite'];

function manifest({ models = true, labelHash = sha(LABEL_BYTES) } = {}) {
  const files = { [LABELS_PATH]: { sha256: labelHash, size: LABEL_BYTES.byteLength } };
  for (const p of [...RUNTIME, ...(models ? MODELS : [])]) files[p] = { sha256: FAKE_HASH, size: 1000 };
  return { version: 1, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Môi trường giả

class FakeTrack extends EventTarget {
  constructor(deviceId = 'cam-back') {
    super();
    this.kind = 'video';
    this.label = 'camera 0, facing back';
    this.readyState = 'live';
    this.muted = false;
    this.deviceId = deviceId;
  }

  stop() {
    this.readyState = 'ended';
  }

  getSettings() {
    return { width: 1920, height: 1080, frameRate: 15, deviceId: this.deviceId };
  }

  getCapabilities() {
    return {};
  }

  applyConstraints() {
    return Promise.resolve();
  }
}

class FakeStream {
  constructor(track) {
    this.track = track;
  }

  getTracks() {
    return [this.track];
  }

  getVideoTracks() {
    return [this.track];
  }
}

class FakeBitmap {
  constructor(width = 1920, height = 1080) {
    this.width = width;
    this.height = height;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

class FakeDoc extends EventTarget {
  constructor() {
    super();
    this.visibilityState = 'visible';
  }

  hide() {
    this.visibilityState = 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }

  show() {
    this.visibilityState = 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** Bộ nhận diện giả: process() "chuyển" bitmap (cỡ về 0×0, đóng) như postMessage thật. */
class FakeVision {
  constructor() {
    this.ready = false;
    this.level = 2;
    this.loads = 0;
    this.terminated = 0;
    this.calls = [];
    this.inflight = 0;
    this.maxInflight = 0;
    this.manual = false; // true: khung chỉ xong khi gọi finish()
    this.waiting = [];
    this.ms = 7;
    this.loadImpl = null;
    this.processImpl = null;
  }

  load() {
    this.loads++;
    if (this.loadImpl) return this.loadImpl(this);
    this.ready = true;
    return Promise.resolve({ build: 'compat', labels: LABELS.labels.length });
  }

  process(frame, opts) {
    const bm = frame.bitmap;
    this.calls.push({ width: bm.width, height: bm.height, opts, t: frame.t });
    bm.width = 0; // đã chuyển sang worker
    bm.height = 0;
    bm.close();
    if (this.processImpl) return this.processImpl(frame, opts);
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const result = { t: frame.t, ms: { pre: 1, det: 5, cls: 1, total: this.ms }, lum: { mean: 120, std: 40 }, boxes: [] };
    return new Promise((resolve) => {
      const done = () => {
        this.inflight--;
        resolve(result);
      };
      if (this.manual) this.waiting.push(done);
      else setImmediate(done);
    });
  }

  finish() {
    const w = this.waiting.splice(0);
    for (const d of w) d();
  }

  terminate() {
    this.terminated++;
    this.ready = false;
  }
}

function makeEnv({ perm = 'granted', mode = 'drive', settings = {}, models = true, labelHash, support = { ok: true, reason: null }, vision = null, cameraFactory = null, visionFactory, evalBackend = evalMemoryBackend() } = {}) {
  const env = { perm, mode, stationary: null, timers: [], clock: { t: 1000 }, logs: [], tracks: [], grabs: 0 };
  let timerId = 0;
  env.setTimeout = (fn, ms) => {
    const id = ++timerId;
    env.timers.push({ id, fn, at: env.clock.t + Math.max(0, ms || 0) });
    return id;
  };
  env.clearTimeout = (id) => {
    env.timers = env.timers.filter((t) => t.id !== id);
  };
  /** Cho đồng hồ chạy thêm ms, chạy các hẹn giờ đến hạn theo thứ tự. */
  env.advance = async (ms) => {
    const end = env.clock.t + ms;
    for (;;) {
      await settle();
      env.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = env.timers[0];
      if (!next || next.at > end) break;
      env.timers.shift();
      env.clock.t = Math.max(env.clock.t, next.at);
      next.fn();
    }
    env.clock.t = end;
    await settle();
  };

  const md = new EventTarget();
  md.calls = [];
  md.enumerateDevices = () =>
    Promise.resolve([
      { kind: 'videoinput', deviceId: 'cam-back', label: 'camera 0, facing back' },
      { kind: 'videoinput', deviceId: 'usb-1', label: 'USB camera' },
    ]);
  md.getUserMedia = (c) => {
    md.calls.push(c);
    const track = new FakeTrack(c.video.deviceId?.exact || 'cam-back');
    env.tracks.push(track);
    return Promise.resolve(new FakeStream(track));
  };
  env.md = md;
  env.nav = {
    mediaDevices: md,
    permissions: {
      query: async () => {
        if (env.perm === 'throws') throw new TypeError('no');
        return { state: env.perm };
      },
    },
  };
  env.ImageCapture = class {
    constructor(track) {
      this.track = track;
    }

    grabFrame() {
      env.grabs++;
      return Promise.resolve(new FakeBitmap(1920, 1080));
    }
  };
  env.doc = new FakeDoc();
  env.win = new EventTarget(); // window: sự kiện 'online'
  const values = { ...DEFAULT_SETTINGS, ...settings };
  const listeners = new Set();
  env.store = {
    settings: values,
    sets: [],
    set(k, v) {
      values[k] = v;
      this.sets.push([k, v]);
      for (const fn of listeners) fn('settings');
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  env.vision = vision || new FakeVision();
  env.fetches = [];
  env.ctl = new CameraController({
    store: env.store,
    roads: null,
    signs: { lastCorridor: null, lastCorridorTime: null },
    getMode: () => env.mode,
    carStationary: () => env.stationary,
    carSpeed: () => env.carKmh ?? null,
    isSimulated: () => env.simulate === true,
    document: env.doc,
    window: env.win,
    navigator: env.nav,
    ImageCapture: env.ImageCapture,
    createImageBitmap: null,
    fetch: async (url, opts) => {
      env.fetches.push(url);
      if (env.fetchImpl) return env.fetchImpl(url, opts);
      return new Response(LABEL_BYTES.slice(), { status: 200 });
    },
    manifest: manifest({ models, labelHash }),
    base: 'https://app.test/',
    now: () => 1_763_900_000_000 + env.clock.t,
    mono: () => env.clock.t,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    learnedBackend: memoryBackend(),
    evalBackend,
    support: () => support,
    cameraFactory,
    visionFactory: visionFactory === undefined ? () => env.vision : visionFactory,
    log: (...a) => env.logs.push(a),
  });
  env.fix = (speed = 10, extra = {}) => {
    env.ctl.onFix({ coord: [105.85, 21.03], speed, heading: 90, accuracy: 5, time: 1_763_900_000_000 + env.clock.t, ...extra });
  };
  env.live = () => env.tracks.filter((t) => t.readyState === 'live').length;
  return env;
}

/** Đỗ đủ lâu (không ở chế độ lái, đứng yên quá PARK_STILL_MS). */
async function park(env) {
  env.mode = 'browse';
  env.stationary = true;
  env.ctl.tick();
  await env.advance(PARK_STILL_MS + 10);
  env.ctl.tick();
}

// ---------------------------------------------------------------------------------------------------------------
// Hằng số và hàm thuần

test('hằng số: giá trị đã định', () => {
  assert.equal(LABELS_PATH, 'models/labels.json');
  assert.equal(CHECK_FRAMES, 30);
  assert.equal(CHECK_FRAMES_MAX, 200);
  assert.equal(CHECK_GRAB_FAILS, 20);
  assert.equal(GRAB_RETRY_MS, 100);
  assert.equal(PAUSE_POLL_MS, 5000);
  assert.deepEqual([...VISION_RETRY_MS], [3000, 15000, 60000]);
  assert.ok(Object.isFrozen(VISION_RETRY_MS));
  assert.deepEqual([...VISION_FATAL], ['unsupported', 'no-models', 'integrity']);
  assert.equal(RANGE_STEP_M, 5);
  assert.equal(PROGRESS_STEP, 0.01);
});

test('readRange: biển 0,7 m rộng 20 px, góc nhìn 70° theo cạnh dài, làm tròn xuống 5 m', () => {
  assert.equal(readRange(1920, 1080), 45); // tiêu cự 1371 px → 48 m
  assert.equal(readRange(1080, 1920), 45); // cầm dọc: cùng tiêu cự
  assert.equal(readRange(1280, 720), 30); // 914 px → 32 m
  assert.equal(readRange(640, 360), 15);
  assert.equal(readRange(0, 0), null);
  assert.equal(readRange(null, undefined), null);
  assert.equal(rangeText(45), 'Đọc được biển cỡ thường từ khoảng 45 m (ước tính).');
  assert.equal(rangeText(null), null);
});

test('learnedCaption: chỉ biển đã học chưa xác nhận mới có chú thích', () => {
  assert.equal(learnedCaption({ key: 'x' }), null); // biển bản đồ
  assert.equal(learnedCaption({ src: 'camera', quiet: false, meta: { hitDays: 3 } }), null);
  assert.equal(learnedCaption({ src: 'camera', quiet: true, meta: { hitDays: 1 } }), 'Camera mới thấy, chưa xác nhận');
  assert.equal(learnedCaption({ src: 'camera', quiet: true, meta: { hitDays: 0 } }), 'Camera mới thấy, chưa xác nhận');
  assert.equal(learnedCaption({ src: 'camera', quiet: true, meta: { hitDays: 2 } }), 'Camera chưa chắc chắn');
  assert.equal(learnedCaption({ src: 'import', quiet: true, meta: { hitDays: 0 } }), 'Biển nhập từ tệp');
});

test('importText: kho đầy là "Kho biển đã đầy (5.000 biển)"', () => {
  assert.equal(importText({ added: 0, skipped: 3, error: 'full' }), 'Kho biển đã đầy (5.000 biển).');
  assert.equal(importText({ added: 12, skipped: 3, error: 'full' }), 'Đã thêm 12 biển. Kho biển đã đầy (5.000 biển).');
  assert.equal(importText({ added: 1200, skipped: 0 }), 'Đã thêm 1.200 biển.');
  assert.equal(importText({ added: 0, skipped: 4 }), 'Tệp không có biển mới nào.');
  assert.equal(importText({ added: 0, skipped: 0, error: 'too-many' }), 'Tệp có hơn 5.000 biển.');
  for (const e of ['too-large', 'bad-json', 'not-geojson', 'no-labels', 'unknown-error']) {
    const t = importText({ added: 0, skipped: 0, error: e });
    assert.ok(t && t.endsWith('.'), e);
  }
});

test('văn bản: tiếng Việt viết thường kiểu câu, không viết hoa toàn bộ', () => {
  const all = [...Object.values(TEXT), ...Object.values(VISION_TEXT), ...EXPORT_WARNING, importText({ error: 'full' })];
  for (const t of all) {
    assert.equal(typeof t, 'string');
    const first = t.replace(/^"/, '')[0];
    assert.ok(first === first.toLocaleUpperCase('vi') && first !== first.toLocaleLowerCase('vi'), t); // chữ hoa đầu câu
    assert.ok(!/[A-ZĐ]{4,}/.test(t.replace(/OpenStreetMap|iD/g, '')), t); // không có cụm VIẾT HOA
  }
  assert.equal(TEXT.notParked, 'Chỉ bật được khi xe đã đỗ.');
  assert.equal(EXPORT_WARNING[0], 'Tệp này cho thấy những con đường bạn đã đi. Chỉ gửi cho người bạn tin tưởng.');
});

test('stateText: mọi mã lỗi camera, lý do không hỗ trợ và lỗi bộ nhận diện đều có câu tiếng Việt', () => {
  const base = {
    support: { ok: true, reason: null },
    models: 'ok',
    enabled: true,
    visionError: null,
    camera: 'on',
    block: null,
    vision: 'ready',
    progress: null,
    level: 2,
    capturing: true,
    health: null,
  };
  assert.equal(stateText(base), TEXT.running);
  for (const code of CAMERA_ERROR_CODES) {
    assert.equal(stateText({ ...base, camera: `error:${code}` }), CAMERA_ERROR_TEXT[code], code);
    assert.ok(CAMERA_ERROR_TEXT[code], code);
  }
  for (const reason of Object.keys(SUPPORT_TEXT)) {
    assert.equal(stateText({ ...base, support: { ok: false, reason } }), SUPPORT_TEXT[reason], reason);
  }
  for (const code of VISION_ERROR_CODES) {
    assert.ok(VISION_TEXT[code], code);
    if (code !== 'args') assert.equal(stateText({ ...base, visionError: code }), VISION_TEXT[code], code);
  }
  assert.equal(stateText({ ...base, visionError: 'args' }), TEXT.running); // lỗi của một khung: không báo
  assert.equal(stateText({ ...base, models: 'no-models' }), VISION_TEXT['no-models']);
  assert.equal(stateText({ ...base, enabled: false }), TEXT.off);
  for (const b of ['mode', 'hidden', 'simulated', 'slow', 'battery']) assert.equal(stateText({ ...base, block: b }), TEXT[b], b);
  assert.equal(stateText({ ...base, vision: 'loading', progress: { loaded: 25, total: 100 } }), 'Đang tải dữ liệu nhận diện biển (25 %).');
  assert.equal(stateText({ ...base, level: 0 }), TEXT.paused);
  for (const h of ['blank', 'dark', 'bright']) assert.equal(stateText({ ...base, health: h }), TEXT[h], h);
  assert.equal(stateText({ ...base, camera: 'starting', capturing: false }), TEXT.starting);
});

// ---------------------------------------------------------------------------------------------------------------
// Khởi động, labels.json, không có mô hình

test('init: labels.json tải một lần từ URL ?v=<16 hex>, kiểm SHA-256, cùng một đối tượng cho kho và bộ học', async () => {
  const env = makeEnv({ mode: 'browse' });
  await env.ctl.init();
  await env.ctl.init();
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0], `https://app.test/models/labels.json?v=${sha(LABEL_BYTES).slice(0, 16)}`);
  assert.equal(env.ctl.state.labels, 'ok');
  assert.ok(env.ctl.learner);
  assert.equal(env.ctl.learner.labels.get('P.127[50]').learn, true);
  assert.equal(env.ctl.learned.labels.get('P.127[50]').learn, true);
  assert.equal(env.ctl.learner.labels.size, env.ctl.learned.labels.size);
  assert.equal(env.md.calls.length, 0); // khởi động không bao giờ mở camera khi chưa bật
  env.ctl.dispose();
});

test('labels.json sai mã băm: không dùng, bộ học vẫn có (để giới hạn camera nghe lượt đi qua), nhập tệp báo cần labels', async () => {
  const env = makeEnv({ mode: 'browse', labelHash: 'b'.repeat(64) });
  await env.ctl.init();
  assert.equal(env.ctl.state.labels, 'error');
  assert.ok(env.ctl.learner);
  assert.equal(env.ctl.learner.labels.size, 0);
  await park(env);
  const r = env.ctl.importGeoJSON({ type: 'FeatureCollection', features: [] });
  assert.equal(r.error, 'no-labels');
  assert.equal(r.text, TEXT.labels);
  env.ctl.dispose();
});

test("'no-models': kho biển vẫn dùng được (cảnh báo, nhập, xuất, xem lại), camera không bao giờ mở", async () => {
  const env = makeEnv({ mode: 'browse', models: false, settings: { camEnabled: true } });
  await env.ctl.init();
  const st = env.ctl.state;
  assert.equal(st.models, 'no-models');
  assert.equal(st.text, VISION_TEXT['no-models']);
  await park(env);
  const res = await env.ctl.enable();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-models');
  assert.equal(env.md.calls.length, 0);
  // Nhập, xem lại, cảnh báo (featsNear), xuất
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [105.85, 21.03] }, properties: { traffic_sign: 'VN:P.127[50]', direction: 90 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [105.86, 21.03] }, properties: { traffic_sign: 'VN:R.122', direction: 270 } },
    ],
  };
  const imp = env.ctl.importGeoJSON(JSON.stringify(fc));
  assert.equal(imp.added, 2);
  assert.equal(imp.text, 'Đã thêm 2 biển.');
  assert.equal(env.ctl.list({ near: [105.85, 21.03] }).length, 2);
  assert.ok(env.ctl.learned.featsNear([105.85, 21.03], 70).length >= 1);
  assert.equal(env.ctl.state.counts.learned, 2);
  assert.equal(env.ctl.state.counts.candidates, 2);
  const id = env.ctl.list()[0].id;
  assert.equal(env.ctl.confirm(id).ok, true);
  assert.equal(env.ctl.state.counts.confirmed, 1);
  const ex = env.ctl.exportGeoJSON();
  assert.equal(ex.ok, true);
  assert.equal(ex.count, 2);
  assert.deepEqual(ex.warning, EXPORT_WARNING);
  assert.ok(ex.filename.endsWith('.geojson'));
  assert.equal(JSON.parse(ex.json).type, 'FeatureCollection');
  // Đang lái với camEnabled: vẫn không mở camera
  env.mode = 'drive';
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.md.calls.length, 0);
  assert.equal(env.vision.loads, 0);
  env.ctl.dispose();
});

test('máy không hỗ trợ: không mở camera, câu SUPPORT_TEXT, kho vẫn dùng được', async () => {
  const env = makeEnv({ mode: 'browse', support: { ok: false, reason: 'webview?' } });
  await env.ctl.init();
  assert.equal(env.ctl.state.text, SUPPORT_TEXT['webview?']);
  await park(env);
  const r = await env.ctl.enable();
  assert.equal(r.reason, 'webview?');
  assert.equal(r.text, SUPPORT_TEXT['webview?']);
  assert.equal(env.md.calls.length, 0);
  assert.deepEqual(env.ctl.list(), []);
  env.ctl.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// Quy tắc mở lại: không bao giờ tự hỏi quyền

for (const perm of ['prompt', 'denied', 'throws']) {
  test(`đang lái, quyền '${perm}': không gọi getUserMedia, camera giữ tắt và có câu giải thích`, async () => {
    const env = makeEnv({ perm, settings: { camEnabled: true } });
    await env.ctl.init();
    for (let i = 0; i < 5; i++) {
      env.fix(10);
      await env.advance(1000);
    }
    env.doc.hide();
    env.doc.show();
    await env.advance(1000);
    env.fix(2); // chậm rồi nhanh lại: lý do chặn đổi, thử tự mở lại (vẫn theo quy tắc quyền)
    env.fix(10);
    await env.advance(1000);
    assert.equal(env.md.calls.length, 0);
    const code = { prompt: 'not-granted', denied: 'denied', throws: 'perm-unknown' }[perm];
    assert.equal(env.ctl.state.camera, `error:${code}`);
    assert.equal(env.ctl.state.text, CAMERA_ERROR_TEXT[code]);
    env.ctl.dispose();
  });
}

test("quyền 'granted': tự mở khi lái, không có userGesture; vòng lấy khung chạy", async () => {
  const starts = [];
  let real = null;
  const { CameraService } = await import('../js/camera.js');
  const env = makeEnv({
    settings: { camEnabled: true },
    cameraFactory: (deps) => {
      real = new CameraService(deps);
      const start = real.start.bind(real);
      real.start = (o = {}) => {
        starts.push(o);
        return start(o);
      };
      return real;
    },
  });
  await env.ctl.init();
  env.fix(10);
  await env.advance(2000);
  assert.equal(env.md.calls.length, 1);
  assert.ok(starts.length >= 1);
  for (const o of starts) assert.notEqual(o.userGesture, true);
  assert.equal(env.ctl.state.camera, 'on');
  assert.ok(env.vision.calls.length >= 3, `khung đã xử lý: ${env.vision.calls.length}`);
  assert.equal(env.ctl.state.capturing, true);
  assert.equal(env.ctl.state.text, TEXT.running);
  env.ctl.dispose();
});

test('test hook: globalThis.__BD_TEST__.visionFactory và cameraFactory được dùng khi không truyền vào', async () => {
  const made = { vision: 0, camera: 0 };
  const fv = new FakeVision();
  const { CameraService } = await import('../js/camera.js');
  globalThis.__BD_TEST__ = {
    visionFactory: () => {
      made.vision++;
      return fv;
    },
    cameraFactory: (deps) => {
      made.camera++;
      return new CameraService(deps);
    },
  };
  try {
    const env = makeEnv({ settings: { camEnabled: true }, visionFactory: null });
    await env.ctl.init();
    env.fix(10);
    await env.advance(1500);
    assert.equal(made.vision, 1);
    assert.equal(made.camera, 1);
    assert.ok(fv.calls.length >= 1);
    env.ctl.dispose();
  } finally {
    delete globalThis.__BD_TEST__;
  }
  // Không có móc: tạo Vision thật (chưa tải gì, không có worker).
  const env2 = makeEnv({ mode: 'browse', visionFactory: null });
  await env2.ctl.init();
  assert.equal(made.vision, 1);
  env2.ctl.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// enable / disable

test('enable(): bị từ chối khi chưa đỗ (đang lái, đang chạy, đứng chưa đủ 5 giây), không gọi getUserMedia', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'drive' });
  await env.ctl.init();
  env.stationary = true;
  let r = await env.ctl.enable();
  assert.deepEqual([r.ok, r.reason, r.text], [false, 'not-parked', TEXT.notParked]);
  env.mode = 'browse';
  env.stationary = false; // xe đang chạy (OBD/GPS)
  env.ctl.tick();
  await env.advance(PARK_STILL_MS + 100);
  r = await env.ctl.enable();
  assert.equal(r.reason, 'not-parked');
  env.stationary = true;
  env.ctl.tick();
  await env.advance(PARK_STILL_MS - 100);
  r = await env.ctl.enable();
  assert.equal(r.reason, 'not-parked');
  assert.equal(env.md.calls.length, 0);
  assert.equal(env.store.settings.camEnabled, false);
  // Một lần đỗ đủ lâu là được (và chỉ khi đó mới được hỏi quyền)
  await env.advance(200);
  r = await env.ctl.enable();
  assert.equal(r.ok, true);
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.store.settings.camEnabled, true);
  env.ctl.dispose();
});

test('dừng đèn đỏ rồi rời chế độ lái ("Kết thúc", nhấn giữ bản đồ): chưa đỗ cho tới PARK_RECENT_MS sau lần chạy cuối', async () => {
  for (const leaveTo of ['browse', 'place']) {
    const env = makeEnv({ perm: 'prompt', mode: 'drive' });
    await env.ctl.init();
    // Đang chạy 36 km/h ở chế độ lái, rồi dừng đèn đỏ 8 giây.
    for (let k = 0; k < 5; k++) {
      env.fix(10);
      await env.advance(1000);
    }
    env.stationary = true;
    env.fix(0);
    for (let k = 0; k < 8; k++) {
      env.ctl.tick();
      await env.advance(1000);
    }
    assert.equal(env.ctl.isParked(), false, 'chế độ lái');
    env.mode = leaveTo;
    env.ctl.refresh();
    assert.equal(env.ctl.isParked(), false, `${leaveTo}: ngay khi rời chế độ lái`);
    for (const wait of [5000, 60e3]) {
      await env.advance(wait);
      env.ctl.tick();
      assert.equal(env.ctl.isParked(), false, `${leaveTo}: thêm ${wait} ms`);
      assert.equal(env.ctl.state.parked, false);
      assert.equal((await env.ctl.enable()).reason, 'not-parked');
      assert.equal((await env.ctl.openCheck()).reason, 'not-parked');
      assert.equal(env.ctl.exportGeoJSON().reason, 'not-parked');
    }
    assert.equal(env.md.calls.length, 0, 'không bao giờ hỏi quyền camera lúc dừng đèn đỏ');
    // Đứng yên tới PARK_RECENT_MS sau lần chạy cuối: đã đỗ.
    await env.advance(PARK_RECENT_MS);
    env.ctl.tick();
    assert.equal(env.ctl.isParked(), true);
    env.ctl.dispose();
  }
});

test('chạy ở chế độ xem bản đồ (chưa tự vào chế độ lái) rồi dừng 10 giây: chưa đỗ; tốc độ OBD cũng tính, rung GPS thì không', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'browse' });
  await env.ctl.init();
  env.fix(8);
  env.stationary = true;
  env.fix(0);
  for (let k = 0; k < 10; k++) {
    env.ctl.tick();
    await env.advance(1000);
  }
  assert.equal(env.ctl.isParked(), false);
  await env.advance(PARK_RECENT_MS);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), true);
  // Mất GPS, xe báo 30 km/h qua OBD (không có định vị mới): không còn đỗ, kể cả sau khi xe dừng hẳn.
  env.carKmh = 30;
  env.ctl.tick();
  env.carKmh = 0;
  await env.advance(PARK_STILL_MS + 1000);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), false, 'OBD vừa báo xe chạy');
  await env.advance(PARK_RECENT_MS);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), true);
  // GPS rung 1,5 m/s lúc đỗ: không tính là vừa chạy (chỉ đặt lại bộ đếm đứng yên 5 giây).
  env.stationary = null;
  env.fix(1.5);
  env.fix(0);
  await env.advance(PARK_STILL_MS + 10);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), true);
  // Chạy thử (định vị giả nhanh) không tính là xe vừa chạy.
  env.fix(15, { simulated: true });
  env.fix(0);
  await env.advance(PARK_STILL_MS + 10);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), true);
  env.ctl.dispose();
});

test('đỗ từ lúc mở ứng dụng (chưa chạy): đỗ sau 5 giây, như trước', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'browse' });
  await env.ctl.init();
  env.stationary = true;
  env.ctl.tick();
  await env.advance(PARK_STILL_MS + 10);
  env.ctl.tick();
  assert.equal(env.ctl.isParked(), true);
  env.ctl.dispose();
});

test('enable(): bật cả "giữ màn hình sáng" và báo lại; chưa lái thì camera đóng lại ngay', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'browse', settings: { keepAwake: false } });
  await env.ctl.init();
  await park(env);
  const r = await env.ctl.enable();
  assert.equal(r.ok, true);
  assert.equal(r.keepAwake, true);
  assert.equal(r.text, TEXT.keepAwakeOn);
  assert.equal(env.store.settings.keepAwake, true);
  assert.equal(env.ctl.state.keepAwakeTurnedOn, true);
  await env.advance(100);
  assert.equal(env.live(), 0); // đỗ: không giữ camera mở
  assert.equal(env.ctl.state.text, TEXT.mode);
  // keepAwake đã bật sẵn: không đổi và không báo
  const env2 = makeEnv({ perm: 'granted', mode: 'browse', settings: { keepAwake: true } });
  await env2.ctl.init();
  await park(env2);
  const r2 = await env2.ctl.enable();
  assert.equal(r2.keepAwake, false);
  assert.equal(r2.text, null);
  assert.ok(!env2.store.sets.some(([k]) => k === 'keepAwake'));
  env.ctl.dispose();
  env2.ctl.dispose();
});

test('enable(): người dùng chặn quyền → không bật, có câu giải thích', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'browse' });
  env.md.getUserMedia = (c) => {
    env.md.calls.push(c);
    return Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  };
  await env.ctl.init();
  await park(env);
  const r = await env.ctl.enable();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'denied');
  assert.equal(r.text, CAMERA_ERROR_TEXT.denied);
  assert.equal(env.store.settings.camEnabled, false);
  env.ctl.dispose();
});

test('disable(): luôn được, kể cả khi đang lái và đang lấy khung', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  await env.ctl.init();
  env.fix(10);
  await env.advance(1500);
  assert.equal(env.live(), 1);
  assert.ok(env.vision.calls.length > 0);
  env.ctl.disable();
  await env.advance(1000);
  assert.equal(env.store.settings.camEnabled, false);
  assert.equal(env.live(), 0);
  assert.equal(env.vision.terminated, 1);
  assert.equal(env.ctl.state.capturing, false);
  assert.equal(env.ctl.state.text, TEXT.off);
  const n = env.vision.calls.length;
  env.fix(10);
  await env.advance(2000);
  assert.equal(env.vision.calls.length, n);
  assert.equal(env.md.calls.length, 1); // không tự mở lại
  env.ctl.dispose();
});

test('tắt camEnabled từ nơi khác (cài đặt) cũng đóng camera', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  await env.ctl.init();
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.live(), 1);
  env.store.set('camEnabled', false);
  await env.advance(500);
  assert.equal(env.live(), 0);
  env.ctl.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// Vòng lấy khung

test('đúng một khung đang xử lý; cỡ khung đọc trước khi chuyển bitmap', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  env.vision.manual = true;
  await env.ctl.init();
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.vision.calls.length, 1);
  const frames = [];
  const learner = env.ctl.learner;
  const onVision = learner.onVision.bind(learner);
  learner.onVision = (r, frame) => {
    frames.push(frame);
    return onVision(r, frame);
  };
  // Khung chưa xong: thời gian trôi, các lần fix tới cũng không gửi thêm khung
  for (let i = 0; i < 5; i++) {
    env.fix(10);
    await env.advance(1000);
  }
  assert.equal(env.vision.calls.length, 1);
  assert.equal(env.vision.maxInflight, 1);
  for (let i = 0; i < 6; i++) {
    env.vision.finish();
    await env.advance(400);
  }
  assert.ok(env.vision.calls.length >= 4);
  assert.equal(env.vision.maxInflight, 1);
  // Cỡ khung từ bitmap trước khi gửi (bitmap giả về 0×0 sau process)
  for (const f of frames) assert.deepEqual(f, { width: 1920, height: 1080 });
  assert.equal(learner.camera.width, 1920);
  assert.equal(learner.camera.height, 1080);
  for (const c of env.vision.calls) {
    assert.deepEqual([c.width, c.height], [1920, 1080]);
    assert.ok(Array.isArray(c.opts.passes) && c.opts.passes[0] === 'A');
    assert.deepEqual(c.opts.foe, { x: 960, y: 0.42 * 1080 });
    assert.ok(Array.isArray(c.opts.hints));
    assert.equal('evalCrops' in c.opts, false); // camEval tắt: không có cờ
  }
  // Lượt quét xen kẽ A / A+B như bộ chọn mức tải ở mức 2
  assert.ok(env.vision.calls.some((c) => c.opts.passes.length === 2));
  env.ctl.dispose();
});

test('camAim dời điểm tụ; camEval bật thì gửi evalCrops: true và nối ảnh vào EvalCrops', async () => {
  const env = makeEnv({ settings: { camEnabled: true, camEval: true, camAim: Object.freeze({ dx: 40, dy: -30 }) } });
  await env.ctl.init();
  env.fix(10);
  await env.advance(1200);
  const c = env.vision.calls[0];
  assert.deepEqual(c.opts.foe, { x: 1000, y: 0.42 * 1080 - 30 });
  assert.equal(c.opts.evalCrops, true);
  assert.equal(typeof env.ctl.learner.onEvalCrop, 'function');
  env.store.set('camEval', false);
  assert.equal(env.ctl.learner.onEvalCrop, null);
  env.ctl.dispose();
});

test('xe chậm dưới 3 m/s: thôi lấy khung, bộ học kết thúc các lượt bám (pause); quá 2 phút thì trả camera', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  await env.ctl.init();
  env.fix(10);
  await env.advance(1500);
  let paused = 0;
  const learner = env.ctl.learner;
  const pause = learner.pause.bind(learner);
  learner.pause = () => {
    paused++;
    return pause();
  };
  env.fix(1);
  await env.advance(1000);
  const n = env.vision.calls.length;
  await env.advance(3000);
  assert.equal(env.vision.calls.length, n);
  assert.ok(paused >= 1);
  assert.equal(env.ctl.state.block, 'slow');
  assert.equal(env.ctl.state.text, TEXT.slow);
  assert.equal(env.live(), 1); // đèn đỏ: camera vẫn mở
  await env.advance(IDLE_RELEASE_MS);
  env.fix(1);
  await env.advance(100);
  assert.equal(env.live(), 0); // kẹt xe lâu: trả camera
  // chạy lại: tự mở lại theo quy tắc quyền
  env.fix(10);
  await env.advance(1500);
  assert.equal(env.live(), 1);
  assert.ok(env.vision.calls.length > n);
  env.ctl.dispose();
});

test('trang bị ẩn: camera dừng, thôi lấy khung; hiện lại thì tự mở lại (không có userGesture)', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  await env.ctl.init();
  env.fix(10);
  await env.advance(1500);
  assert.equal(env.live(), 1);
  let paused = 0;
  const learner = env.ctl.learner;
  const pause = learner.pause.bind(learner);
  learner.pause = () => {
    paused++;
    return pause();
  };
  env.doc.hide();
  await env.advance(100);
  assert.equal(env.live(), 0);
  assert.ok(paused >= 1);
  const n = env.vision.calls.length;
  env.fix(10);
  await env.advance(3000);
  assert.equal(env.vision.calls.length, n);
  assert.equal(env.ctl.state.block, 'hidden');
  assert.equal(env.ctl.state.capturing, false);
  env.doc.show();
  await env.advance(1500);
  assert.equal(env.live(), 1);
  assert.equal(env.md.calls.length, 2);
  assert.ok(env.vision.calls.length > n);
  // hiện lại khi quyền đã về 'prompt': không gọi getUserMedia
  env.doc.hide();
  env.perm = 'prompt';
  env.doc.show();
  await env.advance(1500);
  assert.equal(env.md.calls.length, 2);
  assert.equal(env.ctl.state.camera, 'error:not-granted');
  env.ctl.dispose();
});

test('rời chế độ lái và lần định vị chạy thử: không lấy khung', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  await env.ctl.init();
  env.fix(10, { simulated: true });
  await env.advance(1500);
  assert.equal(env.vision.calls.length, 0);
  assert.equal(env.ctl.state.block, 'simulated');
  env.fix(10);
  await env.advance(1500);
  assert.ok(env.vision.calls.length > 0);
  env.mode = 'browse';
  env.ctl.refresh();
  await env.advance(100);
  assert.equal(env.live(), 0);
  assert.equal(env.ctl.state.block, 'mode');
  env.ctl.dispose();
});

test('chạy thử ("Chạy thử"): camera không bao giờ mở, kể cả trước lần định vị giả đầu tiên; xong thì chuyến thật mở lại', async () => {
  const env = makeEnv({ settings: { camEnabled: true }, mode: 'routes' });
  await env.ctl.init();
  env.fix(0); // lần định vị thật cuối cùng, đứng ở màn hình chọn đường
  await env.advance(1500);
  assert.equal(env.md.calls.length, 0);
  // startNav(true): state.simulate rồi setMode('nav') → refresh(), trước locator.startSimulation.
  env.simulate = true;
  env.mode = 'nav';
  env.ctl.refresh();
  await env.advance(100);
  assert.equal(env.ctl.state.block, 'simulated');
  assert.equal(env.md.calls.length, 0);
  assert.equal(env.live(), 0);
  for (let k = 0; k < 60; k++) {
    env.fix(12, { simulated: true });
    await env.advance(1000);
    assert.equal(env.md.calls.length, 0, `giây ${k}`);
    assert.equal(env.live(), 0);
  }
  assert.equal(env.ctl.state.block, 'simulated');
  assert.equal(env.ctl.state.camera === 'on', false);
  assert.equal(env.ctl.state.text, TEXT.simulated);
  assert.equal(env.grabs, 0);
  // endNav → startDrive: state.simulate = false, chuyến mới. Lần định vị giả cũ không còn tính, kể cả trước định vị thật.
  env.simulate = false;
  env.mode = 'drive';
  env.ctl.newTrip();
  env.ctl.refresh();
  assert.notEqual(env.ctl.state.block, 'simulated');
  env.fix(10);
  await env.advance(1500);
  assert.equal(env.live(), 1);
  assert.equal(env.md.calls.length, 1);
  env.ctl.dispose();
});

test("lỗi bộ nhận diện: 'args' bỏ khung và chạy tiếp; 'worker' tải lại sau VISION_RETRY_MS", async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  let mode = 'args';
  env.vision.processImpl = (frame) => {
    if (mode === 'args') return Promise.reject(Object.assign(new Error('args'), { code: 'args' }));
    if (mode === 'worker') {
      env.vision.ready = false;
      mode = 'ok';
      return Promise.reject(Object.assign(new Error('worker'), { code: 'worker' }));
    }
    return Promise.resolve({ t: frame.t, ms: { pre: 1, det: 1, cls: 1, total: 3 }, lum: { mean: 100, std: 30 }, boxes: [] });
  };
  await env.ctl.init();
  env.fix(10);
  await env.advance(1500);
  assert.ok(env.vision.calls.length >= 3); // 'args' không làm dừng vòng
  assert.equal(env.vision.loads, 1);
  assert.equal(env.logs.length, 1); // ghi một lần
  mode = 'worker';
  await env.advance(500);
  assert.equal(env.ctl.state.visionError, 'worker');
  assert.equal(env.ctl.state.text, VISION_TEXT.worker);
  const n = env.vision.calls.length;
  await env.advance(VISION_RETRY_MS[0] + 100);
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.vision.loads, 2);
  assert.ok(env.vision.calls.length > n);
  assert.equal(env.ctl.state.visionError, null);
  env.ctl.dispose();
});

test("lỗi tải 'integrity' không tự thử lại; camera không mở khi bộ nhận diện không chạy được", async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  env.vision.loadImpl = () => Promise.reject(Object.assign(new Error('integrity'), { code: 'integrity' }));
  await env.ctl.init();
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.ctl.state.visionError, 'integrity');
  assert.equal(env.ctl.state.text, VISION_TEXT.integrity);
  await env.advance(VISION_RETRY_MS[2] * 2);
  env.fix(10);
  await env.advance(1000);
  assert.equal(env.vision.loads, 1);
  assert.equal(env.live(), 0);
  env.ctl.dispose();
});

const visionErr = (code) => Object.assign(new Error(code), { code });

test("bộ nhận diện không tải được ('load', mạng yếu): camera không mở khi lái; thôi sau VISION_RETRY_MS; chuyến mới thì thử lại", async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  env.vision.loadImpl = () => Promise.reject(visionErr('load'));
  await env.ctl.init();
  const total = VISION_RETRY_MS.reduce((a, b) => a + b, 0);
  for (let t = 0; t < total + 30_000; t += 1000) {
    env.fix(15);
    await env.advance(1000);
    assert.equal(env.live(), 0, `giây ${t / 1000}: không mở camera khi bộ nhận diện không chạy`);
  }
  assert.equal(env.vision.loads, VISION_RETRY_MS.length + 1);
  assert.equal(env.md.calls.length, 0);
  let st = env.ctl.state;
  assert.equal(st.visionError, 'load');
  assert.equal(st.visionGaveUp, true);
  assert.equal(st.text, VISION_TEXT.load);
  assert.equal(st.capturing, false);
  assert.ok(env.vision.terminated >= 1); // worker và bộ nhớ được giải phóng
  // Lái thêm 10 phút: không tải lại, không mở camera.
  for (let k = 0; k < 10; k++) {
    env.fix(15);
    await env.advance(60_000);
  }
  assert.equal(env.vision.loads, VISION_RETRY_MS.length + 1);
  assert.equal(env.live(), 0);
  // Chuyến mới (mạng đã có): thử lại, chạy được thì camera tự mở.
  env.vision.loadImpl = null;
  env.ctl.newTrip();
  env.fix(15);
  await env.advance(1500);
  assert.equal(env.vision.loads, VISION_RETRY_MS.length + 2);
  st = env.ctl.state;
  assert.equal(st.visionError, null);
  assert.equal(st.visionGaveUp, false);
  assert.equal(env.live(), 1);
  assert.equal(st.capturing, true);
  env.ctl.dispose();
});

test("bộ nhận diện đã thôi vì không tải được: có mạng lại ('online') thì thử lại ngay; lỗi 'worker' thì không", async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  env.vision.loadImpl = () => Promise.reject(visionErr('load'));
  await env.ctl.init();
  for (let t = 0; t < 90_000; t += 1000) {
    env.fix(15);
    await env.advance(1000);
  }
  assert.equal(env.ctl.state.visionGaveUp, true);
  const n = env.vision.loads;
  env.vision.loadImpl = null;
  env.win.dispatchEvent(new Event('online'));
  env.fix(15);
  await env.advance(1500);
  assert.equal(env.vision.loads, n + 1);
  assert.equal(env.live(), 1);
  env.ctl.dispose();
});

test("bộ nhận diện tải được nhưng hỏng ở mỗi khung ('worker'): thử lại VISION_RETRY_MS.length lần rồi thôi, trả camera", async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  env.vision.processImpl = () => {
    env.vision.ready = false; // như Vision._fatal / _stuck: worker bị kết thúc
    return Promise.reject(visionErr('worker'));
  };
  await env.ctl.init();
  for (let k = 0; k < 600; k++) {
    env.fix(15);
    await env.advance(1000);
  }
  assert.ok(env.vision.loads <= VISION_RETRY_MS.length + 1, `tải ${env.vision.loads} lần`);
  const st = env.ctl.state;
  assert.equal(env.live(), 0);
  assert.equal(st.camera, 'off'); // đóng hẳn, không chỉ tạm trả
  assert.equal(st.visionError, 'worker');
  assert.equal(st.visionGaveUp, true);
  assert.equal(st.text, TEXT.visionStopped);
  assert.ok(env.vision.terminated >= 1);
  // Chuyến mới được thử lại.
  const n = env.vision.loads;
  env.ctl.newTrip();
  env.fix(15);
  await env.advance(1000);
  assert.equal(env.vision.loads, n + 1);
  env.ctl.dispose();
});

test('bộ nhận diện hỏng, chạy tốt VISION_STABLE_FRAMES khung, rồi lại hỏng: lại được thử lại sau VISION_RETRY_MS[0]', async () => {
  const env = makeEnv({ settings: { camEnabled: true } });
  let mode = 'crash';
  env.vision.processImpl = (frame) => {
    if (mode === 'crash') {
      env.vision.ready = false;
      mode = 'ok';
      return Promise.reject(visionErr('worker'));
    }
    return Promise.resolve({ t: frame.t, ms: { pre: 1, det: 1, cls: 1, total: 3 }, lum: { mean: 100, std: 30 }, boxes: [] });
  };
  await env.ctl.init();
  env.fix(15);
  await env.advance(500);
  assert.equal(env.ctl.state.visionError, 'worker');
  // Camera được trả trong lúc chờ tải lại (không có khung nào được xử lý).
  assert.equal(env.live(), 0);
  await env.advance(VISION_RETRY_MS[0] + 100);
  env.fix(15);
  await env.advance(500);
  assert.equal(env.vision.loads, 2);
  assert.equal(env.live(), 1);
  const n = env.vision.calls.length;
  while (env.vision.calls.length < n + VISION_STABLE_FRAMES + 50) {
    env.fix(15);
    await env.advance(1000);
  }
  mode = 'crash';
  await env.advance(1000);
  assert.equal(env.ctl.state.visionError, 'worker');
  await env.advance(VISION_RETRY_MS[0] + 100);
  env.fix(15);
  await env.advance(500);
  assert.equal(env.vision.loads, 3, 'số lần thử lại đã được trả lại');
  assert.equal(env.ctl.state.visionError, null);
  env.ctl.dispose();
});

test('chuyến mới: đặt lại bộ học, bộ chọn mức tải và giới hạn tốc độ camera', async () => {
  const env = makeEnv({ mode: 'browse' });
  await env.ctl.init();
  const calls = [];
  const wrap = (obj, name) => {
    const f = obj[name].bind(obj);
    obj[name] = () => {
      calls.push(name);
      return f();
    };
  };
  wrap(env.ctl.learner, 'reset');
  wrap(env.ctl.scheduler, 'reset');
  env.ctl.newTrip();
  assert.deepEqual(calls.sort(), ['reset', 'reset']);
  assert.equal(env.ctl.speedLimit, null);
  assert.ok(env.ctl.learner.listeners.size >= 1); // CameraLimit nghe lượt đi qua của bộ học
  env.ctl.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// "Kiểm tra camera", xem lại, xoá

test('kiểm tra camera: chỉ khi đỗ; đo p50/p90 với bộ nhận diện, báo cho bộ chọn mức tải; xe chạy thì tự đóng', async () => {
  const env = makeEnv({ perm: 'prompt', mode: 'drive' });
  await env.ctl.init();
  let r = await env.ctl.openCheck();
  assert.equal(r.reason, 'not-parked');
  assert.equal(env.md.calls.length, 0);
  await park(env);
  r = await env.ctl.openCheck();
  assert.equal(r.ok, true);
  assert.equal(env.md.calls.length, 1);
  assert.deepEqual(r.settings, { width: 1920, height: 1080, frameRate: 15, deviceId: 'cam-back', label: 'camera 0, facing back' });
  assert.deepEqual(r.devices.map((d) => d.deviceId), ['cam-back', 'usb-1']);
  assert.equal(r.range, 45);
  assert.ok(r.stream);
  assert.equal(env.ctl.state.check, 'open');
  assert.equal(env.ctl.scheduler.maxLevel, 2);
  const m = await env.ctl.measureCheck({ frames: 5 });
  assert.equal(m.ok, true);
  assert.equal(m.passes.A.n, 5);
  assert.equal(m.passes.AB.n, 5);
  assert.equal(m.p90, 7);
  assert.ok(m.p90 < FAST_P90_MS);
  assert.equal(env.ctl.scheduler.maxLevel, 3);
  assert.deepEqual([m.width, m.height, m.fps, m.range], [1920, 1080, 15, 45]);
  assert.equal(m.rangeText, rangeText(45));
  assert.ok(env.vision.calls.every((c) => c.width === 1920));
  // xe chạy: luồng kiểm tra đóng ngay
  env.stationary = false;
  env.fix(5);
  await settle();
  assert.equal(env.ctl.state.check, null);
  assert.equal(env.live(), 0);
  env.ctl.dispose();
});

test('kiểm tra camera: trang bị ẩn thì đóng luồng xem trước; hiện lại không tự mở lại', async () => {
  const env = makeEnv({ mode: 'drive' });
  await env.ctl.init();
  await park(env);
  const r = await env.ctl.openCheck();
  assert.equal(r.ok, true);
  assert.equal(env.live(), 1);
  env.doc.hide();
  await settle();
  assert.equal(env.live(), 0);
  assert.equal(env.ctl.state.check, null);
  env.doc.show();
  await env.advance(60_000);
  assert.equal(env.md.calls.length, 1); // không gọi getUserMedia khi không có lần bấm
  assert.equal(env.live(), 0);
  env.ctl.dispose();
});

test('"Đo tốc độ xử lý" khi tính năng đang tắt: đóng kiểm tra thì giải phóng bộ nhận diện; mở lại hay bật ngay sau đó thì giữ', async () => {
  const env = makeEnv({ mode: 'drive' });
  await env.ctl.init();
  await park(env);
  assert.equal((await env.ctl.openCheck()).ok, true);
  assert.equal((await env.ctl.measureCheck({ frames: 3 })).ok, true);
  assert.equal(env.ctl.state.vision, 'ready');
  env.ctl.closeCheck();
  assert.equal(env.vision.terminated, 1);
  assert.equal(env.ctl.state.vision, 'idle');
  // Đổi camera (mở lại luồng kiểm tra) không tải lại bộ nhận diện.
  assert.equal((await env.ctl.openCheck()).ok, true);
  assert.equal((await env.ctl.measureCheck({ frames: 3 })).ok, true);
  assert.equal(env.vision.loads, 2);
  assert.equal((await env.ctl.openCheck({ deviceId: 'usb-1' })).ok, true);
  assert.equal(env.vision.terminated, 1);
  assert.equal(env.ctl.state.vision, 'ready');
  // Đo rồi bật: giữ bộ nhận diện vừa tải.
  const res = await env.ctl.enable();
  assert.equal(res.ok, true);
  assert.equal(env.vision.terminated, 1);
  assert.equal(env.vision.loads, 2);
  assert.equal(env.ctl.state.vision, 'ready');
  env.ctl.dispose();
});

test('"Đo tốc độ xử lý": đóng kiểm tra giữa chừng không bị tính là lỗi bộ nhận diện', async () => {
  const env = makeEnv({ mode: 'drive' });
  let rejectPending = null;
  env.vision.processImpl = () =>
    new Promise((resolve, reject) => {
      rejectPending = () => reject(visionErr('worker'));
    });
  const terminate = env.vision.terminate.bind(env.vision);
  env.vision.terminate = () => {
    terminate();
    rejectPending?.(); // như Vision thật: kết thúc worker thì khung đang xử lý bị từ chối
  };
  await env.ctl.init();
  await park(env);
  assert.equal((await env.ctl.openCheck()).ok, true);
  const pm = env.ctl.measureCheck({ frames: 3 });
  await settle();
  env.ctl.closeCheck();
  const r = await pm;
  assert.equal(r.reason, 'closed');
  const st = env.ctl.state;
  assert.equal(st.visionError, null);
  assert.equal(st.vision, 'idle');
  assert.equal(env.timers.length, 0); // không có hẹn tải lại
  env.ctl.dispose();
});

test('labels.json: lần mở đầu (service worker chưa điều khiển trang) tải lại một lần sau controllerchange; có mạng lại thì tải lại labels lỗi', async () => {
  const env = makeEnv({ mode: 'browse' });
  const sw = Object.assign(new EventTarget(), { controller: null });
  env.nav.serviceWorker = sw;
  await env.ctl.init();
  assert.equal(env.fetches.length, 1);
  assert.equal(env.ctl.state.labels, 'ok');
  sw.controller = {};
  sw.dispatchEvent(new Event('controllerchange'));
  await settle();
  assert.deepEqual(env.fetches, [env.fetches[0], env.fetches[0]]); // cùng URL ?v=…, qua service worker
  assert.equal(env.ctl.state.labels, 'ok');
  sw.dispatchEvent(new Event('controllerchange'));
  await settle();
  assert.equal(env.fetches.length, 2); // chỉ một lần
  env.ctl.dispose();
  // Trang đã được điều khiển: không tải thêm.
  const env2 = makeEnv({ mode: 'browse' });
  const sw2 = Object.assign(new EventTarget(), { controller: {} });
  env2.nav.serviceWorker = sw2;
  env2.fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
  await env2.ctl.init();
  sw2.dispatchEvent(new Event('controllerchange'));
  await settle();
  assert.equal(env2.fetches.length, 1);
  assert.equal(env2.ctl.state.labels, 'error');
  // Có mạng lại: tải lại labels.json đã lỗi.
  env2.fetchImpl = null;
  env2.win.dispatchEvent(new Event('online'));
  for (let i = 0; i < 50 && env2.ctl.state.labels === 'loading'; i++) await settle();
  assert.equal(env2.fetches.length, 2);
  assert.equal(env2.ctl.state.labels, 'ok');
  env2.ctl.dispose();
});

test('labels.json treo (mạng chập chờn): init() xong sau LOAD_IDLE với labels lỗi; "Xoá các biển đã học" không phải chờ', async () => {
  const env = makeEnv({ mode: 'browse' });
  let signal = null;
  env.fetchImpl = (url, opts) => {
    signal = opts?.signal || null;
    return new Promise(() => {}); // không bao giờ xong, kể cả khi bị huỷ
  };
  let ready = false;
  env.ctl.init().then(() => {
    ready = true;
  });
  await settle();
  let cleared = null;
  env.ctl.clear().then((r) => {
    cleared = r;
  });
  await settle();
  assert.deepEqual(cleared, { ok: true });
  assert.equal(ready, false);
  await env.advance(VISION_LIMITS.LOAD_IDLE + 10);
  assert.equal(ready, true);
  assert.equal(env.ctl.state.labels, 'error');
  assert.equal(signal?.aborted, true);
  env.ctl.dispose();
});

test('enable(): trang bị ẩn trong lúc hỏi quyền: không bật, không báo lỗi camera mà nhắc bấm bật lại', async () => {
  const env = makeEnv({ mode: 'browse', perm: 'prompt' });
  let release = null;
  const gum = env.md.getUserMedia;
  env.md.getUserMedia = (c) =>
    new Promise((resolve) => {
      release = () => resolve(gum(c));
    });
  await env.ctl.init();
  await park(env);
  const p = env.ctl.enable();
  await settle();
  env.doc.hide();
  env.perm = 'granted';
  release();
  const r = await p;
  env.doc.show();
  await settle();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hidden');
  assert.equal(r.text, TEXT.enableHidden);
  assert.notEqual(env.store.settings.camEnabled, true);
  assert.equal(env.live(), 0);
  env.ctl.dispose();
});

test('xem lại, nhập, xuất chỉ khi đỗ; "Xoá các biển đã học" luôn được', async () => {
  const env = makeEnv({ mode: 'drive' });
  await env.ctl.init();
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [105.85, 21.03] }, properties: { traffic_sign: 'VN:P.102', direction: 90 } }] };
  assert.equal(env.ctl.importGeoJSON(fc).reason, 'not-parked');
  assert.equal(env.ctl.exportGeoJSON().reason, 'not-parked');
  assert.equal(env.ctl.confirm('x').text, TEXT.parkedOnly);
  assert.equal(env.ctl.reject('x').reason, 'not-parked');
  assert.equal(env.ctl.removed('x').reason, 'not-parked');
  assert.equal((await env.ctl.evalExport()).reason, 'not-parked');
  await park(env);
  assert.equal(env.ctl.importGeoJSON(fc).added, 1);
  const id = env.ctl.list()[0].id;
  assert.equal(env.ctl.reject(id).ok, true);
  env.mode = 'drive';
  assert.equal((await env.ctl.clear()).ok, true); // đang lái vẫn xoá được
  assert.equal(env.ctl.learned.size, 0);
  assert.equal((await env.ctl.evalClear()).ok, true);
  assert.deepEqual(env.ctl.evalCounts(), { total: 0, accepted: 0, nearMiss: 0 });
  env.ctl.dispose();
});

test('ảnh kiểm tra đã lưu: camEval tắt vẫn xoá ảnh quá 30 ngày lúc khởi động và khi mở lâu, đếm đúng, xoá được khi chạy', async () => {
  assert.equal(EVAL_EXPIRE_MS, 3_600_000);
  const today = dayNumber(1_763_900_000_000 + 1000);
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' });
  const row = (id, day) => ({ id, day, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'new', pred: [['R.122', 0.9]], w: 40, night: false, blob: png });
  const backend = evalMemoryBackend([row(1, today - 200), row(2, today - 1)]);
  const env = makeEnv({ mode: 'drive', settings: { camEval: false }, evalBackend: backend });
  await env.ctl.init();
  await settle();
  assert.deepEqual([...backend.map.keys()], [2]); // ảnh 200 ngày trước đã bị xoá dù camEval tắt
  assert.equal(env.ctl.state.evalCount, 1);
  assert.equal(env.ctl.evalCounts().total, 1);
  assert.equal(env.ctl.learner.onEvalCrop, null); // camEval tắt: không thêm ảnh mới
  // Ứng dụng mở liền 30 ngày: lần refresh() sau đó xoá nốt ảnh quá hạn.
  env.clock.t += 30 * 86_400_000;
  env.ctl.refresh();
  await settle();
  assert.equal(backend.map.size, 0);
  assert.equal(env.ctl.state.evalCount, 0);
  // "Xoá ảnh biển đã lưu" khi đang lái (không đỗ) vẫn được.
  await backend.put(row(3, today)); // env2 khởi động lại từ hôm nay
  const env2 = makeEnv({ mode: 'drive', settings: { camEval: false }, evalBackend: backend });
  await env2.ctl.init();
  assert.equal(env2.ctl.state.evalCount, 1);
  assert.equal(env2.ctl.isParked(), false);
  assert.equal((await env2.ctl.evalClear()).ok, true);
  assert.equal(backend.map.size, 0);
  assert.equal(env2.ctl.state.evalCount, 0);
  env.ctl.dispose();
  env2.ctl.dispose();
});

test('onChange: báo trạng thái khi đổi, không báo lại khi không đổi; lỗi của bên nghe bị bỏ qua', async () => {
  const env = makeEnv({ mode: 'browse' });
  await env.ctl.init();
  const seen = [];
  const off = env.ctl.onChange((st) => seen.push(st));
  env.ctl.onChange(() => {
    throw new Error('ui');
  });
  env.ctl.refresh();
  env.ctl.refresh();
  assert.ok(seen.length <= 1);
  await park(env);
  assert.equal(seen.at(-1).parked, true);
  assert.ok(Object.isFrozen(seen.at(-1)));
  const n = seen.length;
  env.ctl.tick();
  assert.equal(seen.length, n);
  off();
  env.mode = 'drive';
  env.ctl.refresh();
  assert.equal(seen.length, n);
  env.ctl.dispose();
});
