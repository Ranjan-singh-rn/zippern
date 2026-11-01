package com.zipper.app.data.work

import com.zipper.app.data.api.ApiTime
import com.zipper.app.util.jsonList
import com.zipper.app.util.jsonLong
import com.zipper.app.util.jsonMap
import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * The work screens are DECLARED, not hand-built one by one.
 *
 * Each CRM capability becomes a [WorkModule]: where its data comes from (an API
 * route, or a Firestore collection the CRM itself reads), how a row reads, what
 * the detail shows, and which actions it offers — each action naming the exact
 * route and body the CRM sends. One list screen, one detail screen and one
 * action form render every module, so loading / empty / error / denied /
 * confirm / result behave the same everywhere and are tested once.
 *
 * Everything in this file is pure (no Android, no Firebase): `WorkSpecTest`
 * runs the templating, validation and body building on the JVM.
 */

typealias Item = Map<String, Any?>

enum class FieldKind {
    Text, LongText,
    /** Integer minor units (paise) → "₹1,234.56". */
    Money,
    /** Whole rupees as stored (e.g. `amountPaid`). */
    Rupees,
    Count,
    /** An instant: ISO string, epoch millis, or a Firestore time already turned into millis. */
    Date,
    Status, Bool,
    /** A Firebase uid (an account). */
    Uid,
    /** A partner record id. */
    PartnerId,
    /** A nested value shown as compact text. */
    Json,
    /** A link that opens outside the app (signed document URLs). */
    Url,
}

data class Field(
    val label: String,
    val path: String,
    val kind: FieldKind = FieldKind.Text,
    /** Tapping the value opens another module with this value as its parameter. */
    val link: Link? = null,
    /** Shown only to sessions this accepts (contacts: `can_view_users`, as the CRM gates them). */
    val visibleTo: ((Caps) -> Boolean)? = null,
)

data class Link(val moduleId: String, val param: String)

enum class InputType {
    Text, LongText, Int, Rupees, Choice, Bool, DateTime, Lookup,
    /** One entry per line, sent as a JSON array of strings ([Input.max] = most entries). */
    Lines,
}

data class LookupSpec(
    /** API route returning a bare array of candidates. */
    val path: String,
    val queryKey: String,
    val minChars: Int = 3,
    val valuePath: String,
    val titlePath: String,
    val subtitlePaths: List<String> = emptyList(),
)

data class Input(
    /** Body key; dots nest (`deduction.amount`). For a query input, the query key. */
    val key: String,
    val label: String,
    val type: InputType = InputType.Text,
    val required: Boolean = true,
    val minLen: Int = 0,
    val maxLen: Int = 0,
    val min: Long? = null,
    val max: Long? = null,
    /** value → label, for [InputType.Choice]. */
    val options: List<Pair<String, String>> = emptyList(),
    val default: String = "",
    val help: String = "",
    /** Pre-fill from the selected row. */
    val prefillPath: String? = null,
    /** Only shown (and sent) when this returns true for the other values. */
    val showIf: ((Map<String, String>) -> Boolean)? = null,
    val lookup: LookupSpec? = null,
    /** Sent on the query string instead of in the body. */
    val asQuery: Boolean = false,
)

enum class ActionKind {
    /** Call an API route. */
    Api,
    /** Update the selected Firestore document (only for screens the CRM writes from the browser). */
    FirestoreUpdate,
    /** Create a Firestore document. */
    FirestoreCreate,
    /** Open another module, nothing is sent. */
    Navigate,
    /** Open a URL from the row (signed document links). */
    OpenUrl,
    /**
     * A read-only marker: the button opens a dialog that shows [WorkAction.help]
     * and sends NOTHING. For decisions that exist on the server but stay in
     * the CRM on purpose (Owner governance — "Decide in the CRM"), so the
     * screen says where the decision is made instead of hiding that it exists.
     */
    Info,
}

data class WorkAction(
    val id: String,
    val label: String,
    val path: String = "",
    val method: String = "POST",
    val kind: ActionKind = ActionKind.Api,
    /** Who is OFFERED the button. The server still decides. */
    val gate: (Caps) -> Boolean,
    /** Whether the row is in a state this action applies to. */
    val showFor: (Item, Caps) -> Boolean = { _, _ -> true },
    val inputs: List<Input> = emptyList(),
    /** Constant body fields. */
    val fixed: Map<String, Any?> = emptyMap(),
    /** Fields written on a Firestore action; values may be [FsValue] markers. */
    val firestoreFields: Map<String, Any?> = emptyMap(),
    /** The sentence on the confirmation dialog. Blank = no confirmation (reads only). */
    val confirm: String = "",
    val danger: Boolean = false,
    /** Send the body as a bare JSON array of these input values (`/cards/sign-bulk`). */
    val bodyIsList: Boolean = false,
    /** For [ActionKind.Navigate]: module + parameter template. */
    val target: Link? = null,
    /** For [ActionKind.OpenUrl]: the path of the URL in the row. */
    val urlPath: String? = null,
    val help: String = "",
)

/** Firestore values the CRM writes that only the client can fill in. */
enum class FsValue {
    ServerTimestamp,
    ActorUid,
    ActorName,
    /** The CRM stores the claimant's email (or uid when it has none) as `assignedTo`. */
    ActorEmail,
    /** The actor's department (`reportedByDept`). */
    ActorTeam,
    /** `{uid, name}` — the CRM's `reviewedBy`. */
    ActorRef,
    /** `increment(1)`. */
    Increment,
    /** The value of the action's first input (the CRM writes the response as the status note too). */
    InputCopy,
}

sealed interface Source {
    data class Api(
        val path: String,
        val query: Map<String, String> = emptyMap(),
        /** Where the rows are: null = the body is a bare array (or there are no rows). Dots allowed. */
        val arrayKey: String? = null,
        val limitParam: String? = "limit",
        /** `skip`-paged routes (the audit log). */
        val skipParam: String? = null,
        /**
         * An envelope holding SEVERAL row arrays (`/partner-ops/held-items`:
         * `cards`, `recharges`, `sales`, `subagency_payouts`). Rows are the
         * concatenation, each tagged with [arrayTagKey] = its array's name, so
         * an action can name the type in its route. Takes precedence over
         * [arrayKey] when non-empty.
         */
        val arrayKeys: List<String> = emptyList(),
        val arrayTagKey: String = "__from",
    ) : Source

    data class Firestore(
        val collection: String,
        /** field, op (`==`, `in`, `array-contains`), value template. */
        val where: List<Triple<String, String, String>> = emptyList(),
        val orderBy: String? = null,
        val descending: Boolean = true,
        /**
         * Search mode (the CRM's `searchUsers`): when the module parameter
         * named here is filled, the rows are the document with that id plus a
         * prefix match on each of [prefixFields] — instead of the plain query.
         */
        val searchParam: String? = null,
        val prefixFields: List<String> = emptyList(),
    ) : Source
}

data class Filter(
    /** The query parameter (API) or field (Firestore `==`) it sets. */
    val param: String,
    val label: String,
    /** value → label. The first is the default; a blank value means "no filter". */
    val options: List<Pair<String, String>>,
)

enum class Group(val title: String) {
    Mine("My work"),
    Queues("Queues & approvals"),
    People("Users & hosts"),
    Partners("Agencies & sellers"),
    Money("Money"),
    Reports("Reports"),
    Live("Live & moderation"),
    Support("Support"),
    Team("Team & audit"),
    Config("Configuration"),
}

data class WorkModule(
    val id: String,
    val title: String,
    val group: Group,
    val summary: String,
    /** CRM page(s) this reproduces — kept for the parity matrix. */
    val crm: String,
    val gate: (Caps) -> Boolean,
    val source: Source,
    /** Asked for before loading (a uid, an agency id …). Pre-filled from the session where it can be. */
    val params: List<Input> = emptyList(),
    val filters: List<Filter> = emptyList(),
    val idPath: String = "id",
    val titlePaths: List<String> = listOf("name", "title", "id"),
    val subtitle: List<Field> = emptyList(),
    val statusPath: String? = "status",
    /** Shown above the rows, read from the response root (statements, reports). */
    val header: List<Field> = emptyList(),
    val detail: List<Field> = emptyList(),
    /** Fetch the full record for the detail screen (`{id}` is the row id). */
    val detailPath: String? = null,
    val actions: List<WorkAction> = emptyList(),
    /** Actions that need no row (create, raise, look up). */
    val pageActions: List<WorkAction> = emptyList(),
    val pageSize: Int = 50,
    val maxSize: Int = 500,
    val searchPaths: List<String> = emptyList(),
    /** A line shown under the title on the list (what this screen is, who decides). */
    val note: String = "",
    /**
     * Report envelopes (`columns: [{key, header}]`): rows are described by the
     * server's own columns rather than a fixed field list.
     */
    val columnsPath: String? = null,
    /** Row fields holding a Firebase uid whose PUBLIC display name is shown beside it. */
    val nameUidPaths: List<String> = emptyList(),
    /** Raw keys never shown on this module (e.g. a reporter's uid on an agency screen). */
    val hide: Set<String> = emptySet(),
    /** Keep only rows this accepts (a type filter over a shared route). */
    val clientFilter: ((Item) -> Boolean)? = null,
    /**
     * A pure, per-row derivation applied after loading (never a computation of
     * money): adds display keys such as a session's client label. Must be
     * total — it is also what the JVM tests run on sample rows.
     */
    val rowTransform: ((Item) -> Item)? = null,
)

// ── Templates ────────────────────────────────────────────────────────────────

object WorkTemplate {
    private val token = Regex("""\{([a-zA-Z_.:0-9]+)\}""")

    /**
     * `{id}` row id · `{item:a.b}` a row field · `{param:x}` a module parameter ·
     * `{agency}` / `{seller}` the session's own partner ids · `{uid}` the session uid.
     * Path segments are URL-encoded. Null when a placeholder has no value — the
     * caller then refuses to send rather than calling `/api/users//ban`.
     */
    fun render(
        template: String,
        item: Item?,
        idPath: String,
        params: Map<String, String>,
        caps: Caps,
        encode: Boolean = true,
    ): String? {
        var missing = false
        val out = token.replace(template) { m ->
            val key = m.groupValues[1]
            val raw: String? = when {
                key == "id" -> item.jsonPath(idPath).jsonText()
                key.startsWith("item:") -> item.jsonPath(key.removePrefix("item:")).jsonText()
                key.startsWith("param:") -> params[key.removePrefix("param:")]
                key == "agency" -> caps.agencyId
                key == "seller" -> caps.sellerId
                key == "uid" -> caps.uid
                else -> null
            }
            if (raw.isNullOrBlank()) { missing = true; "" } else if (encode) seg(raw) else raw
        }
        return if (missing) null else out
    }

    fun seg(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}

// ── Inputs: validation and body ─────────────────────────────────────────────

object WorkForm {

    fun visible(inputs: List<Input>, values: Map<String, String>): List<Input> =
        inputs.filter { it.showIf?.invoke(values) ?: true }

    /** Field key → message, for every visible input that is wrong. Empty = OK. */
    fun validate(inputs: List<Input>, values: Map<String, String>): Map<String, String> {
        val errors = LinkedHashMap<String, String>()
        for (i in visible(inputs, values)) {
            val v = values[i.key].orEmpty().trim()
            if (v.isEmpty()) {
                if (i.required) errors[i.key] = "${i.label} is required."
                continue
            }
            when (i.type) {
                InputType.Text, InputType.LongText, InputType.Lookup -> {
                    if (i.minLen > 0 && v.length < i.minLen) errors[i.key] = "${i.label}: at least ${i.minLen} characters."
                    else if (i.maxLen > 0 && v.length > i.maxLen) errors[i.key] = "${i.label}: at most ${i.maxLen} characters."
                }
                InputType.Int -> {
                    val n = v.toLongOrNull()
                    when {
                        n == null -> errors[i.key] = "${i.label} must be a whole number."
                        i.min != null && n < i.min -> errors[i.key] = "${i.label} must be at least ${i.min}."
                        i.max != null && n > i.max -> errors[i.key] = "${i.label} must be at most ${i.max}."
                    }
                }
                InputType.Rupees -> {
                    val paise = rupeesToPaise(v)
                    when {
                        paise == null -> errors[i.key] = "${i.label}: enter an amount like 1500 or 1500.50."
                        i.min != null && paise < i.min -> errors[i.key] = "${i.label} must be at least ₹${formatPaise(i.min)}."
                        i.max != null && paise > i.max -> errors[i.key] = "${i.label} must be at most ₹${formatPaise(i.max)}."
                    }
                }
                InputType.Choice -> if (i.options.none { it.first == v }) errors[i.key] = "Choose ${i.label.lowercase()}."
                InputType.Bool -> if (v != "true" && v != "false") errors[i.key] = "Choose yes or no."
                InputType.DateTime -> if (ApiTime.parseIsoMillis(normaliseDate(v)) == null) errors[i.key] = "${i.label}: use YYYY-MM-DD."
                InputType.Lines -> {
                    val items = lines(v)
                    when {
                        i.max != null && items.size > i.max -> errors[i.key] = "${i.label}: at most ${i.max} entries."
                        i.maxLen > 0 && items.any { it.length > i.maxLen } -> errors[i.key] = "${i.label}: each entry at most ${i.maxLen} characters."
                    }
                }
            }
        }
        return errors
    }

    /** The JSON body: typed values at their (possibly nested) keys, plus [fixed]. Query inputs are left out. */
    fun body(inputs: List<Input>, values: Map<String, String>, fixed: Map<String, Any?> = emptyMap()): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        fixed.forEach { (k, v) -> put(out, k, v) }
        for (i in visible(inputs, values)) {
            if (i.asQuery) continue
            val raw = values[i.key].orEmpty().trim()
            if (raw.isEmpty()) continue
            put(out, i.key, typed(i, raw))
        }
        return out
    }

    fun query(inputs: List<Input>, values: Map<String, String>): Map<String, Any?> =
        visible(inputs, values).filter { it.asQuery }
            .mapNotNull { i -> values[i.key]?.trim()?.takeIf { it.isNotEmpty() }?.let { i.key to typed(i, it) } }
            .toMap()

    fun typed(i: Input, raw: String): Any? = when (i.type) {
        InputType.Int -> raw.toLongOrNull()
        // A yes/no choice is a JSON boolean on the wire (`approve`, `muted`).
        InputType.Choice -> if (raw == "true" || raw == "false") raw == "true" else raw
        InputType.Rupees -> rupeesToPaise(raw)
        InputType.Bool -> raw == "true"
        InputType.DateTime -> normaliseDate(raw)
        InputType.Lines -> lines(raw)
        else -> raw
    }

    /** "a\n b \n\nc" → ["a", "b", "c"]. */
    fun lines(raw: String): List<String> = raw.lines().map { it.trim() }.filter { it.isNotEmpty() }

    @Suppress("UNCHECKED_CAST")
    private fun put(into: MutableMap<String, Any?>, key: String, value: Any?) {
        val parts = key.split('.')
        var cur = into
        for (p in parts.dropLast(1)) {
            cur = (cur.getOrPut(p) { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>)
        }
        cur[parts.last()] = value
    }

    /** "1500" / "1,500.5" / "₹1500.50" → 150050 paise. Null if not an amount or more than 2 decimals. */
    fun rupeesToPaise(text: String): Long? {
        val t = text.replace("₹", "").replace(",", "").trim()
        val m = Regex("""^(\d{1,12})(?:\.(\d{1,2}))?$""").matchEntire(t) ?: return null
        val whole = m.groupValues[1].toLong()
        val frac = m.groupValues[2].padEnd(2, '0').ifEmpty { "00" }.toLong()
        return whole * 100 + frac
    }

    fun formatPaise(paise: Long): String {
        val neg = paise < 0
        val a = kotlin.math.abs(paise)
        val rupees = a / 100
        val p = a % 100
        val s = indian(rupees) + if (p != 0L) "." + p.toString().padStart(2, '0') else ""
        return if (neg) "-$s" else s
    }

    /** 1234567 → "12,34,567" (Indian grouping, as the rest of the app prints numbers). */
    fun indian(n: Long): String {
        val neg = n < 0
        val s = kotlin.math.abs(n).toString()
        if (s.length <= 3) return (if (neg) "-" else "") + s
        val last3 = s.takeLast(3)
        val rest = s.dropLast(3).reversed().chunked(2).joinToString(",").reversed()
        return (if (neg) "-" else "") + "$rest,$last3"
    }

    /** "2026-10-31" → "2026-10-31T00:00:00Z"; a full ISO value is kept. */
    fun normaliseDate(v: String): String =
        if (Regex("""^\d{4}-\d{2}-\d{2}$""").matches(v.trim())) "${v.trim()}T00:00:00Z" else v.trim()
}

// ── Reading rows ─────────────────────────────────────────────────────────────

object WorkRows {

    /** The rows a source answered with. */
    fun rows(body: Any?, arrayKey: String?): List<Item> {
        val arr = if (arrayKey == null) body.jsonList() else body.jsonPath(arrayKey).jsonList()
        return arr?.mapNotNull { it.jsonMap() } ?: emptyList()
    }

    /**
     * The rows of an envelope with several arrays, in the order the keys are
     * given, each row tagged with `tagKey` = the array it came from. A missing
     * or non-array key contributes nothing.
     */
    fun rows(body: Any?, arrayKeys: List<String>, tagKey: String): List<Item> =
        arrayKeys.flatMap { key -> rows(body, key).map { it + (tagKey to key) } }

    /** [Source.Api] → its rows, whichever shape it declares. */
    fun rows(body: Any?, src: Source.Api): List<Item> = when {
        src.arrayKey == "__none__" -> emptyList()
        src.arrayKeys.isNotEmpty() -> rows(body, src.arrayKeys, src.arrayTagKey)
        else -> rows(body, src.arrayKey)
    }

    fun title(item: Item, paths: List<String>): String =
        paths.firstNotNullOfOrNull { p -> item.jsonPath(p).jsonText()?.takeIf { it.isNotBlank() } } ?: "—"

    /** Client-side search across the given paths (and the id). */
    fun matches(item: Item, query: String, paths: List<String>, idPath: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        return (paths + idPath).any { p -> item.jsonPath(p).jsonText()?.lowercase()?.contains(q) == true }
    }
}

// ── Display ──────────────────────────────────────────────────────────────────

object WorkDisplay {

    /**
     * Keys never shown from a raw record, whoever asked: credentials and keys.
     * (The server already decides WHICH records a session receives; this only
     * keeps secrets that ride along on some of them off the screen.)
     */
    private val hidden = setOf(
        "token", "id_token", "jti", "password", "secret", "set_password_link",
        "idempotency_key", "gateAnswers", "headers_sent", "provider_error_body", "_id", "__columns",
        // The envelope tag `WorkRows` adds (`Source.Api.arrayTagKey`) — plumbing, not a field.
        "__from",
    )

    /** Shown masked to the last four characters. */
    private val masked = setOf(
        "accountNumber", "account_number", "bankAccount", "aadhaar", "aadhaarNumber", "pan", "panNumber",
    )

    fun isHidden(key: String): Boolean = key in hidden || key.lowercase().endsWith("secret")

    fun mask(key: String, value: String): String =
        if (key in masked && value.length > 4) "•".repeat(minOf(8, value.length - 4)) + value.takeLast(4) else value

    fun humanize(key: String): String =
        key.replace(Regex("([a-z])([A-Z])"), "$1 $2").replace('_', ' ').replace('.', ' ')
            .trim().replaceFirstChar { it.uppercase() }

    fun status(raw: String?): String =
        raw?.takeIf { it.isNotBlank() }?.replace('_', ' ')?.replaceFirstChar { it.uppercase() } ?: "—"

    fun millis(v: Any?): Long? = when (v) {
        is Long -> if (v > 10_000_000_000L) v else v * 1000
        is Int -> v.toLong() * 1000
        is Double -> v.toLong().let { if (it > 10_000_000_000L) it else it * 1000 }
        is String -> ApiTime.parseIsoMillis(v)
        else -> null
    }

    fun date(v: Any?): String {
        val ms = millis(v) ?: return v.jsonText() ?: "—"
        return SimpleDateFormat("d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(ms))
    }

    fun value(v: Any?, kind: FieldKind): String = when (kind) {
        FieldKind.Money -> v.jsonLong()?.let { "₹" + WorkForm.formatPaise(it) } ?: "—"
        FieldKind.Rupees -> v.jsonLong()?.let { "₹" + WorkForm.indian(it) } ?: (v.jsonText() ?: "—")
        FieldKind.Count -> v.jsonLong()?.let { WorkForm.indian(it) } ?: (v.jsonText() ?: "—")
        FieldKind.Date -> date(v)
        FieldKind.Status -> status(v.jsonText())
        FieldKind.Bool -> if (v == true) "Yes" else if (v == false) "No" else "—"
        FieldKind.Json -> compact(v)
        else -> v.jsonText()?.takeIf { it.isNotBlank() } ?: if (v is Map<*, *> || v is List<*>) compact(v) else "—"
    }

    /** A nested value in one readable line. */
    fun compact(v: Any?, depth: Int = 0): String = when (v) {
        null -> "—"
        is Map<*, *> -> if (depth > 1) "{…}" else v.entries
            .filter { (k, _) -> !isHidden(k.toString()) }
            .joinToString(", ") { (k, x) -> "${humanize(k.toString())}: ${compact(x, depth + 1)}" }
            .ifBlank { "—" }
        is List<*> -> if (v.isEmpty()) "none" else if (depth > 1) "[${v.size}]" else v.joinToString("; ") { compact(it, depth + 1) }
        else -> v.jsonText() ?: v.toString()
    }

    /** Every displayable top-level key of a raw record, for "All fields". */
    fun allFields(item: Item): List<Pair<String, String>> =
        item.entries.filter { (k, _) -> !isHidden(k) }.map { (k, v) ->
            val text = if (v is Map<*, *> || v is List<*>) compact(v) else (v.jsonText() ?: "—")
            humanize(k) to mask(k, text)
        }
}
