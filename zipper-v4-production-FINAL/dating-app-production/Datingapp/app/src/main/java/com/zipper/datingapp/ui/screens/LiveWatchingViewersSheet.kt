package com.zipper.datingapp.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.DatingUiState

/**
 * Bottom sheet that shows the list of viewers (by UID) for a PK stream side.
 *
 * Viewer profiles are resolved lazily from [DatingUiState] where available,
 * or displayed as placeholder stubs otherwise.
 *
 * @param viewerUids  Ordered list of viewer Firebase UIDs
 * @param uiState     Ambient DatingUiState (used to resolve profiles by UID)
 * @param currentUserId Firebase UID of the signed-in user (excluded from list)
 * @param sheetTitle  Label shown in the sheet header (e.g. "Host Viewers 12")
 * @param onDismiss   Callback when the sheet should close
 * @param onOpenViewerProfile Callback when a viewer row is tapped (receives resolved profile or stub)
 * @param onFollowViewer Callback when Follow button is tapped on a viewer row
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveWatchingViewersSheet(
    viewerUids: List<String>,
    uiState: DatingUiState,
    currentUserId: String,
    sheetTitle: String = "Viewers",
    onDismiss: () -> Unit,
    onOpenViewerProfile: (UserProfile) -> Unit,
    onFollowViewer: (UserProfile) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 24.dp)
        ) {
            // ── Header ───────────────────────────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                Text(
                    text = sheetTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.Center),
                )
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterEnd),
                ) {
                    Text("Close", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            if (viewerUids.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "No viewers yet",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 14.sp,
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(viewerUids.filter { it != currentUserId }) { uid ->
                        // Resolve from uiState profiles if available
                        val profile = remember(uid, uiState) {
                            uiState.profiles.firstOrNull { it.id == uid }
                                ?: uiState.followedProfiles.firstOrNull { it.id == uid }
                                ?: UserProfile(id = uid, name = uid.take(8))
                        }
                        ViewerRow(
                            profile = profile,
                            onTap = { onOpenViewerProfile(profile) },
                            onFollow = { onFollowViewer(profile) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ViewerRow(
    profile: UserProfile,
    onTap: () -> Unit,
    onFollow: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Avatar
        if (profile.photoUrl.isNotBlank()) {
            AsyncImage(
                model = profile.photoUrl,
                contentDescription = profile.name,
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
            )
        } else {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = profile.name.take(1).uppercase().ifBlank { "?" },
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp,
                )
            }
        }

        // Name + level
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = profile.name.ifBlank { profile.id.take(8) },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (profile.level > 0) {
                Text(
                    text = "Lv ${profile.level}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Follow button
        TextButton(onClick = onFollow) {
            Text(
                text = "Follow",
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
            )
        }
    }
}
