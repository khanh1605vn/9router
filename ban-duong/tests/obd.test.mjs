import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INIT_COMMANDS,
  ResponseAssembler,
  classify,
  decodeDtcs,
  decodePid,
  frameCommand,
  identifyAdapter,
  isAllowedCommand,
  needsReset,
  parseMessages,
  parseSupported,
  parseVoltage,
  pidBytes,
  pidBytesAll,
  pidCommand,
} from '../js/elm327.js';
import {
  BLE_SERVICES,
  CAR_MESSAGES,
  CarWatch,
  ObdClient,
  RECONNECT_DELAYS,
  SPP_UUID,
  chooseCharacteristics,
  createBleTransport,
  createSerialTransport,
  describeConnectError,
  detectSupport,
  reopenSerial,
  requestBleDevice,
  requestSerialPort,
} from '../js/obd.js';

const flush = () => new Promise((r) => setImmediate(r));
const U = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

// ---------------------------------------------------------------------------------------------
// Đồng hồ giả: thời gian chỉ trôi khi gọi advance(), không chờ thật.

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

const mask = (pids, base) => {
  const b = [0, 0, 0, 0];
  for (const p of pids) {
    const i = p - base - 1;
    b[i >> 3] |= 0x80 >> (i & 7);
  }
  return b;
};

// ---------------------------------------------------------------------------------------------
// Bộ ELM327 giả: mô phỏng echo, linefeed, khoảng trắng, dò giao thức, STOPPED khi bị chen ngang,
// CR trống = chạy lại lệnh cũ, LV RESET / ERR94 chặn dò CAN tới khi có ATFE, gói 20 byte.

class FakeElm {
  constructor(clock, opts = {}) {
    this.clock = clock;
    this.kind = 'fake';
    this.name = 'ELM327 giả';
    this.id = opts.id ?? 'ELM327 v1.5';
    this.ati = opts.ati ?? this.id;
    this.atrv = opts.atrv ?? '13.9V';
    this.speed = 60;
    this.rpm = 1850;
    this.coolant = 88;
    this.fuel = 40;
    this.ecuVolts = 14.2;
    this.supported = opts.supported ?? [0x04, 0x05, 0x0c, 0x0d, 0x11, 0x20, 0x2f, 0x40, 0x42, 0x5c];
    this.noData = new Set(opts.noData || []);
    this.dtcLines = opts.dtcLines || ['43 00'];
    this.latency = 40;
    this.carOff = false;
    this.dead = false;
    this.refuse = false;
    this.stallOnce = null;
    this.dropOnce = null;
    this.lvResetOnce = null;
    this.lvResetSilentOnce = null;
    this.err94Once = null;
    this.writes = [];
    this.writeLog = [];
    this.commands = [];
    this.connects = 0;
    this.disconnects = 0;
    this.interrupted = 0;
    this.bareCr = 0;
    this.feCount = 0;
    this.canBlocked = false;
    this.h = null;
    this.timers = new Set();
    this.input = '';
    this.busy = null;
    this.last = null;
    this.defaults();
  }

  defaults() {
    this.echo = true;
    this.lf = true;
    this.spaces = true;
    this.protocol = false;
  }

  eol() {
    return this.lf ? '\r\n' : '\r';
  }

  async connect(h) {
    this.connects++;
    if (this.refuse) throw new Error('từ chối kết nối');
    this.h = h;
    this.dead = false; // như vừa cắm lại
    this.defaults();
    this.canBlocked = false;
    this.input = '';
    this.busy = null;
  }

  #cancelAll() {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
    this.busy = null;
  }

  async disconnect() {
    this.disconnects++;
    this.h = null;
    this.#cancelAll();
  }

  /** Mất kết nối từ phía thiết bị (như gattserverdisconnected). */
  drop() {
    const h = this.h;
    this.h = null;
    this.#cancelAll();
    h?.onClose('disconnected');
  }

  /** Chip tự khởi động lại (sụt áp khi đề máy) và in thông báo dù không ai hỏi. */
  spontaneous(lines) {
    this.#cancelAll();
    this.defaults();
    this.canBlocked = true;
    this.#finish(lines, '');
  }

  async write(text) {
    this.writes.push(text);
    this.writeLog.push({ text, t: this.clock.now() });
    if (this.dead || !this.h) return;
    for (const ch of text) this.#char(ch);
  }

  #later(fn, ms) {
    const id = this.clock.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  #emit(text) {
    for (let i = 0; i < text.length; i += 20) {
      const part = text.slice(i, i + 20);
      this.#later(() => this.h?.onData(part), 0);
    }
  }

  #finish(lines, echo) {
    this.#emit(echo + lines.map((l) => l + this.eol()).join('') + this.eol());
    this.#emit('>'); // dấu nhắc đến trong gói riêng
  }

  #char(ch) {
    if (this.busy) {
      // Nhận ký tự khi đang xử lý: dừng lại, ký tự đó bị bỏ.
      this.interrupted++;
      if (this.busy.timer) {
        this.clock.clearTimeout(this.busy.timer);
        this.timers.delete(this.busy.timer);
      }
      this.busy = null;
      this.#finish(['STOPPED'], '');
      return;
    }
    if (ch === '\r') {
      let cmd = this.input.replace(/\s+/g, '').toUpperCase();
      this.input = '';
      if (!cmd) {
        this.bareCr++; // ELM327 chạy lại lệnh trước đó
        cmd = this.last;
        if (!cmd) return;
      }
      this.last = cmd;
      this.#run(cmd);
      return;
    }
    if (ch !== '\n') this.input += ch;
  }

  #run(cmd) {
    this.commands.push({ cmd, t: this.clock.now() });
    const echo = this.echo ? cmd + this.eol() : '';
    const r = this.#answer(cmd);
    if (r.drop) return; // câu trả lời bị mất trên đường truyền, bộ đọc vẫn rảnh
    if (r.stall) {
      if (echo) this.#emit(echo);
      this.busy = { timer: null }; // treo cho tới khi bị chen ngang
      return;
    }
    const busy = { timer: null };
    busy.timer = this.#later(() => {
      if (this.busy === busy) this.busy = null;
      this.#finish(r.lines, echo);
    }, r.delay ?? this.latency);
    this.busy = busy;
  }

  #answer(cmd) {
    if (cmd === this.stallOnce) {
      this.stallOnce = null;
      return { stall: true };
    }
    if (cmd === this.dropOnce) {
      this.dropOnce = null;
      return { drop: true };
    }
    if (cmd === this.lvResetOnce) {
      this.lvResetOnce = null;
      this.defaults();
      this.canBlocked = true;
      return { lines: ['LV RESET'] };
    }
    if (cmd === this.lvResetSilentOnce) {
      // Biến thể: in "LV RESET" nhưng không có dấu nhắc, rồi rảnh.
      this.lvResetSilentOnce = null;
      this.defaults();
      this.canBlocked = true;
      this.#emit(`LV RESET${this.eol()}`);
      return { drop: true };
    }
    if (cmd === this.err94Once) {
      this.err94Once = null;
      this.defaults();
      this.canBlocked = true;
      return { lines: ['ERR94'] };
    }
    const OK = { lines: ['OK'] };
    switch (cmd) {
      case 'ATZ':
        this.defaults();
        return { lines: ['', this.id], delay: 600 };
      case 'ATI':
        return { lines: [this.ati] };
      case 'ATE0':
        this.echo = false;
        return OK;
      case 'ATL0':
        this.lf = false;
        return OK;
      case 'ATS0':
        this.spaces = false;
        return OK;
      case 'ATH0':
      case 'ATAT1':
        return OK;
      case 'ATSP0':
        this.protocol = false;
        return OK;
      case 'ATFE':
        this.feCount++;
        this.canBlocked = false;
        return OK;
      case 'ATRV':
        return { lines: [this.atrv] };
      case '03':
        return { lines: this.dtcLines, delay: 120 };
      default:
    }
    if (/^01[0-9A-F]{2}$/.test(cmd)) return this.#mode01(parseInt(cmd.slice(2), 16));
    return { lines: ['?'] };
  }

  #mode01(pid) {
    const searching = !this.protocol;
    const pre = searching ? ['SEARCHING...'] : [];
    const delay = searching ? 3000 : undefined;
    if (this.carOff || this.canBlocked) {
      return searching ? { lines: [...pre, 'UNABLE TO CONNECT'], delay } : { lines: ['NO DATA'] };
    }
    this.protocol = true;
    const data = this.#pidData(pid);
    if (!data || this.noData.has(pid)) return { lines: [...pre, 'NO DATA'], delay };
    return { lines: [...pre, this.#fmt([0x41, pid, ...data])], delay };
  }

  #pidData(pid) {
    if (pid === 0x00 || pid === 0x20 || pid === 0x40) {
      const list = this.supported.filter((p) => p > pid && p <= pid + 0x20);
      return list.length ? mask(list, pid) : null;
    }
    if (!this.supported.includes(pid)) return null;
    switch (pid) {
      case 0x0d:
        return [this.speed];
      case 0x0c: {
        const raw = Math.round(this.rpm * 4);
        return [raw >> 8, raw & 0xff];
      }
      case 0x05:
        return [this.coolant + 40];
      case 0x2f:
        return [Math.round((this.fuel * 255) / 100)];
      case 0x42: {
        const mv = Math.round(this.ecuVolts * 1000);
        return [mv >> 8, mv & 0xff];
      }
      default:
        return [0x20];
    }
  }

  #fmt(bytes) {
    return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(this.spaces ? ' ' : '');
  }
}

function setup(opts) {
  const clock = new FakeClock();
  const elm = new FakeElm(clock, opts);
  const client = new ObdClient(elm, { timers: clock, now: clock.now });
  const states = [];
  const infos = [];
  client.onState((s, info) => {
    states.push(s);
    infos.push(info);
  });
  let snap = null;
  client.onData((s) => {
    snap = s;
  });
  const cmds = () => elm.commands.map((c) => c.cmd);
  const count = (cmd) => cmds().filter((c) => c === cmd).length;
  return {
    clock,
    elm,
    client,
    states,
    infos,
    cmds,
    count,
    get snap() {
      return snap;
    },
  };
}

/** Mọi thứ ghi xuống bộ đọc: lệnh trong danh sách cho phép + CR, 'X', hoặc CR ngay sau 'X'. */
function assertSafeWrites(writes) {
  writes.forEach((w, i) => {
    assert.ok(w.length <= 20, `gói quá dài: ${JSON.stringify(w)}`);
    if (w === '\r') {
      assert.equal(writes[i - 1], 'X', 'CR đứng riêng chỉ được gửi ngay sau X');
      return;
    }
    if (w === 'X') return;
    assert.ok(w.endsWith('\r'), `thiếu CR: ${JSON.stringify(w)}`);
    const cmd = w.slice(0, -1);
    assert.ok(!cmd.includes('\r') && isAllowedCommand(cmd), `lệnh không được phép: ${JSON.stringify(w)}`);
  });
}

// ---------------------------------------------------------------------------------------------
// elm327.js

test('danh sách lệnh cho phép: chặn Mode 04, ATMA, ATPP, chuỗi rỗng và lệnh tự nhập', () => {
  const ok = ['ATZ', 'ATWS', 'ATD', 'ATI', 'ATFE', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATH1', 'ATAT1', 'ATAT2',
    'ATST32', 'ATST64', 'ATSP0', 'ATSPA6', 'ATDPN', 'ATRV', '0100', '010D', '010D1', '015C', '03', 'X'];
  for (const cmd of ok) assert.equal(isAllowedCommand(cmd), true, cmd);
  const bad = ['04', '0400', 'ATMA', 'ATPP 2A SV 00', 'ATPP2ASV00', 'ATPPS', '', ' ', 'hello', 'ATZ\r', '010D\r04',
    'AT Z', 'atz', '0902', '01', '010', '010D12', 'ATSP6', 'ATST3', 'ATBRD', '\r', 'XX', 'x', null, undefined, 42];
  for (const cmd of bad) assert.equal(isAllowedCommand(cmd), false, JSON.stringify(cmd));
  for (const cmd of INIT_COMMANDS) assert.equal(isAllowedCommand(cmd), true, cmd);
});

test('khung lệnh: thêm CR, riêng X thì không; lệnh lạ bị từ chối; không tạo CR trống', () => {
  assert.equal(frameCommand('010D'), '010D\r');
  assert.equal(frameCommand('ATZ'), 'ATZ\r');
  assert.equal(frameCommand('X'), 'X');
  assert.throws(() => frameCommand('04'));
  assert.throws(() => frameCommand(''));
  assert.throws(() => frameCommand('\r'));
  assert.equal(pidCommand(0x0d), '010D');
  assert.equal(pidCommand('5c'), '015C');
  assert.throws(() => pidCommand(300));
});

test('ghép phản hồi: gói bị cắt giữa dòng, dấu nhắc đến riêng, bỏ echo, SEARCHING, BUS INIT và byte 0', () => {
  const a = new ResponseAssembler();
  a.setCommand('010D');
  assert.deepEqual(a.push('010D\r41 0'), []);
  assert.deepEqual(a.push('D 3C\r\r'), []);
  const [r] = a.push('>');
  assert.deepEqual(r.lines, ['41 0D 3C']);

  a.setCommand('0100');
  const out = a.push('\0SEARCHING...\r\n4100BE1FA813\r\r>OK\r');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].lines, ['4100BE1FA813']);
  a.setCommand('ATE0');
  assert.deepEqual(a.push('\r>')[0].lines, ['OK']); // phần còn lại của gói trước

  a.setCommand('0100');
  assert.deepEqual(a.push('BUS INIT: ...OK\r410D00\r\r>')[0].lines, ['410D00']);
  a.setCommand('ATZ');
  assert.deepEqual(a.push('ATZ\r\r\rELM327 v1.5\r\r>')[0].lines, ['ELM327 v1.5']);
  assert.deepEqual(a.push('>')[0].lines, []); // dấu nhắc đứng riêng
  const two = a.push('OK\r>?\r>');
  assert.deepEqual(two.map((x) => x.lines), [['OK'], ['?']]);
});

test('phân loại câu trả lời của ELM327', () => {
  const cases = [
    [['OK'], 'ok'],
    [['410D3C'], 'data'],
    [['ELM327 v1.5'], 'data'],
    [['12.3V'], 'data'],
    [['NO DATA'], 'nodata'],
    [['NODATA'], 'nodata'],
    [['UNABLE TO CONNECT'], 'unable'],
    [['STOPPED'], 'stopped'],
    [['?'], 'unknown'],
    [['CAN ERROR'], 'error'],
    [['BUS ERROR'], 'error'],
    [['FB ERROR'], 'error'],
    [['<RX ERROR'], 'error'],
    [['ERR94'], 'error'],
    [['BUS INIT: ...ERROR'], 'error'],
    [['LV RESET'], 'lvreset'],
    [['BUFFER FULL'], 'buffer'],
    [['410D3C', 'BUFFER FULL'], 'buffer'],
    [['ACT ALERT'], 'alert'],
    [['LP ALERT'], 'alert'],
    [[], 'empty'],
  ];
  for (const [lines, kind] of cases) assert.equal(classify(lines), kind, lines.join('|'));
  assert.equal(needsReset(['ERR94']), true);
  assert.equal(needsReset(['LV RESET']), true);
  assert.equal(needsReset(['CAN ERROR']), false);
  assert.equal(identifyAdapter(['ELM327 v1.5']), 'ELM327 v1.5');
  assert.equal(identifyAdapter(['STN1110 v4.0']), 'STN1110 v4.0');
  assert.equal(identifyAdapter(['OK', '?']), null);
});

test('lấy byte dữ liệu PID ở mọi định dạng', () => {
  assert.deepEqual(pidBytes(['410D3C'], 0x0d), [0x3c]);
  assert.deepEqual(pidBytes(['41 0D 3C'], '0D'), [0x3c]);
  assert.deepEqual(pidBytes(['410C1AF8', '410C1B00'], 0x0c), [0x1a, 0xf8]); // nhiều ECU: dòng đầu
  assert.deepEqual(pidBytes(['7E9 03 41 0D 3D', '7E8 03 41 0D 3C'], 0x0d), [0x3c]); // có header: ưu tiên 7E8
  assert.deepEqual(pidBytes(['7E803410D3C'], 0x0d), [0x3c]);
  assert.deepEqual(pidBytes(['18 DA F1 10 03 41 0D 3C'], 0x0d), [0x3c]);
  // Nhiều frame khi tắt header: dòng đầu là số byte.
  assert.deepEqual(pidBytes(['008', '0: 41 0C 1A F8 0D 3C', '1: 00 00 00 00 00 00 00'], 0x0c), [0x1a, 0xf8, 0x0d, 0x3c, 0, 0]);
  assert.equal(pidBytes(['NO DATA'], 0x0d), null);
  assert.equal(pidBytes(['410C1AF8'], 0x0d), null);
  assert.equal(pidBytes(['SEARCHING...'], 0x0d), null);
  assert.deepEqual(pidBytesAll(['4100BE1FA813', '410080000001'], 0x00), [[0xbe, 0x1f, 0xa8, 0x13], [0x80, 0, 0, 1]]);
  // ISO-TP nhiều frame khi bật header.
  const tp = parseMessages(['7E8 10 0A 43 04 01 33 01 34', '7E8 21 01 35 01 36 00 00 00']);
  assert.deepEqual(tp, [{ header: '7E8', bytes: [0x43, 4, 1, 0x33, 1, 0x34, 1, 0x35, 1, 0x36] }]);
});

test('giải mã PID, bảng PID hỗ trợ và điện áp ATRV', () => {
  assert.equal(decodePid(0x0d, [0x3c]), 60);
  assert.equal(decodePid('0C', [0x1a, 0xf8]), 1726);
  assert.equal(decodePid(0x05, [0x7b]), 83);
  assert.equal(decodePid(0x2f, [0xff]), 100);
  assert.equal(decodePid(0x42, [0x37, 0x78]), 14.2);
  assert.ok(Math.abs(decodePid(0x04, [0x80]) - 50.2) < 0.1);
  assert.equal(decodePid(0x11, [0]), 0);
  assert.equal(decodePid(0x5c, [0x82]), 90);
  assert.equal(decodePid(0x0c, [0x1a]), null);
  assert.equal(decodePid(0x0d, null), null);
  assert.equal(decodePid(0x99, [1]), null);

  assert.deepEqual([...parseSupported([0xbe, 0x1f, 0xa8, 0x13], 0x00)],
    [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20]);
  assert.deepEqual([...parseSupported([0x80, 0, 0, 1], 0x40)], [0x41, 0x60]);
  assert.equal(parseSupported([0x80], 0).size, 0);

  assert.equal(parseVoltage('12.3V'), 12.3);
  assert.equal(parseVoltage('12.3v'), 12.3);
  assert.equal(parseVoltage(' 14.1 V'), 14.1);
  assert.equal(parseVoltage(['OK', '13.9V']), 13.9);
  assert.equal(parseVoltage('?'), null);
  assert.equal(parseVoltage('V'), null);
  assert.equal(parseVoltage('123V'), null);
});

test('giải mã mã lỗi Mode 03: CAN một frame, nhiều frame, giao thức cũ', () => {
  assert.deepEqual(decodeDtcs(['43 01 01 33']), ['P0133']);
  assert.deepEqual(decodeDtcs(['4302 0133 C123']), ['P0133', 'U0123']);
  assert.deepEqual(decodeDtcs(['43 01 41 00']), ['C0100']);
  assert.deepEqual(decodeDtcs(['43 00']), []);
  assert.deepEqual(decodeDtcs(['00A', '0: 43 04 01 33 01 34', '1: 01 35 01 36 00 00 00']), ['P0133', 'P0134', 'P0135', 'P0136']);
  assert.deepEqual(decodeDtcs(['7E8 10 0A 43 04 01 33 01 34', '7E8 21 01 35 01 36 00 00 00']), ['P0133', 'P0134', 'P0135', 'P0136']);
  // Giao thức cũ: mỗi frame 43 + 3 cặp byte, đệm 0000, không có byte đếm.
  assert.deepEqual(decodeDtcs(['43 01 33 02 20 00 00', '43 81 05 00 00 00 00']), ['P0133', 'P0220', 'B0105']);
  assert.deepEqual(decodeDtcs(['43 01 01 33', '43 01 01 33']), ['P0133']); // hai ECU báo trùng
  assert.deepEqual(decodeDtcs(['NO DATA']), []);
});

// ---------------------------------------------------------------------------------------------
// ObdClient với bộ ELM327 giả

test('phiên đầy đủ: khởi tạo → dò giao thức → sẵn sàng → có tốc độ, vòng tua, nhiệt độ, điện áp', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(10000);
  assert.deepEqual(s.states.slice(0, 4), ['connecting', 'init', 'searching', 'ready']);
  assert.deepEqual(s.cmds().slice(0, 11), [...INIT_COMMANDS, '0100', '0120', '0140', 'ATRV']);
  const at = (cmd) => s.elm.commands.find((c) => c.cmd === cmd).t;
  assert.ok(at('ATZ') >= 400, 'chờ một chút sau khi mở kết nối');
  assert.ok(at('ATE0') - at('ATZ') >= 1000, 'sau ATZ chờ ít nhất 1 giây');

  const snap = s.snap;
  assert.equal(snap.speed, 60);
  assert.equal(snap.rpm, 1850);
  assert.equal(snap.coolant, 88);
  assert.ok(Math.abs(snap.fuel - 40) < 0.5);
  assert.equal(snap.voltage, 13.9);
  assert.equal(snap.adapter, 'ELM327 v1.5');
  assert.ok(snap.speedTime > 0);
  for (const p of [0x0d, 0x0c, 0x2f, 0x42, 0x5c]) assert.ok(s.client.supported.has(p), p.toString(16));
  assert.equal(s.client.state, 'ready');

  s.elm.speed = 72;
  await s.clock.advance(1000);
  assert.equal(s.snap.speed, 72);

  assertSafeWrites(s.elm.writes);
  assert.equal(s.elm.interrupted, 0, 'không bao giờ gửi lệnh khi bộ đọc đang bận');
  assert.equal(s.elm.bareCr, 0);
  assert.ok(!s.cmds().includes('03'), 'chỉ đọc mã lỗi khi người dùng yêu cầu');

  // Không quá 6 yêu cầu mỗi giây khi đọc định kỳ; tốc độ được hỏi khoảng 300 ms một lần.
  const readyAt = at('ATRV');
  const times = s.elm.commands.filter((c) => c.t > readyAt).map((c) => c.t);
  for (const t0 of times) assert.ok(times.filter((t) => t >= t0 && t < t0 + 1000).length <= 6, `quá tải ở ${t0}`);
  const speedPolls = s.elm.commands.filter((c) => c.cmd === '010D' && c.t > s.clock.t - 3000).length;
  assert.ok(speedPolls >= 8 && speedPolls <= 11, `tốc độ được hỏi ${speedPolls} lần trong 3 giây`);

  await s.client.stop();
  assert.equal(s.client.state, 'idle');
  const n = s.elm.writes.length;
  await s.clock.advance(5000);
  assert.equal(s.elm.writes.length, n, 'đã ngắt thì không gửi gì nữa');
});

test('PID báo NO DATA 3 lần liên tiếp thì bỏ, các PID khác vẫn chạy', async () => {
  const s = setup({ noData: [0x0c] });
  s.client.start();
  await s.clock.advance(20000);
  assert.equal(s.count('010C'), 3);
  assert.equal(s.snap.rpm, null);
  assert.equal(s.snap.speed, 60);
  assert.equal(s.client.state, 'ready');
});

test("'UNABLE TO CONNECT' (chưa bật khoá điện) → trạng thái nocar, thử lại 0100 mỗi 8 giây", async () => {
  const s = setup();
  s.elm.carOff = true;
  s.client.start();
  await s.clock.advance(6000);
  assert.equal(s.client.state, 'nocar');
  assert.equal(s.infos[s.states.indexOf('nocar')].reason, 'unable');
  await s.clock.advance(20000);
  const tries = s.elm.commands.filter((c) => c.cmd === '0100').map((c) => c.t);
  assert.ok(tries.length >= 2);
  for (let i = 1; i < tries.length; i++) assert.ok(tries[i] - tries[i - 1] >= 8000);
  assert.ok(!s.cmds().some((c) => /^01(?!00)/.test(c)), 'chưa thấy xe thì không hỏi PID nào khác');

  s.elm.carOff = false;
  await s.clock.advance(15000);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 60);
});

test('tắt máy giữa chừng: mọi PID im lặng → nocar, nổ máy lại → đọc tiếp, không bỏ PID tốc độ', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  s.elm.carOff = true;
  await s.clock.advance(3000);
  assert.equal(s.client.state, 'nocar');
  assert.equal(s.infos[s.states.lastIndexOf('nocar')].reason, 'nodata');
  s.elm.carOff = false;
  s.elm.speed = 35;
  await s.clock.advance(12000);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 35);
  assertSafeWrites(s.elm.writes);
});

test("quá hạn khi bộ đọc đang bận: gửi 'X' (không CR), nhận STOPPED rồi chạy tiếp", async () => {
  const s = setup();
  s.elm.stallOnce = '010C';
  s.client.start();
  await s.clock.advance(12000);
  assert.ok(s.elm.writes.includes('X'));
  assert.ok(!s.elm.writes.includes('\r'), 'bộ đọc đã trả STOPPED thì không gửi CR');
  assert.equal(s.elm.interrupted, 1);
  assert.equal(s.elm.bareCr, 0);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.rpm, 1850);
  assertSafeWrites(s.elm.writes);
});

test("quá hạn khi bộ đọc rảnh (mất câu trả lời): 'X', chờ 500 ms, rồi mới gửi CR", async () => {
  const s = setup();
  s.elm.dropOnce = '0105';
  s.client.start();
  await s.clock.advance(12000);
  const i = s.elm.writes.indexOf('X');
  assert.ok(i > 0);
  assert.equal(s.elm.writes[i + 1], '\r');
  assert.ok(s.elm.writeLog[i + 1].t - s.elm.writeLog[i].t >= 500);
  assert.equal(s.elm.writes.filter((w) => w === '\r').length, 1);
  assert.equal(s.elm.bareCr, 0, 'CR chỉ kết thúc lệnh giả X, không làm bộ đọc chạy lại lệnh cũ');
  const crAt = s.elm.writeLog[i + 1].t;
  assert.ok(s.elm.commands.filter((c) => c.cmd === '010D' && c.t > crAt).length > 3);
  assert.equal(s.client.state, 'ready');
  assertSafeWrites(s.elm.writes);
});

test('bộ đọc im hẳn: X, CR, vẫn im → kết nối lại và khởi tạo lại', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  s.elm.dead = true;
  await s.clock.advance(16000);
  const k = s.states.indexOf('lost');
  assert.ok(k > 0);
  assert.deepEqual(s.infos[k], { attempt: 1, delay: RECONNECT_DELAYS[0] });
  assert.deepEqual(s.states.slice(k), ['lost', 'connecting', 'init', 'searching', 'ready']);
  assert.equal(s.elm.connects, 2);
  assert.ok(s.elm.disconnects >= 1);
  assert.equal(s.snap.speed, 60);
  assertSafeWrites(s.elm.writes);
});

test('mất Bluetooth: thử lại sau 2, 5, 10, 20, 30 giây rồi bỏ cuộc', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  s.elm.refuse = true;
  s.elm.drop();
  await s.clock.advance(80000);
  const delays = s.infos.filter((_, i) => s.states[i] === 'lost').map((x) => x.delay);
  assert.deepEqual(delays, [2000, 5000, 10000, 20000, 30000]);
  assert.equal(s.client.state, 'error');
  assert.match(s.infos.at(-1).message, /Mất kết nối với bộ OBD/);
  assert.equal(s.elm.connects, 6);
});

test('không kết nối được ngay lần đầu thì báo lỗi luôn', async () => {
  const s = setup();
  s.elm.refuse = true;
  s.client.start();
  await s.clock.advance(1000);
  assert.equal(s.client.state, 'error');
  assert.match(s.infos.at(-1).message, /Không kết nối được với bộ OBD/);
  assert.equal(s.elm.connects, 1);
});

test('thiết bị không phải ELM327 (ví dụ máy in Bluetooth) → báo lỗi, không gửi lệnh OBD', async () => {
  const s = setup({ id: 'PRINTER READY', ati: '?' });
  s.client.start();
  await s.clock.advance(10000);
  assert.equal(s.client.state, 'error');
  assert.equal(s.infos.at(-1).message, 'Thiết bị này không phải bộ đọc OBD (ELM327).');
  assert.deepEqual(s.cmds(), ['ATZ', 'ATI']);
  assert.ok(!s.elm.writes.some((w) => w.startsWith('01') || w.startsWith('03')));
});

test('LV RESET (sụt áp khi đề máy) → ATFE rồi khởi tạo lại toàn bộ', async () => {
  const s = setup();
  s.elm.lvResetOnce = '010C';
  s.client.start();
  await s.clock.advance(15000);
  const list = s.cmds();
  const k = list.indexOf('010C');
  assert.deepEqual(list.slice(k + 1, k + 10), ['ATFE', ...INIT_COMMANDS, '0100']);
  assert.equal(s.elm.feCount, 1);
  assert.equal(s.states.filter((x) => x === 'ready').length, 2);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.rpm, 1850);
  assertSafeWrites(s.elm.writes);
});

test('LV RESET không kèm dấu nhắc: quá hạn, chuỗi ngắt vẫn nhận ra và gửi ATFE', async () => {
  const s = setup();
  s.elm.lvResetSilentOnce = '010C';
  s.client.start();
  await s.clock.advance(16000);
  const list = s.cmds();
  const k = list.indexOf('010C');
  assert.deepEqual(list.slice(k + 1, k + 4), ['X', 'ATFE', 'ATZ']); // 'X' là lệnh giả kết thúc bằng CR
  assert.equal(s.elm.feCount, 1);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.rpm, 1850);
  assertSafeWrites(s.elm.writes);
});

test('ERR94 (lỗi CAN nặng) → ATFE rồi khởi tạo lại', async () => {
  const s = setup();
  s.elm.err94Once = '010D';
  s.client.start();
  await s.clock.advance(15000);
  const list = s.cmds();
  const k = list.indexOf('010D');
  assert.deepEqual(list.slice(k + 1, k + 3), ['ATFE', 'ATZ']);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 60);
});

test('LV RESET tự xuất hiện khi không có lệnh nào đang chờ cũng được nhận ra', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  s.elm.spontaneous(['LV RESET']);
  await s.clock.advance(10000);
  assert.equal(s.elm.feCount, 1);
  assert.equal(s.states.filter((x) => x === 'ready').length, 2);
  assert.equal(s.client.state, 'ready');
});

test('bộ đọc không có ATRV (trả ?) → đọc điện áp bằng PID 0142', async () => {
  const s = setup({ atrv: '?' });
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.count('ATRV'), 1);
  assert.ok(s.count('0142') >= 1);
  assert.equal(s.snap.voltage, 14.2);
});

test('tạm dừng khi trang bị ẩn: không gửi lệnh nào, bật lại thì đọc tiếp', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  s.client.setPaused(true);
  const n = s.elm.writes.length;
  await s.clock.advance(10000);
  assert.equal(s.elm.writes.length, n);
  s.client.setPaused(false);
  await s.clock.advance(1000);
  assert.ok(s.elm.writes.length > n);
});

test('đọc mã lỗi (Mode 03) chỉ khi được yêu cầu và khi đã kết nối với xe', async () => {
  const s = setup({ dtcLines: ['00A', '0: 43 04 01 33 01 34', '1: 01 35 01 36 00 00 00'] });
  await assert.rejects(s.client.readDtcs(), /Chưa kết nối được với xe/);
  s.client.start();
  await s.clock.advance(8000);
  const p = s.client.readDtcs();
  p.catch(() => {});
  await s.clock.advance(1000);
  assert.deepEqual(await p, ['P0133', 'P0134', 'P0135', 'P0136']);
  assert.equal(s.count('03'), 1);
  assert.equal(s.elm.interrupted, 0);
  assertSafeWrites(s.elm.writes);
});

// ---------------------------------------------------------------------------------------------
// CarWatch

test('CarWatch: nước làm mát ≥ 110 °C liên tục 10 giây thì nhắc, mỗi chuyến một lần', () => {
  const w = new CarWatch();
  assert.equal(w.update({ coolant: 112 }, 0).say, null);
  assert.equal(w.update({ coolant: 112 }, 9000).say, null);
  assert.equal(w.update({ coolant: 113 }, 10000).say, CAR_MESSAGES.coolant);
  assert.equal(w.update({ coolant: 113 }, 20000).say, null);
  w.update({ coolant: 95 }, 21000);
  w.update({ coolant: 112 }, 22000);
  assert.equal(w.update({ coolant: 112 }, 40000).say, null, 'đã nhắc trong chuyến này');
  w.reset();
  w.update({ coolant: 112 }, 50000);
  assert.equal(w.update({ coolant: 112 }, 60000).say, CAR_MESSAGES.coolant);

  const spike = new CarWatch();
  spike.update({ coolant: 111 }, 0);
  spike.update({ coolant: 105 }, 5000);
  assert.equal(spike.update({ coolant: 111 }, 12000).say, null, 'nóng chưa đủ 10 giây liên tục');
  assert.equal(new CarWatch().update({ coolant: null }, 99999).say, null);
});

test('CarWatch: điện áp dưới 12 V liên tục 30 giây khi máy đang chạy thì nhắc một lần', () => {
  const w = new CarWatch();
  w.update({ voltage: 11.8, rpm: 800 }, 0);
  assert.equal(w.update({ voltage: 11.8, rpm: 800 }, 29000).say, null);
  assert.equal(w.update({ voltage: 11.7, rpm: 800 }, 30000).say, CAR_MESSAGES.battery);
  assert.equal(w.update({ voltage: 11.7, rpm: 800 }, 70000).say, null);

  const off = new CarWatch();
  off.update({ voltage: 11.8, rpm: 0 }, 0);
  assert.equal(off.update({ voltage: 11.8, rpm: 0 }, 60000).say, null, 'tắt máy thì không nhắc');
  const fine = new CarWatch();
  fine.update({ voltage: 12.0, rpm: 900 }, 0);
  assert.equal(fine.update({ voltage: 12.0, rpm: 900 }, 60000).say, null);

  const both = new CarWatch();
  both.update({ coolant: 115, voltage: 11.5, rpm: 900 }, 0);
  assert.equal(both.update({ coolant: 115, voltage: 11.5, rpm: 900 }, 30000).say, CAR_MESSAGES.coolant);
  assert.equal(both.update({ coolant: 115, voltage: 11.5, rpm: 900 }, 30500).say, CAR_MESSAGES.battery);
});

// ---------------------------------------------------------------------------------------------
// Trình duyệt và Bluetooth

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

test('nhận biết trình duyệt có dùng được Bluetooth hay không', () => {
  const env = (ua, nav = {}, extra = {}) => ({ isSecureContext: true, navigator: { userAgent: ua, ...nav }, ...extra });
  assert.deepEqual(detectSupport(env(CHROME_ANDROID, { bluetooth: {}, serial: {} })), { ble: true, serial: true, secure: true, reason: null });
  assert.equal(detectSupport({ isSecureContext: false, navigator: { userAgent: CHROME_ANDROID } }).reason, 'insecure');
  const zalo = 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Zalo android/12100';
  assert.equal(detectSupport(env(zalo)).reason, 'webview');
  const fb = `${CHROME_ANDROID} [FBAN/EMA;FBLC/vi_VN;FBAV/400.0.0.0;]`;
  assert.equal(detectSupport(env(fb)).reason, 'webview');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.equal(detectSupport(env(iphone)).reason, 'ios');
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  assert.equal(detectSupport(env(ipad, { maxTouchPoints: 5 })).reason, 'ios');
  const firefox = 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0';
  assert.equal(detectSupport(env(firefox)).reason, 'firefox');
  const ffDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';
  assert.equal(detectSupport(env(ffDesktop, { serial: {} })).serial, false, 'Web Serial của Firefox không có Bluetooth');
  assert.equal(detectSupport({ location: { protocol: 'http:', hostname: 'localhost' }, navigator: { userAgent: CHROME_ANDROID, bluetooth: {} } }).ble, true);
  assert.equal(detectSupport({}).ble, false);
});

test('hộp chọn thiết bị được mở đồng bộ, đúng bộ lọc và danh sách service', async () => {
  assert.notEqual(requestBleDevice.constructor.name, 'AsyncFunction');
  const calls = [];
  const nav = { bluetooth: { requestDevice: (o) => { calls.push(o); return new Promise(() => {}); } } };
  requestBleDevice(false, nav);
  assert.equal(calls.length, 1, 'requestDevice phải được gọi ngay, không qua await nào');
  const o = calls[0];
  assert.equal('acceptAllDevices' in o, false);
  for (const svc of [0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2']) {
    assert.ok(o.filters.some((f) => f.services?.[0] === svc), String(svc));
  }
  for (const name of ['OBD', 'OBDII', 'ELM327', 'V-LINK', 'IOS-Vlink', 'vLinker', 'VEEPEAK', 'OBDLink', 'Vgate']) {
    assert.ok(o.filters.some((f) => f.namePrefix === name), name);
  }
  assert.ok(o.filters.every((f) => f.services || f.namePrefix));
  assert.deepEqual(o.optionalServices, BLE_SERVICES);
  assert.equal(o.optionalServices.length, 13);

  requestBleDevice(true, nav);
  assert.equal(calls[1].acceptAllDevices, true);
  assert.equal('filters' in calls[1], false);
  assert.deepEqual(calls[1].optionalServices, BLE_SERVICES);
  await assert.rejects(requestBleDevice(false, {}), /không hỗ trợ Bluetooth/);

  const ports = [];
  requestSerialPort({ serial: { requestPort: (o2) => { ports.push(o2); return new Promise(() => {}); } } });
  assert.deepEqual(ports, [{ filters: [{ bluetoothServiceClassId: SPP_UUID }] }]);
  assert.match(describeConnectError({ name: 'NotFoundError' }), /Hiện mọi thiết bị/);
});

function fakeServer(map) {
  const calls = [];
  return {
    calls,
    async getPrimaryService(uuid) {
      calls.push(uuid);
      const chars = map[uuid];
      if (!chars) throw Object.assign(new Error('không có service'), { name: 'NotFoundError' });
      return {
        async getCharacteristics() {
          return chars.map((c) => (Array.isArray(c) ? { uuid: c[0], properties: c[1] } : c));
        },
      };
    },
  };
}

test('chọn đặc tính BLE: cặp đã biết trước, theo thuộc tính sau, chỉ trong service được phép', async () => {
  const N = { notify: true };
  const W = { write: true };
  const WNR = { writeWithoutResponse: true };
  let r = await chooseCharacteristics(fakeServer({ [U(0xfff0)]: [[U(0xfff1), N], [U(0xfff2), WNR]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid, r.how], [U(0xfff1), U(0xfff2), 'known']);

  r = await chooseCharacteristics(fakeServer({ [U(0xffe0)]: [[U(0xffe1), { notify: true, writeWithoutResponse: true }]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid], [U(0xffe1), U(0xffe1)]);
  r = await chooseCharacteristics(fakeServer({ [U(0xffe0)]: [[U(0xffe1), { notify: true, write: true }], [U(0xffe2), W]] }));
  assert.equal(r.tx.uuid, U(0xffe2));
  r = await chooseCharacteristics(fakeServer({ [U(0xffe0)]: [[U(0xffe1), { notify: true, write: true }], [U(0xffe2), { read: true }]] }));
  assert.equal(r.tx.uuid, U(0xffe1));

  r = await chooseCharacteristics(fakeServer({ [U(0x18f0)]: [[U(0x2af0), N], [U(0x2af1), W]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid], [U(0x2af0), U(0x2af1)]);
  const vl = 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f';
  r = await chooseCharacteristics(fakeServer({ 'e7810a71-73ae-499d-8c15-faa9aef0c3f2': [[vl, { notify: true, write: true }]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid, r.how], [vl, vl, 'known']);

  // Có lô OBDLink CX bị đảo vai trò FFF1/FFF2: chọn theo thuộc tính.
  r = await chooseCharacteristics(fakeServer({ [U(0xfff0)]: [[U(0xfff1), W], [U(0xfff2), N]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid, r.how], [U(0xfff2), U(0xfff1), 'properties']);
  r = await chooseCharacteristics(fakeServer({ [U(0xbeef)]: [[U(0xbe01), N], [U(0xbe02), WNR]] }));
  assert.deepEqual([r.rx.uuid, r.tx.uuid, r.how], [U(0xbe01), U(0xbe02), 'properties']);

  const other = fakeServer({ [U(0xabcd)]: [[U(0xab01), { notify: true, write: true }]] });
  await assert.rejects(chooseCharacteristics(other), /Không tìm thấy kênh dữ liệu/);
  const allowed = new Set(BLE_SERVICES.map((x) => (typeof x === 'number' ? U(x) : x)));
  assert.ok(other.calls.length > 0 && other.calls.every((u) => allowed.has(u)));
  assert.ok(!other.calls.includes(U(0xabcd)));
});

test('transport BLE: bật notify, ghi tuần tự từng gói ≤ 20 byte, báo mất kết nối', async () => {
  const log = [];
  let active = 0;
  let overlap = false;
  const listeners = {};
  const rx = {
    uuid: U(0xfff1),
    properties: { notify: true },
    fns: new Set(),
    addEventListener(_, f) { this.fns.add(f); },
    removeEventListener(_, f) { this.fns.delete(f); },
    async startNotifications() { log.push('start'); },
    async stopNotifications() { log.push('stop'); },
  };
  const tx = {
    uuid: U(0xfff2),
    properties: { write: true, writeWithoutResponse: true },
    async writeValueWithResponse(v) {
      if (++active > 1) overlap = true;
      log.push(['ghi', v.length]);
      await flush();
      active--;
    },
    async writeValueWithoutResponse() { log.push('không chờ'); },
  };
  const server = fakeServer({ [U(0xfff0)]: [rx, tx] });
  const device = {
    name: 'OBDII',
    gatt: { connected: false, async connect() { this.connected = true; return server; }, disconnect() { this.connected = false; } },
    addEventListener(t, f) { (listeners[t] ||= new Set()).add(f); },
    removeEventListener(t, f) { listeners[t]?.delete(f); },
  };
  const fire = (t) => { for (const f of [...(listeners[t] || [])]) f({}); };

  const tr = createBleTransport(device);
  assert.equal(tr.kind, 'ble');
  assert.equal(tr.name, 'OBDII');
  const got = [];
  let closed = 0;
  await tr.connect({ onData: (t) => got.push(t), onClose: () => closed++ });
  assert.deepEqual(log, ['start']);
  await Promise.all([tr.write('A'.repeat(45)), tr.write('010D\r')]);
  assert.deepEqual(log.slice(1).map((x) => x[1]), [20, 20, 5, 5]);
  assert.equal(overlap, false);
  for (const f of rx.fns) f({ target: { value: new DataView(new TextEncoder().encode('410D3C\r>').buffer) } });
  assert.equal(got.join(''), '410D3C\r>');
  fire('gattserverdisconnected');
  assert.equal(closed, 1);
  await tr.connect({ onData: (t) => got.push(t), onClose: () => closed++ }); // kết nối lại không cần hộp chọn
  await tr.disconnect();
  fire('gattserverdisconnected');
  assert.equal(closed, 1, 'tự ngắt thì không báo mất kết nối');
  assert.equal(device.gatt.connected, false);
});

test('transport Web Serial: mở cổng 38400, đọc liên tục, lỗi đọc thì báo mất kết nối', async () => {
  const makePort = () => {
    const port = {
      opened: null,
      readable: null,
      writable: null,
      controller: null,
      written: [],
      async open(o) {
        this.opened = o;
        this.readable = new ReadableStream({ start: (c) => { this.controller = c; } });
        this.writable = new WritableStream({ write: (chunk) => { this.written.push(new TextDecoder().decode(chunk)); } });
      },
      async close() {
        this.readable = this.writable = null;
      },
    };
    return port;
  };
  const port = makePort();
  const tr = createSerialTransport(port);
  const got = [];
  let closed = 0;
  await tr.connect({ onData: (t) => got.push(t), onClose: () => closed++ });
  assert.deepEqual(port.opened, { baudRate: 38400 });
  await tr.write('ATZ\r');
  assert.deepEqual(port.written, ['ATZ\r']);
  port.controller.enqueue(new TextEncoder().encode('ELM327 v1.5\r\r>'));
  await flush();
  assert.equal(got.join(''), 'ELM327 v1.5\r\r>');
  port.controller.error(new Error('mất cổng'));
  await flush();
  await flush();
  assert.equal(closed, 1);

  const port2 = makePort();
  const tr2 = createSerialTransport(port2);
  let closed2 = 0;
  await tr2.connect({ onData() {}, onClose: () => closed2++ });
  await tr2.disconnect();
  await flush();
  assert.equal(closed2, 0, 'tự ngắt thì không báo mất kết nối');
  assert.equal(port2.readable, null);

  // Mở lại cổng đã cấp quyền: ưu tiên cổng Bluetooth SPP.
  const usb = { ...makePort(), getInfo: () => ({ usbVendorId: 1 }) };
  const spp = { ...makePort(), getInfo: () => ({ bluetoothServiceClassId: SPP_UUID }) };
  const t3 = await reopenSerial({ serial: { getPorts: async () => [usb, spp] } });
  assert.equal(t3.kind, 'serial');
  await t3.connect({ onData() {}, onClose() {} });
  assert.deepEqual(spp.opened, { baudRate: 38400 });
  assert.equal(usb.opened, null);
  await t3.disconnect();
  assert.equal(await reopenSerial({ serial: { getPorts: async () => [] } }), null);
  assert.equal(await reopenSerial({}), null);
});
