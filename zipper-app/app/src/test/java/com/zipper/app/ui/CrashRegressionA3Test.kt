package com.zipper.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A3 (3 Nov 2026) — the two crashes in the emulator's drop box.
 *
 * 1. "Failed to get document because the client is offline" (17:33:40 IST, 5 s after launch): ProfileViewModel —
 *    created by MainActivity at launch — read the users document once in each of five `init` coroutines, only to
 *    learn the uid, and nothing caught the read. Offline (or with a session the server refuses, which Firestore
 *    reports the same way) and no cached copy, the read throws and the app dies.
 *
 * 2. "Expected BringIntoViewRequester to not be used before parents are placed" (13:32:15 and 13:32:51 IST): the
 *    party-room four-digit field was a ZERO-SIZE text field. A single-line field is itself a scrolling container;
 *    measured 0×0 it cannot answer the bring-into-view a focused field sends to a scrolling parent, so tapping the
 *    digits in the create-room form or the room settings sheet (both scroll) crashed the app. The same exception
 *    is what a focus request from the composition that made the field risks; those now wait for the layout.
 *
 * Plain JVM tests — this module has no instrumented tests — so each fault is pinned on the code that caused it.
 */
class CrashRegressionA3Test {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    /** The source without comments, so a comment that names the old call does not count as the call. */
    private fun code(text: String): String =
        text.replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .lines().joinToString("\n") { line ->
                val i = line.indexOf("//")
                if (i >= 0 && !line.substring(0, i).contains("\"")) line.substring(0, i) else line
            }

    /** The body of `fun name(` — from its first `{` to the matching `}`. */
    private fun body(text: String, signature: String): String {
        val start = text.indexOf(signature)
        assertTrue("$signature is in the file", start >= 0)
        val open = text.indexOf('{', start)
        var depth = 0
        for (i in open until text.length) {
            when (text[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return text.substring(open, i + 1)
            }
        }
        error("unbalanced braces after $signature")
    }

    // ── 1. "client is offline" at launch ─────────────────────────────────────

    @Test fun `the profile view model never reads the users document to learn who is signed in`() {
        val vm = code(src("ui/screens/profile/ProfileViewModel.kt"))
        assertFalse("no one-shot users read left in ProfileViewModel", vm.contains("fetchCurrentUser("))
        assertTrue("the per-account listeners follow the signed-in uid", vm.contains("repo.signedInUidFlow().collectLatest"))
    }

    @Test fun `the signed-in uid comes from Firebase Auth on the device, not from Firestore`() {
        val repo = code(src("data/repository/ProfileRepository.kt"))
        val flow = repo.substring(repo.indexOf("fun signedInUidFlow"), repo.indexOf(".distinctUntilChanged()"))
        assertTrue(flow.contains("AuthStateListener"))
        assertFalse("no Firestore read can fail here", flow.contains("firestore"))
        assertFalse(flow.contains("await()"))
    }

    @Test fun `a sign-out or an account switch clears the last account's rows before the next account's arrive`() {
        val vm = code(src("ui/screens/profile/ProfileViewModel.kt"))
        val block = vm.substring(vm.indexOf("repo.signedInUidFlow().collectLatest"))
        val reset = block.indexOf("diamondTransactions = emptyList(), beanTransactions = emptyList()")
        val stopWhenSignedOut = block.indexOf("if (uid == null) return@collectLatest")
        val firstListener = block.indexOf("giftRepo.giftsSentFlow(uid)")
        assertTrue("the reset runs first", reset in 0 until stopWhenSignedOut)
        assertTrue("…then a signed-out state stops there", stopWhenSignedOut in 0 until firstListener)
    }

    // ── 2. BringIntoViewRequester ─────────────────────────────────────────────

    @Test fun `the party digits field is never a zero-size text field`() {
        val field = body(code(src("ui/screens/party/PartyRoomSheets.kt")), "internal fun PartyDigitsField(")
        assertFalse(field.contains("size(0.dp)"))
        assertTrue("the field lies over the boxes, at their size", field.contains("Modifier.matchParentSize().focusRequester(focus)"))
        assertTrue("…and its text and cursor do not show over them", field.contains("cursorBrush = SolidColor(Color.Transparent)"))
    }

    /** The argument list of the call whose `(` is at [open] — to its matching `)`. */
    private fun args(text: String, open: Int): String {
        var depth = 0
        for (i in open until text.length) {
            when (text[i]) {
                '(' -> depth++
                ')' -> if (--depth == 0) return text.substring(open, i + 1)
            }
        }
        return text.substring(open)
    }

    @Test fun `no text field anywhere in the app is laid out at zero size`() {
        val zero = Regex("\\.\\s*(size|requiredSize|width|height)\\(\\s*0\\s*\\.dp\\s*\\)")
        val offenders = main.walkTopDown().filter { it.extension == "kt" }.flatMap { f ->
            val text = code(f.readText())
            Regex("\\b(Basic|Outlined)?TextField\\(").findAll(text).mapNotNull { m ->
                val call = args(text, m.range.last).substringBefore("decorationBox")
                if (zero.containsMatchIn(call)) "${f.name}@${m.range.first}" else null
            }
        }.toList()
        assertEquals(emptyList<String>(), offenders)
    }

    @Test fun `no focus is requested from the composition that made the field`() {
        val offenders = main.walkTopDown().filter { it.extension == "kt" }.flatMap { f ->
            val text = code(f.readText())
            Regex("LaunchedEffect\\(").findAll(text).mapNotNull { m ->
                val open = text.indexOf('{', m.range.last)
                if (open < 0) return@mapNotNull null
                var depth = 0
                var end = open
                for (i in open until text.length) {
                    if (text[i] == '{') depth++
                    if (text[i] == '}' && --depth == 0) { end = i; break }
                }
                val effect = text.substring(open, end + 1)
                if (Regex("\\.requestFocus\\(\\)").containsMatchIn(effect)) "${f.name}@${m.range.first}" else null
            }
        }.toList()
        assertEquals("every first-composition focus request goes through requestFocusAfterLayout", emptyList<String>(), offenders)
    }

    @Test fun `requestFocusAfterLayout waits for the next frame before it asks`() {
        val helper = code(src("ui/components/Focus.kt"))
        val wait = helper.indexOf("withFrameNanos { }")
        val ask = helper.indexOf("requestFocus()")
        assertTrue(wait >= 0 && ask > wait)
        assertTrue("a field that left the composition meanwhile is not a crash either", helper.contains("runCatching { requestFocus() }"))
    }
}
