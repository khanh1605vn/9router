package vn.banduong.app.obd

/**
 * Danh sách lệnh được phép gửi xuống bộ đọc OBD, chép đúng từ `ALLOWED` trong js/elm327.js: chỉ đọc (AT cấu hình,
 * Mode 01 dữ liệu hiện tại, Mode 03 mã lỗi đã lưu) và ký tự ngắt 'X'. Không có Mode 04 (xoá mã lỗi), ATMA, ATPP
 * hay lệnh tự nhập. Trang web có bị chiếm quyền cũng không gửi được lệnh nào khác xuống xe.
 *
 * Hai bản phải luôn giống nhau: ObdCommandsParityTest (Kotlin) đọc js/elm327.js để so mẫu và chạy thử bằng Node,
 * tests/obdnative.test.mjs (JS) đọc tệp này để so lại.
 */
object ObdCommands {
    val ALLOWED_PATTERNS = listOf(
        "^AT(?:Z|WS|D|I|FE|E0|L0|S0|H0|H1|AT1|AT2|SP0|DPN|RV)$",
        "^ATST[0-9A-F]{2}$",
        "^ATSPA[1-9A-C]$",
        "^01[0-9A-F]{2}1?$",
        "^03$",
        "^X$",
    )

    /** Một lần ghi dài nhất được nhận (lệnh dài nhất được phép chỉ vài ký tự). Trùng NATIVE_OBD_LIMITS.maxFrame. */
    const val MAX_FRAME_CHARS = 16

    private val ALLOWED = ALLOWED_PATTERNS.map { Regex(it) }

    /** Giống isAllowedCommand của elm327.js: phân biệt chữ hoa, không khoảng trắng, khớp trọn chuỗi. */
    fun isAllowedCommand(cmd: String): Boolean =
        cmd.length < MAX_FRAME_CHARS && cmd.all { it in 'A'..'Z' || it in '0'..'9' } && ALLOWED.any { it.matches(cmd) }

    /** Chuỗi có đúng là frameCommand(lệnh được phép) không: lệnh + CR, riêng 'X' đứng một mình. */
    fun isAllowedFrame(data: String): Boolean {
        if (data.isEmpty() || data.length > MAX_FRAME_CHARS) return false
        if (data == "X") return true
        if (!data.endsWith('\r')) return false
        val cmd = data.substring(0, data.length - 1)
        return cmd != "X" && isAllowedCommand(cmd)
    }

    /** Byte ghi xuống bộ đọc. Chỉ gọi với chuỗi đã qua kiểm tra (toàn ASCII). */
    fun toBytes(frame: String): ByteArray = ByteArray(frame.length) { frame[it].code.toByte() }

    /**
     * Dữ liệu bộ đọc gửi về, thành chuỗi cho trang: chỉ giữ ASCII in được (0x20–0x7E), CR và LF. Thiết bị lạ gửi
     * gì khác đều bị bỏ, nên trang không bao giờ nhận được ký tự điều khiển.
     */
    fun cleanIncoming(bytes: ByteArray, length: Int = bytes.size): String {
        val sb = StringBuilder(length)
        for (i in 0 until minOf(length, bytes.size)) {
            val b = bytes[i].toInt() and 0xFF
            if (b == 0x0A || b == 0x0D || b in 0x20..0x7E) sb.append(b.toChar())
        }
        return sb.toString()
    }
}

/**
 * Kiểm tra từng lần ghi của một kết nối, như ObdClient.#write trong obd.js: khung lệnh được phép, 'X', và chỉ thêm
 * đúng một trường hợp: CR đứng riêng ngay sau 'X' (kết thúc chuỗi ngắt; với ELM327 CR trống là "chạy lại lệnh vừa
 * rồi", ở đây lệnh vừa rồi là 'X' vô hại). Mỗi kết nối một bộ.
 */
class ObdWriteGuard {
    private var afterX = false

    fun allow(data: String): Boolean {
        val ok = ObdCommands.isAllowedFrame(data) || (data == "\r" && afterX)
        afterX = data == "X"
        return ok
    }

    fun reset() {
        afterX = false
    }
}
