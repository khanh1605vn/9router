// Kho biển báo do camera trên xe ghi nhận (thử nghiệm). Thuần logic, không đụng tới DOM; lưu trữ qua một
// "backend" thay được: bộ nhớ trong (kiểm thử) hoặc IndexedDB 'banduong-learned' (tách riêng khỏi bộ đệm dữ liệu
// đường 'banduong', để xoá bộ đệm đường không xoá biển đã học).
// Mỗi biển là một bản ghi có điểm tin cậy L (log-odds bị chặn): thấy lại thì cộng, đi qua mà không thấy (đủ điều
// kiện) thì trừ. Biển chỉ được đọc khi đã thấy vào ít nhất hai ngày khác nhau. Không lưu giờ của từng lần thấy,
// không lưu chuyến đi, không lưu hình ảnh: chỉ có số thứ tự ngày (theo ngày giờ của máy).
// featsNear() trả về các "nút biển" cùng dạng với nút OSM của RoadData để bộ máy cảnh báo dùng y như dữ liệu bản đồ.

import { angleDiff, distance } from './geo.js';
import { cellKey, cellOf } from './roaddata.js';
import { parseTrafficSign } from './signs.js';

export const LEARNED_DB = 'banduong-learned';
const DB_VERSION = 1;
const STORE = 'signs';
const RECORD_VERSION = 1; // phiên bản cấu trúc bản ghi (trường v)

// ---- Điểm tin cậy (PLAN §5.8, giá trị đã chỉnh lại theo bản thẩm định) ----
export const L_NEW = 0.4; // biển mới thấy lần đầu
export const L_STRONG = 0.85; // biển mới thấy rõ: ≥ 6 khung đồng ý, p trung bình ≥ 0,95, ban ngày
export const L_HIT_DAY = 1.2; // thấy lại ban ngày
export const L_HIT_NIGHT = 0.6; // thấy lại ban đêm
export const L_MISS_CANDIDATE = -0.5; // đi qua mà không thấy, biển chưa xác nhận (bị loại sau 2 lần)
export const L_MISS_CONFIRMED = -0.6; // đi qua mà không thấy, biển đã xác nhận (7 lần từ mức trần)
export const L_MIN = -2; // chặn dưới
export const L_MAX = 3.5; // chặn trên
export const L_CONFIRM = 1.5; // đủ điểm để xác nhận (cùng với số ngày)
export const L_RETIRE = -0.5; // từ mức này trở xuống thì loại
export const L_USER_OK = 3.5; // người dùng bấm "Đúng"
export const L_IMPORT = 0.4; // biển nhập từ tệp
export const CONFIRM_DAYS = 2; // số ngày khác nhau có thấy biển cần để xác nhận
export const CONFIRM_DAYS_UNSURE = 3; // như trên khi đường rẽ nhánh ngay sau biển (branch 'unsure')
export const CONFIRM_DAYS_IMPORT = 1; // biển nhập: một lần chính camera của máy này thấy là đủ

// ---- Hạn giữ (ngày) ----
export const CANDIDATE_DAYS = 90; // biển chưa xác nhận, không thấy lại chừng này ngày thì xoá
export const CONFIRMED_DAYS = 365; // biển đã xác nhận, không thấy lại chừng này ngày thì về lại chưa xác nhận
export const RETIRED_DAYS = 60; // biển đã loại được giữ chừng này ngày (để thấy lại thì dùng lại) rồi xoá
export const SUPPRESS_DAYS = 180; // người dùng báo sai hoặc biển đã dỡ: không học lại chừng này ngày
export const TEMP_DAYS = 30; // biển tạm thời (công trường) không thấy lại chừng này ngày thì loại
export const TEMP_CODES = new Set(['W.227']); // biển tạm thời

// ---- So khớp ----
export const MATCH_ALONG = 25; // cùng biển: cách nhau dọc đường không quá chừng này (m)
export const MATCH_LATERAL = 10; // … và lệch ngang không quá chừng này (m), để không gộp biển của đường song song
export const MATCH_FACING = 45; // … và hướng mặt biển lệch không quá chừng này (độ)
// Hai biển cùng được camera thấy trong một lượt đi qua (coSeen): mỗi bản ghi nhớ tối đa chừng này biển, mỗi biển với
// số ngày khác nhau có thấy cả hai và ngày gần nhất (không có giờ, không có chuyến đi).
export const CO_MAX = 4;
// … và cùng đường: lần thấy mang obs.ways (các đường của hành lang quanh chỗ thấy, do Learner tính) thì bản ghi có
// wayId phải thuộc các đường đó. Bản ghi không có wayId (biển nhập) chỉ xét lệch ngang.
export const SUPPRESS_RADIUS = 30; // biển bị báo sai chặn học lại cùng mã trong bán kính này (m), hướng ±45°
export const MAX_RECORDS = 5000; // số bản ghi tối đa
export const POS_ERR_DEFAULT = 4.5; // sai số vị trí (m, 1σ dọc đường) khi không biết
export const POS_ERR_FLOOR = 0.6; // gộp nhiều lần thấy: sai số không giảm dưới chừng này lần sai số một lần (GPS tương quan)
export const IMPORT_POS_ERR = 10; // sai số vị trí gán cho biển nhập từ tệp (m)

// ---- Nhập/xuất ----
export const MAX_IMPORT_FEATURES = 5000; // tệp nhập có nhiều biển hơn thì từ chối cả tệp
export const MAX_IMPORT_CHARS = 5_000_000; // tệp nhập dạng chuỗi dài hơn thì từ chối
export const MAX_TAG_CHARS = 64; // giá trị traffic_sign dài hơn thì bỏ biển đó
export const SPEED_MIN = 20; // biển tốc độ nhập: trị số trong khoảng này (km/h)
export const SPEED_MAX = 120;
const DIRECTION_MEANING = 'hướng mặt biển nhìn về';

const GRID = 0.001; // ô lưới tra cứu (độ, ~110 m), như lưới nút biển của RoadData
const EARTH = 6371008.8;
const RAD = Math.PI / 180;
const DAY_MS = 864e5;
const STATUSES = new Set(['candidate', 'confirmed', 'retired', 'suppressed']);
const SHOWN = new Set(['candidate', 'confirmed']);
const ID_RE = /^[0-9a-f]{12}$/;
const CODE_RE = /^(?:P|W|R|DP|S|I|IE|IP)\.\d{3}[a-z]?$/;
const VALUE_RE = /^\d{2,3}$/;
const SAFE_TAG_RE = /^[A-Za-z0-9.:[\];_ -]+$/;
const MARKUP_RE = /[<>]/;

// ---------------------------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const norm360 = (d) => ((Math.round(d) % 360) + 360) % 360;

/** Số thứ tự ngày theo lịch của máy (giờ địa phương): số ngày từ 1/1/1970 tới ngày đó. */
export function dayNumber(ms) {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

// Ngày lái xe bắt đầu lúc 04:00 giờ máy, không phải nửa đêm: một chuyến đêm qua 00:00 (vài vòng quanh một khu phố lúc
// 23:50 rồi 00:05) vẫn là một ngày, không đủ "hai ngày khác nhau" để xác nhận biển.
export const DRIVE_DAY_START_H = 4;

/**
 * Số thứ tự "ngày lái xe" của kho: như dayNumber nhưng ngày bắt đầu lúc DRIVE_DAY_START_H giờ (00:00–03:59 tính vào
 * ngày hôm trước). Mọi trường ngày của bản ghi (firstDay, lastHitDay, hitDays, until, co) dùng số này; nên một lần thấy
 * lúc 00:00–03:59 hiện là ngày hôm trước trong "Thấy lần đầu…", ghi chú của biển và tệp xuất.
 */
export const driveDay = (ms) => dayNumber(ms - DRIVE_DAY_START_H * 3600e3);

/** Số thứ tự ngày → "YYYY-MM-DD". */
export function dayString(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Nhãn của bộ phân loại ứng với mã và trị số: ("P.127", "50") → "P.127[50]", ("R.122", null) → "R.122". */
export const labelOf = (code, value) => (value != null ? `${code}[${value}]` : code);

/** Chỉ mục nhãn từ labels.json (cả đối tượng hoặc mảng labels) → Map nhãn → mục. */
export function labelIndex(labels) {
  const list = Array.isArray(labels) ? labels : labels && Array.isArray(labels.labels) ? labels.labels : [];
  const out = new Map();
  for (const l of list) if (l && typeof l.label === 'string') out.set(l.label, l);
  return out;
}

/** Độ lệch (m) của b so với a theo trục hướng brg: { along, lateral } (đều không âm). */
function offsets(a, b, brg) {
  const x = (b[0] - a[0]) * RAD * EARTH * Math.cos(a[1] * RAD);
  const y = (b[1] - a[1]) * RAD * EARTH;
  const ux = Math.sin(brg * RAD);
  const uy = Math.cos(brg * RAD);
  return { along: Math.abs(x * ux + y * uy), lateral: Math.abs(x * uy - y * ux) };
}

const facingClose = (a, b, tol = MATCH_FACING) => Math.abs(angleDiff(a, b)) <= tol;

/** Mã 12 chữ số hệ 16, ngẫu nhiên (không suy ra từ thời gian hay vị trí). */
function randomHex12(random) {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}

function defaultRandom() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    return () => {
      c.getRandomValues(buf);
      return buf[0] / 4294967296;
    };
  }
  return Math.random;
}

// ---------------------------------------------------------------------------------------------
// Nơi lưu (backend): { getAll() → Promise<bản ghi[]>, put(bản ghi), delete(id), clear() }
// ---------------------------------------------------------------------------------------------

/** Lưu trong bộ nhớ (kiểm thử). `initial`: các bản ghi có sẵn. */
export function memoryBackend(initial = []) {
  const map = new Map(initial.map((r) => [r.id, structuredClone(r)]));
  return {
    map,
    async getAll() {
      return [...map.values()].map((r) => structuredClone(r));
    },
    async put(rec) {
      map.set(rec.id, structuredClone(rec));
    },
    async delete(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

/**
 * IndexedDB `name` phiên bản 1, kho 'signs' (keyPath 'id', chỉ mục 'cell' = cellKey của toạ độ).
 * Không có IndexedDB hoặc lỗi thì mọi thao tác thành không làm gì (kho vẫn chạy trong bộ nhớ).
 */
export function idbBackend(name = LEARNED_DB, { indexedDB: idb = globalThis.indexedDB } = {}) {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        if (!idb) return resolve(null);
        const req = idb.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('cell', 'cell', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbp;
  };
  const write = async (fn) => {
    const db = await open();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  };
  return {
    async getAll() {
      const db = await open();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const req = db.transaction(STORE).objectStore(STORE).getAll();
          req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    },
    put: (rec) => write((st) => st.put(rec)),
    delete: (id) => write((st) => st.delete(id)),
    clear: () => write((st) => st.clear()),
  };
}

// ---------------------------------------------------------------------------------------------
// Bản ghi
// ---------------------------------------------------------------------------------------------

/** Bản ghi đọc từ nơi lưu → bản ghi hợp lệ (bản sao) hoặc null (bỏ bản ghi hỏng). */
function sanitize(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) return null;
  if (r.value != null && (typeof r.value !== 'string' || !VALUE_RE.test(r.value))) return null;
  if (!Array.isArray(r.coord) || !isNum(r.coord[0]) || !isNum(r.coord[1])) return null;
  if (Math.abs(r.coord[0]) > 180 || Math.abs(r.coord[1]) > 90 || !isNum(r.facing)) return null;
  if (!STATUSES.has(r.status) || !isNum(r.L)) return null;
  const day = (v) => (isNum(v) ? Math.round(v) : null);
  const firstDay = day(r.firstDay);
  if (firstDay == null) return null;
  return {
    id: r.id,
    v: RECORD_VERSION,
    code: r.code,
    value: r.value ?? null,
    family: typeof r.family === 'string' ? r.family : null,
    coord: [round5(r.coord[0]), round5(r.coord[1])],
    facing: norm360(r.facing),
    wayId: isNum(r.wayId) || typeof r.wayId === 'string' ? r.wayId : null,
    junction: typeof r.junction === 'string' && r.junction.length <= 40 ? r.junction : null,
    branch: r.branch === 'unsure' ? 'unsure' : null,
    plate: r.plate === 'unread' ? 'unread' : null,
    status: r.status,
    L: clamp(r.L, L_MIN, L_MAX),
    hitDays: Math.max(0, day(r.hitDays) ?? 0),
    passes: Math.max(0, day(r.passes) ?? 0),
    misses: Math.max(0, day(r.misses) ?? 0),
    firstDay,
    lastHitDay: day(r.lastHitDay),
    until: day(r.until),
    night: r.night === true,
    posErr: isNum(r.posErr) && r.posErr > 0 ? r.posErr : POS_ERR_DEFAULT,
    src: r.src === 'import' ? 'import' : 'camera',
    co: sanitizeCo(r.co),
  };
}

/** Danh sách co của bản ghi đọc từ nơi lưu: tối đa CO_MAX mục { id, days ≥ 1, last } hợp lệ, không trùng id. */
function sanitizeCo(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    if (out.length >= CO_MAX) break;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id) || out.some((o) => o.id === c.id)) continue;
    if (!isNum(c.days) || !isNum(c.last)) continue;
    out.push({ id: c.id, days: clamp(Math.round(c.days), 1, 99999), last: Math.round(c.last) });
  }
  return out;
}

const copyCo = (co) => (Array.isArray(co) ? co.map((c) => ({ ...c })) : []);

/** Bản ghi đem lưu: thêm khoá ô 'cell' cho chỉ mục. */
const stored = (rec) => ({ ...rec, coord: [...rec.coord], co: copyCo(rec.co), cell: cellKey(...cellOf(rec.coord)) });

/** Bản sao chỉ đọc của bản ghi trả ra ngoài. */
const snapshot = (rec) => (rec ? { ...rec, coord: [...rec.coord], co: copyCo(rec.co) } : null);

const temporary = (rec) => TEMP_CODES.has(rec.code);
const needDays = (rec) =>
  rec.src === 'import' ? CONFIRM_DAYS_IMPORT : rec.branch === 'unsure' ? CONFIRM_DAYS_UNSURE : CONFIRM_DAYS;

/** Nút biển cho bộ máy cảnh báo (cùng dạng nút OSM của RoadData, hợp đồng 6). */
function featOf(rec) {
  return Object.freeze({
    id: `L${rec.id}`,
    coord: Object.freeze([rec.coord[0], rec.coord[1]]),
    onWay: false,
    tags: Object.freeze({ traffic_sign: `VN:${labelOf(rec.code, rec.value)}`, 'traffic_sign:direction': String(rec.facing) }),
    src: rec.src,
    status: rec.status,
    meta: Object.freeze({ hitDays: rec.hitDays, firstDay: rec.firstDay, lastHitDay: rec.lastHitDay, plate: rec.plate }),
  });
}

// ---------------------------------------------------------------------------------------------
// Kho
// ---------------------------------------------------------------------------------------------

export class LearnedSigns {
  #records = new Map(); // id → bản ghi
  #grid = new Map(); // ô lưới → Set id
  #feats = new Map(); // id → nút biển đã dựng (giữ nguyên đối tượng tới khi bản ghi đổi)
  #listeners = new Set();
  #expiredDay = null;
  #loading = null;

  /**
   * @param backend  nơi lưu (memoryBackend() khi kiểm thử)
   * @param now      () → ms (đồng hồ của máy, dùng để tính số thứ tự ngày)
   * @param labels   labels.json (để kiểm tra biển nhập từ tệp: chỉ nhận nhãn được học; và để "cất" bản ghi của nhãn
   *                 không còn được học, xem #dormant)
   * @param requireLabels  true: khi chưa có labels thì mọi bản ghi đều bị cất (không hiện, không cảnh báo) cho tới
   *                 khi biết nhãn nào được học (CameraController dùng); false (mặc định): chưa có labels thì không lọc
   * @param random   () → [0, 1) để tạo mã bản ghi
   */
  constructor({
    backend = idbBackend(LEARNED_DB),
    now = () => Date.now(),
    labels = null,
    requireLabels = false,
    random = defaultRandom(),
  } = {}) {
    this.backend = backend;
    this.now = now;
    this.random = random;
    this.requireLabels = requireLabels === true;
    this.setLabels(labels);
  }

  setLabels(labels) {
    const before = this.labels;
    this.labels = labels ? labelIndex(labels) : null;
    // Bộ nhãn đổi thì tập bản ghi bị cất cũng đổi: báo cho bên nghe (bản đồ, số đếm, cảnh báo).
    if (this.#loading && before !== this.labels) this.#emit();
  }

  /**
   * Bản ghi "bị cất": nhãn của nó không có learn: true trong labels.json đang dùng (nhãn đã bị gỡ khỏi danh sách học,
   * ví dụ mọi P.127 ở bản v1, DECISION.md), hoặc chưa có labels khi requireLabels. Bản ghi bị cất vẫn được giữ nguyên
   * (không đổi trạng thái, không bị trừ điểm, vẫn có trong tệp xuất và bị "Xoá" xoá như mọi bản ghi) nhưng không hiện,
   * không cảnh báo, không đọc, không vào bộ học (featsNear, recordsNear, list, match) nên không đổi giới hạn tốc độ.
   * Bản sau học lại nhãn đó thì bản ghi tự dùng lại.
   */
  #dormant(r) {
    if (!this.labels) return this.requireLabels;
    return this.labels.get(labelOf(r.code, r.value))?.learn !== true;
  }

  /** Bản ghi đang dùng: chưa xác nhận hoặc đã xác nhận, và không bị cất. */
  #active(r) {
    return SHOWN.has(r.status) && !this.#dormant(r);
  }

  /** Đọc mọi bản ghi từ nơi lưu (một lần; gọi lại trả về cùng lời hứa). Bản ghi hỏng bị bỏ qua. */
  load() {
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      let rows = [];
      try {
        rows = (await this.backend.getAll()) || [];
      } catch {
        rows = [];
      }
      for (const row of rows) {
        const rec = sanitize(row);
        if (rec && !this.#records.has(rec.id) && this.#records.size < MAX_RECORDS) this.#index(rec);
      }
      this.#expiredDay = null;
      this.expire();
      this.#emit();
      return this.size;
    })();
    return this.#loading;
  }

  /** Số bản ghi đang giữ (mọi trạng thái). */
  get size() {
    return this.#records.size;
  }

  /**
   * Đếm theo trạng thái → { total, shown, candidate, confirmed, retired, suppressed, dormant }. Bản ghi chưa xác nhận
   * hay đã xác nhận mà bị cất (#dormant) chỉ được đếm ở dormant, không ở shown, candidate hay confirmed.
   */
  counts() {
    const out = { total: this.#records.size, shown: 0, candidate: 0, confirmed: 0, retired: 0, suppressed: 0, dormant: 0 };
    for (const r of this.#records.values()) {
      if (SHOWN.has(r.status) && this.#dormant(r)) {
        out.dormant++;
        continue;
      }
      out[r.status]++;
      if (SHOWN.has(r.status)) out.shown++;
    }
    return out;
  }

  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn(this);
      } catch {
        /* bỏ qua lỗi của bên nghe */
      }
    }
  }

  #today() {
    return driveDay(this.now());
  }

  // ---- Chỉ mục ----

  #cellOf(coord) {
    return `${Math.floor(coord[0] / GRID)}:${Math.floor(coord[1] / GRID)}`;
  }

  #index(rec) {
    this.#records.set(rec.id, rec);
    const key = this.#cellOf(rec.coord);
    let set = this.#grid.get(key);
    if (!set) this.#grid.set(key, (set = new Set()));
    set.add(rec.id);
    this.#feats.delete(rec.id);
  }

  #unindex(rec) {
    const key = this.#cellOf(rec.coord);
    const set = this.#grid.get(key);
    if (set) {
      set.delete(rec.id);
      if (!set.size) this.#grid.delete(key);
    }
    this.#feats.delete(rec.id);
  }

  /** Bản ghi vừa đổi: dựng lại chỉ mục và nút biển, ghi xuống nơi lưu. */
  #touch(rec, oldCoord = rec.coord) {
    this.#unindex({ id: rec.id, coord: oldCoord });
    this.#index(rec);
    this.#persist(rec);
  }

  #persist(rec) {
    try {
      const p = this.backend.put(stored(rec));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* bỏ qua */
    }
  }

  #remove(rec) {
    this.#unindex(rec);
    this.#records.delete(rec.id);
    try {
      const p = this.backend.delete(rec.id);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* bỏ qua */
    }
  }

  /** Các bản ghi trong bán kính radius (m) quanh coord. */
  #near(coord, radius) {
    if (!Array.isArray(coord) || !isNum(coord[0]) || !isNum(coord[1])) return [];
    const dLat = radius / 110000;
    const dLon = dLat / Math.max(0.05, Math.cos(coord[1] * RAD));
    const x0 = Math.floor((coord[0] - dLon) / GRID);
    const x1 = Math.floor((coord[0] + dLon) / GRID);
    const y0 = Math.floor((coord[1] - dLat) / GRID);
    const y1 = Math.floor((coord[1] + dLat) / GRID);
    const out = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const set = this.#grid.get(`${x}:${y}`);
        if (!set) continue;
        for (const id of set) {
          const r = this.#records.get(id);
          if (r && distance(coord, r.coord) <= radius) out.push(r);
        }
      }
    }
    return out;
  }

  // ---- Tra cứu ----

  /**
   * Nút biển (chưa xác nhận và đã xác nhận) trong bán kính radius (m): cùng một đối tượng cho tới khi bản ghi đổi
   * (bộ máy cảnh báo nhớ kết quả phân loại theo đối tượng). Dạng: hợp đồng 6.
   */
  featsNear(coord, radius) {
    this.expire();
    const out = [];
    for (const r of this.#near(coord, radius)) {
      if (!this.#active(r) || this.#superseded(r)) continue;
      let f = this.#feats.get(r.id);
      if (!f) this.#feats.set(r.id, (f = featOf(r)));
      out.push(f);
    }
    return out;
  }

  /**
   * Biển đã xác nhận rec có một biển đã xác nhận khác cùng mã, khác trị số, ở đúng chỗ (cùng quy tắc so khớp như
   * match(): dọc đường ≤ 25 m, ngang ≤ 10 m, hướng mặt ±45°, cùng đường khi cả hai có wayId) mà được thấy lại gần đây
   * hơn (lastHitDay muộn hơn; bằng nhau thì biển có sau, firstDay muộn hơn): biển đã đổi trị số (60 → 50). Chỉ biển
   * mới được hiện và đọc; điểm của cả hai không đổi, nên một lần đọc nhầm trị số tự sửa ở lần đọc đúng kế tiếp
   * (PLAN §5.9). Bộ học vẫn xét lượt đi qua cả hai (recordsNear không lọc).
   */
  #superseded(rec) {
    if (rec.status !== 'confirmed') return false;
    const mine = rec.lastHitDay ?? -Infinity;
    for (const o of this.#near(rec.coord, Math.hypot(MATCH_ALONG, MATCH_LATERAL) + 1)) {
      if (o === rec || o.status !== 'confirmed' || o.code !== rec.code || (o.value ?? null) === (rec.value ?? null)) continue;
      if (this.#dormant(o)) continue; // biển bị cất không che biển đang dùng
      if (!facingClose(o.facing, rec.facing)) continue;
      if (o.wayId != null && rec.wayId != null && o.wayId !== rec.wayId) continue; // biển của đường khác
      const { along, lateral } = offsets(rec.coord, o.coord, (rec.facing + 180) % 360);
      if (along > MATCH_ALONG || lateral > MATCH_LATERAL) continue;
      const theirs = o.lastHitDay ?? -Infinity;
      if (theirs > mine || (theirs === mine && o.firstDay > rec.firstDay)) return true;
    }
    return false;
  }

  /** Bản sao các bản ghi chưa xác nhận và đã xác nhận trong bán kính radius (m) (bộ học dùng để xét lượt đi qua). */
  recordsNear(coord, radius) {
    return this.#near(coord, radius).filter((r) => this.#active(r)).map(snapshot);
  }

  /** Bản sao một bản ghi theo id (có hoặc không có tiền tố 'L'), hoặc null. */
  get(id) {
    return snapshot(this.#records.get(this.#id(id)));
  }

  #id(id) {
    const s = String(id ?? '');
    return s.startsWith('L') ? s.slice(1) : s;
  }

  /** Danh sách để xem lại (chưa xác nhận và đã xác nhận), gần `near` trước; không có `near` thì mới thấy trước. */
  list({ near = null } = {}) {
    const rows = [];
    for (const r of this.#records.values()) {
      if (!this.#active(r)) continue;
      rows.push({
        id: r.id,
        label: labelOf(r.code, r.value),
        code: r.code,
        value: r.value,
        family: r.family,
        coord: [...r.coord],
        facing: r.facing,
        status: r.status,
        src: r.src,
        hitDays: r.hitDays,
        firstDay: r.firstDay,
        lastHitDay: r.lastHitDay,
        plate: r.plate,
        branch: r.branch,
        distance: Array.isArray(near) ? distance(near, r.coord) : null,
      });
    }
    if (Array.isArray(near)) rows.sort((a, b) => a.distance - b.distance);
    else rows.sort((a, b) => (b.lastHitDay ?? b.firstDay) - (a.lastHitDay ?? a.firstDay));
    return rows;
  }

  /**
   * So khớp một lần thấy với kho (không thay đổi gì) →
   * { match: bản ghi cùng biển | null, conflicts: [cùng mã khác trị số], suppressed: bản ghi chặn học lại | null }.
   * Cùng biển: cùng mã và trị số, hướng mặt lệch ≤ 45°, cách nhau dọc đường ≤ 25 m (lệch ngang ≤ 10 m), và khi lần
   * thấy có obs.ways (mảng id đường không rỗng) thì bản ghi có wayId phải nằm trên một trong các đường đó: biển của
   * đường song song, đường trên cao, đường gom không bị gộp hay trừ điểm. Chặn học lại (bước 12) không xét đường.
   */
  match(obs) {
    const res = { match: null, conflicts: [], suppressed: null };
    if (!obs || !Array.isArray(obs.coord) || !isNum(obs.facing)) return res;
    let best = Infinity;
    const radius = Math.max(SUPPRESS_RADIUS, Math.hypot(MATCH_ALONG, MATCH_LATERAL)) + 1;
    const ways = Array.isArray(obs.ways) && obs.ways.length ? obs.ways : null;
    for (const r of this.#near(obs.coord, radius)) {
      if (r.code !== obs.code || !facingClose(r.facing, obs.facing)) continue;
      if (r.status === 'suppressed') {
        if (distance(r.coord, obs.coord) <= SUPPRESS_RADIUS) res.suppressed = r;
        continue;
      }
      if (ways && r.wayId != null && !ways.includes(r.wayId)) continue; // biển của đường khác
      const { along, lateral } = offsets(r.coord, obs.coord, (r.facing + 180) % 360);
      if (along > MATCH_ALONG || lateral > MATCH_LATERAL) continue;
      if ((r.value ?? null) === (obs.value ?? null)) {
        const d = Math.hypot(along, lateral);
        if (d < best) {
          best = d;
          res.match = r;
        }
      } else if (this.#active(r)) res.conflicts.push(r);
    }
    return res;
  }

  // ---- Thay đổi điểm ----

  #untilFor(rec, day) {
    if (rec.status === 'candidate') return day + (temporary(rec) ? TEMP_DAYS : CANDIDATE_DAYS);
    if (rec.status === 'confirmed') return day + (temporary(rec) ? TEMP_DAYS : CONFIRMED_DAYS);
    if (rec.status === 'retired') return day + RETIRED_DAYS;
    if (rec.status === 'suppressed') return day + SUPPRESS_DAYS;
    return null;
  }

  #maybeConfirm(rec) {
    if (rec.status === 'candidate' && rec.L >= L_CONFIRM && rec.hitDays >= needDays(rec)) rec.status = 'confirmed';
  }

  /** Thấy lại: cộng điểm, đếm ngày, gộp vị trí. obs có thể chỉ có { night }. */
  #hit(rec, obs, day) {
    if (this.#records.get(rec.id) !== rec) return; // bản ghi đã bị bỏ: không dựng lại
    const oldCoord = rec.coord;
    rec.L = clamp(rec.L + (obs.night ? L_HIT_NIGHT : L_HIT_DAY), L_MIN, L_MAX);
    if (rec.lastHitDay == null || day > rec.lastHitDay) rec.hitDays++;
    rec.lastHitDay = rec.lastHitDay == null ? day : Math.max(rec.lastHitDay, day);
    rec.passes++;
    rec.night = rec.night && Boolean(obs.night);
    if (rec.status === 'retired') rec.status = 'candidate'; // thấy lại biển đã loại: dùng lại, chưa xác nhận
    if (obs.plate === 'unread') rec.plate = 'unread';
    if (obs.branch === 'unsure') rec.branch = 'unsure';
    if (Array.isArray(obs.coord) && isNum(obs.facing)) {
      // Trung bình có trọng số theo nghịch đảo phương sai; biển neo vào nút giao chỉ gộp với lần neo cùng nút giao.
      const se = isNum(obs.posErr) && obs.posErr > 0 ? obs.posErr : POS_ERR_DEFAULT;
      if ((obs.junction ?? null) === rec.junction) {
        const wo = 1 / (rec.posErr * rec.posErr);
        const wn = 1 / (se * se);
        const t = wn / (wo + wn);
        rec.coord = [round5(rec.coord[0] + t * (obs.coord[0] - rec.coord[0])), round5(rec.coord[1] + t * (obs.coord[1] - rec.coord[1]))];
        rec.facing = norm360(rec.facing + t * angleDiff(rec.facing, obs.facing));
        rec.posErr = Math.max(POS_ERR_FLOOR * Math.min(se, rec.posErr), 1 / Math.sqrt(wo + wn));
      }
      // Đường của lần thấy mới nhất (đã được so khớp là cùng đường): id đường cũ có thể đã đổi khi bản đồ cập nhật.
      if (obs.wayId != null) rec.wayId = obs.wayId;
    }
    this.#maybeConfirm(rec);
    rec.until = this.#untilFor(rec, day);
    this.#touch(rec, oldCoord);
  }

  /** Đi qua đủ điều kiện mà không thấy: trừ điểm; tới ngưỡng thì loại. */
  #miss(rec, day) {
    if (this.#records.get(rec.id) !== rec) return false; // bản ghi đã bị bỏ: không dựng lại
    if (rec.status === 'candidate') rec.L = clamp(rec.L + L_MISS_CANDIDATE, L_MIN, L_MAX);
    else if (rec.status === 'confirmed') rec.L = clamp(rec.L + L_MISS_CONFIRMED, L_MIN, L_MAX);
    else return false;
    rec.misses++;
    rec.passes++;
    if (rec.L <= L_RETIRE) {
      rec.status = 'retired';
      rec.until = this.#untilFor(rec, day);
    }
    this.#touch(rec);
    return true;
  }

  /**
   * Nhường chỗ cho một bản ghi mới khi kho đầy: bỏ biển đã loại, rồi biển chưa xác nhận cũ nhất. Không bỏ các bản
   * ghi trong `keep` (id; các bản ghi lần thấy này vừa đụng tới).
   */
  #makeRoom(keep = null) {
    if (this.#records.size < MAX_RECORDS) return true;
    const age = (r) => r.lastHitDay ?? r.firstDay;
    const pick = (status, key) => {
      let worst = null;
      for (const r of this.#records.values()) {
        if (r.status === status && !(keep && keep.has(r.id)) && (!worst || key(r) < key(worst))) worst = r;
      }
      return worst;
    };
    while (this.#records.size >= MAX_RECORDS) {
      const victim = pick('retired', (r) => r.until ?? 0) || pick('candidate', age);
      if (!victim) return false;
      this.#remove(victim);
    }
    return true;
  }

  #newId() {
    for (;;) {
      const id = randomHex12(this.random);
      if (!this.#records.has(id)) return id;
    }
  }

  /**
   * Một lần thấy biển đã qua mọi bước lọc (signlearn.js) →
   * { record, event: 'new'|'hit'|'conflict'|'suppressed'|'osm'|'full'|'invalid', missed: [bản ghi bị trừ điểm],
   *   created: bản ghi vừa được tạo (true với 'new', và với 'conflict' khi biển trị số mới chưa có) }.
   * obs: { code, value, family, coord, facing, wayId, ways, junction, branch, plate, night, strong, posErr, osm }
   *   (ways: id các đường cùng con đường quanh chỗ thấy, xem match()).
   * - 'suppressed': cùng mã trong 30 m, hướng ±45° đã bị người dùng báo sai: không học (bước 12).
   * - 'osm': dữ liệu bản đồ đã có biển này theo chiều này (obs.osm) và kho chưa có: không tạo bản ghi (bước 13).
   *   Kho đã có thì vẫn tính là thấy lại.
   * - 'conflict': cùng mã khác trị số trong 25 m (đổi biển 50 → 60): biển mới được tính là thấy, biển cũ bị trừ
   *   điểm như một lần đi qua không thấy (các bản ghi đó trong `missed`).
   */
  observe(obs) {
    this.expire();
    const day = this.#today();
    if (
      !obs ||
      typeof obs.code !== 'string' ||
      !CODE_RE.test(obs.code) ||
      (obs.value != null && !VALUE_RE.test(String(obs.value))) ||
      !Array.isArray(obs.coord) ||
      !isNum(obs.coord[0]) ||
      !isNum(obs.coord[1]) ||
      !isNum(obs.facing)
    ) {
      return { record: null, event: 'invalid', missed: [], created: false };
    }
    const o = { ...obs, value: obs.value == null ? null : String(obs.value), facing: norm360(obs.facing) };
    const m = this.match(o);
    if (m.suppressed) return { record: snapshot(m.suppressed), event: 'suppressed', missed: [], created: false };
    if (o.osm && !m.match) return { record: null, event: 'osm', missed: [], created: false };
    // Biển cũ đổi trị số bị trừ điểm trước khi nhường chỗ, và không bị bỏ để nhường chỗ (nếu không, lần trừ điểm sẽ
    // dựng lại đúng bản ghi vừa bỏ và kho vượt giới hạn).
    const missed = [];
    for (const r of m.conflicts) if (this.#miss(r, day)) missed.push(snapshot(r));
    if (!m.match && !this.#makeRoom(new Set(m.conflicts.map((r) => r.id)))) {
      if (missed.length) this.#emit();
      return { record: null, event: 'full', missed, created: false };
    }
    let rec = m.match;
    let event = missed.length ? 'conflict' : 'hit';
    if (rec) {
      this.#hit(rec, o, day);
    } else {
      const strong = Boolean(o.strong) && !o.night;
      rec = {
        id: this.#newId(),
        v: RECORD_VERSION,
        code: o.code,
        value: o.value,
        family: typeof o.family === 'string' ? o.family : null,
        coord: [round5(o.coord[0]), round5(o.coord[1])],
        facing: o.facing,
        wayId: o.wayId ?? null,
        junction: typeof o.junction === 'string' ? o.junction : null,
        branch: o.branch === 'unsure' ? 'unsure' : null,
        plate: o.plate === 'unread' ? 'unread' : null,
        status: 'candidate',
        L: strong ? L_STRONG : L_NEW,
        hitDays: 1,
        passes: 1,
        misses: 0,
        firstDay: day,
        lastHitDay: day,
        until: null,
        night: Boolean(o.night),
        posErr: isNum(o.posErr) && o.posErr > 0 ? o.posErr : POS_ERR_DEFAULT,
        src: 'camera',
        co: [],
      };
      rec.until = this.#untilFor(rec, day);
      this.#index(rec);
      this.#persist(rec);
      if (!missed.length) event = 'new';
    }
    this.#emit();
    return { record: snapshot(rec), event, missed, created: !m.match };
  }

  /** Kết quả một lượt đi qua biển (signlearn.js): 'hit' cộng điểm, 'miss' trừ điểm, 'none' không đổi. */
  pass(id, outcome, { night = false } = {}) {
    this.expire();
    const rec = this.#records.get(this.#id(id));
    if (!rec) return null;
    const day = this.#today();
    if (outcome === 'hit') {
      if (rec.status === 'suppressed') return snapshot(rec);
      this.#hit(rec, { night }, day);
    } else if (outcome === 'miss') {
      if (!this.#miss(rec, day)) return snapshot(rec);
    } else return snapshot(rec);
    this.#emit();
    return snapshot(rec);
  }

  // ---- Người dùng xem lại (chỉ khi xe đã đỗ; giao diện kiểm tra điều đó) ----

  /** "Đúng": xác nhận ngay. */
  confirm(id) {
    const rec = this.#records.get(this.#id(id));
    if (!rec) return null;
    rec.status = 'confirmed';
    rec.L = L_USER_OK;
    rec.until = this.#untilFor(rec, this.#today());
    this.#touch(rec);
    this.#emit();
    return snapshot(rec);
  }

  /**
   * Camera vừa thấy cả hai biển a và b trong cùng một lượt đi qua, bằng hai lượt bám riêng có nhãn khác nhau
   * (signlearn.js): hai biển thật đứng cạnh nhau, không phải một biển bị đọc nhầm. Ghi cho cả hai bản ghi số ngày khác
   * nhau đã thấy cả hai (mỗi ngày tính một lần) và ngày gần nhất; mỗi bản ghi giữ tối đa CO_MAX biển (bỏ biển lâu nhất
   * không cùng thấy). Không đổi điểm. → true khi có thay đổi.
   */
  coSeen(idA, idB) {
    const a = this.#records.get(this.#id(idA));
    const b = this.#records.get(this.#id(idB));
    if (!a || !b || a === b) return false;
    const day = this.#today();
    let changed = false;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!Array.isArray(x.co)) x.co = [];
      const c = x.co.find((e) => e.id === y.id);
      if (c && c.last >= day) continue;
      if (c) {
        c.days++;
        c.last = day;
      } else {
        if (x.co.length >= CO_MAX) {
          let k = 0;
          x.co.forEach((e, i) => {
            if (e.last < x.co[k].last) k = i;
          });
          x.co.splice(k, 1);
        }
        x.co.push({ id: y.id, days: 1, last: day });
      }
      this.#touch(x);
      changed = true;
    }
    return changed;
  }

  /** "Sai": ẩn và không học lại cùng mã ở chỗ này trong 180 ngày. */
  reject(id) {
    return this.#suppress(id);
  }

  /** "Biển đã bị dỡ": như "Sai". */
  removed(id) {
    return this.#suppress(id);
  }

  #suppress(id) {
    const rec = this.#records.get(this.#id(id));
    if (!rec) return null;
    rec.status = 'suppressed';
    rec.until = this.#untilFor(rec, this.#today());
    this.#touch(rec);
    this.#emit();
    return snapshot(rec);
  }

  /** "Xoá các biển đã học": xoá hết, kể cả các biển đã báo sai. */
  async clear() {
    this.#records.clear();
    this.#grid.clear();
    this.#feats.clear();
    try {
      await this.backend.clear();
    } catch {
      /* bỏ qua */
    }
    this.#emit();
  }

  // ---- Hết hạn ----

  /**
   * Áp dụng các hạn giữ (mỗi ngày một lần là đủ; `force` để chạy lại): chưa xác nhận không thấy lại 90 ngày → xoá;
   * đã xác nhận không thấy lại 365 ngày → về chưa xác nhận; biển công trường không thấy lại 30 ngày → loại; đã loại
   * 60 ngày → xoá; báo sai 180 ngày → xoá. Trả về số bản ghi đã đổi.
   */
  expire({ force = false } = {}) {
    const day = this.#today();
    if (!force && this.#expiredDay === day) return 0;
    this.#expiredDay = day;
    let changed = 0;
    for (const rec of [...this.#records.values()]) {
      let touched = false;
      let gone = false;
      while (!gone && rec.until != null && day >= rec.until) {
        const at = rec.until;
        touched = true;
        if (rec.status === 'suppressed' || rec.status === 'retired') gone = true;
        else if (temporary(rec)) {
          rec.status = 'retired';
          rec.until = at + RETIRED_DAYS;
        } else if (rec.status === 'candidate') gone = true;
        else {
          rec.status = 'candidate';
          rec.until = at + CANDIDATE_DAYS;
        }
      }
      if (gone) this.#remove(rec);
      else if (touched) this.#touch(rec);
      if (touched) changed++;
    }
    if (changed) this.#emit();
    return changed;
  }

  // ---- Xuất / nhập (PLAN §6.4) ----

  /**
   * GeoJSON FeatureCollection các biển chưa xác nhận và đã xác nhận (gồm cả biển bị cất, #dormant: tệp là dữ liệu của
   * người dùng). Không có ngày, trừ khi withDates.
   * direction: hướng mặt biển nhìn về (độ), ghi rõ trong ban_duong:direction_meaning.
   * Các biển xếp theo toạ độ (kinh độ, vĩ độ), không theo thứ tự đã thấy: thứ tự trong tệp không lộ đường đã đi.
   */
  exportGeoJSON({ withDates = false } = {}) {
    const features = [];
    for (const r of this.#records.values()) {
      if (!SHOWN.has(r.status)) continue;
      const properties = {
        traffic_sign: `VN:${labelOf(r.code, r.value)}`,
        direction: r.facing,
        'ban_duong:direction_meaning': DIRECTION_MEANING,
        'ban_duong:status': r.status,
        'ban_duong:seen_days': r.hitDays,
      };
      if (withDates) {
        properties['ban_duong:first_seen'] = dayString(r.firstDay);
        if (r.lastHitDay != null) properties['ban_duong:last_seen'] = dayString(r.lastHitDay);
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [round5(r.coord[0]), round5(r.coord[1])] },
        properties,
      });
    }
    const key = (f) => f.geometry.coordinates;
    features.sort(
      (a, b) =>
        key(a)[0] - key(b)[0] ||
        key(a)[1] - key(b)[1] ||
        (a.properties.traffic_sign < b.properties.traffic_sign ? -1 : a.properties.traffic_sign > b.properties.traffic_sign ? 1 : 0) ||
        a.properties.direction - b.properties.direction,
    );
    return { type: 'FeatureCollection', features };
  }

  /**
   * Nhập tệp GeoJSON do ứng dụng xuất (đối tượng hoặc chuỗi). Đọc phòng thủ: tối đa 5.000 biển, chỉ điểm có toạ độ
   * hợp lệ, chỉ nhãn được học (cần labels), trị số tốc độ 20–120, hướng 0–360, bỏ chuỗi có thẻ đánh dấu (< >).
   * Biển nhập là "chưa xác nhận", src 'import'; trùng biển đã có (cùng khoá so khớp) thì bỏ qua.
   * Nhập không bao giờ bỏ bản ghi đang có để lấy chỗ: kho đầy (5.000) thì dừng, các biển còn lại tính là bỏ qua.
   * → { added, skipped, error? } (error: 'too-large'|'bad-json'|'not-geojson'|'too-many'|'no-labels'|'full').
   */
  importGeoJSON(obj) {
    let data = obj;
    if (typeof data === 'string') {
      if (data.length > MAX_IMPORT_CHARS) return { added: 0, skipped: 0, error: 'too-large' };
      try {
        data = JSON.parse(data);
      } catch {
        return { added: 0, skipped: 0, error: 'bad-json' };
      }
    }
    if (!data || typeof data !== 'object' || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      return { added: 0, skipped: 0, error: 'not-geojson' };
    }
    const n = data.features.length;
    if (n > MAX_IMPORT_FEATURES) return { added: 0, skipped: n, error: 'too-many' };
    if (!this.labels) return { added: 0, skipped: n, error: 'no-labels' };
    this.expire();
    const day = this.#today();
    let added = 0;
    let skipped = 0;
    let full = false;
    for (const f of data.features) {
      if (this.#records.size >= MAX_RECORDS) {
        full = true;
        break;
      }
      const rec = this.#importOne(f, day);
      if (rec) added++;
      else skipped++;
    }
    if (added) this.#emit();
    return full ? { added, skipped: n - added, error: 'full' } : { added, skipped };
  }

  #importOne(f, day) {
    if (!f || typeof f !== 'object' || f.type !== 'Feature') return null;
    const g = f.geometry;
    if (!g || typeof g !== 'object' || g.type !== 'Point' || !Array.isArray(g.coordinates)) return null;
    const [lon, lat] = g.coordinates;
    if (!isNum(lon) || !isNum(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    const p = f.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    // Bất kỳ chuỗi nào trong thuộc tính chứa thẻ đánh dấu: bỏ cả biển.
    for (const k of Object.keys(p)) {
      if (MARKUP_RE.test(k)) return null;
      const v = p[k];
      if (typeof v === 'string' && MARKUP_RE.test(v)) return null;
    }
    const tag = Object.hasOwn(p, 'traffic_sign') ? p.traffic_sign : null;
    if (typeof tag !== 'string' || tag.length > MAX_TAG_CHARS || !SAFE_TAG_RE.test(tag)) return null;
    const parts = parseTrafficSign(tag);
    if (parts.length !== 1 || !parts[0].code) return null;
    const { code } = parts[0];
    const value = parts[0].value ?? null;
    if (value != null) {
      if (!VALUE_RE.test(value)) return null;
      if (code === 'P.127' && !(+value >= SPEED_MIN && +value <= SPEED_MAX)) return null;
    }
    const entry = this.labels.get(labelOf(code, value));
    if (!entry || entry.learn !== true || entry.code !== code || (entry.value ?? null) !== value) return null;
    const dirRaw = Object.hasOwn(p, 'direction') ? p.direction : null;
    const dir = typeof dirRaw === 'string' && /^\d{1,3}(?:\.\d+)?$/.test(dirRaw.trim()) ? parseFloat(dirRaw) : dirRaw;
    if (!isNum(dir) || dir < 0 || dir > 360) return null;
    const obs = { code, value, coord: [round5(lon), round5(lat)], facing: norm360(dir) };
    const m = this.match(obs);
    if (m.suppressed || m.match) return null;
    const rec = {
      id: this.#newId(),
      v: RECORD_VERSION,
      code,
      value,
      family: typeof entry.family === 'string' ? entry.family : null,
      coord: obs.coord,
      facing: obs.facing,
      wayId: null,
      junction: null,
      branch: null,
      plate: null,
      status: 'candidate',
      L: L_IMPORT,
      hitDays: 0,
      passes: 0,
      misses: 0,
      firstDay: day,
      lastHitDay: null,
      until: null,
      night: false,
      posErr: IMPORT_POS_ERR,
      src: 'import',
      co: [],
    };
    rec.until = this.#untilFor(rec, day);
    this.#index(rec);
    this.#persist(rec);
    return rec;
  }
}

/** Hướng đi (độ) mà một biển có hướng mặt `facing` áp dụng: ngược với hướng mặt biển. */
export const travelFor = (facing) => (facing + 180) % 360;

/** Biển (bản ghi hoặc nút biển) có áp dụng cho xe đi theo hướng `heading` không (lệch ≤ tol độ). */
export function appliesTo(facing, heading, tol = 60) {
  return Math.abs(angleDiff(travelFor(facing), heading)) <= tol;
}

