// Dữ liệu cho bộ dò: ảnh ghép 640×352 trên nền ảnh đường phố thật, 1–6 cột biển mỗi ảnh (biển cỡ 8–120 điểm
// ảnh, có cột xếp 2–3 biển, có biển phụ bên dưới, có "other-sign"), cùng vật gây nhiễu (biển hiệu cửa hàng có
// chữ tiếng Việt, mảng màu, cột sọc, thùng cảnh báo, mặt sau biển). Hộp "Traffic sign"/"Stop sign" có sẵn của Open Images
// thành vùng bỏ qua (không tính lỗi). Hai kiểu hình học như lúc chạy (passGeometry của js/visionproto.js):
// A = cắt 640×352 đúng độ phân giải camera; B = cả khung hình camera (FRAMES_B: 1920×1080, 1280×720, dọc
// 1080×1920, 4:3) thu nhỏ cho vừa 640×352 rồi thêm viền đen (1920×1080 → 626×352, viền 7 điểm ảnh mỗi bên).
//
//   node tools/camera/render-scenes.mjs --bg $BANDUONG_CACHE/bg --out $BANDUONG_CACHE/scenes --split train \
//        --count 12000 --procs 4 --seed 2
//   node tools/camera/render-scenes.mjs ... --split test --eval-widths 8,10,12,16,20 --geo A --count 300
//
// Định dạng (xem README): ảnh JPEG ở <out>/img/<tên>-<phân đoạn>-<số>.jpg; nhãn của phân đoạn ở
// <out>/<tên>-<phân đoạn>.json = [{ f, geo, frame, boxes: [[x, y, w, h, họ]], ignore: [[x, y, w, h]],
// synth: [[x, y, w, h]], bg, bgClean }] (điểm ảnh của ảnh 640×352, họ là chỉ số trong FAMILIES; synth là mọi vật
// tự vẽ; bg là ImageID của ảnh nền hoặc null; bgClean = nền vẽ thủ tục hoặc ảnh người kiểm xác nhận không có biển).
// Tên = tập, "<tập>-eval<A|B>" với --eval-widths, hoặc --name. --bg rỗng: chỉ nền vẽ thủ tục (dùng cho golden).

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGN_CATALOGUE } from '../../js/signs.js';
import { signSvg } from '../../js/signart.js';
import {
  FAMILIES,
  mulberry32,
  parseArgs,
  seedOf,
  SHAPE_FAMILY,
  SPLIT_SEED_OFFSET,
  valuePool,
  writeFileAtomic,
} from './lib.mjs';
import { backgroundsFor, runQueue, withPages } from './render-common.mjs';
import { distractorSvg, otherSignSvg, plateSvg, toDataUrl } from './synth-art.mjs';

export const SCENE_SHARD = 200; // số ảnh mỗi phân đoạn
const BATCH = 20; // số ảnh mỗi lần gọi vào trang
const BG_PER_BATCH = 12;
export const P_GEO_B = 0.3; // tỉ lệ ảnh kiểu lượt B khi huấn luyện
export const GROUPS_W = [0.3, 0.27, 0.18, 0.12, 0.08, 0.05]; // xác suất có 1…6 cột biển
export const P_STACK = 0.2; // cột có 2–3 biển xếp dọc
export const P_PLATE = 0.18; // biển phụ dưới biển cuối của cột
export const P_OTHER = 0.12; // biển không có trong danh mục
export const SIZE_A = { small: [8, 32], large: [32, 120], pSmall: 0.6 }; // cạnh biển ở ảnh vào bộ dò, lượt A
export const SIZE_B = [8, 64]; // lượt B (ứng với 24–192 điểm ảnh ở khung thật)
export const MAX_DISTRACTORS = 4;
// Khung hình camera của lượt B: [rộng, cao, xác suất]. js/camera.js xin 1920×1080, nới về 1280×720; điện thoại
// dựng dọc cho 1080×1920; vài camera chỉ có 4:3.
export const FRAMES_B = Object.freeze([
  [1920, 1080, 0.65],
  [1280, 720, 0.2],
  [1080, 1920, 0.1],
  [1440, 1080, 0.05],
]);
export const SCENE_W = 640; // ảnh vào bộ dò (hợp đồng 2)
export const SCENE_H = 352;

/**
 * Chỗ của khung hình FW×FH trong ảnh vào 640×352 cho lượt B: thu nhỏ giữ tỉ lệ cho vừa, đặt giữa, phần còn lại
 * đen. Đúng công thức của passGeometry('B') trong js/visionproto.js (tests/models.test.mjs so hai bên).
 */
export function letterboxB(FW, FH) {
  const s = Math.min(SCENE_W / FW, SCENE_H / FH);
  const dw = Math.min(SCENE_W, Math.max(1, Math.round(FW * s)));
  const dh = Math.min(SCENE_H, Math.max(1, Math.round(FH * s)));
  return { dx: Math.floor((SCENE_W - dw) / 2), dy: Math.floor((SCENE_H - dh) / 2), dw, dh };
}
const LB_A = Object.freeze({ dx: 0, dy: 0, dw: SCENE_W, dh: SCENE_H }); // lượt A: ô cắt đúng độ phân giải
// Trọng số chọn họ biển (cân bằng giữa họ nhiều mã và họ chỉ có một mã như biển dừng).
export const FAMILY_WEIGHTS = Object.freeze({
  ring: 0.24, noentry: 0.05, bluering: 0.06, end: 0.06, triangle: 0.22, invtriangle: 0.05, octagon: 0.05,
  bluedisc: 0.1, bluerect: 0.1, diamond: 0.04, plate: 0.03,
});

const CODES_BY_FAMILY = (() => {
  const m = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const e of Object.values(SIGN_CATALOGUE)) m[SHAPE_FAMILY[e.art.shape]].push(e.code);
  return m;
})();

function weighted(R, entries) {
  const tot = entries.reduce((a, [, w]) => a + w, 0);
  let u = R() * tot;
  for (const [k, w] of entries) if ((u -= w) < 0) return k;
  return entries[entries.length - 1][0];
}

/** Một biển trong danh mục (họ cân bằng), trị số ngẫu nhiên nếu có. */
function catalogueItem(R) {
  const fam = weighted(R, Object.entries(FAMILY_WEIGHTS));
  const codes = CODES_BY_FAMILY[fam];
  const code = codes[Math.floor(R() * codes.length)];
  const e = SIGN_CATALOGUE[code];
  const pool = valuePool(code, e.art);
  const value = pool ? pool[Math.floor(R() * pool.length)] : null;
  return { svg: signSvg(e.art, { size: 256, value }), w: 100, h: 100, mirror: false, family: FAMILIES.indexOf(fam), code };
}

/** Mô tả một ảnh (xác định hoàn toàn bởi hạt giống); trang vẽ theo mô tả này. */
export function sceneSpec(seed, { geo = null, evalWidth = null } = {}) {
  const R = mulberry32(seed);
  const L = (a, b) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * R());
  const g = geo || (R() < P_GEO_B ? 'B' : 'A');
  let frame = [SCENE_W, SCENE_H];
  if (g === 'B') {
    const fi = Number(weighted(R, FRAMES_B.map(([, , p], i) => [i, p])));
    frame = [FRAMES_B[fi][0], FRAMES_B[fi][1]];
  }
  const lb = g === 'B' ? letterboxB(frame[0], frame[1]) : { ...LB_A };
  const nGroups = evalWidth ? 3 : 1 + Number(weighted(R, GROUPS_W.map((w, i) => [i, w])));
  const groups = [];
  for (let i = 0; i < nGroups; i++) {
    let size;
    if (evalWidth) size = evalWidth;
    else if (g === 'B') size = L(SIZE_B[0], SIZE_B[1]);
    else size = R() < SIZE_A.pSmall ? L(SIZE_A.small[0], SIZE_A.small[1]) : L(SIZE_A.large[0], SIZE_A.large[1]);
    const n = !evalWidth && R() < P_STACK ? 2 + (R() < 0.3 ? 1 : 0) : 1;
    const items = [];
    for (let j = 0; j < n; j++) {
      if (!evalWidth && R() < P_OTHER) {
        const o = otherSignSvg(R);
        items.push({ svg: o.svg, w: o.w, h: o.h, mirror: false, family: o.family ? FAMILIES.indexOf(o.family) : -1 });
      } else items.push(catalogueItem(R));
    }
    if (!evalWidth && R() < P_PLATE) {
      const p = plateSvg(R);
      items.push({ svg: p.svg, w: p.w, h: p.h, mirror: false, family: FAMILIES.indexOf('plate') });
    }
    groups.push({ size, items });
  }
  const distractors = [];
  const nd = evalWidth ? Math.floor(R() * 2) : Math.floor(R() * (MAX_DISTRACTORS + 1));
  for (let i = 0; i < nd; i++) {
    const d = distractorSvg(R);
    distractors.push({ size: L(10, 140) * (d.w / Math.max(d.w, d.h)), item: { svg: d.svg, w: d.w, h: d.h, mirror: false } });
  }
  return { geo: g, frame, lb, groups, distractors };
}

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    bg: '', out: '', split: 'train', count: 12000, procs: 4, seed: 2, evalWidths: '', geo: '', name: '',
  });
  if (!a.out) throw new Error('cần --out');
  const evalWidths = a.evalWidths ? String(a.evalWidths).split(',').map(Number) : null;
  if (evalWidths && !['A', 'B'].includes(a.geo)) throw new Error('--eval-widths cần --geo A hoặc B');
  const name = a.name || (evalWidths ? `${a.split}-eval${a.geo}` : a.split);
  if (!/^[a-z][a-zA-Z0-9-]{0,31}$/.test(name)) throw new Error(`tên tập không hợp lệ: ${name}`);
  const imgDir = join(a.out, 'img');
  mkdirSync(imgDir, { recursive: true });
  const base = a.seed + SPLIT_SEED_OFFSET[a.split];
  const nShards = Math.ceil(a.count / SCENE_SHARD);
  const jobs = [];
  for (let s = 0; s < nShards; s++) if (!existsSync(join(a.out, `${name}-${s}.json`))) jobs.push(s);
  for (const f of readdirSync(a.out)) if (f.includes('.tmp-')) rmSync(join(a.out, f), { force: true });
  const bgs = backgroundsFor(a.bg, a.split);
  if (!bgs.length) console.error('cảnh báo: không có ảnh nền thật, chỉ dùng nền vẽ thủ tục');
  console.error(`${name}: ${a.count} ảnh, ${nShards} phân đoạn, còn ${jobs.length}`);
  const t0 = Date.now();
  let done = 0;
  await withPages(Math.max(1, a.procs), a.bg, (pages) =>
    runQueue(pages, jobs, async (page, s) => {
      const lo = s * SCENE_SHARD;
      const hi = Math.min(a.count, lo + SCENE_SHARD);
      const labels = [];
      for (let b = lo; b < hi; b += BATCH) {
        const idx = [];
        for (let i = b; i < Math.min(hi, b + BATCH); i++) idx.push(i);
        const Rb = mulberry32(seedOf(base, name, 'bg', s, b));
        const bgSub = bgs.length ? Array.from({ length: BG_PER_BATCH }, () => bgs[Math.floor(Rb() * bgs.length)]) : [];
        const scenes = idx.map((i) => {
          const ew = evalWidths ? evalWidths[i % evalWidths.length] : null;
          const spec = sceneSpec(seedOf(base, name, 'spec', i), { geo: evalWidths ? a.geo : null, evalWidth: ew });
          const conv = (it) => ({ url: toDataUrl(it.svg), w: it.w, h: it.h, mirror: it.mirror, family: it.family ?? -1 });
          return {
            seed: seedOf(base, name, 'page', i),
            geo: spec.geo,
            frame: spec.frame,
            lb: spec.lb,
            groups: spec.groups.map((g) => ({ size: g.size, items: g.items.map(conv) })),
            distractors: spec.distractors.map((d) => ({ size: d.size, item: conv(d.item) })),
            evalWidth: ew,
          };
        });
        const res = await page.evaluate((arg) => window.BD.renderScenes(arg), { scenes, bgs: bgSub });
        res.scenes.forEach((r, j) => {
          const f = `${name}-${s}-${idx[j] - lo}.jpg`;
          writeFileSync(join(imgDir, f), Buffer.from(r.jpeg.split(',')[1], 'base64'));
          const rec = { f, geo: r.geo, frame: scenes[j].frame, boxes: r.boxes, ignore: r.ignore, synth: r.synth, bg: r.bg, bgClean: r.clean };
          if (scenes[j].evalWidth) rec.evalWidth = scenes[j].evalWidth;
          labels.push(rec);
        });
      }
      writeFileAtomic(join(a.out, `${name}-${s}.json`), JSON.stringify(labels));
      done += hi - lo;
      const sec = (Date.now() - t0) / 1000;
      console.error(`${name}-${s}: xong; ${done} ảnh trong ${sec.toFixed(0)} s (${(done / sec).toFixed(2)} ảnh/s)`);
    }),
  );
  const sec = (Date.now() - t0) / 1000;
  if (!jobs.length && existsSync(join(a.out, `${name}.done`))) return;
  writeFileAtomic(join(a.out, `${name}.done`), JSON.stringify({ n: a.count, shards: nShards, sec, rate: done / Math.max(sec, 1e-3) }));
  console.error(`${name}: xong ${a.count} ảnh`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
