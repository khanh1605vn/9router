import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, describePoint, signSpeech, SpeedMonitor } from '../js/alerts.js';
import { SignEngine } from '../js/signengine.js';
import { buildQuery, cellKey, cellOf, parseMaxspeed, parseOverpass, RoadData } from '../js/roaddata.js';
import { parseRoute } from '../js/routing.js';
import { RouteTracker } from '../js/tracker.js';
import { destination } from '../js/geo.js';
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
