package com.zipper.app.ui.screens.partner

import android.net.Uri
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.PartnerFunctions
import com.zipper.app.data.repository.PartnerRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * One application form for four roles.
 *
 * ── THE STEPS ───────────────────────────────────────────────────────────────
 *
 *   Agency        Basic info → KYC documents → Bank details → Done
 *   Sub-agency    Basic info → KYC documents → Bank details + Select MAIN agency → Done
 *   Coin Seller   Basic info → ID proof → Payment details → Done
 *   Host          Agency + identity → Profile → Rate & payout → KYC documents → Done
 *
 * The Agency form is the CRM's `/agency-signup` field for field; the Host form
 * is the agency's Invite Host form field for field. Nothing was invented and
 * nothing was dropped, so a reviewer sees the same record whichever door it
 * came through.
 *
 * ── WHAT IS NEVER TYPED ─────────────────────────────────────────────────────
 *
 * Phone and email come from the signed-in account and are shown, not asked.
 * The applicant's uid is not in the form at all: the callable takes it off the
 * token. A parent agency is CHOSEN from the list the server offers — the id is
 * sent back and the server validates it again before anything is written.
 *
 * ── VALIDATION HAPPENS TWICE, ON PURPOSE ────────────────────────────────────
 *
 * The step gates here stop a person pressing Next with an empty field. They
 * are a courtesy. The API applies the same requirements and the rules the app
 * cannot know (eligibility, the family rule, the parent's state), and its
 * refusal — a sentence written for the applicant — is what [error] shows.
 */
enum class ApplyStep { BASIC, DOCS, PAYMENT, PROFILE, DONE }

data class ParentPick(val id: String, val name: String, val kind: String, val parentName: String)

data class PartnerApplyUiState(
    val kind: String,
    val step: ApplyStep = ApplyStep.BASIC,
    val fields: Map<String, String> = emptyMap(),
    /** slot → local file, before upload. */
    val picked: Map<String, Uri> = emptyMap(),
    /** slot → uploaded URL. */
    val uploaded: Map<String, String> = emptyMap(),
    val uploading: Set<String> = emptySet(),
    val parents: List<ParentPick> = emptyList(),
    val parentsLoading: Boolean = false,
    val parent: ParentPick? = null,
    val identityPhone: String = "",
    val identityEmail: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    val filedId: String = "",
    /**
     * Approved contact rule: the server refused the submission because the
     * account holds no verified phone or email. The form shows what is missing
     * and opens verification; on return it is cleared so Submit can be pressed
     * again with the form exactly as it was.
     */
    val contactRequired: com.zipper.app.util.ContactRequirement? = null,
) {
    fun f(key: String): String = fields[key].orEmpty()
    val isIndia: Boolean get() = (fields["paymentType"] ?: "india") == "india"
    val needsParent: Boolean get() = kind == "sub_agency" || kind == "host"

    /** The ordered steps for this kind. */
    val steps: List<ApplyStep>
        get() = when (kind) {
            "host" -> listOf(ApplyStep.BASIC, ApplyStep.PROFILE, ApplyStep.PAYMENT, ApplyStep.DOCS, ApplyStep.DONE)
            else -> listOf(ApplyStep.BASIC, ApplyStep.DOCS, ApplyStep.PAYMENT, ApplyStep.DONE)
        }
}

@HiltViewModel
class PartnerApplyViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repo: PartnerRepository,
) : ViewModel() {

    val kind: String = checkNotNull(savedStateHandle["kind"])

    private val _state = MutableStateFlow(PartnerApplyUiState(kind = kind))
    val state: StateFlow<PartnerApplyUiState> = _state.asStateFlow()

    init {
        val id = repo.identity()
        _state.update {
            it.copy(
                identityPhone = id.phone,
                identityEmail = id.email,
                fields = mapOf(
                    "paymentType" to "india",
                    // Prefilled, editable only where the identity has nothing.
                    "ownerName" to id.name, "hostName" to id.name, "displayName" to id.name,
                ),
            )
        }
        if (_state.value.needsParent) loadParents()
    }

    /**
     * The form came back to the front — after phone or email verification
     * above all (approved contact rule). The first resume is the one `init`
     * already loaded for. Afterwards the signed-in identity is re-read (a
     * contact may have just been verified) and a contact refusal is cleared so
     * the same form can be submitted again.
     */
    private var resumedOnce = false

    fun onResumed() {
        if (!resumedOnce) {
            resumedOnce = true
            return
        }
        val id = repo.identity()
        _state.update {
            it.copy(
                identityPhone = id.phone,
                identityEmail = id.email,
                contactRequired = null,
                error = if (it.contactRequired != null) null else it.error,
            )
        }
    }

    // ── Fields ───────────────────────────────────────────────────────────────

    fun set(key: String, value: String) =
        _state.update { it.copy(fields = it.fields + (key to value), error = null) }

    fun pick(slot: String, uri: Uri) {
        _state.update { it.copy(picked = it.picked + (slot to uri), error = null, uploading = it.uploading + slot) }
        viewModelScope.launch {
            val up = when (kind) {
                "seller" -> repo.uploadSellerDocument(slot, uri)
                "host" -> repo.uploadHostDocument(slot, uri)
                else -> repo.uploadAgencyDocument(slot, uri)
            }
            _state.update {
                when (up) {
                    is PartnerRepository.Upload.Ok ->
                        it.copy(uploaded = it.uploaded + (slot to up.url), uploading = it.uploading - slot)
                    is PartnerRepository.Upload.Failed ->
                        it.copy(picked = it.picked - slot, uploading = it.uploading - slot,
                                error = "That file could not be uploaded: ${up.message}")
                }
            }
        }
    }

    fun choose(parent: ParentPick) = _state.update { it.copy(parent = parent, error = null) }

    private fun loadParents() {
        _state.update { it.copy(parentsLoading = true) }
        viewModelScope.launch {
            val res = repo.parents(if (kind == "host") "host" else "sub_agency")
            // RC (confirmed role rule): when the server pins the parent — a
            // Sub-agency may be a Host only under its own main agency; a Host a
            // Sub-agency only under the agency they are a Host of — offer only
            // that one. The server refuses any other choice regardless.
            val pinned = (repo.eligibility() as? PartnerFunctions.Result.Ok)?.value?.parentFor?.get(kind).orEmpty()
            _state.update {
                when (res) {
                    is PartnerFunctions.Result.Ok -> it.copy(
                        parentsLoading = false,
                        parents = res.value
                            .filter { p -> pinned.isBlank() || p.id == pinned }
                            .map { p -> ParentPick(p.id, p.name, p.kind, p.parentName) },
                    )
                    is PartnerFunctions.Result.Failed -> it.copy(parentsLoading = false, error = res.userMessage)
                }
            }
        }
    }

    // ── Steps ────────────────────────────────────────────────────────────────

    /** What blocks leaving the current step, in the applicant's words — or null. */
    fun blocker(): String? {
        val s = _state.value
        return when (s.step) {
            ApplyStep.BASIC -> when (kind) {
                "seller" -> when {
                    s.f("displayName").isBlank() -> "Your shop or display name is required."
                    s.f("city").isBlank() -> "Your city is required."
                    else -> null
                }
                "host" -> when {
                    s.parent == null -> "Choose the agency you want to join."
                    s.f("hostName").isBlank() -> "Your name is required."
                    else -> null
                }
                else -> when {
                    s.f("agencyName").isBlank() -> "The agency name is required."
                    s.f("ownerName").isBlank() -> "The owner's name is required."
                    s.f("address").isBlank() -> "An address is required."
                    else -> null
                }
            }
            ApplyStep.PROFILE -> when {
                s.f("age").toIntOrNull()?.let { it < 18 } != false -> "Age is required and must be 18 or over."
                s.f("country").isBlank() -> "Country is required."
                "photo" !in s.uploaded -> "A clear reference photo is required for facial verification."
                else -> null
            }
            ApplyStep.DOCS -> when (kind) {
                "seller" -> if ("proof" !in s.uploaded) "Upload one government-issued photo ID." else null
                else -> if (listOf("doc1", "doc2", "doc3").any { it !in s.uploaded }) "Upload all three documents." else null
            }
            ApplyStep.PAYMENT -> when (kind) {
                "seller" -> if (listOf("upiId", "binanceUid", "accountNumber", "internationalDetails").all { s.f(it).isBlank() }
                                && "upiQr" !in s.uploaded)
                    "Add at least one way buyers can pay you — UPI, a QR code, a bank account, Binance or an international method."
                else null
                "host" -> payoutBlocker(s)
                "sub_agency" -> payoutBlocker(s)
                    ?: if (s.parent == null) "Choose the main agency you will work under." else null
                else -> payoutBlocker(s)
            }
            ApplyStep.DONE -> null
        }
    }

    private fun payoutBlocker(s: PartnerApplyUiState): String? = when {
        s.isIndia && (s.f("accountNumber").isBlank() || s.f("ifscCode").isBlank() || s.f("bankName").isBlank()) ->
            "Account number, IFSC and bank name are required."
        s.isIndia && s.f("accountNumber") != s.f("confirmAccountNumber") -> "The account numbers do not match."
        !s.isIndia && s.f("binanceUid").isBlank() -> "A Binance UID is required for international payout."
        else -> null
    }

    fun next() {
        val s = _state.value
        blocker()?.let { _state.update { st -> st.copy(error = it) }; return }
        val i = s.steps.indexOf(s.step)
        val following = s.steps.getOrNull(i + 1) ?: return
        if (following == ApplyStep.DONE) submit() else _state.update { it.copy(step = following, error = null) }
    }

    fun back(): Boolean {
        val s = _state.value
        val i = s.steps.indexOf(s.step)
        if (i <= 0 || s.step == ApplyStep.DONE) return false
        _state.update { it.copy(step = s.steps[i - 1], error = null) }
        return true
    }

    // ── Submit ───────────────────────────────────────────────────────────────

    private fun submit() {
        val s = _state.value
        if (s.submitting) return
        _state.update { it.copy(submitting = true, error = null, contactRequired = null) }
        viewModelScope.launch {
            val res = when (kind) {
                "host" -> repo.submitHostApplication(hostForm(s), s.parent?.id.orEmpty())
                else -> repo.submitPartnerApplication(kind, partnerForm(s), s.parent?.id)
            }
            // RF-30: no answer about whether it was filed — look before saying
            // anything. Was: "Zipper could not be reached" for a filed application.
            if (res is PartnerFunctions.Result.Failed && res.outcomeUnknown) {
                val filed = applicationOnRecord()
                _state.update {
                    if (filed != null) {
                        it.copy(submitting = false, step = ApplyStep.DONE, filedId = filed)
                    } else {
                        it.copy(submitting = false, error = FilingConfirmation.APPLICATION_NOT_CONFIRMED)
                    }
                }
                return@launch
            }
            _state.update {
                when (res) {
                    is PartnerFunctions.Result.Ok ->
                        it.copy(submitting = false, step = ApplyStep.DONE, filedId = res.value.id)
                    is PartnerFunctions.Result.Failed ->
                        it.copy(submitting = false, error = res.userMessage, contactRequired = res.contact)
                }
            }
        }
    }

    /**
     * RF-30: the pending application of this kind the server now shows, if
     * any — looked for [FilingConfirmation.ATTEMPTS] times, because the API
     * may still be finishing the write that timed out.
     */
    private suspend fun applicationOnRecord(): String? {
        repeat(FilingConfirmation.ATTEMPTS) { attempt ->
            if (attempt > 0) delay(FilingConfirmation.SPACING_MS)
            val mine = repo.myApplications()
            if (mine is PartnerFunctions.Result.Ok) {
                FilingConfirmation.pendingApplicationId(kind, mine.value)?.let { return it }
            }
        }
        return null
    }

    private fun payout(s: PartnerApplyUiState): Map<String, Any> = buildMap {
        put("paymentType", if (s.isIndia) "india" else "foreign")
        put("currency", if (s.isIndia) "INR" else "USD")
        if (s.isIndia) {
            listOf("accountHolderName", "accountNumber", "ifscCode", "bankName", "branch", "upiId")
                .forEach { k -> s.f(k).takeIf { it.isNotBlank() }?.let { put(k, it) } }
        } else {
            s.f("country").takeIf { it.isNotBlank() }?.let { put("country", it) }
            put("binanceUid", s.f("binanceUid"))
        }
    }

    private fun partnerForm(s: PartnerApplyUiState): Map<String, Any> = when (kind) {
        "seller" -> buildMap {
            put("displayName", s.f("displayName")); put("city", s.f("city"))
            s.f("description").takeIf { it.isNotBlank() }?.let { put("description", it) }
            put("phone", s.identityPhone); put("email", s.identityEmail)
            put("idDocUrls", listOfNotNull(s.uploaded["proof"]))
            put("payment", buildMap {
                listOf("accountHolderName", "accountNumber", "ifscCode", "bankName", "branch",
                       "upiId", "binanceUid", "internationalMethod", "internationalDetails")
                    .forEach { k -> s.f(k).takeIf { it.isNotBlank() }?.let { put(k, it) } }
                s.uploaded["upiQr"]?.let { put("upiQrUrl", it) }
                put("currency", if (s.f("binanceUid").isNotBlank() && s.f("accountNumber").isBlank()) "USD" else "INR")
            })
        }
        else -> buildMap {
            put("agencyName", s.f("agencyName")); put("ownerName", s.f("ownerName")); put("address", s.f("address"))
            put("ownerPhone", s.identityPhone); put("ownerEmail", s.identityEmail)
            putAll(payout(s))
            put("kycDocUrls", listOfNotNull(s.uploaded["doc1"], s.uploaded["doc2"], s.uploaded["doc3"]))
        }
    }

    private fun hostForm(s: PartnerApplyUiState): Map<String, Any> = buildMap {
        put("hostName", s.f("hostName")); put("age", s.f("age")); put("country", s.f("country"))
        s.f("dob").takeIf { it.isNotBlank() }?.let { put("dob", it) }
        s.f("callRate").takeIf { it.isNotBlank() }?.let { put("callRate", it) }
        putAll(payout(s))
        put("photoUrl", listOfNotNull(s.uploaded["photo"]))
        put("kycDocUrls", listOfNotNull(s.uploaded["doc1"], s.uploaded["doc2"], s.uploaded["doc3"]))
        put("applicantPhone", s.identityPhone); put("applicantEmail", s.identityEmail)
    }
}
