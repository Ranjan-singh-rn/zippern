package com.zipper.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.tasks.await
import java.util.concurrent.ConcurrentHashMap

/**
 * B13 (4 Nov 2026) — a cosmetic's artwork, from its catalogue id.
 *
 * `users/{uid}.equippedFrame` (and the other `equipped*` pointers) hold the bag item's ID — `equipBagItem` writes the
 * id, never a URL — but the profile screens handed that id straight to `Avatar(frameUrl = …)`, where Coil tried to
 * load "frame_gold_01" as an image and drew nothing. So no equipped frame was ever visible on a profile. This
 * resolves the id to the item's artwork once, from the public `bagItems` catalogue, and caches it for the session.
 */
data class Cosmetic(
    val id: String,
    val imageUrl: String,
    val previewUrl: String,
    val svgaUrl: String,
    val videoUrl: String,
    // O9 (5 Nov 2026): the rest of what decides how an item is drawn (see Decor.kt) — no new build for a new item.
    val category: String = "",
    val name: String = "",
    /** A Lottie bundled in the app (`anim/…json`), for the starter set. */
    val animationAsset: String = "",
    /** A Lottie from the CRM (Storage URL). */
    val animationUrl: String = "",
    /** Colours, "#RRGGBB,#RRGGBB" — chat bubbles, profile cards, ID frames, plain frames. */
    val style: String = "",
    /** How much larger than the avatar the CRM says this frame is drawn (B13a); 0 = the default. */
    val frameScale: Float = 0f,
) {
    /** The best still for this item. */
    val stillUrl: String get() = imageUrl.ifBlank { previewUrl }
}

object CosmeticsCatalog {
    private val cache = ConcurrentHashMap<String, Cosmetic>()

    fun peek(id: String): Cosmetic? = cache[id]

    suspend fun get(id: String): Cosmetic? {
        if (id.isBlank()) return null
        cache[id]?.let { return it }
        val snap = FirebaseFirestore.getInstance().collection("bagItems").document(id).get().await()
        if (!snap.exists()) return null
        val c = Cosmetic(
            id = id,
            imageUrl = snap.getString("imageUrl").orEmpty(),
            previewUrl = snap.getString("previewUrl").orEmpty(),
            svgaUrl = snap.getString("svgaUrl").orEmpty(),
            videoUrl = snap.getString("videoUrl").orEmpty(),
            category = snap.getString("category").orEmpty(),
            name = snap.getString("name").orEmpty(),
            animationAsset = snap.getString("animationAsset").orEmpty(),
            animationUrl = snap.getString("animationUrl").orEmpty(),
            style = snap.getString("style").orEmpty(),
            frameScale = (snap.getDouble("frameScale") ?: 0.0).toFloat(),
        )
        cache[id] = c
        return c
    }
}

/** The cosmetic for [id], or null while it loads (or when there is none). */
@Composable
fun rememberCosmetic(id: String?): Cosmetic? {
    var c by remember(id) { mutableStateOf(id?.takeIf { it.isNotBlank() }?.let { CosmeticsCatalog.peek(it) }) }
    LaunchedEffect(id) {
        if (!id.isNullOrBlank() && c == null) c = try { CosmeticsCatalog.get(id) } catch (_: Exception) { null }
    }
    return c
}
