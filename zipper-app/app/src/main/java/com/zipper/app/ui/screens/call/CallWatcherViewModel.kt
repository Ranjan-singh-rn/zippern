package com.zipper.app.ui.screens.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.data.model.ActiveCall
import com.zipper.app.data.repository.CallRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Singleton (activity-scoped) watcher. Injected into MainScreen to detect incoming calls
 * while the app is open. FCM handles background calls (Phase 14).
 */
@HiltViewModel
class CallWatcherViewModel @Inject constructor(
    private val callRepo: CallRepository,
    private val auth: FirebaseAuth,
) : ViewModel() {

    private val _incomingCall = MutableStateFlow<ActiveCall?>(null)
    val incomingCall: StateFlow<ActiveCall?> = _incomingCall.asStateFlow()

    private var job: kotlinx.coroutines.Job? = null
    private var watchingUid: String? = null

    /**
     * Activity-scoped and restartable: the watcher must outlive the Main tabs
     * (a ring on Settings, in a chat or inside a live room was previously
     * lost) and must re-bind when a different account signs in.
     */
    fun start() {
        val myUid = auth.currentUser?.uid ?: return
        // ZipperMessagingService suppresses the call notification only while this
        // watcher is actually listening; see AppState.callWatcherActive.
        com.zipper.app.service.AppState.callWatcherActive = true
        if (job?.isActive == true && watchingUid == myUid) return
        job?.cancel()
        watchingUid = myUid
        job = viewModelScope.launch {
            callRepo.incomingCallFlow(myUid).collect { call -> _incomingCall.value = call }
        }
    }

    fun stop() {
        com.zipper.app.service.AppState.callWatcherActive = false
        job?.cancel(); job = null; watchingUid = null
        _incomingCall.value = null
    }

    /** Call this once the user has navigated to the IncomingCallScreen so we don't re-trigger. */
    fun consumeIncomingCall() {
        _incomingCall.value = null
    }

    override fun onCleared() {
        // The activity is going; nothing is listening any more, so the messaging
        // service must stop suppressing the call notification.
        com.zipper.app.service.AppState.callWatcherActive = false
        super.onCleared()
    }
}
