// Cài bộ mô hình đã dựng từ thư mục chờ vào models/ (bước cuối của train-all.sh). models/ của ứng dụng chỉ bị đổi
// ở đây, một lần, khi cả bộ đã xong và khớp SHA256SUMS.
//
//   node tools/camera/install-models.mjs --from $BANDUONG_CACHE/models-staging [--to models/] [--no-tests] [--no-rollback]
//
// Các bước: kiểm thư mục chờ (đủ tệp bắt buộc, mọi tệp khớp SHA256SUMS, không có tệp lạ, cặp mẫu chỉ nền vẽ thủ
// tục); chép sang <to>.new rồi đổi chỗ với <to> (bản cũ giữ ở <to>.old). Nếu <to> là models/ của ứng dụng: chạy
// write-manifest.mjs (js/mlmanifest.js) rồi toàn bộ `node --test tests/*.test.mjs`; có bài hỏng thì trả models/
// và js/mlmanifest.js về như cũ (trừ khi --no-rollback) và thoát với mã 1. Thư mục chờ không bị đổi.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, parseArgs, sha256Buf, TOOLS_DIR } from './lib.mjs';

/** Tệp phải có trong một bộ mô hình hoàn chỉnh. */
export const REQUIRED_FILES = Object.freeze([
  'labels.json', 'sign-det.int8.tflite', 'sign-cls.int8.tflite', 'golden/index.json', 'MODEL_CARD.md', 'SHA256SUMS',
]);
const SUMS_LINE = /^([0-9a-f]{64}) [ *](\S(?:.*\S)?)$/;

/** Dòng của SHA256SUMS → [{ sha, path }]; lỗi nếu dòng sai dạng hoặc đường dẫn ra ngoài thư mục. */
export function parseSums(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = SUMS_LINE.exec(line);
    if (!m) throw new Error(`SHA256SUMS: dòng sai dạng: ${line.slice(0, 80)}`);
    const p = m[2];
    if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '')) throw new Error(`SHA256SUMS: đường dẫn lạ: ${p}`);
    out.push({ sha: m[1], path: p });
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Kiểm một thư mục chờ; trả về danh sách lỗi (rỗng = cài được). */
export function checkStage(dir) {
  const errors = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`không có thư mục ${dir}`];
  for (const f of REQUIRED_FILES) if (!existsSync(join(dir, f))) errors.push(`thiếu ${f}`);
  if (errors.length) return errors;
  let sums;
  try {
    sums = parseSums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
  } catch (e) {
    return [e.message];
  }
  const listed = new Set(sums.map((s) => s.path));
  for (const { sha, path } of sums) {
    const p = join(dir, path);
    if (!existsSync(p)) errors.push(`SHA256SUMS liệt kê tệp không có: ${path}`);
    else if (sha256Buf(readFileSync(p)) !== sha) errors.push(`sai SHA-256: ${path}`);
  }
  for (const f of listFiles(dir)) if (f !== 'SHA256SUMS' && !listed.has(f)) errors.push(`tệp không có trong SHA256SUMS: ${f}`);
  try {
    const g = JSON.parse(readFileSync(join(dir, 'golden', 'index.json'), 'utf8'));
    if (g.background !== 'procedural') errors.push('golden/index.json: cặp mẫu phải dùng nền vẽ thủ tục (background: "procedural")');
  } catch {
    errors.push('golden/index.json không đọc được');
  }
  return errors;
}

/** Thay thư mục `to` bằng bản chép của `from`; bản cũ (nếu có) ở `${to}.old`. Trả về đường dẫn bản cũ hoặc null. */
export function swapIn(from, to) {
  const tmp = `${to}.new`;
  const old = `${to}.old`;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(from, tmp, { recursive: true });
  const had = existsSync(to);
  if (had) renameSync(to, old);
  renameSync(tmp, to);
  return had ? old : null;
}

/** Trả `to` về bản cũ (sau swapIn). */
export function swapBack(to, old) {
  rmSync(to, { recursive: true, force: true });
  if (old) renameSync(old, to);
}

function run(cmd, args, cwd) {
  console.error(`$ ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] }).status;
}

function main() {
  const a = parseArgs(process.argv.slice(2), { from: '', to: join(APP_ROOT, 'models'), tests: true, noTests: false, noRollback: false });
  if (!a.from) throw new Error('cần --from <thư mục chờ>');
  const from = resolve(a.from);
  const to = resolve(a.to);
  if (to === from || to.startsWith(from + sep) || from.startsWith(to + sep)) throw new Error('--from và --to phải là hai thư mục tách rời');
  const errors = checkStage(from);
  if (errors.length) {
    for (const e of errors) console.error(`thư mục chờ: ${e}`);
    process.exit(1);
  }
  const isApp = to === resolve(APP_ROOT, 'models');
  const manifestPath = join(APP_ROOT, 'js', 'mlmanifest.js');
  const manifestBefore = isApp && existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const old = swapIn(from, to);
  console.error(`đã chép ${from} → ${to}`);
  if (!isApp) {
    if (old) rmSync(old, { recursive: true, force: true });
    console.error('không phải models/ của ứng dụng: không cập nhật mlmanifest, không chạy kiểm thử');
    return;
  }
  const restore = (why) => {
    console.error(`Lỗi: ${why}`);
    if (a.noRollback) {
      console.error(`--no-rollback: giữ bộ mới trong ${to}; bản cũ ở ${old ?? '(không có)'}`);
    } else {
      swapBack(to, old);
      if (manifestBefore) writeFileSync(manifestPath, manifestBefore);
      else rmSync(manifestPath, { force: true });
      console.error(`đã trả ${to} và js/mlmanifest.js về như cũ; bộ mới vẫn ở ${from}`);
    }
    process.exit(1);
  };
  if (run(process.execPath, [join(TOOLS_DIR, 'write-manifest.mjs'), '--root', APP_ROOT], APP_ROOT) !== 0) restore('write-manifest.mjs thất bại');
  if (!a.noTests) {
    if (run(process.execPath, ['--test', 'tests/*.test.mjs'], APP_ROOT) !== 0)
      restore('có bài kiểm thử hỏng với bộ mô hình mới (xem nhật ký ở trên)');
  }
  if (old) rmSync(old, { recursive: true, force: true });
  console.error(`đã cài bộ mô hình vào ${to}${a.noTests ? ' (không chạy kiểm thử)' : '; toàn bộ kiểm thử qua'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
