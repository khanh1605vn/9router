// Bộ máy cảnh báo: điểm cần chú ý phía trước (camera, trạm thu phí, đường sắt, điểm tự đánh dấu),
// cảnh báo vượt tốc độ và giới hạn tốc độ lấy từ biển do camera trên xe ghi nhận. Thuần logic, không đụng tới DOM.

import { angleDiff, bearing, distance, nearestOnLine } from './geo.js';
import { SPEED_MAX, SPEED_MIN, travelFor } from './learnedsigns.js';
import { joinSays, locate, mapItems, roadLimit } from './signengine.js';
import { parseDirection } from './signs.js';
import { APPLY_ANGLE, ARM_CHORD } from './signlearn.js';
import { REPORT_TYPES } from './store.js';
import { spokenDistance } from './tracker.js';

const RAD = Math.PI / 180;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Tên hiển thị, câu đọc và biểu tượng của một điểm cảnh báo.
 * roadLimit: giới hạn (km/h) của đường xe đang đi, hoặc null. Camera tốc độ không ghi giới hạn thì giới hạn này chỉ
 * hiện trong tên (nói rõ là của đường đang đi), không đọc thành tiếng: dữ liệu không nói camera đo theo số nào.
 */
export function describePoint(p, { roadLimit: road = null } = {}) {
  if (p.kind === 'camera') {
    const limit = p.limit ? ` · giới hạn ${p.limit} km/h` : '';
    const say = p.limit ? `, giới hạn ${p.limit} ki lô mét trên giờ` : '';
    if (p.sub === 'speed') {
      const roadNote = !p.limit && isNum(road) && road > 0 ? ` · giới hạn đường đang đi ${road} km/h` : '';
      if (p.avg) {
        return {
          title: `Đoạn đo tốc độ trung bình${limit}${roadNote}`,
          say: `có đoạn đo tốc độ trung bình${say}`,
          icon: 'camera',
        };
      }
      return { title: `Camera bắn tốc độ${limit}${roadNote}`, say: `có camera bắn tốc độ${say}`, icon: 'camera' };
    }
    if (p.sub === 'redlight') return { title: 'Camera phạt vượt đèn đỏ', say: 'có camera phạt vượt đèn đỏ', icon: 'camera' };
    if (p.enf === 'weight') return { title: 'Điểm kiểm soát tải trọng xe', say: 'có điểm kiểm soát tải trọng xe', icon: 'camera' };
    if (p.enf === 'height') return { title: 'Điểm kiểm soát chiều cao xe', say: 'có điểm kiểm soát chiều cao xe', icon: 'camera' };
    return { title: 'Camera giám sát giao thông', say: 'có camera giám sát giao thông', icon: 'camera' };
  }
  if (p.kind === 'toll') return { title: p.name || 'Trạm thu phí', say: 'có trạm thu phí', icon: 'toll' };
  if (p.kind === 'rail') {
    return { title: 'Đường ngang đường sắt', say: 'có đường sắt cắt ngang, hãy chú ý quan sát', icon: 'rail' };
  }
  const def = REPORT_TYPES[p.type];
  if (!def) return { title: 'Điểm cần chú ý', say: 'có điểm cần chú ý', icon: 'hazard' };
  const extra = p.type === 'school' ? ', hãy giảm tốc độ' : '';
  return {
    title: `${def.label} (bạn đánh dấu)`,
    say: `có ${def.label[0].toLocaleLowerCase('vi')}${def.label.slice(1)}${extra}`,
    icon: def.icon,
  };
}

const SETTING_OF = { camera: 'alertCamera', toll: 'alertToll', rail: 'alertRail', report: 'alertReport' };

// Hướng ghi trên camera (direction / camera:direction, roaddata.js giữ ở p.dir):
// - forward/backward trên một nút của đường (biết hướng vẽ p.wb): chiều xe chịu kiểm soát. Xe đi lệch chiều đó quá
//   CAMERA_TRAVEL_TOLERANCE độ (đường bên kia của đường đôi, đi ngược lại) thì không báo.
// - số độ: người vẽ bản đồ không thống nhất đó là hướng xe chạy hay hướng ống kính nhìn (ngược nhau 180°), nên chỉ
//   dùng như một trục: xe đi gần trục đó theo chiều nào cũng báo; chỉ bỏ khi xe đi lệch trục quá CAMERA_AXIS_TOLERANCE
//   độ (đường cắt ngang chỗ đặt camera).
// - không có, không đọc được, both, forward/backward mà không biết hướng vẽ, không biết hướng xe: vẫn báo.
// Hướng xe dùng để so: khi dẫn đường và điểm nằm trên tuyến phía trước thì là hướng của tuyến tại chỗ điểm đó (camera
// ngay sau chỗ rẽ vẫn được báo sớm); ngoài ra là hướng GPS, chỉ khi xe chạy từ ALERT_MIN_SPEED trở lên.
export const CAMERA_TRAVEL_TOLERANCE = 90;
export const CAMERA_AXIS_TOLERANCE = 60;
// Điểm tự đánh dấu và điểm cộng đồng có hướng (số độ, hướng xe chạy lúc đánh dấu): chỉ báo khi xe đi lệch không quá
// chừng này (độ).
export const POINT_FACING_TOLERANCE = 60;
// m/s: dưới tốc độ này không báo điểm mới, và cũng là tốc độ từ đó hướng GPS được tin để lọc theo hướng. Hai việc dùng
// chung một ngưỡng: nếu ngưỡng tin hướng cao hơn ngưỡng báo thì trong lúc kẹt xe (7–9 km/h) camera của chiều bên kia
// được báo vì không có hướng để lọc.
export const ALERT_MIN_SPEED = 2;
// Hai điểm cùng loại (cùng họ, xem alertFamily) cách nhau không quá chừng này (m) coi là một: chỉ báo một lần.
export const ALERT_DUP_M = 30;

/** Camera có áp dụng cho xe đang đi theo hướng heading (độ) không. Không chắc thì luôn là có. */
export function cameraApplies(p, heading) {
  if (!p || p.kind !== 'camera' || !isNum(heading) || typeof p.dir !== 'string' || !p.dir) return true;
  const d = parseDirection({ direction: p.dir }, ['direction']);
  if (d.mode === 'forward' || d.mode === 'backward') {
    if (!isNum(p.wb)) return true;
    const travel = d.mode === 'forward' ? p.wb : (p.wb + 180) % 360;
    return Math.abs(angleDiff(heading, travel)) <= CAMERA_TRAVEL_TOLERANCE;
  }
  if (d.mode === 'deg') {
    return d.degs.some((deg) => {
      const off = Math.abs(angleDiff(heading, deg));
      return Math.min(off, 180 - off) <= CAMERA_AXIS_TOLERANCE;
    });
  }
  return true;
}

/** Điểm có hướng dạng số (điểm tự đánh dấu, điểm cộng đồng) có áp dụng cho xe đi theo hướng heading không. */
export function facingApplies(p, heading) {
  const dir = p?.direction;
  if (!Number.isInteger(dir) || !isNum(heading)) return true;
  return Math.abs(angleDiff(heading, dir)) <= POINT_FACING_TOLERANCE;
}

/** Điểm có áp dụng cho hướng đi heading không (hướng camera của bản đồ và hướng số của điểm đánh dấu). */
export const pointApplies = (p, heading) => cameraApplies(p, heading) && facingApplies(p, heading);

// Họ của điểm tự đánh dấu và điểm cộng đồng không phải camera: chỉ các loại chắc chắn cùng nghĩa.
const REPORT_FAMILY = { camspeed: 'cam:speed', camred: 'cam:redlight', camera: 'cam:traffic', hazard: 'hazard', closure: 'closure' };
const COMMUNITY_FAMILY = { hazard: 'hazard', closure: 'closure' };

/**
 * Họ của một điểm: điểm của bản đồ, của dữ liệu cộng đồng và của người dùng cùng họ, gần nhau, là cùng một thứ ngoài
 * đường. Camera theo loại (tốc độ, đèn đỏ, giám sát; kiểm soát tải trọng, chiều cao riêng). Loại khác không chắc cùng
 * nghĩa thì mỗi điểm một họ riêng (không bao giờ gộp).
 */
export function alertFamily(p) {
  if (p.kind === 'camera') return `cam:${p.enf || p.sub || 'traffic'}`;
  if (p.kind === 'report') return REPORT_FAMILY[p.type] || `id:${p.id}`;
  if (p.kind === 'community') return COMMUNITY_FAMILY[p.type] || `id:${p.id}`;
  return p.kind === 'toll' ? 'toll' : `id:${p.id}`;
}

/** Thứ tự ưu tiên khi nhiều điểm là cùng một thứ: bản đồ, rồi dữ liệu cộng đồng, rồi điểm người dùng tự đánh dấu. */
const sourceRank = (p) => (p.kind === 'report' ? 2 : p.src === 'community' ? 1 : 0);
const sameThing = (a, b) => alertFamily(a) === alertFamily(b) && distance(a.coord, b.coord) <= ALERT_DUP_M;

/** Hướng (độ) của tuyến dẫn đường ở đoạn index; đoạn quá ngắn thì lấy đoạn kế tiếp. null nếu không có. */
function routeBearing(coords, index) {
  for (let i = Math.max(0, index); i < coords.length - 1 && i < index + 5; i++) {
    if (distance(coords[i], coords[i + 1]) >= 1) return bearing(coords[i], coords[i + 1]);
  }
  return null;
}

export class AlertEngine {
  constructor() {
    this.seen = new Map(); // id → thời điểm đã báo
    this.activeId = null;
  }

  /**
   * @param fix      { coord, speed (m/s), heading, time }
   * @param points   danh sách điểm { id, kind, coord, … }
   * @param settings cài đặt bật/tắt từng loại
   * @param nav      khi đang dẫn đường: { route, seg, s } để chỉ báo điểm nằm trên tuyến phía trước
   * @param opts     { roadLimit: giới hạn (km/h) của đường đang đi, chỉ để hiện kèm camera tốc độ không ghi giới hạn }
   * Điểm có hướng (camera của bản đồ, điểm đánh dấu có direction) chỉ báo khi đúng chiều (pointApplies). Nhiều điểm
   * cùng họ trong ALERT_DUP_M (bản đồ, cộng đồng, tự đánh dấu) chỉ báo một lần, sau khi đã lọc theo hướng: camera
   * của chiều bên kia không bao giờ làm mất cảnh báo của chiều xe đang đi.
   * @returns { active: { point, distance, info } | null, fired: boolean, say: string | null }
   */
  update(fix, points, settings, nav = null, { roadLimit: road = null } = {}) {
    const speed = fix.speed || 0;
    const reach = Math.max(300, Math.min(1200, speed * 22));
    const gps = isNum(fix.heading) && speed >= ALERT_MIN_SPEED ? fix.heading : null;
    const enabled = (p) => !(settings && settings[SETTING_OF[p.kind]] === false);
    const candidates = [];

    for (const p of points) {
      if (!enabled(p)) continue;
      const d = distance(fix.coord, p.coord);
      if (d > reach) {
        // Đi xa hẳn rồi thì lần sau quay lại vẫn được báo.
        if (d > 1500) this.seen.delete(p.id);
        continue;
      }
      let ahead = null;
      let heading = gps;
      if (nav) {
        const { route, seg, s } = nav;
        let to = seg + 1;
        while (to < route.coords.length - 1 && route.cum[to] - s < reach + 50) to++;
        const hit = nearestOnLine(p.coord, route.coords, seg, to);
        if (hit && hit.dist <= 40) {
          const along = route.cum[hit.index] + hit.t * (route.cum[hit.index + 1] - route.cum[hit.index]) - s;
          if (along >= -10 && along <= reach) {
            ahead = Math.max(0, along);
            // Điểm trên tuyến phía trước: so hướng của điểm với hướng tuyến tại đó, không với hướng xe lúc này.
            heading = routeBearing(route.coords, hit.index) ?? gps;
          }
        }
      } else if (d < 40) {
        ahead = d;
      } else if (fix.heading != null) {
        const diff = Math.abs(angleDiff(fix.heading, bearing(fix.coord, p.coord)));
        if (diff < 75 && d * Math.sin(diff * RAD) <= 45) ahead = d;
      }
      if (ahead == null) continue;
      if (!pointApplies(p, heading)) continue; // camera hay điểm của chiều đường bên kia, của đường cắt ngang
      candidates.push({ point: p, distance: ahead, heading });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    const current = candidates.find((c) => c.point.id === this.activeId);
    let fresh = null;
    let same = [];
    if (speed >= ALERT_MIN_SPEED) {
      const first = candidates.find((c) => !this.seen.has(c.point.id));
      if (first) {
        // Cùng một thứ có trong nhiều nguồn (bản đồ, cộng đồng, tự đánh dấu): chọn một điểm theo thứ tự ưu tiên.
        same = candidates.filter((c) => !this.seen.has(c.point.id) && sameThing(c.point, first.point));
        fresh = same.reduce((a, b) => (sourceRank(b.point) < sourceRank(a.point) ? b : a), first);
      }
    }

    let fired = false;
    let chosen = current || null;
    if (fresh && (!current || fresh.distance < current.distance)) {
      chosen = fresh;
      fired = true;
      for (const c of same) this.seen.set(c.point.id, fix.time);
      // Các điểm khác là cùng thứ đó (kể cả điểm chưa vào tầm báo, ở xa hơn vài mét) coi như đã báo: không báo lại.
      for (const p of points) {
        if (p.id === fresh.point.id || this.seen.has(p.id) || !enabled(p)) continue;
        if (sameThing(p, fresh.point) && pointApplies(p, fresh.heading)) this.seen.set(p.id, fix.time);
      }
    }
    this.activeId = chosen ? chosen.point.id : null;
    if (!chosen) return { active: null, fired: false, say: null };

    const info = describePoint(chosen.point, { roadLimit: road });
    return {
      active: { point: chosen.point, distance: chosen.distance, info, reach },
      fired,
      say: fired ? `Còn ${spokenDistance(chosen.distance)}, ${info.say}` : null,
    };
  }
}

// Biển tốc độ tối đa và biển hết hạn chế tốc độ tối đa: thuộc về "Đọc giới hạn tốc độ khi thay đổi".
const LIMIT_CODES = new Set(['P.127', 'P.127a', 'P.127b', 'P.127c', 'DP.127', 'DP.134']);

/**
 * Câu đọc cho các biển vừa đến lượt báo (kết quả SignEngine.update). Người dùng tắt "Đọc giới hạn tốc độ khi
 * thay đổi" (settings.speakLimit = false) thì câu không còn biển tốc độ tối đa; biển vẫn hiện trên màn hình.
 * @returns string | null
 */
export function signSpeech(result, settings = {}) {
  if (!result?.say) return null;
  if (settings.speakLimit !== false) return result.say;
  const keep = result.fired.filter((it) => !LIMIT_CODES.has(it.code));
  if (keep.length === result.fired.length) return result.say;
  // Như SignEngine.update: cùng một biển (cùng mã và trị số) chỉ đọc một lần, biển bản đồ trước (bản đồ thắng biển
  // camera cùng loại), biển camera sau, và câu "camera ghi nhận" chỉ nói một lần cho cả nhóm (joinSays).
  const parts = [];
  const seen = new Set();
  for (const camera of [false, true]) {
    for (const it of keep) {
      if (Boolean(it.src) !== camera || !it.say) continue;
      const dup = `${it.code ?? it.kind}|${it.value ?? ''}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
      parts.push(it);
    }
  }
  return parts.length ? `Phía trước ${spokenDistance(keep[0].distance)}, ${joinSays(parts)}` : null;
}

// ---------------------------------------------------------------------------------------------
// Đổi đường (dùng chung cho SpeedMonitor và CameraLimit)
// ---------------------------------------------------------------------------------------------

export const WAY_CONFIRM_FIXES = 2; // phải khớp đường mới chừng này lần liên tiếp mới đổi đường (tránh nhảy số ở giao lộ)
export const WAY_LOST_FIXES = 4; // chừng này lần định vị liền không khớp đường nào thì coi như không biết xe ở đường nào

// ---------------------------------------------------------------------------------------------
// Giới hạn tốc độ từ biển do camera ghi nhận (PLAN §5.9)
// ---------------------------------------------------------------------------------------------

// Biển tốc độ tối đa hết hiệu lực khi xe đi qua nút giao (khoản 26.8–26.9 QCVN 41:2024). Quy định này mới đọc qua
// nguồn thứ cấp, chưa đối chiếu bản gốc, nên để sau một cờ: tắt cờ thì đi thẳng qua nút giao vẫn giữ giới hạn.
export const CAMERA_LIMIT_ENDS_AT_JUNCTION = true;
// Đường nhập vào nút giao làm hết hiệu lực biển: hạng unclassified trở lên (RANK ≤ 6 của bộ máy biển báo). Các hạng
// nhỏ hơn (residential, living_street, service…) đứng thay cho "ngõ, ngách, hẻm" và lối vào khu dân cư, không làm hết.
export const JUNCTION_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
]);
export const CAMERA_LIMIT_CODE = 'P.127'; // biển tốc độ tối đa: biển đã xác nhận, không biển phụ, thì dùng cho đồng hồ
// Biển hết hiệu lực: hết tốc độ tối đa, hết tất cả các lệnh cấm. DP.127 chỉ hết P.127b/P.127c (theo làn, theo loại xe):
// hai biển đó chỉ để xem, không vào đồng hồ, nên DP.127 không làm gì ở đây.
export const CAMERA_LIMIT_END_CODES = new Set(['DP.134', 'DP.135']);
export const CAMERA_LIMIT_GAP = 300; // hai lần cập nhật cách nhau quá chừng này (m): không biết xe đã qua đâu, thôi giới hạn
// Ở nút giao: xe đi tiếp cùng con đường khi đổi hướng không quá chừng này (độ) và đường mới cùng tên đường cũ, hoặc
// không có nhánh nào của đường từ unclassified trở lên thẳng hơn. Ngược lại là rẽ sang đường khác: thôi giới hạn.
export const CAMERA_LIMIT_THROUGH_ANGLE = 45;
export const CAMERA_LIMIT_VERTEX_NEAR = 100; // đỉnh chung của đường cũ và đường mới cách xe không quá chừng này (m)
export const CAMERA_LIMIT_LATERAL = 25; // biển (và hành lang) cách đường xe đi, theo phương ngang, không quá chừng này (m)
export const CAMERA_LIMIT_AHEAD = 60; // tin "thấy lại" đến khi biển còn ở phía trước không quá chừng này (m): đợi xe qua biển
export const CAMERA_LIMIT_BEHIND = 150; // biển đã ở sau lưng xe quá chừng này (m): tin quá cũ, bỏ
export const CAMERA_LIMIT_PENDING_MAX = 8; // giữ tối đa chừng này tin chờ (biển chưa qua, đường mới chưa chắc)
export const CAMERA_LIMIT_HEADING_SPEED = 2.5; // xe nhanh hơn chừng này (m/s) thì hướng đi của GPS mới dùng được (như matchWay)
// Đang dùng giới hạn camera: đọc lại các biển bản đồ phía trước sau mỗi chừng này (m) xe đi, và trước khi xe còn
// chừng này là hết phần hành lang đã đọc.
export const CAMERA_LIMIT_OSM_REFRESH = 100;
export const CAMERA_LIMIT_CORRIDORS = 20; // giữ chừng này hành lang gần nhất để xem bản đồ có biển nào giữa biển camera và xe

const PASSED_OUTCOMES = new Set(['hit', 'miss', 'none']);

const vertexCount = (way) => way.g.length >> 1;
const vertexOf = (way, i) => [way.g[2 * i], way.g[2 * i + 1]];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lengthOf = (corr) => (corr.cum && corr.cum.length ? corr.cum[corr.cum.length - 1] : 0);
/** Biển bản đồ làm hết giới hạn của camera: một biển tốc độ tối đa khác (thay), DP.134, DP.135. */
const endsCameraLimit = (code) => code === CAMERA_LIMIT_CODE || CAMERA_LIMIT_END_CODES.has(code);

/** Trị số km/h của biển tốc độ tối đa (chuỗi '50' hay số 50) trong khoảng học được, hoặc null. */
function limitValue(v) {
  const n = typeof v === 'number' ? v : /^\d{2,3}$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= SPEED_MIN && n <= SPEED_MAX ? n : null;
}

/** Hướng (độ) của nhánh đường đi ra từ đỉnh i theo chiều step (±1), đo theo dây cung ARM_CHORD m; null nếu hết đường. */
function armBearing(way, i, step) {
  const n = vertexCount(way);
  let k = i + step;
  if (k < 0 || k >= n) return null;
  const v = vertexOf(way, i);
  while (distance(v, vertexOf(way, k)) < ARM_CHORD && k + step >= 0 && k + step < n) k += step;
  return bearing(v, vertexOf(way, k));
}

/** Các nhánh đường toả ra từ đỉnh v → [{ way, i, step, brg }] (cách đếm như armsAt của bộ máy biển báo). */
function armsOf(roads, v) {
  const out = [];
  for (const { way, i } of roads.waysAtVertex(v)) {
    for (const step of [-1, 1]) {
      const brg = armBearing(way, i, step);
      if (brg != null) out.push({ way, i, step, brg });
    }
  }
  return out;
}

/** Nhánh của đường wayId tại đỉnh, theo chiều step; đường khép kín có hai chỉ số thì lấy chỉ số gần i nhất. */
function armFor(arms, wayId, i, step) {
  let best = null;
  for (const a of arms) {
    if (a.way.id !== wayId || a.step !== step) continue;
    if (!best || Math.abs(a.i - i) < Math.abs(best.i - i)) best = a;
  }
  return best;
}

/** Có nhánh nào ngoài nhánh xe đi vào và đi ra thuộc một đường hạng unclassified trở lên không. */
const majorSideArm = (arms, inArm, outArm) =>
  arms.some((a) => a !== inArm && a !== outArm && JUNCTION_ROADS.has(a.way.h));

/**
 * Giới hạn tốc độ lấy từ biển do camera trên xe ghi nhận (PLAN §5.9). Chỉ bắt đầu khi bộ học báo xe vừa đi qua một
 * biển P.127 đã xác nhận, không có biển phụ, nằm trên đường xe đang đi và đúng chiều đi (Learner.onPassed). Hết khi:
 * - qua biển DP.134 hay DP.135 (do camera ghi nhận hoặc có trên bản đồ);
 * - qua một biển tốc độ tối đa khác: biển camera đã xác nhận thay trị số, biển có biển phụ hay biển trên bản đồ thì
 *   thôi giới hạn (bản đồ được ưu tiên);
 * - đi thẳng qua nút giao có đường từ unclassified trở lên nhập vào (CAMERA_LIMIT_ENDS_AT_JUNCTION), dù đường OSM có
 *   tách ở đó hay không;
 * - đổi sang đường khác mà không phải đi tiếp cùng con đường (đường tách đôi ở đỉnh chỉ có 2 nhánh, hay đi thẳng qua
 *   nút giao): rẽ, nhảy sang đường song song, quay đầu;
 * - không còn khớp đường (ra khỏi dữ liệu), vị trí nhảy xa, chạy thử, hoặc reset() (rời chế độ lái, chuyến mới).
 * Biển chưa xác nhận (kể cả lần đầu camera thấy) không bao giờ đổi đồng hồ tốc độ.
 *
 * Gọi update() mỗi lần định vị, sau learner.onFix() của cùng lần định vị (gọi trước thì chỉ chậm một lần định vị):
 * tin của onPassed() được xét ở lần update() kế tiếp, theo vị trí của xe lúc đó.
 */
export class CameraLimit {
  /** @param endsAtJunction  mặc định CAMERA_LIMIT_ENDS_AT_JUNCTION (đổi được khi kiểm thử) */
  constructor({ endsAtJunction = CAMERA_LIMIT_ENDS_AT_JUNCTION } = {}) {
    this.endsAtJunction = endsAtJunction;
    this.reset();
  }

  /** Giới hạn đang dùng { n (km/h), wayId (đường xe đang đi), since (fix.time lúc bắt đầu) } hoặc null. */
  get current() {
    return this.cur;
  }

  /** Quên hết (rời chế độ lái, chuyến mới, đổi loại xe). */
  reset() {
    this.cur = null;
    this.curAt = 0; // vị trí biển của giới hạn đang dùng trên đồng hồ quãng đường (m)
    this.pending = []; // tin onPassed chưa xét xong
    this.D = 0; // đồng hồ quãng đường riêng (m)
    this.last = null; // { coord } của lần update() trước
    this.floor = -Infinity; // giới hạn chỉ bắt đầu từ biển nằm sau mốc này (nút giao, đổi đường, biển hết hiệu lực)
    this.way = null; // id đường xe đang đi (đã chắc)
    this.wayObj = null;
    this.ways = new Map(); // id các đường của cùng con đường từ mốc gần nhất → vị trí lần cuối xe ở trên đó (m)
    this.f = null; // vị trí xe trên đường theo chỉ số đỉnh (seg + t), chỉ tiến theo chiều đi
    this.dir = 0; // +1/−1: chiều đi so với chiều vẽ đường
    this.reverse = 0; // số lần liên tiếp khớp ngược chiều trên cùng đường
    this.lastOn = null; // { D, coord } lần định vị gần nhất trên đường đang đi
    this.miss = 0;
    this.candidate = null; // { way, count, firstD, firstCoord, f, dir }: đường mới chưa chắc
    this.osm = []; // vị trí (m) các biển bản đồ phía trước làm hết giới hạn
    this.osmUntil = -Infinity; // đọc lại biển bản đồ khi đồng hồ quãng đường tới mốc này
    this.corridors = []; // [{ corr, ref }] hành lang gần đây; ref = vị trí đầu hành lang trên đồng hồ quãng đường
  }

  /**
   * Tin từ Learner.onPassed: { record, outcome: 'hit'|'miss'|'none', reason }. Chỉ biển đã xác nhận được nghe:
   * P.127 không biển phụ (bắt đầu hay thay giới hạn), P.127 có biển phụ (thôi giới hạn), DP.134/DP.135 (hết).
   * Mọi kết quả đi qua đều tính, kể cả 'none' ('late', camera tắt…) và 'miss', trừ 'none' lý do 'left' (xe chưa tới
   * biển), 'miss' lý do 'value' (camera vừa đọc một trị số khác ở đúng chỗ đó: biển đã đổi, không dùng trị số cũ) và
   * 'none' lý do 'conflict' có valueChanged (camera thấy, dù chưa đủ tin, cùng mã khác trị số ở đó). 'conflict' do biển
   * khác mã cùng họ (P.103a cạnh P.127) vẫn được tính.
   * @returns true khi tin được giữ lại để xét
   */
  onPassed(evt) {
    const r = evt?.record;
    if (!r || typeof r !== 'object' || r.status !== 'confirmed') return false;
    if (!PASSED_OUTCOMES.has(evt.outcome)) return false;
    if (evt.outcome === 'none' && evt.reason === 'left') return false;
    if (evt.outcome === 'miss' && evt.reason === 'value') return false;
    if (evt.outcome === 'none' && evt.reason === 'conflict' && evt.valueChanged === true) return false;
    if (!Array.isArray(r.coord) || !isNum(r.coord[0]) || !isNum(r.coord[1]) || !isNum(r.facing)) return false;
    let kind;
    let n = null;
    if (r.code === CAMERA_LIMIT_CODE) {
      n = r.plate == null ? limitValue(r.value) : null;
      kind = n != null ? 'start' : 'end';
    } else if (CAMERA_LIMIT_END_CODES.has(r.code)) {
      kind = 'end';
    } else {
      return false;
    }
    this.pending.push({ kind, n, coord: r.coord, facing: r.facing, wayId: r.wayId ?? null, fresh: true });
    if (this.pending.length > CAMERA_LIMIT_PENDING_MAX) this.pending.shift();
    return true;
  }

  /**
   * @param fix    { coord, speed (m/s), heading, time, simulated }
   * @param match  kết quả RoadData.matchWay cho lần định vị này (hoặc null)
   * @param ctx    { roads: RoadData (nút giao), corridor: signs.lastCorridor (biển bản đồ phía trước), hasData,
   *                 vehicle, now: Date }
   * @returns current
   */
  update(fix, match, { roads = null, corridor = null, hasData = true, vehicle = 'car', now = null } = {}) {
    if (!fix || !Array.isArray(fix.coord)) return this.cur;
    if (fix.simulated) {
      // Chạy thử: không dùng dữ liệu camera.
      this.reset();
      return null;
    }
    const step = this.last ? distance(this.last.coord, fix.coord) : 0;
    this.D += step;
    this.last = { coord: fix.coord };
    if (step > CAMERA_LIMIT_GAP) this.#lose();

    this.#track(fix, match, roads, hasData);
    for (const [id, at] of this.ways) if (id !== this.way && this.D - at > CAMERA_LIMIT_BEHIND) this.ways.delete(id);

    const opts = { roads, vehicle, now: now ?? new Date(isNum(fix.time) ? fix.time : Date.now()) };
    this.#keep(corridor, fix.coord);
    // Đường mới chưa chắc: đợi lần sau mới xét tin, để biết xe đã sang đường nào.
    if (this.candidate == null) this.#judgeAll(fix, opts);
    if (this.cur && this.#osmPassed(corridor, fix.coord, opts)) this.#end();
    return this.cur;
  }

  // ---- Đường xe đi ----

  #track(fix, match, roads, hasData) {
    if (!match || !match.way) {
      if (++this.miss >= WAY_LOST_FIXES || !hasData) this.#lose();
      return;
    }
    this.miss = 0;
    const way = match.way;
    const f = isNum(match.seg) ? match.seg + (isNum(match.t) ? match.t : 0) : null;
    const dir = match.dir === 1 || match.dir === -1 ? match.dir : 0;
    if (this.way == null) {
      this.way = way.id;
      this.wayObj = way;
      this.f = f;
      this.dir = dir;
      this.reverse = 0;
      this.candidate = null;
    } else if (way.id === this.way) {
      this.candidate = null;
      this.wayObj = way;
      this.#along(fix, way, f, dir, roads);
    } else {
      // Xe chậm (không có chiều đi): khớp đường chỉ theo khoảng cách, ở giữa nút giao hay nhảy sang đường ngang. Chỉ
      // tính đổi đường khi xe đã chạy.
      if (!dir) return;
      const c = this.candidate;
      if (c && c.way.id === way.id) {
        c.count++;
        c.f = f;
        c.dir = dir;
      } else {
        this.candidate = { way, count: 1, firstD: this.D, firstCoord: fix.coord, f, dir };
      }
      if (this.candidate.count >= WAY_CONFIRM_FIXES) this.#switch(roads);
    }
    if (this.candidate == null) {
      this.lastOn = { D: this.D, coord: fix.coord };
      this.ways.set(this.way, this.D);
    }
  }

  /** Vẫn trên đường cũ: quay đầu (khớp ngược chiều liên tiếp) thì thôi; đi qua nút giao lớn thì thôi (theo cờ). */
  #along(fix, way, f, dir, roads) {
    if (!dir) return; // xe chậm, không biết chiều: đợi
    if (this.dir && dir !== this.dir) {
      if (++this.reverse >= WAY_CONFIRM_FIXES) {
        this.#mark(this.D);
        this.dir = dir;
        this.f = f;
        this.reverse = 0;
      }
      return;
    }
    this.reverse = 0;
    this.dir = dir;
    if (f == null) return;
    if (this.f == null || (f - this.f) * dir <= 0) {
      // Lần đầu, hoặc vị trí lùi lại vài mét theo nhiễu GPS: giữ vị trí đã tiến xa nhất.
      if (this.f == null) this.f = f;
      return;
    }
    const v = this.endsAtJunction ? this.#junctionCrossed(roads, way, this.f, f, dir) : null;
    if (v) this.#mark(this.#atVertex(v, this.D));
    this.f = f;
  }

  /** Đỉnh nút giao lớn đầu tiên xe vừa đi qua trên cùng một đường (giữa vị trí f0 và f1), hoặc null. */
  #junctionCrossed(roads, way, f0, f1, dir) {
    if (!roads) return null;
    const n = vertexCount(way);
    const from = dir > 0 ? Math.floor(f0) + 1 : Math.ceil(f0) - 1;
    const to = dir > 0 ? Math.floor(f1) : Math.ceil(f1);
    for (let k = from; dir > 0 ? k <= to : k >= to; k += dir) {
      if (k <= 0 || k >= n - 1) continue; // đầu mút: đổi đường, xét ở #switch
      const v = vertexOf(way, k);
      const arms = armsOf(roads, v);
      if (arms.length < 3) continue;
      const inArm = armFor(arms, way.id, k, -dir);
      const outArm = armFor(arms, way.id, k, dir);
      if (majorSideArm(arms, inArm, outArm)) return v;
    }
    return null;
  }

  /** Đường mới đã chắc: đi tiếp cùng con đường thì giữ giới hạn, không thì thôi. */
  #switch(roads) {
    const c = this.candidate;
    const tr = this.#transition(roads, this.wayObj, this.f, this.dir, c);
    const base = this.lastOn ?? { D: c.firstD, coord: c.firstCoord };
    const at = tr.at ? clamp(base.D + distance(base.coord, tr.at), base.D, c.firstD) : c.firstD;
    const keep = tr.kind === 'split' || (tr.kind === 'through' && !(this.endsAtJunction && tr.major));
    this.way = c.way.id;
    this.wayObj = c.way;
    this.f = c.f;
    this.dir = c.dir;
    this.reverse = 0;
    this.candidate = null;
    if (!keep) this.#mark(at);
    else if (this.cur) this.cur = Object.freeze({ ...this.cur, wayId: this.way });
  }

  /**
   * Kiểu chuyển từ đường A sang đường mới (c.way) ở đỉnh chung gần xe nhất:
   * 'split' (đỉnh chỉ có 2 nhánh: cùng con đường bị tách đôi), 'through' (nút giao, đi thẳng qua; major: có đường
   * hạng unclassified trở lên nhập vào), 'turn' (rẽ sang đường khác), 'break' (không có đỉnh chung: nhảy sang đường khác).
   */
  #transition(roads, A, fA, dirA, c) {
    const B = c.way;
    if (!roads || !A || !B || !this.lastOn) return { kind: 'break', at: null, major: false };
    let best = null;
    for (let i = 0; i < vertexCount(A); i++) {
      const v = vertexOf(A, i);
      const dA = distance(v, this.lastOn.coord);
      const dB = distance(v, c.firstCoord);
      const d = dA + dB; // đỉnh nằm giữa lần định vị cuối trên A và lần đầu trên đường mới thì tổng nhỏ nhất
      if (Math.max(dA, dB) > CAMERA_LIMIT_VERTEX_NEAR || (best && d >= best.d)) continue;
      const onB = roads.waysAtVertex(v).find((e) => e.way.id === B.id);
      if (onB) best = { d, v, iA: i, iB: onB.i };
    }
    if (!best) return { kind: 'break', at: null, major: false };
    const arms = armsOf(roads, best.v);
    if (arms.length <= 2) return { kind: 'split', at: best.v, major: false };
    // Nhánh xe đi vào: phía xe đến (vị trí trên A trước đỉnh chung); nhánh đi ra: phía xe đang ở trên B.
    const inStep = fA != null && fA !== best.iA ? Math.sign(fA - best.iA) : -(dirA || 1);
    const outStep = c.f != null && c.f !== best.iB ? Math.sign(c.f - best.iB) : c.dir || 1;
    const inArm = armFor(arms, A.id, best.iA, inStep);
    const outArm = armFor(arms, B.id, best.iB, outStep);
    if (!inArm || !outArm) return { kind: 'turn', at: best.v, major: false };
    const travel = (inArm.brg + 180) % 360;
    const dev = (a) => Math.abs(angleDiff(travel, a.brg));
    const turn = dev(outArm);
    // Cùng tên đường (khác rỗng) là đi tiếp cùng con đường. Không thì phải là nhánh thẳng nhất, không tính ngõ
    // (đường chính ngoặt nhẹ ở chỗ có ngõ đi thẳng vẫn là đi tiếp đường chính).
    const sameName = Boolean(A.n) && A.n === B.n;
    const straighter = arms.some((a) => a !== inArm && a !== outArm && JUNCTION_ROADS.has(a.way.h) && dev(a) < turn);
    const major = majorSideArm(arms, inArm, outArm);
    const through = turn <= CAMERA_LIMIT_THROUGH_ANGLE && (sameName || !straighter);
    return { kind: through ? 'through' : 'turn', at: best.v, major };
  }

  /** Vị trí trên đồng hồ quãng đường của đỉnh v xe vừa đi qua (giữa lần định vị trước trên đường và bây giờ). */
  #atVertex(v, upTo) {
    const base = this.lastOn;
    if (!base) return upTo;
    return clamp(base.D + distance(base.coord, v), base.D, upTo);
  }

  /** Một mốc làm hết giới hạn ở vị trí at (m): nút giao, rẽ, quay đầu, hay biển hết hiệu lực. */
  #mark(at) {
    if (this.cur && at > this.curAt) this.#end();
    this.floor = Math.max(this.floor, at);
    this.ways = new Map(this.way != null ? [[this.way, this.D]] : []);
  }

  /** Không còn biết xe ở đường nào. */
  #lose() {
    this.#end();
    this.floor = Math.max(this.floor, this.D);
    this.way = null;
    this.wayObj = null;
    this.ways = new Map();
    this.f = null;
    this.dir = 0;
    this.reverse = 0;
    this.lastOn = null;
    this.candidate = null;
  }

  #end() {
    this.cur = null;
    this.osm = [];
    this.osmUntil = -Infinity;
  }

  // ---- Tin từ bộ học ----

  #judgeAll(fix, opts) {
    const keep = [];
    for (const e of this.pending) if (this.#judge(e, fix, opts)) keep.push(e);
    this.pending = keep;
  }

  /** Xét một tin theo vị trí xe bây giờ. @returns true khi còn phải đợi */
  #judge(e, fix, opts) {
    const travel = travelFor(e.facing);
    const moving = isNum(fix.heading) && (fix.speed || 0) >= CAMERA_LIMIT_HEADING_SPEED;
    if (moving && Math.abs(angleDiff(fix.heading, travel)) > APPLY_ANGLE) return false; // ngược chiều, đã rẽ đi
    const d = distance(fix.coord, e.coord);
    const rel = d > 0 ? angleDiff(travel, bearing(fix.coord, e.coord)) * RAD : 0;
    const along = d * Math.cos(rel); // > 0: biển còn ở phía trước
    if (Math.abs(d * Math.sin(rel)) > CAMERA_LIMIT_LATERAL) return false; // không nằm trên đường xe đi
    if (along > 0) {
      // "Thấy lại" được báo khi camera vừa đọc xong biển, trước khi xe tới biển: đợi xe qua.
      if (e.fresh && along > CAMERA_LIMIT_AHEAD) return false;
      e.fresh = false;
      return true;
    }
    if (-along > CAMERA_LIMIT_BEHIND) return false;
    const at = this.D + along;
    if (at <= this.floor) return false; // đã qua nút giao, đổi đường hay biển hết hiệu lực sau biển này
    if (e.kind === 'end') {
      if (this.cur && at > this.curAt) this.#end();
      this.floor = Math.max(this.floor, at);
      return false;
    }
    if (this.way == null) return false; // không biết xe đang ở đường nào
    if (e.wayId != null && !this.ways.has(e.wayId)) return false; // biển của đường khác
    if (this.cur && at <= this.curAt) return false; // biển cũ hơn biển đang dùng
    if (this.#osmBetween(at, this.D, opts)) return false; // bản đồ có biển khác giữa biển này và xe
    // Biển nhắc lại cùng trị số (hai bên đường, sau nút giao nhỏ): giữ nguyên giới hạn đang dùng và lúc bắt đầu.
    if (!this.cur || this.cur.n !== e.n) {
      this.cur = Object.freeze({ n: e.n, wayId: this.way, since: isNum(fix.time) ? fix.time : null });
    }
    this.curAt = at;
    this.osm = [];
    this.osmUntil = -Infinity;
    return false;
  }

  // ---- Biển trên bản đồ ----

  /** Vị trí đầu hành lang trên đồng hồ quãng đường, hoặc null khi xe không nằm trên hành lang. */
  #refOf(corr, coord) {
    if (!corr || !Array.isArray(corr.coords) || corr.coords.length < 2 || !Array.isArray(corr.cum)) return null;
    const loc = locate(corr, coord);
    return loc && loc.d <= CAMERA_LIMIT_LATERAL ? this.D - loc.s : null;
  }

  #keep(corr, coord) {
    if (!corr || this.corridors.some((k) => k.corr === corr)) return;
    const ref = this.#refOf(corr, coord);
    if (ref == null) return;
    this.corridors.push({ corr, ref });
    if (this.corridors.length > CAMERA_LIMIT_CORRIDORS) this.corridors.shift();
  }

  /** Vị trí (m) các biển bản đồ làm hết giới hạn trên hành lang, tính từ ref. */
  #enders(corr, ref, { roads, vehicle, now }) {
    if (!roads) return [];
    try {
      return mapItems(corr, roads, { vehicle, now })
        .filter((it) => endsCameraLimit(it.code))
        .map((it) => ref + it.distance);
    } catch {
      return []; // dữ liệu bản đồ lạ: bỏ qua, giữ giới hạn (thấp hơn)
    }
  }

  /** Bản đồ có biển làm hết giới hạn nằm trong (lo, hi] không (xem trên hành lang gần nhất dựng trước khi tới lo). */
  #osmBetween(lo, hi, opts) {
    for (let k = this.corridors.length - 1; k >= 0; k--) {
      const { corr, ref } = this.corridors[k];
      if (ref > lo) continue;
      return this.#enders(corr, ref, opts).some((p) => p > lo && p <= hi);
    }
    return false;
  }

  /** Đang dùng giới hạn camera: xe vừa qua một biển bản đồ làm hết giới hạn chưa. */
  #osmPassed(corr, coord, opts) {
    if (this.D >= this.osmUntil) {
      const ref = this.#refOf(corr, coord);
      if (ref != null) {
        this.osm = this.#enders(corr, ref, opts);
        const end = ref + lengthOf(corr) - CAMERA_LIMIT_OSM_REFRESH;
        this.osmUntil = Math.max(this.D, Math.min(this.D + CAMERA_LIMIT_OSM_REFRESH, end));
      }
    }
    return this.osm.some((p) => p > this.curAt && p <= this.D);
  }
}

/** Trị số km/h của giới hạn camera truyền vào SpeedMonitor (CameraLimit.current hoặc một số), hoặc null. */
function cameraValue(camera) {
  if (camera == null) return null;
  return limitValue(typeof camera === 'number' ? camera : camera.n);
}

/** Câu nhắc quá tốc độ; giới hạn lấy từ biển do camera ghi nhận thì nói rõ như vậy. */
export function overSpeedSay(sp) {
  const base = `Bạn đang chạy quá tốc độ. Giới hạn ${sp.limit} ki lô mét trên giờ`;
  return sp.source === 'camera' ? `${base} (camera ghi nhận)` : base;
}

/** Giữ giới hạn tốc độ ổn định giữa các lần định vị và phát cảnh báo khi chạy quá. */
export class SpeedMonitor {
  constructor() {
    this.limit = null; // giới hạn của đoạn đường hiện tại (km/h)
    this.wayId = null;
    this.way = null; // đường đang đi (đã chắc)
    this.dir = 0; // chiều đi đã biết trên đường đó (+1/−1), 0 khi chưa biết
    this.candidate = null;
    this.candidateCount = 0;
    this.missCount = 0;
    this.overSince = 0;
    this.lastVoice = 0;
    this.lastBeep = 0;
    this.cleared = false;
    this.announced = null;
  }

  /**
   * @param match     kết quả RoadData.matchWay (hoặc null)
   * @param camera    giới hạn từ biển do camera ghi nhận (CameraLimit.current, hoặc một số km/h), hoặc null
   * @param camSpeed  cài đặt "Dùng biển tốc độ do camera ghi nhận cho đồng hồ tốc độ"; false thì bỏ qua camera
   * @param now       Date cho giới hạn theo giờ (maxspeed:conditional); mặc định lấy theo fix.time
   * Giới hạn của đường tính theo chiều đi (roadLimit): maxspeed:forward/backward theo chiều đã biết trên đường đó (giữ
   * khi xe dừng), chưa biết chiều thì số nhỏ hơn.
   * Giới hạn hiện ra là min(bản đồ ?? tốc độ tối đa tự đặt, camera): camera không bao giờ nâng giới hạn, kể cả giới
   * hạn tự đặt (customMax, chỉ dùng khi bản đồ không có). source là 'camera' chỉ khi trị số của camera thấp hơn hẳn
   * (hoặc cả bản đồ lẫn tự đặt đều không có).
   * @returns { limit, source: 'road'|'camera'|'custom'|null, level: 'ok'|'near'|'over', sound: null|'voice'|'beep',
   *            announce: number|null }
   */
  update(fix, match, { vehicle = 'car', tolerance = 3, customMax = 0, hasData = true, camera = null, camSpeed = true, now = null } = {}) {
    const when = now instanceof Date ? now : new Date(isNum(fix.time) ? fix.time : Date.now());
    if (match) {
      this.missCount = 0;
      const dir = match.dir === 1 || match.dir === -1 ? match.dir : 0;
      if (match.way.id === this.wayId) {
        this.candidate = null;
        this.way = match.way;
        if (dir) this.dir = dir;
      } else {
        // Phải khớp hai lần liên tiếp mới đổi đường, tránh nhảy số khi qua giao lộ.
        if (this.candidate === match.way.id) this.candidateCount++;
        else {
          this.candidate = match.way.id;
          this.candidateCount = 1;
        }
        if (this.candidateCount >= WAY_CONFIRM_FIXES || this.wayId == null) {
          this.wayId = match.way.id;
          this.way = match.way;
          this.dir = dir;
          this.candidate = null;
        }
      }
      // Tính lại mỗi lần: chiều đi có thể mới biết, khung giờ có thể vừa bắt đầu hay vừa hết.
      if (this.way) this.limit = roadLimit(this.way, vehicle, this.dir, when);
    } else if (++this.missCount >= WAY_LOST_FIXES || !hasData) {
      this.wayId = null;
      this.way = null;
      this.dir = 0;
      this.limit = null;
    }

    const kmh = (fix.speed || 0) * 3.6;
    const road = this.limit;
    const cam = camSpeed === false ? null : cameraValue(camera);
    // Giới hạn nền: của đường, không có thì tốc độ tối đa tự đặt. Camera chỉ được hạ giới hạn nền, không bao giờ nâng.
    const base = road != null ? road : customMax > 0 ? customMax : null;
    let limit = base;
    let source = road != null ? 'road' : base != null ? 'custom' : null;
    if (cam != null && (base == null || cam < base)) {
      limit = cam;
      source = 'camera';
    }

    // Đọc giới hạn của đường khi đổi. Đang hiện giới hạn thấp hơn của camera thì không đọc số của đường (khác số đang
    // hiện); biển camera đã được bộ máy biển báo đọc trước, kèm lời rào.
    let announce = null;
    if (road == null) {
      this.announced = null;
    } else if (source !== 'camera' && road !== this.announced && kmh > 15) {
      announce = road;
      this.announced = road;
    }

    let level = 'ok';
    let sound = null;
    if (limit != null && kmh > limit + 0.5) {
      level = kmh > limit + tolerance ? 'over' : 'near';
    }
    if (level === 'over') {
      if (!this.overSince) this.overSince = fix.time;
      if (fix.time - this.overSince >= 1500) {
        // Nhắc bằng lời lần đầu, sau đó chỉ kêu bíp; nhắc lời lại nếu vẫn chạy quá sau 45 giây
        // hoặc vừa giảm xuống rồi lại vượt (cách lần nhắc trước ít nhất 15 giây).
        const since = fix.time - this.lastVoice;
        if (!this.lastVoice || since > 45000 || (this.cleared && since > 15000)) {
          sound = 'voice';
          this.lastVoice = fix.time;
          this.lastBeep = fix.time;
        } else if (fix.time - this.lastBeep > 6000) {
          sound = 'beep';
          this.lastBeep = fix.time;
        }
        this.cleared = false;
      }
    } else {
      this.overSince = 0;
      if (level === 'ok') this.cleared = true;
    }

    return { limit, source, level, sound, announce };
  }
}
