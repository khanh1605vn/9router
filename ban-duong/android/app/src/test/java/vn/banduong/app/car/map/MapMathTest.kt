package vn.banduong.app.car.map

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import vn.banduong.app.bridge.CarState
import vn.banduong.app.car.MapViewSettings
import vn.banduong.app.car.map.MapMath.Box

class MapMathTest {
    private val lat0 = 10.7769
    private val lon0 = 106.7009
    private val out = FloatArray(2)

    private fun cam(rotation: Double, mpp: Double = 1.0) = MapMath.Camera(lat0, lon0, rotation, mpp, 400f, 300f)

    /** Điểm cách tâm [east] m về phía đông và [north] m về phía bắc. */
    private fun offset(east: Double, north: Double): Pair<Double, Double> {
        val mPerDegLon = MapMath.M_PER_DEG_LON_EQUATOR * Math.cos(Math.toRadians(lat0))
        return (lat0 + north / MapMath.M_PER_DEG_LAT) to (lon0 + east / mPerDegLon)
    }

    private fun proj(c: MapMath.Camera, east: Double, north: Double): Pair<Float, Float> {
        val (la, lo) = offset(east, north)
        c.project(la, lo, out)
        return out[0] to out[1]
    }

    @Test
    fun northUpProjection() {
        val c = cam(0.0, mpp = 2.0)
        assertEquals(400f to 300f, proj(c, 0.0, 0.0))
        val (x1, y1) = proj(c, 100.0, 0.0) // 100 m về đông = 50 px sang phải
        assertEquals(450f, x1, 0.01f); assertEquals(300f, y1, 0.01f)
        val (x2, y2) = proj(c, 0.0, 100.0) // 100 m về bắc = 50 px lên trên
        assertEquals(400f, x2, 0.01f); assertEquals(250f, y2, 0.01f)
    }

    @Test
    fun headingUpPutsTravelDirectionOnTop() {
        // Xe đi về hướng đông (90°): điểm phía đông nằm thẳng phía trên, phía bắc nằm bên trái.
        val c = cam(90.0)
        val (x1, y1) = proj(c, 100.0, 0.0)
        assertEquals(400f, x1, 0.01f); assertEquals(200f, y1, 0.01f)
        val (x2, y2) = proj(c, 0.0, 100.0)
        assertEquals(300f, x2, 0.01f); assertEquals(300f, y2, 0.01f)
        // Đi về hướng nam (180°): phía bắc ở dưới.
        val (_, y3) = proj(cam(180.0), 0.0, 100.0)
        assertEquals(400f, y3, 0.01f)
    }

    @Test
    fun distancesArePreservedAtLatitude() {
        // 1 km theo hướng 45° phải cách điểm neo 1 000 px khi tỉ lệ 1 m/px (sai số < 0,5 %).
        val c = cam(0.0)
        val (x, y) = proj(c, 707.1068, 707.1068)
        val d = Math.hypot((x - 400f).toDouble(), (y - 300f).toDouble())
        assertEquals(1000.0, d, 5.0)
        assertArrayEquals(floatArrayOf(400f, 300f, 400f, 300f), c.projectAll(listOf(CarState.LatLon(lat0, lon0), CarState.LatLon(lat0, lon0))), 0.001f)
    }

    @Test
    fun zoomAndScale() {
        assertEquals(200.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.NEAR, 80.0), 0.0)
        assertEquals(1500.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.FAR, 0.0), 0.0)
        assertEquals(400.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.AUTO, null), 0.0)
        assertEquals(250.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.AUTO, 0.0), 0.0)
        assertEquals(550.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.AUTO, 50.0), 0.0)
        assertEquals(1000.0, MapMath.viewRadiusMeters(MapViewSettings.Zoom.AUTO, 180.0), 0.0)
        // Tăng dần theo tốc độ, bước 50 m.
        var last = 0.0
        for (v in 0..200 step 5) {
            val r = MapMath.viewRadiusMeters(MapViewSettings.Zoom.AUTO, v.toDouble())
            assertTrue(r >= last); assertEquals(0.0, r % 50.0, 0.0); last = r
        }
        val visible = Box(0f, 100f, 800f, 600f)
        val (ax, ay) = MapMath.anchor(visible, MapViewSettings.Orientation.HEADING_UP)
        assertEquals(400f, ax); assertEquals(460f, ay, 0.01f)
        assertEquals(400f to 350f, MapMath.anchor(visible, MapViewSettings.Orientation.NORTH_UP))
        assertEquals(500.0 / 360.0, MapMath.metersPerPixel(500.0, ay, visible.top), 1e-6)
        assertEquals(500.0 / 40.0, MapMath.metersPerPixel(500.0, 105f, 100f), 1e-9)
    }

    @Test
    fun normalizeDegrees() {
        assertEquals(0.0, MapMath.normalizeDeg(360.0), 0.0)
        assertEquals(350.0, MapMath.normalizeDeg(-10.0), 1e-9)
        assertEquals(90.0, MapMath.normalizeDeg(810.0), 1e-9)
    }

    @Test
    fun segmentClipping() {
        val box = Box(0f, 0f, 100f, 100f)
        assertArrayEquals(floatArrayOf(0f, 1f), MapMath.clipSegment(10f, 10f, 90f, 90f, box), 1e-6f)
        assertArrayEquals(floatArrayOf(0.25f, 0.75f), MapMath.clipSegment(-50f, 50f, 150f, 50f, box), 1e-6f)
        assertArrayEquals(floatArrayOf(0f, 0.5f), MapMath.clipSegment(50f, 50f, 50f, 150f, box), 1e-6f)
        assertNull(MapMath.clipSegment(-10f, -10f, -1f, 200f, box))
        assertNull(MapMath.clipSegment(150f, 0f, 200f, 100f, box))
        assertNull(MapMath.clipSegment(-50f, 120f, 120f, 200f, box)) // chéo nhưng ngoài góc
        assertArrayEquals(floatArrayOf(0f, 0f), MapMath.clipSegment(100f, 100f, 150f, 150f, box), 1e-6f) // chạm góc
    }

    @Test
    fun polylineClippingSplitsAndKeepsInsideParts() {
        val box = Box(0f, 0f, 100f, 100f)
        // Hoàn toàn bên trong: giữ nguyên.
        val inside = floatArrayOf(10f, 10f, 50f, 50f, 90f, 10f)
        val p1 = MapMath.clipPolyline(inside, box)
        assertEquals(1, p1.size); assertArrayEquals(inside, p1[0], 0f)
        // Vào – ra – vào lại: hai phần.
        val zig = floatArrayOf(50f, 50f, 150f, 50f, 150f, 80f, 50f, 80f)
        val p2 = MapMath.clipPolyline(zig, box)
        assertEquals(2, p2.size)
        assertArrayEquals(floatArrayOf(50f, 50f, 100f, 50f), p2[0], 1e-4f)
        assertArrayEquals(floatArrayOf(100f, 80f, 50f, 80f), p2[1], 1e-4f)
        // Cắt ngang qua khung: một phần hai điểm trên mép.
        val p3 = MapMath.clipPolyline(floatArrayOf(-100f, 50f, 200f, 50f), box)
        assertEquals(1, p3.size); assertArrayEquals(floatArrayOf(0f, 50f, 100f, 50f), p3[0], 1e-4f)
        // Ngoài hẳn hoặc quá ít điểm.
        assertTrue(MapMath.clipPolyline(floatArrayOf(200f, 200f, 300f, 300f), box).isEmpty())
        assertTrue(MapMath.clipPolyline(floatArrayOf(50f, 50f), box).isEmpty())
        // Mọi điểm sau khi cắt đều trong khung.
        val big = FloatArray(400) { if (it % 2 == 0) (it * 7 % 500 - 200).toFloat() else (it * 13 % 500 - 200).toFloat() }
        for (piece in MapMath.clipPolyline(big, box)) {
            assertTrue(piece.size >= 4)
            for (i in piece.indices step 2) assertTrue(box.inset(-0.01f).contains(piece[i], piece[i + 1]))
        }
    }

    @Test
    fun boundsCulling() {
        val box = Box(0f, 0f, 100f, 100f)
        assertTrue(MapMath.boundsIntersect(floatArrayOf(-50f, 50f, 150f, 50f), box))
        assertFalse(MapMath.boundsIntersect(floatArrayOf(150f, 50f, 250f, 60f), box))
        assertFalse(MapMath.boundsIntersect(FloatArray(0), box))
    }
}
