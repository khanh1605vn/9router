// Theo dõi vị trí trên tuyến: bám tuyến, xác định bước rẽ kế tiếp, thời điểm đọc chỉ dẫn,
// phát hiện đi lệch tuyến và đến nơi. Không phụ thuộc DOM nên kiểm thử được bằng Node.

import { angleDiff, bearing, nearestOnLine } from './geo.js';

const nf1 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

/** Khoảng cách dạng đọc thành tiếng: "350 mét", "1,5 ki lô mét". */
export function spokenDistance(m) {
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} mét`;
  if (m < 975) return `${Math.round(m / 50) * 50} mét`; // từ 975 m trở lên làm tròn thành 1 ki lô mét
  if (m < 10000) return `${nf1.format(Math.round(m / 100) / 10)} ki lô mét`;
  return `${Math.round(m / 1000)} ki lô mét`;
}

const lowerFirst = (s) => (s ? s[0].toLocaleLowerCase('vi') + s.slice(1) : s);

const LEVELS = ['far', 'mid', 'near'];

export class RouteTracker {
  constructor(route) {
    this.route = route;
    this.total = route.cum[route.cum.length - 1] || 0;
    this.stepS = route.steps.map((st) => route.cum[st.index] || 0);
    // Thời gian còn lại tính từ đầu mỗi bước.
    this.suffix = new Array(route.steps.length + 1).fill(0);
    for (let i = route.steps.length - 1; i >= 0; i--) {
      this.suffix[i] = this.suffix[i + 1] + (route.steps[i].duration || 0);
    }
    this.seg = 0;
    this.s = 0;
    this.stepIndex = -1;
    this.offCount = 0;
    this.offSince = 0;
    this.wrongWay = 0;
    this.spoken = new Map(); // chỉ số bước → Set các mức đã đọc
    this.arrived = false;
  }

  #snap(coord) {
    const { coords, cum } = this.route;
    // Chỉ tìm quanh vị trí cũ để không nhảy sang đoạn tuyến khác chạy sát bên.
    const from = Math.max(0, this.seg - 4);
    let to = this.seg + 1;
    while (to < coords.length - 1 && cum[to] - cum[this.seg] < 600) to++;
    let best = nearestOnLine(coord, coords, from, to);
    if (!best || best.dist > 50) {
      const all = nearestOnLine(coord, coords);
      if (all && (!best || all.dist < Math.min(30, best.dist * 0.5))) best = all;
    }
    return best;
  }

  /**
   * Cập nhật theo một lần định vị { coord, speed (m/s), heading (độ|null), accuracy (m), time (ms) }.
   */
  update(fix) {
    const { coords, cum, steps } = this.route;
    const snap = this.#snap(fix.coord);
    const speed = fix.speed || 0;
    const tolerance = Math.max(45, Math.min(100, fix.accuracy || 0));

    let offRoute = false;
    if (!snap || snap.dist > tolerance) {
      if (this.offCount === 0) this.offSince = fix.time;
      this.offCount++;
      offRoute = this.offCount >= 3 && fix.time - this.offSince >= 4000 && speed > 1;
    } else {
      this.offCount = 0;
      this.seg = snap.index;
      this.s = cum[snap.index] + snap.t * (cum[snap.index + 1] - cum[snap.index]);
    }

    const routeBearing = bearing(coords[this.seg], coords[Math.min(this.seg + 1, coords.length - 1)]);
    if (fix.heading != null && speed > 3 && Math.abs(angleDiff(routeBearing, fix.heading)) > 130) {
      this.wrongWay++;
      if (this.wrongWay >= 6) offRoute = true;
    } else {
      this.wrongWay = 0;
    }

    // Bước đang đi = bước cuối cùng có điểm rẽ nằm sau lưng.
    let k = 0;
    while (k + 1 < steps.length - 1 && this.stepS[k + 1] <= this.s + 5) k++;
    const changed = k !== this.stepIndex;
    this.stepIndex = k;

    const next = steps[k + 1] || null;
    const distToNext = next ? Math.max(0, this.stepS[k + 1] - this.s) : 0;
    const stepLen = next ? this.stepS[k + 1] - this.stepS[k] : 0;
    const remainingDistance = Math.max(0, this.total - this.s);
    const remainingDuration =
      this.suffix[k + 1] + (stepLen > 0 ? (steps[k].duration || 0) * Math.min(1, distToNext / stepLen) : 0);

    let cue = null;
    const snappedOk = this.offCount === 0;

    if (!this.arrived && snappedOk && remainingDistance < 25) {
      this.arrived = true;
      const dest = steps[steps.length - 1];
      const side = dest.modifier.includes('left') ? 'trái' : dest.modifier.includes('right') ? 'phải' : '';
      cue = { level: 'arrive', text: side ? `Bạn đã đến nơi. Điểm đến ở bên ${side}.` : 'Bạn đã đến nơi.' };
    } else if (!this.arrived && snappedOk && next) {
      cue = this.#cueFor(k, next, distToNext, speed, changed);
    }

    return {
      snapped: snap && snappedOk ? snap.point : fix.coord,
      onRoute: snappedOk,
      lateral: snap ? snap.dist : Infinity,
      routeBearing,
      s: this.s,
      stepIndex: k,
      step: steps[k],
      next,
      distToNext,
      remainingDistance,
      remainingDuration,
      offRoute,
      arrived: this.arrived,
      cue,
    };
  }

  #cueFor(k, next, dist, speed, changed) {
    const fast = speed > 16.7; // trên 60 km/h
    const farD = fast ? 1000 : 500;
    const midD = fast ? 400 : 200;
    const nearD = Math.max(35, Math.min(150, speed * 3.5));
    const done = this.spoken.get(k) || new Set();
    this.spoken.set(k, done);

    let level = null;
    if (dist <= nearD) level = 'near';
    else if (dist <= midD) level = 'mid';
    else if (dist <= farD) level = 'far';

    const isArrive = next.type === 'arrive';
    const after = this.route.steps[k + 2];
    const chain =
      after && after.type !== 'arrive' && this.stepS[k + 2] - this.stepS[k + 1] < 120
        ? `, sau đó ${lowerFirst(after.short)}`
        : '';

    if (level && !done.has(level)) {
      // Đã đọc mức gần thì không quay lại đọc mức xa hơn.
      for (const l of LEVELS.slice(0, LEVELS.indexOf(level) + 1)) done.add(l);
      if (level === 'near') {
        if (isArrive) return null; // câu "đã đến nơi" sẽ được đọc khi tới đích
        const text = next.type === 'roundabout' || next.type === 'rotary' ? next.text : next.short;
        return { level, text: `${text}${chain}` };
      }
      if (isArrive) return { level, text: `Còn ${spokenDistance(dist)} nữa là đến nơi` };
      return { level, text: `Còn ${spokenDistance(dist)}, ${lowerFirst(next.text)}${chain}` };
    }

    if (changed && !level && !done.has('start')) {
      done.add('start');
      // Chỉ nhắc "đi tiếp" khi chỗ rẽ kế còn xa; gần thì câu "Còn … mét" sẽ tới ngay sau đó.
      const long = dist > farD * 1.5;
      if (k === 0) {
        const depart = this.route.steps[0].text;
        return { level: 'start', text: long ? `${depart}, rồi đi tiếp ${spokenDistance(dist)}` : depart };
      }
      if (long) return { level: 'start', text: `Đi tiếp ${spokenDistance(dist)}` };
    }
    return null;
  }
}
