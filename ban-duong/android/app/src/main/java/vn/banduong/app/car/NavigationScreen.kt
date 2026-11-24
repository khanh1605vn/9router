package vn.banduong.app.car

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.bridge.CarStateStore.Freshness
import vn.banduong.app.car.map.MapRenderer

/**
 * Màn hình chính trên xe: bản đồ tự vẽ (Surface) + NavigationTemplate (thẻ chỉ dẫn, dải thao tác).
 *
 * Nhịp làm mới: mẫu giao diện tối đa mỗi giây một lần ([MIN_REFRESH_MS]); bản đồ tối đa 10 khung hình/giây (do
 * [MapRenderer] giới hạn). Dữ liệu không mới sau [CarStateStore.STALE_MS] thì thẻ chuyển sang lời nhắc mở ứng dụng
 * trên điện thoại, kể cả khi không còn thông điệp nào tới (có hẹn giờ kiểm tra riêng).
 */
class NavigationScreen(
    carContext: CarContext,
    private val renderer: MapRenderer? = null,
    private val alertPresenter: CarAlertPresenter = HostCarAlertPresenter(carContext),
    private val uptime: () -> Long = SystemClock::uptimeMillis,
    private val nowEpoch: () -> Long = System::currentTimeMillis,
) : Screen(carContext) {

    var settings = MapViewSettings()
        private set

    private val handler = Handler(Looper.getMainLooper())
    private val alerts = AlertTracker()
    private var lastInvalidate = Long.MIN_VALUE / 2
    private var refreshScheduled = false
    private var lastMode: Pair<Freshness, Boolean> = Freshness.NONE to false

    internal val navigation = NavigationController(
        nav = try {
            carContext.getCarService(NavigationManager::class.java)
        } catch (_: RuntimeException) {
            null
        },
        executor = ContextCompat.getMainExecutor(carContext),
        onChanged = { forceRefresh() },
    )

    private val storeListener = CarStateStore.Listener { onSnapshot(it) }
    private val refreshRunnable = Runnable {
        refreshScheduled = false
        lastInvalidate = uptime()
        refreshNow()
    }
    private val staleCheck = Runnable { onSnapshot(CarStateStore.snapshot) }

    init {
        renderer?.setSettings(settings)
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) {
                CarStateStore.addListener(storeListener)
                onSnapshot(CarStateStore.snapshot)
            }

            override fun onDestroy(owner: LifecycleOwner) {
                CarStateStore.removeListener(storeListener)
                handler.removeCallbacksAndMessages(null)
                refreshScheduled = false
                navigation.release()
            }
        })
    }

    /** Ảnh chụp mới (hoặc hẹn giờ kiểm tra dữ liệu cũ tới hạn). Luôn trên luồng chính. */
    internal fun onSnapshot(snapshot: CarStateStore.Snapshot) {
        val now = uptime()
        val view = snapshot.view(now)
        val state = view.state
        // Chế độ "chỉ có GPS" không có chỉ dẫn rẽ (maneuver = null) nên cũng kết thúc dẫn đường.
        navigation.update(fresh = view.freshness == Freshness.FRESH, hasManeuver = state?.maneuver != null)
        renderer?.update(snapshot)

        if (view.freshness == Freshness.FRESH && !view.gpsOnly && state != null &&
            lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        ) {
            alerts.pick(state.alerts, now)?.let(alertPresenter::present)
        }

        handler.removeCallbacks(staleCheck)
        snapshot.nextCheckAt(now)?.let { handler.postAtTime(staleCheck, it) }

        // Chuyển trạng thái (chờ ↔ có dữ liệu ↔ chỉ có GPS ↔ cũ) thì làm mới ngay; còn lại tối đa 1 lần/giây.
        val mode = view.freshness to view.gpsOnly
        if (mode != lastMode) {
            lastMode = mode
            forceRefresh()
        } else {
            requestRefresh()
        }
    }

    private fun requestRefresh() {
        if (refreshScheduled) return
        val wait = MIN_REFRESH_MS - (uptime() - lastInvalidate)
        if (wait <= 0) {
            lastInvalidate = uptime()
            refreshNow()
        } else {
            refreshScheduled = true
            handler.postDelayed(refreshRunnable, wait)
        }
    }

    private fun forceRefresh() {
        if (refreshScheduled) {
            handler.removeCallbacks(refreshRunnable)
            refreshScheduled = false
        }
        // Vẫn giữ nhịp tối đa 1 lần/giây kể cả khi đổi trạng thái liên tục.
        requestRefresh()
    }

    internal fun toggleZoom() = changeSettings(settings.copy(zoom = settings.zoom.next()))

    internal fun toggleOrientation() = changeSettings(settings.copy(orientation = settings.orientation.next()))

    private fun changeSettings(s: MapViewSettings) {
        settings = s
        renderer?.setSettings(s)
        // Người lái vừa bấm: cập nhật ngay nhãn nút.
        lastInvalidate = uptime()
        invalidate()
    }

    /** Vẽ lại mẫu giao diện và (đang dẫn đường) gửi chuyến đi cho máy chủ, cùng nhịp tối đa 1 lần/giây. */
    private fun refreshNow() {
        if (navigation.isNavigating) {
            CarStateStore.snapshot.view(uptime()).state?.maneuver?.let { m ->
                navigation.updateTrip(CarTemplates.trip(carContext, m, nowEpoch()))
            }
        }
        invalidate()
    }

    override fun onGetTemplate(): Template = CarTemplates.build(
        c = carContext,
        view = CarStateStore.snapshot.view(uptime()),
        settings = settings,
        navigating = navigation.isNavigating,
        stoppedByHost = navigation.stoppedByHost,
        actions = CarTemplates.Actions(onZoom = ::toggleZoom, onOrientation = ::toggleOrientation),
        nowEpochMs = nowEpoch(),
    )

    companion object {
        const val MIN_REFRESH_MS = 1000L
    }
}
