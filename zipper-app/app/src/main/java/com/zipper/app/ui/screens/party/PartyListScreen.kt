package com.zipper.app.ui.screens.party

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.People
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.ui.components.*
// The glass chip lives with Live Browse, which is where it was drawn. Importing
// it beats a second copy that drifts from the first.
import com.zipper.app.ui.screens.live.GlassChip
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.launch

/*
 * Party rooms — discovery.
 *
 * Two modes, two tabs, because an audio room and a video room are different
 * products that happen to share a document shape: a listener looking for a
 * chat room is not browsing the same thing as one looking for faces, and
 * mixing them in one list makes both harder to scan. The tab is now the query —
 * `activeRoomsFlow(mode)` filters mode server-side and `selectMode` re-subscribes
 * — so this screen no longer holds rooms it has no intention of drawing.
 *
 * A list rather than the 2-up grid Live Browse uses. A live room has a video
 * thumbnail worth half a screen; a party room has a host avatar and three
 * numbers, and a row shows all of them at a glance while costing one image
 * decode instead of a grid full of them.
 *
 * ── THE NUMBERS COME OFF THE ROOM DOCUMENT NOW ───────────────────────────────
 *
 * Every row used to run two aggregate count queries of its own to find out how
 * many people were listening and how many seats were taken, because
 * `listenerCount` had no writer: it was set to 0 when the room was created and
 * never touched again, so the only honest way to show it was to count. Sixty
 * rooms meant a hundred and twenty count queries per subscription, and the
 * result still arrived a beat after the row it belonged to.
 *
 * The join and leave callables maintain `listenerCount` and `occupantCount`
 * properly, so a row is now a pure function of the one document it was handed.
 * No per-row query, and nothing on screen that can disagree with the room it
 * describes.
 */

@Composable
fun PartyListScreen(
    onBack: () -> Unit = {},
    onOpenRoom: (String) -> Unit = {},
    viewModel: PartyListViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val snackbar = remember { SnackbarHostState() }
    var showCreate by remember { mutableStateOf(false) }
    var showOpenById by remember { mutableStateOf(false) }

    /*
     * The snackbar lives in this screen's Box, which is UNDER the create sheet's
     * scrim — so while that sheet is open a refusal from `createPartyRoom` would
     * be announced behind it, and the only thing the host would see is a Start
     * button that came back enabled and did nothing. So the error is held in
     * state while the sheet is up and drawn inside it, next to the button that
     * failed, and the snackbar takes over the moment the sheet is gone. Keyed on
     * both, so a message held back on the way in is still delivered on the way
     * out.
     */
    LaunchedEffect(state.error, showCreate) {
        val message = state.error ?: return@LaunchedEffect
        if (showCreate) return@LaunchedEffect
        snackbar.showSnackbar(message)
        viewModel.clearError()
    }
    LaunchedEffect(state.createdRoomId) {
        state.createdRoomId?.let { id ->
            showCreate = false
            viewModel.consumeCreatedRoom()
            // The draft lives in the ViewModel, so it outlives the sheet. Clearing
            // it on the way into the new room is what stops the next tap of
            // "Start a room" from opening on the last room's settings — and
            // clearing the error stops a refusal that was fixed and retried from
            // following the host into the room that worked.
            viewModel.resetDraft()
            viewModel.clearError()
            onOpenRoom(id)
        }
    }

    val rooms = state.visibleRooms
    val onStartRoom: (() -> Unit)? = if (state.canCreateRoom) ({ showCreate = true }) else null

    ZipperScreen(
        topBar = {
            Column {
                TopBar(
                    title = "Party Rooms",
                    onBack = onBack,
                    actions = {
                        // What THIS tab can see, not a global figure: the query is
                        // one mode, capped at 60, and private rooms are not in it.
                        GlassChip(Icons.Outlined.People, "${compactCount(rooms.size.toLong())} open")
                        IconButtonCircle(
                            Icons.Outlined.Lock,
                            "Open a private room",
                            { showOpenById = true },
                            background = Color.Transparent,
                        )
                    },
                )
                Row(
                    Modifier.fillMaxWidth().padding(start = Space.md, end = Space.md, bottom = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    ModePill("Audio", Icons.Default.Mic, state.mode == PartyRoom.MODE_AUDIO) {
                        viewModel.selectMode(PartyRoom.MODE_AUDIO)
                    }
                    ModePill("Video", Icons.Default.Videocam, state.mode == PartyRoom.MODE_VIDEO) {
                        viewModel.selectMode(PartyRoom.MODE_VIDEO)
                    }
                }
                HairlineDivider()
            }
        },
    ) { _ ->
        Box(Modifier.fillMaxSize()) {
            when {
                state.isLoading -> LoadingState()
                rooms.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.Groups,
                    title = if (state.mode == PartyRoom.MODE_AUDIO) "No audio rooms open" else "No video rooms open",
                    body = if (state.canCreateRoom) {
                        "Open one and people will find you here — a room with one person in it fills up fast. " +
                            "Private rooms are never listed: if somebody sent you a room's id, use the lock above."
                    } else {
                        "Check the other tab, or look again in a few minutes. Rooms open all day. " +
                            "Private rooms are never listed — for one of those you need its id."
                    },
                    actionLabel = if (state.canCreateRoom) "Start a room" else null,
                    onAction = onStartRoom,
                )
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = Space.md, end = Space.md, top = Space.sm, bottom = 96.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    items(rooms, key = { it.roomId }, contentType = { "partyRoom" }) { room ->
                        PartyRoomRow(room) { onOpenRoom(room.roomId) }
                    }
                }
            }

            // Hidden only when nobody is signed in. A party room is deliberately
            // NOT behind the verified-host gate that going live needs — the
            // reasoning is on PartyListUiState.canCreateRoom — so this is offered
            // to very nearly everybody who can see the screen. A banned account is
            // refused by `createPartyRoom`, which is the only place that can say
            // why; hiding the button would explain a ban with a missing control.
            if (state.canCreateRoom) {
                Row(
                    Modifier.align(Alignment.BottomEnd).navigationBarsPadding()
                        .padding(end = Space.lg, bottom = Space.xxl)
                        .height(56.dp)
                        .background(Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape)
                        .clickableNoRipple { showCreate = true }
                        .padding(start = Space.xl, end = Space.xxl),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    Icon(Icons.Outlined.Groups, null, tint = Color.White, modifier = Modifier.size(Size.Icon.md))
                    Text("Start a room", style = ZipperTheme.type.labelL, color = Color.White)
                }
            }

            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = Space.x7l)) { data ->
                Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
            }
        }
    }

    if (showCreate) {
        CreateRoomSheet(
            state = state,
            viewModel = viewModel,
            onDismiss = { showCreate = false; viewModel.resetDraft() },
        )
    }

    if (showOpenById) {
        OpenPrivateRoomSheet(
            // The lookup, not the ViewModel. The sheet needs one answer about one id
            // and has no business with a draft, a mode or a room list — and a lambda
            // is the whole of what it needs, so that is what it gets.
            findRoom = { id -> viewModel.findRoom(id) },
            onOpen = { roomId -> showOpenById = false; onOpenRoom(roomId) },
            onDismiss = { showOpenById = false },
        )
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun ModePill(label: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.height(32.dp)
            .then(
                if (selected) Modifier.background(
                    Brush.horizontalGradient(listOf(c.brandGradientFrom, c.brandGradientTo)), CircleShape,
                )
                else Modifier.background(c.glassLow, CircleShape).border(1.dp, c.borderDefault, CircleShape)
            )
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, null, tint = if (selected) Color.White else c.textSecondary, modifier = Modifier.size(Size.Icon.sm))
        Text(label, style = ZipperTheme.type.labelS, color = if (selected) Color.White else c.textSecondary)
    }
}

/**
 * One room in the list.
 *
 * No animation and no media here on purpose. This row is the thing a user
 * scrolls past twenty of on a phone that cannot afford twenty of anything —
 * and every value it draws now comes off [room] itself, so scrolling costs
 * nothing but layout.
 */
@Composable
private fun PartyRoomRow(room: PartyRoom, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    // Clamped, because these are two independently written numbers: the seat
    // count can be SHRUNK from the owner's settings sheet, and between that write
    // and the seat documents being removed a room can honestly read "12 of 10".
    val taken = room.occupantCount.coerceIn(0, room.seatCount)
    val full = taken >= room.seatCount

    Row(
        Modifier.fillMaxWidth()
            .background(c.bgRaised, RoundedCornerShape(Radius.lg))
            .clickableNoRipple(onClick)
            .padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Avatar(
            room.hostPhotoUrl,
            size = AvatarSize.LG,
            ring = AvatarRing.Live,
            initial = room.hostName,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                // `createPartyRoom` fills an empty name in with "<FirstName>'s
                // room", so a blank title can only reach here from a room made
                // before it did. Keeping the fallback is cheaper than proving
                // there are none left.
                room.title.ifBlank { "${room.hostName}'s room" },
                style = ZipperTheme.type.labelM, color = c.textPrimary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                room.hostName, style = ZipperTheme.type.caption, color = c.textSecondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                if (room.isAudio) {
                    Chip("AUDIO", tint = c.tintVioletSubtle, contentColor = c.brandSecondary, icon = Icons.Default.Mic)
                } else {
                    Chip("VIDEO", tint = c.tintBrandSubtle, contentColor = c.textBrand, icon = Icons.Default.Videocam)
                }
                Chip(
                    compactCount(room.listenerCount.toLong()),
                    tint = c.glassLow, contentColor = c.textSecondary, icon = Icons.Outlined.People,
                )
            }
        }
        /*
         * The one question that decides whether to tap: can I get on a seat?
         *
         * A consent room answers it differently, and this is where it has to be
         * said. An empty seat in one of those is not yours to take — the tap
         * becomes a request somebody has to approve — so it is drawn in the
         * warning colour and labelled, instead of showing an inviting green
         * "2/10" that turns into a queue after the tap. Walking in and finding
         * out is the small surprise this pre-empts.
         */
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (full) "FULL" else "$taken/${room.seatCount}",
                style = ZipperTheme.type.numericM,
                color = when {
                    full -> c.textMuted
                    room.needsSeatConsent -> c.statusWarning
                    else -> c.statusSuccess
                },
            )
            Text(
                when {
                    full -> "no seat free"
                    room.needsSeatConsent -> "ask to sit"
                    else -> "seats taken"
                },
                style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1,
            )
        }
    }
}

// ── Starting a room ──────────────────────────────────────────────────────────

/**
 * Everything a room is decided by, before it exists.
 *
 * The fields live on [PartyListUiState.draft] and not in this composable. That
 * is what makes [PartyDraft.problem] trustworthy: the reason Start is off is
 * computed from the same values the create call will send, so the button's state
 * and the sentence explaining it cannot disagree — and a sheet dismissed
 * mid-create does not take the half-filled form with it.
 *
 * Six settings and a paragraph of explanation is more than a bottom sheet shows
 * at once, so the body scrolls. The cap is what keeps the sheet from growing
 * taller than a short screen and clipping its own Start button off the bottom.
 */
@Composable
private fun CreateRoomSheet(
    state: PartyListUiState,
    viewModel: PartyListViewModel,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val draft = state.draft
    val problem = draft.problem
    val defaultTitle = defaultRoomTitle(state.currentUser?.name)

    PartySheetFrame("Start a party room", onDismiss) {
        Column(
            Modifier.fillMaxWidth()
                // imePadding BEFORE the scroll, so the keyboard shortens the
                // scrolling viewport rather than being padded out inside it —
                // which is what puts the field being typed into above the
                // keyboard instead of behind it. Same order as the room's
                // settings sheet, for the same reason.
                .imePadding()
                .heightIn(max = 440.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            // ── Mode ─────────────────────────────────────────────────────────
            FormLabel("What kind of room")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ModePill("Audio", Icons.Default.Mic, draft.mode == PartyRoom.MODE_AUDIO) {
                    viewModel.setDraftMode(PartyRoom.MODE_AUDIO)
                }
                ModePill("Video", Icons.Default.Videocam, draft.mode == PartyRoom.MODE_VIDEO) {
                    viewModel.setDraftMode(PartyRoom.MODE_VIDEO)
                }
            }
            FormHint(
                if (draft.mode == PartyRoom.MODE_AUDIO)
                    "Voices only. Cheapest on data and kindest to an old phone, which is why most rooms are audio."
                else
                    "Faces on camera. Every seat on video costs everybody in the room data and battery, not just the person sitting on it."
            )

            HairlineDivider()

            // ── Name ─────────────────────────────────────────────────────────
            FormLabel("Room name")
            FormField(
                value = draft.title,
                placeholder = defaultTitle,
                maxChars = 60,
                singleLine = true,
                showCount = false,
                onValue = viewModel::setDraftTitle,
            )
            FormHint("Optional. Leave it empty and the room is called “$defaultTitle”.")

            HairlineDivider()

            // ── Seats ────────────────────────────────────────────────────────
            FormLabel("Seats")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                draft.seatChoices.forEach { n ->
                    FormPill("$n seats", selected = n == draft.seatCount) {
                        viewModel.setDraftSeatCount(n)
                    }
                }
            }
            FormHint(
                if (draft.mode == PartyRoom.MODE_VIDEO && draft.seatCount == draft.seatChoices.last())
                    "Ten video tiles is about as many as a budget phone will composite without dropping frames. Six is the safer room."
                else
                    "How many people can talk at once. Everybody else is a listener, and a listener can be invited up later."
            )

            HairlineDivider()

            // ── Seat mode ────────────────────────────────────────────────────
            FormLabel("Taking a seat")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                FormPill("Anyone can sit", selected = draft.seatMode == PartyRoom.SEAT_MODE_FREE) {
                    viewModel.setDraftSeatMode(PartyRoom.SEAT_MODE_FREE)
                }
                FormPill("Ask me first", selected = draft.seatMode == PartyRoom.SEAT_MODE_CONSENT) {
                    viewModel.setDraftSeatMode(PartyRoom.SEAT_MODE_CONSENT)
                }
            }
            // Both lines, always, and not one line that changes with the pill.
            // This is the setting people read backwards, and the difference only
            // lands when the two halves of it are set against each other.
            Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                FormHint("Anyone can sit — somebody taps an empty seat and is talking a second later.")
                FormHint("Ask me first — a tap becomes a request, and nobody is heard until you or an admin says yes.")
            }

            HairlineDivider()

            // ── Visibility ───────────────────────────────────────────────────
            FormLabel("Who can find this room")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                FormPill("Public", selected = !draft.isPrivate) {
                    viewModel.setDraftVisibility(PartyRoom.VISIBILITY_PUBLIC)
                }
                FormPill("Private", selected = draft.isPrivate) {
                    viewModel.setDraftVisibility(PartyRoom.VISIBILITY_PRIVATE)
                }
            }
            if (draft.isPrivate) {
                // Said in as many words because it is the surprise in this sheet:
                // the list this room was started from will never show it, and a
                // host who does not know that opens one and waits for an audience
                // that has no way to arrive.
                FormHint(
                    "A private room never appears in this list. People get in with the room's id AND these four " +
                        "digits, so they need both from you."
                )
                PartyDigitsField(
                    code = draft.password,
                    error = false,
                    onCode = viewModel::setDraftPassword,
                ) { }
            } else {
                FormHint(
                    "Anybody browsing the ${if (draft.mode == PartyRoom.MODE_AUDIO) "audio" else "video"} tab " +
                        "can see it and walk in."
                )
            }

            HairlineDivider()

            // ── Welcome ──────────────────────────────────────────────────────
            FormLabel("Welcome message")
            FormHint(
                "The first thing anybody reads when they walk in. No numbers — left free, this line fills up with " +
                    "phone numbers and handles sending people somewhere with no moderation and no reporting."
            )
            FormField(
                value = draft.welcomeMessage,
                placeholder = PartyRoom.DEFAULT_WELCOME,
                maxChars = PartyRoom.WELCOME_MAX_CHARS,
                singleLine = false,
                showCount = true,
                onValue = viewModel::setDraftWelcome,
            )

            // ── Start ────────────────────────────────────────────────────────
            // The reason sits against the button, tied to it by the tighter
            // spacing, rather than arriving in a snackbar after a tap that did
            // nothing. A disabled Start with nothing beside it is the exact
            // defect `problem` exists to prevent.
            //
            // `problem` first, because a draft the server would refuse is a
            // better thing to say than whatever it refused last time.
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                val reason = problem ?: state.error
                if (reason != null) {
                    Text(reason, style = ZipperTheme.type.caption, color = c.statusDanger)
                }
                ZipperButton(
                    text = "Start the room",
                    // Clear first: a retry that still shows the last refusal under
                    // a spinner reads as the same failure happening again.
                    onClick = { viewModel.clearError(); viewModel.createRoom() },
                    gradient = true,
                    fullWidth = true,
                    size = ButtonSize.Medium,
                    enabled = problem == null,
                    loading = state.creating,
                )
            }
        }
    }
}

// ── Getting into a private room ──────────────────────────────────────────────

/**
 * Open a room by its id.
 *
 * The only way into a private room from inside the app. `activeRoomsFlow` filters
 * `visibility == public` in the query, so a private room is not merely far down
 * the list — it is not in the result at all, and no amount of scrolling will
 * produce it. Somebody who has been handed an id needs somewhere to put it.
 *
 * The four digits are deliberately NOT collected here. `joinPartyRoom` is what
 * checks them and the room screen's password gate is what asks — a second prompt
 * on this side would be a second place to keep the wrong-code message honest,
 * and it would be guessing at a refusal it has not heard yet.
 *
 * ── TWO CHECKS, AND WHY NEITHER IS ENOUGH ALONE ──────────────────────────────
 *
 * [looksLikeRoomId] catches the damage that actually happens to an id travelling
 * through a chat app — a truncated paste, a pasted link, a copied line with a space
 * on the end — and it costs nothing, so it runs as you type and the button stays
 * off until the shape is right.
 *
 * But a well-formed id for a room that does not exist used to sail straight
 * through, and the room screen is a bad place to find out. `joinPartyRoom` calls
 * `requireLiveRoom`, which refuses a missing document with exactly the same
 * `not-found` as a closed one, and PartyRoomViewModel matches that refusal to the
 * Ended gate. So a single mistyped character produced a spinner, then a terminal
 * card reading "the host ended the party" about a party that was never held, then a
 * trip back to this list to start again.
 *
 * So the tap looks the room up first, through [findRoom], and says "no room with
 * that id" while the field is still on screen with the id in it. It is a single
 * document read on a deliberate tap, which is the cheapest place in this flow to
 * spend one.
 *
 * [findRoom] is `suspend`, and a composable cannot call one — hence the
 * `rememberCoroutineScope` below rather than a LaunchedEffect: the lookup belongs to
 * a tap, and a LaunchedEffect keyed on something that changes as you type would fire
 * a read per keystroke.
 */
@Composable
private fun OpenPrivateRoomSheet(
    findRoom: suspend (String) -> PartyRoom?,
    onOpen: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = ZipperTheme.colors
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var looking by remember { mutableStateOf(false) }
    // The id a lookup came back empty for, not a bare "not found" flag. "No such
    // room" is an answer ABOUT an id, so holding the id is what keeps it honest: the
    // message shows only while the field still contains that exact string, editing a
    // character clears it with no extra bookkeeping, and a slow lookup that lands
    // after the field has moved on cannot refuse an id nobody has checked.
    var missingId by remember { mutableStateOf<String?>(null) }
    // Whitespace is stripped rather than refused: an id travels here through chat
    // apps that hand back a trailing space on a long-press copy, and a paste that
    // quietly works beats an error about a character nobody can see.
    val roomId = typed.filter { !it.isWhitespace() }
    val wellFormed = looksLikeRoomId(roomId)
    val missing = roomId.isNotEmpty() && roomId == missingId

    PartySheetFrame("Open a private room", onDismiss) {
        Column(
            Modifier.fillMaxWidth().imePadding()
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            FormHint(
                "A private room is never in the list. Paste the id its host sent you — the room asks for the four " +
                    "digits itself once it opens."
            )
            FormField(
                value = typed,
                // Room for more than an id fits, on purpose. The cap refuses the
                // whole edit rather than trimming it, so a field capped at twenty
                // would swallow a pasted link and leave an empty box with nothing
                // to explain it — where a paste that lands gets an answer.
                placeholder = "Room id",
                maxChars = 120,
                singleLine = true,
                showCount = false,
                // A document id is case-sensitive, and a keyboard that helpfully
                // capitalises the first letter of what it takes for a sentence
                // would break one pasted-then-edited id in fifty-two, with
                // nothing on screen to explain which character went wrong.
                capitalization = KeyboardCapitalization.None,
                onValue = { typed = it },
            )
            if (roomId.isNotEmpty() && !wellFormed) {
                Text(
                    "That is not a room id — they are $ROOM_ID_LENGTH letters and numbers, nothing else.",
                    style = ZipperTheme.type.caption, color = c.statusDanger,
                )
            } else if (missing) {
                // The shape was right and the room is not there. Said here, against the
                // field that still holds the id, rather than two screens away as "the
                // host ended the party".
                Text(
                    "No room with that id. Check it against what you were sent — one wrong " +
                        "character is enough, and a room that has closed is gone for good.",
                    style = ZipperTheme.type.caption, color = c.statusDanger,
                )
            }
            ZipperButton(
                text = if (looking) "Looking…" else "Open the room",
                onClick = {
                    // Pinned at tap time, so the answer is matched against the id that
                    // was actually looked up rather than whatever the field holds by
                    // the time the read comes back.
                    val id = roomId
                    missingId = null
                    looking = true
                    scope.launch {
                        val room = findRoom(id)
                        looking = false
                        // On a miss the sheet stays exactly where it is with the id
                        // still in the field, ready to be corrected. `onOpen` is what
                        // closes it, so nothing after that branch runs.
                        if (room == null) {
                            missingId = id
                        } else {
                            onOpen(id)
                        }
                    }
                },
                gradient = true,
                fullWidth = true,
                size = ButtonSize.Medium,
                enabled = wellFormed,
                loading = looking,
            )
        }
    }
}

/**
 * Twenty characters of letters and digits — a Firestore auto-id.
 *
 * `createPartyRoom` makes every room with `collection('partyRooms').add(...)`,
 * so this is the shape of every room id in the product. Worth checking before
 * navigating: the room screen's answer to an id that does not exist is an
 * indefinite spinner, which tells somebody who mistyped one character nothing
 * at all about what they did.
 */
private const val ROOM_ID_LENGTH = 20

private fun looksLikeRoomId(id: String): Boolean =
    id.length == ROOM_ID_LENGTH &&
        id.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }

// ── Form pieces ──────────────────────────────────────────────────────────────

@Composable
private fun FormLabel(text: String) {
    Text(text, style = ZipperTheme.type.labelS, color = ZipperTheme.colors.textSecondary)
}

/** The line under a control that says what it will do. Never a restatement of the label. */
@Composable
private fun FormHint(text: String) {
    Text(text, style = ZipperTheme.type.caption, color = ZipperTheme.colors.textMuted)
}

/**
 * One of a small fixed set of choices — seat counts, seat modes, visibility.
 *
 * A pill rather than a dropdown because every one of these has two or three
 * options and all of them fit on a line; a picker that hides half the options
 * behind a tap is a picker nobody discovers.
 *
 * Deliberately the same control as `ChoicePill` in PartyRoomSheets.kt, which is
 * private to that file: a setting chosen before the room exists and the same
 * setting changed afterwards should not look like two different products. If one
 * of the two moves, move the other.
 */
@Composable
private fun FormPill(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Box(
        Modifier.height(34.dp)
            .then(
                if (selected) Modifier.background(c.tintBrandMedium, CircleShape).border(1.dp, c.brandPrimary, CircleShape)
                else Modifier.background(c.glassLow, CircleShape).border(1.dp, c.borderSubtle, CircleShape)
            )
            .clickableNoRipple(onClick)
            .padding(horizontal = Space.lg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, style = ZipperTheme.type.labelS,
            color = if (selected) c.textPrimary else c.textSecondary,
            maxLines = 1,
        )
    }
}

@Composable
private fun FormField(
    value: String,
    placeholder: String,
    maxChars: Int,
    singleLine: Boolean,
    showCount: Boolean,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
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
            // Capped here as well as in the draft's setter. Letting somebody type
            // three hundred characters and silently keeping 250 is a worse
            // surprise than the field simply stopping, and it is what keeps the
            // counter from showing a number the server would refuse.
            onValueChange = { if (it.length <= maxChars) onValue(it) },
            singleLine = singleLine,
            maxLines = if (singleLine) 1 else 4,
            textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.brandPrimary),
            keyboardOptions = KeyboardOptions(
                capitalization = capitalization,
                imeAction = if (singleLine) ImeAction.Done else ImeAction.Default,
            ),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(
                        placeholder, style = ZipperTheme.type.bodyM, color = c.textMuted,
                        maxLines = if (singleLine) 1 else 2, overflow = TextOverflow.Ellipsis,
                    )
                }
                inner()
            },
        )
        if (showCount) {
            Text("${value.length}/$maxChars", style = ZipperTheme.type.caption, color = c.textMuted)
        }
    }
}

/**
 * What the server will call the room if the name is left empty.
 *
 * Mirrors `createPartyRoom`: the FIRST word of the display name and not the
 * whole thing, because a four-word name in a room title truncates in the list to
 * something unreadable. Shown as the placeholder so that "optional" is a
 * concrete offer rather than "we will think of something".
 */
private fun defaultRoomTitle(name: String?): String {
    val first = name?.trim()?.split(' ', '\t', '\n')?.firstOrNull { it.isNotBlank() }.orEmpty()
    return if (first.isEmpty()) "Your room" else "${first}'s room"
}
