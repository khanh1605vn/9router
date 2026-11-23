// Mã chạy trong trang Chrome không giao diện để vẽ dữ liệu tổng hợp (chỉ dùng khi huấn luyện).
// Nạp qua http://render.local/render-page.js (render-common.mjs phục vụ); cung cấp window.BD:
//   BD.renderCrops({ samples, bgs: [{ url, ignore }], jitter }) → { rgb: base64 (N×48×48×3 uint8), meta: [...] }
//   BD.renderScenes({ scenes, bgs: [{ id, url, ignore, clean }] })
//     → { scenes: [{ jpeg: dataURL, boxes, ignore, synth, geo, night, bg, clean }] }
// Mọi phép ngẫu nhiên đi qua mulberry32(seed) của từng mẫu nên kết quả không phụ thuộc lô hay tiến trình.

// ------------------------------------------------------------------------------------------------ hằng số
const OUT = 48; // cạnh ảnh vào bộ phân loại (hợp đồng 3)
const MARGIN = 0.15; // lề mỗi phía quanh khung biển khi cắt (hợp đồng 3)
const HI_RES = 160; // cạnh biển (điểm ảnh) ở bước vẽ siêu lấy mẫu trước khi thu về độ phân giải thật
const CONTEXT = 2.3; // vùng ngữ cảnh quanh biển, theo bội số cạnh biển (đủ cho lệch khung và lề)
// Cạnh thật của biển và độ lệch khung bộ dò do render-crops.mjs chọn (lib.mjs: CROP_SIZES, BOX_JITTER).
const P_PHOTO_BG = 0.8; // tỉ lệ dùng ảnh thật làm nền (khi có ảnh nền)
const P_POLE = 0.55; // tỉ lệ ảnh cắt có cột biển bên dưới
const P_OCCLUDE = 0.25; // tỉ lệ biển bị lá, cành, cột, dây hay xe che một phần
const P_NIGHT = 0.15; // tỉ lệ ảnh cắt ban đêm
const P_BACKLIGHT = 0.08; // ngược sáng: biển tối, nền chói
const P_BLUR = 0.6; // tỉ lệ ảnh bị mờ (lấy nét kém)
const P_MOTION = 0.35; // tỉ lệ ảnh bị nhoè chuyển động
// Khung hình camera không qua nén JPEG; chỉ một phần ảnh được nén nhẹ để mô phỏng giảm nhiễu/làm nét của máy ảnh.
const P_JPEG = 0.5;
const JPEG_Q = [0.55, 0.95]; // chất lượng JPEG khi nén
const BG_TRIES = 6; // số lần thử lấy mảng ảnh nền không đè lên hộp biển có sẵn; hết lượt thì dùng nền vẽ thủ tục
const CROP_VIEW = 1.8; // vùng giữa phải tránh hộp biển có sẵn, theo bội số cạnh biển (khung lệch + lề 15 % mỗi phía)
const BG_IGNORE_PAD = 0.15; // nới hộp biển có sẵn thêm chừng này lần cạnh của nó mỗi phía (hộp thường vẽ sát)

// ------------------------------------------------------------------------------------------------ tiện ích
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mk = (R) => ({
  R,
  U: (a, b) => a + (b - a) * R(),
  L: (a, b) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * R()), // log-đều
  pick: (a) => a[Math.floor(R() * a.length)],
  gauss: () => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R()),
  chance: (p) => R() < p,
});
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

// Bộ nhớ đệm ảnh: hình SVG nhỏ giữ nhiều, ảnh nền lớn (khoảng 3 MB mỗi ảnh khi giải mã) giữ ít.
const CACHES = { svg: { map: new Map(), max: 800 }, photo: { map: new Map(), max: 40 } };
function loadImg(url) {
  const cache = url.startsWith('data:') ? CACHES.svg : CACHES.photo;
  const m = cache.map;
  if (m.has(url)) {
    const v = m.get(url);
    m.delete(url);
    m.set(url, v);
    return v;
  }
  const p = new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error(`không nạp được ảnh ${url.slice(0, 80)}`));
    im.src = url;
  });
  m.set(url, p);
  if (m.size > cache.max) m.delete(m.keys().next().value);
  return p;
}

async function jpegRoundTrip(c, q) {
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
  const bmp = await createImageBitmap(blob);
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, 0);
  bmp.close();
}

// ------------------------------------------------------------------------------------------------ hình học
/** Ma trận đồng nhất ánh xạ 4 điểm src → 4 điểm dst (giải 8×8 bằng khử Gauss). */
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

/** Bốn góc của tấm biển w×h xoay trong không gian (yaw, pitch, roll) rồi chiếu phối cảnh, tâm (cx, cy). */
function projectQuad(cx, cy, w, h, yaw, pitch, roll) {
  const f = 4.5; // tiêu cự theo nửa cạnh: phối cảnh nhẹ
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const a = h / w;
  return [[-1, -a], [1, -a], [1, a], [-1, a]].map(([x, y]) => {
    let X = x * cr - y * sr, Y = x * sr + y * cr, Z = 0;
    [X, Z] = [X * cyw + Z * syw, -X * syw + Z * cyw];
    [Y, Z] = [Y * cp - Z * sp, Y * sp + Z * cp];
    const zz = Z + f;
    return [cx + ((X * f) / zz) * (w / 2), cy + ((Y * f) / zz) * (w / 2)];
  });
}

/**
 * Dán ảnh src (có kênh alpha) vào ctx theo tứ giác quad (nội suy song tuyến, đọc/ghi chỉ vùng bao).
 * Trả về khung bao các điểm ảnh có alpha ≥ 0,5 { x0, y0, x1, y1 } hoặc null nếu không có điểm nào.
 */
function warpInto(ctx, src, quad, alphaMul = 1) {
  const SW = src.width, SH = src.height;
  const H = homography(quad, [[0, 0], [SW, 0], [SW, SH], [0, SH]]);
  const sd = ctx2d(src).getImageData(0, 0, SW, SH).data;
  const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(ctx.canvas.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(ctx.canvas.height - 1, Math.ceil(Math.max(...ys)));
  if (x1 < x0 || y1 < y0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const img = ctx.getImageData(x0, y0, bw, bh);
  const d = img.data;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w = H[6] * px + H[7] * py + 1;
      const u = (H[0] * px + H[1] * py + H[2]) / w - 0.5, v = (H[3] * px + H[4] * py + H[5]) / w - 0.5;
      if (u < -0.5 || v < -0.5 || u > SW - 0.5 || v > SH - 0.5) continue;
      const iu = clamp(Math.floor(u), 0, SW - 2), iv = clamp(Math.floor(v), 0, SH - 2);
      const fu = clamp(u - iu, 0, 1), fv = clamp(v - iv, 0, 1);
      const o = (iv * SW + iu) * 4;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      const al = (sd[o + 3] * w00 + sd[o + 7] * w10 + sd[o + SW * 4 + 3] * w01 + sd[o + SW * 4 + 7] * w11) / 255;
      if (al <= 0.002) continue;
      const di = ((y - y0) * bw + (x - x0)) * 4;
      // màu đã nhân alpha để viền mịn không bị quầng tối
      for (let c = 0; c < 3; c++) {
        const pre =
          (sd[o + c] * sd[o + 3] * w00 + sd[o + 4 + c] * sd[o + 7] * w10 +
            sd[o + SW * 4 + c] * sd[o + SW * 4 + 3] * w01 + sd[o + SW * 4 + 4 + c] * sd[o + SW * 4 + 7] * w11) / 255;
        const a = al * alphaMul;
        d[di + c] = pre * alphaMul + d[di + c] * (1 - a);
      }
      if (al >= 0.5) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  ctx.putImageData(img, x0, y0);
  return bx1 < bx0 ? null : { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 };
}

// ------------------------------------------------------------------------------------------------ hình biển
/** Vẽ hình (SVG đã nạp) ra canvas cạnh rộng `size`, thêm phai màu, bụi, loá, bóng, tem dán. */
async function appearance(item, size, G, { wear = true, dim = 0 } = {}) {
  const img = await loadImg(item.url);
  const w = Math.round(size), h = Math.max(4, Math.round((size * item.h) / item.w));
  const c = canvas(w, h);
  const x = ctx2d(c);
  const sat = G.U(0.55, 1.2), bri = G.U(0.7, 1.15);
  x.filter = `saturate(${sat}) brightness(${bri})`;
  if (item.mirror) {
    x.translate(w, 0);
    x.scale(-1, 1);
  }
  x.drawImage(img, 0, 0, w, h);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.filter = 'none';
  x.globalCompositeOperation = 'source-atop';
  if (dim > 0) {
    x.fillStyle = `rgba(0,0,0,${dim.toFixed(3)})`; // biển tối hơn (ngược sáng, đêm xa đèn)
    x.fillRect(0, 0, w, h);
  }
  if (!wear) {
    x.globalCompositeOperation = 'source-over';
    return c;
  }
  if (G.chance(0.4)) {
    x.fillStyle = `rgba(255,250,240,${G.U(0.05, 0.35)})`; // phai màu do nắng
    x.fillRect(0, 0, w, h);
  }
  if (G.chance(0.5))
    for (let i = 0; i < 40; i++) {
      x.fillStyle = `rgba(${G.U(40, 90)},${G.U(35, 70)},${G.U(20, 50)},${G.U(0.03, 0.15)})`; // bụi bẩn
      x.beginPath();
      x.ellipse(G.U(0, w), G.U(0, h), G.U(0.02, 0.15) * w, G.U(0.02, 0.12) * w, G.U(0, 3), 0, 7);
      x.fill();
    }
  if (G.chance(0.12))
    for (let i = 0; i < 1 + G.R() * 3; i++) {
      x.fillStyle = G.pick(['#f4f4f4', '#d8d8d8', '#c9b38a', '#fafafa']); // tem dán, sơn bong
      x.fillRect(G.U(0, w), G.U(0, h), G.U(0.04, 0.16) * w, G.U(0.03, 0.1) * w);
    }
  if (G.chance(0.2)) {
    const g = x.createRadialGradient(G.U(0.15, 0.85) * w, G.U(0.15, 0.85) * h, 0, w / 2, h / 2, G.U(0.25, 0.6) * w);
    g.addColorStop(0, `rgba(255,255,255,${G.U(0.35, 0.8)})`); // loá
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  }
  if (G.chance(0.3)) {
    x.fillStyle = `rgba(0,0,20,${G.U(0.2, 0.55)})`; // bóng cây, bóng cột
    x.beginPath();
    x.moveTo(G.U(-0.2, 1.2) * w, -2);
    x.lineTo(G.U(-0.2, 1.2) * w, h + 2);
    x.lineTo(G.chance(0.5) ? -2 : w + 2, h + 2);
    x.lineTo(G.chance(0.5) ? -2 : w + 2, -2);
    x.fill();
  }
  x.globalCompositeOperation = 'source-over';
  return c;
}

function proceduralBg(x, W, H, G) {
  const kind = G.pick(['sky', 'foliage', 'urban', 'road']);
  if (kind === 'sky') {
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${G.U(195, 220)},${G.U(30, 70)}%,${G.U(45, 75)}%)`);
    g.addColorStop(1, `hsl(${G.U(190, 220)},${G.U(10, 40)}%,${G.U(70, 92)}%)`);
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 10; i++) {
      x.fillStyle = `rgba(255,255,255,${G.U(0.15, 0.5)})`;
      x.beginPath();
      x.ellipse(G.U(0, W), G.U(0, H), G.U(0.08, 0.3) * W, G.U(0.04, 0.14) * H, 0, 0, 7);
      x.fill();
    }
  } else if (kind === 'foliage') {
    x.fillStyle = `hsl(${G.U(80, 130)},${G.U(25, 55)}%,${G.U(15, 35)}%)`;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 250; i++) {
      x.fillStyle = `hsla(${G.U(70, 140)},${G.U(20, 60)}%,${G.U(10, 55)}%,${G.U(0.4, 0.9)})`;
      x.beginPath();
      x.ellipse(G.U(0, W), G.U(0, H), G.U(0.01, 0.05) * W, G.U(0.01, 0.03) * W, G.U(0, 3.14), 0, 7);
      x.fill();
    }
  } else if (kind === 'urban') {
    x.fillStyle = `hsl(${G.U(0, 360)},${G.U(0, 25)}%,${G.U(35, 75)}%)`;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 14; i++) {
      x.fillStyle = `hsl(${G.U(0, 360)},${G.U(0, 45)}%,${G.U(20, 85)}%)`;
      x.fillRect(G.U(-0.15, 1) * W, G.U(-0.15, 1) * H, G.U(0.08, 0.5) * W, G.U(0.08, 0.6) * H);
    }
  } else {
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${G.U(30, 60)},${G.U(5, 25)}%,${G.U(50, 80)}%)`);
    g.addColorStop(1, `hsl(0,0%,${G.U(20, 45)}%)`);
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
  }
  if (G.chance(0.45)) {
    x.strokeStyle = 'rgba(15,15,15,0.8)'; // dây điện chằng chịt
    for (let i = 0; i < 4; i++) {
      x.lineWidth = G.U(0.004, 0.012) * W;
      x.beginPath();
      const y = G.U(0, H);
      x.moveTo(0, y);
      x.quadraticCurveTo(W / 2, y + G.U(-0.12, 0.15) * H, W, y + G.U(-0.15, 0.15) * H);
      x.stroke();
    }
  }
}

/** Vùng [x0, y0, x1, y1] (tỉ lệ 0–1 của ảnh nền) có đè lên hộp biển có sẵn nào (đã nới BG_IGNORE_PAD) không. */
function hitsIgnore(v, ignore) {
  for (const [x0, y0, x1, y1] of ignore || []) {
    const px = (x1 - x0) * BG_IGNORE_PAD, py = (y1 - y0) * BG_IGNORE_PAD;
    if (v[0] < x1 + px && x0 - px < v[2] && v[1] < y1 + py && y0 - py < v[3]) return true;
  }
  return false;
}

/**
 * Nền: một mảng ảnh thật (tỉ lệ ngẫu nhiên) mà vùng giữa viewPx×viewPx của canvas không đè lên hộp biển có sẵn,
 * hoặc nền vẽ thủ tục. Trả về true nếu dùng ảnh thật.
 */
async function drawBackground(x, W, H, G, bgs, pxPerUnit, viewPx) {
  if (bgs.length && G.chance(P_PHOTO_BG)) {
    const bg = G.pick(bgs);
    const im = await loadImg(bg.url);
    for (let t = 0; t < BG_TRIES; t++) {
      const k = G.L(0.35, 2.6) * pxPerUnit; // số điểm ảnh của ảnh nền ứng với một điểm ảnh thật
      const sw = Math.min(im.width, W * k), sh = Math.min(im.height, H * k);
      const sx = G.U(0, im.width - sw), sy = G.U(0, im.height - sh);
      const vx = ((W - viewPx) / 2) * (sw / W), vy = ((H - viewPx) / 2) * (sh / H);
      const v = [(sx + vx) / im.width, (sy + vy) / im.height, (sx + sw - vx) / im.width, (sy + sh - vy) / im.height];
      if (hitsIgnore(v, bg.ignore)) continue;
      x.drawImage(im, sx, sy, sw, sh, 0, 0, W, H);
      return true;
    }
  }
  proceduralBg(x, W, H, G);
  return false;
}

function occlude(x, G, cx, cy, w, h) {
  const kind = G.pick(['leaves', 'branch', 'pole', 'wire', 'vehicle']);
  if (kind === 'leaves') {
    const ox = cx + G.U(-0.5, 0.5) * w, oy = cy + G.U(-0.5, 0.5) * h;
    for (let i = 0; i < 30; i++) {
      x.fillStyle = `hsl(${G.U(80, 130)},${G.U(30, 60)}%,${G.U(12, 35)}%)`;
      x.beginPath();
      x.ellipse(ox + G.U(-0.2, 0.2) * w, oy + G.U(-0.2, 0.2) * w, G.U(0.03, 0.08) * w, G.U(0.02, 0.05) * w, G.U(0, 3), 0, 7);
      x.fill();
    }
  } else if (kind === 'branch') {
    x.strokeStyle = `hsl(25,30%,${G.U(10, 25)}%)`;
    x.lineWidth = G.U(0.03, 0.07) * w;
    x.beginPath();
    x.moveTo(cx + G.U(-1, 1) * w, cy - h);
    x.lineTo(cx + G.U(-1, 1) * w, cy + h);
    x.stroke();
  } else if (kind === 'pole') {
    x.fillStyle = `hsl(0,0%,${G.U(20, 60)}%)`;
    x.fillRect(cx + G.U(-0.6, 0.4) * w, cy - 2 * h, G.U(0.08, 0.18) * w, 4 * h);
  } else if (kind === 'wire') {
    x.strokeStyle = 'rgba(10,10,10,0.9)';
    x.lineWidth = G.U(0.01, 0.03) * w;
    x.beginPath();
    x.moveTo(cx - 2 * w, cy + G.U(-0.4, 0.4) * h);
    x.lineTo(cx + 2 * w, cy + G.U(-0.4, 0.4) * h);
    x.stroke();
  } else {
    // xe phía trước che một góc (tối đa khoảng 30 % biển)
    x.fillStyle = `hsl(${G.U(0, 360)},${G.U(0, 30)}%,${G.U(5, 60)}%)`;
    const side = G.pick([-1, 1]);
    x.fillRect(cx + side * G.U(0.2, 0.45) * w - (side < 0 ? 2 * w : 0), cy - 2 * h, 2 * w, 4 * h);
  }
}

function lighting(x, W, H, G) {
  x.globalCompositeOperation = 'soft-light';
  x.globalAlpha = G.U(0, 0.18);
  x.fillStyle = `hsl(${G.U(0, 360)},60%,50%)`; // ám màu, cân bằng trắng lệch
  x.fillRect(0, 0, W, H);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
}

/** Ban đêm: nền tối, biển phản quang sáng nhờ đèn pha (vẽ lại biển sáng lên trên nền đã tối). */
function nightify(x, W, H, G) {
  x.fillStyle = `rgba(0,0,10,${G.U(0.6, 0.88)})`;
  x.fillRect(0, 0, W, H);
}

function cameraEffects(c, G, { night, noiseScale = 1 }) {
  const x = ctx2d(c);
  const W = c.width, H = c.height;
  if (G.chance(P_BLUR)) {
    const t = canvas(W, H);
    const tx = t.getContext('2d');
    tx.filter = `blur(${G.U(0.3, 1.2).toFixed(2)}px)`;
    tx.drawImage(c, 0, 0);
    x.clearRect(0, 0, W, H);
    x.drawImage(t, 0, 0);
  }
  if (G.chance(P_MOTION)) {
    const len = G.U(1, 4);
    const ang = G.U(-0.5, 0.5);
    const t = canvas(W, H);
    t.getContext('2d').drawImage(c, 0, 0);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1) - 0.5) * len;
      x.globalAlpha = 1 / (i + 1);
      x.drawImage(t, s * Math.cos(ang), s * Math.sin(ang));
    }
    x.globalAlpha = 1;
  }
  const sigma = (night ? G.U(4, 14) : G.U(0, 7)) * noiseScale;
  if (sigma > 0.5) {
    const id = x.getImageData(0, 0, W, H);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = G.gauss() * sigma;
      for (let k = 0; k < 3; k++) d[i + k] = d[i + k] + l + G.gauss() * sigma * 0.35;
    }
    x.putImageData(id, 0, 0);
  }
}

// ------------------------------------------------------------------------------------------------ ảnh cắt
async function renderCrop(s, bgs, out, off, jitter) {
  const G = mk(mulberry32(s.seed));
  const item = s.item; // { url, w, h, mirror } hoặc null (nền thuần)
  const w = s.width; // cạnh thật, do render-crops.mjs chọn
  const aspect = item ? item.h / item.w : G.U(0.7, 1.3);
  const big = Math.max(w, w * aspect);
  const ss = clamp(Math.round(HI_RES / big), 1, 4);
  const C = Math.ceil(big * CONTEXT) + 4;
  const HS = C * ss;
  const hi = canvas(HS, HS);
  const hx = ctx2d(hi);
  const photo = await drawBackground(hx, HS, HS, G, bgs, 1 / ss, Math.min(HS, CROP_VIEW * big * ss));
  const night = G.chance(P_NIGHT);
  const backlight = !night && G.chance(P_BACKLIGHT);
  if (night) nightify(hx, HS, HS, G);
  if (backlight) {
    hx.fillStyle = `rgba(255,252,240,${G.U(0.3, 0.6)})`;
    hx.fillRect(0, 0, HS, HS);
  }
  const sw = w * ss;
  const cx = HS / 2 + G.U(-0.03, 0.03) * sw, cy = HS / 2 + G.U(-0.03, 0.03) * sw;
  let bbox = null;
  if (item) {
    if (s.kind !== 'bg' && G.chance(P_POLE)) {
      hx.fillStyle = `hsl(0,0%,${G.U(30, 70)}%)`;
      const pw = sw * G.U(0.05, 0.11);
      hx.fillRect(cx - pw / 2, cy, pw, HS);
    }
    let dim = 0;
    if (backlight) dim = G.U(0.25, 0.55);
    if (night) dim = G.U(0, 0.5);
    const sc = await appearance(item, Math.min(512, Math.max(64, sw * 2)), G, { wear: s.kind !== 'bg' || G.chance(0.5), dim });
    const yaw = clamp(G.gauss() * 0.28, -0.7, 0.7), pitch = G.U(-0.15, 0.15), roll = G.U(-0.12, 0.12);
    const quad = projectQuad(cx, cy, sw, sw * aspect, yaw, pitch, roll);
    bbox = warpInto(hx, sc, quad);
    if (s.kind !== 'bg' && G.chance(P_OCCLUDE)) occlude(hx, G, cx, cy, sw, sw * aspect);
  }
  if (!bbox) {
    const bw = sw, bh = sw * aspect;
    bbox = { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
  }
  lighting(hx, HS, HS, G);
  // quang học: thu về độ phân giải thật
  const nat = canvas(C, C);
  const nx = ctx2d(nat);
  nx.imageSmoothingQuality = 'high';
  nx.drawImage(hi, 0, 0, HS, HS, 0, 0, C, C);
  cameraEffects(nat, G, { night });
  if (G.chance(P_JPEG)) await jpegRoundTrip(nat, G.U(JPEG_Q[0], JPEG_Q[1]));
  // khung bộ dò (lệch) + lề 15 % → 48×48
  const bw = (bbox.x1 - bbox.x0) / ss, bh = (bbox.y1 - bbox.y0) / ss;
  const bcx = (bbox.x0 + bbox.x1) / 2 / ss, bcy = (bbox.y0 + bbox.y1) / 2 / ss;
  const js = 1 + G.U(-jitter.scale, jitter.scale);
  const ja = 1 + G.U(-0.05, 0.05);
  const jw = bw * js * ja, jh = bh * js / ja;
  const jcx = bcx + G.U(-jitter.shift, jitter.shift) * bw, jcy = bcy + G.U(-jitter.shift, jitter.shift) * bh;
  const cw = jw * (1 + 2 * MARGIN), ch = jh * (1 + 2 * MARGIN);
  const o = canvas(OUT, OUT);
  const ox = ctx2d(o);
  const q = G.pick(['low', 'medium', 'high']);
  ox.imageSmoothingEnabled = true;
  ox.imageSmoothingQuality = q;
  ox.fillStyle = '#000';
  ox.fillRect(0, 0, OUT, OUT);
  ox.drawImage(nat, jcx - cw / 2, jcy - ch / 2, cw, ch, 0, 0, OUT, OUT);
  const px = ox.getImageData(0, 0, OUT, OUT).data;
  for (let i = 0, j = off; i < px.length; i += 4, j += 3) {
    out[j] = px[i];
    out[j + 1] = px[i + 1];
    out[j + 2] = px[i + 2];
  }
  return { w: Math.round(bw * 10) / 10, night, q, photo };
}

function toBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

async function renderCrops({ samples, bgs, jitter }) {
  const out = new Uint8Array(samples.length * OUT * OUT * 3);
  const meta = [];
  for (let i = 0; i < samples.length; i++) meta.push(await renderCrop(samples[i], bgs, out, i * OUT * OUT * 3, jitter));
  return { rgb: toBase64(out), meta };
}

// ------------------------------------------------------------------------------------------------ cảnh cho bộ dò
const SCENE_W = 640, SCENE_H = 352; // ảnh vào bộ dò (hợp đồng 2)
const MIN_LABEL_PX = 5; // khung nhỏ hơn chừng này (ở ảnh vào bộ dò) không gắn nhãn
const MIN_VISIBLE = 0.6; // phần biển nằm trong ảnh phải ít nhất chừng này mới gắn nhãn

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  return i / (a[2] * a[3] + b[2] * b[3] - i + 1e-9);
};
const overlaps = (a, b, pad = 0) =>
  a[0] - pad < b[0] + b[2] && b[0] - pad < a[0] + a[2] && a[1] - pad < b[1] + b[3] && b[1] - pad < a[1] + a[3];
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Một ảnh vào bộ dò. sc.frame = [FW, FH] là khung hình camera được vẽ (điểm ảnh thật), sc.lb = { dx, dy, dw, dh } là
 * chỗ khung hình nằm trong ảnh 640×352 (render-scenes.mjs tính như passGeometry của js/visionproto.js):
 * A = ô cắt 640×352 đúng độ phân giải camera (lb phủ hết ảnh); B = cả khung hình thu nhỏ cho vừa rồi thêm viền đen.
 * Mọi biến đổi camera làm ở độ phân giải của khung hình, rồi mới thu nhỏ. Toạ độ trả về là điểm ảnh của ảnh vào.
 */
async function renderScene(sc, bgs) {
  const G = mk(mulberry32(sc.seed));
  const geo = sc.geo;
  const [FW, FH] = sc.frame;
  const { dx, dy, dw, dh } = sc.lb;
  const kx = FW / dw, ky = FH / dh; // điểm ảnh khung hình ứng với một điểm ảnh ảnh vào
  const k = kx;
  const c = canvas(FW, FH);
  const x = ctx2d(c);
  const toIn = (X, Y) => [dx + X / kx, dy + Y / ky];
  // nền: ảnh thật, vùng bỏ qua là các hộp biển có sẵn
  const ignore = [];
  let bgId = null;
  let clean = true; // nền vẽ thủ tục, hoặc ảnh người kiểm xác nhận không có biển
  if (bgs.length) {
    const bg = G.pick(bgs);
    bgId = bg.id;
    clean = !!bg.clean;
    const im = await loadImg(bg.url);
    let sw, sh;
    if (geo === 'B') {
      // cả khung hình: lấy 60–100 % bề rộng ảnh nền, giữ tỉ lệ của khung hình
      sw = im.width * G.U(0.6, 1.0);
      sh = (sw * FH) / FW;
      if (sh > im.height) {
        sh = im.height;
        sw = (sh * FW) / FH;
      }
    } else {
      const s = G.U(0.8, 1.6); // A: phóng/thu ảnh nền 0,8–1,6 lần rồi cắt
      sw = Math.min(im.width, FW / s);
      sh = Math.min(im.height, FH / s);
    }
    const sx = G.U(0, im.width - sw), sy = G.U(0, im.height - sh);
    x.drawImage(im, sx, sy, sw, sh, 0, 0, FW, FH);
    for (const [nx0, ny0, nx1, ny1] of bg.ignore || []) {
      const [X0, Y0] = toIn(((nx0 * im.width - sx) / sw) * FW, ((ny0 * im.height - sy) / sh) * FH);
      const [X1, Y1] = toIn(((nx1 * im.width - sx) / sw) * FW, ((ny1 * im.height - sy) / sh) * FH);
      const a = [Math.max(dx, X0), Math.max(dy, Y0), Math.min(dx + dw, X1) - Math.max(dx, X0), Math.min(dy + dh, Y1) - Math.max(dy, Y0)];
      if (a[2] > 1 && a[3] > 1) ignore.push(a.map(r1));
    }
  } else proceduralBg(x, FW, FH, G);
  const night = G.chance(0.12);
  if (night) nightify(x, FW, FH, G);

  const boxes = [];
  const synth = []; // mọi vật tự vẽ (biển, biển lạ, vật gây nhiễu): lỗi âm ở đây luôn đủ trọng số
  const taken = ignore.map((a) => a.slice());
  // vật gây nhiễu trước (có thể bị biển che)
  for (const d of sc.distractors) {
    const ow = d.size * k, oh = ((d.size * d.item.h) / d.item.w) * k;
    const px = G.U(0, FW - ow), py = G.U(0, FH - oh);
    const ap = await appearance(d.item, Math.min(512, Math.max(24, ow * 1.5)), G, { wear: false, dim: night ? G.U(0.4, 0.8) : 0 });
    const bb = warpInto(x, ap, projectQuad(px + ow / 2, py + oh / 2, ow, oh, G.U(-0.3, 0.3), G.U(-0.1, 0.1), G.U(-0.08, 0.08)));
    if (bb) synth.push([...toIn(bb.x0, bb.y0), (bb.x1 - bb.x0) / kx, (bb.y1 - bb.y0) / ky].map(r1));
  }
  for (const grp of sc.groups) {
    // một cột: 1–3 biển xếp dọc, có thể kèm biển phụ ở dưới (toạ độ ảnh vào)
    const sizes = grp.items.map((it) => [grp.size, (grp.size * it.h) / it.w]);
    const gaps = grp.items.map(() => grp.size * G.U(0.04, 0.15));
    const totalH = sizes.reduce((a, s, i) => a + s[1] + (i ? gaps[i] : 0), 0);
    const maxW = Math.max(...sizes.map((s) => s[0]));
    let rect = null;
    for (let t = 0; t < 25 && !rect; t++) {
      const r = [dx + G.U(-0.1 * maxW, dw - 0.9 * maxW), dy + G.U(-0.1 * totalH, dh * 0.92 - totalH), maxW, totalH];
      if (!taken.some((q) => overlaps(r, q, 3))) rect = r;
    }
    if (!rect) continue;
    taken.push(rect);
    const yaw = clamp(G.gauss() * 0.25, -0.65, 0.65), pitch = G.U(-0.12, 0.12), roll = G.U(-0.08, 0.08);
    const poleX = (rect[0] + maxW / 2 - dx) * kx; // toạ độ khung hình
    const top = (rect[1] - dy) * ky;
    if (G.chance(0.7)) {
      x.fillStyle = `hsl(0,0%,${G.U(30, 70)}%)`;
      const pw = Math.max(1, maxW * G.U(0.05, 0.1)) * k;
      x.fillRect(poleX - pw / 2, top, pw, (FH - top) * G.U(0.4, 1));
    }
    let y = top;
    for (let i = 0; i < grp.items.length; i++) {
      const it = grp.items[i];
      const sw = sizes[i][0] * kx, sh = sizes[i][1] * ky;
      if (i) y += gaps[i] * ky;
      const ap = await appearance(it, Math.min(512, Math.max(32, sw * 2)), G, { dim: night ? G.U(0, 0.45) : 0 });
      const quad = projectQuad(poleX, y + sh / 2, sw, sh, yaw, pitch, roll);
      const bb = warpInto(x, ap, quad);
      y += sh;
      if (!bb) continue;
      const bx = [...toIn(bb.x0, bb.y0), (bb.x1 - bb.x0) / kx, (bb.y1 - bb.y0) / ky];
      synth.push(bx.map(r1));
      if (it.family < 0) continue;
      // phần nằm trong ảnh (trong khung hình, không tính viền đen)
      const vis = [Math.max(dx, bx[0]), Math.max(dy, bx[1]), Math.min(dx + dw, bx[0] + bx[2]), Math.min(dy + dh, bx[1] + bx[3])];
      const full = Math.max(1e-6, (quad[1][0] - quad[0][0]) / kx) * Math.max(1e-6, (quad[3][1] - quad[0][1]) / ky);
      const visA = Math.max(0, vis[2] - vis[0]) * Math.max(0, vis[3] - vis[1]);
      if (bx[2] < MIN_LABEL_PX || bx[3] < MIN_LABEL_PX) continue;
      if (visA / full < MIN_VISIBLE) {
        ignore.push(bx.map(r1)); // biển bị cắt mép: không tính lỗi ở đó
        continue;
      }
      boxes.push([...bx.map((v) => Math.round(v * 100) / 100), it.family]);
    }
    if (G.chance(0.15) && !night) occlude(x, G, poleX, top + (totalH * ky) / 2, maxW * k, totalH * ky);
  }
  lighting(x, FW, FH, G);
  if (G.chance(0.1)) {
    x.strokeStyle = `rgba(220,225,235,${G.U(0.15, 0.35)})`; // vệt mưa
    x.lineWidth = Math.max(1, k * 0.8);
    const ang = G.U(-0.3, 0.3);
    for (let i = 0; i < 160; i++) {
      const px = G.U(0, FW), py = G.U(0, FH), L = G.U(8, 30) * k;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + Math.sin(ang) * L, py + Math.cos(ang) * L);
      x.stroke();
    }
  }
  cameraEffects(c, G, { night });
  if (G.chance(P_JPEG)) await jpegRoundTrip(c, G.U(JPEG_Q[0], JPEG_Q[1]));
  let fin = c;
  if (FW !== SCENE_W || FH !== SCENE_H || dx || dy) {
    fin = canvas(SCENE_W, SCENE_H);
    const fx = ctx2d(fin);
    fx.fillStyle = '#000'; // viền đen như lúc chạy
    fx.fillRect(0, 0, SCENE_W, SCENE_H);
    fx.imageSmoothingQuality = 'high';
    fx.drawImage(c, 0, 0, FW, FH, dx, dy, dw, dh);
  }
  const jpeg = fin.toDataURL('image/jpeg', 0.92);
  return { jpeg, boxes, ignore, synth, geo, night, bg: bgId, clean };
}

async function renderScenes({ scenes, bgs }) {
  const out = [];
  for (const sc of scenes) out.push(await renderScene(sc, bgs));
  return { scenes: out };
}

window.BD = { renderCrops, renderScenes, iou };
