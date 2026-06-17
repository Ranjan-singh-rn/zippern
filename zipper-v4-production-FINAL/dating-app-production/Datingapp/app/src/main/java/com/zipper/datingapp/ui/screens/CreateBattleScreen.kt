package com.zipper.datingapp.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Diamond
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zipper.datingapp.data.*
import com.zipper.datingapp.ui.DatingUiState
import com.zipper.datingapp.ui.theme.AppResponsiveContentMaxWidth
import com.zipper.datingapp.ui.theme.LocalWindowWidthClass
import com.zipper.datingapp.ui.theme.defaultHorizontalContentPadding
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateBattleScreen(
    uiState: DatingUiState,
    onClose: () -> Unit,
    onPublish: (GameType, Int, List<QuizQuestion>?, List<SpinSector>?, List<MysteryBoxContent>?) -> Unit
) {
    BackHandler(onBack = onClose)
    var selectedGameType by remember { mutableStateOf(GameType.QUIZ) }
    var prizePool by remember { mutableStateOf(1000f) }
    var entryFee by remember { mutableStateOf(10f) }
    var duration by remember { mutableStateOf(5f) }

    // Quiz State
    var customQuestion by remember { mutableStateOf("") }
    var option1 by remember { mutableStateOf("") }
    var option2 by remember { mutableStateOf("") }
    var option3 by remember { mutableStateOf("") }
    var option4 by remember { mutableStateOf("") }
    var correctIndex by remember { mutableIntStateOf(0) }

    // Spin State
    val spinSectors = remember { 
        mutableStateListOf(
            SpinSector("Rose", "🌹", 10),
            SpinSector("Diamond", "💎", 50),
            SpinSector("Heart", "❤️", 20),
            SpinSector("Crown", "👑", 100),
            SpinSector("Fire", "🔥", 30),
            SpinSector("Star", "⭐", 40)
        ) 
    }

    // Mystery Box State
    val mysteryBoxes = remember {
        mutableStateListOf(
            MysteryBoxContent(0, MysteryRewardType.DIAMONDS.name, 100),
            MysteryBoxContent(1, MysteryRewardType.BEANS.name, 50),
            MysteryBoxContent(2, MysteryRewardType.DIAMONDS.name, 5000), // 1% item
            MysteryBoxContent(3, MysteryRewardType.BEANS.name, 2000)   // 2% item
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        val widthClass = LocalWindowWidthClass.current
        val hPad = widthClass.defaultHorizontalContentPadding()
        Column(
            modifier = Modifier
                .widthIn(max = AppResponsiveContentMaxWidth)
                .fillMaxSize()
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(horizontal = hPad)
                .verticalScroll(rememberScrollState())
        ) {
            Spacer(Modifier.height(16.dp))
            
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Host Game Battle",
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Black,
                    color = MaterialTheme.colorScheme.onBackground
                )
                IconButton(
                    onClick = onClose, 
                    modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                ) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Spacer(Modifier.height(32.dp))

            // Game Type Selection
            Text(
                text = "Select Game Mode", 
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onBackground
            )
            Spacer(Modifier.height(16.dp))
            
            GameTypeGrid(
                selectedType = selectedGameType,
                onSelect = { selectedGameType = it }
            )

            Spacer(Modifier.height(32.dp))

            // CUSTOMIZATION PANEL
            if (selectedGameType == GameType.QUIZ) {
                QuizCustomizationPanel(
                    customQuestion = customQuestion,
                    onQuestionChange = { customQuestion = it },
                    option1 = option1, onOption1Change = { option1 = it },
                    option2 = option2, onOption2Change = { option2 = it },
                    option3 = option3, onOption3Change = { option3 = it },
                    option4 = option4, onOption4Change = { option4 = it },
                    correctIndex = correctIndex,
                    onCorrectIndexChange = { correctIndex = it }
                )
            } else if (selectedGameType == GameType.SPIN) {
                SpinCustomizationPanel(
                    sectors = spinSectors,
                    onAddSector = { spinSectors.add(SpinSector()) },
                    onRemoveSector = { if (spinSectors.size > 2) spinSectors.removeAt(it) },
                    onSectorUpdate = { index, sector -> spinSectors[index] = sector }
                )
            } else if (selectedGameType == GameType.MYSTERY) {
                MysteryCustomizationPanel(
                    boxes = mysteryBoxes,
                    onBoxUpdate = { index, box -> mysteryBoxes[index] = box }
                )
            }

            // Battle Settings Section
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
                shape = RoundedCornerShape(24.dp)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text(
                        text = "Battle Settings", 
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(24.dp))
                    
                    // Prize Pool
                    SettingSliderM3(
                        label = "Total Prize Pool",
                        value = prizePool,
                        range = 100f..10000f,
                        onValueChange = { prizePool = it },
                        unit = "💎"
                    )
                    
                    Spacer(Modifier.height(24.dp))
                    
                    // Entry Fee
                    SettingSliderM3(
                        label = "Join Entry Fee",
                        value = entryFee,
                        range = 0f..100f,
                        onValueChange = { entryFee = it },
                        unit = "💎"
                    )

                    Spacer(Modifier.height(24.dp))
                    
                    // Duration
                    SettingSliderM3(
                        label = "Battle Duration",
                        value = duration,
                        range = 1f..10f,
                        onValueChange = { duration = it },
                        unit = "min"
                    )
                }
            }

            Spacer(Modifier.height(40.dp))

            // Launch Button
            Button(
                onClick = { 
                    val questions = if (selectedGameType == GameType.QUIZ && customQuestion.isNotBlank() && option1.isNotBlank() && option2.isNotBlank()) {
                        val opts = listOf(option1, option2, option3, option4).filter { it.isNotBlank() }
                        listOf(QuizQuestion(customQuestion, opts, correctIndex.coerceAtMost(opts.size - 1)))
                    } else null
                    
                    val sectors = if (selectedGameType == GameType.SPIN) spinSectors.toList() else null
                    val boxes = if (selectedGameType == GameType.MYSTERY) mysteryBoxes.toList() else null
                    
                    onPublish(selectedGameType, prizePool.toInt(), questions, sectors, boxes)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(64.dp),
                shape = RoundedCornerShape(20.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFFFF6B9D),
                    contentColor = Color.White
                ),
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp)
            ) {
                Text(
                    text = "Launch Battle & Go Live", 
                    style = TextStyle(fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                )
            }
            
            Spacer(Modifier.height(16.dp))
            Text(
                text = "You will be matched with a random opponent automatically.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.5f),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center
            )
            
            Spacer(Modifier.height(48.dp))
        }
    }
}

@Composable
fun MysteryCustomizationPanel(
    boxes: List<MysteryBoxContent>,
    onBoxUpdate: (Int, MysteryBoxContent) -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
        shape = RoundedCornerShape(24.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f))
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Settings, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Customise 4 Mystery Boxes", 
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
            Text(
                text = "Set surprises for boys. Max 5000 💎 or 2000 🫘. Boys get 50%.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f)
            )
            
            Spacer(Modifier.height(20.dp))

            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                boxes.forEachIndexed { index, box ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color.White.copy(alpha = 0.05f), RoundedCornerShape(12.dp))
                            .padding(12.dp)
                    ) {
                        Text("Box #${index + 1}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            // Reward Type Selection
                            Row(modifier = Modifier.weight(1.5f)) {
                                FilterChip(
                                    selected = box.rewardType == MysteryRewardType.DIAMONDS,
                                    onClick = { onBoxUpdate(index, box.copy(rewardTypeStr = MysteryRewardType.DIAMONDS.name)) },
                                    label = { Text("💎", fontSize = 10.sp) },
                                    modifier = Modifier.padding(end = 4.dp)
                                )
                                FilterChip(
                                    selected = box.rewardType == MysteryRewardType.BEANS,
                                    onClick = { onBoxUpdate(index, box.copy(rewardTypeStr = MysteryRewardType.BEANS.name)) },
                                    label = { Text("🫘", fontSize = 10.sp) }
                                )
                            }
                            
                            // Amount Input
                            OutlinedTextField(
                                value = if (box.amount == 0) "" else box.amount.toString(),
                                onValueChange = { 
                                    val valInt = it.toIntOrNull() ?: 0
                                    val maxVal = if (box.rewardType == MysteryRewardType.DIAMONDS) 5000 else 2000
                                    onBoxUpdate(index, box.copy(amount = valInt.coerceAtMost(maxVal)))
                                },
                                label = { Text("Amount") },
                                modifier = Modifier.weight(1f),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                singleLine = true
                            )
                        }
                    }
                }
            }
        }
    }
    Spacer(Modifier.height(32.dp))
}

@Composable
fun SpinCustomizationPanel(
    sectors: List<SpinSector>,
    onAddSector: () -> Unit,
    onRemoveSector: (Int) -> Unit,
    onSectorUpdate: (Int, SpinSector) -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
        shape = RoundedCornerShape(24.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f))
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Settings, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Customise Spin Wheel", 
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
            Text(
                text = "Add up to 8 prize sectors for users to win.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f)
            )
            
            Spacer(Modifier.height(20.dp))

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                sectors.forEachIndexed { index, sector ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = sector.emoji,
                            onValueChange = { onSectorUpdate(index, sector.copy(emoji = it)) },
                            label = { Text("Emoji") },
                            modifier = Modifier.width(70.dp),
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = sector.name,
                            onValueChange = { onSectorUpdate(index, sector.copy(name = it)) },
                            label = { Text("Name") },
                            modifier = Modifier.weight(1f),
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = if (sector.value == 0) "" else sector.value.toString(),
                            onValueChange = { onSectorUpdate(index, sector.copy(value = it.toIntOrNull() ?: 0)) },
                            label = { Text("Points") },
                            modifier = Modifier.width(80.dp),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true
                        )
                        IconButton(onClick = { onRemoveSector(index) }) {
                            Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }

            if (sectors.size < 8) {
                TextButton(onClick = onAddSector, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Icon(Icons.Default.Add, contentDescription = null)
                    Text("Add New Sector")
                }
            }
        }
    }
    Spacer(Modifier.height(32.dp))
}

@Composable
fun QuizCustomizationPanel(
    customQuestion: String,
    onQuestionChange: (String) -> Unit,
    option1: String, onOption1Change: (String) -> Unit,
    option2: String, onOption2Change: (String) -> Unit,
    option3: String, onOption3Change: (String) -> Unit,
    option4: String, onOption4Change: (String) -> Unit,
    correctIndex: Int,
    onCorrectIndexChange: (Int) -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
        shape = RoundedCornerShape(24.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.2f))
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Settings, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Customise Game Content", 
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
            Text(
                text = "Leave blank to use AI-generated content automatically.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f)
            )
            
            Spacer(Modifier.height(20.dp))

            OutlinedTextField(
                value = customQuestion,
                onValueChange = onQuestionChange,
                label = { Text("Game Question / Task Title") },
                modifier = Modifier.fillMaxWidth(),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
                )
            )

            Spacer(Modifier.height(12.dp))

            Text("Options (At least 2 required)", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(8.dp))

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                CustomOptionField(option1, "Option 1", isSelected = correctIndex == 0) { 
                    onOption1Change(it) 
                    onCorrectIndexChange(0)
                }
                CustomOptionField(option2, "Option 2", isSelected = correctIndex == 1) { 
                    onOption2Change(it) 
                    onCorrectIndexChange(1)
                }
                CustomOptionField(option3, "Option 3", isSelected = correctIndex == 2) { 
                    onOption3Change(it) 
                    onCorrectIndexChange(2)
                }
                CustomOptionField(option4, "Option 4", isSelected = correctIndex == 3) { 
                    onOption4Change(it) 
                    onCorrectIndexChange(3)
                }
            }
            
            Spacer(Modifier.height(12.dp))
            Text(
                "Tap the selector icon to mark the correct answer.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
    Spacer(Modifier.height(32.dp))
}

@Composable
fun CustomOptionField(value: String, placeholder: String, isSelected: Boolean, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, fontSize = 12.sp) },
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        leadingIcon = {
            RadioButton(selected = isSelected, onClick = { onValueChange(value) })
        },
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f),
            unfocusedBorderColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f),
            focusedContainerColor = if (isSelected) MaterialTheme.colorScheme.primary.copy(alpha = 0.05f) else Color.Transparent
        ),
        singleLine = true
    )
}

@Composable
fun GameTypeGrid(selectedType: GameType, onSelect: (GameType) -> Unit) {
    val items = GameType.entries.toTypedArray()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (i in items.indices step 2) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                GameTypeCard(
                    type = items[i],
                    isSelected = items[i] == selectedType,
                    onClick = { onSelect(items[i]) },
                    modifier = Modifier.weight(1f)
                )
                if (i + 1 < items.size) {
                    GameTypeCard(
                        type = items[i + 1],
                        isSelected = items[i + 1] == selectedType,
                        onClick = { onSelect(items[i + 1]) },
                        modifier = Modifier.weight(1f)
                    )
                } else {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
fun GameTypeCard(type: GameType, isSelected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        color = if (isSelected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        shape = RoundedCornerShape(16.dp),
        border = androidx.compose.foundation.BorderStroke(
            width = if (isSelected) 2.dp else 0.dp, 
            color = if (isSelected) MaterialTheme.colorScheme.primary else Color.Transparent
        ),
        modifier = modifier.height(72.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = type.icon, style = TextStyle(fontSize = 28.sp))
            Spacer(Modifier.width(12.dp))
            Text(
                text = type.label,
                color = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                maxLines = 1
            )
        }
    }
}

@Composable
fun SettingSliderM3(label: String, value: Float, range: ClosedFloatingPointRange<Float>, onValueChange: (Float) -> Unit, unit: String) {
    Column {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label, 
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = String.format(Locale.getDefault(), "%,.0f", value), 
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Black,
                    color = if (unit == "💎") Color(0xFFFFD700) else Color(0xFFFF6B9D)
                )
                Spacer(Modifier.width(4.dp))
                if (unit == "💎") {
                    Icon(Icons.Default.Diamond, contentDescription = null, tint = Color(0xFFFFD700), modifier = Modifier.size(16.dp))
                } else {
                    Text(text = unit, style = MaterialTheme.typography.labelMedium.copy(color = Color(0xFFFF6B9D), fontWeight = FontWeight.Bold))
                }
            }
        }
        
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = range,
            colors = SliderDefaults.colors(
                thumbColor = Color(0xFFFF6B9D),
                activeTrackColor = Color(0xFFFF6B9D),
                inactiveTrackColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.1f),
                activeTickColor = Color.Transparent,
                inactiveTickColor = Color.Transparent
            ),
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}
