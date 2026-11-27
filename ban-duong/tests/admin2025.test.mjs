import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABOLISHED,
  abolishedLabelNames,
  fold,
  formerUnitHint,
  isDistrictLevel,
  lookupProvince,
  modernizeAddressText,
  modernizeParts,
  modernizeQuery,
  provinceLabelRenames,
  UNITS,
} from '../js/admin2025.js';
import { fromNominatim, fromPhoton } from '../js/search.js';
import { isExpressionFilter, localizeLabels, modernizeAdminLabels } from '../js/mapview.js';

// Bảng đối chiếu (SOURCES.md của lần cập nhật): 34 đơn vị theo NQ 202/2025/QH15 và các tỉnh/thành hợp thành.
// Loại đơn vị tính tại 27/11/2026 (Đồng Nai, Quảng Ninh, Bắc Ninh đã thành thành phố trực thuộc Trung ương năm 2026).
const EXPECTED = {
  'Hà Nội': ['thanh-pho', ['Hà Nội']],
  'Huế': ['thanh-pho', ['Huế']],
  'Lai Châu': ['tinh', ['Lai Châu']],
  'Điện Biên': ['tinh', ['Điện Biên']],
  'Sơn La': ['tinh', ['Sơn La']],
  'Lạng Sơn': ['tinh', ['Lạng Sơn']],
  'Quảng Ninh': ['thanh-pho', ['Quảng Ninh']],
  'Thanh Hóa': ['tinh', ['Thanh Hóa']],
  'Nghệ An': ['tinh', ['Nghệ An']],
  'Hà Tĩnh': ['tinh', ['Hà Tĩnh']],
  'Cao Bằng': ['tinh', ['Cao Bằng']],
  'Tuyên Quang': ['tinh', ['Hà Giang', 'Tuyên Quang']],
  'Lào Cai': ['tinh', ['Yên Bái', 'Lào Cai']],
  'Thái Nguyên': ['tinh', ['Bắc Kạn', 'Thái Nguyên']],
  'Phú Thọ': ['tinh', ['Vĩnh Phúc', 'Hòa Bình', 'Phú Thọ']],
  'Bắc Ninh': ['thanh-pho', ['Bắc Giang', 'Bắc Ninh']],
  'Hưng Yên': ['tinh', ['Thái Bình', 'Hưng Yên']],
  'Hải Phòng': ['thanh-pho', ['Hải Dương', 'Hải Phòng']],
  'Ninh Bình': ['tinh', ['Hà Nam', 'Nam Định', 'Ninh Bình']],
  'Quảng Trị': ['tinh', ['Quảng Bình', 'Quảng Trị']],
  'Đà Nẵng': ['thanh-pho', ['Quảng Nam', 'Đà Nẵng']],
  'Quảng Ngãi': ['tinh', ['Kon Tum', 'Quảng Ngãi']],
  'Gia Lai': ['tinh', ['Bình Định', 'Gia Lai']],
  'Khánh Hòa': ['tinh', ['Ninh Thuận', 'Khánh Hòa']],
  'Lâm Đồng': ['tinh', ['Đắk Nông', 'Bình Thuận', 'Lâm Đồng']],
  'Đắk Lắk': ['tinh', ['Phú Yên', 'Đắk Lắk']],
  'Hồ Chí Minh': ['thanh-pho', ['Bà Rịa - Vũng Tàu', 'Bình Dương', 'Hồ Chí Minh']],
  'Đồng Nai': ['thanh-pho', ['Bình Phước', 'Đồng Nai']],
  'Tây Ninh': ['tinh', ['Long An', 'Tây Ninh']],
  'Cần Thơ': ['thanh-pho', ['Sóc Trăng', 'Hậu Giang', 'Cần Thơ']],
  'Vĩnh Long': ['tinh', ['Bến Tre', 'Trà Vinh', 'Vĩnh Long']],
  'Đồng Tháp': ['tinh', ['Tiền Giang', 'Đồng Tháp']],
  'Cà Mau': ['tinh', ['Bạc Liêu', 'Cà Mau']],
  'An Giang': ['tinh', ['Kiên Giang', 'An Giang']],
};

test('34 đơn vị cấp tỉnh khớp bảng đối chiếu: 9 thành phố, 25 tỉnh', () => {
  assert.equal(UNITS.length, 34);
  assert.deepEqual(new Set(UNITS.map((u) => u.name)), new Set(Object.keys(EXPECTED)));
  for (const u of UNITS) {
    const [kind, from] = EXPECTED[u.name];
    assert.equal(u.kind, kind, u.name);
    assert.deepEqual([...u.from].sort(), [...from].sort(), u.name);
  }
  assert.equal(UNITS.filter((u) => u.kind === 'thanh-pho').length, 9);
  assert.equal(UNITS.filter((u) => u.kind === 'tinh').length, 25);
  // 11 đơn vị không sắp xếp, 23 đơn vị hình thành mới.
  assert.equal(UNITS.filter((u) => u.from.length === 1).length, 11);
  assert.equal(UNITS.filter((u) => u.from.length > 1).length, 23);
  for (const u of UNITS) assert.ok(u.from.includes(u.name), `${u.name} giữ tên một đơn vị cũ`);
});

test('63 tỉnh/thành cũ: mỗi tên thuộc đúng một đơn vị mới, 29 tên không còn dùng', () => {
  const all = UNITS.flatMap((u) => u.from);
  assert.equal(all.length, 63);
  assert.equal(new Set(all).size, 63, 'một tỉnh cũ không được nằm ở hai đơn vị');
  assert.equal(ABOLISHED.length, 29);
  for (const u of UNITS) {
    for (const old of u.from) {
      const owners = UNITS.filter((v) => v.from.includes(old));
      assert.equal(owners.length, 1, old);
      assert.equal(lookupProvince(old)?.unit, u, old);
      assert.equal(lookupProvince(`Tỉnh ${old}`)?.unit, u, `Tỉnh ${old}`);
      assert.equal(lookupProvince(fold(old))?.unit, u, `${old} không dấu`);
      assert.equal(lookupProvince(old).oldName, old === u.name ? null : old);
    }
  }
});

test('khoá so tên không đụng nhau giữa các tỉnh cũ (kể cả khi bỏ dấu)', () => {
  const keys = UNITS.flatMap((u) => u.from).map((n) => fold(n).replace(/[^a-z0-9]/g, ''));
  assert.equal(new Set(keys).size, keys.length);
});

test('nhận ra các dạng viết thường gặp trong OSM, Photon, Nominatim', () => {
  const cases = {
    'Tỉnh Tiền Giang': ['Đồng Tháp', 'Tiền Giang'],
    'tỉnh Kiên Giang': ['An Giang', 'Kiên Giang'],
    'Kien Giang Province': ['An Giang', 'Kiên Giang'],
    'Thành phố Hồ Chí Minh': ['TP. Hồ Chí Minh', null],
    'TP. Hồ Chí Minh': ['TP. Hồ Chí Minh', null],
    'TP.HCM': ['TP. Hồ Chí Minh', null],
    'Hồ Chí Minh City': ['TP. Hồ Chí Minh', null],
    'Ho Chi Minh City': ['TP. Hồ Chí Minh', null],
    'Bà Rịa - Vũng Tàu': ['TP. Hồ Chí Minh', 'Bà Rịa - Vũng Tàu'],
    'Ba Ria–Vung Tau': ['TP. Hồ Chí Minh', 'Bà Rịa - Vũng Tàu'],
    'Thừa Thiên Huế': ['Huế', 'Thừa Thiên Huế'],
    'Tỉnh Thừa Thiên - Huế': ['Huế', 'Thừa Thiên Huế'],
    'Thua Thien Hue Province': ['Huế', 'Thừa Thiên Huế'],
    'Thành phố Huế': ['Huế', null],
    'Hue': ['Huế', null],
    'Hanoi': ['Hà Nội', null],
    'Thủ đô Hà Nội': ['Hà Nội', null],
    'Bac Ninh': ['Bắc Ninh', null],
    'Thành phố Đồng Nai': ['Đồng Nai', null],
    'Khánh Hoà': ['Khánh Hòa', null],
    'Tỉnh Hoà Bình': ['Phú Thọ', 'Hòa Bình'],
    'Dak Lak': ['Đắk Lắk', null],
    'Da Nang City': ['Đà Nẵng', null],
  };
  for (const [text, [label, oldName]] of Object.entries(cases)) {
    const hit = lookupProvince(text);
    assert.ok(hit, text);
    assert.equal(hit.unit.label, label, text);
    assert.equal(hit.oldName, oldName, text);
  }
  for (const text of ['Phường Bình Dương', 'Thủ Dầu Một', 'Tịnh Biên', 'Thành phố Thủ Đức', 'Champasak', '', null]) {
    assert.equal(lookupProvince(text), null, String(text));
  }
});

test('nhận ra phần cấp huyện cũ chỉ khi có tiền tố rõ ràng', () => {
  for (const p of ['Quận 1', 'Quận Ninh Kiều', 'Huyện Cần Giờ', 'Thị xã Cửa Lò', 'Thành phố Mỹ Tho', 'Thành phố Thủ Đức', 'TP. Rạch Giá']) {
    assert.ok(isDistrictLevel(p), p);
  }
  for (const p of [
    'Phường Sài Gòn',
    'Xã Cần Giờ',
    'Thị trấn Cái Bè',
    'Thủ Dầu Một',
    'Trấn Biên',
    'Thành phố Hồ Chí Minh',
    'Thành phố Đồng Nai',
    'TP. Hồ Chí Minh',
    'Thành phố mới Bình Dương',
    'Huyện đội',
    'Hà Nội',
  ]) {
    assert.ok(!isDistrictLevel(p), p);
  }
});

test('modernizeParts: đổi tỉnh cũ, bỏ cấp huyện, giữ phường/xã và bỏ trùng', () => {
  assert.deepEqual(modernizeParts(['Phường 5', 'Thành phố Mỹ Tho', 'Tỉnh Tiền Giang'], 2), {
    parts: ['Phường 5', 'Đồng Tháp'],
    hint: 'trước đây: Tiền Giang',
    unit: UNITS.find((u) => u.name === 'Đồng Tháp'),
    district: false,
  });
  // Đã ở dạng mới: chỉ viết gọn tên tỉnh, không có gợi ý.
  const r = modernizeParts(['Phường Tam Hiệp', 'Đồng Nai', 'Thành phố Đồng Nai'], 2);
  assert.deepEqual(r.parts, ['Phường Tam Hiệp', 'Đồng Nai']);
  assert.equal(r.hint, '');
  // Không có phần cấp tỉnh: không đổi gì theo tên (Bình Dương còn là tên phường).
  assert.deepEqual(modernizeParts(['Bình Dương', 'Thủ Dầu Một'], -1).parts, ['Bình Dương', 'Thủ Dầu Một']);
  // Tên tỉnh cũ không tiền tố ở chỗ khác chỗ cấp tỉnh: giữ (là tên phường hay điểm dân cư).
  assert.deepEqual(modernizeParts(['Phường Phú Lợi', 'Sóc Trăng', 'Thành phố Cần Thơ'], 2).parts, ['Phường Phú Lợi', 'Sóc Trăng', 'Cần Thơ']);
  // Phần cấp tỉnh không nhận ra: giữ nguyên chỗ cũ.
  assert.deepEqual(modernizeParts(['Ban Na', 'Champasak'], 1).parts, ['Ban Na', 'Champasak']);
});

test('địa chỉ đã lưu từ trước: đổi tỉnh cũ, giữ quận/huyện kèm "địa chỉ cũ", chuỗi mới thì giữ nguyên', () => {
  assert.deepEqual(modernizeAddressText('Phú Cường, Thành phố Thủ Dầu Một, Bình Dương'), {
    address: 'Phú Cường, Thành phố Thủ Dầu Một, TP. Hồ Chí Minh',
    hint: 'trước đây: Bình Dương',
  });
  assert.deepEqual(modernizeAddressText('Bến Thành, Quận 1, Thành phố Hồ Chí Minh'), {
    address: 'Bến Thành, Quận 1, TP. Hồ Chí Minh',
    hint: 'địa chỉ cũ',
  });
  assert.deepEqual(modernizeAddressText('Thừa Thiên Huế'), { address: 'Huế', hint: 'trước đây: Thừa Thiên Huế' });
  for (const s of ['Phường Sài Gòn, TP. Hồ Chí Minh', 'Phường Hoàn Kiếm, Hà Nội', '10.77690, 106.70090', 'Toạ độ nhập tay', '']) {
    assert.deepEqual(modernizeAddressText(s), { address: s, hint: '' }, s);
  }
  // Chạy hai lần cho cùng kết quả.
  const once = modernizeAddressText('Xã Long Hựu, Huyện Cần Đước, Tỉnh Long An').address;
  assert.equal(once, 'Xã Long Hựu, Huyện Cần Đước, Tây Ninh');
  assert.equal(modernizeAddressText(once).address, once);
});

test('địa chỉ đã lưu từ trước: phường đánh số vẫn đi cùng quận, thị xã (không mất chỗ phân biệt)', () => {
  // Trước 2025, TP.HCM có "Phường 1" ở nhiều quận: bỏ "Quận 3" thì không còn biết là nơi nào.
  assert.deepEqual(modernizeAddressText('Phường 1, Quận 3, Thành phố Hồ Chí Minh'), {
    address: 'Phường 1, Quận 3, TP. Hồ Chí Minh',
    hint: 'địa chỉ cũ',
  });
  assert.deepEqual(modernizeAddressText('Nhà cũ, Phường 1, Quận 3, Thành phố Hồ Chí Minh'), {
    address: 'Nhà cũ, Phường 1, Quận 3, TP. Hồ Chí Minh',
    hint: 'địa chỉ cũ',
  });
  assert.deepEqual(modernizeAddressText('Phường 1, Thị xã Gò Công, Tiền Giang'), {
    address: 'Phường 1, Thị xã Gò Công, Đồng Tháp',
    hint: 'trước đây: Tiền Giang',
  });
  // "Thành phố Huế" là đơn vị cấp tỉnh hiện hành, không phải cấp huyện: bỏ vì trùng, không ghi "địa chỉ cũ".
  assert.deepEqual(modernizeAddressText('Đại Nội, Thành phố Huế, Tỉnh Thừa Thiên Huế'), {
    address: 'Đại Nội, Huế',
    hint: 'trước đây: Thừa Thiên Huế',
  });
  // Kết quả tìm mới (Photon, Nominatim) vẫn bỏ quận/huyện: chỉ địa chỉ đã lưu mới giữ.
  assert.deepEqual(modernizeParts(['Phường 1', 'Quận 3', 'Thành phố Hồ Chí Minh'], 2).parts, ['Phường 1', 'TP. Hồ Chí Minh']);
});

test('câu tìm: chỉ đổi tỉnh cũ ở phần cuối sau dấu phẩy', () => {
  assert.equal(modernizeQuery('chợ Mỹ Tho, Tiền Giang'), 'chợ Mỹ Tho, Đồng Tháp');
  assert.equal(modernizeQuery('Nhà thờ Phú Cường, tỉnh Bình Dương'), 'Nhà thờ Phú Cường, Hồ Chí Minh');
  for (const q of ['Bình Dương', 'Tiền Giang', 'chợ Bến Thành, Hồ Chí Minh', 'Phú Cường, Thủ Dầu Một', ', Tiền Giang', 'Tiền Giang, ']) {
    assert.equal(modernizeQuery(q), q, q);
  }
});

test('gợi ý cho kết quả là đơn vị cũ', () => {
  assert.equal(formerUnitHint('Tỉnh Bình Dương', { historic: true }), 'Ranh giới cũ, nay thuộc TP. Hồ Chí Minh');
  assert.equal(formerUnitHint('Thành phố Rạch Giá', { historic: true }), 'Ranh giới cũ');
  assert.equal(formerUnitHint('Hà Giang', { provinceLevel: true }), 'Tỉnh cũ, nay thuộc Tuyên Quang');
  assert.equal(formerUnitHint('Hà Giang'), '', 'điểm dân cư Hà Giang (place=city) không phải tỉnh');
  assert.equal(formerUnitHint('Tuyên Quang', { provinceLevel: true }), '');
});

// ---------- Mẫu thật (rút gọn) từ Photon (import 2026-11-21) và Nominatim (2026-11-27) ----------

const photon = (props, coord = [106.7, 10.8]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { country: 'Việt Nam', countrycode: 'VN', ...props } });
const nominatim = (display_name, extra = {}) => ({ lat: '10.8', lon: '106.7', display_name, ...extra });

test('Photon dạng mới: thành phố trực thuộc TW ở city, tỉnh ở state, phường ở district/county', () => {
  const tdm = fromPhoton(photon({ osm_key: 'leisure', osm_value: 'stadium', name: 'Sân vận động Gò Đậu', street: 'Nguyễn Hữu Cảnh', locality: 'Phú Thọ 2', district: 'Thủ Dầu Một', city: 'Thành phố Hồ Chí Minh' }));
  assert.equal(tdm.name, 'Sân vận động Gò Đậu');
  assert.equal(tdm.address, 'Nguyễn Hữu Cảnh, Phú Thọ 2, Thủ Dầu Một, TP. Hồ Chí Minh');
  assert.equal(tdm.hint, undefined);

  const bh = fromPhoton(photon({ osm_key: 'aeroway', osm_value: 'aerodrome', name: 'Sân bay Biên Hòa', street: 'Đường D2', locality: 'Bình Thành', district: 'Trấn Biên', city: 'Đồng Nai', state: 'Thành phố Đồng Nai' }));
  assert.equal(bh.address, 'Đường D2, Bình Thành, Trấn Biên, Đồng Nai', 'không lặp "Đồng Nai, Thành phố Đồng Nai", giữ phường Trấn Biên');

  const rg = fromPhoton(photon({ osm_key: 'aeroway', osm_value: 'aerodrome', name: 'Sân bay Rạch Giá', street: 'Cách Mạng Tháng Tám', locality: 'Khu phố 1', city: 'Rạch Giá', county: 'Phường Rạch Giá', state: 'An Giang' }));
  assert.equal(rg.address, 'Cách Mạng Tháng Tám, Khu phố 1, Rạch Giá, Phường Rạch Giá, An Giang');

  const bay = fromPhoton(photon({ osm_key: 'natural', osm_value: 'bay', name: 'Vịnh Hạ Long', city: 'Quảng Ninh' }));
  assert.equal(bay.address, 'Quảng Ninh');

  const hn = fromPhoton(photon({ osm_key: 'place', osm_value: 'city', type: 'city', name: 'Hà Nội' }));
  assert.equal(hn.name, 'Hà Nội');
  assert.equal(hn.address, '');

  const bn = fromPhoton(photon({ osm_key: 'highway', osm_value: 'primary', name: 'Đường Lý Thái Tổ', district: 'Phường Kinh Bắc', state: 'Bac Ninh' }));
  assert.equal(bn.address, 'Phường Kinh Bắc, Bắc Ninh');

  const hue = fromPhoton(photon({ osm_key: 'tourism', osm_value: 'attraction', name: 'Đại Nội', district: 'Phường Phú Xuân', city: 'Thành phố Huế' }));
  assert.equal(hue.address, 'Phường Phú Xuân, Huế');
});

test('Photon dạng cũ: tỉnh cũ đổi sang đơn vị mới kèm gợi ý, quận/huyện có tiền tố bị bỏ', () => {
  const old = fromPhoton(photon({ osm_key: 'amenity', osm_value: 'marketplace', name: 'Chợ Mỹ Tho', street: 'Trưng Trắc', district: 'Phường 1', city: 'Thành phố Mỹ Tho', state: 'Tiền Giang' }));
  assert.equal(old.address, 'Trưng Trắc, Phường 1, Đồng Tháp');
  assert.equal(old.hint, 'trước đây: Tiền Giang');

  const q1 = fromPhoton(photon({ osm_key: 'amenity', osm_value: 'cafe', name: 'Quán A', street: 'Lê Lợi', district: 'Phường Bến Thành', county: 'Quận 1', city: 'Hồ Chí Minh City' }));
  assert.equal(q1.address, 'Lê Lợi, Phường Bến Thành, TP. Hồ Chí Minh');

  const hue = fromPhoton(photon({ osm_key: 'tourism', osm_value: 'attraction', name: 'Đại Nội', city: 'Huế', state: 'Thừa Thiên Huế' }));
  assert.equal(hue.address, 'Huế');
  assert.equal(hue.hint, 'trước đây: Thừa Thiên Huế');

  // Tên địa điểm có tiền tố cấp huyện vẫn giữ nguyên (chỉ bỏ phần địa chỉ).
  const name = fromPhoton(photon({ osm_key: 'place', osm_value: 'town', name: 'Huyện Cần Giờ', city: 'Thành phố Hồ Chí Minh' }));
  assert.equal(name.name, 'Huyện Cần Giờ');
  assert.equal(name.address, 'TP. Hồ Chí Minh');
});

test('địa điểm trùng tên ngắn của tỉnh/thành: địa chỉ ghi dạng đầy đủ, không để trống', () => {
  // Mẫu Photon thật: điểm dân cư "Đồng Nai" (place=city), state "Thành phố Đồng Nai".
  const dn = fromPhoton(photon({ osm_key: 'place', osm_value: 'city', name: 'Đồng Nai', state: 'Thành phố Đồng Nai' }));
  assert.equal(dn.name, 'Đồng Nai');
  assert.equal(dn.address, 'Thành phố Đồng Nai');
  // Kết quả ranh giới tỉnh vẫn khác điểm dân cư.
  const dnb = fromPhoton(photon({ osm_key: 'boundary', osm_value: 'administrative', name: 'Thành phố Đồng Nai', state: 'Thành phố Đồng Nai' }));
  assert.equal(dnb.address, 'Đồng Nai');
  assert.notEqual(dnb.address, dn.address);
  const tq = fromPhoton(photon({ osm_key: 'place', osm_value: 'city', name: 'Tuyên Quang', state: 'Tỉnh Tuyên Quang' }));
  assert.equal(tq.address, 'Tỉnh Tuyên Quang');
  // Mẫu Nominatim thật.
  const bn = fromNominatim(nominatim('Bắc Ninh, Thành phố Bắc Ninh, 26000, Việt Nam', { name: 'Bắc Ninh', category: 'place', type: 'city' }));
  assert.equal(bn.address, 'Thành phố Bắc Ninh');
  const tqn = fromNominatim(nominatim('Tuyên Quang, Tỉnh Tuyên Quang, Việt Nam', { name: 'Tuyên Quang', category: 'place', type: 'city' }));
  assert.equal(tqn.address, 'Tỉnh Tuyên Quang');
  // Tên khác tỉnh thì vẫn dạng ngắn.
  const hl = fromPhoton(photon({ osm_key: 'natural', osm_value: 'bay', name: 'Vịnh Hạ Long', city: 'Quảng Ninh' }));
  assert.equal(hl.address, 'Quảng Ninh');
});

test('Photon: ranh giới cũ (boundary=historic) có gợi ý và xếp sau', () => {
  const hist = fromPhoton(photon({ osm_key: 'boundary', osm_value: 'historic', type: 'other', name: 'Tỉnh Bà Rịa - Vũng Tàu' }));
  assert.equal(hist.name, 'Tỉnh Bà Rịa - Vũng Tàu');
  assert.equal(hist.address, '');
  assert.equal(hist.hint, 'Ranh giới cũ, nay thuộc TP. Hồ Chí Minh');
  assert.equal(hist.former, true);
  const tdm = fromPhoton(photon({ osm_key: 'boundary', osm_value: 'historic', type: 'other', name: 'Thành phố Thủ Dầu Một', city: 'Thành phố Hồ Chí Minh' }));
  assert.equal(tdm.address, 'TP. Hồ Chí Minh');
  assert.equal(tdm.hint, 'Ranh giới cũ');
  const leftover = fromPhoton(photon({ osm_key: 'place', osm_value: 'state', name: 'Hà Giang' }));
  assert.equal(leftover.hint, 'Tỉnh cũ, nay thuộc Tuyên Quang');
});

test('Photon ngoài Việt Nam: giữ cách ghép địa chỉ cũ', () => {
  const la = fromPhoton(photon({ osm_key: 'place', osm_value: 'town', name: 'Pakse', city: 'Pakse', state: 'Champasak', country: 'Laos', countrycode: 'LA' }));
  assert.equal(la.address, 'Champasak');
  assert.equal(la.hint, undefined);
});

test('Nominatim dạng mới (display_name tiếng Việt)', () => {
  const cases = [
    ['Khu phố 9, Phường Tam Hiệp, Đồng Nai, Thành phố Đồng Nai, 76109, Việt Nam', 'Khu phố 9', 'Phường Tam Hiệp, Đồng Nai'],
    ['Khu phố 3, Phường Sài Gòn, Thành phố Hồ Chí Minh, 71016, Việt Nam', 'Khu phố 3', 'Phường Sài Gòn, TP. Hồ Chí Minh'],
    ['Tổ dân phố Tràng Tiền, Phường Hoàn Kiếm, Hà Nội, 11024, Việt Nam', 'Tổ dân phố Tràng Tiền', 'Phường Hoàn Kiếm, Hà Nội'],
    ['Phó Đức Chính, Tổ dân phố 11, Phường Quy Nhơn, Quy Nhơn, Tỉnh Gia Lai, 55111, Việt Nam', 'Phó Đức Chính', 'Tổ dân phố 11, Phường Quy Nhơn, Quy Nhơn, Gia Lai'],
    ['Khu vực Chợ Trung Tâm, Phường Phú Lợi, Sóc Trăng, Thành phố Cần Thơ, Việt Nam', 'Khu vực Chợ Trung Tâm', 'Phường Phú Lợi, Sóc Trăng, Cần Thơ'],
    ['Trần Hưng Đạo, Phường Hồng Gai, Thành phố Quảng Ninh, 01000, Việt Nam', 'Trần Hưng Đạo', 'Phường Hồng Gai, Quảng Ninh'],
    ['Thành phố Đồng Nai, Việt Nam', 'Thành phố Đồng Nai', ''],
  ];
  for (const [dn, name, address] of cases) {
    const r = fromNominatim(nominatim(dn, { name }));
    assert.equal(r.name, name, dn);
    assert.equal(r.address, address, dn);
    assert.equal(r.hint, undefined, dn);
  }
});

test('Nominatim dạng cũ và ranh giới cũ', () => {
  const old = fromNominatim(nominatim('Chợ Bến Thành, Phường Bến Thành, Quận 1, Thành phố Hồ Chí Minh, 71000, Việt Nam', { name: 'Chợ Bến Thành' }));
  assert.equal(old.address, 'Phường Bến Thành, TP. Hồ Chí Minh');
  const tg = fromNominatim(nominatim('Xã Long Hựu, Huyện Cần Đước, Tỉnh Long An, Việt Nam', { name: 'Xã Long Hựu' }));
  assert.equal(tg.address, 'Tây Ninh');
  assert.equal(tg.hint, 'trước đây: Long An');
  const hist = fromNominatim(nominatim('Tỉnh Hà Giang, Tỉnh Tuyên Quang, Việt Nam', { name: 'Tỉnh Hà Giang', category: 'boundary', type: 'historic' }));
  assert.equal(hist.address, '', 'gợi ý đã nói tỉnh mới');
  assert.equal(hist.hint, 'Ranh giới cũ, nay thuộc Tuyên Quang');
  assert.equal(hist.former, true);
  const qn = fromNominatim(nominatim('Tỉnh Quảng Nam, Việt Nam', { name: 'Tỉnh Quảng Nam', category: 'boundary', type: 'historic' }));
  assert.equal(qn.hint, 'Ranh giới cũ, nay thuộc Đà Nẵng');
  const ward = fromNominatim(nominatim('Phường Bình Dương, Thành phố Hồ Chí Minh, 75121, Việt Nam', { name: 'Phường Bình Dương', category: 'boundary', type: 'administrative' }));
  assert.equal(ward.address, 'TP. Hồ Chí Minh');
  assert.equal(ward.former, undefined);
});

test('Nominatim ngoài Việt Nam: không đổi', () => {
  const r = fromNominatim(nominatim('Pakse, Champasak, Laos', { name: 'Pakse' }));
  assert.equal(r.address, 'Champasak, Laos');
});

// ---------- Nhãn bản đồ nền ----------

const fakeStyle = () => ({
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'boundary_3', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', filter: ['==', ['get', 'admin_level'], 4] },
    {
      id: 'label_state',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      filter: ['==', ['get', 'class'], 'state'],
      layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] },
    },
    { id: 'label_legacy', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', filter: ['==', 'class', 'province'], layout: { 'text-field': '{name}' } },
    { id: 'label_nofilter', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'] } },
  ],
});

// Bộ đánh giá rút gọn đủ cho các biểu thức mà modernizeAdminLabels sinh ra.
function evaluate(expr, f) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...a] = expr;
  switch (op) {
    case 'get':
      return f[a[0]] ?? null;
    case 'coalesce':
      for (const x of a) {
        const v = evaluate(x, f);
        if (v != null) return v;
      }
      return null;
    case '==':
      return evaluate(a[0], f) === evaluate(a[1], f);
    case '!':
      return !evaluate(a[0], f);
    case 'all':
      return a.every((x) => evaluate(x, f));
    case 'case':
      for (let i = 0; i + 1 < a.length; i += 2) if (evaluate(a[i], f)) return evaluate(a[i + 1], f);
      return evaluate(a[a.length - 1], f);
    case 'match': {
      const v = evaluate(a[0], f);
      for (let i = 1; i + 1 < a.length; i += 2) {
        const labels = Array.isArray(a[i]) ? a[i] : [a[i]];
        if (labels.includes(v)) return evaluate(a[i + 1], f);
      }
      return evaluate(a[a.length - 1], f);
    }
    default:
      throw new Error(`chưa hỗ trợ ${op}`);
  }
}
// Bộ lọc kiểu cũ: chỉ các phép mà lớp thử dùng.
function evaluateLegacy(flt, f) {
  const [op, ...a] = flt;
  if (op === 'all') return a.every((x) => evaluateLegacy(x, f));
  if (op === 'none') return !a.some((x) => evaluateLegacy(x, f));
  if (op === '==') return f[a[0]] === a[1];
  if (op === 'in') return a.slice(1).includes(f[a[0]]);
  throw new Error(`chưa hỗ trợ ${op}`);
}

test('bản đồ nền: ẩn nhãn tỉnh đã bỏ, đổi nhãn tỉnh nay là thành phố, không đụng lớp khác', () => {
  const style = modernizeAdminLabels(localizeLabels(fakeStyle()));
  const base = fakeStyle();
  assert.deepEqual(style.layers[0], base.layers[0]);
  assert.deepEqual(style.layers[1], base.layers[1], 'ranh giới lấy từ dữ liệu OSM, không đổi');
  const [, , st, legacy, nofilter] = style.layers;
  assert.ok(isExpressionFilter(st.filter));
  assert.ok(!isExpressionFilter(legacy.filter));
  assert.ok(isExpressionFilter(nofilter.filter));

  const show = (layer, f) => (isExpressionFilter(layer.filter) ? evaluate(layer.filter, f) : evaluateLegacy(layer.filter, f));
  for (const name of ['Hà Giang', 'Tỉnh Hà Giang', 'Kon Tum', 'Tỉnh Bình Dương', 'Hoà Bình', 'Tỉnh Bà Rịa - Vũng Tàu']) {
    assert.equal(show(st, { class: 'state', name }), false, name);
    assert.equal(show(nofilter, { class: 'state', name }), false, name);
    assert.equal(show(legacy, { class: 'province', name }), false, name);
  }
  // Tên đơn vị còn dùng, và điểm dân cư trùng tên tỉnh cũ (class city/town), vẫn hiện.
  for (const name of ['Tuyên Quang', 'Tỉnh Gia Lai', 'Thành phố Hồ Chí Minh']) assert.equal(show(st, { class: 'state', name }), true, name);
  assert.equal(show(nofilter, { class: 'city', name: 'Hà Giang' }), true);
  assert.equal(show(nofilter, { class: 'town', name: 'Kon Tum' }), true);

  const text = (layer, f) => evaluate(layer.layout['text-field'], f);
  assert.equal(text(st, { class: 'state', name: 'Tỉnh Đồng Nai', name_en: 'Dong Nai Province' }), 'Thành phố Đồng Nai');
  assert.equal(text(st, { class: 'state', name: 'Tỉnh Quảng Ninh' }), 'Thành phố Quảng Ninh');
  assert.equal(text(st, { class: 'state', name: 'Tỉnh Bắc Ninh' }), 'Thành phố Bắc Ninh');
  assert.equal(text(st, { class: 'state', name: 'Thừa Thiên Huế' }), 'Huế');
  assert.equal(text(st, { class: 'state', name: 'Tỉnh Thừa Thiên Huế' }), 'Thành phố Huế');
  assert.equal(text(st, { class: 'state', name: 'Tỉnh Gia Lai', name_en: 'Gia Lai Province' }), 'Tỉnh Gia Lai', 'localizeLabels vẫn dùng tên gốc');
  assert.equal(text(nofilter, { class: 'city', name: 'Tỉnh Đồng Nai' }), 'Tỉnh Đồng Nai', 'chỉ đổi nhãn cấp tỉnh');
  assert.equal(legacy.layout['text-field'], '{name}', 'text-field dạng chuỗi giữ nguyên');
});

test('nhãn bản đồ: danh sách tên không trùng (biểu thức match của MapLibre đòi nhãn duy nhất)', () => {
  const hidden = abolishedLabelNames();
  assert.equal(new Set(hidden).size, hidden.length);
  for (const n of ABOLISHED) assert.ok(hidden.includes(n) && hidden.includes(`Tỉnh ${n}`), n);
  const from = provinceLabelRenames().flatMap(([f]) => f);
  assert.equal(new Set(from).size, from.length);
  for (const n of from) assert.ok(!hidden.includes(n), n);
  for (const u of UNITS) assert.ok(!hidden.includes(u.name), `${u.name} là tên đang dùng`);
});
