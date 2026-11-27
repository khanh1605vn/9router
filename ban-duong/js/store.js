// Lưu cài đặt, địa điểm, điểm cảnh báo tự đánh dấu và nhật ký chuyến đi trên chính thiết bị.
// localStorage có thể bị chặn (chế độ ẩn danh, hết dung lượng) nên mọi thao tác đều bọc try/catch
// và ứng dụng vẫn chạy bình thường với dữ liệu trong bộ nhớ.

import { validDirection, validSpeed } from './communitydata.js';

const PREFIX = 'banduong:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* bỏ qua: dữ liệu vẫn nằm trong bộ nhớ cho phiên hiện tại */
  }
}

export const DEFAULT_SETTINGS = {
  vehicle: 'car', // 'car' | 'moto'
  avoidTolls: false,
  voice: true,
  beeps: true,
  muted: false, // tắt tiếng nhanh bằng nút loa trên bản đồ
  speakLimit: true, // đọc giới hạn tốc độ khi đổi
  overTolerance: 3, // km/h cho phép vượt trước khi báo động
  customMax: 0, // km/h, 0 = tắt; dùng khi đường chưa có dữ liệu giới hạn
  alertCamera: true,
  alertToll: true,
  alertRail: true, // đường ngang đường sắt (nay do bộ máy biển báo đọc)
  alertReport: true,
  communityData: true, // dùng dữ liệu cộng đồng (data/community.json, js/community.js)
  // Nhóm biển báo phía trước (xem SIGN_CATEGORIES trong signs.js)
  signSpeed: true,
  signProhibit: true,
  signPriority: true,
  signDanger: true,
  signSignals: true,
  signCalming: true,
  signCrossing: false, // vạch qua đường rất dày ở đô thị nên mặc định tắt
  signInfo: true,
  // Kết nối với ô tô
  obdUseSpeed: true, // dùng tốc độ do xe báo khi có
  obdAutoSerial: false, // tự mở lại bộ OBD Bluetooth thường đã dùng lần trước
  carUi: 'auto', // giao diện màn hình ô tô: 'auto' | 'on' | 'off'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  keepAwake: true,
  iosHintDismissed: false, // đã ẩn gợi ý "thêm vào Màn hình chính" trên iPhone, iPad (js/ios.js)
  // Camera nhận diện biển (thử nghiệm)
  camEnabled: false, // chỉ bật được bằng tay khi xe đã đỗ
  camDeviceId: null, // camera đã chọn ở mục kiểm tra camera; null = camera sau của điện thoại
  // chỉnh điểm tụ (px của khung hình) so với mặc định: giữa khung, 0,42 chiều cao. Đóng băng vì settings chỉ chép nông
  // từ đây: luôn lưu bằng store.set('camAim', { dx, dy }) với đối tượng mới, không sửa tại chỗ.
  camAim: Object.freeze({ dx: 0, dy: 0 }),
  signCamera: true, // báo các biển do camera ghi nhận
  camSpeed: true, // dùng biển tốc độ do camera ghi nhận cho đồng hồ tốc độ (không bao giờ nâng giới hạn)
  camEval: false, // lưu ảnh biển nhỏ trên máy để kiểm tra độ chính xác
};

/**
 * Loại điểm người dùng tự đánh dấu. ttl = thời gian tồn tại (giờ), 0 = giữ mãi. warn: false = chỉ hiện trên bản đồ và
 * gửi cho chủ ứng dụng, không báo khi lái (biển đã tháo thì không có gì để báo).
 */
export const REPORT_TYPES = {
  camera: { label: 'Camera phạt nguội', icon: 'camera', ttl: 0 },
  camspeed: { label: 'Camera bắn tốc độ', icon: 'camera', ttl: 0 },
  camred: { label: 'Camera phạt vượt đèn đỏ', icon: 'camera', ttl: 0 },
  signnew: { label: 'Biển báo mới', icon: 'hazard', ttl: 0 },
  signgone: { label: 'Biển báo đã tháo', icon: 'hazard', ttl: 0, warn: false },
  speed: { label: 'Tốc độ tối đa thay đổi', icon: 'hazard', ttl: 0 },
  closure: { label: 'Đường cấm, rào chắn', icon: 'works', ttl: 24 * 30 },
  school: { label: 'Cổng trường học', icon: 'school', ttl: 0 },
  hazard: { label: 'Điểm nguy hiểm', icon: 'hazard', ttl: 0 },
  works: { label: 'Công trường', icon: 'works', ttl: 24 * 30 },
  flood: { label: 'Ngập nước', icon: 'flood', ttl: 6 },
  jam: { label: 'Kẹt xe', icon: 'jam', ttl: 1 },
  crash: { label: 'Tai nạn', icon: 'crash', ttl: 2 },
};

const CODE_RE = /^(?:P|R|W|I|S|DP|IE)\.\d{3}[a-z]{0,2}$/;

/**
 * Thông tin thêm của một điểm đánh dấu, đã lọc: direction (độ, số nguyên 0–359, hướng xe chạy lúc đánh dấu),
 * value (km/h, chỉ cho loại 'speed'), code (mã biển QCVN, chỉ cho loại 'signnew'). Sai hay thiếu thì bỏ, không đoán.
 */
export function reportExtra(type, extra) {
  const out = {};
  if (!extra || typeof extra !== 'object') return out;
  if (typeof extra.direction === 'number' && Number.isFinite(extra.direction)) {
    const d = Math.round(((extra.direction % 360) + 360) % 360) % 360;
    if (validDirection(d)) out.direction = d;
  }
  if (type === 'speed' && validSpeed(extra.value)) out.value = extra.value;
  if (type === 'signnew' && typeof extra.code === 'string' && CODE_RE.test(extra.code.trim())) out.code = extra.code.trim();
  return out;
}

class Store {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...read('settings', {}) };
    this.places = { home: null, work: null, recents: [], ...read('places', {}) };
    this.reports = this.#fresh(read('reports', []));
    this.trips = read('trips', []);
    this.listeners = new Set();
  }

  #fresh(list) {
    const now = Date.now();
    return (Array.isArray(list) ? list : []).filter((r) => {
      const def = REPORT_TYPES[r?.type];
      if (!def || !Array.isArray(r.coord)) return false;
      if (r.type === 'speed' && !validSpeed(r.value)) return false; // "tốc độ đổi" mà không có trị số thì vô nghĩa
      return def.ttl === 0 || now - r.time < def.ttl * 3600e3;
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(what) {
    for (const fn of this.listeners) fn(what);
  }

  set(key, value) {
    this.settings[key] = value;
    write('settings', this.settings);
    this.#emit('settings');
  }

  savePlace(slot, place) {
    this.places[slot] = place;
    write('places', this.places);
    this.#emit('places');
  }

  addRecent(place) {
    const same = (p) => Math.abs(p.coord[0] - place.coord[0]) < 1e-5 && Math.abs(p.coord[1] - place.coord[1]) < 1e-5;
    this.places.recents = [place, ...this.places.recents.filter((p) => !same(p))].slice(0, 8);
    write('places', this.places);
    this.#emit('places');
  }

  /** extra: { direction, value, code } (xem reportExtra). */
  addReport(type, coord, extra = null) {
    const report = {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      coord: [Number(coord[0].toFixed(6)), Number(coord[1].toFixed(6))],
      time: Date.now(),
      ...reportExtra(type, extra),
    };
    this.reports.push(report);
    write('reports', this.reports);
    this.#emit('reports');
    return report;
  }

  removeReport(id) {
    this.reports = this.reports.filter((r) => r.id !== id);
    write('reports', this.reports);
    this.#emit('reports');
  }

  /** Dọn các điểm đã hết hạn; trả về true nếu có thay đổi. */
  pruneReports() {
    const fresh = this.#fresh(this.reports);
    if (fresh.length === this.reports.length) return false;
    this.reports = fresh;
    write('reports', this.reports);
    this.#emit('reports');
    return true;
  }

  /** Nhập danh sách điểm từ tệp chia sẻ; bỏ qua mục không hợp lệ hoặc trùng vị trí. */
  importReports(list) {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const item of list) {
      const coord = item?.coord;
      if (!REPORT_TYPES[item?.type] || !Array.isArray(coord)) continue;
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) continue;
      const dup = this.reports.some(
        (r) => r.type === item.type && Math.abs(r.coord[0] - lon) < 1e-4 && Math.abs(r.coord[1] - lat) < 1e-4
      );
      if (dup) continue;
      const extra = reportExtra(item.type, item);
      if (item.type === 'speed' && extra.value == null) continue;
      this.reports.push({
        id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: item.type,
        coord: [lon, lat],
        time: Number(item.time) || Date.now(),
        ...extra,
      });
      added++;
    }
    if (added) {
      this.reports = this.#fresh(this.reports);
      write('reports', this.reports);
      this.#emit('reports');
    }
    return added;
  }

  addTrip(trip) {
    this.trips = [trip, ...this.trips].slice(0, 30);
    write('trips', this.trips);
    this.#emit('trips');
  }
}

export const store = new Store();
