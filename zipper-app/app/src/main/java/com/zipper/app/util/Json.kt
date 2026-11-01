package com.zipper.app.util

/**
 * A small, strict JSON reader and writer for the work screens' API traffic.
 *
 * Pure Kotlin on purpose: `org.json` is an Android stub on the JVM, so anything
 * built on it cannot be unit-tested without an emulator, and the work screens'
 * mapping rules are exactly what needs testing. Values are plain Kotlin:
 *
 *   object → Map<String, Any?> (insertion-ordered)   array → List<Any?>
 *   string → String   true/false → Boolean   null → null
 *   number → Long when it is an integer that fits, else Double
 */
object Json {

    class ParseError(message: String) : IllegalArgumentException(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.ws()
        val v = p.value()
        p.ws()
        if (!p.done()) throw ParseError("Unexpected trailing content at ${p.i}")
        return v
    }

    fun write(value: Any?): String = StringBuilder().also { writeTo(it, value) }.toString()

    private fun writeTo(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Int, is Long, is Short, is Byte -> sb.append(v.toString())
            is Double -> if (v.isNaN() || v.isInfinite()) sb.append("null")
                else if (v == Math.floor(v) && kotlin.math.abs(v) < 1e15) sb.append(v.toLong().toString())
                else sb.append(v.toString())
            is Float -> writeTo(sb, v.toDouble())
            is Number -> sb.append(v.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, value) in v) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k.toString())
                    sb.append(':')
                    writeTo(sb, value)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in v) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, item)
                }
                sb.append(']')
            }
            is Array<*> -> writeTo(sb, v.toList())
            else -> quote(sb, v.toString())
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Parser(val s: String) {
        var i = 0
        fun done() = i >= s.length
        fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }
        fun fail(what: String): Nothing = throw ParseError("$what at $i")

        fun value(): Any? {
            if (done()) fail("Unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> if (c == '-' || c.isDigit()) num() else fail("Unexpected '$c'")
            }
        }

        fun lit(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) fail("Expected $word")
            i += word.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++ // {
            ws()
            if (!done() && s[i] == '}') { i++; return out }
            while (true) {
                ws()
                if (done() || s[i] != '"') fail("Expected key")
                val k = str()
                ws()
                if (done() || s[i] != ':') fail("Expected ':'")
                i++
                ws()
                out[k] = value()
                ws()
                if (done()) fail("Unterminated object")
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return out }
                    else -> fail("Expected ',' or '}'")
                }
            }
        }

        fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++ // [
            ws()
            if (!done() && s[i] == ']') { i++; return out }
            while (true) {
                ws()
                out.add(value())
                ws()
                if (done()) fail("Unterminated array")
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return out }
                    else -> fail("Expected ',' or ']'")
                }
            }
        }

        fun str(): String {
            i++ // opening quote
            val sb = StringBuilder()
            while (true) {
                if (done()) fail("Unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        if (done()) fail("Bad escape")
                        when (val e = s[i++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("Bad unicode escape")
                                sb.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> fail("Bad escape '\\$e'")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        fun num(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && s[i].isDigit()) i++
            var isInt = true
            if (i < s.length && s[i] == '.') { isInt = false; i++; while (i < s.length && s[i].isDigit()) i++ }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                isInt = false; i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i].isDigit()) i++
            }
            val text = s.substring(start, i)
            if (text == "-" || text.isEmpty()) fail("Bad number")
            if (isInt) text.toLongOrNull()?.let { return it }
            return text.toDoubleOrNull() ?: fail("Bad number")
        }
    }
}

// ── Reading values out of parsed JSON ──────────────────────────────────────────

/** `a.b.0.c` — map keys and list indexes. Null when any step is missing. */
fun Any?.jsonPath(path: String): Any? {
    if (path.isEmpty()) return this
    var cur: Any? = this
    for (part in path.split('.')) {
        cur = when (cur) {
            is Map<*, *> -> cur[part]
            is List<*> -> part.toIntOrNull()?.let { cur.getOrNull(it) }
            else -> return null
        }
    }
    return cur
}

@Suppress("UNCHECKED_CAST")
fun Any?.jsonMap(): Map<String, Any?>? = this as? Map<String, Any?>

fun Any?.jsonList(): List<Any?>? = this as? List<Any?>

/** A scalar as display text; maps and lists are not text. */
fun Any?.jsonText(): String? = when (this) {
    null -> null
    is String -> this
    is Boolean -> if (this) "Yes" else "No"
    is Long, is Int -> this.toString()
    is Double -> if (this == Math.floor(this) && kotlin.math.abs(this) < 1e15) this.toLong().toString() else this.toString()
    is Number -> this.toString()
    else -> null
}

fun Any?.jsonLong(): Long? = when (this) {
    is Long -> this
    is Int -> this.toLong()
    is Double -> this.toLong()
    is String -> this.trim().toLongOrNull()
    else -> null
}
