package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * QA #32 — partner application photos are compressed before upload, and a
 * file that still cannot fit is refused with its size instead of Storage's
 * "does not have permission". QA #13 — transparent images are flattened onto
 * white, not black.
 */
class UploadLimitsTest {

    private val mb = 1024L * 1024L

    @Test fun `over the limit is refused with the size and the limit`() {
        assertEquals(
            "This file is 12.4 MB. The limit is 10 MB — choose a smaller file, or take a photo of the document instead.",
            UploadLimits.documentTooLarge((12.4 * mb).toLong()),
        )
    }

    @Test fun `at or under the limit, or of unknown size, is not`() {
        assertNull(UploadLimits.documentTooLarge(10 * mb))
        assertNull(UploadLimits.documentTooLarge(3 * mb))
        assertNull(UploadLimits.documentTooLarge(null))
    }

    @Test fun `the limit is the Storage rules' limit`() {
        assertEquals(10, UploadLimits.DOCUMENT_MAX_MB)
        val rules = listOf(File("../../storage.rules"), File("../storage.rules"), File("storage.rules")).firstOrNull { it.exists() }
            ?: return   // the app checked out on its own: nothing to compare with
        val text = rules.readText()
        for (path in listOf("/kyc/agencies/signup/{fileName}", "/sellerDocs/signup/{fileName}",
                            "/kyc/applicants/{uid}/{fileName}", "/rechargeProofs/{buyerUid}/{fileName}")) {
            val at = text.indexOf("match $path")
            assertTrue(path, at > 0 && text.substring(at, minOf(text.length, at + 400)).contains("maxSize(${UploadLimits.DOCUMENT_MAX_MB})"))
        }
    }

    @Test fun `the repository compresses photos, checks sizes, and words a refusal`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        fun src(p: String) = File(main, "com/zipper/app/$p").readText()
        val repo = src("data/repository/PartnerRepository.kt")
        assertTrue(repo.contains("MediaUtils.compressDocumentImage(context, uri)"))
        assertTrue(repo.contains("ref.putBytes(photo, metadata).await()"))
        assertTrue(repo.contains("UploadLimits.documentTooLarge(size)?.let { return Upload.Failed(it) }"))
        assertTrue(repo.contains("StorageException.ERROR_NOT_AUTHORIZED) UploadLimits.DOCUMENT_REFUSED"))

        val media = src("util/MediaUtils.kt")
        // QA #13: transparent areas are drawn over white before JPEG encoding.
        assertTrue(media.contains("val flat = if (upright.hasAlpha()) onWhite(upright) else upright"))
        assertTrue(media.contains("inPreferredConfig = if (mayHaveAlpha) Bitmap.Config.ARGB_8888"))
        // Profile photos keep their own settings.
        assertTrue(media.contains("compress(context, uri, MAX_IMAGE_PX, IMAGE_QUALITY)"))
    }
}
