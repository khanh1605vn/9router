// Camera nhận diện biển (thử nghiệm), phía trang: kiểm tra máy có dùng được không, đọc trạng thái quyền, liệt kê
// camera, mở/đóng camera và lấy từng khung hình cho bộ nhận diện (js/vision.js). Không hiển thị hình, không lưu hay gửi
// khung hình đi đâu: khung lấy ra được chuyển thẳng cho worker và worker đóng nó.
//
// Quy tắc an toàn (PLAN §5.1, §7, camera.verdict.md mục 1):
// - Mở camera tự động (lúc khởi động, khi trang hiện lại, khi camera cắm lại) chỉ khi permissions.query cho biết quyền
//   đã được cấp ('granted'). Chrome trên Android có kiểu cho phép "chỉ lần này"; gọi getUserMedia khi quyền đã hết sẽ hiện
//   hộp hỏi quyền trong lúc có thể đang lái xe, và mỗi lần bỏ qua hộp hỏi bị tính vào lần chặn tự động 7 ngày. Chỉ khi
//   người dùng tự bấm bật (lúc xe đã đỗ, start({ userGesture: true })) mới được hỏi quyền.
// - Trang bị ẩn (sang ứng dụng khác, tắt màn hình): dừng mọi track, trả camera cho hệ thống. Trang hiện lại thì chỉ mở
//   lại theo quy tắc trên.
// - Lấy khung bằng ImageCapture.grabFrame(). Không có ImageCapture thì dùng một thẻ <video> ẩn, không gắn vào trang, chỉ
//   play() khi đã có một lần người dùng bấm bật trong phiên này; không bao giờ dùng thuộc tính autoplay (Chrome có thể tự
//   dừng video tắt tiếng tự phát nằm ngoài màn hình).
//
// Trạng thái phát qua onState(fn): 'off' | 'starting' | 'on' | 'paused' (trang ẩn, hoặc camera tạm không có hình) |
// 'error:<mã>' với mã trong CAMERA_ERROR_CODES.

import { canAutoStart } from './camsched.js';
import { visionSupport } from './vision.js';

// ---- Ràng buộc khi mở camera (PLAN §4.2) ----
export const IDEAL_WIDTH = 1920; // px
export const IDEAL_HEIGHT = 1080; // px
export const IDEAL_FPS = 15; // khung/giây camera chạy; bộ nhận diện chỉ lấy 2–5 khung/giây
export const MAX_FPS = 30;
export const RELAXED_WIDTH = 1280; // bậc nới thứ nhất khi camera từ chối ràng buộc (OverconstrainedError)
export const RELAXED_HEIGHT = 720;
export const CONSTRAINT_STEPS = 3; // đầy đủ → nới cỡ và bỏ giới hạn fps → chỉ chọn camera sau (hoặc camera đã chọn)
// ---- Lấy khung ----
export const GRAB_SWITCH_FAILS = 3; // grabFrame() hỏng liên tiếp chừng này lần thì chuyển sang <video> ẩn (nếu được)
export const GRAB_FAIL_MAX = 10; // lấy khung hỏng liên tiếp chừng này lần thì coi camera đã hỏng: 'error:grab'
export const VIDEO_READY = 2; // HTMLMediaElement.HAVE_CURRENT_DATA: video đã có khung hình để chụp
// ---- Tự thử mở lại ----
// Camera bận (ứng dụng khác còn đang trả camera) hoặc lần mở bị huỷ ngang: tự thử mở lại sau từng khoảng này (ms), rồi
// thôi. Mỗi lần thử đều là tự mở (theo quy tắc quyền), chỉ khi trang đang hiện và vẫn muốn chạy.
export const RETRY_DELAYS_MS = Object.freeze([2000, 10000]);
export const RETRY_CODES = Object.freeze(['busy', 'aborted']); // các mã lỗi được tự thử lại

export const CAMERA_ERROR_CODES = [
  'not-granted', // tự mở nhưng quyền chưa được cấp hẳn ('prompt'): không hỏi, giữ tắt
  'perm-unknown', // tự mở nhưng trình duyệt không cho biết trạng thái quyền: không hỏi, giữ tắt
  'needs-gesture', // trình duyệt không có ImageCapture và phiên này chưa có lần bấm bật nào
  'unsupported', // không có navigator.mediaDevices.getUserMedia
  'denied', // NotAllowedError, SecurityError: người dùng, hệ điều hành hoặc chính sách trang chặn camera
  'busy', // NotReadableError: camera đang bị ứng dụng khác giữ hoặc lỗi phần cứng
  'not-found', // NotFoundError, hoặc camera đã chọn không còn
  'overconstrained', // vẫn bị từ chối sau mọi bậc nới ràng buộc
  'aborted', // AbortError, InvalidStateError
  'failed', // lỗi khác
  'ended', // track tự kết thúc (camera bị ngắt, hệ điều hành thu hồi)
  'unplugged', // camera đang dùng biến mất khỏi danh sách thiết bị (rút cáp)
  'grab', // lấy khung hỏng liên tiếp GRAB_FAIL_MAX lần
];

/** Lời giải thích cho từng mã lỗi, để hiện ở màn hình cài đặt khi xe đã đỗ (không đọc to, không hiện lúc đang lái). */
export const CAMERA_ERROR_TEXT = {
  'not-granted': 'Camera đang tắt vì trình duyệt chưa cho phép dùng lâu dài. Hãy bật lại khi xe đã đỗ.',
  'perm-unknown': 'Trình duyệt này không cho biết camera đã được cho phép hay chưa, nên ứng dụng không tự bật camera. Hãy bật lại khi xe đã đỗ.',
  'needs-gesture': 'Trình duyệt này cần bạn tự bật camera mỗi lần mở ứng dụng. Hãy bật lại khi xe đã đỗ.',
  unsupported: 'Trình duyệt này không cho dùng camera.',
  denied: 'Camera đang bị chặn. Hãy cho phép camera trong phần cài đặt trang web của trình duyệt.',
  busy: 'Camera đang được ứng dụng khác dùng. Hãy đóng ứng dụng đó rồi bật lại.',
  'not-found': 'Không tìm thấy camera đã chọn. Hãy chọn lại trong mục kiểm tra camera khi xe đã đỗ.',
  overconstrained: 'Camera này không chạy được ở chế độ cần dùng.',
  aborted: 'Không mở được camera. Hãy thử lại.',
  failed: 'Không mở được camera. Hãy thử lại.',
  ended: 'Camera đã bị ngắt.',
  unplugged: 'Camera đã bị rút ra.',
  grab: 'Không lấy được hình từ camera.',
};

/** Lời giải thích cho lý do cameraSupport() trả về. */
export const SUPPORT_TEXT = {
  insecure: 'Camera chỉ dùng được khi mở ứng dụng qua địa chỉ https.',
  'webview?': 'Hãy mở ứng dụng bằng Chrome hoặc Samsung Internet; trình duyệt bên trong ứng dụng khác thường không cho dùng camera.',
  'no-gum': 'Trình duyệt này không cho dùng camera.',
  'no-worker': 'Thiết bị này không chạy được tính năng nhận diện biển.',
  'no-offscreen': 'Thiết bị này không chạy được tính năng nhận diện biển.',
  'no-simd': 'Thiết bị này không chạy được tính năng nhận diện biển.',
};

// Lý do của visionSupport() (js/vision.js) đổi sang lý do của cameraSupport().
const VISION_REASON = {
  insecure: 'insecure',
  'no-worker': 'no-worker',
  'no-offscreen': 'no-offscreen',
  'no-bitmap': 'no-offscreen', // createImageBitmap (Chrome 50) có trước OffscreenCanvas (69)
  'no-wasm': 'no-simd',
  'no-simd': 'no-simd',
};

// Trình duyệt dựng trên Android WebView (dấu "; wv)"), hoặc trình duyệt bên trong Facebook, Instagram, Zalo, Line.
// Chỉ là đoán theo chuỗi nhận dạng, nên lý do có dấu hỏi.
const WEBVIEW_UA = /; wv\)|\b(?:FBAN|FBAV|FB_IAB|FBIOS|Instagram|Zalo|Line)[/ ]/i;

function looksLikeWebView(nav) {
  if (WEBVIEW_UA.test(String(nav?.userAgent || ''))) return true;
  const brands = nav?.userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /webview/i.test(String(b?.brand || '')));
}

/**
 * Máy có dùng được camera nhận diện biển không: { ok, reason }. reason: null | 'insecure' | 'webview?' | 'no-gum' |
 * 'no-worker' | 'no-offscreen' | 'no-simd'. env thay cho globalThis khi kiểm thử.
 */
export function cameraSupport(env = globalThis) {
  const nav = env.navigator || {};
  let reason = null;
  if (env.isSecureContext === false) reason = 'insecure';
  else if (looksLikeWebView(nav)) reason = 'webview?';
  else if (typeof nav.mediaDevices?.getUserMedia !== 'function') reason = 'no-gum';
  else {
    const v = visionSupport(env);
    if (!v.ok) reason = VISION_REASON[v.reason] || 'no-simd';
  }
  return { ok: reason === null, reason };
}

/** Ràng buộc video ở bậc `step` (0 = đầy đủ). deviceId: camera người dùng đã chọn, bắt buộc đúng camera đó. */
export function cameraConstraints(step = 0, deviceId = null) {
  const video = { facingMode: { ideal: 'environment' } };
  if (step <= 0) {
    video.width = { ideal: IDEAL_WIDTH };
    video.height = { ideal: IDEAL_HEIGHT };
    video.frameRate = { ideal: IDEAL_FPS, max: MAX_FPS };
  } else if (step === 1) {
    video.width = { ideal: RELAXED_WIDTH };
    video.height = { ideal: RELAXED_HEIGHT };
    video.frameRate = { ideal: IDEAL_FPS };
  }
  if (deviceId) video.deviceId = { exact: deviceId };
  return { audio: false, video };
}

/** Mã lỗi (CAMERA_ERROR_CODES) của một lỗi getUserMedia. */
export function errorCode(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'overconstrained';
    case 'AbortError':
    case 'InvalidStateError':
      return 'aborted';
    case 'TypeError':
      return 'unsupported';
    default:
      return 'failed';
  }
}

function stopStream(stream) {
  if (!stream) return;
  let tracks = [];
  try {
    tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
  } catch {
    tracks = [];
  }
  for (const t of tracks) {
    try {
      t.stop();
    } catch {
      // track đã dừng
    }
  }
}

function closeBitmap(bitmap) {
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    // đã đóng
  }
}

function listen(target, type, fn) {
  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener(type, fn);
    return () => target.removeEventListener(type, fn);
  }
  return () => {};
}

export class CameraService {
  /**
   * Mọi phụ thuộc có thể thay khi kiểm thử: navigator, document, ImageCapture (null = không có), createImageBitmap,
   * now() (ms, đồng hồ đơn điệu, dùng làm dấu thời gian khung), canResume() (trang hiện lại thì có được tự mở lại không,
   * ví dụ () => store.settings.camEnabled && isDriving()), setTimeout / clearTimeout (cho lần tự thử mở lại).
   */
  constructor(deps = {}) {
    this._nav = 'navigator' in deps ? deps.navigator : globalThis.navigator;
    this._doc = 'document' in deps ? deps.document : globalThis.document;
    this._IC = 'ImageCapture' in deps ? deps.ImageCapture : globalThis.ImageCapture;
    // Gọi qua hàm bọc: createImageBitmap gọi rời khỏi window sẽ ném "Illegal invocation".
    const cib = 'createImageBitmap' in deps ? deps.createImageBitmap : globalThis.createImageBitmap;
    this._cib = typeof cib === 'function' ? (src) => cib.call(globalThis, src) : null;
    this._now = deps.now || (() => performance.now());
    this._canResume = deps.canResume || (() => true);
    const st = deps.setTimeout || globalThis.setTimeout;
    const ct = deps.clearTimeout || globalThis.clearTimeout;
    this._setTimeout = (fn, ms) => st.call(globalThis, fn, ms);
    this._clearTimeout = (id) => ct.call(globalThis, id);
    this._retryTimer = null;
    this._retryN = 0; // số lần đã tự thử lại từ lần mở gần nhất không phải do thử lại
    this._fromRetry = false;
    this._state = 'off';
    this._listeners = new Set();
    this.error = null; // mã lỗi gần nhất (CAMERA_ERROR_CODES) hoặc null
    this._wanted = false; // người dùng muốn camera chạy (đã start, chưa stop)
    this._deviceId = null; // camera đã chọn; null = camera sau mặc định
    this._lostId = null; // camera vừa bị ngắt/rút, để mở lại khi nó cắm lại
    this._gesture = false; // phiên này đã có lần người dùng bấm bật camera
    this._gen = 0; // tăng mỗi lần mở hoặc đóng: kết quả của lần mở cũ về muộn thì bỏ
    this._starting = null;
    this._startGesture = false;
    this._stream = null;
    this._track = null;
    this._capture = null;
    this._video = null;
    this._unbind = null;
    this._grabbing = false;
    this._fails = 0;
    this._focus = null;
    this._off = [
      listen(this._doc, 'visibilitychange', () => this._onVisibility()),
      listen(this._nav?.mediaDevices, 'devicechange', () => {
        this._onDeviceChange().catch(() => {});
      }),
    ];
  }

  get state() {
    return this._state;
  }

  /** Cách lấy nét đã đặt: 'far' (khoá nét ở xa nhất), 'continuous', hoặc null (để mặc định). */
  get focus() {
    return this._focus;
  }

  onState(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Trạng thái quyền camera: 'granted' | 'prompt' | 'denied' | 'unknown' (trình duyệt không cho hỏi). Không hiện hộp hỏi. */
  async permission() {
    try {
      const status = await this._nav.permissions.query({ name: 'camera' });
      const s = status?.state;
      return s === 'granted' || s === 'prompt' || s === 'denied' ? s : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Các camera: [{ deviceId, label }]. Tên camera chỉ có sau khi đã được cấp quyền. */
  async list() {
    try {
      const all = await this._nav.mediaDevices.enumerateDevices();
      return (Array.isArray(all) ? all : [])
        .filter((d) => d && d.kind === 'videoinput')
        .map((d) => ({ deviceId: String(d.deviceId || ''), label: String(d.label || '') }));
    } catch {
      return [];
    }
  }

  /**
   * Mở camera. deviceId: camera đã chọn (bỏ qua = giữ lựa chọn trước, null = camera sau mặc định). userGesture: true chỉ
   * khi người dùng vừa bấm bật lúc xe đã đỗ; khi đó trình duyệt có thể hỏi quyền. Không có userGesture thì chỉ mở khi quyền
   * đã được cấp. Trả settings khi mở được, null khi không (lý do ở `error` và onState). Không bao giờ ném lỗi.
   * Gọi lại khi đang mở hoặc đã mở cùng camera thì không mở thêm.
   */
  start({ deviceId, userGesture = false } = {}) {
    if (userGesture) this._gesture = true;
    this._cancelRetry();
    if (!this._fromRetry) this._retryN = 0;
    const want = deviceId === undefined ? this._deviceId : deviceId || null;
    const same = want === this._deviceId;
    this._wanted = true;
    if (same && this._starting && (this._startGesture || !userGesture)) return this._starting;
    if (same && this._track && !this._starting) {
      if (userGesture && this._video && this._video.paused) this._play(this._video);
      return Promise.resolve(this.settings);
    }
    if (this._track || this._starting) this._release();
    this._deviceId = want;
    this._startGesture = userGesture;
    const p = this._open(userGesture).catch(() => this._fail('failed', this._gen));
    this._starting = p;
    p.finally(() => {
      if (this._starting === p) this._starting = null;
    });
    return p;
  }

  /** Đóng camera (dừng mọi track). Gọi bao nhiêu lần cũng được. */
  stop() {
    this._wanted = false;
    this._lostId = null;
    this._cancelRetry();
    this._release();
    this.error = null;
    this._setState('off');
  }

  /**
   * Tạm trả camera (dừng mọi track) nhưng vẫn giữ ý muốn chạy và camera đã chọn: dùng khi lâu không lấy khung (xe
   * kẹt, pin yếu: holdCamera trong camsched.js). Mở lại bằng start() (tự mở, theo quy tắc quyền) hoặc khi trang hiện lại.
   */
  suspend() {
    this._cancelRetry(); // main.js sẽ gọi start() khi lại cần camera
    if (!this._track && !this._starting) return;
    this._release();
    this._setState('paused');
  }

  /**
   * Một khung hình: { bitmap: ImageBitmap, t: now() lúc lấy xong } hoặc null (camera chưa chạy, đang lấy khung khác,
   * chưa có hình, hoặc lỗi). Người nhận phải đóng bitmap (worker của Vision tự đóng).
   */
  async grab() {
    if (this._state !== 'on' || !this._track || this._grabbing) return null;
    const gen = this._gen;
    this._grabbing = true;
    let bitmap = null;
    let failed = false;
    try {
      bitmap = this._capture ? await this._capture.grabFrame() : await this._grabVideo();
    } catch {
      failed = true;
      bitmap = null;
    }
    const t = this._now();
    if (gen !== this._gen) {
      closeBitmap(bitmap);
      return null;
    }
    this._grabbing = false;
    if (this._state !== 'on') {
      closeBitmap(bitmap);
      return null;
    }
    if (!bitmap) {
      if (failed) this._grabFailed();
      return null;
    }
    this._fails = 0;
    return { bitmap, t };
  }

  /** Thông số thật của camera đang chạy: { width, height, frameRate, deviceId, label }, hoặc null. */
  get settings() {
    const track = this._track;
    if (!track) return null;
    let s = {};
    try {
      s = (typeof track.getSettings === 'function' && track.getSettings()) || {};
    } catch {
      s = {};
    }
    return {
      width: Number.isFinite(s.width) ? s.width : null,
      height: Number.isFinite(s.height) ? s.height : null,
      frameRate: Number.isFinite(s.frameRate) ? s.frameRate : null,
      deviceId: s.deviceId || this._deviceId || null,
      label: String(track.label || ''),
    };
  }

  /** Bỏ mọi trình nghe sự kiện và đóng camera (khi không dùng đối tượng này nữa). */
  dispose() {
    this.stop(); // cũng huỷ lần tự thử mở lại đang hẹn
    for (const off of this._off) off();
    this._off = [];
    this._listeners.clear();
  }

  // ---- bên trong ----

  _visible() {
    return !this._doc || this._doc.visibilityState !== 'hidden';
  }

  _setState(s) {
    if (s === this._state) return;
    this._state = s;
    for (const fn of this._listeners) {
      try {
        fn(s);
      } catch {
        // lỗi của người nghe không làm hỏng camera
      }
    }
  }

  _fail(code, gen) {
    if (gen !== this._gen) return null;
    this.error = code;
    this._setState(`error:${code}`);
    if (RETRY_CODES.includes(code)) this._scheduleRetry();
    return null;
  }

  /** Camera bận hoặc lần mở bị huỷ: hẹn tự mở lại, tối đa RETRY_DELAYS_MS.length lần. */
  _scheduleRetry() {
    if (!this._wanted || this._retryN >= RETRY_DELAYS_MS.length) return;
    const ms = RETRY_DELAYS_MS[this._retryN++];
    this._cancelRetry();
    this._retryTimer = this._setTimeout(() => {
      this._retryTimer = null;
      if (!RETRY_CODES.includes(this.error) || !this._wanted || this._track || this._starting) return;
      if (!this._visible() || !this._canResume()) return; // trang hiện lại hoặc main.js sẽ gọi start()
      this._fromRetry = true;
      try {
        this.start({ userGesture: false }); // tự mở: chỉ khi quyền đã được cấp
      } finally {
        this._fromRetry = false;
      }
    }, ms);
  }

  _cancelRetry() {
    if (this._retryTimer == null) return;
    this._clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  async _open(userGesture) {
    const gen = ++this._gen;
    const md = this._nav?.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') return this._fail('unsupported', gen);
    if (!this._visible()) {
      // Trang đang ẩn: không mở; khi trang hiện lại sẽ mở theo quy tắc tự mở.
      this._setState('paused');
      return null;
    }
    this._setState('starting');
    if (!userGesture) {
      const perm = await this.permission();
      if (gen !== this._gen) return null;
      // Trang đã bị chặn camera: báo ngay cách bỏ chặn, khỏi để người dùng bấm bật vô ích.
      if (perm === 'denied') return this._fail('denied', gen);
      if (perm === 'unknown') return this._fail('perm-unknown', gen);
      if (!canAutoStart(perm)) return this._fail('not-granted', gen);
    }
    if (!this._IC && !this._gesture) return this._fail('needs-gesture', gen);

    let stream = null;
    let lastErr = null;
    for (let step = 0; step < CONSTRAINT_STEPS && !stream; step++) {
      try {
        stream = await md.getUserMedia(cameraConstraints(step, this._deviceId));
      } catch (err) {
        lastErr = err;
        if (gen !== this._gen) return null;
        // Chỉ OverconstrainedError mới thử nới ràng buộc; camera đã chọn không còn thì thôi.
        if (errorCode(err) !== 'overconstrained' || err?.constraint === 'deviceId') break;
      }
    }
    if (gen !== this._gen) {
      // Đã stop() hoặc trang bị ẩn trong lúc chờ: trả camera ngay.
      stopStream(stream);
      return null;
    }
    if (!stream) {
      let code = errorCode(lastErr);
      if (code === 'overconstrained' && lastErr?.constraint === 'deviceId') code = 'not-found';
      return this._fail(code, gen);
    }
    const track = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : null;
    if (!track) {
      stopStream(stream);
      return this._fail('failed', gen);
    }
    this._stream = stream;
    this._track = track;
    this._lostId = null;
    const offs = [
      listen(track, 'ended', () => {
        if (this._track === track) this._lost('ended');
      }),
      listen(track, 'mute', () => {
        if (this._track === track && this._state === 'on') this._setState('paused');
      }),
      listen(track, 'unmute', () => {
        if (this._track === track && this._state === 'paused') this._setState('on');
      }),
    ];
    this._unbind = () => offs.forEach((off) => off());
    this._capture = null;
    if (typeof this._IC === 'function') {
      try {
        this._capture = new this._IC(track);
      } catch {
        this._capture = null;
      }
    }
    if (!this._capture) this._video = this._makeVideo(stream);
    await this._applyFocus(track);
    if (gen !== this._gen) return null;
    if (track.readyState === 'ended') {
      this._lost('ended');
      return null;
    }
    this._fails = 0;
    this._retryN = 0;
    this.error = null;
    this._setState(track.muted ? 'paused' : 'on');
    return this.settings;
  }

  /** Khoá nét ở xa nhất nếu camera cho chỉnh khoảng lấy nét, không thì lấy nét liên tục. Lỗi thì để mặc định. */
  async _applyFocus(track) {
    this._focus = null;
    if (typeof track.applyConstraints !== 'function') return;
    let caps = null;
    try {
      caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
    } catch {
      caps = null;
    }
    const modes = Array.isArray(caps?.focusMode) ? caps.focusMode : [];
    const far = caps?.focusDistance?.max;
    const tries = [];
    if (modes.includes('manual') && Number.isFinite(far) && far > 0) {
      tries.push([{ focusMode: 'manual', focusDistance: far }, 'far']);
    }
    if (modes.includes('continuous')) tries.push([{ focusMode: 'continuous' }, 'continuous']);
    for (const [c, name] of tries) {
      try {
        await track.applyConstraints({ advanced: [c] });
        this._focus = name;
        return;
      } catch {
        // thử cách sau
      }
    }
  }

  _makeVideo(stream) {
    if (!this._doc || typeof this._doc.createElement !== 'function') return null;
    const v = this._doc.createElement('video');
    v.muted = true;
    v.playsInline = true;
    if (typeof v.setAttribute === 'function') {
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
    }
    v.srcObject = stream;
    if (this._gesture) this._play(v);
    return v;
  }

  _play(v) {
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // trình duyệt từ chối phát: lần lấy khung sau thử lại
    }
  }

  async _grabVideo() {
    const v = this._video;
    if (!v || typeof this._cib !== 'function') throw new Error('no-video');
    if (v.paused) {
      if (this._gesture) this._play(v);
      return null;
    }
    if (!(v.readyState >= VIDEO_READY) || !(v.videoWidth > 0)) return null; // chưa có hình: không tính là lỗi
    return this._cib(v);
  }

  _grabFailed() {
    this._fails++;
    if (this._capture && this._fails >= GRAB_SWITCH_FAILS && this._gesture) {
      // ImageCapture hỏng trên máy này: chuyển sang <video> ẩn (đã có lần bấm bật nên được play()).
      this._capture = null;
      this._video = this._makeVideo(this._stream);
      if (this._video) {
        this._fails = 0;
        return;
      }
    }
    if (this._fails >= GRAB_FAIL_MAX) this._lost('grab');
  }

  /** Camera hỏng hoặc bị ngắt khi đang chạy: trả camera, giữ ý muốn chạy để tự mở lại khi có thể. */
  _lost(code) {
    const id = this.settings?.deviceId || this._deviceId;
    this._release();
    this._lostId = id || null;
    this.error = code;
    this._setState(`error:${code}`);
  }

  _release() {
    this._gen++;
    this._starting = null;
    this._grabbing = false;
    if (this._unbind) this._unbind();
    this._unbind = null;
    stopStream(this._stream);
    if (this._video) {
      try {
        this._video.pause();
      } catch {
        // đã dừng
      }
      this._video.srcObject = null;
    }
    this._stream = null;
    this._track = null;
    this._capture = null;
    this._video = null;
    this._focus = null;
  }

  _onVisibility() {
    if (!this._visible()) {
      const busy = this._track || this._starting;
      if (busy) this._release();
      if (busy && this._wanted) this._setState('paused');
      return;
    }
    if (this._wanted && !this._track && !this._starting && this._canResume()) {
      this.start({ userGesture: false }); // quy tắc tự mở: chỉ khi quyền đã được cấp
    }
  }

  async _onDeviceChange() {
    const track = this._track;
    const live = track ? this.settings?.deviceId : null;
    const lost = this._lostId;
    const id = live || lost;
    if (!id) return;
    const list = await this.list();
    const ids = list.map((d) => d.deviceId).filter(Boolean);
    if (list.length && !ids.length) return; // danh sách không có mã thiết bị (chưa có quyền): không kết luận được
    const present = ids.includes(id);
    if (live) {
      // Trong lúc chờ danh sách, người dùng có thể đã đổi camera: chỉ đóng nếu vẫn là đúng track đã kiểm.
      if (!present && this._track === track) this._lost('unplugged');
      return;
    }
    if (present && this._lostId === lost && this._wanted && !this._track && !this._starting && this._visible() && this._canResume()) {
      this.start({ userGesture: false }); // camera cắm lại: mở lại theo quy tắc tự mở
    }
  }
}

/**
 * Theo dõi pin (navigator.getBattery, Chrome Android 38+): gọi onChange({ level (0–1), charging }) ngay và mỗi khi đổi,
 * hoặc onChange(null) nếu trình duyệt không cho đọc pin. Trả hàm huỷ theo dõi.
 */
export async function watchBattery(onChange, { navigator: nav = globalThis.navigator } = {}) {
  let bm = null;
  try {
    bm = await nav.getBattery();
  } catch {
    bm = null;
  }
  if (!bm) {
    onChange(null);
    return () => {};
  }
  const emit = () => onChange({ level: Number(bm.level), charging: bm.charging === true });
  const offs = [listen(bm, 'levelchange', emit), listen(bm, 'chargingchange', emit)];
  emit();
  return () => offs.forEach((off) => off());
}
