// Service worker: giúp ứng dụng mở được khi mất mạng và giữ lại các ô bản đồ đã xem.
// Đổi VERSION mỗi lần phát hành để máy người dùng nhận bản mới, và đổi luôn SHELL_VERSION trong js/appupdate.js cho
// giống (tests/appupdate.test.mjs kiểm tra hai chỗ khớp nhau).

const VERSION = 'v12';
// Mọi trang GitHub Pages của một tài khoản chung một nguồn gốc (khanh1605vn.github.io), nên chung cả bộ nhớ đệm. Tên
// bộ nhớ đệm vỏ ứng dụng gắn với phạm vi (thư mục) của service worker, để một bản Bạn Đường khác trên cùng tài khoản
// (bản thử, bản sao) không xoá hay ghi đè vỏ ứng dụng của /9router/ khi đổi bản.
const SCOPE_PATH = new URL((self.registration && self.registration.scope) || './', self.location.href).pathname;
const SHELL_PREFIX = 'banduong-shell-';
const SHELL = `${SHELL_PREFIX}${VERSION}@${SCOPE_PATH}`;
const TILES = 'banduong-tiles-v1';
const TILE_LIMIT = 800;
// Ô bản đồ raster tile.openstreetmap.org: địa chỉ không gắn phiên bản, ảnh đổi khi bản đồ được sửa. Bản đã lưu dùng
// ngay, nhưng quá TILE_MAX_AGE thì được tải lại ngầm (lần sau mới thấy ảnh mới). Thời điểm lưu ghi trong một tiêu đề
// riêng (STAMP), vì tiêu đề Date của câu trả lời khác nguồn không đọc được. Bản lưu từ trước khi có STAMP coi như đã cũ.
const TILE_MAX_AGE = 7 * 24 * 3600e3;
const STAMP = 'x-banduong-stored';
// Số lượt tải lại ngầm cùng lúc tối đa (cuộn bản đồ qua nhiều ô cũ không dồn hàng trăm yêu cầu lên máy chủ ô bản đồ).
const REVALIDATE_MAX = 4;
const revalidating = new Set(); // địa chỉ đang được tải lại ngầm

// Tệp mô hình nhận diện biển và LiteRT (khoảng 12 MB mỗi bản dựng): chỉ tải khi người dùng bật camera, nên KHÔNG nằm
// trong SHELL_FILES. Bộ nhớ đệm riêng, không bị xoá khi đổi VERSION (activate chỉ xoá banduong-shell-*). Ô bản đồ và
// tệp ML khoá bằng cả địa chỉ (tệp ML còn gắn ?v= mã băm), nên các bản trên cùng nguồn gốc dùng chung được.
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
  'js/obdnative.js',
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
  'js/carbridge.js',
  'js/appupdate.js',
  'js/ios.js',
  'js/compat.js',
  'vendor/maplibre-gl/maplibre-gl.js',
  'vendor/maplibre-gl/maplibre-gl.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// GitHub Pages trả mọi tệp kèm Cache-Control: max-age=600, nên nếu đi qua bộ nhớ đệm HTTP của trình duyệt thì trong 10
// phút sau khi phát hành, bản mới của service worker vẫn nạp mã cũ vào bộ nhớ đệm vỏ ứng dụng (người dùng bấm "tải lại"
// vẫn chạy mã cũ, hoặc lẫn tệp cũ với tệp mới). Vì vậy lúc cài luôn tải thẳng từ máy chủ (cache: 'reload').
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) =>
        cache.addAll(SHELL_FILES.map((u) => new Request(new URL(u, self.location.href), { cache: 'reload' })))
      )
      .then(() => self.skipWaiting())
  );
});

/**
 * Bộ nhớ đệm vỏ ứng dụng cũ cần xoá khi kích hoạt: bản khác của chính phạm vi này (tên kết thúc bằng @<phạm vi>), và bản
 * đặt tên kiểu cũ (trước v12, chưa gắn phạm vi) nhưng chỉ khi nó chứa trang chính của phạm vi này. Bộ nhớ đệm của bản
 * Bạn Đường ở thư mục khác trên cùng nguồn gốc không bao giờ bị đụng tới.
 */
async function staleShells() {
  const own = `@${SCOPE_PATH}`;
  const home = new URL(SCOPE_PATH, self.location.href).href;
  const out = [];
  for (const k of await caches.keys()) {
    if (!k.startsWith(SHELL_PREFIX) || k === SHELL) continue;
    if (k.endsWith(own)) out.push(k);
    else if (!k.includes('@')) {
      try {
        if (await (await caches.open(k)).match(home)) out.push(k);
      } catch {
        /* không đọc được: để nguyên */
      }
    }
  }
  return out;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    staleShells()
      .then((old) => Promise.all(old.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Trang hỏi "bạn là bản nào?" (js/appupdate.js, SwUpdateWatcher) qua MessageChannel: khi service worker mới nắm trang,
// trang chỉ mời tải lại nếu mã nó đang chạy khác bản này. Chỉ trả đúng chuỗi VERSION, không đọc gì khác từ thông điệp.
self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port || !event.data || event.data.type !== 'banduong:version') return;
  try {
    port.postMessage({ type: 'banduong:version', version: VERSION });
  } catch {
    /* trang đã đóng cổng */
  }
});

/**
 * Yêu cầu hỏi lại máy chủ thay vì dùng bộ nhớ đệm HTTP của trình duyệt (cache: 'no-cache': tệp không đổi thì máy chủ
 * chỉ trả 304, rẻ). Yêu cầu đã tự đặt cách khác (tải lại mạnh, no-store…) thì giữ nguyên. Trình duyệt không cho dựng lại
 * yêu cầu (bản cũ với yêu cầu mở trang) thì dùng yêu cầu gốc.
 */
function bypassHttpCache(request) {
  if (request.cache !== 'default' && request.cache !== 'force-cache') return request;
  try {
    return new Request(request, { cache: 'no-cache' });
  } catch {
    return request;
  }
}

/**
 * Ưu tiên mạng để luôn có bản mới; mất mạng thì dùng bản đã lưu. fresh: bỏ qua bộ nhớ đệm HTTP (vỏ ứng dụng, xem ghi
 * chú ở sự kiện install).
 */
async function networkFirst(request, cacheName, { ignoreSearch = false, fresh = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(fresh ? bypassHttpCache(request) : request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch });
    if (hit) return hit;
    throw err;
  }
}

/** Giới hạn dung lượng: bỏ bớt các mục cũ nhất. */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, 80).map((k) => cache.delete(k)));
}

/** Lưu bản sao kèm thời điểm lưu (STAMP). Phải đọc hết thân để dựng lại câu trả lời với tiêu đề mới. */
async function putStamped(cache, request, copy) {
  const buf = await copy.arrayBuffer();
  const headers = new Headers(copy.headers);
  headers.set(STAMP, String(Date.now()));
  await cache.put(request, new Response(buf, { status: copy.status, statusText: copy.statusText, headers }));
}

/** Bản đã lưu quá maxAge chưa (không có hay không đọc được STAMP: coi như đã quá; đồng hồ bị chỉnh lùi cũng vậy). */
function expired(hit, maxAge) {
  const at = Number(hit.headers.get(STAMP));
  if (!Number.isFinite(at) || at <= 0) return true;
  const age = Date.now() - at;
  return age < 0 || age >= maxAge;
}

/** event.waitUntil không bao giờ làm hỏng câu trả lời (sự kiện đã hết hạn thì bỏ qua việc chạy nền). */
function keepAlive(event, p) {
  try {
    event.waitUntil(p);
  } catch {
    /* bỏ qua */
  }
}

/** Tải lại ngầm một mục đã cũ; lỗi hay câu trả lời không ok thì giữ nguyên bản đang có. */
async function revalidate(cache, request) {
  const url = request.url;
  if (revalidating.has(url) || revalidating.size >= REVALIDATE_MAX) return;
  revalidating.add(url);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await putStamped(cache, request, response);
      await trim(cache);
    }
  } catch {
    /* mất mạng hay máy chủ lỗi: dùng tiếp bản đã lưu, lần sau thử lại */
  } finally {
    revalidating.delete(url);
  }
}

/**
 * Ưu tiên bản đã lưu (ô bản đồ, phông chữ). Không có maxAge: nội dung không đổi theo địa chỉ, giữ mãi. Có maxAge: bản
 * đã lưu quá hạn vẫn trả ngay (không bắt người dùng chờ, mất mạng vẫn có bản đồ) và được tải lại ngầm.
 */
async function cacheFirst(event, request, cacheName, maxAge = null) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    if (maxAge != null && expired(hit, maxAge)) keepAlive(event, revalidate(cache, request));
    return hit;
  }
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    const store = maxAge != null ? putStamped(cache, request, copy) : cache.put(request, copy);
    keepAlive(event, store.then(() => trim(cache)).catch(() => {}));
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
    event.respondWith(networkFirst(request, SHELL, { ignoreSearch: true, fresh: true }));
    return;
  }
  if (url.hostname === 'tiles.openfreemap.org') {
    // Ô bản đồ, phông chữ, biểu tượng có địa chỉ gắn phiên bản → lưu lâu dài.
    // Tệp kiểu bản đồ và danh mục ô thay đổi hằng tuần → luôn hỏi mạng trước.
    const immutable = /\.(pbf|png|jpg|webp)$/.test(url.pathname) || url.pathname.startsWith('/sprites/');
    event.respondWith(immutable ? cacheFirst(event, request, TILES) : networkFirst(request, TILES));
    return;
  }
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(cacheFirst(event, request, TILES, TILE_MAX_AGE));
    return;
  }
  if (url.hostname === 'fonts.gstatic.com') {
    // Phông chữ: địa chỉ gắn phiên bản, không bao giờ đổi.
    event.respondWith(cacheFirst(event, request, TILES));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(networkFirst(request, TILES));
  }
  // Các dịch vụ tìm đường, tìm địa điểm, dữ liệu đường: luôn đi thẳng ra mạng.
});
