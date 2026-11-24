package vn.banduong.app.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.random.Random

/**
 * Kiểm thử kiểu "fuzz": bảng các thông điệp sai phải bị bỏ đúng lý do, và hàng nghìn thông điệp ngẫu nhiên
 * (đột biến từ thông điệp đúng, hoặc trường có kiểu ngẫu nhiên) không bao giờ làm bộ phân tích ném lỗi, còn kết
 * quả nhận được luôn nằm trong giới hạn của BRIDGE.md.
 */
@RunWith(RobolectricTestRunner::class)
class BridgeFuzzTest {
    private val now = 1_764_000_000_000L

    private val valid = JSONObject()
        .put("v", 1).put("type", "state").put("ts", now).put("speed", 52.4).put("speedSource", "gps")
        .put("limit", 60).put("overSpeed", false)
        .put("position", JSONObject().put("lat", 10.7769).put("lon", 106.7009).put("heading", 92.5).put("accuracy", 6))
        .put("alerts", JSONArray().put(JSONObject().put("kind", "camera").put("code", "speed_camera").put("text", "Camera phạt nguội").put("distance", 300).put("source", "osm")))
        .put("maneuver", JSONObject().put("text", "Rẽ phải vào đường Lê Lợi").put("distance", 120).put("icon", "right").put("exit", JSONObject.NULL))
        .put("route", JSONArray().put(JSONArray().put(10.7769).put(106.7009)).put(JSONArray().put(10.77721).put(106.70135)))
        .put("nearbyRoads", JSONArray().put(JSONObject().put("highway", "primary").put("points", JSONArray().put(JSONArray().put(10.7765).put(106.7001)).put(JSONArray().put(10.7771).put(106.7012)))))
        .put("camera", "off").put("obd", "connected")
        .toString()

    @Test
    fun rejectionTable() {
        val cases = listOf(
            null to "not-string",
            "" to "bad-json",
            "[]" to "bad-json",
            "\"state\"" to "bad-json",
            "{" to "bad-json",
            "{\"type\":\"hello\"}" to "bad-version",
            "{\"v\":\"1\",\"type\":\"hello\"}" to "bad-version",
            "{\"v\":1.5,\"type\":\"hello\"}" to "bad-version",
            "{\"v\":2,\"type\":\"hello\"}" to "bad-version",
            "{\"v\":true,\"type\":\"hello\"}" to "bad-version",
            "{\"v\":1}" to "bad-type",
            "{\"v\":1,\"type\":\"HELLO\"}" to "bad-type",
            "{\"v\":1,\"type\":\"openUrl\",\"url\":\"https://example.com\"}" to "bad-type",
            "{\"v\":1,\"type\":\"speak\",\"text\":\"xin chào\"}" to "bad-type",
            "{\"v\":1,\"type\":[\"state\"]}" to "bad-type",
            "{\"v\":1,\"type\":\"keepScreenOn\"}" to "bad-on",
            "{\"v\":1,\"type\":\"keepScreenOn\",\"on\":\"true\"}" to "bad-on",
            "{\"v\":1,\"type\":\"keepScreenOn\",\"on\":1}" to "bad-on",
            "{\"v\":1,\"type\":\"state\"}" to "bad-ts",
            "{\"v\":1,\"type\":\"state\",\"ts\":\"$now\"}" to "bad-ts",
            "{\"v\":1,\"type\":\"state\",\"ts\":0}" to "bad-ts",
            "{\"v\":1,\"type\":\"state\",\"ts\":-1}" to "bad-ts",
            "{\"v\":1,\"type\":\"state\",\"ts\":1e400}" to "bad-json", // org.json của Android từ chối số vô hạn
            "{\"v\":1,\"type\":\"state\",\"ts\":${now + 25L * 3600 * 1000}}" to "bad-ts",
            "{\"v\":1,\"type\":\"state\",\"ts\":${now - 25L * 3600 * 1000}}" to "bad-ts",
            "[[[[[[[[1]]]]]]]]" to "too-deep",
            "{\"v\":1,\"type\":\"state\",\"ts\":$now,\"a\":[[[[[[1]]]]]]}" to "too-deep",
            "x".repeat(BridgeLimits.MAX_MESSAGE_CHARS + 1) to "too-long",
        )
        for ((raw, reason) in cases) {
            val r = BridgeMessageParser.parse(raw, now)
            assertTrue("phải bỏ: ${raw?.take(60)} → $r", r is ParseResult.Rejected)
            assertEquals("lý do cho ${raw?.take(60)}", reason, (r as ParseResult.Rejected).reason)
        }
    }

    @Test
    fun fieldTableBecomesNullOrDefault() {
        // (trường, giá trị sai) → trường đó về null/mặc định, thông điệp vẫn được nhận.
        val bad = listOf<Pair<String, Any>>(
            "speed" to -0.1, "speed" to 400.01, "speed" to "50", "speed" to true, "speed" to JSONArray(),
            "limit" to 4, "limit" to 201, "limit" to "60", "limit" to JSONObject(),
            "speedSource" to "GPS", "speedSource" to 1,
            "overSpeed" to "true", "overSpeed" to 1,
            "position" to "10,106", "position" to JSONObject().put("lat", 91).put("lon", 0),
            "position" to JSONObject().put("lat", 0).put("lon", 180.5),
            "alerts" to "camera", "alerts" to JSONArray().put("x").put(1).put(JSONObject()),
            "maneuver" to JSONObject().put("text", "").put("distance", 10),
            "maneuver" to JSONObject().put("text", "Rẽ").put("distance", -1),
            "maneuver" to JSONObject().put("text", "Rẽ").put("distance", 1_000_001),
            "route" to JSONArray().put(JSONArray().put(10.0)).put(JSONArray().put("10").put("106")),
            "nearbyRoads" to JSONArray().put(JSONObject().put("highway", "primary").put("points", JSONArray().put(JSONArray().put(10.0).put(106.0)))),
            "camera" to "on", "obd" to 3,
        )
        for ((key, value) in bad) {
            val raw = JSONObject().put("v", 1).put("type", "state").put("ts", now).put(key, value).toString()
            val r = BridgeMessageParser.parse(raw, now)
            assertTrue("$key=$value phải vẫn được nhận: $r", r is ParseResult.Ok)
            val s = ((r as ParseResult.Ok).message as InboundMessage.State).state
            when (key) {
                "speed" -> assertEquals(null, s.speedKmh)
                "limit" -> assertEquals(null, s.limitKmh)
                "speedSource" -> assertEquals(null, s.speedSource)
                "overSpeed" -> assertEquals(false, s.overSpeed)
                "position" -> assertEquals(null, s.position)
                "alerts" -> assertTrue(s.alerts.isEmpty())
                "maneuver" -> assertEquals(null, s.maneuver)
                "route" -> assertTrue(s.route.isEmpty())
                "nearbyRoads" -> assertTrue(s.nearbyRoads.isEmpty())
                "camera" -> assertEquals(CarState.CameraStatus.OFF, s.camera)
                "obd" -> assertEquals(CarState.ObdStatus.OFF, s.obd)
            }
        }
    }

    @Test
    fun randomMutationsNeverThrowAndStayBounded() {
        val rnd = Random(20261124)
        val alphabet = "{}[]\",:0123456789.-eE truefalsnul\\u00e9ẠĐ‮\u0000"
        var accepted = 0
        repeat(4000) {
            val sb = StringBuilder(valid)
            repeat(1 + rnd.nextInt(6)) {
                val pos = if (sb.isEmpty()) 0 else rnd.nextInt(sb.length)
                when (rnd.nextInt(3)) {
                    0 -> if (sb.isNotEmpty()) sb.deleteCharAt(pos)
                    1 -> sb.insert(pos, alphabet[rnd.nextInt(alphabet.length)])
                    else -> if (sb.isNotEmpty()) sb.setCharAt(pos, alphabet[rnd.nextInt(alphabet.length)])
                }
            }
            val r = parseNoThrow(sb.toString())
            if (r is ParseResult.Ok) {
                accepted++
                (r.message as? InboundMessage.State)?.let { checkBounds(it.state) }
            }
        }
        assertTrue("phải có một phần đột biến vẫn hợp lệ", accepted > 0)
    }

    @Test
    fun randomlyTypedFieldsNeverThrowAndStayBounded() {
        val rnd = Random(7)
        fun anyValue(depth: Int): Any = when (rnd.nextInt(if (depth > 2) 6 else 8)) {
            0 -> JSONObject.NULL
            1 -> rnd.nextBoolean()
            2 -> rnd.nextDouble(-1e6, 1e6)
            3 -> rnd.nextInt(-500, 500)
            4 -> listOf("", "gps", "camera", "right", "primary", "x".repeat(rnd.nextInt(0, 1200)), "‮a\u0007b")[rnd.nextInt(7)]
            5 -> listOf(Double.MAX_VALUE, -0.0, 1e-300, Long.MAX_VALUE, 360.0, 90.0, -180.0)[rnd.nextInt(7)]
            6 -> JSONArray().apply { repeat(rnd.nextInt(0, 5)) { put(anyValue(depth + 1)) } }
            else -> JSONObject().apply { repeat(rnd.nextInt(0, 5)) { put(listOf("lat", "lon", "text", "distance", "icon", "points", "highway", "kind")[rnd.nextInt(8)], anyValue(depth + 1)) } }
        }
        val keys = listOf("speed", "speedSource", "limit", "overSpeed", "position", "alerts", "maneuver", "route", "nearbyRoads", "camera", "obd")
        repeat(3000) {
            val o = JSONObject().put("v", 1).put("type", "state").put("ts", now)
            for (k in keys) if (rnd.nextBoolean()) o.put(k, anyValue(0))
            val r = parseNoThrow(o.toString())
            if (r is ParseResult.Ok) (r.message as? InboundMessage.State)?.let { checkBounds(it.state) }
        }
    }

    @Test
    fun oversizedListsAreCut() {
        val pt = JSONArray().put(10.7).put(106.7)
        val road = JSONObject().put("highway", "residential").put("points", JSONArray().apply { repeat(50) { put(pt) } })
        val o = JSONObject().put("v", 1).put("type", "state").put("ts", now)
            .put("route", JSONArray().apply { repeat(1000) { put(pt) } })
            .put("nearbyRoads", JSONArray().apply { repeat(100) { put(road) } })
            .put("alerts", JSONArray().apply { repeat(10) { put(JSONObject().put("text", "Biển $it").put("distance", it * 10)) } })
        val s = ((BridgeMessageParser.parse(o.toString(), now) as ParseResult.Ok).message as InboundMessage.State).state
        assertEquals(BridgeLimits.MAX_ROUTE_POINTS, s.route.size)
        assertEquals(40, s.nearbyRoads.size) // 40 × 50 = 2 000 điểm: hết hạn mức tổng trước khi hết 60 đường
        assertEquals(BridgeLimits.MAX_ROAD_POINTS_TOTAL, s.nearbyRoads.sumOf { it.points.size })
        assertEquals(listOf("Biển 0", "Biển 1", "Biển 2"), s.alerts.map { it.text })
    }

    /**
     * org.json của Android nhận chú thích và chuỗi '…': dấu ngoặc giấu trong đó từng làm bộ đếm độ sâu sai (âm, hoặc
     * tưởng đang trong chuỗi "…"), để lọt hàng chục nghìn tầng "[" làm tràn ngăn xếp. Nay mọi dạng đó bị bỏ trước khi
     * tới org.json, và cả khi lọt thì StackOverflowError cũng không thoát ra (chạy trên luồng 8 MB như luồng chính).
     */
    @Test
    fun hiddenBracketsCannotBypassDepthGuard() {
        val n = 60_000
        val deep = "[".repeat(n)
        val cases = listOf(
            "{\"v\":1,\"type\":\"hello\",\"x\":/*" + "]".repeat(n) + "*/" + deep + "}" to "bad-json",
            "{\"v\":1,\"type\":\"hello\",'y':'" + "]".repeat(n) + "',\"x\":" + deep + "}" to "bad-json",
            "{'a':'\"',\"b\":" + deep + "]".repeat(n) + ",\"c\":\"\"}" to "bad-json",
            "{\"v\":1,\"type\":\"hello\"} // " + deep to "bad-json",
            "{\"v\":1,\"type\":\"hello\"} # " + deep to "bad-json",
            "]" + "]".repeat(n) + deep to "bad-json",
            "{\"v\":1,\"type\":\"hello\"}]" + "[".repeat(10) to "bad-json",
            "{\"v\":1;\"type\":\"hello\"}" to "bad-json",
            "{\"v\"=1,\"type\":\"hello\"}" to "bad-json",
            "{v:1,type:hello}" to "bad-json",
            "{\"v\":1,\"type\":\"hello\"}" + "\u0000" to "bad-json",
        )
        for ((raw, reason) in cases) {
            assertTrue(raw.length <= BridgeLimits.MAX_MESSAGE_CHARS)
            val r = onBigStack { BridgeMessageParser.parse(raw, now) }
            assertEquals("lý do cho ${raw.take(60)}", ParseResult.Rejected(reason), r)
        }
        // JSON.stringify không bao giờ sinh các ký tự trên ngoài chuỗi: thông điệp thật vẫn qua.
        assertTrue(BridgeMessageParser.parse(valid, now) is ParseResult.Ok)
        assertTrue(BridgeMessageParser.parse("{\"v\":1,\"type\":\"hello\",\"webVersion\":\"1.0.0\",\"x\":[-1.5e+3,true,false,null,\"/*'#;=\"]}", now) is ParseResult.Ok)
        assertTrue(BridgeMessageParser.parse(" {\r\n\t\"v\" : 1 , \"type\" : \"hello\" } ", now) is ParseResult.Ok)
    }

    private fun <T> onBigStack(block: () -> T): T {
        var out: Result<T>? = null
        val t = Thread(null, { out = runCatching(block) }, "bridge-8mb", 8L * 1024 * 1024)
        t.start()
        t.join()
        return out!!.getOrElse { fail("bộ phân tích ném ${it.javaClass.simpleName}"); throw it }
    }

    private fun parseNoThrow(raw: String): ParseResult = try {
        BridgeMessageParser.parse(raw, now)
    } catch (e: Throwable) {
        fail("bộ phân tích ném ${e.javaClass.simpleName} với: ${raw.take(200)}")
        throw e
    }

    private fun checkBounds(s: CarState) {
        s.speedKmh?.let { assertTrue(it in 0.0..BridgeLimits.MAX_SPEED_KMH) }
        s.limitKmh?.let { assertTrue(it in BridgeLimits.MIN_LIMIT_KMH..BridgeLimits.MAX_LIMIT_KMH) }
        s.position?.let {
            assertTrue(it.lat in -90.0..90.0 && it.lon in -180.0..180.0)
            it.heading?.let { h -> assertTrue(h in 0.0..360.0) }
            it.accuracy?.let { a -> assertTrue(a in 0.0..BridgeLimits.MAX_ACCURACY_M) }
        }
        assertTrue(s.alerts.size <= BridgeLimits.MAX_ALERTS)
        for (a in s.alerts) {
            assertTrue(a.text.isNotEmpty() && a.text.length <= BridgeLimits.MAX_TEXT_CHARS)
            assertTrue(a.text.none { it.code < 0x20 || it.code in 0x202A..0x202E })
            assertTrue(a.distanceM in 0..BridgeLimits.MAX_ALERT_DISTANCE_M)
        }
        s.maneuver?.let {
            assertTrue(it.text.isNotEmpty() && it.text.length <= BridgeLimits.MAX_TEXT_CHARS)
            assertTrue(it.distanceM in 0..BridgeLimits.MAX_MANEUVER_DISTANCE_M)
            it.exit?.let { e -> assertTrue(e in 0..BridgeLimits.MAX_ROUNDABOUT_EXIT) }
        }
        assertTrue(s.route.size <= BridgeLimits.MAX_ROUTE_POINTS)
        assertTrue(s.nearbyRoads.size <= BridgeLimits.MAX_ROADS)
        assertTrue(s.nearbyRoads.sumOf { it.points.size } <= BridgeLimits.MAX_ROAD_POINTS_TOTAL)
        assertTrue(s.nearbyRoads.all { it.points.size in 2..BridgeLimits.MAX_ROAD_POINTS })
        for (p in s.route + s.nearbyRoads.flatMap { it.points }) assertTrue(p.lat in -90.0..90.0 && p.lon in -180.0..180.0)
    }
}
