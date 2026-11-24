package vn.banduong.app.update

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI

class SafeHttpTest {
    private var now = 1_764_000_000_000L
    private val t = FakeTransport()
    private val http = SafeHttp(t) { now }
    private val far = Long.MAX_VALUE
    /** Phạm vi không thêm giới hạn nào (chỉ còn danh sách trắng chung): để thử riêng phần HTTP. */
    private val all = UrlScope { true }
    private val download = UpdateUrls.downloadScope(REPO)

    private fun code(block: () -> Unit): String {
        try {
            block()
        } catch (e: UpdateError) {
            return e.code
        }
        fail("phải ném UpdateError")
        return ""
    }

    @Test
    fun allowListAcceptsOnlyGithubHosts() {
        val ok = listOf(
            "https://api.github.com/repos/a/b/releases",
            "https://github.com/a/b/releases/download/t/x.apk",
            "https://release-assets.githubusercontent.com/x?sig=1&exp=2",
            "https://objects.githubusercontent.com/github-production-release-asset/1",
            "https://github.com:443/a",
        )
        for (u in ok) assertNotNull(u, UpdateUrls.parseAllowed(u))
        val bad = listOf(
            "http://github.com/a", // không phải https
            "https://user@github.com/a", // user-info
            "https://github.com:pass@evil.com/a",
            "https://github.com.evil.com/a",
            "https://evilgithub.com/a",
            "https://githubusercontent.com/a", // phải là tên con
            "https://evil.com/github.com",
            "https://evil.com/?h=.githubusercontent.com",
            "https://x.githubusercontent.com.evil.com/a",
            "https://GitHub.com/a", // chữ hoa: không nhận
            "https://github.com./a",
            "https://github.com:8443/a",
            "https://140.82.112.3/a",
            "https://[::1]/a",
            "https://evil.com\\@github.com/a",
            "https://github.com/a b",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "//github.com/a",
            "https://a_b.githubusercontent.com/x",
            // Tên con khác của githubusercontent.com: nội dung do người dùng bất kỳ đưa lên.
            "https://raw.githubusercontent.com/evil/x/main/a.apk",
            "https://gist.githubusercontent.com/evil/abc/raw/a.apk",
            "https://user-images.githubusercontent.com/1/a.apk",
            "",
        )
        for (u in bad) assertNull(u, UpdateUrls.parseAllowed(u))
        assertNull(UpdateUrls.parseAllowed(null))
    }

    @Test
    fun followsAllowedRedirectsAndRejectsEvilHops() {
        val apk = ByteArray(10) { it.toByte() }
        val a = "https://github.com/$REPO/releases/download/t/ban-duong.apk"
        val b = "https://release-assets.githubusercontent.com/f?x=1"
        t.redirect(a, b)
        t.ok(b, apk)
        assertArrayEquals(apk, http.fetchBytes(download, a, "x", 100, far))
        assertEquals(listOf(a, b), t.requests.map { it.first })

        for (
            evil in listOf(
                "https://evil.example/f", "http://release-assets.githubusercontent.com/f", "https://u:p@github.com/f",
                "https://github.com:444/f",
                // Trong danh sách trắng chung nhưng ngoài phạm vi tải tệp của kho này:
                "https://github.com/evil/other/releases/download/t/a.apk",
                "https://github.com/$REPO/raw/master/a.apk",
                "https://github.com/$REPO/releases/download/../../../evil/x/releases/download/t/a.apk",
                "https://github.com/$REPO/releases/download/t/%2e%2e/a.apk",
                "https://api.github.com/repos/$REPO/releases",
                "https://raw.githubusercontent.com/evil/x/main/a.apk",
                "https://gist.githubusercontent.com/evil/abc/raw/a.apk",
            )
        ) {
            t.requests.clear()
            t.redirect(a, evil)
            assertEquals(evil, SafeHttp.E_BAD_REDIRECT, code { http.fetchBytes(download, a, "x", 100, far) })
            assertEquals("không được gọi tới máy chủ lạ", 1, t.requests.size)
        }
        t.routes[a] = FakeTransport.Resp(302) // thiếu Location
        assertEquals(SafeHttp.E_BAD_REDIRECT, code { http.fetchBytes(all, a, "x", 100, far) })
    }

    @Test
    fun relativeRedirectIsResolvedAndChecked() {
        val base = URI("https://github.com/a/b")
        assertEquals("https://github.com/c", SafeHttp.resolveRedirect(base, "/c").toString())
        assertNull(SafeHttp.resolveRedirect(base, "//evil.com/c"))
        assertNull(SafeHttp.resolveRedirect(base, "http://github.com/c"))
        assertNull(SafeHttp.resolveRedirect(base, "https://github.com/c\r\nX: y"))
    }

    @Test
    fun redirectLoopsStop() {
        val a = "https://github.com/a"
        val b = "https://github.com/b"
        t.redirect(a, b)
        t.redirect(b, a)
        assertEquals(SafeHttp.E_BAD_REDIRECT, code { http.fetchBytes(all, a, "x", 100, far) })
        assertEquals(SafeHttp.MAX_REDIRECTS + 1, t.requests.size)
    }

    @Test
    fun sizeCapsAreEnforcedBeforeAndWhileReading() {
        val u = "https://api.github.com/x"
        t.ok(u, ByteArray(101))
        assertEquals(SafeHttp.E_TOO_LARGE, code { http.fetchBytes(all, u, "x", 100, far) })
        // Không khai báo độ dài: vẫn dừng khi vượt.
        t.routes[u] = FakeTransport.Resp(200, ByteArray(200_000), declared = -1)
        val out = ByteArrayOutputStream()
        assertEquals(SafeHttp.E_TOO_LARGE, code { http.fetch(all, u, "x", 100_000, far, out) { _, _ -> } })
        assertTrue(out.size() <= 100_000)
        // Thân ngắn hơn độ dài khai báo (bị cắt) → lỗi mạng.
        t.routes[u] = FakeTransport.Resp(200, ByteArray(10), declared = 20)
        assertEquals(SafeHttp.E_NETWORK, code { http.fetchBytes(all, u, "x", 100, far) })
        t.ok(u, ByteArray(100))
        assertEquals(100, http.fetchBytes(all, u, "x", 100, far).size)
    }

    @Test
    fun rateLimitsGiveRetryTime() {
        val u = "https://api.github.com/x"
        t.routes[u] = FakeTransport.Resp(403, headers = mapOf("X-RateLimit-Remaining" to "0", "X-RateLimit-Reset" to ((now / 1000) + 1800).toString()))
        var e = runCatching { http.fetchBytes(all, u, "x", 100, far) }.exceptionOrNull() as UpdateError
        assertEquals(SafeHttp.E_RATE_LIMITED, e.code)
        assertEquals(now + 1_800_000, e.retryAtMs)
        t.routes[u] = FakeTransport.Resp(429, headers = mapOf("Retry-After" to "5"))
        e = runCatching { http.fetchBytes(all, u, "x", 100, far) }.exceptionOrNull() as UpdateError
        assertEquals("tối thiểu 60 giây", now + SafeHttp.MIN_BACKOFF_MS, e.retryAtMs)
        t.routes[u] = FakeTransport.Resp(429, headers = mapOf("Retry-After" to "999999999"))
        e = runCatching { http.fetchBytes(all, u, "x", 100, far) }.exceptionOrNull() as UpdateError
        assertEquals("tối đa 6 giờ", now + SafeHttp.MAX_BACKOFF_S * 1000, e.retryAtMs)
        t.routes[u] = FakeTransport.Resp(403)
        e = runCatching { http.fetchBytes(all, u, "x", 100, far) }.exceptionOrNull() as UpdateError
        assertEquals(now + SafeHttp.DEFAULT_BACKOFF_MS, e.retryAtMs)
    }

    @Test
    fun errorsAndHeaders() {
        val u = "https://api.github.com/x"
        assertEquals(SafeHttp.E_NOT_FOUND, code { http.fetchBytes(all, u, "x", 100, far) })
        t.routes[u] = FakeTransport.Resp(500)
        assertEquals(SafeHttp.E_NETWORK, code { http.fetchBytes(all, u, "x", 100, far) })
        t.failWith = IOException("boom")
        assertEquals(SafeHttp.E_NETWORK, code { http.fetchBytes(all, u, "x", 100, far) })
        t.failWith = null
        assertEquals(SafeHttp.E_BAD_URL, code { http.fetchBytes(all, "http://api.github.com/x", "x", 100, far) })
        assertEquals(SafeHttp.E_NETWORK, code { http.fetchBytes(all, u, "x", 100, now - 1) })
        // Chỉ gửi đúng các tiêu đề chung: không có Authorization, Cookie hay gì riêng tư.
        t.ok(u, "[]")
        t.requests.clear()
        http.fetchBytes(all, u, "application/vnd.github+json", 100, far)
        val h = t.requests.single().second
        assertEquals(setOf("Accept", "User-Agent", "X-GitHub-Api-Version"), h.keys)
        assertEquals("BanDuong-Updater", h["User-Agent"])
        t.ok("https://github.com/f", "x")
        t.requests.clear()
        http.fetchBytes(all, "https://github.com/f", "application/octet-stream", 100, far)
        assertFalse(t.requests.single().second.containsKey("X-GitHub-Api-Version"))
    }

    @Test
    fun eachRequestTypeHasItsOwnScope() {
        val api = UpdateUrls.API_SCOPE
        assertTrue(api.allows(URI(UpdateUrls.releasesApi(REPO))))
        assertTrue("kho đổi tên: GitHub chuyển hướng trong API", api.allows(URI("https://api.github.com/repositories/1/releases")))
        assertFalse(api.allows(URI("https://github.com/$REPO/releases")))
        assertFalse(api.allows(URI("https://release-assets.githubusercontent.com/x")))
        // Gọi API mà bị chuyển sang máy chủ tệp: từ chối, không gọi tới.
        val u = UpdateUrls.releasesApi(REPO)
        t.redirect(u, "https://release-assets.githubusercontent.com/x")
        assertEquals(SafeHttp.E_BAD_REDIRECT, code { http.fetchBytes(api, u, "x", 100, far) })
        assertEquals(1, t.requests.size)
        // Địa chỉ đầu ngoài phạm vi: không gọi gì cả.
        t.requests.clear()
        assertEquals(SafeHttp.E_BAD_URL, code { http.fetchBytes(api, "https://github.com/$REPO/releases/download/t/a.apk", "x", 100, far) })
        assertEquals(SafeHttp.E_BAD_URL, code { http.fetchBytes(download, "https://github.com/evil/x/releases/download/t/a.apk", "x", 100, far) })
        assertTrue(t.requests.isEmpty())

        assertTrue(download.allows(URI(UpdateUrls.assetDownload(REPO, "ban-duong-v1.2.0", "ban-duong.apk"))))
        assertTrue(download.allows(URI("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X=1")))
        assertFalse(download.allows(URI("https://github.com/$REPO/releases/download")))
        assertFalse(download.allows(URI("https://github.com/${REPO}x/releases/download/t/a.apk")))
        assertFalse(download.allows(URI("https://api.github.com/repos/$REPO/releases")))
        assertEquals("https://api.github.com/repos/$REPO/releases?per_page=100", UpdateUrls.releasesApi(REPO))
    }
}
