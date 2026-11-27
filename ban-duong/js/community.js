// Dữ liệu cộng đồng: tải data/community.json (cùng nguồn gốc: GitHub Pages hoặc gói tệp trong ứng dụng Android; trong
// ứng dụng Android tải thêm bản trên GitHub Pages), chọn bản mới nhất theo ngày "updated", lưu lại để dùng khi mất mạng,
// rồi đổi các mục thành điểm cảnh báo đi qua đúng đường của điểm tự đánh dấu (AlertEngine trong js/alerts.js).
//
// An toàn: tệp chỉ được JSON.parse rồi qua bộ kiểm tra nghiêm ngặt (js/communitydata.js), không bao giờ chạy hay
// chèn HTML. Tải có hạn giờ, có giới hạn dung lượng, không gửi cookie, không gửi Referer. Mọi lỗi đều im lặng: không
// tải được thì dùng bản đã lưu, không có bản nào thì không có điểm nào (không bao giờ đoán).

import { distance } from './geo.js';
import { describePoint } from './alerts.js';
import { lookupSign } from './signs.js';
import { spokenDistance } from './tracker.js';
import { dayNumber, isoDate, MAX_BYTES, validateCommunity, viDate } from './communitydata.js';

export const COMMUNITY_PATH = 'data/community.json';
// Bản trên GitHub Pages của kho (nhánh master). Chỉ ứng dụng Android tải thêm bản này: trên trình duyệt, trang đã chạy
// từ chính GitHub Pages nên bản cùng nguồn gốc đã là bản đó.
export const COMMUNITY_REMOTE = 'https://khanh1605vn.github.io/9router/data/community.json';
export const COMMUNITY_REFRESH_MS = 6 * 3600e3;
export const COMMUNITY_TIMEOUT_MS = 15000;
export const COMMUNITY_CACHE_KEY = 'banduong:community';
export const COMMUNITY_LABEL = 'dữ liệu cộng đồng';
// Điểm có hướng (direction) và điểm trùng nhau giữa các nguồn: AlertEngine xét sau khi lọc theo hướng
// (pointApplies, ALERT_DUP_M trong js/alerts.js), nên ở đây không lọc gì.

const CAMERA_SUB = { 'camera-speed': 'speed', 'camera-redlight': 'redlight', 'camera-traffic': 'traffic' };
// Thứ tự ưu tiên khi hai bản cùng ngày "updated": bản vừa tải từ GitHub Pages, rồi bản đi kèm ứng dụng, rồi bản đã lưu.
const RANK = { remote: 0, bundle: 1, cache: 2 };

/**
 * Tải một tệp văn bản, có hạn giờ và giới hạn dung lượng. Mọi lỗi → null.
 * @param opts.remote true: tệp ở nguồn gốc khác (không cookie, không chuyển hướng, không Referer)
 */
export async function fetchText(url, { fetch: fetchFn = globalThis.fetch, timeoutMs = COMMUNITY_TIMEOUT_MS, maxBytes = MAX_BYTES, remote = false } = {}) {
  if (typeof fetchFn !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      cache: 'no-cache',
      credentials: remote ? 'omit' : 'same-origin',
      redirect: remote ? 'error' : 'follow',
      referrerPolicy: 'no-referrer',
      signal: ctl?.signal,
    });
    if (!res || !res.ok) return null;
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return new TextEncoder().encode(text).length > maxBytes ? null : text;
    }
    // Đọc từng phần để dừng ngay khi quá giới hạn (máy chủ không báo content-length).
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bộ lưu bằng localStorage (cùng kiểu với js/store.js: lỗi thì bỏ qua). */
export function localStorageBackend(ls = globalThis.localStorage) {
  return {
    get(key) {
      try {
        return ls?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        ls?.setItem(key, value);
      } catch {
        /* hết chỗ hoặc bị chặn: vẫn dùng bản trong bộ nhớ */
      }
    },
  };
}

/**
 * Chọn bản mới nhất theo "updated"; cùng ngày thì theo RANK. candidates: [{ src, data }] đã qua bộ kiểm tra.
 */
export function pickNewest(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c?.data) continue;
    if (!best) {
      best = c;
      continue;
    }
    const d = dayNumber(c.data.updated) - dayNumber(best.data.updated);
    if (d > 0 || (d === 0 && RANK[c.src] < RANK[best.src])) best = c;
  }
  return best;
}

export class CommunityData {
  /**
   * @param opts.fetch    hàm fetch
   * @param opts.storage  { get(key), set(key, value) } (mặc định localStorage)
   * @param opts.native   () => true khi chạy trong ứng dụng Android (tải thêm bản trên GitHub Pages)
   * @param opts.today    () => "YYYY-MM-DD"
   * @param opts.baseUrl  địa chỉ trang, để tính địa chỉ data/community.json cùng nguồn gốc
   */
  constructor({
    fetch: fetchFn = globalThis.fetch?.bind(globalThis),
    storage = localStorageBackend(),
    native = () => false,
    today = () => isoDate(),
    baseUrl = globalThis.location?.href,
    timeoutMs = COMMUNITY_TIMEOUT_MS,
    localUrl = null,
    remoteUrl = COMMUNITY_REMOTE,
  } = {}) {
    this.fetch = fetchFn;
    this.storage = storage;
    this.native = native;
    this.today = today;
    this.timeoutMs = timeoutMs;
    this.localUrl = localUrl || (baseUrl ? new URL(COMMUNITY_PATH, baseUrl).href : COMMUNITY_PATH);
    this.remoteUrl = remoteUrl;
    this.data = null; // { schema, updated, items }
    this.source = null; // 'bundle' | 'remote' | 'cache'
    this.points = [];
    this.listeners = new Set();
    this.pending = null;
    this.timer = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get count() {
    return this.data ? this.data.items.length : 0;
  }

  get updated() {
    return this.data?.updated || null;
  }

  #validate(text) {
    if (typeof text !== 'string') return null;
    const r = validateCommunity(text, { today: this.today() });
    return r.ok ? r.data : null;
  }

  /** Tải lại (mỗi lúc chỉ một lần chạy). Trả về true nếu dữ liệu đang dùng đổi. */
  refresh() {
    if (!this.pending) this.pending = this.#refresh().finally(() => (this.pending = null));
    return this.pending;
  }

  async #refresh() {
    const opts = { fetch: this.fetch, timeoutMs: this.timeoutMs };
    let native = false;
    try {
      native = Boolean(this.native());
    } catch {
      native = false;
    }
    const [local, remote] = await Promise.all([
      fetchText(this.localUrl, opts),
      native && this.remoteUrl ? fetchText(this.remoteUrl, { ...opts, remote: true }) : null,
    ]);
    const cache = this.#validate(this.storage.get(COMMUNITY_CACHE_KEY));
    const best = pickNewest([
      { src: 'remote', data: this.#validate(remote) },
      { src: 'bundle', data: this.#validate(local) },
      { src: 'cache', data: cache },
    ]);
    if (best && best.src !== 'cache') this.storage.set(COMMUNITY_CACHE_KEY, JSON.stringify(best.data));
    const before = this.data ? JSON.stringify(this.data) : '';
    this.data = best?.data || null;
    this.source = best?.src || null;
    this.points = this.data ? communityPoints(this.data.items) : [];
    const changed = before !== (this.data ? JSON.stringify(this.data) : '');
    if (changed) for (const fn of this.listeners) fn(this);
    return changed;
  }

  /** Tải ngay rồi tải lại mỗi COMMUNITY_REFRESH_MS. */
  start({ setInterval: si = globalThis.setInterval } = {}) {
    this.refresh();
    if (!this.timer) this.timer = si(() => this.refresh(), COMMUNITY_REFRESH_MS);
  }

  stop({ clearInterval: ci = globalThis.clearInterval } = {}) {
    if (this.timer) ci(this.timer);
    this.timer = null;
  }

  /** Điểm trong bán kính radius (m) quanh coord. */
  near(coord, radius) {
    return this.points.filter((p) => distance(coord, p.coord) <= radius);
  }
}

/** Câu "Dữ liệu cộng đồng: N điểm, cập nhật dd/mm/yyyy" trong phần cài đặt. */
export function communitySummary(cd) {
  if (!cd?.data) return 'Dữ liệu cộng đồng: chưa tải được.';
  return `Dữ liệu cộng đồng: ${cd.count} điểm, cập nhật ${viDate(cd.updated)}`;
}

/** Tên, câu đọc và biểu tượng của một mục (không có nhãn "dữ liệu cộng đồng"). null nếu không mô tả được. */
export function itemInfo(item) {
  if (CAMERA_SUB[item.type]) return describePoint({ kind: 'camera', sub: CAMERA_SUB[item.type], limit: item.value ?? null });
  if (item.type === 'speed-limit') {
    return {
      title: `Tốc độ tối đa ${item.value} km/h`,
      say: `có biển tốc độ tối đa ${item.value} ki lô mét trên giờ`,
      icon: 'hazard',
    };
  }
  if (item.type === 'sign') {
    const entry = lookupSign(item.code);
    if (!entry || !entry.say || /\{n\}/.test(entry.say + entry.name)) return null;
    return { title: entry.name, say: entry.say, icon: 'hazard' };
  }
  if (item.type === 'hazard') return { title: 'Điểm nguy hiểm', say: 'có điểm nguy hiểm', icon: 'hazard' };
  if (item.type === 'closure') return { title: 'Đường cấm hoặc rào chắn', say: 'có đường cấm hoặc rào chắn', icon: 'works' };
  return null;
}

/** Đổi các mục đã kiểm tra thành điểm cho AlertEngine và bản đồ. */
export function communityPoints(items) {
  const out = [];
  for (const item of items || []) {
    const info = itemInfo(item);
    if (!info) continue;
    const camera = CAMERA_SUB[item.type];
    out.push({
      id: `c:${item.id}`,
      kind: camera ? 'camera' : 'community', // camera theo công tắc "Camera giao thông" như camera của bản đồ
      sub: camera || '',
      limit: camera ? (item.value ?? null) : null,
      type: item.type,
      coord: item.coord,
      direction: item.direction ?? null,
      src: 'community',
      icon: info.icon,
      info: { ...info, title: `${info.title} (${COMMUNITY_LABEL})` },
      item,
    });
  }
  return out;
}

/**
 * Kết quả AlertEngine.update: điểm mang sẵn tên và câu đọc riêng (điểm cộng đồng, điểm tự đánh dấu có trị số) thì
 * dùng chúng thay cho describePoint; câu đọc theo đúng mẫu "Còn …, …" của AlertEngine.
 */
export function withOwnInfo(result) {
  const a = result?.active;
  const info = a?.point?.info;
  if (!info) return result;
  return {
    ...result,
    active: { ...a, info },
    say: result.fired ? `Còn ${spokenDistance(a.distance)}, ${info.say}` : result.say,
  };
}

/** Các dòng chi tiết cho hộp thông tin khi chạm vào điểm cộng đồng trên bản đồ (chữ thường, đi qua textContent). */
export function detailLines(point) {
  const it = point.item;
  const lines = [];
  if (it.note) lines.push(it.note);
  lines.push(`Nguồn: ${it.source}. Chủ ứng dụng xác minh ngày ${viDate(it.verified)}.`);
  if (it.until) lines.push(`Hiệu lực đến hết ngày ${viDate(it.until)}.`);
  if (it.direction != null) lines.push(`Chỉ áp dụng cho chiều xe chạy hướng ${it.direction}°.`);
  lines.push(
    `Đây là ${COMMUNITY_LABEL}, không đầy đủ: không có cảnh báo không có nghĩa là không có camera hay biển. Luôn tuân theo biển báo thực tế.`
  );
  return lines;
}
