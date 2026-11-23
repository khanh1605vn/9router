// Kiểm thử các hàm thuần của js/camui.js (giao diện camera nhận diện biển). Phần DOM được thử trên trình duyệt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AIM_KEY_STEP,
  aimToPoint,
  camAvailable,
  chipLabel,
  chipState,
  countText,
  dayText,
  downloadMb,
  IMPORT_MAX_BYTES,
  importFileError,
  importResultText,
  INTRO_KEY,
  introParagraphs,
  LEARNED_ZOOM,
  learnedFeatures,
  levelText,
  msText,
  OBEY_REAL_SIGNS,
  passText,
  pointToAim,
  REVIEW_MAX_ROWS,
  rowStatus,
  rowTitle,
  runNote,
  seenLine,
  settingsView,
  UI_TEXT,
} from '../js/camui.js';
import { TEXT } from '../js/camctl.js';
import { CAPTURE_SPEED, FOE_Y_FRAC, foeFor } from '../js/camsched.js';
import { dayNumber, MAX_IMPORT_CHARS } from '../js/learnedsigns.js';
import { ML_MANIFEST } from '../js/mlmanifest.js';
import { LEARNED_ICON_PX, LEARNED_QUIET_OPACITY, learnedImageId } from '../js/mapview.js';

const day = (y, m, d) => dayNumber(new Date(y, m - 1, d, 12).getTime());

// Trạng thái mẫu của CameraController#state (chỉ các khoá giao diện đọc).
const ST = Object.freeze({
  support: { ok: true, reason: null },
  enabled: false,
  camera: 'off',
  vision: 'idle',
  visionError: null,
  models: 'ok',
  parked: true,
  counts: { learned: 0, confirmed: 0, candidates: 0 },
  text: 'Camera đang tắt.',
});
const st = (o) => ({ ...ST, ...o });

test('hằng số giao diện có giá trị đã chọn', () => {
  assert.equal(REVIEW_MAX_ROWS, 100);
  assert.equal(IMPORT_MAX_BYTES, MAX_IMPORT_CHARS);
  assert.equal(LEARNED_ZOOM, 17);
  assert.equal(AIM_KEY_STEP, 0.01);
  assert.equal(INTRO_KEY, 'banduong:camIntro');
  assert.equal(LEARNED_ICON_PX, 44);
  assert.equal(LEARNED_QUIET_OPACITY, 0.72);
});

test('dayText: dd/mm/yyyy và dd/mm', () => {
  const d = day(2026, 11, 12);
  assert.equal(dayText(d), '12/11/2026');
  assert.equal(dayText(d, false), '12/11');
  assert.equal(dayText(null), null);
});

test('rowTitle: tên biển, biển tốc độ kèm trị số', () => {
  assert.equal(rowTitle({ code: 'P.127', value: '50' }), 'Tốc độ tối đa cho phép 50 km/h');
  assert.equal(rowTitle({ code: 'P.123a', value: null }), 'Cấm rẽ trái');
  assert.equal(rowTitle({ code: 'X.999', value: null }), 'X.999');
});

test('rowStatus: ba trạng thái hiển thị', () => {
  assert.equal(rowStatus({ status: 'confirmed', src: 'camera', hitDays: 2 }), 'Đã xác nhận');
  assert.equal(rowStatus({ status: 'candidate', src: 'camera', hitDays: 1 }), 'Camera thấy 1 lần');
  assert.equal(rowStatus({ status: 'candidate', src: 'import', hitDays: 0 }), 'Đã nhập');
  assert.equal(rowStatus({ status: 'candidate', src: 'camera', hitDays: 2 }), 'Camera chưa chắc chắn');
});

test('seenLine: thấy lần đầu, số ngày, gần nhất', () => {
  const row = { src: 'camera', firstDay: day(2026, 11, 12), hitDays: 3, lastHitDay: day(2026, 11, 20) };
  assert.equal(seenLine(row), 'Thấy lần đầu 12/11/2026 · thấy vào 3\u00a0ngày · gần nhất 20/11');
  // Mới thấy một lần: không lặp lại "gần nhất" cùng ngày.
  assert.equal(seenLine({ src: 'camera', firstDay: day(2026, 11, 12), hitDays: 1, lastHitDay: day(2026, 11, 12) }), 'Thấy lần đầu 12/11/2026 · thấy vào 1\u00a0ngày');
  assert.equal(seenLine({ src: 'import', firstDay: day(2026, 11, 1), hitDays: 0, lastHitDay: null }), 'Nhập ngày 01/11/2026');
  assert.match(seenLine({ src: 'camera', firstDay: day(2026, 1, 2), hitDays: 1, plate: 'unread' }), /có biển phụ$/);
});

test('countText: "Biển đã học: N (M đã xác nhận)."', () => {
  assert.equal(countText({ learned: 12, confirmed: 8 }), 'Biển đã học: 12 (8 đã xác nhận).');
  assert.equal(countText({ learned: 1234, confirmed: 0 }), 'Biển đã học: 1.234 (0 đã xác nhận).');
  assert.equal(countText({ learned: 0, confirmed: 0 }), UI_TEXT.empty);
});

test('importResultText: "Đã thêm X biển, bỏ qua Y", kho đầy, lỗi tệp', () => {
  assert.equal(importResultText({ added: 12, skipped: 3 }), 'Đã thêm 12 biển, bỏ qua 3.');
  assert.equal(importResultText({ added: 0, skipped: 0 }), 'Tệp không có biển nào.');
  assert.equal(importResultText({ added: 2, skipped: 9, error: 'full' }), 'Đã thêm 2 biển, bỏ qua 9. Kho biển đã đầy (5.000 biển).');
  assert.equal(importResultText({ added: 0, skipped: 0, error: 'bad-json' }), 'Không đọc được tệp. Hãy chọn tệp biển do Bạn Đường xuất ra.');
});

test('importFileError: kiểm cỡ tệp trước khi đọc', () => {
  assert.equal(importFileError({ size: 1000 }), null);
  assert.equal(importFileError({ size: IMPORT_MAX_BYTES }), null);
  assert.equal(importFileError({ size: IMPORT_MAX_BYTES + 1 }), 'Tệp quá lớn (tối đa 5 MB).');
  assert.equal(importFileError({ size: NaN }), 'Tệp quá lớn (tối đa 5 MB).');
  assert.ok(importFileError(null));
});

test('chipState: ẩn khi chưa bật; bật, tạm dừng, cần bật lại', () => {
  assert.equal(chipState(st({ enabled: false, camera: 'on' })), 'hidden');
  assert.equal(chipState(st({ enabled: true, camera: 'on' })), 'on');
  assert.equal(chipState(st({ enabled: true, camera: 'starting' })), 'on');
  assert.equal(chipState(st({ enabled: true, camera: 'off' })), 'paused'); // chưa lái, xe chậm…
  assert.equal(chipState(st({ enabled: true, camera: 'paused' })), 'paused'); // trang ẩn
  assert.equal(chipState(st({ enabled: true, camera: 'error:not-granted' })), 'off');
  assert.equal(chipState(st({ enabled: true, models: 'no-models' })), 'off');
  assert.equal(chipState(st({ enabled: true, support: { ok: false, reason: 'no-simd' } })), 'off');
  assert.equal(chipState(st({ enabled: true, camera: 'on', vision: 'error', visionError: 'integrity' })), 'off');
  assert.equal(chipState(st({ enabled: true, camera: 'on', vision: 'ready', visionError: 'args' })), 'on');
  for (const k of ['on', 'paused', 'off']) assert.match(chipLabel(k), /Bấm để tắt\.$/);
});

test('settingsView: chỉ bật được khi xe đã đỗ; tắt và xoá luôn được', () => {
  // Đang chạy, chưa bật: công tắc khoá, ghi "Chỉ bật được khi xe đã đỗ."
  let v = settingsView(st({ parked: false }));
  assert.equal(v.switchDisabled, true);
  assert.equal(v.switchHint, TEXT.notParked);
  assert.equal(v.checkDisabled, true);
  assert.equal(v.storeDisabled, true);
  assert.equal(v.exportDisabled, true);
  assert.equal(v.parkedHint, true);
  // Đang chạy, đã bật: công tắc vẫn bấm được để tắt.
  v = settingsView(st({ parked: false, enabled: true }));
  assert.equal(v.switchOn, true);
  assert.equal(v.switchDisabled, false);
  assert.equal(v.switchHint, UI_TEXT.canTurnOff);
  assert.equal(v.statusShown, true);
  assert.equal(settingsView(st({ parked: true })).statusShown, false);
  assert.equal(settingsView(st({ parked: true })).switchHint, UI_TEXT.autoStart);
  // Đã đỗ, chạy được: bật được, kiểm tra được.
  v = settingsView(st({ parked: true, counts: { learned: 3, confirmed: 1 } }));
  assert.equal(v.switchDisabled, false);
  assert.equal(v.checkDisabled, false);
  assert.equal(v.storeDisabled, false);
  assert.equal(v.exportDisabled, false);
  assert.equal(v.parkedHint, false);
  // Kho trống: không có gì để xuất.
  assert.equal(settingsView(st({ parked: true })).exportDisabled, true);
  // Bản cài chưa có mô hình hoặc máy không chạy được: công tắc khoá kèm lý do; kho vẫn dùng được.
  v = settingsView(st({ parked: true, models: 'no-models', text: 'Bản cài này chưa có dữ liệu nhận diện biển.' }));
  assert.equal(v.switchDisabled, true);
  assert.equal(v.switchHint, 'Bản cài này chưa có dữ liệu nhận diện biển.');
  assert.equal(v.checkDisabled, true);
  assert.equal(v.storeDisabled, false);
  v = settingsView(st({ parked: true, support: { ok: false, reason: 'no-simd' }, text: 'Thiết bị này không chạy được tính năng nhận diện biển.' }));
  assert.equal(v.switchDisabled, true);
  assert.equal(camAvailable(st({ support: { ok: false } })), false);
  assert.equal(Object.hasOwn(v, 'clearDisabled'), false); // "Xoá các biển đã học" không có trạng thái khoá
});

test('aimToPoint / pointToAim: đi hai chiều, khớp foeFor của bộ học', () => {
  const W = 1920;
  const H = 1080;
  assert.deepEqual(aimToPoint({ dx: 0, dy: 0 }, W, H), { x: 0.5, y: FOE_Y_FRAC });
  for (const [fx, fy] of [
    [0.5, 0.3],
    [0.62, 0.5],
    [0.1, 0.9],
  ]) {
    const aim = pointToAim(fx, fy, W, H);
    const p = aimToPoint(aim, W, H);
    assert.ok(Math.abs(p.x - fx) < 1 / W && Math.abs(p.y - fy) < 1 / H, `${fx},${fy}`);
    const foe = foeFor(aim, W, H); // điểm tụ mà bộ học dùng
    assert.ok(Math.abs(foe.x - fx * W) <= 0.5 && Math.abs(foe.y - fy * H) <= 0.5);
  }
  // Kéo ra ngoài hình: giữ trong khung.
  assert.deepEqual(pointToAim(1.4, -0.2, W, H), { dx: W / 2, dy: Math.round(-FOE_Y_FRAC * H) });
  assert.deepEqual(pointToAim(0.5, 0.5, 0, 0), { dx: 0, dy: 0 });
  assert.deepEqual(aimToPoint(null, 0, 0), { x: 0.5, y: FOE_Y_FRAC });
});

test('learnedFeatures: biển chưa xác nhận vẽ nét đứt; mã lạ bị bỏ', () => {
  const rows = [
    { id: 'a', code: 'P.127', value: '50', coord: [105.8, 21], status: 'confirmed' },
    { id: 'b', code: 'R.122', value: null, coord: [105.81, 21], status: 'candidate' },
    { id: 'c', code: 'X.1', value: null, coord: [105.82, 21], status: 'candidate' },
  ];
  const f = learnedFeatures(rows);
  assert.equal(f.length, 2);
  assert.equal(f[0].quiet, false);
  assert.equal(f[1].quiet, true);
  assert.deepEqual(f[0].art, { shape: 'prohibit', pict: 'speed' });
  assert.notEqual(learnedImageId(f[0]), learnedImageId({ ...f[0], quiet: true }));
});

test('levelText, msText, passText', () => {
  assert.equal(levelText(2), 'mức 2 (3 khung/giây)');
  assert.equal(levelText(3), 'mức 3 (5 khung/giây)');
  assert.equal(levelText(0), 'tạm dừng cho máy đỡ nóng');
  assert.equal(levelText(9), '—');
  assert.equal(msText(18.46), '18,5 ms');
  assert.equal(msText(null), '—');
  assert.equal(passText({ n: 30, p50: 18, p90: 25.2 }), 'trung vị 18 ms, 90 % dưới 25,2 ms');
  assert.equal(passText({ n: 0 }), '—');
});

test('downloadMb: chỉ nói dung lượng khi bản cài có mô hình', () => {
  const files = { ...ML_MANIFEST.files };
  const hasModels = Object.keys(files).some((f) => f.endsWith('.tflite'));
  if (!hasModels) assert.equal(downloadMb(), null);
  const fake = { version: 1, files: { ...files } };
  const e = (size) => ({ sha256: 'a'.repeat(64), size });
  fake.files['models/sign-det.int8.tflite'] = e(500_000);
  fake.files['models/sign-cls.int8.tflite'] = e(400_000);
  const mb = downloadMb(fake);
  const relaxed = ['models/labels.json', 'vendor/litert/litert.iife.min.js', 'vendor/litert/litert_wasm_internal.js', 'vendor/litert/litert_wasm_internal.wasm'];
  const bytes = relaxed.reduce((s, f) => s + fake.files[f].size, 900_000);
  assert.ok(mb >= bytes / 1e6 && mb < bytes / 1e6 + 0.11, `${mb}`);
  assert.match(introParagraphs(fake).at(-1)[1], /tối đa khoảng [\d,]+ MB/);
  assert.doesNotMatch(introParagraphs({ version: 1, files: {} }).at(-1)[1], /MB/);
});

test('lời giới thiệu và ghi chú: đủ các ý của PLAN §6.1, §7', () => {
  const all = introParagraphs()
    .map(([h, t]) => `${h}. ${t}`)
    .join(' ');
  assert.match(all, /2 ngày khác nhau/);
  assert.match(all, /không đọc thành tiếng/);
  assert.match(all, /Camera sau của điện thoại/);
  assert.match(all, /Camera có sẵn của ô tô thường không dùng được/);
  assert.match(all, /tuỳ máy/);
  assert.match(all, /không được lưu hay gửi đi/);
  assert.match(all, /Không cầm hay bấm điện thoại khi đang lái/);
  assert.ok(all.includes(OBEY_REAL_SIGNS));
  assert.match(runNote(), new RegExp(`dưới khoảng ${Math.round(CAPTURE_SPEED * 3.6)}\u00a0km/h`));
  assert.match(UI_TEXT.permission, /cho phép lâu dài/);
  assert.match(UI_TEXT.keepAwakeOn, /Giữ màn hình sáng khi lái/);
});

test('chữ giao diện: viết hoa đúng chính tả (không có cụm chữ in hoa), không dùng text-transform', () => {
  const texts = [...Object.values(UI_TEXT), runNote(), ...introParagraphs().flat(), OBEY_REAL_SIGNS];
  for (const t of texts) {
    // Chữ viết tắt thông dụng thì được (USB, GPS, OBD); ngoài ra không có cụm chữ in hoa.
    assert.doesNotMatch(t.replace(/\b(?:USB|GPS|OBD|MB)\b/g, ''), /\p{Lu}{3,}/u, t);
    assert.match(t, /^[\p{Lu}0-9]/u, `phải bắt đầu bằng chữ hoa: ${t}`);
  }
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /text-transform\s*:\s*uppercase/);
});

test('index.html: mục camera nằm sau "Biển báo phía trước", có đủ nút và câu "Luôn tuân theo …"', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const a = html.indexOf('<h3>Biển báo phía trước</h3>');
  const b = html.indexOf('<h3>Camera nhận diện biển (thử nghiệm)</h3>');
  const c = html.indexOf('<h3>Kết nối với ô tô</h3>');
  assert.ok(a > 0 && b > a && c > b);
  const section = html.slice(b, c);
  for (const id of ['optCamEnabled', 'btnCamCheck', 'optSignCamera', 'optCamSpeed', 'camLearnedCount', 'btnCamList', 'btnCamExport', 'btnCamImport', 'camImportFile', 'btnCamClear']) {
    assert.ok(section.includes(`id="${id}"`), id);
  }
  assert.ok(section.includes('Xoá các biển đã học'));
  assert.ok(section.includes(OBEY_REAL_SIGNS));
  assert.match(section, /accept="\.geojson,\.json/);
  assert.ok(html.includes('id="btnCamChip"'));
  // Nút camera nhỏ và lớp bản đồ ẩn sẵn: không có gì hiện ra khi người dùng chưa bật hay chưa hỏi.
  assert.match(html, /id="btnCamChip"[^>]*hidden/);
  assert.match(html, /id="learnedLayer"[^>]*hidden/);
});

test('camui.js: dữ liệu từ bản ghi và tệp không bao giờ đi qua innerHTML', () => {
  const src = readFileSync(new URL('../js/camui.js', import.meta.url), 'utf8');
  // Mọi chỗ gán HTML chỉ nhận SVG của signSvg() hoặc lineIcon().
  const htmlUses = [...src.matchAll(/(?:innerHTML\s*=|html:)\s*([^\n]+)/g)].map((m) => m[1]);
  assert.ok(htmlUses.length > 0);
  for (const u of htmlUses) assert.match(u, /^(?:v\b|lineIcon\(|entry \? signSvg\(|\/\/)/, u);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML|document\.write/);
});
