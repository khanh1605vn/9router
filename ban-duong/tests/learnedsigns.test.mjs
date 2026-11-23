import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
import { destination } from '../js/geo.js';
import {
  appliesTo,
  CANDIDATE_DAYS,
  CONFIRM_DAYS,
  CONFIRM_DAYS_IMPORT,
  CONFIRM_DAYS_UNSURE,
  CONFIRMED_DAYS,
  CO_MAX,
  dayNumber,
  dayString,
  driveDay,
  DRIVE_DAY_START_H,
  idbBackend,
  L_CONFIRM,
  L_HIT_DAY,
  L_HIT_NIGHT,
  L_MAX,
  L_MIN,
  L_MISS_CANDIDATE,
  L_MISS_CONFIRMED,
  L_NEW,
  L_RETIRE,
  L_STRONG,
  L_USER_OK,
  labelOf,
  LEARNED_DB,
  LearnedSigns,
  MATCH_ALONG,
  MATCH_FACING,
  MATCH_LATERAL,
  MAX_RECORDS,
  memoryBackend,
  POS_ERR_DEFAULT,
  POS_ERR_FLOOR,
  RETIRED_DAYS,
  SUPPRESS_DAYS,
  SUPPRESS_RADIUS,
  TEMP_CODES,
  TEMP_DAYS,
  travelFor,
} from '../js/learnedsigns.js';

// Cờ learn lấy từ danh sách học cố định (như models/labels.json chưa huấn luyện), không đọc tệp đã cài: một lần
// huấn luyện đầy đủ có thể gỡ nhãn khỏi danh sách học (BD_PRUNE) mà phép thử logic học không được phụ thuộc vào đó.
const labels = buildLabels(SIGN_CATALOGUE);
const O = [105.81, 21.015];
const DAY0 = new Date(2026, 10, 23, 12, 0).getTime(); // trưa 23/11/2026 theo giờ máy

/** Kho với đồng hồ chỉnh được: clock.day(n) sang ngày thứ n. */
function makeStore(opts = {}) {
  const clock = { t: DAY0, day(n) { this.t = DAY0 + n * 864e5; } };
  let seed = 1;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const backend = opts.backend || memoryBackend();
  const store = new LearnedSigns({ backend, now: () => clock.t, labels, random, ...opts });
  return { store, clock, backend };
}

/** Một lần thấy biển cách O một quãng `x` m về phía Đông, mặt biển nhìn về hướng Tây (xe đi về hướng Đông). */
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

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------------------------
// Bảng điểm §5.8
// ---------------------------------------------------------------------------------------------

test('bảng điểm: hằng số đúng PLAN §5.8', () => {
  assert.deepEqual(
    [L_NEW, L_STRONG, L_HIT_DAY, L_HIT_NIGHT, L_MISS_CANDIDATE, L_MISS_CONFIRMED, L_MIN, L_MAX, L_CONFIRM, L_RETIRE, L_USER_OK],
    [0.4, 0.85, 1.2, 0.6, -0.5, -0.6, -2, 3.5, 1.5, -0.5, 3.5],
  );
  assert.deepEqual([CONFIRM_DAYS, CONFIRM_DAYS_UNSURE, CONFIRM_DAYS_IMPORT], [2, 3, 1]);
  assert.deepEqual([...TEMP_CODES], ['W.227'], 'biển tạm thời: công trường');
  assert.deepEqual([CANDIDATE_DAYS, CONFIRMED_DAYS, RETIRED_DAYS, SUPPRESS_DAYS, TEMP_DAYS], [90, 365, 60, 180, 30]);
  assert.deepEqual([MATCH_ALONG, MATCH_LATERAL, MATCH_FACING, SUPPRESS_RADIUS, MAX_RECORDS], [25, 10, 45, 30, 5000]);
  assert.equal(LEARNED_DB, 'banduong-learned');
});

test('biển mới: chưa xác nhận, L = 0,4; thấy rõ ban ngày L = 0,85; ban đêm không tính là rõ', () => {
  const { store } = makeStore();
  const a = store.observe(obs());
  assert.equal(a.event, 'new');
  assert.equal(a.record.status, 'candidate');
  assert.equal(a.record.L, L_NEW);
  assert.equal(a.record.hitDays, 1);
  assert.equal(a.record.src, 'camera');
  assert.match(a.record.id, /^[0-9a-f]{12}$/);
  const b = store.observe(obs({ x: 500, strong: true }));
  assert.equal(b.record.L, L_STRONG);
  const c = store.observe(obs({ x: 1000, strong: true, night: true }));
  assert.equal(c.record.L, L_NEW);
  assert.equal(c.record.night, true);
});

test('thấy lại: +1,2 ban ngày, +0,6 ban đêm, chặn trên 3,5; xác nhận cần L ≥ 1,5 và 2 ngày khác nhau', () => {
  const { store, clock } = makeStore();
  const id = store.observe(obs()).record.id;
  // Cùng ngày: đủ điểm nhưng chưa đủ ngày.
  let r = store.observe(obs({ x: 3 }));
  assert.equal(r.event, 'hit');
  assert.equal(r.record.id, id);
  assert.ok(near(r.record.L, L_NEW + L_HIT_DAY));
  assert.equal(r.record.hitDays, 1);
  assert.equal(r.record.status, 'candidate');
  clock.day(1);
  r = store.observe(obs({ x: -2, night: true }));
  assert.ok(near(r.record.L, L_NEW + L_HIT_DAY + L_HIT_NIGHT));
  assert.equal(r.record.hitDays, 2);
  assert.equal(r.record.status, 'confirmed');
  clock.day(2);
  r = store.observe(obs());
  clock.day(3);
  r = store.observe(obs());
  assert.equal(r.record.L, L_MAX);
  assert.equal(r.record.hitDays, 4);
  assert.equal(r.record.passes, 5);
});

test('xác nhận theo ngày: hai ngày ban ngày đủ; ban đêm cần thêm lần; chưa chắc nhánh cần 3 ngày', () => {
  const { store, clock } = makeStore();
  const day = store.observe(obs()).record.id;
  const night = store.observe(obs({ x: 400, night: true })).record.id;
  const unsure = store.observe(obs({ x: 800, branch: 'unsure' })).record.id;
  clock.day(1);
  store.observe(obs());
  store.observe(obs({ x: 400, night: true }));
  store.observe(obs({ x: 800 }));
  assert.equal(store.get(day).status, 'confirmed');
  assert.equal(store.get(night).status, 'candidate', 'L = 1,0 < 1,5');
  assert.equal(store.get(unsure).status, 'candidate', 'mới thấy vào 2 ngày');
  assert.equal(store.get(unsure).branch, 'unsure');
  clock.day(2);
  store.observe(obs({ x: 400, night: true }));
  store.observe(obs({ x: 800 }));
  assert.equal(store.get(night).status, 'confirmed');
  assert.equal(store.get(unsure).status, 'confirmed');
});

test('không thấy (đủ điều kiện): biển chưa xác nhận bị loại sau 2 lần, biển đã xác nhận sau 7 lần từ mức trần', () => {
  const { store, clock } = makeStore();
  const cand = store.observe(obs()).record.id;
  let r = store.pass(cand, 'miss');
  assert.ok(near(r.L, L_NEW + L_MISS_CANDIDATE));
  assert.equal(r.status, 'candidate');
  r = store.pass(cand, 'miss');
  assert.equal(r.status, 'retired');
  assert.equal(r.misses, 2);
  assert.equal(r.until, dayNumber(clock.t) + RETIRED_DAYS);
  // Biển đã xác nhận, ở mức trần.
  const conf = store.observe(obs({ x: 600 })).record.id;
  store.confirm(conf);
  for (let k = 1; k <= 6; k++) {
    r = store.pass(conf, 'miss');
    assert.equal(r.status, 'confirmed', `lần ${k}`);
    assert.ok(near(r.L, L_USER_OK + k * L_MISS_CONFIRMED));
  }
  r = store.pass(conf, 'miss');
  assert.equal(r.status, 'retired');
  // 'none' không đổi gì; id lạ → null.
  const x = store.observe(obs({ x: 1200 })).record;
  assert.deepEqual(store.pass(x.id, 'none'), x);
  assert.equal(store.pass('ffffffffffff', 'miss'), null);
});

test('chặn dưới −2; biển đã loại thấy lại thì dùng lại (chưa xác nhận)', () => {
  const { store, clock } = makeStore();
  const id = store.observe(obs()).record.id;
  store.pass(id, 'miss');
  store.pass(id, 'miss');
  assert.equal(store.get(id).status, 'retired');
  assert.equal(store.featsNear(O, 50).length, 0, 'biển đã loại không hiện');
  clock.day(5);
  const r = store.observe(obs({ x: 4 }));
  assert.equal(r.event, 'hit');
  assert.equal(r.record.id, id);
  assert.equal(r.record.status, 'candidate');
  assert.ok(near(r.record.L, L_NEW + 2 * L_MISS_CANDIDATE + L_HIT_DAY));
  // Chặn dưới: biển đã xác nhận nhận nhiều lần không thấy liên tiếp.
  const { store: s2 } = makeStore();
  const b = s2.observe(obs()).record.id;
  for (let k = 0; k < 10; k++) s2.pass(b, 'miss');
  assert.equal(s2.get(b).L, -0.6, 'loại ở lần thứ hai, sau đó không trừ nữa');
  const c = s2.observe(obs({ x: 800 })).record.id;
  s2.confirm(c);
  for (let k = 0; k < 6; k++) s2.pass(c, 'miss');
  assert.ok(s2.get(c).L >= L_MIN);
});

test('người dùng: "Đúng" xác nhận L = 3,5; "Sai"/"Biển đã bị dỡ" chặn học lại 180 ngày trong 30 m, ±45°', () => {
  const { store, clock } = makeStore();
  const a = store.observe(obs()).record.id;
  assert.equal(store.confirm(a).status, 'confirmed');
  assert.equal(store.get(a).L, L_USER_OK);
  assert.equal(store.reject(a).status, 'suppressed');
  assert.equal(store.featsNear(O, 50).length, 0);
  assert.equal(store.observe(obs({ x: 29 })).event, 'suppressed');
  assert.equal(store.observe(obs({ value: '60', x: 10 })).event, 'suppressed', 'cùng mã, khác trị số');
  assert.equal(store.observe(obs({ x: 10, facing: 270 + 44 })).event, 'suppressed');
  assert.equal(store.observe(obs({ x: 10, facing: 270 + 50 })).event, 'new', 'hướng khác');
  assert.equal(store.observe(obs({ x: 35 })).event, 'new', 'ngoài 30 m');
  assert.equal(store.observe(obs({ code: 'P.102', value: null, family: 'noentry', x: 5 })).event, 'new', 'mã khác');
  const b = store.observe(obs({ x: 3000 })).record.id;
  assert.equal(store.removed(b).status, 'suppressed');
  assert.equal(store.get(b).until, dayNumber(clock.t) + SUPPRESS_DAYS);
  clock.day(SUPPRESS_DAYS - 1);
  assert.ok(store.get(b));
  clock.day(SUPPRESS_DAYS);
  store.expire();
  assert.equal(store.get(b), null, 'hết 180 ngày thì xoá');
  assert.equal(store.observe(obs({ x: 3000 })).event, 'new');
});

test('hết hạn: chưa xác nhận 90 ngày, đã xác nhận 365 ngày, công trường 30 ngày, đã loại 60 ngày', () => {
  const { store, clock } = makeStore();
  const cand = store.observe(obs()).record.id;
  const conf = store.observe(obs({ x: 500 })).record.id;
  store.confirm(conf);
  const works = store.observe(obs({ code: 'W.227', value: null, family: 'triangle', x: 1000 })).record.id;
  const gone = store.observe(obs({ x: 1500 })).record.id;
  store.pass(gone, 'miss');
  store.pass(gone, 'miss');
  clock.day(29);
  store.expire();
  assert.equal(store.get(works).status, 'candidate');
  clock.day(30);
  store.expire();
  assert.equal(store.get(works).status, 'retired', 'công trường: loại sau 30 ngày không thấy');
  clock.day(59);
  store.expire();
  assert.ok(store.get(gone));
  clock.day(60);
  store.expire();
  assert.equal(store.get(gone), null, 'đã loại: xoá sau 60 ngày');
  clock.day(89);
  store.expire();
  assert.ok(store.get(cand));
  assert.ok(store.get(works), 'đã loại ngày 30: còn tới ngày 90');
  clock.day(90);
  store.expire();
  assert.equal(store.get(cand), null, 'chưa xác nhận: xoá sau 90 ngày không thấy');
  assert.equal(store.get(works), null);
  clock.day(364);
  store.expire();
  assert.equal(store.get(conf).status, 'confirmed');
  clock.day(365);
  store.expire();
  assert.equal(store.get(conf).status, 'candidate', 'đã xác nhận: 365 ngày không thấy thì về chưa xác nhận');
  clock.day(365 + 89);
  store.expire();
  assert.ok(store.get(conf));
  clock.day(365 + 90);
  store.expire();
  assert.equal(store.get(conf), null);
  // Một lần chạy sau thời gian dài vẫn đi đủ các bước (đã xác nhận → chưa xác nhận → xoá).
  const { store: s2, clock: c2 } = makeStore();
  const x = s2.observe(obs()).record.id;
  s2.confirm(x);
  c2.day(1000);
  assert.equal(s2.expire(), 1);
  assert.equal(s2.get(x), null);
});

test('khoá so khớp: cùng mã và trị số, mặt biển ±45°, ≤ 25 m dọc đường, ≤ 10 m ngang', () => {
  const { store } = makeStore();
  const id = store.observe(obs()).record.id;
  assert.equal(store.match(obs({ x: 24 })).match?.id, id);
  assert.equal(store.match(obs({ x: -24 })).match?.id, id);
  assert.equal(store.match(obs({ x: 26 })).match, null);
  assert.equal(store.match(obs({ facing: 270 - 44 })).match?.id, id);
  assert.equal(store.match(obs({ facing: 270 + 46 })).match, null);
  assert.equal(store.match(obs({ facing: 90 })).match, null, 'chiều ngược lại');
  assert.equal(store.match(obs({ coord: destination(O, 0, 9) })).match?.id, id, 'lệch ngang 9 m');
  assert.equal(store.match(obs({ coord: destination(O, 0, 11) })).match, null, 'lệch ngang 11 m: đường song song');
  assert.equal(store.match(obs({ value: '60' })).match, null);
  assert.equal(store.match(obs({ code: 'P.102', value: null })).match, null);
  // Vị trí được gộp theo nghịch đảo phương sai; sai số không xuống dưới 0,6 lần sai số một lần thấy.
  const r = store.observe(obs({ x: 10, posErr: 4 }));
  const moved = r.record.coord[0] - O[0];
  const tenMetres = destination(O, 90, 10)[0] - O[0];
  assert.ok(Math.abs(moved - tenMetres / 2) < 2e-5, `gộp nửa đường: ${moved} vs ${tenMetres / 2}`);
  assert.ok(near(r.record.posErr, Math.max(POS_ERR_FLOOR * 4, 4 / Math.SQRT2)));
});

test('đổi trị số trong 25 m (50 → 60): biển mới được tính thấy, biển cũ bị trừ như một lần không thấy', () => {
  const { store, clock } = makeStore();
  const old = store.observe(obs()).record.id;
  clock.day(1);
  store.observe(obs());
  assert.equal(store.get(old).status, 'confirmed');
  const L0 = store.get(old).L;
  const r = store.observe(obs({ value: '60', x: 12 }));
  assert.equal(r.event, 'conflict');
  assert.equal(r.created, true, 'biển 60 chưa có: vừa được tạo');
  assert.equal(r.record.value, '60');
  assert.equal(r.record.status, 'candidate');
  assert.equal(r.missed.length, 1);
  assert.equal(r.missed[0].id, old);
  assert.ok(near(store.get(old).L, L0 + L_MISS_CONFIRMED));
  // Lần sau thấy 60 nữa: biển 60 được thấy lại, biển 50 lại bị trừ.
  clock.day(2);
  const r2 = store.observe(obs({ value: '60', x: 10 }));
  assert.equal(r2.event, 'conflict');
  assert.equal(r2.created, false);
  assert.equal(r2.record.id, r.record.id);
  assert.equal(r2.record.status, 'confirmed');
  // Ngoài 25 m: không liên quan.
  assert.equal(store.observe(obs({ value: '80', x: 40 })).event, 'new');
});

test('bản đồ đã có (bước 13), lần thấy hỏng, sự kiện onChange', () => {
  const { store } = makeStore();
  let changes = 0;
  const off = store.onChange(() => changes++);
  assert.deepEqual(store.observe(obs({ osm: true })), { record: null, event: 'osm', missed: [], created: false });
  assert.equal(store.size, 0);
  const id = store.observe(obs()).record.id;
  assert.equal(store.observe(obs({ osm: true, x: 2 })).event, 'hit', 'kho đã có: vẫn tính là thấy lại');
  assert.equal(store.get(id).passes, 2);
  for (const bad of [null, {}, obs({ code: 'X.1' }), obs({ coord: [NaN, 1] }), obs({ facing: null }), obs({ value: '5a' })]) {
    assert.equal(store.observe(bad).event, 'invalid');
  }
  assert.ok(changes >= 2);
  off();
  const before = changes;
  store.observe(obs({ x: 900 }));
  assert.equal(changes, before);
});

test('giới hạn 5.000 bản ghi: bỏ biển đã loại trước, rồi biển chưa xác nhận cũ nhất; không còn chỗ thì "full"', async () => {
  // Dựng sẵn 5.000 bản ghi qua nơi lưu (nhanh hơn 5.000 lần observe).
  const day = dayNumber(DAY0);
  const recs = [];
  for (let i = 0; i < MAX_RECORDS; i++) {
    const c = destination(O, 90, i * 100);
    const status = i === 10 ? 'retired' : i < 20 ? 'candidate' : 'confirmed';
    recs.push({
      id: i.toString(16).padStart(12, '0'),
      v: 1,
      code: 'P.102',
      value: null,
      family: 'noentry',
      coord: [Math.round(c[0] * 1e5) / 1e5, c[1]],
      facing: 270,
      status,
      L: status === 'confirmed' ? 2 : 0.4,
      hitDays: 1,
      passes: 1,
      misses: 0,
      firstDay: day - 50 + i,
      lastHitDay: day - 50 + (i === 15 ? -100 : i),
      until: status === 'retired' ? day + 30 : status === 'candidate' ? day + 80 : day + 300,
      night: false,
      posErr: 4,
      src: 'camera',
    });
  }
  const { store } = makeStore({ backend: memoryBackend(recs) });
  assert.equal(await store.load(), MAX_RECORDS);
  const far = (k) => obs({ coord: destination(O, 180, 1000 * k) });
  assert.equal(store.observe(far(1)).event, 'new');
  assert.equal(store.size, MAX_RECORDS);
  assert.equal(store.get('00000000000a'), null, 'biển đã loại bị bỏ trước');
  assert.equal(store.observe(far(2)).event, 'new');
  assert.equal(store.get('00000000000f'), null, 'rồi biển chưa xác nhận thấy lâu nhất');
  // Chỉ còn biển đã xác nhận (và các biển chưa xác nhận vừa thêm): bỏ dần các biển chưa xác nhận.
  for (let k = 3; k < 40; k++) store.observe(far(k));
  const c = store.counts();
  assert.equal(c.total, MAX_RECORDS);
  assert.equal(c.retired, 0);
  // Toàn biển đã xác nhận: không thêm được.
  const all = recs.map((r) => ({ ...r, status: 'confirmed', until: day + 300 }));
  const { store: full } = makeStore({ backend: memoryBackend(all) });
  await full.load();
  assert.equal(full.observe(far(1)).event, 'full');
  assert.equal(full.size, MAX_RECORDS);
});

test('featsNear: cùng một đối tượng tới khi bản ghi đổi; id "L" + 12 hex; dạng nút biển (hợp đồng 6)', () => {
  const { store } = makeStore();
  const a = store.observe(obs({ plate: 'unread' })).record;
  store.observe(obs({ code: 'R.122', value: null, family: 'octagon', x: 300, junction: '105.8130000,21.0150000' }));
  const [f1] = store.featsNear(O, 30);
  const [f2] = store.featsNear(destination(O, 90, 10), 30);
  assert.equal(f1, f2, 'cùng đối tượng');
  assert.match(f1.id, /^L[0-9a-f]{12}$/);
  assert.equal(f1.id, `L${a.id}`);
  assert.deepEqual(Object.keys(f1).sort(), ['coord', 'id', 'meta', 'onWay', 'src', 'status', 'tags']);
  assert.equal(f1.onWay, false);
  assert.deepEqual(f1.tags, { traffic_sign: 'VN:P.127[50]', 'traffic_sign:direction': '270' });
  assert.equal(f1.src, 'camera');
  assert.equal(f1.status, 'candidate');
  assert.deepEqual(f1.meta, { hitDays: 1, firstDay: a.firstDay, lastHitDay: a.firstDay, plate: 'unread' });
  assert.ok(Object.isFrozen(f1) && Object.isFrozen(f1.tags));
  const [stop] = store.featsNear(destination(O, 90, 300), 10);
  assert.equal(stop.tags.traffic_sign, 'VN:R.122');
  // Bản ghi đổi (thấy lại) → đối tượng mới, rồi lại giữ nguyên.
  store.observe(obs({ x: 1 }));
  const [f3] = store.featsNear(O, 30);
  assert.notEqual(f3, f1);
  assert.equal(store.featsNear(O, 30)[0], f3);
  assert.equal(f3.meta.hitDays, 1);
  // Ngoài bán kính, biển bị báo sai: không có.
  assert.equal(store.featsNear(destination(O, 0, 200), 50).length, 0);
  store.reject(a.id);
  assert.equal(store.featsNear(O, 30).length, 0);
  assert.equal(labelOf('P.127', '50'), 'P.127[50]');
  assert.equal(labelOf('R.122', null), 'R.122');
});

test('nơi lưu trong bộ nhớ: ghi từng thay đổi kèm khoá ô, đọc lại được, bỏ bản ghi hỏng; clear() xoá hết', async () => {
  const { store, backend } = makeStore();
  const a = store.observe(obs()).record;
  store.observe(obs({ x: 500 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.map.size, 2);
  const row = backend.map.get(a.id);
  assert.equal(row.cell, '3527:700');
  assert.deepEqual(Object.keys(row).filter((k) => /time|trip|image|seen_at/i.test(k)), [], 'không lưu giờ, chuyến đi, hình ảnh');
  backend.map.set('bad', { id: 'bad' });
  backend.map.set('cafecafecafe', { ...row, id: 'cafecafecafe', code: '<b>', coord: [1, 2] });
  backend.map.set('0123456789ab', { ...row, id: '0123456789ab', L: -9, status: 'retired', until: row.until });
  const again = new LearnedSigns({ backend, now: () => DAY0, labels });
  assert.equal(await again.load(), 3);
  assert.equal(again.get('0123456789ab').L, L_MIN, 'điểm đọc từ nơi lưu cũng bị chặn trong [−2, 3,5]');
  assert.deepEqual(again.get(a.id).coord, a.coord);
  assert.equal(again.get(`L${a.id}`).id, a.id, 'nhận cả id có tiền tố L');
  await again.clear();
  assert.equal(again.size, 0);
  assert.equal(backend.map.size, 0);
});

test('coSeen: hai biển cùng được thấy trong một lượt, đếm theo ngày khác nhau, tối đa CO_MAX biển, đọc lại từ nơi lưu', async () => {
  assert.equal(CO_MAX, 4);
  const { store, clock, backend } = makeStore();
  const a = store.observe(obs()).record.id;
  const b = store.observe(obs({ code: 'P.103a', value: null })).record.id;
  assert.deepEqual(store.get(a).co, []);
  assert.equal(store.coSeen(a, b), true);
  assert.equal(store.coSeen(b, a), false, 'cùng ngày: chỉ tính một lần');
  const today = dayNumber(clock.t);
  assert.deepEqual(store.get(a).co, [{ id: b, days: 1, last: today }]);
  assert.deepEqual(store.get(b).co, [{ id: a, days: 1, last: today }]);
  clock.day(1);
  store.coSeen(a, b);
  assert.deepEqual(store.get(a).co, [{ id: b, days: 2, last: today + 1 }]);
  const L = store.get(a).L;
  assert.equal(store.get(a).L, L, 'không đổi điểm');
  // Bản sao: sửa bản trả ra không đổi kho.
  store.get(a).co[0].days = 99;
  assert.equal(store.get(a).co[0].days, 2);
  // Tối đa CO_MAX biển: bỏ biển lâu nhất không cùng thấy.
  const others = [];
  for (let k = 0; k < CO_MAX; k++) {
    clock.day(2 + k);
    const id = store.observe(obs({ x: 200 * (k + 1), code: 'P.123a', value: null })).record.id;
    others.push(id);
    store.coSeen(a, id);
  }
  assert.equal(store.get(a).co.length, CO_MAX);
  assert.ok(!store.get(a).co.some((c) => c.id === b), 'biển lâu nhất bị bỏ');
  assert.equal(store.coSeen(a, a), false);
  assert.equal(store.coSeen(a, 'ffffffffffff'), false);
  // Đọc lại từ nơi lưu: giữ co hợp lệ, bỏ mục hỏng.
  await new Promise((r) => setTimeout(r, 0));
  const row = backend.map.get(b);
  backend.map.set(b, { ...row, co: [{ id: a, days: 2, last: today + 1 }, { id: 'x' }, { id: a, days: 5, last: 1 }, 'z', { id: 'abcdefabcdef', days: 'x', last: 1 }] });
  const again = new LearnedSigns({ backend, now: () => clock.t, labels });
  await again.load();
  assert.deepEqual(again.get(b).co, [{ id: a, days: 2, last: today + 1 }]);
  assert.equal(again.get(a).co.length, CO_MAX);
  assert.deepEqual(Object.keys(again.get(b).co[0]).sort(), ['days', 'id', 'last'], 'chỉ số ngày, không có giờ hay chuyến đi');
});

test('ngày lái xe bắt đầu lúc 04:00: chuyến đêm qua nửa đêm là một ngày; hai đêm liền nhau là hai ngày', () => {
  assert.equal(DRIVE_DAY_START_H, 4);
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // giờ máy
  assert.equal(driveDay(at(24, 3, 59)), driveDay(at(23, 23, 0)));
  assert.equal(driveDay(at(24, 4, 0)), driveDay(at(23, 23, 0)) + 1);
  assert.equal(driveDay(at(23, 12)), dayNumber(at(23, 12)), 'ban ngày: như dayNumber');
  const run = (times) => {
    const { store, clock } = makeStore();
    let id = null;
    for (const t of times) {
      clock.t = t;
      const r = store.observe(obs({ night: true }));
      id = r.record.id;
    }
    return store.get(id);
  };
  // Vài vòng quanh một khu phố trong một chuyến đêm: 23:50, 00:05, 00:20 → vẫn một ngày, chưa xác nhận.
  const loop = run([at(23, 23, 50), at(24, 0, 5), at(24, 0, 20)]);
  assert.deepEqual([loop.status, loop.hitDays], ['candidate', 1]);
  assert.ok(loop.L >= L_CONFIRM, 'đủ điểm, chỉ thiếu ngày');
  // 23:50 đêm nay và 23:50 đêm mai: hai ngày.
  const twoNights = run([at(23, 23, 50), at(24, 23, 50), at(25, 23, 50)]);
  assert.deepEqual([twoNights.status, twoNights.hitDays], ['confirmed', 3]);
  // 02:00 đêm nay và 02:00 đêm mai: hai ngày (cả hai cùng tính vào ngày hôm trước).
  const late = run([at(24, 2), at(25, 2), at(25, 2, 30)]);
  assert.deepEqual([late.status, late.hitDays], ['confirmed', 2]);
  assert.equal(late.firstDay, dayNumber(at(23, 12)), 'thấy lúc 02:00 ngày 24 tính là ngày 23');
});

test('danh sách xem lại: gần trước, không có biển đã loại hay bị báo sai; đếm theo trạng thái', () => {
  const { store } = makeStore();
  const a = store.observe(obs({ x: 900 })).record.id;
  const b = store.observe(obs({ x: 100 })).record.id;
  const c = store.observe(obs({ x: 2000 })).record.id;
  store.confirm(b);
  store.reject(c);
  const rows = store.list({ near: O });
  assert.deepEqual(rows.map((r) => r.id), [b, a]);
  assert.equal(rows[0].status, 'confirmed');
  assert.equal(rows[0].label, 'P.127[50]');
  assert.ok(rows[0].distance < rows[1].distance);
  assert.deepEqual(store.counts(), { total: 3, shown: 2, candidate: 1, confirmed: 1, retired: 0, suppressed: 1 });
  assert.equal(store.list().length, 2);
});

test('số thứ tự ngày theo lịch của máy', () => {
  const d = new Date(2026, 10, 23, 0, 1).getTime();
  const e = new Date(2026, 10, 23, 23, 59).getTime();
  assert.equal(dayNumber(d), dayNumber(e));
  assert.equal(dayNumber(new Date(2026, 10, 24, 0, 0).getTime()), dayNumber(d) + 1);
  assert.equal(dayString(dayNumber(d)), '2026-11-23');
});

test('IndexedDB: cơ sở dữ liệu riêng "banduong-learned" v1, kho "signs" khoá "id", chỉ mục "cell"; không có IndexedDB thì không lỗi', async () => {
  const none = idbBackend(LEARNED_DB, { indexedDB: undefined });
  assert.deepEqual(await none.getAll(), []);
  await none.put({ id: 'x' });
  await none.clear();
  // IndexedDB giả tối thiểu: ghi lại lời gọi open và cấu trúc tạo ra.
  const made = {};
  const rows = new Map();
  const storeObj = {
    put: (r) => rows.set(r.id, r),
    delete: (id) => rows.delete(id),
    clear: () => rows.clear(),
    getAll() {
      const req = {};
      queueMicrotask(() => {
        req.result = [...rows.values()];
        req.onsuccess();
      });
      return req;
    },
  };
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore(name, opts) {
      made.store = { name, opts };
      return { createIndex: (iname, key, o) => (made.index = { iname, key, o }) };
    },
    transaction() {
      const tx = { objectStore: () => storeObj };
      queueMicrotask(() => tx.oncomplete && tx.oncomplete());
      return tx;
    },
  };
  const fake = {
    open(name, version) {
      made.open = { name, version };
      const req = { result: db };
      queueMicrotask(() => {
        req.onupgradeneeded();
        req.onsuccess();
      });
      return req;
    },
  };
  const be = idbBackend(LEARNED_DB, { indexedDB: fake });
  await be.put({ id: 'abc', cell: '1:2' });
  assert.deepEqual(made.open, { name: 'banduong-learned', version: 1 });
  assert.deepEqual(made.store, { name: 'signs', opts: { keyPath: 'id' } });
  assert.deepEqual(made.index, { iname: 'cell', key: 'cell', o: { unique: false } });
  assert.deepEqual(await be.getAll(), [{ id: 'abc', cell: '1:2' }]);
  await be.delete('abc');
  assert.deepEqual(await be.getAll(), []);
});

test('hướng áp dụng: mặt biển nhìn về hướng Tây áp dụng cho xe đi về hướng Đông (±60°); sai số mặc định 4,5 m', () => {
  assert.equal(travelFor(270), 90);
  assert.equal(travelFor(90), 270);
  assert.equal(appliesTo(270, 90), true);
  assert.equal(appliesTo(270, 150), true);
  assert.equal(appliesTo(270, 151), false);
  assert.equal(appliesTo(270, 270), false);
  assert.equal(appliesTo(10, 160, 30), true);
  assert.equal(POS_ERR_DEFAULT, 4.5);
  const { store } = makeStore();
  const { posErr, ...rest } = obs();
  void posErr;
  assert.equal(store.observe(rest).record.posErr, POS_ERR_DEFAULT);
});

test('cùng đường: lần thấy mang obs.ways không gộp hay trừ điểm biển của đường song song; thấy lại cập nhật wayId', () => {
  const { store } = makeStore();
  // Biển của đường trên cao (way 3) ngay trên đường dưới (way 1), lệch 4 m.
  const upper = store.observe(obs({ value: '80', wayId: 3, coord: destination(destination(O, 90, 0), 0, 4) })).record.id;
  assert.equal(store.match(obs({ value: '80', ways: [1] })).match, null, 'xe ở đường dưới: không phải cùng biển');
  assert.equal(store.match(obs({ value: '80', ways: [3, 4] })).match?.id, upper);
  assert.equal(store.match(obs({ value: '80' })).match?.id, upper, 'không có ways: chỉ xét lệch ngang (như trước)');
  assert.equal(store.match(obs({ value: '80', ways: [] })).match?.id, upper);
  // Đổi trị số ở đường dưới không trừ điểm biển đường trên cao.
  const L0 = store.get(upper).L;
  const r = store.observe(obs({ value: '60', wayId: 1, ways: [1] }));
  assert.equal(r.event, 'new');
  assert.deepEqual(r.missed, []);
  assert.equal(store.get(upper).L, L0);
  // Biển nhập (không có wayId) vẫn khớp theo lệch ngang; thấy lại thì nhận wayId của lần thấy.
  const imp = store.observe(obs({ code: 'R.122', value: null, x: 300, wayId: null })).record.id;
  assert.equal(store.get(imp).wayId, null);
  store.observe(obs({ code: 'R.122', value: null, x: 302, wayId: 7, ways: [7] }));
  assert.equal(store.get(imp).wayId, 7);
  // Id đường cũ (bản đồ đã cập nhật) được thay bằng id của lần thấy mới, khi bộ học coi là cùng đường.
  store.observe(obs({ code: 'R.122', value: null, x: 301, wayId: 9, ways: [9, 7] }));
  assert.equal(store.get(imp).wayId, 9);
});

test('kho đầy và đổi trị số: biển cũ bị trừ điểm trước, không bị bỏ để nhường chỗ rồi dựng lại; kho không vượt 5.000', async () => {
  const day = dayNumber(DAY0);
  const recs = [];
  for (let i = 0; i < MAX_RECORDS; i++) {
    const c = destination(O, 90, 1000 + i * 100);
    recs.push({
      id: i.toString(16).padStart(12, '0'),
      v: 1,
      code: 'R.122',
      value: null,
      family: 'octagon',
      coord: [Math.round(c[0] * 1e5) / 1e5, c[1]],
      facing: 270,
      status: i === 0 ? 'candidate' : 'confirmed',
      L: i === 0 ? 0.4 : 2,
      hitDays: 1,
      passes: 1,
      misses: 0,
      firstDay: day - 10,
      lastHitDay: day - 10,
      until: day + 80,
      night: false,
      posErr: 4,
      src: 'camera',
    });
  }
  // Bản ghi chưa xác nhận cũ nhất chính là biển P.127[50] ở O.
  recs[0] = { ...recs[0], code: 'P.127', value: '50', family: 'ring', coord: [O[0], O[1]], firstDay: day - 40, lastHitDay: day - 40 };
  const { store, backend } = makeStore({ backend: memoryBackend(recs) });
  await store.load();
  const old = recs[0].id;
  const r = store.observe(obs({ value: '60', x: 3 }));
  assert.equal(r.event, 'full', 'chỉ còn biển đã xác nhận và chính biển cũ: không có chỗ');
  assert.deepEqual(r.missed.map((m) => m.id), [old], 'biển 50 vẫn bị trừ điểm (đã thấy biển 60 ở đó)');
  assert.equal(store.size, MAX_RECORDS);
  assert.equal(backend.map.size, MAX_RECORDS);
  assert.ok(Math.abs(store.get(old).L - (0.4 + L_MISS_CANDIDATE)) < 1e-9);
  // Có một biển chưa xác nhận khác để bỏ: biển 60 được thêm, biển 50 (đang bị trừ điểm) được giữ.
  const recs2 = recs.map((x, i) => (i === 1 ? { ...x, status: 'candidate', L: 0.4, lastHitDay: day - 5 } : x));
  const { store: s2, backend: b2 } = makeStore({ backend: memoryBackend(recs2) });
  await s2.load();
  const r2 = s2.observe(obs({ value: '60', x: 3 }));
  assert.equal(r2.event, 'conflict');
  assert.equal(r2.created, true);
  assert.equal(s2.size, MAX_RECORDS);
  assert.equal(b2.map.size, MAX_RECORDS);
  assert.ok(s2.get(old), 'biển cũ đổi trị số không bị bỏ');
  assert.equal(s2.get(recs2[1].id), null, 'biển chưa xác nhận khác bị bỏ');
});
