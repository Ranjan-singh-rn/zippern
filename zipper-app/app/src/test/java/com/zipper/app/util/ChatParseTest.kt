package com.zipper.app.util

import com.zipper.app.data.model.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Date

/**
 * O5 (5 Nov 2026) — Messages: reading chats without dropping any, "delete chat" for one person, photos and voice
 * notes, gifts in the chat (server-written only), block and report from the chat.
 */
class ChatParseTest {

    private val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "backend/app/core/deps.py").exists() }
    private fun src(rel: String) = File(repoRoot, rel).readText()

    // ── Reading the list ─────────────────────────────────────────────────────

    @Test fun `a conversation reads whatever type the time was stored as`() {
        val base = mapOf<String, Any?>("participants" to listOf("me", "you"), "otherUserName_me" to "You", "lastMessage" to "hi")
        assertEquals(1_700_000_000_000L, ChatParse.conversation("c", base + ("lastMessageAt" to 1_700_000_000_000L), "me")!!.lastMessageAt)
        assertEquals(1_700_000_000_000L, ChatParse.conversation("c", base + ("lastMessageAt" to 1.7e12), "me")!!.lastMessageAt)
        assertEquals(1_700_000_000_000L, ChatParse.conversation("c", base + ("lastMessageAt" to Date(1_700_000_000_000L)), "me")!!.lastMessageAt)
        assertEquals("a missing time is 0, not a crash", 0L, ChatParse.conversation("c", base, "me")!!.lastMessageAt)
        val c = ChatParse.conversation("c", base + ("unreadCount" to mapOf("me" to 3L, "you" to 2.0)), "me")!!
        assertEquals("you", c.otherUserUid)
        assertEquals("You", c.otherUserName)
        assertEquals(mapOf("me" to 3L, "you" to 2L), c.unreadCount)
    }

    @Test fun `a document that is not this viewer's conversation is skipped, not fatal`() {
        assertNull(ChatParse.conversation("c", mapOf("lastMessage" to "x"), "me"))
        assertNull(ChatParse.conversation("c", mapOf("participants" to listOf("a", "b")), "me"))
    }

    @Test fun `delete chat hides it for this viewer until something newer arrives`() {
        val m = mapOf<String, Any?>("participants" to listOf("me", "you"), "lastMessageAt" to 100L, "clearedAt" to mapOf("me" to 150L))
        val hidden = ChatParse.conversation("c1", m, "me")!!
        assertEquals(150L, hidden.clearedAtMine)
        assertTrue(hidden.hiddenForMe)
        val newer = ChatParse.conversation("c1", m + ("lastMessageAt" to 200L), "me")!!
        assertFalse("a new message brings it back", newer.hiddenForMe)
        // The other person's view is untouched by my mark.
        assertFalse(ChatParse.conversation("c1", m, "you")!!.hiddenForMe)
        val list = ChatParse.visible(listOf(hidden, newer.copy(id = "c2"), newer.copy(id = "c3", lastMessageAt = 300L)))
        assertEquals(listOf("c3", "c2"), list.map { it.id })
    }

    @Test fun `the thread after delete chat shows only what came after`() {
        val msgs = listOf(ChatMessage(id = "1", timestamp = 100L), ChatMessage(id = "2", timestamp = 200L))
        assertEquals(listOf("2"), ChatParse.after(msgs, 150L).map { it.id })
        assertEquals(listOf("1", "2"), ChatParse.after(msgs, 0L).map { it.id })
    }

    @Test fun `the thread is oldest first by each message's own time, whatever order the query gave`() {
        // Firestore puts every number before every Timestamp: a server-stamped 2:05 message came back AFTER a 4:14
        // text, and the screen showed the newest message at the top.
        val queryOrder = listOf(
            ChatMessage(id = "new-text", timestamp = 4_14L),
            ChatMessage(id = "old-server-stamped", timestamp = 2_05L),
            ChatMessage(id = "same-time-a", timestamp = 5_00L),
            ChatMessage(id = "same-time-b", timestamp = 5_00L),
        )
        assertEquals(
            listOf("old-server-stamped", "new-text", "same-time-a", "same-time-b"),
            ChatParse.after(queryOrder, 0L).map { it.id },
        )
        assertEquals(listOf("new-text", "same-time-a", "same-time-b"), ChatParse.after(queryOrder, 3_00L).map { it.id })
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    @Test fun `messages of every kind read, an older message with no type is text`() {
        assertEquals("text", ChatParse.message("m", mapOf("text" to "hi")).type)
        val v = ChatParse.message("m", mapOf("type" to "voice", "audioUrl" to "https://x/a.m4a", "durationMs" to 7_400L))
        assertEquals("voice", v.type)
        assertEquals(7_400L, v.durationMs)
        val g = ChatParse.message("m", mapOf("type" to "gift", "giftName" to "Rose", "quantity" to 2L, "giftEmoji" to "🌹"))
        assertEquals(2, g.quantity)
        assertEquals("Rose", g.giftName)
        assertEquals(1, ChatParse.message("m", mapOf("type" to "gift")).quantity)
    }

    @Test fun `what the list says for a photo or a voice note, and a voice note's clock`() {
        assertEquals("📷 Photo", ChatParse.preview("image", ""))
        assertEquals("🎤 Voice message", ChatParse.preview("voice", ""))
        assertEquals("hi", ChatParse.preview("text", "hi"))
        assertEquals("0:07", ChatParse.clock(7_400L))
        assertEquals("1:00", ChatParse.clock(60_000L))
        assertEquals("0:00", ChatParse.clock(-5L))
        assertEquals("chatMedia/a_b/a/x.jpg", ChatParse.mediaPath("a_b", "a", "x.jpg"))
    }

    // ── "A message I got is not in the app": Messages opened on Official every time ──────

    @Test fun `Official counts only notices not yet seen, so Messages stops opening on Official for good`() {
        val n = listOf(
            com.zipper.app.data.model.UserNotification(id = "1", createdAt = 100L),
            com.zipper.app.data.model.UserNotification(id = "2", createdAt = 200L, isRead = true),
            com.zipper.app.data.model.UserNotification(id = "3", createdAt = 300L),
        )
        assertEquals(2, MessagesTabs.unseenOfficial(n, 0L))
        assertEquals(1, MessagesTabs.unseenOfficial(n, 150L))
        assertEquals(0, MessagesTabs.unseenOfficial(n, 300L))
        // Never opened: Official first (QA, 3 Nov). Opened once: Chats, until something new arrives.
        assertEquals(MessagesTabs.OFFICIAL, MessagesTabs.initialTab(null, MessagesTabs.unseenOfficial(n, 0L), 0))
        assertEquals(MessagesTabs.CHATS, MessagesTabs.initialTab(null, MessagesTabs.unseenOfficial(n, 300L), 0))
        assertEquals("now", 500L, MessagesTabs.seenMark(n, 500L))
        assertEquals("a notice stamped ahead of this phone's clock", 300L, MessagesTabs.seenMark(n, 250L))
        // Notices cannot be marked read by a client, which is why "seen" is the phone's own mark.
        assertTrue(src("firestore.rules").contains("match /notifications/{notifId} {"))
        val screen = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/MessagesScreen.kt")
        assertTrue("coming back from a chat keeps the tab", screen.contains("var tab by rememberSaveable { mutableIntStateOf(-1) }"))
        assertTrue("opening Official marks it seen", screen.contains("viewModel.officialOpened()"))
        val vm = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/MessagesViewModel.kt")
        assertTrue(vm.contains("MessagesTabs.unseenOfficial(notifications, officialSeenAt)"))
    }

    // ── The server and the rules agree with the app ─────────────────────────

    @Test fun `a phone sends text, photo, voice and invite - and never a gift`() {
        assertEquals(setOf("text", "image", "voice", "invite"), ChatParse.CLIENT_TYPES)
        val rules = src("firestore.rules")
        assertTrue(rules.contains("request.resource.data.get('type', 'text') in ['text', 'image', 'voice', 'invite']"))
        assertTrue("a message names its writer", rules.contains("request.resource.data.get('senderUid', '') == request.auth.uid"))
        val repo = src("zipper-app/app/src/main/java/com/zipper/app/data/repository/ChatRepository.kt")
        assertTrue(repo.contains("require(type in ChatParse.CLIENT_TYPES)"))
        // The gift message is the server's, in the money transaction.
        val gifts = src("functions/src/gifts.ts")
        assertTrue(gifts.contains("if (giftContext === 'dm') {"))
        assertTrue(gifts.contains("type: 'gift'"))
        assertTrue(gifts.contains("tx.set(convoRef.collection('messages').doc(chat.messageId), chat.message)"))
        // Photos and voice notes have a home only the two people reach.
        val storage = src("storage.rules")
        assertTrue(storage.contains("match /chatMedia/{convoId}/{uid}/{fileName}"))
        assertTrue(storage.contains("request.auth.uid in convoId.split('_')"))
        assertTrue(repo.contains("ChatParse.mediaPath(convoId, myUid, name)"))
    }

    @Test fun `the chat screen offers photo, gift, voice, block and report`() {
        val screen = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/ChatScreen.kt")
        for (label in listOf("\"Send a photo\"", "\"Send a gift\"", "\"Record a voice message\"", "\"Block \$name\"", "\"Report \$name\"")) {
            assertTrue("chat offers $label", screen.contains(label))
        }
        assertTrue("the gift goes through the same server path as the profile's", screen.contains("peer.sendGift(g, q)"))
        assertTrue("a blocked person's chat cannot be written to", screen.contains("peerState.isBlocked ->"))
        val vm = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/ChatViewModel.kt")
        assertFalse("a failed send is said, not swallowed", vm.contains("catch (_: Exception) {}"))
        assertTrue(vm.contains("MediaUtils.compressImage(appContext, uri)"))
        assertTrue(vm.contains("\"audio/mp4\", \"m4a\""))
    }

    @Test fun `the chat header calls the person through the same paid call the profile starts`() {
        val screen = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/ChatScreen.kt")
        // O14 (5 Nov 2026): the header button follows the person's calls switch ("Calls off" / "Busy" when they cannot take one).
        assertTrue("a call button in the header", screen.contains("if (callable) Icons.Default.Videocam else Icons.Default.VideocamOff"))
        assertTrue("…named for the person while callable", screen.contains("if (callable) \"Call \$name\""))
        assertTrue("…and a call button beside the gift button too", screen.contains("if (canRing) \"Call \$name\""))
        assertTrue("…not offered to a blocked person", screen.contains("if (!peerState.isBlocked) {"))
        assertTrue("…the price is confirmed first", screen.contains("CallConfirmDialog("))
        assertTrue("…and the server starts it", screen.contains("peer.initiateCall()"))
        assertTrue("…then the call screen opens", screen.contains("onStartCall(id)"))
        val nav = src("zipper-app/app/src/main/java/com/zipper/app/navigation/ZipperNavGraph.kt")
        assertTrue(nav.contains("onStartCall = { callId -> navController.navigate(Screen.VideoCall.createRoute(callId, isOutgoing = true)) },\n                prefilledMessage = prefilledMsg,"))
        val profile = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/profile/OtherUserProfileScreen.kt")
        assertTrue("the profile shows the same confirmation", profile.contains("CallConfirmDialog("))
    }

    @Test fun `the chat list selects and deletes chats, and says when it could not load`() {
        val list = src("zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/MessagesScreen.kt")
        assertTrue(list.contains("onLongClick = { onToggle(convo.id) }"))
        assertTrue(list.contains("\"Delete selected chats\""))
        assertTrue(list.contains("\"Chats could not be loaded\""))
        val repo = src("zipper-app/app/src/main/java/com/zipper/app/data/repository/ChatRepository.kt")
        assertTrue("delete chat marks only my own side", repo.contains("\"clearedAt.\$myUid\" to maxOf(now, c.lastMessageAt)"))
        assertTrue("a broken listener is reported, not shown as 'No chats yet'", repo.contains("ConversationsUpdate(emptyList(), failed = true)"))
        assertFalse("no list read throws on a time stored as a Timestamp", repo.contains("getLong(\"lastMessageAt\")"))
    }
}
