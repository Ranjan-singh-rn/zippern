package com.zipper.app.ui.screens.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.material3.MaterialTheme
import com.zipper.app.ui.theme.ZipperPink
import kotlinx.coroutines.delay

@Composable
fun OtpVerifyScreen(
    phoneNumber: String,
    onNavigateToProfileSetup: () -> Unit,
    onNavigateToMain: () -> Unit,
    onBack: () -> Unit,
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    var otp by remember { mutableStateOf("") }
    var secondsLeft by remember { mutableIntStateOf(60) }
    val focusRequester = remember { FocusRequester() }

    // Countdown timer
    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        while (secondsLeft > 0) { delay(1000); secondsLeft-- }
    }

    // Auto-fill OTP if retrieved automatically
    LaunchedEffect(uiState.otpAutoFilled) {
        uiState.otpAutoFilled?.let {
            otp = it
            viewModel.verifyOtp(it)
        }
    }

    // Navigation
    LaunchedEffect(uiState.navigateToProfileSetup) {
        if (uiState.navigateToProfileSetup) { viewModel.onNavigatedToProfileSetup(); onNavigateToProfileSetup() }
    }
    LaunchedEffect(uiState.navigateToMain) {
        if (uiState.navigateToMain) { viewModel.onNavigatedToMain(); onNavigateToMain() }
    }

    // Auto-verify when 6 digits entered
    LaunchedEffect(otp) {
        if (otp.length == 6) viewModel.verifyOtp(otp)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(56.dp))
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = MaterialTheme.colorScheme.onBackground)
                }
            }
            Spacer(Modifier.height(24.dp))
            Text("Verify OTP", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
            Spacer(Modifier.height(8.dp))
            Text(
                "Sent to +91 $phoneNumber",
                color = MaterialTheme.colorScheme.onBackground.copy(0.5f),
                fontSize = 14.sp,
            )
            Spacer(Modifier.height(48.dp))

            // Hidden text field for input
            BasicTextField(
                value = otp,
                onValueChange = { if (it.length <= 6 && it.all(Char::isDigit)) otp = it },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                cursorBrush = SolidColor(ZipperPink),
                modifier = Modifier
                    .size(0.dp)
                    .focusRequester(focusRequester),
            )

            // OTP boxes
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(6) { index ->
                    val char = otp.getOrNull(index)
                    val isFocused = index == otp.length
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(
                                1.5.dp,
                                when {
                                    isFocused -> ZipperPink
                                    char != null -> ZipperPink.copy(0.4f)
                                    else -> MaterialTheme.colorScheme.onBackground.copy(0.1f)
                                },
                                RoundedCornerShape(10.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = char?.toString() ?: "",
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                }
            }

            Spacer(Modifier.height(40.dp))

            if (uiState.isLoading) {
                CircularProgressIndicator(color = ZipperPink, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
            } else {
                Button(
                    onClick = { if (otp.length == 6) viewModel.verifyOtp(otp) },
                    enabled = otp.length == 6,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = ZipperPink),
                ) {
                    Text("Verify", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            Spacer(Modifier.height(24.dp))

            if (secondsLeft > 0) {
                Text("Resend OTP in ${secondsLeft}s", color = MaterialTheme.colorScheme.onBackground.copy(0.4f), fontSize = 13.sp)
            } else {
                TextButton(onClick = { secondsLeft = 60; otp = "" }) {
                    Text("Resend OTP", color = ZipperPink, fontSize = 13.sp)
                }
            }
        }

        uiState.error?.let { err ->
            Snackbar(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(16.dp),
                action = { TextButton(onClick = { viewModel.clearError() }) { Text("OK") } },
            ) { Text(err) }
        }
    }
}
