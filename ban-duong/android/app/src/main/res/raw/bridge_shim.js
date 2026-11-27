// Bạn Đường – lớp nối trang web với ứng dụng Android (chạy trước mọi mã của trang, chỉ trên
// https://appassets.androidplatform.net). Xem BRIDGE.md.
//  - window.BanDuongNative do WebView tạo (addWebMessageListener); chỉ có postMessage(chuỗi JSON).
//  - Thông điệp từ máy được phát lại thành sự kiện 'banduong:native' trên window, detail là đối tượng đã kiểm tra.
//  - navigator.wakeLock: WebView không có Screen Wake Lock, nên thay bằng bản gửi { type: 'keepScreenOn' } cho máy.
//  - Nếu máy không chặn được yêu cầu của service worker, chặn đăng ký service worker (trang vẫn chạy bình thường).
//  - window.BanDuongApp (chỉ đọc): khả năng của ứng dụng mà trang cần biết ngay lúc nạp, trước thông điệp "native".
//    obd: { ble, spp } (Bluetooth của máy cho bộ OBD, xem js/obdnative.js) hoặc null.
//    update: { mode: 'install'|'notify', current } (tự cập nhật, xem js/appupdate.js) hoặc null (bản debug).
(() => {
  'use strict';
  const SW_OK = __SW_OK__;
  const OBD = __OBD_CAPS__;
  const UPDATE = __UPDATE_CAPS__;
  const nb = window.BanDuongNative;
  if (!nb || typeof nb.postMessage !== 'function' || window.__banDuongShim) return;
  Object.defineProperty(window, '__banDuongShim', { value: true });

  const send = (o) => {
    try {
      nb.postMessage(JSON.stringify(o));
    } catch {
      /* cầu nối không nhận: bỏ qua */
    }
  };

  const onNative = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.v !== 1 || typeof msg.type !== 'string') return;
    window.dispatchEvent(new CustomEvent('banduong:native', { detail: msg }));
  };
  if (typeof nb.addEventListener === 'function') nb.addEventListener('message', onNative);
  else nb.onmessage = onNative;

  // ---- Khả năng của ứng dụng ----
  try {
    const obd = OBD && (OBD.ble === true || OBD.spp === true) ? Object.freeze({ ble: OBD.ble === true, spp: OBD.spp === true }) : null;
    const update =
      UPDATE && (UPDATE.mode === 'install' || UPDATE.mode === 'notify') && typeof UPDATE.current === 'string'
        ? Object.freeze({ mode: UPDATE.mode, current: UPDATE.current.slice(0, 40) })
        : null;
    Object.defineProperty(window, 'BanDuongApp', { value: Object.freeze({ v: 1, obd, update }) });
  } catch {
    /* đã có: bỏ qua */
  }

  // ---- Giữ màn hình sáng ----
  const active = new Set();
  let sentOn = null;
  const sync = () => {
    const on = active.size > 0;
    if (on === sentOn) return;
    sentOn = on;
    send({ v: 1, type: 'keepScreenOn', on });
  };

  class WakeLockSentinelShim extends EventTarget {
    #released = false;
    onrelease = null;
    get type() {
      return 'screen';
    }
    get released() {
      return this.#released;
    }
    async release() {
      if (this.#released) return;
      this.#released = true;
      active.delete(this);
      sync();
      const ev = new Event('release');
      this.dispatchEvent(ev);
      if (typeof this.onrelease === 'function') this.onrelease(ev);
    }
  }

  const wakeLock = Object.freeze({
    async request(type = 'screen') {
      if (type !== 'screen') throw new TypeError('Chỉ hỗ trợ wakeLock kiểu "screen"');
      if (document.visibilityState !== 'visible') throw new DOMException('Trang đang ẩn', 'NotAllowedError');
      const s = new WakeLockSentinelShim();
      active.add(s);
      sync();
      return s;
    },
  });
  try {
    Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, enumerable: true, get: () => wakeLock });
  } catch {
    /* không thay được: trang tự bỏ qua khi không có wakeLock */
  }
  // Giống trình duyệt: trang ẩn thì khoá tự nhả; trang hiện lại sẽ tự xin lại (main.js updateWakeLock).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') for (const s of [...active]) s.release();
  });

  // ---- Service worker ----
  if (!SW_OK && navigator.serviceWorker) {
    try {
      const reject = () => Promise.reject(new DOMException('Service worker tắt trong ứng dụng', 'NotSupportedError'));
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: reject });
    } catch {
      /* bỏ qua */
    }
  }

  send({ v: 1, type: 'hello' });
})();
