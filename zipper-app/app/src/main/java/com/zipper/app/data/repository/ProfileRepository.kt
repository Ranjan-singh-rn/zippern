package com.zipper.app.data.repository

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.storage.FirebaseStorage
import com.zipper.app.data.model.BeanTransaction
import com.zipper.app.data.model.DiamondTransaction
import com.zipper.app.data.model.LikeEntry
import com.zipper.app.data.model.PublicProfile
import com.zipper.app.data.model.User
import com.zipper.app.util.MediaUtils
import com.zipper.app.util.UserLanguage
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton
import com.zipper.app.util.millis

sealed class ProfileResult {
    object Success : ProfileResult()
    data class Error(val message: String) : ProfileResult()
}

/**
 * The outcome of a daily claim, carrying what the server actually granted.
 *
 * Deliberately not [ProfileResult]. A bare Success threw away the `day`,
 * `diamonds` and `videoCards` the callable returns, so the screen recomputed the
 * day from a hardcoded 7 and looked the amount up in the app's own table — and
 * told the user a number the server had not paid the moment the CRM changed the
 * schedule. The server decides all three; this hands all three back.
 */
sealed class DailyClaimResult {
    data class Claimed(val day: Int, val diamonds: Long, val videoCards: Int) : DailyClaimResult()
    data class Error(val message: String) : DailyClaimResult()
}

// Limits enforced at pick time (before any upload starts)
const val MAX_VIDEO_DURATION_MS  = 60_000L        // 60 seconds
const val MAX_VIDEO_SIZE_BYTES   = 80L * 1024 * 1024   // 80 MB — covers most 60s 1080p clips
const val MAX_IMAGE_SIZE_BYTES   = 20L * 1024 * 1024   // 20 MB — raw HEIC/RAW from cameras

/*
 * QA #14: what storage.rules accepts under profileMedia/ — images 15 MB, videos 50 MB. The pick-time limits above are
 * higher on purpose (a 20 MB camera photo compresses to well under 1 MB), but when compression FAILS the original is
 * sent as it is, and Storage refused anything over these with an error that read like a permissions fault. Checked
 * before that raw upload instead, with a sentence a person can act on.
 */
const val STORAGE_IMAGE_MAX_BYTES = 15L * 1024 * 1024
const val STORAGE_VIDEO_MAX_BYTES = 50L * 1024 * 1024

/** Why an UNcompressed file cannot be uploaded, or null when it fits ([sizeBytes] < 0 = unknown: let Storage decide). */
fun rawUploadProblem(sizeBytes: Long, isVideo: Boolean): String? {
    if (sizeBytes < 0) return null
    val cap = if (isVideo) STORAGE_VIDEO_MAX_BYTES else STORAGE_IMAGE_MAX_BYTES
    if (sizeBytes <= cap) return null
    val mb = (sizeBytes + 1024 * 1024 - 1) / (1024 * 1024)
    return if (isVideo) "This video ($mb MB) could not be made smaller on this phone, and videos must be under 50 MB. Trim it and try again."
    else "This photo ($mb MB) could not be made smaller on this phone, and photos must be under 15 MB. Choose a smaller one."
}

/** Storage rules check contentType; putBytes without metadata uploads as octet-stream and is refused. */
private val JPEG_META = com.google.firebase.storage.StorageMetadata.Builder().setContentType("image/jpeg").build()
private val MP4_META  = com.google.firebase.storage.StorageMetadata.Builder().setContentType("video/mp4").build()

/*
 * `@Singleton` belongs HERE, on the class.
 *
 * It used to sit above `JPEG_META`, twelve lines up — an annotation applies to
 * the next declaration, and the next declaration was a private top-level val,
 * not this class. It compiled, it looked right in a diff, and Hilt built a fresh
 * ProfileRepository for every injection point: MainActivity's long-lived
 * ProfileViewModel, every screen's ViewModel, each with its own instance and its
 * own `currentUserFlow` auth-state listener on the same document. Not fatal, but
 * it is several times the listener traffic the code reads as asking for, and the
 * one thing the annotation was there to prevent.
 */
@Singleton
class ProfileRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
    private val money: MoneyFunctions,
    private val hostFunctions: HostFunctions,
) {
    private val uid get() = auth.currentUser?.uid

    // ── Real-time stream of the current user's doc ────────────────────────────
    //
    // Uses FirebaseAuth.AuthStateListener so the flow stays alive across auth changes.
    // This is critical for MainActivity's ProfileViewModel which is created once at
    // startup — possibly before the user has logged in — and must react when they do.

    fun currentUserFlow(): Flow<User?> = callbackFlow {
        var firestoreListener: com.google.firebase.firestore.ListenerRegistration? = null

        val authStateListener = com.google.firebase.auth.FirebaseAuth.AuthStateListener { firebaseAuth ->
            // Cancel previous Firestore listener whenever auth state changes.
            firestoreListener?.remove()
            firestoreListener = null
            val id = firebaseAuth.currentUser?.uid
            if (id != null) {
                firestoreListener = firestore.collection("users").document(id)
                    .addSnapshotListener { snap, _ ->
                        trySend(snap?.let { User.from(it) })
                    }
            } else {
                trySend(null)
            }
        }

        auth.addAuthStateListener(authStateListener)
        awaitClose {
            firestoreListener?.remove()
            auth.removeAuthStateListener(authStateListener)
        }
    }

    /**
     * The signed-in account's uid as Firebase Auth holds it on this device, following sign-in, sign-out and an
     * account switch — no Firestore read, so it cannot fail.
     *
     * A3 (3 Nov 2026): ProfileViewModel used to get this uid from [fetchCurrentUser], a one-shot `get()` of the
     * users document, in five coroutines started from `init` with nothing catching. With the client offline —
     * no network, or a session whose refresh token the server no longer accepts, so Firestore's watch stream is
     * refused — and no cached copy, that `get()` throws "Failed to get document because the client is offline"
     * and the app crashed seconds after launch (prod APK, emulator drop box, 2026-11-03 17:33:40 IST). The
     * listeners below only ever needed the uid.
     */
    fun signedInUidFlow(): Flow<String?> = callbackFlow {
        val listener = FirebaseAuth.AuthStateListener { trySend(it.currentUser?.uid) }
        auth.addAuthStateListener(listener)
        awaitClose { auth.removeAuthStateListener(listener) }
    }.distinctUntilChanged()

    // ── One-shot fetch — own ──────────────────────────────────────────────────

    /** Throws when the document cannot be read (offline with no cached copy, refused) — callers catch. */
    suspend fun fetchCurrentUser(): User? {
        val id = uid ?: return null
        return firestore.collection("users").document(id).get().await().let { User.from(it) }
    }

    // ── One-shot fetch — other user ───────────────────────────────────────────

    /**
     * Another person's profile, as the public projection.
     *
     * Was `users/{targetUid}` deserialised into `User` — phone number, email,
     * date of birth, device id, FCM token, diamond and bean balances included,
     * for anyone whose profile you opened.
     */
    suspend fun fetchUser(targetUid: String): PublicProfile? = try {
        val snap = firestore.collection("publicProfiles").document(targetUid).get().await()
        if (snap.exists()) PublicProfile.from(snap) else null
    } catch (_: Exception) { null }

    // ── Edit profile ──────────────────────────────────────────────────────────

    suspend fun updateProfile(
        name: String,
        bio: String,
        city: String,
        age: Int = 0,
        dob: Long = 0L,
        languages: List<UserLanguage>,
        hobbies: List<String> = emptyList(),
        likes: List<String> = emptyList(),
        /**
         * Null means "do not touch". Sent to `setCallRate`, not written here —
         * only a verified host may set one, and the server clamps it to the
         * ceiling their level allows.
         */
        callRate: Int? = null,
        photoUri: Uri? = null,
        coverUri: Uri? = null,
        keptMediaUrls: List<String> = emptyList(),
        keptMediaThumbs: List<String> = emptyList(),
        newMediaUris: List<Uri> = emptyList(),
        deletedMediaUrls: List<String> = emptyList(),
        deletedThumbUrls: List<String> = emptyList(),
    ): ProfileResult {
        val id = uid ?: return ProfileResult.Error("Not logged in")
        return try {
            // ── Profile photo (compressed) ────────────────────────────────────
            var photoUrl: String? = null
            var coverUrl: String? = null

            if (photoUri != null) {
                val bytes = MediaUtils.compressImage(context, photoUri)
                val ref = storage.reference.child("profileMedia/$id/avatar.jpg")
                if (bytes != null) ref.putBytes(bytes, JPEG_META).await()
                else {                                                  // fallback if compress fails
                    rawUploadProblem(getFileSizeBytes(photoUri), isVideo = false)?.let { throw IllegalStateException(it) }
                    ref.putFile(photoUri, JPEG_META).await()
                }
                photoUrl = ref.downloadUrl.await().toString()
            }
            if (coverUri != null) {
                val bytes = MediaUtils.compressImage(context, coverUri)
                val ref = storage.reference.child("profileMedia/$id/cover.jpg")
                if (bytes != null) ref.putBytes(bytes, JPEG_META).await()
                else {
                    rawUploadProblem(getFileSizeBytes(coverUri), isVideo = false)?.let { throw IllegalStateException(it) }
                    ref.putFile(coverUri, JPEG_META).await()
                }
                coverUrl = ref.downloadUrl.await().toString()
            }

            // ── Gallery: upload all new items in parallel ─────────────────────
            //
            // Images → compress to JPEG 72% / 1080px, then putBytes
            // Videos → transcode to 720p H.264 via Media3 Transformer (smaller file,
            //          faster upload), then putFile the compressed temp file.
            //          Also extract a first-frame JPEG thumbnail and upload separately.
            //
            data class MediaUploadResult(val mediaUrl: String, val thumbUrl: String)

            val uploadResults: List<MediaUploadResult> = coroutineScope {
                newMediaUris.mapIndexed { idx, uri ->
                    async {
                        val isVideo = isVideoUri(uri)
                        val ts = System.currentTimeMillis()
                        val ext = if (isVideo) "mp4" else "jpg"

                        val mediaRef = storage.reference.child("profileMedia/$id/gallery_${ts}_$idx.$ext")

                        if (isVideo) {
                            // Compress to 720p — returns a temp Uri in cache dir, or null on failure
                            val compressedUri = MediaUtils.compressVideo(
                                context     = context,
                                uri         = uri,
                                outputName  = "zipper_${ts}_$idx",
                            )
                            val uploadUri = compressedUri ?: uri  // fallback to original if compress fails
                            if (compressedUri == null) {
                                rawUploadProblem(getFileSizeBytes(uri), isVideo = true)?.let { throw IllegalStateException(it) }
                            }
                            mediaRef.putFile(uploadUri, if (isVideo) MP4_META else JPEG_META).await()
                            // Clean up temp file immediately after upload
                            compressedUri?.path?.let { java.io.File(it).delete() }
                        } else {
                            val bytes = MediaUtils.compressImage(context, uri)
                            if (bytes != null) mediaRef.putBytes(bytes, JPEG_META).await()
                            else {
                                rawUploadProblem(getFileSizeBytes(uri), isVideo = false)?.let { throw IllegalStateException(it) }
                                mediaRef.putFile(uri, if (isVideo) MP4_META else JPEG_META).await()
                            }
                        }

                        val mediaUrl = mediaRef.downloadUrl.await().toString()

                        // Upload video thumbnail (first frame JPEG)
                        val thumbUrl = if (isVideo) {
                            val thumbBytes = MediaUtils.extractVideoThumbnail(context, uri)
                            if (thumbBytes != null) {
                                val thumbRef = storage.reference.child("profileMedia/$id/gallery_${ts}_${idx}_thumb.jpg")
                                thumbRef.putBytes(thumbBytes, JPEG_META).await()
                                thumbRef.downloadUrl.await().toString()
                            } else ""
                        } else ""

                        MediaUploadResult(mediaUrl, thumbUrl)
                    }
                }.awaitAll()
            }

            val newMediaUrls  = uploadResults.map { it.mediaUrl }.filter { it.isNotBlank() }
            val newMediaThumbs = uploadResults.map { it.thumbUrl }

            val finalMediaUrls  = keptMediaUrls  + newMediaUrls
            val finalMediaThumbs = keptMediaThumbs + newMediaThumbs

            // ── The call rate goes through the server ──────────────────────────
            //
            // It used to be one more key in the map below. It is not one more
            // profile field: the ceiling on it comes from the host's rung on the
            // level ladder, `firestore.rules` cannot read the ladder, and the
            // single platform-wide 700 it enforced instead held every host above
            // level 0 below the rate they had earned. `setCallRate` reads the
            // ladder and clamps to the host's own rung, and the rules now refuse
            // the field outright — so this is the only route.
            //
            // Before the document write on purpose. This is the one part of a
            // save the server can refuse, and refusing it after the rest had
            // landed would report a failed save that had in fact half happened.
            if (callRate != null) {
                when (val res = hostFunctions.setCallRate(callRate)) {
                    is HostFunctions.Result.Failed -> return ProfileResult.Error(res.userMessage)
                    is HostFunctions.Result.Ok     -> Unit  // clamped or not, it is set
                }
            }

            // ── Firestore update ───────────────────────────────────────────────
            val updates = mutableMapOf<String, Any>(
                "name"          to name.trim(),
                "bio"           to bio.trim(),
                "city"          to city.trim(),
                "age"           to age,
                "dob"           to dob,
                "languages"     to languages.map { mapOf("id" to it.id, "code" to it.code, "name" to it.name) },
                "hobbies"       to hobbies,
                "likes"         to likes,
                "mediaUrls"     to finalMediaUrls,
                "mediaThumbs"   to finalMediaThumbs,
            )
            // `callRateBeans` is deliberately absent — it went through
            // setCallRate above. Including it here now fails the whole save for
            // everyone, host or not: the field is on the rules' owner denylist.
            if (photoUrl != null) updates["photoUrl"]      = photoUrl
            if (coverUrl != null) updates["coverPhotoUrl"] = coverUrl

            firestore.collection("users").document(id).update(updates).await()

            // ── Delete removed files from Storage (best-effort, non-blocking) ──
            // Firestore is already updated, so these are safe to delete even if one fails.
            (deletedMediaUrls + deletedThumbUrls).forEach { url ->
                try { storage.getReferenceFromUrl(url).delete().await() } catch (_: Exception) {}
            }

            ProfileResult.Success
        } catch (e: Exception) {
            ProfileResult.Error(e.message ?: "Update failed")
        }
    }

    // ── Like / Unlike ─────────────────────────────────────────────────────────
    // liked/{targetUid}   — my record of who I liked (stores target's info for display)
    // likedBy/{myUid}     — stored on TARGET's profile so they can see who liked them

    /**
     * Like or unlike another profile.
     *
     * Both used to be a client batch that wrote `totalLikesReceived` onto the
     * *other* person's user document. That needed a rule permitting any
     * signed-in account to change that field on any other account — and such a
     * rule cannot tell "Priya liked Anil" from "Anil gave himself 40,000
     * likes", because they are the same write.
     *
     * Likes are not money, but they drive the Hot tab and the recommendation
     * order, which decide who earns. A forgeable like count is a forgeable
     * ranking. `toggleLike` also reads the edge document first, so a double tap
     * counts once — the old version incremented unconditionally.
     */
    suspend fun likeUser(target: User): ProfileResult = setLike(target.uid, true)

    suspend fun unlikeUser(targetUid: String): ProfileResult = setLike(targetUid, false)

    /** Same call, from the in-call like button, where only a uid is to hand. */
    suspend fun setLikeFromCall(targetUid: String, like: Boolean): ProfileResult =
        setLike(targetUid, like)

    private suspend fun setLike(targetUid: String, like: Boolean): ProfileResult =
        when (val res = hostFunctions.toggleLike(targetUid, like)) {
            is HostFunctions.Result.Ok -> ProfileResult.Success
            is HostFunctions.Result.Failed -> ProfileResult.Error(res.userMessage)
        }

    /** Is [targetUid] in my `liked` list? One-shot, for the profile button. */
    suspend fun isUserLiked(targetUid: String): Boolean {
        val id = uid ?: return false
        return try {
            firestore.collection("users").document(id)
                .collection("liked").document(targetUid)
                .get().await().exists()
        } catch (_: Exception) { false }
    }

    /** Profiles I have liked, newest first. */
    fun iLikeFlow(): Flow<List<LikeEntry>> = likeEdgeFlow("liked")

    /** Profiles that have liked me, newest first. */
    fun likedByFlow(): Flow<List<LikeEntry>> = likeEdgeFlow("likedBy")

    private fun likeEdgeFlow(collection: String): Flow<List<LikeEntry>> = callbackFlow {
        val id = uid
        if (id == null) { trySend(emptyList()); awaitClose { }; return@callbackFlow }
        val reg = firestore.collection("users").document(id)
            .collection(collection)
            .addSnapshotListener { snap, _ ->
                val entries = snap?.documents.orEmpty().mapNotNull { doc ->
                    LikeEntry(
                        uid      = doc.getString("uid") ?: doc.id,
                        name     = doc.getString("name") ?: "",
                        photoUrl = doc.getString("photoUrl") ?: "",
                        level    = (doc.getLong("level") ?: 0L).toInt(),
                        isOnline = doc.getBoolean("isOnline") ?: false,
                        gender   = doc.getString("gender") ?: "",
                        city     = doc.getString("city") ?: "",
                        // toggleLike writes serverTimestamp; the old client
                        // wrote millis. Read both so existing rows still sort.
                        likedAt  = doc.millis("likedAt"),
                    )
                }.sortedByDescending { it.likedAt }
                trySend(entries)
            }
        awaitClose { reg.remove() }
    }

    suspend fun claimDailyReward(): DailyClaimResult =
        when (val res = money.claimDailyReward()) {
            is MoneyFunctions.Result.Ok -> DailyClaimResult.Claimed(
                day        = res.value.day,
                diamonds   = res.value.diamonds,
                videoCards = res.value.videoCards,
            )
            is MoneyFunctions.Result.Failed -> DailyClaimResult.Error(res.userMessage)
        }

    // ── Wallet transaction flows ──────────────────────────────────────────────

    /** Real-time stream of diamond transactions for [uid], newest first. */
    fun diamondTransactionsFlow(uid: String): Flow<List<DiamondTransaction>> = callbackFlow {
        val listener = firestore.collection("users").document(uid)
            .collection("diamondTransactions")
            // No orderBy — sort client-side to avoid needing a Firestore index
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) { trySend(emptyList()); return@addSnapshotListener }
                val list = snap.documents.mapNotNull { doc ->
                    DiamondTransaction(
                        id              = doc.id,
                        type            = doc.getString("type")            ?: "credit",
                        amount          = doc.getLong("amount")            ?: 0L,
                        reason          = doc.getString("reason")          ?: "",
                        reasonLabel     = doc.getString("reasonLabel")     ?: "",
                        timestamp       = doc.millis("timestamp"),
                        relatedUserName = doc.getString("relatedUserName") ?: "",
                    )
                }.sortedByDescending { it.timestamp }
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    /** Real-time stream of bean transactions for [uid], newest first. */
    fun beanTransactionsFlow(uid: String): Flow<List<BeanTransaction>> = callbackFlow {
        val listener = firestore.collection("users").document(uid)
            .collection("beanTransactions")
            // No orderBy — sort client-side to avoid needing a Firestore index
            .addSnapshotListener { snap, err ->
                if (err != null || snap == null) { trySend(emptyList()); return@addSnapshotListener }
                val list = snap.documents.mapNotNull { doc ->
                    BeanTransaction(
                        id              = doc.id,
                        type            = doc.getString("type")            ?: "credit",
                        amount          = doc.getLong("amount")            ?: 0L,
                        reason          = doc.getString("reason")          ?: "",
                        reasonLabel     = doc.getString("reasonLabel")     ?: "",
                        timestamp       = doc.millis("timestamp"),
                        relatedUserName = doc.getString("relatedUserName") ?: "",
                    )
                }.sortedByDescending { it.timestamp }
                trySend(list)
            }
        awaitClose { listener.remove() }
    }

    // ── Theme / Language preferences ─────────────────────────────────────────

    /** Persists the user's theme choice ("light" | "dark" | "system") to Firestore. */
    suspend fun saveTheme(theme: String): ProfileResult {
        val id = uid ?: return ProfileResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(id).update("theme", theme).await()
            ProfileResult.Success
        } catch (e: Exception) { ProfileResult.Error(e.message ?: "Save failed") }
    }

    /** Persists the user's language preference (ISO 639-1 code, e.g. "en", "hi") to Firestore. */
    suspend fun saveLanguage(language: String): ProfileResult {
        val id = uid ?: return ProfileResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(id).update("appLanguage", language).await()
            ProfileResult.Success
        } catch (e: Exception) { ProfileResult.Error(e.message ?: "Save failed") }
    }

    // ── Follow counts ─────────────────────────────────────────────────────────

    suspend fun getFollowerCount(targetUid: String): Int = try {
        firestore.collection("users").document(targetUid).collection("followers").get().await().size()
    } catch (_: Exception) { 0 }

    suspend fun getFollowingCount(targetUid: String): Int = try {
        firestore.collection("users").document(targetUid).collection("following").get().await().size()
    } catch (_: Exception) { 0 }

    // ── Follow / Unfollow ─────────────────────────────────────────────────────
    //
    // A follow is two documents, written together:
    //   users/{target}/followers/{me}     — so the target can count followers
    //   users/{me}/following/{target}     — so I can list who I follow
    //
    // Both are needed because Firestore cannot count across a collection group
    // cheaply, and both sides are read on different screens. `firestore.rules`
    // permits the cross-user write to /followers by design (line 590).
    //
    // WatchLiveViewModel has called these since July; they were never written,
    // which is one of the five errors that stopped this module compiling.

    /** True if the signed-in user already follows [targetUid]. */
    suspend fun isFollowing(targetUid: String): Boolean {
        val me = auth.currentUser?.uid ?: return false
        if (me == targetUid) return false
        return try {
            firestore.collection("users").document(targetUid)
                .collection("followers").document(me)
                .get().await().exists()
        } catch (_: Exception) { false }
    }

    /**
     * Follow [targetUid]. Idempotent — following twice is a no-op, not a
     * doubled count, because both writes are keyed by uid rather than appended.
     */
    suspend fun followUser(targetUid: String) {
        val me = auth.currentUser?.uid ?: throw IllegalStateException("Not signed in")
        if (me == targetUid) throw IllegalArgumentException("Cannot follow yourself")
        val now = com.google.firebase.firestore.FieldValue.serverTimestamp()
        val batch = firestore.batch()
        batch.set(
            firestore.collection("users").document(targetUid).collection("followers").document(me),
            mapOf("uid" to me, "followedAt" to now),
        )
        batch.set(
            firestore.collection("users").document(me).collection("following").document(targetUid),
            mapOf("uid" to targetUid, "followedAt" to now),
        )
        batch.commit().await()
    }

    /** Unfollow [targetUid]. Idempotent — removing a follow that isn't there succeeds. */
    suspend fun unfollowUser(targetUid: String) {
        val me = auth.currentUser?.uid ?: throw IllegalStateException("Not signed in")
        val batch = firestore.batch()
        batch.delete(
            firestore.collection("users").document(targetUid).collection("followers").document(me),
        )
        batch.delete(
            firestore.collection("users").document(me).collection("following").document(targetUid),
        )
        batch.commit().await()
    }

    // ── Block / Unblock ───────────────────────────────────────────────────────
    // Subcollection: users/{myUid}/blocked/{targetUid}
    // Document fields: uid, name, photoUrl, blockedAt

    suspend fun blockUser(
        targetUid: String,
        targetName: String = "",
        targetPhotoUrl: String = "",
    ): ProfileResult {
        val id = uid ?: return ProfileResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(id)
                .collection("blocked").document(targetUid)
                .set(mapOf(
                    "uid"        to targetUid,
                    "name"       to targetName,
                    "photoUrl"   to targetPhotoUrl,
                    "blockedAt"  to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                )).await()
            ProfileResult.Success
        } catch (e: Exception) { ProfileResult.Error(e.message ?: "Block failed") }
    }

    suspend fun unblockUser(targetUid: String): ProfileResult {
        val id = uid ?: return ProfileResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(id)
                .collection("blocked").document(targetUid)
                .delete().await()
            ProfileResult.Success
        } catch (e: Exception) { ProfileResult.Error(e.message ?: "Unblock failed") }
    }

    /** Real-time stream of blocked user UIDs (used by HomeViewModel to filter the grid). */
    fun blockedUidsFlow(): Flow<Set<String>> = callbackFlow {
        val id = uid
        if (id == null) { trySend(emptySet()); close(); return@callbackFlow }
        val listener = firestore.collection("users").document(id)
            .collection("blocked")
            .addSnapshotListener { snap, _ ->
                trySend(snap?.documents?.map { it.id }?.toSet() ?: emptySet())
            }
        awaitClose { listener.remove() }
    }

    /** Real-time stream: is a specific user blocked by the current user? */
    fun isBlockedFlow(targetUid: String): Flow<Boolean> = callbackFlow {
        val id = uid
        if (id == null) { trySend(false); close(); return@callbackFlow }
        val listener = firestore.collection("users").document(id)
            .collection("blocked").document(targetUid)
            .addSnapshotListener { snap, _ -> trySend(snap?.exists() == true) }
        awaitClose { listener.remove() }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Returns true if the Uri's MIME type starts with "video/". */
    fun isVideoUri(uri: Uri): Boolean {
        val mime = context.contentResolver.getType(uri) ?: return false
        return mime.startsWith("video/")
    }

    /**
     * Returns the file size of [uri] in bytes, or -1 if unknown.
     * Uses the content resolver's COLUMN_SIZE where available (avoids opening the stream).
     */
    fun getFileSizeBytes(uri: Uri): Long {
        return try {
            context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                        if (idx >= 0) cursor.getLong(idx) else -1L
                    } else -1L
                } ?: -1L
        } catch (_: Exception) { -1L }
    }

    /**
     * Returns the duration of the video at [uri] in milliseconds.
     * Returns 0 if not a video or retrieval fails.
     */
    fun getVideoDurationMs(uri: Uri): Long = try {
        val r = MediaMetadataRetriever()
        r.setDataSource(context, uri)
        val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        r.release()
        ms
    } catch (_: Exception) { 0L }
}
