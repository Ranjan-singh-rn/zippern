package com.zipper.datingapp.ui.screens

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.zipper.datingapp.ui.components.FuturisticConfirmCloseDialog
import com.zipper.datingapp.ui.components.FuturisticConfirmCloseStyle
import com.zipper.datingapp.ui.theme.AppContainerHi
import com.zipper.datingapp.ui.theme.AppWindowWidthClass
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.AppSurfaceVar
import com.zipper.datingapp.ui.theme.BrandCyan
import com.zipper.datingapp.ui.theme.BrandPink
import com.zipper.datingapp.ui.theme.BrandPinkDim
import com.zipper.datingapp.ui.theme.BrandPurple
import com.zipper.datingapp.ui.theme.BrandPurpleDim
import com.zipper.datingapp.ui.theme.GoldAccent
import com.zipper.datingapp.ui.theme.OutlineDefault
import com.zipper.datingapp.ui.theme.TextMuted
import com.zipper.datingapp.ui.theme.TextSecondary
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.zipper.datingapp.R
import com.zipper.datingapp.data.AppLanguage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.data.UserRole
import com.zipper.datingapp.data.VerificationStatus
import com.zipper.datingapp.data.computeHostLevel
import com.zipper.datingapp.data.currentLevelScore
import com.zipper.datingapp.data.levelThresholdPoints
import com.zipper.datingapp.data.levelTierName
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.components.VerifiedBadge

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    uiState: DatingUiState,
    onEditProfile: () -> Unit,
    onLogout: () -> Unit,
    onDeleteAccount: () -> Unit,
    onThemeToggle: () -> Unit,
    onBeansCenterClick: () -> Unit,
    onDiamondShopClick: () -> Unit,
    onRewardsClick: () -> Unit,
    onClaimReward: () -> Unit,
    onDismissRewards: () -> Unit,
    onLanguageChange: (AppLanguage) -> Unit,
    onConvertDiamonds: (Int) -> Unit,
    onVerifyProfile: () -> Unit,
    onGameCenterClick: () -> Unit,
    onSetCustomPrice: () -> Unit,
    /** Quick entry: start a video call from people on Discover. */
    onBrowseForVideoCalls: () -> Unit = {},
    /** Quick entry: open inbox to message and send gifts in DM. */
    onOpenInboxForGifts: () -> Unit = {},
    /** Unblock a user id from Profile → Blocked users. */
    onUnblockUser: (String) -> Unit = {},
    /** Load the current user's sent and received gift history. */
    onLoadMyGiftHistory: () -> Unit = {},
    /** Show My Profile full-screen sheet. */
    onShowMyProfile: () -> Unit = {},
    /** Navigate to Likes → I Like tab. */
    onShowLikesILike: () -> Unit = {},
    /** Navigate to Likes → Like Me tab. */
    onShowLikesLikeMe: () -> Unit = {},
    /** Open Blocked Users screen. */
    onShowBlockedUsers: () -> Unit = {},
    /** Refresh like counts (i-like and like-me). */
    onRefreshLikeCounts: () -> Unit = {},
    /** Open Feedback & Support screen. */
    onFeedbackClick: () -> Unit = {},
    /** Open My Bag (cosmetics) screen. */
    onMyBagClick: () -> Unit = {},
) {
    val context = LocalContext.current
    val user = uiState.currentUser ?: return
    val presenceFromFeed = uiState.profiles.find { it.id == user.id }
    val selfOnline = presenceFromFeed?.isOnline ?: user.isOnline
    var showLanguageDialog by remember { mutableStateOf(false) }
    var showConvertDialog by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showBlockedUsersSheet by remember { mutableStateOf(false) }
    var showLevelInfoDialog by remember { mutableStateOf(false) }
    var showStreamingHistoryDialog by remember { mutableStateOf(false) }

    fun resolveBlockedDisplayName(uid: String): String {
        val u = uid.trim()
        if (u.isEmpty()) return ""
        return uiState.profiles.find { it.id == u }?.name?.trim()?.takeIf { it.isNotEmpty() }
            ?: uiState.filteredProfiles.find { it.id == u }?.name?.trim()?.takeIf { it.isNotEmpty() }
            ?: u
    }

    val profileWidthClass = LocalWindowWidthClass.current
    Box(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .then(
                    if (profileWidthClass == AppWindowWidthClass.Compact) Modifier.fillMaxWidth()
                    else Modifier.widthIn(max = 680.dp)
                )
                .fillMaxHeight()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
        ) {
            // Header Section with Pink Gradient
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1.7f)
                    .background(
                        brush = Brush.verticalGradient(
                            colors = listOf(BrandPurpleDim, BrandPinkDim)
                        )
                    )
            ) {
                // Settings button top right
                IconButton(
                    onClick = { showSettings = true },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                ) {
                    Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.profile_settings), tint = Color.White)
                }

                Row(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = 20.dp, bottom = 50.dp)
                        .clickable { onShowMyProfile() },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Profile Avatar with Ring/Frame (online dot = Firestore [UserProfile.isOnline])
                    Box(modifier = Modifier.size(90.dp)) {
                        Box(
                            modifier = Modifier.align(Alignment.Center),
                            contentAlignment = Alignment.Center
                        ) {
                            // Base Avatar
                            Surface(
                                modifier = Modifier.size(70.dp),
                                shape = CircleShape,
                                color = AppSurfaceVar,
                            ) {
                                if (user.photoUrl.isRenderableImageUrl()) {
                                    SubcomposeAsyncImage(
                                        model = user.photoUrl,
                                        contentDescription = "Profile photo",
                                        modifier = Modifier.fillMaxSize(),
                                        loading = {
                                            Box(
                                                modifier = Modifier.fillMaxSize(),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                CircularProgressIndicator(
                                                    modifier = Modifier.size(18.dp),
                                                    strokeWidth = 2.dp,
                                                    color = Color.White
                                                )
                                            }
                                        },
                                        error = {
                                            Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                                                Icon(Icons.Default.BrokenImage, contentDescription = "Image load error", tint = Color.White)
                                            }
                                        }
                                    )
                                } else {
                                    Box(contentAlignment = Alignment.Center) {
                                        Text(
                                            text = user.name.take(1),
                                            color = Color.White,
                                            fontSize = 28.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                }
                            }

                            // Frame overlay
                            user.profileFrameId?.let { frameId ->
                                val frameColors = when (frameId) {
                                    "gold" -> listOf(Color(0xFFFFD700), Color(0xFFFFA000), Color(0xFFFFD700))
                                    "diamond" -> listOf(Color(0xFFB9F2FF), Color(0xFFFFFFFF), Color(0xFF00BCD4))
                                    "neon" -> listOf(Color(0xFF39FF14), Color(0xFFFF00FF), Color(0xFF39FF14))
                                    else -> if (frameId.startsWith("p"))
                                        listOf(Color(0xFFFFD700), Color(0xFFFFA000), Color(0xFFFFD700))
                                    else
                                        listOf(Color(0xFF4FC3F7), Color(0xFF81D4FA), Color(0xFF4FC3F7))
                                }
                                Box(
                                    modifier = Modifier
                                        .size(85.dp)
                                        .border(
                                            width = 4.dp,
                                            brush = Brush.sweepGradient(frameColors),
                                            shape = CircleShape
                                        )
                                )
                            }
                        }
                        if (selfOnline) {
                            val scheme = MaterialTheme.colorScheme
                            Surface(
                                modifier = Modifier
                                    .size(14.dp)
                                    .align(Alignment.BottomEnd),
                                shape = CircleShape,
                                color = scheme.primary,
                                border = BorderStroke(2.dp, Color.White)
                            ) {}
                        }
                    }

                    Spacer(modifier = Modifier.width(12.dp))

                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "${user.name} 🤫",
                                color = Color.White,
                                fontSize = 22.sp,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            if (user.hasBlueTick) {
                                Spacer(Modifier.width(4.dp))
                                VerifiedBadge(showLabel = true, size = 16.dp)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            // Boy/Age Badge
                            Surface(
                                color = BrandPurple.copy(alpha = 0.85f),
                                shape = RoundedCornerShape(12.dp)
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        imageVector = when (user.genderText) {
                                            "male" -> Icons.Default.Male
                                            "female" -> Icons.Default.Female
                                            else -> Icons.Default.Person
                                        },
                                        contentDescription = null,
                                        tint = Color.White,
                                        modifier = Modifier.size(14.dp)
                                    )
                                    Text("${user.age}", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            // Level Badge
                            Surface(
                                color = BrandPink.copy(alpha = 0.85f),
                                shape = RoundedCornerShape(12.dp)
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(Icons.Default.WorkspacePremium, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                                    Text("Lv${user.level}", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                "ID: ${user.profileNumber}",
                                color = Color.White.copy(alpha = 0.8f),
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Icon(Icons.Default.LocationOn, contentDescription = null, tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.size(12.dp))
                            Text(
                                user.city,
                                color = Color.White.copy(alpha = 0.8f),
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                        }
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            text = "Gender: ${user.genderText}",
                            color = Color.White.copy(alpha = 0.75f),
                            fontSize = 12.sp
                        )
                    }
                }
            }

            // White Content Card (Overlapping)
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .offset(y = (-30).dp),
                shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
                color = MaterialTheme.colorScheme.surface
            ) {
                Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp)) {
                    
                    // Verification Card — hidden once ANY verification flag is true.
                    // Guards on the full hasBlueTick computed property PLUS the raw booleans so
                    // the card disappears immediately on local state update, without waiting for
                    // the Firestore listener to re-fire.
                    if (!user.hasBlueTick && !user.isVerified && !user.isFaceVerified &&
                        user.faceVerificationStatus != VerificationStatus.APPROVED.name
                    ) {
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onVerifyProfile() },
                            color = AppContainerHi,
                            shape = RoundedCornerShape(16.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, GoldAccent.copy(alpha = 0.45f))
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(Icons.Default.Stars, contentDescription = null, tint = GoldAccent)
                                Spacer(Modifier.width(12.dp))
                                Column {
                                    Text(
                                        text = if (user.faceVerificationStatus == VerificationStatus.PENDING.name) "Verification Pending" else "Get Your Star Badge",
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface,
                                    )
                                    Text(
                                        text = "Complete face verification to earn a star badge!",
                                        fontSize = 12.sp,
                                        color = TextSecondary,
                                    )
                                }
                                Spacer(Modifier.weight(1f))
                                Icon(Icons.Default.ChevronRight, contentDescription = null, tint = TextMuted)
                            }
                        }
                        Spacer(modifier = Modifier.height(24.dp))
                    }

                    // Level Progress info for Girls
                    if (user.role == UserRole.GIRL.name) {
                        LevelProgressCard(user)
                        Spacer(modifier = Modifier.height(16.dp))
                    }

                    // Custom Call Price Section for Level 4+ Girls
                    if (user.role == UserRole.GIRL.name && user.displayProfileLevel >= 4) {
                        CustomCallPriceSection(user = user, onSetCustomPrice = onSetCustomPrice)
                        Spacer(modifier = Modifier.height(16.dp))
                    }

                    // Like Stats Row
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clickable { onShowLikesILike() }
                        ) {
                            Text("${uiState.iLikedProfiles.size}", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Text("I Like", fontSize = 14.sp, color = TextSecondary)
                        }
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clickable { onShowLikesLikeMe() }
                        ) {
                            Text("${uiState.likedMeProfiles.size}", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Text("Like Me", fontSize = 14.sp, color = TextSecondary)
                        }
                    }

                    Spacer(modifier = Modifier.height(30.dp))

                    // Currency Cards
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        CurrencyDetailCard(
                            label = "My Diamonds",
                            value = "${uiState.coinBalance}",
                            icon = Icons.Default.Diamond,
                            color = GoldAccent,
                            onClick = onDiamondShopClick,
                            modifier = Modifier.weight(1f)
                        )
                        CurrencyDetailCard(
                            label = "Beans Center",
                            value = "${uiState.beans}",
                            icon = Icons.Default.Circle,
                            color = BrandPink,
                            onClick = onBeansCenterClick,
                            modifier = Modifier.weight(1f)
                        )
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Button(
                            onClick = onBrowseForVideoCalls,
                            modifier = Modifier.weight(1f).height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = BrandPink),
                            shape = RoundedCornerShape(14.dp),
                            contentPadding = PaddingValues(horizontal = 8.dp)
                        ) {
                            Icon(Icons.Default.Videocam, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "Video calls",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        OutlinedButton(
                            onClick = onOpenInboxForGifts,
                            modifier = Modifier.weight(1f).height(48.dp),
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, GoldAccent.copy(alpha = 0.65f)),
                            contentPadding = PaddingValues(horizontal = 8.dp)
                        ) {
                            Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = GoldAccent, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "Gifts & chat",
                                color = MaterialTheme.colorScheme.onSurface,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))

                    // SPECIAL FEATURE: Convert Diamonds for Girls
                    if (user.role == UserRole.GIRL.name) {
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showConvertDialog = true },
                            color = AppContainerHi,
                            shape = RoundedCornerShape(12.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, GoldAccent.copy(alpha = 0.35f))
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(Icons.Default.PublishedWithChanges, contentDescription = null, tint = GoldAccent)
                                Spacer(Modifier.width(12.dp))
                                Column {
                                    Text("Convert Diamonds to Beans", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface)
                                    Text("Get 50% Beans back instantly!", fontSize = 12.sp, color = TextSecondary)
                                }
                                Spacer(Modifier.weight(1f))
                                Icon(Icons.Default.ChevronRight, contentDescription = null, tint = TextMuted)
                            }
                        }
                        Spacer(modifier = Modifier.height(24.dp))
                    }

                    // Menu List
                    if (!user.isGuest) {
                        ProfileMenuRow(
                            Icons.Default.Block,
                            stringResource(R.string.profile_blocked_users_row),
                            stringResource(R.string.profile_blocked_users_subtitle),
                            onClick = { showBlockedUsersSheet = true }
                        )
                    }
                    // Added: Custom Call Price Setting for Level 4+ Girls
                    if (user.role == UserRole.GIRL.name && user.displayProfileLevel >= 4) {
                        ProfileMenuRow(Icons.Default.Call, "Call Prices", "Set per min", onClick = onSetCustomPrice)
                    }

                    ProfileMenuRow(Icons.Default.CardGiftcard, "My Rewards", "New!", onClick = onRewardsClick)
                    ProfileMenuRow(Icons.Default.ShoppingBag, "My Bag", "Frames & effects", onClick = onMyBagClick)
                    ProfileMenuRow(Icons.Default.Language, "Language", uiState.selectedLanguage.label, onClick = { showLanguageDialog = true })
                    ProfileMenuRow(Icons.Default.Stars, "My Level", "Lv.${user.level}", onClick = { showLevelInfoDialog = true })
                    ProfileMenuRow(Icons.Default.History, "Streaming History", "${user.totalLiveMinutes / 60}h streamed", onClick = { showStreamingHistoryDialog = true })
                    ProfileMenuRow(Icons.Default.HeadsetMic, "Feedback & Support", "Report issues", onClick = onFeedbackClick)
                    ProfileMenuRow(Icons.Default.Settings, stringResource(R.string.profile_settings), "", onClick = { showSettings = true })

                    // DISPLAY REFERRAL CODE AT THE BOTTOM
                    if (!user.referralCode.isNullOrEmpty()) {
                        Spacer(modifier = Modifier.height(24.dp))
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.75f),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.Center
                            ) {
                                Icon(
                                    Icons.Default.Tag,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(16.dp)
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "Reference Code: ${user.referralCode}",
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(100.dp))
                }
            }
        }
    }

    if (showBlockedUsersSheet) {
        ModalBottomSheet(
            onDismissRequest = { showBlockedUsersSheet = false },
            dragHandle = { BottomSheetDefaults.DragHandle() },
            containerColor = MaterialTheme.colorScheme.surface
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp)
                    .navigationBarsPadding()
            ) {
                Text(
                    text = stringResource(R.string.profile_blocked_users_row),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(bottom = 4.dp)
                )
                Text(
                    text = stringResource(R.string.profile_blocked_users_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 12.dp)
                )
                val blocked = user.blockedUserIds.filter { it.isNotBlank() }.distinct()
                if (blocked.isEmpty()) {
                    Text(
                        text = stringResource(R.string.profile_blocked_users_empty),
                        modifier = Modifier.padding(vertical = 24.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 420.dp)
                    ) {
                        items(blocked, key = { it }) { uid ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        text = resolveBlockedDisplayName(uid),
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Text(
                                        text = uid,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                                OutlinedButton(
                                    onClick = {
                                        onUnblockUser(uid)
                                    },
                                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
                                ) {
                                    Text(stringResource(R.string.profile_unblock), fontSize = 12.sp)
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    if (showSettings) {
        ModalBottomSheet(
            onDismissRequest = { showSettings = false },
            dragHandle = { BottomSheetDefaults.DragHandle() },
            containerColor = MaterialTheme.colorScheme.surface
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp)
            ) {
                Text(
                    text = stringResource(R.string.profile_settings),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(bottom = 24.dp)
                )

                SettingsItem(
                    icon = Icons.Default.Edit,
                    title = stringResource(R.string.profile_edit_profile),
                    onClick = {
                        showSettings = false
                        onEditProfile()
                    }
                )

                SettingsItem(
                    icon = Icons.Default.Palette,
                    title = "Appearance (Dark/Light Mode)",
                    onClick = {
                        onThemeToggle()
                    }
                )

                SettingsItem(
                    icon = Icons.Default.OpenInNew,
                    title = stringResource(R.string.profile_update_app),
                    onClick = {
                        showSettings = false
                        runCatching {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(context.getString(R.string.profile_update_app_url)))
                            )
                        }.onFailure { e ->
                            Log.w("ProfileScreen", "open update URL", e)
                        }
                    }
                )

                HorizontalDivider(
                    modifier = Modifier.padding(vertical = 16.dp),
                    color = MaterialTheme.colorScheme.outline.copy(alpha = 0.38f)
                )

                SettingsItem(
                    icon = Icons.AutoMirrored.Filled.Logout,
                    title = stringResource(R.string.profile_logout),
                    titleColor = MaterialTheme.colorScheme.onSurface,
                    onClick = {
                        showSettings = false
                        onLogout()
                    }
                )

                SettingsItem(
                    icon = Icons.Default.DeleteForever,
                    title = stringResource(R.string.profile_delete_account),
                    titleColor = Color.Red,
                    onClick = {
                        showSettings = false
                        showDeleteConfirm = true
                    }
                )
                
                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }

    if (showDeleteConfirm) {
        FuturisticConfirmCloseDialog(
            onDismissRequest = { showDeleteConfirm = false },
            onConfirm = {
                showDeleteConfirm = false
                onDeleteAccount()
            },
            titleContent = {
                Text(
                    text = stringResource(R.string.profile_delete_confirm_title),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                )
            },
            textContent = {
                Text(
                    text = stringResource(R.string.profile_delete_confirm_body),
                    color = Color.White.copy(alpha = 0.88f),
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            },
            confirmStyle = FuturisticConfirmCloseStyle.Destructive,
            confirmLabelResId = R.string.profile_delete_permanently,
        )
    }

    if (uiState.showRewardsDialog) {
        RewardsDialog(
            points = uiState.rewardsPoints,
            canClaim = uiState.canClaimDailyReward,
            onClaim = onClaimReward,
            onDismiss = onDismissRewards
        )
    }

    if (showLanguageDialog) {
        LanguageSelectionDialog(
            currentLanguage = uiState.selectedLanguage,
            onLanguageSelected = { 
                onLanguageChange(it)
                showLanguageDialog = false
            },
            onDismiss = { showLanguageDialog = false }
        )
    }

    if (showConvertDialog) {
        ConvertDiamondsDialog(
            diamondBalance = uiState.coinBalance,
            onConvert = {
                onConvertDiamonds(it)
                showConvertDialog = false
            },
            onDismiss = { showConvertDialog = false }
        )
    }

    if (showLevelInfoDialog) {
        AlertDialog(
            onDismissRequest = { showLevelInfoDialog = false },
            title = { Text("My Level") },
            text = {
                Column {
                    Text("Current Level: ${user.level}", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text("Keep spending diamonds to level up and unlock exclusive features!")
                }
            },
            confirmButton = { TextButton(onClick = { showLevelInfoDialog = false }) { Text("OK") } }
        )
    }

    if (showStreamingHistoryDialog) {
        AlertDialog(
            onDismissRequest = { showStreamingHistoryDialog = false },
            title = { Text("Streaming History") },
            text = {
                Column {
                    Text("Total streamed: ${user.totalLiveMinutes / 60}h ${user.totalLiveMinutes % 60}m", fontWeight = FontWeight.Bold)
                }
            },
            confirmButton = { TextButton(onClick = { showStreamingHistoryDialog = false }) { Text("Close") } }
        )
    }
}

@Composable
fun SettingsItem(
    icon: ImageVector,
    title: String,
    titleColor: Color = MaterialTheme.colorScheme.onSurface,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = titleColor.copy(alpha = 0.88f), modifier = Modifier.size(24.dp))
        Spacer(modifier = Modifier.width(16.dp))
        Text(text = title, style = MaterialTheme.typography.bodyLarge, color = titleColor)
        Spacer(modifier = Modifier.weight(1f))
        Icon(
            Icons.Default.ChevronRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            modifier = Modifier.size(20.dp)
        )
    }
}

@Composable
fun ConvertDiamondsDialog(
    diamondBalance: Int,
    onConvert: (Int) -> Unit,
    onDismiss: () -> Unit
) {
    var amountText by remember { mutableStateOf("") }
    val amount = amountText.toIntOrNull() ?: 0
    val beansReceived = (amount * 0.5).toInt()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Convert Diamonds", fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text(
                    "Available: $diamondBalance 💎",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = amountText,
                    onValueChange = { if(it.isEmpty() || it.all { c -> c.isDigit() }) amountText = it },
                    label = { Text("Amount to convert") },
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true
                )
                Spacer(Modifier.height(8.dp))
                if (amount > 0) {
                    Surface(
                        color = BrandCyan.copy(alpha = 0.12f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            "You will receive: $beansReceived 🫘",
                            modifier = Modifier.padding(8.dp),
                            color = BrandCyan,
                            fontWeight = FontWeight.Bold,
                            textAlign = TextAlign.Center
                        )
                    }
                }
                if (amount > diamondBalance) {
                    Text("Insufficient diamonds!", color = Color.Red, fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConvert(amount) },
                enabled = amount > 0 && amount <= diamondBalance,
                colors = ButtonDefaults.buttonColors(containerColor = BrandPink)
            ) {
                Text("Convert Now")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
        containerColor = MaterialTheme.colorScheme.surface,
        titleContentColor = MaterialTheme.colorScheme.onSurface,
        textContentColor = MaterialTheme.colorScheme.onSurface
    )
}

@Composable
fun LanguageSelectionDialog(
    currentLanguage: AppLanguage,
    onLanguageSelected: (AppLanguage) -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Select Language", fontWeight = FontWeight.Bold) },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                AppLanguage.entries.forEach { language ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onLanguageSelected(language) }
                            .padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(
                            selected = language == currentLanguage,
                            onClick = { onLanguageSelected(language) }
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(text = language.label, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = MaterialTheme.colorScheme.surface,
        titleContentColor = MaterialTheme.colorScheme.onSurface,
        textContentColor = MaterialTheme.colorScheme.onSurface
    )
}

@Composable
fun RewardsDialog(points: Int, canClaim: Boolean, onClaim: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            if (canClaim) {
                Button(onClick = onClaim, colors = ButtonDefaults.buttonColors(containerColor = BrandPink)) {
                    Text("Claim Daily Reward (+50 pts)")
                }
            } else {
                TextButton(onClick = onDismiss) { Text("Close") }
            }
        },
        title = { Text("Daily Rewards Center 🎁", fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("Current Reward Points: $points", fontWeight = FontWeight.Medium, color = BrandPurple)
                Spacer(Modifier.height(16.dp))
                if (canClaim) {
                    Text("Your daily bonus is ready! Claim it to earn points and free diamonds.")
                } else {
                    Text(
                        "You've already claimed your reward for today. Come back tomorrow!",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                
                Spacer(Modifier.height(24.dp))
                Text("How to earn more:", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text("• 5 mins live streaming: +10 pts", fontSize = 12.sp)
                Text("• Send 5 gifts: +20 pts", fontSize = 12.sp)
                Text("• Complete 1 battle: +15 pts", fontSize = 12.sp)
            }
        },
        containerColor = MaterialTheme.colorScheme.surface,
        titleContentColor = MaterialTheme.colorScheme.onSurface,
        textContentColor = MaterialTheme.colorScheme.onSurface,
        shape = RoundedCornerShape(24.dp)
    )
}

@Composable
fun LevelProgressCard(user: UserProfile) {
    val totalMinutes = user.totalLiveMinutes + user.totalStreamingMinutes
    val diamonds = maxOf(user.diamondsEarned, user.gems.toLong())
    val currentLv = computeHostLevel(totalMinutes, diamonds)
    val nextLv = (currentLv + 1).coerceAtMost(99)
    val tierName = levelTierName(currentLv)
    val tierColor = when {
        currentLv <= 3  -> Color(0xFF78909C) // Newcomer: slate
        currentLv <= 6  -> Color(0xFFEF9A9A) // Rising Star: soft red
        currentLv <= 10 -> Color(0xFFFFB300) // Star: amber
        currentLv <= 20 -> Color(0xFFAB47BC) // Super Star: purple
        currentLv <= 50 -> Color(0xFF00BCD4) // Elite: cyan
        else            -> Color(0xFFFFD700) // Legend: gold
    }

    val currentScore = currentLevelScore(totalMinutes, diamonds)
    val thisLvThreshold = levelThresholdPoints(currentLv)
    val nextLvThreshold = levelThresholdPoints(nextLv)
    val progressInTier = if (nextLvThreshold > thisLvThreshold) {
        ((currentScore - thisLvThreshold).toFloat() / (nextLvThreshold - thisLvThreshold).toFloat()).coerceIn(0f, 1f)
    } else 1f

    val hoursStreamed = totalMinutes / 60
    val nextLevelHint = when {
        currentLv < 4  -> "Stream ${((thisLvThreshold + 10 - currentScore) * 5).coerceAtLeast(1)} more minutes to level up"
        currentLv < 7  -> "Keep streaming daily — ${user.liveDaysStreak} day streak active"
        currentLv < 11 -> "Earn more gifts — ${diamonds} diamonds earned so far"
        currentLv < 21 -> "You're a Super Star! Keep earning gifts and streaming"
        currentLv < 51 -> "Elite level — continue to build your legend"
        else           -> "You are a Legend! Keep inspiring your community"
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = tierColor.copy(alpha = 0.12f),
        shape = RoundedCornerShape(16.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, tierColor.copy(alpha = 0.35f))
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(color = tierColor, shape = RoundedCornerShape(8.dp)) {
                    Text(
                        "Lv $currentLv",
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        color = Color.White,
                        fontWeight = FontWeight.Black,
                        fontSize = 13.sp
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(tierName, fontWeight = FontWeight.Bold, color = tierColor, fontSize = 14.sp)
                Spacer(Modifier.weight(1f))
                if (currentLv < 99) {
                    Text("→ Lv $nextLv", color = tierColor.copy(alpha = 0.7f), fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(10.dp))

            LinearProgressIndicator(
                progress = { progressInTier },
                modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape),
                color = tierColor,
                trackColor = tierColor.copy(alpha = 0.18f)
            )

            Spacer(Modifier.height(6.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${(progressInTier * 100).toInt()}% to next level", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Text("${hoursStreamed}h streamed · ${diamonds} diamonds", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            }

            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Lightbulb, contentDescription = null, tint = tierColor, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(nextLevelHint, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f))
            }

            if (currentLv >= 4 && user.genderText == "female") {
                Spacer(Modifier.height(8.dp))
                Surface(color = AppContainerHi, shape = RoundedCornerShape(8.dp), border = androidx.compose.foundation.BorderStroke(1.dp, OutlineDefault)) {
                    Row(modifier = Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.MonetizationOn, contentDescription = null, tint = GoldAccent, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Level 4+ unlocks custom call pricing!", fontSize = 11.sp, color = TextSecondary, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

/**
 * Shown on the profile of Level 4+ girls. Displays the currently configured custom audio/video
 * call prices (or "Not set" prompts) and routes to the price-setting flow via [onSetCustomPrice].
 */
@Composable
fun CustomCallPriceSection(user: UserProfile, onSetCustomPrice: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onSetCustomPrice() },
        color = AppContainerHi,
        shape = RoundedCornerShape(16.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, BrandPink.copy(alpha = 0.35f))
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.MonetizationOn, contentDescription = null, tint = BrandPink, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("My Call Prices", fontWeight = FontWeight.Bold, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.weight(1f))
                Surface(color = BrandPink, shape = RoundedCornerShape(6.dp)) {
                    Text("Level ${user.level}+", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(modifier = Modifier.weight(1f), color = AppSurfaceVar, shape = RoundedCornerShape(10.dp)) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Phone, contentDescription = null, tint = BrandCyan, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Audio Call", fontSize = 11.sp, color = TextSecondary)
                        }
                        Spacer(Modifier.height(4.dp))
                        if (user.customAudioPrice != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Diamond, contentDescription = null, tint = GoldAccent, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("${user.customAudioPrice}/min", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        } else {
                            Text("Tap to set price", fontSize = 12.sp, color = BrandPink, fontWeight = FontWeight.Medium)
                        }
                    }
                }
                Surface(modifier = Modifier.weight(1f), color = AppSurfaceVar, shape = RoundedCornerShape(10.dp)) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Videocam, contentDescription = null, tint = BrandPurple, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Video Call", fontSize = 11.sp, color = TextSecondary)
                        }
                        Spacer(Modifier.height(4.dp))
                        if (user.customVideoPrice != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Diamond, contentDescription = null, tint = GoldAccent, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("${user.customVideoPrice}/min", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        } else {
                            Text("Tap to set price", fontSize = 12.sp, color = BrandPink, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Set your own per-minute rate. Boys pay your rate to call you.",
                fontSize = 10.sp,
                color = TextMuted,
            )
        }
    }
}

@Composable
fun CurrencyDetailCard(label: String, value: String, icon: ImageVector, color: Color, onClick: () -> Unit, modifier: Modifier) {
    Surface(
        modifier = modifier.height(90.dp).clickable { onClick() },
        color = color.copy(alpha = 0.15f),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text(value, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.weight(1f))
                Icon(
                    Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.52f),
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

@Composable
fun ProfileMenuRow(icon: ImageVector, title: String, tag: String, onClick: () -> Unit = {}) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f), modifier = Modifier.size(24.dp))
        Spacer(modifier = Modifier.width(16.dp))
        Text(title, modifier = Modifier.weight(1f), fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface)
        if (tag.isNotEmpty()) {
            Text(tag, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
            Spacer(modifier = Modifier.width(8.dp))
        }
        Icon(
            Icons.Default.ChevronRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            modifier = Modifier.size(20.dp)
        )
    }
}

private fun String?.isRenderableImageUrl(): Boolean {
    if (this.isNullOrBlank()) return false
    val uri = Uri.parse(this)
    val scheme = uri.scheme?.lowercase()
    return (scheme == "https" || scheme == "http") && !uri.host.isNullOrBlank()
}
