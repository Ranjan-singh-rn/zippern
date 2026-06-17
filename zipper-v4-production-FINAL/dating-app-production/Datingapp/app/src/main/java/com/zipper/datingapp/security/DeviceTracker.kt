package com.zipper.datingapp.security

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.tasks.await
import java.security.MessageDigest
import java.util.UUID

/**
 * DeviceTracker — captures device fingerprint and enforces single-device login.
 *
 * Device fingerprint = SHA-256(androidId + model + manufacturer)
 * Stored in Firestore: users/{uid}/activeSession
 *
 * On new login:
 *   1. Generate new sessionId (UUID)
 *   2. Write {sessionId, deviceFingerprint, deviceModel, loginAt} to Firestore
 *   3. Old device detects sessionId mismatch → auto-logout
 *
 * SECURITY NOTE: deviceFingerprint is hashed, never stored raw.
 */
object DeviceTracker {

    private const val SESSION_COLLECTION = "user_sessions"
    private const val DEVICE_BANS_COLLECTION = "device_bans"

    // ─────────────────────────────────────────────────────────────────────────
    // FINGERPRINT
    // ─────────────────────────────────────────────────────────────────────────

    @SuppressLint("HardwareIds")
    fun getDeviceFingerprint(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val model = Build.MODEL ?: "unknown"
        val manufacturer = Build.MANUFACTURER ?: "unknown"
        val raw = "$androidId|$model|$manufacturer"
        return sha256(raw)
    }

    fun getDeviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}"

    fun getAndroidVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"

    private fun sha256(input: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEVICE BAN CHECK
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Check if this device is banned. Call at app startup before auth.
     * @return BanInfo if banned, null if clean.
     */
    suspend fun checkDeviceBan(context: Context): DeviceBanInfo? {
        val fingerprint = getDeviceFingerprint(context)
        val db = FirebaseFirestore.getInstance()
        return try {
            val doc = db.collection(DEVICE_BANS_COLLECTION)
                .document(fingerprint)
                .get()
                .await()
            if (doc.exists() && doc.getBoolean("isActive") == true) {
                DeviceBanInfo(
                    reason = doc.getString("reason") ?: "Violation of terms",
                    bannedAt = doc.getLong("bannedAt") ?: 0L,
                    bannedBy = doc.getString("bannedBy") ?: "system",
                )
            } else null
        } catch (e: Exception) {
            null // On error, allow access (fail open for bans)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SESSION MANAGEMENT (single-device login)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register a new login session. Invalidates any existing session on another device.
     * Call this immediately after successful Firebase Auth sign-in.
     */
    suspend fun registerNewSession(context: Context, uid: String): String {
        val sessionId = UUID.randomUUID().toString()
        val fingerprint = getDeviceFingerprint(context)
        val db = FirebaseFirestore.getInstance()

        val sessionData = mapOf(
            "sessionId" to sessionId,
            "deviceFingerprint" to fingerprint,
            "deviceModel" to getDeviceModel(),
            "androidVersion" to getAndroidVersion(),
            "loginAt" to System.currentTimeMillis(),
            "uid" to uid,
        )

        // Also log to user_devices subcollection for audit trail (non-fatal — don't crash on rules error)
        try {
            db.collection("users").document(uid)
                .collection("user_devices")
                .document(fingerprint)
                .set(sessionData, SetOptions.merge())
                .await()
        } catch (e: Exception) {
            Log.w("DeviceTracker", "user_devices write failed (non-fatal): ${e.message}")
        }

        // Write active session — this atomically invalidates old device
        try {
            db.collection(SESSION_COLLECTION)
                .document(uid)
                .set(sessionData)
                .await()
        } catch (e: Exception) {
            Log.w("DeviceTracker", "user_sessions write failed (non-fatal): ${e.message}")
        }

        // Cache locally
        _currentSessionId = sessionId
        return sessionId
    }

    /**
     * Start listening for session invalidation. If another device logs in,
     * the sessionId in Firestore changes → call onSessionInvalidated().
     * @param uid Firebase user ID
     * @param currentSessionId The session ID registered at login
     * @param onSessionInvalidated Called when user must be logged out
     */
    fun startSessionListener(
        uid: String,
        currentSessionId: String,
        onSessionInvalidated: () -> Unit,
    ): com.google.firebase.firestore.ListenerRegistration {
        val db = FirebaseFirestore.getInstance()
        return db.collection(SESSION_COLLECTION)
            .document(uid)
            .addSnapshotListener { snapshot, error ->
                if (error != null || snapshot == null) return@addSnapshotListener
                val activeSessionId = snapshot.getString("sessionId")
                if (activeSessionId != null && activeSessionId != currentSessionId) {
                    // Another device has logged in — this session is now invalid
                    onSessionInvalidated()
                }
            }
    }

    /**
     * Clear session on logout.
     */
    suspend fun clearSession(uid: String) {
        try {
            FirebaseFirestore.getInstance()
                .collection(SESSION_COLLECTION)
                .document(uid)
                .delete()
                .await()
        } catch (_: Exception) {}
        _currentSessionId = null
    }

    private var _currentSessionId: String? = null
    val currentSessionId: String? get() = _currentSessionId
}

data class DeviceBanInfo(
    val reason: String,
    val bannedAt: Long,
    val bannedBy: String,
)
