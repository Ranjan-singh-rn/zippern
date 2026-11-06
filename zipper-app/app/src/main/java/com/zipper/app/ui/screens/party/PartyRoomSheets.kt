package com.zipper.app.ui.screens.party

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.data.model.PartySeatInvite
import com.zipper.app.data.repository.PartyListener
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay

/*
 * Everything the party room puts OVER itself: sheets, dialogs and the two
 * overlays that animate.
 *
 * Split out of PartyRoomScreen because the room grew a settings sheet, a member
 * list, an admin list, a seat-request queue, an invitation popup and a
 * permission rationale in one rebuild, and all of it in one file made the part
 * that matters — the seats and the chat — impossible to find. Nothing here knows
 * anything the screen does not: every composable takes the same
 * [PartyRoomUiState] and the same [PartyRoomViewModel] the screen holds, so
 * there is no second source of truth to keep in step.
 *
 * `internal` rather than `private` only because the screen is a different file in
 * the same module. None of this is part of any public surface.
 */

// ── Shared sheet chrome ──────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PartySheetFrame(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = ZipperTheme.colors
    // Always fully expanded. A half-open sheet hides the row somebody came for —
    // the settings sheet is six settings tall and the member list is however
    // many people are in the room.
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheet,
        containerColor = c.bgElevated,
        dragHandle = null,
        shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.md)) {
            Box(
                Modifier.padding(top = 6.dp).size(36.dp, 4.dp)
                    .background(c.borderDefault, CircleShape)
                    .align(Alignment.CenterHorizontally)
            )
            Text(
                title, style = ZipperTheme.type.headingS, color = c.textPrimary,
                modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.md),
            )
            HairlineDivider()
            content()
        }
    }
}

@Composable
internal fun PartySheetRow(
    icon: ImageVector,
    label: String,
    tint: Color,
    enabled: Boolean = true,
    onClick: () -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (enabled) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.xl, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(
            icon, null,
            tint = if (enabled) tint else ZipperTheme.colors.textMuted,
            modifier = Modifier.size(Size.Icon.lg),
        )
        Text(
            label,
            style = ZipperTheme.type.bodyL,
            color = if (enabled) tint else ZipperTheme.colors.textMuted,
            maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SettingLabel(text: String) {
    Text(
        text, style = ZipperTheme.type.labelS, color = ZipperTheme.colors.textSecondary,
    )
}

/**
 * One of a small fixed set of choices — seat counts, seat modes, visibility.
 *
 * A pill rather than a dropdown because every one of these has two or three
 * options and all of them fit on a line; a picker that hides two options behind
 * a tap is a picker nobody discovers.
 */
@Composable
private fun ChoicePill(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val c = ZipperTheme.colors
    Box(
        Modifier.height(34.dp)
            .then(
                if (selected) Modifier.background(c.tintBrandMedium, CircleShape).border(1.dp, c.brandPrimary, CircleShape)
                else Modifier.background(c.glassLow, CircleShape).border(1.dp, c.borderSubtle, CircleShape)
            )
            .then(if (enabled) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.lg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, style = ZipperTheme.type.labelS,
            color = when {
                selected -> c.textPrimary
                enabled -> c.textSecondary
                else -> c.textMuted
            },
            maxLines = 1,
        )
    }
}

@Composable
private fun SettingField(
    value: String,
    placeholder: String,
    maxChars: Int,
    singleLine: Boolean,
    onValue: (String) -> Unit,
) {
    val c = ZipperTheme.colors
    val shape = RoundedCornerShape(Radius.md)
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(c.bgRaised, shape)
            .border(1.dp, c.borderSubtle, shape)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        BasicTextField(
            value = value,
            // Hard-capped rather than truncated on save. Letting somebody type
            // three hundred characters and silently keeping 250 is a worse
            // surprise than the field simply stopping.
            onValueChange = { if (it.length <= maxChars) onValue(it) },
            singleLine = singleLine,
            maxLines = if (singleLine) 1 else 4,
            textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.brandPrimary),
            keyboardOptions = KeyboardOptions(imeAction = if (singleLine) ImeAction.Done else ImeAction.Default),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(placeholder, style = ZipperTheme.type.bodyM, color = c.textMuted)
                }
                inner()
            },
        )
        Text("${value.length}/$maxChars", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

/**
 * Four digits, drawn as boxes, typed into a field laid over the boxes — the shape of the OTP boxes
 * (`OtpCodeBoxes`).
 *
 * A3 (3 Nov 2026): the field used to be ZERO-SIZE, beside the boxes. A single-line text field scrolls its own
 * text, so it is itself a scrolling container, and one measured 0×0 cannot answer the "bring me into view" a
 * focused field sends up to its parents. Inside the create-room form and the room settings sheet — both scroll —
 * tapping the boxes crashed the app with "Expected BringIntoViewRequester to not be used before parents are
 * placed" (emulator drop box, 3 Nov 2026 13:32:15 and 13:32:51 IST). Laid over the boxes, the field has their
 * size; its text and cursor are transparent, so the boxes are still what is seen, and a tap anywhere on them
 * lands in the field.
 */
@Composable
internal fun PartyDigitsField(
    code: String,
    error: Boolean,
    onCode: (String) -> Unit,
    /**
     * Grab focus and raise the keyboard on first composition.
     *
     * True on the password gate, where entering four digits is the only thing on
     * screen to do. False inside the settings sheet: the keyboard covering a sheet
     * the owner is still reading is not help.
     */
    autoFocus: Boolean = false,
    onDone: () -> Unit,
) {
    val c = ZipperTheme.colors
    val focus = remember { FocusRequester() }
    // After the first layout, never from the composition that made the field — see requestFocusAfterLayout.
    LaunchedEffect(autoFocus) { if (autoFocus) focus.requestFocusAfterLayout() }
    Box {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            repeat(4) { i ->
                val ch = code.getOrNull(i)
                val shape = RoundedCornerShape(Radius.md)
                Box(
                    Modifier.size(width = 48.dp, height = 56.dp)
                        .background(c.bgRaised, shape)
                        .border(
                            1.dp,
                            when {
                                // The danger border belongs to the wrong answer, not
                                // to the next attempt: it clears as soon as a digit
                                // is typed, or the field reads as broken.
                                error && code.isEmpty() -> c.statusDanger
                                i == code.length -> c.brandPrimary
                                ch != null -> c.borderStrong
                                else -> c.borderSubtle
                            },
                            shape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (ch != null) "•" else "",
                        style = ZipperTheme.type.displayM, color = c.textPrimary,
                    )
                }
            }
        }
        // Over the boxes, at their size: the boxes are what is seen, the IME talks to this.
        BasicTextField(
            value = code,
            onValueChange = { v -> onCode(v.filter { ch -> ch.isDigit() }.take(4)) },
            singleLine = true,
            textStyle = ZipperTheme.type.bodyL.copy(color = Color.Transparent),
            cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier.matchParentSize().focusRequester(focus),
        )
    }
}

// ── The room menu ────────────────────────────────────────────────────────────

/**
 * The overflow menu. Everything that is not a seat and not a message.
 *
 * Owner-only rows are absent rather than disabled for the reason the first
 * version of this file recorded: `endPartyRoom` refuses anybody else, so
 * offering it to a guest is offering an error.
 */
@Composable
internal fun PartyRoomMenuSheet(
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    onMembers: () -> Unit,
    onRequests: () -> Unit,
    onSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    var confirmEnd by remember { mutableStateOf(false) }
    var showAccessLog by remember { mutableStateOf(false) }
    var showMusic by remember { mutableStateOf(false) }
    var showShare by remember { mutableStateOf(false) }
    if (showAccessLog) {
        PartyAccessLogSheet(viewModel, onDismiss = { showAccessLog = false })
        return
    }
    if (showShare) {
        // Owner (5 Nov 2026): invite friends from Messages — an invite card in the chat that opens this room.
        com.zipper.app.ui.screens.live.LiveShareSheet(
            roomId = state.room?.roomId.orEmpty(), hostName = state.room?.hostName.orEmpty(),
            onDismiss = { showShare = false }, kind = "party",
        )
        return
    }
    if (showMusic) {
        // O14 (5 Nov 2026): the music player — the songs on this phone (or the catalogue) — replaces the catalogue-only sheet.
        PartyMusicPlayerSheet(state, viewModel, onDismiss = { showMusic = false })
        return
    }

    PartySheetFrame("Room · ${compactCount(state.memberList.size.toLong())} here", onDismiss) {
        if (state.amSeated) {
            PartySheetRow(Icons.Default.PersonOff, "Leave my seat", c.textPrimary) {
                viewModel.leaveMySeat(); onDismiss()
            }
        }
        if (state.myRequestedSeat > 0) {
            PartySheetRow(
                Icons.Default.Close,
                "Cancel my request for seat ${state.myRequestedSeat}",
                c.textPrimary,
            ) { viewModel.cancelMySeatRequest(); onDismiss() }
        }
        PartySheetRow(Icons.Outlined.People, "People in the room", c.textPrimary) {
            onDismiss(); onMembers()
        }
        PartySheetRow(Icons.Outlined.People, "Invite friends (Messages)", c.textBrand) { showShare = true }
        // B7: room music — the owner and admins pick from Zipper's licensed catalogue.
        if (state.canModerate) {
            PartySheetRow(Icons.Outlined.Settings, state.room?.music?.let { "Music · ${it.title}" } ?: "Music", c.textPrimary) {
                showMusic = true
            }
        }
        if (state.canModerate && state.seatRequests.isNotEmpty()) {
            PartySheetRow(
                Icons.Outlined.Groups,
                "Seat requests · ${state.seatRequests.size}",
                c.textBrand,
            ) { onDismiss(); onRequests() }
        }
        if (state.isOwner) {
            PartySheetRow(Icons.Outlined.Settings, "Room settings", c.textPrimary) {
                onDismiss(); onSettings()
            }
            // B7: who came into a private room, who was turned away or locked out, and every official entry.
            if (state.room?.isPrivate == true) {
                PartySheetRow(Icons.Outlined.People, "Access log", c.textPrimary) { showAccessLog = true }
            }
            PartySheetRow(Icons.Default.Block, "End this room", c.statusDanger) { confirmEnd = true }
        }
    }

    // Outside the sheet's content so the dialog owns the focus, and because
    // ending a room with fifteen people in it deserves a second tap.
    if (confirmEnd) {
        AlertDialog(
            onDismissRequest = { confirmEnd = false },
            containerColor = c.bgElevated,
            title = { Text("End this room?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "Everyone is disconnected and the room disappears from the list. " +
                        "You cannot reopen this one.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton({ confirmEnd = false; viewModel.endRoom(); onDismiss() }) {
                    Text("End room", color = c.statusDanger)
                }
            },
            dismissButton = {
                TextButton({ confirmEnd = false }) { Text("Keep it open", color = c.textSecondary) }
            },
        )
    }
}

// ── One seat ─────────────────────────────────────────────────────────────────

/**
 * What can be done to the person on this seat, or to the empty seat itself.
 *
 * The mute row is decided by [PartyRoomUiState.canMute] and
 * [PartyRoomUiState.canUnmute] rather than by a rule re-derived here — those two
 * are the client's copy of what `setPartySeatMute` enforces, and a third copy
 * would be a third thing to keep in step. When neither is true and the seat IS
 * muted, the row stays visible but disabled and says who muted it: the answer to
 * "why can't I unmute them" is more useful than the row's absence.
 */
@Composable
internal fun PartySeatMenuSheet(
    index: Int,
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    onSit: (Int) -> Unit,
    onOpenProfile: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val room = state.room ?: return
    val seat = state.seatByIndex[index]
    val locked = room.lockedSeats.contains(index)
    var confirmRemove by remember { mutableStateOf(false) }

    PartySheetFrame(seat?.name?.ifBlank { "Seat $index" } ?: "Seat $index", onDismiss) {
        if (seat == null) {
            if (!locked) {
                PartySheetRow(Icons.Default.Add, "Sit here", c.textPrimary) { onDismiss(); onSit(index) }
            }
            if (state.canModerate) {
                PartySheetRow(
                    if (locked) Icons.Default.LockOpen else Icons.Default.Lock,
                    if (locked) "Unlock this seat" else "Lock this seat",
                    c.textPrimary,
                ) { viewModel.toggleSeatLock(index); onDismiss() }
            }
            return@PartySheetFrame
        }

        if (seat.uid == state.myUid) {
            PartySheetRow(
                if (seat.isSilent) Icons.Default.Mic else Icons.Default.MicOff,
                if (seat.isSilent) "Turn my microphone on" else "Turn my microphone off",
                c.textPrimary,
            ) { viewModel.toggleMyMic(); onDismiss() }
            PartySheetRow(Icons.Default.PersonOff, "Leave my seat", c.textPrimary) {
                viewModel.leaveMySeat(); onDismiss()
            }
            PartySheetRow(Icons.Outlined.Person, "View my profile", c.textPrimary) {
                onDismiss(); onOpenProfile(seat.uid)
            }
            return@PartySheetFrame
        }

        when {
            !seat.isMuted && state.canMute(seat) ->
                PartySheetRow(Icons.Default.MicOff, "Mute this seat", c.textPrimary) {
                    viewModel.toggleSeatMute(seat); onDismiss()
                }
            seat.isMuted && state.canUnmute(seat) ->
                PartySheetRow(Icons.Default.Mic, "Unmute this seat", c.textPrimary) {
                    viewModel.toggleSeatMute(seat); onDismiss()
                }
            seat.isMuted ->
                PartySheetRow(
                    Icons.Default.MicOff,
                    if (seat.mutedByRole == "owner") "Muted by the host — only they can unmute"
                    else "Muted by another admin",
                    c.textPrimary,
                    enabled = false,
                )
            // Not muted and I may not mute them: an admin cannot moderate the
            // owner or another admin, so there is nothing to offer.
            else -> Unit
        }

        if (state.canModerate) {
            PartySheetRow(Icons.Default.PersonOff, "Take them off this seat", c.textPrimary) {
                viewModel.removeFromSeat(seat); onDismiss()
            }
        }
        PartySheetRow(Icons.Outlined.Person, "View profile", c.textPrimary) {
            onDismiss(); onOpenProfile(seat.uid)
        }
        if (state.canModerate) {
            // The harsh one, and the reason it is last and red: a removal refuses
            // them a token, so they cannot come back until the room closes.
            PartySheetRow(Icons.Default.Block, "Remove from the room", c.statusDanger) {
                confirmRemove = true
            }
        }
    }

    if (confirmRemove && seat != null) {
        val name = seat.name.ifBlank { "this person" }
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            containerColor = c.bgElevated,
            title = { Text("Remove $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "They lose their seat and cannot rejoin this room. There is no undo — " +
                        "the block lasts until the room closes.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton({ confirmRemove = false; viewModel.removeFromRoom(seat.uid); onDismiss() }) {
                    Text("Remove", color = c.statusDanger)
                }
            },
            dismissButton = {
                TextButton({ confirmRemove = false }) { Text("Cancel", color = c.textSecondary) }
            },
        )
    }
}

// ── Seat requests ────────────────────────────────────────────────────────────

/**
 * The queue, in a consent-mode room.
 *
 * Oldest first, which is the order the repository sorts them in and the only
 * order that is fair — somebody who asked four minutes ago should not be behind
 * somebody who asked four seconds ago because a map reordered.
 */
@Composable
internal fun PartySeatRequestsSheet(
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    onOpenProfile: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    PartySheetFrame("Seat requests · ${state.seatRequests.size}", onDismiss) {
        if (state.seatRequests.isEmpty()) {
            Text(
                "Nobody is waiting. When somebody asks for a seat they appear here.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
                modifier = Modifier.padding(Space.lg),
            )
        } else {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(state.seatRequests, key = { it.uid }) { req ->
                    val busy = state.busyUid == req.uid
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        Avatar(
                            req.photoUrl, size = AvatarSize.MD, initial = req.name,
                            modifier = Modifier.clickableNoRipple { onDismiss(); onOpenProfile(req.uid) },
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                req.name.ifBlank { "Guest" }, style = ZipperTheme.type.labelM,
                                color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "wants seat ${req.seatIndex}", style = ZipperTheme.type.caption,
                                color = c.textSecondary, maxLines = 1,
                            )
                        }
                        // A spinner on both buttons while the decision is in
                        // flight: the row only disappears when the requests
                        // snapshot comes back, and until it does a slow approval
                        // and a failed one looked identical.
                        ZipperButton(
                            "Decline", { viewModel.decideSeatRequest(req.uid, false) },
                            style = ButtonStyle.Secondary, size = ButtonSize.Small,
                            enabled = !busy, loading = busy,
                        )
                        ZipperButton(
                            "Approve", { viewModel.decideSeatRequest(req.uid, true) },
                            gradient = true, size = ButtonSize.Small,
                            enabled = !busy, loading = busy,
                        )
                    }
                }
            }
        }
    }
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Everybody in the room, and what this viewer is allowed to do to them.
 *
 * Two lists in one sheet. The admins come first and are owner-only, because an
 * admin who has left the room still holds the power and would otherwise be
 * invisible and unrevokable — `room.admins` is a list of uids and nothing else
 * on screen reads it.
 */
@Composable
internal fun PartyMembersSheet(
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    onOpenProfile: (String) -> Unit,
    onDismiss: () -> Unit,
    /** B7: the member card's Message and Send-a-gift. */
    onOpenChat: (String) -> Unit = {},
    onGift: () -> Unit = {},
) {
    val c = ZipperTheme.colors
    val room = state.room
    val members = state.memberList
    var actionFor by remember { mutableStateOf<PartyMember?>(null) }
    var confirmRemove by remember { mutableStateOf<PartyMember?>(null) }

    PartySheetFrame("People · ${members.size}", onDismiss) {
        LazyColumn(Modifier.heightIn(max = 440.dp)) {
            if (state.isOwner && room != null && room.admins.isNotEmpty()) {
                item(key = "adminsLabel") {
                    Text(
                        "Admins", style = ZipperTheme.type.labelS, color = c.textSecondary,
                        modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
                    )
                }
                items(room.admins, key = { uid -> "admin_$uid" }) { uid ->
                    val known = members.firstOrNull { it.uid == uid }
                    val busy = state.busyUid == uid
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.md),
                    ) {
                        Avatar(known?.photoUrl, size = AvatarSize.MD, initial = known?.name ?: "A")
                        Column(Modifier.weight(1f)) {
                            Text(
                                known?.name?.ifBlank { null } ?: "Admin",
                                style = ZipperTheme.type.labelM, color = c.textPrimary,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                if (known == null) "not in the room right now" else "admin",
                                style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1,
                            )
                        }
                        ZipperButton(
                            "Remove", { viewModel.setAdmin(uid, false) },
                            style = ButtonStyle.Secondary, size = ButtonSize.Small,
                            enabled = !busy, loading = busy,
                        )
                    }
                }
                item(key = "adminsDivider") { HairlineDivider() }
            }

            item(key = "membersLabel") {
                Text(
                    "In the room", style = ZipperTheme.type.labelS, color = c.textSecondary,
                    modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
                )
            }
            if (members.isEmpty()) {
                item(key = "membersEmpty") {
                    Text(
                        "Just you so far. Share the room and people will turn up.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                        modifier = Modifier.padding(Space.lg),
                    )
                }
            }
            items(members, key = { it.uid }) { m ->
                val isOwnerRow = room?.isOwner(m.uid) == true
                val isAdminRow = room?.isAdmin(m.uid) == true
                Row(
                    Modifier.fillMaxWidth().clickableNoRipple { actionFor = m }
                        .padding(horizontal = Space.lg, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Box {
                        Avatar(m.photoUrl, size = AvatarSize.MD, initial = m.name, decorUid = m.uid)
                        // Online dot: green = here, yellow = on a call (Owner, 6 Nov 2026).
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(12.dp)
                                .background(c.bgElevated, androidx.compose.foundation.shape.CircleShape).padding(2.dp)
                                .background(if (m.inCall) Color(0xFFFFC107) else c.statusSuccess, androidx.compose.foundation.shape.CircleShape),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (m.uid == state.myUid) "${m.name.ifBlank { "You" }} (you)" else m.name.ifBlank { "Guest" },
                            style = ZipperTheme.type.labelM, color = c.textPrimary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            (if (m.seatIndex > 0) "on seat ${m.seatIndex}" else "listening") + if (m.inCall) " · in a call" else "",
                            style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1,
                        )
                    }
                    when {
                        isOwnerRow -> Chip("HOST", tint = c.tintGoldSubtle, contentColor = c.brandVip)
                        isAdminRow -> Chip("ADMIN", tint = c.tintVioletSubtle, contentColor = c.brandSecondary)
                        else -> Unit
                    }
                }
            }
        }
    }

    actionFor?.let { m ->
        PartyMemberActionsDialog(
            member = m,
            state = state,
            onInvite = { seatIndex -> actionFor = null; viewModel.inviteToSeat(m.uid, seatIndex) },
            onRemoveFromSeat = {
                actionFor = null
                state.seatByIndex[m.seatIndex]?.let { viewModel.removeFromSeat(it) }
            },
            onSetAdmin = { make -> actionFor = null; viewModel.setAdmin(m.uid, make) },
            onRemoveFromRoom = { actionFor = null; confirmRemove = m },
            onOpenProfile = { actionFor = null; onDismiss(); onOpenProfile(m.uid) },
            onDismiss = { actionFor = null },
            viewModel = viewModel,
            onMessage = { actionFor = null; onDismiss(); onOpenChat(m.uid) },
            onGift = { actionFor = null; onDismiss(); onGift() },
            // O5c: call them from the card — the confirmation and the call screen are the room screen's.
            onCall = { actionFor = null; onDismiss(); viewModel.prepareCall(m.uid, m.name) },
        )
    }

    confirmRemove?.let { m ->
        val name = m.name.ifBlank { "this person" }
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            containerColor = c.bgElevated,
            title = { Text("Remove $name?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "They are dropped from the room and cannot rejoin it. There is no undo.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton({ confirmRemove = null; viewModel.removeFromRoom(m.uid) }) {
                    Text("Remove", color = c.statusDanger)
                }
            },
            dismissButton = {
                TextButton({ confirmRemove = null }) { Text("Cancel", color = c.textSecondary) }
            },
        )
    }
}

/**
 * What one viewer may do to one member.
 *
 * Every row is gated on the viewer's role rather than on the server's answer,
 * so nothing here is offered that would come back refused: `inviteToSeat`,
 * `removeFromRoom` and `setAdmin` all check the same thing again on the way in.
 */
@Composable
private fun PartyMemberActionsDialog(
    member: PartyMember,
    state: PartyRoomUiState,
    onInvite: (Int) -> Unit,
    onRemoveFromSeat: () -> Unit,
    onSetAdmin: (Boolean) -> Unit,
    onRemoveFromRoom: () -> Unit,
    onOpenProfile: () -> Unit,
    onDismiss: () -> Unit,
    viewModel: PartyRoomViewModel? = null,
    onMessage: () -> Unit = {},
    onGift: () -> Unit = {},
    onCall: () -> Unit = {},
) {
    val c = ZipperTheme.colors
    val room = state.room
    val isMe = member.uid == state.myUid
    // B7: the card's social actions. Follow state is asked once when the card opens.
    var following by remember(member.uid) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(member.uid) { if (!isMe && viewModel != null) following = viewModel.isFollowing(member.uid) }
    var confirmBlock by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf(false) }
    val targetIsOwner = room?.isOwner(member.uid) == true
    val targetIsAdmin = room?.isAdmin(member.uid) == true
    val freeSeat = lowestFreeSeat(state)
    val busy = state.busyUid == member.uid

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgElevated,
        title = {
            // B7: a profile card — photo, name, level and where they are in the room; tap it for the full profile.
            // O9 (5 Nov 2026): drawn on the profile card this person wears (their public profile), when they wear one.
            val card = com.zipper.app.ui.components.rememberDecorBrush(
                "profile_card", com.zipper.app.ui.components.rememberUserDecor(member.uid)?.cardId,
            )
            Row(
                Modifier.fillMaxWidth()
                    .then(if (card != null) Modifier.background(card, RoundedCornerShape(Radius.lg)).padding(Space.md) else Modifier)
                    .clickableNoRipple(onOpenProfile),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Avatar(member.photoUrl, size = AvatarSize.LG, initial = member.name, decorUid = member.uid, animatedFrame = true)
                Column(Modifier.weight(1f)) {
                    Text(
                        member.name.ifBlank { "Guest" }, style = ZipperTheme.type.headingS,
                        color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        listOfNotNull(
                            if (member.level > 0) "Lv ${member.level}" else null,
                            if (targetIsOwner) "Host" else if (targetIsAdmin) "Admin" else null,
                            if (member.seatIndex > 0) "Seat ${member.seatIndex}" else "Listening",
                        ).joinToString(" · "),
                        style = ZipperTheme.type.caption, color = c.textSecondary,
                    )
                }
            }
        },
        text = {
            Column(Modifier.fillMaxWidth()) {
                PartySheetRow(Icons.Outlined.Person, "View profile", c.textPrimary, onClick = onOpenProfile)
                if (!isMe && viewModel != null) {
                    val f = following
                    PartySheetRow(
                        Icons.Default.Star,
                        when (f) { true -> "Following — tap to unfollow"; false -> "Follow"; null -> "Follow" },
                        c.textPrimary, enabled = f != null,
                    ) { viewModel.follow(member.uid, f != true); following = f != true }
                    PartySheetRow(Icons.Outlined.Person, "Message", c.textPrimary, onClick = onMessage)
                    // O5c: call this person. The room's owner may have switched calls off while hosting — then the row
                    // says so and does nothing (the server refuses such a call anyway). WP2: and "Busy" while they are on
                    // another call — the same answer the profile and the chat give (CallAvailability).
                    val ownerCallsOff = room?.isOwner(member.uid) == true && room.ownerBlocksCalls
                    val availability by com.zipper.app.ui.components.rememberCallAvailability(member.uid)
                    val cannotRing = ownerCallsOff || !availability.canCall
                    PartySheetRow(
                        if (cannotRing) Icons.Default.VideocamOff else Icons.Default.Videocam,
                        when {
                            ownerCallsOff -> "Calls off while hosting"
                            !availability.canCall -> availability.message.ifBlank { availability.label }
                            else -> "Call"
                        },
                        if (cannotRing) c.textMuted else c.statusSuccess, enabled = !cannotRing, onClick = onCall,
                    )
                    if (member.seatIndex > 0) PartySheetRow(Icons.Default.Add, "Send a gift", c.textPrimary, onClick = onGift)
                    PartySheetRow(Icons.Default.Block, "Report", c.textPrimary) { reporting = true }
                    PartySheetRow(Icons.Default.Block, "Block", c.statusDanger) { confirmBlock = true }
                }

                if (state.canModerate && !isMe && member.seatIndex == 0) {
                    // The lowest free unlocked seat, picked here rather than asked
                    // for: a moderator inviting somebody does not care which seat,
                    // and a seat number they chose could be taken by the time the
                    // invitation is answered anyway.
                    PartySheetRow(
                        Icons.Default.Add,
                        if (freeSeat > 0) "Invite to seat $freeSeat" else "No free seat to invite them to",
                        c.textPrimary,
                        enabled = freeSeat > 0 && !busy,
                    ) { onInvite(freeSeat) }
                }
                if (state.canModerate && !isMe && member.seatIndex > 0) {
                    PartySheetRow(
                        Icons.Default.PersonOff, "Take them off seat ${member.seatIndex}",
                        c.textPrimary, enabled = !busy, onClick = onRemoveFromSeat,
                    )
                }
                // Admins are the owner's to appoint. `setPartyAdmin` refuses an
                // admin who tries to appoint another one, which is what keeps a
                // co-host from quietly building a majority.
                if (state.isOwner && !isMe && !targetIsOwner) {
                    PartySheetRow(
                        Icons.Default.Star,
                        if (targetIsAdmin) "Remove as admin" else "Make an admin",
                        if (targetIsAdmin) c.textPrimary else c.brandVip,
                        enabled = !busy,
                    ) { onSetAdmin(!targetIsAdmin) }
                }
                if (state.canModerate && !isMe && !targetIsOwner) {
                    PartySheetRow(
                        Icons.Default.Block, "Remove from the room", c.statusDanger,
                        enabled = !busy, onClick = onRemoveFromRoom,
                    )
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Close", color = c.textSecondary) } },
    )

    // B7: block and report ask once, in words, before anything is sent.
    if (confirmBlock && viewModel != null) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false },
            containerColor = c.bgElevated,
            title = { Text("Block ${member.name.ifBlank { "this person" }}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("They can no longer call or message you. You can unblock them from Settings.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ confirmBlock = false; viewModel.block(member); onDismiss() }) { Text("Block", color = c.statusDanger) } },
            dismissButton = { TextButton({ confirmBlock = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    if (reporting && viewModel != null) {
        val reasons = listOf("Harassment or bullying", "Sexual content", "Hate or violence", "Spam or scam", "Underage user", "Something else")
        AlertDialog(
            onDismissRequest = { reporting = false },
            containerColor = c.bgElevated,
            title = { Text("Why are you reporting them?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Column {
                    reasons.forEach { r ->
                        PartySheetRow(Icons.Default.Block, r, c.textPrimary) { reporting = false; viewModel.report(member.uid, r); onDismiss() }
                    }
                }
            },
            confirmButton = { TextButton({ reporting = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

/**
 * The lowest seat nobody is on and nobody has locked, or 0.
 *
 * Seats are 1-based; 0 is the "no such seat" answer and also what
 * [PartyMember.seatIndex] uses for a listener, so a 0 from here is safe to test
 * against rather than to pass on.
 */
internal fun lowestFreeSeat(state: PartyRoomUiState): Int {
    val taken = state.seatByIndex.keys
    val locked = state.room?.lockedSeats?.toSet() ?: emptySet()
    return (1..state.seatCount).firstOrNull { it !in taken && it !in locked } ?: 0
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The owner's settings, saved one row at a time.
 *
 * One Save per setting rather than one for the sheet, because `updatePartyRoom`
 * writes only the fields it is given — so two settings changed in sequence do
 * not clobber each other, and a rejected welcome message does not block a
 * rename.
 *
 * Every local field is keyed on the value it came from, so a successful save
 * resyncs it from the room document instead of leaving the sheet showing what
 * was typed. The keys are the individual fields and not the whole room, because
 * the room document changes every time somebody walks in — `listenerCount` — and
 * keying on that would wipe a half-typed welcome message several times a minute.
 */
@Composable
internal fun PartyRoomSettingsSheet(
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val room = state.room ?: return

    var title by remember(room.title) { mutableStateOf(room.title) }
    var welcome by remember(room.welcomeMessage) { mutableStateOf(room.welcomeMessage) }
    var password by remember { mutableStateOf("") }
    var choosingPrivate by remember { mutableStateOf(false) }
    var shrinkTo by remember { mutableIntStateOf(0) }

    val welcomeProblem = PartyRoom.welcomeProblem(welcome)
    val highestOccupied = state.seats.maxOfOrNull { it.index } ?: 0
    val saving = state.savingSettings

    PartySheetFrame("Room settings", onDismiss) {
        Column(
            Modifier.fillMaxWidth()
                // imePadding BEFORE the scroll, so the keyboard shortens the
                // scrolling area rather than being padded out inside it — which
                // puts the field being typed into above the keyboard instead of
                // behind it.
                .imePadding()
                .heightIn(max = 520.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            // ── Theme (B7) ───────────────────────────────────────────────────
            SettingLabel("Background")
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ROOM_THEMES.forEach { (id, name) ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier.size(54.dp, 72.dp)
                                .background(roomThemeBrush(id), RoundedCornerShape(Radius.md))
                                .border(if (room.theme == id) 2.dp else 1.dp, if (room.theme == id) c.brandPrimary else c.borderSubtle, RoundedCornerShape(Radius.md))
                                .then(if (!saving) Modifier.clickableNoRipple { viewModel.saveSettings(theme = id) } else Modifier),
                        )
                        Text(name, style = ZipperTheme.type.caption, color = c.textSecondary)
                    }
                }
            }

            // ── Calls while hosting (B7) ─────────────────────────────────────
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    SettingLabel("No calls while I'm in this room")
                    Text(
                        "People who ring you are told you're hosting a party room.",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                    )
                }
                androidx.compose.material3.Switch(
                    checked = room.ownerBlocksCalls,
                    onCheckedChange = { viewModel.saveSettings(blockCalls = it) },
                    enabled = !saving,
                )
            }

            HairlineDivider()

            // ── Name ─────────────────────────────────────────────────────────
            SettingLabel("Room name")
            SettingField(
                value = title, placeholder = "${room.hostName}'s room",
                maxChars = 60, singleLine = true,
            ) { title = it }
            ZipperButton(
                "Save name", { viewModel.saveSettings(title = title.trim()) },
                size = ButtonSize.Small, style = ButtonStyle.Secondary,
                enabled = !saving && title.trim() != room.title,
                loading = saving,
            )

            HairlineDivider()

            // ── Welcome ──────────────────────────────────────────────────────
            SettingLabel("Welcome message")
            Text(
                "The first thing anybody reads when they walk in. No numbers — this line " +
                    "fills up with phone numbers otherwise.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )
            SettingField(
                value = welcome, placeholder = PartyRoom.DEFAULT_WELCOME,
                maxChars = PartyRoom.WELCOME_MAX_CHARS, singleLine = false,
            ) { welcome = it }
            if (welcomeProblem != null) {
                // Says WHY the button is off. A disabled Save with no reason is
                // the same defect as a silent server rejection.
                Text(welcomeProblem, style = ZipperTheme.type.caption, color = c.statusDanger)
            }
            ZipperButton(
                "Save welcome", { viewModel.saveSettings(welcomeMessage = welcome.trim()) },
                size = ButtonSize.Small, style = ButtonStyle.Secondary,
                enabled = !saving && welcomeProblem == null && welcome.trim() != room.welcomeMessage,
                loading = saving,
            )

            HairlineDivider()

            // ── Seats ────────────────────────────────────────────────────────
            SettingLabel("Seats")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                PartyRoom.seatChoices(room.mode).forEach { n ->
                    ChoicePill("$n seats", selected = n == room.seatCount, enabled = !saving) {
                        if (n == room.seatCount) return@ChoicePill
                        // Shrinking is destructive, so it asks. Growing is not.
                        if (n < highestOccupied) shrinkTo = n else viewModel.saveSettings(seatCount = n)
                    }
                }
            }
            Text(
                "Fewer seats removes whoever is sitting above the new limit.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )

            HairlineDivider()

            // ── Seat mode ────────────────────────────────────────────────────
            SettingLabel("Taking a seat")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ChoicePill(
                    "Anyone can sit",
                    selected = room.seatMode == PartyRoom.SEAT_MODE_FREE, enabled = !saving,
                ) { viewModel.saveSettings(seatMode = PartyRoom.SEAT_MODE_FREE) }
                ChoicePill(
                    "Ask me first",
                    selected = room.seatMode == PartyRoom.SEAT_MODE_CONSENT, enabled = !saving,
                ) { viewModel.saveSettings(seatMode = PartyRoom.SEAT_MODE_CONSENT) }
            }
            Text(
                if (room.needsSeatConsent)
                    "Requests arrive in the seat-requests list for you and your admins to approve."
                else
                    "Anybody in the room can take a free seat without asking.",
                style = ZipperTheme.type.caption, color = c.textMuted,
            )

            HairlineDivider()

            // ── Visibility ───────────────────────────────────────────────────
            SettingLabel("Who can find this room")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ChoicePill(
                    "Public", selected = !room.isPrivate && !choosingPrivate, enabled = !saving,
                ) {
                    choosingPrivate = false
                    if (room.isPrivate) viewModel.saveSettings(visibility = PartyRoom.VISIBILITY_PUBLIC)
                }
                ChoicePill(
                    "Private", selected = room.isPrivate || choosingPrivate, enabled = !saving,
                ) { choosingPrivate = true }
            }
            if (room.isPrivate || choosingPrivate) {
                Text(
                    if (room.isPrivate)
                        "Private. Only people you give the four digits to can get in — set a new code below."
                    else
                        "A private room needs a four-digit code. Nobody can get in without it, " +
                            "so send it to the people you want.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                )
                PartyDigitsField(code = password, error = false, onCode = { password = it }) { }
                ZipperButton(
                    if (room.isPrivate) "Change the code" else "Make it private",
                    {
                        viewModel.saveSettings(
                            visibility = PartyRoom.VISIBILITY_PRIVATE,
                            password = password,
                        )
                        password = ""
                        choosingPrivate = false
                    },
                    size = ButtonSize.Small, style = ButtonStyle.Secondary,
                    // Exactly four digits. `updatePartyRoom` refuses anything
                    // else, and a Save that fails on the length is a round trip
                    // the field could have prevented.
                    enabled = !saving && password.length == 4,
                    loading = saving,
                )
            }
        }
    }

    if (shrinkTo > 0) {
        val losing = state.seats.count { it.index > shrinkTo }
        AlertDialog(
            onDismissRequest = { shrinkTo = 0 },
            containerColor = c.bgElevated,
            title = { Text("Shrink to $shrinkTo seats?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    if (losing == 1) "One person is sitting above seat $shrinkTo. They lose their seat and stay in the room as a listener."
                    else "$losing people are sitting above seat $shrinkTo. They lose their seats and stay in the room as listeners.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton({ val n = shrinkTo; shrinkTo = 0; viewModel.saveSettings(seatCount = n) }) {
                    Text("Shrink", color = c.statusDanger)
                }
            },
            dismissButton = { TextButton({ shrinkTo = 0 }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

// ── Invitation ───────────────────────────────────────────────────────────────

/**
 * Somebody has offered this person a seat.
 *
 * A dialog and not a chat line or a snackbar: an invitation expires, it has two
 * answers, and the one thing it must not do is scroll away unanswered. Accepting
 * needs the microphone, which is why [onAccept] goes back through the screen's
 * permission gate rather than straight to `respondToInvite`.
 */
@Composable
internal fun PartySeatInviteDialog(
    invite: PartySeatInvite,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    val c = ZipperTheme.colors
    AlertDialog(
        onDismissRequest = { /* An invitation is answered, not dismissed. */ },
        containerColor = c.bgElevated,
        icon = {
            Box(
                Modifier.size(56.dp).background(c.tintBrandMedium, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Outlined.Campaign, null, tint = c.brandPrimary, modifier = Modifier.size(Size.Icon.xl)) }
        },
        title = { Text("Come on up", style = ZipperTheme.type.headingS, color = c.textPrimary) },
        text = {
            Text(
                "${invite.byName.ifBlank { "The host" }} is offering you seat ${invite.seatIndex} " +
                    "in ${invite.roomTitle.ifBlank { "this room" }}. Everyone will hear you.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center,
            )
        },
        confirmButton = { TextButton(onAccept) { Text("Take the seat", color = c.textBrand) } },
        dismissButton = { TextButton(onDecline) { Text("No thanks", color = c.textSecondary) } },
    )
}

// ── Permission ───────────────────────────────────────────────────────────────

/**
 * Why a seat needs the microphone, shown only when the request was refused.
 *
 * Deliberately NOT a gate on the screen. Listening to a party needs no
 * microphone, and demanding one at the door would shut out everybody who only
 * ever listens — which is most of the room. This appears at the one moment the
 * permission actually matters: somebody tried to sit down and said no.
 */
@Composable
internal fun PartyMicRationaleDialog(
    video: Boolean,
    onAllow: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgElevated,
        icon = {
            Box(
                Modifier.size(56.dp).background(c.tintDangerSubtle, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.MicOff, null, tint = c.statusDanger, modifier = Modifier.size(Size.Icon.xl)) }
        },
        title = {
            Text(
                if (video) "Microphone and camera needed" else "Microphone needed",
                style = ZipperTheme.type.headingS, color = c.textPrimary,
            )
        },
        text = {
            Text(
                if (video)
                    "A seat in a video room publishes your voice and your camera. Without both, " +
                        "you would be sitting there silent and blank with nothing on screen to " +
                        "explain why. You can keep listening without them."
                else
                    "A seat publishes your voice to the room. Without the microphone you would be " +
                        "sitting on a seat that nobody can hear, and nothing on screen would say " +
                        "why. You can keep listening without it.",
                style = ZipperTheme.type.bodyM, color = c.textSecondary,
            )
        },
        confirmButton = { TextButton(onAllow) { Text("Allow access", color = c.textBrand) } },
        dismissButton = { TextButton(onDismiss) { Text("Keep listening", color = c.textSecondary) } },
    )
}

// ── Leaving ──────────────────────────────────────────────────────────────────

/**
 * The close button's two answers.
 *
 * Picture-in-picture is the one most people want and the one that did not exist:
 * a party is something you listen to while doing something else, and before this
 * the only way out of the room was out of the room.
 */
@Composable
internal fun PartyExitDialog(
    canPip: Boolean,
    isOwner: Boolean,
    onPip: () -> Unit,
    onLeave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgElevated,
        title = { Text("Leave the room?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                if (canPip) {
                    PartySheetRow(
                        Icons.Default.PictureInPicture,
                        "Minimise and keep listening",
                        c.textPrimary,
                        onClick = onPip,
                    )
                }
                PartySheetRow(
                    Icons.AutoMirrored.Outlined.Logout, "Leave the room", c.statusDanger, onClick = onLeave,
                )
                Text(
                    if (isOwner)
                        "Leaving does not close the room — the others stay. Use “End this room” for that."
                    else
                        "You give up your seat when you leave, and somebody else can take it.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                )
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Stay", color = c.textSecondary) } },
    )
}

// ── Entrance effects ─────────────────────────────────────────────────────────

/**
 * How long one entrance may hold the stage, in millis.
 *
 * A watchdog rather than a duration: [EntranceVideo] reports its own end, and
 * this is what happens when it cannot — a clip that never buffers, a decoder the
 * device would not hand over. Without it a single stalled video wedges the one
 * animation slot for the life of the room and nobody's entrance ever plays
 * again.
 */
private const val ENTRANCE_WATCHDOG_MS = 6_000L

/** No video for this cosmetic: the name plate alone, and briefly. */
private const val ENTRANCE_PLATE_MS = 2_200L

/**
 * One arriving member's entrance effect.
 *
 * ── WHY THERE IS ONLY EVER ONE ───────────────────────────────────────────────
 *
 * An entrance is a full-screen H.264 clip on a hardware decoder session, and a
 * device has a small fixed number of those — two or three on budget hardware.
 * A busy room gets arrivals in bursts, so the screen holds a single slot and
 * DROPS arrivals that turn up while it is full rather than queueing them. Forty
 * people joining at the top of the hour must cost one animation, not forty
 * played back to back over the next four minutes.
 *
 * ── WHERE THE URLS COME FROM: THE SERVER, NOT A FETCH ────────────────────────
 *
 * `joinPartyRoom` calls `resolveCosmetics` and writes the RESOLVED urls onto the
 * listener row — `entranceVideoUrl`, `entrancePosterUrl`, `idFrameUrl` — alongside
 * the item ids. So this composable reads what it draws straight off [listener] and
 * fetches nothing at all.
 *
 * That is what the denormalisation is for. This overlay used to read
 * `bagItems/{id}` itself and keep a per-screen cache of the result, because the
 * listener row carried only the item id: one arrival in a room of forty was forty
 * clients reading the same catalogue document, and every distinct cosmetic cost a
 * round trip before its clip could start. Resolving it once, on the way in, is
 * strictly cheaper and it is also the only version that is correct — the cache made
 * the poster appear for the FIRST arrival wearing a given cosmetic and nobody
 * after, because `previewUrl` was only ever assigned on the cache-miss branch.
 *
 * A blank [PartyListener.entranceVideoUrl] is a real and expected state, not a
 * failure to handle: the item may have no clip, or `resolveCosmetics` may not have
 * been able to resolve it. That case gets the name plate and [ENTRANCE_PLATE_MS],
 * because somebody wearing an entrance should still be announced.
 */
@Composable
internal fun PartyEntranceOverlay(
    listener: PartyListener,
    onFinished: () -> Unit,
) {
    val c = ZipperTheme.colors

    // The watchdog, and nothing else — there is no fetch left to wait on before the
    // clip can start, so this is purely the fallback timer. A clip that reports its
    // own end calls `onFinished` through EntranceVideo first; this is what releases
    // the single animation slot when it cannot.
    LaunchedEffect(listener.uid) {
        delay(if (listener.hasEntrance) ENTRANCE_WATCHDOG_MS else ENTRANCE_PLATE_MS)
        onFinished()
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (listener.entranceSvgaUrl.isNotBlank()) {
            // B13: the SVGA entrance greets the arrival by photo and name (dynamic keys `avatar`, `name`).
            com.zipper.app.ui.components.Svga(
                source = listener.entranceSvgaUrl,
                modifier = Modifier.fillMaxSize(),
                loops = 1,
                dynamicImages = mapOf("avatar" to listener.photoUrl),
                dynamicTexts = mapOf("name" to listener.name),
                onFinished = onFinished,
            )
        } else if (listener.hasEntrance) {
            EntranceVideo(
                videoUrl = listener.entranceVideoUrl,
                posterUrl = listener.entrancePosterUrl,
                contentDescription = "${listener.name} arriving",
                modifier = Modifier.fillMaxSize(),
                loop = false,
                onFinished = onFinished,
            )
        }
        // The name plate, with or without a clip behind it. It is the part that
        // says who arrived, and an entrance whose video is missing should still
        // announce them.
        Row(
            Modifier.align(Alignment.BottomCenter)
                .padding(bottom = Space.x7l)
                .background(c.scrimStrong, CircleShape)
                .border(1.dp, c.tintGoldSubtle, CircleShape)
                .padding(start = 2.dp, end = Space.lg, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(
                listener.photoUrl.ifBlank { null }, size = AvatarSize.SM,
                ring = AvatarRing.Vip, initial = listener.name,
                // Their frame, now that `joinPartyRoom` resolves it onto the listener
                // row too. A frame is the cosmetic somebody paid real diamonds for and
                // the one moment the whole room is looking at them is their arrival —
                // dropping it here was the worst place in the product to drop it.
                frameUrl = listener.idFrameUrl.ifBlank { null },
            )
            Text(
                "${listener.name.ifBlank { "Someone" }} joined",
                style = ZipperTheme.type.labelM, color = c.textPrimary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 220.dp),
            )
            if (listener.level > 0) LevelChip(listener.level)
        }
    }
}


/** B7: the private room's access log, newest first — the owner's to read (rules: the room's host and staff). */
@Composable
internal fun PartyAccessLogSheet(viewModel: PartyRoomViewModel, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    val entries by remember { viewModel.accessLogFlow() }.collectAsStateWithLifecycle(emptyList())
    val fmt = remember { java.text.SimpleDateFormat("d MMM, h:mm a", java.util.Locale.ENGLISH) }
    PartySheetFrame("Access log", onDismiss) {
        if (entries.isEmpty()) {
            Text("Nobody has tried to come in yet.", style = ZipperTheme.type.bodyS, color = c.textMuted, modifier = Modifier.padding(Space.lg))
        }
        LazyColumn(Modifier.heightIn(max = 440.dp)) {
            items(entries.size) { i ->
                val e = entries[i]
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(e.name.ifBlank { e.uid }, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1)
                        Text(fmt.format(java.util.Date(e.atMs)), style = ZipperTheme.type.caption, color = c.textMuted)
                    }
                    Text(
                        when (e.result) {
                            "admitted" -> "Came in with the PIN"
                            "wrong_pin" -> "Wrong PIN"
                            "locked" -> "Locked out"
                            "official" -> "Zipper official (${e.role})"
                            else -> e.result
                        },
                        style = ZipperTheme.type.caption,
                        color = when (e.result) { "admitted" -> c.statusSuccess; "official" -> c.statusWarning; else -> c.statusDanger },
                    )
                }
            }
        }
    }
}


/**
 * B7: room music. The owner or an admin picks a track from Zipper's licensed catalogue; their phone plays it into the
 * room (mixed into the audio it publishes — so they need to be on a seat to be heard), with pause, volume and stop.
 * An empty catalogue says so: tracks are the Owner's to add, licensed, in the CRM.
 */
@Composable
internal fun PartyMusicSheet(state: PartyRoomUiState, viewModel: PartyRoomViewModel, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    val tracks by remember { viewModel.musicTracksFlow() }.collectAsStateWithLifecycle(emptyList())
    val now = state.room?.music
    val mine = now?.by == state.myUid
    var paused by remember { mutableStateOf(false) }
    var volume by remember { mutableFloatStateOf(60f) }
    PartySheetFrame("Music", onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            if (now != null) {
                Text("Now playing: ${now.title}${if (now.artist.isNotBlank()) " — ${now.artist}" else ""}", style = ZipperTheme.type.labelM, color = c.textPrimary)
                if (mine) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        ZipperButton(if (paused) "Resume" else "Pause", { paused = !paused; viewModel.pauseMusic(paused) }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
                        ZipperButton("Stop", { viewModel.stopMusic() }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
                    }
                    Text("Volume", style = ZipperTheme.type.caption, color = c.textMuted)
                    androidx.compose.material3.Slider(value = volume, onValueChange = { volume = it; viewModel.musicVolume(it.toInt()) }, valueRange = 0f..100f)
                } else {
                    Text("Played from another moderator's phone.", style = ZipperTheme.type.caption, color = c.textMuted)
                }
            }
            if (!state.amSeated) {
                Text("Take a seat to play music — it goes out with your microphone.", style = ZipperTheme.type.caption, color = c.statusWarning)
            }
            if (tracks.isEmpty()) {
                Text("No tracks yet. Zipper adds licensed music in the CRM.", style = ZipperTheme.type.bodyS, color = c.textMuted)
            }
        }
        LazyColumn(Modifier.heightIn(max = 360.dp)) {
            items(tracks.size) { i ->
                val t = tracks[i]
                PartySheetRow(Icons.Outlined.Settings, if (t.artist.isNotBlank()) "${t.title} — ${t.artist}" else t.title, c.textPrimary, enabled = state.amSeated) {
                    paused = false
                    viewModel.playMusic(t)
                }
            }
        }
    }
}
