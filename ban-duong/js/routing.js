// Tìm đường qua máy chủ OSRM và chuyển các bước rẽ thành chỉ dẫn tiếng Việt.

import { compassName, cumulativeDistances } from './geo.js';

export const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

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
  /^(đường tỉnh|đường huyện|đường vành đai|đường|phố|ngõ|ngách|hẻm|kiệt|quốc lộ|tỉnh lộ|hương lộ|đại lộ|xa lộ|cao tốc|vành đai|cầu vượt|cầu|hầm|vòng xoay|nút giao|dốc|đê|quảng trường)(?=\s|$)/iu;
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

function buildUrl(from, to, { exclude, heading }) {
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

/**
 * Lấy danh sách tuyến đường từ `from` tới `to`.
 * - Xe máy: tránh đường cao tốc (xe máy không được đi vào cao tốc).
 * - Ô tô + "tránh trạm thu phí": tránh đường có thu phí.
 * Nếu máy chủ không đáp ứng được điều kiện, tự nới điều kiện và báo lại qua `relaxed`.
 */
export async function fetchRoutes(from, to, opts = {}) {
  const { vehicle = 'car', avoidTolls = false, heading = null, signal } = opts;
  const exclude = vehicle === 'moto' ? 'motorway' : avoidTolls ? 'toll' : '';
  const variants = [{ exclude, heading }];
  if (heading != null) variants.push({ exclude, heading: null });
  if (exclude) variants.push({ exclude: '', heading: null });

  let lastError = new RouteError('NoRoute', 'Không tìm được đường đi giữa hai điểm này.');
  for (const variant of variants) {
    let res;
    try {
      res = await fetch(buildUrl(from, to, variant), { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new RouteError('Network', 'Không kết nối được máy chủ tìm đường. Hãy kiểm tra mạng rồi thử lại.');
    }
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
