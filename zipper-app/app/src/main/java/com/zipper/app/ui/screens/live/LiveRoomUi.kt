package com.zipper.app.ui.screens.live

/**
 * B12 (4 Nov 2026) — the live screens' words and small decisions, kept out of the composables so
 * `LiveRoomUiTest` can run them on the JVM.
 */
object LiveRoomUi {
    const val MUTED_NOTICE = "The host has muted you in this live's chat. You can keep watching."
    const val MUTED_PLACEHOLDER = "You're muted in this chat"
    const val PAUSED_TITLE = "Live paused"
    const val PAUSED_BODY = "The host will be right back."
    const val HOST_VIDEO_LOST = "The host's connection dropped — waiting for them to come back…"
    const val RECONNECTING = "Reconnecting…"
    const val CONNECTION_LOST = "Connection lost. Check your internet."
    const val PINNED_MAX = 140
    const val COMMENT_MAX = 300

    /** The host's pinned message as it will be stored: trimmed, at most [PINNED_MAX] characters. */
    fun pinned(text: String): String = text.trim().take(PINNED_MAX)

    /**
     * The PK verdict, from this room's side (the server writes it on both rooms, each from its own side):
     * "Asha won the PK 1,200 to 900", "Asha lost the PK 300 to 1,000", "The PK ended in a draw (500 each)".
     */
    fun pkVerdict(hostName: String, hostUid: String, winnerUid: String, myScore: Long, partnerScore: Long): String {
        val name = hostName.trim().ifEmpty { "The host" }
        return when {
            winnerUid.isBlank() -> "The PK ended in a draw (${group(myScore)} each)"
            winnerUid == hostUid -> "$name won the PK ${group(myScore)} to ${group(partnerScore)}"
            else -> "$name lost the PK ${group(myScore)} to ${group(partnerScore)}"
        }
    }

    /** Duration as the end-of-live card reads it: "1h 05m", "12m 03s", "45s". */
    fun duration(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return when {
            h > 0 -> "${h}h ${m.toString().padStart(2, '0')}m"
            m > 0 -> "${m}m ${sec.toString().padStart(2, '0')}s"
            else -> "${sec}s"
        }
    }

    /** Indian digit grouping: 1,23,456. */
    fun group(n: Long): String {
        val neg = n < 0
        val s = kotlin.math.abs(n).toString()
        if (s.length <= 3) return (if (neg) "-" else "") + s
        val last3 = s.takeLast(3)
        var rest = s.dropLast(3)
        val parts = ArrayList<String>()
        while (rest.length > 2) { parts.add(0, rest.takeLast(2)); rest = rest.dropLast(2) }
        if (rest.isNotEmpty()) parts.add(0, rest)
        return (if (neg) "-" else "") + parts.joinToString(",") + "," + last3
    }
}
