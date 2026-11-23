# Khung chạy từng bước cho train-all.sh (được `source`, không chạy riêng). Cần biến CACHE (thư mục làm việc).
#
# step <tên> <lệnh…>: bỏ qua nếu đã có $CACHE/done/<tên>; không thì chạy lệnh ở nền với nhật ký
# $CACHE/logs/<tên>.log, chờ nó xong rồi ghi dấu xong. Khi train-all.sh nhận SIGTERM, SIGINT hay SIGHUP, bước đang
# chạy và mọi tiến trình con của nó (node, Chrome, python) được gửi SIGTERM — hai bước huấn luyện lưu điểm khôi
# phục rồi thoát — và được chờ tối đa STOP_WAIT_S giây (rồi SIGKILL), nên không tiến trình nào còn chạy mồ côi giữ
# khoá. `kill -9` train-all.sh thì không bắt được: khi đó dừng cả nhóm tiến trình (`kill -- -<pgid>`).

STOP_WAIT_S="${STOP_WAIT_S:-300}" # giây chờ bước đang chạy tự dừng (bộ phân loại chỉ lưu ở cuối epoch, ≤ 3 phút)
STEP_CHILD=""

note() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$CACHE/logs/train-all.log" >&2; }

# PID của mọi tiến trình con cháu của $1 (không gồm $1).
descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    echo "$c"
    descendants "$c"
  done
}

# Tiến trình $1 còn chạy (tiến trình đã thoát nhưng chưa được chờ, trạng thái Z, coi như đã dừng).
is_alive() {
  local st
  st="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [ -n "$st" ] && [ "${st#Z}" = "$st" ]
}

# Dừng bước đang chạy: SIGTERM cho cả cây tiến trình, chờ tối đa STOP_WAIT_S giây, rồi SIGKILL những gì còn lại.
stop_step() {
  [ -n "$STEP_CHILD" ] || return 0
  local pids p alive t=0
  pids="$STEP_CHILD $(descendants "$STEP_CHILD")"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  while [ "$t" -lt "$STOP_WAIT_S" ]; do
    alive=0
    for p in $pids; do
      if is_alive "$p"; then alive=1; fi
    done
    if [ "$alive" = 0 ]; then break; fi
    sleep 1
    t=$((t + 1))
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  wait "$STEP_CHILD" 2>/dev/null || true
  STEP_CHILD=""
}

on_signal() {
  note "nhận tín hiệu $1: dừng bước đang chạy; chạy lại đúng lệnh để làm tiếp"
  stop_step
  exit 143
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP

step() {
  local name="$1" rc t0
  shift
  if [ -f "$CACHE/done/$name" ]; then
    note "bỏ qua $name (đã xong)"
    return 0
  fi
  note "bắt đầu $name"
  t0=$SECONDS
  "$@" >>"$CACHE/logs/$name.log" 2>&1 &
  STEP_CHILD=$!
  rc=0
  wait "$STEP_CHILD" || rc=$?
  STEP_CHILD=""
  if [ "$rc" -ne 0 ]; then
    note "Lỗi ở $name (mã $rc) — xem $CACHE/logs/$name.log; chạy lại để làm tiếp"
    exit 1
  fi
  echo "$((SECONDS - t0))" >"$CACHE/done/$name"
  note "xong $name sau $((SECONDS - t0)) s"
}

# Như step nhưng luôn chạy (không ghi dấu xong): cho bước rẻ phải làm lại mỗi lần (cài mô hình).
always() {
  local name="$1" rc
  shift
  note "bắt đầu $name"
  "$@" >>"$CACHE/logs/$name.log" 2>&1 &
  STEP_CHILD=$!
  rc=0
  wait "$STEP_CHILD" || rc=$?
  STEP_CHILD=""
  if [ "$rc" -ne 0 ]; then
    note "Lỗi ở $name (mã $rc) — xem $CACHE/logs/$name.log"
    exit 1
  fi
  note "xong $name"
}
