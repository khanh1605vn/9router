// Kiểm tra giao diện của tính năng camera (rà soát UX): độ tương phản, cỡ vùng bấm, cỡ chữ trên màn hình ô tô,
// thanh kéo đường chân trời và lời giải thích khớp với quy tắc thật của learnedsigns.js.
// CSS được đọc thẳng từ css/app.css bằng một bộ tách quy tắc nhỏ (không có trình duyệt trong npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aimAria, introParagraphs, rowStatus, UI_TEXT } from '../js/camui.js';
import { learnedCaption } from '../js/camctl.js';
import { EVAL_TEXT } from '../js/evalcrops.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CSS = read('css/app.css');

/** Các quy tắc của app.css: [{ media, selectors: [...], decls: { prop: value } }] theo thứ tự trong tệp. */
function parseCss(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (s, media) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < s.length && depth) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        j++;
      }
      const body = s.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head.slice(6).trim());
      else if (!head.startsWith('@')) {
        const decls = {};
        for (const d of body.split(';')) {
          const k = d.indexOf(':');
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        rules.push({ media, selectors: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decls });
      }
      i = j;
    }
  };
  walk(text, null);
  return rules;
}
const RULES = parseCss(CSS);

/** Giá trị cuối cùng của prop cho đúng selector (không suy luận kế thừa), trong media cho trước (null: ngoài media). */
function decl(selector, prop, media = null) {
  let v;
  for (const r of RULES) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) v = r.decls[prop];
  return v;
}
const vars = (theme) => {
  const out = {};
  for (const sel of theme === 'dark' ? [':root', ':root[data-theme="dark"]'] : [':root']) {
    for (const r of RULES) if (r.media === null && r.selectors.includes(sel)) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) out[k] = v;
  }
  return out;
};
const resolve = (v, theme) => {
  const m = /^var\((--[\w-]+)\)$/.exec(v || '');
  return m ? vars(theme)[m[1]] : v;
};
const px = (v) => Number(/^([\d.]+)px$/.exec(v || '')?.[1]);

function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('ux-1: chữ đỏ cảnh báo (.note.warn, .status-line.warn, .obd-status.warn) đạt 4,5:1 ở cả chế độ sáng lẫn tối', () => {
  for (const sel of ['.note.warn', '.status-line.warn', '.obd-status.warn']) {
    const light = resolve(decl(sel, 'color'), 'light');
    assert.ok(contrast(light, vars('light')['--surface']) >= 4.5, `${sel} sáng: ${light}`);
    const darkRaw = decl(`:root[data-theme="dark"] ${sel}`, 'color') ?? decl(sel, 'color');
    const dark = resolve(darkRaw, 'dark');
    const c = contrast(dark, vars('dark')['--surface']);
    assert.ok(c >= 4.5, `${sel} tối: ${dark} trên ${vars('dark')['--surface']} = ${c.toFixed(2)}:1`);
  }
  // --sign-red còn là nền sau chữ trắng: không được đổi ở chế độ tối.
  assert.equal(vars('dark')['--sign-red'], vars('light')['--sign-red']);
});

test('ux-2: nút nhỏ trong danh sách biển đủ lớn để bấm (như .btn; 56 px trên màn hình ô tô), cách nhau ≥ 8 px', () => {
  const btnH = px(decl('.chip', 'min-height'));
  assert.ok(px(decl('.btn.small', 'min-height')) >= btnH, decl('.btn.small', 'min-height'));
  assert.ok(px(decl('.btn.small', 'min-width')) >= btnH, String(decl('.btn.small', 'min-width')));
  assert.ok(px(decl('.lrow-actions', 'gap')) >= 8, decl('.lrow-actions', 'gap'));
  assert.ok(px(decl('html.car-ui .btn.small', 'min-height')) >= 56);
  assert.ok(px(decl('html.car-ui .btn.small', 'min-width')) >= 56, String(decl('html.car-ui .btn.small', 'min-width')));
});

test('ux-3: biểu tượng trên nút camera màu hổ phách (cam-warn) đạt 3:1 ở cả hai chế độ', () => {
  const sel = '.fab.cam-chip.cam-on.cam-warn';
  for (const theme of ['light', 'dark']) {
    const bg = resolve(decl(sel, 'background'), theme);
    const fg = resolve(decl(sel, 'color'), theme);
    assert.ok(contrast(fg, bg) >= 3, `${theme}: ${fg} trên ${bg} = ${contrast(fg, bg).toFixed(2)}:1`);
  }
});

test('ux-4: dòng "Camera" trên biển giới hạn và chú thích trên thanh vàng lớn hơn trên màn hình ô tô, không tràn viền đỏ', () => {
  const cap = decl('html.car-ui .alert-cap', 'font-size');
  assert.ok(px(cap) >= 15, String(cap));
  const op = decl('html.car-ui .alert-cap', 'opacity');
  assert.ok(op === undefined || Number(op) >= 0.9, String(op));
  // Biển giới hạn trên màn hình ô tô (không thấp): chữ ≥ 12 px trong đĩa trắng đủ rộng, biển vẫn vừa hàng đồng hồ 84 px.
  const M = '(min-height: 461px)';
  const w = px(decl('html.car-ui .limit', 'width', M));
  const b = px(decl('html.car-ui .limit', 'border-width', M));
  assert.ok(px(decl('html.car-ui .limit-src', 'font-size', M)) >= 12);
  assert.ok(w - 2 * b >= 60, `đĩa trắng ${w - 2 * b} px`);
  assert.ok(w <= px(vars('light')['--speedo-h']), `${w} px`);
  // Điện thoại: biển 62 px (52 px khi màn hình thấp) giữ chữ nhỏ để không chạm viền đỏ.
  assert.match(decl('.limit-src', 'font'), /^600 (9|10)px\//);
});

test('ux-5: thanh kéo đường chân trời: dọc, mũi tên lên làm giá trị tăng, có giá trị đọc, viền tập trung vẽ vào trong', () => {
  const src = read('js/camui.js');
  assert.match(src, /role: 'slider', 'aria-orientation': 'vertical'/);
  // ArrowUp làm y giảm (dời lên): giá trị đọc phải tăng.
  assert.ok(Number(aimAria(0.4).now) > Number(aimAria(0.42).now));
  assert.equal(aimAria(0.42).now, '58');
  assert.equal(aimAria(0).now, '100');
  assert.equal(aimAria(1).now, '0');
  assert.equal(aimAria(0.42).text, 'Đường chân trời ở 58% chiều cao hình, tính từ mép dưới');
  assert.match(src, /setAttribute\('aria-valuetext'/);
  // Khung xem trước cắt phần tràn (overflow: hidden) và .cam-aim phủ kín khung: viền phải nằm bên trong.
  assert.equal(decl('.cam-preview', 'overflow'), 'hidden');
  const off = decl('.cam-aim:focus-visible', 'outline-offset');
  assert.ok(off && parseFloat(off) < 0, String(off));
  assert.doesNotMatch(decl('.cam-aim:focus-visible', 'outline'), /sign-yellow/);
});

test('ux-6: hộp thoại nhận tiêu điểm khi mở, giữ Tab bên trong, trả tiêu điểm khi đóng (xem thêm tests/browser/modal-focus.mjs)', () => {
  assert.match(read('index.html'), /<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">/);
  const main = read('js/main.js');
  const open = main.split('function openModal(')[1].split('\n}\n')[0];
  assert.match(open, /if \(\$\('modal'\)\.hidden\) modalOpener = document\.activeElement/);
  assert.match(open, /querySelector\('\.modal-card'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(main.split('function onPopState(')[1].split('\n}\n')[0], /if \(id === 'modal'\) restoreModalFocus\(\)/);
  assert.match(main.split('function closeOverlays(')[1].split('\n}\n')[0], /if \(hadModal\) restoreModalFocus\(\)/);
  assert.match(main, /trapModalTab\(e\)/);
});

test('ux-7: lời giải thích khi nào biển được đọc khớp quy tắc (≥ 2 ngày, hoặc bấm Đúng; mọi biển chưa xác nhận đều im)', () => {
  const how = introParagraphs()[0][1];
  assert.match(how, /ít nhất 2 ngày khác nhau/);
  assert.match(how, /bấm “Đúng” trong danh sách biển/);
  assert.match(how, /Biển chưa xác nhận chỉ hiện trên màn hình, không đọc thành tiếng/);
  assert.doesNotMatch(how, /Biển mới thấy một lần chỉ hiện/);
  assert.match(UI_TEXT.intro, /hoặc bạn bấm “Đúng”/);
  const hint = /<input id="optSignCamera"/.test(read('index.html')) && read('index.html').match(/Báo biển do camera ghi nhận<small>([^<]+)<\/small>/)[1];
  assert.match(hint, /^Biển chưa xác nhận \(mới thấy, chưa chắc chắn hoặc nhập từ tệp\) chỉ hiện trên màn hình, không đọc thành tiếng\.$/);
  const readme = read('README.md');
  assert.match(readme, /ít nhất \*\*2 ngày khác nhau\*\* \(3 ngày nếu ngay sau biển có ngã rẽ/);
  assert.match(readme, /hoặc khi bạn bấm \*\*Đúng\*\*/);
  assert.match(readme, /Biển nhập từ tệp chỉ hiện, không đọc/);
});

test('ux-8: README mô tả đúng dải biển (chỉ viền nét đứt) và màu cam của nút camera', () => {
  const readme = read('README.md');
  assert.match(readme, /trên dải biển chỉ có viền nét đứt/);
  assert.doesNotMatch(readme, /trên thanh vàng và dải biển với viền nét đứt và dòng/);
  assert.match(readme, /màu cam: đang bật nhưng hình bị che, quá tối hoặc quá sáng/);
});

test('ux-10: lời trong hộp thoại thống nhất (tin tưởng, bị dỡ, “Chỉ lần này”, không gọi biển nhập là biển camera)', () => {
  assert.match(EVAL_TEXT.exportWarning, /Chỉ gửi cho người bạn tin tưởng\.$/);
  assert.match(UI_TEXT.permission, /\(đừng chọn “Chỉ lần này”\)/);
  const ui = read('js/camui.js');
  assert.match(ui, /`Tệp GeoJSON gồm \$\{num\(n\)\} biển đang lưu trên máy này \(gồm cả biển đã nhập từ tệp, nếu có\)\.`/);
  assert.doesNotMatch(ui, /biển camera đã ghi nhận trên máy này/);
  assert.doesNotMatch(read('js/signengine.js'), /được dỡ/);
});

test('ux-11: chú thích biển chưa xác nhận không ghi "1 lần" (hitDays đếm ngày, không đếm lần thấy)', () => {
  // Thấy hai lần trong cùng một ngày: hitDays 1, passes 2.
  const sameDay = { status: 'candidate', src: 'camera', hitDays: 1, passes: 2 };
  assert.equal(rowStatus(sameDay), 'Camera mới thấy, chưa xác nhận');
  assert.equal(learnedCaption({ src: 'camera', quiet: true, meta: sameDay }), 'Camera mới thấy, chưa xác nhận');
  assert.equal(rowStatus({ status: 'candidate', src: 'camera', hitDays: 2 }), 'Camera chưa chắc chắn');
  assert.doesNotMatch(read('README.md'), /Camera thấy 1 lần/);
});
