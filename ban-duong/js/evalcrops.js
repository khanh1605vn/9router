// Kho ảnh biển để kiểm tra độ chính xác của camera (PLAN §6.5, tập đánh giá E2 ở §8.3). Mặc định TẮT: chỉ lưu khi người
// dùng bật "Lưu ảnh biển để kiểm tra độ chính xác" (cài đặt camEval). Mỗi mục là một ảnh PNG nhỏ cắt sát biển (khung
// + 15 %, cạnh dài ≤ 96 px) kèm nhãn máy đoán; không có toạ độ, không có giờ, chỉ có số thứ tự ngày (để xoá sau 30
// ngày). Ảnh chỉ ở trên máy (IndexedDB 'banduong-evalcrops', tách khỏi biển đã học); xuất ra tệp chỉ khi người dùng
// bấm, đúng định dạng mà tools/camera/label-crops.html đọc. Khung hình đầy đủ không bao giờ được lưu.
// Thuần logic, không đụng tới DOM; nơi lưu thay được (bộ nhớ trong khi kiểm thử).

import './visionproto.js';
import { dayNumber, memoryBackend } from './learnedsigns.js';

const P = globalThis.VisionProto;

export const EVAL_DB = 'banduong-evalcrops';
const DB_VERSION = 1;
const STORE = 'crops';

export const EVAL_RETENTION_DAYS = 30; // ảnh lưu từ chừng này ngày trước trở lên thì xoá (ảnh hôm nay: 0 ngày)
export const EVAL_FUTURE_DAYS = 1; // ảnh mang ngày sau hôm nay quá chừng này (đồng hồ máy bị chỉnh lùi) thì xoá
export const EVAL_MAX_CROPS = 2000; // số ảnh tối đa; thêm nữa thì xoá ảnh cũ nhất
export const EVAL_MAX_BYTES = P.EVAL_CROP_MAX_BYTES; // một ảnh lớn hơn chừng này (byte) thì không nhận
export const EVAL_OUTCOMES = Object.freeze(['accepted', 'near-miss']);
export const EVAL_FILE_VERSION = 1; // phiên bản tệp xuất (label-crops.html đọc phiên bản 1)
export const EVAL_FILE_NAME = 'anh-bien-kiem-tra.json';

// Chữ cho giao diện (cài đặt nằm trong "Kiểm tra camera", chỉ khi xe đứng yên; nút xoá còn có ở mục Cài đặt, luôn bấm
// được).
export const EVAL_TEXT = Object.freeze({
  setting: 'Lưu ảnh biển để kiểm tra độ chính xác',
  note: 'Giữ trên máy tối đa 30 ngày các ảnh nhỏ cắt sát biển mà camera ghi nhận, để kiểm tra lại khi xe đứng yên. Ảnh có thể có một phần xe cộ phía sau biển.',
  exportWarning: 'Tệp gồm các ảnh biển đã lưu. Ảnh có thể có một phần xe cộ phía sau biển. Chỉ gửi cho người bạn tin tưởng.',
  clear: 'Xoá ảnh biển đã lưu',
  empty: 'Chưa có ảnh biển nào.',
});

const LABEL_RE = /^[A-Za-z0-9.[\]-]{1,40}$/; // nhãn của models/labels.json: 'P.127[50]', 'R.122', 'other-sign'
const REASON_RE = /^[a-z-]{1,32}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBlob = (b) => b !== null && typeof b === 'object' && typeof b.arrayBuffer === 'function' && isNum(b.size);

/**
 * IndexedDB `name` phiên bản 1, kho 'crops' (keyPath 'id'). Không có IndexedDB hoặc lỗi thì mọi thao tác thành không
 * làm gì (kho vẫn chạy trong bộ nhớ cho tới khi tải lại trang).
 */
export function evalIdbBackend(name = EVAL_DB, { indexedDB: idb = globalThis.indexedDB } = {}) {
  let dbp = null;
  // Kho được đọc lúc khởi động cả khi camEval tắt (để xoá ảnh quá hạn): chưa từng lưu ảnh nào thì đọc và xoá không mở,
  // nên không tạo cơ sở dữ liệu rỗng. Chỉ put() mới tạo. Trình duyệt không có indexedDB.databases(): mở như thường.
  const exists = async () => {
    if (dbp || !idb || typeof idb.databases !== 'function') return true;
    try {
      const list = await idb.databases();
      return !Array.isArray(list) || list.some((d) => d && d.name === name);
    } catch {
      return true;
    }
  };
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        if (!idb) return resolve(null);
        const req = idb.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
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
      if (!(await exists())) return [];
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
    delete: async (id) => (await exists()) && write((st) => st.delete(id)),
    clear: async () => (await exists()) && write((st) => st.clear()),
  };
}

/** [[nhãn, p] ×≤3] hợp lệ, nhãn đứng đầu đúng là label; không thì [[label, p]]. */
function cleanPred(pred, label, p) {
  if (!Array.isArray(pred)) return [[label, p]];
  const out = pred
    .slice(0, P.TOP_K)
    .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && LABEL_RE.test(x[0]) && isNum(x[1]) && x[1] >= 0 && x[1] <= 1)
    .map((x) => [x[0], x[1]]);
  return out.length && out[0][0] === label ? out : [[label, p]];
}

/** Một mục (khi thêm hoặc đọc từ nơi lưu) → bản sao hợp lệ, hoặc null. Chỉ giữ đúng các trường đã định. */
function sanitize(e) {
  if (!e || typeof e !== 'object') return null;
  if (!Number.isInteger(e.id) || e.id < 1 || !Number.isInteger(e.day)) return null;
  if (typeof e.label !== 'string' || !LABEL_RE.test(e.label)) return null;
  if (!isNum(e.p) || e.p < 0 || e.p > 1 || !EVAL_OUTCOMES.includes(e.outcome)) return null;
  if (e.reason != null && (typeof e.reason !== 'string' || !REASON_RE.test(e.reason))) return null;
  const b = e.blob;
  if (!isBlob(b) || b.type !== P.EVAL_CROP_TYPE || !(b.size > 0 && b.size <= EVAL_MAX_BYTES)) return null;
  return {
    id: e.id,
    day: e.day,
    label: e.label,
    p: e.p,
    outcome: e.outcome,
    reason: e.reason ?? null,
    pred: cleanPred(e.pred, e.label, e.p),
    w: isNum(e.w) && e.w > 0 && e.w <= P.MAX_FRAME_SIDE ? Math.round(e.w) : null,
    night: typeof e.night === 'boolean' ? e.night : null,
    blob: b,
  };
}

/** byte → base64 (btoa theo từng đoạn, không dựng một chuỗi nhị phân khổng lồ một lần). */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const isPng = (bytes) => bytes.length > PNG_MAGIC.length && PNG_MAGIC.every((v, i) => bytes[i] === v);

/** Blob bắt đầu bằng chữ ký PNG không. */
async function pngBlob(blob) {
  try {
    return isPng(new Uint8Array(await blob.slice(0, PNG_MAGIC.length + 1).arrayBuffer()));
  } catch {
    return false;
  }
}

export class EvalCrops {
  /**
   * @param backend  nơi lưu { getAll, put, delete, clear } (mặc định IndexedDB EVAL_DB; memoryBackend() khi kiểm thử)
   * @param now      () → ms theo đồng hồ của máy (Date.now)
   * @param enabled  () → true khi người dùng đã bật camEval. Mặc định luôn tắt: không có hàm này thì không lưu gì.
   */
  constructor({ backend = evalIdbBackend(EVAL_DB), now = () => Date.now(), enabled = () => false } = {}) {
    this.backend = backend;
    this.now = now;
    this.enabled = typeof enabled === 'function' ? enabled : () => false;
    this.rows = new Map(); // id → mục
    this.nextId = 1;
    this.listeners = new Set();
    this._loading = null;
  }

  /** Đọc nơi lưu một lần (mục hỏng bị bỏ), rồi xoá ảnh quá hạn → số ảnh. */
  load() {
    if (!this._loading) {
      this._loading = (async () => {
        let all = [];
        try {
          all = await this.backend.getAll();
        } catch {
          all = [];
        }
        for (const r of Array.isArray(all) ? all : []) {
          const e = sanitize(r);
          if (e) this.rows.set(e.id, e);
          else if (r && r.id != null) this.#drop(r.id);
        }
        for (const id of this.rows.keys()) this.nextId = Math.max(this.nextId, id + 1);
        await this.expire();
        return this.rows.size;
      })();
    }
    return this._loading;
  }

  get size() {
    return this.rows.size;
  }

  /** { total, accepted, nearMiss } */
  counts() {
    let accepted = 0;
    for (const e of this.rows.values()) if (e.outcome === 'accepted') accepted++;
    return { total: this.rows.size, accepted, nearMiss: this.rows.size - accepted };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch {
        /* bỏ qua lỗi của bên nghe */
      }
    }
  }

  #drop(id) {
    try {
      Promise.resolve(this.backend.delete(id)).catch(() => {});
    } catch {
      /* nơi lưu lỗi: mục đã bỏ khỏi bộ nhớ */
    }
  }

  /**
   * Thêm ảnh của một lượt bám (đúng dạng Learner onEvalCrop đưa: { blob, label, p, pred, w, night, outcome, reason })
   * → mục đã lưu (bản sao, không có trường lạ) hoặc null: cài đặt đang tắt, dữ liệu sai, hay ảnh không phải PNG nhỏ.
   * Kho đầy thì xoá ảnh cũ nhất (ngày sớm nhất, rồi thêm vào sớm nhất).
   */
  async add(crop) {
    if (this.enabled() !== true) return null;
    await this.load();
    if (this.enabled() !== true) return null; // có thể vừa tắt trong lúc đọc
    const e = sanitize({ ...(crop && typeof crop === 'object' ? crop : {}), id: this.nextId, day: dayNumber(this.now()) });
    if (!e || !(await pngBlob(e.blob)) || this.enabled() !== true) return null;
    e.id = this.nextId++; // lấy số mới sau lần chờ: hai lần thêm cùng lúc không trùng số
    this.rows.set(e.id, e);
    const evicted = [];
    while (this.rows.size > EVAL_MAX_CROPS) {
      const old = this.#oldest();
      this.rows.delete(old.id);
      evicted.push(old.id);
    }
    try {
      await this.backend.put({ ...e });
    } catch {
      /* nơi lưu lỗi: ảnh chỉ còn trong bộ nhớ */
    }
    for (const id of evicted) this.#drop(id);
    this.#emit();
    return { ...e };
  }

  #oldest() {
    let o = null;
    for (const e of this.rows.values()) if (!o || e.day < o.day || (e.day === o.day && e.id < o.id)) o = e;
    return o;
  }

  /** Xoá ảnh lưu từ EVAL_RETENTION_DAYS ngày trước trở lên, và ảnh mang ngày quá xa sau hôm nay → số ảnh đã xoá. */
  async expire() {
    const today = dayNumber(this.now());
    const gone = [];
    for (const e of this.rows.values()) {
      if (today - e.day >= EVAL_RETENTION_DAYS || e.day - today > EVAL_FUTURE_DAYS) gone.push(e.id);
    }
    for (const id of gone) {
      this.rows.delete(id);
      this.#drop(id);
    }
    if (gone.length) this.#emit();
    return gone.length;
  }

  /** Các ảnh, mới nhất trước: [{ id, day, label, p, outcome, reason, pred, w, night, blob }] (bản sao). */
  async list() {
    await this.load();
    await this.expire();
    return [...this.rows.values()].sort((a, b) => b.id - a.id).map((e) => ({ ...e, pred: e.pred.map((x) => x.slice()) }));
  }

  /** Xoá một ảnh → true nếu có. id là số (chuỗi số cũng được, như từ thuộc tính data-*). */
  async remove(id) {
    await this.load();
    const k = typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id;
    if (!this.rows.has(k)) return false;
    this.rows.delete(k);
    try {
      await this.backend.delete(k);
    } catch {
      /* đã bỏ khỏi bộ nhớ */
    }
    this.#emit();
    return true;
  }

  /** Xoá hết ảnh đã lưu ("Xoá ảnh biển đã lưu"). */
  async clear() {
    await this.load();
    this.rows.clear();
    try {
      await this.backend.clear();
    } catch {
      /* đã xoá khỏi bộ nhớ */
    }
    this.#emit();
  }

  /**
   * Tệp xuất (chỉ khi người dùng bấm, kèm EVAL_TEXT.exportWarning) → Blob application/json đúng định dạng vào của
   * tools/camera/label-crops.html:
   *   { version: 1, crops: [{ id: 'c<số>', png: 'data:image/png;base64,…', pred: [[nhãn, p] ×≤3], w, drive, night?,
   *                           outcome, reason }] }
   * drive là số thứ tự (chuỗi '1', '2', …) của NGÀY lưu ảnh trong tệp này, để chia tập theo chuyến đi mà không lộ ngày
   * tháng. Không có toạ độ, không có giờ. Ảnh hỏng (không phải PNG) bị bỏ.
   */
  async exportFile() {
    const rows = await this.list();
    rows.sort((a, b) => a.day - b.day || a.id - b.id);
    const days = [...new Set(rows.map((e) => e.day))];
    const drive = new Map(days.map((d, i) => [d, String(i + 1)]));
    const parts = [`{"version":${EVAL_FILE_VERSION},"crops":[`];
    let n = 0;
    for (const e of rows) {
      let bytes;
      try {
        bytes = new Uint8Array(await e.blob.arrayBuffer());
      } catch {
        continue;
      }
      if (!isPng(bytes)) continue;
      const item = { id: `c${e.id}`, png: `data:image/png;base64,${base64(bytes)}`, pred: e.pred, w: e.w, drive: drive.get(e.day) };
      if (e.night !== null) item.night = e.night;
      item.outcome = e.outcome;
      item.reason = e.reason;
      parts.push(`${n++ ? ',' : ''}${JSON.stringify(item)}`);
    }
    parts.push(']}');
    return new Blob(parts, { type: 'application/json' });
  }
}

export { memoryBackend };
