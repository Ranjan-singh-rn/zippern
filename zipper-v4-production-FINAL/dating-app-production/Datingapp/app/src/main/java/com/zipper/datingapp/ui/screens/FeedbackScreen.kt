package com.zipper.datingapp.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.datingapp.ui.DatingViewModel
import com.zipper.datingapp.ui.theme.AppBackground
import com.zipper.datingapp.ui.theme.AppContainer
import com.zipper.datingapp.ui.theme.AppSurface
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextPrimary
import com.zipper.datingapp.ui.theme.TextSecondary
import androidx.activity.compose.BackHandler
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.text.SimpleDateFormat
import java.util.*

// ─────────────────────────────────────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────────────────────────────────────

private enum class FeedbackType { NONE, PAYMENT, LOGIN }

private val PAYMENT_SUBTYPES = listOf(
    "Diamond not received",
    "Wrong amount charged",
    "Payment failed",
    "Duplicate charge",
    "Other",
)

private val LOGIN_SUBTYPES = listOf(
    "Can't login",
    "Account suspended / banned",
    "OTP not received",
    "Lost access to phone number",
    "Account hacked",
    "Other",
)

private data class TicketItem(
    val id: String,
    val type: String,        // "PAYMENT" | "LOGIN"
    val subType: String,
    val description: String,
    val status: String,      // "PENDING" | "IN_REVIEW" | "RESOLVED" | "DISMISSED"
    val createdAt: Long,
    val resolvedAt: Long?,
    val staffNote: String?,  // Message from support team
)

private data class ReportStatusItem(
    val id: String,
    val reportedUserId: String,
    val reason: String,
    val status: String,      // "PENDING" | "UNDER_REVIEW" | "WARNING_ISSUED" | "PENALTY_APPLIED" | "DISMISSED"
    val createdAt: Long,
    val reviewedAt: Long?,
)

// ─────────────────────────────────────────────────────────────────────────────
// FIRESTORE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

private suspend fun submitFeedbackToFirestore(
    type: FeedbackType,
    subType: String,
    description: String,
    transactionId: String,
    contactPhone: String,
) {
    val uid = FirebaseAuth.getInstance().currentUser?.uid ?: "anonymous"
    val doc = hashMapOf(
        "uid"           to uid,
        "type"          to type.name,
        "subType"       to subType,
        "description"   to description,
        "transactionId" to transactionId.ifBlank { null },
        "contactPhone"  to contactPhone.ifBlank { null },
        "createdAt"     to System.currentTimeMillis(),
        "status"        to "PENDING",
        "resolvedAt"    to null,
        "resolvedBy"    to null,
        "staffNote"     to null,
    )
    FirebaseFirestore.getInstance().collection("feedback").add(doc).await()
}

private suspend fun fetchMyTickets(uid: String): List<TicketItem> {
    val snapshot = FirebaseFirestore.getInstance()
        .collection("feedback")
        .whereEqualTo("uid", uid)
        .orderBy("createdAt", Query.Direction.DESCENDING)
        .limit(20)
        .get()
        .await()

    return snapshot.documents.mapNotNull { doc ->
        val data = doc.data ?: return@mapNotNull null
        TicketItem(
            id          = doc.id,
            type        = data["type"] as? String ?: "",
            subType     = data["subType"] as? String ?: "",
            description = data["description"] as? String ?: "",
            status      = data["status"] as? String ?: "PENDING",
            createdAt   = data["createdAt"] as? Long ?: 0L,
            resolvedAt  = data["resolvedAt"] as? Long,
            staffNote   = data["staffNote"] as? String,
        )
    }
}

private suspend fun fetchMyReports(uid: String): List<ReportStatusItem> {
    val snapshot = FirebaseFirestore.getInstance()
        .collection("reports")
        .whereEqualTo("reporterId", uid)
        .orderBy("createdAt", Query.Direction.DESCENDING)
        .limit(20)
        .get()
        .await()

    return snapshot.documents.mapNotNull { doc ->
        val data = doc.data ?: return@mapNotNull null
        ReportStatusItem(
            id             = doc.id,
            reportedUserId = data["reportedUserId"] as? String ?: "",
            reason         = data["reason"] as? String ?: "",
            status         = data["status"] as? String ?: "PENDING",
            createdAt      = data["createdAt"] as? Long ?: 0L,
            reviewedAt     = data["reviewedAt"] as? Long,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackScreen(
    viewModel: DatingViewModel,
    onBack: () -> Unit,
) {
    BackHandler(onBack = onBack)
    var selectedTab by remember { mutableStateOf(0) }  // 0=Submit, 1=My Tickets, 2=My Reports

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "Feedback & Support",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 20.sp,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = TextPrimary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppBackground),
            )
        },
        containerColor = AppBackground,
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            // ── Tab row ───────────────────────────────────────────────────────
            TabRow(
                selectedTabIndex = selectedTab,
                containerColor = AppBackground,
                contentColor = BrandPink,
            ) {
                Tab(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    text = { Text("Submit Issue", fontSize = 13.sp) },
                )
                Tab(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    text = { Text("My Tickets", fontSize = 13.sp) },
                )
                Tab(
                    selected = selectedTab == 2,
                    onClick = { selectedTab = 2 },
                    text = { Text("My Reports", fontSize = 13.sp) },
                )
            }

            when (selectedTab) {
                0 -> SubmitFeedbackTab()
                1 -> MyTicketsTab()
                2 -> MyReportsTab()
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — SUBMIT NEW ISSUE
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubmitFeedbackTab() {
    var selectedType  by remember { mutableStateOf(FeedbackType.NONE) }
    var subType       by remember { mutableStateOf("") }
    var description   by remember { mutableStateOf("") }
    var transactionId by remember { mutableStateOf("") }
    var contactPhone  by remember { mutableStateOf("") }
    var isSubmitting  by remember { mutableStateOf(false) }
    var submitSuccess by remember { mutableStateOf(false) }
    var submitError   by remember { mutableStateOf<String?>(null) }

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(submitError) {
        submitError?.let {
            snackbarHostState.showSnackbar("Error: $it")
            submitError = null
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (submitSuccess) {
            // ── Success state ─────────────────────────────────────────────────
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(88.dp)
                        .clip(CircleShape)
                        .background(Color(0xFF52B788).copy(0.15f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.CheckCircle, null, tint = Color(0xFF52B788), modifier = Modifier.size(52.dp))
                }
                Spacer(Modifier.height(20.dp))
                Text("Ticket Submitted!", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "Our support team will review your issue within 24–48 hours. Check \"My Tickets\" tab for status updates.",
                    color = TextSecondary,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp,
                )
                Spacer(Modifier.height(24.dp))
                Button(
                    onClick = {
                        submitSuccess = false
                        selectedType = FeedbackType.NONE
                        subType = ""; description = ""; transactionId = ""; contactPhone = ""
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = BrandPink),
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(0.65f),
                ) {
                    Text("Submit Another", fontWeight = FontWeight.Bold)
                }
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("How can we help?", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Text("Select the type of issue you're experiencing.", color = TextSecondary, fontSize = 13.sp)

                Spacer(Modifier.height(4.dp))

                FeedbackTypeCard(
                    icon = Icons.Default.Payment,
                    title = "Payment Issue",
                    subtitle = "Diamonds not received, wrong charge, payment failed",
                    gradient = listOf(Color(0xFF7B61FF).copy(0.25f), Color(0xFF4B0082).copy(0.15f)),
                    accentColor = BrandPurple,
                    selected = selectedType == FeedbackType.PAYMENT,
                    onClick = { selectedType = FeedbackType.PAYMENT; subType = ""; transactionId = ""; contactPhone = "" },
                )

                FeedbackTypeCard(
                    icon = Icons.Default.Lock,
                    title = "Login / Account Issue",
                    subtitle = "Can't login, account suspended, OTP not received",
                    gradient = listOf(Color(0xFFFF4D6D).copy(0.25f), Color(0xFF8B0000).copy(0.15f)),
                    accentColor = BrandPink,
                    selected = selectedType == FeedbackType.LOGIN,
                    onClick = { selectedType = FeedbackType.LOGIN; subType = ""; transactionId = ""; contactPhone = "" },
                )

                AnimatedVisibility(
                    visible = selectedType != FeedbackType.NONE,
                    enter = expandVertically(),
                    exit = shrinkVertically(),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        HorizontalDivider(color = OutlineDefault.copy(0.5f))

                        val subtypes = if (selectedType == FeedbackType.PAYMENT) PAYMENT_SUBTYPES else LOGIN_SUBTYPES

                        FeedbackDropdown(
                            label = "Issue Type",
                            options = subtypes,
                            selected = subType,
                            onSelect = { subType = it },
                        )

                        if (selectedType == FeedbackType.PAYMENT) {
                            FeedbackTextField(
                                value = transactionId, onValueChange = { transactionId = it },
                                label = "Transaction ID (optional)", placeholder = "e.g. TXN123456789",
                                singleLine = true, maxLength = 100,
                            )
                        } else {
                            FeedbackTextField(
                                value = contactPhone, onValueChange = { contactPhone = it },
                                label = "Registered Phone Number (optional)", placeholder = "e.g. +91 98765 43210",
                                singleLine = true, maxLength = 20,
                            )
                        }

                        FeedbackTextField(
                            value = description,
                            onValueChange = { if (it.length <= 500) description = it },
                            label = "Describe your issue",
                            placeholder = "Please provide as much detail as possible…",
                            singleLine = false,
                            minLines = 4,
                            maxLines = 7,
                            maxLength = 500,
                            showCharCount = true,
                        )

                        val canSubmit = subType.isNotBlank() && description.isNotBlank() && !isSubmitting

                        Button(
                            onClick = {
                                scope.launch {
                                    isSubmitting = true
                                    try {
                                        submitFeedbackToFirestore(
                                            type = selectedType,
                                            subType = subType,
                                            description = description,
                                            transactionId = transactionId,
                                            contactPhone = contactPhone,
                                        )
                                        submitSuccess = true
                                    } catch (e: Exception) {
                                        submitError = e.message ?: "Unknown error"
                                    } finally {
                                        isSubmitting = false
                                    }
                                }
                            },
                            enabled = canSubmit,
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            shape = RoundedCornerShape(16.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = BrandPink,
                                contentColor = Color.White,
                                disabledContainerColor = OutlineDefault,
                                disabledContentColor = TextMuted,
                            ),
                        ) {
                            if (isSubmitting) {
                                CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            } else {
                                Text("Submit Ticket", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            }
                        }

                        Spacer(Modifier.height(16.dp))
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2 — MY TICKETS (check status of submitted issues)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun MyTicketsTab() {
    val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
    var tickets by remember { mutableStateOf<List<TicketItem>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            tickets = fetchMyTickets(uid)
        } catch (e: Exception) {
            error = e.message
        } finally {
            isLoading = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            isLoading -> CircularProgressIndicator(color = BrandPink, modifier = Modifier.align(Alignment.Center))
            error != null -> ErrorState(error!!)
            tickets.isEmpty() -> EmptyState(
                emoji = "📋",
                title = "No tickets yet",
                subtitle = "Submit an issue from the \"Submit Issue\" tab and track its status here.",
            )
            else -> {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Text(
                            "${tickets.size} ticket${if (tickets.size != 1) "s" else ""}",
                            color = TextSecondary,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(bottom = 4.dp),
                        )
                    }
                    items(tickets, key = { it.id }) { ticket ->
                        TicketCard(ticket)
                    }
                }
            }
        }
    }
}

@Composable
private fun TicketCard(ticket: TicketItem) {
    var expanded by remember { mutableStateOf(false) }

    val (statusColor, statusIcon, statusLabel) = when (ticket.status) {
        "IN_REVIEW"  -> Triple(Color(0xFF3B82F6), Icons.Default.Search, "Under Review")
        "RESOLVED"   -> Triple(Color(0xFF52B788), Icons.Default.CheckCircle, "Resolved")
        "DISMISSED"  -> Triple(Color(0xFF6B7280), Icons.Default.Cancel, "Dismissed")
        else         -> Triple(Color(0xFFF59E0B), Icons.Default.HourglassEmpty, "Pending")
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded },
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = AppContainer),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Header row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // Type badge
                        Box(
                            modifier = Modifier
                                .background(
                                    if (ticket.type == "PAYMENT") BrandPurple.copy(0.2f) else BrandPink.copy(0.2f),
                                    RoundedCornerShape(6.dp),
                                )
                                .padding(horizontal = 8.dp, vertical = 3.dp),
                        ) {
                            Text(
                                if (ticket.type == "PAYMENT") "💳 Payment" else "🔐 Login",
                                color = if (ticket.type == "PAYMENT") BrandPurple else BrandPink,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(ticket.subType, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(formatTimestamp(ticket.createdAt), color = TextMuted, fontSize = 11.sp)
                }

                // Status pill
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .background(statusColor.copy(0.15f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                ) {
                    Icon(statusIcon, null, tint = statusColor, modifier = Modifier.size(13.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(statusLabel, color = statusColor, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            // Expanded details
            AnimatedVisibility(visible = expanded) {
                Column(modifier = Modifier.padding(top = 12.dp)) {
                    HorizontalDivider(color = OutlineDefault.copy(0.4f))
                    Spacer(Modifier.height(12.dp))

                    Text("Your Description", color = TextSecondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(ticket.description, color = TextPrimary, fontSize = 13.sp, lineHeight = 19.sp)

                    if (!ticket.staffNote.isNullOrBlank()) {
                        Spacer(Modifier.height(12.dp))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFF52B788).copy(0.1f), RoundedCornerShape(10.dp))
                                .border(1.dp, Color(0xFF52B788).copy(0.3f), RoundedCornerShape(10.dp))
                                .padding(12.dp),
                        ) {
                            Column {
                                Text("💬 Support Team Response", color = Color(0xFF52B788), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                Spacer(Modifier.height(4.dp))
                                Text(ticket.staffNote, color = TextPrimary, fontSize = 13.sp, lineHeight = 19.sp)
                                if (ticket.resolvedAt != null) {
                                    Spacer(Modifier.height(4.dp))
                                    Text(formatTimestamp(ticket.resolvedAt), color = TextMuted, fontSize = 11.sp)
                                }
                            }
                        }
                    }

                    if (ticket.status == "PENDING") {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "⏳ Our team will review this within 24–48 hours.",
                            color = Color(0xFFF59E0B),
                            fontSize = 12.sp,
                            lineHeight = 17.sp,
                        )
                    }
                }
            }

            // Expand chevron
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                tint = TextMuted,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .padding(top = 8.dp)
                    .size(18.dp),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3 — MY REPORTS (check status of reports I filed against others)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun MyReportsTab() {
    val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
    var reports by remember { mutableStateOf<List<ReportStatusItem>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            reports = fetchMyReports(uid)
        } catch (e: Exception) {
            error = e.message
        } finally {
            isLoading = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            isLoading -> CircularProgressIndicator(color = BrandPink, modifier = Modifier.align(Alignment.Center))
            error != null -> ErrorState(error!!)
            reports.isEmpty() -> EmptyState(
                emoji = "🚩",
                title = "No reports filed",
                subtitle = "When you report a user, you can track what action our team took here.",
            )
            else -> {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        // Context note
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(BrandPurple.copy(0.1f), RoundedCornerShape(10.dp))
                                .padding(12.dp),
                        ) {
                            Text(
                                "ℹ️ Report outcomes are reviewed by our moderation team. We take all reports seriously but cannot share confidential action details for privacy reasons.",
                                color = TextSecondary,
                                fontSize = 12.sp,
                                lineHeight = 17.sp,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                    items(reports, key = { it.id }) { report ->
                        ReportStatusCard(report)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReportStatusCard(report: ReportStatusItem) {
    val (statusColor, statusLabel, statusEmoji) = when (report.status) {
        "UNDER_REVIEW"    -> Triple(Color(0xFF3B82F6), "Under Review", "🔍")
        "WARNING_ISSUED"  -> Triple(Color(0xFFF59E0B), "Action Taken: Warning", "⚠️")
        "PENALTY_APPLIED" -> Triple(Color(0xFFEF4444), "Action Taken: Penalty", "🚫")
        "SUSPENDED"       -> Triple(Color(0xFFEF4444), "Action Taken: Suspended", "🔒")
        "DISMISSED"       -> Triple(Color(0xFF6B7280), "No Action", "❌")
        else              -> Triple(Color(0xFFF59E0B), "Pending Review", "⏳")
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = AppContainer),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Reported: ${report.reason}",
                        color = TextPrimary,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp,
                    )
                    Spacer(Modifier.height(3.dp))
                    Text("Filed: ${formatTimestamp(report.createdAt)}", color = TextMuted, fontSize = 11.sp)
                    if (report.reviewedAt != null) {
                        Text("Reviewed: ${formatTimestamp(report.reviewedAt)}", color = TextMuted, fontSize = 11.sp)
                    }
                }

                Spacer(Modifier.width(8.dp))

                Box(
                    modifier = Modifier
                        .background(statusColor.copy(0.15f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                ) {
                    Text(
                        "$statusEmoji $statusLabel",
                        color = statusColor,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }

            if (report.status == "PENDING") {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Our moderation team will review this report within 48 hours.",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun FeedbackTypeCard(
    icon: ImageVector,
    title: String,
    subtitle: String,
    gradient: List<Color>,
    accentColor: Color,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(
                Brush.linearGradient(if (selected) gradient else listOf(AppContainer, AppSurface)),
                shape = RoundedCornerShape(18.dp),
            )
            .border(
                width = if (selected) 1.5.dp else 1.dp,
                color = if (selected) accentColor else OutlineDefault,
                shape = RoundedCornerShape(18.dp),
            )
            .clickable(onClick = onClick)
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .background(accentColor.copy(0.15f), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, null, tint = accentColor, modifier = Modifier.size(26.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Spacer(Modifier.height(3.dp))
                Text(subtitle, color = TextSecondary, fontSize = 12.sp, lineHeight = 17.sp)
            }
            if (selected) {
                Icon(Icons.Default.CheckCircle, null, tint = accentColor, modifier = Modifier.size(22.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedbackDropdown(
    label: String,
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)

        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = !expanded }) {
            OutlinedTextField(
                value = selected.ifBlank { "Select an option" },
                onValueChange = {},
                readOnly = true,
                trailingIcon = {
                    Icon(Icons.Default.ArrowDropDown, null, tint = if (expanded) BrandPink else TextSecondary)
                },
                modifier = Modifier.fillMaxWidth().menuAnchor(),
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = BrandPink,
                    unfocusedBorderColor = OutlineDefault,
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = if (selected.isBlank()) TextMuted else TextPrimary,
                    cursorColor = BrandPink,
                    focusedContainerColor = AppContainer,
                    unfocusedContainerColor = AppContainer,
                ),
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.background(AppSurface)) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                option,
                                color = if (option == selected) BrandPink else TextPrimary,
                                fontWeight = if (option == selected) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        },
                        onClick = { onSelect(option); expanded = false },
                    )
                }
            }
        }
    }
}

@Composable
private fun FeedbackTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    singleLine: Boolean,
    minLines: Int = 1,
    maxLines: Int = 1,
    maxLength: Int = 500,
    showCharCount: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, color = TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            if (showCharCount) {
                Text(
                    "${value.length}/$maxLength",
                    color = if (value.length >= maxLength) BrandPink else TextMuted,
                    fontSize = 11.sp,
                )
            }
        }
        OutlinedTextField(
            value = value,
            onValueChange = { if (it.length <= maxLength) onValueChange(it) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(placeholder, color = TextMuted, fontSize = 13.sp) },
            singleLine = singleLine,
            minLines = minLines,
            maxLines = if (singleLine) 1 else maxLines,
            shape = RoundedCornerShape(12.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = BrandPink,
                unfocusedBorderColor = OutlineDefault,
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary,
                cursorColor = BrandPink,
                focusedContainerColor = AppContainer,
                unfocusedContainerColor = AppContainer,
            ),
        )
    }
}

@Composable
private fun EmptyState(emoji: String, title: String, subtitle: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(emoji, fontSize = 48.sp)
            Spacer(Modifier.height(16.dp))
            Text(title, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 18.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Text(subtitle, color = TextSecondary, fontSize = 13.sp, textAlign = TextAlign.Center, lineHeight = 19.sp)
        }
    }
}

@Composable
private fun ErrorState(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
            Icon(Icons.Default.ErrorOutline, null, tint = BrandPink, modifier = Modifier.size(48.dp))
            Spacer(Modifier.height(12.dp))
            Text("Couldn't load data", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Spacer(Modifier.height(6.dp))
            Text(message, color = TextSecondary, fontSize = 12.sp, textAlign = TextAlign.Center)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

private fun formatTimestamp(ms: Long): String {
    if (ms == 0L) return "—"
    return SimpleDateFormat("dd MMM yyyy, hh:mm a", Locale.getDefault()).format(Date(ms))
}
