package vn.banduong.app.car.map

import vn.banduong.app.bridge.CarState
import vn.banduong.app.car.MapViewSettings
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * Phép tính hình học cho bản đồ tự vẽ: chiếu toạ độ, xoay theo hướng xe, chọn tỉ lệ, cắt đường theo khung nhìn.
 * Hàm thuần (không đụng Android), kiểm thử bằng JVM.
 *
 * Phép chiếu: mặt phẳng tiếp xúc quanh tâm (equirectangular cục bộ). Trong vài km, sai số so với Web Mercator
 * nhỏ hơn 0,1 %, đủ cho bản đồ chỉ hướng.
 */
object MapMath {
    const val M_PER_DEG_LAT = 110_574.0
    const val M_PER_DEG_LON_EQUATOR = 111_320.0

    /** Hình chữ nhật trên màn hình (pixel), trái/trên/phải/dưới. */
    data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
        val centerX: Float get() = (left + right) / 2f
        val centerY: Float get() = (top + bottom) / 2f

        fun inset(d: Float) = Box(left + d, top + d, right - d, bottom - d)
        fun contains(x: Float, y: Float) = x >= left && x <= right && y >= top && y <= bottom
    }

    /**
     * Máy quay: tâm (vị trí xe) đặt tại điểm neo ([anchorX], [anchorY]) trên màn hình, [rotationDeg] là hướng
     * (độ, 0 = bắc) được vẽ hướng lên trên, [metersPerPx] là tỉ lệ.
     */
    class Camera(
        val lat: Double,
        val lon: Double,
        val rotationDeg: Double,
        val metersPerPx: Double,
        val anchorX: Float,
        val anchorY: Float,
    ) {
        private val mPerDegLon = M_PER_DEG_LON_EQUATOR * cos(Math.toRadians(lat))
        private val cosR = cos(Math.toRadians(rotationDeg))
        private val sinR = sin(Math.toRadians(rotationDeg))

        /** Ghi (x, y) pixel của điểm vào [out] tại [offset], [offset]+1. */
        fun project(lat: Double, lon: Double, out: FloatArray, offset: Int = 0) {
            val east = (lon - this.lon) * mPerDegLon
            val north = (lat - this.lat) * M_PER_DEG_LAT
            // Xoay để hướng [rotationDeg] chỉ lên trên: thành phần ngang và thành phần "phía trước".
            val right = east * cosR - north * sinR
            val ahead = east * sinR + north * cosR
            out[offset] = (anchorX + right / metersPerPx).toFloat()
            out[offset + 1] = (anchorY - ahead / metersPerPx).toFloat()
        }

        fun projectAll(points: List<CarState.LatLon>): FloatArray {
            val out = FloatArray(points.size * 2)
            for ((i, p) in points.withIndex()) project(p.lat, p.lon, out, i * 2)
            return out
        }
    }

    /**
     * Bán kính nhìn (m) từ xe tới mép trên khung nhìn. Tự động: 250 m khi chạy chậm, xa dần theo tốc độ, tối đa
     * 1 000 m; làm tròn bước 50 m để bản đồ không nhấp nháy tỉ lệ.
     */
    fun viewRadiusMeters(zoom: MapViewSettings.Zoom, speedKmh: Double?): Double = when (zoom) {
        MapViewSettings.Zoom.NEAR -> 200.0
        MapViewSettings.Zoom.FAR -> 1_500.0
        MapViewSettings.Zoom.AUTO -> {
            val raw = if (speedKmh == null) 400.0 else (200.0 + speedKmh * 7.0).coerceIn(250.0, 1_000.0)
            (raw / 50.0).roundToLong() * 50.0
        }
    }

    /** Điểm neo của xe: theo hướng đi thì đặt thấp (nhìn xa phía trước hơn), hướng bắc thì ở giữa. */
    fun anchor(visible: Box, orientation: MapViewSettings.Orientation): Pair<Float, Float> = when (orientation) {
        MapViewSettings.Orientation.HEADING_UP -> visible.centerX to (visible.top + visible.height * 0.72f)
        MapViewSettings.Orientation.NORTH_UP -> visible.centerX to visible.centerY
    }

    /** Tỉ lệ để [radiusMeters] vừa từ điểm neo tới mép trên khung nhìn (ít nhất 40 px để tránh chia cho số nhỏ). */
    fun metersPerPixel(radiusMeters: Double, anchorY: Float, visibleTop: Float): Double =
        radiusMeters / max(40.0, (anchorY - visibleTop).toDouble())

    fun normalizeDeg(d: Double): Double {
        val r = d % 360.0
        return if (r < 0) r + 360.0 else r
    }

    /**
     * Cắt đoạn thẳng theo khung (Liang–Barsky). Trả [t0, t1] (0 ≤ t0 ≤ t1 ≤ 1) của phần nằm trong khung, hoặc
     * null nếu đoạn nằm ngoài hẳn.
     */
    fun clipSegment(x0: Float, y0: Float, x1: Float, y1: Float, box: Box): FloatArray? {
        val dx = x1 - x0
        val dy = y1 - y0
        var t0 = 0f
        var t1 = 1f
        val p = floatArrayOf(-dx, dx, -dy, dy)
        val q = floatArrayOf(x0 - box.left, box.right - x0, y0 - box.top, box.bottom - y0)
        for (i in 0 until 4) {
            if (p[i] == 0f) {
                if (q[i] < 0f) return null
            } else {
                val t = q[i] / p[i]
                if (p[i] < 0f) {
                    if (t > t1) return null
                    if (t > t0) t0 = t
                } else {
                    if (t < t0) return null
                    if (t < t1) t1 = t
                }
            }
        }
        return floatArrayOf(t0, t1)
    }

    /**
     * Cắt đường gấp khúc [xy] (x0, y0, x1, y1, …) theo khung: trả các đoạn liên tục nằm trong khung (mỗi đoạn
     * ít nhất 2 điểm). Đoạn đi ra rồi vào lại khung thành hai phần riêng.
     */
    fun clipPolyline(xy: FloatArray, box: Box): List<FloatArray> {
        val pieces = ArrayList<FloatArray>()
        val n = xy.size / 2
        if (n < 2) return pieces
        var cur: FloatList? = null
        for (i in 0 until n - 1) {
            val x0 = xy[2 * i]
            val y0 = xy[2 * i + 1]
            val x1 = xy[2 * i + 2]
            val y1 = xy[2 * i + 3]
            val t = clipSegment(x0, y0, x1, y1, box)
            if (t == null) {
                cur?.let { if (it.size >= 4) pieces += it.toArray() }
                cur = null
                continue
            }
            val sx = x0 + (x1 - x0) * t[0]
            val sy = y0 + (y1 - y0) * t[0]
            val ex = x0 + (x1 - x0) * t[1]
            val ey = y0 + (y1 - y0) * t[1]
            if (cur == null || t[0] > 0f) {
                cur?.let { if (it.size >= 4) pieces += it.toArray() }
                cur = FloatList().apply { add(sx); add(sy) }
            }
            cur.add(ex)
            cur.add(ey)
            if (t[1] < 1f) {
                if (cur.size >= 4) pieces += cur.toArray()
                cur = null
            }
        }
        cur?.let { if (it.size >= 4) pieces += it.toArray() }
        return pieces
    }

    /** Hộp bao của các điểm đã chiếu có cắt khung không (bỏ nhanh đường ở xa). */
    fun boundsIntersect(xy: FloatArray, box: Box): Boolean {
        if (xy.isEmpty()) return false
        var minX = Float.POSITIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < xy.size) {
            minX = min(minX, xy[i]); maxX = max(maxX, xy[i])
            minY = min(minY, xy[i + 1]); maxY = max(maxY, xy[i + 1])
            i += 2
        }
        return maxX >= box.left && minX <= box.right && maxY >= box.top && minY <= box.bottom
    }

    /** Mảng float tự lớn, tránh tạo nhiều đối tượng Float khi cắt đường. */
    private class FloatList {
        private var data = FloatArray(16)
        var size = 0
            private set

        fun add(v: Float) {
            if (size == data.size) data = data.copyOf(size * 2)
            data[size++] = v
        }

        fun toArray(): FloatArray = data.copyOf(size)
    }
}
