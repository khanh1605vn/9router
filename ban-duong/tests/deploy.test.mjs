// Đưa lên mạng (README.md "Đưa lên mạng để dùng trên điện thoại"): `npm run dist` chép đúng các tệp của ứng dụng, đủ
// để chạy (mọi tệp SHELL_FILES và thư mục ML của sw.js) và không có tests/ hay tools/ (các trang thử nghiệm chạy cùng
// địa chỉ sẽ dùng chung quyền camera và dữ liệu của ứng dụng). README ghi rõ chính sách CSP mà bộ nhận diện cần.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  const ctx = {
    self: { addEventListener() {}, location: new URL('https://app.test/sw.js'), registration: { scope: 'https://app.test/' } },
    caches: {},
    fetch() {},
    URL,
    Response,
    Request,
  };
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
  assert.match(README, /trang tạm \*\*khác tên miền\*\*/); // device-bench (PLAN §8.2) vẫn chạy được trên trang riêng
  // Kho khác trên cùng tài khoản GitHub Pages vẫn là cùng địa chỉ gốc: README phải nói thẳng, không để hiểu nhầm.
  assert.match(README, /\*\*không\*\* dùng một kho khác trên `khanh1605vn\.github\.io`/);
  assert.match(README, /Kho khác trên cùng tài khoản \*\*không phải\*\* là địa chỉ khác/);
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

// GitHub Pages (README.md "Mở trên iPhone và máy tính"): không gửi được tiêu đề HTTP, nên index.html mang CSP dạng thẻ
// meta, giống HTML_CSP của ứng dụng Android trừ frame-ancestors (thẻ meta không nhận). Trong WebView hai chính sách
// cùng áp (giao của hai bên), nên phải giống nhau để không chặn thêm gì.
const existsRel = (p) => existsSync(new URL(`../${p}`, import.meta.url));
const directives = (csp) =>
  csp
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();

test('index.html: CSP dạng meta đứng trước mọi script, khớp HTML_CSP của Android (trừ frame-ancestors)', (t) => {
  const html = read('index.html');
  const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  assert.equal(metas.length, 1, 'đúng một thẻ meta CSP');
  const meta = directives(metas[0][1]);
  assert.ok(metas[0].index < html.indexOf('<script'), 'thẻ meta phải đứng trước thẻ script đầu tiên');
  assert.ok(metas[0].index < html.indexOf('<link'), 'thẻ meta phải đứng trước mọi tài nguyên');
  assert.ok(!meta.some((d) => /^(frame-ancestors|report-uri|sandbox)\b/.test(d)), 'chỉ thị thẻ meta không nhận');
  assert.ok(meta.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.ok(meta.includes("worker-src 'self' blob:")); // worker vẽ bản đồ của MapLibre
  assert.ok(!/unsafe-inline|unsafe-eval'|\*/.test(metas[0][1].replace("'wasm-unsafe-eval'", '')));
  // Không có mã nội tuyến (CSP chặn): mọi <script> đều có src.
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\ssrc="[^"]+"/, `script nội tuyến: ${m[0]}`);
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'không có thuộc tính sự kiện nội tuyến');
  const kt = 'android/app/src/main/java/vn/banduong/app/web/WebAssets.kt';
  if (!existsRel(kt)) return t.skip('không có thư mục android/');
  const m = read(kt).match(/const val HTML_CSP = ((?:"[^"]*"\s*\+?\s*)+)/);
  assert.ok(m, 'không đọc được HTML_CSP');
  const header = directives([...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(''));
  assert.deepEqual(meta, header.filter((d) => !d.startsWith('frame-ancestors')));
  assert.ok(header.includes("frame-ancestors 'none'"));
});

test('workflow GitHub Pages: chỉ master, kiểm thử trước, chỉ đưa dist/, quyền tối thiểu, actions ghim SHA', (t) => {
  const p = '../.github/workflows/ban-duong-pages.yml';
  if (!existsRel(p)) return t.skip('không nằm trong kho 9router');
  const y = read(p);
  const job = (name) => {
    const i = y.indexOf(`\n  ${name}:\n`);
    assert.ok(i > 0, `thiếu job ${name}`);
    const rest = y.slice(i + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  assert.match(y, /^on:\n  push:\n    branches:\n      - master\n    paths:\n      - ban-duong\/\*\*\n      - '!ban-duong\/android\/\*\*'\n/m);
  assert.match(y, /^  workflow_dispatch:\n/m);
  const code = y.replace(/^\s*#.*$/gm, ''); // bỏ dòng chú thích
  assert.doesNotMatch(code, /pull_request|secrets\.|GH_TOKEN|github\.token|\$\{\{\s*(secrets|vars)/);
  assert.match(y, /^permissions:\n  contents: read\n/m);
  assert.match(y, /^concurrency:\n  group: ban-duong-pages\n  cancel-in-progress: false\n/m);
  const test_ = job('test');
  assert.match(test_, /permissions:\n      contents: read\n    steps:/);
  assert.match(test_, /working-directory: ban-duong\n        run: npm test/);
  const deploy = job('deploy');
  assert.match(deploy, /needs: test\n/);
  assert.match(deploy, /if: github\.ref == 'refs\/heads\/master'\n/);
  assert.match(deploy, /permissions:\n      contents: read\n      pages: write\n      id-token: write\n    environment:\n      name: github-pages\n/);
  assert.match(deploy, /"\$GITHUB_REF" != "refs\/heads\/master"/);
  assert.match(deploy, /npm run dist/);
  assert.match(deploy, /touch dist\/\.nojekyll/);
  assert.match(deploy, /name: Kiểm tra dist/);
  assert.match(deploy, /path: ban-duong\/dist\n          include-hidden-files: true\n/);
  const uses = [...y.matchAll(/uses: (\S+)/g)].map((x) => x[1]);
  assert.deepEqual(uses.map((u) => u.split('@')[0]).sort(), [
    'actions/checkout', 'actions/checkout', 'actions/deploy-pages', 'actions/setup-node', 'actions/setup-node', 'actions/upload-pages-artifact',
  ]);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, `${u} phải ghim theo SHA commit`);
  // Cùng bản checkout và setup-node với workflow Android.
  const android = '../.github/workflows/ban-duong-android.yml';
  if (existsRel(android)) {
    const a = read(android);
    for (const u of uses.filter((x) => /checkout|setup-node/.test(x))) assert.ok(a.includes(`uses: ${u}`), `${u} khác workflow Android`);
  }
});

test('README: địa chỉ GitHub Pages và việc chủ kho làm một lần', () => {
  assert.match(README, /^## Mở trên iPhone và máy tính$/m);
  assert.match(README, /<https:\/\/khanh1605vn\.github\.io\/9router\/>/);
  assert.match(README, /\*\*Settings\*\* → \*\*Pages\*\* → \*\*Build and deployment\*\* → \*\*Source\*\*, chọn \*\*GitHub Actions\*\*/);
  assert.match(README, /`\.github\/workflows\/ban-duong-pages\.yml`/);
  assert.match(README, /\*\*Đã có bản mới, bấm để tải lại\*\*/);
});
