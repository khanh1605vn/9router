package vn.banduong.app.obd

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import androidx.core.content.ContextCompat

/** Quyền Android cần cho từng việc với bộ OBD. Tên quyền mới chỉ dùng khi sdk ≥ 31 (InlinedApi là chuỗi hằng, vô hại). */
@SuppressLint("InlinedApi")
object ObdPermissions {
    /**
     * Mở hộp chọn: Android 12+ cần "Thiết bị ở gần" (BLUETOOTH_SCAN khai báo neverForLocation, BLUETOOTH_CONNECT để
     * đọc tên và danh sách đã ghép đôi); Android 11 trở xuống, tìm BLE cần quyền vị trí chính xác.
     */
    fun forPick(kind: ObdKind, sdk: Int = Build.VERSION.SDK_INT): List<String> = when {
        sdk >= 31 && kind == ObdKind.BLE -> listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        sdk >= 31 -> listOf(Manifest.permission.BLUETOOTH_CONNECT)
        kind == ObdKind.BLE -> listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        else -> emptyList() // BLUETOOTH (quyền thường, cấp lúc cài) là đủ
    }

    /** Kết nối (cả lần kết nối lại tự động): Android 12+ cần BLUETOOTH_CONNECT. */
    fun forConnect(sdk: Int = Build.VERSION.SDK_INT): List<String> =
        if (sdk >= 31) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()

    fun missing(context: Context, perms: List<String>): List<String> =
        perms.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }

    fun canScan(context: Context, sdk: Int = Build.VERSION.SDK_INT): Boolean =
        sdk < 31 || missing(context, listOf(Manifest.permission.BLUETOOTH_SCAN)).isEmpty()
}

/** Tạo kết nối thật (BLE hoặc SPP) cho [ObdController]. Thiếu Bluetooth, thiếu quyền… thì kết nối báo đóng ngay. */
class AndroidObdLinks(private val context: Context, private val main: Handler) : ObdLink.Factory {
    override fun create(device: ObdDevice, listener: ObdLink.Listener): ObdLink {
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            ?: return FailedLink(listener, main, ObdCloseReason.FAILED)
        if (ObdPermissions.missing(context, ObdPermissions.forConnect()).isNotEmpty()) {
            return FailedLink(listener, main, ObdCloseReason.DENIED)
        }
        val enabled = try {
            adapter.isEnabled
        } catch (_: SecurityException) {
            false
        }
        if (!enabled) return FailedLink(listener, main, ObdCloseReason.OFF)
        val remote = try {
            adapter.getRemoteDevice(device.address)
        } catch (_: IllegalArgumentException) {
            return FailedLink(listener, main, ObdCloseReason.FAILED)
        }
        return when (device.kind) {
            ObdKind.BLE -> BleObdLink(context, remote, listener, main)
            ObdKind.SPP -> SppObdLink(adapter, remote, listener, main) { ObdPermissions.canScan(context) }
        }
    }
}

/** Kết nối không mở được: báo [reason] (trên luồng chính, sau open()). */
internal class FailedLink(
    private val listener: ObdLink.Listener,
    private val main: Handler,
    private val reason: ObdCloseReason,
) : ObdLink {
    private var closed = false

    override fun open() {
        main.post {
            if (!closed) {
                closed = true
                listener.onClosed(reason)
            }
        }
    }

    override fun write(bytes: ByteArray) = false

    override fun close() {
        closed = true
    }
}
