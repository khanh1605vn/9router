// Cầu nối với ứng dụng Android (js/carbridge.js): dựng ảnh chụp "state" theo hợp đồng v1, giới hạn mọi trường như
// phía máy (BridgeMessageParser), nhịp gửi tối đa 4 lần/giây chỉ khi đổi, và không làm gì trên trình duyệt thường.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertId,
  alertsFrom,
  boundNumber,
  boundState,
  cameraStatus,
  CarBridge,
  cleanText,
  createCarBridge,
  encodeState,
  IDLE_INTERVAL_MS,
  KEEPALIVE_MS,
  LIMITS,
  maneuverFrom,
  maneuverIcon,
  NATIVE_EVENT,
  nativeChannel,
  obdStatus,
  positionFrom,
  RoadsMemo,
  ROADS_MOVE_M,
  ROADS_REFRESH_MS,
  roadsNear,
  routeWindow,
  SEND_INTERVAL_MS,
  signText,
  thinPoints,
  toPoint,
} from '../js/carbridge.js';
import { parseRoute } from '../js/routing.js';
import { RouteTracker } from '../js/tracker.js';
import { cellKey, cellOf, RoadData } from '../js/roaddata.js';
import { destination } from '../js/geo.js';
import { driveAlong, sampleOsrmRoute, START } from './fixtures.mjs';

// ---------- Kênh giả và đồng hồ giả ----------

function fakeEnv() {
  let t = 1_764_000_000_000;
  let nextId = 1;
  const timers = new Map();
  const listeners = new Map();
  const sent = [];
  const channel = { postMessage: (s) => sent.push(s) };
  const target = {
    BanDuongNative: channel,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  const fakeTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const env = {
    channel,
    target,
    timers,
    sent,
    now: () => t,
    /** Cho đồng hồ chạy tới, gọi các hẹn giờ tới hạn theo thứ tự. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const [id, x] of timers) if (x.at <= end && (!due || x.at < due[1].at)) due = [id, x];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
    native(detail) {
      listeners.get(NATIVE_EVENT)?.({ detail });
    },
    states: () => sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'state'),
    hellos: () => sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'hello'),
    bridge(opts = {}) {
      return new CarBridge(channel, { target, now: env.now, timers: fakeTimers, ...opts });
    },
  };
  return env;
}

// ---------- Không chạy trong ứng dụng Android: không làm gì ----------

test('trình duyệt thường (không có window.BanDuongNative): createCarBridge trả null, không đụng gì khác', () => {
  const reads = [];
  const target = new Proxy(
    {},
    {
      get(o, k) {
        reads.push(k);
        return undefined;
      },
    }
  );
  assert.equal(createCarBridge({ target }), null);
  assert.deepEqual(reads, ['BanDuongNative'], 'chỉ được đọc đúng một thuộc tính');
  assert.equal(nativeChannel({ BanDuongNative: {} }), null, 'không có postMessage');
  assert.equal(nativeChannel({ BanDuongNative: { postMessage: 'x' } }), null);
  assert.equal(
    nativeChannel({
      get BanDuongNative() {
        throw new Error('bị chặn');
      },
    }),
    null
  );
  assert.equal(nativeChannel(null), null);
  const ch = { postMessage() {} };
  assert.equal(nativeChannel({ BanDuongNative: ch }), ch);
});

test('main.js chỉ gọi cầu nối qua carBridge?.… và chỉ dựng dữ liệu khi có cầu nối', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(src, /const carBridge = createCarBridge\(\);/);
  const uses = src.match(/carBridge[.?][^\s(]*/g) || [];
  for (const u of uses) assert.ok(u.startsWith('carBridge?.'), `phải dùng carBridge?.: ${u}`);
  assert.ok(uses.some((u) => u === 'carBridge?.publish'));
  assert.ok(uses.some((u) => u === 'carBridge?.start'));
  assert.doesNotMatch(src, /addJavascriptInterface|BanDuongNative/, 'main.js không tự đụng tới kênh');
});

// ---------- Làm sạch chữ và số ----------

test('cleanText: bỏ ký tự điều khiển, đổi hướng, độ rộng 0; gộp khoảng trắng', () => {
  assert.equal(cleanText('  Rẽ\tphải\nvào   đường Lê Lợi  '), 'Rẽ phải vào đường Lê Lợi');
  assert.equal(cleanText('Cam\u0000era\u0007 \u009bphạt'), 'Camera phạt');
  assert.equal(cleanText('‮abc‬ ⁦x⁩'), 'abc x');
  assert.equal(cleanText('Lê​Lợi﻿‎'), 'LêLợi');
  assert.equal(cleanText('Đường Láng'), 'Đường Láng');
  assert.equal(cleanText(''), null);
  assert.equal(cleanText(' ​\t '), null);
  assert.equal(cleanText(42), null);
  assert.equal(cleanText(null), null);
});

test('cleanText: cắt còn 120 ký tự UTF-16, không cắt đôi cặp surrogate; chuỗi gốc > 960 ký tự bị bỏ', () => {
  const long = 'Đi tiếp trên đường Nguyễn Văn Linh '.repeat(10);
  const t = cleanText(long);
  assert.ok(t.length <= LIMITS.textChars);
  assert.ok(long.startsWith(t));
  const emoji = `${'a'.repeat(119)}😀b`; // ký tự 120 là nửa đầu của cặp surrogate
  const e = cleanText(emoji);
  assert.equal(e, 'a'.repeat(119));
  assert.equal(cleanText(`${'a'.repeat(118)}😀b`), `${'a'.repeat(118)}😀`);
  assert.equal(cleanText('a'.repeat(960)).length, 120);
  assert.equal(cleanText('a'.repeat(961)), null);
});

test('boundNumber, toPoint, thinPoints', () => {
  assert.equal(boundNumber(5, 0, 10), 5);
  assert.equal(boundNumber(10.04, 0, 10, 1), 10);
  assert.equal(boundNumber(11, 0, 10), null);
  assert.equal(boundNumber(NaN, 0, 10), null);
  assert.equal(boundNumber(Infinity, 0, 10), null);
  assert.equal(boundNumber('5', 0, 10), null);
  assert.deepEqual(toPoint([106.7009004, 10.7769004]), [10.7769, 106.7009], 'đổi [lon, lat] thành [lat, lon]');
  assert.equal(toPoint([181, 10]), null);
  assert.equal(toPoint([106, 91]), null);
  assert.equal(toPoint([106]), null);
  const pts = Array.from({ length: 1000 }, (_, i) => i);
  const thin = thinPoints(pts, 400);
  assert.equal(thin.length, 400);
  assert.equal(thin[0], 0);
  assert.equal(thin.at(-1), 999);
  assert.equal(thinPoints([1, 2, 3], 400).length, 3);
});

// ---------- boundState: giới hạn mọi trường như phía máy ----------

test('boundState: tốc độ, giới hạn, quá tốc độ', () => {
  assert.equal(boundState({ speed: 52.44 }).speed, 52.4);
  assert.equal(boundState({ speed: 401 }).speed, null);
  assert.equal(boundState({ speed: -1 }).speed, null);
  assert.equal(boundState({ speed: '50' }).speed, null);
  assert.equal(boundState({ speed: 50, speedSource: 'obd' }).speedSource, 'obd');
  assert.equal(boundState({ speed: 50, speedSource: 'radar' }).speedSource, null);
  assert.equal(boundState({ speed: null, speedSource: 'gps' }).speedSource, null, 'không có tốc độ thì không có nguồn');
  assert.equal(boundState({ limit: 59.6 }).limit, 60);
  assert.equal(boundState({ limit: 4 }).limit, null);
  assert.equal(boundState({ limit: 201 }).limit, null);
  assert.equal(boundState({ limit: '60' }).limit, null);
  assert.equal(boundState({ overSpeed: true }).overSpeed, true);
  assert.equal(boundState({ overSpeed: 1 }).overSpeed, false);
  assert.equal(boundState({ overSpeed: 'true' }).overSpeed, false);
});

test('boundState: vị trí, camera, OBD và mặc định', () => {
  const empty = boundState();
  assert.deepEqual(empty, {
    speed: null,
    speedSource: null,
    limit: null,
    overSpeed: false,
    position: null,
    alerts: [],
    maneuver: null,
    route: [],
    nearbyRoads: [],
    camera: 'off',
    obd: 'off',
  });
  assert.deepEqual(boundState(null), empty);
  assert.deepEqual(boundState({ position: { lat: 10.7769001, lon: 106.7009001, heading: 92.54, accuracy: 6.4 } }).position, {
    lat: 10.7769,
    lon: 106.7009,
    heading: 92.5,
    accuracy: 6,
    ts: null,
  });
  assert.equal(boundState({ position: { lat: 10, lon: 106, ts: 1764000000000.4 } }).position.ts, 1764000000000);
  assert.equal(boundState({ position: { lat: 10, lon: 106, ts: '1764000000000' } }).position.ts, null);
  assert.equal(boundState({ position: { lat: 10, lon: 106, ts: -5 } }).position.ts, null);
  assert.equal(boundState({ position: { lat: 95, lon: 106 } }).position, null);
  assert.equal(boundState({ position: { lat: 10 } }).position, null);
  const p = boundState({ position: { lat: 10, lon: 106, heading: 400, accuracy: 20000 } }).position;
  assert.equal(p.heading, null);
  assert.equal(p.accuracy, null);
  assert.equal(boundState({ camera: 'running', obd: 'connected' }).camera, 'running');
  assert.equal(boundState({ camera: 'on' }).camera, 'off');
  assert.equal(boundState({ obd: 'ready' }).obd, 'off');
});

test('boundState: tối đa 3 cảnh báo hợp lệ, phần tử sai bị bỏ', () => {
  const ok = (text, distance, extra = {}) => ({ kind: 'camera', code: 'speed_camera', text, distance, source: 'osm', ...extra });
  const out = boundState({
    alerts: [
      ok('', 100), // chữ rỗng
      ok('Camera', -5), // khoảng cách âm
      ok('Camera', 100001),
      ok('Camera', '50'),
      null,
      ok('Camera bắn tốc độ', 120.6, { kind: 'ufo', code: 'có dấu cách', source: 'lạ' }),
      ok('Tốc độ tối đa 50 km/h (camera ghi nhận)', 200, { kind: 'sign', code: 'P.127', source: 'camera' }),
      ok('Trạm thu phí', 300, { kind: 'toll', code: 'x'.repeat(33) }),
      ok('Thứ tư', 400),
    ],
  });
  assert.equal(out.alerts.length, 3);
  assert.deepEqual(out.alerts[0], { kind: 'other', code: null, text: 'Camera bắn tốc độ', distance: 121, source: 'osm', id: null });
  assert.deepEqual(out.alerts[1], {
    kind: 'sign',
    code: 'P.127',
    text: 'Tốc độ tối đa 50 km/h (camera ghi nhận)',
    distance: 200,
    source: 'camera',
    id: null,
  });
  assert.equal(out.alerts[2].code, null);
});

test('boundState: chỉ dẫn rẽ', () => {
  assert.deepEqual(boundState({ maneuver: { text: 'Rẽ phải vào đường Lê Lợi', distance: 120.4, icon: 'right', exit: null } }).maneuver, {
    text: 'Rẽ phải vào đường Lê Lợi',
    distance: 120,
    icon: 'right',
    exit: null,
    tripDistance: null,
    tripDuration: null,
  });
  const t = boundState({ maneuver: { text: 'Rẽ', distance: 10, tripDistance: 5230.6, tripDuration: 610.4 } }).maneuver;
  assert.equal(t.tripDistance, 5231);
  assert.equal(t.tripDuration, 610);
  const bad = boundState({ maneuver: { text: 'Rẽ', distance: 10, tripDistance: -1, tripDuration: 604801 } }).maneuver;
  assert.equal(bad.tripDistance, null);
  assert.equal(bad.tripDuration, null);
  assert.equal(boundState({ maneuver: { text: 'Rẽ', distance: 10, icon: 'u-turn' } }).maneuver.icon, null);
  assert.equal(boundState({ maneuver: { text: 'Vòng xuyến', distance: 10, icon: 'roundabout', exit: 21 } }).maneuver.exit, null);
  assert.equal(boundState({ maneuver: { text: 'Vòng xuyến', distance: 10, icon: 'roundabout', exit: 2 } }).maneuver.exit, 2);
  assert.equal(boundState({ maneuver: { text: '', distance: 10 } }).maneuver, null);
  assert.equal(boundState({ maneuver: { text: 'Rẽ', distance: 1e7 } }).maneuver, null);
  assert.equal(boundState({ maneuver: 'Rẽ phải' }).maneuver, null);
});

test('boundState: tuyến tối đa 400 điểm, điểm sai bị bỏ riêng', () => {
  const route = Array.from({ length: 1000 }, (_, i) => [10 + i * 1e-4, 106]);
  route.splice(5, 0, [95, 106], 'x', [10, 106, 1], [10, '106']);
  const out = boundState({ route }).route;
  assert.equal(out.length, LIMITS.routePoints);
  assert.deepEqual(out[0], [10, 106]);
  assert.deepEqual(out.at(-1), [round6(10 + 999e-4), 106]);
  assert.ok(out.every((p) => Array.isArray(p) && p.length === 2 && p[0] <= 90));
});

const round6 = (v) => Math.round(v * 1e6) / 1e6;

test('boundState: đường quanh xe tối đa 60 đường, 2 000 điểm, 400 điểm mỗi đường', () => {
  const road = (n, highway = 'primary') => ({ highway, points: Array.from({ length: n }, (_, i) => [10 + i * 1e-5, 106]) });
  const many = boundState({ nearbyRoads: Array.from({ length: 100 }, () => road(5)) }).nearbyRoads;
  assert.equal(many.length, LIMITS.roads);
  const big = boundState({ nearbyRoads: Array.from({ length: 10 }, () => road(1000, 'lạ')) }).nearbyRoads;
  assert.ok(big.every((r) => r.points.length <= LIMITS.roadPoints));
  assert.equal(big.reduce((n, r) => n + r.points.length, 0), LIMITS.roadPointsTotal);
  assert.equal(big[0].highway, 'other');
  const short = boundState({ nearbyRoads: [road(1), { highway: 'primary', points: [[10, 106], [95, 106]] }, road(2)] }).nearbyRoads;
  assert.equal(short.length, 1, 'đường dưới 2 điểm hợp lệ bị bỏ');
});

// ---------- encodeState: JSON đúng hợp đồng, dưới hạn mức ----------

/** Độ sâu lồng {/[ ngoài chuỗi, như phía máy đếm trước khi phân tích. */
function depth(json) {
  let d = 0;
  let max = 0;
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') max = Math.max(max, ++d);
    else if (c === '}' || c === ']') d--;
  }
  return max;
}

test('encodeState: thông điệp đầy nhất vẫn dưới 128 KiB, độ sâu ≤ 6, đúng v/type/ts', () => {
  const pt = (i) => [10.123456 + i * 1e-6, 106.123456 + i * 1e-6];
  const body = boundState({
    speed: 399.9,
    speedSource: 'gps',
    limit: 120,
    overSpeed: true,
    position: { lat: -89.123456, lon: -179.123456, heading: 359.9, accuracy: 9999 },
    alerts: Array.from({ length: 3 }, () => ({ kind: 'sign', code: 'x'.repeat(32), text: 'Đ'.repeat(120), distance: 99999, source: 'camera' })),
    maneuver: { text: 'Ở'.repeat(120), distance: 999999, icon: 'sharp-right', exit: 20 },
    route: Array.from({ length: 400 }, (_, i) => pt(i)),
    nearbyRoads: Array.from({ length: 60 }, () => ({ highway: 'secondary_link', points: Array.from({ length: 400 }, (_, i) => pt(i)) })),
    camera: 'starting',
    obd: 'connecting',
  });
  const { json, key } = encodeState(body, 1764000000000.4);
  assert.ok(json.length <= LIMITS.messageChars, `${json.length}`);
  assert.ok(depth(json) <= 6, `độ sâu ${depth(json)}`);
  const msg = JSON.parse(json);
  assert.equal(msg.v, 1);
  assert.equal(msg.type, 'state');
  assert.equal(msg.ts, 1764000000000);
  const { v, type, ts, ...rest } = msg;
  assert.deepEqual(rest, body);
  assert.equal(key, JSON.stringify(body));
});

test('encodeState: quá dài thì bớt đường quanh xe trước, rồi tới tuyến', () => {
  const pts = Array.from({ length: 8000 }, () => [10.123456, 106.123456]);
  // Đi thẳng vào encodeState (bỏ qua boundState) để mô phỏng một thông điệp quá dài.
  const body = { ...boundState(), route: pts, nearbyRoads: Array.from({ length: 10 }, () => ({ highway: 'primary', points: pts })) };
  const { json } = encodeState(body, 1);
  assert.ok(json.length <= LIMITS.messageChars);
  const msg = JSON.parse(json);
  assert.equal(msg.nearbyRoads.length, 0);
  assert.equal(msg.route.length, 4000);
});

// ---------- Từ trạng thái của ứng dụng ----------

test('alertsFrom: điểm cảnh báo và biển (thanh vàng + dải biển), gần nhất trước, tối đa 3, bỏ biển trùng', () => {
  const point = {
    point: { id: 'n1', kind: 'camera', sub: 'speed', limit: 60, coord: [106, 10] },
    distance: 250,
    info: { title: 'Camera bắn tốc độ · giới hạn 60 km/h', say: 'có camera bắn tốc độ', icon: 'camera' },
  };
  const p127 = { key: 'a', kind: 'maxspeed', code: 'P.127', title: 'Tốc độ tối đa 50 km/h', value: 50, distance: 120 };
  const learned = { key: 'b', kind: 'no_left', code: 'P.123a', title: 'Cấm rẽ trái', value: null, distance: 180, src: 'camera', quiet: false };
  const quiet = { key: 'c', kind: 'no_uturn', code: 'P.124a', title: 'Cấm quay đầu xe', value: null, distance: 90, src: 'camera', quiet: true };
  const rail = { key: 'd', kind: 'rail', code: 'W.210', title: 'Giao nhau với đường sắt có rào chắn', value: null, distance: 280 };
  const signs = { active: { item: p127, distance: 118 }, upcoming: [p127, { ...p127, key: 'a2' }, learned, quiet, rail] };
  const out = alertsFrom(point, signs);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { kind: 'sign', code: 'P.124a', text: 'Cấm quay đầu xe (camera ghi nhận, chưa xác nhận)', distance: 90, source: 'camera', id: alertId('s', 'c') });
  assert.deepEqual(out[1], { kind: 'sign', code: 'P.127', text: 'Tốc độ tối đa 50 km/h', distance: 118, source: 'osm', id: alertId('s', 'a') });
  assert.deepEqual(out[2], { kind: 'sign', code: 'P.123a', text: 'Cấm rẽ trái (camera ghi nhận)', distance: 180, source: 'camera', id: alertId('s', 'b') });

  const only = alertsFrom(point, { active: null, upcoming: [rail] });
  assert.deepEqual(only, [
    { kind: 'camera', code: 'speed_camera', text: 'Camera bắn tốc độ · giới hạn 60 km/h', distance: 250, source: 'osm', id: alertId('p', 'n1') },
    { kind: 'rail', code: 'W.210', text: 'Giao nhau với đường sắt có rào chắn', distance: 280, source: 'osm', id: alertId('s', 'd') },
  ]);
  assert.deepEqual(alertsFrom(null, null), []);
  const report = { point: { id: 'r1', kind: 'report', type: 'police', coord: [106, 10] }, distance: -3, info: { title: 'Công an (bạn đánh dấu)' } };
  assert.deepEqual(alertsFrom(report, null)[0], { kind: 'report', code: 'report:police', text: 'Công an (bạn đánh dấu)', distance: 0, source: 'osm', id: alertId('p', 'r1') });
  // Qua boundState: mọi cảnh báo dựng ra đều hợp lệ.
  assert.equal(boundState({ alerts: out }).alerts.length, 3);
});

test('signText: biển do camera ghi nhận có lời rào như lời đọc, biển bản đồ giữ nguyên tên', () => {
  assert.equal(signText({ title: 'Cấm rẽ trái' }), 'Cấm rẽ trái');
  assert.equal(signText({ title: 'Cấm rẽ trái', src: 'camera', quiet: false }), 'Cấm rẽ trái (camera ghi nhận)');
  assert.equal(signText({ title: 'Cấm rẽ trái', src: 'import', quiet: true }), 'Cấm rẽ trái (nhập từ tệp, chưa xác nhận)');
  assert.equal(signText({ title: 'Cấm rẽ trái (camera ghi nhận)', src: 'camera' }), 'Cấm rẽ trái (camera ghi nhận)');
  assert.equal(signText(null), '');
});

test('maneuverFrom: chỉ dẫn kế tiếp như ô chỉ dẫn trên điện thoại', () => {
  const route = parseRoute(sampleOsrmRoute());
  const first = maneuverFrom(route, null);
  assert.equal(first.text, route.steps[1].text);
  assert.equal(first.icon, 'right');
  assert.equal(first.distance, route.steps[0].distance);

  const tracker = new RouteTracker(route);
  const fixes = [...driveAlong(route, 10)];
  const p = tracker.update(fixes[10]);
  const m = maneuverFrom(route, p);
  assert.equal(m.text, 'Rẽ phải vào đường Lê Lợi');
  assert.equal(m.icon, 'right');
  assert.ok(Math.abs(m.distance - p.distToNext) < 1e-9);
  const b = boundState({ maneuver: m }).maneuver;
  assert.equal(b.text, 'Rẽ phải vào đường Lê Lợi');
  // Quãng đường và thời gian còn lại tới đích (giờ đến trên màn hình xe).
  assert.ok(Math.abs(m.tripDistance - p.remainingDistance) < 1e-9);
  assert.ok(Math.abs(m.tripDuration - p.remainingDuration) < 1e-9);
  assert.equal(first.tripDistance, route.distance);
  assert.equal(first.tripDuration, route.duration);
  assert.equal(b.tripDistance, Math.round(p.remainingDistance));

  let last = null;
  for (const f of fixes.slice(11)) last = tracker.update(f);
  const end = maneuverFrom(route, { ...last, next: null, step: route.steps.at(-1), remainingDistance: 5 });
  assert.equal(end.icon, 'arrive');
  assert.equal(end.distance, 5);
  assert.equal(maneuverFrom(null, null), null);
});

test('maneuverIcon: mọi kiểu bước của routing.js', () => {
  assert.equal(maneuverIcon({ type: 'depart', icon: { kind: 'arrow', angle: 0 } }), 'depart');
  assert.equal(maneuverIcon({ type: 'arrive', icon: { kind: 'arrive' } }), 'arrive');
  assert.equal(maneuverIcon({ type: 'ferry', icon: { kind: 'arrow', angle: 0 } }), 'ferry');
  assert.equal(maneuverIcon({ type: 'continue', icon: { kind: 'uturn' } }), 'uturn');
  assert.equal(maneuverIcon({ type: 'roundabout', icon: { kind: 'roundabout', exit: 2 } }), 'roundabout');
  const angles = { '-135': 'sharp-left', '-90': 'left', '-45': 'slight-left', 0: 'straight', 45: 'slight-right', 90: 'right', 135: 'sharp-right' };
  for (const [a, name] of Object.entries(angles)) assert.equal(maneuverIcon({ type: 'turn', icon: { kind: 'arrow', angle: Number(a) } }), name);
  assert.equal(maneuverIcon({ type: 'turn', icon: { kind: 'arrow', angle: 10 } }), null);
  assert.equal(maneuverIcon({}), null);
  const r = maneuverFrom({ steps: [{ distance: 50 }, { type: 'roundabout', text: 'Vào vòng xuyến, đi theo lối ra thứ 2', icon: { kind: 'roundabout', exit: 2 } }] }, null);
  assert.equal(r.exit, 2);
});

test('routeWindow: đoạn tuyến gần xe, [lat, lon], tối đa 400 điểm', () => {
  const route = parseRoute(sampleOsrmRoute()); // 1,6 km, điểm cách nhau 50 m
  const all = routeWindow(route, 0);
  assert.equal(all.length, route.coords.length);
  assert.deepEqual(all[0], [round6(route.coords[0][1]), round6(route.coords[0][0])]);
  const w = routeWindow(route, 800, { behind: 100, ahead: 300 });
  assert.ok(w.length >= 8 && w.length <= 11, `${w.length}`);
  // Điểm đầu của cửa sổ ở sau vị trí 100–150 m, điểm cuối ở trước ít nhất 300 m.
  const at = (p) => route.coords.findIndex((c) => round6(c[1]) === p[0] && round6(c[0]) === p[1]);
  const s0 = route.cum[at(w[0])];
  const s1 = route.cum[at(w.at(-1))];
  assert.ok(s0 <= 700 + 1e-6 && s0 >= 650 - 1e-6, `${s0}`);
  assert.ok(s1 >= 1100 - 1e-6 && s1 <= 1150 + 1e-6, `${s1}`);
  // Tuyến dài: cắt còn 400 điểm.
  const coords = Array.from({ length: 2000 }, (_, i) => destination(START, 0, i * 2));
  const cum = coords.map((_, i) => i * 2);
  assert.equal(routeWindow({ coords, cum }, 0).length, LIMITS.routePoints);
  assert.deepEqual(routeWindow(null, 0), []);
});

test('roadsNear: cắt đường trong bán kính, kèm một điểm ngoài ở mỗi mép, đường gần và đường lớn trước', () => {
  const flat = (pts) => pts.flatMap((c) => c);
  const line = (from, brg, n, step) => Array.from({ length: n }, (_, i) => destination(from, brg, i * step));
  const center = START;
  const westEnd = destination(center, 270, 950);
  const through = { id: 1, h: 'residential', g: flat(line(westEnd, 90, 20, 100)) }; // từ 950 m phía tây tới 950 m phía đông
  const far = { id: 2, h: 'primary', g: flat(line(destination(center, 0, 2000), 90, 5, 100)) };
  const trunk = { id: 3, h: 'trunk', g: flat(line(destination(center, 0, 300), 90, 3, 100)) };
  const odd = { id: 4, h: 'service', g: flat(line(destination(center, 180, 150), 90, 2, 50)) };
  const out = roadsNear([through, far, trunk, odd, { id: 5 }, null], center, { radius: 500 });
  assert.equal(out.length, 3, 'đường ngoài bán kính bị bỏ');
  // Gần trước; đường lớn được cộng điểm: trục chính cách 300 m đứng trước đường lạ cách 150 m.
  assert.deepEqual(out.map((r) => r.highway), ['residential', 'trunk', 'other']);
  const res = out.find((r) => r.highway === 'residential');
  assert.equal(res.points.length, 12, '10 điểm trong bán kính + 1 điểm ngoài mỗi mép');
  // Đường ra khỏi bán kính rồi quay lại: hai đoạn riêng.
  const uturn = { id: 6, h: 'tertiary', g: flat([...line(destination(center, 90, 200), 90, 8, 100), ...line(destination(center, 90, 900), 270, 8, 100).slice(1)]) };
  const parts = roadsNear([uturn], center, { radius: 500 });
  assert.equal(parts.length, 2);
  assert.ok(parts.every((r) => r.points.length >= 4 && r.highway === 'tertiary'));
  assert.equal(out.find((r) => r.highway === 'other').points.length, 2);
  // Hạn mức.
  const many = Array.from({ length: 100 }, (_, k) => ({ id: k, h: 'residential', g: flat(line(destination(center, 0, k * 5), 90, 40, 10)) }));
  const capped = roadsNear(many, center, { radius: 500 });
  assert.equal(capped.length, 50, '2 000 điểm / 40 điểm mỗi đường');
  assert.ok(capped.reduce((n, r) => n + r.points.length, 0) <= LIMITS.roadPointsTotal);
  assert.equal(roadsNear(many, center, { radius: 500, maxRoads: 7 }).length, 7);
  assert.equal(boundState({ nearbyRoads: capped }).nearbyRoads.length, 50);
});

test('RoadsMemo: chỉ tính lại khi xe dời xa hoặc sau một lúc', () => {
  const memo = new RoadsMemo();
  let calls = 0;
  const compute = () => [{ n: ++calls }];
  const t0 = 1000;
  assert.equal(memo.get(START, t0, compute)[0].n, 1);
  assert.equal(memo.get(destination(START, 0, ROADS_MOVE_M - 5), t0 + 1000, compute)[0].n, 1);
  assert.equal(memo.get(destination(START, 0, ROADS_MOVE_M + 5), t0 + 2000, compute)[0].n, 2);
  assert.equal(memo.get(destination(START, 0, ROADS_MOVE_M + 5), t0 + 2000 + ROADS_REFRESH_MS, compute)[0].n, 3);
  assert.deepEqual(memo.get(null, t0, compute), []);
});

test('RoadData.waysNear: đường có đoạn quanh vị trí, mỗi đường một lần (bản của ô mới nhất)', () => {
  const roads = new RoadData({ fetchImpl: async () => ({ ok: false }), cache: { get: async () => null, put: async () => {} } });
  const mk = (id, from, h = 'residential') => {
    const g = [];
    for (let i = 0; i < 5; i++) g.push(...destination(from, 90, i * 50));
    return { id, n: '', h, c: null, m: null, o: 0, g };
  };
  const [cx, cy] = cellOf(START);
  const near = mk(1, START);
  const far = mk(2, destination(START, 0, 1500));
  roads.setCell(cellKey(cx, cy), { ways: [near, far], points: [], v: 3, t: Date.now() });
  roads.setCell(cellKey(cx - 1, cy), { ways: [{ ...near, h: 'old' }], points: [], v: 3, t: Date.now() - 1e6 });
  const got = roads.waysNear(START, 500);
  assert.deepEqual(got.map((w) => w.id), [1]);
  assert.equal(got[0].h, 'residential');
  assert.deepEqual(roads.waysNear(START, 2000).map((w) => w.id).sort(), [1, 2]);
});

test('positionFrom, cameraStatus, obdStatus', () => {
  assert.deepEqual(positionFrom({ coord: [106.7, 10.77], heading: -90, accuracy: 7 }), { lat: 10.77, lon: 106.7, heading: 270, accuracy: 7, ts: null });
  assert.equal(positionFrom({ coord: [106.7, 10.77], time: 1764000000000 }).ts, 1764000000000);
  assert.equal(positionFrom({ coord: [106.7, 10.77], time: 1 }, 5, 1764000000123).ts, 1764000000123);
  assert.equal(positionFrom({ coord: [106.7, 10.77], heading: null }).heading, null);
  assert.equal(positionFrom({ coord: [106.7, 10.77], heading: 720.5 }, 3).heading, 0.5);
  assert.equal(positionFrom(null), null);

  assert.equal(cameraStatus(null), 'off');
  assert.equal(cameraStatus({ enabled: false, camera: 'on', capturing: true }), 'off');
  assert.equal(cameraStatus({ enabled: true, camera: 'off' }), 'off');
  assert.equal(cameraStatus({ enabled: true, camera: 'starting' }), 'starting');
  assert.equal(cameraStatus({ enabled: true, camera: 'on', capturing: true, level: 2 }), 'running');
  assert.equal(cameraStatus({ enabled: true, camera: 'on', capturing: true, level: 0 }), 'paused');
  assert.equal(cameraStatus({ enabled: true, camera: 'on', capturing: false }), 'paused');
  assert.equal(cameraStatus({ enabled: true, camera: 'paused' }), 'paused');
  assert.equal(cameraStatus({ enabled: true, camera: 'error:denied' }), 'error');
  assert.equal(cameraStatus({ enabled: true, camera: 'on', visionError: 'worker' }), 'error');

  assert.equal(obdStatus('ready'), 'connected');
  for (const s of ['connecting', 'init', 'searching', 'lost', 'nocar']) assert.equal(obdStatus(s), 'connecting');
  assert.equal(obdStatus('error'), 'error');
  assert.equal(obdStatus('idle'), 'off');
  assert.equal(obdStatus('ready', false), 'off');
});

// ---------- CarBridge: bắt tay, nhịp gửi, chỉ gửi khi đổi ----------

test('CarBridge: gửi hello khi bắt đầu, chưa có "native" thì không gửi state và không dựng dữ liệu', () => {
  const env = fakeEnv();
  const b = env.bridge({ webVersion: 'v8' });
  b.start();
  assert.deepEqual(env.hellos(), [{ v: 1, type: 'hello', webVersion: 'v8' }]);
  let built = 0;
  const collect = () => (built++, { speed: 10 });
  b.publish(collect);
  env.advance(1000);
  b.publish(collect);
  assert.equal(env.states().length, 0);
  assert.equal(built, 0, 'chưa tới lượt thì không dựng dữ liệu');
  // Gửi lại hello mỗi 3 giây, tối đa 5 lần.
  for (let i = 0; i < 20; i++) {
    env.advance(1000);
    b.publish(collect);
  }
  assert.equal(env.hellos().length, 5);
  assert.equal(env.bridge({ webVersion: 'bad version!' }).ready, false);
});

test('CarBridge: webVersion sai dạng thì không gửi kèm', () => {
  const env = fakeEnv();
  env.bridge({ webVersion: '<script>' }).start();
  assert.deepEqual(env.hellos(), [{ v: 1, type: 'hello' }]);
});

test('CarBridge: đang chiếu lên xe thì gửi ngay, tối đa 4 lần/giây, chỉ khi đổi, giữ nhịp mỗi 2 giây', () => {
  const env = fakeEnv();
  const b = env.bridge();
  b.start();
  let speed = 10;
  let built = 0;
  const collect = () => (built++, { speed, camera: 'off' });
  b.publish(collect);
  env.native({ v: 1, type: 'native', carConnected: true, appVersion: '0.1.0' });
  assert.equal(b.ready, true);
  assert.equal(b.carConnected, true);
  assert.equal(b.appVersion, '0.1.0');
  assert.equal(env.states().length, 1, 'có "native" là gửi ngay ảnh đầy đủ');
  assert.equal(env.states()[0].speed, 10);
  assert.equal(env.states()[0].ts, env.now());

  // Gọi dồn dập 50 lần/giây trong 2 giây, tốc độ đổi liên tục: tối đa 4 thông điệp mỗi giây.
  const start = env.now();
  const sentAt = [];
  for (let i = 0; i < 100; i++) {
    speed = 20 + i * 0.5;
    b.publish(collect);
    const n = env.states().length;
    env.advance(20);
    if (env.states().length > n) sentAt.push(env.now());
  }
  const times = env.states().slice(1).map((m) => m.ts);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= SEND_INTERVAL_MS, `cách nhau ${times[i] - times[i - 1]} ms`);
  for (let s = start; s < env.now(); s += 1000) {
    assert.ok(times.filter((t) => t >= s && t < s + 1000).length <= 4);
  }
  assert.ok(times.length >= 7, `${times.length}`);
  assert.ok(built <= times.length + 2, `dựng ${built} lần cho ${times.length} thông điệp`);
  // Lần gọi cuối rơi vào lúc chưa tới lượt: được gửi bù đúng lúc tới lượt, với dữ liệu mới nhất.
  env.advance(SEND_INTERVAL_MS);
  assert.equal(env.states().at(-1).speed, Math.round((20 + 99 * 0.5) * 10) / 10);

  // Không đổi: không gửi lại, trừ nhịp giữ mỗi KEEPALIVE_MS (2 s, máy coi là cũ sau 5 s).
  assert.equal(KEEPALIVE_MS, 2000);
  const before = env.states().length;
  const lastAt = env.states().at(-1).ts;
  while (env.now() + 250 < lastAt + KEEPALIVE_MS) {
    env.advance(250);
    b.publish(collect);
  }
  assert.equal(env.states().length, before);
  // Nhịp giữ tự hẹn giờ: không cần ai gọi publish() (main.js bị chậm, trang bị ẩn…).
  env.advance(lastAt + KEEPALIVE_MS - env.now());
  assert.equal(env.states().length, before + 1);
  assert.equal(env.states().at(-1).ts, lastAt + KEEPALIVE_MS);
  env.advance(3 * KEEPALIVE_MS);
  assert.equal(env.states().length, before + 4);
  const ts = env.states().map((m) => m.ts);
  for (let i = before; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] <= KEEPALIVE_MS, `cách ${ts[i] - ts[i - 1]} ms`);
  // Có thay đổi khi đang chờ nhịp giữ: vẫn gửi ngay khi tới lượt (không phải đợi tới nhịp giữ).
  env.advance(300);
  speed = 99;
  b.publish(collect);
  assert.equal(env.states().at(-1).speed, 99);
  // Dừng: không còn hẹn giờ nào.
  b.stop();
  const n = env.states().length;
  env.advance(10 * KEEPALIVE_MS);
  assert.equal(env.states().length, n);
});

test('CarBridge: chưa chiếu lên xe thì gửi thưa; cắm vào xe thì gửi ngay; rút ra thì thưa lại', () => {
  const env = fakeEnv();
  const b = env.bridge();
  b.start();
  let speed = 10;
  const collect = () => ({ speed: speed++ });
  b.publish(collect);
  env.native({ v: 1, type: 'native', carConnected: false });
  assert.equal(env.states().length, 1);
  for (let i = 0; i < 40; i++) {
    env.advance(250);
    b.publish(collect);
  }
  assert.equal(env.states().length, 1 + Math.floor((40 * 250) / IDLE_INTERVAL_MS));
  const n = env.states().length;
  env.native({ v: 1, type: 'carConnected', connected: true });
  assert.equal(env.states().length, n + 1, 'cắm vào xe: gửi ngay');
  env.advance(SEND_INTERVAL_MS);
  b.publish(collect);
  assert.equal(env.states().length, n + 2);
  env.native({ v: 1, type: 'carConnected', connected: false });
  assert.equal(b.carConnected, false);
  env.advance(SEND_INTERVAL_MS);
  b.publish(collect);
  assert.equal(env.states().length, n + 2, 'rút ra: thưa lại');
});

test('CarBridge: bỏ qua thông điệp sai dạng hay type lạ từ máy', () => {
  const env = fakeEnv();
  const b = env.bridge();
  const changes = [];
  b.onChange((s) => changes.push(s));
  b.start();
  for (const bad of [null, 'native', 42, {}, { v: 2, type: 'native' }, { v: '1', type: 'native' }, { v: 1, type: 'openUrl', url: 'https://x' }, { v: 1 }]) {
    env.native(bad);
  }
  assert.equal(b.ready, false);
  assert.equal(changes.length, 0);
  env.native({ v: 1, type: 'carConnected', connected: 'yes' });
  assert.equal(b.carConnected, false);
  env.native({ v: 1, type: 'native', carConnected: 1, appVersion: '<b>x</b>' });
  assert.equal(b.ready, true);
  assert.equal(b.carConnected, false, 'chỉ đúng true mới là đang chiếu');
  assert.equal(b.appVersion, null);
  assert.deepEqual(changes, [{ ready: true, carConnected: false }]);
  b.stop();
  env.native({ v: 1, type: 'carConnected', connected: true });
  assert.equal(b.carConnected, false, 'đã dừng thì không nghe nữa');
});

test('CarBridge: lỗi của dữ liệu hay của kênh không làm hỏng ứng dụng', () => {
  const env = fakeEnv();
  const b = env.bridge();
  b.start();
  env.native({ v: 1, type: 'native', carConnected: true });
  assert.doesNotThrow(() =>
    b.publish(() => {
      throw new Error('hỏng');
    })
  );
  assert.equal(env.states().length, 0);
  env.channel.postMessage = () => {
    throw new Error('kênh đóng');
  };
  env.advance(1000);
  assert.doesNotThrow(() => b.publish(() => ({ speed: 1 })));
  assert.doesNotThrow(() => b.publish('không phải hàm'));
  // Dữ liệu lạ đi qua boundState: vẫn ra thông điệp đúng hợp đồng.
  const sent = [];
  env.channel.postMessage = (s) => sent.push(s);
  env.advance(1000);
  b.publish(() => ({ speed: 'nhanh', alerts: 'nhiều', route: { a: 1 }, nearbyRoads: [{ points: 5 }], position: [1, 2], obd: {} }));
  const msg = JSON.parse(sent.at(-1));
  assert.equal(msg.type, 'state');
  assert.equal(msg.speed, null);
  assert.deepEqual(msg.alerts, []);
  assert.deepEqual(msg.route, []);
  assert.deepEqual(msg.nearbyRoads, []);
  assert.equal(msg.position, null);
  assert.equal(msg.obd, 'off');
});

test('alertId: mã ngắn, ổn định, khớp CODE_RE, khác nhau theo khoá; boundState giữ id hợp lệ, bỏ id sai', () => {
  const ids = ['n1', 'n2', 'r1', 'way/123456789:node/987654321:fwd:P.127[50]', 42].map((k) => alertId('p', k));
  for (const id of ids) assert.match(id, /^[A-Za-z0-9._:-]{1,32}$/);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(alertId('p', 'n1'), alertId('p', 'n1'));
  assert.notEqual(alertId('p', 'n1'), alertId('s', 'n1'));
  assert.equal(alertId('p', null), null);
  assert.equal(alertId('p', ''), null);
  assert.equal(alertId('p', { x: 1 }), null);
  const a = (id) => ({ kind: 'camera', code: 'speed_camera', text: 'Camera', distance: 100, id });
  assert.deepEqual(boundState({ alerts: [a('p1x'), a('có dấu cách'), a('x'.repeat(33)), a(5)] }).alerts.map((x) => x.id), ['p1x', null, null]);
});
