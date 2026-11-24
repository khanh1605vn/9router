package vn.banduong.app.web

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException

@RunWith(RobolectricTestRunner::class)
class WebAssetsTest {

    @Test
    fun normalizePath() {
        assertEquals("index.html", WebAssets.normalizePath(""))
        assertEquals("index.html", WebAssets.normalizePath("/"))
        assertEquals("js/main.js", WebAssets.normalizePath("js/main.js"))
        assertEquals("models/index.html", WebAssets.normalizePath("models/"))
        assertNull(WebAssets.normalizePath("../secret"))
        assertNull(WebAssets.normalizePath("js/../../x"))
        assertNull(WebAssets.normalizePath("js/./main.js"))
        assertNull(WebAssets.normalizePath("js//main.js"))
        assertNull(WebAssets.normalizePath("js\\main.js"))
        assertNull(WebAssets.normalizePath("js/ma\u0000in.js"))
    }

    @Test
    fun mimeTypes() {
        assertEquals("text/javascript", WebAssets.mimeTypeFor("js/main.js"))
        assertEquals("application/wasm", WebAssets.mimeTypeFor("vendor/litert/litert_wasm_internal.wasm"))
        assertEquals("application/manifest+json", WebAssets.mimeTypeFor("manifest.webmanifest"))
        assertEquals("application/octet-stream", WebAssets.mimeTypeFor("models/sign-det.int8.tflite"))
        assertEquals("image/svg+xml", WebAssets.mimeTypeFor("icons/icon.svg"))
        assertEquals("text/html", WebAssets.mimeTypeFor("index.html"))
    }

    @Test
    fun handlerServesFromWwwAndReturns404() {
        val opened = ArrayList<String>()
        val h = WebAssets.WwwPathHandler { p ->
            opened += p
            if (p == "www/index.html") ByteArrayInputStream("<!doctype html>".toByteArray()) else throw FileNotFoundException(p)
        }
        val ok = h.handle("")
        assertEquals(200, ok.statusCode)
        assertEquals("text/html", ok.mimeType)
        assertEquals("utf-8", ok.encoding)
        val csp = ok.responseHeaders["Content-Security-Policy"]!!
        assertTrue(csp.contains("object-src 'none'"))
        // Chỉ mã đóng gói: không 'unsafe-inline', không 'unsafe-eval', không nguồn ngoài.
        assertTrue(csp.contains("script-src 'self' 'wasm-unsafe-eval';"))
        assertTrue(csp.contains("worker-src 'self' blob:;"))
        assertTrue(csp.contains("frame-src 'none'"))
        assertFalse(csp.contains("unsafe-inline") || csp.contains("'unsafe-eval'") || csp.contains("https:"))
        assertEquals("nosniff", ok.responseHeaders["X-Content-Type-Options"])
        assertEquals(404, h.handle("nope.js").statusCode)
        assertEquals(404, h.handle("../etc/passwd").statusCode)
        assertEquals(listOf("www/index.html", "www/nope.js"), opened)
    }

    @Test
    fun origins() {
        assertTrue(AppOrigin.isAppUri(Uri.parse("https://appassets.androidplatform.net/index.html")))
        assertTrue(AppOrigin.isAppUri(Uri.parse("https://APPASSETS.androidplatform.net/js/main.js?v=1")))
        assertFalse(AppOrigin.isAppUri(Uri.parse("http://appassets.androidplatform.net/index.html")))
        assertFalse(AppOrigin.isAppUri(Uri.parse("https://appassets.androidplatform.net.evil.com/")))
        assertFalse(AppOrigin.isAppUri(Uri.parse("https://user@appassets.androidplatform.net/")))
        assertFalse(AppOrigin.isAppUri(Uri.parse("https://appassets.androidplatform.net:444/")))
        assertFalse(AppOrigin.isAppUri(Uri.parse("file:///android_asset/www/index.html")))

        assertTrue(AppOrigin.isAppOrigin("https://appassets.androidplatform.net/"))
        assertTrue(AppOrigin.isAppOrigin("https://appassets.androidplatform.net"))
        assertFalse(AppOrigin.isAppOrigin("https://appassets.androidplatform.net/x"))
        assertFalse(AppOrigin.isAppOrigin("https://tiles.openfreemap.org/"))
        assertFalse(AppOrigin.isAppOrigin(null))

        assertTrue(AppOrigin.isExternalWebLink(Uri.parse("https://www.openstreetmap.org/copyright")))
        assertFalse(AppOrigin.isExternalWebLink(Uri.parse("intent://x#Intent;scheme=http;end")))
        assertFalse(AppOrigin.isExternalWebLink(Uri.parse("javascript:alert(1)")))
        assertFalse(AppOrigin.isExternalWebLink(Uri.parse("file:///sdcard/a")))
        assertFalse(AppOrigin.isExternalWebLink(Uri.parse("content://x/y")))
        assertFalse(AppOrigin.isExternalWebLink(Uri.parse("https://appassets.androidplatform.net/index.html")))
    }

    /** Tác vụ copyWebAssets đã đưa đúng bộ tệp của `npm run dist` vào APK. */
    @Test
    fun webAppIsBundledInAssets() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        for (p in listOf("index.html", "manifest.webmanifest", "sw.js", "css/app.css", "js/main.js", "icons/icon.svg",
            "vendor/maplibre-gl/maplibre-gl.js", "models/labels.json")) {
            ctx.assets.open("www/$p").use { assertNotNull(p, it.read()) }
        }
        val top = ctx.assets.list("www")!!.toSet()
        assertFalse("tests/ không được đóng gói", "tests" in top)
        assertFalse("tools/ không được đóng gói", "tools" in top)
        assertFalse("android/ không được đóng gói", "android" in top)
        assertFalse("package.json không được đóng gói", "package.json" in top)
    }
}
