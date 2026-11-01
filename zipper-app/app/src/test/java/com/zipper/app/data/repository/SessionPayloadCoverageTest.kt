package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SESSION-001 (Phase 1A) — every callable the app makes carries the session id.
 *
 * The server is the control (`assertActiveSession` in functions/src); this pins
 * the client half so a new repository cannot quietly call a callable without
 * `SessionManager.withSession`, which would be refused once
 * ENFORCE_MOBILE_SESSION is switched on.
 */
class SessionPayloadCoverageTest {

    private val root = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }

    @Test fun `every getHttpsCallable call goes through withSession`() {
        val offenders = mutableListOf<String>()
        var callSites = 0
        root.walkTopDown().filter { it.extension == "kt" }.forEach { f ->
            val lines = f.readLines()
            lines.forEachIndexed { i, line ->
                if (line.contains("getHttpsCallable(")) {
                    callSites++
                    val window = lines.subList(i, minOf(i + 3, lines.size)).joinToString("\n")
                    if (!window.contains("withSession(")) offenders += "${f.name}:${i + 1}"
                }
            }
        }
        assertTrue("found no callables at all — the scan is broken", callSites >= 5)
        assertEquals("callables without a session id: $offenders", emptyList<String>(), offenders)
    }
}
