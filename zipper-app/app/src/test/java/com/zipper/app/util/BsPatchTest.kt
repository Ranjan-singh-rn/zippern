package com.zipper.app.util

import kotlinx.coroutines.runBlocking
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/**
 * Covers the two things about bsdiff that fail silently rather than loudly.
 *
 * 1. [BsPatch.offtin] is SIGN-MAGNITUDE, not two's complement. Every
 *    non-negative value reads identically under both, so a wrong implementation
 *    passes anything built only from positive numbers and then corrupts the
 *    first patch containing a backwards seek.
 * 2. The diff is added to the old bytes MODULO 256. Get the wraparound wrong and
 *    most bytes still come out right, which is worse than all of them coming out
 *    wrong.
 *
 * Neither produces an exception when it is wrong — it produces an APK with the
 * wrong bytes in it, which is why these are pinned here rather than left to the
 * SHA-256 check in ApkInstaller to catch in production.
 *
 * The patches below are assembled by hand, because generating a real one needs
 * the bsdiff tool. That is not a weakness: it means the control blocks contain
 * exactly the negative seek, the out-of-range read and the two wraparounds that
 * are being tested, rather than whatever a real diff happened to produce.
 *
 * Pure JVM, no Android dependency — `./gradlew testDebugUnitTest` runs it in
 * seconds without an emulator.
 */
class BsPatchTest {

    @get:Rule
    val tmp = TemporaryFolder()

    // ── offtin / offtout ─────────────────────────────────────────────────────

    @Test
    fun `offtin and offtout round-trip across positive, negative and zero`() {
        val values = listOf(
            0L, 1L, -1L,
            127L, 128L, -128L,
            255L, 256L, -256L, -255L,
            4096L, -4096L,
            1L shl 31, -(1L shl 31),
            (1L shl 32) - 1, -((1L shl 32) - 1),
            1L shl 40, -(1L shl 40),
            1L shl 62, -(1L shl 62),
            Long.MAX_VALUE, -Long.MAX_VALUE,
        )
        for (v in values) {
            assertEquals("round-trip of $v", v, BsPatch.offtin(BsPatch.offtout(v)))
        }
    }

    @Test
    fun `offtout writes the sign in bit 63 and the magnitude below it`() {
        // -12 is 0x0c with the top bit of the LAST byte set. A two's-complement
        // encoder would have written ff ff ff ff ff ff ff f4.
        assertArrayEquals(
            byteArrayOf(0x0c, 0, 0, 0, 0, 0, 0, 0x80.toByte()),
            BsPatch.offtout(-12L),
        )
        assertArrayEquals(
            byteArrayOf(0x0c, 0, 0, 0, 0, 0, 0, 0),
            BsPatch.offtout(12L),
        )
    }

    @Test
    fun `offtin is not two's complement`() {
        // THE test. All ones is -1 in two's complement and -(2^63 - 1) here.
        // An implementation that reads a plain little-endian long returns -1 and
        // is wrong by nine quintillion.
        assertEquals(-(Long.MAX_VALUE), BsPatch.offtin(ByteArray(8) { 0xFF.toByte() }))

        // Sign bit set, magnitude zero: "negative zero" is 0, as in bspatch.c.
        assertEquals(0L, BsPatch.offtin(byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0x80.toByte())))

        // A magnitude that uses the low byte only, with the sign flag set.
        assertEquals(-128L, BsPatch.offtin(byteArrayOf(0x80.toByte(), 0, 0, 0, 0, 0, 0, 0x80.toByte())))

        // Bit 62 is part of the number; bit 63 is not.
        assertEquals(1L shl 62, BsPatch.offtin(byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0x40)))
    }

    @Test
    fun `offtin reads at an offset, which is how the header is parsed`() {
        val header = ByteArray(32)
        BsPatch.offtout(1234L, header, 8)
        BsPatch.offtout(-5678L, header, 16)
        BsPatch.offtout(0L, header, 24)
        assertEquals(1234L, BsPatch.offtin(header, 8))
        assertEquals(-5678L, BsPatch.offtin(header, 16))
        assertEquals(0L, BsPatch.offtin(header, 24))
    }

    @Test
    fun `offtout refuses the one magnitude the format cannot hold`() {
        // |Long.MIN_VALUE| is 2^63 and the format gives the magnitude 63 bits.
        // Failing here beats writing bytes that read back as +Long.MIN_VALUE.
        assertThrows(IllegalArgumentException::class.java) { BsPatch.offtout(Long.MIN_VALUE) }
    }

    // ── the bytewise add ─────────────────────────────────────────────────────

    @Test
    fun `adding two bytes and truncating is addition modulo 256`() {
        // This is verbatim the expression BsPatch.addDiff uses. Kotlin widens
        // both operands to Int, and toByte() keeps the low 8 bits — which is
        // exactly mod 256, including the wrap.
        assertEquals(5.toByte(), (0xF9.toByte() + 12.toByte()).toByte())        // 249 + 12 = 261 -> 5
        assertEquals(0.toByte(), (0xFB.toByte() + 5.toByte()).toByte())         // 251 + 5  = 256 -> 0
        assertEquals(0xFF.toByte(), (0xFB.toByte() + 4.toByte()).toByte())      // 251 + 4  = 255
        assertEquals(0xFE.toByte(), (0xFF.toByte() + 0xFF.toByte()).toByte())   // 255 + 255 = 510 -> 254
        assertEquals(10.toByte(), (10.toByte() + 0.toByte()).toByte())
    }

    // ── applying a whole patch ───────────────────────────────────────────────

    @Test
    fun `apply handles a negative seek and two wraparounds`() {
        val old = ByteArray(16) { it.toByte() }   // 0, 1, 2 … 15

        /*
         * Three control triples, chosen to exercise the parts that break:
         *
         *   (4, 2,   8)  diff over old[0..3], 2 extra bytes, oldpos 0 -> 12
         *   (4, 0, -12)  diff over old[12..15], NEGATIVE seek, oldpos 12 -> 4
         *   (2, 1,   0)  diff over old[4..5], 1 extra byte
         *
         * The -12 is the whole point: it only decodes correctly if offtin reads
         * sign-magnitude. Read as two's complement it becomes a vast positive
         * number, oldpos lands past the end of the file, and the last segment
         * silently comes out as the raw diff bytes instead of the sum.
         */
        val control = listOf(
            Triple(4L, 2L, 8L),
            Triple(4L, 0L, -12L),
            Triple(2L, 1L, 0L),
        )
        val diff = byteArrayOf(
            10, 19, 28, 37,                                             // + old[0..3]  = 10, 20, 30, 40
            0xF9.toByte(), 0xF9.toByte(), 0xF9.toByte(), 0xF9.toByte(), // 249 + old[12..15] wraps to 5, 6, 7, 8
            0xFB.toByte(), 0xFB.toByte(),                               // 251 + old[4..5] wraps to 255, 0
        )
        val extra = byteArrayOf(0xAA.toByte(), 0xBB.toByte(), 0x7F)

        val expected = byteArrayOf(
            10, 20, 30, 40,
            0xAA.toByte(), 0xBB.toByte(),
            5, 6, 7, 8,
            0xFF.toByte(), 0x00,
            0x7F,
        )

        assertArrayEquals(expected, applied(old, patch(control, diff, extra)))
    }

    @Test
    fun `bytes past the end of the old file contribute nothing`() {
        // A patch that grows a file legitimately addresses past the end of the
        // old one. bspatch.c skips the add there rather than treating it as an
        // error, and so must this — the diff byte is written unchanged.
        val old = byteArrayOf(1, 2)
        val bytes = patch(
            control = listOf(Triple(4L, 0L, 0L)),
            diff = byteArrayOf(10, 20, 30, 40),
            extra = ByteArray(0),
        )
        assertArrayEquals(byteArrayOf(11, 22, 30, 40), applied(old, bytes))
    }

    @Test
    fun `a negative oldpos is out of range, not an error`() {
        // oldpos goes to -4 and the four diff bytes are read from before the
        // start of the file. Same rule as running past the end.
        val old = ByteArray(16) { it.toByte() }
        val bytes = patch(
            control = listOf(Triple(0L, 1L, -4L), Triple(4L, 0L, 0L)),
            diff = byteArrayOf(7, 7, 7, 7),
            extra = byteArrayOf(0x5A),
        )
        assertArrayEquals(byteArrayOf(0x5A, 7, 7, 7, 7), applied(old, bytes))
    }

    @Test
    fun `apply reports progress that ends at the declared size`() {
        val old = ByteArray(16) { it.toByte() }
        val bytes = patch(listOf(Triple(4L, 2L, 0L)), byteArrayOf(1, 1, 1, 1), byteArrayOf(9, 9))

        val seen = mutableListOf<Pair<Long, Long>>()
        val written = runBlocking {
            BsPatch.apply(file("old", old), file("patch", bytes), tmp.newFile()) { done, total ->
                seen += done to total
            }
        }

        assertEquals(6L, written)
        assertEquals("first report is the start", 0L to 6L, seen.first())
        assertEquals("last report is the finished size", 6L to 6L, seen.last())
    }

    // ── refusing a patch that is not one ─────────────────────────────────────

    @Test
    fun `a patch without the BSDIFF40 magic is refused`() {
        val bytes = patch(listOf(Triple(1L, 0L, 0L)), byteArrayOf(0), ByteArray(0))
        bytes[3] = 'X'.code.toByte()
        assertThrows(IOException::class.java) {
            runBlocking { BsPatch.apply(file("old", byteArrayOf(0)), file("patch", bytes), tmp.newFile()) }
        }
    }

    @Test
    fun `a truncated patch is refused before anything is decompressed`() {
        val bytes = patch(listOf(Triple(4L, 0L, 0L)), byteArrayOf(1, 2, 3, 4), ByteArray(0))
        val short = bytes.copyOf(bytes.size / 2)
        assertThrows(IOException::class.java) {
            runBlocking { BsPatch.apply(file("old", ByteArray(4)), file("patch", short), tmp.newFile()) }
        }
    }

    @Test
    fun `a control block claiming more output than the header allows is refused`() {
        // Header says 4 bytes of output; the control block asks for 8. Without
        // the bound check this would run off the end of the diff stream with a
        // less obvious error, or on a hostile patch write an unbounded file.
        val bytes = patch(listOf(Triple(4L, 0L, 0L)), byteArrayOf(1, 2, 3, 4), ByteArray(0))
        BsPatch.offtout(2L, bytes, 24)   // shrink the declared new size to 2
        assertThrows(IOException::class.java) {
            runBlocking { BsPatch.apply(file("old", ByteArray(8)), file("patch", bytes), tmp.newFile()) }
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun applied(old: ByteArray, patchBytes: ByteArray): ByteArray {
        val out = tmp.newFile()
        runBlocking { BsPatch.apply(file("old", old), file("patch", patchBytes), out) }
        return out.readBytes()
    }

    private fun file(prefix: String, bytes: ByteArray): File =
        tmp.newFile("$prefix-${counter++}.bin").apply { writeBytes(bytes) }

    private var counter = 0

    /**
     * Assemble a BSDIFF40 patch: 32-byte header, then the control, diff and
     * extra blocks, each bzip2-compressed, back to back.
     *
     * Uses [BsPatch.offtout] for the header integers on purpose — an encoder and
     * decoder that agree with each other but not with bsdiff would still be
     * caught, because `offtout writes the sign in bit 63` pins the byte pattern
     * itself against the reference format.
     */
    private fun patch(
        control: List<Triple<Long, Long, Long>>,
        diff: ByteArray,
        extra: ByteArray,
    ): ByteArray {
        val controlBytes = ByteArrayOutputStream().apply {
            for ((x, y, z) in control) {
                write(BsPatch.offtout(x))
                write(BsPatch.offtout(y))
                write(BsPatch.offtout(z))
            }
        }.toByteArray()

        val ctrlBlock = bzip2(controlBytes)
        val diffBlock = bzip2(diff)
        val extraBlock = bzip2(extra)
        val newSize = control.sumOf { it.first + it.second }

        return ByteArrayOutputStream().apply {
            write(BsPatch.MAGIC.toByteArray(Charsets.US_ASCII))
            write(BsPatch.offtout(ctrlBlock.size.toLong()))
            write(BsPatch.offtout(diffBlock.size.toLong()))
            write(BsPatch.offtout(newSize))
            write(ctrlBlock)
            write(diffBlock)
            write(extraBlock)
        }.toByteArray()
    }

    private fun bzip2(data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        BZip2CompressorOutputStream(out).use { it.write(data) }
        return out.toByteArray()
    }
}
