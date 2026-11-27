package vn.banduong.app.update

import org.json.JSONObject
import vn.banduong.app.bridge.BridgeLimits

/** Chế độ cập nhật theo loại bản build (BuildConfig.UPDATE_MODE). */
enum class UpdateMode(val key: String) {
    /** Bản debug: không kiểm tra. */
    OFF("off"),

    /** Bản sideload: chỉ báo có bản mới, bấm thì mở trang tải bản chính thức (khác khoá ký nên không cài đè được). */
    NOTIFY("notify"),

    /** Bản release: kiểm tra, tải, xác minh và mở hộp thoại cài đặt của hệ thống. */
    INSTALL("install"),
    ;

    companion object {
        fun of(key: String): UpdateMode = entries.firstOrNull { it.key == key } ?: OFF
    }
}

enum class UpdateState(val key: String) {
    IDLE("idle"),
    CHECKING("checking"),
    AVAILABLE("available"),
    DOWNLOADING("downloading"),
    VERIFYING("verifying"),
    READY("ready"),
    ERROR("error"),
    UPTODATE("uptodate"),
}

/** Mã lỗi gửi sang trang (cố định, ngắn; trang tự đổi thành câu tiếng Việt). */
object UpdateErrors {
    const val NETWORK = SafeHttp.E_NETWORK
    const val RATE_LIMITED = SafeHttp.E_RATE_LIMITED
    const val TOO_LARGE = SafeHttp.E_TOO_LARGE
    const val BAD_RELEASE = "bad-release"
    const val CHECKSUM = "checksum"
    const val BAD_APK = "bad-apk"
    const val PACKAGE_MISMATCH = "package-mismatch"
    const val SIGNATURE_MISMATCH = "signature-mismatch"
    const val VERSION_MISMATCH = "version-mismatch"
    const val INCOMPATIBLE = "incompatible"
    const val INSTALL_PERMISSION = "install-permission"
    const val INSTALL_FAILED = "install-failed"
    const val INSTALL_ABORTED = "install-aborted"
    const val STORAGE = "storage"
    const val DRIVING = "driving"

    /** Lỗi từ lớp mạng không có trong danh sách hợp đồng thì gộp thành "network" / "bad-release". */
    fun forContract(code: String): String = when (code) {
        SafeHttp.E_NETWORK, SafeHttp.E_CANCELLED -> NETWORK
        SafeHttp.E_RATE_LIMITED -> RATE_LIMITED
        SafeHttp.E_TOO_LARGE -> TOO_LARGE
        SafeHttp.E_NOT_FOUND, SafeHttp.E_BAD_URL, SafeHttp.E_BAD_REDIRECT -> BAD_RELEASE
        else -> code
    }
}

/**
 * Trạng thái cập nhật gửi sang trang. [versionName] và [notes] chỉ có khi đã biết bản mới; [progress] 0…1 khi đang tải;
 * [error] là mã trong [UpdateErrors] (state = error, hoặc ready + install-aborted khi người dùng bấm Huỷ).
 */
data class UpdateStatus(
    val state: UpdateState,
    val versionName: String? = null,
    val notes: String? = null,
    val progress: Double? = null,
    val error: String? = null,
) {
    fun toJson(mode: UpdateMode, current: String): String = JSONObject()
        .put("v", BridgeLimits.PROTOCOL_VERSION)
        .put("type", "updateStatus")
        .put("state", state.key)
        .put("versionName", versionName ?: JSONObject.NULL)
        .put("notes", notes ?: JSONObject.NULL)
        .put("progress", progress?.coerceIn(0.0, 1.0) ?: JSONObject.NULL)
        .put("error", error ?: JSONObject.NULL)
        .put("mode", mode.key)
        .put("current", current)
        .toString()

    companion object {
        val IDLE = UpdateStatus(UpdateState.IDLE)
    }
}
