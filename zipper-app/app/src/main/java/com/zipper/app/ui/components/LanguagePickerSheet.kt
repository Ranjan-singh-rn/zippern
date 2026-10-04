package com.zipper.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.app.ui.theme.ZipperPink
import com.zipper.app.ui.theme.ZipperPurple
import com.zipper.app.util.ALL_LANGUAGES
import com.zipper.app.util.AppLanguage
import com.zipper.app.util.UserLanguage
import com.zipper.app.util.toUserLanguage

private const val MAX_LANGUAGES = 10

/** Compact chip row shown on the profile/edit screen.
 *  Shows up to [visibleCount] chips then a "+N more" overflow chip.
 *  Tapping the overflow (or the "Add" button) opens [LanguagePickerSheet]. */
@Composable
fun LanguageChipRow(
    selected: List<UserLanguage>,
    onTapOverflow: () -> Unit,
    onRemove: ((UserLanguage) -> Unit)? = null,   // null = read-only chips
    visibleCount: Int = 4,
    modifier: Modifier = Modifier,
) {
    if (selected.isEmpty()) {
        Text(
            "No languages added",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(0.4f),
            modifier = modifier,
        )
        return
    }

    val visible = selected.take(visibleCount)
    val overflow = selected.size - visibleCount

    LazyRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = PaddingValues(end = 4.dp),
    ) {
        items(visible) { lang ->
            LangChip(lang = lang, onRemove = onRemove)
        }
        if (overflow > 0) {
            item {
                AssistChip(
                    onClick = onTapOverflow,
                    label = { Text("+$overflow more", fontSize = 12.sp) },
                    shape = RoundedCornerShape(50),
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = ZipperPurple.copy(0.15f),
                        labelColor = ZipperPurple,
                    ),
                    border = AssistChipDefaults.assistChipBorder(
                        enabled = true,
                        borderColor = ZipperPurple.copy(0.3f),
                    ),
                )
            }
        }
    }
}

@Composable
private fun LangChip(
    lang: UserLanguage,
    onRemove: ((UserLanguage) -> Unit)?,
) {
    InputChip(
        selected = true,
        onClick = { onRemove?.invoke(lang) },
        label = { Text(lang.name, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingIcon = if (onRemove != null) {
            { Icon(Icons.Default.Close, contentDescription = "Remove", modifier = Modifier.size(14.dp)) }
        } else null,
        shape = RoundedCornerShape(50),
        colors = InputChipDefaults.inputChipColors(
            selectedContainerColor = ZipperPink.copy(0.15f),
            selectedLabelColor = ZipperPink,
            selectedTrailingIconColor = ZipperPink.copy(0.7f),
        ),
        border = InputChipDefaults.inputChipBorder(
            enabled = true,
            selected = true,
            selectedBorderColor = ZipperPink.copy(0.35f),
        ),
    )
}

/** Full-screen bottom sheet: searchable list of all ISO languages, multi-select. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LanguagePickerSheet(
    selected: List<UserLanguage>,
    onDismiss: () -> Unit,
    onConfirm: (List<UserLanguage>) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf(selected.toMutableStateList()) }

    val filtered = remember(query) {
        if (query.isBlank()) ALL_LANGUAGES
        else ALL_LANGUAGES.filter {
            it.name.contains(query, ignoreCase = true) ||
            it.nativeName.contains(query, ignoreCase = true) ||
            it.code.contains(query, ignoreCase = true)
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 12.dp, bottom = 4.dp)
                    .size(width = 40.dp, height = 4.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurface.copy(0.2f)),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 8.dp),
        ) {
            // ── Header ────────────────────────────────────────────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        "Select Languages",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "${draft.size}/$MAX_LANGUAGES selected",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(0.5f),
                    )
                }
                Button(
                    onClick = { onConfirm(draft.toList()); onDismiss() },
                    shape = RoundedCornerShape(50),
                    colors = ButtonDefaults.buttonColors(containerColor = ZipperPink),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                ) {
                    Text("Done", fontWeight = FontWeight.Bold)
                }
            }

            // ── Selected chips preview ────────────────────────────────────────
            if (draft.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(draft, key = { it.id }) { lang ->
                        LangChip(lang = lang) { removed ->
                            draft.remove(removed)
                        }
                    }
                }
            }

            // ── Search ────────────────────────────────────────────────────────
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search language…", fontSize = 14.sp) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = ZipperPink) },
                trailingIcon = if (query.isNotBlank()) {
                    { IconButton(onClick = { query = "" }) {
                        Icon(Icons.Default.Close, contentDescription = "Clear", modifier = Modifier.size(18.dp))
                    }}
                } else null,
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ZipperPink,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(0.4f),
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
            )

            // ── Language list ─────────────────────────────────────────────────
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
            ) {
                items(filtered, key = { it.id }) { lang ->
                    val isSelected = draft.any { it.id == lang.id }
                    val atMax = draft.size >= MAX_LANGUAGES && !isSelected
                    LanguageListItem(
                        lang       = lang,
                        isSelected = isSelected,
                        disabled   = atMax,
                        onClick    = {
                            if (isSelected) {
                                draft.removeAll { it.id == lang.id }
                            } else if (!atMax) {
                                draft.add(lang.toUserLanguage())
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun LanguageListItem(
    lang: AppLanguage,
    isSelected: Boolean,
    disabled: Boolean,
    onClick: () -> Unit,
) {
    val alpha = if (disabled) 0.35f else 1f

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = !disabled, onClick = onClick)
            .background(
                if (isSelected) ZipperPink.copy(0.08f) else Color.Transparent
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                lang.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha),
            )
            if (lang.nativeName != lang.name) {
                Text(
                    lang.nativeName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(0.5f * alpha),
                )
            }
        }
        if (isSelected) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(ZipperPink),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(14.dp),
                )
            }
        } else {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .border(1.5.dp, MaterialTheme.colorScheme.outline.copy(0.3f * alpha), CircleShape),
            )
        }
    }
}
