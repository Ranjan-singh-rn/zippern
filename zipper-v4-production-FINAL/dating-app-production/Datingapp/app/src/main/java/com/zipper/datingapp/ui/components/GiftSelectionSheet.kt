package com.zipper.datingapp.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.widget.Toast
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Diamond
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.datingapp.R
import com.zipper.datingapp.data.Gift
import com.zipper.datingapp.data.LuckyGiftsOutcome
import com.zipper.datingapp.data.fallbackImageVector
import com.zipper.datingapp.data.giftIconTintOnOrb
import com.zipper.datingapp.data.giftOrbGradient
import com.zipper.datingapp.data.toResolvedCrmGift
import com.zipper.datingapp.ui.paddingWithNavigationBars
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

private val LuckyQuantityOptions = listOf(15, 25, 35, 50, 75, 100)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftSelectionSheet(
    gifts: List<Gift>,
    coinBalance: Int,
    isProcessing: Boolean = false,
    onTopUpCoins: () -> Unit,
    onDismiss: () -> Unit,
    onSend: (Gift, Int) -> Unit,
    /** Live / WebRTC PK: pick battler by Firebase uid (first = host, second = guest). */
    pkBattlerRecipients: List<Pair<String, String>>? = null,
    onSendGiftToPkBattler: ((receiverUserId: String, gift: Gift, count: Int) -> Unit)? = null,
    /** Shown under the title when picking a PK streamer so viewers know gifts affect the battle. */
    pkGiftScoreHint: String? = null,
    /** Game Center live battle: team index 1 or 2. */
    pkGameBattleTeams: List<Pair<Int, String>>? = null,
    /** Same order as [pkGameBattleTeams]: team index to Firebase uid (for lucky gifts callable). */
    pkGameBattleTeamUserIds: List<Pair<Int, String>>? = null,
    onSendGiftToPkGameTeam: ((team: Int, gift: Gift, count: Int) -> Unit)? = null,
    /**
     * When not in PK / game-team mode, recipient uid for [onLuckySend].
     */
    luckyGiftReceiverId: String? = null,
    /**
     * Invokes `processLuckyGifts` (wired from [com.zipper.datingapp.ui.DatingViewModel.processLuckyGifts]).
     */
    onLuckySend: (suspend (receiverId: String, giftPrice: Int, quantity: Int) -> LuckyGiftsOutcome)? = null,
    /**
     * After a successful lucky purchase: play [com.zipper.datingapp.ui.components.GiftOverlay] and optionally
     * mirror premium gifts by posting `live_streams/.../messages` when the host wires it (e.g. [com.zipper.datingapp.ui.DatingViewModel.publishLuckyGiftVisual]).
     */
    onLuckyGiftVisual: ((gift: Gift, receiverId: String, quantity: Int, transactionId: String?) -> Unit)? = null,
    /**
     * Itzo-style audio party gift sheet: warmer accent colors (still dark body for grid contrast).
     */
    itzoAudioPartyGiftPresentation: Boolean = false,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val pickBattlerToast = stringResource(R.string.pk_gift_select_battler_first)
    val giftToLabel = stringResource(R.string.pk_gift_send_to)
    val giftTabPremium = stringResource(R.string.gift_tab_premium)
    val giftTabLucky = stringResource(R.string.gift_tab_lucky)

    var crmGifts by remember { mutableStateOf<List<Gift>>(emptyList()) }
    var crmLuckyGifts by remember { mutableStateOf<List<Gift>>(emptyList()) }
    LaunchedEffect(Unit) {
        runCatching {
            coroutineScope {
                val db = FirebaseFirestore.getInstance()
                val premiumSnapDef = async {
                    db.collection("crm_gifts").whereEqualTo("active", true).get().await()
                }
                val luckySnapDef = async {
                    db.collection("crm_lucky_gifts").whereEqualTo("active", true).get().await()
                }
                crmGifts = premiumSnapDef.await().documents.mapNotNull { doc ->
                    runCatching { doc.toResolvedCrmGift() }.getOrNull()
                }
                crmLuckyGifts = luckySnapDef.await().documents.mapNotNull { doc ->
                    runCatching {
                        doc.toResolvedCrmGift()?.copy(category = "LUCKY")
                    }.getOrNull()
                }
            }
        }
    }

    val luckyGifts = remember(crmLuckyGifts) {
        crmLuckyGifts.sortedBy { it.price }
    }
    val allGiftsForPremium = remember(gifts, crmGifts) {
        gifts + crmGifts.filter { !it.category.equals("LUCKY", ignoreCase = true) }
    }
    val showLuckyTab = luckyGifts.isNotEmpty() && onLuckySend != null

    val categories = remember(allGiftsForPremium) {
        allGiftsForPremium.map { it.category.ifBlank { "STANDARD" } }
            .distinct()
            .sortedWith(compareBy {
                when {
                    it == "CRM_PREMIUM" -> 2
                    it.contains("PREMIUM", true) -> 1
                    else -> 0
                }
            })
    }
    var selectedTab by remember(categories) { mutableIntStateOf(0) }
    var primaryTab by remember { mutableIntStateOf(0) }
    var showTopUpDialog by remember { mutableStateOf(false) }
    var selectedPkUid by remember { mutableStateOf<String?>(null) }
    var selectedPkTeam by remember { mutableIntStateOf(0) }
    var selectedLuckyGift by remember { mutableStateOf<Gift?>(null) }
    var luckyQuantity by remember { mutableIntStateOf(LuckyQuantityOptions.first()) }
    var luckySending by remember { mutableStateOf(false) }
    var jackpotDiamonds by remember { mutableStateOf<Int?>(null) }

    val pkBattlerUidKey = pkBattlerRecipients.orEmpty().map { it.first }.filter { it.isNotBlank() }.sorted().joinToString(",")
    val pkGameTeamKey = pkGameBattleTeams.orEmpty().map { it.first }.sorted().joinToString(",")
    LaunchedEffect(pkBattlerUidKey, pkGameTeamKey) {
        selectedPkTeam = 0
        val battlers = pkBattlerRecipients.orEmpty().filter { it.first.isNotBlank() }.distinctBy { it.first }
        selectedPkUid = when {
            battlers.size == 1 -> battlers[0].first
            battlers.size >= 2 -> battlers[0].first
            else -> null
        }
    }

    val giftListMaxHeight = (LocalConfiguration.current.screenHeightDp * 0.38f).dp

    fun resolveLuckyReceiverId(): String? {
        return when {
            onSendGiftToPkGameTeam != null && !pkGameBattleTeams.isNullOrEmpty() -> {
                if (selectedPkTeam == 0) null
                else {
                    pkGameBattleTeamUserIds
                        ?.firstOrNull { it.first == selectedPkTeam }
                        ?.second
                        ?.trim()
                        ?.takeIf { it.isNotBlank() }
                }
            }
            onSendGiftToPkBattler != null && !pkBattlerRecipients.isNullOrEmpty() ->
                selectedPkUid?.trim()?.takeIf { it.isNotBlank() }
            else ->
                luckyGiftReceiverId?.trim()?.takeIf { it.isNotBlank() }
        }
    }

    fun attemptSendGift(gift: Gift) {
        if (isProcessing) return
        when {
            onSendGiftToPkGameTeam != null && !pkGameBattleTeams.isNullOrEmpty() -> {
                if (selectedPkTeam == 0) {
                    Toast.makeText(ctx, pickBattlerToast, Toast.LENGTH_SHORT).show()
                    return
                }
                if (coinBalance >= gift.price) {
                    onSendGiftToPkGameTeam.invoke(selectedPkTeam, gift, 1)
                } else {
                    showTopUpDialog = true
                }
            }
            onSendGiftToPkBattler != null && !pkBattlerRecipients.isNullOrEmpty() -> {
                val uid = selectedPkUid
                if (uid.isNullOrBlank()) {
                    Toast.makeText(ctx, pickBattlerToast, Toast.LENGTH_SHORT).show()
                    return
                }
                if (coinBalance >= gift.price) {
                    onSendGiftToPkBattler.invoke(uid, gift, 1)
                } else {
                    showTopUpDialog = true
                }
            }
            else -> {
                if (coinBalance >= gift.price) {
                    onSend(gift, 1)
                } else {
                    showTopUpDialog = true
                }
            }
        }
    }

    fun attemptSendLucky() {
        if (luckySending || isProcessing) return
        val gift = selectedLuckyGift
        if (gift == null) {
            Toast.makeText(ctx, ctx.getString(R.string.gift_lucky_pick_first), Toast.LENGTH_SHORT).show()
            return
        }
        if (onSendGiftToPkGameTeam != null && !pkGameBattleTeams.isNullOrEmpty() && selectedPkTeam == 0) {
            Toast.makeText(ctx, pickBattlerToast, Toast.LENGTH_SHORT).show()
            return
        }
        if (onSendGiftToPkBattler != null && !pkBattlerRecipients.isNullOrEmpty() && selectedPkUid.isNullOrBlank()) {
            Toast.makeText(ctx, pickBattlerToast, Toast.LENGTH_SHORT).show()
            return
        }
        val receiver = resolveLuckyReceiverId()
        if (receiver.isNullOrBlank()) {
            Toast.makeText(ctx, ctx.getString(R.string.gift_lucky_no_receiver), Toast.LENGTH_SHORT).show()
            return
        }
        val total = gift.price * luckyQuantity
        if (total <= 0) return
        if (coinBalance < total) {
            showTopUpDialog = true
            return
        }
        val send = onLuckySend ?: return
        scope.launch {
            luckySending = true
            try {
                when (val outcome = send(receiver, gift.price, luckyQuantity)) {
                    is LuckyGiftsOutcome.Success -> {
                        onLuckyGiftVisual?.invoke(gift, receiver, luckyQuantity, outcome.transactionId)
                        if (outcome.diamondsWon > 0) {
                            jackpotDiamonds = outcome.diamondsWon
                        } else {
                            Toast.makeText(
                                ctx,
                                ctx.getString(R.string.gift_lucky_success),
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    }
                    is LuckyGiftsOutcome.Failure -> {
                        Toast.makeText(ctx, outcome.reason, Toast.LENGTH_LONG).show()
                    }
                }
            } finally {
                luckySending = false
            }
        }
    }

    val sheetBg =
        if (itzoAudioPartyGiftPresentation) Color(0xFF251018) else Color(0xFF1F1F2E)
    val onSheetLabel = if (itzoAudioPartyGiftPresentation) Color(0xFFFFE8F4) else Color.White
    val onSheetMuted = if (itzoAudioPartyGiftPresentation) Color(0xFFFFE8F4).copy(alpha = 0.72f) else Color.White.copy(alpha = 0.72f)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = sheetBg,
        dragHandle = {
            BottomSheetDefaults.DragHandle(
                color = if (itzoAudioPartyGiftPresentation) Color(0xFFFF8CC8).copy(alpha = 0.45f) else Color.White.copy(alpha = 0.3f),
            )
        },
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            if (itzoAudioPartyGiftPresentation) {
                Box(
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .height(3.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(
                                Brush.horizontalGradient(
                                    listOf(Color(0xFFFFDDFF), Color(0xFFFF4081), Color(0xFFFF8C42)),
                                ),
                            ),
                )
                Spacer(Modifier.height(10.dp))
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Send a Gift",
                    color = onSheetLabel,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                )
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(
                            if (itzoAudioPartyGiftPresentation) Color(0xFFFFDDFF).copy(alpha = 0.18f) else Color.White.copy(alpha = 0.1f),
                        )
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_diamond),
                        contentDescription = null,
                        tint = onSheetLabel,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = coinBalance.toString(),
                        color = onSheetLabel,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            if (!pkGiftScoreHint.isNullOrBlank() &&
                onSendGiftToPkBattler != null &&
                !pkBattlerRecipients.isNullOrEmpty()
            ) {
                Text(
                    text = pkGiftScoreHint,
                    color = onSheetMuted,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    modifier = Modifier.padding(bottom = 10.dp),
                )
            }
            if (isProcessing) {
                Row(
                    modifier = Modifier.padding(bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = Color(0xFFFFD700),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Processing payment...", color = onSheetMuted, fontSize = 12.sp)
                }
            }

            if (!pkGameBattleTeams.isNullOrEmpty() && onSendGiftToPkGameTeam != null) {
                Text(giftToLabel, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    pkGameBattleTeams.forEach { (team, name) ->
                        FilterChip(
                            selected = selectedPkTeam == team,
                            onClick = { selectedPkTeam = team },
                            label = {
                                Text(
                                    name,
                                    maxLines = 1,
                                    fontSize = 12.sp,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            } else if (!pkBattlerRecipients.isNullOrEmpty() && onSendGiftToPkBattler != null) {
                Text(giftToLabel, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    pkBattlerRecipients.forEach { (uid, name) ->
                        FilterChip(
                            selected = selectedPkUid == uid,
                            onClick = { selectedPkUid = uid },
                            label = {
                                Text(
                                    name,
                                    maxLines = 1,
                                    fontSize = 12.sp,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            if (showLuckyTab) {
                TabRow(
                    selectedTabIndex = primaryTab,
                    containerColor = Color.Transparent,
                    contentColor = Color.White,
                    indicator = { tabPositions ->
                        TabRowDefaults.SecondaryIndicator(
                            Modifier.tabIndicatorOffset(tabPositions[primaryTab]),
                            color = Color(0xFFFFD700),
                        )
                    },
                ) {
                    Tab(
                        selected = primaryTab == 0,
                        onClick = { primaryTab = 0 },
                        text = {
                            Text(giftTabPremium, fontWeight = FontWeight.Bold, color = Color.White)
                        },
                    )
                    Tab(
                        selected = primaryTab == 1,
                        onClick = { primaryTab = 1 },
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.AutoAwesome,
                                    contentDescription = null,
                                    tint = Color(0xFFFFD700),
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    giftTabLucky,
                                    fontWeight = FontWeight.Bold,
                                    color = Color(0xFFFFD700),
                                )
                            }
                        },
                    )
                }
                Spacer(Modifier.height(12.dp))
            }

            when {
                showLuckyTab && primaryTab == 1 -> {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(minSize = 88.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 160.dp, max = giftListMaxHeight),
                        contentPadding = paddingWithNavigationBars(bottomExtra = 8.dp),
                    ) {
                        items(
                            luckyGifts,
                            key = { g -> "lucky_${g.id}_${g.crmDocId}_${g.name}_${g.price}" },
                        ) { gift ->
                            GiftSelectionSheetGiftTile(
                                gift = gift,
                                isProcessing = isProcessing || luckySending,
                                isSelected = selectedLuckyGift?.let { it.id == gift.id && it.price == gift.price } == true,
                                onClick = {
                                    selectedLuckyGift = gift
                                },
                            )
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        items(LuckyQuantityOptions) { q ->
                            FilterChip(
                                selected = luckyQuantity == q,
                                onClick = { luckyQuantity = q },
                                label = { Text("×$q", fontSize = 12.sp, fontWeight = FontWeight.SemiBold) },
                            )
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (luckySending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(28.dp),
                                strokeWidth = 2.dp,
                                color = Color(0xFFFFD700),
                            )
                        }
                        Button(
                            onClick = { attemptSendLucky() },
                            enabled = !luckySending && !isProcessing && selectedLuckyGift != null,
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFFD700)),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Text(
                                stringResource(R.string.gift_lucky_send),
                                color = Color(0xFF1F1F2E),
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }
                else -> {
                    val premiumShimmer = rememberInfiniteTransition(label = "premTab").animateFloat(
                        initialValue = 0f,
                        targetValue = 1f,
                        animationSpec = infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Reverse),
                        label = "premTabShimmer",
                    )
                    TabRow(
                        selectedTabIndex = selectedTab,
                        containerColor = Color.Transparent,
                        contentColor = Color.White,
                        indicator = { tabPositions ->
                            TabRowDefaults.SecondaryIndicator(
                                Modifier.tabIndicatorOffset(tabPositions[selectedTab]),
                                color = Color(0xFFFFD700),
                            )
                        },
                    ) {
                        categories.forEachIndexed { index, category ->
                            val isCrm = category == "CRM_PREMIUM"
                            val isPrem = category.contains("PREMIUM", true)
                            Tab(
                                selected = selectedTab == index,
                                onClick = { selectedTab = index },
                                text = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        when {
                                            isCrm -> {
                                                Icon(
                                                    Icons.Default.Star,
                                                    contentDescription = null,
                                                    tint = Color(0xFFFFD700),
                                                    modifier = Modifier
                                                        .size(16.dp)
                                                        .graphicsLayer { alpha = 0.6f + 0.4f * premiumShimmer.value },
                                                )
                                                Spacer(Modifier.width(4.dp))
                                            }
                                            isPrem -> {
                                                Icon(
                                                    Icons.Default.LocalFireDepartment,
                                                    contentDescription = null,
                                                    tint = Color(0xFFFF6B9D),
                                                    modifier = Modifier.size(16.dp),
                                                )
                                                Spacer(Modifier.width(4.dp))
                                            }
                                            else -> Unit
                                        }
                                        Text(
                                            when (category) {
                                                "CRM_PREMIUM" -> "Premium"
                                                "3D_PREMIUM" -> "3D Gifts"
                                                "STANDARD" -> "Standard"
                                                else -> category.replace('_', ' ')
                                            },
                                            fontWeight = FontWeight.Bold,
                                            color = when {
                                                isCrm -> Color(0xFFFFD700)
                                                isPrem -> Color(0xFFFF6B9D)
                                                else -> Color.White
                                            },
                                        )
                                    }
                                },
                            )
                        }
                    }

                    Spacer(Modifier.height(16.dp))

                    val selectedCategory = categories.getOrNull(selectedTab)
                    if (selectedCategory == "CRM_PREMIUM") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(
                                    Brush.linearGradient(listOf(Color(0xFF7B1FA2), Color(0xFFE91E63))),
                                    RoundedCornerShape(10.dp),
                                )
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.Star, contentDescription = null, tint = Color(0xFFFFD700), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text("Exclusive Premium Gifts", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text("Curated by our team · Limited availability", color = Color.White.copy(alpha = 0.7f), fontSize = 10.sp)
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                    }

                    val currentList = allGiftsForPremium
                        .filter { it.category.ifBlank { "STANDARD" } == selectedCategory }
                        .sortedBy { it.price }

                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(minSize = 88.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 200.dp, max = giftListMaxHeight),
                        contentPadding = paddingWithNavigationBars(bottomExtra = 8.dp),
                    ) {
                        items(
                            currentList,
                            key = { g -> "${g.id}_${g.crmDocId}_${g.name}_${g.price}" },
                        ) { gift ->
                            GiftSelectionSheetGiftTile(
                                gift = gift,
                                isProcessing = isProcessing,
                                isSelected = false,
                                onClick = { attemptSendGift(gift) },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    jackpotDiamonds?.let { won ->
        LuckyJackpotCelebrationDialog(
            diamondsWon = won,
            onDismiss = { jackpotDiamonds = null },
        )
    }

    if (showTopUpDialog) {
        FuturisticConfirmCloseDialog(
            onDismissRequest = { showTopUpDialog = false },
            onConfirm = {
                showTopUpDialog = false
                onTopUpCoins()
            },
            titleContent = {
                Text(
                    text = "Top-up Coins",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                )
            },
            textContent = {
                Text(
                    text = "You don't have enough coins for this gift. Please top up to continue.",
                    color = Color.White.copy(alpha = 0.88f),
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            },
            confirmLabelResId = R.string.teaser_paywall_packages_header,
        )
    }
}

@Composable
private fun GiftSelectionSheetGiftTile(
    gift: Gift,
    isProcessing: Boolean,
    isSelected: Boolean = false,
    onClick: () -> Unit,
) {
    val isPremiumStyle = gift.category.contains("PREMIUM", true) ||
        gift.category.equals("LUCKY", ignoreCase = true)
    val orbBrush = remember(gift.id, gift.name) { gift.giftOrbGradient() }
    val iconTint = remember(gift.id, gift.name) { gift.giftIconTintOnOrb() }
    val rimBrush = remember(gift.id, gift.name) {
        Brush.linearGradient(
            listOf(
                Color.White.copy(alpha = 0.85f),
                Color(0xFFFFD700).copy(alpha = 0.7f),
                Color.White.copy(alpha = 0.5f),
            ),
        )
    }
    val borderWidth = if (isSelected) 2.dp else 1.dp
    val borderColor = when {
        isSelected -> Color(0xFFFFD700)
        isPremiumStyle -> Color(0xFFFF6B9D).copy(alpha = 0.3f)
        else -> Color.Transparent
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = !isProcessing) { onClick() }
            .background(
                if (isPremiumStyle) Color(0xFFFF6B9D).copy(alpha = 0.1f) else Color.Transparent,
                RoundedCornerShape(12.dp),
            )
            .border(
                borderWidth,
                borderColor,
                RoundedCornerShape(12.dp),
            )
            .padding(horizontal = 6.dp, vertical = 8.dp),
    ) {
        Surface(
            modifier = Modifier.size(64.dp),
            shape = CircleShape,
            color = Color.Transparent,
            shadowElevation = 10.dp,
            tonalElevation = 0.dp,
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .border(2.dp, rimBrush, CircleShape)
                    .padding(2.dp)
                    .clip(CircleShape)
                    .background(orbBrush)
                    .drawBehind {
                        val c = Offset(size.width / 2f, size.height / 2f)
                        drawCircle(
                            brush = Brush.radialGradient(
                                colors = listOf(
                                    Color.White.copy(alpha = 0.35f),
                                    Color.Transparent,
                                ),
                                center = c,
                                radius = size.minDimension * 0.45f,
                            ),
                            radius = size.minDimension * 0.48f,
                            center = c,
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier.size(40.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (gift.thumbnailUrl.isNotBlank()) {
                        AsyncImage(
                            model = gift.thumbnailUrl,
                            contentDescription = null,
                            modifier = Modifier
                                .fillMaxSize()
                                .clip(CircleShape),
                        )
                    } else {
                        Icon(
                            imageVector = gift.fallbackImageVector(),
                            contentDescription = gift.name,
                            tint = iconTint,
                            modifier = Modifier.size(36.dp),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = gift.name,
                color = Color.White,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f),
            )
            if (gift.isCrmGift) {
                Spacer(Modifier.width(2.dp))
                Icon(
                    Icons.Default.Star,
                    contentDescription = "Premium",
                    tint = Color(0xFFFFD700),
                    modifier = Modifier.size(10.dp),
                )
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Text(
                text = gift.price.toString(),
                color = Color(0xFFFFD700),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.width(2.dp))
            Icon(
                Icons.Default.Diamond,
                contentDescription = null,
                tint = Color(0xFFFFD700),
                modifier = Modifier.size(10.dp),
            )
        }
    }
}
