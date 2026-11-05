package com.zipper.app.ui.screens.messages

import android.net.Uri
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.storage.StorageException
import com.zipper.app.data.model.ChatMessage
import com.zipper.app.data.repository.ChatRepository
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.util.ChatParse
import com.zipper.app.util.MediaUtils
import com.zipper.app.util.VoicePlayer
import com.zipper.app.util.VoiceRecorder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import javax.inject.Inject

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    /** O10: more messages exist above the newest page ("Show earlier messages"). */
    val hasEarlier: Boolean = false,
    val otherUserName: String = "",
    val otherUserPhotoUrl: String = "",
    val otherUserOnline: Boolean = false,
    val isLoading: Boolean = true,
    /** O5: the thread could not be read (said, not shown as an empty chat). */
    val loadFailed: Boolean = false,
    /** "Sending photo…" / "Sending voice message…" while an upload runs. */
    val uploading: String? = null,
    val recording: Boolean = false,
    val recordingMs: Long = 0L,
    /** The voice note now playing. */
    val playingId: String? = null,
    /** One-shot line for the snackbar (a send that failed, a recording that was too short). */
    val notice: String? = null,
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

    /**
     * O10 (5 Nov 2026), speed: what is typed lives in its own flow. It used to be a field of [state], so every
     * keystroke produced a new screen state and recomposed the whole thread; only the composer reads it now.
     */
    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input.asStateFlow()

    /** How many of the newest messages the thread streams; raised by [showEarlier]. */
    private val shown = MutableStateFlow(ChatRepository.MESSAGES_PAGE)

    private val recorder = VoiceRecorder(appContext)
    private val player = VoicePlayer()
    private var recordTicker: Job? = null
    /** My own name and photo, read once (they ride on every message and on the conversation). */
    private var me: Pair<String, String>? = null

    init {
        viewModelScope.launch { com.zipper.app.util.SafetyWords.ensureLoaded(com.google.firebase.firestore.FirebaseFirestore.getInstance()) }
        loadOtherUser()
        observeMessages()
        // While this chat is open, its messages must not also arrive as notifications.
        com.zipper.app.service.AppState.openChatUid = otherUid
        androidx.core.app.NotificationManagerCompat.from(appContext).cancel(2000 + (otherUid.hashCode() and 0xffff))
    }

    override fun onCleared() {
        super.onCleared()
        if (com.zipper.app.service.AppState.openChatUid == otherUid) com.zipper.app.service.AppState.openChatUid = null
        recorder.cancel()
        player.stop()
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

    /**
     * The thread, minus what this viewer deleted (O5: "delete chat" keeps only what came after). A read failure is
     * said on screen — it used to look like an empty chat.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun observeMessages() {
        viewModelScope.launch {
            shown.flatMapLatest { limit ->
                combine(chatRepo.messagesFlow(convoId, limit), chatRepo.clearedAtFlow(convoId, myUid)) { update, clearedAt ->
                    Triple(update, clearedAt, limit)
                }
            }.collect { (update, clearedAt, limit) ->
                _state.update {
                    it.copy(
                        messages = ChatParse.after(update.messages, clearedAt),
                        // A full page came back, so there may be more above it.
                        hasEarlier = update.messages.size >= limit,
                        isLoading = false,
                        loadFailed = update.failed,
                    )
                }
            }
        }
    }

    /** O10: one more page of older messages above the ones shown. */
    fun showEarlier() { shown.update { it + ChatRepository.MESSAGES_PAGE } }

    fun onInput(v: String) { _input.value = v }

    fun consumeNotice() { _state.update { it.copy(notice = null) } }

    private suspend fun myProfile(): Pair<String, String> {
        me?.let { return it }
        val snap = firestore.collection("users").document(myUid).get().await()
        return ((snap.getString("name") ?: "") to (snap.getString("photoUrl") ?: "")).also { me = it }
    }

    /** One send path for every kind, with the failure said rather than swallowed (O5). */
    private suspend fun deliver(type: String, text: String = "", extra: Map<String, Any> = emptyMap()): Boolean {
        if (myUid.isBlank()) return false
        return try {
            val (myName, myPhoto) = myProfile()
            chatRepo.send(
                myUid = myUid, myName = myName, myPhotoUrl = myPhoto,
                otherUid = otherUid, otherName = _state.value.otherUserName, otherPhotoUrl = _state.value.otherUserPhotoUrl,
                type = type, text = text, extra = extra,
            )
            true
        } catch (e: Exception) {
            _state.update { it.copy(notice = sendFailure(e)) }
            false
        }
    }

    fun sendMessage() {
        val text = _input.value.trim()
        if (text.isBlank()) return
        // O13: abuse in a private chat is still abuse — held back here, masked by the server if it gets through.
        if (!com.zipper.app.util.SafetyWords.allowed(text)) {
            _state.update { it.copy(notice = com.zipper.app.util.SafetyWords.HELD_NOTICE) }
            return
        }
        _input.value = ""
        viewModelScope.launch {
            // Put the text back when it did not go, so nothing typed is lost.
            if (!deliver("text", text = text)) _input.update { if (it.isEmpty()) text else it }
        }
    }

    /** O5: a photo from the gallery — made small (1080 px JPEG, upright), uploaded, then sent. */
    fun sendPhoto(uri: Uri) {
        if (_state.value.uploading != null) return
        _state.update { it.copy(uploading = "Sending photo…") }
        viewModelScope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { MediaUtils.compressImage(appContext, uri) }
                if (bytes == null) {
                    _state.update { it.copy(notice = "That photo could not be read. Try another one.") }
                    return@launch
                }
                val url = chatRepo.uploadChatMedia(convoId, myUid, bytes, "image/jpeg", "jpg")
                deliver("image", extra = mapOf("imageUrl" to url))
            } catch (e: Exception) {
                _state.update { it.copy(notice = sendFailure(e)) }
            } finally {
                _state.update { it.copy(uploading = null) }
            }
        }
    }

    // ── Voice notes ──────────────────────────────────────────────────────────

    /** Call only once RECORD_AUDIO is granted. */
    fun startRecording() {
        if (_state.value.recording || _state.value.uploading != null) return
        player.stop()
        val started = recorder.start(onMaxReached = { viewModelScope.launch { stopRecordingAndSend() } })
        if (!started) {
            _state.update { it.copy(notice = "The microphone could not be opened.") }
            return
        }
        _state.update { it.copy(recording = true, recordingMs = 0L, playingId = null) }
        recordTicker?.cancel()
        recordTicker = viewModelScope.launch {
            while (recorder.isRecording) {
                _state.update { it.copy(recordingMs = recorder.elapsedMs()) }
                delay(200)
            }
        }
    }

    fun cancelRecording() {
        recordTicker?.cancel()
        recorder.cancel()
        _state.update { it.copy(recording = false, recordingMs = 0L) }
    }

    fun stopRecordingAndSend() {
        if (!_state.value.recording) return
        recordTicker?.cancel()
        val result = recorder.stop()
        _state.update { it.copy(recording = false, recordingMs = 0L) }
        if (result == null) {
            _state.update { it.copy(notice = "Hold on a little longer — that was too short to send.") }
            return
        }
        val (file, durationMs) = result
        _state.update { it.copy(uploading = "Sending voice message…") }
        viewModelScope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                val url = chatRepo.uploadChatMedia(convoId, myUid, bytes, "audio/mp4", "m4a")
                deliver("voice", extra = mapOf("audioUrl" to url, "durationMs" to durationMs))
            } catch (e: Exception) {
                _state.update { it.copy(notice = sendFailure(e)) }
            } finally {
                file.delete()
                _state.update { it.copy(uploading = null) }
            }
        }
    }

    fun togglePlay(msg: ChatMessage) {
        if (player.playingId == msg.id) {
            player.stop()
            _state.update { it.copy(playingId = null) }
            return
        }
        if (msg.audioUrl.isBlank()) return
        player.play(
            id = msg.id, url = msg.audioUrl,
            onFinished = { _state.update { it.copy(playingId = null) } },
            onError = { _state.update { it.copy(playingId = null, notice = "That voice message could not be played.") } },
        )
        _state.update { it.copy(playingId = msg.id) }
    }

    fun markRead() {
        val myUid = auth.currentUser?.uid ?: return
        viewModelScope.launch { chatRepo.markRead(convoId, myUid) }
    }

    private fun sendFailure(e: Exception): String {
        val denied = (e as? FirebaseFirestoreException)?.code == FirebaseFirestoreException.Code.PERMISSION_DENIED ||
            (e as? StorageException)?.errorCode == StorageException.ERROR_NOT_AUTHORIZED
        return if (denied) "You can't message ${_state.value.otherUserName.ifBlank { "this person" }} right now."
        else "Couldn't send. Check your connection and try again."
    }
}
