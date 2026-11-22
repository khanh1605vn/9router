// Bộ máy cảnh báo biển báo phía trước (báo trước khoảng 100–200 m). Thuần logic, không đụng tới DOM.
// 1. Dựng "hành lang" ~320 m phía trước: theo tuyến khi đang dẫn đường, hoặc đoán theo đường đang chạy.
// 2. Gom các mục nằm trên hành lang: nút biển báo và thông tin tương đương (đèn, vạch qua đường, gờ giảm
//    tốc…), thay đổi khi sang đoạn đường khác (tốc độ, vòng xuyến, hầm, một chiều, cấm xe…), cấm rẽ, và
//    chỗ ngoặt tính từ hình dạng đường.
// 3. Quyết định khi nào đọc, gộp các mục gần nhau vào một câu, chọn mục hiện trên thanh cảnh báo.

import { angleDiff, bearing, distance, nearestOnLine, pointAtDistance } from './geo.js';
import { vertexKey } from './roaddata.js';
import { categoryEnabled, classifyNode, classifyWay, derived, parseDirection } from './signs.js';
import { spokenDistance } from './tracker.js';

const LENGTH = 320; // chiều dài hành lang phía trước (m)
const MAX_PIECES = 8; // số đoạn đường tối đa khi đoán đường đi tiếp
const NAV_SAMPLE = 20; // khoảng lấy mẫu tuyến để khớp với đoạn đường (m)
const CONT_ANGLE = 35; // góc lệch tối đa khi đoán đường đi thẳng qua nút giao (độ)
const CONT_MARGIN = 10; // nhánh tốt nhất phải thẳng hơn nhánh kế tiếp ít nhất chừng này (độ)
const DUAL_SPLIT = 20; // nhánh đúng chiều lệch hơn nhánh ngược chiều không quá chừng này thì được ưu tiên (độ)
const FEAT_STEP = 60; // khoảng giữa các điểm tra cứu nút biển dọc hành lang (m)
const FEAT_RADIUS = 70;
const ON_WAY_LATERAL = 8; // nút nằm trên đường: lệch ngang tối đa (m)
const OFF_WAY_LATERAL = 25; // biển đứng bên lề: lệch ngang tối đa (m)
const VIA_LATERAL = 8; // nút "via" của cấm rẽ: lệch ngang tối đa (m)
const VIA_TO_END = 15; // nút "via" phải gần cuối đoạn đường đang đi (m)
const UPCOMING_RANGE = 300;
const UPCOMING_MAX = 3;
const FORGET = 500; // xe cách xa mục đã báo hơn chừng này thì quên, lần sau quay lại vẫn báo
const MERGE_GAP = 40; // các mục cách nhau không quá chừng này được đọc chung một câu (m)
const MAX_PER_SENTENCE = 3;
const SPEAK_INTERVAL = 3000; // tối đa một câu mỗi 3 giây
const MIN_SPEAK_SPEED = 1.5; // dưới tốc độ này (m/s) không đọc câu mới
const SAME_KIND_GAP = 80; // biển cùng loại sát biển vừa đọc (đèn ở hai phía giao lộ…) thì không đọc lại (m)
const CURVE_ALIAS = 60; // chỗ ngoặt lệch vị trí trong khoảng này vẫn coi là một (m)
const HOLD_MS = 5000; // mất khớp đường một lúc thì vẫn giữ thanh cảnh báo chừng này
const JUNCTION_SCAN = 150; // tìm nút giao gần biển dừng/nhường đường trong khoảng này (m)
const MEMO_REFRESH = 60e3; // tính lại kết quả tra cứu phụ thuộc ô bên cạnh mỗi phút (ms)

// Cong: lấy mẫu mỗi 10 m, cửa sổ tối đa 90 m, tổng góc đổi hướng ≥ 55°.
const CURVE_STEP = 10;
const CURVE_SPAN = 9;
const CURVE_TURN = 55;
const CURVE_RADIUS = 120;
const CURVE_MIN_SPEED = 8.3; // 30 km/h
const CURVE_MIN_ACCEL = 1.5; // v²/R (m/s²)
const CURVE_JOIN = 30; // hai đoạn cong cùng phía cách nhau không quá chừng này là một chỗ ngoặt (m)
const CURVES_GAP = 150; // hai chỗ ngoặt ngược phía trong khoảng này → "nhiều chỗ ngoặt liên tiếp"
const MANEUVER_GAP = 35; // khi dẫn đường: chỗ rẽ của tuyến không phải chỗ ngoặt

// Hạng đường (số nhỏ = đường lớn), dùng để biết biển dừng tại nút giao thuộc về đường nào.
const RANK = {
  motorway: 1, motorway_link: 1, trunk: 2, trunk_link: 2, primary: 3, primary_link: 3,
  secondary: 4, secondary_link: 4, tertiary: 5, tertiary_link: 5, unclassified: 6,
  residential: 7, living_street: 8,
};

const EARTH = 6371008.8;
const RAD = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Tiện ích hình học
// ---------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const vertexCount = (way) => way.g.length >> 1;
const vertexAt = (way, i) => [way.g[2 * i], way.g[2 * i + 1]];
const lengthOf = (corr) => (corr.cum.length ? corr.cum[corr.cum.length - 1] : 0);
const emptyCorridor = () => ({ coords: [], cum: [], pieces: [] });

/** Toạ độ phẳng (m) của p quanh gốc o: x hướng Đông, y hướng Bắc. */
function toLocal(p, o) {
  return [(p[0] - o[0]) * RAD * EARTH * Math.cos(o[1] * RAD), (p[1] - o[1]) * RAD * EARTH];
}

/** Điểm cách đỉnh i của đường một quãng dist (m) theo chiều dir (+1/−1); hết đường thì dừng ở đỉnh cuối. */
function pointAlongWay(way, i, dir, dist) {
  const n = vertexCount(way);
  let prev = vertexAt(way, i);
  let acc = 0;
  for (let k = i + dir; k >= 0 && k < n; k += dir) {
    const v = vertexAt(way, k);
    const d = distance(prev, v);
    if (acc + d >= dist) {
      const t = d ? (dist - acc) / d : 0;
      return [prev[0] + t * (v[0] - prev[0]), prev[1] + t * (v[1] - prev[1])];
    }
    acc += d;
    prev = v;
  }
  return prev;
}

/**
 * Chiếu một điểm lên hành lang → { s: quãng đường từ xe (m, âm = đã ở sau lưng), d: lệch ngang (m),
 * index: đoạn của hành lang, right: nằm bên phải chiều đi }.
 */
function locate(corr, coord) {
  const { coords, cum } = corr;
  const hit = nearestOnLine(coord, coords);
  if (!hit) return null;
  const a = coords[hit.index];
  const [bx, by] = toLocal(coords[hit.index + 1], a);
  const [px, py] = toLocal(coord, a);
  const len = Math.hypot(bx, by) || 1;
  const cross = (bx * py - by * px) / len; // < 0: bên phải chiều đi
  let s = cum[hit.index] + hit.t * (cum[hit.index + 1] - cum[hit.index]);
  let d = hit.dist;
  if (hit.index === 0 && hit.t === 0) {
    // Điểm nằm trước đầu hành lang, tức là sau lưng xe.
    const along = (px * bx + py * by) / len;
    if (along < 0) {
      s = along;
      d = Math.abs(cross);
    }
  }
  return { s, d, index: hit.index, right: cross < 0 };
}

const corridorBearing = (corr, index) => bearing(corr.coords[index], corr.coords[index + 1]);
const pointOn = (corr, s) => pointAtDistance(corr.coords, corr.cum, s).point;

/** Đoạn hành lang chứa vị trí s; ở ranh giới hai đoạn thì lấy đoạn đang đi tới (đoạn trước). */
function pieceAt(pieces, s, wayIds = null) {
  let first = null;
  for (const p of pieces) {
    if (s < p.s0 - 1 || s > p.s1 + 1) continue;
    if (!wayIds) return p;
    if (!first) first = p;
    if (p.way && wayIds.has(p.way.id)) return p;
  }
  return first;
}

// ---------------------------------------------------------------------------------------------
// C1. Hành lang phía trước
// ---------------------------------------------------------------------------------------------

/** Thêm một điểm vào hành lang, cắt đúng ở LENGTH. Trả về false khi hành lang đã đủ dài. */
function extend(corr, p) {
  const last = corr.coords[corr.coords.length - 1];
  const d = distance(last, p);
  if (d < 0.01) return true;
  const total = lengthOf(corr);
  if (total + d >= LENGTH) {
    const t = (LENGTH - total) / d;
    corr.coords.push([last[0] + t * (p[0] - last[0]), last[1] + t * (p[1] - last[1])]);
    corr.cum.push(LENGTH);
    return false;
  }
  corr.coords.push(p);
  corr.cum.push(total + d);
  return true;
}

/**
 * Ở cuối một đường: chọn nhánh đi thẳng tiếp. Chỉ chọn khi nhánh đó lệch ≤ 35° và thẳng hơn hẳn
 * nhánh kế tiếp (≥ 10°); hai nhánh gần như nhau thì chỉ chọn khi đúng một nhánh cùng tên đường.
 */
function continuation(roads, way, endIdx, dir, visited) {
  const end = vertexAt(way, endIdx);
  const incoming = bearing(pointAlongWay(way, endIdx, -dir, 20), end);
  const cands = [];
  for (const { way: w, i } of roads.waysAtVertex(end)) {
    if (w.id === way.id || visited.has(w.id)) continue;
    const n = vertexCount(w);
    const dirs = i === 0 ? [1] : i === n - 1 ? [-1] : [1, -1];
    for (const d of dirs) {
      const out = bearing(end, pointAlongWay(w, i, d, 20));
      cands.push({ way: w, i, dir: d, diff: Math.abs(angleDiff(incoming, out)) });
    }
  }
  cands.sort((a, b) => a.diff - b.diff);
  // Chỗ tách thành hai làn đường một chiều: nếu có nhánh đi đúng chiều gần thẳng như nhánh ngược chiều
  // thì người lái sẽ vào nhánh đúng chiều, không báo "cấm đi ngược chiều".
  const against = (c) => c.way.o !== 0 && c.dir !== c.way.o;
  const legal = cands.filter((c) => !against(c));
  const pool =
    cands.length && against(cands[0]) && legal.length && legal[0].diff <= CONT_ANGLE && legal[0].diff - cands[0].diff <= DUAL_SPLIT
      ? legal
      : cands;
  const [best, second] = pool;
  if (!best || best.diff > CONT_ANGLE) return null;
  if (!second || second.diff - best.diff >= CONT_MARGIN) return best;
  const named = way.n ? pool.filter((c) => c.diff <= CONT_ANGLE && c.way.n === way.n) : [];
  return named.length === 1 ? named[0] : null;
}

/** Không dẫn đường: đi theo đường đang khớp tới hết đường, rồi đoán nhánh đi thẳng qua các nút giao. */
function freeCorridor(fix, roads, hint) {
  const m = roads.matchWay(fix);
  if (!m) return emptyCorridor();
  let dir = m.dir;
  // Đi chậm hoặc dừng (đèn đỏ): giữ chiều đi đã biết trên cùng đường đó.
  if (!dir && hint && hint.wayId === m.way.id) dir = hint.dir;
  if (!dir) return emptyCorridor();

  const corr = { coords: [m.point], cum: [0], pieces: [], start: { wayId: m.way.id, dir } };
  const visited = new Set();
  let way = m.way;
  let from = dir > 0 ? m.seg + 1 : m.seg;
  let assumed = false;
  for (;;) {
    visited.add(way.id);
    const against = way.o !== 0 && dir !== way.o;
    const n = vertexCount(way);
    const s0 = lengthOf(corr);
    let open = true;
    for (let i = from; open && i >= 0 && i < n; i += dir) open = extend(corr, vertexAt(way, i));
    const s1 = lengthOf(corr);
    if (s1 > s0) corr.pieces.push({ way, dir, s0, s1, assumed, against });
    // Nhánh đi ngược đường một chiều: giữ lại để báo "cấm đi ngược chiều" nhưng không đoán tiếp.
    if (!open || against || corr.pieces.length >= MAX_PIECES) break;
    const endIdx = dir > 0 ? n - 1 : 0;
    const next = continuation(roads, way, endIdx, dir, visited);
    if (!next) {
      // Dừng ở nút giao chưa rõ hướng: giữ lại các đường gặp nhau ở đó (để báo vòng xuyến phía trước).
      corr.end = { coord: vertexAt(way, endIdx), ways: roads.waysAtVertex(vertexAt(way, endIdx)).map((e) => e.way) };
      break;
    }
    way = next.way;
    dir = next.dir;
    from = next.i + next.dir;
    assumed = true;
  }
  return corr.coords.length > 1 ? corr : emptyCorridor();
}

/** Vị trí s (m) của ranh giới giữa đường a và đường b: đỉnh chung của hai đường nằm giữa hai mẫu. */
function boundary(corr, a, b, sa, sb) {
  const mid = (sa + sb) / 2;
  if (!a || !b) return mid;
  const keys = new Set();
  for (let i = 0; i < vertexCount(b); i++) keys.add(vertexKey(vertexAt(b, i)));
  let best = null;
  for (let i = 0; i < vertexCount(a); i++) {
    const v = vertexAt(a, i);
    if (!keys.has(vertexKey(v))) continue;
    const loc = locate(corr, v);
    if (!loc || loc.d > 5 || loc.s < sa - 10 || loc.s > sb + 10) continue;
    if (best == null || Math.abs(loc.s - mid) < Math.abs(best - mid)) best = loc.s;
  }
  return best == null ? mid : clamp(best, sa, sb);
}

/** Đang dẫn đường: hành lang là đoạn tuyến phía trước; khớp từng mẫu 20 m với đoạn đường OSM. */
function navCorridor(nav, roads) {
  const { route, s } = nav;
  const rc = route.coords;
  const rcum = route.cum;
  const total = rcum[rcum.length - 1] || 0;
  if (!rc || rc.length < 2 || !(total - s > 1)) return emptyCorridor();
  const end = Math.min(total, s + LENGTH);
  const at = pointAtDistance(rc, rcum, s);
  const corr = { coords: [at.point], cum: [0], pieces: [] };
  const push = (p, rel) => {
    if (rel - lengthOf(corr) > 0.01) {
      corr.coords.push(p);
      corr.cum.push(rel);
    }
  };
  for (let i = at.index + 1; i < rc.length && rcum[i] < end; i++) push(rc[i], rcum[i] - s);
  push(pointAtDistance(rc, rcum, end).point, end - s);
  if (corr.coords.length < 2) return emptyCorridor();

  // Mẫu đặt theo bội số 20 m tính từ đầu tuyến để ranh giới ổn định giữa các lần định vị.
  const samples = [];
  const sample = (a) => {
    const p = pointAtDistance(rc, rcum, a);
    const m = roads.matchWay({ coord: p.point, heading: p.bearing, speed: 10, accuracy: 10 });
    samples.push({ s: a - s, way: m ? m.way : null, dir: m ? m.dir : 0 });
  };
  sample(s);
  for (let a = (Math.floor(s / NAV_SAMPLE) + 1) * NAV_SAMPLE; a < end - 1; a += NAV_SAMPLE) sample(a);
  sample(end);
  // Một mẫu lẻ không khớp nằm giữa hai mẫu cùng đường: coi là cùng đường.
  for (let k = 1; k + 1 < samples.length; k++) {
    const [a, b, c] = [samples[k - 1], samples[k], samples[k + 1]];
    if (!b.way && a.way && c.way && a.way.id === c.way.id) Object.assign(b, { way: a.way, dir: a.dir });
  }

  const pieces = [];
  for (let k = 0; k < samples.length; k++) {
    const sm = samples[k];
    const cur = pieces[pieces.length - 1];
    if (cur && (cur.way ? cur.way.id : null) === (sm.way ? sm.way.id : null)) {
      cur.s1 = sm.s;
      continue;
    }
    let s0 = 0;
    if (cur) {
      s0 = boundary(corr, cur.way, sm.way, samples[k - 1].s, sm.s);
      cur.s1 = s0;
    }
    const against = Boolean(sm.way && sm.way.o !== 0 && sm.dir !== sm.way.o);
    pieces.push({ way: sm.way, dir: sm.dir, s0, s1: sm.s, assumed: false, against });
  }
  if (pieces.length) pieces[pieces.length - 1].s1 = lengthOf(corr);
  corr.pieces = pieces.filter((p) => p.s1 > p.s0);
  return corr;
}

/**
 * Hành lang ~320 m phía trước xe → { coords, cum, pieces }; cum tính từ xe (0 tại xe).
 * pieces: [{ way|null, dir (+1 xuôi chiều vẽ đường, −1 ngược), s0, s1, assumed, against }].
 * @param nav   { route, seg, s } khi đang dẫn đường và đang ở trên tuyến, ngược lại null
 * @param hint  { wayId, dir } chiều đi đã biết (để giữ hành lang khi xe đi chậm hoặc dừng)
 */
export function buildCorridor(fix, roads, nav = null, hint = null) {
  if (nav && nav.route && Number.isFinite(nav.s)) return navCorridor(nav, roads);
  return freeCorridor(fix, roads, hint);
}

// ---------------------------------------------------------------------------------------------
// Bộ nhớ tạm theo đối tượng dữ liệu (dữ liệu tải lại thì đối tượng mới, tự tính lại)
// ---------------------------------------------------------------------------------------------

class Memo {
  constructor() {
    this.feats = new WeakMap();
    this.ways = new WeakMap();
    this.lines = new WeakMap();
    this.refresh();
  }

  /** Bỏ các kết quả phụ thuộc dữ liệu xung quanh (nút giao, đường gần nhất). */
  refresh() {
    this.roadOf = new WeakMap();
    this.guards = new Map();
  }

  features(feat) {
    let v = this.feats.get(feat);
    if (!v) this.feats.set(feat, (v = classifyNode(feat.tags)));
    return v;
  }

  wayInfo(way) {
    let v = this.ways.get(way);
    if (!v) this.ways.set(way, (v = classifyWay(way.t)));
    return v;
  }

  coordsOf(way) {
    let v = this.lines.get(way);
    if (!v) {
      v = [];
      for (let i = 0; i < vertexCount(way); i++) v.push(vertexAt(way, i));
      this.lines.set(way, v);
    }
    return v;
  }

  /** Đoạn đường gần biển đứng riêng nhất (không xét hướng) → { id, dist } hoặc null. */
  nearestRoad(roads, feat) {
    if (this.roadOf.has(feat)) return this.roadOf.get(feat);
    const m = roads.matchWay({ coord: feat.coord, heading: null, speed: 0, accuracy: 30 });
    const v = m ? { id: m.way.id, dist: m.dist } : null;
    this.roadOf.set(feat, v);
    return v;
  }

  guard(key, compute) {
    if (this.guards.has(key)) return this.guards.get(key);
    if (this.guards.size > 2000) this.guards.clear();
    const v = compute();
    this.guards.set(key, v);
    return v;
  }
}

// ---------------------------------------------------------------------------------------------
// C2. Các mục trên hành lang
// ---------------------------------------------------------------------------------------------

function makeItem(key, f, s, coord, extra = {}) {
  return {
    key,
    kind: f.kind,
    code: f.code ?? null,
    title: f.title,
    say: f.say,
    cat: f.cat,
    art: f.art,
    value: f.value ?? null,
    derived: Boolean(f.derived),
    note: f.note ?? null,
    distance: s,
    coord,
    dup: `${f.code ?? f.kind}|${f.value ?? ''}`,
    ...extra,
  };
}

/** Phần dữ liệu trả ra ngoài cho giao diện. */
const publicItem = ({ key, kind, code, title, say, cat, distance: d, art, value, derived: isDerived, note, coord }) => ({
  key, kind, code, title, say, cat, distance: d, art, value, derived: isDerived, note, coord,
});

/** Nút đứng riêng bên lề (không nằm trên đường) chỉ được nhận khi là biển, điểm nguy hiểm, dừng hoặc nhường đường. */
function isStandaloneSign(tags) {
  return (
    tags.traffic_sign != null ||
    tags['traffic_sign:forward'] != null ||
    tags['traffic_sign:backward'] != null ||
    tags.hazard != null ||
    tags.highway === 'stop' ||
    tags.highway === 'give_way'
  );
}

/** Số nhánh đường toả ra từ một đỉnh; từ 3 nhánh trở lên là nút giao. */
function armsAt(roads, coord) {
  let arms = 0;
  for (const { way, i } of roads.waysAtVertex(coord)) arms += i === 0 || i === vertexCount(way) - 1 ? 1 : 2;
  return arms;
}

/** Điểm trên đường tại chỉ số đỉnh f (có thể lẻ: 2,5 = giữa đỉnh 2 và đỉnh 3). */
function pointAtIndex(way, f) {
  const n = vertexCount(way);
  const i0 = Math.min(Math.floor(f), n - 1);
  const t = f - i0;
  if (t <= 0 || i0 + 1 >= n) return vertexAt(way, i0);
  const a = vertexAt(way, i0);
  const b = vertexAt(way, i0 + 1);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * Đi dọc đường từ vị trí f theo chiều dir: quãng đường (m) tới đỉnh đầu tiên thoả stop(v) (Infinity nếu
 * không gặp trong `limit` m), hoặc tới đầu mút của đường khi không có stop.
 */
function walkDistance(way, f, dir, stop = null, limit = Infinity) {
  const n = vertexCount(way);
  let prev = pointAtIndex(way, f);
  let acc = 0;
  for (let k = dir > 0 ? Math.ceil(f) : Math.floor(f); k >= 0 && k < n; k += dir) {
    const v = vertexAt(way, k);
    acc += distance(prev, v);
    prev = v;
    if (acc > limit) return Infinity;
    if (stop && stop(v)) return acc;
  }
  return stop ? Infinity : acc;
}

/**
 * Biển dừng/nhường đường không ghi hướng: chỉ áp dụng khi nó canh nút giao phía trước (gần nút giao
 * phía trước hơn nút giao phía sau). Biển nằm ngay tại nút giao thì thuộc về đường nhỏ hơn.
 */
function guardsJunctionAhead(feat, piece, roads, ctx) {
  const way = piece.way;
  return ctx.memo.guard(`${feat.id}|${way.id}|${piece.dir}`, () => {
    let f = null;
    if (feat.onWay) {
      const hit = roads.waysAtVertex(feat.coord).find((e) => e.way.id === way.id);
      if (hit) f = hit.i;
    }
    if (f == null) {
      const hit = nearestOnLine(feat.coord, ctx.memo.coordsOf(way));
      if (!hit) return false;
      f = hit.index + hit.t;
    }
    const isJunction = (v) => armsAt(roads, v) >= 3;
    const ahead = walkDistance(way, f, piece.dir, isJunction, JUNCTION_SCAN);
    const behind = walkDistance(way, f, -piece.dir, isJunction, JUNCTION_SCAN);
    if (ahead === 0 && behind === 0) {
      // Biển ghi ngay tại nút giao: thuộc về đường nhỏ hơn (hoặc mọi hướng khi stop=all).
      if (String(feat.tags.stop ?? '').trim() === 'all') return true;
      const ours = RANK[way.h] ?? 9;
      let best = Infinity;
      for (const e of roads.waysAtVertex(feat.coord)) {
        const sameRoad = e.way.id === way.id || (e.way.n === way.n && e.way.h === way.h);
        if (!sameRoad) best = Math.min(best, RANK[e.way.h] ?? 9);
      }
      return best === Infinity || ours >= best;
    }
    if (ahead === Infinity && behind === Infinity) {
      // Không thấy nút giao nào gần: biển canh đầu đường phía trước nếu nó gần đầu đó hơn.
      return walkDistance(way, f, piece.dir) <= walkDistance(way, f, -piece.dir);
    }
    return ahead <= behind;
  });
}

/** Biển đứng riêng không ghi hướng: nằm bên phải chiều đi, sát tim đường, hoặc đường một chiều. */
const sideOk = (loc, piece) => loc.right || loc.d < 3 || Boolean(piece && piece.way && piece.way.o !== 0);

/** Một biển của nút có áp dụng cho chiều đi trên hành lang không. */
function applies(f, feat, loc, featWays, corr, roads, ctx) {
  const dir = f.dirFixed ? { mode: f.dirFixed } : parseDirection(feat.tags, f.dirKeys);
  const piece = pieceAt(corr.pieces, loc.s, featWays);
  switch (dir.mode) {
    case 'forward':
    case 'backward':
      if (!piece || !piece.way) return false;
      return (dir.mode === 'forward') === (piece.dir > 0);
    case 'both':
      return true;
    case 'deg':
      return Math.abs(angleDiff(corridorBearing(corr, loc.index), (dir.deg + 180) % 360)) <= 60;
    default:
      break;
  }
  if (f.needsJunction) {
    if (!piece || !piece.way || !guardsJunctionAhead(feat, piece, roads, ctx)) return false;
    return feat.onWay || sideOk(loc, piece);
  }
  return feat.onWay || sideOk(loc, piece);
}

/** Đường đi qua đỉnh e có cùng phương với hành lang không (dùng khi đoạn tuyến chưa khớp được đường). */
function alignedWith(e, brg) {
  const n = vertexCount(e.way);
  const a = vertexAt(e.way, e.i < n - 1 ? e.i : e.i - 1);
  const b = vertexAt(e.way, e.i < n - 1 ? e.i + 1 : e.i);
  const diff = Math.abs(angleDiff(brg, bearing(a, b)));
  return diff <= 30 || diff >= 150;
}

function featItems(corr, roads, ctx, out) {
  const total = lengthOf(corr);
  const feats = new Map();
  for (let s = 0; ; s += FEAT_STEP) {
    const at = Math.min(s, total);
    for (const f of roads.featsNear(pointOn(corr, at), FEAT_RADIUS)) feats.set(f.id, f);
    if (at >= total) break;
  }
  for (const feat of feats.values()) {
    const features = ctx.memo.features(feat).filter((f) => categoryEnabled(f.cat, ctx.settings));
    if (!features.length) continue;
    const loc = locate(corr, feat.coord);
    if (!loc || loc.s < 0 || loc.s > total + 1) continue;
    let featWays = null;
    if (feat.onWay) {
      if (loc.d > ON_WAY_LATERAL) continue;
      // Nút phải thuộc chính đường trên hành lang: loại nút của đường chui dưới cầu, đường song song.
      const at = roads.waysAtVertex(feat.coord);
      featWays = new Set(at.map((e) => e.way.id));
      if (!at.some((e) => ctx.wayIds.has(e.way.id))) {
        const piece = pieceAt(corr.pieces, loc.s);
        if (!piece || piece.way) continue;
        const brg = corridorBearing(corr, loc.index);
        if (!at.some((e) => alignedWith(e, brg))) continue;
      }
    } else {
      if (!isStandaloneSign(feat.tags) || loc.d > OFF_WAY_LATERAL) continue;
      // Biển đứng gần một đường khác hơn hẳn thì là biển của đường đó.
      const near = ctx.memo.nearestRoad(roads, feat);
      if (near && !ctx.wayIds.has(near.id) && near.dist + 2 < loc.d) continue;
    }
    for (const f of features) {
      if (!applies(f, feat, loc, featWays, corr, roads, ctx)) continue;
      out.push(makeItem(`${feat.id}:${f.kind}`, f, loc.s, feat.coord));
    }
  }
}

/** Thay đổi khi sang đoạn đường kế tiếp: tốc độ, vòng xuyến, hầm, một chiều, cấm xe, kích thước, cấm vượt. */
function transitionItems(corr, ctx, out) {
  const moto = ctx.vehicle === 'moto';
  const blocked = (i) => i.noAll || (moto ? i.noMoto : i.noCar);
  const noPass = (i, dir) => (dir > 0 ? i.noOvertake.forward : i.noOvertake.backward);
  const dims = (i, dir) => (dir > 0 ? i.dims.forward : i.dims.backward);
  let lastLimit = null;
  let prev = null;
  let prevInfo = null;
  for (const p of corr.pieces) {
    if (!p.way) continue;
    const info = ctx.memo.wayInfo(p.way);
    const limit = moto ? p.way.m : p.way.c;
    if (prev && p.s0 > 0) {
      const coord = pointOn(corr, p.s0);
      const add = (kind, data) => {
        const f = derived(kind, data);
        if (f && categoryEnabled(f.cat, ctx.settings)) {
          out.push(makeItem(`w${p.way.id}:${f.kind}:${p.dir}`, f, p.s0, coord));
        }
      };
      if (p.against) add('oneway');
      else {
        if (limit != null && limit !== lastLimit) add('speedChange', { n: limit });
        if (info.roundabout && !prevInfo.roundabout) add('roundabout');
        if (info.tunnel && !prevInfo.tunnel) add('tunnel');
        if (blocked(info) && !blocked(prevInfo)) add('noAccess', { vehicle: moto ? 'moto' : 'car', all: info.noAll });
        if (!moto) {
          const d = dims(info, p.dir);
          const pd = dims(prevInfo, prev.dir);
          if (d.h != null && d.h !== pd.h) add('height', { v: d.h });
          if (d.w != null && d.w !== pd.w) add('weight', { v: d.w });
          if (d.wd != null && d.wd !== pd.wd) add('width', { v: d.wd });
        }
        if (noPass(info, p.dir) && !noPass(prevInfo, prev.dir)) add('noOvertake');
        if (info.hazard && info.hazard !== prevInfo.hazard) add('hazard', { value: info.hazard });
      }
    }
    if (limit != null) lastLimit = limit;
    prev = p;
    prevInfo = info;
  }
  // Hành lang dừng ngay trước vòng xuyến (các nhánh vòng xuyến lệch nhiều so với hướng đi nên không đoán tiếp).
  if (corr.end && prev && !prevInfo.roundabout) {
    const ring = corr.end.ways.find((w) => w.id !== prev.way.id && ctx.memo.wayInfo(w).roundabout);
    const f = ring && derived('roundabout');
    if (f && categoryEnabled(f.cat, ctx.settings)) {
      out.push(makeItem(`w${ring.id}:${f.kind}:0`, f, lengthOf(corr), corr.end.coord));
    }
  }
}

// ---- Cấm rẽ ----

const RESTRICTION = {
  no_left_turn: ['ban', 'left'],
  no_right_turn: ['ban', 'right'],
  no_straight_on: ['ban', 'straight'],
  no_u_turn: ['ban', 'uturn'],
  only_left_turn: ['only', 'left'],
  only_right_turn: ['only', 'right'],
  only_straight_on: ['only', 'straight'],
};
const EXCEPT = { car: ['motorcar', 'motor_vehicle'], moto: ['motorcycle', 'moped', 'mofa', 'motor_vehicle'] };
const SPECIFIC = { car: 'restriction:motorcar', moto: 'restriction:motorcycle' };
const TIMEISH = /\d{1,2}:\d{2}|\b(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH|sunrise|sunset)\b/i;

const listOf = (v) =>
  String(v ?? '')
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().toLowerCase());

/** Tách theo dấu phân cách nằm ngoài ngoặc đơn. */
function splitOutside(text, sep) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** "no_left_turn @ (Mo-Fr 06:00-09:00); none @ (…)" → [{ value, cond }] hoặc null nếu không đọc được. */
function conditionalClauses(text) {
  const out = [];
  for (const part of splitOutside(String(text), ';')) {
    const m = /^([^@]+?)\s*@\s*(.+)$/.exec(part);
    if (!m) return null;
    out.push({ value: m[1].trim().toLowerCase(), cond: m[2].trim() });
  }
  return out.length ? out : null;
}

/** Lệnh cấm rẽ có hiệu lực với loại xe này lúc `now` → { type: 'ban'|'only', turn, timed } hoặc null. */
function effectiveRestriction(tags, vehicle, now) {
  const v = vehicle === 'moto' ? 'moto' : 'car';
  const except = listOf(tags.except);
  if (EXCEPT[v].some((x) => except.includes(x))) return null;
  const base = clean(tags[SPECIFIC[v]]) ?? clean(tags.restriction);
  let value = base;
  let timed = false;
  const cond = tags[`${SPECIFIC[v]}:conditional`] ?? tags['restriction:conditional'];
  if (cond != null) {
    let hit = null;
    let unknown = null;
    for (const c of conditionalClauses(cond) || []) {
      if (!TIMEISH.test(c.cond)) continue; // điều kiện không phải giờ (tải trọng…): không áp dụng
      const on = timeRangesActive(c.cond, now);
      if (on === true) {
        hit = c;
        break;
      }
      if (on === null && !unknown) unknown = c;
    }
    if (hit) value = hit.value;
    else if (unknown && !RESTRICTION[base]) {
      // Chỉ cấm trong khung giờ chưa đọc được: vẫn báo, kèm chữ "theo giờ".
      value = unknown.value;
      timed = true;
    } else if (unknown) {
      timed = unknown.value !== base; // lệnh cấm có thể được bỏ trong một số giờ
    }
  }
  const r = RESTRICTION[value];
  return r ? { type: r[0], turn: r[1], timed } : null;
}

function restrictionItems(corr, roads, ctx, out) {
  const groups = new Map();
  const done = new Set();
  for (const p of corr.pieces) {
    if (!p.way || done.has(p.way.id)) continue;
    done.add(p.way.id);
    for (const r of roads.restrictionsFrom(p.way.id)) {
      const loc = locate(corr, r.via);
      if (!loc || loc.s < 0 || loc.d > VIA_LATERAL) continue;
      // Nút "via" phải ở cuối đoạn đường "from" theo chiều đang đi.
      const toEnd = Math.abs(loc.s - p.s1);
      if (toEnd > VIA_TO_END || toEnd > Math.abs(loc.s - p.s0)) continue;
      const eff = effectiveRestriction(r.tags || {}, ctx.vehicle, ctx.now);
      if (!eff) continue;
      const key = vertexKey(r.via);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { s: loc.s, coord: r.via, bans: new Set(), only: null, timed: false }));
      if (eff.type === 'ban') g.bans.add(eff.turn);
      else if (!g.only) g.only = eff.turn;
      if (eff.timed) g.timed = true;
    }
  }
  for (const [key, g] of groups) {
    const f = derived('turn', { bans: g.bans, only: g.only, timed: g.timed });
    if (f && categoryEnabled(f.cat, ctx.settings)) out.push(makeItem(`r${key}`, f, g.s, g.coord));
  }
}

// ---- Giờ áp dụng ----

const DAY_NAMES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAYS_RE = new RegExp(`^(${DAY}(?:\\s*-\\s*${DAY})?(?:\\s*,\\s*${DAY}(?:\\s*-\\s*${DAY})?)*)(?:\\s+|$)`, 'i');
const RANGE_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => DAY_NAMES.indexOf(x.trim().toLowerCase()));
    if (b == null) days.add(a);
    else for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return days;
}

/**
 * Khung giờ kiểu OSM ("06:00-09:00", "Mo-Fr 06:00-09:00,16:00-19:00", "Mo-Fr 07:00-09:00; Sa 08:00-10:00",
 * "22:00-05:00") có đang hiệu lực lúc `date` (giờ của máy) không → true/false, null nếu không đọc được.
 */
export function timeRangesActive(text, date) {
  if (text == null || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  let s = String(text).trim();
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
  if (!s) return null;
  const minute = date.getHours() * 60 + date.getMinutes();
  const today = date.getDay();
  const yesterday = (today + 6) % 7;
  const rules = s.split(/\s*;\s*|(?<=\d)\s*,\s*(?=[A-Za-z])/).filter(Boolean);
  if (!rules.length) return null;
  let active = false;
  for (const rule of rules) {
    let rest = rule.trim();
    let days = null;
    const dm = DAYS_RE.exec(rest);
    if (dm) {
      days = parseDays(dm[1]);
      rest = rest.slice(dm[0].length).trim();
    }
    const on = (d) => !days || days.has(d);
    if (!rest) {
      if (!days) return null;
      if (on(today)) active = true; // chỉ ghi ngày: cả ngày
      continue;
    }
    for (const range of rest.split(/\s*,\s*/)) {
      const m = RANGE_RE.exec(range);
      if (!m || +m[2] > 59 || +m[4] > 59) return null;
      const from = +m[1] * 60 + +m[2];
      const to = +m[3] * 60 + +m[4];
      if (from > 1440 || to > 1440 || from === to) return null;
      if (from < to) {
        if (on(today) && minute >= from && minute < to) active = true;
      } else if ((on(today) && minute >= from) || (on(yesterday) && minute < to)) {
        active = true; // khung giờ qua nửa đêm
      }
    }
  }
  return active;
}

// ---- Chỗ ngoặt tính từ hình dạng đường ----

/** Các đoạn cong (chưa xét tốc độ): [{ side, s, s1, radius, turn, coord }]. */
function findCurves(coords, cum, { phase = 0, skip = null } = {}) {
  const total = cum.length ? cum[cum.length - 1] : 0;
  const pts = [];
  const ss = [];
  for (let s = phase; s <= total + 1e-6; s += CURVE_STEP) {
    pts.push(pointAtDistance(coords, cum, s).point);
    ss.push(s);
  }
  const n = pts.length;
  if (n < 3) return [];
  const brg = [];
  for (let k = 0; k + 1 < n; k++) brg.push(bearing(pts[k], pts[k + 1]));
  const turn = new Array(n).fill(0);
  for (let k = 1; k + 1 < n; k++) turn[k] = angleDiff(brg[k - 1], brg[k]);

  // Với mỗi điểm đầu: cửa sổ ngắn nhất (≤ 90 m) có tổng góc đổi hướng ≥ 55°.
  const wins = [];
  for (let a = 0; a + 2 < n; a++) {
    let sum = 0;
    for (let e = a + 2; e < n && e - a <= CURVE_SPAN; e++) {
      sum += turn[e - 1];
      if (Math.abs(sum) >= CURVE_TURN) {
        wins.push({ a, e, sum });
        break;
      }
    }
  }
  // Gộp các cửa sổ chồng nhau cùng phía; bán kính lấy theo cửa sổ ngắn nhất (sát với độ cong thật nhất).
  const clusters = [];
  let cl = null;
  for (const w of wins) {
    const sign = Math.sign(w.sum);
    if (cl && sign === cl.sign && w.a <= cl.end) {
      cl.end = Math.max(cl.end, w.e);
      if (w.e - w.a < cl.best.e - cl.best.a) cl.best = w;
    } else {
      if (cl) clusters.push(cl);
      cl = { sign, end: w.e, best: w };
    }
  }
  if (cl) clusters.push(cl);
  const out = [];
  for (const c of clusters) {
    const w = c.best;
    // Góc đổi giữa đoạn mẫu đầu và đoạn mẫu cuối ứng với cung nối hai trung điểm của chúng: (e − a − 1)·10 m.
    const radius = ((w.e - w.a - 1) * CURVE_STEP) / (Math.abs(w.sum) * RAD);
    const curve = { side: c.sign > 0 ? 'right' : 'left', s: ss[w.a], s1: ss[c.end], radius, turn: w.sum, coord: pts[w.a] };
    if (radius > CURVE_RADIUS || (skip && skip(curve.s, curve.s1))) continue;
    out.push(curve);
  }
  return out;
}

const curveOk = (c, speed) =>
  speed >= CURVE_MIN_SPEED && c.radius <= CURVE_RADIUS && (speed * speed) / c.radius >= CURVE_MIN_ACCEL;

/** Nối các đoạn cong: cùng phía sát nhau → một chỗ ngoặt; ngược phía trong 150 m → "nhiều chỗ ngoặt". */
function mergeCurves(curves) {
  const out = [];
  for (const c of curves) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'curve' && prev.side === c.side && c.s - prev.s1 <= CURVE_JOIN) {
      prev.s1 = c.s1;
      prev.radius = Math.min(prev.radius, c.radius);
      prev.anchors.push(c.coord);
      prev.lastS = c.s;
      continue;
    }
    if (prev && c.s - prev.lastS <= CURVES_GAP && (prev.kind === 'curves' || prev.side !== c.side)) {
      prev.kind = 'curves';
      prev.s1 = c.s1;
      prev.anchors.push(c.coord);
      prev.lastS = c.s;
      continue;
    }
    out.push({ ...c, kind: 'curve', anchors: [c.coord], lastS: c.s });
  }
  return out;
}

/**
 * Chỗ ngoặt nguy hiểm trên đường gấp khúc (cum tính bằng m) ở tốc độ speed (m/s):
 * [{ kind: 'curve'|'curves', side, s, s1, radius, coord, anchors }].
 * Chỉ báo khi chạy ≥ 30 km/h, bán kính ≤ 120 m và gia tốc ngang v²/R ≥ 1,5 m/s².
 * opts.phase: vị trí mẫu đầu tiên (m); opts.skip(s0, s1) → true để bỏ một đoạn cong.
 */
export function detectCurves(coords, cum, speed, opts = {}) {
  return mergeCurves(findCurves(coords, cum, opts).filter((c) => curveOk(c, speed)));
}

function curveItems(corr, ctx, out) {
  if (!categoryEnabled('danger', ctx.settings)) return;
  const round = corr.pieces.filter((p) => p.way && ctx.memo.wayInfo(p.way).roundabout);
  const turns = [];
  if (ctx.nav) {
    const { route, s } = ctx.nav;
    for (const st of route.steps || []) {
      const at = route.cum[st.index];
      if (Number.isFinite(at) && at - s > -MANEUVER_GAP && at - s < LENGTH + MANEUVER_GAP) turns.push(at - s);
    }
  }
  const skip = (s0, s1) =>
    round.some((p) => p.s0 < s1 && p.s1 > s0) || turns.some((t) => t >= s0 - MANEUVER_GAP && t <= s1 + MANEUVER_GAP);
  const phase = ctx.nav ? (CURVE_STEP - (ctx.nav.s % CURVE_STEP)) % CURVE_STEP : 0;
  // Chỗ ngoặt đã báo thì giữ lại tới khi đi qua, kể cả khi xe đã giảm tốc.
  const raw = findCurves(corr.coords, corr.cum, { phase, skip }).filter(
    (c) => curveOk(c, ctx.speed) || ctx.curveKey([c.coord]) != null,
  );
  for (const c of mergeCurves(raw)) {
    const f = c.kind === 'curves' ? derived('curves') : derived('curve', { side: c.side });
    const coord = c.coord;
    const key =
      ctx.curveKey(c.anchors) ?? `c${coord[0].toFixed(4)},${coord[1].toFixed(4)}:${c.kind === 'curves' ? 'curves' : c.side}`;
    out.push(makeItem(key, f, c.s, coord, { anchors: c.anchors }));
  }
}

// ---------------------------------------------------------------------------------------------
// C3. Bộ máy: chọn mục hiện trên thanh cảnh báo và thời điểm đọc
// ---------------------------------------------------------------------------------------------

const EMPTY = Object.freeze({ active: null, upcoming: [], fired: [], say: null });

export class SignEngine {
  constructor() {
    this.seen = new Map(); // khoá → { coord, time, reach, spoken, dup, anchors? }
    this.lastSpeak = -Infinity;
    this.lastFix = null; // thời điểm lần định vị trước (ms)
    this.hint = null; // { wayId, dir }: chiều đi gần nhất, giữ hành lang khi xe dừng
    this.last = null; // kết quả gần nhất, giữ tạm khi mất khớp đường
    this.memo = new Memo();
    this.memoTime = -Infinity;
  }

  /** Bắt đầu chuyến mới: quên mọi mục đã báo. */
  reset() {
    this.seen.clear();
    this.lastSpeak = -Infinity;
    this.lastFix = null;
    this.hint = null;
    this.last = null;
  }

  /**
   * @param fix      { coord, speed (m/s), heading, accuracy, time (ms) }
   * @param roads    RoadData
   * @param settings cài đặt (bật/tắt từng nhóm biển)
   * @param opts     { vehicle: 'car'|'moto', nav: { route, seg, s } | null, now: Date }
   * @returns { active: { item, distance, reach } | null, upcoming: [item], fired: [item], say: string | null }
   */
  update(fix, roads, settings, { vehicle = 'car', nav = null, now = new Date() } = {}) {
    if (!fix || !Array.isArray(fix.coord) || !roads) return EMPTY;
    const time = Number.isFinite(fix.time) ? fix.time : now.getTime();
    const speed = Math.max(0, fix.speed || 0);
    const reachNow = clamp(speed * 8, 100, 200);
    const minD = Math.max(15, speed * 1.5);
    // Đọc sớm hơn một nhịp định vị: lần định vị sau xe đã đi thêm chừng này, câu đọc vẫn rơi vào 100–200 m.
    const gap = this.lastFix == null ? 1 : clamp((time - this.lastFix) / 1000, 0, 2);
    this.lastFix = time;
    const trigger = Math.min(200, reachNow + speed * gap);
    this.#forget(fix.coord);
    // Kết quả tra nút giao và đường gần nhất phụ thuộc cả ô bên cạnh (có thể tải sau): tính lại định kỳ.
    if (!(time - this.memoTime < MEMO_REFRESH) || time < this.memoTime) {
      this.memo.refresh();
      this.memoTime = time;
    }

    const corr = buildCorridor(fix, roads, nav, nav ? null : this.hint);
    if (corr.coords.length < 2) return this.#hold(time, speed);
    const first = corr.pieces.find((p) => p.way);
    if (corr.start) this.hint = corr.start;
    else if (first && first.s0 === 0) this.hint = { wayId: first.way.id, dir: first.dir };

    const ctx = {
      settings,
      vehicle,
      now,
      nav: corr.start ? null : nav,
      speed,
      memo: this.memo,
      wayIds: new Set(corr.pieces.filter((p) => p.way).map((p) => p.way.id)),
      curveKey: (anchors) => this.#curveKey(anchors),
    };
    const items = this.#collect(corr, roads, ctx);

    // Mục mới thấy mà đã quá gần thì chỉ hiện. Biển cùng loại sát một biển vừa đọc (đèn ở hai phía giao lộ,
    // vạch qua đường liền nhau) thì coi như đã báo.
    for (const it of items) {
      if (this.seen.has(it.key)) continue;
      if (it.distance < minD) {
        this.#mark(it, time, reachNow, false); // quá gần rồi: chỉ hiện, không đọc
        continue;
      }
      for (const e of this.seen.values()) {
        if (e.spoken && e.dup === it.dup && distance(e.coord, it.coord) <= SAME_KIND_GAP) {
          this.#mark(it, time, reachNow, false);
          break;
        }
      }
    }

    const fired = [];
    let say = null;
    const due = items.find((it) => !this.seen.has(it.key) && it.distance >= minD && it.distance <= trigger);
    if (due && speed >= MIN_SPEAK_SPEED && time - this.lastSpeak >= SPEAK_INTERVAL) {
      // Cùng một biển từ hai nguồn (nút biển tốc độ và chỗ đổi giới hạn của đường) chỉ đọc một lần.
      const says = [];
      const dups = new Set();
      for (const it of items) {
        if (this.seen.has(it.key) || it.distance < minD || it.distance > due.distance + MERGE_GAP) continue;
        if (!dups.has(it.dup)) {
          if (dups.size === MAX_PER_SENTENCE) continue;
          dups.add(it.dup);
          if (!says.includes(it.say)) says.push(it.say);
        }
        fired.push(it);
      }
      for (const it of fired) this.#mark(it, time, Math.max(reachNow, it.distance), true);
      say = `Phía trước ${spokenDistance(due.distance)}, ${says.join(', ')}`;
      this.lastSpeak = time;
    }

    let active = null;
    for (const it of items) {
      const e = this.seen.get(it.key);
      if (e || it.distance <= trigger) {
        active = { item: publicItem(it), distance: it.distance, reach: e ? e.reach : Math.max(reachNow, it.distance) };
        break;
      }
    }

    const upcoming = [];
    const dups = new Set();
    for (const it of items) {
      if (it.distance > UPCOMING_RANGE || dups.has(it.dup)) continue;
      dups.add(it.dup);
      upcoming.push(publicItem(it));
      if (upcoming.length === UPCOMING_MAX) break;
    }

    this.last = { time, active, upcoming };
    return { active, upcoming, fired: fired.map(publicItem), say };
  }

  /** Gom mọi mục phía trước, bỏ trùng khoá (giữ mục gần nhất), sắp theo khoảng cách. */
  #collect(corr, roads, ctx) {
    const raw = [];
    featItems(corr, roads, ctx, raw);
    transitionItems(corr, ctx, raw);
    restrictionItems(corr, roads, ctx, raw);
    curveItems(corr, ctx, raw);
    const byKey = new Map();
    for (const it of raw) {
      if (!(it.distance >= 0)) continue;
      const old = byKey.get(it.key);
      if (!old || it.distance < old.distance) byKey.set(it.key, it);
    }
    return [...byKey.values()].sort((a, b) => a.distance - b.distance);
  }

  #mark(it, time, reach, spoken) {
    this.seen.set(it.key, { coord: it.coord, time, reach, spoken, dup: it.dup, anchors: it.anchors || null });
  }

  /** Khoá của chỗ ngoặt đã báo nằm gần một trong các điểm neo này (vị trí tính lại mỗi lần lệch vài mét). */
  #curveKey(anchors) {
    for (const [key, e] of this.seen) {
      if (!e.anchors) continue;
      for (const a of e.anchors) {
        for (const b of anchors) if (distance(a, b) <= CURVE_ALIAS) return key;
      }
    }
    return null;
  }

  #forget(coord) {
    for (const [key, e] of this.seen) if (distance(coord, e.coord) > FORGET) this.seen.delete(key);
  }

  /** Không dựng được hành lang (mất khớp đường, đi chậm…): giữ kết quả cũ thêm vài giây. */
  #hold(time, speed) {
    const last = this.last;
    if (!last || time - last.time > HOLD_MS || time < last.time) {
      this.last = null;
      return EMPTY;
    }
    const moved = (speed * (time - last.time)) / 1000;
    const shift = (it) => ({ ...it, distance: it.distance - moved });
    let active = null;
    if (last.active && last.active.distance - moved >= 0) {
      active = { ...last.active, item: shift(last.active.item), distance: last.active.distance - moved };
    }
    const upcoming = last.upcoming.map(shift).filter((it) => it.distance >= 0);
    return { active, upcoming, fired: [], say: null };
  }
}
