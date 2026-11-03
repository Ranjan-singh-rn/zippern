package com.zipper.app.data.model

/**
 * One message addressed to a single user — the personal half of the Official
 * tab, as opposed to [BroadcastMessage], which goes to everybody.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The top-level `notifications` collection has had writers for a long time and
 * never had a reader. Four Cloud Functions wrote to it (recharge approved,
 * recharge delayed, agency approved, payout approved) and the backend now
 * writes an official warning there too — and the Official tab read only
 * `broadcasts`, so a user who had been formally warned, or whose recharge had
 * failed, saw "Nothing from Zipper yet".
 *
 * ── `userId`, NOT `targetUid` ───────────────────────────────────────────────
 *
 * The deployed rule is
 *
 *     match /notifications/{notifId} {
 *       allow read: if (request.auth != null
 *                       && resource.data.userId == request.auth.uid)
 *                   || isAdmin();
 *     }
 *
 * so `userId` is the only field that can make one of these readable by the
 * person it is about. The four Functions writers emitted `targetUid`, which
 * that rule does not look at; they have been corrected to `userId`. Documents
 * written before that correction carry no `userId`, do not match the query's
 * equality filter, and are simply absent — not an error, just invisible, which
 * is what they already were.
 */
data class UserNotification(
    val id: String = "",
    /** `warning`, `recharge_approved`, `recharge_delayed`, `agency_approved`, `payout_approved`. */
    val type: String = "",
    val title: String = "",
    val body: String = "",
    val createdAt: Long = 0L,
    val isRead: Boolean = false,
    /**
     * What the notice is about — a ticket id, a recharge id, a partner record
     * — when the writer named one. The backend's notice writer
     * (`services/notices.py`) puts it under `meta` (`ticket_id`, `partner_id`,
     * …) and the canonical shape names it `relatedId`; both are read.
     */
    val relatedId: String = "",
    /**
     * The reason the decision was taken, when the notice carries one (a ban, a
     * suspension, a rejection — `notices.py` writes it as its own `reason`
     * field, apart from the body). QA (3 Nov 2026): never read, so "Your Zipper
     * account is banned" arrived without the reason the email gave.
     */
    val reason: String = "",
) {
    /**
     * A warning is the one kind of notice that is a moderation decision rather
     * than news, and the tab marks it differently so it is not read as an
     * announcement. It is also the only kind that can be appealed.
     */
    val isWarning: Boolean get() = type == "warning"
}
