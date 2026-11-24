package vn.banduong.app.obd

/** Loại bộ OBD: Bluetooth Low Energy (GATT) hoặc Bluetooth thường đã ghép đôi (SPP qua RFCOMM). */
enum class ObdKind(val key: String) {
    BLE("ble"),
    SPP("spp"),
    ;

    companion object {
        fun of(key: Any?): ObdKind? = entries.firstOrNull { it.key == key }
    }
}

/**
 * Thiết bị người dùng đã tự chọn trong hộp chọn của máy. Địa chỉ Bluetooth chỉ ở phía máy, không bao giờ gửi
 * sang trang web; trang chỉ biết mã link ngẫu nhiên và tên (đã làm sạch).
 */
data class ObdDevice(val kind: ObdKind, val address: String, val name: String?)

/** Lý do một kết nối đóng hoặc không mở được (gửi sang trang trong obdState.reason). */
enum class ObdCloseReason(val key: String) {
    /** Mất kết nối sau khi đã mở. */
    LOST("lost"),

    /** Không mở được (thiết bị không trả lời, từ chối, hết thời gian). */
    FAILED("failed"),

    /** BLE: không có service/đặc tính giống bộ OBD. */
    NO_CHANNEL("nochannel"),

    /** Thiếu quyền Bluetooth. */
    DENIED("denied"),

    /** Bluetooth đang tắt. */
    OFF("off"),

    /** Trang tự ngắt, hoặc kết nối bị thay bằng kết nối khác. */
    CLOSED("closed"),

    /** Mã link không còn hiệu lực (chưa chọn thiết bị, hoặc trang đã nạp lại). */
    UNKNOWN("unknown"),
}

/**
 * Một kết nối tới bộ đọc. Mọi hàm gọi trên luồng chính; mọi lời gọi [Listener] cũng trên luồng chính, và sau
 * [close] thì không còn lời gọi nào.
 */
interface ObdLink {
    interface Listener {
        fun onOpen()
        fun onData(bytes: ByteArray)
        fun onClosed(reason: ObdCloseReason)
    }

    fun open()

    /** Ghi byte (đã qua [ObdWriteGuard]). Trả false nếu không ghi được (hàng chờ đầy, chưa mở). */
    fun write(bytes: ByteArray): Boolean

    fun close()

    fun interface Factory {
        fun create(device: ObdDevice, listener: Listener): ObdLink
    }
}

/** Kết quả hộp chọn thiết bị (gửi sang trang trong obdPicked.error khi thất bại). */
sealed interface PickResult {
    data class Picked(val device: ObdDevice) : PickResult

    data class Failed(val error: PickError) : PickResult
}

enum class PickError(val key: String) {
    CANCELLED("cancelled"),
    DENIED("denied"),
    OFF("off"),
    UNSUPPORTED("unsupported"),
    NO_PAIRED("nopaired"),

    /** Hộp chọn khác đang mở, hoặc ứng dụng không ở trên màn hình. */
    BUSY("busy"),

    /** Không có lần chạm nào của người dùng ngay trước đó. */
    GESTURE("gesture"),
}

/** Hộp chọn thiết bị của máy (giao diện + quyền). Gọi trên luồng chính; [done] được gọi đúng một lần. */
interface ObdPicker {
    /** Người dùng vừa chạm vào màn hình (chống trang tự mở hộp chọn liên tục). */
    fun hasRecentUserGesture(): Boolean

    fun pick(kind: ObdKind, showAll: Boolean, done: (PickResult) -> Unit)

    /** Đóng hộp chọn đang mở (trang nạp lại); [done] của nó không được gọi nữa. */
    fun cancel()
}
