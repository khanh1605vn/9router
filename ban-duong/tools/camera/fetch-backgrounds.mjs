// Tải ảnh nền cảnh đường phố từ tập kiểm định và kiểm tra của Open Images V7 (CSV nhỏ, không cần tệp hộp 2,26 GB
// của tập huấn luyện). Chỉ giữ ảnh có giấy phép CC BY 2.0, có hộp xe/đèn/biển, rộng ít nhất 1024 điểm ảnh.
// Ảnh đã được người kiểm có/không có biển (nhãn mức ảnh) được lấy trước: ảnh xác nhận không có biển là sạch, ảnh
// xác nhận có biển thì hộp biển gần đủ. Phần lớn ảnh chưa được kiểm; train_detector.py giảm trọng số lỗi âm trên
// mọi ảnh trừ ảnh sạch (bdcommon.NEG_W_UNVERIFIED), và giới hạn còn lại được ghi trong MODEL_CARD.md.
//
//   node tools/camera/fetch-backgrounds.mjs --out $BANDUONG_CACHE/bg --count 8000 \
//        [--python $BANDUONG_CACHE/venv/bin/python] [--concurrency 8] [--seed 1]
//
// Kết quả trong --out:
//   dl-meta/          CSV tải về (dữ liệu, không bao giờ chạy)
//   dl-raw/           ảnh gốc tải về, chỉ tồn tại trong lúc kiểm tra rồi bị xoá
//   train/ val/ test/ ảnh đã giải mã và ghi lại bằng Pillow (python -I), chia theo ImageID, không trùng nhau
//   index.json        { images: [{ id, split, w, h, status, ignore: [[x0,y0,x1,y1] (tỉ lệ 0–1)] }] } — ignore là
//                     hộp "Traffic sign"/"Stop sign"; status 'present' | 'absent' | 'unverified' (lib.mjs signStatus)
//   attribution.csv   ImageID, Title, Author, AuthorProfileURL, License, OriginalURL, OriginalLandingURL, Changes
//   state.json        tiến độ, để chạy lại thì làm tiếp
// Chạy lại an toàn bất cứ lúc nào: tệp đã có được bỏ qua. Ảnh được giữ và ghi theo thứ tự ứng viên (không theo
// thứ tự tải xong), nên hai lần chạy từ đầu cho cùng index.json.

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  hash32,
  MAX_BG_WIDTH,
  MIN_BG_WIDTH,
  OI_IMAGES,
  OI_LICENSE,
  OI_META,
  OI_SIGN_CLASS,
  OI_SIGN_CLASSES,
  OI_STREET_CLASSES,
  parseArgs,
  readCsv,
  readCsvRows,
  readJson,
  signStatus,
  splitOf,
  SPLITS,
  TOOLS_DIR,
  writeFileAtomic,
} from './lib.mjs';

const RETRIES = 3; // số lần thử lại một tệp
const RETRY_BASE_MS = 1000; // chờ 1 s, 3 s, 9 s giữa các lần thử
const IMAGE_TIMEOUT_MS = 30_000; // thời gian tối đa tải một ảnh
const META_TIMEOUT_MS = 600_000; // thời gian tối đa tải một tệp CSV
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // ảnh lớn hơn bị bỏ
const CHUNK = 96; // số ảnh tải và kiểm tra mỗi lượt
const ROTATION_OK = new Set(['', '0', '0.0']); // ảnh cần xoay thì hộp có thể lệch: bỏ
// Đổi khi cách chọn hay chia ảnh đổi (2: chia theo tác giả, tình trạng biển): candidates.json và state.json cũ bị
// bỏ, ảnh đã tải được kiểm lại.
export const STATE_VERSION = 2;
// Cột "Changes" của attribution.csv (CC BY 2.0 §4(b): nêu rõ tác phẩm đã bị sửa đổi).
export const CHANGES_NOTE =
  'Cropped, rescaled, colour-adjusted and composited with synthetic signs; used only to train models, not distributed.';
const STATUS_RANK = { present: 0, absent: 0, unverified: 1 }; // ảnh đã kiểm lên trước

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tải url về path (qua tệp .part), thử lại khi lỗi mạng; trả về false nếu hết lượt thử. */
async function download(url, path, { timeout, maxBytes = Infinity }) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const part = `${path}.part`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (res.status === 404 || res.status === 403) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) return false;
      let n = 0;
      const guard = async function* (src) {
        for await (const c of src) {
          n += c.length;
          if (n > maxBytes) throw new Error('quá lớn');
          yield c;
        }
      };
      await pipeline(Readable.fromWeb(res.body), guard, createWriteStream(part));
      renameSync(part, path);
      return true;
    } catch (e) {
      rmSync(part, { force: true });
      if (String(e.message).includes('quá lớn')) return false;
      if (attempt === RETRIES) {
        console.error(`bỏ ${url}: ${e.message}`);
        return false;
      }
      await sleep(RETRY_BASE_MS * 3 ** attempt);
    }
  }
  return false;
}

async function fetchMeta(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(OI_META)) {
    const p = join(dir, `${name}.csv`);
    if (existsSync(p)) continue;
    console.error(`tải ${url}`);
    if (!(await download(url, p, { timeout: META_TIMEOUT_MS }))) throw new Error(`không tải được ${url}`);
  }
}

const CLOSEUP_AREA = 0.5; // xe chiếm hơn nửa ảnh: ảnh chụp cận, ít giống cảnh nhìn từ trong xe

/** Điểm "giống cảnh đường phố" của một ảnh từ các hộp của nó. */
export function streetScore(st, vehicleMids) {
  let s = 0;
  for (const k of st.kinds) s += vehicleMids.has(k) ? 1 : 3; // đèn giao thông, biển, cột đèn: +3
  if (st.n >= 3) s += 1;
  if (st.maxArea > CLOSEUP_AREA) s -= 2;
  return s;
}

/**
 * Thứ tự ứng viên: ảnh đã được người kiểm có/không có biển trước, rồi ảnh giống cảnh đường phố nhất (có
 * đèn/biển/cột đèn, nhiều loại xe, không phải ảnh chụp cận một xe), cùng điểm thì theo mã băm có hạt giống.
 */
export function rankCandidates(cands, seed) {
  return cands.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.score - a.score ||
      hash32(`${seed}:${a.id}`) - hash32(`${seed}:${b.id}`) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** Xếp các việc của một lượt theo thứ tự ứng viên (việc tải xong theo thứ tự bất kỳ). */
export function orderByRank(jobs, batch) {
  const rank = new Map(batch.map((c, i) => [c.id, i]));
  return jobs.sort((a, b) => rank.get(a.id) - rank.get(b.id));
}

/** Danh sách ứng viên theo thứ tự cố định (băm theo hạt giống). */
async function buildCandidates(meta, seed) {
  // Tệp lớp có thể có hoặc không có dòng tiêu đề; dòng tiêu đề chỉ thêm một khoá vô hại.
  const mid = {};
  await readCsvRows(join(meta, 'classes.csv'), (r) => (mid[r[1]] = r[0]));
  const streetMids = new Set(OI_STREET_CLASSES.map((n) => mid[n]).filter(Boolean));
  if (streetMids.size !== OI_STREET_CLASSES.length) throw new Error('thiếu mã lớp Open Images');
  const signMids = new Set(OI_SIGN_CLASSES.map((n) => mid[n]).filter(Boolean));
  if (signMids.size !== OI_SIGN_CLASSES.length) throw new Error('thiếu mã lớp biển Open Images');
  const signMid = mid[OI_SIGN_CLASS];
  const street = new Map(); // ImageID → { kinds: Set, n, maxArea }
  const ignore = new Map();
  const verified = new Map(); // ImageID → { present, absent } theo nhãn người kiểm
  const vehicle = new Set(['Car', 'Bus', 'Truck', 'Motorcycle'].map((n) => mid[n]));
  for (const sub of ['validation', 'test']) {
    await readCsv(join(meta, `${sub}-labels.csv`), (r) => {
      if (!signMids.has(r.LabelName)) return;
      if (!verified.has(r.ImageID)) verified.set(r.ImageID, { present: false, absent: false });
      const v = verified.get(r.ImageID);
      if (r.Confidence === '1') v.present = true;
      else if (r.Confidence === '0' && r.LabelName === signMid) v.absent = true;
    });
    await readCsv(join(meta, `${sub}-bbox.csv`), (r) => {
      if (signMids.has(r.LabelName)) {
        if (!ignore.has(r.ImageID)) ignore.set(r.ImageID, []);
        ignore.get(r.ImageID).push([+r.XMin, +r.YMin, +r.XMax, +r.YMax].map((v) => Math.round(v * 1e4) / 1e4));
      }
      if (streetMids.has(r.LabelName) && r.IsDepiction !== '1') {
        if (!street.has(r.ImageID)) street.set(r.ImageID, { kinds: new Set(), n: 0, maxArea: 0 });
        const st = street.get(r.ImageID);
        st.kinds.add(r.LabelName);
        if (vehicle.has(r.LabelName)) {
          st.n++;
          st.maxArea = Math.max(st.maxArea, (r.XMax - r.XMin) * (r.YMax - r.YMin));
        }
      }
    });
  }
  const cands = [];
  for (const sub of ['validation', 'test']) {
    await readCsv(join(meta, `${sub}-images.csv`), (r) => {
      if (!street.has(r.ImageID) || r.License !== OI_LICENSE || !ROTATION_OK.has(r.Rotation ?? '')) return;
      if (!/^[0-9a-f]{16}$/.test(r.ImageID)) return;
      const ign = ignore.get(r.ImageID) || [];
      cands.push({
        id: r.ImageID,
        subset: sub,
        title: r.Title ?? '',
        author: r.Author,
        authorUrl: r.AuthorProfileURL,
        license: r.License,
        url: r.OriginalURL,
        landingUrl: r.OriginalLandingURL ?? '',
        ignore: ign,
        status: signStatus(verified.get(r.ImageID), ign.length),
        score: streetScore(street.get(r.ImageID), vehicle),
      });
    });
  }
  return rankCandidates(cands, seed);
}

const csvCell = (s) => (/[",\n\r]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));

export const ATTRIBUTION_HEADER = 'ImageID,Title,Author,AuthorProfileURL,License,OriginalURL,OriginalLandingURL,Changes';

/** Nội dung attribution.csv cho các ảnh đã giữ (RFC 4180). */
export function attributionCsv(kept) {
  const rows = [ATTRIBUTION_HEADER];
  for (const k of kept)
    rows.push([k.id, k.title, k.author, k.authorUrl, k.license, k.url, k.landingUrl, CHANGES_NOTE].map(csvCell).join(','));
  return rows.join('\n') + '\n';
}

function writeOutputs(out, state) {
  const kept = state.kept;
  const images = kept.map((k) => ({ id: k.id, split: k.split, w: k.w, h: k.h, status: k.status, ignore: k.ignore }));
  writeFileAtomic(join(out, 'index.json'), JSON.stringify({ source: 'Open Images V7 (validation, test)', version: STATE_VERSION, images }));
  writeFileAtomic(join(out, 'attribution.csv'), attributionCsv(kept));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    out: '',
    count: 8000,
    python: process.env.BANDUONG_CACHE ? join(process.env.BANDUONG_CACHE, 'venv', 'bin', 'python') : 'python3',
    concurrency: 8,
    seed: 1,
  });
  if (!args.out) throw new Error('cần --out');
  const out = args.out;
  const meta = join(out, 'dl-meta');
  const raw = join(out, 'dl-raw');
  for (const d of [out, raw, ...SPLITS.map((s) => join(out, s))]) mkdirSync(d, { recursive: true });
  await fetchMeta(meta);

  const candPath = join(out, 'candidates.json');
  const statePath = join(out, 'state.json');
  const stale = (p) => existsSync(p) && readJson(p).version !== STATE_VERSION;
  if (stale(candPath) || stale(statePath)) {
    console.error('candidates.json/state.json của phiên bản cũ: chọn lại ứng viên');
    rmSync(candPath, { force: true });
    rmSync(statePath, { force: true });
  }
  if (!existsSync(candPath)) {
    const c = await buildCandidates(meta, args.seed);
    writeFileAtomic(candPath, JSON.stringify({ version: STATE_VERSION, candidates: c }));
    const nClean = c.filter((x) => x.status !== 'unverified').length;
    console.error(`${c.length} ảnh ứng viên (CC BY 2.0, cảnh đường phố), ${nClean} ảnh đã được kiểm có/không có biển`);
  }
  const cands = readJson(candPath).candidates;
  const state = existsSync(statePath) ? readJson(statePath) : { version: STATE_VERSION, next: 0, kept: [], dropped: {} };
  // Ảnh đã ghi xong nhưng chưa kịp vào state (bị dừng giữa lượt): kiểm lại ở lượt sau.
  for (const f of readdirSync(raw)) rmSync(join(raw, f), { force: true });

  const t0 = Date.now();
  let bytes = 0;
  let fetched = 0;
  while (state.kept.length < args.count && state.next < cands.length) {
    const batch = cands.slice(state.next, state.next + CHUNK);
    const jobs = [];
    let i = 0;
    const worker = async () => {
      while (i < batch.length) {
        const c = batch[i++];
        const split = splitOf(c.id, c.author);
        const dst = join(out, split, `${c.id}.jpg`);
        if (existsSync(dst)) {
          jobs.push({ id: c.id, src: null, dst, split });
          continue;
        }
        const src = join(raw, `${c.id}.jpg`);
        const url = `${OI_IMAGES}/${c.subset}/${c.id}.jpg`;
        if (await download(url, src, { timeout: IMAGE_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES })) {
          bytes += statSync(src).size;
          fetched++;
          jobs.push({ id: c.id, src, dst, split });
        } else state.dropped[c.id] = 'download';
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
    const todo = jobs.filter((j) => j.src);
    let results = {};
    if (todo.length) {
      const jp = join(out, 'jobs.tmp.json');
      const rp = join(out, 'results.tmp.json');
      writeFileSync(jp, JSON.stringify(todo));
      const r = spawnSync(
        args.python,
        ['-I', join(TOOLS_DIR, 'sanitize_images.py'), jp, rp, String(MIN_BG_WIDTH), String(MAX_BG_WIDTH)],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (r.status !== 0) throw new Error('sanitize_images.py thất bại');
      results = readJson(rp);
      rmSync(jp, { force: true });
      rmSync(rp, { force: true });
      for (const j of todo) rmSync(j.src, { force: true });
    }
    const byId = new Map(batch.map((c) => [c.id, c]));
    for (const j of orderByRank(jobs, batch)) {
      const c = byId.get(j.id);
      let res = j.src ? results[j.id] : null;
      if (!j.src) {
        // ảnh sạch đã có từ lần chạy trước: đọc kích thước đã ghi
        const prev = state.kept.find((k) => k.id === j.id);
        if (prev) continue;
        res = { ok: true, w: null, h: null };
      }
      if (res && res.ok && state.kept.length < args.count) state.kept.push({ ...c, split: j.split, w: res.w, h: res.h });
      else if (res && res.ok) rmSync(j.dst, { force: true });
      else state.dropped[j.id] = res ? res.reason : 'unknown';
    }
    state.next += batch.length;
    writeFileAtomic(statePath, JSON.stringify(state));
    writeOutputs(out, state);
    const s = (Date.now() - t0) / 1000;
    console.error(
      `ảnh nền: giữ ${state.kept.length}/${args.count}, đã xét ${state.next}/${cands.length}, ` +
        `bỏ ${Object.keys(state.dropped).length}; ${fetched} ảnh, ${(bytes / 1e6).toFixed(1)} MB trong ${s.toFixed(0)} s`,
    );
  }
  // Ảnh sạch có từ lần chạy trước nhưng thiếu kích thước: đọc lại bằng Python.
  const missing = state.kept.filter((k) => !k.w);
  if (missing.length) {
    const r = spawnSync(args.python, ['-I', '-c', SIZE_PY, ...missing.map((k) => join(out, k.split, `${k.id}.jpg`))], {
      encoding: 'utf8',
    });
    const sizes = r.stdout.trim().split('\n').map((l) => l.split(' ').map(Number));
    missing.forEach((k, i) => ([k.w, k.h] = sizes[i] || [0, 0]));
    writeFileAtomic(statePath, JSON.stringify(state));
    writeOutputs(out, state);
  }
  const perSplit = Object.fromEntries(SPLITS.map((s) => [s, state.kept.filter((k) => k.split === s).length]));
  console.error(`xong: ${state.kept.length} ảnh nền ${JSON.stringify(perSplit)}`);
  if (state.kept.length < args.count) console.error('cảnh báo: không đủ ảnh ứng viên cho số lượng yêu cầu');
}

const SIZE_PY = 'import sys\nfrom PIL import Image\nfor p in sys.argv[1:]:\n    with Image.open(p) as im: print(*im.size)';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
