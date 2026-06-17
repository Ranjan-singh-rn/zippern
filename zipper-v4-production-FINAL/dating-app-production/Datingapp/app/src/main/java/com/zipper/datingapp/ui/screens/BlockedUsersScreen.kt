package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.zipper.datingapp.data.UserProfile
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlockedUsersScreen(
    uiState: DatingUiState,
    onBack: () -> Unit,
    onUnblock: (String) -> Unit
) {
    BackHandler(onBack = onBack)

    val user = uiState.currentUser ?: run { onBack(); return }
    val allProfiles = (uiState.profiles + uiState.filteredProfiles).distinctBy { it.id }
    val blocked = user.blockedUserIds.filter { it.isNotBlank() }.distinct()

    fun displayName(uid: String): String =
        allProfiles.find { it.id == uid }?.name?.takeIf { it.isNotBlank() } ?: uid

    fun photoUrl(uid: String): String =
        allProfiles.find { it.id == uid }?.photoUrl.orEmpty()

    var confirmUnblockId by remember { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Blocked Users", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                        if (blocked.isNotEmpty())
                            Text("${blocked.size} blocked", fontSize = 12.sp, color = TextSecondary)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)
            )
        }
    ) { pad ->
        if (blocked.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Block, null, tint = TextSecondary.copy(.35f), modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No blocked users", color = TextSecondary, fontSize = 15.sp)
                    Text("People you block will appear here", color = TextSecondary.copy(.6f), fontSize = 13.sp)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(pad),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(blocked, key = { it }) { uid ->
                    BlockedUserRow(
                        name = displayName(uid),
                        photoUrl = photoUrl(uid),
                        uid = uid,
                        onUnblock = { confirmUnblockId = uid }
                    )
                }
            }
        }
    }

    // Confirm unblock dialog
    confirmUnblockId?.let { uid ->
        AlertDialog(
            onDismissRequest = { confirmUnblockId = null },
            icon = { Icon(Icons.Default.Lock, null, tint = BrandPink) },
            title = { Text("Unblock ${displayName(uid)}?", fontWeight = FontWeight.Bold) },
            text = { Text("They will be able to see your profile and message you again.") },
            confirmButton = {
                Button(
                    onClick = { onUnblock(uid); confirmUnblockId = null },
                    colors = ButtonDefaults.buttonColors(containerColor = BrandPink)
                ) { Text("Unblock") }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnblockId = null }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun BlockedUserRow(
    name: String,
    photoUrl: String,
    uid: String,
    onUnblock: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(.4f),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.1f))
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Avatar — grayscale tinted to indicate blocked
            Box(
                modifier = Modifier
                    .size(50.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center
            ) {
                if (photoUrl.isNotBlank()) {
                    SubcomposeAsyncImage(
                        model = photoUrl,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize().clip(CircleShape),
                        contentScale = ContentScale.Crop
                    )
                } else {
                    Box(
                        Modifier.fillMaxSize()
                            .background(Brush.linearGradient(listOf(Color(0xFF9E9E9E), Color(0xFF757575)))),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                    }
                }
                // Block icon overlay
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(.35f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.Block, null, tint = Color.White.copy(.8f), modifier = Modifier.size(22.dp))
                }
            }

            Spacer(Modifier.width(14.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(name, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Blocked", color = MaterialTheme.colorScheme.error, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }

            OutlinedButton(
                onClick = onUnblock,
                shape = RoundedCornerShape(10.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, BrandPink),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
            ) {
                Text("Unblock", color = BrandPink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
