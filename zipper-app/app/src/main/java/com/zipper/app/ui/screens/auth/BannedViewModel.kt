package com.zipper.app.ui.screens.auth

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AppealRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class BannedUiState(
    /** Still working out whether they already have one waiting. */
    val checking: Boolean = true,
    /** An appeal of theirs is with a reviewer. The form is not shown. */
    val hasPending: Boolean = false,
    /** The last decided appeal, so the screen can say what came of it. */
    val lastVerdict: String = "",
    val lastReason: String = "",
    val statement: String = "",
    val evidence: List<Uri> = emptyList(),
    val sending: Boolean = false,
    val sent: Boolean = false,
    val error: String? = null,
)

/**
 * The banned screen's one piece of state: whether this person can still say
 * something, and what happened last time they did.
 */
@HiltViewModel
class BannedViewModel @Inject constructor(
    private val appeals: AppealRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(BannedUiState())
    val state: StateFlow<BannedUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(checking = true) }
            val pending = appeals.pendingAppeal()
            // The most recent DECIDED appeal, if there is one. Somebody whose
            // appeal was refused should be told why on this screen rather than
            // filing the same appeal again into the same queue.
            val decided = appeals.myAppeals().firstOrNull {
                (it["status"] as? String).orEmpty() != "pending"
            }
            _state.update {
                it.copy(
                    checking = false,
                    hasPending = pending,
                    lastVerdict = (decided?.get("status") as? String).orEmpty(),
                    lastReason = (decided?.get("decisionReason") as? String).orEmpty(),
                )
            }
        }
    }

    fun onStatement(text: String) = _state.update { it.copy(statement = text, error = null) }

    fun addEvidence(uri: Uri) = _state.update {
        if (it.evidence.size >= 3) it else it.copy(evidence = it.evidence + uri)
    }

    fun removeEvidence(uri: Uri) = _state.update {
        it.copy(evidence = it.evidence.filterNot { u -> u == uri })
    }

    fun submit() {
        val s = _state.value
        if (s.sending) return
        viewModelScope.launch {
            _state.update { it.copy(sending = true, error = null) }
            when (val res = appeals.appealMyBan(s.statement, s.evidence)) {
                is AppealRepository.Result.Ok ->
                    _state.update { it.copy(sending = false, sent = true, hasPending = true) }
                is AppealRepository.Result.AlreadyPending ->
                    _state.update { it.copy(sending = false, hasPending = true) }
                is AppealRepository.Result.Failed ->
                    _state.update { it.copy(sending = false, error = res.message) }
            }
        }
    }
}
