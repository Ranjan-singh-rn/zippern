package com.zipper.app.ui.screens.work

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.WorkOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.api.ApiError
import com.zipper.app.data.work.ActionKind
import com.zipper.app.data.work.Caps
import com.zipper.app.data.work.Field
import com.zipper.app.data.work.FieldKind
import com.zipper.app.data.work.Input
import com.zipper.app.data.work.InputType
import com.zipper.app.data.work.Item
import com.zipper.app.data.work.Link
import com.zipper.app.data.work.WorkAction
import com.zipper.app.data.work.WorkDisplay
import com.zipper.app.data.work.WorkForm
import com.zipper.app.data.work.WorkModule
import com.zipper.app.data.work.WorkRows
import com.zipper.app.data.work.WorkTemplate
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.jsonList
import com.zipper.app.util.jsonMap
import com.zipper.app.util.jsonPath
import com.zipper.app.util.jsonText

/** Where a [Link] leads outside the work screens. */
interface WorkNav {
    fun module(moduleId: String, param: String)
    fun detail(moduleId: String)
    fun appProfile(uid: String)
    fun appLive(roomId: String)
    fun back()
}

private fun follow(nav: WorkNav, link: Link, value: String) {
    if (value.isBlank()) return
    when (link.moduleId) {
        "app.profile" -> nav.appProfile(value)
        "app.live" -> nav.appLive(value)
        else -> nav.module(link.moduleId, value)
    }
}

// ── Hub ───────────────────────────────────────────────────────────────────────

@Composable
fun WorkHubScreen(nav: WorkNav, viewModel: WorkHubViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    ZipperScreen(topBar = {
        TopBar("Work", onBack = nav::back, actions = {
            IconButtonCircle(Icons.Default.Refresh, "Refresh", viewModel::load, size = 36.dp)
        })
    }) { _ ->
        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorBlock(state.error!!, onRetry = viewModel::load)
            else -> {
                val caps = state.caps ?: Caps()
                LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md),
                    verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    item {
                        Column(Modifier.fillMaxWidth().padding(bottom = Space.sm)) {
                            Text(caps.name.ifBlank { caps.email.ifBlank { "Signed in" } }, style = ZipperTheme.type.headingM, color = c.textPrimary)
                            // Every live role, each named — a dual-role partner reads both (see Caps.roleSummary).
                            Text(caps.roleSummary, style = ZipperTheme.type.bodyS, color = c.textSecondary)
                            if (caps.isPendingPartner) Text(
                                "Your application is still being reviewed — your work screens open once it is approved.",
                                style = ZipperTheme.type.bodyS, color = c.statusWarning,
                            )
                            if (caps.isObserver) Text("Read-only account.", style = ZipperTheme.type.bodyS, color = c.textMuted)
                        }
                    }
                    if (state.groups.isEmpty()) {
                        item { EmptyState(Icons.Outlined.WorkOutline, "Nothing to work on here", "This account has no work screens on mobile yet.") }
                    }
                    state.groups.forEach { (group, mods) ->
                        item { SectionHeader(group.title, Modifier.padding(top = Space.sm)) }
                        mods.forEach { m ->
                            item(key = m.id) {
                                Row(
                                    Modifier.fillMaxWidth()
                                        .background(c.bgRaised, RoundedCornerShape(Radius.lg))
                                        .clickableNoRipple { nav.module(m.id, "") }
                                        .padding(Space.md),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(m.title, style = ZipperTheme.type.labelL, color = c.textPrimary)
                                        Text(m.summary, style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    }
                                    Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.navigationBarsPadding().height(Space.lg)) }
                }
            }
        }
    }
}

// ── List ──────────────────────────────────────────────────────────────────────

@Composable
fun WorkListScreen(nav: WorkNav, viewModel: WorkListViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val action by viewModel.action.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val mod = state.module
    if (mod == null) {
        ZipperScreen(topBar = { TopBar("Work", onBack = nav::back) }) { _ ->
            EmptyState(Icons.Outlined.ErrorOutline, "Screen not found", "This work screen does not exist in this build.")
        }
        return
    }
    val caps = state.caps
    ZipperScreen(topBar = {
        TopBar(mod.title, onBack = nav::back, actions = {
            IconButtonCircle(Icons.Default.Refresh, "Refresh", viewModel::refresh, size = 36.dp)
        })
    }) { _ ->
        if (caps != null && !mod.gate(caps)) {
            EmptyState(Icons.Outlined.Lock, "Not available to your account", "The server does not offer this screen to your role.")
            return@ZipperScreen
        }
        val visibleRows = state.rows.filter { WorkRows.matches(it, state.search, mod.searchPaths + mod.titlePaths, mod.idPath) }
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            item {
                Column {
                    Text(mod.summary, style = ZipperTheme.type.bodyS, color = c.textSecondary)
                    if (mod.note.isNotBlank()) Text(mod.note, style = ZipperTheme.type.caption, color = c.textMuted, modifier = Modifier.padding(top = Space.xs))
                }
            }
            if (mod.params.isNotEmpty()) item {
                CardBox {
                    WorkForm.visible(mod.params, state.params).forEach { i ->
                        InputField(i, state.params[i.key].orEmpty()) { v -> viewModel.setParam(i.key, v) }
                    }
                    ZipperButton("Show", viewModel::refresh, size = ButtonSize.Medium, fullWidth = true)
                }
            }
            if (mod.filters.isNotEmpty()) item {
                Column {
                    mod.filters.forEach { f ->
                        ChoiceRow(f.options, state.filters[f.param].orEmpty()) { v -> viewModel.setFilter(f.param, v) }
                    }
                }
            }
            if (caps != null) {
                val pageActions = mod.pageActions.filter { it.gate(caps) && it.showFor(state.root, caps) }
                if (pageActions.isNotEmpty() && (mod.params.isEmpty() || state.started)) item {
                    ActionButtons(pageActions) { a -> runOrNavigate(a, state.root, mod, state.params, caps, nav, viewModel) }
                }
            }
            if (mod.header.isNotEmpty() && state.root.isNotEmpty()) item {
                CardBox { FieldList(mod.header, state.root, caps, state.names, nav) }
            }
            when {
                state.loading && state.rows.isEmpty() -> item { Box(Modifier.fillMaxWidth().height(160.dp)) { LoadingState() } }
                state.error != null -> item { ErrorBlock(state.error!!, onRetry = viewModel::refresh) }
                !state.started -> Unit
                state.rows.isEmpty() && (mod.source as? com.zipper.app.data.work.Source.Api)?.arrayKey != "__none__" ->
                    item { EmptyState(Icons.Outlined.Inbox, "Nothing here", "There is nothing to show for these choices.") }
                else -> {
                    if (state.rows.size > 6) item {
                        PlainField("Search these rows", state.search, onChange = viewModel::setSearch)
                    }
                    itemsIndexed(visibleRows, key = { idx, row -> rowKey(row, mod, idx) }) { _, row ->
                        RowCard(mod, row, state.names) {
                            viewModel.select(row)
                            nav.detail(mod.id)
                        }
                    }
                    if (state.more) item {
                        ZipperButton("Load more", viewModel::loadMore, style = ButtonStyle.Secondary, size = ButtonSize.Medium, fullWidth = true, loading = state.loading)
                    }
                }
            }
            item { Spacer(Modifier.navigationBarsPadding().height(Space.lg)) }
        }
    }
    action?.let { ui -> ActionDialog(ui, caps, nav, viewModel) }
}

private fun rowKey(row: Item, mod: WorkModule, idx: Int): String =
    (row.jsonPath(mod.idPath).jsonText() ?: "") + "#" + idx

private fun runOrNavigate(a: WorkAction, item: Item, mod: WorkModule, params: Map<String, String>, caps: Caps, nav: WorkNav, host: WorkActionHost) {
    when (a.kind) {
        ActionKind.Navigate -> {
            val target = a.target ?: return
            val v = WorkTemplate.render(target.param, item, mod.idPath, params, caps, encode = false) ?: return
            follow(nav, target, v)
        }
        else -> host.open(a, item)
    }
}

@Composable
private fun RowCard(mod: WorkModule, row: Item, names: Map<String, String>, onOpen: () -> Unit) {
    val c = ZipperTheme.colors
    val columns = mod.columnsPath?.let { row.columnsFrom(it) }
    Row(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.lg)).clickableNoRipple(onOpen).padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val title = if (columns != null) columns.firstOrNull()?.second ?: "—" else titleOf(mod, row, names)
            Text(title, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (columns != null) {
                columns.drop(1).take(3).forEach { (h, v) -> Text("$h: $v", style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            } else {
                mod.subtitle.forEach { f ->
                    val v = valueOf(f, row, names)
                    if (v != "—") Text("${f.label}: $v", style = ZipperTheme.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        mod.statusPath?.let { p -> row.jsonPath(p).jsonText()?.takeIf { it.isNotBlank() } }?.let { s ->
            Chip(WorkDisplay.status(s))
        }
        Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
    }
}

/** A row title: the configured paths, with a uid replaced by its public name when known. */
private fun titleOf(mod: WorkModule, row: Item, names: Map<String, String>): String {
    for (p in mod.titlePaths) {
        val v = row.jsonPath(p).jsonText()?.takeIf { it.isNotBlank() } ?: continue
        if (p in mod.nameUidPaths) return names[v]?.let { "$it (ID: $v)" } ?: "ID: $v"
        return v
    }
    return mod.idPath.let { row.jsonPath(it).jsonText() } ?: "—"
}

private fun valueOf(f: Field, row: Item, names: Map<String, String>): String {
    val raw = row.jsonPath(f.path)
    val text = WorkDisplay.value(raw, f.kind)
    val name = raw.jsonText()?.let { names[it] }
    return if (name != null) "$name ($text)" else text
}

/** `columns: [{key, header}]` → header/value pairs for a report row. */
private fun Item.columnsFrom(rootColumnsPath: String): List<Pair<String, String>>? {
    val cols = this["__columns"].jsonList() ?: return null
    return cols.mapNotNull { col ->
        val m = col.jsonMap() ?: return@mapNotNull null
        val key = m["key"].jsonText() ?: return@mapNotNull null
        val header = m["header"].jsonText() ?: key
        header to WorkDisplay.value(this[key], if (key.endsWith("_minor")) FieldKind.Money else FieldKind.Text)
    }
}

// ── Detail ────────────────────────────────────────────────────────────────────

@Composable
fun WorkDetailScreen(nav: WorkNav, viewModel: WorkDetailViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val action by viewModel.action.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val mod = state.module
    val caps = state.caps
    ZipperScreen(topBar = { TopBar(mod?.title ?: "Detail", onBack = nav::back) }) { _ ->
        if (mod == null || caps == null || state.item.isEmpty()) {
            EmptyState(Icons.Outlined.ErrorOutline, "Nothing selected", "Open this record again from its list.", actionLabel = "Back", onAction = nav::back)
            return@ZipperScreen
        }
        var showAll by remember { mutableStateOf(false) }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.md)) {
            if (state.loading) Text("Refreshing…", style = ZipperTheme.type.caption, color = c.textMuted)
            state.error?.let { ErrorBlock(it, onRetry = viewModel::reload) }
            val columns = mod.columnsPath?.let { state.item.columnsFrom(it) }
            CardBox {
                if (columns != null) columns.forEach { (h, v) -> KeyValue(h, v) }
                else FieldList(mod.detail.ifEmpty { emptyList() }, state.item, caps, state.names, nav)
                if (mod.detail.isEmpty() && columns == null) {
                    WorkDisplay.allFields(state.item.filterKeys { it !in mod.hide }).forEach { (k, v) -> KeyValue(k, v) }
                }
            }
            val actions = mod.actions.filter { it.gate(caps) && it.showFor(state.item, caps) }
            if (actions.isNotEmpty()) ActionButtons(actions) { a ->
                if (a.kind == ActionKind.OpenUrl) Unit else runOrNavigate(a, state.item, mod, state.params, caps, nav, viewModel)
            }
            val uri = LocalUriHandler.current
            actions.filter { it.kind == ActionKind.OpenUrl }.forEach { a ->
                val url = a.urlPath?.let { state.item.jsonPath(it).jsonText() }.orEmpty()
                if (url.startsWith("https://")) ZipperButton(a.label, { runCatching { uri.openUri(url) } }, style = ButtonStyle.Secondary, size = ButtonSize.Medium, fullWidth = true)
            }
            if (mod.detail.isNotEmpty()) {
                ZipperButton(if (showAll) "Hide all fields" else "All fields", { showAll = !showAll }, style = ButtonStyle.Ghost, size = ButtonSize.Small)
                if (showAll) CardBox {
                    WorkDisplay.allFields(state.item.filterKeys { it !in mod.hide }).forEach { (k, v) -> KeyValue(k, v) }
                }
            }
            Spacer(Modifier.navigationBarsPadding().height(Space.lg))
        }
    }
    action?.let { ui -> ActionDialog(ui, caps, nav, viewModel) }
}

// ── Pieces ────────────────────────────────────────────────────────────────────

@Composable
private fun FieldList(fields: List<Field>, item: Item, caps: Caps?, names: Map<String, String>, nav: WorkNav) {
    val c = ZipperTheme.colors
    val uri = LocalUriHandler.current
    for (f in fields) {
        if (f.visibleTo != null && (caps == null || !f.visibleTo.invoke(caps))) continue
        val raw = item.jsonPath(f.path) ?: continue
        if (raw is String && raw.isBlank()) continue
        if (f.kind == FieldKind.Url) {
            val url = raw.jsonText().orEmpty()
            if (url.startsWith("https://")) Column {
                Text(f.label, style = ZipperTheme.type.caption, color = c.textSecondary)
                Text("Open", style = ZipperTheme.type.labelM, color = c.textBrand, modifier = Modifier.clickableNoRipple { runCatching { uri.openUri(url) } })
            }
            continue
        }
        val text = WorkDisplay.mask(f.path.substringAfterLast('.'), WorkDisplay.value(raw, f.kind))
        val name = if (f.kind == FieldKind.Uid) raw.jsonText()?.let { names[it] } else null
        val shown = if (name != null) "$name (ID: $text)" else text
        val link = f.link
        Column(Modifier.fillMaxWidth()) {
            Text(f.label, style = ZipperTheme.type.caption, color = c.textSecondary)
            Text(
                shown, style = ZipperTheme.type.bodyM, color = if (link != null) c.textBrand else c.textPrimary,
                modifier = if (link != null) Modifier.clickableNoRipple { follow(nav, link, raw.jsonText().orEmpty()) } else Modifier,
            )
        }
    }
}

@Composable
private fun KeyValue(k: String, v: String) {
    val c = ZipperTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Text(k, style = ZipperTheme.type.caption, color = c.textSecondary)
        Text(v, style = ZipperTheme.type.bodyM, color = c.textPrimary)
    }
}

@Composable
private fun CardBox(content: @Composable ColumnScope.() -> Unit) {
    val c = ZipperTheme.colors
    Column(
        Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
        content = content,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActionButtons(actions: List<WorkAction>, onClick: (WorkAction) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        actions.forEach { a ->
            ZipperButton(a.label, { onClick(a) },
                style = when {
                    a.danger -> ButtonStyle.Danger
                    a.kind == ActionKind.Info -> ButtonStyle.Ghost
                    a.kind == ActionKind.Navigate || a.method == "GET" -> ButtonStyle.Secondary
                    else -> ButtonStyle.Primary
                },
                size = ButtonSize.Small)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceRow(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val c = ZipperTheme.colors
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.xs), verticalArrangement = Arrangement.spacedBy(Space.xs),
        modifier = Modifier.padding(vertical = Space.xs)) {
        options.forEach { (value, label) ->
            val on = value == selected
            Text(
                label,
                style = ZipperTheme.type.labelM,
                color = if (on) c.textOnBrand else c.textSecondary,
                modifier = Modifier
                    .background(if (on) c.brandPrimary else c.bgElevated, RoundedCornerShape(Radius.md))
                    .clickableNoRipple { onSelect(value) }
                    .padding(horizontal = Space.md, vertical = Space.sm),
            )
        }
    }
}

@Composable
private fun PlainField(label: String, value: String, keyboard: KeyboardType = KeyboardType.Text, singleLine: Boolean = true, onChange: (String) -> Unit) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text(label, style = ZipperTheme.type.labelM, color = c.textSecondary)
        Box(
            Modifier.fillMaxWidth().heightIn(min = if (singleLine) 48.dp else 96.dp)
                .background(c.bgElevated, RoundedCornerShape(Radius.lg)).border(1.dp, c.borderDefault, RoundedCornerShape(Radius.lg))
                .padding(horizontal = Space.md, vertical = Space.sm),
        ) {
            BasicTextField(
                value = value, onValueChange = onChange, singleLine = singleLine,
                textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboard),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun InputField(i: Input, value: String, onChange: (String) -> Unit) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        when (i.type) {
            InputType.Choice -> {
                Text(i.label, style = ZipperTheme.type.labelM, color = c.textSecondary)
                ChoiceRow(i.options, value, onChange)
            }
            InputType.Bool -> {
                Text(i.label, style = ZipperTheme.type.labelM, color = c.textSecondary)
                ChoiceRow(listOf("true" to "Yes", "false" to "No"), value, onChange)
            }
            InputType.Int -> PlainField(i.label + if (!i.required) " (optional)" else "", value, KeyboardType.Number, onChange = onChange)
            InputType.Rupees -> PlainField(i.label, value, KeyboardType.Decimal, onChange = onChange)
            InputType.LongText, InputType.Lines -> PlainField(i.label + if (!i.required) " (optional)" else "", value, singleLine = false, onChange = onChange)
            else -> PlainField(i.label, value, onChange = onChange)
        }
        if (i.help.isNotBlank()) Text(i.help, style = ZipperTheme.type.caption, color = c.textMuted)
    }
}

@Composable
private fun ErrorBlock(error: ApiError, onRetry: () -> Unit) {
    val (title, icon) = when (error.kind) {
        ApiError.Kind.Forbidden -> "Not allowed for your account" to Icons.Outlined.Lock
        ApiError.Kind.NoAccount -> "No work account for this login" to Icons.Outlined.Lock
        ApiError.Kind.NotConfigured -> "Work server not configured" to Icons.Outlined.ErrorOutline
        ApiError.Kind.SignedOut -> "Signed out" to Icons.Outlined.Lock
        ApiError.Kind.Invalid -> "Check the details" to Icons.Outlined.ErrorOutline
        else -> "Couldn't load this" to Icons.Outlined.ErrorOutline
    }
    val retry = error.kind !in setOf(ApiError.Kind.NotConfigured, ApiError.Kind.NoAccount, ApiError.Kind.Forbidden, ApiError.Kind.Invalid)
    EmptyState(icon, title, error.message, actionLabel = if (retry) "Try again" else null, onAction = if (retry) onRetry else null)
}

// ── The action dialog: form → confirm → result ──────────────────────────────

@Composable
private fun ActionDialog(ui: ActionUi, caps: Caps?, nav: WorkNav, host: WorkActionHost) {
    val c = ZipperTheme.colors
    val uri = LocalUriHandler.current
    AlertDialog(
        onDismissRequest = { if (ui.stage != ActionUi.Stage.Running) host.dismiss() },
        containerColor = c.bgElevated,
        title = { Text(ui.action.label, style = ZipperTheme.type.headingS, color = c.textPrimary) },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                when (ui.stage) {
                    ActionUi.Stage.Form -> {
                        if (ui.action.help.isNotBlank()) Text(ui.action.help, style = ZipperTheme.type.bodyS, color = c.textSecondary)
                        WorkForm.visible(ui.action.inputs, ui.values).forEach { i ->
                            InputField(i, ui.values[i.key].orEmpty()) { v -> host.setValue(i.key, v) }
                            if (i.type == InputType.Lookup) {
                                ZipperButton("Find", { host.lookup(ui.values[i.key].orEmpty()) }, style = ButtonStyle.Secondary, size = ButtonSize.Small)
                                ui.lookupError?.let { Text(it, style = ZipperTheme.type.caption, color = c.statusWarning) }
                                ui.lookupRows.forEach { row ->
                                    val spec = i.lookup!!
                                    val value = row.jsonPath(spec.valuePath).jsonText().orEmpty()
                                    Column(Modifier.fillMaxWidth().background(c.bgRaised, RoundedCornerShape(Radius.md))
                                        .clickableNoRipple { host.setValue(i.key, value) }.padding(Space.sm)) {
                                        Text(row.jsonPath(spec.titlePath).jsonText() ?: value, style = ZipperTheme.type.labelM, color = c.textPrimary)
                                        spec.subtitlePaths.mapNotNull { p -> row.jsonPath(p).jsonText()?.takeIf { it.isNotBlank() } }
                                            .forEach { Text(it, style = ZipperTheme.type.caption, color = c.textSecondary) }
                                    }
                                }
                            }
                        }
                        ui.error?.let { Text(it, style = ZipperTheme.type.bodyS, color = c.statusDanger) }
                        if (ui.action.inputs.isEmpty() && ui.action.confirm.isNotBlank()) Text(ui.action.confirm, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    }
                    ActionUi.Stage.Confirm -> Text(ui.action.confirm, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                    ActionUi.Stage.Running -> Box(Modifier.fillMaxWidth().height(80.dp)) { LoadingState() }
                    ActionUi.Stage.Done -> {
                        if (!ui.result.isNullOrBlank()) Text(ui.result, style = ZipperTheme.type.bodyM, color = c.textPrimary)
                        ResultView(ui.resultBody) { url -> runCatching { uri.openUri(url) } }
                    }
                }
            }
        },
        confirmButton = {
            when (ui.stage) {
                ActionUi.Stage.Form -> TextButton(onClick = {
                    if (ui.action.inputs.isEmpty() && ui.action.confirm.isNotBlank()) host.run() else host.submit()
                }) { Text(if (ui.action.inputs.isEmpty() && ui.action.method == "GET") "Show" else "Continue", color = c.textBrand) }
                ActionUi.Stage.Confirm -> TextButton(onClick = host::run) {
                    Text("Confirm", color = if (ui.action.danger) c.statusDanger else c.textBrand)
                }
                ActionUi.Stage.Running -> Unit
                ActionUi.Stage.Done -> TextButton(onClick = host::dismiss) { Text("Close", color = c.textBrand) }
            }
        },
        dismissButton = {
            when (ui.stage) {
                ActionUi.Stage.Form -> TextButton(onClick = host::dismiss) { Text("Cancel", color = c.textSecondary) }
                ActionUi.Stage.Confirm -> TextButton(onClick = host::back) { Text("Back", color = c.textSecondary) }
                else -> Unit
            }
        },
    )
}

/** A server answer shown after an action: its fields, with any https link openable. */
@Composable
private fun ResultView(body: Any?, openUrl: (String) -> Unit) {
    val c = ZipperTheme.colors
    val map = body.jsonMap()
    val list = body.jsonList()
    val docs = map?.get("documents").jsonList() ?: map?.get("evidence").jsonList()
    when {
        docs != null -> docs.forEach { d ->
            val m = d.jsonMap() ?: return@forEach
            val url = m["url"].jsonText().orEmpty()
            val label = m["label"].jsonText() ?: m["kind"].jsonText() ?: m["slot"].jsonText() ?: "Document"
            if (url.startsWith("https://")) Text("Open $label", style = ZipperTheme.type.labelM, color = c.textBrand,
                modifier = Modifier.clickableNoRipple { openUrl(url) })
            else Text("$label — ${m["error"].jsonText() ?: "not available"}", style = ZipperTheme.type.caption, color = c.textMuted)
        }
        map != null -> WorkDisplay.allFields(map).take(40).forEach { (k, v) -> KeyValue(k, v) }
        list != null -> list.take(50).forEach { row ->
            Text(WorkDisplay.compact(row), style = ZipperTheme.type.bodyS, color = c.textSecondary)
            HairlineDivider()
        }
        else -> Unit
    }
}
