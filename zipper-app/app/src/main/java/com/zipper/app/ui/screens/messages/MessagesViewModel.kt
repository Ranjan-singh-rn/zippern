package com.zipper.app.ui.screens.messages

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.BroadcastMessage
import com.zipper.app.data.model.Conversation
import com.zipper.app.data.model.SupportTicket
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
    val broadcasts: List<BroadcastMessage> = emptyList(),
    val tickets: List<SupportTicket> = emptyList(),
    val isLoading: Boolean = true,
    val totalUnread: Int = 0,
)

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
            chatRepo.myTicketsFlow(myUid).collect { tickets ->
                _state.update { it.copy(tickets = tickets) }
            }
        }
    }

    fun myUid() = auth.currentUser?.uid ?: ""
    fun convoId(otherUid: String) = chatRepo.convoId(myUid(), otherUid)
}
