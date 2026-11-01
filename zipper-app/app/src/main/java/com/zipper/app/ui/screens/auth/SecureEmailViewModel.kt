package com.zipper.app.ui.screens.auth

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthRepository.EmailCodeSend
import com.zipper.app.data.repository.AuthRepository.EmailCodeVerify
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Which step of the email binding flow is on screen. See `SecureEmailScreen`. */
enum class SecureEmailStage {
    /** Typing the address. */
    Email,

    /** A code was mailed; typing it back. */
    Code,

    /**
     * The address is held by another account, and that is the end of it.
     *
     * A stage of its own rather than an error on [Code] for the reason the
     * phone flow has one: an error is something to retype and this is not.
     */
    Taken,

    /** Bound. The account has an email on it now — the same uid, everything kept. */
    Done,
}

data class SecureEmailUiState(
    val stage: SecureEmailStage = SecureEmailStage.Email,
    val busy: Boolean = false,
    /** Something worth retrying or correcting. Never the refusal — see [SecureEmailStage.Taken]. */
    val error: String? = null,
    /** Lower-cased and trimmed — the address the code was asked for, and is verified against. */
    val email: String = "",
    /** The server's masked form of [email], shown on the code step. */
    val maskedEmail: String = "",
    /** Seconds before another code may be asked for, as the server said when it sent one. */
    val resendInSec: Int = 0,
    /** How long the mailed code lives, as the server said (0 = not known yet). */
    val expiresInSec: Int = 0,
    /** The server's own words for a refusal on [SecureEmailStage.Taken] ('' = the default text). */
    val takenMessage: String = "",
    /** Bumped every time a code is sent, so the screen restarts its countdown. */
    val sendCount: Int = 0,
)

/**
 * Attaching an email address to the account that is signed in — by a six-digit
 * code (UGP-C).
 *
 * ── THE SHAPE, AND WHY IT IS THE PHONE FLOW'S ────────────────────────────────
 *
 * enter address → a code is mailed → enter code → the SERVER checks it and binds
 * the address to this same uid → done → Settings. Exactly the steps of
 * [SecureAccountViewModel], so the two "Secure your account" rows lead to the
 * same experience. It used to end by leaving the app for a mail client and being
 * reopened by an App Link, which is what made "Add your email" open a deep link
 * and land, as often as not, back on an empty "Add your email" form.
 *
 * ── NOT A SIGN-IN, AND NO PASSWORD ───────────────────────────────────────────
 *
 * The code proves this person reads the mailbox; the server then attaches the
 * address to the CURRENT uid or refuses. It never signs into, merges or creates
 * another account, and there is no password anywhere in the app.
 *
 * No client-side "is it free?" pre-check, for the reason given on the phone
 * flow: the server is the only authority, and it answers only once the code has
 * proved the mailbox — so asking for a code reveals nothing about who holds an
 * address.
 */
@HiltViewModel
class SecureEmailViewModel @Inject constructor(
    private val repo: AuthRepository,
    /**
     * UGP review: the flow survives process death. People leave for their mail
     * app to read the code, and Android may kill this process meanwhile; coming
     * back to an empty address form, and a fresh code that voids the one just
     * read, is the failure. The stage, the address, its masked form and the
     * refusal text are kept — the CODE never is.
     */
    private val saved: SavedStateHandle,
) : ViewModel() {

    private val _state = MutableStateFlow(restore())
    val state: StateFlow<SecureEmailUiState> = _state.asStateFlow()

    private fun restore(): SecureEmailUiState {
        val email = saved.get<String>(KEY_EMAIL).orEmpty()
        val stage = saved.get<String>(KEY_STAGE)
            ?.let { name -> SecureEmailStage.values().firstOrNull { it.name == name } }
            ?: SecureEmailStage.Email
        return SecureEmailUiState(
            // A code step with no address could verify nothing: start over.
            stage = if (stage == SecureEmailStage.Code && email.isBlank()) SecureEmailStage.Email else stage,
            email = email,
            maskedEmail = saved.get<String>(KEY_MASKED).orEmpty(),
            expiresInSec = saved.get<Int>(KEY_EXPIRES) ?: 0,
            takenMessage = saved.get<String>(KEY_TAKEN).orEmpty(),
            // The resend countdown is not restored: after a restart the server's
            // own cooldown answers a too-early resend with the seconds left.
        )
    }

    /** Every state change goes through here, so what is saved is what is shown. */
    private fun edit(change: (SecureEmailUiState) -> SecureEmailUiState) {
        _state.update(change)
        val s = _state.value
        saved[KEY_STAGE] = s.stage.name
        saved[KEY_EMAIL] = s.email
        saved[KEY_MASKED] = s.maskedEmail
        saved[KEY_EXPIRES] = s.expiresInSec
        saved[KEY_TAKEN] = s.takenMessage
    }

    fun sendCode(email: String) {
        if (_state.value.busy) return
        val address = email.trim().lowercase()
        edit { it.copy(busy = true, error = null, email = address) }
        viewModelScope.launch {
            when (val res = repo.requestEmailCode(address)) {
                is EmailCodeSend.Sent -> edit {
                    it.copy(
                        busy = false,
                        stage = SecureEmailStage.Code,
                        maskedEmail = res.maskedEmail.ifBlank { address },
                        resendInSec = res.resendInSec.coerceAtLeast(1),
                        expiresInSec = res.expiresInSec,
                        sendCount = it.sendCount + 1,
                    )
                }
                // This verified address is already on the account — typically a
                // retry after the verify reply was lost. The repository has
                // refreshed the session exactly as a fresh bind would.
                EmailCodeSend.AlreadyBound ->
                    edit { it.copy(busy = false, stage = SecureEmailStage.Done) }
                is EmailCodeSend.Wait -> edit { it.copy(busy = false, error = res.message) }
                is EmailCodeSend.Refused -> edit { it.copy(busy = false, error = res.message) }
                is EmailCodeSend.Failed -> edit { it.copy(busy = false, error = res.message) }
            }
        }
    }

    /** Same address, a new code. The previous code stops working (the server voids it). */
    fun resend() = sendCode(_state.value.email)

    fun verify(code: String) {
        if (_state.value.busy) return
        val digits = code.filter { it.isDigit() }
        if (digits.length != 6) {
            edit { it.copy(error = "Enter the 6-digit code from the email.") }
            return
        }
        edit { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.verifyEmailCode(_state.value.email, digits)) {
                EmailCodeVerify.Bound ->
                    edit { it.copy(busy = false, stage = SecureEmailStage.Done) }
                is EmailCodeVerify.Taken ->
                    edit { it.copy(busy = false, stage = SecureEmailStage.Taken, takenMessage = res.message) }
                is EmailCodeVerify.WrongCode -> edit { it.copy(busy = false, error = res.message) }
                is EmailCodeVerify.NeedNewCode -> edit {
                    // The resend control is the way forward; make it available now.
                    it.copy(busy = false, error = res.message, resendInSec = 0, sendCount = it.sendCount + 1)
                }
                is EmailCodeVerify.Refused -> edit { it.copy(busy = false, error = res.message) }
                is EmailCodeVerify.Failed -> edit { it.copy(busy = false, error = res.message) }
            }
        }
    }

    /**
     * Start again with a different address. Nothing was linked on the device,
     * so there is nothing to undo — the old code simply stops mattering, and the
     * server voids it when the next one is requested.
     *
     * Not while a request is in flight: its answer would land on the reset
     * state (a code step with no address) and defeat the double-submit guard.
     */
    fun useDifferentEmail() {
        if (_state.value.busy) return
        edit {
            it.copy(
                stage = SecureEmailStage.Email, error = null, email = "", maskedEmail = "",
                expiresInSec = 0, takenMessage = "",
            )
        }
    }

    fun clearError() = edit { it.copy(error = null) }

    private companion object {
        const val KEY_STAGE = "secure_email.stage"
        const val KEY_EMAIL = "secure_email.email"
        const val KEY_MASKED = "secure_email.masked"
        const val KEY_EXPIRES = "secure_email.expires"
        const val KEY_TAKEN = "secure_email.taken"
    }
}
