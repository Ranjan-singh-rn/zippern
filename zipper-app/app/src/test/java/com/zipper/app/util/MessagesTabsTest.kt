package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA (3 Nov 2026) — Messages opens where the news is, an Official notice shows
 * its reason, and an announcement shows who sent it.
 */
class MessagesTabsTest {

    @Test fun `an unread Official notice and no unread chat opens Official`() {
        assertEquals(MessagesTabs.OFFICIAL, MessagesTabs.initialTab(null, unreadOfficial = 1, unreadChats = 0))
    }

    @Test fun `otherwise Chats, as before`() {
        assertEquals(MessagesTabs.CHATS, MessagesTabs.initialTab(null, 0, 0))
        assertEquals(MessagesTabs.CHATS, MessagesTabs.initialTab(null, 0, 3))
        // Both waiting: a person's chats stay first.
        assertEquals(MessagesTabs.CHATS, MessagesTabs.initialTab(null, 2, 1))
    }

    @Test fun `a caller asking for a tab gets it, whatever is unread`() {
        assertEquals(MessagesTabs.OFFICIAL, MessagesTabs.initialTab("official", 0, 5))
        assertEquals(MessagesTabs.OFFICIAL, MessagesTabs.initialTab(" Official ", 0, 5))
        assertEquals(MessagesTabs.FEEDBACK, MessagesTabs.initialTab("feedback", 3, 0))
        assertEquals(MessagesTabs.CHATS, MessagesTabs.initialTab("chats", 3, 0))
        // Anything else is ignored, not an error.
        assertEquals(MessagesTabs.OFFICIAL, MessagesTabs.initialTab("nonsense", 1, 0))
    }

    @Test fun `the reason line - shown once, and only when there is one`() {
        assertEquals("Reason: Spam in public rooms",
            MessagesTabs.reasonLine("Your account has been banned.", "Spam in public rooms"))
        assertNull(MessagesTabs.reasonLine("Your account has been banned.", "   "))
        // The body already says it — not twice.
        assertNull(MessagesTabs.reasonLine("Banned. Reason: Spam in public rooms.", "Spam in public rooms"))
    }

    @Test fun `the sender line`() {
        assertEquals("From Zipper Team", MessagesTabs.senderLine(" Zipper Team "))
        assertNull(MessagesTabs.senderLine(""))
    }

    @Test fun `the screen, the models and the repository are wired to it`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        fun src(p: String) = File(main, "com/zipper/app/$p").readText()
        val screen = src("ui/screens/messages/MessagesScreen.kt")
        assertTrue(screen.contains("MessagesTabs.initialTab(initialTab, state.unreadOfficial, state.totalUnread)"))
        // E2E re-run (3 Nov 2026): the chats arrived first and the tab was decided with no notice
        // counted. The first tab now waits for both lists.
        assertTrue(screen.contains("LaunchedEffect(state.isLoading, state.notificationsLoaded) {"))
        assertTrue(screen.contains("if (!state.isLoading && state.notificationsLoaded && tab < 0) {"))
        val vm = src("ui/screens/messages/MessagesViewModel.kt")
        assertTrue(vm.contains("_state.update { it.copy(notifications = notifications, notificationsLoaded = true) }"))
        assertTrue(screen.contains("MessagesTabs.reasonLine(n.body, n.reason)"))
        assertTrue(screen.contains("MessagesTabs.senderLine(b.senderName)"))
        // The old hard-coded first tab is gone.
        assertTrue(!screen.contains("mutableIntStateOf(2)"))
        val repo = src("data/repository/ChatRepository.kt")
        assertTrue(repo.contains("doc.getString(\"senderName\")"))
        assertTrue(repo.contains("doc.getString(\"reason\")"))
    }
}
