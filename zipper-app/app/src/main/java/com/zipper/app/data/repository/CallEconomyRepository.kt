package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.EconomyEngine
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Handles all monetary settling when a paid call ends.
 *
 * Call cost = callDurationSeconds * perSecondRate
 * perSecondRate comes from the host's callRateBeans field
 * (for user-to-user calls use a platform default).
 *
 * Diamonds deducted from caller; Beans credited to beneficiary.
 */
@Singleton
class CallEconomyRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) {

    companion object {
        /** Default call cost per minute for user-to-user calls (in diamonds) */
        const val DEFAULT_USER_CALL_RATE_PER_MIN = 10L
    }

    /**
     * Settle economy at end of a call.
     *
     * @param callerUid        UID of caller
     * @param receiverUid      UID of receiver
     * @param durationSeconds  Actual connected duration
     * @param perMinuteRate    Diamonds per minute (host's callRateBeans or DEFAULT)
     * @return the settled [EconomyEngine.CallReward] or null on error
     */
    suspend fun settleCall(
        callerUid: String,
        receiverUid: String,
        durationSeconds: Long,
        perMinuteRate: Long,
    ): EconomyEngine.CallReward? {
        if (durationSeconds <= 0L) return null

        return try {
            // Fetch both users' profiles
            val callerDoc   = firestore.collection("users").document(callerUid).get().await()
            val receiverDoc = firestore.collection("users").document(receiverUid).get().await()

            val callerGender   = callerDoc.getString("gender")   ?: "male"
            val callerIsHost   = callerDoc.getBoolean("isHost")  ?: false
            val callerDiamonds = callerDoc.getLong("diamonds")   ?: 0L

            val receiverGender   = receiverDoc.getString("gender")  ?: "male"
            val receiverIsHost   = receiverDoc.getBoolean("isHost") ?: false

            // Total cost in diamonds (round up to nearest 1)
            val totalCost = ((durationSeconds * perMinuteRate) + 59L) / 60L
            val actualCost = minOf(totalCost, callerDiamonds) // can't deduct more than caller has

            val reward = EconomyEngine.callReward(
                callerUid       = callerUid,
                callerGender    = callerGender,
                callerIsHost    = callerIsHost,
                receiverUid     = receiverUid,
                receiverGender  = receiverGender,
                receiverIsHost  = receiverIsHost,
                callCostDiamonds = actualCost,
            ) ?: return null

            val batch = firestore.batch()

            // 1. Deduct diamonds from caller
            batch.update(
                firestore.collection("users").document(callerUid),
                "diamonds", FieldValue.increment(-actualCost),
            )

            // 2. Credit beans to beneficiary
            batch.update(
                firestore.collection("users").document(reward.beneficiaryUid),
                "beans", FieldValue.increment(reward.beansEarned),
            )

            // 3. Write call history entry
            val callRef = firestore.collection("callHistory").document()
            batch.set(callRef, mapOf(
                "callerUid"       to callerUid,
                "receiverUid"     to receiverUid,
                "callerGender"    to callerGender,
                "receiverGender"  to receiverGender,
                "callerIsHost"    to callerIsHost,
                "receiverIsHost"  to receiverIsHost,
                "durationSeconds" to durationSeconds,
                "costDiamonds"    to actualCost,
                "beneficiaryUid"  to reward.beneficiaryUid,
                "beansEarned"     to reward.beansEarned,
                "rewardPercent"   to reward.rewardPercent,
                "timestamp"       to FieldValue.serverTimestamp(),
            ))

            batch.commit().await()
            reward
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Check if caller has enough diamonds for at least 1 minute of a call.
     */
    suspend fun canAffordCall(callerUid: String, perMinuteRate: Long): Boolean {
        return try {
            val snap = firestore.collection("users").document(callerUid).get().await()
            val diamonds = snap.getLong("diamonds") ?: 0L
            diamonds >= perMinuteRate
        } catch (e: Exception) {
            false
        }
    }
}
