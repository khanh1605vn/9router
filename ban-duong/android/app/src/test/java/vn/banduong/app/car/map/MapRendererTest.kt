package vn.banduong.app.car.map

import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.view.Surface
import androidx.car.app.SurfaceContainer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.bridge.CarStateStore

/** MapRenderer với Surface giả của Robolectric (đồ hoạ cũ, ShadowSurface): nhả Surface, vùng ổn định. */
@RunWith(RobolectricTestRunner::class)
class MapRendererTest {
    private val painter = MapPainter(MapPainter.Texts("km/h", "Dữ liệu đã cũ", "–") { t, d -> "$t · còn $d m" })

    @Test
    fun rendererReleasesSurfacesAndUsesStableArea() {
        val r = MapRenderer(painter, dark = false, clock = { 0L })
        try {
            val s1 = Surface(SurfaceTexture(1))
            val s2 = Surface(SurfaceTexture(2))
            val c1 = SurfaceContainer(s1, 1280, 720, 160)
            val c2 = SurfaceContainer(s2, 1280, 720, 160)
            r.onSurfaceAvailable(c1)
            r.onSurfaceAvailable(c2) // Surface mới thay Surface cũ: nhả Surface cũ
            assertFalse(s1.isValid)
            assertTrue(s2.isValid)
            r.onSurfaceDestroyed(c2)
            assertFalse(s2.isValid)
            val s3 = Surface(SurfaceTexture(3))
            val c3 = SurfaceContainer(s3, 1280, 720, 160)
            r.onSurfaceAvailable(c3)
            r.onVisibleAreaChanged(Rect(300, 100, 1280, 700))
            r.onStableAreaChanged(Rect(300, 200, 1280, 700))
            val f = r.frame(c3, CarStateStore.Snapshot.EMPTY)
            assertEquals(MapMath.Box(300f, 100f, 1280f, 700f), f.visible)
            assertEquals(MapMath.Box(300f, 200f, 1280f, 700f), f.stable)
            r.onStableAreaChanged(Rect(0, 0, 0, 0)) // rỗng: dùng vùng nhìn
            assertEquals(f.visible, r.frame(c3, CarStateStore.Snapshot.EMPTY).stable)
            r.release()
            assertFalse(s3.isValid)
        } finally {
            r.release()
        }
    }

}
