// Bản đồ MapLibre: lớp tuyến đường, điểm cảnh báo, mũi tên vị trí và camera bám theo xe.

/* global maplibregl */
import { angleDiff, circlePolygon, distance } from './geo.js';
import { badgeImage, GLYPHS } from './icons.js';

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

const EMPTY = { type: 'FeatureCollection', features: [] };
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
    this.data = { route: EMPTY, alts: EMPTY, points: EMPTY, accuracy: EMPTY };
    this.progress = 0;
    this.lastCam = '';
  }

  async #resolveStyle(dark) {
    const urls = dark ? [STYLE_URLS.dark, STYLE_URLS.light] : [STYLE_URLS.light];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) return { style: localizeLabels(await res.json()), inverted: dark && url !== STYLE_URLS.dark };
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
