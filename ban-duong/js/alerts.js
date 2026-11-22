// Bộ máy cảnh báo: điểm cần chú ý phía trước (camera, trạm thu phí, đường sắt, điểm tự đánh dấu)
// và cảnh báo vượt tốc độ. Thuần logic, không đụng tới DOM.

import { angleDiff, bearing, distance, nearestOnLine } from './geo.js';
import { REPORT_TYPES } from './store.js';
import { spokenDistance } from './tracker.js';

const RAD = Math.PI / 180;

/** Tên hiển thị, câu đọc và biểu tượng của một điểm cảnh báo. */
export function describePoint(p) {
  if (p.kind === 'camera') {
    const limit = p.limit ? ` · giới hạn ${p.limit} km/h` : '';
    const say = p.limit ? `, giới hạn ${p.limit} ki lô mét trên giờ` : '';
    if (p.sub === 'speed') return { title: `Camera bắn tốc độ${limit}`, say: `có camera bắn tốc độ${say}`, icon: 'camera' };
    if (p.sub === 'redlight') return { title: 'Camera phạt vượt đèn đỏ', say: 'có camera phạt vượt đèn đỏ', icon: 'camera' };
    return { title: 'Camera giám sát giao thông', say: 'có camera giám sát giao thông', icon: 'camera' };
  }
  if (p.kind === 'toll') return { title: p.name || 'Trạm thu phí', say: 'có trạm thu phí', icon: 'toll' };
  if (p.kind === 'rail') {
    return { title: 'Đường ngang đường sắt', say: 'có đường sắt cắt ngang, hãy chú ý quan sát', icon: 'rail' };
  }
  const def = REPORT_TYPES[p.type];
  if (!def) return { title: 'Điểm cần chú ý', say: 'có điểm cần chú ý', icon: 'hazard' };
  const extra = p.type === 'school' ? ', hãy giảm tốc độ' : '';
  return {
    title: `${def.label} (bạn đánh dấu)`,
    say: `có ${def.label[0].toLocaleLowerCase('vi')}${def.label.slice(1)}${extra}`,
    icon: def.icon,
  };
}

const SETTING_OF = { camera: 'alertCamera', toll: 'alertToll', rail: 'alertRail', report: 'alertReport' };

export class AlertEngine {
  constructor() {
    this.seen = new Map(); // id → thời điểm đã báo
    this.activeId = null;
  }

  /**
   * @param fix      { coord, speed (m/s), heading, time }
   * @param points   danh sách điểm { id, kind, coord, … }
   * @param settings cài đặt bật/tắt từng loại
   * @param nav      khi đang dẫn đường: { route, seg, s } để chỉ báo điểm nằm trên tuyến phía trước
   * @returns { active: { point, distance, info } | null, fired: boolean, say: string | null }
   */
  update(fix, points, settings, nav = null) {
    const speed = fix.speed || 0;
    const reach = Math.max(300, Math.min(1200, speed * 22));
    const candidates = [];

    for (const p of points) {
      if (settings && settings[SETTING_OF[p.kind]] === false) continue;
      const d = distance(fix.coord, p.coord);
      if (d > reach) {
        // Đi xa hẳn rồi thì lần sau quay lại vẫn được báo.
        if (d > 1500) this.seen.delete(p.id);
        continue;
      }
      let ahead = null;
      if (nav) {
        const { route, seg, s } = nav;
        let to = seg + 1;
        while (to < route.coords.length - 1 && route.cum[to] - s < reach + 50) to++;
        const hit = nearestOnLine(p.coord, route.coords, seg, to);
        if (hit && hit.dist <= 40) {
          const along = route.cum[hit.index] + hit.t * (route.cum[hit.index + 1] - route.cum[hit.index]) - s;
          if (along >= -10 && along <= reach) ahead = Math.max(0, along);
        }
      } else if (d < 40) {
        ahead = d;
      } else if (fix.heading != null) {
        const diff = Math.abs(angleDiff(fix.heading, bearing(fix.coord, p.coord)));
        if (diff < 75 && d * Math.sin(diff * RAD) <= 45) ahead = d;
      }
      if (ahead != null) candidates.push({ point: p, distance: ahead });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    const current = candidates.find((c) => c.point.id === this.activeId);
    const fresh = speed >= 2 ? candidates.find((c) => !this.seen.has(c.point.id)) : null;

    let fired = false;
    let chosen = current || null;
    if (fresh && (!current || fresh.distance < current.distance)) {
      chosen = fresh;
      fired = true;
      this.seen.set(fresh.point.id, fix.time);
    }
    this.activeId = chosen ? chosen.point.id : null;
    if (!chosen) return { active: null, fired: false, say: null };

    const info = describePoint(chosen.point);
    return {
      active: { ...chosen, info, reach },
      fired,
      say: fired ? `Còn ${spokenDistance(chosen.distance)}, ${info.say}` : null,
    };
  }
}

/** Giữ giới hạn tốc độ ổn định giữa các lần định vị và phát cảnh báo khi chạy quá. */
export class SpeedMonitor {
  constructor() {
    this.limit = null; // giới hạn của đoạn đường hiện tại (km/h)
    this.wayId = null;
    this.candidate = null;
    this.candidateCount = 0;
    this.missCount = 0;
    this.overSince = 0;
    this.lastVoice = 0;
    this.lastBeep = 0;
    this.cleared = false;
    this.announced = null;
  }

  /**
   * @param match  kết quả RoadData.matchWay (hoặc null)
   * @returns { limit, source, level: 'ok'|'near'|'over', sound: null|'voice'|'beep', announce: number|null }
   */
  update(fix, match, { vehicle = 'car', tolerance = 3, customMax = 0, hasData = true } = {}) {
    if (match) {
      this.missCount = 0;
      if (match.way.id === this.wayId) {
        this.candidate = null;
      } else {
        // Phải khớp hai lần liên tiếp mới đổi đường, tránh nhảy số khi qua giao lộ.
        if (this.candidate === match.way.id) this.candidateCount++;
        else {
          this.candidate = match.way.id;
          this.candidateCount = 1;
        }
        if (this.candidateCount >= 2 || this.wayId == null) {
          this.wayId = match.way.id;
          this.limit = vehicle === 'moto' ? match.way.m : match.way.c;
          this.candidate = null;
        }
      }
    } else if (++this.missCount >= 4 || !hasData) {
      this.wayId = null;
      this.limit = null;
    }

    const kmh = (fix.speed || 0) * 3.6;
    const limit = this.limit ?? (customMax > 0 ? customMax : null);
    const source = this.limit != null ? 'road' : limit != null ? 'custom' : null;

    let announce = null;
    if (this.limit != null && this.limit !== this.announced && kmh > 15) {
      announce = this.limit;
      this.announced = this.limit;
    } else if (this.limit == null) {
      this.announced = null;
    }

    let level = 'ok';
    let sound = null;
    if (limit != null && kmh > limit + 0.5) {
      level = kmh > limit + tolerance ? 'over' : 'near';
    }
    if (level === 'over') {
      if (!this.overSince) this.overSince = fix.time;
      if (fix.time - this.overSince >= 1500) {
        // Nhắc bằng lời lần đầu, sau đó chỉ kêu bíp; nhắc lời lại nếu vẫn chạy quá sau 45 giây
        // hoặc vừa giảm xuống rồi lại vượt (cách lần nhắc trước ít nhất 15 giây).
        const since = fix.time - this.lastVoice;
        if (!this.lastVoice || since > 45000 || (this.cleared && since > 15000)) {
          sound = 'voice';
          this.lastVoice = fix.time;
          this.lastBeep = fix.time;
        } else if (fix.time - this.lastBeep > 6000) {
          sound = 'beep';
          this.lastBeep = fix.time;
        }
        this.cleared = false;
      }
    } else {
      this.overSince = 0;
      if (level === 'ok') this.cleared = true;
    }

    return { limit, source, level, sound, announce };
  }
}
