package vn.banduong.app.update

/**
 * Xe có đang chạy không, để bộ cập nhật không mở hộp thoại cài (và không khởi động lại ứng dụng) lúc đang lái.
 *
 * Mặc định là "đang chạy" (an toàn): chỉ coi là đứng yên khi có bằng chứng. Giống QuietGate của trang (js/appupdate.js):
 *  - có tốc độ còn mới (trong [recentMs]): dưới [movingKmh] là đứng yên, từ đó trở lên là đang chạy;
 *  - không có tốc độ mới (trang ít gửi "state" khi không chiếu lên xe, trong hầm, mất GPS): chỉ coi là đứng yên nếu đã
 *    từng thấy một tốc độ thật dưới ngưỡng và lần cuối thấy xe chạy (hoặc lúc tạo, tức lúc mở ứng dụng) đã quá [holdMs];
 *  - chưa từng có tốc độ nào (mở máy lúc xe đang lăn bánh, GPS chưa bắt được): luôn là đang chạy.
 * Mọi thời điểm theo cùng một đồng hồ đơn điệu (SystemClock.uptimeMillis ở bản thật).
 */
class MotionGuard(
    createdAtMs: Long,
    private val movingKmh: Double = MOVING_KMH,
    private val recentMs: Long = RECENT_MS,
    private val holdMs: Long = UNKNOWN_HOLD_MS,
) {
    private var lastSpeed: Double? = null
    private var lastSpeedAt = 0L
    private var movedAt = createdAtMs
    private var seenStill = false

    /** Một tốc độ đo được lúc [atMs] (null hoặc không hữu hạn: bỏ qua). Bản cũ hơn lần đã có thì không đè lên. */
    @Synchronized
    fun observe(speedKmh: Double?, atMs: Long) {
        if (speedKmh == null || !speedKmh.isFinite() || speedKmh < 0) return
        if (lastSpeed != null && atMs < lastSpeedAt) return
        lastSpeed = speedKmh
        lastSpeedAt = atMs
        if (speedKmh >= movingKmh) movedAt = maxOf(movedAt, atMs) else seenStill = true
    }

    @Synchronized
    fun isMoving(nowMs: Long): Boolean {
        val s = lastSpeed
        if (s != null && nowMs - lastSpeedAt in 0..recentMs) return s >= movingKmh
        return !(seenStill && nowMs - movedAt >= holdMs)
    }

    companion object {
        /** Bằng ngưỡng của trang (QUIET.movingKmh). */
        const val MOVING_KMH = 8.0

        /** Trang gửi "state" ít nhất mỗi 5 giây khi có thay đổi; quá chừng này thì tốc độ coi như đã cũ. */
        const val RECENT_MS = 15_000L

        /** Bằng QUIET.unknownHoldMs của trang. */
        const val UNKNOWN_HOLD_MS = 120_000L
    }
}
