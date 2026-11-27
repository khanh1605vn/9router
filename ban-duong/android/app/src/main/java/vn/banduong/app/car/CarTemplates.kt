package vn.banduong.app.car

import android.content.Context
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.navigation.model.Destination
import androidx.car.app.navigation.model.TravelEstimate
import androidx.car.app.navigation.model.Trip
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.core.graphics.drawable.IconCompat
import vn.banduong.app.R
import vn.banduong.app.bridge.CarState
import vn.banduong.app.bridge.CarStateStore.CarView
import vn.banduong.app.bridge.CarStateStore.Freshness
import java.util.TimeZone
import kotlin.math.roundToInt

/**
 * Dựng NavigationTemplate (Car API 1, chạy trên mọi máy chủ Android Auto) từ ảnh chụp trạng thái.
 * Bản đồ do ứng dụng tự vẽ lên Surface ([vn.banduong.app.car.map.MapRenderer]); mẫu này chỉ có thẻ chỉ dẫn và
 * dải thao tác. Không có danh sách, không có ô nhập chữ (quy định chống phân tâm khi lái).
 */
object CarTemplates {

    data class Actions(val onZoom: () -> Unit, val onOrientation: () -> Unit)

    /**
     * [navigating]: đã báo máy chủ navigationStarted; [stoppedByHost]: máy chủ đã yêu cầu dừng (ứng dụng dẫn đường
     * khác đang chỉ đường) nên không hiện chỉ dẫn rẽ của ta, kể cả dạng chữ. [nowEpochMs]: giờ đồng hồ, cho giờ đến.
     */
    fun build(
        c: Context,
        view: CarView,
        settings: MapViewSettings,
        navigating: Boolean,
        stoppedByHost: Boolean,
        actions: Actions,
        nowEpochMs: Long = System.currentTimeMillis(),
    ): NavigationTemplate {
        val b = NavigationTemplate.Builder().setActionStrip(actionStrip(c, settings, actions))
        val state = view.state
        when (view.freshness) {
            Freshness.NONE -> b.setNavigationInfo(
                MessageInfo.Builder(c.getString(R.string.car_waiting_title))
                    .setText(c.getString(R.string.car_waiting))
                    .setImage(icon(c, R.drawable.ic_phone))
                    .build(),
            )
            Freshness.STALE -> b.setNavigationInfo(
                MessageInfo.Builder(c.getString(R.string.car_stale_title))
                    .setText(c.getString(R.string.car_stale))
                    .setImage(icon(c, R.drawable.ic_phone))
                    .build(),
            )
            Freshness.FRESH -> {
                val m = state!!.maneuver
                if (navigating && m != null) {
                    b.setNavigationInfo(routingInfo(c, m))
                    tripEstimate(m, nowEpochMs)?.let { b.setDestinationTravelEstimate(it.destination) }
                } else {
                    b.setNavigationInfo(drivingInfo(c, state, gpsOnly = view.gpsOnly, showManeuver = !stoppedByHost))
                }
            }
        }
        return b.build()
    }

    /** Thẻ chỉ dẫn rẽ: câu chữ của trang web, mũi tên theo loại rẽ, khoảng cách tới điểm rẽ. */
    fun routingInfo(c: Context, m: CarState.Maneuver): RoutingInfo =
        RoutingInfo.Builder().setCurrentStep(step(c, m), CarFormat.routingDistance(m.distanceM)).build()

    private fun step(c: Context, m: CarState.Maneuver): Step {
        val type = CarFormat.maneuverType(m.icon, m.exit)
        val mb = Maneuver.Builder(type).setIcon(icon(c, CarFormat.maneuverIconRes(m.icon), tint = null))
        if (type == Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW) mb.setRoundaboutExitNumber(m.exit!!)
        return Step.Builder(m.text).setManeuver(mb.build()).build()
    }

    /** Ước lượng tới bước kế tiếp và tới đích; null nếu trang không gửi quãng đường/thời gian còn lại. */
    class TripEstimate(val step: TravelEstimate, val destination: TravelEstimate)

    fun tripEstimate(m: CarState.Maneuver, nowEpochMs: Long): TripEstimate? {
        val dist = m.tripDistanceM ?: return null
        val dur = m.tripDurationS ?: return null
        val zone = TimeZone.getDefault()
        // Thời gian tới bước kế tiếp: chia theo tỉ lệ quãng đường (trang chỉ gửi thời gian của cả chuyến).
        val stepDist = m.distanceM.coerceAtMost(dist)
        val stepDur = if (dist > 0) (dur.toLong() * stepDist / dist) else 0L
        fun estimate(meters: Int, seconds: Long) =
            TravelEstimate.Builder(CarFormat.routingDistance(meters), DateTimeWithZone.create(nowEpochMs + seconds * 1000, zone))
                .setRemainingTimeSeconds(seconds)
                .build()
        return TripEstimate(estimate(stepDist, stepDur), estimate(dist, dur.toLong()))
    }

    /** Chuyến đi cho máy chủ (NavigationManager.updateTrip: bảng đồng hồ, màn hình phụ); null nếu thiếu dữ liệu. */
    fun trip(c: Context, m: CarState.Maneuver, nowEpochMs: Long = System.currentTimeMillis()): Trip? {
        val est = tripEstimate(m, nowEpochMs) ?: return null
        val dest = Destination.Builder().setName(c.getString(R.string.car_destination)).build()
        return Trip.Builder()
            .addStep(step(c, m), est.step)
            .addDestination(dest, est.destination)
            .build()
    }

    /**
     * Khi không dẫn đường: dòng tốc độ/giới hạn và cảnh báo gần nhất (hoặc chỉ dẫn rẽ dạng chữ nếu [showManeuver]).
     * [gpsOnly]: chỉ có định vị của máy, nên không nói "không có cảnh báo" mà nhắc mở ứng dụng khi đã dừng xe an toàn.
     */
    fun drivingInfo(c: Context, s: CarState, gpsOnly: Boolean = false, showManeuver: Boolean = true): MessageInfo {
        val speed = s.speedKmh?.let { c.getString(R.string.car_speed, it.roundToInt()) } ?: c.getString(R.string.car_speed_unknown)
        val limit = s.limitKmh?.let { c.getString(R.string.car_limit, it) } ?: c.getString(R.string.car_limit_unknown)
        val title = c.getString(if (s.overSpeed) R.string.car_over_speed_line else R.string.car_speed_line, speed, limit)
        val dist = { m: Int -> CarFormat.distanceText(m) { id, args -> c.getString(id, *args) } }
        val alert = s.alerts.firstOrNull()
        val m = s.maneuver?.takeIf { showManeuver }
        val text = when {
            gpsOnly -> c.getString(R.string.car_gps_only)
            alert != null -> c.getString(R.string.car_alert_line, alert.text, dist(alert.distanceM))
            m != null -> c.getString(R.string.car_maneuver_line, m.text, dist(m.distanceM))
            else -> c.getString(R.string.car_no_alert)
        }
        val image = when {
            s.overSpeed -> icon(c, R.drawable.ic_speed, CarColor.RED)
            alert != null -> icon(c, CarFormat.alertIconRes(alert.kind), CarColor.YELLOW)
            else -> icon(c, R.drawable.ic_speed)
        }
        return MessageInfo.Builder(title).setText(text).setImage(image).build()
    }

    private fun actionStrip(c: Context, settings: MapViewSettings, actions: Actions): ActionStrip {
        val zoomTitle = when (settings.zoom) {
            MapViewSettings.Zoom.AUTO -> R.string.car_action_zoom_auto
            MapViewSettings.Zoom.NEAR -> R.string.car_action_zoom_near
            MapViewSettings.Zoom.FAR -> R.string.car_action_zoom_far
        }
        val orientationTitle = when (settings.orientation) {
            MapViewSettings.Orientation.HEADING_UP -> R.string.car_action_heading_up
            MapViewSettings.Orientation.NORTH_UP -> R.string.car_action_north_up
        }
        return ActionStrip.Builder()
            .addAction(
                Action.Builder()
                    .setTitle(c.getString(zoomTitle))
                    .setIcon(icon(c, R.drawable.ic_action_zoom))
                    .setOnClickListener { actions.onZoom() }
                    .build(),
            )
            .addAction(
                Action.Builder()
                    .setTitle(c.getString(orientationTitle))
                    .setIcon(icon(c, R.drawable.ic_action_compass))
                    .setOnClickListener { actions.onOrientation() }
                    .build(),
            )
            .build()
    }

    private fun icon(c: Context, res: Int, tint: CarColor? = CarColor.DEFAULT): CarIcon {
        val b = CarIcon.Builder(IconCompat.createWithResource(c, res))
        if (tint != null) b.setTint(tint)
        return b.build()
    }
}
