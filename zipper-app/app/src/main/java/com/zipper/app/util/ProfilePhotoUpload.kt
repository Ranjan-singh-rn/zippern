package com.zipper.app.util

/**
 * A-1 / A-2 (APK 20): what a failed signup avatar upload means for the save.
 *
 * ── WHY THE PHOTO MUST NOT BLOCK THE PROFILE ─────────────────────────────────
 *
 * Build 19 uploaded the ORIGINAL gallery file to `profileMedia/{uid}/avatar.jpg`
 * and the Storage rule caps an image at 5 MiB. A 12–50 MP camera JPEG is
 * routinely 4–10 MB, so the upload was refused with an HTTP 403 and the whole
 * of `saveUserProfile` failed on it — the person saw "User does not have
 * permission to access this object." and could not finish signing up at all.
 *
 * Two corrections, in this order:
 *   1. the signup avatar is compressed exactly as the Edit-Profile avatar is
 *      (`MediaUtils.compressImage`: 1080 px on the long side, JPEG q72), which
 *      lands it well under the cap; and
 *   2. if the upload STILL fails, the profile is saved WITHOUT the photo and
 *      the person is told in words they can act on. The avatar is a nicety; the
 *      account is the point.
 *
 * Pure, so the mapping from "what went wrong" to "what the person is told" is
 * unit-tested without Firebase.
 */
object ProfilePhotoUpload {

    /** The one sentence the screen shows for a refused or oversized photo. */
    const val UPLOAD_FAILED_MESSAGE =
        "Photo could not be uploaded (too large or refused). Try a smaller photo or skip it."

    /** Why the bytes could not be produced at all (decode failure) — same advice applies. */
    const val UNREADABLE_MESSAGE =
        "That photo could not be read. Try a different photo or skip it."

    /** The Storage cap on `profileMedia` images (storage.rules `maxSize(5)`), in bytes. */
    const val MAX_UPLOAD_BYTES: Long = 5L * 1024L * 1024L

    /** How the upload step ended. The profile write happens regardless. */
    sealed interface Outcome {
        /** [photoUrl] is the download URL to store. */
        data class Uploaded(val photoUrl: String) : Outcome
        /** Not uploaded; [message] is for the person. The save goes on without a photo. */
        data class Skipped(val message: String) : Outcome
    }

    /**
     * Is this failure the Storage service refusing the object (a rule, a size
     * cap, a quota) rather than a dropped connection?
     *
     * Matched on the exception's class name so this stays a pure JVM function:
     * `com.google.firebase.storage.StorageException` cannot be constructed in a
     * unit test, and the decision only needs the name and the message.
     */
    fun isStorageRefusal(e: Throwable): Boolean {
        val cls = e::class.java.name
        if (cls.endsWith("StorageException")) return true
        val msg = e.message.orEmpty()
        return msg.contains("permission", ignoreCase = true) ||
            msg.contains("403") ||
            msg.contains("quota", ignoreCase = true) ||
            msg.contains("too large", ignoreCase = true)
    }

    /**
     * The sentence for a failed upload. Every failure gets the same actionable
     * advice; a connection failure additionally says it may simply be retried.
     */
    fun messageFor(e: Throwable): String =
        if (isStorageRefusal(e)) UPLOAD_FAILED_MESSAGE
        else "$UPLOAD_FAILED_MESSAGE You can also add it later from Edit profile."

    /**
     * Should the save proceed without the photo?
     *
     * Always true: a refused avatar is never a reason to refuse the account.
     * Kept as a function so the policy has a name and a test, and so a caller
     * that one day needs to make an exception has one place to put it.
     */
    fun saveWithoutPhoto(@Suppress("UNUSED_PARAMETER") e: Throwable): Boolean = true

    /**
     * The bytes to upload, or null when the compressed image is still over the
     * cap — which cannot happen for a 1080-px q72 JPEG, but a caller that
     * skips compression must not learn about the cap from a 403.
     */
    fun acceptableSize(byteCount: Long): Boolean = byteCount in 1..MAX_UPLOAD_BYTES
}
