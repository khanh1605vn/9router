package vn.banduong.app.update

import android.content.Intent
import android.content.pm.PackageInstaller
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class UpdateManagerTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val tag = "ban-duong-v1.2.0"
    private val apk = ByteArray(5000) { (it * 7).toByte() }
    private val cert = setOf("aa".repeat(32))
    private val pkg = "vn.banduong.app"

    private var now = 1_764_000_000_000L
    private var moving = false
    private val t = FakeTransport()
    private val prefs = MemPrefs()
    private val sched = FakeScheduler()
    private val sent = ArrayList<JSONObject>()
    private lateinit var dir: File

    private var archiveFacts: ApkFacts? = ApkFacts(pkg, 3, cert, 26)
    private val installedFacts = ApkFacts(pkg, 2, cert)
    private val inspected = ArrayList<File>()

    private val inspector = object : ApkInspector {
        override fun archive(file: File): ApkFacts? {
            inspected += file
            assertTrue("chỉ kiểm tra tệp đã tải đủ", file.isFile && file.length() == apk.size.toLong())
            return archiveFacts
        }
        override fun installed() = installedFacts
    }

    private var canInstall = true
    private val commits = ArrayList<File>()
    private val abandoned = ArrayList<Int>()
    private var commitError: UpdateError? = null
    private val gateway = object : InstallGateway {
        override fun canRequestInstalls() = canInstall
        override fun commit(file: File, manifest: UpdateManifest): Int {
            commitError?.let { throw it }
            commits += file
            return 42
        }
        override fun abandon(sessionId: Int) { abandoned += sessionId }
    }

    private val opened = ArrayList<String>()
    private val confirms = ArrayList<Intent>()
    private var settingsOpened = 0
    private val ui = object : UpdateUi {
        override fun openInstallSettings(): Boolean { settingsOpened++; return true }
        override fun startConfirm(intent: Intent): Boolean { confirms += intent; return true }
        override fun openExternal(url: String) { opened += url }
    }

    private fun manager(mode: UpdateMode = UpdateMode.INSTALL, installedCode: Long = 2) = UpdateManager(
        config = UpdateConfig(REPO, PREFIX, mode, installedCode, "1.1.0", 34),
        http = SafeHttp(t) { now },
        inspector = inspector,
        gateway = if (mode == UpdateMode.INSTALL) gateway else null,
        prefs = prefs,
        dir = dir,
        io = DirectExecutor(),
        main = { it.run() },
        scheduler = sched,
        nowMs = { now },
        isMoving = { moving },
    ).also { m ->
        m.ui = ui
        m.sink = { sent += JSONObject(it) }
    }

    private fun last() = sent.last()
    private fun state() = last().getString("state")

    @Before
    fun setUp() {
        dir = File(tmp.root, "update")
        serve()
    }

    private fun serve(manifest: String = manifestJson(tag, 3, apk, notes = "Có nút cập nhật.")) {
        t.ok(API, releases(release("v3.0.0"), release(tag, apkSize = apk.size.toLong())))
        t.ok(dl(tag, "update.json"), manifest)
        t.redirect(dl(tag, "ban-duong.apk"), "https://release-assets.githubusercontent.com/apk?sig=x")
        t.ok("https://release-assets.githubusercontent.com/apk?sig=x", apk)
    }

    @Test
    fun checkFindsNewerVersion() {
        val m = manager()
        m.check(manual = true)
        assertEquals("checking", sent.first().getString("state"))
        val s = last()
        assertEquals("available", s.getString("state"))
        assertEquals("1.2.0", s.getString("versionName"))
        assertEquals("Có nút cập nhật.", s.getString("notes"))
        assertEquals("install", s.getString("mode"))
        assertEquals("1.1.0", s.getString("current"))
        assertEquals("updateStatus", s.getString("type"))
        assertEquals(1, s.getInt("v"))
        assertEquals(now, prefs.lastCheckAt)
        // Chỉ gọi API và update.json, chưa tải APK khi người dùng chưa bấm.
        assertEquals(listOf(API, dl(tag, "update.json")), t.requests.map { it.first })
    }

    @Test
    fun sameOrOlderVersionIsUpToDate() {
        manager(installedCode = 3).check(manual = true)
        assertEquals("uptodate", state())
        sent.clear()
        t.ok(API, releases(release("v3.0.0")))
        now += 60_000
        manager().check(manual = true)
        assertEquals("uptodate", state())
    }

    @Test
    fun oneTapDownloadsVerifiesAndOpensInstaller() {
        val m = manager()
        m.check(manual = true)
        m.install()
        val states = sent.map { it.getString("state") }
        assertTrue(states.containsAll(listOf("downloading", "verifying", "ready")))
        assertEquals("ready", state())
        assertEquals(1, commits.size)
        assertEquals(apk.size.toLong(), commits.single().length())
        assertEquals(42, m.pendingSessionForTest)

        // Hệ thống cần người dùng xác nhận: mở đúng intent, bỏ cờ cấp quyền URI.
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        m.onInstallStatus(41, PackageInstaller.STATUS_PENDING_USER_ACTION, confirm) // phiên lạ: bỏ qua
        assertTrue(confirms.isEmpty())
        m.onInstallStatus(42, PackageInstaller.STATUS_PENDING_USER_ACTION, confirm)
        assertEquals(1, confirms.size)
        assertEquals(0, confirms.single().flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)

        m.onInstallStatus(42, PackageInstaller.STATUS_SUCCESS, null)
        assertEquals("uptodate", state())
        assertTrue("đã xoá tệp", dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun userCancelKeepsVerifiedFileForNextTap() {
        val m = manager()
        m.check(true)
        m.install()
        m.onInstallStatus(42, PackageInstaller.STATUS_FAILURE_ABORTED, null)
        assertEquals("ready", state())
        assertEquals("install-aborted", last().getString("error"))
        val downloads = t.requests.count { it.first.contains("release-assets") }
        m.install()
        assertEquals("không tải lại", downloads, t.requests.count { it.first.contains("release-assets") })
        assertEquals(2, commits.size)
        m.onInstallStatus(42, PackageInstaller.STATUS_FAILURE, null)
        assertEquals("error", state())
        assertEquals("install-failed", last().getString("error"))
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun shaMismatchDeletesFileAndNeverInstalls() {
        serve(manifestJson(tag, 3, apk, sha = sha256Hex(byteArrayOf(9))))
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("error", state())
        assertEquals("checksum", last().getString("error"))
        assertTrue(commits.isEmpty())
        assertTrue(inspected.isEmpty())
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun oversizedDownloadIsCut() {
        // Máy chủ gửi nhiều hơn kích thước trong update.json: dừng, không cài.
        t.ok("https://release-assets.githubusercontent.com/apk?sig=x", apk + ByteArray(10))
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("too-large", last().getString("error"))
        assertTrue(commits.isEmpty())
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun packageCertAndVersionMismatchAreRejected() {
        val cases = mapOf(
            ApkFacts("vn.evil.app", 3, cert, 26) to "package-mismatch",
            ApkFacts(pkg, 3, setOf("bb".repeat(32)), 26) to "signature-mismatch",
            ApkFacts(pkg, 3, emptySet(), 26) to "signature-mismatch",
            ApkFacts(pkg, 3, cert + "cc".repeat(32), 26) to "signature-mismatch",
            ApkFacts(pkg, 4, cert, 26) to "version-mismatch",
            ApkFacts(pkg, 2, cert, 26) to "version-mismatch",
            ApkFacts(pkg, 3, cert, 35) to "incompatible",
        )
        for ((facts, code) in cases) {
            sent.clear()
            commits.clear()
            archiveFacts = facts
            val m = manager()
            m.check(true)
            m.install()
            assertEquals(facts.toString(), code, last().getString("error"))
            assertTrue(commits.isEmpty())
            assertTrue(dir.listFiles().orEmpty().isEmpty())
            now += 60_000
        }
        archiveFacts = null
        sent.clear()
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("bad-apk", last().getString("error"))
    }

    @Test
    fun missingInstallPermissionOpensSettingsThenContinues() {
        canInstall = false
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("install-permission", last().getString("error"))
        assertEquals(1, settingsOpened)
        assertFalse("chưa tải khi chưa có quyền", t.requests.any { it.first.contains("release-assets") })
        m.onResume()
        assertTrue(commits.isEmpty())
        canInstall = true
        m.onResume()
        assertEquals("ready", state())
        assertEquals(1, commits.size)
    }

    @Test
    fun drivingBlocksInstall() {
        moving = true
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("driving", last().getString("error"))
        assertEquals("1.2.0", last().getString("versionName"))
        assertFalse(t.requests.any { it.first.contains("release-assets") })
        moving = false
        m.install()
        assertEquals("ready", state())
    }

    @Test
    fun dismissHidesThisVersionFromAutomaticChecks() {
        val m = manager()
        m.check(true)
        m.dismiss()
        assertEquals("idle", state())
        assertEquals(3L, prefs.dismissedCode)
        now += UpdateManager.INTERVAL_MS
        m.check(manual = false)
        assertEquals("idle", state())
        now += 60_000
        m.check(manual = true)
        assertEquals("available", state())
    }

    @Test
    fun automaticFailuresAreSilentAndRateLimitsBackOff() {
        val m = manager()
        t.routes[API] = FakeTransport.Resp(403, headers = mapOf("X-RateLimit-Reset" to ((now / 1000) + 3600).toString()))
        m.check(manual = false)
        assertEquals("idle", state())
        assertEquals(now + 3_600_000, prefs.backoffUntil)
        val n = t.requests.size
        m.check(manual = false)
        m.check(manual = true)
        assertEquals("không gọi GitHub khi đang phải chờ", n, t.requests.size)
        assertEquals("rate-limited", last().getString("error"))
        // Đồng hồ máy lùi xa: hạn chờ quá 6 giờ coi như hết.
        now -= 30L * 24 * 3600 * 1000
        serve()
        m.check(manual = true)
        assertEquals("available", state())
    }

    @Test
    fun manualChecksAreSpacedOut() {
        val m = manager()
        m.check(true)
        val n = t.requests.size
        m.check(true)
        assertEquals(n, t.requests.size)
        assertEquals("available", state())
        now += UpdateManager.MANUAL_MIN_GAP_MS
        m.check(true)
        assertTrue(t.requests.size > n)
    }

    @Test
    fun badManifestIsReportedOnlyWhenManual() {
        serve("{\"versionCode\":3}")
        val m = manager()
        m.check(false)
        assertEquals("idle", state())
        m.check(true)
        assertEquals("bad-release", last().getString("error"))
    }

    @Test
    fun scheduleStartsAfterDelayAndRepeatsEvery6Hours() {
        val m = manager()
        File(dir, "old.apk.part").apply { parentFile!!.mkdirs(); writeText("x") }
        m.start()
        assertTrue("dọn tệp cũ", dir.listFiles().orEmpty().isEmpty())
        assertEquals(UpdateManager.START_DELAY_MS, sched.tasks.single().first)
        sched.runNext()
        assertEquals("available", state())
        assertEquals(UpdateManager.INTERVAL_MS, sched.tasks.single().first)
        m.stop()
        assertTrue(sched.tasks.isEmpty())
    }

    @Test
    fun notifyModeOpensReleasePageInsteadOfInstalling() {
        val m = manager(UpdateMode.NOTIFY)
        m.check(true)
        assertEquals("notify", last().getString("mode"))
        m.install()
        assertEquals(listOf("https://github.com/$REPO/releases/tag/$tag"), opened)
        assertFalse(t.requests.any { it.first.contains("release-assets") })
        assertTrue(commits.isEmpty())
    }

    @Test
    fun offModeDoesNothing() {
        val m = manager(UpdateMode.OFF)
        m.start()
        m.check(true)
        m.install()
        assertTrue(sent.isEmpty())
        assertTrue(t.requests.isEmpty())
        assertTrue(sched.tasks.isEmpty())
    }

    @Test
    fun installFailureFromGatewayIsReported() {
        commitError = UpdateError(UpdateErrors.STORAGE)
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("storage", last().getString("error"))
        assertTrue(dir.listFiles().orEmpty().isEmpty())
        assertNull(last().opt("progress").takeIf { it != JSONObject.NULL })
    }

    private val confirmIntent get() = Intent("android.content.pm.action.CONFIRM_INSTALL")

    @Test
    fun confirmDialogNeverOpensIfCarStartedMovingWhileCopying() {
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("ready", state())
        assertEquals(42, m.pendingSessionForTest)
        // Chép tệp vào phiên cài mất vài giây; trong lúc đó xe lăn bánh.
        moving = true
        m.onInstallStatus(42, PackageInstaller.STATUS_PENDING_USER_ACTION, confirmIntent)
        assertTrue("không mở hộp thoại cài lúc xe chạy", confirms.isEmpty())
        assertEquals(listOf(42), abandoned)
        assertEquals(-1, m.pendingSessionForTest)
        assertEquals("ready", state())
        assertEquals("driving", last().getString("error"))
        // Phiên đã bỏ: hệ thống báo muộn cũng không mở gì.
        m.onInstallStatus(42, PackageInstaller.STATUS_PENDING_USER_ACTION, confirmIntent)
        assertTrue(confirms.isEmpty())
        // Bấm lại lúc vẫn chạy: từ chối ngay, không chép lại.
        m.install()
        assertEquals("driving", last().getString("error"))
        assertEquals(1, commits.size)
        // Dừng hẳn rồi bấm: dùng tệp đã xác minh (không tải lại), phiên mới, lần này mới mở hộp thoại.
        moving = false
        val downloads = t.requests.count { it.first.contains("release-assets") }
        m.install()
        assertEquals(downloads, t.requests.count { it.first.contains("release-assets") })
        assertEquals(2, commits.size)
        m.onInstallStatus(42, PackageInstaller.STATUS_PENDING_USER_ACTION, confirmIntent)
        assertEquals(1, confirms.size)
    }

    @Test
    fun afterCancelChecksStillRunAndAReplacedReleaseDropsTheOldFile() {
        val m = manager()
        m.check(true)
        m.install()
        m.onInstallStatus(42, PackageInstaller.STATUS_FAILURE_ABORTED, null)
        assertEquals("ready", state())
        assertEquals("install-aborted", last().getString("error"))
        // Lần tự kiểm tra sau đó vẫn chạy; vẫn đúng bản đó thì giữ "sẵn sàng cài" và tệp, không nhấp nháy "đang kiểm tra".
        now += UpdateManager.INTERVAL_MS
        val before = t.requests.size
        sent.clear()
        m.check(manual = false)
        assertTrue("có hỏi GitHub", t.requests.size > before)
        assertFalse(sent.any { it.getString("state") == "checking" })
        assertEquals("ready", state())
        assertEquals(1, dir.listFiles().orEmpty().count { it.name.endsWith(".apk") })
        // Bản 1.2.0 bị thay bằng bản sửa lỗi 1.2.1: bỏ tệp cũ, mời bản mới.
        val tag2 = "ban-duong-v1.2.1"
        t.ok(API, releases(release(tag2, apkSize = apk.size.toLong()), release(tag, apkSize = apk.size.toLong())))
        t.ok(dl(tag2, "update.json"), manifestJson(tag2, 4, apk))
        now += UpdateManager.INTERVAL_MS
        m.check(manual = false)
        assertEquals("available", state())
        assertEquals("1.2.1", last().getString("versionName"))
        assertTrue("tệp của bản cũ đã xoá", dir.listFiles().orEmpty().isEmpty())
        // Bản phát hành bị gỡ hẳn: đã mới nhất, không còn tệp nào.
        t.ok(API, releases(release("v3.0.0")))
        now += 60_000
        m.check(manual = true)
        assertEquals("uptodate", state())
    }

    @Test
    fun whileWaitingForTheSystemNoCheckRuns() {
        val m = manager()
        m.check(true)
        m.install()
        assertEquals("ready", state())
        val n = t.requests.size
        now += UpdateManager.INTERVAL_MS
        m.check(manual = false)
        m.check(manual = true)
        assertEquals("phiên cài đang chờ hệ thống: không kiểm tra", n, t.requests.size)
        assertEquals("ready", state())
    }

    @Test
    fun sideloadIsOfferedTheOfficialAppEvenWithTheSameVersionCode() {
        // Bản sideload là gói khác (vn.banduong.app.sideload…) nên không bao giờ "đã mới nhất" so với bản chính thức.
        val m = manager(UpdateMode.NOTIFY, installedCode = 3)
        m.check(true)
        assertEquals("available", state())
        assertEquals("notify", last().getString("mode"))
        m.install()
        assertEquals(listOf("https://github.com/$REPO/releases/tag/$tag"), opened)
        // Bản cài chính thức cùng versionCode thì đã mới nhất.
        sent.clear()
        now += 60_000
        manager(UpdateMode.INSTALL, installedCode = 3).check(true)
        assertEquals("uptodate", state())
    }

    @Test
    fun downloadsStayInsideTheReleaseScope() {
        // update.json chuyển hướng ra ngoài kho (ví dụ raw.githubusercontent.com): từ chối, không đọc gì.
        t.redirect(dl(tag, "update.json"), "https://raw.githubusercontent.com/evil/x/main/update.json")
        t.ok("https://raw.githubusercontent.com/evil/x/main/update.json", manifestJson(tag, 3, apk))
        val m = manager()
        m.check(true)
        assertEquals("error", state())
        assertFalse(t.requests.any { it.first.contains("raw.githubusercontent.com") })
        // APK chuyển hướng sang kho khác trên github.com: cũng từ chối.
        serve()
        t.redirect(dl(tag, "ban-duong.apk"), "https://github.com/evil/x/releases/download/t/ban-duong.apk")
        now += 60_000
        m.check(true)
        m.install()
        assertEquals("error", state())
        assertTrue(commits.isEmpty())
        assertFalse(t.requests.any { it.first.contains("/evil/") })
    }
}
