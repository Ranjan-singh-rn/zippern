package com.zipper.app.ui.screens.party

/*
 * O14 (Owner, 5 Nov 2026) — the party-room music player's pure parts: a song on this phone, the play order, and the
 * words the player shows. No Android classes here, so all of it runs in the JVM tests (PartyMusicLogicTest).
 *
 *   "party music is not to add licensed tracks, but to access from your device if some audios are there grab them to
 *    play, like a music player."
 *
 * The audio itself never leaves the phone as a file: Agora mixes it into what the player's seat publishes, and only
 * the song's title and artist go to the server (`setPartyMusic`, source "device") so the room can show them.
 */

/** A song on this phone — from MediaStore, or a file chosen with the system picker. */
data class DeviceTrack(
    /** Stable for the session: "ms:<MediaStore id>" or "pick:<uri>". */
    val key: String,
    /** What Agora is handed: the content:// URI (or, after the cache fallback, a file path — see the view model). */
    val uri: String,
    val title: String,
    val artist: String,
    /** 0 when the file does not say. */
    val durationMs: Long,
)

enum class MusicRepeat { Off, All, One }

/** May the app read the phone's music? Unknown until the sheet has asked (or checked). */
enum class MusicAccess { Unknown, Granted, Denied }

/**
 * The play order over a list of [order].size songs: the list's own order, or a shuffle of it that starts with the song
 * the person tapped. [pos] is the place in [order]; [current] the song's index in the list.
 */
data class MusicQueue(val order: List<Int>, val pos: Int) {
    init { require(order.isNotEmpty() && pos in order.indices) { "empty queue or position out of range" } }

    val current: Int get() = order[pos]

    /** "Next" tapped: always moves on, wrapping from the last song to the first. */
    fun skip(): MusicQueue = copy(pos = (pos + 1) % order.size)

    /** "Previous" tapped: one back, wrapping from the first song to the last. */
    fun back(): MusicQueue = copy(pos = if (pos == 0) order.size - 1 else pos - 1)

    /** A song played to its end: what plays next, or null to stop. */
    fun afterFinished(repeat: MusicRepeat): MusicQueue? = when (repeat) {
        MusicRepeat.One -> this
        MusicRepeat.All -> skip()
        MusicRepeat.Off -> if (pos + 1 < order.size) copy(pos = pos + 1) else null
    }

    /** Shuffle switched on or off while playing: the current song stays current, the rest re-ordered. */
    fun reshuffled(shuffle: Boolean, random: kotlin.random.Random = kotlin.random.Random.Default): MusicQueue =
        of(order.size, current, shuffle, random)

    companion object {
        /** A queue over [size] songs starting at list index [startAt]; shuffled (start first) when [shuffle]. */
        fun of(size: Int, startAt: Int, shuffle: Boolean, random: kotlin.random.Random = kotlin.random.Random.Default): MusicQueue {
            require(size > 0 && startAt in 0 until size) { "no songs, or start out of range" }
            if (!shuffle) return MusicQueue((0 until size).toList(), startAt)
            val rest = (0 until size).filter { it != startAt }.shuffled(random)
            return MusicQueue(listOf(startAt) + rest, 0)
        }
    }
}

/** What the music sheet holds (the view model's `music` flow). */
data class DeviceMusicState(
    val access: MusicAccess = MusicAccess.Unknown,
    val loading: Boolean = false,
    /** The library has been read at least once (an empty one says "no songs found", not "loading"). */
    val loaded: Boolean = false,
    val library: List<DeviceTrack> = emptyList(),
    /** Files chosen with the system picker this session — listed first. */
    val picked: List<DeviceTrack> = emptyList(),
    val query: String = "",
    /** The list the queue indexes into — what was on screen when the person pressed play. */
    val queueTracks: List<DeviceTrack> = emptyList(),
    val queue: MusicQueue? = null,
    /** Agora says it is playing (not paused, not between songs). */
    val playing: Boolean = false,
    /** A start (server name + Agora) in flight. */
    val busy: Boolean = false,
    val repeat: MusicRepeat = MusicRepeat.Off,
    val shuffle: Boolean = false,
    /** 0–100: the music against the voices, for everyone in the room. */
    val volume: Int = DeviceMusic.DEFAULT_VOLUME,
    /** The current song's length — the file's, or Agora's once it is playing. */
    val durationMs: Long = 0L,
) {
    val current: DeviceTrack? get() = queue?.let { q -> queueTracks.getOrNull(q.current) }
    val all: List<DeviceTrack> get() = DeviceMusic.merge(picked, library)
    val visible: List<DeviceTrack> get() = DeviceMusic.filter(all, query)
}

object DeviceMusic {
    /** The room shows at most this much of a name (the server caps the same: functions/src/party.ts). */
    const val TITLE_MAX = 80
    const val ARTIST_MAX = 60
    /** Shorter than this is a ringtone, an alarm or a notification sound, not a song. */
    const val MIN_SONG_MS = 30_000L
    /** Enough for any phone's music folder; a bigger library is cut, not paged. */
    const val MAX_SONGS = 2_000
    const val DEFAULT_VOLUME = 60
    /** "Previous" more than this far into a song starts it again instead of going back. */
    const val RESTART_AFTER_MS = 3_000L
    /** MediaStore's word for a missing tag. */
    const val UNKNOWN_TAG = "<unknown>"

    private val INVISIBLE = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]")
    private val SPACES = Regex("\\s+")

    /** One line, no control or invisible characters, at most [max] characters. */
    fun line(raw: String?, max: Int): String =
        (raw ?: "").replace(INVISIBLE, " ").replace(SPACES, " ").trim().take(max).trim()

    /** A file name as a title: no folder, no extension, underscores and dashes read as spaces. */
    fun fileTitle(fileName: String?): String {
        val base = (fileName ?: "").substringAfterLast('/').let { n -> if (n.contains('.')) n.substringBeforeLast('.') else n }
        return line(base.replace('_', ' '), TITLE_MAX)
    }

    /** The song's title: its tag, else its file name, else "Music". */
    fun titleOf(tag: String?, fileName: String?): String {
        val t = line(tag, TITLE_MAX)
        if (t.isNotEmpty() && !t.equals(UNKNOWN_TAG, ignoreCase = true)) return t
        return fileTitle(fileName).ifEmpty { "Music" }
    }

    /** The artist, or "" when MediaStore says it does not know. */
    fun artistOf(tag: String?): String {
        val a = line(tag, ARTIST_MAX)
        return if (a.equals(UNKNOWN_TAG, ignoreCase = true)) "" else a
    }

    /** Is this a song (and not a ringtone)? A length of 0 means "unknown" and is kept. */
    fun isSong(durationMs: Long): Boolean = durationMs <= 0L || durationMs >= MIN_SONG_MS

    /** Picked files first, then the library, each song once (by key). */
    fun merge(picked: List<DeviceTrack>, library: List<DeviceTrack>): List<DeviceTrack> {
        val seen = HashSet<String>()
        return (picked + library).filter { seen.add(it.key) }
    }

    /** The songs whose title or artist contains every word of [query] (case-insensitive). */
    fun filter(tracks: List<DeviceTrack>, query: String): List<DeviceTrack> {
        val words = query.trim().lowercase().split(SPACES).filter { it.isNotEmpty() }
        if (words.isEmpty()) return tracks
        return tracks.filter { t ->
            val hay = "${t.title} ${t.artist}".lowercase()
            words.all { hay.contains(it) }
        }
    }

    /** 3:07, 12:40, 1:02:03; "--:--" when unknown. */
    fun clock(ms: Long): String {
        if (ms <= 0L) return if (ms == 0L) "0:00" else "--:--"
        val total = ms / 1000
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        // Locale.ROOT: digits stay 0–9 whatever the phone's language.
        return if (h > 0) String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, s)
        else String.format(java.util.Locale.ROOT, "%d:%02d", m, s)
    }

    /** "Title — Artist", or the title alone. */
    fun label(title: String, artist: String): String = if (artist.isBlank()) title else "$title — $artist"

    /** What everyone in the room reads in the header: "♫ Title — Artist", "(paused)" when paused. */
    fun nowPlayingLine(title: String, artist: String, playing: Boolean): String =
        "♫ ${label(title, artist)}${if (playing) "" else " (paused)"}"

    /** Song length to send: whole milliseconds, 0 for unknown or nonsense (the server caps the same way). */
    fun durationToSend(ms: Long): Long = if (ms in 1..MAX_DURATION_MS) ms else 0L
    const val MAX_DURATION_MS = 6L * 60 * 60 * 1000

    /** The extension to give a cached copy, from the file name or the MIME subtype; "mp3" when neither says. */
    fun cacheExtension(fileName: String?, mimeSubtype: String?): String {
        val fromName = (fileName ?: "").substringAfterLast('.', "").lowercase()
        if (fromName.matches(Regex("[a-z0-9]{2,5}"))) return fromName
        val sub = (mimeSubtype ?: "").lowercase()
        return when {
            sub == "mpeg" || sub == "mp3" -> "mp3"
            sub == "mp4" || sub == "aac" || sub == "x-m4a" || sub == "m4a" -> "m4a"
            sub == "ogg" -> "ogg"
            sub == "flac" || sub == "x-flac" -> "flac"
            sub == "wav" || sub == "x-wav" -> "wav"
            else -> "mp3"
        }
    }

    // ── Agora's audio-mixing codes (RtcEngine 4.x, IRtcEngineEventHandler.onAudioMixingStateChanged) ──
    const val STATE_PLAYING = 710
    const val STATE_PAUSED = 711
    const val STATE_STOPPED = 713
    const val STATE_FAILED = 714
    const val REASON_CAN_NOT_OPEN = 701
    const val REASON_INTERRUPTED_EOF = 703
    const val REASON_ALL_LOOPS_COMPLETED = 723
    const val REASON_STOPPED_BY_USER = 724

    /** What the player does with an Agora mixing report. Pure, so the view model's choices are tested. */
    enum class MixEvent { Playing, Paused, Finished, CannotOpen, Failed, Ignore }

    fun mixEventOf(state: Int, reason: Int): MixEvent = when (state) {
        STATE_PLAYING -> MixEvent.Playing
        STATE_PAUSED -> MixEvent.Paused
        STATE_STOPPED -> when (reason) {
            REASON_ALL_LOOPS_COMPLETED, REASON_INTERRUPTED_EOF -> MixEvent.Finished
            else -> MixEvent.Ignore   // our own stop, or a stop we caused by switching songs
        }
        STATE_FAILED -> if (reason == REASON_CAN_NOT_OPEN) MixEvent.CannotOpen else MixEvent.Failed
        else -> MixEvent.Ignore
    }
}
