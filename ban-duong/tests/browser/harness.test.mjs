// Tự kiểm của bộ chạy thử lái xe (không thuộc npm test, không cần trình duyệt): node --test tests/browser/
// Kiểm mô hình máy ảnh của scene.js, bộ nhận diện oracle.js, thế giới giả lập (lib/drive-world.mjs) và các ngưỡng
// (lib/drive-config.mjs) đối chiếu với hằng số của chính ứng dụng, để bộ chạy thử không lệch khỏi mã thật.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import '../../js/visionproto.js';
import { DEFAULT_HFOV, focalPx, FOE_Y } from '../../js/signtrack.js';
import { foeFor, LEVELS } from '../../js/camsched.js';
import { buildQuery, cellOf, parseOverpass, vertexKey as appVertexKey } from '../../js/roaddata.js';
import { L_MAX, L_MISS_CANDIDATE, L_MISS_CONFIRMED, L_NEW } from '../../js/learnedsigns.js';
import { CLS_MIN_PX, NOMINAL_W } from '../../js/signlearn.js';
import { destination, distance } from '../../js/geo.js';
import * as C from './lib/drive-config.mjs';
import * as B from './bench.js';
import { bboxHasRoad, bboxOf, BDScene as S, BROWSER_DIR, JUNCTION_COORD, JUNCTION_KEY, ORIGIN, overpassFixture, ROAD, sceneSigns, SIGN_LAT, SIGNS, WORLD } from './lib/drive-world.mjs';

const P = globalThis.VisionProto;
const O = (() => {
  const sandbox = { BDScene: S };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(BROWSER_DIR, 'oracle.js'), 'utf8'), sandbox);
  return sandbox.BDOracle;
})();
const I = (() => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(BROWSER_DIR, 'init.js'), 'utf8'), sandbox);
  return sandbox.BDInitLimits;
})();
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

test('máy ảnh của scene.js: tiêu cự, điểm tụ và góc nhìn như ứng dụng', () => {
  assert.equal(S.HFOV, DEFAULT_HFOV);
  assert.equal(S.FOE_Y, FOE_Y);
  assert.equal(S.FOE_Y, P.FOE_Y);
  near(S.focal(), focalPx(1920, 70), 1e-9, 'tiêu cự 1920 px');
  near(S.focal(1080 * 16 / 9), focalPx(1920), 1e-9, 'theo cạnh dài');
  const cam = S.camera({ s: 0, lat: 0, dir: 1 });
  const foe = foeFor({ dx: 0, dy: 0 }, 1920, 1080);
  assert.deepEqual({ x: cam.cx, y: cam.cy }, foe);
  const aimed = S.camera({ s: 0, lat: 0, dir: 1 }, { aim: { dx: 40, dy: -20 } });
  assert.deepEqual({ x: aimed.cx, y: aimed.cy }, foeFor({ dx: 40, dy: -20 }, 1920, 1080));
  assert.equal(S.CAM_HEIGHT, 1.3);
  assert.equal(S.SIGN_SIZE, NOMINAL_W);
  assert.equal(S.SIGN_RIGHT, 5);
  assert.equal(S.SIGN_UP, 2.5);
});

test('hộp của biển: cỡ tỉ lệ nghịch khoảng cách, 20 px ở f·W/20 m, nằm bên phải và trên điểm tụ', () => {
  const cam = S.camera({ s: 0, lat: 0, dir: 1 });
  const z20 = (S.focal() * NOMINAL_W) / CLS_MIN_PX;
  const b = S.signBox(cam, { s: z20, lat: 5 });
  near(b.w, CLS_MIN_PX, 1e-9, 'bề rộng 20 px');
  near(b.Z, z20, 1e-9, 'Z');
  assert.ok(b.u > cam.cx && b.v < cam.cy);
  near(b.u - cam.cx, (S.focal() * 5) / z20, 1e-9, 'lệch ngang');
  const far = S.signBox(cam, { s: 2 * z20, lat: 5 });
  near(far.w, b.w / 2, 1e-9, 'gấp đôi khoảng cách thì nửa bề rộng');
  assert.equal(S.signBox(cam, { s: -3, lat: 5 }), null, 'sau lưng máy ảnh');
  // Đi ngược chiều (Tây): biển bên phải chiều Đông nằm bên trái.
  const west = S.camera({ s: 100, lat: -1.75, dir: -1 });
  const bw = S.signBox(west, { s: 60, lat: SIGN_LAT });
  assert.ok(bw.u < west.cx);
  near(bw.Z, 40, 1e-9, 'Z khi đi Tây');
});

test('xe tải che: hộp của đuôi xe và phần che', () => {
  const pose = { s: 0, lat: 1.75, dir: 1 };
  const cam = S.camera(pose);
  const t = S.truckBox(cam, pose, { gap: 20 });
  near(t.w, (S.focal() * S.TRUCK.w) / 20, 1e-9, 'bề rộng xe tải');
  assert.ok(t.x < cam.cx && t.x + t.w > cam.cx);
  assert.equal(S.overlapShare({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), 0.5);
  assert.equal(S.overlapShare({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), 0);
});

test('thế giới: toạ độ ↔ (s, lat) khớp js/geo.js', () => {
  for (const s of [-200, 0, 350, 700, 1400]) {
    const c = WORLD.toCoord(s, 0);
    near(distance(WORLD.toCoord(0, 0), c), Math.abs(s), 0.02, `quãng ${s} m`);
    const back = WORLD.fromCoord(WORLD.toCoord(s, 6.75));
    near(back.s, s, 1e-6, 's');
    near(back.lat, 6.75, 1e-6, 'lat');
  }
  const south = destination(WORLD.toCoord(100, 0), 180, 5);
  near(WORLD.fromCoord(south).lat, 5, 0.01, 'lat dương là phía Nam (bên phải chiều Đông)');
});

test('dữ liệu Overpass giả lập: hai đoạn đường chính và đường ngang gặp nhau ở một đỉnh', () => {
  const data = parseOverpass(overpassFixture());
  assert.deepEqual(data.ways.map((w) => w.id).sort(), [ROAD.westId, ROAD.eastId, ROAD.crossId].sort());
  assert.equal(appVertexKey(JUNCTION_COORD), JUNCTION_KEY);
  const hasJ = (w) => {
    for (let i = 0; i < w.g.length; i += 2) if (appVertexKey([w.g[i], w.g[i + 1]]) === JUNCTION_KEY) return true;
    return false;
  };
  assert.equal(data.ways.filter(hasJ).length, 3);
  for (const w of data.ways) if (w.id !== ROAD.crossId) assert.equal(w.c, ROAD.maxspeed);
});

test('truy vấn Overpass: chỉ ô chứa đường thử nhận dữ liệu', () => {
  const [cx, cy] = cellOf([ORIGIN.lon0, ORIGIN.lat0]);
  const body = `data=${encodeURIComponent(buildQuery(cx, cy))}`;
  assert.equal(bboxHasRoad(bboxOf(body)), true);
  assert.equal(bboxHasRoad(bboxOf(`data=${encodeURIComponent(buildQuery(cx + 1, cy))}`)), false);
  assert.equal(bboxOf('data=%ZZ'), null);
  // Cả đường thử nằm gọn trong một ô (không bị lặp ở ô bên cạnh).
  for (const s of [ROAD.from, ROAD.to]) assert.deepEqual(cellOf(WORLD.toCoord(s, 0)), [cx, cy]);
  assert.deepEqual(cellOf(WORLD.toCoord(ROAD.junction, ROAD.crossHalf * 0)), [cx, cy]);
});

test('biển của cảnh: R.122 cách nút giao 10 m, ba biển cách nhau đủ xa, họ biển từ labels.json', () => {
  assert.equal(ROAD.junction - SIGNS['R.122'].s, 10);
  const xs = Object.values(SIGNS).map((s) => s.s).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > 100);
  const sg = sceneSigns(['W.224', 'R.122'], { 'W.224': 'triangle', 'R.122': 'octagon' });
  assert.deepEqual(sg.map((x) => x.shape), ['triangle', 'round']);
  assert.ok(sg.every((x) => x.lat === SIGN_LAT && x.dir === 1));
  assert.throws(() => sceneSigns(['P.999'], {}));
});

test('oracle.js: hằng số như bộ nhận diện thật (visionproto.js)', () => {
  assert.equal(O.DET_W, P.DET_W);
  assert.equal(O.DET_H, P.DET_H);
  assert.equal(O.CUT_MARGIN, P.CUT_MARGIN);
  assert.equal(O.CLS_MIN_W, P.CLS_MIN_W);
  assert.equal(O.CLS_MAX_W, P.CLS_MAX_W);
  assert.equal(O.CLS_CAP, P.CLS_MAX);
  assert.equal(O.MAX_BOXES, P.MAX_BOXES);
  assert.equal(O.DET_MIN_PX, 10);
  assert.equal(O.B_SCALE, 3);
  assert.equal(O.P_CLS_MIN, 0.8);
  assert.equal(O.P_CLS_MAX, 0.99);
  assert.ok(O.P_DETECT > O.P_DETECT_RAIN);
  assert.equal(O.BOX_NOISE_REL, 0.03);
  assert.equal(O.BOX_NOISE_PX, 0.7);
  assert.equal(O.OCCLUDE_MIN, 0.4);
  assert.equal(O.P_CONFUSE, 0.02);
  // Trung bình p của nhãn đúng < 0,95: một lần thấy không thành "thấy rõ" (L_STRONG), để S4 đúng 2 lần thiếu.
  assert.ok((O.P_CLS_MIN + O.P_CLS_MAX) / 2 < 0.95);
});

test('oracle.js: ô cắt lượt A, lề trong, nhãn dễ nhầm', () => {
  const crop = { x: 640, y: 278 };
  assert.equal(O.insideA({ x: 700, y: 300, w: 20, h: 20 }, crop, 1920, 1080), true);
  assert.equal(O.insideA({ x: 641, y: 300, w: 20, h: 20 }, crop, 1920, 1080), false, 'sát mép trái của ô');
  assert.equal(O.insideA({ x: 1260, y: 300, w: 20, h: 20 }, crop, 1920, 1080), false, 'vượt mép phải');
  assert.equal(O.insideA({ x: 2, y: 2, w: 20, h: 20 }, { x: 0, y: 0 }, 1920, 1080), true, 'mép ô trùng mép khung thì không có lề');
  assert.deepEqual([...O.confusable('P.127[50]')], ['P.127[60]', 'P.127[40]']);
  assert.deepEqual([...O.confusable('P.127[60]')], ['P.127[50]', 'P.127[40]']);
  assert.equal(O.confusable('W.224')[0], 'other-sign');
  assert.ok(O.SHAPE.triangle.bh / O.SHAPE.triangle.bw >= 0.7 && O.SHAPE.triangle.bh / O.SHAPE.triangle.bw <= 1.05, 'tỉ lệ tam giác trong bước 8');
});

test('ngưỡng của kịch bản (lib/drive-config.mjs)', () => {
  assert.equal(C.PORT_FIRST, 20500);
  assert.equal(C.PORT_LAST, 20599);
  near(C.SPEED * 3.6, 50, 1, 'khoảng 50 km/h');
  assert.equal(C.ALONG_ERR_MAX, 5);
  // Khoảng đọc của S3 là khoảng clamp(v·8 s, 100, 200) của bộ máy biển báo.
  assert.equal(C.SPEAK_MIN, 100);
  assert.equal(C.SPEAK_MAX, 200);
  assert.ok(C.SPEED * 8 <= C.SPEAK_MAX);
  // Đi Đông qua mọi biển và qua nút giao đủ xa để lượt đi qua R.122 kết luận (≥ 10 m và 2 s sau biển).
  assert.ok(C.EAST.from < Math.min(...Object.values(SIGNS).map((s) => s.s)) - 200, 'biển đầu tiên còn xa hơn 200 m lúc xuất phát');
  assert.ok(C.EAST.to - SIGNS['R.122'].s >= 10 + 2 * C.SPEED);
  assert.ok(C.EAST.to > ROAD.junction + C.LIMIT_MARGIN);
  assert.ok(C.WEST.from > ROAD.junction && C.WEST.to < SIGNS['P.127[50]'].s);
  assert.equal(C.GPS_ACCURACY, 5);
  assert.equal(C.GPS_SIGMA, 1);
  assert.equal(C.RAMP_S, 3);
  assert.equal(C.LIMIT_MARGIN, 30);
  assert.equal(C.HIDE_STOP_MS, 1500);
  assert.ok(C.SETTLE_MS > 2000, 'lượt đi qua kết luận sau 2 s');
  assert.equal(C.IDB_FLUSH_MS, 1500);
  assert.equal(C.LOAD_TIMEOUT, 45000);
  assert.equal(C.POLL_MS, 200);
  assert.equal(C.S4_SLACK_DAYS, 3);
  assert.equal(C.S4_JUNCTION_DAYS, 2);
  assert.ok(C.LATENCY_FRAMES >= 200);
  assert.equal(C.DAY_MS, 864e5);
  assert.equal(C.TIMEZONE, 'Asia/Ho_Chi_Minh');
  // 09:00 và 19:30 giờ Việt Nam.
  assert.equal(new Date(C.DAY0 + 7 * 3600e3).getUTCHours(), 9);
  assert.equal(new Date(C.DAY0 + C.NIGHT_SHIFT_MS + 7 * 3600e3).getUTCHours(), 19);
  assert.ok(C.VIEWPORT.width < C.VIEWPORT.height);
  // Mức tải mặc định: 3 khung/giây, lượt B mỗi khung thứ hai (PLAN §5.6).
  assert.deepEqual({ ...LEVELS[2] }, { fps: 3, b: true });
});

test('số lần thiếu để bị loại (PLAN §5.8): 7 từ mức trần, 2 cho biển mới', () => {
  assert.equal(C.missesToRetire(L_MAX, L_MISS_CONFIRMED), 7);
  assert.equal(C.missesToRetire(L_NEW, L_MISS_CANDIDATE), 2);
  assert.equal(C.missesToRetire(2.8, L_MISS_CONFIRMED), 6);
  assert.equal(C.missesToRetire(-0.4, L_MISS_CANDIDATE), 1);
});

test('init.js: nhịp đọc giao diện, GPS giả và giọng đọc giả', () => {
  assert.deepEqual({ ...I }, { SAMPLE_MS: 500, HOOK_MS: 300, SPEAK_MS_PER_CHAR: 55, SPEAK_MS_MIN: 200, FIRST_FIX_MS: 300, HEADING_NOISE_DEG: 1, SPEED_NOISE: 0.1, MOVING: 0.5 });
  assert.ok(I.SAMPLE_MS < 1000, 'đọc giao diện dày hơn nhịp định vị 1 Hz');
});

test('bench.js: số khung, tổ hợp lượt quét, chạy dài, phân vị', () => {
  assert.ok(B.DEFAULT_FRAMES >= 200);
  assert.deepEqual(Object.keys(B.PASS_SETS), ['A', 'AB']);
  assert.deepEqual([...B.BUILDS], ['compat', 'relaxed']);
  assert.equal(B.SOAK_MINUTES, 30);
  assert.equal(B.SOAK_TICK_MS, 60e3);
  assert.equal(B.SOAK_FPS, LEVELS[2].fps);
  assert.equal(B.WARM_FRAMES, 5);
  assert.equal(B.LOAD_DUTY, 0.5);
  const s = B.summarize([5, 1, 4, 2, 3]);
  assert.deepEqual(s, { n: 5, p50: 3, p90: 4.6, p99: 5, max: 5 });
  assert.equal(B.quantileOf([], 0.5), null);
  assert.equal(B.modelsReady({ files: {} }).ok, false);
});
