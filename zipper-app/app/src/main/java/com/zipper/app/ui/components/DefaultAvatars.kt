package com.zipper.app.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import coil.map.Mapper
import coil.request.Options
import com.zipper.app.R
import kotlin.random.Random

/*
 * ── Default avatars ───────────────────────────────────────────────────────────
 *
 * Twelve animal faces, handed out at random on the profile setup screen so that
 * somebody who skips the photo step still has a face.
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 *
 * The setup form has never required a photo, and `users/{uid}.photoUrl` is only
 * written when one was actually uploaded — so skipping it left `photoUrl` as ""
 * permanently. Every list in the app (Discover, Messages, the live grid, the
 * gift leaderboards) then fell back to a coloured gradient with a letter in it.
 * A feed of initials is a feed nobody taps.
 *
 * ── THE `photoUrl` CONVENTION ────────────────────────────────────────────────
 *
 *     photoUrl = "avatar:<id>"      e.g. "avatar:fox"
 *
 * Not a URL, on purpose: there is nothing to upload and nothing to download, so
 * there is no Storage object, no egress and no broken link when a bucket is
 * re-pointed. The id is stable for the life of the app — renaming one silently
 * changes the face of everybody who is wearing it.
 *
 * Any code that renders a `photoUrl` has to cope with this value. Rather than
 * ask twenty-odd call sites to remember, [DefaultAvatarMapper] is registered on
 * the application-wide Coil `ImageLoader` (see ZipperApp.onCreate), which turns
 * "avatar:fox" into the drawable before any fetcher sees it. Every `AsyncImage`
 * in the app therefore resolves it for free. [avatarModel] is here for the few
 * places that need to resolve one by hand — a Compose preview, a notification,
 * anything not going through that loader.
 *
 * Unknown ids resolve to a deterministic member of the set rather than to
 * nothing: a client on an older build must not render an empty circle because a
 * newer one wrote an avatar it has never heard of.
 *
 * They are vector drawables, not bitmaps — a dozen PNGs at every density is the
 * kind of thing that quietly adds megabytes to an APK, and these are flat shapes
 * that lose nothing by being drawn at runtime.
 */

/** The prefix that marks a `photoUrl` as one of the built-in avatars. */
const val DEFAULT_AVATAR_SCHEME = "avatar:"

enum class DefaultAvatar(
    /** Stored in Firestore. Never rename one of these. */
    val id: String,
    @DrawableRes val res: Int,
) {
    Fox("fox", R.drawable.avatar_fox),
    Panda("panda", R.drawable.avatar_panda),
    Cat("cat", R.drawable.avatar_cat),
    Owl("owl", R.drawable.avatar_owl),
    Frog("frog", R.drawable.avatar_frog),
    Penguin("penguin", R.drawable.avatar_penguin),
    Bear("bear", R.drawable.avatar_bear),
    Bunny("bunny", R.drawable.avatar_bunny),
    Tiger("tiger", R.drawable.avatar_tiger),
    Horse("horse", R.drawable.avatar_horse),
    Bird("bird", R.drawable.avatar_bird),
    Monkey("monkey", R.drawable.avatar_monkey);

    /** Exactly what gets written to `users/{uid}.photoUrl`. */
    val photoUrl: String get() = DEFAULT_AVATAR_SCHEME + id

    companion object {
        /**
         * `values().toList()` once, not on every lookup — [fromPhotoUrl] runs on
         * every image load in the app once the mapper is registered.
         */
        val ALL: List<DefaultAvatar> by lazy { DefaultAvatar.values().toList() }

        fun random(): DefaultAvatar = ALL[Random.nextInt(ALL.size)]

        /** A different one from [current]. The shuffle button never no-ops. */
        fun randomOtherThan(current: DefaultAvatar): DefaultAvatar {
            val others = ALL.filter { it != current }
            if (others.isEmpty()) return current
            return others[Random.nextInt(others.size)]
        }

        /**
         * The avatar a stored `photoUrl` refers to, or null if the string is a
         * real URL (or blank) and should be loaded normally.
         *
         * An `avatar:` value whose id is not in the set still returns something:
         * see the note at the top of the file about older clients.
         */
        fun fromPhotoUrl(photoUrl: String?): DefaultAvatar? {
            if (photoUrl == null || !photoUrl.startsWith(DEFAULT_AVATAR_SCHEME)) return null
            val id = photoUrl.removePrefix(DEFAULT_AVATAR_SCHEME).trim().lowercase()
            ALL.firstOrNull { it.id == id }?.let { return it }
            // Stable per id, so one unrecognised avatar does not change face
            // between two renders on the same screen.
            return ALL[(id.hashCode() and 0x7fffffff) % ALL.size]
        }
    }
}

/**
 * Turns `photoUrl = "avatar:fox"` into the drawable resource, for anything that
 * asks Coil for an image.
 *
 * Registered first on the application's `ImageLoader`, so it runs before Coil's
 * own `StringMapper`; the `Int` it returns is then picked up by Coil's
 * `ResourceIntMapper`. Returning null leaves the data untouched, which is what a
 * normal https photo URL needs.
 */
class DefaultAvatarMapper : Mapper<String, Int> {
    override fun map(data: String, options: Options): Int? =
        DefaultAvatar.fromPhotoUrl(data)?.res
}

/**
 * The model to hand an `AsyncImage` for a stored `photoUrl`, resolved by hand.
 *
 * Only needed away from the app's shared `ImageLoader` — previews, tests, and
 * any surface that builds its own loader. Returns null for a blank photoUrl so
 * the caller can fall through to its placeholder.
 */
fun avatarModel(photoUrl: String?): Any? = when {
    photoUrl.isNullOrBlank() -> null
    else -> DefaultAvatar.fromPhotoUrl(photoUrl)?.res ?: photoUrl
}

/** The avatar itself, drawn from the vector. Square; clip it where you use it. */
@Composable
fun DefaultAvatarImage(
    avatar: DefaultAvatar,
    modifier: Modifier = Modifier,
    contentDescription: String? = "Default avatar",
) {
    Image(
        painter = painterResource(avatar.res),
        contentDescription = contentDescription,
        contentScale = ContentScale.Crop,
        modifier = modifier,
    )
}
