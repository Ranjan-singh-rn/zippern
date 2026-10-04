package com.zipper.app.data.model

sealed class BagPurchaseResult {
    object Success : BagPurchaseResult()
    data class InsufficientDiamonds(val required: Int, val current: Long) : BagPurchaseResult()
    data class Error(val message: String) : BagPurchaseResult()
}
