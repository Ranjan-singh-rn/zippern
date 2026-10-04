package com.zipper.app.ui.screens.call

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.R
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Incoming call — Figma 60:31.
 *
 * Caller's photo blurred behind the brand gradient, two pulse rings (200/160)
 * around a 120 avatar with a 5dp gold ring, name at 28 Bold, "Incoming video
 * call", a rate card telling the host what this call pays, then Decline
 * (coral, 72) and Accept (mint, 72) 80dp apart.
 */
@Composable
fun IncomingCallScreen(
    callId: String,
    onCallAccepted: (callId: String) -> Unit,
    onCallDeclined: () -> Unit,
    viewModel: IncomingCallViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    var accepting by remember { mutableStateOf(false) }

    LaunchedEffect(state.status) {
        when (state.status) {
            CallStatus.ENDED, CallStatus.DECLINED, CallStatus.MISSED -> onCallDeclined()
            else -> Unit
        }
    }
    LaunchedEffect(state.navigateToCall) { if (state.navigateToCall) onCallAccepted(callId) }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        if (state.callerPhotoUrl.isNotBlank()) {
            AsyncImage(
                state.callerPhotoUrl, null, contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(), alpha = 0.3f,
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(listOf(Color(0xFFE81E6E), Color(0xFF7038E8), Color(0xFF0E0F21))),
                alpha = 0.65f,
            )
        )

        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))

            PulseRings {
                Box(
                    Modifier.size(120.dp).border(5.dp, c.brandVip, CircleShape).padding(7.dp),
                    contentAlignment = Alignment.Center,
                ) { Avatar(state.callerPhotoUrl, size = AvatarSize.XXL, initial = state.callerName) }
            }

            Spacer(Modifier.height(Space.xxl))
            Text(
                state.callerName.ifBlank { "Someone" },
                style = ZipperTheme.type.displayM, color = c.textPrimary, textAlign = TextAlign.Center,
                maxLines = 1,
            )
            Spacer(Modifier.height(Space.xs))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_video_call), null, tint = c.textSecondary, modifier = Modifier.size(16.dp))
                Text("Incoming video call", style = ZipperTheme.type.bodyM, color = c.textSecondary)
            }

            state.payRateDiamonds?.let { rate ->
                Spacer(Modifier.height(Space.xl))
                Row(
                    Modifier.background(c.scrimMedium, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.glassMid, RoundedCornerShape(Radius.lg))
                        .padding(horizontal = Space.lg, vertical = Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    CurrencyDisc(Currency.Diamond, 20.dp)
                    Column {
                        Text("This call costs ${indianGrouping(rate)} diamonds/min", style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text("Billed from your balance every 10 seconds", style = ZipperTheme.type.caption, color = c.textSecondary)
                    }
                }
            }

            state.earnRateBeans?.let { rate ->
                Spacer(Modifier.height(Space.xl))
                Row(
                    Modifier.background(c.scrimMedium, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.glassMid, RoundedCornerShape(Radius.lg))
                        .padding(horizontal = Space.lg, vertical = Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    CurrencyDisc(Currency.Bean, 20.dp)
                    Column {
                        Text(
                            if (state.isVerifiedHost) "You earn ${indianGrouping(rate)} beans/min"
                            else "Base rate until you're verified",
                            style = ZipperTheme.type.labelM, color = c.textPrimary,
                        )
                        Text(
                            "Credited every 10 seconds while connected",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                        )
                    }
                }
            }

            Spacer(Modifier.weight(1f))

            Row(horizontalArrangement = Arrangement.spacedBy(80.dp), modifier = Modifier.padding(bottom = Space.x5l)) {
                CallAction(
                    R.drawable.ic_call_end, "Decline", c.statusDanger,
                    onClick = { viewModel.decline(); onCallDeclined() },
                )
                CallAction(
                    R.drawable.ic_video_call, if (accepting) "Connecting…" else "Accept", c.statusSuccess,
                    enabled = !accepting,
                    onClick = { accepting = true; viewModel.accept() },
                )
            }
        }
    }
}

@Composable
private fun CallAction(iconRes: Int, label: String, color: Color, enabled: Boolean = true, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Box(
            Modifier.size(72.dp).background(if (enabled) color else color.copy(alpha = 0.5f), CircleShape)
                .then(if (enabled) Modifier.clickableNoRipple(onClick) else Modifier),
            contentAlignment = Alignment.Center,
        ) { Icon(painterResource(iconRes), label, tint = Color.White, modifier = Modifier.size(32.dp)) }
        Text(label, style = ZipperTheme.type.labelM, color = c.textPrimary)
    }
}
