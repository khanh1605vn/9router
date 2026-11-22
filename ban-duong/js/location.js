// Nguồn vị trí: GPS thật (Geolocation API) hoặc chạy mô phỏng dọc một tuyến đường.
// Mỗi lần định vị phát ra { coord, accuracy, speed (m/s), heading (độ | null), time (ms), simulated }.

import { bearing, distance, pointAtDistance } from './geo.js';

const GEO_ERRORS = {
  1: 'Ứng dụng chưa được cấp quyền vị trí. Hãy bật quyền vị trí cho trang này trong cài đặt trình duyệt.',
  2: 'Chưa xác định được vị trí. Hãy bật GPS và ra nơi thoáng.',
  3: 'Tín hiệu GPS yếu, đang thử lại…',
};

export class LocationService {
  constructor() {
    this.listeners = new Set();
    this.errorListeners = new Set();
    this.watchId = null;
    this.last = null;
    this.lastReal = null; // lần định vị thật gần nhất (kể cả lúc đang mô phỏng)
    this.anchor = null; // điểm mốc để suy ra hướng đi khi thiết bị không báo hướng
    this.sim = null;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onError(fn) {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  get simulating() {
    return Boolean(this.sim);
  }

  start() {
    if (!this.supported) {
      for (const fn of this.errorListeners) fn({ code: 0, message: 'Thiết bị này không hỗ trợ định vị.' });
      return;
    }
    if (this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        if (!Number.isFinite(c.latitude) || c.accuracy > 500) return;
        this.lastReal = {
          coord: [c.longitude, c.latitude],
          accuracy: c.accuracy,
          speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
          heading: Number.isFinite(c.heading) ? c.heading : null,
          time: pos.timestamp || Date.now(),
          simulated: false,
        };
        if (!this.sim) this.ingest(this.lastReal); // đang mô phỏng thì chưa dùng tới GPS thật
      },
      (err) => {
        const message = GEO_ERRORS[err.code] || 'Không lấy được vị trí.';
        for (const fn of this.errorListeners) fn({ code: err.code, message });
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Chuẩn hoá một lần định vị thô: bổ sung tốc độ và hướng đi nếu thiết bị không cung cấp. */
  ingest(raw) {
    const prev = this.last;
    let { speed, heading } = raw;

    if (speed == null) {
      speed = 0;
      if (prev) {
        const dt = (raw.time - prev.time) / 1000;
        const d = distance(prev.coord, raw.coord);
        // Dịch chuyển nhỏ hơn sai số thì coi như đang đứng yên.
        if (dt > 0.3 && d > Math.max(3, raw.accuracy * 0.5)) {
          speed = Math.min(70, d / dt) * 0.6 + (prev.speed || 0) * 0.4;
        }
      }
    }

    if (heading == null || speed < 1) {
      heading = prev ? prev.heading : null;
      if (!this.anchor) this.anchor = raw.coord;
      else if (distance(this.anchor, raw.coord) > Math.max(8, raw.accuracy * 0.6)) {
        heading = bearing(this.anchor, raw.coord);
        this.anchor = raw.coord;
      }
    } else {
      this.anchor = raw.coord;
    }

    const fix = { ...raw, speed, heading };
    this.last = fix;
    for (const fn of this.listeners) fn(fix);
    return fix;
  }

  /**
   * Chạy thử dọc theo tuyến. `factor` là hệ số tua nhanh; thời gian trong mỗi lần định vị là
   * thời gian ảo nên các phép tính theo thời gian (cảnh báo, thống kê) vẫn đúng.
   */
  startSimulation(route, factor = 1) {
    this.stopSimulation();
    const stepS = route.steps.map((st) => route.cum[st.index] || 0);
    const total = route.cum[route.cum.length - 1];
    const sim = { route, factor, s: 0, time: Date.now(), timer: null, speed: 0 };
    const speedAt = (s) => {
      let k = 0;
      while (k + 1 < stepS.length && stepS[k + 1] <= s) k++;
      const st = route.steps[k];
      let v = st.duration > 0 ? st.distance / st.duration : 10;
      v = Math.max(4, Math.min(33, v));
      // Giảm tốc khi sắp tới chỗ rẽ cho giống thực tế.
      const toTurn = k + 1 < stepS.length ? stepS[k + 1] - s : Infinity;
      if (toTurn < 45 && k + 1 < stepS.length - 1) v = Math.min(v, 5.5);
      return v;
    };
    const tick = () => {
      const dt = 0.5 * sim.factor;
      const target = speedAt(sim.s);
      sim.speed += Math.max(-3 * dt, Math.min(2 * dt, target - sim.speed));
      sim.s = Math.min(total, sim.s + sim.speed * dt);
      sim.time += dt * 1000;
      const at = pointAtDistance(route.coords, route.cum, sim.s);
      this.ingest({
        coord: at.point,
        accuracy: 5,
        speed: sim.s >= total ? 0 : sim.speed,
        heading: at.bearing,
        time: sim.time,
        simulated: true,
      });
      if (sim.s >= total) this.stopSimulation();
    };
    sim.timer = setInterval(tick, 500);
    this.sim = sim;
    this.anchor = null;
    tick();
  }

  /** Sau khi mô phỏng xong: phát lại vị trí thật gần nhất để mũi tên trở về đúng chỗ. */
  resumeReal() {
    if (this.sim || !this.lastReal) return false;
    this.ingest({ ...this.lastReal, speed: 0, time: Date.now() });
    return true;
  }

  setSimulationFactor(factor) {
    if (this.sim) this.sim.factor = factor;
  }

  stopSimulation() {
    if (!this.sim) return;
    clearInterval(this.sim.timer);
    this.sim = null;
    this.last = null;
    this.anchor = null;
  }
}
