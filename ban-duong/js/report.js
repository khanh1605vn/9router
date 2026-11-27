// Báo cáo của người dùng: chọn loại khi xe đứng yên (khi đang chạy chỉ một nút "Camera ở đây"), lưu ngay trên máy
// (điểm tự đánh dấu, nên máy này được nhắc ngay), và gửi cho chủ ứng dụng bằng chữ ngắn (Zalo, tin nhắn…), bằng
// đường dẫn mở trang tạo issue trên GitHub, hoặc bằng tệp xuất theo định dạng của data/community.json.
// Thuần logic, không đụng DOM.
//
// Riêng tư: không bao giờ gửi tên, số điện thoại, tài khoản hay giờ phút báo cáo; chỉ ngày, toạ độ làm tròn 5 chữ số
// thập phân (khoảng 1 m) và hướng xe chạy (độ).

import { lookupSign } from './signs.js';
import { REPORT_TYPES } from './store.js';
import { COMMUNITY_SCHEMA, isoDate, validSpeed, viDate } from './communitydata.js';

export const QUICK_KMH = 10; // chạy nhanh hơn chừng này (km/h) thì chỉ còn nút "Camera ở đây"
export const QUICK_TYPE = 'camera'; // loại mà nút "Camera ở đây" lưu (camera phạt nguội nói chung)
export const HEADING_MIN_SPEED = 2; // m/s; chậm hơn thì hướng GPS không đáng tin, không lưu hướng
export const ISSUE_URL = 'https://github.com/khanh1605vn/9router/issues/new';
export const MAX_TITLE = 80;
export const MAX_BODY = 1500;
export const MAX_URL = 4000;
export const REPORT_SOURCE = 'Người dùng Bạn Đường báo cáo';
export const SPEED_CHOICES = Object.freeze([20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);

/** Các loại trong nút "Báo cáo" (gửi được cho chủ ứng dụng), theo thứ tự hiện. */
export const REPORT_MENU = Object.freeze(['camspeed', 'camred', 'signnew', 'signgone', 'speed', 'closure']);

/**
 * Loại điểm đánh dấu → loại trong data/community.json. null: chỉ gửi để chủ ứng dụng sửa bản đồ (biển đã tháo), không
 * có mục tương ứng trong kho. Loại không có ở đây (trường học, kẹt xe…) không gửi đi.
 */
export const COMMUNITY_TYPE_OF = Object.freeze({
  camspeed: 'camera-speed',
  camred: 'camera-redlight',
  camera: 'camera-traffic',
  signnew: 'sign',
  signgone: null,
  speed: 'speed-limit',
  closure: 'closure',
  hazard: 'hazard',
});

export const sendable = (type) => Object.prototype.hasOwnProperty.call(COMMUNITY_TYPE_OF, type);

/**
 * Chế độ của nút "Báo cáo" theo tốc độ (km/h; null = không biết, coi như đứng yên vì không có tốc độ thì cũng không có
 * hướng): 'quick' = chỉ một nút "Camera ở đây", 'full' = chọn loại và gửi.
 */
export function reportMode(kmh) {
  return typeof kmh === 'number' && Number.isFinite(kmh) && kmh > QUICK_KMH ? 'quick' : 'full';
}

/** Hướng xe chạy để lưu kèm điểm: chỉ khi GPS đủ nhanh để hướng đáng tin; ngược lại null. */
export function captureHeading(fix) {
  const h = fix?.heading;
  if (typeof h !== 'number' || !Number.isFinite(h) || !((fix.speed || 0) >= HEADING_MIN_SPEED)) return null;
  return Math.round(((h % 360) + 360) % 360) % 360;
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const f5 = (x) => x.toFixed(5);

/** Ngày (theo giờ máy) của điểm đánh dấu, "YYYY-MM-DD"; không có giờ phút. */
export function reportDate(report) {
  const t = Number(report?.time);
  return isoDate(Number.isFinite(t) && t > 0 ? new Date(t) : new Date());
}

/** Tên loại kèm trị số hay tên biển, ví dụ "Tốc độ tối đa thay đổi: 60 km/h". */
export function reportLabel(report) {
  const def = REPORT_TYPES[report.type];
  if (!def) return 'Điểm cần chú ý';
  if (report.type === 'speed' && validSpeed(report.value)) return `${def.label}: ${report.value} km/h`;
  if (report.type === 'signnew' && report.code) {
    const entry = lookupSign(report.code);
    return entry ? `${def.label}: ${report.code} (${entry.name})` : `${def.label}: ${report.code}`;
  }
  return def.label;
}

/** Đường dẫn OpenStreetMap tới điểm (mở được trong Zalo, trình duyệt). */
export function osmLink(coord) {
  const [lon, lat] = coord;
  return `https://www.openstreetmap.org/?mlat=${f5(lat)}&mlon=${f5(lon)}#map=19/${f5(lat)}/${f5(lon)}`;
}

/**
 * Mục theo định dạng data/community.json (chưa xác minh: "verified" là ngày người dùng thấy; công cụ của chủ ứng dụng
 * đặt lại ngày xác minh). null nếu loại không gửi vào kho được.
 */
export function communityItem(report) {
  const type = COMMUNITY_TYPE_OF[report?.type];
  if (!type || !Array.isArray(report.coord)) return null;
  const item = { type, coord: [r5(report.coord[0]), r5(report.coord[1])] };
  if (Number.isInteger(report.direction)) item.direction = report.direction;
  if ((type === 'speed-limit' || type === 'camera-speed') && validSpeed(report.value)) item.value = report.value;
  if (type === 'sign' && report.code) item.code = report.code;
  item.source = REPORT_SOURCE;
  item.verified = reportDate(report);
  return item;
}

/** Chữ ngắn để chia sẻ (Zalo, tin nhắn, bộ nhớ tạm). Dòng cuối là mục JSON cho công cụ của chủ ứng dụng. */
export function shareText(report) {
  const [lon, lat] = report.coord;
  const lines = [`Bạn Đường – báo cáo: ${reportLabel(report)}`];
  const dir = Number.isInteger(report.direction) ? ` · hướng xe chạy ${report.direction}°` : '';
  lines.push(`Vị trí: ${f5(lat)}, ${f5(lon)}${dir}`);
  lines.push(`Ngày thấy: ${viDate(reportDate(report))}`);
  lines.push(`Bản đồ: ${osmLink(report.coord)}`);
  if (report.type === 'signnew' && !report.code) lines.push('Chưa rõ mã biển: chủ ứng dụng cần xem tại chỗ.');
  if (report.type === 'signgone') lines.push('Biển không còn ở đây: cần sửa bản đồ.');
  const item = communityItem(report);
  if (item) lines.push(JSON.stringify(item));
  return lines.join('\n');
}

const NOTICE =
  'Gửi từ ứng dụng Bạn Đường. Nội dung không kèm tên, số điện thoại hay giờ báo cáo, chỉ có ngày và vị trí; ' +
  'GitHub vẫn hiện giờ tạo issue.';

/** Đường dẫn mở trang tạo issue trên GitHub, tiêu đề và nội dung điền sẵn (mã hoá URL, có giới hạn độ dài). */
export function githubIssueUrl(report) {
  const [lon, lat] = report.coord;
  let title = `Báo cáo: ${reportLabel(report)} tại ${f5(lat)}, ${f5(lon)}`;
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1)}…`;
  let body = `${shareText(report)}\n\n${NOTICE}`;
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
  let url = `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  // Chữ tiếng Việt mã hoá dài gấp mấy lần: còn quá dài thì chỉ giữ dòng JSON (đủ cho công cụ của chủ ứng dụng).
  if (url.length > MAX_URL) {
    const item = communityItem(report);
    body = item ? JSON.stringify(item) : `${f5(lat)}, ${f5(lon)}`;
    url = `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }
  return url;
}

/** Tệp "Xuất cho kho dữ liệu": các điểm gửi vào kho được, theo định dạng mục của data/community.json. */
export function exportForRepo(reports, { today = isoDate() } = {}) {
  const items = [];
  for (const r of reports || []) {
    const item = communityItem(r);
    if (item) items.push(item);
  }
  return { schema: COMMUNITY_SCHEMA, kind: 'ban-duong-reports', exported: today, items };
}

/**
 * Tên, câu đọc và biểu tượng riêng của điểm tự đánh dấu có trị số hoặc mã biển (cho AlertEngine qua withOwnInfo);
 * null: dùng describePoint như cũ.
 */
export function localPointInfo(report) {
  const def = REPORT_TYPES[report?.type];
  if (!def) return null;
  if (report.type === 'speed' && validSpeed(report.value)) {
    return {
      title: `Tốc độ tối đa ${report.value} km/h (bạn đánh dấu)`,
      say: `có biển tốc độ tối đa ${report.value} ki lô mét trên giờ`,
      icon: def.icon,
    };
  }
  if (report.type === 'signnew' && report.code) {
    const entry = lookupSign(report.code);
    if (entry && entry.say && !/\{n\}/.test(entry.say + entry.name)) {
      return { title: `${entry.name} (bạn đánh dấu)`, say: entry.say, icon: def.icon };
    }
  }
  return null;
}
