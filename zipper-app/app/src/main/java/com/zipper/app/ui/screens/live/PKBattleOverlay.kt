package com.zipper.app.ui.screens.live

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.ui.theme.ZipperPink
import kotlinx.coroutines.delay

/**
 * PK Battle HUD shown at the top of the live screen while pkActive == true.
 *
 * Displays:
 *  - Host A avatar | score bar (animated) | Host B avatar
 *  - "VS" badge at centre
 *  - Countdown timer
 *  - Winner / loser badge when time runs out (shown for 3 s then [onPKEnd] is called)
 */
@Composable
fun PKBattleOverlay(
    myName: String,
    myPhotoUrl: String,
    myScore: Long,
    partnerName: String,
    partnerPhotoUrl: String,
    partnerScore: Long,
    pkEndTime: Long,
    onPKEnd: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val total = (myScore + partnerScore).coerceAtLeast(1L)
    val myFraction = myScore.toFloat() / total.toFloat()

    val animatedFraction by animateFloatAsState(
        targetValue = myFraction,
        animationSpec = tween(durationMillis = 600),
        label = "pk_bar",
    )

    // Countdown
    var remainingMs by remember { mutableLongStateOf((pkEndTime - System.currentTimeMillis()).coerceAtLeast(0L)) }
    var pkEnded by remember { mutableStateOf(false) }

    LaunchedEffect(pkEndTime) {
        while (true) {
            val left = pkEndTime - System.currentTimeMillis()
            if (left <= 0L) {
                remainingMs = 0L
                pkEnded = true
                delay(3_000)
                onPKEnd()
                break
            }
            remainingMs = left
            delay(1_000)
        }
    }

    val minutes = (remainingMs / 60_000).toInt()
    val seconds = ((remainingMs % 60_000) / 1_000).toInt()
    val timerText = "%02d:%02d".format(minutes, seconds)

    val myWins = pkEnded && myScore >= partnerScore
    val partnerWins = pkEnded && partnerScore > myScore

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(bottomStart = 16.dp, bottomEnd = 16.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // ── Top row: avatars + progress bar ──────────────────────────────────
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            // My side
            PKParticipantAvatar(
                photoUrl = myPhotoUrl,
                name = myName,
                score = myScore,
                isWinner = myWins,
                isLoser = partnerWins,
                align = Alignment.Start,
            )

            // Score bar
            Box(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            ) {
                // Background bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(Color.White.copy(0.2f)),
                )
                // My score portion (left side, pink)
                Box(
                    modifier = Modifier
                        .fillMaxWidth(animatedFraction)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(
                            Brush.horizontalGradient(listOf(ZipperPink, ZipperPink.copy(0.7f)))
                        ),
                )
                // VS badge
                Box(
                    modifier = Modifier.align(Alignment.Center),
                ) {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(Color(0xFFFF6B00))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    ) {
                        Text(
                            text = "VS",
                            color = Color.White,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 9.sp,
                        )
                    }
                }
            }

            // Partner side
            PKParticipantAvatar(
                photoUrl = partnerPhotoUrl,
                name = partnerName,
                score = partnerScore,
                isWinner = partnerWins,
                isLoser = myWins,
                align = Alignment.End,
            )
        }

        Spacer(Modifier.height(4.dp))

        // ── Timer / result ────────────────────────────────────────────────────
        if (pkEnded) {
            val resultText = when {
                myScore == partnerScore -> "🤝 Draw!"
                myWins                 -> "🏆 You Win!"
                else                   -> "😢 You Lost"
            }
            Text(
                text = resultText,
                color = if (myWins) Color(0xFFFFD700) else Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
            )
        } else {
            Text(
                text = "⚔️ PK  $timerText",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun PKParticipantAvatar(
    photoUrl: String,
    name: String,
    score: Long,
    isWinner: Boolean,
    isLoser: Boolean,
    align: Alignment.Horizontal,
    modifier: Modifier = Modifier,
) {
    val borderColor = when {
        isWinner -> Color(0xFFFFD700)
        isLoser  -> Color(0xFF888888)
        else     -> ZipperPink
    }

    Column(
        horizontalAlignment = if (align == Alignment.Start) Alignment.Start else Alignment.End,
        modifier = modifier,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(borderColor)
                .padding(2.dp),
        ) {
            AsyncImage(
                model = photoUrl.ifBlank { null },
                contentDescription = name,
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(Color.DarkGray),
            )
            if (isWinner) {
                Text(
                    "👑",
                    fontSize = 10.sp,
                    modifier = Modifier.align(Alignment.TopEnd),
                )
            }
        }
        Text(
            text = name.take(8),
            color = Color.White,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(48.dp),
        )
        Text(
            text = score.toString(),
            color = if (isWinner) Color(0xFFFFD700) else ZipperPink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(48.dp),
        )
    }
}
