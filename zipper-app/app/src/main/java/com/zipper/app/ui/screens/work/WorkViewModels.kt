package com.zipper.app.ui.screens.work

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.api.ApiError
import com.zipper.app.data.work.ActionKind
import com.zipper.app.data.work.Caps
import com.zipper.app.data.work.Group
import com.zipper.app.data.work.Item
import com.zipper.app.data.work.WorkAction
import com.zipper.app.data.work.WorkModule
import com.zipper.app.data.work.WorkModules
import com.zipper.app.data.work.WorkRepository
import com.zipper.app.data.work.WorkTemplate
import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The row the detail screen shows. Rows are plain maps from the server, so
 * they travel by reference rather than through a route string.
 */
object WorkSelection {
    private val held = HashMap<String, Pair<Item, Map<String, String>>>()
    fun put(moduleId: String, item: Item, params: Map<String, String>) { held[moduleId] = item to params }
    fun get(moduleId: String): Pair<Item, Map<String, String>>? = held[moduleId]
}

/** The session's capabilities, shared by every work screen once the hub has read them. */
object WorkCapsCache {
    @Volatile var caps: Caps? = null
    @Volatile var uid: String? = null
}

// ── Action state, shared by list and detail ─────────────────────────────────

data class ActionUi(
    val action: WorkAction,
    val item: Item,
    val values: Map<String, String>,
    val stage: Stage = Stage.Form,
    val error: String? = null,
    val result: String? = null,
    val resultBody: Any? = null,
    val lookupRows: List<Item> = emptyList(),
    val lookupError: String? = null,
) {
    enum class Stage { Form, Confirm, Running, Done }
}

abstract class WorkActionHost(protected val repo: WorkRepository) : ViewModel() {

    protected val _action = MutableStateFlow<ActionUi?>(null)
    val action: StateFlow<ActionUi?> = _action.asStateFlow()

    abstract val module: WorkModule?
    abstract fun currentCaps(): Caps?
    abstract fun currentParams(): Map<String, String>
    abstract fun afterAction()

    fun open(action: WorkAction, item: Item) {
        val caps = currentCaps() ?: return
        val mod = module ?: return
        val values = LinkedHashMap<String, String>()
        for (i in action.inputs) {
            val pre = i.prefillPath?.let { item.jsonPath(it).jsonText() }
            val def = if (i.default.contains('{')) WorkTemplate.render(i.default, item, mod.idPath, currentParams(), caps, encode = false).orEmpty() else i.default
            values[i.key] = pre ?: def
        }
        val ui = ActionUi(action, item, values)
        _action.value = ui
        // Reads with nothing to fill in run at once.
        if (action.method == "GET" && action.inputs.isEmpty() && action.kind == ActionKind.Api) run()
    }

    fun setValue(key: String, value: String) = _action.update { it?.copy(values = it.values + (key to value), error = null) }

    fun dismiss() {
        val done = _action.value?.stage == ActionUi.Stage.Done && _action.value?.action?.method != "GET"
        _action.value = null
        if (done) afterAction()
    }

    /** Form → confirm (or straight to running for reads). */
    fun submit() {
        val ui = _action.value ?: return
        val errors = com.zipper.app.data.work.WorkForm.validate(ui.action.inputs, ui.values)
        if (errors.isNotEmpty()) { _action.update { it?.copy(error = errors.values.joinToString("\n")) }; return }
        if (ui.action.confirm.isBlank()) run() else _action.update { it?.copy(stage = ActionUi.Stage.Confirm, error = null) }
    }

    fun back() = _action.update { it?.copy(stage = ActionUi.Stage.Form) }

    fun run() {
        val ui = _action.value ?: return
        val caps = currentCaps() ?: return
        val mod = module ?: return
        _action.update { it?.copy(stage = ActionUi.Stage.Running, error = null) }
        viewModelScope.launch {
            when (val r = repo.run(mod, ui.action, ui.item, currentParams(), ui.values, caps)) {
                is WorkRepository.Outcome.Ok -> _action.update {
                    it?.copy(stage = ActionUi.Stage.Done, result = r.value.message, resultBody = r.value.body)
                }
                is WorkRepository.Outcome.Failed -> _action.update {
                    it?.copy(stage = ActionUi.Stage.Form, error = r.error.message)
                }
            }
        }
    }

    fun lookup(term: String) {
        val spec = _action.value?.action?.inputs?.firstOrNull { it.lookup != null }?.lookup ?: return
        if (term.trim().length < spec.minChars) {
            _action.update { it?.copy(lookupError = "Type at least ${spec.minChars} characters.", lookupRows = emptyList()) }
            return
        }
        viewModelScope.launch {
            when (val r = repo.lookup(spec, term.trim())) {
                is WorkRepository.Outcome.Ok -> _action.update {
                    it?.copy(lookupRows = r.value, lookupError = if (r.value.isEmpty()) "Nobody matches exactly." else null)
                }
                is WorkRepository.Outcome.Failed -> _action.update { it?.copy(lookupError = r.error.message) }
            }
        }
    }
}

// ── Hub ───────────────────────────────────────────────────────────────────────

data class WorkHubUi(
    val loading: Boolean = true,
    val error: ApiError? = null,
    val caps: Caps? = null,
    val groups: List<Pair<Group, List<WorkModule>>> = emptyList(),
)

@HiltViewModel
class WorkHubViewModel @Inject constructor(private val repo: WorkRepository) : ViewModel() {
    private val _state = MutableStateFlow(WorkHubUi())
    val state: StateFlow<WorkHubUi> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.value = WorkHubUi(loading = true)
        viewModelScope.launch {
            when (val r = repo.caps()) {
                is WorkRepository.Outcome.Ok -> {
                    WorkCapsCache.caps = r.value
                    _state.value = WorkHubUi(loading = false, caps = r.value, groups = WorkModules.offered(r.value))
                }
                is WorkRepository.Outcome.Failed -> _state.value = WorkHubUi(loading = false, error = r.error)
            }
        }
    }
}

// ── List ──────────────────────────────────────────────────────────────────────

data class WorkListUi(
    val module: WorkModule? = null,
    val caps: Caps? = null,
    val params: Map<String, String> = emptyMap(),
    /** Parameters are filled in and the list has been asked for. */
    val started: Boolean = false,
    val filters: Map<String, String> = emptyMap(),
    val loading: Boolean = false,
    val error: ApiError? = null,
    val rows: List<Item> = emptyList(),
    val root: Item = emptyMap(),
    val names: Map<String, String> = emptyMap(),
    val more: Boolean = false,
    val limit: Int = 50,
    val search: String = "",
)

@HiltViewModel
class WorkListViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    repo: WorkRepository,
) : WorkActionHost(repo) {

    private val moduleId: String = savedStateHandle.get<String>("moduleId").orEmpty()
    private val linkValue: String = savedStateHandle.get<String>("p").orEmpty()

    override val module: WorkModule? = WorkModules.byId(moduleId)

    private val _state = MutableStateFlow(WorkListUi(module = module, limit = module?.pageSize ?: 50))
    val state: StateFlow<WorkListUi> = _state.asStateFlow()

    override fun currentCaps() = _state.value.caps
    override fun currentParams() = _state.value.params
    override fun afterAction() = refresh()

    init { start() }

    private fun start() {
        val mod = module ?: return
        viewModelScope.launch {
            val signedIn = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid
            val cached = WorkCapsCache.caps?.takeIf { it.uid.isNotEmpty() && it.uid == signedIn }
            val caps = cached ?: when (val r = repo.caps()) {
                is WorkRepository.Outcome.Ok -> r.value.also { WorkCapsCache.caps = it }
                is WorkRepository.Outcome.Failed -> { _state.update { it.copy(error = r.error) }; return@launch }
            }
            val params = LinkedHashMap<String, String>()
            mod.params.forEachIndexed { idx, i ->
                val def = if (i.default.contains('{')) WorkTemplate.render(i.default, null, mod.idPath, emptyMap(), caps, encode = false).orEmpty() else i.default
                params[i.key] = if (idx == 0 && linkValue.isNotEmpty()) linkValue else def
            }
            val filters = mod.filters.associate { it.param to it.options.first().first }
            _state.update { it.copy(caps = caps, params = params, filters = filters) }
            val ready = com.zipper.app.data.work.WorkForm.validate(mod.params, params).isEmpty()
            if (ready) refresh()
        }
    }

    fun setParam(key: String, value: String) = _state.update { it.copy(params = it.params + (key to value)) }

    fun setFilter(key: String, value: String) {
        _state.update { it.copy(filters = it.filters + (key to value), limit = module?.pageSize ?: 50) }
        refresh()
    }

    fun setSearch(q: String) = _state.update { it.copy(search = q) }

    fun loadMore() {
        val mod = module ?: return
        _state.update { it.copy(limit = minOf(it.limit + mod.pageSize, mod.maxSize)) }
        refresh()
    }

    fun refresh() {
        val mod = module ?: return
        val s = _state.value
        val caps = s.caps ?: return
        val errors = com.zipper.app.data.work.WorkForm.validate(mod.params, s.params)
        if (errors.isNotEmpty()) {
            _state.update { it.copy(error = ApiError(0, errors.values.first(), ApiError.Kind.Invalid), started = false) }
            return
        }
        _state.update { it.copy(loading = true, error = null, started = true) }
        viewModelScope.launch {
            when (val r = repo.load(mod, s.params, s.filters, s.limit, 0, caps)) {
                is WorkRepository.Outcome.Ok -> {
                    _state.update { it.copy(loading = false, rows = r.value.rows, root = r.value.root, more = r.value.more && it.limit < mod.maxSize) }
                    resolveNames(mod, r.value.rows)
                }
                is WorkRepository.Outcome.Failed -> _state.update { it.copy(loading = false, error = r.error, rows = emptyList(), root = emptyMap()) }
            }
        }
    }

    private suspend fun resolveNames(mod: WorkModule, rows: List<Item>) {
        if (mod.nameUidPaths.isEmpty()) return
        val uids = rows.flatMap { row -> mod.nameUidPaths.mapNotNull { row.jsonPath(it).jsonText() } }
        if (uids.isEmpty()) return
        val names = repo.publicNames(uids)
        _state.update { it.copy(names = it.names + names) }
    }

    fun select(item: Item) {
        val mod = module ?: return
        WorkSelection.put(mod.id, item, _state.value.params)
    }
}

// ── Detail ────────────────────────────────────────────────────────────────────

data class WorkDetailUi(
    val module: WorkModule? = null,
    val caps: Caps? = null,
    val item: Item = emptyMap(),
    val params: Map<String, String> = emptyMap(),
    val loading: Boolean = false,
    val error: ApiError? = null,
    val names: Map<String, String> = emptyMap(),
)

@HiltViewModel
class WorkDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    repo: WorkRepository,
) : WorkActionHost(repo) {

    private val moduleId: String = savedStateHandle.get<String>("moduleId").orEmpty()
    override val module: WorkModule? = WorkModules.byId(moduleId)

    private val _state = MutableStateFlow(WorkDetailUi(module = module))
    val state: StateFlow<WorkDetailUi> = _state.asStateFlow()

    override fun currentCaps() = _state.value.caps
    override fun currentParams() = _state.value.params
    override fun afterAction() = reload()

    init {
        val held = WorkSelection.get(moduleId)
        val signedIn = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid
        val caps = WorkCapsCache.caps?.takeIf { it.uid.isNotEmpty() && it.uid == signedIn }
        _state.update { it.copy(caps = caps, item = held?.first ?: emptyMap(), params = held?.second ?: emptyMap()) }
        reload()
    }

    fun reload() {
        val mod = module ?: return
        val caps = _state.value.caps ?: return
        val item = _state.value.item
        if (item.isEmpty()) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            when (val r = repo.detail(mod, item, _state.value.params, caps)) {
                is WorkRepository.Outcome.Ok -> _state.update { it.copy(loading = false, item = r.value) }
                is WorkRepository.Outcome.Failed -> _state.update { it.copy(loading = false, error = r.error) }
            }
            if (mod.nameUidPaths.isNotEmpty() || mod.detail.any { f -> f.kind == com.zipper.app.data.work.FieldKind.Uid }) {
                val uids = (mod.nameUidPaths + mod.detail.filter { f -> f.kind == com.zipper.app.data.work.FieldKind.Uid }.map { f -> f.path })
                    .mapNotNull { p -> _state.value.item.jsonPath(p).jsonText() }
                if (uids.isNotEmpty()) {
                    val names = repo.publicNames(uids)
                    _state.update { it.copy(names = names) }
                }
            }
        }
    }
}
