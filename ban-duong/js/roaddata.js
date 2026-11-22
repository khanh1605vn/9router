// Dữ liệu đường từ OpenStreetMap (qua Overpass API): giới hạn tốc độ của từng đoạn đường và
// các điểm cần cảnh báo (camera, trạm thu phí, đường ngang đường sắt).
// Bản đồ được chia thành các ô ~3,3 km; mỗi ô tải một lần rồi lưu lại trên máy 7 ngày.

import { angleDiff, bearing, distance, projectOnSegment } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const CELL = 0.03; // kích thước ô (độ)
const GRID = 0.001; // ô lưới tra cứu đoạn đường (~110 m)
const TTL = 7 * 24 * 3600e3;
const RETRY_AFTER = 60e3;
const REQUEST_TIMEOUT = 25e3;
const MAX_CELLS = 16;

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

export const cellOf = (coord) => [Math.floor(coord[0] / CELL), Math.floor(coord[1] / CELL)];
export const cellKey = (cx, cy) => `${cx}:${cy}`;

export function buildQuery(cx, cy) {
  const w = (cx * CELL).toFixed(5);
  const s = (cy * CELL).toFixed(5);
  const e = ((cx + 1) * CELL).toFixed(5);
  const n = ((cy + 1) * CELL).toFixed(5);
  return (
    `[out:json][timeout:25][bbox:${s},${w},${n},${e}];(` +
    `way["highway"~"^(${DRIVABLE})$"];` +
    `node["highway"="speed_camera"];` +
    `node["man_made"="surveillance"]["surveillance:zone"="traffic"];` +
    `node["barrier"="toll_booth"];` +
    `node["highway"="toll_gantry"];` +
    `node["railway"="level_crossing"];` +
    `relation["type"="enforcement"];` +
    `);out body geom qt;`
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
  return v >= 5 && v <= 150 ? v : null;
}

/** Gộp các điểm cùng loại nằm sát nhau (ví dụ từng làn của một trạm thu phí). */
function dedupeNear(points, radius) {
  const kept = [];
  for (const p of points) {
    if (!kept.some((q) => q.kind === p.kind && distance(q.coord, p.coord) < radius)) kept.push(p);
  }
  return kept;
}

/** Chuyển phản hồi Overpass thành { ways, points } gọn nhẹ. */
export function parseOverpass(json) {
  const ways = [];
  const byId = new Map();
  const add = (p) => {
    const old = byId.get(p.id);
    // Thông tin từ quan hệ "enforcement" chi tiết hơn thẻ trên nút nên được ưu tiên.
    if (!old || p.fromRelation) byId.set(p.id, { ...old, ...p });
  };

  for (const el of json?.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'way' && tags.highway && Array.isArray(el.geometry) && el.geometry.length > 1) {
      const general = parseMaxspeed(tags.maxspeed);
      const g = [];
      for (const pt of el.geometry) if (pt) g.push(pt.lon, pt.lat);
      if (g.length < 4) continue;
      ways.push({
        id: el.id,
        n: tags.name || tags.ref || '',
        h: tags.highway,
        c: parseMaxspeed(tags['maxspeed:motorcar']) ?? general,
        m: parseMaxspeed(tags['maxspeed:motorcycle']) ?? general,
        o: tags.oneway === 'yes' || tags.junction === 'roundabout' ? 1 : tags.oneway === '-1' ? -1 : 0,
        g,
      });
    } else if (el.type === 'node' && Number.isFinite(el.lat)) {
      const coord = [el.lon, el.lat];
      if (tags.highway === 'speed_camera') {
        add({ id: `n${el.id}`, kind: 'camera', sub: 'speed', limit: parseMaxspeed(tags.maxspeed), coord });
      } else if (tags.man_made === 'surveillance') {
        add({ id: `n${el.id}`, kind: 'camera', sub: 'traffic', limit: null, coord });
      } else if (tags.barrier === 'toll_booth' || tags.highway === 'toll_gantry') {
        add({ id: `n${el.id}`, kind: 'toll', sub: '', limit: null, coord, name: tags.name || '' });
      } else if (tags.railway === 'level_crossing') {
        add({ id: `n${el.id}`, kind: 'rail', sub: '', limit: null, coord });
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
    }
  }

  const all = [...byId.values()].map(({ fromRelation, ...p }) => p);
  const points = [
    ...dedupeNear(all.filter((p) => p.kind === 'camera'), 15),
    ...dedupeNear(all.filter((p) => p.kind === 'toll'), 120),
    ...dedupeNear(all.filter((p) => p.kind === 'rail'), 40),
  ];
  return { ways, points };
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

export class RoadData {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.cells = new Map(); // key → { ways, points, grid, used }
    this.pending = new Map();
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
    this.cells.set(key, { ways: data.ways, points: data.points, grid: buildIndex(data.ways), used: Date.now() });
    if (this.cells.size > MAX_CELLS) {
      const oldest = [...this.cells.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.cells.delete(oldest[0]);
    }
  }

  async #load(cx, cy) {
    const key = cellKey(cx, cy);
    const cached = await dbGet(key);
    const fresh = cached && Date.now() - cached.t < TTL;
    if (cached) {
      this.setCell(key, cached);
      this.#emit();
      if (fresh) return;
    }
    const body = `data=${encodeURIComponent(buildQuery(cx, cy))}`;
    for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
      const url = OVERPASS_ENDPOINTS[(this.endpoint + attempt) % OVERPASS_ENDPOINTS.length];
      // Máy chủ treo thì bỏ sau 25 giây để còn thử máy chủ kế tiếp.
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
        const data = parseOverpass(await res.json());
        this.endpoint = (this.endpoint + attempt) % OVERPASS_ENDPOINTS.length;
        this.setCell(key, data);
        dbPut({ key, t: Date.now(), ways: data.ways, points: data.points });
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
    this.status = cached ? 'ready' : 'error';
    this.#emit();
  }

  #want(cx, cy) {
    const key = cellKey(cx, cy);
    const cell = this.cells.get(key);
    if (cell) {
      cell.used = Date.now();
      return;
    }
    if (this.pending.has(key)) return;
    if (Date.now() - (this.failedAt.get(key) || 0) < RETRY_AFTER) return;
    if (this.pending.size >= 2) return; // Overpass giới hạn số truy vấn đồng thời
    if (this.status !== 'ready') this.status = 'loading';
    const job = this.#load(cx, cy).finally(() => this.pending.delete(key));
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
   * Tìm đoạn đường khớp nhất với vị trí và hướng đi.
   * Trả về { way, dist } hoặc null khi không có đoạn nào đủ gần.
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
            if (moving) {
              let diff = Math.abs(angleDiff(bearing(a, c), fix.heading));
              if (way.o === -1) diff = 180 - diff;
              else if (way.o === 0) diff = Math.min(diff, 180 - diff);
              if (diff > 50) continue; // đường cắt ngang hoặc ngược chiều
              score += diff * 0.6;
            }
            if (hintName && way.n === hintName) score -= 15;
            if (!best || score < best.score) best = { way, dist: pr.dist, score };
          }
        }
      }
    }
    return best ? { way: best.way, dist: best.dist } : null;
  }
}
