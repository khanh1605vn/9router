import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery,
  CACHE_VERSION,
  CELL,
  cellKey,
  cellOf,
  freshnessText,
  onewayFor,
  OVERPASS_ENDPOINTS,
  overpassFailure,
  parseMaxspeed,
  parseOverpass,
  REFRESH_AGE,
  REFRESH_GAP,
  REFRESH_RETRY,
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
      // Nhóm đường (.roads out tags geom): chỉ có thẻ và hình học, không có mảng "nodes".
      {
        type: 'way',
        id: 100,
        geometry: [N1, N2, N3],
        tags: { highway: 'primary', name: 'Nguyễn Trãi', maxspeed: '50', maxheight: '3.5', overtaking: 'no', 'name:en': 'Nguyen Trai', surface: 'asphalt' },
      },
      { type: 'way', id: 101, geometry: [N2, N4], tags: { highway: 'residential', name: 'Hẻm 12' } },
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
        id: 203, // nút via 4 không mang thẻ: toạ độ chỉ có trong nhóm via
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
      { type: 'node', id: 4, ...N4 },
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
  for (const out of ['.roads out tags geom qt;', '.pts out body qt;', '.restr out body qt;', '.via out skel qt;', '.enf out body geom qt;']) {
    assert.ok(q.includes(out), out);
  }
  for (const k of ['traffic_signals', 'mini_roundabout', 'traffic_calming', 'level_crossing', 'height_restrictor', 'traffic_sign:forward', 'traffic_sign:backward', 'hazard', 'speed_camera', 'toll_booth', 'surveillance']) {
    assert.ok(q.includes(k), k);
  }
  assert.ok(!q.includes('.roads out body'), 'đường không kèm mảng id nút (không dùng tới)');
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
  assert.deepEqual(r203.via, [106.701, 10.771], 'toạ độ nút via lấy từ nhóm via (out skel)');
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

// Phiên bản bản ghi bộ đệm hiện tại (roaddata.js CACHE_VERSION).
const VERSION = CACHE_VERSION;

// Giữa ô, để không kéo theo ô bên cạnh.
const CENTER = [(Math.floor(106.7 / CELL) + 0.5) * CELL, (Math.floor(10.77 / CELL) + 0.5) * CELL];
const CENTER_KEY = cellKey(...cellOf(CENTER));

async function settle(roads) {
  while (roads.reading.size || roads.pending.size) {
    await Promise.all([...roads.reading.values(), ...roads.pending.values()]);
  }
}

/** Chờ (qua các vòng sự kiện) đến khi điều kiện đúng, tối đa vài trăm vòng. */
async function until(cond, rounds = 500) {
  for (let k = 0; k < rounds && !cond(); k++) await new Promise((r) => setImmediate(r));
  return cond();
}

test('tải ô: phản hồi báo lỗi thì thử máy chủ khác, lưu bộ đệm phiên bản hiện tại', async () => {
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
  assert.equal(rec.v, VERSION);
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

test('bộ đệm cũ (chưa có trường v) được dùng ngay nhưng vẫn tải lại', async () => {
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
  assert.equal(cache.puts[0].v, VERSION);
  assert.equal(roads.featsNear([106.7, 10.771], 5).length, 1);
});

test('bản ghi bộ đệm phiên bản 2 (chưa có chiều một chiều riêng của xe máy) được dùng tạm nhưng vẫn tải lại', async () => {
  const data = parseOverpass(sampleResponse());
  const cache = fakeCache([{ key: CENTER_KEY, v: 2, t: Date.now(), base: data.base, ...data }]);
  let hadDataWhileFetching = null;
  const roads = new RoadData({ cache });
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }], () => {
    hadDataWhileFetching = roads.hasData(CENTER);
  });
  roads.fetch = impl;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(hadDataWhileFetching, true, 'bản ghi cũ vẫn dùng được trong lúc tải lại');
  assert.equal(calls.length, 1, 'bản ghi v2 phải được tải lại để đọc oneway:motorcycle');
  assert.equal(cache.puts.at(-1).v, VERSION);
});

test('bộ đệm đúng phiên bản còn hạn thì không tải lại, quá 7 ngày thì tải lại', async () => {
  const data = parseOverpass(sampleResponse());
  const rec = (t) => ({ key: CENTER_KEY, v: VERSION, t, base: data.base, ...data });

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

test('ô có dữ liệu cũ: lần tải lại hỏng thì 60 giây sau thử lại, không giữ dữ liệu cũ suốt phiên', async (t) => {
  // Đồng hồ giả: chỉ thay Date.now, trả lại như cũ khi xong bài.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  const old = { key: CENTER_KEY, t: Date.now(), ways: parseOverpass(sampleResponse()).ways, points: [] };
  const cache = fakeCache([old]);
  const down = new TypeError('Failed to fetch');
  const { calls, impl } = fakeFetch([down, down, down, { json: sampleResponse() }, { json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache });
  const SIGNAL = [106.7, 10.771];

  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 3, 'lần đầu: cả ba máy chủ đều lỗi');
  assert.equal(roads.hasData(CENTER), true, 'vẫn dùng tạm dữ liệu cũ');
  assert.equal(roads.featsNear(SIGNAL, 5).length, 0);

  now += 30e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 3, 'chưa đủ 60 giây thì chưa thử lại');

  now += 31e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 4, 'mạng có lại: tải lại được');
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1);
  assert.equal(cache.puts.at(-1).v, VERSION);

  now += 3600e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 4, 'dữ liệu mới thì không tải nữa');

  now += 7 * 24 * 3600e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 5, 'ô quá 7 ngày ngay trong phiên cũng được tải lại');
});

test('lượt tải mạng đang treo không chặn việc đọc ô có sẵn trên máy', async () => {
  const [cx, cy] = cellOf(CENTER);
  const data = parseOverpass(sampleResponse());
  const v1 = (x, y) => ({ key: cellKey(x, y), t: Date.now(), ways: [], points: [] });
  const cache = fakeCache([
    { key: CENTER_KEY, v: VERSION, t: Date.now(), ...data }, // C: bản ghi mới
    v1(cx, cy - 1), // A: bản ghi kiểu cũ
    v1(cx + 1, cy - 1), // B: bản ghi kiểu cũ
  ]);
  // Máy chủ nhận yêu cầu nhưng không trả lời (đến khi được thả ở cuối bài).
  const hung = [];
  let down = false;
  const impl = () => (down ? Promise.reject(new TypeError('Failed to fetch')) : new Promise((_, reject) => hung.push(reject)));
  const roads = new RoadData({ fetchImpl: impl, cache });

  // Sát mép Đông của A: A và B đều cần tải lại, nhưng làm mới ô đã có dữ liệu chỉ chiếm một lượt.
  roads.ensureAround([(cx + 0.9) * CELL, (cy - 0.5) * CELL]);
  await until(() => roads.reading.size === 0);
  assert.equal(roads.hasData([(cx + 1.5) * CELL, (cy - 0.5) * CELL]), true, 'B đọc được từ bộ đệm');
  assert.equal(roads.pending.size, 1);

  // Đi vào C: đọc ngay từ bộ đệm, không phải chờ lượt tải mạng.
  roads.ensureAround(CENTER);
  await until(() => roads.reading.size === 0);
  assert.equal(roads.hasData(CENTER), true);
  assert.equal(roads.featsNear([106.7, 10.771], 5).length, 1);

  // Đi tiếp vào D chưa có dữ liệu: vẫn còn một lượt để tải ngay dù lượt làm mới A đang treo.
  roads.ensureAround([(cx + 0.5) * CELL, (cy + 1.5) * CELL]);
  await until(() => roads.reading.size === 0);
  assert.equal(roads.pending.has(cellKey(cx, cy + 1)), true);
  assert.equal(roads.pending.size, 2);

  down = true;
  while (hung.length) hung.shift()(new TypeError('Failed to fetch'));
  await settle(roads);
  assert.equal(hung.length, 0);
});

test('tải ô: hai ô tải song song, mỗi ô tự thử đủ ba máy chủ theo thứ tự', async () => {
  // Máy chủ 0 treo với hai yêu cầu đầu (đến khi được thả), sau đó lỗi ngay; máy chủ 1 trả 429; máy chủ 2 trả lời được.
  const hung = [];
  let zeroCalls = 0;
  const tried = new Map(); // khung bbox của ô → các máy chủ đã thử
  const impl = async (url, opts) => {
    const i = OVERPASS_ENDPOINTS.indexOf(url);
    const bbox = /bbox:([\d.,]+)/.exec(decodeURIComponent(opts.body))[1];
    tried.set(bbox, [...(tried.get(bbox) || []), i]);
    if (i === 0) {
      if (++zeroCalls > 2) throw new TypeError('Failed to fetch');
      return new Promise((_, reject) => hung.push(() => reject(new TypeError('Failed to fetch'))));
    }
    if (i === 1) return { ok: false, status: 429, json: async () => null };
    return { ok: true, status: 200, json: async () => sampleResponse() };
  };
  const roads = new RoadData({ fetchImpl: impl, cache: fakeCache() });
  const [cx, cy] = cellOf(CENTER);
  roads.ensureAround([(cx + 0.9) * CELL, (cy + 0.5) * CELL]); // sát mép Đông: tải cả ô bên cạnh
  assert.ok(await until(() => hung.length === 2), 'hai ô cùng đang chờ máy chủ 0');
  hung[0](); // ô thứ nhất: máy chủ 0 lỗi → máy chủ 1 (429) → máy chủ 2 trả lời
  assert.ok(await until(() => roads.endpoint === 2));
  hung[1](); // ô thứ hai cũng phải thử tiếp máy chủ 1 rồi 2, không quay lại máy chủ 0
  await settle(roads);
  assert.deepEqual([...tried.values()], [[0, 1, 2], [0, 1, 2]]);
  assert.equal(roads.failedAt.size, 0);
  assert.equal(roads.endpoint, 2);
  assert.equal(roads.hasData(CENTER), true);
  assert.equal(roads.hasData([(cx + 1.5) * CELL, (cy + 0.5) * CELL]), true);
});

// ---- Làm mới ngầm (stale-while-revalidate): đồng hồ giả, fetch giả ----

const HOURS = 3600e3;

/** Đồng hồ giả: chỉ thay Date.now, trả lại như cũ khi xong bài. */
function fakeClock(t) {
  const realNow = Date.now;
  const clock = { now: realNow() };
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = realNow;
  });
  return clock;
}

const SIGNAL = [106.7, 10.771]; // nút đèn tín hiệu (nút 2) của sampleResponse

/** Bản ghi bộ đệm đúng phiên bản, tải lúc t: đường có sẵn, chưa có nút biển và điểm cảnh báo (bản trước khi OSM được sửa). */
const oldRecord = (key, t) => ({ key, v: VERSION, t, base: '2026-07-01T00:00:00Z', ways: parseOverpass(sampleResponse()).ways, points: [], feats: [], restr: [] });

test('làm mới ngầm: ô còn mới (dưới 6 giờ) không tải lại; quá 6 giờ thì tải lại một lần, thay dữ liệu ngay và báo bên nghe', async (t) => {
  const clock = fakeClock(t);
  const cache = fakeCache([oldRecord(CENTER_KEY, clock.now - HOURS)]);
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => true });
  let updates = 0;
  roads.onUpdate(() => updates++);

  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 0, 'ô mới tải 1 giờ trước: dùng luôn, không hỏi Overpass');
  assert.equal(roads.hasData(CENTER), true);
  assert.equal(roads.featsNear(SIGNAL, 5).length, 0);
  assert.equal(roads.freshness(CENTER).t, clock.now - HOURS);

  clock.now += REFRESH_AGE - HOURS - 1000; // còn 1 giây nữa mới đủ 6 giờ
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 0, 'chưa đủ 6 giờ');

  clock.now += 1000;
  const before = updates;
  roads.ensureAround(CENTER);
  assert.equal(roads.pending.has(CENTER_KEY), true, 'đủ 6 giờ: bắt đầu tải lại');
  assert.equal(roads.hasData(CENTER), true, 'trong lúc tải lại vẫn dùng bản đang có');
  await settle(roads);
  assert.equal(calls.length, 1);
  // Thay ngay trong bộ nhớ: bộ máy cảnh báo hỏi lại là thấy chỗ sửa, không cần mở lại ứng dụng.
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1);
  assert.deepEqual(roads.pointsNear(CENTER, 3000).map((p) => p.id), ['n3']);
  assert.equal(roads.dataTimestamp(), '2026-07-28T02:16:18Z');
  assert.ok(updates > before, 'báo bên nghe (vẽ lại điểm cảnh báo trên bản đồ)');
  assert.equal(cache.puts.length, 1);
  assert.equal(cache.puts[0].t, clock.now, 'bản ghi trên máy mang thời điểm tải mới');
  assert.equal(roads.freshness(CENTER).t, clock.now);

  clock.now += 5 * HOURS;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 1, 'vừa làm mới: 5 giờ sau chưa tải lại');
});

test('làm mới ngầm: ô đang tải thì không gửi thêm truy vấn, chỉ một ô được làm mới mỗi lúc', async (t) => {
  const clock = fakeClock(t);
  const [cx, cy] = cellOf(CENTER);
  const EAST = cellKey(cx + 1, cy);
  const cache = fakeCache([oldRecord(CENTER_KEY, clock.now - 7 * HOURS), oldRecord(EAST, clock.now - 7 * HOURS)]);
  const hung = [];
  const calls = [];
  const impl = (url, opts) => {
    calls.push(decodeURIComponent(opts.body));
    return new Promise((resolve) => hung.push(() => resolve({ ok: true, status: 200, json: async () => sampleResponse() })));
  };
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => true });
  const nearEast = [(cx + 0.9) * CELL, (cy + 0.5) * CELL]; // sát mép Đông: xin cả ô bên cạnh
  roads.ensureAround(nearEast);
  await until(() => roads.reading.size === 0 && calls.length === 1);
  for (let k = 0; k < 20; k++) {
    clock.now += 1000; // định vị mỗi giây trong lúc máy chủ chưa trả lời
    roads.ensureAround(nearEast);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls.length, 1, 'không truy vấn trùng cho ô đang tải, không làm mới song song ô thứ hai');
  assert.equal(roads.pending.size, 1);
  assert.equal(roads.refreshing, CENTER_KEY);
  assert.equal(roads.freshness(CENTER).loading, true);

  hung.shift()();
  await settle(roads);
  assert.equal(roads.refreshing, null);
  roads.ensureAround(nearEast);
  await settle(roads);
  assert.equal(calls.length, 1, 'vừa làm mới xong: nghỉ REFRESH_GAP rồi mới làm mới ô kế tiếp');

  clock.now += REFRESH_GAP;
  roads.ensureAround(nearEast);
  assert.equal(roads.pending.has(EAST), true, 'hết thời gian nghỉ: làm mới ô bên cạnh');
  assert.ok(calls[1].includes(`bbox:${(cy * CELL).toFixed(5)},${((cx + 1) * CELL).toFixed(5)}`));
  hung.shift()();
  await settle(roads);
  assert.equal(calls.length, 2);
});

test('làm mới ngầm không chiếm lượt của ô chưa có dữ liệu', async (t) => {
  const clock = fakeClock(t);
  const [cx, cy] = cellOf(CENTER);
  const cache = fakeCache([oldRecord(CENTER_KEY, clock.now - 7 * HOURS)]);
  const hung = [];
  const impl = () => new Promise((resolve) => hung.push(() => resolve({ ok: true, status: 200, json: async () => sampleResponse() })));
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => true });
  roads.ensureAround(CENTER);
  await until(() => roads.reading.size === 0 && hung.length === 1);
  // Đi sang ô phía Bắc chưa từng tải: tải ngay, dù lượt làm mới ô cũ vẫn đang chờ.
  roads.ensureAround([(cx + 0.5) * CELL, (cy + 1.5) * CELL]);
  await until(() => roads.reading.size === 0 && hung.length === 2);
  assert.equal(roads.pending.has(cellKey(cx, cy + 1)), true);
  while (hung.length) hung.shift()();
  await settle(roads);
});

test('mất mạng: ô cũ (kể cả quá 7 ngày) vẫn được dùng ngay, không thử tải; có mạng lại thì tải lại', async (t) => {
  const clock = fakeClock(t);
  const cache = fakeCache([{ ...oldRecord(CENTER_KEY, clock.now - 30 * 24 * HOURS), feats: parseOverpass(sampleResponse()).feats }]);
  let online = false;
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => online });
  for (let k = 0; k < 5; k++) {
    roads.ensureAround(CENTER);
    await settle(roads);
    clock.now += 120e3;
  }
  assert.equal(calls.length, 0, 'mất mạng: không thử tải lại ô đã có');
  assert.equal(roads.hasData(CENTER), true, 'bản 30 ngày tuổi vẫn cho giới hạn tốc độ và biển báo');
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1);
  assert.equal(roads.status, 'ready');
  assert.equal(roads.failedAt.size, 0, 'mất mạng không bị tính là tải hỏng');

  online = true;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 1, 'có mạng lại: tải lại ngay');
  assert.equal(cache.puts.at(-1).t, clock.now);
});

test('mất mạng vẫn thử tải ô chưa có dữ liệu (navigator.onLine có thể sai)', async () => {
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache: fakeCache(), online: () => false });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 1);
  assert.equal(roads.hasData(CENTER), true);
});

test('làm mới ngầm hỏng: vẫn dùng bản đang có, 10 phút sau mới thử lại ô đó (không phải 60 giây)', async (t) => {
  const clock = fakeClock(t);
  const cache = fakeCache([oldRecord(CENTER_KEY, clock.now - 7 * HOURS)]);
  const down = new TypeError('Failed to fetch');
  const { calls, impl } = fakeFetch([down, down, down, { json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => true });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 3, 'thử đủ ba máy chủ theo thứ tự xoay vòng');
  assert.equal(roads.status, 'ready');
  assert.equal(roads.hasData(CENTER), true);

  clock.now += 5 * 60e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 3, 'chưa đủ 10 phút');

  clock.now += REFRESH_RETRY - 5 * 60e3;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 4);
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1);
});

test('làm mới ngầm: máy chủ trả bản không có đường nào hoặc mốc dữ liệu cũ hơn bản đang có thì không thay, thử máy chủ khác', async (t) => {
  const clock = fakeClock(t);
  const cache = fakeCache([{ ...oldRecord(CENTER_KEY, clock.now - 7 * HOURS), base: '2026-07-28T00:00:00Z' }]);
  const lagging = { ...sampleResponse(), osm3s: { timestamp_osm_base: '2026-07-27T20:00:00Z' } };
  const { calls, impl } = fakeFetch([{ json: { version: 0.6, elements: [] } }, { json: lagging }, { json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache, online: () => true });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.deepEqual(calls.map((c) => c.url), OVERPASS_ENDPOINTS, 'máy chủ 0 trả rỗng, máy chủ 1 chậm giờ, máy chủ 2 dùng được');
  assert.equal(roads.endpoint, 2);
  assert.equal(cache.puts.length, 1);
  assert.equal(roads.dataTimestamp(), '2026-07-28T02:16:18Z');
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1);

  // Mọi máy chủ đều chỉ có bản cũ hơn: giữ nguyên bản đang có, 10 phút sau mới hỏi lại.
  clock.now += REFRESH_AGE;
  const older = { ...sampleResponse(), osm3s: { timestamp_osm_base: '2026-07-01T00:00:00Z' } };
  const { calls: c2, impl: i2 } = fakeFetch([{ json: older }, { json: older }, { json: older }]);
  roads.fetch = i2;
  clock.now += REFRESH_GAP;
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(c2.length, 3);
  assert.equal(cache.puts.length, 1);
  assert.equal(roads.featsNear(SIGNAL, 5).length, 1, 'không mất biển báo đang có');
  assert.equal(roads.status, 'ready');
});

test('đồng hồ máy bị chỉnh lùi (bản ghi tải "ở tương lai"): vẫn được làm mới', async (t) => {
  const clock = fakeClock(t);
  const { calls, impl } = fakeFetch([{ json: sampleResponse() }]);
  const roads = new RoadData({ fetchImpl: impl, cache: fakeCache([oldRecord(CENTER_KEY, clock.now + 24 * HOURS)]), online: () => true });
  roads.ensureAround(CENTER);
  await settle(roads);
  assert.equal(calls.length, 1);
});

test('freshness và freshnessText: câu "Dữ liệu đường quanh đây cập nhật lúc …" cho phần cài đặt', () => {
  const roads = new RoadData();
  assert.equal(roads.freshness(CENTER), null);
  const at = new Date(2026, 10, 24, 9, 5).getTime();
  roads.setCell(CENTER_KEY, { ways: [], points: [], v: VERSION, t: at, base: '2026-11-24T02:04:00Z' });
  assert.deepEqual(roads.freshness(CENTER), { t: at, base: '2026-11-24T02:04:00Z', loading: false });

  const tail = 'Khi có mạng, dữ liệu tự làm mới sau mỗi 6 giờ.';
  assert.equal(freshnessText(roads.freshness(CENTER), new Date(2026, 10, 24, 23, 59)), `Dữ liệu đường quanh đây cập nhật lúc 09:05 hôm nay. ${tail}`);
  assert.equal(freshnessText({ t: at, loading: true }, new Date(2026, 10, 25, 0, 1)), `Dữ liệu đường quanh đây cập nhật lúc 09:05 hôm qua. Đang tải bản mới hơn. ${tail}`);
  assert.equal(freshnessText({ t: at }, new Date(2026, 11, 3, 8, 0)), `Dữ liệu đường quanh đây cập nhật lúc 09:05 ngày 24/11/2026. ${tail}`);
  assert.equal(freshnessText({ t: 0 }), `Dữ liệu đường quanh đây là bản đã lưu từ trước. ${tail}`);
  assert.equal(freshnessText(null), 'Chưa có dữ liệu đường quanh đây. Dữ liệu sẽ được tải khi có mạng.');
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

test('parseOverpass: phố một chiều với ô tô nhưng xe máy đi hai chiều (oneway:motorcycle, rồi oneway:moped)', () => {
  const w = (id, tags) => ({ type: 'way', id, geometry: [N1, N2, N3], tags: { highway: 'residential', ...tags } });
  const data = parseOverpass({
    elements: [
      w(1, { oneway: 'yes', 'oneway:motorcycle': 'no', 'oneway:moped': 'no', 'oneway:bicycle': 'no' }),
      w(2, { oneway: 'yes', 'oneway:moped': 'no' }),
      w(3, { oneway: '-1', 'oneway:motorcycle': 'no' }),
      w(4, { oneway: 'yes', 'oneway:motorcycle': 'yes' }), // giống o: không ghi om
      w(5, { 'oneway:motorcycle': '-1' }), // hai chiều với ô tô, một chiều với xe máy
      w(6, { oneway: 'yes', 'oneway:motorcycle': 'constructor', 'oneway:moped': 'no' }), // giá trị lạ: đọc oneway:moped
      w(7, { oneway: 'yes', 'oneway:bicycle': 'no' }), // chỉ xe đạp được đi hai chiều
    ],
  });
  assert.deepEqual(
    data.ways.map((x) => [x.id, x.o, x.om ?? null]),
    [[1, 1, 0], [2, 1, 0], [3, -1, 0], [4, 1, null], [5, 0, -1], [6, 1, 0], [7, 1, null]],
  );
  assert.deepEqual(data.ways[0].t, { 'oneway:motorcycle': 'no', 'oneway:moped': 'no' });
  assert.equal('t' in data.ways[6], false, 'oneway:bicycle không cần giữ');
});

test('matchWay theo loại xe: xe máy đi ngược chiều vẽ trên phố chỉ một chiều với ô tô vẫn khớp; ô tô và mặc định thì không', () => {
  const roads = singleWay({ o: 1, om: 0 });
  const south = { coord: destination(START, 0, 300), heading: 180, speed: 10, accuracy: 8 };
  assert.equal(roads.matchWay(south), null, 'mặc định là ô tô');
  assert.equal(roads.matchWay(south, '', { vehicle: 'car' }), null);
  const m = roads.matchWay(south, '', { vehicle: 'moto' });
  assert.equal(m.way.id, 10);
  assert.equal(m.dir, -1);
  assert.equal(onewayFor(m.way, 'moto'), 0);
  assert.equal(onewayFor(m.way, 'car'), 1);
  // Đường không có thẻ riêng cho xe máy: xe máy theo chiều chung.
  const plain = singleWay({ o: -1 });
  assert.equal(plain.matchWay({ ...south, heading: 0 }, '', { vehicle: 'moto' }), null);
  assert.equal(onewayFor({ o: -1 }, 'moto'), -1);
  assert.equal(onewayFor({ o: 1, om: 0 }, undefined), 1, 'không rõ loại xe: như ô tô');
});

test('matchWay: đường được ưu tiên (prefer) thắng đường gần hơn vài mét, không thắng đường gần hơn hẳn; only chỉ xét các đường cho trước', () => {
  const g1 = [START, destination(START, 0, 500), destination(START, 0, 1000)];
  const g2 = g1.map((p) => destination(p, 90, 12)); // đường song song cách 12 m
  const roads = new RoadData();
  roads.setCell(cellKey(...cellOf(g1[1])), { ways: [way(1, g1), way(2, g2)], points: [] });
  const off = (m) => ({ coord: destination(destination(START, 0, 500), 90, m), heading: 0, speed: 10, accuracy: 5 });
  const prefer = new Set([1]);
  assert.equal(roads.matchWay(off(7)).way.id, 2);
  assert.equal(roads.matchWay(off(7), '', { prefer }).way.id, 1);
  assert.equal(roads.matchWay(off(12), '', { prefer }).way.id, 2);
  assert.equal(roads.matchWay(off(12), '', { only: prefer }).way.id, 1);
  assert.equal(roads.matchWay(off(50), '', { only: prefer }), null);
});

test('matchWay đi chậm: heading/within bỏ các đường lệch hướng (theo chiều được đi), among chỉ lọc các đường cho trước, không suy ra chiều đi', () => {
  // Ngã tư: đường 1 hai chiều chạy Nam–Bắc qua J, đường 2 từ J sang Đông, đường 3 một chiều vẽ lên Bắc, cách 20 m về phía Tây.
  const J = destination(START, 0, 500);
  const roads = new RoadData();
  const ns = [START, J, destination(J, 0, 500)];
  roads.setCell(cellKey(...cellOf(J)), {
    ways: [way(1, ns), way(2, [J, destination(J, 90, 250), destination(J, 90, 500)]), way(3, ns.map((p) => destination(p, 270, 20)), { o: 1, om: 0 })],
    points: [],
  });
  const fix = { coord: destination(destination(J, 0, 4), 90, 3), speed: 2, heading: 90, accuracy: 5 };
  assert.equal(roads.matchWay(fix).way.id, 1, 'không lọc: đường gần nhất');
  const turned = roads.matchWay(fix, '', { heading: 90, within: 60 });
  assert.equal(turned.way.id, 2, 'đường Nam–Bắc lệch 90° bị bỏ');
  assert.equal(turned.dir, 0, 'đi chậm: không suy ra chiều đi');
  assert.equal(roads.matchWay(fix, '', { heading: 90, within: 60, among: new Set([2]) }).way.id, 1, 'chỉ lọc đường 2');
  assert.equal(roads.matchWay(fix, '', { heading: 90, within: 60, among: new Set([1]) }).way.id, 2);
  assert.equal(roads.matchWay(fix, '', { heading: 170, within: 60 }).way.id, 1, 'đường hai chiều hợp cả hướng ngược lại');
  assert.equal(roads.matchWay(fix, '', { heading: 45, within: 60 }).way.id, 1, 'lệch 45° vẫn giữ');
  // Đường một chiều: ô tô đi ngược chiều thì bị bỏ, xe máy được đi hai chiều (om = 0) thì không.
  const west = { coord: destination(destination(START, 0, 300), 270, 18), speed: 2, heading: 180, accuracy: 5 };
  assert.equal(roads.matchWay(west, '', { heading: 180, within: 60 }).way.id, 1);
  assert.equal(roads.matchWay(west, '', { heading: 180, within: 60, vehicle: 'moto' }).way.id, 3);
  // Đang chạy (trên 2,5 m/s): matchWay tự lọc theo hướng của lần định vị, bỏ qua heading truyền vào.
  const moving = roads.matchWay({ ...fix, speed: 10, heading: 0 }, '', { heading: 90, within: 60 });
  assert.deepEqual([moving.way.id, moving.dir], [1, 1]);
});

// ---- Một đường cắt qua mép ô: mỗi ô giữ một bản đủ hình học, các ô được tải vào những lúc khác nhau ----

const [EX, EY] = cellOf(START);
const EDGE = [EX * CELL, (EY + 0.5) * CELL]; // trên mép Tây của ô chứa START
/** Điểm cách mép ô x m về phía Đông (x < 0: phía Tây, sang ô bên cạnh). */
const fromEdge = (x) => destination(EDGE, x >= 0 ? 90 : 270, Math.abs(x));
const HOME_KEY = cellKey(EX, EY);
const HOUR = 3600e3;

test('đường có bản cũ ở ô phía Tây hoặc phía Nam (bản ghi phiên bản 2, thiếu om): waysAtVertex và matchWay dùng bản của ô phiên bản hiện tại', () => {
  // Phố 2 vẽ từ ô phía Tây sang Đông tới J: một chiều với ô tô, xe máy đi hai chiều. Phố 1 từ J lên phía Bắc.
  const J = fromEdge(300);
  const pts2 = [-200, -100, 0, 100, 200, 300].map(fromEdge);
  const fresh2 = way(2, pts2, { o: 1, om: 0 });
  const { om, ...stale2 } = fresh2; // bản ghi phiên bản 2 của cùng phản hồi: chưa có om
  assert.equal(om, 0);
  const roads1 = [way(1, [J, destination(J, 0, 400)])];
  for (const [dx, dy] of [[-1, 0], [0, -1]]) {
    const roads = new RoadData();
    roads.setCell(HOME_KEY, { ways: [...roads1, fresh2], points: [], v: VERSION, t: Date.now() - 2 * HOUR });
    // Ô bên cạnh tải lại sau nhưng vẫn là bản ghi kiểu cũ: phiên bản đứng trước thời điểm tải.
    roads.setCell(cellKey(EX + dx, EY + dy), { ways: [stale2], points: [], v: 2, t: Date.now() - HOUR });
    const msg = `ô cũ ở (${dx}, ${dy})`;
    const atJ = roads.waysAtVertex(J).map((e) => [e.way.id, e.way.om ?? null]).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(atJ, [[1, null], [2, 0]], msg);
    const on2 = fromEdge(150);
    const still = roads.matchWay({ coord: on2, speed: 0, heading: null, accuracy: 5 }, '', { vehicle: 'moto' });
    assert.equal(still.way, fresh2, `${msg}: đứng yên, hai bản bằng điểm`);
    assert.equal(onewayFor(still.way, 'moto'), 0);
    const west = roads.matchWay({ coord: on2, speed: 6, heading: 270, accuracy: 5 }, '', { vehicle: 'moto' });
    assert.equal(west.way, fresh2, `${msg}: xe máy đi ngược chiều vẽ`);
    assert.equal(west.dir, -1);
  }
});

test('hai bản của một đường lệch chỉ số đỉnh (OSM thêm một nút vào đường giữa hai lần tải ô): mỗi đỉnh chỉ trả về một bản, chỉ số theo bản mới', () => {
  const xs = [];
  for (let x = -300; x <= 500; x += 20) xs.push(x);
  const newer = way(7, [...xs.filter((x) => x < 230), 230, ...xs.filter((x) => x > 230)].map(fromEdge));
  const older = way(7, xs.map(fromEdge));
  const roads = new RoadData();
  roads.setCell(HOME_KEY, { ways: [newer], points: [], v: VERSION, t: Date.now() });
  roads.setCell(cellKey(EX - 1, EY), { ways: [older], points: [], v: VERSION, t: Date.now() - 5 * 24 * HOUR });
  const at = (x) => roads.waysAtVertex(fromEdge(x)).map((e) => [e.way === newer ? 'mới' : 'cũ', e.i]);
  assert.deepEqual(at(260), [['mới', 29]], 'đỉnh giữa phố sau nút mới thêm');
  assert.deepEqual(at(-100), [['mới', 10]], 'đỉnh nằm trong ô phía Tây');
  assert.deepEqual(at(230), [['mới', 27]], 'nút mới thêm');
  // Đi trên đường vẫn khớp bản mới, kể cả ở ô phía Tây.
  assert.equal(roads.matchWay({ coord: fromEdge(-150), speed: 10, heading: 90, accuracy: 5 }).way, newer);
});

test('đường hình chữ P (điểm cuối trùng một đỉnh giữa) có mặt ở hai ô: chỗ nối vẫn trả về hai chỉ số của cùng một bản', () => {
  const neck = fromEdge(100);
  const stem = [-200, -100, 0].map(fromEdge);
  const loop = [neck, destination(neck, 0, 80), destination(destination(neck, 0, 80), 90, 80), destination(neck, 90, 80), neck];
  const p = way(1, [...stem, ...loop]);
  const roads = new RoadData();
  roads.setCell(HOME_KEY, { ways: [p], points: [], v: VERSION, t: Date.now() });
  roads.setCell(cellKey(EX - 1, EY), { ways: [{ ...p }], points: [], v: VERSION, t: Date.now() - HOUR });
  assert.deepEqual(roads.waysAtVertex(neck).map((e) => [e.way === p, e.i]), [[true, 3], [true, 7]]);
});

test('đường dài qua bốn ô tải vào bốn lúc khác nhau: vẫn khớp được ở cả hai đầu', () => {
  const pts = [];
  for (let x = 100; x <= 3.4 * CELL * 111000 * Math.cos((EDGE[1] * Math.PI) / 180); x += 50) pts.push(fromEdge(x));
  const roads = new RoadData();
  for (let k = 0; k < 4; k++) roads.setCell(cellKey(EX + k, EY), { ways: [way(9, pts)], points: [], v: VERSION, t: Date.now() - (4 - k) * HOUR });
  for (const p of [pts[2], pts[pts.length - 3]]) {
    const m = roads.matchWay({ coord: p, speed: 10, heading: 90, accuracy: 5 });
    assert.equal(m?.way.id, 9);
  }
});

// ------------------------------------------------------------------------------------------
// Bản 4 của bộ đệm: cấm theo giờ, tốc độ theo chiều, cấm rẽ qua đường, camera, trạm thu phí vẽ thành vùng
// ------------------------------------------------------------------------------------------

const geomOf = (pts) => pts.map((p) => ({ lat: p.lat, lon: p.lon }));

test('truy vấn Overpass bản 4: nút đường ngầm, camera ALPR, trạm thu phí vẽ thành vùng (out center)', () => {
  const q = buildQuery(...cellOf([106.7, 10.77]));
  assert.ok(q.includes('node.rn["ford"];'));
  assert.ok(q.includes('node["man_made"="surveillance"]["surveillance:type"="ALPR"];'));
  assert.ok(q.includes('way["barrier"="toll_booth"]->.tw;'));
  assert.ok(q.endsWith('.tw out tags center qt;'));
  // Camera giám sát chung không ghi vùng traffic vẫn không được lấy.
  assert.ok(!/node\["man_made"="surveillance"\];/.test(q));
  assert.equal(CACHE_VERSION, 5);
});

test('parseOverpass: thẻ cấm theo giờ giữ trọn (chuỗi phố đi bộ Hoàn Kiếm dài hơn 80 ký tự), minspeed, ford, toll', () => {
  // Chuỗi lấy nguyên từ dữ liệu OSM Hoàn Kiếm (mốc 2026-06-01): khung giờ phố đi bộ nằm sau các khung ngày lễ 2/9,
  // nên cắt ở 80 ký tự là mất đúng phần cần đọc.
  const hk = 'no @ (Aug 29 21:30-23:59; Aug 30 00:01-13:30; Sep 1 17:00-23:59; Sep 2 00:01-16:00; Fr 19:00-23:59; Sa-Su 06:00-23:59)';
  assert.ok(hk.length > 110);
  const data = parseOverpass({
    elements: [
      {
        type: 'way',
        id: 1,
        geometry: [N1, N2],
        tags: { highway: 'tertiary', name: 'Phố Hàng Đào', 'motor_vehicle:conditional': hk, 'taxi:conditional': 'no @ (Mo-Fr 06:00-09:00)' },
      },
      { type: 'way', id: 2, geometry: [N2, N3], tags: { highway: 'motorway', minspeed: '60', toll: 'yes', ford: 'yes' } },
    ],
  });
  assert.equal(data.ways[0].t['motor_vehicle:conditional'], hk);
  assert.equal(data.ways[0].t['taxi:conditional'], undefined, 'thẻ của taxi không cần cho ô tô con, xe máy');
  assert.deepEqual(data.ways[1].t, { minspeed: '60', toll: 'yes', ford: 'yes' });
});

test('parseOverpass: giới hạn tốc độ theo chiều (maxspeed:forward/backward, kể cả riêng ô tô, xe máy)', () => {
  const w = (id, tags) => ({ type: 'way', id, geometry: [N1, N2], tags: { highway: 'primary', ...tags } });
  const data = parseOverpass({
    elements: [
      w(1, { maxspeed: '60' }),
      w(2, { 'maxspeed:forward': '60', 'maxspeed:backward': '40' }),
      w(3, { maxspeed: '50', 'maxspeed:forward': '60' }),
      w(4, { 'maxspeed:motorcar:forward': '80', 'maxspeed:forward': '60', 'maxspeed:backward': '50', 'maxspeed:motorcycle': '40' }),
      w(5, { 'maxspeed:forward': 'signals', 'maxspeed:backward': '50' }),
    ],
  });
  const pick = (way) => ({ c: way.c, cf: way.cf, cb: way.cb, m: way.m, mf: way.mf, mb: way.mb });
  const [a, b, c, d, e] = data.ways.map(pick);
  assert.deepEqual(a, { c: 60, cf: undefined, cb: undefined, m: 60, mf: undefined, mb: undefined }, 'không có thẻ theo chiều: như trước');
  assert.deepEqual(b, { c: null, cf: 60, cb: 40, m: null, mf: 60, mb: 40 });
  assert.deepEqual(c, { c: 50, cf: 60, cb: 50, m: 50, mf: 60, mb: 50 });
  assert.deepEqual(d, { c: null, cf: 80, cb: 50, m: 40, mf: 40, mb: 40 }, 'thẻ riêng của loại xe đứng trước thẻ theo chiều chung');
  assert.deepEqual(e, { c: null, cf: null, cb: 50, m: null, mf: null, mb: 50 }, 'giá trị không đọc được: chiều đó không biết');
});

// Ngã tư Minh Khai – Lạc Trung (Hà Nội): cấm quay đầu qua dải phân cách, "via" là đoạn đường Lạc Trung (OSM 2026-06-01).
const MK_FROM = { type: 'way', id: 711053410, tags: { highway: 'secondary', name: 'Phố Minh Khai', oneway: 'yes' }, geometry: [{ lat: 21.0029308, lon: 105.8698536 }, { lat: 21.0030465, lon: 105.8698084 }] };
const MK_VIA = { type: 'way', id: 711053408, tags: { highway: 'secondary', name: 'Phố Lạc Trung' }, geometry: [{ lat: 21.0030465, lon: 105.8698084 }, { lat: 21.0030382, lon: 105.8697268 }] };
const MK_TO = { type: 'way', id: 711053409, tags: { highway: 'secondary', name: 'Phố Minh Khai', oneway: 'yes' }, geometry: [{ lat: 21.0030382, lon: 105.8697268 }, { lat: 21.0029058, lon: 105.8697779 }] };
const MK_REL = {
  type: 'relation',
  id: 9886764,
  members: [
    { type: 'way', ref: 711053410, role: 'from' },
    { type: 'way', ref: 711053408, role: 'via' },
    { type: 'way', ref: 711053409, role: 'to' },
  ],
  tags: { restriction: 'no_u_turn', type: 'restriction' },
};

test('parseOverpass: cấm quay đầu có "via" là đường (Minh Khai – Lạc Trung): biển đặt ở chỗ from gặp via', () => {
  const data = parseOverpass({ elements: [MK_FROM, MK_VIA, MK_TO, MK_REL] });
  assert.deepEqual(data.restr, [
    { id: 'r9886764', from: 711053410, to: 711053409, via: [105.8698084, 21.0030465], viaWays: [711053408], tags: { restriction: 'no_u_turn', type: 'restriction' } },
  ]);
  // Thiếu đường "via" trong ô: bỏ, không đoán.
  assert.deepEqual(parseOverpass({ elements: [MK_FROM, MK_TO, MK_REL] }).restr, []);
  assert.deepEqual(parseOverpass({ elements: [MK_VIA, MK_TO, MK_REL] }).restr, []);
});

test('parseOverpass: cấm rẽ qua đường mà chiều suy ra ngược đường một chiều thì bỏ (Nguyễn Thị Minh Khai – Bà Huyện Thanh Quan)', () => {
  // Dữ liệu TP.HCM (OSM 2026-07-28): đường "to" một chiều đi VÀO chỗ nối, nên đi theo chuỗi from → via → to là đi
  // ngược chiều. Quan hệ thuộc về chiều khác hoặc vẽ sai: không báo.
  const elements = [
    { type: 'way', id: 227739703, tags: { highway: 'primary', oneway: 'yes' }, geometry: [{ lat: 10.7739193, lon: 106.6897713 }, { lat: 10.7740833, lon: 106.6899262 }, { lat: 10.7747067, lon: 106.69053 }, { lat: 10.7747314, lon: 106.690554 }, { lat: 10.7747898, lon: 106.6906105 }] },
    { type: 'way', id: 1265405856, tags: { highway: 'secondary' }, geometry: [{ lat: 10.7748572, lon: 106.6905386 }, { lat: 10.7747898, lon: 106.6906105 }] },
    { type: 'way', id: 1176155754, tags: { highway: 'secondary', oneway: 'yes' }, geometry: [{ lat: 10.7757532, lon: 106.6895684 }, { lat: 10.7753993, lon: 106.6899518 }, { lat: 10.7749159, lon: 106.6904754 }, { lat: 10.7748572, lon: 106.6905386 }] },
    { type: 'relation', id: 19216405, members: [{ type: 'way', ref: 227739703, role: 'from' }, { type: 'way', ref: 1265405856, role: 'via' }, { type: 'way', ref: 1176155754, role: 'to' }], tags: { restriction: 'no_left_turn', type: 'restriction' } },
  ];
  assert.deepEqual(parseOverpass({ elements }).restr, []);
  // Cùng hình học, đường "to" hai chiều: ghép được.
  const twoWay = elements.map((e) => (e.id === 1176155754 ? { ...e, tags: { highway: 'secondary' } } : e));
  assert.deepEqual(parseOverpass({ elements: twoWay }).restr.map((r) => r.via), [[106.6906105, 10.7747898]]);
});

test('parseOverpass: cấm rẽ qua nhiều đường via (thứ tự thành viên bất kỳ), from một chiều đi ra xa chỗ nối thì bỏ', () => {
  // A (một chiều lên Bắc) → V1 → V2 → B, các đường vẽ nối đầu nhau; thành viên via ghi ngược thứ tự.
  const P = (k) => ({ lat: 10.77 + k * 0.0001, lon: 106.7 });
  const Q = (k) => ({ lat: 10.775, lon: 106.7 + k * 0.0001 });
  const A = { type: 'way', id: 1, geometry: [P(0), P(50)], tags: { highway: 'primary', oneway: 'yes' } };
  const V1 = { type: 'way', id: 2, geometry: [P(50), Q(1)], tags: { highway: 'primary' } };
  const V2 = { type: 'way', id: 3, geometry: [Q(2), Q(1)], tags: { highway: 'primary' } }; // vẽ ngược chiều đi
  const B = { type: 'way', id: 4, geometry: [Q(2), P(-10)], tags: { highway: 'primary' } };
  const rel = (from, extra = {}) => ({
    type: 'relation',
    id: 50,
    members: [
      { type: 'way', ref: from, role: 'from' },
      { type: 'way', ref: 3, role: 'via' },
      { type: 'way', ref: 2, role: 'via' },
      { type: 'way', ref: 4, role: 'to' },
    ],
    tags: { type: 'restriction', restriction: 'no_u_turn', ...extra },
  });
  const ok = parseOverpass({ elements: [A, V1, V2, B, rel(1)] }).restr;
  assert.deepEqual(ok.map((r) => [r.via, r.viaWays]), [[[106.7, 10.775], [3, 2]]]);
  // V2 một chiều ngược hướng đi của chuỗi: bỏ.
  const v2oneway = { ...V2, tags: { highway: 'primary', oneway: 'yes' } };
  assert.deepEqual(parseOverpass({ elements: [A, V1, v2oneway, B, rel(1)] }).restr, []);
  // from một chiều đi ra xa chỗ nối (vẽ từ chỗ nối xuống phía Nam): bỏ.
  const away = { type: 'way', id: 5, geometry: [P(50), P(0)], tags: { highway: 'primary', oneway: 'yes' } };
  assert.deepEqual(parseOverpass({ elements: [away, V1, V2, B, rel(5)] }).restr, []);
});

test('parseOverpass: hướng camera (direction, camera:direction), forward/backward kèm hướng vẽ của đường tại nút', () => {
  const S0 = { lat: 10.77, lon: 106.7 };
  const S1 = { lat: 10.771, lon: 106.7 };
  const S2 = { lat: 10.772, lon: 106.7 };
  const E1 = { lat: 10.771, lon: 106.701 };
  const data = parseOverpass({
    elements: [
      { type: 'way', id: 1, geometry: [S0, S1, S2], tags: { highway: 'trunk' } },
      { type: 'way', id: 2, geometry: [S1, E1], tags: { highway: 'residential' } },
      { type: 'way', id: 3, geometry: [{ lat: 10.78, lon: 106.71 }, { lat: 10.781, lon: 106.71 }], tags: { highway: 'trunk' } },
      { type: 'node', id: 10, lat: 10.7705, lon: 106.7, tags: { highway: 'speed_camera', direction: 'backward' } }, // không nằm trên đường
      { type: 'node', id: 11, lat: 10.781, lon: 106.71, tags: { highway: 'speed_camera', direction: 'forward', maxspeed: '80' } },
      { type: 'node', id: 12, ...S1, tags: { highway: 'speed_camera', direction: 'forward' } }, // nút giao: hai hướng vẽ
      { type: 'node', id: 13, lat: 10.79, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'camera:direction': '135', direction: '0' } },
      { type: 'node', id: 14, lat: 10.795, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'camera', 'camera:direction': '90' } },
      // ALPR ở cổng bãi xe, cổng toà nhà, camera riêng hay trong nhà: không phải camera giao thông.
      { type: 'node', id: 15, lat: 10.796, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'surveillance:zone': 'parking', surveillance: 'private' } },
      { type: 'node', id: 16, lat: 10.797, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'surveillance:zone': 'building' } },
      { type: 'node', id: 17, lat: 10.798, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', surveillance: 'private' } },
      { type: 'node', id: 18, lat: 10.799, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', surveillance: 'indoor' } },
      { type: 'node', id: 19, lat: 10.7995, lon: 106.72, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'surveillance:zone': 'traffic', surveillance: 'public' } },
    ],
  });
  const cam = (id) => data.points.find((p) => p.id === `n${id}`);
  assert.deepEqual([cam(10).dir, cam(10).wb], ['backward', undefined], 'không nằm trên đường: không biết hướng vẽ');
  assert.equal(cam(11).dir, 'forward');
  assert.ok(Math.abs(cam(11).wb) < 0.5, `đường 3 vẽ lên Bắc: ${cam(11).wb}`);
  assert.deepEqual([cam(12).dir, cam(12).wb], ['forward', undefined], 'nút giao của hai đường khác hướng');
  assert.deepEqual([cam(13).kind, cam(13).sub, cam(13).dir], ['camera', 'traffic', '135'], 'ALPR là camera giao thông, đọc camera:direction trước');
  assert.equal(cam(14), undefined, 'camera giám sát chung không ghi vùng traffic: không nhận');
  for (const id of [15, 16, 17, 18]) assert.equal(cam(id), undefined, `ALPR không phải camera giao thông: n${id}`);
  assert.equal(cam(19).sub, 'traffic');
});

test('parseOverpass: quan hệ enforcement có thiết bị là đường (lấy tâm), nút from, đo tốc độ trung bình, tải trọng, chiều cao', () => {
  const data = parseOverpass({
    elements: [
      { type: 'node', id: 1, lat: 10.8, lon: 106.8, tags: { highway: 'speed_camera', maxspeed: '80', direction: 'forward' } },
      {
        type: 'relation',
        id: 90,
        tags: { type: 'enforcement', enforcement: 'maxspeed' }, // không ghi maxspeed: giữ của nút
        members: [
          { type: 'node', ref: 1, role: 'device', lat: 10.8, lon: 106.8 },
          { type: 'node', ref: 2, role: 'from', lat: 10.799, lon: 106.8 },
        ],
      },
      {
        type: 'relation',
        id: 91,
        tags: { type: 'enforcement', enforcement: 'average_speed', maxspeed: '100' },
        members: [
          { type: 'way', ref: 7, role: 'device', geometry: [{ lat: 10.9, lon: 106.9 }, { lat: 10.9002, lon: 106.9002 }] },
          { type: 'node', ref: 8, role: 'to', lat: 10.95, lon: 106.9 },
        ],
      },
      { type: 'relation', id: 92, tags: { type: 'enforcement', enforcement: 'maxweight' }, members: [{ type: 'node', ref: 3, role: 'device', lat: 11, lon: 107 }] },
      { type: 'relation', id: 93, tags: { type: 'enforcement', enforcement: 'maxheight' }, members: [{ type: 'node', ref: 4, role: 'device', lat: 11.1, lon: 107 }] },
      { type: 'relation', id: 94, tags: { type: 'enforcement', enforcement: 'maxspeed' }, members: [{ type: 'node', ref: 5, role: 'from', lat: 11.2, lon: 107 }] }, // không có thiết bị
    ],
  });
  const byId = Object.fromEntries(data.points.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['n1', 'n3', 'n4', 'w7']);
  assert.deepEqual(byId.n1.coord, [106.8, 10.799], 'điểm cảnh báo đặt ở nút from');
  assert.equal(byId.n1.limit, 80);
  assert.equal(byId.n1.dir, 'forward');
  assert.ok(distance(byId.w7.coord, [106.9001, 10.9001]) < 0.01, 'tâm của đường thiết bị');
  assert.deepEqual([byId.w7.sub, byId.w7.avg, byId.w7.limit], ['speed', true, 100]);
  assert.deepEqual([byId.n3.sub, byId.n3.enf], ['traffic', 'weight']);
  assert.deepEqual([byId.n4.sub, byId.n4.enf], ['traffic', 'height']);
});

test('parseOverpass: trạm thu phí vẽ thành vùng (out center) gộp với nút trạm thu phí trong 120 m', () => {
  const data = parseOverpass({
    elements: [
      { type: 'way', id: 70, center: { lat: 10.85, lon: 106.75 }, tags: { barrier: 'toll_booth', name: 'Trạm thu phí An Sương' } },
      { type: 'node', id: 71, lat: 10.8505, lon: 106.75, tags: { barrier: 'toll_booth' } },
      { type: 'way', id: 72, center: { lat: 10.9, lon: 106.75 }, tags: { barrier: 'toll_booth' } },
      { type: 'way', id: 73, tags: { barrier: 'toll_booth' } }, // không có tâm: bỏ
    ],
  });
  const tolls = data.points.filter((p) => p.kind === 'toll');
  assert.deepEqual(tolls.map((p) => [p.id, p.name]), [['w70', 'Trạm thu phí An Sương'], ['w72', '']]);
  assert.deepEqual(tolls[0].coord, [106.75, 10.85]);
});

test('parseOverpass: nút đường ngầm ford=yes trên đường là nút biển', () => {
  const data = parseOverpass({
    elements: [
      { type: 'way', id: 1, geometry: [N1, N2], tags: { highway: 'unclassified' } },
      { type: 'node', id: 1, ...N1, tags: { ford: 'yes' } },
      { type: 'node', id: 2, ...N2, tags: { ford: 'stepping_stones' } },
    ],
  });
  assert.deepEqual(data.feats.map((f) => [f.id, f.tags]), [['n1', { ford: 'yes' }]]);
});
