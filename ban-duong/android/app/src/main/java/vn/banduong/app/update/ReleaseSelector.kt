package vn.banduong.app.update

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import vn.banduong.app.bridge.BridgeMessageParser

/** Bản phát hành phù hợp đã chọn từ danh sách của GitHub (chưa đọc update.json). */
data class ReleaseCandidate(
    val tag: String,
    val versionName: String,
    val apkUrl: String,
    val apkSize: Long,
    val manifestUrl: String,
)

/** Nội dung update.json đã kiểm tra, khớp với [ReleaseCandidate]. */
data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    val sha256: String,
    val size: Long,
    val minSdk: Int,
    val notes: String,
    val tag: String,
)

/**
 * Chọn bản phát hành và đọc update.json. Kho chung với 9router nên có nhiều bản phát hành khác: chỉ nhận bản không
 * phải nháp, không phải thử nghiệm (prerelease), thẻ đúng `<tiền tố><số.số…>`, có đủ hai tệp [APK_ASSET] và
 * [MANIFEST_ASSET] đã tải lên xong. Mọi thứ khác bị bỏ qua (không lỗi).
 */
object ReleaseSelector {
    const val APK_ASSET = "ban-duong.apk"
    const val MANIFEST_ASSET = "update.json"

    // Giới hạn cứng (byte) cho từng loại trả lời. API: 100 bản phát hành (per_page=100) của kho dùng chung với 9router,
    // có bản kèm ghi chú dài; 4 MiB vẫn nhỏ với bộ nhớ.
    const val MAX_API_BYTES = 4L shl 20
    const val MAX_MANIFEST_BYTES = 16L shl 10
    const val MAX_APK_BYTES = 80L shl 20

    const val MAX_NOTES_CHARS = 300
    private const val MAX_VERSION_CODE = 2_100_000_000L

    /** Một đoạn đường dẫn an toàn (thẻ, tên tệp): không có '/', '%', '..'. */
    val SAFE_SEGMENT = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
    val VERSION_NAME_RE = Regex("^[0-9]{1,4}(\\.[0-9]{1,4}){0,3}$")
    private val SHA256_RE = Regex("^[0-9a-f]{64}$")

    fun select(json: String, repo: String, prefix: String): ReleaseCandidate? {
        val arr = try {
            if (BridgeMessageParser.prescan(json, 8) != null) return null
            JSONArray(json)
        } catch (_: JSONException) {
            return null
        } catch (_: StackOverflowError) {
            return null
        }
        var best: ReleaseCandidate? = null
        var bestVersion: List<Int>? = null
        for (i in 0 until minOf(arr.length(), 100)) {
            val rel = arr.optJSONObject(i) ?: continue
            val c = candidate(rel, repo, prefix) ?: continue
            val v = parseVersion(c.versionName) ?: continue
            // GitHub trả mới nhất trước; khi trùng số phiên bản thì giữ bản đứng trước.
            if (bestVersion == null || compareVersions(v, bestVersion) > 0) {
                best = c
                bestVersion = v
            }
        }
        return best
    }

    private fun candidate(rel: JSONObject, repo: String, prefix: String): ReleaseCandidate? {
        if (rel.opt("draft") != false || rel.opt("prerelease") != false) return null
        val tag = rel.opt("tag_name") as? String ?: return null
        if (!tag.startsWith(prefix) || !SAFE_SEGMENT.matches(tag)) return null
        val versionName = tag.removePrefix(prefix)
        if (!VERSION_NAME_RE.matches(versionName)) return null
        val assets = rel.optJSONArray("assets") ?: return null
        var apkSize = -1L
        var hasManifest = false
        for (j in 0 until minOf(assets.length(), 100)) {
            val a = assets.optJSONObject(j) ?: continue
            val name = a.opt("name") as? String ?: continue
            if (name != APK_ASSET && name != MANIFEST_ASSET) continue
            if (a.opt("state") != "uploaded") continue
            val size = (a.opt("size") as? Number)?.toLong() ?: continue
            // Địa chỉ tải phải đúng địa chỉ máy tự dựng (đúng kho, đúng thẻ, đúng tên tệp).
            if (a.opt("browser_download_url") != UpdateUrls.assetDownload(repo, tag, name)) continue
            if (name == APK_ASSET) {
                if (size !in 1..MAX_APK_BYTES) return null
                apkSize = size
            } else {
                if (size !in 1..MAX_MANIFEST_BYTES) return null
                hasManifest = true
            }
        }
        if (apkSize < 0 || !hasManifest) return null
        return ReleaseCandidate(
            tag = tag,
            versionName = versionName,
            apkUrl = UpdateUrls.assetDownload(repo, tag, APK_ASSET),
            apkSize = apkSize,
            manifestUrl = UpdateUrls.assetDownload(repo, tag, MANIFEST_ASSET),
        )
    }

    /**
     * Đọc update.json của [c]: mọi trường bắt buộc, đúng kiểu, đúng khoảng, và khớp bản phát hành (thẻ, tên phiên bản,
     * kích thước APK). Sai bất cứ điều gì → null (coi như bản phát hành hỏng).
     */
    fun parseManifest(json: String, c: ReleaseCandidate): UpdateManifest? {
        val o = try {
            if (BridgeMessageParser.prescan(json, 3) != null) return null
            JSONObject(json)
        } catch (_: JSONException) {
            return null
        } catch (_: StackOverflowError) {
            return null
        }
        val code = integer(o.opt("versionCode"), 1, MAX_VERSION_CODE) ?: return null
        val name = o.opt("versionName") as? String ?: return null
        if (name != c.versionName) return null
        if (o.opt("tag") != c.tag) return null
        val sha = (o.opt("sha256") as? String)?.lowercase()?.takeIf { SHA256_RE.matches(it) } ?: return null
        val size = integer(o.opt("size"), 1, MAX_APK_BYTES) ?: return null
        if (size != c.apkSize) return null
        val minSdk = integer(o.opt("minSdk"), 21, 1000)?.toInt() ?: return null
        val notes = when (val n = o.opt("notes")) {
            null, JSONObject.NULL -> ""
            is String -> BridgeMessageParser.cleanText(n, MAX_NOTES_CHARS) ?: ""
            else -> return null
        }
        return UpdateManifest(code, name, sha, size, minSdk, notes, c.tag)
    }

    private fun integer(raw: Any?, min: Long, max: Long): Long? {
        val n = raw as? Number ?: return null
        val d = n.toDouble()
        if (!d.isFinite() || d != Math.floor(d) || d < min || d > max) return null
        return d.toLong()
    }

    /** "1.10.2" → [1, 10, 2]; null nếu sai dạng. */
    fun parseVersion(name: String): List<Int>? =
        if (VERSION_NAME_RE.matches(name)) name.split('.').map { it.toInt() } else null

    /** So sánh từng phần, phần thiếu coi là 0 (1.2 == 1.2.0). */
    fun compareVersions(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x.compareTo(y)
        }
        return 0
    }
}
