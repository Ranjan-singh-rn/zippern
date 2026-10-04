package com.zipper.app.ui.screens.seller

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.EconomyConfigRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Supplies the wholesale price a coin seller pays, from the CRM.
 *
 * Before this, `BuyCoinScreen` hardcoded ₹2,290 per lakh and read no price from
 * Firestore at all — it read the seller record and the payment credentials, but
 * never `appConfig/economy`. So a seller was quoted the RETAIL price and their
 * whole margin disappeared, no matter what the CRM said.
 *
 * The margin was never zero by design. `sellerWholesalePriceInr` exists, is
 * editable, and is documented in the CRM as the seller "collecting the
 * difference from the buyer directly". The app simply never asked for it.
 */
@HiltViewModel
class BuyCoinViewModel @Inject constructor(
    private val economyConfig: EconomyConfigRepository,
) : ViewModel() {

    data class UiState(
        /** What the seller pays Zipper, per 1,00,000 coins. */
        val wholesalePerLakhInr: Int = 0,
        val wholesalePerLakhUsd: Int = 0,
        /** What the seller's own customers pay, per lakh. The resale price. */
        val retailPerLakhInr: Int = 0,
        /** Seller's gross margin per lakh, collected directly from the buyer. */
        val marginPerLakhInr: Int = 0,
        val isLoading: Boolean = true,
        /**
         * True when `appConfig/economy` could not be read and these are the
         * compiled-in fallbacks.
         *
         * Must be surfaced. A seller shown a stale price who then transfers that
         * amount has made a real payment against a wrong number, and neither
         * side finds out until reconciliation.
         */
        val isFallback: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    // observe(), not get(): a seller can have this screen open when the price is
    // changed in the CRM, and must not transfer money against a number that has
    // since moved. The listener detaches when the ViewModel clears.
    init {
        viewModelScope.launch {
            economyConfig.observe().collectLatest { cfg -> apply(cfg) }
        }
    }

    private fun apply(cfg: EconomyConfigRepository.EconomyConfig) {
        run {
            _state.update {
                it.copy(
                    wholesalePerLakhInr = cfg.sellerWholesalePriceInr,
                    // No separate wholesale USD is configured, so scale the USD
                    // retail by the INR discount rather than inventing a number.
                    wholesalePerLakhUsd = if (cfg.diamondPackPriceInr > 0) {
                        Math.round(
                            cfg.diamondPackPriceUsd.toDouble() *
                                cfg.sellerWholesalePriceInr / cfg.diamondPackPriceInr
                        ).toInt()
                    } else cfg.diamondPackPriceUsd,
                    retailPerLakhInr = cfg.diamondPackPriceInr,
                    marginPerLakhInr = cfg.sellerMarginInrPerLakh,
                    isLoading = false,
                    isFallback = cfg.isFallback,
                )
            }
        }
    }

    /** Force a re-read, skipping the cache. Rarely needed now observe() is live. */
    fun refresh() {
        viewModelScope.launch {
            economyConfig.invalidate()
            apply(economyConfig.get())
        }
    }
}
