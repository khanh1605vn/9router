import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SW_SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://app.test';
const SCOPE = `${ORIGIN}/ban-duong/`;

// Tệp giai đoạn 2 (đang được viết song song). Khi chưa có, kiểm tra "có trên đĩa" chỉ là todo, không làm đỏ bộ thử.
const PHASE2_FILES = ['js/camctl.js', 'js/camui.js', 'js/evalcrops.js'];
// Mọi tệp chạy thật của tính năng camera phải có trong SHELL_FILES để mở được khi mất mạng.
const CAMERA_RUNTIME_FILES = [
  'js/camera.js',
  'js/camsched.js',
  'js/vision.js',
  'js/vision-worker.js',
  'js/visionproto.js',
  'js/mlmanifest.js',
  'js/signtrack.js',
  'js/signlearn.js',
  'js/learnedsigns.js',
  ...PHASE2_FILES,
];

const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Bộ nhớ đệm giả theo Cache API: khoá là địa chỉ đầy đủ; ignoreSearch so cả địa chỉ trừ phần ?… */
class FakeCache {
  constructor() {
    this.map = new Map();
    this.puts = [];
  }
  static key(req) {
    return typeof req === 'string' ? req : req.url;
  }
  async match(req, { ignoreSearch = false } = {}) {
    const k = FakeCache.key(req);
    if (!ignoreSearch) return this.map.get(k)?.clone();
    const strip = (u) => u.split('?')[0];
    for (const [kk, v] of this.map) if (strip(kk) === strip(k)) return v.clone();
    return undefined;
  }
  async put(req, res) {
    const k = FakeCache.key(req);
    const buf = await res.arrayBuffer(); // giống trình duyệt: thân lỗi giữa chừng thì put thất bại
    this.puts.push(k);
    this.map.set(k, new Response(buf, { status: res.status, headers: res.headers }));
  }
  async addAll(list) {
    this.added = list.slice();
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
  async delete(req) {
    return this.map.delete(FakeCache.key(req));
  }
}

class FakeCaches {
  constructor() {
    this.stores = new Map();
  }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name) {
    return this.stores.delete(name);
  }
  get(name) {
    return this.stores.get(name);
  }
}

/** Câu trả lời mạng giả: Response thật, cộng type/url/redirected như trình duyệt đặt. */
function netResponse(body, { status = 200, type = 'basic', url, redirected = false } = {}) {
  const res = new Response(status === 204 ? null : body, { status });
  Object.defineProperty(res, 'type', { value: type });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: redirected });
  return res;
}

/** Nạp sw.js trong node:vm với self, caches, fetch và clients giả. */
function loadSw({ fetchImpl } = {}) {
  const listeners = {};
  const fetched = [];
  const caches = new FakeCaches();
  const calls = { skipWaiting: 0, claim: 0 };
  const ctx = {
    URL,
    Request,
    Response,
    Headers,
    RegExp,
    crypto: globalThis.crypto,
    caches,
    location: new URL(`${SCOPE}sw.js`),
    registration: { scope: SCOPE },
    clients: { claim: async () => void calls.claim++ },
    skipWaiting: async () => void calls.skipWaiting++,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fetch: async (req) => {
      fetched.push(typeof req === 'string' ? req : req.url);
      if (!fetchImpl) throw new TypeError('offline');
      return fetchImpl(req);
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${SW_SOURCE}\n;self.__sw = { SHELL_FILES, VERSION, SHELL, ML, ML_HASH_LEN };`, ctx, { filename: 'sw.js' });

  /** Phát một sự kiện fetch; trả { handled, response, settled } khi mọi waitUntil đã xong. */
  async function dispatchFetch(url, init = {}) {
    const request = new Request(url, init);
    const pending = [];
    let responded = null;
    const event = {
      request,
      respondWith: (p) => {
        responded = Promise.resolve(p);
      },
      waitUntil: (p) => pending.push(Promise.resolve(p)),
    };
    listeners.fetch(event);
    if (!responded) return { handled: false };
    let response;
    let error = null;
    try {
      response = await responded;
    } catch (err) {
      error = err;
    }
    // waitUntil có thể được gọi muộn (sau khi đã có câu trả lời): chờ tới khi không còn việc nào.
    for (let i = 0; i < pending.length; i++) await pending[i].catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < pending.length; i++) await pending[i].catch(() => {});
    return { handled: true, response, error };
  }

  async function dispatchLifecycle(type) {
    let p = null;
    listeners[type]({ waitUntil: (x) => (p = x) });
    await p;
  }

  return { sw: ctx.__sw, caches, fetched, calls, dispatchFetch, dispatchLifecycle };
}

// ---------------------------------------------------------------------------------------------------------------------

test('VERSION đã tăng và tên bộ nhớ đệm ML cố định, không gắn VERSION', () => {
  const { sw } = loadSw();
  assert.equal(sw.VERSION, 'v6');
  assert.equal(sw.SHELL, 'banduong-shell-v6');
  assert.equal(sw.ML, 'banduong-ml-1');
  assert.ok(!sw.ML.startsWith('banduong-shell-'));
});

test('độ dài ?v= khớp HASH_QUERY của js/vision.js', () => {
  const { sw } = loadSw();
  const m = readFileSync(join(ROOT, 'js/vision.js'), 'utf8').match(/const HASH_QUERY = (\d+);/);
  assert.ok(m, 'không tìm thấy HASH_QUERY trong js/vision.js');
  assert.equal(sw.ML_HASH_LEN, Number(m[1]));
});

test('tệp ML: ưu tiên bộ nhớ đệm, khoá bằng cả địa chỉ gồm ?v=', async () => {
  const body = new TextEncoder().encode('detector bytes');
  const url = `${SCOPE}models/det.tflite?v=${sha16(body)}`;
  const t = loadSw({ fetchImpl: () => netResponse(body, { url }) });

  const first = await t.dispatchFetch(url);
  assert.ok(first.handled);
  assert.deepEqual(new Uint8Array(await first.response.arrayBuffer()), body);
  assert.deepEqual([...t.caches.get('banduong-ml-1').map.keys()], [url]);
  assert.equal(t.caches.get('banduong-shell-v6'), undefined, 'không được lọt vào bộ nhớ đệm vỏ ứng dụng');

  // Lần sau: không hỏi mạng nữa.
  const second = await t.dispatchFetch(url);
  assert.deepEqual(new Uint8Array(await second.response.arrayBuffer()), body);
  assert.equal(t.fetched.length, 1);

  // Bản mô hình mới (?v= khác) không được khớp với bản cũ: phải hỏi mạng.
  const other = `${SCOPE}models/det.tflite?v=${'0'.repeat(16)}`;
  const third = await t.dispatchFetch(other);
  assert.ok(third.handled);
  assert.deepEqual(t.fetched, [url, other]);
});

test('tệp ML: mất mạng thì vẫn dùng được bản đã lưu', async () => {
  const body = new TextEncoder().encode('wasm bytes');
  const url = `${SCOPE}vendor/litert/litert_wasm_internal.wasm?v=${sha16(body)}`;
  let online = true;
  const t = loadSw({
    fetchImpl: () => {
      if (!online) throw new TypeError('offline');
      return netResponse(body, { url });
    },
  });
  await t.dispatchFetch(url);
  online = false;
  const r = await t.dispatchFetch(url);
  assert.deepEqual(new Uint8Array(await r.response.arrayBuffer()), body);
});

test('tệp ML: lưu bản mới thì bỏ bản ?v= cũ của cùng tệp, giữ tệp khác', async () => {
  const a = new TextEncoder().encode('model A');
  const b = new TextEncoder().encode('model B');
  const lab = new TextEncoder().encode('{"version":1}');
  const urlA = `${SCOPE}models/cls.tflite?v=${sha16(a)}`;
  const urlB = `${SCOPE}models/cls.tflite?v=${sha16(b)}`;
  const urlL = `${SCOPE}models/labels.json?v=${sha16(lab)}`;
  const bodies = { [urlA]: a, [urlB]: b, [urlL]: lab };
  const t = loadSw({ fetchImpl: (req) => netResponse(bodies[req.url], { url: req.url }) });
  await t.dispatchFetch(urlA);
  await t.dispatchFetch(urlL);
  await t.dispatchFetch(urlB);
  assert.deepEqual([...t.caches.get('banduong-ml-1').map.keys()].sort(), [urlB, urlL].sort());
});

test('tệp ML: câu trả lời lỗi, 206, khác nguồn, chuyển hướng hay mờ không bao giờ được lưu', async () => {
  const body = new TextEncoder().encode('x');
  const url = `${SCOPE}models/det.tflite?v=${sha16(body)}`;
  const cases = [
    { status: 404 },
    { status: 500 },
    { status: 206 },
    { type: 'opaque' },
    { type: 'cors' },
    { redirected: true },
    { url: 'https://evil.test/models/det.tflite' },
  ];
  for (const c of cases) {
    const t = loadSw({ fetchImpl: () => netResponse(body, { url, ...c }) });
    const r = await t.dispatchFetch(url);
    assert.ok(r.handled);
    const ml = t.caches.get('banduong-ml-1');
    assert.equal(ml ? ml.map.size : 0, 0, JSON.stringify(c));
  }
});

test('tệp ML: tải dở (mất mạng giữa chừng) hay tệp cụt, sai mã băm không bao giờ được lưu', async () => {
  const full = new TextEncoder().encode('full model bytes');
  const url = `${SCOPE}models/det.tflite?v=${sha16(full)}`;

  // Luồng đứt giữa chừng.
  const broken = loadSw({
    fetchImpl: () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(full.slice(0, 4));
          c.error(new TypeError('connection reset'));
        },
      });
      return netResponse(stream, { url });
    },
  });
  const r1 = await broken.dispatchFetch(url);
  await assert.rejects(r1.response.arrayBuffer());
  assert.equal(broken.caches.get('banduong-ml-1').map.size, 0);

  // Trả 200 nhưng thiếu byte: mã băm lệch ?v=.
  const short = loadSw({ fetchImpl: () => netResponse(full.slice(0, 8), { url }) });
  await short.dispatchFetch(url);
  assert.equal(short.caches.get('banduong-ml-1').map.size, 0);
  // Lần sau vẫn hỏi lại mạng thay vì dùng mãi bản hỏng.
  await short.dispatchFetch(url);
  assert.equal(short.fetched.length, 2);
});

test('tệp ML: không có ?v= hợp lệ hoặc có Range thì đi thẳng ra mạng, không lưu ở đâu cả', async () => {
  const t = loadSw({ fetchImpl: (req) => netResponse('x', { url: req.url }) });
  for (const url of [
    `${SCOPE}models/labels.json`,
    `${SCOPE}models/labels.json?v=abc`,
    `${SCOPE}models/labels.json?v=${'a'.repeat(16)}&x=1`,
    `${SCOPE}models/golden/index.json`,
    `${SCOPE}vendor/litert/LICENSE`,
  ]) {
    assert.equal((await t.dispatchFetch(url)).handled, false, url);
  }
  const ranged = await t.dispatchFetch(`${SCOPE}models/det.tflite?v=${'a'.repeat(16)}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(ranged.handled, false);
  assert.equal(t.caches.stores.size, 0);
});

test('tests/ và tools/ không bao giờ được lưu', async () => {
  const t = loadSw({ fetchImpl: (req) => netResponse('x', { url: req.url }) });
  for (const p of [
    'tests/browser/vision-smoke.mjs',
    'tests/browser/camera-page.html',
    'tests/sw.test.mjs',
    'tools/camera/train-all.sh',
    'tools/camera/lib.mjs?v=1',
  ]) {
    assert.equal((await t.dispatchFetch(`${SCOPE}${p}`)).handled, false, p);
  }
  assert.equal(t.caches.stores.size, 0);
});

test('vỏ ứng dụng: như trước, ưu tiên mạng; mất mạng thì dùng bản đã lưu (bỏ qua ?…)', async () => {
  let online = true;
  const t = loadSw({
    fetchImpl: (req) => {
      if (!online) throw new TypeError('offline');
      return netResponse(`body of ${new URL(req.url).pathname}`, { url: req.url });
    },
  });
  const r = await t.dispatchFetch(`${SCOPE}js/main.js`);
  assert.ok(r.handled);
  assert.equal(await r.response.text(), 'body of /ban-duong/js/main.js');
  await new Promise((res) => setTimeout(res, 0));
  assert.ok(t.caches.get('banduong-shell-v6').map.has(`${SCOPE}js/main.js`));

  online = false;
  const off = await t.dispatchFetch(`${SCOPE}js/main.js?x=1`);
  assert.equal(await off.response.text(), 'body of /ban-duong/js/main.js');
  // Không có bản lưu: lỗi mạng được trả lại.
  const miss = await t.dispatchFetch(`${SCOPE}js/other.js`);
  assert.ok(miss.error);
  // Không phải GET: không can thiệp.
  assert.equal((await t.dispatchFetch(`${SCOPE}js/main.js`, { method: 'POST' })).handled, false);
});

test('vỏ ứng dụng: câu trả lời không ok không được lưu', async () => {
  const t = loadSw({ fetchImpl: (req) => netResponse('nope', { status: 404, url: req.url }) });
  await t.dispatchFetch(`${SCOPE}js/missing.js`);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(t.caches.get('banduong-shell-v6').map.size, 0);
});

test('ô bản đồ vẫn ưu tiên bộ nhớ đệm như trước', async () => {
  const url = 'https://tiles.openfreemap.org/planet/1/2/3.pbf';
  const t = loadSw({ fetchImpl: () => netResponse('tile', { type: 'cors', url }) });
  await t.dispatchFetch(url);
  await new Promise((res) => setTimeout(res, 0));
  await t.dispatchFetch(url);
  assert.equal(t.fetched.length, 1);
  assert.ok(t.caches.get('banduong-tiles-v1').map.has(url));
});

test('cài đặt: chỉ nạp trước SHELL_FILES, không có tệp ML, tests/ hay tools/', async () => {
  const t = loadSw();
  await t.dispatchLifecycle('install');
  const added = t.caches.get('banduong-shell-v6').added;
  assert.deepEqual(added, t.sw.SHELL_FILES);
  assert.equal(t.caches.get('banduong-ml-1'), undefined);
  for (const f of added) {
    assert.ok(!/^(models|vendor\/litert|tests|tools)\//.test(f), f);
  }
  assert.equal(t.calls.skipWaiting, 1);
});

test('kích hoạt: chỉ xoá banduong-shell-* cũ, giữ banduong-ml-1 và ô bản đồ', async () => {
  const t = loadSw();
  for (const name of ['banduong-shell-v4', 'banduong-shell-v5', 'banduong-shell-v6', 'banduong-ml-1', 'banduong-tiles-v1']) {
    await t.caches.open(name);
  }
  await t.dispatchLifecycle('activate');
  assert.deepEqual((await t.caches.keys()).sort(), ['banduong-ml-1', 'banduong-shell-v6', 'banduong-tiles-v1']);
  assert.equal(t.calls.claim, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// SHELL_FILES so với đồ thị import thật.

/** Bỏ dòng chú thích để câu ví dụ trong chú thích không bị coi là import. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  /\bnew\s+(?:Shared)?Worker\(\s*['"]([^'"]+)['"]/g,
  /\bimportScripts\(\s*['"]([^'"]+)['"]/g,
];

function localRefs(file) {
  const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  const out = new Set();
  for (const re of SPECIFIERS) {
    for (const m of src.matchAll(re)) {
      if (!m[1].startsWith('./') && !m[1].startsWith('../')) continue;
      out.add(relative(ROOT, normalize(join(dirname(join(ROOT, file)), m[1].split(/[?#]/)[0]))).split('\\').join('/'));
    }
  }
  return out;
}

/** Tệp cục bộ mà index.html nạp (script, stylesheet, manifest, biểu tượng). */
function htmlRefs() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const out = new Set();
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(m[1])) continue;
    out.add(m[1].replace(/^\.\//, '').split(/[?#]/)[0]);
  }
  return out;
}

function importGraph() {
  const seen = new Set();
  const queue = [...htmlRefs()].filter((f) => f.endsWith('.js') && f.startsWith('js/'));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(join(ROOT, f))) continue;
    for (const r of localRefs(f)) if (r.endsWith('.js')) queue.push(r);
  }
  return seen;
}

test('SHELL_FILES có mọi tệp js mà index.html, js/main.js và worker nạp', () => {
  const { sw } = loadSw();
  const shell = new Set(sw.SHELL_FILES);
  const graph = importGraph();
  assert.ok(graph.has('js/main.js') && graph.has('js/store.js'), 'không đọc được đồ thị import');
  const missing = [...graph].filter((f) => f.startsWith('js/') && !shell.has(f));
  assert.deepEqual(missing, [], `thiếu trong SHELL_FILES của sw.js: ${missing.join(', ')}`);
  const broken = [...graph].filter((f) => !existsSync(join(ROOT, f)));
  assert.deepEqual(broken, [], `import trỏ tới tệp không có: ${broken.join(', ')}`);
});

test('SHELL_FILES có mọi tệp cục bộ index.html nạp', () => {
  const { sw } = loadSw();
  const shell = new Set(sw.SHELL_FILES);
  const missing = [...htmlRefs()].filter((f) => !shell.has(f));
  assert.deepEqual(missing, []);
});

test('đồ thị import đọc được cả import nhiều dòng, import động, new URL(…, import.meta.url) và importScripts', () => {
  assert.ok(localRefs('js/vision.js').has('js/mlmanifest.js'));
  assert.ok(localRefs('js/vision.js').has('js/vision-worker.js'));
  assert.ok(localRefs('js/vision-worker.js').has('js/visionproto.js'));
  assert.ok(localRefs('js/main.js').has('js/signart.js'));
});

test('SHELL_FILES có mọi tệp chạy thật của tính năng camera, không trùng, không có tệp ML', () => {
  const { sw } = loadSw();
  const shell = new Set(sw.SHELL_FILES);
  assert.equal(shell.size, sw.SHELL_FILES.length, 'có mục trùng');
  for (const f of CAMERA_RUNTIME_FILES) assert.ok(shell.has(f), f);
  for (const f of sw.SHELL_FILES) assert.ok(!/^(models|vendor\/litert|tests|tools)\//.test(f), f);
});

test('mọi mục SHELL_FILES (trừ tệp giai đoạn 2) có trên đĩa, vì addAll hỏng cả lượt cài nếu thiếu một tệp', () => {
  const { sw } = loadSw();
  const missing = [...sw.SHELL_FILES].filter((f) => f !== './' && !PHASE2_FILES.includes(f) && !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, []);
});

test('tệp giai đoạn 2 trong SHELL_FILES đã có trên đĩa', (t) => {
  const missing = PHASE2_FILES.filter((f) => !existsSync(join(ROOT, f)));
  // Khi còn thiếu, sw.js mới không cài được (addAll hỏng) và máy người dùng giữ bản cũ: phải có trước khi phát hành.
  if (missing.length) t.todo(`chưa có: ${missing.join(', ')}`);
  assert.deepEqual(missing, []);
});
