package com.zipper.app.service

import android.Manifest
import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.zipper.app.MainActivity
import com.zipper.app.R
import kotlinx.coroutines.tasks.await

/*
 * Push plumbing shared by the messaging service and the activity.
 *
 *   Channels   — calls (ringtone, full-screen), messages, live.
 *   AppState   — is the app in the foreground, and which chat is open, so a
 *                message notification is not posted over the very chat the
 *                user is reading.
 *   Deep links — extras on the MainActivity intent that the nav graph
 *                consumes once the user is signed in.
 *   Token sync — FCM tokens are only useful once they are on the user doc.
 *                `onNewToken` fires before login on a fresh install, so the
 *                token is re-read and saved every time Main is reached.
 *                One document per DEVICE under `users/{uid}/fcmTokens/{token}`;
 *                the old single `users/{uid}.fcmToken` string meant a second
 *                phone silently unregistered the first.
 */
object PushNotifications {
    private const val TAG = "Push"

    /** Brand pink — the accent Android tints the small icon and app name with. */
    private const val BRAND_COLOR = "#FF3D8B"

    const val CHANNEL_CALLS = "zipper_calls"
    const val CHANNEL_MESSAGES = "zipper_messages"
    const val CHANNEL_LIVE = "zipper_live"

    const val EXTRA_CALL_ID = "zipper.callId"
    const val EXTRA_CALL_ACTION = "zipper.callAction"   // "open" | "decline"
    const val EXTRA_CHAT_UID = "zipper.chatUid"
    const val EXTRA_LIVE_ROOM_ID = "zipper.liveRoomId"

    const val CALL_NOTIFICATION_ID = 1001
    private const val LIVE_NOTIFICATION_ID = 3001

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val audio = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Rings when someone video-calls you"
                setSound(ringtone, audio)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 600, 800, 600, 800)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                setBypassDnd(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New chat messages"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_LIVE, "Live", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When someone you follow goes live"
            }
        )
    }

    private fun canPost(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * `requestCode` must be STABLE for a given target, and derived from the id the
     * notification points at. It used to be `extras.hashCode()` — Bundle does not
     * override hashCode, so that was the identity hash: a different number on
     * every call, which meant FLAG_UPDATE_CURRENT never found a PendingIntent to
     * update and every notification leaked a fresh one carrying stale extras.
     */
    private fun activityIntent(ctx: Context, requestCode: Int, extras: Bundle): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtras(extras)
        }
        return PendingIntent.getActivity(
            ctx, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // ── Calls ──────────────────────────────────────────────────────────────

    fun showIncomingCall(ctx: Context, callId: String, callerName: String) {
        if (!canPost(ctx)) return
        val open = activityIntent(
            ctx, callId.hashCode(),
            Bundle().apply { putString(EXTRA_CALL_ID, callId); putString(EXTRA_CALL_ACTION, "open") },
        )
        val decline = activityIntent(
            ctx, callId.hashCode() xor 0x7FFF,
            Bundle().apply { putString(EXTRA_CALL_ID, callId); putString(EXTRA_CALL_ACTION, "decline") },
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_video_call)
            .setColor(android.graphics.Color.parseColor(BRAND_COLOR))
            .setContentTitle(callerName)
            .setContentText("Incoming video call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(45_000)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .setVibrate(longArrayOf(0, 800, 600, 800, 600, 800))
            .setFullScreenIntent(open, true)
            .setContentIntent(open)
            .addAction(0, "Decline", decline)
            .addAction(0, "Answer", open)
            .build()
        NotificationManagerCompat.from(ctx).notify(CALL_NOTIFICATION_ID, n)
    }

    fun cancelIncomingCall(ctx: Context) {
        NotificationManagerCompat.from(ctx).cancel(CALL_NOTIFICATION_ID)
    }

    // ── Messages ───────────────────────────────────────────────────────────

    fun showMessage(ctx: Context, senderUid: String, senderName: String, preview: String) {
        if (!canPost(ctx)) return
        val open = activityIntent(ctx, senderUid.hashCode(), Bundle().apply { putString(EXTRA_CHAT_UID, senderUid) })
        val n = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_video_call)
            .setColor(android.graphics.Color.parseColor(BRAND_COLOR))
            .setContentTitle(senderName)
            .setContentText(preview)
            .setStyle(NotificationCompat.BigTextStyle().bigText(preview))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        // One notification per sender, replaced as new messages arrive.
        NotificationManagerCompat.from(ctx).notify(2000 + (senderUid.hashCode() and 0xffff), n)
    }

    // ── Live ───────────────────────────────────────────────────────────────

    fun showLiveStarted(ctx: Context, roomId: String, hostName: String, title: String) {
        if (!canPost(ctx)) return
        val open = activityIntent(ctx, roomId.hashCode(), Bundle().apply { putString(EXTRA_LIVE_ROOM_ID, roomId) })
        val n = NotificationCompat.Builder(ctx, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_video_call)
            .setColor(android.graphics.Color.parseColor(BRAND_COLOR))
            .setContentTitle("$hostName is live")
            .setContentText(title.ifBlank { "Tap to join the room" })
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        NotificationManagerCompat.from(ctx).notify(LIVE_NOTIFICATION_ID, n)
    }

    // ── Token ──────────────────────────────────────────────────────────────
    //
    // ONE DOCUMENT PER DEVICE: `users/{uid}/fcmTokens/{token}`, id = the token.
    // The old shape was a single `fcmToken` string on the user document, so
    // signing in on a second phone overwrote the first phone's token — the first
    // phone stopped ringing and nothing said so — and signing out of one killed
    // push on both.
    //
    // The legacy field is still written and still cleared, because a deployed
    // function may still be reading it. The subcollection is the source of truth.

    /** Path of this device's token document. */
    private fun tokenDoc(uid: String, token: String) =
        FirebaseFirestore.getInstance().collection("users").document(uid)
            .collection("fcmTokens").document(token)

    /**
     * Write one device's token.
     *
     * `set(merge)`, never `update()`: on a fresh install `onNewToken` can fire
     * before the user document (and therefore the subcollection) exists, and
     * `update()` fails with NOT_FOUND against a document that is not there.
     */
    fun saveToken(uid: String, token: String) {
        if (token.isBlank()) return
        tokenDoc(uid, token)
            .set(
                mapOf(
                    "token" to token,
                    "platform" to "android",
                    "updatedAt" to FieldValue.serverTimestamp(),
                ),
                SetOptions.merge(),
            )
            .addOnFailureListener { Log.w(TAG, "could not save the device token", it) }
        // Legacy single-token field — kept in step until the migration is done.
        FirebaseFirestore.getInstance().collection("users").document(uid)
            .set(mapOf("fcmToken" to token), SetOptions.merge())
            .addOnFailureListener { Log.w(TAG, "could not save the legacy fcmToken field", it) }
    }

    /** Read the current FCM token and put it on the signed-in user's doc. */
    fun syncToken() {
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                if (token.isNullOrBlank()) return@addOnSuccessListener
                saveToken(uid, token)
            }
            .addOnFailureListener { Log.w(TAG, "could not read the FCM token", it) }
    }

    /**
     * Remove THIS device's token on sign-out so the next owner of this phone is
     * not rung for the old account — and, unlike the previous version, without
     * unregistering every other device the account is signed in on.
     *
     * SUSPENDING, and every caller must let it finish BEFORE `signOut()`. A
     * fire-and-forget delete is queued locally and re-sent by the Firestore
     * client moments later, by which time the auth token is gone and the rules
     * refuse it — the phone would go on ringing for the account that was just
     * signed out, which is the whole bug this closes.
     */
    suspend fun clearToken(uid: String) {
        val userDoc = FirebaseFirestore.getInstance().collection("users").document(uid)
        try {
            val token = FirebaseMessaging.getInstance().token.await()
            if (!token.isNullOrBlank()) tokenDoc(uid, token).delete().await()
        } catch (e: Exception) {
            Log.w(TAG, "could not delete this device's token", e)
        }
        // Legacy field: this device is the only writer of it that we can see from
        // here, and it is single-valued anyway, so it goes unconditionally. The
        // other devices keep their subcollection docs, which is what is sent to.
        try {
            userDoc.update("fcmToken", FieldValue.delete()).await()
        } catch (e: Exception) {
            Log.w(TAG, "could not clear the legacy fcmToken field", e)
        }
    }
}

/** Process-wide foreground tracking so the service can suppress redundant notifications. */
object AppState : Application.ActivityLifecycleCallbacks {
    @Volatile var isForeground: Boolean = false; private set
    /** uid of the peer whose chat is currently open, or null. Set by ChatViewModel. */
    @Volatile var openChatUid: String? = null
    /**
     * True only while CallWatcherViewModel is actually listening for incoming
     * calls. `isForeground` alone was used to suppress the call notification,
     * but the watcher only runs once the user reaches Main — so a signed-in user
     * sitting on Splash, ProfileSetup, FaceVerification or Terms got neither the
     * in-app ring nor the notification. Set by CallWatcherViewModel.start/stop.
     */
    @Volatile var callWatcherActive: Boolean = false
    private var started = 0

    override fun onActivityStarted(activity: Activity) { started++; isForeground = true }
    override fun onActivityStopped(activity: Activity) { started--; if (started <= 0) { started = 0; isForeground = false } }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
