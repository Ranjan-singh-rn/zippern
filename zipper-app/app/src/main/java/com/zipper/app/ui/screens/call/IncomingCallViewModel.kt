package com.zipper.app.ui.screens.call

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.data.repository.CallRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

data class IncomingCallUiState(
    val callId: String          = "",
    val callerName: String      = "",
    val callerPhotoUrl: String  = "",
    val earnRateBeans: Long?    = null,   // what I (the receiver) earn per minute, if I'm a host
    val payRateDiamonds: Long?  = null,   // what I PAY per minute when a host is calling me
    val isVerifiedHost: Boolean = true,   // unverified hosts earn the base rate
    val status: CallStatus      = CallStatus.RINGING,
    val navigateToCall: Boolean = false,
    /** Why the accept was refused, phrased by the server. */
    val error: String? = null,
)

@HiltViewModel
class IncomingCallViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val callRepo: CallRepository,
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val discover: DiscoverRepository,
) : ViewModel() {

    private val callId: String = checkNotNull(savedStateHandle["callId"])

    private val _state = MutableStateFlow(IncomingCallUiState(callId = callId))
    val state: StateFlow<IncomingCallUiState> = _state.asStateFlow()

    init {
        loadCallInfo()
        observeCallDoc()
    }

    private fun loadCallInfo() {
        viewModelScope.launch {
            try {
                val snap = firestore.collection("calls").document(callId).get().await()
                val callerEarns = snap.getString("earner") == "caller"
                _state.update {
                    it.copy(
                        callerName     = snap.getString("callerName") ?: "",
                        callerPhotoUrl = snap.getString("callerPhotoUrl") ?: "",
                        payRateDiamonds = if (callerEarns) snap.getLong("perMinRateDiamonds") else null,
                    )
                }
            } catch (_: Exception) {}
            // The receiver's own earning rate. It is on their own user doc,
            // which they can read; the caller's balance is none of their business.
            try {
                val me = auth.currentUser?.uid ?: return@launch
                val u = firestore.collection("users").document(me).get().await()
                if (u.getBoolean("isHost") == true && _state.value.payRateDiamonds == null) {
                    _state.update {
                        it.copy(
                            earnRateBeans  = u.getLong("callRateBeans"),
                            isVerifiedHost = u.getBoolean("isVerifiedHost") == true,
                        )
                    }
                }
            } catch (_: Exception) {}
        }
    }

    private fun observeCallDoc() {
        viewModelScope.launch {
            callRepo.callFlow(callId).collect { call ->
                if (call == null) return@collect
                val st = when (call.status) {
                    "ringing"   -> CallStatus.RINGING
                    "connected" -> CallStatus.CONNECTED
                    "ended"     -> CallStatus.ENDED
                    "declined"  -> CallStatus.DECLINED
                    "missed"    -> CallStatus.MISSED
                    else        -> CallStatus.RINGING
                }
                _state.update { it.copy(status = st) }
            }
        }
    }

    fun accept() {
        viewModelScope.launch {
            // acceptCall returns a message on failure rather than throwing, so
            // the catch that used to end the call on any exception would have
            // let a refused accept through as a success.
            val error = callRepo.acceptCall(callId)
            if (error == null) {
                _state.update { it.copy(navigateToCall = true) }
            } else {
                _state.update { it.copy(status = CallStatus.ENDED, error = error) }
            }
        }
    }

    fun decline() {
        viewModelScope.launch {
            try { callRepo.declineCall(callId) } catch (_: Exception) {}
        }
    }
}
