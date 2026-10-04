package com.zipper.app.ui.screens.auth

import android.app.Activity
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthProvider
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthResult
import com.zipper.app.util.UserLanguage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AuthUiState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val verificationId: String? = null,
    val navigateToOtp: Boolean = false,
    val navigateToProfileSetup: Boolean = false,
    val navigateToMain: Boolean = false,
    val otpAutoFilled: String? = null,
    val faceVerificationAttempts: Int = 0,
    val navigateToFaceVerification: Boolean = false,
    val navigateToLogin: Boolean = false,
    val accountDeleted: Boolean = false,
    /**
     * The person backed out of profile setup and the half-made account has
     * been discarded. Watched by ProfileSetupScreen, which then navigates to
     * login. Set only on SUCCESS: navigating away from a failed delete would
     * leave the account behind while telling them it was gone.
     */
    val setupAbandoned: Boolean = false,
    /**
     * The account that just signed in is deleted but still inside its recovery
     * window. The screen sends them to RecoverAccountScreen to choose.
     */
    val navigateToRecoverAccount: Boolean = false,
    /**
     * Whether THIS account still owes us a phone or an email.
     *
     * Answered by the server, never derived from the sign-in method. The screen
     * used to compute it as "not a guest and no phone on the token", which asked
     * every Google user for a phone number they had no reason to give. Only a
     * host, an agency, a seller or a member of staff is asked — and only for the
     * one their sign-in could not supply.
     *
     * Default false on purpose: until the server has answered, ask for nothing.
     */
    val requiresPhone: Boolean = false,
    val requiresEmail: Boolean = false,
    /** The exact existing CRM role — `ops_admin`, `agency`, "" — never flattened. */
    val crmRole: String = "",
    val navigateToBanned: Boolean = false,
    val bannedReason: String = "",
    /**
     * Which refusal this is, so the three land on the screen that says the
     * right thing. A suspension is temporary and leaves the phone usable; a ban
     * is not; a device ban is not about this person at all.
     */
    val bannedKind: com.zipper.app.data.repository.RestrictionKind =
        com.zipper.app.data.repository.RestrictionKind.Account,
    /** When a suspension ends. 0 for indefinite. */
    val suspendedUntilMs: Long = 0L,
    val referralCheckLoading: Boolean = false,
    val referralError: String? = null,
    val referralValid: Boolean = false,
    val referralNotFound: Boolean = false,       // code typed but doesn't exist → treat as user
    // Stored from ReferralResult.Valid — used to activate host application on profile save
    /** The code the user typed, held so activateHost can redeem it on save. */
    val referralCode: String = "",
    /**
     * The contact details the code was CHECKED with, held so it can be REDEEMED
     * with the same ones.
     *
     * Without these, checking and redeeming asked two different questions. The
     * check passed them through, so it matched; redemption sent only the code
     * and the server fell back to the Firebase Auth token — which requires both
     * a phone and an email, and never has both. A phone sign-in has no email, a
     * Google sign-in has no phone. So every host watched the code go green and
     * then be refused on save, whichever way they had signed in.
     */
    val referralPhone: String = "",
    val referralEmail: String = "",
    /** Shown as confirmation: "Joining <agency>". */
    val referralAgencyName: String = "",
    /**
     * The profile saved, but becoming a host did not.
     *
     * Its own field rather than `error`, because the two need opposite
     * handling. `error` was set alongside `navigateToMain = true` in the same
     * state update, so the screen navigated away in the same frame it was asked
     * to show a snackbar — the message was rendered onto a screen that was
     * already being torn down and nobody ever read it.
     *
     * The effect was that somebody signed up with a valid agency code, watched
     * it go green, and landed on Home as an ordinary user with no host status
     * and no explanation. Their agency then had a recruit who never appeared.
     * A failure to become a host is worth stopping for.
     */
    val hostActivationError: String? = null,
)

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    /**
     * Whether this account is still a guest, from the server's answer at
     * sign-in. Read by Settings to decide whether to offer "add your phone
     * number" — see [AuthRepository.isGuest] for why `isAnonymous` is not it.
     *
     * Deliberately NOT a field on [AuthUiState]: that object is a record of
     * what the sign-in flow is doing right now and is reset as the flow moves,
     * while this is a standing property of the signed-in account that outlives
     * every screen in it.
     */
    val isGuest: StateFlow<Boolean?> = repo.isGuest.stateIn(
        viewModelScope, SharingStarted.WhileSubscribed(5_000), null,
    )

    // Kept as a member so it is not GC'd while waiting for reCAPTCHA to return
    private var phoneAuthCallbacks: PhoneAuthProvider.OnVerificationStateChangedCallbacks? = null

    // ── Phone OTP ─────────────────────────────────────────────────────────────

    fun sendOtp(phoneNumber: String, activity: Activity, deviceId: String = "") {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            val banReason = repo.getDeviceBanReason(deviceId)
            if (banReason != null) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        navigateToBanned = true,
                        bannedReason = banReason,
                        // This check is the bannedDevices lookup, so it is
                        // always the handset rather than the account.
                        bannedKind = com.zipper.app.data.repository.RestrictionKind.Device,
                    )
                }
                return@launch
            }
            startPhoneAuth(phoneNumber, activity)
        }
    }

    private fun startPhoneAuth(phoneNumber: String, activity: Activity) {
        phoneAuthCallbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                // Auto-retrieved OTP (SMS auto-read)
                val code = credential.smsCode
                if (code != null) {
                    _uiState.update { it.copy(otpAutoFilled = code) }
                }
            }
            override fun onVerificationFailed(e: com.google.firebase.FirebaseException) {
                _uiState.update { it.copy(isLoading = false, error = e.message ?: "Verification failed") }
            }
            override fun onCodeSent(verificationId: String, token: PhoneAuthProvider.ForceResendingToken) {
                _uiState.update { it.copy(
                    isLoading = false,
                    verificationId = verificationId,
                    navigateToOtp = true,
                ) }
            }
        }
        repo.sendOtp(phoneNumber, activity, phoneAuthCallbacks!!)
    }

    fun verifyOtp(code: String, deviceId: String = "") {
        val verificationId = _uiState.value.verificationId ?: return
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            /*
             * Routed through `handleAuthResult` rather than handled here.
             *
             * These three blocks each had their own copy of the same `when`,
             * ending in `else -> {}`. That swallowed every outcome added
             * since — a refused observer, a deleted account awaiting a recovery
             * choice, a host still owing us a phone number — and the screen
             * simply sat there with a spinner and no explanation.
             */
            when (val result = repo.verifyOtp(verificationId, code, deviceId)) {
                is AuthResult.Error -> handleAuthError(result.message)
                else -> handleAuthResult(result)
            }
        }
    }

    // ── Google Sign-In ────────────────────────────────────────────────────────

    fun signInWithGoogle(idToken: String, deviceId: String = "") {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            val banReason = repo.getDeviceBanReason(deviceId)
            if (banReason != null) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        navigateToBanned = true,
                        bannedReason = banReason,
                        // This check is the bannedDevices lookup, so it is
                        // always the handset rather than the account.
                        bannedKind = com.zipper.app.data.repository.RestrictionKind.Device,
                    )
                }
                return@launch
            }
            /*
             * Routed through `handleAuthResult` rather than handled here.
             *
             * These three blocks each had their own copy of the same `when`,
             * ending in `else -> {}`. That swallowed every outcome added
             * since — a refused observer, a deleted account awaiting a recovery
             * choice, a host still owing us a phone number — and the screen
             * simply sat there with a spinner and no explanation.
             */
            when (val result = repo.signInWithGoogle(idToken, deviceId)) {
                is AuthResult.Error -> handleAuthError(result.message)
                else -> handleAuthResult(result)
            }
        }
    }

    // ── Guest ─────────────────────────────────────────────────────────────────

    fun signInAsGuest(deviceId: String = "") {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            val banReason = repo.getDeviceBanReason(deviceId)
            if (banReason != null) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        navigateToBanned = true,
                        bannedReason = banReason,
                        // This check is the bannedDevices lookup, so it is
                        // always the handset rather than the account.
                        bannedKind = com.zipper.app.data.repository.RestrictionKind.Device,
                    )
                }
                return@launch
            }
            /*
             * Routed through `handleAuthResult` rather than handled here.
             *
             * These three blocks each had their own copy of the same `when`,
             * ending in `else -> {}`. That swallowed every outcome added
             * since — a refused observer, a deleted account awaiting a recovery
             * choice, a host still owing us a phone number — and the screen
             * simply sat there with a spinner and no explanation.
             */
            when (val result = repo.signInAsGuest(deviceId)) {
                is AuthResult.Error -> handleAuthError(result.message)
                else -> handleAuthResult(result)
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Routes banned:reason errors to the BannedScreen; all others show as UI error. */
    private fun handleAuthError(message: String) {
        if (message.startsWith("banned:")) {
            val reason = message.removePrefix("banned:").ifBlank { "Your account has been suspended." }
            _uiState.update { it.copy(isLoading = false, navigateToBanned = true, bannedReason = reason) }
        } else {
            _uiState.update { it.copy(isLoading = false, error = message) }
        }
    }

    // ── Profile Setup ─────────────────────────────────────────────────────────

    fun saveProfile(
        name: String,
        gender: String,
        dob: Long,
        age: Int,
        city: String,
        country: String,
        deviceId: String,
        photoUri: Uri?,
        languages: List<UserLanguage> = emptyList(),
        email: String = "",
        /**
         * The number a Google sign-in has no way to know. Collected by the
         * setup form, required before Done, and then dropped on the floor —
         * `saveUserProfile` wrote the auth token's phone, which for a Google
         * account is empty, so these users had no phone number anywhere.
         */
        phone: String = "",
        bio: String = "",
        /**
         * A default avatar the person kept. Scheme-prefixed (`avatar:fox`),
         * not a URL — see DefaultAvatars.kt. Ignored when a photo was picked.
         */
        defaultAvatar: String = "",
    ) {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.saveUserProfile(name, gender, dob, age, city, country, deviceId, photoUri, languages, email, phone, bio, defaultAvatar)) {
                is AuthResult.Success -> {
                    // If a valid referral code was entered, activate the host application now
                    val state = _uiState.value
                    var activationError: String? = null
                    /** Redeemed successfully — this person is a host as of now. */
                    var becameHost = false
                    if (state.referralValid && state.referralCode.isNotBlank()) {
                        // The server re-checks the code, the phone and the email
                        // before granting host status — checkReferralCode above
                        // was a preview, not the decision.
                        // The details THIS profile was just saved with, not the
                        // ones captured when the code was checked. Somebody who
                        // verifies a code and then corrects a typo in their
                        // email would otherwise redeem against the old value and
                        // be told the code belongs to a different person.
                        //
                        // The server prefers the auth token over both, and
                        // `users/{uid}` over the form — these are the fallback,
                        // and they matter only on this first save, when the
                        // profile document is being written in the same breath.
                        val res = repo.activateHostApplication(
                            state.referralCode,
                            phone = phone.ifBlank { state.referralPhone },
                            email = email.ifBlank { state.referralEmail },
                        )
                        if (res is AuthResult.Error) activationError = res.message
                        else becameHost = true
                    }
                    /*
                     * A NEW HOST GOES STRAIGHT TO THE FACE CAPTURE. AN ORDINARY
                     * USER IS NEVER ASKED.
                     *
                     * This used to send everybody to Home with a comment saying
                     * a host would be "prompted for it from Home" — and nothing
                     * on Home ever prompted. `navigateToFaceVerification`
                     * existed, `FaceVerificationScreen` existed, the route was
                     * registered, and not one line in the app ever set the flag.
                     *
                     * So every host who redeemed a code landed on Home tagged
                     * HOST · PENDING, permanently: `isVerifiedHost` gates going
                     * live, gates earning at their own rate, and gates the
                     * weekly payout release. They were a host who could not host
                     * and could not be paid, with nothing on screen to say why
                     * or what to do about it.
                     *
                     * The capture is skippable from the capture screen itself —
                     * it needs decent light and a free minute, and forcing it at
                     * signup would cost real recruits. What it must not be is
                     * INVISIBLE. `MyProfileScreen` carries the same prompt for
                     * anyone who skips it here.
                     */
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            hostActivationError = activationError,
                            navigateToFaceVerification = activationError == null && becameHost,
                            navigateToMain = activationError == null && !becameHost,
                        )
                    }
                }
                is AuthResult.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                else -> {}
            }
        }
    }

    // ── Face Verification ─────────────────────────────────────────────────────

    /**
     * Submit the liveness capture.
     *
     * ── THREE FAILURES NO LONGER DELETE THE ACCOUNT ─────────────────────────
     *
     * This counted EVERY error toward a three-strike limit and then called
     * `clearAllUserData()` — the Firestore document, the uploaded media and the
     * Firebase login, gone, with no confirmation and no message. And the errors
     * it counted were not "this is not the same person": that decision is made
     * by a reviewer, days later, in the CRM. They were dropped connections,
     * Storage hiccups, callable timeouts. A host on a bad train journey lost
     * their account.
     *
     * A failed upload is now what it is — a failed upload. It is reported, the
     * attempt count is kept so the screen can say "attempt 2 of 3", and after
     * the third the capture is simply left for later: the host keeps their
     * account, keeps the HOST · PENDING badge, and is pointed back at Me →
     * Verify your face whenever they have better signal.
     *
     * Nothing here deletes anything. If an account genuinely has to go, that is
     * a moderator's decision with a reason and an audit entry, not a retry
     * counter on a phone.
     */
    fun submitHostCapture(photoUri: android.net.Uri) {
        _uiState.update { it.copy(isLoading = true) }
        viewModelScope.launch {
            when (val result = repo.submitHostCapture(photoUri)) {
                is AuthResult.Success -> _uiState.update {
                    it.copy(isLoading = false, navigateToMain = true)
                }
                is AuthResult.Error -> {
                    val attempts = _uiState.value.faceVerificationAttempts + 1
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            faceVerificationAttempts = attempts,
                            error = if (attempts >= 3) {
                                "${result.message}\n\nThat is three tries. Your account " +
                                "is fine — the capture just has not gone through. Come " +
                                "back to it from Me → Verify your face when you have a " +
                                "better connection."
                            } else {
                                "${result.message} (attempt $attempts of 3)"
                            },
                            // Three failures are a reason to stop asking, not a
                            // reason to take anything away.
                            navigateToMain = attempts >= 3,
                        )
                    }
                }
                else -> {}
            }
        }
    }

    /**
     * The on-device face check did not find a face.
     *
     * Same correction as [submitHostCapture]: this deleted the account on the
     * third failure. A face detector that cannot see a face in a dim room is
     * reporting the lighting, not fraud — and the person it was about to delete
     * is a host their agency has already verified documents for.
     */
    fun faceDetectionFailed() {
        val attempts = _uiState.value.faceVerificationAttempts + 1
        _uiState.update {
            it.copy(
                faceVerificationAttempts = attempts,
                error = if (attempts >= 3) {
                    "We still cannot see a face clearly. Try somewhere brighter, " +
                    "from Me → Verify your face. Nothing has happened to your account."
                } else {
                    "Face check failed. ${3 - attempts} attempt(s) remaining."
                },
                navigateToMain = attempts >= 3,
            )
        }
    }

    fun verifyReferralCode(code: String, overridePhone: String = "", overrideEmail: String = "") {
        if (code.isBlank()) {
            _uiState.update { it.copy(referralValid = false, referralError = null, referralNotFound = false) }
            return
        }
        _uiState.update { it.copy(referralCheckLoading = true, referralError = null, referralNotFound = false) }
        viewModelScope.launch {
            when (val result = repo.verifyReferralCode(code, overridePhone, overrideEmail)) {
                is com.zipper.app.data.repository.ReferralResult.Valid -> {
                    _uiState.update { it.copy(
                        referralCheckLoading = false,
                        referralValid = true,
                        referralNotFound = false,
                        referralError = null,
                        referralCode = code.trim().uppercase(),
                        // Kept so redemption asks the same question the check
                        // just answered. See the field docs above.
                        referralPhone = overridePhone,
                        referralEmail = overrideEmail,
                        referralAgencyName = result.agencyName,
                    ) }
                }
                is com.zipper.app.data.repository.ReferralResult.NotFound -> {
                    // Code doesn't exist — silently treat person as regular user, don't block
                    _uiState.update { it.copy(referralCheckLoading = false, referralValid = false, referralNotFound = true, referralError = null) }
                }
                is com.zipper.app.data.repository.ReferralResult.AlreadyUsed ->
                    _uiState.update { it.copy(referralCheckLoading = false, referralValid = false, referralError = "This code has already been used") }
                is com.zipper.app.data.repository.ReferralResult.AccountMismatch ->
                    _uiState.update { it.copy(referralCheckLoading = false, referralValid = false, referralError = "Details don't match the agency record for this code") }
                is com.zipper.app.data.repository.ReferralResult.Error ->
                    _uiState.update { it.copy(referralCheckLoading = false, referralValid = false, referralError = result.message) }
            }
        }
    }

    // ── Quick login ───────────────────────────────────────────────────────────

    /**
     * What the quick-login button should offer, or null when there is nothing to
     * offer.
     *
     * Read by the login screen so the button can say "Continue as Rahul" with
     * their photo, before any network call.
     *
     * Null also when this handset holds no device key, since a saved credential
     * with no key to sign for it cannot be redeemed. The repository decides
     * that; the screen only has to honour the null.
     */
    suspend fun savedQuickLogin(): com.zipper.app.util.QuickLoginStore.Saved? =
        repo.savedQuickLogin()

    /**
     * Sign back into the account most recently signed out from this device.
     *
     * Three round trips inside: a challenge, a Keystore signature over it, and
     * the redemption. See `AuthRepository.signInWithQuickLogin`.
     */
    fun quickLogin(deviceId: String) {
        if (_uiState.value.isLoading) return
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            handleAuthResult(repo.signInWithQuickLogin(deviceId))
        }
    }

    /**
     * One place that turns an [AuthResult] into navigation.
     *
     * The sign-in paths each had their own copy of this `when`, and they had
     * drifted — which is how the guest path ended up never checking for a ban
     * and never routing a finished profile to Home.
     */
    private fun handleAuthResult(result: AuthResult) {
        when (result) {
            is AuthResult.Success ->
                _uiState.update { it.copy(isLoading = false, navigateToMain = true) }
            is AuthResult.ProfileIncomplete ->
                _uiState.update { it.copy(isLoading = false, navigateToProfileSetup = true) }
            is AuthResult.Banned ->
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        navigateToBanned = true,
                        bannedReason = result.reason,
                        bannedKind = result.kind,
                        suspendedUntilMs = result.untilMillis,
                    )
                }
            is AuthResult.IdentityTaken ->
                _uiState.update { it.copy(isLoading = false, error = result.message) }
            is AuthResult.ObserverDenied ->
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = "This account manages the Zipper CRM and cannot be used in the app.",
                    )
                }
            is AuthResult.DeletedRecoverable ->
                _uiState.update { it.copy(isLoading = false, navigateToRecoverAccount = true) }
            is AuthResult.NeedsContactDetails ->
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        navigateToProfileSetup = true,
                        requiresPhone = result.requiresPhone,
                        requiresEmail = result.requiresEmail,
                        crmRole = result.crmRole,
                    )
                }
            is AuthResult.Error ->
                _uiState.update { it.copy(isLoading = false, error = result.message) }
            is AuthResult.CodeSent ->
                _uiState.update { it.copy(isLoading = false, verificationId = result.verificationId) }
        }
    }

    // ── Consume navigation events ─────────────────────────────────────────────

    fun signOut() {
        viewModelScope.launch {
            repo.signOut()
            _uiState.update { it.copy(navigateToMain = false, navigateToOtp = false, navigateToProfileSetup = false) }
        }
    }

    /**
     * Sign out AND forget this device, so quick sign-in will not offer the
     * account back.
     *
     * The honest "log out" for a shared or borrowed phone. Ordinary sign-out
     * deliberately remembers — that is the whole of the quick sign-in feature —
     * so there has to be a second door for the person who does not want to be
     * remembered.
     */
    fun signOutAndForget() {
        viewModelScope.launch {
            repo.signOutAndForget()
            _uiState.update {
                it.copy(navigateToMain = false, navigateToOtp = false, navigateToProfileSetup = false)
            }
        }
    }

    /**
     * Back out of profile setup and throw the half-made account away.
     *
     * ── WHY THE ACCOUNT HAS TO GO ────────────────────────────────────────────
     *
     * Somebody signed in, saw what was being asked of them, and changed their
     * mind. Leaving the account behind leaves a nameless, genderless document
     * that the feed and the discovery ranking can see — and, for a phone or
     * Google sign-in, holds that identifier against an account nobody is using,
     * so the same person cannot start again cleanly.
     *
     * `setupAbandoned` is set only on success. Navigating away from a failed
     * delete is the mistake the deletion flow already made once: the person was
     * told the account was gone while it was still there.
     */
    fun abandonSetup() {
        if (_uiState.value.isLoading) return
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.abandonSignup()) {
                is AuthResult.Success ->
                    _uiState.update { it.copy(isLoading = false, setupAbandoned = true) }
                is AuthResult.Error ->
                    _uiState.update { it.copy(isLoading = false, error = res.message) }
                else -> _uiState.update { it.copy(isLoading = false) }
            }
        }
    }

    /** Soft-delete (flags the doc; the CRM purges) and sign out. */
    /**
     * Request deletion. Schedules it; does not perform it.
     *
     * ── IT USED TO NAVIGATE AWAY WHETHER OR NOT IT WORKED ───────────────────
     *
     * The result of `softDeleteAccount()` was discarded here, and the call site
     * navigated to Login on the same line as the call — so a failed write (no
     * network, a refused rule) produced exactly the same experience as a
     * successful one: a goodbye screen over an account that was untouched and
     * would still be there, unchanged, the next time they signed in.
     *
     * `accountDeleted` is now only set when the request actually landed, and
     * the navigation waits for it. A failure stays on Settings and says why.
     */
    fun deleteAccount() {
        if (_uiState.value.isLoading) return
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val res = repo.softDeleteAccount()) {
                is AuthResult.Success -> _uiState.update {
                    it.copy(
                        isLoading = false,
                        accountDeleted = true,
                        navigateToMain = false,
                        navigateToOtp = false,
                        navigateToProfileSetup = false,
                    )
                }
                is AuthResult.Error -> _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = "${res.message} Your account has not been deleted.",
                    )
                }
                else -> _uiState.update { it.copy(isLoading = false) }
            }
        }
    }

    fun onNavigatedToOtp()          = _uiState.update { it.copy(navigateToOtp = false) }
    fun onNavigatedToProfileSetup() = _uiState.update { it.copy(navigateToProfileSetup = false) }
    fun onNavigatedToMain()         = _uiState.update { it.copy(navigateToMain = false) }
    fun onNavigatedToFaceVerification() = _uiState.update { it.copy(navigateToFaceVerification = false) }
    fun onNavigatedToLogin()        = _uiState.update { it.copy(navigateToLogin = false) }
    fun onNavigatedToBanned()       = _uiState.update { it.copy(navigateToBanned = false) }
    fun onAccountDeleted()          = _uiState.update { it.copy(accountDeleted = false) }
    fun clearError()                = _uiState.update { it.copy(error = null) }

    /**
     * They have read why the agency link failed and chosen to go on anyway.
     *
     * Their profile is already saved; what they are giving up is host status,
     * which an agency can restore by re-issuing the invitation. Clearing the
     * referral state too, so pressing Done again does not silently retry a code
     * they have just been told does not work for their account.
     */
    fun continueWithoutAgency() = _uiState.update {
        it.copy(
            hostActivationError = null,
            referralValid = false,
            referralCode = "",
            navigateToMain = true,
        )
    }

    /** Dismiss the failure and stay on the form, to correct the details and retry. */
    fun dismissHostActivationError() = _uiState.update { it.copy(hostActivationError = null) }
    fun isLoggedIn()                = repo.isLoggedIn()
}
