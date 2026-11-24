package vn.banduong.app.obd

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.os.Handler
import android.util.Log
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/**
 * Kết nối Bluetooth thường (SPP, RFCOMM 00001101-…) tới bộ OBD đã ghép đôi, như createSerialTransport của obd.js
 * (bản web dùng Web Serial). Mở và đọc trên một luồng riêng, ghi trên một luồng khác; mọi lời gọi [listener] được
 * chuyển về luồng chính.
 *
 * Chỉ thiết bị đã ghép đôi (người dùng tự ghép trong cài đặt Bluetooth, rồi tự chọn trong hộp chọn) mới tới được
 * đây. Quyền BLUETOOTH_CONNECT (Android 12+) đã được hộp chọn xin trước.
 */
@SuppressLint("MissingPermission")
class SppObdLink(
    private val adapter: BluetoothAdapter,
    private val device: BluetoothDevice,
    private val listener: ObdLink.Listener,
    private val main: Handler,
    private val canCancelDiscovery: () -> Boolean,
) : ObdLink {
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var closed = false
    private var opened = false
    private var writer: ExecutorService? = null
    private val queued = AtomicInteger(0)

    override fun open() {
        val t = Thread({ run() }, "BanDuongObdSpp")
        t.isDaemon = true
        t.start()
    }

    private fun run() {
        val s = try {
            connectSocket()
        } catch (_: SecurityException) {
            return post { finish(ObdCloseReason.DENIED) }
        } catch (e: IOException) {
            Log.w(TAG, "Không nối được RFCOMM: ${e.javaClass.simpleName}")
            return post { finish(ObdCloseReason.FAILED) }
        }
        // Công bố socket trước rồi mới xét lại [closed]: close() chạy ở bất kỳ lúc nào cũng thấy và đóng được socket này
        // (hoặc ta tự đóng ở đây), nên không bao giờ sót một kết nối RFCOMM mở (bộ ELM327 rẻ chỉ nhận một kết nối).
        socket = s
        if (closed) {
            closeQuietly(s)
            socket = null
            return
        }
        post {
            opened = true
            writer = Executors.newSingleThreadExecutor { r -> Thread(r, "BanDuongObdSppWrite").apply { isDaemon = true } }
            listener.onOpen()
        }
        val buf = ByteArray(READ_BUFFER)
        try {
            val input = s.inputStream
            while (!closed) {
                val n = input.read(buf)
                if (n < 0) break
                if (n == 0) continue
                val copy = buf.copyOf(n)
                post { if (opened) listener.onData(copy) }
            }
        } catch (_: IOException) {
            // Cổng bị ngắt: báo ở dưới.
        }
        if (closed) closeQuietly(s) // phòng xa: close() đã đóng rồi thì đóng lại cũng vô hại
        post { finish(ObdCloseReason.LOST) }
    }

    /** Thử kết nối bảo mật trước, rồi kết nối không bảo mật (nhiều bộ ELM327 rẻ chỉ nhận kiểu này). */
    private fun connectSocket(): BluetoothSocket {
        if (canCancelDiscovery()) {
            try {
                adapter.cancelDiscovery() // đang dò thiết bị thì RFCOMM rất chậm
            } catch (_: SecurityException) {
                // bỏ qua
            }
        }
        val first = device.createRfcommSocketToServiceRecord(ObdProfiles.SPP_UUID)
        socket = first
        try {
            first.connect()
            return first
        } catch (e: IOException) {
            closeQuietly(first)
            if (closed) throw e
        }
        val second = device.createInsecureRfcommSocketToServiceRecord(ObdProfiles.SPP_UUID)
        socket = second
        try {
            second.connect()
            return second
        } catch (e: IOException) {
            closeQuietly(second)
            throw e
        }
    }

    override fun write(bytes: ByteArray): Boolean {
        val s = socket ?: return false
        val w = writer ?: return false
        if (!opened || closed || queued.get() >= MAX_QUEUE) return false
        queued.incrementAndGet()
        return try {
            w.execute {
                try {
                    if (!closed) {
                        s.outputStream.write(bytes)
                        s.outputStream.flush()
                    }
                } catch (_: IOException) {
                    post { finish(ObdCloseReason.LOST) }
                } finally {
                    queued.decrementAndGet()
                }
            }
            true
        } catch (_: RejectedExecutionException) {
            queued.decrementAndGet()
            false
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        writer?.shutdownNow()
        writer = null
        socket?.let(::closeQuietly) // làm read()/connect() đang chờ ném lỗi, luồng đọc tự thoát
        socket = null
    }

    private fun finish(reason: ObdCloseReason) {
        if (closed) return
        close()
        listener.onClosed(if (opened && reason == ObdCloseReason.FAILED) ObdCloseReason.LOST else reason)
    }

    private fun post(fn: () -> Unit) {
        main.post { if (!closed) fn() }
    }

    private fun closeQuietly(s: BluetoothSocket) {
        try {
            s.close()
        } catch (_: IOException) {
            // bỏ qua
        }
    }

    companion object {
        private const val TAG = "BanDuongObd"
        const val READ_BUFFER = 1024
        const val MAX_QUEUE = 16
    }
}
