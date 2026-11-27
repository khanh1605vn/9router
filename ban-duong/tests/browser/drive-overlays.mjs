// Kiểm thử trình duyệt (chạy tay, không thuộc npm test): các bảng chỉ dùng khi xe đỗ không che màn hình lái.
//   node tests/browser/drive-overlays.mjs [--port 20660]
// Đỗ xe ở chế độ xem bản đồ, mở Cài đặt → "Biển camera ghi nhận". GPS rung quanh 1 m/s lúc đỗ: danh sách vẫn mở (không
// đóng dưới tay người dùng). Rồi xe chạy 50 km/h: ứng dụng tự vào chế độ lái và trong 2 giây phải đóng cả hộp thoại lẫn
// bảng Cài đặt, không rời trang. Vị trí GPS là giả (ghi đè navigator.geolocation); mọi máy chủ ngoài bị chặn.
// Không có mạng thì bản đồ không có ô nền: không ảnh hưởng tới kiểm tra.

import assert from 'node:assert/strict';
import { freePort, loadPlaywright, startDevServer } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const CLOSE_WITHIN_MS = 2000;

const port = Number(opt('port', 0)) || (await freePort());
const srv = await startDevServer(port);
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
let failed = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'đạt ' : 'HỎNG'} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
};
try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, serviceWorkers: 'block', locale: 'vi-VN' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => r.abort());
  await ctx.addInitScript(() => {
    let cb = null;
    const fix = { lat: 21.03, lon: 105.85, speed: 0, heading: null };
    const send = () =>
      cb &&
      cb({
        coords: { latitude: fix.lat, longitude: fix.lon, accuracy: 5, speed: fix.speed, heading: fix.heading, altitude: null, altitudeAccuracy: null },
        timestamp: Date.now(),
      });
    navigator.geolocation.watchPosition = (ok) => {
      cb = ok;
      setTimeout(send, 200);
      return 1;
    };
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok && cb && send(), 200);
    navigator.geolocation.clearWatch = () => {};
    setInterval(() => {
      if (fix.speed > 0) fix.lon += fix.speed / 104000; // ~1 s đi về hướng Đông
      send();
    }, 1000);
    globalThis.__setSpeed = (v, h = 90) => {
      fix.speed = v;
      fix.heading = h;
    };
    try {
      speechSynthesis.speak = () => {};
    } catch {
      /* không có */
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
  const read = () =>
    page.evaluate(() => ({
      mode: [...document.querySelectorAll('#sheet .view')].find((v) => !v.hidden)?.dataset.view ?? null,
      modal: !document.getElementById('modal').hidden,
      settings: !document.getElementById('settingsPanel').hidden,
      title: document.getElementById('modalTitle')?.textContent ?? '',
      path: location.pathname,
    }));
  await sleep(7000); // đứng yên hơn 5 giây ở chế độ xem bản đồ: đã đỗ
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await sleep(400);
  await page.evaluate(() => document.getElementById('btnCamList').click());
  await sleep(600);
  let st = await read();
  check('đỗ: Cài đặt và danh sách "Biển camera ghi nhận" mở', st.modal && st.settings && st.title === 'Biển camera ghi nhận', st);
  // GPS rung quanh 1 m/s lúc đỗ: không đóng bảng dưới tay người dùng.
  for (const v of [0.8, 1.2, 1.1, 0.9, 1.2, 0.8]) {
    await page.evaluate((x) => globalThis.__setSpeed(x), v);
    await sleep(1000);
  }
  await page.evaluate(() => globalThis.__setSpeed(0));
  st = await read();
  check('GPS rung 0,8–1,2 m/s lúc đỗ: danh sách vẫn mở, vẫn ở chế độ xem bản đồ', st.modal && st.settings && st.mode === 'browse', st);
  // Xe chạy 50 km/h: tự vào chế độ lái (sau 4 lần định vị từ 4 m/s), bảng phải đóng trong CLOSE_WITHIN_MS.
  await page.evaluate(() => globalThis.__setSpeed(14));
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('#sheet .view[data-view="drive"]')?.hidden === false, null, { timeout: 15000 });
  const tDrive = Date.now();
  let closedAt = null;
  while (Date.now() - tDrive <= CLOSE_WITHIN_MS) {
    st = await read();
    if (!st.modal && !st.settings) {
      closedAt = Date.now() - tDrive;
      break;
    }
    await sleep(100);
  }
  check(`tự vào chế độ lái sau ${Math.round((tDrive - t0) / 1000)} s chạy`, st.mode === 'drive', st.mode);
  check(`hộp thoại và bảng Cài đặt đóng trong ${CLOSE_WITHIN_MS} ms sau khi vào chế độ lái`, closedAt != null, { closedAt, ...st });
  await sleep(1500);
  st = await read();
  check('vẫn ở trang ứng dụng, vẫn ở chế độ lái, không bảng nào mở lại', st.path.endsWith('/index.html') && st.mode === 'drive' && !st.modal && !st.settings, st);
  check('không có lỗi trang', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
  await srv.stop();
}
assert.equal(failed, false, 'có kiểm tra hỏng');
console.log('drive-overlays: đạt');
