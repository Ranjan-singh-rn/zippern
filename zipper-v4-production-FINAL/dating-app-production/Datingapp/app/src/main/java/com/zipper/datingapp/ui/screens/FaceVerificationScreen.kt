package com.zipper.datingapp.ui.screens

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.zipper.datingapp.ml.GenderClassifier
import com.zipper.datingapp.ui.DatingUiState
import kotlinx.coroutines.tasks.await
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Minimum smile probability to trigger verification (lowered from 0.6 → 0.45 for faster detection).
 * Aligned with the gate in [captureImageWithMediaImageValidation].
 */
private const val SMILE_PROBABILITY_THRESHOLD = 0.45f

/**
 * Maximum eye-open probability for BOTH eyes to count as a deliberate blink.
 * Acts as an alternative trigger when the user cannot produce a clear smile.
 */
private const val BLINK_PROBABILITY_THRESHOLD = 0.30f

/**
 * Minimum gender-classifier confidence to enforce a gender mismatch rejection.
 * Below this value the check is skipped rather than blocking the user.
 * Set to 0f to disable gender checking entirely (e.g. while the model is absent).
 */
private const val GENDER_CONFIDENCE_THRESHOLD = 0.70f

@Composable
fun FaceVerificationScreen(
    uiState: DatingUiState,
    /** Called after capture; must invoke [onFinished] when upload/processing ends (success or failure). */
    onVerify: (Uri, onFinished: () -> Unit) -> Unit,
    onCancel: () -> Unit
) {
    BackHandler(onBack = onCancel)
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }
    val previewView = remember { PreviewView(context) }
    val imageCapture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
    }
    val cameraExecutor: ExecutorService = remember { Executors.newSingleThreadExecutor() }
    /** Gate from camera analyzer thread (avoid stale Compose state + unsafe thread writes). */
    val captureInProgress = remember { AtomicBoolean(false) }
    val lastNoFacePreviewToastMs = remember { AtomicLong(0L) }
    val analysisHolder = remember { object { @Volatile var analysis: ImageAnalysis? = null } }

    var isCapturing by remember { mutableStateOf(false) }
    var smileHint by remember { mutableStateOf("Smile (or blink) to verify") }

    val detector = remember {
        FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                // Enables smilingProbability AND eyeOpenProbability for blink detection
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .build()
        )
    }

    // Gender classifier — gracefully absent when model file is not yet in assets/
    val genderClassifier = remember(context) { GenderClassifier(context) }
    val declaredGender = uiState.currentUser?.genderText.orEmpty()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF09090F))
            .padding(24.dp)
    ) {
        IconButton(
            onClick = onCancel,
            modifier = Modifier.align(Alignment.TopEnd)
        ) {
            Icon(Icons.Default.Close, contentDescription = null, tint = Color.White)
        }

        Column(
            modifier = Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                Icons.Default.Verified,
                contentDescription = null,
                tint = Color(0xFF4FC3F7),
                modifier = Modifier.size(64.dp)
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Face Verification",
                style = MaterialTheme.typography.headlineMedium,
                color = Color.White,
                fontWeight = FontWeight.Bold
            )

            Text(
                text = "Align your face, then smile or blink deliberately. Verification triggers automatically.",
                style = MaterialTheme.typography.bodyLarge,
                color = Color.White.copy(alpha = 0.7f),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )

            Spacer(Modifier.height(40.dp))

            Box(
                modifier = Modifier
                    .size(200.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.05f))
                    .border(2.dp, Color(0xFF4FC3F7), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                AndroidView(
                    factory = { previewView },
                    modifier = Modifier.fillMaxSize()
                )
            }

            Spacer(Modifier.height(24.dp))
            Text(
                smileHint,
                color = if (isCapturing) Color(0xFF4ADE80) else Color.White,
                fontWeight = FontWeight.Medium
            )
        }

        Surface(
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
            color = Color.White.copy(alpha = 0.05f),
            shape = RoundedCornerShape(12.dp)
        ) {
            Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color(0xFF4ADE80), modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("Reference: ${uiState.currentUser?.name?.takeIf { it.isNotBlank() } ?: "your"} profile photos", color = Color.White.copy(alpha = 0.5f), fontSize = 11.sp)
            }
        }
    }

    LaunchedEffect(Unit) {
        val cameraProvider = cameraProviderFuture.get()
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .also { useCase ->
                analysisHolder.analysis = useCase
                useCase.setAnalyzer(cameraExecutor) { imageProxy ->
                    processFaceFrame(
                        imageProxy = imageProxy,
                        detector = detector,
                        context = context,
                        mainExecutor = mainExecutor,
                        lastNoFacePreviewToastMs = lastNoFacePreviewToastMs,
                        onSmileDetected = {
                            if (captureInProgress.compareAndSet(false, true)) {
                                mainExecutor.execute {
                                    isCapturing = true
                                    smileHint = "Smile detected! Capturing..."
                                    runCatching {
                                        captureImageWithMediaImageValidation(
                                            context = context,
                                            imageCapture = imageCapture,
                                            cameraExecutor = cameraExecutor,
                                            detector = detector,
                                            mainExecutor = mainExecutor,
                                            genderClassifier = genderClassifier,
                                            declaredGender = declaredGender,
                                            onReadyForUpload = { uri, _ ->
                                                try {
                                                    onVerify(uri) {
                                                        mainExecutor.execute {
                                                            captureInProgress.set(false)
                                                            isCapturing = false
                                                            smileHint = "Smile or blink to verify"
                                                        }
                                                    }
                                                } catch (e: Exception) {
                                                    Log.e("FaceVerification", "onVerify failed", e)
                                                    mainExecutor.execute {
                                                        captureInProgress.set(false)
                                                        isCapturing = false
                                                        smileHint = "Verification failed. Smile to try again"
                                                    }
                                                }
                                            },
                                            onInvalidFace = {
                                                mainExecutor.execute {
                                                    captureInProgress.set(false)
                                                    isCapturing = false
                                                    smileHint = "Smile or blink to verify"
                                                }
                                            },
                                            onError = {
                                                mainExecutor.execute {
                                                    captureInProgress.set(false)
                                                    isCapturing = false
                                                    smileHint = "Could not capture. Smile to verify"
                                                }
                                            }
                                        )
                                    }.onFailure { e ->
                                        Log.e("FaceVerification", "captureImage", e)
                                        mainExecutor.execute {
                                            captureInProgress.set(false)
                                            isCapturing = false
                                            smileHint = "Could not capture. Smile to verify"
                                        }
                                    }
                                }
                            }
                        },
                        onNoSmile = {
                            mainExecutor.execute {
                                if (!captureInProgress.get()) smileHint = "Smile or blink to verify"
                            }
                        }
                    )
                }
            }

        cameraProvider.unbindAll()
        cameraProvider.bindToLifecycle(
            lifecycleOwner,
            CameraSelector.DEFAULT_FRONT_CAMERA,
            preview,
            imageCapture,
            analysis
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { analysisHolder.analysis?.clearAnalyzer() }
            analysisHolder.analysis = null
            runCatching { cameraProviderFuture.get().unbindAll() }
            runCatching { detector.close() }
            runCatching { genderClassifier.close() }
            runCatching { cameraExecutor.shutdown() }
        }
    }
}

/**
 * Returns true when [this] face meets the verification trigger condition:
 *  • Big smile  : [Face.smilingProbability] > [SMILE_PROBABILITY_THRESHOLD], OR
 *  • Blink      : both [Face.leftEyeOpenProbability] AND [Face.rightEyeOpenProbability]
 *                 are below [BLINK_PROBABILITY_THRESHOLD] (deliberate eyes-closed gesture).
 */
private fun Face.isVerificationReady(): Boolean {
    val smile      = smilingProbability       ?: 0f
    val leftOpen   = leftEyeOpenProbability   ?: 1f
    val rightOpen  = rightEyeOpenProbability  ?: 1f
    val hasBigSmile = smile > SMILE_PROBABILITY_THRESHOLD
    val hasBlink    = leftOpen < BLINK_PROBABILITY_THRESHOLD && rightOpen < BLINK_PROBABILITY_THRESHOLD
    return hasBigSmile || hasBlink
}

private fun processFaceFrame(
    imageProxy: ImageProxy,
    detector: com.google.mlkit.vision.face.FaceDetector,
    context: Context,
    mainExecutor: Executor,
    lastNoFacePreviewToastMs: AtomicLong,
    onSmileDetected: () -> Unit,
    onNoSmile: () -> Unit
) {
    val mediaImage = imageProxy.image
    if (mediaImage == null) {
        imageProxy.close()
        return
    }
    val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    detector.process(inputImage)
        .addOnSuccessListener { faces: List<Face> ->
            when {
                faces.isEmpty() -> {
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastNoFacePreviewToastMs.get() > 2500L) {
                        lastNoFacePreviewToastMs.set(now)
                        mainExecutor.execute {
                            Toast.makeText(
                                context,
                                "No face detected — move closer and face the camera",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                    onNoSmile()
                }
                // Trigger on smile (≥ 0.45) OR deliberate blink (both eyes < 0.30)
                faces.any { it.isVerificationReady() } -> onSmileDetected()
                else -> onNoSmile()
            }
        }
        .addOnFailureListener { onNoSmile() }
        .addOnCompleteListener { runCatching { imageProxy.close() } }
}

/**
 * Decode JPEG from disk, apply orientation by **physically** rotating the bitmap.
 * Prefer EXIF when present; if EXIF reports 0 (e.g. raw buffer saved without tags), use [fallbackRotationDegrees].
 */
private fun bitmapFromJpegFileForMlKit(file: File, fallbackRotationDegrees: Int): Bitmap {
    val exif = ExifInterface(file)
    val orientation = exif.getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL
    )
    val exifRotation = exif.rotationDegrees
    val rotationDegrees = if (exifRotation != 0) exifRotation else fallbackRotationDegrees
    val decoded = BitmapFactory.decodeFile(file.absolutePath)
        ?: throw IllegalStateException("Could not decode captured image")
    Log.d(
        "FaceVerification",
        "JPEG decode: EXIF orientation=$orientation exifRotation=$exifRotation fallback=$fallbackRotationDegrees applied=$rotationDegrees file=${file.name}"
    )
    if (rotationDegrees == 0) return decoded
    val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
    val rotated = Bitmap.createBitmap(
        decoded,
        0,
        0,
        decoded.width,
        decoded.height,
        matrix,
        true
    )
    if (rotated != decoded) decoded.recycle()
    return rotated
}

/** CameraX file capture usually embeds EXIF; fallback 0. */
private fun inputImageFromCapturedFile(file: File): InputImage {
    val bitmap = bitmapFromJpegFileForMlKit(file, fallbackRotationDegrees = 0)
    return InputImage.fromBitmap(bitmap, 0)
}

/** Average luminance 0–255 of center crop; used to explain false negatives. */
private fun averageLuminance(bitmap: Bitmap): Float {
    val w = bitmap.width
    val h = bitmap.height
    if (w <= 0 || h <= 0) return 128f
    val cw = (w * 0.25f).toInt().coerceAtLeast(1)
    val ch = (h * 0.25f).toInt().coerceAtLeast(1)
    val x0 = (w - cw) / 2
    val y0 = (h - ch) / 2
    var sum = 0L
    var n = 0
    for (y in y0 until (y0 + ch)) {
        for (x in x0 until (x0 + cw)) {
            val p = bitmap.getPixel(x, y)
            val r = (p shr 16) and 0xff
            val g = (p shr 8) and 0xff
            val b = p and 0xff
            sum += (0.299 * r + 0.587 * g + 0.114 * b).toInt()
            n++
        }
    }
    return if (n == 0) 128f else sum / n.toFloat()
}

private fun logAndToastNoFace(context: Context, bitmapForMetrics: Bitmap?, tagReason: String) {
    val lum = bitmapForMetrics?.let { averageLuminance(it) }
    val message = when {
        bitmapForMetrics == null -> "Could not read the photo — try again"
        (lum ?: 128f) < 42f -> "Image too dark — try better lighting"
        else -> "No clear face — move closer and face the camera"
    }
    Log.w(
        "FaceVerification",
        "facesEmpty reason=$tagReason luminance=$lum (threshold dark < 42)"
    )
    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
}

/**
 * Crops [bitmap] to the face [boundingBox], clamping to image boundaries.
 * Used to extract the face region for gender classification.
 */
private fun cropFaceBitmap(bitmap: Bitmap, boundingBox: android.graphics.Rect): Bitmap {
    val left   = boundingBox.left.coerceAtLeast(0)
    val top    = boundingBox.top.coerceAtLeast(0)
    val right  = boundingBox.right.coerceAtMost(bitmap.width)
    val bottom = boundingBox.bottom.coerceAtMost(bitmap.height)
    val w = (right - left).coerceAtLeast(1)
    val h = (bottom - top).coerceAtLeast(1)
    return Bitmap.createBitmap(bitmap, left, top, w, h)
}

/**
 * Disk capture only: CameraX writes [photoFile] with EXIF; we read orientation via [ExifInterface],
 * apply [Matrix] in [bitmapFromJpegFileForMlKit], then [InputImage.fromBitmap].
 *
 * Phase 4 additions:
 *  • [genderClassifier] — when non-null and model is loaded, runs gender inference on the face
 *    crop; if predicted gender differs from [declaredGender] with ≥ [GENDER_CONFIDENCE_THRESHOLD]
 *    confidence the capture is rejected.
 *  • Smile OR blink condition: mirrors [Face.isVerificationReady] used in the live preview.
 */
private fun captureImageWithMediaImageValidation(
    context: Context,
    imageCapture: ImageCapture,
    cameraExecutor: Executor,
    detector: com.google.mlkit.vision.face.FaceDetector,
    mainExecutor: Executor,
    genderClassifier: GenderClassifier? = null,
    declaredGender: String = "",
    onReadyForUpload: (Uri, File) -> Unit,
    onInvalidFace: () -> Unit,
    onError: () -> Unit
) {
    val photoFile = File(context.cacheDir, "face_verify_${System.currentTimeMillis()}.jpg")
    val outputOptions = ImageCapture.OutputFileOptions.Builder(photoFile).build()
    Log.d("FaceVerification", "capture -> photoFile=${photoFile.name} (EXIF + Matrix before ML Kit)")
    imageCapture.takePicture(
        outputOptions,
        cameraExecutor,
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                val uri = outputFileResults.savedUri ?: FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    photoFile
                )
                try {
                    val inputImage = inputImageFromCapturedFile(photoFile)
                    detector.process(inputImage)
                        .addOnSuccessListener { faces: List<Face> ->
                            val readyFace = faces.firstOrNull { it.isVerificationReady() }
                            when {
                                faces.isEmpty() -> {
                                    Log.w("FaceVerification", "ML Kit: faces.isEmpty() after EXIF+Matrix upright decode")
                                    val bmp = runCatching {
                                        bitmapFromJpegFileForMlKit(photoFile, 0)
                                    }.getOrNull()
                                    mainExecutor.execute {
                                        logAndToastNoFace(context, bmp, "disk_capture_empty")
                                        onInvalidFace()
                                    }
                                }
                                readyFace == null -> {
                                    Log.w("FaceVerification", "Instant verify: face present but smile/blink threshold not met")
                                    mainExecutor.execute {
                                        Toast.makeText(
                                            context,
                                            "Smile clearly or blink fully, then try again.",
                                            Toast.LENGTH_LONG
                                        ).show()
                                        onInvalidFace()
                                    }
                                }
                                else -> {
                                    // ── Gender check (Phase 4) ──────────────────────────────────
                                    val classifier = genderClassifier
                                    if (classifier != null && classifier.isAvailable &&
                                        declaredGender.isNotBlank() &&
                                        GENDER_CONFIDENCE_THRESHOLD > 0f
                                    ) {
                                        val faceBitmap = runCatching {
                                            val fullBmp = bitmapFromJpegFileForMlKit(photoFile, 0)
                                            cropFaceBitmap(fullBmp, readyFace.boundingBox)
                                        }.getOrNull()

                                        val genderResult = faceBitmap?.let {
                                            runCatching { classifier.classify(it) }.getOrNull()
                                        }

                                        if (genderResult != null &&
                                            genderResult.confidence >= GENDER_CONFIDENCE_THRESHOLD &&
                                            genderResult.predictedGender != declaredGender
                                        ) {
                                            Log.w(
                                                "FaceVerification",
                                                "Gender mismatch: declared=$declaredGender " +
                                                "detected=${genderResult.predictedGender} " +
                                                "conf=${"%.0f".format(genderResult.confidence * 100)}%"
                                            )
                                            mainExecutor.execute {
                                                Toast.makeText(
                                                    context,
                                                    "Gender mismatch detected. Please verify using your own face.",
                                                    Toast.LENGTH_LONG
                                                ).show()
                                                onInvalidFace()
                                            }
                                            return@addOnSuccessListener
                                        }
                                    }
                                    // ─────────────────────────────────────────────────────────────
                                    Log.d(
                                        "FaceVerification",
                                        "Instant verify: faces=${faces.size} trigger=OK gender=OK → upload"
                                    )
                                    mainExecutor.execute { onReadyForUpload(uri, photoFile) }
                                }
                            }
                        }
                        .addOnFailureListener { e ->
                            Log.e("FaceVerification", "ML Kit process failed on disk capture", e)
                            mainExecutor.execute {
                                Toast.makeText(
                                    context,
                                    "Face detection failed. Try again.",
                                    Toast.LENGTH_LONG
                                ).show()
                                onInvalidFace()
                            }
                        }
                } catch (e: Exception) {
                    Log.e("FaceVerification", "decode/InputImage from photoFile", e)
                    mainExecutor.execute {
                        Toast.makeText(
                            context,
                            "Could not read capture. Try again.",
                            Toast.LENGTH_LONG
                        ).show()
                        onInvalidFace()
                    }
                }
            }

            override fun onError(exception: ImageCaptureException) {
                Log.e("FaceVerification", "takePicture(file) failed", exception)
                mainExecutor.execute {
                    Toast.makeText(
                        context,
                        "Could not capture photo. Try again.",
                        Toast.LENGTH_LONG
                    ).show()
                    onError()
                }
            }
        }
    )
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HOST FACE DEDUPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Prevents a person from creating two host accounts.
 *
 * HOW IT WORKS:
 * 1. On host verification submission, ML Kit extracts face landmark positions
 * 2. These positions are normalized into a pseudo-embedding vector (List<Float>)
 * 3. The vector is stored in Firestore: host_face_embeddings/{uid}
 * 4. Before approving a new host, compare against ALL existing host embeddings
 * 5. If cosine similarity > DUPLICATE_THRESHOLD → reject as duplicate face
 *
 * LIMITATIONS:
 * - ML Kit doesn't produce true embeddings (unlike FaceNet/ArcFace)
 * - We use landmark positions as a proxy — effective against casual duplication
 * - A proper implementation would use TFLite FaceNet model for real embeddings
 * - For production, move this comparison to a Cloud Function using a real model
 *
 * THRESHOLD: 0.92 cosine similarity → very conservative (few false positives)
 */
object HostFaceDeduplicate {

    private const val DUPLICATE_THRESHOLD = 0.92f
    private val db get() = com.google.firebase.firestore.FirebaseFirestore.getInstance()

    /**
     * Extract a pseudo-embedding from ML Kit face landmarks.
     * Returns a normalized vector of landmark x,y positions (relative coordinates).
     */
    fun extractPseudoEmbedding(face: com.google.mlkit.vision.face.Face): List<Float> {
        val landmarks: List<Int> = listOf(
            com.google.mlkit.vision.face.FaceLandmark.LEFT_EYE,
            com.google.mlkit.vision.face.FaceLandmark.RIGHT_EYE,
            com.google.mlkit.vision.face.FaceLandmark.NOSE_BASE,
            com.google.mlkit.vision.face.FaceLandmark.LEFT_CHEEK,
            com.google.mlkit.vision.face.FaceLandmark.RIGHT_CHEEK,
            com.google.mlkit.vision.face.FaceLandmark.MOUTH_LEFT,
            com.google.mlkit.vision.face.FaceLandmark.MOUTH_RIGHT,
            com.google.mlkit.vision.face.FaceLandmark.MOUTH_BOTTOM,
        )

        val positions = mutableListOf<Float>()
        val boundingBox = face.boundingBox
        val faceWidth = boundingBox.width().toFloat().coerceAtLeast(1f)
        val faceHeight = boundingBox.height().toFloat().coerceAtLeast(1f)

        for (landmarkType in landmarks) {
            val landmark = face.getLandmark(landmarkType)
            if (landmark != null) {
                // Normalize to [0,1] relative to face bounding box
                positions.add((landmark.position.x - boundingBox.left) / faceWidth)
                positions.add((landmark.position.y - boundingBox.top) / faceHeight)
            } else {
                positions.add(0f)
                positions.add(0f)
            }
        }

        return normalizeVector(positions)
    }

    /**
     * L2-normalize a vector (for cosine similarity).
     */
    private fun normalizeVector(v: List<Float>): List<Float> {
        val magnitude = Math.sqrt(v.sumOf { (it * it).toDouble() }).toFloat()
        return if (magnitude < 0.0001f) v else v.map { it / magnitude }
    }

    /**
     * Cosine similarity between two normalized vectors.
     * Range: -1 to 1. Higher = more similar. 1 = identical.
     */
    fun cosineSimilarity(a: List<Float>, b: List<Float>): Float {
        if (a.size != b.size) return 0f
        return a.zip(b).sumOf { (x, y) -> (x * y).toDouble() }.toFloat()
    }

    /**
     * Save face embedding to Firestore for future comparison.
     * Call this after host verification is approved.
     */
    suspend fun saveHostEmbedding(uid: String, embedding: List<Float>) {
        db.collection("host_face_embeddings")
            .document(uid)
            .set(
                mapOf(
                    "uid" to uid,
                    "embedding" to embedding,
                    "savedAt" to System.currentTimeMillis(),
                ),
            )
            .await()
    }

    /**
     * Check if this face already exists as a verified host.
     * @return DuplicateFaceResult
     */
    suspend fun checkForDuplicateFace(
        newEmbedding: List<Float>,
        excludeUid: String,
    ): DuplicateFaceResult {
        return try {
            val docs = db.collection("host_face_embeddings").get().await()
            var highestSimilarity = 0f
            var matchedUid: String? = null

            for (doc in docs.documents) {
                val existingUid = doc.getString("uid") ?: continue
                if (existingUid == excludeUid) continue // skip self

                @Suppress("UNCHECKED_CAST")
                val rawList = doc.get("embedding") as? List<*> ?: continue
                val existingEmbedding = rawList.mapNotNull { (it as? Number)?.toFloat() }

                if (existingEmbedding.size == newEmbedding.size) {
                    val similarity = cosineSimilarity(newEmbedding, existingEmbedding)
                    if (similarity > highestSimilarity) {
                        highestSimilarity = similarity
                        matchedUid = existingUid
                    }
                }
            }

            if (highestSimilarity >= DUPLICATE_THRESHOLD) {
                DuplicateFaceResult.Duplicate(matchedUid = matchedUid!!, similarity = highestSimilarity)
            } else {
                DuplicateFaceResult.Unique(highestSimilarity = highestSimilarity)
            }
        } catch (e: Exception) {
            DuplicateFaceResult.Error(e.message ?: "Unknown error")
        }
    }
}

sealed class DuplicateFaceResult {
    data class Duplicate(val matchedUid: String, val similarity: Float) : DuplicateFaceResult()
    data class Unique(val highestSimilarity: Float) : DuplicateFaceResult()
    data class Error(val message: String) : DuplicateFaceResult()
}
