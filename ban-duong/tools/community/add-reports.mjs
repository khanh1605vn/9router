#!/usr/bin/env node
// Công cụ của chủ ứng dụng: kiểm tra và gộp báo cáo của người dùng vào data/community.json.
// Không cần cài gì thêm (chỉ Node 22+). Cách dùng xem COMMUNITY.md / README, mục "Dữ liệu cộng đồng".
//
//   node tools/community/add-reports.mjs <tệp...> [--data data/community.json] [--verified YYYY-MM-DD]
//                                        [--source "Chủ ứng dụng khảo sát"] [--note "…"] [--until YYYY-MM-DD]
//                                        [--dry-run]
//
// Tệp vào có thể là: tệp "Xuất cho kho dữ liệu" của ứng dụng (.json), một tệp community.json khác, một mảng mục, một
// mục; hoặc chữ dán từ issue GitHub / tin nhắn Zalo (.txt, .md): mọi dòng bắt đầu bằng "{" và kết thúc bằng "}" được
// đọc như một mục. "-" là đọc từ đầu vào chuẩn.
//
// Quy tắc: chỉ gộp những gì chủ ứng dụng đã tự kiểm tra tại chỗ. Mỗi mục được đặt ngày xác minh (mặc định hôm nay), qua
// đúng bộ kiểm tra của ứng dụng (js/communitydata.js); mục sai bị từ chối kèm lý do. Mục cùng loại cách mục đã có không
// quá 20 m được coi là trùng: không thêm, chỉ cập nhật ngày xác minh của mục cũ.
//
// Đầu vào là chữ của người khác (issue công khai, tin Zalo): chỉ lấy các trường có cấu trúc (MERGE_FIELDS: loại, toạ
// độ, hướng, trị số, mã biển), đều qua bộ kiểm tra. Chữ tự do và ngày của người gửi (note, source, until, verified,
// id) không bao giờ được chép sang tệp đăng lên: nguồn là --source (mặc định REPORT_SOURCE), ghi chú và ngày hết hiệu
// lực chỉ do chủ ứng dụng đặt bằng --note / --until. Trước khi ghi, công cụ in đủ từng mục sẽ thêm và vị trí từng mục
// trùng để chủ ứng dụng xem lại.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distance } from '../../js/geo.js';
import {
  byteLength,
  communityId,
  dayNumber,
  isoDate,
  MAX_BYTES,
  MAX_ITEMS,
  normalizeItem,
  validateCommunity,
} from '../../js/communitydata.js';
import { REPORT_SOURCE } from '../../js/report.js';

export const DEDUPE_M = 20;
// Trường lấy từ báo cáo của người gửi. Mọi trường khác bị bỏ.
export const MERGE_FIELDS = Object.freeze(['type', 'coord', 'direction', 'value', 'code']);
export const DEFAULT_DATA = fileURLToPath(new URL('../../data/community.json', import.meta.url));

/** Đọc các mục từ nội dung một tệp (JSON hoặc chữ dán). Trả về { items, errors }. */
export function parseInput(text) {
  const items = [];
  const errors = [];
  const trimmed = String(text).trim();
  const take = (doc) => {
    if (Array.isArray(doc)) items.push(...doc);
    else if (doc && typeof doc === 'object' && Array.isArray(doc.items)) items.push(...doc.items);
    else if (doc && typeof doc === 'object') items.push(doc);
    else errors.push('không có mục nào');
  };
  try {
    take(JSON.parse(trimmed));
    return { items, errors };
  } catch {
    /* không phải một khối JSON: đọc từng dòng */
  }
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const s = line.trim().replace(/^`+|`+$/g, '');
      if (!(s.startsWith('{') && s.endsWith('}'))) return;
      try {
        const doc = JSON.parse(s);
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) items.push(doc);
      } catch {
        errors.push(`dòng ${i + 1}: JSON sai`);
      }
    });
  return { items, errors };
}

/** Ghi tệp gọn: mỗi mục một dòng (dễ xem khác biệt trong git). */
export function formatCommunity(doc) {
  const head = `{\n  "schema": ${doc.schema},\n  "updated": ${JSON.stringify(doc.updated)},\n  "items": [`;
  if (!doc.items.length) return `${head}]\n}\n`;
  return `${head}\n${doc.items.map((it) => `    ${JSON.stringify(it)}`).join(',\n')}\n  ]\n}\n`;
}

/**
 * Gộp báo cáo vào tệp đang có (đã qua validateCommunity).
 * @param current  { schema, updated, items }
 * @param raws     các mục chưa kiểm tra
 * @param opts     { today, verified (mặc định today), source (mặc định REPORT_SOURCE), note, until: do chủ ứng dụng
 *                  đặt, áp dụng cho mọi mục thêm mới lần này; không bao giờ lấy từ báo cáo }
 * @returns { doc, added, confirmed, rejected: [{ index, reason }], addedItems, confirmedItems }
 */
export function mergeReports(current, raws, { today, verified = today, source = null, note = null, until = null } = {}) {
  if (dayNumber(verified) == null) throw new Error('--verified phải có dạng YYYY-MM-DD');
  if (dayNumber(verified) > dayNumber(today)) throw new Error('--verified không được ở tương lai');
  if (until != null && dayNumber(until) == null) throw new Error('--until phải có dạng YYYY-MM-DD');
  const addedItems = [];
  const confirmedItems = [];
  const items = current.items.map((it) => ({ ...it }));
  const ids = new Set(items.map((it) => it.id));
  const rejected = [];
  let added = 0;
  let confirmed = 0;
  raws.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push({ index, reason: 'không phải đối tượng' });
      return;
    }
    // Ngày xác minh là ngày chủ ứng dụng kiểm tra, không phải ngày người dùng thấy; id do công cụ đặt từ loại và toạ độ.
    // Chỉ lấy trường có cấu trúc của người gửi; nguồn, ghi chú, ngày hết hiệu lực là của chủ ứng dụng.
    const candidate = {};
    for (const k of MERGE_FIELDS) if (raw[k] !== undefined) candidate[k] = raw[k];
    candidate.source = source || REPORT_SOURCE;
    candidate.verified = verified;
    if (note != null && note !== '') candidate.note = note;
    if (until != null) candidate.until = until;
    const r = normalizeItem(candidate, today);
    if (r.expired) {
      rejected.push({ index, reason: 'đã hết hạn (until)' });
      return;
    }
    if (r.error) {
      rejected.push({ index, reason: r.error });
      return;
    }
    const item = r.item;
    const dup = items.find((it) => it.type === item.type && distance(it.coord, item.coord) <= DEDUPE_M);
    if (dup) {
      if (dayNumber(item.verified) > dayNumber(dup.verified)) dup.verified = item.verified;
      confirmed++;
      confirmedItems.push({ index, item: dup, coord: item.coord });
      return;
    }
    let id = communityId(item.type, item.coord);
    for (let n = 2; ids.has(id); n++) id = `${communityId(item.type, item.coord)}-${n}`;
    item.id = id;
    ids.add(id);
    items.push(item);
    addedItems.push({ index, item });
    added++;
  });
  if (items.length > MAX_ITEMS) throw new Error(`quá ${MAX_ITEMS} mục`);
  const doc = { schema: current.schema, updated: today, items };
  const text = formatCommunity(doc);
  if (byteLength(text) > MAX_BYTES) throw new Error('tệp quá lớn');
  // Kiểm tra lại cả tệp sẽ ghi bằng đúng bộ kiểm tra của ứng dụng.
  const check = validateCommunity(text, { today });
  if (!check.ok || check.stats.rejected || check.stats.kept !== items.length) {
    throw new Error(`tệp kết quả không qua được bộ kiểm tra: ${check.error || check.stats.errors.join('; ')}`);
  }
  return { doc, text, added, confirmed, rejected, addedItems, confirmedItems };
}

/** Các dòng in ra để chủ ứng dụng xem lại trước khi ghi: đủ JSON của mục thêm, vị trí của mục trùng. */
export function reviewLines(res) {
  const lines = [];
  for (const { index, item } of res.addedItems) lines.push(`+ mục ${index + 1}: ${JSON.stringify(item)}`);
  for (const { index, item, coord } of res.confirmedItems) {
    lines.push(`= mục ${index + 1} tại ${coord[1]}, ${coord[0]} trùng ${item.id} (${item.coord[1]}, ${item.coord[0]}): xác minh ${item.verified}`);
  }
  return lines;
}

function parseArgs(argv) {
  const opts = { files: [], data: DEFAULT_DATA, verified: null, source: null, note: null, until: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') opts.data = argv[++i];
    else if (a === '--verified') opts.verified = argv[++i];
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--until') opts.until = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.files.length) {
    console.log(
      'Cách dùng: node tools/community/add-reports.mjs <tệp...> [--data data/community.json] [--verified YYYY-MM-DD] ' +
        '[--source "…"] [--note "…"] [--until YYYY-MM-DD] [--dry-run]'
    );
    return opts.help ? 0 : 2;
  }
  const today = isoDate();
  const cur = validateCommunity(readFileSync(opts.data, 'utf8'), { today });
  if (!cur.ok) {
    console.error(`Không đọc được ${opts.data}: ${cur.error}`);
    return 2;
  }
  if (cur.stats.rejected) {
    console.error(`${opts.data} có ${cur.stats.rejected} mục sai, hãy sửa trước:\n  ${cur.stats.errors.join('\n  ')}`);
    return 2;
  }
  const raws = [];
  for (const f of opts.files) {
    const { items, errors } = parseInput(readFileSync(f === '-' ? 0 : f, 'utf8'));
    for (const e of errors) console.error(`${f}: ${e}`);
    raws.push(...items);
  }
  let res;
  try {
    res = mergeReports(cur.data, raws, {
      today,
      verified: opts.verified || today,
      source: opts.source,
      note: opts.note,
      until: opts.until,
    });
  } catch (err) {
    console.error(`Không gộp được: ${err.message}`);
    return 2;
  }
  for (const r of res.rejected) console.error(`Từ chối mục ${r.index + 1}: ${r.reason}`);
  // Xem lại từng mục trước khi đăng: đây là dữ liệu mọi người dùng sẽ thấy.
  for (const line of reviewLines(res)) console.log(line);
  if (cur.stats.expired) console.log(`Bỏ ${cur.stats.expired} mục đã hết hạn.`);
  console.log(
    `Thêm ${res.added} mục, xác nhận lại ${res.confirmed} mục trùng (trong ${DEDUPE_M} m), từ chối ${res.rejected.length} mục. ` +
      `Tổng ${res.doc.items.length} mục, cập nhật ${res.doc.updated}.`
  );
  if (opts.dryRun) console.log('Chạy thử (--dry-run): không ghi tệp.');
  else writeFileSync(opts.data, res.text);
  return res.rejected.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
