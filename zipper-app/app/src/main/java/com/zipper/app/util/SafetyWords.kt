package com.zipper.app.util

import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.tasks.await
import java.text.Normalizer

/**
 * O13 (Owner, 5 Nov 2026) — "no nudity, sexualism or vulgarity in the rooms". The same word check the server runs
 * (functions/src/safety.ts `findBadWords`), on the phone, BEFORE a message is sent: the person is told and nothing is
 * posted. The server still screens everything that arrives (masks it, counts a strike, silences after the Owner's
 * count) — this is the courtesy, the server is the guard.
 *
 * The built-in list is a copy of `BUILTIN_BAD_WORDS` (a unit test keeps the two equal); the Owner's own words and the
 * built-in switch come from `appConfig/safety`, read once a session.
 */
object SafetyWords {

    /** Keep in step with functions/src/safety.ts — SafetyWordsTest compares them. */
    val BUILT_IN: List<String> = listOf(
        // English — sexual / explicit
        "fuck", "fucker", "fucking", "motherfucker", "cunt", "pussy", "dick", "cock", "boobs", "tits", "nude", "nudes",
        "naked", "porn", "xxx", "sex", "sexchat", "horny", "blowjob", "handjob", "whore", "slut", "bitch", "bastard",
        // Hinglish
        "madarchod", "maderchod", "behenchod", "bhenchod", "bhanchod", "chutiya", "chutiye", "chutia", "bhosdike",
        "bhosdi", "bhosda", "gandu", "gaandu", "lund", "lauda", "lawda", "randi", "chut", "gaand", "harami", "chodna",
        "chudai", "nangi",
        // Hindi
        "मादरचोद", "बहनचोद", "चूतिया", "भोसड़ी", "भोसड़ीके", "गांडू", "लंड", "रंडी", "चूत", "गांड", "हरामी", "नंगी", "चुदाई",
    )

    /** Words this long or longer also match inside squeezed-together text (as on the server). */
    const val SQUEEZE_MIN = 6

    /** What a person is told when a message is held back. */
    const val HELD_NOTICE = "Please keep it respectful — that word isn't allowed in ZIPPER."

    private val LEET = mapOf('0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's', '7' to 't', '@' to 'a', '$' to 's', '!' to 'i')
    private val NON_LETTERS = Regex("[^\\p{L}\\p{M}]+")
    private val REPEATS = Regex("(\\p{L})\\1+")

    @Volatile private var ownerWords: List<String> = emptyList()
    @Volatile private var useBuiltIn: Boolean = true
    @Volatile private var loaded = false

    fun normalize(text: String): String {
        val lower = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFKC)
        val mapped = buildString(lower.length) { lower.forEach { append(LEET[it] ?: it) } }
        return mapped.replace(NON_LETTERS, " ").trim()
    }

    fun fold(s: String): String = s.replace(REPEATS, "$1")

    /** The words of [list] in [text] — whole tokens, spaced-out letters, and (for long words) squeezed text. */
    fun find(text: String, list: List<String>): List<String> {
        val norm = normalize(text)
        if (norm.isEmpty()) return emptyList()
        val parts = norm.split(' ')
        val tokens = parts.map(::fold).toMutableSet()
        var run = StringBuilder()
        for (p in parts + "") {
            if (p.length == 1) { run.append(p); continue }
            if (run.length >= 2) tokens += fold(run.toString())
            run = StringBuilder()
        }
        val squeezed = fold(norm.replace(" ", ""))
        val hits = LinkedHashSet<String>()
        for (raw in list) {
            val w = normalize(raw).replace(" ", "")
            if (w.isEmpty()) continue
            val f = fold(w)
            if (f in tokens || (w.length >= SQUEEZE_MIN && squeezed.contains(f))) hits += w
        }
        return hits.toList()
    }

    /** The list this phone checks against right now. */
    fun currentList(): List<String> = ((if (useBuiltIn) BUILT_IN else emptyList()) + ownerWords).distinct()

    /** True when [text] may be sent. */
    fun allowed(text: String): Boolean = find(text, currentList()).isEmpty()

    /** Read the Owner's words once a session; a failure keeps the built-in list (never blocks sending outright). */
    suspend fun ensureLoaded(firestore: FirebaseFirestore) {
        if (loaded) return
        try {
            val doc = firestore.collection("appConfig").document("safety").get().await()
            ownerWords = (doc.get("badWords") as? List<*>).orEmpty()
                .mapNotNull { (it as? String)?.trim()?.lowercase() }
                .filter { it.length in 2..40 }
                .take(500)
            useBuiltIn = doc.getBoolean("useBuiltInWords") != false
            loaded = true
        } catch (_: Exception) {
            // Offline or refused: the built-in list still applies.
        }
    }
}
