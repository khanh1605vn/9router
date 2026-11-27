package vn.banduong.app.car

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import androidx.car.app.testing.SessionController
import androidx.car.app.testing.TestCarContext
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import vn.banduong.app.bridge.CarStateStore

@RunWith(RobolectricTestRunner::class)
class CarLocationSourceTest {
    private val app: Application = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() = CarStateStore.resetForTest()

    @After
    fun tearDown() = CarStateStore.resetForTest()

    private fun loc(
        speed: Float? = 12.5f,
        bearing: Float? = 370f,
        accuracy: Float? = 5f,
        elapsedNanos: Long = 1_000_000_000L,
    ) = Location(LocationManager.GPS_PROVIDER).apply {
        latitude = 10.7769
        longitude = 106.7009
        speed?.let { this.speed = it }
        bearing?.let { this.bearing = it }
        accuracy?.let { this.accuracy = it }
        elapsedRealtimeNanos = elapsedNanos
        time = System.currentTimeMillis()
    }

    @Test
    fun toFixConvertsAndRejectsBadFixes() {
        val now = 2_000_000_000L
        val f = CarLocationSource.toFix(loc(), now, 777L)!!
        assertEquals(10.7769, f.lat, 0.0)
        assertEquals(45.0, f.speedKmh!!, 1e-6) // 12,5 m/s
        assertEquals(10.0, f.headingDeg!!, 1e-3) // 370° → 10°
        assertEquals(5.0, f.accuracyM!!, 0.0)
        assertEquals(777L, f.atUptimeMs)
        // Đứng yên: hướng đi của GPS không đáng tin.
        assertNull(CarLocationSource.toFix(loc(speed = 0.3f), now, 0)!!.headingDeg)
        // Không có tốc độ: tốc độ null (không đoán).
        assertNull(CarLocationSource.toFix(loc(speed = null), now, 0)!!.speedKmh)
        // Sai số quá lớn hoặc quá cũ: bỏ.
        assertNull(CarLocationSource.toFix(loc(accuracy = 800f), now, 0))
        assertNull(CarLocationSource.toFix(loc(elapsedNanos = 1L), now + 20_000_000_000L, 0))
        assertNull(CarLocationSource.toFix(loc().apply { latitude = Double.NaN }, now, 0))
    }

    @Test
    fun noPermissionMeansNoLocation() {
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        val src = CarLocationSource(app)
        assertFalse(src.start())
        assertFalse(src.running)
    }

    @Test
    fun startedSourceFeedsStoreAndStopClearsIt() {
        shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val src = CarLocationSource(app)
        assertTrue(src.start())
        val l = loc(elapsedNanos = SystemClock.elapsedRealtimeNanos()).apply { provider = providerUsed(lm) }
        shadowOf(lm).simulateLocation(l)
        shadowOf(Looper.getMainLooper()).idle()
        val fix = CarStateStore.snapshot.fix
        assertNotNull(fix)
        assertEquals(45.0, fix!!.speedKmh!!, 1e-6)
        src.stop()
        assertNull(CarStateStore.snapshot.fix)
        // Sau khi dừng, định vị mới không còn được ghi.
        shadowOf(lm).simulateLocation(l)
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(CarStateStore.snapshot.fix)
    }

    @Test
    fun carSessionRunsLocationOnlyWhileOpen() {
        shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        val carContext = TestCarContext.createCarContext(app)
        val session = BanDuongSession()
        val controller = SessionController(session, carContext, Intent())
        controller.moveToState(Lifecycle.State.CREATED)
        assertTrue(session.locationRunning)
        CarStateStore.updateNativeFix(CarStateStore.NativeFix(10.0, 106.0, null, null, 20.0, 1L))
        controller.moveToState(Lifecycle.State.DESTROYED)
        assertFalse(session.locationRunning)
        assertNull(CarStateStore.snapshot.fix)
    }

    private fun providerUsed(lm: LocationManager): String =
        if (LocationManager.FUSED_PROVIDER in lm.allProviders) LocationManager.FUSED_PROVIDER else LocationManager.GPS_PROVIDER
}
