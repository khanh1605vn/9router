import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStep, fetchRoutes, parseRoute, roadLabel, RouteError } from '../js/routing.js';
import { normalizeForSpeech } from '../js/voice.js';
import { parseLatLon } from '../js/search.js';
import { sampleOsrmRoute } from './fixtures.mjs';

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

test('fetchRoutes: xe máy yêu cầu tránh cao tốc, tự nới điều kiện khi máy chủ từ chối', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('exclude=')) {
      return new Response(JSON.stringify({ code: 'InvalidValue', message: 'Exclude flag combination is not supported.' }), { status: 400 });
    }
    return new Response(JSON.stringify({ code: 'Ok', routes: [sampleOsrmRoute()] }), { status: 200 });
  };
  try {
    const out = await fetchRoutes([106.7, 10.77], [106.71, 10.78], { vehicle: 'moto' });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /exclude=motorway/);
    assert.doesNotMatch(calls[1], /exclude=/);
    assert.equal(out.relaxed, true);
    assert.equal(out.routes.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchRoutes: báo lỗi dễ hiểu khi không có đường hoặc mất mạng', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'NoRoute' }), { status: 400 });
    await assert.rejects(fetchRoutes([106.7, 10.77], [106.71, 10.78]), (e) => e instanceof RouteError && e.code === 'NoRoute');
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(fetchRoutes([106.7, 10.77], [106.71, 10.78]), (e) => e instanceof RouteError && e.code === 'Network');
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
