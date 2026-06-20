package com.zipper.app.ui.screens.auth

import android.app.Activity
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthProvider
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
    val referralCheckLoading: Boolean = false,
    val referralError: String? = null,
    val referralValid: Boolean = false,
    val referralNotFound: Boolean = false,       // code typed but doesn't exist → treat as user
    // Stored from ReferralResult.Valid — used to activate host application on profile save
    val referralAgencyId: String = "",
    val referralCallRate: Int = 375,
    val referralApplicationId: String = "",
)

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    // ── Phone OTP ─────────────────────────────────────────────────────────────

    fun sendOtp(phoneNumber: String, activity: Activity) {
        _uiState.update { it.copy(isLoading = true, error = null) }
        val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                // Auto-retrieved OTP
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
        repo.sendOtp(phoneNumber, activity, callbacks)
    }

    fun verifyOtp(code: String) {
        val verificationId = _uiState.value.verificationId ?: return
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.verifyOtp(verificationId, code)) {
                is AuthResult.Success -> _uiState.update { it.copy(isLoading = false, navigateToMain = true) }
                is AuthResult.ProfileIncomplete -> _uiState.update { it.copy(isLoading = false, navigateToProfileSetup = true) }
                is AuthResult.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                else -> {}
            }
        }
    }

    // ── Google Sign-In ────────────────────────────────────────────────────────

    fun signInWithGoogle(idToken: String) {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.signInWithGoogle(idToken)) {
                is AuthResult.Success -> _uiState.update { it.copy(isLoading = false, navigateToMain = true) }
                is AuthResult.ProfileIncomplete -> _uiState.update { it.copy(isLoading = false, navigateToProfileSetup = true) }
                is AuthResult.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                else -> {}
            }
        }
    }

    // ── Guest ─────────────────────────────────────────────────────────────────

    fun signInAsGuest() {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.signInAsGuest()) {
                is AuthResult.Success -> _uiState.update { it.copy(isLoading = false, navigateToMain = true) }
                is AuthResult.ProfileIncomplete -> _uiState.update { it.copy(isLoading = false, navigateToProfileSetup = true) }
                is AuthResult.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                else -> {}
            }
        }
    }

    // ── Profile Setup ─────────────────────────────────────────────────────────

    fun saveProfile(name: String, gender: String, dob: Long, age: Int, city: String, deviceId: String, photoUri: Uri?) {
        _uiState.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.saveUserProfile(name, gender, dob, age, city, deviceId, photoUri)) {
                is AuthResult.Success -> {
                    // If a valid referral code was entered, activate the host application now
                    val state = _uiState.value
                    if (state.referralValid && state.referralApplicationId.isNotBlank()) {
                        repo.activateHostApplication(
                            applicationId = state.referralApplicationId,
                            agencyId = state.referralAgencyId,
                            callRate = state.referralCallRate,
                        )
                    }
                    _uiState.update { it.copy(isLoading = false, navigateToFaceVerification = true) }
                }
                is AuthResult.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                else -> {}
            }
        }
    }

    // ── Face Verification ─────────────────────────────────────────────────────

    fun saveFaceVerification(photoUri: android.net.Uri) {
        _uiState.update { it.copy(isLoading = true) }
        viewModelScope.launch {
            when (val result = repo.saveFaceVerification(photoUri)) {
                is AuthResult.Success -> _uiState.update { it.copy(isLoading = false, navigateToMain = true) }
                is AuthResult.Error -> {
                    val attempts = _uiState.value.faceVerificationAttempts + 1
                    if (attempts >= 3) {
                        repo.clearAllUserData()
                        _uiState.update { it.copy(isLoading = false, accountDeleted = true, faceVerificationAttempts = attempts) }
                    } else {
                        _uiState.update { it.copy(isLoading = false, error = result.message, faceVerificationAttempts = attempts) }
                    }
                }
                else -> {}
            }
        }
    }

    fun faceDetectionFailed() {
        val attempts = _uiState.value.faceVerificationAttempts + 1
        if (attempts >= 3) {
            _uiState.update { it.copy(isLoading = true) }
            viewModelScope.launch {
                repo.clearAllUserData()
                _uiState.update { it.copy(isLoading = false, accountDeleted = true, faceVerificationAttempts = attempts) }
            }
        } else {
            _uiState.update {
                it.copy(
                    faceVerificationAttempts = attempts,
                    error = "Face check failed. ${3 - attempts} attempt(s) remaining.",
                )
            }
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
                        referralAgencyId = result.agencyId,
                        referralCallRate = result.callRate,
                        referralApplicationId = result.applicationId,
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

    // ── Consume navigation events ─────────────────────────────────────────────

    fun signOut() {
        viewModelScope.launch {
            repo.signOut()
            _uiState.update { it.copy(navigateToMain = false, navigateToOtp = false, navigateToProfileSetup = false) }
        }
    }

    fun onNavigatedToOtp()          = _uiState.update { it.copy(navigateToOtp = false) }
    fun onNavigatedToProfileSetup() = _uiState.update { it.copy(navigateToProfileSetup = false) }
    fun onNavigatedToMain()         = _uiState.update { it.copy(navigateToMain = false) }
    fun onNavigatedToFaceVerification() = _uiState.update { it.copy(navigateToFaceVerification = false) }
    fun onNavigatedToLogin()        = _uiState.update { it.copy(navigateToLogin = false) }
    fun onAccountDeleted()          = _uiState.update { it.copy(accountDeleted = false) }
    fun clearError()                = _uiState.update { it.copy(error = null) }
    fun isLoggedIn()                = repo.isLoggedIn()
}
