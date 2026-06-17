package com.zipper.datingapp.ui.screens

import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.*
import com.zipper.datingapp.util.buildVideoPlayer
import com.zipper.datingapp.util.extractVideoThumbnail
import com.zipper.datingapp.util.isVideoUrl

private const val MAX_GALLERY = 9
private const val MAX_BIO = 250

// ─────────────────────────────────────────────────────────────────────────────
// Tag option lists
// ─────────────────────────────────────────────────────────────────────────────

private val HOBBY_OPTIONS = listOf(
    "Reading", "Cooking", "Gaming", "Music", "Travel", "Sports",
    "Art", "Dance", "Photography", "Movies", "Fitness", "Fashion",
    "Tech", "Cars", "Nature", "Yoga", "Singing", "Drawing",
)
private val LIKE_OPTIONS = listOf(
    "Beach", "Mountains", "Coffee", "Pets", "Pizza", "Sushi",
    "Sunsets", "Rain", "Concerts", "Hiking", "Binge-watching", "Shopping",
    "Candles", "Flowers", "Road Trips", "Ice Cream",
)
private val DISLIKE_OPTIONS = listOf(
    "Smoking", "Loud Noise", "Crowds", "Traffic", "Spicy Food",
    "Horror Movies", "Gossip", "Lying", "Wasting Food",
)
private val LANGUAGE_OPTIONS = listOf(
    "English", "Hindi", "Bengali", "Tamil", "Telugu", "Marathi",
    "Gujarati", "Kannada", "Malayalam", "Punjabi", "Urdu",
    "French", "Spanish", "Arabic", "Portuguese", "Indonesian",
    "Vietnamese", "Korean", "Japanese", "Chinese (Mandarin)",
)

// ─────────────────────────────────────────────────────────────────────────────
// EditProfileScreen
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EditProfileScreen(
    user: UserProfile,
    uiState: DatingUiState,
    /** name, age, city, gender, email, mobile, bio, photo, gallery, referral, mimeTypes,
     *  hobbies, likes, dislikes, languages */
    onSave: (String, Int, String, String, String, String, String, String, List<String>, String, List<String>, List<String>, List<String>, List<String>, List<String>) -> Unit,
    onSaveDone: () -> Unit = {},
    onUploadVideo: (Uri) -> Unit = {},
    onSelectFrame: (String?) -> Unit = {},
    onBack: () -> Unit,
    onClearSaveFeedback: () -> Unit = {},
    /** Phone re-binding callbacks */
    onSendPhoneChangeOtp: ((String, Activity) -> Unit)? = null,
    onVerifyPhoneChangeOtp: ((String) -> Unit)? = null,
    onClearPhoneChangeState: (() -> Unit)? = null,
    /** Email re-binding callbacks */
    onChangeEmail: ((String) -> Unit)? = null,
    onClearEmailChangeState: (() -> Unit)? = null,
) {
    BackHandler(onBack = onBack)

    val ctx = LocalContext.current
    val activity = remember(ctx) { ctx.findActivity() }

    // ── Form state ────────────────────────────────────────────────────────────
    var name   by remember { mutableStateOf(user.name) }
    var age    by remember { mutableStateOf(user.age.takeIf { it > 0 }?.toString() ?: "") }

    // Locked fields — only settable on first save
    val cityLocked   = user.city.isNotBlank()
    val genderLocked = user.gender.isNotBlank()
    var city   by remember { mutableStateOf(user.city) }
    var gender by remember {
        mutableStateOf(
            when (user.gender.trim().lowercase()) {
                "male", "m"        -> "male"
                "female", "f"      -> "female"
                "transgender", "t" -> "transgender"
                else -> user.genderText.takeIf { it in listOf("male","female","transgender") } ?: ""
            }
        )
    }

    // Contact fields — read-only; changed via re-auth dialogs
    val email  = user.email
    val mobile = user.mobile

    var bio    by remember { mutableStateOf(user.bio.take(MAX_BIO)) }

    // ── Discovery tags ────────────────────────────────────────────────────────
    var selectedHobbies   by remember { mutableStateOf(user.hobbies.toSet()) }
    var selectedLikes     by remember { mutableStateOf(user.likes.toSet()) }
    var selectedDislikes  by remember { mutableStateOf(user.dislikes.toSet()) }
    var selectedLanguages by remember { mutableStateOf(user.languages.toSet()) }

    // ── Referral (input only if not guest + no referral assigned yet) ─────────
    val canEnterReferral = !user.isGuest && user.referralCode.isNullOrBlank()
    var referralInput by remember { mutableStateOf("") }

    // ── Media state ───────────────────────────────────────────────────────────
    var profilePhotoUrl by remember { mutableStateOf(user.photoUrl) }
    var galleryItems by remember { mutableStateOf(user.galleryPhotos.map { it to "image/jpeg" }) }

    var showProfileViewer by remember { mutableStateOf(false) }
    var galleryViewerIndex by remember { mutableIntStateOf(0) }
    var showGalleryViewer by remember { mutableStateOf(false) }

    // ── Phone change dialog state ─────────────────────────────────────────────
    var showPhoneDialog by remember { mutableStateOf(false) }
    var phoneInput by remember { mutableStateOf("") }
    var otpInput   by remember { mutableStateOf("") }

    // ── Email change dialog state ─────────────────────────────────────────────
    var showEmailDialog by remember { mutableStateOf(false) }
    var emailInput by remember { mutableStateOf("") }

    // ── Pickers ───────────────────────────────────────────────────────────────
    val profilePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let { profilePhotoUrl = it.toString() }
    }
    val galleryPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_GALLERY.coerceAtLeast(2))
    ) { uris ->
        val incoming = uris.map { uri ->
            val mime = ctx.contentResolver.getType(uri) ?: "image/jpeg"
            uri.toString() to mime
        }
        galleryItems = (galleryItems + incoming).distinctBy { it.first }.take(MAX_GALLERY)
    }

    // ── Save feedback ─────────────────────────────────────────────────────────
    LaunchedEffect(uiState.profileSaveSuccess) {
        if (uiState.profileSaveSuccess) {
            onClearSaveFeedback()
            onSaveDone()
        }
    }

    val isSaving = uiState.isProfileSaving

    // ── UI ────────────────────────────────────────────────────────────────────
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text("Edit Profile", fontWeight = FontWeight.Bold, fontSize = 18.sp) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                actions = {
                    if (isSaving) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp).padding(end = 16.dp),
                            strokeWidth = 2.dp,
                            color = BrandPink
                        )
                    } else {
                        TextButton(
                            onClick = {
                                if (!isSaving) {
                                    onSave(
                                        name.trim(),
                                        age.toIntOrNull() ?: user.age,
                                        city.trim(),
                                        gender,
                                        email,
                                        mobile,
                                        bio.trim(),
                                        profilePhotoUrl,
                                        galleryItems.map { it.first },
                                        if (canEnterReferral) referralInput else user.referralCode.orEmpty(),
                                        galleryItems.map { it.second },
                                        selectedHobbies.toList(),
                                        selectedLikes.toList(),
                                        selectedDislikes.toList(),
                                        selectedLanguages.toList(),
                                    )
                                }
                            },
                            enabled = gender.isNotBlank() && !isSaving
                        ) {
                            Text(
                                "Save",
                                color = if (gender.isNotBlank()) BrandPink else MaterialTheme.colorScheme.onSurface.copy(.38f),
                                fontWeight = FontWeight.Bold,
                                fontSize = 16.sp
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
        ) {

            // ── Cover + Avatar hero preview ───────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(180.dp)
            ) {
                val coverUrl = galleryItems.firstOrNull()?.first.orEmpty()
                if (coverUrl.isNotBlank()) {
                    SubcomposeAsyncImage(
                        model = ImageRequest.Builder(ctx).data(coverUrl).crossfade(200).build(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Crop,
                        loading = { ShimmerBox(Modifier.fillMaxSize()) }
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(
                                Brush.linearGradient(listOf(Color(0xFF6A1B9A), Color(0xFFE91E63), Color(0xFFFF6F00)))
                            )
                    )
                }
                Box(
                    modifier = Modifier.fillMaxSize().background(
                        Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(.55f)))
                    )
                )
                Text(
                    name.ifBlank { "Your Name" },
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp,
                    modifier = Modifier.align(Alignment.BottomStart).padding(start = 110.dp, bottom = 12.dp)
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = 20.dp)
                        .offset(y = 40.dp)
                ) {
                    ProfileAvatarBadge(
                        photoUrl = profilePhotoUrl,
                        initial = name.take(1).uppercase().ifEmpty { "?" },
                        size = 80.dp,
                        onClick = { showProfileViewer = true }
                    )
                    Surface(
                        modifier = Modifier
                            .size(26.dp)
                            .align(Alignment.BottomEnd)
                            .clickable {
                                profilePicker.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                        shape = CircleShape,
                        color = BrandPink,
                        shadowElevation = 4.dp
                    ) {
                        Icon(Icons.Default.CameraAlt, null, tint = Color.White, modifier = Modifier.padding(5.dp))
                    }
                }
            }

            Spacer(Modifier.height(52.dp))

            // ── Error / Success banner ────────────────────────────────────────
            AnimatedVisibility(visible = uiState.profileSaveError != null) {
                uiState.profileSaveError?.let { err ->
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(err, color = MaterialTheme.colorScheme.onErrorContainer, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            IconButton(onClick = onClearSaveFeedback, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Default.Close, null, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }

            // ── Gallery ───────────────────────────────────────────────────────
            EpSectionHeader(
                icon = Icons.Default.PhotoLibrary,
                title = "Media Gallery  •  ${galleryItems.size}/$MAX_GALLERY",
                subtitle = "First photo becomes your cover image",
                action = if (galleryItems.size < MAX_GALLERY) "Add" else null,
                onAction = {
                    galleryPicker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                    )
                }
            )

            if (galleryItems.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(100.dp)
                        .padding(horizontal = 16.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp))
                        .clickable {
                            galleryPicker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                            )
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.AddPhotoAlternate, null, tint = TextSecondary, modifier = Modifier.size(32.dp))
                        Spacer(Modifier.height(4.dp))
                        Text("Add photos & videos", color = TextSecondary, fontSize = 13.sp)
                    }
                }
            } else {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    itemsIndexed(galleryItems, key = { _, it -> it.first }) { index, (url, mime) ->
                        val progress = uiState.galleryUploadProgress[index]
                        GalleryThumb(
                            url = url,
                            mime = mime,
                            isFirst = index == 0,
                            uploadProgress = progress,
                            onView = { galleryViewerIndex = index; showGalleryViewer = true },
                            onDelete = { galleryItems = galleryItems.filterIndexed { i, _ -> i != index } }
                        )
                    }
                    if (galleryItems.size < MAX_GALLERY) {
                        item {
                            Box(
                                modifier = Modifier
                                    .size(110.dp)
                                    .clip(RoundedCornerShape(14.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant)
                                    .clickable {
                                        galleryPicker.launch(
                                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                                        )
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(Icons.Default.Add, null, tint = TextSecondary, modifier = Modifier.size(28.dp))
                            }
                        }
                    }
                }
            }

            // ── Personal info ─────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Person, title = "Personal Information")

            EpCard {
                // Display Name
                EpTextField(label = "Display Name", value = name, onValueChange = { name = it }, leadingIcon = Icons.Default.Badge)
                EpDivider()
                // Age
                EpTextField(label = "Age", value = age, onValueChange = { age = it.filter { c -> c.isDigit() }.take(2) }, keyboardType = KeyboardType.Number, leadingIcon = Icons.Default.Cake)
                EpDivider()
                // City — locked if already set
                if (cityLocked) {
                    EpLockedRow(icon = Icons.Default.LocationOn, label = "City", value = user.city, hint = "Cannot be changed")
                } else {
                    EpTextField(label = "City", value = city, onValueChange = { city = it }, leadingIcon = Icons.Default.LocationOn)
                }
                EpDivider()
                // Gender — locked if already set
                if (genderLocked) {
                    EpLockedRow(
                        icon = when (user.gender.lowercase()) {
                            "female" -> Icons.Default.Female
                            "male"   -> Icons.Default.Male
                            else     -> Icons.Default.Transgender
                        },
                        label = "Gender",
                        value = user.gender.replaceFirstChar { it.uppercase() },
                        hint = "Cannot be changed"
                    )
                } else {
                    GenderSelector(selected = gender, onSelect = { gender = it })
                }
                EpDivider()
                // Email — read-only + Change/Add button
                EpContactRow(
                    icon = Icons.Default.Email,
                    label = "Email Address",
                    value = email.ifBlank { null },
                    onChangeClick = { showEmailDialog = true }
                )
                EpDivider()
                // Mobile — read-only + Change/Add button
                EpContactRow(
                    icon = Icons.Default.Phone,
                    label = "Mobile Number",
                    value = mobile.ifBlank { null },
                    onChangeClick = { showPhoneDialog = true }
                )
            }

            // ── Bio ───────────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Info, title = "About Me")
            EpCard {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Bio", color = TextSecondary, fontSize = 12.sp)
                        Text(
                            "${bio.length}/$MAX_BIO",
                            fontSize = 11.sp,
                            color = if (bio.length >= MAX_BIO) MaterialTheme.colorScheme.error else TextSecondary
                        )
                    }
                    TextField(
                        value = bio,
                        onValueChange = { if (it.length <= MAX_BIO) bio = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = false,
                        minLines = 3,
                        maxLines = 6,
                        placeholder = { Text("Tell others about yourself…", color = TextSecondary, fontSize = 13.sp) },
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent
                        )
                    )
                }
            }

            // ── Hobbies ───────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Interests, title = "Hobbies")
            EpCard {
                EpTagChips(
                    options = HOBBY_OPTIONS,
                    selected = selectedHobbies,
                    onToggle = { tag ->
                        selectedHobbies = if (tag in selectedHobbies)
                            selectedHobbies - tag else selectedHobbies + tag
                    }
                )
            }

            // ── Likes ─────────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Favorite, title = "Likes")
            EpCard {
                EpTagChips(
                    options = LIKE_OPTIONS,
                    selected = selectedLikes,
                    onToggle = { tag ->
                        selectedLikes = if (tag in selectedLikes)
                            selectedLikes - tag else selectedLikes + tag
                    }
                )
            }

            // ── Dislikes ──────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.HeartBroken, title = "Dislikes")
            EpCard {
                EpTagChips(
                    options = DISLIKE_OPTIONS,
                    selected = selectedDislikes,
                    onToggle = { tag ->
                        selectedDislikes = if (tag in selectedDislikes)
                            selectedDislikes - tag else selectedDislikes + tag
                    }
                )
            }

            // ── Languages ─────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Language, title = "Languages I Speak")
            EpCard {
                EpTagChips(
                    options = LANGUAGE_OPTIONS,
                    selected = selectedLanguages,
                    onToggle = { tag ->
                        selectedLanguages = if (tag in selectedLanguages)
                            selectedLanguages - tag else selectedLanguages + tag
                    }
                )
            }

            // ── Referral ──────────────────────────────────────────────────────
            EpSectionHeader(icon = Icons.Default.Tag, title = "Referral Code")
            EpCard {
                if (canEnterReferral) {
                    // New Google/phone user who doesn't have one yet — let them enter it
                    EpTextField(
                        label = "Enter Referral Code (optional)",
                        value = referralInput,
                        onValueChange = { referralInput = it.uppercase().filter { c -> c.isLetterOrDigit() } },
                        leadingIcon = Icons.Default.Tag
                    )
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Tag, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Referral Code", color = TextSecondary, fontSize = 11.sp)
                            Text(
                                user.referralCode.orEmpty().ifBlank { if (user.isGuest) "Not available for guests" else "Not assigned" },
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 15.sp,
                                color = if (user.referralCode.isNullOrBlank()) TextSecondary else MaterialTheme.colorScheme.onSurface
                            )
                        }
                        Icon(Icons.Default.Lock, null, tint = TextSecondary.copy(.5f), modifier = Modifier.size(16.dp))
                    }
                }
            }

            Spacer(Modifier.height(80.dp))
        }
    }

    // ── Phone change dialog ───────────────────────────────────────────────────
    if (showPhoneDialog) {
        PhoneChangeDialog(
            currentPhone = mobile,
            otpSent = uiState.phoneChangeOtpSent,
            error = uiState.phoneChangeError,
            phoneInput = phoneInput,
            onPhoneChange = { phoneInput = it },
            otpInput = otpInput,
            onOtpChange = { otpInput = it },
            onSendOtp = { activity?.let { act -> onSendPhoneChangeOtp?.invoke(phoneInput, act) } },
            onVerifyOtp = { onVerifyPhoneChangeOtp?.invoke(otpInput) },
            onDismiss = {
                showPhoneDialog = false
                phoneInput = ""; otpInput = ""
                onClearPhoneChangeState?.invoke()
            }
        )
    }

    // ── Email change dialog ───────────────────────────────────────────────────
    if (showEmailDialog) {
        EmailChangeDialog(
            currentEmail = email,
            sent = uiState.emailChangeSent,
            error = uiState.emailChangeError,
            emailInput = emailInput,
            onEmailChange = { emailInput = it },
            onSend = { onChangeEmail?.invoke(emailInput) },
            onDismiss = {
                showEmailDialog = false
                emailInput = ""
                onClearEmailChangeState?.invoke()
            }
        )
    }

    // ── Gallery viewer ────────────────────────────────────────────────────────
    if (showGalleryViewer && galleryItems.isNotEmpty()) {
        EditGalleryViewer(
            items = galleryItems,
            startIndex = galleryViewerIndex,
            onDismiss = { showGalleryViewer = false }
        )
    }

    // ── Profile photo viewer ──────────────────────────────────────────────────
    if (showProfileViewer) {
        ProfilePhotoViewer(
            url = profilePhotoUrl.ifBlank { null },
            initial = name.take(1).uppercase(),
            onDismiss = { showProfileViewer = false },
            onChange = {
                showProfileViewer = false
                profilePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            onDelete = { profilePhotoUrl = ""; showProfileViewer = false }
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone & Email change dialogs
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhoneChangeDialog(
    currentPhone: String,
    otpSent: Boolean,
    error: String?,
    phoneInput: String,
    onPhoneChange: (String) -> Unit,
    otpInput: String,
    onOtpChange: (String) -> Unit,
    onSendOtp: () -> Unit,
    onVerifyOtp: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (currentPhone.isBlank()) "Add Phone Number" else "Change Phone Number") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (currentPhone.isNotBlank()) {
                    Text("Current: $currentPhone", color = TextSecondary, fontSize = 13.sp)
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                }
                if (!otpSent) {
                    OutlinedTextField(
                        value = phoneInput,
                        onValueChange = { if (it.length <= 13) onPhoneChange(it.filter { c -> c.isDigit() }) },
                        label = { Text("New Mobile Number") },
                        placeholder = { Text("10-digit number") },
                        leadingIcon = { Text("+91", modifier = Modifier.padding(start = 8.dp), fontWeight = FontWeight.SemiBold) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text("OTP sent to +91$phoneInput", fontSize = 13.sp, color = TextSecondary)
                    OutlinedTextField(
                        value = otpInput,
                        onValueChange = { if (it.length <= 6) onOtpChange(it.filter { c -> c.isDigit() }) },
                        label = { Text("6-digit OTP") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            if (!otpSent) {
                Button(
                    onClick = onSendOtp,
                    enabled = phoneInput.length >= 10,
                ) { Text("Send OTP") }
            } else {
                Button(
                    onClick = onVerifyOtp,
                    enabled = otpInput.length == 6,
                ) { Text("Verify & Update") }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmailChangeDialog(
    currentEmail: String,
    sent: Boolean,
    error: String?,
    emailInput: String,
    onEmailChange: (String) -> Unit,
    onSend: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (currentEmail.isBlank()) "Add Email Address" else "Change Email Address") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (currentEmail.isNotBlank()) {
                    Text("Current: $currentEmail", color = TextSecondary, fontSize = 13.sp)
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                }
                if (!sent) {
                    OutlinedTextField(
                        value = emailInput,
                        onValueChange = onEmailChange,
                        label = { Text("New Email Address") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text(
                        "Verification email sent to $emailInput. Please check your inbox and click the link to confirm the change.",
                        fontSize = 13.sp,
                    )
                }
            }
        },
        confirmButton = {
            if (!sent) {
                Button(
                    onClick = onSend,
                    enabled = emailInput.contains("@") && emailInput.contains("."),
                ) { Text("Send Verification") }
            } else {
                TextButton(onClick = onDismiss) { Text("Done") }
            }
        },
        dismissButton = {
            if (!sent) TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag chip multi-select
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EpTagChips(
    options: List<String>,
    selected: Set<String>,
    onToggle: (String) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { tag ->
            val isSelected = tag in selected
            FilterChip(
                selected = isSelected,
                onClick = { onToggle(tag) },
                label = { Text(tag, fontSize = 13.sp) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = BrandPink.copy(alpha = 0.18f),
                    selectedLabelColor = BrandPink,
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = isSelected,
                    selectedBorderColor = BrandPink.copy(alpha = 0.5f),
                    borderColor = MaterialTheme.colorScheme.outline.copy(.25f),
                )
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supporting composables (Edit Profile only)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun EpSectionHeader(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String? = null,
    action: String? = null,
    onAction: () -> Unit = {}
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, null, tint = BrandPink, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            if (subtitle != null) Text(subtitle, fontSize = 11.sp, color = TextSecondary)
        }
        if (action != null) {
            TextButton(onClick = onAction) {
                Icon(Icons.Default.Add, null, modifier = Modifier.size(16.dp), tint = BrandPink)
                Text(action, color = BrandPink, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun EpCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.12f))
    ) {
        Column(modifier = Modifier.padding(16.dp), content = content)
    }
    Spacer(Modifier.height(4.dp))
}

@Composable
private fun EpDivider() = HorizontalDivider(
    modifier = Modifier.padding(vertical = 8.dp),
    color = MaterialTheme.colorScheme.outline.copy(.1f)
)

/** Read-only locked field row (city, gender). */
@Composable
private fun EpLockedRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    value: String,
    hint: String,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = TextSecondary, fontSize = 11.sp)
            Text(value.ifBlank { "—" }, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface)
            Text(hint, fontSize = 10.sp, color = TextSecondary.copy(.6f))
        }
        Icon(Icons.Default.Lock, null, tint = TextSecondary.copy(.4f), modifier = Modifier.size(15.dp))
    }
}

/** Read-only contact field with a Change / Add button. */
@Composable
private fun EpContactRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    value: String?,
    onChangeClick: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = TextSecondary, fontSize = 11.sp)
            Text(
                value ?: "Not set",
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = if (value != null) MaterialTheme.colorScheme.onSurface else TextSecondary,
            )
        }
        TextButton(onClick = onChangeClick) {
            Text(if (value.isNullOrBlank()) "Add" else "Change", color = BrandPink, fontSize = 13.sp)
        }
    }
}

@Composable
private fun EpTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    leadingIcon: androidx.compose.ui.graphics.vector.ImageVector? = null
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (leadingIcon != null) {
            Icon(leadingIcon, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(label, color = TextSecondary, fontSize = 11.sp)
            androidx.compose.foundation.text.BasicTextField(
                value = value,
                onValueChange = onValueChange,
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                textStyle = androidx.compose.ui.text.TextStyle(
                    fontSize = 15.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.Medium
                ),
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                singleLine = true,
                decorationBox = { inner ->
                    if (value.isEmpty()) {
                        androidx.compose.material3.Text("—", color = TextSecondary.copy(.5f), fontSize = 15.sp)
                    }
                    inner()
                }
            )
        }
    }
}

@Composable
private fun GenderSelector(selected: String, onSelect: (String) -> Unit) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                when (selected) {
                    "female"      -> Icons.Default.Female
                    "male"        -> Icons.Default.Male
                    "transgender" -> Icons.Default.Transgender
                    else          -> Icons.Default.Person
                },
                null, tint = TextSecondary, modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Gender", color = TextSecondary, fontSize = 11.sp)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("male" to "Male", "female" to "Female", "transgender" to "Trans").forEach { (value, label) ->
                        val isSelected = selected == value
                        Surface(
                            modifier = Modifier.clickable { onSelect(value) },
                            shape = RoundedCornerShape(50),
                            color = if (isSelected) BrandPink else MaterialTheme.colorScheme.surface,
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                if (isSelected) BrandPink else MaterialTheme.colorScheme.outline.copy(.3f)
                            )
                        ) {
                            Text(
                                label,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                color = if (isSelected) Color.White else MaterialTheme.colorScheme.onSurface,
                                fontSize = 13.sp,
                                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GalleryThumb(
    url: String,
    mime: String,
    isFirst: Boolean,
    uploadProgress: Float?,
    onView: () -> Unit,
    onDelete: () -> Unit
) {
    val isVideo = mime.startsWith("video/") || isVideoUrl(url)
    Box(modifier = Modifier.size(110.dp)) {
        if (isVideo) {
            var bitmap by remember(url) { mutableStateOf<Bitmap?>(null) }
            var thumbLoading by remember(url) { mutableStateOf(true) }
            LaunchedEffect(url) {
                if (url.startsWith("http")) bitmap = extractVideoThumbnail(url)
                thumbLoading = false
            }
            Box(modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).clickable(onClick = onView)) {
                when {
                    thumbLoading -> ShimmerBox(Modifier.fillMaxSize())
                    bitmap != null -> Image(bitmap = bitmap!!.asImageBitmap(), contentDescription = null,
                        modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    else -> Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.PlayCircleFilled, null, tint = TextSecondary, modifier = Modifier.size(28.dp))
                    }
                }
                Box(Modifier.fillMaxSize().background(Color.Black.copy(.28f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.PlayCircleFilled, null, tint = Color.White, modifier = Modifier.size(30.dp))
                }
            }
        } else {
            SubcomposeAsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(url).crossfade(200).build(),
                contentDescription = null,
                modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).clickable(onClick = onView),
                contentScale = ContentScale.Crop,
                loading = { ShimmerBox(Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp))) },
                error = {
                    Box(Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant).clickable(onClick = onView),
                        contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Image, null, tint = TextSecondary, modifier = Modifier.size(28.dp))
                    }
                }
            )
        }
        if (isFirst) {
            Surface(modifier = Modifier.align(Alignment.BottomStart).padding(4.dp),
                shape = RoundedCornerShape(4.dp), color = BrandPink.copy(.9f)) {
                Text("Cover", fontSize = 9.sp, color = Color.White, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp))
            }
        }
        if (uploadProgress != null && uploadProgress < 1f) {
            Box(modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).background(Color.Black.copy(.45f)),
                contentAlignment = Alignment.Center) {
                CircularProgressIndicator(progress = { uploadProgress }, modifier = Modifier.size(36.dp),
                    color = BrandPink, strokeWidth = 3.dp)
                Text("${(uploadProgress * 100).toInt()}%", color = Color.White, fontSize = 10.sp)
            }
        }
        IconButton(onClick = onDelete,
            modifier = Modifier.align(Alignment.TopEnd).size(30.dp).background(Color.Black.copy(.6f), CircleShape)) {
            Icon(Icons.Default.Close, null, tint = Color.White, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun EditGalleryViewer(items: List<Pair<String, String>>, startIndex: Int, onDismiss: () -> Unit) {
    val scales  = remember(items.size) { SnapshotStateList<Float>().also { l -> repeat(items.size) { l.add(1f) } } }
    val offsets = remember(items.size) { SnapshotStateList<Offset>().also { l -> repeat(items.size) { l.add(Offset.Zero) } } }
    val pager = rememberPagerState(initialPage = startIndex, pageCount = { items.size })
    val currentScale = scales.getOrElse(pager.currentPage) { 1f }

    Dialog(onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true)) {
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(),
                userScrollEnabled = currentScale <= 1.01f) { page ->
                val (url, mime) = items[page]
                if (mime.startsWith("video/") || isVideoUrl(url)) {
                    EditCachedVideoPlayer(url = url)
                } else {
                    val transformState = rememberTransformableState { zoom, panChange, _ ->
                        val ns = (scales.getOrElse(page) { 1f } * zoom).coerceIn(1f, 6f)
                        scales[page] = ns
                        offsets[page] = if (ns > 1f) offsets.getOrElse(page) { Offset.Zero } + panChange else Offset.Zero
                    }
                    Box(modifier = Modifier.fillMaxSize()
                        .let { if (currentScale > 1.01f) it.transformable(state = transformState) else it },
                        contentAlignment = Alignment.Center) {
                        SubcomposeAsyncImage(model = url, contentDescription = null,
                            modifier = Modifier.fillMaxSize().graphicsLayer(
                                scaleX = scales.getOrElse(page){1f},
                                scaleY = scales.getOrElse(page){1f},
                                translationX = offsets.getOrElse(page){Offset.Zero}.x,
                                translationY = offsets.getOrElse(page){Offset.Zero}.y),
                            contentScale = ContentScale.Fit,
                            loading = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = BrandPink, modifier = Modifier.size(36.dp)) } })
                    }
                }
            }
            IconButton(onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopStart).padding(16.dp).statusBarsPadding()
                    .background(Color.Black.copy(.55f), CircleShape)) {
                Icon(Icons.Default.Close, null, tint = Color.White)
            }
            if (items.size > 1) {
                Surface(modifier = Modifier.align(Alignment.TopCenter).padding(top = 16.dp).statusBarsPadding(),
                    shape = RoundedCornerShape(16.dp), color = Color.Black.copy(.5f)) {
                    Text("${pager.currentPage + 1} / ${items.size}", color = Color.White, fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun EditCachedVideoPlayer(url: String) {
    val ctx = LocalContext.current
    val exo = remember(url) { buildVideoPlayer(ctx, url) }
    DisposableEffect(exo) { onDispose { exo.release() } }
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(factory = { c ->
            androidx.media3.ui.PlayerView(c).apply {
                player = exo; useController = true
                setShowBuffering(androidx.media3.ui.PlayerView.SHOW_BUFFERING_ALWAYS)
            }
        }, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun ProfileAvatarBadge(photoUrl: String, initial: String, size: androidx.compose.ui.unit.Dp, onClick: () -> Unit) {
    val glow = Brush.sweepGradient(listOf(BrandPink, BrandPurple, BrandPink))
    Box(modifier = Modifier.size(size).shadow(8.dp, CircleShape).border(3.dp, glow, CircleShape)
        .clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant).clickable(onClick = onClick),
        contentAlignment = Alignment.Center) {
        if (photoUrl.isNotBlank()) {
            SubcomposeAsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(photoUrl).crossfade(300).build(),
                contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
                loading = { ShimmerBox(Modifier.fillMaxSize()) })
        } else {
            Box(modifier = Modifier.fillMaxSize().background(Brush.linearGradient(listOf(BrandPurple, BrandPink))),
                contentAlignment = Alignment.Center) {
                Text(initial, fontSize = (size.value * 0.35f).sp, fontWeight = FontWeight.Bold, color = Color.White)
            }
        }
    }
}

@Composable
private fun ProfilePhotoViewer(url: String?, initial: String, onDismiss: () -> Unit, onChange: () -> Unit, onDelete: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var confirmDelete by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true)) {
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            if (!url.isNullOrBlank()) {
                SubcomposeAsyncImage(model = url, contentDescription = null,
                    modifier = Modifier.fillMaxSize().pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale == 1f) Offset.Zero else offset + pan
                        }
                    }.graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                    contentScale = ContentScale.Fit,
                    loading = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = BrandPink) } })
            } else {
                Box(modifier = Modifier.fillMaxSize().background(Brush.linearGradient(listOf(BrandPurple, BrandPink))),
                    contentAlignment = Alignment.Center) {
                    Text(initial, fontSize = 96.sp, fontWeight = FontWeight.Bold, color = Color.White.copy(.8f))
                }
            }
            IconButton(onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopStart).padding(12.dp).statusBarsPadding()
                    .background(Color.Black.copy(.55f), CircleShape)) {
                Icon(Icons.Default.Close, null, tint = Color.White)
            }
            Row(modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Color.Black.copy(.7f)).navigationBarsPadding().padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally)) {
                FilledTonalButton(onClick = onChange) {
                    Icon(Icons.Default.CameraAlt, null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp)); Text("Change")
                }
                if (!url.isNullOrBlank()) {
                    OutlinedButton(onClick = { confirmDelete = true },
                        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error)) {
                        Icon(Icons.Default.Delete, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.width(6.dp)); Text("Delete", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(onDismissRequest = { confirmDelete = false },
            title = { Text("Remove Profile Photo?") },
            text = { Text("Your initial will be shown instead.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; onDelete() }) { Text("Remove", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shimmer effect (shared)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
internal fun ShimmerBox(modifier: Modifier = Modifier) {
    val shimmerColors = listOf(
        MaterialTheme.colorScheme.surfaceVariant.copy(.6f),
        MaterialTheme.colorScheme.surfaceVariant.copy(.3f),
        MaterialTheme.colorScheme.surfaceVariant.copy(.6f)
    )
    val transition = rememberInfiniteTransition(label = "shimmer")
    val translateAnim by transition.animateFloat(
        initialValue = 0f, targetValue = 1200f,
        animationSpec = infiniteRepeatable(tween(1200, easing = FastOutSlowInEasing)),
        label = "shimmerX"
    )
    Box(modifier = modifier.background(Brush.linearGradient(colors = shimmerColors,
        start = Offset(translateAnim - 400f, 0f), end = Offset(translateAnim, 0f))))
}

// EditField kept for backward-compat callers elsewhere in codebase
@Composable
fun EditField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
    enabled: Boolean = true
) {
    val scheme = MaterialTheme.colorScheme
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(label, color = scheme.onSurface.copy(.6f), fontSize = 12.sp)
        TextField(
            value = value, onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(), enabled = enabled, singleLine = singleLine,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                focusedIndicatorColor = scheme.primary, unfocusedIndicatorColor = scheme.outline.copy(.5f),
                disabledContainerColor = Color.Transparent, disabledTextColor = scheme.onSurface.copy(.6f),
                disabledIndicatorColor = scheme.outline.copy(.3f)
            )
        )
    }
}
