package vn.banduong.app.car

import android.content.Intent
import androidx.car.app.HostInfo
import androidx.car.app.testing.SessionController
import androidx.car.app.testing.TestAppManager
import androidx.car.app.testing.TestCarContext
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.BuildConfig
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.car.map.MapRenderer

@RunWith(RobolectricTestRunner::class)
class CarAppTest {
    private lateinit var carContext: TestCarContext

    @Before
    fun setUp() {
        CarStateStore.resetForTest()
        carContext = TestCarContext.createCarContext(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() = CarStateStore.resetForTest()

    @Test
    fun hostValidatorUsesAllowlistEvenInDebug() {
        val service = Robolectric.setupService(BanDuongCarAppService::class.java)
        val stranger = HostInfo("com.example.not.a.car.host", 12345)
        assertTrue("bản kiểm thử là debug", BuildConfig.DEBUG)
        assertFalse("mặc định tắt cờ allowAllCarHosts", BuildConfig.ALLOW_ALL_CAR_HOSTS)
        // Bản debug cũng từ chối ứng dụng lạ giả làm máy chủ Android Auto.
        assertFalse(service.createHostValidator().isValidHost(stranger))
        assertFalse(service.createHostValidator(allowAll = false).isValidHost(stranger))
        assertTrue(service.createHostValidator(allowAll = true).isValidHost(stranger))
        // Danh sách của thư viện có Android Auto (gearhead), cũng là đường đi của Desktop Head Unit.
        val allow = carContext.resources.getStringArray(androidx.car.app.R.array.hosts_allowlist_sample)
        assertTrue(allow.any { it.trim().endsWith("com.google.android.projection.gearhead") })
    }

    @Test
    fun sessionTracksCarConnectionAndInstallsMapSurface() {
        val changes = ArrayList<Boolean>()
        CarStateStore.addCarSessionListener { changes += it }
        val session = BanDuongSession()
        val controller = SessionController(session, carContext, Intent())
        controller.moveToState(Lifecycle.State.CREATED)
        assertTrue(CarStateStore.isCarSessionActive)
        val screen = session.onCreateScreen(Intent())
        assertTrue(screen is NavigationScreen)
        val appManager = carContext.getCarService(TestAppManager::class.java)
        assertTrue(appManager.surfaceCallback is MapRenderer)

        controller.moveToState(Lifecycle.State.DESTROYED)
        assertFalse(CarStateStore.isCarSessionActive)
        assertNull(appManager.surfaceCallback)
        assertEquals(listOf(true, false), changes)
    }
}
