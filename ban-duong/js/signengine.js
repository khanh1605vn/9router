// Bộ máy cảnh báo biển báo phía trước (báo trước khoảng 100–200 m). Thuần logic, không đụng tới DOM.
// 1. Dựng "hành lang" ~320 m phía trước: theo tuyến khi đang dẫn đường, hoặc đoán theo đường đang chạy.
// 2. Gom các mục nằm trên hành lang: nút biển báo và thông tin tương đương (đèn, vạch qua đường, gờ giảm
//    tốc…), thay đổi khi sang đoạn đường khác (tốc độ, vòng xuyến, hầm, một chiều, cấm xe…), cấm rẽ, và
//    chỗ ngoặt tính từ hình dạng đường.
// 3. Quyết định khi nào đọc, gộp các mục gần nhau vào một câu, chọn mục hiện trên thanh cảnh báo.

import { angleDiff, bearing, distance, nearestOnLine, pointAtDistance } from './geo.js';
import { onewayFor, vertexKey } from './roaddata.js';
import { categoryEnabled, classifyNode, classifyWay, derived, parseDirection, SIGN_CATEGORIES } from './signs.js';
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
// Đứng chờ trước mục đang hiện (đèn đỏ): vị trí trôi trong chừng này (m, hoặc trong sai số định vị nếu lớn hơn)
// quanh chỗ mục hiện lần cuối thì vẫn giữ mục đó, dù sai số đẩy vị trí qua khỏi mục.
const WAIT_RADIUS = 10;
const JUNCTION_SCAN = 150; // tìm nút giao gần biển dừng/nhường đường trong khoảng này (m)
const MEMO_REFRESH = 60e3; // tính lại kết quả tra cứu phụ thuộc ô bên cạnh mỗi phút (ms)
const JUNCTION_NEAR = 40; // mục cách nút giao không quá chừng này (m) được coi là thuộc nút giao đó
const REVERSED = 120; // hướng đi tại mục lệch hơn chừng này (độ) so với lúc báo: đi theo chiều ngược lại
const AGAINST_STUB = 1; // nhánh cấm đi ngược chiều: chỉ giữ chừng này (m) qua chỗ vào

// Nhớ hành lang vừa dựng (không dẫn đường):
const PREFER_KEEP = 10e3; // không dựng được hành lang lâu hơn chừng này (ms) thì thôi ưu tiên các đường cũ
const SWITCH_FIXES = 2; // số lần định vị liên tiếp cần để chuyển sang một đường không nối với các đường cũ
const SWITCH_NEAR = 50; // đường mới có đỉnh chung với một đường cũ trong khoảng này (m) quanh xe: chuyển ngay
const LINK_HOPS = 6; // một con đường bị cắt thành nhiều đoạn ngắn: đi qua tối đa chừng này đoạn để nhận ra vẫn là nó
const MOVING_SPEED = 2.5; // trên tốc độ này (m/s) hướng GPS đủ tin để biết chiều đi (như RoadData.matchWay)
// Chiều đi đã nhớ mà không được xác nhận lại lâu hơn chừng này (ms) thì thôi dùng, nhưng chỉ khi xe đã dịch đi;
// dừng yên một chỗ (kẹt xe, chờ đèn lâu) thì vẫn dùng.
const DIR_KEEP = 300e3;
// Từ tốc độ này (m/s) xe đang lăn bánh: hướng GPS và hướng dịch chuyển được dùng để kiểm tra chiều đi đã nhớ và
// để loại đường lệch hướng. Chậm hơn là đang đứng: vị trí chỉ trôi theo sai số, không nói gì về chiều đi.
const DIR_CHECK_SPEED = 1;
const DIR_CHECK_MOVE = 10; // xe dịch ít nhất chừng này (m, và 1,5 lần sai số) thì so hướng dịch chuyển với chiều đi đã nhớ
const DIR_AGREE = 60; // lệch không quá chừng này (độ): xe vẫn đi theo chiều đã nhớ, đường vẫn hợp hướng đi
const DIR_FAR = LENGTH; // xe đã ra ngoài hành lang dựng lúc xác nhận chiều đi lần cuối (vị trí nhảy xa): không dùng nữa
// Đi chậm (DIR_CHECK_SPEED…MOVING_SPEED) trên đường chưa nhớ chiều đi (Track.slowDir): hướng GPS lệch đoạn khớp không
// quá SLOW_AGREE độ ở SLOW_NEED lần định vị liên tiếp, mỗi lần một hướng mới do máy đo (không phải hướng lặp lại hay
// hướng suy từ vị trí, Track.observe), thì lấy làm chiều đi; trừ khi có đường khác lệch hướng không quá TWIN_AGREE độ
// trong TWIN_NEAR m quanh chỗ khớp (đường song song, đường gom, hai bên đường đôi, nhánh rẽ chưa tách xa: lúc đi chậm vị
// trí và hướng GPS không phân biệt được). TWIN_NEAR phải lớn hơn khoảng cách thật giữa đường chính và đường gom cùng tên
// (20–23 m ở Nguyễn Khoái, Hà Nội, trong dữ liệu đã lưu); TWIN_AGREE rộng hơn SLOW_AGREE để một bên đường đôi tách ra
// chếch 15–20° vẫn được tính.
const SLOW_AGREE = 30;
const SLOW_NEED = 2;
const TWIN_NEAR = 25;
const TWIN_AGREE = 45;

// Cong: lấy mẫu mỗi 10 m, tổng góc đổi hướng ≥ 55°, bán kính ≤ 120 m. Cửa sổ phải đủ dài để cung bán kính
// 120 m quay đủ 55° (14 mẫu, cung đo được tối đa 130 m); cửa sổ ngắn hơn bỏ sót các cua rộng khi chạy nhanh.
const CURVE_STEP = 10;
const CURVE_TURN = 55;
const CURVE_RADIUS = 120;
const CURVE_SPAN = Math.ceil((CURVE_RADIUS * CURVE_TURN * Math.PI) / 180 / CURVE_STEP) + 2;
// Đường gấp khúc ngay tại nút giao (góc phố): đổi hướng ≥ 40° giữa 10 m trước và 10 m sau nút thì là chỗ rẽ
// ở nút giao, không phải chỗ ngoặt.
const CORNER_TURN = 40;
const CORNER_SPAN = 10;
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
const NO_DIR = Object.freeze({ dir: 0, loose: false }); // Track.dirFor: không có chiều đi đã nhớ dùng được

/** Đi trên đường theo chiều dir (+1/−1) là đi ngược chiều đường một chiều với loại xe này. */
function isAgainst(way, dir, vehicle) {
  const o = onewayFor(way, vehicle);
  return o !== 0 && dir !== o;
}

/** Đường cấm loại xe này (cấm mọi xe, cấm ô tô với ô tô, cấm xe máy với xe máy). */
function closedTo(way, vehicle) {
  const info = classifyWay(way.t);
  return info.noAll || (vehicle === 'moto' ? info.noMoto : info.noCar);
}

/** Hướng (độ) của đoạn khớp m (kết quả RoadData.matchWay) khi đi theo chiều dir (+1/−1). */
function segmentBearing(m, dir) {
  const i = Math.min(m.seg, vertexCount(m.way) - 2);
  const a = vertexAt(m.way, i);
  const b = vertexAt(m.way, i + 1);
  return dir > 0 ? bearing(a, b) : bearing(b, a);
}

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
  } else if (hit.index === coords.length - 2 && hit.t === 1) {
    // Điểm nằm quá cuối hành lang: tính tiếp quãng vượt ra để bên gọi loại được (không coi là ở ngay cuối).
    const [ex, ey] = toLocal(coord, coords[coords.length - 1]);
    const beyond = (ex * bx + ey * by) / len;
    if (beyond > 0) {
      s = cum[cum.length - 1] + beyond;
      d = Math.abs(cross);
    }
  }
  return { s, d, index: hit.index, right: cross < 0 };
}

const corridorBearing = (corr, index) => bearing(corr.coords[index], corr.coords[index + 1]);
const pointOn = (corr, s) => pointAtDistance(corr.coords, corr.cum, s).point;

/** Hướng đi (độ) dọc hành lang quanh vị trí s, đo theo dây cung ±5 m để không nhảy hướng khi s rơi đúng đỉnh gấp khúc. */
function headingAt(corr, s) {
  const total = lengthOf(corr);
  return bearing(pointOn(corr, clamp(s - 5, 0, total)), pointOn(corr, clamp(s + 5, 0, total)));
}

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
function continuation(roads, way, endIdx, dir, visited, vehicle) {
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
  const against = (c) => isAgainst(c.way, c.dir, vehicle);
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

/**
 * Trí nhớ của hành lang tự do giữa các lần định vị: các đường của hành lang vừa dựng và chiều đi trên từng
 * đường. Dùng để (1) không nhảy sang đường song song, đường trên cao hay đường bên dưới chỉ vì một lần định vị
 * lệch, (2) giữ chiều đi khi xe chạy chậm hoặc dừng (đèn đỏ), kể cả khi đã qua chỗ nối sang đoạn đường kế tiếp.
 */
class Track {
  constructor() {
    this.clear();
  }

  clear() {
    this.dirs = new Map(); // id đường → chiều đi (+1/−1) trên hành lang vừa dựng
    this.builtAt = -Infinity; // lần cuối dựng được hành lang (ms)
    this.seenAt = -Infinity; // lần cuối chiều đi được xác nhận bằng chuyển động (ms)
    this.seenCoord = null; // vị trí lúc đó
    // { ids, coord, count }: một con đường không nối với hành lang cũ (các đoạn ids) đang thắng mấy lần liên tiếp
    this.pending = null;
    this.slow = null; // { id, dir, time, count }: đi chậm, hướng GPS hợp với chiều dir trên đường id mấy lần liên tiếp
    this.prev = null; // { heading, coord } của lần định vị trước (Track.observe)
    // Chiều đi các đường của hành lang đã xác nhận gần nhất, giữ lại khi hành lang đang nhớ (dirs) chỉ dựa vào
    // Track.slowDir; null khi dirs đã được xác nhận (hướng GPS lúc chạy, hoặc chiều đi đã xác nhận trước đó).
    this.kept = null;
  }

  /** Các đường được ưu tiên khi khớp vị trí (Map có .has), hoặc null. */
  preferred(time) {
    const age = time - this.builtAt;
    return this.dirs.size && age >= 0 && age <= PREFER_KEEP ? this.dirs : null;
  }

  /**
   * Đã quyết định xe sang đường khác: thôi ưu tiên các đường cũ, để các lần định vị sau (nhất là khi hành lang
   * trên đường mới chưa dựng được vì đi chậm) không bị kéo về đường cũ. Chiều đi đã nhớ vẫn giữ nhưng chỉ dùng
   * được khi xe lại khớp gần nhất với một đường cũ.
   */
  leave() {
    this.builtAt = -Infinity;
    this.pending = null;
  }

  /**
   * Ghi nhớ hành lang vừa dựng. moving: lần định vị này có hướng đáng tin (chiều đi vừa được xác nhận).
   * Hành lang chỉ dựa vào Track.slowDir (corr.start.loose) không xoá chiều đi của hành lang đã xác nhận trước đó
   * (kept): slowDir có thể nhầm sang đường song song, và khi xe lại khớp gần nhất với đường cũ thì dirFor vẫn biết
   * chiều đi trên đó như trước khi có slowDir.
   */
  remember(corr, fix, time, moving) {
    const dirs = new Map();
    for (const p of corr.pieces) {
      // Nhánh cấm đi ngược chiều chỉ là chỗ để báo, xe không đi vào đó.
      if (p.way && p.dir && !p.against && !dirs.has(p.way.id)) dirs.set(p.way.id, p.dir);
    }
    if (corr.start && corr.start.loose) {
      if (!this.kept) this.kept = this.dirs;
    } else {
      this.kept = null;
    }
    this.dirs = dirs;
    this.builtAt = time;
    if (moving) {
      this.seenAt = time;
      this.seenCoord = fix.coord;
    }
  }

  /**
   * Hướng GPS của lần định vị này có phải bằng chứng mới do máy đo không (gọi một lần cho mỗi lần định vị).
   * Máy không báo hướng khi đi chậm thì LocationService (location.js) điền vào hướng của lần trước, hoặc hướng từ một
   * vị trí trước tới vị trí này khi đã dịch đủ xa: hướng đó lặp lại y nguyên qua nhiều lần định vị (đếm nhiều lần
   * cũng không thêm gì), hoặc chỉ là hướng dịch chuyển vài mét, lệch theo sai số định vị. Hướng trùng đúng hướng lần
   * trước, hay trùng hướng từ vị trí lần trước tới vị trí này, thì không phải bằng chứng mới.
   */
  observe(fix) {
    const prev = this.prev;
    const h = fix.heading;
    this.prev = { heading: h, coord: fix.coord };
    if (!Number.isFinite(h)) return false;
    if (!prev) return true;
    if (h === prev.heading) return false;
    return !(prev.coord && Math.abs(angleDiff(bearing(prev.coord, fix.coord), h)) < 1e-6);
  }

  /** Chiều đi đã nhớ trên m.way: { dir, loose } (loose: chỉ dựa vào slowDir), hoặc null. */
  #recall(m, roads, vehicle) {
    const own = this.dirs.get(m.way.id) || carriedDir(this.dirs, m, roads, vehicle);
    if (own) return { dir: own, loose: this.kept != null };
    const old = this.kept && (this.kept.get(m.way.id) || carriedDir(this.kept, m, roads, vehicle));
    return old ? { dir: old, loose: false } : null;
  }

  /**
   * Chiều đi đã nhớ trên đường vừa khớp m (xe đi chậm nên không đọc được hướng): { dir, loose } (loose: chiều đi đó
   * chỉ dựa vào slowDir), hoặc { dir: 0 }. Không dùng khi vị trí đã nhảy xa chỗ xác nhận chiều đi lần cuối, khi xe
   * đang lăn bánh mà hướng GPS hay hướng dịch chuyển lệch quá DIR_AGREE so với chiều đã nhớ (xe đã rẽ hoặc quay đầu),
   * hay khi đã lâu không xác nhận được mà xe đã dịch đi. Lúc đứng yên, vị trí trôi theo sai số GPS không làm mất
   * chiều đi.
   */
  dirFor(m, fix, time, roads, vehicle) {
    const known = this.#recall(m, roads, vehicle);
    if (!known || !this.seenCoord) return NO_DIR;
    const { dir } = known;
    const age = time - this.seenAt;
    if (!(age >= 0)) return NO_DIR;
    const away = distance(this.seenCoord, fix.coord);
    if (away > DIR_FAR) return NO_DIR;
    const brg = segmentBearing(m, dir);
    const off = (h) => Math.abs(angleDiff(brg, h));
    // Chỉ tin hướng dịch chuyển khi quãng dịch vượt hẳn sai số định vị.
    const slack = Math.max(DIR_CHECK_MOVE, 1.5 * (fix.accuracy || 0));
    const moved = away >= slack ? off(bearing(this.seenCoord, fix.coord)) : null;
    let agreed = false;
    if ((fix.speed || 0) >= DIR_CHECK_SPEED) {
      if (Number.isFinite(fix.heading)) {
        if (off(fix.heading) > DIR_AGREE) return NO_DIR;
        agreed = true;
      }
      if (moved != null) {
        if (moved > DIR_AGREE) return NO_DIR;
        agreed = true;
      }
    } else if (moved != null && moved <= DIR_AGREE) {
      agreed = true; // nhích dần lên phía trước dưới DIR_CHECK_SPEED (kẹt xe)
    }
    if (agreed) {
      this.seenAt = time;
      if (moved != null) this.seenCoord = fix.coord; // điểm mốc đi theo xe, để đường cong không bị coi là quay đầu
    } else if (age > DIR_KEEP && moved != null) {
      return NO_DIR;
    }
    return known;
  }

  /**
   * Chiều đi trên đường vừa khớp m khi xe đi chậm (DIR_CHECK_SPEED…MOVING_SPEED) mà chưa biết chiều đi trên đường đó
   * (hành lang trước dừng ở nút giao chưa rõ hướng, hoặc đã rẽ chậm sang đường khác), hoặc 0. Lấy theo hướng GPS khi
   * hướng đó lệch đoạn khớp không quá SLOW_AGREE độ, theo chiều được đi với loại xe này (không bao giờ ngược đường
   * một chiều, không trên đường cấm loại xe này), ở SLOW_NEED lần định vị liên tiếp trên cùng đường, mỗi lần một hướng
   * mới do máy đo (fresh, Track.observe): hướng lặp lại hay suy từ vị trí chỉ được dùng để bỏ chiều đi đã nhớ, như
   * trong dirFor. Có đường khác lệch hướng không quá TWIN_AGREE độ trong TWIN_NEAR m quanh chỗ khớp thì không lấy: ở
   * tốc độ này vị trí và hướng GPS không phân biệt được hai đường song song.
   */
  slowDir(m, fix, roads, vehicle, time, fresh) {
    const speed = fix.speed || 0;
    if (!fresh || !(speed >= DIR_CHECK_SPEED && speed <= MOVING_SPEED) || !Number.isFinite(fix.heading)) {
      this.slow = null;
      return 0;
    }
    const raw = Math.abs(angleDiff(segmentBearing(m, 1), fix.heading));
    let dir = raw <= SLOW_AGREE ? 1 : raw >= 180 - SLOW_AGREE ? -1 : 0;
    if (dir && (isAgainst(m.way, dir, vehicle) || closedTo(m.way, vehicle))) dir = 0;
    const prev = this.slow;
    const count = dir && prev && prev.id === m.way.id && prev.dir === dir && time - prev.time <= 3000 ? prev.count + 1 : 1;
    this.slow = dir ? { id: m.way.id, dir, time, count } : null;
    if (!dir || count < SLOW_NEED) return 0;
    const twin = roads.matchWay({ coord: m.point, speed: 0, heading: null, accuracy: TWIN_NEAR }, '', {
      vehicle,
      heading: fix.heading,
      within: TWIN_AGREE,
      skip: new Set([m.way.id]),
    });
    return twin && twin.dist <= TWIN_NEAR ? 0 : dir;
  }
}

/**
 * Chiều đi trên m.way khi đường đó là nhánh đi thẳng tiếp (như continuation chọn) ở cuối một đường có chiều đi đã
 * nhớ trong dirs và xe đã qua chỗ nối, hoặc 0. Gặp khi xe đi chậm thẳng qua chỗ hành lang đã nhớ rẽ đi (bỏ lỡ chỗ
 * rẽ của tuyến dẫn đường).
 */
function carriedDir(dirs, m, roads, vehicle) {
  if (!dirs.size || !roads) return 0;
  const n = vertexCount(m.way);
  for (const along of [1, -1]) {
    let prev = m.point;
    let acc = 0;
    for (let k = along > 0 ? m.seg + 1 : m.seg; k >= 0 && k < n; k += along) {
      const v = vertexAt(m.way, k);
      acc += distance(prev, v);
      if (acc > SWITCH_NEAR) break;
      prev = v;
      for (const e of roads.waysAtVertex(v)) {
        const d = dirs.get(e.way.id);
        if (!d || e.way.id === m.way.id || e.i !== (d > 0 ? vertexCount(e.way) - 1 : 0)) continue;
        const next = continuation(roads, e.way, e.i, d, new Set(), vehicle);
        if (next && next.way.id === m.way.id && next.i === k && (next.dir > 0 ? m.seg >= k : m.seg < k)) return next.dir;
      }
    }
  }
  return 0;
}

/**
 * Từ vị trí khớp m đi dọc mạng đường qua các đỉnh chung, không quá radius (m), tối đa hops lần sang đường khác và
 * không đi xuyên qua các đường avoid: có gặp một đường trong ids không (hai đường nối liền nhau quanh xe).
 */
function linked(roads, m, ids, radius, hops = 1, avoid = null) {
  const queue = [{ way: m.way, from: m.point, seg: m.seg, acc: 0, hop: 0 }];
  const queued = new Set([m.way.id]);
  for (let q = 0; q < queue.length; q++) {
    const { way, from, seg, acc, hop } = queue[q];
    const n = vertexCount(way);
    for (const dir of [1, -1]) {
      let prev = from;
      let d = acc;
      for (let k = dir > 0 ? seg + 1 : seg; k >= 0 && k < n; k += dir) {
        const v = vertexAt(way, k);
        d += distance(prev, v);
        if (d > radius) break;
        prev = v;
        for (const e of roads.waysAtVertex(v)) {
          const id = e.way.id;
          if (id === way.id) continue;
          if (ids.has(id)) return true;
          if (hop + 1 < hops && !queued.has(id) && !(avoid && avoid.has(id))) {
            queued.add(id);
            queue.push({ way: e.way, from: v, seg: e.i, acc: d, hop: hop + 1 });
          }
        }
      }
    }
  }
  return false;
}

/**
 * Đoạn đường xe đang đi (không dẫn đường). Ưu tiên các đường của hành lang vừa dựng; chỉ chuyển sang một
 * đường không nối với chúng khi cùng một con đường (các đoạn nối liền nhau) thắng SWITCH_FIXES lần liên tiếp,
 * hoặc khi không còn đường cũ nào đủ gần và đúng hướng. Đang chạy mà sang đường nối với đường cũ thì chuyển ngay.
 * Đứng yên thì không chuyển: vị trí trôi sang đường bên cạnh không có nghĩa là xe đã sang đó.
 * Đi chậm (DIR_CHECK_SPEED…MOVING_SPEED) mà có hướng GPS thì khác: một lần định vị chưa đủ tin để biết chiều đi trên
 * đường mới (Track.slowDir cần vài lần liên tiếp và không có đường song song gần), nhưng đủ để bỏ các đường cũ lệch
 * hướng quá DIR_AGREE (xe đã rẽ, quay đầu). Lấy đường gần nhất, không cộng điểm cho đường cũ: sang nhầm đường mới ở
 * tốc độ này thường chỉ làm hành lang trống một lúc (thanh cảnh báo còn giữ vài giây), còn giữ nhầm đường cũ thì báo
 * biển của đường xe không đi.
 * Đã chuyển sang đường mới thì thôi ưu tiên các đường cũ (Track.leave).
 */
function startMatch(fix, roads, track, vehicle, time) {
  if (!track) return roads.matchWay(fix, '', { vehicle });
  const speed = fix.speed || 0;
  const prefer = track.preferred(time);
  if (prefer && Number.isFinite(fix.heading) && speed >= DIR_CHECK_SPEED && speed <= MOVING_SPEED) {
    track.pending = null;
    const m = roads.matchWay(fix, '', { vehicle, heading: fix.heading, within: DIR_AGREE, among: prefer });
    if (m && !prefer.has(m.way.id)) track.leave();
    return m;
  }
  const m = roads.matchWay(fix, '', { vehicle, prefer });
  if (!m || !prefer || prefer.has(m.way.id)) {
    track.pending = null;
    return m;
  }
  const leave = (w) => {
    track.leave();
    return w;
  };
  const old = roads.matchWay(fix, '', { vehicle, only: prefer });
  if (!old) return leave(m); // đã ra xa các đường cũ, hoặc không đường cũ nào đúng hướng
  if (speed < DIR_CHECK_SPEED) {
    track.pending = null;
    return old;
  }
  if (m.dir !== 0 && linked(roads, m, prefer, SWITCH_NEAR)) return leave(m);
  const p = track.pending;
  const radius = p ? Math.max(SWITCH_NEAR, 1.5 * distance(p.coord, fix.coord)) : 0;
  const same = Boolean(p) && (p.ids.has(m.way.id) || linked(roads, m, p.ids, radius, LINK_HOPS, prefer));
  const count = same ? p.count + 1 : 1;
  if (count >= SWITCH_FIXES) return leave(m);
  track.pending = { ids: new Set(same ? [...p.ids, m.way.id] : [m.way.id]), coord: fix.coord, count };
  return old;
}

/** Không dẫn đường: đi theo đường đang khớp tới hết đường, rồi đoán nhánh đi thẳng qua các nút giao. */
function freeCorridor(fix, roads, track, vehicle, time) {
  const fresh = track ? track.observe(fix) : false;
  const m = startMatch(fix, roads, track, vehicle, time);
  if (!m) return emptyCorridor();
  let dir = m.dir;
  let loose = false;
  // Đi chậm hoặc dừng (đèn đỏ): giữ chiều đi đã biết trên đường đó (một trong các đường của hành lang trước).
  if (!dir && track) ({ dir, loose = false } = track.dirFor(m, fix, time, roads, vehicle));
  // Đi chậm trên đường chưa biết chiều đi: theo hướng GPS nếu đủ chắc.
  if (!dir && track) {
    dir = track.slowDir(m, fix, roads, vehicle, time, fresh);
    loose = dir !== 0;
  } else if (track) track.slow = null;
  if (!dir) return emptyCorridor();

  const corr = { coords: [m.point], cum: [0], pieces: [], start: { wayId: m.way.id, dir, loose } };
  const visited = new Set();
  let way = m.way;
  let from = dir > 0 ? m.seg + 1 : m.seg;
  let assumed = false;
  for (;;) {
    visited.add(way.id);
    const against = isAgainst(way, dir, vehicle);
    const n = vertexCount(way);
    const s0 = lengthOf(corr);
    let open = true;
    if (against && assumed) {
      // Nhánh đi ngược đường một chiều: chỉ giữ 1 m qua chỗ vào để báo "cấm đi ngược chiều". Người lái phải
      // rẽ ở nút giao, nên biển, đèn, chỗ ngoặt bên trong đường đó không phải của đường phía trước.
      extend(corr, pointAlongWay(way, from - dir, dir, AGAINST_STUB));
    } else {
      for (let i = from; open && i >= 0 && i < n; i += dir) open = extend(corr, vertexAt(way, i));
    }
    const s1 = lengthOf(corr);
    if (s1 > s0) corr.pieces.push({ way, dir, s0, s1, assumed, against });
    // Nhánh ngược chiều: không đoán tiếp.
    if (!open || against || corr.pieces.length >= MAX_PIECES) break;
    const endIdx = dir > 0 ? n - 1 : 0;
    const next = continuation(roads, way, endIdx, dir, visited, vehicle);
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
function navCorridor(nav, roads, vehicle) {
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
  const match = (a) => {
    const p = pointAtDistance(rc, rcum, a);
    const m = roads.matchWay({ coord: p.point, heading: p.bearing, speed: 10, accuracy: 10 }, '', { vehicle });
    return { s: a - s, way: m ? m.way : null, dir: m ? m.dir : 0 };
  };
  const idOf = (sm) => (sm.way ? sm.way.id : null);
  const grid = [s];
  for (let a = (Math.floor(s / NAV_SAMPLE) + 1) * NAV_SAMPLE; a < end - 1; a += NAV_SAMPLE) grid.push(a);
  grid.push(end);
  // Đường ngắn hơn 20 m (đoạn chui dưới cầu, đoạn nối giữa hai làn của đường cắt ngang…) có thể lọt giữa hai
  // mẫu. Giữa hai mẫu khớp với hai đường khác nhau, lấy thêm mẫu ở trung điểm từng đoạn tuyến: mỗi đường mà
  // tuyến đi qua đều chứa trọn ít nhất một đoạn tuyến.
  const samples = [];
  let seg = at.index;
  for (const a of grid) {
    const sm = match(a);
    const prev = samples[samples.length - 1];
    if (prev && idOf(prev) !== idOf(sm)) {
      const a0 = prev.s + s;
      while (seg + 1 < rc.length && rcum[seg + 1] <= a0) seg++;
      for (let j = seg; j + 1 < rc.length; j++) {
        const mid = (rcum[j] + rcum[j + 1]) / 2;
        if (mid >= a) break;
        if (mid > a0) samples.push(match(mid));
      }
    }
    samples.push(sm);
  }
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
    const against = Boolean(sm.way && isAgainst(sm.way, sm.dir, vehicle));
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
 * @param opts  { vehicle: 'car'|'moto', track: trí nhớ hành lang của SignEngine (không bắt buộc),
 *                time: thời điểm định vị (ms) }
 */
export function buildCorridor(fix, roads, nav = null, { vehicle = 'car', track = null, time = fix.time } = {}) {
  if (nav && nav.route && Number.isFinite(nav.s)) return navCorridor(nav, roads, vehicle);
  return freeCorridor(fix, roads, track, vehicle, Number.isFinite(time) ? time : Date.now());
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

/**
 * Các nút giao trên hành lang → [{ s, key }] theo thứ tự s. Đi theo đỉnh của chính đường OSM ở từng đoạn,
 * vì khi dẫn đường toạ độ tuyến chỉ có 6 chữ số thập phân nên không trùng hẳn đỉnh OSM.
 */
function junctionsOn(corr, roads, memo) {
  const out = [];
  const keys = new Set();
  for (const p of corr.pieces) {
    if (!p.way) continue;
    const line = memo.coordsOf(p.way);
    const hit = nearestOnLine(pointOn(corr, p.s0), line);
    if (!hit) continue;
    let prev = hit.point;
    let s = p.s0;
    for (let k = p.dir > 0 ? hit.index + 1 : hit.index; k >= 0 && k < line.length; k += p.dir) {
      s += distance(prev, line[k]);
      prev = line[k];
      if (s > p.s1 + 1) break;
      const key = vertexKey(line[k]);
      if (keys.has(key) || armsAt(roads, line[k]) < 3) continue;
      keys.add(key);
      out.push({ s, key });
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Khoá nút giao gần vị trí s nhất (trong JUNCTION_NEAR m), hoặc null. */
function junctionNear(junctions, s) {
  let best = null;
  for (const j of junctions) {
    const d = Math.abs(j.s - s);
    if (d <= JUNCTION_NEAR && (!best || d < best.d)) best = { d, key: j.key };
  }
  return best ? best.key : null;
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
      // Đúng bản đường đang đi (cùng đối tượng): bản của ô khác có thể lệch chỉ số đỉnh, lấy f từ bản đó rồi đi
      // trên bản này là sai chỗ. Không thấy thì chiếu nút lên chính bản này.
      const hit = roads.waysAtVertex(feat.coord).find((e) => e.way === way);
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

/**
 * Biển đứng riêng không ghi hướng: nằm sát tim đường, hoặc nằm bên phải chiều đi. Trên đường một chiều (với
 * dòng xe chung, way.o) biển đặt bên nào cũng là biển của chiều chính: áp dụng cho xe đi theo chiều đó, còn xe
 * máy được phép đi ngược chiều (oneway:motorcycle=no) thì không nhận, vì biển quay mặt về phía dòng xe kia.
 */
function sideOk(loc, piece) {
  if (loc.d < 3) return true;
  const way = piece && piece.way;
  if (way && way.o !== 0) return piece.dir === way.o;
  return loc.right;
}

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
    case 'deg': {
      // Biển hai mặt (direction=0;180…): áp dụng khi một trong các mặt quay về phía xe tới.
      const brg = corridorBearing(corr, loc.index);
      return dir.degs.some((deg) => Math.abs(angleDiff(brg, (deg + 180) % 360)) <= 60);
    }
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
/** Bảng lệnh cấm tra bằng chuỗi từ OSM: chỉ nhận khoá của chính bảng (không nhận "constructor", "__proto__"…). */
const restrictionOf = (v) => (v != null && Object.hasOwn(RESTRICTION, v) ? RESTRICTION[v] : null);
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
    else if (unknown && !restrictionOf(base)) {
      // Chỉ cấm trong khung giờ chưa đọc được: vẫn báo, kèm chữ "theo giờ".
      value = unknown.value;
      timed = true;
    } else if (unknown) {
      timed = unknown.value !== base; // lệnh cấm có thể được bỏ trong một số giờ
    }
  }
  const r = restrictionOf(value);
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
    // Lệnh cấm thuộc đúng nút "via" của nó: hai nút khác nhau không bao giờ coi là một biển.
    if (f && categoryEnabled(f.cat, ctx.settings)) out.push(makeItem(`r${key}`, f, g.s, g.coord, { junction: key }));
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

/**
 * Các đoạn cong (chưa xét tốc độ): [{ side, s, s1, radius, turn, coord }].
 * corners: vị trí (m) các góc phố, tức chỗ đường gấp khúc ngay tại nút giao; góc đổi hướng ở đó không tính.
 */
function findCurves(coords, cum, { phase = 0, skip = null, corners = [] } = {}) {
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
  // Góc ở góc phố rơi vào các mẫu cách nó dưới 10 m (dây cung giữa hai mẫu cắt qua góc): bỏ đi. Phần cong còn
  // lại quanh đó (cua gắt có đường nhánh ở đỉnh) vẫn được xét.
  for (const c of corners) {
    for (let k = 1; k + 1 < n; k++) if (Math.abs(ss[k] - c) < CURVE_STEP) turn[k] = 0;
  }

  // Với mỗi điểm đầu: cửa sổ ngắn nhất (tối đa CURVE_SPAN mẫu) có tổng góc đổi hướng ≥ 55°.
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
  // Góc phố: đường (thường là cùng một đường OSM) gấp ≥ 40° ngay tại nút giao. Đó là chỗ rẽ ở ngã tư, không
  // phải chỗ ngoặt nguy hiểm; khi không dẫn đường thì không có chỉ dẫn rẽ nào để loại nó.
  const total = lengthOf(corr);
  const corners = [];
  for (const j of ctx.junctions) {
    const v = pointOn(corr, j.s);
    const a = pointOn(corr, Math.max(0, j.s - CORNER_SPAN));
    const b = pointOn(corr, Math.min(total, j.s + CORNER_SPAN));
    if (distance(a, v) < 1 || distance(v, b) < 1) continue;
    if (Math.abs(angleDiff(bearing(a, v), bearing(v, b))) >= CORNER_TURN) corners.push(j.s);
  }
  const phase = ctx.nav ? (CURVE_STEP - (ctx.nav.s % CURVE_STEP)) % CURVE_STEP : 0;
  // Chỗ ngoặt đã báo (theo cùng chiều đi) thì giữ lại tới khi đi qua, kể cả khi xe đã giảm tốc.
  const raw = findCurves(corr.coords, corr.cum, { phase, skip, corners }).filter(
    (c) => curveOk(c, ctx.speed) || ctx.curveKey([c.coord], headingAt(corr, c.s)) != null,
  );
  for (const c of mergeCurves(raw)) {
    const f = c.kind === 'curves' ? derived('curves') : derived('curve', { side: c.side });
    const coord = c.coord;
    const key =
      ctx.curveKey(c.anchors, headingAt(corr, c.s)) ??
      `c${coord[0].toFixed(4)},${coord[1].toFixed(4)}:${c.kind === 'curves' ? 'curves' : c.side}`;
    out.push(makeItem(key, f, c.s, coord, { anchors: c.anchors }));
  }
}

// ---------------------------------------------------------------------------------------------
// Dùng chung với bộ học biển từ camera (signlearn.js). Chỉ đọc: không đổi hành vi của bộ máy.
// ---------------------------------------------------------------------------------------------

export { locate, pointOn, headingAt, pieceAt, armsAt, FEAT_STEP, FEAT_RADIUS, JUNCTION_NEAR, ON_WAY_LATERAL, OFF_WAY_LATERAL };

/** Các nút giao (đỉnh có từ 3 nhánh) trên hành lang → [{ s, key }] theo thứ tự s (junctionsOn, bộ nhớ tạm riêng). */
export function junctionsAlong(corr, roads) {
  if (!corr || !roads || !corr.pieces) return [];
  return junctionsOn(corr, roads, new Memo());
}

/** Nút giao đầu tiên trong khoảng [s, s + maxAhead] (m) của hành lang → { s, key, coord } hoặc null. */
export function junctionAhead(corr, roads, s, maxAhead = JUNCTION_NEAR) {
  for (const j of junctionsAlong(corr, roads)) {
    if (j.s < s) continue;
    if (j.s - s > maxAhead) break;
    return { s: j.s, key: j.key, coord: j.key.split(',').map(Number) };
  }
  return null;
}

/**
 * Các mục lấy từ dữ liệu bản đồ trên hành lang, áp dụng cho chiều đi trên đó (nút biển, thay đổi khi sang đoạn
 * đường khác, cấm rẽ), với mọi nhóm biển đang bật và không xét các mục đã báo → [{ key, kind, code, value, dup,
 * distance, coord }]. Không có chỗ ngoặt tính từ hình dạng đường (đó là suy đoán của ứng dụng, không phải dữ liệu).
 */
export function mapItems(corr, roads, { vehicle = 'car', now = new Date() } = {}) {
  if (!corr || !roads || !corr.coords || corr.coords.length < 2) return [];
  const ctx = {
    settings: Object.fromEntries(SIGN_CATEGORIES.map((c) => [c.setting, true])),
    vehicle,
    now,
    nav: null,
    speed: 0,
    memo: new Memo(),
    wayIds: new Set(corr.pieces.filter((p) => p.way).map((p) => p.way.id)),
    junctions: [],
    curveKey: () => null,
  };
  const raw = [];
  featItems(corr, roads, ctx, raw);
  transitionItems(corr, ctx, raw);
  restrictionItems(corr, roads, ctx, raw);
  return raw
    .filter((it) => it.distance >= 0)
    .map(({ key, kind, code, value, dup, distance: d, coord }) => ({ key, kind, code, value, dup, distance: d, coord }));
}

// ---------------------------------------------------------------------------------------------
// C3. Bộ máy: chọn mục hiện trên thanh cảnh báo và thời điểm đọc
// ---------------------------------------------------------------------------------------------

const EMPTY = Object.freeze({ active: null, upcoming: [], fired: [], say: null });

/** Hai hướng đi (độ) cùng chiều (lệch không quá REVERSED); thiếu hướng thì coi là cùng chiều. */
const sameWay = (a, b) => a == null || b == null || Math.abs(angleDiff(a, b)) <= REVERSED;

export class SignEngine {
  // Hành lang dựng ở lần cập nhật gần nhất (null khi không dựng được) và thời điểm lần định vị đó (ms, fix.time).
  // Chỉ để đọc (bộ học biển đặt biển lên đúng hành lang mà cảnh báo dùng); bộ máy không đọc lại hai giá trị này.
  #corr = null;
  #corrTime = null;

  /** Hành lang của lần cập nhật gần nhất ({ coords, cum, pieces, … }, không được sửa) hoặc null. */
  get lastCorridor() {
    return this.#corr;
  }

  /** Thời điểm (ms, fix.time) của lần định vị đã dựng lastCorridor, hoặc null. */
  get lastCorridorTime() {
    return this.#corrTime;
  }

  constructor() {
    this.seen = new Map(); // khoá → { coord, time, reach, spoken, dup, brg, junction, anchors? }
    this.lastSpeak = -Infinity;
    this.lastFix = null; // thời điểm lần định vị trước (ms)
    this.track = new Track(); // các đường và chiều đi của hành lang vừa dựng
    this.last = null; // kết quả gần nhất, giữ tạm khi mất khớp đường
    this.stay = null; // mục vừa hiện trên thanh cảnh báo, giữ lại khi đứng chờ ngay trước nó (#waiting)
    this.approached = new Set(); // khoá các mục xe đã tiến lại gần mà chưa đi qua (#waiting)
    this.memo = new Memo();
    this.memoTime = -Infinity;
  }

  /** Bắt đầu chuyến mới: quên mọi mục đã báo. */
  reset() {
    this.seen.clear();
    this.lastSpeak = -Infinity;
    this.lastFix = null;
    this.track.clear();
    this.last = null;
    this.stay = null;
    this.approached.clear();
    this.#corr = null;
    this.#corrTime = null;
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

    const corr = buildCorridor(fix, roads, nav, { vehicle, track: this.track, time });
    this.#corr = corr.coords.length < 2 ? null : corr;
    this.#corrTime = time;
    if (corr.coords.length < 2) return this.#hold(time, speed);
    // Hành lang theo tuyến cũng được nhớ: rời tuyến khi đang đi chậm thì vẫn biết chiều đi.
    this.track.remember(corr, fix, time, fix.heading != null && speed > MOVING_SPEED);

    const ctx = {
      settings,
      vehicle,
      now,
      nav: corr.start ? null : nav,
      speed,
      memo: this.memo,
      wayIds: new Set(corr.pieces.filter((p) => p.way).map((p) => p.way.id)),
      junctions: junctionsOn(corr, roads, this.memo),
      curveKey: (anchors, brg) => this.#curveKey(anchors, brg),
    };
    const items = this.#collect(corr, roads, ctx);

    // Mục đã báo nay lại ở phía trước nhưng theo chiều ngược lại (quay đầu xe, đi lại đường cũ): báo lại như mục mới.
    for (const it of items) {
      const e = this.seen.get(it.key);
      if (e && !sameWay(e.brg, it.brg)) this.seen.delete(it.key);
    }

    // Mục mới thấy mà đã quá gần thì chỉ hiện. Biển cùng loại sát một biển vừa đọc, cùng chiều đi và cùng một
    // nút giao (đèn ở hai phía giao lộ, vạch qua đường liền nhau) thì coi như đã báo. Đèn hay lệnh cấm rẽ của
    // một nút giao khác ngay sau đó vẫn được đọc.
    for (const it of items) {
      if (this.seen.has(it.key)) continue;
      if (it.distance < minD) {
        this.#mark(it, time, reachNow, false); // quá gần rồi: chỉ hiện, không đọc
        continue;
      }
      for (const e of this.seen.values()) {
        if (
          e.spoken &&
          e.dup === it.dup &&
          e.junction === it.junction &&
          sameWay(e.brg, it.brg) &&
          distance(e.coord, it.coord) <= SAME_KIND_GAP
        ) {
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
      // Mục đã báo hiện tới khi đi qua, nhưng không xa hơn khoảng lúc báo (vạch đo không bao giờ bắt đầu từ 0).
      if (it.distance <= (e ? Math.max(trigger, e.reach) : trigger)) {
        active = { item: publicItem(it), distance: it.distance, reach: e ? e.reach : Math.max(reachNow, it.distance) };
        break;
      }
    }
    active = this.#waiting(active, items, corr, fix, speed, time);

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
    const items = [...byKey.values()];
    for (const it of items) {
      it.brg = headingAt(corr, it.distance); // hướng đi tại mục
      it.junction = it.junction ?? junctionNear(ctx.junctions, it.distance);
    }
    return items.sort((a, b) => a.distance - b.distance);
  }

  #mark(it, time, reach, spoken) {
    this.seen.set(it.key, {
      coord: it.coord,
      time,
      reach,
      spoken,
      dup: it.dup,
      brg: it.brg,
      junction: it.junction,
      anchors: it.anchors || null,
    });
  }

  /**
   * Khoá của chỗ ngoặt đã báo theo cùng chiều đi (hướng brg), nằm gần một trong các điểm neo này (vị trí tính
   * lại mỗi lần lệch vài mét).
   */
  #curveKey(anchors, brg) {
    for (const [key, e] of this.seen) {
      if (!e.anchors || !sameWay(e.brg, brg)) continue;
      for (const a of e.anchors) {
        for (const b of anchors) if (distance(a, b) <= CURVE_ALIAS) return key;
      }
    }
    return null;
  }

  #forget(coord) {
    for (const [key, e] of this.seen) if (distance(coord, e.coord) > FORGET) this.seen.delete(key);
  }

  /**
   * Đứng chờ ngay trước mục đang hiện (đèn đỏ, biển dừng): lúc đứng yên, sai số định vị có thể đẩy vị trí qua khỏi
   * mục vài mét, mục rơi ra sau lưng và thanh cảnh báo chớp tắt. Mục vừa hiện mà nay không còn phía trước thì vẫn
   * giữ, khoảng cách không âm và chỉ giảm theo tốc độ đo được, khi:
   * - xe đã thấy mục ở phía trước xa hơn bán kính sai số (đã tiến lại gần nó) và từ đó chưa lần nào chạy từ
   *   MIN_SPEAK_SPEED trở lên mà mục không còn phía trước (chưa thật sự đi qua nó);
   * - lần định vị này dưới MIN_SPEAK_SPEED, còn trong WAIT_RADIUS (hoặc sai số định vị nếu lớn hơn) quanh chỗ mục
   *   hiện lần cuối;
   * - mục vẫn nằm sát đầu hành lang, theo cùng chiều đi (không phải mục của đường vừa rẽ khỏi).
   * Giá phải trả: xe dừng ngay sau mục (đã qua đèn vài mét) đôi khi vẫn thấy mục đó lâu hơn một chút.
   * Trả về mục cần hiện.
   */
  #waiting(active, items, corr, fix, speed, time) {
    const radius = Math.max(WAIT_RADIUS, fix.accuracy || 0);
    const ahead = new Set(items.map((it) => it.key));
    for (const it of items) if (it.distance > radius) this.approached.add(it.key);
    const st = this.stay;
    // Chạy từ MIN_SPEAK_SPEED trở lên mà mục không còn phía trước: đã đi qua hoặc đã rẽ đi. Kẹt xe lâu (không lần
    // nào chạy nhanh) thì chỉ giữ các mục còn phía trước và mục đang hiện, để danh sách không dài mãi.
    if (speed >= MIN_SPEAK_SPEED || this.approached.size > 64) {
      for (const key of this.approached) {
        if (!ahead.has(key) && (speed >= MIN_SPEAK_SPEED || key !== st?.item.key)) this.approached.delete(key);
      }
    }
    if (st && speed < MIN_SPEAK_SPEED && !ahead.has(st.item.key) && this.approached.has(st.item.key)) {
      const loc = distance(fix.coord, st.coord) <= radius ? locate(corr, st.item.coord) : null;
      if (
        loc &&
        loc.s >= -radius &&
        loc.s <= st.distance + radius &&
        loc.d <= OFF_WAY_LATERAL &&
        Math.abs(angleDiff(headingAt(corr, 0), st.brg)) <= DIR_AGREE
      ) {
        st.distance = Math.max(0, st.distance - speed * clamp((time - st.time) / 1000, 0, 2));
        st.time = time;
        return { item: { ...st.item, distance: st.distance }, distance: st.distance, reach: st.reach };
      }
    }
    const it = active && items.find((x) => x.key === active.item.key);
    this.stay = it ? { item: active.item, coord: fix.coord, distance: active.distance, reach: active.reach, brg: it.brg, time } : null;
    return active;
  }

  /** Không dựng được hành lang (mất khớp đường, đi chậm…): giữ kết quả cũ thêm vài giây. */
  #hold(time, speed) {
    if (speed >= MIN_SPEAK_SPEED) {
      this.stay = null;
      this.approached.clear();
    }
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
