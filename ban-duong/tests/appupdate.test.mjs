// Cập nhật ứng dụng Android trong ứng dụng (AppUpdate trong js/carbridge.js): đọc trạng thái từ máy, chữ hiển thị, gửi ý định.
// Lúc hiện lời mời (xe đứng yên) và bản web mới qua service worker (js/appupdate.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_UPDATE_LIMITS,
  AppUpdate,
  createAppUpdate,
  describeUpdate,
  NATIVE_EVENT,
  nativeUpdateSupport,
  parseUpdateStatus,
} from '../js/carbridge.js';
import { readFileSync } from 'node:fs';

import {
  askWorkerVersion,
  planPrompts,
  QUIET,
  QuietGate,
  SHELL_VERSION,
  SW_RELOAD_TEXT,
  SW_UPDATE,
  SwUpdateWatcher,
} from '../js/appupdate.js';

function fakeWindow(update = { mode: 'install', current: '1.1.0' }) {
  const listeners = new Map();
  const sent = [];
  return {
    BanDuongNative: { postMessage: (s) => sent.push(JSON.parse(s)) },
    BanDuongApp: { v: 1, obd: null, update },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    native(msg) {
      for (const fn of listeners.get(NATIVE_EVENT) || []) fn({ detail: msg });
    },
    sent,
  };
}

const status = (o) => ({ v: 1, type: 'updateStatus', state: 'idle', versionName: null, notes: null, progress: null, error: null, mode: 'install', current: '1.1.0', ...o });

test('chỉ có trong ứng dụng Android có tự cập nhật', () => {
  assert.equal(nativeUpdateSupport({}), null);
  assert.equal(nativeUpdateSupport({ BanDuongNative: { postMessage() {} }, BanDuongApp: { update: null } }), null);
  assert.equal(nativeUpdateSupport({ BanDuongNative: { postMessage() {} }, BanDuongApp: { update: { mode: 'off' } } }), null);
  assert.deepEqual(nativeUpdateSupport(fakeWindow()), { mode: 'install', current: '1.1.0' });
  assert.deepEqual(nativeUpdateSupport(fakeWindow({ mode: 'notify', current: '<b>' })), { mode: 'notify', current: null });
  const throwing = { get BanDuongNative() { throw new Error('x'); } };
  assert.equal(nativeUpdateSupport(throwing), null);
  assert.equal(createAppUpdate({ env: {} }), null);
});

test('đọc chặt thông điệp updateStatus', () => {
  assert.equal(parseUpdateStatus(null), null);
  assert.equal(parseUpdateStatus(status({ v: 2 })), null);
  assert.equal(parseUpdateStatus(status({ type: 'native' })), null);
  assert.equal(parseUpdateStatus(status({ state: 'hacked' })), null);
  const s = parseUpdateStatus(status({ state: 'downloading', versionName: '1.2.0', progress: 1.7, notes: 'Mới‮\u0000  lắm', error: 'Bad Code' }));
  assert.equal(s.state, 'downloading');
  assert.equal(s.versionName, '1.2.0');
  assert.equal(s.progress, 1);
  assert.equal(s.notes, 'Mới lắm');
  assert.equal(s.error, null);
  assert.equal(parseUpdateStatus(status({ versionName: '1.2.0<script>' })).versionName, null);
  assert.equal(parseUpdateStatus(status({ progress: NaN })).progress, null);
  const long = parseUpdateStatus(status({ notes: 'x'.repeat(500) }));
  assert.equal(long.notes.length, APP_UPDATE_LIMITS.maxNotes);
});

test('chữ tiếng Việt cho từng trạng thái', () => {
  const sup = { mode: 'install', current: '1.1.0' };
  const d = (o) => describeUpdate(parseUpdateStatus(status(o)), sup);
  assert.equal(d({}).line, 'Phiên bản đang dùng: 1.1.0.');
  assert.equal(d({}).pill, false);
  assert.equal(d({ state: 'checking' }).busy, true);
  assert.equal(d({ state: 'uptodate' }).line, 'Bạn đang dùng bản mới nhất (1.1.0).');
  const a = d({ state: 'available', versionName: '1.2.0', notes: 'Sửa lỗi.' });
  assert.equal(a.pill, true);
  assert.equal(a.pillText, 'Có phiên bản mới 1.2.0');
  assert.equal(a.action, 'install');
  assert.equal(a.actionLabel, 'Cập nhật');
  assert.equal(a.note, 'Sửa lỗi.');
  assert.equal(d({ state: 'downloading', versionName: '1.2.0', progress: 0.456 }).pillText, 'Đang tải bản mới 46%');
  assert.equal(d({ state: 'ready', versionName: '1.2.0' }).action, null);
  assert.equal(d({ state: 'ready', versionName: '1.2.0', error: 'install-aborted' }).action, 'install');
  assert.equal(d({ state: 'error', error: 'network' }).pill, false, 'lỗi khi kiểm tra chỉ hiện trong cài đặt');
  const drv = d({ state: 'error', error: 'driving', versionName: '1.2.0' });
  assert.equal(drv.line, 'Hãy dừng xe an toàn, chờ định vị bắt được rồi bấm “Cập nhật”.');
  assert.equal(drv.action, 'install');
  assert.match(d({ state: 'error', error: 'signature-mismatch', versionName: '1.2.0' }).line, /chữ ký/);
  assert.match(d({ state: 'error', error: 'không-biết' }).line, /Chưa cập nhật được/);
  const n = describeUpdate(parseUpdateStatus(status({ state: 'available', versionName: '1.2.0', mode: 'notify' })), sup);
  assert.equal(n.actionLabel, 'Tải bản chính thức');
  // Không có chữ in hoa toàn bộ.
  for (const st of ['idle', 'checking', 'uptodate', 'available', 'downloading', 'verifying', 'ready', 'error']) {
    const x = d({ state: st, versionName: '1.2.0', error: 'network' });
    for (const s of [x.line, x.pillText, x.actionLabel]) assert.ok(!/[A-ZĐ]{3,}/.test(s), s);
  }
});

test('gửi đúng ý định, không bao giờ có URL; install bị giãn 10 giây', () => {
  let now = 0;
  const win = fakeWindow();
  const u = createAppUpdate({ env: win, now: () => now });
  assert.ok(u instanceof AppUpdate);
  const seen = [];
  u.onChange((s) => seen.push(s.state));
  u.start();
  assert.deepEqual(win.sent.at(-1), { v: 1, type: 'update', action: 'status' });
  win.native(status({ state: 'available', versionName: '1.2.0' }));
  win.native({ v: 1, type: 'obdState' }); // loại khác: bỏ qua
  assert.deepEqual(seen, ['available']);
  assert.equal(u.status.versionName, '1.2.0');
  u.check();
  assert.equal(u.install(), true);
  assert.equal(u.install(), false);
  now += APP_UPDATE_LIMITS.installGapMs;
  assert.equal(u.install(), true);
  u.dismiss();
  assert.deepEqual(win.sent.map((m) => m.action), ['status', 'check', 'install', 'install', 'dismiss']);
  for (const m of win.sent) assert.deepEqual(Object.keys(m).sort(), ['action', 'type', 'v']);
  u.stop();
  win.native(status({ state: 'idle' }));
  assert.deepEqual(seen, ['available']);
});

// ---------- Lúc hiện lời mời và bản web mới (js/appupdate.js) ----------

test('lời mời chỉ hiện khi xe đứng yên đủ lâu, không dẫn đường, không có cảnh báo', () => {
  let now = 0;
  const g = new QuietGate({ now: () => now });
  assert.equal(g.update({ kmh: 0 }), false, 'vừa dừng: chưa hiện');
  now += QUIET.stopHoldMs - 1;
  assert.equal(g.update({ kmh: 3 }), false);
  now += 1;
  assert.equal(g.update({ kmh: 3 }), true, 'đứng yên đủ lâu: hiện');
  assert.equal(g.update({ kmh: 3, alert: true }), false, 'cảnh báo đang hiện: nhường chỗ');
  assert.equal(g.update({ kmh: 3 }), true, 'hết cảnh báo: hiện lại ngay, không đếm lại');
  assert.equal(g.update({ kmh: 0, driving: true }), false, 'đang dẫn đường: không hiện dù xe đứng');
  now += 1000;
  assert.equal(g.update({ kmh: 0 }), false, 'thôi dẫn đường: đếm lại thời gian đứng yên');
  now += QUIET.stopHoldMs;
  assert.equal(g.update({ kmh: 0 }), true);
  assert.equal(g.update({ kmh: QUIET.movingKmh }), false, 'xe chạy: ẩn ngay');
  assert.equal(g.update({ kmh: 60 }), false);
  // Mất tốc độ ngay sau khi chạy (trong hầm): chưa coi là đứng yên.
  now += 1000;
  assert.equal(g.update({ kmh: null }), false);
  now += QUIET.unknownHoldMs - 1000;
  assert.equal(g.update({ kmh: NaN }), false);
  now += 1000 + QUIET.stopHoldMs;
  assert.equal(g.update({ kmh: null }), true, 'lâu không thấy xe chạy: coi là đứng yên');
  // Bản web, mở mà chưa có GPS: chưa biết xe có chạy không, chờ như vừa thấy xe chạy (unknownHoldMs) rồi mới hiện.
  const g2 = new QuietGate({ now: () => now });
  assert.equal(g2.update({}), false);
  now += QUIET.stopHoldMs;
  assert.equal(g2.update({}), false, 'mới mở, không có tốc độ: không coi là đứng yên');
  now += QUIET.unknownHoldMs - QUIET.stopHoldMs;
  assert.equal(g2.update({}), false, 'vừa đủ unknownHoldMs: bắt đầu đếm stopHoldMs');
  now += QUIET.stopHoldMs;
  assert.equal(g2.update({}), true);
});

test('trong ứng dụng Android: chưa từng thấy tốc độ thật thì không bao giờ hiện (mở máy lúc xe đang lăn bánh)', () => {
  let now = 0;
  const g = new QuietGate({ now: () => now, requireSpeed: true });
  for (let i = 0; i < 20; i++) {
    assert.equal(g.update({ kmh: null }), false);
    now += 60_000;
  }
  assert.equal(g.update({ kmh: NaN }), false, 'sau 20 phút vẫn không có tốc độ: không hiện');
  // GPS bắt được: xe đang chạy rồi dừng.
  assert.equal(g.update({ kmh: 40 }), false);
  now += 1000;
  assert.equal(g.update({ kmh: 0 }), false, 'vừa dừng');
  now += QUIET.stopHoldMs;
  assert.equal(g.update({ kmh: 0 }), true, 'tốc độ thật dưới ngưỡng đủ lâu: hiện');
  // Đỗ trong hầm, GPS thôi báo: lần cuối thấy xe chạy chưa đủ lâu thì ẩn, đủ lâu thì coi là vẫn đỗ.
  assert.equal(g.update({ kmh: null }), false);
  now += QUIET.unknownHoldMs;
  assert.equal(g.update({ kmh: null }), false, 'bắt đầu đếm lại stopHoldMs');
  now += QUIET.stopHoldMs;
  assert.equal(g.update({ kmh: null }), true);
  // Mất tốc độ ngay sau khi chạy: không hiện trong unknownHoldMs.
  assert.equal(g.update({ kmh: 30 }), false);
  now += QUIET.unknownHoldMs - 1;
  assert.equal(g.update({ kmh: null }), false);
});

test('chọn lời mời: bản cài Android thay cả bản web nên được ưu tiên', () => {
  assert.deepEqual(planPrompts({ nativePill: true, swVisible: true, quiet: true }), { native: true, sw: false });
  assert.deepEqual(planPrompts({ nativePill: false, swVisible: true, quiet: true }), { native: false, sw: true });
  assert.deepEqual(planPrompts({ nativePill: true, swVisible: true, quiet: false }), { native: false, sw: false });
  assert.deepEqual(planPrompts(), { native: false, sw: false });
});

test('bản Android mới khi xe đang chạy được giữ lại tới lúc dừng', () => {
  let now = 0;
  const win = fakeWindow();
  const u = createAppUpdate({ env: win, now: () => now });
  const gate = new QuietGate({ now: () => now });
  u.start();
  const show = (kmh, extra = {}) => {
    const d = describeUpdate(u.status, u.support);
    return planPrompts({ nativePill: d.pill, quiet: gate.update({ kmh, ...extra }) }).native;
  };
  assert.equal(show(50), false);
  win.native(status({ state: 'available', versionName: '1.2.0' }));
  assert.equal(show(50), false, 'đang chạy: chưa hiện');
  now += 60_000;
  assert.equal(show(45, { driving: true }), false);
  now += 1000;
  assert.equal(show(0), false, 'vừa dừng');
  now += QUIET.stopHoldMs;
  assert.equal(show(0), true, 'dừng đủ lâu: hiện "Có phiên bản mới 1.2.0"');
  assert.equal(describeUpdate(u.status, u.support).pillText, 'Có phiên bản mới 1.2.0');
  win.native(status({ state: 'downloading', versionName: '1.2.0', progress: 0.45 }));
  assert.equal(describeUpdate(u.status, u.support).pillText, 'Đang tải bản mới 45%');
  assert.equal(show(20), false, 'xe chạy lại: ẩn, máy vẫn tải tiếp');
  // Trang không bao giờ gửi URL hay số phiên bản: chỉ ý định.
  for (const m of win.sent) assert.deepEqual(Object.keys(m).sort(), ['action', 'type', 'v']);
});

/** navigator.serviceWorker giả: phát "controllerchange" khi service worker mới nắm trang. */
function fakeContainer(controller = null) {
  const fns = new Set();
  return {
    controller,
    addEventListener(type, fn) {
      if (type === 'controllerchange') fns.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'controllerchange') fns.delete(fn);
    },
    claim(worker = {}) {
      this.controller = worker;
      for (const fn of fns) fn({ type: 'controllerchange' });
    },
  };
}

test('bản web: lần đầu service worker nắm trang thì không mời tải lại', () => {
  const c = fakeContainer(null);
  const w = new SwUpdateWatcher(c, { reload: () => assert.fail('không được tải lại') });
  let changes = 0;
  w.onChange(() => changes++);
  w.start();
  c.claim();
  assert.equal(w.pending, false);
  assert.equal(changes, 0);
  // Bản sau đó nắm trang: lúc này mới là bản mới.
  c.claim();
  assert.equal(w.pending, true);
  assert.equal(changes, 1);
});

test('bản web mới: hiện "tải lại", chỉ tải lại khi bấm lúc xe đứng yên; "Để sau" ẩn một lúc', () => {
  let now = 0;
  let reloads = 0;
  const c = fakeContainer({ id: 'cũ' });
  const w = new SwUpdateWatcher(c, { now: () => now, reload: () => reloads++ });
  w.start();
  assert.equal(w.visible, false);
  assert.equal(w.reload({ quiet: true }), false, 'chưa có bản mới: không tải lại');
  c.claim({ id: 'mới' });
  assert.equal(w.pending, true);
  assert.equal(w.visible, true);
  assert.equal(SW_RELOAD_TEXT, 'Đã có bản mới, bấm để tải lại');
  assert.equal(reloads, 0, 'không tự tải lại');
  assert.equal(w.reload({ quiet: false }), false, 'xe đang chạy: không tải lại');
  assert.equal(reloads, 0);
  w.dismiss();
  assert.equal(w.visible, false);
  now += SW_UPDATE.snoozeMs;
  assert.equal(w.visible, true, 'hết thời gian "Để sau": mời lại');
  c.claim({ id: 'mới hơn' });
  assert.equal(w.reload({ quiet: true }), true);
  assert.equal(reloads, 1);
  w.stop();
});

test('bản web: thỉnh thoảng hỏi sw.js mới, không hỏi khi đang lái hay đã có bản mới', async () => {
  let now = 0;
  let asked = 0;
  const c = fakeContainer({});
  const w = new SwUpdateWatcher(c, { now: () => now, reload() {} });
  w.start();
  assert.equal(w.tick({ allowCheck: true }), false, 'chưa đăng ký: không hỏi');
  w.attach({ update: async () => asked++ });
  assert.equal(w.tick({ allowCheck: true }), false, 'register() vừa hỏi');
  now += SW_UPDATE.checkEveryMs;
  assert.equal(w.tick({ allowCheck: false }), false, 'đang lái: không hỏi');
  assert.equal(w.tick({ allowCheck: true }), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 1);
  assert.equal(w.tick({ allowCheck: true }), false, 'vừa hỏi');
  now += SW_UPDATE.checkEveryMs;
  c.claim({});
  assert.equal(w.tick({ allowCheck: true }), false, 'đã có bản mới: thôi hỏi');
  // Hỏi lỗi (mất mạng) không ném ra ngoài.
  const w2 = new SwUpdateWatcher(fakeContainer({}), { now: () => now });
  w2.attach({ update: () => Promise.reject(new Error('offline')) });
  now += SW_UPDATE.checkEveryMs;
  assert.equal(w2.tick({ allowCheck: true }), true);
  await new Promise((r) => setTimeout(r, 0));
  // Không có service worker (trình duyệt cũ): không làm gì.
  const none = new SwUpdateWatcher(null);
  none.start();
  assert.equal(none.visible, false);
});

test('bản web: service worker mới cùng bản với mã trang (vỏ ưu tiên mạng, vừa cập nhật bản cài) thì không mời tải lại', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const asked = [];
  const versions = { cũ: 'v9', 'cùng bản': SHELL_VERSION, 'bản sau': 'v99' };
  const c = fakeContainer({ id: 'cũ' });
  const w = new SwUpdateWatcher(c, {
    pageVersion: SHELL_VERSION,
    askVersion: async (worker) => {
      asked.push(worker.id);
      return versions[worker.id] ?? null;
    },
  });
  let changes = 0;
  w.onChange(() => changes++);
  w.start();
  c.claim({ id: 'cùng bản' });
  await tick();
  assert.deepEqual(asked, ['cùng bản']);
  assert.equal(w.pending, false, 'trang đã chạy mã mới: không mời');
  assert.equal(changes, 0);
  c.claim({ id: 'bản sau' });
  await tick();
  assert.equal(w.pending, true, 'service worker mới hơn mã trang: mời tải lại');
  assert.equal(changes, 1);
  // Không hỏi được bản (không trả lời, lỗi): vẫn mời.
  const c2 = fakeContainer({ id: 'cũ' });
  const w2 = new SwUpdateWatcher(c2, { pageVersion: SHELL_VERSION, askVersion: async () => { throw new Error('x'); } });
  w2.start();
  c2.claim({ id: 'lạ' });
  await tick();
  assert.equal(w2.pending, true);
});

test('hỏi bản của service worker qua MessageChannel; không trả lời hay trả lời lạ → null', async () => {
  const worker = (reply) => ({
    postMessage(msg, ports) {
      assert.deepEqual(msg, { type: 'banduong:version' });
      if (reply !== undefined) ports[0].postMessage(reply);
    },
  });
  assert.equal(await askWorkerVersion(worker({ type: 'banduong:version', version: 'v12' })), 'v12');
  assert.equal(await askWorkerVersion(worker({ type: 'banduong:version', version: '<b>' })), null);
  assert.equal(await askWorkerVersion(worker({ type: 'other', version: 'v12' })), null);
  assert.equal(await askWorkerVersion(worker(undefined), { timeoutMs: 20 }), null, 'không trả lời: hết hạn chờ');
  assert.equal(await askWorkerVersion(null), null);
  assert.equal(await askWorkerVersion({ postMessage() { throw new Error('x'); } }), null);
});

test('SHELL_VERSION của trang bằng VERSION của sw.js', () => {
  const src = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const m = /^const VERSION = '([^']+)';$/m.exec(src);
  assert.ok(m, 'sw.js có VERSION');
  assert.equal(SHELL_VERSION, m[1], 'đổi VERSION trong sw.js thì đổi luôn SHELL_VERSION trong js/appupdate.js');
});
