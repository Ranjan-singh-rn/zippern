package com.zipper.app.ui.screens.partner

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.data.repository.PartnerRepository
import com.zipper.app.data.repository.RoleAppealStatement
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The partner hub's state: what this person may apply for, what they hold,
 * and what they have in flight — all from the server.
 *
 * ── NOTHING HERE IS DECIDED LOCALLY ─────────────────────────────────────────
 *
 * The role table (an Agency may add a Coin Seller and nothing else; a Host
 * under a sub-agency may add a Coin Seller only; and so on) lives in
 * `backend/app/services/partner_applications.py` and is applied against the
 * authoritative partner records. The app asks and renders. `user.isAgent` and
 * `user.isSeller` on the user document are display flags written by
 * `syncMyRoles`; they are not consulted here, because a flag that lags the
 * record by a sync would show a choice the server then refuses.
 */
data class PartnerHubUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val eligibility: PartnerFunctions.Eligibility? = null,
    val applications: List<PartnerFunctions.Application> = emptyList(),
    /**
     * C2: this person's reinstatement requests, newest first. Read only when
     * something is revoked — everybody else has none and is spared the call.
     */
    val roleAppeals: List<PartnerFunctions.RoleAppeal> = emptyList(),
    /** The revoked kind whose request is being written, or null when no dialog is open. */
    val appealKind: String? = null,
    val appealStatement: String = "",
    val appealSending: Boolean = false,
    val appealError: String? = null,
    /** One line of confirmation after a request was filed. */
    val notice: String? = null,
    /**
     * Decision 15 (RC): what the server says is verified, read only when an
     * approved role is waiting for BOTH contacts. Null otherwise.
     */
    val activation: com.zipper.app.util.ActivationRequirement? = null,
)

@HiltViewModel
class PartnerHubViewModel @Inject constructor(
    private val repo: PartnerRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PartnerHubUiState())
    val state: StateFlow<PartnerHubUiState> = _state.asStateFlow()

    init { refresh() }

    /**
     * The hub came back to the front.
     *
     * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
     *
     * The state was read once, in `init`. Filing an application pops back to
     * THIS back-stack entry — the same view model — so the hub went on showing
     * the choice the person had just used, with no "pending" row under it,
     * until they left the hub and came back. The nav graph's own comment
     * promised a re-read that never happened.
     *
     * The first resume is the one `init` already loaded for, so it is skipped
     * rather than read twice.
     */
    private var resumedOnce = false

    fun onResumed() {
        if (!resumedOnce) {
            resumedOnce = true
            return
        }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            // The spinner only for the first load. A re-read on return keeps
            // what is on screen until the answer is in, instead of blanking it.
            _state.update { it.copy(loading = it.eligibility == null, error = null) }
            val elig = repo.eligibility()
            val apps = repo.myApplications()
            val value = (elig as? PartnerFunctions.Result.Ok)?.value
            val appeals = if (value != null && PartnerHubRows.hasRevoked(value)) {
                (repo.myRoleAppeals() as? PartnerFunctions.Result.Ok)?.value.orEmpty()
            } else {
                emptyList()
            }
            // Decision 15 (RC): an approved role is WAITING for both verified
            // contacts. Ask the server to check — the person may have just
            // come back from verifying one — and re-read if anything started.
            // The server decides; this only asks, and asking twice is harmless.
            var current = value
            var activation: com.zipper.app.util.ActivationRequirement? = null
            var startedNotice: String? = null
            if (value != null && PartnerHubRows.hasAwaiting(value)) {
                val checked = repo.checkActivation()
                if (checked is PartnerFunctions.Result.Ok) {
                    activation = checked.value.requirement
                    if (checked.value.started.isNotEmpty()) {
                        startedNotice = checked.value.started.joinToString(", ") { s -> PartnerHubRows.label(s.kind) } +
                            " started — both your contacts are verified."
                        current = (repo.eligibility() as? PartnerFunctions.Result.Ok)?.value ?: value
                    }
                }
            }
            _state.update {
                it.copy(
                    loading = false,
                    eligibility = current ?: it.eligibility,
                    activation = activation,
                    notice = startedNotice ?: it.notice,
                    applications = (apps as? PartnerFunctions.Result.Ok)?.value ?: it.applications,
                    roleAppeals = appeals,
                    error = when {
                        elig is PartnerFunctions.Result.Failed -> elig.userMessage
                        apps is PartnerFunctions.Result.Failed -> apps.userMessage
                        else -> null
                    },
                )
            }
        }
    }

    // ── Reinstatement of a revoked role (C2) ─────────────────────────────────

    fun openAppeal(kind: String) = _state.update {
        it.copy(appealKind = kind, appealStatement = "", appealError = null, notice = null)
    }

    fun closeAppeal() = _state.update {
        if (it.appealSending) it else it.copy(appealKind = null, appealError = null)
    }

    /** Capped at the server's maximum, so the field cannot hold what Send would refuse. */
    fun onAppealStatement(text: String) = _state.update {
        it.copy(appealStatement = text.take(RoleAppealStatement.MAX), appealError = null)
    }

    /**
     * File the request, then re-read the hub so the row shows it as pending
     * rather than still offering "Request reinstatement".
     *
     * The bounds are checked here as well as on the button: the server refuses
     * anything outside 20–2,000 characters, and saying so before the round trip
     * is the difference between a message and a mystery.
     */
    fun submitAppeal() {
        val s = _state.value
        val kind = s.appealKind ?: return
        if (s.appealSending) return
        val problem = RoleAppealStatement.problem(s.appealStatement)
        if (problem != null) {
            _state.update { it.copy(appealError = problem) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(appealSending = true, appealError = null) }
            when (val res = repo.submitRoleAppeal(kind, s.appealStatement.trim())) {
                is PartnerFunctions.Result.Ok -> {
                    _state.update {
                        it.copy(
                            appealSending = false,
                            appealKind = null,
                            appealStatement = "",
                            notice = "Your request to restore the ${PartnerHubRows.label(kind)} role " +
                                "was sent. A reviewer reads it and the Owner decides.",
                        )
                    }
                    refresh()
                }
                is PartnerFunctions.Result.Failed -> {
                    _state.update {
                        it.copy(
                            appealSending = false,
                            appealError = if (res.outcomeUnknown) FilingConfirmation.APPEAL_NOT_CONFIRMED else res.userMessage,
                        )
                    }
                    // RF-30: it may have been filed — re-read, so the role shows
                    // it if it was. Sending again is safe: the server returns
                    // the request already open for this role.
                    if (res.outcomeUnknown) refresh()
                }
            }
        }
    }
}
