package com.zipper.app.util

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.pm.PackageInfoCompat

/**
 * The version of the APK that is actually installed, as text.
 *
 * ── WHY NOT BuildConfig ──────────────────────────────────────────────────────
 *
 * `BuildConfig.VERSION_NAME` and `VERSION_CODE` are `const`, and Kotlin inlines
 * constants into every call site at compile time. Raising the version in
 * `build.gradle.kts` regenerates BuildConfig, but incremental compilation only
 * recompiles files it believes have changed — so a file that merely READS the
 * constant keeps whatever value it was last compiled against, for as long as
 * nobody edits it.
 *
 * That produced a build where Android's own app settings reported 1.0.7 and the
 * app's login screen reported 1.0.4, on the same install, at the same moment:
 * the screen drawing it had not been touched since 1.0.4. Two numbers that are
 * supposed to be the same thing disagreeing is not a cosmetic bug — it sent a
 * day of debugging after a phantom, because the one fact needed to tell a stale
 * install from a live one was itself stale.
 *
 * `PackageManager` answers from what is installed on the device right now. It
 * cannot be inlined, so it cannot go out of date.
 */
fun Context.installedVersionLabel(): String = try {
    val info = packageManager.getPackageInfo(packageName, 0)
    "${info.versionName} (${PackageInfoCompat.getLongVersionCode(info)})"
} catch (_: PackageManager.NameNotFoundException) {
    // Our own package, so unreachable — but this only ever feeds a label, and a
    // crash there would be far worse than an honest blank.
    ""
}
