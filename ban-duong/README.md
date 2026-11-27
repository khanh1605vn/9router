# Bạn Đường

Ứng dụng web (PWA) dẫn đường và cảnh báo giao thông bằng tiếng Việt, chạy trên trình duyệt điện thoại và cài được ra màn hình chính như một ứng dụng thường.

Thư mục này là một ứng dụng tĩnh độc lập: không cần build, không phụ thuộc phần còn lại của repo. Có thể chép nguyên thư mục sang một repo riêng.

## Tính năng

- **Bản đồ và vị trí**: bản đồ vector, mũi tên vị trí chuyển động mượt, tự xoay theo hướng đi khi lái.
- **Tìm địa điểm**: gợi ý trong lúc gõ, nhập toạ độ trực tiếp, nhấn giữ trên bản đồ để chọn điểm, lưu Nhà và Cơ quan, lịch sử tìm kiếm.
- **Tìm đường**: nhiều tuyến để chọn, cho ô tô hoặc xe máy (xe máy tránh đường cao tốc), tuỳ chọn tránh đường thu phí, ghi rõ tuyến có cao tốc, thu phí hay phà.
- **Dẫn đường từng chặng bằng giọng nói tiếng Việt**: nhắc trước khi rẽ ở ba mốc khoảng cách, biển chỉ dẫn lớn trên màn hình, giờ đến dự kiến, tự tìm lại đường khi đi lệch.
- **Tốc độ**: đồng hồ tốc độ, biển giới hạn tốc độ của đoạn đường đang đi, cảnh báo bằng màu, tiếng bíp và lời nói khi chạy quá; tự đặt tốc độ tối đa cho đoạn đường chưa có dữ liệu. Đang lái mà hơn 5 giây không có vị trí GPS mới (và cũng không có tốc độ từ xe) thì đồng hồ hiện dấu “–” thay vì giữ số cũ.
- **Báo trước biển báo phía trước** (khoảng 100–200 m): đèn tín hiệu, biển dừng, nhường đường, vòng xuyến, cấm rẽ, cấm đi ngược chiều, đổi giới hạn tốc độ, gờ giảm tốc, đường ngang đường sắt, chỗ ngoặt nguy hiểm… Hiện trên thanh vàng giống cảnh báo camera, kèm hình biển; bấm vào để xem chi tiết. Xem [cách hoạt động và giới hạn](#báo-trước-biển-báo).
- **Cảnh báo điểm phía trước**: camera bắn tốc độ, đoạn đo tốc độ trung bình, camera đèn đỏ, camera giám sát, điểm kiểm soát tải trọng hoặc chiều cao xe, trạm thu phí. Camera có ghi chiều trên bản đồ không bị báo cho chiều bên kia. Vị trí camera ở Việt Nam phần lớn không có trên bản đồ mở, xem [giới hạn](#báo-trước-biển-báo).
- **Kết nối với ô tô** qua bộ đọc OBD-II Bluetooth (ELM327): lấy tốc độ của xe (vẫn chạy khi mất GPS trong hầm), vòng tua, nhiệt độ nước làm mát, điện áp; nhắc khi máy quá nóng hoặc điện áp thấp; đọc mã lỗi động cơ. Xem [hướng dẫn](#kết-nối-bộ-obd).
- **Giao diện màn hình ô tô**: bố cục ngang cho màn hình Android trên xe (cũng tự bật khi điện thoại đủ rộng xoay ngang), chữ và nút lớn hơn.
- **Nút “Báo cáo” và dữ liệu cộng đồng**: tự đánh dấu camera, biển báo mới hoặc đã tháo, tốc độ tối đa thay đổi, đường cấm, cổng trường học, điểm nguy hiểm, công trường, ngập nước, kẹt xe, tai nạn; gửi báo cáo cho chủ ứng dụng qua Zalo, tin nhắn hoặc GitHub; xuất và nhập tệp để chia sẻ với người khác. Điểm chủ ứng dụng đã tự kiểm tra tại chỗ được phát cho mọi người dùng. Xem [Báo cáo và dữ liệu cộng đồng](#báo-cáo-và-dữ-liệu-cộng-đồng).
- **Chế độ lái tự do**: không cần đặt điểm đến, vẫn theo dõi tốc độ và cảnh báo; tự bật khi phát hiện đang di chuyển.
- **Chạy thử**: mô phỏng chuyến đi dọc tuyến đã chọn để xem trước chỉ dẫn và cảnh báo.
- **Camera nhận diện biển (thử nghiệm, tắt sẵn)**: điện thoại kẹp trên xe ghi nhận biển báo khi đi qua và báo trước ở những lần đi sau. Xem [cách hoạt động và giới hạn](#camera-nhận-diện-biển-thử-nghiệm).
- **Khác**: giao diện sáng/tối (tự chuyển từ 18 giờ đến 6 giờ), giữ màn hình sáng khi lái, nhật ký chuyến đi, mở lại được khi mất mạng.

## Chạy thử trên máy tính

Cần Node.js 22 trở lên.

```bash
cd ban-duong
npm start          # mở http://localhost:5173
npm test           # các bài kiểm thử logic (không cần mạng)
```

Trên máy tính không có GPS, ứng dụng lấy tâm bản đồ làm điểm xuất phát; dùng nút **Chạy thử** để xem dẫn đường hoạt động.

## Mở trên iPhone và máy tính

Bản web của Bạn Đường nằm tại **<https://khanh1605vn.github.io/9router/>**. Mở địa chỉ này bằng Safari trên iPhone, iPad (rồi cài ra Màn hình chính như mục [Cài trên iPhone](#cài-trên-iphone)), bằng Chrome trên điện thoại Android hay bằng trình duyệt trên máy tính. Ứng dụng Android trên xe không cần địa chỉ này: nó mang sẵn ứng dụng web bên trong.

Trang được GitHub Actions tự đưa lên (workflow `.github/workflows/ban-duong-pages.yml` ở gốc kho): mỗi lần mã trên nhánh `master` có thay đổi trong `ban-duong/` (trừ `ban-duong/android/`), workflow chạy `npm test`, rồi `npm run dist`, kiểm tra thư mục `dist/` chỉ có tệp của ứng dụng và đưa đúng thư mục đó lên. Không cần secret nào.

**Việc chủ kho làm một lần** (trên GitHub, kho `khanh1605vn/9router`):

1. Vào **Settings** → **Pages** → **Build and deployment** → **Source**, chọn **GitHub Actions**.
2. Gộp (merge) thay đổi vào nhánh `master`. Lần chạy đầu tiên của workflow **Bạn Đường Pages** đưa trang lên; nếu đã gộp từ trước khi bật Pages, vào thẻ **Actions** → **Bạn Đường Pages** → **Run workflow** (chọn nhánh `master`) để chạy lại.

Sau đó **bản mới tự đến máy người dùng**: lần sau mở ứng dụng khi có mạng, máy nhận bản mới và hiện nút **Đã có bản mới, bấm để tải lại** (chỉ hiện khi xe đứng yên). Khi sửa mã, nhớ tăng `VERSION` trong `sw.js` và `SHELL_VERSION` trong `js/appupdate.js`.

Lưu ý: mọi trang GitHub Pages của cùng một tài khoản (`khanh1605vn.github.io/<tên kho>/`) dùng chung một địa chỉ gốc, nên dùng chung bộ nhớ trình duyệt và quyền vị trí, camera, dù nằm ở kho khác. Kho khác trên cùng tài khoản **không phải** là địa chỉ khác. Đừng đưa trang thử nghiệm, bản sao thứ hai của Bạn Đường hay mã không tin cậy lên Pages của tài khoản này; trang thử nghiệm phải ở một tên miền khác hẳn (Netlify Drop, hay Pages của một tài khoản GitHub khác). Từ bản `v12`, bộ nhớ đệm của ứng dụng gắn với thư mục `/9router/`, nên một bản Bạn Đường khác trên cùng tài khoản không còn xoá được bộ nhớ đệm của nó, nhưng một trang có mã xấu trên cùng địa chỉ gốc thì vẫn đọc và sửa được dữ liệu của ứng dụng; cách chắc chắn duy nhất là giữ tài khoản này sạch, hoặc dùng tên miền riêng.

Bản mới đến tay người dùng ngay cả khi GitHub Pages bảo trình duyệt giữ tệp 10 phút (`Cache-Control: max-age=600`): service worker luôn tải thẳng tệp mới từ máy chủ khi cài bản mới, và hỏi lại máy chủ mỗi lần nạp tệp của ứng dụng.

## Đưa lên mạng để dùng trên điện thoại

Trình duyệt chỉ cấp quyền vị trí cho trang chạy bằng **HTTPS**, nên cần đưa ứng dụng lên một dịch vụ lưu trữ tĩnh. Trang dùng khi lái chỉ nên chứa các tệp của ứng dụng: `index.html`, `manifest.webmanifest`, `sw.js` và các thư mục `css/`, `js/`, `icons/`, `vendor/`, `models/`. **Không đưa `tests/` và `tools/` lên trang này**: các trang thử nghiệm trong đó chạy cùng địa chỉ nên dùng chung quyền camera, bộ nhớ trình duyệt và danh sách biển đã học của ứng dụng. Cách nhanh nhất:

1. Chạy `npm run dist`: lệnh này chép đúng các tệp trên vào thư mục `dist/` (xoá bản cũ trước).
2. Mở <https://app.netlify.com/drop> trên máy tính và đăng nhập.
3. Kéo thư mục `dist` thả vào trang.
4. Netlify trả về một địa chỉ dạng `https://ten-ngau-nhien.netlify.app`. Mở địa chỉ đó trên điện thoại.

Các lựa chọn khác dùng được y như vậy: Cloudflare Pages, Vercel, hoặc GitHub Pages (kho này đã có sẵn workflow tự đưa lên, xem [Mở trên iPhone và máy tính](#mở-trên-iphone-và-máy-tính)). Không cần cấu hình gì thêm vì mọi đường dẫn trong ứng dụng đều là đường dẫn tương đối, nên ứng dụng chạy được cả ở gốc tên miền lẫn trong thư mục con như `/9router/`.

Muốn chạy `tests/browser/device-bench.html` (đo tốc độ nhận diện trên điện thoại thật) hay `tools/camera/label-crops.html` qua mạng, hãy đưa **cả thư mục** `ban-duong` lên một trang tạm **khác tên miền** với trang dùng khi lái (ví dụ Netlify Drop; **không** dùng một kho khác trên `khanh1605vn.github.io`, vì đó vẫn là cùng địa chỉ gốc), rồi xoá trang đó khi xong, để các trang thử nghiệm không bao giờ dùng chung quyền camera và dữ liệu của ứng dụng.

### Nếu thêm Content-Security-Policy

`index.html` đã có sẵn một CSP dạng thẻ `<meta http-equiv="Content-Security-Policy">` (vì GitHub Pages không gửi được tiêu đề HTTP): chỉ khoá nguồn mã (`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:`), cấm plugin, khung, đổi `<base>` và gửi biểu mẫu ra ngoài; giống chính sách mà ứng dụng Android gửi kèm trang (`HTML_CSP` trong `android/…/web/WebAssets.kt`), trừ `frame-ancestors` (thẻ meta không nhận chỉ thị này, nên trang trên GitHub Pages vẫn có thể bị trang khác nhúng vào khung). Thẻ này chỉ áp lên trang, không áp lên `js/vision-worker.js`. Nếu sửa chính sách ở một chỗ, sửa cả chỗ kia (`tests/deploy.test.mjs` kiểm tra hai chỗ khớp nhau).

Nếu bạn thêm CSP đầy đủ hơn qua cấu hình của dịch vụ lưu trữ (ví dụ tệp `_headers` của Netlify hay Cloudflare Pages), phải tách hai chính sách:

- **Trang** (`/` và `/index.html`): `default-src 'self'; script-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:` cộng các máy chủ ô bản đồ; `connect-src 'self'` cộng các máy chủ kiểu bản đồ, ô bản đồ, Overpass, tìm địa điểm và tìm đường (lấy danh sách từ `js/mapview.js`, `js/roaddata.js`, `js/routing.js`, `js/search.js`, đừng chép cố định); `style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com`. Cần `blob:` trong `worker-src` vì MapLibre chạy worker vẽ bản đồ từ địa chỉ `blob:`; chỉ có `worker-src 'self'` thì bản đồ không hiện.
- **`js/vision-worker.js`** (bộ nhận diện biển): worker này nhận chính sách từ chính phản hồi của tệp đó, không theo trang. Nó cần `script-src 'self' blob: 'wasm-unsafe-eval'`: `blob:` để chạy mã LiteRT đã kiểm SHA-256, `'wasm-unsafe-eval'` để dịch WebAssembly. Chỉ đặt `blob:` và `'wasm-unsafe-eval'` cho riêng tệp này.

Đừng đặt chính sách của trang chung cho mọi đường dẫn (`/*`): khi đó nó cũng áp lên `js/vision-worker.js` và camera không nhận diện được biển (mục cài đặt báo không tải được dữ liệu nhận diện). Sau khi thêm CSP, hãy mở bản đồ và **Kiểm tra camera** → **Đo tốc độ xử lý** để chắc chắn mọi thứ vẫn chạy.

### Cài ra màn hình chính

- **Android (Chrome)**: mở trang → bấm nút ba chấm → **Thêm vào màn hình chính** (hoặc **Cài đặt ứng dụng**).
- **iPhone, iPad (Safari)**: mở trang → bấm nút **Chia sẻ** → **Thêm vào Màn hình chính**. Từ iOS 16.4, Chrome, Edge và Firefox trên iPhone cũng làm được như vậy qua nút **Chia sẻ** của mình. Xem từng bước và các giới hạn ở mục [Cài trên iPhone](#cài-trên-iphone).

Lần đầu mở, hãy cho phép trang dùng vị trí và chạm vào màn hình một lần để trình duyệt cho phát âm thanh.

### Giọng đọc tiếng Việt

Ứng dụng dùng giọng đọc có sẵn của thiết bị. Nếu không nghe thấy tiếng Việt: vào **Cài đặt** của máy → **Chuyển văn bản thành giọng nói** → tải dữ liệu giọng **Tiếng Việt**. Trong ứng dụng có nút **Đọc thử** ở phần Cài đặt.

## Cài trên iPhone

Trên iPhone, iPad, Bạn Đường là ứng dụng web cài từ Safari ra Màn hình chính (không có ứng dụng trên App Store: ứng dụng iPhone gốc và CarPlay cần tài khoản nhà phát triển Apple trả phí). Cần **iOS 16.4 trở lên**; máy cũ hơn sẽ hiện dòng “Trình duyệt này chưa chạy được Bạn Đường”.

1. Mở **Safari** (biểu tượng la bàn xanh) và vào địa chỉ của ứng dụng, ví dụ <https://khanh1605vn.github.io/9router/>. Nếu đang mở trong Zalo hay Facebook (hay một trình duyệt lạ), hãy chép địa chỉ rồi dán vào Safari: ứng dụng sẽ nhắc việc này. Chrome, Edge và Firefox trên iOS 16.4 trở lên cũng thêm được ra Màn hình chính qua nút **Chia sẻ** của trình duyệt (thường ở thanh địa chỉ, hoặc trong trình đơn ba chấm hay ba gạch); không thấy mục **Thêm vào Màn hình chính** thì làm từ Safari. Mỗi bản cài từ một trình duyệt có dữ liệu riêng, nên chỉ cài một lần, từ một trình duyệt.
2. Bấm nút **Chia sẻ** (hình ô vuông có mũi tên đi lên, ở thanh dưới trên iPhone, góc trên trên iPad). Trên iOS mới, nếu không thấy nút này, bấm nút **ba chấm** trước rồi chọn **Chia sẻ**.
3. Kéo danh sách xuống, chọn **Thêm vào Màn hình chính** (có máy ghi tắt là **Thêm vào MH chính**; máy để tiếng Anh: **Add to Home Screen**). Nếu có công tắc mở như ứng dụng web, hãy để bật.
4. Bấm **Thêm**. Biểu tượng Bạn Đường xuất hiện trên Màn hình chính; từ nay mở ứng dụng bằng biểu tượng này, không mở qua Safari.
5. Lần đầu mở, bấm **Cho phép** khi được hỏi dùng vị trí. Nếu lỡ từ chối: vào **Cài đặt** của iPhone → **Quyền riêng tư & Bảo mật** → **Dịch vụ định vị**, kiểm tra Dịch vụ định vị đang bật và mục của Safari (máy tiếng Anh: **Safari Websites**) được phép **Khi dùng ứng dụng**, rồi đóng hẳn và mở lại Bạn Đường.
6. Vào **Cài đặt** của ứng dụng (nút bánh răng) → bấm **Đọc thử**. Không nghe thấy giọng tiếng Việt: vào **Cài đặt** của iPhone → **Trợ năng** → **Nội dung được đọc** → **Giọng nói** → **Tiếng Việt**, tải một giọng. Không nghe thấy gì: tắt chế độ im lặng (nút gạt hay nút tác vụ ở cạnh máy) và tăng âm lượng.

Khi mở trong Safari, Chrome, Edge hay Firefox mà chưa cài, ứng dụng hiện một dòng gợi ý “Để dùng như ứng dụng: bấm nút Chia sẻ… rồi chọn Thêm vào Màn hình chính”; bấm vào để xem các bước, bấm dấu × để ẩn hẳn. Trong **Cài đặt** có mục **Trên iPhone** ghi lại các giới hạn dưới đây.

**Giới hạn trên iPhone** (do iOS, ứng dụng web không vượt qua được):

- **Chỉ chạy khi ứng dụng đang mở trên màn hình.** Tắt màn hình, khoá máy hay chuyển sang ứng dụng khác thì iPhone tạm dừng ứng dụng: không theo dõi vị trí, không đọc cảnh báo, không báo quá tốc độ. Khi lái, hãy kẹp điện thoại và để Bạn Đường mở trên màn hình.
- **Giữ màn hình sáng**: ứng dụng tự xin giữ màn hình sáng khi lái (cần iOS 16.4 trở lên). Theo ghi chú phát hành của Safari 18.4, chức năng này mới chạy được trong ứng dụng mở từ Màn hình chính từ **iOS 18.4**; trên iOS cũ hơn màn hình có thể vẫn tự tắt. Khi đó hãy vào **Cài đặt** → **Màn hình & Độ sáng** → **Tự động khóa** và chọn thời gian dài hơn (hoặc **Không bao giờ**) trong lúc lái, rồi đặt lại sau.
- **Không có kết nối bộ OBD Bluetooth**: iPhone không cho trang web (kể cả Chrome trên iPhone) dùng Bluetooth.
- **Không có CarPlay**: CarPlay chỉ hiện ứng dụng gốc được Apple duyệt. Có thể nghe giọng đọc qua loa xe bằng Bluetooth như mục [Nghe giọng nói qua loa xe](#nghe-giọng-nói-qua-loa-xe).
- **Âm thanh**: chỉ phát được sau khi bạn chạm vào ứng dụng (ví dụ bấm **Bắt đầu lái**); khi chế độ im lặng đang bật, âm báo và giọng đọc có thể không kêu. Sau cuộc gọi hay Siri, ứng dụng tự mở lại âm báo khi hiện lại trên màn hình và trước mỗi tiếng bíp; nếu vẫn không nghe tiếng bíp, chạm vào màn hình một lần (cách này mới kiểm bằng kiểm thử tự động, chưa thử trên iPhone thật).
- **Dữ liệu trên máy**: Safari có thể tự xoá dữ liệu (cài đặt, Nhà, Cơ quan, điểm đánh dấu, biển đã học) của trang web không được mở trong 7 ngày. Ứng dụng đã thêm vào Màn hình chính được tính riêng theo số ngày bạn mở nó, nên thường không bị xoá kiểu này. Vẫn nên **Xuất tệp** điểm đánh dấu để sao lưu.
- **Camera nhận diện biển**: phải bật lại bằng tay (khi xe đã đỗ) mỗi lần mở ứng dụng, và **chưa được thử trên iPhone thật**.

Các phần trên mới được kiểm bằng kiểm thử tự động và trình duyệt máy tính giả lập iPhone, **chưa được thử trên iPhone thật**. Nếu gặp lỗi trên máy của bạn, hãy ghi lại đời máy và phiên bản iOS.

## Báo trước biển báo

Khi dẫn đường hoặc ở chế độ lái, ứng dụng xét khoảng 320 m phía trước: theo tuyến đường khi đang dẫn đường, hoặc theo con đường đang chạy (giả định đi thẳng qua nút giao) khi lái tự do.

- **Báo lúc nào**: khoảng cách báo bằng quãng đường xe chạy trong 8 giây, giữ trong khoảng 100–200 m (chạy càng nhanh báo càng sớm). Các biển cách nhau dưới 40 m được đọc chung một câu, ví dụ “Phía trước 150 mét, đèn tín hiệu giao thông, cấm rẽ trái”. Tối đa một câu mỗi 3 giây; xe đứng yên thì không đọc câu mới.
- **Trên màn hình**: khi tới khoảng cách báo (khoảng 100–200 m), biển hiện trên thanh vàng, cùng chỗ với cảnh báo camera; nếu cùng lúc có camera thì cái nào gần hơn hiện, cái kia vẫn được đọc. Các biển xa hơn hiện ở dải nhỏ phía trên đồng hồ tốc độ (tối đa 2 biển). Điện thoại xoay ngang thường đủ rộng (từ 800 px bề ngang) để giao diện màn hình ô tô tự bật, khi đó dải vẫn hiện; màn hình hẹp hơn thì dải ẩn đi để khỏi che bản đồ.
- **Nguồn**: biển báo được nhập vào OpenStreetMap, cộng với thông tin tương đương biển: đèn tín hiệu, biển dừng và nhường đường, vạch người đi bộ qua đường, gờ giảm tốc, đường ngang đường sắt, vòng xuyến, cấm rẽ, đường một chiều, cấm xe, hạn chế chiều cao, tải trọng, chiều ngang, cấm vượt, chỗ đổi giới hạn tốc độ, hầm, và chỗ ngoặt tính từ hình dạng đường (chỉ báo khi chạy từ 30 km/h).
- **Cấm xe theo giờ**: ứng dụng đọc các lệnh cấm theo giờ trong tuần ghi trên OpenStreetMap (thẻ `motorcar`, `motorcycle`, `motor_vehicle`, `vehicle`, `access` kèm `:conditional`), ví dụ phố đi bộ Hoàn Kiếm từ tối thứ Sáu đến hết Chủ nhật. Lệnh cấm chỉ được báo khi đang trong giờ cấm, như biển cấm thường: “đường cấm ô tô”, “đường cấm xe máy” hoặc “đường cấm”. Lệnh cấm riêng ô tô không bao giờ được báo cho xe máy, và ngược lại. Đường cấm cố định mà có khung giờ được đi (ví dụ `motor_vehicle=no` và `motor_vehicle:conditional=yes @ (22:00-06:00)`) thì trong khung giờ đó không báo cấm.
  - Khung có ngày tháng (Tết, 30/4, 2/9, ngày diễu binh…) bị bỏ qua, nên lệnh cấm một lần của các dịp đó **không** được báo. Bỏ như vậy để các khung đã cũ còn nằm trên bản đồ (đo trên dữ liệu đã lưu: hơn 100 đường ở Hoàn Kiếm từ đợt A80, khoảng 50 đường ở Quận 1 và 3, TP. Hồ Chí Minh, từ dịp 30/4) không báo sai hằng năm.
  - Khung theo ngày lễ, theo giờ mặt trời mọc hoặc lặn, và khung không đọc được thì ứng dụng im lặng, không đoán. Lệnh cấm theo giờ chỉ cho một chiều đường, hay riêng cho taxi, xe tải, xe buýt cũng chưa được báo.
- **Cấm quay đầu, cấm rẽ qua dải phân cách**: quan hệ cấm rẽ mà chỗ rẽ là một hoặc vài đoạn đường ngắn (thường là chỗ mở dải phân cách) nay cũng được báo, ở chỗ đường đang đi gặp đoạn nối đó. Ứng dụng chỉ báo khi ghép được các đoạn đường đúng chiều đi; thiếu đoạn trong dữ liệu đã tải, chuỗi đứt hoặc đường một chiều ngược chiều thì bỏ, để không báo lệnh cấm của chiều bên kia. Đo trên dữ liệu đã lưu: Hoàn Kiếm ghép được 15/16 quan hệ loại này, Quận 1 và 3 (TP. Hồ Chí Minh) 37/43.
- **Giới hạn tốc độ theo chiều**: đường ghi giới hạn khác nhau cho hai chiều (`maxspeed:forward`, `maxspeed:backward`, kể cả riêng ô tô, xe máy) thì đồng hồ lấy số của chiều đang đi. Chưa biết chiều thì đường một chiều lấy chiều được đi, đường hai chiều lấy số nhỏ hơn (thiếu số của một chiều thì không hiện). Giới hạn theo giờ (`maxspeed:conditional`) chỉ dùng khi là khung giờ trong tuần đọc được; loại xe có giới hạn riêng (ví dụ `maxspeed:motorcycle=50`) thì giới hạn theo giờ chung không thay được số đó. Ở hai ô đã đo chưa có đường nào ghi kiểu này, nên đây là sửa cho đúng chứ chưa thêm được đường nào.
- **Biển suy ra từ bản đồ** (không phải biển thật được nhập vào bản đồ):
  - “Bắt đầu đường cao tốc” (IE.452) khi từ đường thường vào cao tốc hoặc nhánh nối cao tốc, **không kèm con số**: tốc độ trên cao tốc theo biển của từng tuyến. Ra trạm dừng nghỉ rồi vào lại cao tốc thì không báo.
  - Tốc độ tối thiểu (R.306) khi đường ghi `minspeed`; qua cầu, hầm không ghi số rồi gặp lại cùng số thì không đọc lại.
  - Đường ngầm (W.216a) khi đường hoặc nút ghi `ford=yes`.
  - “Đường có thu phí”: chỉ hiện, không đọc.
- **Camera và trạm thu phí**:
  - Camera ghi `forward` hoặc `backward` không bị báo cho xe đi chiều bên kia. Hướng ghi bằng số độ chỉ dùng để bỏ camera của đường cắt ngang, vì người vẽ bản đồ không thống nhất số đó là hướng xe chạy hay hướng ống kính. Hướng được xét từ khi xe chạy khoảng 7 km/h, cũng là tốc độ từ đó cảnh báo mới được báo, nên khi bò trong kẹt xe camera của chiều bên kia vẫn không bị báo. Khi dẫn đường, hướng của camera được so với hướng của tuyến tại chỗ camera, nên camera ngay sau chỗ rẽ vẫn được báo sớm. Camera không ghi hướng, ghi hướng không đọc được, hoặc khi điện thoại không báo hướng đi thì vẫn luôn được báo.
  - “Đoạn đo tốc độ trung bình”, “Điểm kiểm soát tải trọng xe” và “Điểm kiểm soát chiều cao xe” có tên riêng. Camera tốc độ không ghi giới hạn thì thanh cảnh báo hiện kèm giới hạn của đường đang đi; câu đọc không có số này.
  - Camera nhận dạng biển số (ALPR) được tính là camera giao thông khi không ghi vùng giám sát khác (camera ALPR ghi vùng bãi xe, toà nhà, hay ghi là camera riêng, trong nhà thì không); camera giám sát không ghi là giám sát giao thông thì không. Trạm thu phí vẽ thành vùng cũng được báo, gộp với trạm vẽ thành điểm trong 120 m.
- **Xe máy**: khi chọn phương tiện là xe máy, đường một chiều có ghi ngoại lệ cho xe máy trên OpenStreetMap (`oneway:motorcycle=no`, hoặc `oneway:moped=no`) được coi là đi được cả hai chiều: không báo “cấm đi ngược chiều”, và khi đi theo chiều ngược lại vẫn có giới hạn tốc độ và các cảnh báo phía trước của đường đó (trừ biển cắm riêng không ghi hướng, vốn quay về phía dòng xe đi theo chiều một chiều). Ô tô vẫn được báo như thường.
- **Bật/tắt từng nhóm** trong **Cài đặt → Biển báo phía trước**. Vạch người đi bộ qua đường tắt sẵn vì ở đô thị quá dày.

Giới hạn cần biết:

- Ở Việt Nam, biển báo được nhập vào OpenStreetMap còn **rất ít** (đếm ngày 22/11/2026: 119 đối tượng có thẻ biển báo trên cả nước, và không có đối tượng nào trong hai ô đô thị đã đo bên dưới). Phần lớn cảnh báo vì thế đến từ thông tin tương đương ở trên, không phải từ biển thật. Không có cảnh báo **không** có nghĩa là không có biển.
- **Không có cảnh báo camera không có nghĩa là không có camera.** Cùng lần đếm ngày 22/11/2026, OpenStreetMap chỉ có **46** điểm camera bắn tốc độ (`highway=speed_camera`) và **4** quan hệ kiểm soát (`type=enforcement`) cho cả Việt Nam; hai ô đã đo bên dưới không có camera nào. Trong khi đó, chỉ riêng Hà Nội, báo chí đưa tin khoảng 1.837 camera AI vận hành từ 13/12/2025 ([Nhân Dân](https://nhandan.vn/1837-camera-ai-tai-ha-noi-chinh-thuc-van-hanh-post930057.html)). Vị trí camera phạt nguội ở Việt Nam không phải dữ liệu mở, nên ứng dụng không thể có danh sách đầy đủ, và không chép từ nguồn khác. Đội cảnh sát giao thông bắn tốc độ lưu động thì không nguồn dữ liệu nào có. Hãy tự đánh dấu camera trên tuyến hay đi bằng nút **Báo cáo**.
- **Giới hạn tốc độ chỉ có trên một phần đường phố.** Tỉ lệ chiều dài đường có ghi `maxspeed`, đo trên dữ liệu OpenStreetMap đã tải về của hai ô:

  | Loại đường | Hoàn Kiếm, Hà Nội (dữ liệu 01/6/2026) | Quận 1 và 3, TP. Hồ Chí Minh (dữ liệu 28/7/2026) |
  | --- | --- | --- |
  | Quốc lộ, đường trục (`trunk`) | không đo | 94 % |
  | Đường chính (`primary`) | 18 % | 44 % |
  | Đường cấp 2 (`secondary`) | 5 % | 64 % |
  | Đường cấp 3 (`tertiary`) | 1 % | 28 % |
  | Đường trong khu dân cư (`residential`) | 2 % | 9 % |

  Nơi khác có thể cao hơn hoặc thấp hơn: chưa đo được trên cả nước. Đoạn đường không ghi giới hạn thì ứng dụng **không tự suy đoán** giới hạn theo luật; hãy dùng **Tốc độ tối đa tự đặt** (Cài đặt), hoặc báo **Tốc độ tối đa thay đổi** ở chỗ có biển.
- Chỗ ngoặt được tính từ hình dạng đường trên bản đồ, nên đôi khi báo cả khúc cua trong ngõ hẻm hoặc chỗ đường rẽ góc vuông. Khi lái tự do, nếu bạn rẽ ở nút giao thì những gì vừa được báo là của đường đi thẳng, và thanh vàng có thể còn hiện biển đó thêm vài giây sau khi rẽ.
- Khi lái tự do trên hai đường song song sát nhau (đường hầm và đường bên trên, đường trên cao và đường bên dưới, đường chính và đường song hành, thường chỉ cách nhau vài mét), ứng dụng có thể bám nhầm sang đường kia một lúc, nên có thể bỏ sót biển của đường đang đi hoặc báo biển của đường kia.
- Khi bò chậm trong kẹt xe (dưới khoảng 9 km/h) trên một con đường chưa biết chiều đi (vừa qua nút giao không rõ hướng, vừa rẽ chậm sang đường khác), ứng dụng chỉ đoán chiều đi từ hướng đi do điện thoại đo được ở hai lần định vị liên tiếp. Nhiều điện thoại không báo hướng đi khi chạy chậm; khi đó, cũng như khi có đường khác gần cùng hướng trong khoảng 25 m (đường gom, hai bên của đường đôi), hoặc khi con đường đó cấm loại xe đang chọn, ứng dụng không báo biển của con đường đó cho tới khi xe chạy nhanh hơn.
- Khi đang dẫn đường, ứng dụng không báo “cấm đi ngược chiều” cho chính tuyến đang đi; cảnh báo này chỉ có khi lái tự do.
- Tên biển theo QCVN 41:2024/BGTVT lấy từ nguồn thứ cấp; hình biển trong ứng dụng là hình vẽ giản lược, không phải bản sao hình gốc.
- **Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.**

## Báo cáo và dữ liệu cộng đồng

Bản đồ mở thiếu nhiều camera và biển báo (xem [Báo trước biển báo](#báo-trước-biển-báo)). Nút **Báo cáo** giúp bạn tự đánh dấu những gì thấy trên đường và gửi cho chủ ứng dụng; điểm chủ ứng dụng đã tự đi xem tại chỗ được đưa vào **dữ liệu cộng đồng** cho mọi người dùng.

### Báo cáo

1. Bấm nút tròn lớn **Báo cáo** trên bản đồ.
2. **Khi xe đứng yên hoặc đi dưới 10 km/h**, chọn một loại:
   - Gửi được cho chủ ứng dụng: **Camera bắn tốc độ**, **Camera phạt vượt đèn đỏ**, **Biển báo mới** (có thể ghi mã biển, ví dụ P.103a; không bắt buộc), **Biển báo đã tháo**, **Tốc độ tối đa thay đổi** (chọn số ghi trên biển), **Đường cấm, rào chắn**.
   - Mục **Loại khác**: camera phạt nguội và điểm nguy hiểm (cũng gửi được), cùng cổng trường học, công trường, ngập nước, kẹt xe, tai nạn (chỉ lưu trên máy này).
3. **Khi xe chạy nhanh hơn 10 km/h**, chỉ còn một nút lớn **Camera ở đây**: chạm là lưu ngay trên máy, không gửi gì; khi dừng xe, chạm vào điểm trên bản đồ để gửi. Hộp báo cáo đang mở cũng tự thu về nút này khi xe bắt đầu chạy. Người lái không được cầm hay bấm điện thoại khi xe đang chạy: nút này dành cho người ngồi cạnh; người lái hãy đợi xe dừng hẳn.
4. Sau khi lưu, chọn cách gửi:
   - **Chia sẻ hoặc chép**: một đoạn chữ ngắn tiếng Việt gửi qua Zalo hay tin nhắn, gồm toạ độ, đường dẫn OpenStreetMap, ngày thấy và một dòng dữ liệu cho chủ ứng dụng.
   - **Gửi qua GitHub**: mở trang tạo issue với tiêu đề và nội dung điền sẵn. **Issue là công khai** và hiện tên tài khoản GitHub của người gửi.
   - Gửi sau cũng được: chạm vào điểm trên bản đồ khi xe đứng yên.
5. Muốn gửi nhiều điểm một lần: **Cài đặt → Điểm tôi tự đánh dấu → Xuất cho kho dữ liệu** tạo một tệp JSON gồm các điểm gửi được.

Điểm vừa báo được lưu như điểm tự đánh dấu, nên máy này nhắc ngay ở lần đi qua sau. Hướng xe chạy được lưu khi xe đi từ khoảng 7 km/h; khi có hướng, điểm chỉ nhắc xe chạy cùng chiều (lệch tối đa 60°). **Biển báo đã tháo** chỉ để gửi đi, không nhắc khi lái.

**Gửi đi những gì**: chỉ ngày, toạ độ (làm tròn khoảng 1 m) và hướng xe chạy. Ứng dụng không gửi tên, số điện thoại, tài khoản hay giờ phút báo cáo. Nhưng **issue GitHub hiện giờ tạo issue** và tên tài khoản của bạn: gửi ngay tại chỗ thì ai đọc cũng biết tài khoản đó ở đây lúc nào. Nếu ngại, hãy gửi sau, hoặc gửi riêng cho chủ ứng dụng qua Zalo hay tệp xuất. Ứng dụng chỉ mở Zalo, hộp chia sẻ hay trang GitHub khi bạn bấm; không có gì được gửi tự động.

### Dữ liệu cộng đồng

- **Bật/tắt**: **Cài đặt → Điểm cảnh báo → Dùng dữ liệu cộng đồng** (bật sẵn). Ngay dưới là dòng “Dữ liệu cộng đồng: N điểm, cập nhật dd/mm/yyyy”. Tắt thì ứng dụng thôi tải tệp này (ứng dụng Android không liên lạc GitHub Pages cho việc này nữa). Camera cộng đồng còn theo công tắc **Camera giao thông**.
- **Nhận ra điểm cộng đồng**: tên trên thanh cảnh báo và màn hình xe có thêm “(dữ liệu cộng đồng)”. Chạm vào điểm trên bản đồ để xem nguồn, ngày chủ ứng dụng xác minh và ngày hết hiệu lực nếu có. Cùng một thứ có ở nhiều nguồn (camera cùng loại, hay điểm nguy hiểm, rào chắn trên OpenStreetMap, trong dữ liệu cộng đồng và trong điểm bạn tự đánh dấu, cách nhau không quá 30 m) chỉ được báo một lần; nếu cùng lúc trong tầm báo thì bản đồ thắng, rồi tới dữ liệu cộng đồng. Việc gộp làm sau khi đã bỏ các điểm của chiều đường bên kia, nên camera bản đồ của chiều bên kia đường đôi không làm mất cảnh báo của chiều bạn đang đi.
- **Cập nhật**: ứng dụng tải lại tệp lúc mở và mỗi 6 giờ, và giữ bản gần nhất để dùng khi mất mạng.
- **Không đầy đủ**: chỉ có những điểm chủ ứng dụng đã tự kiểm tra tại chỗ, nên không có cảnh báo không có nghĩa là không có camera hay biển. Bản phát hành đầu tiên **chưa có điểm nào**. Luôn tuân theo biển báo thực tế.

### Việc của chủ ứng dụng: cập nhật `data/community.json`

**Nguyên tắc**

- **Chỉ thêm những gì chính bạn đã thấy tại chỗ.** Không chép từ VNeTraffic, báo chí, Google Maps hay ứng dụng khác (bản quyền, và sai thì gây hại). Báo cáo của người dùng chỉ là gợi ý nơi cần đi xem.
- **Sửa nguồn chung khi có thể.** Biển đã tháo, biển mới có mã rõ thì nên sửa luôn trên OpenStreetMap từ khảo sát của bạn: mọi ứng dụng cùng được lợi. `data/community.json` dành cho những gì OSM chưa có hoặc chưa phù hợp, như camera đèn đỏ hay rào chắn tạm.
- **Dùng `until` cho điểm có thời hạn**, như rào chắn công trình. Hết hạn thì ứng dụng tự bỏ.

**Định dạng (schema 1)**

```json
{
  "schema": 1,
  "updated": "YYYY-MM-DD",
  "items": [
    {"id":"…","type":"camera-speed","coord":[kinh_độ,vĩ_độ],"direction":90,"value":60,"note":"…","source":"…","verified":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  ]
}
```

| Loại (`type`) | Ý nghĩa | Ghi chú |
| --- | --- | --- |
| `camera-speed` | Camera bắn tốc độ | `value` không bắt buộc |
| `camera-redlight` | Camera phạt vượt đèn đỏ | |
| `camera-traffic` | Camera giám sát, phạt nguội nói chung | |
| `speed-limit` | Biển tốc độ tối đa | `value` bắt buộc |
| `sign` | Biển báo khác | `code` bắt buộc: mã QCVN 41:2024 có trong danh mục của ứng dụng, loại không cần con số (ví dụ P.103a, W.207b). Biển tốc độ dùng `speed-limit`. |
| `hazard` | Điểm nguy hiểm | |
| `closure` | Đường cấm, rào chắn | |

- `coord`: `[kinh độ, vĩ độ]`, trong khung Việt Nam (gồm Hoàng Sa, Trường Sa), làm tròn 6 chữ số.
- `direction` (không bắt buộc): số nguyên 0–359, **hướng xe chạy** mà điểm áp dụng (0 = Bắc, 90 = Đông). Không ghi thì báo cả hai chiều.
- `value`: km/h, số nguyên 5–130, bội của 5.
- `note` (không bắt buộc): tối đa 120 ký tự, chỉ hiện trong hộp chi tiết, không đọc thành tiếng.
- `source`: bắt buộc, tối đa 60 ký tự, ví dụ “Chủ ứng dụng khảo sát”.
- `verified`: ngày bạn kiểm tra, không được ở tương lai. `until` (không bắt buộc): ngày hết hiệu lực, từ ngày `verified` trở đi.
- `id`: tối đa 48 ký tự `[A-Za-z0-9._-]`; công cụ tự đặt từ loại và toạ độ.

Ứng dụng kiểm tra tệp trước khi dùng. **Bỏ cả tệp** khi `schema` không phải 1, `updated` sai dạng hoặc muộn hơn hôm nay quá 2 ngày, có quá 5000 mục, hoặc tệp lớn hơn 1,5 MB. **Bỏ lặng lẽ** mục sai (không đoán), trường lạ, mục đã quá `until` và mục trùng `id`.

**Bản nào được dùng**: trình duyệt và GitHub Pages dùng bản cùng nguồn gốc. Ứng dụng Android dùng thêm https://khanh1605vn.github.io/9router/data/community.json (không gửi cookie, không gửi Referer, không theo chuyển hướng). Bản có `updated` mới hơn thắng; cùng ngày thì GitHub Pages, rồi bản đi kèm ứng dụng, rồi bản đã lưu. Vì “mới hơn thắng”, **luôn tăng `updated`** khi sửa tệp (công cụ tự làm). Muốn rút lại một điểm sai thì xoá mục đó rồi đăng tệp có `updated` mới hơn.

**Gộp báo cáo bằng `tools/community/add-reports.mjs`** (chỉ cần Node 22, không cài thêm gì; chạy từ thư mục `ban-duong/`):

```bash
# Xem trước: chỉ in kết quả, không ghi tệp
node tools/community/add-reports.mjs bao-cao.json --dry-run

# Gộp thật. Ngày xác minh mặc định là hôm nay; ghi rõ nếu bạn đi xem hôm khác
node tools/community/add-reports.mjs bao-cao.json issue-12.txt --verified 2026-11-26 --source "Chủ ứng dụng khảo sát"

# Rào chắn có thời hạn, kèm ghi chú của chính bạn (áp dụng cho mọi mục thêm mới lần này)
node tools/community/add-reports.mjs rao-chan.txt --until 2026-12-31 --note "Rào chắn thi công cầu vượt"
```

- **Đầu vào**: tệp “Xuất cho kho dữ liệu” (`ban-duong-bao-cao-YYYY-MM-DD.json`); một mảng mục, một mục, hoặc một tệp community.json khác; chữ dán từ issue GitHub hay tin Zalo lưu thành `.txt` (mọi dòng bắt đầu bằng `{` và kết thúc bằng `}` được đọc như một mục, kể cả khi bọc trong dấu backtick); hoặc `-` để đọc từ đầu vào chuẩn.
- **Ngày xác minh và id**: mỗi mục được đặt `verified` là ngày bạn xác minh, không phải ngày người dùng thấy. `id` được tính lại từ loại và toạ độ.
- **Chỉ lấy trường có cấu trúc**: từ báo cáo, công cụ chỉ lấy `type`, `coord`, `direction`, `value`, `code`. Chữ tự do và ngày do người gửi viết (`note`, `source`, `until`, `verified`, `id`, trường lạ) **không bao giờ** được chép sang tệp đăng lên, vì issue và tin Zalo là chữ của người khác. `source` là `--source` (mặc định “Người dùng Bạn Đường báo cáo”); `note` và `until` chỉ do bạn đặt bằng `--note` và `--until`.
- **Xem lại trước khi đăng**: công cụ in đủ từng mục sẽ thêm (dòng `+ mục N: {…}`) và vị trí từng mục trùng (dòng `= mục N tại …`). Chạy `--dry-run` và đọc các dòng này trước khi ghi thật.
- **Kiểm tra**: mục đi qua đúng bộ kiểm tra của ứng dụng (`js/communitydata.js`); mục sai bị từ chối kèm lý do, ví dụ “Từ chối mục 2: tốc độ phải là số nguyên 5–130, bội của 5”. Báo cáo **Biển báo mới** chưa có mã thì bị từ chối: thêm `"code":"P.xxx"` vào dòng đó sau khi xem tại chỗ, rồi chạy lại.
- **Mục trùng**: mục cùng loại cách mục đã có không quá 20 m không được thêm; công cụ chỉ cập nhật ngày xác minh của mục cũ.
- **Ghi tệp**: dọn mục đã hết hạn, đặt `updated` bằng hôm nay, kiểm tra lại cả tệp trước khi ghi, mỗi mục một dòng để dễ xem khác biệt trong git.
- **Mã thoát**: 0 khi mọi mục được nhận; 1 khi có mục bị từ chối (các mục còn lại vẫn được ghi); 2 khi lỗi (không ghi gì).

**Đăng lên**: commit `data/community.json` lên nhánh master. GitHub Pages tự triển khai (`npm run dist` chép đúng `data/community.json`; tệp khác đặt vào `data/` bị `.gitignore` bỏ và không được chép). Ứng dụng đang chạy nhận bản mới khi mở lại hoặc trong vòng 6 giờ, không cần đổi `VERSION` của `sw.js`. Bản APK sau mang theo tệp mới trong `assets/www/data/`.

**An toàn và riêng tư**

- Tệp và báo cáo là dữ liệu từ ngoài vào: ứng dụng chỉ `JSON.parse` rồi kiểm tra, chữ chỉ hiện qua `textContent`. Tệp không được ghim mã băm vì nó cập nhật độc lập với ứng dụng; nếu kho mã bị chiếm quyền, kẻ gian chỉ đưa được điểm cảnh báo sai trong giới hạn của bộ kiểm tra, không chạy được mã.
- Báo cáo có thể lộ nơi ở, nơi làm việc của người gửi: công cụ không chép ghi chú của họ; đừng tự chép vào `--note`, đừng thêm điểm gần nhà riêng, và xoá hoặc ẩn issue nếu người gửi lỡ để lộ thông tin riêng.

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

Khi đã kết nối: đồng hồ tốc độ và cảnh báo quá tốc độ dùng tốc độ của xe (tắt được bằng **Dùng tốc độ từ xe**) và vẫn cập nhật khi mất GPS trong hầm; bảng dưới hiện vòng tua, nhiệt độ nước làm mát, điện áp; ứng dụng nhắc khi nước làm mát từ 110 °C ở hai lần đọc liên tiếp cách nhau ít nhất 10 giây (nhiệt độ được đọc mỗi 15 giây, nên thường là khoảng 15 giây sau lần đọc nóng đầu tiên), hoặc khi điện áp dưới 12 V lúc máy đang chạy (vòng tua từ 500 vòng/phút) ở các lần đọc liên tiếp kéo dài ít nhất 30 giây (điện áp được đọc mỗi 20 giây, nên thường là ở lần đọc thứ ba, khoảng 40 giây); lần đọc điện áp lúc bộ đọc lỡ mất số vòng tua không được tính. Nếu xe báo lỗi đường truyền (CAN ERROR…), ứng dụng ẩn số liệu cũ và tự dò lại giao thức của xe; khi đang mất GPS (trong hầm) thì đồng hồ tốc độ hiện dấu “–” cho tới khi có lại tốc độ của xe hoặc vị trí GPS. Nút **Đọc mã lỗi** chỉ bấm được khi xe đứng yên; ứng dụng chỉ đọc, không bao giờ xoá mã lỗi.

Không dùng được trên iPhone, iPad (Safari, Chrome và các trình duyệt thông thường trên iOS đều không cho trang web dùng Bluetooth), trên Firefox, hoặc khi mở trang ngay trong Zalo, Facebook (hãy mở bằng Chrome). Phần kết nối mới được kiểm thử với bộ ELM327 giả lập, chưa thử với bộ đọc và xe thật.

## Dùng trên màn hình Android của ô tô

1. Trên màn hình xe chạy Android có CH Play, cài **Chrome**. Ứng dụng “trình duyệt” có sẵn trên nhiều màn hình xe là loại nhúng (WebView), không có Bluetooth.
2. Mở địa chỉ HTTPS của ứng dụng bằng Chrome → nút ba chấm → **Thêm vào màn hình chính**.
3. Cho phép vị trí. **Giao diện màn hình ô tô** tự bật khi màn hình cảm ứng nằm ngang và rộng (từ 800 px bề ngang, cao không quá 760 px), nên cũng bật trên phần lớn điện thoại khi xoay ngang; có thể chọn **Bật/Tắt** trong **Cài đặt → Kết nối với ô tô**. Ở giao diện này, thanh chỉ dẫn, cảnh báo và bảng điều khiển nằm thành cột bên trái, bản đồ ở bên phải, nút bấm lớn hơn.
4. Muốn đọc dữ liệu xe thì làm như phần [Kết nối bộ OBD](#kết-nối-bộ-obd). Bluetooth của màn hình xe tuỳ hãng, có máy không kết nối được bộ BLE.

## Ứng dụng Android: tự cập nhật

Bản cài chính thức của ứng dụng Android (`ban-duong.apk`, thẻ `ban-duong-v…` trong mục Releases của kho) tự kiểm tra bản mới khi mở và mỗi 6 giờ. Khi có bản mới, góc trên màn hình hiện nút **Có phiên bản mới**; bấm một lần là ứng dụng tự tải, kiểm tra rồi mở hộp thoại cài đặt của Android, bạn chỉ cần bấm **Cập nhật** trong hộp thoại đó. Không cần chép tệp qua USB hay Zalo nữa. Cũng có thể bấm **Cài đặt → Phiên bản ứng dụng → Kiểm tra cập nhật**.

- Lần đầu, Android hỏi quyền **Cài ứng dụng không rõ nguồn gốc**: bật **Cho phép từ nguồn này** cho Bạn Đường rồi quay lại, việc cập nhật tự tiếp tục.
- Nút cập nhật ẩn khi đang dẫn đường hay đang lái, và ứng dụng không mở hộp thoại cài khi xe đang chạy.
- Ứng dụng chỉ cài bản có đúng chữ ký của Bạn Đường (cùng khoá với bản đang cài), đúng tên gói và mới hơn bản đang dùng.
- Bản cài thử (`ban-duong-sideload.apk`, ký bằng khoá thử) không tự cập nhật được: nó chỉ báo có bản mới và mở trang tải bản chính thức. Cài bản chính thức một lần (có thể gỡ bản thử sau đó); từ đó về sau bản chính thức tự cập nhật.

### Phát hành bản Android

Tăng `versionCode` và `versionName` trong `android/version.properties`, sửa `android/release-notes.txt` (tối đa 300 ký tự, tiếng Việt), rồi đẩy lên nhánh `master`. GitHub Actions (`.github/workflows/ban-duong-android.yml`) chạy kiểm thử, build, ký bằng khoá phát hành và tạo bản phát hành `ban-duong-v<versionName>` kèm `ban-duong.apk` và `update.json`.

Chuẩn bị một lần:

1. Tạo khoá phát hành và giữ thật kỹ (mất khoá thì các máy đã cài không nhận được bản mới nữa).
2. Vào **Settings → Environments** của kho, tạo Environment tên `ban-duong-release`. Ở **Deployment branches and tags** chọn chỉ nhánh `master` (nên bật thêm **Required reviewers** nếu có nhiều người cùng ghi vào kho). Thêm 4 secret vào chính Environment này (không thêm ở mức kho): `BANDUONG_KEYSTORE_B64` (tệp khoá mã hoá base64), `BANDUONG_KEYSTORE_PASSWORD`, `BANDUONG_KEY_ALIAS`, `BANDUONG_KEY_PASSWORD`.
3. Thêm biến (không bí mật, bắt buộc) `BANDUONG_CERT_SHA256` ở **Settings → Secrets and variables → Actions → Variables**: SHA-256 của chứng chỉ ký, lấy bằng `keytool -list -v -keystore <tệp khoá> -alias <bí danh>` (dòng `SHA256:`). Ký nhầm khoá thì workflow dừng, không phát hành.
4. Bật Actions cho kho, và nên bật bảo vệ nhánh `master` (chỉ gộp qua pull request).

Workflow chỉ phát hành từ `master`; chạy trên nhánh khác (kể cả bấm chạy tay) thì chỉ kiểm thử. Ai có quyền ghi vào `master` và dùng được Environment này là người phát hành được bản cập nhật cho mọi xe. Không bao giờ đưa tệp khoá hay mật khẩu vào kho mã.

## Nghe giọng nói qua loa xe

1. Ghép đôi điện thoại với xe qua Bluetooth, bật cả phần âm thanh (không chỉ gọi điện).
2. Chọn nguồn âm thanh của xe là **Bluetooth** (BT Audio) của điện thoại và tăng âm lượng phương tiện trên điện thoại.
3. Bấm **Đọc thử** trong Cài đặt để kiểm tra.

Khi xe đang ở nguồn FM/radio hoặc USB thì giọng đọc của điện thoại không phát qua loa xe. Chrome trên Android không giành quyền phát âm thanh khi đọc, nên nhạc đang mở có thể đè lên giọng đọc. Nếu chạy ứng dụng ngay trên màn hình Android của xe thì giọng đọc thường phát ra loa xe như các âm thanh khác của màn hình.

## Vì sao không có Android Auto, CarPlay

**Android Auto, CarPlay** chỉ hiển thị ứng dụng gốc (native) thuộc những loại được cho phép, và phải qua kiểm duyệt của Google hoặc Apple (CarPlay còn cần Apple cấp quyền riêng cho ứng dụng dẫn đường). Một ứng dụng web không đưa lên được hai nền tảng này. Cách thay thế: chạy trên màn hình Android của xe như trên, hoặc kẹp điện thoại.

## Camera nhận diện biển (thử nghiệm)

Tính năng này **tắt sẵn** và đang thử nghiệm. Bật trong **Cài đặt → Camera nhận diện biển (thử nghiệm)**, chỉ bật được khi xe đã đỗ.

- **Báo lúc nào**: không bao giờ ở lần đi đầu tiên. Camera ghi nhận biển khi xe đi qua; biển được đọc thành tiếng (khoảng 100–200 m trước, như biển lấy từ bản đồ, kèm lời “camera ghi nhận”) ở những lần đi sau, khi đã được thấy rõ vào ít nhất **2 ngày khác nhau** (3 ngày nếu ngay sau biển có ngã rẽ; một ngày tính từ 4 giờ sáng, nên một chuyến đêm qua nửa đêm vẫn là một ngày), hoặc khi bạn bấm **Đúng** trong danh sách **Biển camera ghi nhận**. Biển nhập từ tệp chỉ hiện, không đọc, cho tới khi chính camera của máy này thấy rõ biển (thường chỉ cần một lần ban ngày) hoặc bạn bấm **Đúng**. Biển chưa xác nhận chỉ hiện, không đọc: trên thanh vàng có viền nét đứt và dòng “Camera mới thấy, chưa xác nhận”, “Camera chưa chắc chắn” hoặc “Biển nhập từ tệp”; trên dải biển chỉ có viền nét đứt. Biển có trên bản đồ OpenStreetMap thì dùng dữ liệu bản đồ. Bản này không học biển tốc độ (xem dưới), nên camera không đổi giới hạn trên đồng hồ tốc độ: giới hạn vẫn lấy từ bản đồ hoặc **Tốc độ tối đa tự đặt**.
- **Vì sao không báo được ngay lần đầu**: biển tròn cỡ thường khoảng 70 cm, ở 150 m chỉ còn vài điểm ảnh trên khung hình camera điện thoại, quá nhỏ để đọc chắc chắn. Theo tính toán (chưa đo trên đường), camera đọc được biển cỡ thường từ khoảng **45 m** khi quay 1920×1080 và khoảng **30 m** khi quay 1280×720 trở lại gần; xoay dọc hoặc độ phân giải thấp hơn thì ngắn hơn. Mục **Kiểm tra camera** hiện con số ước tính cho camera của bạn.
- **Độ chính xác trên đường thật chưa được đo.** Mô hình nhận diện được huấn luyện từ hình biển tự vẽ của ứng dụng ghép lên ảnh đường phố nước ngoài, chưa từng thấy ảnh biển thật ở Việt Nam. Hãy chờ đợi bỏ sót khi trời tối, mưa, ngược nắng, bị xe tải hay xe máy che, biển mờ hoặc cong, và đôi khi nhận nhầm; quy tắc 2 ngày, biển chưa xác nhận không được đọc và nút **Sai** để giảm nhầm lẫn. Kết quả kiểm tra nằm trong [thẻ mô hình](models/MODEL_CARD.md): mọi con số ở đó đo trên ảnh tổng hợp (hình biển tự vẽ trên ảnh nền), nên chỉ là **giới hạn trên**, không phải độ chính xác trên đường. Ví dụ: bộ phân loại đúng 97,4 % trên 6.400 ảnh thử tổng hợp, và mỗi loại biển được học đạt ít nhất 97 % khi gộp các cỡ biển rộng từ 24 điểm ảnh trở lên (xét riêng từng cỡ thì có loại chỉ đạt 95,5–96,5 %).
- **Chỉ 32 loại biển** được học: hết tốc độ tối đa; các biển cấm thường gặp (đường cấm, cấm đi ngược chiều, cấm ô tô, cấm xe máy, cấm rẽ trái hoặc phải, cấm quay đầu, cấm vượt, cấm dừng và đỗ xe, cấm đỗ xe, hạn chế chiều cao); dừng lại; các biển giao nhau (đường giao nhau, giao nhau với đường ưu tiên hoặc không ưu tiên, có tín hiệu đèn, với đường sắt có hoặc không có rào chắn, vòng xuyến); các biển nguy hiểm thường gặp (chỗ ngoặt, nhiều chỗ ngoặt liên tiếp, gồ giảm tốc, người đi bộ cắt ngang, trẻ em, nguy hiểm khác) và hướng phải đi vòng chướng ngại vật. Không đọc biển có chữ, biển phụ, mũi tên chỉ hướng, biển chỉ dẫn, và trị số của biển hạn chế chiều cao.
- **Biển tốc độ chưa được học** (tốc độ tối đa 20–120 km/h). Trên ảnh thử tổng hợp, mô hình còn đọc nhầm trị số quá nhiều (ví dụ chỉ đúng 93,7 % với biển 60 km/h và 93,8 % với biển 80 km/h, dưới ngưỡng 97 %), và đọc nhầm thành trị số **cao hơn** thì có thể làm mất cảnh báo quá tốc độ trên đường bản đồ chưa có giới hạn. Vì vậy bản này gỡ mọi biển tốc độ khỏi danh sách học. Cùng lý do, bốn loại biển chưa qua ngưỡng cũng bị gỡ: cấm xe tải, hạn chế trọng tải, hết tất cả các lệnh cấm và công trường. Danh sách đầy đủ và số đo của từng loại biển nằm trong [thẻ mô hình](models/MODEL_CARD.md). Biển thuộc các loại đã gỡ mà máy đã lưu từ một bản trước vẫn được giữ (có trong tệp xuất và bị xoá khi bấm **Xoá các biển đã học**), nhưng không hiện, không được cảnh báo và không đổi giới hạn trên đồng hồ tốc độ; mục cài đặt ghi rõ số biển đang được giữ như vậy. Điều này cũng đúng khi chưa tải được danh sách biển được học (lúc mới mở ứng dụng, mất mạng, tệp hỏng): các biển thuộc những loại đã gỡ vẫn bị giữ lại như trên, còn các biển camera ghi nhận khác được dùng như thường; ứng dụng tự tải lại danh sách sau ít lâu, khi có mạng lại hoặc khi bạn quay lại ứng dụng.
- **Thiết bị**:

  | Cách lắp | Dùng được không |
  | --- | --- |
  | Điện thoại Android kẹp cố định trên kính hoặc taplô, **camera sau**, Chrome hoặc Samsung Internet, địa chỉ HTTPS, ứng dụng mở trên màn hình, màn hình sáng | Có |
  | Camera USB cắm vào điện thoại hoặc màn hình xe; camera của màn hình xe mở được trong Chrome | Tuỳ máy: chọn camera trong **Kiểm tra camera** khi xe đỗ |
  | Camera có sẵn của hãng xe (camera hành trình, 360°, hỗ trợ lái), Android Auto, CarPlay | Không: trình duyệt không có cách nào truy cập |
  | Camera lùi của màn hình xe | Thường không truy cập được, và lại nhìn ra phía sau |
  | Trình duyệt bên trong Zalo, Facebook; ứng dụng “trình duyệt” dựng sẵn trên màn hình xe | Không |
  | iPhone, iPad (iOS 16.4 trở lên) | Không hứa hẹn: phải bật lại camera bằng tay mỗi lần mở ứng dụng; chưa được thử trên iPhone thật |
  | Ứng dụng bị ẩn, màn hình tắt, ứng dụng khác che lên | Camera không chạy |

  Máy cần hỗ trợ WebAssembly SIMD (Chrome Android 91 trở lên); nếu không, mục cài đặt ghi “Thiết bị này không chạy được tính năng nhận diện biển.”
- **Máy nóng và pin**: tốc độ xử lý, độ nóng và mức hao pin trên điện thoại thật **chưa được đo**. Con số duy nhất đã đo là trên **máy ảo máy tính để bàn** (4 nhân ảo, Chromium không màn hình, một luồng, khung tổng hợp 1920×1080, 200 khung mỗi lần đo, hai lần đo), **không phải số của điện thoại**: mỗi khung mất trung vị 17 ms (p90 18–19 ms, p99 23–30 ms) với một lượt quét và 33–34 ms (p90 36–38 ms, p99 53–54 ms) với hai lượt, trên bản dựng wasm dùng relaxed SIMD (trình duyệt có hỗ trợ thì ứng dụng chọn bản này); bản dựng tương thích chậm hơn: 25 ms (p90 26–28 ms, p99 29–36 ms) và 48–50 ms (p90 52–53 ms, p99 71–75 ms). Trên điện thoại có thể chậm hơn nhiều, nhưng chưa đo; trang `tests/browser/device-bench.html` dùng để đo trên máy thật. Ứng dụng tự giảm số khung hình xử lý mỗi giây (2, 3 hoặc 5), tự tạm dừng khi xe chạy dưới khoảng 11 km/h, khi máy chậm đi vì nóng hoặc khi pin dưới 20 % mà không sạc; điện thoại kẹp trên kính dưới nắng vẫn có thể quá nóng. Lần đầu chạy, ứng dụng tải dữ liệu nhận diện một lần (khoảng 12 MB chưa nén, ít hơn nếu máy chủ nén tệp). Bật camera cũng bật **Giữ màn hình sáng khi lái**, vì camera chỉ chạy khi màn hình sáng.
- **Quyền riêng tư**: mọi xử lý diễn ra trên máy. Hình ảnh từ camera không bao giờ được gửi đi, và không được lưu trừ khi bạn bật **Lưu ảnh biển để kiểm tra độ chính xác** (xem cuối mục này). Danh sách biển đã học (mã biển, vị trí, hướng, số ngày thấy) cho thấy những nơi bạn đã đi, nên được coi là dữ liệu vị trí nhạy cảm: nó chỉ nằm trong bộ nhớ trình duyệt của máy, chỉ được xuất ra tệp khi bạn bấm **Xuất tệp** (kèm lời nhắc trước khi lưu; mặc định không kèm ngày), và xoá được bất cứ lúc nào bằng **Xoá các biển đã học**. Ứng dụng không tự đưa biển lên OpenStreetMap. Tuỳ chọn **Lưu ảnh biển để kiểm tra độ chính xác** (tắt sẵn, trong **Kiểm tra camera**) giữ ảnh nhỏ cắt sát biển trên máy tối đa 30 ngày; ảnh có thể có một phần xe cộ phía sau biển. Ảnh quá 30 ngày bị xoá cả khi đã tắt tuỳ chọn này. Khi còn ảnh đã lưu, mục Cài đặt hiện số ảnh và nút **Xoá ảnh biển đã lưu**, bấm được bất cứ lúc nào; hộp **Xoá các biển đã học** cũng hỏi xoá luôn các ảnh này.
- **Luật**: điện thoại phải được kẹp cố định; không cầm hay bấm điện thoại khi xe đang chạy (Luật Trật tự, an toàn giao thông đường bộ 2024 cấm người lái dùng điện thoại khi xe đang chạy; theo nguồn thứ cấp, mức phạt với người lái ô tô là 4–6 triệu đồng và trừ 4 điểm giấy phép lái xe theo Nghị định 168/2024). Vì vậy bật camera, chọn camera, xem hình, kiểm tra và xem lại danh sách chỉ làm được khi xe đã đỗ (ngoài chế độ lái, đứng yên ít nhất 5 giây và không chạy trong 2 phút vừa qua, để một lần dừng đèn đỏ không được tính là đỗ); ứng dụng không bao giờ tự hỏi quyền camera. Khi đang chạy chỉ có một nút camera nhỏ cạnh các nút bản đồ (xanh: đang bật; màu cam: đang bật nhưng hình bị che, quá tối hoặc quá sáng; xám: tạm dừng; gạch chéo: cần bật lại khi xe đỗ); chạm một lần là tắt.
- **Luôn tuân theo biển báo và hiệu lệnh thực tế trên đường.**

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
| `js/obdnative.js` | Bộ OBD trong ứng dụng Android (WebView không có Web Bluetooth/Web Serial): hộp chọn thiết bị và kết nối Bluetooth do máy làm, trang chỉ gửi lệnh đọc trong danh sách được phép; trên trình duyệt thường không làm gì |
| `js/voice.js` | Giọng đọc và âm báo |
| `js/ios.js` | iPhone, iPad: nhận ra trình duyệt và chế độ mở từ Màn hình chính, gợi ý cài, mục “Trên iPhone” trong Cài đặt |
| `js/compat.js` | Báo rõ khi trình duyệt quá cũ (trước iOS 16.4) thay vì để trang đứng yên |
| `js/search.js` | Tìm địa điểm |
| `js/admin2025.js` | 34 tỉnh, thành sau sắp xếp 2025 và cách đổi địa chỉ có tên tỉnh cũ sang tên mới |
| `js/store.js` | Cài đặt, địa điểm, điểm đánh dấu, nhật ký (lưu trên thiết bị) |
| `js/report.js` | Nút “Báo cáo”: chế độ khi xe chạy, chữ chia sẻ, đường dẫn tạo issue GitHub, tệp “Xuất cho kho dữ liệu” |
| `js/communitydata.js`, `js/community.js` | Dữ liệu cộng đồng: bộ kiểm tra `data/community.json` (dùng chung với công cụ của chủ ứng dụng), tải, chọn bản mới nhất, lưu để dùng khi mất mạng |
| `data/community.json` | Dữ liệu cộng đồng do chủ ứng dụng kiểm tra tại chỗ, xem [Báo cáo và dữ liệu cộng đồng](#báo-cáo-và-dữ-liệu-cộng-đồng) |
| `js/icons.js` | Bộ biểu tượng tự vẽ |
| `js/camctl.js` | Camera nhận diện biển: điều phối camera, bộ nhận diện, bộ học, kho biển đã học |
| `js/camui.js` | Giao diện camera nhận diện biển: mục cài đặt, kiểm tra camera, danh sách biển đã học, xuất và nhập tệp |
| `js/camera.js`, `js/camsched.js` | Mở camera (không tự hỏi quyền), chọn số khung hình xử lý, tạm dừng khi xe chậm, máy nóng hoặc pin yếu |
| `js/vision.js`, `js/vision-worker.js`, `js/visionproto.js`, `js/mlmanifest.js` | Chạy mô hình nhận diện trong worker; kiểm SHA-256 của mọi tệp mô hình trước khi dùng |
| `js/signtrack.js`, `js/signlearn.js`, `js/learnedsigns.js` | Bám biển qua các khung hình, đặt biển lên bản đồ, kho biển đã học (IndexedDB trên máy), xuất và nhập GeoJSON |
| `js/evalcrops.js` | Ảnh biển để kiểm tra độ chính xác (chỉ khi người dùng bật) |
| `js/carbridge.js` | Cầu nối với ứng dụng Android (màn hình Android Auto): gửi tốc độ, giới hạn, cảnh báo, chỉ dẫn rẽ, đoạn tuyến và đường quanh xe, đã kiểm tra và giới hạn theo hợp đồng; trên trình duyệt thường không làm gì |
| `models/` | Mô hình nhận diện đã huấn luyện, danh sách nhãn, [thẻ mô hình](models/MODEL_CARD.md), ghi công ảnh Open Images (`ATTRIBUTION-openimages.csv`) |
| `vendor/litert/` | LiteRT.js 2.6.0 (giấy phép Apache-2.0; bản WebAssembly có XNNPACK, giấy phép BSD; kèm `LICENSE` và `NOTICE-XNNPACK` trong thư mục) |
| `tools/camera/` | Quy trình tạo dữ liệu và huấn luyện mô hình (không chạy trong ứng dụng), xem `tools/camera/README.md` |
| `tools/community/add-reports.mjs` | Công cụ của chủ ứng dụng: gộp báo cáo vào `data/community.json` (không chạy trong ứng dụng) |
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
| Dữ liệu cộng đồng | Tệp tĩnh `data/community.json` của chính ứng dụng (GitHub Pages) | `COMMUNITY_PATH`, `COMMUNITY_REMOTE` trong `js/community.js` |

Bản đồ, đường và điểm cảnh báo là dữ liệu © những người đóng góp cho OpenStreetMap (giấy phép ODbL). Dữ liệu cộng đồng chỉ gồm điểm chủ ứng dụng tự khảo sát, không chép từ nguồn khác.

Mô hình nhận diện biển được huấn luyện từ hình biển tự vẽ của ứng dụng ghép lên ảnh nền đường phố của bộ dữ liệu Open Images V7 (Google; ảnh ghi giấy phép CC BY 2.0, chú thích CC BY 4.0). Không ảnh nào được kèm trong ứng dụng; tác giả và giấy phép của từng ảnh đã dùng được ghi trong `models/ATTRIBUTION-openimages.csv`.

Các máy chủ công cộng trên phù hợp để dùng cá nhân và thử nghiệm. Nếu phát hành cho nhiều người dùng, cần tự dựng máy chủ Valhalla, Photon, Overpass hoặc thuê dịch vụ tương đương rồi đổi các địa chỉ trên, vì máy chủ công cộng giới hạn lưu lượng và không cam kết luôn hoạt động.

## Tỉnh thành sau sắp xếp 2025

Ứng dụng hiển thị địa chỉ theo 34 tỉnh, thành phố trực thuộc Trung ương. Căn cứ là Nghị quyết 202/2025/QH15, chính
quyền mới hoạt động từ 01/7/2025, và ba nghị quyết năm 2026 đưa Đồng Nai, Quảng Ninh, Bắc Ninh lên thành phố trực thuộc
Trung ương. Từ 01/7/2025 không còn cấp huyện: địa phương chỉ còn cấp tỉnh và cấp xã (xã, phường, đặc khu).

- **Kết quả tìm kiếm, điểm nhấn giữ trên bản đồ**: phần cấp tỉnh luôn ghi tên mới. Nếu dữ liệu còn tên tỉnh cũ,
  ứng dụng đổi sang tên mới và ghi thêm gợi ý ngắn, ví dụ “Phường 1, Đồng Tháp · trước đây: Tiền Giang”. Phần có tiền
  tố quận, huyện, thị xã, hoặc “thành phố” thuộc tỉnh cũ thì bỏ. Tên địa điểm và tên xã, phường thì luôn giữ.
- **Nhà, Cơ quan, Tìm gần đây** đã lưu từ trước cũng hiện theo tên tỉnh mới. Phần quận, huyện, thị xã trong các địa
  chỉ này được giữ và có ghi “địa chỉ cũ”, vì phường cũ như “Phường 1” chỉ rõ là nơi nào khi đi cùng quận, ví dụ
  “Phường 1, Quận 3, TP. Hồ Chí Minh · địa chỉ cũ”. Dữ liệu đã lưu không bị sửa.
- **Ranh giới cũ** mà OpenStreetMap còn giữ, ví dụ “Tỉnh Bình Dương”, vẫn tìm và chọn được. Các kết quả này xếp sau
  cùng, có ghi “Ranh giới cũ, nay thuộc TP. Hồ Chí Minh”.
- **Tìm bằng tên tỉnh cũ** vẫn được. Khi gõ “…, Tiền Giang”, ứng dụng tìm theo “…, Đồng Tháp” vì dữ liệu giờ ghi theo
  tỉnh mới. Mỗi lần tìm vẫn chỉ gửi một yêu cầu.
- **Bản đồ nền**: nhãn cấp tỉnh của tỉnh đã bỏ (ví dụ nhãn “Hà Giang” còn sót trong OSM) bị ẩn. Nhãn “Tỉnh Đồng Nai”
  hiện là “Thành phố Đồng Nai”. Tên thành phố, thị trấn cũ như Mỹ Tho, Kon Tum vẫn hiện, vì đó là tên nơi ở chứ không
  phải tên tỉnh. Ứng dụng không tự thêm nhãn hay vẽ ranh giới nào.

Giới hạn:

- Tên xã, phường mới lấy hoàn toàn từ OpenStreetMap. Nơi nào OSM chưa cập nhật thì địa chỉ có thể thiếu xã, phường,
  hoặc còn tên cũ không có tiền tố (ví dụ “Thủ Dầu Một”). Ứng dụng không có bảng xã, phường nên không tự sửa được.
- Đường ranh giới tỉnh trên bản đồ nền vẽ thẳng từ dữ liệu OSM qua OpenFreeMap (bản dựng lại khoảng mỗi tuần).
  Kiểm tra ngày 27/11/2026: bản dựng hiện tại đã theo ranh giới mới ở các ô đã xem, ví dụ không còn đường ranh Bình
  Dương với TP. Hồ Chí Minh cũ. Ở mức thu nhỏ, OpenFreeMap không hiện tên tỉnh nào của Việt Nam.
- Địa chỉ đã lưu chỉ nhận ra tỉnh khi tên tỉnh đứng cuối chuỗi, như cách ứng dụng vẫn ghép địa chỉ.

## Giới hạn cần biết

- **Độ phủ dữ liệu**: giới hạn tốc độ, biển báo và vị trí camera do cộng đồng OpenStreetMap nhập, ở Việt Nam còn thiếu nhiều nơi: cả nước chỉ có 46 camera bắn tốc độ trên bản đồ, và ở Hoàn Kiếm chỉ 1–18 % chiều dài đường (ngoài quốc lộ) có ghi giới hạn tốc độ (số đo và nguồn ở [Báo trước biển báo](#báo-trước-biển-báo)). **Không có cảnh báo camera không có nghĩa là không có camera.** Đoạn đường chưa có dữ liệu thì ứng dụng không hiện biển giới hạn (không tự suy đoán); hãy dùng mục **Tốc độ tối đa tự đặt** và tự đánh dấu camera trên tuyến hay đi bằng nút **Báo cáo**.
- **Xe máy**: tuyến xe máy tính bằng hồ sơ xe hai bánh của Valhalla nên không đi vào đường cao tốc. Nếu Valhalla không phản hồi, ứng dụng chuyển sang OSRM (chỉ có hồ sơ ô tô) và ghi rõ trên màn hình rằng tuyến có thể đi qua cao tốc.
- **Không có tình trạng giao thông trực tiếp** (kẹt xe theo thời gian thực) vì không có nguồn dữ liệu mở.
- **Điểm tự đánh dấu chỉ nằm trên thiết bị**. Không có máy chủ chung: báo cáo chỉ tới người khác khi chủ ứng dụng đã đi xem tại chỗ và thêm vào dữ liệu cộng đồng, nên có độ trễ và không đầy đủ.
- **Ứng dụng web không chạy nền**: phải để ứng dụng mở trên màn hình thì mới có định vị và cảnh báo. Ứng dụng đã tự giữ màn hình sáng khi lái (trên iPhone xem [Cài trên iPhone](#cài-trên-iphone)).
- **Chưa có bản đồ ngoại tuyến đầy đủ**: chỉ các vùng bản đồ đã xem được lưu lại; tìm đường và tìm địa điểm cần có mạng.

Biển báo và hiệu lệnh thực tế trên đường luôn là căn cứ để tuân theo.

## Quyền riêng tư

Ứng dụng không có máy chủ riêng và không thu thập dữ liệu. Vị trí chỉ được gửi tới các dịch vụ bản đồ ở bảng trên để tìm đường, tìm địa điểm và tải dữ liệu quanh vị trí hiện tại. Cài đặt, địa điểm đã lưu, điểm đánh dấu và nhật ký chuyến đi nằm trong bộ nhớ trình duyệt của thiết bị.

Báo cáo chỉ rời máy khi bạn bấm **Chia sẻ hoặc chép**, **Gửi qua GitHub** hoặc **Xuất cho kho dữ liệu**, và nội dung chỉ gồm ngày, toạ độ (khoảng 1 m) và hướng xe chạy, không có giờ phút. Issue GitHub là công khai, gắn với tài khoản GitHub của người gửi và hiện giờ tạo issue, nên gửi ngay tại chỗ là cho biết bạn ở đâu lúc nào. Ứng dụng Android tải tệp dữ liệu cộng đồng từ github.io lúc mở và mỗi 6 giờ; lượt tải không kèm vị trí hay cookie, nhưng GitHub thấy địa chỉ IP của máy. Tắt **Dùng dữ liệu cộng đồng** thì không tải nữa.

Camera nhận diện biển xử lý hình ảnh ngay trên máy và không gửi hình ảnh đi đâu; hình ảnh chỉ được lưu (ảnh nhỏ cắt sát biển, tối đa 30 ngày, chỉ trên máy) khi bạn bật **Lưu ảnh biển để kiểm tra độ chính xác**. Biển đã học chỉ nằm trên máy, chỉ được xuất ra tệp khi bạn yêu cầu, và xoá được bất cứ lúc nào (xem [Camera nhận diện biển](#camera-nhận-diện-biển-thử-nghiệm)).

Dữ liệu đọc từ xe qua bộ OBD (tốc độ, vòng tua, nhiệt độ, nhiên liệu, điện áp, mã lỗi) chỉ dùng trên máy, không gửi đi đâu và không được lưu lại. Ứng dụng chỉ gửi tới bộ đọc các lệnh trong một danh sách cố định; không đọc số khung (VIN) và không có lệnh xoá mã lỗi.
