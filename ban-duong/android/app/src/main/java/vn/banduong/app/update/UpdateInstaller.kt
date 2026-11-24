package vn.banduong.app.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.IntentCompat
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest

/** Cổng tới PackageInstaller của hệ thống. Kiểm thử thay bằng bản giả. */
interface InstallGateway {
    /** Ứng dụng đã được người dùng cho phép cài ứng dụng chưa (Cài đặt › Cài ứng dụng không rõ nguồn gốc). */
    fun canRequestInstalls(): Boolean

    /**
     * Chép [file] vào một phiên cài đặt mới (băm lại SHA-256 trong lúc chép, phải khớp [manifest]), rồi commit.
     * Hệ thống sẽ hỏi người dùng (STATUS_PENDING_USER_ACTION). Trả mã phiên; lỗi thì ném [UpdateError].
     */
    fun commit(file: File, manifest: UpdateManifest): Int

    /** Bỏ phiên [sessionId] của chính ứng dụng (không mở hộp thoại cho nó nữa). Lỗi thì bỏ qua. */
    fun abandon(sessionId: Int) {}
}

class AndroidInstallGateway(private val context: Context) : InstallGateway {
    override fun canRequestInstalls(): Boolean = context.packageManager.canRequestPackageInstalls()

    override fun abandon(sessionId: Int) {
        // Chỉ phiên do chính ứng dụng tạo mới bỏ được; phiên đã xong hay không còn thì hệ thống ném lỗi: bỏ qua.
        runCatching { context.packageManager.packageInstaller.abandonSession(sessionId) }
    }

    override fun commit(file: File, manifest: UpdateManifest): Int {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            // Hệ thống từ chối nếu tệp không đúng tên gói này: chốt chặn thứ hai sau ApkCheck, ngay lúc cài.
            setAppPackageName(context.packageName)
            setSize(manifest.size)
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
            }
        }
        val id = try {
            installer.createSession(params)
        } catch (e: IOException) {
            throw UpdateError(UpdateErrors.STORAGE, cause = e)
        } catch (e: RuntimeException) {
            throw UpdateError(UpdateErrors.INSTALL_FAILED, cause = e)
        }
        var committed = false
        try {
            installer.openSession(id).use { session ->
                val md = MessageDigest.getInstance("SHA-256")
                var total = 0L
                FileInputStream(file).use { input ->
                    session.openWrite(SESSION_APK_NAME, 0, manifest.size).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > manifest.size) throw UpdateError(UpdateErrors.CHECKSUM)
                            md.update(buf, 0, n)
                            out.write(buf, 0, n)
                        }
                        session.fsync(out)
                    }
                }
                // Băm lại đúng những byte đưa cho hệ thống (tệp trong bộ nhớ riêng của ứng dụng, nhưng vẫn kiểm lần cuối).
                if (total != manifest.size || !MessageDigest.isEqual(md.digest(), hexBytes(manifest.sha256))) {
                    throw UpdateError(UpdateErrors.CHECKSUM)
                }
                val intent = Intent(context, InstallResultReceiver::class.java)
                    .setAction(InstallResultReceiver.ACTION)
                    .setPackage(context.packageName)
                // PackageInstaller điền kết quả vào intent nên PendingIntent phải MUTABLE (Android 12+); intent đã chỉ
                // rõ lớp nhận trong ứng dụng nên không ai khác nhận được.
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pi = PendingIntent.getBroadcast(context, id, intent, flags)
                session.commit(pi.intentSender)
                committed = true
            }
        } catch (e: UpdateError) {
            throw e
        } catch (e: IOException) {
            throw UpdateError(UpdateErrors.STORAGE, cause = e)
        } catch (e: RuntimeException) {
            throw UpdateError(UpdateErrors.INSTALL_FAILED, cause = e)
        } finally {
            if (!committed) runCatching { installer.abandonSession(id) }
        }
        return id
    }

    companion object {
        const val SESSION_APK_NAME = "base.apk"

        fun hexBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { i ->
            ((Character.digit(hex[2 * i], 16) shl 4) or Character.digit(hex[2 * i + 1], 16)).toByte()
        }
    }
}

/**
 * Nhận kết quả phiên cài đặt (không exported, chỉ khai báo ở bản release: src/updater/AndroidManifest.xml).
 * Chỉ chuyển cho [UpdateService] mã phiên, trạng thái và intent xác nhận của hệ thống; [UpdateManager] tự kiểm tra
 * mã phiên có đúng phiên mình vừa tạo không.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val confirm = if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            null
        }
        UpdateService.onInstallStatus(sessionId, status, confirm)
    }

    companion object {
        const val ACTION = "vn.banduong.app.update.INSTALL_RESULT"
    }
}
