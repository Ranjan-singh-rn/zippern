package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.data.*
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.paddingWithNavigationBars
import com.zipper.datingapp.ui.theme.AppResponsiveContentMaxWidth
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.defaultHorizontalContentPadding

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BattleLobbyScreen(
    uiState: DatingUiState,
    onCreateBattle: () -> Unit,
    onEnterBattle: (Battle) -> Unit,
    onBack: () -> Unit
) {
    BackHandler(onBack = onBack)
    val isGirl = uiState.currentUser?.role == UserRole.GIRL.name
    val gameTypeFilters = listOf("All") + GameType.entries.map { it.label }
    var selectedFilter by remember { mutableStateOf("All") }
    val widthClass = LocalWindowWidthClass.current
    val hPad = widthClass.defaultHorizontalContentPadding()

    val filteredBattles = remember(uiState.battles, selectedFilter) {
        if (selectedFilter == "All") uiState.battles
        else uiState.battles.filter { it.gameType.label == selectedFilter }
    }

    // Group by status: LIVE first, then WAITING, then STARTING_SOON, FINISHED last
    val sortedBattles = remember(filteredBattles) {
        filteredBattles.sortedWith(
            compareBy {
                when (it.status) {
                    BattleStatus.LIVE          -> 0
                    BattleStatus.WAITING       -> 1
                    BattleStatus.STARTING_SOON -> 2
                    BattleStatus.FINISHED      -> 3
                    else                       -> 4
                }
            }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = AppResponsiveContentMaxWidth)
                .fillMaxSize()
        ) {
        TopAppBar(
            title = { Text("Game Center", fontWeight = FontWeight.Bold) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            actions = {
                if (isGirl) {
                    Button(
                        onClick = onCreateBattle,
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFF6B9D)),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Host Game")
                    }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = Color.Transparent,
                titleContentColor = MaterialTheme.colorScheme.onBackground,
                navigationIconContentColor = MaterialTheme.colorScheme.onBackground
            )
        )

        // Stats row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = hPad, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Surface(color = Color(0xFFFF6B9D).copy(alpha = 0.12f), shape = RoundedCornerShape(8.dp)) {
                Row(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(8.dp).background(Color.Red, CircleShape))
                    Spacer(Modifier.width(6.dp))
                    Text("${uiState.battles.count { it.status == BattleStatus.LIVE }} Live", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Color.Red)
                }
            }
            Surface(color = Color(0xFF22C55E).copy(alpha = 0.12f), shape = RoundedCornerShape(8.dp)) {
                Row(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Group, contentDescription = null, tint = Color(0xFF22C55E), modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("${uiState.battles.count { it.status == BattleStatus.WAITING }} Open Lobbies", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Color(0xFF22C55E))
                }
            }
        }

        // Game type filter chips
        LazyRow(
            contentPadding = PaddingValues(horizontal = hPad, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(gameTypeFilters) { filterLabel ->
                val isSelected = selectedFilter == filterLabel
                Surface(
                    color = if (isSelected) Color(0xFFFF6B9D) else MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier.clickable { selectedFilter = filterLabel }
                ) {
                    Text(
                        filterLabel,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        fontSize = 12.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        color = if (isSelected) Color.White else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        if (sortedBattles.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.SportsEsports, contentDescription = null, modifier = Modifier.size(64.dp), tint = Color.Gray.copy(alpha = 0.4f))
                    Spacer(Modifier.height(12.dp))
                    Text("No battles right now", color = Color.Gray, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        if (isGirl) "Tap 'Host Game' to create one!" else "Check back soon or try another filter",
                        color = Color.Gray.copy(alpha = 0.7f),
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 280.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = paddingWithNavigationBars(startExtra = hPad, endExtra = hPad, topExtra = 8.dp, bottomExtra = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                items(sortedBattles) { battle ->
                    ImprovedBattleCard(battle = battle, onClick = { onEnterBattle(battle) })
                }
            }
        }
        }
    }
}

@Composable
fun ImprovedBattleCard(battle: Battle, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        color = when (battle.status) {
                            BattleStatus.LIVE -> Color.Red
                            BattleStatus.WAITING -> Color(0xFF22C55E)
                            BattleStatus.STARTING_SOON -> Color(0xFFFBBF24)
                            BattleStatus.FINISHED -> Color.Gray
                            else -> Color.Gray
                        },
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text(
                            text = when (battle.status) {
                                BattleStatus.LIVE -> " LIVE "
                                BattleStatus.WAITING -> " LOBBY "
                                else -> " UPCOMING "
                            },
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            color = Color.White,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.ExtraBold
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Text(
                        text = battle.gameType.label,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                }

                Spacer(Modifier.height(20.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        BattleParticipantAvatarLarge(battle.girl1Name, roleLabel = "Host")
                    }
                    
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                         Text(
                            "VS", 
                            style = MaterialTheme.typography.headlineMedium, 
                            fontWeight = FontWeight.Black,
                            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)
                        )
                    }

                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        BattleParticipantAvatarLarge(
                            battle.girl2Name,
                            roleLabel = if (battle.status == BattleStatus.WAITING && battle.girl2Id.isBlank()) {
                                "Tap to join"
                            } else {
                                "Guest"
                            }
                        )
                    }
                }

                Spacer(Modifier.height(20.dp))
                
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Diamond, contentDescription = null, tint = Color(0xFFFFD700), modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = "${battle.prizePool} Prize Pool", 
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Bold
                    )
                    
                    Spacer(Modifier.weight(1f))
                    
                    Surface(
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.1f),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Icon(Icons.Default.Group, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(4.dp))
                            Text("${battle.viewerCount}", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun BattleParticipantAvatarLarge(name: String, roleLabel: String = "Host") {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            modifier = Modifier.size(64.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.secondaryContainer
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    name.take(1), 
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
        Text(roleLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }
}
