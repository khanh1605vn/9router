# Thẻ mô hình: nhận diện biển báo bằng camera (thử nghiệm)

> **Mọi con số dưới đây đo trên dữ liệu tổng hợp** (hình biển giản lược của ứng dụng dán lên ảnh đường phố nước ngoài), nên chỉ là **giới hạn trên**, **không phải độ chính xác trên đường thật ở Việt Nam**. Độ chính xác thật chưa đo được (PLAN §8.3, E2). Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.

Ngày tạo: 2026-11-23 23:12 UTC · commit: `4c4e8f10efaca1fc0f9a8275ef7c6675f613dc22` (có thay đổi chưa commit, xem `build.provenance` trong labels.json) · dấu hình vẽ: `2462ade345ffb5c7`

## Mô hình

| Tệp | Kiến trúc | Tham số | Vào | Ra |
|---|---|---|---|---|
| `sign-det.int8.tflite` | MobileNetV2 α 0,35 (khởi tạo ngẫu nhiên) + cổ FPN gọn bước 8 + đầu CenterNet | 309.807 | float32 [1,352,640,3], RGB 0–1 | heat [1,44,80,11] (đã sigmoid), reg [1,44,80,4] |
| `sign-cls.int8.tflite` | CNN 4 tầng tích chập + GAP + Dense, từ đầu | 350.805 | float32 [1,48,48,3], RGB 0–1 | logit [1,181] (chưa softmax) |

Lượng tử hoá int8 bằng TFLiteConverter (tập đại diện là ảnh kiểm định tổng hợp), vào/ra float32. Nhiệt độ hiệu chỉnh T = 1,1372 (labels.json); lúc chạy p = softmax(logit / T).

## Dữ liệu

- Hình biển: 169 mã của `SIGN_CATALOGUE` vẽ bằng `signSvg()` (js/signart.js), hình giản lược tự vẽ, giấy phép của kho mã (MIT). P.127 tách thành 11 lớp trị số 20–120. Các mã có hình vẽ giống hệt nhau được gom về một nhãn gốc khi tạo dữ liệu (xem tools/camera/README.md); W.201d, W.202b, W.223b vẽ bằng hình lật gương.
- "other-sign": biển tự sinh không có trong danh mục (vòng/đĩa/chữ nhật có chữ hay ký hiệu lạ, hình lạ, biển phụ; không dùng ký hiệu gần giống một mã trong danh mục). Không dùng ảnh biển thật của Open Images.
- "background": mảng ảnh nền (tránh các hộp biển có sẵn) và vật gây nhiễu tự vẽ (cột sọc đỏ trắng, thùng vàng đen, biển hiệu cửa hàng có chữ tiếng Việt, mảng màu, mặt sau biển).
- Ảnh nền: Open Images V7 (tập validation và test), chỉ ảnh giấy phép CC BY 2.0, chia theo tác giả: test 776, train 6.545, val 679. Trong đó 127 ảnh đã được người kiểm có/không có biển (37 ảnh xác nhận không có biển). Ghi công từng ảnh (tên ảnh, tác giả, đường dẫn, giấy phép, ghi chú đã cắt và chỉnh sửa) trong `ATTRIBUTION-openimages.csv`. Chú thích Open Images: CC BY 4.0. Ảnh chỉ dùng để huấn luyện; trong `models/` không có ảnh chụp nào, chỉ trọng số, nhãn, thẻ này và cặp vào/ra mẫu vẽ trên nền thủ tục (`golden/`).
- Hộp "Traffic sign" và "Stop sign" có sẵn là vùng bỏ qua khi huấn luyện bộ dò. **Giới hạn**: gần hết ảnh nền chưa được người kiểm có biển hay không, và ảnh đã xác nhận có biển vẫn có biển sót hộp, nên có thể có biển thật không có hộp; trên mọi ảnh trừ ảnh xác nhận không có biển, lỗi âm của bộ dò chỉ tính 0,25 phần, nhưng biển thật vẫn có thể bị dạy thành nền một phần, và một ít ảnh cắt "background" có thể chứa biển thật. Điều này làm giảm khả năng thấy biển, không làm tăng nhận nhầm.
- Ảnh cắt `train`: 124.200 ảnh.
- Ảnh cắt `val`: 9.600 ảnh.
- Ảnh cắt `test`: 6.400 ảnh.
- Ảnh cắt `testw`: 48.900 ảnh.
- Ảnh ghép `train`: 12.000 ảnh.
- Ảnh ghép `val`: 600 ảnh.
- Ảnh ghép `test-evalA`: 500 ảnh.
- Ảnh ghép `test-evalB`: 500 ảnh.

## Huấn luyện và khả năng tái lập

- Phiên bản: python 3.13.18, tensorflow 2.21.0, keras 3.15.1, numpy 2.5.5, pillow 13.0.0, platform Linux-6.18.44-fc-v726-x86_64-with-glibc2.39.
- Bộ phân loại: 36 epoch, lô 128, hạt giống 1, độ chính xác kiểm định tốt nhất 97,9 % (epoch 35).
- Bộ dò: 30 epoch, lô 16, ô cắt 320×320, hạt giống 2, mất mát kiểm định tốt nhất 0,679 (epoch 29), 4,99 giờ CPU.
- SHA-256 của mã và hình vẽ dùng để tạo dữ liệu nằm trong `build.provenance.sources` của labels.json; `tests/models.test.mjs` báo lỗi khi hình vẽ biển đổi sau khi huấn luyện.
- Op determinism của TensorFlow bật; dữ liệu vẽ theo hạt giống của từng mẫu. Kết quả tái lập trong biên độ nhiễu đo; trọng số giống hệt từng bit trên CPU khác nhau thì không bảo đảm.

## Bộ phân loại: top-1 theo cạnh biển thật (tập test để riêng)

Ngưỡng của PLAN §8.4 cho mỗi nhãn được học: gộp các cạnh ≥ 24 điểm ảnh, top-1 ≥ 97 %, và không cạnh nào thấp hơn rõ rệt (cận trên Wilson một phía 95 % < 97 %). 48.900 ảnh, khung bộ dò lệch ±15 % kích thước và ±10 % vị trí.

| Nhãn | 20 px | 24 px | 32 px | 48 px | Gộp ≥ 24 px (số ảnh) | Qua ngưỡng |
|---|---|---|---|---|---|---|
| P.101 | 97,5 % | 98,0 % | 98,5 % | 99,5 % | 98,7 % (600) | có |
| P.102 | 98,5 % | 100,0 % | 100,0 % | 99,0 % | 99,7 % (600) | có |
| P.103a | 94,5 % | 97,5 % | 99,5 % | 98,5 % | 98,5 % (600) | có |
| P.104 | 98,0 % | 98,5 % | 99,5 % | 100,0 % | 99,3 % (600) | có |
| P.106a | 93,0 % | 94,5 % | 96,5 % | 99,5 % | 96,8 % (600) | không |
| P.115 | 88,0 % | 91,5 % | 97,5 % | 98,5 % | 95,8 % (600) | không |
| P.117 | 97,5 % | 99,0 % | 99,5 % | 100,0 % | 99,5 % (600) | có |
| P.123a | 99,0 % | 98,5 % | 99,5 % | 100,0 % | 99,3 % (600) | có |
| P.123b | 99,5 % | 99,5 % | 98,5 % | 98,5 % | 98,8 % (600) | có |
| P.124a | 97,5 % | 98,0 % | 98,5 % | 100,0 % | 98,8 % (600) | có |
| P.124c | 97,5 % | 100,0 % | 99,5 % | 100,0 % | 99,8 % (600) | có |
| P.124d | 97,5 % | 99,0 % | 99,5 % | 99,5 % | 99,3 % (600) | có |
| P.125 | 99,5 % | 100,0 % | 99,5 % | 99,5 % | 99,7 % (600) | có |
| P.127[20] | 88,0 % | 92,5 % | 98,0 % | 97,5 % | 96,0 % (600) | không |
| P.127[30] | 79,5 % | 94,5 % | 97,0 % | 98,0 % | 96,5 % (600) | không |
| P.127[40] | 89,0 % | 93,5 % | 96,5 % | 100,0 % | 96,7 % (600) | không |
| P.127[50] | 83,5 % | 93,0 % | 97,0 % | 98,0 % | 96,0 % (600) | không |
| P.127[60] | 91,5 % | 91,0 % | 93,5 % | 96,5 % | 93,7 % (600) | không |
| P.127[70] | 90,5 % | 93,5 % | 98,5 % | 99,0 % | 97,0 % (600) | không |
| P.127[80] | 80,0 % | 90,0 % | 93,5 % | 98,0 % | 93,8 % (600) | không |
| P.127[90] | 85,0 % | 88,5 % | 96,5 % | 98,0 % | 94,3 % (600) | không |
| P.127[100] | 85,0 % | 93,5 % | 98,5 % | 99,0 % | 97,0 % (600) | không |
| P.127[110] | 83,5 % | 90,0 % | 95,5 % | 98,5 % | 94,7 % (600) | không |
| P.127[120] | 81,5 % | 91,0 % | 96,5 % | 98,0 % | 95,2 % (600) | không |
| P.130 | 98,0 % | 99,5 % | 100,0 % | 100,0 % | 99,8 % (600) | có |
| P.131a | 98,0 % | 99,5 % | 97,5 % | 99,5 % | 98,8 % (600) | có |
| DP.134 | 91,0 % | 96,5 % | 95,5 % | 99,5 % | 97,2 % (600) | có |
| DP.135 | 91,5 % | 93,5 % | 96,0 % | 99,0 % | 96,2 % (600) | không |
| W.201a | 94,5 % | 97,0 % | 98,5 % | 99,5 % | 98,3 % (600) | có |
| W.201b | 95,5 % | 97,5 % | 99,0 % | 98,5 % | 98,3 % (600) | có |
| W.202a | 92,0 % | 96,0 % | 99,0 % | 99,5 % | 98,2 % (600) | có |
| W.202b | 93,0 % | 97,0 % | 97,5 % | 99,5 % | 98,0 % (600) | có |
| W.205 | 92,5 % | 99,0 % | 99,5 % | 98,5 % | 99,0 % (600) | có |
| W.207 | 93,5 % | 98,0 % | 97,5 % | 98,5 % | 98,0 % (600) | có |
| W.208 | 99,0 % | 100,0 % | 100,0 % | 100,0 % | 100,0 % (600) | có |
| W.209 | 91,0 % | 98,5 % | 99,0 % | 99,0 % | 98,8 % (600) | có |
| W.210 | 95,0 % | 97,5 % | 98,5 % | 99,5 % | 98,5 % (600) | có |
| W.211 | 94,5 % | 96,5 % | 100,0 % | 99,5 % | 98,7 % (600) | có |
| W.221b | 92,5 % | 97,0 % | 96,5 % | 99,0 % | 97,5 % (600) | có |
| W.224 | 89,5 % | 96,0 % | 99,5 % | 98,0 % | 97,8 % (600) | có |
| W.225 | 89,0 % | 98,5 % | 99,5 % | 99,0 % | 99,0 % (600) | có |
| W.227 | 92,5 % | 95,0 % | 99,0 % | 99,0 % | 97,7 % (600) | không |
| W.233 | 82,0 % | 95,5 % | 98,5 % | 100,0 % | 98,0 % (600) | có |
| R.122 | 99,5 % | 100,0 % | 99,0 % | 99,0 % | 99,3 % (600) | có |
| R.302a | 99,5 % | 99,5 % | 100,0 % | 100,0 % | 99,8 % (600) | có |
| R.302b | 98,5 % | 100,0 % | 98,5 % | 100,0 % | 99,5 % (600) | có |
| R.303 | 98,0 % | 99,0 % | 100,0 % | 100,0 % | 99,7 % (600) | có |
| *109 nhãn khác (trung bình)* | 94,8 % | 97,1 % | 98,9 % | 99,4 % | | |

### Nhầm lẫn thường gặp

| Nhãn thật | Đoán thành | Số ảnh |
|---|---|---|
| P.127[120] | P.127[110] | 36 |
| DP.135 | DP.134 | 32 |
| P.127[90] | P.127[80] | 27 |
| P.127[110] | P.127[100] | 25 |
| P.127[80] | P.127[90] | 22 |
| P.127[110] | P.127[120] | 22 |
| DP.134 | DP.135 | 20 |
| P.127[20] | P.127[30] | 19 |
| P.127[120] | P.127[100] | 19 |
| P.106a | P.106b | 18 |
| P.127[60] | P.127[50] | 18 |
| P.127[60] | P.127[80] | 18 |
| W.221b | W.221a | 18 |
| P.127[80] | P.127[60] | 17 |
| P.103a | P.107b | 16 |

### Hiệu chỉnh (tập test, cạnh ngẫu nhiên)

- ECE (15 ngăn) trước hiệu chỉnh: 0,0074; sau (T = 1,1372): 0,0047. Trên tập kiểm định lúc tìm T: 0,0029 → 0,0031.
- Top-1 trên 6.400 ảnh: 97,4 %.
- Ảnh "background"/"other-sign" bị nhận nhầm thành nhãn được học với p ≥ 0,85: 0,0 %; độ chính xác của các lần nhận đó trên ảnh biển: 99,7 %; tỉ lệ ảnh biển được học đạt p ≥ 0,85: 95,5 %.

## Bộ dò: độ phủ theo cạnh biển ở ảnh vào bộ dò

Trúng khi tâm lệch ≤ max(3 px, 0,5 × cạnh) và tỉ lệ cạnh trong 0,5–2,0; điểm đỉnh ≥ 0,30. Lượt A: cắt 640×352 đúng độ phân giải camera; lượt B: cả khung hình camera (chủ yếu 1920×1080) thu nhỏ cho vừa 640×352 và thêm viền đen như lúc chạy. "Khung sai/ảnh" tính trên mọi ảnh và riêng ảnh có nền sạch (nền vẽ thủ tục hoặc ảnh xác nhận không có biển; biển thật không có hộp trên nền khác bị tính là khung sai).

| Lượt | 8 px | 10 px | 12 px | 16 px | 20 px | Khung sai/ảnh | Khung sai/ảnh nền sạch |
|---|---|---|---|---|---|---|---|
| A, đúng họ | 54,9 % | 73,2 % | 80,2 % | 91,9 % | 92,5 % | 1,05 | – |
| A, bất kể họ | 77,8 % | 92,2 % | 91,1 % | 97,6 % | 95,5 % | | |
| B, đúng họ | 58,4 % | 76,8 % | 86,3 % | 90,4 % | 92,5 % | 1,65 | – |
| B, bất kể họ | 78,5 % | 88,9 % | 95,9 % | 95,2 % | 94,5 % | | |

## Nhãn được học không qua ngưỡng

`P.106a`, `P.115`, `P.127[20]`, `P.127[30]`, `P.127[40]`, `P.127[50]`, `P.127[60]`, `P.127[70]`, `P.127[80]`, `P.127[90]`, `P.127[100]`, `P.127[110]`, `P.127[120]`, `DP.135`, `W.227`.

Đã đặt `learn: false` cho: DP.135, P.106a, P.115, P.127[100], P.127[110], P.127[120], P.127[20], P.127[30], P.127[40], P.127[50], P.127[60], P.127[70], P.127[80], P.127[90], W.227.

## Giới hạn

- Huấn luyện chỉ bằng hình vẽ giản lược của ứng dụng, chưa so với ảnh biển thật; khoảng cách giữa dữ liệu tổng hợp và đường thật chưa đo được, có thể lớn.
- Ảnh nền chủ yếu là đường phố nước ngoài; ít cảnh xe máy dày đặc và mặt tiền cửa hàng như ở Việt Nam. Phần lớn ảnh nền chưa được kiểm có biển thật hay không (xem mục Dữ liệu).
- Biển chữ, biển phụ, mũi tên R.301 và trị số tải trọng/chiều cao không được đọc.
- Tốc độ, nhiệt độ và pin trên điện thoại chưa đo.
