// Kiểm thử trình duyệt của bộ nhận diện (chạy tay, không thuộc npm test):
//   node tests/browser/vision-smoke.mjs [--frames 100] [--out kết-quả.json] [--real-models]
// --real-models: mô hình đã huấn luyện (không phải mô hình giả) có thể không thấy khung nào trên cảnh tổng hợp, nên
// hai điều kiện "có khung" và "có khung bị ô cắt xén" của đường khung lượt A chỉ được ghi lại, không bắt buộc.
// Cần mô hình giả do tools/camera/make-dummy-models.py tạo trong $BANDUONG_CACHE/dummy (mặc định
// ~/.cache/ban-duong-train/dummy). Mô hình giả được phục vụ qua page.route cho models/*.tflite; manifest kiểm thử
// (mã băm của mô hình giả + tệp LiteRT thật trên đĩa) được đưa vào Vision.load({ manifest }), không sửa js/mlmanifest.js.
// Với cả hai bản dựng wasm (compat, relaxed): kiểm hình dạng kết quả, bitmap luôn được đóng, khung thứ hai khi bận bị
// bỏ, khung gợi ý được phân loại trước, mô hình bị sửa một byte bị từ chối ('integrity'), thiếu mô hình → 'no-models',
// worker tự kiểm mã băm và bỏ qua thông điệp lạ, đầu ra khớp vectơ mẫu của trình thông dịch TF, khung lượt A bị ô cắt
// xén không bao giờ được trả về, worker không xin GPU (WebGPU) dù trình duyệt có; rồi đo p50/p90 cho từng lượt quét
// trên khung 1920×1080.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP, loadPlaywright, pct, startDevServer } from './lib/harness.mjs';
import { scan } from '../../tools/camera/write-manifest.mjs';
import '../../js/visionproto.js';

const P = globalThis.VisionProto;
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const FRAMES = Number(opt('frames', 100));
const OUT = opt('out', null);
const REAL_MODELS = argv.includes('--real-models');
const DUMMY = process.env.BANDUONG_DUMMY || join(process.env.BANDUONG_CACHE || join(homedir(), '.cache', 'ban-duong-train'), 'dummy');

const sha = (b) => createHash('sha256').update(b).digest('hex');
// Sai lệch cho phép giữa LiteRT.js và trình thông dịch của TF trên cùng mô hình int8 (tỉ lệ với giá trị lớn nhất).
const PARITY_TOL = 0.02;

function syntheticLabels() {
  const families = ['ring', 'noentry', 'bluering', 'end', 'triangle', 'invtriangle', 'octagon', 'bluedisc', 'bluerect', 'diamond', 'plate'];
  const labels = [];
  for (let i = 0; i < 179; i++) labels.push({ i, label: `X.${i}`, code: `X.${i}`, value: null, family: families[i % 11], learn: false, junction: false });
  labels.push({ i: 179, label: 'other-sign', code: null, value: null, family: null, learn: false, junction: false });
  labels.push({ i: 180, label: 'background', code: null, value: null, family: null, learn: false, junction: false });
  return { version: 1, families, det: { input: [352, 640, 3], stride: 8, out: [44, 80] }, cls: { input: [48, 48, 3] }, T: 1, labels, build: {} };
}

const FRAME_W = 1920; // cỡ khung tổng hợp của vision-page.js
const FRAME_H = 1080;

function checkResult(r, label) {
  const v = P.checkResponse({ type: 'result', id: 1, ...r });
  assert.ok(v.ok, `${label}: result shape (${v.reason})`);
  assert.deepEqual(Object.keys(r).sort(), ['boxes', 'lum', 'ms', 't']);
  assert.deepEqual(Object.keys(r.ms).sort(), ['cls', 'det', 'pre', 'total']);
  assert.deepEqual(Object.keys(r.lum).sort(), ['mean', 'std']);
  assert.ok(r.boxes.length <= P.MAX_BOXES);
  let ncls = 0;
  const gA = P.passGeometry('A', FRAME_W, FRAME_H, P.defaultFoe(FRAME_W, FRAME_H));
  for (const b of r.boxes) {
    assert.deepEqual(Object.keys(b).sort(), ['cls', 'family', 'h', 'pass', 's', 'w', 'x', 'y']);
    assert.ok(b.s >= P.SCORE_MIN);
    if (b.pass === 'A') assert.ok(!P.cutByCrop(b, gA, FRAME_W, FRAME_H), `${label}: pass-A box cut by the crop ${JSON.stringify(b)}`);
    if (b.cls) {
      ncls++;
      assert.ok(b.w >= P.CLS_MIN_W && b.w <= P.CLS_MAX_W, `${label}: classified box width ${b.w}`);
      assert.equal(b.cls.length, 3);
      assert.ok(b.cls[0][1] >= b.cls[1][1] && b.cls[1][1] >= b.cls[2][1]);
      assert.ok(b.cls[0][1] + b.cls[1][1] + b.cls[2][1] <= 1 + 1e-6);
    }
  }
  assert.ok(ncls <= P.CLS_MAX);
  return ncls;
}

const GPU_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-angle=swiftshader'];
// Dấu hiệu LiteRT đã tạo (hay cố tạo) môi trường GPU. Dòng "RegisterAccelerator … GPU WebGPU" chỉ là danh sách bộ tăng
// tốc có trong wasm, không phải GPU được xin.
const GPU_LOG = /GpuEnvironment|default WebGPU device|GPU adapter/i;

/** Đếm số lần worker gọi navigator.gpu.requestAdapter (bộ đếm gắn vào trước khi init được gửi đi). */
async function gpuCheck(browser, server, manifest, dummy, labels) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (GPU_LOG.test(m.text())) logs.push(`${m.type()}: ${m.text().slice(0, 160)}`);
  });
  await page.route(/\/models\/[^/?]+\.tflite(\?.*)?$/, (route) => {
    const body = dummy[new URL(route.request().url()).pathname.slice(1)];
    return body ? route.fulfill({ status: 200, body }) : route.fulfill({ status: 404, body: 'not found' });
  });
  if (labels) await page.route(/\/models\/labels\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, body: labels }));
  await page.goto(`${server.url}/tests/browser/lib/vision-page.html`);
  await page.waitForFunction(() => window.visionTestReady === true);
  const pageAdapter = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))));
  const spied = new Promise((resolve, reject) => {
    page.once('worker', (w) =>
      w
        .evaluate(() => {
          const spy = { calls: 0, hasGpu: false, hiddenBeforeSpy: !!Object.getOwnPropertyDescriptor(navigator, 'gpu') };
          const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'gpu');
          const gpu = d && d.get ? d.get.call(navigator) : null;
          if (gpu) {
            spy.hasGpu = true;
            const orig = gpu.requestAdapter.bind(gpu);
            gpu.requestAdapter = (o) => {
              spy.calls++;
              return orig(o);
            };
          }
          self.__gpuSpy = spy;
          return { ...spy };
        })
        .then((before) => resolve({ w, before }), reject)
    );
  });
  const loading = page.evaluate((a) => window.visionTest.gpuLoad(a), { manifest, build: 'compat' });
  const { w, before } = await spied;
  await page.evaluate(() => window.visionTest.openGate());
  const info = await loading;
  const after = await w.evaluate(() => ({ calls: self.__gpuSpy.calls, gpu: typeof navigator.gpu }));
  await page.evaluate(() => window.visionTest.stopGpu());
  await page.close();
  assert.equal(info.labels, 181);
  assert.equal(before.hiddenBeforeSpy, false, 'spy installed before init');
  assert.equal(after.calls, 0, 'worker never asked for a GPU adapter');
  assert.equal(after.gpu, 'undefined', 'navigator.gpu hidden inside the worker');
  assert.deepEqual(logs, [], 'no WebGPU messages in the console');
  return { pageAdapter, workerHadGpu: before.hasGpu, requestAdapterCalls: after.calls, logs: logs.length };
}

async function main() {
  for (const f of ['sign-det.int8.tflite', 'sign-cls.int8.tflite']) {
    if (!existsSync(join(DUMMY, f))) throw new Error(`Thiếu ${join(DUMMY, f)}: chạy tools/camera/make-dummy-models.py trước`);
  }
  const dummy = {
    'models/sign-det.int8.tflite': readFileSync(join(DUMMY, 'sign-det.int8.tflite')),
    'models/sign-cls.int8.tflite': readFileSync(join(DUMMY, 'sign-cls.int8.tflite')),
  };
  const disk = scan(APP);
  const realLabels = Object.hasOwn(disk, 'models/labels.json');
  const labelsBuf = realLabels ? readFileSync(join(APP, 'models/labels.json')) : Buffer.from(JSON.stringify(syntheticLabels()));
  const files = {};
  for (const [p, e] of Object.entries(disk)) if (p.startsWith('vendor/litert/')) files[p] = e;
  files['models/labels.json'] = { sha256: sha(labelsBuf), size: labelsBuf.length };
  for (const [p, b] of Object.entries(dummy)) files[p] = { sha256: sha(b), size: b.length };
  const manifest = { version: 1, files };

  const report = { frames: FRAMES, labels: realLabels ? 'models/labels.json' : 'synthetic', builds: {} };
  const server = await startDevServer();
  let browser = null;
  let chromium = null;
  try {
    ({ chromium } = loadPlaywright());
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let tamper = false;
    await page.route(/\/models\/[^/?]+\.tflite(\?.*)?$/, (route) => {
      const path = new URL(route.request().url()).pathname.slice(1);
      const body = dummy[path];
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      const out = Buffer.from(body);
      if (tamper) out[out.length >> 1] ^= 0x01;
      return route.fulfill({ status: 200, body: out, headers: { 'Content-Type': 'application/octet-stream' } });
    });
    await page.route(/\/__golden__\/[a-z0-9-]+\.f32$/, (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = join(DUMMY, 'golden', name);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'Content-Type': 'application/octet-stream' } });
    });
    if (!realLabels) {
      await page.route(/\/models\/labels\.json(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, body: labelsBuf, headers: { 'Content-Type': 'application/json' } })
      );
    }
    await page.goto(`${server.url}/tests/browser/lib/vision-page.html`);
    await page.waitForFunction(() => window.visionTestReady === true);
    const support = await page.evaluate(async () => (await import('/js/vision.js')).visionSupport());
    report.support = support;
    assert.ok(support.ok, `visionSupport: ${support.reason}`);

    for (const build of ['compat', 'relaxed']) {
      const b = (report.builds[build] = {});
      for (const passes of [['A', 'B'], ['A'], ['B']]) {
        const key = passes.join('');
        const r = await page.evaluate((a) => window.visionTest.run(a), { manifest, build, frames: FRAMES, passes });
        assert.equal(r.info.build, build);
        assert.equal(r.info.labels, 181);
        assert.equal(r.progress.loaded, r.progress.total, 'progress reaches the total');
        assert.ok(r.detachedAll, 'every transferred bitmap is detached on the page side');
        assert.equal(r.nulls, 0, 'no frame dropped when sent one at a time');
        assert.equal(r.counts.frames, r.counts.closed, `worker closed every bitmap (${r.counts.closed}/${r.counts.frames})`);
        assert.deepEqual(r.busy, { secondNull: true, secondClosed: true, firstOk: true });
        let ncls = 0;
        for (const s of r.samples) ncls += checkResult(s, `${build}/${key}`);
        for (const s of r.samples) assert.ok(s.boxes.every((x) => passes.includes(x.pass)));
        if (r.hint) assert.equal(r.hint.classifiedNow, r.hint.tried, 'hinted boxes are classified first');
        const col = (k) => r.rows.map((x) => x.ms[k]);
        b[key] = {
          n: r.rows.length,
          loadMs: Math.round(r.loadMs),
          total: { p50: pct(col('total'), 0.5), p90: pct(col('total'), 0.9), p99: pct(col('total'), 0.99) },
          pre: { p50: pct(col('pre'), 0.5), p90: pct(col('pre'), 0.9) },
          det: { p50: pct(col('det'), 0.5), p90: pct(col('det'), 0.9) },
          cls: { p50: pct(col('cls'), 0.5), p90: pct(col('cls'), 0.9) },
          rttMedian: Math.round(r.stats.rtt * 100) / 100,
          fps: Math.round(r.stats.fps * 10) / 10,
          boxesMedian: pct(r.rows.map((x) => x.n), 0.5),
          classifiedMedian: pct(r.rows.map((x) => x.ncls), 0.5),
          classifiedInSamples: ncls,
          hint: r.hint,
        };
        console.log(build, key, JSON.stringify(b[key]));
      }

      // Cùng vectơ vào → cùng đầu ra như trình thông dịch của TF (int8 ở cả hai bên: chỉ khác do làm tròn).
      const par = await page.evaluate((a) => window.visionTest.parity(a), { manifest, build, golden: `${server.url}/__golden__/` });
      assert.deepEqual(par.det.shapes.map((x) => x.join('x')).sort(), ['1x44x80x11', '1x44x80x4']);
      assert.deepEqual(par.cls.shapes, [[1, 181]]);
      for (const [m, ch] of [['det', 11], ['det', 4], ['cls', 181]]) {
        assert.ok(par[m][ch].same, `${m}/${ch} length`);
        assert.ok(par[m][ch].maxAbsDiff <= PARITY_TOL * Math.max(1, par[m][ch].maxAbs), `${m}/${ch} parity ${JSON.stringify(par[m][ch])}`);
      }
      b.parity = { det11: par.det[11].maxAbsDiff, det4: par.det[4].maxAbsDiff, cls: par.cls[181].maxAbsDiff };
      console.log(build, 'parity', JSON.stringify(b.parity));

      const fp = await page.evaluate((a) => window.visionTest.framePath(a), { manifest, build });
      assert.ok(fp.same && fp.maxDiff < 1e-3, `frame path A matches tensor path ${JSON.stringify(fp)}`);
      if (!REAL_MODELS) {
        assert.ok(fp.n > 0, `frame path A produced boxes ${JSON.stringify(fp)}`);
        assert.ok(fp.cutRaw > 0, `found a frame whose raw pass-A decode has a box cut by the crop ${JSON.stringify(fp)}`);
      }
      assert.equal(fp.leaked, 0, 'no box cut by the pass-A crop reaches process()');
      b.framePathA = { boxes: fp.n, maxDiff: fp.maxDiff, cutDropped: fp.cutRaw, foe: fp.foe, tried: fp.tried };
      console.log(build, 'framePathA', JSON.stringify(b.framePathA));

      const noModels = { version: 1, files: { ...files } };
      delete noModels.files['models/sign-det.int8.tflite'];
      assert.equal((await page.evaluate((a) => window.visionTest.loadError(a), { manifest: noModels, build }))?.code, 'no-models');
      tamper = true;
      const tampered = await page.evaluate((a) => window.visionTest.loadError(a), { manifest, build });
      tamper = false;
      assert.equal(tampered?.code, 'integrity', `tampered model refused (${JSON.stringify(tampered)})`);
      b.tamperedModel = tampered.code;

      const d = await page.evaluate((a) => window.visionTest.workerDirect(a), { manifest, build });
      assert.deepEqual(d.unknownIgnored, { type: 'stats', frames: 0, closed: 0 }, 'unknown message ignored');
      assert.deepEqual(d.statsWithBitmap, { type: 'stats', frames: 1, closed: 1 }, 'bitmap carried by a stats message is closed');
      assert.equal(d.frameBeforeReady.code, 'worker');
      assert.equal(d.frameBeforeReady.id, 7);
      assert.equal(d.badPasses.code, 'worker');
      assert.match(d.badPasses.reason, /passes/);
      assert.deepEqual(d.countsAfter, { type: 'stats', frames: 3, closed: 3 }, 'rejected frames were closed');
      assert.equal(d.tamperedInit.code, 'integrity', 'worker checks hashes itself');
      b.workerChecks = 'ok';
    }
    assert.deepEqual(errors, [], 'no uncaught page errors');
    await browser.close();
    browser = null;

    // WebGPU: trình duyệt mặc định, rồi trình duyệt bật WebGPU giả lập (SwiftShader) để chắc chắn có adapter.
    report.webgpu = {};
    for (const [name, args] of [['default', []], ['swiftshader', GPU_ARGS]]) {
      browser = await chromium.launch({ args });
      report.webgpu[name] = await gpuCheck(browser, server, manifest, dummy, realLabels ? null : labelsBuf);
      await browser.close();
      browser = null;
      console.log('webgpu', name, JSON.stringify(report.webgpu[name]));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
  report.ok = true;
  console.log(JSON.stringify(report, null, 1));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
