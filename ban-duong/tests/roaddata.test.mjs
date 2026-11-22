import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery,
  CELL,
  cellKey,
  cellOf,
  OVERPASS_ENDPOINTS,
  overpassFailure,
  parseMaxspeed,
  parseOverpass,
  RoadData,
} from '../js/roaddata.js';
import { destination, distance } from '../js/geo.js';
import { START } from './fixtures.mjs';

// ---- Phản hồi Overpass mẫu (dựng tay theo đúng cấu trúc JSON của Overpass, không phải dữ liệu thật) ----
// Đường 100 chạy lên phía Bắc qua nút 1 → 2 → 3; đường 101 rẽ sang Đông từ nút 2 tới nút 4.

const N1 = { lat: 10.77, lon: 106.7 };
const N2 = { lat: 10.771, lon: 106.7 };
const N3 = { lat: 10.772, lon: 106.7 };
const N4 = { lat: 10.771, lon: 106.701 };
const LONG = 'x'.repeat(100);

function sampleResponse() {
  return {
    version: 0.6,
    osm3s: { timestamp_osm_base: '2026-07-28T02:16:18Z' },
    elements: [
      {
        type: 'way',
        id: 100,
        nodes: [1, 2, 3],
        geometry: [N1, N2, N3],
        tags: { highway: 'primary', name: 'Nguyễn Trãi', maxspeed: '50', maxheight: '3.5', overtaking: 'no', 'name:en': 'Nguyen Trai', surface: 'asphalt' },
      },
      { type: 'way', id: 101, nodes: [2, 4], geometry: [N2, N4], tags: { highway: 'residential', name: 'Hẻm 12' } },
      // Nhóm điểm (.pts out body)
      { type: 'node', id: 1, ...N1, tags: { 'traffic_sign:forward': 'VN:P.102' } },
      { type: 'node', id: 2, ...N2, tags: { highway: 'traffic_signals', 'traffic_signals:direction': 'forward', 'name:en': 'x', source: 'survey' } },
      { type: 'node', id: 3, ...N3, tags: { railway: 'level_crossing', 'crossing:barrier': 'yes' } },
      { type: 'node', id: 5, lat: 10.7715, lon: 106.70005, tags: { traffic_sign: 'VN:P.123a', direction: '180' } },
      { type: 'node', id: 6, lat: 10.7716, lon: 106.70005, tags: { highway: 'bus_stop' } },
      { type: 'node', id: 7, lat: 10.7717, lon: 106.70005, tags: { man_made: 'surveillance', 'surveillance:zone': 'town', traffic_sign: 'VN:W.245' } },
      { type: 'node', id: 8, lat: 10.7718, lon: 106.70005, tags: { barrier: 'height_restrictor', maxheight: '3.2' } },
      { type: 'node', id: 9, lat: 10.7719, lon: 106.70005, tags: { highway: 'crossing', crossing: 'uncontrolled', crossing_ref: 'zebra' } },
      { type: 'node', id: 10, lat: 10.772, lon: 106.70005, tags: { hazard: LONG } },
      // Quan hệ cấm rẽ (.restr out body)
      {
        type: 'relation',
        id: 200,
        members: [
          { type: 'way', ref: 100, role: 'from' },
          { type: 'node', ref: 2, role: 'via' },
          { type: 'way', ref: 101, role: 'to' },
        ],
        tags: { type: 'restriction', restriction: 'no_left_turn', 'restriction:motorcar': 'no_left_turn', except: 'bicycle;motorcycle', note: 'ghi chú', name: 'x' },
      },
      {
        type: 'relation',
        id: 201, // "via" là đường: bỏ qua
        members: [
          { type: 'way', ref: 100, role: 'from' },
          { type: 'way', ref: 101, role: 'via' },
          { type: 'way', ref: 100, role: 'to' },
        ],
        tags: { type: 'restriction', restriction: 'no_u_turn' },
      },
      {
        type: 'relation',
        id: 202, // hai đường "from": không hợp lệ
        members: [
          { type: 'way', ref: 100, role: 'from' },
          { type: 'way', ref: 101, role: 'from' },
          { type: 'node', ref: 2, role: 'via' },
          { type: 'way', ref: 101, role: 'to' },
        ],
        tags: { type: 'restriction', restriction: 'no_right_turn' },
      },
      {
        type: 'relation',
        id: 203, // nút via 4 không được in ra nhưng có trong hình học của đường 101
        members: [
          { type: 'way', ref: 101, role: 'from' },
          { type: 'node', ref: 4, role: 'via' },
          { type: 'way', ref: 777, role: 'to' },
        ],
        tags: { type: 'restriction', 'restriction:conditional': 'no_straight_on @ (06:00-22:00)' },
      },
      {
        type: 'relation',
        id: 204, // không biết toạ độ nút via: bỏ qua
        members: [
          { type: 'way', ref: 100, role: 'from' },
          { type: 'node', ref: 999, role: 'via' },
          { type: 'way', ref: 101, role: 'to' },
        ],
        tags: { type: 'restriction', restriction: 'no_left_turn' },
      },
      // Nút via in lại không có thẻ (.via out skel)
      { type: 'node', id: 2, ...N2 },
    ],
  };
}

test('truy vấn Overpass lấy thêm nút trên đường, quan hệ cấm rẽ và nút via', () => {
  const [cx, cy] = cellOf([106.7, 10.77]);
  const q = buildQuery(cx, cy);
  assert.match(q, /^\[out:json\]\[timeout:60\]\[maxsize:134217728\]\[bbox:10\.77000,106\.68000,10\.80000,106\.71000\];/);
  assert.match(q, /way\["highway"~"\^\(motorway\|.*\)\$"\]->\.roads;/);
  assert.match(q, /node\(w\.roads\)->\.rn;/);
  assert.match(q, /rel\(bw\.roads\)\["type"="restriction"\]->\.restr;/);
  assert.match(q, /node\(r\.restr:"via"\)->\.via;/);
  assert.match(q, /rel\["type"="enforcement"\]->\.enf;/);
  for (const out of ['.roads out body geom qt;', '.pts out body qt;', '.restr out body qt;', '.via out skel qt;', '.enf out body geom qt;']) {
    assert.ok(q.includes(out), out);
  }
  for (const k of ['traffic_signals', 'mini_roundabout', 'traffic_calming', 'level_crossing', 'height_restrictor', 'traffic_sign:forward', 'traffic_sign:backward', 'hazard', 'speed_camera', 'toll_booth', 'surveillance']) {
    assert.ok(q.includes(k), k);
  }
  const count = (re) => (q.match(re) || []).length;
  assert.equal(count(/\(/g), count(/\)/g));
  assert.equal(count(/\[/g), count(/\]/g));
  assert.equal(count(/"/g) % 2, 0);
});

test('maxspeed: dưới 10 km/h là dữ liệu nhập sai', () => {
  assert.equal(parseMaxspeed('5'), null);
  assert.equal(parseMaxspeed('9'), null);
  assert.equal(parseMaxspeed('10'), 10);
  assert.equal(parseMaxspeed('150'), 150);
  assert.equal(parseMaxspeed('151'), null);
  assert.equal(parseMaxspeed('VN:urban'), null);
});

test('parseOverpass: đường giữ thẻ cần cho biển báo, bỏ thẻ thừa', () => {
  const data = parseOverpass(sampleResponse());
  assert.equal(data.ways.length, 2);
  const [main, side] = data.ways;
  assert.deepEqual({ c: main.c, m: main.m, o: main.o, n: main.n }, { c: 50, m: 50, o: 0, n: 'Nguyễn Trãi' });
  assert.deepEqual(main.t, { maxheight: '3.5', overtaking: 'no' });
  assert.equal('t' in side, false, 'không có thẻ cần giữ thì không có trường t');
  assert.equal(data.base, '2026-07-28T02:16:18Z');
});

test('parseOverpass: nút biển báo, nằm trên đường hay đứng riêng, chỉ giữ thẻ cần dùng', () => {
  const data = parseOverpass(sampleResponse());
  const byId = new Map(data.feats.map((f) => [f.id, f]));
  assert.deepEqual([...byId.keys()].sort(), ['n1', 'n10', 'n2', 'n3', 'n5', 'n7', 'n8', 'n9']);
  // Đỉnh của đường: onWay; biển đứng bên lề: không.
  assert.equal(byId.get('n1').onWay, true);
  assert.equal(byId.get('n2').onWay, true);
  assert.equal(byId.get('n3').onWay, true);
  assert.equal(byId.get('n5').onWay, false);
  // Nút in hai lần (điểm + via): giữ bản có thẻ; thẻ thừa bị bỏ.
  assert.deepEqual(byId.get('n2').tags, { highway: 'traffic_signals', 'traffic_signals:direction': 'forward' });
  assert.deepEqual(byId.get('n2').coord, [106.7, 10.771]);
  assert.deepEqual(byId.get('n1').tags, { 'traffic_sign:forward': 'VN:P.102' });
  assert.deepEqual(byId.get('n5').tags, { traffic_sign: 'VN:P.123a', direction: '180' });
  assert.deepEqual(byId.get('n9').tags, { highway: 'crossing', crossing: 'uncontrolled', crossing_ref: 'zebra' });
  assert.deepEqual(byId.get('n7').tags, { traffic_sign: 'VN:W.245' });
  assert.equal(byId.get('n10').tags.hazard.length, 80, 'giá trị quá dài bị cắt');
  // Đường ngang đường sắt vừa là điểm trên bản đồ vừa là nút biển báo; camera an ninh không phải camera giao thông.
  assert.deepEqual(data.points.map((p) => `${p.id}/${p.kind}`), ['n3/rail']);
});

test('parseOverpass: nút in dạng skel trước bản có thẻ vẫn giữ thẻ', () => {
  const data = parseOverpass({
    elements: [
      { type: 'node', id: 2, ...N2 },
      { type: 'node', id: 2, ...N2, tags: { highway: 'stop' } },
    ],
  });
  assert.equal(data.feats.length, 1);
  assert.deepEqual(data.feats[0].tags, { highway: 'stop' });
  assert.equal(data.feats[0].onWay, false);
  assert.equal(data.base, null);
});

test('parseOverpass: quan hệ cấm rẽ qua một nút, bỏ loại qua đường hoặc không rõ nút', () => {
  const data = parseOverpass(sampleResponse());
  assert.deepEqual(data.restr.map((r) => r.id), ['r200', 'r203']);
  const [r200, r203] = data.restr;
  assert.deepEqual(r200, {
    id: 'r200',
    from: 100,
    to: 101,
    via: [106.7, 10.771],
    tags: { type: 'restriction', restriction: 'no_left_turn', 'restriction:motorcar': 'no_left_turn', except: 'bicycle;motorcycle' },
  });
  assert.deepEqual(r203.via, [106.701, 10.771], 'toạ độ nút via lấy từ hình học của đường');
  assert.deepEqual(r203.tags, { type: 'restriction', 'restriction:conditional': 'no_straight_on @ (06:00-22:00)' });
});

test('nhận ra phản hồi Overpass bị lỗi giữa chừng', () => {
  assert.match(overpassFailure({ remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' }), /timed out/);
  assert.match(overpassFailure({ remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.' }), /memory/);
  assert.equal(overpassFailure({ elements: [] }), null);
  assert.equal(overpassFailure({ remark: 'ghi chú bình thường', elements: [] }), null);
  assert.equal(overpassFailure(null), null);
});

// ---- Tải dữ liệu với fetch và bộ đệm giả (không dùng mạng, không có IndexedDB) ----

function fakeCache(initial = []) {
  const store = new Map(initial.map((r) => [r.key, r]));
  const puts = [];
  return {
    puts,
    get: async (key) => store.get(key) || null,
    put: async (rec) => {
      puts.push(rec);
      store.set(rec.key, rec);
    },
  };
}

function fakeFetch(responses, onCall = () => {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: opts.body });
    onCall();
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json };
  };
  return { calls, impl };
}

// Giữa ô, để không kéo theo ô bên cạnh.
const CENTER = [(Math.floor(106.7 / CELL) + 0.5) * CELL, (Math.floor(10.77 / CELL) + 0.5) * CELL];
const CENTER_KEY = cellKey(...cellOf(CENTER));

async function settle(roads) {
  await Promise.all([...roads.pending.values()]);
}

test('tải ô: phản hồi báo lỗi thì thử máy chủ khác, lưu bộ đệm phiên bản 2', async () => {
  const cache = fakeCache();
  const { calls, impl } = fakeFetch([
    { json: { remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.', elements: [] } },
    { json: sampleResponse() },
  ]);
  const roads = new RoadData({ fetchImpl: impl, cache });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.deepEqual(calls.map((c) => c.url), [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[1]]);
  assert.ok(calls[0].body.includes(encodeURIComponent('node(w.roads)')));
  assert.equal(roads.status, 'ready');
  assert.equal(roads.endpoint, 1, 'lần sau bắt đầu từ máy chủ vừa trả lời được');
  assert.equal(cache.puts.length, 1);
  const rec = cache.puts[0];
  assert.equal(rec.key, CENTER_KEY);
  assert.equal(rec.v, 2);
  assert.equal(typeof rec.t, 'number');
  assert.equal(rec.base, '2026-07-28T02:16:18Z');
  assert.equal(rec.ways.length, 2);
  assert.equal(rec.feats.length, 8);
  assert.equal(rec.restr.length, 2);
  assert.deepEqual(rec.points.map((p) => p.id), ['n3']);
  assert.equal(roads.dataTimestamp(), '2026-07-28T02:16:18Z');
});

test('tải ô: mọi máy chủ đều lỗi thì không lưu gì', async () => {
  const cache = fakeCache();
  const { calls, impl } = fakeFetch([
    { json: { remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.', elements: [] } },
    { ok: false, status: 504, json: null },
    new TypeError('Failed to fetch'),
  ]);
  const roads = new RoadData({ fetchImpl: impl, cache });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 3);
  assert.equal(cache.puts.length, 0);
  assert.equal(roads.status, 'error');
  assert.equal(roads.hasData(CENTER), false);
});

test('bộ đệm cũ (chưa có v: 2) được dùng ngay nhưng vẫn tải lại', async () => {
  const old = { key: CENTER_KEY, t: Date.now(), ways: parseOverpass(sampleResponse()).ways, points: [] };
  const cache = fakeCache([old]);
  let hadDataWhileFetching = null;
  const roads = new RoadData({ cache });
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }], () => {
    hadDataWhileFetching = roads.hasData(CENTER);
  });
  roads.fetch = impl;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(hadDataWhileFetching, true, 'dữ liệu cũ vẫn cho giới hạn tốc độ trong lúc tải lại');
  assert.equal(calls.length, 1);
  assert.equal(cache.puts.length, 1);
  assert.equal(cache.puts[0].v, 2);
  assert.equal(roads.featsNear([106.7, 10.771], 5).length, 1);
});

test('bộ đệm v2 còn hạn thì không tải lại, quá 7 ngày thì tải lại', async () => {
  const data = parseOverpass(sampleResponse());
  const rec = (t) => ({ key: CENTER_KEY, v: 2, t, base: data.base, ...data });

  const fresh = fakeFetch([]);
  const roads = new RoadData({ fetchImpl: fresh.impl, cache: fakeCache([rec(Date.now() - 3600e3)]) });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(fresh.calls.length, 0);
  assert.equal(roads.restrictionsFrom(100).length, 1);
  assert.equal(roads.dataTimestamp(), '2026-07-28T02:16:18Z');

  const stale = fakeFetch([{ json: sampleResponse() }]);
  const roads2 = new RoadData({ fetchImpl: stale.impl, cache: fakeCache([rec(Date.now() - 8 * 24 * 3600e3)]) });
  roads2.ensureAround(CENTER);
  await settle(roads2);
  assert.equal(stale.calls.length, 1);
});

// ---- Chỉ mục: đỉnh giao lộ, nút biển báo, quan hệ cấm rẽ ----

const J = destination(START, 0, 500); // giao lộ
const way = (id, coords, extra = {}) => ({ id, n: '', h: 'residential', c: null, m: null, o: 0, g: coords.flat(), ...extra });

function junctionRoads() {
  const roads = new RoadData();
  const [cx, cy] = cellOf(J);
  const east = way(2, [J, destination(J, 90, 300)]);
  roads.setCell(cellKey(cx, cy), {
    ways: [
      way(1, [START, J, destination(START, 0, 1000)]), // đi qua giao lộ: đỉnh giữa
      east, // bắt đầu tại giao lộ
      way(3, [destination(J, 270, 300), J]), // kết thúc tại giao lộ
      way(4, [J, destination(J, 45, 60), destination(J, 135, 60), J]), // vòng khép kín
      way(5, [destination(J, 0, 50), destination(J, 90, 50)]), // ở gần nhưng không chạm giao lộ
    ],
    points: [],
  });
  // Cùng đường 2 có mặt ở ô bên cạnh (đường dài chạy qua nhiều ô).
  roads.setCell(cellKey(cx + 1, cy), { ways: [east], points: [] });
  return roads;
}

test('waysAtVertex: mọi đường gặp nhau tại một đỉnh, không trùng lặp giữa các ô', () => {
  const roads = junctionRoads();
  const found = roads.waysAtVertex(J).map(({ way: w, i }) => [w.id, i]);
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(found, [[1, 1], [2, 0], [3, 1], [4, 0], [4, 3]]);
  assert.deepEqual(roads.waysAtVertex(destination(J, 90, 1)), []);
  assert.deepEqual(roads.waysAtVertex(START).map(({ way: w, i }) => [w.id, i]), [[1, 0]]);
});

test('featsNear: trong bán kính, không trùng lặp, tìm cả sang ô bên cạnh', () => {
  // Đặt vị trí sát mép dưới một ô, nút biển báo nằm ở ô phía dưới.
  const [cx, cy] = cellOf(START);
  const p = [START[0], cy * CELL + 0.00005];
  const feat = (id, coord) => ({ id, coord, onWay: true, tags: { highway: 'traffic_signals' } });
  const f30 = feat('n30', destination(p, 0, 30));
  const f65 = feat('n65', destination(p, 90, 65));
  const f100 = feat('n100', destination(p, 0, 100));
  const below = feat('nb', destination(p, 180, 40));
  assert.equal(cellOf(below.coord)[1], cy - 1);
  const roads = new RoadData();
  roads.setCell(cellKey(cx, cy), { ways: [], points: [], feats: [f30, f65, f100] });
  roads.setCell(cellKey(cx, cy - 1), { ways: [], points: [], feats: [below, f30] });
  const ids = roads.featsNear(p, 70).map((f) => f.id).sort();
  assert.deepEqual(ids, ['n30', 'n65', 'nb']);
  assert.deepEqual(roads.featsNear(p, 20), []);
  assert.equal(roads.featsNear(p, 150).length, 4);
});

test('restrictionsFrom: theo đường "from", không trùng lặp giữa các ô', () => {
  const r = (id, from) => ({ id, from, to: 9, via: J, tags: { type: 'restriction', restriction: 'no_left_turn' } });
  const roads = new RoadData();
  roads.setCell('1:1', { ways: [], points: [], restr: [r('r1', 100), r('r2', 100)] });
  roads.setCell('1:2', { ways: [], points: [], restr: [r('r1', 100), r('r3', 200)] });
  assert.deepEqual(roads.restrictionsFrom(100).map((x) => x.id), ['r1', 'r2']);
  assert.deepEqual(roads.restrictionsFrom(200).map((x) => x.id), ['r3']);
  assert.deepEqual(roads.restrictionsFrom(300), []);
});

test('ô dữ liệu kiểu cũ (chỉ có ways, points) vẫn dùng được', () => {
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(J)), { ways: [way(1, [START, J])], points: [] });
  assert.deepEqual(roads.featsNear(J, 100), []);
  assert.deepEqual(roads.restrictionsFrom(1), []);
  assert.equal(roads.dataTimestamp(), null);
  assert.equal(roads.waysAtVertex(J).length, 1);
});

test('dataTimestamp: mốc dữ liệu mới nhất trong các ô', () => {
  const roads = new RoadData();
  assert.equal(roads.dataTimestamp(), null);
  roads.setCell('1:1', { ways: [], points: [], base: '2026-06-01T08:52:28Z' });
  roads.setCell('1:2', { ways: [], points: [], base: '2026-07-28T02:16:18Z' });
  roads.setCell('1:3', { ways: [], points: [] });
  assert.equal(roads.dataTimestamp(), '2026-07-28T02:16:18Z');
});

// ---- matchWay: đoạn khớp, vị trí trên đoạn, chiều đi ----

function singleWay(extra) {
  const roads = new RoadData();
  const g = [START, destination(START, 0, 500), destination(START, 0, 1000)];
  roads.setCell(cellKey(...cellOf(g[1])), { ways: [way(10, g, extra)], points: [] });
  return roads;
}

test('matchWay: trả về đoạn, vị trí chiếu và chiều đi so với chiều vẽ đường', () => {
  const roads = singleWay();
  const at = destination(destination(START, 0, 700), 90, 3);
  const fix = (heading, speed = 10) => ({ coord: at, heading, speed, accuracy: 8 });

  const along = roads.matchWay(fix(2));
  assert.equal(along.way.id, 10);
  assert.equal(along.seg, 1);
  assert.ok(Math.abs(along.t - 0.4) < 0.01, `t = ${along.t}`);
  assert.ok(Math.abs(along.dist - 3) < 0.2, `dist = ${along.dist}`);
  assert.ok(distance(along.point, destination(START, 0, 700)) < 0.5);
  assert.equal(along.dir, 1);

  assert.equal(roads.matchWay(fix(178)).dir, -1);
  assert.equal(roads.matchWay(fix(0, 0)).dir, 0, 'đứng yên: không biết chiều');
  assert.equal(roads.matchWay(fix(null)).dir, 0);

  const first = roads.matchWay({ coord: destination(START, 0, 100), heading: 0, speed: 10, accuracy: 8 });
  assert.equal(first.seg, 0);
});

test('matchWay: đường một chiều ngược chiều vẽ chỉ khớp khi đi đúng chiều cho phép', () => {
  const roads = singleWay({ o: -1 });
  const at = destination(START, 0, 300);
  assert.equal(roads.matchWay({ coord: at, heading: 180, speed: 10, accuracy: 8 }).dir, -1);
  assert.equal(roads.matchWay({ coord: at, heading: 0, speed: 10, accuracy: 8 }), null);
  const oneway = singleWay({ o: 1 });
  assert.equal(oneway.matchWay({ coord: at, heading: 5, speed: 10, accuracy: 8 }).dir, 1);
});
