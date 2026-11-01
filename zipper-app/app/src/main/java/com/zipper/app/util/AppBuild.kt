package com.zipper.app.util

import android.content.Context
import androidx.core.content.pm.PackageInfoCompat

/**
 * D18 — the build this handset actually runs, for the sign-in gate to record.
 *
 * Read from PackageManager, never `BuildConfig.VERSION_CODE`: that constant is
 * inlined at compile time and goes stale in any file incremental compilation
 * did not rebuild (see `UpdateRepository.installedVersionCode`, which learned
 * this the hard way). What the gate records is what adoption is measured from,
 * so it has to be what is installed.
 */
object AppBuild {

    /** The installed versionCode, or 0 when it cannot be read (the server then records nothing). */
    fun installedVersionCode(context: Context): Int = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        PackageInfoCompat.getLongVersionCode(info).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
    } catch (_: Exception) {
        0
    }
}
