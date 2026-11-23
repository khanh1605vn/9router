import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../js/routing.js';
import { CAMERA_HOLD_MAX_MS, CAMERA_HOLD_S, CameraSayGate, RouteTracker, spokenDistance } from '../js/tracker.js';
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

test('câu biển camera ngay trước câu "Còn … mét, rẽ …": giữ tới sau câu rẽ; câu có biển bản đồ đọc ngay; không bao giờ bỏ', () => {
  const route = parseRoute(sampleOsrmRoute());
  const CAM = [{ code: 'P.127', src: 'camera' }];
  const OSM = [{ code: 'P.127' }];
  // Lái 10 m/s; câu biển xuất hiện khi còn cách chỗ rẽ `ahead` m (câu far đọc ở 500 m).
  const run = (ahead, items, { stopAt = null } = {}) => {
    const tracker = new RouteTracker(route);
    let t = 0;
    const gate = new CameraSayGate({ now: () => t });
    const said = [];
    let offered = false;
    for (const fix of driveAlong(route, 10)) {
      t = fix.time;
      let p = tracker.update(fix);
      if (stopAt != null && offered) {
        // Xe dừng (kẹt xe) ngay sau khi câu biển xuất hiện: câu rẽ không tới.
        for (let k = 0; k < 10; k++) {
          t += 1000;
          p = tracker.update({ ...fix, speed: 0, time: t });
          if (p.cue) said.push(`rẽ: ${p.cue.text}`);
          for (const s of gate.step({ tracker, progress: p, cue: p.cue })) said.push(`biển: ${s}@${t - stopAt}`);
        }
        break;
      }
      if (p.cue) said.push(`rẽ: ${p.cue.text}`);
      let say = null;
      if (!offered && p.next && p.distToNext <= 500 + ahead && p.distToNext > 500) {
        offered = true;
        say = 'Phía trước 100 mét, biển tốc độ tối đa 50 ki lô mét trên giờ (camera ghi nhận)';
        if (stopAt != null) stopAt = t;
      }
      for (const s of gate.step({ say, items, tracker, progress: p, cue: p.cue })) said.push(`biển: ${s}`);
    }
    return said;
  };
  const idx = (said, re) => said.findIndex((x) => re.test(x));
  // Camera, câu rẽ "Còn 500 mét" tới trong 5 giây (≤ 50 m ở 10 m/s): câu rẽ đọc trước, câu biển ngay sau.
  for (const ahead of [10, 30, 45]) {
    const said = run(ahead, CAM);
    const far = idx(said, /^rẽ: Còn 500 mét, rẽ phải/);
    const cam = idx(said, /^biển: .*camera ghi nhận/);
    assert.ok(far >= 0 && cam >= 0, JSON.stringify(said));
    assert.equal(cam, far + 1, `cách ${ahead} m: ${JSON.stringify(said)}`);
    assert.equal(said.filter((x) => /camera ghi nhận/.test(x)).length, 1, 'đọc đúng một lần');
  }
  // Câu rẽ còn xa (hơn 5 giây): câu biển đọc ngay như trước.
  let said = run(120, CAM);
  assert.ok(idx(said, /^biển:/) < idx(said, /^rẽ: Còn 500 mét/), JSON.stringify(said));
  // Câu có biển bản đồ: luôn đọc ngay, kể cả ngay trước câu rẽ.
  said = run(30, OSM);
  assert.ok(idx(said, /^biển:/) < idx(said, /^rẽ: Còn 500 mét/), JSON.stringify(said));
  // Xe dừng giữa chừng: câu rẽ không còn sắp tới nên câu biển được đọc (muộn nhất CAMERA_HOLD_MAX_MS), không bị bỏ.
  said = run(30, CAM, { stopAt: 0 });
  const late = said.find((x) => /^biển:/.test(x));
  assert.ok(late, JSON.stringify(said));
  assert.ok(Number(late.split('@')[1]) <= CAMERA_HOLD_MAX_MS + 1000, late);
  assert.equal(CAMERA_HOLD_S, 5);
});

test('cueSoon: chỉ câu far/mid chưa đọc, trong khoảng cho trước', () => {
  const route = parseRoute(sampleOsrmRoute());
  const tracker = new RouteTracker(route);
  const soon = [];
  for (const fix of driveAlong(route, 10)) {
    const p = tracker.update(fix);
    if (p.next && tracker.cueSoon(p, 50)) soon.push(Math.round(p.distToNext));
    assert.equal(tracker.cueSoon(p, 0), false);
    assert.equal(tracker.cueSoon(null, 50), false);
  }
  // Mỗi chỗ rẽ: chỉ trong 50 m trước mốc 500 m và 200 m.
  assert.ok(soon.length > 0);
  assert.ok(soon.every((d) => (d > 500 && d <= 550) || (d > 200 && d <= 250)), JSON.stringify(soon));
});
