package com.zipper.app.ui.screens.auth

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AppealRepository
import com.zipper.app.data.repository.AppealStatus
import com.zipper.app.util.AppealRoute
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class BannedUiState(
    /** Still working out whether they already have one waiting. */
    val checking: Boolean = true,
    /**
     * C9 (B26): which appeal this phone can send — the signed-in form, the same
     * form proved by the device key, or the web page. Decided once, when the
     * screen opens: it is a fact about how the screen was reached, and it must
     * not flicker from a form into an address halfway through somebody typing.
     */
    val route: AppealRoute.Route = AppealRoute.Route.Web,
    /** An appeal of theirs is with a reviewer. The form is not shown. */
    val hasPending: Boolean = false,
    /**
     * What came of the last concluded appeal, already interpreted.
     *
     * An [AppealStatus.Outcome] rather than the raw status string, and that is
     * the whole point of the change: the screen used to compare the string to
     * `"overturned"` and treat everything else as a refusal, so any status this
     * build did not know would have been reported to the person as "your appeal
     * was not accepted". The mapping happens once, here, through a total
     * function. See `AppealStatus`.
     */
    val lastOutcome: AppealStatus.Outcome = AppealStatus.Outcome.NONE,
    /** The reviewer's own words, when there are any. Shown for every outcome. */
    val lastReason: String = "",
    val statement: String = "",
    val evidence: List<Uri> = emptyList(),
    val sending: Boolean = false,
    val sent: Boolean = false,
    val error: String? = null,
    /**
     * Screenshots that would not upload, on an appeal that WAS filed.
     *
     * Not an error — the statement is what a reviewer reads and it arrived.
     * But the upload failure used to be swallowed whole, so somebody watched
     * their thumbnail appear, pressed Send, and was never told the reviewer
     * would see nothing. Usually the 5 MB cap in `storage.rules` against an
     * un-resized gallery photograph.
     */
    val evidenceDropped: Int = 0,
)

/**
 * The banned screen's one piece of state: whether this person can still say
 * something, and what happened last time they did.
 */
@HiltViewModel
class BannedViewModel @Inject constructor(
    private val appeals: AppealRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(BannedUiState())
    val state: StateFlow<BannedUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(checking = true) }
            val route = appeals.appealRoute()
            if (route != AppealRoute.Route.Session) {
                /*
                 * No session, so nothing here can be read: both lookups below
                 * are authenticated. The device-key route still refuses a
                 * duplicate — the server answers `already_pending` and the
                 * screen shows that instead of a second appeal.
                 */
                _state.update { it.copy(checking = false, route = route, hasPending = false) }
                return@launch
            }
            val pending = appeals.pendingAppeal()
            // The most recent CONCLUDED appeal, if there is one. Somebody whose
            // appeal was refused should be told why on this screen rather than
            // filing the same appeal again into the same queue.
            //
            // `isConcluded` rather than `!= "pending"` spelled out here: the
            // predicate and the display mapping now come from one place, so
            // they cannot disagree about what counts as finished.
            val decided = appeals.myAppeals().firstOrNull {
                AppealStatus.isConcluded(it["status"] as? String)
            }
            _state.update {
                it.copy(
                    checking = false,
                    route = route,
                    hasPending = pending,
                    lastOutcome = AppealStatus.outcomeOf(decided?.get("status") as? String),
                    lastReason = (decided?.get("decisionReason") as? String).orEmpty(),
                )
            }
        }
    }

    fun onStatement(text: String) = _state.update { it.copy(statement = text, error = null) }

    fun addEvidence(uri: Uri) = _state.update {
        // Only an authenticated write can upload; the device-key route carries
        // the statement alone (C9), so nothing is collected that would be lost.
        if (it.evidence.size >= 3 || !AppealRoute.carriesEvidence(it.route)) it
        else it.copy(evidence = it.evidence + uri)
    }

    fun removeEvidence(uri: Uri) = _state.update {
        it.copy(evidence = it.evidence.filterNot { u -> u == uri })
    }

    fun submit() {
        val s = _state.value
        if (s.sending) return
        viewModelScope.launch {
            _state.update { it.copy(sending = true, error = null) }
            when (val res = appeals.appealMyBan(s.statement, s.evidence)) {
                is AppealRepository.Result.Ok ->
                    _state.update {
                        it.copy(
                            sending = false, sent = true, hasPending = true,
                            evidenceDropped = res.evidenceDropped,
                        )
                    }
                is AppealRepository.Result.AlreadyPending ->
                    _state.update { it.copy(sending = false, hasPending = true) }
                is AppealRepository.Result.Failed ->
                    _state.update { it.copy(sending = false, error = res.message) }
            }
        }
    }
}
