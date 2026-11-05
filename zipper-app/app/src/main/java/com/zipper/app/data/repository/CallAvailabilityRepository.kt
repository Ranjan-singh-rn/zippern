package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.CallAvailability
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import javax.inject.Inject
import javax.inject.Singleton

/**
 * WP2 (5 Nov 2026) — one source for every Call button: the profile, the chat (top bar and the composer row), the live
 * rail and the party member sheet. Listens to the person's public presence and, only while they broadcast or sit in a
 * party room, to that room's calls switch, and turns the two into a [CallAvailability.Result]. Nothing here decides a
 * call — `startCall` does; this only lets a button say "Calls off" or "Busy" before anybody taps it.
 */
@Singleton
class CallAvailabilityRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
) {

    @OptIn(ExperimentalCoroutinesApi::class)
    fun observe(uid: String): Flow<CallAvailability.Result> {
        if (uid.isBlank()) return flowOf(CallAvailability.AVAILABLE)
        return presenceFlow(uid).flatMapLatest { p ->
            val liveId = CallAvailability.liveRoomToWatch(p)
            val partyId = CallAvailability.partyRoomToWatch(p)
            combine(
                if (liveId != null) roomFlow("liveRooms", liveId, "hostBlocksCalls") else flowOf(null),
                if (partyId != null) roomFlow("partyRooms", partyId, "ownerBlocksCalls") else flowOf(null),
            ) { live, party -> CallAvailability.resolve(p, live, party) }
        }.distinctUntilChanged()
    }

    private fun presenceFlow(uid: String): Flow<CallAvailability.Presence?> = callbackFlow {
        val reg = firestore.collection("publicProfiles").document(uid)
            .addSnapshotListener { snap, _ ->
                // A refused or failed read is "unknown": the button stays a Call button and the server decides.
                val p = snap?.takeIf { it.exists() }?.let { doc ->
                    CallAvailability.Presence(
                        uid = uid,
                        name = doc.getString("name") ?: "",
                        isLive = doc.getBoolean("isLive") ?: false,
                        liveRoomId = doc.getString("liveRoomId") ?: "",
                        isInParty = doc.getBoolean("isInParty") ?: false,
                        partyRoomId = doc.getString("partyRoomId") ?: "",
                        isInCall = doc.getBoolean("isInCall") ?: false,
                    )
                }
                trySend(p)
            }
        awaitClose { reg.remove() }
    }.distinctUntilChanged()

    private fun roomFlow(collection: String, roomId: String, switchField: String): Flow<CallAvailability.RoomSwitch?> =
        callbackFlow {
            val reg = firestore.collection(collection).document(roomId)
                .addSnapshotListener { snap, _ ->
                    val room = snap?.takeIf { it.exists() }?.let { doc ->
                        CallAvailability.RoomSwitch(
                            roomId = roomId,
                            hostUid = doc.getString("hostUid") ?: "",
                            isActive = doc.getBoolean("isActive") ?: true,
                            callsOff = doc.getBoolean(switchField) ?: false,
                        )
                    }
                    trySend(room)
                }
            awaitClose { reg.remove() }
        }.distinctUntilChanged()
}
