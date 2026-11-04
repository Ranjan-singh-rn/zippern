package com.zipper.app.ui.screens.messages

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.BroadcastMessage
import com.zipper.app.data.model.Conversation
import com.zipper.app.data.model.SupportTicket
import com.zipper.app.data.model.UserNotification
import com.zipper.app.data.repository.ChatRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class MessagesUiState(
    val conversations: List<Conversation> = emptyList(),
    /** Sent to everybody. */
    val broadcasts: List<BroadcastMessage> = emptyList(),
    /**
     * Sent to this user alone — warnings, recharge outcomes, approvals. Shown
     * in the same Official tab as [broadcasts] and interleaved with them by
     * time, because from the user's side there is one list of things Zipper
     * has told them, not two.
     */
    val notifications: List<UserNotification> = emptyList(),
    val tickets: List<SupportTicket> = emptyList(),
    val isLoading: Boolean = true,
    val totalUnread: Int = 0,
    /**
     * The personal notices have arrived at least once. The first tab waits for
     * this as well as for the chats (E2E re-run, 3 Nov 2026: the chats came
     * first, the tab was decided with no notice counted, and Messages opened
     * on Chats beside "Official · 4").
     */
    val notificationsLoaded: Boolean = false,
    /** O5: the chats could not be read — said on screen instead of an empty "No chats yet". */
    val chatsFailed: Boolean = false,
    /** O5: conversations ticked for "delete chat" (selection mode while non-empty). */
    val selected: Set<String> = emptySet(),
    val deleting: Boolean = false,
    val notice: String? = null,
    /** O5: this account last opened the Official tab at (epoch ms, kept on the phone). */
    val officialSeenAt: Long = 0L,
    /** O5: the mark as it was when the tab was opened this time — the cards newer than it keep their "new" dot. */
    val officialNewSince: Long = 0L,
) {
    /** Personal notices not yet seen, for the Official tab's count and the first tab (O5: seen = the tab was opened). */
    val unreadOfficial: Int get() = com.zipper.app.util.MessagesTabs.unseenOfficial(notifications, officialSeenAt)
}

@HiltViewModel
class MessagesViewModel @Inject constructor(
    private val chatRepo: ChatRepository,
    private val auth: FirebaseAuth,
    @dagger.hilt.android.qualifiers.ApplicationContext private val appContext: android.content.Context,
) : ViewModel() {

    private val _state = MutableStateFlow(
        MessagesUiState().let { s ->
            val seen = com.zipper.app.util.OfficialSeen.get(appContext, auth.currentUser?.uid.orEmpty())
            s.copy(officialSeenAt = seen, officialNewSince = seen)
        },
    )
    val state: StateFlow<MessagesUiState> = _state.asStateFlow()

    init { load() }

    private fun load() {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            chatRepo.conversationsFlow(myUid).collect { update ->
                val convos = update.conversations
                val unread = convos.sumOf { (it.unreadCount[myUid] ?: 0L).toInt() }
                _state.update { s ->
                    s.copy(
                        conversations = convos, totalUnread = unread, isLoading = false, chatsFailed = update.failed,
                        // A chat that left the list (deleted on another device, or now hidden) is no longer selected.
                        selected = s.selected.filterTo(mutableSetOf()) { id -> convos.any { it.id == id } },
                    )
                }
            }
        }
        viewModelScope.launch {
            chatRepo.broadcastsFlow().collect { broadcasts ->
                _state.update { it.copy(broadcasts = broadcasts) }
            }
        }
        viewModelScope.launch {
            chatRepo.myNotificationsFlow(myUid).collect { notifications ->
                _state.update { it.copy(notifications = notifications, notificationsLoaded = true) }
            }
        }
        viewModelScope.launch {
            chatRepo.myTicketsFlow(myUid).collect { tickets ->
                _state.update { it.copy(tickets = tickets) }
            }
        }
    }

    fun myUid() = auth.currentUser?.uid ?: ""
    fun convoId(otherUid: String) = chatRepo.convoId(myUid(), otherUid)

    // ── O5: select chats and delete them (for me) ───────────────────────────

    fun toggleSelected(id: String) = _state.update {
        it.copy(selected = if (id in it.selected) it.selected - id else it.selected + id)
    }

    fun clearSelection() = _state.update { it.copy(selected = emptySet()) }

    fun selectAll() = _state.update { s -> s.copy(selected = s.conversations.map { it.id }.toSet()) }

    /**
     * Deletes the ticked chats from THIS person's list: each stays hidden until a newer message arrives, and its
     * thread then shows only what came after. The other person's chat is not touched.
     */
    fun deleteSelected() {
        val s = _state.value
        val uid = myUid()
        val chosen = s.conversations.filter { it.id in s.selected }
        if (chosen.isEmpty() || uid.isBlank() || s.deleting) return
        _state.update { it.copy(deleting = true) }
        viewModelScope.launch {
            try {
                chatRepo.clearForMe(chosen, uid)
                _state.update {
                    it.copy(deleting = false, selected = emptySet(),
                        notice = if (chosen.size == 1) "Chat deleted." else "${chosen.size} chats deleted.")
                }
            } catch (e: Exception) {
                _state.update { it.copy(deleting = false, notice = "Couldn't delete. Check your connection and try again.") }
            }
        }
    }

    fun consumeNotice() = _state.update { it.copy(notice = null) }

    /**
     * O5: the Official tab is on screen — everything in it is now seen, so the count clears and the next visit to
     * Messages opens on Chats again (unless something new arrives). The cards that were new keep their dot for this
     * visit.
     */
    fun officialOpened() {
        val uid = myUid()
        val s = _state.value
        if (uid.isBlank() || !s.notificationsLoaded) return
        val mark = com.zipper.app.util.MessagesTabs.seenMark(s.notifications, System.currentTimeMillis())
        if (mark <= s.officialSeenAt) return
        com.zipper.app.util.OfficialSeen.set(appContext, uid, mark)
        _state.update { it.copy(officialNewSince = it.officialSeenAt, officialSeenAt = mark) }
    }
}
