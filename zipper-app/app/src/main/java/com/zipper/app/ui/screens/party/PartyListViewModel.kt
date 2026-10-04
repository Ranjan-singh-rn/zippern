package com.zipper.app.ui.screens.party

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.data.model.User
import com.zipper.app.data.repository.PartyRepository
import com.zipper.app.data.repository.ProfileRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** What the create sheet has been filled in with so far. */
data class PartyDraft(
    val mode: String = PartyRoom.MODE_AUDIO,
    val title: String = "",
    val seatCount: Int = PartyRoom.AUDIO_SEAT_CHOICES.first(),
    val seatMode: String = PartyRoom.SEAT_MODE_FREE,
    val visibility: String = PartyRoom.VISIBILITY_PUBLIC,
    val password: String = "",
    val welcomeMessage: String = PartyRoom.DEFAULT_WELCOME,
) {
    val isPrivate: Boolean get() = visibility == PartyRoom.VISIBILITY_PRIVATE
    val seatChoices: List<Int> get() = PartyRoom.seatChoices(mode)

    /**
     * Why Start is disabled, or null when it is not.
     *
     * One function rather than a scattering of booleans, so the button's state and
     * the message explaining it cannot disagree — a disabled button with no reason
     * beside it is the specific thing this avoids.
     */
    val problem: String?
        get() = when {
            PartyRoom.welcomeProblem(welcomeMessage) != null ->
                PartyRoom.welcomeProblem(welcomeMessage)
            isPrivate && !password.matches(Regex("^[0-9]{4}$")) ->
                "A private room needs a 4-digit password."
            else -> null
        }
}

data class PartyListUiState(
    val rooms: List<PartyRoom> = emptyList(),
    val mode: String = PartyRoom.MODE_AUDIO,
    val currentUser: User? = null,
    val isLoading: Boolean = true,
    val creating: Boolean = false,
    val draft: PartyDraft = PartyDraft(),
    /** Set once when a room has been opened, so the screen can navigate into it. */
    val createdRoomId: String? = null,
    val error: String? = null,
) {
    /**
     * The rooms to draw.
     *
     * No client-side mode filter any more — the query does it. It used to fetch
     * every active room and filter here because no composite index existed, which
     * also meant the list could not exclude private rooms and had no usable sort.
     * Both are the server's job now.
     */
    val visibleRooms: List<PartyRoom> get() = rooms

    /**
     * Whether to offer the "Start a room" button at all.
     *
     * Anyone signed in may open a party room — this is the deliberate difference
     * from going live, which is verified hosts only. A live room is one person
     * broadcasting to an audience and earning from it; a party room is a room
     * people talk in, where gifts go to whichever seat the sender picks rather
     * than to whoever opened the door. Gating a chat room behind a verification
     * badge would leave almost every room unopenable for a gate protecting no
     * earnings.
     *
     * A banned account is still refused, but that is decided by the server —
     * hiding the button on a ban would tell the user why they are banned through
     * a missing control instead of a message.
     */
    val canCreateRoom: Boolean get() = currentUser != null
}

@HiltViewModel
class PartyListViewModel @Inject constructor(
    private val repo: PartyRepository,
    private val profileRepo: ProfileRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PartyListUiState())
    val state: StateFlow<PartyListUiState> = _state.asStateFlow()

    /**
     * The room-list subscription, replaced when the mode tab changes.
     *
     * One listener at a time. The old version held a single listener over every
     * active room and filtered in memory, so switching tabs was free but the list
     * carried rooms it would never show — including private ones it had no
     * business knowing about.
     */
    private var roomsJob: Job? = null

    init {
        subscribeRooms(_state.value.mode)
        viewModelScope.launch {
            profileRepo.currentUserFlow().collect { user ->
                _state.update { it.copy(currentUser = user) }
            }
        }
    }

    private fun subscribeRooms(mode: String) {
        roomsJob?.cancel()
        _state.update { it.copy(isLoading = true) }
        roomsJob = viewModelScope.launch {
            repo.activeRoomsFlow(mode).collect { rooms ->
                _state.update { it.copy(rooms = rooms, isLoading = false) }
            }
        }
    }

    fun selectMode(mode: String) {
        if (_state.value.mode == mode) return
        _state.update {
            it.copy(
                mode = mode,
                rooms = emptyList(),
                // The seat count is per mode — 10/15 for audio, 6/10 for video —
                // so a draft carrying 15 into a video room would be refused by the
                // server. Snap it as the tab changes rather than at Start, where
                // the correction would look like a bug.
                draft = it.draft.copy(mode = mode, seatCount = PartyRoom.seatChoices(mode).first()),
            )
        }
        subscribeRooms(mode)
    }

    // ── The create sheet ─────────────────────────────────────────────────────

    fun editDraft(transform: (PartyDraft) -> PartyDraft) {
        _state.update { it.copy(draft = transform(it.draft)) }
    }

    fun setDraftMode(mode: String) = editDraft {
        it.copy(mode = mode, seatCount = PartyRoom.seatChoices(mode).first())
    }
    fun setDraftTitle(v: String) = editDraft { it.copy(title = v.take(60)) }
    fun setDraftSeatCount(v: Int) = editDraft { it.copy(seatCount = v) }
    fun setDraftSeatMode(v: String) = editDraft { it.copy(seatMode = v) }
    fun setDraftVisibility(v: String) = editDraft { it.copy(visibility = v) }
    fun setDraftPassword(v: String) = editDraft { it.copy(password = v.filter { c -> c.isDigit() }.take(4)) }
    fun setDraftWelcome(v: String) = editDraft {
        it.copy(welcomeMessage = v.take(PartyRoom.WELCOME_MAX_CHARS))
    }
    /**
     * Clear the sheet, keeping the tab the user is on.
     *
     * The seat count has to be snapped as well as the mode. `PartyDraft` defaults
     * `seatCount` to the audio first choice (10), so resetting on the VIDEO tab
     * left the draft on 10 — legal, since 10 is also a video option, but it
     * pre-selected the larger of the two on the tab whose own hint says six is the
     * safer room. [selectMode] snaps it for exactly this reason and the two must
     * agree.
     */
    fun resetDraft() = _state.update {
        it.copy(
            draft = PartyDraft(
                mode = it.mode,
                seatCount = PartyRoom.seatChoices(it.mode).first(),
            ),
        )
    }

    /**
     * Look up a room by id, for the "open a private room" sheet.
     *
     * A private room never appears in the list — that is what private means — so
     * the only way to reach one is an id somebody shared. Checking it here rather
     * than navigating hopefully is worth a read: a mistyped id otherwise lands on
     * the room screen, where `joinPartyRoom` reports a missing document with the
     * same `not-found` as a closed one, and the user is told "the host ended the
     * party" about a party that never existed.
     *
     * @return null when there is no such room.
     */
    suspend fun findRoom(roomId: String): PartyRoom? = repo.fetchRoom(roomId.trim())

    fun createRoom() {
        val s = _state.value
        if (s.creating) return
        val draft = s.draft
        draft.problem?.let { problem ->
            _state.update { it.copy(error = problem) }
            return
        }
        _state.update { it.copy(creating = true) }
        viewModelScope.launch {
            when (val res = repo.createRoom(
                mode = draft.mode,
                title = draft.title.trim(),
                seatCount = draft.seatCount,
                seatMode = draft.seatMode,
                visibility = draft.visibility,
                password = draft.password,
                welcomeMessage = draft.welcomeMessage.trim(),
            )) {
                is PartyRepository.Result.Ok ->
                    _state.update { it.copy(creating = false, createdRoomId = res.value.roomId) }
                is PartyRepository.Result.Failed ->
                    _state.update { it.copy(creating = false, error = res.userMessage) }
            }
        }
    }

    /** Cleared by the screen once it has navigated, so a back press does not re-enter. */
    fun consumeCreatedRoom() { _state.update { it.copy(createdRoomId = null) } }

    fun clearError() { _state.update { it.copy(error = null) } }
}
