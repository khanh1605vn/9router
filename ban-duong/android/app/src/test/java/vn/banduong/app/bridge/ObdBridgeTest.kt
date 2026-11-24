package vn.banduong.app.bridge

import android.net.Uri
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import vn.banduong.app.obd.ObdController
import vn.banduong.app.obd.ObdDevice
import vn.banduong.app.obd.ObdKind
import vn.banduong.app.obd.ObdLink
import vn.banduong.app.obd.ObdPicker
import vn.banduong.app.obd.PickResult

/** Thông điệp OBD qua cầu nối: kiểm tra từng trường, giới hạn nhịp, chỉ nguồn gốc của ứng dụng. */
@RunWith(RobolectricTestRunner::class)
class ObdBridgeTest {
    private val now = 1_764_000_000_000L
    private var nanos = 0L
    private val app = Uri.parse("https://appassets.androidplatform.net")
    private val host = object : NativeBridge.Host {
        override fun setKeepScreenOn(on: Boolean) = Unit
        override fun isCarConnected() = false
        override fun appVersion() = "test"
    }
    private val picks = ArrayList<Pair<ObdKind, Boolean>>()
    private val writes = ArrayList<String>()
    private var pending: ((PickResult) -> Unit)? = null
    private val picker = object : ObdPicker {
        override fun hasRecentUserGesture() = true
        override fun pick(kind: ObdKind, showAll: Boolean, done: (PickResult) -> Unit) {
            picks += kind to showAll
            pending = done
        }
        override fun cancel() {
            pending = null
        }
    }
    private val factory = ObdLink.Factory { _, l ->
        object : ObdLink {
            override fun open() = l.onOpen()
            override fun write(bytes: ByteArray): Boolean {
                writes += String(bytes, Charsets.US_ASCII)
                return true
            }
            override fun close() = Unit
        }
    }
    private lateinit var obd: ObdController
    private lateinit var bridge: NativeBridge
    private val out = ArrayList<String>()

    @Before
    fun setUp() {
        CarStateStore.resetForTest()
        obd = ObdController(picker, factory, clockNanos = { nanos })
        bridge = NativeBridge(host, obd, nowMs = { now }, uptimeMs = { 1000L }, clockNanos = { nanos })
        obd.sink = { out += it } // bỏ kênh trả lời thật, ghi lại để xem
    }

    @After
    fun tearDown() = CarStateStore.resetForTest()

    private fun parse(s: String) = BridgeMessageParser.parse(s, now)

    @Test
    fun parserAcceptsOnlyWellFormedObdMessages() {
        val link = "0123456789abcdef"
        val ok = mapOf(
            """{"v":1,"type":"obdPick","req":1,"kind":"ble"}""" to InboundMessage.ObdPick(1, ObdKind.BLE, false),
            """{"v":1,"type":"obdPick","req":1000000000,"kind":"spp","all":true}""" to InboundMessage.ObdPick(1_000_000_000, ObdKind.SPP, true),
            """{"v":1,"type":"obdConnect","link":"$link"}""" to InboundMessage.ObdConnect(link),
            """{"v":1,"type":"obdDisconnect","link":"$link"}""" to InboundMessage.ObdDisconnect(link),
            """{"v":1,"type":"obdWrite","link":"$link","data":"010D\r"}""" to InboundMessage.ObdWrite(link, "010D\r"),
            """{"v":1,"type":"obdWrite","link":"$link","data":"X"}""" to InboundMessage.ObdWrite(link, "X"),
            """{"v":1,"type":"obdWrite","link":"$link","data":"\r"}""" to InboundMessage.ObdWrite(link, "\r"),
        )
        for ((json, msg) in ok) assertEquals(json, ParseResult.Ok(msg), parse(json))
        val bad = mapOf(
            """{"v":1,"type":"obdPick","kind":"ble"}""" to "bad-req",
            """{"v":1,"type":"obdPick","req":0,"kind":"ble"}""" to "bad-req",
            """{"v":1,"type":"obdPick","req":1.5,"kind":"ble"}""" to "bad-req",
            """{"v":1,"type":"obdPick","req":"1","kind":"ble"}""" to "bad-req",
            """{"v":1,"type":"obdPick","req":1000000001,"kind":"ble"}""" to "bad-req",
            """{"v":1,"type":"obdPick","req":1,"kind":"BLE"}""" to "bad-kind",
            """{"v":1,"type":"obdPick","req":1,"kind":"wifi"}""" to "bad-kind",
            """{"v":1,"type":"obdPick","req":1,"kind":"ble","all":"yes"}""" to "bad-all",
            """{"v":1,"type":"obdConnect"}""" to "bad-link",
            """{"v":1,"type":"obdConnect","link":"AA:BB:CC:DD:EE:FF"}""" to "bad-link",
            """{"v":1,"type":"obdConnect","link":"0123456789ABCDEF"}""" to "bad-link",
            """{"v":1,"type":"obdConnect","link":"${link}0"}""" to "bad-link",
            """{"v":1,"type":"obdDisconnect","link":5}""" to "bad-link",
            """{"v":1,"type":"obdWrite","link":"$link","data":"04\r"}""" to "bad-command",
            """{"v":1,"type":"obdWrite","link":"$link","data":"ATMA\r"}""" to "bad-command",
            """{"v":1,"type":"obdWrite","link":"$link","data":"ATZ"}""" to "bad-command",
            """{"v":1,"type":"obdWrite","link":"$link","data":"ATZ\rATMA\r"}""" to "bad-command",
            """{"v":1,"type":"obdWrite","link":"$link","data":["ATZ\r"]}""" to "bad-command",
            """{"v":1,"type":"obdWrite","link":"$link"}""" to "bad-command",
            """{"v":1,"type":"obdWrite","data":"ATZ\r"}""" to "bad-link",
            """{"v":1,"type":"obdScan"}""" to "bad-type",
            """{"v":1,"type":"obdConnectAddress","address":"AA:BB:CC:DD:EE:FF"}""" to "bad-type",
        )
        for ((json, reason) in bad) assertEquals(json, ParseResult.Rejected(reason), parse(json))
    }

    @Test
    fun fullFlowThroughBridgeAndOriginCheck() {
        val evil = Uri.parse("https://evil.example")
        bridge.handle("""{"v":1,"type":"obdPick","req":3,"kind":"ble","all":true}""", evil, true, null)
        bridge.handle("""{"v":1,"type":"obdPick","req":3,"kind":"ble","all":true}""", app, false, null)
        assertTrue(picks.isEmpty())
        bridge.handle("""{"v":1,"type":"obdPick","req":3,"kind":"ble","all":true}""", app, true, null)
        assertEquals(listOf(ObdKind.BLE to true), picks)
        pending!!(PickResult.Picked(ObdDevice(ObdKind.BLE, "AA:BB:CC:DD:EE:01", "OBDII")))
        val link = Regex("\"link\":\"([0-9a-f]{16})\"").find(out.last())!!.groupValues[1]
        bridge.handle("""{"v":1,"type":"obdConnect","link":"$link"}""", app, true, null)
        assertTrue(out.last().contains("\"state\":\"open\""))
        bridge.handle("""{"v":1,"type":"obdWrite","link":"$link","data":"ATZ\r"}""", app, true, null)
        bridge.handle("""{"v":1,"type":"obdWrite","link":"$link","data":"ATMA\r"}""", app, true, null)
        bridge.handle("""{"v":1,"type":"obdWrite","link":"$link","data":"ATI\r"}""", evil, true, null)
        assertEquals(listOf("ATZ\r"), writes)
        // Trang nạp lại: mã cũ hết hiệu lực.
        bridge.onPageStarted()
        bridge.handle("""{"v":1,"type":"obdConnect","link":"$link"}""", app, true, null)
        assertTrue(out.last().contains("\"reason\":\"unknown\""))
    }

    @Test
    fun writesAreRateLimited() {
        bridge.handle("""{"v":1,"type":"obdPick","req":1,"kind":"spp"}""", app, true, null)
        pending!!(PickResult.Picked(ObdDevice(ObdKind.SPP, "AA:BB:CC:DD:EE:01", null)))
        val link = Regex("\"link\":\"([0-9a-f]{16})\"").find(out.last())!!.groupValues[1]
        bridge.handle("""{"v":1,"type":"obdConnect","link":"$link"}""", app, true, null)
        repeat(30) { bridge.handle("""{"v":1,"type":"obdWrite","link":"$link","data":"010D\r"}""", app, true, null) }
        assertEquals(BridgeLimits.OBD_WRITE_RATE_PER_SEC.toInt(), writes.size)
        nanos += 1_000_000_000L
        repeat(30) { bridge.handle("""{"v":1,"type":"obdWrite","link":"$link","data":"010D\r"}""", app, true, null) }
        assertEquals(2 * BridgeLimits.OBD_WRITE_RATE_PER_SEC.toInt(), writes.size)
        // Mở hộp chọn dồn dập: tối đa 4/giây qua cầu nối, và mỗi lúc một hộp.
        picks.clear()
        nanos += 1_000_000_000L
        repeat(10) { bridge.handle("""{"v":1,"type":"obdPick","req":${it + 2},"kind":"ble"}""", app, true, null) }
        assertEquals(1, picks.size)
    }

    @Test
    fun obdMessagesAreDroppedWithoutController() {
        val plain = NativeBridge(host, null, nowMs = { now }, uptimeMs = { 1000L }, clockNanos = { nanos })
        plain.handle("""{"v":1,"type":"obdPick","req":1,"kind":"ble"}""", app, true, null)
        assertEquals(1, plain.droppedCount)
    }
}
