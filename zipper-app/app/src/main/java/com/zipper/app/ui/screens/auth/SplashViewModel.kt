package com.zipper.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.MoneyFunctions
import com.zipper.app.util.DeletionWindow
import com.zipper.app.util.SessionManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import javax.inject.Inject

/**
 * What the cold-start gate decided. Phase 1A (AUTH-003).
 *
 * The splash used to read `users/{uid}` with the default source — which falls
 * back to the local CACHE when offline — and, on ANY exception, navigate to
 * Main. A suspended or banned account whose phone was offline, or whose read
 * failed for any reason, walked straight into the app. Now the gate asks the
 * server (`resolveIdentity`) with a bounded retry and, if it cannot get an
 * answer, stops on a recoverable error screen instead of guessing.
 */
sealed interface SplashVerdict {
    /** The server answered and nothing restricts entry. */
    data object Continue : SplashVerdict
    data class DeviceBanned(val reason: String) : SplashVerdict
    data class Banned(val reason: String) : SplashVerdict
    data class Suspended(val reason: String, val untilMs: Long) : SplashVerdict
    data object Recover : SplashVerdict
    /** The account was refused for a reason that ends the session (the observer). */
    data object SignOut : SplashVerdict
    /**
     * C8 (B27): deleted, and the recovery window has closed. Ends the session
     * like [SignOut], and says why on the login screen — it used to sign out
     * with no word at all, so the person simply found themselves at Login.
     */
    data class AccountDeleted(val message: String) : SplashVerdict
    /** No authoritative answer after the retries. Fail CLOSED; offer retry. */
    data class Unverified(val message: String) : SplashVerdict
}

object SplashGate {
    const val MAX_ATTEMPTS = 3

    /** Backoff before attempt [n] (1-based). Bounded: total wait ≈ 2s. */
    fun backoffMs(n: Int): Long = when (n) { 1 -> 0L; 2 -> 500L; else -> 1_500L }

    /**
     * Pure mapping from the server's answer to a route. `null` means "no
     * answer" and is ALWAYS [SplashVerdict.Unverified] — never Continue.
     */
    fun decide(identity: MoneyFunctions.Identity?): SplashVerdict {
        if (identity == null) {
            return SplashVerdict.Unverified(
                "We couldn't verify your account right now. Check your connection and try again."
            )
        }
        return when (identity.decision) {
            "allow" -> SplashVerdict.Continue
            "device_banned" -> SplashVerdict.DeviceBanned(
                identity.reason.ifBlank { "This device has been blocked from Zipper." }
            )
            "banned" -> SplashVerdict.Banned(identity.reason.ifBlank { "Your account has been banned." })
            "suspended" -> SplashVerdict.Suspended(
                identity.reason.ifBlank { "Your account has been suspended." },
                identity.suspendedUntilMs,
            )
            "deleted_recoverable" -> SplashVerdict.Recover
            DeletionWindow.DELETED_PERMANENT -> SplashVerdict.AccountDeleted(DeletionWindow.ACCOUNT_DELETED)
            "observer_denied" -> SplashVerdict.SignOut
            // An answer this build does not recognise is not permission.
            else -> SplashVerdict.Unverified(
                "We couldn't verify your account right now. Please update the app or try again."
            )
        }
    }

    /** Why a cold start's `reload()` failed, as far as the platform can tell. */
    enum class ReloadFailure {
        /** Firebase refused the credential itself: disabled, deleted, revoked, malformed. */
        CredentialRefused,
        /** Anything else — no network, a timeout, a server hiccup. Says nothing about the account. */
        Unreachable,
    }

    /**
     * B03 — classify a `user.reload()` failure.
     *
     * Splash used to treat EVERY exception here as an expired session and tear
     * it down: a phone opened on a train signed its owner out, and for a GUEST
     * that sign-out destroyed the anonymous credential — the only copy of
     * their account. Only Firebase's definitive refusals end the session now;
     * everything else stops on the existing retry state instead.
     */
    fun reloadFailure(e: Throwable): ReloadFailure = when (e) {
        is FirebaseAuthInvalidUserException,
        is FirebaseAuthInvalidCredentialsException -> ReloadFailure.CredentialRefused
        else -> ReloadFailure.Unreachable
    }

    /** Does this failure end the session? Only a refused credential does. */
    fun endsSession(failure: ReloadFailure): Boolean = failure == ReloadFailure.CredentialRefused
}

/** Thin ViewModel exposing SessionManager, the role refresh and the identity gate to SplashScreen.
 *  SessionManager is a Hilt singleton and cannot be injected directly into a Composable. */
@HiltViewModel
class SplashViewModel @Inject constructor(
    val sessionManager: SessionManager,
    private val authRepository: AuthRepository,
    private val money: MoneyFunctions,
) : ViewModel() {

    /**
     * Ask the server who this is, with a bounded retry. Phase 1A (AUTH-003).
     * Returns [SplashVerdict.Unverified] — never Continue — when every attempt fails.
     */
    suspend fun verifyIdentity(deviceId: String): SplashVerdict {
        var last: MoneyFunctions.Identity? = null
        for (attempt in 1..SplashGate.MAX_ATTEMPTS) {
            delay(SplashGate.backoffMs(attempt))
            val res = withTimeoutOrNull(8_000) { money.resolveIdentity(deviceId) }
            if (res is MoneyFunctions.Result.Ok) { last = res.value; break }
        }
        return SplashGate.decide(last)
    }

    /**
     * Re-derive the partner/staff role flags from `crmUsers/{uid}` on a RESTORED
     * session.
     *
     * `syncRoles()` ran on every explicit sign-in and never on a cold start, so a
     * person who was signed in when the CRM approved (or revoked) their Agency
     * kept the stale flags — no Agency tag, no dashboard — until they signed out
     * and in again. The backend now also pushes the flags at decision time; this
     * is the client half, so a restored session is never more than one launch
     * behind the authoritative record.
     *
     * Bounded and best effort: a slow or failed call must not hold the splash.
     */
    suspend fun refreshRoles() {
        withTimeoutOrNull(4_000) {
            try { authRepository.syncRoles() } catch (_: Exception) { }
        }
    }
}
