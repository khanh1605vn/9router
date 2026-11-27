// Dữ liệu đường từ OpenStreetMap (qua Overpass API): giới hạn tốc độ của từng đoạn đường, các điểm
// cần cảnh báo (camera, trạm thu phí, đường ngang đường sắt), các nút mang biển báo hoặc thông tin
// tương đương (đèn tín hiệu, vạch qua đường, gờ giảm tốc, biển dừng…) và các quan hệ cấm rẽ.
// Lớp này chỉ lọc và lưu thẻ thô; việc hiểu ý nghĩa biển báo nằm ở nơi khác.
// Bản đồ được chia thành các ô ~3,3 km; mỗi ô tải một lần rồi lưu lại trên máy. Ô đã lưu luôn được dùng ngay
// (kể cả khi mất mạng, dù cũ tới đâu); có mạng mà ô đã quá 6 giờ thì được tải lại ngầm, xong là thay vào ngay.

import { angleDiff, bearing, distance, projectOnSegment } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const CELL = 0.03; // kích thước ô (độ)
const GRID = 0.001; // ô lưới tra cứu đoạn đường và nút biển báo (~110 m)
// Quá hạn này (hoặc bản ghi kiểu cũ) thì ô được tải lại như trước: hỏng thì 60 giây sau thử lại.
const TTL = 7 * 24 * 3600e3;
const RETRY_AFTER = 60e3;
// Làm mới ngầm: ô đúng phiên bản nhưng tải đã quá REFRESH_AGE thì tải lại khi có mạng, trong lúc vẫn dùng bản đang có.
// Dữ liệu OSM chỉ đổi khi có người sửa bản đồ, nên 6 giờ là đủ để thấy chỗ sửa trong ngày mà không tải thừa.
export const REFRESH_AGE = 6 * 3600e3;
// Làm mới ngầm hỏng (máy chủ bận, mạng chập chờn) thì chờ chừng này mới thử lại ô đó: dữ liệu đang có vẫn dùng được.
export const REFRESH_RETRY = 10 * 60e3;
// Hai lượt làm mới (ô đã có dữ liệu) cách nhau ít nhất chừng này, tính từ lúc lượt trước xong: không dồn truy vấn
// liên tiếp lên Overpass khi nhiều ô cùng tới hạn (mở ứng dụng sau nhiều ngày, xe đứng ở góc bốn ô).
export const REFRESH_GAP = 30e3;
const REQUEST_TIMEOUT = 70e3; // máy chủ được chạy 60 giây, cộng thêm thời gian truyền dữ liệu
const MAX_CELLS = 16;
// Bản ghi cũ hơn vẫn dùng tạm được nhưng sẽ được tải lại. 3: đường có thêm chiều một chiều riêng của xe máy (om).
// 4: cấm xe theo giờ (*:conditional), giới hạn tốc độ theo chiều (cf/cb/mf/mb), minspeed, ford, toll trên đường; cấm rẽ
// có "via" là đường; hướng camera; trạm thu phí vẽ thành vùng; camera đọc biển số (ALPR); quan hệ enforcement đầy đủ hơn.
// 5: cờ cx/mx (đường có maxspeed riêng cho ô tô / xe máy); camera đọc biển số (ALPR) chỉ khi là camera giao thông.
export const CACHE_VERSION = 5;
// matchWay: đường thuộc hành lang vừa dựng được cộng chừng này (m) vào điểm, để một lần định vị lệch không làm
// nhảy sang đường song song. 8 m xấp xỉ bằng, có chỗ còn lớn hơn, khoảng cách thật giữa hai đường song song cùng
// chiều (đường hầm và đường bên trên, đường trên cao và đường bên dưới, đường chính và đường song hành: khoảng
// 6,5–10 m trong dữ liệu Hà Nội và TP.HCM đã lưu). Đây là lựa chọn có chủ ý: sau một đợt định vị lệch, hành lang đôi
// khi bị giữ ở nhầm đường song song, kể cả khi các lần định vị sau đã nằm đúng trên đường kia, nên có thể bỏ sót
// biển của đường kia. Đổi lại, số câu đọc biển của đường xe không đi giảm khoảng một nửa. Các cách khác (cộng ít điểm
// hơn, giới hạn mức cộng theo khoảng cách giữa hai đường, thôi ưu tiên khi đường gần nhất khác đường cũ vài lần liên
// tiếp) đã được thử bằng vết GPS mô phỏng trên dữ liệu đường đã lưu, và đều kém hơn khi tính gộp biển bỏ sót với câu
// đọc nhầm đường.
const PREFER_BONUS = 8;

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

// Thẻ của đường cần giữ lại để suy ra biển báo (vòng xuyến, hầm, cấm xe, hạn chế kích thước, cấm vượt…).
const WAY_KEYS = new Set([
  'junction', 'tunnel', 'access', 'vehicle', 'motor_vehicle', 'motorcar', 'motorcycle',
  'oneway:motorcycle', 'oneway:moped',
  'maxheight', 'maxheight:physical', 'maxheight:forward', 'maxheight:backward',
  'maxweight', 'maxweight:forward', 'maxweight:backward',
  'maxwidth', 'maxwidth:forward', 'maxwidth:backward',
  'overtaking', 'overtaking:forward', 'overtaking:backward', 'hazard',
  // Cấm xe theo giờ (giá trị "no @ (Sa-Su 18:30-23:00)"): bộ máy biển báo chỉ đọc các khung giờ trong tuần.
  'motorcar:conditional', 'motorcycle:conditional', 'motor_vehicle:conditional', 'vehicle:conditional', 'access:conditional',
  // Giới hạn tốc độ có điều kiện (đọc lúc chạy, chỉ khung giờ trong tuần), tốc độ tối thiểu, đường ngầm, đường thu phí.
  'maxspeed:conditional', 'maxspeed:motorcar:conditional', 'maxspeed:motorcycle:conditional',
  'minspeed', 'ford', 'toll',
]);
// Giá trị *:conditional thường dài (nhiều khung ngày lễ trước khung giờ trong tuần): giữ trọn tới 255 ký tự (giới hạn
// độ dài giá trị của OSM). Cắt ngắn sẽ làm hỏng khung giờ cuối cùng, đúng phần cần đọc.
const MAX_COND_LEN = 255;

// Thẻ của nút biển báo cần giữ lại.
const FEAT_KEYS = new Set([
  'highway', 'railway', 'crossing', 'crossing_ref', 'crossing:markings', 'crossing:barrier',
  'traffic_calming', 'hazard', 'hazard:direction',
  'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward', 'traffic_sign:direction',
  'traffic_signals:direction', 'direction', 'stop', 'stop:direction', 'give_way:direction',
  'maxspeed', 'overtaking', 'maxheight', 'maxweight', 'maxwidth', 'barrier', 'code', 'content', 'name', 'ford',
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
    `node.rn["ford"];` +
    // Biển và điểm cảnh báo đứng riêng bên lề đường.
    `node["traffic_sign"];` +
    `node["hazard"];` +
    `node["highway"~"^(speed_camera|stop|give_way|toll_gantry)$"];` +
    `node["man_made"="surveillance"]["surveillance:zone"="traffic"];` +
    // Camera đọc biển số xe (ALPR): chỉ nhận khi không ghi vùng khác traffic (isTrafficCamera); camera giám sát chung
    // (không ghi vùng traffic) thì không nhận.
    `node["man_made"="surveillance"]["surveillance:type"="ALPR"];` +
    `node["barrier"="toll_booth"];` +
    `)->.pts;` +
    // Trạm thu phí vẽ thành vùng hay đường: chỉ cần tâm.
    `way["barrier"="toll_booth"]->.tw;` +
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
    `.enf out body geom qt;` +
    `.tw out tags center qt;`
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
    out[k] = String(tags[k]).slice(0, k.endsWith(':conditional') ? Math.max(maxLen, MAX_COND_LEN) : maxLen);
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
    tags.barrier === 'height_restrictor' ||
    tags.ford === 'yes'
  );
}

/** Giá trị thẻ oneway:<loại xe> → 1 (một chiều theo chiều vẽ), −1 (ngược chiều vẽ), 0 (hai chiều), null nếu không đọc được. */
function onewayValue(v) {
  if (v === 'yes') return 1;
  if (v === '-1') return -1;
  if (v === 'no') return 0;
  return null;
}

function parseWay(el) {
  const tags = el.tags || {};
  if (!tags.highway || !Array.isArray(el.geometry) || el.geometry.length < 2) return null;
  const general = parseMaxspeed(tags.maxspeed);
  const g = [];
  for (const pt of el.geometry) if (pt) g.push(pt.lon, pt.lat);
  if (g.length < 4) return null;
  const o = tags.oneway === 'yes' || tags.junction === 'roundabout' ? 1 : tags.oneway === '-1' ? -1 : 0;
  const way = {
    id: el.id,
    n: tags.name || tags.ref || '',
    h: tags.highway,
    c: parseMaxspeed(tags['maxspeed:motorcar']) ?? general,
    m: parseMaxspeed(tags['maxspeed:motorcycle']) ?? general,
    o,
    g,
  };
  // Phố một chiều với ô tô nhưng xe máy được đi hai chiều (oneway=yes + oneway:motorcycle=no, rất hay gặp ở
  // nội thành Hà Nội và TP.HCM). Đọc oneway:motorcycle trước, rồi tới oneway:moped (xe gắn máy). Chỉ ghi om khi
  // khác o, để bản ghi gọn.
  const om = onewayValue(tags['oneway:motorcycle']) ?? onewayValue(tags['oneway:moped']);
  if (om != null && om !== o) way.om = om;
  // Giới hạn theo chiều vẽ (f) và ngược chiều vẽ (b), chỉ ghi khi đường có thẻ maxspeed theo chiều cho loại xe đó.
  Object.assign(way, directionalSpeeds(tags, 'motorcar', 'c'), directionalSpeeds(tags, 'motorcycle', 'm'));
  // Có thẻ maxspeed riêng cho loại xe (không kể :conditional): thẻ riêng đứng trên maxspeed:conditional chung
  // (roadLimit của signengine.js). Chỉ ghi khi có, để bản ghi gọn.
  if (OWN_SPEED_KEYS.motorcar.some((k) => tags[k] != null)) way.cx = 1;
  if (OWN_SPEED_KEYS.motorcycle.some((k) => tags[k] != null)) way.mx = 1;
  const t = pickTags(tags, keepWayTag, MAX_TAG_LEN);
  if (t) way.t = t;
  return way;
}

/**
 * Camera giám sát là camera giao thông: surveillance:zone=traffic, hoặc camera đọc biển số (ALPR) không ghi vùng và
 * không phải camera riêng, trong nhà. ALPR có vùng khác (parking, building, shop…) là camera cổng bãi xe, cổng toà nhà:
 * không nhận, để không báo nhầm cạnh bãi xe.
 */
function isTrafficCamera(tags) {
  if (tags.man_made !== 'surveillance') return false;
  const zone = String(tags['surveillance:zone'] ?? '').trim();
  if (zone === 'traffic') return true;
  if (tags['surveillance:type'] !== 'ALPR' || zone) return false;
  return !ALPR_NOT_TRAFFIC.has(String(tags.surveillance ?? '').trim());
}
const ALPR_NOT_TRAFFIC = new Set(['private', 'indoor']);

const SPEED_DIRS = [['forward', 'f'], ['backward', 'b']];
const OWN_SPEED_KEYS = Object.fromEntries(
  ['motorcar', 'motorcycle'].map((v) => [v, [`maxspeed:${v}`, `maxspeed:${v}:forward`, `maxspeed:${v}:backward`]])
);

/**
 * maxspeed:forward / maxspeed:backward (và maxspeed:<loại xe>:forward…) → { cf, cb } (hay { mf, mb }), hoặc {} khi
 * đường không có thẻ theo chiều nào cho loại xe này. Mỗi chiều lấy khoá có mặt đầu tiên trong thứ tự
 * maxspeed:<xe>:<chiều> → maxspeed:<xe> → maxspeed:<chiều> → maxspeed (giống dimsFor của signs.js, thẻ riêng của loại
 * xe đứng trước). Khoá có mặt mà không đọc được (none, signals…) thì chiều đó là null: không biết, không đoán tiếp.
 */
function directionalSpeeds(tags, vehicle, prefix) {
  if (!SPEED_DIRS.some(([d]) => tags[`maxspeed:${vehicle}:${d}`] != null || tags[`maxspeed:${d}`] != null)) return {};
  const out = {};
  for (const [d, s] of SPEED_DIRS) {
    let v = null;
    for (const k of [`maxspeed:${vehicle}:${d}`, `maxspeed:${vehicle}`, `maxspeed:${d}`, 'maxspeed']) {
      if (tags[k] == null) continue;
      v = parseMaxspeed(tags[k]);
      break;
    }
    out[prefix + s] = v;
  }
  return out;
}

/**
 * Chiều một chiều của đường với loại xe này ('car' | 'moto'): 1 chỉ được đi theo chiều vẽ, −1 chỉ được đi ngược
 * chiều vẽ, 0 đi được hai chiều. Xe máy dùng om khi đường có thẻ riêng cho xe máy.
 */
export const onewayFor = (way, vehicle) => (vehicle === 'moto' && way.om != null ? way.om : way.o);

const MAX_VIA_WAYS = 4; // cấm rẽ qua nhiều đoạn đường hơn chừng này: bỏ (hiếm, dễ ghép sai)

/** Khoá hai đầu mút của một đường đã đọc (parseWay). */
function endKeys(way) {
  const g = way.g;
  return [vkey(g[0], g[1]), vkey(g[g.length - 2], g[g.length - 1])];
}

/**
 * Ghép chuỗi from → các đường "via" → to của một quan hệ cấm rẽ qua đường (cấm quay đầu qua dải phân cách…).
 * Theo quy ước OSM mỗi đường phải bắt đầu hoặc kết thúc ở đường kế tiếp, nên chỉ ghép qua đầu mút: bắt đầu ở đầu mút
 * của from chạm một đường via, đi hết các đường via (mỗi bước đúng một đường chạm đầu mút hiện tại, thứ tự thành viên
 * không quan trọng), rồi to phải bắt đầu hoặc kết thúc ở đó. Chiều đi suy ra từ chuỗi phải hợp với đường một chiều:
 * đi trên from về phía chỗ nối, đi qua từng đường via và đi vào to đều không được ngược chiều (không thì quan hệ thuộc
 * về chiều đường bên kia, hoặc bị vẽ sai). Thiếu đường nào trong ô, chuỗi đứt, hay ghép được theo hai cách: null.
 * Trả về toạ độ chỗ from gặp đường via đầu tiên: nơi đặt biển.
 */
function chainVia(from, vias, to) {
  if (!from || !to || !vias.length || vias.some((w) => !w)) return null;
  const [fa, fb] = endKeys(from);
  const [ta, tb] = endKeys(to);
  if (fa === fb || ta === tb) return null;
  const found = [];
  for (const start of [fa, fb]) {
    // Đi trên from về phía start: start là đỉnh cuối thì xuôi chiều vẽ (+1), đỉnh đầu thì ngược chiều vẽ (−1).
    const fromDir = start === fb ? 1 : -1;
    if (from.o !== 0 && from.o !== fromDir) continue;
    let cur = start;
    let ok = true;
    const left = [...vias];
    while (left.length) {
      const next = [];
      left.forEach((w, k) => {
        if (endKeys(w).includes(cur)) next.push(k);
      });
      if (next.length !== 1) {
        ok = false;
        break;
      }
      const w = left.splice(next[0], 1)[0];
      const [a, b] = endKeys(w);
      const dir = cur === a ? 1 : -1;
      if (a === b || (w.o !== 0 && w.o !== dir)) {
        ok = false;
        break;
      }
      cur = dir > 0 ? b : a;
    }
    if (!ok || (cur !== ta && cur !== tb)) continue;
    const toDir = cur === ta ? 1 : -1;
    if (to.o !== 0 && to.o !== toDir) continue;
    found.push(start === fa ? [from.g[0], from.g[1]] : [from.g[from.g.length - 2], from.g[from.g.length - 1]]);
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Quan hệ cấm rẽ: đúng một đường "from", một đường "to", và "via" là một NÚT biết toạ độ hoặc một đến bốn ĐƯỜNG có
 * trong ô (ghép được bằng chainVia). Với "via" là đường, toạ độ "via" là chỗ from gặp đường via đầu tiên (biển đặt ở
 * đó) và viaWays là id các đường via. wayById: id → đường đã đọc của cùng phản hồi.
 */
function parseRestriction(el, coordOf, wayById) {
  const from = [];
  const to = [];
  const via = [];
  for (const m of el.members || []) {
    if (m.role === 'from') from.push(m);
    else if (m.role === 'to') to.push(m);
    else if (m.role === 'via') via.push(m);
  }
  if (from.length !== 1 || to.length !== 1 || !via.length) return null;
  if (from[0].type !== 'way' || to[0].type !== 'way') return null;
  const tags = pickTags(el.tags || {}, keepRestrTag, MAX_RESTR_TAG_LEN) || {};
  const base = { id: `r${el.id}`, from: from[0].ref, to: to[0].ref };
  if (via.length === 1 && via[0].type === 'node') {
    const coord = coordOf(via[0].ref);
    return coord ? { ...base, via: coord, tags } : null;
  }
  if (via.length > MAX_VIA_WAYS || via.some((m) => m.type !== 'way')) return null;
  const at = chainVia(wayById.get(from[0].ref), via.map((m) => wayById.get(m.ref)), wayById.get(to[0].ref));
  return at ? { ...base, via: at, viaWays: via.map((m) => m.ref), tags } : null;
}

/**
 * Hướng vẽ (độ) của đường tại đỉnh có khoá key, khi đỉnh đó thuộc đúng một đường, hoặc mọi đường chứa nó cho cùng
 * một hướng (lệch không quá 30°, ví dụ chỗ nối hai đoạn của cùng một con đường vẽ cùng chiều). Không thì null: không
 * biết forward/backward là chiều nào.
 */
function drawnBearingAt(key, vertexIndex, ways) {
  const list = vertexIndex.get(key);
  if (!list) return null;
  let first = null;
  for (let k = 0; k < list.length; k += 2) {
    const g = ways[list[k]].g;
    const i = list[k + 1];
    const n = g.length / 2;
    const a = i > 0 ? i - 1 : i;
    const b = i < n - 1 ? i + 1 : i;
    if (a === b) return null;
    const brg = bearing([g[2 * a], g[2 * a + 1]], [g[2 * b], g[2 * b + 1]]);
    if (first == null) first = brg;
    else if (Math.abs(angleDiff(first, brg)) > 30) return null;
  }
  return first;
}

/**
 * Hướng ghi trên camera: speed_camera đọc direction rồi camera:direction, camera giám sát ngược lại. Giữ giá trị thô
 * (bộ cảnh báo đọc bằng parseDirection), và với forward/backward thì kèm hướng vẽ của đường tại nút (wb) nếu biết.
 */
function cameraDirection(tags, key, vertexIndex, ways) {
  const keys = tags.highway === 'speed_camera' ? ['direction', 'camera:direction'] : ['camera:direction', 'direction'];
  for (const k of keys) {
    const v = tags[k] == null ? '' : String(tags[k]).trim();
    if (!v) continue;
    const out = { dir: v.slice(0, 40) };
    if (/^(forward|backward|reverse)$/i.test(v)) {
      const wb = drawnBearingAt(key, vertexIndex, ways);
      if (wb != null) out.wb = Math.round(wb * 10) / 10;
    }
    return out;
  }
  return {};
}

/** Tâm (trung bình các đỉnh) của hình học Overpass [{ lat, lon }], hoặc null. */
function centroid(geometry) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const p of geometry || []) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    x += p.lon;
    y += p.lat;
    n++;
  }
  return n ? [x / n, y / n] : null;
}

const isCoord = (m) => Number.isFinite(m?.lat) && Number.isFinite(m?.lon);

/**
 * Điểm camera của một quan hệ enforcement (out body geom): mỗi thành viên "device" là một điểm, nút thì lấy toạ độ
 * nút, đường thì lấy tâm. Có nút "from" (chỗ bắt đầu đoạn kiểm soát) thì điểm cảnh báo đặt ở đó. average_speed là đoạn
 * đo tốc độ trung bình (avg); maxweight/maxheight là điểm kiểm soát tải trọng/chiều cao (enf), không phải camera tốc độ.
 */
function enforcementPoints(el, tags, add) {
  const enf = String(tags.enforcement ?? '').trim();
  const sub = enf === 'maxspeed' || enf === 'average_speed' ? 'speed' : enf === 'traffic_signals' ? 'redlight' : 'traffic';
  const extra = enf === 'average_speed' ? { avg: true } : enf === 'maxweight' ? { enf: 'weight' } : enf === 'maxheight' ? { enf: 'height' } : {};
  const members = Array.isArray(el.members) ? el.members : [];
  const from = members.find((m) => m.role === 'from' && m.type === 'node' && isCoord(m));
  const limit = parseMaxspeed(tags.maxspeed);
  for (const mem of members) {
    if (mem.role !== 'device') continue;
    let coord = null;
    if (mem.type === 'node' && isCoord(mem)) coord = [mem.lon, mem.lat];
    else if (mem.type === 'way') coord = centroid(mem.geometry);
    if (!coord) continue;
    add({
      id: `${mem.type === 'way' ? 'w' : 'n'}${mem.ref}`,
      kind: 'camera',
      sub,
      limit,
      coord: from ? [from.lon, from.lat] : coord,
      fromRelation: true,
      ...extra,
    });
  }
}

/** Chuyển phản hồi Overpass thành { ways, points, feats, restr, base } gọn nhẹ. */
export function parseOverpass(json) {
  const elements = json?.elements || [];
  const ways = [];
  const wayById = new Map();
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const way = parseWay(el);
    if (!way) continue;
    ways.push(way);
    if (!wayById.has(way.id)) wayById.set(way.id, way);
  }
  const vertexIndex = buildVertexIndex(ways);

  const byId = new Map();
  const add = (p) => {
    const old = byId.get(p.id);
    // Thông tin từ quan hệ "enforcement" chi tiết hơn thẻ trên nút nên được ưu tiên (trừ giới hạn tốc độ quan hệ
    // không ghi: giữ của nút).
    if (!old) byId.set(p.id, p);
    else if (p.fromRelation) byId.set(p.id, { ...old, ...p, limit: p.limit ?? old.limit ?? null });
  };
  const nodeCoord = new Map(); // mọi nút được in ra, kể cả bản "out skel" không có thẻ
  const feats = new Map();
  const restrEls = [];

  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      const coord = [el.lon, el.lat];
      const id = `n${el.id}`;
      const key = vkey(el.lon, el.lat);
      nodeCoord.set(el.id, coord);
      if (tags.highway === 'speed_camera') {
        const dir = cameraDirection(tags, key, vertexIndex, ways);
        add({ id, kind: 'camera', sub: 'speed', limit: parseMaxspeed(tags.maxspeed), coord, ...dir });
      } else if (isTrafficCamera(tags)) {
        add({ id, kind: 'camera', sub: 'traffic', limit: null, coord, ...cameraDirection(tags, key, vertexIndex, ways) });
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
          onWay: vertexIndex.has(key),
          tags: pickTags(tags, keepFeatTag, MAX_TAG_LEN) || {},
        });
      }
    } else if (el.type === 'way' && tags.barrier === 'toll_booth' && el.center) {
      // Trạm thu phí vẽ thành vùng/đường (.tw out center): dùng tâm, gộp với các nút trạm thu phí gần đó (120 m).
      const { lat, lon } = el.center;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        add({ id: `w${el.id}`, kind: 'toll', sub: '', limit: null, coord: [lon, lat], name: tags.name || '' });
      }
    } else if (el.type === 'relation' && tags.type === 'enforcement') {
      enforcementPoints(el, tags, add);
    } else if (el.type === 'relation' && tags.type === 'restriction') {
      restrEls.push(el);
    }
  }

  // Toạ độ nút "via" lấy từ nhóm ".via out skel" (hoặc nhóm điểm, nếu nút có thẻ).
  const restr = [];
  for (const el of restrEls) {
    const r = parseRestriction(el, (ref) => nodeCoord.get(ref), wayById);
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

/**
 * Ô trong bộ nhớ cần tải lại chưa: 'stale' (bản ghi kiểu cũ hoặc quá 7 ngày: tải lại như trước), 'aging' (đúng phiên
 * bản, quá REFRESH_AGE: làm mới ngầm) hoặc null (còn mới). Đồng hồ máy bị chỉnh lùi (t ở tương lai) thì coi như vừa tải
 * quá hạn làm mới, để không giữ mãi một bản ghi không bao giờ "đủ cũ".
 */
function refreshDue(rec, now) {
  if (rec.v !== CACHE_VERSION) return 'stale';
  const age = now - rec.t;
  if (age >= TTL) return 'stale';
  if (age >= REFRESH_AGE || age < 0) return 'aging';
  return null;
}

/**
 * Bản tải lại có được thay vào ô đang có không. Không nhận khi: ô đang có đường mà bản mới không có đường nào (máy chủ
 * trả thiếu, không thể cả ô mất hết đường), hoặc cùng phiên bản bộ đệm mà mốc dữ liệu OSM cũ hơn bản đang có (các máy
 * chủ Overpass cập nhật lệch nhau, có máy chậm vài giờ: không để dữ liệu "lùi" về trước chỗ sửa đã thấy).
 */
function acceptRefresh(prev, data) {
  if (prev.ways.length > 0 && data.ways.length === 0) return false;
  if (prev.v === CACHE_VERSION && prev.base && data.base && data.base < prev.base) return false;
  return true;
}

/** Mặc định: navigator.onLine (false chắc chắn là mất mạng; true chưa chắc có mạng, nên chỉ dùng để bỏ qua). */
const defaultOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Thứ tự ô khi tra cứu: ô đúng phiên bản bộ đệm trước, rồi tới ô tải gần đây hơn (cùng mức thì giữ thứ tự cũ). */
const fresher = (a, b) => (a.v === CACHE_VERSION ? 0 : 1) - (b.v === CACHE_VERSION ? 0 : 1) || b.t - a.t;

export class RoadData {
  // Các ô quanh từng ô (khoá ô → các ô đã xếp theo fresher); tính lại mỗi khi dữ liệu các ô thay đổi.
  #near = new Map();

  /**
   * @param fetchImpl  thay cho fetch (kiểm thử)
   * @param cache      { get(key) → Promise<bản ghi|null>, put(bản ghi) } thay cho IndexedDB (kiểm thử)
   * @param online     () → false khi chắc chắn mất mạng (mặc định navigator.onLine): khi đó không làm mới ô đã có
   */
  constructor({ fetchImpl, cache, online } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.cache = cache || IDB_CACHE;
    this.online = online || defaultOnline;
    this.cells = new Map(); // key → { ways, points, feats, restr, base, v, t, grid, vertices, featGrid, restrFrom, used }
    this.reading = new Map(); // ô đang đọc từ bộ đệm trên máy
    this.cacheChecked = new Set(); // ô đã đọc bộ đệm xong (kể cả khi không có bản ghi)
    this.pending = new Map(); // ô đang tải từ Overpass (tối đa hai)
    this.failedAt = new Map();
    this.refreshing = null; // khoá ô đang được làm mới (ô đã có dữ liệu), nhiều nhất một ô
    this.refreshDone = -Infinity; // lúc lượt làm mới gần nhất xong (Date.now), cho REFRESH_GAP
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
    this.#near.clear();
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
        const prev = this.cells.get(key);
        if (prev && !acceptRefresh(prev, data)) throw new Error('older or empty'); // thử máy chủ khác, giữ bản đang có
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
    const now = Date.now();
    let due = null;
    if (cell) {
      cell.used = now;
      due = refreshDue(cell, now);
      if (!due) return;
      // Dữ liệu đang có (dù cũ bao lâu) vẫn được dùng trong lúc chờ tải lại; tải xong thì thay vào ngay (setCell).
    } else if (!this.cacheChecked.has(key)) {
      // Đọc bộ đệm trên máy trước: chỉ mất vài mili giây nên không tính vào giới hạn truy vấn Overpass.
      if (!this.reading.has(key) && !this.pending.has(key)) {
        if (this.status !== 'ready') this.status = 'loading';
        const job = this.#readCell(key, cx, cy).finally(() => this.reading.delete(key));
        this.reading.set(key, job);
      }
      return;
    }
    if (this.pending.has(key)) return; // ô này đang tải: không gửi thêm truy vấn
    const failed = this.failedAt.get(key);
    if (failed != null && now >= failed && now - failed < (due === 'aging' ? REFRESH_RETRY : RETRY_AFTER)) return;
    // Overpass giới hạn số truy vấn đồng thời: tối đa hai. Ô đã có dữ liệu (dù cũ) chỉ được tải lại khi
    // không còn lượt tải nào khác, để ô chưa có dữ liệu luôn còn chỗ.
    if (this.pending.size >= (cell ? 1 : 2)) return;
    if (cell) {
      // Làm mới ô đã có dữ liệu: chỉ khi có mạng (mất mạng thì cứ dùng bản đang có, không thử vô ích), và nghỉ
      // REFRESH_GAP sau lượt làm mới trước. Chỉ các ô ensureAround xin (quanh xe, ô sắp đi tới) mới được làm mới.
      let online = true;
      try {
        online = this.online() !== false;
      } catch {
        online = true;
      }
      if (!online) return;
      if (now - this.refreshDone < REFRESH_GAP && now >= this.refreshDone) return;
      this.refreshing = key;
    }
    if (this.status !== 'ready') this.status = 'loading';
    const job = this.#fetchCell(cx, cy).finally(() => {
      this.pending.delete(key);
      if (this.refreshing === key) {
        this.refreshing = null;
        this.refreshDone = Date.now();
      }
    });
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

  /**
   * Ô chứa vị trí và 8 ô quanh nó, ô mới hơn đứng trước (fresher). Một đường cắt qua mép ô có mặt trong mọi ô nó
   * chạm tới, mỗi bản đủ cả hình học (Overpass in toàn bộ đường dù có khung [bbox]), nhưng các ô được tải vào
   * những lúc khác nhau: bản ở ô tải sau có thể có thêm thẻ (om của bản ghi phiên bản 3) hay thêm đỉnh (dữ liệu OSM
   * đã sửa). Ô mới hơn đứng trước để các phép tra cứu lấy bản đầu tiên gặp được là bản mới nhất.
   */
  #neighbours(coord) {
    const [cx, cy] = cellOf(coord);
    const key = cellKey(cx, cy);
    let out = this.#near.get(key);
    if (out) return out;
    out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(cellKey(cx + dx, cy + dy));
        if (cell) out.push(cell);
      }
    }
    out.sort(fresher);
    this.#near.set(key, out);
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
   * Một đường có mặt ở nhiều ô chỉ lấy một bản: bản của ô mới nhất có đỉnh này, kèm mọi chỉ số đỉnh này có trong
   * chính bản đó. Không trộn hai bản: hai bản tải vào hai lúc có thể lệch chỉ số đỉnh (OSM đã thêm một nút vào
   * đường), trộn lại thì một đỉnh giữa phố bị đếm thành nút giao bốn nhánh. Đường khép kín (vòng xuyến vẽ thành
   * một vòng) có điểm đầu trùng điểm cuối, hay đường hình chữ P có điểm cuối trùng một đỉnh giữa, thì trả về cả
   * hai chỉ số để bên gọi biết có thể đi theo cả hai phía.
   */
  waysAtVertex(coord) {
    const key = vertexKey(coord);
    const owner = new Map(); // id đường → ô có bản được dùng
    const seen = new Set();
    const out = [];
    for (const cell of this.#neighbours(coord)) {
      const list = cell.vertices.get(key);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const way = cell.ways[list[k]];
        const from = owner.get(way.id);
        if (from && from !== cell) continue; // bản cũ hơn ở ô khác
        owner.set(way.id, cell);
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

  /**
   * Các đường có ít nhất một đoạn trong hình vuông cạnh 2 × radius (m) quanh vị trí (để vẽ bản đồ trên màn hình ô tô,
   * js/carbridge.js). Một đường có mặt ở nhiều ô chỉ lấy bản của ô mới nhất. radius tối đa 2 km.
   */
  waysNear(coord, radius) {
    const r = Math.min(2000, Math.max(0, radius));
    const dLat = r / 110000;
    const dLon = dLat / Math.max(0.05, Math.cos((coord[1] * Math.PI) / 180));
    const x0 = Math.floor((coord[0] - dLon) / GRID);
    const x1 = Math.floor((coord[0] + dLon) / GRID);
    const y0 = Math.floor((coord[1] - dLat) / GRID);
    const y1 = Math.floor((coord[1] + dLat) / GRID);
    const owner = new Map(); // id đường → ô có bản được dùng
    const out = [];
    for (const cell of this.#neighbours(coord)) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const bucket = cell.grid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b += 2) {
            const way = cell.ways[bucket[b]];
            if (owner.has(way.id)) continue;
            owner.set(way.id, cell);
            out.push(way);
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

  /**
   * Độ mới của dữ liệu ô chứa vị trí này, hoặc null khi chưa có: { t: lúc tải về máy (ms, 0 nếu không rõ), base: mốc
   * dữ liệu OSM của Overpass (chuỗi ISO) hoặc null, loading: đang tải bản mới cho ô này }.
   */
  freshness(coord) {
    const key = cellKey(...cellOf(coord));
    const cell = this.cells.get(key);
    if (!cell) return null;
    return { t: cell.t || 0, base: cell.base, loading: this.pending.has(key) };
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
   * @param hintName  tên đường đang đi theo chỉ dẫn (được ưu tiên)
   * @param opts      { vehicle: 'car'|'moto' (chiều một chiều theo loại xe, mặc định ô tô),
   *                    prefer: tập id đường được ưu tiên (có .has), only: chỉ xét các id đường này (có .has),
   *                    skip: bỏ qua các id đường này (có .has),
   *                    heading, within, among: khi xe đi quá chậm để tự lọc theo hướng, bỏ các đoạn của các đường
   *                    among (có .has; mặc định mọi đường) lệch quá within độ so với hướng heading (theo chiều
   *                    được đi). Chỉ để loại đường, không suy ra dir. }
   */
  matchWay(fix, hintName = '', { vehicle = 'car', prefer = null, only = null, heading = null, within = 180, among = null, skip = null } = {}) {
    const { coord } = fix;
    const moving = fix.heading != null && (fix.speed || 0) > 2.5;
    const loose = !moving && Number.isFinite(heading);
    const maxDist = Math.max(30, Math.min(60, fix.accuracy || 0));
    const gx = Math.floor(coord[0] / GRID);
    const gy = Math.floor(coord[1] / GRID);
    let best = null;
    // Một đường có mặt ở nhiều ô: chỉ xét bản của ô mới nhất có đoạn khớp được ở đây (các ô xếp mới trước), để
    // bản cũ (thiếu om, thiếu đỉnh mới) không thắng nhờ bằng điểm hay hơn kém vài phân. Bản mới không có đoạn nào
    // khớp được ở đây thì bản cũ vẫn dùng được, nên không đường nào bị mất.
    const owner = new Map();

    for (const cell of this.#neighbours(coord)) {
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          const bucket = cell.grid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b += 2) {
            const way = cell.ways[bucket[b]];
            if (only && !only.has(way.id)) continue;
            if (skip && skip.has(way.id)) continue;
            const i = bucket[b + 1];
            const a = [way.g[i], way.g[i + 1]];
            const c = [way.g[i + 2], way.g[i + 3]];
            const pr = projectOnSegment(coord, a, c);
            if (pr.dist > maxDist) continue;
            let score = pr.dist;
            let dir = 0;
            if (moving) {
              const raw = Math.abs(angleDiff(bearing(a, c), fix.heading));
              const o = onewayFor(way, vehicle);
              let diff = raw;
              if (o === -1) diff = 180 - raw;
              else if (o === 0) diff = Math.min(raw, 180 - raw);
              if (diff > 50) continue; // đường cắt ngang hoặc ngược chiều
              score += diff * 0.6;
              dir = raw <= 90 ? 1 : -1;
            } else if (loose && (!among || among.has(way.id))) {
              const raw = Math.abs(angleDiff(bearing(a, c), heading));
              const o = onewayFor(way, vehicle);
              const diff = o === -1 ? 180 - raw : o === 0 ? Math.min(raw, 180 - raw) : raw;
              if (diff > within) continue;
            }
            const from = owner.get(way.id);
            if (from && from !== cell) continue;
            owner.set(way.id, cell);
            if (hintName && way.n === hintName) score -= 15;
            if (prefer && prefer.has(way.id)) score -= PREFER_BONUS;
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

const two = (n) => String(n).padStart(2, '0');

/**
 * Câu cho phần cài đặt từ RoadData.freshness(): "Dữ liệu đường quanh đây cập nhật lúc 14:05 hôm nay." (giờ của máy).
 * now: Date (kiểm thử).
 */
export function freshnessText(info, now = new Date()) {
  if (!info) return 'Chưa có dữ liệu đường quanh đây. Dữ liệu sẽ được tải khi có mạng.';
  const parts = [];
  const t = Number.isFinite(info.t) && info.t > 0 ? new Date(info.t) : null;
  if (!t) parts.push('Dữ liệu đường quanh đây là bản đã lưu từ trước.');
  else {
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((dayStart(now) - dayStart(t)) / 864e5);
    const when =
      days === 0
        ? 'hôm nay'
        : days === 1
          ? 'hôm qua'
          : `ngày ${t.getDate()}/${t.getMonth() + 1}/${t.getFullYear()}`;
    parts.push(`Dữ liệu đường quanh đây cập nhật lúc ${two(t.getHours())}:${two(t.getMinutes())} ${when}.`);
  }
  if (info.loading) parts.push('Đang tải bản mới hơn.');
  parts.push(`Khi có mạng, dữ liệu tự làm mới sau mỗi ${Math.round(REFRESH_AGE / 3600e3)} giờ.`);
  return parts.join(' ');
}
