package com.zipper.app.ui.screens.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.zipper.app.data.model.PublicProfile
import com.zipper.app.data.repository.DiscoverRepository
import com.zipper.app.data.repository.ProfileRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

// ── Filter state ──────────────────────────────────────────────────────────────

data class HomeFilters(
    val country: String = "",
    val languageCode: String = "",
    val hobbies: Set<String> = emptySet(),
    val likes: Set<String> = emptySet(),
    /** Hot tab — verified hosts only. "Featured means vouched for." */
    val verifiedHostsOnly: Boolean = false,
) {
    val isActive get() = country.isNotBlank() || languageCode.isNotBlank()
        || hobbies.isNotEmpty() || likes.isNotEmpty() || verifiedHostsOnly
}

// ── UI state ──────────────────────────────────────────────────────────────────

data class HomeUiState(
    /**
     * The feed. `PublicProfile`, not `User`: the old feed deserialised whole
     * user documents — phone number, email, date of birth, device id, FCM
     * token, diamond and bean balances — for twenty strangers at a time.
     */
    val users: List<PublicProfile> = emptyList(),
    val isLoading: Boolean = true,
    val isLoadingMore: Boolean = false,
    val hasMore: Boolean = true,
    val error: String? = null,
    // Current user
    val currentUserDiamonds: Long = 0L,
    // Search
    val showSearchBar: Boolean = false,
    val searchQuery: String = "",
    val searchResult: PublicProfile? = null, // non-null = UID search returned a hit
    val searchNotFound: Boolean = false, // UID searched but no user found
    // Filter
    val showFilterSheet: Boolean = false,
    val filters: HomeFilters = HomeFilters(),
)

// ── ViewModel ─────────────────────────────────────────────────────────────────

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val profileRepo: ProfileRepository,
    private val discover: DiscoverRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    /** The current server-filtered page, before blocked/hobby/like narrowing. */
    private val _rawUsers = MutableStateFlow<List<PublicProfile>>(emptyList())

    /** Blocked UIDs — real-time, updated by a second Firestore listener */
    private val _blockedUids = MutableStateFlow<Set<String>>(emptySet())

    private var feedJob: Job? = null
    private var blockedListenerReg: ListenerRegistration? = null
    private var meListenerReg: ListenerRegistration? = null

    /** Current Firestore limit — grows by PAGE_SIZE on each loadMore() call */
    private var currentLimit = PAGE_SIZE

    init {
        attachListener()
        attachBlockedListener()
        attachCurrentUserListener()
    }

    companion object {
        private const val PAGE_SIZE = 20L
    }

    // ── The feed ──────────────────────────────────────────────────────────────
    //
    // Server-side filter and sort, expanding page size. Still a live listener —
    // someone going live moves up while you watch — but the ordering is the
    // server's, so they move up the whole feed rather than the slice already
    // on the device.

    private fun attachListener() {
        val myUid = auth.currentUser?.uid ?: return
        val f = _uiState.value.filters
        feedJob?.cancel()
        feedJob = viewModelScope.launch {
            discover.feed(
                DiscoverRepository.Filters(
                    country = f.country,
                    languageCode = f.languageCode,
                    verifiedHostsOnly = f.verifiedHostsOnly,
                ),
                limit = currentLimit,
            ).collectLatest { page ->
                _rawUsers.value = page.profiles.filter { it.uid != myUid }
                _uiState.update {
                    it.copy(hasMore = page.hasMore, isLoadingMore = false)
                }
                applyFiltersAndSort()
            }
        }
    }

    /** Next page. Widens the live query rather than appending a static one. */
    fun loadMore() {
        val s = _uiState.value
        if (!s.hasMore || s.isLoadingMore || s.isLoading) return
        _uiState.update { it.copy(isLoadingMore = true) }
        currentLimit += PAGE_SIZE
        attachListener()
    }

    // ── Current user listener (diamonds + own info) ───────────────────────────

    private fun attachCurrentUserListener() {
        val myUid = auth.currentUser?.uid ?: return
        meListenerReg = firestore.collection("users").document(myUid)
            .addSnapshotListener { snap, _ ->
                val diamonds = snap?.getLong("diamonds") ?: 0L
                _uiState.update { it.copy(currentUserDiamonds = diamonds) }
            }
    }

    // ── Blocked users listener ────────────────────────────────────────────────

    private fun attachBlockedListener() {
        val myUid = auth.currentUser?.uid ?: return
        blockedListenerReg = firestore.collection("users").document(myUid)
            .collection("blocked")
            .addSnapshotListener { snap, _ ->
                _blockedUids.value = snap?.documents?.map { it.id }?.toSet() ?: emptySet()
                applyFiltersAndSort()
            }
    }

    // ── Narrowing what the query already returned ─────────────────────────────
    //
    // Country, language and the verified-host tab are in the query. Only three
    // things are left to do here, and each has a reason it cannot be:
    //
    //   blocked  — a per-viewer list; the server cannot filter a shared feed by
    //              it without a query per viewer.
    //   hobbies  — Firestore allows one array-contains per query, and language
    //   likes      already spends it. See DiscoverRepository.matchesLocalFacets.
    //
    // There is no sort step. The order is `presenceRank desc, lastSeen desc`
    // from the query, and re-sorting here would only reorder the page.

    private fun applyFiltersAndSort() {
        val filters = _uiState.value.filters
        val blocked = _blockedUids.value

        val result = _rawUsers.value
            .filter { it.uid !in blocked }
            .filter { discover.matchesLocalFacets(it, filters.hobbies, filters.likes) }

        _uiState.update { it.copy(users = result, isLoading = false) }
    }

    // ── Search ────────────────────────────────────────────────────────────────

    fun toggleSearchBar() {
        _uiState.update {
            it.copy(
                showSearchBar = !it.showSearchBar,
                searchQuery = "",
                searchResult = null,
                searchNotFound = false,
            )
        }
    }

    fun onSearchQueryChange(query: String) {
        _uiState.update {
            it.copy(searchQuery = query, searchResult = null, searchNotFound = false)
        }
    }

    /** Exact UID lookup — user taps the search keyboard action */
    fun searchByUid(uid: String) {
        val myUid = auth.currentUser?.uid ?: return
        val trimmed = uid.trim()
        if (trimmed.isBlank()) return
        // Can't search own ID
        if (trimmed == myUid) {
            _uiState.update { it.copy(searchNotFound = true) }
            return
        }
        viewModelScope.launch {
            // Reads the projection, so searching for someone by id no longer
            // returns their phone number and balances along with their name.
            // A profile absent from publicProfiles is incomplete, banned or
            // deleted — all of which should read as "not found".
            val hit = discover.findByUid(trimmed)
            if (hit == null) {
                _uiState.update { it.copy(searchNotFound = true) }
            } else {
                _uiState.update { it.copy(searchResult = hit, searchNotFound = false) }
            }
        }
    }

    fun clearSearch() {
        _uiState.update {
            it.copy(
                searchQuery = "",
                searchResult = null,
                searchNotFound = false,
                showSearchBar = false,
            )
        }
        applyFiltersAndSort()
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    fun toggleFilterSheet() {
        _uiState.update { it.copy(showFilterSheet = !it.showFilterSheet) }
    }

    // Country, language and the verified tab change the QUERY, so they
    // reattach it. Hobbies and likes narrow what is already loaded and do not.

    fun setCountryFilter(country: String) {
        _uiState.update { it.copy(filters = it.filters.copy(country = country), isLoading = true) }
        restartFeed()
    }

    fun setLanguageFilter(code: String) {
        _uiState.update { it.copy(filters = it.filters.copy(languageCode = code), isLoading = true) }
        restartFeed()
    }

    fun setVerifiedHostsOnly(on: Boolean) {
        _uiState.update { it.copy(filters = it.filters.copy(verifiedHostsOnly = on), isLoading = true) }
        restartFeed()
    }

    /** A changed query starts from page one — the old cursor means nothing. */
    private fun restartFeed() {
        currentLimit = PAGE_SIZE
        attachListener()
    }

    fun toggleHobbyFilter(hobby: String) {
        val updated = _uiState.value.filters.hobbies.let {
            if (hobby in it) it - hobby else it + hobby
        }
        _uiState.update { it.copy(filters = it.filters.copy(hobbies = updated)) }
        applyFiltersAndSort()
    }

    fun toggleLikeFilter(like: String) {
        val updated = _uiState.value.filters.likes.let {
            if (like in it) it - like else it + like
        }
        _uiState.update { it.copy(filters = it.filters.copy(likes = updated)) }
        applyFiltersAndSort()
    }

    fun clearFilters() {
        _uiState.update { it.copy(filters = HomeFilters(), isLoading = true) }
        restartFeed()
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCleared() {
        super.onCleared()
        feedJob?.cancel()
        blockedListenerReg?.remove()
        meListenerReg?.remove()
    }
}
