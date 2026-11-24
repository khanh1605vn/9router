// Script chèn vào trang ứng dụng trước mọi script khác (page.addInitScript) cho bộ chạy thử lái xe
// tests/browser/run.mjs. Chạy sau scene.js và oracle.js, đọc cấu hình globalThis.__BDH_CFG do run.mjs đặt.
//
// Nó thay các thứ của trình duyệt mà một lần lái thật cần, tất cả theo CÙNG một hàm tư thế xe pose(t):
// - navigator.geolocation.watchPosition: quỹ đạo 1 Hz, lần định vị thật (không có cờ simulated), sai số 5 m;
// - getUserMedia: luồng của một canvas 1920×1080 vẽ cảnh camera (scene.js) theo tư thế xe; enumerateDevices;
// - permissions.query({ name: 'camera' }): trạng thái quyền do kịch bản đặt (mặc định 'granted');
// - Date: dời thêm N ngày (và chọn giờ trong ngày) cho các lần đi sau; performance.now() giữ nguyên;
// - document.visibilityState: ẩn/hiện trang theo lệnh (Playwright luôn giữ trang ở 'visible');
// - speechSynthesis: ghi lại mọi câu đọc thay vì phát ra loa; getBattery: pin đầy, đang sạc;
// - globalThis.__BD_TEST__.visionFactory: bộ nhận diện oracle.js khi chưa có mô hình thật (cfg.oracle).
// Mọi số liệu ghi vào globalThis.__BDH.log để run.mjs đọc. Không gửi gì ra ngoài trang.

(function () {
  'use strict';

  const SAMPLE_MS = 500; // đọc trạng thái giao diện mỗi chừng này (ms)
  const HOOK_MS = 300; // dò bộ học mới của ứng dụng mỗi chừng này (ms)
  const SPEAK_MS_PER_CHAR = 55; // thời gian "đọc" giả của một câu, theo số ký tự (ms)
  const FIRST_FIX_MS = 300; // lần định vị đầu tiên sau watchPosition (ms)
  const HEADING_NOISE_DEG = 1; // nhiễu hướng đi của GPS (độ)
  const SPEED_NOISE = 0.1; // nhiễu tốc độ của GPS (m/s)
  const MOVING = 0.5; // dưới tốc độ này (m/s) GPS không báo hướng đi
  const SPEAK_MS_MIN = 200; // … nhưng không ngắn hơn chừng này (ms)
  // Đối chiếu từng khung với cảnh (để báo tỉ lệ thấy và đọc đúng của bộ nhận diện thật): chỉ xét biển cách máy ảnh tới
  // chừng này, khớp khi IoU với hộp của cảnh từ chừng này; ghi tối đa chừng này mục.
  const GT_FAR = 120; // m
  const GT_IOU = 0.3;
  const GT_MAX_ROWS = 20000;
  globalThis.BDInitLimits = Object.freeze({ SAMPLE_MS, HOOK_MS, SPEAK_MS_PER_CHAR, SPEAK_MS_MIN, FIRST_FIX_MS, HEADING_NOISE_DEG, SPEED_NOISE, MOVING, GT_FAR, GT_IOU, GT_MAX_ROWS });
  if (typeof window === 'undefined' || window.top !== window) return; // Node (tự kiểm) hay khung con: chỉ hằng số

  const cfg = globalThis.__BDH_CFG;
  const S = globalThis.BDScene;
  if (!cfg || !S) return;

  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const perfNow = performance.now.bind(performance);
  const rnd = S.rng(cfg.seed >>> 0 || 1);
  const world = S.makeWorld(cfg.world);

  const log = {
    gum: 0,
    gumAt: [],
    tracksMade: 0,
    trackStops: 0,
    grabs: 0,
    grabsHidden: 0,
    fixes: 0,
    speech: [],
    passed: [],
    results: [],
    samples: [],
    visibility: [],
    marks: [],
    oracle: {},
    // Mỗi biển của cảnh thấy được trong một khung đã xử lý: [nhãn, Z (m), bề rộng hộp (px), thấy (0/1), nhãn top-1 hay
    // null, p top-1 hay null], và số hộp không khớp biển nào của cảnh (hộp lạ, kèm nhãn top-1 nếu đã phân loại).
    gt: [],
    stray: { boxes: 0, classified: 0, learnable: 0, labels: {} },
    framesSeen: 0,
  };
  const tracks = [];
  const tracksLive = () => tracks.filter((t) => t.readyState === 'live').length;

  // Cài đặt của kịch bản (camEnabled…) ghép vào cài đặt đã lưu, trước khi ứng dụng đọc localStorage.
  if (cfg.settings) {
    try {
      const key = 'banduong:settings';
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...saved, ...cfg.settings }));
    } catch {
      // localStorage bị chặn: ứng dụng dùng mặc định
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Đồng hồ: Date dời cfg.dateOffsetMs (ngày và giờ của lần đi), performance.now() không đổi
  // ---------------------------------------------------------------------------------------------
  const off = Number(cfg.dateOffsetMs) || 0;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(realNow() + off).toString();
    return args.length ? new RealDate(...args) : new RealDate(realNow() + off);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => realNow() + off;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(FakeDate, 'name', { value: 'Date' });
  globalThis.Date = FakeDate;

  // ---------------------------------------------------------------------------------------------
  // Tư thế xe: đứng yên ở s0 cho tới go(), tăng tốc đều trong rampS giây, chạy đều v, dừng ở s1
  // ---------------------------------------------------------------------------------------------
  const drive = { ...cfg.drive, tGo: null };
  const dir = drive.dir >= 0 ? 1 : -1;
  function pose(t = perfNow()) {
    const out = { s: drive.s0, lat: drive.lat, dir, v: 0, moving: false };
    if (drive.tGo == null || t < drive.tGo) return out;
    const tau = (t - drive.tGo) / 1000;
    const ramp = Math.max(0.1, drive.rampS);
    const a = drive.v / ramp;
    let d = tau < ramp ? 0.5 * a * tau * tau : 0.5 * a * ramp * ramp + drive.v * (tau - ramp);
    let v = tau < ramp ? a * tau : drive.v;
    const total = Math.abs(drive.s1 - drive.s0);
    if (d >= total) {
      d = total;
      v = 0;
    }
    return { s: drive.s0 + dir * d, lat: drive.lat, dir, v, moving: v > 0 };
  }

  // ---------------------------------------------------------------------------------------------
  // GPS
  // ---------------------------------------------------------------------------------------------
  const gps = { accuracy: 5, sigma: 1, ...(cfg.gps || {}) };
  const watches = new Map();
  let watchSeq = 0;
  function position() {
    const p = pose();
    const along = gps.sigma * rnd.gauss();
    const cross = gps.sigma * rnd.gauss();
    const [lon, lat] = world.toCoord(p.s + along, p.lat + cross);
    const moving = p.v > MOVING;
    return {
      coords: {
        latitude: lat,
        longitude: lon,
        accuracy: gps.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        speed: moving ? Math.max(0, p.v + SPEED_NOISE * rnd.gauss()) : 0,
        heading: moving ? (dir > 0 ? 90 : 270) + HEADING_NOISE_DEG * rnd.gauss() : NaN,
      },
      timestamp: FakeDate.now(),
    };
  }
  function deliver(ok) {
    log.fixes++;
    try {
      ok(position());
    } catch (err) {
      log.marks.push({ kind: 'fix-error', message: String(err) });
    }
  }
  const geo = {
    watchPosition(ok) {
      const id = ++watchSeq;
      const first = setTimeout(() => deliver(ok), FIRST_FIX_MS);
      const timer = setInterval(() => deliver(ok), 1000 / (gps.hz || 1));
      watches.set(id, { first, timer });
      return id;
    },
    clearWatch(id) {
      const w = watches.get(id);
      if (!w) return;
      clearTimeout(w.first);
      clearInterval(w.timer);
      watches.delete(id);
    },
    getCurrentPosition(ok) {
      setTimeout(() => ok(position()), FIRST_FIX_MS);
    },
  };
  for (const k of Object.keys(geo)) Object.defineProperty(Geolocation.prototype, k, { value: geo[k], configurable: true, writable: true });

  // ---------------------------------------------------------------------------------------------
  // Trang ẩn/hiện
  // ---------------------------------------------------------------------------------------------
  let visible = true;
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => !visible });
  function setVisible(v) {
    visible = Boolean(v);
    log.visibility.push({ visible, mono: perfNow(), s: pose().s });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  // ---------------------------------------------------------------------------------------------
  // Quyền camera, danh sách camera, getUserMedia → luồng canvas của cảnh
  // ---------------------------------------------------------------------------------------------
  let camPermission = cfg.camPermission || 'granted';
  const permQuery = Permissions.prototype.query;
  Object.defineProperty(Permissions.prototype, 'query', {
    configurable: true,
    writable: true,
    value(desc) {
      if (desc && desc.name === 'camera') {
        const st = new EventTarget();
        st.state = camPermission;
        st.name = 'camera';
        st.onchange = null;
        return Promise.resolve(st);
      }
      return permQuery.call(this, desc);
    },
  });

  const canvas = document.createElement('canvas');
  canvas.width = S.W;
  canvas.height = S.H;
  const scene = { signs: cfg.scene.signs.slice(), junction: cfg.scene.junction || null, seed: cfg.scene.seed || 1, flags: { ...(cfg.scene.flags || {}) } };
  const faces = new Map();
  let renderer = null;

  const md = MediaDevices.prototype;
  Object.defineProperty(md, 'enumerateDevices', {
    configurable: true,
    writable: true,
    value: async () => [{ kind: 'videoinput', deviceId: 'bd-harness-cam', groupId: 'bd', label: camPermission === 'granted' ? 'Camera sau (cảnh mô phỏng)' : '', toJSON() { return this; } }],
  });
  Object.defineProperty(md, 'getUserMedia', {
    configurable: true,
    writable: true,
    async value(constraints) {
      log.gum++;
      log.gumAt.push({ mono: perfNow(), s: pose().s, visible, permission: camPermission });
      if (camPermission === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      const video = constraints && constraints.video;
      if (!video) throw new DOMException('no video', 'NotSupportedError');
      const stream = canvas.captureStream(cfg.captureFps || 15);
      for (const t of stream.getVideoTracks()) {
        log.tracksMade++;
        tracks.push(t);
        const stop = t.stop.bind(t);
        t.stop = () => {
          if (t.readyState === 'live') log.trackStops++;
          stop();
        };
      }
      return stream;
    },
  });
  if (typeof ImageCapture === 'function') {
    const grab = ImageCapture.prototype.grabFrame;
    ImageCapture.prototype.grabFrame = function (...a) {
      log.grabs++;
      if (!visible) log.grabsHidden++;
      return grab.apply(this, a);
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Giọng đọc: ghi lại câu, giả vờ đọc một lúc
  // ---------------------------------------------------------------------------------------------
  class FakeUtterance extends EventTarget {
    constructor(text = '') {
      super();
      this.text = String(text);
      this.lang = '';
      this.voice = null;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onend = null;
      this.onerror = null;
      this.onstart = null;
    }
  }
  const viVoice = Object.freeze({ lang: 'vi-VN', name: 'Giọng giả lập', localService: true, voiceURI: 'bd-harness-vi', default: true });
  const synth = new (class extends EventTarget {
    constructor() {
      super();
      this.queue = [];
      this.current = null;
    }
    get speaking() {
      return this.current != null;
    }
    get pending() {
      return this.queue.length > 0;
    }
    get paused() {
      return false;
    }
    getVoices() {
      return [viVoice];
    }
    speak(u) {
      const p = pose();
      if (String(u.text).trim()) log.speech.push({ text: String(u.text), mono: perfNow(), wall: FakeDate.now(), s: p.s, v: p.v });
      this.queue.push(u);
      if (!this.current) this.#next();
    }
    #next() {
      const u = this.queue.shift();
      this.current = u || null;
      if (!u) return;
      const ms = Math.max(SPEAK_MS_MIN, String(u.text).length * SPEAK_MS_PER_CHAR);
      u._timer = setTimeout(() => {
        this.current = null;
        try {
          u.onend?.({ type: 'end' });
        } catch {
          // lỗi trong trình nghe của ứng dụng
        }
        this.#next();
      }, ms);
    }
    cancel() {
      const all = [this.current, ...this.queue].filter(Boolean);
      this.queue = [];
      this.current = null;
      for (const u of all) {
        clearTimeout(u._timer);
        try {
          u.onerror?.({ type: 'error', error: 'canceled' });
        } catch {
          // bỏ qua
        }
      }
    }
    pause() {}
    resume() {}
  })();
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: FakeUtterance });

  // Pin đầy, đang sạc: kịch bản không xét điều kiện pin.
  Object.defineProperty(Navigator.prototype, 'getBattery', {
    configurable: true,
    writable: true,
    value: async () => Object.assign(new EventTarget(), { level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity }),
  });

  // ---------------------------------------------------------------------------------------------
  // Bộ nhận diện oracle (khi chưa có mô hình thật)
  // ---------------------------------------------------------------------------------------------
  globalThis.__BD_TEST__ = {};
  if (cfg.oracle) {
    globalThis.__BD_TEST__.visionFactory = globalThis.BDOracle.createFactory({
      getScene: () => scene,
      getPose: (t) => pose(t),
      families: cfg.families || {},
      seed: (cfg.seed >>> 0) ^ 0x0dac1e,
      stats: log.oracle,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Vẽ cảnh camera: ảnh mặt biển từ signSvg() của chính ứng dụng
  // ---------------------------------------------------------------------------------------------
  async function loadFaces() {
    const base = new URL('./', location.href);
    const { signSvg } = await import(new URL('js/signart.js', base).href);
    const { lookupSign } = await import(new URL('js/signs.js', base).href);
    const size = cfg.faceSize || 256;
    for (const sg of scene.signs) {
      if (faces.has(sg.label)) continue;
      const entry = lookupSign(sg.code);
      const svg = signSvg(entry?.art, { size, value: sg.value });
      const img = new Image(size, size);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const c = new OffscreenCanvas(size, size); // vẽ sẵn một lần: vẽ lại SVG mỗi khung thì chậm
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      faces.set(sg.label, c);
    }
  }

  function drawFrame() {
    if (!renderer) return;
    try {
      renderer.draw(pose(), scene.flags);
    } catch (err) {
      log.marks.push({ kind: 'draw-error', message: String(err) });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Đọc trạng thái ứng dụng: bộ học (onPassed, kết quả xét lượt bám) và giao diện
  // ---------------------------------------------------------------------------------------------
  let hooked = null;
  function hookLearner() {
    const c = globalThis.__BD_TEST__?.controller;
    const L = c && c.learner;
    if (!L || L === hooked) return;
    hooked = L;
    L.onPassed((e) => {
      const r = e.record || {};
      const p = pose();
      log.passed.push({ outcome: e.outcome, reason: e.reason ?? null, id: r.id, code: r.code, value: r.value ?? null, status: r.status, L: r.L, misses: r.misses, hitDays: r.hitDays, s: p.s, mono: perfNow() });
    });
    const onVision = L.onVision.bind(L);
    const learnable = (label) => L.labels?.get?.(label)?.learn === true;
    const pause = L.pause.bind(L);
    const note = (out) => {
      for (const x of out?.results || []) {
        log.results.push({ ok: x.ok, reason: x.reason ?? null, event: x.event ?? null, id: x.record?.id ?? null, label: x.obs?.label ?? null, Z: x.obs?.Z ?? null, frames: x.obs?.frames ?? null, s: pose().s });
      }
      return out;
    };
    L.onVision = (...a) => {
      try {
        matchFrame(a[0], a[1], learnable);
      } catch (err) {
        log.marks.push({ kind: 'gt-error', message: String(err) });
      }
      return note(onVision(...a));
    };
    L.pause = (...a) => note(pause(...a));
  }

  /** Đối chiếu kết quả một khung (hợp đồng 5) với các biển của cảnh ở tư thế xe lúc chụp khung. */
  function matchFrame(r, size, learnable) {
    if (!r || !Array.isArray(r.boxes)) return;
    log.framesSeen++;
    const W = size?.width || S.W;
    const H = size?.height || S.H;
    const ps = pose(r.t);
    const cam = S.camera(ps, { width: W, height: H });
    const SH = globalThis.BDOracle?.SHAPE || {};
    const used = new Set();
    for (const sg of scene.signs) {
      if ((sg.dir >= 0 ? 1 : -1) !== cam.dir) continue;
      const fam = cfg.families?.[sg.label];
      const b = S.signBox(cam, sg, SH[fam] || SH.default || { bw: 1, bh: 1 });
      if (!b || b.Z > GT_FAR || b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) continue;
      let best = -1;
      let bi = 0;
      r.boxes.forEach((x, i) => {
        const v = globalThis.VisionProto ? globalThis.VisionProto.iou(x, b) : 0;
        if (v >= GT_IOU && v > bi) {
          bi = v;
          best = i;
        }
      });
      if (best >= 0) used.add(best);
      const c = best >= 0 ? r.boxes[best].cls : null;
      if (log.gt.length < GT_MAX_ROWS) {
        log.gt.push([sg.label, Math.round(b.Z * 10) / 10, Math.round(b.w * 10) / 10, best >= 0 ? 1 : 0, c ? c[0][0] : null, c ? Math.round(c[0][1] * 1000) / 1000 : null]);
      }
    }
    r.boxes.forEach((x, i) => {
      if (used.has(i)) return;
      log.stray.boxes++;
      if (!x.cls) return;
      log.stray.classified++;
      const top = x.cls[0][0];
      if (learnable(top)) log.stray.learnable++;
      log.stray.labels[top] = (log.stray.labels[top] || 0) + 1;
    });
  }

  function sample() {
    const $ = (id) => document.getElementById(id);
    const bar = $('alertBar');
    if (!bar) return;
    const c = globalThis.__BD_TEST__?.controller;
    const st = c ? c.state : null;
    const lim = $('limitSign');
    const src = $('limitSrc');
    const chip = $('btnCamChip');
    const strip = $('signStrip');
    const p = pose();
    log.samples.push({
      mono: perfNow(),
      s: Math.round(p.s * 10) / 10,
      v: p.v,
      visible,
      bar: bar.hidden ? null : { cls: bar.className, title: $('alertTitle')?.textContent || '', dist: $('alertDist')?.textContent || '', cap: bar.querySelector('.alert-cap')?.textContent || null, badge: Boolean(bar.querySelector('.cam-badge')) },
      strip: strip && !strip.hidden ? [...strip.children].map((n) => n.className) : [],
      limit: lim && !lim.hidden ? { value: $('limitValue')?.textContent || '', camera: lim.classList.contains('camera'), src: src && !src.hidden ? src.textContent : null } : null,
      chip: chip ? { hidden: chip.hidden, cls: chip.className, title: chip.title, label: chip.getAttribute('aria-label') } : null,
      cam: st ? { camera: st.camera, capturing: st.capturing, vision: st.vision, level: st.level, block: st.block, health: st.health ?? null, text: st.text, speedLimit: st.speedLimit ?? null } : null,
      tracksLive: tracksLive(),
    });
  }

  async function start() {
    try {
      await loadFaces();
    } catch (err) {
      log.marks.push({ kind: 'faces-error', message: String(err) });
    }
    renderer = S.createRenderer(canvas, scene, { faces });
    drawFrame();
    setInterval(drawFrame, 1000 / (cfg.drawFps || 10));
    setInterval(sample, SAMPLE_MS);
    setInterval(hookLearner, HOOK_MS);
    globalThis.__BDH.ready = true;
  }

  globalThis.__BDH = {
    cfg,
    log,
    world,
    scene,
    ready: false,
    pose,
    go() {
      if (drive.tGo == null) drive.tGo = perfNow();
      log.marks.push({ kind: 'go', mono: drive.tGo });
    },
    setVisible,
    setPermission(state) {
      camPermission = state;
      log.marks.push({ kind: 'permission', state, mono: perfNow(), s: pose().s });
    },
    setFlags(flags) {
      Object.assign(scene.flags, flags);
      log.marks.push({ kind: 'flags', flags, mono: perfNow(), s: pose().s });
    },
    mark(kind, extra = {}) {
      log.marks.push({ kind, ...extra, mono: perfNow(), s: pose().s });
    },
    tracks: () => tracks.map((t) => t.readyState),
    tracksLive,
    canvas,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
