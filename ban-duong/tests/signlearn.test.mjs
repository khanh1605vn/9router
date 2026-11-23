import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { destination, distance } from '../js/geo.js';
import { cellKey, cellOf, RoadData, vertexKey } from '../js/roaddata.js';
import { buildCorridor, junctionAhead, junctionsAlong, mapItems, SignEngine } from '../js/signengine.js';
import { LearnedSigns, memoryBackend } from '../js/learnedsigns.js';
import {
  ACCURACY_TO_SIGMA,
  ARM_AHEAD,
  ARM_CHORD,
  ARM_SAME,
  CLS_MIN_PX,
  CONFLICT_RADIUS,
  CONTINUE_ANGLE,
  continuesWay,
  CORRIDOR_KEEP_MS,
  CORRIDORS_MAX,
  EXTRAPOLATE_MS,
  FIX_AGE_MAX,
  FIX_GAP_MAX,
  FORK_AHEAD,
  FIX_KEEP_MS,
  FORK_ANGLE,
  FRAME_GAP_MS,
  HEALTH_WINDOW_MS,
  HIT_DEBOUNCE_MS,
  JUNCTION_BEHIND,
  JUNCTION_SETBACK,
  Learner,
  LOST_MS,
  MIN_WINDOW_FRAMES,
  NEAR_MISS_REASONS,
  nearMiss,
  NOMINAL_W,
  NOMINAL_W_OCTAGON,
  OSM_DUP_RADIUS,
  PASS_BEHIND,
  PASS_GRACE_MS,
  PASS_MAX_MS,
  PARALLEL_NEAR,
  PASS_NEAR,
  POS_ERR_MIN,
  POS_SMOOTH,
  REC_LATERAL,
  APPLY_ANGLE,
  SIDE_MIN,
  STOP_MS,
  STOP_SPEED,
  SUN_DAY,
  sunElevation,
  WAY_SLACK,
  WIN_NEAR,
} from '../js/signlearn.js';
import { acceptTrack, focalPx } from '../js/signtrack.js';

// Cờ learn lấy từ danh sách học cố định (như models/labels.json chưa huấn luyện), không đọc tệp đã cài: một lần
// huấn luyện đầy đủ có thể gỡ nhãn khỏi danh sách học (BD_PRUNE) mà phép thử logic học không được phụ thuộc vào đó.
const labels = buildLabels(SIGN_CATALOGUE);

// ---------------------------------------------------------------------------------------------
// Thế giới mô phỏng: một đường chính thẳng về hướng Đông dài 1,4 km, nút giao với đường ngang ở 900 m. Dựng bằng
// hình học (không phải đường thật), nằm giữa một ô dữ liệu 0,03°.
// ---------------------------------------------------------------------------------------------

const O = [105.81, 21.015];
const JX = 900; // nút giao
const along = (x) => destination(O, 90, x);
const off = (p, y) => (y ? destination(p, y > 0 ? 0 : 180, Math.abs(y)) : p); // y > 0: lệch về phía Bắc

function makeWorld({ fork = false, feats = [] } = {}) {
  const main = [];
  for (let x = 0; x <= 1400; x += 50) main.push(along(x));
  const J = main[JX / 50];
  const ways = [
    { id: 1, n: 'Đường chính', h: 'primary', c: null, m: null, o: 0, g: main.flat() },
    { id: 2, n: 'Đường ngang', h: 'residential', c: null, m: null, o: 0, g: [off(J, -150), off(J, -50), J, off(J, 50), off(J, 150)].flat() },
  ];
  if (fork) {
    // Nhánh rẽ phải chếch 30° (đường nhánh ra khỏi đường chính) ở 1000 m.
    const F0 = main[1000 / 50];
    ways.push({ id: 3, n: 'Nhánh', h: 'primary_link', c: null, m: null, o: 1, g: [F0, destination(F0, 120, 100), destination(F0, 120, 200)].flat() });
  }
  const roads = new RoadData({ fetchImpl: () => Promise.reject(new Error('không có mạng')), cache: { get: async () => null, put: () => {} } });
  roads.setCell(cellKey(...cellOf(O)), { ways, feats, v: 3, t: Date.now() });
  return { roads, ways, J, jKey: vertexKey(J) };
}

const WORLD = makeWorld();

// Camera lỗ kim: HFOV 70°, 1920 px, cao 1,3 m; biển cao 2,5 m (tâm), lệch 5 m.
const W = 1920;
const H = 1080;
const F = focalPx(W, 70);
const FOE = { x: W / 2, y: 0.42 * H };
const P127 = { label: 'P.127[50]', family: 'ring', x: 500, lat: 5, size: 0.7 };
const STOP = { label: 'R.122', family: 'octagon', x: JX - 10, lat: 5, size: 0.6 };
const SIGNS = [P127, STOP];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussOf = (r) => () => {
  let u = 0;
  let v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Hộp máy dò trả về cho xe ở xCar (m dọc đường, đi về hướng Đông): nhiễu bề rộng 3 % + 0,7 px, tâm 1 px. */
function boxesAt(xCar, eastbound, signs, g, r, p) {
  const out = [];
  if (!eastbound) return out; // các biển quay mặt về hướng Tây: xe đi về hướng Tây chỉ thấy mặt sau
  for (const sg of signs) {
    const Z = sg.x - xCar;
    if (Z <= 0.5) continue;
    const wTrue = (F * sg.size) / Z;
    const cx = FOE.x + (F * sg.lat) / Z + g();
    const cy = FOE.y - (F * 1.2) / Z + g();
    const w = wTrue * (1 + 0.03 * g()) + 0.7 * g();
    const h = w * (1 + 0.02 * g());
    const inA = Math.abs(cx - FOE.x) <= 320 && Math.abs(cy - FOE.y) <= 176; // lượt A: 640×352 quanh điểm tụ
    if (!((inA && wTrue >= 10) || wTrue >= 27)) continue; // lượt B: cả khung thu nhỏ 3 lần
    if (r() < 0.05) continue; // máy dò bỏ sót
    let x0 = cx - w / 2;
    let y0 = cy - h / 2;
    let x1 = cx + w / 2;
    let y1 = cy + h / 2;
    if (x0 >= W || y1 <= 0) continue;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(W, x1);
    y1 = Math.min(H, y1);
    const bw = x1 - x0;
    const cls = bw >= 20 && bw <= 400 ? [[sg.label, p], ['other-sign', (1 - p) * 0.6], ['background', (1 - p) * 0.4]] : null;
    out.push({ x: x0, y: y0, w: bw, h: y1 - y0, family: sg.family, s: 0.8, pass: inA ? 'A' : 'B', cls });
  }
  return out;
}

const NOON_HANOI = Date.UTC(2026, 10, 23, 5, 0); // 12:00 giờ Việt Nam

/**
 * Một lượt chạy: GPS 1 Hz (nhiễu σ 4 m, nhận sau 200 ms), camera 5 khung/giây (lệch nhịp ±40 ms), qua SignEngine thật.
 * stop: { x, s } dừng s giây ở x. slow: { x0, x1, v } đi chậm v (m/s) từ x0 tới x1. accuracy(x), mapCorridor(corr, x):
 * thay đổi đầu vào để thử từng điều kiện. cameraOn(x, speed): khung ở vị trí x có được xử lý không (camera tạm dừng).
 * evalCrops: kết quả mang crops (như Vision.process(…, { evalCrops: true })), mỗi khung đã phân loại một "ảnh" giả
 * { label, w, n } ghi vào sent; onEvalCrop: hàm cho Learner.
 */
function drive({
  seed, kmh = 50, day = 0, store, world = WORLD, signs = SIGNS, east = true, camera = true, start = 100, end = 1100, sigma = 4,
  wallStart = NOON_HANOI, p = 0.92, lum = { mean: 120, std: 40 }, stop = null, slow = null, accuracy = () => 5, mapCorridor = null,
  simulated = false, cameraOn = null, evalCrops = false, onEvalCrop = null, sent = [],
}) {
  const r = rng(seed);
  const g = gaussOf(r);
  const v = kmh / 3.6;
  const wall0 = wallStart + day * 864e5;
  const MONO0 = 5e6 + seed * 1000;
  let simT = 0;
  const learner = new Learner({ store, roads: world.roads, labels, now: () => wall0 + simT * 1000, mono: () => MONO0 + simT * 1000, onEvalCrop });
  const engine = new SignEngine();
  const passed = [];
  learner.onPassed((e) => passed.push(e));
  // Vị trí dọc đường (tính theo chiều đi) và tốc độ thật theo thời gian.
  const t1 = stop ? (stop.x - start) / v : Infinity;
  const s0 = slow ? (slow.x0 - start) / v : Infinity;
  const s1 = slow ? s0 + (slow.x1 - slow.x0) / slow.v : Infinity;
  const pos = (t) => {
    if (slow) {
      if (t < s0) return { d: start + v * t, speed: v };
      if (t < s1) return { d: slow.x0 + slow.v * (t - s0), speed: slow.v };
      return { d: slow.x1 + v * (t - s1), speed: v };
    }
    if (t < t1) return { d: start + v * t, speed: v };
    if (t < t1 + stop.s) return { d: stop.x, speed: 0 };
    return { d: stop.x + v * (t - t1 - stop.s), speed: v };
  };
  const T = (end - start) / v + (stop ? stop.s : 0) + (slow ? (slow.x1 - slow.x0) / slow.v - (slow.x1 - slow.x0) / v : 0);
  const xOf = (d) => (east ? d : end + start - d);
  const events = [];
  for (let k = 0; k <= T; k++) events.push({ at: k + 0.2, fix: k });
  if (camera) {
    for (let k = 0; k * 0.2 <= T; k++) {
      const tg = k * 0.2 + (r() - 0.5) * 0.08;
      events.push({ at: tg + 0.05, frame: tg });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const results = [];
  for (const ev of events) {
    simT = ev.at;
    if (ev.fix != null) {
      const { d, speed } = pos(ev.fix);
      const x = xOf(d);
      const fix = {
        coord: off(along(x + sigma * g()), sigma * g()),
        speed: Math.max(0, speed + 0.2 * g()),
        heading: ((east ? 90 : 270) + 2 * g() + 360) % 360,
        accuracy: accuracy(x),
        time: wall0 + ev.fix * 1000,
        simulated,
      };
      engine.update(fix, world.roads, {}, { vehicle: 'car', now: new Date(wall0 + simT * 1000) });
      const corr = engine.lastCorridor && mapCorridor ? mapCorridor(engine.lastCorridor, x) : engine.lastCorridor;
      learner.onFix(fix, { corridor: corr, corridorTime: engine.lastCorridorTime });
    } else {
      const { d, speed } = pos(ev.frame);
      const x = xOf(d);
      if (cameraOn && !cameraOn(x, speed)) continue;
      const boxes = boxesAt(x, east, signs, g, r, p);
      const result = { t: MONO0 + ev.frame * 1000, ms: { total: 30 }, lum, boxes };
      if (evalCrops) {
        result.crops = [];
        boxes.forEach((b, i) => {
          if (!b.cls) return;
          const blob = { label: b.cls[0][0], w: b.w, n: sent.length };
          sent.push(blob);
          result.crops.push({ i, blob, w: 40, h: 40 });
        });
      }
      const res = learner.onVision(result);
      results.push(...res.results);
    }
  }
  return { learner, passed, results };
}

function newStore(clock = { t: NOON_HANOI }) {
  let s = 99;
  const random = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  return new LearnedSigns({ backend: memoryBackend(), now: () => clock.t, labels, random });
}

const byCode = (store, code) => store.list().find((r) => r.code === code) || null;
/** Vị trí dọc đường (m) của toạ độ trên đường chính. */
const xOfCoord = (c) => distance(O, [c[0], O[1]]) * Math.sign(c[0] - O[0]);

// ---------------------------------------------------------------------------------------------
// Đồng hồ và vị trí xe
// ---------------------------------------------------------------------------------------------

function bareLearner() {
  const clock = { wall: 1_800_000_000_000, mono: 50_000 };
  const learner = new Learner({ store: newStore(), roads: WORLD.roads, labels, now: () => clock.wall, mono: () => clock.mono });
  const step = (ms) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  return { learner, clock, step };
}

test('đồng hồ: lần định vị đổi sang đồng hồ đơn điệu theo tuổi của nó; tuổi vô lý thì lấy lúc nhận', () => {
  assert.equal(FIX_AGE_MAX, 3000);
  const { learner, clock } = bareLearner();
  assert.equal(learner.monoOf({ time: clock.wall - 300 }), clock.mono - 300);
  assert.equal(learner.monoOf({ time: clock.wall - 3000 }), clock.mono - 3000);
  assert.equal(learner.monoOf({ time: clock.wall + 500 }), clock.mono, 'lần định vị ở tương lai: đồng hồ máy lệch');
  assert.equal(learner.monoOf({ time: clock.wall - 60_000 }), clock.mono, 'quá cũ: đồng hồ máy lệch giờ GPS');
  assert.equal(learner.monoOf({}), clock.mono);
});

test('quãng đường: tích phân tốc độ giữa các lần định vị, nội suy theo khung, ngoại suy tối đa 1,5 giây', () => {
  assert.equal(EXTRAPOLATE_MS, 1500);
  assert.equal(FIX_GAP_MAX, 3000);
  const { learner, clock, step } = bareLearner();
  const fix = (speed) => ({ coord: along(100), speed, heading: 90, accuracy: 5, time: clock.wall });
  const m0 = clock.mono;
  learner.onFix(fix(10));
  assert.equal(learner.poseAt(m0 - 1), null, 'trước lần định vị đầu');
  step(1000);
  learner.onFix(fix(12));
  const mid = learner.poseAt(m0 + 500);
  assert.ok(Math.abs(mid.D - (10 * 0.5 + 0.5 * 2 * 0.25)) < 1e-9, `D = ${mid.D}`);
  assert.ok(Math.abs(mid.speed - 11) < 1e-9);
  assert.ok(Math.abs(learner.poseAt(m0 + 1000).D - 11) < 1e-9);
  assert.ok(Math.abs(learner.poseAt(m0 + 1000 + 1400).D - (11 + 12 * 1.4)) < 1e-9);
  assert.equal(learner.poseAt(m0 + 1000 + 1501), null, 'quá 1,5 giây sau lần định vị cuối');
  // Tốc độ do xe báo (km/h) được dùng thay tốc độ GPS.
  step(1000);
  learner.onFix(fix(12), { carSpeed: 36 });
  assert.ok(Math.abs(learner.poseAt(clock.mono).D - (11 + 0.5 * (12 + 10))) < 1e-9);
  // Mất GPS lâu: không nội suy qua khoảng trống.
  step(5000);
  learner.onFix(fix(10));
  assert.equal(learner.poseAt(clock.mono - 2000), null);
  assert.ok(learner.poseAt(clock.mono));
  // Lần định vị cũ hơn lần trước thì bỏ.
  const n = learner.fixes.length;
  learner.onFix({ ...fix(10), time: clock.wall - 2000 });
  assert.equal(learner.fixes.length, n);
});

test('lần định vị mô phỏng ("Chạy thử") bị bỏ qua', () => {
  const { learner, clock, step } = bareLearner();
  learner.onFix({ coord: along(100), speed: 10, heading: 90, accuracy: 5, time: clock.wall });
  step(500);
  learner.onFix({ coord: along(105), speed: 10, heading: 90, accuracy: 5, time: clock.wall, simulated: true });
  assert.equal(learner.fixes.length, 1);
  assert.equal(learner.poseAt(clock.mono), null, 'đang mô phỏng: khung không có vị trí xe');
  assert.equal(learner.health().simulated, true);
  const store = newStore();
  const r = drive({ seed: 3, store, simulated: true });
  assert.equal(store.size, 0);
  assert.equal(r.passed.length, 0);
  assert.equal(r.results.filter((x) => x.ok).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Đặt biển lên hành lang
// ---------------------------------------------------------------------------------------------

/** Learner đã nhận các lần định vị tại các vị trí xs (m), mỗi giây một lần, hành lang dựng bằng bộ máy thật. */
function placedLearner(xs, world = WORLD) {
  const { learner, clock, step } = bareLearner();
  learner.roads = world.roads;
  const monos = [];
  xs.forEach((x, k) => {
    if (k) step(1000);
    const fix = { coord: along(x), speed: 10, heading: 90, accuracy: 6, time: clock.wall };
    learner.onFix(fix, { corridor: buildCorridor(fix, world.roads), corridorTime: fix.time });
    monos.push(clock.mono);
  });
  return { learner, monos };
}

const obsAt = (o) => ({ code: 'P.127', value: '50', junction: false, lateral: 5, ...o });

test('đặt biển: dùng hành lang của lần định vị gần nhất không sau khung cuối; giữ hành lang 15 giây', () => {
  assert.deepEqual([CORRIDOR_KEEP_MS, CORRIDORS_MAX], [15000, 60]);
  // Lần định vị thứ hai lệch 2 m về phía trước so với quãng đường đã tích phân (sai số GPS).
  const xs = [88, 100, 112, 120, 130];
  for (let k = 0; k < 14; k++) xs.unshift(xs[0] - 10);
  const all = placedLearner(xs);
  assert.equal(all.learner.corridors.length, 16, 'lần định vị cách nhau 1 giây: giữ 16 hành lang (0…15 giây trước)');
  assert.equal(all.learner.corridors[0].mono, all.monos[all.monos.length - 1] - CORRIDOR_KEEP_MS);
  const { learner, monos } = { learner: all.learner, monos: all.monos.slice(-4) };
  const D = learner.fixes.slice(-4).map((f) => f.D); // …, +10, +20, +30
  // Khung cuối 0,5 s sau lần định vị thứ hai: hành lang bắt đầu ở 112 m.
  const p = learner.place(obsAt({ t: monos[1] + 500, D: D[1] + 5, Z: 30 }));
  assert.ok(Math.abs(xOfCoord(p.coord) - (112 + 5 + 30)) < 0.2, `x = ${xOfCoord(p.coord)}`);
  assert.equal(p.facing, 270);
  assert.equal(p.wayId, 1);
  assert.equal(p.corridorMono, monos[1]);
  assert.ok(Math.abs(p.posErr - 4) < 1e-9, 'sai số 6 m của máy → σ 4 m');
  assert.equal(learner.place(obsAt({ t: all.monos[2] + 100, D: 1, Z: 30 })).error, 'no-corridor', 'hành lang quá 15 giây đã bị bỏ');
  assert.equal(learner.place(obsAt({ t: monos[3] + 100, D: D[3] + 1, Z: 400 })).error, 'off-corridor');
  // Không quá 60 hành lang dù định vị dày.
  const dense = bareLearner();
  for (let k = 0; k < 100; k++) {
    dense.step(100);
    const fix = { coord: along(100 + k), speed: 10, heading: 90, accuracy: 5, time: dense.clock.wall };
    dense.learner.onFix(fix, { corridor: buildCorridor(fix, WORLD.roads), corridorTime: fix.time });
  }
  assert.equal(dense.learner.corridors.length, CORRIDORS_MAX);
});

test('neo biển của nút giao: nút giao trong 40 m phía trước → đặt ở max(nút giao − 10 m, ước tính)', () => {
  assert.equal(JUNCTION_SETBACK, 10);
  assert.equal(JUNCTION_BEHIND, 5);
  const { learner, monos } = placedLearner([800]);
  const D = learner.fixes[0].D;
  const at = (Z, extra = {}) => learner.place(obsAt({ code: 'R.122', value: null, junction: true, t: monos[0] + 1, D, Z, ...extra }));
  const near = at(95);
  assert.equal(near.junction, WORLD.jKey);
  assert.ok(Math.abs(xOfCoord(near.coord) - 895) < 0.2, 'ước tính đã nằm trong 10 m trước nút giao: giữ nguyên');
  const before = at(75);
  assert.equal(before.junction, WORLD.jKey);
  assert.ok(Math.abs(xOfCoord(before.coord) - 890) < 0.2, `x = ${xOfCoord(before.coord)}`);
  const past = at(103);
  assert.equal(past.junction, WORLD.jKey, 'sai số GPS đẩy ước tính qua nút giao 3 m: vẫn neo');
  assert.ok(Math.abs(xOfCoord(past.coord) - 890) < 0.2);
  assert.equal(at(106).junction, null, 'qua nút giao 6 m: không neo');
  const far = at(50);
  assert.equal(far.junction, null, 'nút giao cách 50 m: không neo');
  assert.ok(Math.abs(xOfCoord(far.coord) - 850) < 0.2);
  const speed = learner.place(obsAt({ t: monos[0] + 1, D, Z: 75 }));
  assert.equal(speed.junction, null, 'biển tốc độ không neo vào nút giao');
  assert.ok(Math.abs(xOfCoord(speed.coord) - 875) < 0.2);
  // Hàm của bộ máy.
  const corr = learner.corridors[0].corridor;
  assert.equal(junctionAhead(corr, WORLD.roads, 70).key, WORLD.jKey, 'mặc định trong 40 m (JUNCTION_NEAR)');
  assert.ok(Math.abs(junctionAhead(corr, WORLD.roads, 50, 60).s - 100) < 0.5);
  assert.deepEqual(junctionAhead(corr, WORLD.roads, 70).coord, WORLD.J.map((v) => +v.toFixed(7)));
  assert.equal(junctionAhead(corr, WORLD.roads, 50), null);
  assert.equal(junctionAhead(corr, WORLD.roads, 101), null);
  assert.equal(junctionsAlong(corr, WORLD.roads).length, 1);
});

test('đường rẽ nhánh trong 60 m sau biển, về phía biển → branch "unsure"', () => {
  assert.deepEqual([FORK_AHEAD, FORK_ANGLE], [60, 45]);
  const world = makeWorld({ fork: true });
  const { learner, monos } = placedLearner([850], world);
  const D = learner.fixes[0].D;
  const at = (Z, lateral) => learner.place(obsAt({ t: monos[0] + 1, D, Z, lateral })).branch;
  assert.equal(at(110, 5), 'unsure', 'nhánh rẽ phải 40 m sau biển bên phải');
  assert.equal(at(110, -5), null, 'biển bên trái, nhánh bên phải');
  assert.equal(at(110, 0.5), 'unsure', 'biển treo trên đường');
  assert.equal(at(75, 5), null, 'nhánh cách 75 m');
  assert.equal(at(30, 5), null, 'chỉ có đường ngang vuông góc ở 900 m');
});

test('bản đồ đã có biển cùng loại trong 30 m theo cùng chiều → osm (bước 13)', () => {
  assert.equal(OSM_DUP_RADIUS, 30);
  const feats = [
    { id: 'n1', coord: off(along(500), -6), onWay: false, tags: { traffic_sign: 'VN:P.127[50]', 'traffic_sign:direction': '270' } },
    { id: 'n2', coord: off(along(700), -6), onWay: false, tags: { traffic_sign: 'VN:P.102', 'traffic_sign:direction': '90' } },
    { id: 'n3', coord: off(along(300), -6), onWay: false, tags: { traffic_sign: 'VN:P.115[10]' } },
  ];
  const world = makeWorld({ feats });
  const { learner, monos } = placedLearner([250], world);
  const D = learner.fixes[0].D;
  const at = (o) => learner.place(obsAt({ t: monos[0] + 1, D, ...o })).osm;
  assert.equal(at({ Z: 240 }), true);
  assert.equal(at({ Z: 280 }), true, 'cách đúng 30 m');
  assert.equal(at({ Z: 285 }), false, '35 m sau biển trên bản đồ');
  assert.equal(at({ Z: 250, value: '60' }), false, 'trị số khác');
  assert.equal(at({ Z: 50, code: 'P.115', value: null }), true, 'trị số tải trọng không được đọc: so theo mã');
  const ahead = placedLearner([600], world);
  const p102 = ahead.learner.place(obsAt({ t: ahead.monos[0] + 1, D: ahead.learner.fixes[0].D, Z: 100, code: 'P.102', value: null }));
  assert.equal(p102.osm, false, 'biển trên bản đồ cho chiều ngược lại');
  const items = mapItems(learner.corridors[0].corridor, world.roads);
  assert.ok(items.some((it) => it.dup === 'P.127|50'));
  assert.ok(!items.some((it) => it.code === 'P.102'));
});

// ---------------------------------------------------------------------------------------------
// Mô phỏng đầy đủ
// ---------------------------------------------------------------------------------------------

test('mô phỏng: đặt biển sai ≤ 5 m dọc đường (trung vị), biển dừng neo vào nút giao, hai ngày thì xác nhận', () => {
  const speeds = [30, 40, 50, 60, 70, 45, 55];
  const errs = [];
  for (let i = 0; i < speeds.length; i++) {
    const clock = { t: NOON_HANOI };
    const store = newStore(clock);
    const r1 = drive({ seed: 10 + i, kmh: speeds[i], store });
    const p = byCode(store, 'P.127');
    const s = byCode(store, 'R.122');
    assert.ok(p && s, `${speeds[i]} km/h: ghi nhận cả hai biển (${JSON.stringify(r1.results)})`);
    assert.equal(p.status, 'candidate');
    assert.equal(p.facing, 270);
    assert.equal(p.value, '50');
    errs.push(Math.abs(xOfCoord(p.coord) - P127.x));
    const rec = store.get(s.id);
    assert.equal(rec.junction, WORLD.jKey, 'biển dừng neo vào nút giao');
    const before = JX - xOfCoord(s.coord);
    assert.ok(before > 0 && before <= JUNCTION_SETBACK + 1, `biển dừng ở trước nút giao ${before} m`);
    assert.equal(r1.passed.length, 0, 'lần đầu: chưa có biển nào để xét');
    // Lần thứ hai cùng ngày: chưa xác nhận.
    drive({ seed: 50 + i, kmh: speeds[speeds.length - 1 - i], store });
    assert.equal(byCode(store, 'P.127').status, 'candidate');
    assert.equal(byCode(store, 'P.127').hitDays, 1);
    // Ngày hôm sau: xác nhận cả hai.
    clock.t += 864e5;
    const r2 = drive({ seed: 100 + i, kmh: speeds[i], day: 1, store });
    assert.equal(byCode(store, 'P.127').status, 'confirmed');
    assert.equal(byCode(store, 'R.122').status, 'confirmed');
    assert.equal(byCode(store, 'P.127').hitDays, 2);
    assert.deepEqual(r2.passed.map((e) => e.outcome).sort(), ['hit', 'hit']);
    assert.equal(store.size, 2, 'không sinh bản ghi trùng');
  }
  errs.sort((a, b) => a - b);
  const median = errs[errs.length >> 1];
  assert.ok(median <= 5, `trung vị sai số ${median.toFixed(2)} m (${errs.map((e) => e.toFixed(1)).join(', ')})`);
});

test('mô phỏng: chiều ngược lại không phải bằng chứng; biển bị dỡ: chưa xác nhận loại sau 2 lần, đã xác nhận sau 7 lần', () => {
  const clock = { t: NOON_HANOI };
  const store = newStore(clock);
  drive({ seed: 1, store });
  const p = byCode(store, 'P.127');
  const L0 = store.get(p.id).L;
  const west = drive({ seed: 2, store, east: false });
  assert.equal(west.passed.length, 0, 'không xét biển của chiều kia');
  assert.equal(store.get(p.id).L, L0);
  // Biển tốc độ bị dỡ (biển dừng vẫn còn): hai lần đi qua đủ điều kiện mà không thấy.
  const onlyStop = [STOP];
  for (let d = 1; d <= 2; d++) {
    clock.t += 864e5;
    const r = drive({ seed: 10 + d, day: d, store, signs: onlyStop });
    const e = r.passed.find((x) => x.record.code === 'P.127');
    assert.equal(e.outcome, 'miss');
    assert.equal(e.record.status, d === 1 ? 'candidate' : 'retired');
  }
  assert.equal(store.get(p.id).status, 'retired');
  // Biển dừng đã xác nhận, lên mức trần.
  const s = byCode(store, 'R.122');
  for (let d = 3; d <= 5; d++) {
    clock.t += 864e5;
    drive({ seed: 20 + d, day: d, store, signs: onlyStop });
  }
  assert.equal(store.get(s.id).status, 'confirmed');
  assert.equal(store.get(s.id).L, 3.5);
  for (let k = 1; k <= 7; k++) {
    clock.t += 864e5;
    const r = drive({ seed: 40 + k, day: 5 + k, store, signs: [] });
    assert.deepEqual(r.passed.map((x) => x.outcome), ['miss'], `lần ${k}`);
    assert.equal(store.get(s.id).status, k < 7 ? 'confirmed' : 'retired', `lần ${k}`);
  }
});

test('mô phỏng: từng trường hợp không đủ bằng chứng (không đổi điểm)', () => {
  assert.deepEqual([ARM_AHEAD, WIN_NEAR, MIN_WINDOW_FRAMES, STOP_SPEED, STOP_MS, SUN_DAY], [40, 12, 3, 2, 5000, 5]);
  const clock = { t: NOON_HANOI };
  const store = newStore(clock);
  drive({ seed: 1, store, signs: [P127] });
  const id = byCode(store, 'P.127').id;
  const L0 = store.get(id).L;
  const reason = (opts) => {
    const r = drive({ store, signs: [], ...opts });
    assert.equal(store.get(id).L, L0, JSON.stringify(opts));
    return r.passed.filter((e) => e.record.id === id).map((e) => `${e.outcome}:${e.reason}`).join(',');
  };
  assert.equal(reason({ seed: 2, camera: false }), 'none:camera');
  assert.equal(reason({ seed: 3, lum: { mean: 4, std: 1 } }), 'none:lum', 'khung trơn (camera bị che)');
  assert.equal(reason({ seed: 4, wallStart: Date.UTC(2026, 10, 23, 14) }), 'none:night', '21:00 giờ Việt Nam');
  assert.equal(reason({ seed: 5, stop: { x: 470, s: 8 } }), 'none:stop', 'kẹt xe ngay trước biển');
  assert.equal(reason({ seed: 6, accuracy: (x) => (x > 440 && x < 500 ? 30 : 5) }), 'none:accuracy');
  const parallel = (corr, x) =>
    x > 455 && x < 495 ? { ...corr, pieces: corr.pieces.map((pc) => ({ ...pc, way: { ...pc.way, id: 99 } })) } : corr;
  assert.equal(reason({ seed: 7, mapCorridor: parallel }), 'none:way', 'khớp sang đường song song');
  assert.equal(reason({ seed: 8, signs: [{ ...P127, label: 'P.103a' }] }), 'none:conflict', 'biển khác cùng họ ở đúng chỗ');
  assert.equal(reason({ seed: 9, signs: [P127], p: 0.8 }), 'none:seen', 'thấy biển nhưng chưa đủ tin');
  assert.equal(reason({ seed: 10, start: 470 }), 'none:late', 'xe vào đường khi đã quá gần biển: chỉ báo đã đi qua, không trừ điểm');
  // Đổi biển 50 → 60: biển 60 mới, biển 50 bị trừ như không thấy.
  const r = drive({ seed: 11, store, signs: [{ ...P127, label: 'P.127[60]' }] });
  assert.deepEqual(r.passed.filter((e) => e.record.code === 'P.127').map((e) => `${e.record.value}:${e.outcome}:${e.reason}`), ['50:miss:value']);
  assert.ok(store.get(id).L < L0);
  assert.equal(byCode(store, 'P.127') && store.list().filter((x) => x.code === 'P.127').length, 2);
});

test('biển đã học qua SignEngine thật: chiều đúng được báo ở 100–200 m, chiều ngược lại im lặng', () => {
  const clock = { t: NOON_HANOI };
  const store = newStore(clock);
  drive({ seed: 1, store, signs: [P127] });
  clock.t += 864e5;
  drive({ seed: 2, day: 1, store, signs: [P127] });
  assert.equal(byCode(store, 'P.127').status, 'confirmed');
  const feats = store.featsNear(along(500), 100);
  assert.equal(feats.length, 1);
  const world = makeWorld({ feats });
  const run = (east) => {
    const engine = new SignEngine();
    const out = [];
    const v = 14;
    for (let k = 0; k < 40; k++) {
      const x = east ? 150 + k * v : 850 - k * v;
      const fix = { coord: along(x), speed: v, heading: east ? 90 : 270, accuracy: 5, time: 1e6 + k * 1000 };
      const r = engine.update(fix, world.roads, {}, { vehicle: 'car', now: new Date(NOON_HANOI) });
      for (const it of r.fired) if (it.code === 'P.127') out.push({ ahead: Math.abs(500 - x), say: r.say });
    }
    return out;
  };
  const eastbound = run(true);
  assert.equal(eastbound.length, 1);
  assert.ok(eastbound[0].ahead >= 100 && eastbound[0].ahead <= 200, `báo khi còn ${eastbound[0].ahead} m`);
  assert.match(eastbound[0].say, /biển tốc độ tối đa 50 ki lô mét trên giờ/);
  assert.deepEqual(run(false), []);
});

test('SignEngine.lastCorridor: chỉ đọc, null trước lần đầu và sau reset, cùng thời điểm với lần định vị', () => {
  const engine = new SignEngine();
  assert.equal(engine.lastCorridor, null);
  assert.equal(engine.lastCorridorTime, null);
  const fix = { coord: along(200), speed: 12, heading: 90, accuracy: 5, time: 1_000_000 };
  const a = engine.update(fix, WORLD.roads, {}, { now: new Date(NOON_HANOI) });
  assert.ok(engine.lastCorridor.coords.length >= 2);
  assert.equal(engine.lastCorridorTime, fix.time);
  assert.equal(engine.lastCorridor.pieces[0].way.id, 1);
  assert.throws(() => {
    'use strict';
    engine.lastCorridor = null;
  }, TypeError);
  // Không dựng được hành lang (ngoài đường): null.
  engine.update({ ...fix, coord: off(along(200), 500), time: 1_001_000 }, WORLD.roads, {}, { now: new Date(NOON_HANOI) });
  assert.equal(engine.lastCorridor, null);
  assert.equal(engine.lastCorridorTime, 1_001_000);
  engine.reset();
  assert.equal(engine.lastCorridor, null);
  // Kết quả của bộ máy không đổi.
  const b = new SignEngine().update(fix, WORLD.roads, {}, { now: new Date(NOON_HANOI) });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------------------------
// Mặt trời và tình trạng camera
// ---------------------------------------------------------------------------------------------

test('sunElevation: khớp các giá trị đã biết', () => {
  const at = (coord, iso) => sunElevation(coord, new Date(iso));
  // Luân Đôn, hạ chí 2026: mặt trời mọc 04:43 BST và lặn 21:21 BST (độ cao −0,833° tính cả khúc xạ và bán kính).
  assert.ok(Math.abs(at([-0.1276, 51.5072], '2026-06-21T03:43:00Z') + 0.833) < 0.3);
  assert.ok(Math.abs(at([-0.1276, 51.5072], '2026-06-21T20:21:00Z') + 0.833) < 0.3);
  // Bắc Cực ngày đông chí: dưới chân trời đúng bằng độ nghiêng trục Trái Đất.
  assert.ok(Math.abs(at([0, 90], '2026-12-21T12:00:00Z') + 23.44) < 0.05);
  // Xích đạo, giữa trưa ngày xuân phân: gần đỉnh đầu.
  assert.ok(at([0, 0], '2026-03-20T12:07:00Z') > 89.5);
  // Hà Nội 23/11: trưa khoảng 48°, mọc khoảng 06:12, nửa đêm dưới chân trời rất sâu.
  const hn = [105.85, 21.03];
  const noon = at(hn, '2026-11-23T05:00:00Z');
  assert.ok(noon > 47.5 && noon < 49, `${noon}`);
  assert.ok(Math.abs(at(hn, '2026-11-22T23:12:00Z') + 0.833) < 0.3);
  assert.ok(at(hn, '2026-11-23T17:00:00Z') < -40);
  assert.ok(Number.isNaN(sunElevation(null, new Date())));
});

test('health(): không có khung, khung tốt, khung trơn hoặc tối', () => {
  const { learner, clock, step } = bareLearner();
  assert.deepEqual(
    [learner.health().running, learner.health().reason, learner.health().frames],
    [false, 'no-frames', 0],
  );
  for (let k = 0; k < 10; k++) {
    learner.onVision({ t: clock.mono, ms: {}, lum: { mean: 120, std: 40 }, boxes: [] });
    step(200);
  }
  let h = learner.health();
  assert.equal(h.running, true);
  assert.equal(h.reason, null);
  assert.equal(h.frames, 10);
  assert.equal(h.okShare, 1);
  learner.onVision({ t: clock.mono, ms: {}, lum: { mean: 1, std: 0.5 }, boxes: [] });
  h = learner.health();
  assert.equal(h.reason, 'blank');
  assert.equal(h.lumOk, false);
  learner.onVision({ t: clock.mono + 1, ms: {}, lum: { mean: 12, std: 9 }, boxes: [] });
  assert.equal(learner.health().reason, 'dark');
  learner.onVision({ t: clock.mono + 2, ms: {}, lum: { mean: 250, std: 9 }, boxes: [] });
  assert.equal(learner.health().reason, 'bright');
  step(20_000);
  assert.equal(learner.health().running, false);
  assert.deepEqual(learner.onVision(null), { ended: 0, results: [] });
});

test('setCamera và cỡ khung: tiêu cự theo HFOV, điểm tụ giữ vị trí tương đối khi cỡ khung đổi', () => {
  const { learner, clock } = bareLearner();
  assert.ok(Math.abs(learner.focal - focalPx(1920, 70)) < 1e-9);
  learner.setCamera({ width: 1920, height: 1080, hfov: 60, foe: { x: 1000, y: 400 } });
  assert.ok(Math.abs(learner.focal - 960 / Math.tan(Math.PI / 6)) < 1e-9);
  learner.onVision({ t: clock.mono, ms: {}, lum: { mean: 120, std: 40 }, boxes: [] }, { width: 1280, height: 720 });
  assert.ok(Math.abs(learner.camera.foe.x - (1000 * 1280) / 1920) < 1e-9);
  assert.ok(Math.abs(learner.camera.foe.y - (400 * 720) / 1080) < 1e-9);
  assert.equal(learner.tracker.width, 1280);
  learner.setCamera({ width: -1, hfov: 500 });
  assert.equal(learner.camera.width, 1920);
  assert.equal(learner.camera.hfov, 70);
});

test('setCamera: góc nhìn tính theo cạnh dài; cầm dọc hay xoay máy không đổi tiêu cự, cỡ biển và cửa sổ xét', () => {
  const { learner, clock } = bareLearner();
  const f = focalPx(1920, 70);
  learner.setCamera({ width: 1080, height: 1920, hfov: 70 });
  assert.ok(Math.abs(learner.focal - f) < 1e-9, 'khung dọc 1080×1920: tiêu cự như khung ngang');
  learner.setCamera({ width: 1920, height: 1080, hfov: 70 });
  learner.onVision({ t: clock.mono, ms: {}, lum: { mean: 120, std: 40 }, boxes: [] }, { width: 1080, height: 1920 });
  assert.equal(learner.camera.width, 1080);
  assert.ok(Math.abs(learner.focal - f) < 1e-9, 'xoay máy giữa chừng: tiêu cự giữ nguyên');
  // Cùng hướng, đổi độ phân giải: tiêu cự theo pixel đổi theo.
  learner.onVision({ t: clock.mono + 1, ms: {}, lum: { mean: 120, std: 40 }, boxes: [] }, { width: 720, height: 1280 });
  assert.ok(Math.abs(learner.focal - (f * 1280) / 1920) < 1e-9);
});

test('hằng số của bộ học: cửa sổ xét khoảng 48 m cho biển 0,70 m ở 1080p, HFOV 70°', () => {
  assert.deepEqual([CLS_MIN_PX, NOMINAL_W, NOMINAL_W_OCTAGON], [20, 0.7, 0.6]);
  const winFar = (F * NOMINAL_W) / CLS_MIN_PX;
  assert.ok(winFar > 47 && winFar < 49, `${winFar}`);
  assert.deepEqual(
    [PASS_NEAR, PASS_BEHIND, PASS_GRACE_MS, LOST_MS, PASS_MAX_MS, CONFLICT_RADIUS, HIT_DEBOUNCE_MS],
    [25, 10, 2000, 5000, 120000, 25, 60000],
  );
  assert.deepEqual([REC_LATERAL, APPLY_ANGLE, SIDE_MIN, ARM_SAME, ARM_CHORD], [8, 60, 1.5, 15, 10]);
  assert.deepEqual([POS_ERR_MIN, ACCURACY_TO_SIGMA, HEALTH_WINDOW_MS, FIX_KEEP_MS], [2, 1.5, 10000, 30000]);
  assert.deepEqual([FRAME_GAP_MS, WAY_SLACK, PARALLEL_NEAR, POS_SMOOTH], [2000, 25, 15, 0.3]);
  // Sai số vị trí gán cho một lần thấy không dưới 2 m.
  const { learner, clock } = bareLearner();
  const fix = { coord: along(100), speed: 10, heading: 90, accuracy: 1, time: clock.wall };
  learner.onFix(fix, { corridor: buildCorridor(fix, WORLD.roads), corridorTime: fix.time });
  const p = learner.place({ code: 'P.102', value: null, junction: false, lateral: 5, t: clock.mono + 1, D: 0, Z: 30 });
  assert.equal(p.posErr, POS_ERR_MIN);
  // Lịch sử định vị chỉ giữ 30 giây.
  for (let k = 1; k <= 40; k++) {
    clock.wall += 1000;
    clock.mono += 1000;
    learner.onFix({ ...fix, coord: along(100 + 10 * k), time: clock.wall });
  }
  assert.ok(learner.fixes[0].mono >= clock.mono - FIX_KEEP_MS);
});

test('mô phỏng: biển ở cả hai bên đường (một cặp) chỉ là một bản ghi, chỉ được tính một lần mỗi lượt', () => {
  const store = newStore();
  const r = drive({ seed: 21, store, signs: [P127, { ...P127, lat: -5 }] });
  assert.equal(store.list().filter((x) => x.code === 'P.127').length, 1);
  assert.equal(store.get(byCode(store, 'P.127').id).L, 0.4, 'không cộng điểm hai lần');
  assert.ok(r.results.some((x) => x.event === 'dup'));
});

test('mô phỏng: xe rời đường trước khi tới biển, hoặc đứng quá lâu → không đủ bằng chứng', () => {
  const clock = { t: NOON_HANOI };
  const store = newStore(clock);
  drive({ seed: 1, store, signs: [P127] });
  const id = byCode(store, 'P.127').id;
  const L0 = store.get(id).L;
  const gone = drive({ seed: 31, store, signs: [], mapCorridor: (corr, x) => (x > 440 ? null : corr) });
  assert.deepEqual(gone.passed.filter((e) => e.record.id === id).map((e) => e.reason), ['left']);
  // Đứng rất lâu ngay trước biển: quá thời gian xét; biển đã quá gần nên không được xét lại khi xe đi tiếp.
  const parked = drive({ seed: 32, store, signs: [], stop: { x: 470, s: PASS_MAX_MS / 1000 + 10 } });
  assert.deepEqual(parked.passed.filter((e) => e.record.id === id).map((e) => e.reason), ['timeout']);
  assert.equal(store.get(id).L, L0);
});

test('biển đã học lệch khỏi hành lang quá 8 m (đường song song) không được xét', () => {
  const store = newStore();
  store.observe({ code: 'P.102', value: null, family: 'noentry', coord: off(along(500), REC_LATERAL + 2), facing: 270, posErr: 4 });
  store.observe({ code: 'P.102', value: null, family: 'noentry', coord: off(along(700), REC_LATERAL - 2), facing: 270, posErr: 4 });
  const r = drive({ seed: 41, store, signs: [] });
  assert.deepEqual(r.passed.map((e) => xOfCoord(e.record.coord) > 600), [true]);
});

// ---------------------------------------------------------------------------------------------
// Camera ngừng giữa chừng, xe bò chậm, xe vào đường muộn, đường song song, dừng xe, xe nhanh
// ---------------------------------------------------------------------------------------------

/** Biển P.127[50] học được hôm qua (một lần thấy, chưa xác nhận), đồng hồ đã sang hôm nay → { store, id }. */
function learnedYesterday(seed = 1) {
  const clock = { t: NOON_HANOI };
  const store = newStore(clock);
  drive({ seed, store, signs: [P127] });
  clock.t += 864e5;
  return { store, id: byCode(store, 'P.127').id };
}
const outcomes = (r, id) => r.passed.filter((e) => e.record.id === id).map((e) => `${e.outcome}:${e.reason}`).join(',');

/** Một biển đã có sẵn trong kho (không qua camera). */
const putSign = (store, { x = P127.x, y = 0, code = 'P.127', value = '50', family = 'ring', wayId = 1, confirm = false } = {}) => {
  const rec = store.observe({ code, value, family, coord: off(along(x), y), facing: 270, wayId, junction: null, night: false, posErr: 4 }).record;
  if (confirm) store.confirm(rec.id);
  return rec.id;
};

test('camera ngừng khi biển (vẫn còn) ở phía trước: lượt bám đang mở được xét, thấy lại, không bao giờ "không thấy"', () => {
  for (const cut of [9, 25]) {
    for (const seed of [1, 2, 3]) {
      const { store, id } = learnedYesterday(seed);
      const r = drive({ seed: 100 + seed, day: 1, store, signs: [P127], cameraOn: (x) => x < P127.x - cut });
      assert.equal(outcomes(r, id), 'hit:null', `camera ngừng khi biển còn ${cut} m (seed ${seed})`);
      assert.equal(r.learner.tracker.tracks.length, 0, 'lượt bám cũ đã được kết thúc');
    }
  }
});

test('camera ngừng trong cửa sổ xét (biển đã bị dỡ): không đủ bằng chứng; ngừng khi biển đã ra khỏi cửa sổ: "không thấy"', () => {
  const removed = (cameraOn, seed) => {
    const { store, id } = learnedYesterday(seed);
    const L0 = store.get(id).L;
    const r = drive({ seed: 200 + seed, day: 1, store, signs: [], cameraOn });
    return [outcomes(r, id), Math.round((store.get(id).L - L0) * 10) / 10];
  };
  assert.deepEqual(removed((x) => x < P127.x - 25, 1), ['none:camera', 0], 'ngừng hẳn khi biển còn 25 m');
  assert.deepEqual(removed((x) => x < P127.x - 25 || x > P127.x + 5, 2), ['none:camera', 0], 'ngừng rồi chạy lại sau biển');
  // Mức tải 0 (tạm nghỉ vài phút) từ xa trước biển tới sau biển.
  assert.deepEqual(removed((x) => x < 300 || x > 800, 3), ['none:camera', 0]);
  assert.deepEqual(removed((x) => x < P127.x - 9, 4), ['miss:null', -0.5], 'đã xem trọn cửa sổ 12–48 m');
});

test('xe bò chậm dưới 3 m/s qua biển (camera tạm dừng lấy khung): biển vẫn còn được tính thấy lại', () => {
  for (const [ahead, seed] of [[30, 1], [20, 2], [10, 3]]) {
    const { store, id } = learnedYesterday(seed);
    const r = drive({ seed: 300 + seed, day: 1, store, signs: [P127], slow: { x0: P127.x - ahead, x1: P127.x + 20, v: 2.5 }, cameraOn: (x, v) => v >= 3 });
    assert.equal(outcomes(r, id), 'hit:null', `chậm từ ${ahead} m trước biển`);
    assert.equal(store.get(id).hitDays, 2);
  }
});

test('pause() và quãng không có khung quá 2 giây: kết thúc ngay các lượt bám đang mở', () => {
  const box = (w) => ({ x: 1000, y: 400, w, h: w, family: 'ring', s: 0.8, pass: 'A', cls: null });
  const frame = (t, w) => ({ t, ms: {}, lum: { mean: 120, std: 40 }, boxes: [box(w)] });
  const { learner, clock, step } = bareLearner();
  learner.onVision(frame(clock.mono, 12));
  step(200);
  learner.onVision(frame(clock.mono, 13));
  assert.equal(learner.tracker.tracks.length, 1);
  const res = learner.pause();
  assert.equal(res.ended, 1);
  assert.equal(res.results[0].ok, false);
  assert.equal(learner.tracker.tracks.length, 0);
  // Không gọi pause(): lần định vị đầu tiên sau 2 giây không có khung kết thúc lượt bám.
  learner.onVision(frame(clock.mono + 200, 12));
  step(FRAME_GAP_MS);
  learner.onFix({ coord: along(100), speed: 10, heading: 90, accuracy: 5, time: clock.wall });
  assert.equal(learner.tracker.tracks.length, 1, 'mới 1,8 giây');
  step(300);
  learner.onFix({ coord: along(103), speed: 10, heading: 90, accuracy: 5, time: clock.wall });
  assert.equal(learner.tracker.tracks.length, 0);
  // Khung đến sau quãng ngừng: lượt bám cũ kết thúc trước, không ghép với hộp mới.
  learner.onVision(frame(clock.mono, 12));
  step(FRAME_GAP_MS + 100);
  const later = learner.onVision(frame(clock.mono, 12));
  assert.equal(later.ended, 1);
  assert.equal(learner.tracker.tracks.length, 1);
  assert.equal(learner.stats().tracks, 3);
});

test('bước 13 nhìn cả phía sau: nút OSM cách 15–20 m sau vị trí thật vẫn chặn học trùng', () => {
  // Đơn vị: nút trên bản đồ ở sau lưng xe tại lần định vị được chọn chỉ có trên các hành lang cũ hơn.
  const tag = { traffic_sign: 'VN:P.127[50]', 'traffic_sign:direction': '270' };
  const world = makeWorld({ feats: [{ id: 'n4', coord: off(along(235), -6), onWay: false, tags: tag }] });
  const { learner, monos } = placedLearner([200, 214, 228, 242], world);
  const at = (Z) => learner.place(obsAt({ t: monos[3] + 1, D: learner.fixes[3].D, Z })).osm;
  assert.equal(at(13), true, 'ước tính ở 255 m, bản đồ có ở 235 m (7 m sau lưng xe)');
  assert.equal(at(20), true);
  assert.equal(at(26), false, 'cách 33 m');
  // Mô phỏng đầy đủ.
  for (const dx of [-20, -15]) {
    const w = makeWorld({ feats: [{ id: 'n1', coord: off(along(P127.x + dx), -6), onWay: false, tags: tag }] });
    for (const seed of [1, 2, 3, 4, 5]) {
      const store = newStore();
      const r = drive({ seed, store, world: w, signs: [P127] });
      assert.equal(byCode(store, 'P.127'), null, `OSM ${dx} m (seed ${seed})`);
      assert.ok(r.results.some((x) => x.event === 'osm'));
    }
  }
});

/** Đường chính (way 1) và một đường khác cùng chiều (way 3) song song, cách `gap` m về phía Bắc. */
function parallelWorld(gap) {
  const main = [];
  const other = [];
  for (let x = 0; x <= 1400; x += 50) {
    main.push(along(x));
    other.push(off(along(x), gap));
  }
  const ways = [
    { id: 1, n: 'Đường dưới', h: 'primary', c: null, m: null, o: 0, g: main.flat() },
    { id: 3, n: 'Đường trên cao', h: 'trunk', c: null, m: null, o: 1, g: other.flat() },
  ];
  const roads = new RoadData({ fetchImpl: () => Promise.reject(new Error('không có mạng')), cache: { get: async () => null, put: () => {} } });
  roads.setCell(cellKey(...cellOf(O)), { ways, feats: [], v: 3, t: Date.now() });
  return { roads };
}

test('đường song song cùng chiều (trên cao, đường gom): biển của đường kia không bị trừ điểm; định vị lẫn được thì không trừ', () => {
  for (const gap of [4, 7]) {
    const world = parallelWorld(gap);
    for (let seed = 1; seed <= 6; seed++) {
      const store = newStore();
      const id = putSign(store, { y: gap, value: '80', wayId: 3, confirm: true });
      const r = drive({ seed, store, world, signs: [], sigma: 1.5 });
      assert.ok(!outcomes(r, id).includes('miss'), `đường kia cách ${gap} m (seed ${seed}): ${outcomes(r, id)}`);
      assert.equal(store.get(id).L, 3.5);
    }
  }
  // Biển trên chính đường của xe, sát một đường cùng chiều khác (≤ 15 m): không biết xe ở đường nào, không trừ điểm.
  for (const [gap, want] of [[6, 'none:way'], [40, 'miss:null']]) {
    const store = newStore();
    const id = putSign(store, { wayId: 1, confirm: true });
    const r = drive({ seed: 9, store, world: parallelWorld(gap), signs: [], sigma: 1.5 });
    assert.equal(outcomes(r, id), want, `đường khác cách ${gap} m`);
  }
});

/** Như WORLD, nhưng đường chính bị OSM tách làm hai ở nút giao (id 1 trước, id 4 sau), như dữ liệu thật. */
function splitWorld() {
  const main = [];
  for (let x = 0; x <= 1400; x += 50) main.push(along(x));
  const j = JX / 50;
  const J = main[j];
  const ways = [
    { id: 1, n: 'Đường chính', h: 'primary', c: null, m: null, o: 0, g: main.slice(0, j + 1).flat() },
    { id: 4, n: 'Đường chính', h: 'primary', c: null, m: null, o: 0, g: main.slice(j).flat() },
    { id: 2, n: 'Đường ngang', h: 'residential', c: null, m: null, o: 0, g: [off(J, -150), off(J, -50), J, off(J, 50), off(J, 150)].flat() },
  ];
  const roads = new RoadData({ fetchImpl: () => Promise.reject(new Error('không có mạng')), cache: { get: async () => null, put: () => {} } });
  roads.setCell(cellKey(...cellOf(O)), { ways, feats: [], v: 3, t: Date.now() });
  return { roads, ways, J, jKey: vertexKey(J) };
}

test('continuesWay: chung đầu mút và lệch hướng ≤ CONTINUE_ANGLE là cùng con đường đi tiếp; rẽ ngang, giữa đường thì không', () => {
  assert.equal(CONTINUE_ANGLE, 20);
  const { ways, J } = splitWorld();
  const [a, b, cross] = ways;
  assert.equal(continuesWay(a, b), true);
  assert.equal(continuesWay(b, a), true, 'không theo chiều vẽ');
  const rev = { ...b, id: 5, g: [...b.g].reverse().reduce((o, v, i, arr) => (i % 2 ? o : [...o, arr[i + 1], v]), []) };
  assert.equal(continuesWay(a, rev), true, 'đường đi tiếp vẽ ngược chiều');
  assert.equal(continuesWay(a, a), false, 'chính nó');
  // Đường ngang qua đỉnh nút giao (đỉnh giữa, không phải đầu mút) và một đường bắt đầu ở nút giao nhưng rẽ 90°.
  assert.equal(continuesWay(a, cross), false);
  const turn = { id: 6, g: [J, off(J, 50), off(J, 100)].flat() };
  assert.equal(continuesWay(a, turn), false);
  const bend = (deg) => ({ id: 7, g: [J, destination(J, 90 + deg, 50)].flat() });
  assert.equal(continuesWay(a, bend(CONTINUE_ANGLE - 2)), true, `lệch ${CONTINUE_ANGLE - 2}°`);
  assert.equal(continuesWay(a, bend(CONTINUE_ANGLE + 2)), false, `lệch ${CONTINUE_ANGLE + 2}°`);
  assert.equal(continuesWay(a, { id: 8, g: [J] }), false, 'một đỉnh');
  assert.equal(continuesWay(null, b), false);
});

test('biển của nút giao khi OSM tách đường ở nút giao: đoạn đi tiếp không bị coi là đường song song, biển bị dỡ vẫn bị trừ điểm', () => {
  const world = splitWorld();
  for (let seed = 1; seed <= 6; seed++) {
    const store = newStore();
    const rec = store.observe({ code: 'R.122', value: null, family: 'octagon', coord: along(STOP.x), facing: 270, wayId: 1, junction: world.jKey, night: false, posErr: 4 }).record;
    store.confirm(rec.id);
    const r = drive({ seed, store, world, signs: [], sigma: 1.5 });
    assert.equal(outcomes(r, rec.id), 'miss:null', `seed ${seed}`);
  }
  // Đường song song thật sát bên vẫn chặn trừ điểm khi đường chính bị tách ở nút giao.
  const { roads, ways } = splitWorld();
  const par = [];
  for (let x = 0; x <= 1400; x += 50) par.push(off(along(x), 6));
  roads.setCell(cellKey(...cellOf(O)), { ways: [...ways, { id: 3, n: 'Đường gom', h: 'service', c: null, m: null, o: 1, g: par.flat() }], feats: [], v: 3, t: Date.now() });
  const store = newStore();
  const rec = store.observe({ code: 'R.122', value: null, family: 'octagon', coord: along(STOP.x), facing: 270, wayId: 1, junction: vertexKey(ways[0].g.slice(-2)), night: false, posErr: 4 }).record;
  store.confirm(rec.id);
  assert.equal(outcomes(drive({ seed: 9, store, world: { roads }, signs: [], sigma: 1.5 }), rec.id), 'none:way');
});

test('cùng đường: lần thấy của camera không gộp vào biển đường bên cạnh; id đường cũ của biển vẫn khớp và được cập nhật', () => {
  const world = parallelWorld(5);
  const store = newStore();
  const upper = putSign(store, { y: 5, wayId: 3 });
  drive({ seed: 1, store, world, signs: [P127], sigma: 1.5 });
  const mine = store.list().filter((x) => x.code === 'P.127' && x.id !== upper);
  assert.equal(mine.length, 1, 'biển của đường dưới là một bản ghi riêng');
  assert.equal(store.get(mine[0].id).wayId, 1);
  assert.equal(store.get(upper).passes, 1, 'biển đường trên cao không được tính thấy lại');
  // Biển mang id đường không còn trong dữ liệu (bản đồ đã cập nhật): đi qua không trừ điểm ('way'), thấy lại thì khớp.
  const s2 = newStore();
  const stale = putSign(s2, { wayId: 777 });
  const gone = drive({ seed: 2, store: s2, signs: [] });
  assert.equal(outcomes(gone, stale), 'none:way');
  const seen = drive({ seed: 3, store: s2, signs: [P127] });
  assert.equal(outcomes(seen, stale), 'hit:null');
  assert.equal(s2.size, 1);
  assert.equal(s2.get(stale).wayId, 1);
});

test('xe vào đường khi biển đã ở gần (dưới 40 m): vẫn báo đã đi qua ("late"), không bao giờ trừ điểm', () => {
  for (const [gap, camera] of [[15, false], [30, false], [15, true], [30, true]]) {
    const store = newStore();
    const id = putSign(store, { confirm: true });
    // GPS σ 2 m: lần định vị đầu không thể đặt xe lùi 10 m (σ 4 m thì hiếm khi có, và khi đó biển được xét đủ).
    const r = drive({ seed: gap, store, signs: [], camera, start: P127.x - gap, sigma: 2 });
    assert.equal(outcomes(r, id), 'none:late', `vào đường ${gap} m trước biển, camera ${camera ? 'bật' : 'tắt'}`);
    assert.equal(r.passed.find((e) => e.record.id === id).record.code, 'P.127', 'CameraLimit nhận được biển');
    assert.equal(store.get(id).L, 3.5);
  }
  // Camera bật, biển vẫn còn và đủ khung: thấy lại.
  const store = newStore();
  const id = putSign(store);
  assert.equal(outcomes(drive({ seed: 5, store, signs: [P127], start: P127.x - 39 }), id), 'hit:null');
});

test('dừng xe: chỉ tính khi biển ở trong cửa sổ 12 m…f·W/20; dừng 6 giây được nhận ra dù định vị 1 giây một lần', () => {
  const run = (stop, seed) => {
    const store = newStore();
    const id = putSign(store, { x: STOP.x, code: 'R.122', value: null, family: 'octagon' });
    return outcomes(drive({ seed, kmh: 40, store, signs: [], stop }), id);
  };
  for (let seed = 1; seed <= 4; seed++) {
    assert.equal(run({ x: STOP.x - 30, s: 6 }, seed), 'none:stop', `dừng 6 giây khi biển còn 30 m (seed ${seed})`);
    assert.equal(run({ x: STOP.x - 30, s: 4 }, seed), 'miss:null', 'dừng 4 giây');
    assert.equal(run({ x: STOP.x - 5, s: 8 }, seed), 'miss:null', 'dừng 8 giây ở vạch, biển còn 5 m: ngoài cửa sổ');
  }
});

test('xe nhanh (90–120 km/h): biển đã bị dỡ vẫn được xét dù hai lần định vị nhảy qua khoảng 0–25 m', () => {
  for (const kmh of [90, 110, 120]) {
    for (let seed = 1; seed <= 6; seed++) {
      const store = newStore();
      const id = putSign(store);
      const r = drive({ seed, kmh, store, signs: [], end: 1300 });
      assert.equal(outcomes(r, id), 'miss:null', `${kmh} km/h (seed ${seed})`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Ảnh biển để kiểm tra độ chính xác (camEval, PLAN §6.5): onEvalCrop và "suýt được nhận"
// ---------------------------------------------------------------------------------------------

/**
 * Một lượt bám dựng tay của một biển 0,70 m lệch phải lat m (mặc định 5), xe 50 km/h, 5 khung/giây từ 45 m: qua mọi bước lọc khi p
 * cao. cls(k, p) đổi phân loại của khung k; pt(k, point) đổi cả điểm.
 */
function synthTrack({ label = 'P.127[50]', family = 'ring', p = 0.95, n = 12, lat = 5, cls = null, pt = null } = {}) {
  const v = 50 / 3.6;
  const points = [];
  for (let k = 0; k < n; k++) {
    const t = 1e5 + k * 200;
    const D = (v * k * 200) / 1000;
    const Z = 45 - D;
    const w = (F * 0.7) / Z;
    const cx = FOE.x + (F * lat) / Z;
    const cy = FOE.y - (F * 1.2) / Z;
    const c = cls ? cls(k, p) : [[label, p], ['other-sign', (1 - p) * 0.6], ['background', (1 - p) * 0.4]];
    const point = { t, D, x: cx - w / 2, y: cy - w / 2, w, h: w, s: 0.8, pass: 'A', cls: c, lum: { mean: 120, std: 40 },
      pose: { D, speed: v, accuracy: 5, simulated: false, corridor: true } };
    points.push(pt ? pt(k, point) : point);
  }
  return { id: 1, family, points, plate: null, reason: 'lost' };
}
const CTX = { labels, focal: F, foe: FOE };

test('suýt được nhận (near-miss): chỉ trượt bước đồng thuận hay độ tin, mọi bước khác đều qua', () => {
  assert.deepEqual(NEAR_MISS_REASONS, ['agreement', 'confidence']);
  // Đối chứng: lượt bám tốt được nhận, nên không phải "suýt".
  assert.equal(acceptTrack(synthTrack(), CTX).ok, true);
  assert.equal(nearMiss(synthTrack(), CTX), false);
  // Độ tin thấp (p 0,7 < 0,85) mà hình học, định vị, độ sáng đều tốt.
  const low = synthTrack({ p: 0.7 });
  assert.equal(acceptTrack(low, CTX).reason, 'confidence');
  assert.equal(nearMiss(low, CTX), true);
  // Đồng thuận thấp: 7/12 khung một nhãn, 5/12 nhãn khác.
  const split = synthTrack({ cls: (k, p) => [[k % 12 < 7 ? 'P.127[50]' : 'P.127[60]', p], ['other-sign', 0.02]] });
  assert.equal(acceptTrack(split, CTX).reason, 'agreement');
  assert.equal(nearMiss(split, CTX), true);
  // Truyền sẵn kết quả acceptTrack cũng được (Learner không tính lại).
  assert.equal(nearMiss(low, CTX, acceptTrack(low, CTX)), true);
  // Trượt thêm bước khác thì không phải "suýt": độ sáng (bước 11), định vị (10), lệch ngang (9), độ dài (5), số khung đã
  // phân loại (1), nhãn không được học (4).
  const darkFrame = synthTrack({ p: 0.7, pt: (k, q) => (k === 5 ? { ...q, lum: { mean: 120, std: 3 } } : q) });
  assert.equal(acceptTrack(darkFrame, CTX).reason, 'confidence');
  assert.equal(nearMiss(darkFrame, CTX), false);
  const sim = synthTrack({ p: 0.7, pt: (k, q) => ({ ...q, pose: { ...q.pose, simulated: true } }) });
  assert.equal(nearMiss(sim, CTX), false);
  const far = synthTrack({ p: 0.7, lat: 18 });
  assert.equal(acceptTrack({ ...far, points: far.points.map((q) => ({ ...q, cls: [['P.127[50]', 0.99]] })) }, CTX).reason, 'lateral');
  assert.equal(nearMiss(far, CTX), false);
  const short = synthTrack({ p: 0.7, n: 4 });
  assert.equal(nearMiss(short, CTX), false);
  const few = synthTrack({ p: 0.7, cls: (k, p) => (k < 3 ? [['P.127[50]', p]] : null) });
  assert.equal(acceptTrack(few, CTX).reason, 'cls-frames');
  assert.equal(nearMiss(few, CTX), false);
  const notLearned = labels.labels.find((l) => l.learn === false && l.family === 'ring');
  assert.ok(notLearned, 'có nhãn hình tròn không được học');
  const nl = synthTrack({ label: notLearned.label, p: 0.7 });
  assert.equal(acceptTrack(nl, CTX).reason, 'confidence');
  assert.equal(nearMiss(nl, CTX), false);
  assert.equal(nearMiss({ id: 2, points: [] }, CTX), false);
});

test('onEvalCrop: lượt bám được nhận gửi ảnh lớn nhất có nhãn đứng đầu đúng nhãn; việc học không đổi; không có hàm thì không giữ gì', async () => {
  const got = [];
  const sent = [];
  const storeA = newStore();
  const a = drive({ seed: 10, store: storeA, evalCrops: true, sent, onEvalCrop: (c) => got.push(c) });
  assert.ok(sent.length > 0);
  const accepted = got.filter((c) => c.outcome === 'accepted');
  assert.deepEqual(accepted.map((c) => c.label).sort(), ['P.127[50]', 'R.122']);
  for (const c of accepted) {
    assert.equal(c.reason, 'new');
    assert.deepEqual(Object.keys(c).sort(), ['blob', 'label', 'night', 'outcome', 'p', 'pred', 'reason', 'w']);
    assert.equal(c.blob.label, c.label, 'ảnh có nhãn đứng đầu đúng nhãn của lần thấy');
    assert.equal(c.blob.w, c.w);
    const maxW = Math.max(...sent.filter((s) => s.label === c.label).map((s) => s.w));
    assert.equal(c.w, maxW, 'ảnh của khung lớn nhất');
    assert.equal(c.p, 0.92);
    assert.equal(c.pred[0][0], c.label);
    assert.equal(c.night, false, 'buổi trưa');
  }
  assert.equal(a.learner.evalBest.size, 0, 'lượt bám đã kết thúc thì không giữ ảnh');
  // Cùng lượt chạy không có hàm (dù kết quả vẫn mang crops): kho học y hệt, bộ học không giữ ảnh nào.
  const storeB = newStore();
  const b = drive({ seed: 10, store: storeB, evalCrops: true });
  const strip = (st) => st.list().map(({ id, distance: dd, ...r }) => (void id, void dd, r));
  assert.deepEqual(strip(storeB), strip(storeA));
  assert.equal(b.learner.evalBest.size, 0);
  // Hàm có, nhưng Vision không gửi crops (camEval tắt): không gọi.
  const none = [];
  drive({ seed: 10, store: newStore(), onEvalCrop: (c) => none.push(c) });
  assert.equal(none.length, 0);
  // Hàm ném lỗi hay trả promise bị từ chối: việc học vẫn y hệt.
  const storeC = newStore();
  drive({ seed: 10, store: storeC, evalCrops: true, onEvalCrop: () => { throw new Error('x'); } });
  const storeD = newStore();
  drive({ seed: 10, store: storeD, evalCrops: true, onEvalCrop: () => Promise.reject(new Error('y')) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(strip(storeC), strip(storeA));
  assert.deepEqual(strip(storeD), strip(storeA));
});

test('onEvalCrop: lượt bám chỉ trượt độ tin → "near-miss" (không học gì); trượt thêm độ sáng → không gọi', () => {
  const got = [];
  const store = newStore();
  drive({ seed: 11, store, p: 0.7, evalCrops: true, onEvalCrop: (c) => got.push(c) });
  assert.equal(store.size, 0, 'không học biển nào');
  assert.ok(got.length >= 2, JSON.stringify(got.map((c) => c.outcome)));
  assert.ok(got.every((c) => c.outcome === 'near-miss' && c.reason === 'confidence'));
  assert.deepEqual([...new Set(got.map((c) => c.label))].sort(), ['P.127[50]', 'R.122']);
  assert.ok(got.every((c) => c.p === 0.7 && c.night === false && c.blob.label === c.label));
  const dark = [];
  drive({ seed: 11, store: newStore(), p: 0.7, lum: { mean: 120, std: 3 }, evalCrops: true, onEvalCrop: (c) => dark.push(c) });
  assert.equal(dark.length, 0);
});

test('setEvalCrop: bật/tắt lúc chạy; tắt thì quên ngay các ảnh đang giữ; reset() cũng quên', () => {
  const { learner, step } = bareLearner();
  const got = [];
  learner.setEvalCrop((c) => got.push(c));
  const box = { x: 900, y: 400, w: 30, h: 30, family: 'ring', s: 0.8, pass: 'A', cls: [['P.127[50]', 0.9]] };
  const frameAt = (t) => ({ t, ms: { total: 30 }, lum: { mean: 120, std: 40 }, boxes: [{ ...box }], crops: [{ i: 0, blob: { t }, w: 39, h: 39 }] });
  learner.onVision(frameAt(learner.mono()));
  assert.equal(learner.evalBest.size, 1, 'giữ ảnh của lượt bám đang mở');
  learner.setEvalCrop(null);
  assert.equal(learner.evalBest.size, 0);
  step(200);
  learner.onVision(frameAt(learner.mono()));
  assert.equal(learner.evalBest.size, 0, 'tắt thì không giữ');
  learner.setEvalCrop((c) => got.push(c));
  step(200);
  learner.onVision(frameAt(learner.mono()));
  assert.equal(learner.evalBest.size, 1);
  learner.reset();
  assert.equal(learner.evalBest.size, 0);
  learner.setEvalCrop('không phải hàm');
  assert.equal(learner.onEvalCrop, null);
  assert.equal(got.length, 0, 'không có lượt bám nào đủ điều kiện');
});
