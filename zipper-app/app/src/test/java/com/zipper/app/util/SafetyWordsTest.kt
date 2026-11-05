package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O13 (Owner, 5 Nov 2026) — the phone holds a message back with the same words, and the same matching, as the server
 * (functions/src/safety.ts). The cases are the server's own test cases (functions/test/safety.test.js).
 */
class SafetyWordsTest {

    private val root: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "zipper-app/app/build.gradle.kts").exists() }

    private fun hits(t: String) = SafetyWords.find(t, SafetyWords.BUILT_IN)

    @Test fun `the built-in list is the server's list, word for word`() {
        val ts = File(root, "functions/src/safety.ts").readText()
        val block = ts.substringAfter("export const BUILTIN_BAD_WORDS: readonly string[] = [").substringBefore("\n]")
        val server = Regex("'([^']+)'").findAll(block).map { it.groupValues[1] }.toList()
        assertEquals(server, SafetyWords.BUILT_IN)
        assertTrue(ts.contains("export const SQUEEZE_MIN = ${SafetyWords.SQUEEZE_MIN}"))
    }

    @Test fun `catches whole words, leetspeak, repeated and spaced-out letters, squeezed long words, Hindi`() {
        assertEquals(listOf("bitch"), hits("you are a b!tch"))
        assertEquals(listOf("fuck"), hits("F U C K off"))
        assertEquals(listOf("fuck"), hits("fuuuuck"))
        assertEquals(listOf("nudes"), hits("send nudes"))
        assertTrue(hits("b.h.o.s.d.i.k.e").contains("bhosdike"))
        assertEquals(listOf("chutiya"), hits("ye chutiya hai"))
        assertEquals(listOf("चूतिया"), hits("तू चूतिया है"))
        assertEquals(listOf("boobs"), hits("sh0w b00bs"))
    }

    @Test fun `does not alarm on ordinary words`() {
        for (ok in listOf("class assessment", "Charles Dickens", "Sussex", "grandiose plans", "chutney", "cockpit view",
            "hello everyone", "nice song didi", "good night")) {
            assertEquals(ok, emptyList<String>(), hits(ok))
        }
    }

    @Test fun `every place a person types checks before sending`() {
        val app = File(root, "zipper-app/app/src/main/java/com/zipper/app/ui/screens")
        for (f in listOf("live/WatchLiveViewModel.kt", "live/GoLiveViewModel.kt", "party/PartyRoomViewModel.kt", "messages/ChatViewModel.kt")) {
            assertTrue("$f does not check the words", File(app, f).readText().contains("com.zipper.app.util.SafetyWords.allowed("))
        }
        assertFalse(SafetyWords.allowed("send nudes") && SafetyWords.currentList().isNotEmpty())
        assertTrue(SafetyWords.allowed("hello everyone"))
    }

    @Test fun `the broadcaster sends stills of their own room, and the live wall needs no other client`() {
        assertEquals("liveSnapshots/U1/R1/42.jpg", com.zipper.app.data.repository.SafetyRepository.stillPath("U1", "R1", 42))
        val vm = File(root, "zipper-app/app/src/main/java/com/zipper/app/ui/screens/live/GoLiveViewModel.kt").readText()
        assertTrue(vm.contains("startStills(roomId)"))
        assertTrue("the stills stop with the live", vm.contains("stillsJob?.cancel()"))
        val agora = File(root, "zipper-app/app/src/main/java/com/zipper/app/ui/screens/live/AgoraManager.kt").readText()
        assertTrue(agora.contains("override fun onSnapshotTaken("))
    }
}
