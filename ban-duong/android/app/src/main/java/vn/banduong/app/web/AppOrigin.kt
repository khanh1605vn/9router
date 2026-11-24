package vn.banduong.app.web

import android.net.Uri
import androidx.core.net.toUri
import androidx.webkit.WebViewAssetLoader

/**
 * Nguồn gốc duy nhất mà ứng dụng tin: tệp đóng gói trong APK, phục vụ qua WebViewAssetLoader trên
 * https://appassets.androidplatform.net (tên miền dành riêng, không phân giải ra mạng; là ngữ cảnh an toàn nên
 * geolocation, getUserMedia, service worker, crypto.subtle đều chạy).
 */
object AppOrigin {
    const val HOST: String = WebViewAssetLoader.DEFAULT_DOMAIN
    const val ORIGIN: String = "https://$HOST"
    const val START_URL: String = "$ORIGIN/index.html"

    /** Quy tắc nguồn gốc cho addWebMessageListener và addDocumentStartJavaScript. */
    val ORIGIN_RULES: Set<String> = setOf(ORIGIN)

    fun isAppUri(uri: Uri?): Boolean {
        if (uri == null) return false
        return uri.scheme == "https" &&
            HOST.equals(uri.host, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) &&
            uri.encodedUserInfo == null
    }

    fun isAppUrl(url: String?): Boolean = url != null && isAppUri(url.toUri())

    /**
     * Chuỗi nguồn gốc từ WebView (ví dụ "https://appassets.androidplatform.net/" trong
     * onGeolocationPermissionsShowPrompt, hoặc không có dấu "/" ở PermissionRequest.getOrigin()).
     */
    fun isAppOrigin(origin: String?): Boolean {
        if (origin.isNullOrEmpty()) return false
        val uri = origin.toUri()
        val path = uri.encodedPath
        return isAppUri(uri) && (path.isNullOrEmpty() || path == "/") && uri.encodedQuery == null && uri.encodedFragment == null
    }

    /** Liên kết ra ngoài được phép mở bằng trình duyệt: chỉ http(s), không có thông tin đăng nhập trong địa chỉ. */
    fun isExternalWebLink(uri: Uri?): Boolean {
        if (uri == null || isAppUri(uri)) return false
        val scheme = uri.scheme?.lowercase() ?: return false
        return (scheme == "https" || scheme == "http") && !uri.host.isNullOrEmpty() && uri.encodedUserInfo == null
    }
}
