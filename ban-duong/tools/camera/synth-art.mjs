// Hình vẽ phụ cho dữ liệu tổng hợp (SVG, chỉ dùng khi huấn luyện, không dùng trong ứng dụng):
//  - "other-sign": biển không có trong danh mục (vòng tròn hay chữ nhật có chữ/ký hiệu ngẫu nhiên, hình lạ);
//  - biển phụ (tấm trắng viền đen có chữ, khoảng cách, giờ, mũi tên) đặt dưới biển chính;
//  - vật gây nhiễu: cột chắn sọc đỏ trắng, thùng cảnh báo vàng đen, biển hiệu cửa hàng có chữ tiếng Việt,
//    mảng màu đỏ/xanh/vàng, mặt sau của biển.
// Mỗi hàm nhận rnd() trong [0, 1) và trả về { svg, w, h, family } (w/h theo đơn vị viewBox; family là họ
// của bộ dò nếu vật này nên được dò thấy như một biển, null nếu là vật gây nhiễu).

import { P127_VALUES } from './lib.mjs';

const FONT = 'font-family="DejaVu Sans,Arial,Helvetica,sans-serif" font-weight="700"';
const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const U = (rnd, a, b) => a + (b - a) * rnd();
const wrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}">${body}</svg>`;
const text = (s, x, y, size, fill, maxW) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${FONT} fill="${fill}" text-anchor="middle" dominant-baseline="central"` +
  `${maxW ? ` textLength="${maxW}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(s)}</text>`;

const RED = '#d5202a';
const BLUE = '#0a57a4';
const GREEN = '#0b7a45';
const YELLOW = '#ffd21f';
const BROWN = '#7a4a22';

// Số trên vòng đỏ của "other-sign": không trùng trị số P.127[n] (bội số của 10 trong 20–120).
export const OTHER_NUMBERS = Object.freeze(['5', '15', '25', '35', '45', '55', '65', '75', '85', '95', '3', '7', '130', '8', '12']);
const LETTERS = 'ABCDEFGHKLMNPRSTUVXYZ';
export const GLYPHS = Object.freeze(['star', 'square', 'circle', 'cross', 'bars', 'hook', 'zigzag', 'triangle']);
// Ký hiệu không dùng cho "other-sign" trên từng loại nền vì gần giống hình của một mã trong danh mục (gắn nhãn
// other-sign cho chúng là dạy sai): tam giác — chữ thập ≈ W.205 (đường giao nhau), móc ≈ W.201a/b (chỗ ngoặt),
// gấp khúc ≈ W.202a/b (chỗ ngoặt liên tiếp), vòng ≈ W.206 (vòng xuyến); vòng đỏ — móc ≈ mũi tên rẽ, quay đầu của
// P.123*, P.124*; đĩa xanh — móc ≈ R.302a/b và mũi tên rẽ, vòng ≈ R.303 (vòng xuyến).
export const GLYPH_AVOID = Object.freeze({
  triangle: Object.freeze(['cross', 'hook', 'zigzag', 'circle']),
  ring: Object.freeze(['hook']),
  bluedisc: Object.freeze(['hook', 'circle']),
});
const glyphsFor = (carrier) => GLYPHS.filter((g) => !(GLYPH_AVOID[carrier] || []).includes(g));

const PLACE_WORDS = ['Lê Lợi', 'Trần Hưng Đạo', 'Nguyễn Huệ', 'Phường 3', 'Hà Nội', 'Đà Nẵng', 'Cần Thơ', 'Huế', 'Vũng Tàu',
  'Bến Thành', 'Hải Phòng', 'Quy Nhơn', 'Biên Hoà', 'Thủ Đức', 'Long Biên', 'Cầu Giấy', 'Nha Trang', 'Đồng Nai'];
const SHOP_WORDS = ['Phở bò', 'Bánh mì', 'Cơm tấm', 'Tạp hoá', 'Sửa xe', 'Nhà thuốc', 'Karaoke', 'Điện thoại', 'Cà phê',
  'Vật liệu xây dựng', 'Nhà nghỉ', 'Gội đầu', 'Thời trang', 'Rửa xe', 'Bún chả', 'Điện máy', 'Ngân hàng', 'Hiệu vàng'];
const PLATE_WORDS = ['Trừ xe buýt', 'Trừ xe máy', 'Xe tải', 'Ô tô con', 'Trường học', 'Đoạn đường', 'Hướng đi',
  'Trừ xe ưu tiên', 'Khu dân cư', 'Cấm đỗ', 'Làn xe buýt', 'Xe khách'];

function glyph(kind, cx, cy, r, fill) {
  switch (kind) {
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`);
      }
      return `<path d="M${pts.join('L')}Z" fill="${fill}"/>`;
    }
    case 'square':
      return `<rect x="${cx - r * 0.7}" y="${cy - r * 0.7}" width="${r * 1.4}" height="${r * 1.4}" fill="${fill}"/>`;
    case 'circle':
      return `<circle cx="${cx}" cy="${cy}" r="${r * 0.65}" fill="none" stroke="${fill}" stroke-width="${r * 0.3}"/>`;
    case 'cross':
      return `<path d="M${cx - r} ${cy}H${cx + r}M${cx} ${cy - r}V${cy + r}" stroke="${fill}" stroke-width="${r * 0.35}"/>`;
    case 'bars':
      return [0, 1, 2].map((i) => `<rect x="${cx - r}" y="${cy - r + i * r * 0.75}" width="${2 * r}" height="${r * 0.4}" fill="${fill}"/>`).join('');
    case 'hook':
      return `<path d="M${cx - r * 0.6} ${cy - r}V${cy + r * 0.3}Q${cx - r * 0.6} ${cy + r} ${cx + r * 0.2} ${cy + r}H${cx + r * 0.7}" fill="none" stroke="${fill}" stroke-width="${r * 0.3}"/>`;
    case 'zigzag':
      return `<path d="M${cx - r} ${cy + r * 0.6}L${cx - r * 0.4} ${cy - r * 0.6}L${cx + r * 0.2} ${cy + r * 0.6}L${cx + r * 0.8} ${cy - r * 0.6}" fill="none" stroke="${fill}" stroke-width="${r * 0.25}"/>`;
    default:
      return `<path d="M${cx} ${cy - r}L${cx + r} ${cy + r * 0.8}H${cx - r}Z" fill="${fill}"/>`;
  }
}

/** Nội dung giữa biển: số (không thuộc P.127), 1–3 chữ cái hoặc ký hiệu được phép trên nền carrier. */
function inner(rnd, fill, carrier) {
  const k = rnd();
  if (k < 0.35) return { svg: text(pick(rnd, OTHER_NUMBERS), 50, 52, 38, fill), glyph: null };
  if (k < 0.6) {
    const n = 1 + Math.floor(rnd() * 3);
    let s = '';
    for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rnd() * LETTERS.length)];
    return { svg: text(s, 50, 52, n === 1 ? 46 : 30, fill, n > 2 ? 56 : 0), glyph: null };
  }
  const g = pick(rnd, glyphsFor(carrier));
  return { svg: glyph(g, 50, 50, 22, fill), glyph: g };
}

/**
 * Biển không có trong danh mục, đủ giống biển để bộ dò thấy và bộ phân loại phải học từ chối.
 * Trả thêm glyph: tên ký hiệu ở giữa biển (null nếu là số, chữ hoặc không có).
 */
export function otherSignSvg(rnd) {
  const k = Math.floor(rnd() * 9);
  if (k === 0) {
    // vòng đỏ với số/chữ/ký hiệu lạ
    const c = inner(rnd, '#1a1a1a', 'ring');
    const body = `<circle cx="50" cy="50" r="48" fill="#fff"/>${c.svg}<circle cx="50" cy="50" r="42.5" fill="none" stroke="${RED}" stroke-width="9"/>`;
    return { svg: wrap(100, 100, body), w: 100, h: 100, family: 'ring', glyph: c.glyph };
  }
  if (k === 1) {
    // đĩa xanh với ký hiệu lạ
    const c = inner(rnd, '#fff', 'bluedisc');
    const body = `<circle cx="50" cy="50" r="48" fill="#fff"/><circle cx="50" cy="50" r="46" fill="${BLUE}"/>${c.svg}`;
    return { svg: wrap(100, 100, body), w: 100, h: 100, family: 'bluedisc', glyph: c.glyph };
  }
  if (k === 2 || k === 3) {
    // bảng chữ nhật chỉ đường / tên đường
    const bg = pick(rnd, [BLUE, BLUE, GREEN, BROWN, '#ffffff']);
    const fg = bg === '#ffffff' ? '#1a1a1a' : '#ffffff';
    const lines = 1 + Math.floor(rnd() * 3);
    const w = Math.round(U(rnd, 140, 260));
    const h = 26 + lines * 30;
    let body = `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="8" fill="${fg}"/><rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="6" fill="${bg}"/>`;
    for (let i = 0; i < lines; i++) {
      const word = pick(rnd, PLACE_WORDS) + (rnd() < 0.4 ? ` ${Math.round(U(rnd, 1, 180))} km` : '');
      body += text(word, w / 2, 28 + i * 30, 22, fg, Math.min(w - 24, word.length * 13));
    }
    return { svg: wrap(w, h, body), w, h, family: bg === '#ffffff' ? 'plate' : 'bluerect', glyph: null };
  }
  if (k === 4) {
    // hình thoi vàng viền đen có ký hiệu (kiểu biển nước ngoài; khác I.401 viền trắng không ký hiệu)
    const g = pick(rnd, GLYPHS);
    const body = `<path d="M50 2L98 50L50 98L2 50Z" fill="${YELLOW}" stroke="#1a1a1a" stroke-width="5"/>${glyph(g, 50, 50, 20, '#1a1a1a')}`;
    return { svg: wrap(100, 100, body), w: 100, h: 100, family: 'diamond', glyph: g };
  }
  if (k === 5) {
    // tam giác cảnh báo với ký hiệu không có trong danh mục
    const fill = pick(rnd, [YELLOW, '#ffffff']);
    const c = inner(rnd, '#1a1a1a', 'triangle');
    const body =
      `<path d="M50 7L95 85H5Z" fill="${fill}" stroke="${RED}" stroke-width="8.5" stroke-linejoin="round"/>` +
      `<g transform="translate(50 61) scale(0.55) translate(-50 -50)">${c.svg}</g>`;
    return { svg: wrap(100, 100, body), w: 100, h: 100, family: 'triangle', glyph: c.glyph };
  }
  if (k === 6) {
    // ngũ giác, hình tròn viền xanh lá, bát giác xanh: hình lạ (không giống mã nào, mọi ký hiệu đều được)
    const shape = pick(rnd, ['penta', 'greenring', 'blueoct']);
    let body;
    let g = null;
    if (shape === 'penta') {
      const fill = pick(rnd, [YELLOW, '#c8e64b', BLUE]);
      g = pick(rnd, GLYPHS);
      body = `<path d="M50 3L96 38L96 97H4V38Z" fill="${fill}" stroke="#1a1a1a" stroke-width="4"/>${glyph(g, 50, 62, 20, '#1a1a1a')}`;
    } else if (shape === 'greenring') {
      const c = inner(rnd, '#1a1a1a', null);
      g = c.glyph;
      body = `<circle cx="50" cy="50" r="48" fill="#fff"/>${c.svg}<circle cx="50" cy="50" r="42.5" fill="none" stroke="${GREEN}" stroke-width="9"/>`;
    } else {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = ((22.5 + 45 * i) * Math.PI) / 180;
        pts.push(`${(50 + 48 * Math.cos(a)).toFixed(1)} ${(50 + 48 * Math.sin(a)).toFixed(1)}`);
      }
      const c = inner(rnd, '#fff', null);
      g = c.glyph;
      body = `<path d="M${pts.join('L')}Z" fill="${BLUE}"/>${c.svg}`;
    }
    return { svg: wrap(100, 100, body), w: 100, h: 100, family: null, glyph: g };
  }
  if (k === 7) {
    // biển tốc độ khuyến cáo kiểu nước ngoài: chữ nhật trắng có số và chữ
    const n = pick(rnd, [...OTHER_NUMBERS, ...P127_VALUES]);
    const word = pick(rnd, ['SPEED', 'LIMIT', 'MAX', 'ZONE', 'km/h']); // chữ in trên biển nước ngoài (hình vẽ)
    const body = `<rect x="2" y="2" width="76" height="96" rx="6" fill="#fff" stroke="#1a1a1a" stroke-width="4"/>${text(word, 40, 24, 14, '#1a1a1a')}${text(n, 40, 62, 36, '#1a1a1a')}`;
    return { svg: wrap(80, 100, body), w: 80, h: 100, family: 'plate', glyph: null };
  }
  // vòng đỏ nền xanh/ vàng có ký hiệu lạ
  const fill = pick(rnd, [YELLOW, '#9fd3f5']);
  const c = inner(rnd, '#1a1a1a', 'ring');
  const body = `<circle cx="50" cy="50" r="48" fill="${fill}"/>${c.svg}<circle cx="50" cy="50" r="42.5" fill="none" stroke="${RED}" stroke-width="9"/>`;
  return { svg: wrap(100, 100, body), w: 100, h: 100, family: 'ring', glyph: c.glyph };
}

/** Biển phụ dưới biển chính: tấm trắng viền đen (đôi khi có mũi tên). Tỉ lệ cao/rộng 0,3–0,7. */
export function plateSvg(rnd) {
  const w = 100;
  const h = Math.round(U(rnd, 30, 70));
  const k = rnd();
  let content;
  if (k < 0.3) content = text(`${pick(rnd, ['50', '100', '150', '200', '300', '500'])} m`, 50, h / 2, Math.min(28, h * 0.55), '#1a1a1a');
  else if (k < 0.5) {
    const a = Math.round(U(rnd, 5, 9));
    const b = Math.round(U(rnd, 16, 22));
    content = text(`${a}h - ${b}h`, 50, h / 2, Math.min(26, h * 0.5), '#1a1a1a', 80);
  } else if (k < 0.8) {
    const s = pick(rnd, PLATE_WORDS);
    content = text(s, 50, h / 2, Math.min(18, h * 0.42), '#1a1a1a', Math.min(86, s.length * 9));
  } else {
    const dir = pick(rnd, [-1, 1]);
    const y = h / 2;
    content =
      `<path d="M${50 - 30 * dir} ${y}H${50 + 22 * dir}" stroke="#1a1a1a" stroke-width="${Math.max(4, h * 0.12)}"/>` +
      `<path d="M${50 + 34 * dir} ${y}L${50 + 18 * dir} ${y - h * 0.25}V${y + h * 0.25}Z" fill="#1a1a1a"/>`;
  }
  const body = `<rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="3" fill="#fff" stroke="#1a1a1a" stroke-width="3"/>${content}`;
  return { svg: wrap(w, h, body), w, h, family: 'plate' };
}

/** Vật gây nhiễu (không gắn nhãn): cột sọc, thùng cảnh báo, biển hiệu cửa hàng, mảng màu, mặt sau biển. */
export function distractorSvg(rnd) {
  const k = Math.floor(rnd() * 6);
  if (k === 0) {
    // cột chắn sọc đỏ trắng
    const w = 24;
    const h = Math.round(U(rnd, 60, 110));
    const band = Math.round(U(rnd, 8, 16));
    let body = `<rect x="0" y="0" width="${w}" height="${h}" rx="4" fill="#fff"/>`;
    for (let y = 0; y < h; y += 2 * band) body += `<rect x="0" y="${y}" width="${w}" height="${band}" fill="${RED}"/>`;
    return { svg: wrap(w, h, body), w, h, family: null, kind: 'bollard' };
  }
  if (k === 1) {
    // thùng cảnh báo vàng đen
    const w = 60;
    const h = 80;
    let body = `<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="${YELLOW}"/>`;
    for (let i = -2; i < 8; i++) body += `<path d="M${i * 16} ${h}L${i * 16 + 30} 0H${i * 16 + 38}L${i * 16 + 8} ${h}Z" fill="#111"/>`;
    return { svg: wrap(w, h, `<clipPath id="c"><rect width="${w}" height="${h}" rx="10"/></clipPath><g clip-path="url(#c)">${body}</g>`), w, h, family: null, kind: 'drum' };
  }
  if (k === 2 || k === 3) {
    // biển hiệu cửa hàng
    const bg = pick(rnd, [RED, BLUE, YELLOW, GREEN, '#ffffff', '#f28c00']);
    const fg = bg === YELLOW || bg === '#ffffff' ? pick(rnd, [RED, BLUE, '#1a1a1a']) : pick(rnd, ['#ffffff', YELLOW]);
    const w = Math.round(U(rnd, 160, 320));
    const h = Math.round(U(rnd, 50, 90));
    const word = pick(rnd, SHOP_WORDS);
    const body =
      `<rect x="0" y="0" width="${w}" height="${h}" fill="${bg}"/>` +
      text(word, w / 2, h * 0.45, h * 0.42, fg, Math.min(w - 20, word.length * h * 0.3)) +
      (rnd() < 0.6 ? text(`ĐT ${Math.floor(U(rnd, 1e8, 1e9))}`, w / 2, h * 0.82, h * 0.18, fg) : '');
    return { svg: wrap(w, h, body), w, h, family: null, kind: 'shop' };
  }
  if (k === 4) {
    // mảng màu không đều
    const c = pick(rnd, [RED, BLUE, YELLOW, '#e0e0e0']);
    const pts = [];
    const n = 5 + Math.floor(rnd() * 5);
    const ax = U(rnd, 0.5, 1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = U(rnd, 25, 48);
      pts.push(`${(50 + r * Math.cos(a)).toFixed(1)} ${(50 + r * ax * Math.sin(a)).toFixed(1)}`);
    }
    return { svg: wrap(100, 100, `<path d="M${pts.join('L')}Z" fill="${c}"/>`), w: 100, h: 100, family: null, kind: 'blob' };
  }
  return backOfSignSvg(rnd);
}

/** Mặt sau của biển (xe đi ngược chiều thấy): tấm kim loại xám có đai kẹp. */
export function backOfSignSvg(rnd) {
  const shape = pick(rnd, ['disc', 'triangle', 'octagon', 'rect', 'diamond']);
  const grey = `hsl(210,${Math.round(U(rnd, 0, 10))}%,${Math.round(U(rnd, 45, 75))}%)`;
  const rim = `hsl(210,5%,${Math.round(U(rnd, 25, 45))}%)`;
  let d;
  if (shape === 'disc') d = 'M50 2A48 48 0 1 1 49.9 2Z';
  else if (shape === 'triangle') d = 'M50 5L96 88H4Z';
  else if (shape === 'diamond') d = 'M50 2L98 50L50 98L2 50Z';
  else if (shape === 'rect') d = 'M4 14H96V86H4Z';
  else {
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = ((22.5 + 45 * i) * Math.PI) / 180;
      pts.push(`${(50 + 48 * Math.cos(a)).toFixed(1)} ${(50 + 48 * Math.sin(a)).toFixed(1)}`);
    }
    d = `M${pts.join('L')}Z`;
  }
  const body =
    `<path d="${d}" fill="${grey}" stroke="${rim}" stroke-width="3"/>` +
    `<rect x="44" y="4" width="12" height="92" fill="${rim}" opacity="0.8"/>` +
    `<rect x="30" y="30" width="40" height="6" fill="${rim}"/><rect x="30" y="64" width="40" height="6" fill="${rim}"/>`;
  return { svg: wrap(100, 100, body), w: 100, h: 100, family: null, kind: 'back' };
}

export const toDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
