// Cảnh camera tổng hợp cho bộ chạy thử lái xe (tests/browser/run.mjs) và trang đo trên máy (device-bench.html).
// Tệp script thường (không phải mô-đun): trong trang nó được chèn trước mọi script của ứng dụng (addInitScript) hoặc
// nạp bằng <script src>, trong Node thì chạy bằng vm. Nó chỉ đặt globalThis.BDScene.
//
// Mô hình máy ảnh: máy ảnh lỗ kim, góc nhìn ngang 70° theo cạnh dài, cao 1,3 m, trục quang song song mặt đường nên điểm
// tụ (FOE) là tâm quang học: giữa khung theo chiều ngang, 0,42 chiều cao (như js/camsched.js và js/signtrack.js).
// Toạ độ thế giới: s (m) dọc tim đường thử (hướng Đông, như đường cố định của run.mjs), lat (m) lệch ngang so với tim,
// dương về bên phải của chiều đi Đông (phía Nam). Biển cỡ 0,70 m, tâm cao 2,5 m. Nền vẽ thủ tục (trời, đồi, nhà, cây),
// không dùng ảnh chụp nào.

(function (root) {
  'use strict';

  const W = 1920; // px, khung camera
  const H = 1080;
  const HFOV = 70; // độ, góc nhìn ngang theo cạnh dài
  const CAM_HEIGHT = 1.3; // m, độ cao máy ảnh
  const FOE_Y = 0.42; // điểm tụ: 0,42 chiều cao khung
  const SIGN_SIZE = 0.7; // m, cỡ biển thường
  const SIGN_RIGHT = 5; // m, biển đứng bên phải làn xe đang đi
  const SIGN_UP = 2.5; // m, độ cao tâm biển
  const POLE_W = 0.07; // m, bề rộng cột biển
  const LANE_W = 3.5; // m, bề rộng một làn
  const LANES_EACH = 1; // số làn mỗi chiều
  const DASH = 3; // m, vạch tim đứt: dài
  const DASH_GAP = 6; // m, … khoảng trống
  const LINE_W = 0.15; // m, bề rộng vạch kẻ
  const Z_NEAR = 0.5; // m, mặt cắt gần của máy ảnh
  const Z_FAR = 900; // m, không vẽ xa hơn
  const MARK_FAR = 160; // m, vạch kẻ xa hơn chừng này không vẽ (nhỏ hơn một điểm ảnh)
  const WINDOW_FAR = 150; // m, cửa sổ nhà xa hơn chừng này không vẽ
  const THING_FAR = 450; // m, nhà và cây xa hơn chừng này không vẽ
  const EARTH = 6371008.8; // m, bán kính Trái Đất (như js/geo.js)
  const TRUCK = Object.freeze({ w: 2.5, h: 3.6, clear: 0.5 }); // m, xe tải che phía trước: rộng, cao, gầm
  const RAD = Math.PI / 180;

  /** Tiêu cự (px) theo cạnh dài, như focalPx() của js/signtrack.js: 1920 px / 70° → 1371 px. */
  const focal = (long = W, hfov = HFOV) => long / 2 / Math.tan((hfov / 2) * RAD);

  /** Số ngẫu nhiên có hạt giống (mulberry32), để cảnh và nhiễu lặp lại được. */
  function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.gauss = () => {
      const u = Math.max(1e-12, next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    };
    next.range = (lo, hi) => lo + (hi - lo) * next();
    return next;
  }

  /** Băm một chuỗi thành hạt giống 32 bit (FNV-1a). */
  function seedOf(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  /**
   * Đường thử thẳng hướng Đông qua (lon0, lat0). toCoord(s, lat) → [lon, lat]; fromCoord → { s, lat }. Phép chiếu
   * phẳng cục bộ: sai khác với công thức haversine của js/geo.js dưới 1 cm trên 2 km.
   */
  function makeWorld({ lon0, lat0 }) {
    const dLat = 180 / (Math.PI * EARTH); // độ mỗi mét theo chiều Bắc
    const dLon = dLat / Math.cos(lat0 * RAD);
    return {
      lon0,
      lat0,
      toCoord: (s, lat = 0) => [lon0 + s * dLon, lat0 - lat * dLat],
      fromCoord: (c) => ({ s: (c[0] - lon0) / dLon, lat: (lat0 - c[1]) / dLat }),
    };
  }

  /**
   * Máy ảnh theo tư thế xe: { s, lat (m), dir: +1 đi Đông, −1 đi Tây }, aim { dx, dy } (px, như camAim).
   * view(s, lat, up) → toạ độ máy ảnh { X (phải), Y (lên), Z (trước) } (m).
   */
  function camera(pose, { width = W, height = H, aim = null, hfov = HFOV } = {}) {
    const f = focal(Math.max(width, height), hfov);
    const cx = width / 2 + (aim?.dx || 0);
    const cy = FOE_Y * height + (aim?.dy || 0);
    const dir = pose.dir >= 0 ? 1 : -1;
    const view = (s, lat, up) => ({ X: dir * (lat - pose.lat), Y: up - CAM_HEIGHT, Z: dir * (s - pose.s) });
    const toPx = (p) => ({ u: cx + (f * p.X) / p.Z, v: cy - (f * p.Y) / p.Z });
    return { f, cx, cy, width, height, dir, view, toPx };
  }

  /**
   * Hộp ảnh (px, x y là góc trên bên trái) của một biển trong khung, hoặc null khi biển ở sau hay sát máy ảnh.
   * shape: tỉ lệ hộp so với cỡ biển ({ bw, bh }), mặc định hình tròn.
   */
  function signBox(cam, sign, shape = { bw: 1, bh: 1 }) {
    const p = cam.view(sign.s, sign.lat, sign.up ?? SIGN_UP);
    if (!(p.Z > Z_NEAR)) return null;
    const c = cam.toPx(p);
    const size = sign.size ?? SIGN_SIZE;
    const w = (cam.f * size * shape.bw) / p.Z;
    const h = (cam.f * size * shape.bh) / p.Z;
    return { x: c.u - w / 2, y: c.v - h / 2, w, h, Z: p.Z, X: p.X, u: c.u, v: c.v };
  }

  /** Hộp ảnh của đuôi xe tải che phía trước (px), hoặc null. */
  function truckBox(cam, pose, truck) {
    if (!truck) return null;
    const s = pose.s + cam.dir * truck.gap;
    const lat = pose.lat + (truck.lat || 0);
    const a = cam.view(s, lat - (cam.dir * TRUCK.w) / 2, TRUCK.h);
    const b = cam.view(s, lat + (cam.dir * TRUCK.w) / 2, TRUCK.clear);
    if (!(a.Z > Z_NEAR)) return null;
    const pa = cam.toPx(a);
    const pb = cam.toPx(b);
    return { x: Math.min(pa.u, pb.u), y: pa.v, w: Math.abs(pb.u - pa.u), h: pb.v - pa.v, Z: a.Z };
  }

  /** Phần diện tích của hộp a nằm trong hộp b (0…1). */
  function overlapShare(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    return ((x1 - x0) * (y1 - y0)) / (a.w * a.h);
  }

  // ---------------------------------------------------------------------------------------------
  // Vẽ
  // ---------------------------------------------------------------------------------------------

  /** Cắt đa giác (toạ độ máy ảnh) theo mặt Z = Z_NEAR (Sutherland–Hodgman). */
  function clipNear(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ina = a.Z >= Z_NEAR;
      const inb = b.Z >= Z_NEAR;
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = (Z_NEAR - a.Z) / (b.Z - a.Z);
        out.push({ X: a.X + t * (b.X - a.X), Y: a.Y + t * (b.Y - a.Y), Z: Z_NEAR });
      }
    }
    return out;
  }

  function fillPoly(ctx, cam, pts, color) {
    const c = clipNear(pts);
    if (c.length < 3) return;
    ctx.beginPath();
    c.forEach((p, i) => {
      const q = cam.toPx(p);
      if (i) ctx.lineTo(q.u, q.v);
      else ctx.moveTo(q.u, q.v);
    });
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** Mảng mặt đất từ s0 tới s1, lệch ngang lat0…lat1 (toạ độ thế giới). */
  function groundQuad(ctx, cam, s0, s1, lat0, lat1, color, up = 0) {
    fillPoly(ctx, cam, [cam.view(s0, lat0, up), cam.view(s1, lat0, up), cam.view(s1, lat1, up), cam.view(s0, lat1, up)], color);
  }

  /** Cảnh nền cố định (nhà, cây) theo hạt giống: vị trí thế giới, nên tự giãn ra quanh điểm tụ khi xe chạy. */
  function backdrop(seed, { from = -400, to = 1800 } = {}) {
    const r = rng(seed);
    const items = [];
    for (const side of [-1, 1]) {
      for (let s = from; s < to; s += r.range(12, 26)) {
        items.push({ kind: 'tree', s, lat: side * r.range(9, 14), r: r.range(1.4, 2.6), h: r.range(3, 4.5), tone: r.range(0.75, 1.1) });
      }
      for (let s = from; s < to; s += r.range(22, 46)) {
        const len = r.range(8, 20);
        const lat = side * r.range(17, 34);
        items.push({ kind: 'house', s, len, lat, deep: side * r.range(8, 14), h: r.range(6, 22), hue: Math.floor(r.range(0, 360)), light: r.range(55, 80) });
      }
    }
    return items;
  }

  /** Đồi xa ở chân trời (vô cực: không đổi khi xe chạy). */
  function hills(seed) {
    const r = rng(seed ^ 0x9e3779b9);
    const pts = [];
    for (let x = 0; x <= W; x += 60) pts.push([x, r.range(10, 70)]);
    return pts;
  }

  /**
   * Bộ vẽ cảnh lên một canvas W×H (thẻ <canvas> hay OffscreenCanvas).
   * scene = { signs: [{ s, lat, up?, size?, dir (+1 mặt biển nhìn về xe đi Đông), shape }], junction: { s } | null,
   *           seed }
   * draw(pose, flags) vẽ một khung; flags = { night, rain, blank, truck: { gap, lat? } | null }.
   * faces: Map(label → ảnh 256×256 của mặt biển) cho từng biển (sign.label).
   */
  function createRenderer(canvas, scene, { faces = new Map(), aim = null } = {}) {
    const ctx = canvas.getContext('2d');
    const items = backdrop(scene.seed ?? 1);
    const ridge = hills(scene.seed ?? 1);
    let frameNo = 0;
    const rain = rng((scene.seed ?? 1) ^ 0x51ed);

    function sky(cam) {
      const g = ctx.createLinearGradient(0, 0, 0, cam.cy);
      g.addColorStop(0, '#6f9fd8');
      g.addColorStop(1, '#d8e4ef');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cam.width, cam.cy + 1);
      ctx.fillStyle = '#8ea79a';
      ctx.beginPath();
      ctx.moveTo(0, cam.cy);
      for (const [x, h] of ridge) ctx.lineTo(x, cam.cy - h);
      ctx.lineTo(cam.width, cam.cy);
      ctx.closePath();
      ctx.fill();
      const gg = ctx.createLinearGradient(0, cam.cy, 0, cam.height);
      gg.addColorStop(0, '#9aa98a');
      gg.addColorStop(1, '#6f8a55');
      ctx.fillStyle = gg;
      ctx.fillRect(0, cam.cy, cam.width, cam.height - cam.cy);
    }

    function road(cam, pose) {
      const a = pose.s - 10 * cam.dir;
      const b = pose.s + Z_FAR * cam.dir;
      const half = LANES_EACH * LANE_W;
      groundQuad(ctx, cam, a, b, -half - 1.5, half + 1.5, '#b9ad93'); // lề đất
      groundQuad(ctx, cam, a, b, -half, half, '#55585c'); // mặt đường
      if (scene.junction) {
        const j = scene.junction.s;
        groundQuad(ctx, cam, j - half, j + half, -400, 400, '#55585c');
      }
      // Vạch kẻ: hai mép liền, tim đứt (không kẻ qua nút giao).
      const near = pose.s;
      const far = pose.s + MARK_FAR * cam.dir;
      const lo = Math.min(near, far);
      const hi = Math.max(near, far);
      const inJ = (s) => scene.junction && Math.abs(s - scene.junction.s) < LANE_W * LANES_EACH + 1;
      for (const edge of [-half + 0.2, half - 0.2]) {
        const step = 10;
        for (let s = Math.floor(lo / step) * step; s < hi; s += step) {
          if (inJ(s) || inJ(s + step)) continue;
          groundQuad(ctx, cam, s, s + step, edge - LINE_W / 2, edge + LINE_W / 2, '#e9e9e4', 0.002);
        }
      }
      for (let s = Math.floor(lo / (DASH + DASH_GAP)) * (DASH + DASH_GAP); s < hi; s += DASH + DASH_GAP) {
        if (inJ(s)) continue;
        groundQuad(ctx, cam, s, s + DASH, -LINE_W / 2, LINE_W / 2, '#f2f2ee', 0.002);
      }
    }

    function house(cam, it) {
      const s0 = it.s;
      const s1 = it.s + it.len;
      const near = cam.dir > 0 ? s0 : s1;
      const inner = it.lat;
      const outer = it.lat + it.deep;
      const wall = `hsl(${it.hue} 18% ${it.light}%)`;
      const end = `hsl(${it.hue} 16% ${it.light - 12}%)`;
      fillPoly(ctx, cam, [cam.view(s0, inner, 0), cam.view(s1, inner, 0), cam.view(s1, inner, it.h), cam.view(s0, inner, it.h)], wall);
      fillPoly(ctx, cam, [cam.view(near, inner, 0), cam.view(near, outer, 0), cam.view(near, outer, it.h), cam.view(near, inner, it.h)], end);
      // Hàng cửa sổ cho có kết cấu (chỉ nhà gần: nhà xa thì cửa sổ nhỏ hơn một điểm ảnh).
      if (cam.view(near, inner, 0).Z > WINDOW_FAR) return;
      const wl = inner - 0.02 * Math.sign(inner); // sát mặt tường, phía đường
      for (let y = 2; y < it.h - 1; y += 3) {
        for (let s = s0 + 1; s < s1 - 1.2; s += 2.5) {
          fillPoly(ctx, cam, [cam.view(s, wl, y), cam.view(s + 1.2, wl, y), cam.view(s + 1.2, wl, y + 1.2), cam.view(s, wl, y + 1.2)], '#3d4a57');
        }
      }
    }

    function billboard(cam, s, lat, up, w, h) {
      const p = cam.view(s, lat, up);
      if (!(p.Z > Z_NEAR)) return null;
      const c = cam.toPx(p);
      return { x: c.u - (cam.f * w) / p.Z / 2, y: c.v - (cam.f * h) / p.Z / 2, w: (cam.f * w) / p.Z, h: (cam.f * h) / p.Z, Z: p.Z };
    }

    function tree(cam, it) {
      const trunk = billboard(cam, it.s, it.lat, 1, 0.3, 2);
      if (!trunk || trunk.Z > THING_FAR) return;
      ctx.fillStyle = '#6b4f35';
      ctx.fillRect(trunk.x, trunk.y, trunk.w, trunk.h);
      const crown = billboard(cam, it.s, it.lat, it.h, it.r * 2, it.r * 2);
      ctx.fillStyle = `rgb(${Math.round(60 * it.tone)} ${Math.round(110 * it.tone)} ${Math.round(55 * it.tone)})`;
      ctx.beginPath();
      ctx.ellipse(crown.x + crown.w / 2, crown.y + crown.h / 2, crown.w / 2, crown.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function signBack(b, shape) {
      ctx.fillStyle = '#9aa0a6';
      ctx.beginPath();
      if (shape === 'triangle') {
        ctx.moveTo(b.x + b.w / 2, b.y);
        ctx.lineTo(b.x + b.w, b.y + b.h);
        ctx.lineTo(b.x, b.y + b.h);
        ctx.closePath();
      } else {
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    function sign(cam, pose, sg) {
      const size = sg.size ?? SIGN_SIZE;
      const up = sg.up ?? SIGN_UP;
      const pole = billboard(cam, sg.s, sg.lat, (up - size / 2) / 2, POLE_W, up - size / 2);
      const face = billboard(cam, sg.s, sg.lat, up, size, size);
      if (!face || face.Z > Z_FAR) return;
      ctx.fillStyle = '#8d9399';
      if (pole) ctx.fillRect(pole.x, pole.y, Math.max(1, pole.w), pole.h);
      const facing = (sg.dir >= 0 ? 1 : -1) === cam.dir;
      const img = faces.get(sg.label);
      if (facing && img) ctx.drawImage(img, face.x, face.y, face.w, face.h);
      else signBack(face, sg.shape === 'triangle' ? 'triangle' : 'round');
    }

    function truck(cam, pose, t) {
      const b = truckBox(cam, pose, t);
      if (!b) return;
      ctx.fillStyle = '#2f3237';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = '#b8bcc2';
      ctx.fillRect(b.x + b.w * 0.06, b.y + b.h * 0.08, b.w * 0.88, b.h * 0.62);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(b.x + b.w * 0.04, b.y + b.h * 0.82, b.w * 0.12, b.h * 0.06);
      ctx.fillRect(b.x + b.w * 0.84, b.y + b.h * 0.82, b.w * 0.12, b.h * 0.06);
    }

    function draw(pose, flags = {}) {
      frameNo++;
      const cam = camera(pose, { width: canvas.width, height: canvas.height, aim });
      if (flags.blank) {
        // Camera bị tắt bằng nút của hệ điều hành hoặc bị che kín: khung đen.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cam.width, cam.height);
        return;
      }
      sky(cam);
      road(cam, pose);
      // Vật thể từ xa tới gần (vẽ đè theo chiều sâu).
      const things = [];
      for (const it of items) {
        const z = cam.dir * (it.s - pose.s);
        if (z < -(it.len || 0) - 2 || z > THING_FAR) continue;
        things.push({ z: it.kind === 'house' ? cam.dir * ((cam.dir > 0 ? it.s : it.s + it.len) - pose.s) : z, draw: () => (it.kind === 'house' ? house(cam, it) : tree(cam, it)) });
      }
      for (const sg of scene.signs) things.push({ z: cam.dir * (sg.s - pose.s), draw: () => sign(cam, pose, sg) });
      if (flags.truck) things.push({ z: flags.truck.gap, draw: () => truck(cam, pose, flags.truck) });
      things.sort((a, b) => b.z - a.z);
      for (const t of things) if (t.z > Z_NEAR) t.draw();
      if (flags.rain) {
        ctx.fillStyle = 'rgba(150, 158, 168, 0.28)';
        ctx.fillRect(0, 0, cam.width, cam.height);
        ctx.strokeStyle = 'rgba(220, 225, 235, 0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 260; i++) {
          const x = rain() * cam.width;
          const y = rain() * cam.height;
          ctx.moveTo(x, y);
          ctx.lineTo(x - 6, y + 34);
        }
        ctx.stroke();
      }
      if (flags.night) {
        // Ban đêm: tối gần hết, chỉ còn vùng đèn pha trước xe.
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = '#15171d';
        ctx.fillRect(0, 0, cam.width, cam.height);
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(cam.cx, cam.height, 20, cam.cx, cam.height, cam.height * 0.7);
        g.addColorStop(0, 'rgba(90, 85, 70, 0.55)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, cam.cy, cam.width, cam.height - cam.cy);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    return { draw, get frames() { return frameNo; } };
  }

  root.BDScene = Object.freeze({
    W, H, HFOV, CAM_HEIGHT, FOE_Y, SIGN_SIZE, SIGN_RIGHT, SIGN_UP, POLE_W, LANE_W, LANES_EACH, DASH, DASH_GAP, LINE_W,
    Z_NEAR, Z_FAR, MARK_FAR, WINDOW_FAR, THING_FAR, EARTH, TRUCK,
    focal, rng, seedOf, makeWorld, camera, signBox, truckBox, overlapShare, createRenderer,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
