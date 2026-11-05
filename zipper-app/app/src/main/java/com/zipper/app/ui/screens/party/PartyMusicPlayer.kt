package com.zipper.app.ui.screens.party

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.repository.PartyRepository
import com.zipper.app.ui.components.ButtonSize
import com.zipper.app.ui.components.ButtonStyle
import com.zipper.app.ui.components.ZipperButton
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Size
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File

/*
 * O14 (Owner, 5 Nov 2026) — the party room's music player.
 *
 *   "party music is not to add licensed tracks, but to access from your device if some audios are there grab them to
 *    play, like a music player."
 *
 * The owner or an admin, on a seat, opens Music and sees the songs on their phone (MediaStore; READ_MEDIA_AUDIO on
 * Android 13+, READ_EXTERNAL_STORAGE below — asked here, with the reason), or chooses a file with the system picker
 * (no permission at all). Play, pause, next, previous, seek, volume, repeat and shuffle; the song goes into the room
 * through Agora audio mixing and everybody sees "♫ title — artist". The pure parts live in PartyMusicLogic.kt.
 */

/** Reads the phone's songs. Never throws: a phone that will not answer has no songs. */
object DeviceMusicLibrary {
    private const val TAG = "PartyMusic"
    private const val CACHE_DIR = "party-music"

    /** The permission that lets the app read the phone's audio files. */
    fun permission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO
        else Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, permission()) == PackageManager.PERMISSION_GRANTED

    /** The phone's songs (MediaStore audio marked as music, ringtones left out), by title, at most MAX_SONGS. */
    suspend fun load(context: Context): List<DeviceTrack> = withContext(Dispatchers.IO) {
        val out = ArrayList<DeviceTrack>()
        val collection: Uri =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DISPLAY_NAME,
        )
        try {
            context.contentResolver.query(
                collection, projection, "${MediaStore.Audio.Media.IS_MUSIC} != 0", null,
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
            )?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val titleCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val artistCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                val durationCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                while (c.moveToNext() && out.size < DeviceMusic.MAX_SONGS) {
                    val duration = if (c.isNull(durationCol)) 0L else c.getLong(durationCol)
                    if (!DeviceMusic.isSong(duration)) continue
                    val id = c.getLong(idCol)
                    out += DeviceTrack(
                        key = "ms:$id",
                        uri = ContentUris.withAppendedId(collection, id).toString(),
                        title = DeviceMusic.titleOf(c.getString(titleCol), c.getString(nameCol)),
                        artist = DeviceMusic.artistOf(c.getString(artistCol)),
                        durationMs = duration.coerceAtLeast(0L),
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not read the phone's music", e)
        }
        out
    }

    /** A file chosen with the system picker: its name and length (from its tags, else its file name). */
    suspend fun fromPicked(context: Context, uri: Uri): DeviceTrack? = withContext(Dispatchers.IO) {
        // Keep the read grant for as long as the room is open (and beyond, harmlessly).
        try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
        }
        val name = displayName(context, uri)
        var title: String? = null
        var artist: String? = null
        var duration = 0L
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(context, uri)
            title = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
            artist = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
            duration = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } catch (e: Exception) {
            // Not an audio file the phone can read: refused below if it has no name either.
            Log.w(TAG, "could not read the picked file's tags", e)
            if (name == null) return@withContext null
        } finally {
            try { mmr.release() } catch (_: Exception) {}
        }
        DeviceTrack(
            key = "pick:$uri",
            uri = uri.toString(),
            title = DeviceMusic.titleOf(title, name),
            artist = DeviceMusic.artistOf(artist),
            durationMs = duration.coerceAtLeast(0L),
        )
    }

    /**
     * The fallback when Agora cannot open a content:// URI itself: a copy of [song] in the app's cache (the previous
     * copy is deleted first — one song at a time). Null when the file cannot be read.
     */
    suspend fun copyToCache(context: Context, song: DeviceTrack): File? = withContext(Dispatchers.IO) {
        try {
            val uri = Uri.parse(song.uri)
            val dir = File(context.cacheDir, CACHE_DIR).apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val sub = context.contentResolver.getType(uri)?.substringAfter('/', "")
            val file = File(dir, "now.${DeviceMusic.cacheExtension(displayName(context, uri), sub)}")
            val input = context.contentResolver.openInputStream(uri) ?: return@withContext null
            input.use { inp -> file.outputStream().use { out -> inp.copyTo(out) } }
            file
        } catch (e: Exception) {
            Log.w(TAG, "could not copy the song for playback", e)
            null
        }
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}

/**
 * The Music sheet: what is playing in the room, this phone's player, the phone's songs, and — when the Owner has
 * added any — Zipper's own catalogue. Opened from the room menu by the owner and admins (B7).
 */
@Composable
internal fun PartyMusicPlayerSheet(state: PartyRoomUiState, viewModel: PartyRoomViewModel, onDismiss: () -> Unit) {
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val music by viewModel.music.collectAsStateWithLifecycle()
    val catalogue by remember { viewModel.musicTracksFlow() }.collectAsStateWithLifecycle(emptyList())

    val askAccess = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        viewModel.onMusicAccess(context, granted, asked = true)
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) viewModel.addPickedSong(context, uri)
    }
    LaunchedEffect(Unit) {
        viewModel.onMusicAccess(context, DeviceMusicLibrary.hasPermission(context), asked = false)
    }

    val roomMusic = state.room?.music
    val myUid = state.myUid
    val mineDevice = music.current
    val mineCatalogue = roomMusic != null && !roomMusic.fromDevice && roomMusic.by == myUid
    val seated = state.amSeated
    val micOff = state.mySeat?.isSilent == true

    PartySheetFrame("Music", onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            when {
                mineDevice != null -> DevicePlayerCard(music, mineDevice, viewModel)
                mineCatalogue && roomMusic != null -> CataloguePlayerCard(roomMusic.title, roomMusic.artist, viewModel)
                roomMusic != null -> {
                    val player = state.seats.firstOrNull { it.uid == roomMusic.by }?.name
                        ?: state.listeners.firstOrNull { it.uid == roomMusic.by }?.name
                    Text(
                        "Now playing: ${DeviceMusic.label(roomMusic.title, roomMusic.artist)}${if (roomMusic.playing) "" else " (paused)"}",
                        style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "From ${player?.ifBlank { null } ?: "another moderator"}'s phone. Playing a song here takes over.",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                    )
                    if (state.isOwner) {
                        ZipperButton("Stop the music", { viewModel.stopMusic() }, size = ButtonSize.Small, style = ButtonStyle.Secondary, icon = Icons.Filled.Stop)
                    }
                }
            }
            if (!seated) {
                Text("Take a seat to play music — it goes out with your microphone.", style = ZipperTheme.type.caption, color = c.statusWarning)
            } else if (micOff && (mineDevice != null || mineCatalogue)) {
                Text("Your microphone is off, so the room cannot hear the music.", style = ZipperTheme.type.caption, color = c.statusWarning)
            }
        }

        // ── The phone's songs ──
        when (music.access) {
            MusicAccess.Granted -> DeviceLibrary(music, seated, viewModel, onPick = { pickFile.launch(arrayOf("audio/*")) })
            MusicAccess.Unknown, MusicAccess.Denied -> Column(
                Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
                verticalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Text("Play songs from your phone", style = ZipperTheme.type.labelM, color = c.textPrimary)
                Text(
                    if (music.access == MusicAccess.Denied)
                        "Music access is off. You can still choose a song file, or turn access on in Settings."
                    else
                        "Zipper lists the songs on this phone so you can play them into the room. Only the song's name is shared; the file stays on your phone.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (music.access == MusicAccess.Unknown) {
                        ZipperButton("Allow music access", { askAccess.launch(DeviceMusicLibrary.permission()) },
                            size = ButtonSize.Small, icon = Icons.Filled.LibraryMusic)
                    } else {
                        ZipperButton("Open Settings", {
                            try {
                                context.startActivity(
                                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            } catch (_: Exception) {
                            }
                        }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
                    }
                    ZipperButton("Choose a file", { pickFile.launch(arrayOf("audio/*")) },
                        size = ButtonSize.Small, style = ButtonStyle.Secondary, icon = Icons.Filled.FolderOpen, enabled = seated)
                }
            }
        }

        // ── Zipper's own catalogue, when the Owner has added any ──
        if (catalogue.isNotEmpty()) {
            Text(
                "Zipper music", style = ZipperTheme.type.labelS, color = c.textSecondary,
                modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.xs),
            )
            LazyColumn(Modifier.heightIn(max = 180.dp)) {
                items(catalogue, key = { it.id }) { t ->
                    CatalogueRow(t, enabled = seated) { viewModel.playMusic(t) }
                }
            }
        }
    }
}

@Composable
private fun DevicePlayerCard(music: DeviceMusicState, song: DeviceTrack, viewModel: PartyRoomViewModel) {
    val c = ZipperTheme.colors
    var positionMs by remember(song.key) { mutableLongStateOf(0L) }
    var dragging by remember(song.key) { mutableStateOf(false) }
    var dragValue by remember(song.key) { mutableFloatStateOf(0f) }
    // The seek bar follows Agora twice a second while this sheet is open.
    LaunchedEffect(song.key, music.playing) {
        while (isActive) {
            if (!dragging) positionMs = viewModel.musicPositionMs()
            delay(500)
        }
    }
    val duration = music.durationMs.coerceAtLeast(0L)
    val shape = RoundedCornerShape(Radius.lg)
    Column(
        Modifier.fillMaxWidth().background(c.bgRaised, shape).border(1.dp, c.borderSubtle, shape).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            Box(Modifier.size(40.dp).background(c.tintBrandSubtle, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.MusicNote, null, tint = c.textBrand, modifier = Modifier.size(Size.Icon.md))
            }
            Column(Modifier.weight(1f)) {
                Text(song.title, style = ZipperTheme.type.labelM, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    song.artist.ifBlank { if (music.busy) "Starting…" else "Playing in the room" },
                    style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (duration > 0L) {
            Slider(
                value = if (dragging) dragValue else positionMs.coerceIn(0L, duration).toFloat(),
                onValueChange = { dragging = true; dragValue = it },
                onValueChangeFinished = {
                    viewModel.seekDeviceSong(dragValue.toLong())
                    positionMs = dragValue.toLong()
                    dragging = false
                },
                valueRange = 0f..duration.toFloat(),
                modifier = Modifier.semantics { contentDescription = "Position in the song" },
            )
            Row(Modifier.fillMaxWidth()) {
                Text(DeviceMusic.clock(if (dragging) dragValue.toLong() else positionMs), style = ZipperTheme.type.caption, color = c.textMuted)
                Spacer(Modifier.weight(1f))
                Text(DeviceMusic.clock(duration), style = ZipperTheme.type.caption, color = c.textMuted)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            ToggleIcon(Icons.Filled.Shuffle, "Shuffle", on = music.shuffle) { viewModel.toggleMusicShuffle() }
            IconButton(onClick = { viewModel.previousDeviceSong() }) {
                Icon(Icons.Filled.SkipPrevious, "Previous song", tint = c.textPrimary)
            }
            Box(
                Modifier.size(52.dp).background(c.brandPrimary, CircleShape)
                    .clickableNoRipple { viewModel.toggleDevicePause() }
                    .semantics { contentDescription = if (music.playing) "Pause" else "Play" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (music.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, null, tint = c.textOnBrand, modifier = Modifier.size(Size.Icon.xl))
            }
            IconButton(onClick = { viewModel.nextDeviceSong() }) {
                Icon(Icons.Filled.SkipNext, "Next song", tint = c.textPrimary)
            }
            ToggleIcon(
                if (music.repeat == MusicRepeat.One) Icons.Filled.RepeatOne else Icons.Filled.Repeat,
                when (music.repeat) { MusicRepeat.Off -> "Repeat off"; MusicRepeat.All -> "Repeat all"; MusicRepeat.One -> "Repeat this song" },
                on = music.repeat != MusicRepeat.Off,
            ) { viewModel.cycleMusicRepeat() }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            Icon(Icons.Filled.VolumeUp, null, tint = c.textMuted, modifier = Modifier.size(Size.Icon.md))
            Slider(
                value = music.volume.toFloat(),
                onValueChange = { viewModel.setMusicVolumeLevel(it.toInt()) },
                valueRange = 0f..100f,
                modifier = Modifier.weight(1f).semantics { contentDescription = "Music volume" },
            )
            ZipperButton("Stop", { viewModel.stopMusic() }, size = ButtonSize.Small, style = ButtonStyle.Secondary, icon = Icons.Filled.Stop)
        }
    }
}

@Composable
private fun CataloguePlayerCard(title: String, artist: String, viewModel: PartyRoomViewModel) {
    val c = ZipperTheme.colors
    var paused by remember { mutableStateOf(false) }
    val music by viewModel.music.collectAsStateWithLifecycle()
    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text("Now playing: ${DeviceMusic.label(title, artist)}", style = ZipperTheme.type.labelM, color = c.textPrimary)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            ZipperButton(if (paused) "Resume" else "Pause", { paused = !paused; viewModel.pauseMusic(paused) }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
            ZipperButton("Stop", { viewModel.stopMusic() }, size = ButtonSize.Small, style = ButtonStyle.Secondary)
        }
        Slider(
            value = music.volume.toFloat(), onValueChange = { viewModel.setMusicVolumeLevel(it.toInt()) }, valueRange = 0f..100f,
            modifier = Modifier.semantics { contentDescription = "Music volume" },
        )
    }
}

@Composable
private fun ToggleIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, on: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    IconButton(
        onClick = onClick,
        modifier = Modifier.semantics { stateDescription = if (on) "On" else "Off" },
    ) {
        Icon(icon, label, tint = if (on) c.textBrand else c.textMuted)
    }
}

@Composable
private fun DeviceLibrary(music: DeviceMusicState, seated: Boolean, viewModel: PartyRoomViewModel, onPick: () -> Unit) {
    val c = ZipperTheme.colors
    val visible = music.visible
    val shape = RoundedCornerShape(Radius.md)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Row(
            Modifier.weight(1f).heightIn(min = 40.dp).background(c.bgRaised, shape).border(1.dp, c.borderSubtle, shape)
                .padding(horizontal = Space.md, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Icon(Icons.Filled.Search, null, tint = c.textMuted, modifier = Modifier.size(Size.Icon.sm))
            BasicTextField(
                value = music.query,
                onValueChange = { viewModel.setMusicQuery(it) },
                singleLine = true,
                textStyle = ZipperTheme.type.bodyM.copy(color = c.textPrimary),
                cursorBrush = SolidColor(c.brandPrimary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.weight(1f).semantics { contentDescription = "Search your songs" },
                decorationBox = { inner ->
                    if (music.query.isEmpty()) Text("Search songs or artists", style = ZipperTheme.type.bodyM, color = c.textMuted)
                    inner()
                },
            )
        }
        IconButton(onClick = onPick, enabled = seated) {
            Icon(Icons.Filled.FolderOpen, "Choose a song file", tint = if (seated) c.textPrimary else c.textMuted)
        }
    }
    when {
        music.loading && !music.loaded -> Text(
            "Looking for songs on this phone…", style = ZipperTheme.type.caption, color = c.textMuted,
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
        )
        music.all.isEmpty() -> Text(
            "No songs found on this phone. Choose a file instead (the folder button).",
            style = ZipperTheme.type.caption, color = c.textMuted,
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
        )
        visible.isEmpty() -> Text(
            "No song matches \"${music.query.trim()}\".", style = ZipperTheme.type.caption, color = c.textMuted,
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
        )
        else -> LazyColumn(Modifier.heightIn(max = 320.dp)) {
            items(visible.size, key = { visible[it].key }) { i ->
                val t = visible[i]
                SongRow(t, current = music.current?.key == t.key, playing = music.playing, enabled = seated) {
                    viewModel.playDevice(visible, i)
                }
            }
        }
    }
}

@Composable
private fun SongRow(song: DeviceTrack, current: Boolean, playing: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .then(if (enabled) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.lg, vertical = Space.sm)
            .semantics { stateDescription = if (current) (if (playing) "Playing" else "Paused") else "" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(
            if (current && playing) Icons.Filled.Pause else Icons.Filled.MusicNote, null,
            tint = if (current) c.textBrand else if (enabled) c.textSecondary else c.textMuted,
            modifier = Modifier.size(Size.Icon.md),
        )
        Column(Modifier.weight(1f)) {
            Text(
                song.title, style = ZipperTheme.type.bodyM,
                color = if (current) c.textBrand else if (enabled) c.textPrimary else c.textMuted,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            val sub = listOf(song.artist, if (song.durationMs > 0) DeviceMusic.clock(song.durationMs) else "").filter { it.isNotBlank() }.joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun CatalogueRow(t: PartyRepository.MusicTrack, enabled: Boolean, onClick: () -> Unit) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .then(if (enabled) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(horizontal = Space.lg, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(Icons.Filled.LibraryMusic, null, tint = if (enabled) c.textSecondary else c.textMuted, modifier = Modifier.size(Size.Icon.md))
        Text(
            DeviceMusic.label(t.title, t.artist), style = ZipperTheme.type.bodyM,
            color = if (enabled) c.textPrimary else c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Space.xs))
    }
}
