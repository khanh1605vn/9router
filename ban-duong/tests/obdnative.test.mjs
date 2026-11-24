// Bộ OBD qua ứng dụng Android (js/obdnative.js): nhận ra ứng dụng, hộp chọn của máy, transport cho ObdClient,
// danh sách lệnh được phép (khớp với elm327.js và với bản Kotlin trong android/), và chạy cả phiên ObdClient qua
// một "máy" giả có bộ ELM327 giả phía sau.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanData,
  cleanName,
  createNativeObd,
  isAllowedFrame,
  isNativeObdDevice,
  NATIVE_EVENT,
  NATIVE_OBD_LIMITS,
  NativeObd,
  NativeObdDevice,
  nativeObdSupport,
} from '../js/obdnative.js';
import { frameCommand, INIT_COMMANDS, isAllowedCommand, pidCommand } from '../js/elm327.js';
import {
  BLE_NAME_PREFIXES,
  BLE_SERVICES,
  createBleTransport,
  createSerialTransport,
  describeConnectError,
  detectSupport,
  ObdClient,
  ObdError,
  reopenSerial,
  requestBleDevice,
  requestSerialPort,
} from '../js/obd.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flush = () => new Promise((r) => setImmediate(r));
const LINK = '0123456789abcdef';
const LINK2 = 'fedcba9876543210';

// ---------- Đồng hồ giả, "máy" giả ----------

class FakeClock {
  constructor() {
    this.t = 0;
    this.q = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => {
      const id = ++this.seq;
      this.q.push({ id, at: this.t + Math.max(0, ms || 0), fn });
      return id;
    };
    this.clearTimeout = (id) => {
      const k = this.q.findIndex((x) => x.id === id);
      if (k !== -1) this.q.splice(k, 1);
    };
  }

  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const x of this.q) if (!next || x.at < next.at || (x.at === next.at && x.id < next.id)) next = x;
      if (!next || next.at > end) break;
      this.q.splice(this.q.indexOf(next), 1);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

/** window giả: BanDuongNative ghi lại mọi thông điệp; native(msg) phát thông điệp từ máy như lớp nối. */
function fakeWindow({ caps = { ble: true, spp: true } } = {}) {
  const listeners = new Map();
  const sent = [];
  const win = {
    BanDuongNative: { postMessage: (s) => sent.push(JSON.parse(s)) },
    BanDuongApp: caps ? { v: 1, obd: caps } : undefined,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    native(msg) {
      for (const fn of listeners.get(NATIVE_EVENT) || []) fn({ detail: msg });
    },
    sent,
    last: (type) => sent.filter((m) => m.type === type).at(-1),
  };
  return win;
}

function port(opts = {}) {
  const clock = new FakeClock();
  const win = fakeWindow(opts);
  const obd = new NativeObd(win.BanDuongNative, { target: win, timers: clock, makeError: (m) => new ObdError(m) });
  return { clock, win, obd };
}

async function picked(env, kind = 'ble', name = 'OBDII', link = LINK) {
  const p = env.obd.pick(kind);
  const req = env.win.last('obdPick').req;
  env.win.native({ v: 1, type: 'obdPicked', req, ok: true, link, kind, name });
  return p;
}

// ---------- Nhận ra ứng dụng ----------

test('nativeObdSupport: chỉ khi có BanDuongNative.postMessage và BanDuongApp.obd đúng true', () => {
  assert.equal(nativeObdSupport({}), null);
  assert.equal(nativeObdSupport(undefined), null);
  assert.equal(nativeObdSupport({ BanDuongApp: { obd: { ble: true } } }), null, 'thiếu kênh');
  assert.equal(nativeObdSupport({ BanDuongNative: {}, BanDuongApp: { obd: { ble: true } } }), null, 'kênh không có postMessage');
  const ch = { postMessage() {} };
  assert.equal(nativeObdSupport({ BanDuongNative: ch }), null, 'ứng dụng cũ chưa có OBD');
  assert.equal(nativeObdSupport({ BanDuongNative: ch, BanDuongApp: { obd: { ble: 'true', spp: 1 } } }), null);
  assert.deepEqual(nativeObdSupport({ BanDuongNative: ch, BanDuongApp: { obd: { ble: true } } }), { ble: true, spp: false });
  assert.deepEqual(nativeObdSupport({ BanDuongNative: ch, BanDuongApp: { obd: { ble: true, spp: true } } }), { ble: true, spp: true });
  const throwing = {
    get BanDuongNative() {
      throw new Error('x');
    },
  };
  assert.equal(nativeObdSupport(throwing), null);
  assert.equal(createNativeObd({}), null);
});

test('detectSupport trong ứng dụng: dùng Bluetooth của máy, không cần Web Bluetooth', () => {
  const win = fakeWindow();
  win.navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit Chrome/131 Mobile' };
  assert.deepEqual(detectSupport(win), { ble: true, serial: true, secure: true, reason: null, native: true });
  const sppOnly = fakeWindow({ caps: { ble: false, spp: true } });
  assert.deepEqual(detectSupport(sppOnly), { ble: false, serial: true, secure: true, reason: 'nobt', native: true });
  // Ứng dụng không có OBD: như WebView thường (lý do 'webview').
  const none = fakeWindow({ caps: null });
  none.navigator = win.navigator;
  none.isSecureContext = true;
  assert.equal(detectSupport(none).reason, 'webview');
  assert.equal(detectSupport(none).native, undefined);
});

// ---------- Danh sách lệnh được phép ----------

test('isAllowedFrame: đúng tập frameCommand(lệnh được phép), không gì khác', () => {
  const good = [...INIT_COMMANDS, 'ATRV', 'ATDPN', 'ATI', 'ATFE', 'ATST32', 'ATSPA6', '03', pidCommand(0x0d), `${pidCommand(0x0c)}1`];
  for (const c of good) assert.ok(isAllowedFrame(frameCommand(c)), c);
  assert.ok(isAllowedFrame('X'));
  const bad = [
    '', '\r', 'X\r', 'ATZ', 'ATZ\r\r', 'atz\r', ' ATZ\r', 'AT Z\r', 'ATMA\r', 'ATPP0CSV00\r', '04\r', '0902\r', 'ATWS\n',
    '010D\n', '010D\r\n', 'ATZ\rATMA\r', 'ATSP0\0\r', `${'0'.repeat(20)}\r`, '0100\u0000\r',
  ];
  for (const s of bad) assert.equal(isAllowedFrame(s), false, JSON.stringify(s));
  for (const v of [null, undefined, 1, ['ATZ\r'], { toString: () => 'ATZ\r' }]) assert.equal(isAllowedFrame(v), false);
  // Tự sinh: mọi chuỗi ngắn theo dạng AT.. / 01.. khớp đúng isAllowedCommand.
  const alpha = '0123456789ABCDEFHILPRSTVWXZ';
  let n = 0;
  for (const a of alpha) for (const b of alpha) for (const c of ['', ...alpha]) {
    for (const pre of ['AT', '01', '0', '']) {
      const cmd = pre + a + b + c;
      assert.equal(isAllowedFrame(`${cmd}\r`), cmd !== 'X' && isAllowedCommand(cmd), cmd);
      n++;
    }
  }
  assert.ok(n > 70000);
});

/** Các mẫu trong ALLOWED của elm327.js, đúng như viết trong tệp. */
function jsAllowedPatterns() {
  const src = readFileSync(join(ROOT, 'js/elm327.js'), 'utf8');
  const block = /const ALLOWED = \[([\s\S]*?)\];/.exec(src)[1];
  return [...block.matchAll(/^\s*\/(.+)\/,\s*$/gm)].map((m) => m[1]);
}

const KOTLIN_OBD = join(ROOT, 'android/app/src/main/java/vn/banduong/app/obd');

test('ứng dụng Android dùng đúng danh sách lệnh được phép của elm327.js (ObdCommands.kt)', (t) => {
  const file = join(KOTLIN_OBD, 'ObdCommands.kt');
  if (!existsSync(file)) return t.skip('không có thư mục android/');
  const kt = readFileSync(file, 'utf8');
  const block = /val ALLOWED_PATTERNS = listOf\(([\s\S]*?)\n {4}\)/.exec(kt)[1];
  const patterns = [...block.matchAll(/^\s*"(.+)",\s*$/gm)].map((m) => m[1]);
  assert.ok(patterns.length >= 6);
  assert.deepEqual(patterns, jsAllowedPatterns());
  assert.match(kt, /const val MAX_FRAME_CHARS = 16\b/);
  assert.equal(NATIVE_OBD_LIMITS.maxFrame, 16);
});

test('ứng dụng Android lọc và dò thiết bị BLE giống obd.js (ObdProfiles.kt)', (t) => {
  const file = join(KOTLIN_OBD, 'ObdProfiles.kt');
  if (!existsSync(file)) return t.skip('không có thư mục android/');
  const kt = readFileSync(file, 'utf8');
  const list = (name) => {
    const m = new RegExp(`val ${name}[^=]*= listOf\\(([\\s\\S]*?)\\)\\n`).exec(kt);
    assert.ok(m, name);
    return m[1];
  };
  const prefixes = [...list('NAME_PREFIXES').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(prefixes, BLE_NAME_PREFIXES);
  const services = [...list('SERVICES').matchAll(/uuid16\(0x([0-9a-f]+)\)|uuid\("([0-9a-f-]+)"\)/gi)].map((m) =>
    m[1] ? parseInt(m[1], 16) : m[2]
  );
  assert.deepEqual(services, BLE_SERVICES);
});

// ---------- Làm sạch dữ liệu từ máy ----------

test('cleanData và cleanName', () => {
  assert.equal(cleanData('41 0D 3C\r\r>'), '41 0D 3C\r\r>');
  assert.equal(cleanData('A\u0000B\u001bCÿD‮E\n'), 'ABCDE\n');
  assert.equal(cleanData(42), '');
  assert.equal(cleanData('x'.repeat(NATIVE_OBD_LIMITS.maxData + 1)), '');
  assert.equal(cleanName(' OBDII‮  v1.5\u0007 '), 'OBDII v1.5');
  assert.equal(cleanName('Bộ đọc Việt'), 'Bộ đọc Việt');
  assert.equal(cleanName('\u0000​'), null);
  assert.equal(cleanName(null), null);
  assert.equal(cleanName('a'.repeat(41)), 'a'.repeat(40));
  assert.equal(cleanName('😀'.repeat(41)), '😀'.repeat(40), 'không cắt đôi cặp surrogate');
  assert.equal(cleanName('a'.repeat(500)), null);
});

// ---------- Hộp chọn thiết bị ----------

test('pick: gửi obdPick, nhận thiết bị có mã link do máy cấp', async () => {
  const env = port();
  const p = env.obd.pick('ble', true);
  const msg = env.win.last('obdPick');
  assert.deepEqual(msg, { v: 1, type: 'obdPick', req: msg.req, kind: 'ble', all: true });
  // Sai req, sai v: bỏ qua.
  env.win.native({ v: 1, type: 'obdPicked', req: msg.req + 1, ok: true, link: LINK, kind: 'ble' });
  env.win.native({ v: 2, type: 'obdPicked', req: msg.req, ok: true, link: LINK, kind: 'ble' });
  env.win.native({ v: 1, type: 'obdPicked', req: String(msg.req), ok: true, link: LINK, kind: 'ble' });
  env.win.native({ v: 1, type: 'obdPicked', req: msg.req, ok: true, link: LINK, kind: 'ble', name: 42 });
  const d = await p;
  assert.ok(isNativeObdDevice(d));
  assert.ok(d instanceof NativeObdDevice);
  assert.equal(d.link, LINK);
  assert.equal(d.kind, 'ble');
  assert.equal(d.name, null);
  assert.ok(Object.isFrozen(d));

  const p2 = env.obd.pick('spp');
  const m2 = env.win.last('obdPick');
  assert.deepEqual(m2, { v: 1, type: 'obdPick', req: m2.req, kind: 'spp', all: false });
  assert.notEqual(m2.req, msg.req);
  env.win.native({ v: 1, type: 'obdPicked', req: m2.req, ok: true, link: LINK2, kind: 'spp', name: 'OBDII‮' });
  const d2 = await p2;
  assert.deepEqual([d2.link, d2.kind, d2.name], [LINK2, 'spp', 'OBDII']);
  await assert.rejects(env.obd.pick('wifi'), TypeError);
});

test('pick: lỗi của máy thành lỗi như trình duyệt hoặc câu tiếng Việt', async () => {
  const env = port();
  const fail = async (error) => {
    const p = env.obd.pick('ble');
    env.win.native({ v: 1, type: 'obdPicked', req: env.win.last('obdPick').req, ok: false, error });
    return p.then(
      () => assert.fail('phải lỗi'),
      (e) => e
    );
  };
  const cancelled = await fail('cancelled');
  assert.equal(cancelled.name, 'NotFoundError');
  assert.match(cancelled.message, /cancel/i, 'main.js onPickError coi là người dùng tự đóng');
  assert.equal((await fail('denied')).name, 'NotAllowedError');
  assert.equal(describeConnectError(await fail('denied')), 'Bạn chưa cho phép dùng Bluetooth.');
  for (const code of ['off', 'unsupported', 'nopaired', 'gesture', 'busy', 'lạ', undefined]) {
    const e = await fail(code);
    assert.ok(e instanceof ObdError, String(code));
    assert.equal(describeConnectError(e), e.message);
    assert.match(e.message, /^[A-ZĐ]/u);
  }
  assert.match((await fail('off')).message, /Bluetooth của điện thoại đang tắt/);
  assert.match((await fail('nopaired')).message, /ghép đôi/);
  // ok:true nhưng thiếu link hoặc link sai dạng (ví dụ địa chỉ Bluetooth) → lỗi, không treo.
  for (const link of [undefined, 'AA:BB:CC:DD:EE:FF', LINK.toUpperCase(), `${LINK}0`]) {
    const p = env.obd.pick('ble');
    env.win.native({ v: 1, type: 'obdPicked', req: env.win.last('obdPick').req, ok: true, link, kind: 'ble' });
    await assert.rejects(p, ObdError);
  }
});

test('pick: máy không trả lời thì hết hạn, kênh hỏng thì lỗi ngay', async () => {
  const env = port();
  const p = env.obd.pick('ble');
  let err = null;
  p.catch((e) => (err = e));
  await env.clock.advance(NATIVE_OBD_LIMITS.pickTimeout - 1);
  assert.equal(err, null);
  await env.clock.advance(1);
  assert.ok(err instanceof ObdError);
  // Trả lời muộn bị bỏ qua.
  env.win.native({ v: 1, type: 'obdPicked', req: env.win.last('obdPick').req, ok: true, link: LINK, kind: 'ble' });

  const broken = new NativeObd(
    {
      postMessage() {
        throw new Error('hỏng');
      },
    },
    { target: fakeWindow(), timers: new FakeClock(), makeError: (m) => new ObdError(m) }
  );
  await assert.rejects(broken.pick('spp'), ObdError);
});

// ---------- Transport ----------

test('transport: kết nối, ghi lệnh được phép, nhận dữ liệu, ngắt', async () => {
  const env = port();
  const d = await picked(env, 'ble', 'vLinker MC');
  const t = createBleTransport(d);
  assert.equal(t.kind, 'ble');
  assert.equal(t.name, 'vLinker MC');
  const data = [];
  const closes = [];
  await assert.rejects(t.write('ATZ\r'), /Chưa kết nối/);
  const c = t.connect({ onData: (s) => data.push(s), onClose: (r) => closes.push(r) });
  assert.deepEqual(env.win.last('obdConnect'), { v: 1, type: 'obdConnect', link: LINK });
  env.win.native({ v: 1, type: 'obdData', link: LINK, data: 'sớm' }); // chưa mở: bỏ
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'open' });
  await c;

  await t.write('ATZ\r');
  await t.write('X');
  await t.write('\r'); // CR riêng chỉ ngay sau X
  await assert.rejects(t.write('\r'), /không nằm trong danh sách/);
  for (const bad of ['04\r', 'ATMA\r', 'ATZ', '\r', 'X\r', 'ATPP0CSV00\r', '010D\r010D\r']) {
    await assert.rejects(t.write(bad), /không nằm trong danh sách/, JSON.stringify(bad));
  }
  const writes = env.win.sent.filter((m) => m.type === 'obdWrite');
  assert.deepEqual(writes.map((m) => m.data), ['ATZ\r', 'X', '\r']);
  assert.ok(writes.every((m) => m.link === LINK && m.v === 1));

  env.win.native({ v: 1, type: 'obdData', link: LINK, data: 'ELM327 v1.5\r\r>' });
  env.win.native({ v: 1, type: 'obdData', link: LINK2, data: 'của link khác' });
  env.win.native({ v: 1, type: 'obdData', link: LINK, data: 'A\u0000B‮>' });
  env.win.native({ v: 1, type: 'obdData', link: LINK, data: 7 });
  assert.deepEqual(data, ['ELM327 v1.5\r\r>', 'AB>']);

  await t.disconnect();
  assert.deepEqual(env.win.last('obdDisconnect'), { v: 1, type: 'obdDisconnect', link: LINK });
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'closed', reason: 'closed' });
  env.win.native({ v: 1, type: 'obdData', link: LINK, data: 'sau khi ngắt' });
  assert.deepEqual(closes, [], 'tự ngắt thì không báo onClose');
  assert.equal(data.length, 2);
  await assert.rejects(t.write('ATZ\r'), /Chưa kết nối/);
});

test('transport: mất kết nối báo onClose, kết nối lại dùng lại mã link, không mở lại hộp chọn', async () => {
  const env = port();
  const d = await picked(env, 'spp', null);
  const t = createSerialTransport(d);
  assert.equal(t.kind, 'serial');
  assert.equal(t.name, 'bộ OBD Bluetooth thường');
  const closes = [];
  const h = { onData() {}, onClose: (r) => closes.push(r) };
  let c = t.connect(h);
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'open' });
  await c;
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'closed', reason: 'lost' });
  assert.deepEqual(closes, ['disconnected']);
  c = t.connect(h);
  assert.equal(env.win.sent.filter((m) => m.type === 'obdConnect').length, 2);
  assert.equal(env.win.sent.filter((m) => m.type === 'obdPick').length, 1);
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'open' });
  await c;
});

test('transport: lỗi khi mở kết nối thành câu dễ hiểu; hết thời gian thì huỷ phía máy', async () => {
  const env = port();
  const d = await picked(env);
  const t = createBleTransport(d);
  const h = { onData() {}, onClose() {} };
  const open = (reason) => {
    const c = t.connect(h);
    env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'closed', reason });
    return c.then(
      () => assert.fail('phải lỗi'),
      (e) => e
    );
  };
  const noChannel = await open('nochannel');
  assert.ok(noChannel instanceof ObdError);
  assert.equal(noChannel.message, 'Không tìm thấy kênh dữ liệu của bộ OBD trên thiết bị này.');
  assert.ok((await open('off')) instanceof ObdError);
  assert.match((await open('denied')).message, /Thiết bị ở gần/);
  assert.equal((await open('failed')).name, 'NetworkError');
  assert.equal((await open(undefined)).name, 'NetworkError');

  const c = t.connect(h);
  let err = null;
  c.catch((e) => (err = e));
  await env.clock.advance(NATIVE_OBD_LIMITS.connectTimeout);
  assert.equal(err?.name, 'NetworkError');
  assert.deepEqual(env.win.last('obdDisconnect'), { v: 1, type: 'obdDisconnect', link: LINK });
  // Máy mở muộn: transport đã coi là hỏng, không ghi được.
  env.win.native({ v: 1, type: 'obdState', link: LINK, state: 'open' });
  await assert.rejects(t.write('ATZ\r'), /Chưa kết nối/);
  assert.throws(() => env.obd.transport({ link: LINK, kind: 'ble' }), TypeError);
  assert.throws(() => port().obd.transport(d), TypeError, 'thiết bị của cổng khác');
});

// ---------- Cả phiên ObdClient qua máy giả ----------

/**
 * "Máy" giả: hộp chọn trả về một thiết bị, obdConnect mở kết nối, obdWrite chuyển cho một ELM327 rất đơn giản,
 * câu trả lời gửi về thành từng mẩu obdData (như gói BLE 20 byte). Kiểm tra lại mọi lệnh bằng isAllowedFrame.
 */
function fakeApp(clock) {
  const win = fakeWindow();
  const written = [];
  let input = '';
  const answer = (cmd) => {
    if (cmd === 'ATZ' || cmd === 'ATI') return 'ELM327 v1.5';
    if (cmd === 'ATRV') return '13.9V';
    if (cmd === 'ATDPN') return 'A6';
    if (cmd.startsWith('AT')) return 'OK';
    const pid = /^01([0-9A-F]{2})1?$/.exec(cmd)?.[1];
    switch (pid) {
      case '00':
        return '41 00 98 18 80 11';
      case '20':
        return '41 20 00 02 00 01';
      case '40':
        return '41 40 40 00 00 00';
      case '0D':
        return '41 0D 3C';
      case '0C':
        return '41 0C 1C E8';
      case '05':
        return '41 05 80';
      case '2F':
        return '41 2F 66';
      case '42':
        return '41 42 37 78';
      default:
        return 'NO DATA';
    }
  };
  const reply = (text) => {
    const out = `${text}\r\r>`;
    for (let i = 0; i < out.length; i += 20) {
      const chunk = out.slice(i, i + 20);
      clock.setTimeout(() => win.native({ v: 1, type: 'obdData', link: LINK, data: chunk }), 30);
    }
  };
  const post = win.BanDuongNative.postMessage;
  win.BanDuongNative.postMessage = (s) => {
    post(s);
    const m = JSON.parse(s);
    if (m.type === 'obdPick') clock.setTimeout(() => win.native({ v: 1, type: 'obdPicked', req: m.req, ok: true, link: LINK, kind: m.kind, name: 'OBDII' }), 5);
    if (m.type === 'obdConnect') clock.setTimeout(() => win.native({ v: 1, type: 'obdState', link: m.link, state: 'open' }), 50);
    if (m.type === 'obdWrite') {
      written.push(m.data);
      if (m.data === 'X' || m.data === '\r') return;
      input += m.data;
      let k;
      while ((k = input.indexOf('\r')) !== -1) {
        const cmd = input.slice(0, k);
        input = input.slice(k + 1);
        reply(answer(cmd));
      }
    }
  };
  win.drop = () => win.native({ v: 1, type: 'obdState', link: LINK, state: 'closed', reason: 'lost' });
  return { win, written };
}

test('ObdClient chạy hết phiên qua ứng dụng: khởi tạo, đọc tốc độ, mất kết nối rồi tự nối lại', async () => {
  const clock = new FakeClock();
  const app = fakeApp(clock);
  const obd = new NativeObd(app.win.BanDuongNative, { target: app.win, timers: clock, makeError: (m) => new ObdError(m) });
  const pick = obd.pick('ble');
  await clock.advance(10);
  const device = await pick;
  const client = new ObdClient(createBleTransport(device), { timers: clock, now: clock.now });
  const states = [];
  client.onState((s) => states.push(s));
  client.start();
  await clock.advance(15000);
  assert.equal(client.state, 'ready', states.join(' → '));
  assert.equal(client.snapshot.speed, 60);
  assert.equal(client.snapshot.rpm, 1850);
  assert.equal(client.name, 'OBDII');
  assert.ok(app.written.length > 10);
  let afterX = false;
  for (const w of app.written) {
    assert.ok(isAllowedFrame(w) || (w === '\r' && afterX), JSON.stringify(w));
    afterX = w === 'X';
  }

  app.win.drop();
  await clock.advance(100);
  assert.equal(client.state, 'lost');
  await clock.advance(10000);
  assert.equal(client.state, 'ready', states.join(' → '));
  assert.equal(app.win.sent.filter((m) => m.type === 'obdPick').length, 1, 'không mở lại hộp chọn');
  assert.equal(app.win.sent.filter((m) => m.type === 'obdConnect').length, 2);
  await client.stop();
  assert.equal(app.win.last('obdDisconnect')?.link, LINK);
});

// ---------- obd.js chọn đường của ứng dụng (globalThis giả như trong WebView) ----------

test('obd.js: trong ứng dụng, requestBleDevice/requestSerialPort mở hộp chọn của máy, reopenSerial không tự nối', async () => {
  const win = fakeWindow();
  const saved = {};
  for (const k of ['BanDuongNative', 'BanDuongApp', 'addEventListener', 'removeEventListener']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  }
  try {
    const p = requestBleDevice(true, { bluetooth: { requestDevice: () => assert.fail('không dùng Web Bluetooth') } });
    const m = win.last('obdPick');
    assert.deepEqual([m.kind, m.all], ['ble', true]);
    win.native({ v: 1, type: 'obdPicked', req: m.req, ok: true, link: LINK, kind: 'ble', name: 'OBD' });
    const d = await p;
    assert.ok(isNativeObdDevice(d));
    assert.equal(createBleTransport(d).kind, 'ble');

    const s = requestSerialPort({ serial: { requestPort: () => assert.fail('không dùng Web Serial') } });
    const m2 = win.last('obdPick');
    assert.equal(m2.kind, 'spp');
    win.native({ v: 1, type: 'obdPicked', req: m2.req, ok: true, link: LINK2, kind: 'spp' });
    assert.equal(createSerialTransport(await s).kind, 'serial');
    assert.equal(await reopenSerial({ serial: { getPorts: () => assert.fail('không tự nối') } }), null);
  } finally {
    for (const [k, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
});
