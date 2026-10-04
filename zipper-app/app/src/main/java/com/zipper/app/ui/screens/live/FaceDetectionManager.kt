package com.zipper.app.ui.screens.live

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions

/**
 * Wraps ML Kit face detection.
 * Call [analyzeFrame] from a periodic coroutine (e.g., every 3 seconds) with
 * a bitmap captured from the live camera preview.
 * Results arrive via [onFaceDetected].
 */
object FaceDetectionManager {

    private var detector: FaceDetector? = null

    /** Invoked on the calling thread with true = face found, false = no face. */
    var onFaceDetected: ((Boolean) -> Unit)? = null

    fun init() {
        if (detector != null) return
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setMinFaceSize(0.15f)
            .build()
        detector = FaceDetection.getClient(options)
    }

    fun analyzeFrame(bitmap: Bitmap) {
        val d = detector ?: return
        try {
            val image = InputImage.fromBitmap(bitmap, 0)
            d.process(image)
                .addOnSuccessListener { faces -> onFaceDetected?.invoke(faces.isNotEmpty()) }
                .addOnFailureListener { onFaceDetected?.invoke(true) } // Safe default: assume face present
        } catch (_: Exception) {
            onFaceDetected?.invoke(true)
        }
    }

    fun release() {
        detector?.close()
        detector = null
    }
}
