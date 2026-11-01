package com.zipper.app.data.model

import com.zipper.app.util.millis

data class ActiveCall(
    val callId: String = "",
    val callerId: String = "",
    val callerName: String = "",
    val callerPhotoUrl: String = "",
    val receiverId: String = "",
    val receiverName: String = "",
    val receiverPhotoUrl: String = "",
    val status: String = "ringing",      // ringing | connected | ended | declined | missed
    val channelName: String = "",        // Agora channel = callId
    val startedAt: Long = 0L,            // epoch ms when both connected
    val createdAt: Long = 0L,            // epoch ms when caller initiated
    val endedAt: Long = 0L,
    val endReason: String = "",          // caller_ended | receiver_ended | diamonds_exhausted | network | pip_closed
    val perMinRateDiamonds: Long = 0L,   // computed at create time, stored so both sides agree
    /** "caller" | "receiver" — who EARNS. The other side pays. A host calling a user earns. */
    val earner: String = "receiver",
    // ── Per-minute billing (APK 20 / calls.ts) — written by the server only ──
    /** `minute` on every call connected under the whole-minute rule; absent on legacy ten-second calls. */
    val billingUnit: String = "",
    /** The server's counter of what it has billed: whole minutes, or ten-second ticks on a legacy call. */
    val tickIndex: Long = 0L,
    /** When the next whole minute is charged; 0 before the call connected. */
    val billedThroughMs: Long = 0L,
    /** Running totals, both sides can read them: what the payer has spent and the earner has been credited. */
    val diamondsCharged: Long = 0L,
    val beansCredited: Long = 0L,
) {
    /** Whole minutes charged so far, whichever rule the call was connected under (mirrors `billedMinutesOf`). */
    val minutesBilled: Long
        get() = if (billingUnit == "minute") tickIndex.coerceAtLeast(0L)
        else (tickIndex.coerceAtLeast(0L) + 5L) / 6L
    val payerId: String get() = if (earner == "caller") receiverId else callerId
    val earnerId: String get() = if (earner == "caller") callerId else receiverId

    companion object {
        /**
         * Explicit parse, not `toObject()`.
         *
         * `toObject` maps a Firestore Timestamp onto a `Long` field by throwing,
         * and the server writes `startedAt`, `createdAt` and `endedAt` as
         * Timestamps. So every listener that used `toObject` on a call document
         * died on the first real one: incoming calls never rang, and the in-call
         * screen never left "connecting". This reads each time field through
         * [millis], which accepts either representation.
         */
        fun from(doc: com.google.firebase.firestore.DocumentSnapshot): ActiveCall? {
            if (!doc.exists()) return null
            return ActiveCall(
                callId             = doc.id,
                callerId           = doc.getString("callerId") ?: "",
                callerName         = doc.getString("callerName") ?: "",
                callerPhotoUrl     = doc.getString("callerPhotoUrl") ?: "",
                receiverId         = doc.getString("receiverId") ?: "",
                receiverName       = doc.getString("receiverName") ?: "",
                receiverPhotoUrl   = doc.getString("receiverPhotoUrl") ?: "",
                status             = doc.getString("status") ?: "ringing",
                channelName        = doc.getString("channelName") ?: doc.id,
                startedAt          = doc.millis("startedAt"),
                createdAt          = doc.millis("createdAt"),
                endedAt            = doc.millis("endedAt"),
                endReason          = doc.getString("endReason") ?: "",
                perMinRateDiamonds = doc.getLong("perMinRateDiamonds") ?: 0L,
                earner             = doc.getString("earner") ?: "receiver",
                billingUnit        = doc.getString("billingUnit") ?: "",
                // `get` + Number, not `getLong`: a value that went through
                // JavaScript arithmetic can land as a Double, and `getLong`
                // on one throws inside a snapshot callback.
                tickIndex          = (doc.get("tickIndex") as? Number)?.toLong() ?: 0L,
                billedThroughMs    = (doc.get("billedThroughMs") as? Number)?.toLong() ?: 0L,
                diamondsCharged    = (doc.get("diamondsCharged") as? Number)?.toLong() ?: 0L,
                beansCredited      = (doc.get("beansCredited") as? Number)?.toLong() ?: 0L,
            )
        }
    }
}

data class CallChatMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val message: String = "",
    val timestamp: Long = 0L,
)
