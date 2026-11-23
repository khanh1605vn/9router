// Kiểm thử trình duyệt của js/camera.js (chạy tay, không thuộc npm test):
//   node tests/browser/camera-smoke.mjs [--out kết-quả.json]
// Chromium của Playwright chạy với camera giả (--use-fake-device-for-media-stream) và tự đồng ý hộp hỏi quyền
// (--use-fake-ui-for-media-stream), quyền camera được cấp bằng grantPermissions. Trang kiểm thử
// (tests/browser/camera-page.html) do máy chủ thử của ứng dụng phục vụ trên một cổng trống trong 20400–20499.
// Kiểm: cameraSupport, permission, list; start → grab trả ImageBitmap đúng cỡ settings; stop trả track; ẩn trang thì
// dừng camera, hiện lại thì tự mở lại khi quyền đã cấp; quyền bị thu hồi (prompt) thì ẩn/hiện không gọi getUserMedia;
// đường dự phòng <video> ẩn (không có ImageCapture) cũng trả ImageBitmap đúng cỡ.
// Bước ẩn trang thật: Playwright luôn giữ trang ở 'visible', nên bước này chạy riêng một Chromium có giao diện (cùng tệp
// chạy của Playwright) điều khiển bằng giao thức DevTools thô, đưa tab khác lên trước để tab camera bị ẩn thật. Không có
// DISPLAY thì tự chạy Chromium đó trong xvfb-run; không có cả xvfb-run thì báo lỗi.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, loadPlaywright, pct, startDevServer } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 8000; // chờ tối đa (ms) cho một điều kiện trong trang

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const OUT = opt('out', null);
const GRABS = 10;

/** Một kết nối DevTools thô: send(method, params) → kết quả, ném lỗi khi CDP báo lỗi. */
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`không nối được ${url}`));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const done = pending.get(d.id);
    if (done) {
      pending.delete(d.id);
      done(d);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? fail(new Error(`${method}: ${JSON.stringify(d.error)}`)) : ok(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/** Chromium có giao diện, cổng gỡ lỗi trống trong 20400–20499, hồ sơ tạm. Trả { base, stop() }. */
async function launchHeaded(executable) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'cam-smoke-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ];
  let cmd = executable;
  let cmdArgs = args;
  if (!process.env.DISPLAY) {
    if (spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error) {
      rmSync(profile, { recursive: true, force: true });
      throw new Error('Bước ẩn trang thật cần màn hình: đặt DISPLAY hoặc cài xvfb-run');
    }
    cmd = 'xvfb-run';
    cmdArgs = ['-a', executable, ...args];
  }
  // Nhóm tiến trình riêng để dừng được cả xvfb-run, Xvfb và Chromium.
  const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
  const exited = new Promise((r) => child.once('exit', r));
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // đã thoát
    }
  };
  const stop = async () => {
    killGroup('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    killGroup('SIGKILL');
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(`${base}/json/version`);
        if (r.ok) break;
      } catch {
        // chưa sẵn sàng
      }
      if (i > 100) throw new Error('Chromium có giao diện không khởi động');
      await sleep(100);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, stop };
}

/**
 * Ẩn trang thật: tab camera bị đưa xuống sau thì phải không còn track nào sống; đưa lên lại thì tự mở lại (quyền đã
 * cấp). Quyền về 'prompt' rồi ẩn/hiện: không gọi getUserMedia. Quyền 'denied': báo 'error:denied', không gọi.
 */
async function realVisibility(server, executable) {
  const chrome = await launchHeaded(executable);
  const conns = [];
  const out = {};
  try {
    const { base } = chrome;
    const browser = await cdp((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl);
    conns.push(browser);
    await browser.send('Browser.grantPermissions', { permissions: ['videoCapture'], origin: server.url });
    const newTab = async (url) => (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const activate = async (tab) => {
      const r = await fetch(`${base}/json/activate/${tab.id}`);
      assert.ok(r.ok, `activate ${tab.id}`);
    };
    const camTab = await newTab(`${server.url}/tests/browser/camera-page.html`);
    const page = await cdp(camTab.webSocketDebuggerUrl);
    conns.push(page);
    const T = page.evaluate;
    const until = async (expr) => {
      for (const t0 = Date.now(); Date.now() - t0 < WAIT_MS; await sleep(100)) {
        if (await T(expr)) return;
      }
      throw new Error(`hết giờ chờ: ${expr} ${JSON.stringify(await snap())}`);
    };
    const snap = () =>
      T('({ vis: document.visibilityState, state: camTest.state(), live: camTest.liveTracks(), gum: camTest.gumCalls.length })');
    await until('window.camTestReady === true');
    await T(`(() => {
      camTest.useRealVisibility();
      camTest.make();
      window.visLog = [];
      document.addEventListener('visibilitychange', () => visLog.push(document.visibilityState));
      return true;
    })()`);
    assert.equal(await T('camTest.permission()'), 'granted');
    await T('camTest.start({ userGesture: false }).then(() => true)');
    out.before = await snap();
    assert.deepEqual(out.before, { vis: 'visible', state: 'on', live: 1, gum: 1 });

    // Tab khác lên trước: tab camera bị ẩn thật, camera phải được trả
    const other = await newTab('about:blank');
    await activate(other);
    await until("document.visibilityState === 'hidden'");
    out.hidden = await snap();
    assert.deepEqual(out.hidden, { vis: 'hidden', state: 'paused', live: 0, gum: 1 }, 'ẩn thật: không còn track nào sống');
    assert.deepEqual(await T('camTest.grab(1)'), [null]);

    // Tab camera lên lại: tự mở lại (quyền đã cấp), lấy được khung
    await activate(camTab);
    await until("document.visibilityState === 'visible' && camTest.state() === 'on'");
    out.visible = await snap();
    assert.deepEqual(out.visible, { vis: 'visible', state: 'on', live: 1, gum: 2 });
    assert.deepEqual(await T('camTest.grab(2).then((a) => a.map((f) => !!(f && f.isBitmap)))'), [true, true]);

    // Quyền về 'prompt' (như quyền "chỉ lần này" đã hết): ẩn rồi hiện không được gọi getUserMedia
    await browser.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'prompt', origin: server.url });
    await until("camTest.permission().then((p) => p === 'prompt')");
    await activate(other);
    await until("document.visibilityState === 'hidden'");
    out.hiddenPrompt = await snap();
    assert.equal(out.hiddenPrompt.live, 0);
    await activate(camTab);
    await until("document.visibilityState === 'visible'");
    await until("camTest.state() === 'error:not-granted'");
    await sleep(300);
    out.visiblePrompt = await snap();
    assert.deepEqual(out.visiblePrompt, { vis: 'visible', state: 'error:not-granted', live: 0, gum: 2 }, 'không gọi getUserMedia');

    // Trang bị chặn camera ('denied'): ẩn/hiện báo 'error:denied' (hướng dẫn bỏ chặn), vẫn không gọi getUserMedia
    await browser.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: server.url });
    await until("camTest.permission().then((p) => p === 'denied')");
    await activate(other);
    await until("document.visibilityState === 'hidden'");
    await activate(camTab);
    await until("document.visibilityState === 'visible' && camTest.state() === 'error:denied'");
    out.visibleDenied = await snap();
    assert.deepEqual(out.visibleDenied, { vis: 'visible', state: 'error:denied', live: 0, gum: 2 });
    out.visLog = await T('visLog.slice()');
    await T('(camTest.stop(), true)');
  } finally {
    for (const c of conns) {
      try {
        c.close();
      } catch {
        // đã đóng
      }
    }
    await chrome.stop();
  }
  return out;
}

async function main() {
  const server = await startDevServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const report = { url: server.url, steps: {} };
  const step = (name, value) => {
    report.steps[name] = value;
    console.log(`ok  ${name}`, JSON.stringify(value));
  };
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['camera'], { origin: server.url });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`${server.url}/tests/browser/camera-page.html`);
    await page.waitForFunction(() => window.camTestReady === true);
    const T = (fn, arg) => page.evaluate(fn, arg);
    const settle = () => page.waitForTimeout(300);

    // 1. Hỗ trợ, quyền, danh sách camera
    const support = await T(() => window.camTest.support());
    assert.deepEqual(support, { ok: true, reason: null });
    await T(() => window.camTest.make());
    const perm = await T(() => window.camTest.permission());
    assert.equal(perm, 'granted');
    const list = await T(() => window.camTest.list());
    assert.ok(list.length >= 1 && list.every((d) => d.deviceId && typeof d.label === 'string'));
    step('support-permission-list', { support, perm, cameras: list.map((d) => d.label) });

    // 2. Tự mở (quyền đã cấp) → grab trả ImageBitmap đúng cỡ settings
    const settings = await T(() => window.camTest.start({ userGesture: false }));
    assert.ok(settings && settings.width > 0 && settings.height > 0, JSON.stringify(settings));
    assert.equal(await T(() => window.camTest.state()), 'on');
    assert.equal((await T(() => window.camTest.gumCalls)).length, 1);
    const frames = await T((n) => window.camTest.grab(n), GRABS);
    for (const f of frames) {
      assert.ok(f, 'grab trả khung');
      assert.ok(f.isBitmap, 'ImageBitmap');
      assert.equal(f.w, settings.width);
      assert.equal(f.h, settings.height);
    }
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i].t > frames[i - 1].t, 't tăng dần');
    // start() lần nữa: không mở thêm
    await T(() => window.camTest.start({ userGesture: false }));
    assert.equal((await T(() => window.camTest.gumCalls)).length, 1);
    step('start-grab', {
      settings,
      focus: await T(() => window.camTest.focus()),
      constraints: (await T(() => window.camTest.gumCalls))[0],
      frames: frames.length,
      bitmap: `${frames[0].w}x${frames[0].h}`,
      grabMs: { p50: pct(frames.map((f) => f.ms), 0.5), p90: pct(frames.map((f) => f.ms), 0.9) },
    });

    // 3. stop() trả track; gọi hai lần vẫn an toàn
    assert.equal(await T(() => window.camTest.liveTracks()), 1);
    await T(() => window.camTest.stop());
    await T(() => window.camTest.stop());
    assert.equal(await T(() => window.camTest.liveTracks()), 0);
    assert.equal(await T(() => window.camTest.state()), 'off');
    assert.deepEqual(await T(() => window.camTest.grab(1)), [null]);
    step('stop', { liveTracks: 0, states: await T(() => window.camTest.states) });

    // 4. Ẩn trang (giả) → dừng camera; hiện lại → tự mở lại (quyền đã cấp)
    await T(() => window.camTest.start({ userGesture: false }));
    assert.equal(await T(() => window.camTest.liveTracks()), 1);
    await T(() => window.camTest.setHidden(true));
    assert.equal(await T(() => window.camTest.liveTracks()), 0, 'ẩn trang: không còn track nào sống');
    assert.equal(await T(() => window.camTest.state()), 'paused');
    assert.deepEqual(await T(() => window.camTest.grab(1)), [null]);
    const callsHidden = (await T(() => window.camTest.gumCalls)).length;
    await T(() => window.camTest.setHidden(false));
    await page.waitForFunction(() => window.camTest.state() === 'on');
    assert.equal((await T(() => window.camTest.gumCalls)).length, callsHidden + 1);
    const again = await T(() => window.camTest.grab(2));
    assert.ok(again.every((f) => f && f.isBitmap));
    step('visibility-fake', { stoppedOnHidden: true, restartedOnVisible: true });

    // 5. Ẩn trang thật (Chromium có giao diện, điều khiển bằng DevTools thô; xem realVisibility)
    step('visibility-real', await realVisibility(server, chromium.executablePath()));

    // 6. Đường dự phòng: không có ImageCapture → <video> ẩn, play() sau lần bấm bật
    await T(() => window.camTest.make({ noImageCapture: true }));
    const auto = await T(() => window.camTest.start({ userGesture: false }));
    assert.equal(auto, null);
    assert.equal(await T(() => window.camTest.state()), 'error:needs-gesture');
    const before = (await T(() => window.camTest.gumCalls)).length;
    const vs = await T(() => window.camTest.start({ userGesture: true }));
    assert.equal((await T(() => window.camTest.gumCalls)).length, before + 1);
    await page.waitForTimeout(500);
    let vframes = [];
    for (let i = 0; i < 20 && !vframes.some(Boolean); i++) {
      vframes = await T(() => window.camTest.grab(1));
      if (!vframes[0]) await page.waitForTimeout(100);
    }
    const vf = vframes.find(Boolean);
    assert.ok(vf && vf.isBitmap, 'video ẩn trả ImageBitmap');
    assert.equal(vf.w, vs.width);
    assert.equal(vf.h, vs.height);
    await T(() => window.camTest.setHidden(true));
    assert.equal(await T(() => window.camTest.liveTracks()), 0);
    await T(() => window.camTest.setHidden(false));
    await page.waitForFunction(() => window.camTest.state() === 'on');
    step('video-fallback', { settings: vs, bitmap: `${vf.w}x${vf.h}` });

    // 7. Quyền bị thu hồi (về 'prompt'): ẩn/hiện không được gọi getUserMedia
    await T(() => window.camTest.make());
    await T(() => window.camTest.start({ userGesture: false }));
    assert.equal(await T(() => window.camTest.state()), 'on');
    await context.clearPermissions();
    const permNow = await T(() => window.camTest.permission());
    // Không về 'prompt' thì bước này không kiểm được gì: báo lỗi chứ không lặng lẽ bỏ qua
    assert.equal(permNow, 'prompt', 'clearPermissions phải đưa quyền camera về prompt');
    await T(() => window.camTest.setHidden(true));
    assert.equal(await T(() => window.camTest.liveTracks()), 0);
    const callsBefore = (await T(() => window.camTest.gumCalls)).length;
    await T(() => window.camTest.setHidden(false));
    await settle();
    const callsAfter = (await T(() => window.camTest.gumCalls)).length;
    const stateAfter = await T(() => window.camTest.state());
    assert.equal(callsAfter, callsBefore, 'quyền chưa cấp: không gọi getUserMedia');
    assert.equal(stateAfter, 'error:not-granted');
    step('permission-revoked', { permission: permNow, gumCallsBefore: callsBefore, gumCallsAfter: callsAfter, state: stateAfter });

    await T(() => window.camTest.stop());
    assert.equal(await T(() => window.camTest.liveTracks()), 0);
    assert.deepEqual(errors, [], 'không có lỗi trên trang');
    report.ok = true;
  } finally {
    await browser.close();
    await server.stop();
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('camera-smoke: tất cả đều đạt');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
