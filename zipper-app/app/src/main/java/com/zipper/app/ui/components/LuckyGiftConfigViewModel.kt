package com.zipper.app.ui.components

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.LuckyGiftConfigRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The lucky-gift combos for the gift sheet, wherever it opens.
 *
 * A ViewModel so the one `appConfig/luckyGifts` read is shared by the live
 * room, the party, the call and the profile sheet without each of their
 * ViewModels growing a copy of it. Starts on the server's defaults and
 * replaces them when the document arrives; a sheet opened in the first
 * hundred milliseconds offers 10 / 17 / 25 / 77, which is also what the server
 * accepts when the document is absent.
 */
@HiltViewModel
class LuckyGiftConfigViewModel @Inject constructor(
    private val repo: LuckyGiftConfigRepository,
) : ViewModel() {

    private val _config = MutableStateFlow(LuckyGiftConfigRepository.Config())
    val config: StateFlow<LuckyGiftConfigRepository.Config> = _config.asStateFlow()

    init {
        viewModelScope.launch { _config.value = repo.get() }
    }

    /** After the server refused a combo: drop the cache and read again. */
    fun refresh() {
        repo.invalidate()
        viewModelScope.launch { _config.value = repo.get() }
    }
}
