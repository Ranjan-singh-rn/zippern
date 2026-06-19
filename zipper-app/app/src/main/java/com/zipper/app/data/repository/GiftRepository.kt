package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.EconomyEngine
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

data class GiftItem(
    val id: String = "",
    val name: String = "",
    val costDiamonds: Long = 0L,
    val isLucky: Boolean = false,
    val animationUrl: String = "",   // Lottie / SVGA URL on Firebase Storage
    val category: String = "normal", // "normal" | "lucky" | "special"
)

sealed class GiftResult {
    object Success : GiftResult()
    data class Error(val message: String) : GiftResult()
    object InsufficientDiamonds : GiftResult()
}

@Singleton
class GiftRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) {

    /**
     * Send a gift from the currently authenticated user to [targetUid].
     *
     * Firestore operations (all in a batch):
     * 1. Deduct [gift.costDiamonds] from sender's diamonds
     * 2. Credit beans to receiver = EconomyEngine.giftBeanReward(cost, isLucky)
     * 3. Write gift event to `giftEvents` collection (for live animation + history)
     * 4. Increment receiver's totalGiftsReceived counter
     */
    suspend fun sendGift(targetUid: String, gift: GiftItem, roomId: String? = null): GiftResult {
        val senderUid = auth.currentUser?.uid ?: return GiftResult.Error("Not authenticated")

        return try {
            // Read sender's current diamonds
            val senderSnap = firestore.collection("users").document(senderUid).get().await()
            val currentDiamonds = senderSnap.getLong("diamonds") ?: 0L

            if (currentDiamonds < gift.costDiamonds) return GiftResult.InsufficientDiamonds

            val beansForReceiver = EconomyEngine.giftBeanReward(gift.costDiamonds, gift.isLucky)

            val batch = firestore.batch()

            // 1. Deduct from sender
            batch.update(
                firestore.collection("users").document(senderUid),
                "diamonds", FieldValue.increment(-gift.costDiamonds),
            )

            // 2. Credit beans to receiver
            batch.update(
                firestore.collection("users").document(targetUid),
                "beans", FieldValue.increment(beansForReceiver),
                "totalGiftsReceived", FieldValue.increment(1L),
            )

            // 3. Gift event (triggers live animation via Firestore listener on stream screen)
            val eventRef = firestore.collection("giftEvents").document()
            batch.set(eventRef, mapOf(
                "senderUid"      to senderUid,
                "receiverUid"    to targetUid,
                "giftId"         to gift.id,
                "giftName"       to gift.name,
                "costDiamonds"   to gift.costDiamonds,
                "beansEarned"    to beansForReceiver,
                "isLucky"        to gift.isLucky,
                "animationUrl"   to gift.animationUrl,
                "roomId"         to (roomId ?: ""),
                "rewardPercent"  to if (gift.isLucky) 5 else 50,
                "timestamp"      to FieldValue.serverTimestamp(),
            ))

            batch.commit().await()
            GiftResult.Success
        } catch (e: Exception) {
            GiftResult.Error(e.message ?: "Gift send failed")
        }
    }

    /** Fetch available gifts from Firestore `gifts` collection */
    suspend fun fetchGifts(): List<GiftItem> {
        return try {
            firestore.collection("gifts")
                .orderBy("costDiamonds")
                .get().await()
                .documents.mapNotNull { doc ->
                    GiftItem(
                        id            = doc.id,
                        name          = doc.getString("name") ?: "",
                        costDiamonds  = doc.getLong("costDiamonds") ?: 0L,
                        isLucky       = doc.getBoolean("isLucky") ?: false,
                        animationUrl  = doc.getString("animationUrl") ?: "",
                        category      = doc.getString("category") ?: "normal",
                    )
                }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
