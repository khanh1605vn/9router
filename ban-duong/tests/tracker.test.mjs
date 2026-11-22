import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../js/routing.js';
import { RouteTracker, spokenDistance } from '../js/tracker.js';
import { destination } from '../js/geo.js';
import { driveAlong, sampleOsrmRoute } from './fixtures.mjs';

test('khoảng cách dạng đọc', () => {
  assert.equal(spokenDistance(42), '40 mét');
  assert.equal(spokenDistance(480), '500 mét');
  assert.equal(spokenDistance(1480), '1,5 ki lô mét');
  assert.equal(spokenDistance(2000), '2 ki lô mét');
  assert.equal(spokenDistance(25300), '25 ki lô mét');
});

test('đọc chỉ dẫn đúng thứ tự: xuất phát → còn 500 m → còn 200 m → rẽ → đến nơi', () => {
  const route = parseRoute(sampleOsrmRoute());
  const tracker = new RouteTracker(route);
  const cues = [];
  let last = null;
  for (const fix of driveAlong(route, 10)) {
    last = tracker.update(fix);
    if (last.cue) cues.push(`${last.cue.level}: ${last.cue.text}`);
  }
  assert.deepEqual(cues, [
    'start: Đi về hướng Bắc trên đường Nguyễn Trãi, rồi đi tiếp 1 ki lô mét',
    'far: Còn 500 mét, rẽ phải vào đường Lê Lợi',
    'mid: Còn 200 mét, rẽ phải vào đường Lê Lợi',
    'near: Rẽ phải',
    'far: Còn 500 mét nữa là đến nơi',
    'mid: Còn 200 mét nữa là đến nơi',
    'arrive: Bạn đã đến nơi. Điểm đến ở bên phải.',
  ]);
  assert.equal(last.arrived, true);
  assert.equal(last.offRoute, false);
});

test('theo dõi quãng đường và thời gian còn lại', () => {
  const route = parseRoute(sampleOsrmRoute());
  const tracker = new RouteTracker(route);
  const fixes = driveAlong(route, 10, { to: 400 });
  let p;
  for (const fix of fixes) p = tracker.update(fix);
  assert.equal(p.stepIndex, 0);
  assert.equal(p.next.type, 'turn');
  assert.ok(Math.abs(p.distToNext - 600) < 3, `distToNext = ${p.distToNext}`);
  assert.ok(Math.abs(p.remainingDistance - 1200) < 3);
  // Còn 60% bước đầu (120 s) + trọn bước sau (72 s).
  assert.ok(Math.abs(p.remainingDuration - (0.6 * 120 + 72)) < 1, `remainingDuration = ${p.remainingDuration}`);
  assert.equal(p.onRoute, true);
});

test('lệch nhẹ do sai số GPS vẫn bám tuyến; lệch hẳn thì báo tìm lại đường', () => {
  const route = parseRoute(sampleOsrmRoute());
  const drift = new RouteTracker(route);
  for (const fix of driveAlong(route, 10, { to: 300, offset: 20 })) {
    const p = drift.update(fix);
    assert.equal(p.offRoute, false);
    assert.equal(p.onRoute, true);
  }

  const tracker = new RouteTracker(route);
  for (const fix of driveAlong(route, 10, { to: 300 })) tracker.update(fix);
  // Rẽ sang đường khác: đi về hướng Tây, xa dần tuyến.
  const origin = route.coords[6];
  let off = false;
  let time = 2_000_000;
  for (let d = 20; d <= 200 && !off; d += 10) {
    const p = tracker.update({ coord: destination(origin, 270, d), speed: 10, heading: 270, accuracy: 5, time });
    time += 1000;
    off = p.offRoute;
  }
  assert.equal(off, true);
});

test('đứng yên ngoài tuyến không kích hoạt tìm lại đường', () => {
  const route = parseRoute(sampleOsrmRoute());
  const tracker = new RouteTracker(route);
  const spot = destination(route.coords[3], 270, 120);
  let time = 3_000_000;
  for (let i = 0; i < 10; i++) {
    const p = tracker.update({ coord: spot, speed: 0, heading: null, accuracy: 10, time });
    time += 1000;
    assert.equal(p.offRoute, false);
  }
});
