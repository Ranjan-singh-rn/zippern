package com.zipper.datingapp.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.runtime.mutableStateListOf
import kotlinx.coroutines.delay
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.rememberLottieComposition
import com.zipper.datingapp.R
import com.zipper.datingapp.data.AudioPartyHostSeatAction
import com.zipper.datingapp.data.AudioPartySeat
import com.zipper.datingapp.data.AudioPartyStreamState
import com.zipper.datingapp.data.guestSeatIndexRange
import com.zipper.datingapp.data.normalizeAudioPartyStageSeatCount
import com.zipper.datingapp.ui.components.VerifiedBadge
import com.zipper.datingapp.ui.theme.ItzoUiTokens

private val GoldSeat = Color(0xFFD4AF37)

/**
 * Itzo-inspired audio party: pastel room, host + throne strip, guest rings (`streams/{host}`).
 */
@Composable
fun AudioPartyStageLayout(
    seatCount: Int,
    stream: AudioPartyStreamState,
    hostUserId: String,
    myUserId: String,
    isHost: Boolean,
    title: String,
    subtitle: String,
    hostDisplayName: String,
    hostPhotoUrl: String,
    hostProfileNumber: String,
    hostBeans: Int,
    hostHasBlueTick: Boolean = false,
    showSeatCountControls: Boolean,
    onSeatCountSelected: (Int) -> Unit,
    onClaimSeat: (Int) -> Unit = {},
    onLeaveSeat: (Int) -> Unit = {},
    onHostSeatAction: (AudioPartyHostSeatAction) -> Unit = {},
    onToggleMySeatMic: (Boolean) -> Unit = {},
    onMergeNowPlaying: (String, String) -> Unit = { _, _ -> },
    onSendStageEmoji: (String) -> Unit = {},
    /** When false, quick emoji row is omitted (Itzo room uses docked icon bar). */
    showTopQuickEmojis: Boolean = false,
    /** Host only: called when the host taps "End Party". No-op for audience. */
    onEndParty: () -> Unit = {},
    /** Audience only: called when the guest taps the ✕ leave button. No-op for host. */
    onLeave: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val capacity = normalizeAudioPartyStageSeatCount(
        when {
            stream.streamActive && stream.seatCount > 0 -> stream.seatCount
            else -> seatCount
        }
    )
    val guestRange = remember(capacity, stream.seatCount, seatCount) {
        AudioPartyStreamState(seatCount = capacity).guestSeatIndexRange()
    }
    // ── Viewer join messages ──────────────────────────────────────────────────
    val joinMessages = remember { mutableStateListOf<String>() }
    // Track previous seat snapshot to detect new occupants
    val prevSeatSnapshot = remember { mutableMapOf<Int, String>() }

    LaunchedEffect(stream.seats) {
        for ((idx, seat) in stream.seats) {
            val prevUserId = prevSeatSnapshot[idx].orEmpty()
            val newUserId = seat.userId.trim()
            if (newUserId.isNotBlank() && newUserId != prevUserId) {
                val name = seat.displayName.ifBlank { "Someone" }
                joinMessages.add("👋 $name joined the party")
            }
            prevSeatSnapshot[idx] = newUserId
        }
    }
    // Auto-expire messages after 6 seconds
    LaunchedEffect(joinMessages.size) {
        if (joinMessages.isNotEmpty()) {
            delay(6_000L)
            if (joinMessages.isNotEmpty()) joinMessages.removeAt(0)
        }
    }

    var hostMenuSeat by remember { mutableIntStateOf(0) }
    var showHostMenu by remember { mutableStateOf(false) }
    var hostMenuCustomPrice by remember { mutableStateOf("") }
    LaunchedEffect(showHostMenu) {
        if (showHostMenu) hostMenuCustomPrice = ""
    }
    var showNowPlayingDialog by remember { mutableStateOf(false) }
    var npTitle by remember { mutableStateOf("") }
    var npArtist by remember { mutableStateOf("") }

    if (showNowPlayingDialog && isHost) {
        AlertDialog(
            onDismissRequest = { showNowPlayingDialog = false },
            title = { Text(stringResource(R.string.live_audio_party_now_playing_dialog_title)) },
            text = {
                Column {
                    OutlinedTextField(
                        value = npTitle,
                        onValueChange = { npTitle = it },
                        label = { Text(stringResource(R.string.live_audio_party_np_title)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = npArtist,
                        onValueChange = { npArtist = it },
                        label = { Text(stringResource(R.string.live_audio_party_np_artist)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onMergeNowPlaying(npTitle.trim(), npArtist.trim())
                        showNowPlayingDialog = false
                    }
                ) {
                    Text(stringResource(R.string.live_audio_party_save))
                }
            },
            dismissButton = {
                TextButton(onClick = { showNowPlayingDialog = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        )
    }

    if (showHostMenu && isHost) {
        val st = stream.seats[hostMenuSeat] ?: AudioPartySeat(hostMenuSeat)
        AlertDialog(
            onDismissRequest = { showHostMenu = false },
            title = {
                Text(
                    stringResource(R.string.live_audio_party_host_menu_title, hostMenuSeat)
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(
                        onClick = {
                            onHostSeatAction(AudioPartyHostSeatAction.SetLocked(hostMenuSeat, !st.locked))
                            showHostMenu = false
                        }
                    ) {
                        Text(
                            if (st.locked) stringResource(R.string.live_audio_party_unlock_seat)
                            else stringResource(R.string.live_audio_party_lock_seat)
                        )
                    }
                    TextButton(
                        onClick = {
                            onHostSeatAction(AudioPartyHostSeatAction.SetMuted(hostMenuSeat, !st.mutedByHost))
                            showHostMenu = false
                        }
                    ) {
                        Text(
                            if (st.mutedByHost) stringResource(R.string.live_audio_party_unmute_seat)
                            else stringResource(R.string.live_audio_party_mute_seat)
                        )
                    }
                    TextButton(
                        onClick = {
                            onHostSeatAction(AudioPartyHostSeatAction.Kick(hostMenuSeat))
                            showHostMenu = false
                        }
                    ) {
                        Text(stringResource(R.string.live_audio_party_kick_seat))
                    }
                    if (st.userId.isBlank()) {
                        Text(
                            text = stringResource(R.string.live_audio_party_cohost_hint_empty_seat),
                            color = ItzoUiTokens.AudioPartyOnRoomMuted,
                            fontSize = 13.sp,
                            lineHeight = 18.sp,
                            modifier = Modifier.padding(vertical = 6.dp),
                        )
                    }
                    if (st.userId.isNotBlank() && st.userId != hostUserId) {
                        if (stream.coHostUserId.isNotBlank() && stream.coHostUserId == st.userId) {
                            TextButton(
                                onClick = {
                                    onHostSeatAction(AudioPartyHostSeatAction.ClearCoHost)
                                    showHostMenu = false
                                }
                            ) {
                                Text(stringResource(R.string.live_audio_party_remove_cohost))
                            }
                        } else {
                            TextButton(
                                onClick = {
                                    onHostSeatAction(AudioPartyHostSeatAction.SetCoHostFromSeat(hostMenuSeat))
                                    showHostMenu = false
                                }
                            ) {
                                Text(stringResource(R.string.live_audio_party_make_cohost))
                            }
                            TextButton(
                                onClick = {
                                    onHostSeatAction(
                                        AudioPartyHostSeatAction.PromoteSeatGuestToHost(hostMenuSeat),
                                    )
                                    showHostMenu = false
                                }
                            ) {
                                Text(stringResource(R.string.live_audio_party_make_new_host))
                            }
                        }
                    }
                    Text(stringResource(R.string.live_audio_party_price_presets))
                    listOf(listOf(0, 6, 10), listOf(50, 100)).forEach { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly,
                        ) {
                            row.forEach { price ->
                                TextButton(
                                    onClick = {
                                        onHostSeatAction(
                                            AudioPartyHostSeatAction.SetPrice(hostMenuSeat, price),
                                        )
                                        showHostMenu = false
                                    },
                                ) {
                                    Text("$price")
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        stringResource(R.string.live_audio_party_price_custom),
                        color = ItzoUiTokens.AudioPartyOnRoomMuted,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OutlinedTextField(
                            value = hostMenuCustomPrice,
                            onValueChange = { v ->
                                hostMenuCustomPrice = v.filter { it.isDigit() }.take(6)
                            },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        TextButton(
                            onClick = {
                                val parsed = hostMenuCustomPrice.toIntOrNull() ?: -1
                                if (parsed < 0) return@TextButton
                                val clamped = parsed.coerceIn(0, 500_000)
                                onHostSeatAction(
                                    AudioPartyHostSeatAction.SetPrice(hostMenuSeat, clamped),
                                )
                                showHostMenu = false
                            },
                        ) {
                            Text(stringResource(R.string.live_audio_party_apply_custom_price))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showHostMenu = false }) {
                    Text(stringResource(android.R.string.ok))
                }
            }
        )
    }

    val nowLine = remember(stream.nowPlayingTitle, stream.nowPlayingArtist) {
        when {
            stream.nowPlayingTitle.isNotBlank() && stream.nowPlayingArtist.isNotBlank() ->
                "${stream.nowPlayingTitle} — ${stream.nowPlayingArtist}"
            stream.nowPlayingTitle.isNotBlank() -> stream.nowPlayingTitle
            stream.nowPlayingArtist.isNotBlank() -> stream.nowPlayingArtist
            else -> ""
        }
    }
    val emojiFresh = stream.stageEmoji.isNotBlank() &&
        stream.stageEmojiAtMs > 0L &&
        System.currentTimeMillis() - stream.stageEmojiAtMs < 60_000L

    val guestIndices = guestRange.toList()
    val throneSeatIndex = guestIndices.firstOrNull()
    val restGuests = guestIndices.drop(1)
    val throneSeatState = throneSeatIndex?.let { stream.seats[it] ?: AudioPartySeat(it) }

    val chipColors = FilterChipDefaults.filterChipColors(
        selectedContainerColor = ItzoUiTokens.PkBarLeft.copy(alpha = 0.92f),
        containerColor = Color.White.copy(alpha = 0.88f),
        labelColor = ItzoUiTokens.AudioPartyChipLabelOnLight,
        selectedLabelColor = Color.White,
    )

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // ✕ Leave button — shown for audience members only (host has "End Party" below)
        if (!isHost) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
            ) {
                IconButton(
                    onClick = onLeave,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(38.dp)
                        .background(Color.Black.copy(alpha = 0.38f), CircleShape)
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Leave Party",
                        tint = Color.White,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }
        }

        if (title.isNotBlank()) {
            Text(
                text = title,
                color = ItzoUiTokens.AudioPartyOnBleedText,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        if (subtitle.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = subtitle,
                color = ItzoUiTokens.FrameTeal.copy(alpha = 0.92f),
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        if (nowLine.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = nowLine,
                color = ItzoUiTokens.AudioPartyOnBleedMuted,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (emojiFresh) {
            Spacer(Modifier.height(4.dp))
            Text(text = stream.stageEmoji, fontSize = 28.sp)
        }

        if (isHost) {
            Spacer(Modifier.height(6.dp))
            TextButton(onClick = {
                npTitle = stream.nowPlayingTitle
                npArtist = stream.nowPlayingArtist
                showNowPlayingDialog = true
            }) {
                Text(
                    stringResource(R.string.live_audio_party_edit_now_playing),
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        Spacer(Modifier.height(6.dp))
        if (showTopQuickEmojis) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf("🔥", "❤️", "😂", "👏").forEach { em ->
                    TextButton(
                        onClick = { onSendStageEmoji(em) },
                        modifier = Modifier.size(40.dp),
                    ) {
                        Text(em, fontSize = 20.sp)
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        } else {
            Spacer(Modifier.height(6.dp))
        }
        if (throneSeatIndex != null && throneSeatState != null) {
            AudioPartyHostStrip(
                streamActive = stream.streamActive,
                hostDisplayName = hostDisplayName.ifBlank { stringResource(R.string.live_pk_battler_host_fallback) },
                hostPhotoUrl = hostPhotoUrl,
                hostProfileNumber = hostProfileNumber.trim(),
                hostBeans = hostBeans,
                hostHasBlueTick = hostHasBlueTick,
                coHostUserId = stream.coHostUserId,
                throneSeat = throneSeatState,
                myUserId = myUserId,
                onThroneTap = {
                    if (isHost) {
                        hostMenuSeat = throneSeatIndex
                        showHostMenu = true
                    } else {
                        when {
                            throneSeatState.locked -> { }
                            throneSeatState.userId.isBlank() -> onClaimSeat(throneSeatIndex)
                            throneSeatState.userId == myUserId -> onLeaveSeat(throneSeatIndex)
                            else -> { }
                        }
                    }
                },
                onToggleThroneMic = { onToggleMySeatMic(!throneSeatState.publishingAudio) },
            )
        }

        if (restGuests.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            val cols = 5
            val rows = (restGuests.size + cols - 1) / cols
            for (r in 0 until rows) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    for (c in 0 until cols) {
                        val idxInRow = r * cols + c
                        if (idxInRow < restGuests.size) {
                            val idx = restGuests[idxInRow]
                            val st = stream.seats[idx] ?: AudioPartySeat(idx)
                            AudioPartyGuestSeatCell(
                                seat = st,
                                myUserId = myUserId,
                                isCoHostSeat = stream.coHostUserId.isNotBlank() && st.userId == stream.coHostUserId,
                                goldStyle = true,
                                throneSlot = false,
                                lightRoom = false,
                                showSpeakingWave = stream.streamActive &&
                                    st.userId.isNotBlank() &&
                                    !st.locked &&
                                    st.publishingAudio &&
                                    !st.mutedByHost,
                                onTap = {
                                    if (isHost) {
                                        hostMenuSeat = idx
                                        showHostMenu = true
                                    } else {
                                        when {
                                            st.locked -> { }
                                            st.userId.isBlank() -> onClaimSeat(idx)
                                            st.userId == myUserId -> onLeaveSeat(idx)
                                            else -> { }
                                        }
                                    }
                                },
                                onToggleMySeatMic = { onToggleMySeatMic(!st.publishingAudio) },
                            )
                        } else {
                            Spacer(Modifier.size(46.dp))
                        }
                    }
                }
                if (r < rows - 1) Spacer(Modifier.height(10.dp))
            }
        }

        if (showSeatCountControls) {
            Spacer(Modifier.height(16.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    stringResource(R.string.live_audio_party_seat_layout_label),
                    color = ItzoUiTokens.AudioPartyOnBleedMuted,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
                FilterChip(
                    selected = capacity == 6,
                    onClick = { onSeatCountSelected(6) },
                    label = { Text("6") },
                    colors = chipColors,
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = capacity == 6,
                        borderColor = ItzoUiTokens.AudioPartyOnRoomMuted.copy(alpha = 0.35f),
                        selectedBorderColor = Color.Transparent,
                    ),
                )
                FilterChip(
                    selected = capacity == 10,
                    onClick = { onSeatCountSelected(10) },
                    label = { Text("10") },
                    colors = chipColors,
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = capacity == 10,
                        borderColor = ItzoUiTokens.AudioPartyOnRoomMuted.copy(alpha = 0.35f),
                        selectedBorderColor = Color.Transparent,
                    ),
                )
                FilterChip(
                    selected = capacity == 14,
                    onClick = { onSeatCountSelected(14) },
                    label = { Text("14") },
                    colors = chipColors,
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = capacity == 14,
                        borderColor = ItzoUiTokens.AudioPartyOnRoomMuted.copy(alpha = 0.35f),
                        selectedBorderColor = Color.Transparent,
                    ),
                )
                FilterChip(
                    selected = capacity == 17,
                    onClick = { onSeatCountSelected(17) },
                    label = { Text("17") },
                    colors = chipColors,
                    border = FilterChipDefaults.filterChipBorder(
                        enabled = true,
                        selected = capacity == 17,
                        borderColor = ItzoUiTokens.AudioPartyOnRoomMuted.copy(alpha = 0.35f),
                        selectedBorderColor = Color.Transparent,
                    ),
                )
            }
        }

        // ── End Party button (host only) ──────────────────────────────────────
        if (isHost) {
            var showEndConfirm by remember { mutableStateOf(false) }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = { showEndConfirm = true },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53935)),
                shape = RoundedCornerShape(14.dp),
            ) {
                Icon(
                    Icons.Default.StopCircle,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("End Party", fontWeight = FontWeight.SemiBold)
            }
            if (showEndConfirm) {
                AlertDialog(
                    onDismissRequest = { showEndConfirm = false },
                    title = { Text("End Party?") },
                    text = { Text("This will close the room for all participants.") },
                    confirmButton = {
                        Button(
                            onClick = { showEndConfirm = false; onEndParty() },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53935)),
                        ) { Text("End Party") }
                    },
                    dismissButton = {
                        TextButton(onClick = { showEndConfirm = false }) { Text("Cancel") }
                    },
                )
            }
        }

        // ── Viewer join message feed ──────────────────────────────────────────
        AnimatedVisibility(
            visible = joinMessages.isNotEmpty(),
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 100.dp)
                    .padding(vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                joinMessages.forEach { msg ->
                    Box(
                        modifier = Modifier
                            .background(
                                Color.Black.copy(alpha = 0.45f),
                                RoundedCornerShape(20.dp),
                            )
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    ) {
                        Text(
                            text = msg,
                            color = Color.White,
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.live_stream_compliance_warning),
            color = Color.White.copy(alpha = 0.86f),
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
            lineHeight = 15.sp,
        )
    }
}

@Composable
private fun AudioPartyHostStrip(
    streamActive: Boolean,
    hostDisplayName: String,
    hostPhotoUrl: String,
    hostProfileNumber: String,
    hostBeans: Int,
    hostHasBlueTick: Boolean,
    coHostUserId: String,
    throneSeat: AudioPartySeat,
    myUserId: String,
    onThroneTap: () -> Unit,
    onToggleThroneMic: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(Color(0xE818141F))
                .border(1.dp, GoldSeat.copy(alpha = 0.38f), RoundedCornerShape(24.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(40.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (streamActive) {
                    val wave by rememberLottieComposition(
                        LottieCompositionSpec.Asset("audio_waves.json"),
                    )
                    LottieAnimation(
                        composition = wave,
                        iterations = LottieConstants.IterateForever,
                        modifier = Modifier.size(34.dp),
                    )
                }
                Surface(
                    modifier = Modifier.size(30.dp),
                    shape = CircleShape,
                    color = Color(0xFFD7CCC8),
                ) {
                    AsyncImage(
                        model = hostPhotoUrl.takeIf { it.isNotBlank() },
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = hostDisplayName,
                        color = Color.White,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (hostHasBlueTick) {
                        Spacer(Modifier.width(4.dp))
                        VerifiedBadge(size = 12.dp)
                    }
                }
                if (hostProfileNumber.isNotBlank()) {
                    Text(
                        text = hostProfileNumber,
                        color = Color.White.copy(alpha = 0.72f),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            AudioPartyGuestSeatCell(
                seat = throneSeat,
                myUserId = myUserId,
                isCoHostSeat = coHostUserId.isNotBlank() && throneSeat.userId == coHostUserId,
                goldStyle = false,
                throneSlot = true,
                lightRoom = false,
                showSpeakingWave = streamActive &&
                    throneSeat.userId.isNotBlank() &&
                    !throneSeat.locked &&
                    throneSeat.publishingAudio &&
                    !throneSeat.mutedByHost,
                onTap = onThroneTap,
                onToggleMySeatMic = onToggleThroneMic,
            )
        }
        if (hostBeans >= 0) {
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.padding(start = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    color = ItzoUiTokens.AudioPartyBeanChipBg,
                    shape = RoundedCornerShape(999.dp),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "🫘",
                            fontSize = 13.sp,
                            modifier = Modifier.padding(end = 4.dp)
                        )
                        Text(
                            text = "$hostBeans",
                            color = ItzoUiTokens.AudioPartyBeanChipContent,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AudioPartyGuestSeatCell(
    seat: AudioPartySeat,
    myUserId: String,
    isCoHostSeat: Boolean,
    goldStyle: Boolean,
    throneSlot: Boolean,
    lightRoom: Boolean,
    showSpeakingWave: Boolean = false,
    onTap: () -> Unit,
    onToggleMySeatMic: () -> Unit,
) {
    val w: Dp
    val h: Dp
    val corner = when {
        throneSlot -> RoundedCornerShape(11.dp)
        goldStyle -> RoundedCornerShape(10.dp)
        else -> CircleShape
    }
    when {
        throneSlot -> {
            w = 46.dp
            h = 42.dp
        }
        goldStyle -> {
            w = 58.dp
            h = 58.dp
        }
        else -> {
            w = 44.dp
            h = 44.dp
        }
    }
    val occupied = seat.userId.isNotBlank()
    val borderCol = when {
        seat.locked -> GoldSeat
        occupied -> ItzoUiTokens.AppAccent.copy(alpha = 0.88f)
        else -> GoldSeat.copy(alpha = if (lightRoom) 0.65f else 0.55f)
    }
    val bg =
        if (lightRoom) Color.White.copy(alpha = 0.55f) else Color.Black.copy(alpha = 0.52f)
    val fg = if (lightRoom) ItzoUiTokens.AudioPartyOnRoomText else Color.White
    val mutedFg = if (lightRoom) ItzoUiTokens.AudioPartyOnRoomMuted else Color.White.copy(alpha = 0.72f)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(width = w, height = h)
            .border(
                width = if (throneSlot || goldStyle) 2.dp else 1.5.dp,
                color = borderCol,
                shape = corner,
            )
            .background(bg, corner)
            .clickable { onTap() }
    ) {
        if (showSpeakingWave) {
            val wave by rememberLottieComposition(LottieCompositionSpec.Asset("audio_waves.json"))
            val waveSize = when {
                throneSlot -> 40.dp
                goldStyle -> 52.dp
                else -> 40.dp
            }
            LottieAnimation(
                composition = wave,
                iterations = LottieConstants.IterateForever,
                modifier = Modifier.size(waveSize),
            )
        }
        if (isCoHostSeat && occupied) {
            Text(
                text = "★",
                color = GoldSeat,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(2.dp)
            )
        }
        when {
            seat.locked && !occupied && (goldStyle || throneSlot) -> {
                Image(
                    painter = painterResource(R.drawable.audio_party_seat_throne_idle),
                    contentDescription = null,
                    modifier =
                        Modifier
                            .align(Alignment.Center)
                            .size(if (throneSlot) 22.dp else 30.dp),
                    contentScale = ContentScale.Fit,
                )
                Icon(
                    imageVector = Icons.Default.Lock,
                    contentDescription = null,
                    tint = GoldSeat,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .size(if (throneSlot) 16.dp else 17.dp),
                )
            }
            seat.locked -> {
                Icon(
                    imageVector = Icons.Default.Lock,
                    contentDescription = null,
                    tint = GoldSeat,
                    modifier = Modifier.size(20.dp),
                )
            }
            occupied && seat.photoUrl.isNotBlank() -> AsyncImage(
                model = seat.photoUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .matchParentSize()
                    .clip(corner),
            )
            occupied -> {
                Text(
                    text = seat.displayName.take(1).uppercase(),
                    color = fg,
                    fontSize = if (throneSlot || goldStyle) 16.sp else 14.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            throneSlot && !seat.locked -> {
                Image(
                    painter = painterResource(R.drawable.audio_party_seat_throne_idle),
                    contentDescription = null,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .size(22.dp),
                    contentScale = ContentScale.Fit,
                )
            }
            goldStyle && !seat.locked -> {
                if (seat.priceCoins > 0) {
                    Text(
                        text = "${seat.priceCoins}",
                        color = GoldSeat,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                    )
                } else {
                    Image(
                        painter = painterResource(R.drawable.audio_party_seat_throne_idle),
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        contentScale = ContentScale.Fit,
                    )
                }
            }
            else -> {
                Text(
                    text = if (seat.priceCoins > 0) "${seat.priceCoins}" else "+",
                    color = mutedFg,
                    fontSize = if (goldStyle) 14.sp else 12.sp,
                )
            }
        }
        if (occupied && !seat.locked) {
            val micIcon = when {
                seat.mutedByHost -> Icons.Default.MicOff
                seat.publishingAudio -> Icons.Default.Mic
                else -> Icons.Default.MicOff
            }
            val micTint = if (lightRoom) ItzoUiTokens.AudioPartyOnRoomText else Color.White
            if (seat.userId == myUserId && !seat.mutedByHost) {
                IconButton(
                    onClick = onToggleMySeatMic,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .size(28.dp)
                ) {
                    Icon(
                        micIcon,
                        contentDescription = null,
                        tint = micTint,
                        modifier = Modifier.size(16.dp)
                    )
                }
            } else {
                Icon(
                    micIcon,
                    contentDescription = null,
                    tint = micTint,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(3.dp)
                        .size(14.dp)
                )
            }
        }
    }
}
