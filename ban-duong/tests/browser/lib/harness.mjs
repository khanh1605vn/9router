// Công cụ chung cho các kiểm thử trình duyệt chạy tay (không thuộc npm test): tìm cổng trống trong 20400–20499,
// chạy máy chủ thử của ứng dụng (dev-server.mjs) trên cổng đó, nạp Playwright đã cài sẵn trên máy.
// Playwright lấy theo PLAYWRIGHT_MODULE nếu có, không thì theo cách require('playwright') của Node (NODE_PATH).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT_FIRST = 20400;
const PORT_LAST = 20499;
const START_TIMEOUT = 10e3;

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  return req(process.env.PLAYWRIGHT_MODULE || 'playwright');
}

function tryPort(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

/** Cổng trống đầu tiên trong 20400–20499, bắt đầu từ một vị trí ngẫu nhiên để hai lần chạy song song ít đụng nhau. */
export async function freePort() {
  const span = PORT_LAST - PORT_FIRST + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_FIRST + ((start + i) % span);
    if (await tryPort(port)) return port;
  }
  throw new Error('Không còn cổng trống trong 20400–20499');
}

/**
 * Chạy `node dev-server.mjs` (hoặc `script`) với PORT; trả { url, port, stop() }. Quá `timeout` (ms) chưa báo cổng
 * hay thoát sớm thì dừng tiến trình rồi ném lỗi.
 */
export async function startDevServer(port, { script = join(APP, 'dev-server.mjs'), timeout = START_TIMEOUT } = {}) {
  const p = port || (await freePort());
  const child = spawn(process.execPath, [script], {
    cwd: APP,
    env: { ...process.env, PORT: String(p) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () =>
    new Promise((done) => {
      if (child.exitCode != null || child.signalCode != null) return done();
      child.once('exit', () => done());
      child.kill('SIGTERM');
    });
  child.stderr.resume(); // đọc bỏ để ống không đầy
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('dev-server không khởi động')), timeout);
      child.stdout.on('data', (d) => {
        if (String(d).includes(String(p))) {
          clearTimeout(timer);
          ok();
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`dev-server thoát với mã ${code}`));
      });
    });
  } catch (err) {
    await stop(); // không để lại tiến trình khi không khởi động được
    throw err;
  }
  child.stdout.resume();
  return { url: `http://127.0.0.1:${p}`, port: p, stop };
}

/** Phân vị q của một dãy số (nội suy tuyến tính), làm tròn 0,01. */
export function pct(values, q) {
  const s = values.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * 100) / 100;
}
