package vn.banduong.app.bridge

/**
 * Trạng thái lái xe mà trang web gửi sang (thông điệp "state", phiên bản 1, xem BRIDGE.md).
 * Mọi trường đã được [CarStateParser] kiểm tra kiểu và giới hạn; giá trị không hợp lệ thành null hoặc bị bỏ.
 */
data class CarState(
    /** Thời điểm trang web tạo trạng thái (ms kể từ 1970, theo đồng hồ điện thoại). */
    val ts: Long,
    /** Tốc độ hiện tại, km/h; null khi chưa có. */
    val speedKmh: Double?,
    val speedSource: SpeedSource?,
    /** Giới hạn tốc độ của đoạn đường, km/h; null khi chưa có dữ liệu. */
    val limitKmh: Int?,
    val overSpeed: Boolean,
    val position: Position?,
    /** Tối đa [BridgeLimits.MAX_ALERTS] cảnh báo, gần nhất trước. */
    val alerts: List<Alert>,
    val maneuver: Maneuver?,
    /** Đoạn tuyến gần xe, tối đa [BridgeLimits.MAX_ROUTE_POINTS] điểm. */
    val route: List<LatLon>,
    /** Đường quanh xe, tối đa [BridgeLimits.MAX_ROADS] đường và [BridgeLimits.MAX_ROAD_POINTS_TOTAL] điểm. */
    val nearbyRoads: List<Road>,
    val camera: CameraStatus,
    val obd: ObdStatus,
) {
    enum class SpeedSource(val key: String) { GPS("gps"), OBD("obd") }

    enum class CameraStatus(val key: String) {
        OFF("off"), STARTING("starting"), RUNNING("running"), PAUSED("paused"), ERROR("error")
    }

    enum class ObdStatus(val key: String) {
        OFF("off"), CONNECTING("connecting"), CONNECTED("connected"), ERROR("error")
    }

    enum class AlertKind(val key: String) {
        CAMERA("camera"), TOLL("toll"), RAIL("rail"), SIGN("sign"), REPORT("report"), SPEED("speed"), OTHER("other")
    }

    enum class AlertSource(val key: String) { OSM("osm"), CAMERA("camera") }

    enum class ManeuverIcon(val key: String) {
        DEPART("depart"), STRAIGHT("straight"),
        SLIGHT_LEFT("slight-left"), LEFT("left"), SHARP_LEFT("sharp-left"),
        SLIGHT_RIGHT("slight-right"), RIGHT("right"), SHARP_RIGHT("sharp-right"),
        UTURN("uturn"), ROUNDABOUT("roundabout"), FERRY("ferry"), ARRIVE("arrive")
    }

    enum class HighwayClass(val key: String) {
        MOTORWAY("motorway"), TRUNK("trunk"), PRIMARY("primary"), SECONDARY("secondary"),
        TERTIARY("tertiary"), UNCLASSIFIED("unclassified"), RESIDENTIAL("residential"),
        LIVING_STREET("living_street"), MOTORWAY_LINK("motorway_link"), TRUNK_LINK("trunk_link"),
        PRIMARY_LINK("primary_link"), SECONDARY_LINK("secondary_link"), TERTIARY_LINK("tertiary_link"),
        OTHER("other")
    }

    data class LatLon(val lat: Double, val lon: Double)

    /**
     * [fixTs]: lúc trang nhận lần định vị này (ms kể từ 1970, đồng hồ điện thoại); null nếu trang không gửi. Nhờ nó
     * máy biết vị trí đã cũ khi trang thôi nhận định vị (bị ẩn…) mà vẫn gửi "state" đều.
     */
    data class Position(val lat: Double, val lon: Double, val heading: Double?, val accuracy: Double?, val fixTs: Long? = null)

    data class Alert(
        val kind: AlertKind,
        val code: String?,
        val text: String,
        val distanceM: Int,
        val source: AlertSource,
        /** Mã ổn định của từng điểm/biển (trang web tạo, dạng [A-Za-z0-9._:-]{1,32}); null nếu trang không gửi. */
        val id: String? = null,
    )

    /** [tripDistanceM], [tripDurationS]: quãng đường và thời gian còn lại tới đích (null nếu trang không gửi). */
    data class Maneuver(
        val text: String,
        val distanceM: Int,
        val icon: ManeuverIcon?,
        val exit: Int?,
        val tripDistanceM: Int? = null,
        val tripDurationS: Int? = null,
    )

    data class Road(val highway: HighwayClass, val points: List<LatLon>)
}

/** Giới hạn của cầu nối; BRIDGE.md ghi cùng các con số này. */
object BridgeLimits {
    const val PROTOCOL_VERSION = 1

    /** Độ dài tối đa của một thông điệp (ký tự UTF-16), kiểm tra trước khi phân tích JSON. */
    const val MAX_MESSAGE_CHARS = 128 * 1024

    const val MAX_ALERTS = 3
    const val MAX_TEXT_CHARS = 120
    const val MAX_CODE_CHARS = 32
    const val MAX_ROUTE_POINTS = 400
    const val MAX_ROADS = 60
    const val MAX_ROAD_POINTS = 400
    const val MAX_ROAD_POINTS_TOTAL = 2000

    const val MAX_SPEED_KMH = 400.0
    const val MIN_LIMIT_KMH = 5
    const val MAX_LIMIT_KMH = 200
    const val MAX_ACCURACY_M = 10_000.0
    const val MAX_ALERT_DISTANCE_M = 100_000
    const val MAX_MANEUVER_DISTANCE_M = 1_000_000
    const val MAX_ROUNDABOUT_EXIT = 20
    /** Thời gian còn lại tối đa của một chuyến (giây, 7 ngày). */
    const val MAX_TRIP_DURATION_S = 7 * 24 * 3600

    /** Lệch tối đa giữa ts và đồng hồ máy (cả hai chiều). */
    const val MAX_CLOCK_SKEW_MS = 24L * 60 * 60 * 1000

    /** Tối đa 4 thông điệp "state" mỗi giây. */
    const val STATE_RATE_PER_SEC = 4.0

    /** Các thông điệp khác (hello, keepScreenOn) cộng lại tối đa 4 mỗi giây. */
    const val CONTROL_RATE_PER_SEC = 4.0

    /** obdPick, obdConnect, obdDisconnect cộng lại tối đa 4 mỗi giây. */
    const val OBD_CONTROL_RATE_PER_SEC = 4.0

    /** obdWrite tối đa 10 mỗi giây (ObdClient gửi tối đa 6 lệnh/giây, cộng chuỗi ngắt 'X' + CR). */
    const val OBD_WRITE_RATE_PER_SEC = 10.0

    /** Thông điệp "update" (check, install, dismiss, status) cộng lại tối đa 4 mỗi giây. */
    const val UPDATE_RATE_PER_SEC = 4.0

    /** "update" với action "install": tối đa 1 lần mỗi 10 giây (mỗi lần có thể mở hộp thoại của hệ thống). */
    const val UPDATE_INSTALL_INTERVAL_S = 10.0

    /**
     * Thông điệp ngắn (≤ ký tự này: mọi thông điệp điều khiển và OBD) đi qua cổng chung riêng, rộng hơn; thông điệp
     * dài (state có tuyến đường…) đi qua cổng chung 8/giây như trước. Cả hai đều trước khi phân tích JSON.
     */
    const val SMALL_MESSAGE_CHARS = 256
    const val SMALL_GATE_RATE_PER_SEC =
        STATE_RATE_PER_SEC + CONTROL_RATE_PER_SEC + OBD_CONTROL_RATE_PER_SEC + OBD_WRITE_RATE_PER_SEC + UPDATE_RATE_PER_SEC

    /** Mã yêu cầu obdPick: số nguyên 1 … 10⁹. */
    const val MAX_OBD_REQ = 1_000_000_000
}
