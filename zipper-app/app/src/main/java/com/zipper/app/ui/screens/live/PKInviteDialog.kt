package com.zipper.app.ui.screens.live

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.app.data.model.PkInvite
import com.zipper.app.ui.theme.ZipperPink

/**
 * Shown while the host is in the matchmaking queue.
 * Animated "searching" indicator with a Cancel button.
 */
@Composable
fun PKSearchingDialog(onCancel: () -> Unit) {
    val infiniteTransition = rememberInfiniteTransition(label = "pk_search")
    val rotation by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(1200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pk_rotation",
    )

    AlertDialog(
        onDismissRequest = {},   // not dismissible by tapping outside
        title = { Text("⚔️ Finding PK Match", fontWeight = FontWeight.Bold) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(8.dp))
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(48.dp)
                        .graphicsLayer { rotationZ = rotation },
                    color = ZipperPink,
                    strokeWidth = 4.dp,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    text = "Searching for an opponent...\nThis could take a few seconds.",
                    color = Color.Gray,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                )
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onCancel) {
                Text("Cancel", color = Color.Gray)
            }
        },
    )
}

/**
 * Shown to BOTH matched hosts — they each independently accept or reject.
 *
 * [myUid] is used to determine which host's acceptance to show as "You accepted".
 * [invite] reflects live Firestore state so we know if the partner already accepted.
 */
@Composable
fun PKMatchFoundDialog(
    invite: PkInvite,
    myUid: String,
    onAccept: () -> Unit,
    onReject: () -> Unit,
) {
    val iAmHostA = invite.hostAUid == myUid
    val myName = if (iAmHostA) invite.hostAName else invite.hostBName
    val myPhoto = if (iAmHostA) invite.hostAPhotoUrl else invite.hostBPhotoUrl
    val opponentName = if (iAmHostA) invite.hostBName else invite.hostAName
    val opponentPhoto = if (iAmHostA) invite.hostBPhotoUrl else invite.hostAPhotoUrl

    val myAccepted = if (iAmHostA) invite.hostAAccepted else invite.hostBAccepted
    val partnerAccepted = if (iAmHostA) invite.hostBAccepted else invite.hostAAccepted

    AlertDialog(
        onDismissRequest = {},
        title = {
            Text("⚔️ PK Match Found!", fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth())
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Both host avatars side by side with VS
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                ) {
                    // Me
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.weight(1f),
                    ) {
                        AsyncImage(
                            model = myPhoto.ifBlank { null },
                            contentDescription = myName,
                            modifier = Modifier.size(56.dp).clip(CircleShape).background(Color.DarkGray),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(myName.take(8), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                        if (myAccepted) {
                            Text("✅ Accepted", fontSize = 10.sp, color = Color(0xFF4CAF50))
                        }
                    }

                    // VS
                    Text(
                        "VS",
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 18.sp,
                        color = Color(0xFFFF6B00),
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFFFF6B00).copy(alpha = 0.15f))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    )

                    // Opponent
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.weight(1f),
                    ) {
                        AsyncImage(
                            model = opponentPhoto.ifBlank { null },
                            contentDescription = opponentName,
                            modifier = Modifier.size(56.dp).clip(CircleShape).background(Color.DarkGray),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(opponentName.take(8), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                        if (partnerAccepted) {
                            Text("✅ Accepted", fontSize = 10.sp, color = Color(0xFF4CAF50))
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    text = "3-minute PK battle — viewers gift to support you!",
                    fontSize = 12.sp,
                    color = Color.Gray,
                    textAlign = TextAlign.Center,
                )

                if (myAccepted && !partnerAccepted) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Waiting for opponent to accept...",
                        fontSize = 12.sp,
                        color = Color(0xFFFFC107),
                        textAlign = TextAlign.Center,
                    )
                }
            }
        },
        confirmButton = {
            if (!myAccepted) {
                Button(
                    onClick = onAccept,
                    colors = ButtonDefaults.buttonColors(containerColor = ZipperPink),
                ) {
                    Text("Accept ⚔️", color = Color.White, fontWeight = FontWeight.Bold)
                }
            }
        },
        dismissButton = {
            if (!myAccepted) {
                OutlinedButton(onClick = onReject) { Text("Decline") }
            }
        },
    )
}
