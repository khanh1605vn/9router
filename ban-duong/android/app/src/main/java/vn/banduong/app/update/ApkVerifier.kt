package vn.banduong.app.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.security.MessageDigest

/** Thông tin một gói: tên gói, versionCode, tập chứng chỉ ký (SHA-256 hex của từng chứng chỉ), minSdk nếu biết. */
data class ApkFacts(
    val packageName: String?,
    val versionCode: Long,
    val signers: Set<String>,
    val minSdk: Int? = null,
)

/** Đọc thông tin của tệp APK đã tải và của chính ứng dụng đang cài. Kiểm thử thay bằng bản giả. */
interface ApkInspector {
    fun archive(file: File): ApkFacts?
    fun installed(): ApkFacts?
}

/**
 * Kiểm tra tệp APK trước khi đưa cho trình cài đặt. Tính xác thực đến từ chữ ký: Android chỉ cho cập nhật khi bản mới ký
 * cùng khoá với bản đang cài; ở đây kiểm tra trước đúng điều đó (và đúng tên gói, đúng versionCode đã quảng bá) để không
 * bao giờ mở hộp thoại cài cho một tệp lạ, nhất là một gói KHÁC tên (gói khác tên thì Android cài như ứng dụng mới,
 * không có kiểm tra khoá nào).
 */
object ApkCheck {
    /** Trả mã lỗi ([UpdateErrors]) hoặc null nếu tệp được phép cài. */
    fun verify(archive: ApkFacts?, installed: ApkFacts?, manifest: UpdateManifest, sdkInt: Int): String? {
        if (archive == null || installed == null || installed.packageName == null) return UpdateErrors.BAD_APK
        if (archive.packageName != installed.packageName) return UpdateErrors.PACKAGE_MISMATCH
        if (archive.versionCode != manifest.versionCode || archive.versionCode <= installed.versionCode) {
            return UpdateErrors.VERSION_MISMATCH
        }
        if (installed.signers.isEmpty() || archive.signers != installed.signers) return UpdateErrors.SIGNATURE_MISMATCH
        val minSdk = maxOf(archive.minSdk ?: 0, manifest.minSdk)
        if (minSdk > sdkInt) return UpdateErrors.INCOMPATIBLE
        return null
    }

    fun certDigest(cert: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(cert).joinToString("") { "%02x".format(it) }
}

/** Bản thật: PackageManager.getPackageArchiveInfo / getPackageInfo với chứng chỉ ký. */
class AndroidApkInspector(private val context: Context) : ApkInspector {
    override fun archive(file: File): ApkFacts? = try {
        val pm = context.packageManager
        val info = archiveInfo(pm, file.path, signingFlag()) ?: return null
        var signers = signers(info)
        // Phòng xa máy Android 9–10 không trả signingInfo cho tệp lẻ: đọc lại bằng GET_SIGNATURES (cùng bộ đọc của hệ thống).
        if (signers.isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            @Suppress("DEPRECATION")
            val old = archiveInfo(pm, file.path, PackageManager.GET_SIGNATURES.toLong())
            @Suppress("DEPRECATION")
            signers = old?.signatures.orEmpty().map { ApkCheck.certDigest(it.toByteArray()) }.toSet()
        }
        ApkFacts(
            packageName = info.packageName,
            versionCode = PackageInfoCompat.getLongVersionCode(info),
            signers = signers,
            minSdk = info.applicationInfo?.minSdkVersion,
        )
    } catch (_: RuntimeException) {
        null
    }

    override fun installed(): ApkFacts? = try {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(signingFlag()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, signingFlag().toInt())
        }
        ApkFacts(info.packageName, PackageInfoCompat.getLongVersionCode(info), signers(info))
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: RuntimeException) {
        null
    }

    private fun archiveInfo(pm: PackageManager, path: String, flags: Long): PackageInfo? =
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(path, flags.toInt())
        }

    @Suppress("DEPRECATION")
    private fun signingFlag(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES.toLong()
        else PackageManager.GET_SIGNATURES.toLong()

    /** Chứng chỉ đang ký nội dung gói (không gồm khoá cũ đã xoay). Không có thì tập rỗng (bị từ chối). */
    private fun signers(info: PackageInfo): Set<String> {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        }
        return sigs.orEmpty().map { ApkCheck.certDigest(it.toByteArray()) }.toSet()
    }
}
