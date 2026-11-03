package com.zipper.app.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
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
    /**
     * QA #32: a photo of a DOCUMENT (an ID card, a registration proof, a UPI QR)
     * keeps enough detail to be read by a reviewer — and lands well under the
     * 10 MB the Storage rules allow a KYC document (a 12 MP phone photo was
     * sent unchanged and refused).
     */
    private const val DOC_MAX_PX      = 2048
    private const val DOC_QUALITY     = 85
    private const val THUMB_QUALITY   = 60     // video thumbnail shown small, 60% is fine
    private const val VIDEO_MAX_HEIGHT = 720   // compress video down to 720p max

    // ── Image compression ─────────────────────────────────────────────────────

    /**
     * Decode image Uri → scale to MAX_IMAGE_PX on longest side → turn upright
     * per its EXIF orientation → JPEG bytes at IMAGE_QUALITY.
     * Returns null if the Uri can't be read.
     *
     * The EXIF step matters: many phones (Samsung among them) store a portrait
     * shot as landscape pixels plus an orientation tag. BitmapFactory ignores
     * the tag and the re-encoded JPEG carries no EXIF, so without it every such
     * avatar, cover and gallery photo was uploaded lying on its side — seen in
     * the QA emulator run of 3 Nov 2026 (the picker showed the photo upright,
     * the profile showed it rotated 90°).
     */
    fun compressImage(context: Context, uri: Uri): ByteArray? =
        compress(context, uri, MAX_IMAGE_PX, IMAGE_QUALITY)

    /**
     * QA #32: [compressImage] for a document photo — larger and sharper (see
     * [DOC_MAX_PX]), upright, and JPEG. Null when the Uri cannot be decoded as
     * an image (a PDF, an unsupported format); the caller then checks the raw
     * file's size instead.
     */
    fun compressDocumentImage(context: Context, uri: Uri): ByteArray? =
        compress(context, uri, DOC_MAX_PX, DOC_QUALITY)

    /** The size of the file behind [uri] in bytes, or null when it cannot be told. */
    fun sizeOf(context: Context, uri: Uri): Long? = runCatching {
        context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
        } ?: context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize.takeIf { s -> s >= 0 } }
    }.getOrNull()

    private fun compress(context: Context, uri: Uri, maxPx: Int, quality: Int): ByteArray? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        val w = bounds.outWidth; val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null

        // QA #13: a PNG / WebP / GIF may carry transparency. RGB_565 has no
        // alpha and JPEG has none either, so transparent areas came out BLACK
        // — a transparent UPI QR would be black on black. Decode those with
        // alpha and flatten them onto white below.
        val mayHaveAlpha = bounds.outMimeType in ALPHA_TYPES
        val opts = BitmapFactory.Options().apply {
            inSampleSize = computeSampleSize(w, h, maxPx)
            inPreferredConfig = if (mayHaveAlpha) Bitmap.Config.ARGB_8888
                else Bitmap.Config.RGB_565   // half the memory of ARGB_8888
        }
        val raw = context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        } ?: return null

        val scaled = scaleBitmap(raw, maxPx)
        if (scaled !== raw) raw.recycle()
        // Rotate after scaling: the same result on a bitmap a fraction of the size.
        val upright = applyExifOrientation(scaled, readExifOrientation(context, uri))
        val flat = if (upright.hasAlpha()) onWhite(upright) else upright
        ByteArrayOutputStream(256 * 1024).use { out ->
            flat.compress(Bitmap.CompressFormat.JPEG, quality, out)
            flat.recycle()
            out.toByteArray()
        }
    }.getOrNull()

    private val ALPHA_TYPES = setOf("image/png", "image/webp", "image/gif")

    /** [src] drawn over white (recycling [src]): what a JPEG of a transparent image should look like. */
    private fun onWhite(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            drawBitmap(src, 0f, 0f, null)
        }
        src.recycle()
        return out
    }

    /** The EXIF orientation tag, or NORMAL when there is none or it cannot be read (PNG, WebP without EXIF…). */
    private fun readExifOrientation(context: Context, uri: Uri): Int = runCatching {
        context.contentResolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        }
    }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL

    /**
     * Returns [src] turned upright for [orientation] (recycling [src] when a new
     * bitmap is made). The matrix per tag is the one Glide uses
     * (TransformationUtils.initializeMatrixForRotation).
     */
    private fun applyExifOrientation(src: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180      -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL   -> { m.setRotate(180f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSPOSE       -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90       -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE      -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270      -> m.setRotate(-90f)
            else -> return src
        }
        val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        if (out !== src) src.recycle()
        return out
    }

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
