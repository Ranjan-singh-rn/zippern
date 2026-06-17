package com.zipper.datingapp.ui.screens

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.R
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppContainerHi
import com.zipper.datingapp.ui.theme.AppWindowWidthClass
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.AppSurfaceVar
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextSecondary
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException

private val brandGradient = Brush.horizontalGradient(listOf(BrandPink, BrandPurple))
private val cardShape = RoundedCornerShape(24.dp)
private val buttonShape = RoundedCornerShape(14.dp)
private val fieldShape = RoundedCornerShape(14.dp)

/** Full-width button with a pink→purple gradient background. */
@Composable
private fun GradientButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = buttonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
        ),
        contentPadding = PaddingValues(0.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .background(
                    brush = if (enabled) brandGradient else Brush.horizontalGradient(
                        listOf(BrandPink.copy(alpha = 0.38f), BrandPurple.copy(alpha = 0.38f))
                    ),
                    shape = buttonShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
                content = content,
            )
        }
    }
}

@Composable
fun LoginScreen(
    uiState: DatingUiState,
    onSendOtp: (String, Activity) -> Unit,
    onVerifyOtp: (String) -> Unit,
    onGoogleSignIn: (String) -> Unit,
    onGoogleSignInFailure: (Throwable) -> Unit,
    onSelectGender: (String) -> Unit,
    onSetReferralCode: (String) -> Unit,
    onGuestLogin: () -> Unit,
    onUseAnotherAccount: () -> Unit,
    onBackToOptions: () -> Unit
) {
    var phoneNumber by remember { mutableStateOf("") }
    var otpCode by remember { mutableStateOf("") }
    var showPhoneInput by remember { mutableStateOf(false) }
    var referralInput by remember { mutableStateOf(uiState.registrationReferralCode) }

    BackHandler(enabled = uiState.isOtpSent || showPhoneInput) {
        if (uiState.isOtpSent) {
            onBackToOptions()
        } else {
            showPhoneInput = false
            phoneNumber = ""
        }
    }

    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val webClientId = stringResource(R.string.default_web_client_id)

    val googleSignInLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
            try {
                val account = task.getResult(ApiException::class.java)
                account.idToken?.let { onGoogleSignIn(it) }
                    ?: onGoogleSignInFailure(IllegalStateException("Google sign-in did not return an ID token."))
            } catch (e: ApiException) {
                Log.e("LoginScreen", "Google sign in failed status=${e.statusCode}", e)
                onGoogleSignInFailure(e)
            }
        } else {
            onGoogleSignInFailure(IllegalStateException("Google sign-in was cancelled or could not start."))
        }
    }

    val startGoogleSignIn = {
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(webClientId)
            .requestEmail()
            .build()
        val act = activity
        if (act == null) {
            Log.e("LoginScreen", "Google Sign-In: no Activity context")
        } else {
            val googleSignInClient = GoogleSignIn.getClient(act, gso)
            googleSignInClient.signOut().addOnCompleteListener {
                googleSignInLauncher.launch(googleSignInClient.signInIntent)
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                brush = Brush.verticalGradient(
                    colors = listOf(AppBackground, AppContainerHi)
                )
            )
    ) {
        if (uiState.isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center),
                color = BrandPink,
                strokeWidth = 3.dp,
            )
        }

        val loginWidthClass = LocalWindowWidthClass.current
        val loginHPad = if (loginWidthClass == AppWindowWidthClass.Compact) 24.dp else 48.dp
        Column(
            modifier = Modifier
                .widthIn(max = 520.dp)
                .fillMaxHeight()
                .padding(horizontal = loginHPad, vertical = 16.dp)
                .verticalScroll(rememberScrollState())
                .align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Image(
                painter = painterResource(id = R.drawable.zipper_logo),
                contentDescription = "Zipper Logo",
                modifier = Modifier
                    .size(180.dp)
                    .clip(CircleShape),
                contentScale = ContentScale.Crop
            )

            Spacer(modifier = Modifier.height(40.dp))

            // ── Auth card ─────────────────────────────────────────────────────
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, OutlineDefault, cardShape),
                shape = cardShape,
                color = AppSurfaceVar,
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    uiState.loginError?.takeIf { it.isNotBlank() }?.let { err ->
                        Surface(
                            color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.25f),
                            shape = RoundedCornerShape(10.dp),
                        ) {
                            Text(
                                text = err,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp, vertical = 8.dp)
                            )
                        }
                        Spacer(modifier = Modifier.height(16.dp))
                    }

                    if (!uiState.isOtpSent) {
                        Text(
                            text = "Welcome to Zipper",
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Connect, stream, and belong",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                        )
                        Spacer(modifier = Modifier.height(24.dp))

                        // Gender selection
                        Text(
                            text = "I am a…",
                            color = TextSecondary,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            FilterChip(
                                modifier = Modifier.weight(1f),
                                selected = uiState.registrationGender == "male",
                                onClick = { onSelectGender("male") },
                                label = {
                                    Text(
                                        "Male",
                                        modifier = Modifier.fillMaxWidth(),
                                        textAlign = TextAlign.Center,
                                    )
                                },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = BrandPurple.copy(alpha = 0.20f),
                                    selectedLabelColor = Color.White,
                                    containerColor = OutlineDefault.copy(alpha = 0.5f),
                                    labelColor = TextSecondary,
                                ),
                                border = FilterChipDefaults.filterChipBorder(
                                    enabled = true,
                                    selected = uiState.registrationGender == "male",
                                    borderColor = OutlineDefault,
                                    selectedBorderColor = BrandPurple.copy(alpha = 0.5f),
                                )
                            )
                            FilterChip(
                                modifier = Modifier.weight(1f),
                                selected = uiState.registrationGender == "female",
                                onClick = { onSelectGender("female") },
                                label = {
                                    Text(
                                        "Female",
                                        modifier = Modifier.fillMaxWidth(),
                                        textAlign = TextAlign.Center,
                                    )
                                },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = BrandPink.copy(alpha = 0.20f),
                                    selectedLabelColor = Color.White,
                                    containerColor = OutlineDefault.copy(alpha = 0.5f),
                                    labelColor = TextSecondary,
                                ),
                                border = FilterChipDefaults.filterChipBorder(
                                    enabled = true,
                                    selected = uiState.registrationGender == "female",
                                    borderColor = OutlineDefault,
                                    selectedBorderColor = BrandPink.copy(alpha = 0.5f),
                                )
                            )
                        }
                        if (uiState.registrationGender.isBlank()) {
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                text = "Select your gender to continue.",
                                color = TextMuted,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        Spacer(modifier = Modifier.height(20.dp))

                        val genderSelected = uiState.registrationGender.isNotBlank()

                        // Phone button
                        GradientButton(
                            onClick = { showPhoneInput = true },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = genderSelected && !uiState.isLoading,
                        ) {
                            Icon(
                                Icons.Default.Phone,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(
                                "Continue with Phone",
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 15.sp,
                                color = Color.White,
                            )
                        }

                        Spacer(modifier = Modifier.height(12.dp))

                        // Google button
                        OutlinedButton(
                            onClick = { startGoogleSignIn() },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp),
                            shape = buttonShape,
                            border = androidx.compose.foundation.BorderStroke(1.dp, OutlineDefault),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = TextSecondary),
                            enabled = genderSelected && !uiState.isLoading,
                        ) {
                            Icon(Icons.Default.Email, contentDescription = null, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(12.dp))
                            Text("Continue with Google", fontWeight = FontWeight.Medium)
                        }

                        if (showPhoneInput) {
                            Spacer(modifier = Modifier.height(20.dp))
                            HorizontalDivider(color = OutlineDefault)
                            Spacer(modifier = Modifier.height(20.dp))

                            OutlinedTextField(
                                value = phoneNumber,
                                onValueChange = { if (it.length <= 13) phoneNumber = it.filter { c -> c.isDigit() } },
                                label = { Text("Mobile Number") },
                                placeholder = { Text("10-digit number", color = TextMuted) },
                                modifier = Modifier.fillMaxWidth(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                leadingIcon = {
                                    Text(
                                        text = "+91",
                                        color = TextSecondary,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 15.sp,
                                        modifier = Modifier.padding(start = 12.dp),
                                    )
                                },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = BrandPink,
                                    unfocusedBorderColor = OutlineDefault,
                                    focusedLabelColor = BrandPink,
                                    unfocusedLabelColor = TextMuted,
                                    focusedTextColor = MaterialTheme.colorScheme.onSurface,
                                    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                                    cursorColor = BrandPink,
                                ),
                                shape = fieldShape,
                            )

                            Spacer(modifier = Modifier.height(12.dp))

                            // Referral code — phone login only (not shown for Google/Guest)
                            OutlinedTextField(
                                value = referralInput,
                                onValueChange = { v ->
                                    referralInput = v.uppercase().filter { it.isLetterOrDigit() }
                                    onSetReferralCode(referralInput)
                                },
                                label = { Text("Referral Code (optional)") },
                                placeholder = { Text("e.g. ABC123", color = TextMuted) },
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = BrandPurple,
                                    unfocusedBorderColor = OutlineDefault,
                                    focusedLabelColor = BrandPurple,
                                    unfocusedLabelColor = TextMuted,
                                    focusedTextColor = MaterialTheme.colorScheme.onSurface,
                                    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                                    cursorColor = BrandPurple,
                                ),
                                shape = fieldShape,
                            )

                            Spacer(modifier = Modifier.height(12.dp))

                            GradientButton(
                                onClick = { activity?.let { onSendOtp(phoneNumber, it) } },
                                modifier = Modifier.fillMaxWidth(),
                                enabled = phoneNumber.length >= 10 && !uiState.isLoading,
                            ) {
                                Text("Get OTP", fontWeight = FontWeight.SemiBold, color = Color.White, fontSize = 15.sp)
                            }
                        }

                        Spacer(modifier = Modifier.height(24.dp))
                        HorizontalDivider(color = OutlineDefault)
                        Spacer(modifier = Modifier.height(16.dp))

                        OutlinedButton(
                            onClick = {
                                phoneNumber = ""
                                otpCode = ""
                                showPhoneInput = false
                                onBackToOptions()
                                onUseAnotherAccount()
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(50.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, OutlineDefault),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = TextSecondary),
                            shape = buttonShape,
                        ) {
                            Text("Use another account", fontWeight = FontWeight.Medium)
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        TextButton(
                            onClick = onGuestLogin,
                            modifier = Modifier.fillMaxWidth(),
                            enabled = genderSelected && !uiState.isLoading,
                        ) {
                            Text(
                                "Explore as Guest",
                                color = if (genderSelected) TextMuted else TextMuted.copy(alpha = 0.4f),
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }

                    } else if (uiState.isOtpSent) {
                        Text(
                            text = "Verify OTP",
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Code sent to $phoneNumber",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                        )

                        Spacer(modifier = Modifier.height(28.dp))

                        OutlinedTextField(
                            value = otpCode,
                            onValueChange = { if (it.length <= 6) otpCode = it },
                            label = { Text("6-digit code") },
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            textStyle = TextStyle(
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 22.sp,
                                letterSpacing = 8.sp,
                            ),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = BrandPink,
                                unfocusedBorderColor = OutlineDefault,
                                focusedLabelColor = BrandPink,
                                unfocusedLabelColor = TextMuted,
                                focusedTextColor = MaterialTheme.colorScheme.onSurface,
                                unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                                cursorColor = BrandPink,
                            ),
                            shape = fieldShape,
                        )

                        Spacer(modifier = Modifier.height(20.dp))

                        GradientButton(
                            onClick = { onVerifyOtp(otpCode) },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = otpCode.length == 6 && !uiState.isLoading,
                        ) {
                            Text("Verify & Sign In", fontWeight = FontWeight.SemiBold, color = Color.White, fontSize = 15.sp)
                        }

                        Spacer(modifier = Modifier.height(12.dp))

                        TextButton(
                            onClick = { onBackToOptions() },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Change method / Back", color = TextMuted, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(32.dp))
        }
    }
}

fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
