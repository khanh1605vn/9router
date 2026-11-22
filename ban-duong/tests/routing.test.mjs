import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline6, describeStep, fetchRoutes, parseRoute, parseValhallaTrip, roadLabel, RouteError } from '../js/routing.js';
import { normalizeForSpeech } from '../js/voice.js';
import { parseLatLon } from '../js/search.js';
import { encodePolyline6, sampleOsrmRoute, sampleValhallaTrip } from './fixtures.mjs';

const step = (type, modifier, extra = {}) => ({ name: '', ...extra, maneuver: { type, modifier, ...(extra.maneuver || {}) } });

test('tên đường ghép vào câu đúng chính tả', () => {
  assert.equal(roadLabel('Nguyễn Trãi'), 'đường Nguyễn Trãi');
  assert.equal(roadLabel('Đường Nguyễn Trãi'), 'đường Nguyễn Trãi');
  assert.equal(roadLabel('Đại lộ Võ Văn Kiệt'), 'đại lộ Võ Văn Kiệt');
  assert.equal(roadLabel('Cầu Sài Gòn'), 'cầu Sài Gòn');
  assert.equal(roadLabel('QL1A'), 'QL1A');
  assert.equal(roadLabel('', 'ĐT743;QL13'), 'ĐT743');
  assert.equal(roadLabel('', ''), '');
});

test('câu chỉ dẫn cho các kiểu rẽ', () => {
  assert.equal(describeStep(step('turn', 'right', { name: 'Lê Lợi' })).text, 'Rẽ phải vào đường Lê Lợi');
  assert.equal(describeStep(step('turn', 'sharp left')).text, 'Rẽ ngoặt trái');
  assert.equal(describeStep(step('turn', 'uturn')).icon.kind, 'uturn');
  assert.equal(describeStep(step('end of road', 'left', { name: 'Hai Bà Trưng' })).text, 'Cuối đường, rẽ trái vào đường Hai Bà Trưng');
  assert.equal(describeStep(step('fork', 'slight left')).text, 'Giữ bên trái tại ngã rẽ');
  assert.equal(describeStep(step('merge', 'slight right', { name: 'Xa lộ Hà Nội' })).text, 'Nhập làn sang phải vào xa lộ Hà Nội');
  assert.equal(describeStep(step('off ramp', 'right', { destinations: 'Biên Hoà, Vũng Tàu' })).text, 'Đi theo lối ra bên phải hướng Biên Hoà');
  assert.equal(describeStep(step('continue', 'straight', { name: 'QL1A' })).text, 'Đi tiếp trên QL1A');
  assert.equal(describeStep(step('ferry', '', { name: 'Phà Vũng Tàu - Cần Giờ' })).text, 'Lên phà Vũng Tàu - Cần Giờ');
  assert.equal(describeStep(step('ferry', '', { name: 'Đò Phước Khánh' })).text, 'Lên đò Phước Khánh');
  assert.equal(describeStep(step('ferry', '', { name: 'Bình Khánh' })).text, 'Lên phà Bình Khánh');
  assert.equal(describeStep(step('ferry')).text, 'Lên phà');
  assert.equal(describeStep(step('ferry exit', '', { name: 'Rừng Sác' })).text, 'Rời phà vào đường Rừng Sác');
});

test('vòng xuyến nêu rõ lối ra', () => {
  const d = describeStep(step('roundabout', 'right', { name: 'Điện Biên Phủ', maneuver: { exit: 3 } }));
  assert.equal(d.text, 'Vào vòng xuyến, đi theo lối ra thứ 3 vào đường Điện Biên Phủ');
  assert.equal(d.short, 'Lối ra thứ 3');
  assert.deepEqual(d.icon, { kind: 'roundabout', exit: 3 });
});

test('xuất phát và đến nơi', () => {
  assert.equal(describeStep(step('depart', undefined, { name: 'Nguyễn Trãi', maneuver: { bearing_after: 92 } })).text, 'Đi về hướng Đông trên đường Nguyễn Trãi');
  assert.equal(describeStep(step('arrive', 'left')).text, 'Đến nơi, điểm đến ở bên trái');
  assert.equal(describeStep(step('arrive')).text, 'Đến nơi');
});

test('parseRoute gộp bước chỉ đổi tên đường và nối hình học liền mạch', () => {
  const route = parseRoute(sampleOsrmRoute());
  assert.deepEqual(route.steps.map((s) => s.type), ['depart', 'turn', 'arrive']);
  assert.equal(route.steps[0].distance, 1000); // 500 + 500 đã gộp
  assert.equal(route.steps[0].duration, 120);
  assert.equal(route.coords.length, 33); // 21 điểm hướng Bắc + 12 điểm hướng Đông, không lặp điểm nối
  assert.equal(route.steps[1].index, 20);
  assert.equal(route.steps[2].index, route.coords.length - 1);
  assert.ok(Math.abs(route.cum[route.cum.length - 1] - 1600) < 2);
  assert.equal(route.hasToll, true);
  assert.equal(route.hasMotorway, false);
  assert.equal(route.summary, 'Nguyễn Trãi, Lê Lợi');
  assert.equal(route.steps[1].text, 'Rẽ phải vào đường Lê Lợi');
});

test('giải mã polyline của Valhalla', () => {
  const pts = [[106.7, 10.77], [106.700123, 10.770456], [106.69, 10.8]];
  const back = decodePolyline6(encodePolyline6(pts));
  assert.equal(back.length, 3);
  back.forEach((c, i) => {
    assert.ok(Math.abs(c[0] - pts[i][0]) < 1e-6 && Math.abs(c[1] - pts[i][1]) < 1e-6);
  });
});

test('parseValhallaTrip cho cùng cấu trúc tuyến như OSRM', () => {
  const route = parseValhallaTrip(sampleValhallaTrip());
  assert.deepEqual(route.steps.map((s) => s.type), ['depart', 'roundabout', 'exit roundabout', 'arrive']);
  assert.equal(route.steps[0].distance, 1000); // bước "đi tiếp" đã gộp vào bước xuất phát
  assert.equal(route.steps[0].text, 'Đi về hướng Bắc trên đường Nguyễn Trãi');
  // Tên đường ra khỏi vòng xuyến lấy từ bước kế tiếp, không lấy tên của chính vòng xuyến.
  assert.equal(route.steps[1].text, 'Vào vòng xuyến, đi theo lối ra thứ 2 vào QL.51');
  assert.equal(route.steps[2].text, 'Ra khỏi vòng xuyến vào QL.51');
  assert.equal(route.steps[3].text, 'Đến nơi, điểm đến ở bên phải');
  assert.equal(route.steps[1].index, 20);
  assert.equal(route.steps[3].index, route.coords.length - 1);
  assert.equal(route.coords.length, 33);
  assert.equal(route.distance, 1600);
  assert.equal(route.duration, 240);
  assert.equal(route.hasToll, true);
  assert.equal(route.summary, 'Nguyễn Trãi, QL.51');
});

const okJson = (body) => new Response(JSON.stringify(body), { status: 200 });

test('fetchRoutes: xe máy dùng hồ sơ xe hai bánh, ô tô tránh thu phí khi được yêu cầu', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(JSON.parse(new URL(url).searchParams.get('json')));
    return okJson({ trip: sampleValhallaTrip(), alternates: [{ trip: sampleValhallaTrip() }] });
  };
  try {
    const moto = await fetchRoutes([106.7, 10.77], [106.71, 10.78], { vehicle: 'moto', heading: 91.4 });
    assert.equal(moto.routes.length, 2);
    assert.equal(moto.relaxed, false);
    assert.equal(calls[0].costing, 'motor_scooter');
    assert.deepEqual(calls[0].locations[0], { lon: 106.7, lat: 10.77, heading: 91, heading_tolerance: 60 });
    await fetchRoutes([106.7, 10.77], [106.71, 10.78], { vehicle: 'car', avoidTolls: true });
    assert.equal(calls[1].costing, 'auto');
    assert.deepEqual(calls[1].costing_options, { auto: { use_tolls: 0 } });
    await fetchRoutes([106.7, 10.77], [106.71, 10.78]);
    assert.deepEqual(calls[2].costing_options, { auto: {} });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchRoutes: máy chủ chính hỏng thì dùng dự phòng và báo không bảo đảm tránh cao tốc', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('valhalla')) throw new TypeError('fetch failed');
    if (u.includes('exclude=')) {
      return new Response(JSON.stringify({ code: 'InvalidValue', message: 'Exclude flag combination is not supported.' }), { status: 400 });
    }
    return okJson({ code: 'Ok', routes: [sampleOsrmRoute()] });
  };
  try {
    const out = await fetchRoutes([106.7, 10.77], [106.71, 10.78], { vehicle: 'moto' });
    assert.equal(calls.length, 3);
    assert.match(calls[1], /exclude=motorway/);
    assert.doesNotMatch(calls[2], /exclude=/);
    assert.equal(out.relaxed, true);
    assert.equal(out.routes.length, 1);
    const car = await fetchRoutes([106.7, 10.77], [106.71, 10.78], { vehicle: 'car' });
    assert.equal(car.relaxed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchRoutes: báo lỗi dễ hiểu khi không có đường hoặc mất mạng', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      String(url).includes('valhalla')
        ? new Response(JSON.stringify({ error_code: 442, error: 'No path could be found for input' }), { status: 400 })
        : new Response(JSON.stringify({ code: 'NoRoute' }), { status: 400 });
    await assert.rejects(fetchRoutes([106.7, 10.77], [106.71, 10.78]), (e) => e instanceof RouteError && e.code === 'NoRoute');
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(fetchRoutes([106.7, 10.77], [106.71, 10.78]), (e) => e instanceof RouteError && e.code === 'Network');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchRoutes: người dùng huỷ thì không chuyển sang máy chủ dự phòng', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal }) =>
    new Promise((_, reject) => {
      calls++;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  try {
    const ctrl = new AbortController();
    const pending = fetchRoutes([106.7, 10.77], [106.71, 10.78], { signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(pending, (e) => e.name === 'AbortError');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('chuẩn hoá chữ tắt trước khi đọc', () => {
  assert.equal(normalizeForSpeech('Rẽ phải vào QL1A'), 'Rẽ phải vào Quốc lộ 1A');
  assert.equal(normalizeForSpeech('Đi tiếp trên ĐT743'), 'Đi tiếp trên Đường tỉnh 743');
  assert.equal(normalizeForSpeech('giới hạn 60 km/h'), 'giới hạn 60 ki lô mét trên giờ');
  assert.equal(normalizeForSpeech('Còn 350 m, rẽ trái'), 'Còn 350 mét, rẽ trái');
  // Chữ "mét" viết sẵn không bị thay lần nữa.
  assert.equal(normalizeForSpeech('Còn 350 mét, rẽ trái'), 'Còn 350 mét, rẽ trái');
  assert.equal(normalizeForSpeech('Đi tiếp 1,5 ki lô mét'), 'Đi tiếp 1,5 ki lô mét');
});

test('nhận dạng toạ độ nhập tay', () => {
  assert.deepEqual(parseLatLon('10.7769, 106.7009').coord, [106.7009, 10.7769]);
  assert.equal(parseLatLon('Bến Thành'), null);
  assert.equal(parseLatLon('95, 200'), null);
});
