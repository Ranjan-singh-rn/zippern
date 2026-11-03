package com.zipper.app.ui.components

import android.text.TextPaint
import android.widget.ImageView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.opensource.svgaplayer.SVGACallback
import com.opensource.svgaplayer.SVGADynamicEntity
import com.opensource.svgaplayer.SVGAImageView
import com.opensource.svgaplayer.SVGAParser
import com.opensource.svgaplayer.SVGAVideoEntity
import java.net.URL

/**
 * B13 (4 Nov 2026) — one SVGA animation: a gift, an entrance or an avatar frame.
 *
 * SVGA is the format live-streaming apps use for these: a handful of PNG sprites moved by per-frame transforms,
 * so it composites over live video with real transparency and stays small (tools/decor builds them). This wraps
 * the open-source player in Compose.
 *
 * @param source an `https://…` URL (the catalogue's `svgaUrl`) or `asset:path/in/assets.svga` (bundled demos).
 * @param loops 0 = forever (frames, room themes); 1 = once (gifts, entrances).
 * @param dynamicImages image keys to replace at play time — `avatar` → the user's photo URL.
 * @param dynamicTexts text keys to draw at play time — `name` → the user's name.
 * @param onFinished called once when a finite animation ends, or when the file cannot be played (so an overlay
 *   waiting on it is never stuck).
 */
@Composable
fun Svga(
    source: String,
    modifier: Modifier = Modifier,
    loops: Int = 1,
    dynamicImages: Map<String, String> = emptyMap(),
    dynamicTexts: Map<String, String> = emptyMap(),
    textSizePx: Float = 34f,
    onFinished: () -> Unit = {},
) {
    val context = LocalContext.current
    val finished by rememberUpdatedState(onFinished)
    var view by remember { mutableStateOf<SVGAImageView?>(null) }

    DisposableEffect(source) {
        val parser = SVGAParser(context)
        var cancelled = false
        val completion = object : SVGAParser.ParseCompletion {
            override fun onComplete(videoItem: SVGAVideoEntity) {
                if (cancelled) return
                val dynamic = SVGADynamicEntity().apply {
                    dynamicImages.forEach { (key, url) -> if (url.isNotBlank()) setDynamicImage(url, key) }
                    dynamicTexts.forEach { (key, text) ->
                        if (text.isNotBlank()) {
                            val paint = TextPaint().apply {
                                isAntiAlias = true
                                color = android.graphics.Color.WHITE
                                textSize = textSizePx
                                isFakeBoldText = true
                            }
                            setDynamicText(text, paint, key)
                        }
                    }
                }
                view?.apply {
                    setVideoItem(videoItem, dynamic)
                    startAnimation()
                }
            }

            override fun onError() {
                if (!cancelled) finished()
            }
        }
        try {
            if (source.startsWith("asset:")) parser.decodeFromAssets(source.removePrefix("asset:"), completion)
            else parser.decodeFromURL(URL(source), completion)
        } catch (_: Exception) {
            finished()
        }
        onDispose {
            cancelled = true
            view?.stopAnimation(true)
        }
    }

    AndroidView(
        factory = { ctx ->
            SVGAImageView(ctx).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                this.loops = loops
                clearsAfterStop = true
                callback = object : SVGACallback {
                    override fun onPause() {}
                    override fun onFinished() { if (loops > 0) finished() }
                    override fun onRepeat() {}
                    override fun onStep(frame: Int, percentage: Double) {}
                }
                view = this
            }
        },
        modifier = modifier,
    )
}
