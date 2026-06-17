package com.zipper.app.service

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ZipperMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // TODO Phase 14: Save FCM token to Firestore for this user
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        // TODO Phase 14: Route message by type (call, message, live, party)
        val type = message.data["type"] ?: return
        when (type) {
            "INCOMING_CALL"  -> handleIncomingCall(message.data)
            "NEW_MESSAGE"    -> handleNewMessage(message.data)
            "LIVE_STARTED"   -> handleLiveStarted(message.data)
            "PARTY_CREATED"  -> handlePartyCreated(message.data)
        }
    }

    private fun handleIncomingCall(data: Map<String, String>) { /* Phase 7 */ }
    private fun handleNewMessage(data: Map<String, String>) { /* Phase 8 */ }
    private fun handleLiveStarted(data: Map<String, String>) { /* Phase 4 */ }
    private fun handlePartyCreated(data: Map<String, String>) { /* Phase 6 */ }
}
