package com.zipper.datingapp.security

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.tasks.await

/**
 * BanManager — handles device bans and login suspensions.
 *
 * Device bans:
 *   - Stored in `device_bans/{deviceFingerprint}` in Firestore
 *   - Require super admin approval before activating (isActive = false initially)
 *   - Once active, device is blocked at app startup
 *
 * Login suspensions:
 *   - Stored in `users/{uid}` as suspendedUntilMs: Long
 *   - Applied by CRM team after report review
 *   - Automatically expires when current time > suspendedUntilMs
 *
 * Report workflow:
 *   PENDING → UNDER_REVIEW → WARNING_ISSUED | PENALTY_APPLIED | SUSPENDED | DISMISSED
 *
 * Penalty types:
 *   - WARNING: No action, just a flag
 *   - BEAN_DEDUCTION: Remove N beans from host balance
 *   - DIAMOND_DEDUCTION: Remove N diamonds from user balance
 *   - SUSPENSION: Block login for N hours
 *   - DEVICE_BAN_REQUEST: Submit to super admin for device ban approval
 */
object BanManager {

    private val db get() = FirebaseFirestore.getInstance()

    // ─────────────────────────────────────────────────────────────────────────
    // LOGIN SUSPENSION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Check if user's login is currently suspended.
     * @return SuspensionInfo if suspended, null if clear.
     */
    suspend fun checkLoginSuspension(uid: String): SuspensionInfo? {
        return try {
            val doc = db.collection("users").document(uid).get().await()
            val suspendedUntilMs = doc.getLong("suspendedUntilMs") ?: 0L
            val reason = doc.getString("suspensionReason") ?: "Policy violation"
            if (suspendedUntilMs > System.currentTimeMillis()) {
                SuspensionInfo(suspendedUntilMs = suspendedUntilMs, reason = reason)
            } else null
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Apply a login suspension to a user.
     * Called by CRM Cloud Function (server-side), but exposed here for reference.
     * @param durationHours Number of hours to suspend login
     */
    suspend fun applySuspension(uid: String, durationHours: Int, reason: String, appliedBy: String) {
        val suspendedUntilMs = System.currentTimeMillis() + (durationHours * 3_600_000L)
        db.collection("users").document(uid)
            .update(
                mapOf(
                    "suspendedUntilMs" to suspendedUntilMs,
                    "suspensionReason" to reason,
                    "lastSuspendedBy" to appliedBy,
                    "lastSuspendedAt" to System.currentTimeMillis(),
                ),
            )
            .await()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEVICE BAN REQUEST
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Submit a device ban request. Requires super admin approval.
     * isActive is false until admin approves via CRM.
     */
    suspend fun submitDeviceBanRequest(
        deviceFingerprint: String,
        deviceModel: String,
        uid: String,
        reason: String,
        requestedBy: String,   // CRM agent ID
        reportId: String,
    ) {
        val banRequest = mapOf(
            "deviceFingerprint" to deviceFingerprint,
            "deviceModel" to deviceModel,
            "uid" to uid,
            "reason" to reason,
            "requestedBy" to requestedBy,
            "reportId" to reportId,
            "requestedAt" to System.currentTimeMillis(),
            "isActive" to false,   // ← inactive until super admin approves
            "approvedBy" to null,
            "approvedAt" to null,
            "status" to "PENDING_APPROVAL",
        )

        db.collection("device_ban_requests")
            .add(banRequest)
            .await()
    }

    /**
     * Super admin approves a device ban request. This activates the ban.
     * This is called from the CRM app (admin-side), not from the user app.
     * Included here for completeness.
     */
    suspend fun approveDeviceBan(
        requestId: String,
        deviceFingerprint: String,
        adminUid: String,
        reason: String,
    ) {
        val batch = db.batch()

        // Activate ban in device_bans collection (checked at startup)
        val banRef = db.collection("device_bans").document(deviceFingerprint)
        batch.set(
            banRef,
            mapOf(
                "isActive" to true,
                "reason" to reason,
                "bannedAt" to System.currentTimeMillis(),
                "bannedBy" to adminUid,
                "requestId" to requestId,
            ),
        )

        // Mark request as approved
        val requestRef = db.collection("device_ban_requests").document(requestId)
        batch.update(
            requestRef,
            mapOf(
                "status" to "APPROVED",
                "approvedBy" to adminUid,
                "approvedAt" to System.currentTimeMillis(),
                "isActive" to true,
            ),
        )

        batch.commit().await()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REPORT WORKFLOW
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Submit a report against a user.
     * Creates a Firestore document in `reports` collection.
     */
    suspend fun submitReport(
        reporterId: String,
        reportedUserId: String,
        reason: String,
        description: String,
        evidenceUrls: List<String> = emptyList(),
    ): String {
        val report = mapOf(
            "reporterId" to reporterId,
            "reportedUserId" to reportedUserId,
            "reason" to reason,
            "description" to description,
            "evidenceUrls" to evidenceUrls,
            "status" to "PENDING",
            "createdAt" to System.currentTimeMillis(),
            "reviewedBy" to null,
            "reviewedAt" to null,
            "action" to null,
            "actionDetails" to null,
        )

        val docRef = db.collection("reports").add(report).await()
        return docRef.id
    }

    /**
     * Update report status (called by CRM team via admin app or Cloud Function).
     * Allowed transitions: PENDING → UNDER_REVIEW → WARNING_ISSUED | PENALTY_APPLIED | DISMISSED
     */
    suspend fun updateReportStatus(
        reportId: String,
        newStatus: String,
        action: String?,
        actionDetails: Map<String, Any>?,
        reviewerUid: String,
    ) {
        val update = mutableMapOf<String, Any?>(
            "status" to newStatus,
            "reviewedBy" to reviewerUid,
            "reviewedAt" to System.currentTimeMillis(),
            "action" to action,
            "actionDetails" to actionDetails,
        )
        db.collection("reports").document(reportId).update(update).await()
    }
}

data class SuspensionInfo(
    val suspendedUntilMs: Long,
    val reason: String,
) {
    val remainingMs: Long get() = suspendedUntilMs - System.currentTimeMillis()
    val remainingHours: Long get() = remainingMs / 3_600_000L
    val remainingMinutes: Long get() = (remainingMs % 3_600_000L) / 60_000L
}
