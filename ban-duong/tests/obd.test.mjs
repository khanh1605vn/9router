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
  describeCarState,
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
    this.override = null; // (cmd) → câu trả lời thay thế, hoặc null
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
    const forced = this.override?.(cmd);
    if (forced) return forced;
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

test('PID báo NO DATA 3 lần liên tiếp thì thôi đọc theo lịch (chỉ thử lại mỗi 15 giây), các PID khác vẫn chạy', async () => {
  const s = setup({ noData: [0x0c] });
  s.client.start();
  await s.clock.advance(20000);
  assert.equal(s.count('010C'), 3);
  assert.equal(s.snap.rpm, null);
  assert.equal(s.snap.speed, 60);
  assert.equal(s.client.state, 'ready');
  // Thử lại thưa: không quá một lần mỗi 15 giây.
  const n = s.count('010C');
  await s.clock.advance(60000);
  const retries = s.count('010C') - n;
  assert.ok(retries >= 3 && retries <= 4, `010C được thử lại ${retries} lần trong 60 giây`);
  assert.equal(s.snap.rpm, null);
  assert.equal(s.client.state, 'ready');
  // PID đó có số liệu trở lại thì được đọc tiếp theo lịch.
  s.elm.noData.delete(0x0c);
  s.elm.rpm = 900;
  await s.clock.advance(16000);
  assert.equal(s.snap.rpm, 900);
  const m = s.count('010C');
  await s.clock.advance(3000);
  assert.ok(s.count('010C') - m >= 2, 'vòng tua được đọc lại mỗi giây');
  assert.ok(maxBusPerSecond(s.elm.commands) <= 6);
});

test('xe im ngay khi vừa sẵn sàng, trước khi PID nào kịp trả lời (đề máy, tắt máy): xe trả lời lại thì đọc lại tốc độ và vòng tua', async () => {
  // offFor: xe im bao lâu (đề máy ngay sau khi kết nối thì khoảng 1–2 giây; tắt máy thì vài phút).
  for (const offFor of [1500, 4000, 5 * 60 * 1000]) {
    const s = setup();
    let armed = false;
    s.client.onState((st) => {
      if (st === 'ready' && !armed) {
        armed = true;
        s.elm.carOff = true;
        s.clock.setTimeout(() => {
          s.elm.carOff = false;
          Object.assign(s.elm, { speed: 30, rpm: 900 });
        }, offFor);
      }
    });
    s.client.start();
    await s.clock.advance(6000 + offFor);
    assert.ok(armed);
    assert.equal(s.elm.carOff, false);
    await s.clock.advance(17000); // PID chưa từng trả lời được thử lại sau 15 giây
    assert.equal(s.snap.speed, 30, `xe im ${offFor} ms: không đọc lại tốc độ`);
    assert.equal(s.snap.rpm, 900, `xe im ${offFor} ms: không đọc lại vòng tua`);
    assert.ok(s.clock.t - s.snap.speedTime < 1000, `xe im ${offFor} ms: tốc độ không được đọc theo lịch`);
    assert.equal(s.client.state, 'ready');
    assert.ok(maxBusPerSecond(s.elm.commands) <= 6);
    assertSafeWrites(s.elm.writes);
  }
});

test('xe báo hỗ trợ 0D, 0C, 05, 2F mà cả bốn luôn NO DATA (0100 vẫn trả lời): ở ready với điện áp, không đổi qua lại ready ↔ nocar', async () => {
  const s = setup({ noData: [0x0d, 0x0c, 0x05, 0x2f] });
  s.client.start();
  await s.clock.advance(300000);
  assert.deepEqual(s.states, ['connecting', 'init', 'searching', 'ready']);
  assert.equal(s.snap.voltage, 13.9);
  // Chỉ thử lại thưa: mỗi PID tối đa một lần mỗi 15 giây trong phút cuối.
  const lastMinute = s.elm.commands.filter((c) => /^01/.test(c.cmd) && c.t > s.clock.t - 60000).length;
  assert.ok(lastMinute <= 4 * 4 + 1, `${lastMinute} câu hỏi Mode 01 trong một phút`);
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

test('bộ đọc trả lời ATZ nhưng mất kết nối mỗi lần hỏi xe: vẫn chờ 2, 5, 10, 20, 30 giây rồi bỏ cuộc', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  s.elm.override = (cmd) => {
    if (cmd !== '0100') return null;
    queueMicrotask(() => s.elm.drop()); // Bluetooth rớt đúng lúc hỏi xe
    return { drop: true };
  };
  s.elm.drop();
  await s.clock.advance(150000);
  const delays = s.infos.filter((_, i) => s.states[i] === 'lost').map((x) => x.delay);
  assert.deepEqual(delays, RECONNECT_DELAYS);
  assert.equal(s.client.state, 'error');
  assert.equal(s.infos.at(-1).message, 'Mất kết nối với bộ OBD. Hãy bấm kết nối lại.');
  assert.equal(s.elm.connects, 1 + RECONNECT_DELAYS.length);
  const n = s.elm.connects;
  await s.clock.advance(120000);
  assert.equal(s.elm.connects, n, 'đã bỏ cuộc thì không kết nối lại nữa');
});

test('mất kết nối thỉnh thoảng mà kết nối lại được (đang lái, hoặc đỗ xe tắt máy): không bỏ cuộc, lần nào cũng chờ 2 giây', async () => {
  // Đang lái: mất kết nối mỗi 20 giây, mỗi lần nối lại đều đọc được xe.
  const drive = setup();
  drive.client.start();
  await drive.clock.advance(8000);
  for (let k = 0; k < 8; k++) {
    drive.elm.drop();
    await drive.clock.advance(20000);
    assert.equal(drive.client.state, 'ready', `lần mất kết nối thứ ${k + 1}`);
  }
  const driveDelays = drive.infos.filter((_, i) => drive.states[i] === 'lost').map((x) => x.delay);
  assert.deepEqual(driveDelays, Array(8).fill(RECONNECT_DELAYS[0]));
  assert.equal(drive.snap.speed, 60);

  // Đỗ xe tắt khoá điện ('nocar'): mất kết nối mỗi 3 phút; xe không trả lời nhưng kết nối đứng được lâu.
  const parked = setup();
  parked.elm.carOff = true;
  parked.client.start();
  await parked.clock.advance(12000);
  for (let k = 0; k < 8; k++) {
    await parked.clock.advance(180000);
    parked.elm.drop();
  }
  await parked.clock.advance(15000);
  assert.equal(parked.client.state, 'nocar');
  const parkedDelays = parked.infos.filter((_, i) => parked.states[i] === 'lost').map((x) => x.delay);
  assert.deepEqual(parkedDelays, Array(8).fill(RECONNECT_DELAYS[0]));
  parked.elm.carOff = false;
  await parked.clock.advance(30000);
  assert.equal(parked.client.state, 'ready', 'bật khoá điện thì đọc được xe');
  assert.equal(parked.snap.speed, 60);
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

test('LV RESET tự đến ngay sau câu trả lời ATZ (trước ATE0) không bị bỏ qua: ATFE rồi khởi tạo lại', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(1150); // ATZ gửi lúc 400 ms, trả lời lúc ~1000 ms; ATE0 chưa gửi trước 1400 ms
  assert.deepEqual(s.cmds(), ['ATZ']);
  s.elm.spontaneous(['LV RESET']); // đề máy đúng lúc này: chip sụt áp, chặn dò CAN tới khi có ATFE
  await s.clock.advance(8000);
  assert.deepEqual(s.cmds().slice(0, 4), ['ATZ', 'ATFE', 'ATZ', 'ATE0']);
  assert.equal(s.elm.feCount, 1);
  assert.ok(!s.states.includes('nocar'), 'không được kẹt ở trạng thái chưa thấy xe');
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 60);
  assertSafeWrites(s.elm.writes);
});

test('LV RESET thay cho câu trả lời ATZ ở lần kết nối đầu → ATFE rồi ATZ lại, không báo lỗi', async () => {
  const s = setup();
  s.elm.lvResetOnce = 'ATZ';
  s.client.start();
  await s.clock.advance(10000);
  assert.deepEqual(s.cmds().slice(0, 5), ['ATZ', 'ATI', 'ATFE', 'ATZ', 'ATE0']);
  assert.equal(s.elm.feCount, 1);
  assert.ok(!s.states.includes('nocar') && !s.states.includes('error'));
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.adapter, 'ELM327 v1.5');
});

test('LV RESET ở bất kỳ lúc nào trong khoảng ATZ (400–1400 ms) đều dẫn tới ATFE và đọc được xe', async () => {
  for (let t = 400; t <= 1400; t += 50) {
    const s = setup();
    s.client.start();
    await s.clock.advance(t);
    s.elm.spontaneous(['LV RESET']);
    await s.clock.advance(12000);
    assert.equal(s.client.state, 'ready', `LV RESET lúc ${t} ms`);
    assert.ok(s.elm.feCount >= 1, `LV RESET lúc ${t} ms: chưa gửi ATFE`);
    assert.ok(!s.states.includes('nocar'), `LV RESET lúc ${t} ms: kẹt ở nocar`);
  }
});

test('LV RESET thay cho câu trả lời ATFE (sụt áp lần hai) → sau ATZ lại ATFE, không kẹt ở nocar', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  const n = s.elm.commands.length;
  s.elm.lvResetOnce = 'ATFE';
  s.elm.spontaneous(['LV RESET']);
  await s.clock.advance(10000);
  const list = s.cmds().slice(n);
  assert.deepEqual(list.slice(0, 4), ['ATFE', 'ATZ', 'ATFE', 'ATZ']);
  assert.ok(!s.states.slice(s.states.indexOf('ready')).includes('nocar'), 'không được kẹt ở trạng thái chưa thấy xe');
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 60);
});

test('hai lần sụt áp liên tiếp khi đề máy (lần sau rơi vào lúc khởi tạo lại) vẫn đọc lại được xe', async () => {
  for (const gap of [50, 200, 400, 600, 800, 1000, 1100, 1300, 2000]) {
    const s = setup();
    s.client.start();
    await s.clock.advance(8000);
    assert.equal(s.client.state, 'ready');
    s.elm.spontaneous(['LV RESET']);
    await s.clock.advance(gap);
    s.elm.spontaneous(['LV RESET']);
    await s.clock.advance(30000);
    assert.equal(s.client.state, 'ready', `cách nhau ${gap} ms`);
    assert.equal(s.snap.speed, 60);
  }
});

test("dò CAN bị chặn mà ứng dụng không thấy 'LV RESET' → 'UNABLE TO CONNECT', lần thử sau gửi ATFE trước 0100", async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(100);
  // Bộ ELM327 giả chỉ bỏ chặn khi có ATFE (ATZ không bỏ chặn), như trường hợp xấu nhất.
  s.elm.canBlocked = true;
  await s.clock.advance(6000);
  assert.equal(s.client.state, 'nocar');
  assert.equal(s.infos[s.states.indexOf('nocar')].reason, 'unable');
  assert.equal(s.elm.feCount, 0);
  await s.clock.advance(15000);
  const list = s.cmds();
  const k = list.indexOf('ATFE');
  assert.ok(k > list.indexOf('0100'), 'phải gửi ATFE khi thử lại sau UNABLE TO CONNECT');
  assert.equal(list[k + 1], '0100');
  assert.equal(s.elm.feCount, 1);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.speed, 60);
  assertSafeWrites(s.elm.writes);
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

const CAR_KEYS = ['speed', 'rpm', 'coolant', 'fuel', 'voltage'];

test('lỗi đường truyền khi đang đọc (CAN ERROR, BUS ERROR…) → nocar, xoá số liệu, gửi lại ATSP0 rồi 0100, xe trả lời lại thì đọc tiếp', async () => {
  for (const line of ['CAN ERROR', 'BUS ERROR', '<RX ERROR', 'FB ERROR', 'BUS INIT: ...ERROR']) {
    const s = setup();
    s.client.start();
    await s.clock.advance(8000);
    assert.equal(s.client.state, 'ready', line);
    const n = s.elm.commands.length;
    s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: [line] } : null);
    await s.clock.advance(3000);
    assert.equal(s.client.state, 'nocar', `${line}: vẫn ở trạng thái đã kết nối với xe`);
    assert.equal(s.infos.at(-1).reason, 'error', line);
    const snap = s.client.snapshot;
    for (const k of CAR_KEYS) assert.equal(snap[k], null, `${line}: còn giữ ${k} cũ`);
    await s.clock.advance(9000);
    const list = s.cmds().slice(n);
    const k = list.indexOf('ATSP0');
    assert.ok(k > 0, `${line}: phải gửi lại ATSP0`);
    assert.equal(list[k + 1], '0100', line);
    assert.ok(!list.slice(0, k).includes('0100'), `${line}: ATSP0 phải đi trước lần thử 0100 đầu tiên`);

    s.elm.override = null;
    s.elm.speed = 42;
    await s.clock.advance(15000);
    assert.equal(s.client.state, 'ready', line);
    assert.equal(s.snap.speed, 42, line);
    assert.equal(s.elm.interrupted, 0);
    assertSafeWrites(s.elm.writes);
  }
});

test('lỗi đường truyền ngay khi vừa sẵn sàng (chưa PID nào kịp trả lời) cũng đưa về nocar, không kẹt ở ready', async () => {
  const s = setup();
  let armed = false;
  s.client.onState((st) => {
    if (st === 'ready' && !armed) {
      armed = true; // lỗi bắt đầu đúng lúc 0100 vừa trả lời xong
      s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: ['CAN ERROR'] } : null);
    }
  });
  s.client.start();
  await s.clock.advance(12000);
  assert.ok(armed);
  assert.equal(s.client.state, 'nocar');
  assert.equal(s.infos.at(-1).reason, 'error');
  assert.equal(s.snap?.rpm ?? null, null);
});

test('tắt máy mà các PID báo CAN ERROR, ATRV vẫn đọc 11,9 V: không nhắc ắc quy theo vòng tua cũ', async () => {
  const s = setup();
  const watch = new CarWatch();
  const said = [];
  s.client.onData((snap) => {
    const w = watch.update(snap, s.clock.t).say;
    if (w) said.push(w);
  });
  s.client.start();
  await s.clock.advance(10000);
  assert.equal(s.client.state, 'ready');
  s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: ['CAN ERROR'] } : null);
  s.elm.atrv = '11.9V';
  await s.clock.advance(120000);
  assert.deepEqual(said, []);
  assert.equal(s.client.state, 'nocar');
});

test('một PID thôi trả lời trong khi PID khác vẫn chạy: số cũ bị xoá khỏi snapshot sau 5 giây, có số mới thì hiện lại', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.snap.rpm, 1850);
  for (const k of CAR_KEYS) assert.ok(s.snap[`${k}Time`] > 0, `${k}Time`);
  s.elm.noData.add(0x0c);
  await s.clock.advance(1500);
  const last = s.client.snapshot.rpmTime;
  await s.clock.advance(last + 4500 - s.clock.t);
  assert.equal(s.snap.rpm, 1850, 'chưa quá cũ');
  await s.clock.advance(1000);
  assert.equal(s.snap.rpm, null, 'vòng tua cũ vẫn còn trong snapshot');
  assert.equal(s.snap.rpmTime, null);
  assert.equal(s.snap.speed, 60);
  assert.ok(s.clock.t - s.snap.speedTime < 1000);
  assert.equal(s.client.state, 'ready');
  s.elm.noData.delete(0x0c);
  s.elm.rpm = 900;
  await s.clock.advance(2000);
  assert.equal(s.snap.rpm, 900);
});

test('trang bị ẩn lâu rồi hiện lại: không gửi số liệu đã quá ba chu kỳ đọc (ít nhất 5 giây)', async () => {
  const s = setup();
  const seen = [];
  s.client.start();
  await s.clock.advance(8000);
  s.client.setPaused(true);
  await s.clock.advance(120000);
  s.client.onData((snap) => seen.push({ at: s.clock.t, ...snap }));
  Object.assign(s.elm, { speed: 30, rpm: 1200, coolant: 70 });
  s.client.setPaused(false);
  await s.clock.advance(3000);
  assert.ok(seen.length > 0);
  // Tốc độ 300 ms, vòng tua 1 s, nước làm mát 15 s, nhiên liệu 60 s, ATRV 20 s một lần.
  const maxAge = { speed: 5000, rpm: 5000, coolant: 45000, fuel: 180000, voltage: 60000 };
  for (const x of seen) {
    for (const k of CAR_KEYS) {
      if (x[k] != null) assert.ok(x.at - x[`${k}Time`] <= maxAge[k], `${k} cũ ${x.at - x[`${k}Time`]} ms`);
    }
    assert.ok(x.speed == null || x.speed === 30, 'tốc độ cũ');
    assert.ok(x.rpm == null || x.rpm === 1200, 'vòng tua cũ');
    assert.ok(x.coolant == null || x.coolant === 70, 'nhiệt độ cũ');
  }
  assert.equal(seen.at(-1).speed, 30);
  assert.ok(Math.abs(seen.at(-1).fuel - 40) < 0.5, 'nhiên liệu đọc 2 phút trước vẫn dùng được');
});

test('xe im rồi trả lời lại: snapshot đầu tiên khi sẵn sàng lại không mang số liệu cũ', async () => {
  const s = setup();
  const seen = [];
  s.client.onData((snap) => seen.push({ ...snap }));
  s.client.start();
  await s.clock.advance(8000);
  s.elm.carOff = true;
  await s.clock.advance(3000);
  assert.equal(s.client.state, 'nocar');
  for (const k of CAR_KEYS) assert.equal(s.client.snapshot[k], null, k);
  assert.equal(s.client.snapshot.adapter, 'ELM327 v1.5');
  const n = seen.length;
  s.elm.carOff = false;
  Object.assign(s.elm, { speed: 20, rpm: 900, coolant: 70, fuel: 30 });
  await s.clock.advance(12000);
  assert.equal(s.client.state, 'ready');
  const again = seen.slice(n);
  assert.ok(again.length > 0);
  assert.deepEqual(
    CAR_KEYS.filter((k) => k !== 'voltage').map((k) => again[0][k]),
    [null, null, null, null],
    'số liệu từ trước khi xe im'
  );
  assert.equal(again[0].voltage, 13.9, 'điện áp vừa đọc lại khi dò xe');
  assert.ok(again.every((x) => x.rpm == null || x.rpm === 900));
  assert.ok(again.every((x) => x.coolant == null || x.coolant === 70));
});

/** Số yêu cầu lên bus của xe (Mode 01, 03) nhiều nhất trong một giây bất kỳ. */
function maxBusPerSecond(commands) {
  const ts = commands.filter((c) => /^0[13]/.test(c.cmd)).map((c) => c.t);
  let most = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= 1000) j++;
    most = Math.max(most, i - j + 1);
  }
  return most;
}

test('một loạt ngắn 3 lỗi CAN ERROR khi đang chạy: vẫn ở ready, gửi lại ATSP0 rồi 0100 ngay, có số mới sau vài giây', async () => {
  // Lỗi đường truyền đếm chung với NO DATA: thứ tự nào của ba câu trả lời không có dữ liệu (có ít nhất một lỗi đường
  // truyền) cũng phải được xử lý như nhau, kể cả khi câu thứ ba là NO DATA.
  for (const burst of [
    ['CAN ERROR', 'CAN ERROR', 'CAN ERROR'],
    ['NO DATA', 'CAN ERROR', 'CAN ERROR'],
    ['CAN ERROR', 'NO DATA', 'CAN ERROR'],
    ['CAN ERROR', 'CAN ERROR', 'NO DATA'],
    ['CAN ERROR', 'NO DATA', 'NO DATA'],
  ]) {
    const label = burst.join(', ');
    const s = setup();
    const seen = [];
    s.client.onData((snap) => seen.push({ at: s.clock.t, ...snap }));
    s.client.start();
    await s.clock.advance(8000);
    assert.equal(s.client.state, 'ready');
    const nStates = s.states.length;
    const from = s.elm.commands.length;
    const t0 = s.clock.t;
    let errors = 0;
    s.elm.override = (cmd) => (/^01/.test(cmd) && errors < 3 ? { lines: [burst[errors++]] } : null);
    s.elm.speed = 37;
    await s.clock.advance(8000);
    assert.equal(errors, 3, label);
    // main.js báo "Đã kết nối với xe." mỗi lần vào 'ready', và "xe chưa trả lời" khi ở 'nocar'.
    assert.deepEqual(s.states.slice(nStates), [], `${label}: không được đổi trạng thái vì một lúc nhiễu ngắn`);
    const after = s.elm.commands.slice(from);
    const thirdError = after.filter((c) => /^01/.test(c.cmd))[2];
    const k = after.findIndex((c) => c.cmd === 'ATSP0');
    assert.ok(k > 0, `${label}: phải gửi lại ATSP0`);
    assert.equal(after[k + 1].cmd, '0100', label);
    assert.ok(after[k].t > thirdError.t && after[k].t - thirdError.t < 1000, `${label}: gửi lại ngay, không chờ 8 giây`);
    assert.equal(s.snap.speed, 37, label);
    assert.ok(s.clock.t - s.snap.speedTime < 1000, `${label}: tốc độ đã được đọc lại`);
    for (const x of seen.filter((x) => x.at >= t0)) {
      assert.ok(x.rpm == null || x.at - x.rpmTime <= 5000, `${label}: vòng tua cũ trong lúc dò lại giao thức`);
      assert.ok(x.speed == null || x.at - x.speedTime <= 5000, `${label}: tốc độ cũ trong lúc dò lại giao thức`);
    }
    assert.ok(maxBusPerSecond(s.elm.commands) <= 6);
    assertSafeWrites(s.elm.writes);
  }
});

test('hai lỗi CAN ERROR rồi tắt máy (NO DATA): gửi lại ATSP0 rồi 0100 ngay, xe không trả lời thì sang nocar và nhắc bật khoá điện', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  const from = s.elm.commands.length;
  let errors = 0;
  s.elm.override = (cmd) => {
    if (!/^01/.test(cmd) || errors >= 2) return null;
    if (++errors === 2) s.elm.carOff = true; // sau lỗi thứ hai thì xe tắt máy: mọi câu hỏi sau là NO DATA
    return { lines: ['CAN ERROR'] };
  };
  await s.clock.advance(10000);
  const after = s.cmds().slice(from);
  assert.deepEqual(after.slice(0, 3).map((c) => /^01/.test(c)), [true, true, true]);
  assert.equal(after[3], 'ATSP0', 'câu thứ ba (NO DATA) đi sau hai lỗi đường truyền: phải gửi lại ATSP0 ngay');
  assert.equal(after[4], '0100');
  assert.equal(s.client.state, 'nocar');
  assert.equal(s.infos.at(-1).reason, 'unable');
  assert.equal(
    describeCarState(s.client.state, s.infos.at(-1), { name: s.client.name }),
    'Đã kết nối bộ OBD nhưng xe chưa trả lời. Hãy bật khoá điện hoặc nổ máy.'
  );
  assertSafeWrites(s.elm.writes);
});

test('0100 vẫn trả lời nhưng mọi PID báo CAN ERROR: sang nocar một lần rồi ở đó, không đổi qua lại ready ↔ nocar', async () => {
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  const n = s.states.length;
  const resent = s.count('ATSP0');
  s.elm.override = (cmd) => (/^01/.test(cmd) && cmd !== '0100' ? { lines: ['CAN ERROR'] } : null);
  await s.clock.advance(120000);
  assert.deepEqual(s.states.slice(n), ['nocar'], 'mỗi lần vào lại ready là một lần báo "Đã kết nối với xe."');
  assert.equal(s.infos.at(-1).reason, 'error');
  for (const k of CAR_KEYS) assert.equal(s.client.snapshot[k], null, `còn giữ ${k} cũ`);
  assert.ok(s.count('ATSP0') - resent >= 5, 'vẫn gửi lại ATSP0 rồi 0100 định kỳ');

  s.elm.override = null;
  s.elm.speed = 47;
  await s.clock.advance(20000);
  assert.deepEqual(s.states.slice(n), ['nocar', 'ready']);
  assert.equal(s.snap.speed, 47);
  assert.ok(maxBusPerSecond(s.elm.commands) <= 6, 'tối đa 6 yêu cầu mỗi giây, kể cả lúc dò lại xe');
  assertSafeWrites(s.elm.writes);
});

test('câu trạng thái: xe báo lỗi đường truyền khi máy đang chạy không bị gọi là "xe chưa trả lời"; tắt máy vẫn nhắc bật khoá điện', async () => {
  const noAnswer = 'Đã kết nối bộ OBD nhưng xe chưa trả lời. Hãy bật khoá điện hoặc nổ máy.';
  // Lỗi đường truyền kéo dài trong lúc đang đọc (CAN ERROR cho mọi PID).
  const s = setup();
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(describeCarState(s.client.state, s.infos.at(-1), { name: s.client.name }), 'Đã kết nối với xe qua ELM327 v1.5.');
  s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: ['CAN ERROR'] } : null);
  await s.clock.advance(30000);
  assert.equal(s.client.state, 'nocar');
  const busText = describeCarState(s.client.state, s.infos.at(-1), { name: s.client.name });
  assert.notEqual(busText, noAnswer, 'máy đang chạy mà màn hình bảo bật khoá điện');
  assert.match(busText, /lỗi đường truyền/);
  assert.match(busText, /đang thử lại/);
  assert.doesNotMatch(busText, /xe chưa trả lời/);

  // Tắt máy: các PID thôi trả lời (NO DATA) → câu cũ, nhắc bật khoá điện.
  const off = setup();
  off.client.start();
  await off.clock.advance(8000);
  off.elm.carOff = true;
  await off.clock.advance(10000);
  assert.equal(off.client.state, 'nocar');
  assert.notEqual(off.infos.at(-1).reason, 'error');
  assert.equal(describeCarState(off.client.state, off.infos.at(-1), { name: off.client.name }), noAnswer);
  assertSafeWrites(s.elm.writes);
});

test('đang nocar vì xe chưa trả lời (UNABLE TO CONNECT, NO DATA), sau đó 0100 báo CAN ERROR: câu trạng thái chuyển sang lỗi đường truyền', async () => {
  const noAnswer = 'Đã kết nối bộ OBD nhưng xe chưa trả lời. Hãy bật khoá điện hoặc nổ máy.';
  const text = (s) => describeCarState(s.client.state, s.infos.at(-1), { name: s.client.name });
  // A. Kết nối lúc chưa bật khoá điện ('unable'), rồi bật khoá điện mà bus báo lỗi.
  // B. Đang đọc thì tắt máy ('nodata'), rồi bus báo lỗi.
  for (const start of ['unable', 'nodata']) {
    const s = setup();
    if (start === 'unable') s.elm.carOff = true;
    s.client.start();
    await s.clock.advance(8000);
    if (start === 'nodata') {
      assert.equal(s.client.state, 'ready');
      s.elm.carOff = true;
      await s.clock.advance(3000);
    }
    assert.equal(s.client.state, 'nocar', start);
    assert.equal(s.infos.at(-1).reason, start);
    assert.equal(text(s), noAnswer, start);
    const n = s.states.length;
    s.elm.carOff = false;
    s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: ['CAN ERROR'] } : null);
    await s.clock.advance(30000);
    assert.equal(s.client.state, 'nocar', start);
    assert.equal(s.infos.at(-1).reason, 'error', `${start}: lý do không được cập nhật`);
    assert.match(text(s), /lỗi đường truyền/, start);
    assert.deepEqual(s.states.slice(n), ['nocar'], `${start}: chỉ báo lại 'nocar' một lần khi lý do đổi`);
    assert.ok(s.cmds().slice(-4).includes('ATSP0'), `${start}: vẫn gửi lại ATSP0 trước 0100`);

    s.elm.override = null;
    s.elm.speed = 51;
    await s.clock.advance(20000);
    assert.equal(s.client.state, 'ready', start);
    assert.equal(s.snap.speed, 51, start);
    assertSafeWrites(s.elm.writes);
  }
});

test('câu trạng thái các bước kết nối giữ nguyên như trước', () => {
  assert.equal(describeCarState('idle', null), 'Chưa kết nối.');
  assert.equal(describeCarState('connecting', null, { name: 'Bộ OBD Bluetooth' }), 'Đang kết nối với bộ OBD Bluetooth…');
  assert.equal(describeCarState('connecting', { attempt: 2 }, { name: 'OBDII' }), 'Đang kết nối lại (lần 2)…');
  assert.equal(describeCarState('init', null), 'Đang khởi động bộ OBD…');
  assert.equal(describeCarState('searching', null), 'Đang dò giao thức của xe, có thể mất tới 20 giây…');
  assert.equal(describeCarState('ready', {}, { name: 'OBDII', adapter: 'ELM327 v2.1' }), 'Đã kết nối với xe qua ELM327 v2.1.');
  assert.equal(describeCarState('ready', null, { name: 'OBDII' }), 'Đã kết nối với xe qua OBDII.');
  assert.equal(describeCarState('nocar', { reason: 'unable' }), 'Đã kết nối bộ OBD nhưng xe chưa trả lời. Hãy bật khoá điện hoặc nổ máy.');
  assert.equal(describeCarState('lost', { delay: 5000 }), 'Mất kết nối với bộ OBD, thử lại sau 5 giây…');
  assert.equal(describeCarState('error', { message: 'Bộ OBD không trả lời.' }), 'Bộ OBD không trả lời.');
  assert.equal(describeCarState('error', null), 'Không kết nối được với bộ OBD.');
});

test('sau lỗi đường truyền, xe báo hỗ trợ PID tốc độ mà PID đó luôn NO DATA: vẫn về ready nhờ PID khác trả lời', async () => {
  const s = setup({ noData: [0x0d] });
  s.client.start();
  await s.clock.advance(12000);
  assert.equal(s.client.state, 'ready');
  s.elm.override = (cmd) => (/^01/.test(cmd) ? { lines: ['CAN ERROR'] } : null);
  await s.clock.advance(15000);
  assert.equal(s.client.state, 'nocar');
  s.elm.override = null;
  s.elm.rpm = 990;
  await s.clock.advance(25000);
  assert.equal(s.client.state, 'ready');
  assert.equal(s.snap.rpm, 990);
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

test('CarWatch: chỉ tính lần đọc mới (coolantTime), cần hai lần đọc nóng liên tiếp cách nhau ít nhất 10 giây', () => {
  // Một lần đọc 112 °C lúc 0, snapshot gửi lại số đó 5 lần mỗi giây cho tới lần đọc sau: chưa được nhắc.
  const w = new CarWatch();
  for (let t = 0; t <= 14800; t += 200) assert.equal(w.update({ coolant: 112, coolantTime: 0 }, t).say, null, `lúc ${t} ms`);
  assert.equal(w.update({ coolant: 112, coolantTime: 15000 }, 15000).say, CAR_MESSAGES.coolant);
  assert.equal(w.update({ coolant: 112, coolantTime: 30000 }, 30000).say, null, 'mỗi chuyến một lần');

  // Hai lần đọc nóng cách nhau chưa tới 10 giây: chưa nhắc; lần thứ ba đủ 10 giây kể từ lần đầu thì nhắc.
  const quick = new CarWatch();
  assert.equal(quick.update({ coolant: 111, coolantTime: 0 }, 0).say, null);
  assert.equal(quick.update({ coolant: 111, coolantTime: 4000 }, 4000).say, null);
  assert.equal(quick.update({ coolant: 111, coolantTime: 4000 }, 14000).say, null, 'gửi lại số cũ không đếm');
  assert.equal(quick.update({ coolant: 111, coolantTime: 10000 }, 14500).say, CAR_MESSAGES.coolant);

  // Một lần đọc bình thường ở giữa thì đếm lại từ đầu.
  const mid = new CarWatch();
  mid.update({ coolant: 112, coolantTime: 0 }, 0);
  mid.update({ coolant: 100, coolantTime: 15000 }, 15000);
  assert.equal(mid.update({ coolant: 112, coolantTime: 30000 }, 30000).say, null);
  assert.equal(mid.update({ coolant: 112, coolantTime: 45000 }, 45000).say, CAR_MESSAGES.coolant);

  // Mất số liệu (bị xoá vì cũ hoặc xe im) cũng đếm lại; lần đọc cũ không được tính lại.
  const gone = new CarWatch();
  gone.update({ coolant: 112, coolantTime: 0 }, 0);
  gone.update({ coolant: null, coolantTime: null }, 5000);
  assert.equal(gone.update({ coolant: 112, coolantTime: 15000 }, 15000).say, null);
  assert.equal(gone.update({ coolant: 112, coolantTime: 30000 }, 30000).say, CAR_MESSAGES.coolant);
});

test('CarWatch: điện áp thấp tính theo lần đọc ATRV (voltageTime), trải dài ít nhất 30 giây khi máy chạy', () => {
  // ATRV đọc mỗi 20 giây; một lần đọc 11,8 V được gửi lại suốt 40 giây (vòng tua vẫn mới) thì chưa đủ.
  const v = new CarWatch();
  for (let t = 0; t <= 40000; t += 1000) {
    assert.equal(v.update({ voltage: 11.8, voltageTime: 0, rpm: 800, rpmTime: t }, t).say, null, `lúc ${t} ms`);
  }
  assert.equal(v.update({ voltage: 11.8, voltageTime: 20000, rpm: 800 }, 41000).say, null, 'hai lần đọc mới chỉ cách 20 giây');
  assert.equal(v.update({ voltage: 11.7, voltageTime: 40000, rpm: 800 }, 42000).say, CAR_MESSAGES.battery);

  // Vòng tua tụt dưới 500 (chết máy) ở giữa: đếm lại, lần đọc điện áp cũ không được tính lại.
  const dip = new CarWatch();
  dip.update({ voltage: 11.8, voltageTime: 0, rpm: 800 }, 0);
  dip.update({ voltage: 11.8, voltageTime: 0, rpm: 300 }, 5000);
  dip.update({ voltage: 11.8, voltageTime: 0, rpm: 800 }, 6000);
  assert.equal(dip.update({ voltage: 11.8, voltageTime: 20000, rpm: 800 }, 20000).say, null);
  assert.equal(dip.update({ voltage: 11.8, voltageTime: 40000, rpm: 800 }, 40000).say, null, 'tính lại từ lần đọc lúc 20 giây');
  assert.equal(dip.update({ voltage: 11.8, voltageTime: 60000, rpm: 800 }, 60000).say, CAR_MESSAGES.battery);

  // Không có vòng tua (PID thôi trả lời, số cũ đã bị xoá) thì không nhắc.
  const norpm = new CarWatch();
  for (let t = 0; t <= 100000; t += 20000) assert.equal(norpm.update({ voltage: 11.5, voltageTime: t, rpm: null }, t).say, null);
});

test('CarWatch: vòng tua tạm mất (bộ đọc lỡ vài câu trả lời) không làm đếm lại; lần đọc điện áp lúc đó không được tính', () => {
  // ATRV mỗi 20 giây đọc 11,8 V, máy chạy 850 vòng/phút; giữa các lần đọc, vòng tua bị xoá khỏi snapshot một lúc.
  const w = new CarWatch();
  const step = (t, voltageTime, rpm) => w.update({ voltage: 11.8, voltageTime, rpm, rpmTime: rpm == null ? null : t }, t).say;
  assert.equal(step(0, 0, 850), null);
  assert.equal(step(10000, 0, null), null);
  assert.equal(step(20000, 20000, 850), null);
  assert.equal(step(30000, 20000, null), null);
  assert.equal(step(40000, 40000, 850), CAR_MESSAGES.battery, 'lần đọc thấp thứ ba, 40 giây sau lần đầu');

  // Lần đọc lúc vòng tua đang mất không được tính, kể cả khi vòng tua có lại ngay sau đó.
  const late = new CarWatch();
  late.update({ voltage: 11.8, voltageTime: 0, rpm: 850 }, 0);
  assert.equal(late.update({ voltage: 11.8, voltageTime: 30000, rpm: null }, 30000).say, null);
  assert.equal(late.update({ voltage: 11.8, voltageTime: 30000, rpm: 850 }, 31000).say, null, 'lần đọc lúc 30 giây không được tính');
  assert.equal(late.update({ voltage: 11.8, voltageTime: 50000, rpm: 850 }, 50000).say, CAR_MESSAGES.battery);
});

test('CarWatch: dãy lần đọc điện áp thấp bị đứt khi hai lần đọc cách nhau quá 60 giây hoặc mất số điện áp', () => {
  // Xe im ('nocar') hay trang bị ẩn giữa hai lần đọc: không nối các lần đọc trước và sau thành một dãy.
  const gap = new CarWatch();
  gap.update({ voltage: 11.8, voltageTime: 0, rpm: 850 }, 0);
  gap.update({ voltage: 11.8, voltageTime: 20000, rpm: 850 }, 20000);
  assert.equal(gap.update({ voltage: 11.8, voltageTime: 600000, rpm: 850 }, 600000).say, null, 'dãy đã đứt');
  assert.equal(gap.update({ voltage: 11.8, voltageTime: 620000, rpm: 850 }, 620000).say, null);
  assert.equal(gap.update({ voltage: 11.8, voltageTime: 640000, rpm: 850 }, 640000).say, CAR_MESSAGES.battery);

  // Lần đọc giữ nguyên (vòng tua tạm mất) vẫn nối dãy: không coi là đứt khi chỉ cách nhau 20 giây.
  const held = new CarWatch();
  held.update({ voltage: 11.8, voltageTime: 0, rpm: 850 }, 0);
  for (const t of [20000, 40000, 60000]) held.update({ voltage: 11.8, voltageTime: t, rpm: null }, t);
  assert.equal(held.update({ voltage: 11.8, voltageTime: 80000, rpm: 850 }, 80000).say, CAR_MESSAGES.battery);

  // Không còn số điện áp (bị xoá vì quá 60 giây không đọc được) thì đếm lại.
  const none = new CarWatch();
  none.update({ voltage: 11.8, voltageTime: 0, rpm: 850 }, 0);
  none.update({ voltage: 11.8, voltageTime: 20000, rpm: 850 }, 20000);
  none.update({ voltage: null, voltageTime: null, rpm: 850 }, 30000);
  assert.equal(none.update({ voltage: 11.8, voltageTime: 40000, rpm: 850 }, 40000).say, null);
});

test('bộ đọc lỡ hai câu trả lời vòng tua (vòng tua tạm mất khỏi snapshot): vẫn nhắc ắc quy ở lần đọc ATRV thấp thứ ba', async () => {
  const s = setup();
  const watch = new CarWatch();
  const said = [];
  const seen = [];
  s.client.onData((snap) => {
    seen.push({ at: s.clock.t, ...snap });
    const w = watch.update(snap, s.clock.t).say;
    if (w) said.push({ t: s.clock.t, w });
  });
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  const atrv = () => s.elm.commands.filter((c) => c.cmd === 'ATRV').map((c) => c.t);
  // Từ giờ máy vẫn chạy 1.850 vòng/phút nhưng điện áp chỉ 11,8 V (máy phát không sạc).
  s.elm.atrv = '11.8V';
  const t0 = s.clock.t;
  let drops = 0;
  s.elm.override = (cmd) => {
    if (cmd !== '010C' || drops >= 2) return null;
    const low = atrv().filter((t) => t > t0);
    if (!low.length || s.clock.t < low[0] + 3000) return null;
    drops++;
    return { drop: true }; // câu trả lời bị mất: quá hạn, X, CR
  };
  await s.clock.advance(90000);
  const low = atrv().filter((t) => t > t0);
  assert.equal(drops, 2);
  assert.ok(
    seen.some((x) => x.at > low[0] && x.at < low[1] && x.rpm == null),
    'vòng tua phải có lúc bị xoá khỏi snapshot giữa hai lần đọc ATRV'
  );
  assert.equal(said.length, 1);
  assert.equal(said[0].w, CAR_MESSAGES.battery);
  assert.ok(said[0].t >= low[2] && said[0].t < low[2] + 1000, `nhắc ở lần đọc thấp thứ ba (${said[0].t}; ${low.join(', ')})`);
  assertSafeWrites(s.elm.writes);
});

test('CarWatch với snapshot thật của ObdClient: một lần đọc 112 °C rồi lần sau 95 °C thì không nhắc; nóng hai lần liền thì nhắc', async () => {
  const s = setup();
  const watch = new CarWatch();
  const said = [];
  s.client.onData((snap) => {
    const w = watch.update(snap, s.clock.t).say;
    if (w) said.push({ t: s.clock.t, w });
  });
  s.client.start();
  await s.clock.advance(8000);
  assert.equal(s.client.state, 'ready');
  const reads = () => s.elm.commands.filter((c) => c.cmd === '0105').map((c) => c.t);
  const first = reads().at(-1);
  await s.clock.advance(first + 15000 - 500 - s.clock.t);
  s.elm.coolant = 112;
  await s.clock.advance(1000);
  assert.equal(s.snap.coolant, 112);
  assert.ok(s.clock.t - s.snap.coolantTime < 1000, 'snapshot có thời điểm đọc nước làm mát');
  s.elm.coolant = 95;
  await s.clock.advance(30000);
  assert.deepEqual(said, [], 'một lần đọc nóng chưa đủ để nhắc');

  const from = s.clock.t;
  s.elm.coolant = 113;
  await s.clock.advance(40000);
  const hot = reads().filter((t) => t > from);
  assert.equal(said.length, 1);
  assert.equal(said[0].w, CAR_MESSAGES.coolant);
  assert.ok(said[0].t > hot[1] && said[0].t < hot[1] + 1000, 'nhắc khi có lần đọc nóng thứ hai');
  assert.ok(hot[1] - hot[0] >= 10000);
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

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await flush();
};

/** Cổng nối tiếp giả theo chuẩn Web Serial: open() chờ tới khi gọi release(); close() lỗi nếu chưa mở xong hoặc còn khoá. */
function gatedPort() {
  let release;
  const gate = new Promise((r) => (release = r));
  const port = {
    state: 'closed',
    readable: null,
    writable: null,
    release,
    async open() {
      if (port.state !== 'closed') throw Object.assign(new Error('already open'), { name: 'InvalidStateError' });
      port.state = 'opening';
      await gate;
      port.state = 'opened';
      port.readable = new ReadableStream({ start() {} });
      port.writable = new WritableStream({ write() {} });
    },
    async close() {
      if (port.state !== 'opened') throw Object.assign(new Error('The port is already closed.'), { name: 'InvalidStateError' });
      if (port.readable.locked || port.writable.locked) throw new TypeError('locked');
      port.state = 'closed';
      port.readable = port.writable = null;
    },
  };
  return port;
}

test('ngắt kết nối lúc cổng nối tiếp đang mở: mở xong thì đóng ngay, lần kết nối sau vẫn mở được', async () => {
  const port = gatedPort();
  const c1 = new ObdClient(createSerialTransport(port));
  c1.start();
  await settle();
  assert.equal(c1.state, 'connecting');
  await c1.stop();
  port.release();
  await settle();
  assert.equal(c1.state, 'idle');
  assert.equal(port.state, 'closed', 'cổng vẫn mở và bị khoá sau khi đã ngắt');

  const tr2 = createSerialTransport(port);
  await tr2.connect({ onData() {}, onClose() {} });
  assert.equal(port.state, 'opened');
  await tr2.disconnect();
  assert.equal(port.state, 'closed');
});

test('ngắt kết nối lúc gatt.connect() đang chờ: huỷ lần nối đó, Bluetooth không còn nối, không bật notify', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const rx = {
    uuid: U(0xfff1),
    properties: { notify: true },
    notifying: false,
    started: 0,
    addEventListener() {},
    removeEventListener() {},
    async startNotifications() { this.notifying = true; this.started++; },
    async stopNotifications() { this.notifying = false; },
  };
  const tx = { uuid: U(0xfff2), properties: { write: true }, async writeValueWithResponse() {} };
  const server = fakeServer({ [U(0xfff0)]: [rx, tx] });
  const pending = new Set();
  let disconnectCalls = 0;
  // Theo chuẩn Web Bluetooth: disconnect() huỷ mọi lần connect() đang chờ (AbortError), kể cả khi chưa nối.
  const gatt = {
    connected: false,
    connect() {
      return new Promise((resolve, reject) => {
        const a = { reject };
        pending.add(a);
        gate.then(() => {
          if (!pending.delete(a)) return;
          gatt.connected = true;
          resolve(server);
        });
      });
    },
    disconnect() {
      disconnectCalls++;
      for (const a of pending) a.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      pending.clear();
      gatt.connected = false;
    },
  };
  const device = { name: 'OBDII', gatt, addEventListener() {}, removeEventListener() {} };
  const c = new ObdClient(createBleTransport(device));
  const states = [];
  c.onState((st) => states.push(st));
  c.start();
  await settle();
  assert.equal(c.state, 'connecting');
  await c.stop();
  assert.ok(disconnectCalls >= 1, 'gatt.disconnect() phải được gọi để huỷ lần nối đang chờ');
  assert.equal(pending.size, 0, 'lần gatt.connect() đang chờ chưa bị huỷ');
  release();
  await settle();
  assert.equal(gatt.connected, false);
  assert.equal(rx.started, 0, 'không được nối rồi bật notify sau khi đã ngắt');
  assert.equal(rx.notifying, false);
  assert.equal(c.state, 'idle');
  assert.ok(!states.includes('error'), 'người dùng tự ngắt thì không báo lỗi');

  // Trình duyệt không huỷ được lần nối đang chờ: GATT nối xong sau khi đã ngắt, rồi việc mở hỏng (không có kênh
  // dữ liệu OBD). Phần đã nối vẫn phải được ngắt, và không báo lỗi.
  let release2;
  const gate2 = new Promise((r) => (release2 = r));
  const gatt2 = {
    connected: false,
    async connect() {
      await gate2;
      gatt2.connected = true;
      return fakeServer({});
    },
    disconnect() {
      gatt2.connected = false;
    },
  };
  const c2 = new ObdClient(createBleTransport({ name: 'Tai nghe', gatt: gatt2 }));
  const states2 = [];
  c2.onState((st) => states2.push(st));
  c2.start();
  await settle();
  await c2.stop();
  release2();
  await settle();
  assert.equal(gatt2.connected, false, 'GATT còn nối sau khi người dùng đã ngắt');
  assert.equal(c2.state, 'idle');
  assert.ok(!states2.includes('error'));
});

test('tên chung của bộ đọc viết thường vì đứng giữa câu; tên riêng của thiết bị giữ nguyên', () => {
  assert.equal(createSerialTransport({}).name, 'bộ OBD Bluetooth thường');
  assert.equal(createBleTransport({ gatt: {} }).name, 'bộ OBD Bluetooth');
  assert.equal(createBleTransport({ name: '', gatt: {} }).name, 'bộ OBD Bluetooth');
  assert.equal(createBleTransport({ name: 'vLinker MC-IOS', gatt: {} }).name, 'vLinker MC-IOS');
  // Câu trạng thái mà main.js hiện (describeCarState): tên đứng sau "Đang kết nối với".
  for (const [tr, text] of [
    [createSerialTransport({}), 'Đang kết nối với bộ OBD Bluetooth thường…'],
    [createBleTransport({ gatt: {} }), 'Đang kết nối với bộ OBD Bluetooth…'],
    [createBleTransport({ name: 'OBDII', gatt: {} }), 'Đang kết nối với OBDII…'],
  ]) {
    const name = new ObdClient(tr).name;
    assert.equal(`Đang kết nối với ${name}…`, text);
    assert.equal(describeCarState('connecting', null, { name }), text);
  }
});
