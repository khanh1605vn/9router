// Bộ OBD qua ứng dụng Android Bạn Đường. WebView của Android không có Web Bluetooth hay Web Serial, nên trong ứng dụng
// phần Bluetooth do máy làm (hộp chọn thiết bị, GATT, RFCOMM) và trang chỉ nói chuyện qua window.BanDuongNative
// (cầu nối v1, xem android/…/obd/ObdController.kt). obd.js chọn bộ này khi lớp nối của ứng dụng báo có OBD
// (window.BanDuongApp.obd); ngoài ứng dụng thì không có gì ở đây chạy.
//
// Hợp đồng (mọi thông điệp là chuỗi JSON, v = 1):
//   trang → máy: obdPick { req, kind: 'ble'|'spp', all } · obdConnect { link } · obdWrite { link, data } · obdDisconnect { link }
//   máy → trang: obdPicked { req, ok, link, kind, name | error } · obdState { link, state: 'open'|'closed', reason }
//                obdData { link, data }
// `link` là mã ngẫu nhiên do máy cấp sau khi người dùng tự chọn thiết bị trong hộp chọn của máy; trang không bao giờ
// thấy địa chỉ Bluetooth. Nạp lại trang thì mọi mã cũ mất hiệu lực (phải chọn lại thiết bị).
// Máy kiểm tra lại mọi thứ (danh sách lệnh được phép như elm327.js, độ dài, nhịp gửi); ở đây cũng tự kiểm tra trước.

import { isAllowedCommand } from './elm327.js';

export const NATIVE_EVENT = 'banduong:native';
const V = 1;

export const NATIVE_OBD_LIMITS = Object.freeze({
  maxFrame: 16, // lệnh dài nhất được phép ("ATSPA1\r", "01421\r"…) chỉ vài ký tự
  maxData: 8192, // một thông điệp obdData (máy gửi tối đa 4096)
  maxName: 40,
  pickTimeout: 10 * 60e3, // hộp chọn của máy luôn trả lời; chỉ phòng máy cũ không biết obdPick
  connectTimeout: 30e3, // BLE: nối GATT + dò service (máy tự bỏ sau 20 s); SPP: RFCOMM bảo mật rồi không bảo mật
});

const LINK_RE = /^[0-9a-f]{16}$/;
const KINDS = new Set(['ble', 'spp']);

/**
 * Trang đang chạy trong ứng dụng Android Bạn Đường (có kênh window.BanDuongNative và window.BanDuongApp do ứng dụng gắn),
 * dù máy có Bluetooth hay không. Mọi lỗi khi đọc đều coi như không.
 */
export function inNativeApp(env = globalThis) {
  try {
    const ch = env?.BanDuongNative;
    const app = env?.BanDuongApp;
    return Boolean(ch && typeof ch.postMessage === 'function' && app && typeof app === 'object');
  } catch {
    return false;
  }
}

/**
 * Ứng dụng Android có cổng OBD không: { ble, spp } hoặc null (trình duyệt thường, hoặc máy không có Bluetooth).
 * Chỉ tin đúng `true`; mọi lỗi khi đọc đều coi như không có.
 */
export function nativeObdSupport(env = globalThis) {
  try {
    const ch = env?.BanDuongNative;
    if (!ch || typeof ch.postMessage !== 'function') return null;
    const obd = env?.BanDuongApp?.obd;
    if (!obd || typeof obd !== 'object') return null;
    const ble = obd.ble === true;
    const spp = obd.spp === true;
    return ble || spp ? { ble, spp } : null;
  } catch {
    return null;
  }
}

/**
 * Chuỗi ghi xuống bộ đọc có đúng là frameCommand(lệnh được phép) không: lệnh + CR, riêng 'X' đứng một mình.
 * Ngoài ra chỉ còn một trường hợp (ObdWriteGuard): CR đứng riêng ngay sau 'X', để kết thúc chuỗi ngắt của ObdClient.
 * Máy (ObdCommands.isAllowedFrame, ObdWriteGuard) dùng đúng quy tắc này.
 */
export function isAllowedFrame(text) {
  if (typeof text !== 'string' || !text.length || text.length > NATIVE_OBD_LIMITS.maxFrame) return false;
  if (text === 'X') return true;
  if (!text.endsWith('\r')) return false;
  const cmd = text.slice(0, -1);
  return cmd !== 'X' && isAllowedCommand(cmd);
}

/** Dữ liệu bộ đọc gửi về: chỉ giữ ASCII in được, CR và LF (máy đã lọc, ở đây lọc lại). */
export function cleanData(raw) {
  if (typeof raw !== 'string' || raw.length > NATIVE_OBD_LIMITS.maxData) return '';
  return raw.replace(/[^\r\n\x20-\x7e]/g, '');
}

/** Tên thiết bị (do thiết bị tự quảng bá, không tin được): bỏ ký tự điều khiển và đổi hướng chữ, tối đa 40 ký tự. */
export function cleanName(raw) {
  if (typeof raw !== 'string' || raw.length > 4 * NATIVE_OBD_LIMITS.maxName) return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const cut = Array.from(s).slice(0, NATIVE_OBD_LIMITS.maxName).join('');
  return cut.trimEnd() || null;
}

const namedError = (name, message) => Object.assign(new Error(message), { name });

/** Thiết bị người dùng đã chọn trong hộp chọn của máy. Chỉ mang mã link, loại và tên để hiện. */
export class NativeObdDevice {
  #port;
  constructor(port, link, kind, name) {
    this.#port = port;
    this.link = link;
    this.kind = kind;
    this.name = name;
    Object.freeze(this);
  }

  get port() {
    return this.#port;
  }
}

export const isNativeObdDevice = (x) => x instanceof NativeObdDevice;

/**
 * Cổng OBD của ứng dụng Android.
 * @param channel window.BanDuongNative (có postMessage)
 * @param options { target: nơi phát NATIVE_EVENT (window), timers, makeError(message): lỗi có câu cho người dùng (ObdError) }
 */
export class NativeObd {
  #ch;
  #target;
  #timers;
  #makeError;
  #listener = null;
  #req = 0;
  #picks = new Map(); // req → { resolve, reject, timer }
  #links = new Map(); // link → bộ xử lý của transport đang dùng mã đó

  constructor(channel, { target = globalThis, timers = globalThis, makeError = (m) => new Error(m) } = {}) {
    this.#ch = channel;
    this.#target = target;
    this.#timers = timers;
    this.#makeError = makeError;
  }

  #listen() {
    if (this.#listener) return;
    this.#listener = (e) => this.handleNative(e?.detail);
    this.#target.addEventListener?.(NATIVE_EVENT, this.#listener);
  }

  #send(msg) {
    try {
      this.#ch.postMessage(JSON.stringify({ v: V, ...msg }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mở hộp chọn thiết bị của máy. Gọi ngay trong hàm xử lý bấm: máy chỉ mở hộp chọn ngay sau một lần chạm.
   * @param kind 'ble' (Bluetooth Low Energy) | 'spp' (Bluetooth thường đã ghép đôi)
   * @param all  BLE: hiện mọi thiết bị, không chỉ thiết bị có tên/service của bộ OBD
   * @returns Promise<NativeObdDevice>; huỷ → lỗi NotFoundError (main.js bỏ qua, như trên trình duyệt)
   */
  pick(kind, all = false) {
    if (!KINDS.has(kind)) return Promise.reject(new TypeError('Loại Bluetooth không hợp lệ.'));
    this.#listen();
    const req = (this.#req = (this.#req % 1e9) + 1);
    return new Promise((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        this.#picks.delete(req);
        reject(this.#makeError('Ứng dụng không mở được hộp chọn thiết bị. Hãy thử lại.'));
      }, NATIVE_OBD_LIMITS.pickTimeout);
      this.#picks.set(req, { resolve, reject, timer });
      if (!this.#send({ type: 'obdPick', req, kind, all: all === true })) {
        this.#timers.clearTimeout(timer);
        this.#picks.delete(req);
        reject(this.#makeError('Ứng dụng không mở được hộp chọn thiết bị. Hãy thử lại.'));
      }
    });
  }

  /** Thông điệp từ máy (detail của NATIVE_EVENT). Chỉ nhận đúng dạng hợp đồng; thông điệp khác bị bỏ qua. */
  handleNative(msg) {
    if (!msg || typeof msg !== 'object' || msg.v !== V || typeof msg.type !== 'string') return;
    if (msg.type === 'obdPicked') this.#onPicked(msg);
    else if (msg.type === 'obdState' || msg.type === 'obdData') {
      if (typeof msg.link !== 'string' || !LINK_RE.test(msg.link)) return;
      const h = this.#links.get(msg.link);
      if (!h) return;
      if (msg.type === 'obdData') h.data(cleanData(msg.data));
      else if (msg.state === 'open') h.open();
      else if (msg.state === 'closed') h.closed(typeof msg.reason === 'string' ? msg.reason : 'failed');
    }
  }

  #onPicked(msg) {
    if (!Number.isInteger(msg.req)) return;
    const p = this.#picks.get(msg.req);
    if (!p) return;
    this.#picks.delete(msg.req);
    this.#timers.clearTimeout(p.timer);
    if (msg.ok === true && typeof msg.link === 'string' && LINK_RE.test(msg.link) && KINDS.has(msg.kind)) {
      p.resolve(new NativeObdDevice(this, msg.link, msg.kind, cleanName(msg.name)));
    } else {
      p.reject(this.#pickError(msg.ok === true ? 'bad' : msg.error));
    }
  }

  #pickError(code) {
    switch (code) {
      case 'cancelled':
        // Cùng tên và câu như Chrome khi người dùng đóng hộp chọn: main.js onPickError không báo gì.
        return namedError('NotFoundError', 'User cancelled the requestDevice() chooser.');
      case 'denied':
        return namedError('NotAllowedError', 'Bluetooth permission denied.');
      case 'off':
        return this.#makeError('Bluetooth của điện thoại đang tắt. Hãy bật Bluetooth rồi thử lại.');
      case 'unsupported':
        return this.#makeError('Điện thoại này không hỗ trợ loại Bluetooth này.');
      case 'nopaired':
        return this.#makeError(
          'Chưa có thiết bị nào được ghép đôi. Hãy ghép đôi bộ OBD trong cài đặt Bluetooth của điện thoại trước (mã PIN thường là 1234 hoặc 0000).'
        );
      case 'gesture':
        return this.#makeError('Hãy bấm lại nút kết nối.');
      default:
        return this.#makeError('Chưa mở được hộp chọn thiết bị. Hãy thử lại.');
    }
  }

  #connectError(reason) {
    switch (reason) {
      case 'nochannel':
        return this.#makeError('Không tìm thấy kênh dữ liệu của bộ OBD trên thiết bị này.');
      case 'off':
        return this.#makeError('Bluetooth của điện thoại đang tắt. Hãy bật Bluetooth rồi thử lại.');
      case 'denied':
        return this.#makeError('Ứng dụng chưa được phép dùng Bluetooth. Hãy cho phép quyền “Thiết bị ở gần” rồi thử lại.');
      case 'unknown':
        return this.#makeError('Hãy chọn lại bộ OBD.');
      default:
        // Lỗi đường truyền thường: ObdClient tự báo câu dễ hiểu hoặc tự kết nối lại.
        return namedError('NetworkError', 'Không kết nối được với thiết bị.');
    }
  }

  /**
   * Transport cho ObdClient: { kind, name, connect({ onData, onClose }), write(text), disconnect() }, giống
   * createBleTransport / createSerialTransport trong obd.js. Kết nối lại (ObdClient tự làm) dùng lại mã link,
   * không mở lại hộp chọn.
   */
  transport(device) {
    if (!isNativeObdDevice(device) || device.port !== this) throw new TypeError('Thiết bị không hợp lệ.');
    this.#listen();
    const port = this;
    const { link } = device;
    let state = 'closed'; // closed | connecting | open
    let handlers = null;
    let pending = null; // { resolve, reject, timer } khi đang chờ máy mở kết nối
    let closing = false;
    let afterX = false; // lần ghi trước là 'X': cho phép đúng một CR đứng riêng

    const settle = (err) => {
      const p = pending;
      pending = null;
      if (!p) return;
      port.#timers.clearTimeout(p.timer);
      if (err) p.reject(err);
      else p.resolve();
    };
    const self = {
      open() {
        if (state !== 'connecting') return;
        state = 'open';
        settle(null);
      },
      closed(reason) {
        if (state === 'connecting') {
          state = 'closed';
          settle(port.#connectError(reason));
        } else if (state === 'open') {
          state = 'closed';
          if (!closing) handlers?.onClose(reason === 'lost' ? 'disconnected' : reason);
        }
      },
      data(text) {
        if (state === 'open' && text && handlers) handlers.onData(text);
      },
    };

    return {
      kind: device.kind === 'spp' ? 'serial' : 'ble',
      get name() {
        return device.name || (device.kind === 'spp' ? 'bộ OBD Bluetooth thường' : 'bộ OBD Bluetooth');
      },
      connect(h) {
        handlers = h;
        closing = false;
        settle(namedError('AbortError', 'Đã kết nối lại.'));
        port.#links.set(link, self);
        state = 'connecting';
        afterX = false;
        return new Promise((resolve, reject) => {
          const timer = port.#timers.setTimeout(() => {
            if (pending?.timer !== timer) return;
            state = 'closed';
            port.#send({ type: 'obdDisconnect', link });
            settle(namedError('NetworkError', 'Hết thời gian chờ kết nối.'));
          }, NATIVE_OBD_LIMITS.connectTimeout);
          pending = { resolve, reject, timer };
          if (!port.#send({ type: 'obdConnect', link })) {
            state = 'closed';
            settle(namedError('NetworkError', 'Không gửi được yêu cầu kết nối.'));
          }
        });
      },
      write(text) {
        if (state !== 'open') return Promise.reject(new Error('Chưa kết nối.'));
        const ok = isAllowedFrame(text) || (text === '\r' && afterX);
        afterX = text === 'X';
        if (!ok) return Promise.reject(new Error('Lệnh không nằm trong danh sách được phép gửi tới xe.'));
        if (!port.#send({ type: 'obdWrite', link, data: text })) return Promise.reject(new Error('Không gửi được lệnh.'));
        return Promise.resolve();
      },
      async disconnect() {
        closing = true;
        if (state !== 'closed') port.#send({ type: 'obdDisconnect', link });
        state = 'closed';
        settle(namedError('AbortError', 'Đã ngắt kết nối.'));
        if (port.#links.get(link) === self) port.#links.delete(link);
      },
    };
  }
}

/** NativeObd khi trang chạy trong ứng dụng Android có OBD, không thì null. */
export function createNativeObd(env = globalThis, options = {}) {
  if (!nativeObdSupport(env)) return null;
  return new NativeObd(env.BanDuongNative, { target: env, timers: env, ...options });
}
