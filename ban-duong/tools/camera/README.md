# Huấn luyện mô hình nhận diện biển báo (tools/camera)

Bộ công cụ tạo dữ liệu tổng hợp, huấn luyện, hiệu chỉnh, xuất và đánh giá hai mô hình nhỏ mà tính năng
"Camera nhận diện biển (thử nghiệm)" dùng trên điện thoại:

| Tệp trong `models/` | Là gì |
|---|---|
| `labels.json` | 181 nhãn (169 mã của `SIGN_CATALOGUE`, P.127 tách thành 11 lớp trị số 20–120, `other-sign`, `background`), họ hình dạng, cờ `learn` (47 nhãn được học), cờ `junction`, nhiệt độ `T`, nguồn gốc bản dựng |
| `sign-det.int8.tflite` | Bộ dò: vào float32 [1,352,640,3] RGB 0–1; ra `heat` [1,44,80,11] (đã sigmoid) và `reg` [1,44,80,4] = [log_w, log_h, off_x, off_y] |
| `sign-cls.int8.tflite` | Bộ phân loại: vào float32 [1,48,48,3] (khung + lề 15 % mỗi phía); ra logit [1,181] (chưa softmax) |
| `golden/` | Cặp vào/ra mẫu để kiểm tra lúc chạy (`index.json` mô tả); ảnh vào chỉ có nền vẽ thủ tục |
| `MODEL_CARD.md` | Dữ liệu, giấy phép, phiên bản, số đo trên dữ liệu tổng hợp |
| `ATTRIBUTION-openimages.csv` | Ghi công từng ảnh nền Open Images đã dùng khi huấn luyện (ảnh không nằm trong `models/`) |
| `SHA256SUMS` | Mã băm của mọi tệp trên |

Mọi thứ nặng (môi trường Python, ảnh tải về, dữ liệu đã vẽ, điểm khôi phục) nằm ngoài ứng dụng, trong
`$BANDUONG_CACHE` (mặc định `~/.cache/ban-duong-train`). Ứng dụng vẫn không cần bước dựng và không thêm gói
nào vào `package.json`.

**Số đo trong `MODEL_CARD.md` là giới hạn trên trên dữ liệu tổng hợp, không phải độ chính xác trên đường thật.**

## Yêu cầu

- Linux x86_64, 4 vCPU trở lên, khoảng 15 GB đĩa trống cho `$BANDUONG_CACHE`, không cần GPU.
- Node ≥ 22; Playwright 1.63 cài toàn cục (`require('playwright')` chạy được; đổi bằng `PLAYWRIGHT_MODULE`)
  và Chrome ở `/usr/bin/google-chrome` (đổi bằng `CHROME_PATH`; không có thì dùng Chromium của Playwright).
- Python 3.13 (wheel ghim cho CPython 3.11–3.13, Linux x86_64).
- Mạng tới `pypi.org`/`files.pythonhosted.org`, `storage.googleapis.com` (CSV Open Images) và
  `open-images-dataset.s3.amazonaws.com` (ảnh).

Phiên bản ghim trong `requirements.txt` (kèm mã băm SHA-256 lấy từ JSON API của PyPI, cài bằng
`pip install --require-hashes --only-binary :all:`): tensorflow-cpu 2.21.0, keras 3.15.1, numpy 2.5.5,
pillow 13.0.0 và các gói phụ thuộc. Sinh lại bằng `node tools/camera/pin-requirements.mjs --python <python>`.

## Chạy toàn bộ

```bash
cd ban-duong
export BANDUONG_CACHE=~/.cache/ban-duong-train
nohup tools/camera/train-all.sh > "$BANDUONG_CACHE.out" 2>&1 &
```

`train-all.sh` chạy lần lượt các bước dưới đây, ghi dấu xong vào `$BANDUONG_CACHE/done/<bước>` và nhật ký vào
`$BANDUONG_CACHE/logs/<bước>.log` (tóm tắt ở `logs/train-all.log`). Bị dừng thì chạy lại đúng lệnh đó: bước đã
xong được bỏ qua, bước vẽ dữ liệu làm tiếp từ phân đoạn còn thiếu, hai bước huấn luyện làm tiếp từ điểm khôi phục
(bộ phân loại: cuối mỗi epoch; bộ dò: mỗi 20 phút và cuối mỗi epoch). Một khoá `flock` chặn hai lần chạy cùng một
cache. Không cần TTY.

Dừng giữa chừng: `kill -TERM <pid của train-all.sh>` (hoặc Ctrl-C, SIGHUP). Script chuyển tín hiệu cho bước đang
chạy và mọi tiến trình con của nó (node, Chrome, python), chờ chúng lưu và thoát (tối đa `STOP_WAIT_S` = 300 s,
rồi SIGKILL), nhả khoá rồi thoát với mã 143 (`steps.sh`). `kill -9` thì script không kịp làm gì: khi đó dừng cả
nhóm tiến trình, `kill -9 -- -<pgid>` (`ps -o pgid= -p <pid>`). Nếu chạy lại báo "đang chạy", thông báo in các PID
còn giữ khoá.

**Mọi đầu ra ghi vào thư mục chờ `$BANDUONG_CACHE/models-staging`**; `models/` của ứng dụng không bị đụng tới
cho tới bước cuối `install` (`install-models.mjs`): kiểm thư mục chờ (đủ tệp, khớp `SHA256SUMS`, không tệp lạ,
cặp mẫu nền thủ tục), chép cả bộ vào `models/`, chạy `write-manifest.mjs` (cập nhật `js/mlmanifest.js`) rồi
**toàn bộ `node --test tests/*.test.mjs`**. Có bài hỏng thì `models/` và `js/mlmanifest.js` được trả về như cũ
và bước báo lỗi (bộ mới vẫn ở thư mục chờ; `--no-rollback` để giữ lại mà xem). Đặt `BD_MODELS_OUT=<thư mục>` để
cài ra chỗ khác (lần chạy thử; khi đó không cập nhật mlmanifest và không chạy kiểm thử).

### Kích thước và thời gian

Biến môi trường (mặc định = lần chạy đầy đủ):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BD_BG_COUNT` | 8000 | ảnh nền Open Images |
| `BD_PER_CLASS` / `BD_TIER_A` | 600 / 1200 | ảnh cắt huấn luyện mỗi nhãn / mỗi nhãn được học |
| `BD_VAL_PER_CLASS` | 60 | ảnh cắt kiểm định mỗi nhãn (cũng để tìm T) |
| `BD_TEST_PER_CLASS` | 40 | ảnh cắt kiểm tra mỗi nhãn, cạnh ngẫu nhiên |
| `BD_TESTW_PER_CLASS` / `BD_TESTW_TIER_A` | 25 / 200 | ảnh cắt kiểm tra mỗi nhãn khác / mỗi nhãn được học, ở mỗi cạnh 20/24/32/48 điểm ảnh (ngưỡng E1 cần ≥ 100) |
| `BD_SCENES` / `BD_VAL_SCENES` | 12000 / 600 | ảnh ghép huấn luyện / kiểm định bộ dò |
| `BD_EVAL_SCENES` | 500 | ảnh ghép đánh giá cho mỗi kiểu hình học A và B |
| `BD_GOLDEN_SCENES` | 8 | ảnh ghép nền thủ tục để chọn cặp vào/ra mẫu |
| `BD_CLS_EPOCHS` / `BD_DET_EPOCHS` | 36 / 30 | số epoch |
| `BD_DET_BATCH` | 16 | lô của bộ dò |
| `BD_PROCS` | 4 | số trang Chrome vẽ song song |
| `BD_PRUNE` | 1 | gỡ cờ `learn` của nhãn không qua ngưỡng E1 (đổi giá trị thì bước đánh giá chạy lại và đặt lại cờ) |
| `BD_PRUNE_MAX` | 5 | hơn chừng này nhãn không qua thì bước đánh giá dừng (mã 4) thay vì gỡ âm thầm |
| `BD_INSTALL_TESTS` | 1 | 0: bước install không chạy bộ kiểm thử |
| `BD_MODELS_OUT` | `models/` | nơi cài bộ mô hình |
| `BD_SEED_*` | 1/2 | hạt giống từng bước (BG, CROPS, SCENES, CLS, DET) |

Tốc độ đo trong lần chạy thử trên máy ảo 4 vCPU (Xeon, không GPU), và thời gian ước tính của lần chạy đầy đủ:

| Bước | Tốc độ đo được | Lần chạy đầy đủ (ước tính) |
|---|---|---|
| Môi trường Python | 80 s, 1,5 GB | 1–2 phút |
| Ảnh nền | khoảng 30 ảnh/s cả tải lẫn làm sạch (96 ảnh, 28 MB trong 3 s) | 8.000 ảnh, khoảng 2,4 GB: 5–10 phút |
| Ảnh cắt | khoảng 85 ảnh/s (4 trang Chrome; biển tới 400 điểm ảnh làm chậm khoảng 40 %: lần chạy thử đo 56 ảnh/s với 2 trang, trước đó 97) | khoảng 189.000 ảnh (có 48.900 ảnh testw, 200 mỗi cạnh cho nhãn được học): 35–40 phút |
| Ảnh ghép | 16 ảnh/s (4 trang; 30 % kiểu B); ảnh đánh giá kiểu B khoảng 7 ảnh/s | 13.600 ảnh: 15 phút |
| Bộ phân loại | 780 ảnh/s (lô 128) | 36 epoch × khoảng 124.000 ảnh: 1,7 giờ (dừng sớm thì ngắn hơn) |
| Bộ dò | 26 ảnh/s (lô 16, ô 320×320) | 30 epoch × 12.000 ảnh: 3,9 giờ |
| Hiệu chỉnh, xuất, đánh giá | | khoảng 5 phút |
| **Tổng** | | **khoảng 6,8 giờ**, 6–7 GB đĩa, dưới 4 GB RAM |

Các con số là ước tính từ lần đo ngắn; máy đang bận việc khác thì chậm hơn.

## Từng bước

```bash
P=$BANDUONG_CACHE/venv/bin/python
C=$BANDUONG_CACHE; S=$C/models-staging; mkdir -p $S
python3 -m venv $C/venv
$P -m pip install --require-hashes --only-binary :all: -r tools/camera/requirements.txt
$P -I -B -m unittest discover -s tools/camera -p 'test_*.py' -v   # kiểm thử Python (cần node)
node tools/camera/labels.mjs --out $S/labels.json   # T = 1, learn = 47 nhãn của WHITELIST
node tools/camera/fetch-backgrounds.mjs --out $C/bg --count 8000 --python $P
R="node tools/camera/render-crops.mjs --out $C/crops --bg $C/bg --labels $S/labels.json"
$R --split train --per-class 600 --tier-a 1200
$R --split val --per-class 60 --tier-a 60
$R --split test --per-class 40 --tier-a 40
$R --split test --per-class 25 --tier-a 200 --widths 20,24,32,48
$R --split test --name golden --bg '' --per-class 1 --tier-a 1      # cặp mẫu: chỉ nền vẽ thủ tục
Q="node tools/camera/render-scenes.mjs --out $C/scenes --bg $C/bg"
$Q --split train --count 12000
$Q --split val --count 600
$Q --split test --count 500 --eval-widths 8,10,12,16,20 --geo A
$Q --split test --count 500 --eval-widths 8,10,12,16,20 --geo B
$Q --split test --name golden --bg '' --count 8
$P -I tools/camera/train_classifier.py --data $C/crops --out $C/run/cls --labels $S/labels.json --epochs 36
$P -I tools/camera/train_detector.py --data $C/scenes --out $C/run/det --epochs 30 --resume
$P -I tools/camera/calibrate.py --runs $C/run --crops $C/crops --labels $S/labels.json
$P -I tools/camera/export.py --runs $C/run --crops $C/crops --scenes $C/scenes --bg $C/bg --out $S
$P -I tools/camera/eval_synthetic.py --models $S --crops $C/crops --scenes $C/scenes --runs $C/run --bg $C/bg --out $S/MODEL_CARD.md --prune
$P -I tools/camera/export.py --out $S --sums-only
node tools/camera/install-models.mjs --from $S          # → models/, js/mlmanifest.js, toàn bộ kiểm thử
```

`export.py` từ chối `--out models/`: chỉ `install-models.mjs` ghi vào `models/`. Dữ liệu huấn luyện (kế hoạch vẽ,
số ảnh mỗi nhãn) chỉ lấy danh sách nhãn từ labels.json, không lấy cờ `learn`, nên dùng labels.json nào (kể cả bản
trong `models/` đã bị gỡ nhãn) cũng cho cùng dữ liệu.

| Tệp | Làm gì |
|---|---|
| `lib.mjs` | Hằng số và hàm dùng chung: 11 họ, danh sách 47 nhãn được học, nhãn gắn nút giao, `buildLabels`, kế hoạch vẽ từng nhãn (`trainingPlan`), chia tập theo tác giả, tình trạng biển của ảnh nền, bộ sinh số có hạt giống, bộ đọc CSV, nguồn gốc bản dựng (`provenance`, `artDigest`) |
| `labels.mjs` | Sinh `labels.json` từ `SIGN_CATALOGUE`; lỗi nếu mã được học không có trong danh mục; `--provenance` in nguồn gốc bản dựng |
| `fetch-backgrounds.mjs` + `sanitize_images.py` | Tải ảnh nền Open Images (xem dưới) |
| `synth-art.mjs` | SVG tự vẽ: "other-sign", biển phụ, vật gây nhiễu, mặt sau biển |
| `render-page.js` | Mã chạy trong Chrome: biến đổi, vẽ ảnh cắt và ảnh ghép |
| `render-common.mjs` | Mở Chrome, mỗi tiến trình vẽ một ngữ cảnh riêng, chặn mọi mạng trừ gốc giả `render.local` |
| `render-crops.mjs` | Dữ liệu bộ phân loại |
| `render-scenes.mjs` | Dữ liệu bộ dò |
| `bdcommon.py` | Kiến trúc hai mô hình, đích CenterNet, giải mã, hiệu chỉnh, đọc dữ liệu |
| `train_classifier.py`, `train_detector.py`, `calibrate.py`, `export.py`, `eval_synthetic.py` | Các bước Python (luôn chạy với `python -I`) |
| `train-all.sh`, `steps.sh` | Chạy tất cả, làm tiếp được, dừng gọn khi nhận tín hiệu |
| `install-models.mjs` | Cài bộ mô hình từ thư mục chờ vào `models/`, cập nhật mlmanifest, chạy kiểm thử, trả lại nếu hỏng |
| `test_pipeline.py` | Kiểm thử Python (đích, giải mã khớp `js/visionproto.js`, hiệu chỉnh, ngưỡng E1, định dạng số, bước lượng tử) |
| `pin-requirements.mjs` | Sinh lại `requirements.txt` có mã băm |
| `label-crops.html` | Trang ngoại tuyến gắn nhãn ảnh biển thật xuất từ ứng dụng (đánh giá E2) |

## Dữ liệu

### Ảnh nền (`$BANDUONG_CACHE/bg`)

- Đọc CSV nhỏ của tập validation và test của Open Images V7 (ảnh `*-images-with-rotation.csv`, hộp
  `*-annotations-bbox.csv`, lớp `oidv7-class-descriptions-boxable.csv`), không cần tệp hộp 2,26 GB của tập train.
- Ứng viên: ảnh có hộp Car, Bus, Truck, Motorcycle, Traffic light, Traffic sign hoặc Street light (không tính hộp
  "depiction"), cột `License` đúng bằng `https://creativecommons.org/licenses/by/2.0/`, không cần xoay. Khoảng
  21.600 ảnh.
- **Biển thật trong ảnh nền**: Open Images chỉ vẽ đủ hộp "Traffic sign" cho ảnh mà người kiểm đã xác nhận có biển.
  Nhãn mức ảnh do người kiểm (`*-annotations-human-imagelabels-boxable.csv`, 10,6 MB và 32 MB) cho tình trạng
  của từng ảnh (`status` trong index.json): `present` (xác nhận có biển và có hộp; theo quy trình thì hộp đủ, nhưng
  khi xem vẫn thấy biển sót hộp), `absent` (xác nhận không có biển: ảnh sạch), `unverified` (chưa ai kiểm: có thể
  có biển không có hộp). Chỉ khoảng 160 trong 21.600
  ứng viên đã được kiểm; chúng được lấy trước, rồi tới ảnh giống cảnh đường phố nhất (có đèn/biển/cột đèn, nhiều
  xe, xe không chiếm quá nửa ảnh), cùng điểm thì theo mã băm có hạt giống. Hộp "Traffic sign" và "Stop sign" (lớp
  con) đều thành vùng bỏ qua. Trên mọi ảnh trừ `absent`, lỗi âm của bộ dò chỉ tính `NEG_W_UNVERIFIED` = 0,25 phần
  (trừ quanh vật tự vẽ, `bdcommon.make_targets`); mảng nền của ảnh cắt tránh các hộp biển có sẵn (`render-page.js`
  `CROP_VIEW`, `BG_IGNORE_PAD`). **Giới hạn còn lại**: biển thật không có hộp trên ảnh không sạch vẫn có thể bị dạy
  một phần thành nền, và vài ảnh cắt "background" có thể chứa biển thật; điều này làm giảm khả năng thấy biển, không
  làm tăng nhận nhầm (ghi trong MODEL_CARD.md). Tập train của Open Images chỉ thêm được khoảng 500 ảnh đường phố đã
  xác nhận không có biển, với 1 GB CSV; chưa dùng.
- Ảnh trên S3 có cạnh dài 1024; chỉ giữ ảnh ngang rộng ≥ 1024 (ảnh rộng hơn 1280 bị thu nhỏ).
- Tải song song có giới hạn (8 luồng, thử lại 3 lần, tối đa 10 MB mỗi ảnh). **Ảnh tải về là dữ liệu không tin
  cậy**: nằm trong `dl-raw/` riêng; kiểm tra byte đầu JPEG; `sanitize_images.py` chạy bằng `python -I`, giải mã
  bằng Pillow (giới hạn 40 triệu điểm ảnh), bỏ ảnh lỗi, ghi lại thành JPEG mới không EXIF/ICC vào
  `train/`, `val/`, `test/`; ảnh gốc bị xoá ngay. Không chạy hay nạp mã nào từ dữ liệu tải về.
- Chia theo tác giả Flickr (băm của `Author`, không có thì của ImageID; 80/10/10): loạt ảnh của một người (cùng
  phố, cùng buổi) không nằm ở cả tập huấn luyện lẫn tập kiểm tra.
- Ảnh được giữ và ghi theo thứ tự ứng viên, không theo thứ tự tải xong; các bước vẽ còn xếp ảnh nền theo ImageID
  (`backgroundsFor`), nên hai lần chạy từ đầu với cùng hạt giống cho cùng dữ liệu.
- `index.json`: `{ version, images: [{ id, split, w, h, status, ignore: [[x0, y0, x1, y1]] }] }` — `ignore` là các
  hộp biển có sẵn (tỉ lệ 0–1), thành vùng bỏ qua khi huấn luyện bộ dò.
- `attribution.csv`: `ImageID, Title, Author, AuthorProfileURL, License, OriginalURL, OriginalLandingURL, Changes`
  (`Changes` ghi rằng ảnh đã bị cắt, đổi cỡ, chỉnh màu, ghép biển tổng hợp và chỉ dùng để huấn luyện, theo CC BY 2.0
  §4(b)); được chép thành `models/ATTRIBUTION-openimages.csv`.
- `state.json` và `candidates.json` (có `version`; phiên bản cũ thì chọn lại) giúp chạy lại làm tiếp.

### Ảnh cắt cho bộ phân loại (`$BANDUONG_CACHE/crops`)

- Mỗi phân đoạn 2.000 ảnh: `<tên>-<i>.u8` là N×48×48×3 byte RGB liền nhau; `<tên>-<i>.json` là
  `{ n, labels: [chỉ số nhãn], w: [cạnh khung biển thật], night: [0/1], photo: [0/1] }` (tập `testw` có thêm
  `req`: cạnh yêu cầu). `<tên>.done` ghi số ảnh, thời gian và tốc độ khi đủ mọi phân đoạn. Tập `golden` (ảnh cắt
  cho cặp mẫu) vẽ với `--bg ''`, mọi `photo` = 0.
- Hạt giống từng ảnh = băm(hạt gốc + độ lệch của tập, tên tập, nhãn, số thứ tự): chạy lại cho đúng ảnh cũ, ba
  tập dùng dãy hạt và ảnh nền tách rời.
- Cách vẽ: biển của ứng dụng (`signSvg()`), cạnh thật 14–400 điểm ảnh (tối đa 5 % dưới 18 điểm ảnh, 58 % số còn
  lại trong 18–48; tới 400 như `CLS_MAX_W` lúc chạy), vẽ siêu lấy mẫu rồi thu về cạnh thật; phối cảnh (nghiêng ngang ±40°, dọc, xoay), mòn (phai
  màu, bụi, tem dán, loá, bóng), cột, che khuất (lá, cành, cột, dây, xe), ban đêm, ngược sáng, ám màu, mờ, nhoè
  chuyển động, nhiễu, nén JPEG nhẹ ở một nửa số ảnh (khung hình camera vốn không bị nén); rồi cắt theo khung lệch ±15 % kích thước và ±10 % vị trí cộng lề 15 % mỗi phía,
  thu về 48×48 bằng nội suy ngẫu nhiên (low/medium/high của canvas).
- P.127[n] luôn in đúng số n; biển có số khác (tải trọng, chiều cao, chiều ngang, chiều dài, cự ly, tốc độ khác)
  in một trị số hợp lý ngẫu nhiên.
- **Nhãn trùng hình**: một số mã dùng chung một hình vẽ trong `signart.js` (cùng dòng trong `signs.js`). Nhãn có
  hình giống hệt nhãn khác không có ảnh riêng; ảnh thuộc về nhãn gốc (ưu tiên nhãn được học): P.127a/b/c → các lớp
  P.127[n]; DP.127 → DP.134; P.111c, P.111d → P.111b; W.203b/c → W.203a; W.215b/c → W.215a; W.216b → W.216a;
  W.242b → W.242a; W.245b → W.245a; W.246b/c → W.246a; R.308b → R.308a; R.310b/c → R.310a; R.412, R.415a/b →
  R.403; I.405b/c → I.405a; IE.453b/c → IE.453a. Ba cặp trái/phải được vẽ bằng hình lật gương: W.201d (của
  W.201c), W.202b (của W.202a), W.223b (của W.223a). Chiều thật của các cặp này chưa đối chiếu với QCVN; hai mã
  của mỗi cặp có cùng tên và câu đọc nên nhầm chiều không đổi lời cảnh báo. P.106b luôn có số tấn trên xe (chỗ
  khác duy nhất với P.106a).
- `other-sign`: biển tự sinh ngoài danh mục (vòng đỏ có số không thuộc P.127 hoặc chữ/ký hiệu lạ, đĩa xanh có
  ký hiệu lạ, bảng chỉ đường/tên đường, hình thoi vàng viền đen, tam giác có ký hiệu lạ, ngũ giác, bát giác xanh,
  biển tốc độ chữ nhật kiểu nước ngoài) và biển phụ. Ký hiệu gần giống một mã trong danh mục không được dùng trên
  nền tương ứng (`GLYPH_AVOID` trong `synth-art.mjs`): tam giác không có chữ thập (≈ W.205), móc (≈ W.201a/b), gấp
  khúc (≈ W.202a/b), vòng (≈ W.206); vòng đỏ không có móc (≈ mũi tên của P.123*, P.124*); đĩa xanh không có móc
  (≈ R.302a/b) và vòng (≈ R.303). Không dùng ảnh biển Open Images (biển châu Âu giống biển ta).
- `background`: mảng ảnh nền thuần (45 %) và vật gây nhiễu: cột sọc đỏ trắng, thùng vàng đen, biển hiệu cửa hàng
  có chữ tiếng Việt, mảng màu đỏ/xanh/vàng, mặt sau biển.
- Số ảnh: `--per-class` mỗi nhãn, `--tier-a` mỗi nhãn được học, ×4 cho `background`, ×2 cho `other-sign`.

### Ảnh ghép cho bộ dò (`$BANDUONG_CACHE/scenes`)

- `img/<tên>-<phân đoạn>-<số>.jpg` (640×352, JPEG 92) và `<tên>-<phân đoạn>.json` =
  `[{ f, geo, frame, boxes: [[x, y, w, h, họ]], ignore: [[x, y, w, h]], synth: [[x, y, w, h]], bg, bgClean }]`
  (điểm ảnh của ảnh vào; họ là chỉ số trong `families` của labels.json; `synth` là mọi vật tự vẽ; `bg` là ImageID
  của ảnh nền hoặc null; `bgClean` = nền thủ tục hoặc ảnh `absent`). Phân đoạn 200 ảnh. Tập đánh giá tên
  `test-evalA`, `test-evalB` và có thêm `evalWidth`; tập `golden` (cặp mẫu) chỉ có nền thủ tục.
- 1–6 cột biển mỗi ảnh (cạnh 8–120 điểm ảnh ở lượt A, 8–64 ở lượt B), 20 % cột có 2–3 biển xếp dọc, 18 % có biển
  phụ (họ `plate`) bên dưới, 12 % biển là `other-sign` (gắn họ theo hình, hình lạ thì không gắn nhãn), họ được chọn
  cân bằng; 0–4 vật gây nhiễu không gắn nhãn; ban đêm, vệt mưa, che khuất, mờ, nhiễu, JPEG.
- Hình học A (70 %): ảnh vào là ô cắt 640×352 đúng độ phân giải camera. Hình học B (30 %): cả khung hình camera
  (`FRAMES_B`: 1920×1080 65 %, 1280×720 20 %, dọc 1080×1920 10 %, 1440×1080 5 %) vẽ ở độ phân giải thật (nhiễu,
  mờ, JPEG ở đó) rồi thu nhỏ giữ tỉ lệ và thêm viền đen đúng như `passGeometry('B')` của `js/visionproto.js`
  (1920×1080 → 626×352 với viền 7 điểm ảnh mỗi bên; 1080×1920 → 198×352).
- Hộp "Traffic sign"/"Stop sign" của Open Images và biển bị mép ảnh cắt quá 40 % thành vùng bỏ qua (không tính lỗi
  heat); trên nền không sạch, lỗi âm ngoài vùng vật tự vẽ chỉ tính `NEG_W_UNVERIFIED` phần (xem Ảnh nền).

### Huấn luyện (`$BANDUONG_CACHE/run`)

- `cls/`: `state.json`, `last.weights.h5`, `optimizer.npz` (làm tiếp), `best.weights.h5`, `history.json`.
  CNN 4 tầng (32-64-128-192, BN, ReLU, max-pool) + GAP + dropout + Dense 181, khoảng 351 nghìn tham số,
  khởi tạo ngẫu nhiên; AdamW, tốc độ học khởi động 1 epoch rồi giảm theo cosin; trọng số mẫu cân bằng lớp
  (`background`/`other-sign` ×1,5); tăng cường bằng phép ngẫu nhiên không trạng thái (sáng, tương phản, bão hoà,
  sắc độ, dịch ±2 điểm ảnh); dừng sớm sau 6 epoch không tăng độ chính xác kiểm định; op determinism bật.
- `det/`: MobileNetV2 α 0,35 của `keras.applications` với `weights=None` (không có trọng số ImageNet; momentum của
  BatchNorm hạ từ 0,999 xuống 0,99 để trung bình trượt bám kịp khi huấn luyện từ đầu), cổ FPN
  gọn (bước 32/16/8 → một đầu ra bước 8), đầu CenterNet: heat 11 họ (focal loss giảm phạt, bỏ qua vùng bỏ qua),
  log cạnh bị chặn trong [log 4, log 400] và độ lệch tâm (sigmoid), L1 tại ô tâm. Học trên ô cắt 320×320 (phóng
  0,85–1,2, lật ngang vì mọi họ đều đối xứng), xuất ở 352×640 (cùng trọng số, mạng tích chập hoàn toàn).
- `calib.json`: T và ECE trước/sau trên tập kiểm định; `eval.json`: số đo E1.

### Ngưỡng E1 (`eval_synthetic.py`)

Mỗi nhãn được học được vẽ 200 ảnh ở mỗi cạnh 20/24/32/48 điểm ảnh (tập `testw`). Nhãn qua ngưỡng khi, gộp các cạnh
≥ 24 điểm ảnh (600 ảnh), top-1 ≥ 97 %, và không cạnh nào thấp hơn 97 % rõ rệt (cận trên Wilson một phía 95 % của
cạnh đó < 97 %, tức dưới 191/200). Với 25 ảnh mỗi cạnh như trước, một ảnh sai đã là 96 %, nên nhãn đúng thật
98 % chỉ qua khoảng 22 % số lần; với quy tắc này nhãn đúng 98 % qua khoảng 95 %, nhãn đúng 95 % khoảng 1 %. Ít hơn
`GATE_MIN_N` = 100 ảnh mỗi cạnh thì không được gỡ nhãn (mã thoát 2); hơn `BD_PRUNE_MAX` nhãn không qua thì không
gỡ gì và dừng (mã 4) để người xem `MODEL_CARD.md`. Gỡ nhãn chỉ phụ thuộc lần đánh giá này: chạy lại với
`BD_PRUNE=0` trả lại cờ `learn`.

## Tái lập `models/`

1. Dùng cùng commit, Python 3.13, `requirements.txt` có mã băm và Chrome cùng phiên bản (cách vẽ canvas và bộ mã
   JPEG có thể khác giữa các phiên bản Chrome). `labels.json` ghi `build.provenance`: commit, `gitDirty` (có thay
   đổi chưa commit trong thư mục ứng dụng) và danh sách tệp đổi, SHA-256 của các tệp quyết định dữ liệu
   (`TRAINING_SOURCES` trong lib.mjs: js/signart.js, js/signs.js, mã của tools/camera) và `artDigest` (dấu của hình
   vẽ biển). `tests/models.test.mjs` báo lỗi khi `artDigest` không còn khớp hình vẽ hiện tại (mô hình đã cũ).
2. Xoá hoặc đổi `$BANDUONG_CACHE`, chạy `tools/camera/train-all.sh` với biến mặc định.
3. So `models/MODEL_CARD.md` với bản trong kho: số đo phải gần bằng (trong biên độ nhiễu). Trọng số không giống
   hệt từng bit giữa các CPU khác nhau. Ảnh nền được chọn và ghi theo thứ tự cố định (không theo thứ tự tải xong)
   nhưng nếu một ảnh trên S3 biến mất thì ảnh kế tiếp được lấy thay.

## Chạy thử nhỏ

```bash
env BANDUONG_CACHE=~/.cache/ban-duong-train-smoke BD_MODELS_OUT=~/.cache/ban-duong-train-smoke/models-out \
  BD_BG_COUNT=60 BD_PER_CLASS=20 BD_TIER_A=20 BD_VAL_PER_CLASS=6 BD_TEST_PER_CLASS=4 BD_TESTW_PER_CLASS=3 \
  BD_TESTW_TIER_A=3 BD_SCENES=200 BD_VAL_SCENES=40 BD_EVAL_SCENES=40 BD_CLS_EPOCHS=1 BD_DET_EPOCHS=1 \
  BD_PRUNE=0 tools/camera/train-all.sh
```

Lần chạy thử này mất khoảng 4 phút (đã có sẵn môi trường Python) và ra hai tệp `.tflite` đúng kích thước của
hợp đồng, `golden/`, `SHA256SUMS` và `MODEL_CARD.md` trong `models-out/` (số đo vô nghĩa vì chỉ 1 epoch). Với
`BD_PRUNE=1` bước đánh giá dừng với mã 2 vì 3 ảnh mỗi cạnh quá ít để gỡ nhãn; `models/` không bị đụng tới.

## Gắn nhãn ảnh thật (E2)

`npm start` rồi mở `http://localhost:5173/tools/camera/label-crops.html`. Chọn tệp JSON xuất từ mục "Lưu ảnh
biển để kiểm tra độ chính xác" của ứng dụng (dạng tệp ghi ở đầu trang), bấm phím để gắn nhãn, "Lưu kết quả" tải
về tệp nhãn. Trang không gửi gì ra ngoài.
