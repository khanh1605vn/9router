import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCorridor, detectCurves, SignEngine, timeRangesActive } from '../js/signengine.js';
import { cellKey, cellOf, RoadData } from '../js/roaddata.js';
import { cumulativeDistances, destination, pointAtDistance } from '../js/geo.js';

// Dữ liệu dựng bằng hình học (không phải đường thật). Gốc toạ độ nằm giữa một ô dữ liệu 0,03° để mọi
// tra cứu (đường, nút biển, cấm rẽ) đều nằm trong cùng một ô.
const O = [106.695, 10.785];
const N = 0;
const E = 90;
const S = 180;
const W = 270;
const NOON = new Date(2026, 10, 23, 12, 0); // thứ Hai 23/11/2026, 12:00 giờ máy

/** Các điểm trên đường thẳng từ start theo hướng brg, cách nhau step (m), kể cả điểm đầu. */
function line(start, brg, length, step = 10) {
  const pts = [start];
  for (let d = step; d <= length + 1e-6; d += step) pts.push(destination(start, brg, d));
  return pts;
}

function way(id, pts, extra = {}) {
  return { id, n: '', h: 'primary', c: null, m: null, o: 0, g: pts.flat(), ...extra };
}

function roadsOf(ways, feats = [], restr = []) {
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(O)), { ways, points: [], feats, restr });
  return roads;
}

const feat = (id, coord, tags, onWay = true) => ({ id: `n${id}`, coord, onWay, tags });

/** Chạy thẳng từ `from` theo hướng brg, từ start tới end (m), mỗi lần định vị cách nhau dt (ms). */
function drive(roads, { from = O, brg = N, start = 0, end, speed = 15, dt = 1000, settings = {}, vehicle = 'car', now = NOON, engine = new SignEngine() }) {
  const log = [];
  let time = 1_000_000;
  for (let x = start; x <= end + 1e-6; x += (speed * dt) / 1000) {
    const fix = { coord: destination(from, brg, x), speed, heading: brg, accuracy: 5, time };
    log.push({ x, ...engine.update(fix, roads, settings, { vehicle, now }) });
    time += dt;
  }
  return log;
}

/** Chạy dọc một đường gấp khúc (có thể kèm dẫn đường theo chính đường đó). */
function driveLine(roads, coords, { speed = 15, settings = {}, vehicle = 'car', withNav = false, steps = [], from = 0, engine = new SignEngine() } = {}) {
  const cum = cumulativeDistances(coords);
  const route = { coords, cum, steps };
  const log = [];
  let time = 1_000_000;
  for (let s = from; s <= cum[cum.length - 1]; s += speed) {
    const p = pointAtDistance(coords, cum, s);
    const fix = { coord: p.point, speed, heading: p.bearing, accuracy: 5, time };
    const nav = withNav ? { route, seg: p.index, s } : null;
    log.push({ s, ...engine.update(fix, roads, settings, { vehicle, nav, now: NOON }) });
    time += 1000;
  }
  return log;
}

const spoken = (log) => log.filter((r) => r.say);

// Đường thẳng 1 km hướng Bắc, đỉnh mỗi 10 m (pts[k] cách gốc 10·k m), vẽ từ Nam lên Bắc.
const NORTH = line(O, N, 1000);
const at = (m) => NORTH[Math.round(m / 10)];
const straight = (feats, extra = {}) => roadsOf([way(1, NORTH, extra)], feats);
const SOUTHBOUND = { from: NORTH[NORTH.length - 1], brg: S };

// ------------------------------------------------------------------------------------------
// C3. Thời điểm đọc, thanh cảnh báo
// ------------------------------------------------------------------------------------------

test('đèn tín hiệu cách 400 m: đọc đúng một lần khi còn 100–200 m', () => {
  const roads = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  const log = drive(roads, { end: 600, speed: 15 });
  const said = spoken(log);
  assert.equal(said.length, 1);
  assert.match(said[0].say, /^Phía trước .+, đèn tín hiệu giao thông$/);
  const d = said[0].fired[0].distance;
  assert.ok(d >= 100 && d <= 200, `đọc ở ${d} m`);
  // 15 m/s: khoảng báo 120 m cộng một nhịp định vị (15 m) → đọc khi còn 130 m.
  assert.equal(Math.round(d), 130);
  assert.equal(said[0].say, 'Phía trước 150 mét, đèn tín hiệu giao thông');
  assert.equal(said[0].fired[0].code, 'W.209');
});

test('đi chậm, định vị mỗi giây: vẫn đọc khi còn ít nhất 100 m', () => {
  const roads = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  for (const speed of [5, 8, 12]) {
    const said = spoken(drive(roads, { end: 600, speed }));
    assert.equal(said.length, 1);
    const d = said[0].fired[0].distance;
    assert.ok(d >= 100 && d <= 115, `${speed} m/s: đọc ở ${d} m`);
  }
});

test('báo xa hơn khi chạy nhanh (tối đa 200 m)', () => {
  const roads = straight([feat(1, at(600), { highway: 'traffic_signals' })]);
  const fast = spoken(drive(roads, { end: 700, speed: 30 }));
  assert.equal(fast.length, 1);
  const d = fast[0].fired[0].distance;
  assert.ok(d > 170 && d <= 200, `đọc ở ${d} m`);
});

test('thanh cảnh báo: theo mục gần nhất đã báo, giữ reach, sang mục kế tiếp khi đã đi qua', () => {
  const roads = straight([
    feat(1, at(400), { highway: 'traffic_signals' }),
    feat(2, at(700), { traffic_calming: 'bump' }),
  ]);
  const log = drive(roads, { end: 800, speed: 20 }); // 20 m/s → báo trước 160 m (+ một nhịp 20 m)
  const keys = [];
  for (const r of log) {
    const k = r.active ? r.active.item.key : null;
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  assert.deepEqual(keys, [null, 'n1:signals', null, 'n2:calming', null]);
  const shown = log.filter((r) => r.active && r.active.item.key === 'n1:signals');
  assert.ok(shown.length >= 8, 'thanh phải hiện suốt lúc tiến lại gần');
  const reach = shown[0].active.reach;
  assert.equal(Math.round(reach), Math.round(shown[0].active.distance), 'reach = khoảng cách lúc đọc');
  assert.ok(reach >= 160 && reach <= 200);
  for (const r of shown) {
    assert.equal(r.active.reach, reach);
    assert.ok(r.active.distance >= 0 && r.active.distance <= reach);
    assert.equal(r.active.item.title, 'Đèn tín hiệu giao thông');
  }
  assert.ok(shown.at(-1).active.distance < 20, 'giữ tới khi xe đi qua');
  assert.equal(spoken(log).length, 2);
  assert.match(spoken(log)[1].say, /gờ giảm tốc$/);
});

test('upcoming: tối đa 3 mục trong 300 m, sắp theo khoảng cách, không trùng mã và trị số', () => {
  const roads = straight([
    feat(1, at(150), { highway: 'traffic_signals' }),
    feat(2, at(180), { highway: 'traffic_signals' }),
    feat(3, at(200), { traffic_calming: 'hump' }),
    feat(4, at(250), { traffic_sign: 'VN:P.127[50]' }),
    feat(5, at(290), { railway: 'level_crossing' }),
    feat(6, at(310), { traffic_sign: 'VN:W.225' }),
  ]);
  const r = new SignEngine().update({ coord: O, speed: 10, heading: N, accuracy: 5, time: 0 }, roads, {}, { now: NOON });
  assert.deepEqual(
    r.upcoming.map((u) => [u.code, u.value, Math.round(u.distance)]),
    [['W.209', null, 150], ['W.221b', null, 200], ['P.127', 50, 250]],
  );
  for (const u of r.upcoming) {
    for (const k of ['key', 'code', 'title', 'say', 'cat', 'distance', 'art', 'value', 'derived', 'note']) assert.ok(k in u, k);
  }
});

test('hai mục cách nhau dưới 40 m được đọc chung một câu, gần trước xa sau', () => {
  const roads = straight([
    feat(1, at(400), { highway: 'traffic_signals' }),
    feat(2, at(430), { traffic_calming: 'bump' }),
  ]);
  const said = spoken(drive(roads, { end: 600 }));
  assert.equal(said.length, 1);
  assert.equal(said[0].say, 'Phía trước 150 mét, đèn tín hiệu giao thông, gờ giảm tốc');
  assert.equal(said[0].fired.length, 2);
});

test('tối đa ba mục một câu; mục còn lại đọc ở lần sau', () => {
  const roads = straight([
    feat(1, at(400), { highway: 'traffic_signals' }),
    feat(2, at(410), { traffic_calming: 'bump' }),
    feat(3, at(420), { railway: 'level_crossing' }),
    feat(4, at(430), { traffic_sign: 'VN:W.225' }),
  ]);
  const said = spoken(drive(roads, { end: 600 }));
  assert.equal(said.length, 2);
  assert.equal(said[0].fired.length, 3);
  assert.match(said[1].say, /chú ý trẻ em$/);
  assert.ok(said[1].fired[0].distance >= 22.5, 'mục để lại vẫn được đọc khi chưa quá gần');
});

test('tối đa một câu mỗi 3 giây', () => {
  const roads = straight([
    feat(1, at(400), { highway: 'traffic_signals' }),
    feat(2, at(450), { traffic_calming: 'bump' }),
  ]);
  const engine = new SignEngine();
  const step = (x, time) => engine.update({ coord: at(x), speed: 15, heading: N, accuracy: 5, time }, roads, {}, { now: NOON });
  assert.match(step(290, 0).say, /đèn tín hiệu giao thông$/); // gờ còn 160 m: chưa tới lúc
  assert.equal(step(335, 1000).say, null); // gờ còn 115 m nhưng vừa đọc xong
  assert.equal(step(340, 2000).say, null);
  assert.match(step(345, 3000).say, /^Phía trước 100 mét, gờ giảm tốc$/);
});

test('đứng yên thì không đọc câu mới; chạy tiếp thì đọc', () => {
  const roads = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  const engine = new SignEngine();
  let time = 0;
  const step = (x, speed, heading = N) => {
    time += 1000;
    return engine.update({ coord: at(x), speed, heading, accuracy: 5, time }, roads, {}, { now: NOON });
  };
  for (let x = 100; x <= 200; x += 20) assert.equal(step(x, 20).say, null); // còn ≥ 200 m: chưa báo
  for (let i = 0; i < 5; i++) {
    const r = step(320, 0, null); // dừng chờ, GPS không có hướng
    assert.equal(r.say, null);
    assert.equal(r.active?.item.key, 'n1:signals', 'vẫn hiện khi đã vào khoảng báo');
  }
  assert.match(step(322, 4).say, /^Phía trước 80 mét, đèn tín hiệu giao thông$/);
});

test('mục thấy lần đầu đã ở trong khoảng báo: đọc ngay; quá gần: chỉ hiện, không đọc', () => {
  const roads = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  const inside = drive(roads, { start: 330, end: 420 });
  assert.equal(spoken(inside).length, 1);
  assert.match(inside[0].say, /^Phía trước 70 mét/);
  const tooClose = drive(roads, { start: 390, end: 420 });
  assert.equal(spoken(tooClose).length, 0);
  assert.equal(tooClose[0].active.item.key, 'n1:signals');
});

test('đèn ở hai phía giao lộ (cùng loại, cách nhau 60 m) chỉ đọc một lần', () => {
  const roads = straight([
    feat(1, at(400), { highway: 'traffic_signals' }),
    feat(2, at(460), { highway: 'traffic_signals' }),
  ]);
  const log = drive(roads, { end: 600 });
  assert.equal(spoken(log).length, 1);
  assert.ok(log.some((r) => r.active?.item.key === 'n2:signals'), 'đèn thứ hai vẫn hiện khi đã qua đèn đầu');

  // Đèn ghi ở hai phía của cùng một ngã tư (J − 20 m và J + 20 m): vẫn chỉ đọc một lần.
  const J = at(500);
  const cross = roadsOf(
    [way(1, NORTH), way(2, line(J, E, 300)), way(3, line(J, W, 300))],
    [feat(1, at(480), { highway: 'traffic_signals' }), feat(2, at(520), { highway: 'traffic_signals' })],
  );
  assert.equal(spoken(drive(cross, { end: 600 })).length, 1);
});

test('đèn và cấm rẽ của hai ngã tư khác nhau cách nhau 70 m: đọc cả hai', () => {
  const J1 = at(500);
  const J2 = at(570);
  const ways = [
    way(1, NORTH.slice(0, 51)), way(2, NORTH.slice(50, 58)), way(3, NORTH.slice(57)),
    way(4, line(J1, E, 300), { h: 'residential' }), way(5, line(J1, W, 300), { h: 'residential' }),
    way(6, line(J2, E, 300), { h: 'residential' }), way(7, line(J2, W, 300), { h: 'residential' }),
  ];
  const sig = roadsOf(ways, [feat(1, J1, { highway: 'traffic_signals' }), feat(2, J2, { highway: 'traffic_signals' })]);
  const said = spoken(driveLine(sig, NORTH, { speed: 12 }));
  assert.equal(said.length, 2, JSON.stringify(said.map((r) => r.say)));
  assert.deepEqual(said.map((r) => r.fired.map((f) => f.key)), [['n1:signals'], ['n2:signals']]);

  const bans = roadsOf(ways, [], [
    { id: 'r1', from: 1, to: 5, via: J1, tags: { type: 'restriction', restriction: 'no_left_turn' } },
    { id: 'r2', from: 2, to: 7, via: J2, tags: { type: 'restriction', restriction: 'no_left_turn' } },
  ]);
  const banSaid = spoken(driveLine(bans, NORTH, { speed: 12 }));
  assert.equal(banSaid.length, 2, JSON.stringify(banSaid.map((r) => r.say)));
  for (const r of banSaid) assert.match(r.say, /cấm rẽ trái$/);
});

test('quay đầu xe rồi đi lại qua đèn và gờ vừa báo: báo lại, thanh cảnh báo không hiện mục quá xa', () => {
  const roads = straight([feat(1, at(600), { highway: 'traffic_signals' }), feat(2, at(620), { traffic_calming: 'hump' })]);
  const engine = new SignEngine();
  let time = 0;
  const step = (x, brg) => {
    time += 1000;
    return engine.update({ coord: destination(O, N, x), speed: 12, heading: brg, accuracy: 5, time }, roads, {}, { now: NOON });
  };
  const north = [];
  for (let x = 300; x <= 820; x += 12) north.push(step(x, N));
  assert.equal(spoken(north).length, 1);
  assert.equal(spoken(north)[0].say, 'Phía trước 100 mét, đèn tín hiệu giao thông, gờ giảm tốc');
  // Quay đầu ở 820 m, chạy xuống phía Nam qua lại hai mục đó (cách chưa tới 500 m nên chưa bị quên).
  const south = [];
  for (let x = 816; x >= 450; x -= 12) south.push(step(x, S));
  const said = spoken(south);
  assert.equal(said.length, 1, 'phải báo lại khi đi theo chiều ngược lại');
  assert.match(said[0].say, /^Phía trước 100 mét, gờ giảm tốc, đèn tín hiệu giao thông$/);
  for (const r of south) {
    if (r.active) assert.ok(r.active.distance <= r.active.reach, `mục hiện ở ${r.active.distance} m, reach ${r.active.reach}`);
  }
  assert.equal(south[0].active, null, 'gờ còn 196 m: chưa tới khoảng báo');

  // Đèn riêng cho từng chiều cách nhau 40 m: đèn chiều về đã đọc không làm câm đèn chiều đi sau khi quay đầu.
  const split = straight([
    feat(1, at(600), { highway: 'traffic_signals', 'traffic_signals:direction': 'forward' }),
    feat(2, at(640), { highway: 'traffic_signals', 'traffic_signals:direction': 'backward' }),
  ]);
  const eng = new SignEngine();
  let t = 0;
  const go = (x, brg) => {
    t += 1000;
    return eng.update({ coord: destination(O, N, x), speed: 12, heading: brg, accuracy: 5, time: t }, split, {}, { now: NOON });
  };
  const up = [];
  for (let x = 300; x <= 820; x += 12) up.push(go(x, N));
  assert.deepEqual(spoken(up).map((r) => r.fired.map((f) => f.key)), [['n1:signals']]);
  const down = [];
  for (let x = 816; x >= 450; x -= 12) down.push(go(x, S));
  assert.deepEqual(spoken(down).map((r) => r.fired.map((f) => f.key)), [['n2:signals']]);
});

test('đi qua cua tay áo: đèn ở nhánh sau cua chỉ đọc một lần', () => {
  // Hướng đi tại đèn không đổi giữa lúc báo và lúc tới gần, dù hướng xe đã quay 180°.
  const r = 30;
  const a = line(O, N, 400);
  const center = destination(a[a.length - 1], E, r);
  const arc = [];
  for (let k = 1; k <= 18; k++) arc.push(destination(center, 270 + 10 * k, r));
  const back = line(arc[arc.length - 1], S, 400).slice(1);
  const coords = [...a, ...arc, ...back];
  const roads = roadsOf([way(1, coords)], [feat(1, back[4], { highway: 'traffic_signals' })]);
  const said = spoken(driveLine(roads, coords, { speed: 30 / 3.6 })).filter((r) => /đèn/.test(r.say));
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
});

test('tắt nhóm biển trong cài đặt thì không báo; vạch qua đường mặc định tắt', () => {
  const signals = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  const off = drive(signals, { end: 600, settings: { signSignals: false } });
  assert.equal(spoken(off).length, 0);
  assert.ok(off.every((r) => r.upcoming.length === 0 && !r.active));

  const crossing = straight([feat(1, at(400), { highway: 'crossing', crossing: 'zebra' })]);
  assert.equal(spoken(drive(crossing, { end: 600 })).length, 0);
  const on = spoken(drive(crossing, { end: 600, settings: { signCrossing: true } }));
  assert.equal(on.length, 1);
  assert.match(on[0].say, /vạch người đi bộ qua đường$/);
});

// ------------------------------------------------------------------------------------------
// C2. Hướng áp dụng, đường khác, biển dừng
// ------------------------------------------------------------------------------------------

test('hướng forward/backward theo chiều vẽ đường', () => {
  const fwd = straight([feat(1, at(400), { highway: 'traffic_signals', 'traffic_signals:direction': 'forward' })]);
  assert.equal(spoken(drive(fwd, { end: 600 })).length, 1);
  assert.equal(spoken(drive(fwd, { ...SOUTHBOUND, end: 900 })).length, 0);

  const back = straight([feat(1, at(400), { highway: 'traffic_signals', 'traffic_signals:direction': 'backward' })]);
  assert.equal(spoken(drive(back, { end: 600 })).length, 0);
  assert.equal(spoken(drive(back, { ...SOUTHBOUND, end: 900 })).length, 1);

  // traffic_sign:forward trên nút thuộc đường
  const tf = straight([feat(1, at(400), { 'traffic_sign:forward': 'VN:P.123a' })]);
  const said = spoken(drive(tf, { end: 600 }));
  assert.equal(said.length, 1);
  assert.match(said[0].say, /cấm rẽ trái$/);
  assert.equal(spoken(drive(tf, { ...SOUTHBOUND, end: 900 })).length, 0);
});

test('hướng bằng số độ: biển quay mặt về phía xe tới', () => {
  // direction=180: mặt biển quay về hướng Nam → dành cho xe chạy lên phía Bắc.
  const roads = straight([feat(1, destination(at(400), E, 5), { traffic_sign: 'VN:W.225', direction: '180' }, false)]);
  assert.equal(spoken(drive(roads, { end: 600 })).length, 1);
  assert.equal(spoken(drive(roads, { ...SOUTHBOUND, end: 900 })).length, 0);
});

test('biển hai mặt direction=0;180 đứng bên lề: áp dụng cho cả hai chiều', () => {
  const roads = straight([feat(1, destination(at(400), W, 6), { traffic_sign: 'VN:W.225', direction: '0;180' }, false)]);
  const north = spoken(drive(roads, { end: 600 }));
  assert.equal(north.length, 1);
  assert.match(north[0].say, /chú ý trẻ em$/);
  const south = spoken(drive(roads, { ...SOUTHBOUND, end: 900 }));
  assert.equal(south.length, 1);
  assert.match(south[0].say, /chú ý trẻ em$/);
});

test('biển đứng riêng không ghi hướng: chỉ nhận biển bên phải chiều đi', () => {
  const roads = straight([feat(1, destination(at(400), E, 6), { traffic_sign: 'VN:W.225' }, false)]);
  const north = spoken(drive(roads, { end: 600 }));
  assert.equal(north.length, 1);
  assert.match(north[0].say, /chú ý trẻ em$/);
  assert.equal(spoken(drive(roads, { ...SOUTHBOUND, end: 900 })).length, 0); // bên trái khi đi xuống phía Nam

  // Đường một chiều: biển bên trái vẫn áp dụng.
  const oneway = straight([feat(1, destination(at(400), W, 6), { traffic_sign: 'VN:W.225' }, false)], { o: 1 });
  assert.equal(spoken(drive(oneway, { end: 600 })).length, 1);
});

test('không báo nút của đường khác: đường chui dưới cầu, đường song song, biển của đường bên cạnh', () => {
  const c = at(425); // không phải đỉnh của đường 1
  const under = [destination(c, W, 200), destination(c, E, 3), destination(c, E, 200)];
  const parallel = line(destination(O, E, 6), N, 1000);
  const parallel2 = line(destination(O, E, 25), N, 1000);
  const roads = roadsOf(
    [way(1, NORTH), way(2, under, { h: 'residential' }), way(3, parallel, { h: 'service' }), way(4, parallel2)],
    [
      feat(1, under[1], { highway: 'traffic_signals' }), // đỉnh của đường chui, cách đường 1 chỉ 3 m
      feat(2, parallel[60], { traffic_calming: 'bump' }), // gờ trên đường song song cách 6 m
      feat(3, destination(at(700), E, 20), { traffic_sign: 'VN:W.225' }, false), // cách đường 4 chỉ 5 m
    ],
  );
  const log = drive(roads, { end: 900 });
  assert.equal(spoken(log).length, 0, JSON.stringify(spoken(log).map((r) => r.say)));
  assert.ok(log.every((r) => r.upcoming.length === 0));
});

test('biển dừng không ghi hướng chỉ áp dụng cho chiều đi về phía nút giao', () => {
  const J = at(500);
  const cross = way(2, [destination(J, W, 300), J, destination(J, E, 300)], { h: 'primary' });
  const minor = way(1, NORTH, { h: 'residential' });
  const roads = roadsOf([minor, cross], [feat(1, at(460), { highway: 'stop' })]);
  const north = spoken(drive(roads, { end: 480 }));
  assert.equal(north.length, 1);
  assert.match(north[0].say, /biển dừng lại, dừng hẳn xe$/);
  assert.equal(spoken(drive(roads, { ...SOUTHBOUND, end: 900 })).length, 0);
});

test('biển dừng ghi ngay tại nút giao thuộc về đường nhỏ hơn', () => {
  const J = at(500);
  const westEnd = destination(J, W, 400);
  const crossPts = [...line(westEnd, E, 400, 50).slice(0, -1), J, ...line(J, E, 400, 50).slice(1)];
  const roads = roadsOf(
    [way(1, NORTH, { h: 'residential' }), way(2, crossPts, { h: 'primary' })],
    [feat(1, J, { highway: 'stop' })],
  );
  assert.equal(spoken(drive(roads, { end: 520 })).length, 1); // đi trên đường nhỏ
  assert.equal(spoken(drive(roads, { from: westEnd, brg: E, end: 420 })).length, 0); // đi trên đường lớn
});

// ------------------------------------------------------------------------------------------
// Thay đổi khi sang đoạn đường khác
// ------------------------------------------------------------------------------------------

test('đổi giới hạn tốc độ ở chỗ nối hai đoạn đường (xe máy dùng giới hạn riêng)', () => {
  const K = at(500);
  const roads = roadsOf([
    way(1, NORTH.slice(0, 51), { c: 60, m: 50 }),
    way(2, line(K, N, 800), { c: 40, m: 50 }),
  ]);
  const car = spoken(drive(roads, { end: 600 }));
  assert.equal(car.length, 1);
  assert.equal(car[0].say, 'Phía trước 150 mét, tốc độ tối đa 40 ki lô mét trên giờ');
  const item = car[0].fired[0];
  assert.deepEqual([item.code, item.value, item.derived], ['P.127', 40, true]);
  assert.match(item.note, /OpenStreetMap/);
  assert.equal(spoken(drive(roads, { end: 600, vehicle: 'moto' })).length, 0);
});

test('biển tốc độ ngay chỗ đổi giới hạn: hai nguồn cùng một biển chỉ đọc một lần', () => {
  const K = at(500);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51), { c: 60 }), way(2, line(K, N, 800), { c: 40 })],
    [feat(1, K, { traffic_sign: 'VN:P.127[40]' })],
  );
  const said = spoken(drive(roads, { end: 600 }));
  assert.equal(said.length, 1);
  assert.equal(said[0].fired.length, 2);
  assert.equal(said[0].say.match(/tốc độ tối đa 40/g).length, 1, said[0].say);
});

test('không dẫn đường, sắp tới vòng xuyến: báo dù không đoán được lối ra', () => {
  const K = at(500);
  const center = destination(K, N, 30);
  const ring = [K];
  for (let k = 1; k < 36; k++) ring.push(destination(center, 180 - 10 * k, 30)); // ngược chiều kim đồng hồ
  ring.push(K);
  const roads = roadsOf([way(1, NORTH.slice(0, 51)), way(2, ring, { o: 1, h: 'secondary', t: { junction: 'roundabout' } })]);
  const said = spoken(drive(roads, { end: 480 }));
  assert.equal(said.length, 1);
  assert.match(said[0].say, /vòng xuyến$/);
  assert.equal(said[0].fired[0].code, 'W.206');
});

test('đường phía trước đi ngược chiều đường một chiều: báo cấm đi ngược chiều', () => {
  const K = at(500);
  const ahead = line(K, N, 500);
  const against = roadsOf([way(1, NORTH.slice(0, 51)), way(2, [...ahead].reverse(), { o: 1 })]);
  const said = spoken(drive(against, { end: 480 }));
  assert.equal(said.length, 1);
  assert.match(said[0].say, /đường cấm đi ngược chiều$/);
  assert.equal(said[0].fired[0].code, 'P.102');
  const corr = buildCorridor({ coord: at(300), speed: 15, heading: N, accuracy: 5 }, against);
  assert.deepEqual(corr.pieces.map((p) => [p.way.id, p.dir, p.assumed, p.against]), [[1, 1, false, false], [2, -1, true, true]]);

  const legal = roadsOf([way(1, NORTH.slice(0, 51)), way(2, ahead, { o: 1 })]);
  assert.equal(spoken(drive(legal, { end: 480 })).length, 0);
});

test('đường cấm đi ngược chiều phía trước: không báo biển, gờ, đèn nằm bên trong đường đó', () => {
  const K = at(500);
  const ahead = NORTH.slice(50);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, [...ahead].reverse(), { o: 1 }), way(3, line(K, E, 300)), way(4, line(K, W, 300))],
    [
      feat(1, at(505), { traffic_calming: 'hump' }), // 5 m bên trong đường cấm
      feat(2, at(550), { traffic_calming: 'hump' }),
      feat(3, at(640), { highway: 'traffic_signals' }),
    ],
  );
  const log = drive(roads, { end: 495, speed: 12 });
  const said = spoken(log);
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.match(said[0].say, /^Phía trước .+, đường cấm đi ngược chiều$/);
  const at380 = log.find((r) => r.x >= 380);
  assert.deepEqual(at380.upcoming.map((u) => u.code), ['P.102']);
  const corr = buildCorridor({ coord: at(400), speed: 12, heading: N, accuracy: 5 }, roads);
  assert.ok(corr.cum.at(-1) <= 101 + 1e-6, `hành lang dài ${corr.cum.at(-1)} m`);
  assert.deepEqual(corr.pieces.map((p) => [p.way.id, p.against]), [[1, false], [2, true]]);
});

test('chỗ tách thành hai làn một chiều: đi vào làn đúng chiều, không báo cấm đi ngược chiều', () => {
  const K = at(500);
  const left = line(K, 357, 400).reverse(); // làn chiều ngược lại: vẽ hướng về K
  const right = line(K, 12, 400); // làn của mình
  const roads = roadsOf([way(1, NORTH.slice(0, 51)), way(2, left, { o: 1 }), way(3, right, { o: 1 })]);
  assert.equal(spoken(drive(roads, { end: 480 })).length, 0);
  const corr = buildCorridor({ coord: at(300), speed: 15, heading: N, accuracy: 5 }, roads);
  assert.deepEqual(corr.pieces.map((p) => [p.way.id, p.against]), [[1, false], [3, false]]);
});

test('vào hầm và đường cấm ô tô: báo cho ô tô, xe máy chỉ nghe báo hầm', () => {
  const K = at(500);
  const roads = roadsOf([way(1, NORTH.slice(0, 51)), way(2, line(K, N, 500), { t: { tunnel: 'yes', motorcar: 'no' } })]);
  const car = spoken(drive(roads, { end: 480 }));
  assert.equal(car.length, 1);
  assert.equal(car[0].say, 'Phía trước 150 mét, sắp vào hầm, đường cấm ô tô');
  const moto = spoken(drive(roads, { end: 480, vehicle: 'moto' }));
  assert.equal(moto.length, 1);
  assert.equal(moto[0].say, 'Phía trước 150 mét, sắp vào hầm');
});

// ------------------------------------------------------------------------------------------
// Cấm rẽ
// ------------------------------------------------------------------------------------------

function junctionWithRestriction(tags) {
  const V = at(500);
  return roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, line(V, N, 500)), way(3, line(V, E, 300))],
    [],
    [{ id: 'r1', from: 1, to: 3, via: V, tags: { type: 'restriction', ...tags } }],
  );
}

test('cấm rẽ có except motorcycle: ô tô được báo, xe máy thì không', () => {
  const roads = junctionWithRestriction({ restriction: 'no_right_turn', except: 'bicycle;motorcycle' });
  const car = spoken(drive(roads, { end: 480 }));
  assert.equal(car.length, 1);
  assert.equal(car[0].say, 'Phía trước 150 mét, cấm rẽ phải');
  assert.equal(car[0].fired[0].code, 'P.123b');
  assert.equal(spoken(drive(roads, { end: 480, vehicle: 'moto' })).length, 0);
  // Đi ngược lại (rời khỏi nút "via") thì không báo.
  assert.equal(spoken(drive(roads, { from: at(500), brg: S, end: 400 })).length, 0);
});

test('thẻ OSM trùng tên thuộc tính của Object (hazard=constructor, restriction=__proto__): không lỗi, biển khác vẫn được báo', () => {
  const V = at(500);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, line(V, N, 500)), way(3, line(V, E, 300)), way(4, line(V, W, 300))],
    [feat(1, at(200), { hazard: 'constructor' }), feat(2, at(300), { hazard: '__proto__' }), feat(3, V, { highway: 'traffic_signals' })],
    [
      { id: 'r1', from: 1, to: 3, via: V, tags: { type: 'restriction', restriction: 'constructor' } },
      { id: 'r2', from: 1, to: 4, via: V, tags: { type: 'restriction', restriction: '__proto__', 'restriction:conditional': 'constructor @ (Mo-Fr 06:00-09:00)' } },
      { id: 'r3', from: 1, to: 2, via: V, tags: { type: 'restriction', restriction: 'only_constructor' } },
    ],
  );
  let log;
  assert.doesNotThrow(() => (log = drive(roads, { end: 480 })));
  const says = spoken(log).map((r) => r.say);
  assert.ok(says.some((s) => /nguy hiểm/.test(s)), JSON.stringify(says));
  assert.ok(says.some((s) => /đèn tín hiệu giao thông/.test(s)), JSON.stringify(says));
  assert.ok(!says.some((s) => /cấm rẽ|chỉ được/.test(s)), JSON.stringify(says));
});

test('cấm rẽ theo giờ: trong giờ thì báo, ngoài giờ thì không, giờ không đọc được thì báo kèm "theo giờ"', () => {
  const tags = { 'restriction:conditional': 'no_left_turn @ (Mo-Fr 06:00-09:00)' };
  const roads = junctionWithRestriction(tags);
  const monday730 = new Date(2026, 10, 23, 7, 30);
  const inHours = spoken(drive(roads, { end: 480, now: monday730 }));
  assert.equal(inHours.length, 1);
  assert.match(inHours[0].say, /cấm rẽ trái$/);
  assert.equal(spoken(drive(roads, { end: 480, now: NOON })).length, 0);
  assert.equal(spoken(drive(roads, { end: 480, now: new Date(2026, 10, 22, 7, 30) })).length, 0); // Chủ nhật

  const unknown = junctionWithRestriction({ 'restriction:conditional': 'no_left_turn @ (sunrise-sunset)' });
  const timed = spoken(drive(unknown, { end: 480 }));
  assert.equal(timed.length, 1);
  assert.match(timed[0].say, /cấm rẽ trái theo giờ$/);

  // Điều kiện không phải giờ (tải trọng): không áp dụng cho ô tô con.
  const weight = junctionWithRestriction({ 'restriction:conditional': 'no_left_turn @ (weight>5)' });
  assert.equal(spoken(drive(weight, { end: 480 })).length, 0);
});

test('nhiều lệnh cấm ở cùng một nút được gộp thành một biển', () => {
  const V = at(500);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, line(V, N, 500)), way(3, line(V, E, 300)), way(4, line(V, W, 300))],
    [],
    [
      { id: 'r1', from: 1, to: 3, via: V, tags: { type: 'restriction', restriction: 'no_right_turn' } },
      { id: 'r2', from: 1, to: 4, via: V, tags: { type: 'restriction', restriction: 'no_left_turn' } },
      { id: 'r3', from: 1, to: 2, via: V, tags: { type: 'restriction', restriction: 'no_entry' } },
    ],
  );
  const said = spoken(drive(roads, { end: 480 }));
  assert.equal(said.length, 1);
  assert.equal(said[0].fired.length, 1);
  assert.equal(said[0].fired[0].code, 'P.137');
});

test('timeRangesActive: khung giờ, ngày trong tuần, qua nửa đêm, không đọc được', () => {
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // 22 = Chủ nhật, 23 = thứ Hai, 28 = thứ Bảy
  assert.equal(timeRangesActive('06:00-09:00', at(23, 7, 30)), true);
  assert.equal(timeRangesActive('06:00-09:00', at(23, 9, 0)), false);
  assert.equal(timeRangesActive('06:00-09:00', at(23, 5, 59)), false);
  assert.equal(timeRangesActive('(7:00-9:00)', at(23, 8)), true);
  assert.equal(timeRangesActive('Mo-Fr 06:00-09:00', at(23, 7)), true);
  assert.equal(timeRangesActive('Mo-Fr 06:00-09:00', at(22, 7)), false);
  assert.equal(timeRangesActive('Mo-Fr 06:00-09:00,16:00-19:00', at(24, 17)), true);
  assert.equal(timeRangesActive('06:00-09:00; 16:00-19:00', at(24, 17)), true);
  assert.equal(timeRangesActive('06:00-09:00; 16:00-19:00', at(24, 12)), false);
  assert.equal(timeRangesActive('Mo-Fr 06:00-09:00, Sa 07:00-11:00', at(28, 8)), true);
  assert.equal(timeRangesActive('Mo-Fr 06:00-09:00, Sa 07:00-11:00', at(28, 12)), false);
  assert.equal(timeRangesActive('Sa,Su 08:00-10:00', at(22, 9)), true);
  assert.equal(timeRangesActive('22:00-05:00', at(23, 23)), true);
  assert.equal(timeRangesActive('22:00-05:00', at(23, 4)), true);
  assert.equal(timeRangesActive('22:00-05:00', at(23, 6)), false);
  assert.equal(timeRangesActive('Fr 22:00-05:00', at(28, 4)), true); // rạng sáng thứ Bảy
  assert.equal(timeRangesActive('Fr 22:00-05:00', at(22, 4)), false);
  for (const bad of ['sunrise-sunset', 'PH off', 'abc', '25:00-26:00', '07:00-07:00', '', null]) {
    assert.equal(timeRangesActive(bad, at(23, 8)), null, String(bad));
  }
});

// ------------------------------------------------------------------------------------------
// Chỗ ngoặt
// ------------------------------------------------------------------------------------------

/** Đường thẳng 400 m lên phía Bắc, cung tròn bán kính r quay 90° (phải: sang Đông, trái: sang Tây), rồi 400 m. */
function bend(r = 60, side = 'right') {
  const a = line(O, N, 400);
  const P = a[a.length - 1];
  const right = side === 'right';
  const center = destination(P, right ? E : W, r);
  const arc = [];
  for (let k = 1; k <= 9; k++) arc.push(destination(center, right ? 270 + 10 * k : 90 - 10 * k, r));
  return [...a, ...arc, ...line(arc[arc.length - 1], right ? E : W, 400).slice(1)];
}

test('detectCurves: cung bán kính ~60 m báo ở 60 km/h, không báo ở 20 km/h; đường thẳng không bao giờ', () => {
  const coords = bend(60);
  const cum = cumulativeDistances(coords);
  const fast = detectCurves(coords, cum, 60 / 3.6);
  assert.equal(fast.length, 1);
  assert.equal(fast[0].kind, 'curve');
  assert.equal(fast[0].side, 'right');
  assert.ok(fast[0].radius > 50 && fast[0].radius < 70, `bán kính ${fast[0].radius}`);
  assert.ok(Math.abs(fast[0].s - 400) <= 15, `vị trí ${fast[0].s}`);
  assert.equal(detectCurves(coords, cum, 20 / 3.6).length, 0);
  const left = bend(60, 'left');
  assert.equal(detectCurves(left, cumulativeDistances(left), 60 / 3.6)[0].side, 'left');
  const flat = line(O, N, 1000);
  assert.equal(detectCurves(flat, cumulativeDistances(flat), 100 / 3.6).length, 0);
});

test('detectCurves: hai chỗ ngoặt ngược phía gần nhau thành "nhiều chỗ ngoặt"', () => {
  const r = 50;
  const a = line(O, N, 300);
  const P = a[a.length - 1];
  const c1 = destination(P, E, r);
  const arc1 = [];
  for (let k = 1; k <= 9; k++) arc1.push(destination(c1, 270 + 10 * k, r)); // rẽ phải sang hướng Đông
  const Q = arc1[arc1.length - 1];
  const mid = line(Q, E, 60).slice(1);
  const R0 = mid[mid.length - 1];
  const c2 = destination(R0, N, r);
  const arc2 = [];
  for (let k = 1; k <= 9; k++) arc2.push(destination(c2, 180 - 10 * k, r)); // rẽ trái lên hướng Bắc
  const coords = [...a, ...arc1, ...mid, ...arc2, ...line(arc2[arc2.length - 1], N, 300).slice(1)];
  const found = detectCurves(coords, cumulativeDistances(coords), 50 / 3.6);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'curves');
});

/** Đường thẳng 400 m lên phía Bắc, cung tròn bán kính r quay `turn` độ sang phải (đỉnh cách nhau ~5 m), rồi 400 m. */
function wideBend(r, turn = 90) {
  const a = line(O, N, 400);
  const P = a[a.length - 1];
  const center = destination(P, E, r);
  const n = Math.ceil((r * turn * Math.PI) / 180 / 5);
  const arc = [];
  for (let k = 1; k <= n; k++) arc.push(destination(center, 270 + (turn * k) / n, r));
  return [...a, ...arc, ...line(arc[arc.length - 1], turn % 360, 400).slice(1)];
}

test('detectCurves: cua rộng tới bán kính 120 m vẫn được nhận khi chạy nhanh; rộng hơn thì không', () => {
  // Trước đây cửa sổ chỉ 90 m nên cung bán kính trên ~83 m không bao giờ đủ 55°, kể cả ở 100 km/h.
  for (const r of [85, 100, 120]) {
    const coords = wideBend(r);
    const found = detectCurves(coords, cumulativeDistances(coords), 90 / 3.6);
    assert.equal(found.length, 1, `R=${r}`);
    assert.equal(found[0].side, 'right');
    assert.ok(Math.abs(found[0].radius - r) <= 10, `R=${r}: bán kính ${found[0].radius}`);
  }
  const hairpin = wideBend(100, 180);
  assert.equal(detectCurves(hairpin, cumulativeDistances(hairpin), 90 / 3.6).length, 1, 'cua tay áo R=100');
  const wide = wideBend(140);
  assert.equal(detectCurves(wide, cumulativeDistances(wide), 90 / 3.6).length, 0, 'R=140 vượt ngưỡng 120 m');
  // Cung R=100 ở 30 km/h: v²/R ≈ 0,7 m/s² < 1,5 → không báo.
  const slow = wideBend(100);
  assert.equal(detectCurves(slow, cumulativeDistances(slow), 30 / 3.6).length, 0);
});

test('cua bán kính 100 m ở 90 km/h: đọc đúng một lần', () => {
  const coords = wideBend(100);
  const said = spoken(driveLine(roadsOf([way(1, coords)]), coords, { speed: 90 / 3.6 }));
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.match(said[0].say, /chỗ ngoặt nguy hiểm vòng bên phải$/);
  const d = said[0].fired[0].distance;
  assert.ok(d >= 100 && d <= 200, `đọc ở ${d} m`);
});

test('góc phố: đường gấp ngay tại nút giao không phải chỗ ngoặt; cùng hình dạng không có đường khác thì vẫn báo', () => {
  // Đường 1 chạy lên phía Bắc rồi gấp 90° sang Đông ở J; đường 2 (đi tiếp lên Bắc) và đường 3 (sang Tây) cũng
  // bắt đầu ở J, nên J là ngã tư.
  const a = line(O, N, 400);
  const J = a[a.length - 1];
  const coords = [...a, ...line(J, E, 400).slice(1)];
  const corner = roadsOf([way(1, coords), way(2, line(J, N, 300)), way(3, line(J, W, 300))]);
  for (const kmh of [35, 45]) {
    const said = spoken(driveLine(corner, coords, { speed: kmh / 3.6 }));
    assert.equal(said.length, 0, `${kmh} km/h: ${JSON.stringify(said.map((r) => r.say))}`);
  }
  const bendOnly = spoken(driveLine(roadsOf([way(1, coords)]), coords, { speed: 45 / 3.6 }));
  assert.equal(bendOnly.length, 1);
  assert.match(bendOnly[0].say, /chỗ ngoặt nguy hiểm vòng bên phải$/);

  // Góc phố bo tròn bán kính 12 m, nút giao nằm giữa cung.
  const r = 12;
  const b = line(O, N, 400 - r);
  const P = b[b.length - 1];
  const c = destination(P, E, r);
  const arc = [];
  for (let k = 1; k <= 8; k++) arc.push(destination(c, 270 + 10 * k, r));
  const T = destination(c, N, r);
  const rounded = [...b, ...arc, T, ...line(T, E, 400).slice(1)];
  const mid = arc[4];
  const roads = roadsOf([way(1, rounded), way(2, line(mid, N, 300)), way(3, line(mid, W, 300))]);
  assert.equal(spoken(driveLine(roads, rounded, { speed: 40 / 3.6 })).length, 0);
});

test('cua tay áo có đường nhánh ở đỉnh cua vẫn được báo (chỉ bỏ góc đổi hướng sát nút giao)', () => {
  const r = 25;
  const a = line(O, N, 400);
  const center = destination(a[a.length - 1], E, r);
  const arc = [];
  for (let k = 1; k <= 18; k++) arc.push(destination(center, 270 + 10 * k, r)); // quay 180° sang phải
  const apex = arc[8];
  const coords = [...a, ...arc, ...line(arc[arc.length - 1], S, 400).slice(1)];
  const roads = roadsOf([way(1, coords), way(2, line(apex, N, 200))]);
  const said = spoken(driveLine(roads, coords, { speed: 40 / 3.6 }));
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.match(said[0].say, /chỗ ngoặt nguy hiểm vòng bên phải$/);
});

test('chỗ ngoặt phía trước được đọc đúng một lần khi chạy nhanh, không đọc khi chạy chậm', () => {
  const coords = bend(60);
  const roads = roadsOf([way(1, coords)]);
  const fast = spoken(driveLine(roads, coords, { speed: 60 / 3.6 }));
  assert.equal(fast.length, 1);
  assert.match(fast[0].say, /chỗ ngoặt nguy hiểm vòng bên phải$/);
  assert.equal(fast[0].fired[0].code, 'W.201b');
  assert.equal(spoken(driveLine(roads, coords, { speed: 20 / 3.6 })).length, 0);
  assert.equal(spoken(driveLine(roads, coords, { speed: 60 / 3.6, settings: { signDanger: false } })).length, 0);
});

// ------------------------------------------------------------------------------------------
// C1. Hành lang
// ------------------------------------------------------------------------------------------

test('hành lang tự do: đi tiếp qua chỗ nối đường, dừng ở ngã ba không rõ hướng', () => {
  const K = at(200);
  const fix = { coord: O, speed: 15, heading: N, accuracy: 5 };
  const split = roadsOf([way(1, NORTH.slice(0, 21)), way(2, line(K, N, 800))]);
  const c = buildCorridor(fix, split);
  assert.equal(Math.round(c.cum[c.cum.length - 1]), 320);
  assert.deepEqual(c.pieces.map((p) => [p.way.id, p.dir, Math.round(p.s0), Math.round(p.s1), p.assumed]), [
    [1, 1, 0, 200, false],
    [2, 1, 200, 320, true],
  ]);

  // Hai nhánh lệch ±10°: không đoán.
  const fork = roadsOf([way(1, NORTH.slice(0, 21)), way(2, line(K, 10, 500)), way(3, line(K, 350, 500))]);
  assert.equal(Math.round(buildCorridor(fix, fork).cum.at(-1)), 200);
  // … trừ khi đúng một nhánh mang cùng tên đường.
  const named = roadsOf([way(1, NORTH.slice(0, 21), { n: 'Lê Lợi' }), way(2, line(K, 10, 500), { n: 'Lê Lợi' }), way(3, line(K, 350, 500))]);
  assert.deepEqual(buildCorridor(fix, named).pieces.map((p) => p.way.id), [1, 2]);
  // Ngã ba chữ T: dừng.
  const tee = roadsOf([way(1, NORTH.slice(0, 21)), way(2, [destination(K, W, 300), K, destination(K, E, 300)])]);
  assert.equal(Math.round(buildCorridor(fix, tee).cum.at(-1)), 200);
  // Đứng yên và chưa biết chiều đi: không có hành lang.
  assert.equal(buildCorridor({ ...fix, speed: 0 }, split).coords.length, 0);
});

test('dẫn đường: hành lang theo tuyến, thấy biển sau chỗ rẽ; không coi chỗ rẽ là chỗ ngoặt', () => {
  const K = at(500);
  const east = line(K, E, 500);
  const roads = roadsOf(
    [way(1, NORTH), way(2, east)],
    [feat(1, east[15], { highway: 'traffic_signals' })], // trên đường rẽ vào, cách chỗ rẽ 150 m
  );
  const coords = [...NORTH.slice(0, 51), ...east.slice(1)];
  const cum = cumulativeDistances(coords);
  const steps = [{ index: 0, type: 'depart' }, { index: 50, type: 'turn' }, { index: coords.length - 1, type: 'arrive' }];
  const route = { coords, cum, steps };
  const fix = { coord: at(400), speed: 15, heading: N, accuracy: 5, time: 0 };

  const corr = buildCorridor(fix, roads, { route, seg: 40, s: 400 });
  assert.deepEqual(corr.pieces.map((p) => [p.way.id, p.dir, Math.round(p.s0), Math.round(p.s1)]), [
    [1, 1, 0, 100],
    [2, 1, 100, 320],
  ]);
  const withNav = new SignEngine().update(fix, roads, {}, { nav: { route, seg: 40, s: 400 }, now: NOON });
  assert.equal(withNav.upcoming.length, 1);
  assert.equal(Math.round(withNav.upcoming[0].distance), 250);
  const free = new SignEngine().update(fix, roads, {}, { now: NOON });
  assert.equal(free.upcoming.length, 0, 'không dẫn đường thì đoán đi thẳng, không thấy biển trên đường rẽ');

  const log = driveLine(roads, coords, { speed: 60 / 3.6, withNav: true, steps });
  const said = spoken(log);
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.match(said[0].say, /đèn tín hiệu giao thông$/);
});

test('dẫn đường: đoạn đường ngắn hơn 20 m vẫn được khớp (hạn chế chiều cao, cấm rẽ từ đoạn nối ngắn)', () => {
  const all = line(O, N, 800, 1); // đỉnh mỗi 1 m để cắt đường ở bất kỳ đâu
  const steps = [{ index: 0, type: 'depart' }, { index: all.length - 1, type: 'arrive' }];
  // Đoạn 13 m chui dưới cầu đường sắt, đặt lệch đủ mọi kiểu so với lưới mẫu 20 m của tuyến.
  for (let off = 0; off < 20; off++) {
    const a = 500 + off;
    const b = a + 13;
    const roads = roadsOf([way(1, all.slice(0, a + 1)), way(2, all.slice(a, b + 1), { t: { maxheight: '2.5' } }), way(3, all.slice(b))]);
    const said = spoken(driveLine(roads, all, { speed: 12, withNav: true, steps, from: 300 }));
    assert.equal(said.length, 1, `lệch ${off} m: ${JSON.stringify(said.map((r) => r.say))}`);
    assert.match(said[0].say, /hạn chế chiều cao 2,5 mét$/);
  }
  // Cấm rẽ trái từ đoạn 14 m nằm giữa hai làn của đường cắt ngang.
  const V = all[719];
  const roads = roadsOf(
    [way(1, all.slice(0, 706)), way(2, all.slice(705, 720)), way(3, all.slice(719)), way(4, line(V, W, 300)), way(5, line(V, E, 300))],
    [],
    [{ id: 'r1', from: 2, to: 4, via: V, tags: { type: 'restriction', restriction: 'no_left_turn' } }],
  );
  const said = spoken(driveLine(roads, all, { speed: 12, withNav: true, steps, from: 450 }));
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.match(said[0].say, /cấm rẽ trái$/);
});

test('mất khớp đường một lúc: giữ thanh cảnh báo vài giây rồi bỏ', () => {
  const roads = straight([feat(1, at(400), { highway: 'traffic_signals' })]);
  const engine = new SignEngine();
  const r1 = engine.update({ coord: at(310), speed: 10, heading: N, accuracy: 5, time: 0 }, roads, {}, { now: NOON });
  assert.equal(r1.active.item.key, 'n1:signals');
  assert.equal(Math.round(r1.active.distance), 90);
  const lost = { coord: destination(at(310), E, 200), speed: 10, heading: N, accuracy: 5 }; // cách đường 200 m
  const r2 = engine.update({ ...lost, time: 1000 }, roads, {}, { now: NOON });
  assert.equal(r2.active.item.key, 'n1:signals');
  assert.equal(Math.round(r2.active.distance), 80);
  assert.equal(r2.say, null);
  assert.equal(engine.update({ ...lost, time: 7000 }, roads, {}, { now: NOON }).active, null);
});
