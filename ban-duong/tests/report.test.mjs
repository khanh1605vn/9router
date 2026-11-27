// Nút "Báo cáo": chỉ "Camera ở đây" khi đang chạy, lưu trên máy (điểm tự đánh dấu), chữ chia sẻ và đường dẫn GitHub
// (mã hoá, giới hạn độ dài, không lộ thông tin riêng), tệp xuất cho kho dữ liệu, và công cụ gộp của chủ ứng dụng.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destination } from '../js/geo.js';
import { normalizeItem, validateCommunity } from '../js/communitydata.js';
import {
  captureHeading,
  communityItem,
  COMMUNITY_TYPE_OF,
  exportForRepo,
  githubIssueUrl,
  ISSUE_URL,
  localPointInfo,
  MAX_TITLE,
  MAX_URL,
  osmLink,
  QUICK_KMH,
  QUICK_TYPE,
  REPORT_MENU,
  REPORT_SOURCE,
  reportLabel,
  reportMode,
  sendable,
  shareText,
} from '../js/report.js';
import { REPORT_TYPES, reportExtra, store } from '../js/store.js';
import { DEDUPE_M, formatCommunity, mergeReports, parseInput, reviewLines } from '../tools/community/add-reports.mjs';

const TODAY = '2026-11-27';
const HN = [105.854201, 21.028512];
// 27/11/2026 14:37:12 giờ máy: giờ phút không bao giờ được lộ ra ngoài.
const T = new Date(2026, 10, 27, 14, 37, 12).getTime();
const rep = (over = {}) => ({ id: `r${T.toString(36)}abcd`, type: 'camspeed', coord: HN, time: T, ...over });

test('chế độ nút Báo cáo theo tốc độ: nhanh hơn 10 km/h chỉ còn "Camera ở đây"', () => {
  assert.equal(QUICK_KMH, 10);
  for (const v of [null, undefined, NaN, 0, 5, 10]) assert.equal(reportMode(v), 'full', String(v));
  for (const v of [10.1, 30, 120]) assert.equal(reportMode(v), 'quick', String(v));
  assert.equal(REPORT_TYPES[QUICK_TYPE].label, 'Camera phạt nguội');
  assert.deepEqual(REPORT_MENU, ['camspeed', 'camred', 'signnew', 'signgone', 'speed', 'closure']);
  for (const t of REPORT_MENU) assert.ok(REPORT_TYPES[t], t);
});

test('main.js: đang chạy nhanh thì nút Báo cáo và hộp đang mở thu về "Camera ở đây", không gửi gì', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(src, /if \(reportMode\(currentKmh\(\)\) === 'quick'\) openQuickReport\(\);\s*else openFullReport\(\);/);
  const quick = src.slice(src.indexOf('function openQuickReport'), src.indexOf('function openFullReport'));
  assert.match(quick, /saveReport\(QUICK_TYPE\)/);
  assert.doesNotMatch(quick, /share|clipboard|github|sendBox/i);
  assert.match(src, /guardReportWhileMoving\(\);/);
  assert.match(src, /sendable\(report\.type\) && reportMode\(currentKmh\(\)\) === 'full' \? sendBox\(report\) : null/);
});

test('hướng xe chạy chỉ lưu khi GPS đủ nhanh', () => {
  assert.equal(captureHeading({ heading: 91.6, speed: 5 }), 92);
  assert.equal(captureHeading({ heading: 359.7, speed: 5 }), 0);
  assert.equal(captureHeading({ heading: -10, speed: 5 }), 350);
  assert.equal(captureHeading({ heading: 90, speed: 1 }), null);
  assert.equal(captureHeading({ heading: null, speed: 9 }), null);
  assert.equal(captureHeading(null), null);
});

test('lưu trên máy: điểm tự đánh dấu kèm hướng, tốc độ, mã biển đã lọc', () => {
  assert.deepEqual(reportExtra('camspeed', { direction: 361.4 }), { direction: 1 });
  assert.deepEqual(reportExtra('speed', { value: 60, code: 'P.103a' }), { value: 60 });
  assert.deepEqual(reportExtra('speed', { value: 62 }), {});
  assert.deepEqual(reportExtra('signnew', { code: ' P.103a ' }), { code: 'P.103a' });
  assert.deepEqual(reportExtra('signnew', { code: '<b>' }), {});
  assert.deepEqual(reportExtra('camera', { value: 60, direction: 'x', name: 'An', phone: '0901' }), {});
  store.reports = [];
  const r = store.addReport('speed', HN, { value: 70, direction: 180 });
  assert.equal(r.value, 70);
  assert.equal(r.direction, 180);
  assert.deepEqual(r.coord, [105.854201, 21.028512]);
  // Nhập tệp: giữ thông tin thêm hợp lệ; "tốc độ đổi" không có trị số bị bỏ.
  store.reports = [];
  const added = store.importReports([
    { type: 'camspeed', coord: [106.7, 10.77], direction: 45, time: T },
    { type: 'speed', coord: [106.71, 10.77] },
    { type: 'speed', coord: [106.72, 10.77], value: 50 },
    { type: 'nope', coord: [106.73, 10.77] },
  ]);
  assert.equal(added, 2);
  assert.equal(store.reports[0].direction, 45);
  assert.equal(store.reports[1].value, 50);
  store.reports = [];
});

test('điểm tự đánh dấu "Biển báo đã tháo" không báo khi lái', () => {
  assert.equal(REPORT_TYPES.signgone.warn, false);
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(src, /REPORT_TYPES\[p\.type\]\?\.warn !== false/);
});

test('điểm tự đánh dấu có trị số hoặc mã biển: tên và câu đọc riêng', () => {
  assert.deepEqual(localPointInfo(rep({ type: 'speed', value: 60 })), {
    title: 'Tốc độ tối đa 60 km/h (bạn đánh dấu)',
    say: 'có biển tốc độ tối đa 60 ki lô mét trên giờ',
    icon: 'hazard',
  });
  assert.equal(localPointInfo(rep({ type: 'signnew', code: 'P.103a' })).title, 'Cấm xe ô tô (bạn đánh dấu)');
  assert.equal(localPointInfo(rep({ type: 'signnew' })), null);
  assert.equal(localPointInfo(rep({ type: 'camspeed' })), null);
  assert.equal(reportLabel(rep({ type: 'speed', value: 60 })), 'Tốc độ tối đa thay đổi: 60 km/h');
  assert.equal(reportLabel(rep({ type: 'signnew', code: 'P.103a' })), 'Biển báo mới: P.103a (Cấm xe ô tô)');
});

test('chữ chia sẻ: tiếng Việt, toạ độ 5 chữ số, đường dẫn OpenStreetMap, chỉ có ngày, dòng JSON đúng định dạng kho', () => {
  const text = shareText(rep({ direction: 92 }));
  const lines = text.split('\n');
  assert.equal(lines[0], 'Bạn Đường – báo cáo: Camera bắn tốc độ');
  assert.equal(lines[1], 'Vị trí: 21.02851, 105.85420 · hướng xe chạy 92°');
  assert.equal(lines[2], 'Ngày thấy: 27/11/2026');
  assert.equal(lines[3], 'Bản đồ: https://www.openstreetmap.org/?mlat=21.02851&mlon=105.85420#map=19/21.02851/105.85420');
  assert.equal(osmLink(HN), lines[3].slice('Bản đồ: '.length));
  const item = JSON.parse(lines.at(-1));
  assert.deepEqual(item, {
    type: 'camera-speed',
    coord: [105.8542, 21.02851],
    direction: 92,
    source: REPORT_SOURCE,
    verified: TODAY,
  });
  assert.ok(normalizeItem(item, TODAY).item);
  assert.match(shareText(rep({ type: 'signgone' })), /cần sửa bản đồ/);
  assert.doesNotMatch(shareText(rep({ type: 'signgone' })), /\{/); // không có mục cho kho
  assert.match(shareText(rep({ type: 'signnew' })), /Chưa rõ mã biển/);
});

test('riêng tư: không lộ giờ phút, mã điểm trên máy, tên, số điện thoại', () => {
  const r = rep({ name: 'Nguyễn Văn An', phone: '0901234567', account: 'an@example.com', direction: 10 });
  const outs = [shareText(r), decodeURIComponent(githubIssueUrl(r)), JSON.stringify(exportForRepo([r], { today: TODAY }))];
  for (const out of outs) {
    assert.doesNotMatch(out, /14:37|14 giờ|T14|:12/);
    assert.doesNotMatch(out, new RegExp(String(T)));
    assert.doesNotMatch(out, new RegExp(r.id));
    assert.doesNotMatch(out, /Nguyễn|0901234567|example\.com/);
    assert.doesNotMatch(out, /"time"|"id"/);
  }
});

test('đường dẫn GitHub: đúng kho, tiêu đề và nội dung mã hoá URL, có giới hạn độ dài', () => {
  const url = githubIssueUrl(rep({ type: 'speed', value: 60 }));
  assert.ok(url.startsWith(`${ISSUE_URL}?title=`));
  assert.equal(ISSUE_URL, 'https://github.com/khanh1605vn/9router/issues/new');
  assert.ok(url.length <= MAX_URL);
  assert.doesNotMatch(url.slice(ISSUE_URL.length + 1), /[\s#À-￿]/); // không còn khoảng trắng, #, chữ có dấu
  const q = new URL(url).searchParams;
  assert.equal(q.get('title'), 'Báo cáo: Tốc độ tối đa thay đổi: 60 km/h tại 21.02851, 105.85420');
  assert.ok(q.get('title').length <= MAX_TITLE);
  const body = q.get('body');
  assert.ok(body.startsWith('Bạn Đường – báo cáo: Tốc độ tối đa thay đổi: 60 km/h\n'));
  assert.match(body, /#map=19\//); // dấu # trong đường dẫn OSM nằm nguyên trong nội dung
  assert.match(body, /không kèm tên, số điện thoại hay giờ báo cáo, chỉ có ngày và vị trí; GitHub vẫn hiện giờ tạo issue\./);
  // Lời nhắc trong ứng dụng nói rõ issue có giờ tạo và gợi ý gửi sau hay gửi riêng.
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /hiện tên tài khoản GitHub của bạn và giờ tạo issue/);
  assert.match(main, /hãy gửi sau, hoặc gửi riêng cho chủ ứng dụng qua Zalo hay tệp xuất/);
  const parsed = parseInput(body);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].value, 60);
  // Tiêu đề dài (mã biển có tên dài) bị cắt.
  const long = new URL(githubIssueUrl(rep({ type: 'signnew', code: 'W.207b' }))).searchParams.get('title');
  assert.ok(long.length <= MAX_TITLE);
});

test('xuất cho kho dữ liệu: chỉ loại gửi được, theo định dạng mục của community.json', () => {
  const reports = [
    rep(),
    rep({ type: 'camera', coord: [106.7, 10.77] }),
    rep({ type: 'speed', value: 50, coord: [106.71, 10.77] }),
    rep({ type: 'signnew', code: 'P.103a', coord: [106.72, 10.77] }),
    rep({ type: 'signgone' }),
    rep({ type: 'school' }),
    rep({ type: 'jam' }),
    rep({ type: 'closure', coord: [106.73, 10.77] }),
  ];
  const out = exportForRepo(reports, { today: TODAY });
  assert.equal(out.schema, 1);
  assert.equal(out.kind, 'ban-duong-reports');
  assert.equal(out.exported, TODAY);
  assert.deepEqual(out.items.map((i) => i.type), ['camera-speed', 'camera-traffic', 'speed-limit', 'sign', 'closure']);
  for (const it of out.items) assert.ok(normalizeItem(it, TODAY).item, it.type);
  assert.equal(sendable('signgone'), true);
  assert.equal(communityItem(rep({ type: 'signgone' })), null);
  assert.equal(sendable('school'), false);
  assert.equal(COMMUNITY_TYPE_OF.camspeed, 'camera-speed');
});

// ---------------------------------------------------------------------------------------------
// Công cụ của chủ ứng dụng
// ---------------------------------------------------------------------------------------------

const EMPTY = { schema: 1, updated: '2026-11-01', items: [] };

test('công cụ: đọc tệp xuất, mảng, một mục, và chữ dán từ issue/Zalo', () => {
  const exp = exportForRepo([rep()], { today: TODAY });
  assert.equal(parseInput(JSON.stringify(exp)).items.length, 1);
  assert.equal(parseInput(JSON.stringify(exp.items)).items.length, 1);
  assert.equal(parseInput(JSON.stringify(exp.items[0])).items.length, 1);
  const pasted = `Chào anh,\n${shareText(rep())}\n\n${shareText(rep({ type: 'camred', coord: [106.7, 10.77] }))}\n\`${JSON.stringify(exp.items[0])}\`\n{hỏng}`;
  const p = parseInput(pasted);
  assert.equal(p.items.length, 3);
  assert.deepEqual(p.errors, ['dòng 14: JSON sai']);
});

test('công cụ: gộp, đặt ngày xác minh, gộp trùng trong 20 m cùng loại, từ chối mục sai', () => {
  const near = destination([105.8542, 21.02851], 0, DEDUPE_M - 5);
  const far = destination([105.8542, 21.02851], 0, DEDUPE_M + 10);
  const raws = [
    communityItem(rep()),
    { ...communityItem(rep()), coord: near }, // trùng
    { ...communityItem(rep()), coord: far }, // không trùng
    { ...communityItem(rep()), type: 'camera-redlight' }, // khác loại cùng chỗ
    { ...communityItem(rep({ type: 'speed', value: 60 })), value: 62 }, // sai
    communityItem(rep({ type: 'signnew' })), // thiếu mã biển
    { type: 'hazard', coord: [0, 0], source: 's' }, // ngoài Việt Nam
    'chuỗi',
  ];
  const res = mergeReports(EMPTY, raws, { today: TODAY, verified: '2026-11-26' });
  assert.equal(res.added, 3);
  assert.equal(res.confirmed, 1);
  assert.deepEqual(res.rejected.map((r) => r.index), [4, 5, 6, 7]);
  assert.match(res.rejected[1].reason, /mã biển/);
  assert.equal(res.doc.updated, TODAY);
  for (const it of res.doc.items) assert.equal(it.verified, '2026-11-26');
  assert.equal(new Set(res.doc.items.map((i) => i.id)).size, 3);
  const check = validateCommunity(res.text, { today: TODAY });
  assert.equal(check.ok, true);
  assert.equal(check.data.items.length, 3);
  // Gộp lại cùng mục ngày sau: chỉ cập nhật ngày xác minh.
  const again = mergeReports(res.doc, [communityItem(rep())], { today: TODAY });
  assert.equal(again.added, 0);
  assert.equal(again.confirmed, 1);
  assert.equal(again.doc.items[0].verified, TODAY);
  // Nguồn ghi đè và ngày tương lai bị từ chối.
  assert.equal(mergeReports(EMPTY, [communityItem(rep())], { today: TODAY, source: 'Chủ ứng dụng khảo sát' }).doc.items[0].source, 'Chủ ứng dụng khảo sát');
  assert.throws(() => mergeReports(EMPTY, [], { today: TODAY, verified: '2026-12-30' }), /tương lai/);
  assert.throws(() => mergeReports(EMPTY, [], { today: TODAY, verified: '30/11/2026' }), /YYYY-MM-DD/);
  assert.throws(() => mergeReports(EMPTY, [], { today: TODAY, until: '31/12/2026' }), /--until/);
});

test('công cụ: chữ tự do, nguồn và ngày của người gửi không bao giờ vào tệp đăng lên', () => {
  // Một dòng JSON tự viết dán trong issue: ghi chú lộ địa chỉ, số điện thoại "nộp phạt", nguồn giả danh cơ quan.
  const forged = {
    type: 'camera-speed',
    coord: [105.85, 21.03],
    direction: 90,
    value: 50,
    note: 'Nhà tôi ở số 12 ngõ 5 Hàng Bông, gọi 0912345678 để nộp phạt nhanh',
    source: 'Cục CSGT xác nhận chính thức',
    until: '2099-12-31',
    verified: '2020-01-01',
    id: 'gia-mao',
    extra: '<b>x</b>',
  };
  const res = mergeReports(EMPTY, [forged], { today: TODAY });
  assert.equal(res.added, 1);
  const it = res.doc.items[0];
  assert.deepEqual(Object.keys(it).sort(), ['coord', 'direction', 'id', 'source', 'type', 'value', 'verified']);
  assert.equal(it.source, REPORT_SOURCE);
  assert.equal(it.verified, TODAY);
  assert.notEqual(it.id, 'gia-mao');
  assert.doesNotMatch(res.text, /0912345678|Hàng Bông|Cục CSGT|2099/);
  // --source ghi đè nguồn; ghi chú và ngày hết hiệu lực chỉ do chủ ứng dụng đặt.
  const own = mergeReports(EMPTY, [forged], { today: TODAY, source: 'Chủ ứng dụng khảo sát', note: 'Trước cổng chợ', until: '2026-12-31' });
  assert.deepEqual([own.doc.items[0].source, own.doc.items[0].note, own.doc.items[0].until], ['Chủ ứng dụng khảo sát', 'Trước cổng chợ', '2026-12-31']);
  // Dòng xem lại: đủ JSON của mục thêm và vị trí mục trùng.
  const again = mergeReports(res.doc, [{ ...forged, coord: [105.85001, 21.03] }], { today: TODAY });
  const lines = [...reviewLines(res), ...reviewLines(again)];
  assert.equal(lines[0], `+ mục 1: ${JSON.stringify(it)}`);
  assert.match(lines[1], /^= mục 1 tại 21\.03, 105\.85001 trùng camera-speed-/);
});

test('công cụ: tệp ghi ra mỗi mục một dòng, tệp rỗng giống tệp đi kèm', () => {
  const shipped = readFileSync(new URL('../data/community.json', import.meta.url), 'utf8');
  assert.equal(formatCommunity(JSON.parse(shipped)), shipped);
  const res = mergeReports(EMPTY, [communityItem(rep()), communityItem(rep({ type: 'camred' }))], { today: TODAY });
  assert.equal(res.text.split('\n').filter((l) => l.startsWith('    {')).length, 2);
});

test('công cụ chạy từ dòng lệnh: --dry-run không ghi, chạy thật thì ghi và báo mục bị từ chối', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bd-community-'));
  try {
    const data = join(dir, 'community.json');
    writeFileSync(data, formatCommunity(EMPTY));
    const input = join(dir, 'issue.txt');
    writeFileSync(input, `${shareText(rep())}\n${JSON.stringify({ type: 'speed-limit', coord: [105.9, 21.1], value: 61, source: 's', verified: TODAY })}`);
    const tool = fileURLToPath(new URL('../tools/community/add-reports.mjs', import.meta.url));
    const dry = spawnSync(process.execPath, [tool, input, '--data', data, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 1, dry.stderr);
    assert.match(dry.stdout, /Thêm 1 mục/);
    assert.match(dry.stdout, /^\+ mục 1: \{"id":"camera-speed-[^"]+","type":"camera-speed"/m, 'in đủ mục sẽ thêm để xem lại');
    assert.match(dry.stderr, /Từ chối mục 2: tốc độ/);
    assert.equal(readFileSync(data, 'utf8'), formatCommunity(EMPTY));
    const real = spawnSync(process.execPath, [tool, input, '--data', data], { encoding: 'utf8' });
    assert.equal(real.status, 1);
    const written = JSON.parse(readFileSync(data, 'utf8'));
    assert.equal(written.items.length, 1);
    assert.equal(written.items[0].type, 'camera-speed');
    const help = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
    assert.equal(help.status, 2);
    assert.match(help.stdout, /Cách dùng/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
