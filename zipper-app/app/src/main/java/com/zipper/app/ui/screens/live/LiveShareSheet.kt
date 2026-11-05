package com.zipper.app.ui.screens.live

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.zipper.app.data.repository.ChatRepository
import com.zipper.app.ui.theme.ZipperPink
import com.zipper.app.ui.theme.ZipperPurple
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

// ── Model ──────────────────────────────────────────────────────────────────────

data class ShareContact(
    val uid: String,
    val name: String,
    val photoUrl: String,
    val isOnline: Boolean = false,
)

data class LiveShareUiState(
    val contacts: List<ShareContact> = emptyList(),
    val query: String = "",
    val sentUids: Set<String> = emptySet(),
    val isLoading: Boolean = true,
)

// ── ViewModel ──────────────────────────────────────────────────────────────────

@HiltViewModel
class LiveShareViewModel @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val chatRepo: ChatRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LiveShareUiState())
    val state: StateFlow<LiveShareUiState> = _state.asStateFlow()

    init {
        loadContacts()
    }

    private fun loadContacts() {
        val myUid = auth.currentUser?.uid ?: return
        // Load recent chat partners + people I liked/liked me
        viewModelScope.launch {
            callbackFlow {
                // Recent conversations
                val listener = firestore.collection("conversations")
                    .whereArrayContains("participants", myUid)
                    .orderBy("lastMessageAt", Query.Direction.DESCENDING)
                    .limit(50)
                    .addSnapshotListener { snap, _ ->
                        val uids = snap?.documents?.mapNotNull { doc ->
                            val parts = doc.get("participants") as? List<*>
                            parts?.filterIsInstance<String>()?.firstOrNull { it != myUid }
                        } ?: emptyList()
                        trySend(uids)
                    }
                awaitClose { listener.remove() }
            }.collect { uids ->
                /*
                 * A-8 / R-1 (APK 20): `publicProfiles/{uid}`, NOT `users/{uid}`.
                 *
                 * This read fetched up to fifty full user documents of chat
                 * partners — phone, email, date of birth, device id, balances,
                 * ban reason — to draw a name, a photo and a green dot. The
                 * public projection carries exactly those three, and reading it
                 * is what lets the `users/{uid}` get rule be tightened to the
                 * owner and staff.
                 */
                val contacts = uids.mapNotNull { uid ->
                    try {
                        val snap = firestore.collection("publicProfiles").document(uid).get().await()
                        if (!snap.exists()) return@mapNotNull null
                        ShareContact(
                            uid       = uid,
                            name      = snap.getString("name") ?: return@mapNotNull null,
                            photoUrl  = snap.getString("photoUrl") ?: "",
                            isOnline  = snap.getBoolean("isOnline") ?: false,
                        )
                    } catch (_: Exception) { null }
                }.sortedByDescending { it.isOnline }
                _state.update { it.copy(contacts = contacts, isLoading = false) }
            }
        }
    }

    fun onQuery(q: String) { _state.update { it.copy(query = q) } }

    fun sendInvite(contact: ShareContact, roomId: String, hostName: String, kind: String = "live") {
        if (contact.uid in _state.value.sentUids) return
        val myUid  = auth.currentUser?.uid ?: return
        viewModelScope.launch {
            try {
                val meSnap = firestore.collection("users").document(myUid).get().await()
                chatRepo.sendInvite(
                    myUid        = myUid,
                    myName       = meSnap.getString("name") ?: "",
                    myPhotoUrl   = meSnap.getString("photoUrl") ?: "",
                    otherUid     = contact.uid,
                    otherName    = contact.name,
                    otherPhotoUrl = contact.photoUrl,
                    roomId       = roomId,
                    hostName     = hostName,
                    kind         = kind,
                )
                _state.update { it.copy(sentUids = it.sentUids + contact.uid) }
            } catch (_: Exception) {}
        }
    }
}

// ── Sheet UI ───────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveShareSheet(
    roomId: String,
    hostName: String,
    onDismiss: () -> Unit,
    /** "live" or "party" — what the invite card in the chat opens. */
    kind: String = "live",
    viewModel: LiveShareViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val filtered  = state.contacts.filter { c ->
        state.query.isBlank() || c.name.contains(state.query, ignoreCase = true)
    }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest  = onDismiss,
        sheetState        = sheetState,
        containerColor    = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 16.dp),
        ) {
            Text(
                "Invite Friends to Live",
                fontWeight = FontWeight.Bold,
                fontSize   = 18.sp,
                color      = MaterialTheme.colorScheme.onSurface,
                modifier   = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            )

            OutlinedTextField(
                value         = state.query,
                onValueChange = viewModel::onQuery,
                placeholder   = { Text("Search contacts…", fontSize = 14.sp) },
                leadingIcon   = { Icon(Icons.Default.Search, contentDescription = null) },
                shape         = RoundedCornerShape(50),
                modifier      = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                singleLine    = true,
                colors        = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor   = ZipperPurple,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(0.4f),
                ),
            )

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(0.3f))

            if (state.isLoading) {
                Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ZipperPink)
                }
            } else if (filtered.isEmpty()) {
                Box(Modifier.fillMaxWidth().height(100.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (state.query.isBlank()) "No recent contacts" else "No results for \"${state.query}\"",
                        color    = MaterialTheme.colorScheme.onSurface.copy(0.5f),
                        fontSize = 14.sp,
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                    items(filtered, key = { it.uid }) { contact ->
                        ShareContactRow(
                            contact   = contact,
                            sent      = contact.uid in state.sentUids,
                            onInvite  = { viewModel.sendInvite(contact, roomId, hostName, kind) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ShareContactRow(
    contact: ShareContact,
    sent: Boolean,
    onInvite: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            AsyncImage(
                model              = contact.photoUrl,
                contentDescription = contact.name,
                contentScale       = ContentScale.Crop,
                modifier           = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
            )
            // Online dot
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(if (contact.isOnline) Color(0xFF22C55E) else Color(0xFF6B7280))
                    .align(Alignment.BottomEnd),
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            contact.name,
            fontWeight = FontWeight.SemiBold,
            fontSize   = 15.sp,
            color      = MaterialTheme.colorScheme.onSurface,
            modifier   = Modifier.weight(1f),
        )
        if (sent) {
            Text(
                "Sent ✓",
                fontSize   = 13.sp,
                color      = Color(0xFF34D399),
                fontWeight = FontWeight.SemiBold,
            )
        } else {
            Button(
                onClick  = onInvite,
                shape    = RoundedCornerShape(50),
                colors   = ButtonDefaults.buttonColors(containerColor = ZipperPink),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            ) {
                Text("Invite", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

