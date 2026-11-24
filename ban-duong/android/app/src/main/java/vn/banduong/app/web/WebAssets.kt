package vn.banduong.app.web

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Phục vụ ứng dụng web từ assets/www/ (do tác vụ Gradle copyWebAssets chép vào lúc build).
 * Địa chỉ https://appassets.androidplatform.net/<đường dẫn> ↔ assets/www/<đường dẫn>.
 */
object WebAssets {
    const val ASSET_DIR = "www"

    fun createLoader(context: Context): WebViewAssetLoader {
        val app = context.applicationContext
        return WebViewAssetLoader.Builder()
            .setDomain(AppOrigin.HOST)
            .setHttpAllowed(false)
            .addPathHandler("/", WwwPathHandler { path -> app.assets.open(path) })
            .build()
    }

    /**
     * Chuẩn hoá đường dẫn tương đối; null nếu không hợp lệ (đoạn "..", ".", dấu "\", ký tự điều khiển).
     * Đường dẫn rỗng hoặc kết thúc bằng "/" trỏ vào index.html của thư mục đó.
     */
    fun normalizePath(path: String): String? {
        if (path.length > 512) return null
        if (path.any { it == '\\' || it.code < 0x20 || it.code == 0x7F }) return null
        val p = path.trimStart('/')
        val segments = p.split('/')
        for ((i, s) in segments.withIndex()) {
            if (s == "." || s == "..") return null
            if (s.isEmpty() && i != segments.lastIndex) return null
        }
        return if (p.isEmpty() || p.endsWith('/')) p + "index.html" else p
    }

    /** Kiểu MIME theo phần mở rộng; tự khai báo để mô-đun JS và WebAssembly luôn đúng kiểu. */
    fun mimeTypeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json", "map" -> "application/json"
        "geojson" -> "application/geo+json"
        "webmanifest" -> "application/manifest+json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "ico" -> "image/x-icon"
        "wasm" -> "application/wasm"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "mp3" -> "audio/mpeg"
        "ogg" -> "audio/ogg"
        "wav" -> "audio/wav"
        "txt", "md" -> "text/plain"
        "csv" -> "text/csv"
        else -> "application/octet-stream"
    }

    private fun isText(mime: String) =
        mime.startsWith("text/") || mime == "application/json" || mime == "application/geo+json" ||
            mime == "application/manifest+json" || mime == "image/svg+xml"

    private val BASE_HEADERS = mapOf(
        "X-Content-Type-Options" to "nosniff",
        "Cache-Control" to "no-cache",
        "Cross-Origin-Resource-Policy" to "same-origin",
    )

    /**
     * Chính sách nội dung cho trang HTML. Cầu nối với máy chỉ dựa vào nguồn gốc, nên khoá chặt nguồn mã: chỉ tệp đóng
     * gói của ứng dụng (index.html không có mã nội tuyến; chèn được HTML cũng không chạy được mã để gọi cầu nối).
     * 'wasm-unsafe-eval': WebAssembly; worker blob: luồng phụ của MapLibre; không plugin, không đổi <base>, không khung.
     * Luồng phụ của camera (js/vision-worker.js) là tệp riêng, không mang chính sách này (CSP chỉ gắn vào HTML).
     */
    const val HTML_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; " +
        "base-uri 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'"

    fun notFound(): WebResourceResponse = WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", BASE_HEADERS, ByteArrayInputStream(ByteArray(0)),
    )

    /** PathHandler: tách khỏi AssetManager để kiểm thử được. */
    class WwwPathHandler(private val open: (String) -> InputStream) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            val rel = normalizePath(path) ?: return notFound()
            val stream = try {
                open("$ASSET_DIR/$rel")
            } catch (_: IOException) {
                return notFound()
            }
            val mime = mimeTypeFor(rel)
            val headers = if (mime == "text/html") BASE_HEADERS + ("Content-Security-Policy" to HTML_CSP) else BASE_HEADERS
            return WebResourceResponse(mime, if (isText(mime)) "utf-8" else null, 200, "OK", headers, stream)
        }
    }
}
