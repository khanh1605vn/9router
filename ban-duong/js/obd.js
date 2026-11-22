// Kết nối với ô tô qua bộ đọc OBD-II (chip ELM327 hoặc tương thích):
// - Bluetooth Low Energy qua Web Bluetooth (Chrome/Edge/Samsung Internet trên Android, Chrome máy tính);
// - Bluetooth thường (SPP) qua Web Serial, sau khi đã ghép đôi bộ đọc trong cài đặt Bluetooth của máy.
// ObdClient nói chuyện với bộ đọc qua một "transport" thay được, nên kiểm thử dùng bộ ELM327 giả.
// Riêng tư: dữ liệu của xe chỉ dùng trên máy, không gửi đi đâu; không đọc số VIN.
// Chỉ chạm vào navigator/document bên trong hàm, để module vẫn nạp được trong Node khi kiểm thử.

import {
  INIT_COMMANDS,
  ResponseAssembler,
  classify,
  decodeDtcs,
  decodePid,
  frameCommand,
  identifyAdapter,
  needsReset,
  parseSupported,
  parseVoltage,
  pidBytes,
  pidBytesAll,
  pidCommand,
} from './elm327.js';

// ---------------------------------------------------------------------------------------------
// Hỗ trợ của trình duyệt

/**
 * Trình duyệt này dùng được Bluetooth (BLE) / Web Serial hay không, và lý do nếu không.
 * @param env đối tượng toàn cục (mặc định globalThis), truyền vào để kiểm thử
 * @returns { ble, serial, secure, reason: 'insecure' | 'ios' | 'webview' | 'firefox' | null }
 */
export function detectSupport(env = globalThis) {
  const nav = env?.navigator;
  const loc = env?.location;
  const ua = String(nav?.userAgent || '');
  const host = loc?.hostname || '';
  const secure =
    typeof env?.isSecureContext === 'boolean'
      ? env.isSecureContext
      : loc?.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
  const webview = /; wv\)|FBAN|FBAV|FB_IAB|Zalo|Instagram|\bLine\//i.test(ua);
  const firefox = /Firefox\/|FxiOS/.test(ua);
  const ble = Boolean(secure && nav && 'bluetooth' in nav && nav.bluetooth);
  // Firefox máy tính có Web Serial nhưng không có cổng Bluetooth (RFCOMM), nên vô ích với bộ OBD.
  const serial = Boolean(secure && nav && 'serial' in nav && nav.serial && !firefox);
  let reason = null;
  if (!ble) {
    if (!secure) reason = 'insecure';
    else if (ios) reason = 'ios';
    else if (webview) reason = 'webview';
    else if (firefox) reason = 'firefox';
  }
  return { ble, serial, secure, reason };
}

// ---------------------------------------------------------------------------------------------
// Bluetooth Low Energy

const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const canonicalUuid = (u) => (typeof u === 'number' ? uuid16(u) : String(u).toLowerCase());

/** Service quảng bá thường gặp ở bộ OBD BLE (dùng làm bộ lọc trong hộp chọn thiết bị). */
const FILTER_SERVICES = [0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];

/** Tiền tố tên thiết bị; so khớp phân biệt chữ hoa nên liệt kê đủ các biến thể. */
export const BLE_NAME_PREFIXES = [
  'OBD', 'OBDII', 'OBD2', 'ELM', 'ELM327', 'V-LINK', 'Vlink', 'Android-Vlink', 'IOS-Vlink', 'vLinker',
  'VEEPEAK', 'Veepeak', 'OBDLink', 'Viecar', 'LELink', 'Carista', 'FIXD', 'KONNWEI', 'Vgate',
];

/**
 * Mọi service được phép mở. Web Bluetooth chỉ cho truy cập service có trong bộ lọc hoặc
 * optionalServices, nên việc dò đặc tính theo thuộc tính cũng chỉ diễn ra trong danh sách này.
 */
export const BLE_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', 0xbeef,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip
  0xfefb, 0xe010,
  'e47c8027-cca1-4e3b-981f-bdc47abeb5b5',
  '0783b03e-8535-b5a0-7140-a304d2495cb7',
  '786ef0cc-2a93-332c-0356-0cc60629af99',
  0x1000,
];

// Cặp đặc tính đã biết: nhận (notify) / gửi (write), theo thứ tự ưu tiên.
const VLINKER_CHAR = 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f';
const KNOWN_PAIRS = new Map([
  [uuid16(0xfff0), { notify: [0xfff1], write: [0xfff2] }],
  [uuid16(0xffe0), { notify: [0xffe1], write: [0xffe2, 0xffe1] }], // FFE2 nếu có và ghi được, không thì FFE1
  [uuid16(0x18f0), { notify: [0x2af0], write: [0x2af1] }],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', { notify: [VLINKER_CHAR], write: [VLINKER_CHAR] }],
  [
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    { notify: ['6e400003-b5a3-f393-e0a9-e50e24dcca9e'], write: ['6e400002-b5a3-f393-e0a9-e50e24dcca9e'] },
  ],
]);

const canNotify = (p) => Boolean(p && (p.notify || p.indicate));
const canWrite = (p) => Boolean(p && (p.write || p.writeWithoutResponse));

/**
 * Mở hộp chọn thiết bị Bluetooth. PHẢI gọi đồng bộ ngay trong hàm xử lý chạm/bấm (không await gì
 * trước đó), nếu không trình duyệt sẽ chặn vì thiếu thao tác của người dùng.
 * @param all true: hiện mọi thiết bị (cho bộ đọc không quảng bá tên/service quen thuộc)
 * @returns Promise<BluetoothDevice>
 */
export function requestBleDevice(all = false, nav = globalThis.navigator) {
  const bt = nav?.bluetooth;
  if (!bt?.requestDevice) return Promise.reject(new Error('Trình duyệt này không hỗ trợ Bluetooth trên web.'));
  const optionalServices = [...BLE_SERVICES];
  const options = all
    ? { acceptAllDevices: true, optionalServices }
    : {
        filters: [
          ...FILTER_SERVICES.map((s) => ({ services: [s] })),
          ...BLE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        ],
        optionalServices,
      };
  return bt.requestDevice(options);
}

function pickKnown(chars, known) {
  const find = (ids, ok) => {
    for (const id of ids) {
      const c = chars.find((ch) => canonicalUuid(ch.uuid) === canonicalUuid(id));
      if (c && ok(c.properties)) return c;
    }
    return null;
  };
  const rx = find(known.notify, canNotify);
  const tx = find(known.write, canWrite);
  return rx && tx ? { rx, tx } : null;
}

function pickByProperties(chars) {
  const rx = chars.find((c) => canNotify(c.properties));
  const tx = chars.find((c) => canWrite(c.properties));
  return rx && tx ? { rx, tx } : null;
}

/**
 * Chọn đặc tính nhận/gửi trên GATT server: ưu tiên các cặp đã biết, sau đó lấy đặc tính đầu tiên có
 * notify/indicate và đặc tính đầu tiên ghi được, chỉ trong các service được phép (BLE_SERVICES).
 * @returns { rx, tx, service, how: 'known' | 'properties' }
 */
export async function chooseCharacteristics(server) {
  const found = [];
  for (const s of BLE_SERVICES) {
    const id = canonicalUuid(s);
    let chars;
    try {
      const service = await server.getPrimaryService(id);
      chars = await service.getCharacteristics();
    } catch {
      continue; // thiết bị không có service này
    }
    if (!chars?.length) continue;
    found.push({ id, chars });
    const known = KNOWN_PAIRS.get(id);
    const pair = known && pickKnown(chars, known);
    if (pair) return { ...pair, service: id, how: 'known' };
  }
  for (const { id, chars } of found) {
    const pair = pickByProperties(chars);
    if (pair) return { ...pair, service: id, how: 'properties' };
  }
  throw new ObdError('Không tìm thấy kênh dữ liệu của bộ OBD trên thiết bị này.');
}

const encodeAscii = (text) => Uint8Array.from(String(text), (ch) => ch.charCodeAt(0) & 0x7f);
const BLE_CHUNK = 20; // ATT MTU mặc định 23 byte → tối đa 20 byte dữ liệu mỗi lần ghi

async function writeBle(ch, text) {
  const bytes = encodeAscii(text);
  for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
    const chunk = bytes.slice(i, i + BLE_CHUNK);
    if (ch.properties?.write && ch.writeValueWithResponse) await ch.writeValueWithResponse(chunk);
    else if (ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(chunk);
    else await ch.writeValue(chunk);
  }
}

/**
 * Transport BLE cho ObdClient. Kết nối lại bằng device.gatt.connect(), không cần mở lại hộp chọn
 * trong cùng phiên trang. Không bao giờ ghi descriptor: bật nhận dữ liệu bằng startNotifications().
 */
export function createBleTransport(device) {
  let handlers = null;
  let rx = null;
  let tx = null;
  let closing = false;
  let decoder = null;
  let chain = Promise.resolve();
  const onValue = (ev) => {
    const v = ev?.target?.value;
    if (v && handlers) handlers.onData(decoder.decode(v, { stream: true }));
  };
  const onDisconnected = () => {
    if (!closing) handlers?.onClose('disconnected');
  };

  return {
    kind: 'ble',
    get name() {
      return device?.name || 'Bộ OBD Bluetooth';
    },
    async connect(h) {
      handlers = h;
      closing = false;
      decoder = new TextDecoder();
      device.removeEventListener?.('gattserverdisconnected', onDisconnected);
      device.addEventListener?.('gattserverdisconnected', onDisconnected);
      const server = await device.gatt.connect();
      const pair = await chooseCharacteristics(server);
      if (rx) rx.removeEventListener?.('characteristicvaluechanged', onValue);
      rx = pair.rx;
      tx = pair.tx;
      rx.addEventListener('characteristicvaluechanged', onValue);
      await rx.startNotifications();
    },
    write(text) {
      // Ghi tuần tự: lần ghi sau chỉ bắt đầu khi lần trước xong.
      const job = chain.then(() => {
        if (!tx) throw new Error('Chưa kết nối.');
        return writeBle(tx, text);
      });
      chain = job.catch(() => {});
      return job;
    },
    async disconnect() {
      closing = true;
      try {
        await rx?.stopNotifications?.();
      } catch {
        /* đã mất kết nối */
      }
      rx?.removeEventListener?.('characteristicvaluechanged', onValue);
      device.removeEventListener?.('gattserverdisconnected', onDisconnected);
      try {
        if (device.gatt?.connected) device.gatt.disconnect();
      } catch {
        /* bỏ qua */
      }
      rx = tx = null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bluetooth thường (SPP) qua Web Serial

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/** Mở hộp chọn cổng (bộ đọc Bluetooth thường đã ghép đôi). Gọi đồng bộ trong hàm xử lý bấm. */
export function requestSerialPort(nav = globalThis.navigator) {
  const serial = nav?.serial;
  if (!serial?.requestPort) return Promise.reject(new Error('Trình duyệt này không hỗ trợ cổng nối tiếp (Web Serial).'));
  return serial.requestPort({ filters: [{ bluetoothServiceClassId: SPP_UUID }] });
}

/**
 * Lấy lại cổng đã được cấp quyền trước đó (không cần chạm), để tự kết nối khi mở ứng dụng.
 * @returns Promise<transport | null>
 */
export async function reopenSerial(nav = globalThis.navigator) {
  const serial = nav?.serial;
  if (!serial?.getPorts) return null;
  let ports = [];
  try {
    ports = (await serial.getPorts()) || [];
  } catch {
    return null;
  }
  const spp = ports.find((p) => {
    try {
      return String(p.getInfo?.().bluetoothServiceClassId || '').toLowerCase() === SPP_UUID;
    } catch {
      return false;
    }
  });
  const port = spp || ports[0];
  return port ? createSerialTransport(port) : null;
}

/** Transport Web Serial. Mất kết nối được nhận ra qua lỗi của vòng đọc, không dựa vào sự kiện. */
export function createSerialTransport(port) {
  let handlers = null;
  let reader = null;
  let writer = null;
  let closing = false;
  let chain = Promise.resolve();

  async function readLoop(r, decoder) {
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        if (value?.length && handlers) handlers.onData(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* cổng bị ngắt: báo ở dưới */
    } finally {
      try {
        r.releaseLock();
      } catch {
        /* bỏ qua */
      }
    }
    if (!closing && reader === r) handlers?.onClose('serial');
  }

  return {
    kind: 'serial',
    name: 'Bộ OBD Bluetooth thường',
    async connect(h) {
      handlers = h;
      closing = false;
      if (!port.readable || !port.writable) await port.open({ baudRate: 38400 });
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      readLoop(reader, new TextDecoder());
    },
    write(text) {
      const job = chain.then(() => {
        if (!writer) throw new Error('Chưa kết nối.');
        return writer.write(encodeAscii(text));
      });
      chain = job.catch(() => {});
      return job;
    },
    async disconnect() {
      closing = true;
      const r = reader;
      reader = null;
      try {
        await r?.cancel();
      } catch {
        /* bỏ qua */
      }
      try {
        r?.releaseLock(); // port.close() cần luồng đã được nhả
      } catch {
        /* bỏ qua */
      }
      try {
        writer?.releaseLock();
      } catch {
        /* bỏ qua */
      }
      writer = null;
      try {
        await port.close();
      } catch {
        /* cổng đã đóng */
      }
    },
  };
}

/** Câu báo lỗi tiếng Việt cho lỗi khi chọn/kết nối thiết bị (DOMException của trình duyệt). */
export function describeConnectError(err) {
  if (err instanceof ObdError) return err.message;
  switch (err?.name) {
    case 'NotFoundError':
      return 'Chưa chọn được thiết bị. Nếu không thấy bộ OBD trong danh sách, hãy bật Bluetooth rồi thử “Hiện mọi thiết bị”.';
    case 'SecurityError':
      return 'Trình duyệt không cho phép dùng Bluetooth ở trang này.';
    case 'NotAllowedError':
      return 'Bạn chưa cho phép dùng Bluetooth.';
    case 'NetworkError':
      return 'Không kết nối được với thiết bị. Hãy để bộ OBD gần máy rồi thử lại.';
    default:
      return 'Không kết nối được với bộ OBD.';
  }
}

// ---------------------------------------------------------------------------------------------
// Bộ điều khiển phiên OBD

/** Lỗi có câu báo dành cho người dùng. */
export class ObdError extends Error {}
class LinkLost extends Error {}
class Stopped extends Error {}
class NotElm extends ObdError {}
class Reinit extends Error {
  constructor(forget) {
    super('reinit');
    this.forget = forget;
  }
}
class CarGone extends Error {
  constructor(reason) {
    super('car');
    this.reason = reason;
  }
}

export const TIMING = {
  settle: 400, // chờ sau khi mở kết nối (biện pháp an toàn, chưa được kiểm chứng là cần)
  at: 2000,
  atz: 4000,
  atzMin: 1000, // sau ATZ chờ ít nhất 1 s rồi mới gửi lệnh tiếp
  search: 20000, // 0100 đầu tiên sau ATSP0: bộ đọc đang dò giao thức
  pid: 1500,
  dtc: 4000,
  abort: 500,
  abortCr: 1000,
  nocarRetry: 8000,
  cooldown: 2000,
  minGap: Math.ceil(1000 / 6), // tối đa 6 yêu cầu mỗi giây
};

/** Chờ trước mỗi lần kết nối lại; hết danh sách thì bỏ cuộc. */
export const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];

const POLL_PLAN = [
  { key: 'speed', pid: 0x0d, every: 300 },
  { key: 'rpm', pid: 0x0c, every: 1000 },
  { key: 'coolant', pid: 0x05, every: 15000 },
  { key: 'fuel', pid: 0x2f, every: 60000 },
  { key: 'voltage', cmd: 'ATRV', every: 20000 }, // PID 0142 khi bộ đọc trả '?' cho ATRV
];
const MAX_NODATA = 3;
const MAX_RESETS = 5;

const MSG = {
  notElm: 'Thiết bị này không phải bộ đọc OBD (ELM327).',
  noAnswer: 'Bộ OBD không trả lời. Hãy rút bộ OBD ra, cắm lại rồi thử lại.',
  firstConnect: 'Không kết nối được với bộ OBD. Hãy kiểm tra bộ OBD đã cắm vào xe rồi thử lại.',
  gaveUp: 'Mất kết nối với bộ OBD. Hãy bấm kết nối lại.',
};

const noop = () => {};

function emptySnapshot() {
  return { speed: null, rpm: null, coolant: null, fuel: null, voltage: null, time: null, speedTime: null, adapter: null };
}

/**
 * Một phiên làm việc với bộ đọc ELM327: khởi tạo, dò xe, đọc dữ liệu định kỳ, tự kết nối lại.
 * Mỗi lúc chỉ có một lệnh đang chờ; lệnh kế tiếp chỉ gửi sau khi nhận dấu nhắc '>'.
 *
 * Trạng thái: idle | connecting | init | searching | ready | nocar | lost | error.
 * Dữ liệu: { speed (km/h), rpm, coolant (°C), fuel (%), voltage (V), time, speedTime, adapter }.
 *
 * @param transport { kind, name, connect({ onData, onClose }), write(text), disconnect() }
 * @param options   { timers: { setTimeout, clearTimeout }, now: () => ms, onState, onData }
 */
export class ObdClient {
  #t;
  #timers;
  #now;
  #asm = new ResponseAssembler();
  #state = 'idle';
  #stateFns = new Set();
  #dataFns = new Set();
  #running = false;
  #gen = 0;
  #fault = null;
  #waiter = null;
  #waits = new Set();
  #pauseWaiters = new Set();
  #paused = false;
  #lock = Promise.resolve();
  #supported = new Set();
  #atrv = true;
  #reinitPending = false;
  #validated = false;
  #lastSend = -Infinity;
  #silent = 0;
  #snap = emptySnapshot();

  constructor(transport, { timers, now, onState, onData } = {}) {
    this.#t = transport;
    this.#timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    this.#now = now || (() => Date.now());
    if (onState) this.#stateFns.add(onState);
    if (onData) this.#dataFns.add(onData);
  }

  /** Nghe đổi trạng thái: fn(state, info). Trả về hàm huỷ. */
  onState(fn) {
    this.#stateFns.add(fn);
    return () => this.#stateFns.delete(fn);
  }

  /** Nghe dữ liệu mới: fn(snapshot). Trả về hàm huỷ. */
  onData(fn) {
    this.#dataFns.add(fn);
    return () => this.#dataFns.delete(fn);
  }

  get state() {
    return this.#state;
  }

  get kind() {
    return this.#t?.kind || null;
  }

  get name() {
    return this.#t?.name || null;
  }

  get snapshot() {
    return { ...this.#snap };
  }

  get supported() {
    return new Set(this.#supported);
  }

  get paused() {
    return this.#paused;
  }

  get running() {
    return this.#running;
  }

  /** Bắt đầu phiên (không chờ). Theo dõi tiến trình qua onState. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#validated = false;
    const gen = ++this.#gen;
    this.#session(gen).catch(noop);
  }

  /** Ngắt kết nối và dừng mọi việc. */
  async stop() {
    const was = this.#running;
    this.#running = false;
    this.#gen++;
    this.#failAll(new Stopped());
    await this.#safeDisconnect();
    if (was || this.#state !== 'idle') this.#setState('idle');
  }

  /** Tạm dừng đọc dữ liệu (ví dụ khi trang bị ẩn). */
  setPaused(paused) {
    this.#paused = Boolean(paused);
    if (!this.#paused) {
      for (const w of this.#pauseWaiters) w.resolve();
      this.#pauseWaiters.clear();
    }
  }

  /** Đọc mã lỗi động cơ đã lưu (Mode 03), chỉ khi người dùng yêu cầu. Ứng dụng không bao giờ xoá mã lỗi. */
  async readDtcs() {
    if (this.#state !== 'ready') throw new ObdError('Chưa kết nối được với xe.');
    const r = await this.#command('03', TIMING.dtc);
    if (needsReset(r.lines) || r.kind === 'lvreset') {
      this.#reinitPending = true;
      throw new ObdError('Bộ OBD vừa khởi động lại, hãy thử lại sau ít giây.');
    }
    if (r.kind === 'nodata') return [];
    if (r.kind !== 'data') throw new ObdError('Không đọc được mã lỗi từ xe.');
    return decodeDtcs(r.lines);
  }

  // ---- vòng đời kết nối ----

  #alive(gen) {
    return this.#running && this.#gen === gen;
  }

  async #session(gen) {
    let tries = 0;
    while (this.#alive(gen)) {
      try {
        this.#fault = null;
        this.#asm.reset();
        this.#setState('connecting', tries ? { attempt: tries } : null);
        await this.#t.connect({
          onData: (text) => {
            if (gen === this.#gen) this.#onIncoming(text);
          },
          onClose: () => {
            if (gen === this.#gen) this.#failAll(new LinkLost());
          },
        });
        if (!this.#alive(gen)) return;
        await this.#runLink(() => {
          this.#validated = true;
          tries = 0;
        });
      } catch (err) {
        if (!this.#alive(gen)) return;
        if (err instanceof NotElm) return this.#giveUp(gen, MSG.notElm);
        if (!this.#validated) {
          return this.#giveUp(gen, err instanceof ObdError ? err.message : err instanceof LinkLost ? MSG.noAnswer : MSG.firstConnect);
        }
        await this.#safeDisconnect();
        if (!this.#alive(gen)) return;
        if (tries >= RECONNECT_DELAYS.length) return this.#giveUp(gen, MSG.gaveUp);
        const delay = RECONNECT_DELAYS[tries++];
        this.#fault = null;
        this.#setState('lost', { attempt: tries, delay });
        try {
          await this.#wait(delay, true);
        } catch {
          return; // đã dừng
        }
      }
    }
  }

  async #giveUp(gen, message) {
    this.#running = false;
    this.#gen++;
    this.#failAll(new Stopped());
    await this.#safeDisconnect();
    if (gen + 1 === this.#gen) this.#setState('error', { message });
  }

  async #safeDisconnect() {
    try {
      await this.#t.disconnect?.();
    } catch {
      /* bỏ qua */
    }
  }

  async #runLink(onValidated) {
    let step = 'init';
    let forget = false;
    let resets = 0;
    let carReason = null;
    await this.#wait(TIMING.settle);
    for (;;) {
      try {
        if (step === 'init') {
          await this.#init(forget);
          onValidated();
          forget = false;
          step = 'car';
        }
        if (step === 'car') {
          const reason = carReason;
          carReason = null;
          await this.#findCar(reason);
          step = 'poll';
        }
        await this.#poll(() => {
          resets = 0;
        });
      } catch (err) {
        if (err instanceof Reinit) {
          if (++resets > MAX_RESETS) throw new LinkLost();
          step = 'init';
          forget = err.forget;
          carReason = null;
          continue;
        }
        if (err instanceof CarGone) {
          step = 'car';
          carReason = err.reason;
          continue;
        }
        throw err;
      }
    }
  }

  /** ATZ, nhận dạng bộ đọc, rồi các lệnh cấu hình (câu trả lời khác 'OK' vẫn chấp nhận). */
  async #init(forget) {
    this.#setState('init');
    this.#reinitPending = false;
    this.#supported = new Set();
    if (forget) await this.#command('ATFE', TIMING.at);
    const t0 = this.#now();
    const z = await this.#command('ATZ', TIMING.atz);
    const rest = TIMING.atzMin - (this.#now() - t0);
    if (rest > 0) await this.#wait(rest);
    let id = identifyAdapter(z.lines);
    if (!id) id = identifyAdapter((await this.#command('ATI', TIMING.at)).lines);
    if (!id) throw this.#validated ? new LinkLost() : new NotElm(MSG.notElm);
    this.#snap.adapter = id;
    this.#reinitPending = false; // ATZ vừa khởi động lại chip
    for (const cmd of INIT_COMMANDS.slice(1)) this.#checkReset(await this.#command(cmd, TIMING.at));
  }

  /** Gửi 0100 cho tới khi xe trả lời (bật khoá điện), đọc bảng PID hỗ trợ và điện áp. */
  async #findCar(reason) {
    let first = true;
    let resendProtocol = false;
    if (reason) this.#setState('nocar', { reason });
    for (;;) {
      if (!first || reason) {
        await this.#wait(TIMING.nocarRetry);
        await this.#whilePaused();
      }
      if (resendProtocol) {
        this.#checkReset(await this.#command('ATSP0', TIMING.at));
        resendProtocol = false;
      }
      if (first && !reason) this.#setState('searching');
      first = false;
      reason = null;
      const r = await this.#command('0100', TIMING.search);
      this.#checkReset(r);
      const masks = r.kind === 'data' ? pidBytesAll(r.lines, 0x00) : [];
      if (masks.length) {
        for (const m of masks) for (const p of parseSupported(m, 0x00)) this.#supported.add(p);
        break;
      }
      if (r.kind === 'error') resendProtocol = true;
      if (this.#state !== 'nocar') this.#setState('nocar', { reason: r.kind });
    }
    for (const base of [0x20, 0x40]) {
      if (!this.#supported.has(base)) break;
      const r = await this.#command(pidCommand(base), TIMING.pid);
      this.#checkReset(r);
      for (const m of pidBytesAll(r.lines, base)) for (const p of parseSupported(m, base)) this.#supported.add(p);
    }
    const v = await this.#command('ATRV', TIMING.at);
    this.#checkReset(v);
    this.#atrv = v.kind !== 'unknown';
    const volts = parseVoltage(v.lines);
    if (volts != null) this.#store('voltage', volts, false);
  }

  #checkReset(r) {
    if (r.kind === 'lvreset' || needsReset(r.lines) || this.#reinitPending) throw new Reinit(true);
    if (r.kind === 'alert') throw new Reinit(false); // bộ đọc sắp vào chế độ tiết kiệm điện
  }

  #buildPlan() {
    const t = this.#now();
    const plan = [];
    for (const p of POLL_PLAN) {
      const base = { ...p, next: t, miss: 0, ok: false, dropped: false };
      if (p.pid != null) {
        if (this.#supported.has(p.pid)) plan.push(base);
      } else if (this.#atrv) {
        plan.push({ ...base, next: t + p.every }); // vừa đọc ATRV lúc khởi tạo
      } else if (this.#supported.has(0x42)) {
        plan.push({ ...base, cmd: null, pid: 0x42 });
      }
    }
    return plan;
  }

  async #poll(onGood) {
    const plan = this.#buildPlan();
    this.#silent = 0;
    this.#setState('ready', { adapter: this.#snap.adapter, supported: [...this.#supported].sort((a, b) => a - b) });
    this.#emitData();
    for (;;) {
      if (this.#reinitPending) throw new Reinit(true);
      await this.#whilePaused();
      const active = plan.filter((i) => !i.dropped);
      if (!active.length) {
        await this.#wait(1000);
        continue;
      }
      const item = active.reduce((a, b) => (b.next < a.next ? b : a));
      const t = this.#now();
      const due = Math.max(item.next, this.#lastSend + TIMING.minGap);
      if (due > t) {
        await this.#wait(due - t);
        continue;
      }
      this.#lastSend = t;
      item.next = t + item.every;
      const r = await this.#command(item.cmd || pidCommand(item.pid), item.cmd ? TIMING.at : TIMING.pid);
      this.#checkReset(r);
      if (r.kind === 'unable') throw new CarGone('unable');
      if (this.#handleItem(item, r)) onGood();
    }
  }

  /** Xử lý câu trả lời của một mục đọc định kỳ. @returns true khi có dữ liệu mới */
  #handleItem(item, r) {
    if (item.cmd === 'ATRV') {
      if (r.kind === 'unknown') {
        // Bộ đọc không có ATRV: dùng PID 0142 (điện áp mô-đun điều khiển) nếu xe hỗ trợ.
        this.#atrv = false;
        if (this.#supported.has(0x42)) Object.assign(item, { cmd: null, pid: 0x42, next: this.#now() });
        else item.dropped = true;
        return false;
      }
      const v = parseVoltage(r.lines);
      if (v == null) return false;
      this.#store('voltage', v);
      return true;
    }
    if (r.kind === 'nodata') {
      item.miss++;
      // PID chưa từng trả lời mà báo NO DATA 3 lần liên tiếp thì bỏ hẳn. Còn PID đã từng chạy mà
      // cùng im lặng 3 lần liên tiếp (thường là vừa tắt máy) thì quay lại dò xe, không bỏ PID nào.
      if (!item.ok && item.miss >= MAX_NODATA) item.dropped = true;
      if (item.ok && ++this.#silent >= MAX_NODATA) throw new CarGone('nodata');
      return false;
    }
    if (r.kind === 'timeout' || r.kind === 'stopped') {
      item.next = Math.max(item.next, this.#now() + TIMING.cooldown);
      return false;
    }
    if (r.kind !== 'data') return false;
    const v = decodePid(item.pid, pidBytes(r.lines, item.pid));
    if (v == null) return false;
    item.miss = 0;
    item.ok = true;
    this.#silent = 0;
    this.#store(item.key, v);
    return true;
  }

  #store(key, value, emit = true) {
    const t = this.#now();
    this.#snap[key] = value;
    this.#snap.time = t;
    if (key === 'speed') this.#snap.speedTime = t;
    if (emit) this.#emitData();
  }

  #emitData() {
    const snap = this.snapshot;
    for (const fn of this.#dataFns) {
      try {
        fn(snap);
      } catch {
        /* lỗi ở nơi nghe không được làm dừng phiên */
      }
    }
  }

  #setState(state, info = null) {
    this.#state = state;
    for (const fn of this.#stateFns) {
      try {
        fn(state, info);
      } catch {
        /* bỏ qua */
      }
    }
  }

  // ---- gửi lệnh ----

  /**
   * Gửi một lệnh trong danh sách cho phép và chờ dấu nhắc '>'. Quá hạn thì chạy chuỗi ngắt.
   * @returns { lines, raw, kind } với kind theo classify() hoặc 'timeout'
   */
  #command(cmd, ms) {
    const frame = frameCommand(cmd); // ném lỗi nếu lệnh không được phép
    return this.#exclusive(async () => {
      if (this.#fault) throw this.#fault;
      this.#asm.setCommand(cmd);
      const reply = this.#expect(ms, true);
      reply.catch(noop);
      await this.#write(frame);
      const resp = await reply;
      if (resp) return { ...resp, kind: classify(resp.lines) };
      await this.#abort();
      return { lines: [], raw: '', kind: 'timeout' };
    });
  }

  /**
   * Chuỗi ngắt khi quá hạn: gửi 'X' (không kèm CR). Bộ đọc đang bận sẽ trả 'STOPPED' + '>'.
   * Nếu 500 ms không có gì (bộ đọc đang rảnh, 'X' nằm trong bộ đệm) thì gửi CR để kết thúc lệnh giả
   * 'X' (bộ đọc trả '?' + '>'). Đây là chỗ DUY NHẤT gửi một CR đứng riêng. Vẫn im thì kết nối lại.
   */
  async #abort() {
    // Chip có thể đã in "LV RESET" mà không kèm dấu nhắc: xem phần dở dang trước khi xoá bộ đệm.
    if (needsReset(this.#asm.buffer.split(/[\r\n]+/))) this.#reinitPending = true;
    this.#asm.reset();
    this.#asm.setCommand('X');
    let reply = this.#expect(TIMING.abort, false);
    reply.catch(noop);
    await this.#write('X');
    let resp = await reply;
    if (!resp) {
      reply = this.#expect(TIMING.abortCr, false);
      reply.catch(noop);
      await this.#write('\r', true);
      resp = await reply;
    }
    if (!resp) {
      const err = new LinkLost();
      this.#failAll(err);
      throw err;
    }
    if (needsReset(resp.lines)) this.#reinitPending = true;
  }

  async #write(text, abortCr = false) {
    // Phòng thủ thêm một lớp: chỉ cho qua khung lệnh hợp lệ, 'X', hoặc CR của chuỗi ngắt.
    const ok = text === 'X' || (text === '\r' && abortCr) || (text.endsWith('\r') && frameCommand(text.slice(0, -1)) === text);
    if (!ok) throw new Error('Chặn ghi dữ liệu không hợp lệ xuống bộ OBD.');
    try {
      await this.#t.write(text);
    } catch {
      const err = this.#fault || new LinkLost();
      this.#failAll(err);
      throw err;
    }
  }

  #exclusive(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(noop);
    return run;
  }

  /** Chờ một câu trả lời hoàn chỉnh; hết hạn thì trả null. */
  #expect(ms, skipEmpty) {
    return new Promise((resolve, reject) => {
      if (this.#fault) return reject(this.#fault);
      const w = { resolve, reject, skipEmpty, timer: null };
      w.timer = this.#timers.setTimeout(() => {
        if (this.#waiter === w) this.#waiter = null;
        resolve(null);
      }, ms);
      this.#waiter = w;
    });
  }

  #onIncoming(text) {
    for (const resp of this.#asm.push(text)) {
      const w = this.#waiter;
      if (w && !(w.skipEmpty && resp.lines.length === 0)) {
        this.#waiter = null;
        this.#timers.clearTimeout(w.timer);
        w.resolve(resp);
      } else if (!w) {
        // Câu không ai chờ (ví dụ chip tự khởi động lại khi đề máy): khởi tạo lại ở vòng sau.
        const kind = classify(resp.lines);
        if (needsReset(resp.lines) || kind === 'lvreset' || kind === 'alert') this.#reinitPending = true;
      }
    }
  }

  /** Huỷ mọi việc đang chờ. Khi mất kết nối, chỉ những lần chờ "chỉ dừng khi stop()" được giữ. */
  #failAll(err) {
    const stopping = err instanceof Stopped;
    this.#fault = err;
    const w = this.#waiter;
    this.#waiter = null;
    if (w) {
      this.#timers.clearTimeout(w.timer);
      w.reject(err);
    }
    for (const s of [...this.#waits]) {
      if (s.stopOnly && !stopping) continue;
      this.#timers.clearTimeout(s.timer);
      this.#waits.delete(s);
      s.reject(err);
    }
    for (const p of this.#pauseWaiters) p.reject(err);
    this.#pauseWaiters.clear();
  }

  #wait(ms, stopOnly = false) {
    return new Promise((resolve, reject) => {
      if (this.#fault && !stopOnly) return reject(this.#fault);
      const s = { reject, stopOnly, timer: null };
      s.timer = this.#timers.setTimeout(() => {
        this.#waits.delete(s);
        resolve();
      }, Math.max(0, ms));
      this.#waits.add(s);
    });
  }

  #whilePaused() {
    if (this.#fault) return Promise.reject(this.#fault);
    if (!this.#paused) return Promise.resolve();
    return new Promise((resolve, reject) => this.#pauseWaiters.add({ resolve, reject }));
  }
}

// ---------------------------------------------------------------------------------------------
// Theo dõi tình trạng xe

export const CAR_MESSAGES = {
  coolant: 'Nhiệt độ nước làm mát động cơ đang cao. Hãy dừng xe kiểm tra khi an toàn.',
  battery: 'Điện áp ắc quy thấp, hệ thống sạc có thể có vấn đề.',
};

/** Nhắc bằng lời khi nước làm mát quá nóng hoặc điện áp thấp lúc máy đang chạy; mỗi chuyến nhắc một lần. */
export class CarWatch {
  constructor() {
    this.reset();
  }

  /** Gọi khi bắt đầu chuyến mới. */
  reset() {
    this.hotSince = null;
    this.hotSaid = false;
    this.lowSince = null;
    this.lowSaid = false;
  }

  /** @returns { say: string | null } */
  update(snapshot, now) {
    const s = snapshot || {};
    const hot = Number.isFinite(s.coolant) && s.coolant >= 110;
    if (!hot) this.hotSince = null;
    else if (this.hotSince == null) this.hotSince = now;
    const low = Number.isFinite(s.voltage) && s.voltage < 12 && Number.isFinite(s.rpm) && s.rpm >= 500;
    if (!low) this.lowSince = null;
    else if (this.lowSince == null) this.lowSince = now;

    if (hot && !this.hotSaid && now - this.hotSince >= 10000) {
      this.hotSaid = true;
      return { say: CAR_MESSAGES.coolant };
    }
    if (low && !this.lowSaid && now - this.lowSince >= 30000) {
      this.lowSaid = true;
      return { say: CAR_MESSAGES.battery };
    }
    return { say: null };
  }
}
