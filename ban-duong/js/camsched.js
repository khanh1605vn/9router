// Nhịp chạy của camera nhận diện biển (thử nghiệm). Thuần logic, không đụng tới DOM, đồng hồ được truyền vào.
// - canAutoStart: tự mở camera (lúc khởi động, khi trang hiện lại) chỉ khi quyền đã được cấp hẳn; không bao giờ tự hỏi
//   quyền vì người lái có thể đang chạy xe (PLAN §5.1, camera.verdict.md mục 1).
// - isParked / StillTimer: các thao tác cần chạm máy (bật camera, kiểm tra camera, duyệt biển) chỉ được làm khi xe đã
//   đỗ thật: ngoài chế độ lái, đứng yên ít nhất 5 giây và không chạy trong 2 phút vừa qua. Dừng đèn đỏ không tính, kể
//   cả khi người lái rời chế độ lái lúc đang dừng (§6.1).
// - shouldCapture / captureBlock: có lấy khung hình lúc này không (§5.1); holdCamera: có giữ camera mở không.
// - LevelScheduler: chọn mức tải 0–3 theo thời gian worker đo được, để camera không chiếm quá 25 % một nhân và lùi lại
//   khi máy nóng (§5.6). Trang web trên Android không đọc được nhiệt độ hay mức tải của máy (không có
//   PressureObserver), nên dấu hiệu máy nóng là thời gian xử lý mỗi khung tăng so với lúc đầu.
// - foeFor: điểm tụ (FOE) trong khung hình từ độ chỉnh camAim của người dùng.

// ---- Chế độ và trạng thái xe ----
export const DRIVING_MODES = new Set(['nav', 'drive']); // các chế độ đang lái (main.js state.mode)
export const PARK_SPEED = 1; // dưới tốc độ này (m/s) là xe đứng yên
export const PARK_STILL_MS = 5000; // đứng yên ít nhất chừng này (ms) mới coi là đã đỗ
// Xe vừa chạy (từ CAPTURE_SPEED trở lên, theo OBD hay GPS thật) cách đây chưa tới chừng này (ms) thì chưa coi là đã đỗ,
// dù đã rời chế độ lái: dừng đèn đỏ (thường 30–90 giây) rồi bấm "Kết thúc" hay nhấn giữ bản đồ không phải là đỗ xe.
// Trang web không phân biệt chắc được một lần dừng lâu với đỗ xe; đây là cách gần nhất.
export const PARK_RECENT_MS = 120e3;

// ---- Lấy khung hình (§5.1) ----
export const CAPTURE_SPEED = 3; // chỉ lấy khung khi xe chạy từ chừng này (m/s, ~11 km/h) trở lên
export const BATTERY_MIN = 0.2; // pin dưới mức này (0–1) mà không sạc thì tạm dừng
// Không lấy khung (xe chạy chậm, pin yếu…) liên tục lâu hơn chừng này (ms) thì đóng hẳn camera cho đỡ tốn pin và nóng
// máy; khi lấy khung lại được thì mở lại theo canAutoStart. Trang vẫn hiện nên quyền dùng một lần chưa hết hạn.
export const IDLE_RELEASE_MS = 120e3;

// ---- Mức tải (§5.6) ----
// fps: số khung xử lý mỗi giây; b: có quét lượt B (cả khung thu nhỏ) ở mỗi khung thứ hai không.
export const LEVELS = Object.freeze({
  1: Object.freeze({ fps: 2, b: false }),
  2: Object.freeze({ fps: 3, b: true }),
  3: Object.freeze({ fps: 5, b: true }),
});
export const DEFAULT_LEVEL = 2; // mức mặc định
export const BUDGET_MS_PER_S = 250; // trung vị thời gian worker × số khung mỗi giây không quá chừng này (ms mỗi giây)
export const FAST_P90_MS = 60; // mức 3 chỉ được dùng khi lần kiểm tra lúc đỗ đo p90 (ms.total) dưới chừng này (ms)
export const WINDOW_MS = 20e3; // cửa sổ trượt (ms) để tính trung vị và số khung mỗi giây
export const MIN_SAMPLES = 10; // cần ít nhất chừng này khung trong cửa sổ trước khi đổi mức
// Còn dư tải cho mức trên chừng này (ms thời gian xử lý, cộng dồn qua các lần xe dừng) thì lên một mức.
export const STEP_UP_MS = 120e3;
export const RISE_FACTOR = 1.5; // trung vị tăng từ chừng này lần so với mốc ban đầu: máy đang nóng, hạ một mức
export const BASELINE_MS = 300e3; // mốc ban đầu là trung vị trong chừng này (ms) xử lý đầu tiên (5 phút)
export const RISE_MIN = 5; // mỗi tổ hợp lượt quét cần ít nhất chừng này khung để so với mốc
// Ở mức 1 mà vẫn quá ngân sách chừng này (ms thời gian xử lý, cộng dồn qua các lần xe dừng) thì tạm dừng.
export const OVER_AT_1_MS = 60e3;
export const PAUSE_MS = 300e3; // tạm dừng chừng này (ms) rồi chạy lại từ mức 1
// Hai khung cách nhau quá chừng này (ms) (xe dừng, trang ẩn): bỏ các khung cũ trong cửa sổ đo (số khung mỗi giây phải
// đo lại), nhưng giữ thời gian đã quá ngân sách / đã dư tải, vì đi phố cứ vài chục giây lại dừng đèn đỏ.
export const GAP_MS = 5e3;
export const KEY_WINDOW = 30; // số khung gần nhất nhớ riêng cho từng tổ hợp lượt quét ('A', 'AB')
// Chưa đo được khung có cả lượt B thì ước thời gian của nó bằng chừng này lần khung chỉ có lượt A (thêm một lần chạy
// bộ dò cùng cỡ đầu vào).
export const B_COST_FACTOR = 2;
export const BASELINE_MAX = 2000; // số khung tối đa giữ cho mốc ban đầu, mỗi tổ hợp lượt quét

// ---- Điểm tụ (§5.2) ----
export const FOE_Y_FRAC = 0.42; // điểm tụ mặc định nằm ở 0,42 chiều cao khung, giữa chiều ngang

/** Tự mở camera (không có thao tác của người dùng) chỉ khi quyền đã được cấp; 'prompt', 'denied', 'unknown' thì thôi. */
export function canAutoStart(permissionState) {
  return permissionState === 'granted';
}

/**
 * Xe đang đứng yên. Có carStationary (true/false, từ tốc độ của xe qua OBD hoặc hàm carStationary() của main.js) thì
 * theo nó; không thì theo tốc độ GPS. Không có tốc độ (máy không báo khi đứng yên) cũng tính là đứng yên, như main.js.
 */
export function isStill({ speed = null, carStationary = null } = {}) {
  if (typeof carStationary === 'boolean') return carStationary;
  return !(speed >= PARK_SPEED);
}

/**
 * Xe đã đỗ: không ở chế độ lái, đứng yên liên tục ít nhất PARK_STILL_MS (sinceMs đo bằng StillTimer) và lần cuối xe
 * chạy (movedAgoMs, Infinity nếu chưa chạy từ lúc mở ứng dụng) đã cách ít nhất PARK_RECENT_MS.
 */
export function isParked({ mode, speed = null, carStationary = null, sinceMs = 0, movedAgoMs = Infinity } = {}) {
  if (DRIVING_MODES.has(mode)) return false;
  if (!(movedAgoMs >= PARK_RECENT_MS)) return false;
  if (!isStill({ speed, carStationary })) return false;
  return Number.isFinite(sinceMs) && sinceMs >= PARK_STILL_MS;
}

/** Đếm xe đã đứng yên liên tục bao lâu (ms). Gọi update() ở mỗi lần định vị hoặc mỗi lần xe báo tốc độ. */
export class StillTimer {
  constructor({ now = () => performance.now() } = {}) {
    this._now = now;
    this._since = null;
  }

  /** Trả số ms xe đã đứng yên (0 nếu đang chạy). */
  update(input) {
    const t = this._now();
    if (!isStill(input)) this._since = null;
    else if (this._since == null) this._since = t;
    return this.sinceMs();
  }

  sinceMs() {
    return this._since == null ? 0 : Math.max(0, this._now() - this._since);
  }

  reset() {
    this._since = null;
  }
}

/**
 * Lý do không lấy khung hình lúc này, hoặc null nếu được lấy:
 *   'off' chưa bật, 'mode' không ở chế độ lái, 'hidden' trang bị ẩn, 'simulated' đang chạy thử,
 *   'slow' xe chạy dưới CAPTURE_SPEED (hoặc không rõ tốc độ), 'battery' pin dưới BATTERY_MIN và không sạc.
 * battery = { level (0–1), charging } hoặc null khi trình duyệt không cho đọc pin.
 */
export function captureBlock({ camEnabled = false, mode, visible = false, speed = null, battery = null, simulated = false } = {}) {
  if (!camEnabled) return 'off';
  if (!DRIVING_MODES.has(mode)) return 'mode';
  if (!visible) return 'hidden';
  if (simulated) return 'simulated';
  if (!(speed >= CAPTURE_SPEED)) return 'slow';
  if (battery && battery.charging !== true && Number.isFinite(battery.level) && battery.level < BATTERY_MIN) return 'battery';
  return null;
}

/** Có lấy khung hình lúc này không (PLAN §5.1). */
export function shouldCapture(input) {
  return captureBlock(input) === null;
}

/**
 * Có giữ camera mở không. block là kết quả captureBlock, blockedMs là thời gian nó đã kéo dài liên tục.
 * Tắt tính năng, rời chế độ lái, trang bị ẩn hay đang chạy thử thì đóng ngay (chạy thử không bao giờ mở camera: không
 * lấy khung nào, thường là ở trong nhà); xe chậm, pin yếu quá IDLE_RELEASE_MS thì đóng.
 */
export function holdCamera({ block = null, blockedMs = 0 } = {}) {
  if (block === null) return true;
  if (block === 'off' || block === 'mode' || block === 'hidden' || block === 'simulated') return false;
  return !(blockedMs >= IDLE_RELEASE_MS);
}

/** Điểm tụ trong khung W×H px: giữa khung theo chiều ngang, 0,42 chiều cao, cộng độ chỉnh camAim, giữ trong khung. */
export function foeFor(camAim, W, H) {
  const dx = Number.isFinite(camAim?.dx) ? camAim.dx : 0;
  const dy = Number.isFinite(camAim?.dy) ? camAim.dy : 0;
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  return { x: clamp(W / 2 + dx, W), y: clamp(FOE_Y_FRAC * H + dy, H) };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const passKey = (passes) => (Array.isArray(passes) && passes.length ? [...new Set(passes)].sort().join('') : 'all');

/**
 * Chọn mức tải cho khung kế tiếp (PLAN §5.6):
 *   0 tạm dừng · 1: 2 khung/giây, chỉ lượt A · 2 (mặc định): 3 khung/giây, lượt B mỗi khung thứ hai · 3: 5 khung/giây,
 *   lượt B mỗi khung thứ hai, chỉ khi lần kiểm tra lúc đỗ đo p90 < FAST_P90_MS.
 * Tải = trung vị thời gian worker × số khung xử lý mỗi giây (đo trong cửa sổ WINDOW_MS). Quá BUDGET_MS_PER_S, hoặc
 * trung vị của một tổ hợp lượt quét tăng từ RISE_FACTOR lần so với mốc 5 phút đầu: hạ một mức. Ước tải ở mức trên vẫn
 * trong ngân sách suốt STEP_UP_MS: lên một mức. Ở mức 1 mà vẫn quá ngân sách suốt OVER_AT_1_MS: tạm dừng PAUSE_MS.
 * Hai khoảng thời gian này tính bằng thời gian xử lý: lúc xe dừng (khoảng nghỉ quá GAP_MS) không cộng vào nhưng cũng
 * không xoá, chỉ một lần đánh giá thấy điều kiện không còn đúng mới xoá.
 * Cách dùng: plan() trước mỗi khung, record(result.ms.total, { passes }) sau mỗi khung đã xử lý. Không gọi reset() mỗi
 * lần xe dừng: khoảng nghỉ được tự nhận ra.
 */
export class LevelScheduler {
  constructor({ now = () => performance.now(), level = DEFAULT_LEVEL, parkedP90 = null } = {}) {
    this._now = now;
    this._fast = Number.isFinite(parkedP90) && parkedP90 < FAST_P90_MS;
    this.level = Math.min(Math.max(Math.round(level) || DEFAULT_LEVEL, 1), this.maxLevel);
    this._listeners = new Set();
    this._pausedUntil = null;
    this._lastB = true; // khung đầu tiên chỉ quét lượt A
    this._base = new Map(); // tổ hợp lượt quét → các thời gian trong 5 phút đầu
    this._baseline = null; // tổ hợp lượt quét → trung vị mốc, khi đã đủ 5 phút
    this._active = 0; // thời gian đã xử lý liên tục, cộng dồn (ms), cho mốc ban đầu
    this._keys = new Map(); // tổ hợp lượt quét → KEY_WINDOW thời gian gần nhất (không xoá khi đổi mức)
    this._win = [];
    this._clearTimers();
    this._last = null;
  }

  /** Mức cao nhất được dùng: 3 nếu lần kiểm tra lúc đỗ đủ nhanh, không thì 2. */
  get maxLevel() {
    return this._fast ? 3 : 2;
  }

  get pausedUntil() {
    return this._pausedUntil;
  }

  /** Kết quả lần kiểm tra camera lúc đỗ (p90 của ms.total). Không đủ nhanh thì hạ về mức 2 nếu đang ở mức 3. */
  setParkedCheck({ p90 } = {}) {
    this._fast = Number.isFinite(p90) && p90 < FAST_P90_MS;
    if (this.level > this.maxLevel) this._set(this.maxLevel, this._now(), 'check');
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Khung kế tiếp: { level, intervalMs (khoảng giữa hai lần bắt đầu khung, hoặc thời gian còn tạm dừng), passes }. */
  plan(now = this._now()) {
    if (this._paused(now)) return { level: 0, intervalMs: this._pausedUntil - now, passes: [] };
    const def = LEVELS[this.level];
    const passes = def.b && this._lastB === false ? ['A', 'B'] : ['A'];
    return { level: this.level, intervalMs: Math.round(1000 / def.fps), passes };
  }

  /** Ghi một khung đã xử lý: ms = thời gian trong worker (VisionResult.ms.total), passes = các lượt đã quét. */
  record(ms, { at = this._now(), passes = null } = {}) {
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(at)) return;
    if (this._paused(at)) return; // khung lạc vào lúc đang tạm dừng
    const key = passKey(passes);
    const gap = this._last != null && (at - this._last > GAP_MS || at < this._last);
    // Thời gian xử lý liên tục kể từ khung trước; qua một khoảng nghỉ thì là 0.
    const dt = this._last == null || gap ? 0 : at - this._last;
    if (gap) this._win = []; // số khung mỗi giây đo lại sau khoảng nghỉ; các bộ đếm thời gian vẫn giữ
    this._active += dt;
    this._last = at;
    this._lastB = Array.isArray(passes) ? passes.includes('B') : !this._lastB;

    this._win.push({ at, ms, key });
    while (this._win.length && at - this._win[0].at > WINDOW_MS) this._win.shift();
    const recent = this._keys.get(key) || [];
    recent.push(ms);
    if (recent.length > KEY_WINDOW) recent.shift();
    this._keys.set(key, recent);
    if (!this._baseline) {
      const b = this._base.get(key) || [];
      if (b.length < BASELINE_MAX) b.push(ms);
      this._base.set(key, b);
      if (this._active >= BASELINE_MS) this._finishBaseline();
    }
    this._evaluate(at, dt);
  }

  /** Số đo hiện tại cho màn hình "Kiểm tra camera". */
  stats() {
    const m = this._measure();
    return {
      level: this.level,
      maxLevel: this.maxLevel,
      median: m ? m.median : null,
      perFrame: m ? m.perFrame : null,
      fps: m ? m.fps : null,
      load: m ? m.load : null,
      baseline: this._baseline ? Object.fromEntries(this._baseline) : null,
      pausedUntil: this._pausedUntil,
      overMs: this._overMs, // thời gian xử lý đã quá ngân sách ở mức 1 (ms), so với OVER_AT_1_MS
      headroomMs: this._headMs, // thời gian xử lý mức trên đã còn dư tải (ms), so với STEP_UP_MS
    };
  }

  /**
   * Chuyến mới: đo lại từ đầu, xoá cả hai bộ đếm thời gian. Giữ mức, mốc ban đầu, kết quả kiểm tra và thời gian tạm
   * dừng. Xe dừng giữa chuyến thì không cần gọi.
   */
  reset() {
    this._win = [];
    this._clearTimers();
    this._last = null;
  }

  _clearTimers() {
    this._headMs = 0; // thời gian xử lý (ms) mà ước tải ở mức trên vẫn trong ngân sách
    this._overMs = 0; // thời gian xử lý (ms) mà mức 1 vẫn quá ngân sách
  }

  /** Đang tạm dừng ở thời điểm `at`? Hết thời gian tạm dừng thì chạy lại từ mức 1. */
  _paused(at) {
    if (this._pausedUntil == null) return false;
    if (at < this._pausedUntil) return true;
    this._pausedUntil = null;
    this._set(1, at, 'resume');
    return false;
  }

  _finishBaseline() {
    this._baseline = new Map();
    for (const [key, list] of this._base) {
      if (list.length >= RISE_MIN) this._baseline.set(key, median(list));
    }
    this._base = new Map();
  }

  /**
   * Tải trong cửa sổ: số khung mỗi giây × thời gian mỗi khung. Ở mức 2 và 3 khung chỉ có lượt A xen kẽ khung có cả
   * lượt B, nên thời gian có hai cụm và một trung vị chung nhảy qua lại giữa hai cụm; vì vậy lấy trung vị riêng của
   * từng tổ hợp lượt quét rồi cộng theo tỉ lệ khung của tổ hợp đó. Chỉ có một tổ hợp thì đúng là trung vị × fps.
   */
  _measure() {
    const n = this._win.length;
    if (n < 2) return null;
    const span = this._win[n - 1].at - this._win[0].at;
    if (!(span > 0)) return null;
    const fps = ((n - 1) * 1000) / span;
    let perFrame = 0;
    for (const list of this._byKey().values()) perFrame += (list.length / n) * median(list);
    return { n, median: median(this._win.map((r) => r.ms)), perFrame, fps, load: perFrame * fps };
  }

  _byKey() {
    const by = new Map();
    for (const r of this._win) {
      if (!by.has(r.key)) by.set(r.key, []);
      by.get(r.key).push(r.ms);
    }
    return by;
  }

  /** Trung vị của một tổ hợp lượt quét trong cửa sổ hiện tại đã tăng từ RISE_FACTOR lần so với mốc chưa. */
  _risen() {
    if (!this._baseline) return false;
    for (const [key, list] of this._byKey()) {
      const base = this._baseline.get(key);
      if (base == null || list.length < RISE_MIN) continue;
      if (median(list) >= RISE_FACTOR * base) return true;
    }
    return false;
  }

  /** Ước thời gian worker mỗi khung ở một mức, từ các khung gần nhất của từng tổ hợp lượt quét. */
  _costAt(level) {
    const of = (key) => median(this._keys.get(key) || []);
    const a = of('A') ?? of('all');
    if (a == null) return null;
    if (!LEVELS[level].b) return a;
    const ab = of('AB') ?? (this._keys.has('A') ? a * B_COST_FACTOR : a);
    return (a + ab) / 2;
  }

  /**
   * Đánh giá sau mỗi khung; dt là thời gian xử lý từ khung trước (0 ngay sau khoảng nghỉ). Chưa đủ MIN_SAMPLES khung
   * trong cửa sổ thì chưa kết luận gì: không cộng, không xoá bộ đếm.
   */
  _evaluate(at, dt) {
    if (this._win.length < MIN_SAMPLES) return;
    const m = this._measure();
    if (!m) return;
    if (m.load > BUDGET_MS_PER_S) {
      this._headMs = 0;
      if (this.level > 1) {
        this._set(this.level - 1, at, 'budget');
        return;
      }
      this._overMs += dt;
      if (this._overMs >= OVER_AT_1_MS) this._pause(at);
      return;
    }
    this._overMs = 0;
    if (this._risen()) {
      this._headMs = 0;
      if (this.level > 1) this._set(this.level - 1, at, 'heat');
      return;
    }
    const next = this.level + 1;
    const cost = next <= this.maxLevel ? this._costAt(next) : null;
    if (cost == null || cost * LEVELS[next].fps > BUDGET_MS_PER_S) {
      this._headMs = 0;
      return;
    }
    this._headMs += dt;
    if (this._headMs >= STEP_UP_MS) this._set(next, at, 'headroom');
  }

  _pause(at) {
    this._pausedUntil = at + PAUSE_MS;
    this._set(0, at, 'budget');
  }

  _set(level, at, reason) {
    const from = this.level;
    this.level = level;
    this._win = []; // đổi mức: đo lại từ đầu
    this._clearTimers();
    if (from !== level) this._emit({ level, from, reason, at });
  }

  _emit(change) {
    for (const fn of this._listeners) {
      try {
        fn(change);
      } catch {
        // lỗi của người nghe không làm hỏng bộ lập lịch
      }
    }
  }
}
