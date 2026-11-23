import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertEngine,
  CAMERA_LIMIT_AHEAD,
  CAMERA_LIMIT_BEHIND,
  CAMERA_LIMIT_CODE,
  CAMERA_LIMIT_CORRIDORS,
  CAMERA_LIMIT_END_CODES,
  CAMERA_LIMIT_ENDS_AT_JUNCTION,
  CAMERA_LIMIT_GAP,
  CAMERA_LIMIT_HEADING_SPEED,
  CAMERA_LIMIT_LATERAL,
  CAMERA_LIMIT_OSM_REFRESH,
  CAMERA_LIMIT_PENDING_MAX,
  CAMERA_LIMIT_THROUGH_ANGLE,
  CAMERA_LIMIT_VERTEX_NEAR,
  CameraLimit,
  describePoint,
  JUNCTION_ROADS,
  overSpeedSay,
  signSpeech,
  SpeedMonitor,
  WAY_CONFIRM_FIXES,
  WAY_LOST_FIXES,
} from '../js/alerts.js';
import { SignEngine } from '../js/signengine.js';
import { buildQuery, cellKey, cellOf, parseMaxspeed, parseOverpass, RoadData } from '../js/roaddata.js';
import { parseRoute } from '../js/routing.js';
import { RouteTracker } from '../js/tracker.js';
import { destination } from '../js/geo.js';
import { LearnedSigns, memoryBackend } from '../js/learnedsigns.js';
import { Learner } from '../js/signlearn.js';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { driveAlong, sampleOsrmRoute, START } from './fixtures.mjs';

const ALL_ON = { alertCamera: true, alertToll: true, alertRail: true, alertReport: true };

function drive(points, { settings = ALL_ON, speed = 12, withNav = false } = {}) {
  const route = parseRoute(sampleOsrmRoute());
  const tracker = withNav ? new RouteTracker(route) : null;
  const engine = new AlertEngine();
  const fired = [];
  let shownFor = 0;
  for (const fix of driveAlong(route, speed)) {
    let nav = null;
    if (tracker) {
      const p = tracker.update(fix);
      nav = { route, seg: tracker.seg, s: p.s };
    }
    const r = engine.update(fix, points, settings, nav);
    if (r.fired) fired.push({ id: r.active.point.id, distance: r.active.distance, say: r.say });
    if (r.active) shownFor++;
  }
  return { fired, shownFor };
}

test('đọc giá trị maxspeed của OSM', () => {
  assert.equal(parseMaxspeed('60'), 60);
  assert.equal(parseMaxspeed('50 km/h'), 50);
  assert.equal(parseMaxspeed('30 mph'), 48);
  assert.equal(parseMaxspeed('VN:urban'), null);
  assert.equal(parseMaxspeed('none'), null);
  assert.equal(parseMaxspeed(undefined), null);
  assert.equal(parseMaxspeed('999'), null);
});

test('truy vấn Overpass giới hạn đúng ô bản đồ', () => {
  const [cx, cy] = cellOf([106.7, 10.77]);
  const q = buildQuery(cx, cy);
  assert.match(q, /\[bbox:10\.77000,106\.68000,10\.80000,106\.71000\]/);
  assert.match(q, /speed_camera/);
  assert.match(q, /out body geom/);
});

test('parseOverpass tách đường, camera, trạm thu phí, đường sắt', () => {
  const data = parseOverpass({
    elements: [
      { type: 'way', id: 1, tags: { highway: 'primary', name: 'Nguyễn Trãi', maxspeed: '60', 'maxspeed:motorcycle': '50', oneway: 'yes' }, geometry: [{ lat: 10.77, lon: 106.7 }, { lat: 10.78, lon: 106.7 }] },
      { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: 10.77, lon: 106.7 }, { lat: 10.77, lon: 106.71 }] },
      { type: 'node', id: 10, lat: 10.775, lon: 106.7, tags: { highway: 'speed_camera', maxspeed: '60' } },
      { type: 'node', id: 11, lat: 10.776, lon: 106.7, tags: { man_made: 'surveillance', 'surveillance:zone': 'traffic' } },
      { type: 'node', id: 20, lat: 10.79, lon: 106.7, tags: { barrier: 'toll_booth' } },
      { type: 'node', id: 21, lat: 10.79005, lon: 106.70005, tags: { barrier: 'toll_booth' } },
      { type: 'node', id: 30, lat: 10.76, lon: 106.7, tags: { railway: 'level_crossing' } },
      { type: 'relation', id: 99, tags: { type: 'enforcement', enforcement: 'traffic_signals' }, members: [{ type: 'node', ref: 12, role: 'device', lat: 10.777, lon: 106.7 }, { type: 'node', ref: 13, role: 'from', lat: 10.7771, lon: 106.7 }] },
    ],
  });
  assert.equal(data.ways.length, 2);
  assert.deepEqual({ c: data.ways[0].c, m: data.ways[0].m, o: data.ways[0].o }, { c: 60, m: 50, o: 1 });
  assert.equal(data.ways[1].c, null);
  const kinds = data.points.map((p) => `${p.kind}/${p.sub}`).sort();
  assert.deepEqual(kinds, ['camera/redlight', 'camera/speed', 'camera/traffic', 'rail/', 'toll/']); // hai làn thu phí gộp làm một
  assert.equal(data.points.find((p) => p.sub === 'speed').limit, 60);
});

test('camera phía trước chỉ được báo một lần, kèm khoảng cách', () => {
  const camera = { id: 'n1', kind: 'camera', sub: 'speed', limit: 60, coord: destination(START, 0, 700) };
  const { fired, shownFor } = drive([camera]);
  assert.equal(fired.length, 1);
  assert.ok(fired[0].distance > 250 && fired[0].distance <= 300, `báo ở ${fired[0].distance} m`);
  assert.equal(fired[0].say, 'Còn 300 mét, có camera bắn tốc độ, giới hạn 60 ki lô mét trên giờ');
  assert.ok(shownFor > 15, 'thanh cảnh báo phải hiện suốt lúc tiến lại gần');
});

test('không báo điểm nằm phía sau, ở đường ngang hay loại đã tắt', () => {
  const behind = { id: 'b', kind: 'camera', sub: 'speed', coord: destination(START, 180, 200) };
  const side = { id: 's', kind: 'camera', sub: 'speed', coord: destination(destination(START, 0, 400), 90, 150) };
  assert.equal(drive([behind, side], { withNav: false }).fired.filter((f) => f.id === 'b').length, 0);
  assert.equal(drive([side], { withNav: true }).fired.length, 0);
  const toll = { id: 't', kind: 'toll', coord: destination(START, 0, 600) };
  assert.equal(drive([toll], { settings: { ...ALL_ON, alertToll: false } }).fired.length, 0);
  assert.equal(drive([toll]).fired.length, 1);
});

test('khi dẫn đường: báo điểm nằm trên tuyến sau chỗ rẽ, theo quãng đường thực đi', () => {
  // Điểm nằm trên đường Lê Lợi, cách chỗ rẽ 150 m: đi thẳng theo hướng Bắc thì không "thấy" được.
  const corner = destination(START, 0, 1000);
  const report = { id: 'r1', kind: 'report', type: 'school', coord: destination(corner, 90, 150) };
  const { fired } = drive([report], { withNav: true });
  assert.equal(fired.length, 1);
  assert.match(fired[0].say, /có cổng trường học, hãy giảm tốc độ$/);
  assert.ok(fired[0].distance > 200, `khoảng cách dọc tuyến = ${fired[0].distance}`);
});

test('đứng yên thì không phát cảnh báo mới', () => {
  const engine = new AlertEngine();
  const camera = { id: 'n1', kind: 'camera', sub: 'speed', coord: destination(START, 0, 100) };
  const r = engine.update({ coord: START, speed: 0, heading: 0, time: 1 }, [camera], ALL_ON);
  assert.equal(r.fired, false);
});

test('mô tả điểm cảnh báo', () => {
  assert.equal(describePoint({ kind: 'camera', sub: 'redlight' }).title, 'Camera phạt vượt đèn đỏ');
  assert.equal(describePoint({ kind: 'toll' }).title, 'Trạm thu phí');
  assert.equal(describePoint({ kind: 'report', type: 'flood' }).say, 'có ngập nước');
});

function roadsWithTwoWays() {
  const roads = new RoadData();
  const a = START;
  const b = destination(START, 0, 1000);
  const mid = destination(START, 0, 500);
  const [cx, cy] = cellOf(mid);
  roads.setCell(cellKey(cx, cy), {
    ways: [
      { id: 1, n: 'Nguyễn Trãi', h: 'primary', c: 60, m: 50, o: 0, g: [a[0], a[1], b[0], b[1]] },
      // Đường cắt ngang tại giữa đoạn, giới hạn 40.
      { id: 2, n: 'Đường ngang', h: 'residential', c: 40, m: 40, o: 0, g: [...destination(mid, 270, 300), ...destination(mid, 90, 300)] },
    ],
    points: [{ id: 'n9', kind: 'toll', sub: '', limit: null, coord: b }],
  });
  return { roads, mid };
}

test('khớp đoạn đường theo hướng đi: qua giao lộ không nhận nhầm đường cắt ngang', () => {
  const { roads, mid } = roadsWithTwoWays();
  const north = roads.matchWay({ coord: destination(mid, 90, 4), heading: 2, speed: 10, accuracy: 8 });
  assert.equal(north.way.id, 1);
  const east = roads.matchWay({ coord: destination(mid, 90, 40), heading: 88, speed: 10, accuracy: 8 });
  assert.equal(east.way.id, 2);
  assert.equal(roads.matchWay({ coord: destination(mid, 45, 400), heading: 0, speed: 10, accuracy: 8 }), null);
  assert.equal(roads.pointsNear(mid, 600).length, 1);
  assert.equal(roads.pointsNear(mid, 300).length, 0);
  assert.equal(roads.hasData(mid), true);
});

test('giới hạn tốc độ: đổi đường cần khớp hai lần, xe máy dùng giới hạn riêng', () => {
  const { roads, mid } = roadsWithTwoWays();
  const mon = new SpeedMonitor();
  const fix = (coord, heading, kmh, time) => ({ coord, heading, speed: kmh / 3.6, accuracy: 8, time });
  const on1 = destination(mid, 180, 200);
  let r = mon.update(fix(on1, 0, 40, 0), roads.matchWay(fix(on1, 0, 40, 0)), { vehicle: 'car' });
  assert.equal(r.limit, 60);
  assert.equal(r.announce, 60);
  // Một lần định vị lạc sang đường ngang: chưa đổi.
  const on2 = destination(mid, 90, 60);
  r = mon.update(fix(on2, 90, 40, 1000), roads.matchWay(fix(on2, 90, 40, 1000)), { vehicle: 'car' });
  assert.equal(r.limit, 60);
  r = mon.update(fix(on2, 90, 40, 2000), roads.matchWay(fix(on2, 90, 40, 2000)), { vehicle: 'car' });
  assert.equal(r.limit, 40);
  assert.equal(r.announce, 40);

  const moto = new SpeedMonitor();
  assert.equal(moto.update(fix(on1, 0, 30, 0), roads.matchWay(fix(on1, 0, 30, 0)), { vehicle: 'moto' }).limit, 50);
});

test('vượt tốc độ: nhắc bằng lời sau 1,5 giây, rồi bíp cách quãng, im khi đã giảm tốc', () => {
  const { roads, mid } = roadsWithTwoWays();
  const mon = new SpeedMonitor();
  const at = destination(mid, 180, 200);
  const step = (kmh, time) => {
    const f = { coord: at, heading: 0, speed: kmh / 3.6, accuracy: 8, time };
    return mon.update(f, roads.matchWay(f), { vehicle: 'car', tolerance: 3 });
  };
  assert.equal(step(58, 0).level, 'ok');
  assert.equal(step(62, 1000).level, 'near'); // trong khoảng cho phép: chỉ đổi màu
  assert.equal(step(62, 2000).sound, null);
  const sounds = [];
  for (let t = 3000; t <= 16000; t += 1000) sounds.push(step(70, t).sound);
  assert.deepEqual(sounds.slice(0, 3), [null, null, 'voice']);
  assert.equal(sounds.filter((s) => s === 'voice').length, 1);
  assert.equal(sounds.filter((s) => s === 'beep').length, 1);
  assert.equal(step(55, 17000).level, 'ok');
  assert.equal(step(55, 18000).sound, null);
});

test('tốc độ tối đa tự đặt dùng khi đường không có dữ liệu', () => {
  const mon = new SpeedMonitor();
  const f = { coord: START, heading: 0, speed: 70 / 3.6, accuracy: 8, time: 0 };
  const r = mon.update(f, null, { customMax: 60, tolerance: 3, hasData: true });
  assert.equal(r.limit, 60);
  assert.equal(r.source, 'custom');
  assert.equal(r.level, 'over');
  assert.equal(r.announce, null);
  assert.equal(new SpeedMonitor().update(f, null, { customMax: 0 }).limit, null);
});

// ---------- Câu đọc biển báo và cài đặt "Đọc giới hạn tốc độ khi thay đổi" ----------

const item = (code, kind, value, say, d) => ({ key: `${kind}@${d}`, code, kind, value, say, distance: d });
const LIMIT = item('P.127', 'speed:40', 40, 'tốc độ tối đa 40 ki lô mét trên giờ', 120);
const LIMIT_NODE = item('P.127', 'speed:40', 40, 'biển tốc độ tối đa 40 ki lô mét trên giờ', 125);
const SIGNAL = item('W.209', 'signals', null, 'đèn tín hiệu giao thông', 140);

test('câu đọc biển báo: bật đọc giới hạn tốc độ (mặc định) thì giữ nguyên câu của bộ máy biển báo', () => {
  const sr = { fired: [LIMIT, SIGNAL], say: 'Phía trước 100 mét, tốc độ tối đa 40 ki lô mét trên giờ, đèn tín hiệu giao thông' };
  assert.equal(signSpeech(sr, {}), sr.say);
  assert.equal(signSpeech(sr, { speakLimit: true }), sr.say);
  assert.equal(signSpeech({ fired: [], say: null }, { speakLimit: false }), null);
});

test('câu đọc biển báo: tắt đọc giới hạn tốc độ thì bỏ biển tốc độ khỏi câu, các biển khác vẫn đọc', () => {
  const both = { fired: [LIMIT, LIMIT_NODE, SIGNAL], say: 'Phía trước 100 mét, tốc độ tối đa 40 ki lô mét trên giờ, đèn tín hiệu giao thông' };
  assert.equal(signSpeech(both, { speakLimit: false }), 'Phía trước 150 mét, đèn tín hiệu giao thông');
  const onlyLimit = { fired: [LIMIT, LIMIT_NODE], say: 'Phía trước 100 mét, tốc độ tối đa 40 ki lô mét trên giờ' };
  assert.equal(signSpeech(onlyLimit, { speakLimit: false }), null);
  const end = item('DP.134', 'sign:DP.134', null, 'hết hạn chế tốc độ tối đa', 110);
  assert.equal(signSpeech({ fired: [end], say: 'Phía trước 100 mét, hết hạn chế tốc độ tối đa' }, { speakLimit: false }), null);
  // Biển khác cùng mã và trị số chỉ đọc một lần; biển khu đông dân cư không phải biển giới hạn tốc độ.
  const zone = item('R.420', 'sign:R.420', null, 'bắt đầu khu đông dân cư', 130);
  const two = { fired: [LIMIT, SIGNAL, { ...SIGNAL, key: 'b', distance: 150 }, zone], say: 'x' };
  assert.equal(signSpeech(two, { speakLimit: false }), 'Phía trước 150 mét, đèn tín hiệu giao thông, bắt đầu khu đông dân cư');
});

test('tắt đọc giới hạn tốc độ: chạy qua chỗ đổi 60 → 40 km/h có đèn tín hiệu, chỉ nghe báo đèn', () => {
  const O = [106.695, 10.785];
  const line = (start, brg, length) => {
    const pts = [start];
    for (let d = 10; d <= length + 1e-6; d += 10) pts.push(destination(start, brg, d));
    return pts;
  };
  const NORTH = line(O, 0, 1000);
  const K = NORTH[50]; // chỗ đổi giới hạn, 500 m
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(O)), {
    ways: [
      { id: 1, n: '', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.slice(0, 51).flat() },
      { id: 2, n: '', h: 'primary', c: 40, m: 40, o: 0, g: line(K, 0, 500).flat() },
    ],
    points: [],
    feats: [{ id: 'n9', coord: NORTH[52], onWay: true, tags: { highway: 'traffic_signals' } }],
    restr: [],
  });
  const run = (settings) => {
    const engine = new SignEngine();
    const said = [];
    let time = 1_000_000;
    for (let x = 0; x <= 600; x += 15) {
      const fix = { coord: destination(O, 0, x), speed: 15, heading: 0, accuracy: 5, time };
      const sr = engine.update(fix, roads, settings, { vehicle: 'car', now: new Date(2026, 10, 23, 12) });
      const say = signSpeech(sr, settings);
      if (say) said.push(say);
      time += 1000;
    }
    return said;
  };
  const on = run({ speakLimit: true });
  assert.ok(on.some((s) => /tốc độ tối đa 40/.test(s) && /đèn tín hiệu/.test(s)), JSON.stringify(on));
  const off = run({ speakLimit: false });
  assert.ok(off.length >= 1, JSON.stringify(off));
  assert.ok(off.every((s) => !/tốc độ/.test(s)), JSON.stringify(off));
  assert.ok(off.some((s) => /đèn tín hiệu giao thông/.test(s)), JSON.stringify(off));
});

// ---------- Giới hạn tốc độ từ biển do camera ghi nhận (CameraLimit) ----------

const CO = [106.695, 10.785];
const CNOW = new Date(2026, 10, 23, 12);
const at = (x) => destination(CO, 0, x); // điểm trên đường chính đi về phía bắc, cách gốc x mét
const K = at(500); // chỗ đường chính tách hay có nút giao
const ten = (start, brg, length) => {
  const pts = [start];
  for (let d = 10; d <= length + 1e-6; d += 10) pts.push(destination(start, brg, d));
  return pts;
};
const NORTH = ten(CO, 0, 1000);

/**
 * Đường chính bắc–nam dài 1000 m. split: 'none' (một đường liền), 'plain' (tách đôi ở K, chỉ 2 nhánh).
 * side: hạng đường ngang nhập vào K (hai phía đông, tây; 'east' chỉ phía đông), null thì không có.
 */
function cameraRoads({ split = 'plain', side = null, sides = 'both', limit2 = 60, feats = [], parallel = false } = {}) {
  const ways =
    split === 'none'
      ? [{ id: 1, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.flat() }]
      : [
          { id: 1, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.slice(0, 51).flat() },
          { id: 2, n: 'Đường A', h: 'primary', c: limit2, m: limit2, o: 0, g: NORTH.slice(50).flat() },
        ];
  if (side) {
    ways.push({ id: 3, n: 'Đường B', h: side, c: null, m: null, o: 0, g: ten(K, 90, 300).flat() });
    if (sides === 'both') ways.push({ id: 4, n: 'Đường B', h: side, c: null, m: null, o: 0, g: ten(K, 270, 300).flat() });
  }
  if (parallel) {
    ways.push({ id: 5, n: 'Đường C', h: 'primary', c: 80, m: 80, o: 0, g: ten(destination(CO, 90, 30), 0, 1000).flat() });
  }
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(CO)), { ways, points: [], feats, restr: [] });
  return roads;
}

const signRec = (x, { code = 'P.127', value = '50', status = 'confirmed', plate = null, facing = 180, wayId = 1, lateral = 0 } = {}) => ({
  id: `r${code}${value}${x}`,
  code,
  value,
  status,
  plate,
  facing,
  wayId,
  coord: lateral ? destination(at(x), 90, lateral) : at(x),
});
const passed = (record, outcome = 'none', reason = 'camera') => ({ record, outcome, reason });

/** Đường xe đi: thẳng về phía bắc; turnAt: rẽ sang hướng turn ở mét này; shiftAt: từ mét này lệch sang đường song song. */
function pathFn({ turnAt = null, turn = 90, shiftAt = null, back = null } = {}) {
  return (x) => {
    if (back != null && x > back) return { coord: at(back - (x - back)), heading: 180 };
    if (turnAt != null && x > turnAt) return { coord: destination(at(turnAt), turn, x - turnAt), heading: turn };
    if (shiftAt != null && x >= shiftAt) return { coord: destination(at(x), 90, 30), heading: 0 };
    return { coord: at(x), heading: 0 };
  };
}

/**
 * Chạy xe 15 m/s, định vị mỗi giây, như main.js: bộ máy biển báo (hành lang), khớp đường, rồi tin của bộ học (gửi
 * trước update của lần định vị đó), rồi CameraLimit.update. events: [{ x, evt }]. Trả về { log: [{ x, cur }], cl }.
 */
function runCamera(
  roads,
  { from = 150, to = 800, step = 15, path = pathFn(), events = [], cl = new CameraLimit(), fixAt = null, matchAt = null } = {},
) {
  const engine = new SignEngine();
  const log = [];
  let time = 1_000_000;
  const todo = events.map((e) => ({ ...e }));
  for (let x = from; x <= to; x += step) {
    const p = path(x);
    let fix = { coord: p.coord, heading: p.heading, speed: 15, accuracy: 5, time };
    if (fixAt) fix = fixAt(x, fix);
    engine.update(fix, roads, {}, { vehicle: 'car', now: CNOW });
    const match = matchAt ? matchAt(x, fix) : roads.matchWay(fix, '', { vehicle: 'car' });
    for (const e of todo) {
      if (!e.sent && x >= e.x) {
        e.sent = true;
        e.kept = cl.onPassed(e.evt);
      }
    }
    const cur = cl.update(fix, match, { roads, corridor: engine.lastCorridor, hasData: roads.hasData(fix.coord), vehicle: 'car', now: CNOW });
    log.push({ x, cur });
    time += 1000;
  }
  const curAt = (x) => log.filter((l) => l.x <= x).at(-1)?.cur ?? null;
  return { log, cl, curAt, events: todo };
}

test('giới hạn camera: các ngưỡng là hằng số có tên', () => {
  assert.equal(CAMERA_LIMIT_ENDS_AT_JUNCTION, true);
  assert.deepEqual([...JUNCTION_ROADS].sort(), [
    'motorway', 'motorway_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'trunk', 'trunk_link', 'unclassified',
  ]);
  assert.equal(CAMERA_LIMIT_CODE, 'P.127');
  assert.deepEqual([...CAMERA_LIMIT_END_CODES].sort(), ['DP.134', 'DP.135']);
  assert.equal(WAY_CONFIRM_FIXES, 2);
  assert.equal(WAY_LOST_FIXES, 4);
  assert.equal(CAMERA_LIMIT_GAP, 300);
  assert.equal(CAMERA_LIMIT_THROUGH_ANGLE, 45);
  assert.equal(CAMERA_LIMIT_VERTEX_NEAR, 100);
  assert.equal(CAMERA_LIMIT_LATERAL, 25);
  assert.equal(CAMERA_LIMIT_AHEAD, 60);
  assert.equal(CAMERA_LIMIT_BEHIND, 150);
  assert.equal(CAMERA_LIMIT_PENDING_MAX, 8);
  assert.equal(CAMERA_LIMIT_HEADING_SPEED, 2.5);
  assert.equal(CAMERA_LIMIT_OSM_REFRESH, 100);
  assert.equal(CAMERA_LIMIT_CORRIDORS, 20);
});

test('giới hạn camera: bắt đầu khi xe đã qua biển P.127 đã xác nhận, mọi kết quả đi qua đều tính', () => {
  const roads = cameraRoads();
  for (const [outcome, reason] of [['none', 'camera'], ['none', 'late'], ['none', 'night'], ['miss', null], ['hit', null]]) {
    const r = runCamera(roads, { to: 300, events: [{ x: 215, evt: passed(signRec(200), outcome, reason) }] });
    assert.equal(r.events[0].kept, true, `${outcome}/${reason}`);
    assert.equal(r.curAt(210), null);
    const cur = r.curAt(225);
    assert.ok(cur, `${outcome}/${reason}`);
    assert.equal(cur.n, 50);
    assert.equal(cur.wayId, 1);
    assert.equal(typeof cur.since, 'number');
    assert.ok(Object.isFrozen(cur));
  }
});

test('giới hạn camera: không bắt đầu từ biển chưa xác nhận, có biển phụ, P.127a/b/c, DP.127 hay khi xe chưa tới biển', () => {
  const roads = cameraRoads();
  const cases = [
    ['chưa xác nhận (camera mới thấy)', passed(signRec(200, { status: 'candidate' }), 'hit', null)],
    ['đã loại', passed(signRec(200, { status: 'retired' }))],
    ['có biển phụ', passed(signRec(200, { plate: 'unread' }))],
    ['trị số ngoài khoảng', passed(signRec(200, { value: '150' }))],
    ['tốc độ ban đêm', passed(signRec(200, { code: 'P.127a', value: null }))],
    ['theo làn', passed(signRec(200, { code: 'P.127b', value: null }))],
    ['theo loại xe', passed(signRec(200, { code: 'P.127c', value: null }))],
    ['hết tốc độ theo biển ghép', passed(signRec(200, { code: 'DP.127', value: null }))],
    ['xe chưa tới biển', passed(signRec(200), 'none', 'left')],
    ['camera đọc trị số khác ở đúng chỗ', passed(signRec(200), 'miss', 'value')],
    ['kết quả lạ', passed(signRec(200), 'maybe', null)],
    ['không có bản ghi', { outcome: 'none' }],
  ];
  for (const [name, evt] of cases) {
    const r = runCamera(roads, { to: 330, events: [{ x: 215, evt }] });
    assert.ok(r.log.every((l) => l.cur == null), name);
  }
  // Biển có biển phụ vẫn được giữ lại để xét: nó thay (làm hết) giới hạn đang dùng.
  assert.equal(new CameraLimit().onPassed(passed(signRec(200, { plate: 'unread' }))), true);
  assert.equal(new CameraLimit().onPassed(passed(signRec(200, { status: 'candidate' }))), false);
});

test('giới hạn camera: tin "thấy lại" đến trước khi tới biển thì đợi xe qua biển', () => {
  const roads = cameraRoads();
  const r = runCamera(roads, { to: 300, events: [{ x: 180, evt: passed(signRec(200), 'hit', null) }] });
  assert.equal(r.curAt(195), null); // biển còn ở phía trước
  assert.equal(r.curAt(210)?.n, 50);
  // Biển ở quá xa phía trước: tin không hợp lý, bỏ.
  const far = runCamera(roads, { to: 330, events: [{ x: 150, evt: passed(signRec(150 + CAMERA_LIMIT_AHEAD + 20), 'hit', null) }] });
  assert.ok(far.log.every((l) => l.cur == null));
});

test('giới hạn camera: biển ngược chiều, của đường khác, cách xa đường xe đi hay quá cũ thì không dùng', () => {
  const roads = cameraRoads({ parallel: true });
  const none = (evt, x = 215) => runCamera(roads, { to: 330, events: [{ x, evt }] }).log.every((l) => l.cur == null);
  assert.ok(none(passed(signRec(200, { facing: 0 }))), 'ngược chiều');
  assert.ok(none(passed(signRec(200, { wayId: 5 }))), 'đường song song');
  assert.ok(none(passed(signRec(200, { lateral: CAMERA_LIMIT_LATERAL + 10 }))), 'cách xa');
  assert.ok(none(passed(signRec(150), 'none', 'timeout'), 150 + CAMERA_LIMIT_BEHIND + 30), 'quá cũ');
  // Xe đi chiều ngược lại, đang tới gần biển từ phía sau lưng biển: không phải biển của chiều xe đi.
  const south = runCamera(roads, {
    to: 400,
    path: (x) => ({ coord: at(600 - x), heading: 180 }),
    events: [{ x: 370, evt: passed(signRec(200)) }],
  });
  assert.ok(south.log.every((l) => l.cur == null), 'xe đi ngược chiều');
  // Không có id đường (bộ học không biết): vẫn dùng.
  assert.equal(runCamera(roads, { to: 300, events: [{ x: 215, evt: passed(signRec(200, { wayId: null })) }] }).curAt(225)?.n, 50);
});

test('giới hạn camera: đường tách đôi ở đỉnh chỉ có 2 nhánh thì giữ, wayId theo đường mới', () => {
  const r = runCamera(cameraRoads(), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  const cur = r.curAt(800);
  assert.equal(cur?.n, 50);
  assert.equal(cur.wayId, 2);
  assert.ok(r.log.filter((l) => l.x >= 225).every((l) => l.cur?.n === 50));
});

test('giới hạn camera: đi thẳng qua nút giao có đường lớn nhập vào thì thôi; tắt cờ thì giữ', () => {
  for (const side of ['primary', 'tertiary', 'unclassified']) {
    const roads = cameraRoads({ side });
    const on = runCamera(roads, { events: [{ x: 215, evt: passed(signRec(200)) }] });
    assert.equal(on.curAt(480)?.n, 50, side);
    assert.equal(on.curAt(800), null, side);
    const off = runCamera(roads, { events: [{ x: 215, evt: passed(signRec(200)) }], cl: new CameraLimit({ endsAtJunction: false }) });
    assert.equal(off.curAt(800)?.n, 50, side);
    assert.equal(off.curAt(800).wayId, 2, side);
  }
  // Ngã ba (chỉ một phía có đường nhập vào) cũng là nút giao.
  const tee = runCamera(cameraRoads({ side: 'secondary', sides: 'east' }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(tee.curAt(800), null);
});

test('giới hạn camera: nút giao với ngõ, ngách, hẻm (residential, living_street, service) không làm hết giới hạn', () => {
  for (const side of ['residential', 'living_street', 'service']) {
    // from 200: có một lần định vị đúng ở đỉnh nút giao (đầu mút của đường cũ).
    for (const from of [150, 200]) {
      const r = runCamera(cameraRoads({ side }), { from, events: [{ x: 215, evt: passed(signRec(200)) }] });
      assert.equal(r.curAt(800)?.n, 50, `${side} ${from}`);
    }
  }
});

test('giới hạn camera: xe bò qua nút giao, khớp nhầm sang đường ngang khi chưa có chiều đi thì không tính là rẽ', () => {
  const roads = cameraRoads({ side: 'residential' });
  const slow = (x) => x >= 480 && x <= 525;
  const r = runCamera(roads, {
    events: [{ x: 215, evt: passed(signRec(200)) }],
    fixAt: (x, fix) => (slow(x) ? { ...fix, speed: 1, heading: null } : fix),
    matchAt: (x, fix) => {
      const m = roads.matchWay(fix);
      if (!slow(x)) return m;
      const cross = roads.matchWay(fix, '', { only: new Set([3, 4]) });
      return cross ? { ...cross, dir: 0 } : m;
    },
  });
  assert.equal(r.curAt(800)?.n, 50);
});

test('giới hạn camera: đường OSM không tách ở nút giao, qua nút giao lớn vẫn thôi (theo cờ)', () => {
  const big = cameraRoads({ split: 'none', side: 'tertiary', sides: 'east' });
  const on = runCamera(big, { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(on.curAt(495)?.n, 50);
  assert.equal(on.curAt(800), null);
  const off = runCamera(big, { events: [{ x: 215, evt: passed(signRec(200)) }], cl: new CameraLimit({ endsAtJunction: false }) });
  assert.equal(off.curAt(800)?.n, 50);
  const alley = runCamera(cameraRoads({ split: 'none', side: 'residential' }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(alley.curAt(800)?.n, 50);
});

test('giới hạn camera: rẽ sang đường khác thì thôi, kể cả ở ngõ và khi tắt cờ', () => {
  for (const side of ['primary', 'residential']) {
    for (const endsAtJunction of [true, false]) {
      const r = runCamera(cameraRoads({ side }), {
        to: 700,
        path: pathFn({ turnAt: 500, turn: 90 }),
        events: [{ x: 215, evt: passed(signRec(200)) }],
        cl: new CameraLimit({ endsAtJunction }),
      });
      assert.equal(r.curAt(480)?.n, 50, `${side} ${endsAtJunction}`);
      assert.equal(r.curAt(700), null, `${side} ${endsAtJunction}`);
    }
  }
});

test('giới hạn camera: đường chính hết ở ngã ba, rẽ sang đường khác (chỉ còn ngõ phía kia) thì thôi', () => {
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(CO)), {
    ways: [
      { id: 1, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.slice(0, 51).flat() },
      { id: 3, n: 'Đường B', h: 'primary', c: 60, m: 60, o: 0, g: ten(K, 90, 300).flat() },
      { id: 4, n: 'Ngõ 7', h: 'residential', c: null, m: null, o: 0, g: ten(K, 270, 300).flat() },
    ],
    points: [],
    feats: [],
    restr: [],
  });
  for (const endsAtJunction of [true, false]) {
    const r = runCamera(roads, {
      to: 700,
      path: pathFn({ turnAt: 500, turn: 90 }),
      events: [{ x: 215, evt: passed(signRec(200)) }],
      cl: new CameraLimit({ endsAtJunction }),
    });
    assert.equal(r.curAt(480)?.n, 50);
    assert.equal(r.curAt(700), null, String(endsAtJunction));
  }
});

test('giới hạn camera: ở ngã ba chữ Y, rẽ vào nhánh của đường khác thì thôi; đi theo đường chính ngoặt nhẹ thì giữ', () => {
  const fork = (ways) => {
    const roads = new RoadData();
    roads.setCell(cellKey(...cellOf(CO)), { ways, points: [], feats: [], restr: [] });
    return roads;
  };
  const main1 = { id: 1, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.slice(0, 51).flat() };
  // Nhánh phải lệch 30°, đường chính đi thẳng: xe vào nhánh phải.
  const y = fork([
    main1,
    { id: 2, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: NORTH.slice(50).flat() },
    { id: 3, n: 'Đường B', h: 'tertiary', c: null, m: null, o: 0, g: ten(K, 30, 300).flat() },
  ]);
  for (const endsAtJunction of [true, false]) {
    const r = runCamera(y, {
      to: 750,
      path: pathFn({ turnAt: 500, turn: 30 }),
      events: [{ x: 215, evt: passed(signRec(200)) }],
      cl: new CameraLimit({ endsAtJunction }),
    });
    assert.equal(r.curAt(480)?.n, 50);
    assert.equal(r.curAt(750), null, String(endsAtJunction));
  }
  // Đường chính ngoặt 30° ở chỗ có ngõ đi thẳng (cùng tên, hay không có tên): vẫn là đường chính.
  for (const name of ['Đường A', '']) {
    const bend = fork([
      { ...main1, n: name },
      { id: 2, n: name, h: 'primary', c: 60, m: 60, o: 0, g: ten(K, 30, 300).flat() },
      { id: 3, n: 'Ngõ 5', h: 'residential', c: null, m: null, o: 0, g: NORTH.slice(50).flat() },
    ]);
    const r = runCamera(bend, { to: 750, path: pathFn({ turnAt: 500, turn: 30 }), events: [{ x: 215, evt: passed(signRec(200)) }] });
    assert.equal(r.curAt(750)?.n, 50, JSON.stringify(name));
    assert.equal(r.curAt(750).wayId, 2);
  }
  // Đường chính (cùng tên) ngoặt ở nút giao có đường lớn đi thẳng: tắt cờ thì vẫn là đi tiếp đường chính.
  const named = fork([
    main1,
    { id: 2, n: 'Đường A', h: 'primary', c: 60, m: 60, o: 0, g: ten(K, 30, 300).flat() },
    { id: 3, n: 'Đường C', h: 'tertiary', c: null, m: null, o: 0, g: NORTH.slice(50).flat() },
  ]);
  const keep = runCamera(named, {
    to: 750,
    path: pathFn({ turnAt: 500, turn: 30 }),
    events: [{ x: 215, evt: passed(signRec(200)) }],
    cl: new CameraLimit({ endsAtJunction: false }),
  });
  assert.equal(keep.curAt(750)?.n, 50);
  const ends = runCamera(named, { to: 750, path: pathFn({ turnAt: 500, turn: 30 }), events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(ends.curAt(750), null);
});

test('giới hạn camera: chưa khớp được đường nào thì không bắt đầu', () => {
  const cl = new CameraLimit();
  cl.onPassed(passed(signRec(200, { wayId: null })));
  for (const x of [215, 230]) assert.equal(cl.update({ coord: at(x), heading: 0, speed: 15, accuracy: 5, time: x }, null, {}), null);
});

test('giới hạn camera: nhảy sang đường song song (không có đỉnh chung) hay quay đầu thì thôi', () => {
  const shift = runCamera(cameraRoads({ parallel: true }), { path: pathFn({ shiftAt: 400 }), events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(shift.curAt(390)?.n, 50);
  assert.equal(shift.curAt(800), null);
  const back = runCamera(cameraRoads(), { to: 600, path: pathFn({ back: 350 }), events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(back.curAt(345)?.n, 50);
  assert.equal(back.curAt(450), null);
});

test('giới hạn camera: mất khớp đường, hết dữ liệu, vị trí nhảy xa, chạy thử hay reset thì thôi', () => {
  const roads = cameraRoads();
  const start = () => {
    const cl = new CameraLimit();
    runCamera(roads, { to: 240, cl, events: [{ x: 215, evt: passed(signRec(200)) }] });
    assert.equal(cl.current?.n, 50);
    return cl;
  };
  const f = (x, extra = {}) => ({ coord: at(x), heading: 0, speed: 15, accuracy: 5, time: 2_000_000 + x * 100, ...extra });
  let cl = start();
  for (let i = 1; i < WAY_LOST_FIXES; i++) assert.equal(cl.update(f(240 + i), null, { roads })?.n, 50);
  assert.equal(cl.update(f(250), null, { roads }), null);
  cl = start();
  assert.equal(cl.update(f(245), null, { roads, hasData: false }), null);
  cl = start();
  assert.equal(cl.update(f(240 + CAMERA_LIMIT_GAP + 20), roads.matchWay(f(240 + CAMERA_LIMIT_GAP + 20)), { roads }), null);
  cl = start();
  assert.equal(cl.update(f(245, { simulated: true }), roads.matchWay(f(245)), { roads }), null);
  cl = start();
  cl.reset();
  assert.equal(cl.current, null);
});

test('giới hạn camera: biển DP.134/DP.135 do camera ghi nhận (đã xác nhận) làm hết; biển chưa xác nhận thì không', () => {
  const roads = cameraRoads();
  for (const code of ['DP.134', 'DP.135']) {
    const r = runCamera(roads, {
      events: [
        { x: 215, evt: passed(signRec(200)) },
        { x: 415, evt: passed(signRec(400, { code, value: null })) },
      ],
    });
    assert.equal(r.curAt(400)?.n, 50, code);
    assert.equal(r.curAt(430), null, code);
    const cand = runCamera(roads, {
      events: [
        { x: 215, evt: passed(signRec(200)) },
        { x: 415, evt: passed(signRec(400, { code, value: null, status: 'candidate' }), 'hit', null) },
      ],
    });
    assert.equal(cand.curAt(800)?.n, 50, code);
  }
});

test('giới hạn camera: biển trên bản đồ (DP.134, DP.135, P.127 khác, đổi maxspeed) làm hết; DP.127 thì không', () => {
  const node = (i, sign) => ({ id: `n${i}`, coord: NORTH[i], onWay: true, tags: { traffic_sign: sign } });
  for (const sign of ['VN:DP.134', 'VN:DP.135', 'VN:P.127[60]']) {
    const r = runCamera(cameraRoads({ feats: [node(45, sign)] }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
    assert.equal(r.curAt(435)?.n, 50, sign);
    assert.equal(r.curAt(465), null, sign);
  }
  // Biển ở xa, ngoài phần hành lang đọc lúc bắt đầu: vẫn thấy nhờ đọc lại dọc đường.
  const far = runCamera(cameraRoads({ feats: [node(72, 'VN:DP.134')] }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(far.curAt(705)?.n, 50);
  assert.equal(far.curAt(735), null);
  const dp127 = runCamera(cameraRoads({ feats: [node(45, 'VN:DP.127')] }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(dp127.curAt(800)?.n, 50);
  // Bản đồ đổi giới hạn ở chỗ đường tách đôi (60 → 40): bản đồ được ưu tiên.
  const change = runCamera(cameraRoads({ limit2: 40 }), { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(change.curAt(480)?.n, 50);
  assert.equal(change.curAt(800), null);
});

test('giới hạn camera: bản đồ có biển tốc độ giữa biển camera và xe thì không bắt đầu', () => {
  const roads = cameraRoads({ feats: [{ id: 'n9', coord: NORTH[21], onWay: true, tags: { traffic_sign: 'VN:P.127[60]' } }] });
  const r = runCamera(roads, { to: 400, events: [{ x: 225, evt: passed(signRec(200)) }] });
  assert.ok(r.log.every((l) => l.cur == null));
});

test('giới hạn camera: biển P.127 khác thay trị số; biển có biển phụ thì thôi', () => {
  const r = runCamera(cameraRoads(), {
    events: [
      { x: 215, evt: passed(signRec(200)) },
      { x: 330, evt: passed(signRec(320, { value: '70' }), 'hit', null) },
      { x: 625, evt: passed(signRec(610, { value: '40', plate: 'unread' })) },
    ],
  });
  assert.equal(r.curAt(300)?.n, 50);
  assert.equal(r.curAt(600)?.n, 70);
  assert.equal(r.curAt(640), null);
  // Biển nhắc lại cùng trị số: giữ nguyên giới hạn và lúc bắt đầu.
  const again = runCamera(cameraRoads(), {
    events: [
      { x: 215, evt: passed(signRec(200)) },
      { x: 330, evt: passed(signRec(320)) },
    ],
  });
  assert.equal(again.curAt(800)?.n, 50);
  assert.equal(again.curAt(800).since, again.curAt(225).since);
  assert.equal(again.curAt(480), again.curAt(225)); // cùng đối tượng cho tới khi đổi đường
});

test('giới hạn camera: tin của biển nằm trước biển đang dùng không làm hết hay thay giới hạn', () => {
  const older = runCamera(cameraRoads(), {
    events: [
      { x: 285, evt: passed(signRec(300), 'hit', null) },
      { x: 345, evt: passed(signRec(260, { value: '30' })) },
    ],
  });
  assert.equal(older.curAt(800)?.n, 50);
  const end = runCamera(cameraRoads(), {
    events: [
      { x: 285, evt: passed(signRec(300), 'hit', null) },
      { x: 330, evt: passed(signRec(280, { code: 'DP.134', value: null })) },
    ],
  });
  assert.equal(end.curAt(800)?.n, 50);
  // Biển hết hiệu lực nằm sau biển tốc độ: tin đến muộn hơn tin của biển tốc độ cũng không làm nó bắt đầu lại.
  const late = runCamera(cameraRoads(), {
    events: [
      { x: 330, evt: passed(signRec(310, { code: 'DP.134', value: null })) },
      { x: 345, evt: passed(signRec(290)) },
    ],
  });
  assert.ok(late.log.every((l) => l.cur == null));
});

test('giới hạn camera: tin đến muộn sau khi xe đã qua nút giao thì không dùng biển trước nút giao', () => {
  for (const split of ['plain', 'none']) {
    const roads = cameraRoads({ split, side: 'primary', sides: 'east' });
    for (const x of [510, 525, 540]) {
      const r = runCamera(roads, { events: [{ x, evt: passed(signRec(490)) }] });
      assert.ok(r.log.every((l) => l.cur == null), `${split} ${x}`);
    }
    // Biển ngay sau nút giao thì dùng được.
    const after = runCamera(roads, { events: [{ x: 540, evt: passed(signRec(520, { wayId: split === 'plain' ? 2 : 1 })) }] });
    assert.equal(after.curAt(800)?.n, 50, split);
  }
});

test('đồng hồ tốc độ: lấy giới hạn thấp hơn giữa bản đồ và camera, camera không bao giờ nâng giới hạn', () => {
  const roads = cameraRoads();
  const f = { coord: at(200), heading: 0, speed: 40 / 3.6, accuracy: 5, time: 0 };
  const m = roads.matchWay(f);
  const sp = (opts) => new SpeedMonitor().update(f, m, { vehicle: 'car', ...opts });
  assert.deepEqual([sp({}).limit, sp({}).source], [60, 'road']);
  assert.deepEqual([sp({ camera: { n: 50 } }).limit, sp({ camera: { n: 50 } }).source], [50, 'camera']);
  assert.deepEqual([sp({ camera: 50 }).limit, sp({ camera: 50 }).source], [50, 'camera']);
  assert.deepEqual([sp({ camera: { n: 80 } }).limit, sp({ camera: { n: 80 } }).source], [60, 'road']);
  assert.deepEqual([sp({ camera: { n: 60 } }).limit, sp({ camera: { n: 60 } }).source], [60, 'road']); // bằng: không phải camera
  assert.deepEqual([sp({ camera: { n: 50 }, camSpeed: false }).limit, sp({ camera: { n: 50 }, camSpeed: false }).source], [60, 'road']);
  for (const bad of [{ n: 0 }, { n: 300 }, { n: NaN }, { n: 'abc' }, { n: 55.5 }, {}]) {
    assert.equal(sp({ camera: bad }).source, 'road', JSON.stringify(bad));
  }
  // Không có dữ liệu đường: camera dùng được; tốc độ tự đặt chỉ khi cả hai đều không có.
  const none = (opts) => new SpeedMonitor().update(f, null, { hasData: true, ...opts });
  assert.deepEqual([none({ camera: { n: 50 }, customMax: 40 }).limit, none({ camera: { n: 50 }, customMax: 40 }).source], [50, 'camera']);
  assert.deepEqual([none({ customMax: 40 }).limit, none({ customMax: 40 }).source], [40, 'custom']);
  assert.deepEqual([none({ camera: { n: 50 }, camSpeed: false, customMax: 40 }).limit, none({ camera: { n: 50 }, camSpeed: false, customMax: 40 }).source], [40, 'custom']);
  assert.deepEqual([none({ camera: { n: 50 }, camSpeed: false }).limit, none({ camera: { n: 50 }, camSpeed: false }).source], [null, null]);
});

test('đồng hồ tốc độ: quá giới hạn camera thì nhắc, câu nhắc nói rõ camera ghi nhận; không đọc số của đường khi đang hiện số camera', () => {
  const roads = cameraRoads();
  const mon = new SpeedMonitor();
  const step = (kmh, time, camera) => {
    const f = { coord: at(200), heading: 0, speed: kmh / 3.6, accuracy: 5, time };
    return mon.update(f, roads.matchWay(f), { vehicle: 'car', tolerance: 3, camera });
  };
  let r = step(58, 10_000, { n: 50 });
  assert.equal(r.limit, 50);
  assert.equal(r.source, 'camera');
  assert.equal(r.level, 'over');
  assert.equal(r.announce, null); // không đọc "60" khi đồng hồ đang hiện 50
  assert.equal(r.sound, null);
  r = step(58, 11_000, { n: 50 });
  r = step(58, 12_000, { n: 50 });
  assert.equal(r.sound, 'voice');
  assert.equal(overSpeedSay(r), 'Bạn đang chạy quá tốc độ. Giới hạn 50 ki lô mét trên giờ (camera ghi nhận)');
  assert.equal(overSpeedSay({ limit: 60, source: 'road' }), 'Bạn đang chạy quá tốc độ. Giới hạn 60 ki lô mét trên giờ');
  // Hết giới hạn camera: giới hạn của đường hiện lại và được đọc.
  r = step(58, 13_000, null);
  assert.equal(r.limit, 60);
  assert.equal(r.source, 'road');
  assert.equal(r.level, 'ok');
  assert.equal(r.announce, 60);
});

test('đồng hồ tốc độ cùng CameraLimit: lần đầu camera thấy không đổi gì, biển đã xác nhận hạ giới hạn tới nút giao', () => {
  const roads = cameraRoads({ side: 'primary' });
  const cl = new CameraLimit();
  const mon = new SpeedMonitor();
  const engine = new SignEngine();
  const out = [];
  let time = 5_000_000;
  for (let x = 150; x <= 800; x += 15) {
    const fix = { coord: at(x), heading: 0, speed: 55 / 3.6, accuracy: 5, time };
    engine.update(fix, roads, {}, { vehicle: 'car', now: CNOW });
    const match = roads.matchWay(fix);
    if (x === 210) cl.onPassed(passed(signRec(195, { status: 'candidate' }), 'hit', null)); // biển mới thấy lần đầu
    if (x === 300) cl.onPassed(passed(signRec(285))); // biển đã xác nhận
    cl.update(fix, match, { roads, corridor: engine.lastCorridor, vehicle: 'car', now: CNOW });
    const sp = mon.update(fix, match, { vehicle: 'car', camera: cl.current, camSpeed: true });
    out.push({ x, limit: sp.limit, source: sp.source, level: sp.level });
    time += 1000;
  }
  const atX = (x) => out.filter((o) => o.x <= x).at(-1);
  assert.deepEqual([atX(285).limit, atX(285).source, atX(285).level], [60, 'road', 'ok']);
  assert.deepEqual([atX(300).limit, atX(300).source, atX(300).level], [50, 'camera', 'over']);
  assert.deepEqual([atX(480).limit, atX(480).source], [50, 'camera']);
  assert.deepEqual([atX(800).limit, atX(800).source, atX(800).level], [60, 'road', 'ok']);
});

test('bộ học thật, camera tắt: đi qua biển P.127 đã xác nhận thì đồng hồ dùng giới hạn camera tới nút giao', async () => {
  const labels = buildLabels(SIGN_CATALOGUE);
  const roads = cameraRoads({ side: 'primary' });
  const clock = { wall: Date.UTC(2026, 10, 23, 5, 0), mono: 1_000_000 };
  const store = new LearnedSigns({ backend: memoryBackend(), now: () => clock.wall, labels });
  await store.load();
  const obs = (x, value) => ({
    code: 'P.127', value, family: 'ring', coord: at(x), facing: 180, wayId: 1, ways: [1], junction: null, branch: null,
    plate: null, night: false, strong: false, posErr: 3, osm: false,
  });
  const confirmed = store.observe(obs(300, '50')).record;
  store.confirm(confirmed.id);
  const candidate = store.observe(obs(240, '30')).record; // camera mới thấy một lần
  assert.equal(store.get(candidate.id).status, 'candidate');

  const learner = new Learner({ store, roads, labels, now: () => clock.wall, mono: () => clock.mono });
  const cl = new CameraLimit();
  const heard = [];
  learner.onPassed((e) => {
    heard.push(`${e.record.value}:${e.record.status}:${e.outcome}`);
    cl.onPassed(e);
  });
  const engine = new SignEngine();
  const mon = new SpeedMonitor();
  const out = [];
  for (let x = 100; x <= 800; x += 14) {
    clock.wall += 1000;
    clock.mono += 1000;
    const fix = { coord: at(x), heading: 0, speed: 14, accuracy: 5, time: clock.wall };
    engine.update(fix, roads, {}, { vehicle: 'car', now: new Date(clock.wall) });
    learner.onFix(fix, { corridor: engine.lastCorridor, corridorTime: engine.lastCorridorTime });
    const match = roads.matchWay(fix);
    cl.update(fix, match, { roads, corridor: engine.lastCorridor, hasData: true, vehicle: 'car', now: new Date(clock.wall) });
    const sp = mon.update(fix, match, { vehicle: 'car', camera: cl.current, camSpeed: true });
    out.push({ x, limit: sp.limit, source: sp.source });
  }
  assert.deepEqual(heard, ['30:candidate:none', '50:confirmed:none']);
  const atX = (x) => out.filter((o) => o.x <= x).at(-1);
  assert.deepEqual([atX(290).limit, atX(290).source], [60, 'road']); // biển chưa xác nhận: không đổi gì
  assert.deepEqual([atX(480).limit, atX(480).source], [50, 'camera']);
  assert.deepEqual([atX(800).limit, atX(800).source], [60, 'road']); // qua nút giao có đường lớn nhập vào
  const first = out.find((o) => o.source === 'camera');
  assert.ok(first.x > 300 && first.x <= 340, JSON.stringify(first));
});

test('giới hạn camera: dữ liệu lạ không làm lỗi, thiếu dữ liệu đường thì đổi đường là thôi', () => {
  const cl = new CameraLimit();
  for (const evt of [null, undefined, 5, 'x', {}, { record: null }, { record: 'x', outcome: 'none' },
    { record: { status: 'confirmed', code: 'P.127', value: '50', coord: 'x', facing: 180 }, outcome: 'none' },
    { record: { status: 'confirmed', code: 'P.127', value: '50', coord: [1, 2], facing: 'x' }, outcome: 'none' }]) {
    assert.equal(cl.onPassed(evt), false);
  }
  assert.equal(cl.update(null, null), null);
  assert.equal(cl.update({ coord: 'x' }, null), null);
  const odd = { coords: [[0, 0]], cum: [0], pieces: [] };
  assert.equal(cl.update({ coord: at(200), heading: 0, speed: 15, time: 1 }, null, { corridor: odd }), null);
  // Không có RoadData: biết đường đang khớp nhưng không xét được nút giao, nên mọi lần đổi đường đều thôi giới hạn.
  const roads = cameraRoads();
  const bare = runCamera(roads, { events: [{ x: 215, evt: passed(signRec(200)) }] });
  assert.equal(bare.curAt(800)?.n, 50);
  const noRoads = new CameraLimit();
  let time = 0;
  for (let x = 150; x <= 800; x += 15) {
    const fix = { coord: at(x), heading: 0, speed: 15, accuracy: 5, time: (time += 1000) };
    if (x === 225) noRoads.onPassed(passed(signRec(200)));
    noRoads.update(fix, roads.matchWay(fix), {});
    if (x === 480) assert.equal(noRoads.current?.n, 50);
  }
  assert.equal(noRoads.current, null);
});
