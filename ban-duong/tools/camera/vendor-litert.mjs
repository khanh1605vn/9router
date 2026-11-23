// Đưa LiteRT.js (bộ chạy mô hình TFLite bằng WebAssembly) vào vendor/litert/ của ứng dụng.
//
//   node tools/camera/vendor-litert.mjs [--out vendor/litert] [--cache ~/.cache/ban-duong-train] [--keep yes|no]
//   (--keep yes: giữ lại thư mục cài đặt tạm để xem; mặc định xoá sau khi xong). Tham số khác bị từ chối.
//
// Thư mục đích chỉ được là vendor/litert của ứng dụng, một thư mục mới hay rỗng, hoặc một thư mục do chính công cụ này
// ghi trước đó (VERSIONS.json có globalName 'LiteRT'), và không chứa tệp nào ngoài các tệp đầu ra (OUTPUTS). Chỉ các
// tệp đầu ra bị xoá rồi ghi lại; kiểm tra chạy trước mọi bước tải hay cài đặt.
//
// Các bước:
// 1. Cài sạch @litertjs/core, @litertjs/wasm-utils và esbuild (gói nhị phân theo nền tảng) với phiên bản ghim cứng,
//    vào một thư mục mới, rỗng, NẰM NGOÀI ứng dụng. Gói tải về là dữ liệu không tin cậy: npm chạy với --ignore-scripts,
//    không import hay require mã nào từ đó. esbuild chỉ được gọi qua tệp nhị phân của nó, với tệp vào do ta viết
//    (đưa qua stdin), để gộp thư viện thành một tệp IIFE dùng được trong worker cổ điển.
// 2. Chép hai bản dựng wasm (compat: SIMD128; relaxed: relaxed SIMD) cùng tệp nạp .js của chúng.
// 3. Tải văn bản giấy phép Apache-2.0 của LiteRT và giấy phép BSD của XNNPACK (gói npm không kèm), mỗi tệp vào một
//    thư mục mới, rỗng; chỉ đọc như văn bản rồi kiểm tra nội dung.
// 4. Ghi SHA256SUMS và VERSIONS.json (phiên bản, mã toàn vẹn npm, SHA-256 của từng tệp).
// Không có ngày giờ trong đầu ra: chạy lại với cùng phiên bản cho cùng kết quả (trừ khi văn bản giấy phép trên mạng đổi).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = 'https://registry.npmjs.org/';
const LITERT_VERSION = '2.6.0';
const WASM_UTILS_VERSION = '2.6.0'; // phiên bản khớp với @litertjs/core 2.6.0 (core khai báo ^2.6.0)
const ESBUILD_VERSION = '0.25.12'; // phiên bản đã dùng khi đo đạc (ml.md)
// Gói nhị phân esbuild theo nền tảng: chỉ những nền tảng này được chấp nhận.
const ESBUILD_PLATFORMS = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']);
const GLOBAL_NAME = 'LiteRT';
// Các tệp lấy từ @litertjs/core/wasm/: tệp nạp .js và tệp .wasm của hai bản dựng một luồng.
const WASM_FILES = [
  'litert_wasm_compat_internal.js',
  'litert_wasm_compat_internal.wasm',
  'litert_wasm_internal.js',
  'litert_wasm_internal.wasm',
];
const LICENSES = [
  {
    file: 'LICENSE',
    url: 'https://raw.githubusercontent.com/google-ai-edge/LiteRT/main/LICENSE',
    must: ['Apache License', 'Version 2.0'],
    header: '',
  },
  {
    file: 'NOTICE-XNNPACK',
    url: 'https://raw.githubusercontent.com/google/XNNPACK/master/LICENSE',
    must: ['BSD', 'Redistribution and use in source and binary forms'],
    header:
      'XNNPACK is compiled into litert_wasm_compat_internal.wasm and litert_wasm_internal.wasm.\n' +
      'Its licence follows, reproduced as its binary-redistribution clause requires.\n' +
      `Source: https://raw.githubusercontent.com/google/XNNPACK/master/LICENSE\n\n`,
  },
];
const MAX_LICENSE_BYTES = 64 * 1024; // văn bản giấy phép thật chỉ vài KB; lớn hơn là có gì đó sai
const IIFE_FILE = 'litert.iife.min.js';
const DEFAULT_OUT = 'vendor/litert';
// Mọi tệp công cụ này ghi vào thư mục đích; chỉ những tệp này được xoá và ghi lại.
export const OUTPUTS = Object.freeze([IIFE_FILE, ...WASM_FILES, ...LICENSES.map((l) => l.file), 'VERSIONS.json', 'SHA256SUMS'].sort());
const OPTIONS = ['out', 'cache', 'keep']; // tham số dòng lệnh được nhận
// Tệp vào của esbuild (mã của ta): chỉ lấy những gì worker dùng.
const ENTRY = "export { loadLiteRt, unloadLiteRt, loadAndCompile, Tensor } from '@litertjs/core';\n";

/** Đọc `--khoá giá-trị`; khoá ngoài `allowed`, thiếu giá trị hay đối số lạ thì báo lỗi (không lặng lẽ bỏ qua). */
export function parseArgs(argv, allowed = OPTIONS) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Tham số lạ: ${a}`);
    const key = a.slice(2);
    if (!allowed.includes(key)) throw new Error(`Không nhận tham số --${key} (chỉ nhận: ${allowed.map((k) => `--${k}`).join(', ')})`);
    if (Object.hasOwn(out, key)) throw new Error(`--${key} được đưa hai lần`);
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`--${key} thiếu giá trị`);
    out[key] = v;
  }
  if (out.keep != null && out.keep !== 'yes' && out.keep !== 'no') throw new Error('--keep chỉ nhận yes hoặc no');
  return out;
}

/** dir nằm trong root (hoặc chính là root). */
export function inside(dir, root) {
  const r = relative(resolve(root), resolve(dir));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * Thư mục đích có an toàn để ghi đè không. Ném lỗi nếu: là ứng dụng hay một thư mục cha của nó, không phải thư mục,
 * hoặc không rỗng mà không phải vendor/litert của ứng dụng và cũng không do công cụ này ghi, hoặc có tệp lạ.
 * `app` là thư mục ứng dụng. Trả 'new' | 'empty' | 'ours'.
 */
export function checkOutDir(out, app = APP) {
  const dir = resolve(out);
  if (inside(resolve(app), dir)) throw new Error(`Từ chối ghi vào ${dir}: đó là ứng dụng hoặc thư mục chứa nó`);
  if (!existsSync(dir)) return 'new';
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} không phải thư mục`);
  const names = readdirSync(dir);
  if (!names.length) return 'empty';
  let ours = dir === resolve(app, DEFAULT_OUT);
  if (!ours) {
    try {
      ours = readJson(join(dir, 'VERSIONS.json')).globalName === GLOBAL_NAME;
    } catch {
      ours = false;
    }
  }
  if (!ours) throw new Error(`Từ chối ghi vào ${dir}: thư mục không rỗng và không phải thư mục LiteRT do công cụ này ghi`);
  const extra = names.filter((n) => !OUTPUTS.includes(n));
  if (extra.length) throw new Error(`${dir} có tệp lạ (${extra.join(', ')}); xoá tay rồi chạy lại`);
  return 'ours';
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cache = resolve(opt.cache || process.env.BANDUONG_CACHE || join(homedir(), '.cache', 'ban-duong-train'));
  const out = resolve(APP, opt.out || DEFAULT_OUT);
  if (inside(cache, APP)) throw new Error('Thư mục cài đặt tạm phải nằm ngoài ứng dụng');
  if (inside(out, cache) || inside(cache, out)) throw new Error('Thư mục đích và thư mục cài đặt tạm phải tách rời nhau');
  checkOutDir(out); // trước mọi bước tải hay cài đặt
  const platform = `${process.platform}-${process.arch}`;
  if (!ESBUILD_PLATFORMS.has(platform)) throw new Error(`Chưa hỗ trợ nền tảng ${platform}`);
  const esbuildPkg = `@esbuild/${platform}`;

  mkdirSync(cache, { recursive: true });
  // 1. Cài vào một thư mục mới, rỗng.
  const work = mkdtempSync(join(cache, 'litert-npm-'));
  const pkg = {
    name: 'ban-duong-litert-vendor',
    private: true,
    dependencies: {
      '@litertjs/core': LITERT_VERSION,
      '@litertjs/wasm-utils': WASM_UTILS_VERSION,
      [esbuildPkg]: ESBUILD_VERSION,
    },
  };
  writeFileSync(join(work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.error(`npm install → ${work}`);
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry', REGISTRY, '--loglevel', 'error'],
    { cwd: work, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, npm_config_ignore_scripts: 'true' } }
  );

  const lock = readJson(join(work, 'package-lock.json'));
  const nm = join(work, 'node_modules');
  const packages = {};
  for (const [name, want] of [
    ['@litertjs/core', LITERT_VERSION],
    ['@litertjs/wasm-utils', WASM_UTILS_VERSION],
    [esbuildPkg, ESBUILD_VERSION],
  ]) {
    const meta = readJson(join(nm, name, 'package.json'));
    if (meta.version !== want) throw new Error(`${name}: muốn ${want}, cài được ${meta.version}`);
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.integrity || !entry.resolved?.startsWith(REGISTRY)) throw new Error(`${name}: thiếu mã toàn vẹn trong package-lock`);
    // Ta không chạy script cài đặt nào; ghi lại để biết gói có cần hay không.
    const life = ['preinstall', 'install', 'postinstall'].filter((k) => meta.scripts?.[k]);
    packages[name] = { version: meta.version, license: meta.license ?? null, resolved: entry.resolved, integrity: entry.integrity, installScripts: life };
  }
  // core chỉ được có đúng một bản wasm-utils: bản đã ghim.
  const nested = join(nm, '@litertjs', 'core', 'node_modules');
  if (existsSync(nested)) throw new Error('@litertjs/core có node_modules lồng bên trong; phiên bản không khớp');
  const extra = Object.keys(lock.packages || {}).filter((k) => k && !Object.hasOwn(packages, k.replace(/^node_modules\//, '')));
  if (extra.length) throw new Error(`Có gói phụ thuộc ngoài dự kiến: ${extra.join(', ')}`);

  // esbuild: tệp nhị phân của gói theo nền tảng, không qua trình bao JS của gói "esbuild" (gói đó cần postinstall).
  const exe = join(nm, esbuildPkg, process.platform === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild'));
  const head = readFileSync(exe).subarray(0, 4);
  const native = head[0] === 0x7f && head[1] === 0x45 || head[0] === 0xcf || head[0] === 0xce || head[0] === 0x4d;
  if (!native) throw new Error('Tệp esbuild không phải tệp thực thi gốc');
  const exeVersion = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
  if (exeVersion !== ESBUILD_VERSION) throw new Error(`esbuild báo phiên bản ${exeVersion}`);

  const build = mkdtempSync(join(cache, 'litert-build-'));
  const bundle = join(build, 'litert.iife.min.js');
  const esbuildArgs = [
    '--bundle',
    '--format=iife',
    `--global-name=${GLOBAL_NAME}`,
    '--platform=browser',
    '--target=es2020',
    '--minify',
    '--charset=utf8',
    '--sourcefile=ban-duong-litert-entry.mjs',
    '--loader=js',
    `--outfile=${bundle}`,
  ];
  // Tệp vào đưa qua stdin; esbuild tìm '@litertjs/core' từ thư mục làm việc (cwd = thư mục cài đặt).
  execFileSync(exe, esbuildArgs, { cwd: work, input: ENTRY, stdio: ['pipe', 'inherit', 'inherit'] });
  const iife = readFileSync(bundle);
  if (!iife.toString('utf8').startsWith(`var ${GLOBAL_NAME}=`)) throw new Error('Tệp IIFE không khai báo biến toàn cục mong đợi');

  // 3. Giấy phép.
  const licenseText = {};
  const licenseDirs = [];
  for (const lic of LICENSES) {
    const dir = mkdtempSync(join(cache, 'litert-license-'));
    licenseDirs.push(dir);
    const dest = join(dir, 'download.txt');
    execFileSync('curl', ['-fsSL', '--proto', '=https', '--max-time', '60', '--max-filesize', String(MAX_LICENSE_BYTES), '-o', dest, lic.url], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const buf = readFileSync(dest);
    const text = buf.toString('utf8');
    if (buf.length > MAX_LICENSE_BYTES || !Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${lic.url}: không phải văn bản UTF-8 hợp lệ`);
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw new Error(`${lic.url}: có ký tự điều khiển`);
    for (const m of lic.must) if (!text.includes(m)) throw new Error(`${lic.url}: thiếu "${m}"`);
    licenseText[lic.file] = { text: lic.header + text, url: lic.url, sha256: sha256(buf) };
  }

  // 2 + 4. Ghi vào thư mục đích: chỉ các tệp đầu ra, ghi đè bản cũ (kiểm lại thư mục ngay trước khi xoá).
  checkOutDir(out);
  mkdirSync(out, { recursive: true });
  for (const name of OUTPUTS) rmSync(join(out, name), { force: true });
  writeFileSync(join(out, IIFE_FILE), iife);
  for (const f of WASM_FILES) {
    copyFileSync(join(nm, '@litertjs', 'core', 'wasm', f), join(out, f));
    chmodSync(join(out, f), 0o644); // tệp trong gói npm mang cờ thực thi; trong ứng dụng chỉ là dữ liệu
  }
  for (const [file, l] of Object.entries(licenseText)) writeFileSync(join(out, file), l.text);

  const files = {};
  for (const name of OUTPUTS.filter((n) => n !== 'VERSIONS.json' && n !== 'SHA256SUMS')) {
    const buf = readFileSync(join(out, name));
    files[name] = { sha256: sha256(buf), size: statSync(join(out, name)).size };
  }
  const versions = {
    version: 1,
    globalName: GLOBAL_NAME,
    packages,
    esbuild: { package: esbuildPkg, version: ESBUILD_VERSION, args: esbuildArgs.filter((a) => !a.startsWith('--outfile=')), entry: ENTRY },
    licenses: Object.fromEntries(Object.entries(licenseText).map(([f, l]) => [f, { url: l.url, sha256OfDownload: l.sha256 }])),
    files,
  };
  writeFileSync(join(out, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
  const sums = OUTPUTS.filter((n) => n !== 'SHA256SUMS')
    .map((n) => `${sha256(readFileSync(join(out, n)))}  ${n}`)
    .join('\n');
  writeFileSync(join(out, 'SHA256SUMS'), sums + '\n');
  rmSync(build, { recursive: true, force: true });
  if (opt.keep !== 'yes') for (const dir of [work, ...licenseDirs]) rmSync(dir, { recursive: true, force: true });
  console.error(`Đã ghi ${Object.keys(files).length + 2} tệp vào ${out}`);
  for (const [n, f] of Object.entries(files)) console.error(`  ${n}  ${f.size} B  ${f.sha256.slice(0, 16)}…`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`vendor-litert: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
