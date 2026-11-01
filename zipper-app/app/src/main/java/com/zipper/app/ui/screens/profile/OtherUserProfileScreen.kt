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
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.zipper.app.R
import com.zipper.app.data.model.User
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Another user's profile — Figma "04 Profile (other user)" (91:77).
 *
 *   Hero 262: cover 210 (photo or seeded gradient with initial), top + bottom
 *   scrims, glass back / more buttons, 72 avatar overlapping the cover edge
 *   with a mint ring when online.
 *   Identity: name Bold 24 + verified, "ID · Level", HOST / OFFICIAL badges,
 *   location · gender.
 *   Banner: "LIVE — tap to join" when they are live (coral tint), party variant.
 *   Actions: Like · Call (+ "750/min" price) · Gift · Message — 56 discs.
 *   Cards: About Me, Personal Information (r16, glass gradient, hairline).
 */

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun OtherUserProfileScreen(
    onBack: () -> Unit,
    onStartCall: (callId: String) -> Unit,
    onMessage: (uid: String) -> Unit,
    onJoinLive: (roomId: String) -> Unit,
    onJoinParty: (roomId: String) -> Unit,
    onOpenGallery: (uid: String, startIndex: Int, urls: List<String>) -> Unit,
    onRecharge: () -> Unit,
    viewModel: OtherUserViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val snackbar = remember { SnackbarHostState() }
    var showGifts by remember { mutableStateOf(false) }
    var showMore by remember { mutableStateOf(false) }
    var showReport by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }
    /*
     * Spec §11 (APK 20): the pre-call confirmation. Says what a minute costs
     * and that the FIRST minute is charged the moment the call connects, before
     * the server is asked to ring anybody. Only when there is something to pay:
     * a host ringing a user earns and is not asked.
     */
    var showCallConfirm by remember { mutableStateOf(false) }

    LaunchedEffect(state.navigateToCall) {
        val id = state.navigateToCall ?: return@LaunchedEffect
        viewModel.consumeCallNavigation()
        onStartCall(id)
    }
    LaunchedEffect(state.toastMessage) {
        state.toastMessage?.let { snackbar.showSnackbar(it); viewModel.clearToast() }
    }

    val user = state.user
    Box(Modifier.fillMaxSize().background(c.bgBase)) {
        when {
            state.isLoading -> LoadingState()
            user == null -> Column(Modifier.fillMaxSize().statusBarsPadding()) {
                TopBar("Profile", onBack = onBack)
                EmptyState(Icons.Default.PersonOff, "This profile is unavailable", state.errorMessage ?: "It may have been removed.")
            }
            else -> ProfileBody(
                user = user, state = state,
                onBack = onBack,
                onMore = { showMore = true },
                onLike = viewModel::toggleLike,
                onCall = { if (state.callCostDiamonds > 0L) showCallConfirm = true else viewModel.initiateCall() },
                onGift = { showGifts = true },
                onMessage = { onMessage(user.uid) },
                onJoinLive = { if (user.liveRoomId.isNotBlank()) onJoinLive(user.liveRoomId) },
                onJoinParty = { if (user.partyRoomId.isNotBlank()) onJoinParty(user.partyRoomId) },
                onOpenGallery = { i -> onOpenGallery(user.uid, i, user.mediaUrls) },
            )
        }

        // Spec §11: the server's lucky roll, celebrated for a few seconds.
        state.luckyWin?.let { win ->
            LaunchedEffect(win) { kotlinx.coroutines.delay(4_000); viewModel.clearLuckyWin() }
            LuckyWinBanner(win, Modifier.align(Alignment.Center).padding(Space.xl))
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding()) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    if (showGifts && user != null) {
        GiftDrawer(
            gifts = state.catalogue,
            balanceDiamonds = state.currentUserDiamonds,
            recipientName = user.name,
            recipientPhotoUrl = user.photoUrl,
            sending = state.giftSending,
            // The drawer opens the moment the button is tapped, whatever the
            // catalogue is doing. Handing it the fetch's state is what lets it
            // say so — an empty grid on its own is indistinguishable from a
            // failed load, and that ambiguity is what the mock catalogue used to
            // paper over.
            loading = state.catalogueLoading,
            loadError = state.catalogueError,
            onRetry = viewModel::retryGiftCatalogue,
            onSend = { g, q -> viewModel.sendGift(g, q); showGifts = false },
            onRecharge = { showGifts = false; onRecharge() },
            onDismiss = { showGifts = false },
        )
    }

    if (showMore && user != null) {
        ModalBottomSheet(
            onDismissRequest = { showMore = false },
            containerColor = c.bgElevated, dragHandle = null,
            shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
        ) {
            Column(Modifier.navigationBarsPadding().padding(bottom = Space.md)) {
                Box(Modifier.padding(top = 6.dp, bottom = Space.sm).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
                SheetRow(Icons.Default.Flag, "Report ${user.name}") { showMore = false; showReport = true }
                if (state.isBlocked) SheetRow(Icons.Default.LockOpen, "Unblock ${user.name}") { showMore = false; viewModel.unblockUser() }
                else SheetRow(Icons.Default.Block, "Block ${user.name}", danger = true) { showMore = false; confirmBlock = true }
            }
        }
    }

    if (showReport && user != null) {
        val reasons = listOf("Inappropriate content", "Harassment or abuse", "Scam or fraud", "Underage", "Fake profile", "Something else")
        AlertDialog(
            onDismissRequest = { showReport = false },
            containerColor = c.bgElevated,
            title = { Text("Report ${user.name}", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column {
                    reasons.forEach { r ->
                        Text(
                            r, style = ZipperTheme.type.bodyM, color = c.textPrimary,
                            modifier = Modifier.fillMaxWidth().clickableNoRipple { showReport = false; viewModel.report(r) }.padding(vertical = 10.dp),
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton({ showReport = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }

    if (showCallConfirm && user != null) {
        AlertDialog(
            onDismissRequest = { showCallConfirm = false },
            containerColor = c.bgElevated,
            title = { Text("Call ${user.name}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                        CurrencyDisc(Currency.Diamond, 14.dp)
                        Text("${indianGrouping(state.callCostDiamonds)} per minute", style = ZipperTheme.type.labelM, color = c.textPrimary)
                    }
                    Text(
                        com.zipper.app.util.CallBilling.confirmText(state.callCostDiamonds),
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                    Text(
                        "Your balance: ${indianGrouping(state.currentUserDiamonds)} diamonds",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                    )
                }
            },
            confirmButton = {
                TextButton({ showCallConfirm = false; viewModel.initiateCall() }) {
                    Text("Call — first minute charged on connect", color = c.textBrand)
                }
            },
            dismissButton = { TextButton({ showCallConfirm = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }

    if (confirmBlock && user != null) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false },
            containerColor = c.bgElevated,
            title = { Text("Block ${user.name}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("They won't be able to call, message or see you. You can unblock them from Settings.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ confirmBlock = false; viewModel.blockUser() }) { Text("Block", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmBlock = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

// ── Body ─────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileBody(
    user: User,
    state: OtherUserUiState,
    onBack: () -> Unit, onMore: () -> Unit,
    onLike: () -> Unit, onCall: () -> Unit, onGift: () -> Unit, onMessage: () -> Unit,
    onJoinLive: () -> Unit, onJoinParty: () -> Unit,
    onOpenGallery: (Int) -> Unit,
) {
    val c = ZipperTheme.colors
    val clipboard = LocalClipboardManager.current

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
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
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.xs, vertical = Space.xs),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                IconButtonCircle(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, size = 36.dp, background = c.scrimMedium)
                IconButtonCircle(Icons.Default.MoreVert, "More", onMore, size = 36.dp, background = c.scrimMedium)
            }
            Avatar(
                user.photoUrl, size = AvatarSize.XL,
                ring = when { user.isLive -> AvatarRing.Live; user.isOnline -> AvatarRing.Online; else -> AvatarRing.None },
                initial = user.name, frameUrl = user.equippedFrame.ifBlank { null },
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
            // Same list as every other screen. This one used to show OFFICIAL
            // and SELLER but not AGENT, while your own profile showed AGENT but
            // not OFFICIAL, and neither showed the owner.
            RoleBadgeRow(
                roleBadgesFor(
                    isHost = user.isHost,
                    isVerifiedHost = user.isVerifiedHost,
                    isAgent = user.isAgent,
                    isSeller = user.isSeller,
                    isOfficial = user.isOfficial,
                    crmRole = user.crmRole,
                )
            )
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

        // ── Live / party banner ───────────────────────────────────────────
        when {
            user.isLive -> PresenceBanner(LiveBadgeKind.Live, "Tap to join their live room", c.statusLive, onJoinLive)
            user.isInParty -> PresenceBanner(LiveBadgeKind.Party, "Tap to join their party room", c.brandSecondary, onJoinParty)
        }

        // ── Actions ───────────────────────────────────────────────────────
        Row(
            Modifier.fillMaxWidth().padding(top = Space.lg, start = Space.xxl, end = Space.xxl),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top,
        ) {
            ActionDisc(
                if (state.isLiked) Icons.Default.Favorite else Icons.Outlined.FavoriteBorder,
                if (state.isLiked) "Liked" else "Like",
                c.tintBrandSubtle, if (state.isLiked) c.brandPrimary else c.textPrimary, onLike,
            )
            ActionDisc(Icons.Default.Videocam, "Call", c.tintSuccessSubtle, c.statusSuccess, onCall,
                enabled = !state.isBlocked && !user.isInCall,
                sub = {
                    if (state.callCostDiamonds > 0) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            Icon(painterResource(R.drawable.ic_diamond), null, tint = c.currencyDiamond, modifier = Modifier.size(12.dp))
                            Text("${indianGrouping(state.callCostDiamonds)}/min", style = ZipperTheme.type.overline, color = c.currencyDiamond)
                        }
                    }
                },
            )
            ActionDisc(Icons.Default.CardGiftcard, "Gift", c.tintGoldSubtle, c.brandVip, onGift)
            ActionDisc(Icons.Outlined.ChatBubbleOutline, "Message", c.tintDiamondSubtle, c.currencyDiamond, onMessage, enabled = !state.isBlocked)
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

            if (user.mediaUrls.isNotEmpty()) {
                GlassCard(padding = PaddingValues(vertical = Space.lg)) {
                    Text("Gallery", style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.padding(horizontal = Space.lg))
                    LazyRow(contentPadding = PaddingValues(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        items(user.mediaUrls.size) { i ->
                            val thumb = user.mediaThumbs.getOrNull(i)?.ifBlank { null } ?: user.mediaUrls[i]
                            AsyncImage(
                                thumb, null, contentScale = ContentScale.Crop,
                                modifier = Modifier.size(96.dp, 128.dp).clip(RoundedCornerShape(Radius.md)).background(c.bgElevated).clickableNoRipple { onOpenGallery(i) },
                            )
                        }
                    }
                }
            }

            GlassCard {
                Text("Personal Information", style = ZipperTheme.type.headingS, color = c.textPrimary)
                InfoRow("Full Name", user.name)
                if (user.age > 0) InfoRow("Age", user.age.toString())
                if (user.gender.isNotBlank()) InfoRow("Gender", user.gender.replaceFirstChar { it.uppercase() })
                if (user.city.isNotBlank()) InfoRow("Area", user.city)
                if (user.country.isNotBlank()) InfoRow("Country", user.country)
                if (user.languages.isNotEmpty()) {
                    Text("Languages", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        user.languages.forEach { TagChip(it.name, c.currencyDiamond) }
                    }
                }
                if (user.hobbies.isNotEmpty()) {
                    Text("Hobbies", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        user.hobbies.forEach { TagChip(it, c.brandSecondary) }
                    }
                }
                if (user.likes.isNotEmpty()) {
                    Text("Interests", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        user.likes.forEach { TagChip(it, c.brandPrimary) }
                    }
                }
            }

            if (state.giftsReceived.isNotEmpty()) {
                GlassCard(padding = PaddingValues(vertical = Space.lg)) {
                    Text("Gifts Received", style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.padding(horizontal = Space.lg))
                    LazyRow(contentPadding = PaddingValues(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        items(state.giftsReceived, key = { it.giftId }) { g ->
                            Column(
                                Modifier.width(72.dp).background(c.glassLow, RoundedCornerShape(Radius.md)).padding(vertical = Space.sm),
                                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                if (g.imageUrl.isNotBlank()) AsyncImage(g.imageUrl, null, modifier = Modifier.size(32.dp))
                                else Text(g.emoji, style = ZipperTheme.type.headingL)
                                Text(g.name, style = ZipperTheme.type.caption, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("×${g.count}", style = ZipperTheme.type.overline, color = c.brandVip)
                            }
                        }
                    }
                }
            }

            if (user.topSupporters.isNotEmpty()) {
                GlassCard {
                    Text("Top Supporters", style = ZipperTheme.type.headingS, color = c.textPrimary)
                    user.topSupporters.take(3).forEachIndexed { i, s ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                            Text("${i + 1}", style = ZipperTheme.type.numericM, color = if (i == 0) c.brandVip else c.textSecondary, modifier = Modifier.width(16.dp))
                            Avatar(s.photoUrl, size = AvatarSize.SM, ring = if (i == 0) AvatarRing.Vip else AvatarRing.None, initial = s.name)
                            Text(s.name, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Price(Currency.Diamond, s.totalDiamonds)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.navigationBarsPadding().height(Space.xl))
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun PresenceBanner(kind: LiveBadgeKind, hint: String, tint: Color, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = Space.md, start = Space.xl, end = Space.xl)
            .background(tint.copy(alpha = 0.14f), RoundedCornerShape(Radius.lg))
            .border(1.dp, tint, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick).padding(Space.md),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.size(40.dp).background(tint.copy(alpha = 0.14f), RoundedCornerShape(Radius.sm)), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.Videocam, null, tint = tint, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            LiveBadge(kind)
            Text(hint, style = ZipperTheme.type.caption, color = c.textSecondary)
        }
        Icon(Icons.Default.ChevronRight, null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun ActionDisc(
    icon: ImageVector, label: String, tint: Color, iconTint: Color, onClick: () -> Unit,
    enabled: Boolean = true, sub: @Composable () -> Unit = {},
) {
    val c = ZipperTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        IconButtonCircle(icon, label, onClick, size = 56.dp, background = tint, tint = iconTint, enabled = enabled)
        Text(label, style = ZipperTheme.type.labelS, color = c.textSecondary)
        sub()
    }
}


@Composable
private fun TagChip(text: String, tint: Color) {
    Box(
        Modifier.height(20.dp).background(tint.copy(alpha = 0.14f), CircleShape).border(1.dp, tint, CircleShape).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = ZipperTheme.type.labelS, color = tint, maxLines = 1) }
}

@Composable
private fun InfoRow(label: String, value: String) {
    val c = ZipperTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = ZipperTheme.type.bodyS, color = c.textMuted)
        Text(value, style = ZipperTheme.type.bodyS, color = c.textPrimary, textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.lg))
    }
}

/** Card with the Figma glass gradient (7%→2% white) and a hairline border. */
@Composable
fun GlassCard(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(Space.lg), content: @Composable ColumnScope.() -> Unit) {
    val c = ZipperTheme.colors
    Column(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg))
            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg))
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(Space.md),
        content = content,
    )
}

@Composable
private fun SheetRow(icon: ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    val tint = if (danger) c.statusDanger else c.textPrimary
    Row(
        Modifier.fillMaxWidth().clickableNoRipple(onClick).padding(horizontal = Space.xl, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
        Text(label, style = ZipperTheme.type.bodyL, color = tint)
    }
}
