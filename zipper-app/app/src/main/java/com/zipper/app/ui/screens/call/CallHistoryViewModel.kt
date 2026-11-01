package com.zipper.app.ui.screens.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.CallRecord
import com.zipper.app.data.repository.CallRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** B2: shown instead of "No calls yet" when the history could not be read. */
const val CALL_HISTORY_LOAD_FAILED = "Couldn't load your call history. Check your connection and try again."

data class CallHistoryUiState(
    val calls: List<CallRecord> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
)

@HiltViewModel
class CallHistoryViewModel @Inject constructor(
    private val callRepo: CallRepository,
    private val auth: FirebaseAuth,
) : ViewModel() {

    private val _state = MutableStateFlow(CallHistoryUiState())
    val state: StateFlow<CallHistoryUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        val myUid = auth.currentUser?.uid ?: return
        _state.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            callRepo.loadCallHistory(myUid).fold(
                onSuccess = { records -> _state.update { it.copy(calls = records, isLoading = false, error = null) } },
                // B2: say the read failed (and offer a retry) rather than "No calls yet".
                onFailure = { _state.update { it.copy(isLoading = false, error = CALL_HISTORY_LOAD_FAILED) } },
            )
        }
    }
}
