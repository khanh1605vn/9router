package vn.banduong.app.car

import vn.banduong.app.bridge.CarState

/**
 * Nhận ra cảnh báo MỚI trong các ảnh chụp liên tiếp để chỉ bật thông báo một lần cho mỗi cảnh báo.
 *
 * Trang web gửi lại cùng cảnh báo nhiều lần mỗi giây với khoảng cách giảm dần. Khoá nhận diện là loại + mã + mã riêng
 * của từng điểm/biển ([CarState.Alert.id], trang web tạo từ khoá của điểm/biển), nên hai biển "Tốc độ tối đa" hay hai
 * camera cùng loại gặp liền nhau vẫn là hai cảnh báo. Trang cũ không gửi id thì dùng câu chữ, chỉ bỏ phần khoảng cách
 * ("300 m", "1,2 km"); giữ các số khác (trị số giới hạn: "60 km/h" khác "80 km/h"), và khoảng cách bỗng tăng vọt
 * (hơn [jumpM]) thì coi là một chỗ mới cùng tên.
 *
 * Cảnh báo không thấy lại trong [forgetAfterMs] thì bị quên (gặp lại sau đó sẽ báo lại). Giữa hai lần bật thông báo
 * cách nhau ít nhất [minGapMs]; cảnh báo chưa kịp báo vẫn được giữ là "mới" cho lần sau. Không phụ thuộc Android,
 * kiểm thử được bằng JVM thuần.
 */
class AlertTracker(
    private val forgetAfterMs: Long = 120_000L,
    private val minGapMs: Long = 4_000L,
    private val maxRemembered: Int = 64,
    private val jumpM: Int = 300,
) {
    private class Seen(var atMs: Long, var distanceM: Int)

    private val seen = LinkedHashMap<String, Seen>()
    private var lastShownMs = Long.MIN_VALUE

    /** Trả cảnh báo cần bật thông báo bây giờ (gần nhất trong số cảnh báo mới), hoặc null. */
    fun pick(alerts: List<CarState.Alert>, nowMs: Long): CarState.Alert? {
        val it = seen.entries.iterator()
        while (it.hasNext()) if (nowMs - it.next().value.atMs > forgetAfterMs) it.remove()

        var candidate: CarState.Alert? = null
        for (a in alerts) {
            val k = key(a)
            val s = seen[k]
            if (s != null && a.id == null && a.distanceM > s.distanceM + jumpM) seen.remove(k) // chỗ mới cùng tên
            val known = seen[k]
            if (known != null) {
                known.atMs = nowMs
                known.distanceM = a.distanceM
            } else if (candidate == null) {
                candidate = a
            }
        }
        if (candidate == null) return null
        if (lastShownMs != Long.MIN_VALUE && nowMs - lastShownMs < minGapMs) return null

        // Chỉ cảnh báo vừa báo là đã thấy; cảnh báo mới khác (ví dụ biển 60 ngay sau camera) vẫn là "mới" và được báo ở
        // lần gọi sau, khi đã qua [minGapMs], nếu vẫn còn ở phía trước.
        seen[key(candidate)] = Seen(nowMs, candidate.distanceM)
        while (seen.size > maxRemembered) seen.remove(seen.keys.first())
        lastShownMs = nowMs
        return candidate
    }

    fun reset() {
        seen.clear()
        lastShownMs = Long.MIN_VALUE
    }

    companion object {
        // Khoảng cách trong câu chữ: số + m/mét/km (không phải km/h).
        private val DISTANCE = Regex("[0-9]+(?:[.,][0-9]+)?\\s*(?:km|mét|m)(?![\\p{L}/])", RegexOption.IGNORE_CASE)
        private val SPACES = Regex("\\s+")

        fun key(a: CarState.Alert): String {
            val base = "${a.kind.key}|${a.code.orEmpty()}|"
            if (a.id != null) return "$base#${a.id}"
            return base + a.text.replace(DISTANCE, " ").replace(SPACES, " ").trim().lowercase()
        }
    }
}
