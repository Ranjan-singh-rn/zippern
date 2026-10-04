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
) {
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
