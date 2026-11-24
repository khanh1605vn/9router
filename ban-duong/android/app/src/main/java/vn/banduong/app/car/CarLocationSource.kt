package vn.banduong.app.car

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import vn.banduong.app.bridge.CarStateStore

/**
 * Định vị của chính máy cho màn hình xe, chạy trong phiên Android Auto (không cần trang web): khi điện thoại khoá màn
 * hình, mở ứng dụng khác hay chưa mở Bạn Đường, WebView thôi nhận định vị, nhưng màn hình xe vẫn có tốc độ GPS và vị
 * trí trên bản đồ ([CarStateStore.Snapshot.view], chế độ "chỉ có GPS").
 *
 * Máy chủ Android Auto gắn vào CarAppService kèm quyền dùng định vị "khi đang dùng ứng dụng" của nó, nên lấy được vị trí
 * trong suốt phiên mà không cần dịch vụ chạy nền. Chỉ dùng quyền vị trí người dùng đã cấp trên điện thoại; không có
 * quyền thì không làm gì (màn hình xe vẫn chờ dữ liệu từ trang). Chỉ giữ lần định vị mới nhất trong bộ nhớ.
 */
class CarLocationSource(
    private val context: Context,
    private val uptime: () -> Long = SystemClock::uptimeMillis,
    private val elapsedNanos: () -> Long = SystemClock::elapsedRealtimeNanos,
) {
    private var lm: LocationManager? = null
    private val listener = LocationListenerCompat { loc -> onLocation(loc) }

    var running = false
        private set

    /** Bắt đầu nhận định vị (mỗi giây). Trả false nếu chưa có quyền hay máy không có nguồn định vị. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        if (!hasPermission(context)) return false
        val m = ContextCompat.getSystemService(context, LocationManager::class.java) ?: return false
        val provider = provider(m) ?: return false
        val req = LocationRequestCompat.Builder(INTERVAL_MS)
            .setQuality(LocationRequestCompat.QUALITY_HIGH_ACCURACY)
            .setMinUpdateIntervalMillis(INTERVAL_MS / 2)
            .build()
        return try {
            LocationManagerCompat.requestLocationUpdates(m, provider, req, ContextCompat.getMainExecutor(context), listener)
            lm = m
            running = true
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "Không có quyền vị trí cho màn hình xe")
            false
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Không có nguồn định vị $provider")
            false
        }
    }

    // Gỡ đăng ký không cần quyền còn hiệu lực; mất quyền giữa chừng (SecurityException) thì cũng chỉ bỏ qua.
    @SuppressLint("MissingPermission")
    fun stop() {
        lm?.let {
            try {
                LocationManagerCompat.removeUpdates(it, listener)
            } catch (_: SecurityException) {
            } catch (_: RuntimeException) {
            }
        }
        lm = null
        running = false
        CarStateStore.updateNativeFix(null)
    }

    internal fun onLocation(loc: Location) {
        if (!running) return
        toFix(loc, elapsedNanos(), uptime())?.let(CarStateStore::updateNativeFix)
    }

    companion object {
        private const val TAG = "BanDuongCarGps"
        const val INTERVAL_MS = 1_000L

        /** Như js/location.js: lần định vị sai số hơn 500 m bị bỏ. */
        const val MAX_ACCURACY_M = 500f

        /** Lần định vị cũ hơn chừng này (ví dụ vị trí lưu sẵn) bị bỏ. */
        const val MAX_AGE_MS = 10_000L

        /** Dưới tốc độ này (m/s) hướng đi của GPS không đáng tin. */
        const val MIN_HEADING_SPEED_MS = 1.0f

        fun hasPermission(c: Context): Boolean =
            ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

        private fun provider(m: LocationManager): String? {
            val all = try {
                m.allProviders
            } catch (_: RuntimeException) {
                return null
            }
            return when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && LocationManager.FUSED_PROVIDER in all -> LocationManager.FUSED_PROVIDER
                LocationManager.GPS_PROVIDER in all -> LocationManager.GPS_PROVIDER
                LocationManager.NETWORK_PROVIDER in all -> LocationManager.NETWORK_PROVIDER
                else -> null
            }
        }

        /** Location → [CarStateStore.NativeFix], kiểm tra từng trường như phía trang; sai, quá cũ hoặc quá kém → null. */
        fun toFix(loc: Location, nowElapsedNanos: Long, nowUptimeMs: Long): CarStateStore.NativeFix? {
            val lat = loc.latitude
            val lon = loc.longitude
            if (!lat.isFinite() || !lon.isFinite() || lat !in -90.0..90.0 || lon !in -180.0..180.0) return null
            if (loc.hasAccuracy() && !(loc.accuracy <= MAX_ACCURACY_M)) return null
            val ageMs = (nowElapsedNanos - loc.elapsedRealtimeNanos) / 1_000_000
            if (loc.elapsedRealtimeNanos > 0 && ageMs > MAX_AGE_MS) return null
            val speedMs = if (loc.hasSpeed() && loc.speed.isFinite() && loc.speed >= 0f) loc.speed else null
            val speedKmh = speedMs?.let { (it * 3.6).coerceAtMost(400.0) }
            val heading = if (loc.hasBearing() && loc.bearing.isFinite() && (speedMs == null || speedMs >= MIN_HEADING_SPEED_MS)) {
                ((loc.bearing.toDouble() % 360.0) + 360.0) % 360.0
            } else {
                null
            }
            val accuracy = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null
            return CarStateStore.NativeFix(lat, lon, heading, accuracy, speedKmh, nowUptimeMs)
        }
    }
}
