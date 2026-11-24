// Kiểm thử các hàm thuần của js/camui.js (giao diện camera nhận diện biển). Phần DOM được thử trên trình duyệt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AIM_KEY_STEP,
  aimToPoint,
  camAvailable,
  CHIP_WARN_HEALTH,
  chipLabel,
  chipWarning,
  chipState,
  checkClosedView,
  clearText,
  countText,
  dayText,
  exportText,
  heldCount,
  heldText,
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
  clearEvalText,
  evalCountText,
  learnText,
} from '../js/camui.js';
import { EVAL_TEXT } from '../js/evalcrops.js';
import { learnableCount, speedLearnable, TEXT } from '../js/camctl.js';
import { SIGN_CATALOGUE } from '../js/signs.js';
import { buildLabels } from '../tools/camera/lib.mjs';
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
  assert.equal(rowStatus({ status: 'candidate', src: 'camera', hitDays: 1 }), 'Camera mới thấy, chưa xác nhận');
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

test('biển đang lưu mà không dùng: dòng số biển, danh sách và hộp xuất/xoá nói rõ bao nhiêu biển và vì sao', () => {
  const HELD = 'Đang giữ 2 biển thuộc loại bản này chưa học (không hiện, không báo); vẫn xuất tệp hoặc xoá được.';
  // Chỉ còn biển bị cất (labels đã tải; ví dụ biển tốc độ từ bản dựng cũ): không được nói "chưa ghi nhận".
  const only = { learned: 0, confirmed: 0, candidates: 0, stored: 2 };
  assert.equal(heldCount(only), 2);
  assert.equal(heldText(only, 'ok'), HELD);
  assert.equal(countText(only, 'ok'), `${UI_TEXT.noneInUse} ${HELD}`);
  assert.notEqual(countText(only, 'ok'), UI_TEXT.empty);
  assert.equal(settingsView(st({ counts: only, labels: 'ok' })).count, `${UI_TEXT.noneInUse} ${HELD}`);
  assert.equal(exportText(only), 'Tệp GeoJSON gồm 2 biển đang lưu trên máy này (gồm cả biển đã nhập từ tệp, nếu có).');
  assert.equal(clearText(only), 'Xoá hết 2 biển đang lưu trên máy này (gồm cả biển đã nhập từ tệp, nếu có). Không khôi phục được.');
  // Có cả biển đang dùng.
  const some = { learned: 3, confirmed: 1, candidates: 2, stored: 5 };
  assert.equal(countText(some, 'ok'), `Biển đã học: 3 (1 đã xác nhận). ${HELD}`);
  assert.equal(exportText(some), 'Tệp GeoJSON gồm 5 biển đang lưu trên máy này (gồm cả biển đã nhập từ tệp, nếu có).');
  // Không có biển bị cất: như trước.
  assert.equal(heldText({ learned: 3, confirmed: 1, stored: 3 }, 'ok'), null);
  assert.equal(countText({ learned: 3, confirmed: 1, stored: 3 }, 'ok'), 'Biển đã học: 3 (1 đã xác nhận).');
  assert.equal(countText({ learned: 0, confirmed: 0, stored: 0 }, 'ok'), UI_TEXT.empty);
  assert.equal(clearText({ learned: 0, stored: 0 }), UI_TEXT.empty);
  // Trạng thái tải labels.json không đổi câu: lúc chưa có labels kho cất đúng các loại bản này đã gỡ (camctl
  // PRUNED_CODES), nên không hứa "tải xong thì dùng", và không có biển bị giữ thì không có câu nào (kể cả khi lỗi).
  for (const labels of ['idle', 'loading', 'error', 'missing', 'ok']) {
    const v = settingsView(st({ enabled: false, labels, counts: { learned: 1, confirmed: 1, stored: 3 } }));
    assert.equal(v.statusShown, false);
    assert.equal(v.count, `Biển đã học: 1 (1 đã xác nhận). ${HELD}`, labels);
    assert.equal(settingsView(st({ enabled: false, labels, counts: { learned: 0, confirmed: 0, stored: 0 } })).count, UI_TEXT.empty, labels);
    assert.equal(settingsView(st({ enabled: false, labels, counts: { learned: 2, confirmed: 1, stored: 2 } })).count, 'Biển đã học: 2 (1 đã xác nhận).', labels);
  }
  assert.equal(heldText({ learned: 0, stored: 0 }), null);
  for (const t of [HELD]) assert.doesNotMatch(t, /tải xong|tạm chưa|vẫn được báo/);
  // TEXT.labels (dùng khi nhập tệp mà labels.json đang lỗi) không còn bảo mở lại ứng dụng: việc tải lại là tự động.
  assert.doesNotMatch(TEXT.labels, /mở lại/);
  assert.match(TEXT.labels, /tự tải lại/);
  // Bản cài thiếu labels.json: không hứa tự tải lại.
  assert.doesNotMatch(TEXT.labelsMissing, /tải lại|chờ|thử lại/);
  // Tiếng Việt viết thường kiểu câu, không có chữ in hoa liền nhau.
  for (const t of [HELD, UI_TEXT.noneInUse, TEXT.labels, TEXT.labelsMissing]) assert.doesNotMatch(t, /\p{Lu}{2,}/u);
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

test('chipWarning: camera đang mở mà hình bị che, quá tối, quá sáng thì nút đổi màu và nhãn đọc nói rõ', () => {
  assert.deepEqual([...CHIP_WARN_HEALTH], ['blank', 'dark', 'bright']);
  for (const health of CHIP_WARN_HEALTH) {
    const warn = chipWarning(st({ enabled: true, camera: 'on', capturing: true, health }));
    assert.equal(warn, TEXT[health]);
    assert.equal(chipLabel('on', warn), `Camera nhận diện biển đang bật. ${TEXT[health]} Bấm để tắt.`);
  }
  assert.equal(chipWarning(st({ enabled: true, camera: 'on', capturing: true, health: null })), null, 'hình tốt');
  assert.equal(chipWarning(st({ enabled: true, camera: 'on', capturing: false, health: 'blank' })), null, 'chưa lấy khung');
  assert.equal(chipWarning(st({ enabled: true, camera: 'paused', capturing: true, health: 'blank' })), null, 'tạm dừng');
  assert.equal(chipWarning(st({ enabled: false, camera: 'on', capturing: true, health: 'blank' })), null, 'chưa bật');
  assert.equal(chipLabel('on', null), chipLabel('on'));
  assert.match(readFileSync(new URL('../css/app.css', import.meta.url), 'utf8'), /\.cam-chip\.cam-on\.cam-warn \{/);
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
  // Chỉ còn biển bị cất (nhãn đã bị gỡ khỏi danh sách học): vẫn xuất được.
  assert.equal(settingsView(st({ parked: true, counts: { learned: 0, confirmed: 0, stored: 1 } })).exportDisabled, false);
  assert.equal(settingsView(st({ parked: true, counts: { learned: 0, confirmed: 0, stored: 0 } })).exportDisabled, true);
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

test('settingsView: còn ảnh kiểm tra đã lưu thì hiện số ảnh và nút "Xoá ảnh biển đã lưu" ở Cài đặt, kể cả khi không đỗ, máy không chạy được hay không có mô hình', () => {
  assert.equal(settingsView(st({ parked: true, evalCount: 0 })).evalShown, false);
  for (const extra of [{ parked: false }, { parked: false, models: 'no-models' }, { parked: false, support: { ok: false, reason: 'no-simd' } }]) {
    const v = settingsView(st({ evalCount: 2, ...extra }));
    assert.equal(v.evalShown, true, JSON.stringify(extra));
    assert.equal(Object.hasOwn(v, 'evalClearDisabled'), false); // nút xoá ảnh không có trạng thái khoá
  }
  assert.equal(evalCountText(0), EVAL_TEXT.empty);
  assert.equal(evalCountText(1234), 'Đã lưu 1.234 ảnh biển trên máy.');
  assert.equal(clearEvalText(3), 'Xoá cả 3 ảnh biển đã lưu để kiểm tra độ chính xác');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="camEvalCount" class="note" hidden><\/p>/);
  assert.match(html, /<div class="row wrap cam-actions" hidden><button id="btnCamEvalClear" class="btn" type="button">/);
  const ui = readFileSync(new URL('../js/camui.js', import.meta.url), 'utf8');
  assert.match(ui, /\$\('btnCamEvalClear'\)\.addEventListener\('click', clearEval\)/);
});

test('checkClosedView: luồng kiểm tra bị đóng khi xe vẫn đỗ (ứng dụng bị ẩn) thì nói đúng lý do và cho "Mở lại"', () => {
  assert.deepEqual(checkClosedView(st({ parked: true })), { text: UI_TEXT.checkHidden, reopen: true });
  assert.deepEqual(checkClosedView(st({ parked: false })), { text: UI_TEXT.checkClosed, reopen: false });
  assert.match(UI_TEXT.checkHidden, /ẩn/);
  assert.ok(UI_TEXT.checkHidden.includes(`“${UI_TEXT.reopen}”`));
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
  assert.match(all, /hình ảnh không được gửi đi và không được lưu \(trừ khi bạn tự bật lưu ảnh biển/);
  // Ảnh kiểm tra (camEval) là hình ảnh được lưu: không câu nào được hứa "không bao giờ lưu" vô điều kiện.
  assert.doesNotMatch(`${all} ${UI_TEXT.intro}`, /không lưu hình ảnh|không được lưu hay gửi/);
  assert.match(UI_TEXT.intro, /chỉ lưu ảnh biển khi bạn bật “Lưu ảnh biển để kiểm tra độ chính xác”/);
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

// ---------------------------------------------------------------------------------------------------------------
// Biển tốc độ: công tắc camSpeed chỉ hiện khi labels.json cho học biển tốc độ (bản v1 thì không)

/** labels.json như bản dựng nhưng mọi P.127 có learn: false (như bản v1 đã cài). */
function prunedSpeedLabels() {
  const j = buildLabels(SIGN_CATALOGUE);
  for (const l of j.labels) if (l.code === 'P.127') l.learn = false;
  return j;
}

test('settingsView: công tắc biển tốc độ chỉ hiện khi labels.json học biển tốc độ; không thì một dòng ghi chú', () => {
  let v = settingsView(st({ labels: 'ok', speedLearnable: true }));
  assert.equal(v.camSpeedShown, true);
  assert.equal(v.noSpeedNote, false);
  v = settingsView(st({ labels: 'ok', speedLearnable: false }));
  assert.equal(v.camSpeedShown, false);
  assert.equal(v.noSpeedNote, true);
  // Chưa tải được labels.json: không biết nên không hiện cả hai.
  v = settingsView(st({ labels: 'error', speedLearnable: false }));
  assert.equal(v.camSpeedShown, false);
  assert.equal(v.noSpeedNote, false);
  assert.equal(settingsView(st({})).camSpeedShown, false);
  assert.match(UI_TEXT.noSpeed, /^Bản này chưa học biển tốc độ tối đa, nên camera không đổi giới hạn trên đồng hồ tốc độ\.$/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="camSpeedNote" class="note" hidden><\/p>/);
  assert.match(html, /<label class="opt"><span>Dùng biển tốc độ do camera ghi nhận cho đồng hồ tốc độ<small>[^<]+<\/small><\/span><input id="optCamSpeed"/);
});

test('learnText: số loại biển được học theo labels.json; nói rõ khi chưa học biển tốc độ', () => {
  const full = buildLabels(SIGN_CATALOGUE);
  const pruned = prunedSpeedLabels();
  assert.equal(learnText(null), null);
  assert.equal(learnText(st({ learnable: null })), null);
  assert.equal(learnText(st({ learnable: 0 })), null);
  assert.equal(learnText(st({ learnable: learnableCount(full), speedLearnable: speedLearnable(full) })), 'Bản này học 47 loại biển thường gặp.');
  assert.equal(
    learnText(st({ learnable: learnableCount(pruned), speedLearnable: speedLearnable(pruned) })),
    'Bản này học 36 loại biển thường gặp; chưa học biển tốc độ tối đa vì trên dữ liệu thử, mô hình còn đọc nhầm trị số.'
  );
  // Lời giới thiệu lúc bật lần đầu có câu này khi đã có labels, không có khi chưa.
  const how = (x) => introParagraphs(ML_MANIFEST, x)[0][1];
  assert.match(how(st({ learnable: 32, speedLearnable: false })), /Bản này học 32 loại biển thường gặp; chưa học biển tốc độ tối đa/);
  assert.doesNotMatch(how(null), /loại biển/);
});

test('models/labels.json đã cài (bản v1): 32 loại biển, không học biển tốc độ nào, nên công tắc biển tốc độ bị ẩn', () => {
  const installed = JSON.parse(readFileSync(new URL('../models/labels.json', import.meta.url), 'utf8'));
  // Khi biển tốc độ được học lại (DECISION.md: cần mô hình qua E1 cho cả 11 trị số và dữ liệu đường thật), sửa bài này
  // cùng README ("Chỉ 32 loại biển", "Biển tốc độ chưa được học") và lời trong ứng dụng.
  assert.equal(learnableCount(installed), 32);
  assert.equal(speedLearnable(installed), false);
  const v = settingsView(st({ labels: 'ok', learnable: learnableCount(installed), speedLearnable: speedLearnable(installed) }));
  assert.equal(v.camSpeedShown, false);
  assert.equal(v.noSpeedNote, true);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, new RegExp(`Chỉ ${learnableCount(installed)} loại biển`));
});
