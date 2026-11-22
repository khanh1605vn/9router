// Bộ biểu tượng tự vẽ (SVG 24×24) dùng chung cho giao diện và cho ký hiệu trên bản đồ.

/** Hình sao nổ nhiều cánh (biểu tượng va chạm). */
function burst(cx, cy, outer, inner, spikes) {
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d}z`;
}

// Biểu tượng tô đặc (fill-rule: evenodd), dùng cho điểm cảnh báo.
export const GLYPHS = {
  camera:
    'M4 7h10a1 1 0 0 1 1 1v1.6l5-2.6v8l-5-2.6V14a1 1 0 0 1-1 1h-3.5v3H13v2H5v-2h2.5v-3H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
  toll: 'M3 20V9.5L7 6l4 3.5V20H9v-5H5v5H3zM13 10.5h8v2.4h-2V20h-1.8v-7.1H13v-2.4z',
  rail:
    'M7 3h2v18H7zM15 3h2v18h-2zM4 6h3v2H4zM9 6h6v2H9zM17 6h3v2h-3zM4 11h3v2H4zM9 11h6v2H9zM17 11h3v2h-3z' +
    'M4 16h3v2H4zM9 16h6v2H9zM17 16h3v2h-3z',
  school: 'M12 4 2 9l10 5 8-4v6h2V9L12 4zM6 13.2V17c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.8l-6 3-6-3z',
  hazard: 'M10.6 4h2.8l-.6 10h-1.6L10.6 4zM12 16.2a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z',
  works: 'M10.6 3h2.8l1.2 4.5H9.4L10.6 3zM8.7 10h6.6l1.2 4.5h-9L8.7 10zM6.8 17h10.4l.8 2H21v2H3v-2h3l.8-2z',
  flood:
    'M12 3c1.6 2 2.6 3.4 2.6 4.6a2.6 2.6 0 0 1-5.2 0C9.4 6.4 10.4 5 12 3z' +
    'M2 13l3.3-2 3.4 2 3.3-2 3.3 2 3.4-2L22 13v2.4l-3.3-2-3.4 2-3.3-2-3.3 2-3.4-2L2 15.4V13z' +
    'M2 18l3.3-2 3.4 2 3.3-2 3.3 2 3.4-2L22 18v2.4l-3.3-2-3.4 2-3.3-2-3.3 2-3.4-2L2 20.4V18z',
  jam:
    'M6.5 6h11l2 5.2c.9.3 1.5 1.1 1.5 2.1V18h-2.2v1.5h-2.3V18h-9v1.5H5.2V18H3v-4.7c0-1 .6-1.8 1.5-2.1L6.5 6z' +
    'M7.9 8l-1.2 3h10.6l-1.2-3H7.9zM6.5 13.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z' +
    'M17.5 13.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z',
  crash: burst(12, 12, 10, 5.2, 8),
};

// Màu nền huy hiệu của từng loại điểm trên bản đồ.
export const GLYPH_COLORS = {
  camera: '#d5202a',
  toll: '#0a57a4',
  rail: '#3d4852',
  school: '#e08a00',
  hazard: '#e08a00',
  works: '#e06a00',
  flood: '#1479c9',
  jam: '#b3261e',
  crash: '#b3261e',
};

// Biểu tượng nét mảnh cho nút bấm.
const LINES = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  settings:
    '<path d="M4 7h9M19 7h1M4 12h2M12 12h8M4 17h10M20 17h0"/><circle cx="16" cy="7" r="2.3"/><circle cx="9" cy="12" r="2.3"/><circle cx="17" cy="17" r="2.3"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.6"/>',
  locate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>',
  navigate: '<path d="M12 3l7 17-7-4-7 4 7-17z"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  report: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5.5v-5.5h-5V20H4v-9z"/>',
  work: '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M9 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21.5s7-6.2 7-11.5a7 7 0 1 0-14 0c0 5.3 7 11.5 7 11.5z"/><circle cx="12" cy="10" r="2.5"/>',
  car: '<path d="M5 11l1.7-4.5h10.6L19 11M4 11h16a1 1 0 0 1 1 1v5H3v-5a1 1 0 0 1 1-1zM6 17v2M18 17v2"/><path d="M7 14h.5M16.5 14h.5"/>',
  moto: '<circle cx="5.5" cy="16.5" r="3"/><circle cx="18.5" cy="16.5" r="3"/><path d="M8.5 16.5H14l2-7.5h-3M16 9h2.5l1.5 3.5M5 11.5h4.5l2 5"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
  share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 13v6.5h14V13"/>',
  download: '<path d="M12 3.5V15M7.5 10.5 12 15l4.5-4.5M5 13v6.5h14V13"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8L12 3.5z"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  bluetooth: '<path d="M6.5 7.5l11 9-5.5 4.5V3l5.5 4.5-11 9"/>',
};

/** SVG nét mảnh cho nút bấm. */
export function lineIcon(name, size = 24) {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINES[name] || ''}</svg>`
  );
}

/** SVG tô đặc cho biểu tượng điểm cảnh báo. */
export function glyphIcon(name, size = 24) {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" fill-rule="evenodd" ` +
    `aria-hidden="true"><path d="${GLYPHS[name] || GLYPHS.hazard}"/></svg>`
  );
}

/** Mũi tên chỉ hướng rẽ, vẽ theo kiểu biển chỉ dẫn (nét trắng trên nền xanh). */
export function maneuverIcon(icon, size = 56) {
  const open =
    `<svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`;
  if (!icon || icon.kind === 'arrive') {
    return (
      `<svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="currentColor" fill-rule="evenodd" aria-hidden="true">` +
      `<path d="M24 4c8.3 0 15 6.6 15 14.8C39 30 24 44 24 44S9 30 9 18.8C9 10.6 15.7 4 24 4zm0 8.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z"/></svg>`
    );
  }
  if (icon.kind === 'uturn') {
    return `${open}<path d="M32 43V21a9 9 0 0 0-18 0v10"/><path d="M6.5 24.5 14 33l7.5-8.5"/></svg>`;
  }
  if (icon.kind === 'roundabout') {
    const label = icon.exit
      ? `<text x="24" y="25.5" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" stroke="none" font-family="inherit">${icon.exit}</text>`
      : '';
    return `${open}<circle cx="24" cy="21" r="10.5" stroke-width="4.5"/><path d="M24 44V32"/>${label}</svg>`;
  }
  const a = ((icon.angle || 0) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const bendY = icon.angle ? 27 : 30;
  const tip = [24 + 17 * dx, bendY + 17 * dy];
  const head = (turn) => {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const hx = -(dx * c - dy * s);
    const hy = -(dx * s + dy * c);
    return `${(tip[0] + 10 * hx).toFixed(1)} ${(tip[1] + 10 * hy).toFixed(1)}`;
  };
  const tipStr = `${tip[0].toFixed(1)} ${tip[1].toFixed(1)}`;
  return (
    `${open}<path d="M24 44V${bendY}L${tipStr}"/>` +
    `<path d="M${head(0.7)}L${tipStr}L${head(-0.7)}"/></svg>`
  );
}

/**
 * Ảnh huy hiệu tròn cho một loại điểm, để nạp vào bản đồ bằng map.addImage().
 * Trả về ImageData (kích thước gấp đôi, dùng với pixelRatio: 2).
 */
export function badgeImage(name) {
  const size = 72;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2);
  ctx.fillStyle = GLYPH_COLORS[name] || '#e08a00';
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1.5;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.translate(size / 2 - 19.2, size / 2 - 19.2);
  ctx.scale(1.6, 1.6);
  ctx.fillStyle = '#fff';
  ctx.fill(new Path2D(GLYPHS[name] || GLYPHS.hazard), 'evenodd');
  return ctx.getImageData(0, 0, size, size);
}
