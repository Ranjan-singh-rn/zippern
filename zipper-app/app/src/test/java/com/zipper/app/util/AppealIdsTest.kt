package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * FX-13 (RF-19 / DUP-09) — one pending self-appeal per restriction.
 *
 * The id must be the one the device-key path (`functions/src/appealIds.ts`)
 * derives for the same restriction, or the two paths would file two appeals.
 */
class AppealIdsTest {

    @Test fun `a ban is keyed by when it was imposed`() {
        assertEquals("ban-1760000000000",
            AppealIds.restrictionKey(isSuspended = false, isBanned = true, accountState = "banned",
                suspendedAtMs = null, bannedAtMs = 1760000000000L))
    }

    @Test fun `a suspension wins over the ban flag it also sets`() {
        assertEquals("suspension-1760000000000",
            AppealIds.restrictionKey(isSuspended = true, isBanned = true, accountState = "suspended",
                suspendedAtMs = 1760000000000L, bannedAtMs = 5L))
    }

    @Test fun `no stamp still gives a stable key`() {
        assertEquals("ban", AppealIds.restrictionKey(false, true, null, null, null))
        assertEquals("restriction", AppealIds.restrictionKey(false, false, null, null, null))
    }

    @Test fun `slot 1 is the bare id, later slots are suffixed`() {
        assertEquals("self_u1_ban-1", AppealIds.selfAppealId("u1", "ban-1", 1))
        assertEquals("self_u1_ban-1_2", AppealIds.selfAppealId("u1", "ban-1", 2))
    }

    @Test fun `a pending appeal occupies its slot, a decided one does not`() {
        assertTrue(AppealIds.occupies("pending"))
        assertTrue(AppealIds.occupies(null))
        assertFalse(AppealIds.occupies("rejected"))
        assertFalse(AppealIds.occupies("upheld"))
    }

    @Test fun `the device-key path derives the same id`() {
        val ts = listOf(File("../../functions/src/appealIds.ts"), File("../functions/src/appealIds.ts"))
            .firstOrNull { it.exists() }?.readText() ?: return  // only checkable inside the monorepo
        assertTrue(ts.contains("const base = `self_\${uid}_\${restrictionKey}`"))
        assertTrue(ts.contains("return slot <= 1 ? base : `\${base}_\${slot}`"))
        assertTrue(ts.contains("const kind = suspended ? 'suspension' : banned ? 'ban' : 'restriction'"))
        assertTrue(ts.contains("return at == null ? kind : `\${kind}-\${at}`"))
        assertTrue(ts.contains("export const MAX_APPEAL_SLOTS = 50"))
    }

    @Test fun `the app files at the slot, create-only, and finds the slot before uploading`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val repo = File(main, "com/zipper/app/data/repository/AppealRepository.kt").readText()
        val fn = repo.substring(repo.indexOf("suspend fun appealMyBan("), repo.indexOf("private suspend fun freeAppealSlot("))
        val upload = fn.indexOf("ref.putFile(")
        // RC: the slot comes back as a Placement — the slot, plus the statement
        // of the decided appeal before it, for the re-appeal check.
        val slot = fn.indexOf("val placement = freeAppealSlot(uid, key) ?: return Result.AlreadyPending")
        assertTrue("the slot is chosen", slot > 0)
        assertTrue("…before any evidence upload", upload > 0 && slot < upload)
        assertTrue("the write goes to that slot", fn.contains("val slot = placement.ref"))
        // RC (confirmed): a re-appeal repeating the decided statement with no new
        // evidence is refused after the slot is known and before anything uploads.
        val reappeal = fn.indexOf("AppealStatement.REAPPEAL_NEEDS_SOMETHING_NEW")
        assertTrue("the re-appeal check sits between the slot and the upload", reappeal > slot && reappeal < upload)
        assertTrue(fn.contains("slot.set(appeal).await()"))
        assertFalse("no automatic-id add on the ordinary path", fn.contains("collection(\"appeals\").add("))
        assertEquals(AppealIds.MAX_SLOTS, 50)
    }

    // ── RC: the slot walk itself, run (not just read) ─────────────────────────
    //
    // `freeAppealSlot` used to walk the slots inline, so the only check on it
    // was the text above — which looked inside `appealMyBan` alone and so never
    // saw the automatic-id fallback (`col.document()`) that lived in
    // `freeAppealSlot` until RC removed it. The walk is `AppealIds.chooseSlot`
    // now, and these run it.

    private fun decided(statement: String, status: String = "upheld") = AppealIds.SlotRead(true, status, statement)
    private fun walk(slots: Map<Int, AppealIds.SlotRead>, reads: MutableList<Int> = mutableListOf()) =
        AppealIds.chooseSlot { n -> reads += n; slots[n] ?: AppealIds.SlotRead(exists = false) }

    @Test fun `slot walk - nothing filed yet is slot 1 with no decided statement`() {
        assertEquals(AppealIds.SlotChoice.Free(1, null), walk(emptyMap()))
    }

    @Test fun `slot walk - decided slots are stepped past, carrying the statement just before the free one`() {
        val reads = mutableListOf<Int>()
        val choice = walk(mapOf(1 to decided("first"), 2 to decided("second", "rejected")), reads)
        assertEquals(AppealIds.SlotChoice.Free(3, "second"), choice)
        assertEquals("each slot is read once, in order, and the walk stops at the free one", listOf(1, 2, 3), reads)
    }

    @Test fun `slot walk - a pending appeal stops the walk and nothing is filed`() {
        assertEquals(AppealIds.SlotChoice.Pending,
            walk(mapOf(1 to decided("first"), 2 to AppealIds.SlotRead(true, "pending", "second"))))
        // An appeal with no status is pending: the server's default for one being filed.
        assertEquals(AppealIds.SlotChoice.Pending, walk(mapOf(1 to AppealIds.SlotRead(true, null, "x"))))
    }

    @Test fun `slot walk - every slot decided means nowhere to file, never an automatic id`() {
        val reads = mutableListOf<Int>()
        val all = (1..AppealIds.MAX_SLOTS).associateWith { decided("statement $it") }
        assertEquals(AppealIds.SlotChoice.Exhausted, walk(all, reads))
        assertEquals((1..AppealIds.MAX_SLOTS).toList(), reads)
    }

    @Test fun `the repository walks the slots with chooseSlot and never makes an automatic id`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val repo = File(main, "com/zipper/app/data/repository/AppealRepository.kt").readText()
        val start = repo.indexOf("private suspend fun freeAppealSlot(")
        val walker = repo.substring(start, repo.indexOf("private suspend fun slotTaken(", start))
        assertTrue("the walk is AppealIds.chooseSlot", walker.contains("AppealIds.chooseSlot {"))
        assertTrue("every document it names is a pinned slot id",
            Regex("""\.document\(""").findAll(walker).count() ==
                Regex("""\.document\(AppealIds\.selfAppealId\(""").findAll(walker).count())
        assertFalse("no automatic id (document() with no argument)", walker.contains(".document()"))
        // Create-only: a refused write at a slot that is now taken is "already pending".
        val file = repo.substring(repo.indexOf("suspend fun appealMyBan("), start)
        assertTrue("a refused write at a taken slot is AlreadyPending", Regex(
            """PERMISSION_DENIED && slotTaken\(slot\)\)\s*\{\s*return Result\.AlreadyPending""",
        ).containsMatchIn(file))
    }
}
