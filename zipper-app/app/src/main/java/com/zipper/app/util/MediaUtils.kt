package com.zipper.app.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.roundToInt

object MediaUtils {

    private const val MAX_IMAGE_PX    = 1080   // longest side for photos
    private const val IMAGE_QUALITY   = 72     // JPEG quality — clear enough, ~5× smaller
    private const val THUMB_QUALITY   = 60     // video thumbnail shown small, 60% is fine
    private const val VIDEO_MAX_HEIGHT = 720   // compress video down to 720p max

    // ── Image compression ─────────────────────────────────────────────────────

    /**
     * Decode image Uri → scale to MAX_IMAGE_PX on longest side → JPEG bytes at IMAGE_QUALITY.
     * Returns null if the Uri can't be read.
     */
    fun compressImage(context: Context, uri: Uri): ByteArray? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        val w = bounds.outWidth; val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null

        val opts = BitmapFactory.Options().apply {
            inSampleSize = computeSampleSize(w, h, MAX_IMAGE_PX)
            inPreferredConfig = Bitmap.Config.RGB_565   // half the memory of ARGB_8888
        }
        val raw = context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        } ?: return null

        val scaled = scaleBitmap(raw, MAX_IMAGE_PX)
        ByteArrayOutputStream(256 * 1024).use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, IMAGE_QUALITY, out)
            if (scaled !== raw) scaled.recycle()
            raw.recycle()
            out.toByteArray()
        }
    }.getOrNull()

    // ── Video compression ─────────────────────────────────────────────────────

    /**
     * Compress a video to 720p H.264 using Media3 Transformer.
     * The compressed file is written to the app's cache directory.
     *
     * Returns a [Uri] pointing to the compressed temp file, or null if compression
     * failed (caller should fall back to the original uri).
     *
     * The caller is responsible for deleting the temp file after upload.
     */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    suspend fun compressVideo(context: Context, uri: Uri, outputName: String): Uri? {
        val outputFile = File(context.cacheDir, "${outputName}.mp4")
        outputFile.delete()  // remove stale file if present

        return runCatching {
            // Media3 Transformer must be started from the main thread
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine { cont ->
                    val transformer = Transformer.Builder(context)
                        .setVideoMimeType(MimeTypes.VIDEO_H264)
                        .addListener(object : Transformer.Listener {
                            override fun onCompleted(
                                composition: Composition,
                                exportResult: ExportResult,
                            ) {
                                if (cont.isActive) cont.resume(
                                    if (outputFile.exists() && outputFile.length() > 0)
                                        Uri.fromFile(outputFile) else null
                                )
                            }

                            override fun onError(
                                composition: Composition,
                                exportResult: ExportResult,
                                exportException: ExportException,
                            ) {
                                if (cont.isActive) cont.resume(null)
                            }
                        })
                        .build()

                    // Presentation.createForHeight scales video down to 720p max
                    val editedMediaItem = EditedMediaItem.Builder(MediaItem.fromUri(uri))
                        .setEffects(
                            Effects(
                                /* audioProcessors = */ emptyList(),
                                /* videoEffects    = */ listOf(
                                    Presentation.createForHeight(VIDEO_MAX_HEIGHT)
                                ),
                            )
                        )
                        .build()

                    transformer.start(editedMediaItem, outputFile.absolutePath)

                    cont.invokeOnCancellation { transformer.cancel() }
                }
            }
        }.getOrNull()
    }

    // ── Video thumbnail ───────────────────────────────────────────────────────

    /**
     * Extract the first key frame of a local video Uri → JPEG thumbnail bytes.
     * Returns null on any failure.
     */
    fun extractVideoThumbnail(context: Context, uri: Uri): ByteArray? = runCatching {
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(context, uri)
        val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: retriever.frameAtTime
        retriever.release()
        frame ?: return null

        val scaled = scaleBitmap(frame, MAX_IMAGE_PX)
        ByteArrayOutputStream(128 * 1024).use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, THUMB_QUALITY, out)
            if (scaled !== frame) scaled.recycle()
            frame.recycle()
            out.toByteArray()
        }
    }.getOrNull()

    // ── helpers ───────────────────────────────────────────────────────────────

    private fun computeSampleSize(w: Int, h: Int, maxPx: Int): Int {
        val longest = max(w, h)
        var size = 1
        while (longest / (size * 2) > maxPx) size *= 2
        return size
    }

    private fun scaleBitmap(src: Bitmap, maxPx: Int): Bitmap {
        val longest = max(src.width, src.height)
        if (longest <= maxPx) return src
        val scale = maxPx.toFloat() / longest
        return Bitmap.createScaledBitmap(
            src,
            (src.width * scale).roundToInt(),
            (src.height * scale).roundToInt(),
            true,
        )
    }
}
