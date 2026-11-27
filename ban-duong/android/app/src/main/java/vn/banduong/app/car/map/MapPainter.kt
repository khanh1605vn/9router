package vn.banduong.app.car.map

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import vn.banduong.app.bridge.CarState
import vn.banduong.app.bridge.CarStateStore.Freshness
import vn.banduong.app.car.MapViewSettings
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Vẽ một khung hình bản đồ lên Canvas của Surface màn hình xe: đường quanh xe (độ rộng/màu theo lớp đường),
 * đoạn tuyến, vòng sai số GPS, mũi tên xe theo hướng, ô tốc độ + biển giới hạn (đỏ khi quá tốc độ), thẻ cảnh báo
 * gần nhất. Chỉ chạy trên luồng vẽ của [MapRenderer]; các đối tượng Paint/Path dùng lại giữa các khung hình.
 */
class MapPainter(private val texts: Texts) {

    /** Chuỗi cần vẽ (lấy từ strings.xml lúc tạo, để lớp này không cần Context). */
    class Texts(
        val kmh: String,
        val stale: String,
        val speedUnknown: String,
        val gpsOnly: String = stale,
        val positionStale: String = stale,
        val alertLine: (text: String, distanceM: Int) -> String,
    )

    /**
     * Mọi đầu vào của một khung hình. [visible] là phần không bị thẻ/nút của máy chủ che (đổi theo lúc máy chủ hiện/ẩn
     * dải nút): dùng để đặt tâm bản đồ. [stable] là phần luôn không bị che: ô tốc độ, biển giới hạn và các thẻ chữ đặt
     * trong đó để không nhảy chỗ (rỗng thì dùng [visible]).
     */
    data class Frame(
        val width: Int,
        val height: Int,
        val visible: MapMath.Box,
        val density: Float,
        val dark: Boolean,
        /** Trạng thái đã ghép (CarStateStore.Snapshot.view). */
        val state: CarState?,
        val freshness: Freshness,
        val settings: MapViewSettings,
        /** Hướng cuối cùng biết được (dùng khi ảnh chụp mới không có hướng, ví dụ đứng yên). */
        val headingDeg: Double?,
        /** Chỉ có định vị của máy: không có giới hạn tốc độ, cảnh báo. */
        val gpsOnly: Boolean = false,
        val stable: MapMath.Box = visible,
        /** Tốc độ OBD còn mới nhưng vị trí đã cũ (mất GPS, ví dụ trong hầm): xe đứng ở vị trí cũ trên bản đồ. */
        val positionStale: Boolean = false,
    )

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val arrow = Path()
    private val rect = RectF()

    /** Camera của khung hình vừa vẽ (để kiểm thử và gỡ lỗi). */
    var lastCamera: MapMath.Camera? = null
        private set

    fun paint(canvas: Canvas, f: Frame) {
        val p = MapStyle.palette(f.dark)
        canvas.drawColor(p.background)
        lastCamera = null
        val state = f.state ?: return
        val dp = f.density

        val pos = state.position
        val centerLat = pos?.lat ?: state.route.firstOrNull()?.lat ?: state.nearbyRoads.firstOrNull()?.points?.firstOrNull()?.lat
        val centerLon = pos?.lon ?: state.route.firstOrNull()?.lon ?: state.nearbyRoads.firstOrNull()?.points?.firstOrNull()?.lon
        if (centerLat != null && centerLon != null) {
            val headingUp = f.settings.orientation == MapViewSettings.Orientation.HEADING_UP
            val rotation = if (headingUp) f.headingDeg ?: 0.0 else 0.0
            val (ax, ay) = if (pos != null) {
                MapMath.anchor(f.visible, f.settings.orientation)
            } else {
                f.visible.centerX to f.visible.centerY
            }
            val radius = MapMath.viewRadiusMeters(f.settings.zoom, state.speedKmh)
            val mpp = MapMath.metersPerPixel(radius, ay, f.visible.top)
            val cam = MapMath.Camera(centerLat, centerLon, rotation, mpp, ax, ay)
            lastCamera = cam
            val clip = MapMath.Box(0f, 0f, f.width.toFloat(), f.height.toFloat()).inset(-24f * dp)

            drawRoads(canvas, cam, clip, state.nearbyRoads, p, dp)
            drawLine(canvas, cam, clip, state.route, MapStyle.ROUTE_WIDTH_DP * dp, p.routeCasing, p.route, dp)

            if (pos != null) {
                pos.accuracy?.let { acc ->
                    val r = (acc / mpp).toFloat()
                    if (r > 10f * dp && r < min(f.width, f.height) * 0.5f) {
                        fill.color = p.accuracy
                        canvas.drawCircle(ax, ay, r, fill)
                    }
                }
                drawVehicle(canvas, ax, ay, pos.heading?.let { it - rotation }, p, dp)
            }
        }

        val box = f.stable
        val stale = f.freshness == Freshness.STALE
        val pillY = box.top + 28f * dp
        val pillW = box.width - 32f * dp
        when {
            stale -> {
                canvas.drawColor(p.staleWash)
                drawPill(canvas, texts.stale, box.centerX, pillY, pillW, p.panel, p.panelText, 16f * dp, dp)
            }
            f.gpsOnly -> drawPill(canvas, texts.gpsOnly, box.centerX, pillY, pillW, p.panel, p.panelText, 16f * dp, dp)
            else -> {
                val a = state.alerts.firstOrNull()
                if (a != null) {
                    drawPill(canvas, texts.alertLine(a.text, a.distanceM), box.centerX, pillY, pillW, p.alertPanel, p.alertText, 16f * dp, dp)
                } else if (f.positionStale) {
                    drawPill(canvas, texts.positionStale, box.centerX, pillY, pillW, p.panel, p.panelText, 16f * dp, dp)
                }
            }
        }
        // Dữ liệu cũ: không vẽ tốc độ, màu quá tốc độ hay biển giới hạn của ảnh chụp cũ như thể đang đúng.
        drawSpeed(canvas, state, box, stale, p, dp)
    }

    private fun drawRoads(canvas: Canvas, cam: MapMath.Camera, clip: MapMath.Box, roads: List<CarState.Road>, p: MapStyle.Palette, dp: Float) {
        if (roads.isEmpty()) return
        val sorted = roads.sortedBy { MapStyle.roadStyle(it.highway).zOrder }
        val paths = ArrayList<Pair<MapStyle.RoadStyle, Path>>(sorted.size)
        for (r in sorted) {
            val path = pathFor(cam, clip, r.points) ?: continue
            paths += MapStyle.roadStyle(r.highway) to path
        }
        // Viền trước cho mọi đường, rồi mới tô: chỗ giao nhau liền mạch.
        stroke.color = p.roadCasing
        for ((s, path) in paths) {
            stroke.strokeWidth = (s.widthDp + MapStyle.CASING_EXTRA_DP) * dp
            canvas.drawPath(path, stroke)
        }
        for ((s, path) in paths) {
            stroke.color = MapStyle.roadColor(p, s.tier)
            stroke.strokeWidth = s.widthDp * dp
            canvas.drawPath(path, stroke)
        }
    }

    private fun drawLine(canvas: Canvas, cam: MapMath.Camera, clip: MapMath.Box, pts: List<CarState.LatLon>, width: Float, casing: Int, color: Int, dp: Float) {
        val path = pathFor(cam, clip, pts) ?: return
        stroke.color = casing
        stroke.strokeWidth = width + MapStyle.CASING_EXTRA_DP * dp
        canvas.drawPath(path, stroke)
        stroke.color = color
        stroke.strokeWidth = width
        canvas.drawPath(path, stroke)
    }

    private fun pathFor(cam: MapMath.Camera, clip: MapMath.Box, pts: List<CarState.LatLon>): Path? {
        if (pts.size < 2) return null
        val xy = cam.projectAll(pts)
        if (!MapMath.boundsIntersect(xy, clip)) return null
        val pieces = MapMath.clipPolyline(xy, clip)
        if (pieces.isEmpty()) return null
        val path = Path()
        for (piece in pieces) {
            path.moveTo(piece[0], piece[1])
            var i = 2
            while (i < piece.size) {
                path.lineTo(piece[i], piece[i + 1])
                i += 2
            }
        }
        return path
    }

    /** Mũi tên xe; [relHeading] là góc so với phía trên màn hình (null: chưa biết hướng thì vẽ chấm tròn). */
    private fun drawVehicle(canvas: Canvas, x: Float, y: Float, relHeading: Double?, p: MapStyle.Palette, dp: Float) {
        if (relHeading == null) {
            fill.color = p.vehicleOutline
            canvas.drawCircle(x, y, 11f * dp, fill)
            fill.color = p.vehicle
            canvas.drawCircle(x, y, 8f * dp, fill)
            return
        }
        arrow.reset()
        arrow.moveTo(0f, -16f * dp)
        arrow.lineTo(11f * dp, 12f * dp)
        arrow.lineTo(0f, 6f * dp)
        arrow.lineTo(-11f * dp, 12f * dp)
        arrow.close()
        canvas.save()
        canvas.translate(x, y)
        canvas.rotate(relHeading.toFloat())
        stroke.color = p.vehicleOutline
        stroke.strokeWidth = 3f * dp
        canvas.drawPath(arrow, stroke)
        fill.color = p.vehicle
        canvas.drawPath(arrow, fill)
        canvas.restore()
    }

    /**
     * Góc dưới bên trái vùng ổn định: biển giới hạn (tròn viền đỏ) và ô tốc độ hiện tại (đỏ khi quá tốc độ).
     * [stale]: chỉ vẽ ô "–", không màu quá tốc độ, không biển giới hạn.
     */
    private fun drawSpeed(canvas: Canvas, s: CarState, area: MapMath.Box, stale: Boolean, p: MapStyle.Palette, dp: Float) {
        val margin = 12f * dp
        val boxW = 84f * dp
        val boxH = 64f * dp
        val left = area.left + margin
        val bottom = area.bottom - margin
        val over = s.overSpeed && !stale
        rect.set(left, bottom - boxH, left + boxW, bottom)
        fill.color = if (over) p.overSpeed else p.panel
        canvas.drawRoundRect(rect, 12f * dp, 12f * dp, fill)
        text.color = if (over) p.overSpeedText else p.panelText
        val speed = s.speedKmh?.takeIf { !stale }?.roundToInt()?.toString() ?: texts.speedUnknown
        text.textSize = 30f * dp
        canvas.drawText(speed, rect.centerX(), rect.top + 36f * dp, text)
        text.textSize = 13f * dp
        canvas.drawText(texts.kmh, rect.centerX(), rect.top + 55f * dp, text)

        if (stale) return
        val limit = s.limitKmh ?: return
        val r = 30f * dp
        val cx = rect.right + margin + r
        val cy = rect.centerY()
        fill.color = 0xFFFFFFFF.toInt()
        canvas.drawCircle(cx, cy, r, fill)
        stroke.color = 0xFFD32F2F.toInt()
        stroke.strokeWidth = 6f * dp
        canvas.drawCircle(cx, cy, r - 3f * dp, stroke)
        text.color = 0xFF111111.toInt()
        text.textSize = (if (limit >= 100) 20f else 24f) * dp
        canvas.drawText(limit.toString(), cx, cy - (text.ascent() + text.descent()) / 2f, text)
    }

    /** Thẻ chữ một dòng ở giữa, cắt bớt kèm dấu "…" nếu quá rộng. */
    private fun drawPill(canvas: Canvas, s: String, cx: Float, cy: Float, maxWidth: Float, bg: Int, fg: Int, size: Float, dp: Float) {
        if (maxWidth <= 40f * dp) return
        text.textSize = size
        text.color = fg
        val pad = 12f * dp
        val line = ellipsize(s, maxWidth - 2 * pad)
        val w = text.measureText(line) + 2 * pad
        val h = size + 16f * dp
        rect.set(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f)
        fill.color = bg
        canvas.drawRoundRect(rect, h / 2f, h / 2f, fill)
        canvas.drawText(line, cx, cy - (text.ascent() + text.descent()) / 2f, text)
    }

    private fun ellipsize(s: String, maxWidth: Float): String {
        if (text.measureText(s) <= maxWidth) return s
        val ell = "…"
        val n = text.breakText(s, true, (maxWidth - text.measureText(ell)).coerceAtLeast(0f), null)
        var end = n.coerceIn(0, s.length)
        if (end > 0 && Character.isHighSurrogate(s[end - 1])) end--
        return s.substring(0, end).trimEnd() + ell
    }
}
