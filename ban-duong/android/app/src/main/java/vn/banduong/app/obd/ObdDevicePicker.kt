package vn.banduong.app.obd

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.DialogInterface
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.annotation.VisibleForTesting
import vn.banduong.app.R
import java.util.UUID

/**
 * Hộp chọn bộ OBD của máy, thay cho hộp chọn của Web Bluetooth / Web Serial:
 *  - BLE: tìm thiết bị ở gần, mặc định chỉ hiện thiết bị có tên/service giống bộ OBD như bản web (OBD, ELM, Vlink,
 *    vLinker, Veepeak, OBDLink…), nút "Hiện mọi thiết bị" để xem tất cả;
 *  - Bluetooth thường: danh sách thiết bị đã ghép đôi (có SPP hoặc tên giống bộ OBD; nút "Hiện mọi thiết bị").
 * Người dùng phải tự chọn; không có cách nào chọn thay. Trước đó xin quyền nếu thiếu (Thiết bị ở gần / Vị trí).
 *
 * @param requestPermissions xin các quyền Android rồi gọi lại với true nếu được cấp đủ
 * @param isForeground ứng dụng đang hiện trên màn hình (không mở hộp chọn khi ở nền)
 * @param lastTouchUptime thời điểm (SystemClock.uptimeMillis) người dùng chạm màn hình lần cuối, 0 nếu chưa chạm
 */
@SuppressLint("MissingPermission")
class ObdDevicePicker(
    private val activity: Activity,
    private val requestPermissions: (List<String>, (Boolean) -> Unit) -> Unit,
    private val isForeground: () -> Boolean,
    private val lastTouchUptime: () -> Long,
    private val uptime: () -> Long = SystemClock::uptimeMillis,
) : ObdPicker {
    private val main = Handler(Looper.getMainLooper())
    private var session: Session? = null
    private var generation = 0

    override fun hasRecentUserGesture(): Boolean {
        val t = lastTouchUptime()
        return t > 0 && uptime() - t in 0..GESTURE_WINDOW_MS
    }

    override fun pick(kind: ObdKind, showAll: Boolean, done: (PickResult) -> Unit) {
        val gen = ++generation
        var answered = false
        val once: (PickResult) -> Unit = { r ->
            if (!answered && gen == generation) {
                answered = true
                session = null
                done(r)
            }
        }
        if (!isForeground() || activity.isFinishing) return once(PickResult.Failed(PickError.BUSY))
        val pm = activity.packageManager
        val feature = if (kind == ObdKind.BLE) PackageManager.FEATURE_BLUETOOTH_LE else PackageManager.FEATURE_BLUETOOTH
        val adapter = activity.getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter == null || !pm.hasSystemFeature(feature)) return once(PickResult.Failed(PickError.UNSUPPORTED))
        val missing = ObdPermissions.missing(activity, ObdPermissions.forPick(kind))
        if (missing.isEmpty()) return show(kind, showAll, adapter, gen, once)
        requestPermissions(missing) { granted ->
            if (gen != generation) return@requestPermissions
            if (!granted || ObdPermissions.missing(activity, ObdPermissions.forPick(kind)).isNotEmpty()) {
                once(PickResult.Failed(PickError.DENIED))
            } else if (activity.isFinishing || activity.isDestroyed) {
                // Không đòi isForeground ở đây: kết quả xin quyền có thể về trước onResume.
                once(PickResult.Failed(PickError.BUSY))
            } else {
                show(kind, showAll, adapter, gen, once)
            }
        }
    }

    override fun cancel() {
        generation++
        session?.close()
        session = null
    }

    private fun show(kind: ObdKind, showAll: Boolean, adapter: BluetoothAdapter, gen: Int, done: (PickResult) -> Unit) {
        if (gen != generation) return
        val on = try {
            adapter.isEnabled
        } catch (_: SecurityException) {
            false
        }
        if (!on) return done(PickResult.Failed(PickError.OFF))
        val s = Session(kind, showAll, adapter, done)
        if (kind == ObdKind.SPP) {
            val bonded = try {
                adapter.bondedDevices.orEmpty()
            } catch (_: SecurityException) {
                return done(PickResult.Failed(PickError.DENIED))
            }
            if (bonded.isEmpty()) return done(PickResult.Failed(PickError.NO_PAIRED))
            for (d in bonded) s.add(d.address, deviceName(d), d.uuids?.map { it.uuid }.orEmpty())
        }
        session = s
        s.open()
    }

    private fun deviceName(d: BluetoothDevice): String? = try {
        d.name
    } catch (_: SecurityException) {
        null
    }

    /** Một mục trong danh sách. */
    @VisibleForTesting
    internal data class Entry(val address: String, val name: String?, val services: List<UUID>) {
        val obdLike get() = ObdProfiles.looksLikeObd(name, services) || ObdProfiles.SPP_UUID in services
    }

    private inner class Session(
        private val kind: ObdKind,
        private var showAll: Boolean,
        private val adapter: BluetoothAdapter,
        private val done: (PickResult) -> Unit,
    ) {
        private val entries = LinkedHashMap<String, Entry>()
        private val shown = ArrayList<Entry>()
        private val labels = ArrayList<String>()
        private val listAdapter = ArrayAdapter(activity, android.R.layout.simple_list_item_1, labels)
        private val status = TextView(activity)
        private var dialog: AlertDialog? = null
        private var scanning = false
        private var finished = false
        private val stopScan = Runnable { stopScanning(true) }

        private val scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) = onResult(result)

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                for (r in results) onResult(r)
            }

            override fun onScanFailed(errorCode: Int) {
                main.post {
                    scanning = false
                    refresh()
                }
            }
        }

        fun add(address: String, name: String?, services: List<UUID>) {
            if (entries.size >= MAX_ENTRIES && address !in entries) return
            val old = entries[address]
            // Gói quảng bá sau có thể thiếu tên: giữ tên đã biết.
            entries[address] = Entry(address, name ?: old?.name, (old?.services.orEmpty() + services).distinct().take(16))
        }

        private fun onResult(r: ScanResult) {
            if (finished) return
            val name = r.scanRecord?.deviceName ?: deviceName(r.device)
            val services = r.scanRecord?.serviceUuids?.map { it.uuid }.orEmpty()
            add(r.device.address, name, services)
            refresh()
        }

        fun open() {
            val pad = dp(20)
            status.setPadding(pad, dp(8), pad, dp(8))
            status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            val list = ListView(activity)
            list.adapter = listAdapter
            list.setOnItemClickListener { _, _, pos, _ ->
                val e = shown.getOrNull(pos) ?: return@setOnItemClickListener
                finish(PickResult.Picked(ObdDevice(kind, e.address, e.name)))
            }
            val root = LinearLayout(activity)
            root.orientation = LinearLayout.VERTICAL
            root.addView(status)
            root.addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(320)))
            val title = if (kind == ObdKind.BLE) R.string.obd_pick_title_ble else R.string.obd_pick_title_spp
            val d = AlertDialog.Builder(activity)
                .setTitle(title)
                .setView(root)
                .setNegativeButton(R.string.obd_pick_cancel) { _, _ -> finish(PickResult.Failed(PickError.CANCELLED)) }
                .setNeutralButton(toggleLabel(), null)
                .setOnCancelListener { finish(PickResult.Failed(PickError.CANCELLED)) }
                .create()
            d.setOnShowListener {
                // Nút đổi bộ lọc không đóng hộp chọn.
                d.getButton(DialogInterface.BUTTON_NEUTRAL)?.setOnClickListener { btn ->
                    showAll = !showAll
                    (btn as? TextView)?.setText(toggleLabel())
                    refresh()
                }
            }
            dialog = d
            if (kind == ObdKind.BLE) startScanning()
            refresh()
            d.show()
        }

        private fun toggleLabel() = if (showAll) R.string.obd_pick_show_obd else R.string.obd_pick_show_all

        private fun startScanning() {
            val scanner = adapter.bluetoothLeScanner ?: return
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            try {
                scanner.startScan(null, settings, scanCallback)
                scanning = true
                main.postDelayed(stopScan, SCAN_MS)
            } catch (_: SecurityException) {
                scanning = false
            } catch (_: IllegalStateException) {
                scanning = false // Bluetooth vừa tắt
            }
        }

        private fun stopScanning(update: Boolean) {
            main.removeCallbacks(stopScan)
            if (!scanning) return
            scanning = false
            try {
                adapter.bluetoothLeScanner?.stopScan(scanCallback)
            } catch (_: SecurityException) {
                // bỏ qua
            } catch (_: IllegalStateException) {
                // Bluetooth đã tắt
            }
            if (update) refresh()
        }

        private fun refresh() {
            if (finished) return
            shown.clear()
            val all = entries.values.toList()
            // Bộ OBD lên đầu; thiết bị không tên chỉ hiện khi xem tất cả.
            shown += all.filter { it.obdLike }
            if (showAll) shown += all.filter { !it.obdLike }
            labels.clear()
            labels += shown.map(::label)
            listAdapter.notifyDataSetChanged()
            status.setText(statusText())
        }

        private fun statusText(): Int = when {
            kind == ObdKind.SPP && shown.isEmpty() -> R.string.obd_pick_none_spp
            kind == ObdKind.SPP -> R.string.obd_pick_paired
            shown.isEmpty() && !scanning && needsLocation() -> R.string.obd_pick_location_off
            scanning -> R.string.obd_pick_scanning
            shown.isEmpty() -> R.string.obd_pick_none_ble
            else -> R.string.obd_pick_scan_done
        }

        private fun needsLocation(): Boolean {
            if (Build.VERSION.SDK_INT >= 31 || Build.VERSION.SDK_INT < 28) return false
            val lm = activity.getSystemService(LocationManager::class.java) ?: return false
            return !lm.isLocationEnabled
        }

        private fun label(e: Entry): String {
            val name = ObdController.cleanName(e.name) ?: activity.getString(R.string.obd_pick_unnamed)
            return activity.getString(R.string.obd_pick_item, name, e.address.takeLast(5))
        }

        private fun finish(result: PickResult) {
            if (finished) return
            close()
            done(result)
        }

        fun close() {
            if (finished) return
            finished = true
            stopScanning(false)
            val d = dialog
            dialog = null
            d?.setOnCancelListener(null)
            if (d?.isShowing == true) d.dismiss()
        }

        private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
    }

    companion object {
        const val GESTURE_WINDOW_MS = 5_000L
        const val SCAN_MS = 30_000L
        const val MAX_ENTRIES = 100
    }
}
