// Camera nhận diện biển (thử nghiệm): một đối tượng điều phối toàn bộ phần chạy của tính năng, để main.js chỉ gọi vài
// hàm và giao diện (js/camui.js) chỉ nói chuyện với một chỗ.
//
// Nó giữ, và chỉ tạo khi cần:
// - kho biển đã học (LearnedSigns, IndexedDB 'banduong-learned') và bộ học (Learner), dùng chung một labels.json tải
//   một lần và kiểm SHA-256 theo js/mlmanifest.js. Kho vẫn dùng được (cảnh báo, xem lại, nhập, xuất, xoá) khi máy không
//   chạy được bộ nhận diện hoặc bản cài chưa có mô hình;
// - giới hạn tốc độ từ biển camera (CameraLimit) cho đồng hồ tốc độ;
// - camera (CameraService), bộ nhận diện (Vision), bộ chọn mức tải (LevelScheduler);
// - kho ảnh kiểm tra (EvalCrops, IndexedDB 'banduong-evalcrops'): đọc lúc khởi động dù camEval bật hay tắt, để ảnh quá
//   EVAL_RETENTION_DAYS ngày luôn bị xoá (lúc khởi động và ít nhất mỗi EVAL_EXPIRE_MS khi ứng dụng mở lâu), số ảnh
//   hiện đúng, và "Xoá ảnh biển đã lưu" (luôn được) xoá được ảnh đã lưu từ trước. Chỉ thêm ảnh khi camEval bật.
//
// An toàn (PLAN §7): mọi lần tự mở camera đều không có userGesture, nên CameraService chỉ gọi getUserMedia khi quyền đã
// là 'granted' và không bao giờ tự hiện hộp hỏi quyền. enable() và openCheck() (mục "Kiểm tra camera") chỉ chạy khi xe
// đã đỗ và là hai đường duy nhất được hỏi quyền. disable() và clear() luôn dùng được. Khung hình chỉ đi thẳng từ camera
// sang worker (worker đóng nó), không bao giờ được lưu hay gửi đi.
//
// Móc kiểm thử: nếu globalThis.__BD_TEST__?.visionFactory (hoặc cameraFactory) là hàm thì dùng nó thay cho new Vision()
// (hoặc new CameraService()) lúc cần tạo lần đầu. Bộ chạy thử trên trình duyệt dùng móc này để đưa vào bộ nhận diện giả.
// Ứng dụng thật không bao giờ đặt __BD_TEST__, nên móc này không làm gì.

import { CAMERA_ERROR_TEXT, CameraService, cameraConstraints, cameraSupport, CONSTRAINT_STEPS, errorCode, SUPPORT_TEXT, watchBattery } from './camera.js';
import { CAPTURE_SPEED, captureBlock, DRIVING_MODES, foeFor, holdCamera, isParked, LevelScheduler, StillTimer } from './camsched.js';
import { planFiles, quantile, verifyBytes, Vision, VISION_LIMITS } from './vision.js';
import { ML_MANIFEST } from './mlmanifest.js';
import { labelOf, LearnedSigns, MAX_RECORDS } from './learnedsigns.js';
import { CLS_MIN_PX, Learner, NOMINAL_W } from './signlearn.js';
import { DEFAULT_HFOV, focalPx } from './signtrack.js';
import { CAMERA_LIMIT_CODE, CameraLimit } from './alerts.js';
import { EVAL_FILE_NAME, EVAL_TEXT, EvalCrops } from './evalcrops.js';
import { formatNumberVi } from './signs.js';

const P = globalThis.VisionProto; // vision.js đã nạp visionproto.js

// ---- Ngưỡng ----
export const LABELS_PATH = 'models/labels.json';

/**
 * labels.json có cho học ít nhất một biển tốc độ tối đa (P.127[n], learn: true) không. Mô hình v1 thì không (mọi trị số
 * P.127 đều bị gỡ vì không qua ngưỡng E1, xem models/MODEL_CARD.md): khi đó camera không bao giờ đổi giới hạn trên
 * đồng hồ tốc độ, nên công tắc "Dùng biển tốc độ do camera ghi nhận…" được ẩn (cài đặt camSpeed vẫn giữ nguyên).
 */
export function speedLearnable(labels) {
  const L = labels && Array.isArray(labels.labels) ? labels.labels : [];
  return L.some((l) => l && l.learn === true && l.code === CAMERA_LIMIT_CODE && l.value != null);
}

/**
 * Bản ghi (hay nút biển { code, value }) có nhãn learn: true trong labels.json không. Chưa có labels: không. Bản ghi
 * cũ của nhãn đã bị gỡ (ví dụ P.127[80] học từ bản dựng trước khi cài mô hình v1) thì không: nó không được đổi giới
 * hạn trên đồng hồ tốc độ.
 */
export function learnableRecord(labels, rec) {
  const L = labels && Array.isArray(labels.labels) ? labels.labels : null;
  if (!L || !rec || typeof rec.code !== 'string') return false;
  const label = labelOf(rec.code, rec.value ?? null);
  return L.some((l) => l && l.learn === true && l.label === label);
}

/** Số loại biển được học (nhãn learn: true) của labels.json, hoặc null khi chưa có labels. */
export function learnableCount(labels) {
  if (!labels || !Array.isArray(labels.labels)) return null;
  return labels.labels.filter((l) => l && l.learn === true).length;
}
export const CHECK_FRAMES = 30; // "Kiểm tra camera": số khung đo cho mỗi tổ hợp lượt quét ('A' và 'A'+'B')
export const CHECK_FRAMES_MAX = 200; // … không đo quá chừng này khung mỗi tổ hợp
export const CHECK_GRAB_FAILS = 20; // … lấy khung hỏng liên tiếp chừng này lần thì thôi đo
export const GRAB_RETRY_MS = 100; // camera chưa có khung: đợi chừng này (ms) rồi lấy lại
export const PAUSE_POLL_MS = 5000; // mức tải 0 (tạm dừng cho máy đỡ nóng): xem lại ít nhất mỗi chừng này (ms)
// Bộ nhận diện hỏng giữa chừng ('worker') hoặc tải bị treo ('load'): tự tải lại sau từng khoảng này (ms), rồi thôi cho
// tới lần bật lại hay tải lại trang.
export const VISION_RETRY_MS = Object.freeze([3000, 15000, 60000]);
// … số lần thử lại chỉ được trả lại khi bộ nhận diện đã xử lý chừng này khung liên tiếp không lỗi (tính theo khung, không
// theo giờ: lúc đỗ, ẩn trang hay chạy thử thì không có khung nào). Bộ nhận diện tải được nhưng hỏng ở mỗi khung (máy
// yếu quá FRAME_TIMEOUT, hết bộ nhớ) vì thế không tải lại mãi: thử VISION_RETRY_MS.length lần rồi thôi, trả camera.
export const VISION_STABLE_FRAMES = 100;
// Lỗi bộ nhận diện không tự thử lại: máy không chạy được, bản cài không có mô hình, tệp hỏng (phải tải lại trang).
export const VISION_FATAL = Object.freeze(['unsupported', 'no-models', 'integrity']);
export const RANGE_STEP_M = 5; // tầm đọc biển ước tính làm tròn xuống bội số này (m)
export const PROGRESS_STEP = 0.01; // tiến độ tải chỉ báo lại khi đổi từ chừng này (phần) trở lên
// Ứng dụng mở nhiều ngày liền: xoá ảnh kiểm tra quá hạn ít nhất mỗi chừng này (ms, theo đồng hồ của máy).
export const EVAL_EXPIRE_MS = 60 * 60 * 1000;

// ---- Chữ hiện cho người dùng (chỉ ở màn hình cài đặt lúc xe đỗ; không đọc to) ----
export const TEXT = Object.freeze({
  notParked: 'Chỉ bật được khi xe đã đỗ.',
  parkedOnly: 'Chỉ dùng khi xe đã đỗ.',
  off: 'Camera đang tắt.',
  mode: 'Camera sẽ tự chạy khi bạn bắt đầu lái.',
  hidden: 'Camera tạm dừng khi ứng dụng không hiện trên màn hình.',
  simulated: 'Camera không chạy khi chạy thử.',
  slow: 'Camera tạm dừng khi xe chạy chậm.',
  battery: 'Camera tạm dừng vì pin yếu.',
  paused: 'Camera tạm dừng vài phút để máy đỡ nóng.',
  starting: 'Đang mở camera.',
  running: 'Camera đang ghi nhận biển báo.',
  loading: 'Đang tải dữ liệu nhận diện biển.',
  blank: 'Camera không có hình. Hãy kiểm tra camera có bị che không.',
  dark: 'Hình từ camera quá tối.',
  bright: 'Hình từ camera quá sáng.',
  labels: 'Chưa tải được danh sách biển. Hãy kết nối mạng rồi mở lại ứng dụng.',
  visionStopped: 'Bộ nhận diện biển bị lỗi nhiều lần nên đã dừng. Sẽ thử lại ở chuyến đi sau.',
  enableHidden: 'Ứng dụng đã bị ẩn khi đang mở camera. Hãy bấm bật lại.',
  keepAwakeOn: 'Đã bật “Giữ màn hình sáng khi lái” vì camera chỉ chạy khi màn hình sáng.',
});

/** Lời giải thích cho mã lỗi của bộ nhận diện (VisionError.code). */
export const VISION_TEXT = Object.freeze({
  'no-models': 'Bản cài này chưa có dữ liệu nhận diện biển.',
  unsupported: SUPPORT_TEXT['no-simd'],
  integrity: 'Dữ liệu nhận diện biển bị hỏng. Hãy tải lại trang khi có mạng.',
  load: 'Chưa tải được dữ liệu nhận diện biển. Hãy kiểm tra mạng.',
  worker: 'Bộ nhận diện biển bị lỗi. Đang chạy lại.',
  args: 'Bộ nhận diện bỏ qua một khung hình lỗi.',
});

/** Cảnh báo trước khi lưu tệp biển đã học (PLAN §6.4). */
export const EXPORT_WARNING = Object.freeze([
  'Tệp này cho thấy những con đường bạn đã đi. Chỉ gửi cho người bạn tin tưởng.',
  'Ứng dụng không tự đưa biển lên OpenStreetMap. Nếu muốn đóng góp, hãy mở tệp làm lớp tham khảo trong trình soạn iD và tự nhập sau khi đã kiểm tra tận nơi.',
]);

const IMPORT_ERROR_TEXT = Object.freeze({
  'too-large': 'Tệp quá lớn.',
  'bad-json': 'Không đọc được tệp. Hãy chọn tệp biển do Bạn Đường xuất ra.',
  'not-geojson': 'Tệp không phải danh sách biển do Bạn Đường xuất ra.',
  'too-many': `Tệp có hơn ${formatNumberVi(MAX_RECORDS, 0)} biển.`,
  'no-labels': TEXT.labels,
});

/** Câu báo kết quả nhập tệp biển: { added, skipped, error? } → chữ tiếng Việt. */
export function importText(res) {
  const added = res?.added || 0;
  const did = added ? `Đã thêm ${formatNumberVi(added, 0)} biển.` : '';
  if (res?.error === 'full') return [did, `Kho biển đã đầy (${formatNumberVi(MAX_RECORDS, 0)} biển).`].filter(Boolean).join(' ');
  if (res?.error) return IMPORT_ERROR_TEXT[res.error] || IMPORT_ERROR_TEXT['bad-json'];
  return did || 'Tệp không có biển mới nào.';
}

/**
 * Chú thích cho biển đã học trên thanh cảnh báo và hộp chi tiết, hoặc null (biển bản đồ, biển đã xác nhận).
 * Biển chưa xác nhận (quiet) không được đọc thành tiếng, nên phải ghi rõ trên màn hình.
 */
export function learnedCaption(item) {
  if (!item?.src || !item.quiet) return null;
  if (item.src === 'import') return 'Biển nhập từ tệp';
  return (item.meta?.hitDays ?? 0) <= 1 ? 'Camera mới thấy, chưa xác nhận' : 'Camera chưa chắc chắn';
}

/**
 * Tầm đọc biển ước tính (m): khoảng cách mà biển cỡ thường (NOMINAL_W) rộng đủ CLS_MIN_PX điểm ảnh để phân loại, với
 * góc nhìn hfov đo theo cạnh dài của khung. Làm tròn xuống RANGE_STEP_M. null khi không biết cỡ khung.
 */
export function readRange(width, height, hfov = DEFAULT_HFOV) {
  const long = Math.max(Number(width) || 0, Number(height) || 0);
  if (!(long > 0)) return null;
  const z = (focalPx(long, hfov) * NOMINAL_W) / CLS_MIN_PX;
  return Math.floor(z / RANGE_STEP_M) * RANGE_STEP_M;
}

export const rangeText = (m) => (m ? `Đọc được biển cỡ thường từ khoảng ${m} m (ước tính).` : null);

/** Chữ trạng thái cho một ảnh chụp trạng thái (CameraController#state), theo thứ tự ưu tiên. */
export function stateText(st) {
  if (!st.support.ok) return SUPPORT_TEXT[st.support.reason] || SUPPORT_TEXT['no-simd'];
  if (st.models !== 'ok') return VISION_TEXT['no-models'];
  if (!st.enabled) return TEXT.off;
  if (st.visionError && st.visionError !== 'args') {
    if (st.visionGaveUp && st.visionError === 'worker') return TEXT.visionStopped; // không còn "Đang chạy lại"
    return VISION_TEXT[st.visionError] || VISION_TEXT.load;
  }
  if (st.camera.startsWith('error:')) return CAMERA_ERROR_TEXT[st.camera.slice(6)] || CAMERA_ERROR_TEXT.failed;
  if (st.block) return TEXT[st.block] || TEXT.off;
  if (st.vision === 'loading') {
    const p = st.progress;
    return p && p.total > 0 ? `Đang tải dữ liệu nhận diện biển (${Math.floor((100 * p.loaded) / p.total)} %).` : TEXT.loading;
  }
  if (st.camera === 'starting') return TEXT.starting;
  if (st.level === 0) return TEXT.paused;
  if (st.capturing && TEXT[st.health]) return TEXT[st.health];
  if (st.camera === 'on' && st.capturing) return TEXT.running;
  if (st.camera === 'paused') return TEXT.hidden;
  return TEXT.mode;
}

const DEFAULT_BASE = new URL('../', import.meta.url).href;

function closeBitmap(b) {
  try {
    b?.close?.();
  } catch {
    // đã đóng
  }
}

function stopTracks(stream) {
  try {
    for (const t of stream?.getTracks?.() || []) t.stop();
  } catch {
    // đã dừng
  }
}

function trackSettings(track, deviceId) {
  let s = {};
  try {
    s = track?.getSettings?.() || {};
  } catch {
    s = {};
  }
  const num = (v) => (Number.isFinite(v) ? v : null);
  return { width: num(s.width), height: num(s.height), frameRate: num(s.frameRate), deviceId: s.deviceId || deviceId || null, label: String(track?.label || '') };
}

const pct = (sorted, q) => (sorted.length ? Math.round(quantile(sorted, q) * 10) / 10 : null);

export class CameraController {
  #o; // phụ thuộc đã chuẩn hoá
  #store;
  #learned = null;
  #learner = null;
  #learnerLabels = null; // labels mà bộ học hiện tại dùng (cùng đối tượng với kho)
  #limit = null;
  #sched = null;
  #cam = null;
  #vision = null;
  #evalCrops = null;
  #evalExpiredAt = null; // lần gần nhất xoá ảnh kiểm tra quá hạn (ms, đồng hồ của máy)
  #still;
  #battery = null;
  #labels = null;
  #labelsState = 'idle'; // 'idle' | 'loading' | 'ok' | 'error' | 'missing'
  #ready = null;
  #listeners = new Set();
  #lastKey = '';
  #lastFix = null;
  #speedMs = null;
  #movedAt = null; // lần cuối xe chạy từ CAPTURE_SPEED trở lên (mono ms; OBD hay GPS thật, không tính chạy thử)
  #block = 'off';
  #blockSince = 0;
  #driving = false;
  #armed = true; // được tự mở camera một lần (đặt lại mỗi khi lý do chặn đổi)
  #enabling = false;
  #wasEnabled = false;
  #looping = false;
  #wakeFn = null;
  #visionState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
  #visionError = null;
  #visionRetry = 0;
  #visionTimer = null;
  #visionLoad = null;
  #visionGaveUp = false; // đã thử lại đủ VISION_RETRY_MS: thôi (và trả camera) cho tới chuyến sau, lần bật lại hay khi có mạng lại
  #visionOkFrames = 0; // số khung xử lý được liên tiếp từ lần tải gần nhất (VISION_STABLE_FRAMES)
  #loaded = null; // promise đọc kho biển đã học (clear() chỉ chờ cái này, không chờ labels.json)
  #progress = null;
  #argsLogged = false;
  #keepAwakeTurnedOn = false;
  #check = null; // { stream, track, deviceId }
  #checkGen = 0;
  #offs = [];
  #disposed = false;

  /**
   * @param store          { settings, set(key, value), onChange?(fn) } (store.js)
   * @param roads          RoadData
   * @param signs          SignEngine (đọc lastCorridor, lastCorridorTime)
   * @param getMode        () → state.mode của main.js
   * @param carStationary  () → true/false (tốc độ của xe qua OBD, không thì GPS), như carStationary() của main.js
   * @param carSpeed       () → tốc độ do xe báo (km/h) khi còn mới, hoặc null: để biết xe vừa chạy, kể cả khi mất GPS
   * @param isSimulated    () → true khi đang "Chạy thử" (state.simulate của main.js): camera không mở, kể cả trước
   *                       lần định vị giả đầu tiên
   * Thay khi kiểm thử: document, window (sự kiện 'online'), navigator, ImageCapture, createImageBitmap, fetch, digest, manifest, base (gốc ứng
   * dụng), now (Date.now), mono (performance.now), setTimeout, clearTimeout, learnedBackend, evalBackend,
   * cameraFactory(deps), visionFactory(deps), support (() → { ok, reason }), log.
   */
  constructor(opts = {}) {
    const g = globalThis;
    this.#store = opts.store;
    const st = opts.setTimeout || g.setTimeout;
    const ct = opts.clearTimeout || g.clearTimeout;
    this.#o = {
      roads: opts.roads || null,
      signs: opts.signs || null,
      getMode: opts.getMode || (() => 'browse'),
      carStationary: opts.carStationary || (() => null),
      carSpeed: opts.carSpeed || (() => null),
      isSimulated: opts.isSimulated || (() => false),
      document: 'document' in opts ? opts.document : g.document || null,
      window: 'window' in opts ? opts.window : g.window || null,
      navigator: 'navigator' in opts ? opts.navigator : g.navigator || null,
      ImageCapture: 'ImageCapture' in opts ? opts.ImageCapture : g.ImageCapture || null,
      createImageBitmap: 'createImageBitmap' in opts ? opts.createImageBitmap : g.createImageBitmap || null,
      fetch: opts.fetch || ((...a) => g.fetch(...a)),
      digest: opts.digest,
      manifest: opts.manifest || ML_MANIFEST,
      base: opts.base || null,
      now: opts.now || (() => Date.now()),
      mono: opts.mono || (() => performance.now()),
      setTimeout: (fn, ms) => st.call(g, fn, ms),
      clearTimeout: (id) => ct.call(g, id),
      learnedBackend: opts.learnedBackend,
      evalBackend: opts.evalBackend,
      cameraFactory: opts.cameraFactory || null,
      visionFactory: opts.visionFactory || null,
      support: opts.support || (() => cameraSupport()),
      log: opts.log || ((...a) => console.warn(...a)),
    };
    this.#still = new StillTimer({ now: this.#o.mono });
    this.support = { ok: false, reason: 'no-gum' };
    try {
      this.support = this.#o.support();
    } catch {
      // giữ 'no-gum'
    }
  }

  get #s() {
    return this.#store.settings;
  }

  // ---------------------------------------------------------------------------------------------
  // Khởi động
  // ---------------------------------------------------------------------------------------------

  /**
   * Tạo kho biển, bộ học, giới hạn tốc độ camera và bộ chọn mức tải; tải labels.json; đọc kho. Gọi một lần lúc mở
   * ứng dụng (gọi lại trả cùng promise). Không bao giờ ném lỗi và không mở camera nếu chưa đủ điều kiện.
   */
  init() {
    if (this.#ready) return this.#ready;
    const o = this.#o;
    // requireLabels: chưa biết nhãn nào được học (labels.json chưa tải hay tải lỗi) thì không hiện, không cảnh báo biển
    // nào; bản ghi của nhãn đã bị gỡ (learn: false) cũng vậy (LearnedSigns#dormant).
    this.#learned = new LearnedSigns({ backend: o.learnedBackend, now: o.now, requireLabels: true });
    this.#limit = new CameraLimit();
    this.#sched = new LevelScheduler({ now: o.mono });
    this.#offs.push(
      this.#learned.onChange(() => this.#emit()),
      this.#sched.onChange(() => {
        if (this.#vision) this.#vision.level = this.#sched.level;
        this.#emit();
      })
    );
    if (typeof this.#store.onChange === 'function') {
      this.#offs.push(this.#store.onChange((what) => what === 'settings' && this.#applySettings()));
    }
    const doc = o.document;
    if (doc && typeof doc.addEventListener === 'function') {
      const fn = () => this.#onVisibility();
      doc.addEventListener('visibilitychange', fn);
      this.#offs.push(() => doc.removeEventListener('visibilitychange', fn));
    }
    const win = o.window;
    if (win && typeof win.addEventListener === 'function') {
      const fn = () => this.#onOnline();
      win.addEventListener('online', fn);
      this.#offs.push(() => win.removeEventListener('online', fn));
    }
    this.#warmLabelsOnControl();
    this.#wasEnabled = this.#s.camEnabled === true;
    this.#stillUpdate();
    const loaded = this.#learned.load().catch(() => 0);
    this.#loaded = loaded;
    this.#ready = (async () => {
      await this.#loadLabels();
      this.#makeLearner();
      try {
        const off = await watchBattery((b) => {
          this.#battery = b;
          this.refresh();
        }, { navigator: o.navigator });
        this.#offs.push(off);
      } catch {
        this.#battery = null;
      }
      await loaded;
      // Kho ảnh kiểm tra: đọc (load() xoá ảnh quá hạn) cả khi camEval tắt, để ảnh đã lưu từ trước không nằm lại quá
      // hạn và số ảnh hiện đúng. Không thêm ảnh khi camEval tắt (EvalCrops#add kiểm enabled()).
      await this.#evalStore().load().catch(() => 0);
      this.#applySettings();
      return this;
    })();
    return this.#ready;
  }

  /** Kho biển đã học (để truyền vào SignEngine.update), hoặc null trước init(). */
  get learned() {
    return this.#learned;
  }

  /** Bộ học (null cho tới khi init() xong). */
  get learner() {
    return this.#learner;
  }

  /** Giới hạn tốc độ từ biển camera đã xác nhận: CameraLimit.current ({ n, wayId, since } | null). */
  get speedLimit() {
    return this.#limit ? this.#limit.current : null;
  }

  /** Bộ chọn mức tải (để màn hình kiểm tra đọc stats()). */
  get scheduler() {
    return this.#sched;
  }

  /** labels.json: tải một lần từ đúng URL Vision dùng (?v=…), kiểm kích thước và SHA-256 theo manifest. */
  async #loadLabels() {
    if (this.#labelsState === 'ok' || this.#labelsState === 'loading') return this.#labels;
    const o = this.#o;
    const entry = o.manifest?.files?.[LABELS_PATH];
    if (!entry || typeof entry.sha256 !== 'string' || !Number.isInteger(entry.size)) {
      this.#labelsState = 'missing';
      return null;
    }
    this.#labelsState = 'loading';
    // Hạn chót (mạng treo, "lie-fi"): không có thì init() và clear() có thể chờ tới khi trình duyệt tự bỏ yêu cầu.
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const deadline = new Promise((resolve, reject) => {
      timer = o.setTimeout(() => {
        try {
          ac?.abort();
        } catch {
          // đã huỷ
        }
        reject(new Error('timeout'));
      }, VISION_LIMITS.LOAD_IDLE);
    });
    try {
      const url = this.#labelsUrl(entry);
      const get = async () => {
        const res = await o.fetch(url, ac ? { credentials: 'same-origin', signal: ac.signal } : { credentials: 'same-origin' });
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
        return res.arrayBuffer();
      };
      const buf = await Promise.race([get(), deadline]);
      await verifyBytes(buf, { path: LABELS_PATH, sha256: entry.sha256, size: entry.size }, o.digest);
      const json = JSON.parse(new TextDecoder().decode(buf));
      if (!P.checkLabels(json).ok) throw new Error('labels');
      this.#labels = json;
      this.#labelsState = 'ok';
      this.#learned?.setLabels(json);
    } catch (err) {
      this.#labelsState = 'error';
      o.log('Không tải được labels.json:', err);
    } finally {
      o.clearTimeout(timer);
    }
    return this.#labels;
  }

  /** Đúng URL mà Vision dùng cho labels.json (?v=<16 ký tự đầu SHA-256>). */
  #labelsUrl(entry) {
    return new URL(`${LABELS_PATH}?v=${entry.sha256.slice(0, VISION_LIMITS.HASH_QUERY)}`, this.#o.base || DEFAULT_BASE).href;
  }

  /**
   * Lần mở đầu tiên: init() tải labels.json trước khi service worker kịp điều khiển trang, nên tệp không vào bộ nhớ
   * đệm dữ liệu nhận diện và lần mở sau không có mạng sẽ thiếu. Khi service worker nhận trang ('controllerchange'), tải
   * lại đúng URL đó một lần (qua service worker, nó kiểm SHA-256 trước khi lưu). Không đổi trạng thái labels; lỗi bỏ qua.
   */
  #warmLabelsOnControl() {
    let sw = null;
    try {
      sw = this.#o.navigator?.serviceWorker || null;
      if (!sw || sw.controller || typeof sw.addEventListener !== 'function') return;
    } catch {
      return;
    }
    const entry = this.#o.manifest?.files?.[LABELS_PATH];
    if (!entry || typeof entry.sha256 !== 'string') return;
    const off = () => {
      try {
        sw.removeEventListener('controllerchange', warm);
      } catch {
        // đã gỡ
      }
    };
    const warm = () => {
      off();
      if (this.#disposed) return;
      try {
        Promise.resolve(this.#o.fetch(this.#labelsUrl(entry), { credentials: 'same-origin' }))
          .then((res) => res?.arrayBuffer?.())
          .catch(() => {});
      } catch {
        // chỉ để làm nóng bộ nhớ đệm
      }
    };
    sw.addEventListener('controllerchange', warm);
    this.#offs.push(off);
  }

  /** Có mạng lại: tải lại labels.json đã lỗi; bộ nhận diện đã thôi vì không tải được thì thử lại từ đầu. */
  #onOnline() {
    if (this.#disposed || !this.#limit) return;
    if (this.#labelsState === 'error') this.#loadLabels().then(() => this.#makeLearner());
    if (this.#visionGaveUp && this.#visionError === 'load') {
      this.#visionGaveUp = false;
      this.#visionRetry = 0;
      this.refresh();
    }
  }

  /**
   * Bộ học dùng đúng đối tượng labels của kho. Chưa có labels: vẫn tạo, nhưng kho chưa đưa bản ghi nào (requireLabels).
   * CameraLimit chỉ nghe lượt đi qua của biển có nhãn learn: true trong labels.json đang dùng (learnableRecord).
   */
  #makeLearner() {
    if (this.#learner && (this.#learnerLabels === this.#labels || !this.#labels)) return;
    const o = this.#o;
    const learner = new Learner({ store: this.#learned, roads: o.roads, labels: this.#labels, vehicle: this.#s.vehicle, now: o.now, mono: o.mono });
    this.#learnerLabels = this.#labels;
    learner.onPassed((e) => {
      if (learnableRecord(this.#labels, e?.record)) this.#limit.onPassed(e);
    });
    this.#learner = learner;
    this.#applyEval();
  }

  // ---------------------------------------------------------------------------------------------
  // Mỗi lần định vị và mỗi khi điều kiện đổi
  // ---------------------------------------------------------------------------------------------

  /**
   * Gọi ở mỗi lần định vị, SAU updateSigns (để signs.lastCorridor là của chính lần định vị này).
   * @param match     RoadData.matchWay của lần định vị này (cho CameraLimit)
   * @param carSpeed  tốc độ do xe báo (km/h) khi còn mới, hoặc null (như carSpeed() của main.js)
   */
  onFix(fix, { match = null, carSpeed = null } = {}) {
    if (!fix || !Array.isArray(fix.coord)) return;
    this.#lastFix = fix;
    this.#speedMs = Number.isFinite(carSpeed) && carSpeed >= 0 ? carSpeed / 3.6 : Number.isFinite(fix.speed) ? fix.speed : null;
    if (!fix.simulated) this.#noteMoving(this.#speedMs);
    const o = this.#o;
    const s = this.#s;
    const signs = o.signs;
    const corridor = signs ? signs.lastCorridor : null;
    const corridorTime = signs ? signs.lastCorridorTime : null;
    try {
      this.#learner?.onFix(fix, { corridor, corridorTime, carSpeed });
    } catch (err) {
      o.log('Bộ học biển gặp lỗi, bỏ qua lần định vị này:', err);
    }
    try {
      this.#limit?.update(fix, match, {
        roads: o.roads,
        corridor: corridorTime === fix.time ? corridor : null,
        hasData: o.roads && typeof o.roads.hasData === 'function' ? o.roads.hasData(fix.coord) : true,
        vehicle: s.vehicle,
        now: new Date(o.now()),
      });
    } catch (err) {
      this.#limit?.reset();
      o.log('Giới hạn tốc độ từ camera gặp lỗi, bỏ qua:', err);
    }
    this.refresh();
  }

  /** Gọi mỗi giây và mỗi khi xe báo tốc độ: để biết xe đã đỗ đủ lâu chưa, kể cả khi không có định vị mới. */
  tick() {
    this.#stillUpdate();
    this.refresh();
  }

  /** Ghi lại lúc xe đang chạy (speedMs m/s từ CAPTURE_SPEED trở lên): rung nhẹ của GPS khi đỗ không tới mức này. */
  #noteMoving(speedMs) {
    if (Number.isFinite(speedMs) && speedMs >= CAPTURE_SPEED) this.#movedAt = this.#o.mono();
  }

  /**
   * Cập nhật bộ đếm đứng yên. Trong chế độ lái thì không đếm (đặt lại): chỉ tính thời gian đứng yên sau khi đã rời
   * chế độ lái. Tốc độ do xe báo (OBD) cũng ghi lại lúc xe chạy, kể cả khi không có định vị mới.
   */
  #stillUpdate() {
    let kmh = null;
    try {
      kmh = this.#o.carSpeed();
    } catch {
      kmh = null;
    }
    if (Number.isFinite(kmh)) this.#noteMoving(kmh / 3.6);
    const input = this.#stillInput();
    if (DRIVING_MODES.has(this.#o.getMode())) {
      this.#still.reset();
      return { input, sinceMs: 0 };
    }
    return { input, sinceMs: this.#still.update(input) };
  }

  /** Chuyến đi mới: quên lịch sử định vị, lượt bám, các biển đang xét, giới hạn camera; bộ chọn mức tải đo lại. */
  newTrip() {
    this.#forgetSimFix();
    this.#learner?.reset();
    this.#sched?.reset();
    this.#limit?.reset();
    // Bộ nhận diện đã thôi thử lại ở chuyến trước (mạng yếu, lỗi lặp lại): chuyến mới được thử lại VISION_RETRY_MS.
    const gaveUp = this.#visionGaveUp;
    this.#visionGaveUp = false;
    this.#visionRetry = 0;
    if (gaveUp) this.refresh();
  }

  /** Quên giới hạn tốc độ camera (khi main.js tạo lại SpeedMonitor: chạy thử, đổi loại xe). */
  resetLimit() {
    this.#forgetSimFix();
    this.#limit?.reset();
  }

  /** Quên lần định vị giả cuối (chạy thử vừa xong): chuyến thật bắt đầu trước lần định vị thật đầu tiên không bị coi là chạy thử. */
  #forgetSimFix() {
    if (this.#lastFix?.simulated) {
      this.#lastFix = null;
      this.#speedMs = null;
    }
  }

  #stillInput() {
    let carStationary = null;
    try {
      const v = this.#o.carStationary();
      carStationary = typeof v === 'boolean' ? v : null;
    } catch {
      carStationary = null;
    }
    return { speed: this.#lastFix && Number.isFinite(this.#lastFix.speed) ? this.#lastFix.speed : null, carStationary };
  }

  /**
   * Xe đã đỗ (không ở chế độ lái, đứng yên ít nhất 5 giây sau khi rời chế độ lái, không chạy trong PARK_RECENT_MS vừa
   * qua): điều kiện cho mọi thao tác với camera và kho biển.
   */
  isParked() {
    const { input, sinceMs } = this.#stillUpdate();
    const movedAgoMs = this.#movedAt == null ? Infinity : this.#o.mono() - this.#movedAt;
    return isParked({ mode: this.#o.getMode(), ...input, sinceMs, movedAgoMs });
  }

  #modelsOk() {
    const m = this.#o.manifest;
    return planFiles(m, 'compat').ok || planFiles(m, 'relaxed').ok;
  }

  /** Máy và bản cài chạy được bộ nhận diện (chưa xét lỗi tạm thời). */
  #available() {
    return this.support.ok && this.#modelsOk() && !VISION_FATAL.includes(this.#visionError);
  }

  #visible() {
    const d = this.#o.document;
    return !d || d.visibilityState !== 'hidden';
  }

  #computeBlock() {
    return captureBlock({
      // Bộ nhận diện đã thôi thử lại: không giữ camera (không khung nào được xử lý), như khi không chạy được.
      camEnabled: this.#s.camEnabled === true && this.#available() && !this.#visionGaveUp,
      mode: this.#o.getMode(),
      visible: this.#visible(),
      speed: this.#speedMs,
      battery: this.#battery,
      simulated: this.#simulated() || Boolean(this.#lastFix?.simulated),
    });
  }

  #simulated() {
    try {
      return this.#o.isSimulated() === true;
    } catch {
      return false;
    }
  }

  /** Camera có nên mở lúc này không (cũng là canResume của CameraService khi trang hiện lại). */
  #wantCamera() {
    const block = this.#computeBlock();
    const blockedMs = block && block === this.#block ? this.#o.mono() - this.#blockSince : 0;
    return holdCamera({ block, blockedMs }) && this.#visionState === 'ready';
  }

  /**
   * Quyết định lại: mở, tạm trả hay đóng camera; chạy hay dừng vòng lấy khung. Gọi được bất cứ lúc nào (main.js gọi
   * khi đổi chế độ); onFix, tick, cài đặt, pin và việc ẩn/hiện trang đều tự gọi.
   */
  refresh() {
    if (!this.#limit || this.#disposed) return; // chưa init(), hoặc đã dispose()
    const o = this.#o;
    this.#expireEval();
    const driving = DRIVING_MODES.has(o.getMode());
    if (this.#driving && !driving) this.#limit.reset(); // rời chế độ lái
    this.#driving = driving;
    const block = this.#computeBlock();
    const now = o.mono();
    if (block !== this.#block) {
      this.#block = block;
      this.#blockSince = now;
      this.#armed = true;
    }
    if (this.#check && !this.isParked()) this.closeCheck(); // xe chạy: đóng màn hình kiểm tra
    const hold = holdCamera({ block, blockedMs: block ? now - this.#blockSince : 0 });
    if (!this.#enabling) {
      if (!hold) {
        this.#stopLoop();
        if (this.#cam) {
          if (block === 'off' || block === 'mode' || block === 'simulated') {
            if (this.#cam.state !== 'off') this.#cam.stop();
          } else if (block !== 'hidden') {
            this.#cam.suspend(); // xe chậm, pin yếu quá IDLE_RELEASE_MS: trả camera, vẫn giữ ý muốn chạy
          }
        }
      } else if (this.#s.camEnabled === true) {
        this.#ensureVision();
        const cam = this.#camera();
        if (this.#visionState !== 'ready') {
          // Bộ nhận diện chưa chạy được (đang tải, hỏng và đang chờ tải lại): không mở camera vô ích; đang mở thì trả
          // lại. Mở (một lần, theo quy tắc tự mở) khi bộ nhận diện sẵn sàng.
          if (cam.state === 'on' || cam.state === 'starting') {
            cam.suspend();
            this.#armed = true;
          }
        } else if (this.#armed && cam.state !== 'on' && cam.state !== 'starting') {
          this.#armed = false;
          // Tự mở: KHÔNG có userGesture, nên chỉ mở khi quyền đã là 'granted' và không bao giờ hỏi quyền.
          cam.start({ deviceId: this.#s.camDeviceId ?? null });
        }
      }
    }
    if (block === null && this.#canCapture()) this.#startLoop();
    else if (block !== null) this.#stopLoop();
    this.#emit();
  }

  #onVisibility() {
    if (!this.#visible()) {
      this.#stopLoop(); // CameraService tự trả camera khi trang ẩn
      this.#learner?.pause();
      // Luồng "Kiểm tra camera" là luồng riêng: cũng đóng (PLAN §5.1). Không tự mở lại khi hiện lại (phải bấm).
      this.closeCheck();
    }
    this.refresh();
  }

  #applySettings() {
    const s = this.#s;
    if (this.#learner) this.#learner.vehicle = s.vehicle;
    this.#applyEval();
    const on = s.camEnabled === true;
    if (this.#wasEnabled && !on) this.#shutdown();
    this.#wasEnabled = on;
    this.#armed = true; // camera đã chọn có thể vừa đổi
    this.refresh();
  }

  #applyEval() {
    const on = this.#s.camEval === true;
    if (on) {
      const ec = this.#evalStore();
      this.#learner?.setEvalCrop((c) => ec.add(c));
    } else {
      this.#learner?.setEvalCrop(null);
    }
  }

  #evalStore() {
    if (!this.#evalCrops) {
      this.#evalCrops = new EvalCrops({ backend: this.#o.evalBackend, now: this.#o.now, enabled: () => this.#s.camEval === true });
      this.#evalCrops.onChange?.(() => this.#emit());
      this.#evalCrops.load().catch(() => 0);
      this.#evalExpiredAt = this.#o.now(); // load() vừa xoá ảnh quá hạn
    }
    return this.#evalCrops;
  }

  /** Ứng dụng mở lâu: xoá ảnh kiểm tra quá hạn, nhiều nhất mỗi EVAL_EXPIRE_MS một lần (đồng hồ chỉnh lùi: xoá ngay). */
  #expireEval() {
    const ec = this.#evalCrops;
    if (!ec) return;
    const now = this.#o.now();
    const last = this.#evalExpiredAt;
    if (last != null && now >= last && now - last < EVAL_EXPIRE_MS) return;
    this.#evalExpiredAt = now;
    ec.load()
      .then(() => ec.expire())
      .catch(() => 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Camera và bộ nhận diện
  // ---------------------------------------------------------------------------------------------

  #camera() {
    if (this.#cam) return this.#cam;
    const o = this.#o;
    const deps = { navigator: o.navigator, document: o.document, now: o.mono, canResume: () => this.#s.camEnabled === true && this.#wantCamera() };
    if (o.ImageCapture !== undefined) deps.ImageCapture = o.ImageCapture;
    if (o.createImageBitmap !== undefined) deps.createImageBitmap = o.createImageBitmap;
    const f = o.cameraFactory || globalThis.__BD_TEST__?.cameraFactory;
    this.#cam = typeof f === 'function' ? f(deps) : new CameraService(deps);
    this.#cam.onState(() => {
      if (this.#cam.state !== 'on') this.#stopLoop();
      this.refresh();
    });
    return this.#cam;
  }

  /** Tải bộ nhận diện nếu chưa (không làm gì khi máy hay bản cài không chạy được). → promise của lần tải hoặc null. */
  #ensureVision() {
    if (!this.#available() || this.#visionTimer != null || this.#visionGaveUp) return null;
    if (!this.#vision) {
      const f = this.#o.visionFactory || globalThis.__BD_TEST__?.visionFactory;
      this.#vision = typeof f === 'function' ? f({ manifest: this.#o.manifest }) : new Vision();
      this.#vision.level = this.#sched?.level ?? this.#vision.level;
    }
    const v = this.#vision;
    if (v.ready) {
      this.#visionState = 'ready';
      return Promise.resolve(v);
    }
    if (this.#visionState === 'loading' && this.#visionLoad) return this.#visionLoad;
    this.#visionState = 'loading';
    this.#visionError = null;
    this.#progress = null;
    const opts = { manifest: this.#o.manifest, onProgress: (p) => this.#onProgress(p) };
    if (this.#o.base) opts.base = this.#o.base;
    const p = Promise.resolve()
      .then(() => v.load(opts))
      .then(
        () => {
          if (this.#vision !== v) return null;
          this.#visionState = 'ready';
          this.#visionOkFrames = 0; // số lần thử lại chỉ trả lại sau VISION_STABLE_FRAMES khung tốt
          this.#progress = null;
          v.level = this.#sched.level;
          this.#loadLabels().then(() => this.#makeLearner()); // labels lỗi lúc khởi động mà nay mạng đã có
          this.refresh();
          return v;
        },
        (err) => {
          if (this.#vision !== v) return null;
          this.#visionFailed(err?.code || 'load');
          return null;
        }
      );
    this.#visionLoad = p;
    p.finally(() => {
      if (this.#visionLoad === p) this.#visionLoad = null;
    });
    return p;
  }

  #visionFailed(code) {
    this.#visionState = 'error';
    this.#visionError = code;
    this.#progress = null;
    this.#stopLoop();
    if (!VISION_FATAL.includes(code)) {
      if (this.#visionRetry < VISION_RETRY_MS.length) {
        const ms = VISION_RETRY_MS[this.#visionRetry++];
        this.#visionTimer = this.#o.setTimeout(() => {
          this.#visionTimer = null;
          this.refresh(); // tải lại nếu vẫn cần camera
        }, ms);
      } else {
        // Thôi: giải phóng worker và bộ nhớ; computeBlock coi như tắt nên refresh() đóng camera.
        this.#visionGaveUp = true;
        this.#dropVision();
      }
    }
    this.refresh();
  }

  /** Khung xử lý được: đủ VISION_STABLE_FRAMES khung liên tiếp thì trả lại số lần thử lại. */
  #visionOk() {
    if (this.#visionRetry && ++this.#visionOkFrames >= VISION_STABLE_FRAMES) this.#visionRetry = 0;
  }

  /** Dừng hẹn thử lại và kết thúc bộ nhận diện (worker, bộ nhớ), giữ nguyên trạng thái lỗi. */
  #dropVision() {
    if (this.#visionTimer != null) this.#o.clearTimeout(this.#visionTimer);
    this.#visionTimer = null;
    const v = this.#vision;
    this.#vision = null;
    this.#visionLoad = null;
    this.#progress = null;
    try {
      v?.terminate();
    } catch {
      // đã kết thúc
    }
  }

  /** Giải phóng bộ nhận diện và đặt lại trạng thái của nó (giữ lỗi không tự thử lại). */
  #releaseVision() {
    this.#dropVision();
    this.#visionState = 'idle';
    if (!VISION_FATAL.includes(this.#visionError)) this.#visionError = null;
    this.#visionRetry = 0;
    this.#visionGaveUp = false;
  }

  #onProgress(p) {
    if (!p || !Number.isFinite(p.loaded) || !Number.isFinite(p.total)) return;
    const old = this.#progress;
    // Chỉ báo lại khi tiến độ đổi ít nhất PROGRESS_STEP (hoặc tải xong), để giao diện không vẽ lại theo từng gói mạng.
    if (old && old.total === p.total && p.loaded !== p.total && p.loaded - old.loaded < PROGRESS_STEP * p.total) return;
    this.#progress = { loaded: p.loaded, total: p.total };
    this.#emit();
  }

  #canCapture() {
    return Boolean(this.#learner && this.#cam && this.#cam.state === 'on' && this.#vision && this.#vision.ready && this.#visible());
  }

  #startLoop() {
    if (this.#looping) return;
    this.#looping = true;
    this.#run().catch((err) => this.#o.log('Vòng lấy khung camera dừng vì lỗi:', err));
  }

  #stopLoop() {
    this.#wake();
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const id = this.#o.setTimeout(() => {
        if (this.#wakeFn === wake) this.#wakeFn = null;
        resolve();
      }, Math.max(0, ms));
      const wake = () => {
        this.#o.clearTimeout(id);
        if (this.#wakeFn === wake) this.#wakeFn = null;
        resolve();
      };
      this.#wakeFn = wake;
    });
  }

  #wake() {
    if (this.#wakeFn) this.#wakeFn();
  }

  #mayGo() {
    return this.#block === null && this.#canCapture();
  }

  /** Vòng lấy khung: mỗi lúc đúng một khung đang xử lý. */
  async #run() {
    const o = this.#o;
    let fed = false; // bộ học đã nhận khung từ lần tạm dừng trước
    this.#emit();
    try {
      while (this.#mayGo()) {
        const plan = this.#sched.plan();
        if (plan.level === 0) {
          if (fed) this.#learner.pause();
          fed = false;
          this.#emit();
          await this.#sleep(Math.min(plan.intervalMs, PAUSE_POLL_MS));
          continue;
        }
        const t0 = o.mono();
        const frame = await this.#cam.grab();
        if (!frame) {
          await this.#sleep(GRAB_RETRY_MS);
          continue;
        }
        // Đọc cỡ khung TRƯỚC khi gửi: bitmap được chuyển sang worker và đọc lại sẽ ra 0×0.
        const width = frame.bitmap.width;
        const height = frame.bitmap.height;
        if (!this.#mayGo()) {
          closeBitmap(frame.bitmap);
          break;
        }
        const learner = this.#learner;
        this.#setGeometry(learner, width, height);
        const opts = { passes: plan.passes, foe: learner.camera.foe, hints: learner.hints(frame.t) };
        if (this.#s.camEval === true) opts.evalCrops = true;
        let r = null;
        try {
          r = await this.#vision.process(frame, opts);
        } catch (err) {
          if (!this.#onFrameError(err)) break;
        }
        if (r) {
          fed = true;
          this.#visionOk();
          learner.onVision(r, { width, height });
          this.#sched.record(r.ms.total, { passes: plan.passes });
          this.#vision.level = this.#sched.level;
        }
        if (!this.#mayGo()) break;
        await this.#sleep(plan.intervalMs - (o.mono() - t0));
      }
    } finally {
      this.#looping = false;
      if (fed) this.#learner?.pause(); // ngừng lấy khung: kết thúc và xét ngay các lượt bám đang mở
      this.#emit();
    }
  }

  /** Cỡ khung hay camAim đổi: cập nhật thông số camera của bộ học (điểm tụ = giữa khung, 0,42 chiều cao + camAim). */
  #setGeometry(learner, width, height) {
    const foe = foeFor(this.#s.camAim, width, height);
    const c = learner.camera;
    if (c.width !== width || c.height !== height || c.foe.x !== foe.x || c.foe.y !== foe.y) {
      learner.setCamera({ width, height, hfov: DEFAULT_HFOV, foe });
    }
  }

  /** Lỗi khi xử lý một khung → true nếu vòng chạy tiếp. */
  #onFrameError(err) {
    const code = err?.code || 'worker';
    if (code === 'args') {
      // Lỗi của bên gọi (khung hỏng, quá lớn): bỏ khung này, không tải lại bộ nhận diện.
      if (!this.#argsLogged) this.#o.log('Bộ nhận diện từ chối một khung:', err);
      this.#argsLogged = true;
      return true;
    }
    this.#visionFailed(code === 'load' ? 'worker' : code);
    return false;
  }

  #shutdown() {
    this.#stopLoop();
    this.closeCheck();
    if (this.#cam) this.#cam.stop();
    this.#learner?.pause();
    this.#releaseVision();
  }

  // ---------------------------------------------------------------------------------------------
  // Bật, tắt
  // ---------------------------------------------------------------------------------------------

  /**
   * Người dùng bấm bật lúc xe đã đỗ: đường DUY NHẤT (cùng openCheck) được hỏi quyền camera. Gọi ngay trong lần bấm,
   * không chờ gì trước đó. deviceId: camera đã chọn (bỏ qua = camera đã lưu). Bật thành công thì cũng bật "giữ màn hình
   * sáng" (camera chỉ chạy khi màn hình sáng) và báo lại: { ok, keepAwake, text, reason? }.
   */
  enable({ deviceId } = {}) {
    const no = (reason, text) => Promise.resolve({ ok: false, reason, text, keepAwake: false });
    if (!this.#limit) return no('not-ready', TEXT.off);
    if (!this.isParked()) return no('not-parked', TEXT.notParked);
    if (!this.support.ok) return no(this.support.reason, SUPPORT_TEXT[this.support.reason] || SUPPORT_TEXT['no-simd']);
    if (!this.#modelsOk()) return no('no-models', VISION_TEXT['no-models']);
    const s = this.#s;
    const id = deviceId === undefined ? s.camDeviceId ?? null : deviceId || null;
    if (this.#visionError === 'integrity') this.#visionError = null; // người dùng thử lại: tải lại từ đầu
    this.#visionRetry = 0;
    this.#visionGaveUp = false;
    this.#enabling = true; // trước closeCheck(): giữ bộ nhận diện vừa tải ở "Đo tốc độ xử lý"
    this.closeCheck();
    const cam = this.#camera();
    const p = cam.start({ deviceId: id, userGesture: true });
    return Promise.resolve(p).then((settings) => {
      this.#enabling = false;
      if (!settings) {
        const code = cam.error || 'failed'; // đọc trước refresh(): camera đóng lại thì mã lỗi bị xoá
        const hidden = !cam.error && (cam.state === 'paused' || !this.#visible());
        this.refresh();
        // Trang bị ẩn trong lúc hỏi quyền hay mở camera: không phải lỗi, chỉ cần bấm lại khi ứng dụng đang hiện.
        if (hidden) return { ok: false, reason: 'hidden', text: TEXT.enableHidden, keepAwake: false };
        return { ok: false, reason: code, text: CAMERA_ERROR_TEXT[code] || CAMERA_ERROR_TEXT.failed, keepAwake: false };
      }
      let keepAwake = false;
      if (s.keepAwake !== true) {
        this.#store.set('keepAwake', true);
        keepAwake = true;
      }
      this.#keepAwakeTurnedOn = keepAwake;
      if ((s.camDeviceId ?? null) !== id) this.#store.set('camDeviceId', id);
      if (s.camEnabled !== true) this.#store.set('camEnabled', true);
      this.#wasEnabled = true;
      this.#ensureVision(); // tải sẵn bộ nhận diện trong lúc đỗ
      this.refresh(); // chưa lái: camera đóng lại, sẽ tự mở khi bắt đầu lái (quyền đã được cấp)
      return { ok: true, keepAwake, text: keepAwake ? TEXT.keepAwakeOn : null };
    });
  }

  /** Tắt camera nhận diện biển. Luôn được, kể cả khi đang chạy (một lần chạm). */
  disable() {
    this.#enabling = false;
    this.#keepAwakeTurnedOn = false;
    if (this.#store.settings.camEnabled !== false) this.#store.set('camEnabled', false);
    this.#wasEnabled = false;
    this.#shutdown();
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // "Kiểm tra camera" (chỉ khi xe đã đỗ)
  // ---------------------------------------------------------------------------------------------

  /**
   * Mở luồng xem trước cho màn hình kiểm tra. Gọi ngay trong lần bấm (có thể hỏi quyền). Luồng này riêng với camera
   * lúc lái và tự đóng khi xe chạy. → { ok, stream, settings, devices, range, rangeText } | { ok:false, reason, text }.
   */
  openCheck({ deviceId } = {}) {
    const no = (reason, text) => Promise.resolve({ ok: false, reason, text });
    if (!this.isParked()) return no('not-parked', TEXT.parkedOnly);
    if (!this.support.ok) return no(this.support.reason, SUPPORT_TEXT[this.support.reason] || SUPPORT_TEXT['no-simd']);
    const md = this.#o.navigator?.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') return no('unsupported', CAMERA_ERROR_TEXT.unsupported);
    this.#closeCheck(false); // mở lại, đổi camera: giữ bộ nhận diện đã tải để đo
    if (this.#cam && this.#cam.state !== 'off') this.#cam.stop(); // xe đỗ: camera lúc lái vốn đã đóng
    const id = deviceId === undefined ? this.#s.camDeviceId ?? null : deviceId || null;
    const gen = ++this.#checkGen;
    const open = async () => {
      let lastErr = null;
      for (let step = 0; step < CONSTRAINT_STEPS; step++) {
        try {
          return await md.getUserMedia(cameraConstraints(step, id)); // lần gọi đầu nằm ngay trong lần bấm
        } catch (err) {
          lastErr = err;
          if (errorCode(err) !== 'overconstrained' || err?.constraint === 'deviceId') break;
        }
      }
      throw lastErr;
    };
    return open().then(
      async (stream) => {
        if (gen !== this.#checkGen) {
          stopTracks(stream);
          return { ok: false, reason: 'closed', text: null };
        }
        const track = stream.getVideoTracks?.()[0] || null;
        this.#check = { stream, track, deviceId: id };
        const settings = trackSettings(track, id);
        const devices = await this.#camera().list();
        const range = readRange(settings.width, settings.height);
        this.#emit();
        return { ok: true, stream, settings, devices, range, rangeText: rangeText(range) };
      },
      (err) => {
        let code = errorCode(err);
        if (code === 'overconstrained' && err?.constraint === 'deviceId') code = 'not-found';
        return { ok: false, reason: code, text: CAMERA_ERROR_TEXT[code] || CAMERA_ERROR_TEXT.failed };
      }
    );
  }

  /** Lưu camera đã chọn ở màn hình kiểm tra (chỉ khi đỗ). */
  setDevice(deviceId) {
    if (!this.isParked()) return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly };
    this.#store.set('camDeviceId', deviceId || null);
    return { ok: true };
  }

  /**
   * Đo tốc độ bộ nhận diện thật trên luồng kiểm tra: frames khung cho mỗi tổ hợp lượt quét ('A' và 'A'+'B', xen kẽ như
   * mức 3). video: thẻ <video> đang phát luồng xem trước (dùng khi trình duyệt không có ImageCapture). Xong thì báo
   * p90 cho bộ chọn mức tải (setParkedCheck). → { ok, passes: { A, AB: { n, p50, p90 } }, p50, p90, level, maxLevel,
   * width, height, fps, range, rangeText } | { ok:false, reason, text }.
   */
  async measureCheck({ frames = CHECK_FRAMES, video = null, onProgress = null } = {}) {
    const check = this.#check;
    if (!check || !check.track) return { ok: false, reason: 'no-check', text: null };
    if (!this.isParked()) {
      this.closeCheck();
      return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly };
    }
    const n = Math.min(CHECK_FRAMES_MAX, Math.max(1, Math.round(frames) || CHECK_FRAMES));
    const gen = this.#checkGen;
    const v = await this.#ensureVision();
    if (gen !== this.#checkGen) return { ok: false, reason: 'closed', text: null };
    if (!v || !v.ready) {
      const code = this.#visionError || (this.#available() ? 'load' : this.#modelsOk() ? 'unsupported' : 'no-models');
      return { ok: false, reason: code, text: VISION_TEXT[code] || VISION_TEXT.load };
    }
    const o = this.#o;
    const grab = this.#checkGrabber(check.track, video);
    const times = { A: [], AB: [] };
    let width = null;
    let height = null;
    let fails = 0;
    for (let i = 0; times.A.length < n || times.AB.length < n; i++) {
      if (gen !== this.#checkGen || !this.isParked()) return { ok: false, reason: 'closed', text: null };
      const passes = times.A.length > times.AB.length ? ['A', 'B'] : ['A'];
      let bitmap = null;
      try {
        bitmap = await grab();
      } catch {
        bitmap = null;
      }
      if (!bitmap) {
        if (++fails >= CHECK_GRAB_FAILS) return { ok: false, reason: 'grab', text: CAMERA_ERROR_TEXT.grab };
        await this.#sleep(GRAB_RETRY_MS);
        continue;
      }
      fails = 0;
      width = bitmap.width; // trước khi gửi (bitmap được chuyển đi)
      height = bitmap.height;
      let r = null;
      try {
        r = await v.process({ bitmap, t: o.mono() }, { passes, foe: foeFor(this.#s.camAim, width, height) });
      } catch (err) {
        const code = err?.code || 'worker';
        // Luồng kiểm tra vừa đóng (bộ nhận diện bị giải phóng theo): không phải lỗi của bộ nhận diện.
        if (gen !== this.#checkGen || this.#vision !== v) return { ok: false, reason: 'closed', text: null };
        if (code !== 'args') {
          this.#visionFailed(code);
          return { ok: false, reason: code, text: VISION_TEXT[code] || VISION_TEXT.load };
        }
      }
      if (r) {
        this.#visionOk();
        times[passes.length > 1 ? 'AB' : 'A'].push(r.ms.total);
        if (onProgress) {
          try {
            onProgress({ done: times.A.length + times.AB.length, total: 2 * n });
          } catch {
            // lỗi của hàm báo tiến độ không làm hỏng việc đo
          }
        }
      }
    }
    const sum = (list) => {
      const s = list.slice().sort((a, b) => a - b);
      return { n: s.length, p50: pct(s, 0.5), p90: pct(s, 0.9) };
    };
    const all = [...times.A, ...times.AB].sort((a, b) => a - b);
    const p90 = pct(all, 0.9);
    this.#sched.setParkedCheck({ p90 });
    const range = readRange(width, height);
    this.#emit();
    return {
      ok: true,
      passes: { A: sum(times.A), AB: sum(times.AB) },
      p50: pct(all, 0.5),
      p90,
      level: this.#sched.level,
      maxLevel: this.#sched.maxLevel,
      width,
      height,
      fps: trackSettings(check.track, check.deviceId).frameRate,
      range,
      rangeText: rangeText(range),
    };
  }

  /** Lấy một ImageBitmap từ luồng kiểm tra: ImageCapture nếu có, không thì từ thẻ <video> xem trước. */
  #checkGrabber(track, video) {
    const o = this.#o;
    let ic = null;
    if (typeof o.ImageCapture === 'function') {
      try {
        ic = new o.ImageCapture(track);
      } catch {
        ic = null;
      }
    }
    if (ic) return () => ic.grabFrame();
    const cib = o.createImageBitmap;
    return async () => {
      if (!video || typeof cib !== 'function' || !(video.readyState >= 2) || !(video.videoWidth > 0)) return null;
      return cib.call(globalThis, video);
    };
  }

  /**
   * Đóng luồng kiểm tra (gọi bao nhiêu lần cũng được). Tính năng đang tắt thì cũng giải phóng bộ nhận diện mà "Đo tốc độ
   * xử lý" đã tải (hàng chục MB), trừ khi đang bật (enable() giữ nó lại).
   */
  closeCheck() {
    this.#closeCheck(true);
  }

  #closeCheck(release) {
    this.#checkGen++;
    if (release && this.#vision && this.#s.camEnabled !== true && !this.#enabling) {
      this.#releaseVision();
      this.#emit();
    }
    if (!this.#check) return;
    stopTracks(this.#check.stream);
    this.#check = null;
    this.#emit();
  }

  // ---------------------------------------------------------------------------------------------
  // Xem lại, nhập, xuất (chỉ khi đỗ; xoá thì luôn được)
  // ---------------------------------------------------------------------------------------------

  #parked(fn) {
    if (!this.isParked()) return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly };
    if (!this.#learned) return { ok: false, reason: 'not-ready', text: null };
    return fn(this.#learned);
  }

  /** Danh sách biển đã học, gần nhất trước (near mặc định là vị trí xe). */
  list({ near } = {}) {
    if (!this.#learned) return [];
    return this.#learned.list({ near: near ?? this.#lastFix?.coord ?? null });
  }

  /** "Đúng" */
  confirm(id) {
    return this.#parked((l) => {
      const record = l.confirm(id);
      return { ok: record != null, record };
    });
  }

  /** "Sai" */
  reject(id) {
    return this.#parked((l) => {
      const record = l.reject(id);
      return { ok: record != null, record };
    });
  }

  /** "Biển đã bị dỡ" */
  removed(id) {
    return this.#parked((l) => {
      const record = l.removed(id);
      return { ok: record != null, record };
    });
  }

  /** "Xoá các biển đã học": luôn được. Cũng thôi giới hạn tốc độ đang lấy từ biển camera. */
  async clear() {
    await this.#loaded; // chỉ chờ đọc kho xong (để không bị ghi lại), không chờ labels.json
    this.#limit?.reset();
    this.#learner?.reset();
    if (this.#learned) await this.#learned.clear();
    this.#emit();
    return { ok: true };
  }

  /**
   * Xuất GeoJSON (chỉ khi đỗ). Giao diện phải hiện EXPORT_WARNING trước khi lưu tệp. withDates: kèm ngày thấy.
   * → { ok, data, json, filename, count, warning }
   */
  exportGeoJSON({ withDates = false } = {}) {
    return this.#parked((l) => {
      const data = l.exportGeoJSON({ withDates: withDates === true });
      const day = new Date(this.#o.now()).toISOString().slice(0, 10);
      return { ok: true, data, json: JSON.stringify(data, null, 1), filename: `ban-duong-bien-da-hoc-${day}.geojson`, count: data.features.length, warning: EXPORT_WARNING };
    });
  }

  /** Nhập tệp GeoJSON (chuỗi hoặc đối tượng; chỉ khi đỗ) → { ok, added, skipped, error?, text }. */
  importGeoJSON(input) {
    return this.#parked((l) => {
      const res = l.importGeoJSON(input);
      return { ok: !res.error || res.added > 0, ...res, text: importText(res) };
    });
  }

  // ---- Ảnh kiểm tra độ chính xác (camEval) ----

  evalCounts() {
    return this.#evalCrops ? this.#evalCrops.counts() : { total: 0, accepted: 0, nearMiss: 0 };
  }

  async evalList() {
    if (!this.isParked()) return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly, items: [] };
    const ec = this.#evalStore();
    await ec.load();
    return { ok: true, items: await ec.list() };
  }

  /** Xuất ảnh kiểm tra (chỉ khi đỗ, sau khi hiện warning) → { ok, blob, filename, warning }. */
  async evalExport() {
    if (!this.isParked()) return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly };
    const ec = this.#evalStore();
    await ec.load();
    return { ok: true, blob: await ec.exportFile(), filename: EVAL_FILE_NAME, warning: EVAL_TEXT.exportWarning };
  }

  async evalRemove(id) {
    if (!this.isParked()) return { ok: false, reason: 'not-parked', text: TEXT.parkedOnly };
    const ec = this.#evalStore();
    await ec.load();
    return { ok: await ec.remove(id) };
  }

  /** "Xoá ảnh biển đã lưu": luôn được. */
  async evalClear() {
    const ec = this.#evalStore();
    await ec.load();
    await ec.clear();
    this.#emit();
    return { ok: true };
  }

  /** Giải phóng bộ nhớ chiếm bởi dữ liệu nhận diện đã lưu trong bộ nhớ đệm (service worker), khi người dùng muốn. */
  async clearModelCache() {
    try {
      return { ok: (await globalThis.caches?.delete('banduong-ml-1')) === true };
    } catch {
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Trạng thái cho giao diện
  // ---------------------------------------------------------------------------------------------

  /** Ảnh chụp trạng thái (đối tượng mới, đóng băng). */
  get state() {
    const s = this.#store.settings;
    const c = this.#learned ? this.#learned.counts() : null;
    const cam = this.#cam ? this.#cam.state : 'off';
    const st = {
      support: { ok: this.support.ok, reason: this.support.reason },
      enabled: s.camEnabled === true,
      camera: cam,
      cameraError: this.#cam?.error ?? null,
      vision: this.#visionState,
      visionError: this.#visionError,
      visionGaveUp: this.#visionGaveUp,
      progress: this.#progress,
      models: this.#modelsOk() ? 'ok' : 'no-models',
      labels: this.#labelsState,
      level: this.#sched ? this.#sched.level : null,
      block: this.#limit ? this.#block : 'off',
      capturing: this.#looping,
      parked: this.#limit ? this.isParked() : false,
      // learned: biển đang dùng; stored: mọi biển xuất được và bị "Xoá" xoá (gồm cả biển bị cất, LearnedSigns#dormant).
      counts: { learned: c ? c.shown : 0, confirmed: c ? c.confirmed : 0, candidates: c ? c.candidate : 0, stored: c ? c.shown + c.dormant : 0 },
      health: this.#looping && this.#learner ? this.#learner.health().reason : null,
      keepAwakeTurnedOn: this.#keepAwakeTurnedOn,
      check: this.#check ? 'open' : null,
      evalCount: this.#evalCrops ? this.#evalCrops.size : 0,
      camEval: s.camEval === true,
      signCamera: s.signCamera !== false,
      camSpeed: s.camSpeed !== false,
      learnable: learnableCount(this.#labels),
      speedLearnable: speedLearnable(this.#labels),
      speedLimit: this.speedLimit ? this.speedLimit.n : null,
    };
    st.text = stateText(st);
    return Object.freeze(st);
  }

  /** fn(state) mỗi khi trạng thái đổi → hàm huỷ. Lỗi của fn bị bỏ qua. */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    if (!this.#listeners.size) return;
    const st = this.state;
    const key = JSON.stringify(st);
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    for (const fn of this.#listeners) {
      try {
        fn(st);
      } catch {
        // lỗi của giao diện không làm hỏng camera
      }
    }
  }

  /** Gỡ mọi trình nghe, đóng camera và bộ nhận diện (kiểm thử). */
  dispose() {
    this.#disposed = true;
    this.#shutdown();
    this.#cam?.dispose?.();
    for (const off of this.#offs.splice(0)) {
      try {
        off?.();
      } catch {
        // đã gỡ
      }
    }
    this.#listeners.clear();
  }
}
