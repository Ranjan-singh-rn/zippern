package com.zipper.datingapp.ui.components

import android.view.TextureView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.*
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.datingapp.agora.AgoraManager
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import io.agora.rtc2.Constants
import io.agora.rtc2.video.VideoCanvas
import kotlinx.coroutines.withTimeout

/**
 * App-wide floating PIP that appears when the user minimises a live stream.
 *
 * - Draggable anywhere on screen
 * - Shows real Agora video, **no audio** (silent preview while browsing)
 * - Tap → restore full live (calls [onRestore])
 * - Close → exit live entirely (calls [onClose])
 *
 * Place this at the very top level of the app (MainActivity) so it floats over every screen.
 */
@Composable
fun GlobalLivePip(
    partner: UserProfile,
    viewerFirebaseUid: String,
    onGetAgoraToken: suspend (channelId: String, isPublisher: Boolean) -> String?,
    onRestore: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current

    val screenW = with(density) { configuration.screenWidthDp.dp.toPx() }
    val screenH = with(density) { configuration.screenHeightDp.dp.toPx() }
    val pipW    = with(density) { 140.dp.toPx() }
    val pipH    = with(density) { 186.dp.toPx() }

    // Start bottom-right, above the nav bar
    var offset by remember {
        mutableStateOf(Offset(screenW - pipW - with(density) { 12.dp.toPx() },
                              screenH - pipH - with(density) { 80.dp.toPx() }))
    }

    // Agora — join as audience, video only (no audio while in PIP)
    val manager = remember(partner.id) { AgoraManager(context) }
    DisposableEffect(partner.id) { onDispose { manager.leaveChannel() } }

    val remoteUid by manager.remoteUid.collectAsStateWithLifecycle(initialValue = null)
    var joined by remember(partner.id) { mutableStateOf(false) }
    var token  by remember(partner.id) { mutableStateOf<String?>(null) }

    val textureView = remember(partner.id) {
        TextureView(context.applicationContext).apply { isOpaque = false }
    }

    // Fetch token then join
    LaunchedEffect(partner.id, viewerFirebaseUid) {
        if (partner.id.isBlank() || viewerFirebaseUid.isBlank()) return@LaunchedEffect
        val uid = manager.agoraUidFromFirebaseUid(viewerFirebaseUid.trim())
        // Join immediately without token (works for dev/test channels)
        manager.joinAsAudience(partner.id, uid, null, subscribeAudio = false)
        joined = true
        // Fetch real token in parallel and rejoin for production token-auth channels
        val tok = runCatching {
            withTimeout(12_000L) { onGetAgoraToken(partner.id, false) }
        }.getOrNull()
        if (tok != null) {
            token = tok
            manager.joinAsAudience(partner.id, uid, tok, subscribeAudio = false)
        }
    }

    // Bind remote video once broadcaster's UID arrives
    LaunchedEffect(remoteUid) {
        val ru = remoteUid ?: return@LaunchedEffect
        manager.bindRemoteVideo(textureView, ru, VideoCanvas.RENDER_MODE_HIDDEN, Constants.VIDEO_MIRROR_MODE_DISABLED)
    }

    // Full-screen host — zIndex ensures it's above the Scaffold
    Box(
        modifier = Modifier
            .fillMaxSize()
            .zIndex(100f)
    ) {
        // Drag wrapper
        Box(
            modifier = Modifier
                .offset { IntOffset(offset.x.toInt(), offset.y.toInt()) }
                .size(140.dp, 186.dp)
                .pointerInput(screenW, screenH) {
                    detectDragGestures { change, drag ->
                        change.consume()
                        offset = Offset(
                            (offset.x + drag.x).coerceIn(0f, (screenW - pipW).coerceAtLeast(0f)),
                            (offset.y + drag.y).coerceIn(0f, (screenH - pipH).coerceAtLeast(0f))
                        )
                    }
                }
        ) {
            Card(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable { onRestore() },
                shape = RoundedCornerShape(16.dp),
                elevation = CardDefaults.cardElevation(12.dp),
                colors = CardDefaults.cardColors(containerColor = Color.Black)
            ) {
                Box(Modifier.fillMaxSize()) {
                    // Agora video
                    AndroidView(factory = { textureView }, modifier = Modifier.fillMaxSize())

                    // Poster while video loads — use fully qualified name to avoid resolving
                    // to ColumnScope.AnimatedVisibility (Card{} puts ColumnScope in outer scope)
                    androidx.compose.animation.AnimatedVisibility(
                        visible = remoteUid == null,
                        enter = fadeIn(),
                        exit = fadeOut(tween(600))
                    ) {
                        Box(Modifier.fillMaxSize()) {
                            val posterUrl = partner.photoUrl.ifBlank {
                                partner.galleryPhotos.firstOrNull().orEmpty()
                            }
                            if (posterUrl.isNotBlank()) {
                                AsyncImage(
                                    model = posterUrl, contentDescription = null,
                                    modifier = Modifier.fillMaxSize(),
                                    contentScale = ContentScale.Crop
                                )
                            } else {
                                Box(
                                    Modifier.fillMaxSize().background(
                                        Brush.linearGradient(listOf(BrandPurple, BrandPink))
                                    ),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(partner.name.take(1).uppercase(), color = Color.White,
                                        fontSize = 36.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                            CircularProgressIndicator(
                                Modifier.size(22.dp).align(Alignment.Center),
                                color = Color.White.copy(0.8f), strokeWidth = 2.dp
                            )
                        }
                    }

                    // LIVE badge
                    Surface(
                        Modifier.align(Alignment.TopStart).padding(6.dp),
                        shape = RoundedCornerShape(5.dp), color = Color.Red
                    ) {
                        Row(
                            Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Box(Modifier.size(5.dp).background(Color.White, CircleShape))
                            Spacer(Modifier.width(3.dp))
                            Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.ExtraBold)
                        }
                    }

                    // Close button
                    IconButton(
                        onClick = onClose,
                        modifier = Modifier.align(Alignment.TopEnd).size(26.dp)
                    ) {
                        Icon(Icons.Default.Close, null, tint = Color.White, modifier = Modifier.size(14.dp))
                    }

                    // Bottom hint
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(28.dp)
                            .align(Alignment.BottomCenter)
                            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(0.75f)))),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("Tap to watch", color = Color.White, fontSize = 9.sp)
                    }
                }
            }
        }
    }
}
