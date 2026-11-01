package com.zipper.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class RecoverAccountUiState(
    /** When the account is due to be destroyed. 0 when it could not be read. */
    val dueAtMillis: Long = 0L,
    val busy: Boolean = false,
    val recovered: Boolean = false,
    /**
     * C7: recovered, but the profile was never finished — profile setup, not
     * Home. Set together with [recovered].
     */
    val needsSetup: Boolean = false,
    /**
     * The account has been purged — by "Create a new account instead" or by
     * "Delete it for good". One flag for both, because the server does the same
     * thing either way and the screen goes to the same place; what differs is
     * only what the person chooses to do once they are back at Login.
     */
    val purged: Boolean = false,
    /**
     * Back to Login with no account to enter: the recovery window had already
     * closed (C8, `RECOVERY_EXPIRED`), or the session could not be kept. The
     * reason travels to the login screen through `ForcedSignOut`. Without this
     * the person would be left on a screen with no way back, holding a button
     * that could never work.
     */
    val signedOut: Boolean = false,
    val error: String? = null,
)

/**
 * The state behind the one screen that can undo a deletion.
 *
 * Both actions go through the server. That is not ceremony: recovering clears
 * fields the security rules do not let a user write, and deleting has to remove
 * the auth login and the storage objects, which no client can do for itself.
 */
@HiltViewModel
class RecoverAccountViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(RecoverAccountUiState())
    val state: StateFlow<RecoverAccountUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val pending = repo.pendingDeletion()
            // A null here means "nothing pending" OR "the read failed", and the
            // screen treats both the same way: it shows the choice without a
            // date rather than inventing one. Being unable to say WHEN is not a
            // reason to be unable to say WHAT.
            _state.update { it.copy(dueAtMillis = pending?.dueAtMillis ?: 0L) }
        }
    }

    /**
     * Keep the account — and, since B02, sign into it properly.
     *
     * `recoverAccount` now opens the session the original sign-in skipped
     * (session, quick login, roles) and routes by profile completeness, so the
     * answer can be either of the two sign-in results as well as a refusal.
     *
     * @param deviceId this handset, as on every other sign-in path.
     */
    fun recover(deviceId: String = "") {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.recoverAccount(deviceId)) {
                is AuthResult.Success ->
                    _state.update { it.copy(busy = false, recovered = true) }
                is AuthResult.ProfileIncomplete ->
                    _state.update { it.copy(busy = false, recovered = true, needsSetup = true) }
                // C8: the window had closed. Already signed out by the repository.
                is AuthResult.AccountDeleted -> {
                    ForcedSignOut.raise(res.message)
                    _state.update { it.copy(busy = false, signedOut = true) }
                }
                is AuthResult.Error ->
                    if (repo.isSignedIn()) {
                        _state.update { it.copy(busy = false, error = res.message) }
                    } else {
                        // The session went with the failure (a session that
                        // could not be claimed signs out). There is nothing to
                        // retry from here, so Login, with the reason.
                        ForcedSignOut.raise(res.message)
                        _state.update { it.copy(busy = false, signedOut = true) }
                    }
                is AuthResult.Banned ->
                    _state.update { it.copy(busy = false, error = res.reason) }
                else -> _state.update { it.copy(busy = false, error = UNEXPECTED) }
            }
        }
    }

    /**
     * Purge the account now. Behind BOTH endings on the screen — "Create a new
     * account instead" and "Delete it for good".
     *
     * One function for two buttons because `purgeMyAccountNow` is one server
     * action: the identity is released either way, and the two labels exist to
     * describe the person's intention, not two different outcomes. Duplicating
     * it here so each button had "its own" call would have produced two
     * identical code paths that could drift apart, and a screen that told
     * somebody it did something different depending on which door they used.
     */
    fun deleteNow() {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.deleteAccountNow()) {
                is AuthResult.Success ->
                    _state.update { it.copy(busy = false, purged = true) }
                is AuthResult.Error ->
                    // Deliberately stays on this screen. Navigating away on a
                    // failed delete is what made the old flow lie: the person
                    // was told the account was gone while it was still there.
                    _state.update { it.copy(busy = false, error = res.message) }
                else -> _state.update { it.copy(busy = false, error = UNEXPECTED) }
            }
        }
    }

    private companion object {
        /*
         * ── WHY THE `else` BRANCHES SAY SOMETHING ────────────────────────────
         *
         * `AuthResult` is a sealed class with nine subtypes, and it changes:
         * `ObserverDenied` and `DeletedRecoverable` arrived after this screen
         * was written, and `NeedsContactDetails` has since been replaced by
         * `AccountDeleted` (C7, C8). `recoverAccount` can now answer like a
         * sign-in, so its `when` names those results; the `else` arms remain
         * what keeps this file compiling when another subtype lands, and a
         * `when` without one would break the build in a screen nobody changed.
         *
         * They used to clear `busy` and say nothing. That turned any future
         * result this screen does not understand into a dead button: the
         * spinner stops, the account is neither recovered nor purged, and there
         * is nothing on screen to explain why. On the one screen with no way
         * back, silence is the worst possible failure — so an unrecognised
         * answer is reported as one rather than swallowed.
         */
        const val UNEXPECTED =
            "Something unexpected came back from the server. Nothing has changed — " +
                "please try again."
    }
}
