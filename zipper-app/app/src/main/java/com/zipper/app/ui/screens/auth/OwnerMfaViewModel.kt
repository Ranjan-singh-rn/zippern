package com.zipper.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.api.ApiClient
import com.zipper.app.data.api.ApiResult
import com.zipper.app.util.SessionManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives [MfaMachine]: performs the one call each `Checking` step asks for,
 * feeds the answer back as an [MfaEvent], and holds the current step for
 * [OwnerMfaScreen]. Every decision is the machine's; this class decides
 * nothing and logs nothing (codes, keys and tokens never reach a log).
 *
 * The API session, the Firebase ID token and the Owner binding are
 * `ApiClient`'s business: a POST to `/mfa/verify` or `/mfa/enrol/confirm`
 * through it carries `firebase_id_token` + `client: "android"`, adopts the
 * session the server answers with (memory only), redeems the `ownerWork`
 * custom token and confirms the binding. What comes back here is the
 * settled `user.mfa.firestore_binding` — never a token.
 */
@HiltViewModel
class OwnerMfaViewModel @Inject constructor(
    private val api: ApiClient,
    private val sessionManager: SessionManager,
) : ViewModel() {

    data class Ui(
        /** Null until the pre-filter has been read; false = not an Owner, nothing to show. */
        val applies: Boolean? = null,
        val step: MfaStep = MfaMachine.start,
        val busy: Boolean = false,
    )

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private var started = false

    /**
     * Run the gate once per view-model. The pre-filter is the SERVER's last
     * answer for this account's CRM role (SessionManager, written at sign-in
     * and at every cold start); the decision is `GET /api/auth/me`.
     */
    fun begin() {
        if (started) return
        started = true
        viewModelScope.launch {
            val role = try { sessionManager.crmRole.first() } catch (_: Exception) { "" }
            if (!OwnerMfaGate.appliesTo(role)) {
                _ui.update { it.copy(applies = false, step = MfaStep.NotRequired) }
                return@launch
            }
            _ui.update { it.copy(applies = true) }
            drive(MfaMachine.start)
        }
    }

    /** Perform whatever each `Checking` step asks for until the machine rests on a screen. */
    private suspend fun drive(from: MfaStep) {
        var step = from
        while (true) {
            _ui.update { it.copy(step = step, busy = step is MfaStep.Checking) }
            val checking = step as? MfaStep.Checking ?: return
            val event = when (checking.phase) {
                MfaStep.Phase.Me -> api.get(OwnerMfaGate.ME_PATH).toEvent(MfaMachine::meEvent)
                MfaStep.Phase.Status -> api.get(OwnerMfaGate.STATUS_PATH).toEvent(MfaMachine::statusEvent)
                MfaStep.Phase.EnrolStart -> api.post(OwnerMfaGate.ENROL_START_PATH, emptyMap<String, Any?>()).toEvent(MfaMachine::enrolStartEvent)
            }
            step = MfaMachine.next(step, event)
        }
    }

    /** The code (or recovery code) typed on the Enrol / Verify step. */
    fun submit(raw: String) {
        val step = _ui.value.step
        if (_ui.value.busy) return
        val ok = when (step) {
            is MfaStep.Enrol -> MfaMachine.codeLooksValid(raw)
            is MfaStep.Verify -> if (step.useRecovery) MfaMachine.recoveryLooksValid(raw) else MfaMachine.codeLooksValid(raw)
            else -> return
        }
        if (!ok) {
            val msg = if (step is MfaStep.Verify && step.useRecovery) "Enter one of your recovery codes." else "Enter the 6-digit code from your authenticator app."
            _ui.update { it.copy(step = when (step) { is MfaStep.Enrol -> step.copy(error = msg); is MfaStep.Verify -> step.copy(error = msg); else -> step }) }
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(busy = true) }
            val event = when (step) {
                is MfaStep.Enrol -> api.post(OwnerMfaGate.ENROL_CONFIRM_PATH, mapOf("code" to MfaMachine.normaliseCode(raw)))
                    .toEvent(MfaMachine::enrolConfirmEvent)
                is MfaStep.Verify -> api.post(OwnerMfaGate.VERIFY_PATH, MfaMachine.verifyBody(raw, step.useRecovery))
                    .toEvent(MfaMachine::verifyEvent)
                else -> return@launch
            }
            var next = MfaMachine.next(step, event)
            // Locked out (five wrong codes): the status route says until when.
            if (event is MfaEvent.Failed && event.status == 429) {
                val status = api.get(OwnerMfaGate.STATUS_PATH)
                if (status is ApiResult.Ok) next = MfaMachine.next(next, MfaMachine.statusEvent(status.body))
            }
            drive(next)
        }
    }

    fun toggleRecovery() = _ui.update { it.copy(step = MfaMachine.next(it.step, MfaEvent.ToggleRecovery)) }

    fun recoveryCodesSaved() = _ui.update { it.copy(step = MfaMachine.next(it.step, MfaEvent.RecoveryCodesSaved)) }

    /** "Continue" on a notice: no two-step routes on this server, or Owner screens still locked. */
    fun acknowledge() = _ui.update { it.copy(step = MfaMachine.next(it.step, MfaEvent.Continue)) }

    fun retry() {
        if (_ui.value.busy) return
        viewModelScope.launch { drive(MfaMachine.next(_ui.value.step, MfaEvent.Retry)) }
    }

    /**
     * P1-A3b: re-issue this session's Owner Firestore binding (`/mfa/bind` →
     * redeem → confirm, inside ApiClient). A refused retry is shown as the
     * binding's reason, so the button never looks like it did nothing.
     */
    fun retryBind() {
        if (_ui.value.busy) return
        viewModelScope.launch {
            _ui.update { it.copy(busy = true) }
            val event = when (val r = api.post(OwnerMfaGate.BIND_PATH, emptyMap<String, Any?>())) {
                is ApiResult.Ok -> MfaMachine.bindEvent(r.body)
                is ApiResult.Failure -> MfaEvent.Rebound(MfaBinding("failed", r.error.message))
            }
            _ui.update { it.copy(busy = false, step = MfaMachine.next(it.step, event)) }
        }
    }

    private fun ApiResult.toEvent(read: (Any?) -> MfaEvent): MfaEvent = when (this) {
        is ApiResult.Ok -> read(body)
        is ApiResult.Failure -> MfaEvent.failed(error)
    }
}
