package vn.banduong.app.car.map

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.car.app.SurfaceContainer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode
import vn.banduong.app.bridge.CarState
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.car.MapViewSettings

/** Vẽ thật vào Bitmap (đồ hoạ gốc của Robolectric) rồi kiểm tra màu điểm ảnh ở vài vị trí đã biết. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MapPainterTest {
    private val painter = MapPainter(MapPainter.Texts("km/h", "Dữ liệu đã cũ", "–") { t, d -> "$t · còn $d m" })
    private val lat = 10.7769
    private val lon = 106.7009

    private fun state(over: Boolean = false, heading: Double? = 0.0) = CarState(
        ts = 1L, speedKmh = 72.0, speedSource = null, limitKmh = 60, overSpeed = over,
        position = CarState.Position(lat, lon, heading, null), alerts = emptyList(), maneuver = null,
        // Tuyến đi thẳng về phía bắc 1 km.
        route = listOf(CarState.LatLon(lat, lon), CarState.LatLon(lat + 0.009, lon)),
        // Một đường chính chạy đông – tây, cách xe 100 m về phía nam.
        nearbyRoads = listOf(CarState.Road(CarState.HighwayClass.PRIMARY, listOf(CarState.LatLon(lat - 0.0009, lon - 0.01), CarState.LatLon(lat - 0.0009, lon + 0.01)))),
        camera = CarState.CameraStatus.OFF, obd = CarState.ObdStatus.OFF,
    )

    private fun frame(s: CarState?, dark: Boolean = false, fresh: CarStateStore.Freshness = CarStateStore.Freshness.FRESH) = MapPainter.Frame(
        width = 800, height = 480, visible = MapMath.Box(0f, 0f, 800f, 480f), density = 1f, dark = dark,
        state = s, freshness = fresh,
        settings = MapViewSettings(MapViewSettings.Zoom.NEAR, MapViewSettings.Orientation.HEADING_UP), headingDeg = s?.position?.heading,
    )

    private fun draw(f: MapPainter.Frame): Bitmap {
        val bmp = Bitmap.createBitmap(f.width, f.height, Bitmap.Config.ARGB_8888)
        painter.paint(Canvas(bmp), f)
        return bmp
    }

    @Test
    fun drawsRouteRoadVehicleAndSpeed() {
        val f = frame(state())
        val bmp = draw(f)
        val p = MapStyle.LIGHT
        val cam = painter.lastCamera!!
        // Điểm neo: giữa, 72 % chiều cao; tỉ lệ 200 m tới mép trên.
        assertEquals(400f, cam.anchorX)
        assertEquals(345.6f, cam.anchorY, 0.01f)
        assertEquals(p.vehicle, bmp.getPixel(400, 340))
        // Tuyến phía trước xe (phía bắc = phía trên khi đi về hướng bắc).
        assertEquals(p.route, bmp.getPixel(400, 150))
        // Đường chính cách 100 m phía sau xe ≈ 173 px dưới điểm neo: ngoài khung, góc trên phải chỉ có nền.
        assertEquals(p.background, bmp.getPixel(780, 20))
        // Ô tốc độ ở góc dưới trái: nền sáng gần trắng (hơi trong suốt) khi không quá tốc độ.
        val px = bmp.getPixel(16, 410)
        assertTrue(Color.red(px) > 0xF0 && Color.green(px) > 0xF0 && Color.blue(px) > 0xF0)
    }

    @Test
    fun overSpeedBoxIsRedAndNorthUpRotatesRoad() {
        val bmp = draw(frame(state(over = true)))
        assertEquals(MapStyle.LIGHT.overSpeed, bmp.getPixel(16, 410))

        // Hướng bắc, xe ở giữa; đường chính cách 100 m về phía nam → nằm ngang dưới tâm.
        val f = frame(state(heading = 90.0)).copy(settings = MapViewSettings(MapViewSettings.Zoom.NEAR, MapViewSettings.Orientation.NORTH_UP))
        val b2 = draw(f)
        val cam = painter.lastCamera!!
        assertEquals(240f, cam.anchorY)
        val roadY = (240f + 100.0 / cam.metersPerPx).toInt()
        assertEquals(MapStyle.LIGHT.roadMajor, b2.getPixel(700, roadY))
    }

    @Test
    fun darkModeAndEmptyState() {
        val bmp = draw(frame(null, dark = true, fresh = CarStateStore.Freshness.NONE))
        assertEquals(MapStyle.DARK.background, bmp.getPixel(400, 240))
        assertNull(painter.lastCamera)
        // Dữ liệu cũ: vẫn vẽ (có lớp phủ), không lỗi.
        draw(frame(state(), fresh = CarStateStore.Freshness.STALE))
        assertNotNull(painter.lastCamera)
    }

    /** Dữ liệu cũ: không vẽ tốc độ, màu quá tốc độ hay biển giới hạn của ảnh chụp cũ như thể đang đúng. */
    @Test
    fun staleFrameHidesOldSpeedOverSpeedAndLimit() {
        // Biển giới hạn: tâm (138, 436), bán kính 30; điểm (138, 416) nằm trong phần trắng, trên chữ số.
        val fresh = draw(frame(state(over = true)))
        assertEquals(MapStyle.LIGHT.overSpeed, fresh.getPixel(16, 410))
        assertEquals(Color.WHITE, fresh.getPixel(138, 416))
        val stale = draw(frame(state(over = true), fresh = CarStateStore.Freshness.STALE))
        val px = stale.getPixel(16, 410)
        assertNotEquals(MapStyle.LIGHT.overSpeed, px)
        assertTrue("ô tốc độ màu nền thường", Color.red(px) > 0xD0 && Color.green(px) > 0xD0 && Color.blue(px) > 0xD0)
        assertNotEquals(Color.WHITE, stale.getPixel(138, 416))
    }

    /** Ô tốc độ và biển giới hạn đặt theo vùng ổn định (không nhảy chỗ khi máy chủ hiện/ẩn dải nút). */
    @Test
    fun speedBoxFollowsStableArea() {
        val f = frame(state()).copy(stable = MapMath.Box(200f, 0f, 800f, 400f))
        val bmp = draw(f)
        val inBox = bmp.getPixel(216, 360)
        assertTrue(Color.red(inBox) > 0xF0 && Color.green(inBox) > 0xF0 && Color.blue(inBox) > 0xF0)
        assertEquals(MapStyle.LIGHT.background, bmp.getPixel(16, 470))
        // Tâm bản đồ vẫn theo vùng nhìn.
        assertEquals(400f, painter.lastCamera!!.anchorX)
        // Chế độ chỉ có GPS: vẽ được, không lỗi.
        draw(frame(state()).copy(gpsOnly = true))
    }

    /** Trong hầm (tốc độ OBD còn mới, vị trí cũ): vẫn vẽ tốc độ, màu quá tốc độ, biển; có thêm thẻ báo mất GPS ở trên. */
    @Test
    fun positionStaleKeepsSpeedAndAddsPill() {
        val normal = draw(frame(state(over = true)))
        val old = draw(frame(state(over = true)).copy(positionStale = true))
        assertEquals(MapStyle.LIGHT.overSpeed, old.getPixel(16, 410))
        assertEquals(Color.WHITE, old.getPixel(138, 416))
        var changed = 0
        for (y in 10..46) for (x in 0 until 800) if (normal.getPixel(x, y) != old.getPixel(x, y)) changed++
        assertTrue("có thẻ mất GPS ở trên ($changed điểm ảnh khác)", changed > 1000)
    }

    @Test
    fun rendererFrameUsesVisibleAreaAndDensity() {
        val r = MapRenderer(painter, dark = false, clock = { 0L })
        try {
            val c = SurfaceContainer(null, 1280, 720, 320)
            val f1 = r.frame(c, CarStateStore.Snapshot.EMPTY)
            assertEquals(MapMath.Box(0f, 0f, 1280f, 720f), f1.visible)
            assertEquals(2f, f1.density)
            r.onVisibleAreaChanged(android.graphics.Rect(300, 100, 1280, 700))
            assertEquals(MapMath.Box(300f, 100f, 1280f, 700f), r.frame(c, CarStateStore.Snapshot.EMPTY).visible)
            // Vùng nhìn không hợp lệ (rộng hơn Surface) bị bỏ qua.
            r.onVisibleAreaChanged(android.graphics.Rect(0, 0, 4000, 700))
            assertEquals(MapMath.Box(0f, 0f, 1280f, 720f), r.frame(c, CarStateStore.Snapshot.EMPTY).visible)
            // Không có Surface: cập nhật không vẽ gì và không lỗi.
            r.onSurfaceAvailable(c)
            r.update(CarStateStore.Snapshot(state(), 0L))
            assertEquals(0, r.framesDrawn)
        } finally {
            r.release()
        }
    }
}
