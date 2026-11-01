package com.zipper.app.data.work

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.zipper.app.data.api.ApiClient
import com.zipper.app.data.api.ApiError
import com.zipper.app.data.api.ApiResult
import com.zipper.app.util.jsonMap
import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText
import kotlinx.coroutines.tasks.await
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Runs the declared work screens: loads a module's rows, a row's detail, and
 * an action — against the API (through [ApiClient], the CRM's routes) or
 * against Firestore (only the collections the CRM itself reads and writes from
 * the browser, under the same rules, for the same staff login).
 */
@Singleton
class WorkRepository @Inject constructor(
    private val api: ApiClient,
    private val firestore: FirebaseFirestore,
) {

    data class Loaded(val rows: List<Item>, val root: Item, val more: Boolean)

    sealed interface Outcome<out T> {
        data class Ok<T>(val value: T) : Outcome<T>
        data class Failed(val error: ApiError) : Outcome<Nothing>
    }

    data class ActionResult(val message: String, val body: Any?)

    val apiConfigured: Boolean get() = api.isConfigured

    // ── Who am I ─────────────────────────────────────────────────────────────

    suspend fun caps(): Outcome<Caps> = when (val r = api.get("/api/auth/me")) {
        is ApiResult.Ok -> Outcome.Ok(Caps.from(r.body))
        is ApiResult.Failure -> Outcome.Failed(r.error)
    }

    suspend fun signOutApi() = api.signOut()

    // ── Rows ─────────────────────────────────────────────────────────────────

    suspend fun load(
        module: WorkModule,
        params: Map<String, String>,
        filters: Map<String, String>,
        limit: Int,
        skip: Int,
        caps: Caps,
    ): Outcome<Loaded> = when (val src = module.source) {
        is Source.Api -> loadApi(module, src, params, filters, limit, skip, caps)
        is Source.Firestore -> loadFirestore(module, src, params, filters, limit)
    }

    private suspend fun loadApi(
        module: WorkModule, src: Source.Api, params: Map<String, String>, filters: Map<String, String>,
        limit: Int, skip: Int, caps: Caps,
    ): Outcome<Loaded> {
        val path = WorkTemplate.render(src.path, null, module.idPath, params, caps)
            ?: return Outcome.Failed(ApiError(0, "Fill in the fields above first.", ApiError.Kind.Invalid))
        val query = LinkedHashMap<String, Any?>()
        src.query.forEach { (k, v) -> WorkTemplate.render(v, null, module.idPath, params, caps, encode = false)?.let { query[k] = it } }
        query.putAll(WorkForm.query(module.params, params))
        filters.forEach { (k, v) -> if (v.isNotEmpty()) query[k] = v }
        src.limitParam?.let { query[it] = limit }
        src.skipParam?.let { if (skip > 0) query[it] = skip }
        return when (val r = api.get(path, query)) {
            is ApiResult.Failure -> Outcome.Failed(r.error)
            is ApiResult.Ok -> {
                val root = r.body.jsonMap() ?: emptyMap()
                var rows = if (src.arrayKey == "__none__") emptyList() else WorkRows.rows(r.body, src.arrayKey)
                // Report envelopes: each row carries the server's columns so it can be read on its own.
                module.columnsPath?.let { cp ->
                    val columns = r.body.jsonPath(cp)
                    if (columns != null) rows = rows.map { it + ("__columns" to columns) }
                }
                val fetched = rows.size
                module.clientFilter?.let { f -> rows = rows.filter(f) }
                Outcome.Ok(Loaded(rows, root, more = src.limitParam != null && fetched >= limit))
            }
        }
    }

    private suspend fun loadFirestore(
        module: WorkModule, src: Source.Firestore, params: Map<String, String>, filters: Map<String, String>, limit: Int,
    ): Outcome<Loaded> = try {
        val col = firestore.collection(src.collection)
        val search = src.searchParam?.let { params[it]?.trim() }.orEmpty()

        val docName = src.where.firstOrNull { it.first == "__name__" }?.third
        val rows: List<Item> = when {
            docName != null -> {
                val d = col.document(docName).get().await()
                if (d.exists()) listOf(snapshotItem(d)) else emptyList()
            }
            search.isNotEmpty() -> searchDocs(src, search, limit)
            else -> {
                var q: Query = col
                for ((field, op, value) in src.where) q = whereOf(q, field, op, typedValue(value))
                filters.forEach { (k, v) -> if (v.isNotEmpty()) q = q.whereEqualTo(k, typedValue(v)) }
                val ordered = src.orderBy?.let { q.orderBy(it, if (src.descending) Query.Direction.DESCENDING else Query.Direction.ASCENDING) } ?: q
                val snap = try {
                    ordered.limit(limit.toLong()).get().await()
                } catch (e: FirebaseFirestoreException) {
                    // A filter + order that has no composite index: read unordered and sort here,
                    // as the CRM does for its role lists.
                    if (e.code == FirebaseFirestoreException.Code.FAILED_PRECONDITION && src.orderBy != null) q.limit(limit.toLong()).get().await()
                    else throw e
                }
                val items = snap.documents.map { snapshotItem(it) }
                src.orderBy?.let { key -> items.sortedByDescending { WorkDisplay.millis(it[key]) ?: 0L } } ?: items
            }
        }
        var out = rows
        module.clientFilter?.let { f -> out = out.filter(f) }
        Outcome.Ok(Loaded(out, emptyMap(), more = docName == null && search.isEmpty() && rows.size >= limit))
    } catch (e: FirebaseFirestoreException) {
        Outcome.Failed(firestoreError(e))
    } catch (e: Exception) {
        Outcome.Failed(ApiError.network(e.message))
    }

    /** The CRM's `searchUsers`: the document with that id, plus a prefix match on each field. */
    private suspend fun searchDocs(src: Source.Firestore, term: String, limit: Int): List<Item> {
        val col = firestore.collection(src.collection)
        val found = LinkedHashMap<String, Item>()
        if ('/' !in term) {
            runCatching { col.document(term).get().await() }.getOrNull()?.takeIf { it.exists() }?.let { found[it.id] = snapshotItem(it) }
        }
        for (field in src.prefixFields) {
            val snap = runCatching {
                col.orderBy(field).startAt(term).endAt(term + "").limit(minOf(limit, 25).toLong()).get().await()
            }.getOrNull() ?: continue
            snap.documents.forEach { found.putIfAbsent(it.id, snapshotItem(it)) }
        }
        return found.values.toList()
    }

    private fun whereOf(q: Query, field: String, op: String, value: Any?): Query = when (op) {
        "in" -> q.whereIn(field, (value as? List<*>)?.filterNotNull() ?: listOf(value))
        "array-contains" -> q.whereArrayContains(field, value ?: "")
        else -> q.whereEqualTo(field, value)
    }

    private fun typedValue(v: String): Any = when (v) {
        "true" -> true
        "false" -> false
        else -> v
    }

    // ── Detail ───────────────────────────────────────────────────────────────

    suspend fun detail(module: WorkModule, item: Item, params: Map<String, String>, caps: Caps): Outcome<Item> {
        val tpl = module.detailPath ?: return Outcome.Ok(item)
        val path = WorkTemplate.render(tpl, item, module.idPath, params, caps) ?: return Outcome.Ok(item)
        return when (val r = api.get(path)) {
            is ApiResult.Ok -> Outcome.Ok(r.body.jsonMap() ?: item)
            is ApiResult.Failure -> Outcome.Failed(r.error)
        }
    }

    // ── Names (public projection only) ───────────────────────────────────────

    /**
     * Display names from `publicProfiles` — a name, never a contact — for
     * uids a screen already shows (B1). Unknown or unreadable ids are left out.
     */
    suspend fun publicNames(uids: Collection<String>): Map<String, String> {
        val ids = uids.map { it.trim() }.filter { it.isNotEmpty() && '/' !in it }.distinct()
        val out = HashMap<String, String>()
        for (batch in ids.chunked(30)) {
            val snap = runCatching {
                firestore.collection("publicProfiles").whereIn(FieldPath.documentId(), batch).get().await()
            }.getOrNull() ?: continue
            snap.documents.forEach { d ->
                val name = (d.getString("name") ?: d.getString("displayName")).orEmpty().trim()
                if (name.isNotEmpty()) out[d.id] = name
            }
        }
        return out
    }

    // ── Lookups (buyer picker) ───────────────────────────────────────────────

    suspend fun lookup(spec: LookupSpec, term: String): Outcome<List<Item>> =
        when (val r = api.get(spec.path, mapOf(spec.queryKey to term))) {
            is ApiResult.Ok -> Outcome.Ok(WorkRows.rows(r.body, null))
            is ApiResult.Failure -> Outcome.Failed(r.error)
        }

    // ── Actions ──────────────────────────────────────────────────────────────

    suspend fun run(
        module: WorkModule,
        action: WorkAction,
        item: Item,
        params: Map<String, String>,
        values: Map<String, String>,
        caps: Caps,
    ): Outcome<ActionResult> {
        val errors = WorkForm.validate(action.inputs, values)
        if (errors.isNotEmpty()) return Outcome.Failed(ApiError(0, errors.values.first(), ApiError.Kind.Invalid))
        return when (action.kind) {
            ActionKind.Api -> runApi(module, action, item, params, values, caps)
            ActionKind.FirestoreUpdate, ActionKind.FirestoreCreate -> runFirestore(module, action, item, values, caps)
            ActionKind.Navigate, ActionKind.OpenUrl -> Outcome.Ok(ActionResult("", null))
        }
    }

    private suspend fun runApi(
        module: WorkModule, action: WorkAction, item: Item, params: Map<String, String>,
        values: Map<String, String>, caps: Caps,
    ): Outcome<ActionResult> {
        val path = WorkTemplate.render(action.path, item, module.idPath, params, caps)
            ?: return Outcome.Failed(ApiError(0, "This record is missing the id this action needs.", ApiError.Kind.Invalid))
        val fixed = renderFixed(action.fixed, item, module.idPath, params, caps)
            ?: return Outcome.Failed(ApiError(0, "This record is missing a value this action needs.", ApiError.Kind.Invalid))
        val query = WorkForm.query(action.inputs, values)
        val body: Any? = if (action.bodyIsList) values.values.filter { it.isNotBlank() } else WorkForm.body(action.inputs, values, fixed)
        val r = when (action.method) {
            "GET" -> api.get(path, query)
            "PATCH" -> api.patch(path, body)
            "DELETE" -> api.delete(path)
            else -> api.post(path, body, query)
        }
        return when (r) {
            is ApiResult.Ok -> Outcome.Ok(ActionResult(successMessage(r.body, action), r.body))
            is ApiResult.Failure -> Outcome.Failed(r.error)
        }
    }

    private suspend fun runFirestore(
        module: WorkModule, action: WorkAction, item: Item, values: Map<String, String>, caps: Caps,
    ): Outcome<ActionResult> {
        val src = module.source as? Source.Firestore
            ?: return Outcome.Failed(ApiError(0, "This screen does not write Firestore.", ApiError.Kind.Invalid))
        val firstInput = WorkForm.visible(action.inputs, values).firstOrNull()?.let { values[it.key]?.trim() }.orEmpty()
        val fields = LinkedHashMap<String, Any?>()
        action.firestoreFields.forEach { (k, v) -> fields[k] = fsValue(v, caps, firstInput) }
        // The inputs land at their own keys (status, statusNote, response, rejectionReason …).
        WorkForm.body(action.inputs, values).forEach { (k, v) -> fields[k] = v }
        return try {
            if (action.kind == ActionKind.FirestoreCreate) {
                val ref = firestore.collection(src.collection).add(fields).await()
                Outcome.Ok(ActionResult("Saved (${ref.id}).", null))
            } else {
                val id = item.jsonPath(module.idPath).jsonText()
                    ?: return Outcome.Failed(ApiError(0, "This record has no id.", ApiError.Kind.Invalid))
                val nonNull: Map<String, Any> = fields.mapNotNull { (k, v) -> v?.let { k to it } }.toMap()
                firestore.collection(src.collection).document(id).update(nonNull).await()
                Outcome.Ok(ActionResult("Saved.", null))
            }
        } catch (e: FirebaseFirestoreException) {
            Outcome.Failed(firestoreError(e))
        } catch (e: Exception) {
            Outcome.Failed(ApiError.network(e.message))
        }
    }

    private fun fsValue(v: Any?, caps: Caps, firstInput: String): Any? = when (v) {
        FsValue.ServerTimestamp -> FieldValue.serverTimestamp()
        FsValue.ActorUid -> caps.uid
        FsValue.ActorName -> caps.name.ifBlank { caps.email.ifBlank { caps.uid } }
        FsValue.ActorEmail -> caps.email.ifBlank { caps.uid }
        FsValue.ActorTeam -> caps.team ?: ""
        FsValue.ActorRef -> mapOf("uid" to caps.uid, "name" to caps.name.ifBlank { caps.email })
        FsValue.Increment -> FieldValue.increment(1)
        FsValue.InputCopy -> firstInput
        else -> v
    }

    /** Constant body values; strings may hold `{uuid}`, `{item:…}`, `{param:…}`. Null if one cannot be filled. */
    private fun renderFixed(fixed: Map<String, Any?>, item: Item, idPath: String, params: Map<String, String>, caps: Caps): Map<String, Any?>? {
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in fixed) {
            if (v is String && v.contains('{')) {
                val withUuid = v.replace("{uuid}", UUID.randomUUID().toString().replace("-", ""))
                out[k] = WorkTemplate.render(withUuid, item, idPath, params, caps, encode = false) ?: return null
            } else out[k] = v
        }
        return out
    }

    private fun successMessage(body: Any?, action: WorkAction): String {
        val m = body.jsonMap()
        val note = m?.get("note").jsonText()?.takeIf { it.isNotBlank() }
            ?: m?.get("message").jsonText()?.takeIf { it.isNotBlank() }
            ?: m?.get("warning").jsonText()?.takeIf { it.isNotBlank() }
        return note ?: if (action.method == "GET") "" else "Done."
    }

    private fun firestoreError(e: FirebaseFirestoreException): ApiError = when (e.code) {
        FirebaseFirestoreException.Code.PERMISSION_DENIED ->
            ApiError(403, "Firestore refused this for your account. Nothing was changed.", ApiError.Kind.Forbidden)
        FirebaseFirestoreException.Code.UNAVAILABLE -> ApiError.network(e.message)
        FirebaseFirestoreException.Code.NOT_FOUND -> ApiError(404, "That record no longer exists.", ApiError.Kind.NotFound)
        FirebaseFirestoreException.Code.FAILED_PRECONDITION ->
            ApiError(400, "This list needs a database index that is not deployed yet.", ApiError.Kind.Invalid)
        else -> ApiError(0, e.message ?: "Firestore error", ApiError.Kind.Server)
    }

    companion object {
        /** A Firestore document as a plain map: `id` added, times turned into millis. */
        fun snapshotItem(d: DocumentSnapshot): Item {
            val m = LinkedHashMap<String, Any?>()
            m["id"] = d.id
            d.data?.forEach { (k, v) -> m[k] = plain(v) }
            return m
        }

        fun plain(v: Any?): Any? = when (v) {
            is Timestamp -> v.toDate().time
            is java.util.Date -> v.time
            is Map<*, *> -> v.entries.associate { (k, x) -> k.toString() to plain(x) }
            is List<*> -> v.map { plain(it) }
            is Int -> v.toLong()
            is com.google.firebase.firestore.DocumentReference -> v.path
            is com.google.firebase.firestore.GeoPoint -> "${v.latitude},${v.longitude}"
            else -> v
        }
    }
}
