package com.zipper.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.AccountRestriction
import com.zipper.app.data.model.restrictionOf
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.util.SessionManager
import com.zipper.app.util.millis
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

/** Monitors the active session in real-time.
 *
 *  When a user logs in on a second device:
 *  - The server overwrites `users/{uid}.activeMobileSession` with a record
 *    describing the new device.
 *  - This snapshot listener detects the mismatch and emits [SessionEvent.KickedOut],
 *    carrying the name of the device that took over so the person can be told.
 *
 *  When an admin bans or suspends the user mid-session:
 *  - Firestore's `isBanned` becomes true — for BOTH, because it is the gate.
 *  - This snapshot listener asks `restrictionOf` which of the two it is and
 *    emits [SessionEvent.Banned] or [SessionEvent.Suspended] accordingly. They
 *    are separate events because they land on separate screens: a suspension
 *    leaves the device alone, so that screen offers a way back to Login.
 *
 *  Only `startMobileSession` (a callable, server-side) ever writes the session
 *  fields, and it runs on app sign-in only. THE CRM NEVER WRITES THEM, which is
 *  why a staff member can have the web console and the app open at the same time
 *  without either one throwing the other out — web sign-in is not an app session
 *  and does not claim the field this listener compares. The CRM's own session
 *  lives in its own token, in `backend/app/core/security.py`.
 */
sealed class SessionEvent {
    /**
     * Another device claimed the one allowed mobile session.
     *
     * [replacedByDeviceName] is `activeMobileSession.deviceName` — the handset
     * that took over, as the server recorded it. Empty on an account whose
     * session predates the structured record, or when the server had no model
     * string to store; callers must cope with that rather than printing
     * "opened on a ." at somebody.
     */
    data class KickedOut(val replacedByDeviceName: String) : SessionEvent()

    /** The account is banned, and every device it has used is barred with it. */
    data class Banned(val reason: String) : SessionEvent()

    /**
     * The account is suspended: shut out temporarily, WITH THE DEVICE LEFT
     * ALONE.
     *
     * Carries the end date as well as the reason because the screen has to be
     * able to say when it is over, and there is nowhere else for it to read
     * that from: the listener is stopped the moment the app navigates to the
     * suspended screen (see MainActivity's deny list), so a second read from
     * there would be a second round trip for a value this snapshot already
     * held.
     *
     * [untilMillis] is 0 for an INDEFINITE suspension — the CRM omits
     * `suspendedUntil` for one that runs until a reviewer lifts it. Zero is not
     * "already over", and the screen must not format it as a date.
     */
    data class Suspended(val reason: String, val untilMillis: Long) : SessionEvent()
}

/**
 * Why the last sign-out happened, waiting for the login screen to explain it.
 *
 * ── WHY THIS IS NOT A NAVIGATION ARGUMENT ────────────────────────────────────
 *
 * Every forced sign-out lands on Login with `popUpTo(0) { inclusive = true }` —
 * the whole back stack goes, so there is no `previousBackStackEntry` left to
 * hang a `savedStateHandle` value on, and `Screen.Login.route` is a bare
 * "login" compared by identity in half a dozen places (MainActivity's
 * destination listener, every `popUpTo(Screen.Login.route)`), so giving it an
 * argument would mean touching all of them.
 *
 * Same pattern and same reasoning as `LiveSummaryGifters`: a one-shot hand-off
 * between two destinations for a value that is a nicety, not a fact. If the
 * process dies in between, the worst case is a login screen with no
 * explanation — exactly what it did before this existed.
 *
 * CONSUMED rather than read, so the message appears once. A person who was
 * kicked out on Tuesday should not be told about it again on Friday.
 */
object ForcedSignOut {

    /**
     * Another device signed in and took the one allowed app session, and we do
     * not know which one.
     *
     * The fallback for [anotherDevice]. Kept as the wording for an account whose
     * session was claimed by a build that only wrote the old flat
     * `sessionToken` string, which carried no device information at all.
     */
    const val ANOTHER_DEVICE =
        "You were signed out because your account was opened on another device."

    /** The Firebase credential no longer loads — expired, revoked, or disabled. */
    const val SESSION_EXPIRED =
        "Your session has expired. Please sign in again."

    /**
     * The same message, naming the handset that took over.
     *
     * ── WHY THE NAME IS WORTH THE TROUBLE ────────────────────────────────────
     *
     * "Your account was opened on another device" is true and useless. The two
     * readings a person reaches for are "I have been hacked" and "the app is
     * broken", and neither is actionable. "…opened on a Motorola" is: they
     * either recognise their own second handset and stop worrying, or they do
     * not recognise it and now have a concrete reason to change their password.
     * Support gets the same sentence in the ticket.
     *
     * Falls back to [ANOTHER_DEVICE] on a blank name rather than emitting
     * "opened on a ." — an empty `deviceName` is normal for a session claimed
     * by an older build.
     */
    fun anotherDevice(deviceName: String): String {
        val name = deviceName.trim()
        if (name.isEmpty()) return ANOTHER_DEVICE
        return "You were signed out because your account was opened on ${article(name)} $name."
    }

    /**
     * "a Motorola", "an Oppo".
     *
     * Crude on purpose: `Build.MODEL` is whatever the manufacturer wrote, so
     * there is no dictionary to consult and the first letter is the only signal
     * available. Getting it wrong costs one awkward article in one sentence;
     * not trying costs "a Oppo" for every Oppo owner.
     */
    private fun article(name: String): String {
        val first = name.firstOrNull()?.lowercaseChar() ?: ' '
        val vowel = first == 'a' || first == 'e' || first == 'i' || first == 'o' || first == 'u'
        return if (vowel) "an" else "a"
    }

    @Volatile
    var reason: String? = null
        private set

    fun raise(reason: String) { this.reason = reason }

    /** The pending message, cleared as it is handed over. */
    fun consume(): String? {
        val pending = reason
        reason = null
        return pending
    }
}

@HiltViewModel
class SessionViewModel @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val sessionManager: SessionManager,
    /**
     * Injected purely for [tearDownSession].
     *
     * Before this, the forced-logout paths each hand-rolled their own cleanup
     * and no two of them matched — see [tearDownSession] for what each one
     * forgot. The repository already owns the one correct sequence; the only
     * thing missing was somebody signed-in-adjacent who could reach it, and a
     * ViewModel Hilt already builds is the cheapest place to stand.
     */
    private val repo: AuthRepository,
) : ViewModel() {

    private val _events = MutableSharedFlow<SessionEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<SessionEvent> = _events.asSharedFlow()

    private var listenerRegistration: com.google.firebase.firestore.ListenerRegistration? = null

    /**
     * Whose document [listenerRegistration] is attached to.
     *
     * Kept so [startWatching] can be called from anywhere, as often as it likes,
     * and cost nothing when it is already watching the right account. It is now
     * called on EVERY signed-in destination change (see MainActivity), and
     * without this guard walking Home → Settings → Home would tear the listener
     * down and re-register it twice, at the price of a fresh document read each
     * time and a window of a few milliseconds per navigation in which nothing
     * was watching at all.
     */
    private var watchingUid: String? = null

    fun startWatching() {
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        // Already attached to this account's document. Do not churn it.
        if (listenerRegistration != null && watchingUid == uid) return
        stopWatching()
        watchingUid = uid

        listenerRegistration = firestore.collection("users").document(uid)
            .addSnapshotListener { snap, _ ->
                if (snap == null || !snap.exists()) return@addSnapshotListener

                /*
                 * A MODERATION DECISION TAKEN WHILE THEY WERE USING THE APP.
                 *
                 * Asked first, before the session comparison, exactly as it was
                 * before: somebody who has just been shut out of the product
                 * should be told that, not told their account was opened
                 * somewhere else.
                 *
                 * What is new is WHICH. This used to read `isBanned` alone and
                 * emit Banned, so a mid-session suspension threw the person
                 * onto the banned screen — no end date, no way back to Login,
                 * and the word "banned" for something that ends on Tuesday.
                 * `isBanned` is still the gate and still means what it meant;
                 * `restrictionOf` is what tells the two apart, reading
                 * `accountState` and falling back to `isSuspended` on documents
                 * written before that field existed.
                 */
                when (restrictionOf(snap)) {
                    AccountRestriction.Suspended -> {
                        val reason = snap.getString("banReason")
                            .orEmpty().ifBlank { "Your account has been suspended." }
                        // `millis`, never `getLong`. This is a Firestore
                        // Timestamp and `getLong` on one raises — inside a
                        // snapshot callback, where there is nobody to catch it.
                        val until = snap.millis("suspendedUntil", 0L)
                        viewModelScope.launch {
                            _events.emit(SessionEvent.Suspended(reason, until))
                        }
                        return@addSnapshotListener
                    }
                    AccountRestriction.Banned -> {
                        val reason = snap.getString("banReason")
                            .orEmpty().ifBlank { "Your account has been banned." }
                        viewModelScope.launch { _events.emit(SessionEvent.Banned(reason)) }
                        return@addSnapshotListener
                    }
                    // Under no restriction. On to the session comparison below,
                    // in the order it has always run.
                    AccountRestriction.None -> Unit
                }

                /*
                 * WHICH DEVICE HOLDS THE SESSION — NEW RECORD FIRST, OLD STRING SECOND.
                 *
                 * The server now writes a structured record:
                 *
                 *   activeMobileSession = { sessionId, deviceId, platform,
                 *                           deviceName, createdAt, lastActiveAt }
                 *
                 * and, for one release, ALSO the old flat `sessionToken` string
                 * holding the same id — see `startMobileSession` in
                 * functions/src/identity.ts. The old string exists solely so a
                 * phone running the previous build, which compares nothing else,
                 * keeps being signed out when it should be; dropping it would
                 * leave every un-updated handset signed in for ever.
                 *
                 * Reading them in this order is what makes the transition work in
                 * both directions. A device on THIS build reads the record and
                 * gets a device name to show. The same device, kicked by an
                 * account whose session was claimed by the PREVIOUS build, finds
                 * no record and falls through to the string — it still gets
                 * signed out, it just cannot say by what.
                 *
                 * `sessionId` is the field to compare, not `deviceId`: two
                 * sign-ins on the same handset are two sessions, and the second
                 * must displace the first. That is the reinstall case.
                 *
                 * Read through Firestore's dot-separated field paths rather than
                 * by pulling the record out as a `Map` and indexing it. Same
                 * result, and it cannot be got wrong: `getString` returns null
                 * for a missing PARENT exactly as it does for a missing child,
                 * so an account that has no `activeMobileSession` at all falls
                 * through to the old string without a null-check of its own.
                 */
                val remoteSessionId = snap.getString("activeMobileSession.sessionId")
                    ?.takeIf { it.isNotBlank() }
                    ?: snap.getString("sessionToken").orEmpty()
                // No session claimed at all: a brand-new document, or one whose
                // session was given up by `endMobileSession`. Nothing to compare
                // against, and emitting here would sign out the only device.
                if (remoteSessionId.isBlank()) return@addSnapshotListener

                val replacedBy = snap.getString("activeMobileSession.deviceName").orEmpty()

                viewModelScope.launch {
                    val localSessionId = sessionManager.sessionToken.first()
                    /*
                     * A BLANK LOCAL ID IS NOT A MISMATCH.
                     *
                     * `generateSession` treats a failed session claim as
                     * survivable — the person is authenticated, and refusing them
                     * the app because one callable did not land would be worse
                     * than two devices coexisting until the next launch. That
                     * leaves SessionManager empty on this phone. Comparing an
                     * empty local id against a live remote one would read as
                     * "somebody else took the session" and sign out the only
                     * device using the account, over a dropped network call.
                     */
                    if (localSessionId.isNotBlank() && remoteSessionId != localSessionId) {
                        _events.emit(SessionEvent.KickedOut(replacedBy))
                    }
                }
            }
    }

    fun stopWatching() {
        listenerRegistration?.remove()
        listenerRegistration = null
        watchingUid = null
    }

    /**
     * The complete teardown for a sign-out NOBODY ASKED FOR.
     *
     * ── WHAT THE THREE OLD COPIES EACH FORGOT ────────────────────────────────
     *
     * There were three forced-logout paths and no two of them did the same
     * thing:
     *
     *  - MainActivity's KickedOut handler dropped the push token and called
     *    `FirebaseAuth.signOut()`. It never cleared [SessionManager], so this
     *    phone went on holding a session token for an account whose session it
     *    had just lost.
     *  - SplashScreen's "the credential will not load" branch called
     *    `FirebaseAuth.signOut()` and nothing else — the push token stayed
     *    registered against the uid, so the account carried on ringing a phone
     *    that could no longer answer.
     *  - SplashScreen's session-mismatch branch cleared [SessionManager] but
     *    not the push token.
     *
     * And none of the three minted a quick-login secret first. For a GUEST that
     * is the difference between an account and a deleted one: `signOut()`
     * destroys the only copy of an anonymous credential, so a guest with a
     * balance who was kicked out by another device lost the balance with it. See
     * `AuthRepository.signOut`, which is the one place that gets this right and
     * is now the only implementation any of these paths uses.
     *
     * Quick login is deliberately NOT forgotten here. Somebody displaced by
     * another device still owns the account and should get back in with one tap;
     * forgetting the device is the explicit choice in Settings.
     *
     * Suspending rather than fire-and-forget so a caller that is about to be
     * torn down — SplashScreen navigates away the instant this returns — can
     * await it instead of racing it.
     */
    suspend fun tearDownSession() {
        stopWatching()
        try {
            /*
             * `mintQuickLogin = false`. This is a FORCED teardown — the session
             * was taken by another device — and minting here would give the
             * displaced handset a credential that redeems straight back into the
             * account it was just removed from.
             *
             * Any credential this device already held is revoked SERVER-SIDE by
             * `startMobileSession` on the displacing device, which deletes the
             * previous holder's credentials as part of the same transaction that
             * replaces the session. So there is nothing to clear here, and
             * nothing this handset can do to keep one.
             */
            repo.signOut(mintQuickLogin = false)
        } catch (_: Exception) {
            /*
             * Every step inside `signOut()` is best-effort except the last two,
             * and those two are the ones that must not be skipped: a person
             * whose session was taken cannot be left holding a live Firebase
             * credential and a local session token. Do them by hand and move on.
             */
            try { sessionManager.clear() } catch (_: Exception) {}
            FirebaseAuth.getInstance().signOut()
        }
    }

    /**
     * [tearDownSession] for a caller that cannot suspend.
     *
     * Runs in `viewModelScope`, which for the instance MainActivity holds lives
     * as long as the Activity — so the teardown finishes even though the caller
     * navigates to Login in the next line rather than waiting. Being displaced
     * is not a moment to sit on a spinner.
     */
    fun forceSignOut() {
        stopWatching()
        viewModelScope.launch { tearDownSession() }
    }

    override fun onCleared() {
        stopWatching()
        super.onCleared()
    }
}
