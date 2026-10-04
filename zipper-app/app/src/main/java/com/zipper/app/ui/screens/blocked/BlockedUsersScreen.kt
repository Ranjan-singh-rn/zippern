package com.zipper.app.ui.screens.blocked

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.zipper.app.data.repository.ProfileRepository
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

// ── Data model ────────────────────────────────────────────────────────────────

data class BlockedUser(
    val uid: String = "",
    val name: String = "",
    val photoUrl: String = "",
)

// ── ViewModel ─────────────────────────────────────────────────────────────────

data class BlockedUsersUiState(
    val blockedUsers: List<BlockedUser> = emptyList(),
    val isLoading: Boolean = true,
)

@HiltViewModel
class BlockedUsersViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val repo: ProfileRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(BlockedUsersUiState())
    val uiState: StateFlow<BlockedUsersUiState> = _uiState.asStateFlow()

    private var listenerReg: ListenerRegistration? = null

    init { attachListener() }

    private fun attachListener() {
        val myUid = auth.currentUser?.uid ?: return
        listenerReg = firestore.collection("users").document(myUid)
            .collection("blocked")
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    val uid  = doc.id
                    val name = doc.getString("name") ?: return@mapNotNull null
                    val photo = doc.getString("photoUrl") ?: ""
                    BlockedUser(uid, name, photo)
                } ?: emptyList()
                _uiState.update { it.copy(blockedUsers = list, isLoading = false) }
            }
    }

    fun unblock(targetUid: String) {
        viewModelScope.launch { repo.unblockUser(targetUid) }
        // List updates automatically via listener
    }

    override fun onCleared() {
        super.onCleared()
        listenerReg?.remove()
    }
}

// ── Screen ────────────────────────────────────────────────────────────────────

/*
 * Blocked users — glass rows: 44 avatar, name, "Blocked" caption, and a small
 * Secondary "Unblock" button that confirms before acting.
 */
@Composable
fun BlockedUsersScreen(
    onBack: () -> Unit,
    onViewProfile: (uid: String) -> Unit = {},
    viewModel: BlockedUsersViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    var pending by remember { mutableStateOf<BlockedUser?>(null) }

    ZipperScreen(topBar = { TopBar("Blocked users", onBack = onBack) }) { _ ->
        if (state.isLoading) { LoadingState(); return@ZipperScreen }
        if (state.blockedUsers.isEmpty()) {
            EmptyState(Icons.Outlined.Block, "Nobody blocked", "People you block from a profile or chat will show up here, and you can unblock them any time.")
            return@ZipperScreen
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            items(state.blockedUsers, key = { it.uid }) { blocked ->
                GlassCard(Modifier.clickableNoRipple { onViewProfile(blocked.uid) }, padding = PaddingValues(Space.md)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        Avatar(blocked.photoUrl, size = AvatarSize.MD, initial = blocked.name)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(blocked.name.ifBlank { "User" }, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            // TODO: BlockedUser has no blockedAt timestamp (the Firestore doc isn't read for one); show timeAgo(blockedAt) once the model carries it.
                            Text("Blocked", style = ZipperTheme.type.caption, color = c.textMuted)
                        }
                        ZipperButton("Unblock", { pending = blocked }, style = ButtonStyle.Secondary, size = ButtonSize.Small)
                    }
                }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }

    pending?.let { target ->
        AlertDialog(
            onDismissRequest = { pending = null },
            containerColor = c.bgElevated,
            title = { Text("Unblock ${target.name}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("They'll be able to see your profile and message you again.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ viewModel.unblock(target.uid); pending = null }) { Text("Unblock", style = ZipperTheme.type.labelM, color = c.textBrand) } },
            dismissButton = { TextButton({ pending = null }) { Text("Cancel", style = ZipperTheme.type.labelM, color = c.textSecondary) } },
        )
    }
}
