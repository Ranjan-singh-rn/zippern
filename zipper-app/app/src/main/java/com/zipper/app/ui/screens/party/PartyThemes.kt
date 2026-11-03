package com.zipper.app.ui.screens.party

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * Party-room backgrounds (B7, 3 Nov 2026) — Zipper's own designs, drawn from the theme id on the room
 * (`ROOM_THEMES` in functions/src/party.ts: the server refuses any other id, so every room is drawable here).
 */
val ROOM_THEMES: List<Pair<String, String>> = listOf(
    "classic" to "Classic",
    "sunset" to "Sunset",
    "ocean" to "Ocean",
    "forest" to "Forest",
    "royal" to "Royal",
    "neon" to "Neon",
    "rose" to "Rose",
)

/** The background for a theme id; an unknown id draws Classic (an older app meeting a newer theme stays usable). */
fun roomThemeBrush(theme: String?): Brush = when (theme) {
    "sunset" -> Brush.verticalGradient(listOf(Color(0xFF2B1036), Color(0xFF7A2E4A), Color(0xFFE0703A)))
    "ocean" -> Brush.verticalGradient(listOf(Color(0xFF041A2F), Color(0xFF0B4F6C), Color(0xFF1B98A6)))
    "forest" -> Brush.verticalGradient(listOf(Color(0xFF0B1F14), Color(0xFF1E4D2B), Color(0xFF3A7D44)))
    "royal" -> Brush.verticalGradient(listOf(Color(0xFF140A2E), Color(0xFF3B1E6E), Color(0xFF7E57C2)))
    "neon" -> Brush.linearGradient(listOf(Color(0xFF0A0A1A), Color(0xFF1A0B3D), Color(0xFF00B8D4), Color(0xFFD500F9)))
    "rose" -> Brush.verticalGradient(listOf(Color(0xFF2A0E18), Color(0xFF6B1E3A), Color(0xFFE57399)))
    else -> Brush.verticalGradient(listOf(Color(0xFF14121F), Color(0xFF1F1B33), Color(0xFF2A2547)))
}
