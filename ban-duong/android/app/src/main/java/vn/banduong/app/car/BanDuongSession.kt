package vn.banduong.app.car

import android.content.Intent
import android.content.res.Configuration
import androidx.car.app.AppManager
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.car.map.MapRenderer

/**
 * Một phiên trên màn hình xe. Báo cho [CarStateStore] khi phiên mở/đóng (MainActivity gửi "carConnected" sang
 * trang web), lấy định vị của chính máy ([CarLocationSource]) để màn hình xe có tốc độ GPS cả khi trang web không gửi
 * được, gắn bộ vẽ bản đồ vào Surface của xe và mở [NavigationScreen].
 */
class BanDuongSession : Session() {

    private var renderer: MapRenderer? = null
    private var location: CarLocationSource? = null

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) {
                CarStateStore.carSessionStarted()
                location = CarLocationSource(carContext).also { it.start() }
            }

            override fun onStart(owner: LifecycleOwner) {
                // Người dùng có thể vừa cấp quyền vị trí trên điện thoại.
                location?.start()
            }

            override fun onDestroy(owner: LifecycleOwner) {
                location?.stop()
                location = null
                renderer?.let { r ->
                    try {
                        carContext.getCarService(AppManager::class.java).setSurfaceCallback(null)
                    } catch (_: RuntimeException) {
                    }
                    r.release()
                }
                renderer = null
                CarStateStore.carSessionEnded()
            }
        })
    }

    /** Có định vị của máy (kiểm thử). */
    internal val locationRunning: Boolean get() = location?.running == true

    override fun onCreateScreen(intent: Intent): Screen {
        val r = renderer ?: MapRenderer.create(carContext).also { renderer = it }
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(r)
        return NavigationScreen(carContext, r)
    }

    override fun onCarConfigurationChanged(newConfiguration: Configuration) {
        renderer?.setDarkMode(carContext.isDarkMode)
    }
}
