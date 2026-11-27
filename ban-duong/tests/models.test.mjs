import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../js/visionproto.js';
import { SIGN_CATALOGUE } from '../js/signs.js';
import {
  artDigest,
  BACKGROUND,
  buildLabels,
  CLS_INPUT,
  CLS_MARGIN,
  CsvParser,
  DET_INPUT,
  DET_STRIDE,
  FAMILIES,
  hash32,
  isJunctionCode,
  MAX_BG_WIDTH,
  MIN_BG_WIDTH,
  MIRROR_OF,
  mulberry32,
  isCleanStatus,
  OI_LICENSE,
  OI_META,
  OI_SIGN_CLASS,
  OI_SIGN_CLASSES,
  OI_STREET_CLASSES,
  OTHER_SIGN,
  P127_VALUES,
  parseArgs,
  provenance,
  PROVENANCE_MAX_CHANGED,
  SHAPE_FAMILY,
  signStatus,
  SPLIT_TEST,
  SPLIT_VAL,
  splitOf,
  TRAINING_SOURCES,
  trainingPlan,
  valuePool,
  WHITELIST,
} from '../tools/camera/lib.mjs';
import { labelsText } from '../tools/camera/labels.mjs';
import { wheelFits } from '../tools/camera/pin-requirements.mjs';
import { BOX_JITTER, CROP_SIZES, nativeWidth } from '../tools/camera/lib.mjs';
import { countFor, P_PLATE_OTHER, P_PURE_BG, sampleItem, SHARD } from '../tools/camera/render-crops.mjs';
import {
  FAMILY_WEIGHTS,
  FRAMES_B,
  GROUPS_W,
  letterboxB,
  MAX_DISTRACTORS,
  P_GEO_B,
  P_OTHER,
  P_PLATE,
  P_STACK,
  SCENE_SHARD,
  sceneSpec,
  SIZE_A,
  SIZE_B,
} from '../tools/camera/render-scenes.mjs';
import {
  ATTRIBUTION_HEADER,
  attributionCsv,
  CHANGES_NOTE,
  orderByRank,
  rankCandidates,
  STATE_VERSION,
  streetScore,
} from '../tools/camera/fetch-backgrounds.mjs';
import { distractorSvg, GLYPH_AVOID, GLYPHS, OTHER_NUMBERS, otherSignSvg, plateSvg } from '../tools/camera/synth-art.mjs';
import { backgroundsFor } from '../tools/camera/render-common.mjs';
import { checkStage, parseSums, REQUIRED_FILES, swapBack, swapIn } from '../tools/camera/install-models.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'models');
const TOOLS = join(ROOT, 'tools', 'camera');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const labelsJson = JSON.parse(readFileSync(join(MODELS, 'labels.json'), 'utf8'));
// Nhãn sinh mới từ danh mục (cờ learn = WHITELIST): kế hoạch vẽ và số ảnh không được phụ thuộc vào labels.json đã
// bị eval_synthetic.py --prune sửa.
const FRESH = buildLabels(SIGN_CATALOGUE);
const freshLabel = (name) => FRESH.labels.find((l) => l.label === name);
/** Bản labels.json giống như sau một lần gỡ nhãn: các nhãn đã cho có learn:false và nằm trong build.pruned. */
const prunedCopy = (names) => ({
  ...FRESH,
  labels: FRESH.labels.map((l) => (names.includes(l.label) ? { ...l, learn: false } : { ...l })),
  build: { ...FRESH.build, pruned: [...names] },
});
const tmp = (name) => mkdtempSync(join(tmpdir(), `bd-models-${name}-`));

// ---------------------------------------------------------------------------------------------
// labels.json (hợp đồng 1)
// ---------------------------------------------------------------------------------------------

test('labels.json khớp SIGN_CATALOGUE: 181 nhãn, 47 nhãn được học (trừ nhãn bị gỡ sau đánh giá), họ hợp lệ', () => {
  const fresh = buildLabels(SIGN_CATALOGUE);
  assert.equal(Object.keys(SIGN_CATALOGUE).length, 169);
  assert.equal(labelsJson.version, 1);
  assert.deepEqual(labelsJson.families, fresh.families);
  assert.deepEqual(labelsJson.det, { input: [352, 640, 3], stride: 8, out: [44, 80] });
  assert.deepEqual(labelsJson.cls, { input: [48, 48, 3] });
  // eval_synthetic.py --prune có thể đặt learn:false cho nhãn không qua ngưỡng E1 và ghi chúng vào build.pruned.
  const pruned = new Set(labelsJson.build?.pruned || []);
  for (const p of pruned) assert.ok(WHITELIST.includes(p), `build.pruned có nhãn ngoài danh sách học: ${p}`);
  const expected = fresh.labels.map((l) => (pruned.has(l.label) ? { ...l, learn: false } : l));
  assert.deepEqual(labelsJson.labels, expected, 'chạy lại: node tools/camera/labels.mjs');
  assert.equal(labelsJson.labels.length, 181);
  assert.equal(fresh.labels.filter((l) => l.learn).length, 47);
  assert.equal(labelsJson.labels.filter((l) => l.learn).length, 47 - pruned.size);
  assert.ok(Number.isFinite(labelsJson.T) && labelsJson.T > 0, 'T phải là số dương');
  assert.equal(typeof labelsJson.build, 'object');
  labelsJson.labels.forEach((l, i) => {
    assert.equal(l.i, i);
    if (l.code) assert.ok(FAMILIES.includes(l.family), `${l.label}: họ ${l.family}`);
    else assert.equal(l.family, null);
  });
});

test('labels.json: thứ tự cố định, P.127 thay bằng 11 lớp trị số tại chỗ, hai nhãn cuối', () => {
  const labels = labelsJson.labels.map((l) => l.label);
  const codes = Object.keys(SIGN_CATALOGUE);
  const at = codes.indexOf('P.127');
  assert.deepEqual(labels.slice(0, at), codes.slice(0, at));
  assert.deepEqual(labels.slice(at, at + 11), P127_VALUES.map((v) => `P.127[${v}]`));
  assert.deepEqual(labels.slice(at + 11, 179), codes.slice(at + 1));
  assert.deepEqual(labels.slice(179), [OTHER_SIGN, BACKGROUND]);
  assert.deepEqual(P127_VALUES, ['20', '30', '40', '50', '60', '70', '80', '90', '100', '110', '120']);
  for (const l of labelsJson.labels.filter((x) => x.code === 'P.127')) assert.equal(l.label, `P.127[${l.value}]`);
  for (const l of labelsJson.labels.filter((x) => x.code && x.code !== 'P.127')) assert.equal(l.value, null);
  // Bản sinh lại luôn đọc ngược được; T luôn bắt đầu từ 1 (calibrate.py ghi giá trị thật).
  const again = JSON.parse(labelsText());
  assert.deepEqual(again.labels, buildLabels(SIGN_CATALOGUE).labels);
  assert.equal(again.T, 1);
});

test('danh sách được học đúng 47 nhãn của PLAN §2.2 và có trong danh mục', () => {
  assert.equal(WHITELIST.length, 47);
  assert.equal(new Set(WHITELIST).size, 47);
  const pruned = new Set(labelsJson.build?.pruned || []);
  const learn = labelsJson.labels.filter((l) => l.learn || pruned.has(l.label)).map((l) => l.label).sort();
  assert.deepEqual(learn, [...WHITELIST].sort());
  for (const w of WHITELIST) assert.ok(SIGN_CATALOGUE[w.replace(/\[.*$/, '')], w);
  // Không học biển chữ, biển chỉ dẫn, mũi tên R.301 hay biển phụ.
  for (const no of ['P.129', 'W.245a', 'W.245b', 'R.301', 'I.407a', 'R.420', OTHER_SIGN, BACKGROUND])
    assert.equal(labelsJson.labels.find((l) => l.label === no).learn, false, no);
  assert.throws(() => buildLabels({ 'P.101': SIGN_CATALOGUE['P.101'] }), /không có trong danh mục/);
});

test('nhãn gắn nút giao: R.122, W.208, W.209, P.102, P.123*, P.124*, P.136–P.139', () => {
  const j = labelsJson.labels.filter((l) => l.junction).map((l) => l.label);
  assert.deepEqual(j.sort(), [
    'P.102', 'P.123a', 'P.123b', 'P.124a', 'P.124b', 'P.124c', 'P.124d', 'P.124e', 'P.124f',
    'P.136', 'P.137', 'P.138', 'P.139', 'R.122', 'W.208', 'W.209',
  ]);
  assert.equal(isJunctionCode('P.135'), false);
  assert.equal(isJunctionCode('P.140'), false);
  assert.equal(isJunctionCode('W.207'), false);
});

test('họ của bộ dò: 11 họ theo thứ tự hợp đồng, mọi hình dạng đều có họ', () => {
  assert.deepEqual(FAMILIES, ['ring', 'noentry', 'bluering', 'end', 'triangle', 'invtriangle', 'octagon', 'bluedisc', 'bluerect', 'diamond', 'plate']);
  for (const e of Object.values(SIGN_CATALOGUE)) assert.ok(SHAPE_FAMILY[e.art.shape], e.code);
  const fam = (label) => labelsJson.labels.find((l) => l.label === label).family;
  assert.equal(fam('P.127[50]'), 'ring');
  assert.equal(fam('P.102'), 'noentry');
  assert.equal(fam('P.130'), 'bluering');
  assert.equal(fam('DP.134'), 'end');
  assert.equal(fam('W.225'), 'triangle');
  assert.equal(fam('W.208'), 'invtriangle');
  assert.equal(fam('R.122'), 'octagon');
  assert.equal(fam('R.302a'), 'bluedisc');
  assert.equal(fam('I.407a'), 'bluerect');
  assert.equal(fam('IE.452'), 'bluerect');
  assert.equal(fam('I.401'), 'diamond');
  assert.equal(fam('W.243a'), 'plate');
  assert.equal(fam('W.242a'), 'plate');
  // Mọi họ trừ biển phụ đều có ít nhất một nhãn được học hoặc ít nhất một mã trong danh mục.
  for (const f of FAMILIES) if (f !== 'plate') assert.ok(labelsJson.labels.some((l) => l.family === f), f);
});

test('hằng số kích thước đầu vào khớp hợp đồng 2 và 3', () => {
  assert.deepEqual(DET_INPUT, [352, 640, 3]);
  assert.equal(DET_STRIDE, 8);
  assert.equal(DET_INPUT[0] % 32, 0); // MobileNetV2 cần bội số của 32 để xuất cố định
  assert.equal(DET_INPUT[1] % 32, 0);
  assert.deepEqual(CLS_INPUT, [48, 48, 3]);
  assert.equal(CLS_MARGIN, 0.15);
});

// ---------------------------------------------------------------------------------------------
// Kế hoạch vẽ dữ liệu
// ---------------------------------------------------------------------------------------------

test('kế hoạch vẽ: nhãn trùng hình gom về nhãn gốc, cặp trái/phải lật gương, nhãn được học luôn có ảnh', () => {
  const plan = trainingPlan(FRESH, SIGN_CATALOGUE);
  assert.equal(Object.keys(plan).length, 181);
  for (const w of WHITELIST) assert.equal(plan[w].kind, 'sign', `${w} phải có ảnh huấn luyện riêng`);
  assert.deepEqual(plan['DP.127'], { kind: 'alias', to: 'DP.134' }); // ưu tiên nhãn được học làm gốc
  assert.deepEqual(plan['P.127a'], { kind: 'alias', to: 'P.127[n]' });
  assert.deepEqual(plan['W.245b'], { kind: 'alias', to: 'W.245a' });
  assert.equal(plan['W.202b'].mirror, true);
  assert.equal(plan['W.202a'].mirror, false);
  assert.deepEqual(Object.keys(MIRROR_OF).sort(), ['W.201d', 'W.202b', 'W.223b']);
  assert.deepEqual(plan['P.127[70]'].values, ['70']);
  assert.equal(plan['P.106a'].values, null); // P.106a và P.106b chỉ khác nhau ở số tấn trên xe
  assert.ok(plan['P.106b'].values.length > 0);
  assert.equal(plan[OTHER_SIGN].kind, 'other');
  assert.equal(plan[BACKGROUND].kind, 'background');
  // Mọi nhãn bị gom đều trỏ tới một nhãn có ảnh.
  for (const [k, v] of Object.entries(plan))
    if (v.kind === 'alias' && v.to !== 'P.127[n]') assert.equal(plan[v.to].kind, 'sign', `${k} → ${v.to}`);
});

test('trị số in lên biển đều qua được bộ lọc của signSvg', () => {
  const ok = /^[0-9]{1,3}([.,][0-9])?$/;
  for (const e of Object.values(SIGN_CATALOGUE)) for (const v of valuePool(e.code, e.art) || []) assert.match(v, ok, e.code);
  assert.ok(valuePool('P.115', SIGN_CATALOGUE['P.115'].art).includes('3,5') === false); // P.115 dùng bảng tấn riêng
  assert.ok(valuePool('P.117', SIGN_CATALOGUE['P.117'].art).includes('3,5'));
  assert.equal(valuePool('P.101', SIGN_CATALOGUE['P.101'].art), null);
});

// ---------------------------------------------------------------------------------------------
// Dữ liệu tổng hợp
// ---------------------------------------------------------------------------------------------

test('kế hoạch vẽ và số ảnh không đổi khi labels.json đã bị gỡ cờ learn sau đánh giá', () => {
  const names = ['P.127[50]', 'DP.134', 'W.205'];
  const pruned = prunedCopy(names);
  assert.deepEqual(trainingPlan(pruned, SIGN_CATALOGUE), trainingPlan(FRESH, SIGN_CATALOGUE));
  assert.deepEqual(trainingPlan(pruned, SIGN_CATALOGUE)['DP.127'], { kind: 'alias', to: 'DP.134' });
  const opt = { perClass: 10, tierA: 30, bgMult: 4, otherMult: 2 };
  const planP = trainingPlan(pruned, SIGN_CATALOGUE);
  for (const l of pruned.labels) assert.equal(countFor(l, planP, opt), countFor(freshLabel(l.label), trainingPlan(FRESH, SIGN_CATALOGUE), opt), l.label);
  for (const n of names) assert.equal(countFor(pruned.labels.find((l) => l.label === n), planP, opt), 30, n);
  // labels.json trong kho (có thể đã bị gỡ nhãn) cũng cho đúng kế hoạch của danh mục
  assert.deepEqual(trainingPlan(labelsJson, SIGN_CATALOGUE), trainingPlan(FRESH, SIGN_CATALOGUE));
  // render-crops.mjs không đọc cờ learn
  const src = readFileSync(join(TOOLS, 'render-crops.mjs'), 'utf8');
  assert.doesNotMatch(src, /\.learn\b/);
  assert.doesNotMatch(readFileSync(join(TOOLS, 'lib.mjs'), 'utf8').split('export function trainingPlan')[1].split('\n}\n')[0], /\.learn\b/);
});

test('ảnh cắt: tối đa khoảng 5 % biển dưới 18 điểm ảnh, cạnh trong 14–400 (như CLS_MAX_W lúc chạy), lệch khung ±15 %/±10 %', () => {
  assert.deepEqual(CROP_SIZES, { tinyShare: 0.05, tiny: [14, 18], small: [18, 48], smallSplit: 0.58, large: [48, 400] });
  assert.equal(CROP_SIZES.large[1], globalThis.VisionProto.CLS_MAX_W);
  assert.ok(CROP_SIZES.small[0] <= globalThis.VisionProto.CLS_MIN_W);
  assert.deepEqual(BOX_JITTER, { scale: 0.15, shift: 0.1 });
  const R = mulberry32(5);
  let tiny = 0;
  let small = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const w = nativeWidth(R);
    assert.ok(w >= 14 && w <= 400, String(w));
    if (w < 18) tiny++;
    else if (w < 48) small++;
  }
  assert.ok(Math.abs(tiny / N - 0.05) < 0.01, `dưới 18 px: ${tiny / N}`);
  assert.ok(Math.abs(small / N - 0.95 * 0.58) < 0.02, `18–48 px: ${small / N}`);
});

test('ảnh cắt: số ảnh mỗi nhãn, nội dung xác định theo hạt giống', () => {
  const plan = trainingPlan(FRESH, SIGN_CATALOGUE);
  const opt = { perClass: 10, tierA: 30, bgMult: 4, otherMult: 2 };
  const L = freshLabel;
  assert.equal(countFor(L('P.127[50]'), plan, opt), 30);
  assert.equal(countFor(L('P.140'), plan, opt), 10);
  assert.equal(countFor(L('P.127a'), plan, opt), 0); // nhãn trùng hình: không có ảnh riêng
  assert.equal(countFor(L(BACKGROUND), plan, opt), 40);
  assert.equal(countFor(L(OTHER_SIGN), plan, opt), 20);
  assert.equal(SHARD, 2000);
  assert.ok(P_PURE_BG > 0 && P_PURE_BG < 1 && P_PLATE_OTHER > 0 && P_PLATE_OTHER < 1);
  const a = sampleItem(L('P.127[50]'), plan, 42);
  assert.equal(a.svg, sampleItem(L('P.127[50]'), plan, 42).svg);
  assert.match(a.svg, />50</); // đúng trị số của lớp
  assert.equal(sampleItem(L('W.202b'), plan, 1).mirror, true);
  const o = sampleItem(L(OTHER_SIGN), plan, 3);
  assert.equal(o.kind, 'other');
  let pure = 0;
  for (let i = 0; i < 400; i++) if (sampleItem(L(BACKGROUND), plan, i) === null) pure++;
  assert.ok(Math.abs(pure / 400 - P_PURE_BG) < 0.08, String(pure));
});

test('ảnh ghép: hằng số, trọng số họ, mô tả xác định theo hạt giống', () => {
  assert.deepEqual(Object.keys(FAMILY_WEIGHTS), FAMILIES);
  assert.ok(Math.abs(Object.values(FAMILY_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(GROUPS_W.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(GROUPS_W.length, 6); // 1–6 cột biển mỗi ảnh
  assert.equal(P_GEO_B, 0.3);
  assert.deepEqual(SIZE_A, { small: [8, 32], large: [32, 120], pSmall: 0.6 }); // biển 8–120 điểm ảnh
  assert.deepEqual(SIZE_B, [8, 64]);
  assert.equal(SCENE_SHARD, 200);
  assert.ok(P_STACK > 0 && P_PLATE > 0 && P_OTHER > 0 && MAX_DISTRACTORS === 4);
  const s1 = sceneSpec(123);
  assert.deepEqual(sceneSpec(123), s1);
  let geoB = 0;
  let groups = 0;
  for (let i = 0; i < 600; i++) {
    const s = sceneSpec(i);
    if (s.geo === 'B') geoB++;
    assert.ok(s.groups.length >= 1 && s.groups.length <= 6);
    for (const g of s.groups) {
      const [lo, hi] = s.geo === 'B' ? SIZE_B : [SIZE_A.small[0], SIZE_A.large[1]];
      assert.ok(g.size >= lo && g.size <= hi, `${s.geo} ${g.size}`);
      for (const it of g.items) assert.ok(it.family >= -1 && it.family < FAMILIES.length);
      groups++;
    }
  }
  assert.ok(Math.abs(geoB / 600 - P_GEO_B) < 0.06, String(geoB));
  for (let i = 0; i < 600; i++) {
    const s = sceneSpec(i);
    if (s.geo === 'A') assert.deepEqual([s.frame, s.lb], [[640, 352], { dx: 0, dy: 0, dw: 640, dh: 352 }]);
    else assert.deepEqual(s.lb, letterboxB(...s.frame));
  }
  const ev = sceneSpec(7, { geo: 'A', evalWidth: 12 });
  assert.equal(ev.geo, 'A');
  assert.equal(ev.groups.length, 3);
  for (const g of ev.groups) {
    assert.equal(g.size, 12);
    assert.equal(g.items.length, 1);
    assert.ok(g.items[0].family >= 0); // ảnh đánh giá chỉ có biển trong danh mục
  }
});

test('lượt B: ảnh vào có viền đen đúng như passGeometry của runtime, khung hình theo FRAMES_B', () => {
  const V = globalThis.VisionProto;
  assert.ok(Math.abs(FRAMES_B.reduce((a, f) => a + f[2], 0) - 1) < 1e-9);
  assert.deepEqual(FRAMES_B.map((f) => [f[0], f[1]]), [[1920, 1080], [1280, 720], [1080, 1920], [1440, 1080]]);
  for (const [W, H] of [...FRAMES_B, [640, 352], [4000, 3000], [3000, 4000], [1, 1]]) {
    const g = V.passGeometry('B', W, H);
    const lb = letterboxB(W, H);
    assert.deepEqual([lb.dx, lb.dy, lb.dw, lb.dh], g.dst, `${W}×${H}`);
  }
  assert.deepEqual(letterboxB(1920, 1080), { dx: 7, dy: 0, dw: 626, dh: 352 }); // viền 7 điểm ảnh mỗi bên
  assert.deepEqual(letterboxB(1080, 1920), { dx: 221, dy: 0, dw: 198, dh: 352 });
  const n = { 1920: 0, 1280: 0, 1080: 0, 1440: 0 };
  for (let i = 0; i < 3000; i++) n[sceneSpec(i, { geo: 'B' }).frame[0]]++;
  assert.ok(Math.abs(n[1920] / 3000 - 0.65) < 0.04 && n[1080] > 150 && n[1440] > 60, JSON.stringify(n));
  // trang vẽ dùng đúng lb do Node tính, không tự thu nhỏ theo hệ số cố định
  const page = readFileSync(join(TOOLS, 'render-page.js'), 'utf8');
  assert.doesNotMatch(page, /GEO_B_SCALE/);
  assert.match(page, /const \{ dx, dy, dw, dh \} = sc\.lb;/);
  assert.match(page, /fx\.fillStyle = '#000'/);
});

test('hình tự vẽ: other-sign không dùng trị số P.127, họ hợp lệ, SVG không có thẻ lạ', () => {
  for (const n of OTHER_NUMBERS) assert.ok(!P127_VALUES.includes(n), n);
  const R = mulberry32(9);
  const fams = new Set();
  for (let i = 0; i < 300; i++) {
    for (const a of [otherSignSvg(R), plateSvg(R), distractorSvg(R)]) {
      assert.match(a.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.doesNotMatch(a.svg, /<script|<foreignObject|href=/i);
      assert.ok(a.family === null || a.family === undefined || FAMILIES.includes(a.family), String(a.family));
      assert.ok(a.w > 0 && a.h > 0);
    }
    fams.add(otherSignSvg(R).family);
  }
  assert.ok(fams.has(null) && fams.has('ring') && fams.has('bluerect'));
  assert.equal(plateSvg(R).family, 'plate');
  assert.equal(distractorSvg(R).family, null);
});

test('other-sign: không dùng ký hiệu gần giống mã trong danh mục (chữ thập trong tam giác ≈ W.205, …)', () => {
  assert.deepEqual(GLYPH_AVOID, {
    triangle: ['cross', 'hook', 'zigzag', 'circle'], // W.205, W.201a/b, W.202a/b, W.206
    ring: ['hook'], // mũi tên rẽ, quay đầu của P.123*, P.124*
    bluedisc: ['hook', 'circle'], // R.302a/b, R.303
  });
  for (const list of Object.values(GLYPH_AVOID)) for (const g of list) assert.ok(GLYPHS.includes(g), g);
  const R = mulberry32(17);
  const seen = { triangle: new Set(), ring: new Set(), bluedisc: new Set() };
  for (let i = 0; i < 6000; i++) {
    const o = otherSignSvg(R);
    if (!o.glyph || !GLYPH_AVOID[o.family]) continue;
    assert.ok(!GLYPH_AVOID[o.family].includes(o.glyph), `${o.family} + ${o.glyph}`);
    seen[o.family].add(o.glyph);
  }
  // vẫn còn ký hiệu khác cho mỗi loại nền
  for (const [f, set] of Object.entries(seen)) assert.ok(set.size >= 2, `${f}: ${[...set]}`);
});

test('ảnh nền: điểm "giống cảnh đường phố"', () => {
  const veh = new Set(['car', 'bus']);
  const st = (kinds, n, maxArea) => ({ kinds: new Set(kinds), n, maxArea });
  assert.equal(streetScore(st(['car'], 1, 0.7), veh), -1); // ảnh chụp cận một xe
  assert.equal(streetScore(st(['car'], 1, 0.2), veh), 1);
  assert.equal(streetScore(st(['car', 'bus', 'light'], 4, 0.1), veh), 6);
});

// ---------------------------------------------------------------------------------------------
// Tiện ích của bộ công cụ
// ---------------------------------------------------------------------------------------------

test('chia tập theo tác giả: mọi ảnh của một tác giả cùng một tập, không có tác giả thì theo ImageID', () => {
  for (let a = 0; a < 200; a++) {
    const author = `Tác giả ${a}`;
    const sp = new Set(Array.from({ length: 12 }, (_, i) => splitOf(`${a.toString(16)}${i}abcdef0123456`.slice(0, 16), author)));
    assert.equal(sp.size, 1, author);
  }
  const n = { train: 0, val: 0, test: 0 };
  for (let a = 0; a < 20000; a++) n[splitOf('0000000000000000', `a${a}`)]++;
  assert.ok(Math.abs(n.test / 20000 - 0.1) < 0.01, JSON.stringify(n));
  assert.equal(splitOf('fe600639ac5f36c1', ''), splitOf('fe600639ac5f36c1'));
  assert.equal(splitOf('fe600639ac5f36c1', '  '), splitOf('fe600639ac5f36c1'));
  // fetch-backgrounds.mjs chia theo tác giả
  assert.match(readFileSync(join(TOOLS, 'fetch-backgrounds.mjs'), 'utf8'), /splitOf\(c\.id, c\.author\)/);
});

test('chia tập theo ImageID: cố định, tách rời, tỉ lệ gần 80/10/10', () => {
  assert.equal(SPLIT_VAL, 0.1);
  assert.equal(SPLIT_TEST, 0.1);
  const n = { train: 0, val: 0, test: 0 };
  for (let i = 0; i < 20000; i++) n[splitOf(`img${i.toString(16)}`)]++;
  assert.ok(Math.abs(n.val / 20000 - 0.1) < 0.01, JSON.stringify(n));
  assert.ok(Math.abs(n.test / 20000 - 0.1) < 0.01, JSON.stringify(n));
  assert.equal(splitOf('fe600639ac5f36c1'), splitOf('fe600639ac5f36c1'));
});

test('mulberry32 và hash32 cho cùng dãy với cùng hạt giống', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const c = mulberry32(43)();
  assert.notEqual(mulberry32(42)(), c);
  assert.equal(hash32('abc'), hash32('abc'));
  // Chuỗi chỉ khác một ký tự cuối vẫn cho bit cao phân bố đều (cần cho chia tập theo ImageID).
  let high = 0;
  for (let i = 0; i < 4000; i++) high += hash32(`id${i}`) >>> 31;
  assert.ok(Math.abs(high / 4000 - 0.5) < 0.04, String(high));
});

test('CsvParser: ngoặc kép, dấu phẩy và xuống dòng trong trường, đọc theo khúc', () => {
  const rows = [];
  const p = new CsvParser((r) => rows.push(r));
  const text = 'a,b,c\r\n1,"x, ""y""",3\n2,"dòng\nhai",\n"",,"z"\n';
  for (const ch of text) p.push(ch); // từng ký tự một: khúc bị cắt ở mọi chỗ
  p.end();
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, "y"', '3'],
    ['2', 'dòng\nhai', ''],
    ['', '', 'z'],
  ]);
  const last = [];
  const q = new CsvParser((r) => last.push(r));
  q.push('k,v\nx,1');
  q.end();
  assert.deepEqual(last, [['k', 'v'], ['x', '1']]);
});

test('hằng số ảnh nền Open Images', () => {
  assert.equal(OI_LICENSE, 'https://creativecommons.org/licenses/by/2.0/');
  assert.equal(MIN_BG_WIDTH, 1024);
  assert.equal(MAX_BG_WIDTH, 1280);
  assert.equal(OI_SIGN_CLASS, 'Traffic sign');
  assert.deepEqual(OI_SIGN_CLASSES, ['Traffic sign', 'Stop sign']);
  assert.deepEqual([...OI_STREET_CLASSES].sort(), ['Bus', 'Car', 'Motorcycle', 'Street light', 'Traffic light', 'Traffic sign', 'Truck']);
  assert.match(OI_META['validation-labels'], /validation-annotations-human-imagelabels-boxable\.csv$/);
  assert.match(OI_META['test-labels'], /test-annotations-human-imagelabels-boxable\.csv$/);
});

test('ảnh nền: tình trạng biển theo nhãn người kiểm; ảnh đã kiểm xếp trước; thứ tự không theo lúc tải xong', () => {
  assert.equal(signStatus({ present: true, absent: false }, 2), 'present');
  assert.equal(signStatus({ present: true, absent: false }, 0), 'unverified'); // có biển nhưng thiếu hộp
  assert.equal(signStatus({ present: false, absent: true }, 0), 'absent');
  assert.equal(signStatus({ present: false, absent: true }, 1), 'unverified');
  assert.equal(signStatus(undefined, 0), 'unverified');
  assert.equal(signStatus(undefined, 3), 'unverified'); // hộp có sẵn không chứng minh là đủ
  // chỉ ảnh xác nhận không có biển là sạch: ảnh xác nhận có biển vẫn có biển sót hộp
  assert.deepEqual(['present', 'absent', 'unverified'].map(isCleanStatus), [false, true, false]);
  const c = (id, status, score) => ({ id, status, score });
  const ranked = rankCandidates([c('a1', 'unverified', 9), c('b2', 'absent', 1), c('c3', 'present', 2), c('d4', 'unverified', 3)], 1);
  assert.deepEqual(ranked.map((x) => x.id).slice(0, 2).sort(), ['b2', 'c3']);
  assert.deepEqual(ranked.map((x) => x.id).slice(2), ['a1', 'd4']);
  const batch = ['x', 'y', 'z', 'w'].map((id) => ({ id }));
  const jobs = [{ id: 'z' }, { id: 'x' }, { id: 'w' }, { id: 'y' }]; // thứ tự tải xong
  assert.deepEqual(orderByRank(jobs, batch).map((j) => j.id), ['x', 'y', 'z', 'w']);
  assert.ok(STATE_VERSION >= 2);
});

test('ảnh nền: backgroundsFor xếp theo ImageID dù index.json ghi theo thứ tự nào', () => {
  const d = tmp('bg');
  try {
    const im = (id, split, status) => ({ id, split, w: 1024, h: 700, status, ignore: [[0.1, 0.1, 0.2, 0.2]] });
    const write = (images) => writeFileSync(join(d, 'index.json'), JSON.stringify({ images }));
    write([im('ffff000000000000', 'train', 'unverified'), im('0000aaaa00000000', 'train', 'absent'), im('1234567890abcdef', 'val', 'present')]);
    const a = backgroundsFor(d, 'train');
    write([im('0000aaaa00000000', 'train', 'absent'), im('1234567890abcdef', 'val', 'present'), im('ffff000000000000', 'train', 'unverified')]);
    assert.deepEqual(backgroundsFor(d, 'train'), a);
    assert.deepEqual(a.map((b) => [b.id, b.clean]), [['0000aaaa00000000', true], ['ffff000000000000', false]]);
    assert.equal(backgroundsFor(d, 'val')[0].clean, false); // 'present'
    assert.deepEqual(a[0].ignore, [[0.1, 0.1, 0.2, 0.2]]);
    assert.deepEqual(backgroundsFor('', 'train'), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('ghi công Open Images: có tên ảnh, trang gốc và ghi chú đã sửa đổi (CC BY 2.0 §4(b))', () => {
  assert.equal(ATTRIBUTION_HEADER, 'ImageID,Title,Author,AuthorProfileURL,License,OriginalURL,OriginalLandingURL,Changes');
  assert.match(CHANGES_NOTE, /[Cc]ropped/);
  assert.match(CHANGES_NOTE, /not distributed/);
  const csv = attributionCsv([{ id: 'fe600639ac5f36c1', title: 'Phố "cổ", Hà Nội', author: 'A, B', authorUrl: 'https://u',
    license: OI_LICENSE, url: 'https://o', landingUrl: 'https://l' }]);
  const rows = [];
  const p = new CsvParser((r) => rows.push(r));
  p.push(csv);
  p.end();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['fe600639ac5f36c1', 'Phố "cổ", Hà Nội', 'A, B', 'https://u', OI_LICENSE, 'https://o', 'https://l', CHANGES_NOTE]);
});

test('parseArgs ép kiểu theo giá trị mặc định', () => {
  const a = parseArgs(['--count', '12', '--out', '/x', '--dry-run', '--per-class', '5'], { count: 1, out: '', dryRun: false, perClass: 0 });
  assert.deepEqual(a, { count: 12, out: '/x', dryRun: true, perClass: 5 });
  assert.throws(() => parseArgs(['x']), /tham số lạ/);
});

test('wheelFits: chỉ nhận wheel Linux x86_64 cho CPython 3.11–3.13 hoặc wheel thuần Python', () => {
  assert.equal(wheelFits('six-1.17.0-py2.py3-none-any.whl'), true);
  assert.equal(wheelFits('numpy-2.5.5-cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl'), true);
  assert.equal(wheelFits('protobuf-7.36.2-cp310-abi3-manylinux2014_x86_64.whl'), true);
  assert.equal(wheelFits('numpy-2.5.5-cp313-cp313-win_amd64.whl'), false);
  assert.equal(wheelFits('numpy-2.5.5-cp313-cp313-manylinux_2_27_aarch64.whl'), false);
  assert.equal(wheelFits('numpy-2.5.5-cp39-cp39-manylinux_2_27_x86_64.whl'), false);
  assert.equal(wheelFits('numpy-2.5.5.tar.gz'), false);
});

// ---------------------------------------------------------------------------------------------
// Tệp mô hình đã sinh (chỉ kiểm khi có)
// ---------------------------------------------------------------------------------------------

test('models/SHA256SUMS (nếu có): mọi tệp liệt kê đều khớp', () => {
  const sums = join(MODELS, 'SHA256SUMS');
  if (!existsSync(sums)) return;
  const lines = readFileSync(sums, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    assert.ok(m, `dòng sai dạng: ${line}`);
    const p = join(MODELS, m[2]);
    assert.ok(resolve(p).startsWith(MODELS + '/'), `đường dẫn ra ngoài models/: ${m[2]}`);
    assert.ok(existsSync(p), `thiếu ${m[2]}`);
    assert.equal(sha256(p), m[1], m[2]);
  }
});

test('js/mlmanifest.js (nếu có): mục khai báo khớp tệp trên đĩa, mô hình có mặt thì phải được khai báo', async () => {
  const path = join(ROOT, 'js', 'mlmanifest.js');
  if (!existsSync(path)) return;
  const { ML_MANIFEST } = await import(pathToFileURL(path).href);
  assert.ok(Number.isInteger(ML_MANIFEST.version));
  for (const [rel, info] of Object.entries(ML_MANIFEST.files)) {
    assert.ok(!rel.startsWith('/') && !rel.includes('..'), rel);
    const p = join(ROOT, rel);
    assert.ok(existsSync(p), `mlmanifest khai báo tệp không có: ${rel}`);
    assert.equal(statSync(p).size, info.size, `${rel}: kích thước`);
    assert.equal(sha256(p), info.sha256, `${rel}: sha256`);
  }
  for (const rel of ['models/labels.json', 'models/sign-det.int8.tflite', 'models/sign-cls.int8.tflite'])
    if (existsSync(join(ROOT, rel))) assert.ok(ML_MANIFEST.files[rel], `${rel} có trên đĩa nhưng thiếu trong mlmanifest`);
});

// ---------------------------------------------------------------------------------------------
// Hằng số của các bước Python và của trang vẽ (không chạy được trong Node: đọc mã nguồn)
// ---------------------------------------------------------------------------------------------

/** Hằng số cấp tệp `TÊN = giá trị  # chú thích` (Python) hoặc `const TÊN = giá trị; // chú thích` (JS). */
function constantsOf(file) {
  const lines = readFileSync(join(TOOLS, file), 'utf8').split('\n');
  const py = file.endsWith('.py');
  const re = py ? /^([A-Z][A-Z0-9_]*(?:, *[A-Z][A-Z0-9_]*)*) *= *(.+?)(?: +#.*)?$/ : /^const ([A-Z][A-Z0-9_]*(?:, *[A-Z][A-Z0-9_]*)*) *= *(.+?);?(?: *\/\/.*)?$/;
  const out = {};
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    const commented = /(#|\/\/)/.test(line.slice(m[1].length)) || /^\s*(#|\/\/)/.test(lines[i - 1] || '');
    let names = m[1].split(/, */);
    let rhs = m[2].replace(/;$/, '').trim();
    let vals;
    if (!py && /, *[A-Z][A-Z0-9_]* *=/.test(rhs)) {
      // const A = 1, B = 2;
      const parts = `${names[0]} = ${rhs}`.split(/, *(?=[A-Z][A-Z0-9_]* *=)/);
      names = parts.map((x) => x.split('=')[0].trim());
      vals = parts.map((x) => x.split('=').slice(1).join('=').trim());
    } else vals = names.length > 1 ? rhs.split(/, *(?![^(\[]*[)\]])/) : [rhs];
    names.forEach((n, k) => (out[n] = { raw: vals[k].trim(), commented }));
  });
  return out;
}
const num = (raw) => {
  const r = raw.replace(/^float\(np\.log\((.+)\)\)$/, 'Math.log($1)').replace(/_/g, '').replace(/\(/g, '[').replace(/\)/g, ']');
  return /^Math\.log/.test(r) ? Math.log(Number(r.slice(9, -1))) : JSON.parse(r.replace(/\b(\d+)e(-?\d+)\b/g, '$1e$2'));
};
const isNumeric = (raw) => /^(-?[\d.]|\(|\[-?\d|float\(np\.log|2 \* DET_W)/.test(raw);

// Giá trị mong đợi của mọi ngưỡng/hằng số số học trong các tệp này (thêm hằng số mới thì phải thêm vào đây).
const EXPECTED_CONSTANTS = {
  'bdcommon.py': {
    DET_H: 352, DET_W: 640, STRIDE: 8, CLS_SIZE: 48, LOG_SIZE_MIN: Math.log(4), LOG_SIZE_MAX: Math.log(400),
    PEAK_THRESHOLD: 0.3, MAX_CANDIDATES: 64, MAX_BOX_SIDE: '2 * DET_W', MAX_BOXES: 12, NMS_IOU: 0.5, ECE_BINS: 15,
    BN_MOMENTUM: 0.99, HEAT_PRIOR_BIAS: -2.19, IGNORE_PAD: 2, NEG_W_UNVERIFIED: 0.25, SYNTH_PAD: 4,
  },
  'eval_synthetic.py': {
    GATE_TOP1: 0.97, GATE_MIN_WIDTH: 24, GATE_Z: 1.645, GATE_MIN_N: 100, PRUNE_MAX: 5, CLS_WIDTHS: [20, 24, 32, 48],
    DET_WIDTHS: [8, 10, 12, 16, 20], ACCEPT_P: 0.85, MATCH_CENTRE: 0.5, MATCH_MIN_PX: 3, MATCH_SIZE: [0.5, 2],
    EXIT_TOO_FEW: 2, EXIT_TOO_MANY: 4,
  },
  'train_detector.py': {
    CROP: 320, SCALE_JITTER: [0.85, 1.2], LR_PEAK: 2e-3, WARMUP_STEPS: 300, WEIGHT_DECAY: 4e-5, SIZE_W: 1, OFF_W: 1,
    FOCAL_ALPHA: 2, FOCAL_BETA: 4, MIN_VISIBLE: 0.5, VAL_MAX: 400, LOG_EVERY: 50, PREFETCH: 6,
  },
  'train_classifier.py': { PATIENCE: 6, LR_PEAK: 2e-3, WARMUP_EPOCHS: 1, WEIGHT_DECAY: 1e-4, REJECT_WEIGHT: 1.5, SHIFT_PX: 2 },
  'export.py': { REP_CLS: 300, REP_DET: 120, GOLDEN_CLS: 20, GOLDEN_DET: 4, GOLDEN_SEED: 7, TOL_STEPS: 2 },
  'calibrate.py': { T_MIN: 0.25, T_MAX: 10 },
  'sanitize_images.py': { MAX_PIXELS: 40000000, JPEG_QUALITY: 92 },
  'render-page.js': {
    OUT: 48, MARGIN: 0.15, HI_RES: 160, CONTEXT: 2.3, P_PHOTO_BG: 0.8, P_POLE: 0.55, P_OCCLUDE: 0.25, P_NIGHT: 0.15,
    P_BACKLIGHT: 0.08, P_BLUR: 0.6, P_MOTION: 0.35, P_JPEG: 0.5, JPEG_Q: [0.55, 0.95], BG_TRIES: 6, CROP_VIEW: 1.8,
    BG_IGNORE_PAD: 0.15, SCENE_W: 640, SCENE_H: 352, MIN_LABEL_PX: 5, MIN_VISIBLE: 0.6,
  },
};

test('hằng số Python và trang vẽ: đúng giá trị, có chú thích, không thiếu trong bảng kiểm', () => {
  for (const [file, want] of Object.entries(EXPECTED_CONSTANTS)) {
    const got = constantsOf(file);
    for (const [name, v] of Object.entries(want)) {
      assert.ok(got[name], `${file}: thiếu ${name}`);
      if (typeof v === 'string') assert.equal(got[name].raw, v, `${file}: ${name}`);
      else if (typeof v === 'number') assert.ok(Math.abs(num(got[name].raw) - v) < 1e-12, `${file}: ${name} = ${got[name].raw}`);
      else assert.deepEqual(num(got[name].raw), v, `${file}: ${name}`);
      assert.ok(got[name].commented, `${file}: ${name} cần chú thích ngắn`);
    }
    for (const [name, { raw }] of Object.entries(got))
      if (isNumeric(raw)) assert.ok(Object.hasOwn(want, name), `${file}: hằng số mới ${name} = ${raw} chưa có trong EXPECTED_CONSTANTS`);
  }
});

test('hằng số khớp giữa huấn luyện, đánh giá và runtime (js/visionproto.js, hợp đồng 2–3, PLAN §5.2, §8.4)', () => {
  const V = globalThis.VisionProto;
  const B = EXPECTED_CONSTANTS['bdcommon.py'];
  assert.equal(B.PEAK_THRESHOLD, V.SCORE_MIN);
  assert.equal(B.NMS_IOU, V.NMS_IOU);
  assert.equal(B.MAX_BOXES, V.MAX_BOXES);
  assert.equal(B.MAX_CANDIDATES, V.MAX_CANDIDATES);
  assert.equal(2 * B.DET_W, V.MAX_BOX_SIDE);
  assert.deepEqual([B.DET_H, B.DET_W, B.STRIDE, B.CLS_SIZE], [V.DET_H, V.DET_W, V.STRIDE, V.CLS_SIZE]);
  assert.deepEqual([B.DET_H, B.DET_W], [DET_INPUT[0], DET_INPUT[1]]);
  assert.ok(Math.exp(B.LOG_SIZE_MAX) <= V.MAX_BOX_SIDE && Math.exp(B.LOG_SIZE_MIN) >= 1);
  const P = EXPECTED_CONSTANTS['render-page.js'];
  assert.equal(P.MARGIN, V.CROP_MARGIN);
  assert.equal(P.MARGIN, CLS_MARGIN);
  assert.equal(P.OUT, V.CLS_SIZE);
  assert.deepEqual([P.SCENE_W, P.SCENE_H], [V.DET_W, V.DET_H]);
  assert.equal(V.FAMILIES, FAMILIES.length);
  // bộ giải mã Python dùng đúng các hằng số này (không ghi số trực tiếp)
  const src = readFileSync(join(TOOLS, 'bdcommon.py'), 'utf8');
  assert.match(src, /def decode\(heat, reg, thr=PEAK_THRESHOLD, max_boxes=MAX_BOXES, nms_iou=NMS_IOU, stride=STRIDE,\s+max_cand=MAX_CANDIDATES\)/);
  assert.match(src, /_iou\(c, o\) <= nms_iou/); // như runtime: bỏ khi IoU > ngưỡng
  // bước selftest của train-all chạy kiểm thử Python (khớp bộ giải mã với runtime bằng chính visionproto.js)
  assert.match(readFileSync(join(TOOLS, 'train-all.sh'), 'utf8'), /step selftest "\$PY" -I -B -m unittest discover -s "\$HERE" -p 'test_\*\.py'/);
  assert.ok(existsSync(join(TOOLS, 'test_pipeline.py')));
});

test('MODEL_CARD viết số kiểu Việt Nam: eval_synthetic.py không dùng định dạng số tiếng Anh', () => {
  const all = readFileSync(join(TOOLS, 'eval_synthetic.py'), 'utf8');
  assert.match(all, /def vn_int\(n\)/);
  // bỏ phần định nghĩa vn_int/vn_num/vn_pct (chúng dùng định dạng của Python rồi đổi dấu)
  const src = all.slice(all.indexOf('# ------------------------------------------------------------------------------------------------ ngưỡng E1'));
  assert.ok(src.length > 1000);
  assert.doesNotMatch(src, /\{[^{}]*:,\}/, 'dùng vn_int() thay cho :,');
  assert.doesNotMatch(src, /\{[^{}]*:\.\d+%\}/, 'dùng vn_pct() thay cho :.0%');
  assert.doesNotMatch(src, /\{[^{}]*:\.\d+f\}/, 'dùng vn_num() thay cho :.2f');
});

test('chữ tiếng Việt trong bộ công cụ không viết HOA toàn bộ', () => {
  for (const f of ['train-all.sh', 'steps.sh', 'install-models.mjs', 'eval_synthetic.py', 'export.py', 'fetch-backgrounds.mjs',
    'render-crops.mjs', 'render-scenes.mjs', 'calibrate.py', 'train_classifier.py', 'train_detector.py', 'README.md']) {
    const text = readFileSync(join(TOOLS, f), 'utf8');
    const caps = (text.match(/\p{Lu}{2,}/gu) || []).filter((w) => /[^\x00-\x7f]/.test(w) && w !== 'Đ');
    assert.deepEqual(caps, [], f);
  }
});

// ---------------------------------------------------------------------------------------------
// Ngưỡng E1 và số ảnh testw
// ---------------------------------------------------------------------------------------------

test('train-all: đủ ảnh testw cho nhãn được học để ngưỡng E1 có nghĩa; gỡ nhãn có giới hạn', () => {
  const sh = readFileSync(join(TOOLS, 'train-all.sh'), 'utf8');
  const def = (name) => Number(new RegExp(`${name}="\\$\\{${name}:-(\\d+)\\}"`).exec(sh)?.[1]);
  const E = EXPECTED_CONSTANTS['eval_synthetic.py'];
  assert.ok(def('BD_TESTW_TIER_A') >= 2 * E.GATE_MIN_N, String(def('BD_TESTW_TIER_A')));
  assert.equal(def('BD_PRUNE_MAX'), E.PRUNE_MAX);
  assert.match(sh, /crops --split test --per-class "\$BD_TESTW_PER_CLASS" --tier-a "\$BD_TESTW_TIER_A" --widths 20,24,32,48/);
  assert.match(sh, /--prune --prune-max "\$BD_PRUNE_MAX"/);
});

// ---------------------------------------------------------------------------------------------
// Thư mục chờ, cài đặt, nguồn gốc bản dựng
// ---------------------------------------------------------------------------------------------

test('train-all: mọi bước ghi vào thư mục chờ, models/ chỉ đổi ở bước install', () => {
  const sh = readFileSync(join(TOOLS, 'train-all.sh'), 'utf8');
  assert.match(sh, /STAGE="\$CACHE\/models-staging"/);
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l));
  const usesOut = code.filter((l) => /\$OUT\b/.test(l) && !/^OUT=/.test(l) && !/^note /.test(l.trim()));
  assert.deepEqual(usesOut.map((l) => l.trim().split(' ').slice(0, 2).join(' ')), ['always install'], usesOut.join('\n'));
  assert.match(sh, /always install node "\$HERE\/install-models\.mjs" --from "\$STAGE" --to "\$OUT"/);
  for (const step of ['labels', 'calibrate', 'export', 'eval-p']) {
    const line = code.find((l) => l.startsWith(`step ${step}`) || l.startsWith(`step "${step}`));
    assert.ok(line, step);
  }
  assert.match(sh, /--out "\$STAGE\/labels\.json"/);
  assert.match(sh, /--labels "\$STAGE\/labels\.json"/);
  assert.match(sh, /--out "\$STAGE\/MODEL_CARD\.md"/);
  // export.py không ghi thẳng vào models/ và không tự gọi write-manifest
  const ex = readFileSync(join(TOOLS, 'export.py'), 'utf8');
  assert.doesNotMatch(ex, /write-manifest/);
  assert.match(ex, /--out phải là thư mục chờ/);
});

/** Một thư mục chờ hợp lệ nhỏ (tệp mô hình giả). */
function fakeStage(dir, { background = 'procedural' } = {}) {
  mkdirSync(join(dir, 'golden'), { recursive: true });
  const files = {
    'labels.json': '{}\n', 'sign-det.int8.tflite': 'det', 'sign-cls.int8.tflite': 'cls', 'MODEL_CARD.md': '# x\n',
    'golden/index.json': JSON.stringify({ version: 1, background }), 'golden/cls-00.png': 'png',
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  const sums = Object.keys(files).sort().map((f) => `${createHash('sha256').update(files[f]).digest('hex')}  ${f}`);
  writeFileSync(join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
}

test('install-models: kiểm thư mục chờ (đủ tệp, khớp SHA256SUMS, không tệp lạ, cặp mẫu nền thủ tục)', () => {
  assert.deepEqual([...REQUIRED_FILES].sort(), ['MODEL_CARD.md', 'SHA256SUMS', 'golden/index.json', 'labels.json', 'sign-cls.int8.tflite', 'sign-det.int8.tflite']);
  const d = tmp('stage');
  try {
    const st = join(d, 'stage');
    fakeStage(st);
    assert.deepEqual(checkStage(st), []);
    writeFileSync(join(st, 'stray.txt'), 'x');
    assert.match(checkStage(st).join('\n'), /không có trong SHA256SUMS: stray\.txt/);
    rmSync(join(st, 'stray.txt'));
    writeFileSync(join(st, 'sign-det.int8.tflite'), 'other');
    assert.match(checkStage(st).join('\n'), /sai SHA-256: sign-det\.int8\.tflite/);
    rmSync(st, { recursive: true });
    fakeStage(st, { background: 'photo' });
    assert.match(checkStage(st).join('\n'), /nền vẽ thủ tục/);
    rmSync(join(st, 'MODEL_CARD.md'));
    assert.deepEqual(checkStage(st), ['thiếu MODEL_CARD.md']);
    assert.throws(() => parseSums(`${'a'.repeat(64)}  ../x\n`), /đường dẫn lạ/);
    assert.throws(() => parseSums('xyz  labels.json\n'), /sai dạng/);
    assert.deepEqual(parseSums(`${'b'.repeat(64)}  golden/a.png\n`), [{ sha: 'b'.repeat(64), path: 'golden/a.png' }]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('install-models: đổi chỗ cả thư mục và trả lại được như cũ', () => {
  const d = tmp('swap');
  try {
    const st = join(d, 'stage');
    const to = join(d, 'models');
    fakeStage(st);
    mkdirSync(to);
    writeFileSync(join(to, 'labels.json'), 'old');
    const old = swapIn(st, to);
    assert.equal(readFileSync(join(to, 'labels.json'), 'utf8'), '{}\n');
    assert.equal(readFileSync(join(old, 'labels.json'), 'utf8'), 'old');
    assert.ok(existsSync(join(st, 'labels.json')), 'thư mục chờ giữ nguyên');
    swapBack(to, old);
    assert.equal(readFileSync(join(to, 'labels.json'), 'utf8'), 'old');
    assert.ok(!existsSync(`${to}.old`) && !existsSync(`${to}.new`));
    // cài vào thư mục không phải models/ của ứng dụng: chỉ chép, không chạy kiểm thử
    const r = spawnSync(process.execPath, [join(TOOLS, 'install-models.mjs'), '--from', st, '--to', join(d, 'out')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(d, 'out', 'MODEL_CARD.md'), 'utf8'), '# x\n');
    const bad = spawnSync(process.execPath, [join(TOOLS, 'install-models.mjs'), '--from', join(d, 'none'), '--to', join(d, 'out2')], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.ok(!existsSync(join(d, 'out2')));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('nguồn gốc bản dựng: commit, có thay đổi chưa commit, SHA-256 mã nguồn, dấu hình vẽ', () => {
  for (const f of TRAINING_SOURCES) assert.ok(existsSync(join(ROOT, f)), f);
  const calls = [];
  const run = (args) => {
    calls.push(args.slice(2).join(' '));
    if (args.includes('rev-parse')) return 'abc123\n';
    return ' M js/signart.js\n?? tools/camera/x.mjs\n';
  };
  const p = provenance({ catalogue: SIGN_CATALOGUE, run });
  assert.equal(p.gitCommit, 'abc123');
  assert.equal(p.gitDirty, true);
  assert.deepEqual(p.gitChanged, ['js/signart.js', 'tools/camera/x.mjs']);
  assert.deepEqual(calls, ['rev-parse HEAD', 'status --porcelain -- .']);
  assert.equal(p.sources['js/signart.js'], sha256(join(ROOT, 'js', 'signart.js')));
  assert.equal(Object.keys(p.sources).length, TRAINING_SOURCES.length);
  const clean = provenance({ catalogue: SIGN_CATALOGUE, run: (a) => (a.includes('rev-parse') ? 'abc\n' : '') });
  assert.equal(clean.gitDirty, false);
  const nogit = provenance({ catalogue: SIGN_CATALOGUE, run: () => { throw new Error('no git'); } });
  assert.equal(nogit.gitCommit, null);
  assert.equal(nogit.gitDirty, null);
  assert.ok(PROVENANCE_MAX_CHANGED >= 10);
  // dấu hình vẽ: đổi theo hình (art) và signart.js, không theo tên hay câu đọc
  const art = readFileSync(join(ROOT, 'js', 'signart.js'), 'utf8');
  const d0 = artDigest(SIGN_CATALOGUE, art);
  assert.equal(p.artDigest, d0);
  assert.notEqual(artDigest(SIGN_CATALOGUE, art + ' '), d0);
  const renamed = { ...SIGN_CATALOGUE, 'P.101': { ...SIGN_CATALOGUE['P.101'], name: 'khác' } };
  assert.equal(artDigest(renamed, art), d0);
  const redrawn = { ...SIGN_CATALOGUE, 'P.101': { ...SIGN_CATALOGUE['P.101'], art: { shape: 'prohibit', pict: 'car' } } };
  assert.notEqual(artDigest(redrawn, art), d0);
});

test('models/labels.json (sau lần dựng thật): có nguồn gốc và được huấn luyện từ đúng hình vẽ hiện tại', () => {
  const prov = labelsJson.build?.provenance;
  if (!prov) return; // chỉ có labels.json của labels.mjs (chưa huấn luyện)
  assert.equal(typeof labelsJson.build.gitDirty === 'boolean' || labelsJson.build.gitDirty === null, true);
  assert.match(prov.artDigest, /^[0-9a-f]{64}$/);
  for (const f of TRAINING_SOURCES) assert.ok(Object.hasOwn(prov.sources, f), f);
  assert.equal(prov.artDigest, artDigest(SIGN_CATALOGUE, readFileSync(join(ROOT, 'js', 'signart.js'), 'utf8')),
    'hình vẽ biển (js/signart.js hoặc art trong js/signs.js) đã đổi sau khi huấn luyện: cần chạy lại tools/camera/train-all.sh');
});

test('models/golden (nếu có): chỉ nền vẽ thủ tục, không ảnh chụp nào', () => {
  const p = join(MODELS, 'golden', 'index.json');
  if (!existsSync(p)) return;
  const g = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(g.background, 'procedural');
  assert.ok(!existsSync(join(MODELS, 'golden', 'ATTRIBUTION-openimages.csv')));
});

// ---------------------------------------------------------------------------------------------
// Dừng train-all.sh giữa chừng (steps.sh)
// ---------------------------------------------------------------------------------------------

test('steps.sh: SIGTERM dừng cả bước đang chạy và tiến trình con cháu, nhả khoá, chạy lại làm tiếp', { timeout: 30_000 }, async () => {
  const d = tmp('steps');
  try {
    const pidFile = join(d, 'grandchild.pid');
    const script = join(d, 'run.sh');
    writeFileSync(script, [
      'set -euo pipefail',
      `CACHE=${JSON.stringify(d)}`,
      'mkdir -p "$CACHE/done" "$CACHE/logs"',
      'exec 9>"$CACHE/lock"',
      'flock -n 9 || exit 7',
      'STOP_WAIT_S=10',
      `source ${JSON.stringify(join(TOOLS, 'steps.sh'))}`,
      'slow() { sleep 60 & echo $! > "$1"; wait; }',
      'step quick true',
      `step slow slow ${JSON.stringify(pidFile)}`,
      'step after true',
    ].join('\n'));
    const child = spawn('bash', [script], { stdio: 'ignore' });
    const exited = new Promise((ok) => child.on('exit', (code, sig) => ok({ code, sig })));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const gpid = Number(readFileSync(pidFile, 'utf8'));
    process.kill(gpid, 0); // đang chạy
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 143);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(gpid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'tiến trình cháu còn chạy (mồ côi)');
    assert.ok(existsSync(join(d, 'done', 'quick')));
    assert.ok(!existsSync(join(d, 'done', 'slow')));
    const log = readFileSync(join(d, 'logs', 'train-all.log'), 'utf8');
    assert.match(log, /nhận tín hiệu TERM/);
    // khoá đã nhả: chạy lại được (bước slow giờ xong nhanh)
    writeFileSync(script, readFileSync(script, 'utf8').replace('slow() { sleep 60 &', 'slow() { sleep 0 &'));
    const again = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(readFileSync(join(d, 'logs', 'train-all.log'), 'utf8'), /bỏ qua quick \(đã xong\)[\s\S]*xong slow[\s\S]*xong after/);
    // bước hỏng: thông báo viết thường, không chữ hoa toàn bộ
    writeFileSync(script, readFileSync(script, 'utf8').replace('step after true', 'step broken false'));
    const fail = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(readFileSync(join(d, 'logs', 'train-all.log'), 'utf8'), /Lỗi ở broken \(mã 1\)/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
