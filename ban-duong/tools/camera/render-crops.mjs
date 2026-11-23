// Dữ liệu cho bộ phân loại: ảnh cắt 48×48 (khung biển + lề 15 %) của cả 181 nhãn, vẽ từ hình biển của ứng dụng
// (signSvg trong js/signart.js) với biến đổi phối cảnh, kích thước thật, mờ, nhoè chuyển động, nhiễu, ánh sáng,
// ban đêm, mòn bẩn, che khuất, nén JPEG và lệch khung ±15 % kích thước, ±10 % vị trí.
//
//   node tools/camera/render-crops.mjs --out $BANDUONG_CACHE/crops --bg $BANDUONG_CACHE/bg --split train \
//        --per-class 600 --tier-a 1200 --procs 4 --seed 1 [--widths 20,24,32,48] [--labels models/labels.json] \
//        [--name <tên tập>]
//
// Định dạng (xem README): mỗi phân đoạn <tên>-<số>.u8 là N×48×48×3 byte RGB liền nhau, kèm <tên>-<số>.json
// { n, labels: [chỉ số nhãn], w: [cạnh khung biển thật, điểm ảnh], night: [0/1], photo: [0/1] }. Tên mặc định là
// tập; có --widths thì thêm "w" (ví dụ testw-0.u8), mỗi nhãn được vẽ ở từng cạnh đã cho (cạnh khi nhìn thẳng; góc
// nghiêng làm khung hẹp hơn) và .json có thêm req: [cạnh yêu cầu]. <tên>.done ghi khi đủ mọi phân đoạn.
// --tier-a là số ảnh của mỗi nhãn trong WHITELIST (lib.mjs), không theo cờ learn của labels.json; --bg rỗng thì
// chỉ dùng nền vẽ thủ tục (photo luôn 0, dùng cho cặp vào/ra mẫu của models/golden/).
// Hạt giống của từng mẫu suy từ (hạt gốc, tập, nhãn, số thứ tự): chạy lại cho đúng ảnh cũ; ba tập dùng dãy hạt
// tách rời (SPLIT_SEED_OFFSET) và ảnh nền tách rời.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGN_CATALOGUE } from '../../js/signs.js';
import { signSvg } from '../../js/signart.js';
import {
  BOX_JITTER,
  labelsPath,
  mulberry32,
  nativeWidth,
  parseArgs,
  readJson,
  seedOf,
  SPLIT_SEED_OFFSET,
  trainingPlan,
  WHITELIST,
  writeFileAtomic,
} from './lib.mjs';
import { backgroundsFor, runQueue, withPages } from './render-common.mjs';
import { distractorSvg, otherSignSvg, plateSvg, toDataUrl } from './synth-art.mjs';

export const SHARD = 2000; // số ảnh mỗi phân đoạn
const BATCH = 250; // số ảnh mỗi lần gọi vào trang
const BG_PER_BATCH = 24; // số ảnh nền khác nhau mỗi lô (để bộ nhớ đệm của trang trúng)
export const P_PURE_BG = 0.45; // nhãn background: tỉ lệ mảng nền thuần, còn lại là vật gây nhiễu
export const P_PLATE_OTHER = 0.2; // nhãn other-sign: tỉ lệ biển phụ (bộ dò có thể đưa biển phụ vào bộ phân loại)
const SVG_SIZE = 256;

/**
 * Số mẫu của một nhãn trong một tập. Nhãn trong WHITELIST có tierA ảnh, kể cả khi labels.json đã gỡ cờ learn của
 * nó sau đánh giá lần trước (dữ liệu không đổi theo kết quả đánh giá).
 */
export function countFor(label, plan, { perClass, tierA, bgMult, otherMult }) {
  const p = plan[label.label];
  if (!p || p.kind === 'alias') return 0;
  if (p.kind === 'background') return Math.round(perClass * bgMult);
  if (p.kind === 'other') return Math.round(perClass * otherMult);
  return WHITELIST.includes(label.label) ? tierA : perClass;
}

/** Nội dung (hình SVG) của mẫu thứ k của một nhãn — xác định hoàn toàn bởi hạt giống. */
export function sampleItem(label, plan, seed) {
  const R = mulberry32(seed);
  const p = plan[label.label];
  if (p.kind === 'sign') {
    const value = p.values ? p.values[Math.floor(R() * p.values.length)] : null;
    return { svg: signSvg(p.art, { size: SVG_SIZE, value }), w: 100, h: 100, mirror: p.mirror, kind: 'sign' };
  }
  if (p.kind === 'other') {
    const a = R() < P_PLATE_OTHER ? plateSvg(R) : otherSignSvg(R);
    return { svg: a.svg, w: a.w, h: a.h, mirror: false, kind: 'other' };
  }
  if (R() < P_PURE_BG) return null;
  const d = distractorSvg(R);
  return { svg: d.svg, w: d.w, h: d.h, mirror: false, kind: 'bg' };
}

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    out: '', bg: '', split: 'train', perClass: 600, tierA: 1000, bgMult: 4, otherMult: 2, procs: 4, seed: 1,
    widths: '', labels: '', name: '',
  });
  if (!a.out) throw new Error('cần --out');
  const labelsJson = readJson(labelsPath(a.labels || null));
  const plan = trainingPlan(labelsJson, SIGN_CATALOGUE);
  const widths = a.widths ? String(a.widths).split(',').map(Number) : [null];
  const name = a.name || (a.widths ? `${a.split}w` : a.split);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`tên tập không hợp lệ: ${name}`);
  mkdirSync(a.out, { recursive: true });
  const base = a.seed + SPLIT_SEED_OFFSET[a.split];
  const samples = [];
  for (const l of labelsJson.labels) {
    const n = countFor(l, plan, a);
    for (const w of widths) for (let k = 0; k < n; k++) samples.push({ li: l.i, k, w });
  }
  const nShards = Math.ceil(samples.length / SHARD);
  const jobs = [];
  for (let s = 0; s < nShards; s++) if (!existsSync(join(a.out, `${name}-${s}.json`))) jobs.push(s);
  for (const f of readdirSync(a.out)) if (f.includes('.tmp-')) rmSync(join(a.out, f), { force: true });
  console.error(`${name}: ${samples.length} ảnh, ${nShards} phân đoạn, còn ${jobs.length}`);
  // Ảnh nền kèm vùng bỏ qua (hộp biển có sẵn, tỉ lệ 0–1): trang không lấy mảng nền phủ lên các hộp đó.
  const bgs = backgroundsFor(a.bg, a.split).map((b) => ({ url: b.url, ignore: b.ignore }));
  if (!bgs.length) console.error('cảnh báo: không có ảnh nền thật, chỉ dùng nền vẽ thủ tục');
  const t0 = Date.now();
  let done = 0;
  await withPages(Math.max(1, a.procs), a.bg, (pages) =>
    runQueue(pages, jobs, async (page, s) => {
      const part = samples.slice(s * SHARD, (s + 1) * SHARD);
      const bufs = [];
      const meta = { n: part.length, labels: [], w: [], night: [], photo: [] };
      if (a.widths) meta.req = [];
      for (let b = 0; b < part.length; b += BATCH) {
        const batch = part.slice(b, b + BATCH);
        const Rb = mulberry32(seedOf(base, name, 'bg', s, b));
        const bgSub = bgs.length ? Array.from({ length: BG_PER_BATCH }, () => bgs[Math.floor(Rb() * bgs.length)]) : [];
        const urls = new Map();
        const items = batch.map((smp) => {
          const l = labelsJson.labels[smp.li];
          const it = sampleItem(l, plan, seedOf(base, name, l.label, smp.k, smp.w ?? '-'));
          if (!it) return { kind: 'bg', item: null };
          const url = toDataUrl(it.svg);
          urls.set(url, true);
          return { kind: it.kind, item: { url, w: it.w, h: it.h, mirror: it.mirror } };
        });
        const pageSamples = batch.map((smp, i) => ({
          ...items[i],
          seed: seedOf(base, name, 'page', smp.li, smp.k, smp.w ?? '-'),
          width: smp.w ?? nativeWidth(mulberry32(seedOf(base, name, 'width', smp.li, smp.k))),
        }));
        const res = await page.evaluate((arg) => window.BD.renderCrops(arg), {
          samples: pageSamples,
          bgs: bgSub,
          jitter: BOX_JITTER,
        });
        bufs.push(Buffer.from(res.rgb, 'base64'));
        batch.forEach((smp, i) => {
          meta.labels.push(smp.li);
          meta.w.push(res.meta[i].w);
          meta.night.push(res.meta[i].night ? 1 : 0);
          meta.photo.push(res.meta[i].photo ? 1 : 0);
          if (meta.req) meta.req.push(smp.w);
        });
      }
      writeFileAtomic(join(a.out, `${name}-${s}.u8`), Buffer.concat(bufs));
      writeFileAtomic(join(a.out, `${name}-${s}.json`), JSON.stringify(meta));
      done += part.length;
      const sec = (Date.now() - t0) / 1000;
      console.error(`${name}-${s}: xong; ${done} ảnh trong ${sec.toFixed(0)} s (${(done / sec).toFixed(1)} ảnh/s)`);
    }),
  );
  const sec = (Date.now() - t0) / 1000;
  if (!jobs.length && existsSync(join(a.out, `${name}.done`))) return;
  writeFileAtomic(join(a.out, `${name}.done`), JSON.stringify({ n: samples.length, shards: nShards, sec, rate: done / Math.max(sec, 1e-3) }));
  console.error(`${name}: xong ${samples.length} ảnh`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
