package com.zipper.app.util

/**
 * Compact number formatter using Indian units: K / L (Lakh) / Cr (Crore).
 *
 * Examples:
 *   999      → "999"
 *   1 000    → "1K"
 *   12 000   → "12K"
 *   1 00 000 → "1L"
 *   2 50 000 → "2.5L"
 *  10 00 000 → "10L"
 *  1 00 00 000 → "1Cr"
 */
fun formatCount(n: Long): String = when {
    n >= 1_00_00_000L -> "%.1fCr".format(n / 1_00_00_000.0)
    n >= 1_00_000L    -> "%.1fL".format(n / 1_00_000.0)
    n >= 1_000L       -> "%.0fK".format(n / 1_000.0)
    else              -> n.toString()
}

fun formatCount(n: Int): String = formatCount(n.toLong())
