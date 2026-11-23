# Bạn Đường

Ứng dụng web (PWA) dẫn đường và cảnh báo giao thông bằng tiếng Việt, chạy trên trình duyệt điện thoại và cài được ra màn hình chính như một ứng dụng thường.

Thư mục này là một ứng dụng tĩnh độc lập: không cần build, không phụ thuộc phần còn lại của repo. Có thể chép nguyên thư mục sang một repo riêng.

## Tính năng

- **Bản đồ và vị trí**: bản đồ vector, mũi tên vị trí chuyển động mượt, tự xoay theo hướng đi khi lái.
- **Tìm địa điểm**: gợi ý trong lúc gõ, nhập toạ độ trực tiếp, nhấn giữ trên bản đồ để chọn điểm, lưu Nhà và Cơ quan, lịch sử tìm kiếm.
- **Tìm đường**: nhiều tuyến để chọn, cho ô tô hoặc xe máy (xe máy tránh đường cao tốc), tuỳ chọn tránh đường thu phí, ghi rõ tuyến có cao tốc, thu phí hay phà.
- **Dẫn đường từng chặng bằng giọng nói tiếng Việt**: nhắc trước khi rẽ ở ba mốc khoảng cách, biển chỉ dẫn lớn trên màn hình, giờ đến dự kiến, tự tìm lại đường khi đi lệch.
- **Tốc độ**: đồng hồ tốc độ, biển giới hạn tốc độ của đoạn đường đang đi, cảnh báo bằng màu, tiếng bíp và lời nói khi chạy quá; tự đặt tốc độ tối đa cho đoạn đường chưa có dữ liệu.
- **Báo trước biển báo phía trước** (khoảng 100–200 m): đèn tín hiệu, biển dừng, nhường đường, vòng xuyến, cấm rẽ, cấm đi ngược chiều, đổi giới hạn tốc độ, gờ giảm tốc, đường ngang đường sắt, chỗ ngoặt nguy hiểm… Hiện trên thanh vàng giống cảnh báo camera, kèm hình biển; bấm vào để xem chi tiết. Xem [cách hoạt động và giới hạn](#báo-trước-biển-báo).
- **Cảnh báo điểm phía trước**: camera bắn tốc độ, camera đèn đỏ, camera giám sát, trạm thu phí.
- **Kết nối với ô tô** qua bộ đọc OBD-II Bluetooth (ELM327): lấy tốc độ của xe (vẫn chạy khi mất GPS trong hầm), vòng tua, nhiệt độ nước làm mát, điện áp; nhắc khi máy quá nóng hoặc điện áp thấp; đọc mã lỗi động cơ. Xem [hướng dẫn](#kết-nối-bộ-obd).
- **Giao diện màn hình ô tô**: bố cục ngang cho màn hình Android trên xe (cũng tự bật khi điện thoại đủ rộng xoay ngang), chữ và nút lớn hơn.
- **Điểm tự đánh dấu**: camera phạt nguội, cổng trường học, điểm nguy hiểm, công trường, ngập nước, kẹt xe, tai nạn; xuất và nhập tệp để chia sẻ với người khác.
- **Chế độ lái tự do**: không cần đặt điểm đến, vẫn theo dõi tốc độ và cảnh báo; tự bật khi phát hiện đang di chuyển.
- **Chạy thử**: mô phỏng chuyến đi dọc tuyến đã chọn để xem trước chỉ dẫn và cảnh báo.
- **Khác**: giao diện sáng/tối (tự chuyển từ 18 giờ đến 6 giờ), giữ màn hình sáng khi lái, nhật ký chuyến đi, mở lại được khi mất mạng.

## Chạy thử trên máy tính

Cần Node.js 22 trở lên.

```bash
cd ban-duong
npm start          # mở http://localhost:5173
npm test           # 186 bài kiểm thử logic (không cần mạng)
```

Trên máy tính không có GPS, ứng dụng lấy tâm bản đồ làm điểm xuất phát; dùng nút **Chạy thử** để xem dẫn đường hoạt động.

## Đưa lên mạng để dùng trên điện thoại

Trình duyệt chỉ cấp quyền vị trí cho trang chạy bằng **HTTPS**, nên cần đưa thư mục này lên một dịch vụ lưu trữ tĩnh. Cách nhanh nhất:

1. Mở <https://app.netlify.com/drop> trên máy tính và đăng nhập.
2. Kéo cả thư mục `ban-duong` thả vào trang.
3. Netlify trả về một địa chỉ dạng `https://ten-ngau-nhien.netlify.app`. Mở địa chỉ đó trên điện thoại.

Các lựa chọn khác dùng được y như vậy: Cloudflare Pages, Vercel, hoặc GitHub Pages của một repo riêng chứa nội dung thư mục này ở gốc. Không cần cấu hình gì thêm vì mọi đường dẫn trong ứng dụng đều là đường dẫn tương đối.

### Cài ra màn hình chính

- **Android (Chrome)**: mở trang → bấm nút ba chấm → **Thêm vào màn hình chính** (hoặc **Cài đặt ứng dụng**).
- **iPhone (Safari)**: mở trang → bấm nút **Chia sẻ** → **Thêm vào MH chính**.

Lần đầu mở, hãy cho phép trang dùng vị trí và chạm vào màn hình một lần để trình duyệt cho phát âm thanh.

### Giọng đọc tiếng Việt

Ứng dụng dùng giọng đọc có sẵn của thiết bị. Nếu không nghe thấy tiếng Việt: vào **Cài đặt** của máy → **Chuyển văn bản thành giọng nói** → tải dữ liệu giọng **Tiếng Việt**. Trong ứng dụng có nút **Đọc thử** ở phần Cài đặt.

## Báo trước biển báo

Khi dẫn đường hoặc ở chế độ lái, ứng dụng xét khoảng 320 m phía trước: theo tuyến đường khi đang dẫn đường, hoặc theo con đường đang chạy (giả định đi thẳng qua nút giao) khi lái tự do.

- **Báo lúc nào**: khoảng cách báo bằng quãng đường xe chạy trong 8 giây, giữ trong khoảng 100–200 m (chạy càng nhanh báo càng sớm). Các biển cách nhau dưới 40 m được đọc chung một câu, ví dụ “Phía trước 150 mét, đèn tín hiệu giao thông, cấm rẽ trái”. Tối đa một câu mỗi 3 giây; xe đứng yên thì không đọc câu mới.
- **Trên màn hình**: khi tới khoảng cách báo (khoảng 100–200 m), biển hiện trên thanh vàng, cùng chỗ với cảnh báo camera; nếu cùng lúc có camera thì cái nào gần hơn hiện, cái kia vẫn được đọc. Các biển xa hơn hiện ở dải nhỏ phía trên đồng hồ tốc độ (tối đa 2 biển). Điện thoại xoay ngang thường đủ rộng (từ 800 px bề ngang) để giao diện màn hình ô tô tự bật, khi đó dải vẫn hiện; màn hình hẹp hơn thì dải ẩn đi để khỏi che bản đồ.
- **Nguồn**: biển báo được nhập vào OpenStreetMap, cộng với thông tin tương đương biển: đèn tín hiệu, biển dừng và nhường đường, vạch người đi bộ qua đường, gờ giảm tốc, đường ngang đường sắt, vòng xuyến, cấm rẽ, đường một chiều, cấm xe, hạn chế chiều cao, tải trọng, chiều ngang, cấm vượt, chỗ đổi giới hạn tốc độ, hầm, và chỗ ngoặt tính từ hình dạng đường (chỉ báo khi chạy từ 30 km/h).
- **Bật/tắt từng nhóm** trong **Cài đặt → Biển báo phía trước**. Vạch người đi bộ qua đường tắt sẵn vì ở đô thị quá dày.

Giới hạn cần biết:

- Ở Việt Nam, biển báo được nhập vào OpenStreetMap còn **rất ít** (một lần đếm năm 2026 chỉ thấy 119 đối tượng có thẻ biển báo trên cả nước). Phần lớn cảnh báo vì thế đến từ thông tin tương đương ở trên, không phải từ biển thật. Không có cảnh báo **không** có nghĩa là không có biển.
- Chỗ ngoặt được tính từ hình dạng đường trên bản đồ, nên đôi khi báo cả khúc cua trong ngõ hẻm hoặc chỗ đường rẽ góc vuông. Khi lái tự do, nếu bạn rẽ ở nút giao thì những gì vừa được báo là của đường đi thẳng.
- Tên biển theo QCVN 41:2024/BGTVT lấy từ nguồn thứ cấp; hình biển trong ứng dụng là hình vẽ giản lược, không phải bản sao hình gốc.
- **Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.**

## Kết nối bộ OBD

Cần có: một bộ đọc OBD-II dùng chip ELM327 (hoặc tương thích) và điện thoại Android mở ứng dụng bằng **Chrome** hoặc **Samsung Internet** qua địa chỉ HTTPS (Edge trên Android chưa được kiểm chứng). Trên máy tính dùng được Chrome trên Windows, macOS, ChromeOS; trên Linux, Bluetooth trên web của Chrome chưa bật sẵn. Chỉ kết nối khi xe đang đỗ.

**Bộ Bluetooth Low Energy (BLE)**

1. Cắm bộ đọc vào cổng OBD của xe (thường nằm dưới vô lăng), bật khoá điện hoặc nổ máy.
2. Bật Bluetooth của điện thoại. Trong ứng dụng: **Cài đặt → Kết nối với ô tô → Kết nối bộ OBD Bluetooth**.
3. Nếu Android hỏi, cho phép Chrome dùng quyền **Thiết bị ở gần** (Android 12 trở lên) hoặc quyền **Vị trí** (Android 11 trở xuống); Android cần quyền này để Chrome tìm được thiết bị Bluetooth Low Energy.
4. Chọn bộ đọc trong danh sách (tên thường bắt đầu bằng OBD, ELM, Vlink, vLinker, Veepeak, OBDLink…). Không thấy thì bấm **Hiện mọi thiết bị**. Không cần ghép đôi trước.
5. Chờ dòng **Đã kết nối với xe**. Lần đầu bộ đọc dò giao thức của xe có thể mất tới 20 giây.

Mỗi lần mở lại trang thường phải bấm kết nối lại, vì trình duyệt chưa cho trang web tự nhớ thiết bị BLE.

**Bộ Bluetooth thường (SPP)** — nhiều bộ ELM327 giá rẻ bán ở Việt Nam là loại này:

1. Ghép đôi bộ đọc trong **Cài đặt → Bluetooth** của điện thoại (mã PIN thường là 1234 hoặc 0000).
2. Dùng Chrome 138 trở lên: **Cài đặt → Kết nối với ô tô → Bộ OBD Bluetooth thường (đã ghép đôi)** → chọn bộ đọc.
3. Lần sau mở ứng dụng, bộ đọc này được tự kết nối lại cho tới khi bạn bấm **Ngắt kết nối**.

Khi đã kết nối: đồng hồ tốc độ và cảnh báo quá tốc độ dùng tốc độ của xe (tắt được bằng **Dùng tốc độ từ xe**) và vẫn cập nhật khi mất GPS trong hầm; bảng dưới hiện vòng tua, nhiệt độ nước làm mát, điện áp; ứng dụng nhắc khi nước làm mát từ 110 °C trong 10 giây, hoặc điện áp dưới 12 V trong 30 giây lúc máy đang chạy. Nút **Đọc mã lỗi** chỉ bấm được khi xe đứng yên; ứng dụng chỉ đọc, không bao giờ xoá mã lỗi.

Không dùng được trên iPhone, iPad (Safari, Chrome và các trình duyệt thông thường trên iOS đều không cho trang web dùng Bluetooth), trên Firefox, hoặc khi mở trang ngay trong Zalo, Facebook (hãy mở bằng Chrome). Phần kết nối mới được kiểm thử với bộ ELM327 giả lập, chưa thử với bộ đọc và xe thật.

## Dùng trên màn hình Android của ô tô

1. Trên màn hình xe chạy Android có CH Play, cài **Chrome**. Ứng dụng “trình duyệt” có sẵn trên nhiều màn hình xe là loại nhúng (WebView), không có Bluetooth.
2. Mở địa chỉ HTTPS của ứng dụng bằng Chrome → nút ba chấm → **Thêm vào màn hình chính**.
3. Cho phép vị trí. **Giao diện màn hình ô tô** tự bật khi màn hình cảm ứng nằm ngang và rộng (từ 800 px bề ngang, cao không quá 760 px), nên cũng bật trên phần lớn điện thoại khi xoay ngang; có thể chọn **Bật/Tắt** trong **Cài đặt → Kết nối với ô tô**. Ở giao diện này, thanh chỉ dẫn, cảnh báo và bảng điều khiển nằm thành cột bên trái, bản đồ ở bên phải, nút bấm lớn hơn.
4. Muốn đọc dữ liệu xe thì làm như phần [Kết nối bộ OBD](#kết-nối-bộ-obd). Bluetooth của màn hình xe tuỳ hãng, có máy không kết nối được bộ BLE.

## Nghe giọng nói qua loa xe

1. Ghép đôi điện thoại với xe qua Bluetooth, bật cả phần âm thanh (không chỉ gọi điện).
2. Chọn nguồn âm thanh của xe là **Bluetooth** (BT Audio) của điện thoại và tăng âm lượng phương tiện trên điện thoại.
3. Bấm **Đọc thử** trong Cài đặt để kiểm tra.

Khi xe đang ở nguồn FM/radio hoặc USB thì giọng đọc của điện thoại không phát qua loa xe. Chrome trên Android không giành quyền phát âm thanh khi đọc, nên nhạc đang mở có thể đè lên giọng đọc. Nếu chạy ứng dụng ngay trên màn hình Android của xe thì giọng đọc thường phát ra loa xe như các âm thanh khác của màn hình.

## Vì sao không có Android Auto, CarPlay và nhận diện biển bằng camera

- **Android Auto, CarPlay** chỉ hiển thị ứng dụng gốc (native) thuộc những loại được cho phép, và phải qua kiểm duyệt của Google hoặc Apple (CarPlay còn cần Apple cấp quyền riêng cho ứng dụng dẫn đường). Một ứng dụng web không đưa lên được hai nền tảng này. Cách thay thế: chạy trên màn hình Android của xe như trên, hoặc kẹp điện thoại.
- **Nhận diện biển bằng camera** không được làm vì không đáp ứng được yêu cầu báo trước 100–200 m: biển tròn cỡ thường khoảng 70 cm, ở 150 m chỉ còn khoảng 7–15 điểm ảnh trên khung hình camera điện thoại (ước tính với góc nhìn khoảng 70°), quá nhỏ để đọc chắc chắn, nhất là khi xe rung, ngược nắng hoặc ban đêm; camera chỉ đọc được khi đã khá gần. Chạy nhận diện liên tục còn làm máy nóng và tốn pin; điện thoại kẹp trên kính dưới nắng dễ quá nhiệt và bị hạ hiệu năng.

## Cấu trúc mã nguồn

| Tệp | Nhiệm vụ |
| --- | --- |
| `index.html`, `css/app.css` | Giao diện |
| `js/main.js` | Điều phối: trạng thái màn hình, vòng xử lý mỗi lần định vị, thao tác người dùng |
| `js/mapview.js` | Bản đồ MapLibre, lớp tuyến đường và điểm cảnh báo, camera bám theo xe |
| `js/location.js` | GPS và chế độ chạy thử |
| `js/routing.js` | Gọi máy chủ tìm đường (Valhalla, dự phòng OSRM), tạo câu chỉ dẫn tiếng Việt |
| `js/tracker.js` | Bám tuyến, chọn thời điểm đọc chỉ dẫn, phát hiện lệch tuyến và đến nơi |
| `js/roaddata.js` | Tải đường, giới hạn tốc độ, điểm cảnh báo, nút biển báo và cấm rẽ từ OpenStreetMap, lưu đệm trên máy |
| `js/alerts.js` | Cảnh báo điểm phía trước (camera, trạm thu phí, điểm tự đánh dấu) và cảnh báo quá tốc độ |
| `js/signs.js` | Danh mục biển báo QCVN 41:2024, đọc thẻ biển báo của OpenStreetMap |
| `js/signart.js` | Vẽ hình biển báo (SVG) |
| `js/signengine.js` | Xét đoạn đường phía trước, chọn biển cần báo và thời điểm đọc |
| `js/elm327.js` | Giao thức bộ đọc ELM327: danh sách lệnh được phép, giải mã dữ liệu, mã lỗi |
| `js/obd.js` | Kết nối bộ OBD qua Web Bluetooth hoặc Web Serial, phiên đọc dữ liệu, nhắc tình trạng xe |
| `js/voice.js` | Giọng đọc và âm báo |
| `js/search.js` | Tìm địa điểm |
| `js/store.js` | Cài đặt, địa điểm, điểm đánh dấu, nhật ký (lưu trên thiết bị) |
| `js/icons.js` | Bộ biểu tượng tự vẽ |
| `sw.js`, `manifest.webmanifest` | Cài đặt như ứng dụng, mở được khi mất mạng |
| `vendor/maplibre-gl/` | Thư viện bản đồ MapLibre GL JS 5.24.1 (giấy phép BSD 3 điều khoản, kèm trong thư mục) |
| `tests/` | Kiểm thử bằng `node --test` |

Khi sửa mã rồi phát hành lại, hãy tăng `VERSION` trong `sw.js` để máy người dùng nhận bản mới.

## Nguồn dữ liệu

Mọi dữ liệu đều từ các dịch vụ mở, không cần khoá API:

| Dữ liệu | Dịch vụ | Chỗ đổi địa chỉ |
| --- | --- | --- |
| Bản đồ nền | OpenFreeMap | `STYLE_URLS` trong `js/mapview.js` |
| Tìm đường | Valhalla (máy chủ công cộng của FOSSGIS); dự phòng: OSRM | `VALHALLA_URL`, `OSRM_URL` trong `js/routing.js` |
| Giới hạn tốc độ, camera, trạm thu phí, biển báo, cấm rẽ | Overpass API | `OVERPASS_ENDPOINTS` trong `js/roaddata.js` |
| Tìm địa điểm | Photon, Nominatim | đầu tệp `js/search.js` |

Toàn bộ là dữ liệu © những người đóng góp cho OpenStreetMap (giấy phép ODbL).

Các máy chủ công cộng trên phù hợp để dùng cá nhân và thử nghiệm. Nếu phát hành cho nhiều người dùng, cần tự dựng máy chủ Valhalla, Photon, Overpass hoặc thuê dịch vụ tương đương rồi đổi các địa chỉ trên, vì máy chủ công cộng giới hạn lưu lượng và không cam kết luôn hoạt động.

## Giới hạn cần biết

- **Độ phủ dữ liệu**: giới hạn tốc độ, biển báo và vị trí camera do cộng đồng OpenStreetMap nhập, ở Việt Nam còn thiếu nhiều nơi (xem [Báo trước biển báo](#báo-trước-biển-báo)). Đoạn đường chưa có dữ liệu thì ứng dụng không hiện biển giới hạn (không tự suy đoán); hãy dùng mục **Tốc độ tối đa tự đặt** và tự đánh dấu camera trên tuyến hay đi.
- **Xe máy**: tuyến xe máy tính bằng hồ sơ xe hai bánh của Valhalla nên không đi vào đường cao tốc. Nếu Valhalla không phản hồi, ứng dụng chuyển sang OSRM (chỉ có hồ sơ ô tô) và ghi rõ trên màn hình rằng tuyến có thể đi qua cao tốc.
- **Không có tình trạng giao thông trực tiếp** (kẹt xe theo thời gian thực) vì không có nguồn dữ liệu mở.
- **Điểm tự đánh dấu chỉ nằm trên thiết bị**. Muốn nhiều người cùng thấy báo cáo của nhau cần thêm một máy chủ lưu trữ chung.
- **Ứng dụng web không chạy nền**: phải để ứng dụng mở trên màn hình thì mới có định vị và cảnh báo. Ứng dụng đã tự giữ màn hình sáng khi lái.
- **Chưa có bản đồ ngoại tuyến đầy đủ**: chỉ các vùng bản đồ đã xem được lưu lại; tìm đường và tìm địa điểm cần có mạng.

Biển báo và hiệu lệnh thực tế trên đường luôn là căn cứ để tuân theo.

## Quyền riêng tư

Ứng dụng không có máy chủ riêng và không thu thập dữ liệu. Vị trí chỉ được gửi tới các dịch vụ bản đồ ở bảng trên để tìm đường, tìm địa điểm và tải dữ liệu quanh vị trí hiện tại. Cài đặt, địa điểm đã lưu, điểm đánh dấu và nhật ký chuyến đi nằm trong bộ nhớ trình duyệt của thiết bị.

Dữ liệu đọc từ xe qua bộ OBD (tốc độ, vòng tua, nhiệt độ, nhiên liệu, điện áp, mã lỗi) chỉ dùng trên máy, không gửi đi đâu và không được lưu lại. Ứng dụng chỉ gửi tới bộ đọc các lệnh trong một danh sách cố định; không đọc số khung (VIN) và không có lệnh xoá mã lỗi.
