import test from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff,
  bearing,
  compassName,
  cumulativeDistances,
  destination,
  distance,
  formatDistance,
  formatDuration,
  nearestOnLine,
  pointAtDistance,
  projectOnSegment,
} from '../js/geo.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} mong đợi ${expected} ± ${tol}, nhận ${actual}`);

test('khoảng cách: 1 độ vĩ tuyến dài khoảng 111,2 km', () => {
  near(distance([106, 10], [106, 11]), 111195, 100);
});

test('góc phương vị theo bốn hướng chính', () => {
  near(bearing([106, 10], [106, 11]), 0, 0.01);
  near(bearing([106, 10], [107, 10]), 90, 0.2);
  near(bearing([106, 10], [106, 9]), 180, 0.01);
  near(bearing([106, 10], [105, 10]), 270, 0.2);
});

test('hiệu góc luôn lấy đường ngắn nhất', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  assert.equal(angleDiff(0, 180), 180);
});

test('destination và distance khớp nhau', () => {
  const a = [106.7, 10.77];
  const b = destination(a, 47, 1234);
  near(distance(a, b), 1234, 0.5);
  near(bearing(a, b), 47, 0.05);
});

test('chiếu điểm lên đoạn thẳng', () => {
  const a = [106.7, 10.77];
  const b = destination(a, 0, 1000);
  const p = destination(destination(a, 0, 400), 90, 30); // cách đầu đoạn 400 m, lệch phải 30 m
  const r = projectOnSegment(p, a, b);
  near(r.t, 0.4, 0.005);
  near(r.dist, 30, 0.5);
  // Điểm nằm ngoài đầu mút thì bị kẹp về đầu mút.
  assert.equal(projectOnSegment(destination(a, 180, 50), a, b).t, 0);
});

test('điểm gần nhất trên đường gấp khúc và điểm theo quãng đường', () => {
  const a = [106.7, 10.77];
  const b = destination(a, 0, 500);
  const c = destination(b, 90, 500);
  const coords = [a, b, c];
  const cum = cumulativeDistances(coords);
  near(cum[2], 1000, 1);
  const hit = nearestOnLine(destination(b, 90, 200), coords);
  assert.equal(hit.index, 1);
  near(hit.t, 0.4, 0.01);
  const at = pointAtDistance(coords, cum, 700);
  assert.equal(at.index, 1);
  near(distance(at.point, destination(b, 90, 200)), 0, 1);
  near(at.bearing, 90, 0.5);
});

test('định dạng khoảng cách và thời gian kiểu Việt Nam', () => {
  assert.equal(formatDistance(348), '350 m');
  assert.equal(formatDistance(1240), '1,2 km');
  assert.equal(formatDistance(25400), '25 km');
  assert.equal(formatDuration(40), '1 phút');
  assert.equal(formatDuration(725), '12 phút');
  assert.equal(formatDuration(3900), '1 giờ 5 phút');
  assert.equal(formatDuration(7200), '2 giờ');
});

test('tên hướng la bàn', () => {
  assert.equal(compassName(0), 'Bắc');
  assert.equal(compassName(44), 'Đông Bắc');
  assert.equal(compassName(180), 'Nam');
  assert.equal(compassName(359), 'Bắc');
});
