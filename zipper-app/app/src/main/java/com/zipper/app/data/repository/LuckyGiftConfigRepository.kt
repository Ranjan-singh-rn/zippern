package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.LuckyCombos
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * `appConfig/luckyGifts`, as the gift sheet needs it: the combos to offer and
 * the receiver's share to explain.
 *
 * READ ONLY, and only the two fields the sheet draws. The odds table is in the
 * same document and is deliberately not read: the client has no use for it
 * that is not a way to second-guess the server's roll, and a sheet that showed
 * "84% chance of 5×" would be advertising odds the CRM can change under it.
 *
 * Cached for the process. The CRM bumps `version` on every save and the server
 * reads the document inside each settlement, so a stale combo here costs one
 * refused send with the server's own sentence, never a wrong charge.
 */
@Singleton
class LuckyGiftConfigRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
) {
    data class Config(
        val combos: List<Int> = LuckyCombos.DEFAULT,
        /** Of `unit × combo`, to beans. Default 5. */
        val receiverPct: Int = 5,
        val version: Long = 0L,
    )

    @Volatile
    private var cached: Config? = null

    /** The configuration, or the defaults when the document is absent or unreadable. */
    suspend fun get(): Config {
        cached?.let { return it }
        val cfg = try {
            val snap = firestore.collection("appConfig").document("luckyGifts").get().await()
            if (!snap.exists()) Config()
            else Config(
                combos = LuckyCombos.parse(snap.get("combos")),
                receiverPct = (snap.get("receiverPct") as? Number)?.toInt()?.coerceIn(0, 100) ?: 5,
                version = (snap.get("version") as? Number)?.toLong() ?: 0L,
            )
        } catch (_: Exception) {
            Config()
        }
        cached = cfg
        return cfg
    }

    /** Forget the cache (after a refused combo, so the next sheet re-reads). */
    fun invalidate() { cached = null }
}
