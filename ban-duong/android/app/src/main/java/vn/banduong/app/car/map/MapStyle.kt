package vn.banduong.app.car.map

import vn.banduong.app.bridge.CarState.HighwayClass

/**
 * Màu và độ rộng nét cho bản đồ tự vẽ. Hai bảng màu sáng/tối theo chế độ của xe (CarContext.isDarkMode);
 * màn hình xe thường ở chế độ tối vào ban đêm, nên nền tối và đường sáng vừa đủ, không chói.
 */
object MapStyle {

    data class Palette(
        val background: Int,
        val roadCasing: Int,
        val roadMajor: Int,
        val roadMedium: Int,
        val roadMinor: Int,
        val routeCasing: Int,
        val route: Int,
        val vehicle: Int,
        val vehicleOutline: Int,
        val accuracy: Int,
        val staleWash: Int,
        val panel: Int,
        val panelText: Int,
        val alertPanel: Int,
        val alertText: Int,
        val overSpeed: Int,
        val overSpeedText: Int,
    )

    val LIGHT = Palette(
        background = 0xFFEDEAE2.toInt(),
        roadCasing = 0xFFB9B3A6.toInt(),
        roadMajor = 0xFFFFC94D.toInt(),
        roadMedium = 0xFFFFF0B8.toInt(),
        roadMinor = 0xFFFFFFFF.toInt(),
        routeCasing = 0xFF0B4A8F.toInt(),
        route = 0xFF1E88E5.toInt(),
        vehicle = 0xFF0A57A4.toInt(),
        vehicleOutline = 0xFFFFFFFF.toInt(),
        accuracy = 0x331E88E5,
        staleWash = 0x99EDEAE2.toInt(),
        panel = 0xF2FFFFFF.toInt(),
        panelText = 0xFF1A1A1A.toInt(),
        alertPanel = 0xF2FFF3C4.toInt(),
        alertText = 0xFF3A2E00.toInt(),
        overSpeed = 0xFFD32F2F.toInt(),
        overSpeedText = 0xFFFFFFFF.toInt(),
    )

    val DARK = Palette(
        background = 0xFF1B1E23.toInt(),
        roadCasing = 0xFF0E1013.toInt(),
        roadMajor = 0xFF8A6D2B.toInt(),
        roadMedium = 0xFF5B5F66.toInt(),
        roadMinor = 0xFF3D4148.toInt(),
        routeCasing = 0xFF0B2F5C.toInt(),
        route = 0xFF4DA3FF.toInt(),
        vehicle = 0xFF4DA3FF.toInt(),
        vehicleOutline = 0xFFFFFFFF.toInt(),
        accuracy = 0x334DA3FF,
        staleWash = 0x991B1E23.toInt(),
        panel = 0xE6202429.toInt(),
        panelText = 0xFFF2F2F2.toInt(),
        alertPanel = 0xE63A3000.toInt(),
        alertText = 0xFFFFE9A6.toInt(),
        overSpeed = 0xFFE53935.toInt(),
        overSpeedText = 0xFFFFFFFF.toInt(),
    )

    fun palette(dark: Boolean): Palette = if (dark) DARK else LIGHT

    enum class Tier { MAJOR, MEDIUM, MINOR }

    /** Kiểu nét của một lớp đường: độ rộng (dp), nhóm màu, thứ tự vẽ (nhỏ vẽ trước, nằm dưới). */
    data class RoadStyle(val widthDp: Float, val tier: Tier, val zOrder: Int)

    fun roadStyle(h: HighwayClass): RoadStyle = when (h) {
        HighwayClass.MOTORWAY -> RoadStyle(10f, Tier.MAJOR, 9)
        HighwayClass.TRUNK -> RoadStyle(9f, Tier.MAJOR, 8)
        HighwayClass.PRIMARY -> RoadStyle(8f, Tier.MAJOR, 7)
        HighwayClass.MOTORWAY_LINK, HighwayClass.TRUNK_LINK, HighwayClass.PRIMARY_LINK -> RoadStyle(5f, Tier.MAJOR, 6)
        HighwayClass.SECONDARY -> RoadStyle(7f, Tier.MEDIUM, 5)
        HighwayClass.TERTIARY -> RoadStyle(6f, Tier.MEDIUM, 4)
        HighwayClass.SECONDARY_LINK, HighwayClass.TERTIARY_LINK -> RoadStyle(4.5f, Tier.MEDIUM, 3)
        HighwayClass.UNCLASSIFIED, HighwayClass.RESIDENTIAL -> RoadStyle(4.5f, Tier.MINOR, 2)
        HighwayClass.LIVING_STREET -> RoadStyle(3.5f, Tier.MINOR, 1)
        HighwayClass.OTHER -> RoadStyle(3f, Tier.MINOR, 0)
    }

    fun roadColor(p: Palette, tier: Tier): Int = when (tier) {
        Tier.MAJOR -> p.roadMajor
        Tier.MEDIUM -> p.roadMedium
        Tier.MINOR -> p.roadMinor
    }

    const val ROUTE_WIDTH_DP = 9f
    const val CASING_EXTRA_DP = 2f
}
