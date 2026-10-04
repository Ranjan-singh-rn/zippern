package com.zipper.app.ui.screens.agency

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.ktx.firestore
import com.google.firebase.ktx.Firebase
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.screens.profile.ProfileViewModel
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/*
 * My agency.
 *
 *   Top bar: back, "My agency".
 *   Agency card: name, status chip, referral code (numeric M) with copy.
 *   Stats: hosts · sub-agencies · last payout.
 *   Host rows: avatar, name. Empty state tells the owner to share the code.
 *   Weekly payout card with the "Submit report" action.
 */

// ─── Data classes ────────────────────────────────────────────────────────────

private data class AgencyDoc(
    val name: String = "",
    val status: String = "",        // "pending" | "approved" | "rejected"
    val totalHosts: Long = 0L,
    val subAgenciesCount: Long = 0L,
)

private data class AgencyHostItem(
    val uid: String = "",
)

private data class WeeklyPayoutReport(
    val id: String = "",
    val status: String = "",        // "generated" | "submitted"
    val totalPayout: Double = 0.0,
    val weekLabel: String = "",
)

// ─── Screen ───────────────────────────────────────────────────────────────────

@Composable
fun AgencyDashboardScreen(
    onBack: () -> Unit = {},
    profileViewModel: ProfileViewModel = hiltViewModel(),
) {
    val profileState by profileViewModel.state.collectAsStateWithLifecycle()
    val currentUser = profileState.user
    val currentUid = FirebaseAuth.getInstance().currentUser?.uid ?: ""
    val agencyId = currentUser?.agencyId ?: ""
    val referralCode = currentUser?.referralCode ?: ""
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val c = ZipperTheme.colors

    var agencyDoc by remember { mutableStateOf<AgencyDoc?>(null) }
    var hosts by remember { mutableStateOf<List<AgencyHostItem>>(emptyList()) }
    var payoutReport by remember { mutableStateOf<WeeklyPayoutReport?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var submitLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var submitSuccess by remember { mutableStateOf(false) }

    LaunchedEffect(agencyId) {
        if (agencyId.isBlank()) {
            isLoading = false
            return@LaunchedEffect
        }
        try {
            // Fetch agency doc
            val agSnap = Firebase.firestore.collection("agencies").document(agencyId).get().await()
            agencyDoc = AgencyDoc(
                name = agSnap.getString("name") ?: "",
                status = agSnap.getString("status") ?: "pending",
                totalHosts = agSnap.getLong("totalHosts") ?: 0L,
                subAgenciesCount = agSnap.getLong("subAgenciesCount") ?: 0L,
            )

            // Fetch agencyHosts subcollection
            val hostsSnap = Firebase.firestore.collection("agencies").document(agencyId).collection("agencyHosts").get().await()
            hosts = hostsSnap.documents.map { doc -> AgencyHostItem(uid = doc.getString("uid") ?: doc.id) }

            // Fetch latest weeklyPayoutReport for this agency owner
            val reportSnap = Firebase.firestore.collection("weeklyPayoutReports")
                .whereEqualTo("agencyOwnerUid", currentUid)
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .limit(1)
                .get().await()
            if (!reportSnap.isEmpty) {
                val doc = reportSnap.documents.first()
                payoutReport = WeeklyPayoutReport(
                    id = doc.id,
                    status = doc.getString("status") ?: "",
                    totalPayout = doc.getDouble("totalPayout") ?: 0.0,
                    weekLabel = doc.getString("weekLabel") ?: "",
                )
            }
        } catch (e: Exception) {
            errorMessage = e.message ?: "Failed to load agency data"
        } finally {
            isLoading = false
        }
    }

    ZipperScreen(topBar = { TopBar("My agency", onBack = onBack) }) { _ ->
        when {
            isLoading -> LoadingState()
            agencyId.isBlank() -> EmptyState(Icons.Outlined.Groups, "You're not linked to an agency", "Apply from your profile, or ask an agency owner to add you with their referral code.")
            errorMessage != null -> EmptyState(Icons.Outlined.Groups, "Couldn't load your agency", errorMessage ?: "Unknown error. Go back and try again.")
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                // ── Agency card ───────────────────────────────────────────────
                item {
                    val (tint, label) = when (agencyDoc?.status) {
                        "approved" -> c.statusSuccess to "Approved"
                        "rejected" -> c.statusDanger to "Rejected"
                        else -> c.statusWarning to "Pending"
                    }
                    GlassCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            Text(agencyDoc?.name?.ifBlank { agencyId } ?: agencyId, style = ZipperTheme.type.headingM, color = c.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Chip(label, tint = tint.copy(0.14f), contentColor = tint)
                        }
                        HairlineDivider()
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            Column(Modifier.weight(1f)) {
                                Text("Referral code", style = ZipperTheme.type.caption, color = c.textSecondary)
                                Text(referralCode.ifBlank { "—" }, style = ZipperTheme.type.numericM, color = c.textPrimary)
                            }
                            if (referralCode.isNotBlank()) {
                                IconButtonCircle(Icons.Outlined.ContentCopy, "Copy referral code", { clipboard.setText(AnnotatedString(referralCode)) }, size = 36.dp, tint = c.textBrand)
                            }
                        }
                        Text("Hosts who sign up with your code join this agency.", style = ZipperTheme.type.caption, color = c.textMuted)
                    }
                }

                // ── Stats ─────────────────────────────────────────────────────
                // TODO(design): "beans this week" and "commission" — nothing on the agency doc carries them yet; last payout stands in for commission.
                item {
                    GlassCard(padding = PaddingValues(Space.md)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Stat("Hosts", indianGrouping(agencyDoc?.totalHosts ?: 0L))
                            Stat("Sub-agencies", indianGrouping(agencyDoc?.subAgenciesCount ?: 0L))
                            Stat("Last payout", "₹" + indianGrouping((payoutReport?.totalPayout ?: 0.0).toLong()))
                        }
                    }
                }

                // ── Hosts ─────────────────────────────────────────────────────
                item { SectionHeader("My hosts", Modifier.padding(top = Space.sm)) }
                if (hosts.isEmpty()) {
                    item { EmptyState(Icons.Outlined.Groups, "No hosts yet", "Share your referral code — every host who signs up with it appears here.") }
                } else {
                    items(hosts, key = { it.uid }) { host ->
                        // TODO(design): name, LevelChip, beans this week and verified Chip — agencyHosts rows carry only the uid; join to users/{uid} before showing them.
                        Row(Modifier.fillMaxWidth().padding(vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Avatar(null, size = AvatarSize.MD, initial = host.uid)
                            Column(Modifier.weight(1f)) {
                                Text("Host", style = ZipperTheme.type.labelM, color = c.textPrimary)
                                Text(host.uid, style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        HairlineDivider()
                    }
                }

                // ── Weekly payout ─────────────────────────────────────────────
                item { SectionHeader("Weekly payout", Modifier.padding(top = Space.sm)) }
                item {
                    val report = payoutReport
                    if (report == null) {
                        Text("No payout report yet — one is generated each week once your hosts have earnings.", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                    } else {
                        val (tint, label) = when (report.status) {
                            "submitted" -> c.statusSuccess to "Submitted"
                            "paid" -> c.currencyDiamond to "Paid"
                            else -> c.statusWarning to "Generated"
                        }
                        GlassCard {
                            if (report.weekLabel.isNotBlank()) Text("Week ${report.weekLabel}", style = ZipperTheme.type.caption, color = c.textSecondary)
                            Text("₹" + indianGrouping(report.totalPayout.toLong()), style = ZipperTheme.type.numericL, color = c.textPrimary)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Chip(label, tint = tint.copy(0.14f), contentColor = tint)
                                Spacer(Modifier.weight(1f))
                                if (report.status == "generated") {
                                    ZipperButton(
                                        "Submit report", {
                                            submitLoading = true
                                            val reportId = report.id
                                            scope.launch {
                                                try {
                                                    Firebase.firestore.collection("weeklyPayoutReports").document(reportId).update("status", "submitted").await()
                                                    payoutReport = report.copy(status = "submitted")
                                                    submitSuccess = true
                                                } catch (_: Exception) {
                                                    // show nothing — best effort
                                                } finally {
                                                    submitLoading = false
                                                }
                                            }
                                        },
                                        size = ButtonSize.Small, gradient = true, loading = submitLoading,
                                    )
                                }
                            }
                            if (submitSuccess && report.status == "submitted") {
                                Text("Report submitted successfully.", style = ZipperTheme.type.caption, color = c.statusSuccess)
                            }
                        }
                    }
                }

                item { Spacer(Modifier.navigationBarsPadding()) }
            }
        }
    }
}

// ─── Private pieces ───────────────────────────────────────────────────────────

@Composable
private fun Stat(label: String, value: String) {
    val c = ZipperTheme.colors
    Column { Text(label, style = ZipperTheme.type.caption, color = c.textSecondary); Text(value, style = ZipperTheme.type.numericS, color = c.textPrimary) }
}
