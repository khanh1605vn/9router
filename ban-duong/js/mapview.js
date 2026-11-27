// Bản đồ MapLibre: lớp tuyến đường, điểm cảnh báo, mũi tên vị trí và camera bám theo xe.

/* global maplibregl */
import { angleDiff, circlePolygon, distance } from './geo.js';
import { badgeImage, GLYPHS } from './icons.js';
import { signDataUrl } from './signart.js';
import { abolishedLabelNames, provinceLabelRenames } from './admin2025.js';

export const STYLE_URLS = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

// Dùng khi không tải được bản đồ vector: ảnh nền OpenStreetMap chuẩn.
const RASTER_FALLBACK = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/**
 * Kiểu bản đồ gốc ưu tiên tên tiếng Anh (name_en) nên đường phố Việt Nam hiện thành
 * "Nguyen Dinh Chieu Street". Đổi sang tên gốc tại địa phương (name) để nhãn hiện đúng tiếng Việt.
 */
export function localizeLabels(style) {
  const swap = (expr) => {
    if (Array.isArray(expr)) {
      if (expr.length === 2 && expr[0] === 'get' && (expr[1] === 'name_en' || expr[1] === 'name:en')) return ['get', 'name'];
      return expr.map(swap);
    }
    return typeof expr === 'string' ? expr.replace(/\{name[_:]en\}/g, '{name}') : expr;
  };
  for (const layer of style.layers || []) {
    const field = layer.layout?.['text-field'];
    if (field != null) layer.layout['text-field'] = swap(field);
  }
  return style;
}

/**
 * Bộ lọc kiểu biểu thức (["==", ["get", …], …]) hay kiểu cũ (["==", "class", "state"]). Theo cách MapLibre phân biệt
 * (isExpressionFilter trong style-spec), vì hai kiểu không được trộn trong cùng một "all".
 */
export function isExpressionFilter(filter) {
  if (filter === true || filter === false) return true;
  if (!Array.isArray(filter) || filter.length === 0) return false;
  switch (filter[0]) {
    case 'has':
      return filter.length >= 2 && filter[1] !== '$id' && filter[1] !== '$type';
    case 'in':
      return filter.length >= 3 && (typeof filter[1] !== 'string' || Array.isArray(filter[2]));
    case '!in':
    case '!has':
    case 'none':
      return false;
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return filter.length !== 3 || Array.isArray(filter[1]) || Array.isArray(filter[2]);
    case 'any':
    case 'all':
      return filter.slice(1).every((f) => typeof f === 'boolean' || isExpressionFilter(f));
    default:
      return true;
  }
}

// Lớp nhãn cấp tỉnh trong lược đồ OpenMapTiles: class "state" (OpenFreeMap dùng cho Việt Nam) và "province".
const PROVINCE_CLASSES = ['state', 'province'];

/**
 * Nhãn tỉnh/thành theo sắp xếp 2025 (NQ 202/2025/QH15, js/admin2025.js). Ô bản đồ lấy tên từ OSM. Nút place=state còn
 * sót của tỉnh đã bỏ (như "Hà Giang") thì ẩn. Nhãn của tỉnh nay là thành phố ("Tỉnh Đồng Nai") hoặc đã đổi tên
 * ("Thừa Thiên Huế") thì hiện tên mới. Không thêm nhãn hay toạ độ nào: chỉ lọc và đổi chữ của nhãn có sẵn trong ô.
 * Ranh giới tỉnh vẽ thẳng từ dữ liệu OSM trong ô, nên không đổi ở đây.
 */
export function modernizeAdminLabels(style) {
  const hidden = abolishedLabelNames();
  const renames = provinceLabelRenames();
  for (const layer of style.layers || []) {
    if (layer.type !== 'symbol' || layer['source-layer'] !== 'place') continue;
    const isProvince = () => ['match', ['get', 'class'], [...PROVINCE_CLASSES], true, false];
    if (layer.filter == null || isExpressionFilter(layer.filter)) {
      const keep = ['!', ['all', isProvince(), ['match', ['get', 'name'], [...hidden], true, false]]];
      layer.filter = layer.filter == null ? keep : ['all', layer.filter, keep];
    } else {
      layer.filter = ['all', layer.filter, ['none', ['all', ['in', 'class', ...PROVINCE_CLASSES], ['in', 'name', ...hidden]]]];
    }
    const field = layer.layout?.['text-field'];
    // Chỉ đổi chữ khi text-field là biểu thức; chuỗi kiểu "{name}" giữ nguyên.
    if (Array.isArray(field)) {
      const byName = ['match', ['get', 'name'], ...renames.flatMap(([from, to]) => [[...from], to]), structuredClone(field)];
      layer.layout['text-field'] = ['case', isProvince(), byName, field];
    }
  }
  return style;
}

const EMPTY = { type: 'FeatureCollection', features: [] };

// Bản đồ nền OpenFreeMap được dựng lại khoảng mỗi tuần; địa chỉ ô gắn mã bản dựng (…/planet/<bản dựng>/{z}/{x}/{y}.pbf)
// lấy từ TileJSON của nguồn (https://tiles.openfreemap.org/planet, sw.js luôn hỏi mạng trước). Mở ứng dụng là có bản
// mới; nhưng màn hình xe thường chỉ ngủ chứ không tắt, ứng dụng có thể mở liền nhiều ngày, nên cứ chừng này (ms) lại
// hỏi TileJSON một lần: có bản dựng mới thì nạp lại nguồn ô ngay, không cần mở lại ứng dụng.
export const TILEJSON_CHECK = 6 * 3600e3;

/** Danh sách địa chỉ ô trong TileJSON mới (next) khác bản đang dùng (current): chỉ tin mảng chuỗi https không rỗng. */
export function tileTemplatesDiffer(current, next) {
  if (!Array.isArray(next) || !next.length || next.length > 8) return false;
  if (!next.every((u) => typeof u === 'string' && u.startsWith('https://') && u.length < 512)) return false;
  if (!Array.isArray(current) || current.length !== next.length) return true;
  return current.some((u, i) => u !== next[i]);
}

// Lớp biển do camera ghi nhận (chỉ hiện khi người dùng bấm "Xem trên bản đồ" trong danh sách lúc xe đỗ).
export const LEARNED_ICON_PX = 44; // cỡ hình biển trên bản đồ (px CSS)
export const LEARNED_QUIET_OPACITY = 0.72; // biển chưa xác nhận vẽ nhạt hơn (cùng với viền nét đứt)
const LEARNED_RATIO = 2; // vẽ ảnh gấp đôi rồi nạp với pixelRatio 2 cho nét

/** Tên ảnh trên bản đồ cho một biển đã học (cùng hình, trị số, trạng thái thì dùng chung một ảnh). */
export const learnedImageId = (item) => `bd-l:${JSON.stringify([item.art, item.value ?? null, Boolean(item.quiet)])}`;

/** Vẽ ảnh biển đã học: nền tròn trắng, hình biển, viền liền (đã xác nhận) hoặc nét đứt (chưa xác nhận). */
function learnedImage(item) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const px = LEARNED_ICON_PX * LEARNED_RATIO;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = px;
      const ctx = canvas.getContext('2d');
      const c = px / 2;
      ctx.beginPath();
      ctx.arc(c, c, c - 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 1.5;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 4;
      ctx.strokeStyle = item.quiet ? '#10202f' : '#0a57a4';
      if (item.quiet) ctx.setLineDash([10, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
      const s = px * 0.62;
      ctx.drawImage(img, c - s / 2, c - s / 2, s, s);
      resolve(ctx.getImageData(0, 0, px, px));
    };
    img.onerror = () => resolve(null);
    img.src = signDataUrl(item.art, { size: LEARNED_ICON_PX * LEARNED_RATIO, value: item.value });
  });
}
const line = (coords, props = {}) => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: coords },
});

const ROUTE_COLOR = '#1b6fd8';
const ROUTE_DONE = '#9aa8b5';

function zoomForSpeed(speed, nearTurn) {
  const kmh = (speed || 0) * 3.6;
  const z = kmh < 25 ? 17.3 : kmh < 50 ? 16.8 : kmh < 80 ? 16.1 : 15.3;
  return nearTurn ? Math.max(z, 17.1) : z;
}

export class MapView {
  /**
   * @param handlers { onFollowChange(mode), onLongPress(coord), onPointClick(props), onAltClick(index) }
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.map = null;
    this.follow = 'north'; // 'free' | 'north' | 'drive'
    this.pad = { top: 0, bottom: 0, left: 0 };
    this.shown = null; // vị trí mũi tên đang vẽ { lon, lat, heading }
    this.anim = null;
    this.lastFixAt = 0;
    this.targetZoom = 16.5;
    this.zoomGoal = null;
    this.zoomHoldUntil = 0;
    this.nearTurn = false;
    this.pointers = new Set();
    this.wheeling = false;
    this.data = { route: EMPTY, alts: EMPTY, points: EMPTY, accuracy: EMPTY, learned: EMPTY };
    this.learnedImages = new Map(); // tên ảnh → ImageData của biển đã học (nạp lại khi đổi kiểu bản đồ)
    this.learnedGen = 0;
    this.progress = 0;
    this.lastCam = '';
    this.tileTimer = null;
  }

  /**
   * Hỏi lại TileJSON của các nguồn ô vector (không hỏi khi chắc chắn mất mạng); bản dựng ô đổi thì nạp lại nguồn đó
   * (setUrl: MapLibre tự tải lại TileJSON và các ô đang hiện). Trả về số nguồn đã nạp lại. Không bao giờ ném lỗi.
   */
  async refreshTiles(fetchImpl = (...a) => fetch(...a)) {
    const map = this.map;
    if (!map || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 0;
    let sources = {};
    try {
      sources = map.getStyle()?.sources || {};
    } catch {
      return 0;
    }
    let reloaded = 0;
    for (const [id, def] of Object.entries(sources)) {
      if (!def || def.type !== 'vector' || typeof def.url !== 'string' || !def.url.startsWith('https://')) continue;
      try {
        const src = map.getSource(id);
        if (!src || typeof src.setUrl !== 'function') continue;
        const res = await fetchImpl(def.url);
        if (!res.ok) continue;
        const tj = await res.json();
        if (!tileTemplatesDiffer(src.tiles, tj?.tiles)) continue;
        src.setUrl(def.url);
        reloaded++;
      } catch {
        /* mất mạng giữa chừng hay TileJSON hỏng: giữ nguồn đang dùng, lần sau hỏi lại */
      }
    }
    return reloaded;
  }

  #watchTiles() {
    clearInterval(this.tileTimer);
    this.tileTimer = setInterval(() => void this.refreshTiles(), TILEJSON_CHECK);
  }

  async #resolveStyle(dark) {
    const urls = dark ? [STYLE_URLS.dark, STYLE_URLS.light] : [STYLE_URLS.light];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const style = modernizeAdminLabels(localizeLabels(await res.json()));
          return { style, inverted: dark && url !== STYLE_URLS.dark };
        }
      } catch {
        /* thử nguồn kế tiếp */
      }
    }
    return { style: RASTER_FALLBACK, inverted: dark };
  }

  /** Khởi tạo bản đồ. Ném lỗi nếu thiết bị không dựng được WebGL. */
  async init({ dark, center, zoom }) {
    const { style, inverted } = await this.#resolveStyle(dark);
    this.container.classList.toggle('map-inverted', inverted);
    const map = new maplibregl.Map({
      container: this.container,
      style,
      center,
      zoom,
      maxPitch: 60,
      attributionControl: false,
    });
    this.map = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.#keepAttributionCollapsed();

    const puckEl = document.createElement('div');
    puckEl.className = 'puck no-heading';
    puckEl.innerHTML =
      '<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">' +
      '<path class="puck-arrow" d="M24 5 39 41 24 33.5 9 41z"/><circle class="puck-dot" cx="24" cy="24" r="9"/></svg>';
    this.puckEl = puckEl;
    this.puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });

    const destEl = document.createElement('div');
    destEl.className = 'dest-pin';
    destEl.innerHTML =
      '<svg viewBox="0 0 36 46" width="36" height="46" aria-hidden="true">' +
      '<path d="M18 1.5c9 0 16.5 7.2 16.5 16.2C34.5 29.5 18 44.5 18 44.5S1.5 29.5 1.5 17.7C1.5 8.7 9 1.5 18 1.5z"/>' +
      '<circle cx="18" cy="17.5" r="6"/></svg>';
    this.dest = new maplibregl.Marker({ element: destEl, anchor: 'bottom' });

    // Chỉ chờ kiểu bản đồ, không chờ ô bản đồ: mất mạng thì các lớp của ứng dụng vẫn phải vẽ được.
    const styleReady = new Promise((resolve) => {
      map.on('style.load', () => {
        this.#installLayers();
        resolve();
      });
      setTimeout(resolve, 10000);
    });
    map.on('dragstart', (e) => {
      if (e.originalEvent) this.setFollow('free');
    });
    map.on('zoomstart', (e) => {
      if (e.originalEvent) this.zoomHoldUntil = performance.now() + 12000;
    });
    map.on('click', 'bd-points', (e) => {
      const f = e.features?.[0];
      if (f) this.handlers.onPointClick?.(f.properties);
    });
    map.on('click', 'bd-alts', (e) => {
      const f = e.features?.[0];
      if (f) this.handlers.onAltClick?.(Number(f.properties.index));
    });
    this.#bindGestures();

    await styleReady;
    this.raf = requestAnimationFrame(this.#frame);
    this.#watchTiles();
  }

  /**
   * MapLibre tự mở rộng dòng ghi nguồn bản đồ khi tải xong và chỉ thu lại khi người dùng kéo bản đồ.
   * Lúc dẫn đường không ai kéo bản đồ nên dòng chữ sẽ che đồng hồ tốc độ: giữ nó ở dạng nút (i),
   * người dùng bấm vào mới mở ra.
   */
  #keepAttributionCollapsed() {
    const box = this.container.querySelector('.maplibregl-ctrl-attrib');
    if (!box) return;
    let userClickAt = 0;
    box.addEventListener('click', () => (userClickAt = performance.now()), true);
    const collapse = () => {
      if (performance.now() - userClickAt < 500) return;
      if (box.classList.contains('maplibregl-compact-show')) {
        box.classList.remove('maplibregl-compact-show');
        box.removeAttribute('open');
      }
    };
    new MutationObserver(collapse).observe(box, { attributes: true, attributeFilter: ['class', 'open'] });
    collapse();
  }

  #bindGestures() {
    const el = this.map.getCanvasContainer();
    const release = (e) => this.pointers.delete(e.pointerId);
    el.addEventListener('pointerdown', (e) => this.pointers.add(e.pointerId));
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    el.addEventListener(
      'wheel',
      () => {
        this.wheeling = true;
        this.zoomHoldUntil = performance.now() + 12000;
        clearTimeout(this.wheelTimer);
        this.wheelTimer = setTimeout(() => (this.wheeling = false), 250);
      },
      { passive: true }
    );

    // Nhấn giữ để chọn một điểm trên bản đồ (chuột phải trên máy tính).
    let timer = null;
    let start = null;
    let lastFire = 0;
    const fire = (lngLat) => {
      const now = Date.now();
      if (now - lastFire < 800) return;
      lastFire = now;
      this.handlers.onLongPress?.([lngLat.lng, lngLat.lat]);
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    this.map.on('touchstart', (e) => {
      cancel();
      if (e.points.length !== 1) return;
      start = e.point;
      timer = setTimeout(() => fire(e.lngLat), 600);
    });
    this.map.on('touchmove', (e) => {
      if (timer && start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) cancel();
    });
    this.map.on('touchend', cancel);
    this.map.on('touchcancel', cancel);
    this.map.on('contextmenu', (e) => {
      e.preventDefault();
      fire(e.lngLat);
    });
  }

  #installLayers() {
    const map = this.map;
    if (!map || map.getSource('bd-route')) return;
    for (const name of Object.keys(GLYPHS)) {
      if (!map.hasImage(`bd-${name}`)) map.addImage(`bd-${name}`, badgeImage(name), { pixelRatio: 2 });
    }
    // Chèn tuyến đường bên dưới các nhãn chữ để tên đường vẫn đọc được.
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

    map.addSource('bd-accuracy', { type: 'geojson', data: this.data.accuracy });
    map.addLayer(
      { id: 'bd-accuracy', type: 'fill', source: 'bd-accuracy', paint: { 'fill-color': ROUTE_COLOR, 'fill-opacity': 0.12 } },
      firstSymbol
    );

    map.addSource('bd-alts', { type: 'geojson', data: this.data.alts });
    map.addLayer(
      {
        id: 'bd-alts-case',
        type: 'line',
        source: 'bd-alts',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#5f7387', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 11] },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: 'bd-alts',
        type: 'line',
        source: 'bd-alts',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#b9c7d6', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 8] },
      },
      firstSymbol
    );

    map.addSource('bd-route', { type: 'geojson', data: this.data.route, lineMetrics: true });
    map.addLayer(
      {
        id: 'bd-route-case',
        type: 'line',
        source: 'bd-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b3f86', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 16, 13, 19, 22] },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: 'bd-route',
        type: 'line',
        source: 'bd-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 16, 9.5, 19, 17],
          'line-gradient': this.#gradient(),
        },
      },
      firstSymbol
    );

    map.addSource('bd-points', { type: 'geojson', data: this.data.points });
    map.addLayer({
      id: 'bd-points',
      type: 'symbol',
      source: 'bd-points',
      minzoom: 10,
      layout: {
        'icon-image': ['concat', 'bd-', ['get', 'icon']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 0.9],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    for (const [id, data] of this.learnedImages) if (!map.hasImage(id)) map.addImage(id, data, { pixelRatio: LEARNED_RATIO });
    map.addSource('bd-learned', { type: 'geojson', data: this.data.learned });
    map.addLayer({
      id: 'bd-learned',
      type: 'symbol',
      source: 'bd-learned',
      layout: {
        'icon-image': ['get', 'img'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['get', 'quiet'], 0, 1],
      },
      paint: { 'icon-opacity': ['case', ['get', 'quiet'], LEARNED_QUIET_OPACITY, 1] },
    });
  }

  #gradient() {
    const p = Math.max(0, Math.min(0.9999, this.progress));
    return ['step', ['line-progress'], ROUTE_DONE, p, ROUTE_COLOR];
  }

  #setData(name, data) {
    this.data[name] = data;
    this.map?.getSource(`bd-${name}`)?.setData(data);
  }

  /** Đổi giao diện sáng/tối của bản đồ. */
  async setTheme(dark) {
    const { style, inverted } = await this.#resolveStyle(dark);
    this.container.classList.toggle('map-inverted', inverted);
    this.map.setStyle(style, { diff: false });
  }

  /**
   * Khoảng trống cần chừa cho thanh trên, bảng dưới và cột bên trái (px).
   * left > 0 khi dùng giao diện màn hình ô tô: cột điều khiển nằm bên trái, bản đồ dùng phần còn lại.
   */
  setPadding(top, bottom, left = 0) {
    this.pad = { top, bottom, left };
  }

  setFollow(mode) {
    if (mode === this.follow) return;
    this.follow = mode;
    if (mode === 'north' && this.map && this.map.getZoom() < 14) this.zoomGoal = 15.5;
    if (mode === 'drive') this.zoomHoldUntil = 0;
    this.handlers.onFollowChange?.(mode);
  }

  setNearTurn(near) {
    this.nearTurn = near;
  }

  /** Cập nhật vị trí mới cho mũi tên; chuyển động được nội suy mượt giữa các lần định vị. */
  setPuck(fix) {
    const now = performance.now();
    const to = { lon: fix.coord[0], lat: fix.coord[1], heading: fix.heading };
    const first = !this.shown;
    const from = this.shown || to;
    const gap = this.lastFixAt ? now - this.lastFixAt : 0;
    const jump = distance([from.lon, from.lat], fix.coord) > 400;
    this.anim = { from, to, t0: now, dur: first || jump ? 0 : Math.max(250, Math.min(1300, gap)) };
    this.lastFixAt = now;
    this.targetZoom = zoomForSpeed(fix.speed, this.nearTurn);
    this.puckEl.classList.toggle('no-heading', fix.heading == null);
    this.#setData('accuracy', fix.accuracy > 15 ? { type: 'Feature', properties: {}, geometry: circlePolygon(fix.coord, fix.accuracy) } : EMPTY);
    if (first) {
      this.puck.setLngLat(fix.coord).addTo(this.map);
      if (this.follow !== 'free') this.map.jumpTo({ center: fix.coord, zoom: Math.max(this.map.getZoom(), 15.5) });
    }
  }

  hidePuck() {
    this.puck.remove();
    this.shown = null;
    this.anim = null;
    this.lastFixAt = 0;
    this.#setData('accuracy', EMPTY);
  }

  #frame = (now) => {
    this.raf = requestAnimationFrame(this.#frame);
    const a = this.anim;
    if (!a || !this.map) return;
    const k = a.dur ? Math.min(1, (now - a.t0) / a.dur) : 1;
    const lon = a.from.lon + (a.to.lon - a.from.lon) * k;
    const lat = a.from.lat + (a.to.lat - a.from.lat) * k;
    let heading = a.to.heading;
    if (a.from.heading != null && a.to.heading != null) {
      heading = a.from.heading + angleDiff(a.from.heading, a.to.heading) * k;
    } else if (heading == null) heading = a.from.heading;
    this.shown = { lon, lat, heading };
    this.puck.setLngLat([lon, lat]);
    if (heading != null) this.puck.setRotation(heading);
    if (this.follow !== 'free' && !this.pointers.size && !this.wheeling) this.#moveCamera(now);
  };

  #moveCamera(now) {
    const map = this.map;
    const drive = this.follow === 'drive';
    const zoom0 = map.getZoom();
    const pitch0 = map.getPitch();
    const bearing0 = map.getBearing();
    const wantBearing = drive ? (this.shown.heading ?? bearing0) : 0;
    const wantPitch = drive ? 50 : 0;
    let wantZoom = zoom0;
    if (drive) {
      if (now > this.zoomHoldUntil) wantZoom = this.targetZoom;
    } else if (this.zoomGoal != null) {
      wantZoom = this.zoomGoal;
      if (Math.abs(zoom0 - wantZoom) < 0.02) this.zoomGoal = null;
    }
    const bearing = bearing0 + angleDiff(bearing0, wantBearing) * 0.1;
    const pitch = pitch0 + (wantPitch - pitch0) * 0.1;
    const zoom = zoom0 + (wantZoom - zoom0) * 0.08;
    const h = this.container.clientHeight;
    const left = this.pad.left || 0;
    // Khi lái, mũi tên nằm ở phần dưới bản đồ để thấy xa phía trước, nhưng không bao giờ dưới vùng thanh trên
    // (biển chỉ dẫn, thanh cảnh báo) khi màn hình thấp như điện thoại xoay ngang. Đổi dần để bản đồ không giật
    // khi thanh cảnh báo hiện ra hay ẩn đi.
    const wantTop = Math.max(Math.round(h * 0.36), Math.min(this.pad.top, h - this.pad.bottom - 40));
    this.driveTop = this.driveTop == null || !drive ? wantTop : this.driveTop + (wantTop - this.driveTop) * 0.15;
    if (Math.abs(wantTop - this.driveTop) < 1) this.driveTop = wantTop;
    const padding = drive
      ? { top: Math.round(this.driveTop), bottom: this.pad.bottom, left, right: 0 }
      : { top: this.pad.top, bottom: this.pad.bottom, left, right: 0 };
    const key = `${this.shown.lon.toFixed(7)},${this.shown.lat.toFixed(7)},${bearing.toFixed(2)},${pitch.toFixed(2)},${zoom.toFixed(3)},${padding.top},${padding.bottom},${left}`;
    if (key === this.lastCam) return; // không có gì thay đổi: khỏi vẽ lại
    this.lastCam = key;
    map.jumpTo({ center: [this.shown.lon, this.shown.lat], bearing, pitch, zoom, padding });
  }

  /** Hiển thị các tuyến tìm được; tuyến `selected` được tô đậm. */
  setRoutes(routes, selected = 0) {
    this.progress = 0;
    this.#setData('alts', {
      type: 'FeatureCollection',
      features: routes.map((r, index) => ({ r, index })).filter((x) => x.index !== selected).map((x) => line(x.r.coords, { index: x.index })),
    });
    this.#setData('route', routes[selected] ? line(routes[selected].coords) : EMPTY);
    this.#applyGradient();
  }

  clearRoutes() {
    this.progress = 0;
    this.#setData('alts', EMPTY);
    this.#setData('route', EMPTY);
  }

  /** Tô xám phần tuyến đã đi qua (fraction: 0..1). */
  setProgress(fraction) {
    if (Math.abs(fraction - this.progress) < 0.0005) return;
    this.progress = fraction;
    this.#applyGradient();
  }

  #applyGradient() {
    if (this.map?.getLayer('bd-route')) this.map.setPaintProperty('bd-route', 'line-gradient', this.#gradient());
  }

  setPoints(points) {
    this.#setData('points', {
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, icon: p.icon, kind: p.kind },
        geometry: { type: 'Point', coordinates: p.coord },
      })),
    });
  }

  /**
   * Hiện lớp biển do camera ghi nhận: items = [{ id, coord, quiet, art, value }] (js/camui.js learnedFeatures).
   * Lớp này mặc định trống; chỉ giao diện "Xem trên bản đồ" gọi hàm này.
   */
  async setLearned(items) {
    const gen = ++this.learnedGen;
    const list = Array.isArray(items) ? items : [];
    for (const it of list) {
      const id = learnedImageId(it);
      if (this.learnedImages.has(id)) continue;
      const data = await learnedImage(it);
      if (gen !== this.learnedGen) return;
      if (!data) continue;
      this.learnedImages.set(id, data);
      if (this.map && !this.map.hasImage(id)) this.map.addImage(id, data, { pixelRatio: LEARNED_RATIO });
    }
    // Chỉ đặt dữ liệu khi mọi ảnh đã nạp, để bản đồ không báo thiếu ảnh.
    this.#setData('learned', {
      type: 'FeatureCollection',
      features: list
        .filter((it) => this.learnedImages.has(learnedImageId(it)))
        .map((it) => ({
          type: 'Feature',
          properties: { id: it.id, img: learnedImageId(it), quiet: Boolean(it.quiet) },
          geometry: { type: 'Point', coordinates: it.coord },
        })),
    });
  }

  /** Ẩn lớp biển do camera ghi nhận. */
  clearLearned() {
    this.learnedGen++;
    this.#setData('learned', EMPTY);
  }

  setDestination(coord) {
    if (coord) this.dest.setLngLat(coord).addTo(this.map);
    else this.dest.remove();
  }

  /** Thu phóng để thấy trọn tuyến đường giữa thanh trên và bảng dưới. */
  fitRoute(coords) {
    if (!coords?.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    this.setFollow('free');
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.map.fitBounds(bounds, {
      padding: { top: this.pad.top + 64, bottom: this.pad.bottom + 36, left: (this.pad.left || 0) + 44, right: 44 },
      bearing: 0,
      pitch: 0,
      duration: 700,
      maxZoom: 16.5,
    });
  }

  flyTo(coord, zoom = 16) {
    this.setFollow('free');
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.map.easeTo({
      center: coord,
      zoom: Math.max(this.map.getZoom(), zoom),
      bearing: 0,
      pitch: 0,
      duration: 700,
      padding: { top: this.pad.top, bottom: this.pad.bottom, left: this.pad.left || 0, right: 0 },
    });
  }

  get center() {
    const c = this.map.getCenter();
    return [c.lng, c.lat];
  }
}
