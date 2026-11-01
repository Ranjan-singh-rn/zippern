package com.zipper.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B44 — the client reads `bannedDevices` the way the server does:
 * `exists && isActive != false`.
 */
class DeviceBanTest {

    @Test fun `no document bars nothing`() {
        assertFalse(DeviceBan.applies(exists = false, isActive = null))
        assertFalse(DeviceBan.applies(exists = false, isActive = true))
    }

    @Test fun `a live bar bars, including one written before the field existed`() {
        assertTrue(DeviceBan.applies(exists = true, isActive = true))
        assertTrue(DeviceBan.applies(exists = true, isActive = null))
    }

    @Test fun `a lifted bar bars nothing`() {
        assertFalse(DeviceBan.applies(exists = true, isActive = false))
    }

    @Test fun `both client checks use it`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val repo = File(main, "com/zipper/app/data/repository/AuthRepository.kt").readText()
        val fn = repo.substring(repo.indexOf("suspend fun getDeviceBanReason("), repo.indexOf("private suspend fun generateSession("))
        assertTrue(fn.contains("DeviceBan.applies(snap.exists(), snap.getBoolean(\"isActive\"))"))
        assertFalse(fn.contains("if (snap.exists()) snap.getString"))
        val splash = File(main, "com/zipper/app/ui/screens/auth/SplashScreen.kt").readText()
        assertFalse(splash.contains("if (deviceBanSnap.exists()) {"))
    }

    @Test fun `C6 the session refusal for a barred device is recognised and nothing else is`() {
        assertTrue(DeviceBan.isDeviceBarred("DEVICE_BARRED"))
        assertTrue(DeviceBan.isDeviceBarred(" DEVICE_BARRED "))
        for (code in listOf(null, "", "device_banned", "ACCOUNT_RESTRICTED", "SESSION_DISPLACED")) {
            assertFalse("'$code' is not DEVICE_BARRED", DeviceBan.isDeviceBarred(code))
        }
    }

    @Test fun `C6 a refused session on a barred device is not reported as a connection problem`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val repo = File(main, "com/zipper/app/data/repository/AuthRepository.kt").readText()
        val start = repo.indexOf("private suspend fun generateSession(")
        val fn = repo.substring(start, repo.indexOf("private suspend fun mintQuickLoginCredential(", start))
        assertTrue(fn.contains("DeviceBan.isDeviceBarred(res.detail)"))
        assertTrue(fn.contains("AuthResult.Banned(res.userMessage, RestrictionKind.Device)"))
    }
}
