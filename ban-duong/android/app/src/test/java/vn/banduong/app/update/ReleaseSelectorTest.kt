package vn.banduong.app.update

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ReleaseSelectorTest {
    private fun pick(json: String) = ReleaseSelector.select(json, REPO, PREFIX)

    @Test
    fun picksNewestMatchingReleaseAndIgnoresTheRest() {
        val json = releases(
            release("v2.9.0"), // bản phát hành của 9router
            release("ban-duong-v9.0.0", prerelease = true),
            release("ban-duong-v8.0.0", draft = true),
            release("ban-duong-v1.10.0"),
            release("ban-duong-v1.9.3"),
            release("ban-duong-v1.2.0-beta"),
            release("ban-duong-vX"),
            release("cli-v1.0.0"),
        )
        val c = pick(json)!!
        assertEquals("ban-duong-v1.10.0", c.tag)
        assertEquals("1.10.0", c.versionName)
        assertEquals(dl("ban-duong-v1.10.0", "ban-duong.apk"), c.apkUrl)
        assertEquals(dl("ban-duong-v1.10.0", "update.json"), c.manifestUrl)
        assertEquals(1000, c.apkSize)
    }

    @Test
    fun orderOfApiDoesNotMatterAndNoneMatchingGivesNull() {
        assertEquals("ban-duong-v1.3", pick(releases(release("ban-duong-v1.2.9"), release("ban-duong-v1.3")))!!.tag)
        assertNull(pick(releases(release("v1.0.0"), release("ban-duong-v2.0.0", prerelease = true))))
        assertNull(pick("[]"))
        assertNull(pick("{}"))
        assertNull(pick("not json"))
        assertNull(pick("[{\"tag_name\":'ban-duong-v1'}]")) // JSON không chặt
    }

    @Test
    fun draftAndPrereleaseMustBeExactlyFalse() {
        assertNull(pick(releases(release("ban-duong-v1.0.0", draft = "false"))))
        assertNull(pick(releases(release("ban-duong-v1.0.0", prerelease = JSONObject.NULL))))
        assertNull(pick(releases(release("ban-duong-v1.0.0").apply { remove("draft") })))
    }

    @Test
    fun assetsMustBeCompleteUploadedAndAtTheExpectedUrl() {
        val tag = "ban-duong-v1.0.0"
        fun only(vararg a: JSONObject) = pick(releases(release(tag, assets = a.toList())))
        val apk = asset(tag, "ban-duong.apk", 1000)
        val man = asset(tag, "update.json", 300)
        assertNotNull(only(apk, man, asset(tag, "notes.txt", 5)))
        assertNull(only(apk))
        assertNull(only(man))
        assertNull(only(asset(tag, "ban-duong.apk", 1000, state = "starter"), man))
        assertNull(only(asset(tag, "ban-duong.apk", 1000, url = "https://evil.example/ban-duong.apk"), man))
        assertNull(only(asset(tag, "ban-duong.apk", 1000, url = dl("ban-duong-v0.9.0", "ban-duong.apk")), man))
        assertNull(only(asset(tag, "ban-duong.apk", 1000, url = "https://github.com/evil/9router/releases/download/$tag/ban-duong.apk"), man))
        assertNull(only(apk, asset(tag, "update.json", 300, url = "http://github.com/$REPO/releases/download/$tag/update.json")))
        assertNull("APK quá 80 MiB", only(asset(tag, "ban-duong.apk", ReleaseSelector.MAX_APK_BYTES + 1), man))
        assertNull("update.json quá 16 KiB", only(apk, asset(tag, "update.json", ReleaseSelector.MAX_MANIFEST_BYTES + 1)))
    }

    @Test
    fun versionCompare() {
        val v = ReleaseSelector::parseVersion
        assertTrue(ReleaseSelector.compareVersions(v("1.10")!!, v("1.9.9")!!) > 0)
        assertEquals(0, ReleaseSelector.compareVersions(v("1.2")!!, v("1.2.0")!!))
        assertTrue(ReleaseSelector.compareVersions(v("2")!!, v("10")!!) < 0)
        assertNull(v("1.2.3.4.5"))
        assertNull(v("1.-2"))
        assertNull(v("12345"))
        assertNull(v(""))
    }

    private val cand = ReleaseCandidate("ban-duong-v1.2.0", "1.2.0", dl("ban-duong-v1.2.0", "ban-duong.apk"), 4, dl("ban-duong-v1.2.0", "update.json"))
    private val apk = byteArrayOf(1, 2, 3, 4)

    @Test
    fun manifestIsParsedAndMustMatchRelease() {
        val m = ReleaseSelector.parseManifest(manifestJson(cand.tag, 3, apk), cand)!!
        assertEquals(3L, m.versionCode)
        assertEquals("1.2.0", m.versionName)
        assertEquals(sha256Hex(apk), m.sha256)
        assertEquals(4L, m.size)
        assertEquals(26, m.minSdk)
        assertEquals("Sửa lỗi và cải thiện.", m.notes)
        // Chữ hoa trong sha256 được nhận và đổi thành chữ thường.
        assertEquals(sha256Hex(apk), ReleaseSelector.parseManifest(manifestJson(cand.tag, 3, apk, sha = sha256Hex(apk).uppercase()), cand)!!.sha256)

        val bad = listOf(
            manifestJson("ban-duong-v1.1.0", 3, apk), // thẻ khác
            manifestJson(cand.tag, 3, apk, versionName = "1.3.0"),
            manifestJson(cand.tag, 3, apk, size = 5), // khác kích thước của tệp đính kèm
            manifestJson(cand.tag, 3, apk, sha = "abc"),
            manifestJson(cand.tag, 3, apk, sha = "g".repeat(64)),
            manifestJson(cand.tag, 0, apk),
            manifestJson(cand.tag, 3, apk, minSdk = 5),
            JSONObject(manifestJson(cand.tag, 3, apk)).put("versionCode", 3.5).toString(),
            JSONObject(manifestJson(cand.tag, 3, apk)).put("versionCode", "3").toString(),
            JSONObject(manifestJson(cand.tag, 3, apk)).put("notes", 7).toString(),
            JSONObject(manifestJson(cand.tag, 3, apk)).apply { remove("sha256") }.toString(),
            "[1]",
            "{\"versionCode\":3,}",
        )
        for (b in bad) assertNull(b, ReleaseSelector.parseManifest(b, cand))
    }

    @Test
    fun acceptsExactlyWhatTheWorkflowWrites() {
        // Đầu ra của bước "Xác minh APK và viết update.json" (jq, có xuống dòng) chạy thử trên máy với bản release thật.
        val c = ReleaseCandidate("ban-duong-v1.1.0", "1.1.0", dl("ban-duong-v1.1.0", "ban-duong.apk"), 25939714, dl("ban-duong-v1.1.0", "update.json"))
        val json = """
            {
              "versionCode": 2,
              "versionName": "1.1.0",
              "sha256": "0497a2baf5f3b1b37cee5b9777176787ca4f81fa4698db3d556af273bf531090",
              "size": 25939714,
              "minSdk": 26,
              "notes": "Tự kiểm tra và cài bản mới ngay trong ứng dụng: khi có phiên bản mới sẽ hiện nút “Cập nhật”, bấm một lần là cài, không cần chép qua USB hay Zalo.",
              "tag": "ban-duong-v1.1.0"
            }
        """.trimIndent()
        val m = ReleaseSelector.parseManifest(json, c)!!
        assertEquals(2L, m.versionCode)
        assertEquals(25939714L, m.size)
        assertTrue(m.notes.startsWith("Tự kiểm tra"))
    }

    @Test
    fun notesAreSanitisedAndCapped() {
        val evil = "Bản mới‮\u0000\n<b>đậm</b>  " + "x".repeat(400)
        val m = ReleaseSelector.parseManifest(manifestJson(cand.tag, 3, apk, notes = evil), cand)!!
        assertTrue(m.notes.length <= ReleaseSelector.MAX_NOTES_CHARS)
        assertTrue(m.notes.startsWith("Bản mới <b>đậm</b> x"))
        assertTrue(m.notes.none { it.code < 0x20 || it == '‮' })
        // Quá dài (> 8 lần giới hạn) → bỏ hẳn, không lỗi.
        assertEquals("", ReleaseSelector.parseManifest(manifestJson(cand.tag, 3, apk, notes = "y".repeat(3000)), cand)!!.notes)
    }
}
