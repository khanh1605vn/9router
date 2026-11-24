package vn.banduong.app.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import vn.banduong.app.obd.ObdProfiles.CharInfo
import vn.banduong.app.obd.ObdProfiles.ServiceInfo
import vn.banduong.app.obd.ObdProfiles.uuid16
import java.util.UUID

class ObdProfilesTest {
    private fun ch(id: UUID, notify: Boolean = false, indicate: Boolean = false, write: Boolean = false, wnr: Boolean = false) =
        CharInfo(id, notify, indicate, write, wnr)

    @Test
    fun knownPairsWin() {
        val fff0 = ServiceInfo(uuid16(0xfff0), listOf(ch(uuid16(0xfff1), notify = true), ch(uuid16(0xfff2), wnr = true)))
        val c = ObdProfiles.chooseChannel(listOf(fff0))!!
        assertEquals("known", c.how)
        assertEquals(uuid16(0xfff1), c.rx.uuid)
        assertEquals(uuid16(0xfff2), c.tx.uuid)
    }

    @Test
    fun ffe0UsesFfe2ElseFfe1() {
        val both = ServiceInfo(uuid16(0xffe0), listOf(ch(uuid16(0xffe1), notify = true, write = true), ch(uuid16(0xffe2), write = true)))
        assertEquals(uuid16(0xffe2), ObdProfiles.chooseChannel(listOf(both))!!.tx.uuid)
        val one = ServiceInfo(uuid16(0xffe0), listOf(ch(uuid16(0xffe1), notify = true, wnr = true)))
        val c = ObdProfiles.chooseChannel(listOf(one))!!
        assertEquals(uuid16(0xffe1), c.rx.uuid)
        assertEquals(uuid16(0xffe1), c.tx.uuid)
    }

    @Test
    fun fallsBackToPropertiesInAllowedServicesOnly() {
        val other = ServiceInfo(uuid16(0x180d), listOf(ch(uuid16(0x2a37), notify = true), ch(uuid16(0x2a39), write = true)))
        assertNull("service lạ (nhịp tim) không bao giờ được dùng", ObdProfiles.chooseChannel(listOf(other)))
        val beef = ServiceInfo(uuid16(0xbeef), listOf(ch(uuid16(0x1), indicate = true), ch(uuid16(0x2)), ch(uuid16(0x3), write = true)))
        val c = ObdProfiles.chooseChannel(listOf(other, beef))!!
        assertEquals("properties", c.how)
        assertEquals(uuid16(0xbeef), c.service)
        assertEquals(uuid16(0x1), c.rx.uuid)
        assertEquals(uuid16(0x3), c.tx.uuid)
        // Cặp đã biết thiếu thuộc tính: rơi về dò theo thuộc tính, theo thứ tự SERVICES.
        val badKnown = ServiceInfo(uuid16(0xfff0), listOf(ch(uuid16(0xfff1)), ch(uuid16(0xfff2), write = true), ch(uuid16(0xfff3), notify = true)))
        val d = ObdProfiles.chooseChannel(listOf(beef, badKnown))!!
        assertEquals(uuid16(0xfff0), d.service)
        assertEquals("properties", d.how)
        assertNull(ObdProfiles.chooseChannel(emptyList()))
        assertNull(ObdProfiles.chooseChannel(listOf(ServiceInfo(uuid16(0xfff0), emptyList()))))
    }

    @Test
    fun filterLikeWebBluetooth() {
        assertTrue(ObdProfiles.looksLikeObd("OBDII", emptyList()))
        assertTrue(ObdProfiles.looksLikeObd("vLinker MC-Android", emptyList()))
        assertTrue(ObdProfiles.looksLikeObd("V-LINK", emptyList()))
        assertFalse("phân biệt chữ hoa như namePrefix", ObdProfiles.looksLikeObd("obdii", emptyList()))
        assertFalse(ObdProfiles.looksLikeObd("Galaxy Buds", emptyList()))
        assertFalse(ObdProfiles.looksLikeObd(null, listOf(uuid16(0x180d))))
        assertTrue(ObdProfiles.looksLikeObd(null, listOf(uuid16(0xfff0))))
        assertEquals(UUID.fromString("00001101-0000-1000-8000-00805f9b34fb"), ObdProfiles.SPP_UUID)
    }

    /** Danh sách tên và service phải đúng như js/obd.js. */
    @Test
    fun listsMatchObdJs() {
        val src = WebSource.read("js/obd.js")
        fun block(name: String) = Regex("""(?:export )?const $name = \[([\s\S]*?)\];""").find(src)!!.groupValues[1]
        val prefixes = Regex("""'([^']+)'""").findAll(block("BLE_NAME_PREFIXES")).map { it.groupValues[1] }.toList()
        assertEquals(prefixes, ObdProfiles.NAME_PREFIXES)
        fun uuids(b: String) = Regex("""0x([0-9a-fA-F]+)|'([0-9a-f-]{36})'""").findAll(b.replace(Regex("//.*"), "")).map {
            if (it.groupValues[1].isNotEmpty()) uuid16(it.groupValues[1].toInt(16)) else UUID.fromString(it.groupValues[2])
        }.toList()
        assertEquals(uuids(block("BLE_SERVICES")), ObdProfiles.SERVICES)
        assertEquals(uuids(block("FILTER_SERVICES")), ObdProfiles.FILTER_SERVICES)
        assertTrue(src.contains("export const SPP_UUID = '${ObdProfiles.SPP_UUID}'"))
    }
}
