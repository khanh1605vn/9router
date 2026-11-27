package vn.banduong.app.update

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.MainThread
import androidx.core.content.edit
import vn.banduong.app.BuildConfig
import vn.banduong.app.bridge.CarStateStore
import java.io.File
import java.util.concurrent.Executors

/**
 * Một [UpdateManager] cho cả tiến trình (Activity bị dựng lại khi WebView hỏng thì việc tải vẫn chạy tiếp).
 * Bản debug (UPDATE_MODE = off) không có gì ở đây chạy.
 */
object UpdateService {
    @Volatile
    private var instance: UpdateManager? = null

    /** Xe có đang chạy không (MotionGuard: không có bằng chứng đứng yên thì coi là đang chạy). Cả tiến trình dùng chung. */
    private val motion = MotionGuard(SystemClock.uptimeMillis())
    private var listening = false

    val mode: UpdateMode get() = UpdateMode.of(BuildConfig.UPDATE_MODE)

    @MainThread
    fun get(context: Context): UpdateManager? {
        if (mode == UpdateMode.OFF) return null
        instance?.let { return it }
        val app = context.applicationContext
        val main = Handler(Looper.getMainLooper())
        val m = UpdateManager(
            config = UpdateConfig(
                repo = BuildConfig.UPDATE_REPO,
                tagPrefix = BuildConfig.UPDATE_TAG_PREFIX,
                mode = mode,
                installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
                installedVersionName = BuildConfig.VERSION_NAME,
                sdkInt = Build.VERSION.SDK_INT,
            ),
            http = SafeHttp(UrlConnectionTransport()),
            inspector = AndroidApkInspector(app),
            gateway = if (mode == UpdateMode.INSTALL) AndroidInstallGateway(app) else null,
            prefs = SharedUpdatePrefs(app),
            // Bộ nhớ đệm riêng của ứng dụng: ứng dụng khác không đọc/ghi được; hệ thống có thể dọn khi thiếu chỗ.
            dir = File(app.cacheDir, "update"),
            io = Executors.newSingleThreadExecutor { r -> Thread(r, "BanDuongUpdate").apply { isDaemon = true } },
            main = { r -> if (Looper.myLooper() == Looper.getMainLooper()) r.run() else main.post(r) },
            scheduler = HandlerScheduler(main),
            isMoving = { motion.isMoving(SystemClock.uptimeMillis()) },
        )
        listenForSpeed()
        instance = m
        return m
    }

    /** Nạp tốc độ vào [motion] từ "state" của trang (khi còn mới lúc nhận) và định vị của máy (khi chiếu lên xe). */
    @MainThread
    private fun listenForSpeed() {
        if (listening) return
        listening = true
        val feed = CarStateStore.Listener { snap -> observe(snap) }
        observe(CarStateStore.snapshot)
        CarStateStore.addListener(feed)
    }

    private fun observe(snap: CarStateStore.Snapshot) {
        val st = snap.state
        if (st != null && snap.freshness(snap.receivedAtUptimeMs) == CarStateStore.Freshness.FRESH) {
            motion.observe(st.speedKmh, snap.receivedAtUptimeMs)
        }
        snap.fix?.let { motion.observe(it.speedKmh, it.atUptimeMs) }
    }

    /** Từ InstallResultReceiver (luồng chính). Tiến trình đã khởi động lại thì không có phiên nào đang chờ: bỏ qua. */
    @MainThread
    fun onInstallStatus(sessionId: Int, status: Int, confirm: Intent?) {
        instance?.onInstallStatus(sessionId, status, confirm)
    }

}

private class SharedUpdatePrefs(context: Context) : UpdatePrefs {
    private val sp = context.getSharedPreferences("update", Context.MODE_PRIVATE)
    override var lastCheckAt: Long
        get() = sp.getLong("lastCheckAt", 0L)
        set(v) = sp.edit { putLong("lastCheckAt", v) }
    override var dismissedCode: Long
        get() = sp.getLong("dismissedCode", 0L)
        set(v) = sp.edit { putLong("dismissedCode", v) }
    override var backoffUntil: Long
        get() = sp.getLong("backoffUntil", 0L)
        set(v) = sp.edit { putLong("backoffUntil", v) }
}

private class HandlerScheduler(private val handler: Handler) : UpdateScheduler {
    override fun schedule(delayMs: Long, task: Runnable): Runnable {
        handler.postDelayed(task, delayMs)
        return task
    }

    override fun cancel(token: Runnable) = handler.removeCallbacks(token)
}
