package com.zipper.datingapp.util

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import androidx.compose.runtime.*
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Builds an [ExoPlayer] with an HTTP data source tuned for fast start and smooth playback.
 * Caller must call [ExoPlayer.release] when done.
 */
fun buildVideoPlayer(context: Context, url: String): ExoPlayer {
    val httpDataSourceFactory = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(8_000)
        .setReadTimeoutMs(20_000)
        .setDefaultRequestProperties(emptyMap())

    val dataSourceFactory = DefaultDataSource.Factory(context, httpDataSourceFactory)

    val mediaSource = ProgressiveMediaSource.Factory(dataSourceFactory)
        .createMediaSource(MediaItem.fromUri(url))

    return ExoPlayer.Builder(context)
        .build()
        .also { player ->
            player.setMediaSource(mediaSource)
            player.prepare()
            player.playWhenReady = true
        }
}

/**
 * Extract the first video frame from a remote URL on a background thread.
 * Returns null on any failure.
 */
suspend fun extractVideoThumbnail(url: String): Bitmap? = withContext(Dispatchers.IO) {
    runCatching {
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(url, HashMap<String, String>())
        val bmp = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        retriever.release()
        bmp
    }.getOrNull()
}

/** Returns true if the URL likely points to a video file. */
fun isVideoUrl(url: String): Boolean =
    url.contains(".mp4", ignoreCase = true) ||
    url.contains(".mov", ignoreCase = true) ||
    url.contains(".webm", ignoreCase = true) ||
    url.contains(".mkv", ignoreCase = true) ||
    url.contains("video", ignoreCase = true)
