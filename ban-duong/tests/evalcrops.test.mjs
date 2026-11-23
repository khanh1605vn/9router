import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../js/visionproto.js';
import { dayNumber } from '../js/learnedsigns.js';
import {
  EVAL_DB,
  EVAL_FILE_VERSION,
  EVAL_FUTURE_DAYS,
  EVAL_MAX_BYTES,
  EVAL_MAX_CROPS,
  EVAL_OUTCOMES,
  EVAL_RETENTION_DAYS,
  EVAL_TEXT,
  EvalCrops,
  evalIdbBackend,
  memoryBackend,
} from '../js/evalcrops.js';

const VP = globalThis.VisionProto;
const DAY = 864e5;
const NOON = new Date(2026, 10, 23, 12, 0).getTime(); // giờ địa phương của máy chạy thử

// Ảnh PNG 1×1 thật.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (extra = 0) => new Blob([PNG_1x1, new Uint8Array(extra)], { type: 'image/png' });

/** Đúng dạng Learner onEvalCrop đưa ra. */
const crop = (over = {}) => ({
  blob: png(),
  label: 'P.127[50]',
  p: 0.93,
  pred: [['P.127[50]', 0.93], ['P.127[60]', 0.04], ['other-sign', 0.01]],
  w: 31.6,
  night: false,
  outcome: 'accepted',
  reason: 'new',
  ...over,
});

function makeStore({ on = true, t = NOON, backend = memoryBackend() } = {}) {
  const clock = { t, on };
  const store = new EvalCrops({ backend, now: () => clock.t, enabled: () => clock.on });
  return { store, clock, backend };
}

// Bộ kiểm tra tệp vào của tools/camera/label-crops.html, lấy nguyên văn từ trang (không chép tay): tệp xuất phải là
// đúng thứ trang đó đọc được.
const HTML = readFileSync(new URL('../tools/camera/label-crops.html', import.meta.url), 'utf8');
function fromPage(re) {
  const m = HTML.match(re);
  assert.ok(m, `label-crops.html không còn ${re}`);
  return m[0];
}
const PAGE = new Function(
  [
    fromPage(/const MAX_FILE_BYTES = .*;/),
    fromPage(/const MAX_CROPS = .*;/),
    fromPage(/const MAX_PNG_CHARS = .*;/),
    fromPage(/const PNG_RE = .*;/),
    fromPage(/const ID_RE = .*;/),
    fromPage(/function validCrop\(c\) \{[\s\S]*?\n\}\n/),
    'return { MAX_FILE_BYTES, MAX_CROPS, MAX_PNG_CHARS, validCrop };',
  ].join('\n'),
)();

test('hằng số: IndexedDB riêng, giữ 30 ngày, tối đa 2.000 ảnh, ảnh ≤ 64 KiB như worker; chữ giao diện viết thường câu', () => {
  assert.equal(EVAL_DB, 'banduong-evalcrops');
  assert.equal(EVAL_RETENTION_DAYS, 30);
  assert.equal(EVAL_FUTURE_DAYS, 1);
  assert.equal(EVAL_MAX_CROPS, 2000);
  assert.equal(EVAL_MAX_BYTES, 64 * 1024);
  assert.equal(EVAL_MAX_BYTES, VP.EVAL_CROP_MAX_BYTES);
  assert.deepEqual(EVAL_OUTCOMES, ['accepted', 'near-miss']);
  assert.equal(EVAL_FILE_VERSION, 1);
  assert.equal(EVAL_TEXT.setting, 'Lưu ảnh biển để kiểm tra độ chính xác');
  assert.match(EVAL_TEXT.note, /30 ngày/);
  assert.match(EVAL_TEXT.note, /một phần xe cộ phía sau biển/);
  assert.match(EVAL_TEXT.exportWarning, /một phần xe cộ phía sau biển/);
  for (const s of Object.values(EVAL_TEXT)) {
    assert.notEqual(s, s.toUpperCase(), 'không viết hoa toàn bộ');
    assert.equal(s[0], s[0].toUpperCase(), 'viết hoa chữ đầu câu');
  }
});

test('mặc định tắt: không có cài đặt (hay camEval tắt) thì không lưu gì; bật thì lưu; tắt lại thì thôi', async () => {
  const backend = memoryBackend();
  const off = new EvalCrops({ backend, now: () => NOON });
  assert.equal(await off.add(crop()), null, 'không truyền enabled: luôn tắt');
  assert.equal(off.size, 0);
  assert.equal(backend.map.size, 0);
  const { store, clock, backend: be } = makeStore({ on: false });
  assert.equal(await store.add(crop()), null);
  assert.equal(be.map.size, 0, 'không ghi gì xuống nơi lưu');
  assert.equal(await store.exportFile().then((b) => b.text()).then((s) => JSON.parse(s).crops.length), 0);
  clock.on = true;
  assert.ok(await store.add(crop()));
  assert.equal(be.map.size, 1);
  clock.on = false;
  assert.equal(await store.add(crop()), null);
  assert.equal(store.size, 1);
  // Chỉ đúng true mới là bật (không phải chuỗi hay số).
  const odd = new EvalCrops({ backend: memoryBackend(), now: () => NOON, enabled: () => 'true' });
  assert.equal(await odd.add(crop()), null);
});

test('mục lưu: đúng các trường đã định, có số ngày nhưng không có toạ độ hay giờ; dữ liệu sai bị từ chối', async () => {
  const { store, backend } = makeStore();
  const e = await store.add(crop({ coord: [105.8, 21.0], t: 123456, time: NOON, frame: 'x' }));
  assert.deepEqual(Object.keys(e).sort(), ['blob', 'day', 'id', 'label', 'night', 'outcome', 'p', 'pred', 'reason', 'w']);
  assert.equal(e.day, dayNumber(NOON));
  assert.equal(e.w, 32, 'bề rộng làm tròn tới px');
  assert.equal(e.id, 1);
  const saved = backend.map.get(1);
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(e).sort());
  assert.ok(!('coord' in saved) && !('t' in saved) && !('time' in saved));
  // Nhãn đứng đầu của pred phải là label; không thì chỉ giữ [[label, p]].
  assert.deepEqual((await store.add(crop({ pred: [['R.122', 0.9]] }))).pred, [['P.127[50]', 0.93]]);
  assert.deepEqual((await store.add(crop({ outcome: 'near-miss', reason: 'confidence', night: null, w: null }))).night, null);
  for (const bad of [
    crop({ blob: new Blob([PNG_1x1], { type: 'image/jpeg' }) }),
    crop({ blob: new Blob([new Uint8Array(40)], { type: 'image/png' }) }), // không có chữ ký PNG
    crop({ blob: png(EVAL_MAX_BYTES) }), // quá lớn
    crop({ blob: new Blob([], { type: 'image/png' }) }),
    crop({ blob: 'data:image/png;base64,AAAA' }),
    crop({ label: '<script>' }),
    crop({ label: '' }),
    crop({ p: 1.2 }),
    crop({ p: NaN }),
    crop({ outcome: 'rejected' }),
    crop({ reason: 'A B' }),
    null,
  ]) {
    assert.equal(await store.add(bad), null, JSON.stringify(bad && { ...bad, blob: String(bad.blob) }));
  }
  assert.equal(store.size, 3);
});

test('giữ 30 ngày: ảnh 29 ngày tuổi còn, 30 ngày thì bị xoá (cả ở nơi lưu); ngày sau hôm nay quá 1 ngày cũng bị xoá', async () => {
  const { store, clock, backend } = makeStore();
  await store.add(crop());
  clock.t += 10 * DAY;
  await store.add(crop({ label: 'R.122', pred: null }));
  clock.t = NOON + (EVAL_RETENTION_DAYS - 1) * DAY;
  assert.equal((await store.list()).length, 2);
  clock.t = NOON + EVAL_RETENTION_DAYS * DAY;
  const left = await store.list();
  assert.deepEqual(left.map((e) => e.label), ['R.122']);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...backend.map.keys()], [2]);
  // Tải lại từ nơi lưu cũng xoá ảnh quá hạn (lúc load).
  const day0 = dayNumber(NOON);
  const be = memoryBackend([
    { id: 1, day: day0 - 30, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'new', blob: png() },
    { id: 2, day: day0 - 29, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'new', blob: png() },
    { id: 3, day: day0 + 1, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'new', blob: png() },
    { id: 4, day: day0 + 2, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'new', blob: png() },
  ]);
  const again = new EvalCrops({ backend: be, now: () => NOON, enabled: () => true });
  assert.equal(await again.load(), 2);
  assert.deepEqual((await again.list()).map((e) => e.id), [3, 2]);
});

test('tối đa 2.000 ảnh: thêm nữa thì xoá ảnh cũ nhất (ngày sớm nhất, rồi thêm vào sớm nhất)', async () => {
  const day0 = dayNumber(NOON);
  // Kho đã đầy: 1.999 ảnh hôm nay (id 2…2000) và một ảnh 5 ngày trước với id lớn nhất (đồng hồ từng bị chỉnh).
  const rows = [];
  for (let id = 2; id <= EVAL_MAX_CROPS; id++) rows.push({ id, day: day0, label: 'P.127[50]', p: 0.9, outcome: 'accepted', reason: 'hit', blob: png() });
  rows.push({ id: 5000, day: day0 - 5, label: 'R.122', p: 0.9, outcome: 'accepted', reason: 'hit', blob: png() });
  const { store, backend } = makeStore({ backend: memoryBackend(rows) });
  assert.equal(await store.load(), EVAL_MAX_CROPS);
  const e1 = await store.add(crop());
  assert.equal(e1.id, 5001, 'số mới lớn hơn mọi số đã có');
  assert.equal(store.size, EVAL_MAX_CROPS);
  assert.ok(!store.rows.has(5000), 'ảnh của ngày sớm nhất bị xoá trước');
  await store.add(crop());
  assert.ok(!store.rows.has(2), 'rồi tới ảnh thêm vào sớm nhất');
  assert.ok(store.rows.has(3));
  await new Promise((r) => setImmediate(r));
  assert.equal(backend.map.size, EVAL_MAX_CROPS, 'nơi lưu cũng chỉ còn 2.000 ảnh');
  // Thêm dồn dập cùng lúc vẫn giữ đúng mức trần và không trùng số.
  await Promise.all(Array.from({ length: 30 }, () => store.add(crop())));
  assert.equal(store.size, EVAL_MAX_CROPS);
  const ids = [...store.rows.keys()];
  assert.equal(new Set(ids).size, ids.length);
});

test('xem, xoá một ảnh (số hay chuỗi số), xoá hết; lưu bền qua nơi lưu; mục hỏng bị bỏ', async () => {
  const { store, backend } = makeStore();
  await store.add(crop());
  await store.add(crop({ label: 'R.122', pred: [['R.122', 0.8]], outcome: 'near-miss', reason: 'agreement' }));
  await store.add(crop({ label: 'W.207' }));
  assert.deepEqual(store.counts(), { total: 3, accepted: 2, nearMiss: 1 });
  const seen = [];
  store.onChange(() => seen.push(store.size));
  assert.deepEqual((await store.list()).map((e) => e.label), ['W.207', 'R.122', 'P.127[50]'], 'mới nhất trước');
  assert.equal(await store.remove('2'), true);
  assert.equal(await store.remove(2), false);
  assert.equal(await store.remove('x'), false);
  const reopened = new EvalCrops({ backend, now: () => NOON, enabled: () => true });
  assert.deepEqual((await reopened.list()).map((e) => e.id), [3, 1]);
  assert.ok((await reopened.list())[0].blob instanceof Blob);
  await store.clear();
  assert.equal(store.size, 0);
  assert.equal(backend.map.size, 0);
  assert.deepEqual(seen, [2, 0]);
  // Mục hỏng (không phải PNG, thiếu trường, có toạ độ thì chỉ giữ trường đã định) khi đọc lại.
  const be = memoryBackend([
    { id: 1, day: dayNumber(NOON), label: 'R.122', p: 0.9, outcome: 'accepted', reason: null, blob: png(), coord: [1, 2] },
    { id: 2, day: dayNumber(NOON), label: 'R.122', p: 0.9, outcome: 'accepted', blob: 'x' },
    { id: 'z', day: dayNumber(NOON), label: 'R.122', p: 0.9, outcome: 'accepted', blob: png() },
  ]);
  const s2 = new EvalCrops({ backend: be, now: () => NOON, enabled: () => true });
  assert.equal(await s2.load(), 1);
  assert.ok(!('coord' in (await s2.list())[0]));
});

test('tệp xuất: đúng định dạng label-crops.html đọc (kiểm bằng chính mã của trang), không lộ ngày, giờ hay toạ độ', async () => {
  const { store, clock } = makeStore();
  await store.add(crop());
  await store.add(crop({ label: 'R.122', pred: [['R.122', 0.7], ['W.208', 0.2]], outcome: 'near-miss', reason: 'confidence', night: true, w: 24 }));
  clock.t += 3 * DAY;
  await store.add(crop({ label: 'P.102', pred: null, p: 0.88, night: null }));
  const file = await store.exportFile();
  assert.equal(file.type, 'application/json');
  const text = await file.text();
  const j = JSON.parse(text);
  assert.equal(j.version, 1);
  assert.equal(j.crops.length, 3);
  const ok = j.crops.map(PAGE.validCrop);
  assert.ok(ok.every(Boolean), 'trang nhận mọi ảnh');
  assert.deepEqual(ok.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(ok[0].pred, [['P.127[50]', 0.93], ['P.127[60]', 0.04], ['other-sign', 0.01]]);
  assert.deepEqual(ok[2].pred, [['P.102', 0.88]]);
  assert.deepEqual(ok.map((c) => c.w), [32, 24, 32]);
  assert.deepEqual(ok.map((c) => c.night), [false, true, false]);
  assert.deepEqual(ok.map((c) => c.drive), ['1', '1', '2'], 'chuyến = số thứ tự ngày trong tệp, không phải ngày tháng');
  assert.equal(Buffer.from(ok[0].png.split(',')[1], 'base64').equals(PNG_1x1), true, 'ảnh giữ nguyên byte');
  assert.deepEqual(j.crops.map((c) => c.outcome), ['accepted', 'near-miss', 'accepted']);
  assert.equal(j.crops[1].reason, 'confidence');
  assert.equal(j.crops[2].night, undefined, 'không biết ngày hay đêm thì không ghi');
  for (const c of j.crops) assert.deepEqual(Object.keys(c).filter((k) => !['id', 'png', 'pred', 'w', 'drive', 'night', 'outcome', 'reason'].includes(k)), []);
  assert.doesNotMatch(text, /"(day|coord|time|t|lat|lon)"/);
  assert.doesNotMatch(text, new RegExp(String(dayNumber(NOON))));
  assert.doesNotMatch(text, /2026/);
});

test('tệp xuất lớn nhất vẫn nằm trong giới hạn của label-crops.html', () => {
  assert.ok(EVAL_MAX_CROPS <= PAGE.MAX_CROPS);
  const b64 = Math.ceil(EVAL_MAX_BYTES / 3) * 4 + 'data:image/png;base64,'.length;
  assert.ok(b64 <= PAGE.MAX_PNG_CHARS, 'một ảnh lớn nhất vẫn được nhận');
  assert.ok(EVAL_MAX_CROPS * (b64 + 300) <= PAGE.MAX_FILE_BYTES, 'cả tệp lớn nhất vẫn mở được');
});

test('tệp xuất bỏ ảnh hỏng; kho trống cho tệp rỗng hợp lệ', async () => {
  const { store } = makeStore();
  assert.deepEqual(JSON.parse(await (await store.exportFile()).text()), { version: 1, crops: [] });
  await store.add(crop());
  // Blob đã lưu bị hỏng sau đó (đọc lỗi).
  const e = store.rows.get(1);
  store.rows.set(1, { ...e, blob: { type: 'image/png', size: 10, arrayBuffer: async () => { throw new Error('hỏng'); } } });
  await store.add(crop());
  assert.deepEqual(JSON.parse(await (await store.exportFile()).text()).crops.map((c) => c.id), ['c2']);
});

test('IndexedDB: cơ sở dữ liệu "banduong-evalcrops" v1, kho "crops" khoá "id"; không có IndexedDB thì không lỗi', async () => {
  const none = evalIdbBackend(EVAL_DB, { indexedDB: undefined });
  assert.deepEqual(await none.getAll(), []);
  await none.put({ id: 1 });
  await none.clear();
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
      return {};
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
  const store = new EvalCrops({ backend: evalIdbBackend(EVAL_DB, { indexedDB: fake }), now: () => NOON, enabled: () => true });
  await store.add(crop());
  assert.deepEqual(made.open, { name: 'banduong-evalcrops', version: 1 });
  assert.deepEqual(made.store, { name: 'crops', opts: { keyPath: 'id' } });
  assert.equal(rows.size, 1);
  assert.equal(rows.get(1).label, 'P.127[50]');
});

test('IndexedDB: chưa từng lưu ảnh thì đọc và xoá lúc khởi động không tạo cơ sở dữ liệu rỗng; put() vẫn tạo', async () => {
  const opened = [];
  let names = [];
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
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = { objectStore: () => storeObj };
      queueMicrotask(() => tx.oncomplete && tx.oncomplete());
      return tx;
    },
  };
  const fake = {
    databases: async () => names.map((name) => ({ name, version: 1 })),
    open(name) {
      opened.push(name);
      names = [...new Set([...names, name])];
      const req = { result: db };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  };
  const backend = evalIdbBackend(EVAL_DB, { indexedDB: fake });
  const off = new EvalCrops({ backend, now: () => NOON, enabled: () => false });
  assert.equal(await off.load(), 0);
  await off.clear();
  assert.deepEqual(opened, []); // camEval chưa từng bật: không có 'banduong-evalcrops'
  const on = new EvalCrops({ backend, now: () => NOON, enabled: () => true });
  await on.add(crop());
  assert.deepEqual(opened, [EVAL_DB]);
  assert.equal(rows.size, 1);
  assert.equal((await backend.getAll()).length, 1);
  // databases() lỗi: mở như thường
  const flaky = { ...fake, databases: async () => { throw new Error('x'); } };
  opened.length = 0;
  names = [];
  await evalIdbBackend(EVAL_DB, { indexedDB: flaky }).getAll();
  assert.deepEqual(opened, [EVAL_DB]);
});
