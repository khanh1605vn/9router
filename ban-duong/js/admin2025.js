// Đơn vị hành chính cấp tỉnh sau sắp xếp năm 2025, cùng các hàm thuần đổi địa chỉ sang tên tỉnh/thành hiện hành.
//
// Căn cứ (đối chiếu đủ nguồn trong SOURCES.md của lần cập nhật này):
// - Nghị quyết 202/2025/QH15 của Quốc hội về việc sắp xếp đơn vị hành chính cấp tỉnh. Thông qua ngày 12/6/2025.
//   63 tỉnh, thành phố còn 34 đơn vị. Chính quyền các tỉnh, thành mới hoạt động từ 01/7/2025.
// - Nghị quyết 203/2025/QH15 sửa đổi Hiến pháp và Luật Tổ chức chính quyền địa phương 72/2025/QH15: cấp huyện (quận,
//   huyện, thị xã, thành phố thuộc tỉnh) kết thúc hoạt động từ 01/7/2025. Chính quyền địa phương còn hai cấp: tỉnh và xã
//   (Điều 1 Luật 72/2025/QH15: cấp xã gồm xã, phường, đặc khu).
// - Nghị quyết 175/2024/QH15: thành phố Huế trực thuộc Trung ương từ 01/01/2025, thay cho tỉnh Thừa Thiên Huế.
// - Ba tỉnh sau đó thành thành phố trực thuộc Trung ương, giữ nguyên địa giới: Đồng Nai (NQ 30/2026/QH16, từ
//   30/4/2026), Quảng Ninh (NQ 36/2026/QH16, từ 01/9/2026), Bắc Ninh (NQ 39/2026/QH16, từ 20/9/2026).
//   Từ 20/9/2026 cả nước có 25 tỉnh và 9 thành phố trực thuộc Trung ương.
//
// Ở đây chỉ có tên. Không có toạ độ, ranh giới hay trung tâm hành chính: những thứ đó lấy từ dữ liệu OpenStreetMap.
// Tên xã/phường mới cũng không có bảng ở đây, ứng dụng hiện đúng như OSM trả về.

/**
 * 34 đơn vị cấp tỉnh. Trường `from` liệt kê các tỉnh, thành trước sắp xếp hợp thành đơn vị (theo Điều 1 NQ 202/2025/QH15;
 * 11 đơn vị không sắp xếp chỉ có chính nó). `label` là tên ngắn hiện trên màn hình xe. `cityFrom` là ngày một tỉnh trở
 * thành thành phố trực thuộc Trung ương sau năm 2025.
 */
export const UNITS = Object.freeze(
  [
    // 11 đơn vị không sắp xếp
    { name: 'Hà Nội', kind: 'thanh-pho', from: ['Hà Nội'] },
    { name: 'Huế', kind: 'thanh-pho', from: ['Huế'] },
    { name: 'Lai Châu', kind: 'tinh', from: ['Lai Châu'] },
    { name: 'Điện Biên', kind: 'tinh', from: ['Điện Biên'] },
    { name: 'Sơn La', kind: 'tinh', from: ['Sơn La'] },
    { name: 'Lạng Sơn', kind: 'tinh', from: ['Lạng Sơn'] },
    { name: 'Quảng Ninh', kind: 'thanh-pho', from: ['Quảng Ninh'], cityFrom: '2026-09-01' }, // NQ 36/2026/QH16
    { name: 'Thanh Hóa', kind: 'tinh', from: ['Thanh Hóa'] },
    { name: 'Nghệ An', kind: 'tinh', from: ['Nghệ An'] },
    { name: 'Hà Tĩnh', kind: 'tinh', from: ['Hà Tĩnh'] },
    { name: 'Cao Bằng', kind: 'tinh', from: ['Cao Bằng'] },
    // 23 đơn vị hình thành sau sắp xếp
    { name: 'Tuyên Quang', kind: 'tinh', from: ['Hà Giang', 'Tuyên Quang'] },
    { name: 'Lào Cai', kind: 'tinh', from: ['Yên Bái', 'Lào Cai'] },
    { name: 'Thái Nguyên', kind: 'tinh', from: ['Bắc Kạn', 'Thái Nguyên'] },
    { name: 'Phú Thọ', kind: 'tinh', from: ['Vĩnh Phúc', 'Hòa Bình', 'Phú Thọ'] },
    { name: 'Bắc Ninh', kind: 'thanh-pho', from: ['Bắc Giang', 'Bắc Ninh'], cityFrom: '2026-09-20' }, // NQ 39/2026/QH16
    { name: 'Hưng Yên', kind: 'tinh', from: ['Thái Bình', 'Hưng Yên'] },
    { name: 'Hải Phòng', kind: 'thanh-pho', from: ['Hải Dương', 'Hải Phòng'] },
    { name: 'Ninh Bình', kind: 'tinh', from: ['Hà Nam', 'Nam Định', 'Ninh Bình'] },
    { name: 'Quảng Trị', kind: 'tinh', from: ['Quảng Bình', 'Quảng Trị'] },
    { name: 'Đà Nẵng', kind: 'thanh-pho', from: ['Quảng Nam', 'Đà Nẵng'] },
    { name: 'Quảng Ngãi', kind: 'tinh', from: ['Kon Tum', 'Quảng Ngãi'] },
    { name: 'Gia Lai', kind: 'tinh', from: ['Bình Định', 'Gia Lai'] },
    { name: 'Khánh Hòa', kind: 'tinh', from: ['Ninh Thuận', 'Khánh Hòa'] },
    { name: 'Lâm Đồng', kind: 'tinh', from: ['Đắk Nông', 'Bình Thuận', 'Lâm Đồng'] },
    { name: 'Đắk Lắk', kind: 'tinh', from: ['Phú Yên', 'Đắk Lắk'] },
    {
      name: 'Hồ Chí Minh',
      label: 'TP. Hồ Chí Minh',
      kind: 'thanh-pho',
      from: ['Bà Rịa - Vũng Tàu', 'Bình Dương', 'Hồ Chí Minh'],
    },
    { name: 'Đồng Nai', kind: 'thanh-pho', from: ['Bình Phước', 'Đồng Nai'], cityFrom: '2026-04-30' }, // NQ 30/2026/QH16
    { name: 'Tây Ninh', kind: 'tinh', from: ['Long An', 'Tây Ninh'] },
    { name: 'Cần Thơ', kind: 'thanh-pho', from: ['Sóc Trăng', 'Hậu Giang', 'Cần Thơ'] },
    { name: 'Vĩnh Long', kind: 'tinh', from: ['Bến Tre', 'Trà Vinh', 'Vĩnh Long'] },
    { name: 'Đồng Tháp', kind: 'tinh', from: ['Tiền Giang', 'Đồng Tháp'] },
    { name: 'Cà Mau', kind: 'tinh', from: ['Bạc Liêu', 'Cà Mau'] },
    { name: 'An Giang', kind: 'tinh', from: ['Kiên Giang', 'An Giang'] },
  ].map((u) => Object.freeze({ ...u, label: u.label || u.name, from: Object.freeze(u.from) }))
);

// Tên cũ khác tên hiện hành của cùng đơn vị: tỉnh Thừa Thiên Huế trước 01/01/2025 (NQ 175/2024/QH15). Mảng là các
// dạng viết của tên cũ gặp trên nhãn bản đồ.
const RENAMED = Object.freeze({ 'Thừa Thiên Huế': Object.freeze({ now: 'Huế', labels: ['Thừa Thiên Huế', 'Thừa Thiên - Huế'] }) });

/** Tên các tỉnh trước sắp xếp không còn là tên đơn vị cấp tỉnh (29 tên). */
export const ABOLISHED = Object.freeze(
  UNITS.flatMap((u) => u.from.filter((n) => !UNITS.some((v) => v.name === n)))
);

/** Bỏ dấu, chữ thường, đ → d (so tên không phụ thuộc dấu và kiểu bỏ dấu "Hoà"/"Hòa"). */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

// Tiền tố/hậu tố cấp tỉnh mà dữ liệu OSM, Photon, Nominatim dùng: "Tỉnh X", "Thành phố X", "TP. X", "X Province", "X City".
const PROVINCE_PREFIX = /^(?:tinh|thanh pho|t\.?\s?p\.?|thu do)(?=[\s.]|$)[\s.]*/;
const PROVINCE_SUFFIX = /\s+(?:province|city|municipality)$/;

/** Khoá so tên cấp tỉnh: bỏ dấu, bỏ tiền tố/hậu tố, chỉ giữ chữ và số. */
export function provinceKey(text) {
  return fold(text).replace(PROVINCE_PREFIX, '').replace(PROVINCE_SUFFIX, '').replace(/[^a-z0-9]/g, '');
}

// Khoá → { unit, oldName }. oldName khác null khi tên là tên cũ không còn dùng.
const LOOKUP = new Map();
for (const unit of UNITS) {
  LOOKUP.set(provinceKey(unit.name), { unit, oldName: null });
  for (const n of unit.from) if (n !== unit.name) LOOKUP.set(provinceKey(n), { unit, oldName: n });
}
for (const [old, { now }] of Object.entries(RENAMED)) {
  LOOKUP.set(provinceKey(old), { unit: UNITS.find((u) => u.name === now), oldName: old });
}
// Cách viết tắt thông dụng của Thành phố Hồ Chí Minh ("TP.HCM", "TPHCM"): chỉ để nhận ra, không hiển thị.
LOOKUP.set('hcm', LOOKUP.get(provinceKey('Hồ Chí Minh')));
LOOKUP.set('tphcm', LOOKUP.get(provinceKey('Hồ Chí Minh')));

/**
 * Tra một tên cấp tỉnh (mới hoặc cũ, mọi dạng viết). Trả về { unit, oldName } hoặc null.
 * oldName là tên cũ chuẩn (ví dụ "Tiền Giang") khi văn bản gọi theo tên đã bỏ; null khi đã là tên hiện hành.
 */
export function lookupProvince(text) {
  const key = provinceKey(text);
  return (key && LOOKUP.get(key)) || null;
}

// Phần địa chỉ cấp huyện đã bỏ từ 01/7/2025: "Quận 1", "Huyện Cần Giờ", "Thị xã …", "Thành phố Mỹ Tho" (thành phố
// thuộc tỉnh). Chỉ nhận khi có tiền tố viết đủ và chữ sau tiền tố viết hoa hoặc là số. Phần không tiền tố như "Thủ Dầu
// Một" có thể là tên phường mới, nên giữ.
const DISTRICT_PREFIX = /^(?:Quận|Huyện|Thị xã|Thành phố|TP\.)\s+(?=[\p{Lu}\d])/u;

/** Phần địa chỉ là đơn vị cấp huyện cũ. "Thành phố X" chỉ tính khi X không phải một trong 34 đơn vị cấp tỉnh. */
export function isDistrictLevel(part) {
  const p = String(part ?? '').trim();
  const m = DISTRICT_PREFIX.exec(p);
  if (!m) return false;
  if (/^(?:Thành phố|TP\.)/u.test(p)) {
    const hit = lookupProvince(p);
    if (hit && !hit.oldName) return false;
  }
  return true;
}

/** Dạng đầy đủ để hiển thị khi cần nói rõ loại đơn vị ("Thành phố Đồng Nai", "Tỉnh Gia Lai"). */
export const fullName = (unit) => (unit.kind === 'thanh-pho' ? `Thành phố ${unit.name}` : `Tỉnh ${unit.name}`);

const PREVIOUSLY = (old) => `trước đây: ${old}`;

/**
 * Đổi danh sách phần địa chỉ (không gồm tên địa điểm) sang dạng sau sắp xếp.
 * `provinceAt` là vị trí của phần cấp tỉnh (theo trường dữ liệu, không đoán theo tên). -1 nghĩa là không có phần nào.
 * - Phần cấp tỉnh: tên cũ đổi sang đơn vị mới, kèm gợi ý "trước đây: <tỉnh cũ>". Tên mới viết theo dạng ngắn thống nhất.
 * - Bỏ phần cấp huyện có tiền tố rõ ràng (isDistrictLevel).
 * - Bỏ phần trùng với đơn vị cấp tỉnh, như "Đồng Nai, Thành phố Đồng Nai". Phường/xã và tên cũ không tiền tố khác thì giữ.
 * `keepDistricts` = true thì giữ phần cấp huyện (dùng cho địa chỉ đã lưu từ trước, xem modernizeAddressText).
 * Trả về { parts, hint, unit, district } với `district` = true khi còn giữ một phần cấp huyện.
 */
export function modernizeParts(parts, provinceAt = -1, { keepDistricts = false } = {}) {
  const list = Array.isArray(parts) ? parts : [];
  let unit = null;
  let hint = '';
  const rest = [];
  list.forEach((raw, i) => {
    const p = String(raw ?? '').trim();
    if (!p) return;
    if (i === provinceAt) {
      const hit = lookupProvince(p);
      if (hit) {
        unit = hit.unit;
        if (hit.oldName) hint = PREVIOUSLY(hit.oldName);
        return;
      }
    }
    rest.push(p);
  });
  const sameUnit = (p) => {
    const hit = unit && lookupProvince(p);
    return Boolean(hit && hit.unit === unit && !hit.oldName);
  };
  const district = keepDistricts && rest.some((p) => isDistrictLevel(p));
  const out = rest.filter((p) => (keepDistricts || !isDistrictLevel(p)) && !sameUnit(p));
  if (unit) out.push(unit.label);
  const seen = new Set();
  return {
    parts: out.filter((p) => {
      const k = fold(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    hint,
    unit,
    district,
  };
}

/**
 * Gợi ý cho một kết quả mà chính tên của nó là đơn vị cũ: ranh giới OSM `boundary=historic` (như "Tỉnh Bình Dương"),
 * hoặc nút `place=state` còn sót mang tên tỉnh đã bỏ (như "Hà Giang"). Trả về chuỗi rỗng nếu không phải.
 */
export function formerUnitHint(name, { historic = false, provinceLevel = false } = {}) {
  const hit = lookupProvince(name);
  if (historic) return hit ? `Ranh giới cũ, nay thuộc ${hit.unit.label}` : 'Ranh giới cũ';
  if (provinceLevel && hit?.oldName) return `Tỉnh cũ, nay thuộc ${hit.unit.label}`;
  return '';
}

/**
 * Địa chỉ dạng chuỗi đã lưu từ trước (Nhà, Cơ quan, tìm gần đây): chỉ đổi phần cuối nếu là tỉnh cũ. Phần cấp huyện
 * được GIỮ: trong địa chỉ cũ, phường đánh số như "Phường 1" chỉ rõ nghĩa khi đi cùng quận ("Phường 1, Quận 3"), bỏ quận
 * thì không còn biết là nơi nào. Khi còn phần cấp huyện, gợi ý ghi "địa chỉ cũ" (nếu chưa có gợi ý "trước đây: …").
 * Chuỗi đã ở dạng mới thì giữ nguyên. Trả về { address, hint }.
 */
export function modernizeAddressText(address) {
  const text = String(address ?? '');
  if (!text.includes(',') && !lookupProvince(text)) return { address: text, hint: '' };
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const { parts: out, hint, district } = modernizeParts(parts, parts.length - 1, { keepDistricts: true });
  return { address: out.join(', '), hint: hint || (district ? OLD_ADDRESS : '') };
}

/** Gợi ý cho địa chỉ đã lưu còn phần quận/huyện/thị xã (cấp huyện đã kết thúc hoạt động từ 01/7/2025). */
export const OLD_ADDRESS = 'địa chỉ cũ';

/**
 * Câu tìm có phần cuối (sau dấu phẩy) là tỉnh đã bỏ, như "chợ Mỹ Tho, Tiền Giang": đổi phần đó sang tên đơn vị mới,
 * vì dữ liệu OSM giờ ghi địa chỉ theo tỉnh mới. Tỉnh cũ nằm trọn trong đơn vị mới nên không mất kết quả đúng.
 * Câu không có dấu phẩy giữ nguyên ("Bình Dương" còn là tên phường).
 */
export function modernizeQuery(query) {
  const q = String(query ?? '');
  const i = q.lastIndexOf(',');
  if (i <= 0) return q;
  const tail = q.slice(i + 1).trim();
  const hit = tail && lookupProvince(tail);
  if (!hit || !hit.oldName || !q.slice(0, i).trim()) return q;
  return `${q.slice(0, i).trim()}, ${hit.unit.name}`;
}

// Dạng dấu kiểu cũ (hoà, khoẻ, thuỷ): OSM có nơi viết "Hoà Bình", "Khánh Hoà".
const OLD_TONES = [
  [/òa/g, 'oà'], [/óa/g, 'oá'], [/ỏa/g, 'oả'], [/õa/g, 'oã'], [/ọa/g, 'oạ'],
  [/òe/g, 'oè'], [/óe/g, 'oé'], [/ỏe/g, 'oẻ'], [/õe/g, 'oẽ'], [/ọe/g, 'oẹ'],
  [/ùy/g, 'uỳ'], [/úy/g, 'uý'], [/ủy/g, 'uỷ'], [/ũy/g, 'uỹ'], [/ụy/g, 'uỵ'],
];
const toneVariants = (s) => {
  const old = OLD_TONES.reduce((t, [re, to]) => t.replace(re, to), s);
  return old === s ? [s] : [s, old];
};
const uniqStrings = (list) => [...new Set(list)];

/** Mọi dạng nhãn bản đồ của tỉnh đã bỏ (tên trần, "Tỉnh X", "tỉnh X", dấu kiểu cũ) để ẩn nhãn cấp tỉnh. */
export function abolishedLabelNames() {
  return uniqStrings(
    ABOLISHED.flatMap((n) =>
      toneVariants(n).flatMap((v) => [v, `Tỉnh ${v}`, `tỉnh ${v}`])
    )
  );
}

/**
 * Nhãn cấp tỉnh còn tên nhưng đổi loại đơn vị hoặc đổi tên: [[các dạng cũ], nhãn mới].
 * "Tỉnh Đồng Nai" → "Thành phố Đồng Nai" (cũng vậy với Quảng Ninh, Bắc Ninh); "Thừa Thiên Huế" → "Huế".
 */
export function provinceLabelRenames() {
  const out = [];
  for (const u of UNITS.filter((v) => v.cityFrom)) {
    out.push([uniqStrings(toneVariants(u.name).flatMap((v) => [`Tỉnh ${v}`, `tỉnh ${v}`])), fullName(u)]);
  }
  for (const { now, labels } of Object.values(RENAMED)) {
    const unit = UNITS.find((u) => u.name === now);
    const bare = uniqStrings(labels);
    out.push([bare, unit.name]);
    out.push([bare.flatMap((v) => [`Tỉnh ${v}`, `tỉnh ${v}`]), fullName(unit)]);
  }
  return out;
}
