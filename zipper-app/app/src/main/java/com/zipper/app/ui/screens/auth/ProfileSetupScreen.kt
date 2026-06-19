package com.zipper.app.ui.screens.auth

import android.annotation.SuppressLint
import android.location.Geocoder
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.google.android.gms.location.LocationServices
import com.google.firebase.auth.FirebaseAuth
import com.zipper.app.ui.theme.*
import com.zipper.app.ui.theme.ZipperSuccess
import com.zipper.app.ui.theme.ZipperError
import java.text.SimpleDateFormat
import java.util.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalPermissionsApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ProfileSetupScreen(
    onNavigateToFaceVerification: (gender: String) -> Unit,
    onNavigateToLogin: () -> Unit = {},
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Detect if this is a guest/anonymous login — referral code not shown for guests
    val isGuestUser = remember { FirebaseAuth.getInstance().currentUser?.isAnonymous ?: true }

    var name by remember { mutableStateOf("") }
    var gender by remember { mutableStateOf("") }
    var dob by remember { mutableStateOf<Long?>(null) }
    var ageError by remember { mutableStateOf(false) }
    var city by remember { mutableStateOf("") }
    var cityDetecting by remember { mutableStateOf(false) }
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var referralCode by remember { mutableStateOf("") }
    var showNotAHostDialog by remember { mutableStateOf(false) }

    // Device ID
    @SuppressLint("HardwareIds")
    val deviceId = remember {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }

    val locationPermission = rememberPermissionState(android.Manifest.permission.ACCESS_COARSE_LOCATION)

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { photoUri = it }
    }

    LaunchedEffect(uiState.navigateToFaceVerification) {
        if (uiState.navigateToFaceVerification) {
            viewModel.onNavigatedToFaceVerification()
            onNavigateToFaceVerification(gender)
        }
    }

    // Date picker state
    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = System.currentTimeMillis() - (20L * 365 * 24 * 60 * 60 * 1000),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                utcTimeMillis < System.currentTimeMillis()
        }
    )

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    val selected = datePickerState.selectedDateMillis
                    if (selected != null) {
                        val ageYears = ((System.currentTimeMillis() - selected) / (365.25 * 24 * 60 * 60 * 1000)).toInt()
                        if (ageYears < 18) {
                            ageError = true
                        } else {
                            ageError = false
                            dob = selected
                        }
                    }
                    showDatePicker = false
                }) { Text("OK", color = ZipperPink) }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel", color = MaterialTheme.colorScheme.onBackground.copy(0.6f)) }
            },
            colors = DatePickerDefaults.colors(
                containerColor = MaterialTheme.colorScheme.surface,
                titleContentColor = MaterialTheme.colorScheme.onSurface,
                headlineContentColor = MaterialTheme.colorScheme.onSurface,
                weekdayContentColor = MaterialTheme.colorScheme.onSurface.copy(0.5f),
                subheadContentColor = MaterialTheme.colorScheme.onSurface.copy(0.7f),
                yearContentColor = MaterialTheme.colorScheme.onSurface,
                currentYearContentColor = ZipperPink,
                selectedYearContentColor = MaterialTheme.colorScheme.onSurface,
                selectedYearContainerColor = ZipperPink,
                dayContentColor = MaterialTheme.colorScheme.onSurface,
                selectedDayContentColor = MaterialTheme.colorScheme.onSurface,
                selectedDayContainerColor = ZipperPink,
                todayContentColor = ZipperPink,
                todayDateBorderColor = ZipperPink,
            ),
        ) {
            DatePicker(
                state = datePickerState,
                colors = DatePickerDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            )
        }
    }

    fun detectCity() {
        if (!locationPermission.status.isGranted) {
            locationPermission.launchPermissionRequest()
            return
        }
        cityDetecting = true
        scope.launch {
            try {
                val fusedClient = LocationServices.getFusedLocationProviderClient(context)
                fusedClient.lastLocation.addOnSuccessListener { location ->
                    if (location != null) {
                        scope.launch {
                            try {
                                val geocoder = Geocoder(context, Locale.getDefault())
                                @Suppress("DEPRECATION")
                                val addresses = withContext(Dispatchers.IO) {
                                    geocoder.getFromLocation(location.latitude, location.longitude, 1)
                                }
                                val detectedCity = addresses?.firstOrNull()?.let { extractCity(it) } ?: ""
                                city = detectedCity
                            } catch (e: Exception) {
                                // keep manual input
                            } finally {
                                cityDetecting = false
                            }
                        }
                    } else {
                        cityDetecting = false
                    }
                }.addOnFailureListener {
                    cityDetecting = false
                }
            } catch (e: Exception) {
                cityDetecting = false
            }
        }
    }

    // Auto-detect city when permission granted
    LaunchedEffect(locationPermission.status.isGranted) {
        if (locationPermission.status.isGranted && city.isEmpty()) {
            detectCity()
        }
    }

    val dobFormatted = dob?.let {
        SimpleDateFormat("dd MMM yyyy", Locale.getDefault()).format(Date(it))
    } ?: ""

    val ageFromDob = dob?.let {
        ((System.currentTimeMillis() - it) / (365.25 * 24 * 60 * 60 * 1000)).toInt()
    } ?: 0

    // Referral code validity is handled in the onClick dialog flow, not by disabling the button
    val canProceed = name.isNotBlank() && gender.isNotBlank() && dob != null && !ageError && city.isNotBlank()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .imePadding(),
    ) {

        // Background glow orbs
        Box(
            modifier = Modifier
                .size(300.dp)
                .align(Alignment.TopEnd)
                .offset(x = 80.dp, y = (-40).dp)
                .blur(110.dp)
                .background(ZipperPurple.copy(0.2f), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(250.dp)
                .align(Alignment.BottomStart)
                .offset(x = (-60).dp, y = 60.dp)
                .blur(90.dp)
                .background(ZipperPink.copy(0.18f), CircleShape),
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp)
                .navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(56.dp))

            Text(
                "Set Up Profile",
                fontSize = 26.sp,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(4.dp))
            Text("Tell us who you are", color = MaterialTheme.colorScheme.onBackground.copy(0.45f), fontSize = 14.sp)

            Spacer(Modifier.height(28.dp))

            // Photo picker
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(CircleShape)
                    .background(
                        Brush.linearGradient(listOf(ZipperPink.copy(0.3f), ZipperPurple.copy(0.3f))),
                    )
                    .border(2.dp, Brush.linearGradient(listOf(ZipperPink, ZipperPurple)), CircleShape)
                    .clickable { photoPicker.launch("image/*") },
                contentAlignment = Alignment.Center,
            ) {
                if (photoUri != null) {
                    AsyncImage(
                        model = photoUri,
                        contentDescription = "Profile photo",
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop,
                    )
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.AddAPhoto, null, tint = ZipperPink, modifier = Modifier.size(26.dp))
                        Spacer(Modifier.height(4.dp))
                        Text("Add Photo", color = ZipperPink, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            Spacer(Modifier.height(28.dp))

            // Name
            ProfileField(
                value = name,
                onValueChange = { name = it },
                label = "Display Name",
                placeholder = "What should we call you?",
            )

            Spacer(Modifier.height(20.dp))

            // Gender
            ProfileLabel("Gender")
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("Male" to "male", "Female" to "female", "Transgender" to "transgender").forEach { (label, value) ->
                    val selected = gender == value
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(44.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(
                                if (selected) Brush.linearGradient(listOf(ZipperPink, ZipperPurple))
                                else Brush.linearGradient(listOf(MaterialTheme.colorScheme.onBackground.copy(0.06f), MaterialTheme.colorScheme.onBackground.copy(0.06f))),
                            )
                            .border(
                                1.dp,
                                if (selected) Color.Transparent else MaterialTheme.colorScheme.onBackground.copy(0.12f),
                                RoundedCornerShape(12.dp),
                            )
                            .clickable { gender = value },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label,
                            fontSize = 13.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (selected) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onBackground.copy(0.55f),
                        )
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            // DOB
            ProfileLabel("Date of Birth")
            Spacer(Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.onBackground.copy(0.06f))
                    .border(
                        1.dp,
                        if (dob != null) ZipperPink.copy(0.6f) else MaterialTheme.colorScheme.onBackground.copy(0.12f),
                        RoundedCornerShape(12.dp),
                    )
                    .clickable { showDatePicker = true }
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = if (dob != null) "$dobFormatted  (Age $ageFromDob)" else "Select date of birth",
                        color = if (dob != null) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onBackground.copy(0.3f),
                        fontSize = 15.sp,
                    )
                    Icon(Icons.Default.CalendarMonth, null, tint = ZipperPink, modifier = Modifier.size(20.dp))
                }
            }
            if (ageError) {
                Spacer(Modifier.height(4.dp))
                Text("You must be 18 or older to use Zipper", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }

            Spacer(Modifier.height(20.dp))

            // City
            ProfileLabel("City")
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(52.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.onBackground.copy(0.06f))
                        .border(
                            1.dp,
                            if (city.isNotEmpty()) ZipperPink.copy(0.6f) else MaterialTheme.colorScheme.onBackground.copy(0.12f),
                            RoundedCornerShape(12.dp),
                        )
                        .padding(horizontal = 16.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (cityDetecting) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(color = ZipperPink, modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("Detecting...", color = MaterialTheme.colorScheme.onBackground.copy(0.4f), fontSize = 14.sp)
                        }
                    } else {
                        OutlinedTextField(
                            value = city,
                            onValueChange = { city = it },
                            placeholder = { Text("Your city", color = MaterialTheme.colorScheme.onBackground.copy(0.3f), fontSize = 14.sp) },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color.Transparent,
                                unfocusedBorderColor = Color.Transparent,
                                focusedTextColor = MaterialTheme.colorScheme.onBackground,
                                unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                                cursorColor = ZipperPink,
                            ),
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
                // Detect button
                Box(
                    modifier = Modifier
                        .size(52.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Brush.linearGradient(listOf(ZipperPink.copy(0.8f), ZipperPurple.copy(0.8f))))
                        .clickable(enabled = !cityDetecting) { detectCity() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.MyLocation, null, tint = Color.White, modifier = Modifier.size(22.dp))
                }
            }

            // Referral code section — only shown for non-guest users
            if (!isGuestUser) {
                Spacer(Modifier.height(20.dp))

                // Referral Code (optional — for hosts joining via agency)
                ProfileLabel("Referral Code (Optional — for hosts only)")
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = referralCode,
                        onValueChange = { referralCode = it.uppercase() },
                        placeholder = { Text("Enter agency code", color = MaterialTheme.colorScheme.onBackground.copy(0.3f)) },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = when {
                                uiState.referralValid -> ZipperSuccess
                                uiState.referralError != null -> ZipperError
                                else -> ZipperPink
                            },
                            unfocusedBorderColor = when {
                                uiState.referralValid -> ZipperSuccess
                                uiState.referralError != null -> ZipperError
                                else -> MaterialTheme.colorScheme.onBackground.copy(0.12f)
                            },
                            focusedTextColor = MaterialTheme.colorScheme.onBackground,
                            unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                            cursorColor = ZipperPink,
                            focusedContainerColor = MaterialTheme.colorScheme.onBackground.copy(0.06f),
                            unfocusedContainerColor = MaterialTheme.colorScheme.onBackground.copy(0.06f),
                        ),
                        modifier = Modifier.weight(1f),
                    )
                    if (uiState.referralCheckLoading) {
                        CircularProgressIndicator(color = ZipperPink, modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                    } else if (referralCode.length >= 6) {
                        Box(
                            modifier = Modifier
                                .size(48.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(Brush.linearGradient(listOf(ZipperPink, ZipperPurple)))
                                .clickable { viewModel.verifyReferralCode(referralCode) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("✓", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                if (uiState.referralError != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(uiState.referralError!!, color = ZipperError, fontSize = 12.sp)
                }
                if (uiState.referralValid) {
                    Spacer(Modifier.height(4.dp))
                    Text("✓ Valid referral code — you'll be registered as a host", color = ZipperSuccess, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                }
            }

            Spacer(Modifier.height(36.dp))

            // Save button
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(
                        if (canProceed)
                            Brush.horizontalGradient(listOf(ZipperPink, ZipperPurple))
                        else
                            Brush.horizontalGradient(listOf(MaterialTheme.colorScheme.onBackground.copy(0.1f), MaterialTheme.colorScheme.onBackground.copy(0.1f))),
                    )
                    .clickable(enabled = canProceed && !uiState.isLoading) {
                        if (!isGuestUser && referralCode.isNotBlank() && !uiState.referralValid) {
                            // Code was entered but didn't verify as host — show dialog
                            showNotAHostDialog = true
                        } else {
                            viewModel.saveProfile(
                                name = name.trim(),
                                gender = gender,
                                dob = dob!!,
                                age = ageFromDob,
                                city = city.trim(),
                                deviceId = deviceId,
                                photoUri = photoUri,
                            )
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (uiState.isLoading) {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                } else {
                    Text(
                        "Let's Go! ⚡",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (canProceed) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onBackground.copy(0.3f),
                        letterSpacing = 1.sp,
                    )
                }
            }

            Spacer(Modifier.height(40.dp))
        }

        uiState.error?.let { err ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                action = { TextButton(onClick = { viewModel.clearError() }) { Text("OK") } },
                containerColor = MaterialTheme.colorScheme.surface,
            ) { Text(err, color = MaterialTheme.colorScheme.onSurface) }
        }

        // "Not a host" dialog — shown when referral code entered but verification failed
        if (showNotAHostDialog) {
            AlertDialog(
                onDismissRequest = { showNotAHostDialog = false },
                title = { Text("Not Registered as Host", fontWeight = FontWeight.Bold) },
                text = {
                    Text(
                        "The referral code you entered does not match any host record for your account. " +
                            "Would you like to continue as a regular user instead?",
                        color = MaterialTheme.colorScheme.onSurface.copy(0.8f),
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            val currentDob = dob ?: return@TextButton
                            showNotAHostDialog = false
                            // Clear the referral code and proceed as normal user
                            viewModel.saveProfile(
                                name = name.trim(),
                                gender = gender,
                                dob = currentDob,
                                age = ageFromDob,
                                city = city.trim(),
                                deviceId = deviceId,
                                photoUri = photoUri,
                            )
                        }
                    ) {
                        Text("Yes, Continue as User", color = ZipperPink, fontWeight = FontWeight.SemiBold)
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = {
                            showNotAHostDialog = false
                            viewModel.signOut()
                            onNavigateToLogin()
                        }
                    ) {
                        Text("No, Go Back", color = MaterialTheme.colorScheme.onSurface.copy(0.6f))
                    }
                },
                containerColor = MaterialTheme.colorScheme.surface,
                titleContentColor = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun ProfileLabel(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onBackground.copy(0.65f),
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ProfileField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        ProfileLabel(label)
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text(placeholder, color = MaterialTheme.colorScheme.onBackground.copy(0.3f)) },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = ZipperPink,
                unfocusedBorderColor = MaterialTheme.colorScheme.onBackground.copy(0.12f),
                focusedTextColor = MaterialTheme.colorScheme.onBackground,
                unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                cursorColor = ZipperPink,
                focusedContainerColor = MaterialTheme.colorScheme.onBackground.copy(0.06f),
                unfocusedContainerColor = MaterialTheme.colorScheme.onBackground.copy(0.06f),
            ),
        )
    }
}

private fun extractCity(addr: android.location.Address): String {
    val adminSuffixes = listOf(
        "division", "district", "zone", "taluk", "tehsil",
        "mandal", "block", "sub-district", "municipal corporation", "nagar nigam"
    )

    fun String.isAdminJargon() = adminSuffixes.any { this.contains(it, ignoreCase = true) }
    fun String?.clean() = this?.trim()?.takeIf { it.isNotBlank() && !it.isAdminJargon() }

    // Priority 1: locality (Android field for city/town)
    addr.locality.clean()?.let { return it }

    // Priority 2: subAdminArea (district) filtered for admin jargon
    addr.subAdminArea.clean()?.let { return it }

    // Priority 3: Parse from full address line — city is typically before State
    val line = addr.getAddressLine(0)
    if (!line.isNullOrBlank()) {
        val state = addr.adminArea ?: ""
        val country = addr.countryName ?: ""
        val parts = line.split(",").map { it.trim() }
        val candidate = parts.firstOrNull { part ->
            part.isNotBlank() &&
            !part.any { it.isDigit() } &&
            !part.contains(state, ignoreCase = true) &&
            !part.contains(country, ignoreCase = true) &&
            !part.isAdminJargon()
        }
        candidate?.let { return it }
    }

    // Priority 4: adminArea (state) as last resort
    return addr.adminArea ?: ""
}
