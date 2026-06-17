package com.zipper.datingapp.data

import com.google.firebase.FirebaseApp
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException

// LuckyGiftsOutcome is defined in Models.kt — do not duplicate here.

/** Callable `processLuckyGifts` is deployed in `us-central1` — match region explicitly. */
fun zipperFirebaseFunctions(): FirebaseFunctions =
    FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "us-central1")

fun Map<*, *>.callableSuccessFlag(): Boolean {
    val v = get("success") ?: return false
    return when (v) {
        is Boolean -> v
        is Number -> v.toInt() != 0
        is String -> v.equals("true", ignoreCase = true) || v == "1"
        else -> false
    }
}

@Suppress("UNCHECKED_CAST")
fun Any?.callablePayloadSuccess(): Boolean =
    (this as? Map<*, *>)?.callableSuccessFlag() == true

@Suppress("UNCHECKED_CAST")
fun Any?.callablePayloadDiamondsWon(): Int {
    val map = this as? Map<*, *> ?: return 0
    val raw = map["diamondsWon"] ?: return 0
    return (raw as? Number)?.toInt()
        ?: raw.toString().trim().toIntOrNull()
        ?: 0
}

@Suppress("UNCHECKED_CAST")
fun Any?.callablePayloadTransactionId(): String? {
    val map = this as? Map<*, *> ?: return null
    return map["transactionId"]?.toString()?.trim()?.takeIf { it.isNotEmpty() }
}

@Suppress("UNCHECKED_CAST")
fun Any?.callablePayloadErrorMessage(): String? {
    val map = this as? Map<*, *> ?: return null
    return map["error"]?.toString()?.takeIf { it.isNotBlank() }
        ?: map["message"]?.toString()?.takeIf { it.isNotBlank() }
}

fun Throwable.callableFailureMessage(): String {
    val fe = this as? FirebaseFunctionsException
        ?: return message?.takeIf { it.isNotBlank() } ?: "Network error"
    val codePart = fe.code?.name?.takeIf { it.isNotBlank() }
    val msgPart = fe.message?.takeIf { it.isNotBlank() }
    return listOfNotNull(codePart, msgPart).joinToString(": ").ifBlank { "Cloud error" }
}
