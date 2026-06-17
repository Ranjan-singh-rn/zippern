package com.zipper.datingapp.ui.screens

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import com.zipper.datingapp.data.CallState
import com.zipper.datingapp.economy.VirtualEconomyMath
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.video.VideoCanvas
import kotlinx.coroutines.delay

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * VIDEO / AUDIO CALL SCREEN (Agora RTC)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Used for both video calls (isVideoCall = true) and audio calls (isVideoCall = false).
 *
 * Economy:
 *  - Every 60 seconds, if callState == ACTIVE, the billing event is triggered
 *    by the Cloud Function watching the `calls` Firestore document.
 *  - This screen just shows the timer and controls.
 *  - viewModel.onCallConnected(callId) starts the timer.
 *  - viewModel.endCall(callId) writes the final duration → Cloud Function bills.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Composable
fun VideoCallScreen(
    viewModel: DatingViewModel,
    callId: String,
    calleeId: String,
    calleeName: String,
    calleePhotoUrl: String,
    isVideoCall: Boolean,
    rtcEngine: RtcEngine?,
    remoteAgoraUid: Int,
    /** Callback invoked when the call ends; receives billable elapsed seconds so the ViewModel can charge correctly. */
    onCallEnded: (elapsedSeconds: Int) -> Unit,
) {
    val callState by viewModel.callState.collectAsState()
    val currentUser by viewModel.currentUser.collectAsState()
    val diamonds by viewModel.diamonds.collectAsState()
    val isInPipMode by viewModel.isInPipMode.collectAsState()

    var isMuted by remember { mutableStateOf(false) }
    var isSpeakerOn by remember { mutableStateOf(true) }
    var isVideoEnabled by remember { mutableStateOf(isVideoCall) }

    // Local call duration timer — replaces the ViewModel stub (MutableStateFlow(0) that never ticks)
    var localDurationSeconds by remember { mutableIntStateOf(0) }
    LaunchedEffect(callState) {
        if (callState != CallState.ACTIVE) return@LaunchedEffect
        while (true) {
            delay(1_000)
            localDurationSeconds++
        }
    }

    // Cleanup on abnormal dispose (config change, back press while ACTIVE) so billing fires with elapsed time
    val latestOnCallEnded by rememberUpdatedState(onCallEnded)
    val latestCallState by rememberUpdatedState(callState)
    val latestDuration by rememberUpdatedState(localDurationSeconds)
    DisposableEffect(Unit) {
        onDispose {
            if (latestCallState != CallState.ENDED) latestOnCallEnded(latestDuration)
        }
    }

    // Auto-end on insufficient diamond balance (re-check every 5 s while active)
    LaunchedEffect(callState) {
        if (callState != CallState.ACTIVE) return@LaunchedEffect
        while (true) {
            delay(5_000)
            val callee = viewModel.viewedProfile.value
            if (callee != null) {
                val ratePerMin = if (isVideoCall) callee.videoCallRateBeansPerMin else callee.audioCallRateBeansPerMin
                val meGender = currentUser?.gender ?: ""
                val cost = VirtualEconomyMath.diamondCostPerMinuteForCaller(ratePerMin, meGender, callee.gender)
                if (cost > 0 && diamonds < cost.toLong()) {
                    latestOnCallEnded(latestDuration)
                    break
                }
            }
        }
    }

    // Pulse animation for dialing state
    val infiniteTransition = rememberInfiniteTransition(label = "dial_pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "scale",
    )

    // Auto-end if far side disconnects
    LaunchedEffect(callState) {
        if (callState == CallState.ENDED) {
            delay(1_500)
            onCallEnded(localDurationSeconds)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AppBackground),
    ) {
        // ── Remote video (full-screen) ─────────────────────────────────────
        if (isVideoCall && callState == CallState.ACTIVE && rtcEngine != null) {
            AndroidView(
                factory = { ctx ->
                    android.widget.FrameLayout(ctx).apply {
                        val remoteView = android.view.SurfaceView(ctx)
                        addView(remoteView)
                        rtcEngine.setupRemoteVideo(VideoCanvas(remoteView, VideoCanvas.RENDER_MODE_HIDDEN, remoteAgoraUid))
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else if (!isVideoCall || callState != CallState.ACTIVE) {
            // Audio call background or waiting
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Brush.radialGradient(listOf(BrandPurple.copy(0.4f), AppBackground))),
            )
        }

        // ── Local PIP (self-view) ──────────────────────────────────────────
        if (isVideoCall && isVideoEnabled && callState == CallState.ACTIVE && rtcEngine != null) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(12.dp)
                    .size(width = 90.dp, height = 120.dp)
                    .clip(RoundedCornerShape(10.dp)),
            ) {
                AndroidView(
                    factory = { ctx ->
                        android.widget.FrameLayout(ctx).apply {
                            val localView = android.view.SurfaceView(ctx)
                            addView(localView)
                            rtcEngine.setupLocalVideo(VideoCanvas(localView, VideoCanvas.RENDER_MODE_HIDDEN, 0))
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        // ── Callee info + status (center, shown while dialing/audio call) ──
        if (callState != CallState.ACTIVE || !isVideoCall) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.Center)
                    .padding(horizontal = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Avatar with pulse animation while dialing
                Box(
                    modifier = Modifier
                        .size(120.dp)
                        .scale(if (callState == CallState.DIALING) pulseScale else 1f)
                        .clip(CircleShape)
                        .background(BrandPurple.copy(0.3f)),
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = calleePhotoUrl.ifBlank { null },
                        contentDescription = calleeName,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                    )
                    if (calleePhotoUrl.isBlank()) {
                        Text(
                            calleeName.take(1).uppercase(),
                            color = Color.White,
                            style = MaterialTheme.typography.displayMedium,
                        )
                    }
                }

                Spacer(Modifier.height(20.dp))

                Text(calleeName, color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))

                Text(
                    when (callState) {
                        CallState.DIALING -> "Calling…"
                        CallState.RINGING -> "Ringing…"
                        CallState.CONNECTING -> "Connecting…"
                        CallState.ACTIVE -> if (isVideoCall) "" else formatCallDuration(localDurationSeconds)
                        CallState.ENDED -> "Call Ended"
                        else -> ""
                    },
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyLarge,
                )

                // Diamond cost indicator
                if (callState == CallState.DIALING || callState == CallState.ACTIVE) {
                    currentUser?.let { user ->
                        val callee = viewModel.viewedProfile.collectAsState().value
                        if (callee != null) {
                            val rate = if (isVideoCall) callee.videoCallRateBeansPerMin else callee.audioCallRateBeansPerMin
                            val cost = VirtualEconomyMath.diamondCostPerMinuteForCaller(rate, user.gender, callee.gender)
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "💎 $cost diamonds/min",
                                color = BrandPink.copy(0.85f),
                                fontSize = 13.sp,
                            )
                        }
                    }
                }
            }
        }

        // ── Timer overlay (video call, active) — hidden in PiP ───────────
        if (callState == CallState.ACTIVE && isVideoCall && !isInPipMode) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(12.dp)
                    .background(Color.Black.copy(0.45f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Text(formatCallDuration(localDurationSeconds), color = Color.White, fontSize = 12.sp)
            }
        }

        // ── Controls — hidden in PiP ──────────────────────────────────────
        if (!isInPipMode) {
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Mute microphone
                    CallControlButton(
                        icon = if (isMuted) Icons.Default.MicOff else Icons.Default.Mic,
                        label = if (isMuted) "Unmute" else "Mute",
                        tint = Color.White,
                        background = Color.White.copy(0.15f),
                        onClick = {
                            isMuted = !isMuted
                            rtcEngine?.muteLocalAudioStream(isMuted)
                        },
                    )

                    // END CALL — large red
                    Box(
                        modifier = Modifier
                            .size(68.dp)
                            .clip(CircleShape)
                            .background(Color(0xFFE53935))
                            .clickable { onCallEnded(localDurationSeconds) },  // passes elapsed so ViewModel can charge
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.CallEnd, contentDescription = "End", tint = Color.White, modifier = Modifier.size(30.dp))
                    }

                    // Speaker / video toggle
                    if (isVideoCall) {
                        CallControlButton(
                            icon = if (isVideoEnabled) Icons.Default.Videocam else Icons.Default.VideocamOff,
                            label = if (isVideoEnabled) "Video" else "No Video",
                            tint = Color.White,
                            background = Color.White.copy(0.15f),
                            onClick = {
                                isVideoEnabled = !isVideoEnabled
                                rtcEngine?.muteLocalVideoStream(!isVideoEnabled)
                            },
                        )
                    } else {
                        CallControlButton(
                            icon = if (isSpeakerOn) Icons.Default.VolumeUp else Icons.Default.VolumeOff,
                            label = if (isSpeakerOn) "Speaker" else "Earpiece",
                            tint = Color.White,
                            background = Color.White.copy(0.15f),
                            onClick = {
                                isSpeakerOn = !isSpeakerOn
                                rtcEngine?.setEnableSpeakerphone(isSpeakerOn)
                            },
                        )
                    }
                }
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CALL CONTROL BUTTON
// ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun CallControlButton(
    icon: ImageVector,
    label: String,
    tint: Color,
    background: Color,
    onClick: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(52.dp)
                .clip(CircleShape)
                .background(background)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(24.dp))
        }
        Text(label, color = TextMuted, fontSize = 11.sp)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AUDIO CALL SCREEN (delegates to VideoCallScreen with isVideoCall = false)
// ──────────────────────────────────────────────────────────────────────────────

@Composable
fun AudioCallScreen(
    viewModel: DatingViewModel,
    callId: String,
    calleeId: String,
    calleeName: String,
    calleePhotoUrl: String,
    rtcEngine: RtcEngine?,
    remoteAgoraUid: Int,
    onCallEnded: (elapsedSeconds: Int) -> Unit,
) = VideoCallScreen(
    viewModel = viewModel,
    callId = callId,
    calleeId = calleeId,
    calleeName = calleeName,
    calleePhotoUrl = calleePhotoUrl,
    isVideoCall = false,
    rtcEngine = rtcEngine,
    remoteAgoraUid = remoteAgoraUid,
    onCallEnded = onCallEnded,
)

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

private fun formatCallDuration(seconds: Int): String {
    val h = seconds / 3_600
    val m = (seconds % 3_600) / 60
    val s = seconds % 60
    return if (h > 0) "%02d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}
