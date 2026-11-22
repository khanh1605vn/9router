// Hình biển báo dạng SVG (viewBox 0 0 100 100) theo kiểu biển Việt Nam: vòng đỏ, tam giác vàng,
// nền xanh lam, nền xanh lá cao tốc. Đây là hình giản lược tự vẽ, không sao chép hình gốc.
// An toàn: dữ liệu động chỉ có `value` (lọc theo mẫu số) và `title` (đã thoát ký tự XML);
// không dùng id hay tham chiếu ngoài vì một trang có thể chứa nhiều bản sao cùng lúc.

const RED = '#d5202a';
const YELLOW = '#ffd21f';
const BLUE = '#0a57a4';
const GREEN = '#0b7a45';
const INK = '#1a1a1a';
const WHITE = '#ffffff';
const GREY = '#8a9097'; // hình vẽ mờ của biển "hết …"
const EDGE = '#b9c0c8'; // viền mảnh để biển nền trắng nổi trên nền sáng
const LAMP_GREEN = '#1c9b50';
const FONT = 'font-family="Arial,Helvetica,sans-serif" font-weight="700"';

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Nét vẽ cơ bản
// ---------------------------------------------------------------------------------------------

const ln = (d, c, w = 8, cap = 'round', dash = '') =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="round"` +
  `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const fl = (d, c) => `<path d="${d}" fill="${c}"/>`;
const dot = (x, y, r, c) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
const ring = (x, y, r, c, w) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
const box = (x, y, w, h, c, rx = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''} fill="${c}"/>`;
const grp = (t, inner) => (inner ? `<g transform="${t}">${inner}</g>` : '');
const fit = (s, x, y) => `translate(${x} ${y}) scale(${s})`;
/** Thu nhỏ hình quanh tâm (50, 50) để không chạm vòng viền. */
const shrink = (svg, s = 0.88) => grp(`translate(50 50) scale(${s}) translate(-50 -50)`, svg);

/** Đầu mũi tên tam giác: đáy giữa tại (x, y), mũi hướng theo vectơ (dx, dy). */
function head(x, y, dx, dy, c, len = 16, half = 11) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const pts = [
    [x + ux * len, y + uy * len],
    [x - uy * half, y + ux * half],
    [x + uy * half, y - ux * half],
  ];
  return fl(`M${pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L')}Z`, c);
}

/** Mũi tên: thân là đường `d` kết thúc tại (x, y), đầu mũi tên hướng (dx, dy). */
const arrow = (d, x, y, dx, dy, c, w = 9, len = 16, half = 11) => ln(d, c, w) + head(x, y, dx, dy, c, len, half);

// Bề rộng ước lượng của chữ đậm Arial (theo em) để co chữ khi dài.
const GLYPH_W = { ',': 0.28, '.': 0.28, ' ': 0.28, m: 0.89, t: 0.33, '%': 0.89, i: 0.28, '/': 0.28, h: 0.61, k: 0.56 };
const textWidth = (s, size) => [...s].reduce((w, ch) => w + (GLYPH_W[ch] ?? (/\d/.test(ch) ? 0.56 : 0.62)), 0) * size;

/** Chữ căn giữa tại (x, cy) (cy là tâm theo chiều dọc), tự co lại nếu rộng quá maxW. */
function text(s, x, cy, size, c, maxW = 0) {
  const squeeze = maxW && textWidth(s, size) > maxW ? ` textLength="${maxW}" lengthAdjust="spacingAndGlyphs"` : '';
  return (
    `<text x="${x}" y="${r1(cy + size * 0.36)}" font-size="${size}" ${FONT} fill="${c}" ` +
    `text-anchor="middle"${squeeze}>${esc(s)}</text>`
  );
}

/** Con số lớn ở giữa biển (tốc độ, tải trọng…). */
function bigNumber(v, c, cy = 50, maxW = 62) {
  const size = v.length <= 2 ? 46 : 40;
  return text(v, 50, cy, size, c, maxW);
}

/** Dải vạch mảnh màu đen chéo từ trên phải xuống dưới trái (biển "hết …"), cắt theo hình tròn. */
function endBand(cx, cy, radius, c = INK, offsets = [-9, -4.5, 0, 4.5, 9]) {
  const d = offsets
    .map((o) => {
      const h = Math.sqrt(radius * radius - o * o);
      const mx = cx + o / Math.SQRT2;
      const my = cy + o / Math.SQRT2;
      const hx = h / Math.SQRT2;
      return `M${r1(mx + hx)} ${r1(my - hx)}L${r1(mx - hx)} ${r1(my + hx)}`;
    })
    .join('');
  return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.2"/>`;
}

/** Dải vạch chéo (cùng hướng) cắt theo hình thoi |x−50| + |y−50| ≤ radius. */
function diamondBand(radius, c = INK, offsets = [-9, -4.5, 0, 4.5, 9]) {
  const d = offsets
    .map((k) => {
      const t1 = (radius + k) / 2;
      const t2 = (k - radius) / 2;
      return `M${r1(50 + t1)} ${r1(50 - t1 + k)}L${r1(50 + t2)} ${r1(50 - t2 + k)}`;
    })
    .join('');
  return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.2"/>`;
}

// ---------------------------------------------------------------------------------------------
// Xe cộ và người (nhìn ngang thì đầu xe quay sang trái)
// ---------------------------------------------------------------------------------------------

const wheel = (x, y, r, c, bg) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="${bg}" stroke-width="2.5"/>`;

function carSide({ ink, bg }) {
  return (
    fl('M16 62V54Q16 48.5 21.5 47.5L31 45.5L39.5 35.5Q41.5 33.5 45.5 33.5H65Q69 33.5 71 36.5L77.5 45.5Q84 46.5 84 52V62Z', ink) +
    fl('M41 45.5L46 39H54.5V45.5Z', bg) +
    fl('M58.5 45.5V39H66.5L71 45.5Z', bg) +
    wheel(30, 63, 8, ink, bg) +
    wheel(70, 63, 8, ink, bg)
  );
}

/** Ô tô con nhìn từ phía sau, tâm (cx, cy), rộng 30·s. */
function carRear(cx, cy, s, c, bg) {
  return grp(
    `translate(${cx} ${cy}) scale(${s})`,
    fl('M-10.5 -4L-8 -15.5H8L10.5 -4Z', c) +
      fl('M-8 -5.5L-6.3 -13.2H6.3L8 -5.5Z', bg) +
      box(-15, -5, 30, 13, c, 3.5) +
      box(-12.5, -1.5, 5, 3, bg, 1) +
      box(7.5, -1.5, 5, 3, bg, 1) +
      box(-14, 7, 6, 6, c, 1.5) +
      box(8, 7, 6, 6, c, 1.5),
  );
}

/** Xe tải nhìn từ phía sau, tâm (cx, cy). */
function truckRear(cx, cy, s, c, bg) {
  return grp(
    `translate(${cx} ${cy}) scale(${s})`,
    box(-15, -26, 30, 30, c, 2) +
      box(-15, 5, 30, 5, c, 1) +
      box(-12, 6, 5, 2.5, bg) +
      box(7, 6, 5, 2.5, bg) +
      box(-14, 9, 7, 6, c, 1.5) +
      box(7, 9, 7, 6, c, 1.5),
  );
}

function truckSide({ ink, bg, value }, extra = '') {
  const label = value ? text(`${value}t`, 61.5, 43, 17, bg, 40) : '';
  return (
    box(37, 25, 49, 36, ink, 2) +
    fl('M14 63V47Q14 43 17 41L22 32Q24 30 27 30H35V63Z', ink) +
    fl('M19.5 44L24 35.5H31V44Z', bg) +
    box(14, 57, 72, 6, ink) +
    wheel(27, 65, 7.5, ink, bg) +
    wheel(64, 65, 7.5, ink, bg) +
    wheel(77, 65, 7.5, ink, bg) +
    label +
    extra
  );
}

function busSide({ ink, bg }) {
  let windows = '';
  for (const x of [30, 41.5, 53, 64.5]) windows += box(x, 36, 9, 11, bg, 1.5);
  return (
    box(12, 29, 76, 35, ink, 6) +
    box(16, 36, 10, 14, bg, 1.5) +
    windows +
    box(76, 36, 8, 11, bg, 1.5) +
    wheel(28, 65, 7.5, ink, bg) +
    wheel(72, 65, 7.5, ink, bg)
  );
}

function motoSide({ ink }, rider = true) {
  const body =
    ring(25, 66, 10, ink, 5) +
    ring(75, 66, 10, ink, 5) +
    fl('M38 51H62L70 61H45Z', ink) +
    ln('M25 66L35 43M29 41H39M62 55L75 66', ink, 5) +
    ln('M50 47H70', ink, 6);
  if (!rider) return body;
  return body + dot(57, 21, 7, ink) + ln('M58 30L62 46', ink, 9) + ln('M57 34L37 41', ink, 6) + ln('M62 46L50 53L53 64', ink, 7);
}

function bicycleSide({ ink }, dy = 0) {
  return grp(
    `translate(0 ${dy})`,
    ring(27, 62, 13, ink, 4.5) +
      ring(73, 62, 13, ink, 4.5) +
      ln('M73 62L49 62L57 39L73 62M49 62L35 40H57M35 40L27 62M35 40L34 33M29 33H39', ink, 4.5) +
      ln('M52 36H62', ink, 5),
  );
}

function pedestrian(c) {
  return dot(54, 17, 8, c) + ln('M52 29L47 55', c, 10) + ln('M51 33L39 47M51 33L63 44', c, 7) + ln('M47 55L37 80M47 55L58 67L60 81', c, 8);
}

/** Hai hình xếp dọc trên một biển (P.105, P.107…). */
const stack = (a, b) => grp(fit(0.58, 21, 2), a) + grp(fit(0.58, 21, 40), b);

/** Ô tô nhỏ ở góc dưới trái kèm một mũi tên (P.103b, P.124b…). */
const withCar = (k, arrowSvg) => grp(fit(0.42, 12, 48), carSide(k)) + grp(fit(0.66, 30, 6), arrowSvg);

// ---------------------------------------------------------------------------------------------
// Mũi tên chỉ hướng (dùng cho biển cấm rẽ và biển hiệu lệnh)
// ---------------------------------------------------------------------------------------------

const ARROWS = {
  'turn-left': (c) => arrow('M58 84V52Q58 38 44 38H38', 38, 38, -1, 0, c),
  'turn-right': (c) => arrow('M42 84V52Q42 38 56 38H62', 62, 38, 1, 0, c),
  straight: (c) => arrow('M50 84V40', 50, 40, 0, -1, c),
  uturn: (c) => arrow('M62 84V46A12 12 0 0 0 38 46V56', 38, 56, 0, 1, c),
  'left-uturn': (c) =>
    arrow('M62 84V38Q62 28 52 28H46', 46, 28, -1, 0, c, 9, 15, 10) +
    arrow('M62 60A11 11 0 0 0 40 60V62', 40, 62, 0, 1, c, 9, 15, 10),
  'right-uturn': (c) =>
    arrow('M56 84V40Q56 30 64 30H65', 65, 30, 1, 0, c, 9, 14, 10) +
    arrow('M56 62A11 11 0 0 0 34 62V64', 34, 64, 0, 1, c, 9, 15, 10),
  'left-right': (c) =>
    arrow('M50 84V48Q50 38 40 38H38', 38, 38, -1, 0, c) + arrow('M50 48Q50 38 60 38H62', 62, 38, 1, 0, c),
  'straight-left': (c) =>
    arrow('M57 84V40', 57, 40, 0, -1, c) + arrow('M57 72Q57 56 43 56H39', 39, 56, -1, 0, c),
  'straight-right': (c) =>
    arrow('M43 84V40', 43, 40, 0, -1, c) + arrow('M43 72Q43 56 57 56H61', 61, 56, 1, 0, c),
};

/** Ba mũi tên cong nối thành vòng, chạy ngược chiều kim đồng hồ. */
function roundabout(c) {
  const rad = Math.PI / 180;
  const r = 22;
  let out = '';
  for (let k = 0; k < 3; k++) {
    const t0 = (100 + 120 * k) * rad;
    const t1 = t0 + 72 * rad;
    const p = (t) => [r1(50 + r * Math.cos(t)), r1(50 - r * Math.sin(t))];
    const [x0, y0] = p(t0);
    const [x1, y1] = p(t1);
    out += arrow(`M${x0} ${y0}A${r} ${r} 0 0 0 ${x1} ${y1}`, x1, y1, -Math.sin(t1), -Math.cos(t1), c, 7.5, 13, 9);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hình vẽ bên trong biển. k = { ink, bg, value, art }; toạ độ trong khung 100×100, tâm (50, 50).
// ---------------------------------------------------------------------------------------------

const PICTS = {
  blank: () => '',
  speed: ({ ink, value }) => (value ? bigNumber(value, ink) : text('km/h', 50, 50, 22, ink)),
  car: (k) => carSide(k),
  'car-left': (k) => withCar(k, ARROWS['turn-left'](k.ink)),
  'car-right': (k) => withCar(k, ARROWS['turn-right'](k.ink)),
  'car-uturn': (k) => withCar(k, ARROWS.uturn(k.ink)),
  'car-left-uturn': (k) => withCar(k, ARROWS['left-uturn'](k.ink)),
  'car-right-uturn': (k) => withCar(k, ARROWS['right-uturn'](k.ink)),
  'car-moto': (k) => stack(carSide(k), motoSide(k)),
  moto: (k) => shrink(motoSide(k), 0.88),
  moped: (k) => motoSide(k, false),
  truck: (k) => shrink(truckSide(k), 0.9),
  'truck-danger': (k) => shrink(truckSide({ ...k, value: null }, fl('M61.5 31L71 43L61.5 55L52 43Z', k.bg)), 0.9),
  bus: (k) => shrink(busSide(k), 0.9),
  'bus-truck': (k) => stack(busSide(k), truckSide({ ...k, value: null })),
  taxi: (k) => carSide(k) + box(48, 25, 15, 7, k.ink, 1.5),
  trailer: (k) =>
    grp(fit(0.62, 0, 16), carSide(k)) + ln('M52 52H60', k.ink, 3) + box(59, 35, 27, 19, k.ink, 2) + wheel(72, 56, 5.5, k.ink, k.bg),
  semitrailer: ({ ink, bg }) =>
    shrink(
      fl('M12 64V48Q12 45 15 43L19 36Q20.5 34 23 34H31V64Z', ink) +
        fl('M16.5 46L20 38.5H27V46Z', bg) +
        box(33, 27, 55, 31, ink, 2) +
        box(12, 58, 76, 5, ink) +
        wheel(21, 66, 6.5, ink, bg) +
        wheel(67, 66, 6.5, ink, bg) +
        wheel(80, 66, 6.5, ink, bg),
      0.9,
    ),
  tractor: ({ ink, bg }) =>
    fl('M18 58V46H54V58Z', ink) +
    ln('M54 46V22H76V40', ink, 5) +
    box(56, 38, 14, 8, ink) +
    ln('M28 46V32', ink, 4) +
    dot(66, 61, 17, ink) +
    dot(66, 61, 6.5, bg) +
    dot(26, 68, 9.5, ink) +
    dot(26, 68, 3.5, bg),
  'farm-truck': ({ ink, bg }) =>
    shrink(
      box(12, 40, 22, 18, ink, 2) +
        ln('M34 44L44 32H52', ink, 4) +
        box(40, 44, 46, 14, ink, 1.5) +
        wheel(23, 64, 8, ink, bg) +
        wheel(70, 64, 9, ink, bg),
      0.86,
    ),
  bicycle: (k) => bicycleSide(k),
  'bicycle-load': (k) => grp('translate(50 52) scale(0.88) translate(-50 -50)', bicycleSide(k) + box(60, 30, 22, 15, k.ink, 2)),
  cyclist: (k) =>
    bicycleSide(k, 8) + dot(46, 14, 7, k.ink) + ln('M57 45L46 25', k.ink, 9) + ln('M47 28L36 41', k.ink, 6) + ln('M57 45L53 58L49 70', k.ink, 6),
  tricycle: ({ ink, bg }) =>
    shrink(
      fl('M12 58V38Q12 31 19 31H37V58Z', ink) +
        fl('M17 42V37H32V42Z', bg) +
        ring(24, 67, 9.5, ink, 4.5) +
        ring(75, 67, 9.5, ink, 4.5) +
        ln('M37 54H60L75 67M60 54L63 36M57 34H69', ink, 4.5),
      0.86,
    ),
  pedestrian: ({ ink }) => shrink(pedestrian(ink), 0.88),
  children: ({ ink }) => grp('translate(-15 1)', pedestrian(ink)) + grp(fit(0.72, 31, 22), pedestrian(ink)),
  crosswalk: ({ ink }) => {
    let z = '';
    for (const x of [16, 29, 42, 55, 68, 81]) z += box(x - 3.5, 74, 7, 12, ink, 1);
    return grp(fit(0.78, 11, 1), pedestrian(ink)) + z;
  },
  handcart: ({ ink, bg }) =>
    box(16, 46, 32, 15, ink, 2) +
    wheel(30, 66, 7.5, ink, bg) +
    ln('M48 49L57 43', ink, 4) +
    dot(66, 24, 7.5, ink) +
    ln('M65 34L68 57', ink, 9) +
    ln('M65 38L56 44', ink, 6) +
    ln('M68 57L61 79M68 57L75 68L76 79', ink, 7),
  cart: (k) =>
    grp(fit(0.5, 10, 21), PICTS.cattle(k)) + ln('M50 46H58', k.ink, 3.5) + box(57, 37, 25, 17, k.ink, 2) + wheel(69, 60, 8, k.ink, k.bg),
  weight: (k) => (k.value ? text(`${k.value}t`, 50, 50, 36, k.ink, 64) : grp(fit(0.8, 10, 10), truckSide(k))),
  axle: (k) =>
    grp(fit(0.68, 16, 2), truckSide({ ...k, value: null })) +
    arrow('M66 52V56', 66, 56, 0, 1, k.ink, 4, 9, 7) +
    (k.value ? text(`${k.value}t`, 50, 79, 21, k.ink, 46) : ''),
  height: ({ ink, value }) =>
    fl('M37 15H63L50 28Z', ink) +
    fl('M37 85H63L50 72Z', ink) +
    (value ? text(`${value}m`, 50, 50, 24, ink, 58) : ln('M50 35V65', ink, 4)),
  width: ({ ink, value }) =>
    fl('M15 37V63L28 50Z', ink) +
    fl('M85 37V63L72 50Z', ink) +
    (value ? text(`${value}m`, 50, 50, 22, ink, 40) : ln('M35 50H65', ink, 4)),
  length: (k) => lengthPict(k, truckSide({ ...k, value: null })),
  'length-trailer': (k) => lengthPict(k, PICTS.semitrailer(k)),
  gap: ({ ink, bg, value }) => {
    const k = { ink, bg };
    const y = value ? 54 : 62;
    return (
      grp(fit(0.4, 6, 18), carSide(k)) +
      grp(fit(0.4, 54, 18), carSide(k)) +
      ln(`M33 ${y}H67`, ink, 3.5) +
      head(33, y, -1, 0, ink, 9, 7) +
      head(67, y, 1, 0, ink, 9, 7) +
      (value ? text(`${value}m`, 50, 70, 17, ink, 44) : '')
    );
  },
  'turn-left': ({ ink }) => ARROWS['turn-left'](ink),
  'turn-right': ({ ink }) => ARROWS['turn-right'](ink),
  straight: ({ ink }) => ARROWS.straight(ink),
  uturn: ({ ink }) => ARROWS.uturn(ink),
  'left-uturn': ({ ink }) => ARROWS['left-uturn'](ink),
  'right-uturn': ({ ink }) => ARROWS['right-uturn'](ink),
  'left-right': ({ ink }) => ARROWS['left-right'](ink),
  'straight-left': ({ ink }) => ARROWS['straight-left'](ink),
  'straight-right': ({ ink }) => ARROWS['straight-right'](ink),
  overtake: ({ ink, bg, end }) => carRear(33, 52, 1.05, end ? ink : RED, bg) + carRear(67, 52, 1.05, ink, bg),
  'truck-overtake': ({ ink, bg }) => truckRear(33, 56, 1, RED, bg) + carRear(67, 58, 1, ink, bg),
  horn: ({ ink }) =>
    fl('M19 41H34L64 24V76L34 59H19Z', ink) + box(13, 44, 7, 12, ink, 1.5) + ln('M72 39Q77 50 72 61M79 34Q86 50 79 66', ink, 4),
  text: ({ ink, art }) => {
    const words = String(art?.text ?? '').slice(0, 24).split(' ').filter(Boolean);
    if (words.length < 2) return text(words[0] || '', 50, 50, 24, ink, 66);
    return text(words[0], 50, 36, 26, ink, 64) + text(words.slice(1).join(' '), 50, 64, 26, ink, 64);
  },
  'no-stopping': () => ln('M23 23L77 77M77 23L23 77', RED, 8.5, 'butt'),
  'no-parking': () => ln('M23 23L77 77', RED, 8.5),
  'no-parking-odd': () => ln('M23 23L77 77', RED, 8.5) + box(61, 22, 6, 21, WHITE),
  'no-parking-even': () => ln('M23 23L77 77', RED, 8.5) + box(56, 22, 6, 21, WHITE) + box(66, 22, 6, 21, WHITE),
  oncoming: ({ ink }) => arrow('M37 20V58', 37, 58, 0, 1, ink) + arrow('M63 80V42', 63, 42, 0, -1, RED),
  'curve-left': ({ ink }) => arrow('M62 86V64Q62 40 38 34', 38, 34, -24, -6, ink, 9, 17, 12),
  'curve-right': ({ ink }) => arrow('M38 86V64Q38 40 62 34', 62, 34, 24, -6, ink, 9, 17, 12),
  curves: ({ ink }) => arrow('M40 86C40 70 62 68 62 54C62 40 42 40 42 30', 42, 30, 0, -1, ink, 9, 17, 12),
  rollover: (k) => grp('rotate(-16 50 66)', truckSide({ ...k, value: null })),
  narrow: ({ ink }) => ln('M28 86V64L40 46V14M72 86V64L60 46V14', ink, 7),
  'two-way': ({ ink }) => arrow('M37 18V60', 37, 60, 0, 1, ink) + arrow('M63 82V40', 63, 40, 0, -1, ink),
  junction: ({ ink }) => box(43, 14, 14, 72, ink) + box(14, 43, 72, 14, ink),
  'side-road': ({ ink }) => box(42, 14, 16, 72, ink) + box(58, 45, 26, 10, ink),
  'two-way-junction': ({ ink }) =>
    arrow('M76 26H34', 34, 26, -1, 0, ink, 7, 13, 9) +
    arrow('M24 44H66', 66, 44, 1, 0, ink, 7, 13, 9) +
    arrow('M50 86V68', 50, 68, 0, -1, ink, 9, 14, 11),
  roundabout: ({ ink }) => roundabout(ink),
  signals: ({ ink }) =>
    box(37, 12, 26, 76, ink, 7) + dot(50, 26, 8.5, RED) + dot(50, 50, 8.5, YELLOW) + dot(50, 74, 8.5, LAMP_GREEN),
  'rail-barrier': ({ ink }) =>
    box(21, 30, 7, 50, ink) + box(46.5, 30, 7, 50, ink) + box(72, 30, 7, 50, ink) + box(13, 40, 74, 8, ink) + box(13, 58, 74, 8, ink),
  train: ({ ink, bg }) =>
    box(20, 40, 42, 21, ink, 5) +
    box(26, 27, 9, 14, ink, 1.5) +
    box(60, 26, 22, 35, ink, 2) +
    box(65.5, 31, 11, 10, bg, 1.5) +
    box(16, 60, 68, 6, ink) +
    fl('M17 60L9 70H21Z', ink) +
    wheel(32, 70, 7, ink, bg) +
    wheel(50, 70, 7, ink, bg) +
    wheel(70, 70, 7, ink, bg),
  bridge: ({ ink }) => ln('M24 86L38 70V30L24 14M76 86L62 70V30L76 14', ink, 7),
  piers: ({ ink }) =>
    box(12, 36, 76, 9, ink) +
    box(19, 45, 7, 30, ink) +
    box(46.5, 45, 7, 30, ink) +
    box(74, 45, 7, 30, ink) +
    ln('M12 83Q19 78 26 83T40 83T54 83T68 83T82 83T88 82', ink, 3.5),
  drawbridge: ({ ink }) => ln('M12 62H32L46 34M88 62H68L54 34', ink, 7) + ln('M12 78Q19 73 26 78T40 78T54 78T68 78T82 78T88 77', ink, 3.5),
  embankment: (k) =>
    fl('M12 58H56L64 86H12Z', k.ink) +
    grp(fit(0.46, 10, 18), carSide(k)) +
    ln('M68 70Q73 66 78 70T88 70M66 80Q71 76 76 80T86 80', k.ink, 3.5),
  ford: ({ ink }) => {
    let w = '';
    for (const y of [40, 50, 60]) w += `M14 ${y}Q21 ${y - 6} 28 ${y}T42 ${y}T56 ${y}T70 ${y}T84 ${y}`;
    return ln('M34 12V30M66 12V30M34 70V88M66 70V88', ink, 5) + ln(w, ink, 4);
  },
  ferry: (k) =>
    grp(fit(0.5, 25, 3), carSide(k)) + fl('M12 44H88L78 60H22Z', k.ink) + ln('M12 72Q19 67 26 72T40 72T54 72T68 72T82 72T88 71M18 82Q25 77 32 82T46 82T60 82T74 82T82 81', k.ink, 3.5),
  arch: ({ ink }) => fl('M16 86V32H84V86H66V58A16 16 0 0 0 34 58V86Z', ink),
  'slope-down': ({ ink }) => fl('M14 30L86 74V82H14Z', ink),
  'slope-up': ({ ink }) => fl('M14 74L86 30V82H14Z', ink),
  bumpy: ({ ink }) => fl('M12 82V66Q22 52 32 66Q42 78 50 66Q60 52 70 66Q78 76 88 66V82Z', ink),
  bump: ({ ink }) => fl('M12 82V70H33Q50 40 67 70H88V82Z', ink),
  slippery: ({ ink, bg }) => carRear(50, 30, 1.15, ink, bg) + ln('M41 50C30 60 54 70 41 86M59 50C70 60 46 70 59 86', ink, 4.5),
  'soft-verge': (k) => fl('M12 70H58L66 86H12Z', k.ink) + grp('rotate(16 60 60)', grp(fit(0.62, 18, 12), carSide(k))),
  cliff: ({ ink }) => fl('M88 86V14L76 18L70 32L74 44L64 56L68 70L58 86Z', ink) + ln('M18 86L32 22M42 86L48 22', ink, 3.5),
  crash: (k) =>
    grp(fit(0.6, 38, 30), carSide(k)) +
    grp('translate(62 30) scale(-0.6 0.6)', carSide(k)) +
    fl('M50 12L53.5 22L63 18L57 27L66 32L55 32L50 42L45 32L34 32L43 27L37 18L46.5 22Z', k.ink),
  obstacle: ({ ink }) =>
    box(38, 50, 24, 24, ink, 2) + arrow('M27 86V44', 27, 44, 0, -1, ink, 7, 13, 10) + arrow('M73 86V44', 73, 44, 0, -1, ink, 7, 13, 10),
  dual: ({ ink }) => box(22, 14, 20, 72, ink, 2) + box(58, 14, 20, 72, ink, 2),
  'dual-end': ({ ink }) => ln('M31 86V66L50 46V14M69 86V66L50 46', ink, 15),
  'hump-bridge': ({ ink }) => fl('M10 72Q50 24 90 72V82Q50 36 10 82Z', ink),
  expressway: ({ ink }) =>
    box(10, 28, 80, 10, ink, 1.5) +
    box(20, 38, 5, 8, ink) +
    box(75, 38, 5, 8, ink) +
    fl('M18 88L42 46H48L43 88Z', ink) +
    fl('M82 88L58 46H52L57 88Z', ink),
  'power-line': ({ ink }) =>
    ln('M22 86V24M78 86V24', ink, 5) +
    ln('M13 30H31M69 30H87', ink, 4) +
    ln('M16 32Q50 50 84 32M28 32Q50 44 72 32', ink, 2.5) +
    fl('M56 44L45 64H53L46 84L65 58H56L62 44Z', RED),
  tunnel: ({ ink }) =>
    fl('M12 86V52A38 38 0 0 1 88 52V86H72V55A22 22 0 0 0 28 55V86Z', ink) + ln('M39 86L46 62M61 86L54 62', ink, 3),
  jam: ({ ink, bg }) => carRear(50, 25, 0.68, ink, bg) + carRear(50, 47, 0.82, ink, bg) + carRear(50, 70, 0.96, ink, bg),
  plane: ({ ink }) =>
    grp(
      'rotate(40 50 50)',
      fl('M50 12Q55 12 55 22V76Q55 84 50 86Q45 84 45 76V22Q45 12 50 12Z', ink) +
        fl('M47 38L13 58V65L47 54ZM53 38L87 58V65L53 54Z', ink) +
        fl('M47 73L35 81V86L47 82ZM53 73L65 81V86L53 82Z', ink),
    ),
  works: ({ ink }) =>
    dot(35, 22, 7.5, ink) +
    ln('M37 32L43 56', ink, 9) +
    ln('M43 56L35 80M43 56L53 68L55 80', ink, 7) +
    ln('M38 36L55 47', ink, 6) +
    ln('M30 30L64 60', ink, 4.5) +
    fl('M60 56L74 62L70 74L58 67Z', ink) +
    fl('M60 86Q75 58 90 86Z', ink),
  rocks: ({ ink }) =>
    fl('M12 86V16L44 86Z', ink) +
    fl('M55 36l8-3 5 6-3 8-8 1-4-6z', ink) +
    fl('M66 54l7-2 4 6-3 7-7 0-3-6z', ink) +
    fl('M52 68l6-2 4 5-2 6-6 0-3-5z', ink) +
    fl('M72 74l6-2 4 5-2 6-6 0-3-5z', ink),
  cattle: ({ ink }) =>
    box(28, 34, 48, 24, ink, 9) +
    fl('M12 38Q12 31 19 31H31V50H22Q14 50 12 45Z', ink) +
    ln('M20 31L15 23', ink, 3.5) +
    box(32, 54, 6, 26, ink, 1.5) +
    box(41, 54, 6, 26, ink, 1.5) +
    box(62, 54, 6, 26, ink, 1.5) +
    box(70, 54, 6, 26, ink, 1.5) +
    ln('M76 39Q86 46 82 62', ink, 3),
  animal: ({ ink }) =>
    `<ellipse cx="55" cy="46" rx="21" ry="9.5" transform="rotate(-12 55 46)" fill="${ink}"/>` +
    ln('M39 44L30 28', ink, 9) +
    `<ellipse cx="25" cy="25" rx="8" ry="5.5" transform="rotate(-20 25 25)" fill="${ink}"/>` +
    ln('M30 21L28 10M29 15L22 12M33 21L38 11M36 15L42 13', ink, 3) +
    ln('M41 50L30 58L22 52M45 52L37 64L29 62M69 47L81 59L91 57M64 52L74 68L84 70', ink, 5) +
    ln('M75 39L81 33', ink, 4),
  wind: ({ ink }) =>
    ln('M22 86V16', ink, 5) +
    fl('M24 18L44 21V43L24 46Z', RED) +
    fl('M44 21L62 24V40L44 43Z', WHITE) +
    fl('M62 24L80 27V37L62 40Z', RED) +
    `<path d="M24 18L80 27V37L24 46Z" fill="none" stroke="${ink}" stroke-width="2.5" stroke-linejoin="round"/>`,
  exclaim: ({ ink }) => fl('M43 16H57L54 63H46Z', ink) + dot(50, 77, 7.5, ink),
  'arrow-up': ({ ink }) => arrow('M50 84V48', 50, 48, 0, -1, ink, 12, 26, 18),
  'keep-right': ({ ink }) => arrow('M30 30L57 57', 57, 57, 1, 1, ink, 12, 22, 16),
  'keep-left': ({ ink }) => arrow('M70 30L43 57', 43, 57, -1, 1, ink, 12, 22, 16),
  'keep-both': ({ ink }) =>
    arrow('M50 22V40L35 55', 35, 55, -1, 1, ink, 10, 18, 13) + arrow('M50 40L65 55', 65, 55, 1, 1, ink, 10, 18, 13),
  // Hình R.308 chưa đối chiếu được: vẽ mũi tên đi qua phía trên một con đường cắt ngang.
  loop: ({ ink, bg }) =>
    ln('M14 44H86M14 60H86', ink, 4) + ln('M50 86V48', bg, 22, 'butt') + arrow('M50 84V44', 50, 44, 0, -1, ink, 12, 22, 16),
  'hazmat-arrow': ({ ink }) =>
    arrow('M54 84V48', 54, 48, 0, -1, ink, 12, 24, 17) +
    `<path d="M27 56L36 65L27 74L18 65Z" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linejoin="round"/>`,
  lanes: ({ ink }) => ln('M22 14V86M78 14V86', ink, 4) + ln('M50 16V86', ink, 4, 'butt', '10 8'),
  'lane-arrows': ({ ink }) =>
    ln('M37 16V84M63 16V84', ink, 3) +
    arrow('M27 82V54Q27 46 21 46H20', 20, 46, -1, 0, ink, 6, 11, 8) +
    arrow('M50 82V42', 50, 42, 0, -1, ink, 6, 12, 8) +
    arrow('M73 82V54Q73 46 79 46H80', 80, 46, 1, 0, ink, 6, 11, 8),
  'dead-end': ({ ink }) => box(43, 36, 14, 50, ink) + box(24, 21, 52, 13, RED, 1),
  'oneway-up': ({ ink }) => arrow('M50 86V50', 50, 50, 0, -1, ink, 14, 30, 22),
  'oneway-left': ({ ink }) => arrow('M86 50H50', 50, 50, -1, 0, ink, 14, 30, 22),
  'oneway-right': ({ ink }) => arrow('M14 50H50', 50, 50, 1, 0, ink, 14, 30, 22),
  'crosswalk-info': () => {
    let z = '';
    for (const x of [27, 38, 49, 60, 71]) z += box(x, 73, 6, 7, INK);
    return fl('M50 11L91 85H9Z', WHITE) + grp(fit(0.52, 25, 30), pedestrian(INK)) + z;
  },
  footbridge: ({ ink }) =>
    box(10, 56, 80, 6, ink) + ln('M22 62V86M78 62V86', ink, 5) + ln('M14 44H86', ink, 3) + grp(fit(0.44, 27, 20.4), pedestrian(ink)),
  houses: ({ ink, bg }) =>
    fl('M13 72V52L26 40L39 52V72Z', ink) +
    fl('M38 72V46L55 31L72 46V72Z', ink) +
    box(74, 38, 12, 34, ink) +
    fl('M74 38L80 26L86 38Z', ink) +
    box(22, 56, 8, 8, bg) +
    box(50, 50, 10, 10, bg) +
    box(77, 46, 6, 8, bg) +
    box(10, 72, 80, 3, ink),
};

function lengthPict(k, vehicle) {
  const y = k.value ? 53 : 62;
  return (
    grp(fit(0.6, 20, 2), vehicle) +
    ln(`M26 ${y}H74`, k.ink, 3.5) +
    head(26, y, -1, 0, k.ink, 9, 7) +
    head(74, y, 1, 0, k.ink, 9, 7) +
    (k.value ? text(`${k.value}m`, 50, 70, 17, k.ink, 44) : '')
  );
}

/** Danh sách tên hình vẽ có sẵn (để kiểm thử danh mục). */
export const PICTOGRAMS = Object.freeze(Object.keys(PICTS));

function pict(art, k) {
  const name = art.pict === '!' ? 'exclaim' : art.pict;
  const fn = Object.hasOwn(PICTS, name) ? PICTS[name] : PICTS.exclaim;
  const svg = fn({ ...k, art });
  return art.flip ? grp('matrix(-1 0 0 1 100 0)', svg) : svg;
}

// ---------------------------------------------------------------------------------------------
// Hình dạng biển
// ---------------------------------------------------------------------------------------------

const DANGER_BOX = 'translate(50 61) scale(0.6) translate(-50 -50)';
const redSlash = (d = 'M22 22L78 78', w = 8.5) => ln(d, RED, w, 'butt');

function octagon(r) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = ((22.5 + 45 * i) * Math.PI) / 180;
    pts.push(`${r1(50 + r * Math.cos(a))} ${r1(50 + r * Math.sin(a))}`);
  }
  return `M${pts.join('L')}Z`;
}

const SHAPES = {
  prohibit: (art, k) =>
    dot(50, 50, 48.5, WHITE) +
    ring(50, 50, 48.5, EDGE, 1) +
    pict(art, { ink: INK, bg: WHITE, value: k.value }) +
    (art.slash ? redSlash() : '') +
    ring(50, 50, 42.5, RED, 9),
  'prohibit-blue': (art, k) =>
    dot(50, 50, 48.5, WHITE) +
    ring(50, 50, 48.5, EDGE, 1) +
    dot(50, 50, 40, BLUE) +
    pict(art, { ink: WHITE, bg: BLUE, value: k.value }) +
    (art.slash ? redSlash() : '') +
    ring(50, 50, 42.5, RED, 9),
  noentry: () => dot(50, 50, 48.5, RED) + ring(50, 50, 48.5, WHITE, 1.5) + box(17, 41, 66, 18, WHITE, 2),
  end: (art, k) =>
    dot(50, 50, 48.5, WHITE) +
    ring(50, 50, 47, '#5f666e', 2) +
    pict(art, { ink: GREY, bg: WHITE, value: k.value, end: true }) +
    endBand(50, 50, 44),
  danger: (art, k) =>
    `<path d="M50 7L95 85H5Z" fill="${YELLOW}" stroke="${WHITE}" stroke-width="13" stroke-linejoin="round"/>` +
    `<path d="M50 7L95 85H5Z" fill="${YELLOW}" stroke="${RED}" stroke-width="8.5" stroke-linejoin="round"/>` +
    grp(DANGER_BOX, pict(art, { ink: INK, bg: YELLOW, value: k.value })),
  giveway: () =>
    `<path d="M5 14H95L50 92Z" fill="${YELLOW}" stroke="${WHITE}" stroke-width="13" stroke-linejoin="round"/>` +
    `<path d="M5 14H95L50 92Z" fill="${YELLOW}" stroke="${RED}" stroke-width="8.5" stroke-linejoin="round"/>`,
  stop: () =>
    fl(octagon(49), WHITE) +
    fl(octagon(47.5), RED) +
    `<path d="${octagon(43)}" fill="none" stroke="${WHITE}" stroke-width="2.5"/>` +
    text('STOP', 50, 50, 26, WHITE, 70),
  mandatory: (art, k) =>
    dot(50, 50, 48.5, WHITE) +
    ring(50, 50, 48.5, EDGE, 1) +
    dot(50, 50, 46, BLUE) +
    pict(art, { ink: WHITE, bg: BLUE, value: k.value }) +
    (art.slash ? redSlash('M20 20L80 80') : ''),
  info: (art, k) =>
    `<rect x="2.5" y="2.5" width="95" height="95" rx="10" fill="${WHITE}" stroke="${EDGE}" stroke-width="1"/>` +
    box(6, 6, 88, 88, BLUE, 7) +
    pict(art, { ink: WHITE, bg: BLUE, value: k.value }) +
    (art.slash ? redSlash('M12 12L88 88', 8) : ''),
  zone: (art, k) =>
    `<rect x="1" y="14" width="98" height="72" rx="7" fill="${WHITE}" stroke="${EDGE}" stroke-width="1"/>` +
    box(4.5, 17.5, 91, 65, BLUE, 5) +
    pict(art, { ink: WHITE, bg: BLUE, value: k.value }) +
    (art.slash ? redSlash('M8 22L92 78', 7) : ''),
  priority: (art) =>
    `<path d="M50 2L98 50L50 98L2 50Z" fill="${WHITE}" stroke="#5f666e" stroke-width="1.5" stroke-linejoin="round"/>` +
    fl('M50 17L83 50L50 83L17 50Z', YELLOW) +
    (art.slash ? diamondBand(33) : ''),
  expressway: (art, k) =>
    `<rect x="1" y="8" width="98" height="84" rx="8" fill="${WHITE}" stroke="${EDGE}" stroke-width="1"/>` +
    box(4.5, 11.5, 91, 77, GREEN, 6) +
    grp('translate(50 50) scale(0.86) translate(-50 -50)', pict(art, { ink: WHITE, bg: GREEN, value: k.value })) +
    (art.slash ? redSlash('M10 18L90 82', 7) : ''),
  cross: () => {
    const board = `<rect x="4" y="40" width="92" height="20" rx="2" fill="${WHITE}" stroke="${RED}" stroke-width="5"/>`;
    return grp('rotate(35 50 50)', board) + grp('rotate(-35 50 50)', board);
  },
  post: (art) => {
    const n = Math.max(1, Math.min(3, Number(art.stripes) || 1));
    let stripes = '';
    for (let i = 0; i < n; i++) {
      const y = 76 - i * 24;
      stripes += fl(`M29 ${y + 6}L71 ${y - 10}V${y}L29 ${y + 16}Z`, RED);
    }
    return `<rect x="28" y="3" width="44" height="94" rx="3" fill="${WHITE}" stroke="${EDGE}" stroke-width="1.5"/>` + stripes;
  },
};

/** Danh sách hình dạng biển có sẵn. */
export const SIGN_SHAPES = Object.freeze(Object.keys(SHAPES));

// ---------------------------------------------------------------------------------------------
// Giao diện công khai
// ---------------------------------------------------------------------------------------------

/** Lọc trị số in trên biển: chỉ nhận 1–3 chữ số, có thể thêm một chữ số thập phân ("3,5"). */
function cleanValue(value) {
  if (value == null) return null;
  let s;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '';
  else s = String(value).trim();
  if (!/^[0-9]{1,3}([.,][0-9])?$/.test(s)) return null;
  return s.replace('.', ',');
}

/**
 * SVG độc lập của một biển. art = { shape, pict, slash?, text?, flip?, stripes? } (từ signs.js).
 * value: trị số in trên biển (tốc độ, chiều cao…), bị bỏ nếu không đúng dạng số.
 */
export function signSvg(art, { size = 48, value = null, title = '' } = {}) {
  const a = art && typeof art === 'object' ? art : {};
  const shape = Object.hasOwn(SHAPES, a.shape) ? a.shape : 'danger';
  const art2 = Object.hasOwn(SHAPES, a.shape) ? a : { ...a, pict: a.pict || 'exclaim' };
  const px = Math.max(8, Math.min(512, Math.round(Number(size) || 48)));
  const label = String(title ?? '').slice(0, 200);
  const a11y = label ? ` role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>` : ' aria-hidden="true">';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}"${a11y}` +
    `${SHAPES[shape](art2, { value: cleanValue(value) })}</svg>`
  );
}

/** Như signSvg nhưng trả về data URL (dùng cho <img src> hoặc ảnh trên bản đồ). */
export function signDataUrl(art, opts) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(signSvg(art, opts))}`;
}
