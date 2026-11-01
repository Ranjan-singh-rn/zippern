package com.zipper.app.util

/**
 * FX-13 (RF-19 / DUP-09) — the deterministic id of a self-appeal.
 *
 * `appealMyBan` read "is one pending?" and then `add`ed, so two devices — or
 * this app and the device-key path (`functions/src/quickLogin.ts`) — at the
 * same moment both read "none" and both filed one; a failed read counted as
 * "none" too. An appeal now goes to `self_{uid}_{restriction}` (slot 1) with
 * CREATE semantics: `firestore.rules` allows no update on `appeals`, so a
 * write to an id that already exists is refused. A DECIDED appeal keeps its id
 * (it is history), so a new appeal for the same restriction takes the next
 * slot (`…_2`): whether somebody may appeal again after a refusal is not
 * changed by this.
 *
 * The same derivation as `functions/src/appealIds.ts`; the two must agree, or
 * the app and the device-key path would pick different ids for one
 * restriction. Pure — `AppealIdsTest` runs it.
 */
object AppealIds {

    /**
     * Deterministic slots per restriction. RC: there is no automatic-id
     * fallback after them — the rules accept only these ids.
     */
    const val MAX_SLOTS = 50

    /**
     * Which restriction an appeal is about: the suspension (when suspended) or
     * the ban, stamped with when it was imposed, so a later restriction is a
     * new key. The `…AtMs` values are the account document's `suspendedAt` /
     * `bannedAt` in milliseconds, or null when absent.
     */
    fun restrictionKey(
        isSuspended: Boolean,
        isBanned: Boolean,
        accountState: String?,
        suspendedAtMs: Long?,
        bannedAtMs: Long?,
    ): String {
        val suspended = isSuspended || accountState == "suspended"
        val banned = isBanned || accountState == "banned"
        val kind = when {
            suspended -> "suspension"
            banned -> "ban"
            else -> "restriction"
        }
        val at = if (suspended) suspendedAtMs else bannedAtMs
        return if (at == null) kind else "$kind-$at"
    }

    /** `self_{uid}_{restriction}` for slot 1; `…_{n}` after it. */
    fun selfAppealId(uid: String, restrictionKey: String, slot: Int): String {
        val base = "self_${uid}_$restrictionKey"
        return if (slot <= 1) base else "${base}_$slot"
    }

    /** A pending appeal occupies its slot; a decided one is history. */
    fun occupies(status: String?): Boolean = (status ?: "pending") == "pending"

    /** What one slot holds, as the app reads it: nothing, or an appeal's status and statement. */
    data class SlotRead(val exists: Boolean, val status: String? = null, val statement: String? = null)

    /** Where the next appeal for a restriction goes. */
    sealed interface SlotChoice {
        /** File at [slot]; [decidedStatement] is the decided appeal just before it (null at slot 1). */
        data class Free(val slot: Int, val decidedStatement: String?) : SlotChoice
        /** An appeal for this restriction is still pending: nothing new is filed. */
        data object Pending : SlotChoice
        /** Every slot holds a decided appeal, and the rules accept no other id: nothing is filed. */
        data object Exhausted : SlotChoice
    }

    /**
     * The slot walk `AppealRepository.freeAppealSlot` performs, without Firestore,
     * so `AppealIdsTest` runs it. Slots are read in order through [read]: the
     * first free one is the slot; a pending one stops the walk; a decided one is
     * stepped past and its statement carried forward for the re-appeal check
     * ("another appeal after a decision only with new evidence or a valid
     * reason"). Every slot decided is [SlotChoice.Exhausted] — never an
     * automatic id.
     */
    inline fun chooseSlot(read: (slot: Int) -> SlotRead): SlotChoice {
        var previous: String? = null
        for (n in 1..MAX_SLOTS) {
            val seen = read(n)
            if (!seen.exists) return SlotChoice.Free(n, previous)
            if (occupies(seen.status)) return SlotChoice.Pending
            previous = seen.statement.orEmpty()
        }
        return SlotChoice.Exhausted
    }
}
