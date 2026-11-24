package vn.banduong.app.update

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit

const val REPO = "khanh1605vn/9router"
const val PREFIX = "ban-duong-v"
const val API = "https://api.github.com/repos/$REPO/releases?per_page=100"

fun dl(tag: String, name: String) = "https://github.com/$REPO/releases/download/$tag/$name"

fun sha256Hex(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

/** Một bản phát hành như API của GitHub trả. */
fun release(
    tag: String,
    apkSize: Long = 1000,
    manifestSize: Long = 300,
    draft: Any = false,
    prerelease: Any = false,
    assets: List<JSONObject>? = null,
): JSONObject = JSONObject()
    .put("tag_name", tag)
    .put("draft", draft)
    .put("prerelease", prerelease)
    .put("name", "Bạn Đường $tag")
    .put("author", JSONObject().put("login", "someone"))
    .put(
        "assets",
        JSONArray(
            assets ?: listOf(
                asset(tag, "ban-duong.apk", apkSize),
                asset(tag, "update.json", manifestSize),
            ),
        ),
    )

fun asset(tag: String, name: String, size: Long, state: String = "uploaded", url: String = dl(tag, name)): JSONObject =
    JSONObject().put("name", name).put("size", size).put("state", state).put("browser_download_url", url)
        .put("uploader", JSONObject().put("login", "github-actions[bot]"))

fun releases(vararg r: JSONObject): String = JSONArray(r.toList()).toString()

fun manifestJson(
    tag: String,
    versionCode: Long,
    apk: ByteArray,
    versionName: String = tag.removePrefix(PREFIX),
    minSdk: Int = 26,
    notes: String = "Sửa lỗi và cải thiện.",
    sha: String = sha256Hex(apk),
    size: Long = apk.size.toLong(),
): String = JSONObject()
    .put("versionCode", versionCode)
    .put("versionName", versionName)
    .put("sha256", sha)
    .put("size", size)
    .put("minSdk", minSdk)
    .put("notes", notes)
    .put("tag", tag)
    .toString()

/** Máy chủ giả: URL → trả lời. Ghi lại mọi yêu cầu (URL, tiêu đề). */
class FakeTransport : HttpTransport {
    data class Resp(val code: Int, val body: ByteArray = ByteArray(0), val headers: Map<String, String> = emptyMap(), val declared: Long? = null)

    val routes = HashMap<String, Resp>()
    val requests = ArrayList<Pair<String, Map<String, String>>>()
    var failWith: IOException? = null

    fun ok(url: String, body: String) { routes[url] = Resp(200, body.toByteArray()) }
    fun ok(url: String, body: ByteArray) { routes[url] = Resp(200, body) }
    fun redirect(url: String, to: String, code: Int = 302) { routes[url] = Resp(code, headers = mapOf("Location" to to)) }

    override fun get(url: URL, headers: Map<String, String>): HttpResponse {
        requests += url.toString() to headers
        failWith?.let { throw it }
        val r = routes[url.toString()] ?: Resp(404)
        return object : HttpResponse {
            override val code = r.code
            override val contentLength = r.declared ?: r.body.size.toLong()
            override fun header(name: String) = r.headers[name]
            override fun body(): InputStream = ByteArrayInputStream(r.body)
            override fun close() = Unit
        }
    }
}

/** Chạy ngay trên luồng gọi (kiểm thử không cần luồng nền). */
class DirectExecutor : AbstractExecutorService() {
    private var down = false
    override fun execute(command: Runnable) = command.run()
    override fun shutdown() { down = true }
    override fun shutdownNow(): MutableList<Runnable> { down = true; return mutableListOf() }
    override fun isShutdown() = down
    override fun isTerminated() = down
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
}

class MemPrefs : UpdatePrefs {
    override var lastCheckAt = 0L
    override var dismissedCode = 0L
    override var backoffUntil = 0L
}

class FakeScheduler : UpdateScheduler {
    val tasks = ArrayList<Pair<Long, Runnable>>()
    override fun schedule(delayMs: Long, task: Runnable): Runnable {
        tasks += delayMs to task
        return task
    }
    override fun cancel(token: Runnable) {
        tasks.removeAll { it.second === token }
    }
    fun runNext(): Long {
        val (d, t) = tasks.removeAt(0)
        t.run()
        return d
    }
}
