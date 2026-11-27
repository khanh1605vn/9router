// Bộ chạy thử lái xe trên trình duyệt cho tính năng camera nhận diện biển (PLAN §8.2). Chạy tay, không thuộc npm test:
//   node tests/browser/run.mjs [--only S1,S2] [--real-models] [--out kết-quả.json] [--shots thư-mục] [--port 20500]
//
// Mỗi lần đi là một trang mới của ứng dụng thật (index.html qua dev-server.mjs) trong CÙNG một ngữ cảnh trình duyệt,
// nên kho biển đã học (IndexedDB) được giữ từ lần đi này sang lần đi sau như trên điện thoại. init.js thay GPS bằng quỹ
// đạo 1 Hz, camera bằng luồng canvas của scene.js, dời đồng hồ Date sang ngày sau, ghi lại câu đọc. Overpass được trả
// từ dữ liệu giả lập (lib/drive-world.mjs); ô bản đồ là ảnh 1×1; mọi máy chủ khác bị chặn.
//
// Hai chế độ:
// - oracle (mặc định khi chưa có mô hình đã huấn luyện): bộ nhận diện oracle.js chiếu các biển đã biết của cảnh qua
//   cùng mô hình máy ảnh thành hộp có nhiễu, nên kiểm được toàn bộ phần sau bộ nhận diện bằng mã thật của ứng dụng;
// - --real-models: bộ nhận diện thật (Vision, LiteRT.js) trên chính khung hình của cảnh; cần models/ đã cài.
// S10 (khớp vectơ mẫu) và S11 (độ trễ) luôn dùng mô hình thật, và tự bỏ qua khi models/ chưa có mô hình.
//
// Biển: P.103a, W.224 và R.122 học được với models/labels.json đã cài. Mô hình v1 không học biển tốc độ (mọi P.127 có
// learn: false, xem models/MODEL_CARD.md), nên đường đi của biển giới hạn "Camera" (CameraLimit) được kiểm riêng ở S3L
// trong một ngữ cảnh trình duyệt riêng, với labels.json giả lập chỉ có trong kiểm thử (P.127[50] learn: true), và chỉ
// ở chế độ oracle.
//
// Cổng: một cổng trống trong 20500–20599. Mọi tiến trình (máy chủ thử, Chromium) đều được dừng khi xong hay khi lỗi.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { APP, loadPlaywright, startDevServer } from './lib/harness.mjs';
import {
  bboxHasRoad, bboxOf, fixtureLabels, JUNCTION_KEY, LANE_EAST, LANE_WEST, locate, MAIN_SIGN, ORIGIN, overpassFixture, ROAD, sceneSigns,
  SIGNS, SOURCES, SPEED_FIXTURE_LABEL,
} from './lib/drive-world.mjs';
import {
  ALONG_ERR_MAX, DAY0, DAY_MS, EAST, GPS_ACCURACY, GPS_SIGMA, HIDE_STOP_MS, IDB_FLUSH_MS, LATENCY_FRAMES, LIMIT_MARGIN,
  LOAD_TIMEOUT, missesToRetire, NIGHT_SHIFT_MS, POLL_MS, PORT_FIRST, PORT_LAST, RAMP_S, S4_JUNCTION_DAYS, S4_SLACK_DAYS, SETTLE_MS, SPEAK_MAX,
  SPEAK_MIN, SPEED, TIMEZONE, VIEWPORT, WEST,
} from './lib/drive-config.mjs';
import { ML_MANIFEST } from '../../js/mlmanifest.js';
import { L_MAX, L_MISS_CANDIDATE, L_MISS_CONFIRMED } from '../../js/learnedsigns.js';
import { CAMERA_SUFFIX } from '../../js/signengine.js';
import { TEXT } from '../../js/camctl.js';

const argv = process.argv.slice(2);
const opt = (k, d = null) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const flag = (k) => argv.includes(`--${k}`);
const REAL = flag('real-models');
const OUT = opt('out');
const SHOTS = opt('shots');
const ONLY = opt('only') ? new Set(opt('only').split(',').map((x) => x.trim().toUpperCase())) : null;

const LABELS_TEXT = readFileSync(join(APP, 'models', 'labels.json'), 'utf8');
const LABELS = JSON.parse(LABELS_TEXT);
const FAMILIES = Object.fromEntries(LABELS.labels.map((l) => [l.label, l.family]));
const LEARNABLE = new Set(LABELS.labels.filter((l) => l.learn === true).map((l) => l.label));
const M = MAIN_SIGN; // biển chính của các kịch bản (P.103a)
const SPD = SPEED_FIXTURE_LABEL; // biển tốc độ của S3L (P.127[50], chỉ học được với nhãn giả lập)
// Câu đọc của từng biển (để nhận ra câu của camera và kiểm khoảng cách đọc).
const SAYS = Object.freeze({ 'P.103a': /cấm ô tô/i, 'R.122': /dừng lại/i, 'W.224': /người đi bộ/i, 'P.127[50]': /tốc độ tối đa 50/i });
const ANY_SIGN_SAY = /tốc độ tối đa|dừng lại|cấm ô tô|người đi bộ/i;

// ---------------------------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);

function tryPort(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

async function freePort() {
  const want = Number(opt('port', 0));
  if (want) {
    if (want < PORT_FIRST || want > PORT_LAST) throw new Error(`--port phải trong ${PORT_FIRST}–${PORT_LAST}`);
    return want;
  }
  for (let p = PORT_FIRST; p <= PORT_LAST; p++) if (await tryPort(p)) return p;
  throw new Error(`Không còn cổng trống trong ${PORT_FIRST}–${PORT_LAST}`);
}

/** Mô hình đã huấn luyện có trong models/ và trong js/mlmanifest.js không. */
function modelsInstalled() {
  const f = ML_MANIFEST.files || {};
  const need = ['models/sign-det.int8.tflite', 'models/sign-cls.int8.tflite'];
  const ok = need.every((p) => f[p] && existsSync(join(APP, p)));
  return { ok, golden: existsSync(join(APP, 'models', 'golden', 'index.json')) };
}

/** Quá trình huấn luyện có đang chạy không (số đo độ trễ lúc đó không đại diện). Chỉ đọc danh sách tiến trình. */
function trainingRunning() {
  try {
    return /tools\/camera\/(train|train-all)/.test(execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------------------------
// Trình duyệt và ngữ cảnh
// ---------------------------------------------------------------------------------------------

/** Ảnh PNG 1×1 một màu (ô bản đồ giả), dựng bằng zlib để chắc chắn giải mã được. */
function png1px([r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]); // 1×1, 8 bit, RGB
  const idat = deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const PNG_1PX = png1px([233, 238, 242]);
const OVERPASS = JSON.stringify(overpassFixture());
const EMPTY_OVERPASS = JSON.stringify({ version: 0.6, osm3s: { timestamp_osm_base: '2026-11-20T00:00:00Z' }, elements: [] });

/**
 * Một ngữ cảnh trình duyệt mới (IndexedDB riêng). labels: Buffer labels.json giả lập (chỉ S3L): được trả cho
 * models/labels.json?v=… và manifest trên đường truyền mang mã băm, kích thước của nó (tệp trên đĩa không đổi).
 */
async function newContext(browser, net, { labels = null } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    locale: 'vi-VN',
    timezoneId: TIMEZONE,
    permissions: ['geolocation', 'camera'],
  });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, async (route) => {
    const req = route.request();
    const url = req.url();
    if (/overpass/.test(url) && req.method() === 'POST') {
      const has = bboxHasRoad(bboxOf(req.postData()));
      net.overpass++;
      if (has) net.overpassRoad++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: has ? OVERPASS : EMPTY_OVERPASS });
    }
    if (/tile\.openstreetmap\.org/.test(url)) {
      net.tiles++;
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
    }
    net.blocked.add(new URL(url).host);
    return route.abort();
  });
  const fx = labels ? { sha256: createHash('sha256').update(labels).digest('hex'), size: labels.length } : null;
  if (!REAL || fx) {
    // Oracle: thêm hai mục mô hình giả vào manifest nếu chưa có (chỉ trên đường truyền, tệp trên đĩa không đổi) để bộ
    // điều phối coi tính năng là có; bộ nhận diện oracle không tải tệp nào. Nhãn giả lập: thay mục labels.json.
    await ctx.route(/\/js\/mlmanifest\.js(\?|$)/, async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      const e = (n) => `{"sha256":"${'ab'.repeat(32)}","size":${n}}`;
      if (!REAL && !/sign-det\.int8\.tflite/.test(body)) {
        body = body.replace('"files": {', `"files": {"models/sign-det.int8.tflite": ${e(520000)}, "models/sign-cls.int8.tflite": ${e(380000)},`);
      }
      if (fx) {
        const before = body;
        body = body.replace(/("models\/labels\.json":\s*\{\s*"sha256":\s*")[0-9a-f]{64}(",\s*"size":\s*)\d+/, `$1${fx.sha256}$2${fx.size}`);
        if (body === before) throw new Error('manifest: không thay được mục labels.json');
      }
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body });
    });
  }
  if (fx) {
    await ctx.route(/\/models\/labels\.json(\?|$)/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: labels }));
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Một lần đi
// ---------------------------------------------------------------------------------------------

/**
 * p = { day, night, dir: +1|−1, from, to, signs: [nhãn], flags, permission, hooks: [{ at, fn(page) }], settings }
 * → { day, cfg, log, before, after, errors, ms }
 */
async function drivePass(env, p) {
  const t0 = Date.now();
  const dir = p.dir ?? 1;
  const span = p.dir < 0 ? WEST : EAST;
  const from = p.from ?? span.from;
  const to = p.to ?? span.to;
  const wall = DAY0 + p.day * DAY_MS + (p.night ? NIGHT_SHIFT_MS : 0);
  const cfg = {
    world: ORIGIN,
    dateOffsetMs: wall - Date.now(),
    drive: { s0: from, s1: to, dir, v: SPEED, lat: dir > 0 ? LANE_EAST : LANE_WEST, rampS: RAMP_S },
    gps: { accuracy: GPS_ACCURACY, sigma: GPS_SIGMA, hz: 1 },
    scene: { signs: sceneSigns(p.signs, FAMILIES), junction: { s: ROAD.junction }, seed: 7, flags: { night: Boolean(p.night), ...(p.flags || {}) } },
    camPermission: p.permission || 'granted',
    oracle: !REAL,
    families: Object.fromEntries(p.signs.map((l) => [l, FAMILIES[l]])),
    drawFps: 10,
    captureFps: 15,
    seed: 1000 + p.day,
    settings: { camEnabled: true, keepAwake: true, ...(p.settings || {}) },
  };
  const page = await env.ctx.newPage();
  const errors = { page: [], console: [] };
  page.on('pageerror', (e) => errors.page.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource: net::ERR_FAILED/.test(t)) return; // máy chủ ngoài bị chặn có chủ đích
    errors.console.push(t);
  });
  const content = `globalThis.__BDH_CFG = ${JSON.stringify(cfg)};\n${SOURCES.scene}\n${SOURCES.oracle}\n${SOURCES.init}`;
  await page.addInitScript({ content });
  await page.goto(`${env.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => globalThis.__BDH?.ready && globalThis.__BD_TEST__?.controller?.learner && globalThis.__BD_TEST__.controller.state.labels === 'ok',
    null,
    { timeout: LOAD_TIMEOUT }
  );
  await page.waitForFunction(() => globalThis.__BDH.log.fixes >= 3, null, { timeout: LOAD_TIMEOUT });
  const before = await readRecords(page, env.ids);
  await page.evaluate(() => document.getElementById('btnDrive').click());
  await page.waitForFunction(() => document.querySelector('#sheet .view[data-view="drive"]')?.hidden === false, null, { timeout: 10000 });
  await sleep(1200); // thêm một lần định vị đứng yên trong chế độ lái
  await page.evaluate(() => globalThis.__BDH.go());
  const hooks = (p.hooks || []).map((h) => ({ ...h, done: false })).sort((a, b) => dir * (a.at - b.at));
  const limit = ((Math.abs(to - from) / SPEED + RAMP_S) * 1000) + 30000;
  const tStart = Date.now();
  for (;;) {
    const ps = await page.evaluate(() => globalThis.__BDH.pose());
    for (const h of hooks) {
      if (!h.done && dir * (ps.s - h.at) >= 0) {
        h.done = true;
        await page.evaluate((k) => globalThis.__BDH.mark('hook', { at: k }), h.at);
        await h.fn(page, ps);
      }
    }
    if (!ps.moving && dir * (ps.s - to) >= -0.01) break;
    if (Date.now() - tStart > limit) throw new Error(`lần đi ngày ${p.day} quá giờ ở s = ${r1(ps.s)}`);
    await sleep(POLL_MS);
  }
  for (const h of hooks) if (!h.done) await h.fn(page, await page.evaluate(() => globalThis.__BDH.pose()));
  await sleep(p.settle ?? SETTLE_MS);
  const log = await page.evaluate(() => {
    const h = globalThis.__BDH;
    const c = globalThis.__BD_TEST__.controller;
    const L = c.learner;
    return { ...h.log, learner: L?.stats?.() ?? null, health: L?.health?.() ?? null, state: c.state };
  });
  const after = await readRecords(page, env.ids);
  await sleep(IDB_FLUSH_MS);
  await page.close();
  const pass = { day: p.day, night: Boolean(p.night), dir, from, to, signs: p.signs, flags: cfg.scene.flags, permission: cfg.camPermission, log, before, after, errors, ms: Date.now() - t0 };
  env.passes.push(brief(pass));
  console.log(`  ngày ${p.day}${p.night ? ' (đêm)' : ''}: ${(pass.ms / 1000).toFixed(0)} s, getUserMedia ${log.gum}, khung ${log.oracle?.frames ?? log.framesSeen ?? '?'}, câu đọc ${log.speech.length}, lượt đi qua ${log.passed.length}`);
  if (REAL) {
    for (const [label, e] of Object.entries(gtStats(log.gt))) {
      const a = e.all;
      console.log(`    ${label}: ${a.frames} khung có biển, thấy ${a.det}, phân loại ${a.cls}, đúng ${a.ok} (p ≥ ${GT_P_SURE}: ${a.sure}), nhầm ${a.wrong}`);
    }
    const tr = log.results.map((x) => `${x.label ?? '?'}:${x.ok ? 'nhận' : x.reason}`);
    console.log(`    lượt bám đã xét: ${tr.length ? tr.join(', ') : 'không có'}; hộp lạ ${log.stray.boxes} (phân loại ${log.stray.classified}, nhãn được học ${log.stray.learnable})`);
  }
  return pass;
}

/** Bản ghi đã học: list() (biển đang hiện) và get() cho các id đã biết (kể cả biển đã loại). */
async function readRecords(page, ids) {
  return page.evaluate((known) => {
    const L = globalThis.__BD_TEST__.controller.learned;
    const out = {};
    for (const row of L.list()) out[row.id] = L.get(row.id);
    for (const id of known) if (!out[id]) out[id] = L.get(id);
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return { records: Object.values(out), counts: L.counts() };
  }, Object.values(ids));
}

// Dải khoảng cách (m) khi đối chiếu từng khung với cảnh, và p tối thiểu của một khung "đọc chắc" (như MEAN_P_MIN).
const GT_BINS = Object.freeze([[0, 20], [20, 30], [30, 45], [45, 60], [60, 80], [80, 120]]);
const GT_P_SURE = 0.85;

/**
 * Tỉ lệ thấy và đọc đúng của bộ nhận diện theo từng biển của cảnh, gộp và theo dải khoảng cách: frames (khung có biển
 * trong hình), det (có hộp khớp IoU ≥ 0,3), cls (hộp đó đã được phân loại), ok (nhãn top-1 đúng), sure (đúng và
 * p ≥ 0,85), wrong (nhãn top-1 là một nhãn khác, không phải nền/biển khác).
 */
function gtStats(rows) {
  const out = {};
  const blank = () => ({ frames: 0, det: 0, cls: 0, ok: 0, sure: 0, wrong: 0 });
  for (const [label, Z, , det, top, p] of rows || []) {
    const e = (out[label] ||= { all: blank(), byZ: Object.fromEntries(GT_BINS.map(([a, b]) => [`${a}-${b}`, blank()])) });
    const bin = GT_BINS.find(([a, b]) => Z >= a && Z < b);
    for (const c of [e.all, bin && e.byZ[`${bin[0]}-${bin[1]}`]].filter(Boolean)) {
      c.frames++;
      if (!det) continue;
      c.det++;
      if (top == null) continue;
      c.cls++;
      if (top === label) {
        c.ok++;
        if (p >= GT_P_SURE) c.sure++;
      } else if (top !== 'background' && top !== 'other-sign') c.wrong++;
    }
  }
  return out;
}

/** Tóm tắt một lần đi cho tệp kết quả (bỏ các mẫu giao diện dài). */
function brief(pass) {
  const l = pass.log;
  return {
    day: pass.day,
    night: pass.night,
    dir: pass.dir,
    from: pass.from,
    to: pass.to,
    signs: pass.signs,
    flags: pass.flags,
    permission: pass.permission,
    seconds: Math.round(pass.ms / 1000),
    getUserMedia: l.gum,
    trackStops: l.trackStops,
    grabs: l.grabs,
    oracle: l.oracle && { ...l.oracle, gaps: undefined, frameGapMs: gapStats(l.oracle.gaps) },
    learner: l.learner,
    speech: l.speech.map((x) => ({ text: x.text, s: r1(x.s) })),
    passed: l.passed.map((e) => ({ ...e, s: r1(e.s), L: r1(e.L) })),
    tracks: l.results,
    vision: { framesSeen: l.framesSeen, gt: gtStats(l.gt), stray: l.stray },
    records: pass.after.records.map(recBrief),
    pageErrors: pass.errors.page,
    consoleErrors: pass.errors.console.slice(0, 20),
  };
}

/** Khoảng cách giữa hai khung đã xử lý liên tiếp (ms), bỏ các quãng dừng lấy khung (> 2 s). */
function gapStats(gaps) {
  const g = (gaps || []).filter((x) => x <= 2000).sort((a, b) => a - b);
  if (!g.length) return null;
  const q = (f) => g[Math.min(g.length - 1, Math.floor(f * g.length))];
  return { n: g.length, p50: q(0.5), p90: q(0.9), max: g[g.length - 1], fps: Math.round((1000 / (g.reduce((a, b) => a + b, 0) / g.length)) * 10) / 10 };
}

const recBrief = (r) => ({ id: r.id, label: r.value != null ? `${r.code}[${r.value}]` : r.code, status: r.status, L: r1(r.L), hitDays: r.hitDays, misses: r.misses, passes: r.passes, s: r1(locate(r.coord).s), lat: r1(locate(r.coord).lat), junction: r.junction, wayId: r.wayId, facing: r.facing });
const labelOf = (r) => (r.value != null ? `${r.code}[${r.value}]` : r.code);
const recOf = (set, label) => set.records.find((r) => labelOf(r) === label) || null;

// ---------------------------------------------------------------------------------------------
// Kết quả của từng kịch bản
// ---------------------------------------------------------------------------------------------

class Result {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.status = 'pass';
    this.checks = [];
    this.data = {};
    this.notes = [];
  }
  check(name, ok, detail = null, { info = false } = {}) {
    this.checks.push({ name, ok: Boolean(ok), detail, ...(info ? { info: true } : {}) });
    if (!ok && !info) this.status = 'fail';
    console.log(`    ${ok ? 'đạt ' : info ? 'lưu ý' : 'HỎNG'} ${name}${detail != null ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    return ok;
  }
  skip(reason) {
    this.status = 'skip';
    this.notes.push(reason);
    console.log(`    bỏ qua: ${reason}`);
  }
}

/** Các kiểm tra chung cho mọi lần đi: không lỗi trang, camera và bộ nhận diện chạy (nếu kịch bản cần). */
function common(res, pass, { camera = true } = {}) {
  res.check(`ngày ${pass.day}: không có lỗi trang`, pass.errors.page.length === 0, pass.errors.page.slice(0, 3));
  if (camera) res.check(`ngày ${pass.day}: bộ nhận diện nhận khung`, (pass.log.oracle?.frames ?? pass.log.learner?.frames ?? 0) > 0, { frames: pass.log.oracle?.frames ?? null, learnerFrames: pass.log.learner?.frames ?? null });
}

const camSpeech = (pass) => pass.log.speech.filter((x) => x.text.includes(CAMERA_SUFFIX.trim()));
const unchanged = (a, b) => a && b && a.L === b.L && a.misses === b.misses && a.hitDays === b.hitDays && a.status === b.status;

// ---------------------------------------------------------------------------------------------
// Kịch bản
// ---------------------------------------------------------------------------------------------

const SC = {};

/** Lần đi đầu tiên với biển `main` và R.122 (S1, và ngày đầu của S3L). */
async function firstPass(env, res, main, shotName) {
  const shot = env.shot(shotName, { canvas: true });
  const pass = await drivePass(env, { day: env.nextDay(), signs: [main, 'R.122'], hooks: [{ at: 320, fn: shot }] });
  common(res, pass);
  res.check('kho trống trước lần đi', pass.before.records.length === 0, pass.before.counts);
  const p = recOf(pass.after, main);
  const r = recOf(pass.after, 'R.122');
  res.check('có đúng hai biển đã học', pass.after.records.length === 2, pass.after.records.map(recBrief));
  res.check(`${main} là biển chưa xác nhận`, p?.status === 'candidate', p && recBrief(p));
  res.check('R.122 là biển chưa xác nhận', r?.status === 'candidate', r && recBrief(r));
  return { pass, p, r };
}

SC.S1 = {
  title: `Lần đầu đi qua ${M} và R.122 ở 50 km/h: hai biển chưa xác nhận, sai số ≤ 5 m, R.122 neo vào nút giao, không đọc gì`,
  async run(env, res) {
    res.check(`${M}, W.224 và R.122 học được với models/labels.json đã cài`, [M, 'W.224', 'R.122'].every((l) => LEARNABLE.has(l)), [M, 'W.224', 'R.122'].filter((l) => !LEARNABLE.has(l)));
    const { pass, p, r } = await firstPass(env, res, M, 's1-scene-day');
    if (p) res.check(`${M}: sai số dọc đường ≤ ${ALONG_ERR_MAX} m`, Math.abs(locate(p.coord).s - SIGNS[M].s) <= ALONG_ERR_MAX, { s: r1(locate(p.coord).s), want: SIGNS[M].s });
    if (r) {
      res.check(`R.122: sai số dọc đường ≤ ${ALONG_ERR_MAX} m`, Math.abs(locate(r.coord).s - SIGNS['R.122'].s) <= ALONG_ERR_MAX, { s: r1(locate(r.coord).s), want: SIGNS['R.122'].s });
      res.check('R.122 neo vào nút giao', r.junction === JUNCTION_KEY, { junction: r.junction, want: JUNCTION_KEY });
    }
    res.check('hướng mặt biển nhìn về xe đi Đông (270° ± 15°)', [p, r].every((x) => x && Math.abs(((x.facing - 270 + 540) % 360) - 180) <= 15), [p?.facing, r?.facing]);
    res.check('không đọc biển nào của camera', camSpeech(pass).length === 0 && !pass.log.speech.some((x) => ANY_SIGN_SAY.test(x.text)), pass.log.speech.map((x) => x.text));
    res.check('không phát sự kiện đi qua cho biển mới', pass.log.passed.length === 0, pass.log.passed);
    if (p) env.ids[M] = p.id;
    if (r) env.ids['R.122'] = r.id;
    res.data = { records: pass.after.records.map(recBrief), speech: pass.log.speech.map((x) => x.text), oracle: pass.log.oracle, tracks: pass.log.results };
    env.chain.S1 = res.status === 'pass';
  },
};

/** Lần đi thứ hai (S2, và ngày thứ hai của S3L): cả hai biển được xác nhận, chưa đọc gì. */
async function secondPass(env, res, main, shotName) {
  const pass = await drivePass(env, { day: env.nextDay(), signs: [main, 'R.122'], hooks: [{ at: 260, fn: env.shot(shotName) }] });
  common(res, pass);
  const pb = recOf(pass.before, main);
  const rb = recOf(pass.before, 'R.122');
  res.check('kho đọc lại từ IndexedDB: hai biển chưa xác nhận', pb?.status === 'candidate' && rb?.status === 'candidate', pass.before.records.map(recBrief));
  const p = recOf(pass.after, main);
  const r = recOf(pass.after, 'R.122');
  res.check(`${main} đã xác nhận, thấy vào 2 ngày`, p?.status === 'confirmed' && p.hitDays === 2, p && recBrief(p));
  res.check('R.122 đã xác nhận, thấy vào 2 ngày', r?.status === 'confirmed' && r.hitDays === 2, r && recBrief(r));
  const quiet = pass.log.samples.filter((x) => x.bar && /\bquiet\b/.test(x.bar.cls) && /\blearned\b/.test(x.bar.cls));
  res.check('thanh cảnh báo hiện biển chưa xác nhận: viền nét đứt, "Camera mới thấy, chưa xác nhận"', quiet.some((x) => x.bar.cap === 'Camera mới thấy, chưa xác nhận'), quiet.slice(0, 2).map((x) => ({ s: x.s, ...x.bar })));
  res.check('không đọc biển nào của camera (biển chưa xác nhận không bao giờ được đọc)', camSpeech(pass).length === 0 && !pass.log.speech.some((x) => ANY_SIGN_SAY.test(x.text)), pass.log.speech.map((x) => x.text));
  const hits = pass.log.passed.filter((e) => e.outcome === 'hit');
  const code = SIGNS[main].code;
  res.check('mỗi biển có một lần thấy lại (hit)', [code, 'R.122'].every((c) => hits.filter((e) => e.code === c).length === 1), pass.log.passed);
  return pass;
}

/** Câu đọc kèm "(camera ghi nhận)" của từng biển, ở 100–200 m (khoảng cách thật và khoảng cách trong câu). */
function checkSpoken(res, pass, labels) {
  const said = camSpeech(pass);
  for (const label of labels) {
    const u = said.find((x) => SAYS[label].test(x.text));
    const d = u ? SIGNS[label].s - u.s : null;
    const m = u && /Phía trước (\d+) mét/.exec(u.text);
    res.check(`${label}: đọc kèm "${CAMERA_SUFFIX.trim()}"`, Boolean(u), said.map((x) => x.text));
    if (u) {
      res.check(`${label}: đọc khi còn ${SPEAK_MIN}–${SPEAK_MAX} m (khoảng cách thật)`, d >= SPEAK_MIN && d <= SPEAK_MAX, { trueDistance: r1(d), text: u.text });
      res.check(`${label}: khoảng cách trong câu đọc ${SPEAK_MIN}–${SPEAK_MAX} m`, m && Number(m[1]) >= SPEAK_MIN && Number(m[1]) <= SPEAK_MAX, u.text);
    }
  }
}

SC.S2 = {
  title: 'Ngày hôm sau: cả hai biển được xác nhận',
  async run(env, res) {
    const pass = await secondPass(env, res, M, 's2-quiet-bar');
    res.data = { records: pass.after.records.map(recBrief), passed: pass.log.passed, speech: pass.log.speech.map((x) => x.text) };
    env.chain.S2 = res.status === 'pass';
  },
};

SC.S3 = {
  title: `Lần thứ ba: đọc "… (camera ghi nhận)" ở 100–200 m cho ${M} và R.122; không biển nào là biển tốc độ nên giới hạn vẫn của bản đồ`,
  async run(env, res) {
    const shots = [{ at: 250, fn: env.shot('s3-confirmed-bar') }, { at: 450, fn: env.shot('s3-map-limit') }];
    const pass = await drivePass(env, { day: env.nextDay(), signs: [M, 'R.122'], hooks: shots });
    common(res, pass);
    checkSpoken(res, pass, [M, 'R.122']);
    const conf = pass.log.samples.filter((x) => x.bar && /\blearned\b/.test(x.bar.cls));
    res.check('thanh cảnh báo hiện biển đã xác nhận (không nét đứt) có huy hiệu camera', conf.some((x) => !/\bquiet\b/.test(x.bar.cls) && x.bar.badge), conf.slice(0, 2).map((x) => ({ s: x.s, ...x.bar })));
    // Không có biển tốc độ nào được học: giới hạn suốt đường là của bản đồ, không bao giờ "Camera".
    const moving = pass.log.samples.filter((x) => x.s >= EAST.from + 50 && x.s <= ROAD.junction - LIMIT_MARGIN && x.v > 0);
    res.check(`suốt đường: giới hạn của bản đồ ${ROAD.maxspeed}, không có "Camera"`, moving.length > 0 && moving.every((x) => x.limit && x.limit.value === String(ROAD.maxspeed) && !x.limit.camera), { samples: moving.length, first: moving[0]?.limit, last: moving[moving.length - 1]?.limit });
    res.check('không có giới hạn tốc độ từ camera', pass.log.samples.every((x) => !x.limit?.camera && !x.cam?.speedLimit), null);
    const p = recOf(pass.after, M);
    const r = recOf(pass.after, 'R.122');
    res.check('hai biển vẫn đã xác nhận, thấy vào 3 ngày', p?.status === 'confirmed' && r?.status === 'confirmed' && p.hitDays === 3 && r.hitDays === 3, [p, r].map((x) => x && recBrief(x)));
    res.data = { speech: pass.log.speech.map((x) => ({ text: x.text, s: r1(x.s) })), records: pass.after.records.map(recBrief) };
    env.chain.S3 = res.status === 'pass';
  },
};

SC.S3L = {
  title: `Biển giới hạn "Camera" (CameraLimit) với nhãn giả lập: ${SPD} học được chỉ trong kiểm thử; ngày thứ ba đọc "tốc độ tối đa 50 (camera ghi nhận)" và đồng hồ hiện "Camera" 50 sau biển`,
  async run(env, res) {
    if (REAL) return res.skip(`--real-models: mô hình v1 không học biển tốc độ (${SPD} có learn: false trong models/labels.json); S3L chỉ kiểm phần sau bộ nhận diện nên chạy ở chế độ oracle.`);
    res.check(`${SPD} không học được với models/labels.json đã cài`, !LEARNABLE.has(SPD), null);
    // Ngữ cảnh riêng (IndexedDB riêng), nhãn giả lập chỉ ở đây; ngày đếm từ đầu.
    const sub = { ...env, ids: {}, day: -1, ctx: await newContext(env.browser, env.net, { labels: fixtureLabels(LABELS_TEXT, SPD) }) };
    try {
      await firstPass(sub, res, SPD, 's3l-scene-day');
      await secondPass(sub, res, SPD, 's3l-quiet-bar');
      const pass = await drivePass(sub, { day: sub.nextDay(), signs: [SPD, 'R.122'], hooks: [{ at: 450, fn: env.shot('s3l-camera-limit') }], settings: { camSpeed: true } });
      common(res, pass);
      checkSpoken(res, pass, [SPD]);
      const sP = SIGNS[SPD].s;
      const win = pass.log.samples.filter((x) => x.s >= sP + LIMIT_MARGIN && x.s <= ROAD.junction - LIMIT_MARGIN && x.v > 0);
      const camOk = win.filter((x) => x.limit && x.limit.value === '50' && x.limit.camera && x.limit.src === 'Camera');
      res.check(`biển giới hạn hiện "Camera" 50 sau biển (${sP + LIMIT_MARGIN}–${ROAD.junction - LIMIT_MARGIN} m)`, win.length > 0 && camOk.length === win.length, { samples: win.length, camera50: camOk.length, first: win[0]?.limit, last: win[win.length - 1]?.limit });
      const pre = pass.log.samples.filter((x) => x.s >= EAST.from + 50 && x.s <= sP - LIMIT_MARGIN && x.v > 0);
      res.check(`trước biển: giới hạn của bản đồ ${ROAD.maxspeed}, không có "Camera"`, pre.length > 0 && pre.every((x) => x.limit && x.limit.value === String(ROAD.maxspeed) && !x.limit.camera), { samples: pre.length, first: pre[0]?.limit });
      const postJ = pass.log.samples.filter((x) => x.s >= ROAD.junction + LIMIT_MARGIN && x.v > 0);
      res.check('qua nút giao (đổi đường): giới hạn camera hết hiệu lực', postJ.length > 0 && postJ.every((x) => !x.limit?.camera), { samples: postJ.length, last: postJ[postJ.length - 1]?.limit });
      const p = recOf(pass.after, SPD);
      res.check(`${SPD} vẫn đã xác nhận, thấy vào 3 ngày`, p?.status === 'confirmed' && p.hitDays === 3, p && recBrief(p));
      res.data = { speech: pass.log.speech.map((x) => ({ text: x.text, s: r1(x.s) })), records: pass.after.records.map(recBrief), limitSamples: pass.log.samples.filter((x) => x.v > 0).map((x) => ({ s: x.s, limit: x.limit })) };
    } finally {
      await sub.ctx.close().catch(() => {});
    }
  },
};

SC.S4 = {
  title: 'Biển bị dỡ khỏi cảnh: biển đã xác nhận bị loại sau số lần thiếu của §5.8, biển chưa xác nhận sau 2 lần; biển của nút giao cũng bị tính lần thiếu',
  async run(env, res) {
    // Ngày chuẩn bị: biển chính lên mức trần (L_MAX) để đúng câu "7 lần từ mức trần"; W.224 mới thấy một lần.
    const prep = await drivePass(env, { day: env.nextDay(), signs: [M, 'W.224', 'R.122'] });
    common(res, prep);
    const p0 = recOf(prep.after, M);
    const w0 = recOf(prep.after, 'W.224');
    res.check('ngày chuẩn bị: W.224 là biển chưa xác nhận mới', w0?.status === 'candidate' && w0.hitDays === 1, w0 && recBrief(w0));
    res.check(`ngày chuẩn bị: ${M} đã xác nhận, L = ${L_MAX} (mức trần)`, p0?.status === 'confirmed' && Math.abs(p0.L - L_MAX) < 1e-6, p0 && recBrief(p0));
    if (!p0 || !w0) return;
    env.ids['W.224'] = w0.id;
    const kP = missesToRetire(p0.L, L_MISS_CONFIRMED);
    const kW = missesToRetire(w0.L, L_MISS_CANDIDATE);
    res.data.expected = { [M]: { L: p0.L, misses: kP }, 'W.224': { L: w0.L, misses: kW } };
    res.check('số lần thiếu để loại theo §5.8: biển đã xác nhận 7 (từ mức trần), biển chưa xác nhận 2', kP === 7 && kW === 2, { kP, kW });
    const timeline = [];
    let lastP = p0;
    let lastW = w0;
    let lastR = recOf(prep.after, 'R.122');
    for (let i = 0; i < kP + S4_SLACK_DAYS && lastP.status !== 'retired'; i++) {
      const pass = await drivePass(env, { day: env.nextDay(), signs: ['R.122'] });
      common(res, pass);
      const P = pass.after.records.find((x) => x.id === p0.id);
      const Wr = pass.after.records.find((x) => x.id === w0.id);
      const R = recOf(pass.after, 'R.122');
      const outP = pass.log.passed.filter((e) => e.id === p0.id).map((e) => `${e.outcome}${e.reason ? `:${e.reason}` : ''}`);
      const outW = pass.log.passed.filter((e) => e.id === w0.id).map((e) => `${e.outcome}${e.reason ? `:${e.reason}` : ''}`);
      const outR = R ? pass.log.passed.filter((e) => e.id === R.id).map((e) => `${e.outcome}${e.reason ? `:${e.reason}` : ''}`) : [];
      timeline.push({ day: pass.day, P: P && recBrief(P), W: Wr && recBrief(Wr), R: R && recBrief(R), outP, outW, outR });
      res.check(`ngày ${pass.day}: ${M} có đúng một lần thiếu`, P && P.misses === lastP.misses + 1, { before: recBrief(lastP), after: P && recBrief(P), events: outP });
      if (lastW.status !== 'retired') res.check(`ngày ${pass.day}: W.224 có đúng một lần thiếu`, Wr && Wr.misses === lastW.misses + 1, { after: Wr && recBrief(Wr), events: outW });
      // PLAN §5.8 chỉ đòi biển vẫn còn không bao giờ bị tính là thiếu: 'hit', hoặc 'none:seen' khi lượt bám thấy biển nhưng
      // chưa đủ tin (p của oracle 0,80–0,99 mỗi khung, trung bình 3–5 khung dưới 0,85 vào 3–8 % số lần) đều đúng.
      res.check(
        `ngày ${pass.day}: R.122 (vẫn còn) không bị tính thiếu ('hit' hoặc 'none:seen'), vẫn đã xác nhận`,
        R && lastR && outR.length === 1 && ['hit', 'none:seen'].includes(outR[0]) && R.misses === lastR.misses && R.status === 'confirmed' &&
          R.hitDays === lastR.hitDays + (outR[0] === 'hit' ? 1 : 0),
        { events: outR, before: lastR && recBrief(lastR), after: R && recBrief(R) },
      );
      if (P) lastP = P;
      if (Wr) lastW = Wr;
      if (R) lastR = R;
    }
    res.data.timeline = timeline;
    // Đường thấy lại vẫn phải chạy: ít nhất một ngày là 'hit'; số ngày 'none:seen' được ghi lại.
    const rSeen = timeline.filter((x) => x.outR?.[0] === 'none:seen').length;
    const rHits = timeline.filter((x) => x.outR?.[0] === 'hit').length;
    res.check(`R.122: thấy lại (hit) ${rHits} ngày, 'none:seen' ${rSeen} ngày; có ít nhất một ngày thấy lại`, rHits >= 1, { hit: rHits, seen: rSeen });
    const retiredAtP = timeline.find((x) => x.P?.status === 'retired');
    const retiredAtW = timeline.find((x) => x.W?.status === 'retired');
    res.check(`${M} bị loại đúng ở lần thiếu thứ ${kP}`, retiredAtP && retiredAtP.P.misses - p0.misses === kP && timeline.filter((x) => x.P?.status === 'confirmed').every((x) => x.P.misses - p0.misses < kP), retiredAtP?.P);
    res.check(`W.224 bị loại đúng ở lần thiếu thứ ${kW}`, retiredAtW && retiredAtW.W.misses - w0.misses === kW && timeline.filter((x) => x.W?.status === 'candidate').every((x) => x.W.misses - w0.misses < kW), retiredAtW?.W);
    // Biển của nút giao (R.122, neo 10 m trước nút giao, đường chính tách làm hai đường OSM ở nút giao như dữ liệu thật):
    // dỡ nốt nó thì mỗi lượt đi qua cũng phải là một lần thiếu.
    const junction = [];
    for (let i = 0; i < S4_JUNCTION_DAYS; i++) {
      const pass = await drivePass(env, { day: env.nextDay(), signs: [] });
      common(res, pass);
      const R = recOf(pass.after, 'R.122');
      const ev = pass.log.passed.filter((e) => e.code === 'R.122').map((e) => `${e.outcome}${e.reason ? `:${e.reason}` : ''}`);
      junction.push({ day: pass.day, R: R && recBrief(R), events: ev });
      res.check(`ngày ${pass.day}: R.122 đã dỡ (biển nút giao) có một lần thiếu`, ev.length === 1 && ev[0] === 'miss' && R && R.misses === (lastR?.misses ?? 0) + 1, { events: ev, before: lastR && recBrief(lastR), after: R && recBrief(R) });
      if (R) lastR = R;
    }
    res.data.junction = junction;
    env.chain.confirmed = false; // biển chính đã bị loại: các kịch bản sau cần chuỗi S1–S3 mới
  },
};

SC.S5 = {
  title: 'Ban đêm: không có lần thiếu nào được tính',
  async run(env, res) {
    const shot = env.shot('s5-scene-night', { canvas: true });
    const pass = await drivePass(env, { day: env.nextDay(), night: true, signs: [M, 'R.122'], hooks: [{ at: 300, fn: shot }] });
    common(res, pass);
    for (const label of [M, 'R.122']) {
      const a = recOf(pass.before, label);
      const b = recOf(pass.after, label);
      res.check(`${label}: không bị trừ điểm (L, số lần thiếu giữ nguyên)`, unchanged(a, b), { before: a && recBrief(a), after: b && recBrief(b) });
    }
    res.check('không có sự kiện "miss"', !pass.log.passed.some((e) => e.outcome === 'miss'), pass.log.passed);
    res.data = { passed: pass.log.passed, lum: pass.log.oracle?.lum ?? null, health: pass.log.health };
  },
};

SC.S6 = {
  title: 'Đi ngược chiều: không có bằng chứng, không cảnh báo',
  async run(env, res) {
    const pass = await drivePass(env, { day: env.nextDay(), dir: -1, signs: [M, 'R.122'], hooks: [{ at: 400, fn: env.shot('s6-westbound') }] });
    common(res, pass);
    for (const label of [M, 'R.122']) {
      const a = recOf(pass.before, label);
      const b = recOf(pass.after, label);
      res.check(`${label}: kho không đổi (L, số ngày, số lần thiếu, số lượt)`, unchanged(a, b) && a.passes === b.passes, { before: a && recBrief(a), after: b && recBrief(b) });
    }
    const ids = new Set([env.ids[M], env.ids['R.122']]);
    res.check('không có sự kiện đi qua nào cho hai biển', !pass.log.passed.some((e) => ids.has(e.id)), pass.log.passed);
    const shown = pass.log.samples.filter((x) => (x.bar && /\blearned\b/.test(x.bar.cls)) || x.strip.some((c) => /\blearned\b/.test(c)));
    res.check('thanh cảnh báo và dải biển không hiện biển camera', shown.length === 0, shown.slice(0, 2));
    res.check('không đọc câu nào của camera', camSpeech(pass).length === 0, pass.log.speech.map((x) => x.text));
    res.check('không có giới hạn tốc độ từ camera', pass.log.samples.every((x) => !x.limit?.camera && !x.cam?.speedLimit), null);
  },
};

SC.S7 = {
  title: 'Quyền camera là "prompt": ẩn rồi hiện trang không gọi getUserMedia',
  async run(env, res) {
    const at = {};
    const gum = async (page, key) => {
      at[key] = await page.evaluate(() => ({ gum: globalThis.__BDH.log.gum, chip: document.getElementById('btnCamChip').className, camera: globalThis.__BD_TEST__.controller.state.camera }));
    };
    const toggle = async (page) => {
      await page.evaluate(() => globalThis.__BDH.setVisible(false));
      await sleep(1500);
      await page.evaluate(() => globalThis.__BDH.setVisible(true));
      await sleep(1500);
    };
    const hooks = [
      { at: 180, fn: (page) => gum(page, 'moving') },
      { at: 190, fn: async (page) => { await toggle(page); await gum(page, 'afterToggle'); } },
      // Đối chứng: quyền đã cấp thì ẩn/hiện tự mở lại camera (không có lần bấm nào).
      { at: 260, fn: async (page) => { await page.evaluate(() => globalThis.__BDH.setPermission('granted')); await toggle(page); await gum(page, 'granted'); } },
      // Quyền "chỉ lần này" hết hạn: lại là prompt; ẩn trả camera, hiện lại không hỏi quyền.
      { at: 340, fn: async (page) => { await page.evaluate(() => globalThis.__BDH.setPermission('prompt')); await toggle(page); await gum(page, 'promptAgain'); } },
    ];
    const pass = await drivePass(env, { day: env.nextDay(), to: 430, signs: [M], permission: 'prompt', hooks });
    common(res, pass, { camera: false });
    res.check('đang chạy, quyền "prompt": không gọi getUserMedia, nút camera gạch chéo', at.moving?.gum === 0 && /cam-off/.test(at.moving.chip), at.moving);
    res.check('ẩn rồi hiện trang (quyền "prompt"): vẫn không gọi getUserMedia', at.afterToggle?.gum === 0, at.afterToggle);
    res.check('đối chứng: quyền đã cấp thì ẩn/hiện tự mở lại camera, không cần bấm', at.granted?.gum === 1 && at.granted.camera === 'on', at.granted);
    res.check('quyền trở lại "prompt": ẩn/hiện không gọi thêm getUserMedia', at.promptAgain?.gum === 1 && /cam-off/.test(at.promptAgain.chip), at.promptAgain);
    res.check('mọi lần gọi getUserMedia đều lúc quyền đã cấp', pass.log.gumAt.every((g) => g.permission === 'granted'), pass.log.gumAt);
    res.data = { at, gumAt: pass.log.gumAt, visibility: pass.log.visibility };
  },
};

SC.S8 = {
  title: 'Ẩn trang: camera dừng hẳn (track kết thúc), hiện lại thì tự mở lại',
  async run(env, res) {
    const at = {};
    const read = (page) => page.evaluate(() => ({ live: globalThis.__BDH.tracksLive(), stops: globalThis.__BDH.log.trackStops, gum: globalThis.__BDH.log.gum, grabs: globalThis.__BDH.log.grabs, grabsHidden: globalThis.__BDH.log.grabsHidden, capturing: globalThis.__BD_TEST__.controller.state.capturing, camera: globalThis.__BD_TEST__.controller.state.camera }));
    const hooks = [
      { at: 200, fn: async (page) => { at.before = await read(page); } },
      {
        at: 210,
        fn: async (page) => {
          await page.evaluate(() => globalThis.__BDH.setVisible(false));
          await sleep(HIDE_STOP_MS);
          at.hidden = await read(page);
          await sleep(2000);
          at.hiddenLater = await read(page);
          await page.evaluate(() => globalThis.__BDH.setVisible(true));
          await sleep(2500);
          at.shown = await read(page);
        },
      },
    ];
    const pass = await drivePass(env, { day: env.nextDay(), to: 420, signs: [M], hooks });
    common(res, pass);
    res.check('trước khi ẩn: camera mở và đang lấy khung', at.before?.live >= 1 && at.before.capturing === true, at.before);
    res.check(`ẩn trang: mọi track đã dừng trong ${HIDE_STOP_MS} ms`, at.hidden?.live === 0 && at.hidden.stops >= 1 && at.hidden.capturing === false, at.hidden);
    res.check('trong lúc ẩn: không lấy khung nào', at.hiddenLater && at.hiddenLater.grabsHidden === 0 && at.hiddenLater.grabs === at.hidden.grabs, at.hiddenLater);
    res.check('hiện lại (quyền đã cấp): tự mở lại camera, không cần bấm', at.shown?.live >= 1 && at.shown.gum === (at.before?.gum ?? 0) + 1 && at.shown.camera === 'on', at.shown);
    res.data = { at, visibility: pass.log.visibility };
  },
};

SC.S9 = {
  title: 'Camera không có hình (khung đen): không có lần thiếu nào, nút camera báo',
  async run(env, res) {
    const shot = env.shot('s9-blank-chip');
    const pass = await drivePass(env, { day: env.nextDay(), signs: [M, 'R.122'], flags: { blank: true }, hooks: [{ at: 300, fn: shot }] });
    common(res, pass);
    for (const label of [M, 'R.122']) {
      const a = recOf(pass.before, label);
      const b = recOf(pass.after, label);
      res.check(`${label}: không bị trừ điểm`, unchanged(a, b), { before: a && recBrief(a), after: b && recBrief(b) });
    }
    res.check('không có sự kiện "miss"', !pass.log.passed.some((e) => e.outcome === 'miss'), pass.log.passed);
    const cap = pass.log.samples.filter((x) => x.cam?.capturing);
    const blank = cap.filter((x) => x.cam.health === 'blank');
    res.check('bộ học nhận ra khung đen (health "blank")', blank.length > 0, { capturing: cap.length, blank: blank.length });
    const warned = pass.log.samples.filter((x) => x.chip && !x.chip.hidden && x.chip.title === TEXT.blank);
    res.check(`nút camera báo "${TEXT.blank}"`, warned.length > 0, warned[0]?.chip ?? pass.log.samples.find((x) => x.cam?.capturing)?.chip);
    const styled = warned.filter((x) => /\bcam-warn\b/.test(x.chip.cls));
    res.check('nút camera có kiểu hiển thị cảnh báo riêng (không chỉ chú thích)', styled.length > 0, warned[0]?.chip, { info: true });
    res.data = { passed: pass.log.passed, health: pass.log.health, chip: warned[0]?.chip ?? null };
  },
};

SC.S10 = {
  title: 'Khớp vectơ mẫu: đầu ra LiteRT khớp models/golden/index.json trong tol của từng đầu ra, cả hai bản dựng wasm',
  async run(env, res) {
    const m = modelsInstalled();
    if (!m.ok || !m.golden) return res.skip('Chưa có mô hình đã huấn luyện (models/sign-det.int8.tflite, sign-cls.int8.tflite, golden/index.json) — chạy lại sau khi bước cài đặt của tools/camera/train-all.sh xong.');
    const page = await benchPage(env);
    try {
      for (const build of ['compat', 'relaxed']) {
        const out = await page.evaluate((b) => globalThis.bdBench.parity({ build: b }), build);
        res.data[build] = out;
        res.check(`${build}: mọi trường hợp trong tol`, out.ok && out.cases > 0, { cases: out.cases, worst: out.worst, failed: out.failed.slice(0, 5) });
      }
    } finally {
      await page.close();
    }
  },
};

SC.S11 = {
  title: `Độ trễ p50/p90/p99 trên ≥ ${LATENCY_FRAMES} khung mỗi bản dựng`,
  async run(env, res) {
    const m = modelsInstalled();
    if (!m.ok) return res.skip('Chưa có mô hình đã huấn luyện trong models/ — chạy lại sau khi bước cài đặt của tools/camera/train-all.sh xong.');
    const busy = trainingRunning();
    res.data.trainingRunning = busy;
    if (busy) res.notes.push('Quá trình huấn luyện đang chạy và chiếm mọi nhân: số đo dưới đây KHÔNG đại diện cho máy này.');
    const page = await benchPage(env);
    try {
      for (const build of ['compat', 'relaxed']) {
        const out = await page.evaluate(({ b, n }) => globalThis.bdBench.latency({ build: b, frames: n }), { b: build, n: LATENCY_FRAMES });
        res.data[build] = out;
        res.check(`${build}: đo đủ ${LATENCY_FRAMES} khung mỗi tổ hợp lượt quét`, Object.values(out.passes).every((x) => x.n >= LATENCY_FRAMES), out.passes);
      }
    } finally {
      await page.close();
    }
  },
};

async function benchPage(env) {
  const page = await env.ctx.newPage();
  page.on('pageerror', (e) => console.log(`    lỗi trang đo: ${e.message}`));
  await page.goto(`${env.base}/tests/browser/device-bench.html?harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.bdBench?.ready === true, null, { timeout: LOAD_TIMEOUT });
  return page;
}

// Thứ tự chạy: S4 làm biển bị loại nên chạy cuối trong các kịch bản cần biển đã xác nhận. S3L dùng ngữ cảnh riêng.
const ORDER = ['S1', 'S2', 'S3', 'S3L', 'S5', 'S6', 'S9', 'S7', 'S8', 'S4', 'S10', 'S11'];
const NEEDS_CONFIRMED = new Set(['S4', 'S5', 'S6', 'S9']);
const DRIVES = new Set(['S1', 'S2', 'S3', 'S3L', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);

async function main() {
  const models = modelsInstalled();
  const port = await freePort();
  const pw = loadPlaywright();
  const started = new Date().toISOString();
  const results = [];
  const net = { overpass: 0, overpassRoad: 0, tiles: 0, blocked: new Set() };
  const env = {
    base: null,
    browser: null,
    net,
    ctx: null,
    ids: {},
    chain: { S1: false, S2: false, S3: false, confirmed: false },
    passes: [],
    day: -1,
    nextDay() {
      this.day += 1;
      return this.day;
    },
    shot(name, { canvas = false } = {}) {
      return async (page) => {
        if (!SHOTS) return;
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `${name}.png`) });
        if (canvas) {
          const url = await page.evaluate(() => globalThis.__BDH.canvas.toDataURL('image/png'));
          writeFileSync(join(SHOTS, `${name}-camera.png`), Buffer.from(url.split(',')[1], 'base64'));
        }
      };
    },
  };
  console.log(`Bộ chạy thử lái xe: chế độ ${REAL ? 'mô hình thật' : 'oracle'}, cổng ${port}${models.ok ? '' : ', models/ chưa có mô hình đã huấn luyện'}`);
  const srv = await startDevServer(port);
  env.base = srv.url;
  let browser = null;
  try {
    browser = await pw.chromium.launch();
    env.browser = browser;
    env.ctx = await newContext(browser, net);
    const want = ORDER.filter((id) => !ONLY || ONLY.has(id));
    const runOne = async (id, { prerequisite = false } = {}) => {
      const res = new Result(id, SC[id].title);
      if (prerequisite) res.prerequisite = true;
      console.log(`${id}${prerequisite ? ' (điều kiện trước)' : ''}: ${SC[id].title}`);
      const t0 = Date.now();
      if (REAL && DRIVES.has(id) && !models.ok) {
        res.skip('--real-models: models/ chưa có mô hình đã huấn luyện.');
      } else {
        try {
          await SC[id].run(env, res);
        } catch (err) {
          res.check('chạy hết kịch bản', false, String(err?.stack || err).split('\n').slice(0, 4).join(' | '));
        }
      }
      res.seconds = Math.round((Date.now() - t0) / 1000);
      results.push(res);
      if (id === 'S3') env.chain.confirmed = env.chain.S1 && env.chain.S2 && res.status === 'pass';
      return res;
    };
    let chainTried = false;
    for (const id of want) {
      if (NEEDS_CONFIRMED.has(id) && !env.chain.confirmed && !chainTried && !(REAL && !models.ok)) {
        chainTried = true;
        for (const pre of ['S1', 'S2', 'S3']) await runOne(pre, { prerequisite: true });
        if (!env.chain.confirmed) console.log(`  ${id}: chuỗi S1–S3 không đạt, vẫn chạy để ghi lại kết quả`);
      }
      await runOne(id);
    }
  } finally {
    if (env.ctx) await env.ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
  const summary = {
    started,
    finished: new Date().toISOString(),
    mode: REAL ? 'real-models' : 'oracle',
    modelsInstalled: models,
    trainingRunning: trainingRunning(),
    note: REAL
      ? null
      : 'Chế độ oracle: bộ nhận diện được thay bằng oracle.js (hộp chiếu từ cảnh đã biết, có nhiễu). Kết quả kiểm phần sau bộ nhận diện; độ chính xác và độ trễ của mô hình thật chưa đo.',
    world: { origin: ORIGIN, road: ROAD, signs: SIGNS, speed: SPEED, gpsSigma: GPS_SIGMA },
    network: { overpass: net.overpass, overpassRoad: net.overpassRoad, tiles: net.tiles, blocked: [...net.blocked] },
    counts: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      skip: results.filter((r) => r.status === 'skip').length,
    },
    scenarios: results,
    passes: env.passes,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nKết quả: ${summary.counts.pass} đạt, ${summary.counts.fail} hỏng, ${summary.counts.skip} bỏ qua${OUT ? ` → ${OUT}` : ''}`);
  for (const r of results) console.log(`  ${r.id}${r.prerequisite ? '*' : ''} ${r.status}${r.notes.length ? ` (${r.notes.join(' ')})` : ''}`);
  process.exitCode = summary.counts.fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});

