package vn.banduong.app.bridge

import android.annotation.SuppressLint
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.annotation.MainThread
import androidx.annotation.VisibleForTesting
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import vn.banduong.app.obd.ObdController
import vn.banduong.app.web.AppOrigin

/**
 * Cầu nối JavaScript ↔ Android. Dùng WebViewCompat.addWebMessageListener với quy tắc nguồn gốc chỉ gồm
 * [AppOrigin.ORIGIN]: đối tượng window.BanDuongNative chỉ xuất hiện trong khung của ứng dụng, không bao giờ
 * trong trang khác (không dùng addJavascriptInterface).
 *
 * Trang web chỉ làm được những việc sau: chào (hello), gửi trạng thái lái xe (state) cho màn hình ô tô, bật/tắt giữ
 * màn hình sáng, và dùng bộ OBD người dùng đã tự chọn trong hộp chọn của máy ([ObdController]: obdPick,
 * obdConnect, obdWrite với lệnh trong danh sách được phép, obdDisconnect). Không có lệnh nào khác; thông điệp sai
 * hoặc quá nhiều đều bị bỏ.
 */
class NativeBridge(
    private val host: Host,
    private val obd: ObdController? = null,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val uptimeMs: () -> Long = SystemClock::uptimeMillis,
    clockNanos: () -> Long = System::nanoTime,
) : WebViewCompat.WebMessageListener {

    interface Host {
        fun setKeepScreenOn(on: Boolean)
        fun isCarConnected(): Boolean
        fun appVersion(): String
    }

    // Giới hạn chung trước khi phân tích JSON (rẻ), rồi giới hạn riêng theo loại.
    private val gate = RateLimiter(ratePerSec = BridgeLimits.STATE_RATE_PER_SEC + BridgeLimits.CONTROL_RATE_PER_SEC, clockNanos = clockNanos)
    private val smallGate = RateLimiter(BridgeLimits.SMALL_GATE_RATE_PER_SEC, clockNanos = clockNanos)
    private val stateLimiter = RateLimiter(BridgeLimits.STATE_RATE_PER_SEC, clockNanos = clockNanos)
    private val controlLimiter = RateLimiter(BridgeLimits.CONTROL_RATE_PER_SEC, clockNanos = clockNanos)
    private val obdControlLimiter = RateLimiter(BridgeLimits.OBD_CONTROL_RATE_PER_SEC, clockNanos = clockNanos)
    private val obdWriteLimiter = RateLimiter(BridgeLimits.OBD_WRITE_RATE_PER_SEC, clockNanos = clockNanos)

    init {
        obd?.sink = { post(it) }
    }

    private var reply: JavaScriptReplyProxy? = null

    @VisibleForTesting
    var droppedCount = 0
        private set

    /** Gắn cầu nối vào WebView. Trả false nếu WebView quá cũ (khi đó trang vẫn chạy, chỉ không có màn hình xe). */
    @SuppressLint("RequiresFeature")
    fun install(webView: WebView, shimJs: String): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(webView, JS_OBJECT_NAME, AppOrigin.ORIGIN_RULES, this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, shimJs, AppOrigin.ORIGIN_RULES)
            return true
        }
        return false
    }

    @MainThread
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        val data = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
        handle(data, sourceOrigin, isMainFrame, replyProxy)
    }

    /** Phần xử lý không phụ thuộc WebView, để kiểm thử. */
    @VisibleForTesting
    @MainThread
    internal fun handle(data: String?, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy?) {
        // Kiểm tra lại dù quy tắc nguồn gốc đã lọc: chỉ khung chính của ứng dụng.
        if (!isMainFrame || !AppOrigin.isAppOrigin(sourceOrigin.toString())) return drop("origin")
        val small = data != null && data.length <= BridgeLimits.SMALL_MESSAGE_CHARS
        if (!(if (small) smallGate else gate).tryAcquire()) return drop("rate")
        when (val r = BridgeMessageParser.parse(data, nowMs())) {
            is ParseResult.Rejected -> drop(r.reason)
            is ParseResult.Ok -> when (val m = r.message) {
                is InboundMessage.State -> {
                    if (!stateLimiter.tryAcquire()) return drop("rate-state")
                    CarStateStore.update(m.state, uptimeMs())
                }
                is InboundMessage.Hello -> {
                    if (!controlLimiter.tryAcquire()) return drop("rate-control")
                    reply = replyProxy
                    post(OutboundMessages.native(host.isCarConnected(), host.appVersion()))
                }
                is InboundMessage.KeepScreenOn -> {
                    if (!controlLimiter.tryAcquire()) return drop("rate-control")
                    host.setKeepScreenOn(m.on)
                }
                is InboundMessage.ObdPick, is InboundMessage.ObdConnect, is InboundMessage.ObdDisconnect -> {
                    val c = obd ?: return drop("obd-off")
                    if (!obdControlLimiter.tryAcquire()) return drop("rate-obd")
                    if (reply == null) reply = replyProxy
                    when (m) {
                        is InboundMessage.ObdPick -> c.pick(m.req, m.kind, m.all)
                        is InboundMessage.ObdConnect -> c.connect(m.link)
                        is InboundMessage.ObdDisconnect -> c.disconnect(m.link)
                        else -> Unit
                    }
                }
                is InboundMessage.ObdWrite -> {
                    val c = obd ?: return drop("obd-off")
                    if (!obdWriteLimiter.tryAcquire()) return drop("rate-obd-write")
                    c.write(m.link, m.data)
                }
            }
        }
    }

    /** Trang mới bắt đầu nạp: bỏ kênh trả lời cũ, nhả giữ màn hình, xoá trạng thái cũ trên màn hình xe. */
    @MainThread
    fun onPageStarted() {
        reply = null
        obd?.reset()
        host.setKeepScreenOn(false)
        CarStateStore.clear(uptimeMs())
    }

    @MainThread
    fun notifyCarConnected(connected: Boolean) {
        post(OutboundMessages.carConnected(connected))
    }

    @SuppressLint("RequiresFeature")
    private fun post(json: String) {
        val r = reply ?: return
        try {
            r.postMessage(json)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Không gửi được thông điệp sang trang", e)
            reply = null
        }
    }

    private fun drop(reason: String) {
        droppedCount++
        // Không ghi nội dung thông điệp (có thể chứa vị trí); chỉ ghi lý do, và chỉ thỉnh thoảng.
        if (droppedCount <= 5 || droppedCount % 100 == 0) Log.w(TAG, "Bỏ thông điệp từ trang: $reason (#$droppedCount)")
    }

    companion object {
        const val JS_OBJECT_NAME = "BanDuongNative"
        private const val TAG = "BanDuongBridge"
    }
}
