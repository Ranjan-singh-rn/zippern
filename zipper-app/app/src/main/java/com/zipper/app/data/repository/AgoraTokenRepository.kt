package com.zipper.app.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.zipper.app.util.ServerRefusals
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/** What the server said about this channel. */
sealed interface AgoraTokenResult {
    /**
     * A token was issued. [token] is null only when the server is unconfigured.
     *
     * [uid] is THE NUMBER THE TOKEN WAS SIGNED FOR, and the client must join
     * with it (A-7 / F-6). It used to be 0 — "let Agora assign" — which
     * `agora-access-token` signs as "any uid", so a viewer's token could join
     * as the host's uid and knock the host off their own stream. The server
     * now derives a stable, non-zero uid from the Firebase uid (a party seat
     * keeps its seat index) and returns it here. Joining with any other number
     * is refused by Agora.
     *
     * [expiresAtMs] is when the privilege lapses (one hour). The engine warns
     * thirty seconds before that through `onTokenPrivilegeWillExpire`, and
     * `AgoraManager` renews through [AgoraTokenRepository.requestToken] again.
     */
    data class Granted(
        val token: String?,
        val uid: Int = 0,
        val expiresAtMs: Long = 0L,
        /** `publisher` or `subscriber`, as the server decided. */
        val role: String = "",
    ) : AgoraTokenResult
    /** The host removed this viewer, or they are not a party to this call. */
    data object Denied : AgoraTokenResult
    /** The room or call is over. */
    data object Ended : AgoraTokenResult
    /** Network or unknown failure — the caller may retry. */
    data class Failed(val message: String?) : AgoraTokenResult
}

/**
 * Short-lived Agora RTC tokens from the `generateAgoraToken` Cloud Function.
 *
 * THE ONLY CALLER OF THAT FUNCTION. Every join and every renewal — live room,
 * PK, call, party — comes through here, so the refusal handling below is the
 * refusal handling for all of them.
 *
 * The function decides the ROLE as well as the token: the host of a live room
 * and the two parties to a call get a publisher token, everyone else gets a
 * subscriber token, and a kicked viewer gets `permission-denied`. That refusal
 * is the whole point of the server-side check, so it must not be flattened into
 * "no token" the way every failure used to be — a kicked viewer would then join
 * anyway, silently, exactly as before.
 *
 * Tokens are valid for one hour. A RENEWAL (A-6) is this same request again for
 * the same channel: the server reads, signs for the same uid, and writes
 * nothing. `AgoraManager` asks for one when the engine reports the token is
 * about to expire, and hands it to `RtcEngine.renewToken`.
 */
@Singleton
class AgoraTokenRepository @Inject constructor(
    private val functions: FirebaseFunctions,
    /** Phase 1A (SESSION-001): the active session id travels with the token request. */
    private val sessionManager: com.zipper.app.util.SessionManager,
) {
    /**
     * Ask for a token for [channelId].
     *
     * [uid] is informational only and is NOT what the token is signed for:
     * the server derives the uid (or takes the seat index in a party) and
     * returns it in [AgoraTokenResult.Granted.uid]. It is still sent so the
     * server can log a client that disagrees with it.
     */
    suspend fun requestToken(channelId: String, uid: Int = 0): AgoraTokenResult {
        return try {
            val result = functions
                .getHttpsCallable("generateAgoraToken")
                .call(sessionManager.withSession(mapOf("channelName" to channelId, "uid" to uid)))
                .await()
            @Suppress("UNCHECKED_CAST")
            val data = result.getData() as? Map<String, Any>
            val signedUid = when (val raw = data?.get("uid")) {
                /*
                 * DEPLOY-ORDER TOLERANCE. The function that returns `uid`
                 * (functions/src/index.ts, F-6) ships with this build but is
                 * deployed separately. A response with NO `uid` key is the
                 * previous function, whose token is signed for "any uid" — so
                 * joining with 0 is still what that token covers. A response
                 * that carries a uid the engine cannot use is refused below.
                 */
                null -> {
                    android.util.Log.w("AgoraToken", "Token for $channelId carried no uid (old server); joining with 0.")
                    0
                }
                is Number -> raw.toInt()
                else -> -1
            }
            if (signedUid < 0 || (data?.containsKey("uid") == true && signedUid == 0)) {
                return AgoraTokenResult.Failed("The server did not assign a media id. Please update the app.")
            }
            AgoraTokenResult.Granted(
                token = data?.get("token") as? String,
                uid = signedUid,
                expiresAtMs = (data?.get("expiresAt") as? Number)?.toLong() ?: 0L,
                role = data?.get("role") as? String ?: "",
            )
        } catch (e: FirebaseFunctionsException) {
            // P0-1: a session refusal also signs this device out (SessionViewModel).
            ServerRefusals.report(e)
            when (e.code) {
                FirebaseFunctionsException.Code.PERMISSION_DENIED -> AgoraTokenResult.Denied
                FirebaseFunctionsException.Code.FAILED_PRECONDITION -> AgoraTokenResult.Ended
                else -> {
                    android.util.Log.w("AgoraToken", "Token fetch failed for $channelId: ${e.code} ${e.localizedMessage}")
                    AgoraTokenResult.Failed(e.localizedMessage)
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("AgoraToken", "Token fetch failed for $channelId: ${e.localizedMessage}")
            AgoraTokenResult.Failed(e.localizedMessage)
        }
    }

    /**
     * The grant or null, for callers that have no way to act on a refusal
     * (the host's own join, the PK channel). A refusal still logs.
     */
    suspend fun fetchGrant(channelId: String): AgoraTokenResult.Granted? =
        when (val r = requestToken(channelId)) {
            is AgoraTokenResult.Granted -> r
            else -> null
        }

    /**
     * A-6: a fresh token for a channel the engine is still in, for
     * `RtcEngine.renewToken`. Null when the server refused or could not be
     * reached; the engine then drops the user at expiry, which is the state we
     * were in before renewal existed — never worse.
     */
    suspend fun renewToken(channelId: String): String? = fetchGrant(channelId)?.token
}
