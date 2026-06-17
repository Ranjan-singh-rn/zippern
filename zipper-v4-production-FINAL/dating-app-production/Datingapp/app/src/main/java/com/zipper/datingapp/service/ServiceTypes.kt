package com.zipper.datingapp.service

// ─────────────────────────────────────────────────────────────────────────────
// INCOMING CALL INVITE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight call signal received via RTDB / Firestore signaling.
 * Mapped into [com.zipper.datingapp.ui.IncomingCallUi] for UI display.
 */
data class IncomingCallInvite(
    val roomId: String,
    val callerId: String,
    val callerName: String = "",
    val callerPhotoUrl: String = "",
    val isVideoCall: Boolean = true,
    /** True for the local marketing hook synthetic call (no actual signaling). */
    val isMarketingSynthetic: Boolean = false,
)

// ─────────────────────────────────────────────────────────────────────────────
// PK MATCH RESULT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned from PK matchmaking ([FirebaseService.findOrCreatePkMatch]).
 */
sealed class PkMatchResult {
    data class Matched(
        val roomId: String,
        val partnerUserId: String,
        val partnerStreamId: String,
        val isStreamer: Boolean,
        val durationSeconds: Int = 300,
    ) : PkMatchResult()

    /** No opponent found yet — caller should wait and poll. */
    object Waiting : PkMatchResult()

    data class Error(val message: String) : PkMatchResult()
}

// ─────────────────────────────────────────────────────────────────────────────
// GIFT TRANSFER RESULT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned from [FirebaseService.processGiftTransfer].
 */
sealed class GiftTransferResult {
    data class Success(val senderBalance: Int) : GiftTransferResult()
    data class Failed(val reason: String) : GiftTransferResult()
}
