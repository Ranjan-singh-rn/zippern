package com.zipper.datingapp.data

import android.util.Log
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.storage.FirebaseStorage
import kotlinx.coroutines.tasks.await

private const val TAG = "CrmGiftMediaUrls"

/**
 * Turns a value from Firestore into an HTTPS URL ExoPlayer / Coil can load.
 *
 * Supports:
 * - Full `https://` / `http://` URLs (returned as-is)
 * - `gs://bucket/path` Firebase Storage URIs
 * - Default-bucket paths, e.g. `crm_gifts/abc/video.mp4` (uses [FirebaseStorage.reference.child])
 */
suspend fun resolveFirebaseStorageUrl(raw: String?): String {
    if (raw.isNullOrBlank()) return ""
    val t = raw.trim()
    if (t.startsWith("http://", ignoreCase = true) || t.startsWith("https://", ignoreCase = true)) {
        return t
    }
    return runCatching {
        when {
            t.startsWith("gs://") -> FirebaseStorage.getInstance()
                .getReferenceFromUrl(t)
                .downloadUrl
                .await()
                .toString()
            else -> FirebaseStorage.getInstance()
                .reference
                .child(t.removePrefix("/"))
                .downloadUrl
                .await()
                .toString()
        }
    }.getOrElse { e ->
        Log.w(TAG, "resolveFirebaseStorageUrl failed raw=$raw", e)
        ""
    }
}

private fun firstNonBlank(vararg values: String?): String? =
    values.firstOrNull { !it.isNullOrBlank() }?.trim()

/** First non-empty video field from common CRM / Firestore naming. */
fun DocumentSnapshot.crmVideoRaw(): String? = firstNonBlank(
    getString("videoUrl"),
    getString("video"),
    getString("mp4Url"),
    getString("mp4"),
    getString("videoPath"),
    getString("videoFile"),
    getString("mediaUrl")
)

/** First non-empty audio field from common CRM / Firestore naming. */
fun DocumentSnapshot.crmAudioRaw(): String? = firstNonBlank(
    getString("soundUrl"),
    getString("audioUrl"),
    getString("mp3Url"),
    getString("mp3"),
    getString("audio"),
    getString("audioPath"),
    getString("soundPath"),
    getString("audioFile")
)

/** 0–12: minimum overlay seconds; 0 means app default (~10s) for CRM. */
private fun DocumentSnapshot.crmDisplayDurationSeconds(): Int {
    val n = when (val v = get("displayDurationSeconds")) {
        is Number -> v.toInt()
        is String -> v.trim().toIntOrNull() ?: 0
        else -> 0
    }
    if (n != 0) return n.coerceIn(0, 12)
    val alt = when (val v = get("minDisplaySeconds") ?: get("displayDuration")) {
        is Number -> v.toInt()
        is String -> v.toString().trim().toIntOrNull() ?: 0
        else -> 0
    }
    return alt.coerceIn(0, 12)
}

/** First non-empty thumbnail / preview field. */
fun DocumentSnapshot.crmThumbnailRaw(): String? = firstNonBlank(
    getString("thumbnailUrl"),
    getString("thumbnail"),
    getString("imageUrl"),
    getString("thumbUrl"),
    getString("thumbnailPath"),
    getString("previewUrl")
)

/**
 * Builds a [Gift] for the Premium tab, resolving Storage paths to HTTPS download URLs.
 */
suspend fun DocumentSnapshot.toResolvedCrmGift(): Gift? {
    val name = getString("name") ?: return null
    // Safety guard: if CRM sets status="inactive" without toggling active=false, honour it.
    val statusField = getString("status")?.trim()?.lowercase()
    if (statusField != null && statusField == "inactive") return null
    val videoUrl = resolveFirebaseStorageUrl(crmVideoRaw())
    val soundUrl = resolveFirebaseStorageUrl(crmAudioRaw())
    val thumbnailUrl = resolveFirebaseStorageUrl(crmThumbnailRaw())
    val category = getString("category")?.trim()?.ifBlank { null } ?: "CRM_PREMIUM"
    return Gift(
        id = id,
        name = name,
        price = (getLong("price") ?: 0L).toInt(),
        thumbnailUrl = thumbnailUrl,
        videoUrl = videoUrl,
        soundUrl = soundUrl,
        category = category,
        points = (getLong("points") ?: 0L).toInt(),
        isCrmGift = true,
        crmDocId = id,
        displayDurationSeconds = crmDisplayDurationSeconds()
    )
}
