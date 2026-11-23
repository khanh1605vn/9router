// Bám biển qua các khung hình camera và quyết định một lượt bám có đủ tin để thành "một lần thấy biển" không
// (thử nghiệm). Thuần logic, không đụng tới DOM; đầu vào là kết quả của Vision.process() (hợp đồng 5): hộp theo
// pixel của cả khung, x, y là góc trên bên trái.
// - Tracker: ghép hộp của khung mới với các lượt bám đang mở (IoU hoặc khoảng cách tâm, tỉ lệ cỡ hộp, hướng giãn ra
//   theo chiều dọc từ đường chân trời), lọc Kalman vận tốc không đổi trên tâm x, y và 1/w; phát hiện biển phụ ngay dưới biển.
// - fitRange: biển đứng yên thì 1/w giảm tuyến tính theo quãng đường xe đi D: 1/w = (Z0 − D)/(f·W). Hồi quy có trọng
//   số w⁴ cho Z0 (không phụ thuộc tiêu cự f) và cỡ biển W.
// - acceptTrack: các bước lọc 1–11 của PLAN §5.5. Bước 12 (đã bị báo sai) nằm ở LearnedSigns.observe, bước 13
//   (bản đồ đã có biển này) do Learner tính (cần hành lang và dữ liệu đường) rồi LearnedSigns.observe áp dụng.

// ---- Máy ảnh mặc định (khi chưa biết thông số thật) ----
export const DEFAULT_WIDTH = 1920; // px
export const DEFAULT_HEIGHT = 1080; // px
export const DEFAULT_HFOV = 70; // góc nhìn ngang (độ)
export const FOE_Y = 0.42; // điểm tụ mặc định nằm ở 0,42 chiều cao khung (như visionproto.js)

// ---- Ghép hộp vào lượt bám (PLAN §5.3) ----
export const IOU_MIN = 0.2; // IoU với hộp dự đoán tối thiểu
export const CENTRE_GATE = 0.6; // hoặc tâm lệch không quá chừng này lần bề rộng dự đoán
export const SCALE_MIN = 0.8; // tỉ lệ bề rộng mỗi bước (khung đã xử lý) trong khoảng này
export const SCALE_MAX = 1.6;
export const FOE_MIN_MOVE = 3; // dịch chuyển dọc trên chừng này (px) thì phải hướng ra xa đường chân trời
export const FOE_BASE = 3; // đo dịch chuyển từ hộp cách đó chừng này khung đã ghép (đỡ nhiễu tâm vài px)
export const LONG_BONUS = 0.05; // điểm ghép cộng thêm cho lượt bám đã dài (tối đa, từ 10 khung)
export const MAX_MISSED = 3; // số khung đã xử lý liên tiếp không ghép được thì kết thúc lượt bám
export const EDGE_MARGIN = 2; // hộp chạm mép khung (px) thì kết thúc (hộp bị cắt, bề rộng sai)
export const MAX_TRACK_MS = 15000; // lượt bám dài nhất (ms)
export const MAX_TRACKS = 32; // số lượt bám mở cùng lúc tối đa
// Biển phụ: hộp 'plate' ngay dưới biển, tâm hộp thấp hơn mép dưới biển 0,1–1,2 lần bề rộng biển, chồng ngang
// ≥ 50 % bề rộng hộp hẹp hơn, ở ít nhất 2 khung.
export const PLATE_GAP_MIN = 0.1;
export const PLATE_GAP_MAX = 1.2;
export const PLATE_OVERLAP = 0.5;
export const PLATE_FRAMES = 2;

// ---- Nhận một lượt bám (PLAN §5.5) ----
export const CLS_P_MIN = 0.6; // khung "đã phân loại": nhãn đứng đầu có p ≥ chừng này và không phải nền/biển khác
export const MIN_CLS_FRAMES = 3; // bước 1: số khung đã phân loại tối thiểu
export const MIN_CLS_FRAMES_SPEED = 4; // … với biển tốc độ P.127[n]
export const AGREE_MIN = 0.7; // bước 2: tỉ lệ khung cùng nhãn (mã và trị số)
export const MEAN_P_MIN = 0.85; // bước 3: p trung bình của các khung cùng nhãn
export const MARGIN_MIN = 0.3; // bước 3: chênh lệch trung bình giữa nhãn thứ nhất và thứ hai
export const MIN_TRAVEL = 15; // bước 5: xe đi được ít nhất chừng này trong lượt bám (m)
export const MIN_DURATION = 600; // bước 5: lượt bám kéo dài ít nhất chừng này (ms)
export const MIN_RANGE_POINTS = 4; // bước 5: số điểm (khung có vị trí xe) tối thiểu cho hồi quy
export const R2_MIN = 0.9; // bước 6
export const Z_LAST_MIN = 3; // bước 6: khoảng cách tới biển ở khung cuối (m)
export const Z_LAST_MAX = 60;
export const W_MIN = 0.45; // bước 7: cỡ biển ước tính (m); bước lọc mềm, không loại được hình dán trên xe
export const W_MAX = 1.7;
export const ASPECT_ROUND = [0.8, 1.25]; // bước 8: cao/rộng của biển tròn, bát giác, hình thoi
export const ASPECT_TRIANGLE = [0.7, 1.05]; // … của biển tam giác
export const ASPECT_MIN_W = 20; // chỉ đo cao/rộng trên hộp từ chừng này px trở lên (hộp nhỏ quá nhiễu)
export const LATERAL_MAX = 15; // bước 9: lệch ngang ước tính (m)
export const FIX_ACCURACY_MAX = 20; // bước 10: sai số định vị (m)
export const FIX_SPEED_MIN = 3; // bước 10: tốc độ (m/s)
export const LUM_STD_MIN = 8; // bước 11: độ lệch chuẩn độ sáng (thang 8 bit); khung trơn là camera bị che/tắt
export const LUM_MEAN_MIN = 25; // bước 11: độ sáng trung bình
export const LUM_MEAN_MAX = 235;
export const STRONG_FRAMES = 6; // lần thấy "rõ": ≥ 6 khung cùng nhãn …
export const STRONG_P = 0.95; // … p trung bình ≥ 0,95 (ban ngày: do Learner xét)

const NOT_SIGN = new Set(['background', 'other-sign']);
const ROUND = new Set(['ring', 'noentry', 'bluering', 'end', 'bluedisc', 'octagon', 'diamond']);
const TRIANGLE = new Set(['triangle', 'invtriangle']);
const RAD = Math.PI / 180;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Tiêu cự theo pixel từ bề rộng khung và góc nhìn ngang. */
export function focalPx(width = DEFAULT_WIDTH, hfov = DEFAULT_HFOV) {
  return width / 2 / Math.tan((hfov / 2) * RAD);
}

/** Điểm tụ mặc định của khung W×H. */
export const defaultFoe = (w = DEFAULT_WIDTH, h = DEFAULT_HEIGHT) => ({ x: w / 2, y: FOE_Y * h });

/** Độ sáng khung đủ để tin camera đang thấy cảnh thật (bước 11). */
export function lumOk(lum) {
  return Boolean(lum) && isNum(lum.mean) && isNum(lum.std) && lum.std >= LUM_STD_MIN && lum.mean >= LUM_MEAN_MIN && lum.mean <= LUM_MEAN_MAX;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// ---------------------------------------------------------------------------------------------
// Lọc Kalman một chiều, vận tốc không đổi (trạng thái [giá trị, tốc độ đổi])
// ---------------------------------------------------------------------------------------------

class CV1 {
  constructor(z, r, q, v0Var) {
    this.p = z;
    this.v = 0;
    this.P = [r, 0, 0, v0Var]; // [Ppp, Ppv, Pvp, Pvv]
    this.q = q;
  }

  /** Dự đoán sau dt giây (không đổi trạng thái). */
  peek(dt) {
    return this.p + this.v * dt;
  }

  predict(dt) {
    const [a, b, c, d] = this.P;
    const q = this.q;
    this.p += this.v * dt;
    // P = F P Fᵀ + Q, F = [[1, dt], [0, 1]], Q của gia tốc nhiễu trắng.
    this.P = [
      a + dt * (b + c) + dt * dt * d + (q * dt ** 3) / 3,
      b + dt * d + (q * dt * dt) / 2,
      c + dt * d + (q * dt * dt) / 2,
      d + q * dt,
    ];
  }

  update(z, r) {
    const [a, b, c, d] = this.P;
    const s = a + r;
    const k0 = a / s;
    const k1 = c / s;
    const y = z - this.p;
    this.p += k0 * y;
    this.v += k1 * y;
    this.P = [(1 - k0) * a, (1 - k0) * b, c - k1 * a, d - k1 * b];
  }
}

// ---- Lọc Kalman của lượt bám ----
export const Q_XY = 600 ** 2; // nhiễu gia tốc của tâm hộp (px²/s³): tâm tăng tốc mạnh khi biển tới gần
export const R_XY = 1.5 ** 2; // nhiễu đo tâm (px²)
export const V0_XY = 400 ** 2; // độ bất định tốc độ ban đầu của tâm (px²/s²)
export const Q_IW = 1e-4; // nhiễu gia tốc của 1/w (1/px² /s³); xe chạy đều thì 1/w giảm tuyến tính
export const V0_IW = 0.05 ** 2; // độ bất định tốc độ đổi ban đầu của 1/w ((1/px)²/s²)
export const BOX_NOISE_REL = 0.03; // nhiễu đo bề rộng hộp: phần tỉ lệ (3 %) …
export const BOX_NOISE_PX = 0.7; // … cộng phần cố định (px)
/** Phương sai đo của 1/w khi bề rộng đo là w px: σw = 3 % · w + 0,7 px, σ(1/w) ≈ σw / w². */
export const rIw = (w) => ((BOX_NOISE_REL * w + BOX_NOISE_PX) / (w * w)) ** 2;

// ---------------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------------

/**
 * Lượt bám: { id, family, points: [{ t, D|null, x, y, w, h, s, pass, cls, lum, pose }], plate: 'unread'|null,
 * reason: 'lost'|'edge'|'timeout'|'flush' } (reason có khi đã kết thúc).
 * pose của mỗi điểm do Learner nội suy: { D (m), speed (m/s), accuracy (m), simulated, corridor } hoặc null.
 */
export class Tracker {
  /**
   * @param width, height  cỡ khung (px)
   * @param foe            điểm tụ { x, y } (px), mặc định giữa khung theo chiều ngang, 0,42 chiều cao
   */
  constructor({ width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, foe = null } = {}) {
    this.tracks = [];
    this.nextId = 1;
    this.setFrame({ width, height, foe });
  }

  setFrame({ width = this.width, height = this.height, foe = null } = {}) {
    this.width = width;
    this.height = height;
    this.foe = foe && isNum(foe.x) && isNum(foe.y) ? { x: foe.x, y: foe.y } : defaultFoe(width, height);
  }

  reset() {
    this.tracks = [];
  }

  /** Hộp dự đoán của các lượt bám đang mở ở thời điểm t (ms): gợi ý cho bộ phân loại (Vision.process hints). */
  hints(t) {
    return this.tracks.map((tr) => this.#predict(tr, t)[0]).map(({ x, y, w, h }) => ({ x, y, w, h }));
  }

  /** Kết thúc mọi lượt bám đang mở (camera tắt, đổi chuyến) → các lượt bám đó. */
  flush() {
    const out = this.tracks.map((tr) => this.#finish(tr, 'flush'));
    this.tracks = [];
    return out;
  }

  #touchesEdge(b) {
    return b.x <= EDGE_MARGIN || b.y <= EDGE_MARGIN || b.x + b.w >= this.width - EDGE_MARGIN || b.y + b.h >= this.height - EDGE_MARGIN;
  }

  /** Các hộp dự đoán ở thời điểm t: theo Kalman, và theo mô hình giãn ra từ điểm tụ (khi đã có tốc độ đổi cỡ). */
  #predict(tr, t) {
    const last = tr.points[tr.points.length - 1];
    const dt = Math.max(0, (t - last.t) / 1000);
    const iw = tr.kiw.peek(dt);
    const w = iw > 0 && 1 / iw < 4 * this.width ? 1 / iw : last.w;
    const h = w * (last.h / last.w);
    const cx = tr.kx.peek(dt);
    const cy = tr.ky.peek(dt);
    const out = [{ x: cx - w / 2, y: cy - h / 2, w, h }];
    if (tr.points.length >= 2) {
      const c = centreOf(last);
      const k = w / last.w;
      const ex = this.foe.x + (c.x - this.foe.x) * k;
      const ey = this.foe.y + (c.y - this.foe.y) * k;
      out.push({ x: ex - w / 2, y: ey - h / 2, w, h });
    }
    return out;
  }

  /** Điểm ghép của hộp b với lượt bám tr (càng lớn càng hợp), hoặc −1 khi không qua các bước lọc. */
  #score(tr, b, t) {
    if (b.family !== tr.family) return -1;
    const last = tr.points[tr.points.length - 1];
    const steps = tr.missed + 1;
    // Tỉ lệ so với bề rộng đã lọc ở khung trước (hai hộp thô 10–14 px lệch nhau tới 25 % chỉ vì nhiễu).
    const iwf = tr.kiw.p;
    const ratio = b.w / (iwf > 0 && 1 / iwf < 4 * this.width ? 1 / iwf : last.w);
    if (!(ratio >= SCALE_MIN ** steps && ratio <= SCALE_MAX ** steps)) return -1;
    // Biển đứng yên trước xe đang chạy giãn ra từ điểm tụ. Chỉ xét theo chiều dọc: máy gắn lệch vài độ (camAim để mặc
    // định) và xe vào cua dời cả khung theo chiều ngang (điểm tụ thật không ở điểm tụ giả định), nhưng không đổi chiều
    // dọc. Hộp cách đường chân trời quá một bề rộng biển (đo ở FOE_BASE khung trước, để nhiễu tâm vài px của biển ở xa
    // không làm sai hướng) mà dịch dọc quá FOE_MIN_MOVE px về phía đường chân trời thì không phải biển đó. Lượt bám chưa
    // đủ FOE_BASE khung thì chưa xét.
    const c = centreOf(b);
    const basePt = tr.points.length >= FOE_BASE ? tr.points[tr.points.length - FOE_BASE] : null;
    if (basePt) {
      const ry = centreOf(basePt).y - this.foe.y;
      const dy = c.y - centreOf(basePt).y;
      if (Math.abs(ry) > basePt.w && dy * ry < 0 && Math.abs(dy) > FOE_MIN_MOVE) return -1;
    }
    let best = -1;
    // Thêm một dự đoán theo mô hình giãn ra từ điểm tụ với chính tỉ lệ cỡ của hộp b: dùng được ngay từ khung thứ hai,
    // khi Kalman chưa biết tốc độ (biển ở gần nhảy vài chục px mỗi khung).
    const lc = centreOf(last);
    const k = b.w / last.w;
    const own = { w: b.w, h: b.h, x: this.foe.x + (lc.x - this.foe.x) * k - b.w / 2, y: this.foe.y + (lc.y - this.foe.y) * k - b.h / 2 };
    for (const p of [...this.#predict(tr, t), own]) {
      const o = iou(p, b);
      const pc = centreOf(p);
      const near = Math.hypot(pc.x - c.x, pc.y - c.y) <= CENTRE_GATE * p.w;
      if (o >= IOU_MIN || near) best = Math.max(best, o + (near ? 0.01 : 0));
    }
    // Hai lượt bám cùng tranh một hộp: lượt bám dài hơn được ưu tiên.
    return best < 0 ? best : best + LONG_BONUS * Math.min(1, tr.points.length / 10);
  }

  #start(b, t, pose, lum) {
    const c = centreOf(b);
    const tr = {
      id: this.nextId++,
      family: b.family,
      points: [],
      plateHits: 0,
      plate: null,
      missed: 0,
      kx: new CV1(c.x, R_XY, Q_XY, V0_XY),
      ky: new CV1(c.y, R_XY, Q_XY, V0_XY),
      kiw: new CV1(1 / b.w, rIw(b.w), Q_IW, V0_IW),
    };
    this.#add(tr, b, t, pose, lum, true);
    return tr;
  }

  #add(tr, b, t, pose, lum, first = false) {
    if (!first) {
      const last = tr.points[tr.points.length - 1];
      const dt = Math.max(0, (t - last.t) / 1000);
      const c = centreOf(b);
      tr.kx.predict(dt);
      tr.ky.predict(dt);
      tr.kiw.predict(dt);
      tr.kx.update(c.x, R_XY);
      tr.ky.update(c.y, R_XY);
      tr.kiw.update(1 / b.w, rIw(b.w));
    }
    tr.points.push({
      t,
      D: pose && isNum(pose.D) ? pose.D : null,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      s: b.s,
      pass: b.pass,
      cls: Array.isArray(b.cls) ? b.cls : null,
      lum: lum || null,
      pose: pose || null,
    });
    tr.missed = 0;
  }

  #finish(tr, reason) {
    return { id: tr.id, family: tr.family, points: tr.points, plate: tr.plate, reason };
  }

  /** Biển phụ ngay dưới hộp biển b trong cùng khung. */
  static plateBelow(b, plates) {
    for (const p of plates) {
      const gap = p.y + p.h / 2 - (b.y + b.h);
      if (gap < PLATE_GAP_MIN * b.w || gap > PLATE_GAP_MAX * b.w) continue;
      const overlap = Math.min(b.x + b.w, p.x + p.w) - Math.max(b.x, p.x);
      if (overlap >= PLATE_OVERLAP * Math.min(b.w, p.w)) return true;
    }
    return false;
  }

  /**
   * Một khung đã xử lý → các lượt bám vừa kết thúc.
   * @param result  kết quả Vision.process(): { t (ms, đồng hồ đơn điệu), lum, boxes }
   * @param pose    vị trí xe lúc chụp khung (Learner nội suy) hoặc null
   */
  update(result, pose = null) {
    if (!result || !isNum(result.t) || !Array.isArray(result.boxes)) return [];
    const t = result.t;
    const lum = result.lum || null;
    const valid = (b) => b && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h) && b.w > 0 && b.h > 0;
    const boxes = result.boxes.filter((b) => valid(b) && b.family !== 'plate');
    const plates = result.boxes.filter((b) => valid(b) && b.family === 'plate');
    const ended = [];

    // Ghép tham lam theo điểm ghép giảm dần.
    const pairs = [];
    this.tracks.forEach((tr, ti) => {
      boxes.forEach((b, bi) => {
        const sc = this.#score(tr, b, t);
        if (sc >= 0) pairs.push({ ti, bi, sc });
      });
    });
    pairs.sort((a, b) => b.sc - a.sc);
    const usedT = new Set();
    const usedB = new Set();
    const done = new Set();
    for (const { ti, bi } of pairs) {
      if (usedT.has(ti) || usedB.has(bi)) continue;
      usedT.add(ti);
      usedB.add(bi);
      const tr = this.tracks[ti];
      const b = boxes[bi];
      if (this.#touchesEdge(b)) {
        ended.push(this.#finish(tr, 'edge'));
        done.add(tr);
        continue;
      }
      this.#add(tr, b, t, pose, lum);
      if (Tracker.plateBelow(b, plates)) tr.plateHits++;
      if (tr.plateHits >= PLATE_FRAMES) tr.plate = 'unread';
      if (t - tr.points[0].t > MAX_TRACK_MS) {
        ended.push(this.#finish(tr, 'timeout'));
        done.add(tr);
      }
    }
    this.tracks.forEach((tr, ti) => {
      if (usedT.has(ti) || done.has(tr)) return;
      tr.missed++;
      if (tr.missed >= MAX_MISSED || t - tr.points[0].t > MAX_TRACK_MS) {
        ended.push(this.#finish(tr, tr.missed >= MAX_MISSED ? 'lost' : 'timeout'));
        done.add(tr);
      }
    });
    this.tracks = this.tracks.filter((tr) => !done.has(tr));
    boxes.forEach((b, bi) => {
      if (usedB.has(bi) || this.#touchesEdge(b) || this.tracks.length >= MAX_TRACKS) return;
      const tr = this.#start(b, t, pose, lum);
      if (Tracker.plateBelow(b, plates)) tr.plateHits++;
      this.tracks.push(tr);
    });
    return ended;
  }
}

// ---------------------------------------------------------------------------------------------
// Khoảng cách và cỡ biển
// ---------------------------------------------------------------------------------------------

/**
 * Hồi quy có trọng số (∝ w⁴, vì var(1/w) ≈ σw²/w⁴) của 1/w theo D: 1/w = a + b·D, b = −1/(f·W).
 * @param points [{ D (m, quãng đường xe đã đi), w (px) }]
 * @param focal  tiêu cự (px), chỉ dùng cho W
 * @returns { Z0, W, r2, n, Zlast, slope, intercept } hoặc null (dưới 4 điểm, biển không lớn dần, dữ liệu suy biến).
 *   Z0 = −a/b là khoảng cách tới biển khi D = 0, không phụ thuộc f; Zlast = Z0 − D của điểm cuối.
 */
export function fitRange(points, focal = focalPx()) {
  const pts = (points || []).filter((p) => p && isNum(p.D) && isNum(p.w) && p.w > 0);
  const n = pts.length;
  if (n < MIN_RANGE_POINTS) return null;
  const D0 = pts[0].D;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = p.D - D0;
    const y = 1 / p.w;
    const wt = p.w ** 4;
    sw += wt;
    sx += wt * x;
    sy += wt * y;
    sxx += wt * x * x;
    sxy += wt * x * y;
  }
  const den = sw * sxx - sx * sx;
  if (!(den > 0)) return null;
  const b = (sw * sxy - sx * sy) / den;
  const a = (sy - b * sx) / sw;
  if (!(b < 0)) return null;
  const ybar = sy / sw;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of pts) {
    const x = p.D - D0;
    const y = 1 / p.w;
    const wt = p.w ** 4;
    ssTot += wt * (y - ybar) ** 2;
    ssRes += wt * (y - a - b * x) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const Z0 = -a / b + D0;
  return { Z0, W: -1 / (focal * b), r2, n, Zlast: Z0 - pts[n - 1].D, slope: b, intercept: a - b * D0 };
}

// ---------------------------------------------------------------------------------------------
// Nhận lượt bám
// ---------------------------------------------------------------------------------------------

const toIndex = (labels) => {
  if (labels instanceof Map) return labels;
  const list = Array.isArray(labels) ? labels : labels && Array.isArray(labels.labels) ? labels.labels : [];
  return new Map(list.filter((l) => l && typeof l.label === 'string').map((l) => [l.label, l]));
};

const median = (arr) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Khung đã phân loại: nhãn đứng đầu đủ tin và là biển. */
export const classified = (pt) =>
  Array.isArray(pt.cls) && pt.cls.length > 0 && Array.isArray(pt.cls[0]) && typeof pt.cls[0][0] === 'string' &&
  isNum(pt.cls[0][1]) && pt.cls[0][1] >= CLS_P_MIN && !NOT_SIGN.has(pt.cls[0][0]);

/** Nhãn chiếm đa số trong các khung đã phân loại → { label, agree, total } hoặc null. */
export function majorityLabel(track) {
  const counts = new Map();
  let total = 0;
  for (const pt of track.points || []) {
    if (!classified(pt)) continue;
    total++;
    counts.set(pt.cls[0][0], (counts.get(pt.cls[0][0]) || 0) + 1);
  }
  let best = null;
  for (const [label, n] of counts) if (!best || n > best.agree) best = { label, agree: n, total };
  return best;
}

/**
 * Các bước lọc 1–11 của PLAN §5.5 trên một lượt bám đã kết thúc.
 * @param ctx { labels (labels.json hoặc Map nhãn → mục), focal (px), foe { x, y } }
 * @returns { ok: true, obs } | { ok: false, reason }
 *   reason: 'cls-frames'|'agreement'|'confidence'|'whitelist'|'span'|'fit'|'range'|'size'|'facing'|'lateral'|
 *           'fixes'|'camera'
 *   obs: { label, code, value, family, junction, frames, agree, meanP, margin, strong, Z, t, D, W, r2, n, lateral,
 *          plate, t0, travel }  (Z: khoảng cách tới biển ở khung cuối có vị trí xe, t và D của khung đó)
 */
export function acceptTrack(track, ctx = {}) {
  const labels = toIndex(ctx.labels);
  const focal = isNum(ctx.focal) ? ctx.focal : focalPx();
  const foe = ctx.foe && isNum(ctx.foe.x) ? ctx.foe : defaultFoe();
  const pts = (track && track.points) || [];
  const fail = (reason) => ({ ok: false, reason });

  // 1–3. Phân loại qua nhiều khung.
  const maj = majorityLabel(track || {});
  if (!maj) return fail('cls-frames');
  const isSpeed = maj.label.startsWith('P.127[');
  if (maj.total < (isSpeed ? MIN_CLS_FRAMES_SPEED : MIN_CLS_FRAMES)) return fail('cls-frames');
  if (maj.agree / maj.total < AGREE_MIN) return fail('agreement');
  const agreeing = pts.filter((pt) => classified(pt) && pt.cls[0][0] === maj.label);
  const meanP = agreeing.reduce((s, pt) => s + pt.cls[0][1], 0) / agreeing.length;
  const margin =
    agreeing.reduce((s, pt) => s + pt.cls[0][1] - (Array.isArray(pt.cls[1]) && isNum(pt.cls[1][1]) ? pt.cls[1][1] : 0), 0) /
    agreeing.length;
  if (meanP < MEAN_P_MIN || margin < MARGIN_MIN) return fail('confidence');

  // 4. Danh sách được học.
  const entry = labels.get(maj.label);
  if (!entry || entry.learn !== true) return fail('whitelist');

  // 5. Độ dài lượt bám.
  const ranged = pts.filter((pt) => isNum(pt.D) && pt.pose);
  if (ranged.length < MIN_RANGE_POINTS) return fail('span');
  const first = ranged[0];
  const last = ranged[ranged.length - 1];
  const travel = last.D - first.D;
  if (travel < MIN_TRAVEL || last.t - pts[0].t < MIN_DURATION) return fail('span');

  // 6. Hồi quy khoảng cách.
  const fit = fitRange(ranged, focal);
  if (!fit || !(fit.r2 >= R2_MIN)) return fail('fit');
  if (fit.Zlast < Z_LAST_MIN || fit.Zlast > Z_LAST_MAX) return fail('range');

  // 7. Cỡ biển (lọc mềm).
  if (!(fit.W >= W_MIN && fit.W <= W_MAX)) return fail('size');

  // 8. Mặt biển nhìn thẳng về phía xe: tỉ lệ cao/rộng.
  const family = typeof entry.family === 'string' ? entry.family : track.family;
  const range = ROUND.has(family) ? ASPECT_ROUND : TRIANGLE.has(family) ? ASPECT_TRIANGLE : null;
  if (range) {
    const big = pts.filter((pt) => pt.w >= ASPECT_MIN_W);
    const aspect = median((big.length ? big : pts).map((pt) => pt.h / pt.w));
    if (!(aspect >= range[0] && aspect <= range[1])) return fail('facing');
  }

  // 9. Lệch ngang so với hướng đi.
  const lateral = ((last.x + last.w / 2 - foe.x) / focal) * fit.Zlast;
  if (Math.abs(lateral) > LATERAL_MAX) return fail('lateral');

  // 10. Định vị trong suốt lượt bám.
  for (const pt of ranged) {
    const p = pt.pose;
    if (p.simulated || !(p.accuracy <= FIX_ACCURACY_MAX) || !(p.speed >= FIX_SPEED_MIN) || !p.corridor) return fail('fixes');
  }

  // 11. Camera thấy cảnh thật ở mọi khung.
  if (!pts.every((pt) => lumOk(pt.lum))) return fail('camera');

  return {
    ok: true,
    obs: {
      label: maj.label,
      code: entry.code,
      value: entry.value ?? null,
      family,
      junction: entry.junction === true,
      frames: maj.total,
      agree: maj.agree,
      meanP,
      margin,
      strong: maj.agree >= STRONG_FRAMES && meanP >= STRONG_P,
      Z: fit.Zlast,
      t: last.t,
      D: last.D,
      W: fit.W,
      r2: fit.r2,
      n: fit.n,
      lateral,
      plate: track.plate || null,
      t0: pts[0].t,
      travel,
    },
  };
}
