package vn.banduong.app.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Danh sách lệnh được phép của máy phải đúng như js/elm327.js: so từng mẫu với tệp JS, rồi (nếu máy build có Node)
 * cho chính isAllowedCommand của JS chấm một tập lớn chuỗi thử và so với bản Kotlin.
 */
class ObdCommandsParityTest {
    private fun jsPatterns(): List<String> {
        val src = WebSource.read("js/elm327.js")
        val block = Regex("""const ALLOWED = \[([\s\S]*?)\];""").find(src)!!.groupValues[1]
        return Regex("""(?m)^\s*/(.+)/,\s*$""").findAll(block).map { it.groupValues[1] }.toList()
    }

    @Test
    fun patternsMatchElm327Js() {
        val js = jsPatterns()
        assertTrue(js.size >= 6)
        assertEquals(js, ObdCommands.ALLOWED_PATTERNS)
    }

    /** Chuỗi thử: mọi dạng ngắn quanh các mẫu, cộng chuỗi ngẫu nhiên có cả chữ thường, khoảng trắng, ký tự lạ. */
    private fun corpus(): List<String> {
        val out = LinkedHashSet<String>()
        val alpha = "0123456789ABCDEFHILPRSTVWXZ"
        for (a in alpha) for (b in alpha) for (c in listOf("") + alpha.map { it.toString() }) {
            for (pre in listOf("AT", "ATS", "ATSP", "01", "0", "")) out += "$pre$a$b$c"
        }
        val noisy = "ATZXSDPVR0123456789ABCDEFatz x\r\n\t-.:é"
        val rnd = Random(20261124)
        repeat(20_000) {
            val n = rnd.nextInt(0, 9)
            out += String(CharArray(n) { noisy[rnd.nextInt(noisy.length)] })
        }
        return out.toList()
    }

    @Test
    fun javaRegexWithJsSourcesAgrees() {
        // Cùng mẫu nguồn nhưng biên dịch bằng java.util.regex trực tiếp: các mẫu chỉ dùng cú pháp chung của hai bên.
        val res = jsPatterns().map { Regex(it) }
        for (s in corpus()) {
            val expected = res.any { it.matches(s) }
            assertEquals(s, expected, ObdCommands.isAllowedCommand(s))
        }
    }

    @Test
    fun nodeIsAllowedCommandAgrees() {
        val node = listOf("/usr/bin/node", "/usr/local/bin/node").map(::File).firstOrNull { it.canExecute() }
            ?: System.getenv("PATH").orEmpty().split(File.pathSeparator).map { File(it, "node") }.firstOrNull { it.canExecute() }
        assumeTrue("không có Node trên máy build", node != null)
        val cases = corpus()
        val input = File.createTempFile("obd-corpus", ".json")
        try {
            // JSON đơn giản: mảng chuỗi, thoát ký tự theo \uXXXX.
            input.writeText(cases.joinToString(",", "[", "]") { s -> "\"" + s.map { "\\u%04x".format(it.code) }.joinToString("") + "\"" })
            val script = """
                import { isAllowedCommand } from '${File(WebSource.root, "js/elm327.js").toURI()}';
                import { readFileSync } from 'node:fs';
                const cases = JSON.parse(readFileSync(process.argv[1], 'utf8'));
                process.stdout.write(cases.map((c) => (isAllowedCommand(c) ? '1' : '0')).join(''));
            """.trimIndent()
            val p = ProcessBuilder(node!!.path, "--input-type=module", "-e", script, input.path).redirectErrorStream(false).start()
            val out = p.inputStream.bufferedReader().readText()
            val err = p.errorStream.bufferedReader().readText()
            assertTrue("node treo", p.waitFor(60, TimeUnit.SECONDS))
            assertEquals(err, 0, p.exitValue())
            assertEquals(cases.size, out.length)
            var allowed = 0
            cases.forEachIndexed { i, s ->
                val js = out[i] == '1'
                if (js) allowed++
                assertEquals("JS và Kotlin khác nhau ở ${s.map { it.code }}", js, ObdCommands.isAllowedCommand(s))
            }
            assertTrue("tập thử phải có cả lệnh được phép", allowed > 100)
        } finally {
            input.delete()
        }
    }
}
