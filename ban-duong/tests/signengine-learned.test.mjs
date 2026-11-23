import test from 'node:test';
import assert from 'node:assert/strict';
import { destination } from '../js/geo.js';
import { cellKey, cellOf, RoadData } from '../js/roaddata.js';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { CAMERA_SUFFIX, dayDate, joinSays, LEARNED_OSM_GAP, mapItems, PLATE_SUFFIX, SignEngine } from '../js/signengine.js';
import { dayNumber, dayString, LearnedSigns, memoryBackend } from '../js/learnedsigns.js';

// Biển do camera trên xe ghi nhận đi qua bộ máy cảnh báo (PLAN §4.3, §5.9, §8.1). Dùng kho LearnedSigns thật với
// nơi lưu trong bộ nhớ. Thế giới dựng bằng hình học (không phải đường thật): một đường thẳng về hướng Đông dài
// 1,4 km, đỉnh mỗi 10 m, nằm giữa một ô dữ liệu 0,03°.

const labels = buildLabels(SIGN_CATALOGUE);
const O = [105.81, 21.015];
const along = (x) => destination(O, 90, x);
const DAY1 = new Date(2026, 10, 22, 12, 0).getTime(); // 22/11/2026, 12:00 giờ máy
const NOON = new Date(2026, 10, 23, 12, 0);
const END = 'Có thể nhận nhầm hoặc biển đã được dỡ. Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.';
const PUBLIC_KEYS = ['key', 'kind', 'code', 'title', 'say', 'cat', 'distance', 'art', 'value', 'derived', 'note', 'coord'];

function world(feats = []) {
  const main = [];
  for (let x = 0; x <= 1400; x += 10) main.push(along(x));
  const roads = new RoadData({ fetchImpl: () => Promise.reject(new Error('không có mạng')), cache: { get: async () => null, put: () => {} } });
  const ways = [{ id: 1, n: 'Đường chính', h: 'primary', c: null, m: null, o: 0, g: main.flat() }];
  roads.setCell(cellKey(...cellOf(O)), { ways, feats, v: 3, t: Date.now() });
  return roads;
}

/** Nút bản đồ: trên đường (onWay, phải trùng một đỉnh: x chia hết cho 10) hoặc biển đứng riêng. */
const osm = (id, coord, tags, onWay = false) => ({ id: `n${id}`, coord, onWay, tags });
const SIGNALS = (x) => osm(`s${x}`, along(x), { highway: 'traffic_signals' }, true);
const BUMP = (x) => osm(`b${x}`, along(x), { traffic_calming: 'bump' }, true);
const SIGN = (id, coord, tag) => osm(id, coord, { traffic_sign: tag, 'traffic_sign:direction': '270' });

function newStore() {
  const clock = { t: DAY1 };
  let seed = 12345;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  return { store: new LearnedSigns({ backend: memoryBackend(), now: () => clock.t, labels, random }), clock };
}

// Hướng mặt biển 270 (quay về phía Tây): áp dụng cho xe đi về hướng Đông.
const obs = ({ x = 500, code = 'P.127', value = '50', family = 'ring', facing = 270, plate = null } = {}) => ({
  code,
  value,
  family,
  coord: along(x),
  facing,
  wayId: 1,
  junction: null,
  branch: null,
  plate,
  night: false,
  strong: false,
  posErr: 4,
});

/** Camera thấy các biển này hôm nay (chưa xác nhận); twice: thấy lại vào ngày hôm sau (tự xác nhận). */
function learned(signs, { twice = true } = {}) {
  const { store, clock } = newStore();
  const ids = signs.map((s) => store.observe(obs(s)).record.id);
  if (twice) {
    clock.t += 864e5;
    for (const s of signs) store.observe(obs(s));
  }
  return { store, clock, ids };
}

/** Chạy thẳng với tốc độ v (m/s), mỗi giây một lần định vị, từ x = from tới to (về hướng Đông) hoặc ngược lại. */
function drive(roads, { store = null, east = true, settings = {}, from = 150, to = 850, v = 14, engine = new SignEngine() } = {}) {
  const log = [];
  const n = Math.floor((to - from) / v);
  for (let k = 0; k <= n; k++) {
    const x = east ? from + k * v : to - k * v;
    const fix = { coord: along(x), speed: v, heading: east ? 90 : 270, accuracy: 5, time: 1e6 + k * 1000 };
    log.push({ x, ...engine.update(fix, roads, settings, { vehicle: 'car', now: NOON, learned: store }) });
  }
  return log;
}

const said = (log) => log.filter((r) => r.say).map((r) => r.say);
const shown = (r) => [r.active && r.active.item, ...r.upcoming, ...r.fired].filter(Boolean);
const camShown = (log) => log.flatMap((r) => shown(r).filter((it) => it.src));

// ---------------------------------------------------------------------------------------------
// Chiều đi, chưa xác nhận, lời rào
// ---------------------------------------------------------------------------------------------

test('biển đã học được báo khi còn 100–200 m theo chiều Đông, im lặng theo chiều Tây', () => {
  const { store } = learned([{ x: 500 }]);
  const roads = world();
  const east = drive(roads, { store });
  const fired = east.flatMap((r) => r.fired.filter((it) => it.src).map((it) => ({ ahead: 500 - r.x, it, say: r.say })));
  assert.equal(fired.length, 1);
  assert.ok(fired[0].ahead >= 100 && fired[0].ahead <= 200, `báo khi còn ${fired[0].ahead} m`);
  assert.equal(fired[0].say, 'Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)');
  assert.equal(fired[0].it.src, 'camera');
  assert.equal(fired[0].it.quiet, false);
  assert.equal(fired[0].it.meta.hitDays, 2);
  assert.deepEqual(said(east), [fired[0].say], 'đọc đúng một lần');

  const west = drive(roads, { store, east: false });
  assert.deepEqual(said(west), []);
  assert.deepEqual(camShown(west), [], 'chiều ngược lại: không hiện');
});

test('biển camera mới thấy một lần (chưa xác nhận): hiện nét đứt nhưng không bao giờ được đọc', () => {
  const { store } = learned([{ x: 500 }], { twice: false });
  const roads = world([SIGNALS(520)]);
  const log = drive(roads, { store });
  // Câu đọc y như khi không có biển camera.
  assert.deepEqual(said(log), said(drive(roads)));
  assert.deepEqual(said(log), ['Phía trước 100 mét, đèn tín hiệu giao thông']);
  assert.equal(log.flatMap((r) => r.fired).filter((it) => it.src).length, 0, 'không bao giờ nằm trong fired');
  const active = log.map((r) => r.active && r.active.item).filter((it) => it && it.src);
  assert.ok(active.length > 0, 'có lúc hiện trên thanh cảnh báo');
  assert.ok(active.every((it) => it.quiet === true && it.src === 'camera' && it.meta.hitDays === 1));
  assert.ok(log.some((r) => r.upcoming.some((it) => it.src && it.quiet)), 'có trong danh sách sắp tới');
  // Đi chậm hơn, nhanh hơn: vẫn không đọc.
  for (const v of [6, 22]) assert.deepEqual(said(drive(world(), { store, v })), []);
});

test('lời rào: đúng câu chữ, kể cả khi gộp với biển bản đồ và với biển camera khác', () => {
  const sentence = (signs, feats = []) => said(drive(world(feats), { store: learned(signs).store }));
  const P123A = { code: 'P.123a', value: null, family: 'ring' };
  const P124A = { code: 'P.124a', value: null, family: 'ring' };
  const P125 = { code: 'P.125', value: null, family: 'ring' };
  assert.deepEqual(sentence([{ x: 500 }]), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)']);
  assert.deepEqual(sentence([{ x: 500, plate: 'unread' }]), [
    'Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ, có biển phụ (camera ghi nhận)',
  ]);
  // Biển bản đồ đọc trước, biển camera sau cùng (dù biển camera ở gần hơn).
  assert.deepEqual(sentence([{ x: 500 }], [SIGNALS(510)]), [
    'Phía trước 100 mét, đèn tín hiệu giao thông, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)',
  ]);
  // Hai, ba biển camera: nối bằng "và", lời rào nói một lần.
  assert.deepEqual(sentence([{ x: 500, ...P123A }, { x: 520, ...P124A }]), ['Phía trước 100 mét, cấm rẽ trái và cấm quay đầu (camera ghi nhận)']);
  assert.deepEqual(sentence([{ x: 500, ...P123A }, { x: 510, ...P124A }, { x: 520, ...P125 }]), [
    'Phía trước 100 mét, cấm rẽ trái, cấm quay đầu và cấm vượt (camera ghi nhận)',
  ]);
  assert.deepEqual(sentence([{ x: 500, ...P123A }, { x: 520, ...P124A }], [SIGNALS(510)]), [
    'Phía trước 100 mét, đèn tín hiệu giao thông, cấm rẽ trái và cấm quay đầu (camera ghi nhận)',
  ]);
  // Có biển phụ: mỗi biển camera giữ lời rào của nó, để "có biển phụ" không bị hiểu là của biển sau.
  assert.deepEqual(sentence([{ x: 500, ...P123A, plate: 'unread' }, { x: 520, ...P124A }]), [
    'Phía trước 100 mét, cấm rẽ trái, có biển phụ (camera ghi nhận), cấm quay đầu (camera ghi nhận)',
  ]);
  // Câu đã đủ 3 loại biển bản đồ: biển camera được đọc ở câu sau, không chiếm chỗ của biển bản đồ.
  assert.deepEqual(sentence([{ x: 500, ...P123A }], [SIGNALS(510), BUMP(520), SIGN('p', along(530), 'VN:P.125')]), [
    'Phía trước 100 mét, đèn tín hiệu giao thông, gờ giảm tốc, cấm vượt',
    'Phía trước 70 mét, cấm rẽ trái (camera ghi nhận)',
  ]);
  assert.equal(CAMERA_SUFFIX, ' (camera ghi nhận)');
  assert.equal(PLATE_SUFFIX, ', có biển phụ');
});

test('joinSays: mục bản đồ như trước (bỏ câu trùng), biển camera sau cùng', () => {
  const m = (say) => ({ say });
  const c = (say, plate = null) => ({ say: `${say}${plate ? PLATE_SUFFIX : ''}${CAMERA_SUFFIX}`, src: 'camera', meta: { plate } });
  assert.equal(joinSays([m('đèn tín hiệu giao thông'), m('gờ giảm tốc'), m('đèn tín hiệu giao thông')]), 'đèn tín hiệu giao thông, gờ giảm tốc');
  assert.equal(joinSays([c('cấm rẽ trái'), m('gờ giảm tốc')]), 'gờ giảm tốc, cấm rẽ trái (camera ghi nhận)');
  assert.equal(joinSays([c('cấm rẽ trái'), c('cấm rẽ trái')]), 'cấm rẽ trái (camera ghi nhận)');
  assert.equal(joinSays([c('cấm rẽ trái'), c('cấm vượt')]), 'cấm rẽ trái và cấm vượt (camera ghi nhận)');
  assert.equal(joinSays([c('cấm rẽ trái'), c('cấm vượt', 'unread')]), 'cấm rẽ trái (camera ghi nhận), cấm vượt, có biển phụ (camera ghi nhận)');
  assert.equal(joinSays([]), '');
});

// ---------------------------------------------------------------------------------------------
// Dữ liệu bản đồ luôn thắng
// ---------------------------------------------------------------------------------------------

test(`biển bản đồ cùng loại trong ${LEARNED_OSM_GAP} m dọc đường: bỏ biển camera; cách 31 m thì giữ`, () => {
  assert.equal(LEARNED_OSM_GAP, 30);
  const { store, ids } = learned([{ x: 500 }]);
  const at = store.get(ids[0]).coord; // toạ độ đã làm tròn của bản ghi
  for (const gap of [0, 12, 25, LEARNED_OSM_GAP - 0.01, -20, -(LEARNED_OSM_GAP - 0.01)]) {
    const roads = world([SIGN('o', destination(at, 90, gap), 'VN:P.127[50]')]);
    const log = drive(roads, { store });
    assert.deepEqual(camShown(log), [], `biển bản đồ cách ${gap} m: biển camera không bao giờ hiện`);
    assert.deepEqual(said(log), said(drive(roads)), `cách ${gap} m: câu đọc như khi không có camera`);
    assert.deepEqual(said(log).length, 1);
    assert.doesNotMatch(said(log)[0], /camera/);
  }
  for (const gap of [31, -31]) {
    const roads = world([SIGN('o', destination(at, 90, gap), 'VN:P.127[50]')]);
    const log = drive(roads, { store });
    assert.ok(camShown(log).length > 0, `biển bản đồ cách ${gap} m: biển camera vẫn hiện`);
    // Cùng một câu (cách nhau dưới 40 m): câu đọc lấy theo biển bản đồ, không có lời rào.
    assert.deepEqual(said(log), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ']);
  }
});

test(`cuối hành lang dài đủ: biển camera chỉ hiện khi đã thấy được ${LEARNED_OSM_GAP} m sau nó; đường cụt thì vẫn báo`, () => {
  const { store } = learned([{ x: 500 }]);
  const roads = world();
  const engine = new SignEngine();
  const at = (x, k) =>
    engine.update({ coord: along(x), speed: 14, heading: 90, accuracy: 5, time: 1e6 + k * 1000 }, roads, {}, { now: NOON, learned: store });
  // Hành lang 320 m: biển camera cách 295 m (trong 30 m cuối) chưa hiện, cách 285 m thì hiện.
  assert.equal(at(205, 0).upcoming.filter((it) => it.src).length, 0);
  assert.equal(at(215, 1).upcoming.filter((it) => it.src).length, 1);
  // Đường cụt ở 600 m: hành lang ngắn, biển camera sát cuối đường vẫn được hiện và đọc.
  const main = [];
  for (let x = 0; x <= 600; x += 10) main.push(along(x));
  const dead = new RoadData({ fetchImpl: () => Promise.reject(new Error('không có mạng')), cache: { get: async () => null, put: () => {} } });
  dead.setCell(cellKey(...cellOf(O)), { ways: [{ id: 1, n: 'Ngõ', h: 'residential', c: null, m: null, o: 0, g: main.flat() }], feats: [], v: 3, t: Date.now() });
  const { store: s2 } = learned([{ x: 590 }]);
  assert.deepEqual(said(drive(dead, { store: s2, from: 300, to: 600 })), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)']);
});

test('biển camera không có trị số trùng biển bản đồ cùng mã có trị số: bỏ biển camera', () => {
  const { store } = learned([{ x: 500, code: 'P.115', value: null, family: 'ring' }]);
  const alone = drive(world(), { store });
  assert.deepEqual(said(alone), ['Phía trước 100 mét, hạn chế trọng tải (camera ghi nhận)']);
  const roads = world([SIGN('o', along(515), 'VN:P.115[10]')]);
  const log = drive(roads, { store });
  assert.deepEqual(camShown(log), []);
  assert.deepEqual(said(log), said(drive(roads)));
});

test('biển camera đã đọc không làm biển bản đồ cùng loại phía sau thôi đọc; ngược lại thì có', () => {
  const { store } = learned([{ x: 400 }]);
  const after = drive(world([SIGN('o', along(470), 'VN:P.127[50]')]), { store });
  assert.deepEqual(said(after), [
    'Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)',
    'Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ',
  ]);
  const { store: s2 } = learned([{ x: 470 }]);
  const before = drive(world([SIGN('o', along(400), 'VN:P.127[50]')]), { store: s2 });
  assert.deepEqual(said(before), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ'], 'biển camera cùng loại ngay sau: coi như đã báo');
});

// ---------------------------------------------------------------------------------------------
// Cài đặt
// ---------------------------------------------------------------------------------------------

test('signCamera: false ẩn mọi biển camera; kết quả y như không có kho biển', () => {
  const { store } = learned([{ x: 500 }, { x: 600, code: 'P.123a', value: null }]);
  const roads = world([SIGNALS(700)]);
  const off = drive(roads, { store, settings: { signCamera: false } });
  assert.deepEqual(camShown(off), []);
  assert.deepEqual(off, drive(roads, { settings: { signCamera: false } }));
  assert.deepEqual(off, drive(roads));
  assert.ok(camShown(drive(roads, { store, settings: { signCamera: true } })).length > 0);
});

test('bật/tắt nhóm biển vẫn áp dụng cho biển camera', () => {
  const { store } = learned([{ x: 500 }, { x: 650, code: 'P.123a', value: null }]);
  const roads = world();
  const codes = (log) => [...new Set(camShown(log).map((it) => it.code))].sort();
  assert.deepEqual(codes(drive(roads, { store })), ['P.123a', 'P.127']);
  const noSpeed = drive(roads, { store, settings: { signSpeed: false } });
  assert.deepEqual(codes(noSpeed), ['P.123a']);
  assert.deepEqual(said(noSpeed), ['Phía trước 100 mét, cấm rẽ trái (camera ghi nhận)']);
  const noProhibit = drive(roads, { store, settings: { signProhibit: false } });
  assert.deepEqual(codes(noProhibit), ['P.127']);
  assert.deepEqual(said(noProhibit), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)']);
});

// ---------------------------------------------------------------------------------------------
// Bộ nhớ tạm, dạng dữ liệu, độ bền
// ---------------------------------------------------------------------------------------------

test('cùng một nút biển qua nhiều lần cập nhật: không tính lại; bản ghi đổi thì tính lại', () => {
  const { store, ids } = learned([{ x: 500 }], { twice: false });
  const got = [];
  const spy = {
    featsNear(coord, radius) {
      const out = store.featsNear(coord, radius);
      got.push(...out);
      return out;
    },
  };
  const roads = world();
  const engine = new SignEngine();
  const step = (k) =>
    engine.update({ coord: along(300 + k), speed: 14, heading: 90, accuracy: 5, time: 1e6 + k * 1000 }, roads, {}, { now: NOON, learned: spy });
  const a = step(0);
  const feat = got[0];
  assert.ok(feat && Object.isFrozen(feat));
  const cached = engine.memo.camFeats.get(feat);
  assert.ok(Array.isArray(cached) && cached.length === 1);
  assert.equal(a.upcoming.find((it) => it.src).quiet, true);
  got.length = 0;
  step(1);
  step(2);
  assert.ok(got.length > 0 && got.every((f) => f === feat), 'kho trả về cùng đối tượng');
  assert.equal(engine.memo.camFeats.get(feat), cached, 'bộ nhớ tạm không tính lại');
  store.confirm(ids[0]);
  got.length = 0;
  const b = step(3);
  assert.ok(got.length > 0 && got.every((f) => f !== feat), 'bản ghi đổi: đối tượng mới');
  assert.notEqual(engine.memo.camFeats.get(got[0]), cached);
  assert.equal(b.upcoming.find((it) => it.src).quiet, false);
});

test('dạng mục: biển bản đồ giữ nguyên các khoá cũ; biển camera thêm src, quiet, meta', () => {
  const { store } = learned([{ x: 500 }]);
  const roads = world([SIGNALS(600)]);
  const engine = new SignEngine();
  const r = engine.update({ coord: along(420), speed: 14, heading: 90, accuracy: 5, time: 1e6 }, roads, {}, { now: NOON, learned: store });
  const cam = r.upcoming.find((it) => it.src);
  const map = r.upcoming.find((it) => !it.src);
  assert.deepEqual(Object.keys(map), PUBLIC_KEYS);
  assert.deepEqual(Object.keys(cam), [...PUBLIC_KEYS, 'src', 'quiet', 'meta']);
  assert.equal(cam.key.startsWith('L'), true);
  assert.deepEqual(cam.meta, { hitDays: 2, firstDay: dayNumber(DAY1), lastHitDay: dayNumber(DAY1) + 1, plate: null });
  assert.equal(cam.derived, false);
  assert.equal(cam.code, 'P.127');
  assert.equal(cam.value, 50);
});

test('mapItems chỉ có dữ liệu bản đồ; lastCorridor và lastCorridorTime vẫn đúng khi có biển camera', () => {
  const { store } = learned([{ x: 500 }]);
  const roads = world([SIGNALS(600)]);
  const engine = new SignEngine();
  const fix = { coord: along(420), speed: 14, heading: 90, accuracy: 5, time: 1_234_000 };
  const r = engine.update(fix, roads, {}, { now: NOON, learned: store });
  assert.ok(r.upcoming.some((it) => it.src));
  assert.equal(engine.lastCorridorTime, fix.time);
  assert.ok(engine.lastCorridor.coords.length >= 2);
  const items = mapItems(engine.lastCorridor, roads);
  assert.deepEqual(
    items.map((it) => it.key),
    ['ns600:signals'],
  );
});

test('kho biển lỗi hoặc trả dữ liệu lạ: cảnh báo từ bản đồ vẫn y như không có kho', () => {
  const roads = world([SIGNALS(520)]);
  const base = drive(roads);
  const broken = {
    featsNear() {
      throw new Error('hỏng');
    },
  };
  const junk = {
    featsNear: () => [null, { id: 5 }, { id: 'Lx', coord: [Number.NaN, 21], tags: {} }, { id: 'Ly', coord: along(500) }],
  };
  assert.deepEqual(drive(roads, { store: broken }), base);
  assert.deepEqual(drive(roads, { store: junk }), base);
  assert.deepEqual(drive(roads, { store: {} }), base);
  assert.deepEqual(drive(roads, { store: { featsNear: () => null } }), base);
});

// ---------------------------------------------------------------------------------------------
// Ghi chú trên bảng chi tiết và ngày
// ---------------------------------------------------------------------------------------------

/** Ghi chú của biển camera đầu tiên hiện ra. */
const noteOf = (store, engine = new SignEngine()) => {
  const r = engine.update({ coord: along(420), speed: 14, heading: 90, accuracy: 5, time: 1e6 }, world(), {}, { now: NOON, learned: store });
  return r.upcoming.find((it) => it.src).note;
};

test('ghi chú: nguồn camera, ngày thấy (dd/mm/yyyy), lời nhắc tuân theo biển thật', () => {
  assert.equal(
    noteOf(learned([{ x: 500 }]).store),
    `Biển do camera trên xe ghi nhận, không lấy từ bản đồ. Thấy lần đầu ngày 22/11/2026, đã thấy vào 2 ngày, lần gần nhất ngày 23/11/2026. ${END}`,
  );
  assert.equal(
    noteOf(learned([{ x: 500 }], { twice: false }).store),
    `Biển do camera trên xe ghi nhận, không lấy từ bản đồ. Thấy ngày 22/11/2026, chưa thấy lại vào ngày khác. Chưa xác nhận nên không đọc thành tiếng. ${END}`,
  );
  assert.equal(
    noteOf(learned([{ x: 500, plate: 'unread' }]).store),
    'Biển do camera trên xe ghi nhận, không lấy từ bản đồ. Thấy lần đầu ngày 22/11/2026, đã thấy vào 2 ngày, lần gần nhất ' +
      `ngày 23/11/2026. Có biển phụ bên dưới, ứng dụng không đọc được nội dung. ${END}`,
  );
  // Thấy vào 3 ngày, qua năm mới.
  const { store, clock } = newStore();
  clock.t = new Date(2026, 11, 31, 9, 0).getTime();
  store.observe(obs());
  clock.t = new Date(2027, 0, 1, 7, 0).getTime();
  store.observe(obs());
  clock.t = new Date(2027, 0, 9, 18, 0).getTime();
  store.observe(obs());
  assert.equal(
    noteOf(store),
    `Biển do camera trên xe ghi nhận, không lấy từ bản đồ. Thấy lần đầu ngày 31/12/2026, đã thấy vào 3 ngày, lần gần nhất ngày 09/01/2027. ${END}`,
  );
  // Định dạng ngày thay được (dùng cho kiểm thử, hoặc cách viết ngày khác).
  const custom = noteOf(learned([{ x: 500 }]).store, new SignEngine({ formatDay: (d) => `#${d}` }));
  assert.match(custom, new RegExp(`Thấy lần đầu ngày #${dayNumber(DAY1)}, đã thấy vào 2 ngày, lần gần nhất ngày #${dayNumber(DAY1) + 1}\\.`));
});

test('biển nhập từ tệp: ghi chú nói rõ nguồn; chưa xác nhận thì chỉ hiện; camera thấy lại thì được đọc', () => {
  const { store, clock } = newStore();
  const fc = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: along(500) }, properties: { traffic_sign: 'VN:P.127[50]', direction: 270 } }],
  };
  assert.deepEqual(store.importGeoJSON(fc), { added: 1, skipped: 0 });
  const roads = world();
  const log = drive(roads, { store });
  assert.deepEqual(said(log), []);
  const it = camShown(log)[0];
  assert.equal(it.src, 'import');
  assert.equal(it.quiet, true);
  assert.equal(
    it.note,
    `Biển lấy từ tệp đã nhập, không lấy từ bản đồ. Nhập ngày 22/11/2026. Camera trên xe chưa thấy biển này. Chưa xác nhận nên không đọc thành tiếng. ${END}`,
  );
  // Một lần chính camera của máy này thấy (ban ngày) là đủ xác nhận biển nhập.
  clock.t += 864e5;
  assert.equal(store.observe(obs()).record.status, 'confirmed');
  const again = drive(roads, { store });
  assert.deepEqual(said(again), ['Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)']);
  const it2 = camShown(again)[0];
  assert.equal(it2.src, 'import');
  assert.equal(it2.quiet, false);
  assert.equal(
    it2.note,
    `Biển lấy từ tệp đã nhập, không lấy từ bản đồ. Nhập ngày 22/11/2026. Camera trên xe đã thấy biển này vào 1 ngày, lần gần nhất ngày 23/11/2026. ${END}`,
  );
});

test('dayDate: số thứ tự ngày theo lịch của máy → dd/mm/yyyy, ở mọi múi giờ', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['Asia/Ho_Chi_Minh', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = zone;
      for (const [y, m, d, h, min] of [
        [2026, 10, 12, 0, 10],
        [2026, 10, 12, 23, 50],
        [2027, 0, 1, 0, 0],
        [2028, 1, 29, 12, 0],
      ]) {
        const day = dayNumber(new Date(y, m, d, h, min).getTime());
        const want = `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${y}`;
        assert.equal(dayDate(day), want, `${zone} ${want} ${h}:${min}`);
        assert.equal(dayDate(day), dayString(day).split('-').reverse().join('/'));
      }
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  assert.equal(dayDate(null), null);
  assert.equal(dayDate(Number.NaN), null);
});
