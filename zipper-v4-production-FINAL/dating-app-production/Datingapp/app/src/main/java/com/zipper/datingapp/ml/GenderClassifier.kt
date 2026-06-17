package com.zipper.datingapp.ml

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

/**
 * TFLite-based gender classifier used during face verification.
 *
 * ## Model setup
 * Place a binary TFLite gender classification model at:
 *   `app/src/main/assets/gender_classifier.tflite`
 *
 * Expected model spec:
 *   - Input  : [1 × 224 × 224 × 3] float32, RGB pixels normalised to [0, 1]
 *   - Output : [1 × 2] float32  — [female_probability, male_probability] (softmax)
 *
 * Recommended free models (convert to .tflite):
 *   • MobileNetV2 trained on UTKFace / Adience datasets
 *   • https://github.com/shubham0204/Age-Gender_Estimation_TF-Android
 *
 * ## Graceful degradation
 * If the model file is missing or fails to load, [isAvailable] returns false and
 * [classify] returns null — verification proceeds without a gender check rather
 * than blocking the user.
 */
class GenderClassifier(context: Context) {

    private val tag = "GenderClassifier"

    /** Pixel dimensions expected by the model. */
    private val inputSize = 224

    /** Asset filename for the TFLite model. */
    private val modelFileName = "gender_classifier.tflite"

    private val interpreter: Interpreter? = runCatching {
        val afd = context.assets.openFd(modelFileName)
        FileInputStream(afd.fileDescriptor).use { fis ->
            val channel = fis.channel
            val buffer = channel.map(
                FileChannel.MapMode.READ_ONLY,
                afd.startOffset,
                afd.declaredLength
            )
            Interpreter(buffer, Interpreter.Options().apply { setNumThreads(2) })
        }
    }.onFailure {
        Log.w(tag, "Could not load $modelFileName — gender check will be skipped. " +
            "Add the model to app/src/main/assets/ to enable gender verification.", it)
    }.getOrNull()

    /** True when the TFLite model loaded successfully and inference is possible. */
    val isAvailable: Boolean get() = interpreter != null

    /**
     * Runs gender inference on [faceBitmap].
     *
     * @param faceBitmap Any-size bitmap of the face region (will be scaled to [inputSize]×[inputSize]).
     * @return [GenderResult] or null if the model is unavailable / inference fails.
     */
    fun classify(faceBitmap: Bitmap): GenderResult? {
        val interp = interpreter ?: return null
        return runCatching {
            // Scale to model input size
            val scaled = Bitmap.createScaledBitmap(faceBitmap, inputSize, inputSize, true)

            // Pack pixels into ByteBuffer: float32 RGB normalised [0, 1]
            val inputBuffer = ByteBuffer
                .allocateDirect(4 * inputSize * inputSize * 3)
                .apply {
                    order(ByteOrder.nativeOrder())
                    for (y in 0 until inputSize) {
                        for (x in 0 until inputSize) {
                            val px = scaled.getPixel(x, y)
                            putFloat(((px shr 16) and 0xff) / 255f) // R
                            putFloat(((px shr 8)  and 0xff) / 255f) // G
                            putFloat((px          and 0xff) / 255f) // B
                        }
                    }
                    rewind()
                }

            // [female_prob, male_prob]
            val output = Array(1) { FloatArray(2) }
            interp.run(inputBuffer, output)

            val femaleProb = output[0][0]
            val maleProb   = output[0][1]
            val predicted  = if (femaleProb >= maleProb) "female" else "male"
            val confidence = maxOf(femaleProb, maleProb)

            Log.d(tag, "classify: female=${"%.2f".format(femaleProb)} male=${"%.2f".format(maleProb)} → $predicted (conf ${"%.0f".format(confidence * 100)}%)")

            GenderResult(
                femaleProb      = femaleProb,
                maleProb        = maleProb,
                predictedGender = predicted,
                confidence      = confidence
            )
        }.onFailure { e ->
            Log.w(tag, "inference failed — gender check skipped", e)
        }.getOrNull()
    }

    /** Release TFLite resources. Call from [DisposableEffect.onDispose]. */
    fun close() {
        runCatching { interpreter?.close() }
    }
}

/**
 * Result of a [GenderClassifier.classify] call.
 *
 * @property femaleProb      Raw female softmax probability [0, 1].
 * @property maleProb        Raw male softmax probability [0, 1].
 * @property predictedGender `"female"` or `"male"` (whichever has higher probability).
 * @property confidence      `max(femaleProb, maleProb)` — use for threshold gating.
 */
data class GenderResult(
    val femaleProb      : Float,
    val maleProb        : Float,
    val predictedGender : String,
    val confidence      : Float
)
