package com.zipper.app.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.io.File

/**
 * O5 (5 Nov 2026) — chat voice notes: AAC in an MPEG-4 container (`audio/mp4`, what storage.rules admits as audio),
 * mono 44.1 kHz at 64 kbit/s — about 0.5 MB a minute, under the 5 MB cap. At most [ChatParse.VOICE_MAX_MS]; the
 * recorder stops itself there. Anything under [ChatParse.VOICE_MIN_MS] is treated as a slip and thrown away.
 */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val isRecording: Boolean get() = recorder != null

    /** Starts recording; false when the microphone could not be opened (nothing is left behind). */
    fun start(onMaxReached: () -> Unit): Boolean {
        cancel()
        // The screen asks first; this is the check lint and the OS both want next to the microphone.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        val f = File(context.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(64_000)
            r.setAudioSamplingRate(44_100)
            r.setMaxDuration(ChatParse.VOICE_MAX_MS.toInt())
            r.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onMaxReached()
            }
            r.setOutputFile(f.absolutePath)
            r.prepare()
            r.start()
            recorder = r
            file = f
            startedAt = SystemClock.elapsedRealtime()
            true
        } catch (_: Exception) {
            runCatching { r.release() }
            f.delete()
            false
        }
    }

    fun elapsedMs(): Long = if (recorder != null) SystemClock.elapsedRealtime() - startedAt else 0L

    /** Stops. The recording and its length — or null when nothing usable was recorded (the file is then deleted). */
    fun stop(): Pair<File, Long>? {
        val r = recorder ?: return null
        val f = file
        val ms = SystemClock.elapsedRealtime() - startedAt
        recorder = null
        file = null
        // stop() throws when no audio was captured at all (a tap, not a recording).
        val ok = runCatching { r.stop() }.isSuccess
        runCatching { r.release() }
        if (!ok || f == null || !f.exists() || ms < ChatParse.VOICE_MIN_MS) {
            f?.delete()
            return null
        }
        return f to ms.coerceAtMost(ChatParse.VOICE_MAX_MS)
    }

    /** Stops and throws the recording away. */
    fun cancel() {
        stop()?.first?.delete()
    }
}

/** Plays one voice note at a time, streamed from its download URL. */
class VoicePlayer {
    private var player: MediaPlayer? = null

    /** The message id now playing, or null. */
    var playingId: String? = null
        private set

    fun play(id: String, url: String, onFinished: () -> Unit, onError: () -> Unit) {
        stop()
        val p = MediaPlayer()
        player = p
        playingId = id
        try {
            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            p.setOnPreparedListener { it.start() }
            p.setOnCompletionListener { stop(); onFinished() }
            p.setOnErrorListener { _, _, _ -> stop(); onError(); true }
            p.setDataSource(url)
            p.prepareAsync()
        } catch (_: Exception) {
            stop()
            onError()
        }
    }

    fun stop() {
        val p = player ?: return
        player = null
        playingId = null
        runCatching { if (p.isPlaying) p.stop() }
        runCatching { p.release() }
    }
}
