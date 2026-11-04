package com.zipper.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.zipper.app.data.model.TopSupportEntry
import com.zipper.app.data.model.User
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Own profile — full view behind the Me tab's identity row.
 *
 * Same hero / identity / glass-card layout as OtherUserProfileScreen, but the
 * action row is a single "Edit profile" gradient button, followed by the
 * viewer's own stat pills (Likes me · I like · Beans · Diamonds).
 *
 * `isOwnProfile = true` is the only remaining caller (ZipperNavGraph); the
 * other-user path uses OtherUserProfileScreen. The other-user parameters
 * (like / block / call / gift / message / live / party) stay in the signature
 * so that call site keeps compiling, and are intentionally unused here.
 *
 * `availableGifts: List<GiftItem> = MOCK_GIFTS` used to be among them, and it was
 * not harmless the way an unused callback is. Nothing here rendered it, and the
 * nav graph never passed it, so the value living in production was a list of ten
 * gifts with ids that exist in no Firestore collection — one display away from
 * offering somebody a gift that `settleGift` would refuse as not found. An unused
 * parameter whose default is wrong data is a trap for whoever wires it up next,
 * so it is gone; gifting goes through GiftDrawer with the CRM catalogue, which
 * OtherUserProfileScreen shows how to feed.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ProfileScreen(
    user: User,
    isOwnProfile: Boolean,
    isLiked: Boolean = false,
    isBlocked: Boolean = false,
    currentUserDiamonds: Long = 0L,   // viewer's diamond balance (for gift sheet)
    callCostDiamonds: Long = 0L,      // diamond cost/min to call this user
    onBack: () -> Unit,
    onEditProfile: () -> Unit = {},
    onBlock: () -> Unit = {},
    onUnblock: () -> Unit = {},
    onReport: () -> Unit = {},
    onToggleLike: () -> Unit = {},
    onVideoCall: () -> Unit = {},
    onMessage: () -> Unit = {},
    onOpenGallery: (startIndex: Int) -> Unit = {},
    onViewAllGiftsSent: () -> Unit = {},
    onViewAllGiftsReceived: () -> Unit = {},
    onSendGift: (GiftItem) -> Unit = {},
    onJoinLive: () -> Unit = {},
    onJoinParty: () -> Unit = {},
    giftsSent: List<GiftSummaryItem> = emptyList(),
    giftsReceived: List<GiftSummaryItem> = emptyList(),
) {
    val c = ZipperTheme.colors
    val clipboard = LocalClipboardManager.current
    var showLanguageSheet by remember { mutableStateOf(false) }

    // QA #16: Back and Edit stay on screen (they used to scroll away with the hero), and the status bar gets a scrim
    // that fades in as the page scrolls, so content no longer runs under the clock.
    val profileScroll = rememberScrollState()
    Box(Modifier.fillMaxSize().background(c.bgBase)) {
    Column(Modifier.fillMaxSize().verticalScroll(profileScroll)) {
        // ── Hero ──────────────────────────────────────────────────────────
        Box(Modifier.fillMaxWidth().height(262.dp)) {
            Box(Modifier.fillMaxWidth().height(210.dp).background(placeholderBrush(user.uid))) {
                val cover = user.coverPhotoUrl.ifBlank { user.photoUrl }
                if (cover.isNotBlank()) {
                    AsyncImage(cover, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    Text(user.name.take(1).uppercase(), style = ZipperTheme.type.displayL, color = Color.White.copy(0.16f), modifier = Modifier.align(Alignment.Center))
                }
                Box(Modifier.fillMaxWidth().height(110.dp).background(Brush.verticalGradient(listOf(Color(0xC7070812), Color(0x4D070812), Color.Transparent))))
                Box(Modifier.fillMaxWidth().height(120.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x59070812), Color(0xE5070812)))))
            }
            Avatar(
                user.photoUrl, size = AvatarSize.XL,
                ring = if (user.isVerifiedHost) AvatarRing.Vip else AvatarRing.None,
                initial = user.name, frameItemId = user.equippedFrame.ifBlank { null }, animatedFrame = true,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }

        // ── Identity ──────────────────────────────────────────────────────
        Column(Modifier.fillMaxWidth().padding(top = Space.sm, start = Space.lg, end = Space.lg), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(user.name, style = ZipperTheme.type.headingL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (user.isVerifiedHost || user.isOfficial) Icon(Icons.Default.Verified, "Verified", tint = c.currencyDiamond, modifier = Modifier.size(18.dp))
            }
            Text(
                "ID: ${user.uid.take(8).uppercase()}   ·   Level ${user.level}",
                style = ZipperTheme.type.caption, color = c.textMuted,
                modifier = Modifier.clickableNoRipple { clipboard.setText(AnnotatedString(user.uid)) },
            )
            // The same list every other screen uses. This was the third
            // hand-written copy, and the only one that knew about CRM roles at
            // all — so the owner's badge appeared here and nowhere else.
            // `roleBadgesFor` now carries that knowledge for all of them.
            val badges = roleBadgesFor(
                isHost = user.isHost,
                isVerifiedHost = user.isVerifiedHost,
                isAgent = user.isAgent,
                isSeller = user.isSeller,
                isOfficial = user.isOfficial,
                crmRole = user.crmRole,
                showPendingHost = true,
            )
            if (badges.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    badges.forEach { RoleBadgePill(it) }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Icons.Outlined.LocationOn, null, tint = c.textSecondary, modifier = Modifier.size(14.dp))
                val place = user.city.ifBlank { user.country }.ifBlank { "Somewhere" }
                Text(place, style = ZipperTheme.type.bodyS, color = c.textSecondary)
                if (user.gender.isNotBlank()) {
                    Text("·", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    Text(user.gender.replaceFirstChar { it.uppercase() }, style = ZipperTheme.type.bodyS, color = c.textSecondary)
                }
            }
        }

        // ── Edit + stats ──────────────────────────────────────────────────
        ZipperButton(
            "Edit profile", onEditProfile, icon = Icons.Outlined.Edit, gradient = true, fullWidth = true, size = ButtonSize.Medium,
            modifier = Modifier.padding(top = Space.lg, start = Space.lg, end = Space.lg),
        )
        Column(Modifier.fillMaxWidth().padding(top = Space.md, start = Space.lg, end = Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                StatPill("Likes me", indianGrouping(user.totalLikesReceived), c.brandPrimary, Modifier.weight(1f))
                StatPill("I like", indianGrouping(user.totalLikesGiven), c.textPrimary, Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                StatPill("Beans", indianGrouping(user.beans), c.currencyBean, Modifier.weight(1f), Currency.Bean)
                StatPill("Diamonds", indianGrouping(user.diamonds), c.currencyDiamond, Modifier.weight(1f), Currency.Diamond)
            }
        }

        // ── Sections ──────────────────────────────────────────────────────
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.xl), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            if (user.bio.isNotBlank()) {
                GlassCard {
                    Text("About Me", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    var expanded by remember { mutableStateOf(false) }
                    Text(user.bio, style = ZipperTheme.type.bodyM, color = c.textSecondary, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
                    if (user.bio.length > 120) {
                        Text(if (expanded) "Show less" else "Read more", style = ZipperTheme.type.labelS, color = c.textBrand, modifier = Modifier.clickableNoRipple { expanded = !expanded })
                    }
                }
            }

            GlassCard {
                Text("Personal Information", style = ZipperTheme.type.headingS, color = c.textPrimary)
                KeyValueRow("Full Name", user.name)
                if (user.age > 0) KeyValueRow("Age", user.age.toString())
                if (user.gender.isNotBlank()) KeyValueRow("Gender", user.gender.replaceFirstChar { it.uppercase() })
                if (user.city.isNotBlank()) KeyValueRow("Area", user.city)
                if (user.country.isNotBlank()) KeyValueRow("Country", user.country)
                KeyValueRow("Email", user.email.ifBlank { "—" })
                KeyValueRow("Phone", user.phoneNumber.ifBlank { "—" })
                KeyValueRow("Referral Code", user.referralCode.ifBlank { "—" })
                // QA #17: streamed time is a host's figure — a viewer's "0h 0m" said nothing and read like a fault.
                if (user.isHost) {
                    val h = user.streamedTimeSeconds / 3600
                    val m = (user.streamedTimeSeconds % 3600) / 60
                    KeyValueRow("Streamed Time", "${h}h ${m}m")
                }
                if (user.languages.isNotEmpty()) {
                    Text("Languages", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    LanguageChipRow(selected = user.languages, onTapOverflow = { showLanguageSheet = true }, visibleCount = 4)
                }
                if (user.hobbies.isNotEmpty()) {
                    Text("Hobbies", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        user.hobbies.forEach { TagPill(it, c.brandSecondary) }
                    }
                }
                if (user.likes.isNotEmpty()) {
                    Text("Interests", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        user.likes.forEach { TagPill(it, c.brandPrimary) }
                    }
                }
            }

            if (user.isHost) {
                GlassCard {
                    Text("Host Earnings", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    EarningRow("Call rate", "${indianGrouping(user.callRateBeans.toLong())} beans/min")
                    EarningRow("Call earnings", "${indianGrouping(user.hostCallEarnings)} beans")
                    EarningRow("Gift earnings", "${indianGrouping(user.hostGiftEarnings)} beans")
                    HairlineDivider()
                    EarningRow("Total earned", "${indianGrouping(user.hostCallEarnings + user.hostGiftEarnings)} beans", strong = true)
                }
            }

            if (user.isHost && user.topSupporters.isNotEmpty()) RankingCard("Top Supporters This Week", user.topSupporters)
            if (!user.isHost && user.topHosts.isNotEmpty()) RankingCard("Top Hosts I Support", user.topHosts)

            GlassCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Gallery", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    Text("${user.mediaUrls.size} / 10", style = ZipperTheme.type.caption, color = c.textMuted)
                }
                if (user.mediaUrls.isNotEmpty()) {
                    user.mediaUrls.indices.chunked(3).forEach { row ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                            row.forEach { i ->
                                val url = user.mediaUrls[i]
                                val isVideo = url.isVideoUrl()
                                val thumb = if (isVideo) user.mediaThumbs.getOrNull(i)?.takeIf { it.isNotBlank() } ?: url else url
                                Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(Radius.sm)).background(c.bgElevated).clickableNoRipple { onOpenGallery(i) }) {
                                    AsyncImage(thumb, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                                    if (isVideo) {
                                        Box(Modifier.align(Alignment.Center).size(28.dp).background(c.scrimStrong, CircleShape), contentAlignment = Alignment.Center) {
                                            Icon(Icons.Default.PlayArrow, "Video", tint = Color.White, modifier = Modifier.size(16.dp))
                                        }
                                    }
                                }
                            }
                            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                } else {
                    Text("No photos or videos yet. Tap Edit profile to add some.", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                }
            }

            GiftStrip("Gifts Sent", giftsSent, "No gifts sent yet. Send one from any host's profile.", onViewAllGiftsSent)
            // QA #17: "go live" is advice only a host can take; anyone can receive a gift in a party room or a chat.
            GiftStrip(
                "Gifts Received", giftsReceived,
                if (user.isHost) "No gifts received yet. Go live to receive some." else "No gifts received yet.",
                onViewAllGiftsReceived,
            )
        }
        Spacer(Modifier.navigationBarsPadding().height(Space.xl))
    }
    // The pinned bar over the page (QA #16).
    val barScrim = (profileScroll.value / 360f).coerceIn(0f, 1f)
    Box(Modifier.fillMaxWidth().background(c.bgBase.copy(alpha = barScrim)).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Space.xs, vertical = Space.xs),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, size = 36.dp, background = c.scrimMedium)
            IconButtonCircle(Icons.Outlined.Edit, "Edit profile", onEditProfile, size = 36.dp, background = c.scrimMedium)
        }
    }
    }

    // Full language sheet
    if (showLanguageSheet && user.languages.isNotEmpty()) {
        LanguagePickerSheet(
            selected = user.languages,
            onDismiss = { showLanguageSheet = false },
            onConfirm = { showLanguageSheet = false },
        )
    }
}

/** Model for a gift with aggregated count. */
data class GiftSummaryItem(
    val giftId: String,
    val name: String,
    val emoji: String = "🎁",
    val imageUrl: String = "",
    val count: Int,
)

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun StatPill(label: String, value: String, tint: Color, modifier: Modifier, currency: Currency? = null) {
    val c = ZipperTheme.colors
    Column(
        modifier.height(64.dp).background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.md),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (currency != null) CurrencyDisc(currency, 14.dp)
            Text(label, style = ZipperTheme.type.caption, color = c.textMuted)
        }
        Text(value, style = ZipperTheme.type.numericM, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}


@Composable
private fun TagPill(text: String, tint: Color) {
    Box(
        Modifier.height(20.dp).background(tint.copy(alpha = 0.14f), CircleShape).border(1.dp, tint, CircleShape).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = ZipperTheme.type.labelS, color = tint, maxLines = 1) }
}

@Composable
private fun KeyValueRow(label: String, value: String) {
    val c = ZipperTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = ZipperTheme.type.bodyS, color = c.textMuted)
        Text(value, style = ZipperTheme.type.bodyS, color = c.textPrimary, textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.lg))
    }
}

@Composable
private fun EarningRow(label: String, value: String, strong: Boolean = false) {
    val c = ZipperTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = if (strong) ZipperTheme.type.labelM else ZipperTheme.type.bodyS, color = if (strong) c.textPrimary else c.textMuted)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CurrencyDisc(Currency.Bean, 12.dp)
            Text(value, style = if (strong) ZipperTheme.type.numericM else ZipperTheme.type.numericS, color = c.currencyBean)
        }
    }
}

@Composable
private fun RankingCard(title: String, entries: List<TopSupportEntry>) {
    val c = ZipperTheme.colors
    GlassCard {
        Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary)
        entries.take(10).forEachIndexed { i, e ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Text("${e.rank.takeIf { it > 0 } ?: (i + 1)}", style = ZipperTheme.type.numericM, color = if (i == 0) c.brandVip else c.textSecondary, modifier = Modifier.width(20.dp))
                Avatar(e.photoUrl, size = AvatarSize.SM, ring = if (i == 0) AvatarRing.Vip else AvatarRing.None, initial = e.name)
                Text(e.name, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Price(Currency.Diamond, e.totalDiamonds)
            }
        }
    }
}

@Composable
private fun GiftStrip(title: String, gifts: List<GiftSummaryItem>, emptyHint: String, onViewAll: () -> Unit) {
    val c = ZipperTheme.colors
    GlassCard(padding = PaddingValues(vertical = Space.lg)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = ZipperTheme.type.headingS, color = c.textPrimary)
            if (gifts.isNotEmpty()) Text("See all", style = ZipperTheme.type.labelM, color = c.textBrand, modifier = Modifier.clickableNoRipple(onViewAll))
        }
        if (gifts.isEmpty()) {
            Text(emptyHint, style = ZipperTheme.type.bodyS, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.lg))
        } else {
            LazyRow(contentPadding = PaddingValues(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                items(gifts.take(10), key = { it.giftId }) { g ->
                    Column(
                        Modifier.width(72.dp).background(c.glassLow, RoundedCornerShape(Radius.md)).padding(vertical = Space.sm),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        if (g.imageUrl.isNotBlank()) AsyncImage(g.imageUrl, null, modifier = Modifier.size(32.dp))
                        else Text(g.emoji.ifBlank { "🎁" }, style = ZipperTheme.type.headingL)
                        Text(g.name, style = ZipperTheme.type.caption, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("×${g.count}", style = ZipperTheme.type.overline, color = c.brandVip)
                    }
                }
            }
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
