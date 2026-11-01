package com.zipper.app.ui.screens.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.ui.theme.ZipperTheme

/**
 * APK 20 / spec §8 — the door into Main.
 *
 * Wraps the Main destination so every path into the app passes it (cold
 * start, Login, profile setup, face verification, account recovery). For
 * everyone but an Owner it renders [content] after one DataStore read and
 * sends nothing anywhere; for an Owner it shows [OwnerMfaScreen] until the
 * server's two-step sign-in has passed on THIS process's API session, and
 * only then renders [content]. Fails closed: until the pre-filter has been
 * read, nothing of Main is composed.
 *
 * No pass is remembered across view-models on purpose: a fresh Main entry
 * costs an Owner one `GET /api/auth/me` (already verified → straight in;
 * session gone after a sign-out → the code is asked again), and costs an
 * ordinary user nothing.
 */
@Composable
fun OwnerMfaGateHost(
    /** Sign the app out with the reason the login screen should show (null = none). */
    onRefused: (reason: String?) -> Unit,
    content: @Composable () -> Unit,
) {
    val viewModel: OwnerMfaViewModel = hiltViewModel()
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.begin() }
    // Spec §8: the Observer is refused outright — signed out with the sentence, nothing to press.
    LaunchedEffect(ui.step) {
        if (MfaMachine.signsOutAtOnce(ui.step)) onRefused(OwnerMfaGate.OBSERVER_DENIED_MESSAGE)
    }
    when {
        ui.applies == null -> Box(Modifier.fillMaxSize().background(ZipperTheme.colors.bgBase))
        ui.applies == false || MfaMachine.passes(ui.step) -> content()
        else -> OwnerMfaScreen(onPassed = {}, onSignOut = onRefused, viewModel = viewModel)
    }
}
