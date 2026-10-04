package com.zipper.app.util

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.zipper.app.data.repository.UpdateRepository.UpdateInfo
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Fetches an OTA APK, proves it is the one that was published, and hands it to
 * the system installer.
 *
 * ── WHY A PLAIN HTTP STREAM AND NOT DownloadManager ──────────────────────────
 *
 * DownloadManager was the obvious choice and was what this used: a system
 * service that survives the app being backgrounded, retries across a network
 * change, draws a notification the user already understands, and costs no
 * dependency.
 *
 * It does not work on every phone. `com.android.providers.downloads` can be
 * disabled by the user and is disabled automatically by several "battery saver"
 * apps, and when it is, `enqueue()` still returns an id — for a download nothing
 * will ever service. No exception, no failure status, no way to tell it from a
 * slow network. It showed up as a progress bar frozen at zero, three separate
 * times, including for a 0.2 MB patch where size, timeout, disk space and
 * connectivity had all been ruled out.
 *
 * The thing that ships fixes cannot rest on a component the user can switch
 * off. `HttpURLConnection` is in the platform, cannot be disabled, and needs no
 * dependency either. What is genuinely lost is backgrounded downloading and
 * resume — and resume was never configured here anyway, so a dropped connection
 * always restarted. With delta patches most updates are now well under a
 * megabyte, which is the size at which none of that mattered.
 *
 * ── WHY app-scoped EXTERNAL FILES, NOT Downloads/ OR cacheDir ────────────────
 *
 * `getExternalFilesDir(DIRECTORY_DOWNLOADS)` needs NO storage permission on any
 * supported API, is readable by the system package installer (which runs as a
 * different process and therefore cannot read internal `filesDir`), and is wiped
 * with the app. The public Downloads collection would mean either
 * WRITE_EXTERNAL_STORAGE or MediaStore, plus leaving a stray APK in the user's
 * gallery app for ever.
 *
 * ── DELTA UPDATES, AND THE ONE RULE THAT GOVERNS THEM ────────────────────────
 *
 * When the publisher has generated a bsdiff patch from the build this handset is
 * running to the one being offered, [download] fetches that patch (single-digit
 * megabytes) and rebuilds the new APK from the installed one instead of pulling
 * ~90 MB down again. See [tryPatch].
 *
 * A PATCH IS AN OPTIMISATION AND NOTHING ELSE. Every way it can fail — no patch
 * published, patch download failed, patch hash wrong, installed APK unreadable,
 * out of disk, out of memory, a bug in [BsPatch] — falls through to the full
 * download, silently, with the reason written only to logcat. A delta update
 * must never be the reason somebody cannot update, and there is no patch-specific
 * error the person holding the phone could act on: from where they are standing,
 * a patch that did not work is a download that took longer.
 *
 * That is the opposite of how a hash mismatch on the FULL APK is treated, and
 * deliberately so. A patch that does not reconstruct the published APK means
 * this device's installed binary was not what the patch was generated against —
 * a normal thing (sideloaded build, different split, partially-applied earlier
 * update). A full APK that does not match its published hash means the bytes at
 * that URL are not the bytes that were published, which is not normal and is
 * said out loud.
 */
@Singleton
class ApkInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    sealed interface Progress {
        /** Bytes so far and the expected total. [total] is never 0 — see [download]. */
        data class Downloading(val bytesSoFar: Long, val total: Long) : Progress

        /**
         * Rebuilding the APK from the installed one plus the patch.
         *
         * Its own step with its own byte counter because on a ~90 MB result it
         * takes seconds, and a progress bar parked at 100% while that happens is
         * indistinguishable from a hang — which is the state in which people
         * kill the app and never get the update at all.
         */
        data class Applying(val bytesSoFar: Long, val total: Long) : Progress

        /** Hashing the file. Separate from Downloading because on a 48 MB APK it is visibly not instant. */
        data object Verifying : Progress

        /** Hash matched. [file] is ready for [install]. */
        data class Ready(val file: File) : Progress

        /** Something went wrong, said in words a tester can paste into a chat. */
        data class Failed(val reason: String) : Progress
    }

    /**
     * True when this app may ask the system to install a package.
     *
     * `minSdk` is 26, which is exactly the API that introduced per-app
     * REQUEST_INSTALL_PACKAGES consent, so there is no older branch to write:
     * the permission in the manifest is necessary and never sufficient.
     */
    fun canInstallPackages(): Boolean = context.packageManager.canRequestPackageInstalls()

    /**
     * The settings page where the user grants "install unknown apps" for THIS
     * app specifically.
     *
     * The `package:` URI is what makes it land on our own entry rather than the
     * global list of every installed app — without it the person has to find
     * "Zipper" in a list of forty, which is where this flow gets abandoned.
     */
    fun unknownSourcesSettingsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    /**
     * Get [info]'s APK onto this handset and verify it, emitting progress the
     * whole way.
     *
     * Tries the patch first when there is one, then falls back to downloading
     * the whole file. The flow ends on [Progress.Ready] or [Progress.Failed] and
     * never throws. Cancelling it removes the download and its partial file, so
     * a dismissed dialog does not leave megabytes behind.
     */
    fun download(info: UpdateInfo): Flow<Progress> = flow {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        if (dir == null) {
            emit(Progress.Failed("Storage is unavailable on this device."))
            return@flow
        }

        // The cheap route, if the publisher built one for the version this
        // handset is on. Null means it was not tried or did not work, and either
        // way the answer is the same: download the whole thing.
        val patch = info.patch
        if (patch != null) {
            val rebuilt = tryPatch(dir, info, patch)
            if (rebuilt != null) {
                emit(Progress.Ready(rebuilt))
                return@flow
            }
        }

        when (
            val fetched = fetch(
                dir = dir,
                url = info.url,
                fileName = apkFileName(info),
                expectedSize = info.sizeBytes,
                expectedSha256 = info.sha256,
                noun = "update",
            )
        ) {
            is Fetched.Ok -> emit(Progress.Ready(fetched.file))
            is Fetched.Failed -> emit(Progress.Failed(fetched.reason))
        }
    }.flowOn(Dispatchers.IO)

    /**
     * Download the patch, apply it to the installed APK, verify the result.
     *
     * @return the verified, reconstructed APK, or null — and null is not an
     *   error, it is "use the full download". Nothing in here emits
     *   [Progress.Failed]; see the class comment.
     *
     * ── THE INSTALLED APK IS THE PATCH SOURCE ───────────────────────────────
     *
     * `applicationInfo.sourceDir` is the path to the APK this process is running
     * from. With `splits { abi }` that is the split for THIS device's
     * architecture, which is exactly the binary the patch was generated against,
     * because the publish side generates one patch per ABI and
     * [com.zipper.app.data.repository.UpdateRepository] only ever hands back the
     * entry matching this CPU.
     *
     * ── VERIFYING THE RESULT IS WHAT VERIFIES THE SOURCE ────────────────────
     *
     * There is nothing to check the installed APK against before patching: the
     * document publishes the hash of the NEW apk, not of every old one, and the
     * file on disk may have been resigned, recompressed by the installer, or be
     * a build that never came from us at all.
     *
     * So the check is on the output. If the reconstructed APK hashes to the
     * published `sha256` of the full APK then the old file was byte-for-byte
     * what the patch expected, because bsdiff reconstruction is deterministic
     * and SHA-256 does not collide by accident. If it does not, the source was
     * wrong: delete the result and download the real thing. That check is the
     * entire safety argument for delta updates, which is why it is a hard
     * failure here and not a warning — an unverified APK would be installed with
     * consent the user gave THIS app, which is the one thing the whole download
     * path exists to prevent.
     */
    private suspend fun FlowCollector<Progress>.tryPatch(
        dir: File,
        info: UpdateInfo,
        patch: UpdateInfo.Patch,
    ): File? {
        var patchFile: File? = null
        // Non-null while the reconstructed APK is still a liability rather than
        // an asset. Cleared once it has passed the hash check, so the `finally`
        // below deletes a half-built or wrong APK and never a good one.
        var scratch: File? = null

        return try {
            val installed = File(context.applicationInfo.sourceDir)
            if (!installed.isFile || !installed.canRead()) {
                Log.i(TAG, "No delta: the installed APK at ${installed.path} is not readable.")
                return null
            }

            val fetched = fetch(
                dir = dir,
                url = patch.url,
                fileName = "zipper-${info.versionCode}.bsdiff",
                expectedSize = patch.sizeBytes,
                expectedSha256 = patch.sha256,
                noun = "patch",
            )
            if (fetched is Fetched.Failed) {
                Log.i(TAG, "No delta: ${fetched.reason}")
                return null
            }
            // Held as a val as well as in `patchFile`, because `patchFile` is a
            // local var captured by the cleanup lambdas below and so cannot be
            // smart-cast out of File? at the call site.
            val downloaded = (fetched as Fetched.Ok).file
            patchFile = downloaded

            val target = File(dir, apkFileName(info))
            runCatching { if (target.exists()) target.delete() }
            scratch = target

            emit(Progress.Applying(0L, info.sizeBytes))
            BsPatch.apply(installed, downloaded, target) { written, total ->
                emit(Progress.Applying(written, total))
            }

            emit(Progress.Verifying)

            // Size first because it is free, then the hash. Same order and same
            // standard as the full download — a patch result gets no discount.
            val size = target.length()
            if (size != info.sizeBytes) {
                Log.w(TAG, "No delta: patched APK is $size bytes, published size is ${info.sizeBytes}.")
                return null
            }
            val hash = withContext(Dispatchers.IO) { sha256Of(target) }
            if (hash == null || hash != info.sha256) {
                Log.w(TAG, "No delta: patched APK hashed to $hash, published hash is ${info.sha256}.")
                return null
            }

            scratch = null
            target
        } catch (cancelled: CancellationException) {
            // Cancellation is not a patch failure. Rethrown before the catch-all
            // below, because swallowing it would turn a dismissed dialog into a
            // 90 MB full download nobody asked for.
            throw cancelled
        } catch (t: Throwable) {
            // Throwable, not Exception, on purpose and against the usual rule.
            // An OutOfMemoryError while rebuilding a 90 MB file is a foreseeable
            // outcome on a cheap handset, and the one thing it must not do is
            // stop that handset from updating. Everything here is recoverable by
            // definition: the fallback is the download this feature replaced.
            Log.w(TAG, "No delta: patching failed, falling back to the full download.", t)
            null
        } finally {
            // The patch is useless either way once we get here.
            runCatching { patchFile?.delete() }
            runCatching { scratch?.delete() }
        }
    }

    /** One fetched-and-verified file, or a reason phrased for a person. */
    private sealed interface Fetched {
        data class Ok(val file: File) : Fetched
        data class Failed(val reason: String) : Fetched
    }

    /**
     * Download one file and prove it is the one that was published.
     *
     * Deliberately ONE function for the APK and for the patch. Both are bytes
     * fetched from a URL in a document and both are described by the same
     * url/sha256/sizeBytes triple, so they are held to the same standard — a
     * separate, looser path for the patch would be a file we decompress and
     * execute arithmetic from without having checked it.
     *
     * @param noun goes into the failure text. Only the APK's failures are ever
     *   shown to anybody; the patch's are logged.
     */
    private suspend fun FlowCollector<Progress>.fetch(
        dir: File,
        url: String,
        fileName: String,
        expectedSize: Long,
        expectedSha256: String,
        noun: String,
    ): Fetched {
        // Named for the build, so two interrupted attempts at different
        // versions cannot be mistaken for each other. Deleted first: a stale
        // file from an interrupted attempt would otherwise be verified in place
        // of the real one.
        val target = File(dir, fileName)
        runCatching { if (target.exists()) target.delete() }

        /*
         * ── A PLAIN HTTP STREAM, NOT DownloadManager ─────────────────────────
         *
         * This used `DownloadManager`, and the reasoning was sound: it survives
         * the app being backgrounded, resumes across a dropped connection, and
         * draws its own notification — all worth having for a 90 MB APK.
         *
         * It also never ran. On the handset this was tested on, an enqueued
         * download sat at zero bytes indefinitely and reported no failure. The
         * system provider `com.android.providers.downloads` can be disabled by
         * the user, and is disabled automatically by several "battery saver"
         * apps; when it is, `enqueue()` still returns an id, for a download
         * nothing will ever service. There is no error to surface and no status
         * that distinguishes it from a slow network — so it presented as a
         * frozen progress bar three times running, including for a 0.2 MB patch,
         * where size, timeout, disk space and connectivity were all ruled out.
         *
         * A component the user can switch off is the wrong foundation for the
         * thing that ships fixes. `HttpURLConnection` has none of the niceties
         * and cannot be turned off. For a patch measured in hundreds of
         * kilobytes the niceties were worth little anyway, and for the full APK
         * a failed download simply restarts — which is what it did before, since
         * nothing here ever asked DownloadManager to resume.
         *
         * `flowOn(Dispatchers.IO)` on the flow below puts this blocking loop and
         * its `emit`s off the main thread already.
         */
        var keepFile = false
        try {
            emit(Progress.Downloading(0L, expectedSize))

            val conn = try {
                (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    instanceFollowRedirects = true
                    requestMethod = "GET"
                }
            } catch (e: Exception) {
                return Fetched.Failed("Could not reach the server: ${e.message ?: "unknown error"}")
            }

            try {
                val status = conn.responseCode
                if (status !in 200..299) {
                    return Fetched.Failed("The server answered $status for the $noun.")
                }

                // Content-Length when the server gives one, the published size
                // otherwise. A bar divided by -1 reads as frozen, which is the
                // one thing this is here to avoid.
                val announced = conn.contentLengthLong.takeIf { it > 0L } ?: expectedSize

                /*
                 * How often the bar is redrawn, SCALED TO THE FILE.
                 *
                 * A fixed 256 KB threshold was wrong in exactly the case that
                 * matters now: a delta patch is often ~200 KB, so the condition
                 * never fired and the only updates were the 0 at the start and
                 * the total at the end. The download worked and the dialog read
                 * "0 MB of 0.2 MB" throughout — indistinguishable, to anybody
                 * watching, from the frozen bar this whole class of bug has
                 * already produced three times.
                 *
                 * A fiftieth of the file gives a bar that moves about fifty
                 * times whatever the size; the 32 KB floor stops a tiny file
                 * emitting on every buffer, and the 256 KB ceiling keeps a 90 MB
                 * APK from redrawing 1,400 times.
                 */
                val emitEvery = (announced / 50L).coerceIn(32 * 1024L, EMIT_EVERY_BYTES)

                conn.inputStream.use { input ->
                    target.outputStream().buffered(BUFFER).use { output ->
                        val buf = ByteArray(BUFFER)
                        var soFar = 0L
                        var sinceEmit = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            soFar += n
                            sinceEmit += n
                            // Not per chunk: a full APK is ~1,400 buffers and a
                            // recomposition each would cost more than the
                            // download. A quarter megabyte is smooth and cheap.
                            if (sinceEmit >= emitEvery) {
                                emit(Progress.Downloading(soFar, announced))
                                sinceEmit = 0L
                            }
                        }
                        output.flush()
                        emit(Progress.Downloading(soFar, announced))
                    }
                }
            } catch (e: CancellationException) {
                // The person dismissed the dialog. Not a failure, and it must
                // not be reported as one.
                throw e
            } catch (e: Exception) {
                return Fetched.Failed("The download failed: ${e.message ?: "connection lost"}")
            } finally {
                runCatching { conn.disconnect() }
            }

            val file = target
            if (!file.exists()) return Fetched.Failed("The downloaded file is missing.")

            emit(Progress.Verifying)

            /*
             * ── THE HASH CHECK IS NOT A FORMALITY ────────────────────────────
             *
             * By the time this runs the user has already granted this app
             * permission to install packages from outside the store. That
             * consent is the whole security boundary, and it was given to US —
             * so whatever bytes arrived at this URL will be installed with it,
             * as a signed-looking update to an app that holds their account,
             * their camera and their microphone.
             *
             * A URL is not a promise about its contents. The document could be
             * edited, the bucket could be misconfigured, a captive portal or a
             * middlebox could answer instead of the CDN. If the hash does not
             * match the one the publisher wrote, this is not a corrupted
             * download to retry — it is a different file than the one that was
             * published, and the correct response is to destroy it and say so.
             *
             * The patch is held to the same standard for the same reason: it is
             * decompressed and turned into an APK that is then installed, so
             * unverified patch bytes are unverified APK bytes one step removed.
             *
             * Size is checked first because it is free and catches the dull
             * cases (a truncated transfer, an HTML error page served with a 200)
             * before spending a second hashing them.
             */
            val actualSize = file.length()
            if (actualSize != expectedSize) {
                runCatching { file.delete() }
                return Fetched.Failed(
                    "This file is not the published $noun — expected " +
                        "$expectedSize bytes, got $actualSize. It has been deleted."
                )
            }

            val actualHash = withContext(Dispatchers.IO) { sha256Of(file) }
            if (actualHash == null || actualHash != expectedSha256) {
                runCatching { file.delete() }
                return Fetched.Failed(
                    "This file does not match the published $noun and has been " +
                        "deleted. Nothing was installed. Tell the team before trying again."
                )
            }

            keepFile = true
            return Fetched.Ok(file)
        } finally {
            // Anything that leaves here without a verified file leaves no file.
            // That covers a cancelled dialog, a dropped connection and a hash
            // mismatch alike — and it matters most for the full APK, where the
            // alternative is ~90 MB of rubbish sitting in app storage that
            // nothing will ever clean up.
            //
            // This used `DownloadManager.remove(id)`, which deleted the row and
            // the file together. With the row gone, the file is ours to delete.
            if (!keepFile) runCatching { File(dir, fileName).delete() }
        }
    }

    /**
     * Hand the verified APK to the system package installer.
     *
     * ── WHY FileProvider ────────────────────────────────────────────────────
     *
     * A `file://` URI in an intent has thrown FileUriExposedException since
     * Android 7. The installer is a different process, so it needs a `content://`
     * URI plus FLAG_GRANT_READ_URI_PERMISSION to read one byte of this file.
     *
     * The authority is `${applicationId}.fileprovider`, declared in the manifest.
     * `packageName` and `applicationId` are the same string here because there is
     * no `applicationIdSuffix` on any build type — which is the same fact that
     * forces the debug/release channel split in
     * [com.zipper.app.data.repository.UpdateRepository].
     *
     * FLAG_ACTIVITY_NEW_TASK because this is called with the application context
     * in some paths and Android will not start an activity from a non-activity
     * context without it.
     *
     * Nothing here knows or cares whether the file arrived whole or was rebuilt
     * from a patch: by this point it has hashed to the published SHA-256 either
     * way, which makes them the same bytes.
     *
     * @return null on success, or a message to show when no installer answered.
     */
    fun install(file: File): String? {
        return try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            null
        } catch (e: Exception) {
            "Could not open the installer: ${e.message ?: "unknown error"}"
        }
    }

    /**
     * Where the finished APK lands, whichever route produced it.
     *
     * One name on purpose: the patch path writes here and, if it fails, the full
     * download deletes and overwrites it. Two names would leave a discarded
     * 90 MB file on the handset every time a patch did not apply.
     */
    private fun apkFileName(info: UpdateInfo): String = "zipper-${info.versionCode}.apk"

    /** Streamed in chunks — a 48 MB APK read whole would be 48 MB of heap for no reason. */
    private fun sha256Of(file: File): String? = try {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    } catch (_: Exception) {
        null
    }

    private companion object {
        const val TAG = "ApkInstaller"
        const val APK_MIME = "application/vnd.android.package-archive"

        /** Long enough for a slow Indian mobile connection to answer at all. */
        const val CONNECT_TIMEOUT_MS = 30_000
        /**
         * Per READ, not for the whole transfer. A 90 MB download over a poor
         * connection legitimately takes many minutes; what is not legitimate is
         * a socket that has gone quiet, and only this distinguishes them.
         */
        const val READ_TIMEOUT_MS = 60_000

        const val BUFFER = 64 * 1024

        /**
         * The CEILING on how much must arrive before the bar is redrawn; the
         * real interval is a fiftieth of the file, computed per download. See
         * `emitEvery` — a fixed value here made a 0.2 MB patch look frozen.
         */
        const val EMIT_EVERY_BYTES = 256 * 1024L
    }
}
