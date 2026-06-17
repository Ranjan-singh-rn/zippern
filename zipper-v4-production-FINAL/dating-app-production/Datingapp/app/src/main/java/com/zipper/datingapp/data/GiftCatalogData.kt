package com.zipper.datingapp.data

/**
 * Hard-coded gift catalog used as the default when Firestore hasn't loaded yet.
 *
 * Lottie URLs point to the LottieFiles public CDN. For production, upload each
 * .json to Firebase Storage and replace with the gs:// or https:// download URL.
 *
 * Seeder script: `functions/src/seedGifts.ts` — run once to push this catalog
 * into the `gifts` Firestore collection so every client reads it from the cloud.
 */
val availableGifts: List<Gift> = listOf(

    // ── Tier 1 — Casual (10–99 💎) ──────────────────────────────────────────

    Gift(
        id = "1", name = "Rose", category = "REGULAR",
        price = 10, sortOrder = 1,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/rose.png",
        lottieUrl = "https://assets9.lottiefiles.com/packages/lf20_j3oxj2ta.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/rose.mp3",
    ),
    Gift(
        id = "2", name = "Fire", category = "REGULAR",
        price = 20, sortOrder = 2,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/fire.png",
        lottieUrl = "https://assets2.lottiefiles.com/packages/lf20_jvftm4zt.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/fire.mp3",
    ),
    Gift(
        id = "3", name = "Bouquet", category = "REGULAR",
        price = 50, sortOrder = 3,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/bouquet.png",
        lottieUrl = "https://assets5.lottiefiles.com/packages/lf20_lfpby0yp.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/bouquet.mp3",
    ),
    Gift(
        id = "4", name = "Cake", category = "REGULAR",
        price = 99, sortOrder = 4,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/cake.png",
        lottieUrl = "https://assets10.lottiefiles.com/packages/lf20_obhph2.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/cake.mp3",
    ),

    // ── Tier 2 — Popular (100–999 💎) ───────────────────────────────────────

    Gift(
        id = "5", name = "Diamond", category = "PREMIUM",
        price = 199, sortOrder = 5,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/diamond.png",
        lottieUrl = "https://assets3.lottiefiles.com/packages/lf20_ikaU3M.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/diamond.mp3",
    ),
    Gift(
        id = "6", name = "Crown", category = "PREMIUM",
        price = 299, sortOrder = 6,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/crown.png",
        lottieUrl = "https://assets2.lottiefiles.com/packages/lf20_wCl4RK.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/crown.mp3",
    ),
    Gift(
        id = "7", name = "Rocket", category = "PREMIUM",
        price = 499, sortOrder = 7,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/rocket.png",
        lottieUrl = "https://assets5.lottiefiles.com/packages/lf20_M9p23l.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/rocket.mp3",
    ),
    Gift(
        id = "8", name = "Lightning", category = "PREMIUM",
        price = 699, sortOrder = 8,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/lightning.png",
        lottieUrl = "https://assets3.lottiefiles.com/packages/lf20_vBBK7u.json",
        soundUrl   = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/lightning.mp3",
    ),

    // ── Tier 3 — VIP (1000+ 💎) — Full-screen entrance effect ──────────────

    Gift(
        id = "9", name = "Super Car", category = "VIP",
        price = 1000, sortOrder = 9,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/supercar.png",
        lottieUrl = "https://assets1.lottiefiles.com/packages/lf20_fklalxu4.json",
        videoUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/videos/supercar.mp4",
        soundUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/supercar.mp3",
    ),
    Gift(
        id = "10", name = "Private Jet", category = "VIP",
        price = 3000, sortOrder = 10,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/jet.png",
        lottieUrl = "https://assets9.lottiefiles.com/packages/lf20_pKcncK.json",
        videoUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/videos/jet.mp4",
        soundUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/jet.mp3",
    ),
    Gift(
        id = "11", name = "Castle", category = "VIP",
        price = 5000, sortOrder = 11,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/castle.png",
        lottieUrl = "https://assets1.lottiefiles.com/packages/lf20_castle.json",
        videoUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/videos/castle.mp4",
        soundUrl  = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/sounds/castle.mp3",
    ),

    // ── Lucky Gifts — 5% beans, 95% to company ──────────────────────────────

    Gift(
        id = "lucky_1", name = "Lucky Rose",   category = "LUCKY", giftType = GiftType.LUCKY.name,
        price = 10, sortOrder = 20,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/lucky_rose.png",
        lottieUrl = "https://assets9.lottiefiles.com/packages/lf20_j3oxj2ta.json",
    ),
    Gift(
        id = "lucky_2", name = "Lucky Diamond", category = "LUCKY", giftType = GiftType.LUCKY.name,
        price = 99, sortOrder = 21,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/lucky_diamond.png",
        lottieUrl = "https://assets3.lottiefiles.com/packages/lf20_ikaU3M.json",
    ),
    Gift(
        id = "lucky_3", name = "Lucky Crown",   category = "LUCKY", giftType = GiftType.LUCKY.name,
        price = 199, sortOrder = 22,
        thumbnailUrl = "https://cdn.jsdelivr.net/gh/SochitelGroup/zipper-assets@main/gifts/thumbs/lucky_crown.png",
        lottieUrl = "https://assets2.lottiefiles.com/packages/lf20_wCl4RK.json",
    ),
)
