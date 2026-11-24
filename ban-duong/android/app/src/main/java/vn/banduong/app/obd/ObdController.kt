package vn.banduong.app.obd

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.MainThread
import androidx.annotation.VisibleForTesting
import org.json.JSONObject
import vn.banduong.app.bridge.BridgeLimits
import vn.banduong.app.bridge.RateLimiter
import java.security.SecureRandom
import java.util.Locale

/**
 * Phía máy của bộ OBD trong ứng dụng (trang web: js/obdnative.js). Trang chỉ làm được bốn việc, đều đã qua
 * BridgeMessageParser và giới hạn nhịp của NativeBridge:
 *  - obdPick: mở hộp chọn thiết bị của máy (chỉ ngay sau một lần chạm, mỗi lúc một hộp); người dùng tự chọn,
 *    máy cấp một mã link ngẫu nhiên. Không có cách nào nối thẳng tới một địa chỉ, hay tới thiết bị chưa được chọn.
 *  - obdConnect / obdDisconnect: mở/đóng kết nối tới thiết bị của một mã link (mỗi lúc một kết nối).
 *  - obdWrite: ghi một lệnh, chỉ khi lệnh qua [ObdWriteGuard] (danh sách lệnh được phép của elm327.js).
 * Dữ liệu bộ đọc gửi về được lọc còn ASCII in được, gom lại (tới dấu nhắc '>' hoặc 40 ms) rồi gửi sang trang,
 * có giới hạn độ dài và nhịp. Nạp lại trang ([reset]) thì đóng kết nối và bỏ mọi mã link.
 */
class ObdController(
    private val picker: ObdPicker,
    private val links: ObdLink.Factory,
    private val random: SecureRandom = SecureRandom(),
    private val handler: Handler = Handler(Looper.getMainLooper()),
    clockNanos: () -> Long = System::nanoTime,
) {
    /** Gửi chuỗi JSON sang trang (NativeBridge gắn vào). */
    var sink: ((String) -> Unit)? = null

    private val devices = LinkedHashMap<String, ObdDevice>()
    private var active: Active? = null
    private var picking = false
    private var generation = 0

    private val messageLimiter = RateLimiter(MAX_DATA_MESSAGES_PER_SEC, clockNanos = clockNanos)
    private val charLimiter = RateLimiter(MAX_DATA_CHARS_PER_SEC, clockNanos = clockNanos)

    private inner class Active(val token: String, val device: ObdDevice) : ObdLink.Listener {
        lateinit var link: ObdLink
        var open = false
        val guard = ObdWriteGuard()
        val pending = StringBuilder()
        var flushScheduled = false
        val flushTask = Runnable {
            flushScheduled = false
            flush(this)
        }

        override fun onOpen() {
            if (active !== this || open) return
            open = true
            send(stateMessage(token, "open", null))
        }

        override fun onData(bytes: ByteArray) {
            if (active !== this || !open) return
            val text = ObdCommands.cleanIncoming(bytes)
            if (text.isEmpty()) return
            pending.append(text)
            if (pending.length > MAX_PENDING_CHARS) pending.delete(0, pending.length - MAX_PENDING_CHARS)
            schedule(this, if (text.indexOf('>') >= 0) 0L else COALESCE_MS)
        }

        override fun onClosed(reason: ObdCloseReason) {
            if (active !== this) return
            flush(this)
            handler.removeCallbacks(flushTask)
            active = null
            send(stateMessage(token, "closed", reason))
        }
    }

    @VisibleForTesting
    internal val activeToken: String? get() = active?.token

    @VisibleForTesting
    internal val isOpen: Boolean get() = active?.open == true

    @VisibleForTesting
    internal val knownLinks: Set<String> get() = devices.keys.toSet()

    @MainThread
    fun pick(req: Int, kind: ObdKind, showAll: Boolean) {
        if (picking) return send(pickFailed(req, PickError.BUSY))
        if (!picker.hasRecentUserGesture()) return send(pickFailed(req, PickError.GESTURE))
        picking = true
        val gen = generation
        picker.pick(kind, showAll && kind == ObdKind.BLE) { result ->
            if (gen != generation) return@pick
            picking = false
            when (result) {
                is PickResult.Failed -> send(pickFailed(req, result.error))
                is PickResult.Picked -> {
                    val device = result.device.copy(name = cleanName(result.device.name))
                    val token = newToken()
                    devices[token] = device
                    trimDevices()
                    send(
                        JSONObject().put("v", V).put("type", "obdPicked").put("req", req).put("ok", true)
                            .put("link", token).put("kind", device.kind.key).put("name", device.name ?: JSONObject.NULL)
                            .toString(),
                    )
                }
            }
        }
    }

    @MainThread
    fun connect(token: String) {
        val device = devices[token] ?: return send(stateMessage(token, "closed", ObdCloseReason.UNKNOWN))
        active?.let { a ->
            if (a.token == token) {
                // Đang mở hoặc đã mở: không mở lần nữa (trang gửi lại sau khi nạp lại cầu nối…).
                if (a.open) send(stateMessage(token, "open", null))
                return
            }
            closeActive(ObdCloseReason.CLOSED)
        }
        val a = Active(token, device)
        active = a
        a.link = links.create(device, a)
        if (active === a) a.link.open()
    }

    /** @return true nếu lệnh được ghi xuống bộ đọc */
    @MainThread
    fun write(token: String, data: String): Boolean {
        val a = active
        if (a == null || a.token != token || !a.open) return drop("obd-not-open")
        if (!a.guard.allow(data)) return drop("obd-not-allowed")
        if (!a.link.write(ObdCommands.toBytes(data))) return drop("obd-write-failed")
        return true
    }

    @MainThread
    fun disconnect(token: String) {
        if (active?.token == token) closeActive(ObdCloseReason.CLOSED)
    }

    /** Trang nạp lại hoặc màn hình bị huỷ: đóng hộp chọn và kết nối, mọi mã link mất hiệu lực. */
    @MainThread
    fun reset() {
        generation++
        if (picking) picker.cancel()
        picking = false
        closeActive(null)
        devices.clear()
    }

    private fun closeActive(notify: ObdCloseReason?) {
        val a = active ?: return
        active = null
        handler.removeCallbacks(a.flushTask)
        try {
            a.link.close()
        } catch (e: RuntimeException) {
            Log.w(TAG, "Lỗi khi đóng kết nối OBD", e)
        }
        if (notify != null) send(stateMessage(a.token, "closed", notify))
    }

    private fun schedule(a: Active, delayMs: Long) {
        if (a.flushScheduled && delayMs > 0) return
        handler.removeCallbacks(a.flushTask)
        a.flushScheduled = true
        if (delayMs <= 0) handler.post(a.flushTask) else handler.postDelayed(a.flushTask, delayMs)
    }

    private fun flush(a: Active) {
        while (a.pending.isNotEmpty() && active === a) {
            val n = minOf(a.pending.length, MAX_DATA_CHARS)
            if (!messageLimiter.tryAcquire() || !charLimiter.tryAcquire(n.toDouble())) {
                // Thiết bị gửi quá nhiều: để lại, thử sau (phần cũ nhất bị bỏ khi vượt MAX_PENDING_CHARS).
                schedule(a, THROTTLE_RETRY_MS)
                return
            }
            val chunk = a.pending.substring(0, n)
            a.pending.delete(0, n)
            send(JSONObject().put("v", V).put("type", "obdData").put("link", a.token).put("data", chunk).toString())
        }
    }

    private fun trimDevices() {
        val it = devices.keys.iterator()
        while (devices.size > MAX_DEVICES && it.hasNext()) {
            val k = it.next()
            if (k == active?.token) continue
            it.remove()
        }
    }

    private fun newToken(): String {
        val b = ByteArray(8)
        random.nextBytes(b)
        return b.joinToString("") { String.format(Locale.ROOT, "%02x", it.toInt() and 0xFF) }
    }

    private fun send(json: String) {
        try {
            sink?.invoke(json)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Không gửi được thông điệp OBD sang trang", e)
        }
    }

    private var drops = 0

    private fun drop(reason: String): Boolean {
        drops++
        if (drops <= 5 || drops % 100 == 0) Log.w(TAG, "Bỏ lệnh OBD từ trang: $reason (#$drops)")
        return false
    }

    companion object {
        private const val TAG = "BanDuongObd"
        private const val V = BridgeLimits.PROTOCOL_VERSION

        val TOKEN_RE = Regex("^[0-9a-f]{16}$")

        /** Số thiết bị đã chọn được nhớ trong một lần nạp trang. */
        const val MAX_DEVICES = 4

        const val MAX_NAME_CHARS = 40

        /** Một thông điệp obdData tối đa (trang nhận tối đa 8192). */
        const val MAX_DATA_CHARS = 4096

        /** Phần chưa gửi tối đa; thiết bị gửi rác liên tục thì phần cũ nhất bị bỏ. */
        const val MAX_PENDING_CHARS = 8192

        const val COALESCE_MS = 40L
        const val THROTTLE_RETRY_MS = 50L

        /** ELM327 ở 38 400 baud chỉ gửi được khoảng 3,8 KB/s; để dư nhiều. */
        const val MAX_DATA_CHARS_PER_SEC = 16_384.0
        const val MAX_DATA_MESSAGES_PER_SEC = 50.0

        private fun pickFailed(req: Int, error: PickError) =
            JSONObject().put("v", V).put("type", "obdPicked").put("req", req).put("ok", false).put("error", error.key).toString()

        private fun stateMessage(token: String, state: String, reason: ObdCloseReason?): String {
            val o = JSONObject().put("v", V).put("type", "obdState").put("link", token).put("state", state)
            if (reason != null) o.put("reason", reason.key)
            return o.toString()
        }

        /** Tên do thiết bị tự quảng bá: bỏ ký tự điều khiển và đổi hướng chữ, gộp khoảng trắng, tối đa 40 ký tự. */
        fun cleanName(raw: String?): String? {
            if (raw == null || raw.length > MAX_NAME_CHARS * 4) return null
            val sb = StringBuilder()
            var space = true
            for (ch in raw) {
                val c = ch.code
                if (c < 0x20 || c in 0x7F..0x9F || c in 0x200B..0x200F || c in 0x202A..0x202E || c in 0x2066..0x2069 || c == 0xFEFF) continue
                if (Character.isWhitespace(ch)) {
                    if (!space) sb.append(' ')
                    space = true
                    continue
                }
                sb.append(ch)
                space = false
            }
            var s = sb.toString().trim()
            if (s.codePointCount(0, s.length) > MAX_NAME_CHARS) s = s.substring(0, s.offsetByCodePoints(0, MAX_NAME_CHARS)).trimEnd()
            return s.ifEmpty { null }
        }
    }
}
