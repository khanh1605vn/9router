package vn.banduong.app.car

import androidx.car.app.model.Distance
import androidx.car.app.navigation.model.Maneuver
import vn.banduong.app.R
import vn.banduong.app.bridge.CarState
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Hàm thuần (không cần CarContext) để đổi dữ liệu của trang web sang kiểu của Car App Library. */
object CarFormat {

    /** Khoảng cách đã làm tròn để hiển thị: dưới 100 m theo bước 10 m, dưới 1 km theo bước 50 m, rồi km. */
    data class Rounded(val value: Double, val unit: Int) {
        val isKm: Boolean get() = unit != Distance.UNIT_METERS
    }

    fun roundDistance(meters: Int): Rounded {
        val m = meters.coerceAtLeast(0)
        if (m < 100) return Rounded(((m / 10.0).roundToLong() * 10).toDouble(), Distance.UNIT_METERS)
        val step50 = (m / 50.0).roundToLong() * 50
        if (step50 < 1000) return Rounded(step50.toDouble(), Distance.UNIT_METERS)
        val km = m / 1000.0
        return if (km < 10) {
            Rounded((km * 10).roundToLong() / 10.0, Distance.UNIT_KILOMETERS_P1)
        } else {
            Rounded(km.roundToLong().toDouble(), Distance.UNIT_KILOMETERS)
        }
    }

    /** Khoảng cách cho RoutingInfo (máy chủ tự ghi đơn vị theo ngôn ngữ của xe). */
    fun routingDistance(meters: Int): Distance {
        val r = roundDistance(meters)
        return Distance.create(r.value, r.unit)
    }

    /** Chuỗi khoảng cách tiếng Việt: "300 m", "1,2 km", "15 km" (dấu phẩy thập phân). */
    fun distanceText(meters: Int, getString: (Int, Array<out Any>) -> String): String {
        val r = roundDistance(meters)
        if (!r.isKm) return getString(R.string.car_distance_m, arrayOf(r.value.roundToInt()))
        val num = if (r.unit == Distance.UNIT_KILOMETERS_P1) {
            val tenths = (r.value * 10).roundToInt()
            if (tenths % 10 == 0) "${tenths / 10}" else "${tenths / 10},${tenths % 10}"
        } else {
            "${r.value.roundToInt()}"
        }
        return getString(R.string.car_distance_km, arrayOf(num))
    }

    /**
     * Loại chỉ dẫn rẽ cho Car App Library. Việt Nam đi bên phải: quay đầu là quay sang trái, vòng xuyến đi
     * ngược chiều kim đồng hồ.
     */
    fun maneuverType(icon: CarState.ManeuverIcon?, exit: Int?): Int = when (icon) {
        null -> Maneuver.TYPE_UNKNOWN
        CarState.ManeuverIcon.DEPART -> Maneuver.TYPE_DEPART
        CarState.ManeuverIcon.STRAIGHT -> Maneuver.TYPE_STRAIGHT
        CarState.ManeuverIcon.SLIGHT_LEFT -> Maneuver.TYPE_TURN_SLIGHT_LEFT
        CarState.ManeuverIcon.LEFT -> Maneuver.TYPE_TURN_NORMAL_LEFT
        CarState.ManeuverIcon.SHARP_LEFT -> Maneuver.TYPE_TURN_SHARP_LEFT
        CarState.ManeuverIcon.SLIGHT_RIGHT -> Maneuver.TYPE_TURN_SLIGHT_RIGHT
        CarState.ManeuverIcon.RIGHT -> Maneuver.TYPE_TURN_NORMAL_RIGHT
        CarState.ManeuverIcon.SHARP_RIGHT -> Maneuver.TYPE_TURN_SHARP_RIGHT
        CarState.ManeuverIcon.UTURN -> Maneuver.TYPE_U_TURN_LEFT
        CarState.ManeuverIcon.ROUNDABOUT ->
            if (exit != null && exit >= 1) Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW else Maneuver.TYPE_ROUNDABOUT_ENTER_CCW
        CarState.ManeuverIcon.FERRY -> Maneuver.TYPE_FERRY_BOAT
        CarState.ManeuverIcon.ARRIVE -> Maneuver.TYPE_DESTINATION
    }

    /** Hình vẽ cho từng loại chỉ dẫn (vector trong res/drawable). */
    fun maneuverIconRes(icon: CarState.ManeuverIcon?): Int = when (icon) {
        null, CarState.ManeuverIcon.DEPART -> R.drawable.ic_maneuver_depart
        CarState.ManeuverIcon.STRAIGHT -> R.drawable.ic_maneuver_straight
        CarState.ManeuverIcon.SLIGHT_LEFT -> R.drawable.ic_maneuver_slight_left
        CarState.ManeuverIcon.LEFT -> R.drawable.ic_maneuver_left
        CarState.ManeuverIcon.SHARP_LEFT -> R.drawable.ic_maneuver_sharp_left
        CarState.ManeuverIcon.SLIGHT_RIGHT -> R.drawable.ic_maneuver_slight_right
        CarState.ManeuverIcon.RIGHT -> R.drawable.ic_maneuver_right
        CarState.ManeuverIcon.SHARP_RIGHT -> R.drawable.ic_maneuver_sharp_right
        CarState.ManeuverIcon.UTURN -> R.drawable.ic_maneuver_uturn
        CarState.ManeuverIcon.ROUNDABOUT -> R.drawable.ic_maneuver_roundabout
        CarState.ManeuverIcon.FERRY -> R.drawable.ic_maneuver_ferry
        CarState.ManeuverIcon.ARRIVE -> R.drawable.ic_maneuver_arrive
    }

    fun alertIconRes(kind: CarState.AlertKind): Int = when (kind) {
        CarState.AlertKind.CAMERA -> R.drawable.ic_alert_camera
        else -> R.drawable.ic_alert_warning
    }
}
