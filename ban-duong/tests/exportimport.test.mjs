import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { destination } from '../js/geo.js';
import {
  IMPORT_POS_ERR,
  L_IMPORT,
  LearnedSigns,
  MAX_IMPORT_CHARS,
  MAX_IMPORT_FEATURES,
  MAX_RECORDS,
  MAX_TAG_CHARS,
  memoryBackend,
  SPEED_MAX,
  SPEED_MIN,
} from '../js/learnedsigns.js';

// Cờ learn lấy từ danh sách học cố định (như models/labels.json chưa huấn luyện), không đọc tệp đã cài: một lần
// huấn luyện đầy đủ có thể gỡ nhãn khỏi danh sách học (BD_PRUNE) mà phép thử logic học không được phụ thuộc vào đó.
const labels = buildLabels(SIGN_CATALOGUE);
const O = [105.81, 21.015];
const DAY0 = new Date(2026, 10, 23, 12, 0).getTime();

function makeStore(opts = {}) {
  const clock = { t: DAY0 };
  const store = new LearnedSigns({ backend: memoryBackend(), now: () => clock.t, labels, ...opts });
  return { store, clock };
}

const obs = (over = {}) => ({
  code: 'P.127',
  value: '50',
  family: 'ring',
  coord: destination(O, 90, over.x ?? 0),
  facing: 270,
  wayId: 1,
  junction: null,
  branch: null,
  plate: null,
  night: false,
  strong: false,
  posErr: 4,
  osm: false,
  ...over,
});

const feature = (tag, { coord = O, direction = 270, ...props } = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: coord },
  properties: { traffic_sign: tag, direction, ...props },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('xuất: FeatureCollection các biển chưa xác nhận và đã xác nhận, không có ngày trừ khi được chọn', () => {
  const { store, clock } = makeStore();
  const a = store.observe(obs()).record.id;
  clock.t += 864e5;
  store.observe(obs());
  store.observe(obs({ code: 'R.122', value: null, family: 'octagon', x: 400, facing: 268 }));
  const gone = store.observe(obs({ x: 900 })).record.id;
  store.reject(gone);
  const g = store.exportGeoJSON();
  assert.equal(g.type, 'FeatureCollection');
  assert.equal(g.features.length, 2, 'biển bị báo sai không được xuất');
  const f = g.features.find((x) => x.properties.traffic_sign === 'VN:P.127[50]');
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, store.get(a).coord);
  for (const c of f.geometry.coordinates) assert.ok(Math.abs(c * 1e5 - Math.round(c * 1e5)) < 1e-6, 'làm tròn 5 chữ số');
  assert.deepEqual(f.properties, {
    traffic_sign: 'VN:P.127[50]',
    direction: 270,
    'ban_duong:direction_meaning': 'hướng mặt biển nhìn về',
    'ban_duong:status': 'confirmed',
    'ban_duong:seen_days': 2,
  });
  assert.equal(typeof f.properties.direction, 'number');
  const stop = g.features.find((x) => x.properties.traffic_sign === 'VN:R.122');
  assert.equal(stop.properties['ban_duong:status'], 'candidate');
  assert.equal(stop.properties.direction, 268);
  const text = JSON.stringify(g);
  assert.doesNotMatch(text, /first_seen|last_seen|20\d\d-\d\d-\d\d/);
  const dated = store.exportGeoJSON({ withDates: true }).features.find((x) => x.properties.traffic_sign === 'VN:P.127[50]');
  assert.equal(dated.properties['ban_duong:first_seen'], '2026-11-23');
  assert.equal(dated.properties['ban_duong:last_seen'], '2026-11-24');
});

test('nhập: biển hợp lệ thành "chưa xác nhận", src "import"; trùng khoá so khớp thì gộp', () => {
  const { store } = makeStore();
  const r = store.importGeoJSON(
    fc(
      feature('VN:P.127[50]'),
      feature('VN:P.127[50]', { coord: destination(O, 90, 12) }), // cùng biển trong file
      feature('VN:R.122', { coord: destination(O, 90, 300), direction: '90' }),
      feature('VN:W.207', { coord: destination(O, 90, 600), direction: 0 }),
    ),
  );
  assert.deepEqual(r, { added: 3, skipped: 1 });
  const rows = store.list({ near: O });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, 'candidate');
    assert.equal(row.src, 'import');
    assert.equal(row.hitDays, 0);
    assert.equal(row.lastHitDay, null);
  }
  const p = store.get(rows[0].id);
  assert.equal(p.L, L_IMPORT);
  assert.equal(p.posErr, IMPORT_POS_ERR);
  assert.equal(p.family, 'ring');
  assert.equal(rows.find((x) => x.code === 'R.122').facing, 90);
  // Hiện (chưa xác nhận) nhưng không đọc: bộ máy nhận status 'candidate'.
  assert.equal(store.featsNear(O, 30)[0].status, 'candidate');
  assert.equal(store.featsNear(O, 30)[0].src, 'import');
  // Nhập lại cùng tệp: không thêm gì.
  assert.deepEqual(store.importGeoJSON(fc(feature('VN:P.127[50]', { coord: destination(O, 90, 20) }))), { added: 0, skipped: 1 });
});

test('nhập: biển nhập được xác nhận sau một lần chính camera thấy ban ngày (ban đêm chưa đủ)', () => {
  const { store } = makeStore();
  store.importGeoJSON(fc(feature('VN:P.127[50]'), feature('VN:P.102', { coord: destination(O, 90, 500) })));
  const day = store.observe(obs({ x: 3 }));
  assert.equal(day.event, 'hit');
  assert.equal(day.record.status, 'confirmed');
  assert.equal(day.record.src, 'import');
  const night = store.observe(obs({ code: 'P.102', value: null, family: 'noentry', x: 502, night: true }));
  assert.equal(night.event, 'hit');
  assert.equal(night.record.status, 'candidate');
  // Biển nhập trùng chỗ một biển đã bị báo sai: bỏ qua.
  const id = store.observe(obs({ x: 3000 })).record.id;
  store.reject(id);
  assert.deepEqual(store.importGeoJSON(fc(feature('VN:P.127[60]', { coord: destination(O, 90, 3010) }))), { added: 0, skipped: 1 });
});

test('nhập: chỉ nhận mã được học, trị số tốc độ 20–120, hướng 0–360', () => {
  assert.deepEqual([SPEED_MIN, SPEED_MAX], [20, 120]);
  const { store } = makeStore();
  const at = (k) => destination(O, 0, 200 * k);
  const bad = [
    feature('VN:P.103b', { coord: at(1) }), // không thuộc danh sách học
    feature('VN:W.245a', { coord: at(2) }),
    feature('VN:I.409', { coord: at(3) }),
    feature('VN:P.127[25]', { coord: at(4) }), // không phải lớp trị số
    feature('VN:P.127[130]', { coord: at(5) }),
    feature('VN:P.127[5]', { coord: at(6) }),
    feature('VN:P.127[abc]', { coord: at(7) }),
    feature('VN:P.127', { coord: at(8) }), // thiếu trị số
    feature('VN:P.115[10]', { coord: at(9) }), // trị số tải trọng không được đọc
    feature('VN:P.127[50];VN:P.102', { coord: at(10) }), // nhiều biển trong một điểm
    feature('DE:274[50]', { coord: at(11) }),
    feature('maxspeed', { coord: at(12) }),
    feature('vn:p.124a', { coord: at(20) }),
    feature('VN:P.127[50]', { coord: at(13), direction: 400 }),
    feature('VN:P.127[50]', { coord: at(14), direction: -5 }),
    feature('VN:P.127[50]', { coord: at(15), direction: 'N' }),
    feature('VN:P.127[50]', { coord: at(16), direction: null }),
    feature('VN:P.127[50]', { coord: at(17), direction: '1e3' }),
    feature(42, { coord: at(18) }),
    feature('x'.repeat(MAX_TAG_CHARS + 1), { coord: at(19) }),
  ];
  assert.deepEqual(store.importGeoJSON(fc(...bad)), { added: 0, skipped: bad.length });
  const good = [
    feature('VN:P.127[20]', { coord: at(30) }),
    feature('VN:P.127[120]', { coord: at(31) }),
    feature('VN:P.115', { coord: at(32) }),
    feature('VN:P.124a', { coord: at(33), direction: 360 }),
    // Tiền tố viết thường không phải cách app xuất: parseTrafficSign không nhận.
    feature('VN:DP.135', { coord: at(34), direction: '0' }),
  ];
  assert.deepEqual(store.importGeoJSON(fc(...good)), { added: 5, skipped: 0 });
  assert.equal(store.list().find((r) => r.code === 'P.124a').facing, 0);
});

test('nhập: hình học và cấu trúc tệp được kiểm tra phòng thủ', () => {
  const { store } = makeStore();
  const geoms = [
    { type: 'LineString', coordinates: [O, O] },
    { type: 'Point', coordinates: [200, 10] },
    { type: 'Point', coordinates: [105, 95] },
    { type: 'Point', coordinates: [NaN, 10] },
    { type: 'Point', coordinates: ['105', '21'] },
    { type: 'Point' },
    null,
  ];
  const fs = geoms.map((geometry) => ({ type: 'Feature', geometry, properties: { traffic_sign: 'VN:P.102', direction: 1 } }));
  fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: O } }); // không có properties
  fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: O }, properties: ['VN:P.102'] });
  fs.push({ type: 'Polygon' }, null, 'Feature', 7);
  assert.deepEqual(store.importGeoJSON(fc(...fs)), { added: 0, skipped: fs.length });
  assert.equal(store.importGeoJSON({ type: 'Feature' }).error, 'not-geojson');
  assert.equal(store.importGeoJSON({ type: 'FeatureCollection', features: {} }).error, 'not-geojson');
  assert.equal(store.importGeoJSON(null).error, 'not-geojson');
  assert.equal(store.importGeoJSON('{').error, 'bad-json');
  assert.deepEqual(store.importGeoJSON(JSON.stringify(fc(feature('VN:P.102')))), { added: 1, skipped: 0 }, 'nhận cả chuỗi JSON');
});

test('nhập: bỏ biển có chuỗi mang thẻ đánh dấu (<script> …)', () => {
  const { store } = makeStore();
  const fs = [
    feature('VN:P.102<script>alert(1)</script>'),
    feature('<img src=x onerror=alert(1)>'),
    feature('VN:P.102', { 'ban_duong:status': '<script>alert(1)</script>' }),
    feature('VN:P.102', { name: '<b>x</b>' }),
    feature('VN:P.102', { '<script>': 1 }),
    feature('VN:P.102', { direction: '<90>' }),
  ];
  assert.deepEqual(store.importGeoJSON(fc(...fs)), { added: 0, skipped: fs.length });
  assert.equal(store.size, 0);
  // Khoá lạ như "__proto__" không làm hỏng đối tượng nào.
  const proto = JSON.parse('{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[105.81,21.015]},"properties":{"__proto__":{"polluted":1},"traffic_sign":"VN:P.102","direction":90}}]}');
  assert.deepEqual(store.importGeoJSON(proto), { added: 1, skipped: 0 });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('nhập: tệp quá lớn bị từ chối cả tệp (quá 5.000 biển hoặc quá dài)', () => {
  assert.equal(MAX_IMPORT_FEATURES, 5000);
  const { store } = makeStore();
  const many = fc(...Array.from({ length: MAX_IMPORT_FEATURES + 1 }, (_, k) => feature('VN:P.102', { coord: destination(O, 0, 100 * k) })));
  const r = store.importGeoJSON(many);
  assert.equal(r.error, 'too-many');
  assert.equal(r.added, 0);
  assert.equal(store.size, 0);
  assert.equal(store.importGeoJSON(' '.repeat(MAX_IMPORT_CHARS + 1)).error, 'too-large');
  // Đúng 5.000 biển thì nhận (giới hạn kho cũng là 5.000).
  const ok = fc(...Array.from({ length: MAX_IMPORT_FEATURES }, (_, k) => feature('VN:P.102', { coord: destination(O, 0, 100 * k) })));
  assert.deepEqual(store.importGeoJSON(ok), { added: MAX_IMPORT_FEATURES, skipped: 0 });
});

test('nhập: cần labels.json để biết mã nào được học', () => {
  const store = new LearnedSigns({ backend: memoryBackend(), now: () => DAY0 });
  const r = store.importGeoJSON(fc(feature('VN:P.102')));
  assert.equal(r.error, 'no-labels');
  assert.equal(store.size, 0);
  store.setLabels(labels);
  assert.deepEqual(store.importGeoJSON(fc(feature('VN:P.102'))), { added: 1, skipped: 0 });
});

test('xuất rồi nhập vào máy khác: cùng biển, cùng hướng, đều chưa xác nhận', () => {
  const { store, clock } = makeStore();
  store.observe(obs());
  clock.t += 864e5;
  store.observe(obs());
  store.observe(obs({ code: 'W.208', value: null, family: 'invtriangle', x: 300, facing: 91 }));
  const text = JSON.stringify(store.exportGeoJSON());
  const { store: other } = makeStore();
  assert.deepEqual(other.importGeoJSON(text), { added: 2, skipped: 0 });
  const a = store.list({ near: O });
  const b = other.list({ near: O });
  assert.deepEqual(b.map((r) => [r.label, r.facing, r.status]), [['P.127[50]', 270, 'candidate'], ['W.208', 91, 'candidate']]);
  assert.deepEqual(b.map((r) => r.coord), a.map((r) => r.coord));
});

test('xuất: thứ tự biển trong tệp theo toạ độ, không theo thứ tự đã thấy (không lộ đường đã đi)', () => {
  const xs = [0, 300, 600, 900, 1200, 1500];
  const order = (seen) => {
    const { store } = makeStore();
    for (const x of seen) store.observe(obs({ x }));
    return store.exportGeoJSON().features.map((f) => f.geometry.coordinates[0]);
  };
  const east = order(xs);
  const west = order([...xs].reverse());
  const mixed = order([900, 0, 1500, 300, 1200, 600]);
  assert.deepEqual(east, west, 'đi về hướng Đông hay hướng Tây: cùng một tệp');
  assert.deepEqual(mixed, east);
  assert.deepEqual(east, [...east].sort((a, b) => a - b));
  // Cùng chỗ: theo mã biển rồi theo hướng.
  const { store } = makeStore();
  store.observe(obs({ code: 'R.122', value: null, family: 'octagon', facing: 90 }));
  store.observe(obs({ code: 'P.102', value: null, family: 'noentry', facing: 270 }));
  store.observe(obs({ code: 'P.102', value: null, family: 'noentry', facing: 90 }));
  assert.deepEqual(
    store.exportGeoJSON().features.map((f) => `${f.properties.traffic_sign}@${f.properties.direction}`),
    ['VN:P.102@90', 'VN:P.102@270', 'VN:R.122@90'],
  );
});

test('nhập khi kho đầy: không bỏ biển chính camera đã học để lấy chỗ; dừng và báo "full"', () => {
  const { store } = makeStore();
  // Gần đầy: MAX_RECORDS − 1 biển do camera ghi nhận (chưa xác nhận, có thể bị bỏ khi camera thấy biển mới).
  for (let i = 0; i < MAX_RECORDS - 1; i++) store.observe(obs({ code: 'W.207', value: null, family: 'triangle', x: 40 * i }));
  const own = store.size;
  const far = (k) => feature('VN:R.122', { coord: destination([106.5, 10.8], 0, 50 * k), direction: 90 });
  const r = store.importGeoJSON(fc(far(0), far(1), far(2)));
  assert.deepEqual(r, { added: 1, skipped: 2, error: 'full' });
  assert.equal(store.size, MAX_RECORDS);
  assert.equal(store.list().filter((x) => x.src === 'camera').length, own, 'không mất biển nào do camera học');
  assert.deepEqual(store.importGeoJSON(fc(far(5))), { added: 0, skipped: 1, error: 'full' });
});
