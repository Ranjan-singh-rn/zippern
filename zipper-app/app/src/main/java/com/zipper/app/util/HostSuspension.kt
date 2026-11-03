package com.zipper.app.util

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Spec §5 "partner role suspension", for the HOST role — the app's side.
 *
 * Staff suspend ONLY the Host capability (`POST /api/users/{uid}/suspend-host`,
 * backend `users.suspend_host`): the account, its other roles, the agency
 * roster row, the verification and the earnings stay, and `isHost` stays true.
 * What stops is acting AS a Host — going live, the publisher token, earning on
 * a call, setting a rate, Host home — and every one of those server paths
 * refuses with `details.code = HOST_ROLE_SUSPENDED` and one sentence:
 *
 *   Your Host role is suspended until 4 Nov 2026, 3:45 pm IST — reason: …
 *
 * This object says the same sentence from the account's own document
 * (`users/{uid}.hostSuspended` / `hostSuspendedUntil` / `hostSuspendedReason`,
 * server-written only) so a screen can say why BEFORE trying — going live is a
 * direct Firestore create the rules refuse with a bare PERMISSION_DENIED.
 *
 * NOT a session refusal: the account is not restricted, so nothing here goes
 * near `ServerRefusals` (whose ACCOUNT_RESTRICTED signs the device out).
 *
 * Pure — `HostSuspensionActionsTest` runs it on the JVM.
 */
object HostSuspension {

    /** `HttpsError.details.code` when the caller's OWN Host role is suspended. */
    const val CODE = "HOST_ROLE_SUSPENDED"

    /** What a third party calling a suspended host gets — never the reason or the date. */
    const val UNAVAILABLE_CODE = "HOST_UNAVAILABLE"

    /** `checkReferralCode`'s `reason` for a suspended Host. */
    const val REFERRAL_REASON = "host_suspended"

    private val MONTHS = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /**
     * `04 Nov 2026, 10:15 UTC` — the backend's `email.when` and the Functions'
     * `whenUtc`, written out by hand (no locale formatter) so all three agree.
     */
    fun whenUtc(epochMs: Long): String {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.ROOT)
        c.timeInMillis = epochMs
        fun pad(n: Int) = n.toString().padStart(2, '0')
        return "${pad(c.get(Calendar.DAY_OF_MONTH))} ${MONTHS[c.get(Calendar.MONTH)]} ${c.get(Calendar.YEAR)}, " +
            "${pad(c.get(Calendar.HOUR_OF_DAY))}:${pad(c.get(Calendar.MINUTE))} UTC"
    }

    /**
     * QA #54 — `4 Nov 2026, 3:45 pm IST`: the backend's `email.when` and the
     * Functions' `whenIst`, written out by hand (no locale formatter) so all
     * three agree. People read times in India Standard Time; stored values stay UTC.
     */
    fun whenIst(epochMs: Long): String = IstTime.format(epochMs)

    /**
     * The server's sentence, word for word. [untilMs] null or ≤ 0 means the
     * suspension runs until somebody resumes it; a blank [reason] drops the
     * `— reason: …` part rather than printing an empty one.
     */
    fun message(untilMs: Long?, reason: String?): String {
        val until = if (untilMs != null && untilMs > 0L) whenIst(untilMs) else "it is resumed"
        val why = reason?.trim().orEmpty()
        return "Your Host role is suspended until $until" + (if (why.isNotEmpty()) " — reason: $why" else "")
    }

    /** Strict, like every server gate: a Host whose `hostSuspended` is true. */
    fun isSuspended(isHost: Boolean, hostSuspended: Boolean): Boolean = isHost && hostSuspended

    /** The sentence for this account's own document, or null when its Host role is not suspended. */
    fun messageFor(isHost: Boolean, hostSuspended: Boolean, untilMs: Long, reason: String): String? =
        if (isSuspended(isHost, hostSuspended)) message(untilMs, reason) else null

    /** Was a callable refused because the caller's OWN Host role is suspended? */
    fun isRefusal(detailCode: String?): Boolean = detailCode?.trim() == CODE
}
