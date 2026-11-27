package vn.banduong.app.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BridgeMessageParserTest {
    private val now = 1_764_000_000_000L

    private fun state(block: JSONObject.() -> Unit = {}): JSONObject =
        JSONObject().put("v", 1).put("type", "state").put("ts", now).apply(block)

    private fun parseState(o: JSONObject): CarState {
        val r = BridgeMessageParser.parse(o.toString(), now)
        assertTrue("$r", r is ParseResult.Ok)
        return ((r as ParseResult.Ok).message as InboundMessage.State).state
    }

    private fun rejected(raw: String?): String {
        val r = BridgeMessageParser.parse(raw, now)
        assertTrue("$r", r is ParseResult.Rejected)
        return (r as ParseResult.Rejected).reason
    }

    private fun pts(n: Int) = JSONArray().apply { repeat(n) { put(JSONArray().put(10.77 + it * 1e-5).put(106.69)) } }

    @Test
    fun parsesFullState() {
        val s = parseState(state {
            put("speed", 52.4)
            put("speedSource", "obd")
            put("limit", 60)
            put("overSpeed", false)
            put("position", JSONObject().put("lat", 10.7769).put("lon", 106.7009).put("heading", 90).put("accuracy", 5))
            put("alerts", JSONArray().put(
                JSONObject().put("kind", "camera").put("code", "P.127").put("text", "Phía trước có camera phạt nguội")
                    .put("distance", 350).put("source", "osm"),
            ))
            put("maneuver", JSONObject().put("text", "Rẽ phải vào Lê Lợi").put("distance", 120.6).put("icon", "right"))
            put("route", pts(10))
            put("nearbyRoads", JSONArray().put(JSONObject().put("highway", "primary").put("points", pts(5))))
            put("camera", "running")
            put("obd", "connected")
        })
        assertEquals(now, s.ts)
        assertEquals(52.4, s.speedKmh!!, 1e-9)
        assertEquals(CarState.SpeedSource.OBD, s.speedSource)
        assertEquals(60, s.limitKmh)
        assertEquals(10.7769, s.position!!.lat, 1e-9)
        assertEquals(90.0, s.position!!.heading!!, 1e-9)
        assertEquals(1, s.alerts.size)
        assertEquals(CarState.AlertKind.CAMERA, s.alerts[0].kind)
        assertEquals("P.127", s.alerts[0].code)
        assertEquals("Phía trước có camera phạt nguội", s.alerts[0].text)
        assertEquals(350, s.alerts[0].distanceM)
        assertEquals("Rẽ phải vào Lê Lợi", s.maneuver!!.text)
        assertEquals(121, s.maneuver!!.distanceM)
        assertEquals(CarState.ManeuverIcon.RIGHT, s.maneuver!!.icon)
        assertEquals(10, s.route.size)
        assertEquals(CarState.HighwayClass.PRIMARY, s.nearbyRoads[0].highway)
        assertEquals(CarState.CameraStatus.RUNNING, s.camera)
        assertEquals(CarState.ObdStatus.CONNECTED, s.obd)
    }

    @Test
    fun parsesPositionTimeTripAndAlertId() {
        val s = parseState(state {
            put("position", JSONObject().put("lat", 10.7769).put("lon", 106.7009).put("ts", now - 1500))
            put("alerts", JSONArray()
                .put(JSONObject().put("kind", "sign").put("code", "P.127").put("text", "Tốc độ tối đa 60 km/h").put("distance", 90).put("id", "s1x9z"))
                .put(JSONObject().put("kind", "sign").put("text", "Biển khác").put("distance", 95).put("id", "có dấu cách"))
                .put(JSONObject().put("kind", "sign").put("text", "Biển nữa").put("distance", 99).put("id", 12)))
            put("maneuver", JSONObject().put("text", "Rẽ trái").put("distance", 80).put("tripDistance", 5230.4).put("tripDuration", 610.6))
        })
        assertEquals(now - 1500, s.position!!.fixTs)
        assertEquals(listOf("s1x9z", null, null), s.alerts.map { it.id })
        assertEquals(5230, s.maneuver!!.tripDistanceM)
        assertEquals(611, s.maneuver!!.tripDurationS)
        // Ngoài khoảng: null, phần còn lại vẫn nhận.
        val bad = parseState(state {
            put("position", JSONObject().put("lat", 10.0).put("lon", 106.0).put("ts", now + 25L * 3600 * 1000))
            put("maneuver", JSONObject().put("text", "Rẽ").put("distance", 10).put("tripDistance", -1).put("tripDuration", BridgeLimits.MAX_TRIP_DURATION_S + 1))
        })
        assertNull(bad.position!!.fixTs)
        assertNull(bad.maneuver!!.tripDistanceM)
        assertNull(bad.maneuver!!.tripDurationS)
        assertEquals(10.0, bad.position!!.lat, 0.0)
    }

    @Test
    fun minimalStateUsesDefaults() {
        val s = parseState(state())
        assertNull(s.speedKmh)
        assertNull(s.limitKmh)
        assertFalse(s.overSpeed)
        assertNull(s.position)
        assertTrue(s.alerts.isEmpty())
        assertNull(s.maneuver)
        assertEquals(CarState.CameraStatus.OFF, s.camera)
        assertEquals(CarState.ObdStatus.OFF, s.obd)
    }

    @Test
    fun rejectsBadEnvelope() {
        assertEquals("not-string", rejected(null))
        assertEquals("bad-json", rejected("không phải JSON"))
        assertEquals("bad-json", rejected("[1,2]"))
        assertEquals("bad-version", rejected("""{"type":"state","ts":$now}"""))
        assertEquals("bad-version", rejected("""{"v":2,"type":"state","ts":$now}"""))
        assertEquals("bad-version", rejected("""{"v":"1","type":"state","ts":$now}"""))
        assertEquals("bad-type", rejected("""{"v":1,"type":"exec","cmd":"rm"}"""))
        assertEquals("bad-type", rejected("""{"v":1}"""))
    }

    @Test
    fun rejectsOversizeAndDeepMessages() {
        val big = "{\"v\":1,\"type\":\"hello\",\"x\":\"" + "a".repeat(BridgeLimits.MAX_MESSAGE_CHARS) + "\"}"
        assertEquals("too-long", rejected(big))
        assertEquals("too-deep", rejected("{\"v\":1,\"type\":\"state\",\"x\":" + "[".repeat(50_000) + "]".repeat(50_000) + "}"))
        // Ngoặc nằm trong chuỗi không tính là lồng nhau.
        assertTrue(BridgeMessageParser.depthWithin("""{"a":"[[[[[[[[[[\"[[[["}""", 2))
        assertFalse(BridgeMessageParser.depthWithin("[[[]]]", 2))
    }

    @Test
    fun rejectsBadTimestamp() {
        assertEquals("bad-ts", rejected(JSONObject().put("v", 1).put("type", "state").toString()))
        assertEquals("bad-ts", rejected(state { put("ts", "hôm nay") }.toString()))
        assertEquals("bad-ts", rejected(state { put("ts", now + BridgeLimits.MAX_CLOCK_SKEW_MS + 1) }.toString()))
        assertEquals("bad-ts", rejected(state { put("ts", 0) }.toString()))
    }

    @Test
    fun outOfRangeNumbersBecomeNull() {
        val s = parseState(state {
            put("speed", -3)
            put("limit", 999)
            put("position", JSONObject().put("lat", 95).put("lon", 106))
        })
        assertNull(s.speedKmh)
        assertNull(s.limitKmh)
        assertNull(s.position)
        val s2 = parseState(state {
            put("speed", "50")
            put("limit", 49.6)
            put("position", JSONObject().put("lat", 10).put("lon", 106).put("heading", 400).put("accuracy", -1))
        })
        assertNull(s2.speedKmh)
        assertEquals(50, s2.limitKmh)
        assertNull(s2.position!!.heading)
        assertNull(s2.position!!.accuracy)
    }

    @Test
    fun overSpeedMustBeTrueBoolean() {
        assertFalse(parseState(state { put("overSpeed", "true") }).overSpeed)
        assertFalse(parseState(state { put("overSpeed", 1) }).overSpeed)
        assertTrue(parseState(state { put("overSpeed", true) }).overSpeed)
    }

    @Test
    fun alertsAreBoundedAndCleaned() {
        val arr = JSONArray()
        arr.put(JSONObject().put("text", "Thiếu khoảng cách")) // bỏ: thiếu distance
        arr.put(JSONObject().put("distance", 10)) // bỏ: thiếu text
        arr.put(JSONObject().put("text", "  Trạm\u0000 thu‮phí\n\nphía trước  ").put("distance", 900).put("kind", "lạ").put("code", "<script>"))
        repeat(5) { arr.put(JSONObject().put("text", "Cảnh báo $it").put("distance", it)) }
        val s = parseState(state { put("alerts", arr) })
        assertEquals(BridgeLimits.MAX_ALERTS, s.alerts.size)
        assertEquals("Trạm thuphí phía trước", s.alerts[0].text)
        assertEquals(CarState.AlertKind.OTHER, s.alerts[0].kind)
        assertNull(s.alerts[0].code)
        assertEquals(CarState.AlertSource.OSM, s.alerts[0].source)
    }

    @Test
    fun textIsTruncatedTo120WithoutSplittingSurrogates() {
        val long = "Đường ".repeat(40)
        val t = BridgeMessageParser.cleanText(long)!!
        assertTrue(t.length <= BridgeLimits.MAX_TEXT_CHARS)
        assertTrue(t.startsWith("Đường Đường"))
        val emoji = "a".repeat(119) + "🚗" + "b"
        val e = BridgeMessageParser.cleanText(emoji)!!
        assertEquals(119, e.length)
        assertNull(BridgeMessageParser.cleanText("   ​  "))
        assertNull(BridgeMessageParser.cleanText(42))
    }

    @Test
    fun routeAndRoadsAreBounded() {
        val roads = JSONArray()
        repeat(80) { roads.put(JSONObject().put("highway", "residential").put("points", pts(50))) }
        val s = parseState(state {
            put("route", pts(1000))
            put("nearbyRoads", roads)
        })
        assertEquals(BridgeLimits.MAX_ROUTE_POINTS, s.route.size)
        assertTrue(s.nearbyRoads.size <= BridgeLimits.MAX_ROADS)
        assertTrue(s.nearbyRoads.sumOf { it.points.size } <= BridgeLimits.MAX_ROAD_POINTS_TOTAL)
        assertEquals(40, s.nearbyRoads.size)
    }

    @Test
    fun invalidPointsAreDropped() {
        val route = JSONArray()
            .put(JSONArray().put(10).put(106))
            .put(JSONArray().put(91).put(106))
            .put(JSONArray().put(10).put(106).put(3))
            .put(JSONArray().put("10").put(106))
            .put(JSONObject().put("lat", 10).put("lon", 106))
            .put(JSONArray().put(-10).put(-181))
            .put(JSONArray().put(11).put(107))
        val s = parseState(state {
            put("route", route)
            put("nearbyRoads", JSONArray().put(JSONObject().put("highway", "xx").put("points", JSONArray().put(JSONArray().put(1).put(2)))))
        })
        assertEquals(listOf(CarState.LatLon(10.0, 106.0), CarState.LatLon(11.0, 107.0)), s.route)
        assertTrue("đường chỉ 1 điểm bị bỏ", s.nearbyRoads.isEmpty())
    }

    @Test
    fun controlMessages() {
        val hello = BridgeMessageParser.parse("""{"v":1,"type":"hello","webVersion":"v7"}""", now) as ParseResult.Ok
        assertEquals(InboundMessage.Hello("v7"), hello.message)
        val helloBad = BridgeMessageParser.parse("""{"v":1,"type":"hello","webVersion":"<b>"}""", now) as ParseResult.Ok
        assertEquals(InboundMessage.Hello(null), helloBad.message)
        val on = BridgeMessageParser.parse("""{"v":1,"type":"keepScreenOn","on":true}""", now) as ParseResult.Ok
        assertEquals(InboundMessage.KeepScreenOn(true), on.message)
        assertEquals("bad-on", rejected("""{"v":1,"type":"keepScreenOn","on":"yes"}"""))
    }

    @Test
    fun outboundMessagesAreVersioned() {
        val n = JSONObject(OutboundMessages.native(true, "0.1.0"))
        assertEquals(1, n.getInt("v"))
        assertEquals("native", n.getString("type"))
        assertTrue(n.getBoolean("carConnected"))
        val c = JSONObject(OutboundMessages.carConnected(false))
        assertEquals("carConnected", c.getString("type"))
        assertFalse(c.getBoolean("connected"))
    }
}
