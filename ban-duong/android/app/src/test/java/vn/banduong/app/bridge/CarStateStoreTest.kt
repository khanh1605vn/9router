package vn.banduong.app.bridge

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.bridge.CarStateStore.Freshness

@RunWith(RobolectricTestRunner::class)
class CarStateStoreTest {
    private val state = CarState(
        ts = 1L, speedKmh = 30.0, speedSource = null, limitKmh = null, overSpeed = false, position = null,
        alerts = emptyList(), maneuver = null, route = emptyList(), nearbyRoads = emptyList(),
        camera = CarState.CameraStatus.OFF, obd = CarState.ObdStatus.OFF,
    )

    @Before
    fun setUp() = CarStateStore.resetForTest()

    @After
    fun tearDown() = CarStateStore.resetForTest()

    @Test
    fun freshnessBoundaries() {
        assertEquals(Freshness.NONE, CarStateStore.snapshot.freshness(0))
        CarStateStore.update(state, 10_000)
        val s = CarStateStore.snapshot
        assertEquals(Freshness.FRESH, s.freshness(10_000))
        assertEquals(Freshness.FRESH, s.freshness(10_000 + CarStateStore.STALE_MS))
        assertEquals(Freshness.STALE, s.freshness(10_000 + CarStateStore.STALE_MS + 1))
        assertEquals(Freshness.STALE, s.freshness(10_000 + 3_600_000))
        assertEquals(10_000 + CarStateStore.STALE_MS + 1, s.staleAtUptimeMs)
        assertEquals(Freshness.STALE, s.freshness(s.staleAtUptimeMs))
        assertEquals(5_000L, CarStateStore.STALE_MS)
    }

    @Test
    fun clearReturnsToNoneAndListenersSeeEveryChange() {
        val seen = ArrayList<CarStateStore.Snapshot>()
        val l = CarStateStore.Listener { seen += it }
        CarStateStore.addListener(l)
        CarStateStore.update(state, 1_000)
        CarStateStore.clear(2_000)
        assertEquals(2, seen.size)
        assertSame(state, seen[0].state)
        assertNull(seen[1].state)
        assertEquals(Freshness.NONE, CarStateStore.snapshot.freshness(2_000))
        CarStateStore.removeListener(l)
        CarStateStore.update(state, 3_000)
        assertEquals(2, seen.size)
    }

    @Test
    fun carSessionListenerOnlyFiresOnTransitions() {
        val seen = ArrayList<Boolean>()
        CarStateStore.addCarSessionListener { seen += it }
        assertFalse(CarStateStore.isCarSessionActive)
        CarStateStore.carSessionStarted()
        CarStateStore.carSessionStarted()
        assertTrue(CarStateStore.isCarSessionActive)
        CarStateStore.carSessionEnded()
        assertTrue(CarStateStore.isCarSessionActive)
        CarStateStore.carSessionEnded()
        CarStateStore.carSessionEnded() // thừa: không xuống dưới 0
        assertFalse(CarStateStore.isCarSessionActive)
        assertEquals(listOf(true, false), seen)
        CarStateStore.carSessionStarted()
        assertEquals(listOf(true, false, true), seen)
    }

    private val fixAt = 1_764_000_000_000L
    private fun withPosition(ageAtSendMs: Long) = state.copy(
        ts = fixAt + ageAtSendMs,
        position = CarState.Position(10.7769, 106.7009, 90.0, 5.0, fixTs = fixAt),
        limitKmh = 60,
        alerts = listOf(CarState.Alert(CarState.AlertKind.CAMERA, "speed_camera", "Camera", 200, CarState.AlertSource.OSM)),
    )
    private fun fix(at: Long, speed: Double? = 45.0) = CarStateStore.NativeFix(10.78, 106.70, 180.0, 4.0, speed, at)

    /** Trang vẫn gửi đều nhưng vị trí đứng yên (trang bị ẩn, WebView thôi nhận định vị): coi là cũ sau 10 giây. */
    @Test
    fun positionThatStopsAdvancingBecomesStale() {
        // Lúc gửi, vị trí đã 8 giây tuổi: 2 giây sau (trước mốc 5 giây của STALE_MS) là cũ.
        CarStateStore.update(withPosition(ageAtSendMs = 8_000), 50_000)
        val s = CarStateStore.snapshot
        assertEquals(Freshness.FRESH, s.freshness(50_000))
        assertEquals(Freshness.FRESH, s.freshness(52_000))
        assertEquals(Freshness.STALE, s.freshness(52_001))
        assertEquals(52_001L, s.nextCheckAt(50_000))
        assertEquals(55_001L, s.nextCheckAt(52_001))
        // Không có fixTs (trang cũ): chỉ theo thời điểm nhận như trước.
        CarStateStore.update(state.copy(position = CarState.Position(10.0, 106.0, null, null)), 50_000)
        assertEquals(Freshness.FRESH, CarStateStore.snapshot.freshness(55_000))
        assertEquals(55_001L, CarStateStore.snapshot.nextCheckAt(50_000))
    }

    /** Trang cũ/không có, nhưng máy tự có định vị: chế độ chỉ có GPS, không giới hạn, không cảnh báo. */
    @Test
    fun nativeFixGivesGpsOnlyViewWhenPageDataIsOldOrMissing() {
        val none = CarStateStore.snapshot.copy(fix = fix(at = 1_000))
        val v0 = none.view(2_000)
        assertTrue(v0.gpsOnly)
        assertEquals(Freshness.FRESH, v0.freshness)
        assertEquals(45.0, v0.state!!.speedKmh!!, 0.0)
        assertEquals(CarState.SpeedSource.GPS, v0.state!!.speedSource)
        assertNull(v0.state!!.limitKmh)
        assertTrue(v0.state!!.alerts.isEmpty())
        // Định vị của máy cũng cũ: về NONE.
        assertEquals(Freshness.NONE, none.view(1_000 + CarStateStore.FIX_STALE_MS + 1).freshness)
        assertEquals(1_000 + CarStateStore.FIX_STALE_MS + 1, none.nextCheckAt(2_000))

        CarStateStore.update(withPosition(ageAtSendMs = 0), 10_000)
        CarStateStore.updateNativeFix(fix(at = 10_500))
        val s = CarStateStore.snapshot
        // Dữ liệu trang còn mới: dùng trang (có giới hạn, cảnh báo).
        assertFalse(s.view(11_000).gpsOnly)
        assertEquals(60, s.view(11_000).state!!.limitKmh)
        // Trang cũ, định vị máy còn mới: chỉ có GPS, giữ tuyến/đường làm nền.
        CarStateStore.updateNativeFix(fix(at = 16_000))
        val v = CarStateStore.snapshot.view(16_500)
        assertTrue(v.gpsOnly)
        assertEquals(10.78, v.state!!.position!!.lat, 0.0)
        assertNull(v.state!!.maneuver)
        // Cả hai cũ: STALE như trước.
        assertEquals(Freshness.STALE, CarStateStore.snapshot.view(30_000).freshness)
        assertFalse(CarStateStore.snapshot.view(30_000).gpsOnly)
        // Trang nạp lại (clear) không xoá định vị của máy; phiên xe đóng thì xoá.
        CarStateStore.clear(16_600)
        assertTrue(CarStateStore.snapshot.view(16_700).gpsOnly)
        CarStateStore.updateNativeFix(null)
        assertEquals(Freshness.NONE, CarStateStore.snapshot.view(16_700).freshness)
    }

    /**
     * Trong hầm: GPS mất (fixTs đứng yên), bộ OBD vẫn báo tốc độ và trang vẫn gửi "state" mỗi giây. Tốc độ, giới hạn,
     * cảnh báo của trang vẫn dùng được (đúng như trên điện thoại), chỉ vị trí là cũ. Tốc độ GPS thì vẫn coi là cũ.
     */
    @Test
    fun tunnelWithObdSpeedStaysFreshAndOnlyPositionIsOld() {
        val obd = withPosition(ageAtSendMs = 0).copy(speedKmh = 78.0, speedSource = CarState.SpeedSource.OBD, overSpeed = true)
        for (sec in listOf(0, 5, 10, 11, 15, 30, 60)) {
            val now = 100_000L + sec * 1000L
            CarStateStore.update(obd.copy(ts = fixAt + sec * 1000L), now)
            val v = CarStateStore.snapshot.view(now)
            assertEquals("t=${sec}s", Freshness.FRESH, v.freshness)
            assertFalse(v.gpsOnly)
            assertEquals(78.0, v.state!!.speedKmh!!, 0.0)
            assertEquals(60, v.state!!.limitKmh)
            assertEquals(1, v.state!!.alerts.size)
            assertEquals("t=${sec}s", sec > 10, v.positionStale)
        }
        // Trang thôi gửi: vẫn cũ sau STALE_MS như mọi khi.
        assertEquals(Freshness.STALE, CarStateStore.snapshot.view(160_000 + CarStateStore.STALE_MS + 1).freshness)
        // Máy có định vị riêng còn mới: dùng vị trí đó, giữ tốc độ OBD và giới hạn của trang.
        CarStateStore.updateNativeFix(fix(at = 160_000))
        val v = CarStateStore.snapshot.view(160_500)
        assertEquals(Freshness.FRESH, v.freshness)
        assertFalse(v.gpsOnly)
        assertFalse(v.positionStale)
        assertEquals(10.78, v.state!!.position!!.lat, 0.0)
        assertEquals(78.0, v.state!!.speedKmh!!, 0.0)
        assertEquals(60, v.state!!.limitKmh)
        // Cùng hoàn cảnh mà tốc độ là GPS (cũng đã cũ): STALE (hoặc chỉ có GPS của máy), không dùng tốc độ của trang.
        CarStateStore.updateNativeFix(null)
        CarStateStore.update(obd.copy(ts = fixAt + 30_000, speedSource = CarState.SpeedSource.GPS), 200_000)
        assertEquals(Freshness.STALE, CarStateStore.snapshot.view(200_000).freshness)
        // OBD nhưng không có số tốc độ: cũng STALE.
        CarStateStore.update(obd.copy(ts = fixAt + 30_000, speedKmh = null), 200_000)
        assertEquals(Freshness.STALE, CarStateStore.snapshot.view(200_000).freshness)
    }
}
