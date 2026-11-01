package com.zipper.app.ui.screens.profile

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.zipper.app.data.model.User
import com.zipper.app.data.repository.CallRepository
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.data.repository.EconomyConfigRepository
import com.zipper.app.data.repository.GiftCatalogue
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.GiftResult
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.data.repository.GiftItem as RepoGiftItem
import com.zipper.app.util.EconomyEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

// ── UI state ──────────────────────────────────────────────────────────────────

data class OtherUserUiState(
    val user: User? = null,
    val isLoading: Boolean = true,
    val isLiked: Boolean = false,
    val isBlocked: Boolean = false,
    val currentUserDiamonds: Long = 0L,   // viewer's own balance for gift sheet
    val callCostDiamonds: Long = 0L,      // diamond cost/min to call this user (0 = no cost / not host)
    val giftsReceived: List<GiftSummaryItem> = emptyList(),
    /**
     * The CRM gift catalogue, and the three things that can be true of it.
     *
     * There used to be a second list beside this one — `availableGifts`,
     * defaulting to MOCK_GIFTS, ten gifts with ids `g1`..`g10` that exist in no
     * Firestore collection. Nothing rendered it in the end, but while it was the
     * default the sheet could open on gifts nobody could send, and `settleGift`
     * answers `g1` with "That gift no longer exists." — the user picks a gift,
     * taps send, and is told the gift is not real.
     *
     * [catalogueLoading] and [catalogueError] exist so the drawer never has to
     * guess which kind of empty it is looking at: still fetching, fetched and
     * genuinely empty (the CRM has no active gifts), or failed and worth a retry.
     */
    val catalogue: List<RepoGiftItem> = emptyList(),
    val catalogueLoading: Boolean = true,
    val catalogueError: String? = null,
    val giftSending: Boolean = false,
    val errorMessage: String? = null,
    val toastMessage: String? = null,
    val navigateToCall: String? = null,   // non-null = callId to navigate to
    /** Spec §11: the server's roll on the last lucky gift sent from this profile, for the celebration. */
    val luckyWin: GiftResult.LuckyWin? = null,
)

// ── ViewModel ─────────────────────────────────────────────────────────────────

@HiltViewModel
class OtherUserViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val repo: ProfileRepository,
    private val giftRepo: GiftRepository,
    private val callRepo: CallRepository,
    savedStateHandle: SavedStateHandle,
    private val discover: DiscoverRepository,
    private val economyConfig: EconomyConfigRepository,
    private val liveRepo: com.zipper.app.data.repository.LiveRepository,
) : ViewModel() {

    val targetUid: String = checkNotNull(savedStateHandle["uid"])

    private val _uiState = MutableStateFlow(OtherUserUiState())
    val uiState: StateFlow<OtherUserUiState> = _uiState.asStateFlow()

    private var blockedListener: ListenerRegistration? = null
    private var meListener: ListenerRegistration? = null

    // Current viewer's data — needed to compute accurate call cost
    private var currentUserGender: String = ""
    private var currentUserIsHost: Boolean = false
    private var currentUserIsVerifiedHost: Boolean = false
    private var currentUserCallRate: Long = 0L

    init {
        attachUserListener()
        attachBlockedListener()
        attachMeListener()
        checkIsLiked()
        attachGiftsReceivedListener()
        loadGiftCatalogue()
    }

    /** The user tapped "Try again" on a catalogue that failed to load. */
    fun retryGiftCatalogue() = loadGiftCatalogue()

    /**
     * The gift catalogue, from the CRM.
     *
     * This used to seed the state with MOCK_GIFTS and then overwrite it only
     * `if (firestoreGifts.isNotEmpty())`, with a `catch` that was meant to keep
     * the mock list on a network failure. The `catch` could never run:
     * `fetchGifts()` turns its own exception into an empty list, so a dropped
     * connection did not throw, it returned nothing, fell into the isNotEmpty()
     * guard, and left the invented catalogue in place with nothing signalled.
     * Every route through that function ended in the same silent lie.
     *
     * So the state starts empty and loading, and each outcome is now written
     * down: `catalogue` only ever holds gifts the CRM actually has, and a
     * failure sets [OtherUserUiState.catalogueError] instead of substituting
     * data. Clearing the error on entry matters too — a retry that fails again
     * has to re-arm it, and a retry that succeeds must not leave the old message
     * sitting under a full grid.
     */
    private fun loadGiftCatalogue() {
        _uiState.update { it.copy(catalogueLoading = true, catalogueError = null) }
        viewModelScope.launch {
            when (val res = giftRepo.fetchGiftCatalogue()) {
                is GiftCatalogue.Ok -> _uiState.update {
                    it.copy(catalogue = res.gifts, catalogueLoading = false, catalogueError = null)
                }
                is GiftCatalogue.Failed -> _uiState.update {
                    it.copy(catalogueLoading = false, catalogueError = res.message)
                }
            }
        }
    }

    // ── Real-time user doc ────────────────────────────────────────────────────

    /**
     * Someone else's profile, from `publicProfiles`.
     *
     * Was a listener on their `users/{uid}` document deserialised into `User`,
     * which brought their phone number, email, date of birth, device id, FCM
     * token and balances down with it — for anyone who opened their profile.
     */
    private fun attachUserListener() {
        viewModelScope.launch {
            discover.profileFlow(targetUid).collect { profile ->
                _uiState.update {
                    it.copy(
                        user = profile?.toUser(),
                        isLoading = false,
                        errorMessage = if (profile == null) "That profile is unavailable." else null,
                    )
                }
                recomputeCallCost()
            }
        }
    }

    // ── Real-time own diamond balance ─────────────────────────────────────────

    private fun attachMeListener() {
        val myUid = auth.currentUser?.uid ?: return
        meListener = firestore.collection("users").document(myUid)
            .addSnapshotListener { snap, _ ->
                val diamonds = snap?.getLong("diamonds") ?: 0L
                currentUserGender  = snap?.getString("gender")   ?: ""
                currentUserIsHost  = snap?.getBoolean("isHost")  ?: false
                currentUserIsVerifiedHost = snap?.getBoolean("isVerifiedHost") ?: false
                currentUserCallRate = snap?.getLong("callRateBeans") ?: 0L
                _uiState.update { it.copy(currentUserDiamonds = diamonds) }
                recomputeCallCost()
            }
    }

    /**
     * Estimates the diamond cost/min the viewer would pay. The server
     * (`startCall`) is the authority; this mirrors its `rateFor` so the number
     * on the button matches the number on the bill: CRM receiver split, base
     * rate for unverified hosts, flat rate for user↔user.
     */
    private fun recomputeCallCost() {
        val target = _uiState.value.user ?: return
        viewModelScope.launch {
            val cfg = economyConfig.get()

            /*
             * Mirrors `rateFor` in functions/src/calls.ts, including WHO PAYS.
             *
             * That last part is what this used to get wrong. It priced every
             * call from the caller's side, so a host ringing a user was shown a
             * cost — for a call the user pays for and the host is paid for. The
             * user always pays: one host and one user means the user pays
             * whichever of them dialled, and two of a kind means the caller
             * pays.
             */
            val cost = when {
                // Exactly one host: the user pays, the host earns.
                target.isHost != currentUserIsHost -> {
                    val iAmTheHost = currentUserIsHost
                    val earnerIncome = if (iAmTheHost) {
                        if (currentUserIsVerifiedHost && currentUserCallRate > 0) currentUserCallRate
                        else cfg.callRateBeansPerMin
                    } else {
                        if (target.isVerifiedHost) target.callRateBeans.toLong()
                        else cfg.callRateBeansPerMin
                    }
                    val payerGender  = if (iAmTheHost) target.gender else currentUserGender
                    val earnerGender = if (iAmTheHost) currentUserGender else target.gender
                    // I only pay when I am the user.
                    if (iAmTheHost) 0L
                    else cfg.payerDiamondsPerMin(earnerIncome, payerGender, earnerGender)
                }
                // Two hosts: I dialled, so I pay, priced from their income.
                target.isHost && currentUserIsHost -> {
                    val income = if (target.isVerifiedHost) target.callRateBeans.toLong()
                                 else cfg.callRateBeansPerMin
                    cfg.payerDiamondsPerMin(income, currentUserGender, target.gender)
                }
                // Two users: the flat rate, paid by whoever dials.
                else -> cfg.userCallRatePerMin
            }
            _uiState.update { it.copy(callCostDiamonds = cost) }
        }
    }

    // ── Real-time blocked status ──────────────────────────────────────────────

    private fun attachBlockedListener() {
        val myUid = auth.currentUser?.uid ?: return
        blockedListener = firestore.collection("users").document(myUid)
            .collection("blocked").document(targetUid)
            .addSnapshotListener { snap, _ ->
                _uiState.update { it.copy(isBlocked = snap?.exists() == true) }
            }
    }

    // ── Like status (one-shot) ───────────────────────────────────────────────

    private fun checkIsLiked() {
        viewModelScope.launch {
            val isLiked = repo.isUserLiked(targetUid)
            _uiState.update { it.copy(isLiked = isLiked) }
        }
    }

    // ── Real-time gifts received ──────────────────────────────────────────────

    private fun attachGiftsReceivedListener() {
        viewModelScope.launch {
            giftRepo.giftsReceivedFlow(targetUid).collect { entries ->
                val summary = entries
                    .groupBy { it.giftId }
                    .map { (giftId, items) ->
                        GiftSummaryItem(
                            giftId   = giftId,
                            name     = items.first().giftName,
                            emoji    = items.first().emoji,
                            imageUrl = items.first().imageUrl,
                            count    = items.sumOf { it.quantity },
                        )
                    }
                    .sortedByDescending { it.count }
                _uiState.update { it.copy(giftsReceived = summary) }
            }
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    fun toggleLike() {
        val user = _uiState.value.user ?: return
        viewModelScope.launch {
            if (_uiState.value.isLiked) {
                repo.unlikeUser(targetUid)
                _uiState.update { it.copy(isLiked = false) }
            } else {
                repo.likeUser(user)
                _uiState.update { it.copy(isLiked = true) }
            }
        }
    }

    fun sendGift(gift: RepoGiftItem, quantity: Int) {
        if (_uiState.value.giftSending) return
        _uiState.update { it.copy(giftSending = true) }
        viewModelScope.launch {
            val result = try {
                giftRepo.sendGift(targetUid, gift, quantity = quantity, targetName = _uiState.value.user?.name ?: "")
            } catch (e: Exception) { GiftResult.Error(e.localizedMessage ?: "Could not send gift") }
            val msg = when (result) {
                is GiftResult.Success            -> "Sent ${gift.name}" + (if (quantity > 1) " ×$quantity" else "")
                // The SERVER's roll, shown as it came back.
                is GiftResult.LuckyWin           -> "Lucky ×${result.multiplier}! +${result.diamondsBack} diamonds back"
                is GiftResult.InsufficientDiamonds -> "Not enough diamonds — recharge to send this"
                is GiftResult.Error              -> result.message
            }
            _uiState.update {
                it.copy(giftSending = false, toastMessage = msg, luckyWin = result as? GiftResult.LuckyWin ?: it.luckyWin)
            }
        }
    }

    fun sendGift(gift: GiftItem) {
        viewModelScope.launch {
            val repoGift = RepoGiftItem(
                id           = gift.giftId,
                name         = gift.name,
                costDiamonds = gift.costDiamonds.toLong(),
                category     = "normal",
                emoji        = gift.emoji,
                imageUrl     = gift.imageUrl,
                lottieAsset  = gift.lottieAsset,
            )
            when (val result = giftRepo.sendGift(
                targetUid  = targetUid,
                gift       = repoGift,
                targetName = _uiState.value.user?.name ?: "",
                senderName = "",   // sender's own name not needed here; filled by repo if available
            )) {
                is GiftResult.Success            -> _uiState.update { it.copy(toastMessage = "Gift sent! 🎁") }
                is GiftResult.LuckyWin           -> _uiState.update { it.copy(toastMessage = "🎉 Lucky win! +${result.diamondsBack} 💎 back") }
                is GiftResult.InsufficientDiamonds -> _uiState.update { it.copy(toastMessage = "Not enough diamonds 💎") }
                is GiftResult.Error              -> _uiState.update { it.copy(toastMessage = result.message) }
            }
        }
    }

    fun blockUser() {
        val user = _uiState.value.user ?: return
        viewModelScope.launch {
            repo.blockUser(
                targetUid     = targetUid,
                targetName    = user.name,
                targetPhotoUrl = user.photoUrl,
            )
            _uiState.update {
                it.copy(isBlocked = true, toastMessage = "${user.name} has been blocked")
            }
        }
    }

    fun unblockUser() {
        val user = _uiState.value.user
        viewModelScope.launch {
            repo.unblockUser(targetUid)
            _uiState.update {
                it.copy(isBlocked = false, toastMessage = "${user?.name ?: "User"} has been unblocked")
            }
        }
    }

    fun report(reason: String) {
        viewModelScope.launch {
            try {
                liveRepo.reportUser(targetUid, reason)
                _uiState.update { it.copy(toastMessage = "Thanks — our team will review this profile") }
            } catch (e: Exception) {
                _uiState.update { it.copy(toastMessage = "Couldn't send the report. Try again.") }
            }
        }
    }

    fun clearToast() {
        _uiState.update { it.copy(toastMessage = null) }
    }

    /** The lucky celebration has been shown. */
    fun clearLuckyWin() { _uiState.update { it.copy(luckyWin = null) } }

    // ── Video Call ────────────────────────────────────────────────────────────

    fun initiateCall() {
        val receiver = _uiState.value.user ?: return
        auth.currentUser?.uid ?: return
        viewModelScope.launch {
            // No caller profile, no rate. startCall reads both parties from
            // Firestore and decides the price itself — the client used to build
            // a User object and hand over `callCostDiamonds`, a number it had
            // computed locally and the server had no reason to trust.
            when (val res = callRepo.createCall(receiver.uid)) {
                is CallRepository.CallStart.Ok ->
                    _uiState.update {
                        it.copy(
                            navigateToCall = res.callId,
                            callCostDiamonds = res.perMinRateDiamonds,
                        )
                    }
                is CallRepository.CallStart.Failed ->
                    // Covers "not enough diamonds", "this host is offline" and
                    // being blocked, each phrased by the server.
                    _uiState.update { it.copy(toastMessage = res.message) }
            }
        }
    }

    fun consumeCallNavigation() {
        _uiState.update { it.copy(navigateToCall = null) }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCleared() {
        super.onCleared()
        blockedListener?.remove()
        meListener?.remove()
    }
}
