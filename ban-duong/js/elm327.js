// Giao thức của chip ELM327 (bộ đọc OBD-II): danh sách lệnh được phép, ghép phản hồi,
// phân loại câu trả lời và giải mã dữ liệu. Thuần logic, không đụng tới Bluetooth hay DOM.
//
// Nguồn: datasheet ELM327 (qua bản trích từng trang), python-OBD, ELMduino, driver can327 của Linux.

/** Chuỗi khởi tạo; ATZ luôn đứng đầu (xem ObdClient trong obd.js). */
export const INIT_COMMANDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0'];

// Chỉ đọc: AT cấu hình, Mode 01 (dữ liệu hiện tại), Mode 03 (mã lỗi đã lưu) và ký tự ngắt 'X'.
// Không có Mode 04 (xoá mã lỗi), ATMA (theo dõi bus), ATPP (ghi tham số cố định) hay lệnh tự nhập.
const ALLOWED = [
  /^AT(?:Z|WS|D|I|FE|E0|L0|S0|H0|H1|AT1|AT2|SP0|DPN|RV)$/,
  /^ATST[0-9A-F]{2}$/,
  /^ATSPA[1-9A-C]$/,
  /^01[0-9A-F]{2}1?$/,
  /^03$/,
  /^X$/,
];

/** Lệnh có nằm trong danh sách được phép gửi tới xe hay không (phân biệt chữ hoa, không khoảng trắng). */
export function isAllowedCommand(cmd) {
  return typeof cmd === 'string' && ALLOWED.some((re) => re.test(cmd));
}

/**
 * Chuỗi thật sự ghi xuống bộ đọc: lệnh + CR, riêng ký tự ngắt 'X' thì không kèm CR.
 * Không bao giờ tạo ra một CR đứng riêng: với ELM327, CR trống nghĩa là "chạy lại lệnh vừa rồi".
 */
export function frameCommand(cmd) {
  if (!isAllowedCommand(cmd)) throw new Error('Lệnh không nằm trong danh sách được phép gửi tới xe.');
  return cmd === 'X' ? 'X' : `${cmd}\r`;
}

/** Lệnh Mode 01 cho một PID: 0x0D → '010D'. */
export function pidCommand(pid) {
  const p = toPid(pid);
  if (p == null) throw new Error('PID không hợp lệ.');
  return `01${hex2(p)}`;
}

const compact = (line) => String(line).replace(/\s+/g, '').toUpperCase();
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

function toPid(pid) {
  const p = typeof pid === 'string' ? parseInt(pid, 16) : pid;
  return Number.isInteger(p) && p >= 0 && p <= 0xff ? p : null;
}

const MAX_BUFFER = 4096; // thiết bị lạ gửi rác liên tục thì không để bộ đệm phình mãi

/**
 * Ghép các gói dữ liệu nhận được thành từng câu trả lời hoàn chỉnh. ELM327 kết thúc mỗi câu trả lời
 * bằng dấu nhắc '>'; một câu có thể bị cắt thành nhiều gói 20 byte và '>' có thể đến trong gói riêng.
 */
export class ResponseAssembler {
  constructor() {
    this.buffer = '';
    this.command = null; // lệnh vừa gửi, để bỏ dòng echo
  }

  setCommand(cmd) {
    this.command = cmd ? compact(cmd) : null;
  }

  reset() {
    this.buffer = '';
  }

  /** @returns mảng câu trả lời đã hoàn chỉnh [{ lines, raw }] (có thể rỗng) */
  push(text) {
    this.buffer += String(text ?? '').replace(/\0/g, '');
    const out = [];
    let k;
    while ((k = this.buffer.indexOf('>')) !== -1) {
      const raw = this.buffer.slice(0, k);
      this.buffer = this.buffer.slice(k + 1);
      out.push({ lines: this.#lines(raw), raw });
    }
    if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
    return out;
  }

  #lines(raw) {
    return raw
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        const c = compact(l);
        if (this.command && c === this.command) return false; // echo của lệnh vừa gửi
        if (/^SEARCHING\.*$/.test(c)) return false;
        if (/^BUSINIT:?\.*OK$/.test(c)) return false;
        return true;
      });
  }
}

/**
 * Phân loại một câu trả lời.
 * @returns 'ok' | 'data' | 'nodata' | 'unable' | 'stopped' | 'unknown' | 'error' | 'lvreset' | 'buffer'
 *          | 'alert' | 'empty' (chỉ có dấu nhắc, không có dòng nào)
 */
export function classify(lines) {
  if (!lines || !lines.length) return 'empty';
  const c = lines.map(compact);
  const has = (re) => c.some((l) => re.test(l));
  if (has(/LVRESET/)) return 'lvreset';
  if (has(/^ERR\d{2}$/) || has(/CANERROR|BUSERROR|FBERROR|<RXERROR|^BUSINIT:.*ERROR$/)) return 'error';
  if (has(/BUFFERFULL/)) return 'buffer';
  if (has(/ACTALERT|LPALERT/)) return 'alert';
  if (has(/UNABLETOCONNECT/)) return 'unable';
  if (has(/^STOPPED$/)) return 'stopped';
  if (has(/^NODATA$/)) return 'nodata';
  if (c.every((l) => l === '?')) return 'unknown';
  if (c.every((l) => l === 'OK')) return 'ok';
  return 'data';
}

/**
 * Câu trả lời cho thấy chip vừa tự khởi động lại (LV RESET khi sụt áp lúc đề máy, ERR94 lỗi CAN nặng):
 * mọi cài đặt về mặc định và việc dò CAN bị chặn tới khi gửi AT FE, nên phải ATFE rồi khởi tạo lại.
 */
export function needsReset(lines) {
  return (lines || []).some((l) => /LVRESET|^ERR94$/.test(compact(l)));
}

/** Chuỗi nhận dạng bộ đọc trong câu trả lời ATZ / ATI ("ELM327 v1.5"), hoặc null nếu không giống ELM327. */
export function identifyAdapter(lines) {
  for (const line of lines || []) {
    if (/ELM|STN|OBD/i.test(line)) {
      const clean = String(line).replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40);
      if (clean) return clean;
    }
  }
  return null;
}

function hexBytes(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/**
 * Tách câu trả lời thành các thông điệp OBD (mảng byte, đã bỏ header và byte PCI).
 * Hỗ trợ: tắt header ("410D3C" hoặc "41 0D 3C", mỗi ECU một dòng); nhiều frame khi tắt header
 * (dòng đầu là số byte, sau đó "0: …", "1: …"); bật header CAN 11 bit ("7E8 03 41 0D 3C") và
 * 29 bit ("18 DA F1 10 03 41 0D 3C"), kể cả nhiều frame ISO-TP (first frame 1x, consecutive 2x).
 * Header của giao thức cũ (J1850, ISO 9141, KWP) không được hỗ trợ: ứng dụng luôn gửi ATH0.
 * @returns [{ header: string | null, bytes: number[] }]
 */
export function parseMessages(lines) {
  const out = [];
  let multi = null; // nhiều frame khi tắt header: { need, bytes }
  const tp = new Map(); // header → { need, bytes } (ISO-TP khi bật header)
  const endMulti = () => {
    if (multi && multi.need > 0 && multi.bytes.length >= multi.need) {
      out.push({ header: null, bytes: multi.bytes.slice(0, multi.need) });
    }
    multi = null;
  };

  for (const line of lines || []) {
    const c = compact(line);
    const frame = /^([0-9A-F]):([0-9A-F]*)$/.exec(c);
    if (frame) {
      if (multi) {
        multi.bytes.push(...hexBytes(frame[2]));
        if (multi.bytes.length >= multi.need) endMulti();
      }
      continue;
    }
    if (!/^[0-9A-F]+$/.test(c)) continue;
    if (c.length <= 3) {
      // Số byte của câu trả lời nhiều frame (tối đa 3 chữ số hex).
      endMulti();
      multi = { need: parseInt(c, 16), bytes: [] };
      continue;
    }

    let header = null;
    let body = null;
    if (c.length % 2 === 1 && c.length >= 5) {
      header = c.slice(0, 3);
      body = hexBytes(c.slice(3));
    } else if (c.length % 2 === 0 && c.length >= 12 && c.startsWith('18DA')) {
      header = c.slice(0, 8);
      body = hexBytes(c.slice(8));
    }
    if (!header) {
      if (c.length % 2 === 0) out.push({ header: null, bytes: hexBytes(c) });
      continue;
    }

    const pci = body[0];
    const type = pci >> 4;
    if (type === 0) {
      const n = pci & 0x0f;
      if (n > 0 && body.length > n) out.push({ header, bytes: body.slice(1, 1 + n) });
    } else if (type === 1 && body.length >= 2) {
      tp.set(header, { need: ((pci & 0x0f) << 8) | body[1], bytes: body.slice(2) });
    } else if (type === 2) {
      const t = tp.get(header);
      if (t) {
        t.bytes.push(...body.slice(1));
        if (t.bytes.length >= t.need) {
          out.push({ header, bytes: t.bytes.slice(0, t.need) });
          tp.delete(header);
        }
      }
    }
  }
  endMulti();
  return out;
}

/** Dữ liệu của PID Mode 01 từ mọi ECU đã trả lời (để gộp bảng PID hỗ trợ). @returns number[][] */
export function pidBytesAll(lines, pid) {
  const p = toPid(pid);
  if (p == null) return [];
  return parseMessages(lines)
    .filter((m) => m.bytes[0] === 0x41 && m.bytes[1] === p)
    .map((m) => m.bytes.slice(2));
}

/**
 * Các byte dữ liệu (A, B, …) của PID Mode 01, hoặc null. Nhiều ECU cùng trả lời thì lấy ECU động cơ
 * (header 7E8 / 18DAF110) nếu nhận ra được, không thì lấy dòng đầu tiên.
 */
export function pidBytes(lines, pid) {
  const p = toPid(pid);
  if (p == null) return null;
  const hits = parseMessages(lines).filter((m) => m.bytes[0] === 0x41 && m.bytes[1] === p);
  if (!hits.length) return null;
  const engine = hits.find((m) => m.header === '7E8' || m.header === '18DAF110');
  return (engine || hits[0]).bytes.slice(2);
}

const pct = (a) => (a * 100) / 255;
const DECODERS = {
  0x04: { n: 1, f: (b) => pct(b[0]) }, // tải động cơ, %
  0x05: { n: 1, f: (b) => b[0] - 40 }, // nhiệt độ nước làm mát, °C
  0x0c: { n: 2, f: (b) => (256 * b[0] + b[1]) / 4 }, // vòng tua, vòng/phút
  0x0d: { n: 1, f: (b) => b[0] }, // tốc độ xe, km/h
  0x11: { n: 1, f: (b) => pct(b[0]) }, // vị trí bướm ga, %
  0x2f: { n: 1, f: (b) => pct(b[0]) }, // mức nhiên liệu, %
  0x42: { n: 2, f: (b) => (256 * b[0] + b[1]) / 1000 }, // điện áp mô-đun điều khiển, V
  0x5c: { n: 1, f: (b) => b[0] - 40 }, // nhiệt độ dầu động cơ, °C
};

/** Giá trị vật lý của một PID Mode 01 (km/h, vòng/phút, °C, %, V), hoặc null. */
export function decodePid(pid, bytes) {
  const d = DECODERS[toPid(pid)];
  if (!d || !Array.isArray(bytes) || bytes.length < d.n) return null;
  return d.f(bytes);
}

/** Bảng PID hỗ trợ (0100 / 0120 / 0140): bit cao nhất của A ứng với PID base + 1. */
export function parseSupported(bytes, base = 0) {
  const set = new Set();
  if (!Array.isArray(bytes) || bytes.length < 4) return set;
  for (let i = 0; i < 32; i++) {
    if ((bytes[i >> 3] >> (7 - (i & 7))) & 1) set.add(base + i + 1);
  }
  return set;
}

/** Điện áp do bộ đọc đo (câu trả lời ATRV, ví dụ "12.3V"), hoặc null. Nhận một chuỗi hoặc mảng dòng. */
export function parseVoltage(input) {
  const list = Array.isArray(input) ? input : [input];
  for (const s of list) {
    const m = /^\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*V\s*$/i.exec(String(s ?? ''));
    if (m) {
      const v = parseFloat(m[1].replace(',', '.'));
      if (v > 0 && v < 40) return v;
    }
  }
  return null;
}

function dtcCode(a, b) {
  return `${['P', 'C', 'B', 'U'][a >> 6]}${(a >> 4) & 3}${(a & 0x0f).toString(16)}${hex2(b)}`.toUpperCase();
}

/**
 * Mã lỗi đã lưu từ câu trả lời Mode 03, ví dụ ['P0133']. Với CAN: 43 + số mã + từng cặp byte (một hoặc
 * nhiều frame). Với giao thức cũ: mỗi frame 43 + đúng 3 cặp byte, đệm 00 00, không có byte đếm.
 */
export function decodeDtcs(lines) {
  const codes = [];
  for (const { bytes } of parseMessages(lines)) {
    if (bytes[0] !== 0x43) continue;
    const pairs = bytes.length === 7 ? bytes.slice(1) : bytes.slice(2, 2 + 2 * (bytes[1] || 0));
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (!pairs[i] && !pairs[i + 1]) continue;
      const code = dtcCode(pairs[i], pairs[i + 1]);
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}
