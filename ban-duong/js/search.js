// Tìm địa điểm: Photon (gợi ý trong lúc gõ) và Nominatim (dự phòng khi bấm tìm).
// Cả hai đều dùng dữ liệu OpenStreetMap. Địa chỉ được đổi sang tỉnh/thành sau sắp xếp 2025 (js/admin2025.js).

import { fold, formerUnitHint, fullName, lookupProvince, modernizeParts, modernizeQuery } from './admin2025.js';

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export { fromNominatim, fromPhoton }; // để kiểm thử với mẫu thật

// Khung bao lãnh thổ Việt Nam (tây, nam, đông, bắc) để ưu tiên kết quả trong nước.
const VN_BBOX = [102.1, 8.3, 109.7, 23.5];
const inVietnam = (c) => c[0] >= VN_BBOX[0] && c[0] <= VN_BBOX[2] && c[1] >= VN_BBOX[1] && c[1] <= VN_BBOX[3];

const uniq = (parts) => parts.filter((p, i) => p && parts.indexOf(p) === i);

// Đánh dấu địa chỉ đã ở dạng sau sắp xếp 2025 (khỏi đổi lại khi hiện). Địa điểm lưu từ trước không có dấu này.
export const ADM = 2025;

const VN_NAMES = new Set(['Việt Nam', 'Vietnam', 'Viet Nam']);
const isVietnam = (code, country) => (code ? String(code).toUpperCase() === 'VN' : !country || VN_NAMES.has(country));

/** Tên là một trong 34 đơn vị hiện hành (không phải tên cũ). */
const lookupCurrent = (text) => {
  const hit = lookupProvince(text);
  return hit && !hit.oldName ? hit : null;
};

/**
 * Kết quả mà tên là đơn vị hành chính cũ (ranh giới OSM boundary=historic như "Tỉnh Bình Dương", hoặc nút place=state
 * còn sót như "Hà Giang") vẫn chọn được, nhưng có gợi ý và xếp sau kết quả hiện hành.
 */
const isFormer = (place) => Boolean(place.former);
// Gợi ý "…, nay thuộc Tuyên Quang" đã nói tỉnh: địa chỉ chỉ còn đúng tên đó thì bỏ cho gọn.
const dropRepeated = (address, hint) => (address && hint.endsWith(`nay thuộc ${address}`) ? '' : address);
const formerLast = (list) => [...list.filter((p) => !isFormer(p)), ...list.filter(isFormer)];
// Địa điểm trùng tên ngắn của tỉnh/thành (như điểm dân cư "Đồng Nai", "Tuyên Quang"): phần cấp tỉnh ghi dạng đầy đủ
// ("Thành phố Đồng Nai", "Tỉnh Tuyên Quang") để địa chỉ không bị lọc mất vì trùng tên, và phân biệt được với kết quả
// ranh giới tỉnh.
const fullProvinceIfSame = (parts, unit, name) =>
  unit && fold(unit.label) === fold(name) ? parts.map((x) => (x === unit.label ? fullName(unit) : x)) : parts;

function fromPhoton(feature) {
  const p = feature.properties || {};
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.locality || p.district || p.city || 'Địa điểm';
  const fields = [p.name ? street : '', p.locality, p.district, p.city, p.county, p.state];
  let parts = uniq(fields);
  let hint = '';
  let former = false;
  if (isVietnam(p.countrycode, p.country)) {
    // Phần cấp tỉnh là trường state. Thành phố trực thuộc Trung ương thì Photon để ở city, state trống.
    let at = p.state ? fields.length - 1 : -1;
    if (at < 0 && p.city && lookupCurrent(p.city)) at = 3; // vị trí của city trong fields
    const res = modernizeParts(fields, at);
    parts = fullProvinceIfSame(res.parts, res.unit, name);
    hint = res.hint;
    const historic = p.osm_key === 'boundary' && p.osm_value === 'historic';
    const provinceLevel = p.osm_key === 'place' && (p.osm_value === 'state' || p.osm_value === 'province');
    const own = p.name ? formerUnitHint(p.name, { historic, provinceLevel }) : '';
    if (own) {
      hint = own;
      former = true;
    }
  }
  const address = dropRepeated(parts.filter((x) => x !== name).join(', '), hint);
  return { name, address, ...(hint ? { hint } : {}), ...(former ? { former } : {}), adm: ADM, coord: [c[0], c[1]] };
}

function fromNominatim(item) {
  const lon = Number(item.lon);
  const lat = Number(item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const all = String(item.display_name || '').split(',').map((s) => s.trim());
  const name = item.name || all[0] || 'Địa điểm';
  const country = all[all.length - 1];
  let parts = all.filter((x) => x && x !== name && !VN_NAMES.has(x) && !/^\d{5,6}$/.test(x));
  let hint = '';
  let former = false;
  if (VN_NAMES.has(country)) {
    // display_name đi từ nhỏ đến lớn: phần cuối (trước mã bưu chính, tên nước) là cấp tỉnh.
    const res = modernizeParts(parts, parts.length - 1);
    parts = fullProvinceIfSame(res.parts, res.unit, name).filter((x) => x !== name);
    hint = res.hint;
    const historic = item.category === 'boundary' && item.type === 'historic';
    const provinceLevel = item.category === 'place' && (item.type === 'state' || item.type === 'province');
    const own = formerUnitHint(name, { historic, provinceLevel });
    if (own) {
      hint = own;
      former = true;
    }
  }
  return {
    name,
    address: dropRepeated(parts.join(', '), hint),
    ...(hint ? { hint } : {}),
    ...(former ? { former } : {}),
    adm: ADM,
    coord: [lon, lat],
  };
}

/** Nhận dạng chuỗi toạ độ "10.7769, 106.7009" (vĩ độ trước). */
export function parseLatLon(text) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, address: 'Toạ độ nhập tay', coord: [lon, lat] };
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Tìm địa điểm theo từ khoá. `near` là vị trí hiện tại để ưu tiên kết quả gần.
 * `thorough` = true khi người dùng bấm tìm: nếu Photon lỗi hoặc không có kết quả thì hỏi thêm Nominatim.
 */
export async function searchPlaces(query, { near = null, signal, thorough = false } = {}) {
  const q = query.trim();
  if (!q) return [];
  const direct = parseLatLon(q);
  if (direct) return [direct];

  // "…, Tiền Giang" → "…, Đồng Tháp": dữ liệu OSM giờ ghi địa chỉ theo tỉnh mới. Vẫn một yêu cầu mỗi lần tìm.
  const sq = modernizeQuery(q);
  const params = new URLSearchParams({ q: sq, limit: '8' });
  if (near) {
    params.set('lat', near[1].toFixed(5));
    params.set('lon', near[0].toFixed(5));
  }
  if (!near || inVietnam(near)) params.set('bbox', VN_BBOX.join(','));

  let results = [];
  let failed = null;
  try {
    const data = await getJson(`${PHOTON}/api/?${params}`, signal);
    results = formerLast((data.features || []).map(fromPhoton).filter(Boolean));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    failed = err;
  }
  if (results.length || !thorough) {
    if (failed && !results.length) throw failed;
    return results;
  }

  const nq = new URLSearchParams({ q: sq, format: 'jsonv2', limit: '8', 'accept-language': 'vi' });
  if (!near || inVietnam(near)) nq.set('countrycodes', 'vn');
  const data = await getJson(`${NOMINATIM}?${nq}`, signal);
  return formerLast((Array.isArray(data) ? data : []).map(fromNominatim).filter(Boolean));
}

/** Tìm tên địa điểm tại một toạ độ (khi nhấn giữ trên bản đồ). */
export async function reverseGeocode(coord, { signal } = {}) {
  const fallback = {
    name: 'Điểm đã chọn',
    address: `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`,
    coord,
  };
  try {
    const params = new URLSearchParams({ lon: coord[0].toFixed(6), lat: coord[1].toFixed(6) });
    const data = await getJson(`${PHOTON}/reverse?${params}`, signal);
    const hit = formerLast((data.features || []).map(fromPhoton).filter(Boolean))[0];
    if (!hit) return fallback;
    return { ...hit, address: hit.address || fallback.address, coord };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return fallback;
  }
}
