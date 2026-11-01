package com.zipper.app.util

import com.zipper.app.data.model.SupportTicket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B2 — broken screens and navigation. One test group per confirmed defect:
 * the pure rule it now follows, and a source check that the screen uses it.
 */
class BrokenScreensB2Test {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    // ── 1. Agency dashboard: a host row opens the host ───────────────────────
    @Test fun `a roster uid that fits the profile route is openable, anything else is not`() {
        assertTrue(AgencyIdentity.canOpenProfile("Xy12abcDEF"))
        assertFalse(AgencyIdentity.canOpenProfile(""))
        assertFalse(AgencyIdentity.canOpenProfile(null))
        assertFalse(AgencyIdentity.canOpenProfile("a/b"))
        assertFalse(AgencyIdentity.canOpenProfile("a b"))
        assertFalse(AgencyIdentity.canOpenProfile("a?x=1"))
    }

    @Test fun `host rows are wired to the existing PUBLIC profile route`() {
        val dash = src("ui/screens/agency/AgencyDashboardScreen.kt")
        assertTrue(dash.contains("onOpenHost: (uid: String) -> Unit = {}"))
        assertTrue(dash.contains("Modifier.clickableNoRipple { onOpenHost(host.uid) }"))
        assertTrue(dash.contains("AgencyIdentity.canOpenProfile(host.uid)"))
        val nav = src("navigation/ZipperNavGraph.kt")
        assertTrue(nav.contains("onOpenHost = { uid -> navController.navigate(Screen.UserProfile.createRoute(uid)) }"))
        // The destination reads the public projection only — no contact, no earnings.
        val vm = src("ui/screens/profile/OtherUserViewModel.kt")
        assertTrue(vm.contains("`publicProfiles`"))
        // Role visibility of the dashboard itself is unchanged.
        assertTrue(dash.contains("currentUser?.ownAgencyId"))
        assertTrue(dash.contains("takeIf { !it.isHost }?.agencyId"))
    }

    // ── 2. Messages "Feedback" tab reads the tickets the app writes ──────────
    @Test fun `a feedback ticket maps message, response and timestamps from the writer's fields`() {
        val t = SupportTicket.fromFeedbackTicket(
            id = "t1", userId = "u1", subject = "Coins", message = "Missing coins", body = null,
            status = "resolved", response = "Credited.", adminReply = null, statusMessage = null,
            createdAt = 1_000L, statusChangedAt = 5_000L,
        )
        assertEquals("Missing coins", t.body)
        assertEquals("Credited.", t.statusMessage)
        assertEquals("resolved", t.status)
        assertEquals(5_000L, t.updatedAt)

        val untouched = SupportTicket.fromFeedbackTicket(
            id = "t2", userId = "u1", subject = "", message = "", body = "old body",
            status = null, response = "", adminReply = "legacy reply", statusMessage = null,
            createdAt = 1_000L, statusChangedAt = 0L,
        )
        assertEquals("old body", untouched.body)
        assertEquals("legacy reply", untouched.statusMessage)
        assertEquals("open", untouched.status)
        assertEquals(1_000L, untouched.updatedAt)
    }

    @Test fun `the tab reads feedbackTickets by owner and createdAt, the indexed query`() {
        val repo = src("data/repository/ChatRepository.kt")
        assertTrue(repo.contains("firestore.collection(\"feedbackTickets\")"))
        assertFalse(repo.contains("firestore.collection(\"supportTickets\")"))
        val tickets = repo.substring(repo.indexOf("fun myTicketsFlow"))
        assertTrue(tickets.contains(".whereEqualTo(\"userId\", myUid)"))
        assertTrue(tickets.contains(".orderBy(\"createdAt\", Query.Direction.DESCENDING)"))
        // Same collection the Feedback screen writes.
        assertTrue(src("ui/screens/feedback/FeedbackScreen.kt").contains("firestore.collection(\"feedbackTickets\").add(data)"))
        assertTrue(src("ui/screens/messages/MessagesScreen.kt").contains("\"assigned\" -> c.currencyDiamond to \"Assigned\""))
    }

    // ── 3. The host honours a staff End / Mute ───────────────────────────────
    @Test fun `a room closed from outside ends the host's broadcast once`() {
        assertTrue(LiveModeration.closedRemotely(isLive = true, alreadyHandled = false, roomIsActive = false))
        assertFalse(LiveModeration.closedRemotely(isLive = true, alreadyHandled = true, roomIsActive = false))
        assertFalse("the host's own End already left", LiveModeration.closedRemotely(isLive = false, alreadyHandled = false, roomIsActive = false))
        assertFalse(LiveModeration.closedRemotely(isLive = true, alreadyHandled = false, roomIsActive = true))
        assertEquals("Zipper ended this live. Reason: abuse", LiveModeration.endedMessage(true, " abuse "))
        assertEquals("This live room was closed.", LiveModeration.endedMessage(false, null))
    }

    @Test fun `a staff mute holds the mic off until it is lifted`() {
        assertTrue(LiveModeration.mustForceMicOff(hostMuted = true, micOn = true))
        assertFalse(LiveModeration.mustForceMicOff(hostMuted = true, micOn = false))
        assertFalse(LiveModeration.mustForceMicOff(hostMuted = false, micOn = true))
        assertFalse(LiveModeration.mayUnmute(hostMuted = true))
        assertTrue(LiveModeration.mayUnmute(hostMuted = false))
        assertTrue(LiveModeration.mutedMessage("spam").endsWith("Reason: spam"))
    }

    @Test fun `the host screen reads the staff fields and does not overwrite a staff end`() {
        val room = src("data/model/LiveRoom.kt")
        for (f in listOf("endedByStaff", "endReason", "hostMuted", "hostMuteReason")) {
            assertTrue("LiveRoom reads $f", room.contains("doc.get") && room.contains("\"$f\""))
        }
        val vm = src("ui/screens/live/GoLiveViewModel.kt")
        assertTrue(vm.contains("LiveModeration.closedRemotely(_state.value.isLive, _state.value.endedRemotely, room.isActive)"))
        assertTrue(vm.contains("endLive(roomAlreadyClosed = true)"))
        assertTrue(vm.contains("if (!roomAlreadyClosed) {"))
        assertTrue(vm.contains("LiveModeration.mustForceMicOff(room.hostMuted, _state.value.isMicOn)"))
        assertTrue(vm.contains("LiveModeration.mayUnmute(_state.value.mutedByStaff)"))
        // The no-face auto-end now explains itself instead of dropping to setup.
        assertTrue(vm.contains("remoteEndMessage = LiveModeration.FACE_TIMEOUT_MESSAGE"))
        val screen = src("ui/screens/live/GoLiveScreen.kt")
        assertTrue(screen.contains("if (state.endedRemotely) {"))
        assertTrue(screen.contains("onLiveEnded(viewModel.sessionSummary())"))
    }

    // ── 4. Gift details: loading is not "No gifts yet" ───────────────────────
    @Test fun `gift details shows loading until the first answer`() {
        val screen = src("ui/screens/profile/GiftDetailsScreen.kt")
        assertTrue(screen.contains("if (isLoading && gifts.isEmpty()) {"))
        assertTrue(src("navigation/ZipperNavGraph.kt").contains("isLoading = giftState.isLoading,"))
    }

    // ── 5. Call history: a failed read is not an empty history ───────────────
    @Test fun `call history reports a failure with a retry`() {
        val repo = src("data/repository/CallRepository.kt")
        assertTrue(repo.contains("suspend fun loadCallHistory(myUid: String, limit: Long = 50): Result<List<CallRecord>>"))
        assertTrue(repo.contains("Result.failure(e)"))
        val vm = src("ui/screens/call/CallHistoryViewModel.kt")
        assertTrue(vm.contains("callRepo.loadCallHistory(myUid).fold("))
        assertTrue(vm.contains("error = CALL_HISTORY_LOAD_FAILED"))
        val screen = src("ui/screens/call/CallHistoryScreen.kt")
        assertTrue(screen.contains("actionLabel = \"Try again\", onAction = viewModel::load"))
    }

    // ── 6. Recharge form: the seller's name is decoded once ──────────────────
    @Test fun `seller name is taken as Navigation decoded it, and the placeholder is blank`() {
        assertEquals("50% Coins", RouteArgs.sellerName("50% Coins"))
        assertEquals("", RouteArgs.sellerName("-"))
        assertEquals("", RouteArgs.sellerName(null))
        val form = src("ui/screens/partner/RechargeRequestScreen.kt")
        assertFalse(form.contains("Uri.decode(savedStateHandle.get<String>(\"sellerName\")"))
        assertTrue(form.contains("RouteArgs.sellerName(savedStateHandle.get<String>(\"sellerName\"))"))
    }
}
