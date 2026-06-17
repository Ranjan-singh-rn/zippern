package com.zipper.app.ui.screens.auth

import android.app.Activity
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.zipper.app.R
import com.zipper.app.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    onNavigateToOtp: (phone: String) -> Unit,
    onNavigateToProfileSetup: () -> Unit,
    onNavigateToMain: () -> Unit,
    onNavigateToTerms: () -> Unit,
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var phone by remember { mutableStateOf("") }
    var termsAccepted by remember { mutableStateOf(false) }

    // Pulsing logo animation
    val pulse = rememberInfiniteTransition(label = "pulse")
    val pulseScale by pulse.animateFloat(
        initialValue = 1f, targetValue = 1.08f,
        animationSpec = infiniteRepeatable(tween(1200, easing = EaseInOutSine), RepeatMode.Reverse),
        label = "scale",
    )

    val credentialManager = remember { CredentialManager.create(context) }

    fun launchGoogleSignIn() {
        if (!termsAccepted) return
        scope.launch {
            try {
                val googleIdOption = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(context.getString(R.string.default_web_client_id))
                    .setAutoSelectEnabled(false)
                    .build()
                val request = GetCredentialRequest.Builder()
                    .addCredentialOption(googleIdOption)
                    .build()
                val result = credentialManager.getCredential(context as Activity, request)
                val credential = result.credential
                if (credential is CustomCredential &&
                    credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                ) {
                    val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
                    viewModel.signInWithGoogle(token)
                }
            } catch (e: GetCredentialException) {
                // user cancelled or no accounts
            }
        }
    }

    // Navigation
    LaunchedEffect(uiState.navigateToOtp) {
        if (uiState.navigateToOtp) { viewModel.onNavigatedToOtp(); onNavigateToOtp(phone) }
    }
    LaunchedEffect(uiState.navigateToProfileSetup) {
        if (uiState.navigateToProfileSetup) { viewModel.onNavigatedToProfileSetup(); onNavigateToProfileSetup() }
    }
    LaunchedEffect(uiState.navigateToMain) {
        if (uiState.navigateToMain) { viewModel.onNavigatedToMain(); onNavigateToMain() }
    }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {

        // ── Background glow orbs ──────────────────────────────────────────
        Box(
            modifier = Modifier
                .size(320.dp)
                .offset(x = (-80).dp, y = (-60).dp)
                .blur(120.dp)
                .background(ZipperPink.copy(alpha = 0.25f), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(280.dp)
                .align(Alignment.TopEnd)
                .offset(x = 80.dp, y = 40.dp)
                .blur(100.dp)
                .background(ZipperPurple.copy(alpha = 0.22f), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(200.dp)
                .align(Alignment.BottomStart)
                .offset(x = (-40).dp, y = 60.dp)
                .blur(80.dp)
                .background(ZipperPink.copy(alpha = 0.15f), CircleShape),
        )

        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(72.dp))

            // ── Logo ──────────────────────────────────────────────────────
            Box(contentAlignment = Alignment.Center) {
                // Outer glow ring
                Box(
                    modifier = Modifier
                        .scale(pulseScale)
                        .size(110.dp)
                        .background(
                            Brush.radialGradient(
                                listOf(ZipperPink.copy(0.35f), Color.Transparent),
                            ),
                            CircleShape,
                        ),
                )
                // Inner logo circle
                Box(
                    modifier = Modifier
                        .size(80.dp)
                        .background(
                            Brush.linearGradient(listOf(ZipperPink, ZipperPurple)),
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("⚡", fontSize = 38.sp)
                }
            }
            Spacer(Modifier.height(18.dp))
            Text(
                "ZIPPER",
                fontSize = 34.sp,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onBackground,
                letterSpacing = 8.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Live. Connect. Shine.",
                fontSize = 13.sp,
                color = ZipperGold,
                letterSpacing = 3.sp,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(48.dp))

            // ── Phone input card ──────────────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(MaterialTheme.colorScheme.onBackground.copy(0.06f))
                    .border(
                        1.dp,
                        if (phone.isNotEmpty()) ZipperPink.copy(0.6f) else MaterialTheme.colorScheme.onBackground.copy(0.1f),
                        RoundedCornerShape(16.dp),
                    )
                    .padding(horizontal = 16.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "+91",
                        color = ZipperPink,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Box(
                        modifier = Modifier
                            .width(1.dp)
                            .height(24.dp)
                            .padding(horizontal = 8.dp)
                            .background(MaterialTheme.colorScheme.onBackground.copy(0.15f)),
                    )
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        value = phone,
                        onValueChange = { if (it.length <= 10 && it.all(Char::isDigit)) phone = it },
                        placeholder = { Text("Phone number", color = MaterialTheme.colorScheme.onBackground.copy(0.3f), fontSize = 15.sp) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color.Transparent,
                            unfocusedBorderColor = Color.Transparent,
                            focusedTextColor = MaterialTheme.colorScheme.onBackground,
                            unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                            cursorColor = ZipperPink,
                        ),
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // ── Get OTP button (gradient) ─────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(
                        if (phone.length == 10 && termsAccepted)
                            Brush.horizontalGradient(listOf(ZipperPink, ZipperPurple))
                        else
                            Brush.horizontalGradient(listOf(MaterialTheme.colorScheme.onBackground.copy(0.1f), MaterialTheme.colorScheme.onBackground.copy(0.1f))),
                    )
                    .clickable(enabled = phone.length == 10 && termsAccepted && !uiState.isLoading) {
                        viewModel.sendOtp("+91$phone", context as Activity)
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (uiState.isLoading) {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                } else {
                    Text(
                        "Get OTP",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (phone.length == 10 && termsAccepted) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onBackground.copy(0.3f),
                        letterSpacing = 1.sp,
                    )
                }
            }

            Spacer(Modifier.height(24.dp))

            // ── OR divider ────────────────────────────────────────────────
            Row(verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onBackground.copy(0.1f))
                Text("  OR  ", color = MaterialTheme.colorScheme.onBackground.copy(0.35f), fontSize = 12.sp)
                HorizontalDivider(modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onBackground.copy(0.1f))
            }

            Spacer(Modifier.height(20.dp))

            // ── Google button ─────────────────────────────────────────────
            SocialButton(
                icon = "🇬",
                label = "Continue with Google",
                enabled = termsAccepted && !uiState.isLoading,
                onClick = { launchGoogleSignIn() },
            )

            Spacer(Modifier.height(12.dp))

            // ── Guest button ──────────────────────────────────────────────
            SocialButton(
                icon = "👤",
                label = "Continue as Guest",
                enabled = termsAccepted && !uiState.isLoading,
                onClick = { viewModel.signInAsGuest() },
            )

            Spacer(Modifier.height(24.dp))

            // ── T&C checkbox ──────────────────────────────────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.onBackground.copy(0.04f))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    checked = termsAccepted,
                    onCheckedChange = { termsAccepted = it },
                    colors = CheckboxDefaults.colors(
                        checkedColor = ZipperPink,
                        uncheckedColor = MaterialTheme.colorScheme.onBackground.copy(0.4f),
                        checkmarkColor = MaterialTheme.colorScheme.onBackground,
                    ),
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.onBackground.copy(0.65f), fontSize = 13.sp)) {
                            append("I agree to the ")
                        }
                        withStyle(SpanStyle(color = ZipperPink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)) {
                            append("Terms & Conditions")
                        }
                    },
                    modifier = Modifier.clickable { onNavigateToTerms() },
                )
            }

            Spacer(Modifier.weight(1f))
            Text(
                "By continuing you confirm you're 18+",
                color = MaterialTheme.colorScheme.onBackground.copy(0.25f),
                fontSize = 11.sp,
            )
            Spacer(Modifier.height(24.dp))
        }

        // Error snackbar
        uiState.error?.let { err ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                action = { TextButton(onClick = { viewModel.clearError() }) { Text("OK") } },
                containerColor = MaterialTheme.colorScheme.surface,
            ) { Text(err, color = MaterialTheme.colorScheme.onSurface) }
        }
    }
}

@Composable
private fun SocialButton(
    icon: String,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.onBackground.copy(0.06f))
            .border(1.dp, MaterialTheme.colorScheme.onBackground.copy(if (enabled) 0.18f else 0.07f), RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Text(icon, fontSize = 18.sp)
            Spacer(Modifier.width(10.dp))
            Text(
                label,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = if (enabled) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onBackground.copy(0.3f),
            )
        }
    }
}
