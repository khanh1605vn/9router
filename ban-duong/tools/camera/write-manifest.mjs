// Ghi js/mlmanifest.js: SHA-256 và kích thước của các tệp mô hình và LiteRT mà js/vision.js tải và kiểm trước khi
// dùng. Chỉ liệt kê những tệp đang có trên đĩa (thiếu mô hình thì trang coi là tính năng chưa cài).
//
//   node tools/camera/write-manifest.mjs [--root <thư mục ứng dụng>] [--version N]
//
// Đầu ra xác định: khoá xếp theo thứ tự, không có ngày giờ. `version` là số nguyên tăng thêm 1 mỗi khi danh sách tệp
// hay nội dung đổi so với bản đang có (chạy lại khi không có gì đổi thì giữ nguyên); --version N đặt hẳn giá trị.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_FILES = ['models/labels.json', 'models/sign-det.int8.tflite', 'models/sign-cls.int8.tflite'];
const VENDOR_DIR = 'vendor/litert';
const VENDOR_RUNTIME = /\.(js|wasm)$/; // chỉ những tệp trang thực sự tải (IIFE, tệp nạp và wasm)
const OUT = 'js/mlmanifest.js';
const HEADER =
  '// Tệp sinh tự động bởi tools/camera/write-manifest.mjs — đừng sửa tay.\n' +
  '// SHA-256 và kích thước (byte) của từng tệp mô hình và LiteRT; js/vision.js từ chối tệp không khớp.\n';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Tham số lạ: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export function scan(root) {
  const files = [];
  for (const f of MODEL_FILES) if (existsSync(join(root, f)) && statSync(join(root, f)).isFile()) files.push(f);
  const vd = join(root, VENDOR_DIR);
  if (existsSync(vd)) {
    for (const n of readdirSync(vd)) {
      const f = `${VENDOR_DIR}/${n}`;
      if (VENDOR_RUNTIME.test(n) && statSync(join(root, f)).isFile()) files.push(f);
    }
  }
  const out = {};
  for (const f of files.sort()) {
    const buf = readFileSync(join(root, f));
    out[f] = { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  return out;
}

/** Đọc bản đang có (do chính công cụ này ghi: một khai báo `export const ML_MANIFEST = <JSON>;`). */
export function parseManifest(text) {
  const m = /export const ML_MANIFEST = (\{[\s\S]*\});\s*$/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}

export function render(manifest) {
  return `${HEADER}\nexport const ML_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`;
}

export function nextVersion(prev, files) {
  if (!prev || !Number.isInteger(prev.version)) return 1;
  return JSON.stringify(prev.files) === JSON.stringify(files) ? prev.version : prev.version + 1;
}

function main() {
  const opt = args(process.argv.slice(2));
  const root = resolve(opt.root || join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const files = scan(root);
  const outPath = join(root, OUT);
  const prev = existsSync(outPath) ? parseManifest(readFileSync(outPath, 'utf8')) : null;
  const version = opt.version != null ? Number(opt.version) : nextVersion(prev, files);
  if (!Number.isInteger(version) || version < 1) throw new Error('--version phải là số nguyên dương');
  writeFileSync(outPath, render({ version, files }));
  console.error(`Đã ghi ${OUT} (phiên bản ${version}, ${Object.keys(files).length} tệp)`);
  for (const [f, e] of Object.entries(files)) console.error(`  ${f}  ${e.size} B`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
