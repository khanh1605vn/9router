package vn.banduong.app.update

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** Lỗi của bộ cập nhật: [code] là mã gửi sang trang (ngắn, cố định, không chứa dữ liệu từ ngoài). */
class UpdateError(val code: String, val retryAtMs: Long? = null, cause: Throwable? = null) : Exception(code, cause)

/** Một lần trả lời HTTP (một bước, không tự chuyển hướng). */
interface HttpResponse : Closeable {
    val code: Int
    /** Độ dài khai báo, -1 nếu không có. */
    val contentLength: Long
    fun header(name: String): String?
    fun body(): InputStream
}

/** Lớp mạng thấp nhất: một yêu cầu GET tới đúng [url], KHÔNG tự chuyển hướng. Kiểm thử thay bằng bản giả. */
fun interface HttpTransport {
    @Throws(IOException::class)
    fun get(url: URL, headers: Map<String, String>): HttpResponse
}

/** HttpsURLConnection: không bộ nhớ đệm, không tự chuyển hướng, không cookie, có hạn chờ. */
class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : HttpTransport {
    override fun get(url: URL, headers: Map<String, String>): HttpResponse {
        val conn = url.openConnection() as? HttpsURLConnection ?: throw IOException("not https")
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.allowUserInteraction = false
        conn.connectTimeout = connectTimeoutMs
        conn.readTimeout = readTimeoutMs
        conn.requestMethod = "GET"
        for ((k, v) in headers) conn.setRequestProperty(k, v)
        val code = conn.responseCode
        return object : HttpResponse {
            override val code = code
            override val contentLength: Long = conn.contentLengthLong
            override fun header(name: String): String? = conn.getHeaderField(name)
            override fun body(): InputStream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: ByteArrayInputStream(ByteArray(0)))
            override fun close() = conn.disconnect()
        }
    }
}

/**
 * GET an toàn cho bộ cập nhật: mọi địa chỉ (cả từng bước chuyển hướng) phải qua [UpdateUrls.isAllowed]; tối đa
 * [MAX_REDIRECTS] bước; giới hạn cứng số byte đọc; hạn chót tổng; 403/429 thành "rate-limited" kèm lúc được thử lại.
 * Không gửi thông tin đăng nhập hay dữ liệu cá nhân nào: chỉ Accept, User-Agent chung và phiên bản API.
 */
class SafeHttp(
    private val transport: HttpTransport,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    /** Đọc cả thân trả lời vào bộ nhớ (API, update.json), tối đa [maxBytes]. */
    fun fetchBytes(scope: UrlScope, url: String, accept: String, maxBytes: Long, deadlineMs: Long): ByteArray {
        val out = ByteArrayOutputStream()
        fetch(scope, url, accept, maxBytes, deadlineMs, out) { _, _ -> }
        return out.toByteArray()
    }

    /**
     * Tải về [out], tối đa [maxBytes] byte (vượt thì dừng ngay, "too-large"). [onProgress](đã đọc, tổng khai báo hoặc -1).
     * Địa chỉ đầu và mọi bước chuyển hướng phải qua cả danh sách trắng chung lẫn [scope]. Trả số byte đã ghi.
     */
    fun fetch(
        scope: UrlScope,
        url: String,
        accept: String,
        maxBytes: Long,
        deadlineMs: Long,
        out: OutputStream,
        onProgress: (Long, Long) -> Unit,
    ): Long {
        var current: URI = UpdateUrls.parseAllowed(url)?.takeIf(scope::allows) ?: throw UpdateError(E_BAD_URL)
        for (hop in 0..MAX_REDIRECTS) {
            checkDeadline(deadlineMs)
            val resp = try {
                transport.get(current.toURL(), headersFor(current, accept))
            } catch (e: InterruptedIOException) {
                throw UpdateError(E_NETWORK, cause = e)
            } catch (e: IOException) {
                throw UpdateError(E_NETWORK, cause = e)
            } catch (e: RuntimeException) {
                throw UpdateError(E_NETWORK, cause = e)
            }
            resp.use { r ->
                when (r.code) {
                    in 200..299 -> return readBody(r, maxBytes, deadlineMs, out, onProgress)
                    301, 302, 303, 307, 308 -> {
                        val loc = r.header("Location") ?: throw UpdateError(E_BAD_REDIRECT)
                        current = resolveRedirect(current, loc)?.takeIf(scope::allows) ?: throw UpdateError(E_BAD_REDIRECT)
                    }
                    403, 429 -> throw UpdateError(E_RATE_LIMITED, retryAtMs = retryAt(r))
                    else -> throw UpdateError(if (r.code == 404) E_NOT_FOUND else E_NETWORK)
                }
            }
        }
        throw UpdateError(E_BAD_REDIRECT)
    }

    private fun headersFor(uri: URI, accept: String): Map<String, String> {
        val h = linkedMapOf("Accept" to accept, "User-Agent" to USER_AGENT)
        if (uri.host == "api.github.com") h["X-GitHub-Api-Version"] = API_VERSION
        return h
    }

    private fun readBody(r: HttpResponse, maxBytes: Long, deadlineMs: Long, out: OutputStream, onProgress: (Long, Long) -> Unit): Long {
        val declared = r.contentLength
        if (declared > maxBytes) throw UpdateError(E_TOO_LARGE)
        var total = 0L
        val buf = ByteArray(64 * 1024)
        try {
            r.body().use { input ->
                while (true) {
                    checkDeadline(deadlineMs)
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > maxBytes) throw UpdateError(E_TOO_LARGE)
                    out.write(buf, 0, n)
                    onProgress(total, declared)
                }
            }
        } catch (e: UpdateError) {
            throw e
        } catch (e: IOException) {
            throw UpdateError(E_NETWORK, cause = e)
        }
        if (declared >= 0 && total != declared) throw UpdateError(E_NETWORK)
        return total
    }

    private fun checkDeadline(deadlineMs: Long) {
        if (nowMs() > deadlineMs) throw UpdateError(E_NETWORK)
        if (Thread.currentThread().isInterrupted) throw UpdateError(E_CANCELLED)
    }

    /** Lúc được thử lại sau khi GitHub giới hạn: Retry-After (giây) hoặc X-RateLimit-Reset (giây kể từ 1970). */
    private fun retryAt(r: HttpResponse): Long {
        val now = nowMs()
        val after = r.header("Retry-After")?.trim()?.toLongOrNull()?.takeIf { it >= 0 }?.coerceAtMost(MAX_BACKOFF_S)
        val reset = r.header("X-RateLimit-Reset")?.trim()?.toLongOrNull()?.times(1000)
        val at = when {
            after != null -> now + after * 1000
            reset != null && reset > now -> reset
            else -> now + DEFAULT_BACKOFF_MS
        }
        return at.coerceIn(now + MIN_BACKOFF_MS, now + MAX_BACKOFF_S * 1000)
    }

    companion object {
        const val MAX_REDIRECTS = 5
        const val USER_AGENT = "BanDuong-Updater"
        const val API_VERSION = "2022-11-28"
        const val MIN_BACKOFF_MS = 60_000L
        const val DEFAULT_BACKOFF_MS = 60 * 60_000L
        const val MAX_BACKOFF_S = 6L * 3600

        const val E_NETWORK = "network"
        const val E_RATE_LIMITED = "rate-limited"
        const val E_NOT_FOUND = "not-found"
        const val E_TOO_LARGE = "too-large"
        const val E_BAD_URL = "bad-url"
        const val E_BAD_REDIRECT = "bad-redirect"
        const val E_CANCELLED = "cancelled"

        /** Bước chuyển hướng: địa chỉ tương đối được ghép với địa chỉ hiện tại, rồi kiểm tra lại danh sách trắng. */
        fun resolveRedirect(base: URI, location: String): URI? {
            if (location.length > 4096) return null
            if (location.any { it < ' ' || it == '\\' || it.code == 0x7F }) return null
            val next = try {
                base.resolve(URI(location.trim()))
            } catch (_: Exception) {
                return null
            }
            return UpdateUrls.parseAllowed(next.toString())
        }
    }
}
