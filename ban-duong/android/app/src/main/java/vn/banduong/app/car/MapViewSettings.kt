package vn.banduong.app.car

/** Cách xem bản đồ trên màn hình xe; người lái đổi bằng nút trên dải thao tác. */
data class MapViewSettings(
    val zoom: Zoom = Zoom.AUTO,
    val orientation: Orientation = Orientation.HEADING_UP,
) {
    enum class Zoom {
        /** Theo tốc độ: chạy nhanh thì nhìn xa hơn. */
        AUTO,
        NEAR,
        FAR;

        fun next(): Zoom = entries[(ordinal + 1) % entries.size]
    }

    enum class Orientation {
        /** Hướng xe chạy luôn ở phía trên. */
        HEADING_UP,
        NORTH_UP;

        fun next(): Orientation = if (this == HEADING_UP) NORTH_UP else HEADING_UP
    }
}
