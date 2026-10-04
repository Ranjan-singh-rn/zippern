package com.zipper.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.request.ImageRequest

/**
 * One entrance animation, played as video.
 *
 * ## Why this is a video player and not a Lottie
 *
 * The entrance assets are image-sequence Lotties: a full-screen picture per
 * frame, base64'd into JSON. `en_jet.json` is 22.3 MB and decodes to roughly
 * two gigabytes of bitmap, because Lottie has to turn every one of its 237
 * embedded 1082x1912 images into an Android bitmap to draw it. Re-encoded as
 * H.264 the same clip is 1.9 MB and plays on the hardware decoder — the
 * fixed-function block that every Android device has had for a decade, which
 * the Lottie path never touched.
 *
 * `functions/scripts/reencode-entrances.py` does the conversion and explains
 * the format choice; this is the other half of it.
 *
 * ## The rules this component enforces
 *
 * **One player at a time, and it dies with the composable.** An ExoPlayer holds
 * a hardware decoder session, and a device has a small fixed number of those —
 * on budget hardware sometimes two or three. Leaking one means the next video
 * anywhere in the app silently fails to start, so the release is in a
 * `DisposableEffect` rather than anywhere it could be skipped.
 *
 * **Never in a list.** This belongs in a detail sheet or a full-screen overlay.
 * A grid shows [posterUrl] as a still; that is what the Bag does, and it is
 * what stopped the Bag freezing the device.
 *
 * **Muted.** The re-encoded files carry no audio track at all (`-an`), but an
 * entrance plays over a live call, so a future asset that did carry one must
 * not talk over the host.
 *
 * @param posterUrl the still shown until the first frame renders, which avoids
 *   the black flash while the decoder spins up. The same image the grid uses,
 *   so it is already in Coil's cache by the time anyone opens this.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun EntranceVideo(
    videoUrl: String,
    posterUrl: String = "",
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    loop: Boolean = true,
    onFinished: () -> Unit = {},
) {
    val context = LocalContext.current
    var firstFrameRendered by remember(videoUrl) { mutableStateOf(false) }

    val exoPlayer = remember(videoUrl) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(videoUrl))
            repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            volume = 0f
            playWhenReady = true
            prepare()
        }
    }

    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() { firstFrameRendered = true }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) onFinished()
            }
        }
        exoPlayer.addListener(listener)
        onDispose {
            exoPlayer.removeListener(listener)
            // Releases the decoder session. See the note above on why this must
            // not be conditional.
            exoPlayer.release()
        }
    }

    // Backgrounding the app while a sheet is open must not leave a decoder
    // running behind a locked screen.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, exoPlayer) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE  -> exoPlayer.pause()
                Lifecycle.Event.ON_RESUME -> exoPlayer.play()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = exoPlayer
                    useController = false
                    // The clip is portrait and the box it sits in usually is not,
                    // so fit rather than crop — cropping an entrance cuts the
                    // subject's head off.
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                    // Transparent so the sheet's gradient shows through the
                    // letterboxing instead of a black slab.
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    setKeepContentOnPlayerReset(true)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        if (!firstFrameRendered && posterUrl.isNotBlank()) {
            AsyncImage(
                model = ImageRequest.Builder(context).data(posterUrl).crossfade(false).build(),
                contentDescription = contentDescription,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }

    // A non-looping clip that has already ended when it is recomposed (a
    // configuration change, say) would otherwise sit on a frozen last frame.
    LaunchedEffect(videoUrl) { exoPlayer.play() }
}
