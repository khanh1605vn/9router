package vn.banduong.app.car

import androidx.car.app.model.Distance
import androidx.car.app.navigation.model.Maneuver
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.bridge.CarState.ManeuverIcon

@RunWith(RobolectricTestRunner::class)
class CarFormatTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
    private fun text(m: Int) = CarFormat.distanceText(m) { id, args -> ctx.getString(id, *args) }

    @Test
    fun roundingSteps() {
        val cases = mapOf(
            0 to (0.0 to Distance.UNIT_METERS), 4 to (0.0 to Distance.UNIT_METERS), 45 to (50.0 to Distance.UNIT_METERS),
            94 to (90.0 to Distance.UNIT_METERS), 99 to (100.0 to Distance.UNIT_METERS), 120 to (100.0 to Distance.UNIT_METERS),
            130 to (150.0 to Distance.UNIT_METERS), 974 to (950.0 to Distance.UNIT_METERS),
            980 to (1.0 to Distance.UNIT_KILOMETERS_P1), 1240 to (1.2 to Distance.UNIT_KILOMETERS_P1),
            9_960 to (10.0 to Distance.UNIT_KILOMETERS_P1), 10_000 to (10.0 to Distance.UNIT_KILOMETERS),
            123_456 to (123.0 to Distance.UNIT_KILOMETERS), -5 to (0.0 to Distance.UNIT_METERS),
        )
        for ((m, exp) in cases) {
            val r = CarFormat.roundDistance(m)
            assertEquals("$m m", exp.first, r.value, 1e-9)
            assertEquals("$m m", exp.second, r.unit)
        }
        val d = CarFormat.routingDistance(1240)
        assertEquals(1.2, d.displayDistance, 1e-9)
        assertEquals(Distance.UNIT_KILOMETERS_P1, d.displayUnit)
    }

    @Test
    fun vietnameseDistanceText() {
        assertEquals("300 m", text(300))
        assertEquals("1,2 km", text(1240))
        assertEquals("1 km", text(1000))
        assertEquals("15 km", text(15_200))
    }

    @Test
    fun maneuverMappingForRightHandTraffic() {
        val expected = mapOf(
            ManeuverIcon.DEPART to Maneuver.TYPE_DEPART,
            ManeuverIcon.STRAIGHT to Maneuver.TYPE_STRAIGHT,
            ManeuverIcon.SLIGHT_LEFT to Maneuver.TYPE_TURN_SLIGHT_LEFT,
            ManeuverIcon.LEFT to Maneuver.TYPE_TURN_NORMAL_LEFT,
            ManeuverIcon.SHARP_LEFT to Maneuver.TYPE_TURN_SHARP_LEFT,
            ManeuverIcon.SLIGHT_RIGHT to Maneuver.TYPE_TURN_SLIGHT_RIGHT,
            ManeuverIcon.RIGHT to Maneuver.TYPE_TURN_NORMAL_RIGHT,
            ManeuverIcon.SHARP_RIGHT to Maneuver.TYPE_TURN_SHARP_RIGHT,
            ManeuverIcon.UTURN to Maneuver.TYPE_U_TURN_LEFT,
            ManeuverIcon.ROUNDABOUT to Maneuver.TYPE_ROUNDABOUT_ENTER_CCW,
            ManeuverIcon.FERRY to Maneuver.TYPE_FERRY_BOAT,
            ManeuverIcon.ARRIVE to Maneuver.TYPE_DESTINATION,
        )
        assertEquals(ManeuverIcon.entries.toSet(), expected.keys)
        for ((icon, type) in expected) {
            assertEquals(icon.key, type, CarFormat.maneuverType(icon, null))
            // Mọi loại đều có hình vẽ tồn tại.
            ctx.resources.getResourceName(CarFormat.maneuverIconRes(icon))
        }
        assertEquals(Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW, CarFormat.maneuverType(ManeuverIcon.ROUNDABOUT, 2))
        assertEquals(Maneuver.TYPE_ROUNDABOUT_ENTER_CCW, CarFormat.maneuverType(ManeuverIcon.ROUNDABOUT, 0))
        assertEquals(Maneuver.TYPE_UNKNOWN, CarFormat.maneuverType(null, null))
    }
}
