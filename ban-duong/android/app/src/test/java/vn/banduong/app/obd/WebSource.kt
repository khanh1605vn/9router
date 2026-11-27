package vn.banduong.app.obd

import java.io.File

/** Thư mục ứng dụng web (ban-duong/), tìm ngược lên từ thư mục chạy kiểm thử (android/app). */
internal object WebSource {
    val root: File by lazy {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null && !File(dir, "js/elm327.js").isFile) dir = dir.parentFile
        checkNotNull(dir) { "Không thấy js/elm327.js phía trên ${System.getProperty("user.dir")}" }
    }

    fun read(path: String): String = File(root, path).readText(Charsets.UTF_8)
}
