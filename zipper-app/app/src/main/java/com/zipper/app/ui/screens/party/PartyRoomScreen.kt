package com.zipper.app.ui.screens.party

import android.Manifest
import android.app.Activity
import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Groups
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.rememberMultiplePermissionsState
import com.zipper.app.data.model.LiveGiftEvent
import com.zipper.app.data.model.PartyRoom
import com.zipper.app.data.model.PartySeat
import com.zipper.app.data.repository.PartyGiftEvent
import com.zipper.app.data.repository.PartyListener
import com.zipper.app.data.repository.PartyMessage
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.live.AgoraManager
import com.zipper.app.ui.screens.live.GiftAnimationOverlay
import com.zipper.app.ui.screens.live.GlassChip
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Party room.
 *
 * One screen, two shapes. An audio room is ten or fifteen avatars in a grid; a
 * video room is six or ten tiles and is about as much as a budget phone will
 * composite. Everything below the seats — chat, gifts, the mic button, the
 * moderator's controls — is shared, because it is the same room either way.
 *
 * ── THE OWNER SITS ON AN ORDINARY SEAT ───────────────────────────────────────
 *
 * There is no host slot here any more, and nothing in this file knows where the
 * owner is sitting. Seats are 1..seatCount, every one of them starts empty, and
 * the owner takes one by tapping it like anybody else. `state.isOwner` still
 * decides what somebody is ALLOWED to do; it no longer decides who is drawn
 * where or who publishes. That single change removed the "find the host's video
 * by elimination" code, the owner-only mute state that lived in one phone's
 * memory, and the seat the owner could never stand up from.
 *
 * ── WHAT ANIMATES, AND WHAT DELIBERATELY DOES NOT ────────────────────────────
 *
 * This file used to say "nothing here animates". Three things do now, and each
 * is bounded on purpose:
 *
 *   · a gift, once per gift, keyed on the gift's document id so a redelivered
 *     snapshot cannot replay it;
 *   · an arrival's entrance effect, ONE at a time — extra arrivals are dropped
 *     rather than queued, because forty people joining at the top of the hour
 *     must cost one animation and not forty;
 *   · the ring on a speaking seat, which is still a border that is on or off
 *     rather than a pulse. Fifteen pulsing rings on a ₹8,000 phone that is also
 *     mixing fifteen Opus streams is a frame budget spent on decoration.
 *
 * ── PERMISSION ───────────────────────────────────────────────────────────────
 *
 * The room asks for NOTHING to enter. A listener needs no microphone, and most
 * of a party room is listeners. The microphone (and, in a video room, the
 * camera) is asked for at the one moment it matters: taking a seat, or accepting
 * an invitation to one. See [PartyRoomViewModel.takeSeat], which documents what
 * happens when a seat publishes silence.
 */

/**
 * Five across, at both seat counts.
 *
 * Ten seats is two rows of five and fifteen is three. The old grid was three
 * across, which was right for nine and is four rows for fifteen — and four rows
 * of seat cells is taller than the cap the chat needs left over, so it scrolled,
 * and a grid that scrolls hides the seats somebody is looking for. Five columns
 * costs avatar size (MD rather than LG) and buys a grid that is readable whole.
 */
private const val AUDIO_COLUMNS = 5

/** Six tiles read best three across, two rows. Ten need four, or they are four rows deep. */
private const val VIDEO_COLUMNS_FEW = 3
private const val VIDEO_COLUMNS_MANY = 4
private const val VIDEO_MANY_THRESHOLD = 6

/**
 * How stale a gift may be and still be worth animating, in millis.
 *
 * `giftsFlow` hands over the last twelve gifts, so the first snapshot after
 * joining is history — and replaying a gift that landed four minutes ago as if
 * it just arrived is worse than missing one. Compared against the device clock
 * while the timestamp comes from the server's, hence the generous window: the
 * failure modes are a skipped animation or a repeated one, and neither costs
 * anybody money.
 */
private const val GIFT_FRESH_WINDOW_MS = 15_000L

/**
 * One gift tap, and the nonce that makes it idempotent.
 *
 * ── WHY THE SCREEN HOLDS THIS AND NOT THE VIEWMODEL ──────────────────────────
 *
 * `sendGift` builds its idempotency key from this nonce. A fresh nonce is a
 * fresh key, and a fresh key on a transaction that already committed is a second
 * charge — which is exactly what used to happen, because the nonce was minted
 * inside `sendGift` under a comment claiming it was one key per tap. A dropped
 * response looks identical to a failure, the user taps again, and the second tap
 * pays again.
 *
 * So the nonce belongs to the TAP, and a tap is a thing the screen knows about:
 * the same gift, the same quantity and the same recipients means the same tap
 * retried, and gets the same nonce. Anything different is a new intent and gets
 * a new one. It is retired the moment a send is confirmed, because the next
 * identical tap is a second present and must not be deduplicated into the first.
 */
private data class GiftTap(
    val giftId: String,
    val quantity: Int,
    val recipients: Set<String>,
    val nonce: String,
)

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun PartyRoomScreen(
    // Read by the ViewModel from its SavedStateHandle, which is how it reaches
    // the repository without the screen having to pass it into every call.
    @Suppress("UNUSED_PARAMETER") roomId: String,
    onBack: () -> Unit = {},
    onRecharge: () -> Unit = {},
    onOpenProfile: (uid: String) -> Unit = {},
    /** B7: "Message" on a member's card. */
    onOpenChat: (uid: String) -> Unit = {},
    viewModel: PartyRoomViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val activity = context as? Activity
    val snackbar = remember { SnackbarHostState() }

    var showGifts by remember { mutableStateOf(false) }
    var showRoomMenu by remember { mutableStateOf(false) }
    var showMembers by remember { mutableStateOf(false) }
    var showRequests by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showExit by remember { mutableStateOf(false) }
    var seatMenuFor by remember { mutableStateOf<Int?>(null) }
    var welcomeVisible by remember { mutableStateOf(true) }

    // ── Permission, asked for a seat and never for the door ───────────────────
    //
    // The list follows the room's mode, so an audio room never asks for a camera it
    // will not open. Keyed on the mode rather than on the whole state, which is the
    // difference between one rebuild and one per snapshot: `listenerCount` changes
    // every time somebody walks in, and rebuilding the permission state several
    // times a minute would throw away any request that was in flight.
    //
    // ONE rebuild, though, and not none — the old comment here claimed otherwise.
    // `state.isVideo` is `room?.isAudio == false`, so it reads false for as long as
    // `room` is null, and a VIDEO room therefore composes once with the audio-only
    // list and flips this key the snapshot the room document lands on. There is no
    // way around that: the mode is not knowable before the document arrives.
    //
    // What makes it harmless is that there is almost nothing to lose at that
    // moment. The seat grid and the seat sheet are both behind `room != null`, so
    // there is no seat on screen to tap yet. The seat INVITATION dialog is not
    // behind it, and that is the one path where the flip can land on a live request
    // and orphan its result callback — which is exactly what the LaunchedEffect
    // below catches, off `allPermissionsGranted`, a flag the rebuilt state reports
    // just the same.
    val wanted = remember(state.isVideo) {
        if (state.isVideo) listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        else listOf(Manifest.permission.RECORD_AUDIO)
    }
    // Held as MutableState objects rather than delegated locals because the
    // permission callback below outlives the composition that created it, and
    // must read what is current rather than what was captured.
    val pendingSeat = remember { mutableIntStateOf(0) }
    val pendingInvite = remember { mutableStateOf(false) }
    val showRationale = remember { mutableStateOf(false) }

    val permissions = rememberMultiplePermissionsState(wanted) { result ->
        val granted = result.values.isNotEmpty() && result.values.all { it }
        val seat = pendingSeat.intValue
        val invite = pendingInvite.value
        pendingSeat.intValue = 0
        pendingInvite.value = false
        when {
            // Refused. The room keeps working — this only explains what the seat
            // would have needed.
            !granted -> showRationale.value = true
            seat > 0 -> viewModel.takeSeat(seat)
            invite -> viewModel.respondToInvite(true)
            else -> Unit
        }
    }

    // The same work, driven off the granted flag instead of the callback.
    //
    // A safety net rather than a duplicate: the callback above clears the pending
    // seat BEFORE it acts, so whichever of the two runs first, the other finds
    // nothing to do. Here because a permission granted from the system settings
    // screen — rather than from the dialog this screen launched — never produces a
    // result callback at all, and the seat the user tapped would otherwise stay
    // pending forever with no way to discharge it.
    LaunchedEffect(permissions.allPermissionsGranted) {
        if (!permissions.allPermissionsGranted) return@LaunchedEffect
        val seat = pendingSeat.intValue
        val invite = pendingInvite.value
        if (seat == 0 && !invite) return@LaunchedEffect
        pendingSeat.intValue = 0
        pendingInvite.value = false
        if (seat > 0) viewModel.takeSeat(seat) else viewModel.respondToInvite(true)
    }

    val takeSeatWithMic: (Int) -> Unit = { index ->
        if (permissions.allPermissionsGranted) {
            viewModel.takeSeat(index)
        } else {
            pendingSeat.intValue = index
            pendingInvite.value = false
            permissions.launchMultiplePermissionRequest()
        }
    }
    val acceptInviteWithMic: () -> Unit = {
        if (permissions.allPermissionsGranted) {
            viewModel.respondToInvite(true)
        } else {
            pendingSeat.intValue = 0
            pendingInvite.value = true
            permissions.launchMultiplePermissionRequest()
        }
    }

    // ── Entering, and the two message channels ───────────────────────────────
    //
    // `enterRoom` is the gate: it is what writes the listener row, checks a
    // private room's code and refuses somebody who has been removed. Only once it
    // has said yes does the ViewModel ask for an Agora token. Called once here;
    // it guards its own re-entry as well, because a LaunchedEffect is only
    // once-per-key and a key can come back.
    LaunchedEffect(Unit) { viewModel.enterRoom(context) }
    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it); viewModel.clearError() }
    }
    LaunchedEffect(state.notice) {
        state.notice?.let { snackbar.showSnackbar(it); viewModel.clearNotice() }
    }

    // ── Picture-in-picture ───────────────────────────────────────────────────
    //
    // The system owns the mode; the ViewModel only mirrors it so the layout can
    // strip itself down. Watched on RESUME and PAUSE, which is where the mode
    // change is observable — there is no callback for it on a Composable.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME || event == Lifecycle.Event.ON_PAUSE) {
                viewModel.setPip(
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                        activity?.isInPictureInPictureMode == true
                )
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val canPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity != null
    val enterPip: () -> Unit = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Square for an audio room, because what PiP shows is a grid of faces;
            // portrait for video, to match the tiles.
            val ratio = if (state.isVideo) Rational(3, 4) else Rational(1, 1)
            activity?.enterPictureInPictureMode(
                PictureInPictureParams.Builder().setAspectRatio(ratio).build()
            )
        }
    }

    // Leaving is the ViewModel's job and runs exactly once. Doing it from the
    // screen as well is what pushed the live room's viewer count negative — one
    // join answered by three leaves — and here it would call `leavePartySeat` on
    // a seat somebody else may already have taken.
    val exit: () -> Unit = { viewModel.leave(); onBack() }

    // ── Hardware back ────────────────────────────────────────────────────────
    //
    // Back asks the same question the close button asks, because it is the same
    // decision. Without this it popped the screen directly, which skipped both of
    // the things leaving a room actually means: `viewModel.leave()` — the seat stayed
    // occupied and the channel stayed joined until `onCleared` caught up — and any
    // chance of picture-in-picture, which is the answer most people want and was
    // reachable only from a button in the corner.
    //
    // Deliberately OFF in both terminal states. A kicked or ended room has already
    // released Agora and marked the session left; there is nothing to minimise and
    // no seat to stand up from, so back falls through to the navigator and does what
    // the terminal card's own button does. A dialog there would put a decision
    // between somebody and the only way out of a room that is already over.
    BackHandler(enabled = state.gate == PartyGate.None || state.gate == PartyGate.Password) {
        // The password gate and the beat before the room document lands are the same
        // case: nothing to minimise, nobody sitting down. Straight out, which is
        // what the gate card's own Back button does.
        if (state.gate == PartyGate.Password || state.room == null) {
            exit()
        } else {
            showExit = true
        }
    }

    val chatState = rememberLazyListState()
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) chatState.animateScrollToItem(state.messages.size - 1)
    }

    // ── Video surfaces ───────────────────────────────────────────────────────
    //
    // One SurfaceView per seat index, created ON DEMAND and then kept for the
    // life of the screen. Two things this fixes at once: the old grid allocated
    // one per seat up front and then clamped the grid to what it had allocated,
    // which at ten seats is ten surfaces a six-person room never uses; and a
    // SurfaceView built inside a composable is rebuilt on every recomposition,
    // which mid-room is a black flash and a fresh surface handshake. A plain map
    // rather than snapshot state because it is a cache and not something anything
    // should recompose on.
    val surfaces = remember { mutableMapOf<Int, SurfaceView>() }

    // ── Gift animations ──────────────────────────────────────────────────────
    val openedAt = remember { System.currentTimeMillis() }
    var animatedGiftId by remember { mutableStateOf("") }
    val newestGift = state.recentGifts.firstOrNull()
    val giftToAnimate = newestGift?.takeIf {
        it.id != animatedGiftId && it.timestamp >= openedAt - GIFT_FRESH_WINDOW_MS
    }
    // B7: the same gift also flies from the sender's seat to the receiver's (server-written receiver only).
    var travelledGiftId by remember { mutableStateOf("") }
    val giftToFly = newestGift?.takeIf {
        it.id != travelledGiftId && it.receiverUid.isNotBlank() && it.timestamp >= openedAt - GIFT_FRESH_WINDOW_MS
    }

    // ── Entrance effects, one slot ───────────────────────────────────────────
    //
    // No URL cache here any more. `joinPartyRoom` resolves the cosmetic on the way
    // in and writes the URLs onto the listener row, so the overlay has everything it
    // needs in the snapshot it is handed — see [PartyEntranceOverlay].
    var knownListeners by remember { mutableStateOf<Set<String>?>(null) }
    var entrance by remember { mutableStateOf<PartyListener?>(null) }
    LaunchedEffect(state.listeners) {
        val ids = state.listeners.map { it.uid }.toSet()
        val before = knownListeners
        knownListeners = ids
        // The first snapshot is the room as we found it, not forty arrivals.
        if (before == null) return@LaunchedEffect
        // The slot is full: this arrival gets no animation at all rather than a
        // place in a queue that would still be draining in four minutes.
        if (entrance != null) return@LaunchedEffect
        val arrival = state.listeners.lastOrNull {
            it.uid !in before && it.uid != state.myUid && it.entranceItemId.isNotBlank()
        }
        if (arrival != null) entrance = arrival
    }

    // ── Gift recipients ──────────────────────────────────────────────────────
    val recipients = state.giftableSeatHolders.map { GiftRecipient(it.uid, it.name, it.photoUrl) }
    val recipientIds = recipients.map { it.id }.toSet()
    var giftPicks by remember { mutableStateOf<Set<String>>(emptySet()) }
    var giftPicksSeeded by remember { mutableStateOf(false) }
    LaunchedEffect(showGifts) { if (!showGifts) giftPicksSeeded = false }
    LaunchedEffect(showGifts, recipientIds) {
        // Defaults to EVERYONE on a seat. Seeded once per opening, so somebody
        // sitting down mid-choice does not silently join the bill.
        if (showGifts && !giftPicksSeeded && recipientIds.isNotEmpty()) {
            giftPicks = recipientIds
            giftPicksSeeded = true
        }
    }
    // Anybody who has stood up since the selection was made is dropped: one stale
    // uid would have `sendGift` refuse the whole tap.
    val livePicks = giftPicks.intersect(recipientIds)

    var giftTap by remember { mutableStateOf<GiftTap?>(null) }
    LaunchedEffect(state.lastGiftResult) {
        val result = state.lastGiftResult ?: return@LaunchedEffect
        /*
         * A finished tap, STATED by the ViewModel rather than deduced here.
         *
         * This used to watch the `giftSending` true→false edge and read `state.error`
         * to decide how the send had gone. That inference was wrong in a way that
         * cost people presents: an error from something else entirely can still be on
         * screen when a gift lands, because the snackbar that shows it suspends for
         * seconds before `clearError()` runs. A perfectly successful gift therefore
         * read as a failure — the drawer stayed open, this nonce was never retired,
         * and the next tap of the same gift to the same people reused it. `settleGift`
         * recognised the key, correctly treated it as a replay, and delivered nothing
         * while charging nothing. A present that silently never arrives is the worst
         * thing this screen can do, so the signal is read rather than guessed at.
         *
         * `delivered > 0` is the condition, NOT `allDelivered`. A PARTIAL send has
         * already charged for everybody it reached, which spends the nonce: keeping it
         * would let a retry re-send to those people under a replayed key — nothing
         * delivered and nothing refunded — and minting a fresh one would charge them
         * twice. Either way the honest move is to close the drawer and let the notice
         * `sendGift` posted say "three of four".
         *
         * Nothing delivered at all is the one case that keeps the drawer open with its
         * nonce intact. That IS the retry this whole scheme exists for, and a retry
         * has to carry the same key.
         */
        if (result.delivered > 0) {
            // Only if it is still the tap this result belongs to. A result for an
            // older tap must not retire a newer tap's nonce out from under it.
            if (giftTap?.nonce == result.nonce) giftTap = null
            showGifts = false
        }
        viewModel.clearGiftResult()
    }

    val room = state.room

    // B7: the room's own background; seat positions for gift travel are forgotten when the room closes.
    DisposableEffect(Unit) { onDispose { PartySeatCentres.centres.clear() } }
    Box(Modifier.fillMaxSize().background(c.bgBase).background(roomThemeBrush(room?.theme))) {
        when {
            // A private room we have not been let into yet. The room document is
            // readable, so the card can say whose room it is.
            state.gate == PartyGate.Password -> PasswordGate(
                room = room,
                error = state.passwordError,
                joining = state.joining,
                onSubmit = { code -> viewModel.enterRoom(context, code) },
                onBack = exit,
                onOfficial = if (state.officialAllowed) ({ viewModel.enterAsOfficial(context) }) else null,
            )

            room == null -> LoadingState()

            // Stripped down to who is talking. PiP deliberately does not carry the
            // video grid: ten tiles at PiP size is unreadable, and binding them
            // would cost a second surface per seat for a window the size of a
            // matchbox. The audio never stopped, which is the point.
            state.inPip -> PipLayout(state)

            else -> Column(Modifier.fillMaxSize().statusBarsPadding()) {
                RoomHeader(
                    state = state,
                    onOpenOwner = { onOpenProfile(room.hostUid) },
                    onMembers = { showMembers = true },
                    onRequests = { showRequests = true },
                    onMenu = { showRoomMenu = true },
                    onClose = { showExit = true },
                )

                // Capped, and scrolling inside the cap. Without a ceiling the seat
                // grid takes whatever it wants from a Column and the chat below it
                // gets what is left — which on a short screen is nothing, and the
                // chat is half of why anybody is in the room.
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = if (room.isAudio) Size.Media.lg else Size.Media.xl)
                        .verticalScroll(rememberScrollState())
                        .padding(start = Space.md, end = Space.md, top = Space.xs, bottom = Space.xs),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    if (room.isAudio) {
                        AudioSeatGrid(
                            state = state,
                            onSeatTap = { index ->
                                onSeatTapped(index, state, viewModel, takeSeatWithMic, onOpenProfile) {
                                    seatMenuFor = it
                                }
                            },
                            onToggleLock = viewModel::toggleSeatLock,
                        )
                    } else {
                        VideoSeatGrid(
                            state = state,
                            surfaces = surfaces,
                            onSeatTap = { index ->
                                onSeatTapped(index, state, viewModel, takeSeatWithMic, onOpenProfile) {
                                    seatMenuFor = it
                                }
                            },
                            onToggleLock = viewModel::toggleSeatLock,
                        )
                    }
                }

                if (state.myRequestedSeat > 0) {
                    PendingRequestStrip(
                        seatIndex = state.myRequestedSeat,
                        onCancel = viewModel::cancelMySeatRequest,
                    )
                }

                // The welcome message, pinned above the chat rather than posted
                // into it. As a chat line it would be indistinguishable from
                // something a person typed, and it would scroll away within a
                // dozen messages — this is the line the room's owner wrote for
                // everybody who walks in, so it stays until it is dismissed.
                if (welcomeVisible && room.welcomeMessage.isNotBlank()) {
                    WelcomeCard(room.welcomeMessage) { welcomeVisible = false }
                }

                HairlineDivider()

                LazyColumn(
                    state = chatState,
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = PaddingValues(
                        start = Space.md, end = Space.md, top = Space.sm, bottom = Space.sm,
                    ),
                    verticalArrangement = Arrangement.spacedBy(Space.xs),
                ) {
                    items(state.messages, key = { it.id }, contentType = { "partyMessage" }) { m ->
                        ChatLine(m) { onOpenProfile(m.senderUid) }
                    }
                }

                // The ticker: the last gift, as a line of text. Cheap, and it is
                // what remains on screen after the animation has gone.
                newestGift?.let { g ->
                    Box(Modifier.padding(horizontal = Space.md, vertical = Space.xxs)) {
                        GiftEventPill(
                            g.senderName.ifBlank { "Someone" }, g.giftName, g.quantity,
                            g.senderPhotoUrl.ifBlank { null },
                        )
                    }
                }

                ComposerBar(
                    state = state,
                    onInput = viewModel::onMessageInput,
                    onSend = viewModel::sendMessage,
                    onToggleMic = viewModel::toggleMyMic,
                    onToggleCamera = viewModel::toggleMyCamera,
                    onGift = { showGifts = true },
                )
            }
        }

        // One gift at a time, keyed on the document id. `giftsFlow` redelivers its
        // whole window on any change, so without the id the same gift would
        // animate again every time a later one landed.
        if (!state.inPip) {
            giftToFly?.let { g ->
                GiftTravelOverlay(
                    gift = g,
                    seatOfUid = { uid -> state.seatByIndex.entries.firstOrNull { it.value.uid == uid }?.key },
                    centres = PartySeatCentres.centres,
                    onFinished = { travelledGiftId = g.id },
                )
            }
            giftToAnimate?.let { g ->
                GiftAnimationOverlay(
                    giftEvent = g.asLiveGiftEvent(),
                    onDismiss = { animatedGiftId = g.id },
                )
            }
            entrance?.let { arrival ->
                PartyEntranceOverlay(
                    listener = arrival,
                    onFinished = { entrance = null },
                )
            }
        }

        // A kick outranks everything else on screen, including the room ending.
        // Both are terminal for the life of the room: the ViewModel has already
        // released Agora and marked the session left, so the only thing left to do
        // here is say why and get out.
        //
        // BEFORE the snackbar host, and that ordering is the fix for a real defect:
        // children of a Box are drawn in declaration order, so this full-screen scrim
        // used to be painted OVER the snackbar. The two messages most worth reading
        // arrive at exactly this moment — why the room ended, why an action failed —
        // and they were landing underneath the card that replaced the room.
        when (state.gate) {
            PartyGate.Kicked -> TerminalOverlay(
                photoUrl = room?.hostPhotoUrl,
                name = room?.hostName ?: "The host",
                title = "Removed from this room",
                body = "A moderator removed you. You cannot rejoin this room, but their " +
                    "other rooms are still open to you.",
                onExit = exit,
            )
            PartyGate.Ended -> TerminalOverlay(
                photoUrl = room?.hostPhotoUrl,
                name = room?.hostName ?: "The host",
                title = "This room has closed",
                // The owner who just pressed "End room" sees this card too, and
                // "QA User One ended the party" read to them as if someone else had.
                body = if (room != null && room.hostUid.isNotBlank() && room.hostUid == state.myUid) {
                    "You ended the party. Start another whenever you like."
                } else {
                    "${room?.hostName ?: "The host"} ended the party. Have a look at what " +
                        "else is open."
                },
                onExit = exit,
            )
            PartyGate.None, PartyGate.Password -> Unit
        }

        // Spec §11: the server's lucky roll, celebrated for a few seconds.
        state.luckyWin?.let { win ->
            LaunchedEffect(win) { kotlinx.coroutines.delay(4_000); viewModel.clearLuckyWin() }
            LuckyWinBanner(win, Modifier.align(Alignment.Center).padding(Space.xl))
        }

        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = Space.x7l),
        ) { data ->
            Snackbar(snackbarData = data, containerColor = c.bgElevated, contentColor = c.textPrimary)
        }
    }

    // ── Sheets and dialogs ───────────────────────────────────────────────────

    if (showGifts && room != null) {
        if (recipients.isEmpty()) {
            // Nobody but me is on a seat. There is no one to send to, and an empty
            // drawer that charges for nothing is worse than no drawer.
            LaunchedEffect(Unit) { showGifts = false }
        } else {
            GiftDrawer(
                gifts = state.gifts,
                balanceDiamonds = state.myDiamonds,
                recipientName = recipients.first().name,
                recipientPhotoUrl = recipients.first().photoUrl,
                sending = state.giftSending,
                recipients = recipients,
                multiSelect = true,
                selectedRecipientIds = livePicks,
                onToggleRecipient = { r ->
                    giftPicks = if (r.id in livePicks) livePicks - r.id else livePicks + r.id
                },
                onSelectEveryone = { giftPicks = recipientIds },
                onSend = { gift, qty ->
                    val picks = livePicks
                    val prior = giftTap
                    // The same tap retried keeps its nonce; anything else is a new
                    // intent and gets a new one.
                    val nonce = if (
                        prior != null &&
                        prior.giftId == gift.id &&
                        prior.quantity == qty &&
                        prior.recipients == picks
                    ) prior.nonce else viewModel.newGiftTapNonce()
                    giftTap = GiftTap(gift.id, qty, picks, nonce)
                    viewModel.sendGift(gift, qty, picks.toList(), nonce)
                },
                onRecharge = { showGifts = false; onRecharge() },
                onDismiss = { showGifts = false },
            )
        }
    }

    if (showRoomMenu && room != null) {
        PartyRoomMenuSheet(
            state = state,
            viewModel = viewModel,
            onMembers = { showMembers = true },
            onRequests = { showRequests = true },
            onSettings = { showSettings = true },
            onDismiss = { showRoomMenu = false },
        )
    }

    if (showMembers && room != null) {
        PartyMembersSheet(
            state = state,
            viewModel = viewModel,
            onOpenProfile = onOpenProfile,
            onDismiss = { showMembers = false },
            onOpenChat = onOpenChat,
            onGift = { showGifts = true },
        )
    }

    if (showRequests && room != null) {
        PartySeatRequestsSheet(
            state = state,
            viewModel = viewModel,
            onOpenProfile = onOpenProfile,
            onDismiss = { showRequests = false },
        )
    }

    if (showSettings && state.isOwner) {
        PartyRoomSettingsSheet(
            state = state,
            viewModel = viewModel,
            onDismiss = { showSettings = false },
        )
    }

    seatMenuFor?.let { index ->
        if (room != null) {
            PartySeatMenuSheet(
                index = index,
                state = state,
                viewModel = viewModel,
                onSit = takeSeatWithMic,
                onOpenProfile = onOpenProfile,
                onDismiss = { seatMenuFor = null },
            )
        }
    }

    // An invitation is answered, not dismissed, so it outranks the sheets. Not
    // shown once the room is terminal — a seat in a closed room is not an offer.
    if (state.gate == PartyGate.None && !state.inPip) {
        state.myInvite?.let { invite ->
            PartySeatInviteDialog(
                invite = invite,
                onAccept = acceptInviteWithMic,
                onDecline = { viewModel.respondToInvite(false) },
            )
        }
    }

    if (showRationale.value) {
        PartyMicRationaleDialog(
            video = state.isVideo,
            onAllow = {
                showRationale.value = false
                permissions.launchMultiplePermissionRequest()
            },
            onDismiss = { showRationale.value = false },
        )
    }

    if (showExit) {
        PartyExitDialog(
            canPip = canPip,
            isOwner = state.isOwner,
            onPip = { showExit = false; enterPip() },
            onLeave = { showExit = false; exit() },
            onDismiss = { showExit = false },
        )
    }
}

/**
 * What a tap on a seat means.
 *
 * Hoisted out of both grids so an audio seat and a video tile cannot disagree
 * about it — they did before, in two copies of the same `when`.
 */
private fun onSeatTapped(
    index: Int,
    state: PartyRoomUiState,
    viewModel: PartyRoomViewModel,
    takeSeatWithMic: (Int) -> Unit,
    onOpenProfile: (String) -> Unit,
    openSeatMenu: (Int) -> Unit,
) {
    val seat = state.seatByIndex[index]
    val locked = state.room?.lockedSeats?.contains(index) == true
    when {
        // My own seat: one tap to stand up. The seat menu reaches the same thing
        // for anybody who wants to think about it first.
        seat != null && seat.uid == state.myUid -> viewModel.leaveMySeat()
        // Somebody else's: what I may do to them depends on what I am, and the
        // sheet is where that is decided.
        seat != null && state.canModerate -> openSeatMenu(index)
        seat != null -> onOpenProfile(seat.uid)
        // A locked seat is inert for a member. A moderator unlocks it from the
        // padlock on the disc, which is a control and not a seat.
        locked -> Unit
        // Already asked for this one — tapping again would be a second request
        // the server refuses.
        state.myRequestedSeat == index -> viewModel.cancelMySeatRequest()
        else -> takeSeatWithMic(index)
    }
}

// ── Header ───────────────────────────────────────────────────────────────────

@Composable
private fun RoomHeader(
    state: PartyRoomUiState,
    onOpenOwner: () -> Unit,
    onMembers: () -> Unit,
    onRequests: () -> Unit,
    onMenu: () -> Unit,
    onClose: () -> Unit,
) {
    val c = ZipperTheme.colors
    val room = state.room ?: return
    Row(
        Modifier.fillMaxWidth().height(Size.Bar.top).padding(start = Space.md, end = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Avatar(
            room.hostPhotoUrl, size = AvatarSize.SM, initial = room.hostName,
            modifier = Modifier.clickableNoRipple(onOpenOwner),
        )
        Column(Modifier.weight(1f)) {
            Text(
                room.title.ifBlank { "${room.hostName}'s room" },
                style = ZipperTheme.type.labelM, color = c.textPrimary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.xxs),
            ) {
                if (room.isPrivate) {
                    Icon(
                        Icons.Default.Lock, "Private room", tint = c.textMuted,
                        modifier = Modifier.size(Size.Icon.xs),
                    )
                }
                Text(
                    room.hostName, style = ZipperTheme.type.caption, color = c.textSecondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                // B7: what is playing, for everyone in the room.
                room.music?.let { m ->
                    Text("· ♫ ${m.title}", style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                // B7: an official who came in without the PIN is never a silent visitor.
                if (room.officialPresentUids.isNotEmpty()) {
                    Text(
                        "· Zipper official present", style = ZipperTheme.type.caption, color = c.statusWarning,
                        maxLines = 1,
                    )
                }
            }
        }
        // Somebody is waiting for a seat. Only a moderator can do anything about
        // it, so only a moderator is told.
        if (state.canModerate && state.seatRequests.isNotEmpty()) {
            Box(Modifier.clickableNoRipple(onRequests)) {
                GlassChip(Icons.Outlined.Groups, state.seatRequests.size.toString())
            }
        }
        // The presence collection, never `room.listenerCount`: this chip opens the
        // list it counts, and the two must not disagree.
        Box(Modifier.clickableNoRipple(onMembers)) {
            GlassChip(Icons.Outlined.People, compactCount(state.memberList.size.toLong()))
        }
        IconButtonCircle(
            Icons.Default.MoreVert, "Room options", onMenu,
            size = Size.Control.sm, background = Color.Transparent,
        )
        IconButtonCircle(
            Icons.Default.Close, "Minimise or leave", onClose,
            size = Size.Control.sm, background = Color.Transparent,
        )
    }
}

// ── Audio seats ──────────────────────────────────────────────────────────────

@Composable
private fun AudioSeatGrid(
    state: PartyRoomUiState,
    onSeatTap: (Int) -> Unit,
    onToggleLock: (Int) -> Unit,
) {
    // 1..seatCount. There is no seat 0 any more; the owner is somewhere in here
    // like everybody else.
    (1..state.seatCount).chunked(AUDIO_COLUMNS).forEach { row ->
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Space.xs),
        ) {
            row.forEach { index ->
                Box(Modifier.weight(1f)) {
                    AudioSeat(index, state, onSeatTap, onToggleLock)
                }
            }
            // Keep a short last row's columns the same width as the others.
            repeat(AUDIO_COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun AudioSeat(
    index: Int,
    state: PartyRoomUiState,
    onSeatTap: (Int) -> Unit,
    onToggleLock: (Int) -> Unit,
) {
    val room = state.room ?: return
    val seat = state.seatByIndex[index]
    val locked = room.lockedSeats.contains(index)
    val mine = seat != null && seat.uid == state.myUid
    val waiting = state.myRequestedSeat == index
    val speaking = isSpeaking(seat, state)

    Column(
        Modifier.fillMaxWidth()
            .recordSeatCentre(PartySeatCentres.centres, index)
            .clickableNoRipple { onSeatTap(index) }
            .padding(vertical = Space.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xxs),
    ) {
        // 12dp wider than the disc, so the corner badges (lock toggle, role, mute)
        // sit on the disc's edge. Wrapped tight, the 28dp lock toggle covered the
        // top-right of a 44dp disc — including its centre — so it cut the "+" down
        // to a stray "¬" on every empty seat, and an owner tapping the middle of a
        // seat to sit on it LOCKED it instead (QA emulator run, 3 Nov 2026).
        Box(Modifier.size(Size.Avatar.md + 12.dp), contentAlignment = Alignment.Center) {
            if (seat != null) {
                Avatar(
                    seat.photoUrl,
                    size = AvatarSize.MD,
                    // The ring is the speaking indicator, and an Agora uid is now
                    // a seat index — so the ring lights on the seat that is
                    // actually talking rather than on whoever the old
                    // find-the-host-by-elimination code guessed.
                    ring = if (speaking) AvatarRing.Online else AvatarRing.None,
                    initial = seat.name,
                )
                SeatMuteBadge(seat, Modifier.align(Alignment.BottomEnd))
                SeatRoleBadge(room, seat.uid, Modifier.align(Alignment.TopEnd))
            } else {
                EmptySeatDisc(
                    diameter = Size.Avatar.md,
                    locked = locked,
                    busy = state.busySeat == index,
                    waiting = waiting,
                )
                if (state.canModerate) {
                    // 22dp in the 56dp box's corner: clear of the seat's centre by
                    // 6dp — but only if Compose does not quietly grow its touch
                    // area to the 48dp minimum, which reaches back over the middle
                    // of the seat and turned "sit here" taps into "lock this seat"
                    // (QA, 3 Nov 2026). So the toggle keeps exactly its own bounds;
                    // the whole seat is the primary target, this is the secondary.
                    ExactTouchBounds {
                        SeatLockToggle(locked, Modifier.align(Alignment.TopEnd), size = 22.dp) { onToggleLock(index) }
                    }
                }
            }
        }
        Text(
            seatCaption(index, seat, locked, waiting, mine),
            style = ZipperTheme.type.caption,
            color = seatCaptionColor(room, seat),
            maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
        )
    }
}

// ── Video seats ──────────────────────────────────────────────────────────────

/**
 * Six tiles three across, ten tiles four across, portrait either way.
 *
 * Ten at three across is four rows, which is deeper than the cap the chat needs
 * left over; at four across it is three. Portrait because a tile holds a face.
 */
@Composable
private fun VideoSeatGrid(
    state: PartyRoomUiState,
    surfaces: MutableMap<Int, SurfaceView>,
    onSeatTap: (Int) -> Unit,
    onToggleLock: (Int) -> Unit,
) {
    val context = LocalContext.current
    val columns = if (state.seatCount > VIDEO_MANY_THRESHOLD) VIDEO_COLUMNS_MANY else VIDEO_COLUMNS_FEW
    (1..state.seatCount).chunked(columns).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            row.forEach { index ->
                VideoTile(
                    index = index,
                    state = state,
                    // A factory, not an instance: the surface is only allocated
                    // for a tile that will really show video, and the map keys it
                    // by seat so the same tile always gets the same one back.
                    surfaceFor = { surfaces.getOrPut(index) { SurfaceView(context) } },
                    onSeatTap = onSeatTap,
                    onToggleLock = onToggleLock,
                    modifier = Modifier.weight(1f).aspectRatio(3f / 4f),
                )
            }
            repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun VideoTile(
    index: Int,
    state: PartyRoomUiState,
    surfaceFor: () -> SurfaceView,
    onSeatTap: (Int) -> Unit,
    onToggleLock: (Int) -> Unit,
    modifier: Modifier,
) {
    val c = ZipperTheme.colors
    val room = state.room ?: return
    val seat = state.seatByIndex[index]
    val locked = room.lockedSeats.contains(index)
    val mine = seat != null && seat.uid == state.myUid
    val speaking = isSpeaking(seat, state)
    val showVideo = seat != null && !seat.cameraOff
    val surface = if (showVideo) surfaceFor() else null

    // A seat holder publishes on their seat index and the server writes that into
    // `agoraUid`, so the two cannot disagree. The index is the fallback rather
    // than a guess: a seat document written before that field existed would
    // otherwise bind this tile to uid 0, which is the local speaker.
    val remoteUid = seat?.agoraUid?.takeIf { it != 0 } ?: index
    LaunchedEffect(surface, mine, remoteUid) {
        val sv = surface ?: return@LaunchedEffect
        if (mine) AgoraManager.setupLocalVideo(sv) else AgoraManager.setupRemoteVideo(sv, remoteUid)
    }

    val shape = RoundedCornerShape(Radius.md)
    Box(
        modifier
            .recordSeatCentre(PartySeatCentres.centres, index)
            .background(c.bgRaised, shape)
            .then(if (speaking) Modifier.border(2.dp, c.statusOnline, shape) else Modifier)
            .clickableNoRipple { onSeatTap(index) },
        contentAlignment = Alignment.Center,
    ) {
        if (surface != null) {
            /*
             * Detach before reuse, or the second mount throws.
             *
             * `showVideo` is `seat != null && !seat.cameraOff`, so this AndroidView
             * leaves and re-enters the composition every time a seat holder turns
             * their camera off and on, and every time a seat empties and is taken
             * again. The factory runs once per entry and is handed the SAME cached
             * SurfaceView each time — the whole point of the cache being that a
             * SurfaceView rebuilt mid-room is a black flash and a fresh surface
             * handshake.
             *
             * Compose removes the AndroidView's holder from the view tree on the way
             * out, but it does not detach the holder's child. So the cached surface
             * arrives at the next factory call still parented to the dead holder, and
             * `addView` answers that with IllegalStateException: "The specified child
             * already has a parent." Turning a camera off and on again crashed the
             * room.
             *
             * Detaching rather than keeping the view permanently mounted and merely
             * hidden: a mounted tile needs a surface, and mounting one per tile means
             * ten SurfaceViews in a ten-seat room where four seats are empty. The map
             * is lazy precisely so a six-person room does not pay for ten, and on the
             * ₹8,000 phones this product is built for that is not a rounding error.
             */
            val sv: SurfaceView = surface
            AndroidView(
                factory = {
                    (sv.parent as? ViewGroup)?.removeView(sv)
                    sv
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else if (seat != null) {
            Avatar(
                seat.photoUrl, size = AvatarSize.MD, initial = seat.name,
                ring = if (speaking) AvatarRing.Online else AvatarRing.None,
            )
        } else {
            EmptySeatDisc(
                diameter = Size.Avatar.md,
                locked = locked,
                busy = state.busySeat == index,
                waiting = state.myRequestedSeat == index,
            )
            if (state.canModerate) {
                SeatLockToggle(locked, Modifier.align(Alignment.TopEnd).padding(Space.xxs)) {
                    onToggleLock(index)
                }
            }
        }

        if (seat != null) {
            SeatRoleBadge(room, seat.uid, Modifier.align(Alignment.TopEnd).padding(Space.xxs))
            Row(
                Modifier.align(Alignment.BottomStart).padding(Space.xxs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.xxs),
            ) {
                if (seat.isSilent) {
                    Icon(
                        Icons.Default.MicOff,
                        if (seat.isMuted) "Muted by a moderator" else "Microphone off",
                        tint = if (seat.isMuted) c.statusDanger else c.textMuted,
                        modifier = Modifier.size(Size.Icon.xs),
                    )
                }
                Text(
                    if (mine) "You" else seat.name,
                    style = ZipperTheme.type.caption, color = Color.White,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ── Seat pieces ──────────────────────────────────────────────────────────────

@Composable
private fun EmptySeatDisc(diameter: Dp, locked: Boolean, busy: Boolean, waiting: Boolean) {
    val c = ZipperTheme.colors
    Box(
        Modifier.size(diameter)
            .background(c.glassLow, CircleShape)
            .border(1.dp, if (waiting) c.brandPrimary else c.borderSubtle, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (locked) Icons.Default.Lock else Icons.Default.Add,
            if (locked) "Locked seat" else "Take this seat",
            tint = when {
                busy || waiting -> c.brandPrimary
                locked -> c.textMuted
                else -> c.textSecondary
            },
            modifier = Modifier.size(Size.Icon.md),
        )
    }
}

/**
 * Silent, and by whose hand.
 *
 * `isMuted` and `selfMuted` are separate fields precisely so that clearing one
 * cannot clear the other, and they are drawn differently for the same reason:
 * painting both red taught guests that the host had silenced them when they had
 * silenced themselves, and taught moderators that a guest had muted themselves
 * when it was the moderator's own doing.
 */
@Composable
private fun SeatMuteBadge(seat: PartySeat, modifier: Modifier = Modifier) {
    if (!seat.isSilent) return
    val c = ZipperTheme.colors
    val byModerator = seat.isMuted
    Box(
        modifier.size(Size.Icon.md)
            .background(if (byModerator) c.statusDanger else c.bgElevated, CircleShape)
            .border(1.dp, if (byModerator) c.statusDanger else c.borderStrong, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Default.MicOff,
            if (byModerator) "Muted by a moderator" else "Microphone off",
            tint = if (byModerator) Color.White else c.textSecondary,
            modifier = Modifier.size(11.dp),
        )
    }
}

/**
 * Owner or admin, in gold and violet.
 *
 * The same glyph for both, because both mean "can moderate you" and that is the
 * thing worth reading at a glance; the colour is the difference between the
 * person whose room it is and a co-host they appointed. Nothing at all for an
 * ordinary seat holder, which is most of them.
 */
@Composable
private fun SeatRoleBadge(room: PartyRoom, uid: String, modifier: Modifier = Modifier) {
    val c = ZipperTheme.colors
    val owner = room.isOwner(uid)
    val tint = when {
        owner -> c.brandVip
        room.isAdmin(uid) -> c.brandSecondary
        else -> return
    }
    Box(
        modifier.size(Size.Icon.md).background(tint, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Default.Star, if (owner) "Room owner" else "Room admin",
            tint = Color.White, modifier = Modifier.size(11.dp),
        )
    }
}

/**
 * Lock or unlock an empty seat, for a moderator.
 *
 * On the disc rather than in a menu because the disc itself has to keep meaning
 * "sit here" — a moderator has to be able to take a seat as easily as anybody
 * else, and routing every empty seat through a sheet would put an extra tap
 * between the owner and their own microphone. Small for a control, deliberately:
 * it is the secondary action on the cell, and the primary one is the whole cell.
 */
@Composable
private fun SeatLockToggle(
    locked: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = Size.Icon.xl,
    onClick: () -> Unit,
) {
    val c = ZipperTheme.colors
    Box(
        modifier.size(size)
            .clickableNoRipple(onClick)
            .padding(2.dp)
            .background(c.bgElevated, CircleShape)
            .border(1.dp, c.borderDefault, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (locked) Icons.Default.Lock else Icons.Default.LockOpen,
            if (locked) "Unlock this seat" else "Lock this seat",
            tint = if (locked) c.statusWarning else c.textMuted,
            modifier = Modifier.size(11.dp),
        )
    }
}

/**
 * Turns off Compose's minimum-touch-target expansion for [content]: a control
 * smaller than 48dp otherwise also answers taps up to 48dp around it, even over
 * a neighbouring target that the user was actually aiming at.
 */
@Composable
private fun ExactTouchBounds(content: @Composable () -> Unit) {
    val current = LocalViewConfiguration.current
    val exact = remember(current) {
        object : ViewConfiguration by current {
            override val minimumTouchTargetSize: DpSize get() = DpSize.Zero
        }
    }
    CompositionLocalProvider(LocalViewConfiguration provides exact, content = content)
}

private fun seatCaption(
    index: Int,
    seat: PartySeat?,
    locked: Boolean,
    waiting: Boolean,
    mine: Boolean,
): String = when {
    mine -> "You"
    seat != null -> seat.name.ifBlank { "Guest" }
    waiting -> "Waiting…"
    locked -> "Locked"
    else -> "Seat $index"
}

@Composable
private fun seatCaptionColor(room: PartyRoom, seat: PartySeat?): Color {
    val c = ZipperTheme.colors
    return when {
        seat == null -> c.textMuted
        room.isOwner(seat.uid) -> c.brandVip
        room.isAdmin(seat.uid) -> c.brandSecondary
        else -> c.textPrimary
    }
}

/**
 * Is this seat talking?
 *
 * An Agora uid IS a seat index now, so this is a lookup rather than the two-way
 * guess it used to be: the owner no longer joins on uid 0 as a publisher with no
 * seat document, so there is nothing left to resolve by elimination. My own
 * voice still comes back in a report of its own — Agora reports the local
 * speaker as uid 0 — which is why my seat reads [PartyRoomUiState.localSpeaking]
 * and everybody else's reads the uid set. Merging the two would light seat 0,
 * which does not exist.
 *
 * A silent seat never lights. Agora stops reporting volume for a muted stream
 * anyway, but a ring that survived a mute by one stale report would say somebody
 * was talking when nobody could hear them.
 */
private fun isSpeaking(seat: PartySeat?, state: PartyRoomUiState): Boolean = when {
    seat == null -> false
    seat.isSilent -> false
    seat.uid == state.myUid -> state.localSpeaking
    else -> (if (seat.agoraUid != 0) seat.agoraUid else seat.index) in state.speakingUids
}

// ── Strips and cards ─────────────────────────────────────────────────────────

/**
 * "You have asked for a seat."
 *
 * In a consent room `takeSeat` sends a request instead of taking the seat, and
 * without this the tap looked like it had done nothing at all — the seat stayed
 * empty, the notice scrolled past, and the only honest thing on screen was a
 * faint ring on one disc.
 */
@Composable
private fun PendingRequestStrip(seatIndex: Int, onCancel: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.xxs)
            .background(c.tintBrandSubtle, RoundedCornerShape(Radius.md))
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Text(
            "Waiting for the host to let you onto seat $seatIndex",
            style = ZipperTheme.type.bodyS, color = c.textPrimary,
            modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        Text(
            "Cancel", style = ZipperTheme.type.labelM, color = c.textBrand,
            modifier = Modifier.clickableNoRipple(onCancel),
        )
    }
}

@Composable
private fun WelcomeCard(text: String, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    val shape = RoundedCornerShape(Radius.md)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.md, vertical = Space.xxs)
            .background(c.tintVioletSubtle, shape)
            .border(1.dp, c.borderSubtle, shape)
            .padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Icon(
            Icons.Outlined.Campaign, null, tint = c.brandSecondary,
            modifier = Modifier.size(Size.Icon.md),
        )
        Text(
            text, style = ZipperTheme.type.bodyS, color = c.textPrimary,
            modifier = Modifier.weight(1f), maxLines = 4, overflow = TextOverflow.Ellipsis,
        )
        Icon(
            Icons.Default.Close, "Hide the welcome message", tint = c.textMuted,
            modifier = Modifier.size(Size.Icon.sm).clickableNoRipple(onDismiss),
        )
    }
}

// ── Chat and composer ────────────────────────────────────────────────────────

@Composable
private fun ChatLine(message: PartyMessage, onOpenProfile: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth().clickableNoRipple(onOpenProfile),
        horizontalArrangement = Arrangement.spacedBy(Space.xxs),
    ) {
        if (message.isJoin) {
            Text(message.senderName, style = ZipperTheme.type.labelS, color = c.textBrand, maxLines = 1)
            Text("joined", style = ZipperTheme.type.bodyS, color = c.textSecondary)
        } else {
            Text("${message.senderName}:", style = ZipperTheme.type.labelS, color = c.brandVip, maxLines = 1)
            Text(
                message.text, style = ZipperTheme.type.bodyS, color = c.textPrimary,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ComposerBar(
    state: PartyRoomUiState,
    onInput: (String) -> Unit,
    onSend: () -> Unit,
    onToggleMic: () -> Unit,
    onToggleCamera: () -> Unit,
    onGift: () -> Unit,
) {
    val c = ZipperTheme.colors
    // The mic and the camera belong to whoever is on a seat. Being the owner is
    // no longer one of the ways to be publishing — they have to sit down like
    // everybody else — so this is one condition where it used to be two.
    val seat = state.mySeat
    val onAir = seat != null
    val silent = seat?.isSilent == true
    val heldByModerator = seat?.isMuted == true
    val cameraOff = seat?.cameraOff == true

    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().imePadding()
            .padding(start = Space.md, end = Space.md, top = Space.sm, bottom = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Row(
            Modifier.weight(1f).height(Size.Control.md)
                .background(c.bgRaised, CircleShape)
                .border(1.dp, c.borderSubtle, CircleShape)
                .padding(start = Space.lg, end = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = state.messageInput,
                onValueChange = onInput,
                singleLine = true,
                textStyle = ZipperTheme.type.bodyS.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    if (state.messageInput.isEmpty()) {
                        Text("Say something…", style = ZipperTheme.type.bodyS, color = c.textMuted)
                    }
                    inner()
                },
            )
            Icon(
                Icons.AutoMirrored.Filled.Send, "Send",
                tint = if (state.messageInput.isBlank()) c.textMuted else c.brandPrimary,
                modifier = Modifier.size(Size.Icon.md).clickableNoRipple(onSend),
            )
        }
        if (onAir) {
            // Deliberately still ENABLED while a moderator holds the mute. The
            // ViewModel answers a tap with "the host muted you", and a button that
            // says why it will not work beats one that is greyed out and says
            // nothing — which is what the old disabled control did.
            RoundControl(
                icon = if (silent) Icons.Default.MicOff else Icons.Default.Mic,
                label = when {
                    heldByModerator -> "A moderator muted you"
                    silent -> "Turn my microphone on"
                    else -> "Turn my microphone off"
                },
                tint = when {
                    heldByModerator -> c.statusDanger
                    silent -> c.statusWarning
                    else -> c.textPrimary
                },
                onClick = onToggleMic,
            )
            if (state.isVideo) {
                RoundControl(
                    icon = if (cameraOff) Icons.Default.VideocamOff else Icons.Default.Videocam,
                    label = if (cameraOff) "Turn my camera on" else "Turn my camera off",
                    tint = if (cameraOff) c.statusWarning else c.textPrimary,
                    onClick = onToggleCamera,
                )
            }
        }
        Box(
            Modifier.size(Size.Control.md)
                .background(
                    Brush.linearGradient(listOf(c.brandGradientFrom, c.brandGradientTo)),
                    CircleShape,
                )
                .clickableNoRipple(onGift),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.CardGiftcard, "Send a gift", tint = Color.White,
                modifier = Modifier.size(Size.Icon.md),
            )
        }
    }
}

@Composable
private fun RoundControl(
    icon: ImageVector,
    label: String,
    tint: Color,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    IconButtonCircle(
        icon, label, onClick,
        size = Size.Control.md,
        background = ZipperTheme.colors.bgRaised,
        tint = tint,
        enabled = enabled,
    )
}

// ── Picture-in-picture ───────────────────────────────────────────────────────

/**
 * The room, at the size of a matchbox.
 *
 * Who is on a seat and who is talking, and nothing else. No chat, no controls, no
 * video: PiP is for keeping the room in your ear while you do something else,
 * and every pixel spent on chrome here is a pixel taken from the faces.
 */
@Composable
private fun PipLayout(state: PartyRoomUiState) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxSize().background(c.bgBase).padding(Space.sm),
        verticalArrangement = Arrangement.spacedBy(Space.xs, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (state.seats.isEmpty()) {
            Text(
                state.room?.title?.ifBlank { null } ?: "Party room",
                style = ZipperTheme.type.labelS, color = c.textSecondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        } else {
            // Nine at most. A PiP window is not a seat grid and fifteen 36dp
            // avatars in it are fifteen grey dots.
            state.seats.take(9).chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    row.forEach { seat ->
                        Avatar(
                            seat.photoUrl, size = AvatarSize.SM, initial = seat.name,
                            ring = if (isSpeaking(seat, state)) AvatarRing.Online else AvatarRing.None,
                        )
                    }
                }
            }
        }
    }
}

// ── Gates and terminal states ────────────────────────────────────────────────

/**
 * Four digits, for a private room.
 *
 * A room that needs a code is discovered by being REFUSED rather than by reading
 * `visibility` for ourselves — the refusal is the server's answer and the field
 * is only a hint about what to render. Which is also why the first sight of this
 * card carries no error: being asked for a password is not a mistake, and
 * `passwordError` is deliberately null until an answer is actually wrong.
 */
@Composable
private fun PasswordGate(
    room: PartyRoom?,
    error: String?,
    joining: Boolean,
    onSubmit: (String) -> Unit,
    onBack: () -> Unit,
    /** B7: Zipper staff allowed into private rooms — never silent: logged, and shown in the room. */
    onOfficial: (() -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    var code by remember { mutableStateOf("") }
    // A wrong answer clears the boxes: four wrong digits left in place means the
    // next tap of Join sends the same four again.
    LaunchedEffect(error) { if (error != null) code = "" }

    Column(
        Modifier.fillMaxSize().statusBarsPadding().imePadding().padding(horizontal = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Avatar(room?.hostPhotoUrl, size = AvatarSize.XL, initial = room?.hostName ?: "")
        Spacer(Modifier.height(Space.md))
        Text(
            room?.title?.ifBlank { null } ?: "Private room",
            style = ZipperTheme.type.headingM, color = c.textPrimary, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.xs))
        Text(
            "Ask ${room?.hostName ?: "the host"} for the four-digit code.",
            style = ZipperTheme.type.bodyM, color = c.textSecondary, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.xl))
        PartyDigitsField(
            code = code,
            error = error != null,
            onCode = { code = it },
            autoFocus = true,
            onDone = { if (code.length == 4) onSubmit(code) },
        )
        if (error != null) {
            Spacer(Modifier.height(Space.md))
            Text(
                error, style = ZipperTheme.type.bodyS, color = c.statusDanger,
                textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(Space.xl))
        ZipperButton(
            "Join the room", { onSubmit(code) }, gradient = true, fullWidth = true,
            size = ButtonSize.Medium, enabled = code.length == 4 && !joining, loading = joining,
        )
        if (onOfficial != null) {
            Spacer(Modifier.height(Space.sm))
            ZipperButton(
                "Enter as Zipper official", onOfficial, style = ButtonStyle.Secondary, fullWidth = true,
                size = ButtonSize.Medium, enabled = !joining,
            )
            Text(
                "Your entry is recorded in the room's access log and shown to everyone in the room.",
                style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(Space.sm))
        ZipperButton(
            "Back", onBack, style = ButtonStyle.Secondary, fullWidth = true,
            size = ButtonSize.Medium,
        )
    }
}

/** Kicked, or the room closed. Either way there is nothing left to do here. */
@Composable
private fun TerminalOverlay(
    photoUrl: String?,
    name: String,
    title: String,
    body: String,
    onExit: () -> Unit,
) {
    val c = ZipperTheme.colors
    val shape = RoundedCornerShape(Radius.xl)
    Box(Modifier.fillMaxSize().background(c.scrimStrong), contentAlignment = Alignment.Center) {
        Column(
            Modifier.padding(Space.x3l).fillMaxWidth()
                .background(c.bgElevated, shape)
                .border(1.dp, c.borderSubtle, shape)
                .padding(Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Avatar(photoUrl, size = AvatarSize.XL, initial = name)
            Text(title, style = ZipperTheme.type.headingM, color = c.textPrimary)
            Text(
                body, style = ZipperTheme.type.bodyM, color = c.textSecondary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.sm))
            ZipperButton(
                "Back to rooms", onExit, style = ButtonStyle.Secondary, fullWidth = true,
                size = ButtonSize.Medium,
            )
        }
    }
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

/**
 * The gift overlay speaks [LiveGiftEvent].
 *
 * A party gift carries one field a live gift does not (`diamondCost`) and names
 * the sender's uid differently; everything the animation draws is in both. A
 * projection rather than a second overlay, because two overlays is two sets of
 * animation timings to keep in step and the room does not need its own.
 */
private fun PartyGiftEvent.asLiveGiftEvent(): LiveGiftEvent = LiveGiftEvent(
    id = id,
    uid = senderUid,
    senderName = senderName,
    senderPhotoUrl = senderPhotoUrl,
    giftName = giftName,
    emoji = emoji,
    imageUrl = imageUrl,
    quantity = quantity,
    timestamp = timestamp,
    svgaUrl = svgaUrl,
    lottieAsset = lottieAsset,
)
