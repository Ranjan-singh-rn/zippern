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
 * The lucky-gift configuration for the gift sheet, wherever it opens.
 *
 * A ViewModel so the one `appConfig/luckyGifts` read is shared by the live
 * room, the party, the call and the profile sheet without each of their
 * ViewModels growing a copy of it. Starts on the defaults — combos 10 / 17 /
 * 25 / 77 and the Owner's switch OFF, so lucky gifts show as unavailable —
 * and replaces them when the document arrives.
 */
@HiltViewModel
class LuckyGiftConfigViewModel @Inject constructor(
    private val repo: LuckyGiftConfigRepository,
) : ViewModel() {

    private val _config = MutableStateFlow(LuckyGiftConfigRepository.Config())
    val config: StateFlow<LuckyGiftConfigRepository.Config> = _config.asStateFlow()

    /**
     * Read the document again. The gift sheet calls this each time it opens:
     * the Owner's switch can change while the app is running, and a sheet that
     * kept offering a lucky gift after it was turned off — or kept it
     * unavailable after it was turned on — would be wrong until a restart. One
     * small read per sheet.
     */
    fun refresh() {
        repo.invalidate()
        viewModelScope.launch { _config.value = repo.get() }
    }
}
