package com.zipper.app.ui.screens.profile

import android.content.Context
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.home.SelectChip
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.LevelEngine
import com.zipper.app.util.UserLanguage
import com.zipper.app.util.languageByCode
import com.zipper.app.util.toUserLanguage
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/*
 * Edit profile — Figma "05 Edit profile".
 *
 *   TopBar "Edit profile" with a "Save" text action (brand, muted while the
 *   name is blank, spinner while saving). Cover 160 with a camera disc, 96
 *   avatar overlapping it with a gradient edit disc. Fields on bg/elevated
 *   r16 boxes; hobbies and interests as SelectChips; hosts get a Call rate
 *   glass card with the server-enforced band; gallery is a 3-column grid.
 */

// ── Preset options ────────────────────────────────────────────────────────────

private val HOBBY_OPTIONS = listOf(
    "Travelling", "Dancing", "Singing", "Gaming", "Reading",
    "Fitness", "Cooking", "Photography", "Movies", "Sports",
    "Music", "Art", "Fashion", "Tech", "Yoga",
)

private val LIKE_OPTIONS = listOf(
    "Friendship", "Dating", "Long Talks", "Video Calls", "Live Streaming",
    "Music", "Party Rooms", "Gaming", "Shopping", "Travel",
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EditProfileScreen(
    onBack: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val c = ZipperTheme.colors
    val snackbar = remember { SnackbarHostState() }
    var showLanguagePicker by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }

    // Pre-select device language if languages empty on first load
    LaunchedEffect(state.user) {
        if (state.user != null && state.editLanguages.isEmpty()) {
            viewModel.onLanguagesChange(suggestLanguages(context))
        }
    }

    LaunchedEffect(state.saveSuccess) {
        if (state.saveSuccess) {
            viewModel.onSaveSuccessConsumed()
            onBack()
        }
    }

    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it); viewModel.clearError() }
    }

    val photoLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) viewModel.onPhotoUriChange(uri)
    }
    val coverLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) viewModel.onCoverUriChange(uri)
    }
    // PickMultipleVisualMedia lets the user select several photos/videos at once
    val mediaLauncher = rememberLauncherForActivityResult(PickMultipleVisualMedia()) { uris ->
        uris.forEach { viewModel.addMediaUri(it) }
    }
    val pickMedia = { mediaLauncher.launch(PickVisualMediaRequest(PickVisualMedia.ImageAndVideo)) }

    // Block system back while save is in progress
    BackHandler(enabled = state.isSaving) { /* swallow — don't navigate away mid-save */ }

    val user = state.user
    // Spec §10 / F-16: the call-rate card and the Host Level line are host-level
    // items; a normal user never sees them.
    val isHost = com.zipper.app.util.LevelVisibility.showCallRateCard(user?.isHost == true)

    // Host call rate limits by HOST level (0–10), NOT user spending level.
    // `user.hostLevel` is written as 0 at signup and never updated, so compute
    // it the same way LevelScreen does — from beans actually earned.
    val totalBeansEarned = (user?.hostCallEarnings ?: 0L) + (user?.hostGiftEarnings ?: 0L)
    val hostLvl = LevelEngine.computeHostLevel(totalBeansEarned).level

    // The ceiling comes from the server (getHostHome), the floor from config.
    // Zero max means the control is not offered: not a host, or unverified, in
    // which case startCall charges the base rate whatever the slider says.
    val minCallRate = state.minCallRateBeans.toInt().coerceAtLeast(1)
    val maxCallRate = state.maxCallRateBeans.toInt()
    val canEditCallRate = isHost && maxCallRate > minCallRate

    val canSave = state.editName.isNotBlank() && !state.isSaving

    ZipperScreen(
        topBar = {
            TopBar("Edit profile", onBack = { if (!state.isSaving) onBack() }) {
                if (state.isSaving) {
                    CircularProgressIndicator(color = c.brandPrimary, strokeWidth = 2.dp, modifier = Modifier.padding(end = Space.md).size(20.dp))
                } else {
                    Text(
                        "Save", style = ZipperTheme.type.labelL, color = if (canSave) c.textBrand else c.textMuted,
                        modifier = Modifier.clickableNoRipple { if (canSave) viewModel.saveProfile() }.padding(horizontal = Space.md, vertical = Space.sm),
                    )
                }
            }
        },
    ) { _ ->
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding()
                    .padding(top = Space.md, start = Space.lg, end = Space.lg, bottom = Space.xxl),
                verticalArrangement = Arrangement.spacedBy(Space.xl),
            ) {
                // ── Cover + avatar ────────────────────────────────────────
                Box(Modifier.fillMaxWidth().height(208.dp)) {
                    Box(
                        Modifier.fillMaxWidth().height(160.dp).clip(RoundedCornerShape(Radius.lg))
                            .background(placeholderBrush(user?.uid ?: "")).clickableNoRipple { coverLauncher.launch("image/*") },
                    ) {
                        val cover = state.editCoverUri ?: user?.coverPhotoUrl?.takeIf { it.isNotBlank() }
                        if (cover != null) AsyncImage(cover, "Cover photo", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        Box(Modifier.fillMaxWidth().height(80.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, c.scrimMedium))))
                        Box(
                            Modifier.align(Alignment.BottomEnd).padding(Space.md).size(32.dp).background(c.scrimStrong, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.CameraAlt, "Change cover", tint = Color.White, modifier = Modifier.size(16.dp)) }
                    }
                    Box(Modifier.align(Alignment.BottomCenter).size(96.dp).clickableNoRipple { photoLauncher.launch("image/*") }) {
                        val photo = state.editPhotoUri ?: user?.photoUrl?.takeIf { it.isNotBlank() }
                        Box(
                            Modifier.fillMaxSize().clip(CircleShape).background(c.tintBrandSubtle).border(3.dp, c.bgBase, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (photo != null) AsyncImage(photo, "Profile photo", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            else Text(state.editName.take(1).uppercase().ifEmpty { "?" }, style = ZipperTheme.type.displayM, color = c.textBrand)
                        }
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(28.dp)
                                .background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                                .border(2.dp, c.bgBase, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.CameraAlt, "Change photo", tint = Color.White, modifier = Modifier.size(14.dp)) }
                    }
                }

                // ── Fields ────────────────────────────────────────────────
                EditField("Display name", state.editName, { if (it.length <= 30) viewModel.onNameChange(it) }, "Your name")

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    EditLabel("Bio")
                    EditBox(minHeight = 88.dp) {
                        BasicTextField(
                            value = state.editBio, onValueChange = { if (it.length <= 150) viewModel.onBioChange(it) }, maxLines = 5,
                            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary), cursorBrush = SolidColor(c.brandPrimary),
                            modifier = Modifier.fillMaxWidth(),
                            decorationBox = { inner -> if (state.editBio.isEmpty()) Text("Tell people about yourself", style = ZipperTheme.type.bodyL, color = c.textMuted); inner() },
                        )
                    }
                    Text("${state.editBio.length}/150", style = ZipperTheme.type.caption, color = c.textMuted, modifier = Modifier.align(Alignment.End))
                }

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    EditLabel("Date of birth")
                    EditBox(onClick = { showDatePicker = true }) {
                        val hasDob = state.editDob > 0L
                        Text(
                            if (hasDob) "${formatDob(state.editDob)}   (Age ${calculateAge(state.editDob)})" else "Tap to select",
                            style = ZipperTheme.type.bodyL, color = if (hasDob) c.textPrimary else c.textMuted, modifier = Modifier.weight(1f),
                        )
                        Icon(Icons.Outlined.CalendarMonth, null, tint = c.textBrand, modifier = Modifier.size(18.dp))
                    }
                }

                EditField("Area / City", state.editCity, { if (it.length <= 100) viewModel.onCityChange(it) }, "e.g. Patia, Bhubaneswar")

                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    EditLabel("Languages")
                    EditBox(onClick = { showLanguagePicker = true }) {
                        LanguageChipRow(
                            selected = state.editLanguages, onTapOverflow = { showLanguagePicker = true },
                            onRemove = { viewModel.removeLanguage(it) }, visibleCount = 5, modifier = Modifier.weight(1f),
                        )
                        Icon(Icons.Default.Add, "Add language", tint = c.textBrand, modifier = Modifier.size(20.dp))
                    }
                }

                ChipSection("Hobbies", "Select all that apply", HOBBY_OPTIONS, state.editHobbies) { viewModel.toggleHobby(it) }
                ChipSection("Interests", "What you're looking for", LIKE_OPTIONS, state.editLikes) { viewModel.toggleLike(it) }

                // ── Locked account details ────────────────────────────────
                GlassCard {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("Account", style = ZipperTheme.type.headingS, color = c.textPrimary)
                        Icon(Icons.Default.Lock, null, tint = c.textMuted, modifier = Modifier.size(16.dp))
                    }
                    LockedRow("Gender", user?.gender?.replaceFirstChar { it.uppercase() }?.ifBlank { "—" } ?: "—")
                    LockedRow("Phone", user?.phoneNumber?.ifBlank { "—" } ?: "—")
                    LockedRow("Email", user?.email?.ifBlank { "—" } ?: "—")
                    LockedRow("Referral code", user?.referralCode?.ifBlank { "—" } ?: "—")
                    Text("Gender is set once. Contact support to change your phone or email.", style = ZipperTheme.type.caption, color = c.textMuted)
                }

                // ── Call rate (hosts) ─────────────────────────────────────
                if (isHost) {
                    val shownRate = if (canEditCallRate) state.editCallRate else minCallRate
                    GlassCard {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Call rate", style = ZipperTheme.type.headingS, color = c.textPrimary)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                                CurrencyDisc(Currency.Bean, 14.dp)
                                Text("${indianGrouping(shownRate.toLong())}/min", style = ZipperTheme.type.numericM, color = c.currencyBean)
                            }
                        }
                        Text(
                            when {
                                canEditCallRate -> "Between ${indianGrouping(minCallRate.toLong())} and ${indianGrouping(maxCallRate.toLong())} beans/min at your level"
                                maxCallRate == 0 -> "Complete identity verification to set your own rate"
                                else -> "Host Level ${hostLvl.coerceAtLeast(1)} · fixed at ${indianGrouping(minCallRate.toLong())} beans/min"
                            },
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                        if (canEditCallRate) {
                            Slider(
                                value = state.editCallRate.toFloat(),
                                onValueChange = { viewModel.onCallRateChange(it.toInt()) },
                                valueRange = minCallRate.toFloat()..maxCallRate.toFloat(),
                                steps = (((maxCallRate - minCallRate) / 100) - 1).coerceAtLeast(0),
                                colors = SliderDefaults.colors(thumbColor = c.brandPrimary, activeTrackColor = c.brandPrimary, inactiveTrackColor = c.borderDefault),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            Row(
                                Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                            ) {
                                Icon(Icons.Default.Lock, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                                Text(
                                    if (maxCallRate == 0) "Verified hosts can set their own rate" else "Reach Host Level 3 to unlock custom rates",
                                    style = ZipperTheme.type.bodyS, color = c.textSecondary,
                                )
                            }
                        }
                    }
                }

                // ── Gallery ───────────────────────────────────────────────
                val totalGallery = state.editMediaUrls.size + state.editNewMediaUris.size
                val canAddMore = totalGallery < 10
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        EditLabel("Gallery")
                        Text("$totalGallery / 10 · photos & videos", style = ZipperTheme.type.caption, color = c.textMuted)
                    }
                    GalleryEditGrid(
                        existingUrls = state.editMediaUrls,
                        existingThumbs = state.editMediaThumbs,
                        newUris = state.editNewMediaUris,
                        canAddMore = canAddMore,
                        onRemoveUrl = { viewModel.removeExistingMediaUrl(it) },
                        onRemoveUri = { viewModel.removeNewMediaUri(it) },
                        onAddClick = pickMedia,
                    )
                }

                Spacer(Modifier.navigationBarsPadding())
            }

            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding()) { data ->
                Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
            }
        }
    }

    if (showDatePicker) {
        val minAgeMillis = remember { Calendar.getInstance().apply { add(Calendar.YEAR, -14) }.timeInMillis }
        val datePickerState = rememberDatePickerState(
            initialSelectedDateMillis = state.editDob.takeIf { it > 0L }
                ?: Calendar.getInstance().apply { add(Calendar.YEAR, -25) }.timeInMillis,
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean = utcTimeMillis <= minAgeMillis
            },
        )
        val pickerColors = DatePickerDefaults.colors(
            containerColor = c.bgElevated,
            selectedDayContainerColor = c.brandPrimary, selectedYearContainerColor = c.brandPrimary,
            todayContentColor = c.textBrand, todayDateBorderColor = c.brandPrimary, currentYearContentColor = c.textBrand,
        )
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    datePickerState.selectedDateMillis?.let { millis ->
                        viewModel.onDobChange(millis)
                        viewModel.onAgeChange(calculateAge(millis))
                    }
                    showDatePicker = false
                }) { Text("OK", color = c.textBrand) }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("Cancel", color = c.textSecondary) } },
            colors = pickerColors,
        ) { DatePicker(state = datePickerState, colors = pickerColors) }
    }

    if (showLanguagePicker) {
        LanguagePickerSheet(
            selected = state.editLanguages,
            onDismiss = { showLanguagePicker = false },
            onConfirm = { langs -> viewModel.onLanguagesChange(langs); showLanguagePicker = false },
        )
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun EditLabel(text: String) {
    Text(text, style = ZipperTheme.type.labelM, color = ZipperTheme.colors.textSecondary)
}

/** 56h r16 input container on bg/elevated with a hairline border. */
@Composable
private fun EditBox(
    modifier: Modifier = Modifier,
    minHeight: Dp = 56.dp,
    onClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val c = ZipperTheme.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = minHeight)
            .background(c.bgElevated, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
            .then(if (onClick != null) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.lg, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun EditField(label: String, value: String, onValueChange: (String) -> Unit, placeholder: String, keyboardType: KeyboardType = KeyboardType.Text) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        EditLabel(label)
        EditBox {
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipSection(title: String, hint: String, options: List<String>, selected: List<String>, onToggle: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            EditLabel(title)
            Text(hint, style = ZipperTheme.type.caption, color = ZipperTheme.colors.textMuted)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            options.forEach { SelectChip(it, selected = selected.contains(it), onClick = { onToggle(it) }) }
        }
    }
}

@Composable
private fun LockedRow(label: String, value: String) {
    val c = ZipperTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = ZipperTheme.type.bodyS, color = c.textMuted)
        Text(value, style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.lg))
    }
}

// ── Gallery grid ─────────────────────────────────────────────────────────────

private class GalleryTile(val model: Any, val isVideo: Boolean, val onRemove: () -> Unit)

@Composable
private fun GalleryEditGrid(
    existingUrls: List<String>,
    existingThumbs: List<String> = emptyList(),
    newUris: List<Uri>,
    canAddMore: Boolean,
    onRemoveUrl: (String) -> Unit,
    onRemoveUri: (Uri) -> Unit,
    onAddClick: () -> Unit,
) {
    val context = LocalContext.current
    // null = the trailing "Add" tile
    val tiles: List<GalleryTile?> = buildList {
        existingUrls.forEachIndexed { idx, url ->
            val isVideo = url.isVideoUrl()
            // Use the stored thumbnail for videos; the image URL directly for photos
            val model: Any = if (isVideo) existingThumbs.getOrNull(idx)?.takeIf { it.isNotBlank() } ?: url else url
            add(GalleryTile(model, isVideo) { onRemoveUrl(url) })
        }
        // Newly picked items (not yet uploaded) — VideoFrameDecoder handles local video URIs via Coil
        newUris.forEach { uri ->
            val isVideo = (context.contentResolver.getType(uri) ?: "").startsWith("video/")
            add(GalleryTile(uri, isVideo) { onRemoveUri(uri) })
        }
        if (canAddMore) add(null)
    }
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        tiles.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                row.forEach { t -> if (t == null) AddTile(Modifier.weight(1f), onAddClick) else GalleryEditThumb(t, Modifier.weight(1f)) }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun GalleryEditThumb(tile: GalleryTile, modifier: Modifier) {
    val c = ZipperTheme.colors
    Box(modifier.aspectRatio(1f).clip(RoundedCornerShape(Radius.md)).background(c.bgElevated)) {
        AsyncImage(tile.model, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (tile.isVideo) {
            Box(Modifier.align(Alignment.Center).size(28.dp).background(c.scrimStrong, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Color.White, modifier = Modifier.size(16.dp))
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).padding(Space.xs).size(22.dp).background(c.scrimStrong, CircleShape).clickableNoRipple(tile.onRemove),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Default.Close, "Remove", tint = Color.White, modifier = Modifier.size(13.dp)) }
    }
}

@Composable
private fun AddTile(modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        modifier.aspectRatio(1f).background(c.bgElevated, RoundedCornerShape(Radius.md)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.md)).clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Icon(Icons.Default.Add, null, tint = c.textBrand, modifier = Modifier.size(24.dp))
            Text("Add", style = ZipperTheme.type.labelS, color = c.textBrand)
        }
    }
}

private fun String.isVideoUrl(): Boolean {
    // Firebase Storage URLs have ?alt=media&token=... so endsWith doesn't work.
    val lower = lowercase()
    return lower.contains(".mp4") || lower.contains(".mov") ||
           lower.contains(".webm") || lower.contains(".mkv") ||
           lower.contains("/video/") || lower.contains("video%2F")
}

// ── DOB helpers ───────────────────────────────────────────────────────────────

private fun formatDob(millis: Long): String {
    if (millis <= 0L) return ""
    return SimpleDateFormat("dd MMM yyyy", Locale.getDefault()).format(Date(millis))
}

private fun calculateAge(dobMillis: Long): Int {
    if (dobMillis <= 0L) return 0
    val dob = Calendar.getInstance().apply { timeInMillis = dobMillis }
    val today = Calendar.getInstance()
    var age = today.get(Calendar.YEAR) - dob.get(Calendar.YEAR)
    if (today.get(Calendar.DAY_OF_YEAR) < dob.get(Calendar.DAY_OF_YEAR)) age--
    return age.coerceAtLeast(0)
}

private fun suggestLanguages(context: Context): List<UserLanguage> {
    val result = mutableListOf<UserLanguage>()
    val deviceCode = Locale.getDefault().language
    languageByCode(deviceCode)?.toUserLanguage()?.let { result.add(it) }
    if (deviceCode != "en") languageByCode("en")?.toUserLanguage()?.let { result.add(it) }
    return result
}
