// Điều phối toàn bộ ứng dụng: trạng thái màn hình, vòng xử lý mỗi lần định vị, và các thao tác của người dùng.

import { distance, formatClock, formatDistance, formatDuration } from './geo.js';
import { REPORT_TYPES, store } from './store.js';
import { LocationService } from './location.js';
import { MapView } from './mapview.js';
import { fetchRoutes, RouteError } from './routing.js';
import { RouteTracker } from './tracker.js';
import { clearRoadCache, RoadData } from './roaddata.js';
import { AlertEngine, describePoint, SpeedMonitor } from './alerts.js';
import { PRIORITY, voice } from './voice.js';
import { reverseGeocode, searchPlaces } from './search.js';
import { GLYPH_COLORS, glyphIcon, lineIcon, maneuverIcon } from './icons.js';

const $ = (id) => document.getElementById(id);

/** Tạo phần tử DOM. Chữ luôn đi qua textContent nên dữ liệu từ dịch vụ ngoài không chèn được HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // chỉ dùng cho SVG do ứng dụng tự sinh
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const lowerFirst = (s) => (s ? s[0].toLocaleLowerCase('vi') + s.slice(1) : s);

const state = {
  mode: 'browse', // 'browse' | 'place' | 'routes' | 'nav' | 'drive'
  fix: null,
  place: null,
  routes: [],
  selected: 0,
  route: null,
  tracker: null,
  progress: null,
  simulate: false,
  simFactor: 1,
  rerouting: false,
  lastRerouteAt: 0,
  trip: null,
  dark: false,
  wakeLock: null,
  alertId: null,
  navIconKey: '',
  movingCount: 0,
  noAutoDriveUntil: 0,
  routeAbort: null,
  searchAbort: null,
  lastSavedPos: 0,
};

const locator = new LocationService();
const roads = new RoadData();
const alerts = new AlertEngine();
let speedMon = new SpeedMonitor();

const map = new MapView($('map'), {
  onFollowChange: (mode) => $('btnLocate').classList.toggle('active', mode !== 'free'),
  onLongPress: (coord) => pickOnMap(coord),
  onPointClick: (props) => showPoint(props),
  onAltClick: (index) => selectRoute(index),
});

// ---------- Tiện ích giao diện ----------

let toastTimer = null;
function toast(message, ms = 3200) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function syncLayout() {
  const sheetH = $('sheet').offsetHeight;
  document.documentElement.style.setProperty('--sheet-h', `${sheetH}px`);
  map.setPadding($('top').offsetHeight + 8, sheetH);
}

function setMode(mode) {
  state.mode = mode;
  for (const v of document.querySelectorAll('#sheet .view')) v.hidden = v.dataset.view !== mode;
  $('searchBar').hidden = mode === 'nav';
  $('navSign').hidden = mode !== 'nav';
  if (mode !== 'nav') $('navThen').hidden = true;
  if (mode !== 'nav' && mode !== 'drive') renderAlert({ active: null });
  updateWakeLock();
  syncLayout();
}

// Mỗi bảng/hộp thoại mở ra được ghi một mục vào lịch sử trình duyệt để nút Quay lại của điện thoại
// đóng bảng trên cùng thay vì thoát ứng dụng.
const overlayStack = [];
let ignorePop = false;

function openOverlay(id) {
  $(id).hidden = false;
  if (overlayStack.includes(id)) return;
  overlayStack.push(id);
  history.pushState({ overlay: overlayStack.length }, '');
}

/** Đóng mọi bảng đang mở (khi người dùng bấm nút đóng hoặc chọn xong). */
function closeOverlays() {
  const n = overlayStack.length;
  if (!n) return;
  for (const id of overlayStack) $(id).hidden = true;
  overlayStack.length = 0;
  ignorePop = true;
  history.go(-n);
}

/** Người dùng bấm nút Quay lại: chỉ đóng bảng trên cùng. */
function onPopState() {
  if (ignorePop) {
    ignorePop = false;
    return;
  }
  const id = overlayStack.pop();
  if (id) $(id).hidden = true;
}

function openModal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(body);
  openOverlay('modal');
}

function wantDark() {
  const t = store.settings.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  const h = new Date().getHours();
  return h >= 18 || h < 6;
}

function applyTheme(force = false) {
  const dark = wantDark();
  if (!force && dark === state.dark) return;
  state.dark = dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#17222e' : '#0a57a4';
  if (map.map) map.setTheme(dark);
}

function applyAudio() {
  const s = store.settings;
  voice.enabled = s.voice && !s.muted;
  voice.beeps = s.beeps && !s.muted;
  $('btnMute').firstElementChild.innerHTML = lineIcon(s.muted ? 'mute' : 'volume');
  $('btnMute').classList.toggle('off', s.muted);
  if (s.muted) voice.stop();
}

async function updateWakeLock() {
  const need =
    store.settings.keepAwake &&
    (state.mode === 'nav' || state.mode === 'drive') &&
    document.visibilityState === 'visible';
  try {
    if (need && !state.wakeLock && 'wakeLock' in navigator) {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
      });
    } else if (!need && state.wakeLock) {
      const lock = state.wakeLock;
      state.wakeLock = null;
      await lock.release();
    }
  } catch {
    /* thiết bị từ chối giữ màn hình sáng: không ảnh hưởng chức năng khác */
  }
}

// ---------- Điểm cảnh báo trên bản đồ ----------

const reportPoints = () => store.reports.map((r) => ({ id: r.id, kind: 'report', type: r.type, coord: r.coord }));

function refreshPoints() {
  const list = [
    ...roads.allPoints().map((p) => ({ ...p, icon: describePoint(p).icon })),
    ...reportPoints().map((p) => ({ ...p, icon: REPORT_TYPES[p.type].icon })),
  ];
  map.setPoints(list);
}

function showPoint(props) {
  const report = store.reports.find((r) => r.id === props.id);
  if (report) {
    const def = REPORT_TYPES[report.type];
    const when = new Date(report.time);
    const body = el(
      'div',
      { class: 'view' },
      el('p', { class: 'sub' }, `Bạn đánh dấu lúc ${formatClock(when)} ngày ${when.toLocaleDateString('vi-VN')}.`),
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: () => {
            store.removeReport(report.id);
            closeOverlays();
            toast('Đã xoá điểm đánh dấu.');
          },
        },
        el('span', { html: lineIcon('trash', 18) }),
        el('span', {}, 'Xoá điểm này')
      )
    );
    openModal(def.label, body);
    return;
  }
  const point = roads.allPoints().find((p) => p.id === props.id);
  if (!point) return;
  openModal(
    describePoint(point).title,
    el('p', { class: 'sub' }, 'Nguồn: dữ liệu mở OpenStreetMap. Vị trí thực tế có thể đã thay đổi.')
  );
}

function openReport() {
  voice.unlock();
  const coord = state.fix?.coord || map.center;
  const grid = el('div', { class: 'report-grid' });
  for (const [type, def] of Object.entries(REPORT_TYPES)) {
    const badge = el('span', { class: 'report-badge', html: glyphIcon(def.icon, 26) });
    badge.style.background = GLYPH_COLORS[def.icon];
    grid.append(
      el(
        'button',
        {
          class: 'report-btn',
          type: 'button',
          onclick: () => {
            store.addReport(type, coord);
            closeOverlays();
            voice.chime('done');
            toast(`Đã đánh dấu: ${def.label}.`);
          },
        },
        badge,
        el('span', {}, def.label)
      )
    );
  }
  const where = state.fix ? 'tại vị trí hiện tại của bạn' : 'tại tâm bản đồ (chưa có vị trí GPS)';
  openModal(
    'Đánh dấu điểm cảnh báo',
    el(
      'div',
      { class: 'view' },
      el('p', { class: 'sub' }, `Điểm sẽ được đặt ${where} và lưu trên thiết bị này. Lần sau đi qua, ứng dụng sẽ nhắc bạn.`),
      grid
    )
  );
}

// ---------- Tốc độ và cảnh báo ----------

function renderSpeed(fix, sp) {
  $('speedo').hidden = false;
  $('speedValue').textContent = String(Math.round(fix.speed * 3.6));
  const box = $('speedBox');
  box.classList.toggle('near', sp.level === 'near');
  box.classList.toggle('over', sp.level === 'over');
  const sign = $('limitSign');
  sign.hidden = sp.limit == null;
  if (sp.limit != null) $('limitValue').textContent = String(sp.limit);
  sign.classList.toggle('custom', sp.source === 'custom');
}

function renderAlert(result) {
  const bar = $('alertBar');
  if (!result.active) {
    if (!bar.hidden) {
      bar.hidden = true;
      syncLayout();
    }
    state.alertId = null;
    return;
  }
  const { point, distance: d, info, reach } = result.active;
  if (state.alertId !== point.id) {
    state.alertId = point.id;
    $('alertIcon').innerHTML = glyphIcon(info.icon, 26);
    $('alertTitle').textContent = info.title;
  }
  $('alertDist').textContent = formatDistance(d);
  $('alertMeter').style.width = `${Math.round(100 * (1 - Math.min(1, d / reach)))}%`;
  if (bar.hidden) {
    bar.hidden = false;
    syncLayout();
  }
}

// ---------- Dẫn đường ----------

function renderNav(p) {
  const next = p.next || p.step;
  $('navDist').textContent = p.next ? formatDistance(p.distToNext) : '';
  $('navInstr').textContent = next.text;
  const key = JSON.stringify(next.icon);
  if (key !== state.navIconKey) {
    state.navIconKey = key;
    $('navIcon').innerHTML = maneuverIcon(next.icon);
  }
  $('navSign').classList.toggle('expressway', Boolean(p.step.expressway));

  const stepS = state.tracker.stepS;
  const after = state.route.steps[p.stepIndex + 2];
  const then = $('navThen');
  if (after && stepS[p.stepIndex + 2] - stepS[p.stepIndex + 1] < 250) {
    then.replaceChildren(
      el('span', {}, 'Sau đó'),
      el('span', { html: maneuverIcon(after.icon, 22) }),
      el('span', {}, lowerFirst(after.short))
    );
    then.hidden = false;
  } else then.hidden = true;

  $('navEta').textContent = formatClock(new Date(Date.now() + p.remainingDuration * 1000));
  $('navRemain').textContent = `${formatDuration(p.remainingDuration)} · ${formatDistance(p.remainingDistance)}`;
}

function renderSteps() {
  const list = $('stepList');
  list.replaceChildren();
  const steps = state.route?.steps || [];
  const current = (state.progress?.stepIndex ?? -1) + 1;
  steps.forEach((st, i) => {
    list.append(
      el(
        'li',
        { class: i === current ? 'step current' : 'step' },
        el('span', { class: 'step-icon', html: maneuverIcon(st.icon, 28) }),
        el('span', { class: 'step-text' }, st.text),
        el('span', { class: 'step-dist' }, i > 0 ? formatDistance(steps[i - 1].distance) : '')
      )
    );
  });
}

function beginRoute(route) {
  state.route = route;
  state.tracker = new RouteTracker(route);
  state.progress = null;
  state.navIconKey = '';
  map.setRoutes([route], 0);
  map.setDestination(state.place.coord);
  // Trước khi có định vị đầu tiên: hiện sẵn chỗ rẽ đầu tiên.
  const first = route.steps[1] || route.steps[0];
  $('navDist').textContent = formatDistance(route.steps[0].distance);
  $('navInstr').textContent = first.text;
  $('navIcon').innerHTML = maneuverIcon(first.icon);
  $('navEta').textContent = formatClock(new Date(Date.now() + route.duration * 1000));
  $('navRemain').textContent = `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`;
}

function startNav(simulate) {
  const route = state.routes[state.selected];
  if (!route) return;
  voice.unlock();
  state.simulate = simulate;
  state.simFactor = 1;
  beginRoute(route);
  setMode('nav');
  map.setFollow('drive');
  startTrip();
  $('btnSimSpeed').hidden = !simulate;
  $('btnSimSpeed').textContent = '×1';
  if (simulate) {
    speedMon = new SpeedMonitor();
    locator.startSimulation(route, 1);
  } else if (state.fix) onFix(state.fix);
  else toast('Chưa có vị trí GPS. Chỉ dẫn sẽ bắt đầu khi có tín hiệu.');
}

function endNav(arrived = false) {
  const wasSim = state.simulate;
  closeOverlays();
  $('btnSimSpeed').hidden = true;
  locator.stopSimulation();
  state.simulate = false;
  state.route = null;
  state.tracker = null;
  state.progress = null;
  map.clearRoutes();
  map.setDestination(null);
  map.setNearTurn(false);
  if (!arrived) voice.stop(); // đến nơi thì để máy đọc hết câu báo đến nơi
  const summary = finishTrip();
  setMode('browse');
  map.setFollow('north');
  if (wasSim) {
    // Xoá vị trí mô phỏng; mũi tên sẽ hiện lại khi có GPS thật.
    state.fix = null;
    map.hidePuck();
    $('speedo').hidden = true;
    speedMon = new SpeedMonitor();
    locator.resumeReal();
  }
  if (summary) showSummary(summary, arrived ? 'Bạn đã đến nơi' : 'Kết thúc chuyến đi');
}

async function reroute() {
  if (state.rerouting || state.simulate || Date.now() - state.lastRerouteAt < 8000) return;
  state.rerouting = true;
  toast('Bạn đã đi lệch tuyến. Đang tìm lại đường…');
  voice.speak('Đang tìm lại đường', PRIORITY.turn);
  try {
    const fix = state.fix;
    const { routes } = await fetchRoutes(fix.coord, state.place.coord, {
      vehicle: store.settings.vehicle,
      avoidTolls: store.settings.avoidTolls,
      heading: fix.speed > 3 ? fix.heading : null,
    });
    if (state.mode === 'nav') beginRoute(routes[0]);
  } catch (err) {
    toast(err instanceof RouteError ? err.message : 'Chưa tìm lại được đường. Sẽ thử lại.');
  } finally {
    state.rerouting = false;
    state.lastRerouteAt = Date.now();
  }
}

// ---------- Chế độ lái tự do (không đặt điểm đến) ----------

function startDrive(auto = false) {
  voice.unlock();
  state.simulate = false;
  setMode('drive');
  map.setFollow('drive');
  startTrip();
  if (auto) toast('Bạn đang di chuyển — đã bật chế độ lái.');
}

function endDrive() {
  const summary = finishTrip();
  setMode('browse');
  map.setFollow('north');
  state.noAutoDriveUntil = Date.now() + 10 * 60e3; // người dùng vừa chủ động tắt: đừng tự bật lại ngay
  if (summary) showSummary(summary, 'Kết thúc chuyến đi');
}

// ---------- Thống kê chuyến đi ----------

function startTrip() {
  state.trip = { t0: null, last: null, distance: 0, moving: 0, max: 0, simulated: state.simulate };
}

function updateTrip(fix) {
  const t = state.trip;
  if (!t) return;
  if (t.last) {
    const dt = fix.time - t.last.time;
    if (dt > 0 && dt < 15000 && fix.speed > 0.8) {
      t.distance += distance(t.last.coord, fix.coord);
      t.moving += dt;
    }
  } else t.t0 = fix.time;
  t.max = Math.max(t.max, fix.speed);
  t.last = fix;
  if (state.mode === 'drive') {
    $('driveDist').textContent = formatDistance(t.distance);
    $('driveInfo').textContent =
      t.moving > 20000
        ? `${formatDuration(t.moving / 1000)} · trung bình ${Math.round((t.distance / t.moving) * 3600)} km/h`
        : 'Đang theo dõi tốc độ và điểm cảnh báo';
  }
}

function finishTrip() {
  const t = state.trip;
  state.trip = null;
  if (!t || !t.last || t.distance < 100) return null;
  const summary = {
    time: Date.now(),
    distance: Math.round(t.distance),
    duration: Math.round((t.last.time - t.t0) / 1000),
    avg: t.moving > 0 ? Math.round((t.distance / t.moving) * 3600) : 0,
    max: Math.round(t.max * 3.6),
    simulated: t.simulated,
  };
  if (!t.simulated && t.distance > 300) store.addTrip(summary);
  return summary;
}

function showSummary(s, title) {
  const stat = (value, label) => el('div', { class: 'stat' }, el('b', {}, value), el('span', {}, label));
  openModal(
    title,
    el(
      'div',
      { class: 'view' },
      el(
        'div',
        { class: 'stats' },
        stat(formatDistance(s.distance), 'Quãng đường'),
        stat(formatDuration(s.duration), 'Thời gian'),
        stat(`${s.avg} km/h`, 'Tốc độ trung bình'),
        stat(`${s.max} km/h`, 'Tốc độ cao nhất')
      ),
      s.simulated ? el('p', { class: 'sub' }, 'Đây là chuyến chạy thử nên không được lưu vào nhật ký.') : null
    )
  );
}

// ---------- Vòng xử lý mỗi lần định vị ----------

function onFix(fix) {
  state.fix = fix;
  const driving = state.mode === 'nav' || state.mode === 'drive';
  let shown = fix;
  let nav = null;

  if (state.mode === 'nav' && state.tracker) {
    const p = state.tracker.update(fix);
    state.progress = p;
    if (p.onRoute) {
      // Bám mũi tên vào tuyến để không bị giật theo sai số GPS.
      shown = { ...fix, coord: p.snapped, heading: fix.speed > 1 ? p.routeBearing : fix.heading };
      nav = { route: state.route, seg: state.tracker.seg, s: p.s };
    }
    renderNav(p);
    map.setProgress(state.tracker.total ? p.s / state.tracker.total : 0);
    map.setNearTurn(p.next != null && p.distToNext < 160);
    if (p.cue) {
      if (p.cue.level === 'near') voice.chime('turn');
      voice.speak(p.cue.text, PRIORITY.turn);
    }
    if (p.arrived) {
      map.setPuck(shown);
      setTimeout(() => state.mode === 'nav' && endNav(true), 1200);
      return;
    }
    if (p.offRoute) reroute();
  }

  map.setPuck(shown);
  roads.ensureAround(fix.coord, fix.speed > 2 ? fix.heading : null);

  const s = store.settings;
  const match = roads.matchWay(fix, state.progress?.step?.name || '');
  const sp = speedMon.update(fix, match, {
    vehicle: s.vehicle,
    tolerance: s.overTolerance,
    customMax: s.customMax,
    hasData: roads.hasData(fix.coord),
  });
  renderSpeed(fix, sp);

  if (driving) {
    if (sp.sound === 'voice') {
      voice.chime('over');
      voice.speak(`Bạn đang chạy quá tốc độ. Giới hạn ${sp.limit} ki lô mét trên giờ`, PRIORITY.alert);
    } else if (sp.sound === 'beep') voice.chime('over');
    else if (sp.announce && s.speakLimit) {
      voice.speak(`Giới hạn tốc độ ${sp.announce} ki lô mét trên giờ`, PRIORITY.info);
    }

    const near = [...roads.pointsNear(fix.coord, 1300), ...reportPoints()];
    const result = alerts.update(fix, near, s, nav);
    renderAlert(result);
    if (result.fired) {
      voice.chime('alert');
      voice.speak(result.say, PRIORITY.alert);
    }
    updateTrip(fix);
  } else if (state.mode === 'browse') {
    // Đang chạy xe mà chưa bật chế độ lái thì tự bật để vẫn có cảnh báo.
    const mayAuto = !fix.simulated && Date.now() > state.noAutoDriveUntil;
    state.movingCount = mayAuto && fix.speed >= 4 ? state.movingCount + 1 : 0;
    if (state.movingCount >= 4) {
      state.movingCount = 0;
      startDrive(true);
    }
  }

  if (!fix.simulated) {
    const status = $('gpsStatus');
    status.classList.remove('warn');
    status.textContent =
      fix.accuracy > 50
        ? `Tín hiệu GPS yếu (sai số khoảng ${Math.round(fix.accuracy)} m)`
        : `Đã có vị trí (sai số khoảng ${Math.max(1, Math.round(fix.accuracy))} m)`;
    if (Date.now() - state.lastSavedPos > 30000) {
      state.lastSavedPos = Date.now();
      try {
        localStorage.setItem('banduong:lastpos', JSON.stringify(fix.coord));
      } catch {
        /* bỏ qua */
      }
    }
  }
}

// ---------- Địa điểm, tìm kiếm, chọn tuyến ----------

function showPlace(place, fly = true) {
  state.place = place;
  $('placeName').textContent = place.name;
  const far = state.fix ? `Cách bạn ${formatDistance(distance(state.fix.coord, place.coord))}` : '';
  $('placeAddress').textContent = [place.address, far].filter(Boolean).join(' · ');
  map.clearRoutes();
  map.setDestination(place.coord);
  setMode('place');
  if (fly) map.flyTo(place.coord, 15.5);
}

function closePlace() {
  state.routeAbort?.abort();
  state.place = null;
  state.routes = [];
  map.clearRoutes();
  map.setDestination(null);
  setMode('browse');
}

async function pickOnMap(coord) {
  if (state.mode === 'nav' || state.mode === 'routes') return;
  showPlace({ name: 'Điểm đã chọn', address: `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`, coord }, false);
  try {
    const place = await reverseGeocode(coord);
    if (state.place && state.place.coord === coord) showPlace(place, false);
  } catch {
    /* giữ nguyên toạ độ nếu không tra được tên */
  }
}

function setVehicleButtons() {
  const moto = store.settings.vehicle === 'moto';
  for (const [id, on] of [['vehCar', !moto], ['vehMoto', moto], ['setCar', !moto], ['setMoto', moto]]) {
    $(id).setAttribute('aria-pressed', String(on));
  }
}

function renderRoutes() {
  const list = $('routeList');
  list.replaceChildren();
  state.routes.forEach((r, i) => {
    const tags = el('div', { class: 'tags' });
    if (r.hasMotorway) tags.append(el('span', { class: 'tag green' }, 'Cao tốc'));
    if (r.hasToll) tags.append(el('span', { class: 'tag' }, 'Thu phí'));
    if (r.hasFerry) tags.append(el('span', { class: 'tag' }, 'Phà'));
    list.append(
      el(
        'button',
        { class: 'route-card', type: 'button', 'aria-pressed': String(i === state.selected), onclick: () => selectRoute(i) },
        el('div', { class: 'route-time' }, formatDuration(r.duration)),
        el('div', { class: 'route-meta' }, formatDistance(r.distance)),
        r.summary ? el('div', { class: 'route-via' }, `Qua ${r.summary}`) : null,
        tags.childElementCount ? tags : null
      )
    );
  });
}

function selectRoute(index) {
  if (state.mode !== 'routes' || !state.routes[index]) return;
  state.selected = index;
  renderRoutes();
  map.setRoutes(state.routes, index);
}

async function planRoute() {
  const place = state.place;
  if (!place) return;
  const origin = state.fix?.coord || map.center;
  if (!state.fix) toast('Chưa có vị trí GPS — tạm lấy tâm bản đồ làm điểm xuất phát.');
  state.routes = [];
  $('routesTitle').textContent = `Đến ${place.name}`;
  $('routesNote').textContent = 'Đang tìm đường…';
  $('routeList').replaceChildren();
  $('btnStart').disabled = true;
  $('btnSimulate').disabled = true;
  setVehicleButtons();
  setMode('routes');

  state.routeAbort?.abort();
  const abort = (state.routeAbort = new AbortController());
  try {
    const moto = store.settings.vehicle === 'moto';
    const { routes, relaxed } = await fetchRoutes(origin, place.coord, {
      vehicle: store.settings.vehicle,
      avoidTolls: store.settings.avoidTolls,
      signal: abort.signal,
    });
    if (abort.signal.aborted || state.mode !== 'routes') return;
    state.routes = routes;
    state.selected = 0;
    const notes = [`${routes.length} tuyến cho ${moto ? 'xe máy' : 'ô tô'}`];
    if (relaxed) notes.push(moto ? 'không tìm được tuyến tránh cao tốc, hãy kiểm tra kỹ trước khi đi' : 'không tránh được hết đường thu phí');
    else if (moto) notes.push('đã tránh đường cao tốc');
    $('routesNote').textContent = `${notes.join(' · ')}.`;
    $('btnStart').disabled = false;
    $('btnSimulate').disabled = false;
    renderRoutes();
    map.setRoutes(routes, 0);
    syncLayout();
    map.fitRoute(routes[0].coords);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    $('routesNote').textContent = err instanceof RouteError ? err.message : 'Không tìm được đường. Hãy thử lại.';
    syncLayout();
  }
}

function goSaved(slot) {
  const place = store.places[slot];
  if (!place) {
    toast(`Chưa lưu địa chỉ ${slot === 'home' ? 'Nhà' : 'Cơ quan'}. Hãy tìm địa điểm rồi bấm nút lưu.`);
    openSearch();
    return;
  }
  showPlace(place, false);
  planRoute();
}

function resultRow(place, icon, onPick) {
  const far = state.fix ? formatDistance(distance(state.fix.coord, place.coord)) : '';
  return el(
    'button',
    { class: 'result', type: 'button', onclick: onPick },
    el('span', { class: 'result-icon', html: lineIcon(icon, 20) }),
    el(
      'span',
      { class: 'result-text' },
      el('div', { class: 'result-name' }, place.name),
      place.address ? el('div', { class: 'result-addr' }, place.address) : null
    ),
    far ? el('span', { class: 'result-dist' }, far) : null
  );
}

function pickResult(place) {
  store.addRecent(place);
  closeOverlays();
  showPlace(place);
}

function renderSearchHome() {
  const body = $('searchBody');
  body.replaceChildren();
  const saved = [
    ['home', 'Nhà', 'home'],
    ['work', 'Cơ quan', 'work'],
  ].filter(([slot]) => store.places[slot]);
  if (saved.length) {
    body.append(el('div', { class: 'list-label' }, 'Đã lưu'));
    for (const [slot, label, icon] of saved) {
      const p = store.places[slot];
      body.append(resultRow({ ...p, name: label, address: [p.name, p.address].filter(Boolean).join(', ') }, icon, () => pickResult(p)));
    }
  }
  if (store.places.recents.length) {
    body.append(el('div', { class: 'list-label' }, 'Tìm gần đây'));
    for (const p of store.places.recents) body.append(resultRow(p, 'recent', () => pickResult(p)));
  }
  if (!body.childElementCount) {
    body.append(el('p', { class: 'empty' }, 'Gõ tên địa điểm, địa chỉ hoặc toạ độ (ví dụ: 10.7769, 106.7009). Bạn cũng có thể nhấn giữ trên bản đồ để chọn điểm đến.'));
  }
}

async function runSearch(query, thorough) {
  const q = query.trim();
  state.searchAbort?.abort();
  if (q.length < 2) {
    renderSearchHome();
    return;
  }
  const abort = (state.searchAbort = new AbortController());
  const body = $('searchBody');
  if (thorough) body.replaceChildren(el('p', { class: 'empty' }, 'Đang tìm…'));
  try {
    const results = await searchPlaces(q, { near: state.fix?.coord || map.center, signal: abort.signal, thorough });
    if (abort.signal.aborted) return;
    body.replaceChildren();
    if (!results.length) {
      body.append(el('p', { class: 'empty' }, thorough ? 'Không tìm thấy địa điểm phù hợp. Hãy thử từ khoá khác.' : 'Chưa có gợi ý. Bấm tìm để tra kỹ hơn.'));
      return;
    }
    for (const p of results) body.append(resultRow(p, 'pin', () => pickResult(p)));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    body.replaceChildren(el('p', { class: 'empty' }, 'Không kết nối được dịch vụ tìm kiếm. Hãy kiểm tra mạng rồi thử lại.'));
  }
}

function openSearch() {
  openOverlay('searchPanel');
  const input = $('searchInput');
  input.value = '';
  renderSearchHome();
  input.focus();
}

// ---------- Cài đặt ----------

function renderSettings() {
  const s = store.settings;
  $('optAvoidTolls').checked = s.avoidTolls;
  $('optVoice').checked = s.voice;
  $('optBeeps').checked = s.beeps;
  $('optSpeakLimit').checked = s.speakLimit;
  $('optTolerance').value = String(s.overTolerance);
  $('optCustomMax').value = String(s.customMax);
  $('optCamera').checked = s.alertCamera;
  $('optToll').checked = s.alertToll;
  $('optRail').checked = s.alertRail;
  $('optReport').checked = s.alertReport;
  $('optTheme').value = s.theme;
  $('optAwake').checked = s.keepAwake;
  setVehicleButtons();

  const n = store.reports.length;
  $('reportCount').textContent = n
    ? `Bạn đang có ${n} điểm đánh dấu trên thiết bị này. Xuất tệp để sao lưu hoặc gửi cho người khác; nhập tệp để thêm điểm từ người khác.`
    : 'Bạn chưa đánh dấu điểm nào. Bấm nút tam giác cảnh báo trên bản đồ khi đi qua nơi cần nhớ.';
  $('btnExport').disabled = n === 0;

  const hint = $('voiceState').querySelector('small');
  hint.textContent =
    voice.hasVietnamese === false
      ? 'Máy chưa có giọng đọc tiếng Việt. Hãy cài dữ liệu giọng nói tiếng Việt trong phần cài đặt "Chuyển văn bản thành giọng nói" của thiết bị.'
      : 'Bấm để nghe thử.';

  const trips = $('tripList');
  trips.replaceChildren();
  if (!store.trips.length) trips.append(el('p', { class: 'note' }, 'Chưa có chuyến đi nào được ghi lại.'));
  for (const t of store.trips.slice(0, 6)) {
    const d = new Date(t.time);
    trips.append(
      el(
        'div',
        { class: 'trip' },
        el('b', {}, `${d.toLocaleDateString('vi-VN')} ${formatClock(d)}`),
        el('span', {}, `${formatDistance(t.distance)} · ${formatDuration(t.duration)} · cao nhất ${t.max} km/h`)
      )
    );
  }
}

function bindSettings() {
  const toggles = {
    optAvoidTolls: 'avoidTolls',
    optVoice: 'voice',
    optBeeps: 'beeps',
    optSpeakLimit: 'speakLimit',
    optCamera: 'alertCamera',
    optToll: 'alertToll',
    optRail: 'alertRail',
    optReport: 'alertReport',
    optAwake: 'keepAwake',
  };
  for (const [id, key] of Object.entries(toggles)) {
    $(id).addEventListener('change', (e) => {
      store.set(key, e.target.checked);
      applyAudio();
      updateWakeLock();
    });
  }
  $('optTolerance').addEventListener('change', (e) => store.set('overTolerance', Number(e.target.value)));
  $('optCustomMax').addEventListener('change', (e) => store.set('customMax', Number(e.target.value)));
  $('optTheme').addEventListener('change', (e) => {
    store.set('theme', e.target.value);
    applyTheme();
  });

  const setVehicle = (v, replan) => {
    store.set('vehicle', v);
    setVehicleButtons();
    speedMon = new SpeedMonitor();
    if (replan && state.mode === 'routes') planRoute();
  };
  $('setCar').addEventListener('click', () => setVehicle('car', false));
  $('setMoto').addEventListener('click', () => setVehicle('moto', false));
  $('vehCar').addEventListener('click', () => setVehicle('car', true));
  $('vehMoto').addEventListener('click', () => setVehicle('moto', true));

  $('btnVoiceTest').addEventListener('click', () => {
    voice.unlock();
    const wasEnabled = voice.enabled;
    voice.enabled = true;
    const ok = voice.speak('Xin chào. Bạn Đường sẽ nhắc bạn khi sắp rẽ và khi có cảnh báo phía trước.', PRIORITY.turn);
    voice.enabled = wasEnabled;
    if (!ok) toast('Trình duyệt này không hỗ trợ giọng đọc.');
  });

  $('btnExport').addEventListener('click', () => {
    const data = { app: 'ban-duong', version: 1, reports: store.reports };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `ban-duong-diem-danh-dau-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const added = store.importReports(Array.isArray(data) ? data : data?.reports);
      toast(added ? `Đã thêm ${added} điểm đánh dấu.` : 'Tệp không có điểm mới nào.');
      renderSettings();
    } catch {
      toast('Không đọc được tệp. Hãy chọn tệp .json do Bạn Đường xuất ra.');
    }
  });

  $('btnClearCache').addEventListener('click', async () => {
    await clearRoadCache();
    toast('Đã xoá dữ liệu đường đã lưu. Dữ liệu mới sẽ được tải khi bạn di chuyển.');
  });
}

// ---------- Khởi động ----------

function bind() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    node.innerHTML = lineIcon(node.dataset.icon, Number(node.dataset.size) || 24);
  }
  // Âm thanh chỉ phát được sau lần chạm đầu tiên.
  window.addEventListener('pointerdown', () => voice.unlock(), { once: true });
  window.addEventListener('popstate', onPopState);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlays();
  });
  document.addEventListener('visibilitychange', updateWakeLock);

  $('btnSearch').addEventListener('click', openSearch);
  $('btnSearchBack').addEventListener('click', () => closeOverlays());
  let debounce = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(e.target.value, false), 350);
  });
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    runSearch($('searchInput').value, true);
    $('searchInput').blur();
  });

  $('btnSettings').addEventListener('click', () => {
    renderSettings();
    openOverlay('settingsPanel');
  });
  $('btnSettingsBack').addEventListener('click', () => closeOverlays());
  $('btnSteps').addEventListener('click', () => {
    renderSteps();
    openOverlay('stepsPanel');
  });
  $('btnStepsBack').addEventListener('click', () => closeOverlays());
  $('btnModalClose').addEventListener('click', () => closeOverlays());
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeOverlays();
  });

  $('btnMute').addEventListener('click', () => {
    store.set('muted', !store.settings.muted);
    applyAudio();
    toast(store.settings.muted ? 'Đã tắt âm thanh.' : 'Đã bật âm thanh.');
  });
  $('btnReport').addEventListener('click', openReport);
  $('btnLocate').addEventListener('click', () => {
    if (!state.fix) {
      toast('Chưa có vị trí. Hãy bật GPS và cho phép trang này dùng vị trí.');
      locator.stop();
      locator.start();
      return;
    }
    map.setFollow(state.mode === 'nav' || state.mode === 'drive' ? 'drive' : 'north');
  });

  $('chipHome').addEventListener('click', () => goSaved('home'));
  $('chipWork').addEventListener('click', () => goSaved('work'));
  $('btnDrive').addEventListener('click', () => startDrive(false));
  $('btnEndDrive').addEventListener('click', endDrive);

  $('btnPlaceClose').addEventListener('click', closePlace);
  $('btnRoute').addEventListener('click', planRoute);
  $('btnSaveHome').addEventListener('click', () => {
    store.savePlace('home', state.place);
    toast('Đã lưu làm địa chỉ Nhà.');
  });
  $('btnSaveWork').addEventListener('click', () => {
    store.savePlace('work', state.place);
    toast('Đã lưu làm địa chỉ Cơ quan.');
  });

  $('btnRoutesClose').addEventListener('click', () => {
    state.routeAbort?.abort();
    if (state.place) showPlace(state.place);
    else closePlace();
  });
  $('btnStart').addEventListener('click', () => startNav(false));
  $('btnSimulate').addEventListener('click', () => startNav(true));
  $('btnEndNav').addEventListener('click', () => endNav(false));
  $('btnSimSpeed').addEventListener('click', () => {
    state.simFactor = state.simFactor === 1 ? 2 : state.simFactor === 2 ? 5 : 1;
    locator.setSimulationFactor(state.simFactor);
    $('btnSimSpeed').textContent = `×${state.simFactor}`;
  });

  bindSettings();
}

async function boot() {
  bind();
  applyAudio();
  state.dark = wantDark();
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';

  let center = [106.2, 16.2]; // toàn cảnh Việt Nam cho tới khi có GPS
  let zoom = 4.8;
  try {
    const saved = JSON.parse(localStorage.getItem('banduong:lastpos') || 'null');
    if (Array.isArray(saved) && Number.isFinite(saved[0]) && Number.isFinite(saved[1])) {
      center = saved;
      zoom = 14;
    }
  } catch {
    /* bỏ qua */
  }

  try {
    await map.init({ dark: state.dark, center, zoom });
  } catch (err) {
    console.error(err);
    $('gpsStatus').classList.add('warn');
    $('gpsStatus').textContent = 'Thiết bị hoặc trình duyệt này không hiển thị được bản đồ (cần hỗ trợ WebGL).';
    return;
  }

  new ResizeObserver(syncLayout).observe($('sheet'));
  new ResizeObserver(syncLayout).observe($('top'));
  syncLayout();
  refreshPoints();

  roads.onUpdate(refreshPoints);
  store.onChange((what) => {
    if (what === 'reports') refreshPoints();
  });
  locator.on(onFix);
  locator.onError((err) => {
    const status = $('gpsStatus');
    status.classList.add('warn');
    status.textContent = err.message;
  });
  locator.start();

  setInterval(() => {
    applyTheme();
    if (store.pruneReports()) refreshPoints();
  }, 5 * 60e3);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
