package com.zipper.app.util

/**
 * A-5 / A-23 (APK 20): is the downloaded APK one this app may hand to the
 * system installer?
 *
 * The SHA-256 check in `ApkInstaller` proves the bytes are the bytes that were
 * PUBLISHED — integrity. It proves nothing about what was published: a wrong
 * document (`appConfig/androidUpdate` is writable by every tech-family CRM
 * role) can point at another package, an older build, or an APK signed by a
 * different key. Android stops the last of those at the very end, after the
 * download and the permission prompt, with INSTALL_FAILED_UPDATE_INCOMPATIBLE
 * and no sentence a person can act on; the first two it would happily
 * install. So the archive's own manifest and signing block are read before
 * `ACTION_VIEW`, and all three must match the running app:
 *
 *   * the package name — it is an update to THIS app or it is nothing;
 *   * the versionCode — strictly greater than what is running, or the
 *     "update" is a downgrade the installer would refuse anyway;
 *   * the signer certificates — the same set as the running app's, so the
 *     install cannot fail on the key and nothing signed elsewhere is offered
 *     with the consent the user gave us.
 *
 * Pure. The Android half (`PackageManager.getPackageArchiveInfo`) feeds it
 * plain values, and the decision is tested without a device.
 */
object ApkVerification {

    /** What the downloaded archive says about itself. Nulls for fields the parser could not read. */
    data class Candidate(
        val packageName: String?,
        val versionCode: Long?,
        /** Lowercase hex SHA-256 of each signing certificate, in any order. Empty when unreadable. */
        val signerSha256: List<String>,
    )

    /** The app that is running, from `PackageManager.getPackageInfo`. */
    data class Running(
        val packageName: String,
        val versionCode: Long,
        val signerSha256: List<String>,
    )

    sealed interface Verdict {
        data object Ok : Verdict
        /** [reason] is written for the person holding the phone — and for the chat it will be pasted into. */
        data class Refused(val reason: String) : Verdict
    }

    /** The decision. Order matters only for which sentence is shown; every check runs on every file. */
    fun decide(candidate: Candidate?, running: Running): Verdict {
        if (candidate == null) {
            return Verdict.Refused(
                "The downloaded file is not a readable Android package. It has been deleted; nothing was installed.",
            )
        }
        val pkg = candidate.packageName?.trim().orEmpty()
        if (pkg.isEmpty() || pkg != running.packageName) {
            return Verdict.Refused(
                "The downloaded file is for a different app (${pkg.ifEmpty { "unknown" }}), not Zipper. " +
                    "It has been deleted; nothing was installed. Tell the team.",
            )
        }
        val version = candidate.versionCode
        if (version == null || version <= running.versionCode) {
            return Verdict.Refused(
                "The downloaded build (${version ?: "unknown version"}) is not newer than the one " +
                    "installed (${running.versionCode}). It has been deleted; nothing was installed.",
            )
        }
        val theirs = normalise(candidate.signerSha256)
        val ours = normalise(running.signerSha256)
        if (theirs.isEmpty() || ours.isEmpty() || theirs != ours) {
            return Verdict.Refused(
                "The downloaded build is signed with a different key from the installed app, so Android " +
                    "would refuse to install it. It has been deleted; nothing was installed. Tell the team.",
            )
        }
        return Verdict.Ok
    }

    /** Lowercase, trimmed, de-duplicated, order-free. */
    fun normalise(hashes: List<String>): Set<String> =
        hashes.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    /** Bytes of a DER certificate → lowercase hex SHA-256. */
    fun sha256Hex(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { b -> "%02x".format(b) }
}
