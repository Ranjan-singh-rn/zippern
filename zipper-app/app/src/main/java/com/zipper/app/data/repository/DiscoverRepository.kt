package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.model.PublicProfile
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The Home feed.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * `HomeViewModel` attached a snapshot listener to `users` with
 * `whereEqualTo("isProfileComplete", true).limit(20)` — **no `orderBy` at all**
 * — and then filtered and sorted the result in Kotlin.
 *
 * Three consequences, all of which a user would have noticed before we did:
 *
 *  - With no ordering, Firestore returns documents in document-id order. Every
 *    user saw roughly the same twenty accounts, in the same order, forever.
 *  - Filters applied to those twenty. Choosing a country did not search for
 *    people in that country; it removed everyone in the sample who was not in
 *    it, usually leaving nothing.
 *  - "Live first" sorted the page, not the platform. Someone going live was
 *    promoted to the top of the twenty they already happened to be in.
 *
 * Filtering and sorting happen in the query now, so they apply to everybody.
 */
@Singleton
class DiscoverRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
) {

    data class Filters(
        val country: String = "",
        val languageCode: String = "",
        /** Verified hosts only — the Hot tab. */
        val verifiedHostsOnly: Boolean = false,
    )

    data class Page(val profiles: List<PublicProfile>, val hasMore: Boolean)

    /**
     * A live page of the feed.
     *
     * Still a snapshot listener, so someone going live moves up the list while
     * you watch — but now the ordering is the server's, so they move up the
     * whole feed and not just the slice already downloaded.
     *
     * Firestore permits one `array-contains` per query, and [Filters] spends it
     * on language. Hobbies and likes stay client-side; see [matchesLocalFacets].
     */
    fun feed(filters: Filters, limit: Long): Flow<Page> = callbackFlow {
        var q: Query = firestore.collection("publicProfiles")
            // Complete, not banned, not deleted. Computed server-side so a
            // banned account cannot linger in the feed until it next writes.
            .whereEqualTo("isListed", true)

        if (filters.country.isNotBlank()) {
            q = q.whereEqualTo("country", filters.country)
        }
        if (filters.languageCode.isNotBlank()) {
            q = q.whereArrayContains("languageCodes", filters.languageCode)
        }
        if (filters.verifiedHostsOnly) {
            q = q.whereEqualTo("isVerifiedHost", true)
        }

        q = q
            // Live → in a party → online → in call → offline, then most recent.
            // One integer because Firestore cannot order across three booleans.
            .orderBy("presenceRank", Query.Direction.DESCENDING)
            .orderBy("lastSeen", Query.Direction.DESCENDING)
            .limit(limit)

        // O10: parsed off the main thread — every listed person's presence change re-sends the page.
        val reg = q.addSnapshotListener(BackgroundListeners.executor) { snap, err ->
            if (err != null || snap == null) {
                // A missing composite index surfaces here. The message carries a
                // console link to create it — worth reading rather than
                // treating as an empty feed.
                trySend(Page(emptyList(), hasMore = false))
                return@addSnapshotListener
            }
            val profiles = snap.documents.mapNotNull { PublicProfile.from(it) }
            trySend(Page(profiles, hasMore = snap.size().toLong() == limit))
        }
        awaitClose { reg.remove() }
    }

    /**
     * Hobbies and likes, applied on the client.
     *
     * Not an oversight: Firestore allows a single `array-contains` per query and
     * language already uses it. Combining them server-side would mean either a
     * composite facet field (one array entry per hobby×like pair, which grows
     * badly) or a search service. Until the feed is large enough to need one,
     * filtering the fetched page is honest and cheap — the page is already
     * ordered and filtered by the query, so this narrows a relevant set rather
     * than an arbitrary one.
     */
    fun matchesLocalFacets(
        p: PublicProfile,
        hobbies: Set<String>,
        likes: Set<String>,
    ): Boolean {
        if (hobbies.isNotEmpty() && p.hobbies.none { it in hobbies }) return false
        if (likes.isNotEmpty() && p.likes.none { it in likes }) return false
        return true
    }

    /** Live view of one profile, for the profile screen and chat headers. */
    fun profileFlow(uid: String): Flow<PublicProfile?> = callbackFlow {
        val reg = firestore.collection("publicProfiles").document(uid)
            .addSnapshotListener { snap, _ ->
                trySend(snap?.let { if (it.exists()) PublicProfile.from(it) else null })
            }
        awaitClose { reg.remove() }
    }

    /**
     * Coin sellers, online first.
     *
     * The Diamond Shop queried `users where isSeller == true` and read whole
     * user documents to render a name and an avatar — which handed every buyer
     * each seller's phone number, email and diamond balance.
     */
    suspend fun sellers(limit: Long = 30): List<PublicProfile> = try {
        firestore.collection("publicProfiles")
            .whereEqualTo("isSeller", true)
            .orderBy("presenceRank", Query.Direction.DESCENDING)
            .orderBy("lastSeen", Query.Direction.DESCENDING)
            .limit(limit)
            .get().await()
            .documents.mapNotNull { PublicProfile.from(it) }
    } catch (_: Exception) { emptyList() }

    /** Exact-id lookup from the search box. */
    suspend fun findByUid(uid: String): PublicProfile? = try {
        val snap = firestore.collection("publicProfiles").document(uid.trim()).get().await()
        if (snap.exists()) PublicProfile.from(snap) else null
    } catch (_: Exception) {
        null
    }
}
