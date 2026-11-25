// Lời mời cập nhật trên màn hình: khi nào được hiện (xe đứng yên, không dẫn đường, không có cảnh báo) và bản web mới
// (service worker mới đã nắm trang). Phần nói chuyện với bộ cập nhật của ứng dụng Android nằm trong carbridge.js
// (AppUpdate, describeUpdate); tệp này chỉ quyết định lúc hiện và nút "tải lại" của bản web. Không chạm DOM: main.js gắn.

/**
 * Ngưỡng của QuietGate.
 * movingKmh: từ tốc độ này trở lên là xe đang chạy (bằng ngưỡng máy từ chối mở hộp thoại cài, mã "driving").
 * stopHoldMs: phải đứng yên liên tục chừng này mới hiện, để không bật lên rồi tắt ngay khi xe nhích chậm.
 * unknownHoldMs: không có tốc độ (trong hầm, mất GPS, vừa mở ứng dụng) thì chưa coi là đứng yên trong chừng này kể từ
 *   lần cuối thấy xe chạy, hoặc kể từ lúc mở (chưa biết gì thì có thể xe đang chạy: màn hình xe bật theo chìa khoá).
 */
export const QUIET = Object.freeze({ movingKmh: 8, stopHoldMs: 5000, unknownHoldMs: 120_000 });

/**
 * Có được hiện lời mời cập nhật lúc này không. Gọi update() đều đặn (mỗi giây) với tình trạng mới nhất:
 *   driving: đang dẫn đường hoặc ở chế độ lái; kmh: tốc độ còn mới (km/h) hoặc null; alert: thanh cảnh báo đang hiện.
 * Xe chạy hoặc đang lái → false ngay. Đứng yên đủ stopHoldMs (và không có cảnh báo) → true. Lời mời bị giữ lại
 * trong lúc chạy chứ không mất: lần dừng sau sẽ hiện.
 * requireSpeed (trong ứng dụng Android, nơi bấm là mở hộp thoại cài và khởi động lại ứng dụng): phải từng thấy một tốc độ
 * thật dưới movingKmh mới tính là đứng yên; chưa từng có tốc độ nào (mới mở, GPS chưa bắt được) thì không bao giờ hiện.
 */
export class QuietGate {
  #now;
  #requireSpeed;
  #stillSince = null;
  #movedAt;
  #seenStill = false;

  constructor({ now = () => Date.now(), requireSpeed = false } = {}) {
    this.#now = now;
    this.#requireSpeed = Boolean(requireSpeed);
    // Lúc mở coi như vừa thấy xe chạy: không biết tốc độ thì phải chờ unknownHoldMs, không hiện ngay.
    this.#movedAt = now();
  }

  update({ driving = false, kmh = null, alert = false } = {}) {
    const now = this.#now();
    let still;
    if (driving) still = false;
    else if (typeof kmh === 'number' && Number.isFinite(kmh)) {
      still = kmh < QUIET.movingKmh;
      if (!still) this.#movedAt = now;
      else this.#seenStill = true;
    } else {
      still = (!this.#requireSpeed || this.#seenStill) && now - this.#movedAt >= QUIET.unknownHoldMs;
    }
    if (!still) {
      this.#stillSince = null;
      return false;
    }
    this.#stillSince ??= now;
    // Cảnh báo đang hiện: chỉ che lời mời, không bắt đếm lại thời gian đứng yên.
    return !alert && now - this.#stillSince >= QUIET.stopHoldMs;
  }
}

/**
 * Hiện lời mời nào. Bản cài Android mới (nativePill) thay luôn cả phần web nên được ưu tiên: khi nó hiện thì ẩn nút
 * "tải lại" của bản web để không chồng hai lời mời.
 */
export function planPrompts({ nativePill = false, swVisible = false, quiet = false } = {}) {
  const native = Boolean(nativePill && quiet);
  return { native, sw: Boolean(swVisible && quiet && !native) };
}

export const SW_UPDATE = Object.freeze({
  checkEveryMs: 60 * 60e3, // hỏi máy chủ có sw.js mới không mỗi giờ (trang trên màn hình xe có khi mở cả ngày)
  snoozeMs: 2 * 60 * 60e3, // "Để sau": ẩn chừng này rồi mới mời lại
});

export const SW_RELOAD_TEXT = 'Đã có bản mới, bấm để tải lại';

/**
 * Bản của mã trang đang chạy: phải bằng VERSION trong sw.js (tests/appupdate.test.mjs kiểm tra). Khi service worker mới
 * nắm trang, trang hỏi nó là bản nào; trùng bản này nghĩa là trang đã chạy mã mới (vỏ ứng dụng ưu tiên mạng, hay vừa cập
 * nhật bản cài Android) nên không mời tải lại.
 */
export const SHELL_VERSION = 'v12';

/** Hạn chờ service worker trả lời "bạn là bản nào?" (ms). Không trả lời thì coi như bản khác. */
export const SW_VERSION_WAIT_MS = 3000;

/**
 * Hỏi service worker (controller) VERSION của nó qua MessageChannel → Promise<string|null> (null: không trả lời kịp,
 * trả lời sai dạng, hay trình duyệt không có MessageChannel).
 */
export function askWorkerVersion(worker, { timeoutMs = SW_VERSION_WAIT_MS, timers = globalThis } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let ch = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer != null) timers.clearTimeout(timer);
      try {
        ch?.port1.close(); // đóng cả khi hết hạn chờ: cổng còn mở thì không được thu dọn
      } catch {
        /* bỏ qua */
      }
      resolve(v);
    };
    try {
      if (!worker || typeof worker.postMessage !== 'function' || typeof MessageChannel !== 'function') return finish(null);
      ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        const d = e?.data;
        const v = d && d.type === 'banduong:version' && typeof d.version === 'string' ? d.version : null;
        finish(v && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null);
      };
      timer = timers.setTimeout(() => finish(null), timeoutMs);
      worker.postMessage({ type: 'banduong:version' }, [ch.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * Bản web mới. sw.js gọi skipWaiting() và clients.claim(), nên khi có bản mới, service worker mới nắm trang ngay
 * ("controllerchange") trong lúc trang vẫn chạy mã cũ. Thay vì để hai bản lẫn nhau, ta mời người dùng tải lại, và chỉ
 * tải lại khi họ bấm lúc xe đứng yên.
 * Lần đầu mở (trang chưa có service worker nào) thì "controllerchange" đầu tiên chỉ là bản đầu tiên nắm trang: bỏ qua.
 * Service worker mới cùng bản với mã trang (pageVersion) cũng bỏ qua: vỏ ứng dụng ưu tiên mạng nên trang mở lúc có mạng
 * đã chạy mã mới, chỉ service worker là tới sau. Không hỏi được bản thì vẫn mời (thà mời thừa còn hơn chạy lẫn hai bản).
 */
export class SwUpdateWatcher {
  #c;
  #now;
  #reload;
  #had = false;
  #pending = false;
  #snoozeUntil = -Infinity;
  #reg = null;
  #lastCheck = -Infinity;
  #checking = false;
  #listener = null;
  #fns = new Set();
  #pageVersion;
  #askVersion;
  #asking = false;

  /**
   * container: navigator.serviceWorker (hoặc bản giả khi kiểm thử); không có thì không làm gì.
   * pageVersion: bản của mã trang (SHELL_VERSION); null thì mọi lần đổi service worker đều mời tải lại.
   * askVersion(worker) → Promise<string|null>: hỏi bản của service worker (askWorkerVersion).
   */
  constructor(
    container,
    { now = () => Date.now(), reload = () => globalThis.location?.reload(), pageVersion = null, askVersion = askWorkerVersion } = {}
  ) {
    this.#c = container || null;
    this.#now = now;
    this.#reload = reload;
    this.#pageVersion = typeof pageVersion === 'string' && pageVersion ? pageVersion : null;
    this.#askVersion = askVersion;
  }

  /** fn() mỗi khi lời mời đổi (có bản mới, bấm "Để sau") → hàm huỷ. */
  onChange(fn) {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  start() {
    if (!this.#c || this.#listener) return;
    try {
      this.#had = Boolean(this.#c.controller);
    } catch {
      this.#had = false;
    }
    this.#listener = () => this.#onControllerChange();
    this.#c.addEventListener?.('controllerchange', this.#listener);
  }

  stop() {
    if (this.#listener) this.#c.removeEventListener?.('controllerchange', this.#listener);
    this.#listener = null;
  }

  /** Bản đăng ký từ navigator.serviceWorker.register(): để thỉnh thoảng hỏi bản mới. register() vừa hỏi rồi. */
  attach(reg) {
    if (!reg || typeof reg.update !== 'function') return;
    this.#reg = reg;
    this.#lastCheck = this.#now();
  }

  get pending() {
    return this.#pending;
  }

  /** Có bản mới và không đang trong thời gian "Để sau". */
  get visible() {
    return this.#pending && this.#now() >= this.#snoozeUntil;
  }

  dismiss() {
    if (!this.#pending) return;
    this.#snoozeUntil = this.#now() + SW_UPDATE.snoozeMs;
    this.#emit();
  }

  /** Người dùng bấm "tải lại". Chỉ tải lại khi có bản mới và xe đứng yên (quiet); trả true nếu đã tải lại. */
  reload({ quiet = false } = {}) {
    if (!this.#pending || !quiet) return false;
    try {
      this.#reload();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gọi đều đặn. Đủ checkEveryMs và được phép (allowCheck: xe đứng yên, trang đang hiện, có mạng) thì nhờ trình duyệt
   * hỏi sw.js mới. Không hỏi khi đang lái để bản mới không thay giữa chuyến. Trả true nếu đã hỏi.
   */
  tick({ allowCheck = false } = {}) {
    if (!this.#reg || this.#pending || this.#checking || !allowCheck) return false;
    const now = this.#now();
    if (now - this.#lastCheck < SW_UPDATE.checkEveryMs) return false;
    this.#lastCheck = now;
    this.#checking = true;
    Promise.resolve()
      .then(() => this.#reg.update())
      .catch(() => {
        /* mất mạng, máy chủ lỗi: lần sau hỏi lại */
      })
      .finally(() => {
        this.#checking = false;
      });
    return true;
  }

  #onControllerChange() {
    if (!this.#had) {
      this.#had = true;
      return;
    }
    if (this.#pending || this.#asking) return;
    if (!this.#pageVersion) return this.#markPending();
    let worker = null;
    try {
      worker = this.#c.controller;
    } catch {
      worker = null;
    }
    this.#asking = true;
    Promise.resolve()
      .then(() => this.#askVersion(worker))
      .catch(() => null)
      .then((v) => {
        this.#asking = false;
        // Cùng bản với mã đang chạy: không có gì để tải lại.
        if (v !== this.#pageVersion) this.#markPending();
      });
  }

  #markPending() {
    if (this.#pending) return;
    this.#pending = true;
    this.#emit();
  }

  #emit() {
    for (const fn of this.#fns) {
      try {
        fn();
      } catch {
        /* giao diện lỗi không làm hỏng bộ theo dõi */
      }
    }
  }
}
