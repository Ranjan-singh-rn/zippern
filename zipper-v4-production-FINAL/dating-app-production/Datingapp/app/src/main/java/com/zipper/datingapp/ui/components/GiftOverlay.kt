package com.zipper.datingapp.ui.components

import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.ViewGroup
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.fallbackImageVector
import com.zipper.datingapp.ui.media.GiftSoundPlayback
import com.zipper.datingapp.webrtc.WebRTCManager
import com.zipper.datingapp.data.giftAuraColors
import com.zipper.datingapp.data.giftIconTintOnOrb
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.random.Random

/** Spring "pop" for gift entrance (luxury motion spec: stiffness 400, damping 0.5). */
private val giftEntranceSpring = spring<Float>(dampingRatio = 0.45f, stiffness = 450f)

private data class GiftStarParticle(
    val vx: Float,
    val vy: Float,
    val radius: Float,
    val shape: Int = 0  // 0=circle, 1=ring, 2=star
)

private fun giftOverlayLoadControl(): DefaultLoadControl {
    // Short CRM clips: smaller buffers for faster start (min, max, playAfterBuffer, rebuffer).
    return DefaultLoadControl.Builder()
        .setBufferDurationsMs(
            2_500,
            20_000,
            500,
            2_500
        )
        .setTargetBufferBytes(-1)
        .build()
}

/** Muted video track only: keep default media semantics; focus is disabled when a second player plays MP3. */
private fun giftOverlayMutedVideoAudioAttributes(): AudioAttributes =
    AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build()

/**
 * Audible gift SFX / music (muxed video). [C.USAGE_GAME] mixes during [AudioManager.MODE_IN_COMMUNICATION].
 */
private fun giftOverlayAudibleGiftAudioAttributes(): AudioAttributes =
    AudioAttributes.Builder()
        .setUsage(C.USAGE_GAME)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build()

/**
 * Separate MP3 for CRM gifts: [USAGE_MEDIA] + music content routes on STREAM_MUSIC and tends to
 * play alongside VoIP. [handleAudioFocus] is false on this player so ExoPlayer does not defer
 * playback when [AudioManager.MODE_IN_COMMUNICATION] holds call focus (which blocked gift SFX).
 */
private fun giftOverlaySeparateMp3AudioAttributes(): AudioAttributes =
    AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build()

/** Max wait for video (and separate MP3 when applicable) to reach [Player.STATE_READY] before synchronized start. */
private const val VideoReadyWaitMs = 3_000L

/** CRM: default minimum on-screen time (seconds). Firestore 0 uses this. */
private const val CrmGiftDefaultMinSeconds = 12

/** CRM: overlay never runs longer than this (wall clock); guarantees dismiss + [onComplete]. */
private const val CrmGiftMaxWallSeconds = 12

/** CRM: max value read from Firestore / [Gift.displayDurationSeconds] (seconds). */
private const val CrmGiftMaxConfiguredSeconds = 12

/** Non-CRM: safety cap if [Player.STATE_ENDED] never fires (e.g. bad stream). */
private const val NonCrmSafetyWallSeconds = 600

/**
 * CRM / CRM_PREMIUM: minimum hold time (0 in Firestore → [CrmGiftDefaultMinSeconds]).
 * Clamped to 1..[CrmGiftMaxConfiguredSeconds].
 */
private fun Gift.crmMinDisplayMillis(): Long {
    val isCrm = isCrmGift || category.contains("CRM", ignoreCase = true)
    if (!isCrm) return 0L
    val v = displayDurationSeconds.coerceIn(0, CrmGiftMaxConfiguredSeconds)
    val sec = (if (v > 0) v else CrmGiftDefaultMinSeconds).coerceIn(1, CrmGiftMaxConfiguredSeconds)
    return sec * 1000L
}

private fun Gift.crmMaxWallMillis(): Long =
    if (isCrmGift || category.contains("CRM", ignoreCase = true)) {
        CrmGiftMaxWallSeconds * 1000L
    } else {
        NonCrmSafetyWallSeconds * 1000L
    }

@Composable
fun GiftOverlay(
    gift: Gift?,
    onComplete: () -> Unit
) {
    if (gift == null) return
    val videoUrl = gift.videoUrl.orEmpty().trim()
    val soundUrl = gift.soundUrl.orEmpty().trim()

    val primaryVideoUri = videoUrl.takeIf { it.isNotEmpty() }?.let(Uri::parse)
    val primaryAudioUri = if (primaryVideoUri == null) {
        soundUrl.takeIf { it.isNotEmpty() }?.let(Uri::parse)
    } else {
        null
    }

    val mediaUri = primaryVideoUri ?: primaryAudioUri
    val isCrmFullBleedGift =
        primaryVideoUri != null && (gift.isCrmGift || gift.category.contains("CRM", ignoreCase = true))
    val isLuckyGiftFlow = gift.category.equals("LUCKY", ignoreCase = true)
    val scrimAlpha =
        when {
            isLuckyGiftFlow -> 0f
            isCrmFullBleedGift -> 0.10f
            else -> 0.38f
        }

    Box(Modifier.fillMaxSize().zIndex(200f)) {
        if (scrimAlpha > 0f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = scrimAlpha)),
            )
        }
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            if (mediaUri == null) {
                GiftFallbackIconOverlay(gift = gift, onComplete = onComplete)
            } else {
                val isAudioOnlyGift = primaryVideoUri == null
                GiftVideoOverlayContent(
                    gift = gift,
                    mediaUri = mediaUri,
                    isAudioOnlyGift = isAudioOnlyGift,
                    loadControl = remember { giftOverlayLoadControl() },
                    onComplete = onComplete
                )
            }
        }
    }
}

@Composable
private fun GiftFallbackIconOverlay(gift: Gift, onComplete: () -> Unit) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val enterOffsetPx = remember(density) { with(density) { 220.dp.toPx() } }
    val scale = remember(gift.id) { Animatable(0.22f) }
    val alpha = remember(gift.id) { Animatable(0f) }
    val slideOffsetY = remember(gift.id) { Animatable(enterOffsetPx) }

    val auraPulse = rememberInfiniteTransition(label = "giftAuraFallback").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_300, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "auraPulse"
    )
    val shimmerPhase = rememberInfiniteTransition(label = "giftShimmerFallback").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_400, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "shimmerFallback"
    )
    val (glowInner, _) = remember(gift.id) { gift.giftAuraColors() }

    LaunchedEffect(gift.id) {
        triggerGiftHaptic(context)
        slideOffsetY.snapTo(enterOffsetPx)
        scale.snapTo(0.22f)
        alpha.snapTo(0f)
        coroutineScope {
            launch { alpha.animateTo(1f, tween(150)) }
            launch { slideOffsetY.animateTo(0f, giftEntranceSpring) }
            launch { scale.animateTo(1f, giftEntranceSpring) }
        }
        delay(max(2_100L, gift.crmMinDisplayMillis()))
        coroutineScope {
            launch {
                slideOffsetY.animateTo(
                    -enterOffsetPx * 1.3f,
                    tween(320, easing = FastOutLinearInEasing)
                )
            }
            launch {
                scale.animateTo(0.2f, tween(280, easing = FastOutLinearInEasing))
            }
            alpha.animateTo(0f, tween(260))
        }
        onComplete()
    }

    val isPremium = gift.category.contains("PREMIUM", ignoreCase = true)

    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        // Energy rings for premium gifts
        if (isPremium) {
            GiftEnergyRingLayer(
                burstKey = gift.id,
                accent = glowInner,
                ringCount = 4,
                modifier = Modifier.fillMaxSize()
            )
        }
        GiftParticleBurstLayer(
            burstKey = gift.id,
            accent = glowInner,
            modifier = Modifier.fillMaxSize()
        )
        // Outer breathing aura
        Box(
            modifier = Modifier
                .size(if (isPremium) 340.dp else 280.dp)
                .graphicsLayer {
                    val p = auraPulse.value
                    scaleX = 1f + (if (isPremium) 0.65f else 0.5f) * p
                    scaleY = 1f + (if (isPremium) 0.65f else 0.5f) * p
                    this.alpha = 0.18f + 0.38f * (1f - p)
                }
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            glowInner.copy(alpha = if (isPremium) 0.88f else 0.78f),
                            Color.Transparent
                        )
                    )
                )
        )
        // Secondary inner ring for premium
        if (isPremium) {
            Box(
                modifier = Modifier
                    .size(200.dp)
                    .graphicsLayer {
                        val p = auraPulse.value
                        scaleX = 1f + 0.3f * (1f - p)
                        scaleY = 1f + 0.3f * (1f - p)
                        this.alpha = 0.28f + 0.42f * p
                    }
                    .border(
                        width = 2.dp,
                        brush = Brush.sweepGradient(listOf(glowInner, Color.White, glowInner)),
                        shape = CircleShape
                    )
            )
        }
        // Gift icon
        Box(
            modifier = Modifier
                .size(if (isPremium) 160.dp else 128.dp)
                .graphicsLayer {
                    scaleX = scale.value
                    scaleY = scale.value
                    this.alpha = alpha.value
                    translationY = slideOffsetY.value
                    if (isPremium) rotationZ = shimmerPhase.value * 8f - 4f
                }
                .drawWithContent {
                    drawContent()
                    drawDiagonalGiftShimmer(shimmerPhase.value)
                }
        ) {
            Icon(
                imageVector = gift.fallbackImageVector(),
                contentDescription = gift.name,
                tint = gift.giftIconTintOnOrb(),
                modifier = Modifier.fillMaxSize()
            )
        }
    }
}

@Composable
private fun GiftVideoOverlayContent(
    gift: Gift,
    mediaUri: Uri,
    isAudioOnlyGift: Boolean,
    loadControl: DefaultLoadControl,
    onComplete: () -> Unit
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val enterOffsetPx = remember(density) { with(density) { 240.dp.toPx() } }

    val separateSound = remember(gift.id, gift.videoUrl, gift.soundUrl) {
        val v = gift.videoUrl.orEmpty().trim()
        val s = gift.soundUrl.orEmpty().trim()
        v.isNotEmpty() && s.isNotEmpty() && s != v
    }

    val scale = remember(gift.id) { Animatable(0.25f) }
    val alpha = remember(gift.id) { Animatable(0f) }
    val slideOffsetY = remember(gift.id) { Animatable(enterOffsetPx) }

    val auraPulse = rememberInfiniteTransition(label = "giftAuraVideo").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_100, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "videoAuraPulse"
    )
    val shimmerPhase = rememberInfiniteTransition(label = "giftShimmerVideo").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_400, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "shimmerVideo"
    )
    val (glowInner, _) = remember(gift.id) { gift.giftAuraColors() }

    val mutedVideoAudio = remember { giftOverlayMutedVideoAudioAttributes() }
    val audibleGiftAudio = remember { giftOverlayAudibleGiftAudioAttributes() }
    val separateMp3Audio = remember { giftOverlaySeparateMp3AudioAttributes() }
    val player = remember(gift.id, separateSound) {
        val attrs = if (separateSound) mutedVideoAudio else audibleGiftAudio
        val handleFocus = !separateSound
        ExoPlayer.Builder(context)
            .setLoadControl(loadControl)
            .setAudioAttributes(attrs, handleFocus)
            .build()
            .apply { playWhenReady = !separateSound }
    }

    val soundPlayer = remember(gift.id, separateSound) {
        if (separateSound) {
            ExoPlayer.Builder(context)
                .setLoadControl(loadControl)
                .setAudioAttributes(separateMp3Audio, /* handleAudioFocus = */ false)
                .build()
                .apply {
                    playWhenReady = false
                    volume = 1f
                }
        } else {
            null
        }
    }

    // In VoIP / live voice modes, STREAM_MUSIC is often inaudible unless routed to the loudspeaker.
    DisposableEffect(gift.id) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        @Suppress("DEPRECATION")
        val restoreSpeaker = am.isSpeakerphoneOn
        val inCallLikeMode =
            am.mode == AudioManager.MODE_IN_COMMUNICATION ||
                am.mode == AudioManager.MODE_IN_CALL
        if (inCallLikeMode) {
            WebRTCManager.applyLivePlaybackSpeakerMode(am, preferLoudSpeaker = true)
        }
        onDispose {
            if (inCallLikeMode) {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = restoreSpeaker
            }
        }
    }

    var firstFrameRendered by remember(gift.id) { mutableStateOf(false) }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }

    DisposableEffect(gift.id, player) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() {
                mainHandler.post { firstFrameRendered = true }
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    mainHandler.post { firstFrameRendered = true }
                }
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
        }
    }

    LaunchedEffect(gift.id) {
        val primaryEnded = AtomicBoolean(false)
        val secondaryEnded = AtomicBoolean(!separateSound)
        val primaryError = AtomicBoolean(false)
        val soundError = AtomicBoolean(false)
        val minDisplayMs = gift.crmMinDisplayMillis()
        val maxWallMs = gift.crmMaxWallMillis()

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) primaryEnded.set(true)
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w("GiftOverlay", "CRM gift video ExoPlayer error", error)
                primaryError.set(true)
            }
        })
        soundPlayer?.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) secondaryEnded.set(true)
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w("GiftOverlay", "CRM gift sound ExoPlayer error", error)
                soundError.set(true)
            }
        })

        player.setMediaItem(MediaItem.fromUri(mediaUri))
        if (separateSound && soundPlayer != null) {
            player.volume = 0f
        }
        player.prepare()
        player.playWhenReady = false

        if (separateSound && soundPlayer != null) {
            soundPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(gift.soundUrl.orEmpty().trim())))
            soundPlayer.prepare()
            soundPlayer.playWhenReady = false

            var waitedBoth = 0L
            while (waitedBoth < VideoReadyWaitMs && !primaryError.get()) {
                val videoOk =
                    player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_ENDED
                val soundOk =
                    soundPlayer.playbackState == Player.STATE_READY || soundPlayer.playbackState == Player.STATE_ENDED
                if (videoOk && soundOk) break
                delay(32)
                waitedBoth += 32
            }
            if (soundPlayer.playbackState != Player.STATE_READY && soundPlayer.playbackState != Player.STATE_ENDED) {
                Log.w("GiftOverlay", "CRM gift sound not READY after wait; starting video with best-effort audio")
            }
            if (soundError.get() || soundPlayer.playerError != null) {
                Log.w("GiftOverlay", "CRM gift sound error; retrying prepare once")
                soundError.set(false)
                runCatching {
                    soundPlayer.stop()
                    soundPlayer.clearMediaItems()
                    soundPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(gift.soundUrl.orEmpty().trim())))
                    soundPlayer.prepare()
                    var rw = 0L
                    while (rw < 4_000L &&
                        soundPlayer.playbackState != Player.STATE_READY &&
                        soundPlayer.playbackState != Player.STATE_ENDED
                    ) {
                        delay(32)
                        rw += 32
                    }
                }
            }
            if (soundError.get() || soundPlayer.playerError != null) {
                runCatching { soundPlayer.stop() }
                secondaryEnded.set(true)
                Log.w("GiftOverlay", "Sound failed after retry; starting video (muxed audio only if encoded in video)")
                runCatching {
                    player.volume = 1f
                    player.seekTo(0)
                    player.playWhenReady = true
                }
                GiftSoundPlayback.playGiftSuccessSound(context.applicationContext)
            } else {
                delay(80L)
                runCatching {
                    player.seekTo(0)
                    soundPlayer.seekTo(0)
                    player.playWhenReady = true
                    soundPlayer.playWhenReady = true
                }
            }
        } else {
            player.playWhenReady = true
            var waited = 0L
            while (player.playbackState != Player.STATE_READY &&
                player.playbackState != Player.STATE_ENDED &&
                waited < VideoReadyWaitMs &&
                !primaryError.get()
            ) {
                delay(32)
                waited += 32
            }
        }

        if (primaryError.get() || player.playerError != null) {
            Log.w("GiftOverlay", "Dismissing overlay: video playback failed")
            runCatching { player.stop() }
            runCatching { soundPlayer?.stop() }
            GiftSoundPlayback.playGiftSuccessSound(context.applicationContext)
            onComplete()
            return@LaunchedEffect
        }

        slideOffsetY.snapTo(enterOffsetPx)
        scale.snapTo(0.25f)
        alpha.snapTo(0f)

        val startWallClockMs = System.currentTimeMillis()

        triggerGiftHaptic(context)

        coroutineScope {
            launch { alpha.animateTo(1f, tween(130)) }
            launch { slideOffsetY.animateTo(0f, giftEntranceSpring) }
            launch { scale.animateTo(1f, giftEntranceSpring) }
        }

        fun cycleComplete(): Boolean =
            primaryEnded.get() && (!separateSound || secondaryEnded.get())

        while (true) {
            delay(32)
            val elapsed = System.currentTimeMillis() - startWallClockMs
            if (elapsed >= maxWallMs) break

            if (!cycleComplete()) continue

            if (elapsed >= minDisplayMs || elapsed >= maxWallMs) break

            primaryEnded.set(false)
            secondaryEnded.set(!separateSound)
            runCatching {
                player.seekTo(0)
                player.playWhenReady = true
                soundPlayer?.seekTo(0)
                soundPlayer?.playWhenReady = true
            }
        }

        runCatching {
            player.stop()
            soundPlayer?.stop()
        }
        val outPx = with(density) { 280.dp.toPx() }
        coroutineScope {
            launch {
                slideOffsetY.animateTo(
                    -outPx * 1.35f,
                    tween(340, easing = FastOutLinearInEasing)
                )
            }
            launch {
                scale.animateTo(0.14f, tween(300, easing = FastOutLinearInEasing))
            }
            alpha.animateTo(0f, tween(280))
        }
        onComplete()
    }

    DisposableEffect(gift.id) {
        onDispose {
            runCatching { player.release() }
            runCatching { soundPlayer?.release() }
        }
    }

    val isPremiumVideo = gift.category.contains("PREMIUM", ignoreCase = true)
    val isCrmFullBleed =
        !isAudioOnlyGift && (gift.isCrmGift || gift.category.contains("CRM", ignoreCase = true))

    BoxWithConstraints(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        val auraDiameterPremium = minOf(440.dp, maxWidth * 0.92f, maxHeight * 0.55f)
        val auraDiameterStd = minOf(400.dp, maxWidth * 0.88f, maxHeight * 0.52f)
        val standardVideoSize = minOf(330.dp, maxWidth * 0.82f, maxHeight * 0.45f)

        if (isPremiumVideo) {
            GiftEnergyRingLayer(
                burstKey = gift.id,
                accent = glowInner,
                ringCount = if (isCrmFullBleed) 6 else 5,
                modifier = Modifier.fillMaxSize()
            )
        }
        GiftParticleBurstLayer(
            burstKey = gift.id,
            accent = glowInner,
            modifier = Modifier.fillMaxSize()
        )
        if (!isCrmFullBleed) {
            Box(
                modifier = Modifier
                    .size(if (isPremiumVideo) auraDiameterPremium else auraDiameterStd)
                    .graphicsLayer {
                        val p = auraPulse.value
                        scaleX = 1f + (if (isPremiumVideo) 0.55f else 0.46f) * p
                        scaleY = 1f + (if (isPremiumVideo) 0.55f else 0.46f) * p
                        this.alpha = 0.18f + 0.32f * (1f - p)
                    }
                    .clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            colors = listOf(
                                glowInner.copy(alpha = if (isPremiumVideo) 0.9f else 0.82f),
                                Color.Transparent
                            )
                        )
                    )
            )
        }
        val videoAreaModifier = if (isCrmFullBleed) {
            Modifier
                .fillMaxWidth(0.94f)
                .heightIn(max = maxHeight * 0.78f)
                .aspectRatio(9f / 16f)
                .clip(RoundedCornerShape(20.dp))
        } else {
            Modifier.size(standardVideoSize)
        }
        Box(
            modifier = videoAreaModifier
                .graphicsLayer {
                    scaleX = scale.value
                    scaleY = scale.value
                    this.alpha = alpha.value
                    translationY = slideOffsetY.value
                }
                .drawWithContent {
                    drawContent()
                    if (!isCrmFullBleed) {
                        drawDiagonalGiftShimmer(shimmerPhase.value)
                    }
                }
        ) {
            if (isAudioOnlyGift) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black)
                ) {
                    if (gift.thumbnailUrl.isNotBlank()) {
                        AsyncImage(
                            model = gift.thumbnailUrl,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                }
            } else {
                val videoAreaBg =
                    if (isCrmFullBleed) Color.Transparent else Color(0xFF0D0D0D)
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(videoAreaBg)
                ) {
                    AndroidView(
                        factory = { ctx ->
                            PlayerView(ctx).apply {
                                useController = false
                                layoutParams = ViewGroup.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                    ViewGroup.LayoutParams.MATCH_PARENT
                                )
                            }
                        },
                        update = { view ->
                            view.player = player
                            val transparentShutter = isCrmFullBleed || !firstFrameRendered
                            view.setShutterBackgroundColor(
                                if (transparentShutter) android.graphics.Color.TRANSPARENT
                                else android.graphics.Color.BLACK
                            )
                            view.setBackgroundColor(
                                if (isCrmFullBleed) android.graphics.Color.TRANSPARENT
                                else android.graphics.Color.BLACK
                            )
                        },
                        modifier = Modifier.fillMaxSize()
                    )
                    if (!firstFrameRendered && gift.thumbnailUrl.isNotBlank()) {
                        AsyncImage(
                            model = gift.thumbnailUrl,
                            contentDescription = null,
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(1f)
                        )
                    }
                    if (!firstFrameRendered && gift.thumbnailUrl.isBlank()) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .zIndex(1f),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(44.dp),
                                color = Color(0xFFFFD700),
                                strokeWidth = 3.dp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GiftParticleBurstLayer(
    burstKey: Any,
    accent: Color,
    modifier: Modifier = Modifier
) {
    val particleCount = 22
    val particles = remember(burstKey) {
        val r = Random(burstKey.hashCode().toLong())
        List(particleCount) {
            val ang = r.nextDouble() * 2 * PI
            val dist = r.nextFloat() * 140f + 60f
            GiftStarParticle(
                vx = (cos(ang) * dist).toFloat(),
                vy = (sin(ang) * dist).toFloat(),
                radius = r.nextFloat() * 5f + 2f,
                shape = r.nextInt(3)
            )
        }
    }
    val progress = remember(burstKey) { Animatable(0f) }
    LaunchedEffect(burstKey) {
        progress.snapTo(0f)
        progress.animateTo(1f, tween(1000, easing = LinearEasing))
    }
    Canvas(modifier = modifier.graphicsLayer { }) {
        val p = progress.value
        val c = center
        particles.forEach { star ->
            val eased = p * p * (3f - 2f * p)   // smoothstep for natural deceleration
            val x = c.x + star.vx * eased
            val y = c.y + star.vy * eased
            val fade = ((1f - p).coerceIn(0f, 1f))
            when (star.shape) {
                1 -> {   // glowing ring particle
                    drawCircle(
                        color = accent.copy(alpha = fade * 0.65f),
                        radius = star.radius * 2.8f,
                        center = Offset(x, y),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = star.radius * 0.7f)
                    )
                }
                2 -> {   // bright white + accent halo
                    drawCircle(color = accent.copy(alpha = fade * 0.35f), radius = star.radius * 3.5f, center = Offset(x, y))
                    drawCircle(color = Color.White.copy(alpha = fade * 0.9f), radius = star.radius * 1.1f, center = Offset(x, y))
                }
                else -> { // standard glow circle
                    drawCircle(color = accent.copy(alpha = fade * 0.38f), radius = star.radius * 2.4f, center = Offset(x, y))
                    drawCircle(color = Color.White.copy(alpha = fade * 0.85f), radius = star.radius * (1f - p * 0.1f), center = Offset(x, y))
                }
            }
        }
    }
}

/** Expanding energy-ring wave effect for premium / high-value gifts. */
@Composable
fun GiftEnergyRingLayer(
    burstKey: Any,
    accent: Color,
    ringCount: Int = 3,
    modifier: Modifier = Modifier
) {
    val progresses = remember(burstKey) {
        List(ringCount) { Animatable(0f) }
    }
    LaunchedEffect(burstKey) {
        progresses.forEachIndexed { idx, anim ->
            launch {
                delay((idx * 160L))
                anim.snapTo(0f)
                anim.animateTo(1f, tween(900, easing = LinearEasing))
            }
        }
    }
    Canvas(modifier = modifier.graphicsLayer { }) {
        val c = center
        val maxR = size.minDimension * 0.72f
        progresses.forEachIndexed { idx, anim ->
            val p = anim.value
            val alpha = ((1f - p) * 0.55f).coerceIn(0f, 1f)
            val strokeW = (6f - idx * 1.5f) * (1f - p * 0.5f)
            drawCircle(
                color = accent.copy(alpha = alpha),
                radius = maxR * p,
                center = c,
                style = androidx.compose.ui.graphics.drawscope.Stroke(width = strokeW.coerceAtLeast(0.5f))
            )
            // inner highlight ring
            drawCircle(
                color = Color.White.copy(alpha = alpha * 0.4f),
                radius = maxR * p * 0.96f,
                center = c,
                style = androidx.compose.ui.graphics.drawscope.Stroke(width = strokeW * 0.4f)
            )
        }
    }
}

private fun DrawScope.drawDiagonalGiftShimmer(phase: Float) {
    val w = size.width
    val h = size.height
    val travel = w + h
    val x0 = -travel * 0.35f + phase * travel * 1.7f
    val brush = Brush.linearGradient(
        colors = listOf(
            Color.White.copy(alpha = 0f),
            Color.White.copy(alpha = 0.52f),
            Color.White.copy(alpha = 0f)
        ),
        start = Offset(x0, -h * 0.15f),
        end = Offset(x0 + h * 1.15f, h * 1.2f)
    )
    drawRect(brush = brush, size = size, blendMode = BlendMode.SrcAtop)
}

private const val GiftPreloadMaxPerPass = 16
private const val GiftPreloadPauseMs = 120L

@Composable
fun GiftAssetPreloader(gifts: List<Gift>) {
    val context = LocalContext.current
    val cacheDir = remember { File(context.cacheDir, "gift_assets").apply { mkdirs() } }
    LaunchedEffect(gifts) {
        if (gifts.isEmpty()) return@LaunchedEffect
        delay(400)
        gifts.take(GiftPreloadMaxPerPass).forEachIndexed { index, gift ->
            if (index > 0) delay(GiftPreloadPauseMs)
            cacheAssetToDisk(gift.videoUrl.orEmpty(), cacheDir, "mp4")
            delay(GiftPreloadPauseMs)
            cacheAssetToDisk(gift.soundUrl.orEmpty(), cacheDir, "mp3")
            val thumb = gift.thumbnailUrl.trim()
            if (thumb.isNotEmpty()) {
                delay(GiftPreloadPauseMs)
                val ext = thumb.substringAfterLast('.', "jpg").substringBefore('?', "jpg").take(8)
                cacheAssetToDisk(thumb, cacheDir, ext)
            }
        }
    }
}

private suspend fun cacheAssetToDisk(url: String, cacheDir: File, extension: String): File? {
    if (url.isBlank()) return null
    return withContext(Dispatchers.IO) {
        runCatching {
            val fileName = sha1(url) + "." + extension
            val outFile = File(cacheDir, fileName)
            if (outFile.exists()) return@runCatching outFile

            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 15000
                doInput = true
                connect()
            }
            if (connection.responseCode !in 200..299) return@runCatching null

            connection.inputStream.use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            }
            outFile
        }.getOrNull()
    }
}

private fun sha1(value: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(value.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }
}

private fun triggerGiftHaptic(context: Context) {
    runCatching {
        val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(VibratorManager::class.java)
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(35, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(35)
        }
    }
}
