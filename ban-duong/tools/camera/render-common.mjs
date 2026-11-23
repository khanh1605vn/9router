// Khung chạy chung cho render-crops.mjs và render-scenes.mjs: một Chrome không giao diện, mỗi tiến trình vẽ là
// một ngữ cảnh trình duyệt riêng (tiến trình riêng), trang ở gốc giả http://render.local/ chỉ phục vụ
// render-page.js và ảnh nền đã làm sạch; mọi yêu cầu mạng khác bị chặn.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromeExecutable, isCleanStatus, loadPlaywright, readJson, SPLITS, TOOLS_DIR } from './lib.mjs';

const ORIGIN = 'http://render.local';
const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/render-page.js"></script></body></html>';
const ID_RE = /^[0-9a-f]{16}$/;

/**
 * Ảnh nền của một tập: [{ id, url, ignore, clean }] từ index.json của fetch-backgrounds.mjs (rỗng nếu không có),
 * xếp theo ImageID để cùng một tập ảnh luôn cho cùng thứ tự (các bước vẽ chọn ảnh nền theo chỉ số), dù index.json
 * được ghi theo thứ tự nào. clean = người kiểm xác nhận ảnh không có biển (lib.mjs signStatus, isCleanStatus).
 */
export function backgroundsFor(bgDir, split) {
  if (!bgDir || !existsSync(join(bgDir, 'index.json'))) return [];
  return readJson(join(bgDir, 'index.json'))
    .images.filter((im) => im.split === split && ID_RE.test(im.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((im) => ({ id: im.id, url: `${ORIGIN}/bg/${split}/${im.id}.jpg`, ignore: im.ignore || [], clean: isCleanStatus(im.status) }));
}

async function route(r, bgDir) {
  const url = new URL(r.request().url());
  if (url.origin !== ORIGIN) return r.abort();
  if (url.pathname === '/') return r.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML });
  if (url.pathname === '/render-page.js')
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(TOOLS_DIR, 'render-page.js')) });
  const m = /^\/bg\/([a-z]+)\/([0-9a-f]{16})\.jpg$/.exec(url.pathname);
  if (m && bgDir && SPLITS.includes(m[1])) {
    const p = join(bgDir, m[1], `${m[2]}.jpg`);
    if (existsSync(p)) return r.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(p) });
  }
  return r.fulfill({ status: 404, body: '' });
}

/** Mở n trang vẽ, gọi fn(pages), luôn đóng trình duyệt sau cùng. */
export async function withPages(n, bgDir, fn) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromeExecutable(), args: ['--disable-gpu'] });
  try {
    const pages = [];
    for (let i = 0; i < n; i++) {
      const ctx = await browser.newContext();
      await ctx.route('**/*', (r) => route(r, bgDir));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error(`lỗi trong trang: ${e.message}`));
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => !!window.BD, null, { timeout: 30_000 });
      pages.push(page);
    }
    return await fn(pages);
  } finally {
    await browser.close();
  }
}

/** Chạy các việc trên các trang song song; mỗi trang lấy việc kế tiếp khi xong việc trước. */
export async function runQueue(pages, jobs, handler) {
  let next = 0;
  await Promise.all(
    pages.map(async (page) => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await handler(page, job);
      }
    }),
  );
}
