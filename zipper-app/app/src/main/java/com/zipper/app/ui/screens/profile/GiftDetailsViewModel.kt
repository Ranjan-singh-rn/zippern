package com.zipper.app.ui.screens.profile

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.GiftHistoryEntry
import com.zipper.app.data.repository.GiftRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The "View all" gift grid.
 *
 * The route carries `{uid}` and `{type}`, so this screen works for the signed-in
 * user's own profile AND for somebody else's — ProfileViewModel could only ever
 * answer for the former, which is why the nav graph used to hand the screen an
 * empty list.
 *
 * Both tabs read the same `users/{uid}/giftShowcase` subcollection; `sentCount`
 * and `receivedCount` decide which side a row belongs to, and rows scoring zero
 * in the requested direction are dropped by the repository.
 */
data class GiftDetailsUiState(
    val gifts: List<GiftSummaryItem> = emptyList(),
    val isLoading: Boolean = true,
)

@HiltViewModel
class GiftDetailsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    giftRepo: GiftRepository,
) : ViewModel() {

    private val uid: String = savedStateHandle.get<String>("uid").orEmpty()
    private val type: String = savedStateHandle.get<String>("type") ?: "received"

    private val _state = MutableStateFlow(GiftDetailsUiState())
    val state: StateFlow<GiftDetailsUiState> = _state.asStateFlow()

    init {
        if (uid.isBlank()) {
            _state.value = GiftDetailsUiState(isLoading = false)
        } else {
            val flow =
                if (type == "sent") giftRepo.giftsSentFlow(uid)
                else giftRepo.giftsReceivedFlow(uid)
            viewModelScope.launch {
                flow.collect { entries ->
                    _state.update { it.copy(gifts = entries.toSummaries(), isLoading = false) }
                }
            }
        }
    }
}

/**
 * The showcase already holds one document per gift, but a document can appear
 * more than once across a migration or a re-seed, so equal ids are folded
 * together and the counts added rather than trusting a single row.
 */
private fun List<GiftHistoryEntry>.toSummaries(): List<GiftSummaryItem> =
    groupBy { it.giftId }
        .map { (giftId, items) ->
            GiftSummaryItem(
                giftId   = giftId,
                name     = items.first().giftName,
                emoji    = items.first().emoji.ifBlank { "🎁" },
                imageUrl = items.firstOrNull { it.imageUrl.isNotBlank() }?.imageUrl.orEmpty(),
                count    = items.sumOf { it.quantity },
            )
        }
        .sortedByDescending { it.count }
