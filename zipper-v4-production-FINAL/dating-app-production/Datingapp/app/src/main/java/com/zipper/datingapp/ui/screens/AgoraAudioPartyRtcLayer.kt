package com.zipper.datingapp.ui.screens

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.datingapp.agora.AgoraManager
import java.io.File
import kotlinx.coroutines.delay

private const val TAG = "AgoraAudioPartyRtc"

/** Copy a content [Uri] (e.g. OpenDocument) to cache so Agora can read a local path. */
fun copyStreamUriToTempAudioFile(context: Context, uri: Uri): String? {
    return try {
        val cr = context.contentResolver
        val ext =
            when (cr.getType(uri)) {
                "audio/mpeg" -> "mp3"
                "audio/mp4", "audio/x-m4a", "audio/aac" -> "m4a"
                "audio/x-wav", "audio/wav" -> "wav"
                else -> "audio"
            }
        val out = File(context.cacheDir, "agora_bgm_${System.currentTimeMillis()}.$ext")
        cr.openInputStream(uri)?.use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        } ?: return null
        out.absolutePath
    } catch (e: Exception) {
        Log.w(TAG, "copyStreamUriToTempAudioFile", e)
        null
    }
}

/**
 * Minimal surface for Agora audio-party RTC: no video sinks, host or watcher joins by role.
 *
 * @param joinAsBroadcaster true for audio-party host, or seated guest who should publish mic.
 * @param micPermissionGranted RECORD_AUDIO granted when [joinAsBroadcaster] is true.
 */
@Composable
fun AgoraAudioPartyRtcLayer(
    channelId: String,
    firebaseUid: String,
    joinAsBroadcaster: Boolean,
    micPermissionGranted: Boolean,
    token: String?,
    /** When true, delay after join and invoke [onHostStreamReady] (host analytics / Firestore timing). */
    signalHostStreamReady: Boolean,
    onEngineReady: (AgoraManager?) -> Unit,
    onJoinedChannel: () -> Unit = {},
    onHostStreamReady: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val manager = remember { AgoraManager(context) }
    val latestJoined by rememberUpdatedState(onJoinedChannel)
    val latestHostReady by rememberUpdatedState(onHostStreamReady)

    DisposableEffect(Unit) {
        onEngineReady(manager)
        onDispose {
            onEngineReady(null)
            manager.destroy()
        }
    }

    val joinOk by manager.joinChannelSuccess.collectAsStateWithLifecycle(initialValue = false)

    LaunchedEffect(channelId, firebaseUid, joinAsBroadcaster, micPermissionGranted, token) {
        if (channelId.isBlank() || firebaseUid.isBlank()) return@LaunchedEffect
        val t = token ?: ""  // "" = no-auth / test mode; replace with signed token in production
        val publish = joinAsBroadcaster && micPermissionGranted
        manager.leaveChannel()
        delay(220)
        val uid = manager.agoraUidFromFirebaseUid(firebaseUid.trim())
        val trimmed = channelId.trim()
        if (publish) {
            manager.joinAsAudioPartyBroadcaster(trimmed, uid, t)
        } else {
            manager.joinAsAudioPartyAudience(trimmed, uid, t)
        }
    }

    LaunchedEffect(joinOk) {
        if (joinOk) latestJoined()
    }

    LaunchedEffect(joinOk, signalHostStreamReady) {
        if (!joinOk || !signalHostStreamReady) return@LaunchedEffect
        delay(1200)
        latestHostReady()
    }

    Box(modifier = modifier.size(0.dp))
}
