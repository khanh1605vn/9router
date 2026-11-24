package vn.banduong.app.bridge

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import vn.banduong.app.obd.ObdCommands
import vn.banduong.app.obd.ObdController
import vn.banduong.app.obd.ObdKind
import vn.banduong.app.bridge.BridgeLimits as L

/** Thông điệp trang web gửi sang đã qua kiểm tra. Chỉ có đúng các loại dưới đây; loại khác bị bỏ. */
sealed interface InboundMessage {
    /** Trang vừa nạp xong cầu nối; phía máy trả lời bằng trạng thái hiện tại (carConnected…). */
    data class Hello(val webVersion: String?) : InboundMessage

    data class State(val state: CarState) : InboundMessage

    /** Giữ màn hình sáng (thay cho Screen Wake Lock, WebView không hỗ trợ). */
    data class KeepScreenOn(val on: Boolean) : InboundMessage

    /** Mở hộp chọn bộ OBD của máy (js/obdnative.js). */
    data class ObdPick(val req: Int, val kind: ObdKind, val all: Boolean) : InboundMessage

    /** Mở kết nối tới thiết bị của mã link do máy cấp. */
    data class ObdConnect(val link: String) : InboundMessage

    /** Ghi một lệnh ELM327 đã đóng khung (lệnh được phép + CR, 'X', hoặc CR sau 'X'). */
    data class ObdWrite(val link: String, val data: String) : InboundMessage

    data class ObdDisconnect(val link: String) : InboundMessage
}

sealed interface ParseResult {
    data class Ok(val message: InboundMessage) : ParseResult
    data class Rejected(val reason: String) : ParseResult
}

/**
 * Kiểm tra và đọc thông điệp từ JavaScript. Không tin bất cứ thứ gì: giới hạn độ dài trước khi phân tích,
 * giới hạn độ sâu lồng nhau (org.json đệ quy, chuỗi "[[[[…" dài có thể làm tràn ngăn xếp), kiểm tra kiểu và
 * khoảng giá trị từng trường, cắt bớt danh sách quá dài.
 */
object BridgeMessageParser {
    const val MAX_DEPTH = 6

    private val CODE_RE = Regex("^[A-Za-z0-9._:-]{1,${L.MAX_CODE_CHARS}}$")
    private val VERSION_RE = Regex("^[A-Za-z0-9._-]{1,32}$")

    fun parse(raw: String?, nowMs: Long): ParseResult {
        if (raw == null) return ParseResult.Rejected("not-string")
        if (raw.length > L.MAX_MESSAGE_CHARS) return ParseResult.Rejected("too-long")
        prescan(raw, MAX_DEPTH)?.let { return ParseResult.Rejected(it) }
        val obj = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            return ParseResult.Rejected("bad-json")
        } catch (_: RuntimeException) {
            return ParseResult.Rejected("bad-json")
        } catch (_: StackOverflowError) {
            // Lớp phòng thủ cuối: prescan đã chặn lồng sâu, nhưng không để lỗi này thoát ra luồng chính.
            return ParseResult.Rejected("bad-json")
        }
        val v = obj.opt("v")
        if (v !is Number || !isInteger(v) || v.toInt() != L.PROTOCOL_VERSION) return ParseResult.Rejected("bad-version")
        return when (obj.opt("type")) {
            "hello" -> {
                val wv = (obj.opt("webVersion") as? String)?.takeIf { VERSION_RE.matches(it) }
                ParseResult.Ok(InboundMessage.Hello(wv))
            }
            "keepScreenOn" -> {
                val on = obj.opt("on") as? Boolean ?: return ParseResult.Rejected("bad-on")
                ParseResult.Ok(InboundMessage.KeepScreenOn(on))
            }
            "state" -> parseState(obj, nowMs)
            "obdPick" -> {
                val req = obj.opt("req")
                if (req !is Number || !isInteger(req) || req.toDouble() < 1 || req.toDouble() > L.MAX_OBD_REQ) {
                    return ParseResult.Rejected("bad-req")
                }
                val kind = ObdKind.of(obj.opt("kind")) ?: return ParseResult.Rejected("bad-kind")
                val all = when (val a = obj.opt("all")) {
                    null -> false
                    is Boolean -> a
                    else -> return ParseResult.Rejected("bad-all")
                }
                ParseResult.Ok(InboundMessage.ObdPick(req.toInt(), kind, all))
            }
            "obdConnect" -> link(obj)?.let { ParseResult.Ok(InboundMessage.ObdConnect(it)) } ?: ParseResult.Rejected("bad-link")
            "obdDisconnect" -> link(obj)?.let { ParseResult.Ok(InboundMessage.ObdDisconnect(it)) } ?: ParseResult.Rejected("bad-link")
            "obdWrite" -> {
                val link = link(obj) ?: return ParseResult.Rejected("bad-link")
                val data = obj.opt("data") as? String
                // Phòng thủ hai lớp: ở đây chỉ nhận khung lệnh được phép (hoặc CR riêng); ObdWriteGuard xét thêm thứ tự.
                if (data == null || !(ObdCommands.isAllowedFrame(data) || data == "\r")) return ParseResult.Rejected("bad-command")
                ParseResult.Ok(InboundMessage.ObdWrite(link, data))
            }
            else -> ParseResult.Rejected("bad-type")
        }
    }

    private fun link(o: JSONObject): String? = (o.opt("link") as? String)?.takeIf { ObdController.TOKEN_RE.matches(it) }

    private fun parseState(o: JSONObject, nowMs: Long): ParseResult {
        val tsRaw = o.opt("ts")
        if (tsRaw !is Number || !finite(tsRaw)) return ParseResult.Rejected("bad-ts")
        val ts = tsRaw.toDouble()
        if (ts < (nowMs - L.MAX_CLOCK_SKEW_MS).toDouble() || ts > (nowMs + L.MAX_CLOCK_SKEW_MS).toDouble()) {
            return ParseResult.Rejected("bad-ts")
        }
        val state = CarState(
            ts = ts.toLong(),
            speedKmh = num(o, "speed", 0.0, L.MAX_SPEED_KMH),
            speedSource = enumOf(o.opt("speedSource"), CarState.SpeedSource.entries) { it.key },
            limitKmh = num(o, "limit", L.MIN_LIMIT_KMH.toDouble(), L.MAX_LIMIT_KMH.toDouble())?.let { Math.round(it).toInt() },
            overSpeed = o.opt("overSpeed") == true,
            position = (o.opt("position") as? JSONObject)?.let { position(it, nowMs) },
            alerts = alerts(o.opt("alerts")),
            maneuver = (o.opt("maneuver") as? JSONObject)?.let(::maneuver),
            route = points(o.opt("route"), L.MAX_ROUTE_POINTS),
            nearbyRoads = roads(o.opt("nearbyRoads")),
            camera = enumOf(o.opt("camera"), CarState.CameraStatus.entries) { it.key } ?: CarState.CameraStatus.OFF,
            obd = enumOf(o.opt("obd"), CarState.ObdStatus.entries) { it.key } ?: CarState.ObdStatus.OFF,
        )
        return ParseResult.Ok(InboundMessage.State(state))
    }

    private fun position(p: JSONObject, nowMs: Long): CarState.Position? {
        val lat = num(p, "lat", -90.0, 90.0) ?: return null
        val lon = num(p, "lon", -180.0, 180.0) ?: return null
        val heading = num(p, "heading", 0.0, 360.0)
        val accuracy = num(p, "accuracy", 0.0, L.MAX_ACCURACY_M)
        val fixTs = num(p, "ts", (nowMs - L.MAX_CLOCK_SKEW_MS).toDouble(), (nowMs + L.MAX_CLOCK_SKEW_MS).toDouble())?.toLong()
        return CarState.Position(lat, lon, heading, accuracy, fixTs)
    }

    private fun alerts(raw: Any?): List<CarState.Alert> {
        val arr = raw as? JSONArray ?: return emptyList()
        val out = ArrayList<CarState.Alert>(L.MAX_ALERTS)
        for (i in 0 until arr.length()) {
            if (out.size >= L.MAX_ALERTS) break
            val a = arr.opt(i) as? JSONObject ?: continue
            val text = cleanText(a.opt("text")) ?: continue
            val dist = num(a, "distance", 0.0, L.MAX_ALERT_DISTANCE_M.toDouble()) ?: continue
            out += CarState.Alert(
                kind = enumOf(a.opt("kind"), CarState.AlertKind.entries) { it.key } ?: CarState.AlertKind.OTHER,
                code = (a.opt("code") as? String)?.takeIf { CODE_RE.matches(it) },
                text = text,
                distanceM = Math.round(dist).toInt(),
                source = enumOf(a.opt("source"), CarState.AlertSource.entries) { it.key } ?: CarState.AlertSource.OSM,
                id = (a.opt("id") as? String)?.takeIf { CODE_RE.matches(it) },
            )
        }
        return out
    }

    private fun maneuver(m: JSONObject): CarState.Maneuver? {
        val text = cleanText(m.opt("text")) ?: return null
        val dist = num(m, "distance", 0.0, L.MAX_MANEUVER_DISTANCE_M.toDouble()) ?: return null
        val icon = enumOf(m.opt("icon"), CarState.ManeuverIcon.entries) { it.key }
        val exit = num(m, "exit", 0.0, L.MAX_ROUNDABOUT_EXIT.toDouble())?.let { Math.round(it).toInt() }
        val tripDist = num(m, "tripDistance", 0.0, L.MAX_MANEUVER_DISTANCE_M.toDouble())?.let { Math.round(it).toInt() }
        val tripDur = num(m, "tripDuration", 0.0, L.MAX_TRIP_DURATION_S.toDouble())?.let { Math.round(it).toInt() }
        return CarState.Maneuver(text, Math.round(dist).toInt(), icon, exit, tripDist, tripDur)
    }

    private fun roads(raw: Any?): List<CarState.Road> {
        val arr = raw as? JSONArray ?: return emptyList()
        val out = ArrayList<CarState.Road>()
        var budget = L.MAX_ROAD_POINTS_TOTAL
        for (i in 0 until arr.length()) {
            if (out.size >= L.MAX_ROADS || budget < 2) break
            val r = arr.opt(i) as? JSONObject ?: continue
            val pts = points(r.opt("points"), minOf(L.MAX_ROAD_POINTS, budget))
            if (pts.size < 2) continue
            budget -= pts.size
            val hw = enumOf(r.opt("highway"), CarState.HighwayClass.entries) { it.key } ?: CarState.HighwayClass.OTHER
            out += CarState.Road(hw, pts)
        }
        return out
    }

    /** Danh sách điểm [[lat, lon], …]; điểm sai bị bỏ, quá [max] điểm thì cắt. */
    private fun points(raw: Any?, max: Int): List<CarState.LatLon> {
        val arr = raw as? JSONArray ?: return emptyList()
        val out = ArrayList<CarState.LatLon>(minOf(arr.length(), max))
        for (i in 0 until arr.length()) {
            if (out.size >= max) break
            val p = arr.opt(i) as? JSONArray ?: continue
            if (p.length() != 2) continue
            val lat = p.opt(0) as? Number ?: continue
            val lon = p.opt(1) as? Number ?: continue
            val la = lat.toDouble()
            val lo = lon.toDouble()
            if (!la.isFinite() || !lo.isFinite() || la < -90 || la > 90 || lo < -180 || lo > 180) continue
            out += CarState.LatLon(la, lo)
        }
        return out
    }

    private fun num(o: JSONObject, key: String, min: Double, max: Double): Double? {
        val v = o.opt(key) as? Number ?: return null
        val d = v.toDouble()
        return if (d.isFinite() && d >= min && d <= max) d else null
    }

    private inline fun <E> enumOf(raw: Any?, values: List<E>, key: (E) -> String): E? {
        val s = raw as? String ?: return null
        return values.firstOrNull { key(it) == s }
    }

    /**
     * Chuỗi hiển thị trên màn hình xe: bỏ ký tự điều khiển và ký tự đổi hướng chữ (bidi), gộp khoảng trắng,
     * cắt còn [BridgeLimits.MAX_TEXT_CHARS] ký tự (không cắt đôi cặp surrogate). Rỗng thì trả null.
     */
    fun cleanText(raw: Any?): String? {
        val s = raw as? String ?: return null
        if (s.length > L.MAX_TEXT_CHARS * 8) return null
        val sb = StringBuilder(minOf(s.length, L.MAX_TEXT_CHARS))
        var lastSpace = true
        for (ch in s) {
            val c = ch.code
            val drop = c < 0x20 || c in 0x7F..0x9F || c in 0x200B..0x200F || c in 0x202A..0x202E ||
                c in 0x2066..0x2069 || c == 0xFEFF
            if (drop) {
                if (c == 0x09 || c == 0x0A || c == 0x0D) {
                    if (!lastSpace) { sb.append(' '); lastSpace = true }
                }
                continue
            }
            if (Character.isWhitespace(ch)) {
                if (!lastSpace) { sb.append(' '); lastSpace = true }
                continue
            }
            sb.append(ch)
            lastSpace = false
        }
        var t = sb.toString().trim()
        if (t.length > L.MAX_TEXT_CHARS) {
            var end = L.MAX_TEXT_CHARS
            if (Character.isHighSurrogate(t[end - 1])) end--
            t = t.substring(0, end).trimEnd()
        }
        return t.ifEmpty { null }
    }

    /**
     * Soát trước khi đưa cho org.json, chỉ nhận JSON chặt (RFC 8259, đúng kiểu JSON.stringify của trang): trả lý do bị
     * bỏ, hoặc null nếu được. org.json của Android dễ dãi (nhận chú thích / * * /, //, #, chuỗi trong dấu ', chữ không
     * ngoặc, và dấu " nằm giữa một chữ như `n"` là ký tự thường), nên bộ đếm độ sâu chỉ đúng nếu ta đọc theo đúng ngữ
     * pháp: đây là bộ đọc ngữ pháp JSON đầy đủ (theo vị trí của từng token, có ngăn xếp riêng tối đa [maxDepth] tầng),
     * không phải đếm ký tự. Chuỗi chỉ mở ở chỗ cần một giá trị hay một khoá; chữ phải đúng là true/false/null; số đúng
     * dạng JSON; sau mỗi giá trị chỉ có khoảng trắng, `,` `]` `}` hoặc hết. JSON chặt là tập con của thứ org.json nhận,
     * và ranh giới token của hai bên trùng nhau, nên độ sâu ta đếm là độ sâu org.json sẽ đệ quy.
     */
    fun prescan(s: String, maxDepth: Int): String? {
        // isObject[d]: tầng d là { (true) hay [ (false).
        val isObject = BooleanArray(maxDepth + 1)
        var depth = 0
        var st = S_VALUE
        var i = 0
        val n = s.length
        while (true) {
            while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
            if (i >= n) return if (st == S_AFTER && depth == 0) null else "bad-json"
            val ch = s[i]
            when (st) {
                S_VALUE, S_VALUE_OR_CLOSE -> {
                    if (ch == ']' && st == S_VALUE_OR_CLOSE) {
                        depth--; i++; st = S_AFTER
                        continue
                    }
                    when {
                        ch == '{' || ch == '[' -> {
                            if (++depth > maxDepth) return "too-deep"
                            isObject[depth] = ch == '{'
                            i++
                            st = if (ch == '{') S_KEY_OR_CLOSE else S_VALUE_OR_CLOSE
                        }
                        ch == '"' -> { i = endOfString(s, i); if (i < 0) return "bad-json"; st = S_AFTER }
                        ch == '-' || ch in '0'..'9' -> { i = endOfNumber(s, i); if (i < 0) return "bad-json"; st = S_AFTER }
                        s.startsWith("true", i) -> { i += 4; st = S_AFTER }
                        s.startsWith("false", i) -> { i += 5; st = S_AFTER }
                        s.startsWith("null", i) -> { i += 4; st = S_AFTER }
                        else -> return "bad-json"
                    }
                }
                S_KEY, S_KEY_OR_CLOSE -> when {
                    ch == '}' && st == S_KEY_OR_CLOSE -> { depth--; i++; st = S_AFTER }
                    ch == '"' -> { i = endOfString(s, i); if (i < 0) return "bad-json"; st = S_COLON }
                    else -> return "bad-json"
                }
                S_COLON -> if (ch == ':') { i++; st = S_VALUE } else return "bad-json"
                else -> { // S_AFTER: vừa hết một giá trị.
                    if (depth == 0) return "bad-json" // chỉ được một giá trị gốc
                    val obj = isObject[depth]
                    when {
                        ch == ',' -> { i++; st = if (obj) S_KEY else S_VALUE }
                        ch == '}' && obj -> { depth--; i++ }
                        ch == ']' && !obj -> { depth--; i++ }
                        else -> return "bad-json"
                    }
                }
            }
        }
    }

    private const val S_VALUE = 0 // cần một giá trị (đầu vào, sau ':' hay sau ',' trong [ ])
    private const val S_VALUE_OR_CLOSE = 1 // ngay sau '[': một giá trị hoặc ']'
    private const val S_KEY = 2 // sau ',' trong { }: một khoá
    private const val S_KEY_OR_CLOSE = 3 // ngay sau '{': một khoá hoặc '}'
    private const val S_COLON = 4 // sau khoá
    private const val S_AFTER = 5 // sau một giá trị: ',' hoặc đóng ngoặc (hoặc hết, ở tầng gốc)

    /** [i] trỏ vào '"' mở; trả chỉ số ngay sau '"' đóng, hoặc -1 nếu chuỗi sai (ký tự điều khiển, \ lạ, chưa đóng). */
    private fun endOfString(s: String, start: Int): Int {
        var i = start + 1
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> return i + 1
                c < ' ' -> return -1
                c == '\\' -> {
                    if (i + 1 >= s.length) return -1
                    when (s[i + 1]) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> i += 2
                        'u' -> {
                            if (i + 6 > s.length) return -1
                            for (k in i + 2 until i + 6) if (Character.digit(s[k], 16) < 0) return -1
                            i += 6
                        }
                        else -> return -1
                    }
                }
                else -> i++
            }
        }
        return -1
    }

    /** Số JSON: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?; trả chỉ số ngay sau số, hoặc -1. */
    private fun endOfNumber(s: String, start: Int): Int {
        var i = start
        fun digits(): Int {
            val from = i
            while (i < s.length && s[i] in '0'..'9') i++
            return i - from
        }
        if (s[i] == '-') i++
        if (i >= s.length) return -1
        if (s[i] == '0') i++ else if (digits() == 0) return -1
        if (i < s.length && s[i] == '.') { i++; if (digits() == 0) return -1 }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            if (digits() == 0) return -1
        }
        return i
    }

    /** Độ sâu lồng { [ không quá [max] và đúng dạng JSON chặt (xem [prescan]). */
    fun depthWithin(s: String, max: Int): Boolean = prescan(s, max) == null

    private fun finite(n: Number) = n.toDouble().isFinite()

    private fun isInteger(n: Number): Boolean {
        val d = n.toDouble()
        return d.isFinite() && d == Math.floor(d)
    }
}

/** Thông điệp phía máy gửi sang trang web (luôn là chuỗi JSON nhỏ, do máy tự tạo). */
object OutboundMessages {
    fun native(carConnected: Boolean, appVersion: String): String = JSONObject()
        .put("v", L.PROTOCOL_VERSION)
        .put("type", "native")
        .put("carConnected", carConnected)
        .put("appVersion", appVersion)
        .toString()

    fun carConnected(connected: Boolean): String = JSONObject()
        .put("v", L.PROTOCOL_VERSION)
        .put("type", "carConnected")
        .put("connected", connected)
        .toString()
}
