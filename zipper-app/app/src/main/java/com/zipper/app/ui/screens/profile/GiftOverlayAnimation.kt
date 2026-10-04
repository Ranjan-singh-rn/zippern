package com.zipper.app.ui.screens.profile

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.airbnb.lottie.compose.*
import com.zipper.app.ui.theme.ZipperGold
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Bounces and pulses an emoji when no Lottie animation is available.
 * Uses infiniteTransition so it animates continuously until the overlay dismisses.
 */
@Composable
private fun AnimatedEmojiDisplay(emoji: String) {
    val infiniteTransition = rememberInfiniteTransition(label = "emoji_bounce")
    val bobY by infiniteTransition.animateFloat(
        initialValue  = 0f,
        targetValue   = -22f,
        animationSpec = infiniteRepeatable(
            animation  = tween(540, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "bob",
    )
    val pulse by infiniteTransition.animateFloat(
        initialValue  = 0.88f,
        targetValue   = 1.12f,
        animationSpec = infiniteRepeatable(
            animation  = tween(540, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse",
    )
    Text(
        text     = emoji,
        fontSize = 96.sp,
        modifier = Modifier
            .scale(pulse)
            .offset(y = bobY.dp),
    )
}

/**
 * Fullscreen gift overlay — Chamet/Bigo style.
 *
 * Flow:
 *  1. Fades in over the current screen
 *  2a. If gift has a Lottie asset → plays it 1–2× (waits for network load with 3 s timeout)
 *  2b. If emoji-mode gift (no lottieAsset) → shows [AnimatedEmojiDisplay] for 1.2–2 s
 *  3. Fades out and calls [onDismiss]
 *
 * Tapping anywhere dismisses early.
 */
@Composable
fun GiftOverlayAnimation(
    gift: GiftItem,
    senderName: String = "",
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()

    // Background alpha (drives both fade-in and fade-out)
    val bgAlpha   = remember { Animatable(0f) }
    // Card scale (springs up from 0.6 → 1.0 on appear)
    val cardScale = remember { Animatable(0.6f) }

    // Lottie — supports:
    //   "gifts/g1_rose.json"  → bundled asset (assets/ folder, no network)
    //   "https://..."         → remote URL (Firebase Storage or CDN)
    val hasLottie   = gift.lottieAsset.isNotBlank()
    val isRemoteUrl = gift.lottieAsset.startsWith("https://") || gift.lottieAsset.startsWith("http://")
    val lottieSpec  = when {
        !hasLottie  -> LottieCompositionSpec.Asset("gifts/g1_rose.json")  // dummy — will never render
        isRemoteUrl -> LottieCompositionSpec.Url(gift.lottieAsset)
        else        -> LottieCompositionSpec.Asset(gift.lottieAsset)
    }
    val composition by rememberLottieComposition(spec = lottieSpec)
    val lottieAnim  = rememberLottieAnimatable()

    // Dismiss helper — can be called from tap OR from the auto-play coroutine
    fun triggerDismiss() {
        scope.launch {
            bgAlpha.animateTo(0f, tween(350, easing = FastOutLinearInEasing))
            onDismiss()
        }
    }

    // Single lifecycle effect — runs once on enter
    LaunchedEffect(Unit) {
        // Fade in + spring scale together
        launch { bgAlpha.animateTo(1f, tween(280, easing = FastOutSlowInEasing)) }
        cardScale.animateTo(1f, tween(380, easing = FastOutSlowInEasing))

        val isNormalGift = gift.costDiamonds <= 50

        if (hasLottie) {
            // Wait for the Lottie composition to finish loading (disk or network), up to 3 s
            val resolvedComposition = withTimeoutOrNull(3_000L) {
                snapshotFlow { composition }.first { it != null }
            }
            if (resolvedComposition != null) {
                lottieAnim.animate(
                    composition = resolvedComposition,
                    iterations  = if (isNormalGift) 1 else 2,
                )
            } else {
                // Lottie load timed out — fall back to emoji display duration
                delay(if (isNormalGift) 1_200L else 2_000L)
            }
        } else {
            // Emoji-mode gift — AnimatedEmojiDisplay handles the visual
            delay(if (isNormalGift) 1_200L else 2_000L)
        }

        // Fade out
        bgAlpha.animateTo(0f, tween(350, easing = FastOutLinearInEasing))
        onDismiss()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .alpha(bgAlpha.value)
            .background(Color.Black.copy(0.68f))
            .clickable(
                indication        = null,
                interactionSource = remember { MutableInteractionSource() },
                onClick           = ::triggerDismiss,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .scale(cardScale.value)
                .wrapContentSize()
                .clickable(   // stop tap propagation
                    indication        = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick           = {},
                ),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // ── Animation / emoji ─────────────────────────────────────────
            Box(
                modifier         = Modifier.size(280.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (hasLottie && composition != null) {
                    LottieAnimation(
                        composition = composition,
                        progress    = { lottieAnim.progress },
                        modifier    = Modifier.fillMaxSize(),
                    )
                } else {
                    // Emoji-mode: bouncing + pulsing emoji
                    AnimatedEmojiDisplay(gift.emoji)
                }
            }

            // ── Gift name ────────────────────────────────────────────────
            Spacer(Modifier.height(8.dp))
            Text(
                gift.name,
                fontSize   = 26.sp,
                fontWeight = FontWeight.ExtraBold,
                color      = Color.White,
            )

            // ── Cost pill ────────────────────────────────────────────────
            Spacer(Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(Color.White.copy(0.15f))
                    .padding(horizontal = 18.dp, vertical = 6.dp),
            ) {
                Text(
                    "${gift.costDiamonds} 💎",
                    fontSize   = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color      = ZipperGold,
                )
            }

            // ── Sender label ─────────────────────────────────────────────
            if (senderName.isNotBlank()) {
                Spacer(Modifier.height(10.dp))
                Text(
                    "Sent by $senderName",
                    fontSize = 13.sp,
                    color    = Color.White.copy(0.55f),
                )
            }

            Spacer(Modifier.height(32.dp))

            // ── Tap to skip hint ─────────────────────────────────────────
            Text(
                "Tap anywhere to skip",
                fontSize = 12.sp,
                color    = Color.White.copy(0.35f),
            )
        }
    }
}
