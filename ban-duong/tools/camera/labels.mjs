// Sinh models/labels.json (hợp đồng 1) từ SIGN_CATALOGUE trong js/signs.js.
//
//   node tools/camera/labels.mjs                       # ghi models/labels.json
//   node tools/camera/labels.mjs --out <tệp> | --stdout
//   node tools/camera/labels.mjs --provenance          # in JSON nguồn gốc bản dựng (export.py gọi)
//
// Danh sách nhãn có thứ tự cố định. T (nhiệt độ hiệu chỉnh) luôn được đặt lại thành 1.0; calibrate.py ghi giá trị
// thật sau khi huấn luyện. Lỗi nếu một mã trong danh sách được học không có trong danh mục.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SIGN_CATALOGUE } from '../../js/signs.js';
import { buildLabels, labelsPath, parseArgs, provenance, writeFileAtomic } from './lib.mjs';

/** Nội dung labels.json dạng chuỗi (thụt 2 dấu cách, mỗi nhãn một dòng cho dễ đọc khi so sánh thay đổi). */
export function labelsText(obj = buildLabels(SIGN_CATALOGUE)) {
  const { labels, ...rest } = obj;
  const head = JSON.stringify({ ...rest, labels: [] }, null, 2);
  const rows = labels.map((l) => `    ${JSON.stringify(l)}`).join(',\n');
  return head.replace('"labels": []', `"labels": [\n${rows}\n  ]`) + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2), { out: '', stdout: false, provenance: false });
  if (args.provenance) {
    const run = (a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    process.stdout.write(JSON.stringify(provenance({ catalogue: SIGN_CATALOGUE, run })) + '\n');
    return;
  }
  const text = labelsText();
  if (args.stdout) process.stdout.write(text);
  else {
    const out = labelsPath(args.out || null);
    writeFileAtomic(out, text);
    console.error(`labels.json: ${JSON.parse(text).labels.length} nhãn → ${out}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
