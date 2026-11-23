// Đưa lên mạng (README.md "Đưa lên mạng để dùng trên điện thoại"): `npm run dist` chép đúng các tệp của ứng dụng, đủ
// để chạy (mọi tệp SHELL_FILES và thư mục ML của sw.js) và không có tests/ hay tools/ (các trang thử nghiệm chạy cùng
// địa chỉ sẽ dùng chung quyền camera và dữ liệu của ứng dụng). README ghi rõ chính sách CSP mà bộ nhận diện cần.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const README = read('README.md');

/** Danh sách tệp và thư mục mà lệnh dist chép (đọc từ package.json). */
function distEntries() {
  const cmd = JSON.parse(read('package.json')).scripts.dist;
  assert.equal(typeof cmd, 'string', 'package.json phải có lệnh dist');
  const m = cmd.match(/for\(const p of (\[[^\]]*\])\)/);
  assert.ok(m, 'không đọc được danh sách tệp của lệnh dist');
  return [...vm.runInNewContext(m[1])];
}

function swLists() {
  const ctx = { self: { addEventListener() {} }, caches: {}, fetch() {}, URL, Response, Request };
  vm.createContext(ctx);
  vm.runInContext(`${read('sw.js')}\n;self.__sw = { SHELL_FILES, ML_DIRS, NEVER_CACHE_DIRS };`, ctx);
  return ctx.self.__sw;
}

test('npm run dist: chép đủ tệp để chạy, không có tests/ và tools/', () => {
  const entries = distEntries();
  assert.deepEqual(entries, ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor', 'models']);
  const covered = (p) => entries.some((e) => p === e || p.startsWith(`${e}/`));
  const { SHELL_FILES, ML_DIRS, NEVER_CACHE_DIRS } = swLists();
  for (const f of SHELL_FILES) if (f !== './') assert.ok(covered(f), `${f} thiếu trong dist`);
  for (const d of ML_DIRS) assert.ok(covered(d.replace(/\/$/, '')), `${d} thiếu trong dist`);
  for (const d of NEVER_CACHE_DIRS) assert.ok(!covered(d.replace(/\/$/, '')), `${d} không được có trong dist`);
  assert.match(read('.gitignore'), /^\/dist\/$/m);
});

test('README: đưa thư mục dist lên, không đưa tests/ và tools/ lên trang dùng khi lái', () => {
  assert.match(README, /Chạy `npm run dist`/);
  assert.match(README, /Kéo thư mục `dist` thả vào trang/);
  assert.doesNotMatch(README, /Kéo cả thư mục `ban-duong`/);
  assert.match(README, /\*\*Không đưa `tests\/` và `tools\/` lên trang này\*\*/);
  assert.match(README, /trang tạm \*\*khác địa chỉ\*\*/); // device-bench (PLAN §8.2) vẫn chạy được trên trang riêng
});

test('README: chính sách CSP tách trang và js/vision-worker.js, khớp cách worker nạp LiteRT', () => {
  const worker = read('js/vision-worker.js');
  // Worker chạy mã LiteRT qua blob: và tự dịch wasm: đúng lý do chính sách của nó cần blob: và 'wasm-unsafe-eval'.
  assert.match(worker, /importScripts\(iife\)/);
  assert.match(worker, /WebAssembly\.instantiate\(/);
  assert.match(worker, /README\.md/);
  assert.match(README, /### Nếu thêm Content-Security-Policy/);
  assert.match(README, /worker-src 'self' blob:/); // worker vẽ bản đồ của MapLibre
  assert.match(README, /\*\*`js\/vision-worker\.js`\*\*[^\n]*script-src 'self' blob: 'wasm-unsafe-eval'/);
  assert.match(README, /Đừng đặt chính sách của trang chung cho mọi đường dẫn \(`\/\*`\)/);
});

test('README: hình ảnh chỉ được lưu khi người dùng bật lưu ảnh kiểm tra; ảnh quá 30 ngày bị xoá cả khi đã tắt', () => {
  assert.doesNotMatch(README, /Hình ảnh từ camera không bao giờ được lưu hay gửi đi/);
  assert.doesNotMatch(README, /không lưu hay gửi hình ảnh đi đâu/);
  assert.match(README, /không được lưu trừ khi bạn bật \*\*Lưu ảnh biển để kiểm tra độ chính xác\*\*/);
  assert.match(README, /Ảnh quá 30 ngày bị xoá cả khi đã tắt tuỳ chọn này/);
});
