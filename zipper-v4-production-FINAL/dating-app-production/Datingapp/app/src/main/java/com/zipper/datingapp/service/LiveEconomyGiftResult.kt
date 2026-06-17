package com.zipper.datingapp.service

/**
 * Result of a live-economy gift send operation ([FirebaseService.sendGift]).
 *
 * [Success] — gift was charged and written; [newWalletBalance] is the confirmed post-charge balance.
 * [Failed]  — gift was NOT sent; [reason] is a user-facing message.
 */
sealed class LiveEconomyGiftResult {
    data class Success(val newWalletBalance: Int) : LiveEconomyGiftResult()
    data class Failed(val reason: String) : LiveEconomyGiftResult()
}
