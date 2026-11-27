import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import {
  acceptTrack,
  AGREE_MIN,
  BOX_NOISE_PX,
  BOX_NOISE_REL,
  ASPECT_ROUND,
  ASPECT_TRIANGLE,
  CENTRE_GATE,
  CLS_P_MIN,
  defaultFoe,
  EDGE_MARGIN,
  FIX_ACCURACY_MAX,
  FIX_SPEED_MIN,
  fitRange,
  focalPx,
  FOE_BASE,
  FOE_MIN_MOVE,
  IOU_MIN,
  ASPECT_MIN_W,
  LATERAL_MAX,
  LONG_BONUS,
  MAX_TRACKS,
  LUM_MEAN_MAX,
  LUM_MEAN_MIN,
  LUM_STD_MIN,
  lumOk,
  majorityLabel,
  MARGIN_MIN,
  MAX_MISSED,
  MAX_TRACK_MS,
  MEAN_P_MIN,
  MIN_CLS_FRAMES,
  MIN_CLS_FRAMES_SPEED,
  MIN_DURATION,
  MIN_RANGE_POINTS,
  MIN_TRAVEL,
  PLATE_FRAMES,
  PLATE_GAP_MAX,
  PLATE_GAP_MIN,
  PLATE_OVERLAP,
  Q_IW,
  Q_XY,
  R_XY,
  R2_MIN,
  rIw,
  SCALE_MAX,
  SCALE_MIN,
  STRONG_FRAMES,
  STRONG_P,
  Tracker,
  V0_IW,
  V0_XY,
  W_MAX,
  W_MIN,
  Z_LAST_MAX,
  Z_LAST_MIN,
} from '../js/signtrack.js';

// Cờ learn lấy từ danh sách học cố định (như models/labels.json chưa huấn luyện), không đọc tệp đã cài: một lần
// huấn luyện đầy đủ có thể gỡ nhãn khỏi danh sách học (BD_PRUNE) mà phép thử logic học không được phụ thuộc vào đó.
const labels = buildLabels(SIGN_CATALOGUE);
const F = focalPx(1920, 70);
const FOE = defaultFoe(1920, 1080);
const LUM = { mean: 120, std: 40 };
const CTX = { labels, focal: F, foe: FOE };

/**
 * Lượt bám dựng từ hình học (camera lỗ kim): biển cỡ W (m) lệch X (m) sang phải, cao hơn camera Y (m), xe tiến từ
 * cách biển Z0 tới Zend, mỗi khung đi `step` m sau dt ms.
 */
function synth({
  Z0 = 60, Zend = 9, step = 2.5, dt = 200, W = 0.7, X = 5, Y = 1.2, f = F, label = 'P.127[50]', p = 0.95, p2 = 0.03,
  family = 'ring', aspect = 1, pose = {}, lum = LUM, clsFrom = 20, D0 = 100, t0 = 1000,
} = {}) {
  const points = [];
  for (let k = 0; Z0 - k * step >= Zend - 1e-9; k++) {
    const Z = Z0 - k * step;
    const w = (f * W) / Z;
    const h = w * aspect;
    const cx = FOE.x + (f * X) / Z;
    const cy = FOE.y - (f * Y) / Z;
    const D = D0 + k * step;
    points.push({
      t: t0 + k * dt,
      D,
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      s: 0.8,
      pass: 'A',
      cls: w >= clsFrom ? [[label, p], ['other-sign', p2], ['background', 0.01]] : null,
      lum,
      pose: { D, speed: (step / dt) * 1000, accuracy: 5, simulated: false, corridor: true, ...pose },
    });
  }
  return { id: 1, family, points, plate: null, reason: 'lost' };
}

const reason = (tr, ctx = CTX) => {
  const r = acceptTrack(tr, ctx);
  return r.ok ? 'ok' : r.reason;
};

// ---------------------------------------------------------------------------------------------
// fitRange
// ---------------------------------------------------------------------------------------------

test('fitRange: Z0 không phụ thuộc tiêu cự, W đúng theo tiêu cự, R² = 1 khi không nhiễu', () => {
  const pts = (f) => synth({ f, Z0: 80, Zend: 10, D0: 0 }).points.map(({ D, w }) => ({ D, w }));
  const a = fitRange(pts(F), F);
  const b = fitRange(pts(2 * F), 2 * F);
  assert.ok(Math.abs(a.Z0 - 80) < 1e-6, `Z0 = ${a.Z0}`);
  assert.ok(Math.abs(b.Z0 - 80) < 1e-6);
  assert.ok(Math.abs(a.W - 0.7) < 1e-9 && Math.abs(b.W - 0.7) < 1e-9);
  assert.ok(a.r2 > 0.999999);
  assert.equal(a.n, pts(F).length);
  // Cùng các điểm nhưng gán sai tiêu cự: Z0 không đổi, chỉ W đổi theo.
  const c = fitRange(pts(F), 2 * F);
  assert.ok(Math.abs(c.Z0 - a.Z0) < 1e-9);
  assert.ok(Math.abs(c.W - 0.35) < 1e-9);
  // Gốc D tuỳ ý: Zlast là khoảng cách ở điểm cuối.
  const d = fitRange(synth({ Z0: 80, Zend: 10, D0: 500 }).points, F);
  assert.ok(Math.abs(d.Zlast - 10) < 1e-6 && Math.abs(d.Z0 - 580) < 1e-6);
});

test('fitRange: dưới 4 điểm, biển không lớn dần, dữ liệu suy biến → null; nhiễu làm R² giảm', () => {
  assert.equal(MIN_RANGE_POINTS, 4);
  const pts = synth({ Z0: 30, Zend: 22.5, D0: 0 }).points; // 4 điểm
  assert.equal(pts.length, 4);
  assert.ok(fitRange(pts, F));
  assert.equal(fitRange(pts.slice(0, 3), F), null);
  assert.equal(fitRange([...pts].reverse().map((p, i) => ({ D: i, w: p.w })), F), null, 'nhỏ dần: đang đi ra xa');
  assert.equal(fitRange(pts.map((p) => ({ D: 5, w: p.w })), F), null, 'xe đứng yên');
  assert.equal(fitRange([{ D: 0, w: 0 }, { D: 1, w: NaN }, null, { D: 2 }], F), null);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const noisy = synth({ Z0: 60, Zend: 9, D0: 0 }).points.map((p) => ({ D: p.D, w: p.w * (1 + 0.1 * rnd()) }));
  const r = fitRange(noisy, F);
  assert.ok(r.r2 < 0.9999 && r.r2 > R2_MIN, `r2 = ${r.r2}`);
});

// ---------------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------------

const frameOf = (pt, extra = []) => ({
  t: pt.t,
  lum: LUM,
  boxes: [{ x: pt.x, y: pt.y, w: pt.w, h: pt.h, family: 'ring', s: 0.8, pass: 'A', cls: pt.cls }, ...extra],
});
const pose = (pt) => pt.pose;

test('Tracker: biển tiến lại gần thành một lượt bám, kết thúc khi mất 3 khung liên tiếp', () => {
  assert.equal(MAX_MISSED, 3);
  const tr = new Tracker();
  const pts = synth({ Z0: 90, Zend: 9 }).points;
  for (const pt of pts) assert.deepEqual(tr.update(frameOf(pt), pose(pt)), []);
  assert.equal(tr.tracks.length, 1);
  const last = pts[pts.length - 1];
  assert.deepEqual(tr.update({ t: last.t + 200, lum: LUM, boxes: [] }), []);
  assert.deepEqual(tr.update({ t: last.t + 400, lum: LUM, boxes: [] }), []);
  const ended = tr.update({ t: last.t + 600, lum: LUM, boxes: [] });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'lost');
  assert.equal(ended[0].points.length, pts.length);
  assert.equal(ended[0].points[5].D, pts[5].D);
  assert.equal(tr.tracks.length, 0);
});

test('Tracker: hộp chạm mép khung kết thúc lượt bám (không thêm hộp bị cắt)', () => {
  const tr = new Tracker();
  const pts = synth({ Z0: 40, Zend: 8, step: 2, X: 4 }).points;
  for (const pt of pts) tr.update(frameOf(pt), pose(pt));
  const last = pts[pts.length - 1];
  // Khung kế tiếp (cách biển 6 m): hộp thật vượt mép phải, máy dò trả về phần còn trong khung.
  const [next] = synth({ Z0: 6, Zend: 6, X: 4 }).points;
  const edgeBox = { x: next.x, y: next.y, w: 1920 - next.x, h: next.h, family: 'ring', s: 0.8, pass: 'B', cls: null };
  assert.ok(next.x + next.w > 1920 && edgeBox.x + edgeBox.w >= 1920 - EDGE_MARGIN);
  const ended = tr.update({ t: last.t + 200, lum: LUM, boxes: [edgeBox] }, null);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'edge');
  assert.equal(ended[0].points.length, pts.length);
  assert.equal(tr.tracks.length, 0, 'hộp chạm mép không mở lượt bám mới');
});

test('Tracker: lượt bám dài nhất 15 giây', () => {
  assert.equal(MAX_TRACK_MS, 15000);
  const tr = new Tracker();
  const box = { x: 1300, y: 300, w: 40, h: 40, family: 'ring', s: 0.8, pass: 'A', cls: null };
  let ended = [];
  let t = 0;
  for (; t <= 15000; t += 200) assert.deepEqual(tr.update({ t, lum: LUM, boxes: [{ ...box }] }), []);
  ended = tr.update({ t, lum: LUM, boxes: [{ ...box }] });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'timeout');
});

test('Tracker: lọc theo IoU/khoảng cách tâm, tỉ lệ cỡ mỗi bước và cùng họ biển', () => {
  assert.equal(IOU_MIN, 0.2);
  assert.equal(CENTRE_GATE, 0.6);
  assert.deepEqual([SCALE_MIN, SCALE_MAX], [0.8, 1.6]);
  const pts = synth({ Z0: 40, Zend: 25 }).points;
  const run = (mutate) => {
    const tr = new Tracker();
    for (const pt of pts) tr.update(frameOf(pt), pose(pt));
    const last = pts[pts.length - 1];
    const b = { x: last.x, y: last.y, w: last.w * 1.1, h: last.h * 1.1, family: 'ring', s: 0.8, pass: 'A', cls: null };
    mutate(b, last);
    tr.update({ t: last.t + 200, lum: LUM, boxes: [b] });
    return tr.tracks.map((x) => x.points.length);
  };
  const n = pts.length;
  assert.deepEqual(run(() => {}), [n + 1], 'hộp hợp lệ: ghép vào lượt bám cũ');
  assert.deepEqual(run((b) => (b.x += 400)), [n, 1], 'quá xa: lượt bám mới');
  assert.deepEqual(
    run((b, last) => {
      b.w = last.w * 1.7;
      b.h = b.w;
      b.x = last.x + last.w / 2 - b.w / 2;
      b.y = last.y + last.h / 2 - b.h / 2;
    }),
    [n, 1],
    'to lên quá 1,6 lần trong một bước',
  );
  assert.deepEqual(
    run((b, last) => {
      b.w = last.w * 0.75;
      b.h = b.w;
    }),
    [n, 1],
    'nhỏ đi quá 0,8 lần',
  );
  assert.deepEqual(run((b) => (b.family = 'triangle')), [n, 1], 'khác họ biển');
});

test('Tracker: dịch chuyển dọc trên 3 px không được hướng về phía đường chân trời; chiều ngang không xét (máy lệch, vào cua)', () => {
  assert.equal(FOE_MIN_MOVE, 3);
  assert.ok(FOE_BASE >= 2);
  // Biển to, nằm phải điểm tụ: dịch vào trong 12 px vẫn trùng nhiều (IoU cao) nhưng ngược hướng giãn ra.
  const pts = synth({ Z0: 30, Zend: 15 }).points;
  const run = (dx, dy) => {
    const tr = new Tracker();
    for (const pt of pts) tr.update(frameOf(pt), pose(pt));
    const last = pts[pts.length - 1];
    const b = { x: last.x + dx, y: last.y + dy, w: last.w, h: last.h, family: 'ring', s: 0.8, pass: 'A', cls: null };
    tr.update({ t: last.t + 200, lum: LUM, boxes: [b] });
    return tr.tracks.length;
  };
  const last = pts[pts.length - 1];
  const base = pts[pts.length - FOE_BASE];
  // Hướng ra ngoài: tiếp tục chuyển động giãn ra từ điểm tụ.
  const out = { x: last.x - base.x, y: last.y - base.y };
  assert.equal(run(out.x * 0.5, out.y * 0.5), 1);
  // Lệch ngang về phía điểm tụ giả định: máy gắn lệch hay xe vào cua dời cả khung theo chiều ngang, vẫn là biển đó.
  // Điểm tụ giả định lệch 400 px sang phải điểm tụ thật (máy gắn lệch, camAim mặc định): biển đi ngang về phía điểm tụ
  // giả định (chiều dọc vẫn ra xa đường chân trời) vẫn là một lượt bám.
  const yawed = new Tracker({ width: 1920, height: 1080, foe: { x: FOE.x + 400, y: FOE.y } });
  const far = synth({ Z0: 60, Zend: 15 }).points;
  const ended = far.flatMap((pt) => yawed.update(frameOf(pt), pose(pt)));
  assert.deepEqual([ended.length, yawed.tracks.length, yawed.tracks[0].points.length], [0, 1, far.length]);
  assert.equal(run(0, -(last.y - base.y) + 40), 2, 'đi xuống, về phía đường chân trời');
  assert.equal(run(out.x, -(last.y - base.y) + 6), 2, 'dọc về phía đường chân trời quá 3 px');
});

/**
 * Camera lỗ kim trên xe chạy trên cung tròn bán kính R (dương: cua phải, âm: cua trái; Infinity: đường thẳng), máy
 * gắn lệch yaw độ sang phải mà ứng dụng vẫn giả định điểm tụ ở giữa khung (camAim mặc định). Biển 0,7 m lệch lat m
 * sang phải đường (âm: bên trái), cao hơn camera 1,2 m, ở quãng 100 m. → { tracks, ok }
 */
function curveRun({ R = Infinity, yaw = 0, lat = 5, kmh = 50, fps = 5, seed = 1 }) {
  let st = seed >>> 0;
  const r = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const v = kmh / 3.6;
  const dt = 1 / fps;
  const sSign = 100;
  const pos = (s) => (Number.isFinite(R) ? { x: R - R * Math.cos(s / R), y: R * Math.sin(s / R), h: s / R } : { x: 0, y: s, h: 0 });
  const ps = pos(sSign);
  const sx = ps.x + lat * Math.cos(ps.h);
  const sy = ps.y - lat * Math.sin(ps.h);
  const tr = new Tracker({ width: 1920, height: 1080, foe: FOE });
  const ended = [];
  let t = 0;
  for (let s = 0; s < sSign + 5; s += v * dt, t += dt) {
    const c = pos(s);
    const h = c.h + (yaw * Math.PI) / 180;
    const dx = sx - c.x;
    const dy = sy - c.y;
    const Z = dx * Math.sin(h) + dy * Math.cos(h);
    const X = dx * Math.cos(h) - dy * Math.sin(h);
    const boxes = [];
    if (Z > 0.5) {
      const wT = (F * 0.7) / Z;
      const cx = FOE.x + (F * X) / Z + g();
      const cy = FOE.y - (F * 1.2) / Z + g();
      const w = wT * (1 + 0.03 * g()) + 0.7 * g();
      if (wT >= 10 && cx > w && cx < 1920 - w) {
        const cls = w >= 20 ? [['P.127[50]', 0.93], ['other-sign', 0.04]] : null;
        boxes.push({ x: cx - w / 2, y: cy - w / 2, w, h: w, family: 'ring', s: 0.8, pass: 'A', cls });
      }
    }
    ended.push(...tr.update({ t: t * 1000, lum: LUM, boxes }, { D: s, speed: v, accuracy: 5, simulated: false, corridor: true }));
  }
  ended.push(...tr.flush());
  return { tracks: ended.length, ok: ended.some((k) => acceptTrack(k, CTX).ok) };
}

test('Tracker: đường cong (R = ±100, ±200, ±400 m) và máy gắn lệch ±10°, ±15° (camAim mặc định): biển vẫn được nhận', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const all = (o) => seeds.every((seed) => curveRun({ ...o, seed }).ok);
  for (const R of [400, 200, 100, -400, -200, -100]) assert.ok(all({ R }), `R = ${R} m, 50 km/h, 5 khung/giây`);
  for (const yaw of [10, 15, -10, -15]) {
    for (const lat of [5, -3]) assert.ok(all({ yaw, lat, fps: 3 }), `máy lệch ${yaw}°, biển lệch ${lat} m, 3 khung/giây`);
  }
  // Đường thẳng, máy thẳng: một biển là một lượt bám.
  const n = seeds.reduce((a, seed) => a + curveRun({ seed }).tracks, 0) / seeds.length;
  assert.ok(n <= 1.25, `${n} lượt bám mỗi biển`);
});

test('Tracker: biển phụ ngay dưới biển ở ≥ 2 khung → plate "unread"', () => {
  assert.equal(PLATE_FRAMES, 2);
  assert.deepEqual([PLATE_GAP_MIN, PLATE_GAP_MAX, PLATE_OVERLAP], [0.1, 1.2, 0.5]);
  const pts = synth({ Z0: 40, Zend: 20 }).points;
  const plateFor = (pt, dy = 0.2, dx = 0) => ({
    x: pt.x + dx * pt.w,
    y: pt.y + pt.h + dy * pt.w - 0.15 * pt.w,
    w: pt.w,
    h: 0.3 * pt.w,
    family: 'plate',
    s: 0.6,
    pass: 'A',
    cls: null,
  });
  const run = (withPlate) => {
    const tr = new Tracker();
    let out = null;
    pts.forEach((pt, k) => tr.update(frameOf(pt, withPlate(k, pt) ? [withPlate(k, pt)] : []), pose(pt)));
    const last = pts[pts.length - 1];
    for (let k = 1; k <= 3; k++) out = tr.update({ t: last.t + k * 200, lum: LUM, boxes: [] });
    assert.equal(out.length, 1, 'biển phụ không thành lượt bám riêng');
    return out[0].plate;
  };
  assert.equal(run((k, pt) => (k === 3 || k === 5 ? plateFor(pt) : null)), 'unread');
  assert.equal(run((k, pt) => (k === 3 ? plateFor(pt) : null)), null, 'chỉ một khung');
  assert.equal(run((k, pt) => (k % 2 ? plateFor(pt, 0.2, 0.8) : null)), null, 'lệch ngang, chồng dưới 50 %');
  assert.equal(run((k, pt) => (k % 2 ? plateFor(pt, 2) : null)), null, 'quá xa bên dưới');
  assert.equal(run((k, pt) => (k % 2 ? plateFor(pt, -1.2) : null)), null, 'ở trên biển');
  assert.ok(Tracker.plateBelow({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 105, w: 100, h: 30 }]));
});

test('Tracker: hints() trả về hộp dự đoán của các lượt bám đang mở; flush() kết thúc hết', () => {
  const tr = new Tracker();
  const pts = synth({ Z0: 40, Zend: 30 }).points;
  for (const pt of pts) tr.update(frameOf(pt), pose(pt));
  const last = pts[pts.length - 1];
  const [h] = tr.hints(last.t + 200);
  assert.ok(h.w > last.w, 'biển to dần');
  assert.ok(h.x + h.w / 2 > last.x + last.w / 2, 'và dịch ra xa điểm tụ');
  const out = tr.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'flush');
  assert.equal(tr.tracks.length, 0);
});

// ---------------------------------------------------------------------------------------------
// acceptTrack: từng bước lọc của PLAN §5.5
// ---------------------------------------------------------------------------------------------

test('acceptTrack: lượt bám tốt → obs đầy đủ', () => {
  const r = acceptTrack(synth(), CTX);
  assert.equal(r.ok, true, r.reason);
  const o = r.obs;
  assert.equal(o.label, 'P.127[50]');
  assert.equal(o.code, 'P.127');
  assert.equal(o.value, '50');
  assert.equal(o.family, 'ring');
  assert.equal(o.junction, false);
  assert.ok(Math.abs(o.Z - 10) < 1e-6, 'khung cuối cách biển 10 m');
  assert.ok(Math.abs(o.W - 0.7) < 1e-6);
  assert.ok(Math.abs(o.lateral - 5) < 1e-6);
  assert.equal(o.plate, null);
  assert.equal(acceptTrack(synth({ p: 0.96, p2: 0.02 }), CTX).obs.strong, true);
  const stop = acceptTrack(synth({ label: 'R.122', family: 'octagon', W: 0.6 }), CTX);
  assert.equal(stop.ok, true);
  assert.equal(stop.obs.junction, true);
  assert.equal(stop.obs.value, null);
});

test('acceptTrack bước 1: đủ khung đã phân loại (P.127 cần 4)', () => {
  assert.deepEqual([MIN_CLS_FRAMES, MIN_CLS_FRAMES_SPEED, CLS_P_MIN], [3, 4, 0.6]);
  const withCls = (tr, n) => {
    let left = n;
    for (let k = tr.points.length - 1; k >= 0; k--) {
      if (tr.points[k].cls && left > 0) left--;
      else tr.points[k].cls = null;
    }
    return tr;
  };
  assert.equal(reason(withCls(synth({ label: 'P.127[50]', p: 0.97 }), 3)), 'cls-frames');
  assert.equal(reason(withCls(synth({ label: 'P.127[50]', p: 0.97 }), 4)), 'ok');
  assert.equal(reason(withCls(synth({ label: 'P.102', family: 'noentry', p: 0.97 }), 2)), 'cls-frames');
  assert.equal(reason(withCls(synth({ label: 'P.102', family: 'noentry', p: 0.97 }), 3)), 'ok');
  assert.equal(reason(synth({ p: 0.59, p2: 0.01 })), 'cls-frames', 'p dưới 0,6 không phải khung đã phân loại');
  assert.equal(reason(synth({ label: 'background' })), 'cls-frames');
  assert.equal(reason(synth({ label: 'other-sign' })), 'cls-frames');
});

test('acceptTrack bước 2–3: ≥ 70 % khung cùng nhãn, p trung bình ≥ 0,85, chênh lệch ≥ 0,30', () => {
  assert.deepEqual([AGREE_MIN, MEAN_P_MIN, MARGIN_MIN], [0.7, 0.85, 0.3]);
  const mix = (share) => {
    const tr = synth();
    const cls = tr.points.filter((p) => p.cls);
    const k = Math.round(cls.length * (1 - share));
    cls.slice(0, k).forEach((p) => (p.cls = [['P.127[60]', 0.95], ['P.127[50]', 0.03], ['background', 0.01]]));
    return { tr, n: cls.length, k };
  };
  const a = mix(0.6);
  assert.equal(reason(a.tr), 'agreement', `${a.n - a.k}/${a.n}`);
  assert.equal(reason(mix(0.8).tr), 'ok');
  assert.equal(reason(synth({ p: 0.84, p2: 0.05 })), 'confidence');
  assert.equal(reason(synth({ p: 0.86, p2: 0.05 })), 'ok');
  assert.equal(reason(synth({ p: 0.9, p2: 0.61 })), 'confidence', 'chênh lệch 0,29');
});

test('acceptTrack bước 4: chỉ nhãn được học', () => {
  assert.equal(reason(synth({ label: 'P.103b' })), 'whitelist');
  assert.equal(reason(synth({ label: 'W.245a', family: 'triangle', aspect: 0.87 })), 'whitelist');
  assert.equal(reason(synth({ label: 'P.103a' })), 'ok');
});

test('acceptTrack bước 5: quãng đi ≥ 15 m, ≥ 0,6 giây, ≥ 4 điểm có vị trí xe', () => {
  assert.deepEqual([MIN_TRAVEL, MIN_DURATION, MIN_RANGE_POINTS], [15, 600, 4]);
  assert.equal(reason(synth({ Z0: 22, Zend: 9.5, step: 2.5 })), 'span', '12,5 m');
  assert.equal(reason(synth({ Z0: 24.5, Zend: 9.5, step: 2.5 })), 'ok', '15 m');
  assert.equal(reason(synth({ Z0: 25, Zend: 9, step: 4, dt: 100 })), 'span', '0,4 giây');
  const few = synth();
  few.points.forEach((p, k) => {
    if (k < few.points.length - 3) {
      p.D = null;
      p.pose = null;
    }
  });
  assert.equal(reason(few), 'span');
});

test('acceptTrack bước 6: R² ≥ 0,9 và khoảng cách ở khung cuối 3–60 m', () => {
  assert.deepEqual([R2_MIN, Z_LAST_MIN, Z_LAST_MAX], [0.9, 3, 60]);
  const bad = synth();
  let seed = 3;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  bad.points.forEach((p) => (p.w *= 0.4 + 1.2 * rnd()));
  bad.points.forEach((p) => (p.h = p.w));
  assert.equal(reason(bad), 'fit');
  assert.equal(reason(synth({ Z0: 30, Zend: 2, step: 2 })), 'range', 'quá gần');
  assert.equal(reason(synth({ Z0: 110, Zend: 64, step: 2.5, W: 1.4, clsFrom: 20 })), 'range', 'quá xa');
});

test('acceptTrack bước 7: cỡ biển ước tính 0,45–1,7 m', () => {
  assert.deepEqual([W_MIN, W_MAX], [0.45, 1.7]);
  assert.equal(reason(synth({ W: 0.4 })), 'size');
  assert.equal(reason(synth({ W: 0.5 })), 'ok');
  assert.equal(reason(synth({ W: 1.6, Z0: 58, X: 5 })), 'ok');
  // Biển giả lớn: hình học khớp nhưng ước tính 1,8 m.
  assert.equal(reason(synth({ W: 1.8, Z0: 58 })), 'size');
});

test('acceptTrack bước 8: tỉ lệ cao/rộng theo dạng biển', () => {
  assert.deepEqual(ASPECT_ROUND, [0.8, 1.25]);
  assert.deepEqual(ASPECT_TRIANGLE, [0.7, 1.05]);
  assert.equal(reason(synth({ aspect: 0.75 })), 'facing', 'biển tròn bị nghiêng sang đường khác');
  assert.equal(reason(synth({ aspect: 1.3 })), 'facing');
  assert.equal(reason(synth({ aspect: 1.2 })), 'ok');
  const tri = (aspect) => reason(synth({ label: 'W.207', family: 'triangle', aspect }));
  assert.equal(tri(0.87), 'ok');
  assert.equal(tri(1.1), 'facing');
  assert.equal(tri(0.65), 'facing');
});

test('acceptTrack bước 9: lệch ngang ≤ 15 m', () => {
  assert.equal(LATERAL_MAX, 15);
  assert.equal(reason(synth({ X: 14, Zend: 30, Z0: 60 })), 'ok');
  assert.equal(reason(synth({ X: 16, Zend: 30, Z0: 60 })), 'lateral');
  assert.equal(reason(synth({ X: -16, Zend: 30, Z0: 60 })), 'lateral');
});

test('acceptTrack bước 10: định vị thật, sai số ≤ 20 m, tốc độ ≥ 3 m/s, có hành lang rõ chiều', () => {
  assert.deepEqual([FIX_ACCURACY_MAX, FIX_SPEED_MIN], [20, 3]);
  assert.equal(reason(synth({ pose: { simulated: true } })), 'fixes');
  assert.equal(reason(synth({ pose: { accuracy: 25 } })), 'fixes');
  assert.equal(reason(synth({ pose: { accuracy: 20 } })), 'ok');
  assert.equal(reason(synth({ pose: { speed: 2.9 } })), 'fixes');
  assert.equal(reason(synth({ pose: { corridor: false } })), 'fixes');
});

test('acceptTrack bước 11: độ sáng khung (camera bị che hoặc tắt)', () => {
  assert.deepEqual([LUM_STD_MIN, LUM_MEAN_MIN, LUM_MEAN_MAX], [8, 25, 235]);
  assert.equal(lumOk({ mean: 120, std: 8 }), true);
  assert.equal(lumOk({ mean: 120, std: 7.9 }), false);
  assert.equal(lumOk({ mean: 24, std: 30 }), false);
  assert.equal(lumOk({ mean: 236, std: 30 }), false);
  assert.equal(lumOk(null), false);
  assert.equal(reason(synth({ lum: { mean: 2, std: 1 } })), 'camera');
  const one = synth();
  one.points[2].lum = { mean: 250, std: 3 };
  assert.equal(reason(one), 'camera');
});

test('acceptTrack: lần thấy "rõ" cần ≥ 6 khung cùng nhãn và p trung bình ≥ 0,95; nhãn đa số', () => {
  assert.deepEqual([STRONG_FRAMES, STRONG_P], [6, 0.95]);
  assert.equal(acceptTrack(synth({ p: 0.94, p2: 0.02 }), CTX).obs.strong, false);
  assert.equal(acceptTrack(synth({ p: 0.96, p2: 0.02 }), CTX).obs.strong, true);
  const short = synth({ Z0: 35, Zend: 20 });
  assert.ok(acceptTrack(short, CTX).obs.agree < 6 || acceptTrack(short, CTX).obs.strong);
  const m = majorityLabel(synth());
  assert.equal(m.label, 'P.127[50]');
  assert.equal(m.agree, m.total);
  assert.equal(majorityLabel({ points: [] }), null);
});

test('Tracker: tối đa 32 lượt bám mở cùng lúc; lượt bám dài được ưu tiên khi tranh hộp', () => {
  assert.equal(MAX_TRACKS, 32);
  assert.ok(LONG_BONUS > 0 && LONG_BONUS < IOU_MIN);
  assert.equal(ASPECT_MIN_W, 20);
  const tr = new Tracker();
  const boxes = Array.from({ length: 40 }, (_, k) => ({ x: 20 + (k % 8) * 230, y: 20 + Math.floor(k / 8) * 200, w: 30, h: 30, family: 'ring', s: 0.8, pass: 'A', cls: null }));
  tr.update({ t: 0, lum: LUM, boxes });
  assert.equal(tr.tracks.length, MAX_TRACKS);
  // Hộp trùng ở khung cuối mở một lượt bám một khung đúng chỗ lượt bám dài; khung sau cả hai dự đoán đều trúng hộp
  // thật, lượt bám dài nhận hộp.
  const pts = synth({ Z0: 40, Zend: 22.5 }).points;
  const head = pts.slice(0, -1);
  const last = head[head.length - 1];
  const dupT = new Tracker();
  for (const pt of head.slice(0, -1)) dupT.update(frameOf(pt), pose(pt));
  dupT.update(frameOf(last, [{ ...frameOf(last).boxes[0] }]), pose(last));
  assert.deepEqual(dupT.tracks.map((x) => x.points.length).sort((a, b) => b - a), [head.length, 1]);
  dupT.update(frameOf(pts[pts.length - 1]), pose(pts[pts.length - 1]));
  assert.deepEqual(dupT.tracks.map((x) => x.points.length).sort((a, b) => b - a), [head.length + 1, 1], 'lượt bám dài nhận hộp');
});

test('acceptTrack bước 8: tỉ lệ cao/rộng chỉ đo trên hộp từ 20 px (hộp nhỏ quá nhiễu)', () => {
  const tr = synth();
  tr.points.forEach((p) => {
    if (p.w < ASPECT_MIN_W) p.h = p.w * 2;
  });
  assert.equal(reason(tr), 'ok');
});

test('lọc Kalman của lượt bám: hằng số và nhiễu đo 1/w theo nhiễu bề rộng 3 % + 0,7 px', () => {
  assert.deepEqual([Q_XY, R_XY, V0_XY], [600 ** 2, 1.5 ** 2, 400 ** 2]);
  assert.deepEqual([Q_IW, V0_IW], [1e-4, 0.05 ** 2]);
  assert.deepEqual([BOX_NOISE_REL, BOX_NOISE_PX], [0.03, 0.7]);
  // σ(1/w) ≈ σw / w²: hộp 10 px → σw = 1 px; hộp 100 px → σw = 3,7 px.
  assert.ok(Math.abs(rIw(10) - (1 / 100) ** 2) < 1e-15);
  assert.ok(Math.abs(rIw(100) - (3.7 / 1e4) ** 2) < 1e-15);
  assert.ok(rIw(20) > rIw(40), 'hộp nhỏ: 1/w nhiễu hơn');
});
