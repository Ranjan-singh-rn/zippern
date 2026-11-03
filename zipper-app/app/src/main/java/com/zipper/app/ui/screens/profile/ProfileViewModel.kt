package com.zipper.app.ui.screens.profile

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.User
import com.zipper.app.data.model.BeanTransaction
import com.zipper.app.data.model.DiamondTransaction
import com.zipper.app.data.repository.GiftHistoryEntry
import com.zipper.app.data.repository.GiftRepository
import com.zipper.app.data.repository.HostStatsRepository
import com.zipper.app.data.repository.MAX_IMAGE_SIZE_BYTES
import com.zipper.app.data.repository.MAX_VIDEO_DURATION_MS
import com.zipper.app.data.repository.MAX_VIDEO_SIZE_BYTES
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.data.repository.ProfileResult
import com.zipper.app.util.UserLanguage
// GiftSummaryItem is in the same package — no import needed
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ProfileUiState(
    val user: User? = null,
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val saveSuccess: Boolean = false,
    val error: String? = null,
    // Edit fields (mirrored from live user doc, edited locally)
    val editName: String = "",
    val editBio: String = "",
    val editCity: String = "",
    val editAge: Int = 0,
    val editLanguages: List<UserLanguage> = emptyList(),
    val editHobbies: List<String> = emptyList(),
    val editLikes: List<String> = emptyList(),
    val editPhotoUri: Uri? = null,
    val editCoverUri: Uri? = null,
    val editCallRate: Int = 375,
    val editDob: Long = 0L,
    // Gallery: existing URLs + thumbs from Firestore (parallel lists) + new local URIs
    val editMediaUrls: List<String> = emptyList(),
    val editMediaThumbs: List<String> = emptyList(), // parallel to editMediaUrls; "" for images
    val editNewMediaUris: List<Uri> = emptyList(),
    // Gift summaries (loaded from Firestore, empty until Phase 6)
    val giftsSent: List<GiftSummaryItem> = emptyList(),
    val giftsReceived: List<GiftSummaryItem> = emptyList(),
    // Wallet transaction histories
    val diamondTransactions: List<DiamondTransaction> = emptyList(),
    val beanTransactions: List<BeanTransaction> = emptyList(),
    /**
     * Beans per diamond, live from the CRM. The convert card previews with this
     * and enforces its multiple. Always a whole number — see the truncation note
     * where it is read, because the server depends on it being the same one.
     */
    val beansPerDiamond: Long = 20L,
    /**
     * What this host may charge, decided by the server.
     *
     * `maxCallRateBeans` already accounts for their level AND their verified
     * status — an unverified host gets 0, because startCall prices them at the
     * base rate whatever their level. Zero therefore means "the rate control
     * should not be offered", which is exactly what the screen needs to know.
     */
    val maxCallRateBeans: Long = 0L,
    val minCallRateBeans: Long = 300L,
    // Social counts
    val followerCount: Int = 0,
    val followingCount: Int = 0,
)

@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val repo: ProfileRepository,
    private val giftRepo: GiftRepository,
    private val beanConversionRepo: com.zipper.app.data.repository.BeanConversionRepository,
    private val economyConfig: com.zipper.app.data.repository.EconomyConfigRepository,
    private val hostStats: com.zipper.app.data.repository.HostStatsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ProfileUiState(isLoading = true))
    val state: StateFlow<ProfileUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            economyConfig.observe().collect { cfg ->
                /*
                 * A WHOLE number of beans per diamond — and the same whole
                 * number the server uses.
                 *
                 * `beanToDiamondRate` is a double in the CRM config, so this
                 * truncation is not a convenience for the UI: `convertBeans`
                 * refuses anything that is not a multiple of the rate, and it
                 * also requires a whole number of beans. Set the rate to 20.5
                 * and a server reading the raw double would refuse every amount
                 * a person could possibly type, while this client went on
                 * offering multiples of 20 — the two ends checking different
                 * numbers, with nothing on either side saying so.
                 *
                 * functions/src/wallet.ts now does `Math.trunc(rawRate)` before
                 * its modulus, which makes truncation the contract rather than a
                 * client-side quirk: both ends floor the same double to the same
                 * integer, so the multiple the convert card enforces is exactly
                 * the multiple the server checks. Truncating rather than
                 * rounding is deliberate on both sides — 20.5 rounded up to 21
                 * would quietly pay the host less than the configured rate.
                 *
                 * The floor of 1 keeps the card's `% rate` and `/ rate` from
                 * dividing by zero when the field is missing or nonsense.
                 */
                val rate = cfg.beanToDiamondRate.toLong().coerceAtLeast(1L)
                _state.update {
                    it.copy(
                        beansPerDiamond = rate,
                        minCallRateBeans = cfg.minHostCallRate,
                    )
                }
            }
        }
        // The ceiling comes from getHostHome rather than a table in this file.
        // It was hardcoded in EditProfileScreen as 700/2000/5000/12000 — a
        // fourth copy of a number that also lives in the CRM config, the level
        // ladder and the functions' fallback, and the only one a host could see.
        viewModelScope.launch {
            when (val res = hostStats.hostHome()) {
                is HostStatsRepository.Result.Ok ->
                    _state.update { it.copy(maxCallRateBeans = res.home.level.maxCallRateBeans) }
                is HostStatsRepository.Result.Failed -> Unit  // not a host
            }
        }
        viewModelScope.launch {
            repo.currentUserFlow().collect { user ->
                _state.update { s ->
                    s.copy(
                        user = user,
                        isLoading = false,
                        // Populate edit fields only when not actively saving
                        editName        = if (s.isSaving) s.editName        else user?.name           ?: "",
                        editBio         = if (s.isSaving) s.editBio         else user?.bio            ?: "",
                        editCity        = if (s.isSaving) s.editCity        else user?.city           ?: "",
                        editAge         = if (s.isSaving) s.editAge         else user?.age            ?: 0,
                        editLanguages   = if (s.isSaving) s.editLanguages   else user?.languages      ?: emptyList(),
                        editHobbies     = if (s.isSaving) s.editHobbies     else user?.hobbies        ?: emptyList(),
                        editLikes       = if (s.isSaving) s.editLikes       else user?.likes          ?: emptyList(),
                        editCallRate    = if (s.isSaving) s.editCallRate    else user?.callRateBeans  ?: 375,
                        editDob         = if (s.isSaving) s.editDob         else user?.dob            ?: 0L,
                        editMediaUrls   = if (s.isSaving) s.editMediaUrls   else user?.mediaUrls      ?: emptyList(),
                        editMediaThumbs = if (s.isSaving) s.editMediaThumbs else user?.mediaThumbs    ?: emptyList(),
                    )
                }
            }
        }

        /*
         * Everything below belongs to ONE account, and which account is decided by Firebase Auth on this device
         * — no network read.
         *
         * A3 (3 Nov 2026): each of these five blocks used to start with `repo.fetchCurrentUser()?.uid`, a one-shot
         * `get()` of the users document, with nothing catching it. Offline (no network, or a session the server
         * no longer accepts, so Firestore's watch stream is refused) and with no cached copy, that `get()` throws
         * "Failed to get document because the client is offline" — and because MainActivity creates this view
         * model at launch, the app crashed a few seconds after opening (prod APK, emulator drop box,
         * 2026-11-03 17:33:40 IST). The listeners only ever needed the uid.
         *
         * Following the auth state also fixes two quieter faults of the same blocks: MainActivity's instance
         * lives for the whole process, so a sign-in after launch never started them; and a sign-out or an
         * account switch left the previous account's gifts, wallet history and counts in the state.
         */
        viewModelScope.launch {
            repo.signedInUidFlow().collectLatest { uid ->
                _state.update {
                    it.copy(
                        followerCount = 0, followingCount = 0,
                        giftsSent = emptyList(), giftsReceived = emptyList(),
                        diamondTransactions = emptyList(), beanTransactions = emptyList(),
                    )
                }
                if (uid == null) return@collectLatest
                coroutineScope {
                    launch {
                        val followers = repo.getFollowerCount(uid)
                        val following = repo.getFollowingCount(uid)
                        _state.update { it.copy(followerCount = followers, followingCount = following) }
                    }
                    launch {
                        giftRepo.giftsSentFlow(uid).collect { entries ->
                            _state.update { it.copy(giftsSent = entries.toGiftSummary()) }
                        }
                    }
                    launch {
                        giftRepo.giftsReceivedFlow(uid).collect { entries ->
                            _state.update { it.copy(giftsReceived = entries.toGiftSummary()) }
                        }
                    }
                    launch {
                        repo.diamondTransactionsFlow(uid).collect { txs ->
                            _state.update { it.copy(diamondTransactions = txs) }
                        }
                    }
                    launch {
                        repo.beanTransactionsFlow(uid).collect { txs ->
                            _state.update { it.copy(beanTransactions = txs) }
                        }
                    }
                }
            }
        }
    }

    /** One row per gift, its quantities added up, most-given first. */
    private fun List<GiftHistoryEntry>.toGiftSummary(): List<GiftSummaryItem> =
        groupBy { it.giftId }
            .map { (giftId, items) ->
                GiftSummaryItem(
                    giftId   = giftId,
                    name     = items.first().giftName,
                    emoji    = items.first().emoji,
                    imageUrl = items.first().imageUrl,
                    count    = items.sumOf { it.quantity },
                )
            }
            .sortedByDescending { it.count }

    // ── Edit field mutations ──────────────────────────────────────────────────

    fun onNameChange(v: String)                       = _state.update { it.copy(editName = v) }
    fun onBioChange(v: String)                        = _state.update { it.copy(editBio = v) }
    fun onCityChange(v: String)                       = _state.update { it.copy(editCity = v) }
    fun onAgeChange(v: Int)                           = _state.update { it.copy(editAge = v) }
    fun onPhotoUriChange(uri: Uri?)                   = _state.update { it.copy(editPhotoUri = uri) }
    fun onCoverUriChange(uri: Uri?)                   = _state.update { it.copy(editCoverUri = uri) }
    fun onLanguagesChange(langs: List<UserLanguage>)  = _state.update { it.copy(editLanguages = langs) }
    fun onHobbiesChange(h: List<String>)              = _state.update { it.copy(editHobbies = h) }
    fun onLikesChange(l: List<String>)                = _state.update { it.copy(editLikes = l) }
    fun onCallRateChange(rate: Int)                   = _state.update { it.copy(editCallRate = rate) }
    fun onDobChange(dob: Long)                        = _state.update { it.copy(editDob = dob) }

    // ── Gallery media ─────────────────────────────────────────────────────────

    /**
     * Called when the user picks a new media Uri from the system picker.
     * For videos: checks duration against MAX_VIDEO_DURATION_MS (60s).
     * Rejected items surface an error toast via state.error.
     */
    fun addMediaUri(uri: Uri) = viewModelScope.launch {
        val s = _state.value
        val totalSlots = s.editMediaUrls.size + s.editNewMediaUris.size
        if (totalSlots >= 10) {
            _state.update { it.copy(error = "Gallery is full (max 10 items)") }
            return@launch
        }

        val isVideo = repo.isVideoUri(uri)
        val fileSizeBytes = repo.getFileSizeBytes(uri)

        if (isVideo) {
            // Size check first (cheap) — catches huge 4K clips before reading metadata
            if (fileSizeBytes in 1..Long.MAX_VALUE && fileSizeBytes > MAX_VIDEO_SIZE_BYTES) {
                val mb = fileSizeBytes / (1024 * 1024)
                _state.update { it.copy(error = "Video is too large (${mb} MB). Max allowed is 80 MB.") }
                return@launch
            }
            // Duration check
            val durationMs = repo.getVideoDurationMs(uri)
            if (durationMs > MAX_VIDEO_DURATION_MS) {
                val secs = durationMs / 1000
                _state.update { it.copy(error = "Video is too long (${secs}s). Max is 60 seconds.") }
                return@launch
            }
        } else {
            // Image size guard — raw HEIC/RAW files can be very large
            if (fileSizeBytes in 1..Long.MAX_VALUE && fileSizeBytes > MAX_IMAGE_SIZE_BYTES) {
                val mb = fileSizeBytes / (1024 * 1024)
                _state.update { it.copy(error = "Image is too large (${mb} MB). Max allowed is 20 MB.") }
                return@launch
            }
        }

        _state.update { it.copy(editNewMediaUris = it.editNewMediaUris + uri) }
    }

    fun removeExistingMediaUrl(url: String) = _state.update { s ->
        val idx = s.editMediaUrls.indexOf(url)
        s.copy(
            editMediaUrls   = s.editMediaUrls.filterNot { it == url },
            editMediaThumbs = if (idx >= 0 && idx < s.editMediaThumbs.size)
                s.editMediaThumbs.filterIndexed { i, _ -> i != idx }
            else s.editMediaThumbs,
        )
    }

    fun removeNewMediaUri(uri: Uri) = _state.update {
        it.copy(editNewMediaUris = it.editNewMediaUris.filterNot { u -> u == uri })
    }

    fun removeLanguage(lang: UserLanguage) =
        _state.update { it.copy(editLanguages = it.editLanguages.filterNot { l -> l.id == lang.id }) }

    fun toggleHobby(hobby: String) = _state.update { s ->
        val current = s.editHobbies.toMutableList()
        if (current.contains(hobby)) current.remove(hobby) else current.add(hobby)
        s.copy(editHobbies = current)
    }

    fun toggleLike(like: String) = _state.update { s ->
        val current = s.editLikes.toMutableList()
        if (current.contains(like)) current.remove(like) else current.add(like)
        s.copy(editLikes = current)
    }

    // ── Save ──────────────────────────────────────────────────────────────────

    fun saveProfile() {
        val s = _state.value
        if (s.editName.isBlank()) {
            _state.update { it.copy(error = "Name cannot be empty") }
            return
        }

        // Compute which Storage files were removed so the repo can delete them
        val originalUrls   = s.user?.mediaUrls   ?: emptyList()
        val originalThumbs = s.user?.mediaThumbs  ?: emptyList()
        val keptSet        = s.editMediaUrls.toSet()
        val removedMediaUrls  = originalUrls.filterNot { it in keptSet }
        // Collect thumbnail URLs for every removed media item (videos have a non-empty thumb)
        val removedThumbUrls  = originalUrls.mapIndexedNotNull { idx, url ->
            if (url !in keptSet)
                originalThumbs.getOrElse(idx) { "" }.takeIf { it.isNotBlank() }
            else null
        }

        _state.update { it.copy(isSaving = true, error = null) }
        viewModelScope.launch {
            when (val result = repo.updateProfile(
                name              = s.editName,
                bio               = s.editBio,
                city              = s.editCity,
                age               = s.editAge,
                dob               = s.editDob,
                languages         = s.editLanguages,
                hobbies           = s.editHobbies,
                likes             = s.editLikes,
                // The slider is only shown when the server reports a ceiling
                // above the floor (verified host). Otherwise send nothing, or
                // the rules refuse the whole save.
                callRate          = if (s.maxCallRateBeans > s.minCallRateBeans) s.editCallRate else null,
                photoUri          = s.editPhotoUri,
                coverUri          = s.editCoverUri,
                keptMediaUrls     = s.editMediaUrls,
                keptMediaThumbs   = s.editMediaThumbs,
                newMediaUris      = s.editNewMediaUris,
                deletedMediaUrls  = removedMediaUrls,
                deletedThumbUrls  = removedThumbUrls,
            )) {
                is ProfileResult.Success -> _state.update {
                    it.copy(
                        isSaving = false,
                        saveSuccess = true,
                        editPhotoUri = null,
                        editCoverUri = null,
                        editNewMediaUris = emptyList(),
                    )
                }
                is ProfileResult.Error -> _state.update {
                    it.copy(isSaving = false, error = result.message)
                }
            }
        }
    }

    fun saveTheme(theme: String) {
        viewModelScope.launch { repo.saveTheme(theme) }
    }

    fun saveLanguage(language: String) {
        viewModelScope.launch { repo.saveLanguage(language) }
    }

    fun onSaveSuccessConsumed() = _state.update { it.copy(saveSuccess = false) }
    fun clearError()             = _state.update { it.copy(error = null) }

    fun convertBeans(amount: Long) {
        // The Firestore listener updates beans/diamonds in state on success.
        viewModelScope.launch {
            when (val res = beanConversionRepo.convertBeans(amount)) {
                is com.zipper.app.data.repository.BeanConversionRepository.ConvertResult.Ok -> Unit
                is com.zipper.app.data.repository.BeanConversionRepository.ConvertResult.Failed ->
                    // Was swallowed entirely: a refused conversion looked
                    // identical to a successful one until the balance failed to
                    // move, which users read as the app eating their beans.
                    _state.update { it.copy(error = res.message) }
            }
        }
    }
}
