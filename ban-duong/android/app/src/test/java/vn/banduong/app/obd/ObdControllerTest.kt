package vn.banduong.app.obd

import android.os.Looper
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
class ObdControllerTest {
    private var nanos = 0L
    private val sent = ArrayList<JSONObject>()

    private class FakePicker : ObdPicker {
        var gesture = true
        var pending: ((PickResult) -> Unit)? = null
        var lastKind: ObdKind? = null
        var lastAll: Boolean? = null
        var cancels = 0
        override fun hasRecentUserGesture() = gesture
        override fun pick(kind: ObdKind, showAll: Boolean, done: (PickResult) -> Unit) {
            lastKind = kind
            lastAll = showAll
            pending = done
        }
        override fun cancel() {
            cancels++
            pending = null
        }
        fun answer(r: PickResult) {
            val p = pending!!
            pending = null
            p(r)
        }
    }

    private class FakeLink(val device: ObdDevice, val listener: ObdLink.Listener) : ObdLink {
        var opened = 0
        var closed = false
        val writes = ArrayList<String>()
        var acceptWrites = true
        override fun open() {
            opened++
        }
        override fun write(bytes: ByteArray): Boolean {
            if (!acceptWrites) return false
            writes += String(bytes, Charsets.US_ASCII)
            return true
        }
        override fun close() {
            closed = true
        }
    }

    private val picker = FakePicker()
    private val links = ArrayList<FakeLink>()
    private lateinit var c: ObdController

    @Before
    fun setUp() {
        c = ObdController(picker, { d, l -> FakeLink(d, l).also { links += it } }, clockNanos = { nanos })
        c.sink = { sent += JSONObject(it) }
    }

    private fun idle(ms: Long = 0) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun last(type: String) = sent.last { it.getString("type") == type }

    private fun pickDevice(kind: ObdKind = ObdKind.BLE, name: String? = "OBDII", address: String = "AA:BB:CC:DD:EE:01"): String {
        c.pick(7, kind, false)
        picker.answer(PickResult.Picked(ObdDevice(kind, address, name)))
        return last("obdPicked").getString("link")
    }

    private fun openLink(kind: ObdKind = ObdKind.BLE): Pair<String, FakeLink> {
        val token = pickDevice(kind)
        c.connect(token)
        val link = links.last()
        link.listener.onOpen()
        return token to link
    }

    @Test
    fun pickIssuesRandomTokenAndNeverLeaksAddress() {
        c.pick(7, ObdKind.BLE, true)
        assertEquals(ObdKind.BLE, picker.lastKind)
        assertEquals(true, picker.lastAll)
        picker.answer(PickResult.Picked(ObdDevice(ObdKind.BLE, "AA:BB:CC:DD:EE:01", " vLinker‮ MC\u0007 ")))
        val m = last("obdPicked")
        assertEquals(7, m.getInt("req"))
        assertTrue(m.getBoolean("ok"))
        assertTrue(ObdController.TOKEN_RE.matches(m.getString("link")))
        assertEquals("ble", m.getString("kind"))
        assertEquals("vLinker MC", m.getString("name"))
        assertFalse("địa chỉ Bluetooth không sang trang", m.toString().contains("AA:BB"))
        // Hai lần chọn: hai mã khác nhau.
        val other = pickDevice()
        assertTrue(other != m.getString("link"))
        // SPP không có "hiện mọi thiết bị" từ trang (hộp chọn tự có nút).
        c.pick(8, ObdKind.SPP, true)
        assertEquals(false, picker.lastAll)
    }

    @Test
    fun pickNeedsGestureAndOnlyOneAtATime() {
        picker.gesture = false
        c.pick(1, ObdKind.BLE, false)
        assertEquals("gesture", last("obdPicked").getString("error"))
        assertNull(picker.pending)
        picker.gesture = true
        c.pick(2, ObdKind.BLE, false)
        c.pick(3, ObdKind.BLE, false)
        val busy = last("obdPicked")
        assertEquals(3, busy.getInt("req"))
        assertEquals("busy", busy.getString("error"))
        picker.answer(PickResult.Failed(PickError.CANCELLED))
        val m = last("obdPicked")
        assertEquals(2, m.getInt("req"))
        assertFalse(m.getBoolean("ok"))
        assertEquals("cancelled", m.getString("error"))
    }

    @Test
    fun connectOnlyKnownTokensOneLinkAtATime() {
        c.connect("0123456789abcdef")
        assertEquals("unknown", last("obdState").getString("reason"))
        assertTrue(links.isEmpty())
        val a = pickDevice(address = "AA:BB:CC:DD:EE:01")
        val b = pickDevice(address = "AA:BB:CC:DD:EE:02")
        c.connect(a)
        assertEquals(1, links.size)
        assertEquals(1, links[0].opened)
        assertEquals("AA:BB:CC:DD:EE:01", links[0].device.address)
        c.connect(a) // đang mở: không mở thêm
        assertEquals(1, links.size)
        links[0].listener.onOpen()
        assertEquals("open", last("obdState").getString("state"))
        c.connect(b)
        assertTrue(links[0].closed)
        val closed = sent.last { it.getString("type") == "obdState" && it.getString("link") == a }
        assertEquals("closed", closed.getString("state"))
        assertEquals("closed", closed.getString("reason"))
        assertEquals(2, links.size)
        // Kết nối cũ báo muộn: bị bỏ qua.
        val before = sent.size
        links[0].listener.onOpen()
        links[0].listener.onData("41 0D 3C\r>".toByteArray())
        links[0].listener.onClosed(ObdCloseReason.LOST)
        idle(100)
        assertEquals(before, sent.size)
    }

    @Test
    fun writesPassAllowListOnly() {
        val (token, link) = openLink()
        assertTrue(c.write(token, "ATZ\r"))
        assertTrue(c.write(token, "010D\r"))
        assertTrue(c.write(token, "X"))
        assertTrue(c.write(token, "\r"))
        for (bad in listOf("\r", "04\r", "ATMA\r", "ATPP0CSV00\r", "ATZ", "atz\r", "ATZ\rATMA\r", "0902\r")) {
            assertFalse(bad, c.write(token, bad))
        }
        assertFalse("mã link khác", c.write("fedcba9876543210", "ATZ\r"))
        assertEquals(listOf("ATZ\r", "010D\r", "X", "\r"), link.writes)
        c.disconnect(token)
        assertTrue(link.closed)
        assertFalse(c.write(token, "ATZ\r"))
    }

    @Test
    fun noWritesBeforeOpen() {
        val token = pickDevice()
        c.connect(token)
        assertFalse(c.write(token, "ATZ\r"))
        assertTrue(links.last().writes.isEmpty())
    }

    @Test
    fun dataIsCleanedAndCoalescedUntilPrompt() {
        val (token, link) = openLink()
        link.listener.onData(byteArrayOf(0x34, 0x31, 0x20, 0x00, 0x1B, 0x30))
        link.listener.onData("D 3C\r".toByteArray())
        idle(10)
        assertTrue(sent.none { it.getString("type") == "obdData" })
        link.listener.onData("\r>".toByteArray())
        idle(0)
        val d = sent.filter { it.getString("type") == "obdData" }
        assertEquals(1, d.size)
        assertEquals(token, d[0].getString("link"))
        assertEquals("41 0D 3C\r\r>", d[0].getString("data"))
        // Không có dấu nhắc: vẫn gửi sau COALESCE_MS.
        link.listener.onData("SEARCHING...".toByteArray())
        idle(ObdController.COALESCE_MS)
        assertEquals("SEARCHING...", last("obdData").getString("data"))
    }

    @Test
    fun floodsAreBoundedInSizeAndRate() {
        val (_, link) = openLink()
        val junk = ByteArray(3000) { 'A'.code.toByte() }
        repeat(20) { link.listener.onData(junk) } // 60 000 ký tự, không có dấu nhắc
        idle(ObdController.COALESCE_MS)
        val d = sent.filter { it.getString("type") == "obdData" }
        val total = d.sumOf { it.getString("data").length }
        assertTrue("phần chờ bị giới hạn", total <= ObdController.MAX_PENDING_CHARS)
        assertTrue(d.all { it.getString("data").length <= ObdController.MAX_DATA_CHARS })
        // Một giây lưu lượng tối đa, rồi phải chờ.
        sent.clear()
        repeat(100) { link.listener.onData("41 0D 3C\r\r>".toByteArray()); idle(0) }
        repeat(20) { link.listener.onData(junk); idle(0) }
        val sentChars = sent.filter { it.getString("type") == "obdData" }.sumOf { it.getString("data").length }
        assertTrue("không quá MAX_DATA_CHARS_PER_SEC khi đồng hồ không chạy: $sentChars", sentChars <= ObdController.MAX_DATA_CHARS_PER_SEC + 1)
        val count = sent.count { it.getString("type") == "obdData" }
        assertTrue("không quá MAX_DATA_MESSAGES_PER_SEC: $count", count <= ObdController.MAX_DATA_MESSAGES_PER_SEC)
        nanos += 1_000_000_000L
        idle(ObdController.THROTTLE_RETRY_MS)
        assertTrue(sent.count { it.getString("type") == "obdData" } > count)
    }

    @Test
    fun lostLinkIsReported() {
        val (token, link) = openLink()
        link.listener.onData("41 0D".toByteArray())
        link.listener.onClosed(ObdCloseReason.LOST)
        assertEquals("41 0D", last("obdData").getString("data"))
        val s = last("obdState")
        assertEquals(token, s.getString("link"))
        assertEquals("closed", s.getString("state"))
        assertEquals("lost", s.getString("reason"))
        assertNull(c.activeToken)
        // Kết nối lại cùng mã (ObdClient tự làm): không cần chọn lại.
        c.connect(token)
        assertEquals(2, links.size)
    }

    @Test
    fun resetForgetsEverything() {
        val (token, link) = openLink()
        c.pick(9, ObdKind.SPP, false)
        val stale = picker.pending!!
        c.reset()
        assertTrue(link.closed)
        assertEquals(1, picker.cancels)
        assertTrue(c.knownLinks.isEmpty())
        val before = sent.size
        stale(PickResult.Picked(ObdDevice(ObdKind.SPP, "AA:BB:CC:DD:EE:09", "OBDII")))
        assertEquals("kết quả của trang cũ bị bỏ", before, sent.size)
        c.connect(token)
        assertEquals("unknown", last("obdState").getString("reason"))
        // Sau khi nạp lại, chọn được ngay (không bị kẹt "busy").
        c.pick(10, ObdKind.BLE, false)
        assertTrue(picker.pending != null)
    }

    @Test
    fun remembersFewDevicesButKeepsActive() {
        val first = pickDevice(address = "AA:BB:CC:DD:EE:00")
        c.connect(first)
        repeat(ObdController.MAX_DEVICES + 2) { pickDevice(address = "AA:BB:CC:DD:EE:1$it") }
        assertTrue(first in c.knownLinks)
        assertEquals(ObdController.MAX_DEVICES, c.knownLinks.size)
    }

    @Test
    fun cleanName() {
        assertEquals("OBD II", ObdController.cleanName("  OBD\t​ II \u0000"))
        assertNull(ObdController.cleanName("‮\u0007"))
        assertNull(ObdController.cleanName(null))
        assertNull(ObdController.cleanName("x".repeat(161)))
        assertEquals("😀".repeat(40), ObdController.cleanName("😀".repeat(41)))
        assertEquals("Bộ đọc Việt", ObdController.cleanName("Bộ đọc Việt"))
    }
}
