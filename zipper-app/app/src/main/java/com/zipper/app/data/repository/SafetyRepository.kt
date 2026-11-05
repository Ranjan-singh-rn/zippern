package com.zipper.app.data.repository

import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageMetadata
import com.zipper.app.util.SessionManager
import kotlinx.coroutines.tasks.await
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * O13 (Owner, 5 Nov 2026) — the broadcaster's half of the live wall. A still of what this phone publishes goes to
 * `liveSnapshots/{uid}/{roomId}/{time}.jpg` (storage.rules: the broadcaster writes their own, at most 1 MB; staff read)
 * and the server is told (`reportLiveSnapshot`), which keeps it as the room's newest, deletes the one before and —
 * only when the Owner has turned the AI check on — reads it with SafeSearch.
 */
@Singleton
class SafetyRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val storage: FirebaseStorage,
    private val functions: FirebaseFunctions,
    private val sessionManager: SessionManager,
) {
    /** What the server answered: seconds to the next still, and whether an automatic end closed the room. */
    data class StillAnswer(val nextSeconds: Long, val ended: Boolean)

    suspend fun reportStill(roomId: String, file: File): StillAnswer? {
        val uid = auth.currentUser?.uid ?: return null
        if (!file.exists() || file.length() == 0L || file.length() > MAX_STILL_BYTES) return null
        val path = stillPath(uid, roomId, System.currentTimeMillis())
        storage.reference.child(path)
            .putFile(Uri.fromFile(file), StorageMetadata.Builder().setContentType("image/jpeg").build())
            .await()
        val res = functions.getHttpsCallable("reportLiveSnapshot")
            .call(sessionManager.withSession(mapOf("roomId" to roomId, "path" to path)))
            .await()
        val map = res.data as? Map<*, *> ?: return null
        return StillAnswer(
            nextSeconds = ((map["next"] as? Number)?.toLong() ?: DEFAULT_EVERY_SECONDS).coerceIn(30L, 600L),
            ended = map["ended"] == true,
        )
    }

    companion object {
        const val DEFAULT_EVERY_SECONDS = 60L
        /** The first still, once the camera has settled. */
        const val FIRST_STILL_AFTER_MS = 10_000L
        /** storage.rules refuses a still over 1 MB. */
        const val MAX_STILL_BYTES = 1_000_000L
        fun stillPath(uid: String, roomId: String, atMs: Long) = "liveSnapshots/$uid/$roomId/$atMs.jpg"
    }
}
