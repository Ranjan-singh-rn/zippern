package com.zipper.datingapp.service

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.live.LiveSessionCleanupPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Lightweight sticky service so [onTaskRemoved] runs when the user swipes the app from Recents.
 * [android.app.Activity] has no public task-removed callback; [Service.onTaskRemoved] does.
 *
 * Firestore cleanup (no in-memory ViewModel — process may be dying).
 */
class LiveTaskCleanupService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        LiveBroadcastCleanup.runAll(applicationContext)
    }
}

private object LiveBroadcastCleanup {
    private const val TAG = "LiveBroadcastCleanup"
    private val firebaseService = FirebaseService()

    fun runAll(appContext: android.content.Context) {
        endGhostViewerIfNeeded(appContext)
        endGhostSoloLiveIfNeeded(appContext)
    }

    /** Viewer +1 without [stopWatching] (kill / swipe). */
    private fun endGhostViewerIfNeeded(ctx: android.content.Context) {
        val streamId = LiveSessionCleanupPrefs.consumePendingViewerDecrement(ctx) ?: return
        GlobalScope.launch(Dispatchers.IO + NonCancellable) {
            runCatching { firebaseService.incrementLiveStreamViewers(streamId, -1) }
                .onFailure { e -> Log.w(TAG, "ghost viewer -1 stream=$streamId", e) }
        }
    }

    private fun endGhostSoloLiveIfNeeded(ctx: android.content.Context) {
        val uid = FirebaseAuth.getInstance().currentUser?.uid?.trim().orEmpty().ifEmpty { return }
        GlobalScope.launch(Dispatchers.IO + NonCancellable) {
            runCatching {
                val doc = FirebaseFirestore.getInstance()
                    .collection("users")
                    .document(uid)
                    .get()
                    .await()
                var shouldTeardown = false
                var streamDoc = uid
                if (doc.exists()) {
                    val user = doc.toObject(UserProfile::class.java)
                    if (user?.isLive == true) {
                        shouldTeardown = true
                        streamDoc = user.liveRoomId?.trim()?.takeIf { it.isNotEmpty() } ?: uid
                    }
                }
                if (!shouldTeardown) {
                    val peek = LiveSessionCleanupPrefs.peekHostingLiveUid(ctx)
                    if (peek == uid) {
                        shouldTeardown = true
                        streamDoc = uid
                        LiveSessionCleanupPrefs.consumeHostingLiveUid(ctx)
                    }
                }
                if (!shouldTeardown) return@launch

                val updated = doc.toObject(UserProfile::class.java)?.copy(isLive = false, liveRoomId = null)
                runCatching { firebaseService.updateUserLiveStatus(uid, false, null) }
                if (updated != null) {
                    runCatching { firebaseService.saveUserProfile(updated) }
                }
                runCatching { firebaseService.endLiveStream(uid, streamDoc) }
                    .onFailure { e ->
                        Log.w(TAG, "endLiveStream onTaskRemoved", e)
                        runCatching { firebaseService.clearLiveStreamPkBannerIfDocumentExists(uid) }
                    }
            }.onFailure { e ->
                Log.w(TAG, "endGhostSoloLiveIfNeeded", e)
            }
        }
    }
}
