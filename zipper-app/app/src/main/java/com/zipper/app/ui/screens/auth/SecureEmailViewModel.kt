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

/**
 * The email link, on its way from the Android intent that carried it to the
 * ViewModel that can use it.
 *
 * ── WHY A PROCESS-LEVEL OBJECT AND NOT A NAVIGATION ARGUMENT ─────────────────
 *
 * The link arrives at `MainActivity` as an `ACTION_VIEW` intent, which is two
 * layers below the nav graph and one composition away from any ViewModel. The
 * obvious alternative — put it in the route — is wrong twice: the link is a
 * long URL with a one-time credential in its query string, and a route is a
 * string that gets encoded, logged by the nav library, and kept in the back
 * stack for as long as the screen lives.
 *
 * Same pattern and same reasoning as [ForcedSignOut] one file over: a one-shot
 * hand-off between two parts of the app that have no other way to reach each
 * other. CONSUMED rather than read, so a link cannot be replayed by a
 * configuration change — and so the credential is not left sitting in memory
 * after it has been spent.
 *
 * The cold-start case is why this is an object rather than a field on the
 * Activity: tapping the link may START the process, in which case the value is
 * delivered before the screen exists at all. A `StateFlow` replays its current
 * value to whoever collects it next, so the ViewModel picks it up whenever it
 * happens to be created.
 */
object EmailLinkReturn {
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    /** Called from `MainActivity` when an intent turns out to be a sign-in link. */
    fun deliver(link: String) { _pending.value = link }

    /**
     * Take the link, leaving nothing behind.
     *
     * Not atomic, and does not need to be: both the delivery and this are on
     * the main thread, and there is exactly one collector.
     */
    fun consume(): String? {
        val link = _pending.value
        _pending.value = null
        return link
    }
}

/** Which step of the email binding flow is on screen. See `SecureEmailScreen`. */
enum class SecureEmailStage {
    /** Typing the address. */
    Email,

    /**
     * The link has been sent, and the app is waiting for it to be opened.
     *
     * Also the step the person is on while the returned link is being
     * exchanged — that is `busy` on this stage rather than a fifth stage of its
     * own, because it is the same waiting seen from the other end and a screen
     * that flashes through an extra step reads as a glitch.
     */
    Sent,

    /**
     * The address is held by another live account, and that is the end of it.
     *
     * A stage of its own rather than an error on [Sent] for the reason the
     * phone flow has one: an error is something to retype and this is not.
     */
    Taken,

    /** Bound. The guest account has an email on it now, same uid and all. */
    Done,
}

data class SecureEmailUiState(
    val stage: SecureEmailStage = SecureEmailStage.Email,
    val busy: Boolean = false,
    /** Something went wrong and is worth retrying. Never the refusal — see [SecureEmailStage.Taken]. */
    val error: String? = null,
    /** Lower-cased and trimmed, as it was sent. Shown on the sent step, and looked up on refusal. */
    val email: String = "",
    /**
     * Whose account holds the address, when we could find out. Blank otherwise,
     * and the screen simply says less. Decoration on a refusal that has already
     * been decided — never an input to it.
     */
    val heldByName: String = "",
    val heldByPhotoUrl: String = "",
)

/**
 * Turning a guest into a permanent account, by attaching an email address to
 * the uid that is already signed in.
 *
 * ── WHY THIS IS NOT A SIGN-IN, AND HAS NO PASSWORD ───────────────────────────
 *
 * Both for the same reasons as [SecureAccountViewModel]. Signing in with the
 * credential would resolve to whatever account the address belongs to and hand
 * this person a different uid, leaving their diamonds and history on an
 * anonymous account nobody can open again — an anonymous credential cannot be
 * re-obtained once the local copy is gone. So `AuthRepository.linkEmail`
 * attaches the credential to the CURRENT uid and changes nothing else.
 *
 * And the credential is a one-time link, never a password. The app has no
 * email+password sign-in anywhere and must not gain one: what the server wants
 * is proof that this person reads that mailbox, which a link gives directly,
 * and a password would only add a second secret to lose and a second recovery
 * flow to build.
 */
@HiltViewModel
class SecureEmailViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SecureEmailUiState())
    val state: StateFlow<SecureEmailUiState> = _state.asStateFlow()

    init {
        /*
         * Collected for the life of the ViewModel rather than checked once,
         * because the link can arrive at three different moments: before this
         * screen exists (a cold start from the mail app), while it is on screen
         * in the background (the ordinary case), or after a failed attempt when
         * the person opens a second link. A `StateFlow` covers the first for
         * free by replaying, and the other two by simply emitting again.
         */
        viewModelScope.launch {
            EmailLinkReturn.pending.collect { link ->
                if (link == null) return@collect
                EmailLinkReturn.consume()
                complete(link)
            }
        }
    }

    /**
     * Send the link.
     *
     * No pre-check that the address is free. It would be a second opinion on a
     * question `bindVerifiedIdentity` is the only authority on, decided from a
     * different query — and the moment the two disagree the app is refusing
     * addresses the server would have allowed, or promising ones it will not.
     * The same reasoning as the phone flow's, written out at
     * [SecureAccountViewModel].
     */
    fun sendLink(email: String) {
        if (_state.value.busy) return
        val address = email.trim().lowercase()
        _state.update { it.copy(busy = true, error = null, email = address) }
        viewModelScope.launch {
            when (val res = repo.sendEmailSignInLink(address)) {
                is AuthResult.Success ->
                    _state.update { it.copy(busy = false, stage = SecureEmailStage.Sent) }

                is AuthResult.Error ->
                    _state.update { it.copy(busy = false, error = res.message) }

                /*
                 * `sendEmailSignInLink` returns only the two above. This is here
                 * because `AuthResult` is shared with the sign-in paths and
                 * carries bans, observers and recovery windows for them — none
                 * of which can be reached by mailing a link from a session that
                 * is already signed in, and all of which an empty `else` would
                 * swallow.
                 */
                else -> _state.update {
                    it.copy(busy = false, error = "We could not send that email. Please try again.")
                }
            }
        }
    }

    /** Same address, second attempt. The previous link stays valid; this is not a reset. */
    fun resend() = sendLink(_state.value.email)

    /**
     * A link came back. Exchange it for a binding.
     *
     * Suspend, and called from inside the collector, so two links opened in
     * quick succession are processed one after the other rather than racing
     * each other through `linkWithCredential`.
     */
    private suspend fun complete(link: String) {
        /*
         * The address is read back from disk whenever this ViewModel does not
         * have it, which is the COMMON case rather than the odd one: tapping a
         * link in a mail app is exactly the journey during which Android kills
         * the process it came from. See `SessionManager.KEY_PENDING_EMAIL`.
         */
        val address = _state.value.email.ifBlank { repo.pendingEmailAddress() }
        if (address.isBlank()) {
            _state.update {
                it.copy(
                    stage = SecureEmailStage.Email,
                    busy = false,
                    error = "We no longer have the address that link was sent to. " +
                        "Enter it again and we will send a new one.",
                )
            }
            return
        }

        // Onto the waiting step even if the person arrived here cold, so the
        // spinner is over "Check your email" rather than over an empty form
        // they are being invited to fill in a second time.
        _state.update {
            it.copy(stage = SecureEmailStage.Sent, busy = true, error = null, email = address)
        }

        when (val res = repo.linkEmail(link, address)) {
            is AuthResult.Success ->
                _state.update { it.copy(busy = false, stage = SecureEmailStage.Done) }

            is AuthResult.IdentityTaken -> {
                /*
                 * Who holds it — asked ONLY to put a name on a refusal that has
                 * already happened, server-side, on rules this app does not get
                 * a say in.
                 *
                 * Worth the extra call because the commonest holder is the
                 * person's own older account: "already used by Priya" is what
                 * makes somebody recognise that, where "used by another account"
                 * reads as a fault on our side and becomes a support ticket.
                 * `findExistingAccount` returns an empty list on any failure, so
                 * a bad connection here costs a name and nothing else.
                 *
                 * The server's own message is deliberately not carried into the
                 * screen: it ends "sign in to that account instead", which is
                 * sound advice for somebody with an account to go back to and
                 * terrible advice for a guest, who would be walking away from
                 * the balance they came here to protect.
                 */
                val holder = repo.findExistingAccount(email = address).firstOrNull()
                _state.update {
                    it.copy(
                        busy = false,
                        stage = SecureEmailStage.Taken,
                        heldByName = holder?.name.orEmpty(),
                        heldByPhotoUrl = holder?.photoUrl.orEmpty(),
                    )
                }
            }

            is AuthResult.Error ->
                _state.update { it.copy(busy = false, error = res.message) }

            // See the note on the same branch in `sendLink`.
            else -> _state.update {
                it.copy(busy = false, error = "That address could not be added. Please try again.")
            }
        }
    }

    /**
     * Start again with a different address.
     *
     * AWAITED, and the reasoning is `useDifferentNumber`'s exactly: the link
     * step is idempotent, so a provider left attached by an abandoned attempt
     * is REUSED on the next one — right for retrying the same address, and
     * wrong here, where it means the person opens a link for B and has A bound.
     * `linkEmail` refuses that bind, but a person told what happened can act on
     * it and a silent mismatch two screens later cannot be acted on at all.
     *
     * The stored address is dropped in the same call, because it is the input
     * to the next `getCredentialWithLink` — see `discardPendingEmailLink`.
     *
     * `busy` is held for the round trip, which also closes a race: without it a
     * fresh `sendLink` could start while the unlink is in flight, and `sendLink`
     * early-returns on `busy`.
     *
     * On the refusal path the rollback has already run, so
     * `discardPendingEmailLink` returns true with no network call and the
     * spinner is never seen.
     */
    fun useDifferentEmail() {
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val cleared = repo.discardPendingEmailLink()
            _state.update {
                it.copy(
                    stage = SecureEmailStage.Email,
                    busy = false,
                    error = if (cleared) null else
                        "We could not release the previous address. Check your " +
                        "connection and tap this again.",
                    email = "",
                    heldByName = "",
                    heldByPhotoUrl = "",
                )
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
}
