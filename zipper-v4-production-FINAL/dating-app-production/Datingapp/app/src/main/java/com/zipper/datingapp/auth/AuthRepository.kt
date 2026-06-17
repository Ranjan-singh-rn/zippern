@file:Suppress("DEPRECATION")
package com.zipper.datingapp.auth

import android.content.Context
import android.location.Geocoder
import android.os.Build
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.datingapp.R
import com.zipper.datingapp.data.Agency
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.data.UserRole
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Handles all Firebase Auth operations:
 * - Phone OTP
 * - Google Sign-In
 * - Anonymous (guest)
 * - Session sign-out + revoke
 *
 * Also handles:
 * - Referral code validation (HOST vs USER detection)
 * - City-level geocoding (NOT area/neighbourhood)
 * - Gender lock enforcement (on profile save)
 */
class AuthRepository(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance(),
) {

    // ─────────────────────────────────────────────────────────────────────────
    // CURRENT USER
    // ─────────────────────────────────────────────────────────────────────────

    val currentUser: FirebaseUser? get() = auth.currentUser
    val isLoggedIn: Boolean get() = auth.currentUser != null && auth.currentUser?.isAnonymous == false

    // ─────────────────────────────────────────────────────────────────────────
    // PHONE OTP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Start phone number verification. Callbacks on the passed [callbacks].
     */
    fun sendPhoneOtp(
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

    /**
     * Sign in with a phone OTP credential.
     */
    suspend fun signInWithPhoneCredential(credential: PhoneAuthCredential): FirebaseUser? {
        return auth.signInWithCredential(credential).await().user
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOOGLE SIGN-IN
    // ─────────────────────────────────────────────────────────────────────────

    fun getGoogleSignInClient(context: Context) =
        GoogleSignIn.getClient(
            context,
            GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(context.getString(R.string.default_web_client_id))
                .requestEmail()
                .build()
        )

    /**
     * Exchange a Google ID token for a Firebase credential and sign in.
     */
    suspend fun signInWithGoogle(idToken: String): FirebaseUser? {
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        return auth.signInWithCredential(credential).await().user
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ANONYMOUS (GUEST)
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun signInAsGuest(): FirebaseUser? =
        auth.signInAnonymously().await().user

    // ─────────────────────────────────────────────────────────────────────────
    // SIGN OUT
    // ─────────────────────────────────────────────────────────────────────────

    suspend fun signOutAndClearSession(context: Context) {
        // Mark user offline before sign out
        auth.currentUser?.uid?.let { uid ->
            runCatching {
                firestore.collection("users").document(uid)
                    .update("isOnline", false, "lastSeen", System.currentTimeMillis())
                    .await()
            }
        }
        auth.signOut()
        revokeGoogleSession(context)
        clearEncryptedSession(context)
    }

    private suspend fun revokeGoogleSession(context: Context) {
        val client = getGoogleSignInClient(context)
        runCatching { client.signOut().await() }
        runCatching { client.revokeAccess().await() }
    }

    private fun clearEncryptedSession(context: Context) {
        runCatching {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val securePrefs = EncryptedSharedPreferences.create(
                context,
                SESSION_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            securePrefs.edit().clear().apply()
        }
        context.getSharedPreferences(SESSION_PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().apply()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REFERRAL CODE VALIDATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Validates a referral code against the `agencies` collection.
     *
     * @param referralCode The code entered by the user at registration
     * @return Agency if the code is valid and active, null otherwise
     */
    suspend fun validateReferralCode(referralCode: String): Agency? {
        if (referralCode.isBlank()) return null
        return try {
            val snapshot = firestore
                .collection("agencies")
                .whereEqualTo("referralCode", referralCode.trim().uppercase())
                .whereEqualTo("isActive", true)
                .limit(1)
                .get()
                .await()
            if (snapshot.isEmpty) {
                Log.d(TAG, "Referral code not found: $referralCode")
                null
            } else {
                snapshot.documents.first().toObject(Agency::class.java)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Referral code validation failed", e)
            null
        }
    }

    /**
     * Determines the user role based on referral code.
     * If referral code is valid → HOST, otherwise → USER.
     */
    suspend fun resolveUserRole(referralCode: String?): Pair<UserRole, Agency?> {
        if (referralCode.isNullOrBlank()) return Pair(UserRole.USER, null)
        val agency = validateReferralCode(referralCode)
        return if (agency != null) Pair(UserRole.HOST, agency)
        else Pair(UserRole.USER, null)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PROFILE CREATION & GENDER LOCK
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Creates the initial user profile in Firestore.
     * Called once after registration.
     *
     * Gender is stored here and MUST NOT be changeable after this point.
     * Role is determined by referral code validation.
     */
    suspend fun createUserProfile(
        uid: String,
        name: String,
        gender: String,           // "MALE" or "FEMALE" — immutable after this
        dateOfBirth: Long,
        city: String,
        country: String,
        role: UserRole,
        referralCode: String? = null,
        agencyId: String? = null,
        agencyName: String? = null,
        profilePhotoUrl: String = "",
    ): Result<Unit> {
        val now = System.currentTimeMillis()
        val age = calculateAgeFromDob(dateOfBirth)
        val profile = UserProfile(
            id = uid,
            name = name.trim(),
            gender = gender.uppercase(),  // IMMUTABLE — stored once
            age = age,
            dateOfBirth = dateOfBirth,
            role = role.name,
            city = city.trim(),
            country = country.trim(),
            photoUrl = profilePhotoUrl,
            referralCode = referralCode?.trim()?.uppercase(),
            agencyId = agencyId,
            agencyName = agencyName,
            isOnline = true,
            createdAt = now,
            profileNumber = generateProfileNumber(uid),
        )
        return try {
            firestore.collection("users").document(uid)
                .set(profile)
                .await()

            // If host, add to agency's hostIds list
            if (role == UserRole.HOST && !agencyId.isNullOrBlank()) {
                runCatching {
                    firestore.collection("agencies").document(agencyId)
                        .update("hostIds", com.google.firebase.firestore.FieldValue.arrayUnion(uid))
                        .await()
                }
            }

            // Initialize balance document
            firestore.collection("balances").document(uid)
                .set(mapOf("diamonds" to 0L, "beans" to 0L, "updatedAt" to now))
                .await()

            Result.success(Unit)
        } catch (e: Exception) {
            Log.e(TAG, "Create user profile failed", e)
            Result.failure(e)
        }
    }

    /**
     * Checks whether the user's profile has been created in Firestore.
     * Used to detect first-time registration vs returning login.
     */
    suspend fun isProfileComplete(uid: String): Boolean {
        return try {
            val doc = firestore.collection("users").document(uid).get().await()
            val profile = doc.toObject(UserProfile::class.java)
            profile != null && profile.name.isNotBlank() && profile.gender.isNotBlank()
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Fetches the user profile from Firestore.
     */
    suspend fun fetchUserProfile(uid: String): UserProfile? {
        return try {
            val doc = firestore.collection("users").document(uid).get().await()
            doc.toObject(UserProfile::class.java)?.copy(id = uid)
        } catch (e: Exception) {
            Log.e(TAG, "Fetch user profile failed for $uid", e)
            null
        }
    }

    /**
     * Updates editable profile fields. Gender is explicitly excluded from updates.
     *
     * Fields that are NEVER updated here:
     * - gender (immutable)
     * - role (set at registration)
     * - referralCode (set at registration)
     * - agencyId / agencyName (set at registration)
     * - diamondBalance / beanBalance (managed by Cloud Functions)
     * - totalBeansEarned / totalDiamondsSpent (managed by Cloud Functions)
     * - level (calculated by Cloud Functions)
     */
    suspend fun updateEditableProfileFields(
        uid: String,
        name: String? = null,
        age: Int? = null,
        city: String? = null,
        bio: String? = null,
        hobbies: List<String>? = null,
        languages: List<String>? = null,
        photoUrl: String? = null,
        galleryUrls: List<String>? = null,
        audioCallRate: Int? = null,
        videoCallRate: Int? = null,
    ): Result<Unit> {
        val updates = mutableMapOf<String, Any>()
        name?.let { updates["name"] = it.trim() }
        age?.let { updates["age"] = it }
        city?.let { updates["city"] = it.trim() }
        bio?.let { updates["bio"] = it.trim() }
        hobbies?.let { updates["hobbies"] = it }
        languages?.let { updates["languages"] = it }
        photoUrl?.let { updates["photoUrl"] = it }
        galleryUrls?.let { updates["galleryUrls"] = it }
        audioCallRate?.let { updates["audioCallRateBeansPerMin"] = it; updates["customAudioPrice"] = it }
        videoCallRate?.let { updates["videoCallRateBeansPerMin"] = it; updates["customVideoPrice"] = it }
        updates["updatedAt"] = System.currentTimeMillis()

        return try {
            firestore.collection("users").document(uid).update(updates).await()
            Result.success(Unit)
        } catch (e: Exception) {
            Log.e(TAG, "Update profile fields failed", e)
            Result.failure(e)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CITY GEOCODING (city only — NOT area/neighbourhood)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Resolves a lat/lng coordinate to a city name.
     *
     * Uses Geocoder.locality (city), NOT subLocality (area/neighbourhood).
     * Falls back gracefully if Geocoder is unavailable.
     *
     * @return Pair(city, country) — both may be empty strings if resolution fails
     */
    suspend fun resolveCityFromCoordinates(
        context: Context,
        latitude: Double,
        longitude: Double,
    ): Pair<String, String> = withContext(Dispatchers.IO) {
        try {
            if (!Geocoder.isPresent()) return@withContext Pair("", "")
            val geocoder = Geocoder(context, Locale.ENGLISH)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                var result = Pair("", "")
                geocoder.getFromLocation(latitude, longitude, 1) { addresses ->
                    val addr = addresses.firstOrNull() ?: return@getFromLocation
                    val city = addr.locality ?: addr.subAdminArea ?: ""   // CITY, not subLocality
                    val country = addr.countryName ?: ""
                    result = Pair(city, country)
                }
                result
            } else {
                @Suppress("DEPRECATION")
                val addresses = geocoder.getFromLocation(latitude, longitude, 1)
                val addr = addresses?.firstOrNull() ?: return@withContext Pair("", "")
                val city = addr.locality ?: addr.subAdminArea ?: ""   // CITY, not subLocality
                val country = addr.countryName ?: ""
                Pair(city, country)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Geocoding failed", e)
            Pair("", "")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private fun calculateAgeFromDob(dobMillis: Long): Int {
        val now = java.util.Calendar.getInstance()
        val dob = java.util.Calendar.getInstance().apply { timeInMillis = dobMillis }
        var age = now.get(java.util.Calendar.YEAR) - dob.get(java.util.Calendar.YEAR)
        if (now.get(java.util.Calendar.DAY_OF_YEAR) < dob.get(java.util.Calendar.DAY_OF_YEAR)) age--
        return age.coerceAtLeast(0)
    }

    /**
     * Generates a 5-digit profile display number from the UID.
     */
    private fun generateProfileNumber(uid: String): String {
        val hash = uid.hashCode().and(0xFFFFF)  // 20-bit hash
        return hash.toString().takeLast(5).padStart(5, '0')
    }

    companion object {
        private const val TAG = "AuthRepository"
        private const val SESSION_PREFS_NAME = "secure_session"
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION GUARD — blocks guest users from sensitive actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline guard for actions that require a real (non-guest) account.
 * Pass [onBlocked] to show a login prompt; [action] is only invoked for real users.
 */
inline fun checkAccess(
    isGuest: Boolean,
    onBlocked: () -> Unit,
    action: () -> Unit,
) {
    if (isGuest) onBlocked() else action()
}
