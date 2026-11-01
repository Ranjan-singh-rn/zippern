package com.zipper.app.ui.screens.auth

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.FirebaseException
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthProvider
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Which step of the binding flow is on screen. See [SecureAccountScreen]. */
enum class SecureAccountStage {
    /** Typing the number. */
    Phone,

    /** Typing the code that was texted to it. */
    Code,

    /**
     * The number is held by another live account, and that is the end of it.
     *
     * A stage of its own rather than an error on [Code] because the two need
     * opposite treatment: an error there is something to retype, and this is
     * not. Nothing the person does to the code will change the answer.
     */
    Taken,

    /** Bound. The guest account is a phone account now, same uid and all. */
    Done,
}

data class SecureAccountUiState(
    val stage: SecureAccountStage = SecureAccountStage.Phone,
    val busy: Boolean = false,
    /** Something went wrong and is worth retrying. Never the refusal — see [SecureAccountStage.Taken]. */
    val error: String? = null,
    /** E.164, as it was sent to Firebase. Shown on the code step, and looked up on refusal. */
    val phoneE164: String = "",
    /**
     * The code, held here rather than in the screen so Play Services' auto-read
     * can fill the boxes. The screen owning it would need a one-shot event and a
     * consume callback to push a value in from underneath, which is the shape
     * `otpAutoFilled` has on the login screen and the reason it needs one.
     */
    val code: String = "",
    /**
     * Whose account holds the number, when we could find out. Blank otherwise,
     * and the screen simply says less. Decoration on a refusal that has already
     * been decided — never an input to it.
     */
    val heldByName: String = "",
    val heldByPhotoUrl: String = "",
)

/**
 * Turning a guest into a permanent account, by attaching a phone number to the
 * uid that is already signed in.
 *
 * ── WHY THIS IS NOT A SIGN-IN ────────────────────────────────────────────────
 *
 * Every other phone path in the app calls `verifyOtp`, which signs in with the
 * credential and therefore lands on whatever account that number resolves to.
 * That is exactly wrong here: it would hand a guest a different uid, and their
 * document, diamonds and history would be left behind on the anonymous account
 * nobody can ever reach again — an anonymous credential cannot be re-obtained
 * once the local copy is gone. So this calls `linkPhone`, which attaches the
 * credential to the CURRENT uid and changes nothing else about the account.
 */
@HiltViewModel
class SecureAccountViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SecureAccountUiState())
    val state: StateFlow<SecureAccountUiState> = _state.asStateFlow()

    // Held as members so neither is collected while the reCAPTCHA activity is in
    // front of us — the same reason AuthViewModel keeps its callbacks.
    private var callbacks: PhoneAuthProvider.OnVerificationStateChangedCallbacks? = null
    private var verificationId: String? = null

    /**
     * FX-15: a link (and its server bind) is in flight. Distinct from `busy`,
     * which is also set while the SMS is being sent — instant verification must
     * still be able to link then. Callbacks and taps arrive on the main thread.
     */
    private var linkInFlight = false

    /** Text a code to [phoneE164]. [activity] is Firebase's, for the reCAPTCHA fallback. */
    fun sendCode(phoneE164: String, activity: Activity) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null, phoneE164 = phoneE164) }

        callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                /*
                 * Play Services answered the SMS itself. Link with the credential
                 * it produced, not with a credential rebuilt from `smsCode` —
                 * that field is null on instant verification, where there is no
                 * SMS at all, so rebuilding would strand the person on a code box
                 * for a code that is never going to arrive.
                 *
                 * The code is still copied into the state when there is one, so
                 * the boxes fill in under the spinner and the step does not look
                 * like it skipped itself.
                 */
                _state.update { s -> s.copy(code = credential.smsCode ?: s.code) }
                // FX-15: the person may already have typed the code and pressed
                // "Add this number" — that link is the one that counts, and a
                // second link of the same credential would only report an error
                // over a success.
                if (SubmitGuard.mayStart(linkInFlight)) link(credential)
            }

            override fun onVerificationFailed(e: FirebaseException) {
                _state.update { it.copy(busy = false, error = e.message ?: "Could not send the code.") }
            }

            override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                verificationId = id
                /*
                 * Only advance from the number step.
                 *
                 * Instant verification can complete before the SMS is reported as
                 * sent, and a resend arrives here while the code step is already
                 * up. Moving stage unconditionally would drag somebody back to an
                 * empty code box with a link already in flight.
                 */
                if (_state.value.stage == SecureAccountStage.Phone) {
                    _state.update { it.copy(busy = false, stage = SecureAccountStage.Code, code = "") }
                } else {
                    _state.update { it.copy(busy = false) }
                }
            }
        }
        repo.sendOtp(phoneE164, activity, callbacks!!)
    }

    fun onCode(code: String) = _state.update { it.copy(code = code.filter { ch -> ch.isDigit() }.take(6)) }

    /** Build the credential from the typed code and attach it to this account. */
    fun submitCode() {
        val id = verificationId ?: return
        val code = _state.value.code
        if (code.length != 6 || _state.value.busy) return
        val credential = try {
            PhoneAuthProvider.getCredential(id, code)
        } catch (e: Exception) {
            _state.update { it.copy(busy = false, error = e.message ?: "That code could not be checked.") }
            return
        }
        link(credential)
    }

    private fun link(credential: PhoneAuthCredential) {
        if (!SubmitGuard.mayStart(linkInFlight)) return
        linkInFlight = true
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                // The number they just verified, so `linkPhone` can refuse to bind a
                // different one left attached by an attempt they abandoned.
                when (val res = repo.linkPhone(credential, _state.value.phoneE164)) {
                    is AuthResult.Success ->
                        _state.update { it.copy(busy = false, stage = SecureAccountStage.Done) }

                    is AuthResult.IdentityTaken -> {
                        /*
                         * Who holds it — asked ONLY to put a name on a refusal that
                         * has already happened, server-side, on rules this app does
                         * not get a say in.
                         *
                         * Worth the extra call because the commonest holder is the
                         * person's own older account: "already used by Priya" is what
                         * makes somebody recognise that, where "used by another
                         * account" reads as a fault on our side and becomes a support
                         * ticket. `findExistingAccount` returns an empty list on any
                         * failure, so a bad connection here costs a name and nothing
                         * else.
                         *
                         * Asked AFTER the attempt, never before it. A pre-check would
                         * be a second opinion on "is this number available", decided
                         * from a different query than the one that actually rules on
                         * it — and the moment those two disagree the app is refusing
                         * numbers the server would have allowed, or promising ones it
                         * will not.
                         *
                         * The server's own message is deliberately not carried into
                         * the screen: it ends "sign in to that account instead",
                         * which is sound advice for a person who has an account to go
                         * back to and terrible advice for a guest, who would be
                         * walking away from the balance they came here to protect.
                         */
                        val holder = repo.findExistingAccount(phone = _state.value.phoneE164).firstOrNull()
                        _state.update {
                            it.copy(
                                busy = false,
                                stage = SecureAccountStage.Taken,
                                heldByName = holder?.name.orEmpty(),
                                heldByPhotoUrl = holder?.photoUrl.orEmpty(),
                            )
                        }
                    }

                    is AuthResult.Error ->
                        _state.update { it.copy(busy = false, error = res.message) }

                    /*
                     * `linkPhone` returns only the three above. This is here because
                     * `AuthResult` is shared with the four sign-in paths and carries
                     * bans, observers and recovery windows for them — none of which
                     * can be reached by attaching a number to a session that is
                     * already signed in, and all of which would be silently swallowed
                     * by an empty `else`.
                     */
                    else -> _state.update {
                        it.copy(busy = false, error = "That number could not be added. Please try again.")
                    }
                }
            } finally {
                linkInFlight = false
            }
        }
    }

    /**
     * Start again with a different number.
     *
     * The verification id goes with it. Keeping it would leave a code box that
     * validates against the previous number's SMS, which is how somebody ends up
     * being told a perfectly correct code is wrong.
     */
    fun useDifferentNumber() {
        // FX-15: never while a link is being made or bound — this UNLINKS the
        // phone, and doing it mid-bind left Firestore saying the number was
        // bound while Firebase Auth no longer held it (RF-28). The Back arrow
        // and the button both arrive here.
        if (!SubmitGuard.mayStart(_state.value.busy || linkInFlight)) return
        verificationId = null
        /*
         * Drop any phone provider left attached by the attempt being abandoned.
         *
         * `linkPhone`'s link step is idempotent — a dangling link is reused on
         * the next attempt, which is right for retrying the SAME number and
         * wrong here. Without this, the person verifies B by SMS and the bind
         * sends A, because A is what is on the account and on the token.
         *
         * AWAITED, not fire-and-forget. The only way to arrive here with a link
         * still attached is the transient-failure path — a bad connection —
         * which is precisely when this unlink fails too. Dropping the result
         * would move the wrong-number bind behind an unreported failure instead
         * of removing it. (`linkPhone` refuses that bind anyway, but a person
         * told what happened can act; a silent mismatch two screens later
         * cannot be acted on at all.)
         *
         * `busy` is held for the round trip, which also closes a race: without
         * it a fresh `sendCode` could start while the unlink is in flight —
         * `sendCode` early-returns on `busy`.
         *
         * On the refusal path the rollback has already run, so
         * `discardPendingPhoneLink` returns true with no network call and the
         * spinner is never seen.
         */
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val cleared = repo.discardPendingPhoneLink()
            _state.update {
                it.copy(
                    stage = SecureAccountStage.Phone,
                    busy = false,
                    error = if (cleared) null else
                        "We could not release the previous number. Check your " +
                        "connection and tap this again.",
                    code = "",
                    phoneE164 = "",
                    heldByName = "",
                    heldByPhotoUrl = "",
                )
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
}
