// Dữ liệu đường từ OpenStreetMap (qua Overpass API): giới hạn tốc độ của từng đoạn đường, các điểm
// cần cảnh báo (camera, trạm thu phí, đường ngang đường sắt), các nút mang biển báo hoặc thông tin
// tương đương (đèn tín hiệu, vạch qua đường, gờ giảm tốc, biển dừng…) và các quan hệ cấm rẽ.
// Lớp này chỉ lọc và lưu thẻ thô; việc hiểu ý nghĩa biển báo nằm ở nơi khác.
// Bản đồ được chia thành các ô ~3,3 km; mỗi ô tải một lần rồi lưu lại trên máy 7 ngày.

import { angleDiff, bearing, distance, projectOnSegment } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const CELL = 0.03; // kích thước ô (độ)
const GRID = 0.001; // ô lưới tra cứu đoạn đường và nút biển báo (~110 m)
const TTL = 7 * 24 * 3600e3;
const RETRY_AFTER = 60e3;
const REQUEST_TIMEOUT = 70e3; // máy chủ được chạy 60 giây, cộng thêm thời gian truyền dữ liệu
const MAX_CELLS = 16;
const CACHE_VERSION = 2; // bản ghi cũ hơn vẫn dùng tạm được nhưng sẽ được tải lại

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

// Thẻ của đường cần giữ lại để suy ra biển báo (vòng xuyến, hầm, cấm xe, hạn chế kích thước, cấm vượt…).
const WAY_KEYS = new Set([
  'junction', 'tunnel', 'access', 'vehicle', 'motor_vehicle', 'motorcar', 'motorcycle',
  'maxheight', 'maxheight:physical', 'maxheight:forward', 'maxheight:backward',
  'maxweight', 'maxweight:forward', 'maxweight:backward',
  'maxwidth', 'maxwidth:forward', 'maxwidth:backward',
  'overtaking', 'overtaking:forward', 'overtaking:backward', 'hazard',
]);

// Thẻ của nút biển báo cần giữ lại.
const FEAT_KEYS = new Set([
  'highway', 'railway', 'crossing', 'crossing_ref', 'crossing:markings', 'crossing:barrier',
  'traffic_calming', 'hazard', 'hazard:direction',
  'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward', 'traffic_sign:direction',
  'traffic_signals:direction', 'direction', 'stop', 'stop:direction', 'give_way:direction',
  'maxspeed', 'overtaking', 'maxheight', 'maxweight', 'maxwidth', 'barrier', 'code', 'content', 'name',
]);

const FEAT_HIGHWAY = new Set(['traffic_signals', 'stop', 'give_way', 'crossing', 'mini_roundabout']);
const MAX_TAG_LEN = 80;
const MAX_RESTR_TAG_LEN = 120;

export const cellOf = (coord) => [Math.floor(coord[0] / CELL), Math.floor(coord[1] / CELL)];
export const cellKey = (cx, cy) => `${cx}:${cy}`;

// Khoá so khớp chính xác một đỉnh của đường (toạ độ OSM có 7 chữ số thập phân).
const vkey = (lon, lat) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
export const vertexKey = (coord) => vkey(coord[0], coord[1]);

export function buildQuery(cx, cy) {
  const w = (cx * CELL).toFixed(5);
  const s = (cy * CELL).toFixed(5);
  const e = ((cx + 1) * CELL).toFixed(5);
  const n = ((cy + 1) * CELL).toFixed(5);
  return (
    `[out:json][timeout:60][maxsize:134217728][bbox:${s},${w},${n},${e}];` +
    `way["highway"~"^(${DRIVABLE})$"]->.roads;` +
    // Nút nằm trên đường xe chạy: chỉ lấy những nút có thẻ cần dùng.
    `node(w.roads)->.rn;(` +
    `node.rn["highway"~"^(traffic_signals|stop|give_way|crossing|mini_roundabout|speed_camera|toll_gantry)$"];` +
    `node.rn["traffic_calming"];` +
    `node.rn["railway"="level_crossing"];` +
    `node.rn["barrier"~"^(toll_booth|height_restrictor)$"];` +
    `node.rn["traffic_sign"];` +
    `node.rn["traffic_sign:forward"];` +
    `node.rn["traffic_sign:backward"];` +
    `node.rn["hazard"];` +
    // Biển và điểm cảnh báo đứng riêng bên lề đường.
    `node["traffic_sign"];` +
    `node["hazard"];` +
    `node["highway"~"^(speed_camera|stop|give_way|toll_gantry)$"];` +
    `node["man_made"="surveillance"]["surveillance:zone"="traffic"];` +
    `node["barrier"="toll_booth"];` +
    `)->.pts;` +
    `rel(bw.roads)["type"="restriction"]->.restr;` +
    // Theo mã nguồn Overpass, node(r.restr:"via") là câu lệnh đệ quy đứng riêng nên không bị khung [bbox]
    // chung giới hạn: nút "via" nằm ngoài ô vẫn được in ra (chưa kiểm chứng trên máy chủ thật).
    `node(r.restr:"via")->.via;` +
    `rel["type"="enforcement"]->.enf;` +
    // Đường chỉ cần thẻ và hình học; mảng id nút không dùng tới mà chiếm khoảng 20% dung lượng sau khi nén.
    `.roads out tags geom qt;` +
    `.pts out body qt;` +
    `.restr out body qt;` +
    `.via out skel qt;` +
    `.enf out body geom qt;`
  );
}

/** Đọc giá trị maxspeed của OSM thành km/h; trả về null nếu không phải con số rõ ràng. */
export function parseMaxspeed(raw) {
  if (raw == null) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(mph|km\/h|kmh|kph)?$/i.exec(String(raw).trim());
  if (!m) return null;
  let v = parseFloat(m[1].replace(',', '.'));
  if ((m[2] || '').toLowerCase() === 'mph') v *= 1.609344;
  v = Math.round(v);
  // Dưới 10 km/h là dữ liệu nhập sai (ở Việt Nam hay gặp maxspeed=5).
  return v >= 10 && v <= 150 ? v : null;
}

/**
 * Phản hồi Overpass vẫn là JSON hợp lệ khi truy vấn hết giờ hoặc hết bộ nhớ, chỉ kèm "remark".
 * Trả về nội dung lỗi (để thử máy chủ khác, không lưu vào bộ đệm) hoặc null nếu dùng được.
 */
export function overpassFailure(json) {
  const remark = typeof json?.remark === 'string' ? json.remark : '';
  return /runtime error|timed out|out of memory/i.test(remark) ? remark : null;
}

/** Gộp các điểm cùng loại nằm sát nhau (ví dụ từng làn của một trạm thu phí). */
function dedupeNear(points, radius) {
  const kept = [];
  for (const p of points) {
    if (!kept.some((q) => q.kind === p.kind && distance(q.coord, p.coord) < radius)) kept.push(p);
  }
  return kept;
}

/** Chỉ giữ các thẻ cần dùng và cắt giá trị quá dài (thẻ OSM là dữ liệu không đáng tin). Trả về null nếu rỗng. */
function pickTags(tags, keep, maxLen) {
  let out = null;
  for (const k of Object.keys(tags)) {
    if (!keep(k)) continue;
    if (!out) out = {};
    out[k] = String(tags[k]).slice(0, maxLen);
  }
  return out;
}

const keepWayTag = (k) => WAY_KEYS.has(k);
const keepFeatTag = (k) => FEAT_KEYS.has(k);
const keepRestrTag = (k) => k === 'restriction' || k.startsWith('restriction:') || k === 'except' || k === 'type';

/** Nút có mang biển báo hoặc thông tin tương đương biển báo không. */
function isFeatureNode(tags) {
  return (
    tags.traffic_sign != null ||
    tags['traffic_sign:forward'] != null ||
    tags['traffic_sign:backward'] != null ||
    tags.hazard != null ||
    tags.traffic_calming != null ||
    tags.railway === 'level_crossing' ||
    FEAT_HIGHWAY.has(tags.highway) ||
    tags.barrier === 'height_restrictor'
  );
}

function parseWay(el) {
  const tags = el.tags || {};
  if (!tags.highway || !Array.isArray(el.geometry) || el.geometry.length < 2) return null;
  const general = parseMaxspeed(tags.maxspeed);
  const g = [];
  for (const pt of el.geometry) if (pt) g.push(pt.lon, pt.lat);
  if (g.length < 4) return null;
  const way = {
    id: el.id,
    n: tags.name || tags.ref || '',
    h: tags.highway,
    c: parseMaxspeed(tags['maxspeed:motorcar']) ?? general,
    m: parseMaxspeed(tags['maxspeed:motorcycle']) ?? general,
    o: tags.oneway === 'yes' || tags.junction === 'roundabout' ? 1 : tags.oneway === '-1' ? -1 : 0,
    g,
  };
  const t = pickTags(tags, keepWayTag, MAX_TAG_LEN);
  if (t) way.t = t;
  return way;
}

/**
 * Quan hệ cấm rẽ: chỉ nhận loại có đúng một đường "from", một đường "to" và một NÚT "via" biết toạ độ.
 * Loại "via" là đường (cấm quay đầu qua dải phân cách…) bị bỏ qua vì cần ghép nhiều đoạn đường.
 */
function parseRestriction(el, coordOf) {
  const from = [];
  const to = [];
  const via = [];
  for (const m of el.members || []) {
    if (m.role === 'from') from.push(m);
    else if (m.role === 'to') to.push(m);
    else if (m.role === 'via') via.push(m);
  }
  if (from.length !== 1 || to.length !== 1 || via.length !== 1) return null;
  if (from[0].type !== 'way' || to[0].type !== 'way' || via[0].type !== 'node') return null;
  const coord = coordOf(via[0].ref);
  if (!coord) return null;
  return {
    id: `r${el.id}`,
    from: from[0].ref,
    to: to[0].ref,
    via: coord,
    tags: pickTags(el.tags || {}, keepRestrTag, MAX_RESTR_TAG_LEN) || {},
  };
}

/** Chuyển phản hồi Overpass thành { ways, points, feats, restr, base } gọn nhẹ. */
export function parseOverpass(json) {
  const elements = json?.elements || [];
  const ways = [];
  const vertices = new Set();
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const way = parseWay(el);
    if (!way) continue;
    ways.push(way);
    for (let i = 0; i < way.g.length; i += 2) vertices.add(vkey(way.g[i], way.g[i + 1]));
  }

  const byId = new Map();
  const add = (p) => {
    const old = byId.get(p.id);
    // Thông tin từ quan hệ "enforcement" chi tiết hơn thẻ trên nút nên được ưu tiên.
    if (!old || p.fromRelation) byId.set(p.id, { ...old, ...p });
  };
  const nodeCoord = new Map(); // mọi nút được in ra, kể cả bản "out skel" không có thẻ
  const feats = new Map();
  const restrEls = [];

  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      const coord = [el.lon, el.lat];
      const id = `n${el.id}`;
      nodeCoord.set(el.id, coord);
      if (tags.highway === 'speed_camera') {
        add({ id, kind: 'camera', sub: 'speed', limit: parseMaxspeed(tags.maxspeed), coord });
      } else if (tags.man_made === 'surveillance' && tags['surveillance:zone'] === 'traffic') {
        add({ id, kind: 'camera', sub: 'traffic', limit: null, coord });
      } else if (tags.barrier === 'toll_booth' || tags.highway === 'toll_gantry') {
        add({ id, kind: 'toll', sub: '', limit: null, coord, name: tags.name || '' });
      } else if (tags.railway === 'level_crossing') {
        add({ id, kind: 'rail', sub: '', limit: null, coord });
      }
      // Nút in hai lần (nhóm điểm và nhóm "via"): bản có thẻ là bản được giữ.
      if (!feats.has(id) && isFeatureNode(tags)) {
        feats.set(id, {
          id,
          coord,
          onWay: vertices.has(vkey(el.lon, el.lat)),
          tags: pickTags(tags, keepFeatTag, MAX_TAG_LEN) || {},
        });
      }
    } else if (el.type === 'relation' && tags.type === 'enforcement') {
      const sub =
        tags.enforcement === 'maxspeed' || tags.enforcement === 'average_speed'
          ? 'speed'
          : tags.enforcement === 'traffic_signals'
            ? 'redlight'
            : 'traffic';
      for (const mem of el.members || []) {
        if (mem.type === 'node' && mem.role === 'device' && Number.isFinite(mem.lat)) {
          add({
            id: `n${mem.ref}`,
            kind: 'camera',
            sub,
            limit: parseMaxspeed(tags.maxspeed),
            coord: [mem.lon, mem.lat],
            fromRelation: true,
          });
        }
      }
    } else if (el.type === 'relation' && tags.type === 'restriction') {
      restrEls.push(el);
    }
  }

  // Toạ độ nút "via" lấy từ nhóm ".via out skel" (hoặc nhóm điểm, nếu nút có thẻ).
  const restr = [];
  for (const el of restrEls) {
    const r = parseRestriction(el, (ref) => nodeCoord.get(ref));
    if (r) restr.push(r);
  }

  const all = [...byId.values()].map(({ fromRelation, ...p }) => p);
  const points = [
    ...dedupeNear(all.filter((p) => p.kind === 'camera'), 15),
    ...dedupeNear(all.filter((p) => p.kind === 'toll'), 120),
    ...dedupeNear(all.filter((p) => p.kind === 'rail'), 40),
  ];
  const base = typeof json?.osm3s?.timestamp_osm_base === 'string' ? json.osm3s.timestamp_osm_base : null;
  return { ways, points, feats: [...feats.values()], restr, base };
}

/** Lập chỉ mục lưới cho các đoạn đường của một ô để tra đoạn gần vị trí hiện tại. */
function buildIndex(ways) {
  const grid = new Map();
  ways.forEach((way, wi) => {
    const g = way.g;
    for (let i = 0; i + 3 < g.length; i += 2) {
      const x0 = Math.floor(Math.min(g[i], g[i + 2]) / GRID);
      const x1 = Math.floor(Math.max(g[i], g[i + 2]) / GRID);
      const y0 = Math.floor(Math.min(g[i + 1], g[i + 3]) / GRID);
      const y1 = Math.floor(Math.max(g[i + 1], g[i + 3]) / GRID);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue; // đoạn dài bất thường: bỏ qua
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${x}:${y}`;
          let bucket = grid.get(key);
          if (!bucket) grid.set(key, (bucket = []));
          bucket.push(wi, i);
        }
      }
    }
  });
  return grid;
}

/** Chỉ mục đỉnh: khoá toạ độ → [chỉ số đường, chỉ số điểm, …] (một đỉnh có thể thuộc nhiều đường). */
function buildVertexIndex(ways) {
  const index = new Map();
  ways.forEach((way, wi) => {
    const g = way.g;
    for (let i = 0; i < g.length; i += 2) {
      const key = vkey(g[i], g[i + 1]);
      const list = index.get(key);
      if (list) list.push(wi, i / 2);
      else index.set(key, [wi, i / 2]);
    }
  });
  return index;
}

/** Lưới tra cứu nút biển báo theo ô GRID: khoá ô → [chỉ số nút, …]. */
function buildFeatGrid(feats) {
  const grid = new Map();
  feats.forEach((f, fi) => {
    const key = `${Math.floor(f.coord[0] / GRID)}:${Math.floor(f.coord[1] / GRID)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(fi);
    else grid.set(key, [fi]);
  });
  return grid;
}

/** Nhóm các quan hệ cấm rẽ theo đường "from". */
function groupRestrictions(restr) {
  const byFrom = new Map();
  for (const r of restr) {
    const list = byFrom.get(r.from);
    if (list) list.push(r);
    else byFrom.set(r.from, [r]);
  }
  return byFrom;
}

// ---- Bộ nhớ đệm IndexedDB (không bắt buộc: lỗi thì chỉ dùng bộ nhớ trong) ----

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('banduong', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('cells', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function dbGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction('cells').objectStore('cells').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function dbPut(record) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction('cells', 'readwrite').objectStore('cells').put(record);
  } catch {
    /* bỏ qua */
  }
}

export async function clearRoadCache() {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction('cells', 'readwrite').objectStore('cells').clear();
  } catch {
    /* bỏ qua */
  }
}

const IDB_CACHE = { get: dbGet, put: dbPut };

/** Bản ghi (hoặc ô trong bộ nhớ) đúng phiên bản và chưa quá 7 ngày. */
const isFresh = (rec) => rec.v === CACHE_VERSION && Date.now() - rec.t < TTL;

export class RoadData {
  /**
   * @param fetchImpl  thay cho fetch (kiểm thử)
   * @param cache      { get(key) → Promise<bản ghi|null>, put(bản ghi) } thay cho IndexedDB (kiểm thử)
   */
  constructor({ fetchImpl, cache } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.cache = cache || IDB_CACHE;
    this.cells = new Map(); // key → { ways, points, feats, restr, base, v, t, grid, vertices, featGrid, restrFrom, used }
    this.reading = new Map(); // ô đang đọc từ bộ đệm trên máy
    this.cacheChecked = new Set(); // ô đã đọc bộ đệm xong (kể cả khi không có bản ghi)
    this.pending = new Map(); // ô đang tải từ Overpass (tối đa hai)
    this.failedAt = new Map();
    this.listeners = new Set();
    this.endpoint = 0;
    this.status = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** Đưa trực tiếp dữ liệu một ô vào bộ nhớ (dùng khi đọc từ bộ đệm và khi kiểm thử). */
  setCell(key, data) {
    const ways = data.ways || [];
    const feats = data.feats || [];
    const restr = data.restr || [];
    this.cells.set(key, {
      ways,
      points: data.points || [],
      feats,
      restr,
      base: data.base || null,
      // Phiên bản và thời điểm tải của bản ghi: thiếu hoặc quá hạn thì ô được tải lại khi có dịp.
      v: data.v ?? null,
      t: data.t ?? 0,
      grid: buildIndex(ways),
      vertices: buildVertexIndex(ways),
      featGrid: buildFeatGrid(feats),
      restrFrom: groupRestrictions(restr),
      used: Date.now(),
    });
    if (this.cells.size > MAX_CELLS) {
      const oldest = [...this.cells.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.cells.delete(oldest[0]);
      this.cacheChecked.delete(oldest[0]); // quay lại ô này thì đọc bộ đệm trước
    }
  }

  async #readCache(key) {
    try {
      return (await this.cache.get(key)) || null;
    } catch {
      return null;
    }
  }

  #writeCache(record) {
    try {
      const p = this.cache.put(record);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* bỏ qua */
    }
  }

  /** Đọc ô từ bộ đệm trên máy, rồi tải từ mạng nếu không có bản ghi hoặc bản ghi đã cũ. */
  async #readCell(key, cx, cy) {
    const cached = await this.#readCache(key);
    this.cacheChecked.add(key);
    // Ô đã có trong bộ nhớ (vừa tải xong từ mạng) thì mới hơn bộ đệm.
    if (cached && !this.cells.has(key)) {
      this.setCell(key, cached);
      this.status = 'ready';
      this.#emit();
    }
    this.#want(cx, cy);
  }

  async #fetchCell(cx, cy) {
    const key = cellKey(cx, cy);
    const body = `data=${encodeURIComponent(buildQuery(cx, cy))}`;
    // Đọc một lần: lượt tải chạy song song có thể đổi this.endpoint trong lúc chờ.
    const start = this.endpoint;
    for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
      const index = (start + attempt) % OVERPASS_ENDPOINTS.length;
      const url = OVERPASS_ENDPOINTS[index];
      // Máy chủ treo thì bỏ sau 70 giây để còn thử máy chủ kế tiếp.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const failure = overpassFailure(json);
        if (failure) throw new Error(failure); // dữ liệu thiếu: không dùng, không lưu
        const data = parseOverpass(json);
        this.endpoint = index;
        const record = {
          key,
          v: CACHE_VERSION,
          t: Date.now(),
          base: data.base,
          ways: data.ways,
          points: data.points,
          feats: data.feats,
          restr: data.restr,
        };
        this.setCell(key, record);
        this.#writeCache(record);
        this.failedAt.delete(key);
        this.status = 'ready';
        this.#emit();
        return;
      } catch {
        /* thử máy chủ kế tiếp */
      } finally {
        clearTimeout(timer);
      }
    }
    this.failedAt.set(key, Date.now());
    this.status = this.cells.has(key) ? 'ready' : 'error';
    this.#emit();
  }

  #want(cx, cy) {
    const key = cellKey(cx, cy);
    const cell = this.cells.get(key);
    if (cell) {
      cell.used = Date.now();
      if (isFresh(cell)) return;
      // Dữ liệu cũ (bản ghi kiểu cũ hoặc quá 7 ngày) vẫn được dùng trong lúc chờ tải lại.
    } else if (!this.cacheChecked.has(key)) {
      // Đọc bộ đệm trên máy trước: chỉ mất vài mili giây nên không tính vào giới hạn truy vấn Overpass.
      if (!this.reading.has(key) && !this.pending.has(key)) {
        if (this.status !== 'ready') this.status = 'loading';
        const job = this.#readCell(key, cx, cy).finally(() => this.reading.delete(key));
        this.reading.set(key, job);
      }
      return;
    }
    if (this.pending.has(key)) return;
    if (Date.now() - (this.failedAt.get(key) || 0) < RETRY_AFTER) return;
    // Overpass giới hạn số truy vấn đồng thời: tối đa hai. Ô đã có dữ liệu (dù cũ) chỉ được tải lại khi
    // không còn lượt tải nào khác, để ô chưa có dữ liệu luôn còn chỗ.
    if (this.pending.size >= (cell ? 1 : 2)) return;
    if (this.status !== 'ready') this.status = 'loading';
    const job = this.#fetchCell(cx, cy).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
  }

  /** Bảo đảm đã có dữ liệu quanh vị trí hiện tại và ô sắp đi tới. */
  ensureAround(coord, heading = null) {
    const [cx, cy] = cellOf(coord);
    this.#want(cx, cy);
    // Sắp ra khỏi ô (cách mép dưới ~700 m) thì tải luôn ô bên cạnh.
    const fx = coord[0] / CELL - cx;
    const fy = coord[1] / CELL - cy;
    const edge = 0.2;
    const dx = fx < edge ? -1 : fx > 1 - edge ? 1 : 0;
    const dy = fy < edge ? -1 : fy > 1 - edge ? 1 : 0;
    if (dx) this.#want(cx + dx, cy);
    if (dy) this.#want(cx, cy + dy);
    if (dx && dy) this.#want(cx + dx, cy + dy);
    if (heading != null) {
      // Nhìn trước ~2 km theo hướng đang đi.
      const ahead = [
        coord[0] + (Math.sin((heading * Math.PI) / 180) * 0.018) / Math.cos((coord[1] * Math.PI) / 180),
        coord[1] + Math.cos((heading * Math.PI) / 180) * 0.018,
      ];
      const [ax, ay] = cellOf(ahead);
      this.#want(ax, ay);
    }
  }

  #neighbours(coord) {
    const [cx, cy] = cellOf(coord);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(cellKey(cx + dx, cy + dy));
        if (cell) out.push(cell);
      }
    }
    return out;
  }

  /** Có dữ liệu cho ô chứa vị trí này chưa. */
  hasData(coord) {
    const [cx, cy] = cellOf(coord);
    return this.cells.has(cellKey(cx, cy));
  }

  /** Các điểm cảnh báo trong bán kính (m) quanh vị trí. */
  pointsNear(coord, radius) {
    const seen = new Set();
    const out = [];
    for (const cell of this.#neighbours(coord)) {
      for (const p of cell.points) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (distance(coord, p.coord) <= radius) out.push(p);
      }
    }
    return out;
  }

  /** Mọi điểm cảnh báo đang có trong bộ nhớ (để vẽ lên bản đồ). */
  allPoints() {
    const seen = new Map();
    for (const cell of this.cells.values()) for (const p of cell.points) seen.set(p.id, p);
    return [...seen.values()];
  }

  /**
   * Các đường có một đỉnh trùng đúng toạ độ này: [{ way, i }] với i là chỉ số điểm (chỉ số trong g chia 2).
   * Một đường có mặt ở nhiều ô chỉ được trả về một lần; riêng đường khép kín (vòng xuyến vẽ thành một vòng)
   * có điểm đầu trùng điểm cuối thì trả về cả hai chỉ số để bên gọi biết có thể đi theo cả hai phía.
   */
  waysAtVertex(coord) {
    const key = vertexKey(coord);
    const seen = new Set();
    const out = [];
    for (const cell of this.#neighbours(coord)) {
      const list = cell.vertices.get(key);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const way = cell.ways[list[k]];
        const i = list[k + 1];
        const id = `${way.id}:${i}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ way, i });
      }
    }
    return out;
  }

  /** Các nút biển báo trong bán kính (m) quanh vị trí (bán kính nhỏ, tối đa vài km). */
  featsNear(coord, radius) {
    const dLat = radius / 110000;
    const dLon = dLat / Math.max(0.05, Math.cos((coord[1] * Math.PI) / 180));
    const x0 = Math.floor((coord[0] - dLon) / GRID);
    const x1 = Math.floor((coord[0] + dLon) / GRID);
    const y0 = Math.floor((coord[1] - dLat) / GRID);
    const y1 = Math.floor((coord[1] + dLat) / GRID);
    const seen = new Set();
    const out = [];
    for (const cell of this.#neighbours(coord)) {
      if (!cell.feats.length) continue;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const bucket = cell.featGrid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (const fi of bucket) {
            const f = cell.feats[fi];
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            if (distance(coord, f.coord) <= radius) out.push(f);
          }
        }
      }
    }
    return out;
  }

  /** Các quan hệ cấm rẽ bắt đầu từ đường này (theo id đường OSM). */
  restrictionsFrom(wayId) {
    const seen = new Set();
    const out = [];
    for (const cell of this.cells.values()) {
      const list = cell.restrFrom.get(wayId);
      if (!list) continue;
      for (const r of list) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  /** Thời điểm dữ liệu OSM mới nhất trong các ô đang có (chuỗi ISO của Overpass) hoặc null. */
  dataTimestamp() {
    let newest = null;
    for (const cell of this.cells.values()) {
      if (cell.base && (!newest || cell.base > newest)) newest = cell.base;
    }
    return newest;
  }

  /**
   * Tìm đoạn đường khớp nhất với vị trí và hướng đi.
   * Trả về { way, dist, seg, t, point, dir } hoặc null khi không có đoạn nào đủ gần:
   * seg = chỉ số điểm đầu của đoạn khớp, t = vị trí 0..1 trên đoạn, point = điểm chiếu lên đường,
   * dir = +1 đi xuôi chiều vẽ đường, −1 đi ngược chiều vẽ, 0 khi không di chuyển hoặc không có hướng.
   */
  matchWay(fix, hintName = '') {
    const { coord } = fix;
    const moving = fix.heading != null && (fix.speed || 0) > 2.5;
    const maxDist = Math.max(30, Math.min(60, fix.accuracy || 0));
    const gx = Math.floor(coord[0] / GRID);
    const gy = Math.floor(coord[1] / GRID);
    let best = null;

    for (const cell of this.#neighbours(coord)) {
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          const bucket = cell.grid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b += 2) {
            const way = cell.ways[bucket[b]];
            const i = bucket[b + 1];
            const a = [way.g[i], way.g[i + 1]];
            const c = [way.g[i + 2], way.g[i + 3]];
            const pr = projectOnSegment(coord, a, c);
            if (pr.dist > maxDist) continue;
            let score = pr.dist;
            let dir = 0;
            if (moving) {
              const raw = Math.abs(angleDiff(bearing(a, c), fix.heading));
              let diff = raw;
              if (way.o === -1) diff = 180 - raw;
              else if (way.o === 0) diff = Math.min(raw, 180 - raw);
              if (diff > 50) continue; // đường cắt ngang hoặc ngược chiều
              score += diff * 0.6;
              dir = raw <= 90 ? 1 : -1;
            }
            if (hintName && way.n === hintName) score -= 15;
            if (!best || score < best.score) {
              best = { way, dist: pr.dist, score, seg: i / 2, t: pr.t, point: pr.point, dir };
            }
          }
        }
      }
    }
    if (!best) return null;
    const { score, ...match } = best;
    return match;
  }
}
