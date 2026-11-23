// Giao diện của camera nhận diện biển (thử nghiệm): mục trong Cài đặt, nút camera nhỏ cạnh các nút bản đồ, hộp "Kiểm
// tra camera", danh sách "Biển camera ghi nhận", xuất/nhập tệp và lớp biển đã học trên bản đồ.
//
// Mọi việc chạy thật nằm trong CameraController (js/camctl.js); tệp này chỉ hiển thị trạng thái của nó và chuyển lần bấm
// của người dùng vào nó. Quy tắc an toàn (PLAN §7):
// - lúc xe chạy không cần bấm gì: bật camera, chọn camera, xem hình, kiểm tra và xem lại danh sách chỉ làm được khi xe
//   đã đỗ; tắt camera (nút camera nhỏ, công tắc) và "Xoá các biển đã học" thì luôn được;
// - không bao giờ tự hỏi quyền camera: chỉ enable() và openCheck() được hỏi, và chỉ gọi ngay trong lần bấm;
// - không có hình xem trước khi xe chạy; khi camera học được biển thì không có thông báo hay âm thanh nào.
// Chữ lấy từ bản ghi hay từ tệp luôn đi qua textContent; HTML duy nhất được chèn là SVG do signart.js và icons.js sinh.
//
// Phần đầu tệp là các hàm thuần (kiểm thử trong tests/camui.test.mjs, chạy được trong Node); initCamUi() mới đụng DOM.

import { formatDistance } from './geo.js';
import { lineIcon } from './icons.js';
import { signSvg } from './signart.js';
import { formatNumberVi, lookupSign } from './signs.js';
import { CHECK_FRAMES, EXPORT_WARNING, importText, TEXT } from './camctl.js';
import { CAPTURE_SPEED, FOE_Y_FRAC, LEVELS } from './camsched.js';
import { dayString, MAX_IMPORT_CHARS, MAX_RECORDS } from './learnedsigns.js';
import { EVAL_TEXT } from './evalcrops.js';
import { planFiles } from './vision.js';
import { ML_MANIFEST } from './mlmanifest.js';

// ---- Ngưỡng ----
export const REVIEW_MAX_ROWS = 100; // danh sách "Biển camera ghi nhận" chỉ vẽ chừng này biển gần nhất
export const IMPORT_MAX_BYTES = MAX_IMPORT_CHARS; // tệp nhập lớn hơn chừng này (byte) thì từ chối trước khi đọc
export const LEARNED_ZOOM = 17; // "Xem trên bản đồ": phóng tới mức này
export const AIM_KEY_STEP = 0.01; // mỗi lần bấm phím mũi tên dời đường chân trời chừng này (phần khung hình)
export const INTRO_KEY = 'banduong:camIntro'; // localStorage: đã đọc lời giới thiệu lúc bật lần đầu (chỉ là tiện lợi)

// ---- Chữ ----
export const OBEY_REAL_SIGNS = 'Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.';
export const UI_TEXT = Object.freeze({
  section: 'Camera nhận diện biển (thử nghiệm)',
  intro:
    'Dùng camera sau của điện thoại kẹp cố định trên xe để ghi nhận biển báo khi xe đi qua. Biển đã ghi nhận được báo ' +
    'trước 100–200 m ở những lần đi sau, khi đã thấy lại rõ vào ngày khác (hoặc bạn bấm “Đúng”). Mọi xử lý diễn ra trên máy: không gửi hình ' +
    'ảnh đi, và chỉ lưu ảnh biển khi bạn bật “Lưu ảnh biển để kiểm tra độ chính xác”.',
  permission:
    'Khi trình duyệt hỏi, hãy cho phép lâu dài (đừng chọn “Chỉ lần này”); nếu không, lần sau camera sẽ tắt cho tới khi ' +
    'bạn bật lại lúc xe đỗ.',
  enabled: 'Đã bật camera nhận diện biển. Camera sẽ tự chạy khi bạn bắt đầu lái.',
  disabled: 'Đã tắt camera nhận diện biển.',
  // Tên đúng như công tắc trong mục Hiển thị (index.html, optAwake).
  keepAwakeOn: 'Đã bật “Giữ màn hình sáng khi lái” vì camera chỉ chạy khi màn hình sáng.',
  autoStart: 'Camera tự chạy khi bạn lái.',
  canTurnOff: 'Tắt được bất cứ lúc nào, cả khi đang chạy.',
  mount: 'Kẹp điện thoại nằm ngang, camera nhìn thẳng ra trước, không bị cần gạt hay tem che.',
  aimHelp: 'Kéo đường kẻ vàng tới đường chân trời, chấm tròn vào chỗ con đường phía trước chụm lại.',
  aimSaved: 'Đã lưu đường chân trời.',
  checkOpening: 'Đang mở camera…',
  checkClosed: 'Đã đóng camera vì xe không còn đỗ.',
  checkHidden: 'Đã tắt camera khi ứng dụng bị ẩn. Bấm “Mở lại” để xem tiếp.',
  reopen: 'Mở lại',
  measure: 'Đo tốc độ xử lý',
  measuring: 'Đang đo',
  defaultCamera: 'Camera sau của điện thoại',
  empty: 'Chưa có biển nào được ghi nhận.',
  layer: 'Biển camera ghi nhận',
  layerHide: 'Ẩn biển camera ghi nhận trên bản đồ',
  exportTitle: 'Xuất tệp biển đã học',
  withDates: 'Kèm ngày',
  withDatesHint: 'Ghi thêm ngày thấy biển lần đầu và lần gần nhất.',
  save: 'Lưu tệp',
  clearTitle: 'Xoá các biển đã học?',
  clearDone: 'Đã xoá các biển đã học.',
  confirmed: 'Đã xác nhận biển.',
  rejected: 'Đã bỏ biển này. Camera sẽ không học lại biển này trong một thời gian.',
  removed: 'Đã ghi nhận biển đã bị dỡ.',
  evalCleared: 'Đã xoá ảnh biển đã lưu.',
});

/**
 * Luồng "Kiểm tra camera" bị bộ điều phối đóng (người dùng không bấm đóng): câu giải thích và có hiện nút "Mở lại" không.
 * Xe vẫn đỗ thì luồng đóng vì ứng dụng bị ẩn (camctl đóng nó khi trang ẩn); xe chạy thì vì xe không còn đỗ.
 */
export function checkClosedView(st) {
  return st?.parked ? { text: UI_TEXT.checkHidden, reopen: true } : { text: UI_TEXT.checkClosed, reopen: false };
}

/** Ngày (số thứ tự ngày của learnedsigns.js) → "12/11/2026", hoặc "12/11" khi withYear = false. */
export function dayText(day, withYear = true) {
  if (!Number.isInteger(day)) return null;
  const [y, m, d] = dayString(day).split('-');
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

const num = (n) => formatNumberVi(Number(n) || 0, 0);

/** Tên một biển đã học: tên biển theo QCVN, kèm trị số với biển tốc độ ("Tốc độ tối đa cho phép 50 km/h"). */
export function rowTitle(row) {
  const entry = lookupSign(row?.code);
  const name = entry?.name || String(row?.code ?? '');
  return row?.code === 'P.127' && row.value != null ? `${name} ${row.value} km/h` : name;
}

/**
 * Trạng thái một biển đã học: "Đã xác nhận", "Đã nhập", "Camera mới thấy, chưa xác nhận" (thấy vào một ngày; có thể
 * nhiều lần trong ngày đó, nên không ghi số lần) hoặc "Camera chưa chắc chắn" (thấy vào ≥ 2 ngày, chưa đủ điểm).
 */
export function rowStatus(row) {
  if (row?.status === 'confirmed') return 'Đã xác nhận';
  if (row?.src === 'import') return 'Đã nhập';
  return (row?.hitDays ?? 0) <= 1 ? 'Camera mới thấy, chưa xác nhận' : 'Camera chưa chắc chắn';
}

/** "Thấy lần đầu 12/11/2026 · thấy vào 3 ngày · gần nhất 20/11" (biển nhập: "Nhập ngày …"). */
export function seenLine(row) {
  const first = dayText(row?.firstDay);
  const hits = Number(row?.hitDays) || 0;
  const parts = [];
  if (row?.src === 'import') {
    if (first) parts.push(`Nhập ngày ${first}`);
    if (hits > 0) parts.push(`camera thấy vào ${num(hits)}\u00a0ngày`);
  } else {
    if (first) parts.push(`Thấy lần đầu ${first}`);
    parts.push(`thấy vào ${num(Math.max(1, hits))}\u00a0ngày`);
  }
  if (Number.isInteger(row?.lastHitDay) && row.lastHitDay !== row.firstDay) parts.push(`gần nhất ${dayText(row.lastHitDay, false)}`);
  if (row?.plate) parts.push('có biển phụ');
  return parts.join(' · ');
}

/** "Biển đã học: 12 (8 đã xác nhận)." */
export function countText(counts) {
  const n = counts?.learned || 0;
  if (!n) return UI_TEXT.empty;
  return `Biển đã học: ${num(n)} (${num(counts.confirmed || 0)} đã xác nhận).`;
}

/** Câu báo kết quả nhập tệp: "Đã thêm 12 biển, bỏ qua 3." (kèm "Kho biển đã đầy …" khi kho đầy). */
export function importResultText(res) {
  if (res?.error && res.error !== 'full') return importText(res);
  const added = res?.added || 0;
  const skipped = res?.skipped || 0;
  let s = added || skipped ? `Đã thêm ${num(added)} biển, bỏ qua ${num(skipped)}.` : 'Tệp không có biển nào.';
  if (res?.error === 'full') s += ` Kho biển đã đầy (${num(MAX_RECORDS)} biển).`;
  return s;
}

/** Kiểm tệp nhập trước khi đọc: null nếu được đọc, không thì câu báo lỗi. */
export function importFileError(file) {
  if (!file) return importText({ error: 'bad-json' });
  if (!(file.size <= IMPORT_MAX_BYTES)) return `Tệp quá lớn (tối đa ${num(IMPORT_MAX_BYTES / 1e6)} MB).`;
  return null;
}

/** Máy và bản cài chạy được bộ nhận diện (chưa xét lỗi tạm thời). */
export const camAvailable = (st) => Boolean(st?.support?.ok && st.models === 'ok');

/**
 * Trạng thái nút camera nhỏ lúc lái: 'hidden' (chưa bật), 'on' (camera đang mở), 'paused' (đã bật, camera đang đóng
 * hoặc chờ), 'off' (đã bật nhưng không chạy được, phải bật lại khi xe đỗ: chưa được cấp quyền lâu dài, lỗi camera, máy
 * không chạy được hoặc dữ liệu nhận diện hỏng).
 */
export function chipState(st) {
  if (!st?.enabled) return 'hidden';
  if (!camAvailable(st)) return 'off';
  const cam = String(st.camera || 'off');
  if (cam.startsWith('error:')) return 'off';
  if (st.visionError && st.visionError !== 'args' && st.vision === 'error') return 'off';
  if (cam === 'on' || cam === 'starting') return 'on';
  return 'paused';
}

// Tình trạng hình (Learner#health) làm nút camera nhỏ đổi màu cảnh báo khi camera đang mở: bị che, quá tối, quá sáng.
export const CHIP_WARN_HEALTH = Object.freeze(['blank', 'dark', 'bright']);

/** Camera đang mở và đang lấy khung nhưng hình không dùng được: câu báo (như mục Cài đặt), không thì null. */
export function chipWarning(st) {
  if (chipState(st) !== 'on' || !st.capturing || !CHIP_WARN_HEALTH.includes(st.health)) return null;
  return TEXT[st.health] || null;
}

/** Nhãn đọc cho nút camera nhỏ (aria-label). warn: câu của chipWarning khi camera đang mở mà hình không dùng được. */
export function chipLabel(kind, warn = null) {
  if (kind === 'on' && warn) return `Camera nhận diện biển đang bật. ${warn} Bấm để tắt.`;
  if (kind === 'on') return 'Camera nhận diện biển đang bật. Bấm để tắt.';
  if (kind === 'paused') return 'Camera nhận diện biển đang tạm dừng. Bấm để tắt.';
  return 'Camera nhận diện biển chưa chạy, cần bật lại khi xe đã đỗ. Bấm để tắt.';
}

/** Dòng chọn trong hộp "Xoá các biển đã học?" khi còn ảnh kiểm tra: "Xoá cả 3 ảnh biển đã lưu để kiểm tra độ chính xác". */
export const clearEvalText = (n) => `Xoá cả ${num(n)} ảnh biển đã lưu để kiểm tra độ chính xác`;

/** Số ảnh kiểm tra độ chính xác đang lưu → "Đã lưu 3 ảnh biển trên máy." hoặc EVAL_TEXT.empty. */
export function evalCountText(n) {
  return n > 0 ? `Đã lưu ${num(n)} ảnh biển trên máy.` : EVAL_TEXT.empty;
}

/**
 * Trạng thái các nút trong mục Cài đặt (thuần, để kiểm thử quy tắc "chỉ khi xe đã đỗ"):
 * switchDisabled: công tắc bật không bấm được (tắt thì luôn được); checkDisabled: "Kiểm tra camera";
 * storeDisabled: xem danh sách, nhập tệp; exportDisabled: xuất tệp. "Xoá các biển đã học" không bao giờ bị khoá.
 * evalShown: còn ảnh kiểm tra đã lưu, nên hiện số ảnh và nút "Xoá ảnh biển đã lưu" (không bao giờ bị khoá: không cần
 * xe đỗ, máy chạy được hay có mô hình, vì ảnh đã lưu phải luôn xoá được).
 */
export function settingsView(st) {
  const available = camAvailable(st);
  const parked = Boolean(st?.parked);
  const enabled = Boolean(st?.enabled);
  let switchHint = UI_TEXT.autoStart;
  if (enabled) switchHint = UI_TEXT.canTurnOff;
  else if (!available) switchHint = st?.text || TEXT.off;
  else if (!parked) switchHint = TEXT.notParked;
  return {
    switchOn: enabled,
    statusShown: enabled, // ô trạng thái chỉ hiện khi đã bật (khi tắt, lý do nằm ngay dưới công tắc)
    switchDisabled: !enabled && (!parked || !available),
    switchHint,
    checkDisabled: !parked || !available,
    storeDisabled: !parked,
    exportDisabled: !parked || !(st?.counts?.learned > 0),
    parkedHint: !parked,
    evalShown: Number(st?.evalCount) > 0,
  };
}

/** Mức tải → chữ giữa câu: "mức 2 (3 khung/giây)". */
export function levelText(level) {
  if (level === 0) return 'tạm dừng cho máy đỡ nóng';
  const l = LEVELS[level];
  return l ? `mức ${level} (${l.fps} khung/giây)` : '—';
}

/** Thời gian xử lý (ms) → "18,5 ms". */
export const msText = (v) => (Number.isFinite(v) ? `${formatNumberVi(v, 1)} ms` : '—');

/** Một tổ hợp lượt quét của lần đo: "trung vị 18 ms, 90 % dưới 25 ms". */
export const passText = (p) => (p && p.n ? `trung vị ${msText(p.p50)}, 90 % dưới ${msText(p.p90)}` : '—');

/**
 * Dung lượng tải một lần khi bật (MB, làm tròn lên 0,1), tính từ danh sách tệp (js/mlmanifest.js) của bản LiteRT lớn
 * hơn, hoặc null khi bản cài chưa có mô hình (khi đó không nói con số nào).
 */
export function downloadMb(manifest = ML_MANIFEST) {
  let best = null;
  for (const build of ['compat', 'relaxed']) {
    const plan = planFiles(manifest, build);
    if (!plan.ok) continue;
    const bytes = Object.values(plan.files).reduce((s, f) => s + f.size, 0);
    best = Math.max(best ?? 0, bytes);
  }
  return best == null ? null : Math.ceil(best / 1e5) / 10;
}

/** Ghi chú cuối mục: khi nào camera chạy và tạm dừng (tốc độ lấy từ CAPTURE_SPEED). */
export function runNote() {
  const kmh = Math.round(CAPTURE_SPEED * 3.6);
  return (
    'Camera chỉ chạy khi ứng dụng đang mở trên màn hình và màn hình sáng; tự tạm dừng khi xe chạy dưới khoảng ' +
    `${kmh}\u00a0km/h, khi máy nóng hoặc pin yếu. Điện thoại phải được kẹp cố định; không cầm máy khi lái xe.`
  );
}

/** Đoạn lời giới thiệu hiện lúc bật lần đầu: [[tiêu đề nhỏ, nội dung]]. */
export function introParagraphs(manifest = ML_MANIFEST) {
  const mb = downloadMb(manifest);
  return [
    [
      'Cách hoạt động',
      'Camera ghi nhận biển báo khi xe đi qua. Ở những lần đi sau, khi biển đã được thấy rõ vào ít nhất 2 ngày khác nhau ' +
        '(hoặc bạn bấm “Đúng” trong danh sách biển), ứng dụng báo trước 100–200 m. Biển chưa xác nhận chỉ hiện trên màn ' +
        'hình, không đọc thành tiếng.',
    ],
    [
      'Dùng camera nào',
      'Camera sau của điện thoại, kẹp cố định và nhìn thẳng ra trước. Camera có sẵn của ô tô thường không dùng được cho ' +
        'ứng dụng web. Camera USB hoặc camera của màn hình xe có thể dùng được, tuỳ máy.',
    ],
    [
      'Quyền riêng tư',
      'Mọi xử lý diễn ra trên máy, hình ảnh không được gửi đi và không được lưu (trừ khi bạn tự bật lưu ảnh biển để ' +
        'kiểm tra độ chính xác). Danh sách biển đã học cho thấy những nơi bạn đã ' +
        'đi; nó chỉ nằm trên máy này và xoá được bất cứ lúc nào.',
    ],
    [
      'Luật giao thông',
      'Chỉ chỉnh điện thoại khi xe đã đỗ. Không cầm hay bấm điện thoại khi đang lái.',
    ],
    [
      'Đang thử nghiệm',
      'Độ chính xác trên đường thật chưa được đo; camera có thể bỏ sót hoặc nhận nhầm biển.' +
        (mb ? ` Lần đầu chạy sẽ tải dữ liệu nhận diện, tối đa khoảng ${formatNumberVi(mb, 1)} MB.` : '') +
        ` ${OBEY_REAL_SIGNS}`,
    ],
  ];
}

/**
 * Đường chân trời (camAim, độ lệch tính bằng điểm ảnh của khung W×H so với điểm mặc định giữa khung, 0,42 chiều cao)
 * → vị trí trên hình xem trước, theo phần khung (0–1).
 */
export function aimToPoint(aim, W, H) {
  const dx = Number.isFinite(aim?.dx) ? aim.dx : 0;
  const dy = Number.isFinite(aim?.dy) ? aim.dy : 0;
  const clamp = (v) => Math.min(Math.max(v, 0), 1);
  if (!(W > 0) || !(H > 0)) return { x: 0.5, y: FOE_Y_FRAC };
  return { x: clamp(0.5 + dx / W), y: clamp(FOE_Y_FRAC + dy / H) };
}

/** Ngược lại: vị trí đã kéo (phần khung 0–1) → camAim { dx, dy } (điểm ảnh, số nguyên). */
export function pointToAim(fx, fy, W, H) {
  const clamp = (v) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1);
  if (!(W > 0) || !(H > 0)) return { dx: 0, dy: 0 };
  return { dx: Math.round((clamp(fx) - 0.5) * W), dy: Math.round((clamp(fy) - FOE_Y_FRAC) * H) };
}

/**
 * Giá trị đọc cho trình đọc màn hình của thanh kéo đường chân trời (dọc): độ cao tính từ mép dưới hình, theo phần
 * trăm, để phím mũi tên lên (dời đường lên) làm giá trị tăng. y: vị trí theo phần khung, 0 = mép trên.
 */
export function aimAria(y) {
  const v = 100 - Math.round(Math.min(Math.max(Number.isFinite(y) ? y : FOE_Y_FRAC, 0), 1) * 100);
  return { now: String(v), text: `Đường chân trời ở ${v}% chiều cao hình, tính từ mép dưới` };
}

/** Dòng trong danh sách → điểm cho lớp biển đã học trên bản đồ. Biển chưa xác nhận vẽ nét đứt, nhạt hơn. */
export function learnedFeatures(rows) {
  const out = [];
  for (const r of rows || []) {
    const entry = lookupSign(r.code);
    if (!entry || !Array.isArray(r.coord)) continue;
    out.push({ id: r.id, coord: r.coord, quiet: r.status !== 'confirmed', art: entry.art, value: r.value ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phần DOM
// ---------------------------------------------------------------------------------------------

/** Tạo phần tử DOM; chữ luôn đi qua textContent (như el() của main.js). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // chỉ SVG do ứng dụng tự sinh
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v != null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const iconBtn = (cls, icon, label, onclick) =>
  el('button', { class: cls, type: 'button', onclick }, icon ? el('span', { html: lineIcon(icon, 18) }) : null, el('span', {}, label));

/** Huy hiệu camera nhỏ trên hình biển do camera ghi nhận (thanh cảnh báo, dải biển). */
export function camBadge() {
  return el('span', { class: 'cam-badge', role: 'img', 'aria-label': 'Camera ghi nhận', html: lineIcon('camera', 12) });
}

function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function introSeen() {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function markIntroSeen() {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    // trình duyệt chặn bộ nhớ: lần sau lại hiện lời giới thiệu
  }
}

/**
 * Gắn giao diện camera vào trang. ctl: CameraController. deps: { store, map (MapView, có thể null), openModal(title,
 * body), closeOverlays(), toast(msg) } của main.js. Trả { render }.
 */
export function initCamUi(ctl, { store, map = null, openModal, closeOverlays, toast }) {
  const $ = (id) => document.getElementById(id);
  let st = ctl.state;
  // Hộp thoại đang hiện của tệp này: { kind: 'intro'|'check'|'review'|'export'|'clear', body, … } hoặc null.
  let view = null;
  let layerShown = false;

  const modalOpen = (kind) => Boolean(view && view.kind === kind && !$('modal').hidden && $('modalBody').contains(view.body));

  function show(kind, title, body, extra = {}) {
    if (view?.kind === 'check' && kind !== 'check') endCheck();
    view = { kind, body, ...extra };
    openModal(title, body);
  }

  /** Đóng riêng hộp thoại (bảng Cài đặt bên dưới vẫn mở): như bấm nút Quay lại. */
  function closeModal() {
    if (!$('modal').hidden) history.back();
  }

  function onModalGone() {
    if (!view) return;
    if (view.kind === 'check') endCheck();
    view = null;
  }

  const watchModal = () => {
    if (view && ($('modal').hidden || !$('modalBody').contains(view.body))) onModalGone();
  };
  new MutationObserver(watchModal).observe($('modal'), { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(watchModal).observe($('modalBody'), { childList: true });

  // ---------- Mục trong Cài đặt ----------

  function renderSettings() {
    const v = settingsView(st);
    const sw = $('optCamEnabled');
    sw.checked = v.switchOn;
    sw.disabled = v.switchDisabled;
    $('camEnableHint').textContent = v.switchHint;
    const status = $('camStatus');
    status.parentElement.hidden = !v.statusShown;
    status.textContent = st.text;
    status.classList.toggle('ok', st.enabled && chipState(st) === 'on');
    status.classList.toggle('warn', st.enabled && chipState(st) === 'off');
    $('btnCamCheck').disabled = v.checkDisabled;
    $('optSignCamera').checked = st.signCamera;
    $('optCamSpeed').checked = st.camSpeed;
    $('camLearnedCount').textContent = countText(st.counts);
    $('btnCamList').disabled = v.storeDisabled;
    $('btnCamImport').disabled = v.storeDisabled;
    $('btnCamExport').disabled = v.exportDisabled;
    $('camParkedHint').hidden = !v.parkedHint;
    $('camEvalCount').hidden = !v.evalShown;
    $('camEvalCount').textContent = evalCountText(st.evalCount);
    $('btnCamEvalClear').parentElement.hidden = !v.evalShown;
  }

  async function clearEval() {
    await ctl.evalClear(); // luôn được
    toast(UI_TEXT.evalCleared);
  }

  function onSwitch(e) {
    const want = e.target.checked;
    e.target.checked = st.enabled; // công tắc luôn theo trạng thái thật
    if (!want) {
      ctl.disable();
      toast(UI_TEXT.disabled);
      return;
    }
    if (!ctl.isParked()) {
      toast(TEXT.notParked);
      return;
    }
    if (!introSeen()) openIntro();
    else doEnable();
  }

  /** Bật camera: phải gọi ngay trong lần bấm (trình duyệt có thể hỏi quyền). */
  function doEnable() {
    const p = ctl.enable();
    markIntroSeen();
    p.then((res) => {
      if (modalOpen('intro')) closeModal();
      if (!res.ok) {
        toast(res.text || TEXT.off, 5000);
        return;
      }
      const awake = $('optAwake');
      if (awake) awake.checked = store.settings.keepAwake === true; // công tắc ở mục Hiển thị
      toast(res.keepAwake ? UI_TEXT.keepAwakeOn : UI_TEXT.enabled, 5000);
    });
  }

  function openIntro() {
    const body = el('div', { class: 'view cam-intro' });
    for (const [head, text] of introParagraphs()) body.append(el('p', { class: 'note' }, el('b', {}, `${head}. `), text));
    body.append(
      el(
        'div',
        { class: 'row wrap' },
        el('button', { class: 'btn primary grow', type: 'button', onclick: () => (ctl.isParked() ? doEnable() : toast(TEXT.notParked)) }, 'Bật camera'),
        el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Để sau')
      )
    );
    show('intro', 'Camera nhận diện biển', body);
  }

  // ---------- Kiểm tra camera ----------

  function openCheck() {
    if (!ctl.isParked()) {
      toast(TEXT.parkedOnly);
      return;
    }
    const video = el('video', { playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const msg = el('div', { class: 'cam-preview-msg' }, UI_TEXT.checkOpening);
    const horizon = el('div', { class: 'cam-horizon' });
    const foe = el('div', { class: 'cam-foe' });
    const aim = el('div', { class: 'cam-aim', tabindex: '0', role: 'slider', 'aria-orientation': 'vertical', 'aria-label': 'Đường chân trời', 'aria-valuemin': '0', 'aria-valuemax': '100' }, horizon, foe);
    aim.hidden = true;
    const box = el('div', { class: 'cam-preview' }, video, aim, msg);
    const picker = el('select', { id: 'camPicker' });
    const pickerRow = el('label', { class: 'cam-pick' }, el('span', {}, 'Camera dùng để nhận diện'), picker);
    const stats = el('div', { class: 'stats cam-stats' });
    const extra = el('div', { class: 'cam-extra' });
    const statusP = el('p', { class: 'note', role: 'status' });
    const measureBtn = el('button', { class: 'btn primary', type: 'button' }, UI_TEXT.measure);
    const resetBtn = el('button', { class: 'btn', type: 'button' }, 'Đặt lại đường chân trời');
    const reopenBtn = el('button', { class: 'btn primary', type: 'button' }, UI_TEXT.reopen);
    reopenBtn.hidden = true;
    const evalSw = el('input', { id: 'optCamEval', type: 'checkbox', class: 'switch' });
    const evalCount = el('p', { class: 'note' });
    const evalExport = iconBtn('btn', 'share', 'Xuất ảnh', null);
    const evalClear = iconBtn('btn', 'trash', EVAL_TEXT.clear, null);
    const body = el(
      'div',
      { class: 'view cam-check' },
      box,
      el('p', { class: 'note' }, UI_TEXT.aimHelp),
      el('p', { class: 'note' }, UI_TEXT.mount),
      pickerRow,
      stats,
      extra,
      el('div', { class: 'row wrap' }, reopenBtn, measureBtn, resetBtn),
      statusP,
      el('h3', { class: 'cam-sub' }, 'Kiểm tra độ chính xác'),
      el('label', { class: 'opt' }, el('span', {}, EVAL_TEXT.setting, el('small', {}, EVAL_TEXT.note)), evalSw),
      evalCount,
      el('p', { class: 'note warn' }, EVAL_TEXT.exportWarning),
      el('div', { class: 'row wrap' }, evalExport, evalClear),
      el('p', { class: 'note' }, OBEY_REAL_SIGNS)
    );
    const ui = { video, msg, aim, horizon, foe, box, picker, stats, extra, statusP, measureBtn, reopenBtn, evalSw, evalCount, evalExport, gen: 0, live: false, closed: false, W: 0, H: 0, info: {}, measure: null, measuring: false };
    show('check', 'Kiểm tra camera', body, { ui });
    bindAim(ui);
    picker.addEventListener('change', () => {
      const id = picker.value || null;
      const r = ctl.setDevice(id);
      if (!r.ok) {
        toast(r.text || TEXT.parkedOnly);
        return;
      }
      startPreview(ui, id);
    });
    measureBtn.addEventListener('click', () => runMeasure(ui));
    // Mở lại luồng xem trước đã bị đóng khi ứng dụng bị ẩn: chỉ từ lần bấm này (không bao giờ tự mở lại).
    reopenBtn.addEventListener('click', () => {
      if (!ctl.isParked()) {
        toast(TEXT.parkedOnly);
        return;
      }
      startPreview(ui, undefined);
    });
    resetBtn.addEventListener('click', () => {
      store.set('camAim', { dx: 0, dy: 0 });
      placeAim(ui);
      statusP.textContent = UI_TEXT.aimSaved;
    });
    evalSw.addEventListener('change', () => {
      const on = evalSw.checked;
      if (on && !ctl.isParked()) {
        evalSw.checked = false;
        toast(TEXT.parkedOnly);
        return;
      }
      store.set('camEval', on);
    });
    evalExport.addEventListener('click', async () => {
      const res = await ctl.evalExport();
      if (!res.ok) return toast(res.text || TEXT.parkedOnly);
      saveFile(res.blob, res.filename);
    });
    evalClear.addEventListener('click', clearEval);
    renderCheck();
    startPreview(ui, undefined); // ngay trong lần bấm: trình duyệt có thể hỏi quyền
  }

  function startPreview(ui, deviceId) {
    const gen = ++ui.gen;
    ui.live = false;
    ui.closed = false;
    ui.reopenBtn.hidden = true;
    ui.aim.hidden = true;
    ui.msg.hidden = false;
    ui.msg.textContent = UI_TEXT.checkOpening;
    ui.video.srcObject = null;
    ui.measure = null;
    ctl.openCheck(deviceId === undefined ? {} : { deviceId }).then((res) => {
      if (gen !== ui.gen || !modalOpen('check')) {
        if (res.ok && gen === ui.gen) ctl.closeCheck();
        return;
      }
      if (!res.ok) {
        ui.msg.textContent = res.text || TEXT.parkedOnly;
        return;
      }
      ui.live = true;
      ui.info = { width: res.settings.width, height: res.settings.height, fps: res.settings.frameRate, rangeText: res.rangeText };
      ui.video.srcObject = res.stream;
      ui.video.addEventListener(
        'loadedmetadata',
        () => {
          if (gen !== ui.gen) return;
          ui.W = ui.video.videoWidth || ui.info.width || 0;
          ui.H = ui.video.videoHeight || ui.info.height || 0;
          if (ui.W && ui.H) ui.box.style.aspectRatio = `${ui.W} / ${ui.H}`;
          ui.msg.hidden = true;
          ui.aim.hidden = false;
          placeAim(ui);
          renderCheck();
        },
        { once: true }
      );
      ui.video.play().catch(() => {});
      fillPicker(ui, res.devices);
      renderCheck();
    });
  }

  function fillPicker(ui, devices) {
    const saved = store.settings.camDeviceId ?? '';
    const opts = [el('option', { value: '' }, UI_TEXT.defaultCamera)];
    (devices || []).forEach((d, i) => {
      if (!d.deviceId) return;
      opts.push(el('option', { value: d.deviceId }, d.label || `Camera ${i + 1}`));
    });
    ui.picker.replaceChildren(...opts);
    ui.picker.value = saved && opts.some((o) => o.value === saved) ? saved : '';
  }

  function placeAim(ui) {
    const p = aimToPoint(store.settings.camAim, ui.W, ui.H);
    ui.horizon.style.top = `${p.y * 100}%`;
    ui.foe.style.left = `${p.x * 100}%`;
    ui.foe.style.top = `${p.y * 100}%`;
    setAimAria(ui, p.y);
  }

  function setAimAria(ui, y) {
    const a = aimAria(y);
    ui.aim.setAttribute('aria-valuenow', a.now);
    ui.aim.setAttribute('aria-valuetext', a.text);
  }

  function bindAim(ui) {
    let drag = false;
    const at = (e) => {
      const r = ui.aim.getBoundingClientRect();
      return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
    };
    const move = (fx, fy) => {
      const a = pointToAim(fx, fy, ui.W, ui.H);
      const p = aimToPoint(a, ui.W, ui.H);
      ui.horizon.style.top = `${p.y * 100}%`;
      ui.foe.style.left = `${p.x * 100}%`;
      ui.foe.style.top = `${p.y * 100}%`;
      setAimAria(ui, p.y);
      return a;
    };
    const save = (a) => {
      if (!ctl.isParked()) return;
      store.set('camAim', a); // đối tượng mới mỗi lần (store.js)
      ui.statusP.textContent = UI_TEXT.aimSaved;
    };
    ui.aim.addEventListener('pointerdown', (e) => {
      if (!ui.live) return;
      drag = true;
      ui.aim.setPointerCapture?.(e.pointerId);
      const { fx, fy } = at(e);
      move(fx, fy);
    });
    ui.aim.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { fx, fy } = at(e);
      move(fx, fy);
    });
    const end = (e) => {
      if (!drag) return;
      drag = false;
      const { fx, fy } = at(e);
      save(move(fx, fy));
    };
    ui.aim.addEventListener('pointerup', end);
    ui.aim.addEventListener('pointercancel', () => {
      drag = false;
      placeAim(ui);
    });
    ui.aim.addEventListener('keydown', (e) => {
      if (!ui.live || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const p = aimToPoint(store.settings.camAim, ui.W, ui.H);
      const fy = p.y + (e.key === 'ArrowUp' ? -AIM_KEY_STEP : AIM_KEY_STEP);
      save(move(p.x, fy));
      placeAim(ui);
    });
  }

  async function runMeasure(ui) {
    if (ui.measuring || !ui.live) return;
    ui.measuring = true;
    renderCheck();
    const total = 2 * CHECK_FRAMES;
    ui.statusP.textContent = `${UI_TEXT.measuring}… 0/${total}`;
    const res = await ctl.measureCheck({
      frames: CHECK_FRAMES,
      video: ui.video,
      onProgress: (p) => {
        ui.statusP.textContent = `${UI_TEXT.measuring}… ${p.done}/${p.total}`;
      },
    });
    ui.measuring = false;
    if (!modalOpen('check')) return;
    if (!res.ok) {
      ui.statusP.textContent = res.text || '';
    } else {
      ui.measure = res;
      ui.statusP.textContent = 'Đã đo xong.';
    }
    renderCheck();
  }

  function renderCheck() {
    if (!modalOpen('check')) return;
    const ui = view.ui;
    if (ui.live && st.check !== 'open') {
      // Xe bắt đầu chạy hoặc ứng dụng bị ẩn: bộ điều phối đã đóng luồng kiểm tra.
      const closed = checkClosedView(st);
      ui.live = false;
      ui.closed = true;
      ui.gen++;
      ui.video.srcObject = null;
      ui.aim.hidden = true;
      ui.msg.hidden = false;
      ui.msg.textContent = closed.text;
    }
    ui.reopenBtn.hidden = !(ui.closed && !ui.live && st.parked);
    const m = ui.measure;
    const w = m?.width || ui.W || ui.info.width;
    const h = m?.height || ui.H || ui.info.height;
    const fps = m?.fps ?? ui.info.fps;
    const range = m?.rangeText || ui.info.rangeText;
    const stat = (big, small) => el('div', { class: 'stat' }, el('b', {}, big), el('span', {}, small));
    const cells = [
      stat(w && h ? `${w}×${h}` : '—', 'Độ phân giải'),
      stat(Number.isFinite(fps) ? `${formatNumberVi(fps, 0)}` : '—', 'Khung hình mỗi giây'),
      stat(m ? msText(m.p50) : '—', 'Xử lý, trung vị'),
      stat(m ? msText(m.p90) : '—', 'Xử lý, 90 % khung'),
    ];
    ui.stats.replaceChildren(...cells);
    const notes = [];
    if (range) notes.push(el('p', { class: 'note' }, range));
    if (m) {
      notes.push(el('p', { class: 'note' }, `Lượt quét chính: ${passText(m.passes.A)}. Hai lượt: ${passText(m.passes.AB)}.`));
      notes.push(el('p', { class: 'note' }, `Khi lái dùng ${levelText(m.level)}; máy này dùng được tới ${levelText(m.maxLevel)}.`));
    }
    ui.extra.replaceChildren(...notes);
    ui.measureBtn.disabled = !ui.live || ui.measuring || !st.parked;
    ui.evalSw.checked = st.camEval;
    ui.evalCount.textContent = evalCountText(st.evalCount);
    ui.evalExport.disabled = !st.parked || !st.evalCount;
  }

  function endCheck() {
    const ui = view?.ui;
    if (ui) {
      ui.gen++;
      ui.live = false;
      ui.video.srcObject = null;
    }
    ctl.closeCheck();
  }

  // ---------- Danh sách "Biển camera ghi nhận" ----------

  function openReview() {
    if (!ctl.isParked()) {
      toast(TEXT.parkedOnly);
      return;
    }
    const body = el('div', { class: 'view cam-review' });
    show('review', 'Biển camera ghi nhận', body, { key: '' });
    renderReview(true);
  }

  function renderReview(force = false) {
    if (!modalOpen('review')) return;
    const key = `${st.parked}|${JSON.stringify(st.counts)}`;
    if (!force && key === view.key) return;
    view.key = key;
    const rows = ctl.list();
    const parked = st.parked;
    const body = view.body;
    const scroll = body.closest('.modal-card')?.scrollTop ?? 0;
    const parts = [];
    if (!parked) parts.push(el('p', { class: 'note warn' }, TEXT.parkedOnly));
    if (!rows.length) parts.push(el('p', { class: 'empty' }, UI_TEXT.empty));
    for (const row of rows.slice(0, REVIEW_MAX_ROWS)) parts.push(reviewRow(row, parked));
    if (rows.length > REVIEW_MAX_ROWS) {
      parts.push(el('p', { class: 'note' }, `Đang hiện ${num(REVIEW_MAX_ROWS)} biển gần nhất trong số ${num(rows.length)} biển.`));
    }
    parts.push(el('p', { class: 'note' }, OBEY_REAL_SIGNS));
    body.replaceChildren(...parts);
    const card = body.closest('.modal-card');
    if (card) card.scrollTop = scroll;
  }

  function reviewRow(row, parked) {
    const entry = lookupSign(row.code);
    const title = rowTitle(row);
    const confirmed = row.status === 'confirmed';
    const status = el('span', { class: `lstatus${confirmed ? ' ok' : ' quiet'}` }, rowStatus(row));
    const act = (label, fn, cls = 'btn small') =>
      el('button', { class: cls, type: 'button', disabled: !parked, onclick: () => fn(row) }, label);
    const actions = el('div', { class: 'lrow-actions' });
    if (map?.map) {
      actions.append(
        el(
          'button',
          // Chữ ngắn để bốn nút nằm một hàng trên điện thoại; tên đầy đủ cho trình đọc màn hình và khi rê chuột.
          { class: 'btn small', type: 'button', disabled: !parked, onclick: () => showOnMap(row), 'aria-label': 'Xem trên bản đồ', title: 'Xem trên bản đồ' },
          el('span', { html: lineIcon('pin', 16) }),
          el('span', {}, 'Bản đồ')
        )
      );
    }
    if (!confirmed) actions.append(act('Đúng', doConfirm));
    actions.append(act('Sai', doReject), act('Biển đã bị dỡ', doRemoved));
    return el(
      'div',
      { class: `lrow${confirmed ? '' : ' quiet'}` },
      el(
        'div',
        { class: 'lrow-main' },
        el('span', { class: 'lrow-art', html: entry ? signSvg(entry.art, { size: 44, value: row.value, title }) : '' }),
        el('div', { class: 'lrow-text' }, el('div', { class: 'lrow-name' }, title), status, el('div', { class: 'lrow-meta' }, seenLine(row))),
        row.distance != null ? el('span', { class: 'lrow-dist' }, formatDistance(row.distance)) : null
      ),
      actions
    );
  }

  const after = (res, okText) => {
    if (!res.ok) toast(res.text || 'Không tìm thấy biển này.');
    else toast(okText);
    renderReview(true);
    if (layerShown) refreshLayer();
  };
  const doConfirm = (row) => after(ctl.confirm(row.id), UI_TEXT.confirmed);
  const doReject = (row) => after(ctl.reject(row.id), UI_TEXT.rejected);
  const doRemoved = (row) => after(ctl.removed(row.id), UI_TEXT.removed);

  // ---------- Lớp biển đã học trên bản đồ (chỉ hiện khi người dùng bấm "Xem trên bản đồ") ----------

  function refreshLayer() {
    if (!map?.setLearned) return;
    map.setLearned(learnedFeatures(ctl.list()));
  }

  function showOnMap(row) {
    if (!ctl.isParked() || !map?.map) return;
    refreshLayer();
    layerShown = true;
    $('learnedLayer').hidden = false;
    closeOverlays();
    map.flyTo(row.coord, LEARNED_ZOOM);
  }

  function hideLayer() {
    layerShown = false;
    $('learnedLayer').hidden = true;
    map?.clearLearned?.();
  }

  // ---------- Xuất, nhập, xoá ----------

  function openExport() {
    if (!ctl.isParked()) return toast(TEXT.parkedOnly);
    const dates = el('input', { id: 'optCamDates', type: 'checkbox', class: 'switch' });
    const n = st.counts.learned;
    const body = el(
      'div',
      { class: 'view' },
      el('p', { class: 'sub' }, `Tệp GeoJSON gồm ${num(n)} biển đang lưu trên máy này (gồm cả biển đã nhập từ tệp, nếu có).`),
      el('p', { class: 'note warn' }, EXPORT_WARNING[0]),
      el('p', { class: 'note' }, EXPORT_WARNING[1]),
      el('label', { class: 'opt' }, el('span', {}, UI_TEXT.withDates, el('small', {}, UI_TEXT.withDatesHint)), dates),
      el(
        'div',
        { class: 'row wrap' },
        iconBtn('btn primary grow', 'share', UI_TEXT.save, () => {
          const res = ctl.exportGeoJSON({ withDates: dates.checked });
          if (!res.ok) return toast(res.text || TEXT.parkedOnly);
          saveFile(new Blob([res.json], { type: 'application/geo+json' }), res.filename);
          closeModal();
          toast(`Đã lưu tệp ${num(res.count)} biển.`);
        }),
        el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Huỷ')
      )
    );
    show('export', UI_TEXT.exportTitle, body);
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bad = importFileError(file);
    if (bad) return toast(bad, 5000);
    if (!ctl.isParked()) return toast(TEXT.parkedOnly);
    let text;
    try {
      text = await file.text();
    } catch {
      return toast(importText({ error: 'bad-json' }), 5000);
    }
    const res = ctl.importGeoJSON(text);
    toast(res.ok === false && res.reason === 'not-parked' ? res.text : importResultText(res), 5000);
    if (layerShown) refreshLayer();
  }

  function openClear() {
    const n = st.counts.learned;
    // Còn ảnh kiểm tra đã lưu: hộp này nói rõ và cho xoá luôn (chọn sẵn), không âm thầm xoá hay bỏ sót.
    const evalBox = st.evalCount > 0 ? el('input', { type: 'checkbox', class: 'switch', checked: true }) : null;
    const body = el(
      'div',
      { class: 'view' },
      el('p', { class: 'sub' }, n ? `Xoá hết ${num(n)} biển đang lưu trên máy này (gồm cả biển đã nhập từ tệp, nếu có). Không khôi phục được.` : UI_TEXT.empty),
      evalBox ? el('label', { class: 'opt' }, el('span', {}, clearEvalText(st.evalCount)), evalBox) : null,
      el(
        'div',
        { class: 'row wrap' },
        iconBtn('btn danger grow', 'trash', 'Xoá', async () => {
          if (evalBox?.checked) await ctl.evalClear();
          await ctl.clear();
          hideLayer();
          closeModal();
          toast(UI_TEXT.clearDone);
        }),
        el('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Huỷ')
      )
    );
    show('clear', UI_TEXT.clearTitle, body);
  }

  // ---------- Nút camera nhỏ lúc lái ----------

  let chipKind = '';
  function renderChip() {
    const kind = chipState(st);
    const warn = chipWarning(st);
    const chip = $('btnCamChip');
    chip.hidden = kind === 'hidden';
    const key = `${kind}|${warn || ''}`;
    if (key === chipKind) {
      chip.title = st.text;
      return;
    }
    chipKind = key;
    chip.classList.toggle('cam-on', kind === 'on');
    chip.classList.toggle('cam-warn', Boolean(warn));
    chip.classList.toggle('cam-paused', kind === 'paused');
    chip.classList.toggle('cam-off', kind === 'off');
    chip.firstElementChild.innerHTML = lineIcon(kind === 'off' ? 'camera-off' : 'camera');
    chip.setAttribute('aria-label', chipLabel(kind, warn));
    chip.title = st.text;
  }

  // ---------- Gắn sự kiện ----------

  $('camIntroNote').textContent = UI_TEXT.intro;
  $('camPermNote').textContent = UI_TEXT.permission;
  $('camRunNote').textContent = runNote();
  $('optCamEnabled').addEventListener('change', onSwitch);
  $('btnCamCheck').addEventListener('click', openCheck);
  $('optSignCamera').addEventListener('change', (e) => store.set('signCamera', e.target.checked));
  $('optCamSpeed').addEventListener('change', (e) => store.set('camSpeed', e.target.checked));
  $('btnCamList').addEventListener('click', openReview);
  $('btnCamExport').addEventListener('click', openExport);
  $('btnCamImport').addEventListener('click', () => {
    if (!ctl.isParked()) return toast(TEXT.parkedOnly);
    $('camImportFile').click();
  });
  $('camImportFile').addEventListener('change', onImportFile);
  $('btnCamClear').addEventListener('click', openClear);
  $('btnCamEvalClear').lastElementChild.textContent = EVAL_TEXT.clear;
  $('btnCamEvalClear').addEventListener('click', clearEval);
  $('btnCamChip').addEventListener('click', () => {
    ctl.disable(); // luôn được, một lần chạm
    toast(UI_TEXT.disabled);
  });
  $('btnLearnedList').addEventListener('click', openReview);
  $('btnLearnedHide').addEventListener('click', hideLayer);

  function render() {
    st = ctl.state;
    renderAll();
  }

  function renderAll() {
    renderChip();
    if (!$('settingsPanel').hidden) renderSettings();
    if (view?.kind === 'check') renderCheck();
    if (view?.kind === 'review') renderReview();
    if (layerShown && !st.parked) hideLayer(); // xe chạy: thôi hiện lớp biển đã học
  }

  ctl.onChange((s) => {
    st = s;
    renderAll();
  });
  // Mở bảng Cài đặt: vẽ lại mục camera theo trạng thái mới nhất.
  new MutationObserver(() => {
    if (!$('settingsPanel').hidden) render();
  }).observe($('settingsPanel'), { attributes: true, attributeFilter: ['hidden'] });
  render();
  renderSettings();
  return { render };
}

