package vn.banduong.app.obd

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.util.Log

/**
 * Kết nối GATT tới bộ OBD Bluetooth Low Energy, giống createBleTransport của obd.js: chọn cặp đặc tính bằng
 * [ObdProfiles.chooseChannel], bật notify/indicate trên đặc tính nhận, ghi từng gói 20 byte (ATT MTU mặc định),
 * có phản hồi nếu đặc tính hỗ trợ, không thì không phản hồi. Mọi thao tác GATT trên luồng chính, lần lượt từng cái.
 *
 * Quyền BLUETOOTH_CONNECT (Android 12+) đã được hộp chọn xin trước; thiếu quyền thì SecurityException → DENIED.
 */
@SuppressLint("MissingPermission")
class BleObdLink(
    private val context: Context,
    private val device: BluetoothDevice,
    private val listener: ObdLink.Listener,
    private val main: Handler,
) : ObdLink {
    private var gatt: BluetoothGatt? = null
    private var rx: BluetoothGattCharacteristic? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var withResponse = false
    private var opened = false
    private var closed = false
    private var writing = false
    private val queue = ArrayDeque<ByteArray>()
    private val timeout = Runnable { finish(ObdCloseReason.FAILED) }

    override fun open() {
        main.postDelayed(timeout, CONNECT_TIMEOUT_MS)
        try {
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
            if (gatt == null) post { finish(ObdCloseReason.FAILED) }
        } catch (_: SecurityException) {
            post { finish(ObdCloseReason.DENIED) }
        }
    }

    override fun write(bytes: ByteArray): Boolean {
        if (!opened || closed || tx == null) return false
        var i = 0
        val chunks = ArrayList<ByteArray>()
        while (i < bytes.size) {
            chunks += bytes.copyOfRange(i, minOf(bytes.size, i + CHUNK))
            i += CHUNK
        }
        if (queue.size + chunks.size > MAX_QUEUE) return false
        queue.addAll(chunks)
        pump()
        return true
    }

    override fun close() {
        if (closed) return
        closed = true
        main.removeCallbacks(timeout)
        queue.clear()
        val g = gatt
        gatt = null
        try {
            g?.disconnect()
            g?.close()
        } catch (e: SecurityException) {
            Log.w(TAG, "Không đóng được GATT", e)
        }
    }

    private fun finish(reason: ObdCloseReason) {
        if (closed) return
        close()
        listener.onClosed(if (opened && reason == ObdCloseReason.FAILED) ObdCloseReason.LOST else reason)
    }

    private fun post(fn: () -> Unit) {
        main.post { if (!closed) fn() }
    }

    @Suppress("DEPRECATION")
    private fun pump() {
        if (writing || closed) return
        val g = gatt ?: return
        val c = tx ?: return
        val chunk = queue.removeFirstOrNull() ?: return
        val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        val ok = try {
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(c, chunk, type) == BluetoothStatusCodes.SUCCESS
            } else {
                c.writeType = type
                c.value = chunk
                g.writeCharacteristic(c)
            }
        } catch (_: SecurityException) {
            false
        }
        if (!ok) return finish(ObdCloseReason.LOST)
        writing = true
    }

    private fun onServices(g: BluetoothGatt) {
        val infos = g.services.map { s ->
            ObdProfiles.ServiceInfo(
                s.uuid,
                s.characteristics.map { c ->
                    val p = c.properties
                    ObdProfiles.CharInfo(
                        uuid = c.uuid,
                        notify = p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0,
                        indicate = p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0,
                        write = p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0,
                        writeNoResponse = p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0,
                    )
                },
            )
        }
        val ch = ObdProfiles.chooseChannel(infos) ?: return finish(ObdCloseReason.NO_CHANNEL)
        val service = g.getService(ch.service) ?: return finish(ObdCloseReason.NO_CHANNEL)
        val r = service.characteristics.firstOrNull { it.uuid == ch.rx.uuid } ?: return finish(ObdCloseReason.NO_CHANNEL)
        val t = service.characteristics.firstOrNull { it.uuid == ch.tx.uuid } ?: return finish(ObdCloseReason.NO_CHANNEL)
        rx = r
        tx = t
        withResponse = ch.tx.write
        if (!g.setCharacteristicNotification(r, true)) return finish(ObdCloseReason.FAILED)
        val cccd = r.getDescriptor(ObdProfiles.CCCD_UUID) ?: return becomeOpen()
        val value = if (ch.rx.notify) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            g.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            cccd.value = value
            @Suppress("DEPRECATION")
            g.writeDescriptor(cccd)
        }
        if (!ok) finish(ObdCloseReason.FAILED)
    }

    private fun becomeOpen() {
        if (opened || closed) return
        opened = true
        main.removeCallbacks(timeout)
        listener.onOpen()
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) = post {
            when {
                newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS -> {
                    val ok = try {
                        g.discoverServices()
                    } catch (_: SecurityException) {
                        false
                    }
                    if (!ok) finish(ObdCloseReason.FAILED)
                }
                newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS ->
                    finish(ObdCloseReason.FAILED)
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) = post {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(ObdCloseReason.FAILED)
            } else {
                try {
                    onServices(g)
                } catch (_: SecurityException) {
                    finish(ObdCloseReason.DENIED)
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = post {
            if (descriptor.uuid != ObdProfiles.CCCD_UUID) return@post
            if (status == BluetoothGatt.GATT_SUCCESS) becomeOpen() else finish(ObdCloseReason.FAILED)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = post {
            writing = false
            if (status != BluetoothGatt.GATT_SUCCESS) finish(ObdCloseReason.LOST) else pump()
        }

        // Android 13+: giá trị đi kèm lời gọi.
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            onValue(characteristic, value.copyOf())
        }

        // Android 12 trở xuống (lời gọi cũ; từ 13 không dùng để khỏi nhận hai lần).
        @Deprecated("Android < 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= 33) return
            onValue(characteristic, characteristic.value?.copyOf() ?: return)
        }
    }

    private fun onValue(c: BluetoothGattCharacteristic, value: ByteArray) {
        if (value.isEmpty() || value.size > MAX_NOTIFY_BYTES) return
        post {
            if (opened && c.uuid == rx?.uuid) listener.onData(value)
        }
    }

    companion object {
        private const val TAG = "BanDuongObd"
        const val CHUNK = 20
        const val MAX_QUEUE = 16
        const val MAX_NOTIFY_BYTES = 512
        const val CONNECT_TIMEOUT_MS = 20_000L
    }
}
