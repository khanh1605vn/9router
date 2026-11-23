// Ngưỡng và thông số của bộ chạy thử lái xe (tests/browser/run.mjs). Tách riêng để tests/browser/harness.test.mjs
// kiểm giá trị và quan hệ của chúng với hằng số của ứng dụng (PLAN §5.8, §5.9, §8.2).

import { L_RETIRE } from '../../../js/learnedsigns.js';

// ---- Ngưỡng của các kịch bản ----
export const PORT_FIRST = 20500; // cổng của bộ chạy thử: 20500–20599
export const PORT_LAST = 20599;
export const SPEED = 13.8; // m/s (~50 km/h), tốc độ đều của mỗi lần đi
export const RAMP_S = 3; // s, tăng tốc từ 0 tới SPEED
export const GPS_SIGMA = 1; // m, nhiễu vị trí GPS (độ lệch chuẩn mỗi trục)
export const GPS_ACCURACY = 5; // m, sai số máy báo
export const EAST = Object.freeze({ from: 100, to: 760 }); // m, đi Đông: qua P.127 (350), W.224 (520), R.122 (690), nút giao (700)
export const WEST = Object.freeze({ from: 780, to: 100 }); // m, đi Tây: ngược chiều với mọi biển
export const DAY_MS = 864e5;
export const DAY0 = Date.UTC(2026, 10, 24, 2, 0, 0); // 09:00 ngày 24/11/2026 giờ Việt Nam: lần đi đầu tiên
export const NIGHT_SHIFT_MS = 10.5 * 3600e3; // lần đi ban đêm: 19:30 cùng ngày (mặt trời dưới chân trời)
export const TIMEZONE = 'Asia/Ho_Chi_Minh';
export const ALONG_ERR_MAX = 5; // m, S1: sai số vị trí biển dọc đường
export const SPEAK_MIN = 100; // m, S3: câu đọc của biển đã xác nhận rơi vào khoảng này trước biển…
export const SPEAK_MAX = 200; // … tới chừng này
export const LIMIT_MARGIN = 30; // m, S3: xét biển giới hạn "Camera" từ chừng này sau biển tới chừng này trước nút giao
export const HIDE_STOP_MS = 1500; // ms, S8: ẩn trang thì camera phải dừng trong chừng này
export const SETTLE_MS = 3500; // ms, xe dừng ở cuối đường rồi mới đọc kết quả (các lượt đi qua biển kết luận sau 2 s)
export const IDB_FLUSH_MS = 1500; // ms, chờ IndexedDB ghi xong trước khi đóng trang
export const LOAD_TIMEOUT = 45000; // ms, chờ ứng dụng sẵn sàng
export const POLL_MS = 200; // ms, nhịp theo dõi tư thế xe
export const S4_SLACK_DAYS = 3; // S4: thêm tối đa chừng này lần đi khi một lần đi không cho lần thiếu nào
export const LATENCY_FRAMES = 200; // S11: số khung đo mỗi bản dựng (PLAN §8.2: ≥ 200)
export const EPS = 1e-9; // sai số làm tròn khi so điểm L
// Cửa sổ trình duyệt nhỏ: bản đồ (WebGL chạy bằng CPU trong Chromium không màn hình) vẽ lại mỗi lần định vị và chiếm
// phần lớn CPU của trang; cửa sổ nhỏ để vòng lấy khung của camera giữ được nhịp 3 khung/giây như trên máy thật.
export const VIEWPORT = Object.freeze({ width: 480, height: 800 });

/** Số lần thiếu (miss) cho tới khi bị loại (L ≤ L_RETIRE), từ điểm L hiện tại, mỗi lần trừ |w|. */
export const missesToRetire = (L, w) => Math.max(1, Math.ceil((L - L_RETIRE - EPS) / Math.abs(w)));
