package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / A-5 — a downloaded APK is handed to the installer only when it is
 * THIS app, NEWER, and signed by the SAME key as the running build. The
 * hash check in ApkInstaller proves the bytes were published; this proves
 * what was published is an update.
 */
class ApkVerificationTest {

    private val signer = "a".repeat(64)
    private val running = ApkVerification.Running("com.zipper.app", 20L, listOf(signer))

    private fun candidate(
        pkg: String? = "com.zipper.app",
        version: Long? = 21L,
        signers: List<String> = listOf(signer),
    ) = ApkVerification.Candidate(pkg, version, signers)

    @Test fun `same package, newer version, same signer is accepted`() {
        assertEquals(ApkVerification.Verdict.Ok, ApkVerification.decide(candidate(), running))
    }

    @Test fun `an unreadable archive is refused`() {
        val v = ApkVerification.decide(null, running)
        assertTrue(v is ApkVerification.Verdict.Refused)
        assertTrue((v as ApkVerification.Verdict.Refused).reason.contains("not a readable Android package"))
    }

    @Test fun `another package is refused and named`() {
        val v = ApkVerification.decide(candidate(pkg = "com.example.other"), running) as ApkVerification.Verdict.Refused
        assertTrue(v.reason.contains("com.example.other"))
        assertTrue(ApkVerification.decide(candidate(pkg = ""), running) is ApkVerification.Verdict.Refused)
        assertTrue(ApkVerification.decide(candidate(pkg = null), running) is ApkVerification.Verdict.Refused)
    }

    @Test fun `the same or an older versionCode is refused`() {
        val same = ApkVerification.decide(candidate(version = 20L), running) as ApkVerification.Verdict.Refused
        assertTrue(same.reason.contains("not newer"))
        assertTrue(ApkVerification.decide(candidate(version = 19L), running) is ApkVerification.Verdict.Refused)
        assertTrue(ApkVerification.decide(candidate(version = null), running) is ApkVerification.Verdict.Refused)
    }

    @Test fun `a different signer is refused before Android gets to refuse it`() {
        val v = ApkVerification.decide(candidate(signers = listOf("b".repeat(64))), running) as ApkVerification.Verdict.Refused
        assertTrue(v.reason.contains("different key"))
        assertTrue(ApkVerification.decide(candidate(signers = emptyList()), running) is ApkVerification.Verdict.Refused)
        // An unreadable running signer set refuses too: no comparison, no install.
        val blindRunning = running.copy(signerSha256 = emptyList())
        assertTrue(ApkVerification.decide(candidate(), blindRunning) is ApkVerification.Verdict.Refused)
    }

    @Test fun `signer comparison ignores case, whitespace, order and duplicates`() {
        val c = candidate(signers = listOf(" " + signer.uppercase() + " ", signer))
        assertEquals(ApkVerification.Verdict.Ok, ApkVerification.decide(c, running))
        val two = ApkVerification.Running("com.zipper.app", 20L, listOf("b".repeat(64), signer))
        assertEquals(ApkVerification.Verdict.Ok, ApkVerification.decide(candidate(signers = listOf(signer, "B".repeat(64))), two))
        // A subset is not the same set.
        assertTrue(ApkVerification.decide(candidate(signers = listOf(signer)), two) is ApkVerification.Verdict.Refused)
    }

    @Test fun `sha256Hex is lowercase hex of the bytes`() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ApkVerification.sha256Hex(ByteArray(0)),
        )
    }

    @Test fun `the installer verifies before ACTION_VIEW, sweeps stale files, and the dialog can cancel`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val installer = File(main, "com/zipper/app/util/ApkInstaller.kt").readText()
        val install = installer.substring(installer.indexOf("fun install(file: File): String?"))
        assertTrue(install.indexOf("verify(file)") < install.indexOf("Intent(Intent.ACTION_VIEW)"))
        assertTrue(installer.contains("fun cleanupStaleFiles()"))
        val vm = File(main, "com/zipper/app/ui/screens/update/UpdateViewModel.kt").readText()
        val retry = vm.substring(vm.indexOf("fun retry()"))
        assertTrue("Try again re-reads the document", retry.contains("updateRepository.check()"))
        assertTrue(vm.contains("apkInstaller.cleanupStaleFiles()"))
        val dialog = File(main, "com/zipper/app/ui/screens/update/UpdateDialog.kt").readText()
        assertTrue(dialog.contains("TextButton(dismiss) { Text(\"Cancel\""))
        val repo = File(main, "com/zipper/app/data/repository/UpdateRepository.kt").readText()
        assertTrue("the channel comes from OTA_CHANNEL, not DEBUG", repo.contains("channelFor(BuildConfig.OTA_CHANNEL)"))
        assertTrue(!repo.contains("if (BuildConfig.DEBUG) CHANNEL_DEBUG"))
    }
}
