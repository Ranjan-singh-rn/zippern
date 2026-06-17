package com.zipper.datingapp.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Native telephony-style feedback for WebRTC: outgoing ringback ([ToneGenerator]) and
 * incoming [Ringtone]. All audio is stopped on state transitions so nothing leaks across calls.
 */
object CallSoundManager {
    private const val TAG = "CallSoundManager"

    @Volatile
    private var toneGenerator: ToneGenerator? = null

    private var toneLoopJob: Job? = null

    @Volatile
    private var ringtone: Ringtone? = null

    private val lock = Any()

    /** Outgoing “dialing” cadence — repeats until [stopOutgoingDialTone] / [stopAll]. */
    fun startOutgoingDialTone(scope: CoroutineScope) {
        synchronized(lock) {
            stopOutgoingDialToneLocked()
            val tg = try {
                ToneGenerator(AudioManager.STREAM_VOICE_CALL, 100)
            } catch (e: RuntimeException) {
                Log.w(TAG, "ToneGenerator unavailable", e)
                null
            } ?: return

            toneGenerator = tg
            toneLoopJob = scope.launch(Dispatchers.Main.immediate) {
                while (isActive) {
                    try {
                        tg.startTone(ToneGenerator.TONE_SUP_RINGTONE, 260)
                    } catch (e: Exception) {
                        Log.w(TAG, "startTone failed", e)
                    }
                    delay(1_180L)
                }
            }
        }
    }

    fun stopOutgoingDialTone() {
        synchronized(lock) { stopOutgoingDialToneLocked() }
    }

    private fun stopOutgoingDialToneLocked() {
        toneLoopJob?.cancel()
        toneLoopJob = null
        toneGenerator?.let {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    it.stopTone()
                }
            } catch (_: Exception) {
            }
            try {
                it.release()
            } catch (_: Exception) {
            }
        }
        toneGenerator = null
    }

    /** System default incoming ringtone (looped on P+).
     *  RingtoneManager.getRingtone() does ContentResolver/disk I/O — run it on an IO thread
     *  to avoid StrictMode DiskReadViolation and main-thread jank (~400ms) on call arrival. */
    fun startIncomingRingtone(appContext: Context) {
        synchronized(lock) { stopIncomingRingtoneLocked() }
        val ctx = appContext.applicationContext
        Thread {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: run {
                Log.w(TAG, "No default ringtone URI")
                return@Thread
            }
            val rt = try {
                RingtoneManager.getRingtone(ctx, uri)   // disk I/O — safe on this thread
            } catch (e: Exception) {
                Log.w(TAG, "getRingtone failed", e)
                null
            } ?: return@Thread
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                rt.isLooping = true
            }
            try {
                rt.audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            } catch (_: Exception) {
            }
            synchronized(lock) {
                if (ringtone != null) {
                    // stopIncomingRingtone() was called while we were loading — discard
                    try { rt.stop() } catch (_: Exception) {}
                    return@Thread
                }
                ringtone = rt
            }
            try {
                rt.play()
            } catch (e: Exception) {
                Log.w(TAG, "ringtone.play failed", e)
                synchronized(lock) { ringtone = null }
            }
        }.also { it.name = "CallSoundManager-ringtone-load"; it.start() }
    }

    fun stopIncomingRingtone() {
        synchronized(lock) { stopIncomingRingtoneLocked() }
    }

    private fun stopIncomingRingtoneLocked() {
        ringtone?.let {
            try {
                it.stop()
            } catch (_: Exception) {
            }
        }
        ringtone = null
    }

    fun stopAll() {
        synchronized(lock) {
            stopOutgoingDialToneLocked()
            stopIncomingRingtoneLocked()
        }
    }
}
