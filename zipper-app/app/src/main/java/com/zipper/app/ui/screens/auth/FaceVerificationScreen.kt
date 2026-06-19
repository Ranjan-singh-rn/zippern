package com.zipper.app.ui.screens.auth

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.net.Uri
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.firebase.ml.modeldownloader.CustomModelDownloadConditions
import com.google.firebase.ml.modeldownloader.DownloadType
import com.google.firebase.ml.modeldownloader.FirebaseModelDownloader
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.zipper.app.ui.theme.*
import kotlinx.coroutines.tasks.await
import org.tensorflow.lite.Interpreter
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.abs

// ─── Liveness step state machine ────────────────────────────────────────────
private enum class LivenessStep(val instruction: String, val emoji: String) {
    LOOK("Look directly at the camera", "👁"),
    BLINK("Now BLINK slowly", "😑"),
    SMILE("Great! Now SMILE  😄", "😄"),
    CAPTURE("Hold still…", "📸"),
    PROCESSING("Verifying…", "⏳"),
}

@Composable
fun FaceVerificationScreen(
    declaredGender: String,
    onNavigateToMain: () -> Unit,
    onNavigateToLogin: () -> Unit,
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }

    var step by remember { mutableStateOf(LivenessStep.LOOK) }
    var attemptsLeft by remember { mutableIntStateOf(3 - uiState.faceVerificationAttempts) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var genderInterpreter by remember { mutableStateOf<Interpreter?>(null) }

    var imageCaptureUseCase by remember { mutableStateOf<ImageCapture?>(null) }
    var imageAnalysisUseCase by remember { mutableStateOf<ImageAnalysis?>(null) }

    // ML Kit detector (FAST mode + classification for eye/smile probabilities)
    val detector = remember {
        FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                .setMinFaceSize(0.2f)
                .build()
        )
    }

    // Download gender classifier model from Firebase ML (optional — skip if not uploaded yet)
    LaunchedEffect(Unit) {
        try {
            val conditions = CustomModelDownloadConditions.Builder().build()
            val model = FirebaseModelDownloader.getInstance()
                .getModel("gender_classifier", DownloadType.LOCAL_MODEL_UPDATE_IN_BACKGROUND, conditions)
                .await()
            model.file?.let { genderInterpreter = Interpreter(it) }
        } catch (_: Exception) { /* Model not yet uploaded to Firebase — gender check skipped */ }
    }

    // Navigation handlers
    LaunchedEffect(uiState.navigateToMain) {
        if (uiState.navigateToMain) { viewModel.onNavigatedToMain(); onNavigateToMain() }
    }
    LaunchedEffect(uiState.accountDeleted) {
        if (uiState.accountDeleted) { viewModel.onAccountDeleted(); onNavigateToLogin() }
    }

    // ── Liveness detection on live frames ────────────────────────────────────
    fun processFrame(face: Face) {
        when (step) {
            LivenessStep.LOOK -> {
                // Face centered and looking forward
                if (abs(face.headEulerAngleY) < 30f && abs(face.headEulerAngleX) < 20f) {
                    mainExecutor.execute { step = LivenessStep.BLINK; errorMsg = null }
                }
            }
            LivenessStep.BLINK -> {
                val left = face.leftEyeOpenProbability ?: 1f
                val right = face.rightEyeOpenProbability ?: 1f
                if (left < 0.2f || right < 0.2f) {
                    mainExecutor.execute { step = LivenessStep.SMILE; errorMsg = null }
                }
            }
            LivenessStep.SMILE -> {
                val smile = face.smilingProbability ?: 0f
                if (smile > 0.65f) {
                    mainExecutor.execute { step = LivenessStep.CAPTURE; errorMsg = null }
                }
            }
            else -> {}
        }
    }

    // ── Auto-capture when CAPTURE step is reached ─────────────────────────────
    LaunchedEffect(step) {
        if (step != LivenessStep.CAPTURE) return@LaunchedEffect
        val capture = imageCaptureUseCase ?: run { step = LivenessStep.BLINK; return@LaunchedEffect }
        step = LivenessStep.PROCESSING

        val photoFile = File(context.cacheDir, "fv_${System.currentTimeMillis()}.jpg")
        val output = ImageCapture.OutputFileOptions.Builder(photoFile).build()

        capture.takePicture(
            output,
            mainExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                    val uri = Uri.fromFile(photoFile)
                    val bitmap = BitmapFactory.decodeFile(photoFile.absolutePath)

                    // Gender check (runs only if model was downloaded)
                    val interpreter = genderInterpreter
                    if (interpreter != null && bitmap != null) {
                        val detectedGender = classifyGender(bitmap, interpreter)
                        val declared = declaredGender.lowercase()
                        val detected = detectedGender.lowercase()
                        val genderMatch = declared == detected ||
                            declared == "transgender" || detected == "transgender" ||
                            declared == "unknown"

                        if (!genderMatch) {
                            errorMsg = "Face does not match your declared gender ($declaredGender). " +
                                "Attempts remaining: ${attemptsLeft - 1}"
                            attemptsLeft--
                            step = LivenessStep.LOOK
                            viewModel.faceDetectionFailed()
                            return
                        }
                    }

                    // All checks passed — save & proceed
                    viewModel.saveFaceVerification(uri)
                }

                override fun onError(exc: ImageCaptureException) {
                    errorMsg = "Camera error. Please try again."
                    step = LivenessStep.LOOK
                }
            }
        )
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    val pulse = rememberInfiniteTransition(label = "pulse")
    val pulseScale by pulse.animateFloat(
        initialValue = 1f, targetValue = 1.05f,
        animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
        label = "scale",
    )
    val borderColor = when (step) {
        LivenessStep.LOOK       -> ZipperPurple
        LivenessStep.BLINK      -> ZipperPink
        LivenessStep.SMILE      -> ZipperGold
        LivenessStep.CAPTURE,
        LivenessStep.PROCESSING -> ZipperSuccess
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // Background glow
        Box(Modifier.size(260.dp).offset((-60).dp, (-40).dp)
            .blur(100.dp).background(ZipperPurple.copy(0.18f), CircleShape))
        Box(Modifier.size(200.dp).align(Alignment.BottomEnd).offset(60.dp, 60.dp)
            .blur(80.dp).background(ZipperPink.copy(0.15f), CircleShape))

        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(52.dp))

            Text(
                "Identity Check",
                fontSize = 24.sp, fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Quick liveness check to keep Zipper safe",
                color = MaterialTheme.colorScheme.onBackground.copy(0.5f),
                fontSize = 13.sp, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))

            // Attempt counter
            Text(
                "Attempts remaining: $attemptsLeft / 3",
                color = if (attemptsLeft <= 1) ZipperError
                        else MaterialTheme.colorScheme.onBackground.copy(0.35f),
                fontSize = 12.sp,
            )

            Spacer(Modifier.height(24.dp))

            // Step indicator chips
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LivenessStep.entries.take(3).forEach { s ->
                    val active  = s == step || step.ordinal > s.ordinal
                    val current = s == step
                    Box(
                        modifier = Modifier
                            .height(4.dp)
                            .width(if (current) 32.dp else 20.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(if (active) borderColor else MaterialTheme.colorScheme.onBackground.copy(0.15f)),
                    )
                }
            }

            Spacer(Modifier.height(20.dp))

            // Camera oval
            Box(
                modifier = Modifier.size(260.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size((260 * pulseScale).dp)
                        .border(
                            3.dp,
                            Brush.sweepGradient(listOf(borderColor, borderColor.copy(0.3f), borderColor)),
                            CircleShape,
                        ),
                )
                Box(
                    modifier = Modifier.size(240.dp).clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surface),
                ) {
                    val previewView = remember { PreviewView(context) }
                    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

                    LaunchedEffect(Unit) {
                        val providerFuture = ProcessCameraProvider.getInstance(context)
                        providerFuture.addListener({
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build()
                                .also { it.setSurfaceProvider(previewView.surfaceProvider) }

                            val imgCapture = ImageCapture.Builder()
                                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                                .build()
                            imageCaptureUseCase = imgCapture

                            val imgAnalysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            imgAnalysis.setAnalyzer(cameraExecutor) { proxy ->
                                val mediaImg = proxy.image
                                if (mediaImg != null && step != LivenessStep.CAPTURE && step != LivenessStep.PROCESSING) {
                                    val inputImg = InputImage.fromMediaImage(mediaImg, proxy.imageInfo.rotationDegrees)
                                    detector.process(inputImg)
                                        .addOnSuccessListener { faces ->
                                            faces.firstOrNull()?.let { processFrame(it) }
                                        }
                                        .addOnCompleteListener { proxy.close() }
                                } else {
                                    proxy.close()
                                }
                            }
                            imageAnalysisUseCase = imgAnalysis

                            try {
                                provider.unbindAll()
                                provider.bindToLifecycle(
                                    lifecycleOwner,
                                    CameraSelector.DEFAULT_FRONT_CAMERA,
                                    preview, imgCapture, imgAnalysis,
                                )
                            } catch (_: Exception) { }
                        }, mainExecutor)
                    }
                }

                // Processing overlay
                if (step == LivenessStep.PROCESSING || uiState.isLoading) {
                    Box(
                        modifier = Modifier.size(240.dp).clip(CircleShape)
                            .background(androidx.compose.ui.graphics.Color(0x88000000)),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = ZipperPink, modifier = Modifier.size(40.dp))
                    }
                }
            }

            Spacer(Modifier.height(24.dp))

            // Instruction card
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(borderColor.copy(0.1f))
                    .padding(horizontal = 20.dp, vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(step.emoji, fontSize = 28.sp)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        step.instruction,
                        color = MaterialTheme.colorScheme.onBackground,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            // Error message
            errorMsg?.let { err ->
                Spacer(Modifier.height(12.dp))
                Text(err, color = ZipperError, fontSize = 13.sp, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.height(16.dp))
            Text(
                "Your selfie is encrypted and stored securely.",
                color = MaterialTheme.colorScheme.onBackground.copy(0.3f),
                fontSize = 11.sp, textAlign = TextAlign.Center,
            )
        }
    }
}

// ── Gender classifier (TFLite) ────────────────────────────────────────────────
// Model expects: [1, 224, 224, 3] float32 input (RGB normalized 0..1)
// Model outputs: [1, 3] softmax → [male, female, transgender]
// Upload model named "gender_classifier" to Firebase ML console to enable.
private fun classifyGender(bitmap: Bitmap, interpreter: Interpreter): String {
    val size = 224
    val scaled = Bitmap.createScaledBitmap(bitmap, size, size, true)
    val input = Array(1) { Array(size) { Array(size) { FloatArray(3) } } }
    for (y in 0 until size) {
        for (x in 0 until size) {
            val pixel = scaled.getPixel(x, y)
            input[0][y][x][0] = Color.red(pixel) / 255f
            input[0][y][x][1] = Color.green(pixel) / 255f
            input[0][y][x][2] = Color.blue(pixel) / 255f
        }
    }
    val output = Array(1) { FloatArray(3) }
    interpreter.run(input, output)
    return when (output[0].indices.maxByOrNull { output[0][it] } ?: 0) {
        0    -> "male"
        1    -> "female"
        else -> "transgender"
    }
}
