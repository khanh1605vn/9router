// Dữ liệu cộng đồng: bộ kiểm tra data/community.json, bộ tải (bản mới thắng, bản sai bị bỏ, dùng bản đã lưu khi mất
// mạng), đổi thành điểm cảnh báo đi qua AlertEngine như điểm tự đánh dấu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { destination } from '../js/geo.js';
import { AlertEngine, facingApplies, POINT_FACING_TOLERANCE } from '../js/alerts.js';
import {
  byteLength,
  cleanString,
  COMMUNITY_TYPES,
  dayNumber,
  MAX_BYTES,
  MAX_ITEMS,
  MAX_NOTE,
  normalizeItem,
  validateCommunity,
  viDate,
} from '../js/communitydata.js';
import {
  COMMUNITY_CACHE_KEY,
  COMMUNITY_REFRESH_MS,
  COMMUNITY_REMOTE,
  CommunityData,
  communityPoints,
  communitySummary,
  detailLines,
  fetchText,
  pickNewest,
  withOwnInfo,
} from '../js/community.js';

const TODAY = '2026-11-27';
const HN = [105.8542, 21.0285]; // Hồ Hoàn Kiếm
const item = (over = {}) => ({ type: 'camera-speed', coord: HN, source: 'Chủ ứng dụng khảo sát', verified: '2026-11-20', ...over });
const doc = (items = [], over = {}) => ({ schema: 1, updated: '2026-11-25', items, ...over });

// ---------------------------------------------------------------------------------------------
// Bộ kiểm tra
// ---------------------------------------------------------------------------------------------

test('tệp data/community.json đi kèm ứng dụng hợp lệ và rỗng (không có mục bịa)', () => {
  const text = readFileSync(new URL('../data/community.json', import.meta.url), 'utf8');
  const r = validateCommunity(text, { today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.data.schema, 1);
  assert.deepEqual(JSON.parse(text).items, []);
  assert.ok(dayNumber(r.data.updated) != null);
});

test('kiểm tra: mục hợp lệ được giữ, chỉ các trường đã biết, toạ độ làm tròn 6 chữ số', () => {
  const r = validateCommunity(
    doc([item({ value: 60, direction: 90, note: '  Trước  cổng\tchợ ', coord: [105.85420049, 21.02850011], html: '<b>x</b>', extra: 1 })]),
    { today: TODAY }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.items, [
    {
      id: 'camera-speed-21.02850-105.85420',
      type: 'camera-speed',
      coord: [105.8542, 21.0285],
      direction: 90,
      value: 60,
      note: 'Trước cổng chợ',
      source: 'Chủ ứng dụng khảo sát',
      verified: '2026-11-20',
    },
  ]);
});

test('kiểm tra: loại ngoài danh sách bị bỏ', () => {
  assert.deepEqual(COMMUNITY_TYPES, ['camera-speed', 'camera-redlight', 'camera-traffic', 'speed-limit', 'sign', 'hazard', 'closure']);
  for (const type of ['mobile-police', 'CAMERA-SPEED', '', null, 'constructor', '__proto__']) {
    assert.ok(normalizeItem(item({ type }), TODAY).error, String(type));
  }
});

test('kiểm tra: toạ độ phải trong khung Việt Nam và đúng dạng [kinh độ, vĩ độ]', () => {
  for (const coord of [[0, 0], [21.0285, 105.8542], [120, 15], [100, 15], [106, 5], [106, 24], [106], [106, 16, 3], ['106', '16'], [NaN, 16], null, 'x']) {
    assert.ok(normalizeItem(item({ coord }), TODAY).error, JSON.stringify(coord));
  }
  for (const coord of [[112.33, 16.53], [114.29, 8.65], [102.15, 22.4], [104.75, 8.6]]) {
    assert.ok(normalizeItem(item({ coord }), TODAY).item, JSON.stringify(coord)); // Hoàng Sa, Trường Sa, Điện Biên, Cà Mau
  }
});

test('kiểm tra: hướng là số nguyên 0–359', () => {
  for (const direction of [-1, 360, 45.5, '90', true]) assert.ok(normalizeItem(item({ direction }), TODAY).error, String(direction));
  for (const direction of [0, 359, 180]) assert.equal(normalizeItem(item({ direction }), TODAY).item.direction, direction);
  assert.equal('direction' in normalizeItem(item({ direction: null }), TODAY).item, false);
});

test('kiểm tra: tốc độ 5–130 km/h, bội của 5; speed-limit bắt buộc có; loại khác bỏ trị số', () => {
  for (const value of [0, 4, 135, 62, 60.5, '60', -60]) {
    assert.ok(normalizeItem(item({ value }), TODAY).error, `camera ${value}`);
    assert.ok(normalizeItem(item({ type: 'speed-limit', value }), TODAY).error, `limit ${value}`);
  }
  for (const value of [5, 60, 130]) assert.equal(normalizeItem(item({ type: 'speed-limit', value }), TODAY).item.value, value);
  assert.ok(normalizeItem(item({ type: 'speed-limit' }), TODAY).error);
  assert.equal('value' in normalizeItem(item({}), TODAY).item, false); // camera không ghi giới hạn: được
  assert.equal('value' in normalizeItem(item({ type: 'hazard', value: 60 }), TODAY).item, false);
  assert.equal('code' in normalizeItem(item({ type: 'hazard', code: 'P.103a' }), TODAY).item, false);
});

test('kiểm tra: biển (sign) cần mã QCVN có trong danh mục, không cần con số', () => {
  assert.equal(normalizeItem(item({ type: 'sign', code: 'P.103a' }), TODAY).item.code, 'P.103a');
  assert.equal(normalizeItem(item({ type: 'sign', code: 'W.207b' }), TODAY).item.code, 'W.207b');
  for (const code of [undefined, '', 'p.103a', 'P103a', 'X.999', 'P.999', 'P.127', 'R.306', '<b>P.101</b>', 42]) {
    assert.ok(normalizeItem(item({ type: 'sign', code }), TODAY).error, String(code));
  }
});

test('kiểm tra: chuỗi có giới hạn độ dài, ký tự điều khiển bị bỏ, nguồn bắt buộc', () => {
  assert.ok(normalizeItem(item({ note: 'x'.repeat(MAX_NOTE + 1) }), TODAY).error);
  assert.equal(normalizeItem(item({ note: 'x'.repeat(MAX_NOTE) }), TODAY).item.note.length, MAX_NOTE);
  assert.equal(normalizeItem(item({ note: 'a\u0000b‮c​d' }), TODAY).item.note, 'a b c d');
  // Mọi ký tự định dạng vô hình (bidi U+061C, gạch mềm, U+180E, U+2060–U+2064, ký tự thẻ) cũng bị bỏ.
  for (const ch of ['\u061c', '\u00ad', '\u180e', '\u2060', '\u2061', '\u2064', '\u{E0041}', '\u{E007F}', '\u2066', '\ufeff', '\u2028', '\ud800']) {
    assert.equal(cleanString(`a${ch}b`), 'a b', `U+${ch.codePointAt(0).toString(16)}`);
  }
  assert.equal(cleanString('Phố Hàng Bông, ngõ 5'), 'Phố Hàng Bông, ngõ 5', 'chữ tiếng Việt giữ nguyên');
  assert.equal('note' in normalizeItem(item({ note: '   ' }), TODAY).item, false);
  assert.ok(normalizeItem(item({ note: 5 }), TODAY).error);
  assert.ok(normalizeItem(item({ source: '' }), TODAY).error);
  assert.ok(normalizeItem(item({ source: undefined }), TODAY).error);
  assert.ok(normalizeItem(item({ source: 'y'.repeat(61) }), TODAY).error);
  assert.ok(normalizeItem(item({ id: 'a b' }), TODAY).error);
  assert.ok(normalizeItem(item({ id: 'x'.repeat(49) }), TODAY).error);
  assert.equal(normalizeItem(item({ id: 'cam-01' }), TODAY).item.id, 'cam-01');
});

test('kiểm tra: ngày xác minh và hết hạn; mục hết hạn bị bỏ qua', () => {
  assert.ok(normalizeItem(item({ verified: '2026-11-31' }), TODAY).error);
  assert.ok(normalizeItem(item({ verified: '27/11/2026' }), TODAY).error);
  assert.ok(normalizeItem(item({ verified: '2026-12-05' }), TODAY).error); // tương lai
  assert.ok(normalizeItem(item({ until: '2026-11-19' }), TODAY).error); // trước ngày xác minh
  assert.equal(normalizeItem(item({ until: '2026-11-26' }), TODAY).expired, true);
  assert.equal(normalizeItem(item({ until: TODAY }), TODAY).item.until, TODAY);
  const r = validateCommunity(doc([item({ until: '2026-11-26' }), item({ type: 'hazard' })]), { today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { total: 2, kept: 1, rejected: 0, expired: 1, errors: [] });
});

test('kiểm tra: không ghi đè thuộc tính nguyên mẫu', () => {
  const r = validateCommunity(
    '{"schema":1,"updated":"2026-11-25","items":[{"type":"hazard","coord":[105.85,21.02],"source":"s","verified":"2026-11-20","__proto__":{"polluted":1},"constructor":{"x":1}}]}',
    { today: TODAY }
  );
  assert.equal(r.ok, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(r.data.items[0]), ['id', 'type', 'coord', 'source', 'verified']);
});

test('kiểm tra cả tệp: schema, ngày cập nhật, số mục, dung lượng, JSON hỏng, id trùng', () => {
  const ok = (d) => validateCommunity(d, { today: TODAY });
  assert.equal(ok('không phải json').ok, false);
  assert.equal(ok('[]').ok, false);
  assert.equal(ok(doc([], { schema: 2 })).ok, false);
  assert.equal(ok(doc([], { schema: '1' })).ok, false);
  assert.equal(ok(doc([], { updated: '2026-13-01' })).ok, false);
  assert.equal(ok(doc([], { updated: '2099-01-01' })).ok, false); // tương lai: sẽ thắng mãi mọi bản mới
  assert.equal(ok(doc([], { updated: '2026-11-29' })).ok, true); // lệch múi giờ: cho phép 2 ngày
  assert.equal(ok(doc({})).ok, false);
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item({ coord: [105 + i * 1e-4, 21] }));
  assert.equal(ok(doc(many)).ok, false);
  assert.equal(ok(doc(many.slice(0, MAX_ITEMS))).data.items.length, MAX_ITEMS);
  const big = JSON.stringify(doc([item({ note: 'x' })])).replace('"x"', `"${'x'.repeat(MAX_BYTES)}"`);
  assert.ok(byteLength(big) > MAX_BYTES);
  assert.equal(ok(big).ok, false);
  const dup = ok(doc([item({ id: 'a' }), item({ id: 'a', type: 'hazard' })]));
  assert.equal(dup.data.items.length, 1);
  assert.equal(dup.stats.rejected, 1);
  assert.match(dup.stats.errors[0], /id trùng/);
  assert.equal(validateCommunity(doc([])).ok, false); // thiếu ngày hôm nay
});

test('viDate: dd/mm/yyyy', () => {
  assert.equal(viDate('2026-01-05'), '05/01/2026');
  assert.equal(viDate('x'), '');
});

// ---------------------------------------------------------------------------------------------
// Bộ tải
// ---------------------------------------------------------------------------------------------

const LOCAL = 'https://app.test/data/community.json';

function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
}

/** fetch giả: routes = { url: chuỗi | { status, body, headers } | 'throw' | 'hang' }. */
function fakeFetch(routes) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (r === undefined || r === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (r === 'hang') {
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    const spec = typeof r === 'string' ? { body: r } : r;
    return Promise.resolve(new Response(spec.body, { status: spec.status ?? 200, headers: spec.headers || {} }));
  };
  fn.calls = calls;
  return fn;
}

const make = (routes, { native = false, storage = memory(), today = TODAY } = {}) => {
  const fetch = fakeFetch(routes);
  const cd = new CommunityData({ fetch, storage, native: () => native, today: () => today, localUrl: LOCAL, timeoutMs: 50 });
  return { cd, fetch, storage };
};
const J = (d) => JSON.stringify(d);

test('tải: bản cùng nguồn gốc được kiểm tra, đổi thành điểm và lưu lại', async () => {
  const { cd, fetch, storage } = make({ [LOCAL]: J(doc([item({ value: 50 })])) });
  let changes = 0;
  cd.onChange(() => changes++);
  assert.equal(communitySummary(cd), 'Dữ liệu cộng đồng: chưa tải được.');
  assert.equal(await cd.refresh(), true);
  assert.equal(cd.source, 'bundle');
  assert.equal(cd.count, 1);
  assert.equal(communitySummary(cd), 'Dữ liệu cộng đồng: 1 điểm, cập nhật 25/11/2026');
  assert.equal(cd.points[0].kind, 'camera');
  assert.equal(changes, 1);
  assert.equal(fetch.calls.length, 1, 'trên trình duyệt không tải bản GitHub Pages');
  assert.equal(fetch.calls[0].opts.credentials, 'same-origin');
  assert.equal(JSON.parse(storage.get(COMMUNITY_CACHE_KEY)).items.length, 1);
  assert.equal(await cd.refresh(), false, 'không đổi thì không báo');
  assert.equal(changes, 1);
});

test('công tắc "Dùng dữ liệu cộng đồng" tắt: không tải gì (kể cả GitHub Pages trong ứng dụng Android), bật lại thì tải', async () => {
  const { cd, fetch } = make({ [LOCAL]: J(doc([item()])), [COMMUNITY_REMOTE]: J(doc([item()])) }, { native: true });
  assert.equal(fetch.calls.length, 0, 'tạo đối tượng không tải');
  // main.js: chỉ start() khi công tắc bật; tắt thì stop() (thôi hẹn giờ 6 giờ), bật lại thì start().
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(src, /if \(communityOn\(\)\) community\.start\(\);/);
  assert.doesNotMatch(src, /^\s*community\.start\(\);/m, 'không có lời gọi start() vô điều kiện');
  assert.match(src, /if \(communityWas\) community\.start\(\);\s*else community\.stop\(\);/);
  assert.equal((src.match(/community\.(?:start|refresh)\(/g) || []).length, 2, 'không có chỗ tải nào khác');
  // stop() huỷ hẹn giờ: không còn lần tải nào sau đó.
  const timers = [];
  cd.start({ setInterval: (fn, ms) => (timers.push({ fn, ms }), 7) });
  await cd.pending;
  const after = fetch.calls.length;
  let cleared = null;
  cd.stop({ clearInterval: (id) => (cleared = id) });
  assert.equal(cleared, 7);
  assert.equal(cd.timer, null);
  assert.equal(fetch.calls.length, after);
});

test('tải trong ứng dụng Android: bản mới hơn thắng, cùng ngày thì bản GitHub Pages', async () => {
  const older = J(doc([item()], { updated: '2026-11-01' }));
  const newer = J(doc([item(), item({ type: 'hazard' })], { updated: '2026-11-25' }));
  let t = make({ [LOCAL]: older, [COMMUNITY_REMOTE]: newer }, { native: true });
  await t.cd.refresh();
  assert.equal(t.cd.source, 'remote');
  assert.equal(t.cd.count, 2);
  const remoteCall = t.fetch.calls.find((c) => c.url === COMMUNITY_REMOTE);
  assert.equal(remoteCall.opts.credentials, 'omit');
  assert.equal(remoteCall.opts.redirect, 'error');
  assert.equal(remoteCall.opts.referrerPolicy, 'no-referrer');

  t = make({ [LOCAL]: newer, [COMMUNITY_REMOTE]: older }, { native: true });
  await t.cd.refresh();
  assert.equal(t.cd.source, 'bundle');

  t = make({ [LOCAL]: J(doc([item()])), [COMMUNITY_REMOTE]: newer }, { native: true });
  await t.cd.refresh();
  assert.equal(t.cd.source, 'remote');
  assert.equal(t.cd.count, 2);
});

test('tải: bản tải về sai (JSON hỏng, schema lạ, quá lớn, lỗi HTTP, quá giờ) bị bỏ, dùng bản đi kèm', async () => {
  const good = J(doc([item()], { updated: '2026-11-01' }));
  const bad = [
    'không phải json',
    J(doc([], { schema: 9, updated: '2026-11-26' })),
    J(doc([], { updated: '2099-01-01' })),
    { body: J(doc([], { updated: '2026-11-26' })), headers: { 'content-length': String(MAX_BYTES + 1) } },
    { body: `${J(doc([], { updated: '2026-11-26' }))}${' '.repeat(MAX_BYTES)}` }, // không báo content-length mà quá giới hạn
    { status: 404, body: J(doc([], { updated: '2026-11-26' })) },
    'throw',
    'hang',
  ];
  for (const remote of bad) {
    const { cd } = make({ [LOCAL]: good, [COMMUNITY_REMOTE]: remote }, { native: true });
    await cd.refresh();
    assert.equal(cd.source, 'bundle', typeof remote === 'string' ? remote.slice(0, 30) : JSON.stringify(remote).slice(0, 60));
    assert.equal(cd.count, 1);
  }
});

test('fetchText: dừng khi quá giới hạn, quá giờ; không phải chuỗi UTF-8 hợp lệ thì bỏ', async () => {
  const f = fakeFetch({ a: 'x'.repeat(100), b: 'hang', c: { body: new Uint8Array([0xff, 0xfe, 0x41]) } });
  assert.equal(await fetchText('a', { fetch: f, maxBytes: 99 }), null);
  assert.equal(await fetchText('a', { fetch: f, maxBytes: 100 }), 'x'.repeat(100));
  const t0 = Date.now();
  assert.equal(await fetchText('b', { fetch: f, timeoutMs: 30 }), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await fetchText('c', { fetch: f }), null);
  assert.equal(await fetchText('a', { fetch: null }), null);
});

test('tải khi mất mạng: dùng bản đã lưu (kiểm tra lại, bỏ mục đã hết hạn)', async () => {
  const storage = memory({
    [COMMUNITY_CACHE_KEY]: J(doc([item({ until: '2026-11-30' }), item({ type: 'hazard' })], { updated: '2026-11-20' })),
  });
  let t = make({}, { storage, native: true });
  await t.cd.refresh();
  assert.equal(t.cd.source, 'cache');
  assert.equal(t.cd.count, 2);
  t = make({}, { storage, native: true, today: '2026-12-01' });
  await t.cd.refresh();
  assert.equal(t.cd.count, 1, 'mục hết hạn bị bỏ ngay cả trong bản đã lưu');
  // Bản đã lưu bị sửa hỏng: coi như không có.
  storage.set(COMMUNITY_CACHE_KEY, '{"schema":1,"updated":"2026-11-20","items":[{"type":"camera-speed","coord":[0,0]}]}');
  t = make({}, { storage });
  await t.cd.refresh();
  assert.equal(t.cd.count, 0);
  storage.set(COMMUNITY_CACHE_KEY, '<script>');
  t = make({}, { storage });
  await t.cd.refresh();
  assert.equal(t.cd.data, null);
  assert.equal(t.cd.points.length, 0);
});

test('tải: bản đã lưu mới hơn bản đi kèm thì giữ bản đã lưu, không bị ghi đè bằng bản cũ', async () => {
  const cached = J(doc([item(), item({ type: 'hazard' })], { updated: '2026-11-25' }));
  const storage = memory({ [COMMUNITY_CACHE_KEY]: cached });
  const { cd } = make({ [LOCAL]: J(doc([], { updated: '2026-11-01' })) }, { storage });
  await cd.refresh();
  assert.equal(cd.source, 'cache');
  assert.equal(cd.count, 2);
  assert.equal(storage.get(COMMUNITY_CACHE_KEY), cached);
});

test('tải: bộ lưu bị chặn (chế độ ẩn danh) vẫn chạy', async () => {
  const storage = { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); } };
  const { localStorageBackend } = await import('../js/community.js');
  const ls = localStorageBackend({ getItem: storage.get, setItem: storage.set });
  const cd = new CommunityData({ fetch: fakeFetch({ [LOCAL]: J(doc([item()])) }), storage: ls, today: () => TODAY, localUrl: LOCAL });
  await cd.refresh();
  assert.equal(cd.count, 1);
});

test('tải lại lúc mở và mỗi 6 giờ', async () => {
  const { cd, fetch } = make({ [LOCAL]: J(doc([item()])) });
  let timer = null;
  cd.start({ setInterval: (fn, ms) => ((timer = { fn, ms }), 1) });
  assert.equal(COMMUNITY_REFRESH_MS, 6 * 3600e3);
  assert.equal(timer.ms, COMMUNITY_REFRESH_MS);
  await cd.pending;
  assert.equal(fetch.calls.length, 1);
  timer.fn();
  await cd.pending;
  assert.equal(fetch.calls.length, 2);
  cd.start({ setInterval: () => assert.fail('chỉ một bộ hẹn giờ') });
  await cd.pending;
  let cleared = null;
  cd.stop({ clearInterval: (id) => (cleared = id) });
  assert.equal(cleared, 1);
});

test('pickNewest: theo ngày rồi theo thứ tự remote > bundle > cache', () => {
  const d = (updated) => ({ updated });
  assert.equal(pickNewest([]), null);
  assert.equal(pickNewest([{ src: 'cache', data: d('2026-11-02') }, { src: 'remote', data: d('2026-11-01') }]).src, 'cache');
  assert.equal(pickNewest([{ src: 'cache', data: d('2026-11-02') }, { src: 'bundle', data: d('2026-11-02') }]).src, 'bundle');
  assert.equal(pickNewest([{ src: 'remote', data: null }, { src: 'bundle', data: d('2026-11-02') }]).src, 'bundle');
});

// ---------------------------------------------------------------------------------------------
// Điểm cảnh báo
// ---------------------------------------------------------------------------------------------

const ALL_ON = { alertCamera: true, alertToll: true, alertRail: true, alertReport: true };

test('điểm cộng đồng: tên mang nhãn "dữ liệu cộng đồng", camera theo công tắc camera', () => {
  const items = validateCommunity(
    doc([
      item({ value: 60 }),
      item({ type: 'camera-redlight' }),
      item({ type: 'camera-traffic' }),
      item({ type: 'speed-limit', value: 50 }),
      item({ type: 'sign', code: 'P.103a' }),
      item({ type: 'hazard' }),
      item({ type: 'closure' }),
    ]),
    { today: TODAY }
  ).data.items;
  const pts = communityPoints(items);
  assert.equal(pts.length, 7);
  for (const p of pts) {
    assert.match(p.info.title, / \(dữ liệu cộng đồng\)$/);
    assert.equal(p.src, 'community');
    assert.ok(p.id.startsWith('c:'));
  }
  assert.deepEqual(pts.map((p) => p.kind), ['camera', 'camera', 'camera', 'community', 'community', 'community', 'community']);
  assert.equal(pts[0].limit, 60);
  assert.match(pts[0].info.title, /^Camera bắn tốc độ · giới hạn 60 km\/h/);
  assert.equal(pts[3].info.say, 'có biển tốc độ tối đa 50 ki lô mét trên giờ');
  assert.equal(pts[4].info.title, 'Cấm xe ô tô (dữ liệu cộng đồng)');
  assert.equal(pts[4].info.say, 'cấm ô tô');
  assert.equal(pts[6].icon, 'works');
});

test('điểm cộng đồng đi qua AlertEngine như điểm tự đánh dấu; tắt "Camera giao thông" thì camera cộng đồng im', () => {
  const ahead = destination(HN, 90, 250);
  const pts = communityPoints([normalizeItem(item({ coord: ahead, value: 60 }), TODAY).item]);
  const fix = { coord: HN, speed: 12, heading: 90, time: 0 };
  const engine = new AlertEngine();
  const r = withOwnInfo(engine.update(fix, pts, ALL_ON));
  assert.equal(r.fired, true);
  assert.match(r.active.info.title, /\(dữ liệu cộng đồng\)$/);
  assert.equal(r.say, 'Còn 250 mét, có camera bắn tốc độ, giới hạn 60 ki lô mét trên giờ');
  const off = new AlertEngine().update(fix, pts, { ...ALL_ON, alertCamera: false });
  assert.equal(off.active, null);
  // Điểm không phải camera: không theo công tắc nào khác ngoài "Dùng dữ liệu cộng đồng" (main.js lọc trước).
  const hz = communityPoints([normalizeItem(item({ type: 'closure', coord: ahead }), TODAY).item]);
  const r2 = withOwnInfo(new AlertEngine().update(fix, hz, { ...ALL_ON, alertReport: false }));
  assert.equal(r2.say, 'Còn 250 mét, có đường cấm hoặc rào chắn');
  // withOwnInfo để nguyên kết quả của điểm không mang tên riêng.
  const plain = { active: { point: { id: 'n1', kind: 'toll' }, info: { title: 'T' }, distance: 1 }, fired: true, say: 'x' };
  assert.equal(withOwnInfo(plain), plain);
  assert.equal(withOwnInfo(null), null);
});

test('điểm có hướng chỉ báo cho xe chạy cùng hướng; không biết hướng thì vẫn báo', () => {
  assert.equal(POINT_FACING_TOLERANCE, 60);
  const p = { direction: 90 };
  assert.equal(facingApplies(p, 100), true);
  assert.equal(facingApplies(p, 150), true); // đúng 60°
  assert.equal(facingApplies(p, 270), false); // chiều ngược lại
  assert.equal(facingApplies(p, null), true);
  assert.equal(facingApplies({ direction: null }, 270), true);
  assert.equal(facingApplies({ direction: 5 }, 355), true);
  // Qua AlertEngine: đi chậm dưới 2 m/s thì không có hướng tin được, nhưng cũng không báo điểm mới.
  const [cp] = communityPoints([normalizeItem(item({ coord: destination(HN, 90, 250), direction: 90 }), TODAY).item]);
  const fwd = new AlertEngine().update({ coord: HN, speed: 12, heading: 90, time: 0 }, [cp], ALL_ON);
  assert.equal(fwd.fired, true);
  const back = new AlertEngine().update({ coord: HN, speed: 12, heading: 270, time: 0 }, [cp], ALL_ON);
  assert.equal(back.active, null);
});

// Đường đôi chạy lên Bắc ở x = 0; chiều xuống Nam cách 20 m về phía Đông.
const northFix = (x, speed = 15) => ({ coord: destination(HN, 0, x), speed, heading: 0, time: 1e6 + x * 100, accuracy: 5 });
const drive = (points, { to = 700, step = 15, speed = 15 } = {}) => {
  const engine = new AlertEngine();
  const said = [];
  for (let x = 0; x <= to; x += step) {
    const r = withOwnInfo(engine.update(northFix(x, speed), points, ALL_ON));
    if (r.fired) said.push([x, r.say, r.active.point.id]);
  }
  return said;
};

test('camera bản đồ của chiều bên kia đường đôi không làm mất camera cộng đồng của chiều xe đang đi', () => {
  const sb = { id: 'n1', kind: 'camera', sub: 'speed', limit: null, coord: destination(destination(HN, 0, 600), 90, 20), dir: 'forward', wb: 180 };
  const comm = communityPoints([normalizeItem(item({ coord: destination(HN, 0, 605), direction: 0, value: 50 }), TODAY).item]);
  const said = drive([sb, ...comm]);
  assert.equal(said.length, 1);
  assert.equal(said[0][2], comm[0].id);
  assert.match(said[0][1], /^Còn 300 mét, có camera bắn tốc độ, giới hạn 50 ki lô mét trên giờ$/);
  // Xe chạy xuống Nam ở chiều bên kia: camera bản đồ báo, camera cộng đồng (hướng 0) im.
  const engine = new AlertEngine();
  const south = [];
  for (let x = 1300; x >= 0; x -= 15) {
    const fix = { coord: destination(destination(HN, 0, x), 90, 20), speed: 15, heading: 180, time: 2e6 - x * 100 };
    const r = engine.update(fix, [sb, ...comm], ALL_ON);
    if (r.fired) south.push(r.active.point.id);
  }
  assert.deepEqual(south, ['n1']);
});

test('cùng một camera trong nhiều nguồn chỉ báo một lần, bản đồ thắng rồi đến cộng đồng rồi điểm tự đánh dấu', () => {
  const own = { id: 'r1', kind: 'report', type: 'camspeed', coord: destination(HN, 0, 400), direction: 0 };
  const comm = communityPoints([normalizeItem(item({ coord: destination(HN, 0, 408), direction: 0 }), TODAY).item]);
  const osm = { id: 'n2', kind: 'camera', sub: 'speed', limit: null, coord: destination(HN, 0, 425) };
  // Điểm tự đánh dấu và điểm cộng đồng làm từ chính báo cáo đó: một lần (điểm nào vào tầm báo trước thì báo).
  let said = drive([own, ...comm], { to: 500, step: 5 });
  assert.equal(said.length, 1);
  assert.match(said[0][1], /^Còn 300 mét, có camera bắn tốc độ/);
  // Cùng lúc trong tầm: cộng đồng thắng điểm tự đánh dấu.
  assert.equal(new AlertEngine().update(northFix(200), [own, ...comm], ALL_ON).active.point.id, comm[0].id);
  // Cả ba, camera bản đồ xa hơn 25 m nhưng vào tầm báo sau: vẫn chỉ một lần.
  said = drive([own, ...comm, osm], { to: 500, step: 5 });
  assert.equal(said.length, 1);
  // Cùng lúc trong tầm: bản đồ thắng.
  const engine = new AlertEngine();
  const r = engine.update(northFix(200), [own, ...comm, { ...osm, coord: destination(HN, 0, 410) }], ALL_ON);
  assert.equal(r.active.point.id, 'n2');
  // Camera đèn đỏ ở cùng chỗ là thứ khác: vẫn báo riêng.
  const red = { id: 'n3', kind: 'camera', sub: 'redlight', coord: destination(HN, 0, 415) };
  said = drive([own, red], { to: 500, step: 5 });
  assert.deepEqual(said.map((x) => x[2]).sort(), ['n3', 'r1']);
  // Hai camera cùng loại cách nhau hơn 30 m: báo cả hai.
  said = drive([own, { ...osm, coord: destination(HN, 0, 440) }], { to: 500, step: 5 });
  assert.equal(said.length, 2);
});

test('chi tiết điểm cộng đồng: nguồn, ngày xác minh, lời nhắc không đầy đủ (chữ thường, không HTML)', () => {
  const [p] = communityPoints([normalizeItem(item({ note: '<img src=x onerror=alert(1)>', until: '2026-12-31', direction: 45 }), TODAY).item]);
  const lines = detailLines(p);
  assert.equal(lines[0], '<img src=x onerror=alert(1)>'); // main.js đưa qua textContent, không bao giờ innerHTML
  assert.match(lines[1], /Nguồn: Chủ ứng dụng khảo sát\. Chủ ứng dụng xác minh ngày 20\/11\/2026\./);
  assert.ok(lines.some((l) => /31\/12\/2026/.test(l)));
  assert.ok(lines.some((l) => /45°/.test(l)));
  assert.match(lines.at(-1), /không đầy đủ/);
});

test('main.js: điểm cộng đồng đi cùng đường với điểm tự đánh dấu, chữ chỉ qua textContent', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(src, /const near = \[\.\.\.osm, \.\.\.warnReportPoints\(\), \.\.\.shared\];/);
  assert.match(src, /withOwnInfo\(alerts\.update\(fix, near, s, nav/);
  // Camera tốc độ không ghi giới hạn: hiện kèm giới hạn của đường đang đi (trước khi camera hạ), chỉ hiện, không đọc.
  assert.match(src, /withOwnInfo\(alerts\.update\(fix, near, s, nav, \{ roadLimit: speedMon\.limit \}\)\)/);
  // Không bỏ điểm cộng đồng trước khi lọc theo hướng (AlertEngine gộp điểm trùng sau khi lọc).
  assert.match(src, /const shared = communityOn\(\) \? community\.near\(fix\.coord, 1300\) : \[\];/);
  // Không có chỗ nào đưa dữ liệu cộng đồng hay chữ báo cáo vào innerHTML.
  assert.doesNotMatch(src, /html:\s*(?:detailLines|shareText|it\.note|item\.note|shared\.)/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Dùng dữ liệu cộng đồng/);
  assert.match(html, /id="optCommunity"/);
  assert.match(html, /id="communityLine"/);
  assert.match(html, /id="btnExportRepo"/);
  assert.match(html, /Xuất cho kho dữ liệu/);
});

test('main.js đọc được (không khai báo trùng tên sau khi ghép phần báo cáo)', () => {
  const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../js/main.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('data/community.json không bị .gitignore bỏ (để được đưa lên kho và GitHub Pages)', (t) => {
  const file = fileURLToPath(new URL('../data/community.json', import.meta.url));
  const r = spawnSync('git', ['check-ignore', '-q', file], { encoding: 'utf8' });
  if (r.error || r.status === 128) return t.skip('không nằm trong kho git');
  assert.equal(r.status, 1, 'git check-ignore báo tệp bị bỏ qua');
});
