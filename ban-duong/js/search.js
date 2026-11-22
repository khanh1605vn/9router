// Tìm địa điểm: Photon (gợi ý trong lúc gõ) và Nominatim (dự phòng khi bấm tìm).
// Cả hai đều dùng dữ liệu OpenStreetMap.

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Khung bao lãnh thổ Việt Nam (tây, nam, đông, bắc) để ưu tiên kết quả trong nước.
const VN_BBOX = [102.1, 8.3, 109.7, 23.5];
const inVietnam = (c) => c[0] >= VN_BBOX[0] && c[0] <= VN_BBOX[2] && c[1] >= VN_BBOX[1] && c[1] <= VN_BBOX[3];

const uniq = (parts) => parts.filter((p, i) => p && parts.indexOf(p) === i);

function fromPhoton(feature) {
  const p = feature.properties || {};
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.locality || p.district || p.city || 'Địa điểm';
  const address = uniq([p.name ? street : '', p.locality, p.district, p.city, p.county, p.state])
    .filter((x) => x !== name)
    .join(', ');
  return { name, address, coord: [c[0], c[1]] };
}

function fromNominatim(item) {
  const lon = Number(item.lon);
  const lat = Number(item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const parts = String(item.display_name || '').split(',').map((s) => s.trim());
  const name = item.name || parts[0] || 'Địa điểm';
  const address = parts.filter((x) => x && x !== name && x !== 'Việt Nam' && !/^\d{5,6}$/.test(x)).join(', ');
  return { name, address, coord: [lon, lat] };
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

  const params = new URLSearchParams({ q, limit: '8' });
  if (near) {
    params.set('lat', near[1].toFixed(5));
    params.set('lon', near[0].toFixed(5));
  }
  if (!near || inVietnam(near)) params.set('bbox', VN_BBOX.join(','));

  let results = [];
  let failed = null;
  try {
    const data = await getJson(`${PHOTON}/api/?${params}`, signal);
    results = (data.features || []).map(fromPhoton).filter(Boolean);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    failed = err;
  }
  if (results.length || !thorough) {
    if (failed && !results.length) throw failed;
    return results;
  }

  const nq = new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': 'vi' });
  if (!near || inVietnam(near)) nq.set('countrycodes', 'vn');
  const data = await getJson(`${NOMINATIM}?${nq}`, signal);
  return (Array.isArray(data) ? data : []).map(fromNominatim).filter(Boolean);
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
    const hit = (data.features || []).map(fromPhoton).filter(Boolean)[0];
    if (!hit) return fallback;
    return { name: hit.name, address: hit.address || fallback.address, coord };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return fallback;
  }
}
