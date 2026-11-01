package com.zipper.app.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.Timestamp
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.ActiveCall
import com.zipper.app.data.model.CallChatMessage
import com.zipper.app.data.model.CallRecord
import com.zipper.app.util.millis
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CallRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val money: MoneyFunctions,
) {

    private val callsCol get() = firestore.collection("calls")

    // ── Call lifecycle — all server-owned ─────────────────────────────────────
    //
    // Every one of these used to be a direct write to the `calls` document.
    // That put the caller's device in charge of when a call started, what it
    // cost per minute, and when it ended — the three numbers the bill is made
    // of. `startedAt` in particular was `System.currentTimeMillis()`, so the
    // charge for a call was measured against the caller's own clock.

    sealed interface CallStart {
        data class Ok(val callId: String, val perMinRateDiamonds: Long, val receiverPct: Int) : CallStart
        data class Failed(val message: String) : CallStart
    }

    /**
     * Ring [peerUid].
     *
     * The rate is no longer passed in. `startCall` reads the host's configured
     * rate and the CRM's split and returns what it decided, so the screen shows
     * the price the server will actually charge rather than one the client
     * computed and hoped matched.
     */
    suspend fun createCall(
        peerUid: String,
        idempotencyKey: String = money.newIdempotencyKey(),
    ): CallStart = when (val res = money.startCall(peerUid, idempotencyKey)) {
        is MoneyFunctions.Result.Ok ->
            CallStart.Ok(res.value.callId, res.value.perMinRateDiamonds, res.value.receiverPct)
        is MoneyFunctions.Result.Failed -> CallStart.Failed(res.userMessage)
    }

    /**
     * Pick up. The server stamps the start time — the clock begins there —
     * and charges the first full minute in the same transaction.
     *
     * @return null on success, or the server's refusal ("You need 750
     *   diamonds for one minute. You have 420.").
     */
    suspend fun acceptCall(callId: String): String? =
        when (val res = money.acceptCall(callId)) {
            is MoneyFunctions.Result.Ok -> null
            is MoneyFunctions.Result.Failed -> res.userMessage
        }

    /** [acceptCall] with the server's billing figures, for the screen that connects. */
    suspend fun acceptCallDetailed(callId: String): MoneyFunctions.Result<MoneyFunctions.CallAccept> =
        money.acceptCall(callId)

    suspend fun declineCall(callId: String): String? =
        when (val res = money.declineCall(callId, "declined")) {
            is MoneyFunctions.Result.Ok -> null
            is MoneyFunctions.Result.Failed -> res.userMessage
        }

    /**
     * What a hang-up did — or why it did not happen.
     *
     * `null` used to mean both "the server settled it" and "the request
     * failed", and the screen treated the second as the first. See [endCall].
     */
    sealed interface CallEndResult {
        data class Settled(val end: MoneyFunctions.CallEnd) : CallEndResult
        data class Failed(val message: String) : CallEndResult
    }

    /**
     * Hang up, and keep trying for a moment if the network is against us.
     *
     * ── WHY THE RETRY, AND WHY THE FAILURE IS NO LONGER SILENT ───────────────
     *
     * This returned `null` on failure, indistinguishable from a successful end
     * that reported nothing, and the call screen navigated away regardless. The
     * moment a hang-up is most likely to fail is the moment the signal dropped
     * — and that is exactly when the consequence is worst: the server still
     * believes the call is connected, nothing ticks, and two minutes later the
     * watchdog settles the whole gap at full rate. The user hung up and kept
     * paying for two more minutes.
     *
     * So: three attempts over a few seconds, because a hang-up is idempotent on
     * the server (`settleAndClose` short-circuits on an already-ended call) and
     * the common failure is a single dropped request rather than a lasting
     * outage. If all three fail the caller is TOLD, instead of being shown a
     * clean "call ended" over a call that is still running and still billing.
     */
    suspend fun endCall(
        callId: String,
        reason: String = "caller_ended",
    ): CallEndResult {
        var last = "The call could not be ended."
        repeat(3) { attempt ->
            when (val res = money.endCall(callId, reason)) {
                is MoneyFunctions.Result.Ok -> return CallEndResult.Settled(res.value)
                is MoneyFunctions.Result.Failed -> {
                    last = res.userMessage
                    // A refusal is final — the call is already ended, or is not
                    // ours. Only retry what looks transient.
                    if (res.code !in TRANSIENT_CODES) return CallEndResult.Failed(last)
                    if (attempt < 2) delay(1_200L * (attempt + 1))
                }
            }
        }
        return CallEndResult.Failed(last)
    }

    /**
     * Rang out unanswered.
     *
     * Had no caller anywhere in the app until the ring timeout was added, which
     * is why an unanswered call used to ring for ever. `VideoCallViewModel`
     * calls it now when the caller's own timer expires; the server sweep is the
     * backstop for a caller whose app is gone.
     */
    suspend fun markMissed(callId: String) {
        money.declineCall(callId, "missed")
    }

    /**
     * The liveness ping — and the one source of the billed figures on screen.
     *
     * Sends a call id and nothing else. The previous version was handed
     * `tickDiamonds` and `tickBeans` by the ViewModel, which had computed them
     * from a rate it read once — so the amount billed was whatever the caller's
     * app said it should be, and a client that simply stopped calling this was
     * on a free call.
     *
     * APK 20: the server charges whole minutes from its own clock (the first
     * on connect, then one at every 60-second mark); this tick charges nothing
     * by itself. BOTH devices send it every [LIVENESS_TICK_SECONDS] — the
     * earner's refreshes the watchdog and is never charged — and the answer
     * carries `minutesBilled`, `billedThroughMs`, `startedAtMs` and
     * `elapsedSeconds`, which `CallBilling` turns into the timer and the price.
     */
    suspend fun tickCall(callId: String): MoneyFunctions.CallTick? =
        when (val res = money.tickCall(callId)) {
            is MoneyFunctions.Result.Ok -> res.value
            is MoneyFunctions.Result.Failed -> null
        }

    // ── Real-time listeners ───────────────────────────────────────────────────

    fun callFlow(callId: String): Flow<ActiveCall?> = callbackFlow {
        val listener = callsCol.document(callId)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.let { ActiveCall.from(it) })
            }
        awaitClose { listener.remove() }
    }

    /** Watches for any incoming ringing call for the current user. */
    fun incomingCallFlow(myUid: String): Flow<ActiveCall?> = callbackFlow {
        /*
         * Only rings that are still ringing NOW.
         *
         * Without the cutoff this query happily returns a call from last
         * Tuesday: nothing used to close an unanswered `ringing` document, so
         * it sat there live, and the next time this listener attached it rang
         * again. Answering it stamped `startedAt` at that moment, the caller
         * was long gone so nobody ticked, and the watchdog then billed them for
         * about twelve ticks of a conversation that never happened.
         *
         * The server expires unanswered rings now, but this is the half that
         * protects the person in front of the phone: a device that has been
         * offline sees the sweep's write late, and until it arrives this filter
         * is what stops the ghost ringing. Slightly wider than the server's
         * 45 seconds, so a ring near the boundary is decided by the server
         * rather than disappearing from the callee's screen first.
         */
        val cutoff = Timestamp(java.util.Date(System.currentTimeMillis() - 90_000L))
        val listener = callsCol
            .whereEqualTo("receiverId", myUid)
            .whereEqualTo("status", "ringing")
            .whereGreaterThan("createdAt", cutoff)
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(1)
            .addSnapshotListener { snap, _ ->
                val call = snap?.documents?.firstOrNull()?.let { doc ->
                    ActiveCall.from(doc)
                }
                trySend(call)
            }
        awaitClose { listener.remove() }
    }

    // ── In-call chat ──────────────────────────────────────────────────────────

    suspend fun sendChatMessage(callId: String, message: String) {
        val uid = auth.currentUser?.uid ?: return
        val userSnap = firestore.collection("users").document(uid).get().await()
        val name = userSnap.getString("name") ?: ""
        callsCol.document(callId).collection("messages").add(
            mapOf(
                "senderUid"  to uid,
                "senderName" to name,
                "message"    to message,
                "timestamp"  to System.currentTimeMillis(),
            )
        ).await()
    }

    fun chatMessagesFlow(callId: String): Flow<List<CallChatMessage>> = callbackFlow {
        val listener = callsCol.document(callId).collection("messages")
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .addSnapshotListener { snap, _ ->
                val msgs = snap?.documents?.mapNotNull { doc ->
                    doc.toObject(CallChatMessage::class.java)?.copy(id = doc.id)
                } ?: emptyList()
                trySend(msgs)
            }
        awaitClose { listener.remove() }
    }

    // ── Call history ──────────────────────────────────────────────────────────

    /**
     * Fetch up to [limit] call history entries for [myUid].
     * Runs two queries (caller + receiver) and merges, sorted by timestamp desc.
     */
    suspend fun getCallHistory(myUid: String, limit: Long = 50): List<CallRecord> =
        loadCallHistory(myUid, limit).getOrDefault(emptyList())

    /**
     * B2: the same read, but a failure is a FAILURE, not an empty list. Call
     * history used to say "No calls yet" when the query was refused or the
     * network was down, and `CallHistoryUiState.error` was never set.
     */
    suspend fun loadCallHistory(myUid: String, limit: Long = 50): Result<List<CallRecord>> {
        return try {
            val historyCol = firestore.collection("callHistory")

            // As caller (outgoing calls)
            val asCallerSnap = historyCol
                .whereEqualTo("callerUid", myUid)
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(limit)
                .get().await()

            // As receiver (incoming calls)
            val asReceiverSnap = historyCol
                .whereEqualTo("receiverUid", myUid)
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(limit)
                .get().await()

            val records = mutableListOf<CallRecord>()

            for (doc in asCallerSnap.documents) {
                val receiverUid   = doc.getString("receiverUid")  ?: continue
                val receiverName  = doc.getString("receiverName") ?: ""
                val receiverPhoto = doc.getString("receiverPhotoUrl") ?: ""
                val duration      = doc.getLong("durationSeconds") ?: 0L
                val ts            = doc.millis("timestamp")
                val beans         = doc.getLong("beansEarned") ?: 0L
                records.add(
                    CallRecord(
                        id              = doc.id,
                        otherUserUid    = receiverUid,
                        otherUserName   = receiverName,
                        otherUserPhotoUrl = receiverPhoto,
                        type            = if (duration > 0L) "outgoing" else "missed",
                        durationSeconds = duration,
                        timestamp       = ts,
                        costBeans       = beans,
                    )
                )
            }

            for (doc in asReceiverSnap.documents) {
                val callerUid   = doc.getString("callerUid")   ?: continue
                val callerName  = doc.getString("callerName")  ?: ""
                val callerPhoto = doc.getString("callerPhotoUrl") ?: ""
                val duration    = doc.getLong("durationSeconds") ?: 0L
                val ts          = doc.millis("timestamp")
                val beans       = doc.getLong("beansEarned") ?: 0L
                records.add(
                    CallRecord(
                        id              = doc.id,
                        otherUserUid    = callerUid,
                        otherUserName   = callerName,
                        otherUserPhotoUrl = callerPhoto,
                        type            = if (duration > 0L) "incoming" else "missed",
                        durationSeconds = duration,
                        timestamp       = ts,
                        costBeans       = beans,
                    )
                )
            }

            // Merge and sort by timestamp descending, deduplicate by id
            Result.success(
                records
                    .distinctBy { it.id }
                    .sortedByDescending { it.timestamp }
                    .take(limit.toInt())
            )
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    companion object {
        /**
         * Failures worth trying again. Everything else is the server saying no,
         * and repeating a refusal only delays telling the person about it.
         */
        val TRANSIENT_CODES = setOf("UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL", "ABORTED")

        /**
         * How often EACH device pings `tickCall`.
         *
         * APK 20: this is a liveness interval, not a billing unit. The server
         * bills whole minutes from its own clock (functions/src/calls.ts) and
         * closes a call whose last tick from either side is older than two
         * minutes; ten seconds keeps the figures on screen fresh and the
         * watchdog quiet. A mismatch here changes nothing about what is
         * charged.
         */
        const val LIVENESS_TICK_SECONDS = com.zipper.app.util.CallBilling.LIVENESS_TICK_SECONDS

        /** Old name, kept for callers that still read it. */
        const val TICK_SECONDS = LIVENESS_TICK_SECONDS
    }
}
