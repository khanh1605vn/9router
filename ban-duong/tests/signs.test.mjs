import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryEnabled,
  classifyNode,
  classifyWay,
  derived,
  formatNumberVi,
  lookupSign,
  parseCodeTag,
  parseDirection,
  parseMeasure,
  parseTrafficSign,
  SIGN_CATALOGUE,
  SIGN_CATEGORIES,
} from '../js/signs.js';
import { PICTOGRAMS, SIGN_SHAPES, signDataUrl, signSvg } from '../js/signart.js';

// Mọi mã trong danh sách QCVN 41:2024 đã nghiên cứu (dải "W.207a–l" đã khai triển từng chữ).
const LISTED_CODES = (
  'P.101 P.102 P.103a P.103b P.103c P.104 P.105 P.106a P.106b P.106c P.107 P.107a P.107b P.108 P.108a ' +
  'P.109 P.110a P.110b P.111a P.111b P.111c P.111d P.112 P.113 P.114 P.115 P.116 P.117 P.118 P.119 P.120 ' +
  'P.121 P.123a P.123b P.124a P.124b P.124c P.124d P.124e P.124f P.125 P.126 P.127 P.127a P.127b P.127c ' +
  'DP.127 P.128 P.129 P.130 P.131a P.131b P.131c P.132 DP.133 DP.134 DP.135 P.136 P.137 P.138 P.139 P.140 ' +
  'W.201a W.201b W.201c W.201d W.202a W.202b W.203a W.203b W.203c W.204 W.205a W.205b W.205c W.205d ' +
  'W.205e W.206 W.207a W.207b W.207c W.207d W.207e W.207f W.207g W.207h W.207i W.207j W.207k W.207l ' +
  'W.208 W.209 W.210 W.211 W.212 W.213 W.214 W.215a W.215b W.215c W.216a W.216b W.217 W.218 W.219 W.220 ' +
  'W.221a W.221b W.222a W.222b W.223a W.223b W.224 W.225 W.226 W.227 W.228a W.228b W.228c W.228d W.229 ' +
  'W.230 W.231 W.232 W.233 W.234 W.235 W.236 W.237 W.238 W.239a W.239b W.240 W.241 W.242a W.242b W.243a ' +
  'W.243b W.243c W.244 W.245a W.245b W.246a W.246b W.246c W.247 R.122 R.301a R.301b R.301c R.301d ' +
  'R.301e R.301f R.301g R.301h R.302a R.302b R.302c R.303 R.304 R.305 R.306 R.307 R.308a R.308b R.309 ' +
  'R.310a R.310b R.310c R.403a R.403b R.403c R.403d R.403e R.403f R.403g R.403h R.403k R.404a R.411 ' +
  'R.412a R.412b R.412c R.412d R.412e R.412f R.412g R.412h R.415a R.415b R.420 R.421 I.401 I.402 I.405a ' +
  'I.405b I.405c I.407a I.407b I.407c I.423a I.423b I.424a I.424b I.424c I.424d IE.452 IE.453a IE.453b IE.453c'
).split(' ');
// R.412i–p (hết làn dành riêng) cố ý không đưa vào danh mục.
const SKIPPED_CODES = 'R.412i R.412j R.412k R.412l R.412m R.412n R.412o R.412p'.split(' ');

const CAT_KEYS = SIGN_CATEGORIES.map((c) => c.key);
const one = (tags) => {
  const f = classifyNode(tags);
  assert.equal(f.length, 1, `mong đợi 1 đặc trưng, nhận ${JSON.stringify(f)}`);
  return f[0];
};

// ------------------------------------------------------------------------------------------
// Danh mục
// ------------------------------------------------------------------------------------------

test('danh mục: mọi mã trong danh sách nghiên cứu đều tra được', () => {
  assert.equal(LISTED_CODES.length, 210);
  for (const code of LISTED_CODES) {
    const e = lookupSign(code);
    assert.ok(e, `không tra được ${code}`);
    assert.ok(e.name && e.say, code);
    assert.ok(CAT_KEYS.includes(e.cat), `${code}: nhóm ${e.cat}`);
    assert.ok(SIGN_SHAPES.includes(e.art.shape), `${code}: hình dạng ${e.art.shape}`);
    assert.ok(PICTOGRAMS.includes(e.art.pict), `${code}: hình vẽ ${e.art.pict}`);
    assert.ok(!/[A-ZĐ]{3,}/.test(e.name.replace(/^[A-Z]+\./, '')), `${code}: không viết hoa toàn bộ`);
  }
  for (const code of SKIPPED_CODES) assert.equal(lookupSign(code), null, code);
});

test('danh mục: mục gộp theo bộ và theo dải', () => {
  // "P.111b, P.111c" → mỗi mã một mục; "W.207a–l" → một mục chung W.207.
  assert.equal(SIGN_CATALOGUE['P.111b'].name, SIGN_CATALOGUE['P.111c'].name);
  assert.equal(SIGN_CATALOGUE['W.207a'], undefined);
  assert.equal(SIGN_CATALOGUE['W.207'].code, 'W.207');
  for (const base of ['W.205', 'W.207', 'R.301', 'R.403', 'R.404', 'R.412', 'I.424', 'W.228']) {
    assert.ok(SIGN_CATALOGUE[base], base);
  }
  assert.equal(SIGN_CATALOGUE['W.216a'].name, 'Đường ngầm');
  assert.equal(SIGN_CATALOGUE['W.216b'].name, 'Đường ngầm có nguy cơ lũ quét');
  assert.ok(Object.isFrozen(SIGN_CATALOGUE['P.127'].art));
});

test('lookupSign: đúng mã, bỏ chữ cái cuối, dải chữ cái và họ cùng tên', () => {
  assert.equal(lookupSign('W.211a').code, 'W.211');
  assert.equal(lookupSign('W.207c').code, 'W.207');
  assert.equal(lookupSign('P.127').code, 'P.127');
  assert.equal(lookupSign('p.127').code, 'P.127');
  assert.equal(lookupSign('W.205f'), null); // ngoài dải a–e
  assert.equal(lookupSign('W.245').code, 'W.245a'); // họ W.245a/b cùng tên "Đi chậm"
  assert.equal(lookupSign('P.111'), null); // P.111a/b/c/d khác tên nhau
  assert.equal(lookupSign('X.101'), null);
  assert.equal(lookupSign(''), null);
  assert.equal(lookupSign(null), null);
});

test('nhóm cài đặt của từng biển', () => {
  const cat = (c) => lookupSign(c).cat;
  for (const c of ['P.127', 'P.127b', 'DP.127', 'DP.134', 'R.306', 'R.307', 'R.420', 'R.421', 'IE.452', 'IE.453a']) {
    assert.equal(cat(c), 'speed', c);
  }
  assert.equal(cat('W.209'), 'signals');
  for (const c of ['R.122', 'W.208', 'W.206', 'R.303', 'I.401', 'I.402', 'W.205c', 'W.207k']) assert.equal(cat(c), 'priority', c);
  for (const c of ['P.101', 'P.102', 'P.123a', 'P.130', 'DP.133', 'DP.135']) assert.equal(cat(c), 'prohibit', c);
  assert.equal(cat('W.221b'), 'calming');
  assert.equal(cat('W.221a'), 'danger');
  assert.equal(cat('W.224'), 'crossing');
  assert.equal(cat('I.423b'), 'crossing');
  for (const c of ['W.210', 'W.211', 'W.242a', 'W.243c']) assert.equal(cat(c), 'rail', c);
  for (const c of ['W.201a', 'W.233', 'W.240']) assert.equal(cat(c), 'danger', c);
  for (const c of ['R.301c', 'R.403a', 'I.407a', 'I.424b']) assert.equal(cat(c), 'info', c);
});

test('hình vẽ: biển cấm có vạch chéo theo mô tả, biển không vạch thì không có', () => {
  for (const c of ['P.103a', 'P.104', 'P.123a', 'P.124a', 'P.128', 'P.136', 'P.140']) assert.equal(SIGN_CATALOGUE[c].art.slash, true, c);
  for (const c of ['P.101', 'P.105', 'P.115', 'P.117', 'P.121', 'P.125', 'P.126', 'P.127']) {
    assert.ok(!SIGN_CATALOGUE[c].art.slash, c);
  }
  assert.equal(SIGN_CATALOGUE['P.102'].art.shape, 'noentry');
  assert.equal(SIGN_CATALOGUE['P.130'].art.shape, 'prohibit-blue');
  assert.equal(SIGN_CATALOGUE['P.131a'].art.shape, 'prohibit-blue');
  assert.equal(SIGN_CATALOGUE['DP.135'].art.shape, 'end');
  assert.equal(SIGN_CATALOGUE['W.208'].art.shape, 'giveway');
  assert.equal(SIGN_CATALOGUE['R.122'].art.shape, 'stop');
  assert.equal(SIGN_CATALOGUE['R.420'].art.shape, 'zone');
  assert.equal(SIGN_CATALOGUE['R.421'].art.slash, true);
  assert.equal(SIGN_CATALOGUE['I.402'].art.shape, 'priority');
  assert.equal(SIGN_CATALOGUE['IE.452'].art.shape, 'expressway');
  assert.equal(SIGN_CATALOGUE['W.242a'].art.shape, 'cross');
});

test('categoryEnabled: theo cài đặt, chưa có thì theo mặc định', () => {
  assert.equal(categoryEnabled('speed', {}), true);
  assert.equal(categoryEnabled('crossing', {}), false);
  assert.equal(categoryEnabled('crossing', { signCrossing: true }), true);
  assert.equal(categoryEnabled('speed', { signSpeed: false }), false);
  assert.equal(categoryEnabled('rail', { alertRail: false }), false);
  assert.equal(categoryEnabled('rail', undefined), true);
  assert.equal(categoryEnabled('khác', {}), true);
});

// ------------------------------------------------------------------------------------------
// traffic_sign, code, direction
// ------------------------------------------------------------------------------------------

test('parseTrafficSign: các kiểu ghi thật gặp ở Việt Nam', () => {
  const codes = (v) => parseTrafficSign(v).map((p) => p.code);
  assert.deepEqual(codes('VN:P.102'), ['P.102']);
  assert.deepEqual(codes('VN:P.103c'), ['P.103c']);
  assert.deepEqual(codes('VN:P.130'), ['P.130']);
  assert.deepEqual(codes('VN:W.245'), ['W.245']);
  assert.deepEqual(codes('VN:102'), ['P.102']); // thiếu chữ nhóm, khớp duy nhất
  assert.deepEqual(codes('VN:302a'), ['R.302a']);
  assert.deepEqual(codes('VN:402'), ['I.402']);
  const pair = parseTrafficSign('VN:401,127[60]');
  assert.deepEqual(
    pair.map((p) => [p.code, p.value]),
    [
      ['I.401', null],
      ['P.127', '60'],
    ],
  );
  assert.deepEqual(codes('vn:p.102'), [null]); // tiền tố phải là hai chữ in hoa
  assert.deepEqual(codes('VN:p.102'), ['P.102']); // chữ nhóm không phân biệt hoa thường
});

test('parseTrafficSign: không tách bên trong [] và "", tiền tố mặc định, nước khác', () => {
  const timed = parseTrafficSign('VN:P.103c[06:00-09:00,16:00-19:00]');
  assert.equal(timed.length, 1);
  assert.equal(timed[0].code, 'P.103c');
  assert.equal(timed[0].value, '06:00-09:00,16:00-19:00');

  const de = parseTrafficSign('DE:244.1,"Kfz-Verkehr frei"');
  assert.equal(de.length, 2);
  assert.deepEqual(de.map((p) => p.code), [null, null]);
  assert.equal(de[1].text, 'Kfz-Verkehr frei');

  // Tiền tố mặc định lấy từ phần tử có mã đầu tiên, không phải từ giá trị chung đứng đầu.
  const city = parseTrafficSign('city_limit;VN:R.420');
  assert.equal(city[0].named, 'city_limit');
  assert.equal(city[1].code, 'R.420');
  assert.deepEqual(parseTrafficSign('maxspeed;VN:401,127[50]').map((p) => p.code), [null, 'I.401', 'P.127']);
  assert.deepEqual(parseTrafficSign('VN:P.102;P.130').map((p) => p.code), ['P.102', 'P.130']);
  assert.deepEqual(parseTrafficSign('VN:P.102;VN:P.130').map((p) => p.code), ['P.102', 'P.130']);

  // Nước khác bị bỏ qua, kể cả phần tử không tiền tố theo sau.
  assert.deepEqual(parseTrafficSign('DE:274[60]').map((p) => p.code), [null]);
  assert.deepEqual(parseTrafficSign('DE:274;P.102').map((p) => p.code), [null, null]);
  assert.deepEqual(parseTrafficSign('VN:P.127[50];DE:123').map((p) => p.code), ['P.127', null]);

  // Không có tiền tố nào: chỉ nhận khi có chữ nhóm rõ ràng.
  assert.deepEqual(parseTrafficSign('P.102').map((p) => p.code), ['P.102']);
  assert.deepEqual(parseTrafficSign('127[60]').map((p) => p.code), [null]);

  // Thiếu chữ nhóm: P/DP trùng số thì chọn P; không khớp thì null.
  assert.equal(parseTrafficSign('VN:127[60]')[0].code, 'P.127');
  assert.equal(parseTrafficSign('VN:134')[0].code, 'DP.134');
  assert.equal(parseTrafficSign('VN:999')[0].code, null);

  // Giá trị chung.
  const named = parseTrafficSign('maxspeed;yes;give_way;none;variable_message;distance_marker');
  assert.deepEqual(named.map((p) => p.named), ['maxspeed', 'yes', 'give_way', 'none', 'variable_message', 'distance_marker']);
  assert.deepEqual(parseTrafficSign('residential').map((p) => [p.code, p.named]), [[null, null]]);
  assert.deepEqual(parseTrafficSign(''), []);
  assert.deepEqual(parseTrafficSign(undefined), []);
});

test('parseCodeTag: khoá không chuẩn code=VN.R.420', () => {
  assert.equal(parseCodeTag('VN.R.420').code, 'R.420');
  assert.equal(parseCodeTag('VN.R.421').code, 'R.421');
  assert.equal(parseCodeTag('VN.DP.134').code, 'DP.134');
  assert.equal(parseCodeTag('VN:P.127[40]').value, '40');
  assert.equal(parseCodeTag('Khu vực'), null);
  assert.equal(parseCodeTag(undefined), null);
});

test('parseDirection: chữ, số độ, phương hướng và thứ tự ưu tiên khoá', () => {
  const d = (v) => parseDirection({ direction: v }, ['direction']);
  assert.deepEqual(d('forward'), { mode: 'forward' });
  assert.deepEqual(d('backward'), { mode: 'backward' });
  assert.deepEqual(d('reverse'), { mode: 'backward' });
  assert.deepEqual(d('both'), { mode: 'both' });
  assert.deepEqual(d('all'), { mode: 'both' });
  assert.deepEqual(d('forward;backward'), { mode: 'both' });
  assert.deepEqual(d('45'), { mode: 'deg', degs: [45] });
  assert.deepEqual(d('360'), { mode: 'deg', degs: [0] });
  assert.deepEqual(d('45-100'), { mode: 'none' });
  assert.deepEqual(d('400'), { mode: 'none' });
  assert.deepEqual(d('NE'), { mode: 'deg', degs: [45] });
  assert.deepEqual(d('NNW'), { mode: 'deg', degs: [337.5] });
  assert.deepEqual(d('W'), { mode: 'deg', degs: [270] });
  assert.deepEqual(d('north'), { mode: 'deg', degs: [0] });
  assert.deepEqual(d('clockwise'), { mode: 'none' });
  assert.deepEqual(parseDirection({}, ['direction']), { mode: 'none' });
  const keys = ['traffic_signals:direction', 'direction'];
  assert.deepEqual(parseDirection({ direction: 'backward', 'traffic_signals:direction': 'forward' }, keys), {
    mode: 'forward',
  });
  assert.deepEqual(parseDirection({ direction: 'backward', 'traffic_signals:direction': ' ' }, keys), {
    mode: 'backward',
  });
});

test('parseDirection: nhiều giá trị cách nhau bằng ";" thì giữ mọi hướng, bỏ khoảng góc', () => {
  const d = (v) => parseDirection({ direction: v }, ['direction']);
  // Biển hai mặt: trước đây chỉ lấy giá trị đầu tiên (90), bỏ mất mặt quay về hướng 270.
  assert.deepEqual(d('90;270'), { mode: 'deg', degs: [90, 270] });
  assert.deepEqual(d('0; 180'), { mode: 'deg', degs: [0, 180] });
  assert.deepEqual(d('N;S'), { mode: 'deg', degs: [0, 180] });
  assert.deepEqual(d('90;90'), { mode: 'deg', degs: [90] });
  assert.deepEqual(d('45-100;190'), { mode: 'deg', degs: [190] });
  assert.deepEqual(d('45-100;190-250'), { mode: 'none' });
  assert.deepEqual(d('constructor'), { mode: 'none' });
});

// ------------------------------------------------------------------------------------------
// classifyNode
// ------------------------------------------------------------------------------------------

test('classifyNode: đèn tín hiệu, dừng lại, nhường đường, vòng xuyến nhỏ', () => {
  const sig = one({ highway: 'traffic_signals' });
  assert.equal(sig.kind, 'signals');
  assert.equal(sig.code, 'W.209');
  assert.equal(sig.cat, 'signals');
  assert.equal(sig.title, 'Đèn tín hiệu giao thông');
  assert.equal(sig.say, 'đèn tín hiệu giao thông');
  assert.deepEqual(sig.dirKeys, ['traffic_signals:direction', 'direction']);

  const stop = one({ highway: 'stop', traffic_sign: 'stop', direction: 'forward' }); // không bị lặp
  assert.equal(stop.code, 'R.122');
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.title, 'Biển dừng lại');
  assert.equal(stop.say, 'biển dừng lại, dừng hẳn xe');
  assert.equal(stop.needsJunction, true);
  assert.deepEqual(one({ highway: 'stop' }).dirKeys, ['stop:direction', 'direction']);
  assert.equal(one({ traffic_sign: 'VN:R.122' }).kind, 'stop');

  const gw = one({ highway: 'give_way' });
  assert.equal(gw.code, 'W.208');
  assert.equal(gw.title, 'Giao nhau với đường ưu tiên');
  assert.equal(gw.say, 'giao nhau với đường ưu tiên, chú ý nhường đường');
  assert.equal(gw.needsJunction, true);
  assert.deepEqual(gw.dirKeys, ['give_way:direction', 'direction']);
  assert.equal(one({ traffic_sign: 'give_way' }).kind, 'giveway');

  const mini = one({ highway: 'mini_roundabout' });
  assert.equal(mini.code, 'W.206');
  assert.equal(mini.say, 'vòng xuyến');
  assert.equal(mini.cat, 'priority');
});

test('classifyNode: vạch người đi bộ', () => {
  for (const tags of [
    { highway: 'crossing' },
    { highway: 'crossing', crossing: 'uncontrolled' },
    { highway: 'crossing', crossing: 'marked' },
    { highway: 'crossing', crossing: 'zebra' },
    { highway: 'crossing', crossing: 'island', crossing_ref: 'zebra' },
  ]) {
    const f = one(tags);
    assert.equal(f.code, 'W.224');
    assert.equal(f.cat, 'crossing');
    assert.equal(f.title, 'Vạch người đi bộ qua đường');
    assert.deepEqual(f.dirKeys, []);
  }
  for (const crossing of ['traffic_signals', 'unmarked', 'informal', 'no', 'marked;traffic_signals']) {
    assert.deepEqual(classifyNode({ highway: 'crossing', crossing }), [], crossing);
  }
  assert.deepEqual(classifyNode({ highway: 'crossing', 'crossing:markings': 'no' }), []);
});

test('classifyNode: gờ giảm tốc và vạch giảm tốc', () => {
  for (const v of ['bump', 'hump', 'table', 'cushion', 'yes', 'mini_bumps', 'choked_table']) {
    const f = one({ traffic_calming: v });
    assert.equal(f.code, 'W.221b');
    assert.equal(f.cat, 'calming');
    assert.equal(f.title, 'Gờ giảm tốc');
    assert.equal(f.say, 'gờ giảm tốc');
    assert.deepEqual(f.dirKeys, ['direction']);
  }
  const rumble = one({ traffic_calming: 'rumble_strip' });
  assert.equal(rumble.title, 'Vạch giảm tốc');
  assert.equal(rumble.say, 'vạch giảm tốc');
  for (const v of ['island', 'choked_island', 'painted_island', 'choker', 'chicane', 'dip']) {
    assert.deepEqual(classifyNode({ traffic_calming: v }), [], v);
  }
});

test('classifyNode: đường ngang đường sắt', () => {
  const barrier = one({ railway: 'level_crossing', 'crossing:barrier': 'full' });
  assert.equal(barrier.code, 'W.210');
  assert.equal(barrier.title, 'Đường sắt có rào chắn');
  assert.equal(barrier.say, 'đường ngang đường sắt có rào chắn');
  assert.equal(barrier.cat, 'rail');
  for (const v of ['yes', 'half', 'double_half']) assert.equal(one({ railway: 'level_crossing', 'crossing:barrier': v }).code, 'W.210', v);
  const none = one({ railway: 'level_crossing', 'crossing:barrier': 'no' });
  assert.equal(none.code, 'W.211');
  assert.equal(none.title, 'Đường sắt không có rào chắn');
  assert.equal(none.say, 'đường ngang đường sắt không có rào chắn, chú ý quan sát tàu');
  assert.deepEqual(none.dirKeys, []);
  // Dữ liệu không ghi rào chắn (hoặc ghi giá trị lạ): không được tự nói "có" hay "không có rào chắn".
  for (const tags of [{ railway: 'level_crossing' }, { railway: 'level_crossing', 'crossing:barrier': 'unknown' }]) {
    const f = one(tags);
    assert.equal(f.code, null);
    assert.equal(f.cat, 'rail');
    assert.equal(f.kind, 'rail');
    assert.equal(f.title, 'Đường ngang đường sắt');
    assert.equal(f.say, 'đường ngang đường sắt, chú ý quan sát tàu');
    assert.doesNotMatch(`${f.title} ${f.say}`, /rào chắn/);
    assert.match(f.note, /không ghi/);
    assert.deepEqual(f.art, { shape: 'danger', pict: 'train' });
    assert.deepEqual(f.dirKeys, []);
  }
});

test('classifyNode: thanh giới hạn chiều cao', () => {
  const f = one({ barrier: 'height_restrictor', maxheight: '3.5' });
  assert.equal(f.code, 'P.117');
  assert.equal(f.value, 3.5);
  assert.equal(f.title, 'Hạn chế chiều cao 3,5 m');
  assert.equal(f.say, 'hạn chế chiều cao 3,5 mét');
  assert.equal(f.cat, 'prohibit');
  assert.deepEqual(classifyNode({ barrier: 'height_restrictor' }), []);
  assert.deepEqual(classifyNode({ barrier: 'height_restrictor', maxheight: 'none' }), []);
});

test('classifyNode: hazard=*', () => {
  const h = (value) => one({ hazard: value });
  assert.equal(h('children').code, 'W.225');
  assert.equal(h('school_zone').code, 'W.225');
  assert.equal(h('pedestrians').code, 'W.224');
  assert.equal(h('pedestrians').cat, 'danger'); // nhóm nguy hiểm, không phải nhóm vạch qua đường
  assert.equal(h('bump').cat, 'danger');
  assert.equal(h('cyclists').code, 'W.226');
  assert.equal(h('animal_crossing').code, 'W.231');
  assert.equal(h('falling_rocks').title, 'Đá lở');
  assert.equal(h('landslide').code, 'W.228');
  assert.equal(h('loose_gravel').title, 'Sỏi đá bắn lên');
  for (const v of ['slippery', 'slippery_road', 'ice']) assert.equal(h(v).code, 'W.222a', v);
  assert.equal(h('side_winds').code, 'W.232');
  for (const v of ['dip', 'frost_heave', 'damaged_road']) assert.equal(h(v).code, 'W.221a', v);
  assert.equal(h('queues_likely').code, 'W.241');
  assert.equal(h('low_flying_aircraft').code, 'W.229');
  assert.equal(h('accident_blackspot').code, 'W.244');
  const curves = h('curves');
  assert.equal(curves.code, 'W.202');
  assert.equal(curves.title, 'Nhiều chỗ ngoặt nguy hiểm liên tiếp');
  const curve = h('curve');
  assert.equal(curve.code, null);
  assert.equal(curve.title, 'Chỗ ngoặt nguy hiểm');
  assert.deepEqual(curve.art, { shape: 'danger', pict: 'curves' });
  assert.equal(h('turn').code, null);
  assert.equal(h('dangerous_junction').title, 'Giao lộ nguy hiểm');
  assert.equal(h('dangerous_junction').code, null);
  assert.equal(h('weak_bridge').title, 'Cầu yếu');
  const other = h('erosion');
  assert.equal(other.code, 'W.233');
  assert.equal(other.title, 'Nguy hiểm khác');
  assert.equal(other.say, 'chú ý nguy hiểm');
  for (const v of ['children', 'curve', 'erosion']) {
    assert.equal(h(v).cat, 'danger');
    assert.deepEqual(h(v).dirKeys, ['hazard:direction', 'direction']);
    assert.match(h(v).kind, /^hazard:/);
  }
});

test('giá trị OSM trùng tên thuộc tính của Object (constructor, __proto__…) không làm hỏng việc phân loại', () => {
  for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const f = one({ hazard: v });
    assert.equal(f.code, 'W.233', v);
    assert.equal(f.title, 'Nguy hiểm khác', v);
    assert.equal(derived('hazard', { value: v }).code, 'W.233', v);
    assert.equal(one({ traffic_sign: 'hazard', hazard: v }).code, 'W.233', v);
  }
  // Đơn vị lạ trùng tên thuộc tính của Object: không đọc được, không trả NaN.
  assert.equal(parseMeasure('3 constructor', 'm'), null);
  assert.equal(parseMeasure('3constructor', 't'), null);
  assert.equal(parseMeasure('3.5 m', 'm'), 3.5);
  // Hướng "chỉ được đi" lạ: không có biển.
  assert.equal(derived('turn', { only: 'constructor' }), null);
  assert.equal(derived('turn', { only: '__proto__', bans: [] }), null);
});

test('classifyNode: traffic_sign có mã và tốc độ', () => {
  const speed = one({ traffic_sign: 'VN:P.127[50]' });
  assert.equal(speed.kind, 'speed:50');
  assert.equal(speed.code, 'P.127');
  assert.equal(speed.value, 50);
  assert.equal(speed.title, 'Tốc độ tối đa 50 km/h');
  assert.equal(speed.say, 'biển tốc độ tối đa 50 ki lô mét trên giờ');
  assert.equal(speed.cat, 'speed');
  assert.deepEqual(speed.dirKeys, ['traffic_sign:direction', 'direction']);
  assert.equal(one({ traffic_sign: 'VN:P.127', maxspeed: '60' }).value, 60);
  assert.deepEqual(classifyNode({ traffic_sign: 'VN:P.127' }), []); // thiếu số thì bỏ
  assert.equal(one({ traffic_sign: 'maxspeed', maxspeed: '70' }).kind, 'speed:70');
  assert.deepEqual(classifyNode({ traffic_sign: 'maxspeed', maxspeed: 'VN:urban' }), []);
  assert.deepEqual(classifyNode({ traffic_sign: 'maxspeed', maxspeed: 'implicit' }), []);

  const both = classifyNode({ traffic_sign: 'VN:401,127[60]' });
  assert.deepEqual(both.map((f) => f.kind), ['sign:I.401', 'speed:60']);
  assert.equal(both[0].cat, 'priority');

  const end = one({ traffic_sign: 'VN:DP.134' });
  assert.equal(end.title, 'Hết tốc độ tối đa cho phép');
  assert.equal(end.code, 'DP.134');

  const fwd = one({ 'traffic_sign:forward': 'VN:P.102' });
  assert.equal(fwd.dirFixed, 'forward');
  assert.equal(fwd.kind, 'sign:P.102');
  assert.equal(fwd.title, 'Cấm đi ngược chiều');
  const two = classifyNode({ 'traffic_sign:forward': 'VN:P.125', 'traffic_sign:backward': 'VN:P.125' });
  assert.deepEqual(two.map((f) => f.dirFixed), ['forward', 'backward']);

  assert.equal(one({ traffic_sign: 'VN:W.245' }).title, 'Đi chậm');
  assert.equal(one({ traffic_sign: 'VN:W.207c' }).code, 'W.207c');
  assert.deepEqual(classifyNode({ traffic_sign: 'DE:274[60]' }), []);
  assert.deepEqual(classifyNode({ traffic_sign: 'VN:S.999' }), []);
  assert.deepEqual(classifyNode({ traffic_sign: 'distance_marker' }), []);
});

test('classifyNode: biển kích thước, tải trọng lấy trị số từ [] hoặc thẻ đi kèm', () => {
  const h = one({ traffic_sign: 'VN:P.117[3.5]' });
  assert.equal(h.value, 3.5);
  assert.equal(h.title, 'Hạn chế chiều cao 3,5 m');
  assert.equal(one({ traffic_sign: 'VN:P.117', maxheight: '4' }).value, 4);
  const w = one({ traffic_sign: 'VN:P.115', maxweight: '10' });
  assert.equal(w.title, 'Hạn chế trọng tải 10 tấn');
  assert.equal(w.say, 'hạn chế trọng tải 10 tấn');
  const truck = one({ traffic_sign: 'VN:P.106b[2.5]' });
  assert.equal(truck.title, 'Cấm xe tải trên 2,5 tấn');
  assert.equal(one({ traffic_sign: 'VN:P.118', maxwidth: '2' }).title, 'Hạn chế chiều ngang 2 m');
  const bare = one({ traffic_sign: 'VN:P.115' }); // không có trị số vẫn báo
  assert.equal(bare.value, null);
  assert.equal(bare.title, 'Hạn chế trọng tải toàn bộ xe');
});

test('classifyNode: city_limit, overtaking và yes chỉ tin khi có thẻ đi kèm', () => {
  assert.equal(one({ traffic_sign: 'city_limit', code: 'VN.R.420' }).code, 'R.420');
  assert.equal(one({ traffic_sign: 'city_limit', code: 'VN.R.421' }).code, 'R.421');
  assert.equal(one({ traffic_sign: 'city_limit', content: 'Khu Vực Đông Dân Cư' }).code, 'R.420');
  assert.equal(one({ traffic_sign: 'city_limit', content: 'Hết khu đông dân cư' }).code, 'R.421');
  assert.equal(one({ traffic_sign: 'city_limit', content: 'Khu đông dân cư', name: 'Hết khu đông dân cư' }).code, 'R.421');
  assert.equal(one({ traffic_sign: 'city_limit', code: 'VN.DP.134', content: 'Hết Tốc Độ Tối Đa 40' }).code, 'DP.134');
  assert.equal(one({ traffic_sign: 'city_limit', code: 'VN.DP.135' }).code, 'DP.135');
  assert.deepEqual(classifyNode({ traffic_sign: 'city_limit', name: 'Xã Lai Vung' }), []);
  assert.equal(one({ traffic_sign: 'city_limit', code: 'VN.R.420' }).cat, 'speed');

  assert.equal(one({ traffic_sign: 'overtaking', overtaking: 'no' }).code, 'P.125');
  assert.deepEqual(classifyNode({ traffic_sign: 'overtaking' }), []);

  assert.equal(one({ traffic_sign: 'yes', maxspeed: '50' }).kind, 'speed:50');
  assert.equal(one({ traffic_sign: 'yes', overtaking: 'no' }).code, 'P.125');
  assert.equal(one({ traffic_sign: 'yes', code: 'VN.DP.135' }).code, 'DP.135');
  assert.deepEqual(classifyNode({ traffic_sign: 'yes' }), []);
  assert.deepEqual(classifyNode({ traffic_sign: 'yes', 'traffic_sign:direction': 'forward' }), []);
});

test('classifyNode: bỏ trùng giữa traffic_sign=hazard và hazard=*', () => {
  const f = one({ traffic_sign: 'hazard', hazard: 'children' });
  assert.equal(f.code, 'W.225');
  assert.deepEqual(classifyNode({}), []);
  assert.deepEqual(classifyNode(undefined), []);
});

// ------------------------------------------------------------------------------------------
// classifyWay, parseMeasure, formatNumberVi
// ------------------------------------------------------------------------------------------

test('classifyWay: cấm phương tiện', () => {
  const none = classifyWay(undefined);
  assert.equal(none.noCar || none.noMoto || none.noAll || none.roundabout || none.tunnel, false);
  assert.equal(none.hazard, null);
  assert.deepEqual(none.dims.forward, { h: null, w: null, wd: null });

  const all = classifyWay({ access: 'no' });
  assert.deepEqual([all.noAll, all.noCar, all.noMoto], [true, true, true]);
  assert.equal(classifyWay({ vehicle: 'no' }).noAll, true);
  const mv = classifyWay({ motor_vehicle: 'no' });
  assert.deepEqual([mv.noAll, mv.noCar, mv.noMoto], [false, true, true]);
  const car = classifyWay({ motorcar: 'no' });
  assert.deepEqual([car.noCar, car.noMoto], [true, false]);
  const moto = classifyWay({ motorcycle: 'no' });
  assert.deepEqual([moto.noCar, moto.noMoto], [false, true]);
  // Thẻ riêng thắng thẻ chung.
  const allowCar = classifyWay({ access: 'no', motorcar: 'yes' });
  assert.deepEqual([allowCar.noAll, allowCar.noCar, allowCar.noMoto], [false, false, true]);
  const allowMv = classifyWay({ access: 'no', motor_vehicle: 'yes' });
  assert.deepEqual([allowMv.noAll, allowMv.noCar, allowMv.noMoto], [false, false, false]);
  for (const v of ['private', 'destination', 'delivery', 'permissive']) {
    const w = classifyWay({ access: v });
    assert.equal(w.noCar || w.noMoto || w.noAll, false, v);
  }
  assert.equal(classifyWay({ 'motorcar:conditional': 'no @ (06:00-09:00)' }).noCar, false);
});

test('classifyWay: vòng xuyến, hầm, kích thước, cấm vượt, nguy hiểm', () => {
  assert.equal(classifyWay({ junction: 'roundabout' }).roundabout, true);
  assert.equal(classifyWay({ junction: 'circular' }).roundabout, true);
  assert.equal(classifyWay({ tunnel: 'yes' }).tunnel, true);
  assert.equal(classifyWay({ tunnel: 'building_passage' }).tunnel, false);
  assert.equal(classifyWay({ tunnel: 'culvert' }).tunnel, false);

  const dims = classifyWay({ maxheight: '3.5', 'maxweight:forward': '10', maxweight: '20', maxwidth: '2,2' }).dims;
  assert.deepEqual(dims.forward, { h: 3.5, w: 10, wd: 2.2 });
  assert.deepEqual(dims.backward, { h: 3.5, w: 20, wd: 2.2 });
  assert.equal(classifyWay({ 'maxheight:physical': '4.2' }).dims.forward.h, 4.2);
  assert.equal(classifyWay({ maxheight: '3', 'maxheight:physical': '4.2' }).dims.backward.h, 3);
  assert.equal(classifyWay({ 'maxheight:backward': '2.8' }).dims.backward.h, 2.8);
  assert.equal(classifyWay({ 'maxheight:backward': '2.8' }).dims.forward.h, null);

  const ov = (tags) => classifyWay(tags).noOvertake;
  assert.deepEqual(ov({ overtaking: 'no' }), { forward: true, backward: true });
  assert.deepEqual(ov({ overtaking: 'forward' }), { forward: false, backward: true });
  assert.deepEqual(ov({ overtaking: 'backward' }), { forward: true, backward: false });
  assert.deepEqual(ov({ overtaking: 'yes' }), { forward: false, backward: false });
  assert.deepEqual(ov({ 'overtaking:forward': 'no' }), { forward: true, backward: false });
  assert.deepEqual(ov({ 'overtaking:backward': 'no' }), { forward: false, backward: true });

  assert.equal(classifyWay({ hazard: 'curves' }).hazard, 'curves');
});

test('parseMeasure: đơn vị mét và tấn', () => {
  assert.equal(parseMeasure('3.5', 'm'), 3.5);
  assert.equal(parseMeasure('3,5', 'm'), 3.5);
  assert.equal(parseMeasure('3.5 m', 'm'), 3.5);
  assert.equal(parseMeasure('3.5m', 'm'), 3.5);
  assert.equal(parseMeasure(`12'6"`, 'm'), 3.81);
  assert.equal(parseMeasure(`12'`, 'm'), 3.66);
  assert.equal(parseMeasure('5 t', 't'), 5);
  assert.equal(parseMeasure('5', 't'), 5);
  assert.equal(parseMeasure('500 kg', 't'), 0.5);
  assert.equal(parseMeasure('3 st', 't'), 2.72);
  assert.equal(parseMeasure('4000 lbs', 't'), 1.81);
  assert.equal(parseMeasure(3.5, 'm'), 3.5);
  for (const v of ['none', 'default', 'below_default', 'unsigned', 'empty', '', '  ', '0', '-2', 'abc', null, undefined]) {
    assert.equal(parseMeasure(v, 'm'), null, String(v));
  }
  assert.equal(parseMeasure('3 m', 't'), null); // sai đơn vị
  assert.equal(parseMeasure('5 t', 'm'), null);
  assert.equal(parseMeasure(`12'6"`, 't'), null);
});

test('formatNumberVi: dấu phẩy thập phân, dấu chấm hàng nghìn', () => {
  assert.equal(formatNumberVi(3.5), '3,5');
  assert.equal(formatNumberVi(50), '50');
  assert.equal(formatNumberVi(100), '100');
  assert.equal(formatNumberVi(2.25), '2,25');
  assert.equal(formatNumberVi(0.5), '0,5');
  assert.equal(formatNumberVi(1850), '1.850');
  assert.equal(formatNumberVi(13.94, 1), '13,9');
  assert.equal(formatNumberVi(null), '');
  assert.equal(formatNumberVi('x'), '');
});

// ------------------------------------------------------------------------------------------
// derived
// ------------------------------------------------------------------------------------------

test('derived: tốc độ, chỗ ngoặt, vòng xuyến, hầm, một chiều', () => {
  const sp = derived('speedChange', { n: 50 });
  assert.equal(sp.code, 'P.127');
  assert.equal(sp.title, 'Tốc độ tối đa 50 km/h');
  assert.equal(sp.say, 'tốc độ tối đa 50 ki lô mét trên giờ');
  assert.equal(sp.value, 50);
  assert.equal(sp.note, 'Theo dữ liệu giới hạn tốc độ của OpenStreetMap.');

  const left = derived('curve', { side: 'left' });
  assert.equal(left.code, 'W.201a');
  assert.equal(left.title, 'Chỗ ngoặt nguy hiểm vòng bên trái');
  assert.equal(left.say, 'chỗ ngoặt nguy hiểm vòng bên trái');
  assert.equal(left.note, 'Tính từ hình dạng đường trên bản đồ, không phải biển thật.');
  const right = derived('curve', { side: 'right' });
  assert.equal(right.code, 'W.201b');
  assert.equal(right.say, 'chỗ ngoặt nguy hiểm vòng bên phải');
  const curves = derived('curves');
  assert.equal(curves.code, 'W.202');
  assert.equal(curves.say, 'nhiều chỗ ngoặt nguy hiểm liên tiếp');

  assert.equal(derived('roundabout').code, 'W.206');
  const tunnel = derived('tunnel');
  assert.equal(tunnel.code, 'W.240');
  assert.equal(tunnel.say, 'sắp vào hầm');
  const oneway = derived('oneway');
  assert.equal(oneway.code, 'P.102');
  assert.equal(oneway.say, 'đường cấm đi ngược chiều');
  assert.equal(oneway.note, 'Theo dữ liệu đường một chiều của OpenStreetMap.');
});

test('derived: cấm phương tiện, kích thước, cấm vượt, nguy hiểm', () => {
  assert.equal(derived('noAccess', { all: true }).code, 'P.101');
  assert.equal(derived('noAccess', { all: true }).title, 'Đường cấm');
  assert.equal(derived('noAccess', { vehicle: 'car' }).code, 'P.103a');
  assert.equal(derived('noAccess', { vehicle: 'car' }).title, 'Cấm xe ô tô');
  assert.equal(derived('noAccess', { vehicle: 'moto' }).code, 'P.104');
  assert.equal(derived('noAccess', { vehicle: 'moto' }).title, 'Cấm xe máy');

  const h = derived('height', { v: 3.5 });
  assert.equal(h.code, 'P.117');
  assert.equal(h.title, 'Hạn chế chiều cao 3,5 m');
  assert.equal(h.say, 'hạn chế chiều cao 3,5 mét');
  assert.equal(h.value, 3.5);
  const w = derived('weight', { v: 10 });
  assert.equal(w.code, 'P.115');
  assert.equal(w.title, 'Hạn chế trọng tải 10 tấn');
  assert.equal(w.say, 'hạn chế trọng tải 10 tấn');
  const wd = derived('width', { v: 2.5 });
  assert.equal(wd.code, 'P.118');
  assert.equal(wd.title, 'Hạn chế chiều ngang 2,5 m');
  assert.equal(wd.say, 'hạn chế chiều ngang xe 2,5 mét');

  assert.equal(derived('noOvertake').code, 'P.125');
  assert.equal(derived('noOvertake').say, 'cấm vượt');
  const hz = derived('hazard', { value: 'children' });
  assert.equal(hz.code, 'W.225');
  assert.equal(hz.cat, 'danger');
  assert.equal(derived('nope'), null);
});

test('derived: cấm rẽ ghép biển theo tổ hợp hướng', () => {
  const t = (bans, extra = {}) => derived('turn', { bans: new Set(bans), only: null, timed: false, ...extra });
  const cases = [
    [['left'], 'P.123a', 'Cấm rẽ trái'],
    [['right'], 'P.123b', 'Cấm rẽ phải'],
    [['uturn'], 'P.124a', 'Cấm quay đầu xe'],
    [['left', 'uturn'], 'P.124c', 'Cấm rẽ trái và quay đầu xe'],
    [['uturn', 'right'], 'P.124d', 'Cấm rẽ phải và quay đầu xe'],
    [['left', 'right'], 'P.137', 'Cấm rẽ trái, rẽ phải'],
    [['straight'], 'P.136', 'Cấm đi thẳng'],
    [['left', 'straight'], 'P.138', 'Cấm đi thẳng, rẽ trái'],
    [['straight', 'right'], 'P.139', 'Cấm đi thẳng, rẽ phải'],
  ];
  for (const [bans, code, title] of cases) {
    const f = t(bans);
    assert.equal(f.code, code, bans.join('+'));
    assert.equal(f.title, title);
    assert.equal(f.cat, 'prohibit');
    assert.equal(f.note, 'Theo dữ liệu cấm rẽ của OpenStreetMap.');
  }
  assert.equal(t(['left']).say, 'cấm rẽ trái');

  const many = t(['left', 'right', 'uturn']);
  assert.equal(many.code, null);
  assert.equal(many.title, 'Cấm rẽ trái, rẽ phải và quay đầu');
  assert.equal(many.say, 'cấm rẽ trái, rẽ phải và quay đầu');
  assert.ok(many.art && many.art.shape === 'prohibit');

  const only = (o) => derived('turn', { bans: new Set(), only: o });
  assert.equal(only('straight').title, 'Chỉ được đi thẳng');
  assert.equal(only('left').title, 'Chỉ được rẽ trái');
  assert.equal(only('right').title, 'Chỉ được rẽ phải');
  assert.equal(only('right').say, 'chỉ được rẽ phải');
  assert.equal(only('left').code, 'R.301');
  assert.equal(only('left').art.shape, 'mandatory');

  const timed = t(['left'], { timed: true });
  assert.equal(timed.title, 'Cấm rẽ trái theo giờ');
  assert.equal(timed.say, 'cấm rẽ trái theo giờ');
  assert.equal(derived('turn', { bans: new Set() }), null);
});

test('derived: mọi kết quả có derived, note và hình vẽ', () => {
  const list = [
    derived('speedChange', { n: 60 }),
    derived('curve', { side: 'left' }),
    derived('curves'),
    derived('roundabout'),
    derived('tunnel'),
    derived('oneway'),
    derived('noAccess', { vehicle: 'car' }),
    derived('height', { v: 4 }),
    derived('weight', { v: 3 }),
    derived('width', { v: 2 }),
    derived('noOvertake'),
    derived('hazard', { value: 'weak_bridge' }),
    derived('turn', { bans: ['uturn'] }),
  ];
  for (const f of list) {
    assert.equal(f.derived, true, f.kind);
    assert.ok(typeof f.note === 'string' && f.note.length > 10, f.kind);
    assert.ok(f.kind && f.title && f.say && f.cat && f.art, f.kind);
    assert.deepEqual(f.dirKeys, []);
  }
});

// ------------------------------------------------------------------------------------------
// signart
// ------------------------------------------------------------------------------------------

/** Kiểm tra SVG có cấu trúc XML đúng: thẻ đóng mở khớp, thuộc tính có ngoặc kép, không trùng. */
function assertWellFormed(svg, label) {
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), label);
  assert.ok(svg.endsWith('</svg>'), label);
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let pos = 0;
  let m;
  while ((m = tagRe.exec(svg))) {
    const between = svg.slice(pos, m.index);
    assert.ok(!/[<>]/.test(between), `${label}: ký tự lạ trước ${m[0]}`);
    pos = tagRe.lastIndex;
    const [, close, name, attrs, self] = m;
    const names = [...attrs.matchAll(/([\w:-]+)="/g)].map((a) => a[1]);
    assert.equal(new Set(names).size, names.length, `${label}: thuộc tính trùng trong ${m[0]}`);
    if (close) assert.equal(stack.pop(), name, `${label}: thẻ đóng ${name} không khớp`);
    else if (!self) stack.push(name);
  }
  assert.equal(pos, svg.length, `${label}: còn phần không đọc được`);
  assert.equal(stack.length, 0, `${label}: thẻ chưa đóng ${stack}`);
  assert.ok(!/\sid=|href|url\(|<script|<foreignObject|javascript:/i.test(svg), `${label}: có tham chiếu cấm`);
}

const SAMPLE = { speed: 50, height: 3.5, width: 2, weight: 10, length: 12, gap: 70, axle: 7, truck: 2.5 };

test('signSvg: SVG hợp lệ cho mọi mục trong danh mục', () => {
  for (const e of Object.values(SIGN_CATALOGUE)) {
    const svg = signSvg(e.art, { size: 48, value: SAMPLE[e.art.pict] ?? null, title: e.name });
    assertWellFormed(svg, e.code);
    assert.match(svg, /viewBox="0 0 100 100"/);
    assert.match(svg, /width="48" height="48"/);
    assertWellFormed(signSvg(e.art), `${e.code} (không trị số)`);
  }
  for (const pict of PICTOGRAMS) {
    for (const shape of SIGN_SHAPES) assertWellFormed(signSvg({ shape, pict, slash: true }, { value: '120' }), `${shape}/${pict}`);
  }
});

test('signSvg: in trị số đã lọc và từ chối giá trị độc hại', () => {
  const art = SIGN_CATALOGUE['P.127'].art;
  assert.match(signSvg(art, { value: 50 }), />50</);
  assert.match(signSvg(art, { value: '120' }), />120</);
  assert.match(signSvg(SIGN_CATALOGUE['P.117'].art, { value: '3.5' }), />3,5m</);
  assert.match(signSvg(SIGN_CATALOGUE['P.117'].art, { value: 3.81 }), />3,8m</);
  const plain = signSvg(art, { value: null });
  for (const bad of ['<script>', '50"><x', '1234', '5e1', '-5', ' ', '3,55', {}, NaN, Infinity]) {
    const svg = signSvg(art, { value: bad });
    assert.equal(svg, plain, `giá trị ${String(bad)} phải bị bỏ`);
    assertWellFormed(svg, String(bad));
  }
  assert.ok(!signSvg(art, { value: '<script>' }).includes('script'));
});

test('signSvg: tiêu đề được thoát ký tự, kích thước bị chặn, hình lạ vẫn vẽ được', () => {
  const svg = signSvg(SIGN_CATALOGUE['W.233'].art, { title: '<b onload="x">&\'' });
  assertWellFormed(svg, 'title');
  assert.ok(svg.includes('aria-label="&lt;b onload=&quot;x&quot;&gt;&amp;&#39;"'));
  assert.ok(svg.includes('<title>&lt;b onload=&quot;x&quot;&gt;&amp;&#39;</title>'));
  assert.ok(!svg.includes('<b '));
  assert.match(signSvg(SIGN_CATALOGUE['W.233'].art), /aria-hidden="true"/);
  assert.match(signSvg(SIGN_CATALOGUE['W.233'].art, { size: 99999 }), /width="512"/);
  assert.match(signSvg(SIGN_CATALOGUE['W.233'].art, { size: '"><x' }), /width="48"/);
  for (const art of [null, undefined, {}, { shape: 'x', pict: 'y' }, { shape: 'prohibit', pict: '__proto__' }]) {
    assertWellFormed(signSvg(art), JSON.stringify(art));
  }
  const text = signSvg({ shape: 'danger', pict: 'text', text: 'Đi <chậm>' });
  assertWellFormed(text, 'text');
  assert.ok(text.includes('&lt;chậm&gt;'));
});

test('signSvg: màu theo kiểu biển Việt Nam', () => {
  assert.match(signSvg(SIGN_CATALOGUE['P.123a'].art), /#d5202a/);
  assert.match(signSvg(SIGN_CATALOGUE['W.201a'].art), /#ffd21f/);
  assert.match(signSvg(SIGN_CATALOGUE['R.301'].art), /#0a57a4/);
  assert.match(signSvg(SIGN_CATALOGUE['IE.452'].art), /#0b7a45/);
  assert.match(signSvg(SIGN_CATALOGUE['R.122'].art), />STOP</);
  // Vạch chéo đỏ đi từ trên trái xuống dưới phải.
  assert.match(signSvg(SIGN_CATALOGUE['P.123a'].art), /d="M22 22L78 78" fill="none" stroke="#d5202a"/);
});

test('signDataUrl: data URL mã hoá đúng nội dung SVG', () => {
  const art = SIGN_CATALOGUE['P.127'].art;
  const url = signDataUrl(art, { value: 60, size: 40 });
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), signSvg(art, { value: 60, size: 40 }));
  assert.ok(!/[<>"#\s]/.test(url.slice(url.indexOf(',') + 1)));
});

// ------------------------------------------------------------------------------------------
// Biển suy ra từ thẻ sẵn có (PLAN 1.6)
// ------------------------------------------------------------------------------------------

test('classifyWay: tốc độ tối thiểu, đường ngầm, đường thu phí; giá trị lạ thì không có', () => {
  const w = classifyWay({ minspeed: '60', ford: 'yes', toll: 'yes' });
  assert.deepEqual([w.minspeed, w.ford, w.toll], [60, true, true]);
  const none = classifyWay({ minspeed: 'VN:motorway', ford: 'stepping_stones', toll: 'no' });
  assert.deepEqual([none.minspeed, none.ford, none.toll], [null, false, false]);
  assert.deepEqual([classifyWay(undefined).minspeed, classifyWay(undefined).ford, classifyWay(undefined).toll], [null, false, false]);
});

test('classifyNode: nút ford=yes là đường ngầm W.216a (suy ra, không phải biển thật)', () => {
  const f = one({ ford: 'yes' });
  assert.equal(f.code, 'W.216a');
  assert.equal(f.cat, 'danger');
  assert.equal(f.derived, true);
  assert.match(f.note, /không phải biển thật/);
  assert.deepEqual(classifyNode({ ford: 'boat' }), []);
});

test('derived: bắt đầu đường cao tốc (không kèm con số), tốc độ tối thiểu, đường ngầm, đường thu phí, cấm theo giờ', () => {
  const mw = derived('motorway');
  assert.deepEqual([mw.code, mw.title, mw.say, mw.value], ['IE.452', 'Bắt đầu đường cao tốc', 'bắt đầu đường cao tốc', null]);
  assert.ok(!/\d/.test(mw.title + mw.say), 'không có trị số tốc độ');
  const min = derived('minspeed', { n: 60 });
  assert.deepEqual([min.code, min.kind, min.title, min.say, min.value], ['R.306', 'minspeed:60', 'Tốc độ tối thiểu 60 km/h', 'tốc độ tối thiểu 60 ki lô mét trên giờ', 60]);
  assert.deepEqual([derived('ford').code, derived('ford').say], ['W.216a', 'đường ngầm, chú ý nước']);
  const toll = derived('toll');
  assert.deepEqual([toll.code, toll.cat, toll.title], [null, 'info', 'Đường có thu phí']);
  const timed = derived('noAccess', { vehicle: 'car', timed: true });
  assert.deepEqual([timed.code, timed.say], ['P.103a', 'đường cấm ô tô']);
  assert.match(timed.note, /theo giờ/);
  assert.doesNotMatch(derived('noAccess', { vehicle: 'car' }).note, /theo giờ/);
  for (const f of [mw, min, derived('ford'), toll, timed]) {
    assert.equal(f.derived, true, f.kind);
    assert.ok(typeof f.note === 'string' && f.note.length > 10, f.kind);
    assert.ok(f.kind && f.title && f.say && f.cat && f.art, f.kind);
    assert.deepEqual(f.dirKeys, []);
    assertWellFormed(signSvg(f.art, { value: f.value }), f.kind);
  }
});
