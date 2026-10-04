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
            val records = callRepo.getCallHistory(myUid)
            _state.update { it.copy(calls = records, isLoading = false) }
        }
    }
}
