package vn.banduong.app.car.map

import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import vn.banduong.app.R
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.car.CarFormat
import vn.banduong.app.car.MapViewSettings
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Nhận Surface của màn hình xe (AppManager.setSurfaceCallback) và vẽ bản đồ bằng Canvas trên một luồng riêng.
 * Chỉ vẽ lại khi có dữ liệu mới, đổi cách xem, đổi vùng nhìn hoặc đổi sáng/tối; tối đa 10 khung hình/giây
 * ([MIN_FRAME_MS]), nên tốn rất ít pin và không làm nghẽn luồng chính.
 */
class MapRenderer internal constructor(
    private val painter: MapPainter,
    dark: Boolean,
    private val clock: () -> Long = SystemClock::uptimeMillis,
) : SurfaceCallback {

    private val thread = HandlerThread("BanDuongCarMap").apply { start() }
    private val handler = Handler(thread.looper)

    // Surface có thể bị huỷ (luồng chính) khi luồng vẽ đang vẽ: khoá để không vẽ lên Surface đã huỷ.
    private val lock = Any()
    private var container: SurfaceContainer? = null

    @Volatile private var visibleArea: Rect? = null
    @Volatile private var stableArea: Rect? = null
    @Volatile private var snapshot = CarStateStore.Snapshot.EMPTY
    @Volatile private var settings = MapViewSettings()
    @Volatile private var dark = dark
    @Volatile private var released = false

    // Chỉ luồng vẽ đọc/ghi.
    private var lastHeading: Double? = null

    private val frameRequested = AtomicBoolean(false)
    @Volatile private var lastFrameAt = Long.MIN_VALUE / 2

    /** Số khung hình đã vẽ (kiểm thử). */
    @Volatile
    var framesDrawn = 0
        private set

    private val drawRunnable = Runnable {
        frameRequested.set(false)
        drawFrame()
    }

    fun update(s: CarStateStore.Snapshot) {
        snapshot = s
        requestFrame()
    }

    fun setSettings(s: MapViewSettings) {
        settings = s
        requestFrame()
    }

    fun setDarkMode(d: Boolean) {
        if (dark == d) return
        dark = d
        requestFrame()
    }

    // Quy ước của SurfaceCallback (Car App Library 1.7): mọi Surface nhận được phải được release(). Làm trong khoá nên
    // luồng vẽ không bao giờ đang lockCanvas trên Surface bị nhả.
    override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
        synchronized(lock) {
            val old = container
            container = surfaceContainer
            val oldSurface = old?.surface
            if (oldSurface != null && oldSurface !== surfaceContainer.surface) releaseQuietly(oldSurface)
        }
        requestFrame()
    }

    override fun onVisibleAreaChanged(visibleArea: Rect) {
        this.visibleArea = Rect(visibleArea)
        requestFrame()
    }

    override fun onStableAreaChanged(stableArea: Rect) {
        this.stableArea = Rect(stableArea)
        requestFrame()
    }

    override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
        synchronized(lock) {
            val cur = container
            container = null
            cur?.surface?.let(::releaseQuietly)
            surfaceContainer.surface?.takeIf { it !== cur?.surface }?.let(::releaseQuietly)
        }
    }

    fun release() {
        released = true
        handler.removeCallbacksAndMessages(null)
        synchronized(lock) {
            container?.surface?.let(::releaseQuietly)
            container = null
        }
        thread.quitSafely()
    }

    private fun releaseQuietly(s: android.view.Surface) {
        try {
            s.release()
        } catch (_: RuntimeException) {
        }
    }

    private fun requestFrame() {
        if (released || !frameRequested.compareAndSet(false, true)) return
        val wait = (lastFrameAt + MIN_FRAME_MS - clock()).coerceAtLeast(0L)
        handler.postDelayed(drawRunnable, wait)
    }

    private fun drawFrame() {
        val snap = snapshot
        val state = snap.view(clock()).state
        if (state == null) lastHeading = null else state.position?.heading?.let { lastHeading = it }
        synchronized(lock) {
            val c = container ?: return
            val surface = c.surface ?: return
            if (!surface.isValid || c.width <= 0 || c.height <= 0) return
            val canvas = try {
                surface.lockCanvas(null)
            } catch (e: RuntimeException) {
                // Gồm cả Surface.OutOfResourcesException.
                Log.w(TAG, "Không khoá được Surface để vẽ", e)
                return
            }
            try {
                painter.paint(canvas, frame(c, snap))
            } catch (e: RuntimeException) {
                // Không để lỗi vẽ làm dừng ứng dụng; khung sau vẽ lại từ đầu.
                Log.w(TAG, "Lỗi khi vẽ bản đồ", e)
            } finally {
                try {
                    surface.unlockCanvasAndPost(canvas)
                } catch (_: RuntimeException) {
                }
            }
            lastFrameAt = clock()
            framesDrawn++
        }
    }

    internal fun frame(c: SurfaceContainer, snap: CarStateStore.Snapshot): MapPainter.Frame {
        val full = MapMath.Box(0f, 0f, c.width.toFloat(), c.height.toFloat())
        val box = boxOf(visibleArea, c) ?: full
        val density = if (c.dpi > 0) c.dpi / 160f else 1f
        val view = snap.view(clock())
        return MapPainter.Frame(
            width = c.width,
            height = c.height,
            visible = box,
            density = density,
            dark = dark,
            state = view.state,
            freshness = view.freshness,
            settings = settings,
            headingDeg = lastHeading,
            gpsOnly = view.gpsOnly,
            positionStale = view.positionStale,
            stable = boxOf(stableArea, c) ?: box,
        )
    }

    private fun boxOf(r: Rect?, c: SurfaceContainer): MapMath.Box? {
        val a = r?.takeIf { !it.isEmpty && it.left >= 0 && it.top >= 0 && it.right <= c.width && it.bottom <= c.height } ?: return null
        return MapMath.Box(a.left.toFloat(), a.top.toFloat(), a.right.toFloat(), a.bottom.toFloat())
    }

    companion object {
        const val MIN_FRAME_MS = 100L
        private const val TAG = "BanDuongCarMap"

        fun create(carContext: CarContext): MapRenderer {
            val texts = MapPainter.Texts(
                kmh = carContext.getString(R.string.car_unit_kmh),
                stale = carContext.getString(R.string.car_map_stale),
                speedUnknown = carContext.getString(R.string.car_map_speed_unknown),
                gpsOnly = carContext.getString(R.string.car_map_gps_only),
                positionStale = carContext.getString(R.string.car_map_position_stale),
                alertLine = { t, d ->
                    carContext.getString(
                        R.string.car_alert_line, t,
                        CarFormat.distanceText(d) { id, args -> carContext.getString(id, *args) },
                    )
                },
            )
            return MapRenderer(MapPainter(texts), carContext.isDarkMode)
        }
    }
}
