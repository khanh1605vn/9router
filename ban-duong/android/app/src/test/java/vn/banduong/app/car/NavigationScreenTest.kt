package vn.banduong.app.car

import android.os.Looper
import android.os.SystemClock
import androidx.car.app.HandshakeInfo
import androidx.car.app.model.CarColor
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.testing.ScreenController
import androidx.car.app.testing.TestAppManager
import androidx.car.app.testing.TestCarContext
import androidx.car.app.testing.navigation.TestNavigationManager
import androidx.car.app.model.Distance
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import vn.banduong.app.bridge.CarState
import vn.banduong.app.bridge.CarStateStore
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
class NavigationScreenTest {
    private lateinit var carContext: TestCarContext
    private val presented = ArrayList<CarState.Alert>()
    private var now = 100_000L

    @Before
    fun setUp() {
        CarStateStore.resetForTest()
        carContext = TestCarContext.createCarContext(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() = CarStateStore.resetForTest()

    private fun state(
        speed: Double? = 52.4,
        limit: Int? = 60,
        over: Boolean = false,
        alerts: List<CarState.Alert> = emptyList(),
        maneuver: CarState.Maneuver? = null,
    ) = CarState(
        ts = 1L, speedKmh = speed, speedSource = CarState.SpeedSource.GPS, limitKmh = limit, overSpeed = over,
        position = CarState.Position(10.7769, 106.7009, 90.0, 5.0),
        alerts = alerts, maneuver = maneuver,
        route = listOf(CarState.LatLon(10.7769, 106.7009), CarState.LatLon(10.7769, 106.7030)),
        nearbyRoads = emptyList(), camera = CarState.CameraStatus.OFF, obd = CarState.ObdStatus.OFF,
    )

    private val camera = CarState.Alert(CarState.AlertKind.CAMERA, "speed_camera", "Camera phạt nguội", 300, CarState.AlertSource.OSM)
    private val turn = CarState.Maneuver("Rẽ phải vào đường Lê Lợi", 130, CarState.ManeuverIcon.RIGHT, null)

    private val epoch = 1_764_000_000_000L
    private fun screen() = NavigationScreen(carContext, renderer = null, alertPresenter = { presented += it }, uptime = { now }, nowEpoch = { epoch })

    private fun template(s: NavigationScreen) = s.onGetTemplate() as NavigationTemplate
    private fun message(s: NavigationScreen) = template(s).navigationInfo as MessageInfo
    private val nav get() = carContext.getCarService(NavigationManager::class.java) as TestNavigationManager

    @Test
    fun noStateAsksToOpenPhoneApp() {
        val t = template(screen())
        val m = t.navigationInfo as MessageInfo
        assertEquals("Chưa có dữ liệu", m.title.toString())
        assertEquals("Khi đã dừng xe an toàn, hãy mở ứng dụng Bạn Đường trên điện thoại để bắt đầu.", m.text.toString())
        val actions = t.actionStrip!!.actions
        assertEquals(listOf("Tự động", "Hướng xe"), actions.map { it.title.toString() })
        assertTrue(actions.all { it.icon != null && it.onClickDelegate != null })
    }

    @Test
    fun staleDataAfterFiveSeconds() {
        val s = screen()
        CarStateStore.update(state(), now)
        now += CarStateStore.STALE_MS
        assertEquals("52 km/h · giới hạn 60 km/h", message(s).title.toString())
        now += 1
        val m = message(s)
        assertEquals("Mất dữ liệu từ điện thoại", m.title.toString())
        assertEquals("Chưa nhận được dữ liệu mới. Khi đã dừng xe an toàn, hãy mở ứng dụng Bạn Đường trên điện thoại.", m.text.toString())
    }

    @Test
    fun normalDrivingShowsSpeedAndLimit() {
        val s = screen()
        CarStateStore.update(state(), now)
        val m = message(s)
        assertEquals("52 km/h · giới hạn 60 km/h", m.title.toString())
        assertEquals("Không có cảnh báo phía trước", m.text.toString())
        assertEquals(CarColor.DEFAULT, m.image!!.tint)

        CarStateStore.update(state(speed = null, limit = null), now)
        assertEquals("Chưa có tốc độ · chưa có giới hạn", message(s).title.toString())
    }

    @Test
    fun overSpeedIsRed() {
        val s = screen()
        CarStateStore.update(state(speed = 72.0, over = true), now)
        val m = message(s)
        assertEquals("Quá tốc độ: 72 km/h · giới hạn 60 km/h", m.title.toString())
        assertEquals(CarColor.RED, m.image!!.tint)
    }

    @Test
    fun alertIsShownInCardAndPresentedOnce() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.STARTED)
        CarStateStore.update(state(alerts = listOf(camera)), now)
        assertEquals("Camera phạt nguội · còn 300 m", message(s).text.toString())
        assertEquals(CarColor.YELLOW, message(s).image!!.tint)
        assertEquals(listOf(camera), presented)
        now += 1000
        CarStateStore.update(state(alerts = listOf(camera.copy(distanceM = 250))), now)
        assertEquals(1, presented.size)
        assertEquals("Camera phạt nguội · còn 250 m", message(s).text.toString())
    }

    @Test
    fun alertsAreNotPresentedWhenScreenNotVisible() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.CREATED)
        CarStateStore.update(state(alerts = listOf(camera)), now)
        assertTrue(presented.isEmpty())
    }

    @Test
    fun hostAlertPresenterFallsBackToToastBeforeApi5() {
        val p = HostCarAlertPresenter(carContext)
        p.present(camera) // chưa bắt tay: coi như Car API 1
        val toasts = carContext.getCarService(TestAppManager::class.java).toastsShown
        assertEquals(listOf("Camera phạt nguội, còn 300 m"), toasts.map { it.toString() })

        carContext.updateHandshakeInfo(HandshakeInfo("com.google.android.projection.gearhead", 5))
        p.present(camera) // Car API 5: dùng Alert (máy chủ giả bỏ qua), không có thêm toast
        assertEquals(1, carContext.getCarService(TestAppManager::class.java).toastsShown.size)

        val alert = HostCarAlertPresenter.build(carContext, camera, "300 m")
        assertEquals("Camera phạt nguội", alert.title.toString())
        assertEquals("Còn 300 m", alert.subtitle.toString())
        assertNotNull(alert.icon)
        // Biểu tượng trắng được tô màu để tương phản với nền thẻ (VD-1).
        assertEquals(CarColor.YELLOW, alert.icon!!.tint)
        val sign = camera.copy(kind = CarState.AlertKind.SIGN)
        assertEquals(CarColor.DEFAULT, HostCarAlertPresenter.build(carContext, sign, "300 m").icon!!.tint)
        assertTrue(alert.actions.isEmpty())
    }

    @Test
    fun maneuverStartsNavigationAndShowsRoutingInfo() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.CREATED)
        CarStateStore.update(state(maneuver = turn), now)
        assertEquals(1, nav.navigationStartedCount)
        assertTrue(s.navigation.isNavigating)
        val r = template(s).navigationInfo as RoutingInfo
        val step = r.currentStep!!
        assertEquals("Rẽ phải vào đường Lê Lợi", step.cue.toString())
        assertEquals(Maneuver.TYPE_TURN_NORMAL_RIGHT, step.maneuver!!.type)
        assertNotNull(step.maneuver!!.icon)
        assertEquals(150.0, r.currentDistance!!.displayDistance, 1e-9)
        assertEquals(Distance.UNIT_METERS, r.currentDistance!!.displayUnit)

        // Vòng xuyến có số lối ra.
        CarStateStore.update(state(maneuver = CarState.Maneuver("Vào vòng xuyến, ra lối thứ 2", 2400, CarState.ManeuverIcon.ROUNDABOUT, 2)), now)
        val rr = template(s).navigationInfo as RoutingInfo
        assertEquals(Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW, rr.currentStep!!.maneuver!!.type)
        assertEquals(2, rr.currentStep!!.maneuver!!.roundaboutExitNumber)
        assertEquals(2.4, rr.currentDistance!!.displayDistance, 1e-9)
        assertEquals(1, nav.navigationStartedCount)

        // Hết chỉ dẫn: kết thúc dẫn đường.
        CarStateStore.update(state(), now)
        assertEquals(1, nav.navigationEndedCount)
        assertTrue(template(s).navigationInfo is MessageInfo)
    }

    @Test
    fun hostStopSuppressesRoutingUntilTripEnds() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.CREATED)
        CarStateStore.update(state(maneuver = turn), now)
        nav.navigationManagerCallback!!.onStopNavigation()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(s.navigation.isNavigating)
        CarStateStore.update(state(maneuver = turn), now)
        assertEquals(1, nav.navigationStartedCount)
        // Ứng dụng dẫn đường khác đang chỉ đường: không hiện chỉ dẫn rẽ của ta, kể cả dạng chữ (NF-5).
        assertEquals("Không có cảnh báo phía trước", message(s).text.toString())
        assertTrue(s.navigation.stoppedByHost)
        CarStateStore.update(state(maneuver = turn, alerts = listOf(camera)), now)
        assertEquals("Camera phạt nguội · còn 300 m", message(s).text.toString())
        // Chuyến cũ kết thúc rồi có chuyến mới: dẫn đường lại.
        CarStateStore.update(state(), now)
        CarStateStore.update(state(maneuver = turn), now)
        assertEquals(2, nav.navigationStartedCount)
    }

    @Test
    fun staleDataEndsNavigationEvenWithoutNewMessages() {
        // Dùng đồng hồ thật của Robolectric để hẹn giờ kiểm tra dữ liệu cũ chạy được.
        val s = NavigationScreen(carContext, renderer = null, alertPresenter = { presented += it })
        val controller = ScreenController(s).moveToState(Lifecycle.State.RESUMED)
        CarStateStore.update(state(maneuver = turn), SystemClock.uptimeMillis())
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(s.navigation.isNavigating)
        controller.reset()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(CarStateStore.STALE_MS + 50))
        assertFalse(s.navigation.isNavigating)
        assertEquals(1, nav.navigationEndedCount)
        val last = controller.templatesReturned.last() as NavigationTemplate
        assertEquals("Mất dữ liệu từ điện thoại", (last.navigationInfo as MessageInfo).title.toString())
    }

    @Test
    fun templateRefreshIsThrottledToOncePerSecond() {
        val s = NavigationScreen(carContext, renderer = null, alertPresenter = { })
        val controller = ScreenController(s).moveToState(Lifecycle.State.RESUMED)
        val looper = shadowOf(Looper.getMainLooper())
        looper.idleFor(Duration.ofSeconds(2))
        controller.reset()
        repeat(10) { i ->
            CarStateStore.update(state(speed = 40.0 + i), SystemClock.uptimeMillis())
            looper.idleFor(Duration.ofMillis(100))
        }
        looper.idleFor(Duration.ofMillis(1100))
        val n = controller.templatesReturned.size
        assertTrue("$n lần làm mới trong ~2 giây", n in 1..3)
        assertEquals("49 km/h · giới hạn 60 km/h", ((controller.templatesReturned.last() as NavigationTemplate).navigationInfo as MessageInfo).title.toString())
    }

    @Test
    fun actionsToggleZoomAndOrientation() {
        val s = screen()
        s.toggleZoom()
        assertEquals(MapViewSettings.Zoom.NEAR, s.settings.zoom)
        s.toggleZoom()
        s.toggleOrientation()
        assertEquals(listOf("Xa", "Hướng bắc"), template(s).actionStrip!!.actions.map { it.title.toString() })
        s.toggleZoom()
        assertEquals(MapViewSettings.Zoom.AUTO, s.settings.zoom)
    }

    private fun fix(speed: Double? = 45.4) = CarStateStore.NativeFix(10.78, 106.70, 180.0, 4.0, speed, now)

    /** Điện thoại khoá màn hình / chưa mở ứng dụng: màn hình xe vẫn có tốc độ GPS của máy, không giả "không có cảnh báo". */
    @Test
    fun gpsOnlyModeShowsNativeSpeedWithoutAlerts() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.STARTED)
        CarStateStore.updateNativeFix(fix())
        val m = message(s)
        assertEquals("45 km/h · chưa có giới hạn", m.title.toString())
        assertEquals(
            "Chỉ có tốc độ GPS, chưa có cảnh báo. Khi đã dừng xe an toàn, hãy mở ứng dụng Bạn Đường trên điện thoại.",
            m.text.toString(),
        )
        // Trang gửi dữ liệu có cảnh báo, rồi thôi gửi: sau 5 s về chế độ GPS, không bật lại cảnh báo cũ, không dẫn đường.
        CarStateStore.update(state(alerts = listOf(camera), maneuver = turn), now)
        assertEquals(listOf(camera), presented)
        assertTrue(s.navigation.isNavigating)
        now += CarStateStore.STALE_MS + 1
        CarStateStore.updateNativeFix(fix(speed = 30.0))
        assertFalse(s.navigation.isNavigating)
        val g = message(s)
        assertEquals("30 km/h · chưa có giới hạn", g.title.toString())
        assertTrue(g.text.toString().startsWith("Chỉ có tốc độ GPS"))
        assertEquals(1, presented.size)
    }

    /** NF-4: đang dẫn đường thì gửi bước kế tiếp và giờ đến cho máy chủ (bảng đồng hồ), và hiện giờ đến trên thẻ. */
    @Test
    fun tripIsSentToHostWhileNavigating() {
        val s = screen()
        ScreenController(s).moveToState(Lifecycle.State.CREATED)
        CarStateStore.update(state(maneuver = turn.copy(tripDistanceM = 5_000, tripDurationS = 600)), now)
        assertTrue(s.navigation.isNavigating)
        // Gửi cùng nhịp làm mới mẫu giao diện (tối đa 1 lần/giây).
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        val trip = nav.tripsSent.last()
        assertEquals("Rẽ phải vào đường Lê Lợi", trip.steps[0].cue.toString())
        assertEquals(Maneuver.TYPE_TURN_NORMAL_RIGHT, trip.steps[0].maneuver!!.type)
        assertEquals("Điểm đến", trip.destinations[0].name.toString())
        val dest = trip.destinationTravelEstimates[0]
        assertEquals(600L, dest.remainingTimeSeconds)
        assertEquals(epoch + 600_000, dest.arrivalTimeAtDestination!!.timeSinceEpochMillis)
        assertEquals(5.0, dest.remainingDistance!!.displayDistance, 1e-9)
        // Bước kế tiếp: 130 m trên 5 000 m của 600 giây → 15 giây.
        assertEquals(15L, trip.stepTravelEstimates[0].remainingTimeSeconds)
        assertEquals(600L, template(s).destinationTravelEstimate!!.remainingTimeSeconds)
        // Không có quãng đường/thời gian còn lại: không gửi chuyến (không bịa giờ đến).
        val sent = nav.tripsSent.size
        now += 2_000
        CarStateStore.update(state(maneuver = turn), now)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        assertEquals(sent, nav.tripsSent.size)
    }
}
