# Bạn Đường

Ứng dụng web (PWA) dẫn đường và cảnh báo giao thông bằng tiếng Việt, chạy trên trình duyệt điện thoại và cài được ra màn hình chính như một ứng dụng thường.

Thư mục này là một ứng dụng tĩnh độc lập: không cần build, không phụ thuộc phần còn lại của repo. Có thể chép nguyên thư mục sang một repo riêng.

## Tính năng

- **Bản đồ và vị trí**: bản đồ vector, mũi tên vị trí chuyển động mượt, tự xoay theo hướng đi khi lái.
- **Tìm địa điểm**: gợi ý trong lúc gõ, nhập toạ độ trực tiếp, nhấn giữ trên bản đồ để chọn điểm, lưu Nhà và Cơ quan, lịch sử tìm kiếm.
- **Tìm đường**: nhiều tuyến để chọn, cho ô tô hoặc xe máy (xe máy tránh đường cao tốc), tuỳ chọn tránh đường thu phí, ghi rõ tuyến có cao tốc, thu phí hay phà.
- **Dẫn đường từng chặng bằng giọng nói tiếng Việt**: nhắc trước khi rẽ ở ba mốc khoảng cách, biển chỉ dẫn lớn trên màn hình, giờ đến dự kiến, tự tìm lại đường khi đi lệch.
- **Tốc độ**: đồng hồ tốc độ, biển giới hạn tốc độ của đoạn đường đang đi, cảnh báo bằng màu, tiếng bíp và lời nói khi chạy quá; tự đặt tốc độ tối đa cho đoạn đường chưa có dữ liệu.
- **Cảnh báo phía trước**: camera bắn tốc độ, camera đèn đỏ, camera giám sát, trạm thu phí, đường ngang đường sắt.
- **Điểm tự đánh dấu**: camera phạt nguội, cổng trường học, điểm nguy hiểm, công trường, ngập nước, kẹt xe, tai nạn; xuất và nhập tệp để chia sẻ với người khác.
- **Chế độ lái tự do**: không cần đặt điểm đến, vẫn theo dõi tốc độ và cảnh báo; tự bật khi phát hiện đang di chuyển.
- **Chạy thử**: mô phỏng chuyến đi dọc tuyến đã chọn để xem trước chỉ dẫn và cảnh báo.
- **Khác**: giao diện sáng/tối (tự chuyển từ 18 giờ đến 6 giờ), giữ màn hình sáng khi lái, nhật ký chuyến đi, mở lại được khi mất mạng.

## Chạy thử trên máy tính

Cần Node.js 22 trở lên.

```bash
cd ban-duong
npm start          # mở http://localhost:5173
npm test           # 34 bài kiểm thử logic (không cần mạng)
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

## Cấu trúc mã nguồn

| Tệp | Nhiệm vụ |
| --- | --- |
| `index.html`, `css/app.css` | Giao diện |
| `js/main.js` | Điều phối: trạng thái màn hình, vòng xử lý mỗi lần định vị, thao tác người dùng |
| `js/mapview.js` | Bản đồ MapLibre, lớp tuyến đường và điểm cảnh báo, camera bám theo xe |
| `js/location.js` | GPS và chế độ chạy thử |
| `js/routing.js` | Gọi máy chủ tìm đường, tạo câu chỉ dẫn tiếng Việt |
| `js/tracker.js` | Bám tuyến, chọn thời điểm đọc chỉ dẫn, phát hiện lệch tuyến và đến nơi |
| `js/roaddata.js` | Tải giới hạn tốc độ và điểm cảnh báo từ OpenStreetMap, lưu đệm trên máy |
| `js/alerts.js` | Cảnh báo điểm phía trước và cảnh báo quá tốc độ |
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
| Tìm đường | OSRM (máy chủ thử nghiệm công cộng) | `OSRM_URL` trong `js/routing.js` |
| Giới hạn tốc độ, camera, trạm thu phí | Overpass API | `OVERPASS_ENDPOINTS` trong `js/roaddata.js` |
| Tìm địa điểm | Photon, Nominatim | đầu tệp `js/search.js` |

Toàn bộ là dữ liệu © những người đóng góp cho OpenStreetMap (giấy phép ODbL).

Các máy chủ công cộng trên phù hợp để dùng cá nhân và thử nghiệm. Nếu phát hành cho nhiều người dùng, cần tự dựng máy chủ OSRM, Photon, Overpass hoặc thuê dịch vụ tương đương rồi đổi các địa chỉ trên, vì máy chủ công cộng giới hạn lưu lượng và không cam kết luôn hoạt động.

## Giới hạn cần biết

- **Độ phủ dữ liệu**: giới hạn tốc độ và vị trí camera do cộng đồng OpenStreetMap nhập, ở Việt Nam còn thiếu nhiều nơi. Đoạn đường chưa có dữ liệu thì ứng dụng không hiện biển giới hạn (không tự suy đoán); hãy dùng mục **Tốc độ tối đa tự đặt** và tự đánh dấu camera trên tuyến hay đi.
- **Xe máy**: máy chủ tìm đường công cộng chỉ có hồ sơ ô tô. Chế độ xe máy dùng hồ sơ đó và loại đường cao tốc; thời gian dự kiến tính theo ô tô.
- **Không có tình trạng giao thông trực tiếp** (kẹt xe theo thời gian thực) vì không có nguồn dữ liệu mở.
- **Điểm tự đánh dấu chỉ nằm trên thiết bị**. Muốn nhiều người cùng thấy báo cáo của nhau cần thêm một máy chủ lưu trữ chung.
- **Ứng dụng web không chạy nền**: phải để ứng dụng mở trên màn hình thì mới có định vị và cảnh báo. Ứng dụng đã tự giữ màn hình sáng khi lái.
- **Chưa có bản đồ ngoại tuyến đầy đủ**: chỉ các vùng bản đồ đã xem được lưu lại; tìm đường và tìm địa điểm cần có mạng.

Biển báo và hiệu lệnh thực tế trên đường luôn là căn cứ để tuân theo.

## Quyền riêng tư

Ứng dụng không có máy chủ riêng và không thu thập dữ liệu. Vị trí chỉ được gửi tới các dịch vụ bản đồ ở bảng trên để tìm đường, tìm địa điểm và tải dữ liệu quanh vị trí hiện tại. Cài đặt, địa điểm đã lưu, điểm đánh dấu và nhật ký chuyến đi nằm trong bộ nhớ trình duyệt của thiết bị.
