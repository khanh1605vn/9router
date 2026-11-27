// Hình học trên mặt cầu + định dạng số đo. Toạ độ luôn theo thứ tự GeoJSON: [kinh độ, vĩ độ].

const R = 6371008.8; // bán kính Trái Đất trung bình (m)
const RAD = Math.PI / 180;

export const toRad = (d) => d * RAD;
export const toDeg = (r) => r / RAD;

/** Khoảng cách haversine giữa hai điểm (m). */
export function distance(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Góc phương vị từ a tới b, 0..360 (0 = Bắc, 90 = Đông). */
export function bearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x =
    Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
    Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Hiệu góc có dấu b − a, trong khoảng (−180, 180]. */
export function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Điểm cách p một đoạn dist (m) theo góc phương vị brg. */
export function destination(p, brg, dist) {
  const d = dist / R;
  const lat1 = p[1] * RAD;
  const lon1 = p[0] * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg * RAD)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg * RAD) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [lon2 / RAD, lat2 / RAD];
}

/**
 * Chiếu điểm p lên đoạn a–b (xấp xỉ phẳng quanh p, đủ chính xác với đoạn ngắn).
 * Trả về { t: vị trí 0..1 trên đoạn, point, dist: khoảng cách vuông góc (m) }.
 */
export function projectOnSegment(p, a, b) {
  const k = Math.cos(p[1] * RAD) * RAD * R;
  const m = RAD * R;
  const ax = (a[0] - p[0]) * k;
  const ay = (a[1] - p[1]) * m;
  const bx = (b[0] - p[0]) * k;
  const by = (b[1] - p[1]) * m;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return {
    t,
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    dist: Math.hypot(x, y),
  };
}

/**
 * Điểm gần p nhất trên đường gấp khúc, chỉ xét các đoạn [from, to).
 * Trả về { index: chỉ số đoạn, t, point, dist } hoặc null nếu không có đoạn nào.
 */
export function nearestOnLine(p, coords, from = 0, to = coords.length - 1) {
  let best = null;
  const start = Math.max(0, from);
  const end = Math.min(coords.length - 1, to);
  for (let i = start; i < end; i++) {
    const r = projectOnSegment(p, coords[i], coords[i + 1]);
    if (!best || r.dist < best.dist) best = { index: i, t: r.t, point: r.point, dist: r.dist };
  }
  return best;
}

/** Mảng khoảng cách cộng dồn dọc đường gấp khúc (m), cum[0] = 0. */
export function cumulativeDistances(coords) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + distance(coords[i - 1], coords[i]);
  return cum;
}

/** Điểm nằm cách đầu tuyến một quãng s (m), kèm chỉ số đoạn và hướng đi tại đó. */
export function pointAtDistance(coords, cum, s) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg === 0 ? 0 : (d - cum[lo]) / seg;
  const a = coords[lo];
  const b = coords[hi];
  return {
    index: lo,
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    bearing: seg === 0 ? 0 : bearing(a, b),
  };
}

/** Đa giác xấp xỉ hình tròn (dùng vẽ vòng sai số GPS). */
export function circlePolygon(center, radius, steps = 48) {
  const ring = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(center, (i / steps) * 360, radius));
  return { type: 'Polygon', coordinates: [ring] };
}

const nf1 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

/** "350 m", "1,2 km", "25 km" — hiển thị trên màn hình. */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  if (m < 10000) return `${nf1.format(m / 1000)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "12 phút", "1 giờ 5 phút". */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} phút`;
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return mm ? `${h} giờ ${mm} phút` : `${h} giờ`;
}

/** Giờ đến dự kiến dạng "14:35". */
export function formatClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const COMPASS = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];

/** Tên hướng la bàn tiếng Việt của một góc phương vị. */
export function compassName(brg) {
  return COMPASS[Math.round((((brg % 360) + 360) % 360) / 45) % 8];
}
