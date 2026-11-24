package vn.banduong.app.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MotionGuardTest {
    private val hold = MotionGuard.UNKNOWN_HOLD_MS
    private val recent = MotionGuard.RECENT_MS

    @Test
    fun noSpeedEverMeansMoving() {
        // Mở máy lúc xe đang lăn bánh, GPS chưa bắt được: không bao giờ coi là đứng yên.
        val g = MotionGuard(createdAtMs = 1_000)
        assertTrue(g.isMoving(1_000))
        assertTrue(g.isMoving(1_000 + 24 * 3600_000L))
        g.observe(null, 5_000)
        g.observe(Double.NaN, 5_000)
        g.observe(-1.0, 5_000)
        assertTrue(g.isMoving(10_000))
    }

    @Test
    fun freshSpeedDecides() {
        val g = MotionGuard(createdAtMs = 0)
        g.observe(0.0, 1_000)
        assertFalse(g.isMoving(1_000))
        assertFalse(g.isMoving(1_000 + recent))
        g.observe(7.9, 2_000)
        assertFalse(g.isMoving(2_000))
        g.observe(8.0, 3_000)
        assertTrue(g.isMoving(3_000))
        g.observe(0.0, 4_000)
        assertFalse(g.isMoving(4_000))
        // Tin cũ tới muộn không đè tin mới.
        g.observe(60.0, 3_500)
        assertFalse(g.isMoving(4_100))
    }

    @Test
    fun staleSpeedNeedsAStopAndTwoMinutesWithoutMovement() {
        val g = MotionGuard(createdAtMs = 0)
        g.observe(50.0, 10_000)
        g.observe(0.0, 20_000)
        assertFalse(g.isMoving(20_000))
        // Tốc độ thôi tới (trang ít gửi, mất GPS trong hầm): mới thấy xe chạy cách đây chưa đủ lâu → coi là đang chạy.
        assertTrue(g.isMoving(20_000 + recent + 1))
        assertTrue(g.isMoving(10_000 + hold - 1))
        assertFalse(g.isMoving(10_000 + hold))
        // Mất tốc độ ngay khi đang chạy: chạy.
        g.observe(40.0, 200_000)
        assertTrue(g.isMoving(200_000 + recent + 1))
        assertTrue(g.isMoving(200_000 + hold - 1))
        // Lâu rồi không thấy xe chạy (đỗ trong hầm, đã từng thấy đứng yên): đứng yên.
        assertFalse(g.isMoving(200_000 + hold))
    }

    @Test
    fun theStartCountsAsMovement() {
        // Có tốc độ đứng yên ngay lúc mở rồi mất: vẫn phải đủ hold kể từ lúc mở.
        val g = MotionGuard(createdAtMs = 100_000)
        g.observe(0.0, 101_000)
        assertTrue(g.isMoving(101_000 + recent + 1))
        assertFalse(g.isMoving(100_000 + hold))
    }
}
