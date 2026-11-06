package com.zipper.app.ui.screens.auth

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.net.Uri
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.google.accompanist.permissions.shouldShowRationale
import com.google.firebase.ml.modeldownloader.CustomModelDownloadConditions
import com.google.firebase.ml.modeldownloader.DownloadType
import com.google.firebase.ml.modeldownloader.FirebaseModelDownloader
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.tasks.await
import org.tensorflow.lite.Interpreter
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.abs

/*
 * Host identity check — liveness (look · blink · smile) on the front camera,
 * then an auto-capture that is matched against the profile photo server-side.
 *
 *   TopBar "Verify your identity". Instruction glass card with the three
 *   steps (done = mint check, current = brand disc, upcoming = raised disc).
 *   Circular 240 preview inside a brand-gradient ring that pulses. Capture
 *   gradient CTA, retry Secondary button on error, attempt counter caption,
 *   DPDP biometric note.
 */

// ─── Liveness step state machine ────────────────────────────────────────────
private enum class LivenessStep(val instruction: String, val emoji: String) {
    LOOK("Look directly at the camera", "👁"),
    BLINK("Now BLINK slowly", "😑"),
    SMILE("Great! Now SMILE  😄", "😄"),
    CAPTURE("Hold still…", "📸"),
    PROCESSING("Verifying…", "⏳"),
}

private const val DPDP_NOTE = "Your face image is biometric data. It is used only to confirm you are the person in your profile photo and is reviewed by Zipper staff."

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun FaceVerificationScreen(
    declaredGender: String,
    onNavigateToMain: () -> Unit,
    onNavigateToLogin: () -> Unit,
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val c = ZipperTheme.colors

    // ── Camera permission gate ────────────────────────────────────────────────
    val cameraPermission = rememberPermissionState(android.Manifest.permission.CAMERA)

    // Request as soon as the screen opens — user sees the dialog immediately
    LaunchedEffect(Unit) {
        if (!cameraPermission.status.isGranted) {
            cameraPermission.launchPermissionRequest()
        }
    }

    /*
     * THE WAY OUT.
     *
     * This screen is now reached automatically the moment somebody redeems a
     * referral code, and it is also the only screen in the app that cannot
     * function without a hardware permission. Without an exit, a host who
     * declines the camera — or taps it by mistake, or has no light — is held on
     * a rationale card with one button that reopens a dialog they have already
     * said no to. They would have to kill the app, and they would land back
     * here on the next launch.
     *
     * So the capture is skippable, and skipping is honest about its price: the
     * badge stays pending, `isVerifiedHost` stays false, and everything it
     * gates stays shut until they come back through Me → Verify your face.
     * Nothing is lost by leaving — beans still accrue, they are simply held.
     */
    if (!cameraPermission.status.isGranted) {
        // Rationale / settings nudge while waiting for the user to grant
        ZipperScreen(
            topBar = {
                TopBar(
                    "Verify your identity",
                    actions = {
                        TextButton(onClick = onNavigateToMain) {
                            Text("Later", style = ZipperTheme.type.labelM, color = c.textSecondary)
                        }
                    },
                )
            },
        ) { _ ->
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                if (cameraPermission.status.shouldShowRationale) {
                    // User denied once — show request button again
                    EmptyState(
                        Icons.Outlined.CameraAlt, "Allow camera access",
                        "Zipper needs the camera for a quick liveness check. Your selfie is only used for verification.",
                        actionLabel = "Allow camera", onAction = { cameraPermission.launchPermissionRequest() },
                    )
                } else {
                    // Permanently denied — send to Settings
                    EmptyState(
                        Icons.Outlined.CameraAlt, "Camera is turned off",
                        "Turn on camera access for Zipper in Settings to continue with verification.",
                        actionLabel = "Open Settings",
                        onAction = {
                            val intent = android.content.Intent(
                                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", context.packageName, null)
                            )
                            context.startActivity(intent)
                        },
                    )
                }
                Text(DPDP_NOTE, style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = Space.x3l))
            }
        }
        return   // Don't render the camera UI until permission is granted
    }

    // Permission granted — proceed with the camera
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

                    // All checks passed — save & proceed.
                    // 7 Nov 2026 ("host face verification not working"): the camera saves a full-resolution photo,
                    // 4–8 MB on most current phones, and storage.rules accepts at most 4 MB at
                    // hostVerification/{uid}/capture.jpg — so the upload was refused and verification never started.
                    // The photo is scaled to 1280 px on its long side and saved at JPEG 85 (a few hundred KB) first.
                    val upload = runCatching {
                        val raw = bitmap ?: return@runCatching uri
                        // Keep the photo upright: re-encoding drops the EXIF rotation the camera wrote.
                        val deg = when (android.media.ExifInterface(photoFile.absolutePath).getAttributeInt(
                            android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL)) {
                            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                            else -> 0f
                        }
                        val b = if (deg == 0f) raw else android.graphics.Bitmap.createBitmap(
                            raw, 0, 0, raw.width, raw.height, android.graphics.Matrix().apply { postRotate(deg) }, true)
                        val scale = 1280f / maxOf(b.width, b.height)
                        val small = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(
                            b, (b.width * scale).toInt(), (b.height * scale).toInt(), true) else b
                        val out = File(context.cacheDir, "fv_upload_${System.currentTimeMillis()}.jpg")
                        out.outputStream().use { small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, it) }
                        Uri.fromFile(out)
                    }.getOrDefault(uri)
                    viewModel.submitHostCapture(upload)
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
    val busy = step == LivenessStep.CAPTURE || step == LivenessStep.PROCESSING || uiState.isLoading
    val ringBrush = if (busy) Brush.sweepGradient(listOf(c.statusSuccess, c.statusSuccess.copy(0.3f), c.statusSuccess))
                    else Brush.sweepGradient(listOf(c.brandGradientFrom, c.brandGradientTo, c.brandGradientFrom))

    ZipperScreen(
        topBar = {
            TopBar(
                "Verify your identity",
                // The same exit as the permission gate above. A host who cannot
                // do this right now leaves with their status intact and pending,
                // rather than force-quitting the app.
                actions = {
                    TextButton(onClick = onNavigateToMain) {
                        Text("Later", style = ZipperTheme.type.labelM, color = c.textSecondary)
                    }
                },
            )
        },
    ) { _ ->
        Box(Modifier.fillMaxSize()) {
            AmbientGlows()
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Space.xl),
            ) {
                // Instruction card — three short steps
                GlassCard {
                    Text("Quick liveness check", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    LivenessStep.entries.take(3).forEachIndexed { i, s ->
                        val done = step.ordinal > s.ordinal
                        val current = s == step
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Box(
                                Modifier.size(24.dp).then(
                                    when {
                                        done -> Modifier.background(c.tintSuccessSubtle, CircleShape).border(1.dp, c.statusSuccess, CircleShape)
                                        current -> Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                                        else -> Modifier.background(c.bgRaised, CircleShape).border(1.dp, c.borderSubtle, CircleShape)
                                    }
                                ),
                                contentAlignment = Alignment.Center,
                            ) {
                                // `textOnBrand` rather than `Color.White`: the
                                // number is only white because the CURRENT step's
                                // disc is filled with the brand gradient. Saying
                                // that in the token keeps the pair together — the
                                // fill above and this foreground are one decision.
                                if (done) Icon(Icons.Default.Check, null, tint = c.statusSuccess, modifier = Modifier.size(14.dp))
                                else Text("${i + 1}", style = ZipperTheme.type.overline, color = if (current) c.textOnBrand else c.textMuted)
                            }
                            Text(
                                when (s) { LivenessStep.LOOK -> "Look straight at the camera"; LivenessStep.BLINK -> "Blink slowly"; else -> "Smile" },
                                style = if (current) ZipperTheme.type.labelM else ZipperTheme.type.bodyM,
                                color = if (current) c.textPrimary else c.textSecondary,
                            )
                        }
                    }
                }

                // Camera ring
                Box(Modifier.size(260.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.size((260 * pulseScale).dp).border(3.dp, ringBrush, CircleShape))
                    Box(Modifier.size(240.dp).clip(CircleShape).background(c.bgElevated)) {
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
                                    val mediaImg = proxy.mediaImageForMlKit()
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
                        Box(Modifier.size(240.dp).clip(CircleShape).background(c.scrimStrong), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 3.dp, modifier = Modifier.size(40.dp))
                        }
                    }
                }

                // Current step + attempts
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text(step.instruction, style = ZipperTheme.type.headingS, color = c.textPrimary, textAlign = TextAlign.Center)
                    Text(
                        "Attempts remaining: $attemptsLeft / 3",
                        style = ZipperTheme.type.caption, color = if (attemptsLeft <= 1) c.statusDanger else c.textMuted,
                    )
                }

                // Error state
                errorMsg?.let { err ->
                    Column(
                        Modifier.fillMaxWidth().background(c.tintDangerSubtle, RoundedCornerShape(Radius.lg)).border(1.dp, c.statusDanger, RoundedCornerShape(Radius.lg)).padding(Space.lg),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Icon(Icons.Outlined.ErrorOutline, null, tint = c.statusDanger, modifier = Modifier.size(24.dp))
                        Text("Check failed", style = ZipperTheme.type.headingS, color = c.textPrimary, textAlign = TextAlign.Center)
                        Text(err, style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center)
                        ZipperButton("Retry", onClick = { errorMsg = null; step = LivenessStep.LOOK }, style = ButtonStyle.Secondary, size = ButtonSize.Medium)
                    }
                }

                // Capture: the liveness flow auto-captures on smile; this is the
                // manual fallback once look + blink have passed.
                ZipperButton(
                    if (busy) "Verifying…" else "Capture",
                    onClick = { if (step == LivenessStep.SMILE) step = LivenessStep.CAPTURE },
                    gradient = true, fullWidth = true,
                    enabled = step == LivenessStep.SMILE, loading = busy,
                )

                Text(DPDP_NOTE, style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center)
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

/**
 * The camera frame as the `media.Image` ML Kit reads.
 *
 * CameraX marks `ImageProxy.getImage()` `@ExperimentalGetImage`. The opt-in covers this one read and nothing
 * else (lint UnsafeOptInUsageError) — the usage CameraX and ML Kit document. The caller still owns the proxy
 * and closes it.
 */
@androidx.annotation.OptIn(ExperimentalGetImage::class)
private fun ImageProxy.mediaImageForMlKit(): android.media.Image? = image

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
            input[0][y][x][0] = AndroidColor.red(pixel) / 255f
            input[0][y][x][1] = AndroidColor.green(pixel) / 255f
            input[0][y][x][2] = AndroidColor.blue(pixel) / 255f
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
