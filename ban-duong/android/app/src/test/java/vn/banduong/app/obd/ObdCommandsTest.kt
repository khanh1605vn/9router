package vn.banduong.app.obd

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ObdCommandsTest {
    @Test
    fun allowsOnlyReadOnlyCommands() {
        val good = listOf(
            "ATZ", "ATWS", "ATD", "ATI", "ATFE", "ATE0", "ATL0", "ATS0", "ATH0", "ATH1", "ATAT1", "ATAT2", "ATSP0",
            "ATDPN", "ATRV", "ATST32", "ATSTFF", "ATSPA1", "ATSPAC", "0100", "010D", "010C1", "0142", "03", "X",
        )
        for (c in good) assertTrue(c, ObdCommands.isAllowedCommand(c))
        val bad = listOf(
            "", "atz", "AT Z", " ATZ", "ATZ ", "ATMA", "ATPP0CSV00", "ATSP1", "ATSPA0", "ATSPAD", "ATST3", "ATSTGG",
            "04", "0902", "0100 ", "01001A", "010D2", "0D", "03 ", "XX", "x", "ATZ\n", "ATZ\r", "ATZ\u0000",
            "ＡＴＺ", "ATⅠ", "01٠٠",
        )
        for (c in bad) assertFalse(c, ObdCommands.isAllowedCommand(c))
    }

    @Test
    fun framesAreCommandPlusCrOrBareX() {
        assertTrue(ObdCommands.isAllowedFrame("ATZ\r"))
        assertTrue(ObdCommands.isAllowedFrame("010D\r"))
        assertTrue(ObdCommands.isAllowedFrame("X"))
        for (f in listOf("", "\r", "X\r", "ATZ", "ATZ\r\r", "ATZ\n", "010D\r\n", "ATZ\rATMA\r", "04\r", "${"0".repeat(20)}\r")) {
            assertFalse(f, ObdCommands.isAllowedFrame(f))
        }
    }

    @Test
    fun guardAllowsBareCrOnlyRightAfterX() {
        val g = ObdWriteGuard()
        assertFalse(g.allow("\r"))
        assertTrue(g.allow("X"))
        assertTrue(g.allow("\r"))
        assertFalse("chỉ một CR sau mỗi X", g.allow("\r"))
        assertTrue(g.allow("X"))
        assertFalse(g.allow("ATMA\r"))
        assertFalse("lệnh bị từ chối cũng xoá trạng thái sau X", g.allow("\r"))
        assertTrue(g.allow("X"))
        g.reset()
        assertFalse(g.allow("\r"))
    }

    @Test
    fun incomingKeepsPrintableAsciiCrLfOnly() {
        val bytes = byteArrayOf(0x34, 0x31, 0x20, 0x0D, 0x0A, 0x3E, 0x00, 0x07, 0x1B, 0x7F, 0x80.toByte(), 0xFF.toByte(), 0x41)
        assertEquals("41 \r\n>A", ObdCommands.cleanIncoming(bytes))
        assertEquals("41", ObdCommands.cleanIncoming(bytes, 2))
        assertEquals("", ObdCommands.cleanIncoming(ByteArray(0)))
        assertArrayEquals(byteArrayOf(0x41, 0x54, 0x5A, 0x0D), ObdCommands.toBytes("ATZ\r"))
    }
}
