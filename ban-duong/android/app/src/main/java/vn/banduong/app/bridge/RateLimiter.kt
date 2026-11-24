package vn.banduong.app.bridge

/**
 * Xô token đơn giản: tối đa [ratePerSec] lần mỗi giây, dồn được tối đa [burst] lần.
 * Thông điệp vượt giới hạn bị bỏ (không xếp hàng), nên trang web không thể làm nghẽn luồng chính.
 */
class RateLimiter(
    private val ratePerSec: Double,
    private val burst: Double = ratePerSec,
    private val clockNanos: () -> Long = System::nanoTime,
) {
    private var tokens = burst
    private var last = clockNanos()

    /** Lấy [cost] token (mặc định 1, ví dụ số ký tự khi giới hạn lưu lượng). Không đủ thì không lấy gì. */
    @Synchronized
    fun tryAcquire(cost: Double = 1.0): Boolean {
        val now = clockNanos()
        val elapsed = (now - last).coerceAtLeast(0L) / 1e9
        last = now
        tokens = minOf(burst, tokens + elapsed * ratePerSec)
        if (tokens >= cost) {
            tokens -= cost
            return true
        }
        return false
    }
}
