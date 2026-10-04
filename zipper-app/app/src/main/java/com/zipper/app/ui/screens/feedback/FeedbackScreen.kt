package com.zipper.app.ui.screens.feedback

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayCircleOutline
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.storage.FirebaseStorage
import com.zipper.app.ui.components.ButtonSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.Chip
import com.zipper.app.ui.components.EmptyState
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.screens.home.SelectChip
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.util.Calendar
import javax.inject.Inject
import com.zipper.app.util.millis

// ---------------------------------------------------------------------------
// UI State & Models
// ---------------------------------------------------------------------------

data class FeedbackUiState(
    val selectedCategory: String = "general",
    val subject: String = "",
    val message: String = "",
    val issueTime: Long = 0L,               // epoch ms; 0 = not specified
    val selectedUris: List<Uri> = emptyList(),
    val isUploading: Boolean = false,
    val uploadProgress: Float = 0f,         // 0..1 across all attachments
    val isSubmitting: Boolean = false,
    val isSuccess: Boolean = false,
    val errorMsg: String? = null,
    val myTickets: List<FeedbackTicket> = emptyList(),
    val isLoadingTickets: Boolean = false,
)

data class FeedbackTicket(
    val id: String = "",
    val category: String = "",
    val subject: String = "",
    val message: String = "",
    val status: String = "open",
    val response: String = "",
    val createdAt: Long = 0L,
    val issueOccurredAt: Long = 0L,
    val attachmentUrls: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------------

@HiltViewModel
class FeedbackViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
    @ApplicationContext private val appContext: android.content.Context,
) : ViewModel() {

    private val _uiState = MutableStateFlow(FeedbackUiState())
    val uiState: StateFlow<FeedbackUiState> = _uiState.asStateFlow()

    init { load() }

    private fun load() {
        val uid = auth.currentUser?.uid ?: return
        _uiState.update { it.copy(isLoadingTickets = true) }
        viewModelScope.launch {
            try {
                val snap = firestore.collection("feedbackTickets")
                    .whereEqualTo("userId", uid)
                    .orderBy("createdAt", com.google.firebase.firestore.Query.Direction.DESCENDING)
                    .limit(20)
                    .get().await()
                val tickets = snap.documents.mapNotNull { doc ->
                    @Suppress("UNCHECKED_CAST")
                    FeedbackTicket(
                        id               = doc.id,
                        category         = doc.getString("category") ?: "general",
                        subject          = doc.getString("subject") ?: "",
                        message          = doc.getString("message") ?: "",
                        status           = doc.getString("status") ?: "open",
                        response         = doc.getString("response") ?: "",
                        createdAt        = doc.millis("createdAt"),
                        issueOccurredAt  = doc.getLong("issueOccurredAt") ?: 0L,
                        attachmentUrls   = (doc.get("attachmentUrls") as? List<String>) ?: emptyList(),
                    )
                }
                _uiState.update { it.copy(myTickets = tickets, isLoadingTickets = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isLoadingTickets = false) }
            }
        }
    }

    fun updateCategory(c: String) = _uiState.update { it.copy(selectedCategory = c) }
    fun updateSubject(s: String)   = _uiState.update { it.copy(subject = s) }
    fun updateMessage(m: String)   = _uiState.update { it.copy(message = m) }
    fun updateIssueTime(ms: Long)  = _uiState.update { it.copy(issueTime = ms) }

    fun addAttachments(uris: List<Uri>) {
        _uiState.update { current ->
            val combined = (current.selectedUris + uris).distinct().take(4)
            current.copy(selectedUris = combined)
        }
    }

    fun removeAttachment(uri: Uri) {
        _uiState.update { it.copy(selectedUris = it.selectedUris - uri) }
    }

    fun submitTicket() {
        val state = _uiState.value
        if (state.subject.isBlank() || state.message.isBlank()) {
            _uiState.update { it.copy(errorMsg = "Subject and message cannot be empty.") }
            return
        }
        val uid = auth.currentUser?.uid ?: run {
            _uiState.update { it.copy(errorMsg = "You must be logged in to submit a ticket.") }
            return
        }
        _uiState.update { it.copy(isSubmitting = true, isUploading = state.selectedUris.isNotEmpty(), errorMsg = null) }
        viewModelScope.launch {
            try {
                // 1. Upload attachments
                val attachmentUrls = mutableListOf<String>()
                val total = state.selectedUris.size.coerceAtLeast(1).toFloat()
                state.selectedUris.forEachIndexed { idx, uri ->
                    val ext = appContext.contentResolver.getType(uri)?.substringAfter("/") ?: "jpg"
                    val ref = storage.reference.child(
                        "feedbackAttachments/$uid/${System.currentTimeMillis()}_$idx.$ext"
                    )
                    val stream = appContext.contentResolver.openInputStream(uri)
                    if (stream != null) {
                        ref.putStream(stream).await()
                        stream.close()
                        val url = ref.downloadUrl.await().toString()
                        attachmentUrls.add(url)
                    }
                    _uiState.update { it.copy(uploadProgress = (idx + 1) / total) }
                }

                // 2. Fetch user info
                val userDoc = firestore.collection("users").document(uid).get().await()
                val userName  = userDoc.getString("name") ?: userDoc.getString("displayName") ?: ""
                val userPhone = userDoc.getString("phoneNumber") ?: ""

                // 3. Write to Firestore
                val data = hashMapOf(
                    "userId"          to uid,
                    "userName"        to userName,
                    "userPhone"       to userPhone,
                    "category"        to state.selectedCategory,
                    "subject"         to state.subject,
                    "message"         to state.message,
                    "issueOccurredAt" to state.issueTime,
                    "attachmentUrls"  to attachmentUrls,
                    "status"          to "open",
                    "priority"        to "medium",
                    "createdAt"       to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                    "response"        to "",
                    "assignedTo"      to "",
                    "assignedTeam"    to "",
                )
                firestore.collection("feedbackTickets").add(data).await()

                _uiState.update {
                    it.copy(
                        isSubmitting    = false,
                        isUploading     = false,
                        uploadProgress  = 0f,
                        isSuccess       = true,
                        subject         = "",
                        message         = "",
                        issueTime       = 0L,
                        selectedUris    = emptyList(),
                    )
                }
                load()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSubmitting   = false,
                        isUploading    = false,
                        uploadProgress = 0f,
                        errorMsg       = e.localizedMessage ?: "Failed to submit. Please try again.",
                    )
                }
            }
        }
    }

    fun clearSuccess() = _uiState.update { it.copy(isSuccess = false) }
    fun clearError()   = _uiState.update { it.copy(errorMsg = null) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private fun formatDate(ts: Long): String {
    if (ts == 0L) return ""
    return java.text.SimpleDateFormat("dd MMM yyyy, h:mm a", java.util.Locale.getDefault())
        .format(java.util.Date(ts))
}

private fun isVideoUri(context: android.content.Context, uri: Uri): Boolean {
    val mime = context.contentResolver.getType(uri) ?: ""
    return mime.startsWith("video/")
}

private val CATEGORIES = listOf(
    "login"        to "🔐 Login / Auth",
    "payment"      to "💳 Payment",
    "recharge"     to "💎 Recharge",
    "video_call"   to "📞 Video Call",
    "live_stream"  to "📡 Live Stream",
    "account"      to "👤 Account",
    "bug"          to "🐛 Bug Report",
    "general"      to "💬 General",
)

private const val MESSAGE_MAX = 1000

// ---------------------------------------------------------------------------
// Screen — Figma "04 Feedback" / "14 Categorised feedback"
// ---------------------------------------------------------------------------

@Composable
fun FeedbackScreen(
    onBack: () -> Unit,
    viewModel: FeedbackViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val c = ZipperTheme.colors
    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf("New ticket", "My tickets")

    ZipperScreen(topBar = { TopBar("Help & support", onBack = onBack) }) { _ ->
        Column(Modifier.fillMaxSize()) {
            // Segmented control
            Row(
                Modifier.padding(start = Space.lg, end = Space.lg, bottom = Space.sm).fillMaxWidth().height(38.dp).background(c.bgRaised, CircleShape).padding(2.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                tabs.forEachIndexed { i, t ->
                    val on = selectedTab == i
                    Box(
                        Modifier.weight(1f).fillMaxHeight()
                            .then(if (on) Modifier.background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape) else Modifier)
                            .clickableNoRipple { selectedTab = i },
                        contentAlignment = Alignment.Center,
                    ) { Text(t, style = ZipperTheme.type.labelM, color = if (on) Color.White else c.textMuted) }
                }
            }

            if (selectedTab == 0) NewTicketTab(uiState = uiState, viewModel = viewModel)
            else MyTicketsTab(uiState = uiState)
        }
    }
}

// ---------------------------------------------------------------------------
// Tab 0 — New Ticket
// ---------------------------------------------------------------------------

@Composable
private fun NewTicketTab(
    uiState: FeedbackUiState,
    viewModel: FeedbackViewModel,
) {
    val c = ZipperTheme.colors
    val context = LocalContext.current

    // Media picker — images + videos
    val mediaPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isNotEmpty()) viewModel.addAttachments(uris)
    }

    // Date + time picker (launched on click — safe, not during composition)
    val onPickDateTime: () -> Unit = {
        val cal = Calendar.getInstance()
        if (uiState.issueTime > 0L) cal.timeInMillis = uiState.issueTime
        DatePickerDialog(
            context,
            { _, year, month, day ->
                cal.set(year, month, day)
                TimePickerDialog(
                    context,
                    { _, hour, minute ->
                        cal.set(Calendar.HOUR_OF_DAY, hour)
                        cal.set(Calendar.MINUTE, minute)
                        cal.set(Calendar.SECOND, 0)
                        viewModel.updateIssueTime(cal.timeInMillis)
                    },
                    cal.get(Calendar.HOUR_OF_DAY),
                    cal.get(Calendar.MINUTE),
                    false,
                ).show()
            },
            cal.get(Calendar.YEAR),
            cal.get(Calendar.MONTH),
            cal.get(Calendar.DAY_OF_MONTH),
        ).also { it.datePicker.maxDate = System.currentTimeMillis() }.show()
    }

    // Success state — EmptyState-like card
    if (uiState.isSuccess) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.lg)) {
            Column(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)),
            ) {
                EmptyState(Icons.Outlined.CheckCircle, "Ticket sent", "We read every ticket and reply here under My tickets, usually within a day.", actionLabel = "Send another", onAction = { viewModel.clearSuccess() })
            }
            Spacer(Modifier.navigationBarsPadding())
        }
        return
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        // ── Category ──
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("CATEGORY", style = ZipperTheme.type.overline, color = c.textMuted)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                CATEGORIES.forEach { (key, label) ->
                    SelectChip(label, selected = uiState.selectedCategory == key) { viewModel.updateCategory(key) }
                }
            }
        }

        // ── Subject ──
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("SUBJECT", style = ZipperTheme.type.overline, color = c.textMuted)
            FieldBox(uiState.subject, viewModel::updateSubject, placeholder = "What is this about?", singleLine = true, modifier = Modifier.fillMaxWidth().height(52.dp))
        }

        // ── Message ──
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("DESCRIBE YOUR ISSUE", style = ZipperTheme.type.overline, color = c.textMuted, modifier = Modifier.weight(1f))
                Text("${uiState.message.length} / $MESSAGE_MAX", style = ZipperTheme.type.caption, color = if (uiState.message.length > MESSAGE_MAX) c.statusDanger else c.textMuted)
            }
            FieldBox(uiState.message, viewModel::updateMessage, placeholder = "Tell us what happened, step by step.", singleLine = false, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
        }

        // ── When did the issue occur? ──
        Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text("WHEN DID IT HAPPEN?", style = ZipperTheme.type.overline, color = c.textMuted)
            val set = uiState.issueTime > 0L
            Row(
                Modifier.fillMaxWidth().height(52.dp).background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).clickableNoRipple(onPickDateTime).padding(horizontal = Space.lg),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Icon(Icons.Outlined.CalendarToday, null, tint = if (set) c.brandPrimary else c.textMuted, modifier = Modifier.size(20.dp))
                Text(if (set) formatDate(uiState.issueTime) else "Tap to pick date & time", style = ZipperTheme.type.bodyL, color = if (set) c.textPrimary else c.textMuted)
            }
            if (set) Text("Tap the field above to change", style = ZipperTheme.type.caption, color = c.textMuted)
        }

        // ── Attachments ──
        Column(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Attachments", style = ZipperTheme.type.labelM, color = c.textPrimary, modifier = Modifier.weight(1f))
                Text("${uiState.selectedUris.size} / 4", style = ZipperTheme.type.caption, color = c.textMuted)
            }
            Box(Modifier.fillMaxWidth().background(c.tintBrandSubtle, RoundedCornerShape(Radius.sm)).padding(horizontal = Space.md, vertical = Space.sm)) {
                Text(
                    "📸  This app blocks screenshots & screen recording. Use another device to photograph the screen, then upload the photo here.",
                    style = ZipperTheme.type.bodyS, color = c.textBrand,
                )
            }

            if (uiState.selectedUris.isNotEmpty()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    uiState.selectedUris.forEach { uri ->
                        AttachmentThumb(uri = uri, isVideo = isVideoUri(context, uri), onRemove = { viewModel.removeAttachment(uri) }, modifier = Modifier.weight(1f))
                    }
                    repeat(4 - uiState.selectedUris.size) { Spacer(Modifier.weight(1f)) }
                }
            }

            if (uiState.selectedUris.size < 4) {
                ZipperButton(
                    if (uiState.selectedUris.isEmpty()) "Add photo / video" else "Add more",
                    onClick = { mediaPicker.launch(arrayOf("image/*", "video/*")) },
                    style = ButtonStyle.Secondary, size = ButtonSize.Medium,
                    icon = Icons.Outlined.AddPhotoAlternate, fullWidth = true,
                )
            }
        }

        // ── Upload progress ──
        if (uiState.isUploading) {
            Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text("Uploading attachments…", style = ZipperTheme.type.caption, color = c.textSecondary)
                LinearProgressIndicator(
                    progress = { uiState.uploadProgress },
                    modifier = Modifier.fillMaxWidth().clip(CircleShape),
                    color = c.brandPrimary, trackColor = c.tintBrandSubtle,
                )
            }
        }

        // ── Submit ──
        val canSubmit = !uiState.isSubmitting && !uiState.isUploading &&
            uiState.subject.isNotBlank() && uiState.message.isNotBlank()
        ZipperButton(
            when {
                uiState.isUploading  -> "Uploading…"
                uiState.isSubmitting -> "Sending…"
                else                 -> "Send"
            },
            onClick = { viewModel.submitTicket() },
            enabled = canSubmit, loading = uiState.isSubmitting, gradient = true, fullWidth = true,
        )

        // ── Error ──
        if (uiState.errorMsg != null) {
            Row(
                Modifier.fillMaxWidth().background(c.tintDangerSubtle, RoundedCornerShape(Radius.md)).padding(horizontal = Space.md, vertical = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(uiState.errorMsg, style = ZipperTheme.type.bodyS, color = c.statusDanger, modifier = Modifier.weight(1f))
                Icon(Icons.Default.Close, "Dismiss", tint = c.statusDanger, modifier = Modifier.size(16.dp).clickableNoRipple { viewModel.clearError() })
            }
        }

        Spacer(Modifier.navigationBarsPadding())
    }
}

/** Standard text field: bgElevated, Radius.lg, borderDefault, brand cursor. */
@Composable
private fun FieldBox(value: String, onValueChange: (String) -> Unit, placeholder: String, singleLine: Boolean, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    Row(
        modifier.background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg, vertical = if (singleLine) 0.dp else Space.md),
        verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
    ) {
        BasicTextField(
            value = value, onValueChange = onValueChange,
            singleLine = singleLine,
            textStyle = ZipperTheme.type.bodyL.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.brandPrimary),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text(placeholder, style = ZipperTheme.type.bodyL, color = c.textMuted)
                    inner()
                }
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Attachment thumbnail
// ---------------------------------------------------------------------------

@Composable
private fun AttachmentThumb(
    uri: Uri,
    isVideo: Boolean,
    onRemove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = ZipperTheme.colors
    Box(modifier.aspectRatio(1f).clip(RoundedCornerShape(Radius.sm)).background(c.bgRaised)) {
        AsyncImage(model = uri, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (isVideo) {
            Box(Modifier.fillMaxSize().background(c.scrimSoft), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayCircleOutline, null, tint = Color.White, modifier = Modifier.size(28.dp))
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).padding(Space.xs).size(20.dp).background(c.scrimStrong, CircleShape).clickableNoRipple(onRemove),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Default.Close, "Remove", tint = Color.White, modifier = Modifier.size(12.dp)) }
    }
}

// ---------------------------------------------------------------------------
// Tab 1 — My Tickets
// ---------------------------------------------------------------------------

@Composable
private fun MyTicketsTab(uiState: FeedbackUiState) {
    when {
        uiState.isLoadingTickets -> LoadingState()
        uiState.myTickets.isEmpty() -> EmptyState(Icons.Outlined.ConfirmationNumber, "No tickets yet", "Send a ticket from the New ticket tab and replies will show up here.")
        else -> LazyColumn(
            contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            items(uiState.myTickets, key = { it.id }) { ticket -> TicketCard(ticket = ticket) }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

// ---------------------------------------------------------------------------
// Ticket Card
// ---------------------------------------------------------------------------

@Composable
private fun TicketCard(ticket: FeedbackTicket) {
    val c = ZipperTheme.colors
    val categoryLabel = CATEGORIES.firstOrNull { it.first == ticket.category }?.second ?: ticket.category
    val sColor = when (ticket.status) {
        "open"                    -> c.statusWarning
        "assigned", "in_progress" -> c.currencyDiamond
        "resolved"                -> c.statusSuccess
        "closed"                  -> c.textMuted
        else                      -> c.textMuted
    }

    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.lg),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Chip(categoryLabel, tint = c.glassMid, contentColor = c.textSecondary)
            Spacer(Modifier.weight(1f))
            Chip(ticket.status.replace("_", " ").replaceFirstChar { it.uppercase() }, tint = sColor.copy(alpha = 0.14f), contentColor = sColor)
        }

        Text(ticket.subject, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (ticket.message.isNotBlank()) Text(ticket.message, style = ZipperTheme.type.bodyS, color = c.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis)

        if (ticket.issueOccurredAt > 0L) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Icon(Icons.Outlined.CalendarToday, null, tint = c.textMuted, modifier = Modifier.size(12.dp))
                Text("Issue at: ${formatDate(ticket.issueOccurredAt)}", style = ZipperTheme.type.caption, color = c.textMuted)
            }
        }

        if (ticket.attachmentUrls.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ticket.attachmentUrls.take(4).forEach { url ->
                    AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(52.dp).clip(RoundedCornerShape(Radius.sm)).background(c.bgRaised))
                }
            }
        }

        if (ticket.response.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md)).padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                Text("Reply from Zipper", style = ZipperTheme.type.caption, color = c.textBrand)
                Text(ticket.response, style = ZipperTheme.type.bodyS, color = c.textPrimary)
            }
        }

        Text(formatDate(ticket.createdAt), style = ZipperTheme.type.caption, color = c.textMuted)
    }
}
