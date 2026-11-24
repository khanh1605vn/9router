package vn.banduong.app.bridge

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Nơi giữ trạng thái lái xe mới nhất (đã qua kiểm tra) cho màn hình ô tô, dùng chung trong cả tiến trình:
 * MainActivity (WebView) ghi vào, phiên Android Auto đọc ra. Có kèm thời điểm nhận để biết dữ liệu đã cũ.
 *
 * Ghi trên luồng chính; người nghe luôn được gọi trên luồng chính. Đọc [snapshot] được ở luồng nào cũng được
 * (ảnh chụp bất biến, biến @Volatile), luồng vẽ bản đồ dùng cách này.
 */
object CarStateStore {
    /** Sau ngần này ms không có "state" mới thì màn hình xe báo mất dữ liệu (xem BRIDGE.md). */
    const val STALE_MS = 5_000L

    /**
     * Vị trí trang gửi đã cũ hơn ngần này (tính từ lúc trang nhận lần định vị đó) thì cũng coi là mất dữ liệu: trang
     * bị ẩn (điện thoại khoá màn hình) thì WebView thôi nhận định vị nhưng vẫn có thể gửi "state" đều.
     */
    const val POSITION_STALE_MS = 10_000L

    /** Lần định vị của chính máy ([NativeFix]) cũ hơn ngần này thì không dùng nữa. */
    const val FIX_STALE_MS = 5_000L

    enum class Freshness { NONE, FRESH, STALE }

    /**
     * Lần định vị do máy tự lấy khi đang có phiên màn hình xe (vn.banduong.app.car.CarLocationSource), không qua trang
     * web: dùng khi trang không gửi được dữ liệu mới (bị ẩn, chưa mở, bị dừng). [atUptimeMs]: lúc nhận (uptime).
     */
    data class NativeFix(
        val lat: Double,
        val lon: Double,
        val headingDeg: Double?,
        val accuracyM: Double?,
        val speedKmh: Double?,
        val atUptimeMs: Long,
    )

    /**
     * Thứ màn hình xe hiện: [state] (đã ghép), độ mới, và [gpsOnly] = chỉ có định vị của máy (tốc độ GPS, vị trí,
     * đường/tuyến cũ để làm nền), không có giới hạn tốc độ, cảnh báo hay chỉ dẫn rẽ vì những thứ đó do trang tính.
     */
    data class CarView(val state: CarState?, val freshness: Freshness, val gpsOnly: Boolean)

    /** Ảnh chụp bất biến: trạng thái từ trang, thời điểm nhận (SystemClock.uptimeMillis) và định vị của máy. */
    data class Snapshot(val state: CarState?, val receivedAtUptimeMs: Long, val fix: NativeFix? = null) {
        /** Độ mới của dữ liệu từ trang: có "state" trong [STALE_MS] và vị trí trong đó chưa quá [POSITION_STALE_MS]. */
        fun freshness(nowUptimeMs: Long): Freshness = when {
            state == null -> Freshness.NONE
            nowUptimeMs - receivedAtUptimeMs > STALE_MS -> Freshness.STALE
            positionStaleAt()?.let { nowUptimeMs >= it } == true -> Freshness.STALE
            else -> Freshness.FRESH
        }

        /** Thời điểm (uptime) ảnh chụp này bắt đầu bị coi là cũ (chỉ theo thời điểm nhận). */
        val staleAtUptimeMs: Long get() = receivedAtUptimeMs + STALE_MS + 1

        /** Uptime lúc vị trí trong [state] quá [POSITION_STALE_MS]; null nếu không có vị trí hay không có fixTs. */
        private fun positionStaleAt(): Long? {
            val s = state ?: return null
            val fixTs = s.position?.fixTs ?: return null
            val ageAtReceive = (s.ts - fixTs).coerceAtLeast(0L)
            return receivedAtUptimeMs + (POSITION_STALE_MS - ageAtReceive) + 1
        }

        private fun fixFresh(nowUptimeMs: Long): Boolean = fix != null && nowUptimeMs - fix.atUptimeMs <= FIX_STALE_MS

        fun view(nowUptimeMs: Long): CarView {
            val f = freshness(nowUptimeMs)
            if (f == Freshness.FRESH) return CarView(state, f, gpsOnly = false)
            val fx = fix
            if (fx != null && fixFresh(nowUptimeMs)) return CarView(gpsOnlyState(state, fx), Freshness.FRESH, gpsOnly = true)
            return CarView(state, f, gpsOnly = false)
        }

        /** Lần sau (uptime, > now) mà [view] có thể đổi dù không có gì mới tới; null nếu không có. */
        fun nextCheckAt(nowUptimeMs: Long): Long? {
            val times = ArrayList<Long>(3)
            if (state != null) {
                times += staleAtUptimeMs
                positionStaleAt()?.let { times += it }
            }
            fix?.let { times += it.atUptimeMs + FIX_STALE_MS + 1 }
            return times.filter { it > nowUptimeMs }.minOrNull()
        }

        companion object {
            val EMPTY = Snapshot(null, 0L)

            /** Chỉ có định vị của máy: tốc độ/vị trí từ GPS; giữ đường quanh xe và tuyến cũ làm nền bản đồ. */
            fun gpsOnlyState(last: CarState?, f: NativeFix) = CarState(
                ts = last?.ts ?: 0L,
                speedKmh = f.speedKmh,
                speedSource = if (f.speedKmh != null) CarState.SpeedSource.GPS else null,
                limitKmh = null,
                overSpeed = false,
                position = CarState.Position(f.lat, f.lon, f.headingDeg, f.accuracyM),
                alerts = emptyList(),
                maneuver = null,
                route = last?.route.orEmpty(),
                nearbyRoads = last?.nearbyRoads.orEmpty(),
                camera = CarState.CameraStatus.OFF,
                obd = CarState.ObdStatus.OFF,
            )
        }
    }

    fun interface Listener {
        fun onSnapshot(snapshot: Snapshot)
    }

    fun interface CarSessionListener {
        fun onCarSessionChanged(active: Boolean)
    }

    @Volatile
    var snapshot: Snapshot = Snapshot.EMPTY
        private set

    /** Số phiên Android Auto đang mở (thường 0 hoặc 1). */
    @Volatile
    private var carSessions = 0

    val isCarSessionActive: Boolean get() = carSessions > 0

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val sessionListeners = CopyOnWriteArraySet<CarSessionListener>()
    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** Trạng thái mới từ trang web (đã kiểm tra). Mỗi lần là một ảnh chụp đầy đủ, thay hẳn ảnh trước. */
    fun update(state: CarState, uptimeMs: Long) = publish(Snapshot(state, uptimeMs, snapshot.fix))

    /** Trang nạp lại, WebView dừng hoặc ứng dụng đóng: xoá trạng thái, màn hình xe về lời nhắc mở ứng dụng. */
    fun clear(uptimeMs: Long) = publish(Snapshot(null, uptimeMs, snapshot.fix))

    /** Định vị mới của chính máy (chỉ khi có phiên màn hình xe); null: thôi dùng (phiên đóng, mất quyền…). */
    fun updateNativeFix(fix: NativeFix?) {
        val s = snapshot
        if (s.fix == fix) return
        publish(s.copy(fix = fix))
    }

    private fun publish(s: Snapshot) {
        snapshot = s
        onMain { for (l in listeners) l.onSnapshot(s) }
    }

    fun addListener(l: Listener) {
        listeners += l
    }

    fun removeListener(l: Listener) {
        listeners -= l
    }

    fun carSessionStarted() = changeSessions(+1)

    fun carSessionEnded() = changeSessions(-1)

    private fun changeSessions(delta: Int) {
        val before = carSessions > 0
        carSessions = (carSessions + delta).coerceAtLeast(0)
        val after = carSessions > 0
        if (before != after) onMain { for (l in sessionListeners) l.onCarSessionChanged(after) }
    }

    fun addCarSessionListener(l: CarSessionListener) {
        sessionListeners += l
    }

    fun removeCarSessionListener(l: CarSessionListener) {
        sessionListeners -= l
    }

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    /** Chỉ dùng trong kiểm thử. */
    fun resetForTest() {
        snapshot = Snapshot.EMPTY
        carSessions = 0
        listeners.clear()
        sessionListeners.clear()
    }
}
