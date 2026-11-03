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
) {
    /** Unread personal notices, for the Official tab's count. */
    val unreadOfficial: Int get() = notifications.count { !it.isRead }
}

@HiltViewModel
class MessagesViewModel @Inject constructor(
    private val chatRepo: ChatRepository,
    private val auth: FirebaseAuth,
) : ViewModel() {

    private val _state = MutableStateFlow(MessagesUiState())
    val state: StateFlow<MessagesUiState> = _state.asStateFlow()

    init { load() }

    private fun load() {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            chatRepo.conversationsFlow(myUid).collect { convos ->
                val unread = convos.sumOf { (it.unreadCount[myUid] ?: 0L).toInt() }
                _state.update { it.copy(conversations = convos, totalUnread = unread, isLoading = false) }
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
}
