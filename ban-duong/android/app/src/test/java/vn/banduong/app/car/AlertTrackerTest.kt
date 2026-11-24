package vn.banduong.app.car

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import vn.banduong.app.bridge.CarState

class AlertTrackerTest {
    private fun alert(text: String, d: Int, kind: CarState.AlertKind = CarState.AlertKind.CAMERA, code: String? = null) =
        CarState.Alert(kind, code, text, d, CarState.AlertSource.OSM)

    @Test
    fun sameAlertApproachingIsShownOnce() {
        val t = AlertTracker()
        assertEquals("Phía trước 300 mét có camera", t.pick(listOf(alert("Phía trước 300 mét có camera", 300)), 0)?.text)
        assertNull(t.pick(listOf(alert("Phía trước 250 mét có camera", 250)), 500))
        assertNull(t.pick(listOf(alert("Phía trước 100 mét có camera", 100)), 10_000))
    }

    @Test
    fun differentAlertIsNewButRespectsMinimumGap() {
        val t = AlertTracker(minGapMs = 4_000)
        val cam = alert("Camera phạt nguội", 300)
        val toll = alert("Trạm thu phí", 800, CarState.AlertKind.TOLL)
        assertEquals(cam, t.pick(listOf(cam), 0))
        // Mới nhưng chưa đủ 4 giây: chưa báo, vẫn giữ là "mới".
        assertNull(t.pick(listOf(cam, toll), 1_000))
        assertEquals(toll, t.pick(listOf(cam, toll), 4_000))
        assertNull(t.pick(listOf(cam, toll), 9_000))
    }

    @Test
    fun nearestNewAlertWinsAndAllCurrentAreMarked() {
        val t = AlertTracker()
        val a = alert("Biển P.127", 120, CarState.AlertKind.SIGN, "P.127")
        val b = alert("Đường sắt", 400, CarState.AlertKind.RAIL)
        assertEquals(a, t.pick(listOf(a, b), 0))
        assertNull(t.pick(listOf(a, b), 10_000))
    }

    @Test
    fun forgottenAfterWindowAndCodeDistinguishes() {
        val t = AlertTracker(forgetAfterMs = 60_000)
        val a = alert("Biển hạn chế tốc độ", 200, CarState.AlertKind.SIGN, "P.127")
        assertEquals(a, t.pick(listOf(a), 0))
        assertNull(t.pick(listOf(a), 30_000))
        assertNull(t.pick(emptyList(), 85_000))
        assertEquals(a, t.pick(listOf(a), 91_000))
        val other = a.copy(code = "P.127a")
        assertEquals(other, t.pick(listOf(other), 100_000))
    }

    @Test
    fun keyIgnoresDistanceAndCaseButKeepsOtherNumbers() {
        assertEquals(
            AlertTracker.key(alert("Còn 300 m tới CAMERA", 300)),
            AlertTracker.key(alert("Còn 50 m tới camera", 50)),
        )
        assertEquals(
            AlertTracker.key(alert("Camera sau 1,2 km", 1200)),
            AlertTracker.key(alert("Camera sau 800 mét", 800)),
        )
        // Trị số giới hạn là một phần của biển: 60 km/h khác 80 km/h.
        assertNotEquals(
            AlertTracker.key(alert("Tốc độ tối đa 60 km/h", 100, CarState.AlertKind.SIGN, "P.127")),
            AlertTracker.key(alert("Tốc độ tối đa 80 km/h", 100, CarState.AlertKind.SIGN, "P.127")),
        )
    }

    /** Lỗi cũ: bỏ mọi chữ số khỏi câu chữ nên biển 80 ngay sau biển 60 (trong 2 phút) không bao giờ bật thông báo. */
    @Test
    fun newSpeedLimitSignSoonAfterPreviousIsPresented() {
        val t = AlertTracker()
        val s60 = alert("Tốc độ tối đa 60 km/h", 150, CarState.AlertKind.SIGN, "P.127")
        val s80 = alert("Tốc độ tối đa 80 km/h", 200, CarState.AlertKind.SIGN, "P.127")
        assertEquals(s60, t.pick(listOf(s60), 0))
        assertNull(t.pick(listOf(s60.copy(distanceM = 20)), 20_000))
        assertNull(t.pick(emptyList(), 30_000))
        assertEquals(s80, t.pick(listOf(s80), 40_000))
        // Kèm id (trang mới): 50 → 50 ở chỗ khác cũng là biển mới.
        val a = alert("Tốc độ tối đa 50 km/h", 150, CarState.AlertKind.SIGN, "P.127").copy(id = "s1abc")
        val b = a.copy(id = "s2def", distanceM = 400)
        assertEquals(a, t.pick(listOf(a), 60_000))
        assertNull(t.pick(listOf(a.copy(distanceM = 10)), 70_000))
        assertEquals(b, t.pick(listOf(b), 80_000))
    }

    @Test
    fun secondCameraOfSameTypeIsPresented() {
        val t = AlertTracker()
        val text = "Camera bắn tốc độ · giới hạn 60 km/h"
        // Có id: hai camera khác nhau dù câu chữ giống hệt.
        val c1 = alert(text, 300, code = "speed_camera").copy(id = "p1")
        val c2 = alert(text, 500, code = "speed_camera").copy(id = "p2")
        assertEquals(c1, t.pick(listOf(c1), 0))
        assertNull(t.pick(listOf(c1.copy(distanceM = 0)), 25_000))
        assertNull(t.pick(emptyList(), 30_000))
        assertEquals(c2, t.pick(listOf(c2), 90_000))
        // Không có id (trang cũ): khoảng cách tăng vọt nghĩa là camera kế tiếp cùng tên.
        val u = AlertTracker()
        val d1 = alert(text, 300, code = "speed_camera")
        assertEquals(d1, u.pick(listOf(d1), 0))
        assertNull(u.pick(listOf(d1.copy(distanceM = 40)), 20_000))
        assertNull(u.pick(listOf(d1.copy(distanceM = 60)), 21_000)) // dao động GPS nhỏ: vẫn là camera cũ
        assertEquals(d1.copy(distanceM = 700), u.pick(listOf(d1.copy(distanceM = 700)), 60_000))
    }
}
