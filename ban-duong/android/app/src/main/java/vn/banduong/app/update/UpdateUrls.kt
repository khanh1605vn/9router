package vn.banduong.app.update

import java.net.URI
import java.net.URISyntaxException

/**
 * Phạm vi của một lần tải: địa chỉ đầu và từng bước chuyển hướng phải nằm trong đó (ngoài danh sách trắng chung của
 * [UpdateUrls.parseAllowed]). Mỗi loại yêu cầu một phạm vi hẹp, xem [UpdateUrls.API_SCOPE] và [UpdateUrls.downloadScope].
 */
fun interface UrlScope {
    fun allows(uri: URI): Boolean
}

/**
 * Danh sách trắng địa chỉ mà bộ cập nhật được phép gọi (kể cả từng bước chuyển hướng):
 *  - chỉ https, cổng mặc định (443), không user-info, không địa chỉ IP;
 *  - máy chủ đúng là api.github.com, github.com, hoặc một trong hai máy chủ GitHub đặt tệp đính kèm của bản phát hành
 *    (release-assets.githubusercontent.com, objects.githubusercontent.com). Không nhận các tên con khác của
 *    githubusercontent.com (raw., gist.…: nội dung do người dùng bất kỳ đưa lên).
 * Thêm vào đó mỗi lần tải có một [UrlScope] riêng: gọi API chỉ tới api.github.com; tải tệp chỉ tới đúng
 * github.com/<kho>/releases/download/… rồi chuyển sang máy chủ tệp đính kèm.
 * Địa chỉ luôn do máy tự dựng từ BuildConfig (kho, tiền tố thẻ) và trả lời của GitHub; trang web không bao giờ gửi URL.
 */
object UpdateUrls {
    private const val API_HOST = "api.github.com"
    private const val WEB_HOST = "github.com"
    private val ASSET_HOSTS = setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com")
    private val EXACT_HOSTS = setOf(API_HOST, WEB_HOST) + ASSET_HOSTS

    /** Gọi API: chỉ api.github.com (GitHub có thể chuyển hướng trong API khi kho đổi tên). */
    val API_SCOPE = UrlScope { it.host == API_HOST }

    /**
     * Tải update.json / APK của [repo]: github.com chỉ với đường dẫn /<repo>/releases/download/…, rồi máy chủ tệp đính kèm.
     * Đường dẫn được so ở dạng thô (chưa giải mã) và không được có đoạn "." hay "..".
     */
    fun downloadScope(repo: String): UrlScope {
        require(REPO_RE.matches(repo) && !repo.contains("..")) { "repo" }
        val prefix = "/$repo/releases/download/"
        return UrlScope { uri ->
            when (uri.host) {
                WEB_HOST -> {
                    val path = uri.rawPath ?: return@UrlScope false
                    path.startsWith(prefix) && path.split('/').none { it == "." || it == ".." || it.contains('%') }
                }
                in ASSET_HOSTS -> true
                else -> false
            }
        }
    }

    const val RELEASES_PER_PAGE = 100

    /** owner/repo của GitHub (chữ, số, '-', '_', '.'), không có '..'. */
    val REPO_RE = Regex("^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")

    /** Đọc chặt một địa chỉ tuyệt đối; null nếu sai cú pháp hoặc ngoài danh sách trắng. */
    fun parseAllowed(raw: String?): URI? {
        if (raw == null || raw.length > 2048) return null
        // Không nhận ký tự điều khiển, khoảng trắng hay '\' (một số bộ đọc URL hiểu '\' như '/').
        if (raw.any { it <= ' ' || it == '\\' || it.code >= 0x7F }) return null
        val uri = try {
            URI(raw)
        } catch (_: URISyntaxException) {
            return null
        }
        return uri.takeIf { isAllowed(it) }
    }

    fun isAllowed(uri: URI): Boolean {
        if (!uri.isAbsolute || uri.isOpaque) return false
        if (uri.scheme != "https") return false
        if (uri.rawUserInfo != null) return false
        if (uri.port != -1 && uri.port != 443) return false
        val host = uri.host ?: return false
        // URI giữ nguyên hoa/thường; ta chỉ nhận chữ thường để không có hai cách viết cùng một máy chủ.
        if (host != host.lowercase() || host.endsWith('.')) return false
        if (host.startsWith('[') || host.all { it.isDigit() || it == '.' }) return false
        return host in EXACT_HOSTS
    }

    /** Địa chỉ danh sách bản phát hành (API công khai, không cần đăng nhập). */
    fun releasesApi(repo: String): String {
        require(REPO_RE.matches(repo) && !repo.contains("..")) { "repo" }
        // 100 là tối đa của GitHub: kho dùng chung với các bản phát hành của 9router, 30 bản mới nhất có thể không còn bản
        // nào của Bạn Đường. Thân trả lời vẫn bị cắt ở ReleaseSelector.MAX_API_BYTES.
        return "https://api.github.com/repos/$repo/releases?per_page=$RELEASES_PER_PAGE"
    }

    /** Địa chỉ tải tệp đính kèm mà GitHub dùng (browser_download_url); máy tự dựng, chỉ so với trả lời của API. */
    fun assetDownload(repo: String, tag: String, name: String): String {
        require(REPO_RE.matches(repo) && !repo.contains("..")) { "repo" }
        require(ReleaseSelector.SAFE_SEGMENT.matches(tag) && ReleaseSelector.SAFE_SEGMENT.matches(name)) { "segment" }
        return "https://github.com/$repo/releases/download/$tag/$name"
    }

    /** Trang của một bản phát hành (để mở bằng trình duyệt ở bản sideload). */
    fun releasePage(repo: String, tag: String): String {
        require(REPO_RE.matches(repo) && !repo.contains("..")) { "repo" }
        require(ReleaseSelector.SAFE_SEGMENT.matches(tag)) { "segment" }
        return "https://github.com/$repo/releases/tag/$tag"
    }
}
