package com.zipper.app.data.model

data class BagItem(
    val id: String = "",
    val name: String = "",
    val category: String = "",
    val previewUrl: String = "",
    val isOwned: Boolean = false,
    val isEquipped: Boolean = false,
    val unlockLevel: Int = 0,
    val price: Int = 0,
    val source: String = "marketplace",
    val animationAsset: String = "",   // local asset path (fallback)
    val animationUrl: String = "",     // Firebase Storage URL (preferred)
    val targetGender: String = "all",   // "all" | "male" | "female"
    val targetRole: String = "all",     // "all" | "user" | "host" (strict exclusive)
    val targetUserId: String = "",      // if non-empty, ONLY this account can have this item
    /**
     * Minimum HOST level required to own this item. 0 = no host gate.
     *
     * The CRM has written this field since July (app-config/bag-items) and
     * MyBagViewModel has read it since July, but the model never had it — so
     * the module did not compile. Appended rather than inserted, because at the
     * time BagItem was also built positionally ~40 times in MyBagViewModel's
     * invented default catalogue, and a mid-struct field would have rebound
     * price to minHostLevel and source to price. That catalogue is gone; every
     * construction is now by named argument from Firestore.
     */
    val minHostLevel: Int = 0,
    /**
     * H.264 MP4 of the animation, in Firebase Storage. The preferred source.
     *
     * `animationUrl` points at the old image-sequence Lottie — a full-screen
     * picture per frame, base64'd into JSON, 22 MB for `en_jet` and about two
     * gigabytes of bitmap once decoded. Nothing plays those any more; they are
     * left in the field so a rollback has something to fall back to, and so the
     * CRM does not have to be migrated in the same breath as the app.
     */
    val videoUrl: String = "",
    /** B13: the SVGA animation (tools/decor) — frames and entrances that move over live video, transparent. */
    val svgaUrl: String = "",
    /** O9 (5 Nov 2026): colours from the CRM, "#RRGGBB,#RRGGBB" — chat bubbles, cards, ID frames, plain frames. */
    val style: String = "",

    // ── This account's copy of the item, and the terms on offer ──────────────
    //
    // The next three are not catalogue data: they are merged in from
    // `users/{uid}/ownedItems/{itemId}` and are meaningless on a catalogue row
    // the user does not own. `durations`, at the end, is the opposite — it comes
    // from the catalogue and says nothing about what this account holds.
    //
    // Before they existed the bag had no time concept at all, while the server
    // had had one since `purchaseBagItem` started writing `expiresAt`. So the
    // sheet told every buyer of a 28-day frame that its duration was "Eternal",
    // and `isOwned` stayed true forever because it was derived from the mere
    // presence of the document id — which `expireCosmetics` marks but never
    // deletes.
    /**
     * When this account's copy lapses, in epoch millis. 0 means permanent, or
     * not owned at all.
     */
    val expiresAt: Long = 0L,
    /**
     * The copy has lapsed.
     *
     * Merged from the owned row's `expired` flag OR'd with an [expiresAt] that
     * is already in the past, because the flag is only flipped by an hourly
     * sweep (`expireCosmetics`) and an item that lapsed forty minutes ago is
     * lapsed regardless of what the flag still says.
     */
    val expired: Boolean = false,
    /**
     * The term the last purchase or renewal bought, in days. 0 = permanent, or
     * a row written before the server recorded it.
     *
     * Kept alongside [expiresAt] because "28 days" and "4 days left" are
     * different facts and a renewal screen has to state both — the remaining
     * days alone cannot tell the user what they are about to buy.
     */
    val durationDaysTotal: Int = 0,
    /**
     * The terms the CRM offers for this item, priced per term.
     *
     * Empty means one price and no expiry — `purchaseBagItem` charges `price`
     * and writes a null expiry. When it is not empty the server prices the
     * CHOSEN row and refuses a term it does not list, so the client must send
     * back one of these and not a duration of its own invention.
     */
    val durations: List<BagDuration> = emptyList(),
) {
    /** A timed copy, so renewing it means something. */
    val isTimed: Boolean get() = expiresAt > 0L

    /**
     * Whole days until this copy lapses, rounded UP, never negative.
     *
     * Rounded up so the last partial day reads "1 day left" rather than
     * "0 days left" for its final twenty-three hours — the user still owns it,
     * and a zero would read as already gone.
     */
    fun daysLeftAt(nowMs: Long): Int {
        if (expiresAt <= nowMs) return 0
        return ((expiresAt - nowMs + DAY_MS - 1) / DAY_MS).toInt()
    }
}

/**
 * One row of the CRM's duration matrix: `bagItems/{id}.durations`.
 *
 * `priceDiamonds` mirrors the server's `chosen.priceGems ?? chosen.price` — the
 * field is written under two names and the app must read whichever is there, or
 * the picker quotes 0 diamonds for a term that costs 900.
 */
data class BagDuration(
    val days: Int = 0,
    val priceDiamonds: Int = 0,
)

/**
 * A row of `users/{uid}/ownedItems/{itemId}` — what this account actually holds.
 *
 * The bag used to read only the document ids out of this collection, which is
 * why an expired cosmetic still counted as owned: `expireCosmetics` writes
 * `{ expired: true, expiredAt }` and leaves the row in place, so the id survives
 * the expiry that it records.
 */
data class OwnedItem(
    val itemId: String = "",
    val category: String = "",
    /** Epoch millis. 0 means permanent — the server writes null for those. */
    val expiresAt: Long = 0L,
    val expired: Boolean = false,
    /** Days bought, as the last purchase or renewal set them. 0 = permanent. */
    val durationDaysTotal: Int = 0,
) {
    /**
     * Has this lapsed as of [nowMs]?
     *
     * Both halves are needed. The flag alone is up to an hour stale, because
     * `expireCosmetics` runs hourly; the timestamp alone misses nothing, but
     * trusting only it would ignore a row the server has deliberately marked.
     */
    fun isExpiredAt(nowMs: Long): Boolean =
        expired || (expiresAt > 0L && expiresAt <= nowMs)
}

private const val DAY_MS = 24L * 60 * 60 * 1000
