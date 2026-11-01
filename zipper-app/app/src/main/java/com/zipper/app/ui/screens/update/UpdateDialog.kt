package com.zipper.app.ui.screens.update

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.BuildConfig
import com.zipper.app.util.installedVersionLabel
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Somebody tapped "Check for updates" in Settings.
 *
 * Same shape as the old email-link hand-off (removed in UGP-C) and
 * `ForcedSignOut`, for the same reason: the screen that raises the event and the composable that owns the
 * dialog are in different parts of the tree, and neither should have to know
 * about the other.
 *
 * TAKEN rather than merely observed. A flag left set would be re-read the next
 * time [AppUpdateGate] enters composition — a rotation on Settings, say — and the
 * person would get a "you are up to date" dialog they did not ask for, from a tap
 * they made ten minutes ago.
 */
object UpdateCheckRequest {
    private val _pending = MutableStateFlow(false)
    val pending: StateFlow<Boolean> = _pending.asStateFlow()

    fun request() {
        _pending.value = true
    }

    /**
     * Take the request, leaving nothing behind.
     *
     * Not atomic, and does not need to be: both the raise and this are on the
     * main thread, and there is exactly one collector.
     */
    fun consume(): Boolean {
        val pending = _pending.value
        _pending.value = false
        return pending
    }
}

/**
 * The OTA dialog, and the only thing that mounts it.
 *
 * Drawn at the composition root — above the NavHost, not inside a destination —
 * so a download survives navigation and so a required update covers whatever
 * screen the person is standing on. See the call site in `MainActivity` for why
 * the check is gated on [authResolved].
 *
 * @param authResolved true once the splash has decided where this launch is
 *   going. Until then there is no check at all.
 */
@Composable
fun AppUpdateGate(
    viewModel: UpdateViewModel,
    authResolved: Boolean,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val manualPending by UpdateCheckRequest.pending.collectAsStateWithLifecycle()

    LaunchedEffect(authResolved) {
        if (authResolved) viewModel.checkOnce()
    }
    LaunchedEffect(manualPending) {
        if (manualPending && UpdateCheckRequest.consume()) viewModel.checkManually()
    }

    /*
     * The result code is thrown away on purpose — ACTION_MANAGE_UNKNOWN_APP_SOURCES
     * answers RESULT_CANCELED whether the toggle was flipped or not, so the
     * permission is re-read instead. This contract also fires when the person
     * simply presses Back out of Settings, which is the case that would otherwise
     * leave the dialog stuck on "waiting".
     */
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { viewModel.onReturnFromPermissionSettings() }

    if (state.phase == UpdatePhase.Hidden) return

    val c = ZipperTheme.colors
    val info = state.info
    val required = state.required

    /*
     * ── A REQUIRED UPDATE HAS NO WAY OUT, AND THAT IS THE WHOLE POINT ────────
     *
     * `onDismissRequest` is empty and both dismissOnBackPress and
     * dismissOnClickOutside are false. All three are needed: an empty
     * onDismissRequest alone still lets Compose consume the back press and the
     * outside tap as "dismissed", and the caller would be left with a dialog
     * that vanished without anything having changed.
     *
     * This is reserved for `mandatory`, or for a build below
     * `minSupportedVersionCode` — a client the server has declared it will no
     * longer answer correctly. Letting that one past the dialog does not give
     * the person a working app; it gives them a broken one with no explanation.
     * Every other update is dismissible in three ways and asks again next launch.
     */
    val dismiss: () -> Unit = { viewModel.dismiss() }
    val onDismissRequest: () -> Unit = if (required) ({}) else dismiss
    val properties = DialogProperties(
        dismissOnBackPress = !required,
        dismissOnClickOutside = !required,
    )

    // Hoisted with explicit types rather than written inline as
    // `if (required) null else { … }` at five call sites: an inline conditional
    // composable lambda leans on expected-type inference reaching through an `if`
    // into a lambda literal, and the same shape is needed five times with two
    // different labels. One declaration each, typed, and no inference to guess at.
    val laterButton: (@Composable () -> Unit)? =
        if (required) null else ({ TextButton(dismiss) { Text("Later", color = c.textSecondary) } })
    val notNowButton: (@Composable () -> Unit)? =
        if (required) null else ({ TextButton(dismiss) { Text("Not now", color = c.textSecondary) } })
    // A-23: a download the person no longer wants can be stopped. Cancel
    // removes the partial file; a REQUIRED update has no Cancel, as it has no Later.
    val cancelButton: (@Composable () -> Unit)? =
        if (required) null else ({ TextButton(dismiss) { Text("Cancel", color = c.textSecondary) } })

    when (state.phase) {
        UpdatePhase.UpToDate -> {
            AlertDialog(
                onDismissRequest = dismiss,
                containerColor = c.bgElevated,
                title = { Text("You are up to date", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        "This is the newest build that has been published for this channel.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                confirmButton = { TextButton(dismiss) { Text("OK", color = c.brandPrimary) } },
            )
        }

        // `info` is non-null for every phase the ViewModel can reach from a
        // successful check; the guard is here so a state that somehow lost it
        // draws nothing instead of crashing on `info!!`.
        UpdatePhase.Prompt -> if (info != null) {
            AlertDialog(
                onDismissRequest = onDismissRequest,
                properties = properties,
                containerColor = c.bgElevated,
                title = {
                    Text(
                        if (required) "Update required" else "Update available",
                        style = ZipperTheme.type.headingS, color = c.textPrimary,
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Text(
                            // The size that will actually leave their data
                            // balance: the patch's when there is one, the whole
                            // APK's otherwise. Quoting the full 90 MB for an
                            // 8 MB download is the kind of number that gets an
                            // update postponed indefinitely.
                            "Version ${info.versionName} · ${formatSize(info.downloadSizeBytes)}",
                            style = ZipperTheme.type.bodyM, color = c.textPrimary,
                        )
                        // `notes` is documented as possibly empty, so an empty
                        // string must not leave a blank line where a paragraph
                        // was expected.
                        if (info.notes.isNotEmpty()) {
                            Text(info.notes, style = ZipperTheme.type.bodyM, color = c.textSecondary)
                        }
                        if (required) {
                            Text(
                                "This version can no longer be used. Install the update to carry on.",
                                style = ZipperTheme.type.bodyM, color = c.statusWarning,
                            )
                        }
                        // Said out loud rather than left as a surprise. The
                        // headline number above is the patch, and a patch can
                        // fail to apply for reasons nobody here can see — at
                        // which point the full APK downloads instead. Somebody
                        // deciding on the strength of "8.4 MB" is owed the worst
                        // case before they tap, not after.
                        if (info.patch != null) {
                            Text(
                                "This is a small patch built from the version already on this " +
                                    "phone. If it cannot be used, the full " +
                                    "${formatSize(info.sizeBytes)} download starts instead.",
                                style = ZipperTheme.type.caption, color = c.textMuted,
                            )
                        }
                        Text(
                            "The update downloads over your mobile data if you are not on Wi-Fi.",
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                    }
                },
                confirmButton = {
                    TextButton({ viewModel.startDownload() }) { Text("Update", color = c.brandPrimary) }
                },
                // No Later at all when required — absent rather than disabled. A
                // greyed-out button invites tapping it and reads as a bug.
                dismissButton = laterButton,
            )
        }

        UpdatePhase.NeedsPermission -> {
            AlertDialog(
                onDismissRequest = onDismissRequest,
                properties = properties,
                containerColor = c.bgElevated,
                title = { Text("Allow installing updates", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        "Android needs your permission before Zipper can install its own " +
                            "update. The next screen has one switch — turn it on and come " +
                            "back, and the download starts by itself.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                confirmButton = {
                    TextButton({
                        // Launched through the result contract rather than
                        // startActivity, so coming back — by Allow or by Back —
                        // re-reads the permission. See the launcher above.
                        runCatching { permissionLauncher.launch(viewModel.unknownSourcesIntent()) }
                    }) { Text("Open settings", color = c.brandPrimary) }
                },
                dismissButton = notNowButton,
            )
        }

        UpdatePhase.Downloading, UpdatePhase.Applying, UpdatePhase.Verifying -> {
            val phase = state.phase
            val verifying = phase == UpdatePhase.Verifying
            val applying = phase == UpdatePhase.Applying
            AlertDialog(
                // Never dismissible by tapping AWAY, required or not: this one
                // has a running download behind it, and a stray tap outside
                // must not throw the bytes away. A non-mandatory update has an
                // explicit Cancel below instead (A-23).
                onDismissRequest = {},
                properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
                containerColor = c.bgElevated,
                title = {
                    Text(
                        when {
                            verifying -> "Checking the download"
                            applying -> "Applying update…"
                            else -> "Downloading update"
                        },
                        style = ZipperTheme.type.headingS, color = c.textPrimary,
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        val fraction = state.fraction
                        /*
                         * Real progress, from DownloadManager's own byte count.
                         * A 48 MB APK behind an indeterminate spinner is
                         * indistinguishable from a hang, and the first thing
                         * anybody does about a hang is kill the app — which is
                         * the one action that guarantees the update never lands.
                         *
                         * Indeterminate ONLY while hashing, where there is
                         * genuinely no progress to report, and where the step is
                         * named so the bar is not the only explanation.
                         *
                         * Applying is determinate for the same reason
                         * downloading is: rebuilding ~90 MB from a patch takes
                         * seconds, and the bar reports real bytes written, so it
                         * keeps moving instead of sitting full while the phone
                         * appears to have stopped.
                         */
                        if (verifying || fraction == null) {
                            LinearProgressIndicator(
                                modifier = Modifier.fillMaxWidth().height(4.dp),
                                color = c.brandPrimary,
                                trackColor = c.glassMid,
                            )
                        } else {
                            LinearProgressIndicator(
                                progress = { fraction },
                                modifier = Modifier.fillMaxWidth().height(4.dp),
                                color = c.brandPrimary,
                                trackColor = c.glassMid,
                            )
                        }
                        Text(
                            when {
                                verifying -> "Making sure this is the build that was published."
                                // Says what is happening AND keeps the byte
                                // counter, so the step reads as work in progress
                                // rather than as the download having stalled at
                                // the end.
                                applying -> "Building the new version from the one already " +
                                    "installed — ${formatSize(state.bytesSoFar)} of " +
                                    formatSize(state.totalBytes)
                                else -> "${formatSize(state.bytesSoFar)} of ${formatSize(state.totalBytes)}"
                            },
                            style = ZipperTheme.type.bodyM, color = c.textSecondary,
                        )

                        /*
                         * ── A DEBUG-ONLY LINE THAT SAYS WHAT IS ACTUALLY RUNNING ──
                         *
                         * This update has now appeared to freeze at zero bytes
                         * four times, from four different causes: a Firestore
                         * read denied before sign-in, a disabled system download
                         * provider, a progress threshold larger than the file,
                         * and — most often — a phone still running an older
                         * build that none of the fixes had reached yet.
                         *
                         * Every one of them produced the same screen. With no
                         * USB debugging on the test handset there was no way to
                         * tell them apart, so each round cost a build, a manual
                         * transfer and an install to rule out a single guess.
                         *
                         * The running build number and a seconds counter settle
                         * the most important question — is this even the code we
                         * think it is — from a photograph of the screen. The
                         * counter distinguishes "waiting on a socket" from
                         * "nothing is happening at all", because a stalled read
                         * fails on its own after 60s and a dead code path never
                         * will.
                         *
                         * DEBUG only. It is diagnostic text, not product copy.
                         */
                        if (BuildConfig.DEBUG) {
                            var elapsed by remember { mutableIntStateOf(0) }
                            LaunchedEffect(Unit) {
                                while (true) {
                                    kotlinx.coroutines.delay(1_000)
                                    elapsed += 1
                                }
                            }
                            Text(
                                "build ${LocalContext.current.installedVersionLabel()}" +
                                    " · ${elapsed}s · ${state.bytesSoFar} bytes",
                                style = ZipperTheme.type.caption, color = c.textMuted,
                            )
                        }
                    }
                },
                confirmButton = {},
                dismissButton = cancelButton,
            )
        }

        UpdatePhase.ReadyToInstall -> {
            AlertDialog(
                onDismissRequest = onDismissRequest,
                properties = properties,
                containerColor = c.bgElevated,
                title = { Text("Ready to install", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        "The download is verified. Android will ask you to confirm the install.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                confirmButton = { TextButton({ viewModel.install() }) { Text("Install", color = c.brandPrimary) } },
                dismissButton = laterButton,
            )
        }

        UpdatePhase.Failed -> {
            AlertDialog(
                onDismissRequest = onDismissRequest,
                properties = properties,
                containerColor = c.bgElevated,
                title = { Text("Update failed", style = ZipperTheme.type.headingS, color = c.textPrimary) },
                text = {
                    Text(
                        // The reason verbatim. A hash mismatch is not a hiccup —
                        // it means the file at that URL was not the file that was
                        // published — and whoever is holding the phone is the
                        // person who can tell the team about it.
                        state.error ?: "Something went wrong.",
                        style = ZipperTheme.type.bodyM, color = c.textSecondary,
                    )
                },
                // Try again RE-READS the update document (A-5), so a corrected
                // publish is picked up and a withdrawn one closes the dialog.
                confirmButton = { TextButton({ viewModel.retry() }) { Text("Try again", color = c.brandPrimary) } },
                dismissButton = laterButton,
            )
        }

        UpdatePhase.Hidden -> Unit   // returned above; here so the `when` is exhaustive
    }
}

/**
 * Bytes as something a person can weigh against their data balance.
 *
 * MB for everything an APK realistically is — no KB branch, because a 400 KB
 * APK does not exist and "0.4 MB" is clearer than switching units mid-flow.
 */
private fun formatSize(bytes: Long): String {
    if (bytes <= 0L) return "0 MB"
    val mb = bytes.toDouble() / (1024.0 * 1024.0)
    return "%.1f MB".format(mb)
}
