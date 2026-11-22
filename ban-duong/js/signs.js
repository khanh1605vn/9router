// Danh mục biển báo theo QCVN 41:2024/BGTVT và bộ đọc thẻ OpenStreetMap thành "biển phía trước".
// Thuần logic, không đụng tới DOM. Tên biển lấy từ nguồn thứ cấp đã rà soát; hình vẽ (signart.js)
// là hình giản lược tự vẽ, không phải bản sao hình gốc.

import { parseMaxspeed } from './roaddata.js';

// ---------------------------------------------------------------------------------------------
// Danh mục
// ---------------------------------------------------------------------------------------------

// Mỗi dòng: [mã (nhiều mã cách nhau bằng dấu cách), tên, câu đọc, hình dạng, hình vẽ, thêm]
// "thêm": 1 = có vạch chéo đỏ; hoặc đối tượng gộp vào art (text, stripes, flip…).
// Câu đọc đã được làm mượt để ghép sau "Phía trước 150 mét, …"; {n} là chỗ điền con số.
const S = 1;
const ROWS = [
  // Biển cấm (P) và hết cấm (DP)
  ['P.101', 'Đường cấm', 'đường cấm', 'prohibit', 'blank'],
  ['P.102', 'Cấm đi ngược chiều', 'cấm đi ngược chiều', 'noentry', 'blank'],
  ['P.103a', 'Cấm xe ô tô', 'cấm ô tô', 'prohibit', 'car', S],
  ['P.103b', 'Cấm xe ô tô rẽ phải', 'cấm ô tô rẽ phải', 'prohibit', 'car-right', S],
  ['P.103c', 'Cấm xe ô tô rẽ trái', 'cấm ô tô rẽ trái', 'prohibit', 'car-left', S],
  ['P.104', 'Cấm xe máy', 'cấm xe máy', 'prohibit', 'moto', S],
  ['P.105', 'Cấm xe ô tô và xe máy', 'cấm ô tô và xe máy', 'prohibit', 'car-moto'],
  ['P.106a', 'Cấm xe ô tô tải', 'cấm xe tải', 'prohibit', 'truck', S],
  [
    'P.106b',
    'Cấm xe ô tô tải (có khối lượng chuyên chở vượt trị số ghi trên biển)',
    'cấm xe tải trên số tấn ghi trên biển',
    'prohibit',
    'truck',
    S,
  ],
  ['P.106c', 'Cấm các xe chở hàng nguy hiểm', 'cấm xe chở hàng nguy hiểm', 'prohibit', 'truck-danger', S],
  ['P.107', 'Cấm xe ô tô khách và xe ô tô tải', 'cấm xe khách và xe tải', 'prohibit', 'bus-truck'],
  ['P.107a', 'Cấm xe ô tô khách', 'cấm xe khách', 'prohibit', 'bus', S],
  ['P.107b', 'Cấm xe taxi', 'cấm taxi', 'prohibit', 'taxi', S],
  ['P.108', 'Cấm xe kéo rơ-moóc', 'cấm xe kéo rơ moóc', 'prohibit', 'trailer', S],
  ['P.108a', 'Cấm xe sơ-mi rơ-moóc', 'cấm xe sơ mi rơ moóc', 'prohibit', 'semitrailer', S],
  ['P.109', 'Cấm máy kéo', 'cấm máy kéo', 'prohibit', 'tractor', S],
  ['P.110a', 'Cấm xe đạp', 'cấm xe đạp', 'prohibit', 'bicycle', S],
  ['P.110b', 'Cấm xe đạp thồ', 'cấm xe đạp thồ', 'prohibit', 'bicycle-load', S],
  ['P.111a', 'Cấm xe gắn máy', 'cấm xe gắn máy', 'prohibit', 'moped', S],
  [
    'P.111b P.111c',
    'Cấm xe ba bánh loại có động cơ (xe lam, xích lô máy)',
    'cấm xe ba bánh có động cơ',
    'prohibit',
    'tricycle',
    S,
  ],
  ['P.111d', 'Cấm xe ba bánh loại không có động cơ (xích lô)', 'cấm xích lô', 'prohibit', 'tricycle', S],
  ['P.112', 'Cấm người đi bộ', 'cấm người đi bộ', 'prohibit', 'pedestrian', S],
  ['P.113', 'Cấm xe người kéo, đẩy', 'cấm xe người kéo, đẩy', 'prohibit', 'handcart', S],
  ['P.114', 'Cấm xe vật nuôi kéo', 'cấm xe vật nuôi kéo', 'prohibit', 'cart', S],
  ['P.115', 'Hạn chế trọng tải toàn bộ xe', 'hạn chế trọng tải', 'prohibit', 'weight'],
  ['P.116', 'Hạn chế tải trọng trên trục xe', 'hạn chế tải trọng trục xe', 'prohibit', 'axle'],
  ['P.117', 'Hạn chế chiều cao', 'hạn chế chiều cao', 'prohibit', 'height'],
  ['P.118', 'Hạn chế chiều ngang xe', 'hạn chế chiều ngang xe', 'prohibit', 'width'],
  ['P.119', 'Hạn chế chiều dài xe', 'hạn chế chiều dài xe', 'prohibit', 'length'],
  [
    'P.120',
    'Hạn chế chiều dài xe cơ giới kéo theo rơ-moóc hoặc sơ-mi rơ-moóc',
    'hạn chế chiều dài xe kéo moóc',
    'prohibit',
    'length-trailer',
  ],
  ['P.121', 'Cự ly tối thiểu giữa hai xe', 'giữ cự ly tối thiểu giữa hai xe', 'prohibit', 'gap'],
  ['P.123a', 'Cấm rẽ trái', 'cấm rẽ trái', 'prohibit', 'turn-left', S],
  ['P.123b', 'Cấm rẽ phải', 'cấm rẽ phải', 'prohibit', 'turn-right', S],
  ['P.124a', 'Cấm quay đầu xe', 'cấm quay đầu', 'prohibit', 'uturn', S],
  ['P.124b', 'Cấm ô tô quay đầu xe', 'cấm ô tô quay đầu', 'prohibit', 'car-uturn', S],
  ['P.124c', 'Cấm rẽ trái và quay đầu xe', 'cấm rẽ trái và quay đầu', 'prohibit', 'left-uturn', S],
  ['P.124d', 'Cấm rẽ phải và quay đầu xe', 'cấm rẽ phải và quay đầu', 'prohibit', 'right-uturn', S],
  ['P.124e', 'Cấm ô tô rẽ trái và quay đầu xe', 'cấm ô tô rẽ trái và quay đầu', 'prohibit', 'car-left-uturn', S],
  ['P.124f', 'Cấm ô tô rẽ phải và quay đầu xe', 'cấm ô tô rẽ phải và quay đầu', 'prohibit', 'car-right-uturn', S],
  ['P.125', 'Cấm vượt', 'cấm vượt', 'prohibit', 'overtake'],
  ['P.126', 'Cấm xe ô tô tải vượt', 'cấm xe tải vượt', 'prohibit', 'truck-overtake'],
  ['P.127', 'Tốc độ tối đa cho phép', 'tốc độ tối đa {n} ki lô mét trên giờ', 'prohibit', 'speed'],
  ['P.127a', 'Tốc độ tối đa cho phép về ban đêm', 'tốc độ tối đa ban đêm {n} ki lô mét trên giờ', 'prohibit', 'speed'],
  ['P.127b', 'Biển ghép tốc độ tối đa cho phép trên từng làn đường', 'tốc độ tối đa theo làn', 'prohibit', 'speed'],
  [
    'P.127c',
    'Biển ghép tốc độ tối đa cho phép theo phương tiện, trên từng làn đường',
    'tốc độ tối đa theo loại xe',
    'prohibit',
    'speed',
  ],
  ['DP.127', 'Biển hết tốc độ tối đa cho phép theo biển ghép', 'hết hạn chế tốc độ theo làn', 'end', 'speed'],
  ['P.128', 'Cấm sử dụng còi', 'cấm bóp còi', 'prohibit', 'horn', S],
  ['P.129', 'Kiểm tra', 'trạm kiểm tra, chuẩn bị dừng xe', 'prohibit', 'text', { text: 'Kiểm tra' }],
  ['P.130', 'Cấm dừng xe và đỗ xe', 'cấm dừng và đỗ xe', 'prohibit-blue', 'no-stopping'],
  ['P.131a', 'Cấm đỗ xe', 'cấm đỗ xe', 'prohibit-blue', 'no-parking'],
  ['P.131b', 'Cấm đỗ xe ngày lẻ', 'cấm đỗ xe ngày lẻ', 'prohibit-blue', 'no-parking-odd'],
  ['P.131c', 'Cấm đỗ xe ngày chẵn', 'cấm đỗ xe ngày chẵn', 'prohibit-blue', 'no-parking-even'],
  [
    'P.132',
    'Nhường đường cho xe cơ giới đi ngược chiều qua đường hẹp',
    'đường hẹp, nhường xe đi ngược chiều',
    'prohibit',
    'oncoming',
  ],
  ['DP.133', 'Hết cấm vượt', 'hết cấm vượt', 'end', 'overtake'],
  ['DP.134', 'Hết tốc độ tối đa cho phép', 'hết hạn chế tốc độ tối đa', 'end', 'speed'],
  ['DP.135', 'Hết tất cả các lệnh cấm', 'hết tất cả lệnh cấm', 'end', 'blank'],
  ['P.136', 'Cấm đi thẳng', 'cấm đi thẳng', 'prohibit', 'straight', S],
  ['P.137', 'Cấm rẽ trái, rẽ phải', 'cấm rẽ trái và rẽ phải', 'prohibit', 'left-right', S],
  ['P.138', 'Cấm đi thẳng, rẽ trái', 'cấm đi thẳng và rẽ trái', 'prohibit', 'straight-left', S],
  ['P.139', 'Cấm đi thẳng, rẽ phải', 'cấm đi thẳng và rẽ phải', 'prohibit', 'straight-right', S],
  ['P.140', 'Cấm xe công nông và các loại xe tương tự', 'cấm xe công nông', 'prohibit', 'farm-truck', S],

  // Biển nguy hiểm và cảnh báo (W)
  ['W.201a', 'Chỗ ngoặt nguy hiểm vòng bên trái', 'chỗ ngoặt nguy hiểm vòng bên trái', 'danger', 'curve-left'],
  ['W.201b', 'Chỗ ngoặt nguy hiểm vòng bên phải', 'chỗ ngoặt nguy hiểm vòng bên phải', 'danger', 'curve-right'],
  ['W.201c W.201d', 'Chỗ ngoặt nguy hiểm có nguy cơ lật xe', 'khúc cua có nguy cơ lật xe', 'danger', 'rollover'],
  ['W.202a W.202b', 'Nhiều chỗ ngoặt nguy hiểm liên tiếp', 'nhiều chỗ ngoặt nguy hiểm liên tiếp', 'danger', 'curves'],
  ['W.203a W.203b W.203c', 'Đường bị thu hẹp', 'đường bị thu hẹp', 'danger', 'narrow'],
  ['W.204', 'Đường hai chiều', 'đường hai chiều', 'danger', 'two-way'],
  ['W.205', 'Đường giao nhau', 'đường giao nhau', 'danger', 'junction'],
  ['W.206', 'Giao nhau chạy theo vòng xuyến', 'vòng xuyến', 'danger', 'roundabout'],
  ['W.207', 'Giao nhau với đường không ưu tiên (đường nhánh)', 'có đường nhánh giao cắt', 'danger', 'side-road'],
  ['W.208', 'Giao nhau với đường ưu tiên (đường chính)', 'sắp vào đường ưu tiên, nhường đường', 'giveway', 'blank'],
  ['W.209', 'Giao nhau có tín hiệu đèn', 'giao nhau có đèn tín hiệu', 'danger', 'signals'],
  ['W.210', 'Giao nhau với đường sắt có rào chắn', 'đường sắt có rào chắn', 'danger', 'rail-barrier'],
  ['W.211', 'Giao nhau với đường sắt không có rào chắn', 'đường sắt không có rào chắn, chú ý tàu', 'danger', 'train'],
  ['W.212', 'Cầu hẹp', 'cầu hẹp', 'danger', 'bridge'],
  ['W.213', 'Cầu tạm', 'cầu tạm', 'danger', 'piers'],
  ['W.214', 'Cầu quay, cầu cất', 'cầu quay, cầu cất', 'danger', 'drawbridge'],
  ['W.215a W.215b W.215c', 'Kè, vực sâu phía trước / bên đường', 'kè, vực sâu nguy hiểm', 'danger', 'embankment'],
  ['W.216a', 'Đường ngầm', 'đường ngầm, chú ý nước', 'danger', 'ford'],
  ['W.216b', 'Đường ngầm có nguy cơ lũ quét', 'đường ngầm có nguy cơ lũ quét', 'danger', 'ford'],
  ['W.217', 'Bến phà', 'bến phà', 'danger', 'ferry'],
  ['W.218', 'Cửa chui', 'cửa chui', 'danger', 'arch'],
  ['W.219', 'Dốc xuống nguy hiểm', 'dốc xuống nguy hiểm', 'danger', 'slope-down'],
  ['W.220', 'Dốc lên nguy hiểm', 'dốc lên nguy hiểm', 'danger', 'slope-up'],
  ['W.221a', 'Đường lồi lõm', 'đường lồi lõm', 'danger', 'bumpy'],
  ['W.221b', 'Đường có gồ giảm tốc', 'gờ giảm tốc', 'danger', 'bump'],
  ['W.222a', 'Đường trơn', 'đường trơn', 'danger', 'slippery'],
  ['W.222b', 'Lề đường nguy hiểm', 'lề đường nguy hiểm', 'danger', 'soft-verge'],
  ['W.223a W.223b', 'Vách núi nguy hiểm', 'vách núi nguy hiểm', 'danger', 'cliff'],
  ['W.224', 'Đường người đi bộ cắt ngang', 'đường người đi bộ cắt ngang', 'danger', 'crosswalk'],
  ['W.225', 'Trẻ em', 'chú ý trẻ em', 'danger', 'children'],
  ['W.226', 'Đường người đi xe đạp cắt ngang', 'người đi xe đạp cắt ngang', 'danger', 'cyclist'],
  ['W.227', 'Công trường', 'công trường', 'danger', 'works'],
  ['W.228', 'Đá lở; Sỏi đá bắn lên; Nền đường yếu', 'chú ý đá lở', 'danger', 'rocks'],
  ['W.229', 'Dải máy bay lên xuống', 'máy bay bay thấp', 'danger', 'plane'],
  ['W.230', 'Gia súc', 'chú ý gia súc', 'danger', 'cattle'],
  ['W.231', 'Thú rừng vượt qua đường', 'chú ý thú rừng', 'danger', 'animal'],
  ['W.232', 'Gió ngang', 'chú ý gió ngang', 'danger', 'wind'],
  ['W.233', 'Nguy hiểm khác', 'chú ý nguy hiểm', 'danger', 'exclaim'],
  ['W.234', 'Giao nhau với đường hai chiều', 'giao nhau với đường hai chiều', 'danger', 'two-way-junction'],
  ['W.235', 'Đường đôi', 'bắt đầu đường đôi', 'danger', 'dual'],
  ['W.236', 'Kết thúc đường đôi', 'hết đường đôi', 'danger', 'dual-end'],
  ['W.237', 'Cầu vồng', 'cầu vồng, tầm nhìn hạn chế', 'danger', 'hump-bridge'],
  ['W.238', 'Đường cao tốc phía trước', 'sắp vào đường cao tốc', 'danger', 'expressway'],
  ['W.239a', 'Đường cáp điện ở phía trên', 'có cáp điện phía trên', 'danger', 'power-line'],
  ['W.239b', 'Chiều cao tĩnh không thực tế', 'chú ý chiều cao tĩnh không', 'danger', 'height'],
  ['W.240', 'Đường hầm', 'sắp vào hầm', 'danger', 'tunnel'],
  ['W.241', 'Ùn tắc giao thông', 'đoạn đường hay ùn tắc', 'danger', 'jam'],
  ['W.242a W.242b', 'Nơi đường sắt giao vuông góc với đường bộ', 'đường sắt cắt ngang', 'cross', 'blank'],
  // Hình W.243 chưa đối chiếu được với văn bản gốc: vẽ tấm biển đứng có 1–3 vạch chéo đỏ như mô tả.
  ['W.243a', 'Nơi đường sắt giao không vuông góc với đường bộ', 'sắp đến đường sắt', 'post', 'blank', { stripes: 1 }],
  ['W.243b', 'Nơi đường sắt giao không vuông góc với đường bộ', 'sắp đến đường sắt', 'post', 'blank', { stripes: 2 }],
  ['W.243c', 'Nơi đường sắt giao không vuông góc với đường bộ', 'sắp đến đường sắt', 'post', 'blank', { stripes: 3 }],
  ['W.244', 'Đoạn đường hay xảy ra tai nạn', 'đoạn đường hay xảy ra tai nạn', 'danger', 'crash'],
  ['W.245a W.245b', 'Đi chậm', 'đi chậm', 'danger', 'text', { text: 'Đi chậm' }],
  ['W.246a W.246b W.246c', 'Chú ý chướng ngại vật', 'chú ý chướng ngại vật', 'danger', 'obstacle'],
  ['W.247', 'Chú ý xe đỗ', 'chú ý xe đỗ', 'danger', 'car'],

  // Biển hiệu lệnh (R)
  ['R.122', 'Dừng lại', 'biển dừng lại, dừng hẳn xe', 'stop', 'blank'],
  ['R.301', 'Hướng đi phải theo', 'hướng đi bắt buộc', 'mandatory', 'arrow-up'],
  ['R.302a', 'Hướng phải đi vòng chướng ngại vật', 'đi vòng chướng ngại vật', 'mandatory', 'keep-right'],
  ['R.302b', 'Hướng phải đi vòng chướng ngại vật', 'đi vòng chướng ngại vật', 'mandatory', 'keep-left'],
  ['R.302c', 'Hướng phải đi vòng chướng ngại vật', 'đi vòng chướng ngại vật', 'mandatory', 'keep-both'],
  ['R.303', 'Nơi giao nhau chạy theo vòng xuyến', 'đi theo vòng xuyến', 'mandatory', 'roundabout'],
  ['R.304', 'Đường dành cho xe thô sơ', 'đường dành cho xe thô sơ', 'mandatory', 'bicycle'],
  ['R.305', 'Đường dành cho người đi bộ', 'đường dành cho người đi bộ', 'mandatory', 'pedestrian'],
  ['R.306', 'Tốc độ tối thiểu cho phép', 'tốc độ tối thiểu {n} ki lô mét trên giờ', 'mandatory', 'speed'],
  ['R.307', 'Hết hạn chế tốc độ tối thiểu', 'hết tốc độ tối thiểu', 'mandatory', 'speed', S],
  ['R.308a R.308b', 'Tuyến đường cầu vượt cắt qua', 'đi theo tuyến cầu vượt', 'mandatory', 'loop'],
  ['R.309', 'Ấn còi', 'bấm còi', 'mandatory', 'horn'],
  [
    'R.310a R.310b R.310c',
    'Hướng đi phải theo cho các xe chở hàng nguy hiểm',
    'xe chở hàng nguy hiểm đi theo hướng chỉ',
    'mandatory',
    'hazmat-arrow',
  ],
  ['R.403a', 'Đường dành cho xe ô tô', 'đường dành cho ô tô', 'info', 'car'],
  ['R.403b', 'Đường dành cho xe ô tô, xe máy', 'đường dành cho ô tô và xe máy', 'info', 'car-moto'],
  ['R.403', 'Đường dành cho từng loại xe', 'đường dành riêng cho một số loại xe', 'info', 'lanes'],
  ['R.404', 'Hết đoạn đường dành cho từng loại xe', 'hết đường dành riêng', 'info', 'lanes', S],
  ['R.411', 'Hướng đi trên mỗi làn đường phải theo', 'đi đúng làn theo hướng mũi tên', 'info', 'lane-arrows'],
  [
    'R.412',
    'Làn đường dành riêng cho từng loại xe hoặc nhóm xe',
    'làn đường dành riêng cho một số loại xe',
    'info',
    'lanes',
  ],
  ['R.415a R.415b', 'Gộp làn đường theo phương tiện', 'gộp làn theo loại xe', 'info', 'lanes'],
  ['R.420', 'Bắt đầu khu đông dân cư', 'bắt đầu khu đông dân cư', 'zone', 'houses'],
  ['R.421', 'Hết khu đông dân cư', 'hết khu đông dân cư', 'zone', 'houses', S],

  // Biển chỉ dẫn (I, IE)
  ['I.401', 'Bắt đầu đường ưu tiên', 'bắt đầu đường ưu tiên', 'priority', 'blank'],
  ['I.402', 'Hết đoạn đường ưu tiên', 'hết đường ưu tiên', 'priority', 'blank', S],
  ['I.405a I.405b I.405c', 'Đường cụt', 'đường cụt', 'info', 'dead-end'],
  ['I.407a', 'Đường một chiều', 'đường một chiều', 'info', 'oneway-up'],
  ['I.407b', 'Đường một chiều (chỉ hướng tại nút giao)', 'đường một chiều bên trái', 'info', 'oneway-left'],
  ['I.407c', 'Đường một chiều (chỉ hướng tại nút giao)', 'đường một chiều bên phải', 'info', 'oneway-right'],
  ['I.423a', 'Vị trí người đi bộ sang ngang', 'vạch người đi bộ sang đường', 'info', 'crosswalk-info'],
  ['I.423b', 'Vị trí người đi bộ sang ngang', 'vạch người đi bộ sang đường', 'info', 'crosswalk-info', { flip: true }],
  [
    'I.424',
    'Cầu vượt, hầm chui qua đường cho người đi bộ',
    'cầu vượt hoặc hầm cho người đi bộ',
    'info',
    'footbridge',
  ],
  ['IE.452', 'Bắt đầu đường cao tốc', 'bắt đầu đường cao tốc', 'expressway', 'expressway'],
  ['IE.453a IE.453b IE.453c', 'Kết thúc đường cao tốc', 'sắp hết đường cao tốc', 'expressway', 'expressway', S],
];

// Các mục gộp theo dải mã ("W.207a–l"): chỉ nhận đúng các chữ cái có trong dải đã liệt kê.
// null = dải không ghi rõ chữ cuối ("R.404a…").
const RANGES = {
  'W.205': 'abcde',
  'W.207': 'abcdefghijkl',
  'W.228': 'abcd',
  'R.301': 'abcdefgh',
  'R.403': 'cdefghk',
  'R.404': null,
  'R.412': 'abcdefgh', // R.412i–p (hết làn dành riêng) không có trong danh mục
  'I.424': 'abcd',
};

// Nhóm cài đặt của từng mã (theo mã cơ sở, bỏ chữ cái cuối); mã chính xác được xét trước.
const CAT_EXACT = { 'W.221b': 'calming' };
const CAT_BASE = {
  'P.127': 'speed',
  'DP.127': 'speed',
  'DP.134': 'speed',
  'R.306': 'speed',
  'R.307': 'speed',
  'R.420': 'speed',
  'R.421': 'speed',
  'IE.452': 'speed',
  'IE.453': 'speed',
  'W.209': 'signals',
  'R.122': 'priority',
  'W.208': 'priority',
  'W.206': 'priority',
  'R.303': 'priority',
  'I.401': 'priority',
  'I.402': 'priority',
  'W.205': 'priority',
  'W.207': 'priority',
  'DP.133': 'prohibit',
  'DP.135': 'prohibit',
  'W.224': 'crossing',
  'I.423': 'crossing',
  'W.210': 'rail',
  'W.211': 'rail',
  'W.242': 'rail',
  'W.243': 'rail',
};
const CAT_GROUP = { P: 'prohibit', DP: 'prohibit', W: 'danger', R: 'info', I: 'info', IE: 'info', S: 'info' };

const CODE_RE = /^(DP|IE|[PWRIS])\.?(\d{3})([a-z]{0,2})$/i;
const baseOf = (code) => code.replace(/[a-z]+$/, '');
const groupOf = (code) => code.slice(0, code.indexOf('.'));

function catOf(code) {
  return CAT_EXACT[code] || CAT_BASE[baseOf(code)] || CAT_GROUP[groupOf(code)] || 'info';
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

function buildCatalogue() {
  const out = {};
  for (const [codes, name, say, shape, pict, extra] of ROWS) {
    for (const code of codes.split(' ')) {
      const art = { shape, pict };
      if (extra === S) art.slash = true;
      else if (extra) Object.assign(art, extra);
      out[code] = { code, name, say, cat: catOf(code), art };
    }
  }
  return deepFreeze(out);
}

/** Danh mục biển: { [mã]: { code, name, say, cat, art: { shape, pict, slash? } } }. */
export const SIGN_CATALOGUE = buildCatalogue();

// Họ biển chỉ có mã con cùng một tên (W.245a, W.245b "Đi chậm") → mục đầu tiên của họ.
// Họ có tên khác nhau (P.111a/b/c/d, W.201a–d…) không được gộp.
const FAMILIES = (() => {
  const byBase = new Map();
  for (const e of Object.values(SIGN_CATALOGUE)) {
    const base = baseOf(e.code);
    if (base === e.code || SIGN_CATALOGUE[base]) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(e);
  }
  const out = {};
  for (const [base, list] of byBase) if (list.every((e) => e.name === list[0].name)) out[base] = list[0];
  return out;
})();

/** Chuẩn hoá cách viết mã ("p.127" → "P.127", "W.207C" → "W.207c"); trả về null nếu không phải mã. */
function canonicalCode(code) {
  const m = CODE_RE.exec(String(code ?? '').trim());
  return m ? `${m[1].toUpperCase()}.${m[2]}${m[3].toLowerCase()}` : null;
}

/**
 * Tra mã biển: đúng mã trước, rồi bỏ chữ cái cuối để tìm mục chung ("W.211a" → W.211,
 * "W.207c" → W.207). Với mục gộp theo dải, chữ cái phải nằm trong dải đã liệt kê.
 * Mã không có chữ cái của một họ cùng tên ("W.245") trả về mục đầu của họ (W.245a).
 */
export function lookupSign(code) {
  const c = canonicalCode(code);
  if (!c) return null;
  if (SIGN_CATALOGUE[c]) return SIGN_CATALOGUE[c];
  const base = baseOf(c);
  if (base === c) return FAMILIES[c] || null;
  const entry = SIGN_CATALOGUE[base];
  if (!entry) return null;
  const letters = RANGES[base];
  const suffix = c.slice(base.length);
  if (letters && (suffix.length !== 1 || !letters.includes(suffix))) return null;
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Nhóm cài đặt
// ---------------------------------------------------------------------------------------------

export const SIGN_CATEGORIES = [
  { key: 'speed', setting: 'signSpeed', label: 'Biển tốc độ, khu đông dân cư', def: true },
  {
    key: 'prohibit',
    setting: 'signProhibit',
    label: 'Biển cấm: cấm rẽ, cấm quay đầu, cấm đi vào, cấm vượt, hạn chế chiều cao và tải trọng',
    def: true,
  },
  { key: 'priority', setting: 'signPriority', label: 'Dừng lại, nhường đường, vòng xuyến', def: true },
  { key: 'danger', setting: 'signDanger', label: 'Biển nguy hiểm và chỗ ngoặt', def: true },
  { key: 'signals', setting: 'signSignals', label: 'Đèn tín hiệu giao thông', def: true },
  { key: 'calming', setting: 'signCalming', label: 'Gờ giảm tốc', def: true },
  { key: 'rail', setting: 'alertRail', label: 'Đường ngang đường sắt', def: true }, // khoá cài đặt có sẵn
  { key: 'crossing', setting: 'signCrossing', label: 'Vạch người đi bộ qua đường', def: false }, // rất dày ở đô thị
  { key: 'info', setting: 'signInfo', label: 'Biển hiệu lệnh và chỉ dẫn khác', def: true },
];

/** Nhóm biển có đang bật không; chưa có cài đặt thì dùng mặc định của nhóm. */
export function categoryEnabled(cat, settings) {
  const c = SIGN_CATEGORIES.find((x) => x.key === cat);
  if (!c) return true;
  const v = settings ? settings[c.setting] : undefined;
  return v === undefined ? c.def : v !== false;
}

// ---------------------------------------------------------------------------------------------
// Số liệu
// ---------------------------------------------------------------------------------------------

/** Số kiểu Việt Nam: 3.5 → "3,5", 1850 → "1.850" (tối đa `digits` chữ số thập phân). */
export function formatNumberVi(v, digits = 2) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '';
  let s = n.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (/^-0$/.test(s)) s = '0';
  const [int, dec] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return dec ? `${grouped},${dec}` : grouped;
}

const NO_MEASURE = new Set(['none', 'default', 'below_default', 'unsigned', 'empty', 'no']);
const UNITS = {
  m: { '': 1, m: 1 },
  // st = short ton (tấn Mỹ), lbs = pound
  t: { '': 1, t: 1, kg: 0.001, st: 0.90718474, lbs: 0.00045359237, lb: 0.00045359237 },
};

/**
 * Đọc giá trị kích thước/tải trọng của OSM: unit 'm' (maxheight, maxwidth) hoặc 't' (maxweight).
 * "3.5", "3,5", "3.5 m", "12'6\"" (feet-inch → mét), "5 t", "500 kg" → 0,5; trả về null nếu không rõ.
 */
export function parseMeasure(raw, unit) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || NO_MEASURE.has(s)) return null;
  const table = UNITS[unit];
  if (!table) return null;
  let v;
  const ft = /^(\d+(?:\.\d+)?)\s*(?:'|ft)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/.exec(s);
  if (ft) {
    if (unit !== 'm') return null;
    v = parseFloat(ft[1]) * 0.3048 + parseFloat(ft[2] || '0') * 0.0254;
  } else {
    const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]*)\.?$/.exec(s);
    if (!m || !(m[2] in table)) return null;
    v = parseFloat(m[1].replace(',', '.')) * table[m[2]];
  }
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Thẻ traffic_sign
// ---------------------------------------------------------------------------------------------

// Giá trị chung không mang tiền tố quốc gia (theo osm-traffic-sign-tool; overtaking và
// distance_marker là giá trị gặp trong dữ liệu Việt Nam, chưa có tài liệu).
const NAMED = new Set([
  'maxspeed',
  'city_limit',
  'stop',
  'give_way',
  'signals',
  'hazard',
  'overtaking',
  'yes',
  'none',
  'variable',
  'variable_message',
  'destination',
  'distance_marker',
]);
const PREFIX_RE = /^([A-Z]{2}):(.*)$/;
const VN_CODE_RE = /^(DP|IE|[PWRIS])?\.?(\d{3})([a-z]{0,2})(?:\[([^\]]*)\])?$/i;
const NAMED_RE = /^([a-z_]+)(?:\[([^\]]*)\])?$/;
const GROUPS = ['P', 'DP', 'W', 'R', 'I', 'IE', 'S'];

/** Tách theo ';' và ',' nhưng không tách bên trong [...] và "...". */
function splitParts(value) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (const ch of String(value)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '[') depth++;
    else if (!quoted && ch === ']') depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && (ch === ';' || ch === ',')) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Thiếu chữ nhóm ("VN:102"): tra mọi nhóm, chỉ nhận khi khớp duy nhất (riêng P và DP thì chọn P). */
function resolveGroupless(num, suffix) {
  const hits = GROUPS.filter((g) => lookupSign(`${g}.${num}${suffix}`));
  if (hits.length === 1) return `${hits[0]}.${num}${suffix}`;
  if (hits.length === 2 && hits.includes('P') && hits.includes('DP')) return `P.${num}${suffix}`;
  return null;
}

function parseCoded(body, raw, groupRequired) {
  const m = VN_CODE_RE.exec(body.replace(/\s+(?=\[)/, ''));
  if (!m) return { code: null, value: null, named: null, raw };
  const value = m[4] != null ? m[4].trim() || null : null;
  const suffix = m[3].toLowerCase();
  let code = null;
  if (m[1]) code = `${m[1].toUpperCase()}.${m[2]}${suffix}`;
  else if (!groupRequired) code = resolveGroupless(m[2], suffix);
  return { code, value, named: null, raw };
}

/**
 * Đọc giá trị traffic_sign=* thành danh sách biển { code, value, named, raw }.
 * code là mã QCVN ("P.127") hoặc null (giá trị chung, biển nước khác, không đọc được).
 */
export function parseTrafficSign(value) {
  if (value == null) return [];
  const tokens = splitParts(value);
  // Tiền tố mặc định lấy từ phần tử có mã đầu tiên, không phải phần tử đầu tiên.
  let defPrefix = null;
  for (const t of tokens) {
    const p = PREFIX_RE.exec(t);
    const nm = p && NAMED_RE.exec(p[2].trim().toLowerCase());
    if (p && !(nm && NAMED.has(nm[1]))) {
      defPrefix = p[1];
      break;
    }
  }
  return tokens.map((raw) => {
    if (raw.startsWith('"')) return { code: null, value: null, named: null, raw, text: raw.replace(/^"|"$/g, '') };
    const p = PREFIX_RE.exec(raw);
    const body = p ? p[2].trim() : raw;
    const nm = NAMED_RE.exec(body.toLowerCase());
    if (nm && NAMED.has(nm[1])) {
      return { code: null, value: nm[2] != null ? nm[2].trim() || null : null, named: nm[1], raw };
    }
    const prefix = p ? p[1] : defPrefix;
    if (prefix && prefix !== 'VN') return { code: null, value: null, named: null, raw };
    // Không có tiền tố nào trong cả giá trị: chỉ nhận khi có chữ nhóm rõ ràng (P., W., …).
    return parseCoded(body, raw, !prefix);
  });
}

/** Khoá không chuẩn code=VN.R.420 (hoặc VN:R.420, R.420) → { code, value, named: null, raw } hoặc null. */
export function parseCodeTag(code) {
  if (code == null) return null;
  const raw = String(code).trim();
  const body = raw.replace(/^VN[.:]\s*/i, '');
  const part = parseCoded(body, raw, true);
  return part.code ? part : null;
}

// ---------------------------------------------------------------------------------------------
// Hướng áp dụng
// ---------------------------------------------------------------------------------------------

const COMPASS = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse', 's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];
const WORDS = { north: 0, east: 90, south: 180, west: 270 };

/**
 * Đọc hướng áp dụng từ khoá đầu tiên có giá trị trong `keys`.
 * → { mode: 'forward' | 'backward' | 'both' | 'deg' | 'none', deg? } (deg là hướng mặt biển).
 */
export function parseDirection(tags, keys) {
  let raw = null;
  for (const k of keys || []) {
    const v = tags?.[k];
    if (v != null && String(v).trim() !== '') {
      raw = String(v).trim().toLowerCase();
      break;
    }
  }
  if (raw == null) return { mode: 'none' };
  if (raw === 'forward') return { mode: 'forward' };
  if (raw === 'backward' || raw === 'reverse') return { mode: 'backward' };
  if (raw === 'both' || raw === 'all' || raw === 'forward;backward' || raw === 'backward;forward') {
    return { mode: 'both' };
  }
  const first = raw.split(';')[0].trim();
  if (/^\d+(?:\.\d+)?$/.test(first)) {
    const deg = parseFloat(first);
    return deg <= 360 ? { mode: 'deg', deg: deg % 360 } : { mode: 'none' };
  }
  const ci = COMPASS.indexOf(first);
  if (ci >= 0) return { mode: 'deg', deg: ci * 22.5 };
  if (first in WORDS) return { mode: 'deg', deg: WORDS[first] };
  return { mode: 'none' };
}

// ---------------------------------------------------------------------------------------------
// Phân loại nút OSM thành biển
// ---------------------------------------------------------------------------------------------

const DIR_SIGN = ['traffic_sign:direction', 'direction'];
const DIR_HAZARD = ['hazard:direction', 'direction'];

const listOf = (v) =>
  String(v ?? '')
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** Điền con số vào câu đọc có chỗ {n}; không có số thì bỏ cả cụm số và đơn vị. */
function fillSay(say, n) {
  if (!say.includes('{n}')) return say;
  if (n == null) return say.replace(/\s*\{n\}( ki lô mét trên giờ)?/, '');
  return say.replace('{n}', formatNumberVi(n));
}

function feature(entry, over = {}) {
  return {
    kind: `sign:${entry.code}`,
    code: entry.code,
    cat: entry.cat,
    title: entry.name,
    say: fillSay(entry.say, null),
    art: entry.art,
    value: null,
    dirKeys: DIR_SIGN,
    ...over,
  };
}

const speedFeature = (n, extra = {}) =>
  feature(SIGN_CATALOGUE['P.127'], {
    kind: `speed:${n}`,
    title: `Tốc độ tối đa ${n} km/h`,
    say: `biển tốc độ tối đa ${n} ki lô mét trên giờ`,
    value: n,
    ...extra,
  });

const stopFeature = (dirKeys) =>
  feature(SIGN_CATALOGUE['R.122'], {
    kind: 'stop',
    title: 'Biển dừng lại',
    say: 'biển dừng lại, dừng hẳn xe',
    dirKeys,
    needsJunction: true,
  });

const giveWayFeature = (dirKeys) =>
  feature(SIGN_CATALOGUE['W.208'], {
    kind: 'giveway',
    title: 'Giao nhau với đường ưu tiên',
    say: 'giao nhau với đường ưu tiên, chú ý nhường đường',
    dirKeys,
    needsJunction: true,
  });

// hazard=* → [mã, tiêu đề, câu đọc, hình vẽ khi không có mã]. Danh sách giá trị theo iD và JOSM.
const HAZARD = {
  curve: [null, 'Chỗ ngoặt nguy hiểm', 'chỗ ngoặt nguy hiểm', 'curves'],
  turn: [null, 'Chỗ ngoặt nguy hiểm', 'chỗ ngoặt nguy hiểm', 'curves'],
  curves: ['W.202', 'Nhiều chỗ ngoặt nguy hiểm liên tiếp', 'nhiều chỗ ngoặt nguy hiểm liên tiếp'],
  turns: ['W.202', 'Nhiều chỗ ngoặt nguy hiểm liên tiếp', 'nhiều chỗ ngoặt nguy hiểm liên tiếp'],
  children: ['W.225', 'Trẻ em', 'chú ý trẻ em'],
  school_zone: ['W.225', 'Trẻ em', 'chú ý trẻ em'],
  pedestrians: ['W.224', 'Đường người đi bộ cắt ngang', 'đường người đi bộ cắt ngang'],
  cyclists: ['W.226', 'Đường người đi xe đạp cắt ngang', 'người đi xe đạp cắt ngang'],
  animal_crossing: ['W.231', 'Thú rừng vượt qua đường', 'chú ý thú rừng'],
  falling_rocks: ['W.228', 'Đá lở', 'chú ý đá lở'],
  landslide: ['W.228', 'Đá lở', 'chú ý đá lở'],
  loose_gravel: ['W.228', 'Sỏi đá bắn lên', 'chú ý sỏi đá bắn lên'],
  slippery: ['W.222a', 'Đường trơn', 'đường trơn'],
  slippery_road: ['W.222a', 'Đường trơn', 'đường trơn'],
  ice: ['W.222a', 'Đường trơn', 'đường trơn'],
  side_winds: ['W.232', 'Gió ngang', 'chú ý gió ngang'],
  bump: ['W.221b', 'Gờ giảm tốc', 'gờ giảm tốc'],
  dip: ['W.221a', 'Đường lồi lõm', 'đường lồi lõm'],
  frost_heave: ['W.221a', 'Đường lồi lõm', 'đường lồi lõm'],
  damaged_road: ['W.221a', 'Đường lồi lõm', 'đường lồi lõm'],
  queues_likely: ['W.241', 'Ùn tắc giao thông', 'đoạn đường hay ùn tắc'],
  low_flying_aircraft: ['W.229', 'Dải máy bay lên xuống', 'máy bay bay thấp'],
  accident: ['W.244', 'Đoạn đường hay xảy ra tai nạn', 'đoạn đường hay xảy ra tai nạn'],
  accident_blackspot: ['W.244', 'Đoạn đường hay xảy ra tai nạn', 'đoạn đường hay xảy ra tai nạn'],
  dangerous_junction: [null, 'Giao lộ nguy hiểm', 'giao lộ nguy hiểm', 'junction'],
  weak_bridge: [null, 'Cầu yếu', 'cầu yếu', 'bridge'],
};
const HAZARD_OTHER = ['W.233', 'Nguy hiểm khác', 'chú ý nguy hiểm'];

/** Biển nguy hiểm tương ứng với một giá trị hazard=* (cả trên nút lẫn trên way). */
function hazardFeature(value, dirKeys = DIR_HAZARD) {
  const v = listOf(value)[0] || '';
  const [code, title, say, pict] = HAZARD[v] || HAZARD_OTHER;
  if (!code) {
    return {
      kind: `hazard:${v}`,
      code: null,
      cat: 'danger',
      title,
      say,
      art: { shape: 'danger', pict },
      value: null,
      dirKeys,
    };
  }
  // hazard=* luôn thuộc nhóm "nguy hiểm", kể cả khi mã biển (W.224, W.221b) nằm ở nhóm khác.
  return feature(lookupSign(code), { kind: `hazard:${code}`, code, cat: 'danger', title, say, dirKeys });
}

// Biển mang trị số: [đơn vị, thẻ OSM đi kèm, mẫu tiêu đề, mẫu câu đọc, tiền tố kind].
const MEASURED = {
  'P.117': ['m', 'maxheight', (v) => `Hạn chế chiều cao ${v} m`, (v) => `hạn chế chiều cao ${v} mét`, 'height'],
  'P.118': ['m', 'maxwidth', (v) => `Hạn chế chiều ngang ${v} m`, (v) => `hạn chế chiều ngang xe ${v} mét`, 'width'],
  'P.115': ['t', 'maxweight', (v) => `Hạn chế trọng tải ${v} tấn`, (v) => `hạn chế trọng tải ${v} tấn`, 'weight'],
  'P.106b': ['t', 'maxweight', (v) => `Cấm xe tải trên ${v} tấn`, (v) => `cấm xe tải trên ${v} tấn`],
  'P.116': ['t', null, (v) => `Hạn chế tải trọng trục ${v} tấn`, (v) => `hạn chế tải trọng trục xe ${v} tấn`],
  'P.119': ['m', null, (v) => `Hạn chế chiều dài xe ${v} m`, (v) => `hạn chế chiều dài xe ${v} mét`],
  'P.120': ['m', null, (v) => `Hạn chế chiều dài xe kéo moóc ${v} m`, (v) => `hạn chế chiều dài xe kéo moóc ${v} mét`],
  'P.121': ['m', null, (v) => `Cự ly tối thiểu ${v} m`, (v) => `giữ cự ly tối thiểu ${v} mét`],
  'W.239b': ['m', 'maxheight', (v) => `Chiều cao tĩnh không ${v} m`, (v) => `chú ý chiều cao tĩnh không ${v} mét`],
};

// Biển tốc độ khác P.127: [mẫu tiêu đề khi có số].
const SPEED_TITLES = {
  'P.127a': (n) => `Tốc độ tối đa ban đêm ${n} km/h`,
  'R.306': (n) => `Tốc độ tối thiểu ${n} km/h`,
};

/** Một biển có mã QCVN → đặc trưng; null nếu không dùng được (ví dụ biển tốc độ thiếu số). */
function codedFeature(part, tags, dir) {
  const entry = lookupSign(part.code);
  if (!entry) return null;
  const code = part.code;
  if (entry.code === 'P.127') {
    const n = parseMaxspeed(part.value) ?? parseMaxspeed(tags.maxspeed);
    return n == null ? null : speedFeature(n, dir);
  }
  if (entry.code === 'R.122') return { ...stopFeature(['traffic_sign:direction', 'stop:direction', 'direction']), ...dir };
  if (entry.code === 'W.208') {
    return { ...giveWayFeature(['traffic_sign:direction', 'give_way:direction', 'direction']), ...dir };
  }
  const base = { kind: `sign:${code}`, code, ...dir };
  const measured = MEASURED[entry.code];
  if (measured) {
    const [unit, tagKey, title, say, kindPrefix] = measured;
    const v = parseMeasure(part.value, unit) ?? (tagKey ? parseMeasure(tags[tagKey], unit) : null);
    if (v == null) return feature(entry, base);
    const vi = formatNumberVi(v);
    return feature(entry, {
      ...base,
      kind: kindPrefix ? `${kindPrefix}:${v}` : `sign:${code}:${v}`,
      title: title(vi),
      say: say(vi),
      value: v,
    });
  }
  if (entry.say.includes('{n}') || entry.art.pict === 'speed') {
    const n = parseMaxspeed(part.value);
    if (n == null) return feature(entry, base);
    const title = SPEED_TITLES[entry.code];
    return feature(entry, {
      ...base,
      kind: `sign:${code}:${n}`,
      title: title ? title(n) : entry.name,
      say: fillSay(entry.say, n),
      value: n,
    });
  }
  return feature(entry, base);
}

/** traffic_sign=city_limit chỉ được tin khi code/content nói rõ là khu đông dân cư. */
function cityLimitCode(tags) {
  const c = parseCodeTag(tags.code);
  if (c) {
    const base = baseOf(c.code);
    if (base === 'R.420' || base === 'R.421' || base === 'DP.134' || base === 'DP.135') return c.code;
    return null;
  }
  const content = String(tags.content ?? '').trim();
  if (!/đông dân cư/i.test(content)) return null;
  const startsHet = (s) => /^hết/i.test(String(s ?? '').trim());
  return startsHet(content) || startsHet(tags.name) ? 'R.421' : 'R.420';
}

/** Các giá trị chung (maxspeed, city_limit, yes…) → đặc trưng, dựa vào thẻ đi kèm. */
function namedFeatures(part, tags, dir) {
  const out = [];
  const signDir = { dirKeys: DIR_SIGN, ...dir };
  const fromCode = () => {
    const c = parseCodeTag(tags.code);
    const f = c && codedFeature(c, tags, signDir);
    if (f) out.push(f);
    return Boolean(f);
  };
  switch (part.named) {
    case 'maxspeed': {
      const n = parseMaxspeed(part.value) ?? parseMaxspeed(tags.maxspeed);
      if (n != null) out.push(speedFeature(n, signDir));
      break;
    }
    case 'city_limit': {
      const code = cityLimitCode(tags);
      const f = code && codedFeature({ code, value: null }, tags, signDir);
      if (f) out.push(f);
      break;
    }
    case 'overtaking':
      if (String(tags.overtaking ?? '').trim() === 'no') out.push(feature(SIGN_CATALOGUE['P.125'], signDir));
      break;
    case 'yes': {
      if (fromCode()) break;
      const n = parseMaxspeed(tags.maxspeed);
      if (n != null) out.push(speedFeature(n, signDir));
      if (String(tags.overtaking ?? '').trim() === 'no') out.push(feature(SIGN_CATALOGUE['P.125'], signDir));
      break;
    }
    case 'stop':
      out.push({ ...stopFeature(['traffic_sign:direction', 'stop:direction', 'direction']), ...dir });
      break;
    case 'give_way':
      out.push({ ...giveWayFeature(['traffic_sign:direction', 'give_way:direction', 'direction']), ...dir });
      break;
    case 'hazard':
      out.push({ ...hazardFeature(tags.hazard, ['traffic_sign:direction', 'hazard:direction', 'direction']), ...dir });
      break;
    default:
      // signals, none, variable, destination, distance_marker…: không đủ thông tin để báo.
      break;
  }
  return out;
}

const CALMING_SKIP = new Set(['island', 'choked_island', 'painted_island', 'choker', 'chicane', 'dip']);
const CALMING_OK = new Set(['bump', 'hump', 'table', 'cushion', 'rumble_strip', 'yes']);
const CROSSING_SKIP = new Set(['traffic_signals', 'unmarked', 'informal', 'no']);
const CROSSING_OK = new Set(['uncontrolled', 'marked', 'zebra']);

function crossingFeature(tags) {
  const list = listOf(tags.crossing);
  if (list.some((v) => CROSSING_SKIP.has(v))) return null;
  const markings = String(tags['crossing:markings'] ?? '').trim().toLowerCase();
  if (markings === 'no') return null;
  const ok =
    list.length === 0 ||
    list.some((v) => CROSSING_OK.has(v)) ||
    listOf(tags.crossing_ref).includes('zebra') ||
    (markings !== '' && markings !== 'no');
  if (!ok) return null;
  return feature(SIGN_CATALOGUE['W.224'], {
    kind: 'crossing',
    title: 'Vạch người đi bộ qua đường',
    say: 'vạch người đi bộ qua đường',
    dirKeys: [],
  });
}

function calmingFeature(tags) {
  const list = listOf(tags.traffic_calming);
  if (!list.length || list.some((v) => CALMING_SKIP.has(v))) return null;
  const v = list.find((x) => CALMING_OK.has(x));
  if (!v) return null;
  const rumble = v === 'rumble_strip';
  return feature(SIGN_CATALOGUE['W.221b'], {
    kind: rumble ? 'calming:rumble' : 'calming',
    title: rumble ? 'Vạch giảm tốc' : 'Gờ giảm tốc',
    say: rumble ? 'vạch giảm tốc' : 'gờ giảm tốc',
    dirKeys: ['direction'],
  });
}

function railFeature(tags) {
  const barrier = String(tags['crossing:barrier'] ?? '').trim().toLowerCase();
  if (barrier && barrier !== 'no') {
    return feature(SIGN_CATALOGUE['W.210'], {
      kind: 'rail:barrier',
      title: 'Đường sắt có rào chắn',
      say: 'đường ngang đường sắt có rào chắn',
      dirKeys: [],
    });
  }
  return feature(SIGN_CATALOGUE['W.211'], {
    kind: 'rail',
    title: 'Đường sắt không có rào chắn',
    say: 'đường ngang đường sắt không có rào chắn, chú ý quan sát tàu',
    dirKeys: [],
  });
}

/**
 * Phân loại thẻ của một nút OSM thành các biển/điểm cần báo:
 * [{ kind, code|null, cat, title, say, art, value, dirKeys, dirFixed?, needsJunction? }].
 */
export function classifyNode(tags) {
  if (!tags) return [];
  const out = [];
  // 1. Biển ghi bằng traffic_sign (kể cả :forward/:backward = biển cho riêng một chiều).
  for (const [key, dirFixed] of [
    ['traffic_sign', null],
    ['traffic_sign:forward', 'forward'],
    ['traffic_sign:backward', 'backward'],
  ]) {
    if (tags[key] == null) continue;
    const dir = dirFixed ? { dirFixed } : {};
    for (const part of parseTrafficSign(tags[key])) {
      if (part.code) {
        const f = codedFeature(part, tags, dir);
        if (f) out.push(f);
      } else if (part.named) out.push(...namedFeatures(part, tags, dir));
    }
  }
  // 2. Các thẻ tương đương biển.
  const hw = tags.highway;
  if (hw === 'traffic_signals') {
    out.push(
      feature(SIGN_CATALOGUE['W.209'], {
        kind: 'signals',
        title: 'Đèn tín hiệu giao thông',
        say: 'đèn tín hiệu giao thông',
        dirKeys: ['traffic_signals:direction', 'direction'],
      }),
    );
  }
  if (hw === 'stop') out.push(stopFeature(['stop:direction', 'direction']));
  if (hw === 'give_way') out.push(giveWayFeature(['give_way:direction', 'direction']));
  if (hw === 'crossing') {
    const f = crossingFeature(tags);
    if (f) out.push(f);
  }
  if (hw === 'mini_roundabout') {
    out.push(
      feature(SIGN_CATALOGUE['W.206'], {
        kind: 'roundabout',
        title: 'Giao nhau chạy theo vòng xuyến',
        say: 'vòng xuyến',
        dirKeys: [],
      }),
    );
  }
  if (tags.traffic_calming != null) {
    const f = calmingFeature(tags);
    if (f) out.push(f);
  }
  if (tags.railway === 'level_crossing') out.push(railFeature(tags));
  if (tags.barrier === 'height_restrictor') {
    const v = parseMeasure(tags.maxheight, 'm');
    if (v != null) out.push(derivedMeasure('height', v, { dirKeys: ['direction'] }, false));
  }
  if (tags.hazard != null && String(tags.hazard).trim() !== '') out.push(hazardFeature(tags.hazard));

  // Bỏ trùng (ví dụ highway=stop kèm traffic_sign=stop): giữ bản đầu tiên cho mỗi loại và chiều.
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.kind}|${f.dirFixed || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Thẻ trên way
// ---------------------------------------------------------------------------------------------

const firstDefined = (tags, keys) => {
  for (const k of keys) {
    const v = tags[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
};

function dimsFor(tags, dir) {
  const pick = (key, unit, fallback) =>
    parseMeasure(tags[`${key}:${dir}`], unit) ??
    parseMeasure(tags[key], unit) ??
    (fallback ? parseMeasure(tags[fallback], unit) : null);
  return { h: pick('maxheight', 'm', 'maxheight:physical'), w: pick('maxweight', 't'), wd: pick('maxwidth', 'm') };
}

/**
 * Thẻ của một way (tập con thẻ gốc, có thể undefined) → các quy định cần báo khi đi vào way:
 * { roundabout, tunnel, noCar, noMoto, noAll, dims: { forward, backward }, noOvertake, hazard }.
 */
export function classifyWay(tags) {
  const t = tags || {};
  const val = (k) => (t[k] == null ? '' : String(t[k]).trim());
  const noCar = firstDefined(t, ['motorcar', 'motor_vehicle', 'vehicle', 'access']) === 'no';
  const noMoto = firstDefined(t, ['motorcycle', 'motor_vehicle', 'vehicle', 'access']) === 'no';
  // "Đường cấm" chỉ khi cấm chung và không có thẻ riêng nào cho phép ô tô hay xe máy.
  const noAll = (val('access') === 'no' || val('vehicle') === 'no') && noCar && noMoto;
  const ov = val('overtaking');
  const noOvertake = {
    forward: ov === 'no' || ov === 'backward' || val('overtaking:forward') === 'no',
    backward: ov === 'no' || ov === 'forward' || val('overtaking:backward') === 'no',
  };
  const junction = val('junction');
  return {
    roundabout: junction === 'roundabout' || junction === 'circular',
    tunnel: val('tunnel') === 'yes',
    noCar,
    noMoto,
    noAll,
    dims: { forward: dimsFor(t, 'forward'), backward: dimsFor(t, 'backward') },
    noOvertake,
    hazard: val('hazard') || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Biển suy ra (không có nút biển thật), dùng chung câu chữ cho bộ máy cảnh báo
// ---------------------------------------------------------------------------------------------

const NOTES = {
  speedChange: 'Theo dữ liệu giới hạn tốc độ của OpenStreetMap.',
  curve: 'Tính từ hình dạng đường trên bản đồ, không phải biển thật.',
  roundabout: 'Theo dữ liệu vòng xuyến của OpenStreetMap.',
  tunnel: 'Theo dữ liệu đường hầm của OpenStreetMap.',
  oneway: 'Theo dữ liệu đường một chiều của OpenStreetMap.',
  noAccess: 'Theo dữ liệu hạn chế phương tiện của OpenStreetMap.',
  dims: 'Theo dữ liệu kích thước, tải trọng cho phép của OpenStreetMap.',
  noOvertake: 'Theo dữ liệu cấm vượt của OpenStreetMap.',
  hazard: 'Theo dữ liệu điểm nguy hiểm của OpenStreetMap.',
  turn: 'Theo dữ liệu cấm rẽ của OpenStreetMap.',
  timed: ' Lệnh cấm chỉ áp dụng trong một số khung giờ; ứng dụng chưa đọc được khung giờ này.',
};

function asDerived(f, note) {
  return { ...f, dirKeys: [], derived: true, note };
}

function derivedMeasure(kind, v, extra = {}, isDerived = true) {
  const [code, unit, label, spoken] = {
    height: ['P.117', 'm', 'Hạn chế chiều cao', 'hạn chế chiều cao'],
    weight: ['P.115', 'tấn', 'Hạn chế trọng tải', 'hạn chế trọng tải'],
    width: ['P.118', 'm', 'Hạn chế chiều ngang', 'hạn chế chiều ngang xe'],
  }[kind];
  const vi = formatNumberVi(v);
  const f = feature(SIGN_CATALOGUE[code], {
    kind: `${kind}:${v}`,
    title: `${label} ${vi} ${unit}`,
    say: `${spoken} ${vi} ${unit === 'm' ? 'mét' : unit}`,
    value: v,
    ...extra,
  });
  return isDerived ? asDerived(f, NOTES.dims) : f;
}

const TURN_WORDS = { straight: 'đi thẳng', left: 'rẽ trái', right: 'rẽ phải', uturn: 'quay đầu' };
const TURN_ORDER = ['straight', 'left', 'right', 'uturn'];
// Tổ hợp cấm rẽ có biển riêng (khoá = các hướng theo TURN_ORDER, nối bằng '+').
const TURN_CODES = {
  left: 'P.123a',
  right: 'P.123b',
  uturn: 'P.124a',
  'left+uturn': 'P.124c',
  'right+uturn': 'P.124d',
  'left+right': 'P.137',
  straight: 'P.136',
  'straight+left': 'P.138',
  'straight+right': 'P.139',
};
const ONLY = {
  straight: ['Chỉ được đi thẳng', 'arrow-up'],
  left: ['Chỉ được rẽ trái', 'turn-left'],
  right: ['Chỉ được rẽ phải', 'turn-right'],
};

const joinVi = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} và ${words.at(-1)}`);

function turnFeature({ bans, only = null, timed = false } = {}) {
  const suffix = timed ? ' theo giờ' : '';
  const note = NOTES.turn + (timed ? NOTES.timed : '');
  if (only && ONLY[only]) {
    const [title, pict] = ONLY[only];
    const entry = SIGN_CATALOGUE['R.301'];
    return asDerived(
      feature(entry, {
        kind: `turn:only-${only}${timed ? ':timed' : ''}`,
        title: title + suffix,
        say: title.toLocaleLowerCase('vi') + suffix,
        art: { shape: 'mandatory', pict },
      }),
      note,
    );
  }
  const set = new Set(bans || []);
  const parts = TURN_ORDER.filter((d) => set.has(d));
  if (!parts.length) return null;
  const key = parts.join('+');
  const kind = `turn:${key}${timed ? ':timed' : ''}`;
  const code = TURN_CODES[key];
  if (code) {
    const entry = SIGN_CATALOGUE[code];
    return asDerived(feature(entry, { kind, title: entry.name + suffix, say: entry.say + suffix }), note);
  }
  // Tổ hợp không có biển riêng: kể từng hướng; hình vẽ lấy biển gần nhất (nhiều hướng nhất).
  let best = null;
  for (const [k, c] of Object.entries(TURN_CODES)) {
    const ks = k.split('+');
    if (ks.every((d) => set.has(d)) && (!best || ks.length > best.n)) best = { c, n: ks.length };
  }
  const title = `Cấm ${joinVi(parts.map((d) => TURN_WORDS[d]))}`;
  return asDerived(
    {
      kind,
      code: null,
      cat: 'prohibit',
      title: title + suffix,
      say: title.toLocaleLowerCase('vi') + suffix,
      art: SIGN_CATALOGUE[best.c].art,
      value: null,
    },
    note,
  );
}

/**
 * Đặc trưng cho các mục bộ máy tự suy ra (đổi tốc độ, chỗ ngoặt, cấm rẽ…), cùng một cách viết
 * tiêu đề và câu đọc. Mỗi kết quả có derived: true và note cho bảng chi tiết.
 */
export function derived(kind, data = {}) {
  switch (kind) {
    case 'speedChange': {
      const n = data.n;
      return asDerived(
        feature(SIGN_CATALOGUE['P.127'], {
          kind: `speed:${n}`,
          title: `Tốc độ tối đa ${n} km/h`,
          say: `tốc độ tối đa ${n} ki lô mét trên giờ`,
          value: n,
        }),
        NOTES.speedChange,
      );
    }
    case 'curve': {
      const left = data.side === 'left';
      const entry = SIGN_CATALOGUE[left ? 'W.201a' : 'W.201b'];
      return asDerived(
        feature(entry, {
          kind: `curve:${left ? 'left' : 'right'}`,
          say: `chỗ ngoặt nguy hiểm vòng bên ${left ? 'trái' : 'phải'}`,
        }),
        NOTES.curve,
      );
    }
    case 'curves':
      return asDerived(
        feature(SIGN_CATALOGUE['W.202a'], {
          kind: 'curves',
          code: 'W.202',
          say: 'nhiều chỗ ngoặt nguy hiểm liên tiếp',
        }),
        NOTES.curve,
      );
    case 'roundabout':
      return asDerived(feature(SIGN_CATALOGUE['W.206'], { kind: 'roundabout', say: 'vòng xuyến' }), NOTES.roundabout);
    case 'tunnel':
      return asDerived(feature(SIGN_CATALOGUE['W.240'], { kind: 'tunnel', say: 'sắp vào hầm' }), NOTES.tunnel);
    case 'oneway':
      return asDerived(
        feature(SIGN_CATALOGUE['P.102'], { kind: 'oneway', say: 'đường cấm đi ngược chiều' }),
        NOTES.oneway,
      );
    case 'noAccess': {
      if (data.all) {
        return asDerived(feature(SIGN_CATALOGUE['P.101'], { kind: 'noAccess:all', say: 'đường cấm' }), NOTES.noAccess);
      }
      const moto = data.vehicle === 'moto';
      const entry = SIGN_CATALOGUE[moto ? 'P.104' : 'P.103a'];
      return asDerived(
        feature(entry, { kind: `noAccess:${moto ? 'moto' : 'car'}`, say: moto ? 'đường cấm xe máy' : 'đường cấm ô tô' }),
        NOTES.noAccess,
      );
    }
    case 'height':
    case 'weight':
    case 'width':
      return derivedMeasure(kind, data.v);
    case 'noOvertake':
      return asDerived(feature(SIGN_CATALOGUE['P.125'], { kind: 'noOvertake' }), NOTES.noOvertake);
    case 'hazard':
      return asDerived(hazardFeature(data.value), NOTES.hazard);
    case 'turn':
      return turnFeature(data);
    default:
      return null;
  }
}
