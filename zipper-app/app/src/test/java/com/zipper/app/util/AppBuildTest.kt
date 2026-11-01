package com.zipper.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D18 — the sign-in gate is told which build is installed, so the adoption of
 * the release that pins appeal ids can be counted before the restrictive rules
 * ship (`functions/src/identity.ts`, `appBuildReports/{uid}`).
 *
 * Wiring, pinned at the source: the value is the INSTALLED versionCode
 * (PackageManager), it rides on `resolveIdentity` — which runs on every cold
 * start and every sign-in — and a build that cannot read it sends nothing.
 */
class AppBuildTest {

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()

    @Test fun `the installed versionCode comes from PackageManager, never BuildConfig`() {
        val build = src("util/AppBuild.kt")
        assertTrue(build.contains("PackageInfoCompat.getLongVersionCode(info)"))
        assertTrue(build.contains("context.packageManager.getPackageInfo(context.packageName, 0)"))
        val code = build.lines().filterNot { it.trim().startsWith("*") || it.trim().startsWith("//") }.joinToString("\n")
        assertFalse("BuildConfig.VERSION_CODE is inlined and goes stale", code.contains("BuildConfig.VERSION_CODE"))
        assertTrue("an unreadable version is 0, which is not sent", build.contains("} catch (_: Exception) {\n        0\n    }"))
    }

    @Test fun `resolveIdentity carries the build, and only when it is known`() {
        val fns = src("data/repository/MoneyFunctions.kt")
        val at = fns.indexOf("suspend fun resolveIdentity(")
        val body = fns.substring(at, fns.indexOf(") { m ->", at))
        assertTrue(body.contains("put(\"deviceId\", deviceId)"))
        assertTrue(body.contains("if (appVersionCode > 0) put(\"appVersionCode\", appVersionCode)"))
        assertTrue(fns.contains("private val appVersionCode: Int by lazy { AppBuild.installedVersionCode(appContext) }"))
        assertTrue(fns.contains("@ApplicationContext private val appContext: Context"))
    }

    @Test fun `the server reads the same field name`() {
        val identity = listOf(File("../functions/src/identity.ts"), File("../../functions/src/identity.ts")).firstOrNull { it.exists() }
        if (identity != null) {
            val ts = identity.readText()
            assertTrue(ts.contains("data: { deviceId?: string; appVersionCode?: number }"))
            assertTrue(ts.contains("recordAppBuild(uid, data?.appVersionCode)"))
        }
    }
}
