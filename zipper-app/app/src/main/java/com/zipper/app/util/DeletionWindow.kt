package com.zipper.app.util

/**
 * HOW LONG A DELETED ACCOUNT CAN COME BACK, AND WHAT HAPPENS ONCE IT CANNOT.
 *
 * ── TWO DEFECTS, ONE NUMBER (C8 — B27, B28) ─────────────────────────────────
 *
 * The server keeps a deleted account recoverable for SIXTY days
 * (`GRACE_DAYS` in functions/src/accounts.ts), and stamps `deletionDueAt` at
 * request time. The app said thirty — in the Settings dialog, in the privacy
 * policy and on the recovery screen — so a person was told their account
 * would be gone a month before it was. And this file's copy of the number
 * lived as an unused constant in `AuthRepository` that also said thirty.
 *
 * The other half was the end of the window. `resolveIdentity` answers
 * `deleted_permanent` for an account past its due date (the daily sweep may
 * not have released the login yet), and the sign-in gate let that fall
 * through to the ordinary path — straight into a dead account. Recovery after
 * the date is now refused by the server with `RECOVERY_EXPIRED`. Both are read
 * here, and both end in the same place: a plain "this account was deleted"
 * and a sign-out, never an entry.
 *
 * Imports nothing, so `DeletionWindowTest` proves it on the JVM.
 */
object DeletionWindow {

    /**
     * Days a deletion can be undone. Must match `GRACE_DAYS` in
     * functions/src/accounts.ts. Copy that can name the server's own due date
     * (`deletionDueAt`) does so instead — an account deleted before the window
     * was lengthened keeps the deadline it was given.
     */
    const val GRACE_DAYS = 60

    /** `details.code` on `recoverAccount`'s refusal after `deletionDueAt`. */
    const val RECOVERY_EXPIRED = "RECOVERY_EXPIRED"

    /** `resolveIdentity`'s decision for an account whose window has closed. */
    const val DELETED_PERMANENT = "deleted_permanent"

    /**
     * What the person is told. No number in it: an account deleted before the
     * window was lengthened had thirty days, and this sentence is true either
     * way.
     */
    const val ACCOUNT_DELETED =
        "This account was deleted and its recovery period has ended, so it can no longer " +
            "be opened. Its history is kept, but the account cannot be restored."

    /** Did `recoverAccount` refuse because the window has closed? */
    fun isRecoveryExpired(detail: String?): Boolean = detail?.trim() == RECOVERY_EXPIRED

    /** Does this `resolveIdentity` decision mean the account must not be entered? */
    fun endsAccount(decision: String?): Boolean = decision?.trim() == DELETED_PERMANENT
}
