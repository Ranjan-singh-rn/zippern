package com.zipper.app.util

/**
 * RF-30 — a write whose answer never arrived is not a write that failed.
 *
 * The partner bridge (`functions/src/index.ts`, `apiRefusalToHttpsError`)
 * gives the API 25 s. An application or recharge the API filed but answered
 * late used to come back as "Zipper could not be reached. Please try again."
 * The person was told it failed when it had not; pressing Submit again met
 * "Your application is already with a reviewer", and a recharge filed with a
 * screenshot and no reference was filed twice.
 *
 * The bridge now says so: `deadline-exceeded` with `details.code`
 * [OUTCOME_UNKNOWN]. The same is true of the SDK's own deadline and of a
 * connection lost while the request was in flight. [unknown] recognises all
 * three; a caller that writes then looks (an application) or repeats the same
 * request id (a recharge) instead of saying it failed.
 *
 * Pure — no Android, no Firebase — so `WriteOutcomeTest` proves it on the JVM.
 */
object WriteOutcome {

    /** The bridge's `details.code` for a write that may or may not have happened. */
    const val OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"

    /**
     * @param code the `FirebaseFunctionsException.Code` name.
     * @param detailCode its `details.code`, or "" / null.
     * @param transport true when no server answer was received at all — an
     *   `IOException` under the exception, or no Functions exception at all.
     */
    fun unknown(code: String, detailCode: String?, transport: Boolean): Boolean =
        detailCode?.trim() == OUTCOME_UNKNOWN || code == "DEADLINE_EXCEEDED" || transport
}
