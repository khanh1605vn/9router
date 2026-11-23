import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCorridor, detectCurves, SignEngine, timeRangesActive } from '../js/signengine.js';
import { cellKey, cellOf, parseOverpass, RoadData } from '../js/roaddata.js';
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

// ------------------------------------------------------------------------------------------
// Xe máy trên phố một chiều với ô tô nhưng xe máy được đi hai chiều (oneway:motorcycle=no)
// ------------------------------------------------------------------------------------------

/** Phản hồi theo cấu trúc Overpass: phố 1 (hai chiều) chạy lên phía Bắc tới K = 500 m, nối vào phố 2 vẽ từ Bắc
 * xuống K, một chiều với ô tô (vẽ ngược hướng xe đi lên), xe máy và xe gắn máy được đi hai chiều. */
function motoContraflow() {
  const geom = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
  const data = parseOverpass({
    elements: [
      { type: 'way', id: 1, geometry: geom(NORTH.slice(0, 51)), tags: { highway: 'residential' } },
      {
        type: 'way',
        id: 2,
        geometry: geom([...NORTH.slice(50)].reverse()),
        tags: { highway: 'residential', maxspeed: '30', oneway: 'yes', 'oneway:motorcycle': 'no', 'oneway:moped': 'no' },
      },
    ],
  });
  return roadsOf(data.ways, [feat(1, at(700), { highway: 'traffic_signals' })]); // đèn 200 m bên trong phố 2
}

test('phố một chiều với ô tô, xe máy đi hai chiều (oneway:motorcycle=no): xe máy không nghe "cấm đi ngược chiều", vẫn được báo tốc độ và đèn trong phố', () => {
  const roads = motoContraflow();
  const car = spoken(drive(roads, { end: 480 }));
  assert.deepEqual(car.map((r) => r.fired.map((f) => f.code)), [['P.102']], 'ô tô vẫn được báo cấm đi ngược chiều');

  const moto = spoken(drive(roads, { end: 900, vehicle: 'moto' }));
  const says = moto.map((r) => r.say);
  assert.ok(!says.some((x) => /ngược chiều/.test(x)), JSON.stringify(says));
  assert.deepEqual(moto.map((r) => r.fired.map((f) => f.code)), [['P.127'], ['W.209']], JSON.stringify(says));
  assert.match(says[0], /tốc độ tối đa 30 ki lô mét trên giờ$/);
  assert.match(says[1], /^Phía trước .+, đèn tín hiệu giao thông$/);
  const d = moto[1].fired[0].distance;
  assert.ok(d >= 100 && d <= 200, `đọc ở ${d} m`);

  const fix = { coord: at(300), speed: 15, heading: N, accuracy: 5 };
  const pieces = (vehicle) => buildCorridor(fix, roads, null, { vehicle }).pieces.map((p) => [p.way.id, p.dir, p.against]);
  assert.deepEqual(pieces('moto'), [[1, 1, false], [2, -1, false]]);
  assert.deepEqual(pieces('car'), [[1, 1, false], [2, -1, true]]);
});

test('dẫn đường cho xe máy qua phố ngược chiều được phép: hành lang khớp đúng phố đó, không báo cấm đi ngược chiều', () => {
  const roads = motoContraflow();
  const steps = [{ index: 0, type: 'depart' }, { index: NORTH.length - 1, type: 'arrive' }];
  const route = { coords: NORTH, cum: cumulativeDistances(NORTH), steps };
  const fix = { coord: at(400), speed: 10, heading: N, accuracy: 5, time: 0 };
  const corr = buildCorridor(fix, roads, { route, seg: 40, s: 400 }, { vehicle: 'moto' });
  assert.deepEqual(corr.pieces.map((p) => [p.way?.id ?? null, p.dir, p.against]), [[1, 1, false], [2, -1, false]]);
  const said = spoken(driveLine(roads, NORTH, { speed: 10, vehicle: 'moto', withNav: true, steps, from: 300 }));
  assert.deepEqual(said.map((r) => r.fired.map((f) => f.code)), [['P.127'], ['W.209']], JSON.stringify(said.map((r) => r.say)));
});

test('biển đứng riêng không ghi hướng trên phố một chiều: xe đi theo chiều chính nhận cả biển bên trái; xe máy đi ngược chiều được phép không nhận biển của dòng xe kia', () => {
  const left = straight([feat(1, destination(at(400), W, 6), { traffic_sign: 'VN:W.225' }, false)], { o: 1, om: 0 });
  assert.equal(spoken(drive(left, { end: 600, vehicle: 'moto' })).length, 1, 'xe máy đi theo chiều chính');
  assert.equal(spoken(drive(left, { ...SOUTHBOUND, end: 900, vehicle: 'moto' })).length, 0);
  const right = straight([feat(1, destination(at(400), E, 6), { traffic_sign: 'VN:W.225' }, false)], { o: 1, om: 0 });
  assert.equal(spoken(drive(right, { ...SOUTHBOUND, end: 900, vehicle: 'moto' })).length, 0);
  // Nút nằm trên đường (gờ giảm tốc) thì áp dụng cho mọi chiều được đi.
  const hump = straight([feat(1, at(400), { traffic_calming: 'hump' })], { o: 1, om: 0 });
  const said = spoken(drive(hump, { ...SOUTHBOUND, end: 900, vehicle: 'moto' }));
  assert.equal(said.length, 1);
  assert.match(said[0].say, /gờ giảm tốc$/);
});

// ------------------------------------------------------------------------------------------
// Hành lang tự do: không nhảy sang đường song song vì một lần định vị lệch
// ------------------------------------------------------------------------------------------

/** Đường trên cao (1, một chiều, không có đèn) và đường bên dưới cách 12 m về phía Đông (2, có đèn ở 800 m). */
function elevated(signalAt = 800) {
  const elev = line(O, N, 1500);
  const surf = line(destination(O, E, 12), N, 1500);
  return roadsOf(
    [way(1, elev, { o: 1, h: 'trunk' }), way(2, surf, { o: 1 })],
    [feat(1, surf[signalAt / 10], { highway: 'traffic_signals' })],
  );
}

/** Chạy lên phía Bắc mỗi 20 m; lateral(x) là độ lệch về phía Đông (m) của lần định vị ở x. */
function driveLateral(roads, lateral, { end = 900, engine = new SignEngine(), start = 0 } = {}) {
  const log = [];
  let time = 1_000_000;
  for (let x = start; x <= end; x += 20) {
    const coord = destination(destination(O, N, x), E, lateral(x));
    log.push({ x, ...engine.update({ coord, speed: 20, heading: N, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON }) });
  }
  return log;
}

test('không dẫn đường: một lần định vị lệch về phía đường song song (đường trên cao, đường bên dưới) không làm báo biển của đường đó', () => {
  const roads = elevated();
  for (const bad of [600, 680]) {
    for (const off of [7, 11]) {
      const log = driveLateral(roads, (x) => (x === bad ? off : 0));
      assert.equal(spoken(log).length, 0, `lệch ${off} m ở ${bad} m: ${JSON.stringify(spoken(log).map((r) => r.say))}`);
      assert.ok(log.every((r) => !r.active && r.upcoming.length === 0), `lệch ${off} m ở ${bad} m`);
    }
  }
});

test('xe thật sự sang đường song song (dữ liệu không có đường nối): hành lang theo đường mới từ lần định vị thứ hai', () => {
  const roads = elevated(1200);
  const log = driveLateral(roads, (x) => (x >= 1000 ? 12 : 0), { end: 1100 });
  const row = (x) => log.find((r) => r.x === x);
  assert.equal(row(1000).upcoming.length, 0, 'lần đầu khớp đường kia: chưa chuyển');
  assert.deepEqual(row(1020).upcoming.map((u) => u.key), ['n1:signals'], 'lần thứ hai: đã chuyển');
  assert.equal(spoken(log).length, 1);
  assert.match(spoken(log)[0].say, /đèn tín hiệu giao thông$/);
});

test('rẽ sang đường nối với đường cũ (ngã ba chếch 25°, rẽ phải ở ngã tư): hành lang chuyển ngay, như khi không nhớ đường cũ', () => {
  const J = at(500);
  const fork = line(J, 25, 500);
  const east = line(J, E, 500);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, line(J, N, 500)), way(3, fork), way(4, east), way(5, line(J, W, 300))],
    [
      feat(1, fork[15], { highway: 'traffic_signals' }),
      feat(2, at(650), { traffic_calming: 'hump' }),
      feat(3, east[15], { traffic_calming: 'bump' }),
    ],
  );
  for (const [branch, brg] of [[fork, 25], [east, E]]) {
    const path = [...NORTH.slice(0, 50).map((p) => [p, N]), ...branch.map((p) => [p, brg])];
    const engine = new SignEngine();
    let time = 1_000_000;
    for (let k = 30; k < path.length; k += 2) {
      const fix = { coord: path[k][0], speed: 15, heading: path[k][1], accuracy: 5, time: (time += 1000) };
      const keys = (r) => r.upcoming.map((u) => u.key);
      const fresh = new SignEngine().update(fix, roads, {}, { now: NOON });
      assert.deepEqual(keys(engine.update(fix, roads, {}, { now: NOON })), keys(fresh), `hướng ${brg}°, điểm ${k}`);
    }
  }
});

test('reset(): quên đường và chiều đi đã nhớ của chuyến trước', () => {
  const roads = elevated();
  const engine = new SignEngine();
  driveLateral(roads, () => 0, { end: 600, engine });
  const onSurface = { coord: destination(destination(O, N, 640), E, 11), speed: 20, heading: N, accuracy: 5, time: 2_000_000 };
  engine.reset();
  assert.deepEqual(engine.update(onSurface, roads, {}, { now: NOON }).upcoming.map((u) => u.key), ['n1:signals']);

  const stopped = { coord: at(300), speed: 0, heading: null, accuracy: 5 };
  const straightRoad = straight([feat(1, at(480), { highway: 'traffic_signals' })]);
  const eng = new SignEngine();
  drive(straightRoad, { end: 300, speed: 10, engine: eng });
  assert.equal(eng.update({ ...stopped, time: 1_100_000 }, straightRoad, {}, { now: NOON }).upcoming.length, 1, 'dừng: vẫn nhớ chiều đi');
  eng.reset();
  const r = eng.update({ ...stopped, time: 1_101_000 }, straightRoad, {}, { now: NOON });
  assert.deepEqual([r.active, r.upcoming.length], [null, 0]);
});

// ------------------------------------------------------------------------------------------
// Đi chậm, dừng đèn đỏ: giữ chiều đi qua chỗ nối đoạn đường
// ------------------------------------------------------------------------------------------

test('đi chậm (dưới 9 km/h) qua chỗ nối hai đoạn đường: vẫn báo đèn phía trước', () => {
  const roads = roadsOf([way(1, NORTH.slice(0, 31), { n: 'X' }), way(2, NORTH.slice(30), { n: 'X' })], [feat(1, at(480), { highway: 'traffic_signals' })]);
  const engine = new SignEngine();
  const log = [];
  let time = 1_000_000;
  for (let x = 0; x <= 470; ) {
    const speed = x < 250 ? 8 : 2.2;
    log.push({ x, ...engine.update({ coord: destination(O, N, x), speed, heading: N, accuracy: 5, time }, roads, {}, { now: NOON }) });
    time += 1000;
    x += speed;
  }
  const said = spoken(log);
  assert.equal(said.length, 1, JSON.stringify(said.map((r) => r.say)));
  assert.ok(said[0].x > 300, 'đọc khi đã sang đoạn đường thứ hai');
  assert.equal(said[0].say, 'Phía trước 100 mét, đèn tín hiệu giao thông');
  assert.ok(log.filter((r) => r.x > 380).every((r) => r.active?.item.key === 'n1:signals'), 'thanh cảnh báo còn tới đèn');
});

test('dừng đèn đỏ ngay sau chỗ nối đoạn đường (làn rẽ bắt đầu trước nút giao): thanh cảnh báo còn suốt lúc chờ', () => {
  const J = at(500);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 46), { n: 'X' }), way(2, NORTH.slice(45), { n: 'X' }), way(3, [destination(J, W, 300), J, destination(J, E, 300)])],
    [feat(1, J, { highway: 'traffic_signals' })],
  );
  const engine = new SignEngine();
  let time = 1_000_000;
  const step = (x, v) => engine.update({ coord: destination(O, N, x), speed: v, heading: v > 0.5 ? N : null, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON });
  for (let x = 200; x < 420; x += 10) step(x, 10);
  for (const [x, v] of [[428, 7], [436, 5], [442, 3.5], [446, 2.6], [449, 2], [452, 1.5], [455, 1], [457, 0.4]]) step(x, v);
  for (let k = 0; k < 60; k++) {
    const r = step(458, 0);
    assert.equal(r.active?.item.key, 'n1:signals', `giây thứ ${k + 1} chờ đèn`);
    assert.equal(Math.round(r.active.distance), 42);
  }
});

test('chiều đi đã nhớ không còn dùng khi xe quay đầu lúc đi chậm hoặc đã dừng quá lâu', () => {
  // Đèn ở 480 m (phía Bắc), gờ ở 150 m (phía Nam); xe chạy lên tới 300 m rồi đi chậm hoặc dừng.
  const roads = straight([
    feat(1, at(480), { highway: 'traffic_signals' }),
    feat(2, at(150), { traffic_calming: 'hump' }),
    feat(3, at(800), { traffic_calming: 'bump' }),
  ]);
  const north = (r) => r.upcoming.some((u) => u.key === 'n1:signals');
  const run = (moves) => {
    const engine = new SignEngine();
    drive(roads, { end: 300, speed: 10, engine });
    let time = 1_031_000;
    return moves.map(([x, speed, heading, dt = 1000]) =>
      engine.update({ coord: destination(O, N, x), speed, heading, accuracy: 5, time: (time += dt) }, roads, {}, { now: NOON }),
    );
  };
  // Dừng chờ một chỗ: vẫn nhớ chiều đi dù đã quá 5 phút. Quá 5 phút chưa xác nhận lại mà xe đã dịch đi (vị trí lùi
  // 40 m, không có hướng) thì thôi.
  const wait = run([[300, 0, null, 60e3], [300, 0, null, 200e3], [300, 0, null, 50e3], [260, 0, null, 10e3]]);
  assert.deepEqual(wait.map(north), [true, true, true, false]);
  // Vị trí nhảy ra ngoài hành lang dựng lúc xác nhận chiều đi lần cuối (mất tín hiệu GPS): không dùng chiều cũ.
  const bump = (r) => r.upcoming.some((u) => u.key === 'n3:calming');
  assert.deepEqual(run([[600, 0, null, 6000]]).map(bump), [true]);
  assert.deepEqual(run([[650, 0, null, 6000]]).map(bump), [false]);
  // Quay đầu đi chậm về phía Nam (hướng GPS 180°): không dựng hành lang theo chiều cũ.
  const back = run([...Array(10)].map((_, k) => [298 - 2 * k, 2, S]));
  assert.ok(back.slice(-4).every((r) => !north(r) && !r.active), JSON.stringify(back.map(north)));
  // Không có hướng GPS nhưng xe đã lùi hơn 10 m (từ 290 m): cũng không dùng chiều cũ (sau 5 giây giữ thanh cảnh báo).
  const drift = run([...Array(14)].map((_, k) => [298 - 2 * k, 2, null]));
  assert.ok(drift.slice(-4).every((r) => !north(r)), JSON.stringify(drift.map(north)));
});

// ------------------------------------------------------------------------------------------
// Đi chậm qua nút giao rồi rẽ, dừng: không giữ hành lang trên đường xe không đi
// ------------------------------------------------------------------------------------------

/** Ngã tư J ở 500 m: A (lên tới J), B (đi thẳng tiếp), C (rẽ, hướng brgC), nhánh phía Tây. Biển trên B là n1, n2. */
function crossroads(brgC = E, featsB = [[1, 6, { highway: 'traffic_signals' }]], featsC = []) {
  const J = at(500);
  const B = line(J, N, 600);
  const C = line(J, brgC, 600);
  const roads = roadsOf(
    [way(1, NORTH.slice(0, 51)), way(2, B), way(3, C, { h: 'residential' }), way(4, line(J, W, 300).reverse(), { h: 'residential' })],
    [...featsB.map(([id, k, tags]) => feat(id, B[k], tags)), ...featsC.map(([id, k, tags]) => feat(id, C[k], tags))],
  );
  return { J, B, C, roads };
}

const showsB = (r) => [r.active?.item, ...r.upcoming].some((it) => it && /^n[12]:/.test(it.key));

test('rẽ phải lúc đi chậm (1,2–2,4 m/s): sau vài giây giữ thanh cảnh báo, không còn hiện biển của đường đi thẳng', () => {
  const { C, roads } = crossroads(E, [[1, 6, { highway: 'traffic_signals' }], [2, 15, { highway: 'speed_camera' }]], [[3, 25, { highway: 'traffic_signals' }]]);
  const path = [...NORTH.slice(0, 50), ...C];
  const cum = cumulativeDistances(path);
  for (const v of [1.2, 2, 2.4]) {
    const engine = new SignEngine();
    const log = [];
    let time = 1_000_000;
    for (let s = 250; s < 700; ) {
      const speed = s < 450 ? 10 : s < 560 ? v : 8;
      const p = pointAtDistance(path, cum, s);
      log.push({ s, time, ...engine.update({ coord: p.point, speed, heading: p.bearing, accuracy: 5, time }, roads, {}, { now: NOON }) });
      time += 1000;
      s += speed;
    }
    const turned = log.find((r) => r.s > 503).time;
    const late = log.filter((r) => r.s > 503 && r.time > turned + 5000);
    assert.ok(late.every((r) => !showsB(r)), `${v} m/s: ${JSON.stringify(late.filter(showsB).map((r) => Math.round(r.s)))}`);
    // Chỉ đèn trên C được đọc khi đã rẽ.
    const onC = spoken(log).filter((r) => r.s > 500);
    assert.deepEqual(onC.map((r) => r.fired.map((f) => f.key)), [['n3:signals']], `${v} m/s`);
  }
});

test('rẽ chậm rồi dừng ngay trên đường rẽ (5–20 m) suốt 1 phút: không hiện đèn của đường đi thẳng', () => {
  const { J, roads } = crossroads();
  for (const stopAt of [5, 8, 12, 20]) {
    const engine = new SignEngine();
    let time = 1_000_000;
    const step = (coord, speed, heading) => engine.update({ coord, speed, heading, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON });
    for (let s = 300; s < 470; s += 10) step(at(s), 10, N);
    for (let s = 470; s < 500; s += 2) step(destination(O, N, s), 2, N);
    const turned = time + 1000;
    for (let d = 2; d <= stopAt; d += 2) step(destination(J, E, d), 2, E);
    for (let k = 0; k < 60; k++) {
      const r = step(destination(J, E, stopAt), 0, E);
      if (time > turned + 5000) assert.ok(!showsB(r), `dừng cách J ${stopAt} m, giây thứ ${k + 1}`);
    }
  }
});

test('rẽ chậm vào nhánh chếch 30°, 45°, 60°: không đọc đèn của đường đi thẳng', () => {
  for (const theta of [30, 45, 60]) {
    const { J, roads } = crossroads(theta, [[1, 11, { highway: 'traffic_signals' }]]); // đèn 110 m sau J trên B
    for (const v of [1.6, 2, 2.4]) {
      const engine = new SignEngine();
      const log = [];
      let time = 1_000_000;
      const step = (coord, speed, heading) => log.push(engine.update({ coord, speed, heading, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON }));
      for (let s = 300; s < 440; s += 10) step(at(s), 10, N);
      for (let s = 440; s < 500; s += v) step(destination(O, N, s), v, N);
      for (let d = v; d <= 60; d += v) step(destination(J, theta, d), v, theta);
      assert.deepEqual(spoken(log).map((r) => r.say), [], `${theta}°, ${v} m/s`);
    }
  }
});

test('sang đường song song bị cắt thành nhiều đoạn ngắn (20–50 m): hành lang theo đường mới, không đọc đèn của đường cũ', () => {
  const M = line(O, N, 1200);
  const P0 = destination(O, E, 12);
  for (const seg of [20, 50]) {
    const ways = [way(1, M, { o: 1, h: 'trunk' })];
    for (let a = 0, id = 100; a < 1200; a += seg) ways.push(way(id++, line(destination(P0, N, a), N, Math.min(seg, 1200 - a)), { o: 1, h: 'tertiary' }));
    const roads = roadsOf(ways, [feat(1, M[60], { highway: 'traffic_signals' }), feat(2, destination(P0, N, 700), { highway: 'traffic_signals' })]);
    for (const v of [10, 20]) {
      const engine = new SignEngine();
      const log = [];
      let time = 1_000_000;
      for (let s = 0; s <= 900; s += v) {
        const lateral = s < 200 ? 0 : s < 220 ? (12 * (s - 200)) / 20 : 12;
        const coord = destination(destination(O, N, s), E, lateral);
        log.push({ s, ...engine.update({ coord, speed: v, heading: N, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON }) });
      }
      const msg = `đoạn ${seg} m, ${v} m/s`;
      assert.ok(log.filter((r) => r.s >= 260).every((r) => !r.upcoming.some((u) => u.key === 'n1:signals')), msg);
      assert.deepEqual(spoken(log).map((r) => r.fired.map((f) => f.key)), [['n2:signals']], msg);
    }
  }
});

test('quay đầu chậm qua dải phân cách (đường đôi 8 m, 15 m): hết vài giây giữ thanh cảnh báo thì không còn hiện đèn phía sau', async () => {
  const { LocationService } = await import('../js/location.js');
  const U = at(600);
  for (const gap of [8, 15]) {
    const ways = [way(1, line(O, N, 1500), { o: 1 }), way(2, line(destination(O, E, gap), N, 1500).reverse(), { o: 1 })];
    const roads = roadsOf(ways, [
      feat(1, destination(U, N, 80), { highway: 'traffic_signals' }),
      feat(2, destination(at(450), E, gap), { highway: 'traffic_signals' }),
    ]);
    for (const deviceHeading of [true, false]) {
      for (const vt of [1.5, 2.2]) {
        const loc = new LocationService();
        const engine = new SignEngine();
        let time = 1_000_000;
        const rows = [];
        const feed = (coord, speed, heading) => {
          const fix = loc.ingest({ coord, accuracy: 8, speed, heading: deviceHeading ? heading : null, time: (time += 1000), simulated: false });
          rows.push({ heading, time, ...engine.update(fix, roads, {}, { now: NOON }) });
        };
        for (let s = 300; s < 590; s += 10) feed(destination(O, N, s), 10, N);
        for (const [d, v] of [[594, 6], [598, 3], [600, 1]]) feed(destination(O, N, d), v, N);
        for (let k = 0; k < 10; k++) feed(U, 0, null);
        const centre = destination(U, E, gap / 2);
        const steps = Math.round((Math.PI * gap) / 2 / vt);
        for (let k = 1; k <= steps; k++) {
          const a = 270 + (180 * k) / steps;
          feed(destination(centre, a % 360, gap / 2), vt, (a + 90) % 360);
        }
        const back = destination(U, E, gap);
        for (let d = vt; d <= 60; d += vt) feed(destination(back, S, d), vt, S);
        for (let d = 60; d <= 200; d += 8) feed(destination(back, S, d), 8, S);
        const mid = rows.find((r) => r.heading >= 90 && r.heading <= 270).time; // nửa vòng quay đầu
        const behind = (r) => [r.active?.item, ...r.upcoming].some((it) => it && it.key === 'n1:signals');
        const late = rows.filter((r) => r.time >= mid + 5000 && behind(r));
        assert.deepEqual(late.map((r) => (r.time - mid) / 1000), [], `dải phân cách ${gap} m, ${deviceHeading ? 'có' : 'không có'} hướng từ máy, ${vt} m/s`);
        assert.ok(spoken(rows).some((r) => r.fired.some((f) => f.key === 'n2:signals')), 'đèn phía trước sau khi quay đầu vẫn được đọc');
      }
    }
  }
});

test('dừng đèn đỏ, vị trí trôi lệch về phía sau 15–20 m (sai số GPS lúc đứng yên): thanh cảnh báo vẫn còn', async () => {
  const { LocationService } = await import('../js/location.js');
  const roads = roadsOf([way(1, line(O, N, 1500))], [feat(1, destination(O, N, 480), { highway: 'traffic_signals' })]);
  for (const [off, brg] of [[15, 150], [20, 200], [12, 180]]) {
    const loc = new LocationService();
    const engine = new SignEngine();
    let time = 1_000_000;
    const feed = (coord, speed, heading) =>
      engine.update(loc.ingest({ coord, accuracy: 15, speed, heading, time: (time += 1000), simulated: false }), roads, {}, { now: NOON });
    let s = 200;
    for (; s < 440; s += 10) feed(destination(O, N, s), 10, N);
    for (const v of [7, 4, 2, 0.5]) feed(destination(O, N, (s += v)), v, v >= 1 ? N : null);
    const stop = destination(O, N, s);
    for (let k = 0; k < 60; k++) {
      const r = feed(destination(stop, brg, Math.min(off, (off * k) / 8)), 0, null);
      assert.equal(r.active?.item.key, 'n1:signals', `lệch ${off} m hướng ${brg}°, giây thứ ${k + 1}`);
    }
  }
});

test('dừng lâu hơn 5 phút (kẹt xe) trên đoạn đường không bị cắt: thanh cảnh báo vẫn còn, đi tiếp chậm vẫn đúng chiều', () => {
  const roads = roadsOf([way(1, line(O, N, 1500))], [feat(1, destination(O, N, 480), { highway: 'traffic_signals' })]);
  const engine = new SignEngine();
  let time = 1_000_000;
  const step = (x, speed) => engine.update({ coord: destination(O, N, x), speed, heading: N, accuracy: 5, time: (time += 1000) }, roads, {}, { now: NOON });
  for (let x = 200; x <= 440; x += 10) step(x, 10);
  for (let k = 1; k <= 400; k++) assert.equal(step(440, 0).active?.item.key, 'n1:signals', `giây thứ ${k} đứng yên`);
  for (let x = 442; x <= 460; x += 2) assert.equal(step(x, 2).active?.item.key, 'n1:signals', `đi tiếp ở ${x} m`);
});
