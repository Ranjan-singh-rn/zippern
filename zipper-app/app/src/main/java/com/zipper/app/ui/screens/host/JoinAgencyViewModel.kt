package com.zipper.app.ui.screens.host

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthResult
import com.zipper.app.data.repository.ReferralResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class JoinAgencyUiState(
    val code: String = "",
    val checking: Boolean = false,
    val activating: Boolean = false,
    /** The agency the code belongs to, once the server has confirmed it. */
    val agencyName: String? = null,
    val error: String? = null,
    /** Activated. The screen hands the person on to face verification. */
    val done: Boolean = false,
    /** They were already this agency's host; nothing changed. */
    val alreadyHost: Boolean = false,
) {
    val verified: Boolean get() = agencyName != null
    val canCheck: Boolean get() = code.length >= 4 && !checking && !activating
}

/**
 * "Join an agency" for an account that already exists.
 *
 * ── WHY THIS IS A SCREEN AND NOT A FIELD ─────────────────────────────────────
 *
 * The referral code used to be collectable in exactly one place: the first-run
 * profile setup form. So an agency could invite somebody who already had the app
 * — which is most people they invite — and that person had nowhere to accept.
 * Their profile showed the referral code as a read-only row, and Go Live told
 * them to "apply with an agency referral code" with nothing to tap. The only
 * remaining route was a staff member running `grant_host` by hand.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * It holds no activation logic. Both calls go to the same two repository methods
 * the setup form uses, which call the same two server functions:
 * `checkReferralCode` to look, `activateHost` to commit. A second implementation
 * of "become a host" is precisely what must not exist here — the server decides
 * the agency, the rate, the roster row and the verification record in one
 * transaction, and anything this class added would be a weaker copy that drifts.
 *
 * The identity match is the server's too. It reads the phone and email from the
 * caller's own token and user document, so there is nothing to type and nothing
 * for this screen to get wrong.
 */
@HiltViewModel
class JoinAgencyViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(JoinAgencyUiState())
    val uiState: StateFlow<JoinAgencyUiState> = _uiState.asStateFlow()

    fun onCodeChange(raw: String) {
        val code = raw.uppercase().trim()
        _uiState.update {
            // Any edit invalidates a previous check. Leaving `agencyName` set
            // would let somebody verify one code and submit another.
            it.copy(code = code, agencyName = null, error = null)
        }
    }

    /** Look, without committing. */
    fun check() {
        val code = _uiState.value.code
        if (code.isBlank()) return
        _uiState.update { it.copy(checking = true, error = null, agencyName = null) }
        viewModelScope.launch {
            when (val res = repo.verifyReferralCode(code)) {
                is ReferralResult.Valid ->
                    _uiState.update { it.copy(checking = false, agencyName = res.agencyName.ifBlank { "your agency" }) }

                ReferralResult.NotFound -> _uiState.update {
                    it.copy(checking = false, error = "No agency has a code like that. Check it with them.")
                }
                ReferralResult.AlreadyUsed -> _uiState.update {
                    it.copy(checking = false, error = "That invitation has already been used.")
                }
                /*
                 * Named carefully. The server will not say WHICH of the two
                 * differs — that would turn a guessed code into a way to test
                 * whether a number is registered — so this says what to do
                 * instead of what is wrong.
                 */
                ReferralResult.AccountMismatch -> _uiState.update {
                    it.copy(
                        checking = false,
                        error = "This invitation was sent to a different phone number or " +
                            "email address. Ask your agency to re-send it to the ones on " +
                            "this account.",
                    )
                }
                is ReferralResult.Error -> _uiState.update { it.copy(checking = false, error = res.message) }
            }
        }
    }

    /** Commit. Only reachable once [check] has come back positive. */
    fun activate() {
        val s = _uiState.value
        if (!s.verified || s.activating) return
        _uiState.update { it.copy(activating = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.activateHostApplication(s.code)) {
                is AuthResult.Success -> _uiState.update { it.copy(activating = false, done = true) }
                /*
                 * Everything else is a refusal with a server sentence worth
                 * showing as-is: a ban, a suspension, an agency they already
                 * belong to, an approval that has not happened yet. The screen
                 * stays put so they can read it and try a different code.
                 */
                is AuthResult.Error -> _uiState.update { it.copy(activating = false, error = res.message) }
                else -> _uiState.update {
                    it.copy(activating = false, error = "Couldn't join that agency. Please try again.")
                }
            }
        }
    }

    fun dismissError() = _uiState.update { it.copy(error = null) }
}
