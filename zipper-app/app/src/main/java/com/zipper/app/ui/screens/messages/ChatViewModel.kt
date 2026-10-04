package com.zipper.app.ui.screens.messages

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.data.repository.ChatRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    val messageInput: String = "",
    val otherUserName: String = "",
    val otherUserPhotoUrl: String = "",
    val otherUserOnline: Boolean = false,
    val isLoading: Boolean = true,
)

@HiltViewModel
class ChatViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val chatRepo: ChatRepository,
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val discover: DiscoverRepository,
    @dagger.hilt.android.qualifiers.ApplicationContext private val appContext: android.content.Context,
) : ViewModel() {

    val otherUid: String = checkNotNull(savedStateHandle["uid"])
    val myUid: String get() = auth.currentUser?.uid ?: ""
    // convoId is deterministic — same result regardless of who opens the chat
    val convoId: String  = listOf(otherUid, auth.currentUser?.uid ?: "").sorted().joinToString("_")

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        loadOtherUser()
        observeMessages()
        // While this chat is open, its messages must not also arrive as notifications.
        com.zipper.app.service.AppState.openChatUid = otherUid
        androidx.core.app.NotificationManagerCompat.from(appContext).cancel(2000 + (otherUid.hashCode() and 0xffff))
    }

    override fun onCleared() {
        super.onCleared()
        if (com.zipper.app.service.AppState.openChatUid == otherUid) com.zipper.app.service.AppState.openChatUid = null
    }

    private fun loadOtherUser() {
        viewModelScope.launch {
            // Three fields for a chat header used to mean reading the whole
            // user document — phone number, email, date of birth and balances
            // with it.
            val p = discover.findByUid(otherUid) ?: return@launch
            _state.update {
                it.copy(
                    otherUserName     = p.name,
                    otherUserPhotoUrl = p.photoUrl,
                    otherUserOnline   = p.isOnline,
                )
            }
        }
    }

    private fun observeMessages() {
        viewModelScope.launch {
            chatRepo.messagesFlow(convoId).collect { msgs ->
                _state.update { it.copy(messages = msgs, isLoading = false) }
            }
        }
    }

    fun onInput(v: String) { _state.update { it.copy(messageInput = v) } }

    fun sendMessage() {
        val text = _state.value.messageInput.trim()
        if (text.isBlank()) return
        _state.update { it.copy(messageInput = "") }
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            try {
                val meSnap = firestore.collection("users").document(myUid).get().await()
                chatRepo.sendMessage(
                    myUid        = myUid,
                    myName       = meSnap.getString("name") ?: "",
                    myPhotoUrl   = meSnap.getString("photoUrl") ?: "",
                    otherUid     = otherUid,
                    otherName    = _state.value.otherUserName,
                    otherPhotoUrl = _state.value.otherUserPhotoUrl,
                    text         = text,
                )
            } catch (_: Exception) {}
        }
    }

    fun markRead() {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch { chatRepo.markRead(convoId, myUid) }
    }
}
