// Kho "dữ liệu cộng đồng" (data/community.json): định dạng và bộ kiểm tra nghiêm ngặt. Thuần logic, không đụng DOM,
// dùng chung cho ứng dụng (js/community.js) và công cụ của chủ ứng dụng (tools/community/add-reports.mjs).
//
// Tệp là dữ liệu từ ngoài vào (kể cả bản tải về từ GitHub Pages), nên được coi là không tin cậy:
//  - chỉ nhận các loại trong danh sách, toạ độ trong khung Việt Nam, số trong khoảng cho phép;
//  - chuỗi bị cắt ký tự điều khiển và giới hạn độ dài; trường lạ bị bỏ; mục sai bị bỏ lặng lẽ (không đoán);
//  - không bao giờ chạy hay hiển thị HTML từ tệp: chữ chỉ đi qua textContent.
//
// Định dạng (schema 1):
// { "schema": 1, "updated": "YYYY-MM-DD", "items": [ { "id", "type", "coord": [kinh độ, vĩ độ], "direction"?,
//   "value"?, "code"?, "note"?, "source", "verified": "YYYY-MM-DD", "until"?: "YYYY-MM-DD" } ] }

import { lookupSign } from './signs.js';

export const COMMUNITY_SCHEMA = 1;

/** Các loại được nhận. Loại khác (kể cả của schema sau này) bị bỏ qua. */
export const COMMUNITY_TYPES = Object.freeze([
  'camera-speed', // camera bắn tốc độ; value = giới hạn km/h nếu biết
  'camera-redlight', // camera phạt vượt đèn đỏ
  'camera-traffic', // camera giám sát giao thông (phạt nguội nói chung)
  'speed-limit', // biển tốc độ tối đa; value bắt buộc
  'sign', // biển báo khác; code (mã QCVN 41:2024) bắt buộc
  'hazard', // điểm nguy hiểm
  'closure', // đường cấm, rào chắn
]);
const TYPE_SET = new Set(COMMUNITY_TYPES);
const VALUE_TYPES = new Set(['camera-speed', 'speed-limit']);

// Khung chữ nhật thô quanh Việt Nam, gồm cả Hoàng Sa và Trường Sa. Khung chữ nhật nên vẫn gồm một phần nước láng
// giềng: đây chỉ là chặn toạ độ vô lý (đảo kinh/vĩ độ, 0,0…), không phải kiểm tra biên giới.
export const VN_BBOX = Object.freeze({ west: 102.1, south: 6.0, east: 117.9, north: 23.5 });

export const MAX_ITEMS = 5000;
export const MAX_BYTES = 1_500_000; // cả tệp, tính theo byte UTF-8
export const MAX_ID = 48;
export const MAX_NOTE = 120;
export const MAX_SOURCE = 60;
export const SPEED_MIN = 5;
export const SPEED_MAX = 130;
export const SPEED_STEP = 5;
// Ngày "updated" ở tương lai quá chừng này (ngày) thì cả tệp bị bỏ: một ngày sai kiểu 2099 sẽ thắng mãi mọi bản mới.
export const FUTURE_SLACK_DAYS = 2;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODE_RE = /^(?:P|R|W|I|S|DP|IE)\.\d{3}[a-z]{0,2}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Ký tự điều khiển (Cc: C0/C1) và mọi ký tự định dạng vô hình (Cf: ký tự định hướng bidi như U+202E, U+2066–U+2069,
// U+061C, dấu gạch mềm U+00AD, U+180E, U+200B–U+200F, U+2060–U+2064, U+FEFF, ký tự thẻ U+E0000–U+E007F…): có thể
// làm chữ hiện sai thứ tự hay giấu chữ để giả mạo. Thêm nửa cặp UTF-16 lẻ (Cs) và dấu ngắt dòng, ngắt đoạn (U+2028, U+2029).
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Độ dài byte UTF-8 của chuỗi. */
export function byteLength(s) {
  return new TextEncoder().encode(String(s)).length;
}

/** "YYYY-MM-DD" hợp lệ (đúng ngày có thật, năm 2020–2100) → số ngày kể từ 1970-01-01; sai → null. */
export function dayNumber(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 864e5;
}

/** Ngày theo giờ máy dưới dạng "YYYY-MM-DD". */
export function isoDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "YYYY-MM-DD" → "dd/mm/yyyy" (cách viết ngày ở Việt Nam); sai → chuỗi rỗng. */
export function viDate(iso) {
  if (dayNumber(iso) == null) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Chuỗi gọn: bỏ ký tự điều khiển, gộp khoảng trắng. Không phải chuỗi → null. */
export function cleanString(v) {
  if (typeof v !== 'string') return null;
  return v.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Toạ độ [kinh độ, vĩ độ] nằm trong khung Việt Nam. */
export function inVietnam(coord) {
  if (!Array.isArray(coord) || coord.length !== 2) return false;
  const [lon, lat] = coord;
  return (
    typeof lon === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= VN_BBOX.west &&
    lon <= VN_BBOX.east &&
    lat >= VN_BBOX.south &&
    lat <= VN_BBOX.north
  );
}

/** Giới hạn tốc độ hợp lệ: số nguyên 5–130, bội của 5. */
export function validSpeed(v) {
  return Number.isInteger(v) && v >= SPEED_MIN && v <= SPEED_MAX && v % SPEED_STEP === 0;
}

/** Hướng hợp lệ: số nguyên 0–359 (độ, theo chiều xe chạy mà điểm áp dụng; 0 = Bắc, 90 = Đông). */
export function validDirection(v) {
  return Number.isInteger(v) && v >= 0 && v <= 359;
}

/**
 * Mã biển dùng được cho loại 'sign': đúng dạng QCVN (P.103a, W.207b, DP.135, IE.452…), có trong danh mục của ứng
 * dụng, và không cần con số đi kèm (biển có {n} như P.127 hay P.117 không đọc được khi thiếu trị số: dùng
 * 'speed-limit' cho biển tốc độ). Trả về mã đã chuẩn hoá hoặc null.
 */
export function signCode(v) {
  const s = cleanString(v);
  if (!s || !CODE_RE.test(s)) return null;
  const entry = lookupSign(s);
  if (!entry || /\{n\}/.test(entry.say || '') || /\{n\}/.test(entry.name || '')) return null;
  return s;
}

/** Mã định danh ổn định từ loại và toạ độ (không chứa thời điểm báo cáo). */
export function communityId(type, coord) {
  const [lon, lat] = coord;
  return `${type}-${lat.toFixed(5)}-${lon.toFixed(5)}`;
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Kiểm tra và làm sạch một mục. Trả về { item } (mục mới, chỉ các trường đã biết), { expired: true } (hết hạn
 * 'until'), hoặc { error: 'lý do' }.
 * @param today "YYYY-MM-DD" (giờ máy) để so 'until' và 'verified'.
 */
export function normalizeItem(raw, today) {
  if (!isPlainObject(raw)) return { error: 'không phải đối tượng' };
  const todayN = dayNumber(today);
  if (todayN == null) return { error: 'thiếu ngày hôm nay' };
  const type = raw.type;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) return { error: 'loại không hỗ trợ' };
  if (!inVietnam(raw.coord)) return { error: 'toạ độ ngoài Việt Nam hoặc sai dạng' };
  const coord = [round6(raw.coord[0]), round6(raw.coord[1])];
  const item = { id: '', type, coord };

  if (own(raw, 'id') && raw.id != null) {
    const id = raw.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID || !ID_RE.test(id)) return { error: 'id sai dạng' };
    item.id = id;
  } else {
    item.id = communityId(type, coord);
  }

  if (own(raw, 'direction') && raw.direction != null) {
    if (!validDirection(raw.direction)) return { error: 'hướng phải là số nguyên 0–359' };
    item.direction = raw.direction;
  }

  if (VALUE_TYPES.has(type)) {
    const has = own(raw, 'value') && raw.value != null;
    if (has && !validSpeed(raw.value)) return { error: 'tốc độ phải là số nguyên 5–130, bội của 5' };
    if (!has && type === 'speed-limit') return { error: 'thiếu tốc độ (value)' };
    if (has) item.value = raw.value;
  }

  if (type === 'sign') {
    const code = signCode(raw.code);
    if (!code) return { error: 'thiếu mã biển hoặc mã biển không dùng được' };
    item.code = code;
  }

  if (own(raw, 'note') && raw.note != null) {
    const note = cleanString(raw.note);
    if (note == null || note.length > MAX_NOTE) return { error: `ghi chú quá ${MAX_NOTE} ký tự hoặc sai dạng` };
    if (note) item.note = note;
  }

  const source = cleanString(raw.source);
  if (!source || source.length > MAX_SOURCE) return { error: `thiếu nguồn hoặc nguồn quá ${MAX_SOURCE} ký tự` };
  item.source = source;

  const verifiedN = dayNumber(raw.verified);
  if (verifiedN == null) return { error: 'ngày xác minh (verified) sai dạng YYYY-MM-DD' };
  if (verifiedN > todayN + 1) return { error: 'ngày xác minh ở tương lai' };
  item.verified = raw.verified;

  if (own(raw, 'until') && raw.until != null) {
    const untilN = dayNumber(raw.until);
    if (untilN == null || untilN < verifiedN) return { error: 'ngày hết hạn (until) sai' };
    if (untilN < todayN) return { expired: true };
    item.until = raw.until;
  }
  return { item };
}

/**
 * Kiểm tra cả tệp. input là chuỗi JSON (giới hạn MAX_BYTES) hoặc đối tượng đã đọc.
 * @returns { ok: true, data: { schema, updated, items }, stats: { total, kept, rejected, expired, errors } }
 *        | { ok: false, error }
 * errors: tối đa 50 dòng "mục i: lý do" để công cụ của chủ ứng dụng in ra (ứng dụng không hiện).
 */
export function validateCommunity(input, { today } = {}) {
  if (dayNumber(today) == null) return { ok: false, error: 'thiếu ngày hôm nay' };
  let doc = input;
  if (typeof input === 'string') {
    if (byteLength(input) > MAX_BYTES) return { ok: false, error: 'tệp quá lớn' };
    try {
      doc = JSON.parse(input);
    } catch {
      return { ok: false, error: 'không phải JSON' };
    }
  }
  if (!isPlainObject(doc)) return { ok: false, error: 'không phải đối tượng' };
  if (doc.schema !== COMMUNITY_SCHEMA) return { ok: false, error: 'schema không hỗ trợ' };
  const updatedN = dayNumber(doc.updated);
  if (updatedN == null) return { ok: false, error: 'ngày cập nhật (updated) sai dạng' };
  if (updatedN > dayNumber(today) + FUTURE_SLACK_DAYS) return { ok: false, error: 'ngày cập nhật ở tương lai' };
  if (!Array.isArray(doc.items)) return { ok: false, error: 'thiếu danh sách items' };
  if (doc.items.length > MAX_ITEMS) return { ok: false, error: `quá ${MAX_ITEMS} mục` };

  const items = [];
  const ids = new Set();
  const errors = [];
  let rejected = 0;
  let expired = 0;
  doc.items.forEach((raw, i) => {
    const r = normalizeItem(raw, today);
    if (r.expired) {
      expired++;
      return;
    }
    if (r.item && ids.has(r.item.id)) r.error = 'id trùng';
    if (r.error) {
      rejected++;
      if (errors.length < 50) errors.push(`mục ${i}: ${r.error}`);
      return;
    }
    ids.add(r.item.id);
    items.push(r.item);
  });
  return {
    ok: true,
    data: { schema: COMMUNITY_SCHEMA, updated: doc.updated, items },
    stats: { total: doc.items.length, kept: items.length, rejected, expired, errors },
  };
}
