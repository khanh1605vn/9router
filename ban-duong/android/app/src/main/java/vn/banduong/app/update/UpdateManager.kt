package vn.banduong.app.update

import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import androidx.annotation.MainThread
import androidx.annotation.VisibleForTesting
import java.io.File
import java.io.FileOutputStream
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

/** Cấu hình cố định của bộ cập nhật (từ BuildConfig và máy đang chạy). */
data class UpdateConfig(
    val repo: String,
    val tagPrefix: String,
    val mode: UpdateMode,
    val installedVersionCode: Long,
    val installedVersionName: String,
    val sdkInt: Int,
)

/** Giá trị cần nhớ qua các lần mở ứng dụng. */
interface UpdatePrefs {
    var lastCheckAt: Long
    var dismissedCode: Long
    var backoffUntil: Long
}

/** Việc chỉ làm được khi có màn hình (Activity) đang mở. */
interface UpdateUi {
    /** Mở màn hình "Cài ứng dụng không rõ nguồn gốc" của ứng dụng. */
    fun openInstallSettings(): Boolean

    /** Mở hộp thoại xác nhận cài đặt của hệ thống (intent do PackageInstaller đưa). */
    fun startConfirm(intent: Intent): Boolean

    /** Mở trang web bằng trình duyệt ngoài (chỉ dùng ở chế độ notify, địa chỉ do máy dựng). */
    fun openExternal(url: String)
}

/** Những gì cầu nối JS được gọi (NativeBridge). Không có tham số nào từ trang ngoài ý định. */
interface UpdateCommands {
    var sink: ((String) -> Unit)?
    fun check(manual: Boolean)
    fun install()
    fun dismiss()
    fun resend()
}

/** Lịch hẹn giờ (Handler ở bản thật). */
interface UpdateScheduler {
    fun schedule(delayMs: Long, task: Runnable): Runnable
    fun cancel(token: Runnable)
}

/**
 * Bộ cập nhật trong ứng dụng: kiểm tra GitHub Releases, tải, xác minh, cài qua PackageInstaller.
 *
 * Luồng: mọi trạng thái đổi trên luồng chính; mạng, ghi tệp và băm chạy trên [io] (một luồng). Kết quả của một việc bị huỷ
 * ([dismiss], việc mới hơn) bị bỏ nhờ [generation].
 *
 * Trang web chỉ gửi được ba ý định: check, install, dismiss (và status để nhận lại trạng thái). Không bao giờ có URL hay
 * tên tệp từ trang: máy tự quyết định tải gì (BuildConfig.UPDATE_REPO + thẻ đã kiểm tra).
 */
class UpdateManager(
    private val config: UpdateConfig,
    private val http: SafeHttp,
    private val inspector: ApkInspector,
    private val gateway: InstallGateway?,
    private val prefs: UpdatePrefs,
    private val dir: File,
    private val io: ExecutorService,
    private val main: (Runnable) -> Unit,
    private val scheduler: UpdateScheduler,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val isMoving: () -> Boolean = { false },
) : UpdateCommands {
    /** Nơi gửi thông điệp updateStatus sang trang (NativeBridge gắn vào). */
    override var sink: ((String) -> Unit)? = null

    var ui: UpdateUi? = null

    var status: UpdateStatus = UpdateStatus.IDLE
        private set

    val mode: UpdateMode get() = config.mode

    private var candidate: ReleaseCandidate? = null
    private var manifest: UpdateManifest? = null
    private var readyFile: File? = null
    private var pendingSession = -1
    private var awaitingPermission = false
    private var job: Future<*>? = null
    private var generation = 0
    @Volatile
    private var lastProgressAt = 0L
    private var started = false
    private var timer: Runnable? = null

    private val busy: Boolean
        get() = status.state == UpdateState.CHECKING || status.state == UpdateState.DOWNLOADING ||
            status.state == UpdateState.VERIFYING

    // ---- vòng đời ----

    /** Gọi khi màn hình chính mở: dọn tệp cũ, hẹn lần kiểm tra đầu sau [START_DELAY_MS], rồi mỗi [INTERVAL_MS]. */
    @MainThread
    fun start() {
        if (config.mode == UpdateMode.OFF || started) return
        started = true
        if (readyFile == null && !busy) cleanDir()
        scheduleNext(START_DELAY_MS)
    }

    @MainThread
    fun stop() {
        started = false
        timer?.let(scheduler::cancel)
        timer = null
    }

    private fun scheduleNext(delayMs: Long) {
        timer?.let(scheduler::cancel)
        timer = scheduler.schedule(delayMs) {
            timer = null
            if (!started) return@schedule
            check(manual = false)
            scheduleNext(INTERVAL_MS)
        }
    }

    /** Người dùng quay lại ứng dụng (ví dụ từ màn hình cho phép cài): tiếp tục nếu đang chờ quyền. */
    @MainThread
    fun onResume() {
        if (!awaitingPermission) return
        if (gateway?.canRequestInstalls() == true) {
            awaitingPermission = false
            install()
        }
    }

    // ---- lệnh từ trang ----

    @MainThread
    override fun resend() = emit()

    @MainThread
    override fun check(manual: Boolean) {
        if (config.mode == UpdateMode.OFF) return
        // Đang chờ hệ thống trả lời phiên cài (READY không lỗi): không kiểm tra. READY có lỗi (người dùng bấm Huỷ, xe chạy)
        // thì vẫn kiểm tra: bản đó có thể đã bị thay bằng bản sửa lỗi; tệp đã tải chỉ được giữ nếu vẫn đúng bản đó.
        if (busy || (status.state == UpdateState.READY && status.error == null)) return emit()
        val now = nowMs()
        val until = prefs.backoffUntil
        // Đồng hồ máy có thể lùi (màn hình xe chưa đồng bộ giờ): hạn chờ xa hơn mức tối đa thì coi như hết hạn.
        if (now < until && until - now <= SafeHttp.MAX_BACKOFF_S * 1000) {
            if (manual) setStatus(UpdateStatus(UpdateState.ERROR, error = UpdateErrors.RATE_LIMITED))
            return
        }
        if (manual && now - prefs.lastCheckAt in 0 until MANUAL_MIN_GAP_MS && status.state in QUIET_STATES) return emit()
        val previous = status
        val gen = ++generation
        if (manual || previous.state !in KEEP_WHILE_CHECKING) setStatus(UpdateStatus(UpdateState.CHECKING))
        val cfg = config
        job = io.submit {
            val result: CheckResult = try {
                runCheck(cfg)
            } catch (e: UpdateError) {
                CheckResult.Failed(UpdateErrors.forContract(e.code), e.retryAtMs)
            } catch (e: RuntimeException) {
                CheckResult.Failed(UpdateErrors.NETWORK, null)
            }
            main { if (gen == generation) onChecked(result, manual, previous) }
        }
    }

    @MainThread
    override fun install() {
        when (config.mode) {
            UpdateMode.OFF -> return
            UpdateMode.NOTIFY -> {
                val c = candidate ?: return check(manual = true)
                ui?.openExternal(UpdateUrls.releasePage(config.repo, c.tag))
                return
            }
            UpdateMode.INSTALL -> Unit
        }
        val m = manifest
        val c = candidate
        if (busy) return emit()
        if (m == null || c == null) return check(manual = true)
        if (isMoving()) return setStatus(statusFor(m, UpdateState.ERROR, error = UpdateErrors.DRIVING))
        val g = gateway ?: return setStatus(statusFor(m, UpdateState.ERROR, error = UpdateErrors.INSTALL_FAILED))
        if (!g.canRequestInstalls()) {
            awaitingPermission = true
            ui?.openInstallSettings()
            return setStatus(statusFor(m, UpdateState.ERROR, error = UpdateErrors.INSTALL_PERMISSION))
        }
        val file = readyFile
        if (file != null && file.isFile) commit(file, m) else download(c, m)
    }

    @MainThread
    override fun dismiss() {
        if (config.mode == UpdateMode.OFF) return
        generation++
        job?.cancel(true)
        job = null
        awaitingPermission = false
        pendingSession = -1
        manifest?.let { prefs.dismissedCode = it.versionCode }
        readyFile = null
        cleanDir()
        setStatus(UpdateStatus.IDLE)
    }

    // ---- kiểm tra ----

    private sealed interface CheckResult {
        data class Found(val candidate: ReleaseCandidate, val manifest: UpdateManifest) : CheckResult
        data object None : CheckResult
        data class Failed(val code: String, val retryAtMs: Long?) : CheckResult
    }

    private fun runCheck(cfg: UpdateConfig): CheckResult {
        val deadline = nowMs() + CHECK_DEADLINE_MS
        val api = http.fetchBytes(UpdateUrls.API_SCOPE, UpdateUrls.releasesApi(cfg.repo), ACCEPT_API, ReleaseSelector.MAX_API_BYTES, deadline)
        val c = ReleaseSelector.select(api.toString(Charsets.UTF_8), cfg.repo, cfg.tagPrefix) ?: return CheckResult.None
        val raw = http.fetchBytes(UpdateUrls.downloadScope(cfg.repo), c.manifestUrl, ACCEPT_ANY, ReleaseSelector.MAX_MANIFEST_BYTES, deadline)
        val m = ReleaseSelector.parseManifest(raw.toString(Charsets.UTF_8), c)
            ?: return CheckResult.Failed(UpdateErrors.BAD_RELEASE, null)
        return CheckResult.Found(c, m)
    }

    private fun onChecked(r: CheckResult, manual: Boolean, previous: UpdateStatus) {
        job = null
        val now = nowMs()
        when (r) {
            is CheckResult.Failed -> {
                if (r.retryAtMs != null) prefs.backoffUntil = r.retryAtMs
                // Lần tự kiểm tra hỏng (xe không có mạng…) thì im lặng, giữ trạng thái cũ; chỉ báo khi người dùng tự bấm.
                if (manual) setStatus(UpdateStatus(UpdateState.ERROR, error = r.code)) else setStatus(previous.quiet())
            }
            CheckResult.None -> {
                prefs.lastCheckAt = now
                forgetRelease()
                setStatus(UpdateStatus(UpdateState.UPTODATE))
            }
            is CheckResult.Found -> {
                prefs.lastCheckAt = now
                val m = r.manifest
                // Bản sideload (notify) là một gói khác, không bao giờ cập nhật tại chỗ được: bản phát hành hợp lệ nào cũng
                // là "có bản mới" để người dùng cài ứng dụng chính thức, kể cả khi versionCode bằng bản đang chạy.
                if (config.mode != UpdateMode.NOTIFY && m.versionCode <= config.installedVersionCode) {
                    forgetRelease()
                    return setStatus(UpdateStatus(UpdateState.UPTODATE))
                }
                if (m.minSdk > config.sdkInt) {
                    forgetRelease()
                    return setStatus(if (manual) UpdateStatus(UpdateState.ERROR, error = UpdateErrors.INCOMPATIBLE) else UpdateStatus.IDLE)
                }
                val changed = manifest?.versionCode != m.versionCode
                candidate = r.candidate
                manifest = m
                if (changed) {
                    readyFile = null
                    cleanDir()
                } else if (previous.state == UpdateState.READY && readyFile?.isFile == true) {
                    // Vẫn đúng bản đã tải và xác minh (người dùng bấm Huỷ lúc trước): giữ "sẵn sàng cài", không tải lại.
                    return setStatus(previous)
                }
                // Người dùng đã bấm "Để sau" cho đúng bản này: lần tự kiểm tra không hiện lại (tự bấm kiểm tra thì có).
                if (!manual && prefs.dismissedCode == m.versionCode) return setStatus(UpdateStatus.IDLE)
                setStatus(statusFor(m, UpdateState.AVAILABLE))
            }
        }
    }

    // ---- tải và xác minh ----

    private fun download(c: ReleaseCandidate, m: UpdateManifest) {
        val gen = ++generation
        lastProgressAt = 0L
        setStatus(statusFor(m, UpdateState.DOWNLOADING, progress = 0.0))
        val cfg = config
        job = io.submit {
            val result: Result<File> = try {
                Result.success(downloadAndVerify(c, m, cfg, gen))
            } catch (e: UpdateError) {
                Result.failure(e)
            } catch (e: Exception) {
                Result.failure(UpdateError(UpdateErrors.STORAGE, cause = e))
            }
            main {
                if (gen != generation) {
                    result.getOrNull()?.delete()
                    return@main
                }
                job = null
                result.fold(
                    onSuccess = { f ->
                        readyFile = f
                        commit(f, m)
                    },
                    onFailure = { e ->
                        cleanDir()
                        val code = UpdateErrors.forContract((e as? UpdateError)?.code ?: UpdateErrors.STORAGE)
                        setStatus(statusFor(m, UpdateState.ERROR, error = code))
                    },
                )
            }
        }
    }

    /** Chạy trên [io]. Trả tệp đã qua mọi kiểm tra; sai thì xoá tệp và ném [UpdateError]. */
    private fun downloadAndVerify(c: ReleaseCandidate, m: UpdateManifest, cfg: UpdateConfig, gen: Int): File {
        if (!dir.isDirectory && !dir.mkdirs()) throw UpdateError(UpdateErrors.STORAGE)
        val part = File(dir, "ban-duong-${m.versionCode}.apk.part")
        val done = File(dir, "ban-duong-${m.versionCode}.apk")
        part.delete()
        done.delete()
        var ok = false
        try {
            val md = MessageDigest.getInstance("SHA-256")
            val total = DigestOutputStream(FileOutputStream(part), md).use { out ->
                http.fetch(UpdateUrls.downloadScope(cfg.repo), c.apkUrl, ACCEPT_ANY, m.size, nowMs() + DOWNLOAD_DEADLINE_MS, out) { read, _ ->
                    val now = nowMs()
                    if (now - lastProgressAt >= PROGRESS_EVERY_MS) {
                        lastProgressAt = now
                        val p = read.toDouble() / m.size
                        main { if (gen == generation) setStatus(statusFor(m, UpdateState.DOWNLOADING, progress = p)) }
                    }
                }
            }
            // Toàn vẹn: đúng số byte và SHA-256 trong update.json (chỉ chống tệp hỏng/bị cắt; tính xác thực là chữ ký).
            if (total != m.size) throw UpdateError(UpdateErrors.CHECKSUM)
            if (!MessageDigest.isEqual(md.digest(), AndroidInstallGateway.hexBytes(m.sha256))) throw UpdateError(UpdateErrors.CHECKSUM)
            main { if (gen == generation) setStatus(statusFor(m, UpdateState.VERIFYING)) }
            if (!part.renameTo(done)) throw UpdateError(UpdateErrors.STORAGE)
            ApkCheck.verify(inspector.archive(done), inspector.installed(), m, cfg.sdkInt)?.let { throw UpdateError(it) }
            ok = true
            return done
        } finally {
            if (!ok) {
                part.delete()
                done.delete()
            }
        }
    }

    // ---- cài ----

    private fun commit(file: File, m: UpdateManifest) {
        val g = gateway ?: return
        if (isMoving()) return setStatus(statusFor(m, UpdateState.ERROR, error = UpdateErrors.DRIVING))
        val gen = ++generation
        setStatus(statusFor(m, UpdateState.VERIFYING))
        val cfg = config
        job = io.submit {
            val result: Result<Int> = try {
                // Kiểm tra lại ngay trước khi đưa cho hệ thống (tệp có thể đã nằm đó từ lần bấm trước).
                ApkCheck.verify(inspector.archive(file), inspector.installed(), m, cfg.sdkInt)?.let { throw UpdateError(it) }
                Result.success(g.commit(file, m))
            } catch (e: UpdateError) {
                Result.failure(e)
            } catch (e: Exception) {
                Result.failure(UpdateError(UpdateErrors.INSTALL_FAILED, cause = e))
            }
            main {
                if (gen != generation) return@main
                job = null
                result.fold(
                    onSuccess = { id ->
                        pendingSession = id
                        setStatus(statusFor(m, UpdateState.READY))
                    },
                    onFailure = { e ->
                        readyFile = null
                        cleanDir()
                        setStatus(statusFor(m, UpdateState.ERROR, error = (e as? UpdateError)?.code ?: UpdateErrors.INSTALL_FAILED))
                    },
                )
            }
        }
    }

    /** Kết quả của phiên PackageInstaller (InstallResultReceiver, luồng chính). */
    @MainThread
    fun onInstallStatus(sessionId: Int, code: Int, confirm: Intent?) {
        if (sessionId < 0 || sessionId != pendingSession) return
        val m = manifest ?: return
        when (code) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Chép tệp vào phiên cài có thể mất vài giây (tệp lớn, bộ nhớ màn hình xe chậm): xe có thể đã lăn bánh.
                // Không mở hộp thoại lúc đó; bỏ phiên, giữ tệp đã xác minh, lần bấm sau kiểm tra lại rồi mới mở.
                if (isMoving()) {
                    gateway?.abandon(sessionId)
                    return failInstall(m, UpdateErrors.DRIVING, keepFile = true)
                }
                val i = confirm ?: return failInstall(m, UpdateErrors.INSTALL_FAILED)
                // Intent của hệ thống: bỏ mọi cờ cấp quyền URI để không thể bị lợi dụng chuyển quyền.
                i.flags = i.flags and URI_GRANT_FLAGS.inv()
                if (ui?.startConfirm(i) != true) failInstall(m, UpdateErrors.INSTALL_ABORTED, keepFile = true)
            }
            PackageInstaller.STATUS_SUCCESS -> {
                // Thường tiến trình đã bị hệ thống dừng để thay bản mới trước khi tới đây.
                pendingSession = -1
                readyFile = null
                cleanDir()
                candidate = null
                manifest = null
                setStatus(UpdateStatus(UpdateState.UPTODATE))
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> failInstall(m, UpdateErrors.INSTALL_ABORTED, keepFile = true)
            PackageInstaller.STATUS_FAILURE_STORAGE -> failInstall(m, UpdateErrors.STORAGE)
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> failInstall(m, UpdateErrors.INCOMPATIBLE)
            else -> failInstall(m, UpdateErrors.INSTALL_FAILED)
        }
    }

    private fun failInstall(m: UpdateManifest, code: String, keepFile: Boolean = false) {
        pendingSession = -1
        if (keepFile && readyFile?.isFile == true) {
            // Người dùng bấm Huỷ: giữ tệp đã xác minh, bấm "Cập nhật" lần nữa thì mở lại hộp thoại, không tải lại.
            setStatus(statusFor(m, UpdateState.READY, error = code))
        } else {
            readyFile = null
            cleanDir()
            setStatus(statusFor(m, UpdateState.ERROR, error = code))
        }
    }

    // ---- tiện ích ----

    /** Không còn bản nào để cài (đã mới nhất, bản bị gỡ, không hợp máy): bỏ cả tệp đã tải nếu có. */
    private fun forgetRelease() {
        candidate = null
        manifest = null
        if (readyFile != null) {
            readyFile = null
            cleanDir()
        }
    }

    private fun statusFor(m: UpdateManifest, state: UpdateState, progress: Double? = null, error: String? = null) =
        UpdateStatus(state, m.versionName, m.notes.ifEmpty { null }, progress, error)

    /** Trạng thái để giữ lại sau một lần tự kiểm tra hỏng: không để "đang kiểm tra" treo. */
    private fun UpdateStatus.quiet(): UpdateStatus = if (state == UpdateState.CHECKING) UpdateStatus.IDLE else this

    private fun setStatus(s: UpdateStatus) {
        status = s
        emit()
    }

    private fun emit() {
        if (config.mode == UpdateMode.OFF) return
        try {
            sink?.invoke(status.toJson(config.mode, config.installedVersionName))
        } catch (e: RuntimeException) {
            Log.w(TAG, "Không gửi được trạng thái cập nhật", e)
        }
    }

    private fun cleanDir() {
        dir.listFiles()?.forEach { it.delete() }
    }

    @VisibleForTesting
    internal val pendingSessionForTest: Int get() = pendingSession

    companion object {
        private const val TAG = "BanDuongUpdate"
        const val START_DELAY_MS = 20_000L
        const val INTERVAL_MS = 6L * 3600 * 1000
        const val MANUAL_MIN_GAP_MS = 30_000L
        const val CHECK_DEADLINE_MS = 60_000L
        const val DOWNLOAD_DEADLINE_MS = 30L * 60 * 1000
        const val PROGRESS_EVERY_MS = 250L
        const val ACCEPT_API = "application/vnd.github+json"
        const val ACCEPT_ANY = "application/octet-stream"

        private val QUIET_STATES = setOf(UpdateState.UPTODATE, UpdateState.AVAILABLE)

        /** Lần tự kiểm tra từ những trạng thái này không hiện "đang kiểm tra" (nút "Có phiên bản mới" không nhấp nháy). */
        private val KEEP_WHILE_CHECKING = setOf(UpdateState.AVAILABLE, UpdateState.READY)
        private const val URI_GRANT_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
    }
}
