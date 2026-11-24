package vn.banduong.app.car

import android.util.Log
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.navigation.model.Trip
import java.util.concurrent.Executor

/**
 * Báo cho máy chủ Android Auto khi nào ứng dụng đang dẫn đường (navigationStarted/Ended), dựa vào việc trang
 * web có gửi chỉ dẫn rẽ (maneuver) hay không. Nếu máy chủ yêu cầu dừng (ví dụ người lái mở ứng dụng dẫn đường
 * khác), ta thôi hiện chỉ dẫn cho đến khi chuyến hiện tại kết thúc (trang web thôi gửi maneuver).
 *
 * Khi đang dẫn đường, [updateTrip] gửi bước kế tiếp và giờ đến cho máy chủ (bảng đồng hồ, màn hình phụ của xe nếu có).
 */
class NavigationController(
    private val nav: NavigationManager?,
    executor: Executor,
    private val onChanged: () -> Unit,
) {
    var isNavigating = false
        private set

    /** Máy chủ đã yêu cầu dừng dẫn đường (ứng dụng dẫn đường khác đang chỉ đường): không hiện chỉ dẫn rẽ của ta. */
    var stoppedByHost = false
        private set

    init {
        try {
            nav?.setNavigationManagerCallback(executor, object : NavigationManagerCallback {
                override fun onStopNavigation() {
                    isNavigating = false
                    stoppedByHost = true
                    onChanged()
                }
            })
        } catch (e: RuntimeException) {
            Log.w(TAG, "Không đặt được NavigationManagerCallback", e)
        }
    }

    /** Gọi mỗi khi có ảnh chụp mới hoặc dữ liệu chuyển sang cũ. */
    fun update(fresh: Boolean, hasManeuver: Boolean) {
        if (fresh && !hasManeuver) stoppedByHost = false
        val want = fresh && hasManeuver && !stoppedByHost
        if (want == isNavigating) return
        try {
            if (want) nav?.navigationStarted() else nav?.navigationEnded()
            isNavigating = want
        } catch (e: RuntimeException) {
            Log.w(TAG, "Máy chủ từ chối đổi trạng thái dẫn đường", e)
            isNavigating = false
        }
    }

    /** Gửi chuyến hiện tại cho máy chủ; chỉ khi đang dẫn đường (máy chủ từ chối nếu chưa navigationStarted). */
    fun updateTrip(trip: Trip?) {
        if (!isNavigating || trip == null) return
        try {
            nav?.updateTrip(trip)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Máy chủ không nhận thông tin chuyến đi", e)
        }
    }

    fun release() {
        update(fresh = false, hasManeuver = false)
        try {
            nav?.clearNavigationManagerCallback()
        } catch (_: RuntimeException) {
        }
    }

    companion object {
        private const val TAG = "BanDuongCarNav"
    }
}
