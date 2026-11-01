package com.zipper.app.data.api

import com.zipper.app.util.jsonList
import com.zipper.app.util.jsonMap
import com.zipper.app.util.jsonText

/** One API answer. Pure — `ApiErrorTest` runs the mapping on the JVM. */
sealed interface ApiResult {
    data class Ok(val status: Int, val body: Any?) : ApiResult
    data class Failure(val error: ApiError) : ApiResult
}

/**
 * Why a call did not succeed, in words a person can act on.
 *
 * The API's own sentences are kept: FastAPI answers `{"detail": "<sentence>"}`
 * and the backend writes those sentences for the person on the other end
 * ("Only a business owner can approve this."). A structured detail (an object
 * with `message`) or a validation list (422) is reduced to its message.
 */
data class ApiError(
    val status: Int,
    val message: String,
    val kind: Kind,
    /** The structured `detail` object when the server sent one (e.g. CONTACT_VERIFICATION_REQUIRED). */
    val detail: Map<String, Any?>? = null,
) {
    enum class Kind {
        /** This build has no API host. */
        NotConfigured,
        /** No Firebase user in the app. */
        SignedOut,
        /** Signed in, but the API knows no staff or partner account for this login. */
        NoAccount,
        /** 401 on a route — the session was refused. */
        Unauthorized,
        /** 403 — the server says this account may not do this. */
        Forbidden,
        NotFound,
        /** 409 — a conflict or an unconfirmed outcome; the server says what to do. */
        Conflict,
        /** 400 / 422 — the request itself was refused. */
        Invalid,
        /** 503 — outcome unknown or a dependency is down. */
        Unavailable,
        Server,
        Network,
    }

    val code: String? get() = detail?.get("code") as? String

    companion object {
        fun notConfigured() = ApiError(
            0,
            "This build is not connected to the Zipper work server. Ask the developer for a build with the work server configured.",
            Kind.NotConfigured,
        )

        fun signedOut() = ApiError(0, "Sign in to the app first.", Kind.SignedOut)

        fun network(why: String?) = ApiError(
            0,
            "Couldn't reach the Zipper server. Nothing was changed — check your connection and try again." +
                (why?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: ""),
            Kind.Network,
        )

        fun fromResponse(status: Int, body: Any?): ApiError {
            val detail = body.jsonMap()?.get("detail")
            val structured = detail.jsonMap()
            val message = when {
                detail is String && detail.isNotBlank() -> detail
                structured != null -> (structured["message"].jsonText() ?: structured["outcome"].jsonText()).orEmpty()
                detail.jsonList() != null -> validationMessage(detail.jsonList()!!)
                body is String && body.isNotBlank() && body.length < 300 -> body
                else -> ""
            }.ifBlank { defaultMessage(status) }
            return ApiError(status, message, kindOf(status), structured)
        }

        fun kindOf(status: Int): Kind = when (status) {
            400, 422 -> Kind.Invalid
            401 -> Kind.Unauthorized
            403 -> Kind.Forbidden
            404 -> Kind.NotFound
            409 -> Kind.Conflict
            503 -> Kind.Unavailable
            in 500..599 -> Kind.Server
            else -> Kind.Server
        }

        /** FastAPI 422: `[{"loc": ["body","reason"], "msg": "...", ...}]` → "reason: …". */
        fun validationMessage(items: List<Any?>): String =
            items.mapNotNull { item ->
                val m = item.jsonMap() ?: return@mapNotNull null
                val field = m["loc"].jsonList()?.lastOrNull()?.jsonText()
                val msg = m["msg"].jsonText() ?: return@mapNotNull null
                if (field.isNullOrBlank() || field == "body") msg else "$field: $msg"
            }.joinToString("; ")

        fun defaultMessage(status: Int): String = when (status) {
            401 -> "Your work session ended. Try again."
            403 -> "Your account is not allowed to do this."
            404 -> "That record was not found."
            409 -> "This changed while you were looking at it. Refresh and try again."
            503 -> "The server could not confirm the outcome. Refresh before trying again."
            else -> "The server refused this (HTTP $status). Nothing was changed."
        }
    }
}

/** ISO-8601 instants from the API (`2026-10-22T10:00:00+00:00`, `...Z`, with or without fraction). */
object ApiTime {
    fun parseIsoMillis(text: String?): Long? {
        if (text.isNullOrBlank()) return null
        val m = Regex("""^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$""")
            .matchEntire(text.trim()) ?: return null
        val g = m.groupValues
        val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
        cal.clear()
        cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].ifEmpty { "0" }.toInt())
        var ms = cal.timeInMillis + (g[7].ifEmpty { "0" }.padEnd(3, '0').take(3).toLong())
        val zone = g[8]
        if (zone.isNotEmpty() && zone != "Z") {
            val sign = if (zone[0] == '-') -1 else 1
            val digits = zone.substring(1).replace(":", "")
            val offsetMin = digits.take(2).toInt() * 60 + digits.drop(2).toInt()
            ms -= sign * offsetMin * 60_000L
        }
        return ms
    }
}
