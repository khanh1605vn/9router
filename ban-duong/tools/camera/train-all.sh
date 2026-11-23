#!/usr/bin/env bash
# Chạy toàn bộ quy trình dữ liệu tổng hợp → huấn luyện → hiệu chỉnh → xuất → đánh giá → cài, theo thứ tự.
#
#   BANDUONG_CACHE=~/.cache/ban-duong-train nohup tools/camera/train-all.sh > train-all.out 2>&1 &
#
# Mỗi bước ghi dấu xong vào $BANDUONG_CACHE/done/<bước> và bị bỏ qua khi chạy lại; nhật ký từng bước ở
# $BANDUONG_CACHE/logs/<bước>.log. Bị dừng (SIGTERM, Ctrl-C, SIGHUP) thì bước đang chạy được dừng theo (xem
# steps.sh); chạy lại đúng lệnh này: các bước vẽ dữ liệu làm tiếp từ phân đoạn còn thiếu, hai bước huấn luyện làm
# tiếp từ điểm khôi phục. Không cần TTY. `kill -9` script này thì dừng cả nhóm tiến trình: kill -9 -- -<pgid>.
#
# Mọi đầu ra ghi vào thư mục chờ $BANDUONG_CACHE/models-staging; models/ của ứng dụng chỉ bị đổi ở bước cuối
# "install" (install-models.mjs): chép cả bộ, cập nhật js/mlmanifest.js, chạy toàn bộ `node --test tests/*.test.mjs`
# và trả models/ về như cũ nếu có bài kiểm thử hỏng.
# Kích thước lấy từ biến môi trường BD_* (mặc định là lần chạy đầy đủ, xem tools/camera/README.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
CACHE="${BANDUONG_CACHE:-$HOME/.cache/ban-duong-train}"
STAGE="$CACHE/models-staging"          # mọi đầu ra của các bước; models/ chỉ đổi ở bước install
OUT="${BD_MODELS_OUT:-$APP/models}"    # nơi cài bộ mô hình; lần chạy thử đặt ra ngoài ứng dụng

# Kích thước mặc định của lần chạy đầy đủ (máy 4 vCPU, không GPU; thời gian đo được ghi trong README).
BD_BG_COUNT="${BD_BG_COUNT:-8000}"             # ảnh nền Open Images
BD_PER_CLASS="${BD_PER_CLASS:-600}"            # ảnh cắt huấn luyện mỗi nhãn
BD_TIER_A="${BD_TIER_A:-1200}"                 # ảnh cắt huấn luyện mỗi nhãn được học
BD_VAL_PER_CLASS="${BD_VAL_PER_CLASS:-60}"     # ảnh cắt kiểm định mỗi nhãn (cũng dùng để hiệu chỉnh T)
BD_TEST_PER_CLASS="${BD_TEST_PER_CLASS:-40}"   # ảnh cắt kiểm tra mỗi nhãn (cạnh ngẫu nhiên)
BD_TESTW_PER_CLASS="${BD_TESTW_PER_CLASS:-25}" # ảnh cắt kiểm tra mỗi nhãn khác và mỗi cạnh 20/24/32/48
BD_TESTW_TIER_A="${BD_TESTW_TIER_A:-200}"      # như trên cho nhãn được học (ngưỡng E1 cần ≥ 100 ảnh mỗi cạnh)
BD_SCENES="${BD_SCENES:-12000}"                # ảnh ghép huấn luyện bộ dò
BD_VAL_SCENES="${BD_VAL_SCENES:-600}"
BD_EVAL_SCENES="${BD_EVAL_SCENES:-500}"        # mỗi kiểu hình học A và B
BD_GOLDEN_SCENES="${BD_GOLDEN_SCENES:-8}"      # ảnh ghép nền thủ tục cho cặp vào/ra mẫu
BD_CLS_EPOCHS="${BD_CLS_EPOCHS:-36}"           # khoảng 1,7 giờ ở 780 ảnh/s
BD_DET_EPOCHS="${BD_DET_EPOCHS:-30}"           # khoảng 3,9 giờ ở 26 ảnh/s
BD_DET_BATCH="${BD_DET_BATCH:-16}"
BD_PROCS="${BD_PROCS:-4}"                      # số trang Chrome vẽ song song
BD_PRUNE="${BD_PRUNE:-1}"                      # 1: gỡ khỏi danh sách học các nhãn không qua ngưỡng E1
BD_PRUNE_MAX="${BD_PRUNE_MAX:-5}"              # không qua nhiều hơn chừng này nhãn thì dừng cho người xem
BD_INSTALL_TESTS="${BD_INSTALL_TESTS:-1}"      # 1: bước install chạy bộ kiểm thử và trả lại nếu hỏng
BD_SEED_BG="${BD_SEED_BG:-1}"
BD_SEED_CROPS="${BD_SEED_CROPS:-1}"
BD_SEED_SCENES="${BD_SEED_SCENES:-2}"
BD_SEED_CLS="${BD_SEED_CLS:-1}"
BD_SEED_DET="${BD_SEED_DET:-2}"

PY="$CACHE/venv/bin/python"
mkdir -p "$CACHE/done" "$CACHE/logs" "$CACHE/run" "$STAGE"
exec 9>"$CACHE/train-all.lock"
if ! flock -n 9; then
  echo "train-all.sh đang chạy với cùng $CACHE (tiến trình giữ khoá: $(fuser "$CACHE/train-all.lock" 2>/dev/null | xargs echo))" >&2
  echo "dừng nó bằng: kill -TERM <pid của train-all.sh>, hoặc nếu chỉ còn tiến trình con mồ côi: kill -TERM <các pid trên>" >&2
  exit 1
fi

# shellcheck source=steps.sh
source "$HERE/steps.sh"

venv() {
  [ -x "$PY" ] || python3 -m venv "$CACHE/venv"
  "$PY" -m pip install --no-input --disable-pip-version-check --require-hashes --only-binary :all: \
    -r "$HERE/requirements.txt"
  "$PY" -I -c "import tensorflow as tf, PIL, numpy; print(tf.__version__, PIL.__version__, numpy.__version__)"
}

crops() { node "$HERE/render-crops.mjs" --out "$CACHE/crops" --bg "$CACHE/bg" --procs "$BD_PROCS" --seed "$BD_SEED_CROPS" --labels "$STAGE/labels.json" "$@"; }
scenes() { node "$HERE/render-scenes.mjs" --out "$CACHE/scenes" --bg "$CACHE/bg" --procs "$BD_PROCS" --seed "$BD_SEED_SCENES" "$@"; }

note "train-all: cache $CACHE, thư mục chờ $STAGE, cài vào $OUT"
step venv venv
step selftest "$PY" -I -B -m unittest discover -s "$HERE" -p 'test_*.py' -v
step labels node "$HERE/labels.mjs" --out "$STAGE/labels.json"
step backgrounds node "$HERE/fetch-backgrounds.mjs" --out "$CACHE/bg" --count "$BD_BG_COUNT" --python "$PY" --seed "$BD_SEED_BG"
step crops-train crops --split train --per-class "$BD_PER_CLASS" --tier-a "$BD_TIER_A"
step crops-val crops --split val --per-class "$BD_VAL_PER_CLASS" --tier-a "$BD_VAL_PER_CLASS"
step crops-test crops --split test --per-class "$BD_TEST_PER_CLASS" --tier-a "$BD_TEST_PER_CLASS"
step crops-testw crops --split test --per-class "$BD_TESTW_PER_CLASS" --tier-a "$BD_TESTW_TIER_A" --widths 20,24,32,48
# cặp vào/ra mẫu (models/golden/): chỉ nền vẽ thủ tục, không ảnh Open Images nào
step crops-golden crops --split test --name golden --bg '' --per-class 1 --tier-a 1
step scenes-train scenes --split train --count "$BD_SCENES"
step scenes-val scenes --split val --count "$BD_VAL_SCENES"
step scenes-evalA scenes --split test --count "$BD_EVAL_SCENES" --eval-widths 8,10,12,16,20 --geo A
step scenes-evalB scenes --split test --count "$BD_EVAL_SCENES" --eval-widths 8,10,12,16,20 --geo B
step scenes-golden scenes --split test --name golden --bg '' --count "$BD_GOLDEN_SCENES"
step train-cls "$PY" -I "$HERE/train_classifier.py" --data "$CACHE/crops" --out "$CACHE/run/cls" \
  --labels "$STAGE/labels.json" --epochs "$BD_CLS_EPOCHS" --seed "$BD_SEED_CLS"
step train-det "$PY" -I "$HERE/train_detector.py" --data "$CACHE/scenes" --out "$CACHE/run/det" \
  --epochs "$BD_DET_EPOCHS" --batch "$BD_DET_BATCH" --seed "$BD_SEED_DET" --resume
step calibrate "$PY" -I "$HERE/calibrate.py" --runs "$CACHE/run" --crops "$CACHE/crops" --labels "$STAGE/labels.json"
step export "$PY" -I "$HERE/export.py" --runs "$CACHE/run" --crops "$CACHE/crops" --scenes "$CACHE/scenes" \
  --bg "$CACHE/bg" --out "$STAGE"
PRUNE_FLAG=()
[ "$BD_PRUNE" = "1" ] && PRUNE_FLAG=(--prune --prune-max "$BD_PRUNE_MAX")
# tên bước gồm BD_PRUNE: đổi BD_PRUNE thì bước đánh giá chạy lại (cờ learn được đặt lại theo lần này)
step "eval-p$BD_PRUNE" "$PY" -I "$HERE/eval_synthetic.py" --models "$STAGE" --crops "$CACHE/crops" \
  --scenes "$CACHE/scenes" --runs "$CACHE/run" --bg "$CACHE/bg" --out "$STAGE/MODEL_CARD.md" "${PRUNE_FLAG[@]}"
rm -f "$CACHE/done/eval-p$((1 - BD_PRUNE))" "$CACHE/done/sums"
always sums "$PY" -I "$HERE/export.py" --out "$STAGE" --sums-only
INSTALL_FLAG=()
[ "$BD_INSTALL_TESTS" = "1" ] || INSTALL_FLAG=(--no-tests)
always install node "$HERE/install-models.mjs" --from "$STAGE" --to "$OUT" "${INSTALL_FLAG[@]}"
note "train-all: xong; mô hình ở $OUT (bản chờ ở $STAGE)"
