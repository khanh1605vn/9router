package vn.banduong.app.bridge

import android.net.Uri
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativeBridgeTest {
    private val now = 1_764_000_000_000L
    private var nanos = 0L
    private val keepOn = ArrayList<Boolean>()
    private var car = false

    private val host = object : NativeBridge.Host {
        override fun setKeepScreenOn(on: Boolean) {
            keepOn += on
        }
        override fun isCarConnected() = car
        override fun appVersion() = "0.1.0-test"
    }

    private class FakeReply : JavaScriptReplyProxy() {
        val sent = ArrayList<String>()
        override fun postMessage(message: String) {
            sent += message
        }
        override fun postMessage(arrayBuffer: ByteArray) = Unit
        override fun executeJavaScript(
            script: String,
            callback: androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException>?,
        ) = Unit
    }

    private val app = Uri.parse("https://appassets.androidplatform.net")
    private lateinit var bridge: NativeBridge

    @Before
    fun setUp() {
        CarStateStore.resetForTest()
        bridge = NativeBridge(host, nowMs = { now }, uptimeMs = { 1000L }, clockNanos = { nanos })
    }

    @After
    fun tearDown() = CarStateStore.resetForTest()

    private fun stateJson(speed: Int) = """{"v":1,"type":"state","ts":$now,"speed":$speed}"""

    @Test
    fun stateFromAppOriginReachesHub() {
        bridge.handle(stateJson(42), app, true, null)
        assertEquals(42.0, CarStateStore.snapshot.state!!.speedKmh!!, 1e-9)
    }

    @Test
    fun otherOriginsAndSubframesAreIgnored() {
        bridge.handle(stateJson(1), Uri.parse("https://evil.example"), true, null)
        bridge.handle(stateJson(2), Uri.parse("http://appassets.androidplatform.net"), true, null)
        bridge.handle(stateJson(3), Uri.parse("https://appassets.androidplatform.net:8443"), true, null)
        bridge.handle(stateJson(4), app, false, null)
        assertNull(CarStateStore.snapshot.state)
        assertEquals(4, bridge.droppedCount)
    }

    @Test
    fun stateIsRateLimitedTo4PerSecond() {
        for (i in 1..10) bridge.handle(stateJson(i), app, true, null)
        assertEquals(4.0, CarStateStore.snapshot.state!!.speedKmh!!, 1e-9)
        nanos += 1_000_000_000L
        for (i in 11..20) bridge.handle(stateJson(i), app, true, null)
        assertEquals(14.0, CarStateStore.snapshot.state!!.speedKmh!!, 1e-9)
    }

    @Test
    fun helloRepliesWithNativeStatusAndCarEvents() {
        car = true
        val reply = FakeReply()
        bridge.handle("""{"v":1,"type":"hello"}""", app, true, reply)
        assertEquals(1, reply.sent.size)
        val m = JSONObject(reply.sent[0])
        assertEquals("native", m.getString("type"))
        assertTrue(m.getBoolean("carConnected"))
        bridge.notifyCarConnected(false)
        assertEquals("carConnected", JSONObject(reply.sent[1]).getString("type"))
        // Trang nạp lại: kênh cũ bị bỏ, không gửi nữa.
        bridge.onPageStarted()
        bridge.notifyCarConnected(true)
        assertEquals(2, reply.sent.size)
    }

    @Test
    fun keepScreenOnAndPageReset() {
        bridge.handle("""{"v":1,"type":"keepScreenOn","on":true}""", app, true, null)
        bridge.handle("""{"v":1,"type":"keepScreenOn","on":"x"}""", app, true, null)
        bridge.handle(stateJson(30), app, true, null)
        assertNotNull(CarStateStore.snapshot.state)
        bridge.onPageStarted()
        assertEquals(listOf(true, false), keepOn)
        assertNull(CarStateStore.snapshot.state)
    }

    @Test
    fun unknownCommandsDoNothing() {
        bridge.handle("""{"v":1,"type":"openUrl","url":"https://evil.example"}""", app, true, null)
        bridge.handle("""{"v":1,"type":"exec"}""", app, true, null)
        assertTrue(keepOn.isEmpty())
        assertNull(CarStateStore.snapshot.state)
        assertEquals(2, bridge.droppedCount)
    }
}
