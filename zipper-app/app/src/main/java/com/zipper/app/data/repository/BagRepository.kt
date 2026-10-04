package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.BagItem
import com.zipper.app.data.model.BagPurchaseResult
import com.zipper.app.data.model.OwnedItem
import com.zipper.app.util.millis
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BagRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val money: MoneyFunctions,
) {

    private val users get() = firestore.collection("users")

    /**
     * Real-time stream of what [uid] owns, keyed by item id.
     *
     * Reads the whole document rather than its id. It used to collect only ids,
     * which made "owned" mean "a row exists" — and `expireCosmetics` marks a
     * lapsed row `{ expired: true, expiredAt }` and leaves it there, so the id
     * outlives the ownership it once proved. Every timed cosmetic therefore read
     * as owned forever: no Renew was ever offered, and the Equip button happily
     * wrote an expired frame back onto the profile the sweep had just cleared.
     *
     * No `where` clause on purpose. Filtering `expired == false` server-side
     * would hide exactly the rows the screen needs in order to offer a renewal,
     * and it would need a composite index to combine with the expiry range.
     * Whether a row counts is [OwnedItem.isExpiredAt]'s job, at the moment of
     * asking.
     */
    fun ownedItemsFlow(uid: String): Flow<Map<String, OwnedItem>> = callbackFlow {
        val listener = users.document(uid).collection("ownedItems")
            .addSnapshotListener { snap, _ ->
                val owned = snap?.documents.orEmpty().associate { doc ->
                    doc.id to OwnedItem(
                        // `itemId` is written by purchaseBagItem and equals the
                        // document id; rows created before it was written have
                        // only the id.
                        itemId            = doc.getString("itemId") ?: doc.id,
                        category          = doc.getString("category") ?: "",
                        // A permanent item has `expiresAt: null`, which reads as
                        // 0 — the same thing the model means by permanent.
                        expiresAt         = doc.millis("expiresAt"),
                        expired           = doc.getBoolean("expired") ?: false,
                        durationDaysTotal = (doc.getLong("durationDaysTotal") ?: 0L).toInt(),
                    )
                }
                trySend(owned)
            }
        awaitClose { listener.remove() }
    }

    /**
     * Buy a cosmetic, or renew one.
     *
     * `purchaseBagItem` prices it, checks both level gates, checks the item is
     * active and actually offered to this account, and extends an existing
     * expiry rather than replacing it. The client version checked the price it
     * was handed, and nothing else — an item reserved for one account, or
     * switched off in the CRM, was buyable by anyone who knew its id.
     *
     * Only [BagItem.id] and the chosen term are sent. The price on the object is
     * for display; [durationDays] must be one of the item's own
     * [BagItem.durations] or the server refuses it.
     */
    suspend fun purchaseItem(
        item: BagItem,
        durationDays: Int? = null,
        idempotencyKey: String = money.newIdempotencyKey(),
    ): BagPurchaseResult = when (
        val res = money.purchaseBagItem(item.id, durationDays, idempotencyKey)
    ) {
        is MoneyFunctions.Result.Ok -> BagPurchaseResult.Success
        is MoneyFunctions.Result.Failed ->
            // The server's message carries the numbers ("This costs 900, you
            // have 420"), which is more use than the typed variant, whose
            // `required`/`current` the client no longer knows.
            BagPurchaseResult.Error(res.userMessage)
    }

    /**
     * Wear an item.
     *
     * ── THIS USED TO BE A CLIENT WRITE, AND THAT MADE COSMETICS OPTIONAL ─────
     *
     * It wrote `users/{uid}.equippedFrame` (or one of four siblings) directly,
     * and `firestore.rules` did not protect those fields — they were absent from
     * `ownerProtectedFields()`, so the owner-update clause allowed them, and no
     * rule compared the value against `users/{uid}/ownedItems`. Anyone with a
     * console could wear a cosmetic they had never bought. The app hit the same
     * hole by accident: `expireCosmetics` clears the pointer on the hour, the
     * Equip button wrote it straight back, and an unpaid cosmetic blinked off
     * and on forever.
     *
     * Those fields are protected now and `equipBagItem` owns them. It checks the
     * item is owned, that it has not expired — against `expiresAt`, not the
     * hourly `expired` flag — and that the category on the request matches the
     * item's real one, so a cheap frame cannot be worn in the expensive entrance
     * slot by simply claiming to be one.
     *
     * The local expiry check below stays, because refusing on the device is
     * instant and says something useful; the server's refusal is the one that
     * actually holds.
     */
    suspend fun equipItem(item: BagItem) {
        if (item.expired || (item.isTimed && item.expiresAt <= System.currentTimeMillis())) {
            throw IllegalStateException("${item.name} has expired — renew it to wear it again.")
        }
        if (equippedFieldFor(item.category) == null) {
            // An unknown category used to return silently, which meant a
            // category added in the CRM produced a button that did nothing at
            // all. The server refuses it too; saying so is better than a shrug.
            throw IllegalStateException("${item.name} cannot be worn yet.")
        }
        when (val res = money.equipBagItem(item.id, item.category)) {
            is MoneyFunctions.Result.Ok -> Unit
            is MoneyFunctions.Result.Failed -> throw IllegalStateException(res.userMessage)
        }
    }

    /** Take off whatever is worn in [category]. Empty id means "none". */
    suspend fun unequipItem(category: String) {
        if (equippedFieldFor(category) == null) return
        when (val res = money.equipBagItem("", category)) {
            is MoneyFunctions.Result.Ok -> Unit
            is MoneyFunctions.Result.Failed -> throw IllegalStateException(res.userMessage)
        }
    }

    /**
     * Whether this category has a slot at all.
     *
     * The categories are the CRM's: frame, chat_bubble, profile_card, id_frame,
     * entrance. An older version of this map had a `"profile_cover"` key that no
     * category ever produced, and no key for `profile_card` or `id_frame` — so
     * equipping either fell through `else` and silently overwrote the avatar
     * frame.
     *
     * The field names are no longer used to WRITE anything — `equipBagItem` owns
     * that, and `EQUIP_POINTERS` in functions/src/wallet.ts is the one true copy.
     * They are kept here only so the app can tell a wearable category from one it
     * does not understand without a round trip.
     */
    private fun equippedFieldFor(category: String): String? = when (category) {
        "frame"        -> "equippedFrame"
        "chat_bubble"  -> "equippedChatBubble"
        "profile_card" -> "equippedProfileCard"
        "id_frame"     -> "equippedIdFrame"
        "entrance"     -> "equippedEntrance"
        else           -> null
    }
}
