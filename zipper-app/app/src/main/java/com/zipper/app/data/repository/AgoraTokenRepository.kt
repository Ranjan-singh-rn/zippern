package com.zipper.app.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/** What the server said about this channel. */
sealed interface AgoraTokenResult {
    /** A token was issued. [token] is null only when the server is unconfigured. */
    data class Granted(val token: String?) : AgoraTokenResult
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
 * The function decides the ROLE as well as the token: the host of a live room
 * and the two parties to a call get a publisher token, everyone else gets a
 * subscriber token, and a kicked viewer gets `permission-denied`. That refusal
 * is the whole point of the server-side check, so it must not be flattened into
 * "no token" the way every failure used to be — a kicked viewer would then join
 * anyway, silently, exactly as before.
 *
 * Tokens are valid for one hour.
 */
@Singleton
class AgoraTokenRepository @Inject constructor(
    private val functions: FirebaseFunctions,
) {
    /**
     * Ask for a token for [channelId].
     *
     * [uid] is 0 to let Agora assign a dynamic uid.
     */
    suspend fun requestToken(channelId: String, uid: Int = 0): AgoraTokenResult {
        return try {
            val result = functions
                .getHttpsCallable("generateAgoraToken")
                .call(mapOf("channelName" to channelId, "uid" to uid))
                .await()
            @Suppress("UNCHECKED_CAST")
            val data = result.getData() as? Map<String, Any>
            AgoraTokenResult.Granted(data?.get("token") as? String)
        } catch (e: FirebaseFunctionsException) {
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
     * Token string or null, for callers that have no way to act on a refusal
     * (the host's own join, the PK channel). A refusal still logs.
     */
    suspend fun fetchToken(channelId: String, uid: Int = 0): String? =
        when (val r = requestToken(channelId, uid)) {
            is AgoraTokenResult.Granted -> r.token
            else -> null
        }
}
