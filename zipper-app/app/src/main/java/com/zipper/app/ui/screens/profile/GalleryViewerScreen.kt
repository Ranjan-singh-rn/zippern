package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.zipper.app.ui.components.IconButtonCircle
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Gallery viewer — full-bleed black pager. Top scrim with a circular close
 * and "n / total" caption, bottom page dots (brand current, glass others).
 * Images load via Coil; videos play with ExoPlayer.
 *
 * @param mediaUrls   List of image/video URLs.
 * @param startIndex  Page to open first.
 * @param onBack      Navigate back.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun GalleryViewerScreen(
    mediaUrls: List<String>,
    startIndex: Int = 0,
    onBack: () -> Unit,
) {
    // Guard: if no media, navigate back. Must be in LaunchedEffect — calling
    // onBack() directly during composition crashes Compose.
    if (mediaUrls.isEmpty()) {
        LaunchedEffect(Unit) { onBack() }
        return
    }

    val c = ZipperTheme.colors
    val pagerState = rememberPagerState(
        initialPage = startIndex.coerceIn(0, mediaUrls.lastIndex)
    ) { mediaUrls.size }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize(), pageSpacing = 4.dp) { page ->
            val url = mediaUrls[page]
            if (url.isVideoUrl()) {
                VideoPlayer(url = url, isCurrentPage = page == pagerState.currentPage)
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AsyncImage(model = url, contentDescription = "Media ${page + 1}", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                }
            }
        }

        // Top scrim: close + counter
        Box(Modifier.fillMaxWidth().align(Alignment.TopStart).background(Brush.verticalGradient(listOf(c.scrimMedium, Color.Transparent)))) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.sm, vertical = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButtonCircle(Icons.Default.Close, "Close", onBack, background = c.scrimMedium, tint = Color.White)
                Spacer(Modifier.weight(1f))
                Box(Modifier.background(c.scrimMedium, CircleShape).padding(horizontal = Space.md, vertical = Space.xs)) {
                    Text("${pagerState.currentPage + 1} / ${mediaUrls.size}", style = ZipperTheme.type.caption, color = Color.White)
                }
            }
        }

        // Bottom page dots
        if (mediaUrls.size <= 12) {
            Row(
                Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = Space.xxl),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                repeat(mediaUrls.size) { idx ->
                    val on = idx == pagerState.currentPage
                    Box(Modifier.size(if (on) 8.dp else 6.dp).background(if (on) c.brandPrimary else c.glassHigh, CircleShape))
                }
            }
        }
    }
}

// ── Video Player ──────────────────────────────────────────────────────────────

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun VideoPlayer(url: String, isCurrentPage: Boolean) {
    val context = LocalContext.current
    val exoPlayer = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            repeatMode    = Player.REPEAT_MODE_ONE
            volume        = 1f      // full sound
            playWhenReady = true    // start as soon as buffered enough
            prepare()
        }
    }

    // Pause when user swipes to another page; resume when they come back
    LaunchedEffect(isCurrentPage) {
        if (isCurrentPage) exoPlayer.play() else exoPlayer.pause()
    }

    DisposableEffect(exoPlayer) {
        onDispose { exoPlayer.release() }
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player        = exoPlayer
                    useController = false   // no seek bar / play-pause overlay
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

private fun String.isVideoUrl(): Boolean {
    // Firebase Storage URLs have ?alt=media&token=... so endsWith doesn't work.
    // Use contains to match the extension anywhere in the URL.
    val lower = lowercase()
    return lower.contains(".mp4") || lower.contains(".mov") ||
           lower.contains(".webm") || lower.contains(".mkv") ||
           lower.contains("/video/") || lower.contains("video%2F")
}
