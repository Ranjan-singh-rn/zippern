package com.zipper.app.data.model

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * O8 (5 Nov 2026) — daily tasks as the app shows them. The Owner sets the tasks in the CRM (`appConfig/dailyTasks`);
 * the server counts today's progress (`users/{uid}/dailyTasks/{YYYY-MM-DD}`, the IST day) from its own records and
 * pays a task once, through `claimDailyTask`. The app only reads and asks. Pure — `DailyTasksTest` runs it on the JVM.
 */
data class DailyTaskDef(
    val id: String,
    val title: String,
    val audience: String,   // everyone | users | hosts
    val metric: String,
    val target: Long,
    val rewardDiamonds: Long,
    val rewardBeans: Long,
    val enabled: Boolean,
    val order: Int,
)

data class DailyTaskRow(
    val def: DailyTaskDef,
    val progress: Long,
    val claimed: Boolean,
) {
    val done: Boolean get() = progress >= def.target
    val canClaim: Boolean get() = done && !claimed
    /** 0..1 for the bar. */
    val fraction: Float get() = if (def.target <= 0) 1f else (progress.toFloat() / def.target).coerceIn(0f, 1f)
}

object DailyTasks {
    /** The unit a measure counts in, for "3 / 5 gifts". */
    val UNITS: Map<String, String> = mapOf(
        "daily_checkin" to "times", "send_gifts" to "gifts", "gift_diamonds" to "diamonds", "call_minutes" to "minutes",
        "watch_live_minutes" to "minutes", "party_minutes" to "minutes", "party_joins" to "rooms", "dm_people" to "people",
        "live_minutes" to "minutes", "gifts_received" to "gifts", "beans_earned" to "beans", "call_minutes_received" to "minutes",
    )

    /** Today's key in IST — the same as the server's `istDateKey` (YYYY-MM-DD). */
    fun istDateKey(nowMs: Long = System.currentTimeMillis()): String {
        val c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Kolkata"), Locale.ROOT).apply { timeInMillis = nowMs }
        return String.format(Locale.ROOT, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    private fun num(v: Any?): Long = when (v) { is Number -> v.toLong(); is String -> v.toLongOrNull() ?: 0L; else -> 0L }

    /** The config document as the server keeps it; anything unusable is skipped (the server sanitised it already). */
    fun parseConfig(data: Map<String, Any?>?): Pair<Boolean, List<DailyTaskDef>> {
        if (data == null) return false to emptyList()
        val on = data["enabled"] == true
        val list = (data["tasks"] as? List<*>).orEmpty().mapNotNull { raw ->
            val t = raw as? Map<*, *> ?: return@mapNotNull null
            val id = t["id"] as? String ?: return@mapNotNull null
            val metric = t["metric"] as? String ?: return@mapNotNull null
            if (metric !in UNITS) return@mapNotNull null
            DailyTaskDef(
                id = id,
                title = (t["title"] as? String).orEmpty().ifBlank { id },
                audience = (t["audience"] as? String) ?: "everyone",
                metric = metric,
                target = num(t["target"]).coerceAtLeast(1L),
                rewardDiamonds = num(t["rewardDiamonds"]).coerceAtLeast(0L),
                rewardBeans = num(t["rewardBeans"]).coerceAtLeast(0L),
                enabled = t["enabled"] != false,
                order = num(t["order"]).toInt(),
            )
        }
        return on to list.sortedWith(compareBy<DailyTaskDef> { it.order }.thenBy { it.id })
    }

    fun audienceMatches(audience: String, isHost: Boolean): Boolean = when (audience) {
        "hosts" -> isHost
        "users" -> !isHost
        else -> true
    }

    /** The rows this person sees today: switched-on tasks for their audience, with progress and what was claimed. */
    fun rows(enabled: Boolean, defs: List<DailyTaskDef>, progress: Map<String, Any?>?, isHost: Boolean): List<DailyTaskRow> {
        if (!enabled) return emptyList()
        val claimed = (progress?.get("claimed") as? Map<*, *>).orEmpty().keys.map { it.toString() }.toSet()
        return defs.filter { it.enabled && audienceMatches(it.audience, isHost) }.map { d ->
            DailyTaskRow(d, num(progress?.get(d.metric)).coerceAtLeast(0L), d.id in claimed)
        }
    }

    /** "20 💎" / "300 beans" / "20 💎 + 300 beans". */
    fun rewardText(d: DailyTaskDef): String = listOfNotNull(
        if (d.rewardDiamonds > 0) "${d.rewardDiamonds} 💎" else null,
        if (d.rewardBeans > 0) "${d.rewardBeans} beans" else null,
    ).joinToString(" + ")
}
