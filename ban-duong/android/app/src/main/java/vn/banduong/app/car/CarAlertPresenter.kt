package vn.banduong.app.car

import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.model.Alert
import androidx.car.app.model.AlertCallback
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarText
import androidx.car.app.versioning.CarAppApiLevels
import androidx.core.graphics.drawable.IconCompat
import vn.banduong.app.R
import vn.banduong.app.bridge.CarState

/** Bật thông báo cho cảnh báo mới trên màn hình xe. */
fun interface CarAlertPresenter {
    fun present(alert: CarState.Alert)
}

/**
 * Car API ≥ 5: dùng Alert của máy chủ (thẻ nổi, tự ẩn sau [DURATION_MS]). Máy chủ cũ hơn: CarToast.
 * Chỉ hiện câu chữ và khoảng cách; không có nút bấm nào (người lái không phải thao tác).
 */
class HostCarAlertPresenter(private val carContext: CarContext) : CarAlertPresenter {

    override fun present(alert: CarState.Alert) {
        val distance = CarFormat.distanceText(alert.distanceM) { id, args -> carContext.getString(id, *args) }
        try {
            if (apiLevel(carContext) >= CarAppApiLevels.LEVEL_5) {
                carContext.getCarService(AppManager::class.java).showAlert(build(carContext, alert, distance))
            } else {
                val text = carContext.getString(R.string.car_alert_toast, alert.text, distance)
                CarToast.makeText(carContext, text, CarToast.LENGTH_LONG).show()
            }
        } catch (_: RuntimeException) {
            // Máy chủ từ chối (HostException…): bỏ qua, màn hình bản đồ vẫn ghi cảnh báo.
        }
    }

    companion object {
        const val ALERT_ID = 1
        const val DURATION_MS = 8_000L

        fun build(carContext: CarContext, alert: CarState.Alert, distanceText: String): Alert =
            Alert.Builder(ALERT_ID, CarText.create(alert.text), DURATION_MS)
                .setSubtitle(CarText.create(carContext.getString(R.string.car_alert_subtitle, distanceText)))
                .setIcon(
                    // Biểu tượng vẽ màu trắng: tô màu để luôn tương phản với nền thẻ của máy chủ (sáng hay tối).
                    CarIcon.Builder(IconCompat.createWithResource(carContext, CarFormat.alertIconRes(alert.kind)))
                        .setTint(alertTint(alert.kind))
                        .build(),
                )
                .setCallback(object : AlertCallback {
                    override fun onCancel(reason: Int) = Unit
                    override fun onDismiss() = Unit
                })
                .build()

        /** Camera vàng như biểu tượng trên thẻ chỉ dẫn; loại khác để máy chủ chọn màu tương phản. */
        fun alertTint(kind: CarState.AlertKind): CarColor =
            if (kind == CarState.AlertKind.CAMERA || kind == CarState.AlertKind.SPEED) CarColor.YELLOW else CarColor.DEFAULT

        /** Mức Car API của máy chủ; chưa bắt tay xong (hoặc trong kiểm thử) thì coi như mức 1. */
        fun apiLevel(carContext: CarContext): Int =
            try {
                carContext.carAppApiLevel
            } catch (_: IllegalStateException) {
                CarAppApiLevels.LEVEL_1
            }
    }
}
