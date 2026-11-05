package com.zipper.app.ui.screens.party

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** O14 (5 Nov 2026): the party music player's pure parts — play order, names, and Agora's mixing reports. */
class PartyMusicLogicTest {

    private fun track(i: Int, title: String = "Song $i", artist: String = "Artist $i") =
        DeviceTrack(key = "ms:$i", uri = "content://media/external/audio/media/$i", title = title, artist = artist, durationMs = 200_000L)

    // ── The queue ─────────────────────────────────────────────────────────────────────

    @Test fun `in order, next wraps, previous wraps`() {
        val q = MusicQueue.of(3, startAt = 1, shuffle = false)
        assertEquals(1, q.current)
        assertEquals(2, q.skip().current)
        assertEquals(0, q.skip().skip().current)      // wraps to the first
        assertEquals(0, q.back().current)
        assertEquals(2, MusicQueue.of(3, 0, false).back().current)   // wraps to the last
    }

    @Test fun `a song that ends — repeat off stops after the last, all wraps, one repeats`() {
        val last = MusicQueue.of(3, startAt = 2, shuffle = false)
        assertNull(last.afterFinished(MusicRepeat.Off))
        assertEquals(0, last.afterFinished(MusicRepeat.All)!!.current)
        assertEquals(2, last.afterFinished(MusicRepeat.One)!!.current)
        assertEquals(1, MusicQueue.of(3, 0, false).afterFinished(MusicRepeat.Off)!!.current)
    }

    @Test fun `shuffle starts with the tapped song and plays every song once`() {
        val q = MusicQueue.of(10, startAt = 7, shuffle = true, random = Random(42))
        assertEquals(7, q.current)
        assertEquals((0 until 10).toSet(), q.order.toSet())
        assertEquals(10, q.order.size)
        var cur: MusicQueue? = q
        val played = mutableListOf<Int>()
        while (cur != null) { played += cur.current; cur = cur.afterFinished(MusicRepeat.Off) }
        assertEquals(10, played.size)
        assertEquals(10, played.toSet().size)
    }

    @Test fun `shuffle switched while playing keeps the current song`() {
        val q = MusicQueue.of(6, startAt = 0, shuffle = false).skip().skip()   // on song 2
        val s = q.reshuffled(true, Random(1))
        assertEquals(2, s.current)
        val back = s.reshuffled(false)
        assertEquals(2, back.current)
        assertEquals((0 until 6).toList(), back.order)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an empty list has no queue`() { MusicQueue.of(0, 0, false) }

    // ── Names ─────────────────────────────────────────────────────────────────────────

    @Test fun `title from the tag, else the file name, else Music`() {
        assertEquals("Kesariya", DeviceMusic.titleOf("  Kesariya ", "x.mp3"))
        assertEquals("Tum Hi Ho", DeviceMusic.titleOf("<unknown>", "Tum_Hi_Ho.mp3"))
        assertEquals("my song v2", DeviceMusic.titleOf(null, "/storage/emulated/0/Music/my song v2.m4a"))
        assertEquals("Music", DeviceMusic.titleOf("", ""))
        assertEquals("Music", DeviceMusic.titleOf(null, null))
    }

    @Test fun `one line, invisible characters gone, capped like the server`() {
        assertEquals("A B", DeviceMusic.line("A\n​B\t", 80))
        assertEquals(80, DeviceMusic.titleOf("x".repeat(300), null).length)
        assertEquals(60, DeviceMusic.artistOf("y".repeat(300)).length)
        assertEquals(DeviceMusic.TITLE_MAX, 80)
        assertEquals(DeviceMusic.ARTIST_MAX, 60)
    }

    @Test fun `unknown artist is blank`() {
        assertEquals("", DeviceMusic.artistOf("<unknown>"))
        assertEquals("", DeviceMusic.artistOf(null))
        assertEquals("Pritam", DeviceMusic.artistOf(" Pritam "))
    }

    @Test fun `ringtones are not songs, unknown length is kept`() {
        assertFalse(DeviceMusic.isSong(5_000))
        assertTrue(DeviceMusic.isSong(0))
        assertTrue(DeviceMusic.isSong(30_000))
        assertTrue(DeviceMusic.isSong(240_000))
    }

    @Test fun `search matches every word in title or artist`() {
        val list = listOf(track(1, "Tum Hi Ho", "Arijit Singh"), track(2, "Kesariya", "Arijit Singh"), track(3, "Naatu Naatu", "Rahul"))
        assertEquals(listOf("ms:1", "ms:2"), DeviceMusic.filter(list, "arijit").map { it.key })
        assertEquals(listOf("ms:1"), DeviceMusic.filter(list, " tum  ARIJIT ").map { it.key })
        assertEquals(3, DeviceMusic.filter(list, "  ").size)
        assertTrue(DeviceMusic.filter(list, "zzz").isEmpty())
    }

    @Test fun `picked files come first, each song once`() {
        val picked = listOf(track(9), track(1))
        val lib = listOf(track(1), track(2))
        assertEquals(listOf("ms:9", "ms:1", "ms:2"), DeviceMusic.merge(picked, lib).map { it.key })
    }

    @Test fun `clock and labels`() {
        assertEquals("0:00", DeviceMusic.clock(0))
        assertEquals("--:--", DeviceMusic.clock(-1))
        assertEquals("3:07", DeviceMusic.clock(187_400))
        assertEquals("1:02:03", DeviceMusic.clock(3_723_000))
        assertEquals("Tum Hi Ho — Arijit", DeviceMusic.label("Tum Hi Ho", "Arijit"))
        assertEquals("Tum Hi Ho", DeviceMusic.label("Tum Hi Ho", " "))
        assertEquals("♫ A — B", DeviceMusic.nowPlayingLine("A", "B", playing = true))
        assertEquals("♫ A (paused)", DeviceMusic.nowPlayingLine("A", "", playing = false))
    }

    @Test fun `duration to send and the cached copy's extension`() {
        assertEquals(0L, DeviceMusic.durationToSend(-3))
        assertEquals(0L, DeviceMusic.durationToSend(DeviceMusic.MAX_DURATION_MS + 1))
        assertEquals(1000L, DeviceMusic.durationToSend(1000))
        assertEquals("m4a", DeviceMusic.cacheExtension("song.M4A", null))
        assertEquals("mp3", DeviceMusic.cacheExtension(null, "mpeg"))
        assertEquals("flac", DeviceMusic.cacheExtension("noext", "x-flac"))
        assertEquals("mp3", DeviceMusic.cacheExtension("weird.name.with spaces", null))
    }

    // ── Agora's reports ───────────────────────────────────────────────────────────────

    @Test fun `mixing reports map to what the player does`() {
        assertEquals(DeviceMusic.MixEvent.Playing, DeviceMusic.mixEventOf(710, 0))
        assertEquals(DeviceMusic.MixEvent.Paused, DeviceMusic.mixEventOf(711, 0))
        assertEquals(DeviceMusic.MixEvent.Finished, DeviceMusic.mixEventOf(713, 723))
        assertEquals(DeviceMusic.MixEvent.Finished, DeviceMusic.mixEventOf(713, 703))
        assertEquals(DeviceMusic.MixEvent.Ignore, DeviceMusic.mixEventOf(713, 724))   // our own stop
        assertEquals(DeviceMusic.MixEvent.CannotOpen, DeviceMusic.mixEventOf(714, 701))
        assertEquals(DeviceMusic.MixEvent.Failed, DeviceMusic.mixEventOf(714, 702))
        assertEquals(DeviceMusic.MixEvent.Ignore, DeviceMusic.mixEventOf(999, 0))
    }

    @Test fun `state — current, everything, and what the search shows`() {
        val lib = listOf(track(1, "Alpha"), track(2, "Beta"))
        val s = DeviceMusicState(library = lib, picked = listOf(track(3, "Gamma")), query = "a",
            queueTracks = lib, queue = MusicQueue.of(2, 1, false))
        assertEquals("ms:2", s.current?.key)
        assertEquals(listOf("ms:3", "ms:1", "ms:2"), s.all.map { it.key })
        assertEquals(3, s.visible.size)   // every title has an "a"
        assertNull(DeviceMusicState().current)
    }
}
