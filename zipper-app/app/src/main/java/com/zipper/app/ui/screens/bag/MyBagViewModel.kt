package com.zipper.app.ui.screens.bag

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.model.BagDuration
import com.zipper.app.data.model.BagItem
import com.zipper.app.data.model.BagPurchaseResult
import com.zipper.app.data.model.OwnedItem
import com.zipper.app.data.repository.BagRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

data class MyBagUiState(
    /** The catalogue, from Firestore `bagItems`. Empty means empty. */
    val catalogItems: List<BagItem> = emptyList(),
    /** What this account holds, keyed by item id — including lapsed rows. */
    val ownedById: Map<String, OwnedItem> = emptyMap(),
    val equippedByCategory: Map<String, String> = emptyMap(),
    val isLoading: Boolean = true,
    /**
     * Why the catalogue is not on screen, in words a user can act on.
     *
     * There was no such field, and that absence was the whole bug: with no way
     * to say "could not load", the ViewModel answered a failed read with 33
     * invented items at invented prices. Tapping one called `purchaseBagItem`
     * with an id that exists in no collection, so the server replied "That item
     * no longer exists" — a priced shelf that cannot sell anything, which is
     * worse than an empty one because the user blames themselves.
     */
    val loadError: String? = null,
    /** The item a purchase is in flight for, so a second tap cannot double-charge. */
    val purchasingItemId: String? = null,
    val toastMessage: String? = null,
)

@HiltViewModel
class MyBagViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val bagRepo: BagRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(MyBagUiState())
    val state: StateFlow<MyBagUiState> = _state.asStateFlow()

    /** Cancelled and replaced on retry, so two taps cannot race to set state. */
    private var catalogJob: Job? = null

    init {
        val uid = auth.currentUser?.uid
        if (uid == null) {
            // Reachable: MyBagScreen is composed from the nav graph, and a
            // session that expired while the app was backgrounded lands here.
            // The old code returned without clearing isLoading, which left the
            // screen spinning forever with no explanation.
            _state.update { it.copy(isLoading = false, loadError = "You are signed out. Sign in again to open your bag.") }
        } else {
            loadCatalog(uid)
            loadEquipped(uid)

            // Real-time: a purchase or a renewal changes the expiry, and an
            // hourly sweep can retire an item while the screen is open.
            viewModelScope.launch {
                bagRepo.ownedItemsFlow(uid).collect { owned ->
                    _state.update { it.copy(ownedById = owned) }
                }
            }
        }
    }

    /** Re-read the catalogue after a failure. */
    fun retry() {
        val uid = auth.currentUser?.uid ?: return
        loadCatalog(uid)
        loadEquipped(uid)
    }

    /**
     * The catalogue, filtered to what this account is actually offered.
     *
     * The targeting filter applies to every outcome. It used to be skipped on
     * the failure path, so a failed read did not just invent items — it also
     * widened what the user was shown, offering cosmetics reserved for one
     * account, one gender or one role.
     */
    private fun loadCatalog(uid: String) {
        catalogJob?.cancel()
        catalogJob = viewModelScope.launch {
            _state.update { it.copy(isLoading = true, loadError = null) }
            try {
                // Own profile first: the targeting rules below are about this
                // account, and the server applies the same three in the same
                // order before it will sell anything (wallet.ts, purchaseBagItem).
                val userSnap   = firestore.collection("users").document(uid).get().await()
                val userGender = userSnap.getString("gender") ?: "all"    // "male" | "female" | ...
                val isHost     = userSnap.getBoolean("isHost") ?: false

                val snap = firestore.collection("bagItems")
                    .whereEqualTo("isActive", true)
                    .get()
                    .await()
                val remoteItems = snap.documents.mapNotNull { d ->
                    try {
                        BagItem(
                            id             = d.id,
                            name           = d.getString("name")          ?: return@mapNotNull null,
                            category       = d.getString("category")      ?: return@mapNotNull null,
                            previewUrl     = d.getString("previewUrl")    ?: "",
                            unlockLevel    = (d.getLong("unlockLevel")    ?: 0L).toInt(),
                            minHostLevel   = (d.getLong("minHostLevel")   ?: 0L).toInt(),
                            price          = (d.getLong("price")          ?: 0L).toInt(),
                            source         = d.getString("source")        ?: "marketplace",
                            animationAsset = d.getString("animationAsset") ?: "",
                            animationUrl   = d.getString("animationUrl")   ?: "",
                            videoUrl       = d.getString("videoUrl")       ?: "",
                            svgaUrl        = d.getString("svgaUrl")        ?: "",
                            style          = d.getString("style")          ?: "",
                            targetGender   = d.getString("targetGender")  ?: "all",
                            targetRole     = d.getString("targetRole")    ?: "all",
                            targetUserId   = d.getString("targetUserId")  ?: "",
                            durations      = parseDurations(d.get("durations")),
                            isOwned        = false,
                            isEquipped     = false,
                        )
                    } catch (_: Exception) { null }
                }

                // ── Targeting filter ────────────────────────────────────────────
                // Priority: exclusive user ID > gender > role
                val visibleCatalog = remoteItems.filter { item ->
                    when {
                        // Exclusive to a specific account — only that user sees it
                        item.targetUserId.isNotBlank() -> item.targetUserId == uid
                        // Gender filter (ignore "transgender"/"other" — treat as all)
                        item.targetGender != "all" && userGender in listOf("male", "female") ->
                            item.targetGender == userGender
                        // Role filter — strict exclusive: host ≠ user
                        item.targetRole == "user" -> !isHost
                        item.targetRole == "host" ->  isHost
                        else -> true
                    }
                }

                _state.update { it.copy(
                    catalogItems = visibleCatalog,
                    isLoading    = false,
                    loadError    = null,
                )}
            } catch (e: CancellationException) {
                // A retry cancelled this read, or the screen went away. Neither
                // is a failure to report: swallowing it would let a superseded
                // job write "could not be loaded" over the results of the job
                // that replaced it.
                throw e
            } catch (_: Exception) {
                // The catalogue already on screen is kept: a refresh that fails
                // is no reason to take away items the user could still buy. The
                // screen shows this message only when it has nothing to show.
                _state.update { it.copy(
                    isLoading = false,
                    loadError = "The shop could not be loaded. Every item and price comes from Zipper's server, so there is nothing to show until it answers.",
                )}
            }
        }
    }

    private fun loadEquipped(uid: String) {
        viewModelScope.launch {
            try {
                val snap = firestore.collection("users").document(uid).get().await()
                val equipped = mapOf(
                    "frame"        to (snap.getString("equippedFrame")     ?: ""),
                    "entrance"     to (snap.getString("equippedEntrance")  ?: ""),
                    "chat_bubble"  to (snap.getString("equippedChatBubble")  ?: ""),
                    "profile_card" to (snap.getString("equippedProfileCard") ?: ""),
                    "id_frame"     to (snap.getString("equippedIdFrame")   ?: ""),
                )
                _state.update { it.copy(equippedByCategory = equipped) }
            } catch (_: Exception) {}
        }
    }

    /**
     * The CRM's duration matrix for one item.
     *
     * Nothing in the CRM writes `durations` yet — `purchaseBagItem` has honoured
     * the field since it was written, so reading it here is what makes a term
     * selectable the day an admin starts saving one, rather than a second app
     * release later.
     */
    private fun parseDurations(raw: Any?): List<BagDuration> {
        val rows = raw as? List<*> ?: return emptyList()
        return rows.mapNotNull { entry ->
            // Unchecked, and safe for the same reason as every other Firestore
            // map read here: `as?` yields null on anything that is not a map, and
            // the values are then read with `as? Number`.
            @Suppress("UNCHECKED_CAST")
            val row = entry as? Map<String, Any?> ?: return@mapNotNull null
            val days = (row["days"] as? Number)?.toInt() ?: return@mapNotNull null
            // O9 (5 Nov 2026): 0 days is "for ever" — the Store sells for some days OR permanently, and the server
            // writes no expiry for a 0-day term.
            if (days < 0) return@mapNotNull null
            BagDuration(
                days = days,
                // `priceGems` is the CRM's name and `price` the older one; the
                // server reads `chosen.priceGems ?? chosen.price`, so reading
                // them in the same order is what keeps the quoted price and the
                // charged price the same number.
                priceDiamonds = ((row["priceGems"] ?: row["price"]) as? Number)?.toInt() ?: 0,
            )
        }.sortedBy { if (it.days == 0) Int.MAX_VALUE else it.days }   // the shortest first, "for ever" last
    }

    fun equip(item: BagItem) {
        /*
         * Refused here as well as hidden in the UI, because "owned" and "still
         * valid" are different questions and only one of them used to be asked.
         *
         * This check is a courtesy now rather than the protection. `equipBagItem`
         * on the server owns the cosmetic pointers — the rules stopped letting the
         * client write them — and it re-checks ownership and expiry against the
         * `ownedItems` row with the Admin SDK. Refusing on the device just makes
         * the answer instant and the wording useful.
         */
        if (item.expired || (item.isTimed && item.expiresAt <= System.currentTimeMillis())) {
            _state.update { it.copy(toastMessage = "${item.name} has expired — renew it to wear it again.") }
            return
        }
        viewModelScope.launch {
            try {
                bagRepo.equipItem(item)
                // O9: rooms and chats read what a person wears from their public profile, cached five minutes —
                // forget this person's entry so the next screen shows the new item.
                auth.currentUser?.uid?.let { com.zipper.app.ui.components.UserDecorCache.invalidate(it) }
                _state.update { s ->
                    s.copy(
                        equippedByCategory = s.equippedByCategory + (item.category to item.id),
                        toastMessage = "Equipped ${item.name}",
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(toastMessage = "Failed to equip: ${e.localizedMessage}") }
            }
        }
    }

    /**
     * Buy [item], or renew it for another [durationDays].
     *
     * [durationDays] must be one of the item's own [BagItem.durations]; the
     * server refuses anything else. Omitting it means "the item's single price",
     * which is what a permanent cosmetic costs.
     */
    fun purchase(item: BagItem, durationDays: Int? = null) {
        // One purchase at a time. Each call mints a fresh idempotency key, so
        // two taps are two distinct charges as far as the server is concerned —
        // the key protects a retry of one tap, not a second tap.
        if (_state.value.purchasingItemId != null) return
        _state.update { it.copy(purchasingItemId = item.id) }
        viewModelScope.launch {
            val renewing = item.isTimed || item.expired
            val message = when (val result = bagRepo.purchaseItem(item, durationDays)) {
                is BagPurchaseResult.Success ->
                    if (renewing) "Renewed ${item.name}!" else "Purchased ${item.name}!"
                is BagPurchaseResult.InsufficientDiamonds ->
                    "Need ${result.required} 💎 (have ${result.current})"
                is BagPurchaseResult.Error -> result.message
            }
            // The new expiry arrives through ownedItemsFlow, so nothing here
            // patches ownership by hand — the row the server wrote is the row
            // the screen renders.
            _state.update { it.copy(purchasingItemId = null, toastMessage = message) }
        }
    }

    fun clearToast() {
        _state.update { it.copy(toastMessage = null) }
    }
}
