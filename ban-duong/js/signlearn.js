// Bộ học biển báo từ camera (thử nghiệm). Thuần logic, mọi phụ thuộc được truyền vào (kho biển, dữ liệu đường,
// đồng hồ, các hàm hình học của bộ máy cảnh báo), chạy được trong Node.
// 1. Mỗi lần định vị: đổi thời điểm định vị (giờ của GPS) sang đồng hồ đơn điệu của trang, cộng dồn quãng đường xe
//    đi (tốc độ do xe báo khi còn mới, không thì tốc độ GPS), giữ các hành lang của bộ máy cảnh báo trong 15 giây.
// 2. Mỗi khung camera đã xử lý: nội suy vị trí xe lúc chụp (ngoại suy tối đa 1,5 giây sau lần định vị cuối), đưa vào
//    Tracker; lượt bám kết thúc thì xét các bước lọc, đặt biển lên hành lang (neo vào nút giao với biển của nút giao,
//    đánh dấu "chưa chắc" khi đường rẽ nhánh ngay sau biển) rồi ghi vào kho. Camera ngừng gửi khung quá 2 giây (tạm
//    dừng khi xe chậm, tắt, trang bị ẩn) thì các lượt bám đang mở được kết thúc và xét ngay.
// 3. Xét từng lượt đi qua các biển đã học theo đúng chiều, trên đúng con đường của biển: thấy lại, không thấy đủ điều
//    kiện (trừ điểm), hoặc không đủ bằng chứng (camera tắt hay ngừng giữa chừng, trời tối, kẹt xe…: không đổi điểm).
// Lần định vị mô phỏng ("Chạy thử") bị bỏ qua.

import { angleDiff, bearing, distance } from './geo.js';
import { vertexKey } from './roaddata.js';
import * as SE from './signengine.js';
import {
  acceptTrack,
  classified,
  defaultFoe,
  DEFAULT_HEIGHT,
  DEFAULT_HFOV,
  DEFAULT_WIDTH,
  FIX_ACCURACY_MAX,
  fitRange,
  focalPx,
  LUM_MEAN_MAX,
  LUM_MEAN_MIN,
  LUM_STD_MIN,
  lumOk,
  majorityLabel,
  Tracker,
} from './signtrack.js';
import { appliesTo, labelIndex, labelOf, MATCH_ALONG, MATCH_FACING, MATCH_LATERAL } from './learnedsigns.js';

// ---- Đồng hồ và vị trí xe ----
export const FIX_AGE_MAX = 3000; // tuổi lần định vị (ms) ngoài 0…chừng này là đồng hồ máy lệch giờ GPS: lấy lúc nhận
export const EXTRAPOLATE_MS = 1500; // khung chụp sau lần định vị cuối quá chừng này thì không có vị trí xe
export const FIX_GAP_MAX = 3000; // hai lần định vị cách nhau quá chừng này (ms) thì không nội suy giữa chúng
export const FIX_KEEP_MS = 30000; // giữ lịch sử định vị chừng này (ms)
// Giữ hành lang của các lần định vị trong chừng này (ms) để đặt biển: lượt bám kết thúc muộn (camera ngừng giữa
// chừng) vẫn đặt được, và bước 13 nhìn được 30 m sau lưng xe kể cả khi xe đi chậm (3 m/s cần 10 giây).
export const CORRIDOR_KEEP_MS = 15000;
export const CORRIDORS_MAX = 60; // … nhưng không quá chừng này hành lang (định vị dày hơn 1 lần/giây)
export const FRAME_GAP_MS = 2000; // không có khung nào chừng này (ms): camera đã ngừng, lượt bám đang mở bị kết thúc

// ---- Đặt biển (PLAN §5.7) ----
export const JUNCTION_SETBACK = 10; // biển của nút giao đặt trước nút giao chừng này (m) nếu ước tính gần hơn
// Không có nút giao trong 40 m phía trước mà có một nút giao ngay sau lưng ước tính (trong chừng này, m): sai số GPS
// đã đẩy biển qua nút giao nó canh; vẫn neo vào nút giao đó.
export const JUNCTION_BEHIND = 5;
export const FORK_AHEAD = 60; // đường rẽ nhánh trong chừng này (m) sau biển, về phía biển: "chưa chắc"
export const FORK_ANGLE = 45; // nhánh lệch không quá chừng này (độ) so với hướng đi mới tính là rẽ nhánh
export const ARM_SAME = 15; // nhánh lệch dưới chừng này (độ) so với chính hành lang là hành lang, không phải nhánh
export const ARM_CHORD = 10; // hướng của hành lang trước và sau nút giao đo theo dây cung dài chừng này (m)
export const SIDE_MIN = 1.5; // lệch ngang dưới chừng này (m): biển treo trên đường, không rõ phía
export const OSM_DUP_RADIUS = 30; // bản đồ có biển cùng loại cách chừng này (m) theo cùng chiều: không học (bước 13)
export const WAY_SLACK = 25; // các đường của hành lang trong chừng này (m) quanh biển là "đường của biển" (cùng MATCH_ALONG)
export const PARALLEL_NEAR = 15; // đường khác cùng chiều trong chừng này (m) quanh biển: không biết xe ở đường nào
// … trừ khi nó nối tiếp một đường của hành lang ở một đầu mút chung (OSM tách con đường ở nút giao) và lệch hướng không
// quá chừng này (độ): đó là chính con đường đi tiếp, không phải đường song song.
export const CONTINUE_ANGLE = 20;
export const SUN_DAY = 5; // mặt trời cao hơn chừng này (độ) là ban ngày
export const POS_ERR_MIN = 2; // sai số vị trí nhỏ nhất gán cho một lần thấy (m)
export const ACCURACY_TO_SIGMA = 1.5; // sai số định vị của máy (bán kính) chia chừng này ≈ 1σ theo một trục

// ---- Xét lượt đi qua (PLAN §5.8) ----
// Biển hiện trên hành lang lần đầu cách xe ít nhất chừng này (m) mới được xét đủ (có thể trừ điểm). Gần hơn (xe vừa
// rẽ vào đường): chỉ theo dõi, đi qua thì báo 'none' lý do 'late' (CameraLimit vẫn biết), không bao giờ trừ điểm.
export const ARM_AHEAD = 40;
export const REC_LATERAL = 8; // biển đã học nằm trên tim đường: lệch ngang tối đa so với hành lang (m)
export const APPLY_ANGLE = 60; // hướng đi lệch hướng áp dụng của biển không quá chừng này (độ), như bộ máy cảnh báo
export const WIN_NEAR = 12; // cửa sổ xét: từ khoảng cách biển đạt 20 px …
export const CLS_MIN_PX = 20; // … tới chừng này mét trước biển
export const NOMINAL_W = 0.7; // cỡ biển thường (m) để tính khoảng cách biển đạt 20 px
export const NOMINAL_W_OCTAGON = 0.6; // biển dừng (bát giác) nhỏ hơn
export const MIN_WINDOW_FRAMES = 3; // camera phải xử lý ít nhất chừng này khung trong cửa sổ
export const STOP_SPEED = 2; // dưới tốc độ này (m/s) …
export const STOP_MS = 5000; // … lâu hơn chừng này (ms) trong cửa sổ là xe dừng: không đủ bằng chứng
export const POS_SMOOTH = 0.3; // hệ số làm mượt vị trí biển trên đồng hồ quãng đường giữa các lần định vị (0…1)
export const PASS_NEAR = 25; // biển phải hiện trên hành lang cách xe không quá chừng này (m) ở một lần định vị
export const PASS_BEHIND = 10; // xe qua biển chừng này (m) …
export const PASS_GRACE_MS = 2000; // … và đã qua chừng này (ms) (đợi lượt bám kết thúc) thì kết luận
export const LOST_MS = 5000; // biển không còn trên hành lang chừng này (ms) trước khi tới: xe đã rẽ đi
export const PASS_MAX_MS = 120000; // xét một biển quá chừng này (ms) thì lượt đó không còn trừ điểm được ('timeout')
export const CONFLICT_RADIUS = 25; // lượt bám biển khác cùng họ trong chừng này (m) quanh biển: không kết luận
// … trừ khi lượt bám đó là một biển thứ hai đã biết ở cạnh: biển đã xác nhận có nhãn đó, cách biển đang xét không quá
// CONFLICT_RADIUS, cùng hướng, và camera đã thấy cả hai (hai lượt bám riêng trong một lượt đi qua) vào ít nhất chừng này
// ngày khác nhau (LearnedSigns.coSeen). Một biển bị đọc nhầm chỉ cho một lượt bám mỗi lượt: không bao giờ đủ.
export const CO_SEEN_DAYS = 2;
export const CO_SEEN_MS = 30000; // hai lần thấy cách nhau không quá chừng này (ms) là cùng một lượt đi qua
export const HIT_DEBOUNCE_MS = 60000; // một biển chỉ được tính thấy lại một lần trong chừng này (ms)
export const HEALTH_WINDOW_MS = 10000; // health() xét các khung trong chừng này (ms)
// Ảnh biển để kiểm tra độ chính xác (PLAN §6.5, tuỳ chọn onEvalCrop): một lượt bám "suýt được nhận" chỉ trượt các
// bước lọc phân loại này (bước 2 đồng thuận, bước 3 độ tin), còn mọi bước khác đều qua (xem nearMiss).
export const NEAR_MISS_REASONS = Object.freeze(['agreement', 'confidence']);

const RAD = Math.PI / 180;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lengthOf = (corr) => (corr && corr.cum && corr.cum.length ? corr.cum[corr.cum.length - 1] : 0);
const usable = (corr) => Boolean(corr && Array.isArray(corr.coords) && corr.coords.length >= 2 && Array.isArray(corr.pieces));
const codeOf = (label) => String(label).split('[')[0]; // 'P.127[50]' → 'P.127'
const defaultMono = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

/**
 * Đường b nối tiếp đường a: chung một đầu mút (đỉnh đầu hoặc cuối của cả hai) và hướng đi vào đầu mút theo a lệch
 * hướng đi ra theo b không quá CONTINUE_ANGLE (đo theo đoạn sát đầu mút). Không theo chiều vẽ, không theo chiều đi.
 * Có roads (RoadData, waysAtVertex): đầu mút đó còn phải không phải chỗ rẽ nhánh, tức là không nhánh nào khác ở đó
 * (trừ nhánh xe đi tới theo a và chính b) lệch không quá FORK_ANGLE so với hướng đi vào. Ở ngã ba chữ Y, kể cả hai
 * nhánh đối xứng ±10°, không nhánh nào là "đi tiếp"; nút giao có đường ngang (≈ 90°) vẫn có.
 */
export function continuesWay(a, b, roads = null) {
  if (!a || !b || a.id === b.id || !Array.isArray(a.g) || !Array.isArray(b.g)) return false;
  const na = a.g.length >> 1;
  const nb = b.g.length >> 1;
  if (na < 2 || nb < 2) return false;
  const pt = (w, i) => [w.g[2 * i], w.g[2 * i + 1]];
  for (const [end, prev] of [[na - 1, na - 2], [0, 1]]) {
    const v = pt(a, end);
    const key = vertexKey(v);
    const into = bearing(pt(a, prev), v);
    for (const [start, next] of [[0, 1], [nb - 1, nb - 2]]) {
      if (vertexKey(pt(b, start)) !== key) continue;
      const out = bearing(v, pt(b, next));
      if (Math.abs(angleDiff(into, out)) <= CONTINUE_ANGLE && !forkAt(roads, v, into, out, a.id, b.id)) return true;
    }
  }
  return false;
}

/**
 * Ở đỉnh v (xe đi vào theo hướng into, đi ra theo hướng out của đường bId) có một nhánh khác lệch không quá FORK_ANGLE
 * so với into: đó là chỗ rẽ nhánh. Bỏ qua nhánh xe đi tới (ngược into trong ARM_SAME), các nhánh của đường aId và
 * nhánh out của chính bId. Không có roads (hay waysAtVertex lỗi) thì coi là không rẽ nhánh.
 */
function forkAt(roads, v, into, out, aId, bId) {
  if (!roads || typeof roads.waysAtVertex !== 'function') return false;
  let arms;
  try {
    arms = roads.waysAtVertex(v);
  } catch {
    return false;
  }
  for (const { way, i } of arms || []) {
    if (!way || !Array.isArray(way.g) || way.id === aId) continue;
    const n = way.g.length >> 1;
    for (const d of [-1, 1]) {
      const k = i + d;
      if (k < 0 || k >= n) continue;
      const brg = bearing(v, [way.g[2 * k], way.g[2 * k + 1]]);
      if (Math.abs(angleDiff((into + 180) % 360, brg)) < ARM_SAME) continue; // nhánh xe đi tới
      if (way.id === bId && Math.abs(angleDiff(out, brg)) < 1) continue; // chính b
      if (Math.abs(angleDiff(into, brg)) <= FORK_ANGLE) return true;
    }
  }
  return false;
}

/**
 * Lượt bám "suýt được nhận" (near-miss), cho tập ảnh kiểm tra độ chính xác: acceptTrack trượt ở một bước trong
 * NEAR_MISS_REASONS (đồng thuận hay độ tin của bộ phân loại), VÀ khi coi hai bước đó là qua (mọi khung đã phân loại đổi
 * thành nhãn đa số với p = 1) thì acceptTrack nhận lượt bám. Tức là mọi bước khác đều qua: đủ khung đã phân loại
 * (bước 1), nhãn được học (4), độ dài, hồi quy khoảng cách, cự li, cỡ biển, mặt biển, lệch ngang (5–9), định vị (10) và
 * độ sáng (11). Không đặt biển lên hành lang (không cần bản đồ).
 * @param res  kết quả acceptTrack(track, ctx) nếu đã có (khỏi tính lại)
 */
export function nearMiss(track, ctx = {}, res = acceptTrack(track, ctx)) {
  if (!res || res.ok || !NEAR_MISS_REASONS.includes(res.reason)) return false;
  const maj = majorityLabel(track || {});
  if (!maj) return false;
  const sure = [[maj.label, 1]];
  const points = track.points.map((pt) => (classified(pt) ? { ...pt, cls: sure } : pt));
  return acceptTrack({ ...track, points }, ctx).ok === true;
}

/** Các hàm của bộ máy cảnh báo mà bộ học dùng (thay được khi kiểm thử). */
export const ENGINE = Object.freeze({
  locate: SE.locate,
  pointOn: SE.pointOn,
  headingAt: SE.headingAt,
  pieceAt: SE.pieceAt,
  junctionAhead: SE.junctionAhead,
  junctionsAlong: SE.junctionsAlong,
  mapItems: SE.mapItems,
  FEAT_STEP: SE.FEAT_STEP,
  FEAT_RADIUS: SE.FEAT_RADIUS,
  JUNCTION_NEAR: SE.JUNCTION_NEAR,
});

// ---------------------------------------------------------------------------------------------
// Độ cao mặt trời
// ---------------------------------------------------------------------------------------------

/**
 * Độ cao mặt trời (độ, không tính khúc xạ) ở toạ độ [kinh độ, vĩ độ] vào thời điểm date, theo công thức của NOAA
 * (sai số cỡ 0,1° trong thế kỷ này). Âm là mặt trời dưới đường chân trời.
 */
export function sunElevation(coord, date) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Array.isArray(coord) || !isNum(coord[0]) || !isNum(coord[1]) || !isNum(ms)) return NaN;
  const [lon, lat] = coord;
  const jd = ms / 864e5 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eot =
    4 *
    (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr)) / RAD; // phút
  const utcMin = (((ms % 864e5) + 864e5) % 864e5) / 60000;
  const solar = utcMin + eot + 4 * lon; // giờ mặt trời thật (phút)
  const ha = (solar / 4 - 180) * RAD;
  const latr = lat * RAD;
  const cosZ = Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(clamp(cosZ, -1, 1)) / RAD;
}

// ---------------------------------------------------------------------------------------------
// Bộ học
// ---------------------------------------------------------------------------------------------

export class Learner {
  /**
   * @param store    LearnedSigns
   * @param roads    RoadData
   * @param labels   labels.json (đối tượng) hoặc Map nhãn → mục
   * @param now      () → ms theo đồng hồ của máy (Date.now)
   * @param mono     () → ms theo đồng hồ đơn điệu của trang (performance.now), cùng đồng hồ với Vision result.t
   * @param engine   các hàm hình học của bộ máy cảnh báo (mặc định ENGINE)
   * @param vehicle  'car' | 'moto'
   * @param camera   { width, height, hfov, foe } (thay đổi sau bằng setCamera)
   * @param onEvalCrop  tuỳ chọn (camEval): fn({ blob, label, p, pred, w, night, outcome: 'accepted'|'near-miss', reason })
   *                 được gọi khi một lượt bám kết thúc, với ảnh cắt tốt nhất của nó (xem setEvalCrop). Không có thì bộ học
   *                 không giữ ảnh nào.
   */
  constructor({ store, roads = null, labels = null, now = () => Date.now(), mono = defaultMono, engine = ENGINE, vehicle = 'car', camera = {}, onEvalCrop = null } = {}) {
    this.store = store;
    this.roads = roads;
    this.labels = labels instanceof Map ? labels : labelIndex(labels);
    this.now = now;
    this.mono = mono;
    this.engine = engine;
    this.vehicle = vehicle;
    this.tracker = new Tracker();
    this.listeners = new Set();
    this.counters = { frames: 0, tracks: 0, accepted: 0, rejected: {}, events: {} };
    this.evalBest = new Map(); // id lượt bám đang mở → Map nhãn → ảnh cắt lớn nhất có nhãn đó đứng đầu
    this.onEvalCrop = null;
    this.setEvalCrop(onEvalCrop);
    this.setCamera(camera);
    this.reset();
  }

  /**
   * Bật/tắt việc giữ ảnh cắt để kiểm tra độ chính xác (PLAN §6.5). fn nhận { blob (PNG), label, p, pred ([[nhãn, p]
   * ×≤3] của ảnh đó), w (bề rộng khung, px), night (true|false|null), outcome, reason } khi một lượt bám kết thúc:
   * - outcome 'accepted': lần thấy đã được nhận (qua các bước lọc và đặt được lên hành lang); reason là sự kiện của kho
   *   ('new'|'hit'|'conflict'|'osm'|'suppressed'|'full'|'invalid'|'dup');
   * - outcome 'near-miss': xem nearMiss(); reason là bước trượt ('agreement'|'confidence').
   * Ảnh là ảnh lớn nhất của lượt bám trong các khung đã phân loại có nhãn đứng đầu đúng bằng label. Ảnh chỉ có khi kết
   * quả Vision mang crops (process(…, { evalCrops: true })). fn = null: tắt, quên ngay các ảnh đang giữ. Lỗi (kể cả
   * promise bị từ chối) của fn bị bỏ qua.
   */
  setEvalCrop(fn) {
    this.onEvalCrop = typeof fn === 'function' ? fn : null;
    if (!this.onEvalCrop) this.evalBest.clear();
  }

  /**
   * Thông số camera: { width, height (px), hfov (độ), foe { x, y } (px) }. hfov là góc nhìn theo CẠNH DÀI của khung
   * (ngang khi cầm ngang, dọc khi cầm dọc): xoay máy không đổi tiêu cự tính theo pixel.
   */
  setCamera({ width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, hfov = DEFAULT_HFOV, foe = null } = {}) {
    const w = isNum(width) && width > 0 ? width : DEFAULT_WIDTH;
    const h = isNum(height) && height > 0 ? height : DEFAULT_HEIGHT;
    this.camera = {
      width: w,
      height: h,
      hfov: isNum(hfov) && hfov > 10 && hfov < 170 ? hfov : DEFAULT_HFOV,
      foe: foe && isNum(foe.x) && isNum(foe.y) ? { x: foe.x, y: foe.y } : defaultFoe(w, h),
    };
    this.focal = focalPx(Math.max(w, h), this.camera.hfov);
    this.tracker.setFrame({ width: w, height: h, foe: this.camera.foe });
  }

  /** Bắt đầu lại (chuyến mới, camera bật lại): quên lịch sử định vị, lượt bám và các biển đang xét. */
  reset() {
    this.fixes = []; // [{ mono, time, D, speed, accuracy, coord, corridor|null, way }]
    this.corridors = []; // [{ corridor, mono, D, accuracy }] trong CORRIDOR_KEEP_MS gần nhất
    this.frames = []; // [{ t, lumOk, lum }] cho health()
    this.lastFrame = null; // khung đã xử lý gần nhất { t }: camera còn chạy không
    this.lastPosed = null; // khung gần nhất có vị trí xe { t, D }: cửa sổ xét được xem tới đâu
    this.passes = new Map(); // id biển → trạng thái lượt đi qua
    this.recentHits = new Map(); // id biển → lúc tính thấy lại (mono)
    this.sighted = new Map(); // id biển → { t (mono), label, family, coord, facing }: lần thấy gần đây (coSeen)
    this.simulated = false;
    this.tracker.reset();
    this.evalBest.clear();
  }

  /**
   * Nghe kết quả mỗi lượt đi qua biển: fn({ record, outcome: 'hit'|'miss'|'none', reason, valueChanged? }).
   * valueChanged: true khi reason là 'conflict' và lượt bám gây ra nó là biển cùng mã khác trị số (camera vừa thấy,
   * dù chưa đủ tin, một trị số khác ở đúng chỗ: biển có thể đã đổi, CameraLimit không dùng trị số cũ).
   */
  onPassed(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(record, outcome, reason = null, extra = null) {
    for (const fn of this.listeners) {
      try {
        fn(extra ? { record, outcome, reason, ...extra } : { record, outcome, reason });
      } catch {
        /* bỏ qua lỗi của bên nghe */
      }
    }
  }

  #count(group, key) {
    this.counters[group][key] = (this.counters[group][key] || 0) + 1;
  }

  stats() {
    return structuredClone(this.counters);
  }

  // ---- Định vị ----

  /** Thời điểm (đồng hồ đơn điệu) của một lần định vị nhận ngay lúc này. */
  monoOf(fix) {
    const nowMono = this.mono();
    if (!fix || !isNum(fix.time)) return nowMono;
    const age = this.now() - fix.time;
    return age >= 0 && age <= FIX_AGE_MAX ? nowMono - age : nowMono;
  }

  /**
   * Gọi sau SignEngine.update(fix, …) cho cùng lần định vị.
   * @param fix   { coord, speed (m/s), heading, accuracy, time (ms, giờ GPS), simulated }
   * @param opts  { corridor: signs.lastCorridor, corridorTime: signs.lastCorridorTime (không bắt buộc),
   *                carSpeed: tốc độ do xe báo (km/h, như carSpeed() của main.js) hoặc null }
   */
  onFix(fix, { corridor = null, corridorTime = null, carSpeed = null } = {}) {
    if (!fix || !Array.isArray(fix.coord)) return;
    if (fix.simulated) {
      // Chạy thử: không học, không xét lượt đi qua; quên các biển đang xét để không kết luận nhầm sau đó.
      this.simulated = true;
      this.passes.clear();
      return;
    }
    this.simulated = false;
    const m = this.monoOf(fix);
    const prev = this.fixes[this.fixes.length - 1];
    if (prev && !(m > prev.mono)) return; // lần định vị cũ hơn hoặc trùng lần trước
    const speed = isNum(carSpeed) && carSpeed >= 0 ? carSpeed / 3.6 : Math.max(0, isNum(fix.speed) ? fix.speed : 0);
    const D = prev ? prev.D + (0.5 * (prev.speed + speed) * (m - prev.mono)) / 1000 : 0;
    const corrOk =
      usable(corridor) && !(corridor.start && corridor.start.loose) && !(isNum(corridorTime) && isNum(fix.time) && corridorTime !== fix.time);
    const entry = {
      mono: m,
      time: fix.time,
      D,
      speed,
      accuracy: isNum(fix.accuracy) ? fix.accuracy : Infinity,
      coord: fix.coord,
      corridor: corrOk ? corridor : null,
      way: corrOk && corridor.pieces[0] && corridor.pieces[0].way ? corridor.pieces[0].way.id : null,
    };
    this.fixes.push(entry);
    while (this.fixes.length > 2 && this.fixes[0].mono < m - FIX_KEEP_MS) this.fixes.shift();
    if (corrOk) {
      this.corridors.push({ corridor, mono: m, D, accuracy: entry.accuracy });
    }
    while (this.corridors.length && (this.corridors[0].mono < m - CORRIDOR_KEEP_MS || this.corridors.length > CORRIDORS_MAX)) {
      this.corridors.shift();
    }
    // Camera đã ngừng gửi khung (xe chậm dưới 3 m/s, tắt camera, trang bị ẩn): kết thúc và xét các lượt bám còn mở
    // trước khi xét lượt đi qua, để biển vẫn còn đó được tính là thấy (không thành "không thấy").
    if (this.tracker.tracks.length && this.lastFrame && this.mono() - this.lastFrame.t > FRAME_GAP_MS) this.#flush();
    this.#passes(entry);
  }

  /**
   * Camera tạm dừng (bên gọi ngừng lấy khung: xe chậm, mức tải 0, tắt camera, trang bị ẩn): kết thúc và xét ngay các
   * lượt bám đang mở → { ended, results } như onVision. Không gọi thì việc này tự xảy ra sau FRAME_GAP_MS.
   */
  pause() {
    return this.#flush();
  }

  #flush() {
    const ended = this.tracker.flush();
    return { ended: ended.length, results: ended.map((tr) => this.#endTrack(tr)) };
  }

  /**
   * Vị trí xe lúc t (đồng hồ đơn điệu) → { D, speed, accuracy, simulated: false, corridor } hoặc null (trước lịch
   * sử, giữa hai lần định vị cách nhau quá xa, hoặc sau lần định vị cuối quá 1,5 giây).
   */
  poseAt(t) {
    if (!isNum(t) || this.simulated || !this.fixes.length) return null;
    let i = this.fixes.length - 1;
    while (i >= 0 && this.fixes[i].mono > t) i--;
    if (i < 0) return null;
    const a = this.fixes[i];
    const b = this.fixes[i + 1];
    const tau = (t - a.mono) / 1000;
    if (!b) {
      if (t - a.mono > EXTRAPOLATE_MS) return null;
      return { D: a.D + a.speed * tau, speed: a.speed, accuracy: a.accuracy, simulated: false, corridor: a.corridor != null };
    }
    if (b.mono - a.mono > FIX_GAP_MAX) return null;
    const T = (b.mono - a.mono) / 1000;
    const acc = (b.speed - a.speed) / T;
    return {
      D: a.D + a.speed * tau + 0.5 * acc * tau * tau,
      speed: a.speed + acc * tau,
      accuracy: Math.max(a.accuracy, b.accuracy),
      simulated: false,
      corridor: a.corridor != null && b.corridor != null,
    };
  }

  // ---- Khung camera ----

  /**
   * Một khung đã xử lý (Vision.process, hợp đồng 5). frame: { width, height } nếu cỡ khung đổi.
   * → { ended: số lượt bám vừa kết thúc, results: [{ ok, reason?, event?, record? }] }
   */
  onVision(result, frame = null) {
    if (!result || !isNum(result.t) || !Array.isArray(result.boxes)) return { ended: 0, results: [] };
    if (frame && isNum(frame.width) && isNum(frame.height) && (frame.width !== this.camera.width || frame.height !== this.camera.height)) {
      // Cỡ khung đổi (xoay máy, đổi độ phân giải): điểm tụ giữ nguyên vị trí tương đối trong khung.
      const { width: w0, height: h0, foe } = this.camera;
      this.setCamera({ ...this.camera, width: frame.width, height: frame.height, foe: { x: (foe.x * frame.width) / w0, y: (foe.y * frame.height) / h0 } });
    }
    const t = result.t;
    // Camera vừa chạy lại sau một quãng không có khung: lượt bám mở từ trước đó đã cũ, kết thúc và xét trước khi ghép
    // hộp của khung mới.
    const stale = this.lastFrame && t - this.lastFrame.t > FRAME_GAP_MS && this.tracker.tracks.length;
    const flushed = stale ? this.#flush() : { ended: 0, results: [] };
    this.lastFrame = { t };
    const good = lumOk(result.lum);
    this.counters.frames++;
    this.frames.push({ t, lumOk: good, lum: result.lum || null });
    while (this.frames.length && this.frames[0].t < t - HEALTH_WINDOW_MS) this.frames.shift();
    const pose = this.poseAt(t);
    if (pose) {
      const from = this.lastPosed;
      const gap = !from || t - from.t > FRAME_GAP_MS; // quãng không có khung (có vị trí xe) trước khung này
      for (const st of this.passes.values()) {
        const s = st.sFix - (pose.D - st.DFix);
        if (s >= WIN_NEAR && s <= st.winFar) {
          st.frames++;
          if (!good) st.lumBad = true;
        }
        if (s < WIN_NEAR) st.near = true; // camera còn chạy khi biển đã ra khỏi cửa sổ xét
        if (gap) {
          // Quãng không có khung trùm lên cửa sổ xét: cửa sổ không được xem trọn.
          const sFrom = from ? st.sFix - (from.D - st.DFix) : Infinity;
          if (sFrom > WIN_NEAR && s < st.winFar) st.gap = true;
        }
      }
      this.lastPosed = { t, D: pose.D };
    }
    const ended = this.tracker.update(result, pose);
    if (this.onEvalCrop) this.#keepCrops(result, ended);
    const results = [...flushed.results, ...ended.map((tr) => this.#endTrack(tr))];
    return { ended: flushed.ended + ended.length, results };
  }

  /**
   * Ảnh cắt của khung này (result.crops[k] ứng với result.boxes[i]) → giữ cho lượt bám đã nhận hộp đó, nếu hộp đã phân
   * loại và lớn hơn ảnh đang giữ cho cùng nhãn đứng đầu. Lượt bám nhận hộp ở khung này khi điểm cuối của nó có cùng t và
   * đúng toạ độ, cỡ của hộp (Tracker chép nguyên các trường đó).
   */
  #keepCrops(result, ended) {
    const crops = Array.isArray(result.crops) ? result.crops : null;
    if (!crops || !crops.length) return;
    const withBox = [];
    for (const c of crops) {
      const b = c && Number.isInteger(c.i) ? result.boxes[c.i] : null;
      if (b && c.blob) withBox.push({ b, blob: c.blob });
    }
    for (const tr of [...this.tracker.tracks, ...ended]) {
      const pt = tr.points[tr.points.length - 1];
      if (!pt || pt.t !== result.t || !classified(pt)) continue;
      const hit = withBox.find(({ b }) => b.x === pt.x && b.y === pt.y && b.w === pt.w && b.h === pt.h);
      if (!hit) continue;
      const label = pt.cls[0][0];
      let best = this.evalBest.get(tr.id);
      if (!best) this.evalBest.set(tr.id, (best = new Map()));
      const cur = best.get(label);
      if (!cur || pt.w > cur.w) best.set(label, { blob: hit.blob, w: pt.w, p: pt.cls[0][1], pred: pt.cls.map((c) => [c[0], c[1]]) });
    }
  }

  /** Gọi onEvalCrop với ảnh đã giữ cho nhãn label của một lượt bám (nếu có); không bao giờ ném lỗi ra ngoài. */
  #evalCrop(kept, label, outcome, reason, night) {
    const c = kept && kept.get(label);
    const fn = this.onEvalCrop;
    if (!c || !fn) return;
    try {
      const r = fn({ blob: c.blob, label, p: c.p, pred: c.pred, w: c.w, night, outcome, reason });
      if (r && typeof r.then === 'function') r.then(null, () => {});
    } catch {
      /* ảnh kiểm tra chỉ là phần thêm: lỗi của bên nhận không ảnh hưởng tới việc học */
    }
  }

  /** Ban đêm ở vị trí xe gần nhất (true|false), hoặc null khi chưa có lần định vị. */
  #nightNow() {
    const f = this.fixes[this.fixes.length - 1];
    if (!f || !Array.isArray(f.coord)) return null;
    const e = sunElevation(f.coord, new Date(this.now()));
    return Number.isFinite(e) ? !(e > SUN_DAY) : null;
  }

  /** Gợi ý hộp cho bộ phân loại ở khung kế tiếp (Vision.process hints). */
  hints(t = this.mono()) {
    return this.tracker.hints(t);
  }

  /**
   * Tình trạng camera trong HEALTH_WINDOW_MS gần nhất → { running, frames, fps, lumOk, lum, okShare, lastFrameAgo,
   * reason: null|'no-frames'|'blank'|'dark'|'bright', simulated }.
   */
  health() {
    const now = this.mono();
    const recent = this.frames.filter((f) => now - f.t <= HEALTH_WINDOW_MS);
    const last = recent[recent.length - 1] || null;
    let reason = null;
    if (!last) reason = 'no-frames';
    else if (!last.lumOk) {
      const lum = last.lum;
      if (!lum || !isNum(lum.std) || !isNum(lum.mean) || lum.std < LUM_STD_MIN) reason = 'blank';
      else if (lum.mean < LUM_MEAN_MIN) reason = 'dark';
      else if (lum.mean > LUM_MEAN_MAX) reason = 'bright';
      else reason = 'blank';
    }
    return {
      running: recent.length > 0,
      frames: recent.length,
      fps: recent.length / (HEALTH_WINDOW_MS / 1000),
      lumOk: last ? last.lumOk : false,
      lum: last ? last.lum : null,
      okShare: recent.length ? recent.filter((f) => f.lumOk).length / recent.length : 0,
      lastFrameAgo: last ? now - last.t : null,
      reason,
      simulated: this.simulated,
    };
  }

  // ---- Lượt bám kết thúc ----

  #endTrack(track) {
    this.counters.tracks++;
    const kept = this.evalBest.get(track.id) || null;
    this.evalBest.delete(track.id);
    const ctx = { labels: this.labels, focal: this.focal, foe: this.camera.foe };
    const res = acceptTrack(track, ctx);
    this.#markSeen(track);
    if (!res.ok) {
      if (kept && this.onEvalCrop && nearMiss(track, ctx, res)) {
        this.#evalCrop(kept, majorityLabel(track).label, 'near-miss', res.reason, this.#nightNow());
      }
      this.#count('rejected', res.reason);
      return { ok: false, reason: res.reason };
    }
    const placed = this.place(res.obs);
    if (placed.error) {
      this.#count('rejected', placed.error);
      return { ok: false, reason: placed.error };
    }
    this.counters.accepted++;
    const o = res.obs;
    const date = new Date(this.now());
    const night = !(sunElevation(placed.coord, date) > SUN_DAY);
    const obs = {
      code: o.code,
      value: o.value,
      label: o.label,
      family: o.family,
      coord: placed.coord,
      facing: placed.facing,
      wayId: placed.wayId,
      ways: placed.ways,
      junction: placed.junction,
      branch: placed.branch,
      plate: o.plate,
      night,
      strong: o.strong && !night,
      posErr: placed.posErr,
      osm: placed.osm,
    };
    // Một biển chỉ được tính thấy lại một lần mỗi lượt đi qua (hai lượt bám của cùng một biển).
    const m = this.store.match(obs);
    const t = this.mono();
    if (m.match && this.#recentHit(m.match.id, t)) {
      this.#coSight(m.match, t);
      this.#count('events', 'dup');
      this.#evalCrop(kept, o.label, 'accepted', 'dup', night);
      return { ok: true, event: 'dup', record: null, obs };
    }
    const r = this.store.observe(obs);
    this.#count('events', r.event);
    this.#evalCrop(kept, o.label, 'accepted', r.event, night);
    if (r.record && (r.event === 'hit' || r.event === 'conflict' || r.event === 'new')) {
      this.recentHits.set(r.record.id, t);
      this.#coSight(r.record, t);
      if (!r.created) {
        // Thấy lại: kết luận ngay lượt đi qua biển này.
        this.passes.delete(r.record.id);
        this.#emit(r.record, 'hit', null);
      }
    }
    for (const old of r.missed || []) {
      // Đổi trị số (50 → 60): kho đã trừ điểm biển cũ như một lần đi qua không thấy. Lượt đi qua này của biển cũ đã
      // kết luận: ghi như vừa thấy để lần định vị kế tiếp không xét lại nó ('late') rồi báo nó đã đi qua (CameraLimit
      // sẽ dùng lại trị số cũ ngay sau biển mới).
      this.passes.delete(old.id);
      this.recentHits.set(old.id, t);
      this.#emit(old, 'miss', 'value');
    }
    return { ok: true, event: r.event, record: r.record, obs };
  }

  /**
   * Lượt bám (nhận hay không) có nhãn đa số: đánh dấu các biển đang xét cùng họ ở gần. Cùng nhãn: biển vẫn còn đó
   * (lượt đi qua này không thể là "không thấy"; nếu lần thấy được ghi vào đúng biển đó thì là "thấy lại"). Khác nhãn:
   * biển khác cùng họ ở đúng chỗ, không kết luận.
   */
  #markSeen(track) {
    if (!this.passes.size) return;
    for (const st of this.passes.values()) {
      const k = this.#marks(track, st);
      if (k === 'conflict' && this.#explained(track, st)) continue; // biển thứ hai đã biết ở cạnh, không phải đọc nhầm
      if (k === 'conflict') {
        st.conflict = true;
        if (codeOf(majorityLabel(track).label) === codeOf(st.label)) st.valueConflict = true;
      } else if (k === 'seen') st.seen = true;
    }
  }

  /** Lượt bám có nhãn đa số cùng họ với biển đang xét st, ở trong CONFLICT_RADIUS m quanh biển → 'seen'|'conflict'|null. */
  #marks(track, st) {
    const maj = majorityLabel(track);
    if (!maj) return null;
    const ranged = track.points.filter((p) => isNum(p.D) && p.pose);
    const lp = ranged[ranged.length - 1];
    if (!lp) return null;
    const entry = this.labels.get(maj.label);
    const family = entry && typeof entry.family === 'string' ? entry.family : track.family;
    if (st.family !== family) return null;
    const fit = fitRange(ranged, this.focal);
    const Z = fit && fit.Zlast > 0 ? fit.Zlast : (this.focal * NOMINAL_W) / lp.w;
    const s = st.sFix - (lp.D - st.DFix);
    if (Math.abs(Z - s) > CONFLICT_RADIUS) return null;
    return maj.label !== st.label ? 'conflict' : 'seen';
  }

  /**
   * Lượt bám nhãn khác cùng họ (k = 'conflict' với biển đang xét st) là một biển thứ hai đã biết: một biển đã xác nhận
   * mang đúng nhãn đó, cách st không quá CONFLICT_RADIUS, hướng mặt lệch ≤ MATCH_FACING, mà camera đã thấy cùng st
   * (hai lượt bám riêng trong một lượt đi qua) vào ≥ CO_SEEN_DAYS ngày. Khi đó lượt bám không chặn st bị trừ điểm.
   */
  #explained(track, st) {
    const maj = majorityLabel(track);
    const mine = maj && typeof this.store.get === 'function' ? this.store.get(st.id) : null;
    if (!mine || !Array.isArray(mine.co)) return false;
    for (const c of mine.co) {
      if (!(c.days >= CO_SEEN_DAYS)) continue;
      const other = this.store.get(c.id);
      if (!other || other.status !== 'confirmed' || labelOf(other.code, other.value) !== maj.label) continue;
      if (!Array.isArray(other.coord) || distance(other.coord, mine.coord) > CONFLICT_RADIUS) continue;
      if (Math.abs(angleDiff(other.facing, mine.facing)) > MATCH_FACING) continue;
      return true;
    }
    return false;
  }

  /**
   * Một lần thấy được nhận cho biển rec (lúc t): biển khác nhãn, cùng họ, cùng hướng, cách không quá CONFLICT_RADIUS,
   * được thấy trong CO_SEEN_MS trước đó (lượt bám khác, cùng lượt đi qua) → ghi vào kho là hai biển cùng được thấy.
   */
  #coSight(rec, t) {
    if (!rec || !Array.isArray(rec.coord)) return;
    const label = labelOf(rec.code, rec.value);
    for (const [id, s] of this.sighted) {
      if (t - s.t > CO_SEEN_MS) {
        this.sighted.delete(id);
        continue;
      }
      if (id === rec.id || s.label === label || s.family !== rec.family) continue;
      if (distance(s.coord, rec.coord) > CONFLICT_RADIUS || Math.abs(angleDiff(s.facing, rec.facing)) > MATCH_FACING) continue;
      if (typeof this.store.coSeen === 'function') this.store.coSeen(id, rec.id);
    }
    this.sighted.set(rec.id, { t, label, family: rec.family, coord: rec.coord, facing: rec.facing });
  }

  /** Biển vừa được tính thấy lại trong HIT_DEBOUNCE_MS (ms) trước t. */
  #recentHit(id, t) {
    const at = this.recentHits.get(id);
    if (at == null) return false;
    if (t - at <= HIT_DEBOUNCE_MS) return true;
    this.recentHits.delete(id);
    return false;
  }

  // ---- Đặt biển lên hành lang ----

  /**
   * Đặt một lần thấy (obs của acceptTrack) lên hành lang của lần định vị gần nhất không sau khung cuối:
   * s = Z + (D(khung cuối) − D(lần định vị)). → { coord, facing, s, wayId, ways, junction, branch, osm, posErr,
   * corridorMono } hoặc { error: 'no-corridor'|'off-corridor' }. ways: id các đường cùng con đường quanh biển (cho
   * LearnedSigns.match).
   */
  place(obs) {
    const E = this.engine;
    let c = null;
    let ci = -1;
    this.corridors.forEach((k, i) => {
      if (k.mono <= obs.t) {
        c = k;
        ci = i;
      }
    });
    if (!c) return { error: 'no-corridor' };
    const corr = c.corridor;
    const total = lengthOf(corr);
    const sSign = obs.Z + (obs.D - c.D);
    if (!(sSign >= 0 && sSign <= total)) return { error: 'off-corridor' };
    let s = sSign;
    let junction = null;
    if (obs.junction) {
      const ahead = E.junctionAhead(corr, this.roads, sSign, E.JUNCTION_NEAR);
      const j = ahead || E.junctionAhead(corr, this.roads, Math.max(0, sSign - JUNCTION_BEHIND), JUNCTION_BEHIND);
      if (j) {
        s = ahead ? Math.max(j.s - JUNCTION_SETBACK, sSign) : Math.max(0, j.s - JUNCTION_SETBACK);
        junction = j.key;
      }
    }
    const coord = E.pointOn(corr, s);
    const facing = Math.round((E.headingAt(corr, s) + 180) % 360) % 360;
    const piece = E.pieceAt(corr.pieces, s);
    const side = obs.lateral > SIDE_MIN ? 1 : obs.lateral < -SIDE_MIN ? -1 : 0;
    const branch = this.#forks(corr, sSign, side) ? 'unsure' : null;
    const osm = this.#osmHas(obs, ci, coord, s);
    const posErr = isNum(c.accuracy) ? Math.max(POS_ERR_MIN, c.accuracy / ACCURACY_TO_SIGMA) : undefined;
    return {
      coord,
      facing,
      s,
      wayId: piece && piece.way ? piece.way.id : null,
      ways: [...this.#sameRoadWays(corr, s, coord)],
      junction,
      branch,
      osm,
      posErr,
      corridorMono: c.mono,
    };
  }

  /**
   * Bước 13: bản đồ có biển cùng loại (cùng dup; cùng mã khi trị số không đọc được) trong OSM_DUP_RADIUS m quanh vị
   * trí s trên hành lang thứ ci, theo cùng chiều. Hành lang chỉ có các mục ở phía trước xe; phần sau lưng xe được
   * xét trên các hành lang cũ hơn (dựng khi xe còn ở xa phía sau, trên cùng con đường: toạ độ biển nằm trên đó).
   */
  #osmHas(obs, ci, coord, s) {
    const E = this.engine;
    if (!this.roads) return false;
    const dup = `${obs.code}|${obs.value ?? ''}`;
    const opts = { vehicle: this.vehicle, now: new Date(this.now()) };
    const has = (corr, at) =>
      E.mapItems(corr, this.roads, opts).some(
        (it) => (obs.value == null ? it.code === obs.code : it.dup === dup) && Math.abs(it.distance - at) <= OSM_DUP_RADIUS,
      );
    const corr = this.corridors[ci].corridor;
    if (has(corr, s)) return true;
    const heading = E.headingAt(corr, s);
    let covered = s; // phần sau lưng biển đã xét được (m)
    for (let i = ci - 1; i >= 0 && covered < OSM_DUP_RADIUS; i--) {
      const k = this.corridors[i].corridor;
      const loc = E.locate(k, coord);
      if (!loc || loc.d > REC_LATERAL || loc.s <= covered || loc.s > lengthOf(k)) continue;
      if (Math.abs(angleDiff(E.headingAt(k, loc.s), heading)) > APPLY_ANGLE) continue; // chiều khác
      if (has(k, loc.s)) return true;
      covered = loc.s;
    }
    return false;
  }

  /**
   * Id các đường của hành lang trong WAY_SLACK m quanh vị trí s (các đoạn liền nhau của cùng con đường), cộng id
   * đường của các biển đã học quanh đó mà dữ liệu đường hiện có không còn (id cũ trước khi bản đồ cập nhật).
   */
  #sameRoadWays(corr, s, coord) {
    const ways = this.#waysNear(corr, s);
    if (!ways.size || !this.store || typeof this.store.recordsNear !== 'function') return ways;
    for (const r of this.store.recordsNear(coord, MATCH_ALONG + MATCH_LATERAL)) {
      if (r.wayId != null && !ways.has(r.wayId) && !this.#wayExists(r.wayId, r.coord)) ways.add(r.wayId);
    }
    return ways;
  }

  #waysNear(corr, s) {
    const out = new Set();
    for (const p of corr.pieces) if (p.way && p.s1 >= s - WAY_SLACK && p.s0 <= s + WAY_SLACK) out.add(p.way.id);
    return out;
  }

  /** Dữ liệu đường đang có một đường mang id này cách coord không quá 30 m. Không kiểm tra được thì coi là không có. */
  #wayExists(id, coord) {
    const roads = this.roads;
    if (!roads || typeof roads.matchWay !== 'function') return false;
    try {
      return roads.matchWay({ coord, accuracy: 0, speed: 0, heading: null }, '', { vehicle: this.vehicle, only: new Set([id]) }) != null;
    } catch {
      return false;
    }
  }

  /**
   * Biển đã học (rec) có nằm trên con đường của hành lang ở vị trí s không:
   * 'same' (cùng đường, hoặc biển không có wayId: chỉ xét lệch ngang), 'other' (biển của một đường khác đang có trong
   * dữ liệu: đường song song, trên cao, đường gom), 'unknown' (không kiểm tra được: hành lang quanh đó không theo
   * đường nào, hoặc id đường của biển không còn trong dữ liệu).
   */
  #link(rec, corr, s) {
    if (rec.wayId == null) return 'same';
    const ways = this.#waysNear(corr, s);
    if (ways.has(rec.wayId)) return 'same';
    if (!ways.size || !this.#wayExists(rec.wayId, rec.coord)) return 'unknown';
    return 'other';
  }

  /**
   * Một đường khác (không thuộc con đường của hành lang quanh biển) cùng chiều đi chạy trong PARALLEL_NEAR m quanh biển
   * (đường trên cao, đường gom sát bên): định vị không phân biệt được xe ở đường nào, lượt đi qua không trừ điểm.
   */
  #parallelNear(rec, corr, s) {
    const roads = this.roads;
    if (!roads || typeof roads.matchWay !== 'function') return false;
    const total = lengthOf(corr);
    const fix = { coord: rec.coord, heading: this.engine.headingAt(corr, clamp(s, 0, total)), speed: 10, accuracy: 0 };
    const skip = this.#waysNear(corr, s);
    const mine = [...new Set(corr.pieces.filter((p) => p.way && skip.has(p.way.id)).map((p) => p.way))];
    try {
      // Biển của nút giao nằm ngay trước nút giao, nơi hành lang thường dừng: đoạn đường đi tiếp sau nút giao (một id
      // khác) không phải đường song song. Bỏ qua nó (và đoạn nối tiếp nó) rồi tìm lại. Mỗi vòng thêm một id: dừng được.
      for (;;) {
        const other = roads.matchWay(fix, '', { vehicle: this.vehicle, skip });
        if (!other || other.dist > PARALLEL_NEAR) return false;
        if (!mine.some((w) => continuesWay(w, other.way, roads))) return true;
        skip.add(other.way.id);
        mine.push(other.way);
      }
    } catch {
      return false;
    }
  }

  /** Đường rẽ nhánh (lệch ≤ FORK_ANGLE) trong FORK_AHEAD m sau vị trí s, về phía biển (side: +1 phải, −1 trái, 0 cả hai). */
  #forks(corr, s, side) {
    const E = this.engine;
    if (!this.roads) return false;
    const total = lengthOf(corr);
    for (const j of E.junctionsAlong(corr, this.roads)) {
      if (j.s <= s || j.s > s + FORK_AHEAD) continue;
      const v = j.key.split(',').map(Number);
      const hIn = bearing(E.pointOn(corr, Math.max(0, j.s - ARM_CHORD)), E.pointOn(corr, j.s));
      // Hành lang dừng ngay ở nút giao (chưa rõ đi tiếp nhánh nào): mọi nhánh đều được xét.
      const hOut = j.s + ARM_CHORD / 2 < total ? bearing(E.pointOn(corr, j.s), E.pointOn(corr, Math.min(total, j.s + ARM_CHORD))) : null;
      for (const { way, i } of this.roads.waysAtVertex(v)) {
        const n = way.g.length >> 1;
        for (const d of [-1, 1]) {
          const k = i + d;
          if (k < 0 || k >= n) continue;
          const b = bearing(v, [way.g[2 * k], way.g[2 * k + 1]]);
          if (Math.abs(angleDiff((hIn + 180) % 360, b)) < ARM_SAME) continue; // nhánh xe đi tới
          if (hOut != null && Math.abs(angleDiff(hOut, b)) < ARM_SAME) continue; // hành lang đi tiếp
          const rel = angleDiff(hIn, b);
          if (Math.abs(rel) <= FORK_ANGLE && (side === 0 || Math.sign(rel) === side)) return true;
        }
      }
    }
    return false;
  }

  // ---- Xét lượt đi qua ----

  #winFar(family) {
    return (this.focal * (family === 'octagon' ? NOMINAL_W_OCTAGON : NOMINAL_W)) / CLS_MIN_PX;
  }

  /** Các biển đã học nằm trên hành lang, theo chiều đi → [{ rec, loc, link }] (link: xem #link). */
  #onCorridor(corr) {
    const E = this.engine;
    const out = [];
    if (!this.store || typeof this.store.recordsNear !== 'function') return out;
    const total = lengthOf(corr);
    const seen = new Set();
    for (let s = 0; ; s += E.FEAT_STEP) {
      const at = Math.min(s, total);
      for (const rec of this.store.recordsNear(E.pointOn(corr, at), E.FEAT_RADIUS)) {
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
        const loc = E.locate(corr, rec.coord);
        if (!loc || loc.d > REC_LATERAL || loc.s > total + 1) continue;
        const brg = E.headingAt(corr, clamp(loc.s, 0, total));
        if (!appliesTo(rec.facing, brg, APPLY_ANGLE)) continue;
        out.push({ rec, loc, link: this.#link(rec, corr, loc.s) });
      }
      if (at >= total) break;
    }
    return out;
  }

  #passes(fix) {
    const corr = fix.corridor;
    const prev = this.fixes.length >= 2 ? this.fixes[this.fixes.length - 2] : null;
    const located = new Set();
    if (corr) {
      const ways = (upTo) => corr.pieces.filter((p) => p.way && p.s0 <= upTo + 1).map((p) => p.way.id);
      for (const { rec, loc, link } of this.#onCorridor(corr)) {
        let st = this.passes.get(rec.id);
        const inWin = st && loc.s >= WIN_NEAR && loc.s <= st.winFar;
        if (link === 'other') {
          // Biển của một đường khác ngay cạnh (song song, trên cao, đường gom): xe không đi trên đường của biển.
          if (inWin) st.switched = true;
          continue;
        }
        if (!st) {
          if (loc.s < 0 || this.#recentHit(rec.id, fix.mono)) continue;
          st = {
            id: rec.id,
            label: rec.value != null ? `${rec.code}[${rec.value}]` : rec.code,
            family: rec.family,
            night: rec.night,
            coord: rec.coord,
            armed: fix.mono,
            winFar: this.#winFar(rec.family),
            sFix: loc.s,
            DFix: fix.D,
            lastSeen: fix.mono,
            reached: false,
            ways: new Set(ways(loc.s)),
            // Lượt này không thể trừ điểm: biển hiện lần đầu đã quá gần ('late'), không biết biển có trên đường của
            // xe không ('way'), hoặc (sau đó) xét quá lâu ('timeout'). Đi qua vẫn báo 'none' với lý do này.
            noMiss: loc.s < ARM_AHEAD ? 'late' : link === 'unknown' || this.#parallelNear(rec, corr, loc.s) ? 'way' : null,
            frames: 0,
            near: false,
            gap: false,
            lumBad: false,
            stopSince: null,
            stopped: false,
            accBad: false,
            switched: false,
            conflict: false,
            valueConflict: false,
            seen: false,
            cross: null,
          };
          this.passes.set(rec.id, st);
        } else {
          if (inWin && ((fix.way != null && !st.ways.has(fix.way)) || link === 'unknown')) st.switched = true;
          // Xe nhanh (trên 90 km/h) có thể nhảy qua cả khoảng 0–25 m giữa hai lần định vị: biển lần trước còn ở phía
          // trước thì nay đã ở sau lưng, vẫn trên hành lang (không quá LOST_MS, nếu không đã kết luận 'left').
          if (loc.s < 0 && st.sFix > 0) st.reached = true;
          for (const id of ways(loc.s)) st.ways.add(id);
          // Vị trí biển theo đồng hồ quãng đường (R = s + D) được làm mượt qua các lần định vị: mỗi lần lệch vài mét
          // theo GPS, còn quãng đường tích phân thì liền mạch. Xe đứng yên: giữ nguyên (chỉ có nhiễu GPS).
          if (fix.speed >= STOP_SPEED) {
            const R = st.sFix + st.DFix;
            st.sFix = R + POS_SMOOTH * (loc.s + fix.D - R) - fix.D;
            st.DFix = fix.D;
          }
          st.lastSeen = fix.mono;
        }
        if (loc.s >= 0 && loc.s <= PASS_NEAR) st.reached = true;
        located.add(rec.id);
      }
    }
    for (const st of [...this.passes.values()]) {
      const s = st.sFix - (fix.D - st.DFix);
      if (s >= WIN_NEAR && s <= st.winFar) {
        if (!(fix.accuracy <= FIX_ACCURACY_MAX)) st.accBad = true;
        // Mất hành lang, hay hành lang không còn đi qua biển, trong cửa sổ xét: không biết xe còn trên đường đó không.
        if (!corr || !located.has(st.id)) st.switched = true;
      }
      this.#stopRule(st, s, fix, prev);
      if (s <= 0 && st.cross == null) st.cross = fix.mono;
      if (!st.noMiss && fix.mono - st.armed > PASS_MAX_MS) st.noMiss = 'timeout';
      if (!located.has(st.id) && s > 0 && fix.mono - st.lastSeen > LOST_MS) this.#conclude(st, 'none', 'left');
      else if (s <= -PASS_BEHIND && st.cross != null && fix.mono - st.cross >= PASS_GRACE_MS) this.#decide(st);
    }
  }

  /**
   * Xe dừng (dưới STOP_SPEED lâu hơn STOP_MS), bắt đầu khi biển ở trong cửa sổ xét WIN_NEAR…winFar. Lần dừng chỉ hết
   * khi xe nhanh lên lại (vị trí đo được nhảy vài mét quanh mép cửa sổ khi xe đứng yên không cắt đôi lần dừng). Thời
   * điểm tốc độ qua ngưỡng được nội suy giữa hai lần định vị, để định vị 1 giây một lần không làm hụt tới 2 giây.
   */
  #stopRule(st, s, fix, prev) {
    const crossing = (a, b) => a.mono + ((a.speed - STOP_SPEED) / (a.speed - b.speed)) * (b.mono - a.mono);
    if (fix.speed < STOP_SPEED) {
      if (st.stopSince == null && s >= WIN_NEAR && s <= st.winFar) {
        st.stopSince = prev && prev.speed >= STOP_SPEED ? crossing(prev, fix) : fix.mono;
      }
      if (st.stopSince != null && fix.mono - st.stopSince > STOP_MS) st.stopped = true;
    } else if (st.stopSince != null) {
      const end = prev && prev.speed < STOP_SPEED ? crossing(prev, fix) : fix.mono;
      if (end - st.stopSince > STOP_MS) st.stopped = true;
      st.stopSince = null;
    }
  }

  #decide(st) {
    if (!st.reached) return this.#conclude(st, 'none', 'left');
    // Còn lượt bám đang mở của biển cùng họ ở đúng chỗ (camera vừa ngừng khi đang bám biển): đợi nó kết thúc (tự kết
    // thúc sau FRAME_GAP_MS nếu không còn khung) để lần thấy đó được tính là thấy lại, không kết luận trước.
    if (this.tracker.tracks.some((tr) => this.#marks(tr, st))) return;
    if (st.noMiss) return this.#conclude(st, 'none', st.noMiss);
    if (st.conflict) return this.#conclude(st, 'none', 'conflict');
    if (st.seen) return this.#conclude(st, 'none', 'seen');
    // Camera phải xử lý đủ khung trong cửa sổ, không ngừng giữa chừng, và còn chạy khi biển đã ra khỏi cửa sổ.
    if (st.frames < MIN_WINDOW_FRAMES || st.gap || !st.near) return this.#conclude(st, 'none', 'camera');
    if (st.lumBad) return this.#conclude(st, 'none', 'lum');
    if (!st.night && !(sunElevation(st.coord, new Date(this.now())) > SUN_DAY)) return this.#conclude(st, 'none', 'night');
    if (st.stopped) return this.#conclude(st, 'none', 'stop');
    if (st.accBad) return this.#conclude(st, 'none', 'accuracy');
    if (st.switched) return this.#conclude(st, 'none', 'way');
    return this.#conclude(st, 'miss', null);
  }

  #conclude(st, outcome, reason) {
    this.passes.delete(st.id);
    let record = null;
    if (outcome === 'miss') record = this.store.pass(st.id, 'miss');
    else record = typeof this.store.get === 'function' ? this.store.get(st.id) : null;
    this.#count('events', outcome === 'miss' ? 'miss' : `none:${reason}`);
    if (record) this.#emit(record, outcome, reason, reason === 'conflict' && st.valueConflict ? { valueChanged: true } : null);
  }
}
