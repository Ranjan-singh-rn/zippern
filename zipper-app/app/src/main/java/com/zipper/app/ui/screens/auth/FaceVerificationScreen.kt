package com.zipper.app.ui.screens.auth

import android.content.Context
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
import androidx.compose.ui.graphics.Color
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
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.zipper.app.ui.theme.*
import java.io.File
import java.util.concurrent.Executors

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

    var isCapturing by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf("Position your face inside the circle") }
    var statusSuccess by remember { mutableStateOf<Boolean?>(null) }

    var imageCaptureUseCase by remember { mutableStateOf<ImageCapture?>(null) }

    val attemptsLeft = 3 - uiState.faceVerificationAttempts

    // Pulse animation for the face guide circle
    val pulse = rememberInfiniteTransition(label = "pulse")
    val pulseScale by pulse.animateFloat(
        initialValue = 1f, targetValue = 1.04f,
        animationSpec = infiniteRepeatable(tween(1000), RepeatMode.Reverse),
        label = "scale",
    )

    LaunchedEffect(uiState.navigateToMain) {
        if (uiState.navigateToMain) { viewModel.onNavigatedToMain(); onNavigateToMain() }
    }
    LaunchedEffect(uiState.accountDeleted) {
        if (uiState.accountDeleted) { viewModel.onAccountDeleted(); onNavigateToLogin() }
    }

    fun captureAndVerify() {
        val imageCapture = imageCaptureUseCase ?: return
        isCapturing = true
        statusMessage = "Analyzing…"

        val photoFile = File(context.cacheDir, "face_verify_${System.currentTimeMillis()}.jpg")
        val outputOptions = ImageCapture.OutputFileOptions.Builder(photoFile).build()

        imageCapture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    val uri = Uri.fromFile(photoFile)
                    detectFace(context, uri,
                        onFaceDetected = {
                            viewModel.saveFaceVerification(uri)
                            statusSuccess = true
                            statusMessage = "Face verified! ✓"
                            isCapturing = false
                        },
                        onNoFace = {
                            statusSuccess = false
                            statusMessage = "No face detected. Please look at the camera."
                            isCapturing = false
                            viewModel.faceDetectionFailed()
                        }
                    )
                }
                override fun onError(exc: ImageCaptureException) {
                    statusSuccess = false
                    statusMessage = "Camera error: ${exc.message}"
                    isCapturing = false
                }
            }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // Background orbs
        Box(
            modifier = Modifier.size(280.dp).offset((-60).dp, (-40).dp)
                .blur(100.dp).background(ZipperPurple.copy(0.18f), CircleShape),
        )
        Box(
            modifier = Modifier.size(220.dp).align(Alignment.BottomEnd).offset(60.dp, 60.dp)
                .blur(80.dp).background(ZipperPink.copy(0.15f), CircleShape),
        )

        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(56.dp))
            Text(
                "Face Verification",
                fontSize = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Verify your identity to continue",
                color = MaterialTheme.colorScheme.onBackground.copy(0.5f),
                fontSize = 14.sp,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Attempts remaining: $attemptsLeft / 3",
                color = if (attemptsLeft <= 1) ZipperError else MaterialTheme.colorScheme.onBackground.copy(0.4f),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(28.dp))

            // Camera preview inside oval guide
            Box(
                modifier = Modifier.size(260.dp),
                contentAlignment = Alignment.Center,
            ) {
                // Pulsing guide ring
                Box(
                    modifier = Modifier
                        .size((260 * pulseScale).dp)
                        .border(
                            2.dp,
                            Brush.sweepGradient(listOf(ZipperPink, ZipperPurple, ZipperPink)),
                            CircleShape,
                        ),
                )
                // Camera preview
                Box(
                    modifier = Modifier
                        .size(240.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surface),
                ) {
                    val previewView = remember { PreviewView(context) }
                    AndroidView(
                        factory = { previewView },
                        modifier = Modifier.fillMaxSize(),
                    )
                    LaunchedEffect(Unit) {
                        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
                        cameraProviderFuture.addListener({
                            val cameraProvider = cameraProviderFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.setSurfaceProvider(previewView.surfaceProvider)
                            }
                            val imageCapture = ImageCapture.Builder()
                                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                                .build()
                            imageCaptureUseCase = imageCapture
                            try {
                                cameraProvider.unbindAll()
                                cameraProvider.bindToLifecycle(
                                    lifecycleOwner,
                                    CameraSelector.DEFAULT_FRONT_CAMERA,
                                    preview,
                                    imageCapture,
                                )
                            } catch (e: Exception) {
                                statusMessage = "Camera unavailable"
                            }
                        }, ContextCompat.getMainExecutor(context))
                    }
                }
            }

            Spacer(Modifier.height(24.dp))

            // Status message
            Text(
                text = statusMessage,
                color = when (statusSuccess) {
                    true  -> ZipperSuccess
                    false -> ZipperError
                    null  -> MaterialTheme.colorScheme.onBackground.copy(0.65f)
                },
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(28.dp))

            // Verify button
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(
                        if (!isCapturing && !uiState.isLoading)
                            Brush.horizontalGradient(listOf(ZipperPink, ZipperPurple))
                        else
                            Brush.horizontalGradient(listOf(Color.White.copy(0.12f), Color.White.copy(0.12f))),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (isCapturing || uiState.isLoading) {
                    CircularProgressIndicator(color = ZipperPink, modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                } else {
                    TextButton(
                        onClick = { captureAndVerify() },
                        enabled = !isCapturing && !uiState.isLoading,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        Text(
                            "Verify My Face",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            letterSpacing = 1.sp,
                        )
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(
                "Your selfie is securely stored and reviewed to confirm identity.",
                color = MaterialTheme.colorScheme.onBackground.copy(0.35f),
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun detectFace(
    context: Context,
    uri: Uri,
    onFaceDetected: () -> Unit,
    onNoFace: () -> Unit,
) {
    val options = FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
        .setMinFaceSize(0.15f)
        .build()
    val detector = FaceDetection.getClient(options)
    try {
        val image = InputImage.fromFilePath(context, uri)
        detector.process(image)
            .addOnSuccessListener { faces ->
                if (faces.isNotEmpty()) onFaceDetected() else onNoFace()
            }
            .addOnFailureListener { onNoFace() }
    } catch (e: Exception) {
        onNoFace()
    }
}
