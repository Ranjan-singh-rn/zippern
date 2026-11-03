package com.zipper.app.util

/**
 * QA #31 (3 Nov 2026) — telling a sign-out the APP made from one Firebase made
 * on its own.
 *
 * Firebase ends a session by itself when the account's refresh tokens stop
 * working: the account was disabled, deleted, its tokens revoked, or a "major
 * account change" expired them (QA #30 was one). The SDK then sets
 * `currentUser` to null and tells its listeners — and nothing in the app
 * listened. The person stayed in the main shell with every read refused: 0
 * diamonds, empty lists, no message.
 *
 * `SessionViewModel` now listens. A loss is UNEXPECTED — and sends the person
 * to Login with "Your session has expired. Please sign in again." — when:
 *   * somebody was signed in a moment ago and now nobody is, and
 *   * the app itself did not just sign out ([expect] was not called in the last
 *     [EXPECTED_WINDOW_MS]); every `signOut()` the app makes calls it first.
 *
 * A window rather than a flag: Firebase delivers the state change to its
 * listeners later, on the main thread, so a flag cleared right after
 * `signOut()` returned would already be gone when the listener ran.
 *
 * Pure apart from the clock it is handed — `AuthLossTest` runs it on the JVM.
 */
object AuthLoss {
    const val EXPECTED_WINDOW_MS = 15_000L

    @Volatile
    private var expectedAtMs = Long.MIN_VALUE / 2

    /** Call immediately before every sign-out the app makes on purpose. */
    fun expect(nowMs: Long = System.currentTimeMillis()) {
        expectedAtMs = nowMs
    }

    /** True when [wasUid] → [nowUid] is a session Firebase ended on its own. */
    fun isUnexpected(wasUid: String?, nowUid: String?, nowMs: Long = System.currentTimeMillis()): Boolean =
        !wasUid.isNullOrBlank() && nowUid.isNullOrBlank() && nowMs - expectedAtMs > EXPECTED_WINDOW_MS

    /** Test hook: forget any expected sign-out. */
    internal fun reset() {
        expectedAtMs = Long.MIN_VALUE / 2
    }
}
