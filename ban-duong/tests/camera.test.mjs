import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_ERROR_CODES,
  CAMERA_ERROR_TEXT,
  CameraService,
  cameraConstraints,
  cameraSupport,
  CONSTRAINT_STEPS,
  errorCode,
  GRAB_FAIL_MAX,
  GRAB_SWITCH_FAILS,
  IDEAL_FPS,
  IDEAL_HEIGHT,
  IDEAL_WIDTH,
  MAX_FPS,
  RELAXED_HEIGHT,
  RELAXED_WIDTH,
  RETRY_CODES,
  RETRY_DELAYS_MS,
  SUPPORT_TEXT,
  VIDEO_READY,
  watchBattery,
} from '../js/camera.js';
import {
  B_COST_FACTOR,
  BASELINE_MAX,
  BASELINE_MS,
  BATTERY_MIN,
  BUDGET_MS_PER_S,
  CAPTURE_SPEED,
  canAutoStart,
  captureBlock,
  DEFAULT_LEVEL,
  DRIVING_MODES,
  FAST_P90_MS,
  foeFor,
  FOE_Y_FRAC,
  GAP_MS,
  holdCamera,
  IDLE_RELEASE_MS,
  isParked,
  isStill,
  KEY_WINDOW,
  LevelScheduler,
  LEVELS,
  MIN_SAMPLES,
  OVER_AT_1_MS,
  PARK_SPEED,
  PARK_STILL_MS,
  PAUSE_MS,
  RISE_FACTOR,
  RISE_MIN,
  shouldCapture,
  STEP_UP_MS,
  StillTimer,
  WINDOW_MS,
} from '../js/camsched.js';
import { DEFAULT_SETTINGS } from '../js/store.js';

// ---------------------------------------------------------------------------------------------------------------
// Môi trường giả cho CameraService: navigator.permissions, mediaDevices, document (visibilitychange), ImageCapture.

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

class FakeTrack extends EventTarget {
  constructor({ deviceId = 'cam-back', label = 'camera 0, facing back', width = 1920, height = 1080, caps = {} } = {}) {
    super();
    this.kind = 'video';
    this.label = label;
    this.readyState = 'live';
    this.muted = false;
    this.stopped = 0;
    this.applied = [];
    this.rejectApply = () => false;
    this._settings = { width, height, frameRate: 15, deviceId };
    this._caps = caps;
  }

  stop() {
    this.readyState = 'ended'; // như trình duyệt: stop() không phát sự kiện 'ended'
    this.stopped++;
  }

  getSettings() {
    return { ...this._settings };
  }

  getCapabilities() {
    return this._caps;
  }

  applyConstraints(c) {
    this.applied.push(c);
    return this.rejectApply(c) ? Promise.reject(Object.assign(new Error('x'), { name: 'OverconstrainedError' })) : Promise.resolve();
  }

  fire(type) {
    if (type === 'mute') this.muted = true;
    if (type === 'unmute') this.muted = false;
    if (type === 'ended') this.readyState = 'ended';
    this.dispatchEvent(new Event(type));
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
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

class FakeVideo {
  constructor() {
    this.attrs = {};
    this.paused = true;
    this.readyState = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.playCalls = 0;
    this.srcObject = null;
  }

  setAttribute(k, v) {
    this.attrs[k] = v;
  }

  play() {
    this.playCalls++;
    this.paused = false;
    this.readyState = 4;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

class FakeDoc extends EventTarget {
  constructor() {
    super();
    this.visibilityState = 'visible';
    this.videos = [];
  }

  createElement(tag) {
    assert.equal(tag, 'video');
    const v = new FakeVideo();
    this.videos.push(v);
    return v;
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

function domError(name, extra = {}) {
  return Object.assign(new Error(name), { name, ...extra });
}

/**
 * perm: 'granted' | 'prompt' | 'denied' | 'throws' | 'missing'. gum(constraints, n) → Promise<stream> thay cách mở.
 */
function makeEnv({ perm = 'granted', gum = null, imageCapture = true, caps = {}, canResume } = {}) {
  const env = { perm, tracks: [], grabs: 0, grabImpl: null, bitmaps: [], clock: { t: 0 }, timers: [] };
  // Hẹn giờ giả: env.runTimers() chạy các hẹn đã đến hạn theo thứ tự (không chờ thật).
  let timerId = 0;
  env.setTimeout = (fn, ms) => {
    const id = ++timerId;
    env.timers.push({ id, fn, ms });
    return id;
  };
  env.clearTimeout = (id) => {
    env.timers = env.timers.filter((t) => t.id !== id);
  };
  env.runTimers = async () => {
    const due = env.timers;
    env.timers = [];
    for (const t of due) t.fn();
    await settle();
    return due.map((t) => t.ms);
  };
  const md = new EventTarget();
  md.calls = [];
  md.devices = [
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
    { kind: 'videoinput', deviceId: 'cam-front', label: 'camera 1, facing front' },
    { kind: 'videoinput', deviceId: 'cam-back', label: 'camera 0, facing back' },
  ];
  md.enumerateDevices = () => Promise.resolve(md.devices.map((d) => ({ ...d })));
  md.getUserMedia = (c) => {
    md.calls.push(c);
    if (gum) return gum(c, md.calls.length);
    const track = new FakeTrack({ deviceId: c.video.deviceId?.exact || 'cam-back', caps: env.caps });
    env.tracks.push(track);
    return Promise.resolve(new FakeStream(track));
  };
  env.caps = caps;
  env.md = md;
  env.nav = { mediaDevices: md };
  if (perm !== 'missing') {
    env.nav.permissions = {
      query: async (desc) => {
        assert.deepEqual(desc, { name: 'camera' });
        if (env.perm === 'throws') throw new TypeError('camera is not a valid permission name');
        return { state: env.perm };
      },
    };
  }
  env.doc = new FakeDoc();
  class FakeImageCapture {
    constructor(track) {
      this.track = track;
    }

    grabFrame() {
      env.grabs++;
      if (env.grabImpl) return env.grabImpl();
      const b = new FakeBitmap(1920, 1080);
      env.bitmaps.push(b);
      return Promise.resolve(b);
    }
  }
  env.cib = (v) => {
    const b = new FakeBitmap(v.videoWidth, v.videoHeight);
    env.bitmaps.push(b);
    return Promise.resolve(b);
  };
  env.cam = new CameraService({
    navigator: env.nav,
    document: env.doc,
    ImageCapture: imageCapture ? FakeImageCapture : null,
    createImageBitmap: env.cib,
    now: () => env.clock.t,
    canResume,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
  });
  env.states = [];
  env.cam.onState((s) => env.states.push(s));
  return env;
}

// ---------------------------------------------------------------------------------------------------------------
// cameraSupport

const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';

function supportEnv(over = {}) {
  return {
    isSecureContext: true,
    navigator: { userAgent: CHROME_UA, mediaDevices: { getUserMedia() {} } },
    Worker: function Worker() {},
    OffscreenCanvas: function OffscreenCanvas() {},
    createImageBitmap: () => {},
    crypto: { subtle: {} },
    WebAssembly: globalThis.WebAssembly,
    ...over,
  };
}

test('cameraSupport: Chrome Android trên https dùng được', () => {
  assert.deepEqual(cameraSupport(supportEnv()), { ok: true, reason: null });
});

test('cameraSupport: lý do không dùng được', () => {
  const nav = (o) => ({ navigator: { userAgent: CHROME_UA, mediaDevices: { getUserMedia() {} }, ...o } });
  const cases = [
    [{ isSecureContext: false }, 'insecure'],
    [{ crypto: {} }, 'insecure'], // crypto.subtle chỉ có trong ngữ cảnh an toàn
    [nav({ userAgent: CHROME_UA.replace('Pixel 8)', 'Pixel 8; wv)') }), 'webview?'],
    [nav({ userAgent: `${CHROME_UA} [FBAN/FB4A;FBAV/450.0.0.0;]` }), 'webview?'],
    [nav({ userAgent: `${CHROME_UA} Zalo android/12100` }), 'webview?'],
    [nav({ userAgentData: { brands: [{ brand: 'Android WebView', version: '158' }] } }), 'webview?'],
    [{ navigator: { userAgent: CHROME_UA } }, 'no-gum'],
    [{ navigator: { userAgent: CHROME_UA, mediaDevices: {} } }, 'no-gum'],
    [{ Worker: undefined }, 'no-worker'],
    [{ OffscreenCanvas: undefined }, 'no-offscreen'],
    [{ createImageBitmap: undefined }, 'no-offscreen'],
    [{ WebAssembly: { validate: () => false } }, 'no-simd'],
    [{ WebAssembly: undefined }, 'no-simd'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(cameraSupport(supportEnv(over)), { ok: false, reason }, JSON.stringify(over));
  }
  // Trang không an toàn: báo 'insecure' trước, không báo thiếu getUserMedia
  assert.equal(cameraSupport(supportEnv({ isSecureContext: false, navigator: { userAgent: CHROME_UA } })).reason, 'insecure');
  // Samsung Internet và Chrome trên máy tính không bị coi là WebView
  const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/31.0 Chrome/130.0.0.0 Mobile Safari/537.36';
  assert.equal(cameraSupport(supportEnv(nav({ userAgent: samsung }))).ok, true);
  for (const r of ['insecure', 'webview?', 'no-gum', 'no-worker', 'no-offscreen', 'no-simd']) assert.ok(SUPPORT_TEXT[r]);
});

// ---------------------------------------------------------------------------------------------------------------
// Quy tắc tự mở lại

test('canAutoStart: chỉ khi quyền là granted', () => {
  assert.equal(canAutoStart('granted'), true);
  for (const s of ['prompt', 'denied', 'unknown', undefined, null, 'GRANTED']) assert.equal(canAutoStart(s), false);
});

test('permission(): đọc permissions.query, lỗi hoặc thiếu API thì unknown', async () => {
  for (const [perm, want] of [
    ['granted', 'granted'],
    ['prompt', 'prompt'],
    ['denied', 'denied'],
    ['throws', 'unknown'],
    ['missing', 'unknown'],
  ]) {
    const env = makeEnv({ perm });
    assert.equal(await env.cam.permission(), want, perm);
  }
  const env = makeEnv({ perm: 'weird' });
  assert.equal(await env.cam.permission(), 'unknown');
});

test('tự mở: không bao giờ gọi getUserMedia khi quyền chưa là granted', async () => {
  for (const [perm, code] of [
    ['prompt', 'not-granted'],
    ['denied', 'denied'], // trang bị chặn: báo ngay cách bỏ chặn, không bảo "bật lại khi xe đã đỗ"
    ['throws', 'perm-unknown'],
    ['missing', 'perm-unknown'],
  ]) {
    const env = makeEnv({ perm });
    const r = await env.cam.start({ userGesture: false });
    assert.equal(r, null, perm);
    assert.equal(env.md.calls.length, 0, `${perm}: không được gọi getUserMedia`);
    assert.equal(env.cam.state, `error:${code}`, perm);
    assert.equal(env.cam.error, code);
    assert.ok(CAMERA_ERROR_TEXT[code]);
    assert.deepEqual(env.timers, [], `${perm}: không hẹn tự thử lại`);
    // Mặc định (không ghi userGesture) cũng là tự mở
    await env.cam.start();
    assert.equal(env.md.calls.length, 0, perm);
  }
  assert.match(CAMERA_ERROR_TEXT.denied, /cài đặt trang web/);
  assert.doesNotMatch(CAMERA_ERROR_TEXT.denied, /xe đã đỗ/);
});

test('tự mở khi đã granted; người dùng bấm bật thì được hỏi quyền', async () => {
  const env = makeEnv({ perm: 'granted' });
  const s = await env.cam.start({ userGesture: false });
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.cam.state, 'on');
  assert.deepEqual(s, { width: 1920, height: 1080, frameRate: 15, deviceId: 'cam-back', label: 'camera 0, facing back' });
  assert.deepEqual(env.states, ['starting', 'on']);

  const tap = makeEnv({ perm: 'prompt' });
  await tap.cam.start({ userGesture: true });
  assert.equal(tap.md.calls.length, 1);
  assert.equal(tap.cam.state, 'on');
});

test('getUserMedia nhận đúng ràng buộc của PLAN §4.2', async () => {
  const env = makeEnv();
  await env.cam.start({ userGesture: true });
  assert.deepEqual(env.md.calls[0], {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 15, max: 30 },
    },
  });
  const chosen = makeEnv();
  await chosen.cam.start({ deviceId: 'usb-1', userGesture: true });
  assert.deepEqual(chosen.md.calls[0].video.deviceId, { exact: 'usb-1' });
  assert.equal(chosen.cam.settings.deviceId, 'usb-1');
});

test('trang ẩn: dừng mọi track và trả camera; hiện lại chỉ mở theo quy tắc tự mở', async () => {
  const env = makeEnv({ perm: 'prompt' });
  await env.cam.start({ userGesture: true }); // bấm bật khi đỗ: hỏi quyền, người dùng chọn "chỉ lần này"
  const first = env.tracks[0];
  assert.equal(env.cam.state, 'on');

  env.doc.hide();
  assert.equal(first.stopped, 1);
  assert.equal(first.readyState, 'ended');
  assert.equal(env.cam.state, 'paused');
  assert.equal(env.cam.settings, null);
  assert.equal(await env.cam.grab(), null);

  // Quyền "chỉ lần này" đã hết: hiện lại không được hỏi quyền
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 1, 'không gọi getUserMedia khi quyền là prompt');
  assert.equal(env.cam.state, 'error:not-granted');

  // Quyền đã cấp lâu dài: ẩn rồi hiện thì tự mở lại
  env.perm = 'granted';
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 2);
  assert.equal(env.cam.state, 'on');
  assert.equal(env.tracks[1].readyState, 'live');

  env.doc.hide();
  assert.equal(env.tracks[1].stopped, 1);
  env.perm = 'denied';
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 2);
});

test('trang hiện lại: không tự mở khi canResume() trả false hoặc đã stop()', async () => {
  let may = false;
  const env = makeEnv({ canResume: () => may });
  await env.cam.start({ userGesture: true });
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 1);
  may = true;
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 2);

  env.cam.stop();
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 2, 'đã tắt thì không tự mở');
  assert.equal(env.cam.state, 'off');
});

test('trang ẩn trong lúc đang chờ getUserMedia: camera mở xong bị trả ngay', async () => {
  let resolve;
  const track = new FakeTrack();
  const env = makeEnv({ gum: () => new Promise((r) => (resolve = r)) });
  const p = env.cam.start({ userGesture: true });
  await settle();
  assert.equal(env.cam.state, 'starting');
  env.doc.hide();
  assert.equal(env.cam.state, 'paused');
  resolve(new FakeStream(track));
  assert.equal(await p, null);
  assert.equal(track.stopped, 1);
  assert.equal(env.cam.state, 'paused');
});

test('start() khi trang đang ẩn: không mở, đợi trang hiện', async () => {
  const env = makeEnv();
  env.doc.visibilityState = 'hidden';
  assert.equal(await env.cam.start({ userGesture: true }), null);
  assert.equal(env.md.calls.length, 0);
  assert.equal(env.cam.state, 'paused');
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.cam.state, 'on');
});

// ---------------------------------------------------------------------------------------------------------------
// Lỗi khi mở camera

test('OverconstrainedError: thử lại với ràng buộc nới dần', async () => {
  const env = makeEnv({
    gum: (c, n) => {
      if (n === 1) return Promise.reject(domError('OverconstrainedError', { constraint: 'frameRate' }));
      const t = new FakeTrack({ width: 1280, height: 720 });
      env.tracks.push(t);
      return Promise.resolve(new FakeStream(t));
    },
  });
  const s = await env.cam.start({ userGesture: true });
  assert.equal(env.md.calls.length, 2);
  assert.deepEqual(env.md.calls[1].video, {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 15 },
  });
  assert.equal(s.width, 1280);
  assert.equal(env.cam.state, 'on');

  const never = makeEnv({ gum: () => Promise.reject(domError('OverconstrainedError', { constraint: 'width' })) });
  assert.equal(await never.cam.start({ userGesture: true }), null);
  assert.equal(never.md.calls.length, CONSTRAINT_STEPS);
  assert.deepEqual(never.md.calls[2].video, { facingMode: { ideal: 'environment' } });
  assert.equal(never.cam.state, 'error:overconstrained');

  // Camera đã chọn không còn: không lặng lẽ đổi sang camera khác
  const gone = makeEnv({ gum: () => Promise.reject(domError('OverconstrainedError', { constraint: 'deviceId' })) });
  await gone.cam.start({ deviceId: 'usb-1', userGesture: true });
  assert.equal(gone.md.calls.length, 1);
  assert.equal(gone.cam.state, 'error:not-found');
  for (let step = 0; step < CONSTRAINT_STEPS; step++) {
    assert.deepEqual(cameraConstraints(step, 'usb-1').video.deviceId, { exact: 'usb-1' });
  }
});

test('NotAllowedError, NotReadableError, NotFoundError: báo lỗi, không thử lại', async () => {
  for (const [name, code] of [
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotReadableError', 'busy'],
    ['NotFoundError', 'not-found'],
    ['AbortError', 'aborted'],
    ['WeirdError', 'failed'],
  ]) {
    const env = makeEnv({ gum: () => Promise.reject(domError(name)) });
    assert.equal(await env.cam.start({ userGesture: true }), null);
    assert.equal(env.md.calls.length, 1, name);
    assert.equal(env.cam.state, `error:${code}`, name);
    assert.equal(env.cam.error, code);
    assert.ok(CAMERA_ERROR_TEXT[code]);
    // Chỉ camera bận / lần mở bị huỷ mới hẹn tự thử lại (xem kiểm thử bên dưới)
    assert.deepEqual(env.timers.map((t) => t.ms), RETRY_CODES.includes(code) ? [RETRY_DELAYS_MS[0]] : [], name);
  }
  assert.equal(errorCode(null), 'failed');
  assert.equal(errorCode(new TypeError('x')), 'unsupported');
  for (const code of CAMERA_ERROR_CODES) assert.ok(CAMERA_ERROR_TEXT[code], code);

  const none = makeEnv();
  none.nav.mediaDevices = undefined;
  const cam = new CameraService({ navigator: { permissions: none.nav.permissions }, document: none.doc, ImageCapture: null });
  assert.equal(await cam.start({ userGesture: true }), null);
  assert.equal(cam.state, 'error:unsupported');
});

test('camera bận khi tự mở lại: thử lại sau 2 s rồi 10 s, theo quy tắc tự mở', async () => {
  assert.deepEqual(RETRY_DELAYS_MS, [2000, 10000]);
  assert.deepEqual(RETRY_CODES, ['busy', 'aborted']);
  // Trang hiện lại trong lúc ứng dụng khác (camera, ghi hình hành trình) chưa trả camera xong
  let busyLeft = 1;
  const env = makeEnv({
    gum: (c) => {
      if (busyLeft > 0) {
        busyLeft--;
        return Promise.reject(domError('NotReadableError'));
      }
      const t = new FakeTrack();
      env.tracks.push(t);
      return Promise.resolve(new FakeStream(t));
    },
  });
  busyLeft = 0;
  await env.cam.start({ userGesture: true });
  assert.equal(env.cam.state, 'on');
  env.doc.hide();
  busyLeft = 1;
  env.doc.show();
  await settle();
  assert.equal(env.cam.state, 'error:busy');
  assert.equal(env.md.calls.length, 2);
  assert.deepEqual(await env.runTimers(), [2000]);
  assert.equal(env.md.calls.length, 3);
  assert.equal(env.cam.state, 'on', 'trang vẫn hiện: tự mở lại được');
  assert.deepEqual(env.timers, []);

  // Bận mãi: thử đúng RETRY_DELAYS_MS.length lần rồi thôi
  busyLeft = Infinity;
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 4);
  assert.deepEqual(await env.runTimers(), [2000]);
  assert.deepEqual(await env.runTimers(), [10000]);
  assert.deepEqual(await env.runTimers(), []);
  assert.equal(env.md.calls.length, 6);
  assert.equal(env.cam.state, 'error:busy');
  // Một lần mở mới (trang hiện lại, main.js gọi start) lại được thử lại từ đầu
  await env.cam.start();
  assert.equal(env.md.calls.length, 7);
  assert.deepEqual(env.timers.map((t) => t.ms), [2000]);
  // stop() huỷ lần thử đang hẹn
  env.cam.stop();
  assert.deepEqual(env.timers, []);
  assert.equal(env.cam.state, 'off');
});

test('tự thử lại chỉ khi trang hiện, vẫn muốn chạy, canResume() và quyền đã cấp', async () => {
  let may = true;
  const env = makeEnv({ gum: () => Promise.reject(domError('AbortError')), canResume: () => may });
  await env.cam.start({ userGesture: true });
  assert.equal(env.cam.state, 'error:aborted');
  // Quyền "chỉ lần này" đã hết trước lúc thử lại: không gọi getUserMedia, không hỏi quyền
  env.perm = 'prompt';
  await env.runTimers();
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.cam.state, 'error:not-granted');
  assert.deepEqual(env.timers, [], 'không thử lại tiếp');

  env.perm = 'granted';
  await env.cam.start({ userGesture: true });
  assert.equal(env.md.calls.length, 2);
  env.doc.visibilityState = 'hidden'; // trang ẩn (sự kiện chưa tới): không thử
  await env.runTimers();
  assert.equal(env.md.calls.length, 2);
  env.doc.show(); // trang hiện lại thì tự mở như thường
  await settle();
  assert.equal(env.md.calls.length, 3);

  may = false; // đã rời chế độ lái
  await env.runTimers();
  assert.equal(env.md.calls.length, 3);
  // Lỗi khác (không tìm thấy camera) không tự thử lại
  const nf = makeEnv({ gum: () => Promise.reject(domError('NotFoundError')) });
  await nf.cam.start({ userGesture: true });
  assert.deepEqual(nf.timers, []);
  // suspend() (lâu không lấy khung) và dispose() cũng huỷ hẹn
  const d = makeEnv({ gum: () => Promise.reject(domError('NotReadableError')) });
  await d.cam.start({ userGesture: true });
  assert.equal(d.timers.length, 1);
  d.cam.suspend();
  assert.deepEqual(d.timers, []);
  await d.cam.start();
  assert.equal(d.timers.length, 1);
  d.cam.dispose();
  assert.deepEqual(d.timers, []);
});

test('ràng buộc từng bậc', () => {
  assert.deepEqual(cameraConstraints(0).video.frameRate, { ideal: IDEAL_FPS, max: MAX_FPS });
  assert.deepEqual(cameraConstraints(0).video.width, { ideal: IDEAL_WIDTH });
  assert.deepEqual(cameraConstraints(0).video.height, { ideal: IDEAL_HEIGHT });
  assert.deepEqual(cameraConstraints(1).video.width, { ideal: RELAXED_WIDTH });
  assert.deepEqual(cameraConstraints(1).video.height, { ideal: RELAXED_HEIGHT });
  assert.equal(cameraConstraints(2).video.width, undefined);
  assert.equal(cameraConstraints(0).audio, false);
  assert.equal(cameraConstraints(0).video.deviceId, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// start() một lần, stop() an toàn

test('start() gọi nhiều lần chỉ mở một lần; đổi camera thì đóng camera cũ', async () => {
  const env = makeEnv();
  const a = env.cam.start({ userGesture: true });
  const b = env.cam.start({ userGesture: true });
  assert.equal(a, b);
  await a;
  await env.cam.start();
  await env.cam.start({ userGesture: false });
  assert.equal(env.md.calls.length, 1);
  assert.deepEqual(env.states, ['starting', 'on']);

  await env.cam.start({ deviceId: 'usb-1', userGesture: true });
  assert.equal(env.md.calls.length, 2);
  assert.equal(env.tracks[0].stopped, 1);
  assert.equal(env.cam.settings.deviceId, 'usb-1');
  // Bỏ qua deviceId: giữ camera đã chọn
  await env.cam.start();
  assert.equal(env.md.calls.length, 2);
});

test('bấm bật trong lúc lần tự mở đang chờ: mở lại có hỏi quyền', async () => {
  const env = makeEnv({ perm: 'prompt' });
  const auto = env.cam.start({ userGesture: false });
  const tap = env.cam.start({ userGesture: true });
  assert.notEqual(auto, tap);
  assert.equal(await auto, null);
  await tap;
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.cam.state, 'on');
});

test('stop() gọi hai lần vẫn an toàn; stop() trong lúc đang mở thì trả camera khi mở xong', async () => {
  const env = makeEnv();
  await env.cam.start({ userGesture: true });
  env.cam.stop();
  env.cam.stop();
  assert.equal(env.tracks[0].stopped, 1);
  assert.equal(env.cam.state, 'off');
  assert.deepEqual(env.states, ['starting', 'on', 'off']);
  assert.equal(await env.cam.grab(), null);

  let resolve;
  const track = new FakeTrack();
  const slow = makeEnv({ gum: () => new Promise((r) => (resolve = r)) });
  const p = slow.cam.start({ userGesture: true });
  await settle();
  slow.cam.stop();
  resolve(new FakeStream(track));
  assert.equal(await p, null);
  assert.equal(track.stopped, 1);
  assert.equal(slow.cam.state, 'off');

  const idle = makeEnv();
  idle.cam.stop();
  assert.deepEqual(idle.states, []);
  idle.cam.dispose();
  idle.doc.hide();
  idle.doc.show();
});

test('suspend(): trả camera nhưng vẫn giữ ý muốn chạy; mở lại theo quy tắc tự mở', async () => {
  const env = makeEnv({ perm: 'prompt' });
  env.cam.suspend(); // chưa mở: không làm gì
  assert.deepEqual(env.states, []);
  await env.cam.start({ deviceId: 'usb-1', userGesture: true });
  env.cam.suspend();
  assert.equal(env.tracks[0].stopped, 1);
  assert.equal(env.cam.state, 'paused');
  assert.equal(await env.cam.grab(), null);
  await env.cam.start(); // quyền chỉ một lần đã hết: không hỏi lại
  assert.equal(env.md.calls.length, 1);
  assert.equal(env.cam.state, 'error:not-granted');
  env.perm = 'granted';
  await env.cam.start();
  assert.equal(env.md.calls.length, 2);
  assert.deepEqual(env.md.calls[1].video.deviceId, { exact: 'usb-1' }, 'giữ camera đã chọn');
  env.cam.suspend();
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 3, 'trang hiện lại: tự mở lại vì vẫn muốn chạy');
});

// ---------------------------------------------------------------------------------------------------------------
// Sự kiện của track, rút camera

test("track 'ended' (camera bị ngắt) và 'mute'/'unmute'", async () => {
  const env = makeEnv();
  await env.cam.start({ userGesture: true });
  const t = env.tracks[0];
  t.fire('mute');
  assert.equal(env.cam.state, 'paused');
  assert.equal(await env.cam.grab(), null);
  assert.equal(env.grabs, 0);
  t.fire('unmute');
  assert.equal(env.cam.state, 'on');
  assert.ok(await env.cam.grab());

  t.fire('ended');
  assert.equal(env.cam.state, 'error:ended');
  assert.equal(t.stopped, 1);
  assert.equal(env.cam.settings, null);
  // Trang ẩn rồi hiện: thử mở lại theo quy tắc tự mở (quyền đã cấp)
  env.doc.hide();
  env.doc.show();
  await settle();
  assert.equal(env.md.calls.length, 2);
  assert.equal(env.cam.state, 'on');
});

test('mở xong mà track đang tắt hình (muted) thì là paused', async () => {
  const env = makeEnv({
    gum: () => {
      const t = new FakeTrack();
      t.muted = true;
      env.tracks.push(t);
      return Promise.resolve(new FakeStream(t));
    },
  });
  await env.cam.start({ userGesture: true });
  assert.equal(env.cam.state, 'paused');
  env.tracks[0].fire('unmute');
  assert.equal(env.cam.state, 'on');
});

test('rút camera đang dùng: error:unplugged; cắm lại thì tự mở lại khi quyền đã cấp', async () => {
  const env = makeEnv();
  env.md.devices.push({ kind: 'videoinput', deviceId: 'usb-1', label: 'USB camera' });
  await env.cam.start({ deviceId: 'usb-1', userGesture: true });
  const t = env.tracks[0];
  env.md.devices = env.md.devices.filter((d) => d.deviceId !== 'usb-1');
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.cam.state, 'error:unplugged');
  assert.equal(t.stopped, 1);

  // Thiết bị khác thay đổi, camera vẫn chưa cắm lại: không làm gì
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.md.calls.length, 1);

  env.perm = 'prompt';
  env.md.devices.push({ kind: 'videoinput', deviceId: 'usb-1', label: 'USB camera' });
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.md.calls.length, 1, 'quyền chưa cấp: không mở, không hỏi');

  env.perm = 'granted';
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.md.calls.length, 2);
  assert.equal(env.cam.state, 'on');
  assert.deepEqual(env.md.calls[1].video.deviceId, { exact: 'usb-1' });

  // Thiết bị khác cắm vào trong lúc camera chạy: không làm gì
  env.md.devices.push({ kind: 'videoinput', deviceId: 'usb-2', label: 'USB 2' });
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.cam.state, 'on');
  // Danh sách không có mã thiết bị: không kết luận
  env.md.devices = env.md.devices.map((d) => ({ ...d, deviceId: '' }));
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.cam.state, 'on');
});

test('rút camera cũ trong lúc người dùng đổi sang camera khác: không đóng camera mới', async () => {
  const env = makeEnv();
  env.md.devices.push({ kind: 'videoinput', deviceId: 'usb-1', label: 'USB 1' }, { kind: 'videoinput', deviceId: 'usb-2', label: 'USB 2' });
  await env.cam.start({ deviceId: 'usb-1', userGesture: true });
  // enumerateDevices chậm: trả danh sách lúc usb-1 đã rút
  let release;
  const enumerate = env.md.enumerateDevices;
  env.md.enumerateDevices = () => new Promise((r) => (release = () => r(enumerate())));
  env.md.devices = env.md.devices.filter((d) => d.deviceId !== 'usb-1');
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  await env.cam.start({ deviceId: 'usb-2', userGesture: true }); // "Kiểm tra camera": chọn usb-2
  assert.equal(env.cam.state, 'on');
  release();
  await settle();
  assert.equal(env.cam.state, 'on', 'usb-2 vẫn chạy');
  assert.equal(env.tracks[1].stopped, 0);
  assert.equal(env.cam.settings.deviceId, 'usb-2');

  // Camera đang chạy bị rút trong lúc chờ danh sách: vẫn đóng như thường
  env.md.devices = env.md.devices.filter((d) => d.deviceId !== 'usb-2');
  env.md.dispatchEvent(new Event('devicechange'));
  await settle();
  release();
  await settle();
  assert.equal(env.cam.state, 'error:unplugged');
  assert.equal(env.tracks[1].stopped, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Lấy khung

test('grab(): ImageCapture.grabFrame(), dấu thời gian lấy lúc xong, mỗi lần một khung', async () => {
  const env = makeEnv();
  await env.cam.start({ userGesture: true });
  let resolve;
  env.grabImpl = () => new Promise((r) => (resolve = r));
  env.clock.t = 100;
  const p = env.cam.grab();
  assert.equal(await env.cam.grab(), null, 'đang lấy một khung');
  env.clock.t = 150;
  const bm = new FakeBitmap(1920, 1080);
  resolve(bm);
  const f = await p;
  assert.equal(f.bitmap, bm);
  assert.equal(f.t, 150);
  assert.equal(bm.closed, false);

  // stop() trong lúc đang lấy: đóng khung, trả null
  const q = env.cam.grab();
  env.cam.stop();
  const late = new FakeBitmap(1920, 1080);
  resolve(late);
  assert.equal(await q, null);
  assert.equal(late.closed, true);
});

test('grabFrame() hỏng liên tiếp: chuyển sang video ẩn; không có cách khác thì error:grab', async () => {
  const env = makeEnv();
  await env.cam.start({ userGesture: true });
  env.grabImpl = () => Promise.reject(domError('UnknownError'));
  for (let i = 0; i < GRAB_SWITCH_FAILS; i++) assert.equal(await env.cam.grab(), null);
  assert.equal(env.doc.videos.length, 1);
  assert.equal(env.doc.videos[0].playCalls, 1);
  const f = await env.cam.grab();
  assert.equal(f.bitmap.width, 1280);
  assert.equal(env.cam.state, 'on');

  // Tự mở (không có lần bấm bật nào): không được play() video ẩn, nên hỏng mãi thì báo lỗi
  const auto = makeEnv();
  await auto.cam.start({ userGesture: false });
  auto.grabImpl = () => Promise.reject(domError('UnknownError'));
  for (let i = 0; i < GRAB_FAIL_MAX - 1; i++) await auto.cam.grab();
  assert.equal(auto.cam.state, 'on');
  await auto.cam.grab();
  assert.equal(auto.cam.state, 'error:grab');
  assert.equal(auto.tracks[0].stopped, 1);
  assert.equal(auto.doc.videos.length, 0);
});

test('không có ImageCapture: video ẩn chỉ play() sau lần bấm bật, không autoplay', async () => {
  const auto = makeEnv({ imageCapture: false });
  assert.equal(await auto.cam.start({ userGesture: false }), null);
  assert.equal(auto.md.calls.length, 0, 'tự mở mà chưa có lần bấm nào: không mở');
  assert.equal(auto.cam.state, 'error:needs-gesture');

  const env = makeEnv({ imageCapture: false });
  await env.cam.start({ userGesture: true });
  const v = env.doc.videos[0];
  assert.equal(v.srcObject.track, env.tracks[0]);
  assert.equal(v.muted, true);
  assert.equal(v.playsInline, true);
  assert.equal('autoplay' in v.attrs, false);
  assert.equal(v.autoplay, undefined);
  assert.equal(v.playCalls, 1);
  env.clock.t = 42;
  const f = await env.cam.grab();
  assert.equal(f.bitmap.width, 1280);
  assert.equal(f.t, 42);
  // Video chưa có hình: null nhưng không tính là lỗi
  v.readyState = VIDEO_READY - 1;
  assert.equal(await env.cam.grab(), null);
  assert.equal(env.cam.state, 'on');

  // Ẩn rồi hiện (cùng phiên, đã có lần bấm): mở lại và play() video mới
  env.doc.hide();
  assert.equal(v.srcObject, null);
  env.doc.show();
  await settle();
  assert.equal(env.doc.videos.length, 2);
  assert.equal(env.doc.videos[1].playCalls, 1);
});

test('createImageBitmap được gọi với this là globalThis (gọi rời sẽ ném Illegal invocation)', async () => {
  const env = makeEnv({ imageCapture: false });
  const seen = [];
  const cam = new CameraService({
    navigator: env.nav,
    document: env.doc,
    ImageCapture: null,
    createImageBitmap: function (src) {
      seen.push(this === globalThis);
      return Promise.resolve(new FakeBitmap(src.videoWidth, src.videoHeight));
    },
  });
  await cam.start({ userGesture: true });
  const f = await cam.grab();
  assert.equal(f.bitmap.width, 1280);
  assert.deepEqual(seen, [true]);
  cam.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// Lấy nét, danh sách camera, thông số

test('lấy nét: khoá ở xa nhất nếu được, không thì liên tục; lỗi thì bỏ qua', async () => {
  const far = makeEnv({ caps: { focusMode: ['manual', 'continuous'], focusDistance: { min: 0.1, max: 10 } } });
  await far.cam.start({ userGesture: true });
  assert.deepEqual(far.tracks[0].applied, [{ advanced: [{ focusMode: 'manual', focusDistance: 10 }] }]);
  assert.equal(far.cam.focus, 'far');

  const cont = makeEnv({ caps: { focusMode: ['continuous', 'single-shot'] } });
  await cont.cam.start({ userGesture: true });
  assert.deepEqual(cont.tracks[0].applied, [{ advanced: [{ focusMode: 'continuous' }] }]);
  assert.equal(cont.cam.focus, 'continuous');

  const none = makeEnv({ caps: {} });
  await none.cam.start({ userGesture: true });
  assert.deepEqual(none.tracks[0].applied, []);
  assert.equal(none.cam.focus, null);

  const bad = makeEnv({
    gum: () => {
      const t = new FakeTrack({ caps: { focusMode: ['manual', 'continuous'], focusDistance: { max: 5 } } });
      t.rejectApply = (c) => c.advanced[0].focusMode === 'manual';
      bad.tracks.push(t);
      return Promise.resolve(new FakeStream(t));
    },
  });
  await bad.cam.start({ userGesture: true });
  assert.equal(bad.tracks[0].applied.length, 2);
  assert.equal(bad.cam.focus, 'continuous');
  assert.equal(bad.cam.state, 'on');

  const worse = makeEnv({
    gum: () => {
      const t = new FakeTrack({ caps: { focusMode: ['continuous'] } });
      t.rejectApply = () => true;
      return Promise.resolve(new FakeStream(t));
    },
  });
  await worse.cam.start({ userGesture: true });
  assert.equal(worse.cam.focus, null);
  assert.equal(worse.cam.state, 'on');
});

test('list(): chỉ camera; lỗi thì danh sách rỗng', async () => {
  const env = makeEnv();
  assert.deepEqual(await env.cam.list(), [
    { deviceId: 'cam-front', label: 'camera 1, facing front' },
    { deviceId: 'cam-back', label: 'camera 0, facing back' },
  ]);
  env.md.enumerateDevices = () => Promise.reject(new Error('x'));
  assert.deepEqual(await env.cam.list(), []);
});

test('settings: null khi tắt, thông số thật khi chạy', async () => {
  const env = makeEnv();
  assert.equal(env.cam.settings, null);
  await env.cam.start({ userGesture: true });
  assert.deepEqual(Object.keys(env.cam.settings).sort(), ['deviceId', 'frameRate', 'height', 'label', 'width']);
  env.tracks[0]._settings = { width: 1080, height: 1920, frameRate: 30, deviceId: 'cam-back' };
  assert.equal(env.cam.settings.width, 1080, 'đọc lại mỗi lần (xoay máy)');
});

test('lỗi của người nghe onState không làm hỏng camera; huỷ nghe được', async () => {
  const env = makeEnv();
  env.cam.onState(() => {
    throw new Error('boom');
  });
  const seen = [];
  const off = env.cam.onState((s) => seen.push(s));
  await env.cam.start({ userGesture: true });
  off();
  env.cam.stop();
  assert.deepEqual(seen, ['starting', 'on']);
  assert.equal(env.cam.state, 'off');
});

// ---------------------------------------------------------------------------------------------------------------
// Xe đã đỗ, có lấy khung không, pin

test('isStill / isParked: ngoài chế độ lái, đứng yên ít nhất 5 giây', () => {
  assert.equal(PARK_SPEED, 1);
  assert.equal(PARK_STILL_MS, 5000);
  assert.deepEqual([...DRIVING_MODES].sort(), ['drive', 'nav']);
  assert.equal(isStill({ speed: 0.99 }), true);
  assert.equal(isStill({ speed: 1 }), false);
  assert.equal(isStill({ speed: null }), true, 'không có tốc độ: như main.js');
  assert.equal(isStill({ speed: 5, carStationary: true }), true, 'xe báo đứng yên thắng GPS trễ');
  assert.equal(isStill({ speed: 0, carStationary: false }), false, 'xe báo đang chạy');

  assert.equal(isParked({ mode: 'browse', speed: 0, sinceMs: 5000 }), true);
  assert.equal(isParked({ mode: 'browse', speed: 0, sinceMs: 4999 }), false);
  assert.equal(isParked({ mode: 'place', speed: 0.5, sinceMs: 60e3 }), true);
  assert.equal(isParked({ mode: 'browse', speed: 1.2, sinceMs: 60e3 }), false);
  assert.equal(isParked({ mode: 'drive', speed: 0, sinceMs: 600e3 }), false, 'dừng đèn đỏ không phải đã đỗ');
  assert.equal(isParked({ mode: 'nav', speed: 0, carStationary: true, sinceMs: 600e3 }), false);
  assert.equal(isParked({ mode: 'browse', speed: 3, carStationary: true, sinceMs: 6000 }), true);
  assert.equal(isParked({ mode: 'browse', speed: 0, carStationary: false, sinceMs: 6000 }), false);
  assert.equal(isParked({ mode: 'browse', speed: 0 }), false);
  assert.equal(isParked(), false);
});

test('StillTimer đếm thời gian đứng yên liên tục', () => {
  let t = 0;
  const st = new StillTimer({ now: () => t });
  assert.equal(st.update({ speed: 0 }), 0);
  t = 3000;
  assert.equal(st.update({ speed: 0.3 }), 3000);
  t = 4000;
  assert.equal(st.update({ speed: 2 }), 0);
  t = 5000;
  st.update({ speed: 0 });
  t = 10e3;
  assert.equal(st.sinceMs(), 5000);
  assert.equal(isParked({ mode: 'browse', speed: 0, sinceMs: st.sinceMs() }), true);
  st.reset();
  assert.equal(st.sinceMs(), 0);
});

test('shouldCapture / captureBlock: PLAN §5.1', () => {
  assert.equal(CAPTURE_SPEED, 3);
  assert.equal(BATTERY_MIN, 0.2);
  const ok = { camEnabled: true, mode: 'drive', visible: true, speed: 10, battery: { level: 0.8, charging: false }, simulated: false };
  assert.equal(captureBlock(ok), null);
  assert.equal(shouldCapture(ok), true);
  assert.equal(shouldCapture({ ...ok, mode: 'nav' }), true);
  const cases = [
    [{ camEnabled: false }, 'off'],
    [{ mode: 'browse' }, 'mode'],
    [{ mode: 'routes' }, 'mode'],
    [{ visible: false }, 'hidden'],
    [{ simulated: true }, 'simulated'],
    [{ speed: 2.99 }, 'slow'],
    [{ speed: null }, 'slow'],
    [{ battery: { level: 0.19, charging: false } }, 'battery'],
  ];
  for (const [over, why] of cases) {
    assert.equal(captureBlock({ ...ok, ...over }), why, JSON.stringify(over));
    assert.equal(shouldCapture({ ...ok, ...over }), false);
  }
  assert.equal(shouldCapture({ ...ok, speed: 3 }), true);
  assert.equal(shouldCapture({ ...ok, battery: { level: 0.2, charging: false } }), true);
  assert.equal(shouldCapture({ ...ok, battery: { level: 0.05, charging: true } }), true);
  assert.equal(shouldCapture({ ...ok, battery: null }), true, 'không đọc được pin: vẫn chạy');
  assert.equal(shouldCapture({ ...ok, battery: { level: NaN, charging: false } }), true);
  assert.equal(shouldCapture(), false);
});

test('pin yếu thì tạm dừng, cắm sạc thì chạy lại (watchBattery)', async () => {
  const bm = new EventTarget();
  bm.level = 0.5;
  bm.charging = false;
  const seen = [];
  const off = await watchBattery((b) => seen.push(b), { navigator: { getBattery: async () => bm } });
  const gate = () => shouldCapture({ camEnabled: true, mode: 'drive', visible: true, speed: 12, battery: seen.at(-1) });
  assert.deepEqual(seen, [{ level: 0.5, charging: false }]);
  assert.equal(gate(), true);
  bm.level = 0.19;
  bm.dispatchEvent(new Event('levelchange'));
  assert.equal(gate(), false);
  assert.equal(captureBlock({ camEnabled: true, mode: 'drive', visible: true, speed: 12, battery: seen.at(-1) }), 'battery');
  bm.charging = true;
  bm.dispatchEvent(new Event('chargingchange'));
  assert.equal(gate(), true);
  bm.charging = false;
  bm.dispatchEvent(new Event('chargingchange'));
  assert.equal(gate(), false);
  off();
  bm.level = 0.9;
  bm.dispatchEvent(new Event('levelchange'));
  assert.equal(seen.length, 4, 'đã huỷ theo dõi');

  const none = [];
  await watchBattery((b) => none.push(b), { navigator: {} });
  assert.deepEqual(none, [null]);
});

test('holdCamera: đóng hẳn camera khi không lấy khung quá lâu', () => {
  assert.equal(IDLE_RELEASE_MS, 120e3);
  assert.equal(holdCamera({ block: null }), true);
  for (const b of ['off', 'mode', 'hidden']) assert.equal(holdCamera({ block: b, blockedMs: 0 }), false, b);
  for (const b of ['slow', 'battery', 'simulated']) {
    assert.equal(holdCamera({ block: b, blockedMs: IDLE_RELEASE_MS - 1 }), true, b);
    assert.equal(holdCamera({ block: b, blockedMs: IDLE_RELEASE_MS }), false, b);
  }
  assert.equal(holdCamera(), true);
});

test('foeFor: giữa khung, 0,42 chiều cao, cộng camAim, giữ trong khung', () => {
  assert.equal(FOE_Y_FRAC, 0.42);
  const near = (p, x, y) => assert.ok(Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9, JSON.stringify(p));
  near(foeFor({ dx: 0, dy: 0 }, 1920, 1080), 960, 453.6);
  near(foeFor({ dx: -100, dy: 40 }, 1920, 1080), 860, 493.6);
  near(foeFor(null, 1280, 720), 640, 302.4);
  near(foeFor({ dx: NaN, dy: 'x' }, 1280, 720), 640, 302.4);
  assert.deepEqual(foeFor({ dx: 5000, dy: -5000 }, 1920, 1080), { x: 1920, y: 0 });
  assert.deepEqual(foeFor({ dx: -5000, dy: 5000 }, 1920, 1080), { x: 0, y: 1080 });
});

test('store.js: các cài đặt mới của camera (hợp đồng 7)', () => {
  assert.equal(DEFAULT_SETTINGS.camEnabled, false);
  assert.equal(DEFAULT_SETTINGS.camDeviceId, null);
  assert.deepEqual(DEFAULT_SETTINGS.camAim, { dx: 0, dy: 0 });
  // settings chép nông từ DEFAULT_SETTINGS nên camAim dùng chung: phải đóng băng để sửa tại chỗ thì ném lỗi
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.camAim), true);
  assert.throws(() => {
    DEFAULT_SETTINGS.camAim.dx = 40;
  }, TypeError);
  assert.deepEqual(DEFAULT_SETTINGS.camAim, { dx: 0, dy: 0 });
  assert.equal(DEFAULT_SETTINGS.signCamera, true);
  assert.equal(DEFAULT_SETTINGS.camSpeed, true);
  assert.equal(DEFAULT_SETTINGS.camEval, false);
});

// ---------------------------------------------------------------------------------------------------------------
// LevelScheduler

/** Chạy bộ lập lịch theo đồng hồ giả: cost(passes, level) là thời gian worker giả của mỗi khung. */
function drive(s, clock, ms, cost) {
  const end = clock.t + ms;
  while (clock.t < end) {
    const p = s.plan(clock.t);
    if (p.level === 0) {
      clock.t += Math.min(p.intervalMs, end - clock.t);
      continue;
    }
    s.record(cost(p.passes, p.level), { at: clock.t, passes: p.passes });
    clock.t += p.intervalMs;
  }
}

const byPass = (a, ab) => (passes) => (passes.includes('B') ? ab : a);

test('LevelScheduler: hằng số của PLAN §5.6', () => {
  assert.deepEqual(LEVELS, { 1: { fps: 2, b: false }, 2: { fps: 3, b: true }, 3: { fps: 5, b: true } });
  assert.equal(DEFAULT_LEVEL, 2);
  assert.equal(BUDGET_MS_PER_S, 250);
  assert.equal(FAST_P90_MS, 60);
  assert.equal(STEP_UP_MS, 120e3);
  assert.equal(RISE_FACTOR, 1.5);
  assert.equal(BASELINE_MS, 300e3);
  assert.equal(OVER_AT_1_MS, 60e3);
  assert.equal(PAUSE_MS, 300e3);
  assert.equal(WINDOW_MS, 20e3);
  assert.equal(MIN_SAMPLES, 10);
  assert.equal(GAP_MS, 5e3);
  assert.equal(RISE_MIN, 5);
  assert.equal(KEY_WINDOW, 30);
  assert.equal(B_COST_FACTOR, 2);
  assert.equal(BASELINE_MAX, 2000);
});

test('LevelScheduler.plan: nhịp và lượt quét từng mức', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t });
  assert.equal(s.level, 2);
  assert.equal(s.maxLevel, 2);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const p = s.plan();
    seq.push(p.passes.join(''));
    assert.equal(p.level, 2);
    assert.equal(p.intervalMs, 333);
    s.record(20, { passes: p.passes });
    clock.t += p.intervalMs;
  }
  assert.deepEqual(seq, ['A', 'AB', 'A', 'AB'], 'lượt B mỗi khung thứ hai');
  // Kế hoạch chưa được dùng (khung hỏng) thì gọi lại vẫn như cũ
  assert.deepEqual(s.plan().passes, s.plan().passes);

  const one = new LevelScheduler({ now: () => 0, level: 1 });
  assert.deepEqual(one.plan(), { level: 1, intervalMs: 500, passes: ['A'] });
  one.record(20, { passes: ['A'] });
  assert.deepEqual(one.plan().passes, ['A']);

  assert.equal(new LevelScheduler({ level: 3 }).level, 2, 'mức 3 cần lần kiểm tra lúc đỗ');
  assert.equal(new LevelScheduler({ level: 3, parkedP90: 60 }).level, 2);
  const fast = new LevelScheduler({ now: () => 0, level: 3, parkedP90: 59 });
  assert.equal(fast.level, 3);
  assert.equal(fast.plan().intervalMs, 200);
  fast.setParkedCheck({ p90: 75 });
  assert.equal(fast.level, 2);
  assert.equal(fast.maxLevel, 2);
});

test('LevelScheduler: quá ngân sách thì hạ mức', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t });
  const changes = [];
  s.onChange((c) => changes.push(c));
  drive(s, clock, 2000, () => 100); // 100 ms × 3 khung/giây = 300 > 250, nhưng chưa đủ khung
  assert.equal(s.level, 2);
  drive(s, clock, 2000, () => 100);
  assert.equal(s.level, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 2);
  assert.equal(changes[0].level, 1);
  assert.equal(changes[0].reason, 'budget');
  // Ở mức 1: 100 × 2 = 200 ≤ 250, nhưng mức 2 ước 300: không lên lại
  drive(s, clock, 600e3, () => 100);
  assert.equal(s.level, 1);
  assert.equal(s.plan(clock.t).level, 1);

  // Đúng bằng ngân sách thì không hạ
  const c2 = { t: 0 };
  const edge = new LevelScheduler({ now: () => c2.t });
  for (let i = 0; i < 30; i++) edge.record(62.5, { at: i * 250, passes: ['A'] }); // 62,5 ms × 4 khung/giây = 250
  assert.equal(edge.level, 2);
  edge.record(62.5, { at: 30 * 250 - 10, passes: ['A'] });
  assert.equal(edge.level, 1);
});

test('LevelScheduler: dư tải 2 phút thì lên mức', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t, level: 1 });
  const cost = byPass(30, 60);
  drive(s, clock, 120e3, cost); // dư tải tính từ khung thứ 10 (4,5 s)
  assert.equal(s.level, 1);
  drive(s, clock, 10e3, cost);
  assert.equal(s.level, 2);
  // Không có lần kiểm tra lúc đỗ: không lên mức 3 dù còn dư
  drive(s, clock, 600e3, cost);
  assert.equal(s.level, 2);

  // Có kiểm tra lúc đỗ p90 < 60 ms: lên mức 3 sau 2 phút dư tải
  s.setParkedCheck({ p90: 45 });
  drive(s, clock, 119e3, cost);
  assert.equal(s.level, 2);
  drive(s, clock, 10e3, cost);
  assert.equal(s.level, 3);
  assert.equal(s.plan(clock.t).intervalMs, 200);
  // Ở mức 3: (30 + 60)/2 × 5 = 225 ≤ 250, giữ nguyên
  drive(s, clock, 300e3, cost);
  assert.equal(s.level, 3);
});

test('LevelScheduler: ước thời gian khung có lượt B khi chưa đo được', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t, level: 1 });
  // Lượt A 60 ms: mức 2 ước (60 + 2 × 60)/2 × 3 = 270 > 250, nên không lên dù mức 1 chỉ dùng 120 ms mỗi giây
  drive(s, clock, 600e3, () => 60);
  assert.equal(s.level, 1);
});

test('LevelScheduler: ở mức 1 vẫn quá ngân sách 60 giây thì tạm dừng 5 phút', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t });
  const changes = [];
  s.onChange((c) => changes.push(`${c.from}→${c.level}:${c.reason}`));
  drive(s, clock, 4e3, () => 200); // mức 2 → 1 sau khoảng 3 s
  assert.equal(s.level, 1);
  const atOne = clock.t;
  drive(s, clock, 60e3, () => 200); // 200 × 2 = 400 > 250; cần 10 khung (4,5 s) rồi 60 s
  assert.equal(s.level, 1);
  drive(s, clock, 6e3, () => 200);
  assert.equal(s.level, 0);
  const p = s.plan(clock.t);
  assert.equal(p.level, 0);
  assert.deepEqual(p.passes, []);
  assert.ok(p.intervalMs > PAUSE_MS - 7e3 && p.intervalMs <= PAUSE_MS, String(p.intervalMs));
  assert.ok(clock.t - atOne >= OVER_AT_1_MS);
  // Khung lạc vào lúc tạm dừng bị bỏ qua
  s.record(1, { at: clock.t + 1, passes: ['A'] });
  assert.equal(s.level, 0);
  assert.equal(s.stats().level, 0);
  const until = s.pausedUntil;
  assert.equal(s.plan(until - 1).level, 0);
  const after = s.plan(until);
  assert.equal(after.level, 1);
  assert.equal(after.intervalMs, 500);
  assert.equal(s.pausedUntil, null);
  assert.deepEqual(changes, ['2→1:budget', '1→0:budget', '0→1:resume']);
});

test('LevelScheduler: trung vị tăng 1,5 lần so với 5 phút đầu thì hạ mức (máy nóng)', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t });
  const changes = [];
  s.onChange((c) => changes.push(c.reason));
  drive(s, clock, 200e3, byPass(20, 40));
  // Tăng trước khi đủ 5 phút: chưa có mốc, không hạ
  drive(s, clock, 99e3, byPass(29, 58));
  assert.equal(s.level, 2);
  assert.equal(s.stats().baseline, null);
  drive(s, clock, 2e3, byPass(20, 40));
  assert.deepEqual(s.stats().baseline, { A: 20, AB: 40 });
  drive(s, clock, 30e3, byPass(20, 40));

  // Tăng 1,4 lần: không hạ (tải 3 × 42 = 126 vẫn trong ngân sách)
  drive(s, clock, 60e3, byPass(28, 56));
  assert.equal(s.level, 2);
  // Tăng 1,5 lần: hạ dù tải vẫn trong ngân sách
  drive(s, clock, 30e3, byPass(30, 60));
  assert.equal(s.level, 1);
  assert.deepEqual(changes, ['heat']);
  // Còn nóng: không lên lại
  drive(s, clock, 300e3, byPass(30, 60));
  assert.equal(s.level, 1);
  // Nguội lại: sau 2 phút dư tải thì lên
  drive(s, clock, 30e3, byPass(20, 40));
  assert.equal(s.level, 1);
  drive(s, clock, 120e3, byPass(20, 40));
  assert.equal(s.level, 2);
  assert.deepEqual(changes, ['heat', 'headroom']);
});

test('LevelScheduler: khoảng nghỉ dài thì đo lại số khung mỗi giây nhưng giữ thời gian dư tải', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t, level: 1 });
  const cost = byPass(30, 60);
  drive(s, clock, 100e3, cost);
  assert.ok(s.stats().median != null);
  const head = s.stats().headroomMs;
  assert.ok(head > 90e3 && head < STEP_UP_MS, String(head));
  clock.t += GAP_MS + 1; // xe dừng đèn đỏ: không lấy khung
  s.record(30, { at: clock.t, passes: ['A'] });
  assert.equal(s.stats().median, null, 'cửa sổ đã xoá');
  assert.equal(s.stats().headroomMs, head, 'khoảng nghỉ không cộng vào, cũng không xoá');
  // Đúng bằng GAP_MS chưa phải khoảng nghỉ
  clock.t += GAP_MS;
  s.record(30, { at: clock.t, passes: ['A'] });
  assert.equal(s.stats().fps, 1000 / GAP_MS);
  clock.t += 500;
  // Cần MIN_SAMPLES khung mới đánh giá lại, rồi cộng tiếp phần còn thiếu (khoảng 20 s): lên mức trước 30 s
  drive(s, clock, 15e3, cost);
  assert.equal(s.level, 1);
  drive(s, clock, 15e3, cost);
  assert.equal(s.level, 2);
  assert.equal(s.stats().headroomMs, 0, 'đổi mức: bộ đếm về 0');

  // Đồng hồ chạy lùi cũng là khoảng nghỉ
  const back = new LevelScheduler({ now: () => 0, level: 1 });
  for (let i = 0; i < 20; i++) back.record(30, { at: 10e3 + i * 500, passes: ['A'] });
  const h = back.stats().headroomMs;
  assert.ok(h > 0);
  back.record(30, { at: 0, passes: ['A'] });
  assert.equal(back.stats().median, null);
  assert.equal(back.stats().headroomMs, h);

  // reset(): chuyến mới, đo lại và xoá bộ đếm, giữ mức
  s.reset();
  assert.equal(s.level, 2);
  assert.equal(s.stats().median, null);
  assert.equal(s.stats().headroomMs, 0);
  assert.equal(s.stats().overMs, 0);
  // Số đo hỏng bị bỏ qua
  s.record(NaN);
  s.record(-1);
  s.record(10, { at: Infinity });
  assert.equal(s.stats().median, null);
});

/**
 * Như drive() nhưng giống đi phố: chạy `every` ms rồi dừng `stop` ms (dưới CAPTURE_SPEED, không lấy khung). Khung được
 * ghi lúc worker xong (at = bắt đầu + cost), khung kế tiếp bắt đầu sau max(intervalMs, cost), như vòng lặp của main.js.
 */
function driveStops(s, clock, ms, cost, { every, stop }) {
  const end = clock.t + ms;
  let seg = clock.t;
  let paused = 0;
  while (clock.t < end) {
    if (clock.t - seg >= every) {
      clock.t += stop;
      seg = clock.t;
      continue;
    }
    const p = s.plan(clock.t);
    if (p.level === 0) {
      const wait = Math.min(p.intervalMs, end - clock.t);
      paused += wait;
      clock.t += wait;
      continue;
    }
    const c = cost(p.passes, clock.t);
    s.record(c, { at: clock.t + c, passes: p.passes });
    clock.t += Math.max(p.intervalMs, c);
  }
  return paused;
}

test('LevelScheduler: máy chậm đi phố (dừng 10 s sau mỗi 50 s) vẫn tạm dừng khi quá ngân sách ở mức 1', () => {
  for (const [every, stop] of [
    [50e3, 10e3],
    [30e3, 6e3],
  ]) {
    const clock = { t: 0 };
    const s = new LevelScheduler({ now: () => clock.t });
    const changes = [];
    s.onChange((c) => changes.push({ at: c.at, to: c.level, reason: c.reason }));
    // Đầu chuyến: chưa đủ 60 s xử lý ở mức 1 thì chưa tạm dừng, dù đồng hồ đã qua hơn 60 s
    driveStops(s, clock, every + stop + 20e3, () => 200, { every, stop });
    assert.equal(s.level, 1, `${every}: chưa đủ 60 s xử lý`);
    assert.ok(s.stats().overMs > 0 && s.stats().overMs < OVER_AT_1_MS, String(s.stats().overMs));
    const paused = driveStops(s, clock, 1800e3 - clock.t, () => 200, { every, stop });
    const pause = changes.find((c) => c.to === 0);
    assert.ok(pause, `${every}/${stop}: phải tạm dừng (${JSON.stringify(changes)})`);
    assert.equal(pause.reason, 'budget');
    assert.ok(pause.at < 150e3, String(pause.at));
    assert.ok(paused >= 3 * PAUSE_MS, `phần lớn chuyến tạm dừng: ${paused}`);
    assert.ok(changes.some((c) => c.reason === 'resume'));
  }
});

test('LevelScheduler: sau một lần tải vọt lên, máy nhanh đi phố (dừng mỗi 60 s) vẫn lên lại mức 2', () => {
  for (const every of [60e3, 90e3, 115e3]) {
    const clock = { t: 0 };
    const s = new LevelScheduler({ now: () => clock.t });
    const changes = [];
    s.onChange((c) => changes.push(`${c.from}→${c.level}:${c.reason}`));
    // 10 s tải vọt lên (ứng dụng khác, dọn rác bộ nhớ): 150 ms mỗi khung, rồi lại 20 / 40 ms
    const cost = (passes, t) => (t > 30e3 && t < 40e3 ? 150 : passes.includes('B') ? 40 : 20);
    driveStops(s, clock, 600e3, cost, { every, stop: 6e3 });
    assert.equal(changes[0], '2→1:budget', every);
    assert.ok(changes.includes('1→2:headroom'), `${every}: ${JSON.stringify(changes)}`);
    assert.equal(s.level, 2, every);
  }
});

test('LevelScheduler: lỗi của người nghe onChange không làm hỏng bộ lập lịch', () => {
  const clock = { t: 0 };
  const s = new LevelScheduler({ now: () => clock.t });
  s.onChange(() => {
    throw new Error('boom');
  });
  const seen = [];
  const off = s.onChange((c) => seen.push(c.level));
  drive(s, clock, 5e3, () => 100);
  assert.equal(s.level, 1);
  assert.deepEqual(seen, [1]);
  off();
});
