// Sinh lại tools/camera/requirements.txt: giải phụ thuộc bằng `pip install --dry-run --report` (không cài gì),
// rồi lấy mã băm SHA-256 của từng tệp wheel từ JSON API của PyPI (https://pypi.org/pypi/<tên>/<bản>/json).
// Chỉ dùng khi cần nâng phiên bản; quy trình huấn luyện bình thường chỉ đọc requirements.txt đã ghim.
//
//   node tools/camera/pin-requirements.mjs --python /đường/dẫn/venv-tạm/bin/python
//
// Python được dùng phải là bản sẽ chạy huấn luyện (mặc định 3.13, Linux x86_64): pip giải phụ thuộc theo nó.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';

// Gói gốc cần cài; phần còn lại do pip tự giải.
export const TOP_LEVEL = ['tensorflow-cpu==2.21.0', 'numpy', 'pillow'];
// Bản Python CPython được nhận wheel (thẻ cpXY); wheel thuần Python và abi3 luôn được nhận.
const PY_TAGS = ['cp311', 'cp312', 'cp313'];

/** Wheel dùng được trên Linux x86_64 với một trong các bản Python ở trên. */
export function wheelFits(filename) {
  if (!filename.endsWith('.whl')) return false;
  const parts = filename.slice(0, -4).split('-');
  if (parts.length < 5) return false;
  const [py, abi, plat] = parts.slice(-3);
  const platOk = plat === 'any' || (/manylinux|linux/.test(plat) && plat.includes('x86_64'));
  if (!platOk) return false;
  if (abi === 'none' && /^(py3|py2\.py3)/.test(py)) return true;
  if (abi === 'abi3') return true;
  return PY_TAGS.some((t) => py.split('.').includes(t));
}

async function hashesFor(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const j = await res.json();
  const out = [];
  for (const f of j.urls || []) if (f.packagetype === 'bdist_wheel' && wheelFits(f.filename)) out.push(f.digests.sha256);
  if (!out.length) throw new Error(`${name}==${version}: không có wheel Linux x86_64 phù hợp`);
  return [...new Set(out)].sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { python: 'python3', out: null });
  const here = fileURLToPath(new URL('.', import.meta.url));
  const outPath = args.out || join(here, 'requirements.txt');
  const dir = mkdtempSync(join(tmpdir(), 'bd-pin-'));
  try {
    const report = join(dir, 'report.json');
    const r = spawnSync(
      args.python,
      ['-I', '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--only-binary', ':all:', '--quiet', '--report', report, ...TOP_LEVEL],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error('pip --dry-run thất bại');
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    const pins = rep.install.map((i) => ({ name: i.metadata.name, version: i.metadata.version }));
    pins.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const lines = [
      '# Sinh bởi tools/camera/pin-requirements.mjs — đừng sửa tay.',
      `# Python ${rep.environment?.python_full_version || '?'} trên ${rep.environment?.platform_machine || '?'};`,
      '# mã băm lấy từ JSON API của PyPI. Cài bằng:',
      '#   pip install --require-hashes --only-binary :all: -r tools/camera/requirements.txt',
    ];
    for (const p of pins) {
      const hs = await hashesFor(p.name, p.version);
      lines.push(`${p.name}==${p.version} \\`);
      hs.forEach((h, i) => lines.push(`    --hash=sha256:${h}${i < hs.length - 1 ? ' \\' : ''}`));
    }
    writeFileSync(outPath, lines.join('\n') + '\n');
    console.log(`đã ghi ${pins.length} gói vào ${outPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
