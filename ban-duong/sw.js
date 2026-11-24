// Service worker: giúp ứng dụng mở được khi mất mạng và giữ lại các ô bản đồ đã xem.
// Đổi VERSION mỗi lần phát hành để máy người dùng nhận bản mới.

const VERSION = 'v7';
const SHELL = `banduong-shell-${VERSION}`;
const TILES = 'banduong-tiles-v1';
const TILE_LIMIT = 800;

// Tệp mô hình nhận diện biển và LiteRT (khoảng 12 MB mỗi bản dựng): chỉ tải khi người dùng bật camera, nên KHÔNG nằm
// trong SHELL_FILES. Bộ nhớ đệm riêng, không bị xoá khi đổi VERSION (activate chỉ xoá banduong-shell-*).
const ML = 'banduong-ml-1';
// Thư mục (tính từ phạm vi của service worker) đi vào bộ nhớ đệm ML.
const ML_DIRS = ['models/', 'vendor/litert/'];
// Mỗi địa chỉ ML gắn ?v=<16 ký tự đầu của SHA-256> (HASH_QUERY trong js/vision.js), nên nội dung không đổi theo địa chỉ.
// Chỉ nhận đúng dạng này; địa chỉ không có ?v= hợp lệ đi thẳng ra mạng, không lưu.
const ML_HASH_LEN = 16;
const ML_QUERY = new RegExp(`^\\?v=[0-9a-f]{${ML_HASH_LEN}}$`);
// Mã thử nghiệm và công cụ huấn luyện: không bao giờ lưu.
const NEVER_CACHE_DIRS = ['tests/', 'tools/'];

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/geo.js',
  'js/store.js',
  'js/location.js',
  'js/mapview.js',
  'js/routing.js',
  'js/tracker.js',
  'js/roaddata.js',
  'js/alerts.js',
  'js/voice.js',
  'js/search.js',
  'js/icons.js',
  'js/signs.js',
  'js/signart.js',
  'js/signengine.js',
  'js/elm327.js',
  'js/obd.js',
  'js/camera.js',
  'js/camsched.js',
  'js/camctl.js',
  'js/camui.js',
  'js/evalcrops.js',
  'js/vision.js',
  'js/vision-worker.js',
  'js/visionproto.js',
  'js/mlmanifest.js',
  'js/signtrack.js',
  'js/signlearn.js',
  'js/learnedsigns.js',
  'vendor/maplibre-gl/maplibre-gl.js',
  'vendor/maplibre-gl/maplibre-gl.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('banduong-shell-') && k !== SHELL).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/** Ưu tiên mạng để luôn có bản mới; mất mạng thì dùng bản đã lưu. */
async function networkFirst(request, cacheName, ignoreSearch = false) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch });
    if (hit) return hit;
    throw err;
  }
}

/** Ưu tiên bản đã lưu (ô bản đồ, phông chữ: nội dung không đổi theo địa chỉ). */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone()).then(async () => {
      const keys = await cache.keys();
      // Giới hạn dung lượng: bỏ bớt các mục cũ nhất.
      if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, 80).map((k) => cache.delete(k)));
    });
  }
  return response;
}

/** Đường dẫn tính từ phạm vi của service worker (ứng dụng có thể nằm trong thư mục con), hoặc null nếu ngoài phạm vi. */
function appPath(url) {
  const scope = self.registration && self.registration.scope;
  const base = new URL(scope || './', self.location.href).pathname;
  return url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
}

function under(path, dirs) {
  return path !== null && dirs.some((d) => path.startsWith(d));
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Chỉ lưu câu trả lời đầy đủ (200, không phải 206), cùng nguồn gốc, không qua chuyển hướng. */
function storable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic' || response.redirected) return false;
  try {
    return new URL(response.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/**
 * Đọc hết bản sao, chỉ lưu khi SHA-256 khớp ?v= của địa chỉ: tải dở (mất mạng giữa chừng) làm việc đọc thất bại,
 * tệp cụt hay hỏng thì lệch mã băm, nên không bao giờ nằm lại trong bộ nhớ đệm để bị dùng mãi. Lưu xong thì bỏ các
 * bản khác ?v= của cùng tệp (bản mô hình cũ).
 */
async function storeVerified(cache, url, copy) {
  const buf = await copy.arrayBuffer();
  const want = new URL(url).search.slice(3); // bỏ '?v='
  if (!(await sha256Hex(buf)).startsWith(want)) return;
  await cache.put(url, new Response(buf, { status: 200, statusText: copy.statusText, headers: copy.headers }));
  const path = new URL(url).pathname;
  const keys = await cache.keys();
  await Promise.all(
    keys.filter((k) => k.url !== url && new URL(k.url).pathname === path).map((k) => cache.delete(k))
  );
}

/** Tệp ML: ưu tiên bản đã lưu, khoá bằng cả địa chỉ gồm ?v= (không ignoreSearch). */
async function mlCacheFirst(event, request) {
  let cache = null;
  try {
    cache = await caches.open(ML);
    const hit = await cache.match(request.url, { ignoreVary: true });
    if (hit) return hit;
  } catch {
    cache = null; // không mở được bộ nhớ đệm (chế độ riêng tư, hết chỗ): vẫn tải từ mạng
  }
  const response = await fetch(request);
  if (cache && storable(response)) {
    event.waitUntil(storeVerified(cache, request.url, response.clone()).catch(() => {}));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    const path = appPath(url);
    // Nhánh ML phải đứng trước nhánh chung, để 12 MB tệp mô hình không rơi vào bộ nhớ đệm của vỏ ứng dụng.
    if (under(path, ML_DIRS)) {
      if (ML_QUERY.test(url.search) && !request.headers.has('range')) event.respondWith(mlCacheFirst(event, request));
      return;
    }
    if (under(path, NEVER_CACHE_DIRS)) return;
    event.respondWith(networkFirst(request, SHELL, true));
    return;
  }
  if (url.hostname === 'tiles.openfreemap.org') {
    // Ô bản đồ, phông chữ, biểu tượng có địa chỉ gắn phiên bản → lưu lâu dài.
    // Tệp kiểu bản đồ và danh mục ô thay đổi hằng tuần → luôn hỏi mạng trước.
    const immutable = /\.(pbf|png|jpg|webp)$/.test(url.pathname) || url.pathname.startsWith('/sprites/');
    event.respondWith(immutable ? cacheFirst(request, TILES) : networkFirst(request, TILES));
    return;
  }
  if (url.hostname === 'tile.openstreetmap.org' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, TILES));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(networkFirst(request, TILES));
  }
  // Các dịch vụ tìm đường, tìm địa điểm, dữ liệu đường: luôn đi thẳng ra mạng.
});
