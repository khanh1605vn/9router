package vn.banduong.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.car.app.connection.CarConnection
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Observer
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import vn.banduong.app.bridge.CarStateStore
import vn.banduong.app.bridge.NativeBridge
import vn.banduong.app.obd.AndroidObdLinks
import vn.banduong.app.obd.ObdController
import vn.banduong.app.obd.ObdDevicePicker
import vn.banduong.app.update.UpdateManager
import vn.banduong.app.update.UpdateService
import vn.banduong.app.update.UpdateUi
import vn.banduong.app.web.AppOrigin
import vn.banduong.app.web.WebAssets

/**
 * Màn hình điện thoại: toàn bộ ứng dụng web Bạn Đường trong một WebView, nạp từ tệp đóng gói trong APK.
 *
 * An toàn:
 *  - chỉ nạp https://appassets.androidplatform.net (WebViewAssetLoader), không đọc tệp, không nội dung hỗn hợp;
 *  - điều hướng sang nguồn gốc khác mở bằng trình duyệt ngoài (chỉ http/https, chỉ khi người dùng bấm);
 *  - quyền camera và vị trí chỉ cấp cho nguồn gốc của ứng dụng, mỗi lần đều kiểm tra quyền Android;
 *  - cầu nối JS chỉ có trong khung của ứng dụng (addWebMessageListener), xem [NativeBridge];
 *  - bộ OBD Bluetooth: chỉ thiết bị người dùng tự chọn trong hộp chọn của máy, chỉ lệnh đọc được phép ([ObdController]);
 *  - tự cập nhật (bản release): máy tự tìm, tải và xác minh bản mới trên GitHub ([UpdateManager]); người dùng luôn tự
 *    xác nhận trong hộp thoại cài đặt của hệ thống.
 */
class MainActivity : ComponentActivity(), NativeBridge.Host, UpdateUi {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var bridge: NativeBridge
    private lateinit var obd: ObdController
    private lateinit var obdPicker: ObdDevicePicker
    private var updater: UpdateManager? = null

    // Lần chạm cuối (uptime): hộp chọn bộ OBD chỉ mở ngay sau một lần chạm, như Web Bluetooth.
    private var lastTouchUp = 0L
    private var pendingBluetooth: ((Boolean) -> Unit)? = null

    // Xe được coi là đã kết nối khi điện thoại đang chiếu Android Auto hoặc có phiên màn hình xe đang mở.
    private var carConnected = false
    private var projecting = false
    private var resumed = false
    private var carConnection: CarConnection? = null
    private val carObserver = Observer<Int> { type -> onCarConnectionType(type) }
    private val carSessionListener = CarStateStore.CarSessionListener { updateCarConnected() }

    // Yêu cầu quyền đang chờ người dùng trả lời.
    private val pendingGeo = ArrayList<Pair<String, GeolocationPermissions.Callback>>()
    private var pendingCamera: PermissionRequest? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val locationLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val ok = res.values.any { it } || hasLocationPermission()
        if (!ok) toast(R.string.permission_location_denied)
        val waiting = pendingGeo.toList()
        pendingGeo.clear()
        for ((origin, cb) in waiting) cb.invoke(origin, ok, false)
    }

    private val cameraLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val req = pendingCamera ?: return@registerForActivityResult
        pendingCamera = null
        if (granted) {
            req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            req.deny()
            toast(R.string.permission_camera_denied)
        }
    }

    private val bluetoothLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val cb = pendingBluetooth ?: return@registerForActivityResult
        pendingBluetooth = null
        cb(res.isNotEmpty() && res.values.all { it })
    }

    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = pendingFiles ?: return@registerForActivityResult
        pendingFiles = null
        cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        assetLoader = WebAssets.createLoader(this)
        obdPicker = ObdDevicePicker(
            activity = this,
            requestPermissions = ::requestBluetooth,
            isForeground = { resumed },
            lastTouchUptime = { lastTouchUp },
        )
        obd = ObdController(obdPicker, AndroidObdLinks(applicationContext, Handler(Looper.getMainLooper())))
        updater = UpdateService.get(this)?.also { it.ui = this }
        bridge = NativeBridge(this, obd, updater)

        val swOk = setUpServiceWorker()
        webView = WebView(this)
        configureWebView(webView)
        val bridgeOk = bridge.install(webView, loadShim(swOk))
        if (!bridgeOk) toast(R.string.webview_too_old)

        val root = FrameLayout(this)
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.brand_blue))
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        // Trang web vẽ dưới thanh trạng thái/điều hướng thì bị che: chừa đúng phần hệ thống chiếm.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        carConnection = CarConnection(this).also { it.type.observeForever(carObserver) }
        CarStateStore.addCarSessionListener(carSessionListener)
        updateCarConnected()

        if (savedInstanceState == null || !restoreWeb(savedInstanceState)) webView.loadUrl(AppOrigin.START_URL)
        updater?.start()
    }

    private fun restoreWeb(state: Bundle): Boolean {
        val list = webView.restoreState(state) ?: return false
        val url = list.currentItem?.url
        return list.size > 0 && AppOrigin.isAppUrl(url)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(w: WebView) {
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(true)
            // Tiếng bíp cảnh báo quá tốc độ phát khi không có thao tác chạm.
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            safeBrowsingEnabled = true
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // Trang tự có giao diện tối; không để WebView tự đảo màu bản đồ.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(w.settings, false)
        }
        // Khi đang chiếu lên màn hình xe, điện thoại có thể tắt màn hình: giữ tiến trình hiển thị ở mức quan trọng.
        w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        w.webViewClient = AppWebViewClient()
        w.webChromeClient = AppChromeClient()
    }

    /** Service worker của trang (sw.js) cũng phải lấy tệp qua WebViewAssetLoader. Trả false nếu WebView không hỗ trợ. */
    @SuppressLint("RequiresFeature")
    private fun setUpServiceWorker(): Boolean {
        val needed = listOf(
            WebViewFeature.SERVICE_WORKER_BASIC_USAGE,
            WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST,
            WebViewFeature.SERVICE_WORKER_FILE_ACCESS,
            WebViewFeature.SERVICE_WORKER_CONTENT_ACCESS,
        )
        if (!needed.all(WebViewFeature::isFeatureSupported)) return false
        val controller = ServiceWorkerControllerCompat.getInstance()
        controller.serviceWorkerWebSettings.apply {
            allowFileAccess = false
            allowContentAccess = false
        }
        controller.setServiceWorkerClient(object : ServiceWorkerClientCompat() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                interceptApp(request.url)
        })
        return true
    }

    private fun interceptApp(url: Uri): WebResourceResponse? =
        if (AppOrigin.isAppUri(url)) assetLoader.shouldInterceptRequest(url) ?: WebAssets.notFound() else null

    private fun loadShim(swOk: Boolean): String =
        resources.openRawResource(R.raw.bridge_shim).bufferedReader(Charsets.UTF_8).use { it.readText() }
            .replace("__SW_OK__", if (swOk) "true" else "false")
            .replace("__OBD_CAPS__", obdCaps())
            .replace("__UPDATE_CAPS__", updateCaps())

    /** Khả năng Bluetooth của máy cho bộ OBD, dạng JSON cho lớp nối (js/obdnative.js đọc qua window.BanDuongApp). */
    private fun obdCaps(): String {
        val pm = packageManager
        val ble = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val spp = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)
        return if (ble || spp) "{\"ble\":$ble,\"spp\":$spp}" else "null"
    }

    /** Chế độ tự cập nhật cho lớp nối (window.BanDuongApp.update): { mode, current } hoặc null (bản debug). */
    private fun updateCaps(): String {
        val u = updater ?: return "null"
        return JSONObject().put("mode", u.mode.key).put("current", BuildConfig.VERSION_NAME).toString()
    }

    private fun requestBluetooth(perms: List<String>, done: (Boolean) -> Unit) {
        if (pendingBluetooth != null) return done(false)
        pendingBluetooth = done
        try {
            bluetoothLauncher.launch(perms.toTypedArray())
        } catch (e: IllegalStateException) {
            pendingBluetooth = null
            done(false)
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_UP) lastTouchUp = SystemClock.uptimeMillis()
        return super.dispatchTouchEvent(ev)
    }

    private inner class AppWebViewClient : WebViewClientCompat() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            interceptApp(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (AppOrigin.isAppUri(uri)) return false
            // Khung con không được dẫn đi đâu khác; khung chính thì mở trình duyệt ngoài khi người dùng bấm.
            if (request.isForMainFrame && request.hasGesture() && AppOrigin.isExternalWebLink(uri)) openExternal(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (AppOrigin.isAppUrl(url)) bridge.onPageStarted()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceErrorCompat) {
            if (request.isForMainFrame && AppOrigin.isAppUri(request.url)) toast(R.string.web_load_error)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Tiến trình vẽ trang bị dừng (hết bộ nhớ…): bỏ WebView cũ, dựng lại màn hình.
            Log.w(TAG, "WebView renderer gone, crash=${detail.didCrash()}")
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            obd.reset()
            CarStateStore.clear(android.os.SystemClock.uptimeMillis())
            toast(R.string.web_renderer_restarted)
            recreate()
            return true
        }
    }

    private inner class AppChromeClient : WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            if (!AppOrigin.isAppOrigin(origin)) {
                callback.invoke(origin, false, false)
                return
            }
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false)
                return
            }
            pendingGeo += origin to callback
            if (pendingGeo.size == 1) {
                locationLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            }
        }

        override fun onGeolocationPermissionsHidePrompt() {
            pendingGeo.clear()
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val wantsVideo = PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources
            if (!AppOrigin.isAppOrigin(request.origin?.toString()) || !wantsVideo) {
                request.deny()
                return
            }
            // Chỉ camera; micro, MIDI, nội dung có bảo vệ đều không cấp.
            if (granted(Manifest.permission.CAMERA)) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                return
            }
            pendingCamera?.deny()
            pendingCamera = request
            cameraLauncher.launch(Manifest.permission.CAMERA)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingCamera === request) pendingCamera = null
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            // Nhập tệp (điểm đánh dấu, biển đã học): chỉ đọc tệp người dùng tự chọn.
            pendingFiles?.onReceiveValue(null)
            pendingFiles = filePathCallback
            return try {
                fileLauncher.launch(fileChooserParams.createIntent())
                true
            } catch (_: ActivityNotFoundException) {
                pendingFiles = null
                false
            }
        }
    }

    private fun openExternal(uri: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_browser)
        }
    }

    private fun onCarConnectionType(type: Int) {
        projecting = type == CarConnection.CONNECTION_TYPE_PROJECTION
        updateCarConnected()
    }

    /** Gửi "carConnected" sang trang mỗi khi kết nối đổi (chiếu Android Auto, phiên màn hình xe mở/đóng). */
    private fun updateCarConnected() {
        val connected = projecting || CarStateStore.isCarSessionActive
        if (connected == carConnected) return
        carConnected = connected
        // Đang chiếu lên xe mà điện thoại ở nền: vẫn để trang chạy (định vị, cảnh báo) để màn hình xe có dữ liệu.
        if (::webView.isInitialized) {
            if (connected && !resumed) webView.onResume()
            if (!connected && !resumed) webView.onPause()
        }
        bridge.notifyCarConnected(connected)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        webView.onResume()
        updater?.onResume()
    }

    override fun onPause() {
        resumed = false
        if (!carConnected) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        carConnection?.type?.removeObserver(carObserver)
        CarStateStore.removeCarSessionListener(carSessionListener)
        carConnection = null
        pendingGeo.clear()
        pendingCamera?.deny()
        pendingCamera = null
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        pendingBluetooth = null
        if (::obd.isInitialized) obd.reset()
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        if (isFinishing) CarStateStore.clear(android.os.SystemClock.uptimeMillis())
        updater?.let { u ->
            // Activity mới (dựng lại) đã gắn mình vào thì không gỡ của nó.
            if (u.ui === this) {
                u.ui = null
                u.sink = null
            }
            if (isFinishing && !isChangingConfigurations) u.stop()
        }
        super.onDestroy()
    }

    // ---- NativeBridge.Host ----

    override fun setKeepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun isCarConnected(): Boolean = carConnected

    override fun appVersion(): String = BuildConfig.VERSION_NAME

    // ---- UpdateUi ----

    override fun openInstallSettings(): Boolean {
        toast(R.string.update_allow_install)
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri())
        return try {
            startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            // Một số màn hình xe bỏ trang này: mở trang cài đặt chung của ứng dụng.
            try {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
                true
            } catch (_: ActivityNotFoundException) {
                false
            }
        }
    }

    override fun startConfirm(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }

    override fun openExternal(url: String) = openExternal(url.toUri())

    // ---- tiện ích ----

    private fun hasLocationPermission() =
        granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun toast(res: Int) = Toast.makeText(this, res, Toast.LENGTH_LONG).show()

    companion object {
        private const val TAG = "BanDuong"
    }
}
