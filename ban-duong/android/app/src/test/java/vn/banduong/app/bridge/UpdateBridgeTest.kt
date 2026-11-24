package vn.banduong.app.bridge

import android.net.Uri
import androidx.webkit.JavaScriptReplyProxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.update.UpdateCommands

@RunWith(RobolectricTestRunner::class)
class UpdateBridgeTest {
    private val now = 1_764_000_000_000L
    private var nanos = 0L
    private val app = Uri.parse("https://appassets.androidplatform.net")

    private val host = object : NativeBridge.Host {
        override fun setKeepScreenOn(on: Boolean) = Unit
        override fun isCarConnected() = false
        override fun appVersion() = "1.1.0"
    }

    private class FakeUpdate : UpdateCommands {
        override var sink: ((String) -> Unit)? = null
        val calls = ArrayList<String>()
        override fun check(manual: Boolean) { calls += "check:$manual" }
        override fun install() { calls += "install" }
        override fun dismiss() { calls += "dismiss" }
        override fun resend() {
            calls += "resend"
            sink?.invoke("""{"v":1,"type":"updateStatus","state":"idle"}""")
        }
    }

    private class FakeReply : JavaScriptReplyProxy() {
        val sent = ArrayList<String>()
        override fun postMessage(message: String) { sent += message }
        override fun postMessage(arrayBuffer: ByteArray) = Unit
        override fun executeJavaScript(
            script: String,
            callback: androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException>?,
        ) = Unit
    }

    private lateinit var update: FakeUpdate
    private lateinit var bridge: NativeBridge

    @Before
    fun setUp() {
        CarStateStore.resetForTest()
        update = FakeUpdate()
        bridge = NativeBridge(host, update = update, nowMs = { now }, uptimeMs = { 1000L }, clockNanos = { nanos })
    }

    private fun msg(action: String) = """{"v":1,"type":"update","action":"$action"}"""

    @Test
    fun parserAcceptsOnlyKnownActions() {
        for (a in listOf("check", "install", "dismiss", "status")) {
            val r = BridgeMessageParser.parse(msg(a), now)
            assertEquals(a, ((r as ParseResult.Ok).message as InboundMessage.Update).action.key)
        }
        val bad = listOf(
            msg("download"),
            msg("INSTALL"),
            """{"v":1,"type":"update"}""",
            """{"v":1,"type":"update","action":1}""",
            """{"v":1,"type":"update","action":["install"]}""",
            """{"v":2,"type":"update","action":"install"}""",
            """{"v":1,"type":"update","action":'install'}""",
            """{"v":1,"type":"update","action":"install",}""",
        )
        for (b in bad) assertTrue(b, BridgeMessageParser.parse(b, now) is ParseResult.Rejected)
        // Trường thừa (ví dụ một URL) bị bỏ qua hoàn toàn: máy không bao giờ dùng địa chỉ từ trang.
        val withUrl = BridgeMessageParser.parse("""{"v":1,"type":"update","action":"install","url":"https://evil.example/x.apk"}""", now)
        assertEquals(InboundMessage.Update(UpdateAction.INSTALL), (withUrl as ParseResult.Ok).message)
    }

    @Test
    fun actionsReachUpdaterAndStatusGoesBack() {
        val reply = FakeReply()
        bridge.handle("""{"v":1,"type":"hello"}""", app, true, reply)
        assertTrue("hello gửi kèm trạng thái cập nhật", reply.sent.any { it.contains("updateStatus") })
        bridge.handle(msg("check"), app, true, reply)
        bridge.handle(msg("dismiss"), app, true, reply)
        bridge.handle(msg("install"), app, true, reply)
        assertEquals(listOf("resend", "check:true", "dismiss", "install"), update.calls)
    }

    @Test
    fun otherOriginsCannotUpdate() {
        bridge.handle(msg("install"), Uri.parse("https://evil.example"), true, null)
        bridge.handle(msg("install"), app, false, null)
        assertTrue(update.calls.isEmpty())
    }

    @Test
    fun updateMessagesAreRateLimited() {
        for (i in 1..10) bridge.handle(msg("check"), app, true, null)
        assertEquals(4, update.calls.size)
        nanos += 1_000_000_000L
        update.calls.clear()
        // install: tối đa 1 lần mỗi 10 giây.
        for (i in 1..3) bridge.handle(msg("install"), app, true, null)
        assertEquals(listOf("install"), update.calls)
        nanos += 5_000_000_000L
        bridge.handle(msg("install"), app, true, null)
        assertEquals(1, update.calls.size)
        nanos += 5_100_000_000L
        bridge.handle(msg("install"), app, true, null)
        assertEquals(2, update.calls.size)
    }

    @Test
    fun withoutUpdaterMessagesAreDropped() {
        val b = NativeBridge(host, nowMs = { now }, uptimeMs = { 1000L }, clockNanos = { nanos })
        b.handle(msg("install"), app, true, null)
        assertEquals(1, b.droppedCount)
    }
}
