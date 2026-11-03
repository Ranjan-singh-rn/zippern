package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * A1 (3 Nov 2026) — the 17 errors of `:app:lintDebug`, fixed rather than suppressed, and kept fixed.
 *
 *  * MissingTranslation (16): `app_name` is the brand, declared `translatable="false"`; the 15 strings no code
 *    read (checked for `R.string.x` / `@string/x` across code, layouts, xml and the manifest; the app has no
 *    `getIdentifier` lookups) were deleted from every locale. What remains is translated into every locale the
 *    app ships, and no locale carries a string the base does not.
 *  * UnsafeOptInUsageError (1): CameraX's `ImageProxy.getImage()` is opted into on the one function that reads it.
 *
 * Lint itself is the full check (`./gradlew :app:lintDebug`); these run with the unit tests, so a string added
 * without its translations, or an opt-in widened, fails here first.
 */
class LintFixesA1Test {

    private val res = listOf(File("src/main/res"), File("app/src/main/res")).first { it.exists() }
    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }

    /** name → translatable, for one `values*` folder's strings.xml. */
    private fun strings(dir: File): Map<String, Boolean> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(dir, "strings.xml"))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val e = nodes.item(i) as Element
            e.getAttribute("name") to (e.getAttribute("translatable") != "false")
        }
    }

    private val locales: List<File> =
        res.listFiles { f -> f.isDirectory && f.name.startsWith("values-") && File(f, "strings.xml").exists() }
            .orEmpty().sortedBy { it.name }

    @Test fun `the app ships Hindi, Telugu and Tamil`() {
        assertEquals(listOf("values-hi", "values-ta", "values-te"), locales.map { it.name })
    }

    @Test fun `every translatable string is translated in every locale, and no locale carries extras`() {
        val base = strings(File(res, "values"))
        val translatable = base.filterValues { it }.keys
        val fixed = base.filterValues { !it }.keys
        for (locale in locales) {
            val names = strings(locale).keys
            assertEquals("${locale.name}: missing", emptySet<String>(), translatable - names)
            assertEquals("${locale.name}: not in the base", emptySet<String>(), names - base.keys)
            assertEquals("${locale.name}: translates a non-translatable string", emptySet<String>(), names intersect fixed)
        }
    }

    @Test fun `the brand name is one untranslated string`() {
        assertEquals(false, strings(File(res, "values"))["app_name"])
    }

    @Test fun `the 15 strings nothing read are gone from every locale`() {
        val dead = setOf(
            "verify_otp", "resend_otp", "terms_accept", "age_confirm", "set_up_profile", "tell_us_who_you_are",
            "display_name", "what_to_call_you", "gender", "select_dob", "age_error", "your_city", "detecting",
            "lets_go", "error_generic",
        )
        for (dir in listOf(File(res, "values")) + locales) {
            assertEquals(dir.name, emptySet<String>(), strings(dir).keys intersect dead)
        }
    }

    @Test fun `the CameraX opt-in covers the one read of the frame and nothing wider`() {
        val face = File(main, "com/zipper/app/ui/screens/auth/FaceVerificationScreen.kt").readText()
        assertTrue(
            face.contains(
                "@androidx.annotation.OptIn(ExperimentalGetImage::class)\n" +
                    "private fun ImageProxy.mediaImageForMlKit(): android.media.Image? = image"
            )
        )
        assertEquals("one opt-in", 1, Regex("ExperimentalGetImage::class").findAll(face).count())
        assertFalse("no file-wide opt-in", face.contains("@file:OptIn"))
        assertTrue("the analyzer reads the frame through it", face.contains("val mediaImg = proxy.mediaImageForMlKit()"))
        assertFalse("and nowhere directly", Regex("\\bproxy\\.image\\b").containsMatchIn(face))
    }
}
