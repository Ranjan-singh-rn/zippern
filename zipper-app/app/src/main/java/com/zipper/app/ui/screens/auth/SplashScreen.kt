package com.zipper.app.ui.screens.auth

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.R
import com.zipper.app.ui.theme.ZipperPink
import kotlinx.coroutines.delay
import kotlinx.coroutines.tasks.await

@Composable
fun SplashScreen(
    onNavigateToLogin: () -> Unit,
    onNavigateToProfileSetup: () -> Unit,
    onNavigateToFaceVerification: () -> Unit,
    onNavigateToMain: () -> Unit,
) {
    val scale = remember { Animatable(0.6f) }

    LaunchedEffect(Unit) {
        scale.animateTo(1f, animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy))
        delay(800)

        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            onNavigateToLogin()
            return@LaunchedEffect
        }

        try {
            user.reload().await()
        } catch (e: Exception) {
            FirebaseAuth.getInstance().signOut()
            onNavigateToLogin()
            return@LaunchedEffect
        }

        try {
            val snap = FirebaseFirestore.getInstance()
                .collection("users").document(user.uid).get().await()
            if (!snap.exists()) {
                onNavigateToProfileSetup()
                return@LaunchedEffect
            }
            val profileComplete = snap.getBoolean("isProfileComplete") ?: false
            val faceVerified = snap.getBoolean("isFaceVerified") ?: false
            when {
                !profileComplete -> onNavigateToProfileSetup()
                !faceVerified   -> onNavigateToFaceVerification()
                else            -> onNavigateToMain()
            }
        } catch (e: Exception) {
            onNavigateToMain()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        // Full-screen splash background
        AsyncImage(
            model = R.drawable.splash_background,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )

        // Bouncing logo in center
        AsyncImage(
            model = R.drawable.ic_app_logo,
            contentDescription = "Zipper",
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(160.dp)
                .scale(scale.value)
                .clip(CircleShape)
                .align(Alignment.Center),
        )

        // Loading indicator at bottom
        CircularProgressIndicator(
            color = ZipperPink,
            strokeWidth = 2.dp,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 48.dp)
                .size(28.dp),
        )
    }
}
