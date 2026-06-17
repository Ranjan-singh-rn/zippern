package com.zipper.app.ui.screens.auth

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.ui.theme.ZipperGold
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
    val scale = remember { Animatable(0.5f) }
    LaunchedEffect(Unit) {
        scale.animateTo(1f, animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy))
        delay(800)

        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            onNavigateToLogin()
            return@LaunchedEffect
        }

        // Re-authenticate anonymous/token state — handle stale token gracefully
        try {
            user.reload().await()
        } catch (e: Exception) {
            // Token invalid or network issue — send to login
            FirebaseAuth.getInstance().signOut()
            onNavigateToLogin()
            return@LaunchedEffect
        }

        try {
            val snap = FirebaseFirestore.getInstance()
                .collection("users").document(user.uid).get().await()
            if (!snap.exists()) {
                // Auth user exists but no Firestore doc — partial state, go to profile setup
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
            // Firestore error (offline, permission) — if auth exists, try to continue
            onNavigateToMain()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            // Logo circle
            Box(
                modifier = Modifier
                    .scale(scale.value)
                    .size(100.dp)
                    .background(ZipperPink.copy(alpha = 0.15f), shape = CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("⚡", fontSize = 48.sp)
            }
            Spacer(Modifier.height(20.dp))
            Text(
                "ZIPPER",
                fontSize = 36.sp,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onBackground,
                letterSpacing = 6.sp,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Live. Connect. Shine.",
                fontSize = 14.sp,
                color = ZipperGold,
                letterSpacing = 2.sp,
            )
            Spacer(Modifier.height(48.dp))
            CircularProgressIndicator(
                color = ZipperPink,
                strokeWidth = 2.dp,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}
