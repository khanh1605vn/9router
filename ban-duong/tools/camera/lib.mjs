// Phần dùng chung của bộ công cụ huấn luyện nhận diện biển (tools/camera/): danh sách nhãn, họ hình dạng của
// bộ dò, danh sách biển được học, cách chia tập, bộ sinh số ngẫu nhiên có hạt giống, bộ đọc CSV.
// Thuần logic, chạy được trong Node không cần trình duyệt; tests/models.test.mjs kiểm tra các hằng số ở đây.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(TOOLS_DIR, '..', '..');

// ---------------------------------------------------------------------------------------------
// Nhãn (hợp đồng 1: models/labels.json)
// ---------------------------------------------------------------------------------------------

export const LABELS_VERSION = 1;

/** 11 họ hình dạng mà bộ dò phân biệt, theo đúng thứ tự kênh của đầu ra heat. */
export const FAMILIES = Object.freeze([
  'ring', 'noentry', 'bluering', 'end', 'triangle', 'invtriangle', 'octagon', 'bluedisc', 'bluerect', 'diamond', 'plate',
]);

// Hình dạng trong signart.js → họ của bộ dò. 'cross' (W.242, chữ X) và 'post' (W.243, cột vạch đỏ) là tấm bảng
// trắng có viền hoặc vạch đỏ, không thuộc hình tròn/tam giác/chữ nhật xanh nào, nên xếp chung họ 'plate' với biển phụ.
export const SHAPE_FAMILY = Object.freeze({
  prohibit: 'ring',
  noentry: 'noentry',
  'prohibit-blue': 'bluering',
  end: 'end',
  danger: 'triangle',
  giveway: 'invtriangle',
  stop: 'octagon',
  mandatory: 'bluedisc',
  info: 'bluerect',
  zone: 'bluerect',
  expressway: 'bluerect',
  priority: 'diamond',
  cross: 'plate',
  post: 'plate',
});

export const DET_INPUT = Object.freeze([352, 640, 3]); // cao × rộng × kênh của ảnh vào bộ dò
export const DET_STRIDE = 8; // mỗi ô đầu ra ứng với 8×8 điểm ảnh đầu vào
export const CLS_INPUT = Object.freeze([48, 48, 3]); // ảnh vào bộ phân loại
export const CLS_MARGIN = 0.15; // lề thêm mỗi phía quanh khung biển khi cắt ảnh cho bộ phân loại

/** Trị số tốc độ của các lớp P.127[n]: 20…120 km/h, bước 10. */
export const P127_VALUES = Object.freeze(Array.from({ length: 11 }, (_, i) => String(20 + 10 * i)));

/** 47 nhãn được phép lưu và cảnh báo trong bản đầu (PLAN §2.2, "tier A"). */
export const WHITELIST = Object.freeze([
  ...P127_VALUES.map((v) => `P.127[${v}]`),
  'DP.134', 'DP.135',
  'P.101', 'P.102', 'P.103a', 'P.104', 'P.106a', 'P.115', 'P.117', 'P.123a', 'P.123b', 'P.124a', 'P.124c', 'P.124d',
  'P.125', 'P.130', 'P.131a',
  'R.122', 'W.208', 'W.209', 'W.205', 'W.207', 'R.303',
  'W.201a', 'W.201b', 'W.202a', 'W.202b', 'W.210', 'W.211', 'W.221b', 'W.224', 'W.225', 'W.227', 'W.233',
  'R.302a', 'R.302b',
]);

// Biển gắn với nút giao (PLAN §5.7): R.122, W.208, W.209, P.102, P.123*, P.124*, P.136–P.139.
const JUNCTION_RE = /^(R\.122|W\.208|W\.209|P\.102|P\.123[a-z]*|P\.124[a-z]*|P\.13[6-9])$/;
export const isJunctionCode = (code) => JUNCTION_RE.test(code);

export const OTHER_SIGN = 'other-sign';
export const BACKGROUND = 'background';

/**
 * Danh sách nhãn theo hợp đồng 1: các mã của SIGN_CATALOGUE theo thứ tự khai báo, P.127 thay bằng 11 lớp trị số
 * tại đúng chỗ, rồi "other-sign" và "background".
 */
export function buildLabels(catalogue) {
  const codes = Object.keys(catalogue);
  for (const w of WHITELIST) {
    const code = w.replace(/\[.*$/, '');
    if (!catalogue[code]) throw new Error(`mã trong danh sách học không có trong danh mục: ${w}`);
  }
  const rows = [];
  const add = (label, code, value, family) =>
    rows.push({ label, code, value, family, learn: WHITELIST.includes(label), junction: code ? isJunctionCode(code) : false });
  for (const code of codes) {
    const shape = catalogue[code].art.shape;
    const family = SHAPE_FAMILY[shape];
    if (!family) throw new Error(`hình dạng chưa xếp họ: ${shape} (${code})`);
    if (code === 'P.127') for (const v of P127_VALUES) add(`P.127[${v}]`, code, v, family);
    else add(code, code, null, family);
  }
  add(OTHER_SIGN, null, null, null);
  add(BACKGROUND, null, null, null);
  return {
    version: LABELS_VERSION,
    families: [...FAMILIES],
    det: { input: [...DET_INPUT], stride: DET_STRIDE, out: [DET_INPUT[0] / DET_STRIDE, DET_INPUT[1] / DET_STRIDE] },
    cls: { input: [...CLS_INPUT] },
    T: 1.0,
    labels: rows.map((r, i) => ({ i, ...r })),
    build: { generator: 'tools/camera/labels.mjs', catalogueCodes: codes.length },
  };
}

// ---------------------------------------------------------------------------------------------
// Kế hoạch vẽ dữ liệu cho từng nhãn
// ---------------------------------------------------------------------------------------------

// Hình vẽ của ta dùng chung một hình cho vài mã (cùng dòng trong signs.js). Hai mã của một cặp trái/phải được vẽ
// bằng hình lật gương để mỗi lớp có hình riêng. Theo hình gốc, mã a là bản vòng trái trước, b là bản lật; chiều
// thật chưa đối chiếu với QCVN, nhưng hai mã có cùng tên và câu đọc nên nhầm chiều không đổi lời cảnh báo.
export const MIRROR_OF = Object.freeze({ 'W.201d': 'W.201c', 'W.202b': 'W.202a', 'W.223b': 'W.223a' });

// Trị số hợp lý để in lên biển có số (chỉ để vẽ dữ liệu; bộ phân loại chỉ đọc trị số của P.127).
const VALUE_POOLS = {
  speed: P127_VALUES,
  weight: ['2', '2,5', '3', '5', '7', '10', '13', '15', '18', '30', '40'],
  axle: ['6', '7', '8', '9,5', '10', '11', '12'],
  height: ['2', '2,5', '2,8', '3', '3,2', '3,5', '4', '4,2', '4,5', '4,8'],
  width: ['2', '2,2', '2,5', '2,8', '3'],
  length: ['8', '10', '12', '14', '16', '20'],
  'length-trailer': ['10', '12', '16', '18', '20'],
  gap: ['30', '35', '50', '70', '100'],
};
// Mã dùng hình 'truck' nhưng có số tấn in trên xe (P.106b) — số là chỗ khác biệt duy nhất với P.106a.
const TRUCK_VALUE = { 'P.106b': ['2,5', '3,5', '5', '7', '10', '15'] };

/** Các trị số có thể in lên biển của một mã (null = biển không có số). */
export function valuePool(code, art) {
  if (TRUCK_VALUE[code]) return TRUCK_VALUE[code];
  return VALUE_POOLS[art.pict] || null;
}

/**
 * Cách sinh dữ liệu cho từng nhãn: { kind:'sign', code, art, mirror, values } | { kind:'alias', to } |
 * { kind:'other' } | { kind:'background' }. Nhãn "alias" có hình vẽ giống hệt một nhãn khác (kể cả khi in số),
 * nên không có ảnh huấn luyện riêng: mọi ảnh của hình đó thuộc về nhãn gốc (ưu tiên nhãn trong WHITELIST).
 * Chỉ lấy danh sách nhãn từ labelsJson, không bao giờ lấy cờ learn: eval_synthetic.py --prune có thể gỡ cờ learn
 * trong labels.json, và dữ liệu huấn luyện không được đổi theo kết quả đánh giá lần trước.
 */
export function trainingPlan(labelsJson, catalogue) {
  const out = {};
  const learn = new Set(WHITELIST);
  const groups = new Map();
  for (const l of labelsJson.labels) {
    if (l.label === OTHER_SIGN) out[l.label] = { kind: 'other' };
    else if (l.label === BACKGROUND) out[l.label] = { kind: 'background' };
    if (!l.code) continue;
    const art = catalogue[l.code].art;
    if (l.code === 'P.127') {
      out[l.label] = { kind: 'sign', code: l.code, art, mirror: false, values: [l.value] };
      continue;
    }
    const mirror = Object.hasOwn(MIRROR_OF, l.code);
    const values = valuePool(l.code, art);
    out[l.label] = { kind: 'sign', code: l.code, art, mirror, values };
    // Khoá nhóm: hình vẽ + có in số hay không + lật gương. P.127a/b/c và DP.127 in số giống P.127[n]/DP.134.
    const key = JSON.stringify([art, values ? (art.pict === 'speed' ? 'speed' : values.join('|')) : null, mirror]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l.label);
  }
  // P.127a/b/c vẽ giống hệt P.127[n] với cùng trị số: gom về các lớp P.127[n].
  const speedKey = JSON.stringify([catalogue['P.127'].art, 'speed', false]);
  for (const [key, members] of groups) {
    const canon = key === speedKey ? null : members.find((m) => learn.has(m)) || members[0];
    for (const m of members) {
      if (key === speedKey) out[m] = { kind: 'alias', to: 'P.127[n]' };
      else if (m !== canon) out[m] = { kind: 'alias', to: canon };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phân bố kích thước ảnh cắt cho bộ phân loại
// ---------------------------------------------------------------------------------------------

/** Cạnh thật của biển (điểm ảnh của khung hình camera) khi vẽ ảnh cắt, và độ lệch khung bộ dò. */
export const CROP_SIZES = Object.freeze({
  tinyShare: 0.05, // tối đa 5 % ảnh có biển dưới 18 điểm ảnh (bộ phân loại không chạy dưới 20 điểm ảnh)
  tiny: [14, 18],
  small: [18, 48], // lấy log-đều; chiếm smallSplit số ảnh còn lại
  smallSplit: 0.58,
  large: [48, 400], // lấy log-đều; tới 400 điểm ảnh như bộ phân loại lúc chạy (js/visionproto.js CLS_MAX_W)
});
export const BOX_JITTER = Object.freeze({ scale: 0.15, shift: 0.1 }); // khung bộ dò lệch ±15 % cỡ, ±10 % vị trí

/** Cạnh thật (điểm ảnh) của một ảnh cắt, từ bộ sinh rnd. */
export function nativeWidth(rnd, c = CROP_SIZES) {
  const logU = ([a, b]) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * rnd());
  if (rnd() < c.tinyShare) return c.tiny[0] + (c.tiny[1] - c.tiny[0]) * rnd();
  return rnd() < c.smallSplit ? logU(c.small) : logU(c.large);
}

// ---------------------------------------------------------------------------------------------
// Ngẫu nhiên có hạt giống, băm, chia tập
// ---------------------------------------------------------------------------------------------

/** Băm 32 bit của một chuỗi: FNV-1a, rồi bước trộn cuối của murmur3 để các chuỗi gần giống nhau tách xa nhau. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hạt giống 32 bit dẫn xuất từ nhiều phần (hạt gốc, tên tập, số thứ tự phân đoạn…). */
export const seedOf = (...parts) => hash32(parts.map(String).join('\u0001'));

/** mulberry32: trả về hàm sinh số thực trong [0, 1). Cùng thuật toán với mã chạy trong trang. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SPLITS = Object.freeze(['train', 'val', 'test']);
export const SPLIT_VAL = 0.1; // tỉ lệ ảnh nền dành cho tập kiểm định
export const SPLIT_TEST = 0.1; // tỉ lệ ảnh nền dành cho tập kiểm tra

/**
 * Tập của một ảnh nền, theo mã băm của tác giả (Author của Flickr), không có tác giả thì của ImageID: cố định,
 * không phụ thuộc thứ tự tải. Chia theo tác giả để loạt ảnh cùng một người chụp (cùng phố, cùng buổi) không nằm
 * ở cả tập huấn luyện lẫn tập kiểm tra.
 */
export function splitOf(id, author = '') {
  const key = String(author || '').trim();
  const u = hash32(key ? `split-author:${key}` : `split:${id}`) / 4294967296;
  if (u < SPLIT_TEST) return 'test';
  if (u < SPLIT_TEST + SPLIT_VAL) return 'val';
  return 'train';
}

// Hạt giống của ba tập được tách xa nhau để không bao giờ trùng dãy số.
export const SPLIT_SEED_OFFSET = Object.freeze({ train: 0, val: 1_000_003, test: 2_000_003 });

// ---------------------------------------------------------------------------------------------
// Open Images (ảnh nền)
// ---------------------------------------------------------------------------------------------

/** Chuỗi giấy phép đúng như trong cột License của CSV Open Images. */
export const OI_LICENSE = 'https://creativecommons.org/licenses/by/2.0/';
/** Lớp có hộp cho thấy ảnh là cảnh đường phố. */
export const OI_STREET_CLASSES = Object.freeze(['Car', 'Bus', 'Truck', 'Motorcycle', 'Traffic light', 'Traffic sign', 'Street light']);
export const OI_SIGN_CLASS = 'Traffic sign'; // lớp dùng để biết ảnh đã được người kiểm có/không có biển
// Hộp của các lớp này thành vùng bỏ qua (Stop sign là lớp con của Traffic sign, hộp ghi riêng tên lớp con).
export const OI_SIGN_CLASSES = Object.freeze(['Traffic sign', 'Stop sign']);
export const MIN_BG_WIDTH = 1024; // ảnh nền phải rộng ít nhất chừng này (ảnh dọc bị bỏ)
export const MAX_BG_WIDTH = 1280; // ảnh rộng hơn được thu nhỏ về chừng này
export const OI_BASE = 'https://storage.googleapis.com/openimages';
export const OI_IMAGES = 'https://open-images-dataset.s3.amazonaws.com';
export const OI_META = Object.freeze({
  classes: `${OI_BASE}/v7/oidv7-class-descriptions-boxable.csv`,
  'validation-images': `${OI_BASE}/2018_04/validation/validation-images-with-rotation.csv`,
  'test-images': `${OI_BASE}/2018_04/test/test-images-with-rotation.csv`,
  'validation-bbox': `${OI_BASE}/v5/validation-annotations-bbox.csv`,
  'test-bbox': `${OI_BASE}/v5/test-annotations-bbox.csv`,
  // nhãn mức ảnh do người kiểm (Confidence 1 = có, 0 = không có); khoảng 10,6 MB và 32 MB
  'validation-labels': `${OI_BASE}/v5/validation-annotations-human-imagelabels-boxable.csv`,
  'test-labels': `${OI_BASE}/v5/test-annotations-human-imagelabels-boxable.csv`,
});

/**
 * Tình trạng biển của một ảnh nền, từ nhãn người kiểm của lớp OI_SIGN_CLASS (và các lớp con) và số hộp biển:
 *  - 'present': người kiểm xác nhận có biển, và ảnh có hộp. Theo quy trình của Open Images thì hộp phải đủ, nhưng
 *    khi xem ảnh vẫn thấy biển không có hộp (biển nhỏ, "Stop sign" khi chỉ lớp cha được xác nhận): không sạch;
 *  - 'absent': người kiểm xác nhận không có biển và ảnh không có hộp biển nào: ảnh sạch;
 *  - 'unverified': chưa ai kiểm (gần hết ảnh): có thể có biển thật không có hộp.
 * verified: { present: bool (một lớp biển có Confidence 1), absent: bool (OI_SIGN_CLASS có Confidence 0) }.
 */
export function signStatus(verified, nBoxes) {
  if (verified?.present && nBoxes > 0) return 'present';
  if (verified?.absent && !verified?.present && nBoxes === 0) return 'absent';
  return 'unverified';
}
/** Ảnh nền chắc chắn không có biển thật ngoài các hộp: chỉ 'absent' (lỗi âm của bộ dò được tính đủ trọng số). */
export const isCleanStatus = (s) => s === 'absent';

/** Bộ đọc CSV theo RFC 4180 (trường trong ngoặc kép, "" là dấu ngoặc, xuống dòng trong trường), đọc theo khúc. */
export class CsvParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quotePending = false;
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (ch === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
        } else if (ch === '"') {
          this.quotePending = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }
      if (ch === '"' && this.field === '') this.inQuotes = true;
      else if (ch === ',') {
        this.row.push(this.field);
        this.field = '';
      } else if (ch === '\n') this.endRow();
      else if (ch !== '\r') this.field += ch;
    }
  }

  endRow() {
    this.row.push(this.field);
    this.field = '';
    const r = this.row;
    this.row = [];
    if (r.length > 1 || r[0] !== '') this.onRow(r);
  }

  end() {
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.field !== '' || this.row.length) this.endRow();
  }
}

/** Đọc một tệp CSV, gọi onRow(mảng trường) cho từng dòng (kể cả dòng đầu). */
export async function readCsvRows(path, onRow) {
  const p = new CsvParser(onRow);
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) p.push(chunk);
  p.end();
}

/** Đọc một tệp CSV có dòng tiêu đề, gọi onRow(object) cho từng dòng. */
export async function readCsv(path, onRow) {
  let header = null;
  const p = new CsvParser((r) => {
    if (!header) header = r;
    else {
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = r[i] ?? '';
      onRow(o);
    }
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) p.push(chunk);
  p.end();
}

// ---------------------------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------------------------

/** "--khoá giá trị" và "--cờ" → object; giá trị được ép kiểu theo giá trị mặc định (số, true/false). */
export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`tham số lạ: ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    let v;
    if (next === undefined || next.startsWith('--')) v = true;
    else {
      v = next;
      i++;
    }
    const d = defaults[key];
    if (typeof d === 'number') v = Number(v);
    else if (typeof d === 'boolean') v = v === true || v === 'true' || v === '1';
    out[key] = v;
  }
  return out;
}

export function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/** Ghi tệp qua tệp tạm rồi đổi tên, để một lần chạy bị dừng giữa chừng không để lại tệp dở. */
export function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Nạp Playwright: PLAYWRIGHT_MODULE nếu có, không thì gói "playwright" cài toàn cục. */
export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  return req(process.env.PLAYWRIGHT_MODULE || 'playwright');
}

/** Chrome dùng để vẽ: CHROME_PATH, rồi /usr/bin/google-chrome, rồi bản Chromium đi kèm Playwright. */
export function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

export const labelsPath = (p) => p || join(APP_ROOT, 'models', 'labels.json');

// ---------------------------------------------------------------------------------------------
// Nguồn gốc bản dựng (ghi vào labels.json build.provenance và MODEL_CARD.md)
// ---------------------------------------------------------------------------------------------

/** Các tệp quyết định dữ liệu và cách huấn luyện (đường dẫn tính từ thư mục ứng dụng). */
export const TRAINING_SOURCES = Object.freeze([
  'js/signart.js', 'js/signs.js',
  'tools/camera/bdcommon.py', 'tools/camera/calibrate.py', 'tools/camera/eval_synthetic.py', 'tools/camera/export.py',
  'tools/camera/fetch-backgrounds.mjs', 'tools/camera/labels.mjs', 'tools/camera/lib.mjs',
  'tools/camera/render-common.mjs', 'tools/camera/render-crops.mjs', 'tools/camera/render-page.js',
  'tools/camera/render-scenes.mjs', 'tools/camera/requirements.txt', 'tools/camera/sanitize_images.py',
  'tools/camera/steps.sh', 'tools/camera/synth-art.mjs', 'tools/camera/train-all.sh',
  'tools/camera/train_classifier.py', 'tools/camera/train_detector.py',
]);

/**
 * Dấu của hình vẽ biển mà dữ liệu tổng hợp dựa vào: SHA-256 của js/signart.js cùng mã và thuộc tính `art` của
 * từng mục trong danh mục (theo thứ tự). Đổi tên, câu đọc hay trường khác của signs.js không đổi dấu này; đổi
 * hình vẽ thì đổi, nghĩa là mô hình đã cũ và cần huấn luyện lại.
 */
export function artDigest(catalogue, signartText) {
  const art = Object.keys(catalogue).map((code) => [code, catalogue[code].art]);
  return sha256Buf(Buffer.from(`${sha256Buf(Buffer.from(signartText))}\n${JSON.stringify(art)}`));
}

/**
 * Nguồn gốc của một bản dựng: commit, có thay đổi chưa commit hay không (trong thư mục ứng dụng), SHA-256 của các
 * tệp TRAINING_SOURCES và artDigest. run(cmd, args) trả về stdout (để kiểm thử không cần git); thiếu git thì null.
 */
export function provenance({ root = APP_ROOT, catalogue, run } = {}) {
  const git = (args) => {
    try {
      return run(args);
    } catch {
      return null;
    }
  };
  const commit = git(['-C', root, 'rev-parse', 'HEAD'])?.trim() || null;
  const status = git(['-C', root, 'status', '--porcelain', '--', '.']);
  const changed = status == null ? null : status.split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
  const sources = {};
  for (const rel of TRAINING_SOURCES) {
    const p = join(root, rel);
    sources[rel] = existsSync(p) ? sha256Buf(readFileSync(p)) : null;
  }
  return {
    gitCommit: commit,
    gitDirty: changed == null ? null : changed.length > 0,
    gitChanged: changed == null ? null : changed.slice(0, PROVENANCE_MAX_CHANGED),
    sources,
    artDigest: catalogue ? artDigest(catalogue, readFileSync(join(root, 'js', 'signart.js'), 'utf8')) : null,
  };
}
export const PROVENANCE_MAX_CHANGED = 50; // số đường dẫn chưa commit ghi lại tối đa (đủ để thấy, không phình tệp)
