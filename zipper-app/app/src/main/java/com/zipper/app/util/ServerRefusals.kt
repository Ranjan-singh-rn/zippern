package com.zipper.app.util

import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * P0-1: the server's two session refusals, from ANY callable, delivered to the
 * one place that knows how to act on them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `assertActiveSession` (functions/src/mobileSession.ts) refuses a protected
 * callable with `details.code`:
 *
 *   SESSION_DISPLACED   the sign-in on this device predates the account's
 *                       cut-off, or its session id is no longer the active one;
 *   ACCOUNT_RESTRICTED  the account is banned, suspended, or being deleted.
 *
 * The app had no handling for either (0 references). Each repository turned
 * the refusal into a toast on whatever screen made the call, and the person
 * stayed on a device that every protected action would now refuse, with no
 * explanation. The Firestore listener in `SessionViewModel` catches most of
 * these on its own — but not a cut-off moved without a new session (a
 * suspension that was lifted, a deletion request), and not a refusal that
 * arrives before the listener's next snapshot.
 *
 * So every callable wrapper reports its `FirebaseFunctionsException` here, and
 * `SessionViewModel` turns a recognised refusal into the same sign-out or
 * restriction screen its listener uses. The wrappers still return their own
 * failure as before: this is in addition, not instead.
 */
object ServerRefusals {

    const val SESSION_DISPLACED = "SESSION_DISPLACED"
    const val ACCOUNT_RESTRICTED = "ACCOUNT_RESTRICTED"

    enum class Kind { Displaced, Restricted }

    /** Which refusal a server detail code names, or null for anything else. Pure. */
    fun classify(detailCode: String?): Kind? = when (detailCode?.trim()) {
        SESSION_DISPLACED -> Kind.Displaced
        ACCOUNT_RESTRICTED -> Kind.Restricted
        else -> null
    }

    private val _events = MutableSharedFlow<Kind>(extraBufferCapacity = 8)

    /** Recognised refusals, as they arrive. Collected by `SessionViewModel`. */
    val events: SharedFlow<Kind> = _events.asSharedFlow()

    /**
     * Report a failed callable. Returns what was recognised, or null.
     * Never throws: this runs on every failure path in the app.
     */
    fun report(e: FirebaseFunctionsException): Kind? {
        val kind = classify(detailCodeOf(e)) ?: return null
        _events.tryEmit(kind)
        return kind
    }

    @Suppress("UNCHECKED_CAST")
    fun detailCodeOf(e: FirebaseFunctionsException): String = try {
        ((e.details as? Map<String, Any?>)?.get("code") as? String).orEmpty()
    } catch (_: Exception) {
        ""
    }
}
