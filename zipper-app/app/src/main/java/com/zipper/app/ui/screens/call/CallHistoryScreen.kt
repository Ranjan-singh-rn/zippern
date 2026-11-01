package com.zipper.app.ui.screens.call

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.zipper.app.data.model.CallRecord
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.messages.timeAgo
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Call history — rows: 44 avatar, name, direction icon + label, duration,
 * beans figure coloured by sign, "2m ago". Tap opens the profile.
 */

private fun formatDuration(seconds: Long): String {
    if (seconds <= 0L) return "Missed"
    val m = seconds / 60
    val s = seconds % 60
    return "%d:%02d".format(m, s)
}

@Composable
fun CallHistoryScreen(
    onBack: () -> Unit = {},
    onViewProfile: (String) -> Unit = {},
    viewModel: CallHistoryViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    ZipperScreen(topBar = { TopBar("Call history", onBack = onBack) }) { _ ->
        when {
            state.isLoading -> LoadingState()
            // B2: a failed read is not an empty history.
            state.error != null && state.calls.isEmpty() -> EmptyState(Icons.Outlined.Call, "Call history unavailable", state.error ?: "", actionLabel = "Try again", onAction = viewModel::load)
            state.calls.isEmpty() -> EmptyState(Icons.Outlined.Call, "No calls yet", "Open a host's profile and start a video call — every call you make or receive shows up here.")
            else -> LazyColumn(contentPadding = PaddingValues(bottom = Space.xl)) {
                items(state.calls) { call ->
                    CallRow(call = call, onViewProfile = onViewProfile)
                    HairlineDivider()
                }
                item { Spacer(Modifier.navigationBarsPadding()) }
            }
        }
    }
}

@Composable
private fun CallRow(call: CallRecord, onViewProfile: (String) -> Unit) {
    val c = ZipperTheme.colors
    val typeColor = when (call.type) {
        "outgoing" -> c.currencyDiamond
        "incoming" -> c.currencyBean
        else       -> c.statusDanger
    }
    val typeIcon = when (call.type) {
        "outgoing" -> Icons.AutoMirrored.Filled.CallMade
        "incoming" -> Icons.AutoMirrored.Filled.CallReceived
        else       -> Icons.AutoMirrored.Filled.CallMissed
    }
    val typeLabel = when (call.type) {
        "outgoing" -> "Outgoing"
        "incoming" -> "Incoming"
        else       -> "Missed"
    }

    Row(
        Modifier.fillMaxWidth().clickableNoRipple { onViewProfile(call.otherUserUid) }.padding(horizontal = Space.lg, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Avatar(call.otherUserPhotoUrl.ifBlank { null }, size = AvatarSize.MD, initial = call.otherUserName)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(call.otherUserName.ifBlank { "User" }, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Icon(typeIcon, null, tint = typeColor, modifier = Modifier.size(14.dp))
                Text(typeLabel, style = ZipperTheme.type.caption, color = typeColor)
                Text("·", style = ZipperTheme.type.caption, color = c.textMuted)
                Text(formatDuration(call.durationSeconds), style = ZipperTheme.type.caption, color = if (call.type == "missed") c.statusDanger else c.textMuted)
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(timeAgo(call.timestamp), style = ZipperTheme.type.caption, color = c.textMuted)
            when {
                call.type == "outgoing" && call.costBeans > 0 ->
                    Text("−" + indianGrouping(call.costBeans), style = ZipperTheme.type.numericS, color = c.statusDanger)
                call.type == "incoming" && call.costBeans > 0 ->
                    Text("+" + indianGrouping(call.costBeans), style = ZipperTheme.type.numericS, color = c.currencyBean)
            }
        }
    }
}
