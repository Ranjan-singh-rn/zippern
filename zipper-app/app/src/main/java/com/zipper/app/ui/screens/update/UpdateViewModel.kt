package com.zipper.app.ui.screens.update

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.UpdateRepository
import com.zipper.app.data.repository.UpdateRepository.UpdateInfo
import com.zipper.app.util.ApkInstaller
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/**
 * Which step of the OTA flow is on screen. Nothing is drawn on [Hidden].
 */
enum class UpdatePhase {
    Hidden,

    /** The offer: version, notes, size, Update / Later. */
    Prompt,

    /**
     * "Install unknown apps" is off for this app, so the download would be
     * wasted. Asked for BEFORE the bytes, not after — see [startDownload].
     */
    NeedsPermission,

    Downloading,

    /**
     * Rebuilding the APK from the installed one plus the downloaded patch.
     *
     * Its own phase because it is not free: reconstructing ~90 MB takes seconds,
     * and leaving the download bar pinned at 100% for that long reads as a hang.
     * A hang is the state in which people force-quit — which is the one action
     * that guarantees the update never lands.
     *
     * Never reached when there is no patch, and a patch that fails to apply
     * moves straight back to [Downloading] for the full APK. The person is not
     * told which of those happened, because there is nothing for them to do
     * about it.
     */
    Applying,

    /** Hashing. A step of its own because on a large APK it is visibly not instant. */
    Verifying,

    /** Verified and waiting. The system installer has been offered once already. */
    ReadyToInstall,

    Failed,

    /**
     * "You are on the latest version" — reachable only from the Settings row.
     *
     * An automatic check that found nothing shows nothing at all; being told
     * there is no news on every launch is noise. Somebody who tapped
     * "Check for updates" asked a question and is owed an answer.
     */
    UpToDate,
}

data class UpdateUiState(
    val phase: UpdatePhase = UpdatePhase.Hidden,
    val info: UpdateInfo? = null,
    /**
     * This update may not be skipped: `mandatory`, or this build is below
     * `minSupportedVersionCode`. Held separately from the phase because it
     * survives every phase — the dialog stays inescapable while downloading,
     * while failed, and while waiting to install.
     */
    val required: Boolean = false,
    val bytesSoFar: Long = 0L,
    val totalBytes: Long = 0L,
    val error: String? = null,
    /** The verified APK, once there is one. */
    val file: File? = null,
) {
    /** 0f..1f, or null while the total is not yet known. */
    val fraction: Float?
        get() = if (totalBytes > 0L) (bytesSoFar.toFloat() / totalBytes).coerceIn(0f, 1f) else null
}

/**
 * Drives the update check, the download and the install.
 *
 * Activity-scoped (obtained with `by viewModels()` in `MainActivity`), for two
 * reasons that both matter:
 *
 *  * a download must not be cancelled by a rotation or by navigating away from
 *    whatever screen happened to be showing when it started, and
 *  * the "once per launch" guard has to live somewhere that survives
 *    recomposition but not a cold start. A ViewModel retained by the Activity is
 *    exactly that lifetime.
 */
@HiltViewModel
class UpdateViewModel @Inject constructor(
    private val updateRepository: UpdateRepository,
    private val apkInstaller: ApkInstaller,
) : ViewModel() {

    private val _state = MutableStateFlow(UpdateUiState())
    val state: StateFlow<UpdateUiState> = _state.asStateFlow()

    private var checked = false
    private var downloadJob: Job? = null

    /**
     * The automatic check. Runs at most once for the life of the Activity.
     *
     * Silent when there is nothing to say: no spinner, no toast, and no dialog
     * on [UpdateRepository.UpdateCheck.UpToDate] — which is also what every
     * failure returns.
     */
    fun checkOnce() {
        if (checked) return
        checked = true
        runCheck(manual = false)
    }

    /** The Settings row. Ignores the once-guard and always reports back. */
    fun checkManually() {
        checked = true
        // Don't interrupt a download that is already running to ask a question
        // whose answer we are looking at.
        if (_state.value.phase != UpdatePhase.Hidden) return
        runCheck(manual = true)
    }

    private fun runCheck(manual: Boolean) {
        viewModelScope.launch {
            when (val result = updateRepository.check()) {
                is UpdateRepository.UpdateCheck.UpToDate ->
                    if (manual) {
                        _state.value = UpdateUiState(phase = UpdatePhase.UpToDate)
                    }

                is UpdateRepository.UpdateCheck.Available ->
                    _state.value = UpdateUiState(
                        phase = UpdatePhase.Prompt,
                        info = result.info,
                        required = false,
                    )

                is UpdateRepository.UpdateCheck.Required ->
                    _state.value = UpdateUiState(
                        phase = UpdatePhase.Prompt,
                        info = result.info,
                        required = true,
                    )
            }
        }
    }

    /**
     * Update was tapped.
     *
     * The install permission is checked FIRST. Asking afterwards would mean the
     * person spends tens of megabytes and several minutes, and only then finds
     * out they have to go into Settings — and if they refuse, all of it was for
     * nothing. The order is also the honest one: this is the step where they
     * decide, so it is the step where they are asked.
     */
    fun startDownload() {
        val info = _state.value.info ?: return
        if (!apkInstaller.canInstallPackages()) {
            _state.value = _state.value.copy(phase = UpdatePhase.NeedsPermission, error = null)
            return
        }
        if (downloadJob?.isActive == true) return

        _state.value = _state.value.copy(
            phase = UpdatePhase.Downloading,
            bytesSoFar = 0L,
            // The patch's size when there is a patch — the same number the
            // prompt quoted. Every later total comes from the progress events
            // themselves, so a patch that fails to apply resets the bar to the
            // full APK's size with no special handling here.
            totalBytes = info.downloadSizeBytes,
            error = null,
            file = null,
        )

        downloadJob = viewModelScope.launch {
            apkInstaller.download(info).collect { progress ->
                when (progress) {
                    is ApkInstaller.Progress.Downloading ->
                        _state.value = _state.value.copy(
                            phase = UpdatePhase.Downloading,
                            bytesSoFar = progress.bytesSoFar,
                            totalBytes = progress.total,
                        )

                    is ApkInstaller.Progress.Applying ->
                        _state.value = _state.value.copy(
                            phase = UpdatePhase.Applying,
                            bytesSoFar = progress.bytesSoFar,
                            totalBytes = progress.total,
                        )

                    is ApkInstaller.Progress.Verifying ->
                        _state.value = _state.value.copy(phase = UpdatePhase.Verifying)

                    is ApkInstaller.Progress.Ready -> {
                        _state.value = _state.value.copy(
                            phase = UpdatePhase.ReadyToInstall,
                            file = progress.file,
                        )
                        // Offer the installer straight away — one tap, not two,
                        // for somebody who has already said yes. The dialog stays
                        // up behind the system sheet so a dismissed sheet still
                        // has an Install button to go back to.
                        install()
                    }

                    is ApkInstaller.Progress.Failed ->
                        _state.value = _state.value.copy(
                            phase = UpdatePhase.Failed,
                            error = progress.reason,
                        )
                }
            }
        }
    }

    /** Hand the verified file to the system installer. */
    fun install() {
        val file = _state.value.file ?: return
        val error = apkInstaller.install(file)
        if (error != null) {
            _state.value = _state.value.copy(phase = UpdatePhase.Failed, error = error)
        }
    }

    /** The intent for the "install unknown apps" screen, for the UI to launch. */
    fun unknownSourcesIntent() = apkInstaller.unknownSourcesSettingsIntent()

    /**
     * Back from the system settings screen.
     *
     * The result code is useless — ACTION_MANAGE_UNKNOWN_APP_SOURCES reports
     * RESULT_CANCELED whether the toggle was flipped or not — so the permission
     * itself is re-read. Granted: carry straight on into the download, because
     * the person has already tapped Update and making them tap it again reads as
     * the app having lost their answer. Refused: back to the offer, which for a
     * required update is still not dismissible.
     */
    fun onReturnFromPermissionSettings() {
        if (apkInstaller.canInstallPackages()) {
            startDownload()
        } else {
            _state.value = _state.value.copy(phase = UpdatePhase.Prompt, error = null)
        }
    }

    /** Try the whole download again after a failure. */
    fun retry() {
        _state.value = _state.value.copy(phase = UpdatePhase.Prompt, error = null, file = null)
    }

    /**
     * Later, or the "up to date" acknowledgement.
     *
     * Refuses to do anything for a required update, so a stray caller cannot
     * open the escape hatch the dialog deliberately does not draw. Also cancels
     * an in-flight download — [ApkInstaller.download] deletes the partial file
     * when its flow is cancelled, so nothing is left on the handset.
     */
    fun dismiss() {
        if (_state.value.required && _state.value.phase != UpdatePhase.UpToDate) return
        downloadJob?.cancel()
        downloadJob = null
        _state.value = UpdateUiState()
    }
}
