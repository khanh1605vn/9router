// Dữ liệu giả lập cho kiểm thử: một phản hồi theo đúng cấu trúc của OSRM, dựng bằng hình học
// (không phải dữ liệu đường thật). Tuyến: đi về hướng Bắc 1 km trên Nguyễn Trãi, rẽ phải,
// đi về hướng Đông 600 m trên Lê Lợi rồi đến nơi ở bên phải.

import { destination } from '../js/geo.js';

export const START = [106.7, 10.77];

function lineFrom(start, brg, length, stepLen = 50) {
  const pts = [start];
  for (let d = stepLen; d <= length; d += stepLen) pts.push(destination(start, brg, d));
  return pts;
}

export function sampleOsrmRoute() {
  const north = lineFrom(START, 0, 1000);
  const corner = north[north.length - 1];
  const mid = lineFrom(corner, 0, 0); // chỉ để rõ ý: điểm rẽ trùng điểm cuối đoạn đầu
  const east = lineFrom(corner, 90, 600);
  const end = east[east.length - 1];
  const half = Math.floor(north.length / 2);

  return {
    distance: 1600,
    duration: 192,
    legs: [
      {
        summary: 'Nguyễn Trãi, Lê Lợi',
        steps: [
          {
            name: 'Nguyễn Trãi',
            distance: 500,
            duration: 60,
            geometry: { coordinates: north.slice(0, half + 1) },
            maneuver: { type: 'depart', bearing_after: 0, location: north[0] },
            intersections: [{ classes: [] }],
          },
          {
            // Chỉ đổi tên đường: phải được gộp vào bước trước.
            name: 'Nguyễn Trãi nối dài',
            distance: 500,
            duration: 60,
            geometry: { coordinates: north.slice(half) },
            maneuver: { type: 'new name', modifier: 'straight', bearing_after: 0, location: north[half] },
            intersections: [{ classes: [] }],
          },
          {
            name: 'Lê Lợi',
            distance: 600,
            duration: 72,
            geometry: { coordinates: east },
            maneuver: { type: 'turn', modifier: 'right', bearing_after: 90, location: mid[0] },
            intersections: [{ classes: ['toll'] }],
          },
          {
            name: 'Lê Lợi',
            distance: 0,
            duration: 0,
            geometry: { coordinates: [end, end] },
            maneuver: { type: 'arrive', modifier: 'right', location: end },
            intersections: [{}],
          },
        ],
      },
    ],
  };
}

/** Dãy lần định vị chạy dọc tuyến với tốc độ cố định (m/s), mỗi giây một lần. */
export function driveAlong(route, speed, { from = 0, to = Infinity, offset = 0 } = {}) {
  const total = route.cum[route.cum.length - 1];
  const fixes = [];
  let time = 1_000_000;
  for (let s = from; s <= Math.min(to, total); s += speed) {
    let i = 0;
    while (i < route.cum.length - 2 && route.cum[i + 1] <= s) i++;
    const seg = route.cum[i + 1] - route.cum[i];
    const t = seg ? (s - route.cum[i]) / seg : 0;
    const a = route.coords[i];
    const b = route.coords[i + 1];
    let coord = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const heading = (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI;
    if (offset) coord = destination(coord, heading + 90, offset);
    fixes.push({ coord, speed, heading: (heading + 360) % 360, accuracy: 5, time });
    time += 1000;
  }
  return fixes;
}
