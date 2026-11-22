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
import { SignEngine } from './signengine.js';
import { categoryEnabled, formatNumberVi, lookupSign, SIGN_CATEGORIES } from './signs.js';
import { signSvg } from './signart.js';
import {
  CarWatch,
  createBleTransport,
  createSerialTransport,
  describeConnectError,
  detectSupport,
  ObdClient,
  ObdError,
  reopenSerial,
  requestBleDevice,
  requestSerialPort,
} from './obd.js';

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
  alertKey: null, // mục đang hiện trên thanh cảnh báo: 'p:<id điểm>' hoặc 's:<khoá biển>'
  alertSign: null, // { item, distance } khi thanh cảnh báo đang hiện một biển báo
  stripKey: '',
  limitSaid: new Map(), // giới hạn tốc độ (km/h) → lúc bộ máy biển báo vừa đọc (ms)
  lastFixAt: 0, // lúc nhận lần định vị gần nhất (đồng hồ máy, ms)
  lastMatch: null, // đoạn đường khớp gần nhất, dùng khi mất GPS mà xe vẫn báo tốc độ
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
const signs = new SignEngine();
let speedMon = new SpeedMonitor();

// Kết nối với ô tô qua bộ OBD-II.
const car = {
  support: detectSupport(),
  client: null,
  state: 'idle',
  info: null,
  snap: null,
  watch: new CarWatch(),
  dtc: null, // kết quả đọc mã lỗi gần nhất: { loading } | { codes } | { error }
  onlyAt: 0, // lần gần nhất cập nhật tốc độ chỉ bằng dữ liệu xe (lúc mất GPS)
};

const isDriving = () => state.mode === 'nav' || state.mode === 'drive';

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
  if (document.documentElement.classList.contains('car-ui')) {
    // Màn hình ô tô: thanh trên và bảng dưới là một cột bên trái, bản đồ dùng phần còn lại.
    map.setPadding(12, 12, Math.round($('top').getBoundingClientRect().right));
  } else {
    map.setPadding($('top').offsetHeight + 8, sheetH);
  }
}

// Giao diện màn hình ô tô: bật tay, hoặc tự bật trên màn hình cảm ứng nằm ngang, rộng mà thấp (màn hình trên xe).
const CAR_QUERY = '(orientation: landscape) and (min-width: 800px) and (max-height: 760px) and (pointer: coarse)';
let carQuery = null;

function applyCarUi() {
  if (!carQuery && typeof window.matchMedia === 'function') {
    carQuery = window.matchMedia(CAR_QUERY);
    if (carQuery.addEventListener) carQuery.addEventListener('change', applyCarUi);
    else carQuery.addListener?.(applyCarUi);
  }
  const pref = store.settings.carUi;
  const on = pref === 'on' || (pref === 'auto' && Boolean(carQuery?.matches));
  const root = document.documentElement;
  if (root.classList.contains('car-ui') === on) return;
  root.classList.toggle('car-ui', on);
  syncLayout();
}

function setMode(mode) {
  state.mode = mode;
  for (const v of document.querySelectorAll('#sheet .view')) v.hidden = v.dataset.view !== mode;
  $('searchBar').hidden = mode === 'nav';
  $('navSign').hidden = mode !== 'nav';
  if (mode !== 'nav') $('navThen').hidden = true;
  if (mode !== 'nav' && mode !== 'drive') {
    renderAlert({ active: null });
    renderStrip(null);
  }
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

/** Âm báo và lời nhắc về tốc độ (dùng cho cả định vị GPS lẫn tốc độ từ xe khi mất GPS). */
function speakSpeed(sp) {
  if (sp.sound === 'voice') {
    voice.chime('over');
    voice.speak(`Bạn đang chạy quá tốc độ. Giới hạn ${sp.limit} ki lô mét trên giờ`, PRIORITY.alert);
  } else if (sp.sound === 'beep') voice.chime('over');
  else if (sp.announce && store.settings.speakLimit) {
    // Bộ máy biển báo vừa báo trước đúng giới hạn này thì không đọc lại khi xe sang đoạn đường mới.
    const said = state.limitSaid.get(sp.announce);
    if (said == null || Date.now() - said > 60e3) {
      voice.speak(`Giới hạn tốc độ ${sp.announce} ki lô mét trên giờ`, PRIORITY.info);
    }
  }
}

/** Hai mục là cùng một biển (cùng mã và trị số), để dải biển kế tiếp không lặp lại biển trên thanh cảnh báo. */
const sameSign = (a, b) =>
  a.key === b.key || ((a.code ?? a.kind) === (b.code ?? b.kind) && (a.value ?? null) === (b.value ?? null));

/**
 * Thanh cảnh báo vàng, dùng chung cho điểm cảnh báo (camera, trạm thu phí, điểm tự đánh dấu) và biển báo
 * phía trước: mục nào gần hơn thì hiện, mục còn lại vẫn được đọc. Với biển báo, ô biểu tượng là hình biển.
 */
function renderAlert(pointResult, signResult = null) {
  const bar = $('alertBar');
  const p = pointResult?.active || null;
  const s = signResult?.active || null;
  let show = null;
  if (p && (!s || p.distance <= s.distance)) {
    show = { key: `p:${p.point.id}`, distance: p.distance, reach: p.reach, info: p.info };
  } else if (s) {
    show = { key: `s:${s.item.key}`, distance: s.distance, reach: s.reach, sign: s.item };
  }
  if (!show) {
    if (!bar.hidden) {
      bar.hidden = true;
      syncLayout();
    }
    state.alertKey = null;
    state.alertSign = null;
    return;
  }
  if (state.alertKey !== show.key) {
    state.alertKey = show.key;
    const icon = $('alertIcon');
    icon.classList.toggle('is-sign', Boolean(show.sign));
    if (show.sign) {
      // SVG do signart.js sinh từ hằng số nội bộ; trị số trên biển đã được lọc theo mẫu số.
      icon.innerHTML = signSvg(show.sign.art, { size: 50, value: show.sign.value });
      $('alertTitle').textContent = show.sign.title;
    } else {
      icon.innerHTML = glyphIcon(show.info.icon, 26);
      $('alertTitle').textContent = show.info.title;
    }
    bar.classList.toggle('tappable', Boolean(show.sign));
    if (show.sign) bar.tabIndex = 0;
    else bar.removeAttribute('tabindex');
  }
  state.alertSign = show.sign ? { item: show.sign, distance: show.distance } : null;
  $('alertDist').textContent = formatDistance(show.distance);
  const done = show.reach > 0 ? 1 - Math.min(1, show.distance / show.reach) : 0;
  $('alertMeter').style.width = `${Math.round(100 * Math.max(0, done))}%`;
  if (bar.hidden) {
    bar.hidden = false;
    syncLayout();
  }
}

/** Dải nhỏ phía trên đồng hồ tốc độ: tối đa 2 biển kế tiếp, khác với biển đang hiện trên thanh cảnh báo. */
function renderStrip(signResult) {
  const strip = $('signStrip');
  const shown = state.alertSign?.item || null;
  const items =
    isDriving() && signResult ? signResult.upcoming.filter((it) => !shown || !sameSign(it, shown)).slice(0, 2) : [];
  const key = items.map((it) => it.key).join('|');
  if (key !== state.stripKey) {
    state.stripKey = key;
    strip.replaceChildren(
      ...items.map((it) =>
        el(
          'div',
          { class: 'strip-item' },
          el('span', { class: 'strip-art', html: signSvg(it.art, { size: 40, value: it.value, title: it.title }) }),
          el('b', { class: 'strip-dist' })
        )
      )
    );
  }
  items.forEach((it, i) => {
    strip.children[i].lastChild.textContent = formatDistance(it.distance);
  });
  strip.hidden = items.length === 0;
}

/** Bấm vào thanh cảnh báo khi đang hiện biển báo: xem chi tiết biển. */
function showSignDetail() {
  const cur = state.alertSign;
  if (!cur) return;
  const { item, distance: d } = cur;
  let codeLine = null;
  if (item.code) {
    codeLine = item.derived ? `Tương ứng biển ${item.code} theo QCVN 41:2024` : `Biển ${item.code} theo QCVN 41:2024`;
  }
  openModal(
    item.title,
    el(
      'div',
      { class: 'view' },
      el(
        'div',
        { class: 'sign-detail' },
        el('span', { class: 'sign-detail-art', html: signSvg(item.art, { size: 88, value: item.value, title: item.title }) }),
        el(
          'div',
          { class: 'min0' },
          codeLine ? el('p', { class: 'sub' }, codeLine) : null,
          el('p', { class: 'sign-detail-dist' }, `Còn khoảng ${formatDistance(d)}`)
        )
      ),
      item.note ? el('p', { class: 'note' }, item.note) : null,
      el('p', { class: 'note' }, 'Nguồn: dữ liệu OpenStreetMap. Luôn tuân theo biển báo thực tế trên đường.')
    )
  );
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
  signs.reset();
  car.watch.reset();
  state.limitSaid.clear();
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
  state.lastFixAt = Date.now();
  const driving = isDriving();
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
  state.lastMatch = match;
  // Có tốc độ do xe báo (bộ OBD) thì đồng hồ và cảnh báo quá tốc độ dùng số đó, chính xác hơn GPS.
  const kmh = fix.simulated ? null : carSpeed(); // chạy thử thì giữ tốc độ mô phỏng
  const speedFix = kmh == null ? fix : { ...fix, speed: kmh / 3.6 };
  const sp = speedMon.update(speedFix, match, {
    vehicle: s.vehicle,
    tolerance: s.overTolerance,
    customMax: s.customMax,
    hasData: roads.hasData(fix.coord),
  });
  renderSpeed(speedFix, sp);

  if (driving) {
    // Đường ngang đường sắt nay do bộ máy biển báo đọc, nên không đưa vào bộ cảnh báo điểm nữa.
    const near = [...roads.pointsNear(fix.coord, 1300).filter((p) => p.kind !== 'rail'), ...reportPoints()];
    const result = alerts.update(fix, near, s, nav);
    const sr = signs.update(fix, roads, s, { vehicle: s.vehicle, nav, now: new Date() });
    for (const it of sr.fired) {
      if (it.code === 'P.127' && it.value != null) state.limitSaid.set(it.value, Date.now());
    }
    speakSpeed(sp);
    renderAlert(result, sr);
    renderStrip(sr);
    if (result.fired || sr.say) voice.chime('alert');
    if (result.fired) voice.speak(result.say, PRIORITY.alert);
    if (sr.say) voice.speak(sr.say, PRIORITY.alert);
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

// ---------- Kết nối với ô tô (bộ OBD-II) ----------

const UNSUPPORTED = {
  insecure: 'Cần mở ứng dụng bằng địa chỉ https:// thì mới dùng được Bluetooth.',
  ios: 'iPhone và iPad chưa hỗ trợ Bluetooth trên web, kể cả Chrome trên iPhone. Kết nối ô tô chỉ dùng được trên Android hoặc máy tính.',
  webview: 'Trang đang mở bên trong ứng dụng khác (Zalo, Facebook…), nơi không có Bluetooth. Hãy mở trang bằng Chrome.',
  firefox: 'Firefox không hỗ trợ Bluetooth trên web. Hãy dùng Chrome, Edge hoặc Samsung Internet.',
  other: 'Trình duyệt này không hỗ trợ Bluetooth trên web. Hãy dùng Chrome, Edge hoặc Samsung Internet trên Android.',
};

const carReady = () => car.client != null && car.state === 'ready';
/** Đang có phiên kết nối (kể cả đang kết nối lại); trạng thái lỗi coi như đã dừng. */
const carBusy = () => car.client != null && car.state !== 'idle' && car.state !== 'error';

/** Tốc độ do xe báo (km/h) nếu còn mới (dưới 1,5 giây) và người dùng cho phép dùng; không thì null. */
function carSpeed() {
  const snap = car.snap;
  if (!store.settings.obdUseSpeed || !carReady() || !snap || snap.speed == null) return null;
  return Date.now() - snap.speedTime < 1500 ? snap.speed : null;
}

/** Xe đang đứng yên: theo tốc độ của xe nếu có, không thì theo GPS. */
function carStationary() {
  const snap = car.snap;
  if (snap?.speed != null && Date.now() - snap.speedTime < 5000) return snap.speed < 1;
  return !state.fix || state.fix.speed < 1;
}

/** Dòng ngắn ở bảng dưới khi đang lái: "1.850 vòng/phút · 88 °C · 13,9 V". */
function carLine(snap) {
  if (!snap) return '';
  const parts = [];
  if (snap.rpm != null) parts.push(`${formatNumberVi(Math.round(snap.rpm), 0)} vòng/phút`);
  if (snap.coolant != null) parts.push(`${Math.round(snap.coolant)} °C`);
  if (snap.voltage != null) parts.push(`${formatNumberVi(snap.voltage, 1)} V`);
  return parts.join(' · ');
}

/** Số liệu đầy đủ trong phần cài đặt. */
function carReadout(snap) {
  if (!snap) return '';
  const parts = [];
  if (snap.speed != null) parts.push(`${Math.round(snap.speed)} km/h`);
  if (snap.rpm != null) parts.push(`${formatNumberVi(Math.round(snap.rpm), 0)} vòng/phút`);
  if (snap.coolant != null) parts.push(`nước làm mát ${Math.round(snap.coolant)} °C`);
  if (snap.fuel != null) parts.push(`nhiên liệu ${Math.round(snap.fuel)} %`);
  if (snap.voltage != null) parts.push(`ắc quy ${formatNumberVi(snap.voltage, 1)} V`);
  return parts.join(' · ');
}

function carStatusText() {
  const { state: st, info } = car;
  const name = car.client?.name || 'bộ OBD';
  switch (st) {
    case 'connecting':
      return info?.attempt ? `Đang kết nối lại (lần ${info.attempt})…` : `Đang kết nối với ${name}…`;
    case 'init':
      return 'Đang khởi động bộ OBD…';
    case 'searching':
      return 'Đang dò giao thức của xe, có thể mất tới 20 giây…';
    case 'ready':
      return `Đã kết nối với xe qua ${info?.adapter || car.snap?.adapter || name}.`;
    case 'nocar':
      return 'Đã kết nối bộ OBD nhưng xe chưa trả lời. Hãy bật khoá điện hoặc nổ máy.';
    case 'lost':
      return `Mất kết nối với bộ OBD, thử lại sau ${Math.round((info?.delay || 0) / 1000)} giây…`;
    case 'error':
      return info?.message || 'Không kết nối được với bộ OBD.';
    default:
      return 'Chưa kết nối.';
  }
}

/** Phần "Kết nối với ô tô" trong cài đặt. Tên và chuỗi phiên bản của thiết bị chỉ đi qua textContent. */
function renderObdPanel() {
  const sup = car.support;
  const busy = carBusy();
  let status = carStatusText();
  if (!car.client && !sup.ble) {
    status = UNSUPPORTED[sup.reason || 'other'];
    if (sup.serial) status += ' Vẫn dùng được bộ OBD Bluetooth thường đã ghép đôi.';
  }
  $('obdStatus').textContent = status;
  $('obdStatus').classList.toggle('ok', carReady());
  const live = carReady() ? carReadout(car.snap) : '';
  $('obdLive').textContent = live;
  $('obdLive').hidden = !live;
  $('btnObdBle').hidden = busy || !sup.ble;
  $('btnObdAll').hidden = busy || !sup.ble;
  $('btnObdSerial').hidden = busy || !sup.serial;
  $('btnObdStop').hidden = !busy;
  const canRead = carReady() && carStationary() && !car.dtc?.loading;
  $('btnObdDtc').disabled = !canRead;
  $('obdDtcHint').textContent =
    carReady() && !carStationary()
      ? 'Hãy dừng xe hẳn rồi mới đọc mã lỗi.'
      : 'Chỉ đọc được khi đã kết nối và xe đang đứng yên.';
}

/** Kết quả đọc mã lỗi: chỉ vẽ lại khi kết quả đổi. */
function renderDtc() {
  const box = $('obdDtc');
  const r = car.dtc;
  if (!r) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const never = el(
    'p',
    { class: 'note' },
    'Ứng dụng chỉ đọc, không bao giờ xoá mã lỗi. Mã lỗi cho biết hệ thống nào cần kiểm tra; hãy nhờ thợ hoặc gara xem khi đèn báo lỗi động cơ sáng.'
  );
  if (r.loading) box.replaceChildren(el('p', { class: 'note' }, 'Đang đọc mã lỗi…'));
  else if (r.error) box.replaceChildren(el('p', { class: 'note warn' }, r.error));
  else if (!r.codes.length) box.replaceChildren(el('p', { class: 'note' }, 'Xe không lưu mã lỗi nào.'), never);
  else box.replaceChildren(el('ul', { class: 'dtc-list' }, ...r.codes.map((c) => el('li', {}, c))), never);
}

/** Cập nhật mọi chỗ hiện trạng thái xe. Phần cài đặt chỉ vẽ lại khi đang mở. */
function renderCar() {
  const line = carReady() ? carLine(car.snap) : '';
  for (const id of ['navCar', 'driveCar']) {
    const node = $(id);
    if (node.textContent !== line) node.textContent = line;
    node.hidden = !line;
  }
  if (!$('settingsPanel').hidden) renderObdPanel();
}

/** Bắt đầu phiên OBD với một transport đã chọn. quiet: tự kết nối lúc mở ứng dụng, không báo lỗi. */
async function startObd(transport, { serial = false, quiet = false } = {}) {
  const old = car.client;
  car.client = null;
  if (old) await old.stop().catch(() => {});
  const client = new ObdClient(transport);
  Object.assign(car, { client, state: 'idle', info: null, snap: null, dtc: null });
  client.onState((st, info) => {
    if (car.client !== client) return;
    const was = car.state;
    car.state = st;
    car.info = info;
    if (st === 'ready' && was !== 'ready') {
      if (serial && !store.settings.obdAutoSerial) store.set('obdAutoSerial', true);
      toast('Đã kết nối với xe.');
    } else if (st === 'error' && !quiet) toast(info?.message || 'Không kết nối được với bộ OBD.', 5000);
    renderCar();
    renderObdPanel();
  });
  client.onData((snap) => onCarData(client, snap));
  client.setPaused(document.hidden);
  client.start();
  renderObdPanel();
}

/** Không làm gì khi người dùng tự đóng hộp chọn thiết bị; lỗi khác thì báo bằng câu dễ hiểu. */
function onPickError(err) {
  const cancelled =
    err?.name === 'AbortError' || (err?.name === 'NotFoundError' && /cancel|no port selected/i.test(String(err?.message)));
  if (!cancelled) toast(describeConnectError(err), 5000);
}

/** Bộ OBD Bluetooth Low Energy. requestDevice() được gọi đồng bộ ngay trong lần bấm. */
function connectBle(all) {
  let pick;
  try {
    pick = requestBleDevice(all);
  } catch (err) {
    pick = Promise.reject(err);
  }
  voice.unlock();
  pick.then((device) => startObd(createBleTransport(device)), onPickError);
}

/** Bộ OBD Bluetooth thường (SPP) đã ghép đôi, qua Web Serial. requestPort() cũng gọi ngay trong lần bấm. */
function connectSerial() {
  let pick;
  try {
    pick = requestSerialPort();
  } catch (err) {
    pick = Promise.reject(err);
  }
  voice.unlock();
  pick.then((port) => startObd(createSerialTransport(port), { serial: true }), onPickError);
}

async function stopObd() {
  const client = car.client;
  Object.assign(car, { client: null, state: 'idle', info: null, snap: null, dtc: null });
  if (store.settings.obdAutoSerial) store.set('obdAutoSerial', false);
  renderCar();
  renderObdPanel();
  renderDtc();
  if (client) await client.stop().catch(() => {});
}

/** Mở lại bộ OBD Bluetooth thường đã dùng lần trước (trình duyệt cho phép mà không cần chạm). */
async function reopenCar() {
  if (!store.settings.obdAutoSerial || !car.support.serial || car.client) return;
  const transport = await reopenSerial().catch(() => null);
  if (transport && !car.client) startObd(transport, { serial: true, quiet: true });
}

async function readCarDtcs() {
  const client = car.client;
  if (!carReady() || !carStationary()) return;
  car.dtc = { loading: true };
  renderDtc();
  renderObdPanel();
  let result;
  try {
    result = { codes: await client.readDtcs() };
  } catch (err) {
    result = { error: err instanceof ObdError ? err.message : 'Không đọc được mã lỗi từ xe.' };
  }
  if (car.client !== client) return;
  car.dtc = result;
  renderDtc();
  renderObdPanel();
}

function onCarData(client, snap) {
  if (car.client !== client) return;
  car.snap = snap;
  renderCar();
  const now = Date.now();
  const warn = car.watch.update(snap, now).say;
  if (warn) {
    voice.chime('alert');
    voice.speak(warn, PRIORITY.alert);
    toast(warn, 6000);
  }
  // Mất GPS (trong hầm…) mà xe vẫn báo tốc độ: cập nhật đồng hồ và cảnh báo quá tốc độ theo đoạn đường khớp gần nhất.
  if (!isDriving() || !state.fix || state.fix.simulated || now - state.lastFixAt <= 3000 || now - car.onlyAt < 1000) return;
  const kmh = carSpeed();
  if (kmh == null) return;
  car.onlyAt = now;
  const s = store.settings;
  const f = { ...state.fix, speed: kmh / 3.6, time: now };
  const sp = speedMon.update(f, state.lastMatch, {
    vehicle: s.vehicle,
    tolerance: s.overTolerance,
    customMax: s.customMax,
    hasData: true,
  });
  renderSpeed(f, sp);
  speakSpeed(sp);
}

// ---------- Cài đặt ----------

// Hình biển minh hoạ cho từng nhóm biển trong cài đặt: [mã biển, trị số].
const CATEGORY_ART = {
  speed: ['P.127', 50],
  prohibit: ['P.123a'],
  priority: ['R.122'],
  danger: ['W.201a'],
  signals: ['W.209'],
  calming: ['W.221b'],
  rail: ['W.210'],
  crossing: ['W.224'],
  info: ['I.407a'],
};

// Giữ id cũ "optRail" cho công tắc đường sắt (khoá cài đặt alertRail có từ trước).
const signOptId = (c) => (c.setting === 'alertRail' ? 'optRail' : `opt-${c.setting}`);

/** Sinh các công tắc "Biển báo phía trước" từ SIGN_CATEGORIES. */
function buildSignOptions() {
  const box = $('signOpts');
  for (const c of SIGN_CATEGORIES) {
    const [main, detail] = c.label.split(': ');
    const [code, value] = CATEGORY_ART[c.key] || [];
    const entry = code ? lookupSign(code) : null;
    const input = el('input', { id: signOptId(c), type: 'checkbox', class: 'switch' });
    input.addEventListener('change', (e) => store.set(c.setting, e.target.checked));
    box.append(
      el(
        'label',
        { class: 'opt sign-opt' },
        entry ? el('i', { class: 'opt-art', html: signSvg(entry.art, { size: 34, value }) }) : null,
        el('span', {}, main, detail ? el('small', {}, detail[0].toLocaleUpperCase('vi') + detail.slice(1)) : null),
        input
      )
    );
  }
}

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
  $('optReport').checked = s.alertReport;
  for (const c of SIGN_CATEGORIES) $(signOptId(c)).checked = categoryEnabled(c.key, s);
  $('optObdSpeed').checked = s.obdUseSpeed;
  $('optCarUi').value = s.carUi;
  $('optTheme').value = s.theme;
  $('optAwake').checked = s.keepAwake;
  setVehicleButtons();
  renderObdPanel();
  renderDtc();

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
    optReport: 'alertReport',
    optObdSpeed: 'obdUseSpeed',
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
  $('optCarUi').addEventListener('change', (e) => {
    store.set('carUi', e.target.value);
    applyCarUi();
  });

  buildSignOptions();
  // Hộp chọn thiết bị phải được mở ngay trong lần bấm, nên các hàm này không chờ gì trước khi gọi.
  $('btnObdBle').addEventListener('click', () => connectBle(false));
  $('btnObdAll').addEventListener('click', () => connectBle(true));
  $('btnObdSerial').addEventListener('click', connectSerial);
  $('btnObdStop').addEventListener('click', stopObd);
  $('btnObdDtc').addEventListener('click', readCarDtcs);

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
  document.addEventListener('visibilitychange', () => {
    updateWakeLock();
    car.client?.setPaused(document.hidden); // trang bị ẩn thì thôi hỏi xe để đỡ tốn pin
  });

  $('alertBar').addEventListener('click', showSignDetail);
  $('alertBar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') showSignDetail();
  });

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
  applyCarUi();
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
  reopenCar();

  setInterval(() => {
    applyTheme();
    if (store.pruneReports()) refreshPoints();
  }, 5 * 60e3);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
