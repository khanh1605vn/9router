// Lưu cài đặt, địa điểm, điểm cảnh báo tự đánh dấu và nhật ký chuyến đi trên chính thiết bị.
// localStorage có thể bị chặn (chế độ ẩn danh, hết dung lượng) nên mọi thao tác đều bọc try/catch
// và ứng dụng vẫn chạy bình thường với dữ liệu trong bộ nhớ.

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
};

/** Loại điểm người dùng tự đánh dấu. ttl = thời gian tồn tại (giờ), 0 = giữ mãi. */
export const REPORT_TYPES = {
  camera: { label: 'Camera phạt nguội', icon: 'camera', ttl: 0 },
  school: { label: 'Cổng trường học', icon: 'school', ttl: 0 },
  hazard: { label: 'Điểm nguy hiểm', icon: 'hazard', ttl: 0 },
  works: { label: 'Công trường', icon: 'works', ttl: 24 * 30 },
  flood: { label: 'Ngập nước', icon: 'flood', ttl: 6 },
  jam: { label: 'Kẹt xe', icon: 'jam', ttl: 1 },
  crash: { label: 'Tai nạn', icon: 'crash', ttl: 2 },
};

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

  addReport(type, coord) {
    const report = {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      coord: [Number(coord[0].toFixed(6)), Number(coord[1].toFixed(6))],
      time: Date.now(),
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
      this.reports.push({
        id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: item.type,
        coord: [lon, lat],
        time: Number(item.time) || Date.now(),
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
