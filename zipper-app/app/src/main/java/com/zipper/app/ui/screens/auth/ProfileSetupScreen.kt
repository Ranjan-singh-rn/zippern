package com.zipper.app.ui.screens.auth

import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.core.app.ActivityCompat
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.google.android.gms.location.LocationServices
import com.google.firebase.auth.FirebaseAuth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import com.zipper.app.ui.components.LanguageChipRow
import com.zipper.app.ui.components.LanguagePickerSheet
import com.zipper.app.ui.theme.*
import com.zipper.app.ui.components.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.MyLocation
import com.zipper.app.util.UserLanguage
import com.zipper.app.util.languageByCode
import com.zipper.app.util.toUserLanguage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(
    ExperimentalPermissionsApi::class,
    ExperimentalMaterial3Api::class
)
@Composable
fun ProfileSetupScreen(
    onNavigateToMain: () -> Unit,
    onNavigateToLogin: () -> Unit = {},
    /**
     * Where a brand-new HOST goes: straight to the liveness capture, carrying
     * the gender they just declared so the capture screen can prompt properly.
     * Ordinary users never reach it.
     */
    onNavigateToFaceVerification: (String) -> Unit = {},
    viewModel: AuthViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current

    /*
     * Is this a guest? The referral field, the host dialog and the random-name
     * prefill all hang off the answer.
     *
     * From the server, with `isAnonymous` only as a fallback for an install
     * where it has never been asked. `isAnonymous` on its own was wrong here
     * in a way that broke setup: quick sign-in redeems a CUSTOM token, so every
     * returning guest read false, and `signInWithQuickLogin` can land on this
     * screen with `ProfileIncomplete`. Those guests were shown the hosts-only
     * referral field, could be routed into the "not a host" dialog, were
     * blocked from finishing by the referral clause in `canProceed` the moment
     * they typed in it, and — worst — skipped the `randomGuestName()` prefill,
     * so they arrived at a required empty name box. See
     * [com.zipper.app.util.SessionManager.isGuest].
     */
    val serverSaysGuest by viewModel.isGuest.collectAsStateWithLifecycle()
    val isGuestUser = serverSaysGuest
        ?: (FirebaseAuth.getInstance().currentUser?.isAnonymous ?: true)

    // Country detected from GPS reverse-geocode — never shown to user, stored in Firestore only.
    // Seeded from device locale so it's always set even if location is denied.
    var detectedCountry by remember { mutableStateOf(Locale.getDefault().displayCountry) }
    val hasPhone = remember { FirebaseAuth.getInstance().currentUser?.phoneNumber?.isNotBlank() == true }
    val hasEmail = remember { FirebaseAuth.getInstance().currentUser?.email?.isNotBlank() == true }

    // Fields to collect the missing contact info. Whether they are shown at all
    // is decided further down, from the role — see `needsEmail` / `needsPhone`.
    var extraEmail by remember { mutableStateOf("") }   // for phone-login users
    var extraPhone by remember { mutableStateOf("") }   // for Google-login users

    /*
     * Whatever name we can honestly offer, by sign-in method.
     *
     *   Google — `displayName`, which Firebase populates from the account.
     *   Phone  — nothing. There is no name attached to a phone number, and
     *            inventing one ("User 8821") is worse than an empty field.
     *   Guest  — "Guest kfmqz". Generated HERE, and not read from anywhere.
     *
     * The guest case is the one that was broken. `createUserDocument` writes
     * "Guest_${uid.take(6)}" into the Firestore document, but nothing ever
     * copies that onto the Firebase Auth profile — so `displayName` is null for
     * an anonymous sign-in and this field rendered empty, leaving every guest
     * staring at a required box with no idea what to type.
     *
     * A prefill, not a lock: the field stays editable, and most people replace
     * it. The random tail is so that two guests on the same screen are not both
     * called "Guest".
     */
    var name by remember {
        mutableStateOf(
            FirebaseAuth.getInstance().currentUser?.displayName?.takeIf { it.isNotBlank() } ?: ""
        )
    }
    /*
     * The prefill cannot be computed inside `remember`.
     *
     * `isGuestUser` comes from a DataStore-backed flow whose first emission has
     * not arrived on the first composition, so it reads the `isAnonymous`
     * fallback there — which is FALSE for a returning guest, because quick
     * sign-in redeems a custom token. `remember` with no keys captures that
     * once, so the very people this prefill exists for arrived at an empty
     * required name box: exactly the defect it was added to fix.
     *
     * Applied when the real answer lands, once, and only while the box is still
     * untouched. Not `remember(isGuestUser)` — re-keying would throw away
     * whatever the person had already typed the moment the flag settled.
     */
    var namePrefilled by remember { mutableStateOf(false) }
    LaunchedEffect(isGuestUser) {
        if (!namePrefilled && isGuestUser && name.isBlank()) {
            name = randomGuestName()
            namePrefilled = true
        }
    }

    /*
     * The photo the account already has.
     *
     * A Google sign-in arrives with one — `AuthRepository.createUserDocument`
     * copies it onto `users/{uid}.photoUrl` at account creation, straight from
     * `FirebaseAuth.currentUser.photoUrl`, which is why it can be read back here
     * without a Firestore round trip.
     *
     * The disc used to be driven by `photoUri` alone, so these users were shown
     * an empty "Add Photo" circle and asked to supply a picture they had already
     * supplied thirty seconds earlier.
     */
    val accountPhotoUrl = remember {
        FirebaseAuth.getInstance().currentUser?.photoUrl?.toString().orEmpty()
    }

    /*
     * The default avatar this person was dealt on arrival. See
     * ui/components/DefaultAvatars.kt for what gets stored and who resolves it.
     */
    var defaultAvatar by remember { mutableStateOf(DefaultAvatar.random()) }

    // Set when somebody taps Shuffle — they have chosen a cartoon over the photo
    // their provider supplied, and that choice must outrank `accountPhotoUrl`.
    var preferDefaultAvatar by remember { mutableStateOf(false) }

    // Guarding the Back button: it destroys the account, so it asks first.
    var showAbandonDialog by remember { mutableStateOf(false) }

    var bio by remember { mutableStateOf("") }
    var gender by remember { mutableStateOf("") }
    var dob by remember { mutableStateOf<Long?>(null) }
    var ageError by remember { mutableStateOf(false) }
    var city by remember { mutableStateOf("") }
    var cityDetecting by remember { mutableStateOf(false) }
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var referralCode by remember { mutableStateOf("") }
    var showNotAHostDialog by remember { mutableStateOf(false) }
    var selectedLanguages by remember { mutableStateOf<List<UserLanguage>>(emptyList()) }
    var showLanguagePicker by remember { mutableStateOf(false) }

    // Device ID
    @SuppressLint("HardwareIds")
    val deviceId = remember {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }

    val locationPermission = rememberPermissionState(android.Manifest.permission.ACCESS_COARSE_LOCATION)

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { photoUri = it }
    }

    // Signup ends at Home for an ordinary user. The liveness capture used to
    // sit here for everybody; it is host-only now.
    LaunchedEffect(uiState.navigateToMain) {
        if (uiState.navigateToMain) {
            viewModel.onNavigatedToMain()
            onNavigateToMain()
        }
    }

    // …and at the capture for somebody who just became a host. Until now this
    // flag was never set by anything, so a new host went to Home tagged
    // HOST · PENDING and stayed there: unable to go live, earning at the base
    // rate rather than their own, and with their weekly payout held.
    LaunchedEffect(uiState.navigateToFaceVerification) {
        if (uiState.navigateToFaceVerification) {
            viewModel.onNavigatedToFaceVerification()
            onNavigateToFaceVerification(gender.ifBlank { "unknown" })
        }
    }

    /*
     * ── THERE WAS NO WAY OUT OF THIS SCREEN ──────────────────────────────────
     *
     * The nav graph enters ProfileSetup with `popUpTo(Screen.Login.route) {
     * inclusive = true }`, so Login is gone from the back stack by the time this
     * composes. There is no back button and the system back gesture had nothing
     * left to pop — it closed the app. Somebody who signed in with the wrong
     * Google account, or changed their mind about a phone number, was left with
     * a half-made account and a form they could only complete or force-quit.
     *
     * Back now offers to undo the sign-up: the account Firebase created a moment
     * ago is deleted and they land back on Login, free to start again with a
     * different method. It asks first — an accidental swipe must not destroy an
     * account — and it waits for the deletion to actually land before navigating,
     * the same way FaceVerificationScreen waits on `accountDeleted`. Navigating
     * optimistically would tell somebody their account was gone while it was
     * still sitting there, exactly the lie `deleteAccount` was fixed to stop
     * telling.
     */
    BackHandler(enabled = true) {
        if (!uiState.isLoading) showAbandonDialog = true
    }

    LaunchedEffect(uiState.setupAbandoned) {
        if (uiState.setupAbandoned) onNavigateToLogin()
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
        // Explicit permission check required by lint before calling location APIs
        if (ActivityCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_COARSE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
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
                            val (detectedCity, detectedCountryName) =
                                fetchLocationFromNominatim(location.latitude, location.longitude)
                            city = detectedCity ?: ""
                            detectedCountryName?.let { detectedCountry = it }
                            cityDetecting = false
                        }
                    } else {
                        cityDetecting = false
                    }
                }.addOnFailureListener {
                    cityDetecting = false
                }
            } catch (e: SecurityException) {
                cityDetecting = false
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

    // Pre-select languages based on device locale (runs once on first composition)
    LaunchedEffect(Unit) {
        if (selectedLanguages.isEmpty()) {
            val deviceCode = java.util.Locale.getDefault().language  // e.g. "hi", "ja", "en"
            val suggestions = buildList {
                // Device language first
                languageByCode(deviceCode)?.toUserLanguage()?.let { add(it) }
                // Always include English as second suggestion (unless device is English)
                if (deviceCode != "en") {
                    languageByCode("en")?.toUserLanguage()?.let { add(it) }
                }
            }
            selectedLanguages = suggestions.distinctBy { it.id }
        }
    }

    val dobFormatted = dob?.let {
        SimpleDateFormat("dd MMM yyyy", Locale.getDefault()).format(Date(it))
    } ?: ""

    val ageFromDob = dob?.let {
        ((System.currentTimeMillis() - it) / (365.25 * 24 * 60 * 60 * 1000)).toInt()
    } ?: 0

    /*
     * ── WHO ACTUALLY HAS TO HAND OVER A PHONE NUMBER ─────────────────────────
     *
     * This used to be `!isGuestUser && !hasEmail` / `!isGuestUser && !hasPhone`,
     * which asked EVERY signed-in person for whichever contact detail their
     * sign-in method had not supplied. Somebody who tapped "Sign in with Google"
     * to watch one stream was stopped on this form and made to type a mobile
     * number — a piece of personal data the app had no use for and no right to
     * insist on, and a wall in front of the one thing they came to do.
     *
     * The requirement belongs to the ROLE, not to the sign-in method, and only
     * the server knows the role: `resolveIdentity` sets `requiresPhone` and
     * `requiresEmail` for a host, an agency, a seller or a member of CRM staff,
     * and for nobody else. It reaches the app as
     * `AuthResult.NeedsContactDetails` and is held on the ViewModel.
     *
     * ── THE DEFAULT IS "DO NOT ASK" ──────────────────────────────────────────
     *
     * `uiState.requiresPhone` / `requiresEmail` are false until the server has
     * answered, so the fields stay hidden while the answer is in flight. That
     * direction is deliberate. Defaulting to "ask" would show a phone field to
     * every ordinary user for the fraction of a second before the truth arrived,
     * and on a slow connection for much longer than that — reproducing exactly
     * the bug this replaces, but intermittently, which is worse. The cost of
     * the safe default is that a host with a slow connection sees the field
     * appear a moment late; the cost of the unsafe one is that everybody else
     * is asked for their number.
     *
     * ── WHY A TYPED REFERRAL CODE ALSO COUNTS ────────────────────────────────
     *
     * Somebody entering an agency code is ASKING to become a host, and is not
     * one yet — so the server truthfully reports that nothing is required of
     * them. But `verifyReferralCode` matches the code against the agency's
     * invitation using both contact details, and redeeming it on save needs the
     * same pair. Without this clause the code would be refused on save with no
     * field on screen to fix it. The original comment on `extraEmail` already
     * claimed the fields were "shown only when referral code is entered"; the
     * code never did that, and this is it.
     *
     * `hasEmail` / `hasPhone` still come from FirebaseAuth, and still should:
     * they answer "do we already know it", which is a fact about the credential.
     * The role answers "should we ask at all". Two different questions.
     */
    val needsEmail = (uiState.requiresEmail || referralCode.isNotBlank()) && !hasEmail
    val needsPhone = (uiState.requiresPhone || referralCode.isNotBlank()) && !hasPhone

    // Verify button is enabled when code >= 6 chars AND missing fields are filled
    val verifyEnabled = referralCode.length >= 6 &&
        (!needsEmail || extraEmail.isNotBlank()) &&
        (!needsPhone || extraPhone.length == 10)

    // Referral code validity is handled in the onClick dialog flow, not by disabling the button
    val canProceed = name.isNotBlank() && gender.isNotBlank() && dob != null && !ageError && city.isNotBlank() &&
        selectedLanguages.isNotEmpty() &&
        (!needsEmail || extraEmail.isNotBlank()) &&
        (!needsPhone || extraPhone.length == 10) &&
        (isGuestUser || referralCode.isBlank() || uiState.referralValid || uiState.referralNotFound)

    val c = ZipperTheme.colors

    /*
     * What the disc shows, in priority order:
     *
     *   1. a photo picked from the gallery just now,
     *   2. the photo the account already had (Google),
     *   3. the default avatar we dealt them.
     *
     * Shuffle jumps to (3) deliberately, which is why `preferDefaultAvatar`
     * outranks `accountPhotoUrl` here.
     */
    val showingDefaultAvatar = photoUri == null && (preferDefaultAvatar || accountPhotoUrl.isBlank())

    /*
     * …and the same decision expressed as the string to store.
     *
     * Empty when a local photo is waiting: the repository uploads it and writes
     * the download URL itself, and passing anything here would only compete with
     * that. Otherwise this IS the value that lands in `users/{uid}.photoUrl` —
     * either the Google photo the document already carries, or "avatar:<id>".
     */
    val photoUrlToStore = when {
        photoUri != null -> ""
        showingDefaultAvatar -> defaultAvatar.photoUrl
        else -> accountPhotoUrl
    }

    fun submit() {
        focusManager.clearFocus(force = true)
        scope.launch {
            delay(300)
            /*
             * The bio used to be written here, by itself, in a try/catch that
             * swallowed whatever went wrong — before the real save and outside
             * it. Two writes for one form, and either could fail alone: a
             * refused bio was silent, and a bio that landed before a save that
             * then failed left half a profile behind.
             *
             * It is one save now. The screen collects, the repository writes.
             */
            viewModel.saveProfile(
                name = name.trim(), gender = gender, dob = dob!!, age = ageFromDob,
                city = city.trim(), country = detectedCountry, deviceId = deviceId,
                photoUri = photoUri, languages = selectedLanguages, email = extraEmail.trim(),
                bio = bio.trim(),
                /*
                 * The avatar, when there is no file to upload.
                 *
                 * `photoUri` is the only way a picture reached the repository,
                 * and the repository only writes `photoUrl` when that upload
                 * produced a download URL — so a default avatar had no route to
                 * Firestore at all. This is that route: the repository stores it
                 * verbatim when `photoUri` is null and ignores it otherwise.
                 */
                defaultAvatar = photoUrlToStore,
                // Stored in the same shape the rest of the platform uses, so it
                // matches a partner record and an agency's invitation without
                // anybody having to normalise it later.
                phone = if (extraPhone.isNotBlank()) "+91$extraPhone" else "",
            )
        }
    }

    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        AmbientGlows()

        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
            // Its own fixed bar rather than the first item in the scroll, so the
            // only escape from this screen cannot be scrolled off the top of it.
            Box(Modifier.fillMaxWidth().height(Size.Bar.top).padding(horizontal = Space.sm)) {
                IconButtonCircle(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    "Back to sign in",
                    { showAbandonDialog = true },
                    modifier = Modifier.align(Alignment.CenterStart),
                    enabled = !uiState.isLoading,
                )
            }

            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(top = Space.sm, start = Space.xxl, end = Space.xxl, bottom = Space.xxl),
                verticalArrangement = Arrangement.spacedBy(Space.xxl),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text("Set Up Profile", style = ZipperTheme.type.displayM, color = c.textPrimary)
                    Text("Tell us who you are", style = ZipperTheme.type.bodyM, color = c.textSecondary)
                }

                /*
                 * ── THE DISC IS NEVER EMPTY NOW ───────────────────────────
                 *
                 * It used to say "Add Photo" and, if the person walked past
                 * it, `photoUrl` stayed "" for the life of the account — an
                 * app full of blank faces, because nothing downstream ever
                 * asks for a photo again. It is seeded with a random animal
                 * instead, which they can keep, shuffle, or replace with a
                 * picture of themselves.
                 */
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Space.lg),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(96.dp)) {
                        Box(
                            Modifier.fillMaxSize().clip(CircleShape)
                                .background(Brush.linearGradient(listOf(c.brandGradientFrom.copy(0.3f), c.brandGradientTo.copy(0.3f))))
                                .border(2.dp, Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                                .clickableNoRipple { photoPicker.launch("image/*") },
                            contentAlignment = Alignment.Center,
                        ) {
                            when {
                                photoUri != null ->
                                    AsyncImage(photoUri, "Profile photo", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().clip(CircleShape))
                                showingDefaultAvatar ->
                                    DefaultAvatarImage(defaultAvatar, modifier = Modifier.fillMaxSize().clip(CircleShape))
                                else ->
                                    AsyncImage(accountPhotoUrl, "Profile photo", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().clip(CircleShape))
                            }
                        }
                        // Outside the clipped disc, so the badge is not cut in half
                        // by the circle it sits on the edge of.
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(30.dp).clip(CircleShape)
                                .background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)))
                                .border(2.dp, c.bgBase, CircleShape)
                                .clickableNoRipple { photoPicker.launch("image/*") },
                            contentAlignment = Alignment.Center,
                        ) {
                            // On a solid brand gradient, so `textOnBrand`.
                            Icon(Icons.Default.AddAPhoto, "Choose a photo", tint = c.textOnBrand, modifier = Modifier.size(Size.Icon.xs))
                        }
                    }

                    Column(
                        Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Text(
                            if (showingDefaultAvatar) "We picked this one for you" else "Your photo",
                            style = ZipperTheme.type.labelM, color = c.textPrimary,
                        )
                        Text(
                            "Tap the circle to use a photo of your own.",
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                        Row(
                            Modifier
                                .background(c.tintBrandSubtle, RoundedCornerShape(Radius.full))
                                .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.full))
                                .clickableNoRipple {
                                    // Always lands on a DIFFERENT one — a shuffle
                                    // that can repeat itself reads as a dead button.
                                    defaultAvatar = DefaultAvatar.randomOtherThan(defaultAvatar)
                                    preferDefaultAvatar = true
                                    photoUri = null
                                }
                                .padding(horizontal = Space.md, vertical = Space.sm),
                            horizontalArrangement = Arrangement.spacedBy(Space.xs),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.Shuffle, null, tint = c.textBrand, modifier = Modifier.size(Size.Icon.sm))
                            Text(
                                if (showingDefaultAvatar) "Shuffle" else "Use an avatar",
                                style = ZipperTheme.type.labelS, color = c.textBrand, maxLines = 1,
                            )
                        }
                    }
                }

                SetupField("Display Name", name, { name = it }, "Your name")

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    SetupLabel("About Me (optional)")
                    SetupBox(minHeight = 88.dp) {
                        BasicTextField(
                            value = bio, onValueChange = { if (it.length <= 150) bio = it },
                            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                            modifier = Modifier.fillMaxWidth(),
                            decorationBox = { inner -> if (bio.isEmpty()) Text("Tell others about yourself", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                        )
                    }
                    Text("${bio.length}/150", style = ZipperTheme.type.caption, color = c.textMuted, modifier = Modifier.align(Alignment.End))
                }

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    SetupLabel("Languages")
                    SetupBox(onClick = { showLanguagePicker = true }) {
                        LanguageChipRow(selected = selectedLanguages, onTapOverflow = { showLanguagePicker = true }, onRemove = { l -> selectedLanguages = selectedLanguages - l }, modifier = Modifier.weight(1f))
                        Icon(Icons.Default.Add, null, tint = c.textBrand, modifier = Modifier.size(20.dp))
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    SetupLabel("Gender")
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        listOf("male" to "Male", "female" to "Female", "transgender" to "Transgender").forEach { (value, label) ->
                            val on = gender == value
                            // The selected pill is filled with the brand gradient, so its
                            // label is `textOnBrand` (was `Color.White`); the unselected
                            // ones sit on bgElevated, so theirs is `textSecondary`. Both
                            // halves of the pair being tokens is what makes the
                            // selected/unselected contrast survive a palette change —
                            // half a pair is worse than neither.
                            Box(
                                Modifier.weight(1f).height(44.dp)
                                    .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), RoundedCornerShape(Radius.md))
                                          else Modifier.background(c.bgElevated, RoundedCornerShape(Radius.md)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.md)))
                                    .clickableNoRipple { gender = value },
                                contentAlignment = Alignment.Center,
                            ) { Text(label, style = ZipperTheme.type.labelS, color = if (on) c.textOnBrand else c.textSecondary, maxLines = 1) }
                        }
                    }
                    Text("Set once — it decides your call pricing and can't be changed later.", style = ZipperTheme.type.caption, color = c.textMuted)
                }

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    SetupLabel("Date of Birth")
                    SetupBox(onClick = { showDatePicker = true }, error = ageError) {
                        Text(
                            if (dob != null) "$dobFormatted   (Age $ageFromDob)" else "Pick your birthday",
                            style = ZipperTheme.type.bodyL, color = if (dob != null) c.textPrimary else c.textMuted, modifier = Modifier.weight(1f),
                        )
                        Icon(Icons.Outlined.CalendarMonth, null, tint = c.textBrand, modifier = Modifier.size(18.dp))
                    }
                    if (ageError) Text("You must be 18 or older to use Zipper", style = ZipperTheme.type.caption, color = c.statusDanger)
                }

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    SetupLabel("Area / City")
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        SetupBox(modifier = Modifier.weight(1f)) {
                            if (cityDetecting) Text("Detecting…", style = ZipperTheme.type.bodyL, color = c.textMuted)
                            else BasicTextField(
                                value = city, onValueChange = { city = it }, singleLine = true,
                                textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                                modifier = Modifier.fillMaxWidth(),
                                decorationBox = { inner -> if (city.isEmpty()) Text("Your area or city", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                            )
                        }
                        Box(
                            Modifier.size(56.dp).background(Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), RoundedCornerShape(Radius.lg))
                                .clickableNoRipple { if (!cityDetecting) detectCity() },
                            contentAlignment = Alignment.Center,
                        ) {
                            // Both sit on a solid brand-gradient square, so both are
                            // `textOnBrand` (was `Color.White`).
                            if (cityDetecting) CircularProgressIndicator(color = c.textOnBrand, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            else Icon(Icons.Outlined.MyLocation, "Detect location", tint = c.textOnBrand, modifier = Modifier.size(22.dp))
                        }
                    }
                }

                /*
                 * The fields, and the sentence that has to come with them.
                 *
                 * An unexplained "Phone Number" box on a sign-up form reads as
                 * the app helping itself to a contact detail, and the people who
                 * see it here are the ones whose money depends on us being able
                 * to reach them. Naming the role and the reason turns it from a
                 * demand into an explanation — and if we cannot name a reason,
                 * that is the signal we should not be asking.
                 *
                 * One block rather than two independent `if`s so the line is
                 * written once and covers whichever of the two is actually being
                 * asked for.
                 */
                if (needsEmail || needsPhone) {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.lg)) {
                        Text(
                            contactDetailsReason(uiState.crmRole, askEmail = needsEmail, askPhone = needsPhone),
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                        if (needsEmail) {
                            SetupField("Email", extraEmail, { extraEmail = it.trim() }, "you@example.com", KeyboardType.Email)
                        }
                        if (needsPhone) {
                            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                                SetupLabel("Phone Number")
                                SetupBox {
                                    Text("+91", style = ZipperTheme.type.labelL, color = c.textBrand)
                                    Box(Modifier.padding(horizontal = Space.md).width(1.dp).height(24.dp).background(c.borderStrong))
                                    BasicTextField(
                                        value = extraPhone, onValueChange = { v -> if (v.length <= 10 && v.all(Char::isDigit)) extraPhone = v }, singleLine = true,
                                        textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                                        modifier = Modifier.weight(1f),
                                        decorationBox = { inner -> if (extraPhone.isEmpty()) Text("10-digit mobile number", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                                    )
                                }
                            }
                        }
                    }
                }

                // Referral (hosts)
                if (!isGuestUser) {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        SetupLabel("Referral code (hosts only, optional)")
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                            SetupBox(modifier = Modifier.weight(1f)) {
                                BasicTextField(
                                    value = referralCode, onValueChange = { referralCode = it.uppercase().trim() }, singleLine = true,
                                    textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                                    keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Characters),
                                    modifier = Modifier.fillMaxWidth(),
                                    decorationBox = { inner -> if (referralCode.isEmpty()) Text("Agency code", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                                )
                            }
                            Box(
                                Modifier.size(56.dp)
                                    .background(if (verifyEnabled) Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)) else Brush.linearGradient(listOf(c.bgElevated, c.bgElevated)), RoundedCornerShape(Radius.lg))
                                    .clickableNoRipple { if (verifyEnabled && !uiState.referralCheckLoading) viewModel.verifyReferralCode(referralCode, overridePhone = if (extraPhone.isNotBlank()) "+91$extraPhone" else "", overrideEmail = extraEmail) },
                                contentAlignment = Alignment.Center,
                            ) {
                                // Enabled the square is a brand gradient, so the tick is
                                // `textOnBrand` (was `Color.White`); disabled it is
                                // bgElevated, so the tick is `textMuted`. The spinner
                                // only ever shows while a request is in flight, which
                                // only happens from the enabled state.
                                if (uiState.referralCheckLoading) CircularProgressIndicator(color = c.textOnBrand, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                                else Icon(Icons.Default.Check, "Verify code", tint = if (verifyEnabled) c.textOnBrand else c.textMuted, modifier = Modifier.size(22.dp))
                            }
                        }
                        when {
                            uiState.referralError != null -> Text(uiState.referralError!!, style = ZipperTheme.type.caption, color = c.statusDanger)
                            uiState.referralValid -> Text(
                                "Valid code" + (if (uiState.referralAgencyName.isNotBlank()) " — joining ${uiState.referralAgencyName}" else "") + ". You'll be registered as a host.",
                                style = ZipperTheme.type.caption, color = c.statusSuccess,
                            )
                            uiState.referralNotFound -> Text("Code not recognised — you'll join as a regular user", style = ZipperTheme.type.caption, color = c.statusWarning)
                        }
                    }
                }

                ZipperButton(
                    "Let's Go!", onClick = {
                        if (!isGuestUser && referralCode.isNotBlank() && !uiState.referralValid && !uiState.referralNotFound && uiState.referralError != null) showNotAHostDialog = true
                        else submit()
                    },
                    gradient = true, fullWidth = true, enabled = canProceed && !uiState.isLoading, loading = uiState.isLoading,
                    modifier = Modifier.padding(top = Space.sm),
                )
                Spacer(Modifier.navigationBarsPadding())
            }
        }

        uiState.error?.let { err ->
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(Space.lg),
                action = { TextButton(onClick = { viewModel.clearError() }) { Text("OK", color = c.textBrand) } },
                containerColor = c.bgElevated, contentColor = c.textPrimary,
            ) { Text(err) }
        }

        /*
         * The profile saved but the agency link did not.
         *
         * Held as a dialog rather than the snackbar below, because this one has
         * to be acknowledged: the alternative is landing on Home as an ordinary
         * user, having just entered a valid agency code, with nothing on screen
         * to say the host part failed.
         */
        uiState.hostActivationError?.let { err ->
            AlertDialog(
                onDismissRequest = { viewModel.dismissHostActivationError() },
                containerColor = c.bgElevated,
                title = { Text("Couldn't join the agency", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        "$err\n\nYour profile is saved. You can correct the details and try the " +
                        "code again, or continue as a regular user and ask the agency to re-send " +
                        "the invitation.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                confirmButton = {
                    TextButton({ viewModel.dismissHostActivationError() }) {
                        Text("Try again", color = c.textBrand)
                    }
                },
                dismissButton = {
                    TextButton({ viewModel.continueWithoutAgency() }) {
                        Text("Continue as user", color = c.textSecondary)
                    }
                },
            )
        }

        if (showLanguagePicker) {
            LanguagePickerSheet(selected = selectedLanguages, onDismiss = { showLanguagePicker = false }, onConfirm = { selectedLanguages = it; showLanguagePicker = false })
        }

        if (showNotAHostDialog) {
            AlertDialog(
                onDismissRequest = { showNotAHostDialog = false },
                containerColor = c.bgElevated,
                title = { Text("Not registered as a host", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = { Text("That referral code doesn't match a host record for your account. Continue as a regular user instead?", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
                confirmButton = { TextButton({ showNotAHostDialog = false; if (dob != null) submit() }) { Text("Continue as user", color = c.textBrand) } },
                dismissButton = { TextButton({ showNotAHostDialog = false; viewModel.signOut(); onNavigateToLogin() }) { Text("Go back", color = c.textSecondary) } },
            )
        }

        /*
         * Back is destructive, so it asks.
         *
         * Not a snackbar with an Undo and not a straight-through action: by the
         * time this screen is on the display, Firebase has already created a
         * login. Going back means removing it, and a stray swipe on a full form
         * must not be able to do that silently. The confirm button says what
         * actually happens rather than "OK".
         *
         * A failure to delete leaves `setupAbandoned` false, so nothing
         * navigates and the reason surfaces in the snackbar above.
         */
        if (showAbandonDialog) {
            AlertDialog(
                onDismissRequest = { showAbandonDialog = false },
                containerColor = c.bgElevated,
                title = { Text("Leave and delete this account?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        "Signing in already created an account. Going back removes it — " +
                        "the login itself, not just this form — and returns you to the " +
                        "sign-in screen, where you can start again with any method.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = { showAbandonDialog = false; viewModel.abandonSetup() },
                        enabled = !uiState.isLoading,
                    ) { Text("Delete and go back", color = c.statusDanger) }
                },
                dismissButton = {
                    TextButton({ showAbandonDialog = false }) { Text("Keep setting up", color = c.textSecondary) }
                },
            )
        }
    }
}

/**
 * "Guest kfmqz" — the prefill a guest sign-in gets.
 *
 * Four or five lowercase letters, nothing read from the account. `Guest_` plus
 * a slice of the uid was the obvious alternative and is what the Firestore
 * document already holds, but a uid fragment is an identifier the person did
 * not choose and cannot read out loud; this is a throwaway handle that reads as
 * one, and they are free to type over it.
 */
private fun randomGuestName(): String {
    val length = (4..5).random()
    val tail = buildString { repeat(length) { append(('a'..'z').random()) } }
    return "Guest $tail"
}

/**
 * The one line that has to sit above a contact field: who is being asked, and
 * what for.
 *
 * ── WHY THE ROLE IS IN THE SENTENCE ──────────────────────────────────────────
 *
 * The field is only ever shown to somebody whose role needs it, and that role is
 * the entire justification. "Hosts need an email address so we can reach you
 * about payouts" is a reason a host can agree or disagree with; a bare "Email"
 * box is indistinguishable from an app collecting contact details because it
 * can. The people who reach this are the ones with money in the system, and
 * they are exactly the ones entitled to know why they are being asked.
 *
 * `crmRole` is the raw role string from `resolveIdentity`, not a flattened one,
 * so it is matched rather than displayed — except in the staff fallback, where
 * printing the role the CRM actually holds ("Ops admin", "Finance member") is
 * more honest than a generic "staff" for somebody who knows their own title.
 *
 * An EMPTY role is the common case here, and it means "not in `crmUsers`" —
 * which for anybody being asked at all means a host, or somebody flagged as an
 * agent or seller on their user document. The wording covers all three: they
 * are all paid.
 */
private fun contactDetailsReason(crmRole: String, askEmail: Boolean, askPhone: Boolean): String {
    val what = when {
        askEmail && askPhone -> "an email address and a phone number"
        askEmail -> "an email address"
        else -> "a phone number"
    }
    return when (crmRole) {
        "" -> "Hosts need $what so we can reach you about your payouts."
        "agency" -> "Agencies need $what so we can reach you about your hosts and your payouts."
        "seller" -> "Coin sellers need $what so we can reach you about orders and settlements."
        else -> {
            // "ops_admin" → "Ops admin". `take`/`drop` rather than
            // `replaceFirstChar` so this cannot depend on a stdlib version.
            val spaced = crmRole.replace('_', ' ')
            val titled = spaced.take(1).uppercase() + spaced.drop(1)
            "$titled accounts need $what so the team can reach you about this account."
        }
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun SetupLabel(text: String) {
    Text(text, style = ZipperTheme.type.labelM, color = ZipperTheme.colors.textSecondary)
}

/** 56h r16 input container on bg/elevated with a hairline border. */
@Composable
private fun SetupBox(
    modifier: Modifier = Modifier,
    minHeight: androidx.compose.ui.unit.Dp = 56.dp,
    onClick: (() -> Unit)? = null,
    error: Boolean = false,
    content: @Composable RowScope.() -> Unit,
) {
    val c = ZipperTheme.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = minHeight)
            .background(c.bgElevated, RoundedCornerShape(Radius.lg))
            .border(1.dp, if (error) c.statusDanger else c.borderDefault, RoundedCornerShape(Radius.lg))
            .then(if (onClick != null) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.lg, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun SetupField(label: String, value: String, onValueChange: (String) -> Unit, placeholder: String, keyboardType: KeyboardType = KeyboardType.Text) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        SetupLabel(label)
        SetupBox {
            BasicTextField(
                value = value, onValueChange = onValueChange, singleLine = true,
                textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
            )
        }
    }
}

/**
 * Single Nominatim reverse-geocode call that returns both city and country.
 * Country is stored silently in Firestore (never shown to user).
 * City is the user-visible "Area / City" field.
 */
private suspend fun fetchLocationFromNominatim(lat: Double, lon: Double): Pair<String?, String?> =
    withContext(Dispatchers.IO) {
        try {
            val url = java.net.URL(
                "https://nominatim.openstreetmap.org/reverse" +
                "?format=json&lat=$lat&lon=$lon&accept-language=en&zoom=10"
            )
            val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
                setRequestProperty("User-Agent", "ZipperApp/1.0 (contact@zipper.app)")
                connectTimeout = 6000
                readTimeout  = 6000
            }
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()

            val address = org.json.JSONObject(body).optJSONObject("address")
                ?: return@withContext Pair(null, null)

            // City: best available place name at suburb/city granularity
            val city = address.optString("city").takeIf { it.isNotBlank() }
                ?: address.optString("town").takeIf { it.isNotBlank() }
                ?: address.optString("suburb").takeIf { it.isNotBlank() }
                ?: address.optString("county").takeIf { it.isNotBlank() }
                ?: address.optString("village").takeIf { it.isNotBlank() }

            // Country: Nominatim returns "country" field in English when accept-language=en
            val country = address.optString("country").takeIf { it.isNotBlank() }

            Pair(city, country)
        } catch (e: Exception) {
            Pair(null, null)
        }
    }
