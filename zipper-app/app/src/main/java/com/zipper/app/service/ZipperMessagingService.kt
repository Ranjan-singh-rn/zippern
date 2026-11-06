package com.zipper.app.service

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives the data-only messages sent by functions/src/push.ts and turns
 * them into notifications — or nothing, when the app is already showing the
 * thing the notification would point at.
 */
class ZipperMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Not signed in yet (fresh install): MainActivity re-reads and saves the
        // token when Main is reached, so nothing is lost by returning here.
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        PushNotifications.saveToken(uid, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val d = message.data
        when (d["type"]) {
            "INCOMING_CALL" -> {
                val callId = d["callId"] ?: return
                // Staleness is enforced by the server's 30s TTL and CALL_ENDED; a
                // device-clock comparison here silenced phones whose clock lagged.
                // In the foreground CallWatcherViewModel is already listening on
                // Firestore and navigates to the incoming screen itself — but ONLY
                // once the user has reached Main. `isForeground` alone therefore
                // left a dead zone: on Splash, ProfileSetup, FaceVerification or
                // Terms the watcher is stopped, so suppressing here meant the call
                // arrived nowhere at all.
                if (AppState.isForeground && AppState.callWatcherActive) return
                PushNotifications.showIncomingCall(this, callId, d["callerName"] ?: "Someone")
            }
            "CALL_ENDED" -> PushNotifications.cancelIncomingCall(this)
            "NEW_MESSAGE" -> {
                val senderUid = d["senderUid"] ?: return
                if (AppState.isForeground && AppState.openChatUid == senderUid) return
                PushNotifications.showMessage(this, senderUid, d["senderName"] ?: "New message", d["preview"] ?: "")
            }
            "NOTICE" -> {
                val title = d["title"] ?: return
                PushNotifications.showNotice(this, d["noticeId"] ?: title, title, d["body"] ?: "")
            }
            "LIVE_STARTED" -> {
                val roomId = d["roomId"] ?: return
                if (AppState.isForeground) return
                PushNotifications.showLiveStarted(this, roomId, d["hostName"] ?: "Someone you follow", d["title"] ?: "")
            }
        }
    }
}
