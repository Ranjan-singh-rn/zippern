package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/** One row of a profile's gift showcase: a gift, and how many times. */
data class GiftHistoryEntry(
    val giftId: String = "",
    val giftName: String = "",
    val emoji: String = "",             // plain-text emoji fallback for display
    val imageUrl: String = "",
    val quantity: Int = 1,
)

data class GiftItem(
    val id: String = "",
    val name: String = "",
    val costDiamonds: Long = 0L,        // cost of ONE gift (field: "diamondCost" in Firestore)
    val isLucky: Boolean = false,
    val emoji: String = "🎁",           // plain-text emoji for display fallback
    val imageUrl: String = "",          // Firebase Storage URL for grid thumbnail (SVG/PNG)
    val lottieAsset: String = "",       // Bundled asset key OR remote URL for the overlay animation
    val category: String = "normal",    // "normal" | "lucky" | "special"
)

sealed class GiftResult {
    object Success : GiftResult()
    data class LuckyWin(val multiplier: Int, val diamondsBack: Long) : GiftResult()
    data class Error(val message: String) : GiftResult()
    object InsufficientDiamonds : GiftResult()
}

/**
 * The gift catalogue, or the reason there isn't one.
 *
 * [GiftRepository.fetchGifts] flattens a failure into an empty list, which
 * collapses the one distinction a screen needs: "the CRM has no active gifts"
 * and "we could not reach Firestore" arrive as the same empty list, so the UI
 * cannot offer a retry for the second and cannot honestly describe the first.
 * That is how a profile ended up opening its gift sheet on ten invented gifts
 * and saying nothing — the failure had nowhere to go. Anything that renders a
 * state to a person should use [GiftRepository.fetchGiftCatalogue].
 */
sealed interface GiftCatalogue {
    data class Ok(val gifts: List<GiftItem>) : GiftCatalogue
    data class Failed(val message: String) : GiftCatalogue
}

@Singleton
class GiftRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
    private val money: MoneyFunctions,
) {

    /**
     * Send a gift from the signed-in user to [targetUid].
     *
     * The work happens in the `settleGift` Cloud Function. This method sends
     * what the user chose and reports what came back — it does not price the
     * gift, check the balance, or touch a balance document.
     *
     * @param targetUid Receiver's Firebase UID
     * @param gift      The gift chosen. Only [GiftItem.id] is sent; the server
     *                  reads the price from the `gifts` collection, so a
     *                  tampered client cannot buy a 9,999 gift for 1.
     * @param quantity  1, or a combo count (17 / 37 / 77)
     * @param roomId    Live/party room id, or null for a 1-on-1 send
     *
     * [targetName] and [senderName] are unused now — the server reads both
     * names from the user documents. They stay on the signature so the dozen
     * call sites keep compiling; drop them when the UI is rebuilt.
     *
     * Note on [GiftResult.LuckyWin]: the server does not yet roll lucky gifts,
     * so this never returns it. Chance mechanics are deliberately unshipped —
     * they are what India's Online Gaming Act 2025 reaches, and that needs a
     * legal opinion before any money rides on a random number.
     */
    suspend fun sendGift(
        targetUid: String,
        gift: GiftItem,
        quantity: Int = 1,
        roomId: String? = null,
        targetName: String = "",
        senderName: String = "",
        /**
         * Stable across retries of ONE tap. Generate it when the user presses
         * send and reuse it for every retry of that press — a fresh key per
         * retry defeats the server's replay guard and charges twice.
         */
        idempotencyKey: String = money.newIdempotencyKey(),
    ): GiftResult {
        // Everything that used to happen here — balance checks, the price
        // calculation, the receiver percentage, seven document writes across two
        // accounts — now happens in the settleGift Cloud Function.
        //
        // The client had no business doing any of it. It set its own price, wrote
        // its own balance, and could be modified to do neither honestly.
        // LiveRepository.sendGiftInLive did not even check the balance, so
        // gifting drove it negative.
        //
        // Only the gift id and the recipient leave the device.
        val qty = quantity.coerceIn(1, 9999)
        val context = if (roomId.isNullOrBlank()) "dm" else "live"

        return when (val res = money.settleGift(
            giftId = gift.id,
            receiverUid = targetUid,
            quantity = qty,
            context = context,
            roomId = roomId,
            idempotencyKey = idempotencyKey,
        )) {
            is MoneyFunctions.Result.Ok -> GiftResult.Success
            is MoneyFunctions.Result.Failed -> when (res.code) {
                // The server phrases this one with the actual numbers, which is
                // more use than a generic "not enough diamonds".
                "FAILED_PRECONDITION" ->
                    if (res.userMessage.contains("diamond", ignoreCase = true)) {
                        GiftResult.InsufficientDiamonds
                    } else {
                        GiftResult.Error(res.userMessage)
                    }
                else -> GiftResult.Error(res.userMessage)
            }
        }
    }

    /**
     * Public gift showcase for [uid] — the "Gifts Sent" tab.
     *
     * Reads `users/{uid}/giftShowcase`, which `settleGift` maintains. The tabs
     * previously read `giftsSent` / `giftsReceived`, which nothing has ever
     * written, so both sections were empty on every profile in the app.
     *
     * This is the anonymous half of the design on purpose: a gift and a count,
     * visible to anyone. Who sent it to whom lives in `giftTransactions`, which
     * only the two parties can read. The "you sent this x2" highlight comes
     * from `giftPairs` and belongs to the profile UI, not here.
     */
    fun giftsSentFlow(uid: String): Flow<List<GiftHistoryEntry>> =
        showcaseFlow(uid, "sentCount")

    /** Public gift showcase for [uid] — the "Gifts Received" tab. */
    fun giftsReceivedFlow(uid: String): Flow<List<GiftHistoryEntry>> =
        showcaseFlow(uid, "receivedCount")

    private fun showcaseFlow(uid: String, countField: String): Flow<List<GiftHistoryEntry>> =
        callbackFlow {
            val reg = firestore.collection("users").document(uid)
                .collection("giftShowcase")
                .addSnapshotListener { snap, _ ->
                    val entries = snap?.documents.orEmpty().mapNotNull { doc ->
                        // A showcase doc carries both counts. Zero in this
                        // direction means the gift belongs to the other tab.
                        val count = doc.getLong(countField) ?: 0L
                        if (count <= 0L) return@mapNotNull null
                        GiftHistoryEntry(
                            giftId   = doc.getString("giftId") ?: doc.id,
                            giftName = doc.getString("displayName") ?: "",
                            emoji    = doc.getString("emoji")?.takeIf { it.isNotBlank() } ?: "\uD83C\uDF81",
                            imageUrl = doc.getString("iconUrl") ?: "",
                            quantity = count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
                        )
                    }.sortedByDescending { it.quantity }
                    trySend(entries)
                }
            awaitClose { reg.remove() }
        }

    /**
     * The active gifts from Firestore `gifts`, ordered by sortOrder — or why not.
     *
     * The message on [GiftCatalogue.Failed] is ours, not the exception's:
     * Firestore phrases its own failures as "PERMISSION_DENIED: Missing or
     * insufficient permissions", which is a line for a log, not for somebody who
     * wanted to send a rose.
     */
    suspend fun fetchGiftCatalogue(): GiftCatalogue =
        try {
            GiftCatalogue.Ok(
                firestore.collection("gifts")
                    .whereEqualTo("isActive", true)
                    .orderBy("sortOrder")
                    .get().await()
                    .documents.mapNotNull { doc ->
                        val category = doc.getString("category") ?: "normal"
                        GiftItem(
                            id           = doc.id,
                            name         = doc.getString("name")         ?: return@mapNotNull null,
                            // CRM writes "diamondCost"; legacy docs may have "costDiamonds"
                            costDiamonds = doc.getLong("diamondCost")    ?: doc.getLong("costDiamonds") ?: 0L,
                            isLucky      = category == "lucky",
                            emoji        = doc.getString("emoji")        ?: "🎁",
                            imageUrl     = doc.getString("imageUrl")     ?: "",
                            lottieAsset  = doc.getString("lottieAsset")  ?: "",
                            category     = category,
                        )
                    }
            )
        } catch (_: Exception) {
            GiftCatalogue.Failed("Couldn't load gifts — check your connection.")
        }

    /**
     * Fetch available gifts, or an empty list if the read failed.
     *
     * The lossy shape, kept for the live / party / call drawers that have no
     * retry affordance to feed yet. Note what it means for a caller: an empty
     * return says nothing about whether anything went wrong, so a caller that
     * treats "empty" as "keep whatever I had" is deciding to ignore failures it
     * never saw. Prefer [fetchGiftCatalogue].
     */
    suspend fun fetchGifts(): List<GiftItem> =
        when (val res = fetchGiftCatalogue()) {
            is GiftCatalogue.Ok -> res.gifts
            is GiftCatalogue.Failed -> emptyList()
        }
}
