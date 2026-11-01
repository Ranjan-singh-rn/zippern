package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.LuckyCombos
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * `appConfig/luckyGifts`, as the gift sheet needs it: whether lucky gifts are
 * on at all, the combos to offer and the receiver's share to explain.
 *
 * READ ONLY, and only the fields the sheet draws. The odds table is in the
 * same document and is deliberately not read: the client has no use for it
 * that is not a way to second-guess the server's roll, and a sheet that showed
 * "84% chance of 5×" would be advertising odds the CRM can change under it.
 *
 * `enabled` is the Owner's switch (off until legal clearance under the Online
 * Gaming Act 2025). It is OFF unless the document says exactly `true` — an
 * absent or unreadable document is off — which is the server's own rule: it
 * refuses every lucky send while the switch is off (`LUCKY_GIFTS_DISABLED`).
 *
 * Cached for the process; the gift sheet re-reads it each time it opens
 * (`LuckyGiftConfigViewModel.refresh`). The CRM bumps `version` on every save
 * and the server reads the document inside each settlement, so a stale value
 * here costs one refused send with the server's own sentence, never a wrong
 * charge.
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
        /**
         * The Owner's switch. False by default — and for an absent or
         * unreadable document — so a lucky gift shows as unavailable until
         * the server's document says otherwise.
         */
        val enabled: Boolean = false,
    )

    @Volatile
    private var cached: Config? = null

    /** The configuration, or the defaults (switch OFF) when the document is absent or unreadable. */
    suspend fun get(): Config {
        cached?.let { return it }
        val cfg = try {
            val snap = firestore.collection("appConfig").document("luckyGifts").get().await()
            if (!snap.exists()) Config()
            else Config(
                combos = LuckyCombos.parse(snap.get("combos")),
                receiverPct = (snap.get("receiverPct") as? Number)?.toInt()?.coerceIn(0, 100) ?: 5,
                version = (snap.get("version") as? Number)?.toLong() ?: 0L,
                enabled = LuckyCombos.parseEnabled(snap.get("enabled")),
            )
        } catch (_: Exception) {
            Config()
        }
        cached = cfg
        return cfg
    }

    /** Forget the cache, so the next read goes to the document. */
    fun invalidate() { cached = null }
}
