// Kiểm thử trình duyệt (chạy tay, không thuộc npm test): tiêu điểm bàn phím trong các hộp thoại camera.
//   node tests/browser/modal-focus.mjs [--port 20660]
// Đỗ xe, mở Cài đặt, bấm Space trên công tắc camera: hộp giới thiệu phải nhận tiêu điểm, Tab và Shift+Tab chỉ đi vòng
// trong hộp, bấm "Bật camera" thì tiêu điểm về lại công tắc (không rơi về BODY). Mở "Kiểm tra camera" (camera giả của
// Chromium, bộ nhận diện giả): thanh kéo đường chân trời là thanh dọc, mũi tên lên làm giá trị tăng, có giá trị đọc,
// viền tập trung nằm bên trong khung xem trước; Escape thì tiêu điểm về nút "Kiểm tra camera". Mọi máy chủ ngoài bị chặn.

import assert from 'node:assert/strict';
import { freePort, loadPlaywright, startDevServer } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);

const port = Number(opt('port', 0)) || (await freePort());
const srv = await startDevServer(port);
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
let failed = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'đạt ' : 'HỎNG'} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
};
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    locale: 'vi-VN',
    permissions: ['camera'],
  });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => r.abort());
  // Mô hình chưa cài trên máy thử: khai báo hai tệp mô hình để ứng dụng coi là có; bộ nhận diện giả không tải gì.
  await ctx.route(/\/js\/mlmanifest\.js/, async (route) => {
    const res = await route.fetch();
    const e = (n) => `{"sha256":"${'ab'.repeat(32)}","size":${n}}`;
    const body = (await res.text()).replace('"files": {', `"files": {"models/sign-det.int8.tflite": ${e(520000)}, "models/sign-cls.int8.tflite": ${e(380000)},`);
    route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('banduong:settings', JSON.stringify({ theme: 'light' }));
    } catch {
      /* không có */
    }
    const fix = { coords: { latitude: 21.03, longitude: 105.85, accuracy: 5, speed: 0, heading: null, altitude: null, altitudeAccuracy: null } };
    navigator.geolocation.watchPosition = (ok) => {
      setInterval(() => ok({ ...fix, timestamp: Date.now() }), 1000);
      return 1;
    };
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok({ ...fix, timestamp: Date.now() }), 100);
    navigator.geolocation.clearWatch = () => {};
    globalThis.__BD_TEST__ = {
      visionFactory: () => ({
        ready: false,
        level: 2,
        load() {
          this.ready = true;
          return Promise.resolve({ build: 'compat' });
        },
        process(f) {
          f.bitmap?.close?.();
          return Promise.resolve({ t: f.t, ms: { total: 10 }, lum: { mean: 120, std: 40 }, boxes: [] });
        },
        terminate() {},
      }),
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__BD_TEST__?.controller?.isParked?.() === true, null, { timeout: 30000 });
  const where = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return { id: a.id || a.tagName, text: (a.textContent || '').trim().slice(0, 30), inModal: document.getElementById('modal').contains(a) };
    });

  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel:not([hidden])');
  await page.focus('#optCamEnabled');
  await page.keyboard.press('Space');
  await page.waitForSelector('#modal:not([hidden]) .cam-intro');
  let w = await where();
  check('hộp giới thiệu mở: tiêu điểm nằm trong hộp', w.inModal, w);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    seen.push(await where());
  }
  check('Tab 8 lần: luôn ở trong hộp (đi vòng)', seen.every((x) => x.inModal), seen.map((x) => x.text || x.id));
  const back = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    back.push(await where());
  }
  check('Shift+Tab 8 lần: luôn ở trong hộp', back.every((x) => x.inModal), back.map((x) => x.text || x.id));
  await page.click('#modal .cam-intro button.primary');
  await page.waitForFunction(() => globalThis.__BD_TEST__.controller.state.enabled === true, null, { timeout: 15000 });
  await page.waitForSelector('#modal', { state: 'hidden' });
  await page.waitForTimeout(300);
  w = await where();
  check('bấm "Bật camera": tiêu điểm về lại công tắc camera, không rơi về BODY', w.id === 'optCamEnabled', w);

  await page.focus('#btnCamCheck');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.cam-aim') && !document.querySelector('.cam-aim').hidden, null, { timeout: 20000 });
  w = await where();
  check('"Kiểm tra camera" mở: tiêu điểm nằm trong hộp', w.inModal, w);
  await page.focus('.cam-aim');
  // Giống người dùng bàn phím: :focus-visible cần lần nhấn phím gần nhất.
  await page.keyboard.press('Shift');
  const before = await page.evaluate(() => {
    const a = document.querySelector('.cam-aim');
    return { now: a.getAttribute('aria-valuenow'), text: a.getAttribute('aria-valuetext'), orient: a.getAttribute('aria-orientation') };
  });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const after = await page.evaluate(() => document.querySelector('.cam-aim').getAttribute('aria-valuenow'));
  check('thanh kéo là thanh dọc, có giá trị đọc', before.orient === 'vertical' && /^Đường chân trời ở \d+% chiều cao hình/.test(before.text || ''), before);
  check('mũi tên lên 2 lần: giá trị tăng', Number(after) > Number(before.now), { before: before.now, after });
  const ring = await page.evaluate(() => {
    const a = document.querySelector('.cam-aim');
    const cs = getComputedStyle(a);
    return { fv: a.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset), color: cs.outlineColor };
  });
  // Khung xem trước cắt phần tràn: viền chỉ thấy được khi nằm hẳn bên trong (offset + bề dày ≤ 0).
  check('viền tập trung của thanh kéo nằm bên trong khung, màu trắng', ring.fv && ring.style === 'solid' && ring.offset + ring.width <= 0 && ring.color === 'rgb(255, 255, 255)', ring);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal', { state: 'hidden' });
  await page.waitForTimeout(200);
  w = await where();
  // Escape đóng cả bảng Cài đặt (closeOverlays): nút "Kiểm tra camera" bị ẩn, nên tiêu điểm về nút Cài đặt.
  check('Escape: tiêu điểm về một nút còn thấy (nút Cài đặt), không rơi về BODY', w.id === 'btnSettings', w);
  check('không có lỗi trang', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
  await srv.stop();
}
assert.equal(failed, false, 'có kiểm tra hỏng');
console.log('modal-focus: đạt');
