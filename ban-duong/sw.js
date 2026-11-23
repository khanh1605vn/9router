// Service worker: giúp ứng dụng mở được khi mất mạng và giữ lại các ô bản đồ đã xem.
// Đổi VERSION mỗi lần phát hành để máy người dùng nhận bản mới.

const VERSION = 'v4';
const SHELL = `banduong-shell-${VERSION}`;
const TILES = 'banduong-tiles-v1';
const TILE_LIMIT = 800;

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
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
