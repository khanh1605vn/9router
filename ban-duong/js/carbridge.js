// Cầu nối với ứng dụng Android "Bạn Đường" (màn hình Android Auto). Chỉ chạy khi trang nằm trong WebView của ứng dụng
// đó: ứng dụng gắn sẵn đối tượng window.BanDuongNative (WebViewCompat.addWebMessageListener, chỉ cho đúng nguồn gốc
// https://appassets.androidplatform.net). Trên trình duyệt thường không có đối tượng này: createCarBridge() trả null
// và main.js không làm gì thêm.
//
// Hợp đồng (phiên bản 1): trang gửi "hello" và "state" (ảnh chụp trạng thái lái, mục 3.3), máy trả "native" và
// "carConnected" qua sự kiện 'banduong:native' của window. Máy kiểm tra lại mọi giới hạn; ở đây cũng tự giới hạn đúng
// như vậy để thông điệp không bao giờ bị bỏ vì quá dài hay sai kiểu. Thuần logic, không đụng tới DOM.

import { distance } from './geo.js';

export const BRIDGE_V = 1;
export const NATIVE_EVENT = 'banduong:native';

// Trùng với BridgeLimits phía Android. Đổi một bên phải đổi bên kia.
export const LIMITS = Object.freeze({
  messageChars: 131072, // độ dài tối đa của một thông điệp (ký tự UTF-16)
  textChars: 120, // chữ trên màn hình xe, sau khi làm sạch
  rawTextChars: 960, // chuỗi gốc dài hơn chừng này bị coi là sai
  alerts: 3,
  routePoints: 400,
  roads: 60,
  roadPoints: 400, // mỗi đường
  roadPointsTotal: 2000,
  speedMax: 400,
  limitMin: 5,
  limitMax: 200,
  accuracyMax: 10000,
  alertDistanceMax: 100000,
  maneuverDistanceMax: 1000000,
  exitMax: 20,
  tripDurationMax: 604800, // giây (7 ngày): thời gian còn lại của chuyến
});

// Nhịp gửi "state": đang chiếu lên xe thì tối đa 4 lần/giây (máy cho phép 4/giây), chỉ khi có thay đổi, và ít nhất
// mỗi 2 giây một lần dù không đổi (máy coi dữ liệu là cũ sau 5 giây, CarStateStore.STALE_MS). Nhịp giữ này có hẹn giờ
// riêng, không phụ thuộc việc main.js gọi publish() đều đặn. Chưa chiếu lên xe thì gửi thưa.
export const SEND_INTERVAL_MS = 250;
export const KEEPALIVE_MS = 2000;
export const IDLE_INTERVAL_MS = 5000;
export const HELLO_RETRY_MS = 3000;
export const HELLO_TRIES = 5;

// Tốc độ trên đồng hồ cũ hơn chừng này (ms) thì màn hình xe ghi "chưa có" (như SPEED_STALE_MS trong main.js).
export const SPEED_STALE_MS = 5000;
// Cửa sổ tuyến gửi lên xe: chừng này mét sau lưng và phía trước vị trí trên tuyến.
export const ROUTE_BEHIND_M = 100;
export const ROUTE_AHEAD_M = 3000;
// Đường quanh xe để vẽ bản đồ trên màn hình xe.
export const ROADS_RADIUS_M = 500;
export const ROADS_MOVE_M = 30; // dời xa hơn chừng này (m) thì tính lại
export const ROADS_REFRESH_MS = 10000; // hoặc cứ chừng này (ms) tính lại một lần (dữ liệu đường mới tải về)

const ALERT_KINDS = new Set(['camera', 'toll', 'rail', 'sign', 'report', 'speed', 'other']);
const ICONS = new Set([
  'depart', 'straight', 'slight-left', 'left', 'sharp-left', 'slight-right', 'right', 'sharp-right',
  'uturn', 'roundabout', 'ferry', 'arrive',
]);
// Như DRIVABLE trong js/roaddata.js.
const HIGHWAYS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
const CAMERA_STATES = new Set(['off', 'starting', 'running', 'paused', 'error']);
const OBD_STATES = new Set(['off', 'connecting', 'connected', 'error']);
const CODE_RE = /^[A-Za-z0-9._:-]{1,32}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, digits) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

// ---------------------------------------------------------------------------------------------
// Kiểm tra và giới hạn từng trường (giống BridgeMessageParser phía Android)
// ---------------------------------------------------------------------------------------------

/** Số hữu hạn trong [min, max] (sau khi làm tròn digits chữ số thập phân, nếu có), không thì null. */
export function boundNumber(v, min, max, digits = null) {
  if (!isNum(v)) return null;
  const n = digits == null ? v : round(v, digits);
  return n >= min && n <= max ? n : null;
}

// Ký tự điều khiển C0/C1, ký tự đổi hướng chữ, ký tự độ rộng 0.
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const SPACE_RE = /[\t\n\v\f\r]/g;

/**
 * Làm sạch chữ hiện trên màn hình xe: tab/xuống dòng thành dấu cách, bỏ ký tự điều khiển, đổi hướng và độ rộng 0,
 * gộp khoảng trắng, cắt còn LIMITS.textChars ký tự UTF-16 (không cắt đôi cặp surrogate). Rỗng hoặc chuỗi gốc quá dài
 * (hơn LIMITS.rawTextChars) → null.
 */
export function cleanText(s) {
  if (typeof s !== 'string' || s.length > LIMITS.rawTextChars) return null;
  let t = s.replace(SPACE_RE, ' ').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  if (t.length > LIMITS.textChars) {
    let end = LIMITS.textChars;
    const c = t.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--; // nửa đầu của cặp surrogate: bỏ luôn
    t = t.slice(0, end).trimEnd();
  }
  return t || null;
}

/** Toạ độ [lon, lat] của ứng dụng → điểm [lat, lon] của hợp đồng (làm tròn 6 chữ số), sai → null. */
export function toPoint(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lat = boundNumber(coord[1], -90, 90, 6);
  const lon = boundNumber(coord[0], -180, 180, 6);
  return lat == null || lon == null ? null : [lat, lon];
}

/** Điểm [lat, lon] đúng dạng hợp đồng (đã đổi chiều), sai → null. */
function cleanPoint(p) {
  if (!Array.isArray(p) || p.length !== 2) return null;
  const lat = boundNumber(p[0], -90, 90, 6);
  const lon = boundNumber(p[1], -180, 180, 6);
  return lat == null || lon == null ? null : [lat, lon];
}

/** Bớt điểm của đường gấp khúc còn tối đa max điểm, cách đều theo chỉ số, luôn giữ điểm đầu và điểm cuối. */
export function thinPoints(points, max) {
  if (points.length <= max) return points;
  if (max < 2) return points.slice(0, Math.max(0, max));
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Danh sách điểm hợp lệ (điểm sai bị bỏ riêng), tối đa max điểm. */
function cleanPoints(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    const q = cleanPoint(p);
    if (q) out.push(q);
  }
  return thinPoints(out, max);
}

function cleanAlert(a) {
  if (!a || typeof a !== 'object') return null;
  const text = cleanText(a.text);
  const d = isNum(a.distance) ? Math.round(a.distance) : null;
  if (!text || d == null || d < 0 || d > LIMITS.alertDistanceMax) return null;
  return {
    kind: ALERT_KINDS.has(a.kind) ? a.kind : 'other',
    code: typeof a.code === 'string' && CODE_RE.test(a.code) ? a.code : null,
    text,
    distance: d,
    source: a.source === 'camera' ? 'camera' : 'osm',
    id: typeof a.id === 'string' && CODE_RE.test(a.id) ? a.id : null,
  };
}

function cleanManeuver(m) {
  if (!m || typeof m !== 'object') return null;
  const text = cleanText(m.text);
  const d = boundNumber(m.distance, 0, LIMITS.maneuverDistanceMax, 0);
  if (!text || d == null) return null;
  const exit = boundNumber(m.exit, 0, LIMITS.exitMax, 0);
  return {
    text,
    distance: d,
    icon: ICONS.has(m.icon) ? m.icon : null,
    exit,
    tripDistance: boundNumber(m.tripDistance, 0, LIMITS.maneuverDistanceMax, 0),
    tripDuration: boundNumber(m.tripDuration, 0, LIMITS.tripDurationMax, 0),
  };
}

function cleanPosition(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = boundNumber(p.lat, -90, 90, 6);
  const lon = boundNumber(p.lon, -180, 180, 6);
  if (lat == null || lon == null) return null;
  return {
    lat,
    lon,
    heading: boundNumber(p.heading, 0, 360, 1),
    accuracy: boundNumber(p.accuracy, 0, LIMITS.accuracyMax, 0),
    ts: isNum(p.ts) && p.ts > 0 ? Math.round(p.ts) : null,
  };
}

function cleanRoads(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let budget = LIMITS.roadPointsTotal;
  for (const r of list) {
    if (out.length >= LIMITS.roads || budget < 2) break;
    if (!r || typeof r !== 'object') continue;
    const points = cleanPoints(r.points, Math.min(LIMITS.roadPoints, budget));
    if (points.length < 2) continue;
    budget -= points.length;
    out.push({ highway: HIGHWAYS.has(r.highway) ? r.highway : 'other', points });
  }
  return out;
}

/**
 * Phần thân của thông điệp "state" (mọi trường trừ v, type, ts), mỗi trường đã được kiểm tra và giới hạn đúng hợp
 * đồng: sai kiểu hay ngoài khoảng thành null/mặc định, danh sách quá dài bị cắt.
 */
export function boundState(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const speed = boundNumber(r.speed, 0, LIMITS.speedMax, 1);
  const alerts = [];
  if (Array.isArray(r.alerts)) {
    for (const a of r.alerts) {
      const c = cleanAlert(a);
      if (c) alerts.push(c);
      if (alerts.length === LIMITS.alerts) break;
    }
  }
  return {
    speed,
    speedSource: speed != null && (r.speedSource === 'gps' || r.speedSource === 'obd') ? r.speedSource : null,
    limit: boundNumber(isNum(r.limit) ? Math.round(r.limit) : null, LIMITS.limitMin, LIMITS.limitMax),
    overSpeed: r.overSpeed === true,
    position: cleanPosition(r.position),
    alerts,
    maneuver: cleanManeuver(r.maneuver),
    route: cleanPoints(r.route, LIMITS.routePoints),
    nearbyRoads: cleanRoads(r.nearbyRoads),
    camera: CAMERA_STATES.has(r.camera) ? r.camera : 'off',
    obd: OBD_STATES.has(r.obd) ? r.obd : 'off',
  };
}

/**
 * Chuỗi JSON của thông điệp "state" từ phần thân đã giới hạn (boundState). Nếu vẫn dài quá LIMITS.messageChars (không
 * xảy ra với các hạn mức trên, chỉ phòng xa) thì bớt dần đường quanh xe rồi tới tuyến.
 * @returns { json, key } key: phần thân, để so xem trạng thái có đổi không (không tính ts)
 */
export function encodeState(body, ts) {
  let b = body;
  for (;;) {
    const key = JSON.stringify(b);
    // Ghép v, type, ts vào trước phần thân (đã là một đối tượng JSON không rỗng) để không phải stringify lại.
    const json = `{"v":${BRIDGE_V},"type":"state","ts":${Math.round(ts)},${key.slice(1)}`;
    if (json.length <= LIMITS.messageChars) return { json, key };
    if (b.nearbyRoads.length) b = { ...b, nearbyRoads: b.nearbyRoads.slice(0, Math.floor(b.nearbyRoads.length / 2)) };
    else if (b.route.length) b = { ...b, route: b.route.slice(0, Math.floor(b.route.length / 2)) };
    else return { json: null, key };
  }
}

// ---------------------------------------------------------------------------------------------
// Từ trạng thái của ứng dụng sang dữ liệu của hợp đồng
// ---------------------------------------------------------------------------------------------

const CAMERA_SUFFIX = ' (camera ghi nhận)';
const QUIET_SUFFIX = ' (camera ghi nhận, chưa xác nhận)';
const IMPORT_QUIET_SUFFIX = ' (nhập từ tệp, chưa xác nhận)';

/** Chữ của một biển trên màn hình xe: tên biển, biển do camera ghi nhận (hoặc nhập từ tệp) có lời rào như lời đọc. */
export function signText(item) {
  const title = typeof item?.title === 'string' ? item.title : '';
  if (!title || !item.src || title.includes('(camera ghi nhận')) return title;
  if (!item.quiet) return `${title}${CAMERA_SUFFIX}`;
  return `${title}${item.src === 'import' ? IMPORT_QUIET_SUFFIX : QUIET_SUFFIX}`;
}

/**
 * Vị trí cho màn hình xe từ lần định vị đang hiện (đã bám tuyến nếu đang dẫn đường): coord [lon, lat] → lat, lon;
 * hướng đi đưa về 0 … 360 độ; ts: lúc trang nhận lần định vị đó (ms, đồng hồ máy), để máy biết vị trí đã cũ khi trang
 * thôi nhận định vị (ví dụ trang bị ẩn) dù vẫn gửi "state" đều.
 */
export function positionFrom(fix, accuracy = fix?.accuracy, ts = fix?.time) {
  const c = fix?.coord;
  if (!Array.isArray(c) || c.length < 2) return null;
  const heading = isNum(fix.heading) ? ((fix.heading % 360) + 360) % 360 : null;
  return { lat: c[1], lon: c[0], heading, accuracy: isNum(accuracy) ? accuracy : null, ts: isNum(ts) ? ts : null };
}

/** Mã của một điểm cảnh báo (camera, trạm thu phí, đường sắt, điểm tự đánh dấu) theo kiểu thẻ OSM. */
function pointCode(p) {
  if (p.kind === 'camera') return p.sub === 'speed' ? 'speed_camera' : p.sub === 'redlight' ? 'red_light_camera' : 'traffic_camera';
  if (p.kind === 'toll') return 'toll_booth';
  if (p.kind === 'rail') return 'level_crossing';
  if (p.kind === 'report' && typeof p.type === 'string') return `report:${p.type}`;
  return null;
}

/**
 * Mã ổn định, ngắn của một điểm cảnh báo hay một biển cho màn hình xe (để máy phân biệt hai biển/camera giống nhau
 * về câu chữ, ví dụ hai camera cùng loại liền nhau): tiền tố + FNV-1a 32 bit của khoá gốc, luôn khớp CODE_RE.
 * Khoá không phải chuỗi/số → null.
 */
export function alertId(prefix, key) {
  if (typeof key !== 'string' && !isNum(key)) return null;
  const s = String(key);
  if (!s) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}${h.toString(36)}`;
}

const sameSign = (a, b) =>
  a.key === b.key || ((a.code ?? a.kind) === (b.code ?? b.kind) && (a.value ?? null) === (b.value ?? null));

/**
 * Cảnh báo cho màn hình xe, gần nhất trước, tối đa LIMITS.alerts mục: điểm cảnh báo đang hiện trên thanh vàng
 * (AlertEngine.update().active), biển đang hiện trên thanh và các biển kế tiếp (SignEngine.update()). Biển trùng
 * (cùng khoá, hoặc cùng mã và trị số) chỉ lấy một lần.
 * @param point { point, distance, info } | null
 * @param signs { active: { item, distance } | null, upcoming: [item] } | null
 */
export function alertsFrom(point, signs) {
  const out = [];
  if (point?.point && point.info) {
    out.push({
      kind: ALERT_KINDS.has(point.point.kind) ? point.point.kind : 'other',
      code: pointCode(point.point),
      text: point.info.title,
      distance: Math.max(0, point.distance),
      source: 'osm',
      id: alertId('p', point.point.id),
    });
  }
  const items = [];
  if (signs?.active?.item) items.push({ ...signs.active.item, distance: signs.active.distance });
  for (const it of signs?.upcoming || []) {
    if (it && !items.some((x) => sameSign(x, it))) items.push(it);
  }
  for (const it of items) {
    if (!isNum(it.distance) || it.distance < -50) continue; // đã đi qua hẳn
    out.push({
      kind: /^rail(:|$)/.test(it.kind || '') ? 'rail' : 'sign',
      code: it.code ?? null,
      text: signText(it),
      distance: Math.max(0, it.distance),
      source: it.src ? 'camera' : 'osm',
      id: alertId('s', it.key),
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, LIMITS.alerts);
}

const ARROW_ICONS = new Map([
  [-135, 'sharp-left'],
  [-90, 'left'],
  [-45, 'slight-left'],
  [0, 'straight'],
  [45, 'slight-right'],
  [90, 'right'],
  [135, 'sharp-right'],
]);

/** Tên biểu tượng của một bước chỉ dẫn (js/routing.js: type, icon) theo hợp đồng, không biết → null. */
export function maneuverIcon(step) {
  const type = step?.type;
  if (type === 'depart') return 'depart';
  if (type === 'arrive' || step?.icon?.kind === 'arrive') return 'arrive';
  if (type === 'ferry') return 'ferry';
  const icon = step?.icon;
  if (!icon) return null;
  if (icon.kind === 'roundabout') return 'roundabout';
  if (icon.kind === 'uturn') return 'uturn';
  if (icon.kind === 'arrow') return ARROW_ICONS.get(icon.angle || 0) ?? null;
  return null;
}

/**
 * Chỉ dẫn kế tiếp khi đang dẫn đường, như ô chỉ dẫn trên điện thoại (renderNav, beginRoute trong main.js).
 * @param route    tuyến đang đi (js/routing.js) hoặc null
 * @param progress kết quả RouteTracker.update gần nhất, hoặc null khi chưa có lần định vị nào trên tuyến
 */
export function maneuverFrom(route, progress) {
  if (!route?.steps?.length) return null;
  let step;
  let dist;
  let tripDistance;
  let tripDuration;
  if (progress) {
    step = progress.next || progress.step;
    dist = progress.next ? progress.distToNext : progress.remainingDistance;
    tripDistance = progress.remainingDistance;
    tripDuration = progress.remainingDuration;
  } else {
    step = route.steps[1] || route.steps[0];
    dist = route.steps[0].distance;
    tripDistance = route.distance;
    tripDuration = route.duration;
  }
  if (!step) return null;
  const exit = step.icon?.kind === 'roundabout' && step.icon.exit > 0 ? step.icon.exit : null;
  const nonNeg = (v) => (isNum(v) ? Math.max(0, v) : null);
  // tripDistance/tripDuration: quãng đường (m) và thời gian (s) còn lại tới đích, cho giờ đến trên màn hình xe.
  return {
    text: step.text,
    distance: nonNeg(dist),
    icon: maneuverIcon(step),
    exit,
    tripDistance: nonNeg(tripDistance),
    tripDuration: nonNeg(tripDuration),
  };
}

/**
 * Đoạn tuyến gần xe: từ ROUTE_BEHIND_M sau lưng tới ROUTE_AHEAD_M phía trước vị trí s (m dọc tuyến), dạng [lat, lon],
 * tối đa LIMITS.routePoints điểm.
 */
export function routeWindow(route, s = 0, { behind = ROUTE_BEHIND_M, ahead = ROUTE_AHEAD_M, max = LIMITS.routePoints } = {}) {
  const coords = route?.coords;
  const cum = route?.cum;
  // cum có thể là Float64Array (geo.js cumulativeDistances).
  if (!Array.isArray(coords) || !cum || typeof cum.length !== 'number' || cum.length < coords.length || coords.length < 2) return [];
  const at = isNum(s) ? s : 0;
  let i0 = 0;
  while (i0 + 1 < coords.length && cum[i0 + 1] <= at - behind) i0++;
  let i1 = i0;
  while (i1 + 1 < coords.length && cum[i1] < at + ahead) i1++;
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const p = toPoint(coords[i]);
    if (p) out.push(p);
  }
  return thinPoints(out, max);
}

// Đường lớn được ưu tiên khi phải bớt đường (m cộng thêm vào khoảng cách khi xếp hạng).
const ROAD_BONUS = {
  motorway: 200, trunk: 200, primary: 150, secondary: 100, tertiary: 75,
  motorway_link: 50, trunk_link: 50, primary_link: 50, secondary_link: 30, tertiary_link: 30,
};

/** Khoảng cách gần đúng (m) giữa hai toạ độ [lon, lat] ở gần nhau (đủ cho việc cắt đường quanh xe). */
function approxDist(a, b, cosLat) {
  const dx = (b[0] - a[0]) * cosLat;
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy) * 111320;
}

/**
 * Cắt hình học các đường quanh xe (RoadData.waysNear) trong bán kính radius quanh center. Mỗi đoạn liền nằm trong
 * bán kính (kèm một điểm ngay ngoài ở mỗi đầu để đường không bị hụt ở mép) thành một mục { highway, points }.
 * Đường gần (và đường lớn) trước; dừng khi hết hạn mức số đường hoặc số điểm.
 * @param ways [{ h, g: [lon, lat, lon, lat, …] }]
 */
export function roadsNear(ways, center, { radius = ROADS_RADIUS_M, maxRoads = LIMITS.roads, maxTotal = LIMITS.roadPointsTotal, maxPer = LIMITS.roadPoints } = {}) {
  if (!Array.isArray(ways) || !Array.isArray(center)) return [];
  const cosLat = Math.cos((center[1] * Math.PI) / 180);
  const runs = [];
  for (const way of ways) {
    const g = way?.g;
    if (!Array.isArray(g) || g.length < 4) continue;
    const n = g.length >> 1;
    const inside = new Array(n);
    const dist = new Array(n);
    for (let i = 0; i < n; i++) {
      dist[i] = approxDist(center, [g[2 * i], g[2 * i + 1]], cosLat);
      inside[i] = dist[i] <= radius;
    }
    let run = null;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const keep = inside[i] || (i > 0 && inside[i - 1]) || (i + 1 < n && inside[i + 1]);
      if (keep) {
        if (!run) run = [];
        run.push([g[2 * i], g[2 * i + 1]]);
        if (dist[i] < best) best = dist[i];
      }
      if ((!keep || i === n - 1) && run) {
        if (run.length >= 2) runs.push({ h: way.h, run, rank: best - (ROAD_BONUS[way.h] || 0) });
        run = null;
        best = Infinity;
      }
    }
  }
  runs.sort((a, b) => a.rank - b.rank);
  const out = [];
  let budget = maxTotal;
  for (const r of runs) {
    if (out.length >= maxRoads || budget < 2) break;
    const points = [];
    for (const c of r.run) {
      const p = toPoint(c);
      if (p) points.push(p);
    }
    const thin = thinPoints(points, Math.min(maxPer, budget));
    if (thin.length < 2) continue;
    budget -= thin.length;
    out.push({ highway: HIGHWAYS.has(r.h) ? r.h : 'other', points: thin });
  }
  return out;
}

/** Nhớ kết quả roadsNear: chỉ tính lại khi xe dời xa ROADS_MOVE_M hoặc sau ROADS_REFRESH_MS. */
export class RoadsMemo {
  #center = null;
  #at = 0;
  #value = [];

  get(center, now, compute) {
    if (!Array.isArray(center)) return [];
    if (!this.#center || now - this.#at >= ROADS_REFRESH_MS || now < this.#at || distance(center, this.#center) >= ROADS_MOVE_M) {
      this.#value = compute();
      this.#center = center;
      this.#at = now;
    }
    return this.#value;
  }
}

/** Trạng thái camera nhận diện biển (CameraController.state) theo hợp đồng. */
export function cameraStatus(st) {
  if (!st || !st.enabled) return 'off';
  const cam = typeof st.camera === 'string' ? st.camera : 'off';
  if (cam.startsWith('error') || (st.visionError && st.visionError !== 'args')) return 'error';
  if (cam === 'starting') return 'starting';
  if (cam === 'paused') return 'paused';
  if (cam === 'on') return st.capturing && st.level !== 0 ? 'running' : 'paused';
  return 'off';
}

/** Trạng thái bộ OBD (car.state của main.js, theo ObdClient.onState) theo hợp đồng. */
export function obdStatus(state, hasClient = true) {
  if (!hasClient) return 'off';
  switch (state) {
    case 'ready':
      return 'connected';
    case 'connecting':
    case 'init':
    case 'searching':
    case 'lost':
    case 'nocar':
      return 'connecting';
    case 'error':
      return 'error';
    default:
      return 'off';
  }
}

// ---------------------------------------------------------------------------------------------
// Kênh với ứng dụng Android
// ---------------------------------------------------------------------------------------------

/** Đối tượng window.BanDuongNative do ứng dụng Android gắn vào (có postMessage), không có thì null. */
export function nativeChannel(target = globalThis) {
  try {
    const ch = target?.BanDuongNative;
    return ch && typeof ch.postMessage === 'function' ? ch : null;
  } catch {
    return null;
  }
}

/**
 * Điều phối việc gửi trạng thái lên màn hình xe.
 * - start(): nghe NATIVE_EVENT và gửi "hello"; chỉ gửi "state" sau khi máy trả lời "native".
 * - publish(collect): gọi thường xuyên (mỗi lần định vị, mỗi giây); collect() trả dữ liệu thô cho boundState và chỉ
 *   được gọi khi thật sự tới lượt gửi. Đang chiếu lên xe: tối đa 4 lần/giây, chỉ khi đổi (hoặc mỗi KEEPALIVE_MS);
 *   lần gọi rơi vào lúc chưa tới lượt thì được gửi bù đúng lúc tới lượt. Chưa chiếu lên xe: mỗi IDLE_INTERVAL_MS.
 * Lỗi của collect hay của kênh bị bỏ qua: cầu nối không bao giờ làm hỏng phần còn lại của ứng dụng.
 */
export class CarBridge {
  #ch;
  #target;
  #now;
  #timers;
  #webVersion;
  #listener = null;
  #ready = false;
  #carConnected = false;
  #appVersion = null;
  #collect = null;
  #timer = null;
  #timerAt = Infinity;
  #lastSentAt = -Infinity;
  #lastKey = null;
  #helloAt = -Infinity;
  #helloTries = 0;
  #changeFns = new Set();

  constructor(channel, { target = globalThis, now = () => Date.now(), timers = globalThis, webVersion = null } = {}) {
    this.#ch = channel;
    this.#target = target;
    this.#now = now;
    this.#timers = timers;
    this.#webVersion = typeof webVersion === 'string' && VERSION_RE.test(webVersion) ? webVersion : null;
  }

  get ready() {
    return this.#ready;
  }

  get carConnected() {
    return this.#carConnected;
  }

  get appVersion() {
    return this.#appVersion;
  }

  /** fn({ ready, carConnected }) mỗi khi máy báo trạng thái → hàm huỷ. */
  onChange(fn) {
    this.#changeFns.add(fn);
    return () => this.#changeFns.delete(fn);
  }

  start() {
    if (this.#listener) return;
    this.#listener = (e) => this.handleNative(e?.detail);
    this.#target.addEventListener?.(NATIVE_EVENT, this.#listener);
    this.#hello(); // lớp nối đã gửi một "hello" lúc tài liệu bắt đầu nạp, nhưng câu trả lời có thể đến trước bộ nghe này
  }

  stop() {
    if (this.#listener) this.#target.removeEventListener?.(NATIVE_EVENT, this.#listener);
    this.#listener = null;
    this.#cancel();
    this.#ready = false;
  }

  /** Thông điệp từ máy (detail của NATIVE_EVENT). Chỉ nhận đúng dạng hợp đồng; type lạ bị bỏ qua. */
  handleNative(msg) {
    if (!msg || typeof msg !== 'object' || msg.v !== BRIDGE_V || typeof msg.type !== 'string') return;
    let connected;
    if (msg.type === 'native') {
      this.#appVersion = typeof msg.appVersion === 'string' && VERSION_RE.test(msg.appVersion) ? msg.appVersion : null;
      connected = msg.carConnected === true;
      this.#lastKey = null; // máy vừa (nạp lại) kênh: gửi lại ảnh đầy đủ
      this.#lastSentAt = -Infinity;
    } else if (msg.type === 'carConnected') {
      connected = msg.connected === true;
    } else return;
    const was = this.#carConnected;
    const wasReady = this.#ready;
    if (msg.type === 'native') this.#ready = true;
    this.#carConnected = connected;
    if (connected && !was) {
      this.#lastSentAt = -Infinity; // vừa cắm vào xe: gửi ngay
      this.#lastKey = null;
    }
    if (connected !== was && this.#timer != null) {
      this.#cancel(); // nhịp đổi: tính lại lượt kế
    }
    if (connected !== was || this.#ready !== wasReady) this.#notify();
    if (this.#collect && (msg.type === 'native' || connected !== was)) this.publish(this.#collect);
  }

  #notify() {
    for (const fn of this.#changeFns) {
      try {
        fn({ ready: this.#ready, carConnected: this.#carConnected });
      } catch {
        // lỗi của bên nghe không làm hỏng cầu nối
      }
    }
  }

  /** Khoảng tối thiểu giữa hai lần gửi "state" (ms). */
  get interval() {
    return this.#carConnected ? SEND_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  publish(collect) {
    if (typeof collect !== 'function') return;
    this.#collect = collect;
    const now = this.#now();
    if (!this.#ready) {
      if (this.#listener && this.#helloTries < HELLO_TRIES && now - this.#helloAt >= HELLO_RETRY_MS) this.#hello();
      return;
    }
    const due = this.#lastSentAt + this.interval;
    if (due > now) {
      // Đã có hẹn muộn hơn (nhịp giữ): dời về đúng lúc tới lượt để thay đổi được gửi sớm.
      if (this.#timer == null || this.#timerAt > due) this.#schedule(due - now);
      return;
    }
    this.#flush();
  }

  #schedule(wait) {
    this.#cancel();
    this.#timerAt = this.#now() + wait;
    this.#timer = this.#timers.setTimeout(() => this.#flush(), wait);
  }

  /** Đang chiếu lên xe: hẹn lần gửi giữ nhịp kế tiếp (ít nhất mỗi KEEPALIVE_MS), kể cả khi không ai gọi publish(). */
  #armKeepalive(now) {
    if (!this.#carConnected || this.#timer != null) return;
    this.#schedule(Math.max(this.#lastSentAt + KEEPALIVE_MS - now, this.interval));
  }

  #flush() {
    this.#cancel();
    if (!this.#ready || !this.#collect) return;
    const now = this.#now();
    let out;
    try {
      out = encodeState(boundState(this.#collect()), now);
    } catch {
      return;
    }
    if (!out.json) return;
    if (out.key !== this.#lastKey || now - this.#lastSentAt >= KEEPALIVE_MS) {
      if (this.#post(out.json)) {
        this.#lastKey = out.key;
        this.#lastSentAt = now;
      }
    }
    this.#armKeepalive(now);
  }

  #cancel() {
    if (this.#timer != null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = Infinity;
  }

  #hello() {
    this.#helloAt = this.#now();
    this.#helloTries++;
    const msg = { v: BRIDGE_V, type: 'hello' };
    if (this.#webVersion) msg.webVersion = this.#webVersion;
    this.#post(JSON.stringify(msg));
  }

  #post(json) {
    try {
      this.#ch.postMessage(json);
      return true;
    } catch {
      return false;
    }
  }
}

/** CarBridge khi trang chạy trong ứng dụng Android, không thì null (trình duyệt thường: không làm gì). */
export function createCarBridge(options = {}) {
  const ch = nativeChannel(options.target ?? globalThis);
  return ch ? new CarBridge(ch, options) : null;
}

// ---------- Tự cập nhật ứng dụng (không cần chép tệp qua USB hay Zalo) ----------
// Chỉ có khi lớp nối gắn window.BanDuongApp.update (bản release/sideload của ứng dụng); trên trình duyệt thường trang tự
// cập nhật qua service worker và phần này không chạy.
//   trang → máy: update { action: 'check' | 'install' | 'dismiss' | 'status' }  (không bao giờ có URL: máy tự quyết tải gì)
//   máy → trang: updateStatus { state, versionName, notes, progress, error, mode, current }
// Máy tự tìm bản phát hành trên GitHub, tải, kiểm tra SHA-256, tên gói và chữ ký trùng bản đang cài, rồi mở hộp thoại cài
// đặt của Android; người dùng luôn tự xác nhận trong hộp thoại đó (android/…/update/UpdateManager.kt).

export const UPDATE_STATES = Object.freeze(['idle', 'checking', 'available', 'downloading', 'verifying', 'ready', 'error', 'uptodate']);
const UPD_STATES = new Set(UPDATE_STATES);
const UPD_MODES = new Set(['install', 'notify']);
const UPD_VERSION_RE = /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/;
const UPD_CURRENT_RE = /^[A-Za-z0-9._-]{1,40}$/;
const UPD_ERROR_RE = /^[a-z][a-z-]{0,31}$/;

export const APP_UPDATE_LIMITS = Object.freeze({
  maxNotes: 300,
  installGapMs: 10_500, // máy nhận tối đa 1 lần "install" mỗi 10 giây
});

/** Ứng dụng có tự cập nhật không: { mode: 'install'|'notify', current } hoặc null. Mọi lỗi khi đọc đều coi như không. */
export function nativeUpdateSupport(env = globalThis) {
  try {
    const ch = env?.BanDuongNative;
    if (!ch || typeof ch.postMessage !== 'function') return null;
    const u = env?.BanDuongApp?.update;
    if (!u || typeof u !== 'object' || !UPD_MODES.has(u.mode)) return null;
    const current = typeof u.current === 'string' && UPD_CURRENT_RE.test(u.current) ? u.current : null;
    return { mode: u.mode, current };
  } catch {
    return null;
  }
}

/** Bỏ ký tự điều khiển, ký tự đổi hướng chữ và độ rộng 0; gộp khoảng trắng; cắt còn max ký tự. */
function cleanNotes(raw, max = APP_UPDATE_LIMITS.maxNotes) {
  if (typeof raw !== 'string' || raw.length > max * 8) return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}

/** Thông điệp updateStatus từ máy → trạng thái đã kiểm tra, hoặc null nếu sai dạng. */
export function parseUpdateStatus(msg) {
  if (!msg || typeof msg !== 'object' || msg.v !== BRIDGE_V || msg.type !== 'updateStatus') return null;
  if (!UPD_STATES.has(msg.state)) return null;
  const progress = typeof msg.progress === 'number' && Number.isFinite(msg.progress) ? Math.min(1, Math.max(0, msg.progress)) : null;
  return {
    state: msg.state,
    versionName: typeof msg.versionName === 'string' && UPD_VERSION_RE.test(msg.versionName) ? msg.versionName : null,
    notes: cleanNotes(msg.notes),
    progress,
    error: typeof msg.error === 'string' && UPD_ERROR_RE.test(msg.error) ? msg.error : null,
    mode: UPD_MODES.has(msg.mode) ? msg.mode : null,
    current: typeof msg.current === 'string' && UPD_CURRENT_RE.test(msg.current) ? msg.current : null,
  };
}

const UPD_ERROR_TEXT = {
  network: 'Không kết nối được máy chủ cập nhật. Hãy kiểm tra mạng rồi thử lại.',
  'rate-limited': 'Máy chủ cập nhật đang bận. Ứng dụng sẽ tự thử lại sau.',
  'too-large': 'Bản cập nhật không hợp lệ nên đã bị bỏ. Hãy thử lại sau.',
  'bad-release': 'Bản cập nhật không hợp lệ nên đã bị bỏ. Hãy thử lại sau.',
  'bad-apk': 'Bản cập nhật không hợp lệ nên đã bị bỏ. Hãy thử lại sau.',
  'version-mismatch': 'Bản cập nhật không hợp lệ nên đã bị bỏ. Hãy thử lại sau.',
  checksum: 'Tệp tải về bị lỗi hoặc không đầy đủ nên đã bị xoá. Hãy thử lại.',
  'package-mismatch': 'Tệp tải về không phải bản chính thức của Bạn Đường nên không được cài.',
  'signature-mismatch': 'Tệp tải về không có chữ ký đúng của Bạn Đường nên không được cài.',
  incompatible: 'Bản mới cần phiên bản Android mới hơn máy này.',
  'install-permission': 'Hãy bật “Cho phép từ nguồn này” cho Bạn Đường, rồi quay lại ứng dụng. Việc cập nhật sẽ tự tiếp tục.',
  'install-failed': 'Chưa cài được bản mới. Hãy thử lại.',
  'install-aborted': 'Đã huỷ cài đặt. Bấm “Cập nhật” để cài lại.',
  storage: 'Máy không đủ chỗ trống để tải bản mới.',
  // Máy chỉ cài khi thấy xe đứng yên (tốc độ GPS hoặc OBD dưới 8 km/h); chưa bắt được định vị cũng bị từ chối.
  driving: 'Hãy dừng xe an toàn, chờ định vị bắt được rồi bấm “Cập nhật”.',
};

const updPct = (p) => `${Math.round((p ?? 0) * 100)}%`;

/**
 * Chữ và nút cho trạng thái: { line, note, action, actionLabel, pill, pillText, canDismiss, busy }.
 * action: 'install' (cập nhật / tải bản chính thức) hoặc null. pill: có hiện nút nổi "Có phiên bản mới" không.
 */
export function describeUpdate(status, support) {
  const mode = status?.mode || support?.mode || 'install';
  const current = status?.current || support?.current || null;
  const v = status?.versionName;
  const notify = mode === 'notify';
  const installLabel = notify ? 'Tải bản chính thức' : 'Cập nhật';
  const out = { line: '', note: status?.notes || null, action: null, actionLabel: installLabel, pill: false, pillText: '', canDismiss: false, busy: false };
  const here = current ? `Phiên bản đang dùng: ${current}.` : '';
  switch (status?.state) {
    case 'checking':
      out.line = 'Đang kiểm tra bản mới…';
      out.busy = true;
      out.note = null;
      break;
    case 'uptodate':
      out.line = current ? `Bạn đang dùng bản mới nhất (${current}).` : 'Bạn đang dùng bản mới nhất.';
      out.note = null;
      break;
    case 'available':
      out.line = notify
        ? `Có phiên bản mới ${v}. Bản đang dùng là bản cài thử nên không tự cập nhật được: hãy tải và cài bản chính thức một lần.`
        : `Có phiên bản mới ${v}.`;
      out.action = 'install';
      out.pill = true;
      out.pillText = `Có phiên bản mới ${v}`;
      out.canDismiss = true;
      break;
    case 'downloading':
      out.line = `Đang tải bản ${v}… ${updPct(status.progress)}`;
      out.busy = true;
      out.pill = true;
      out.pillText = `Đang tải bản mới ${updPct(status.progress)}`;
      out.canDismiss = true;
      break;
    case 'verifying':
      out.line = 'Đang kiểm tra tệp tải về…';
      out.busy = true;
      out.pill = true;
      out.pillText = 'Đang kiểm tra bản mới…';
      break;
    case 'ready':
      if (status.error === 'install-aborted') {
        out.line = UPD_ERROR_TEXT['install-aborted'];
        out.action = 'install';
        out.pill = true;
        out.pillText = `Cài bản mới ${v}`;
        out.canDismiss = true;
      } else {
        out.line = 'Hãy xác nhận trong hộp thoại cài đặt của Android.';
        out.pill = true;
        out.pillText = 'Đang chờ xác nhận cài đặt';
        out.busy = true;
      }
      break;
    case 'error': {
      out.line = UPD_ERROR_TEXT[status.error] || 'Chưa cập nhật được. Hãy thử lại sau.';
      // Lỗi khi đang cài một bản đã biết: vẫn cho bấm lại; lỗi khi kiểm tra: chỉ hiện trong phần cài đặt.
      if (v) {
        out.action = 'install';
        out.actionLabel = notify ? installLabel : 'Thử lại';
        out.pill = true;
        out.pillText = `Cập nhật bản ${v}`;
        out.canDismiss = true;
      }
      break;
    }
    default:
      out.line = here || 'Bấm “Kiểm tra cập nhật” để tìm bản mới.';
      out.note = null;
  }
  return out;
}

/**
 * Nói chuyện với bộ cập nhật của máy. start() nghe NATIVE_EVENT và xin máy gửi lại trạng thái; check/install/dismiss gửi
 * đúng một ý định. install bị giãn ít nhất APP_UPDATE_LIMITS.installGapMs giữa hai lần (máy cũng tự giới hạn).
 */
export class AppUpdate {
  #ch;
  #target;
  #now;
  #listener = null;
  #status = null;
  #lastInstall = -Infinity;
  #fns = new Set();

  constructor(channel, { target = globalThis, now = () => Date.now(), support = null } = {}) {
    this.#ch = channel;
    this.#target = target;
    this.#now = now;
    this.support = support;
  }

  get status() {
    return this.#status;
  }

  /** fn(status) mỗi khi máy báo trạng thái mới → hàm huỷ. */
  onChange(fn) {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  start() {
    if (this.#listener) return;
    this.#listener = (e) => this.handleNative(e?.detail);
    this.#target.addEventListener?.(NATIVE_EVENT, this.#listener);
    this.#send('status');
  }

  stop() {
    if (this.#listener) this.#target.removeEventListener?.(NATIVE_EVENT, this.#listener);
    this.#listener = null;
  }

  handleNative(msg) {
    const s = parseUpdateStatus(msg);
    if (!s) return;
    this.#status = s;
    for (const fn of this.#fns) {
      try {
        fn(s);
      } catch {
        /* giao diện lỗi không làm hỏng cầu nối */
      }
    }
  }

  check() {
    return this.#send('check');
  }

  /** Trả false nếu vừa bấm (chưa đủ installGapMs). */
  install() {
    const now = this.#now();
    if (now - this.#lastInstall < APP_UPDATE_LIMITS.installGapMs) return false;
    this.#lastInstall = now;
    return this.#send('install');
  }

  dismiss() {
    return this.#send('dismiss');
  }

  #send(action) {
    try {
      this.#ch.postMessage(JSON.stringify({ v: BRIDGE_V, type: 'update', action }));
      return true;
    } catch {
      return false;
    }
  }
}

/** AppUpdate khi chạy trong ứng dụng Android có tự cập nhật; trình duyệt thường hoặc bản debug → null. */
export function createAppUpdate(options = {}) {
  const env = options.env ?? globalThis;
  const support = nativeUpdateSupport(env);
  if (!support) return null;
  return new AppUpdate(env.BanDuongNative, { target: env, ...options, support });
}
