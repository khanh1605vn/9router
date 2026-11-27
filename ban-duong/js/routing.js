// Tìm đường và chuyển các bước rẽ thành chỉ dẫn tiếng Việt.
// Máy chủ chính là Valhalla (có hồ sơ xe máy, tránh được cao tốc và đường thu phí);
// OSRM (chỉ có hồ sơ ô tô) là dự phòng khi Valhalla không phản hồi.

import { bearing, compassName, cumulativeDistances } from './geo.js';

export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
export const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const TIMEOUT_MS = 15000;

export class RouteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const TURN = {
  uturn: 'Quay đầu',
  'sharp right': 'Rẽ ngoặt phải',
  right: 'Rẽ phải',
  'slight right': 'Chếch sang phải',
  straight: 'Đi thẳng',
  'slight left': 'Chếch sang trái',
  left: 'Rẽ trái',
  'sharp left': 'Rẽ ngoặt trái',
};

const ANGLE = {
  'sharp left': -135,
  left: -90,
  'slight left': -45,
  straight: 0,
  'slight right': 45,
  right: 90,
  'sharp right': 135,
};

const sideOf = (modifier) =>
  !modifier ? '' : modifier.includes('left') ? 'trái' : modifier.includes('right') ? 'phải' : '';

const lowerFirst = (s) => (s ? s[0].toLocaleLowerCase('vi') + s.slice(1) : s);

// Danh từ chung đứng đầu tên đường: giữ nguyên tên, chỉ viết thường chữ cái đầu khi nằm giữa câu.
const GENERIC =
  /^(đường tỉnh|đường huyện|đường vành đai|đường cao tốc|đường|phố|ngõ|ngách|hẻm|kiệt|quốc lộ|tỉnh lộ|hương lộ|đại lộ|xa lộ|cao tốc|vành đai|cầu vượt|cầu|hầm|vòng xoay|nút giao|dốc|đê|quảng trường|bến phà|phà)(?=\s|$)/iu;
// Ký hiệu tuyến đường (QL1A, ĐT743, CT.01…): giữ nguyên chữ hoa.
const REF = /^(ql|tl|đt|dt|đh|hl|ct)(?=[\s.\d-]|$)/iu;

/** Tên đường để ghép vào câu chỉ dẫn: "đường Lê Lợi", "đại lộ Võ Văn Kiệt", "QL1A". */
export function roadLabel(name, ref) {
  const n = (name || '').trim();
  if (!n) return (ref || '').split(';')[0].trim();
  if (REF.test(n)) return n;
  if (GENERIC.test(n)) return lowerFirst(n);
  return `đường ${n}`;
}

/** Mô tả một bước rẽ của OSRM: { text, short, icon }. */
export function describeStep(step) {
  const m = step.maneuver || {};
  const type = m.type || 'continue';
  const modifier = m.modifier;
  const label = roadLabel(step.name, step.ref);
  const onto = label ? ` vào ${label}` : '';
  const side = sideOf(modifier);
  const arrow = (mod) => ({ kind: 'arrow', angle: ANGLE[mod] ?? 0 });
  const turnIcon = modifier === 'uturn' ? { kind: 'uturn' } : arrow(modifier);
  const turnWord = TURN[modifier] || 'Đi thẳng';

  switch (type) {
    case 'depart': {
      const dir = compassName(m.bearing_after ?? 0);
      return {
        text: label ? `Đi về hướng ${dir} trên ${label}` : `Đi về hướng ${dir}`,
        short: 'Xuất phát',
        icon: { kind: 'arrow', angle: 0 },
      };
    }
    case 'arrive':
      return {
        text: side ? `Đến nơi, điểm đến ở bên ${side}` : 'Đến nơi',
        short: 'Đến nơi',
        icon: { kind: 'arrive' },
      };
    case 'turn':
      return { text: turnWord + onto, short: turnWord, icon: turnIcon };
    case 'new name':
    case 'continue': {
      if (modifier === 'uturn') {
        return {
          text: label ? `Quay đầu và đi tiếp trên ${label}` : 'Quay đầu',
          short: 'Quay đầu',
          icon: { kind: 'uturn' },
        };
      }
      if (!modifier || modifier === 'straight') {
        return {
          text: label ? `Đi tiếp trên ${label}` : 'Tiếp tục đi thẳng',
          short: 'Đi thẳng',
          icon: arrow('straight'),
        };
      }
      return {
        text: label ? `${turnWord} để đi tiếp trên ${label}` : turnWord,
        short: turnWord,
        icon: turnIcon,
      };
    }
    case 'merge':
      return {
        text: `Nhập làn${side ? ` sang ${side}` : ''}${onto}`,
        short: 'Nhập làn',
        icon: arrow(side === 'trái' ? 'slight left' : side === 'phải' ? 'slight right' : 'straight'),
      };
    case 'on ramp':
      return {
        text: `Đi theo đường dẫn${side ? ` bên ${side}` : ''}${onto}`,
        short: 'Vào đường dẫn',
        icon: arrow(side === 'trái' ? 'slight left' : side === 'phải' ? 'slight right' : 'straight'),
      };
    case 'off ramp': {
      const dest = (step.destinations || '').split(/[,;]/)[0].trim();
      return {
        text: `Đi theo lối ra${side ? ` bên ${side}` : ''}${dest ? ` hướng ${dest}` : onto}`,
        short: 'Đi theo lối ra',
        icon: arrow(side === 'trái' ? 'slight left' : side === 'phải' ? 'slight right' : 'straight'),
      };
    }
    case 'fork': {
      const short = side ? `Giữ bên ${side}` : 'Đi thẳng';
      return {
        text: `${short} tại ngã rẽ${onto}`,
        short,
        icon: arrow(side === 'trái' ? 'slight left' : side === 'phải' ? 'slight right' : 'straight'),
      };
    }
    case 'end of road':
      return { text: `Cuối đường, ${lowerFirst(turnWord)}${onto}`, short: turnWord, icon: turnIcon };
    case 'roundabout':
    case 'rotary': {
      const exit = Number(m.exit) || 0;
      return exit
        ? {
            text: `Vào vòng xuyến, đi theo lối ra thứ ${exit}${onto}`,
            short: `Lối ra thứ ${exit}`,
            icon: { kind: 'roundabout', exit },
          }
        : { text: `Đi vào vòng xuyến${onto}`, short: 'Vào vòng xuyến', icon: { kind: 'roundabout', exit: 0 } };
    }
    case 'roundabout turn':
      return {
        text: `Tại vòng xuyến, ${lowerFirst(turnWord)}${onto}`,
        short: turnWord,
        icon: turnIcon,
      };
    case 'exit roundabout':
    case 'exit rotary':
      return { text: `Ra khỏi vòng xuyến${onto}`, short: 'Ra khỏi vòng xuyến', icon: arrow('slight right') };
    case 'ferry': {
      // Tên tuyến phà/đò đã tự có chữ "Phà", "Đò" ở đầu thì giữ nguyên, không ghép thêm "đường".
      const n = (step.name || '').trim();
      const boat = !n ? 'phà' : /^(bến phà|phà|bến đò|đò)(?=\s|$)/iu.test(n) ? lowerFirst(n) : `phà ${n}`;
      return { text: `Lên ${boat}`, short: 'Lên phà', icon: arrow('straight') };
    }
    case 'ferry exit':
      return { text: `Rời phà${onto}`, short: 'Rời phà', icon: arrow('straight') };
    default:
      return {
        text: label ? `Đi tiếp trên ${label}` : 'Tiếp tục đi thẳng',
        short: 'Đi thẳng',
        icon: arrow('straight'),
      };
  }
}

/** Bước không đòi hỏi người lái thao tác gì (chỉ đổi tên đường, đi thẳng). */
function isPassive(step) {
  const { type, modifier } = step.maneuver || {};
  if (type === 'notification' || type === 'use lane') return true;
  if (type === 'new name' || type === 'continue') return !modifier || modifier === 'straight';
  return false;
}

/** Chuyển một tuyến của OSRM thành cấu trúc dùng cho dẫn đường. */
export function parseRoute(osrmRoute) {
  const coords = [];
  const steps = [];
  let hasToll = false;
  let hasFerry = false;
  let hasMotorway = false;

  for (const leg of osrmRoute.legs || []) {
    for (const raw of leg.steps || []) {
      const g = raw.geometry?.coordinates || [];
      if (!coords.length && g.length) coords.push(g[0]);
      const index = Math.max(0, coords.length - 1);
      for (let i = 1; i < g.length; i++) {
        const last = coords[coords.length - 1];
        if (g[i][0] !== last[0] || g[i][1] !== last[1]) coords.push(g[i]);
      }

      const classes = new Set((raw.intersections || []).flatMap((x) => x.classes || []));
      if (classes.has('toll')) hasToll = true;
      if (classes.has('ferry') || raw.mode === 'ferry') hasFerry = true;
      const expressway = classes.has('motorway');
      if (expressway) hasMotorway = true;

      const prev = steps[steps.length - 1];
      if (prev && isPassive(raw)) {
        // Gộp vào bước trước: người lái cứ đi tiếp, không cần nhắc.
        prev.distance += raw.distance || 0;
        prev.duration += raw.duration || 0;
        continue;
      }
      steps.push({
        type: raw.maneuver?.type || 'continue',
        modifier: raw.maneuver?.modifier || '',
        name: raw.name || '',
        ref: raw.ref || '',
        distance: raw.distance || 0,
        duration: raw.duration || 0,
        location: raw.maneuver?.location || g[0],
        index,
        expressway,
        ...describeStep(raw),
      });
    }
  }

  const last = steps[steps.length - 1];
  if (last && last.type === 'arrive') last.index = coords.length - 1;

  const cum = cumulativeDistances(coords);
  return {
    coords,
    cum,
    steps,
    distance: osrmRoute.distance ?? cum[cum.length - 1] ?? 0,
    duration: osrmRoute.duration ?? 0,
    summary: (osrmRoute.legs || []).map((l) => l.summary).filter(Boolean).join(', '),
    hasToll,
    hasFerry,
    hasMotorway,
  };
}

// ---------- Valhalla ----------

// Mã loại thao tác của Valhalla → [kiểu, hướng] theo cách gọi dùng chung trong ứng dụng.
const VALHALLA_TYPES = {
  1: ['depart'], 2: ['depart'], 3: ['depart'],
  4: ['arrive'], 5: ['arrive', 'right'], 6: ['arrive', 'left'],
  7: ['new name', 'straight'], 8: ['continue', 'straight'],
  9: ['turn', 'slight right'], 10: ['turn', 'right'], 11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'], 13: ['turn', 'uturn'],
  14: ['turn', 'sharp left'], 15: ['turn', 'left'], 16: ['turn', 'slight left'],
  17: ['on ramp', 'straight'], 18: ['on ramp', 'right'], 19: ['on ramp', 'left'],
  20: ['off ramp', 'right'], 21: ['off ramp', 'left'],
  22: ['fork', 'straight'], 23: ['fork', 'slight right'], 24: ['fork', 'slight left'],
  25: ['merge', 'straight'], 37: ['merge', 'slight right'], 38: ['merge', 'slight left'],
  26: ['roundabout'], 27: ['exit roundabout'],
  28: ['ferry'], 29: ['ferry exit'],
};

/** Giải mã chuỗi polyline độ chính xác 6 chữ số của Valhalla thành [[kinh độ, vĩ độ], …]. */
export function decodePolyline6(str) {
  const coords = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && i < str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

/** Chuyển một "trip" của Valhalla thành cấu trúc dùng cho dẫn đường. */
export function parseValhallaTrip(trip) {
  const coords = [];
  const steps = [];
  let hasToll = false;
  let hasFerry = false;
  let hasMotorway = false;

  for (const leg of trip.legs || []) {
    const shape = decodePolyline6(leg.shape || '');
    // Bỏ các điểm trùng nhau liên tiếp, đồng thời ghi lại chỉ số mới của từng điểm.
    const remap = new Array(shape.length);
    for (let i = 0; i < shape.length; i++) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== shape[i][0] || last[1] !== shape[i][1]) coords.push(shape[i]);
      remap[i] = coords.length - 1;
    }
    const s = leg.summary || {};
    hasToll ||= Boolean(s.has_toll);
    hasFerry ||= Boolean(s.has_ferry);
    hasMotorway ||= Boolean(s.has_highway);

    const list = leg.maneuvers || [];
    list.forEach((m, k) => {
      const [type, modifier = ''] = VALHALLA_TYPES[m.type] || ['continue', 'straight'];
      const index = remap[Math.min(m.begin_shape_index ?? 0, shape.length - 1)] ?? 0;
      let name = m.street_names?.[0] || m.begin_street_names?.[0] || '';
      // Ở bước "vào vòng xuyến", tên đi kèm là tên của chính vòng xuyến; đường đi ra nằm ở bước kế tiếp.
      if (type === 'roundabout') name = list[k + 1]?.type === 27 ? list[k + 1].street_names?.[0] || '' : '';
      const after = coords[Math.min(index + 1, coords.length - 1)];
      const raw = {
        name,
        ref: '',
        destinations: m.sign?.exit_toward_elements?.[0]?.text || '',
        distance: (m.length || 0) * 1000,
        duration: m.time || 0,
        maneuver: {
          type,
          modifier,
          exit: m.roundabout_exit_count,
          bearing_after: m.bearing_after ?? bearing(coords[index], after),
          location: coords[index],
        },
      };
      const prev = steps[steps.length - 1];
      if (prev && isPassive(raw)) {
        prev.distance += raw.distance;
        prev.duration += raw.duration;
        return;
      }
      steps.push({
        type,
        modifier,
        name,
        ref: '',
        distance: raw.distance,
        duration: raw.duration,
        location: coords[index],
        index,
        expressway: Boolean(m.highway),
        ...describeStep(raw),
      });
    });
  }

  const last = steps[steps.length - 1];
  if (last && last.type === 'arrive') last.index = coords.length - 1;

  // Valhalla không có tóm tắt tuyến: lấy tên hai đoạn dài nhất, theo thứ tự đi.
  const longest = steps
    .map((st, i) => ({ st, i }))
    .filter((x) => x.st.name)
    .sort((a, b) => b.st.distance - a.st.distance)
    .filter((x, i, arr) => arr.findIndex((y) => y.st.name === x.st.name) === i)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.st.name);

  const cum = cumulativeDistances(coords);
  return {
    coords,
    cum,
    steps,
    distance: (trip.summary?.length ?? 0) * 1000 || cum[cum.length - 1] || 0,
    duration: trip.summary?.time ?? 0,
    summary: longest.join(', '),
    hasToll,
    hasFerry,
    hasMotorway,
  };
}

/** Gọi fetch có giới hạn thời gian; vẫn tôn trọng tín hiệu huỷ của người gọi. */
async function fetchWithTimeout(url, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchValhalla(from, to, { vehicle, avoidTolls, heading, signal }) {
  const moto = vehicle === 'moto';
  // motor_scooter dùng quyền đi lại của xe hai bánh: không bao giờ vào đường cao tốc.
  const costing = moto ? 'motor_scooter' : 'auto';
  const options = moto ? { top_speed: 70, use_primary: 1 } : avoidTolls ? { use_tolls: 0 } : {};
  const start = { lon: from[0], lat: from[1] };
  if (heading != null) {
    start.heading = Math.round(heading) % 360;
    start.heading_tolerance = 60;
  }
  const body = {
    locations: [start, { lon: to[0], lat: to[1] }],
    costing,
    costing_options: { [costing]: options },
    units: 'kilometers',
    alternates: 2,
  };
  const res = await fetchWithTimeout(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(body))}`, signal);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* xử lý như lỗi bên dưới */
  }
  if (res.ok && data?.trip) {
    const trips = [data.trip, ...(data.alternates || []).map((a) => a?.trip).filter(Boolean)];
    const routes = trips.map(parseValhallaTrip).filter((r) => r.coords.length > 1 && r.steps.length);
    if (routes.length) return routes;
  }
  // 171: không có đường gần điểm chọn; 442: không tìm được lối đi.
  const code = data?.error_code;
  if (code === 171) throw new RouteError('NoSegment', 'Điểm đi hoặc điểm đến nằm quá xa đường giao thông.');
  if (code === 442) throw new RouteError('NoRoute', 'Không tìm được đường đi giữa hai điểm này.');
  throw new RouteError('Unavailable', 'Máy chủ tìm đường chưa phản hồi.');
}

// ---------- OSRM (dự phòng) ----------

function osrmUrl(from, to, { exclude, heading }) {
  const pts = `${from[0].toFixed(6)},${from[1].toFixed(6)};${to[0].toFixed(6)},${to[1].toFixed(6)}`;
  const q = new URLSearchParams({
    alternatives: 'true',
    steps: 'true',
    geometries: 'geojson',
    overview: 'false',
  });
  if (exclude) q.set('exclude', exclude);
  let url = `${OSRM_URL}${pts}?${q}`;
  // bearings chứa dấu ";" nên ghép tay để không bị mã hoá.
  if (heading != null) url += `&bearings=${Math.round(heading) % 360},60;`;
  return url;
}

async function fetchOsrm(from, to, { vehicle, avoidTolls, heading, signal }) {
  const exclude = vehicle === 'moto' ? 'motorway' : avoidTolls ? 'toll' : '';
  const variants = [{ exclude, heading }];
  if (heading != null) variants.push({ exclude, heading: null });
  if (exclude) variants.push({ exclude: '', heading: null });

  let lastError = new RouteError('NoRoute', 'Không tìm được đường đi giữa hai điểm này.');
  for (const variant of variants) {
    const res = await fetchWithTimeout(osrmUrl(from, to, variant), signal);
    if (res.status === 429 || res.status >= 500) {
      throw new RouteError('Busy', 'Máy chủ tìm đường đang bận. Hãy thử lại sau ít phút.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* phản hồi không phải JSON: xử lý như lỗi bên dưới */
    }
    if (res.ok && data?.code === 'Ok' && data.routes?.length) {
      const routes = data.routes.map(parseRoute).filter((r) => r.coords.length > 1 && r.steps.length);
      // Máy chủ không nhận điều kiện tránh đường thì tuyến trả về có thể vẫn đi qua cao tốc/trạm thu phí.
      if (routes.length) return { routes, relaxed: Boolean(exclude) && !variant.exclude };
    }
    lastError = new RouteError(
      data?.code || 'Error',
      data?.code === 'NoSegment'
        ? 'Điểm đi hoặc điểm đến nằm quá xa đường giao thông.'
        : 'Không tìm được đường đi giữa hai điểm này.'
    );
  }
  throw lastError;
}

/**
 * Lấy danh sách tuyến đường từ `from` tới `to`.
 * - Xe máy: không đi đường cao tốc.
 * - Ô tô + "tránh đường thu phí": tránh đường có thu phí.
 * Trả về { routes, relaxed }; `relaxed` = true khi phải dùng máy chủ dự phòng không bảo đảm được
 * điều kiện tránh đường, để giao diện nhắc người dùng kiểm tra lại.
 */
export async function fetchRoutes(from, to, opts = {}) {
  const request = { vehicle: 'car', avoidTolls: false, heading: null, ...opts };
  let primaryError = null;
  try {
    return { routes: await fetchValhalla(from, to, request), relaxed: false };
  } catch (err) {
    if (request.signal?.aborted) throw err;
    primaryError = err;
  }
  try {
    return await fetchOsrm(from, to, request);
  } catch (err) {
    if (request.signal?.aborted) throw err;
    // Cả hai máy chủ cùng báo không có đường thì đó là câu trả lời thật; còn lại là lỗi kết nối.
    for (const e of [err, primaryError]) {
      if (e instanceof RouteError && (e.code === 'NoRoute' || e.code === 'NoSegment' || e.code === 'Busy')) throw e;
    }
    throw new RouteError('Network', 'Không kết nối được máy chủ tìm đường. Hãy kiểm tra mạng rồi thử lại.');
  }
}
