package com.zipper.app.ui.screens.partner

import com.zipper.app.data.repository.PartnerFunctions

/**
 * RF-30 — what the app says after a filing whose outcome is unknown
 * ([com.zipper.app.util.WriteOutcome]).
 *
 * ── AN APPLICATION ──────────────────────────────────────────────────────────
 *
 * The person's own applications are re-read (`myPartnerApplications`, which
 * lists Host applications too) a few times, a few seconds apart, because the
 * API may still be finishing. A PENDING application of the kind just
 * submitted means it is with a reviewer: a fresh filing is always pending,
 * and one that was already pending would have made this submission a
 * refusal — either way that is the truth the person needs, so the form moves
 * to Done. Nothing found is NOT "it failed" (the API may still be writing):
 * the person is told it could not be confirmed and where to look.
 *
 * ── A RECHARGE ──────────────────────────────────────────────────────────────
 *
 * The form carries one request id, the same on every retry; the API answers a
 * repeat with the request it already filed. So the honest instruction is to
 * send again — it cannot be filed twice.
 *
 * Pure apart from the [PartnerFunctions.Application] shape, so
 * `FilingConfirmationTest` proves it on the JVM.
 */
object FilingConfirmation {

    /** Looks, and the wait between them: the API's own 25 s plus up to ~6 s more. */
    const val ATTEMPTS = 3
    const val SPACING_MS = 3_000L

    /** The pending application of [kind] the server now shows, or null. */
    fun pendingApplicationId(kind: String, applications: List<PartnerFunctions.Application>): String? =
        applications.firstOrNull { it.kind == kind && it.status == "pending" && it.id.isNotBlank() }?.id

    const val APPLICATION_NOT_CONFIRMED =
        "We couldn't confirm that your application was received. Check Partner hub in a minute " +
            "before applying again — if it isn't listed there, apply again."

    const val RECHARGE_NOT_CONFIRMED =
        "We couldn't confirm that your request was received. Tap Send again — " +
            "the same request will not be filed twice."

    /** A reinstatement request (C2): the server returns the one already open, so sending again is safe. */
    const val APPEAL_NOT_CONFIRMED =
        "We couldn't confirm that your request was received. If it isn't shown on this role " +
            "in a moment, send it again — it will not be filed twice."
}
