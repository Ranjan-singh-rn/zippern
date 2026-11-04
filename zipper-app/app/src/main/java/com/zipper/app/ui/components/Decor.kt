package com.zipper.app.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt

/*
 * O9 (5 Nov 2026) — decorations everywhere.
 *
 * "user entries are not showing to the live or party room … profile circle, that frame not showing … chat bubbles
 *  not applied … colour chart should be there … profile card is not even showing … take it from that type itself,
 *  not another build."
 *
 * What a person wears is read from their PUBLIC profile — `publicProfiles/{uid}.equipped*`, the pointers only the
 * server writes (`equipBagItem`, `expireCosmetics`) — never from a field the sender put on their own message. So
 * nobody can wear in a chat a bubble they never bought, and what everyone sees is what that person owns NOW. One read
 * per person per five minutes, cached for the session.
 *
 * How an item is drawn is decided by what its catalogue row (`bagItems/{id}`, the CRM) carries, in this order:
 *   SVGA (`svgaUrl`) → video (`videoUrl`, entrances) → Lottie (`animationUrl`, or `animationAsset` bundled in the app)
 *   → colours (`style`: "#RRGGBB,#RRGGBB" — bubbles, profile cards, ID frames and plain frames) → a still image.
 * The CRM decides the type by what it uploads; the app needs no new build for a new item.
 */

// ── The starter set's looks, by catalogue id ─────────────────────────────────

object DecorDefaults {
    /** The bundled frame rings (512×512 vector Lottie; the ring's inside is 372 px across). */
    val FRAME_LOTTIE: Map<String, String> = mapOf(
        "af_basic" to "anim/frame_silver.json",
        "af_bronze" to "anim/frame_bronze.json",
        "af_silver" to "anim/frame_silver.json",
        "af_gold" to "anim/frame_gold.json",
        "af_royal" to "anim/frame_royal.json",
        "af_dragon" to "anim/frame_cosmic.json",
        "af_neon" to "anim/frame_neon.json",
        "af_galaxy" to "anim/frame_galaxy.json",
        "af_event1" to "anim/frame_purple.json",
    )

    /** How much larger than the avatar a bundled ring is drawn, so its inside meets the photo's edge. */
    const val LOTTIE_FRAME_SCALE = 1.38f

    /** The bundled entrance clips (vector Lottie, 28–284 KB each). */
    val ENTRANCE_LOTTIE: Map<String, String> = mapOf(
        "en_bike" to "lottie/entries/entry_level6_bike.json",
        "en_sports" to "lottie/entries/entry_level8_sports.json",
        "en_lambo" to "lottie/entries/entry_level10_lambo.json",
        "en_tiger" to "lottie/entries/entry_tiger.json",
        "en_king" to "lottie/entries/entry_king.json",
        "en_horse" to "lottie/entries/entry_horse.json",
        "en_ship" to "lottie/entries/entry_ship.json",
        "en_jet" to "lottie/entries/entry_jet.json",
        "en_rocket" to "lottie/entries/entry_rocket.json",
        "en_yamraj" to "lottie/entries/entry_special_yamraj.json",
        "en_vip" to "lottie/entries/entry_vip_plane.json",
    )

    /** The banner behind an arrival's name: the richer the entrance, the richer the banner. */
    fun bannerAsset(entranceId: String, level: Int): String? = when {
        entranceId in setOf("en_yamraj", "en_vip", "en_king", "en_lambo") -> "anim/entrance_royal.json"
        entranceId.isNotBlank() -> "anim/entrance_premium.json"
        level >= 5 -> "anim/entrance_standard.json"
        else -> null
    }

    /** The colour chart: chat bubbles, by id. */
    val BUBBLE: Map<String, List<Long>> = mapOf(
        "cb_default" to listOf(0xFF2A2440, 0xFF3A3358),
        "cb_rose" to listOf(0xFFFF5F8F, 0xFFC2185B),
        "cb_ocean" to listOf(0xFF2193B0, 0xFF1565C0),
        "cb_galaxy" to listOf(0xFF7B2FF7, 0xFFF107A3),
        "cb_event" to listOf(0xFFF7971E, 0xFFFF5E62),
        "cb_mint" to listOf(0xFF11998E, 0xFF38EF7D),
        "cb_gold" to listOf(0xFFB8860B, 0xFFFFC94D),
        "cb_midnight" to listOf(0xFF232526, 0xFF414345),
    )

    /** Profile cards, by id. */
    val CARD: Map<String, List<Long>> = mapOf(
        "pc_basic" to listOf(0xFF2E2652, 0xFF594D8C),
        "pc_gold" to listOf(0xFF8A6100, 0xFFFFC94D),
        "pc_royal" to listOf(0xFF3A0CA3, 0xFF8E2DE2),
        "pc_event" to listOf(0xFFFF512F, 0xFFDD2476),
    )

    /** ID frames — the banner behind a name — by id. */
    val ID_FRAME: Map<String, List<Long>> = mapOf(
        "id_basic" to listOf(0xFF8E9EAB, 0xFFEEF2F3),
        "id_gold" to listOf(0xFFB8860B, 0xFFFFD86B),
        "id_royal" to listOf(0xFF5B247A, 0xFF1BCEDF),
        "id_event" to listOf(0xFFFF416C, 0xFFFF4B2B),
    )

    /**
     * A catalogue row's `style`: "#RRGGBB,#RRGGBB[,…]" (an optional "gradient:" prefix, `#AARRGGBB` too). Null when
     * it is blank or unreadable — the item then falls back to its built-in look or its image.
     */
    fun parseColors(style: String?): List<Color>? {
        val raw = style?.trim()?.removePrefix("gradient:")?.takeIf { it.isNotBlank() } ?: return null
        val colors = raw.split(',', ' ', ';').mapNotNull { part ->
            val hex = part.trim().removePrefix("#")
            when (hex.length) {
                6 -> hex.toLongOrNull(16)?.let { Color(0xFF000000 or it) }
                8 -> hex.toLongOrNull(16)?.let { Color(it) }
                else -> null
            }
        }
        return when (colors.size) {
            0 -> null
            1 -> listOf(colors[0], colors[0])
            else -> colors
        }
    }

    fun colorsFor(category: String, id: String, style: String?): List<Color>? =
        parseColors(style) ?: when (category) {
            "chat_bubble" -> BUBBLE[id]
            "profile_card" -> CARD[id]
            "id_frame" -> ID_FRAME[id]
            else -> null
        }?.map { Color(it) }
}

// ── What a person is wearing ─────────────────────────────────────────────────

@Immutable
data class UserDecor(
    val uid: String,
    val name: String = "",
    val photoUrl: String = "",
    val level: Int = 0,
    val frameId: String = "",
    val bubbleId: String = "",
    val entranceId: String = "",
    val cardId: String = "",
    val idFrameId: String = "",
)

/** `publicProfiles/{uid}` → [UserDecor], cached five minutes. One read per person, however many rows they post. */
object UserDecorCache {
    private data class Entry(val decor: UserDecor?, val at: Long)
    private val cache = ConcurrentHashMap<String, Entry>()
    private const val TTL_MS = 5 * 60_000L

    fun peek(uid: String): UserDecor? = cache[uid]?.takeIf { fresh(it) }?.decor

    private fun fresh(e: Entry) = System.currentTimeMillis() - e.at < TTL_MS

    suspend fun get(uid: String): UserDecor? {
        if (uid.isBlank()) return null
        cache[uid]?.takeIf { fresh(it) }?.let { return it.decor }
        val decor = try {
            val d = FirebaseFirestore.getInstance().collection("publicProfiles").document(uid).get().await()
            if (!d.exists()) null else UserDecor(
                uid = uid,
                name = d.getString("name").orEmpty(),
                photoUrl = d.getString("photoUrl").orEmpty(),
                level = (d.getLong("level") ?: 0L).toInt(),
                frameId = d.getString("equippedFrame").orEmpty(),
                bubbleId = d.getString("equippedChatBubble").orEmpty(),
                entranceId = d.getString("equippedEntrance").orEmpty(),
                cardId = d.getString("equippedProfileCard").orEmpty(),
                idFrameId = d.getString("equippedIdFrame").orEmpty(),
            )
        } catch (_: Exception) { return peekAny(uid) }
        cache[uid] = Entry(decor, System.currentTimeMillis())
        return decor
    }

    /** A stale answer is better than none when the read fails. */
    private fun peekAny(uid: String): UserDecor? = cache[uid]?.decor

    /** After this person changes what they wear (the bag), so the next screen shows it at once. */
    fun invalidate(uid: String) { cache.remove(uid) }
}

/** What [uid] is wearing, or null while it loads (or for nobody). */
@Composable
fun rememberUserDecor(uid: String?): UserDecor? {
    var d by remember(uid) { mutableStateOf(uid?.takeIf { it.isNotBlank() }?.let { UserDecorCache.peek(it) }) }
    LaunchedEffect(uid) {
        if (!uid.isNullOrBlank() && d == null) d = UserDecorCache.get(uid)
    }
    return d
}

// ── Frames ───────────────────────────────────────────────────────────────────

/**
 * The frame for [frameItemId] around an avatar [avatarSize] across: SVGA (animated only where [animated]), a
 * Lottie ring (bundled or from the CRM; a still frame of it in lists), a colour ring from `style`, or the item's
 * image. Draws nothing for no frame.
 */
@Composable
fun DecorFrame(frameItemId: String?, avatarSize: Dp, animated: Boolean, modifier: Modifier = Modifier) {
    if (frameItemId.isNullOrBlank()) return
    val item = rememberCosmetic(frameItemId)
    val svga = item?.svgaUrl?.takeIf { animated && it.isNotBlank() }
    // The starter set's own ring first (the CRM's stored path for it may be a web path the app does not bundle).
    val bundled = DecorDefaults.FRAME_LOTTIE[frameItemId] ?: item?.animationAsset?.takeIf { it.endsWith(".json") && !it.startsWith("/") }
    val remoteLottie = item?.animationUrl?.takeIf { it.isNotBlank() }
    val colors = DecorDefaults.parseColors(item?.style)
    val still = item?.stillUrl?.takeIf { it.isNotBlank() }
    val scale = item?.frameScale?.takeIf { it in 1.0f..2.5f }
    when {
        // `requiredSize`, not `size`: a frame is larger than the avatar box it sits in, and `size` is clamped to the
        // box — which drew every ring INSIDE the photo instead of around it.
        svga != null -> Svga(source = svga, modifier = modifier.requiredSize(avatarSize * (scale ?: 1.3f)), loops = 0)
        bundled != null || remoteLottie != null -> LottieRing(
            spec = if (bundled != null) LottieCompositionSpec.Asset(bundled) else LottieCompositionSpec.Url(remoteLottie!!),
            size = avatarSize * (scale ?: DecorDefaults.LOTTIE_FRAME_SCALE),
            animated = animated,
            modifier = modifier,
        )
        colors != null -> ColorRing(colors, avatarSize, modifier)
        still != null -> coil.compose.AsyncImage(
            model = still, contentDescription = null,
            contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            modifier = modifier.requiredSize(avatarSize * (scale ?: 1.3f)),
        )
    }
}

@Composable
private fun LottieRing(spec: LottieCompositionSpec, size: Dp, animated: Boolean, modifier: Modifier) {
    val composition by rememberLottieComposition(spec)
    if (animated) {
        val progress = animateLottieCompositionAsState(composition, iterations = LottieConstants.IterateForever)
        LottieAnimation(composition, { progress.value }, modifier.requiredSize(size))
    } else {
        // In a list: one frame of it, drawn once — no animation clock per row.
        LottieAnimation(composition, { 0.3f }, modifier.requiredSize(size))
    }
}

/** A frame that is just colours: a gradient ring with a soft glow, outside the photo. */
@Composable
private fun ColorRing(colors: List<Color>, avatarSize: Dp, modifier: Modifier) {
    Canvas(modifier.requiredSize(avatarSize * 1.18f)) {
        val stroke = this.size.minDimension * 0.07f
        val brush = Brush.sweepGradient(colors + colors.first())
        drawCircle(brush = brush, radius = this.size.minDimension / 2f - stroke / 2f, style = Stroke(width = stroke))
        drawCircle(
            color = colors.first().copy(alpha = 0.25f),
            radius = this.size.minDimension / 2f - stroke * 1.4f,
            style = Stroke(width = stroke * 0.5f),
        )
    }
}

// ── Bubbles, cards and ID frames: colours ────────────────────────────────────

/** The chat bubble [bubbleId] as a brush, or null for the plain one. */
@Composable
fun rememberDecorBrush(category: String, itemId: String?): Brush? {
    if (itemId.isNullOrBlank()) return null
    val item = rememberCosmetic(itemId)
    val colors = remember(itemId, item?.style) { DecorDefaults.colorsFor(category, itemId, item?.style) } ?: return null
    return remember(colors) { Brush.linearGradient(colors) }
}

// ── Arrivals: who just walked in ─────────────────────────────────────────────

/** Somebody who just entered a live or party room. */
@Immutable
data class Arrival(
    val uid: String,
    val name: String,
    val photoUrl: String = "",
    val level: Int = 0,
    /** Their entrance, from their public profile (or the party listener row). Blank: the banner alone. */
    val entranceItemId: String = "",
    val svgaUrl: String = "",
    val videoUrl: String = "",
    val posterUrl: String = "",
    val key: String = uid,
)

const val ARRIVAL_BANNER_MS = 2_600L
const val ARRIVAL_EFFECT_WATCHDOG_MS = 8_000L
/** In the first look at a live room, a join this recent is an arrival (the viewer's own included), not history. */
const val FIRST_SNAPSHOT_ARRIVAL_MS = 30_000L

/**
 * O9: an arrival, for everyone in the room. A banner slides in — photo (with their frame), name, level — and, when
 * they wear an entrance, its effect plays over the room once: SVGA (with their photo and name in it) → video →
 * Lottie (bundled, or from the CRM). Ends itself; [onFinished] frees the room's single arrival slot.
 */
@Composable
fun ArrivalOverlay(arrival: Arrival, onFinished: () -> Unit, modifier: Modifier = Modifier) {
    val done by rememberUpdatedState(onFinished)
    val decor = rememberUserDecor(arrival.uid)
    val entranceId = arrival.entranceItemId.ifBlank { decor?.entranceId.orEmpty() }
    val item = rememberCosmetic(entranceId.ifBlank { null })
    val svga = arrival.svgaUrl.ifBlank { item?.svgaUrl.orEmpty() }
    val video = arrival.videoUrl.ifBlank { item?.videoUrl.orEmpty() }
    val bundled = DecorDefaults.ENTRANCE_LOTTIE[entranceId] ?: item?.animationAsset?.takeIf { it.endsWith(".json") && !it.startsWith("/") }
    val remoteLottie = item?.animationUrl.orEmpty()
    val hasEffect = entranceId.isNotBlank() &&
        (svga.isNotBlank() || video.isNotBlank() || bundled != null || remoteLottie.isNotBlank())
    val level = maxOf(arrival.level, decor?.level ?: 0)

    /*
     * The arrival ends when BOTH the effect and the banner are done, not when the first of them is. On a phone with
     * animations switched off (Accessibility → Remove animations, battery saver — and the QA emulator) a Lottie
     * "finishes" the moment it starts; ending the arrival there took the banner with it, so nobody saw anyone
     * arrive. Keyed on the entrance too: the wearer's entrance is read after the banner is already up.
     */
    var effectDone by remember(arrival.key, entranceId, hasEffect) { mutableStateOf(!hasEffect) }
    var bannerDone by remember(arrival.key) { mutableStateOf(false) }
    LaunchedEffect(arrival.key) {
        delay(ARRIVAL_BANNER_MS + 400)
        bannerDone = true
    }
    LaunchedEffect(arrival.key) {
        delay(ARRIVAL_EFFECT_WATCHDOG_MS)   // a stuck decoder never holds the room's arrival slot
        done()
    }
    LaunchedEffect(effectDone, bannerDone) { if (effectDone && bannerDone) done() }

    /*
     * A Lottie entrance is loaded and timed HERE, at the top of the arrival, not inside the branch that draws it. The
     * branch was re-created when the room recomposed a moment after the arrival began, which threw away the loaded
     * file and the ride's position with it — the picture never got past the edge of the screen (5 Nov 2026, on the
     * emulator). State that outlives a recomposition lives where the recomposition cannot reach it.
     */
    val lottieSpec: LottieCompositionSpec? = when {
        !hasEffect || svga.isNotBlank() || video.isNotBlank() -> null
        bundled != null -> LottieCompositionSpec.Asset(bundled)
        remoteLottie.isNotBlank() -> LottieCompositionSpec.Url(remoteLottie)
        else -> null
    }
    val lottieResult = if (lottieSpec != null) rememberLottieComposition(lottieSpec) else null
    val lottie = lottieResult?.value
    val still = lottie != null && isStillEntrance(lottie.durationFrames)
    val rideX = remember(arrival.key) { Animatable(STILL_ENTRANCE_START_X) }
    val playProgress = animateLottieCompositionAsState(if (lottie != null && !still) lottie else null, iterations = 1)
    LaunchedEffect(arrival.key, lottieResult?.isFailure) {
        if (lottieResult?.isFailure == true) {
            android.util.Log.w("ZipperDecor", "entrance $lottieSpec could not be read", lottieResult.error)
            effectDone = true
        }
    }
    LaunchedEffect(arrival.key, lottie) {
        if (lottie == null) return@LaunchedEffect
        if (isStillEntrance(lottie.durationFrames)) {
            // A ONE-FRAME file — every entrance in the starter set is a single picture wrapped as a Lottie (`ip 0,
            // op 1`) — "finished" 33 ms after it started, so nobody ever saw it. A picture rides in instead: in from
            // the right, a hold in the middle (a delay, so it shows with animations off too), out to the left.
            rideX.animateTo(0f, tween(560, easing = FastOutSlowInEasing))
            delay(STILL_ENTRANCE_HOLD_MS)
            rideX.animateTo(STILL_ENTRANCE_END_X, tween(520, easing = androidx.compose.animation.core.FastOutLinearInEasing))
            effectDone = true
        } else {
            androidx.compose.runtime.snapshotFlow { playProgress.value }.collect { if (it >= 1f) effectDone = true }
        }
    }

    Box(modifier.fillMaxSize()) {
        if (hasEffect && !effectDone) {
            when {
                svga.isNotBlank() -> Svga(
                    source = svga, modifier = Modifier.fillMaxSize(), loops = 1,
                    dynamicImages = mapOf("avatar" to arrival.photoUrl), dynamicTexts = mapOf("name" to arrival.name),
                    onFinished = { effectDone = true },
                )
                video.isNotBlank() -> EntranceVideo(
                    videoUrl = video, posterUrl = arrival.posterUrl, contentDescription = "${arrival.name} arriving",
                    modifier = Modifier.fillMaxSize(), loop = false, onFinished = { effectDone = true },
                )
                lottie != null -> {
                    // Above the banner (which sits just below the middle), not under it.
                    val place = Modifier.fillMaxWidth().height(280.dp).align(Alignment.Center).offset(y = (-110).dp)
                    if (still) StillEntrance(lottie, { rideX.value }, place)
                    else LottieAnimation(lottie, { playProgress.value }, place)
                }
            }
        }
        ArrivalBanner(
            arrival.copy(photoUrl = arrival.photoUrl.ifBlank { decor?.photoUrl.orEmpty() }, name = arrival.name.ifBlank { decor?.name.orEmpty() }),
            level, entranceId, Modifier.align(Alignment.CenterStart).padding(top = 140.dp),
        )
    }
}

/** Shorter than this many frames, a Lottie is a picture and is moved rather than played. */
internal const val STILL_ENTRANCE_MAX_FRAMES = 2f
internal fun isStillEntrance(durationFrames: Float): Boolean = durationFrames <= STILL_ENTRANCE_MAX_FRAMES
/** How long a ridden-in picture stays in the middle of the room. Delay-based, so it holds with animations off too. */
const val STILL_ENTRANCE_HOLD_MS = 1_500L
/** Where the ride starts and ends, in widths of the picture from its place in the middle: off the right, off the left. */
internal const val STILL_ENTRANCE_START_X = 1.35f
internal const val STILL_ENTRANCE_END_X = -1.45f

/**
 * One frame of [composition] on a card the picture's own shape, at [x] picture-widths from the middle. Most of these
 * are photographs with a background, and a full-width black box sliding over a live video looked like a glitch
 * rather than an entrance. Draw-phase only: the position is read in the layer, so the ride never recomposes.
 */
@Composable
private fun StillEntrance(composition: com.airbnb.lottie.LottieComposition, x: () -> Float, modifier: Modifier) {
    val bounds = composition.bounds
    val ratio = if (bounds.height() > 0) bounds.width().toFloat() / bounds.height() else 1f
    val card = RoundedCornerShape(24.dp)
    Box(modifier, contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .padding(horizontal = 16.dp)
                .aspectRatio(ratio.coerceIn(0.4f, 2.5f), matchHeightConstraintsFirst = true)
                .graphicsLayer {
                    val p = x()
                    translationX = p * size.width
                    // A little lean into the ride: bigger in the middle, tilted while moving.
                    val nearMiddle = 1f - kotlin.math.abs(p).coerceAtMost(1f)
                    scaleX = 0.86f + 0.14f * nearMiddle
                    scaleY = scaleX
                    rotationZ = -4f * p.coerceIn(-1f, 1f)
                    shape = card
                    clip = true
                }
                .border(2.dp, Brush.linearGradient(listOf(Color(0xFFFFD54F), Color(0xFFF107A3), Color(0xFF7B2FF7))), card),
        ) {
            LottieAnimation(composition, { 0f }, Modifier.fillMaxSize())
        }
    }
}

/** The sliding name banner: in from the left, a hold, out to the right. */
@Composable
private fun ArrivalBanner(arrival: Arrival, level: Int, entranceId: String, modifier: Modifier) {
    val c = ZipperTheme.colors
    val x = remember(arrival.key) { Animatable(-1f) }
    LaunchedEffect(arrival.key) {
        x.animateTo(0f, tween(420, easing = FastOutSlowInEasing))
        delay(ARRIVAL_BANNER_MS - 900)
        x.animateTo(1.2f, tween(480, easing = LinearEasing))
    }
    val bannerAsset = DecorDefaults.bannerAsset(entranceId, level)
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val travel = constraints.maxWidth.toFloat()
        Box(
            Modifier
                .offset { IntOffset((x.value * travel).roundToInt(), 0) }
                .padding(start = 8.dp)
                .height(56.dp)
                .widthIn(min = 200.dp, max = 320.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (bannerAsset != null) {
                val composition by rememberLottieComposition(LottieCompositionSpec.Asset(bannerAsset))
                val p = animateLottieCompositionAsState(composition, iterations = 1)
                LottieAnimation(composition, { p.value }, Modifier.matchParentSize().clip(RoundedCornerShape(28.dp)))
            }
            Row(
                Modifier
                    .background(
                        if (entranceId.isNotBlank() || level >= 5)
                            Brush.horizontalGradient(listOf(Color(0xCC7B2FF7), Color(0x99F107A3), Color(0x00F107A3)))
                        else Brush.horizontalGradient(listOf(c.scrimStrong, c.scrimStrong.copy(alpha = 0f))),
                        RoundedCornerShape(28.dp),
                    )
                    .border(1.dp, if (entranceId.isNotBlank()) c.brandVip else Color.Transparent, RoundedCornerShape(28.dp))
                    .padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Avatar(arrival.photoUrl.ifBlank { null }, size = AvatarSize.SM, initial = arrival.name, decorUid = arrival.uid)
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            arrival.name.ifBlank { "Someone" }, style = ZipperTheme.type.labelM, color = Color.White,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 150.dp),
                        )
                        if (level > 0) LevelChip(level)
                    }
                    Text("entered the room", style = ZipperTheme.type.caption, color = Color.White.copy(alpha = 0.85f))
                }
            }
        }
    }
}

// ── Emoji gifts that jump ────────────────────────────────────────────────────

/**
 * O9: an emoji gift is not a still picture — [count] copies of it hop up from the bottom, each on its own beat, and
 * fade as they land, then the whole thing reports [onFinished]. Used where a gift has an emoji and no artwork.
 */
@Composable
fun EmojiJump(emoji: String, modifier: Modifier = Modifier, count: Int = 7, onFinished: () -> Unit = {}) {
    val done by rememberUpdatedState(onFinished)
    val n = count.coerceIn(1, 12)
    val hops = remember(emoji) { List(n) { Animatable(0f) } }
    LaunchedEffect(emoji) {
        hops.forEachIndexed { i, a ->
            launch {
                delay(i * 110L)
                a.animateTo(1f, tween(1_250, easing = LinearEasing))
            }
        }
        delay(n * 110L + 1_350L)
        done()
    }
    BoxWithConstraints(modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        hops.forEachIndexed { i, a ->
            // Spread across the width; each hop is a parabola up and a little sideways.
            val lane = (i + 0.5f) / n
            Text(
                emoji,
                style = ZipperTheme.type.displayL,
                modifier = Modifier.graphicsLayer {
                    val t = a.value
                    val up = 4f * t * (1f - t)            // 0 → 1 → 0
                    translationX = w * lane - w * 0.06f + (if (i % 2 == 0) 1 else -1) * 30f * t
                    translationY = h * 0.78f - up * h * 0.45f - t * h * 0.12f
                    val s = 0.7f + 0.6f * up
                    scaleX = s; scaleY = s
                    rotationZ = (if (i % 2 == 0) 1 else -1) * 18f * t
                    alpha = if (t < 0.85f) 1f else (1f - t) / 0.15f
                },
            )
        }
    }
}

/**
 * O9: a live room's arrivals, from its join rows (`liveRooms/{id}/comments`, `isJoin`). The first snapshot is the
 * room as this phone found it; every join row after that plays [ArrivalOverlay], one at a time.
 */
@Composable
fun LiveArrivals(comments: List<com.zipper.app.data.model.LiveComment>) {
    var arrival by remember { mutableStateOf<Arrival?>(null) }
    val seen = remember { mutableSetOf<String>() }
    var primed by remember { mutableStateOf(false) }
    LaunchedEffect(comments) {
        val fresh = comments.filter { it.isJoin && seen.add(it.id) }
        val playable = if (!primed) {
            primed = true
            // The room as this phone found it: old joins are history, not arrivals. A join from the last few
            // seconds still plays — this viewer's own (written just before the first snapshot came back, which hid
            // the entrance from the person who bought it) or someone who walked in with them.
            val now = System.currentTimeMillis()
            fresh.filter { kotlin.math.abs(now - it.timestamp) <= FIRST_SNAPSHOT_ARRIVAL_MS }
        } else fresh
        if (arrival == null) playable.lastOrNull()?.let { j ->
            arrival = Arrival(uid = j.uid, name = j.name, photoUrl = j.photoUrl, key = j.id)
        }
    }
    arrival?.let { a -> ArrivalOverlay(a, onFinished = { arrival = null }) }
}
