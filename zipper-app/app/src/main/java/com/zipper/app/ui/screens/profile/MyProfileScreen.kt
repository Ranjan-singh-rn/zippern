package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import java.time.LocalDate
import java.time.ZoneId

/*
 * Me tab — Figma "13 Cosmetics & VIP / 01 Me tab" (169:2).
 *
 *   Header 56: "Me" (Semi Bold 20), edit + settings icons.
 *   Identity row: 64 avatar (frame if equipped), name Semi Bold 17,
 *   "ID · Lv", role pill.
 *   Balances card (76h): Diamonds | Beans, each tappable.
 *   Grid of 104×78 cells (r16, bg/raised, hairline): icon 24, label 11,
 *   optional 26×18 badge top-right.
 *
 * SVIP, Super Monthly Card and Game Center cells are drawn in Figma but
 * ship in the cosmetics / games phases; they are not rendered until their
 * backends exist, so nothing here is a dead tap.
 */

@Composable
fun MyProfileScreen(
    onNavigateToProfile: () -> Unit,
    onNavigateToEditProfile: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToDiamondShop: () -> Unit,
    onNavigateToBeansCenter: () -> Unit,
    onNavigateToMyBag: () -> Unit,
    /** O9 (5 Nov 2026): the Store — frames, bubbles, entrances and cards to buy for days or for ever. */
    onNavigateToStore: () -> Unit = {},
    onNavigateToEarnings: () -> Unit,
    onNavigateToCallHistory: () -> Unit,
    onNavigateToLikes: (Int) -> Unit = {},
    onNavigateToLevel: () -> Unit = {},
    onNavigateToDailyRewards: () -> Unit = {},
    onNavigateToAgencyDashboard: () -> Unit = {},
    onNavigateToSellerDashboard: () -> Unit = {},
    /** Mobile parity: the role-aware work hub (CRM capabilities for partners and staff). */
    onNavigateToWork: () -> Unit = {},
    onNavigateToFeedback: () -> Unit = {},
    /** The liveness capture, for a host who has not done it. Takes their gender. */
    onNavigateToFaceVerification: (String) -> Unit = {},
    onNavigateToPartnerHub: () -> Unit = {},
    /** B10: the account switcher (the accounts signed in on this device). */
    onNavigateToSwitchAccount: () -> Unit = {},
    onLogout: () -> Unit = {},
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val clipboard = LocalClipboardManager.current
    var confirmLogout by remember { mutableStateOf(false) }

    if (state.isLoading || state.user == null) { LoadingState(); return }
    val user = state.user!!

    val todayIst = remember { LocalDate.now(ZoneId.of("Asia/Kolkata")).toString() }
    val rewardReady = user.lastDailyClaimDate != todayIst

    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        // Header
        Row(Modifier.fillMaxWidth().height(Size.Bar.top).padding(start = Space.lg, end = Space.sm), verticalAlignment = Alignment.CenterVertically) {
            Text("Me", style = ZipperTheme.type.headingM, color = c.textPrimary)
            Spacer(Modifier.weight(1f))
            IconButtonCircle(Icons.Outlined.Edit, "Edit profile", onNavigateToEditProfile, background = Color.Transparent)
            IconButtonCircle(Icons.Outlined.Settings, "Settings", onNavigateToSettings, background = Color.Transparent)
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            // Identity
            Row(Modifier.fillMaxWidth().clickableNoRipple(onNavigateToProfile).padding(vertical = Space.sm), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Avatar(
                    user.photoUrl, size = AvatarSize.LG, initial = user.name,
                    ring = if (user.isVerifiedHost) AvatarRing.Vip else AvatarRing.None,
                    frameItemId = user.equippedFrame.ifBlank { null }, animatedFrame = true,
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(user.name, style = ZipperTheme.type.headingS, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "ID ${user.uid.take(8).uppercase()}  ·  Lv ${user.level}",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                        modifier = Modifier.clickableNoRipple { clipboard.setText(AnnotatedString(user.uid)) },
                    )
                    // One list, shared with every other screen that shows a
                    // person. `showPendingHost` is true only here: a host who
                    // has not captured yet needs to know why they cannot
                    // withdraw, and nobody else needs to be told.
                    RoleBadgeRow(
                        roleBadgesFor(
                            isHost = user.isHost,
                            isVerifiedHost = user.isVerifiedHost,
                            isAgent = user.isAgent,
                            isSeller = user.isSeller,
                            isOfficial = user.isOfficial,
                            crmRole = user.crmRole,
                            showPendingHost = true,
                        )
                    )
                }
                Icon(Icons.Default.ChevronRight, null, tint = c.textMuted)
            }

            // Balances
            Row(
                Modifier.fillMaxWidth().height(76.dp)
                    .background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
                    .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BalanceCell("Diamonds", user.diamonds, Currency.Diamond, Modifier.weight(1f), onNavigateToDiamondShop)
                Box(Modifier.width(1.dp).height(40.dp).background(c.borderSubtle))
                BalanceCell("Beans", user.beans, Currency.Bean, Modifier.weight(1f), onNavigateToBeansCenter)
            }

            /*
             * The one thing an unverified host has to do, and the only place
             * that asks them to.
             *
             * `isVerifiedHost` gates going live, gates earning at their own
             * call rate rather than the base one, and gates the weekly payout
             * release. A host who skips the capture at signup is therefore
             * losing money every week — and until this banner existed, nothing
             * anywhere told them so. The badge said PENDING and the row below
             * said "Verification pending", neither of which is an instruction
             * or a way to act on one.
             */
            if (user.isHost && !user.isVerifiedHost) {
                Row(
                    Modifier.fillMaxWidth()
                        .background(c.tintGoldSubtle, RoundedCornerShape(Radius.lg))
                        .border(1.dp, c.statusWarning, RoundedCornerShape(Radius.lg))
                        .clickableNoRipple { onNavigateToFaceVerification(user.gender) }
                        .padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Box(
                        Modifier.size(40.dp).background(c.tintGoldSubtle, RoundedCornerShape(Radius.sm)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Outlined.CameraAlt, null, tint = c.statusWarning, modifier = Modifier.size(20.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Verify your face", style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text(
                            "Takes a minute. Until you do, you cannot go live, you earn at " +
                            "the base rate instead of your own, and your weekly payout is held.",
                            style = ZipperTheme.type.caption, color = c.textSecondary,
                        )
                    }
                    Icon(Icons.Default.ChevronRight, null, tint = c.statusWarning, modifier = Modifier.size(18.dp))
                }
            }

            /*
             * "Become a partner" — the four roles, offered or greyed out by the
             * SERVER's eligibility table, plus this person's applications.
             * Replaces the lone "Join an agency" row.
             *
             * Shown to everyone EXCEPT ZIPPER staff, hosts included: a host
             * under a main agency may still add a Sub-agency or a Coin Seller
             * role, and the hub says so. Staff are never partners. `crmRole` is
             * stamped server-side by `syncMyRoles` from `crmUsers/{uid}` and is
             * non-blank ONLY for an Owner or a department role (partners get
             * '') — it is not the `isOfficial` badge. Hiding the card is the
             * convenience; the API refusing every staff application is the rule.
             *
             * Approved contact rule (supersedes UGP-A's "not shown to a guest"):
             * an account without a verified phone or email SEES the card, and
             * the card says a verified contact comes first. Hiding it explained
             * nothing; the hub now says what is missing and opens phone or
             * email verification, then brings the person back. The test is
             * the Firebase Auth record — the same one the server reads
             * (`is_unverified_guest`) — never the `users/{uid}` contact
             * fields, and the server still refuses an application without one.
             */
            val authUser = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser
            if (com.zipper.app.util.ContactRules.partnerEntryVisible(
                    crmRole = user.crmRole,
                    authPhone = authUser?.phoneNumber,
                    authEmail = authUser?.email,
                    authEmailVerified = authUser?.isEmailVerified == true,
                )
            ) Row(
                Modifier.fillMaxWidth()
                    .background(c.bgElevated, RoundedCornerShape(Radius.lg))
                    .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
                    .clickableNoRipple(onNavigateToPartnerHub)
                    .padding(Space.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Box(
                    Modifier.size(40.dp).background(c.bgBase, RoundedCornerShape(Radius.sm)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Groups, null, tint = c.brandVip, modifier = Modifier.size(20.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text("Become a partner", style = ZipperTheme.type.labelM, color = c.textPrimary)
                    // B36: never "an agency" for a Host — Host + Agency is a
                    // forbidden pair, and the hub would only grey it out. A Host
                    // under a main agency may add a Sub-agency or a Coin Seller
                    // role; under a sub-agency, a Coin Seller only (the hub says so).
                    Text(
                        when {
                            // Approved contact rule: the card is shown, and says what comes first.
                            com.zipper.app.util.ContactRules.partnerEntryNeedsContact(
                                authPhone = authUser?.phoneNumber,
                                authEmail = authUser?.email,
                                authEmailVerified = authUser?.isEmailVerified == true,
                            ) -> "Verify a phone number or email first — we'll show you how."
                            user.isHost -> "Add a sub-agency or coin seller role."
                            else -> "Apply as a Host, Agency, Sub-agency or Coin Seller."
                        },
                        style = ZipperTheme.type.caption, color = c.textSecondary,
                    )
                }
                Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
            }

            // Host earnings entry — the host's daily reason to open the app
            if (user.isHost) {
                Row(
                    Modifier.fillMaxWidth().background(c.tintGoldSubtle, RoundedCornerShape(Radius.lg)).border(1.dp, c.brandVip, RoundedCornerShape(Radius.lg))
                        .clickableNoRipple(onNavigateToEarnings).padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Box(Modifier.size(40.dp).background(c.tintGoldSubtle, RoundedCornerShape(Radius.sm)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.TrendingUp, null, tint = c.brandVip, modifier = Modifier.size(20.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Host earnings", style = ZipperTheme.type.labelM, color = c.textPrimary)
                        Text(if (user.isVerifiedHost) "Today's beans, weekly statement, payout" else "Verification pending — earning at base rate", style = ZipperTheme.type.caption, color = c.textSecondary)
                    }
                    Icon(Icons.Default.ChevronRight, null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
                }
            }

            // Cells
            val cells = buildList {
                add(Cell(Icons.Outlined.Storefront, "Store", onNavigateToStore))
                add(Cell(Icons.Outlined.CardGiftcard, "My Bag", onNavigateToMyBag))
                add(Cell(Icons.Outlined.BarChart, "My Level", onNavigateToLevel, badge = "Lv ${user.level}", badgeTint = c.brandPrimary))
                add(Cell(Icons.Outlined.CalendarMonth, "Daily Reward", onNavigateToDailyRewards, badge = if (rewardReady) "!" else "D${user.dailyStreak}", badgeTint = if (rewardReady) c.statusDanger else c.brandPrimary))
                add(Cell(Icons.Outlined.Favorite, "Likes", { onNavigateToLikes(0) }, badge = user.totalLikesReceived.takeIf { it > 0 }?.let { compactCount(it) }, badgeTint = c.brandPrimary))
                add(Cell(Icons.Outlined.Videocam, "Call History", onNavigateToCallHistory))
                if (user.isAgent) add(Cell(Icons.Outlined.Groups, "Agency", onNavigateToAgencyDashboard))
                if (user.isSeller) add(Cell(Icons.Outlined.Storefront, "Seller", onNavigateToSellerDashboard))
                // Shown to anyone the server has given a partner or staff role (server-written
                // flags). The hub itself asks the API what the session may do.
                if (user.isAgent || user.isSeller || user.isOfficial || user.crmRole.isNotBlank() || user.ownAgencyId.isNotBlank()) {
                    add(Cell(Icons.Outlined.WorkOutline, "Work", onNavigateToWork))
                }
                add(Cell(Icons.Outlined.Settings, "Settings", onNavigateToSettings))
                add(Cell(Icons.Outlined.SwitchAccount, "Switch account", onNavigateToSwitchAccount))
                add(Cell(Icons.Outlined.ChatBubbleOutline, "Feedback", onNavigateToFeedback))
                add(Cell(Icons.AutoMirrored.Outlined.Logout, "Log out", { confirmLogout = true }, danger = true))
            }
            cells.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    row.forEach { MeCell(it, Modifier.weight(1f)) }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            Spacer(Modifier.height(Space.xl))
        }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            containerColor = c.bgElevated,
            title = { Text("Log out?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("Your diamonds and beans stay on your account.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ confirmLogout = false; onLogout() }) { Text("Log out", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmLogout = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

private data class Cell(
    val icon: ImageVector, val label: String, val onClick: () -> Unit,
    val badge: String? = null, val badgeTint: Color = Color.Unspecified, val danger: Boolean = false,
)

@Composable
private fun MeCell(cell: Cell, modifier: Modifier) {
    val c = ZipperTheme.colors
    Box(
        modifier.height(78.dp).background(c.bgRaised, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).clickableNoRipple(cell.onClick),
    ) {
        Column(Modifier.fillMaxSize().padding(top = 14.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(cell.icon, null, tint = if (cell.danger) c.statusDanger else c.textPrimary, modifier = Modifier.size(24.dp))
            Text(cell.label, style = ZipperTheme.type.caption, color = if (cell.danger) c.statusDanger else c.textSecondary, maxLines = 1)
        }
        if (cell.badge != null) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(6.dp).height(18.dp).background(cell.badgeTint.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp),
                contentAlignment = Alignment.Center,
            ) { Text(cell.badge, style = ZipperTheme.type.overline, color = cell.badgeTint) }
        }
    }
}

@Composable
private fun BalanceCell(label: String, amount: Long, currency: Currency, modifier: Modifier, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(modifier.fillMaxHeight().clickableNoRipple(onClick).padding(horizontal = Space.md), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                CurrencyDisc(currency, 14.dp)
                Text(label, style = ZipperTheme.type.caption, color = c.textMuted)
            }
            Text(indianGrouping(amount), style = ZipperTheme.type.numericM, color = if (currency == Currency.Diamond) c.currencyDiamond else c.currencyBean)
        }
        Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
    }
}

