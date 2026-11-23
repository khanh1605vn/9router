// Điều phối toàn bộ ứng dụng: trạng thái màn hình, vòng xử lý mỗi lần định vị, và các thao tác của người dùng.

import { distance, formatClock, formatDistance, formatDuration } from './geo.js';
import { REPORT_TYPES, store } from './store.js';
import { LocationService } from './location.js';
import { MapView } from './mapview.js';
import { fetchRoutes, RouteError } from './routing.js';
import { CameraSayGate, RouteTracker } from './tracker.js';
import { clearRoadCache, RoadData } from './roaddata.js';
import { AlertEngine, describePoint, overSpeedSay, signSpeech, SpeedMonitor } from './alerts.js';
import { PRIORITY, voice } from './voice.js';
import { reverseGeocode, searchPlaces } from './search.js';
import { GLYPH_COLORS, glyphIcon, lineIcon, maneuverIcon } from './icons.js';
import { SignEngine } from './signengine.js';
import { categoryEnabled, formatNumberVi, lookupSign, SIGN_CATEGORIES } from './signs.js';
import { signSvg } from './signart.js';
import { CameraController, learnedCaption } from './camctl.js';
import { camBadge, initCamUi } from './camui.js';
import {
  CarWatch,
  createBleTransport,
  createSerialTransport,
  describeCarState,
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
  alertQuiet: false, // biển đang hiện trên thanh là biển camera chưa xác nhận (viền nét đứt)
  alertSign: null, // { item, distance } khi thanh cảnh báo đang hiện một biển báo
  detail: null, // hộp chi tiết biển đang mở: { key, dist } (dist = dòng "Còn khoảng …")
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
// Câu biển camera (có lời rào) sắp chen trước câu "Còn … mét, rẽ …": giữ lại tới sau câu rẽ (tracker.js).
const cameraSayGate = new CameraSayGate();

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

// Camera nhận diện biển (thử nghiệm): kho biển đã học, bộ học, camera, bộ nhận diện và giới hạn tốc độ từ biển camera
// đều nằm trong camctl.js. Mọi thao tác với camera chỉ làm được khi xe đã đỗ (camctl.isParked()).
const camctl = new CameraController({
  store,
  roads,
  signs,
  getMode: () => state.mode,
  carStationary: () => carStationary(),
  // Tốc độ do xe báo (km/h, còn mới), để biết xe vừa chạy (chưa coi là đã đỗ), như carStationary().
  carSpeed: () => (car.snap?.speed != null && Date.now() - car.snap.speedTime < 5000 ? car.snap.speed : null),
  isSimulated: () => state.simulate === true, // "Chạy thử": không bao giờ mở camera
});
/** Xe đã đỗ (không ở chế độ lái, đứng yên ít nhất 5 giây): dùng cho các mục camera trong cài đặt. */
const isParked = () => camctl.isParked();

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
  const root = document.documentElement;
  const sheetH = $('sheet').offsetHeight;
  root.style.setProperty('--sheet-h', `${sheetH}px`);
  if (root.classList.contains('car-ui')) {
    // Màn hình ô tô: thanh trên và bảng dưới là một cột bên trái, bản đồ dùng phần còn lại. Luôn chừa chỗ cho
    // đồng hồ tốc độ và dải biển ở góc dưới (16 + đồng hồ + 12 + dải 48 + 8 px) để mũi tên vị trí không bị che.
    const speedoH = parseFloat(getComputedStyle(root).getPropertyValue('--speedo-h')) || 84;
    map.setPadding(12, Math.round(16 + speedoH + 12 + 48 + 8), Math.round($('top').getBoundingClientRect().right));
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
  camctl.refresh(); // vào/ra chế độ lái: mở hoặc đóng camera nhận diện biển
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
  // Giới hạn lấy từ biển do camera ghi nhận (thấp hơn bản đồ): ghi rõ "Camera" trên biển giới hạn.
  const cam = sp.source === 'camera';
  sign.classList.toggle('camera', cam);
  let src = $('limitSrc');
  if (!src && cam) {
    src = el('small', { id: 'limitSrc', class: 'limit-src' }, 'Camera');
    sign.append(src);
  }
  if (src) src.hidden = !cam;
}

// Đang lái mà chừng này (ms) không có lần định vị mới, cũng không có tốc độ mới từ xe, thì đồng hồ thôi hiện số cũ.
// Bằng thời hạn bộ OBD giữ số tốc độ; dài hơn khoảng cách thường gặp giữa hai lần định vị dưới cầu vượt, giữa nhà cao.
const SPEED_STALE_MS = 5000;

/**
 * Mất GPS (trong hầm…) mà xe cũng không còn báo tốc độ (lỗi đường truyền, tắt "Dùng tốc độ từ xe", mất kết nối):
 * đồng hồ hiện "–" và bỏ màu "gần/quá tốc độ", không giữ mãi con số và màu đỏ đã cũ. Đồng hồ và biển giới hạn vẫn ở
 * chỗ cũ để bố cục không xê dịch. Lần định vị mới (onFix) hoặc tốc độ mới của xe (onCarData) hiện lại số.
 */
function markSpeedStale() {
  if (!isDriving() || $('speedo').hidden || !state.fix || state.fix.simulated) return;
  const now = Date.now();
  if (now - state.lastFixAt <= SPEED_STALE_MS) return;
  const snap = car.snap;
  const carFresh = store.settings.obdUseSpeed && carReady() && snap?.speed != null && now - snap.speedTime < SPEED_STALE_MS;
  if (carFresh) return;
  $('speedValue').textContent = '–';
  $('speedBox').classList.remove('near', 'over');
}

/** Âm báo và lời nhắc về tốc độ (dùng cho cả định vị GPS lẫn tốc độ từ xe khi mất GPS). */
function speakSpeed(sp) {
  if (sp.sound === 'voice') {
    voice.chime('over');
    voice.speak(overSpeedSay(sp), PRIORITY.alert); // giới hạn từ camera thì câu có "(camera ghi nhận)"
  } else if (sp.sound === 'beep') voice.chime('over');
  else if (sp.announce && store.settings.speakLimit) {
    // Bộ máy biển báo vừa báo trước đúng giới hạn này thì không đọc lại khi xe sang đoạn đường mới.
    const said = state.limitSaid.get(sp.announce);
    if (said == null || Date.now() - said > 60e3) {
      voice.speak(`Giới hạn tốc độ ${sp.announce} ki lô mét trên giờ`, PRIORITY.info);
    }
  }
}

const NO_SIGNS = Object.freeze({ active: null, upcoming: [], fired: [], say: null });
let signFault = false;

/**
 * Biển báo phía trước. Bộ máy biển báo đọc dữ liệu do cộng đồng nhập: nếu một bản ghi lạ làm nó lỗi thì bỏ qua
 * lần này, để cảnh báo camera, quá tốc độ và chỉ dẫn vẫn chạy như thường.
 */
function updateSigns(fix, s, nav) {
  try {
    // Biển do camera ghi nhận đi cùng biển bản đồ; bộ máy tự bỏ chúng khi tắt "Báo biển do camera ghi nhận".
    return signs.update(fix, roads, s, { vehicle: s.vehicle, nav, now: new Date(), learned: camctl.learned });
  } catch (err) {
    if (!signFault) {
      signFault = true;
      console.warn('Bộ máy biển báo gặp lỗi, tạm bỏ qua:', err);
    }
    return NO_SIGNS;
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
  syncSignDetail(show);
  if (!show) {
    if (!bar.hidden) {
      bar.hidden = true;
      syncLayout();
    }
    state.alertKey = null;
    state.alertQuiet = false;
    state.alertSign = null;
    return;
  }
  const quiet = Boolean(show.sign?.quiet);
  if (state.alertKey !== show.key || state.alertQuiet !== quiet) {
    state.alertKey = show.key;
    state.alertQuiet = quiet;
    const icon = $('alertIcon');
    icon.classList.toggle('is-sign', Boolean(show.sign));
    // Biển do camera ghi nhận (hoặc nhập từ tệp): huy hiệu camera nhỏ; chưa xác nhận thì viền nét đứt và chú thích.
    const learned = Boolean(show.sign?.src);
    bar.classList.toggle('learned', learned);
    bar.classList.toggle('quiet', quiet);
    if (show.sign) {
      // SVG do signart.js sinh từ hằng số nội bộ; trị số trên biển đã được lọc theo mẫu số.
      icon.innerHTML = signSvg(show.sign.art, { size: 50, value: show.sign.value });
      if (learned) icon.append(camBadge());
      const cap = learnedCaption(show.sign);
      $('alertTitle').replaceChildren(show.sign.title, ...(cap ? [el('small', { class: 'alert-cap' }, cap)] : []));
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
  const key = items.map((it) => `${it.key}${it.quiet ? '~' : ''}`).join('|');
  if (key !== state.stripKey) {
    state.stripKey = key;
    strip.replaceChildren(
      ...items.map((it) => {
        const art = el('span', { class: 'strip-art', html: signSvg(it.art, { size: 40, value: it.value, title: it.title }) });
        if (it.src) art.append(camBadge());
        const cls = ['strip-item', it.src ? 'learned' : '', it.quiet ? 'quiet' : ''].filter(Boolean).join(' ');
        return el('div', { class: cls, title: learnedCaption(it) }, art, el('b', { class: 'strip-dist' }));
      })
    );
  }
  items.forEach((it, i) => {
    strip.children[i].lastChild.textContent = formatDistance(it.distance);
  });
  strip.hidden = items.length === 0;
}

// Mục lấy từ thẻ mô tả chính đèn tín hiệu, vạch qua đường, gờ giảm tốc, đường ngang hay vòng xuyến (không phải
// thẻ biển traffic_sign): dữ liệu không cho biết ở đó có biển thật, nên chỉ ghi "tương ứng biển".
const EQUIVALENT_KIND = /^(signals|crossing|calming|rail|roundabout)(:|$)/;

// Câu phải có ở mọi chỗ giải thích một biển do camera ghi nhận (PLAN §7).
const OBEY_REAL_SIGNS = 'Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.';

/** "Còn khoảng 140 m": số và đơn vị luôn nằm cùng một dòng. */
const detailDistText = (d) => `Còn khoảng ${formatDistance(d).replace(/ (?=\S+$)/, '\u00a0')}`;

/** Bấm vào thanh cảnh báo khi đang hiện biển báo: xem chi tiết biển. */
function showSignDetail() {
  const cur = state.alertSign;
  if (!cur) return;
  const { item, distance: d } = cur;
  let codeLine = null;
  if (item.code) {
    codeLine =
      item.derived || EQUIVALENT_KIND.test(item.kind || '')
        ? `Tương ứng biển ${item.code} theo QCVN 41:2024`
        : `Biển ${item.code} theo QCVN 41:2024`;
  }
  const dist = el('p', { class: 'sign-detail-dist' }, detailDistText(d));
  // Biển do camera ghi nhận hoặc nhập từ tệp: ghi chú của bộ máy biển báo đã nói rõ nguồn và độ tin cậy.
  let source = 'Nguồn: dữ liệu OpenStreetMap. Luôn tuân theo biển báo thực tế trên đường.';
  let note = item.note;
  if (item.src) {
    source = item.src === 'import' ? 'Nguồn: tệp đã nhập.' : 'Nguồn: camera trên xe.';
    if (!note || !note.includes(OBEY_REAL_SIGNS)) note = [note, OBEY_REAL_SIGNS].filter(Boolean).join(' ');
  }
  const cap = learnedCaption(item);
  openModal(
    item.title,
    el(
      'div',
      { class: 'view' },
      el(
        'div',
        { class: 'sign-detail' },
        el('span', { class: 'sign-detail-art', html: signSvg(item.art, { size: 88, value: item.value, title: item.title }) }),
        el('div', { class: 'min0' }, codeLine ? el('p', { class: 'sub' }, codeLine) : null, dist)
      ),
      cap ? el('p', { class: 'sub learned-cap' }, cap) : null,
      note ? el('p', { class: 'note' }, note) : null,
      el('p', { class: 'note' }, source)
    )
  );
  // Khoảng cách được cập nhật theo thanh cảnh báo; biển rời thanh (đã đi qua) thì hộp tự đóng.
  state.detail = { key: `s:${item.key}`, dist };
}

/** Giữ hộp chi tiết biển khớp với thanh cảnh báo: cập nhật khoảng cách, tự đóng khi biển không còn trên thanh. */
function syncSignDetail(show) {
  const detail = state.detail;
  if (!detail) return;
  if ($('modal').hidden || !detail.dist.isConnected) {
    state.detail = null; // người dùng đã đóng, hoặc hộp đang hiện nội dung khác
    return;
  }
  if (show?.key === detail.key) {
    detail.dist.textContent = detailDistText(show.distance);
    return;
  }
  state.detail = null;
  if (overlayStack.length === 1 && overlayStack[0] === 'modal') closeOverlays();
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
    camctl.resetLimit();
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
    camctl.resetLimit();
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
  // Tự vào chế độ lái vì xe đã chạy: đóng mọi bảng đang mở (Cài đặt, danh sách biển camera, kiểm tra camera…) để
  // bản đồ, biển báo và đồng hồ tốc độ hiện ra mà người lái không phải chạm máy. Đóng hộp thoại thì camui tự đóng
  // màn hình kiểm tra camera (theo dõi #modal).
  if (auto) closeOverlays();
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
  cameraSayGate.reset();
  camctl.newTrip(); // bộ học, bộ chọn mức tải và giới hạn tốc độ camera bắt đầu lại
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
      // Chỉ câu rẽ ngay được ngắt câu cảnh báo đang đọc (câu đó được đọc lại sau); câu "Còn … mét" thì xếp hàng.
      const urgent = p.cue.level === 'near';
      if (urgent) voice.chime('turn');
      voice.speak(p.cue.text, PRIORITY.turn, { urgent });
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
  const match = roads.matchWay(fix, state.progress?.step?.name || '', { vehicle: s.vehicle });
  state.lastMatch = match;
  // Có tốc độ do xe báo (bộ OBD) thì đồng hồ và cảnh báo quá tốc độ dùng số đó, chính xác hơn GPS.
  const kmh = fix.simulated ? null : carSpeed(); // chạy thử thì giữ tốc độ mô phỏng
  const speedFix = kmh == null ? fix : { ...fix, speed: kmh / 3.6 };
  const sr = driving ? updateSigns(fix, s, nav) : null;
  // Sau updateSigns (cùng hành lang của lần định vị này): bộ học biển, giới hạn tốc độ từ biển camera, bật/tắt camera.
  // Lần định vị "Chạy thử" không được học và không dùng biển camera.
  camctl.onFix(fix, { match, carSpeed: kmh });
  const sp = speedMon.update(speedFix, match, {
    vehicle: s.vehicle,
    tolerance: s.overTolerance,
    customMax: s.customMax,
    hasData: roads.hasData(fix.coord),
    camera: camctl.speedLimit, // chỉ hạ, không bao giờ nâng giới hạn
    camSpeed: s.camSpeed,
  });
  renderSpeed(speedFix, sp);

  if (driving) {
    // Đường ngang đường sắt nay do bộ máy biển báo đọc, nên không đưa vào bộ cảnh báo điểm nữa.
    const near = [...roads.pointsNear(fix.coord, 1300).filter((p) => p.kind !== 'rail'), ...reportPoints()];
    const result = alerts.update(fix, near, s, nav);
    const signSay = signSpeech(sr, s); // tắt "Đọc giới hạn tốc độ khi thay đổi" thì câu này không có biển tốc độ
    if (s.speakLimit !== false) {
      for (const it of sr.fired) {
        // Biển camera đọc kèm lời rào, không thay được câu "Giới hạn tốc độ …" của bản đồ.
        if (it.code === 'P.127' && it.value != null && !it.src) state.limitSaid.set(it.value, Date.now());
      }
    }
    speakSpeed(sp);
    renderAlert(result, sr);
    renderStrip(sr);
    const navOn = state.mode === 'nav' && state.tracker && state.progress;
    const signSays = cameraSayGate.step({
      say: signSay,
      items: sr.fired,
      tracker: navOn ? state.tracker : null,
      progress: navOn ? state.progress : null,
      cue: navOn ? state.progress.cue : null,
    });
    if (result.fired || signSays.length) voice.chime('alert');
    if (result.fired) voice.speak(result.say, PRIORITY.alert);
    for (const say of signSays) voice.speak(say, PRIORITY.alert);
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
  firefox: 'Firefox không hỗ trợ Bluetooth trên web. Hãy dùng Chrome hoặc Samsung Internet trên Android.',
  other: 'Trình duyệt này không hỗ trợ Bluetooth trên web. Hãy dùng Chrome hoặc Samsung Internet trên Android.',
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
  return describeCarState(car.state, car.info, { name: car.client?.name, adapter: car.snap?.adapter });
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

/**
 * Bọc transport của bộ OBD: nếu bị ngắt ("Ngắt kết nối") trong lúc đang mở kết nối dở thì khi việc mở xong,
 * kết nối được đóng lại ngay. Không thì cổng nối tiếp vẫn mở và bị khoá (lần kết nối sau lỗi cho tới khi tải lại
 * trang), hoặc Bluetooth vẫn nối với bộ đọc sau khi người dùng đã ngắt.
 */
function closeIfStopped(transport) {
  let opening = null;
  let stopped = false;
  return {
    get kind() {
      return transport.kind;
    },
    get name() {
      return transport.name;
    },
    async connect(handlers) {
      stopped = false;
      const job = (opening = transport.connect(handlers));
      try {
        await job;
      } catch (err) {
        if (stopped) await transport.disconnect().catch(() => {}); // có thể đã nối được một phần
        throw err;
      } finally {
        if (opening === job) opening = null;
      }
      if (stopped) {
        await transport.disconnect().catch(() => {});
        throw new Error('Đã ngắt kết nối.');
      }
    },
    write: (text) => transport.write(text),
    async disconnect() {
      if (opening) stopped = true;
      await transport.disconnect();
    },
  };
}

/** Bắt đầu phiên OBD với một transport đã chọn. quiet: tự kết nối lúc mở ứng dụng, không báo lỗi. */
async function startObd(transport, { serial = false, quiet = false } = {}) {
  const old = car.client;
  car.client = null;
  if (old) await old.stop().catch(() => {});
  const client = new ObdClient(closeIfStopped(transport));
  Object.assign(car, { client, state: 'idle', info: null, snap: null, dtc: null });
  // Chỉ lần tự mở lại lúc khởi động là im lặng; đã kết nối được rồi mà sau đó mất hẳn thì vẫn báo.
  let mute = quiet;
  // "Đã kết nối với xe." chỉ báo lần đầu của phiên: những lần vào lại 'ready' sau đó (xe vừa nổ máy lại, đường
  // truyền hết lỗi, bộ đọc tự nối lại) đã hiện ở dòng trạng thái và dòng số liệu, không cần hiện thêm khi đang lái.
  let greeted = false;
  client.onState((st, info) => {
    if (car.client !== client) return;
    const was = car.state;
    car.state = st;
    car.info = info;
    if (st === 'ready' && was !== 'ready') {
      mute = false;
      if (serial && !store.settings.obdAutoSerial) store.set('obdAutoSerial', true);
      if (!greeted) toast('Đã kết nối với xe.');
      greeted = true;
    } else if (st === 'error' && !mute) toast(info?.message || 'Không kết nối được với bộ OBD.', 5000);
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
  camctl.tick(); // tốc độ của xe: xe đã đỗ chưa
  const now = Date.now();
  const warn = car.watch.update(snap, now).say;
  if (warn) {
    voice.chime('alert');
    voice.speak(warn, PRIORITY.alert);
    toast(warn, 6000);
  }
  // Mất GPS (trong hầm…) mà xe vẫn báo tốc độ: cập nhật đồng hồ và cảnh báo quá tốc độ theo đoạn đường khớp gần nhất.
  // Giới hạn của đường và giới hạn camera (camctl.speedLimit) đều được giữ suốt lúc mất GPS, dù xe đi bao xa: biển
  // P.127 ở cửa hầm phải còn hiệu lực trong cả hầm (hầm hầu như không có nút giao). Camera chỉ hạ giới hạn (SpeedMonitor
  // lấy số thấp hơn), nên giữ lâu chỉ có thể nhắc thừa, không bao giờ làm mất lời nhắc quá tốc độ. Có lại GPS thì
  // CameraLimit.update xét lại (nhảy quá 300 m, đổi đường, nút giao).
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
    camera: camctl.speedLimit,
    camSpeed: s.camSpeed,
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
    camctl.resetLimit();
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
  camctl.init(); // không mở camera: chỉ đọc kho biển đã học và labels.json
  initCamUi(camctl, { store, map, openModal, closeOverlays, toast }); // mục Cài đặt, nút camera, danh sách biển đã học
  // Bộ chạy thử trên trình duyệt (tests/browser) đặt sẵn globalThis.__BD_TEST__ để đọc bộ điều phối camera.
  if (globalThis.__BD_TEST__ && typeof globalThis.__BD_TEST__ === 'object') globalThis.__BD_TEST__.controller = camctl;
  locator.on(onFix);
  locator.onError((err) => {
    const status = $('gpsStatus');
    status.classList.add('warn');
    status.textContent = err.message;
  });
  locator.start();
  reopenCar();
  setInterval(() => {
    markSpeedStale();
    camctl.tick();
  }, 1000);

  setInterval(() => {
    applyTheme();
    if (store.pruneReports()) refreshPoints();
  }, 5 * 60e3);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
