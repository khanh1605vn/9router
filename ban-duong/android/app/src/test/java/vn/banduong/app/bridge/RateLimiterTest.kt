package vn.banduong.app.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RateLimiterTest {
    private var now = 0L
    private val clock = { now }

    @Test
    fun allowsBurstThenBlocks() {
        val r = RateLimiter(4.0, clockNanos = clock)
        repeat(4) { assertTrue(r.tryAcquire()) }
        assertFalse(r.tryAcquire())
    }

    @Test
    fun refillsOverTime() {
        val r = RateLimiter(4.0, clockNanos = clock)
        repeat(4) { r.tryAcquire() }
        now += 250_000_000L // 0,25 s → thêm 1 lượt
        assertTrue(r.tryAcquire())
        assertFalse(r.tryAcquire())
    }

    @Test
    fun sustainedRateIsBounded() {
        val r = RateLimiter(4.0, clockNanos = clock)
        var ok = 0
        // 100 thông điệp mỗi giây trong 10 giây.
        repeat(1000) {
            if (r.tryAcquire()) ok++
            now += 10_000_000L
        }
        assertTrue("ok=$ok", ok in 40..45)
    }

    @Test
    fun clockGoingBackwardsDoesNotGrantTokens() {
        val r = RateLimiter(4.0, clockNanos = clock)
        repeat(4) { r.tryAcquire() }
        now -= 5_000_000_000L
        assertFalse(r.tryAcquire())
        assertEquals(false, r.tryAcquire())
    }
}
