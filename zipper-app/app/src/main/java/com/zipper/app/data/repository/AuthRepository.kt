package com.zipper.app.data.repository

import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.storage.FirebaseStorage
import com.zipper.app.data.model.User
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

sealed class AuthResult {
    object Success : AuthResult()
    data class Error(val message: String) : AuthResult()
    data class CodeSent(val verificationId: String) : AuthResult()
    object ProfileIncomplete : AuthResult()
}

sealed class ReferralResult {
    object NotFound : ReferralResult()
    object AlreadyUsed : ReferralResult()
    object AccountMismatch : ReferralResult()
    data class Valid(val agencyId: String, val callRate: Int, val applicationId: String) : ReferralResult()
    data class Error(val message: String) : ReferralResult()
}

@Singleton
class AuthRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
) {
    val currentFirebaseUser get() = auth.currentUser

    // ── Phone OTP ─────────────────────────────────────────────────────────────

    fun sendOtp(
        phoneNumber: String,
        activity: android.app.Activity,
        callbacks: PhoneAuthProvider.OnVerificationStateChangedCallbacks,
    ) {
        val options = PhoneAuthOptions.newBuilder(auth)
            .setPhoneNumber(phoneNumber)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(callbacks)
            .build()
        PhoneAuthProvider.verifyPhoneNumber(options)
    }

    suspend fun verifyOtp(verificationId: String, code: String): AuthResult {
        return try {
            val credential = PhoneAuthProvider.getCredential(verificationId, code)
            signInWithCredential(credential)
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "OTP verification failed")
        }
    }

    private suspend fun signInWithCredential(credential: PhoneAuthCredential): AuthResult {
        return try {
            val result = auth.signInWithCredential(credential).await()
            val uid = result.user?.uid ?: return AuthResult.Error("No user ID")
            val isNew = result.additionalUserInfo?.isNewUser == true
            if (isNew) {
                createUserDocument(uid, result.user?.phoneNumber ?: "")
                AuthResult.ProfileIncomplete
            } else {
                val snap = firestore.collection("users").document(uid).get().await()
                val profileComplete = snap.getBoolean("isProfileComplete") ?: false
                if (profileComplete) AuthResult.Success else AuthResult.ProfileIncomplete
            }
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Sign in failed")
        }
    }

    // ── Google Sign-In ────────────────────────────────────────────────────────

    suspend fun signInWithGoogle(idToken: String): AuthResult {
        return try {
            val credential = GoogleAuthProvider.getCredential(idToken, null)
            val result = auth.signInWithCredential(credential).await()
            val uid = result.user?.uid ?: return AuthResult.Error("No user ID")
            val isNew = result.additionalUserInfo?.isNewUser == true
            if (isNew) {
                createUserDocument(
                    uid = uid,
                    phone = "",
                    name = result.user?.displayName ?: "",
                    photoUrl = result.user?.photoUrl?.toString() ?: "",
                )
                AuthResult.ProfileIncomplete
            } else {
                val snap = firestore.collection("users").document(uid).get().await()
                val profileComplete = snap.getBoolean("isProfileComplete") ?: false
                if (profileComplete) AuthResult.Success else AuthResult.ProfileIncomplete
            }
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Google sign-in failed")
        }
    }

    // ── Guest ─────────────────────────────────────────────────────────────────

    suspend fun signInAsGuest(): AuthResult {
        return try {
            val result = auth.signInAnonymously().await()
            val uid = result.user?.uid ?: return AuthResult.Error("No user ID")
            createUserDocument(uid, phone = "", name = "Guest_${uid.take(6)}")
            AuthResult.ProfileIncomplete
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Guest sign-in failed")
        }
    }

    // ── User document ─────────────────────────────────────────────────────────

    private suspend fun createUserDocument(
        uid: String,
        phone: String,
        name: String = "",
        photoUrl: String = "",
    ) {
        val user = User(
            uid = uid,
            name = name,
            photoUrl = photoUrl,
            diamonds = 100,
            createdAt = System.currentTimeMillis(),
            lastSeen = System.currentTimeMillis(),
        )
        firestore.collection("users").document(uid).set(user).await()
    }

    suspend fun saveUserProfile(
        name: String,
        gender: String,
        dob: Long,
        age: Int,
        city: String,
        deviceId: String,
        photoUri: Uri?,
    ): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            var photoUrl = ""
            if (photoUri != null) {
                val ref = storage.reference.child("profile_photos/$uid.jpg")
                ref.putFile(photoUri).await()
                photoUrl = ref.downloadUrl.await().toString()
            }
            val updates = mapOf(
                "name" to name,
                "gender" to gender,
                "dob" to dob,
                "age" to age,
                "city" to city,
                "deviceId" to deviceId,
                "photoUrl" to photoUrl,
                "isProfileComplete" to true,
                "isOnline" to true,
                "lastSeen" to System.currentTimeMillis(),
            )
            firestore.collection("users").document(uid).update(updates).await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Profile save failed")
        }
    }

    // ── Face verification + referral code ─────────────────────────────────────

    // Delete user entirely (account + Firestore doc) — called after 3 failed verifications
    suspend fun deleteCurrentUser(): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(uid).delete().await()
            auth.currentUser?.delete()?.await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Delete failed")
        }
    }

    // Upload verification selfie to Firebase Storage, mark isFaceVerified = true
    suspend fun saveFaceVerification(photoUri: Uri): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            val ref = storage.reference.child("face_verifications/$uid.jpg")
            ref.putFile(photoUri).await()
            val url = ref.downloadUrl.await().toString()
            firestore.collection("users").document(uid)
                .update("isFaceVerified", true, "facePhotoUrl", url).await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Face save failed")
        }
    }

    // Verify referral code — checks if code exists AND matches user's phone/email
    suspend fun verifyReferralCode(code: String): ReferralResult {
        return try {
            val snap = firestore.collection("hostApplications")
                .whereEqualTo("referralCode", code.trim().uppercase())
                .limit(1)
                .get().await()

            if (snap.isEmpty) return ReferralResult.NotFound

            val doc = snap.documents.first()
            val isActivated = doc.getBoolean("isActivated") ?: false
            if (isActivated) return ReferralResult.AlreadyUsed

            val applicantPhone = doc.getString("applicantPhone") ?: ""
            val applicantEmail = doc.getString("applicantEmail") ?: ""
            val currentPhone = auth.currentUser?.phoneNumber ?: ""
            val currentEmail = auth.currentUser?.email ?: ""

            val phoneMatch = applicantPhone.isNotBlank() && currentPhone.isNotBlank() &&
                applicantPhone.replace(" ", "") == currentPhone.replace(" ", "")
            val emailMatch = applicantEmail.isNotBlank() && currentEmail.isNotBlank() &&
                applicantEmail.equals(currentEmail, ignoreCase = true)

            if (!phoneMatch && !emailMatch) return ReferralResult.AccountMismatch

            // Valid — return host data
            ReferralResult.Valid(
                agencyId = doc.getString("agencyId") ?: "",
                callRate = doc.getLong("callRate")?.toInt() ?: 375,
                applicationId = doc.id,
            )
        } catch (e: Exception) {
            ReferralResult.Error(e.message ?: "Verification failed")
        }
    }

    // Called after successful referral code check — activates the host application
    suspend fun activateHostApplication(applicationId: String, agencyId: String, callRate: Int): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            // Mark application as used
            firestore.collection("hostApplications").document(applicationId)
                .update("isActivated", true, "activatedByUid", uid).await()
            // Update user to host
            firestore.collection("users").document(uid)
                .update("isHost", true, "agencyId", agencyId, "callRateBeans", callRate).await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Activation failed")
        }
    }

    // ── Realtime user listener ────────────────────────────────────────────────

    fun currentUserFlow(): Flow<User?> = callbackFlow {
        val uid = auth.currentUser?.uid
        if (uid == null) {
            trySend(null)
            close()
            return@callbackFlow
        }
        val listener = firestore.collection("users").document(uid)
            .addSnapshotListener { snap, _ ->
                if (snap != null && snap.exists()) {
                    trySend(snap.toObject(User::class.java))
                } else {
                    trySend(null)
                }
            }
        awaitClose { listener.remove() }
    }

    // ── Misc ──────────────────────────────────────────────────────────────────

    suspend fun updateOnlineStatus(isOnline: Boolean) {
        val uid = auth.currentUser?.uid ?: return
        firestore.collection("users").document(uid)
            .update("isOnline", isOnline, "lastSeen", System.currentTimeMillis())
    }

    suspend fun saveFcmToken(token: String) {
        val uid = auth.currentUser?.uid ?: return
        firestore.collection("users").document(uid).update("fcmToken", token)
    }

    fun signOut() {
        auth.signOut()
    }

    fun isLoggedIn() = auth.currentUser != null
}
