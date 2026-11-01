package com.zipper.app.ui.screens.agency

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.Icon
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
import com.zipper.app.util.AgencyIdentity
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/*
 * My agency.
 *
 *   Top bar: back, "My agency".
 *   Agency card: name, status chip, referral code (numeric M) with copy.
 *   Stats: hosts · sub-agencies · last payout.
 *   Host rows: avatar, name. Empty state tells the owner to share the code.
 *
 * B1: the title is the agency's NAME (`agencyName`), the referral code is the
 * one issued to the AGENCY RECORD, host rows show the roster name with a
 * labelled Host ID, and the host count is the current roster. Sub-agencies are
 * not counted by anything this screen may read (no writer keeps a count on the
 * record), so the stat says "—" rather than a made-up 0. See util/AgencyIdentity.
 *   Weekly payout card with the "Submit report" action.
 */

// ─── Data classes ────────────────────────────────────────────────────────────

private data class AgencyDoc(
    /** `agencyName` (fallback `name`); null when the record carries neither. */
    val name: String? = null,
    val status: String = "",        // "pending" | "approved" | "rejected"
    /** `agencies/{id}.referralCode` — blank until the backend issues one. */
    val referralCode: String = "",
)

private data class AgencyHostItem(
    val uid: String = "",
    /** The roster row's `name`, as the grant wrote it; blank if the row has none. */
    val name: String = "",
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
    /**
     * B2: a host row opens that host's profile — the same public profile
     * (`publicProfiles`, no contact, no earnings) any signed-in user can open
     * from Home. Nothing private is reached through it.
     */
    onOpenHost: (uid: String) -> Unit = {},
    /**
     * Mobile parity: the OPERATIONAL host view (bean earnings per host) from the
     * partner-scoped API route `GET /api/partners/agencies/{id}/hosts` — only
     * this agency's own hosts, enforced on the server.
     */
    onOpenHostEarnings: (agencyId: String) -> Unit = {},
    profileViewModel: ProfileViewModel = hiltViewModel(),
) {
    val profileState by profileViewModel.state.collectAsStateWithLifecycle()
    val currentUser = profileState.user
    val currentUid = FirebaseAuth.getInstance().currentUser?.uid ?: ""
    // The agency this person OWNS. `ownAgencyId` is written by the server; the
    // fallback to `agencyId` covers a profile not yet re-synced, and only for a
    // non-Host, because a Host's `agencyId` is the agency they work under.
    val agencyId = currentUser?.ownAgencyId?.takeIf { it.isNotBlank() }
        ?: currentUser?.takeIf { !it.isHost }?.agencyId.orEmpty()
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
                name = AgencyIdentity.agencyName(agSnap.getString("agencyName"), agSnap.getString("name")),
                status = agSnap.getString("status") ?: "pending",
                referralCode = AgencyIdentity.referralCode(agSnap.getString("referralCode")),
            )

            // Fetch agencyHosts subcollection
            val hostsSnap = Firebase.firestore.collection("agencies").document(agencyId).collection("agencyHosts").get().await()
            // FX-10 (RF-15): current hosts only. A row `revoke_host` or the
            // account purge marked `active: false` is history, not a host; a
            // row with no `active` field predates the marker and is current.
            hosts = AgencyIdentity.roster(hostsSnap.documents.map { doc -> doc.id to (doc.data ?: emptyMap()) })
                .map { row -> AgencyHostItem(uid = row.uid, name = row.name) }

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
                    val referralCode = agencyDoc?.referralCode.orEmpty()
                    val (tint, label) = when (agencyDoc?.status) {
                        "approved" -> c.statusSuccess to "Approved"
                        "rejected" -> c.statusDanger to "Rejected"
                        else -> c.statusWarning to "Pending"
                    }
                    GlassCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            Column(Modifier.weight(1f)) {
                                Text(agencyDoc?.name ?: AgencyIdentity.NO_NAME, style = ZipperTheme.type.headingM, color = if (agencyDoc?.name != null) c.textPrimary else c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(AgencyIdentity.reference(AgencyIdentity.AGENCY_ID, agencyId), style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Chip(label, tint = tint.copy(0.14f), contentColor = tint)
                        }
                        HairlineDivider()
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            Column(Modifier.weight(1f)) {
                                Text("Referral code", style = ZipperTheme.type.caption, color = c.textSecondary)
                                Text(referralCode.ifBlank { AgencyIdentity.NOT_ISSUED }, style = ZipperTheme.type.numericM, color = c.textPrimary)
                                if (referralCode.isBlank()) Text("Not issued yet", style = ZipperTheme.type.caption, color = c.textMuted)
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
                            // The current roster — the same rows listed below, not a stored counter nobody updates.
                            Stat("Hosts", indianGrouping(hosts.size.toLong()))
                            // No count this screen may read: "—", never an invented 0.
                            Stat("Sub-agencies", AgencyIdentity.NOT_COUNTED)
                            Stat("Last payout", "₹" + indianGrouping((payoutReport?.totalPayout ?: 0.0).toLong()))
                        }
                    }
                }

                // ── Hosts ─────────────────────────────────────────────────────
                item { SectionHeader("My hosts", Modifier.padding(top = Space.sm), action = "Earnings", onAction = { onOpenHostEarnings(agencyId) }) }
                if (hosts.isEmpty()) {
                    item { EmptyState(Icons.Outlined.Groups, "No hosts yet", "Share your referral code — every host who signs up with it appears here.") }
                } else {
                    items(hosts, key = { it.uid }) { host ->
                        // TODO(design): LevelChip, beans this week and verified Chip — not on the roster row.
                        val openable = AgencyIdentity.canOpenProfile(host.uid)
                        Row(
                            Modifier.fillMaxWidth()
                                .then(if (openable) Modifier.clickableNoRipple { onOpenHost(host.uid) } else Modifier)
                                .padding(vertical = Space.sm),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                        ) {
                            Avatar(null, size = AvatarSize.MD, initial = AgencyIdentity.initial(host.name))
                            Column(Modifier.weight(1f)) {
                                Text(AgencyIdentity.displayName(host.name), style = ZipperTheme.type.labelM, color = if (host.name.isNotBlank()) c.textPrimary else c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(AgencyIdentity.reference(AgencyIdentity.HOST_ID, host.uid), style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (openable) Icon(Icons.Default.ChevronRight, "Open profile", tint = c.textMuted, modifier = Modifier.size(18.dp))
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
