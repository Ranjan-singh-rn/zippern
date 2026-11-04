package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** QA #14: an uncompressed fallback upload is checked against storage.rules' caps before it is sent. */
class RawUploadLimitTest {
    private val mb = 1024L * 1024

    @Test fun `the caps are the ones storage rules enforce on profileMedia`() {
        assertEquals(15 * mb, STORAGE_IMAGE_MAX_BYTES)
        assertEquals(50 * mb, STORAGE_VIDEO_MAX_BYTES)
        val rules = listOf(File("../storage.rules"), File("../../storage.rules"), File("storage.rules")).firstOrNull { it.exists() }
        if (rules != null) {
            val text = rules.readText()
            assertTrue("storage.rules still says images 15 / videos 50", text.contains("(isImage() && maxSize(15)) || (isVideo() && maxSize(50))"))
        }
    }

    @Test fun `a photo or video that fits goes, one that does not is refused with a reason`() {
        assertNull(rawUploadProblem(14 * mb, isVideo = false))
        assertNull(rawUploadProblem(15 * mb, isVideo = false))
        assertNotNull(rawUploadProblem(15 * mb + 1, isVideo = false))
        assertNull(rawUploadProblem(49 * mb, isVideo = true))
        val v = rawUploadProblem(51 * mb, isVideo = true)
        assertNotNull(v)
        assertTrue(v!!.contains("51 MB") && v.contains("50 MB"))
    }

    @Test fun `an unknown size is left to Storage`() {
        assertNull(rawUploadProblem(-1, isVideo = false))
    }
}
