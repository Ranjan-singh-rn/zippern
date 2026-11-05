package com.zipper.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.zipper.app.data.repository.CallAvailabilityRepository
import com.zipper.app.util.CallAvailability
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent

/** WP2: how a composable without a ViewModel of its own reaches the one [CallAvailabilityRepository]. */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface CallAvailabilityEntryPoint {
    fun callAvailabilityRepository(): CallAvailabilityRepository
}

/**
 * WP2 (5 Nov 2026): whether a call to [uid] would ring right now — for a Call row in a sheet (a party member), which
 * follows the same switch as the profile and the chat. AVAILABLE until the first answer arrives; `startCall` decides.
 */
@Composable
fun rememberCallAvailability(uid: String): State<CallAvailability.Result> {
    val app = LocalContext.current.applicationContext
    val repo = remember(app) {
        EntryPointAccessors.fromApplication(app, CallAvailabilityEntryPoint::class.java).callAvailabilityRepository()
    }
    val flow = remember(uid) { repo.observe(uid) }
    return flow.collectAsStateWithLifecycle(initialValue = CallAvailability.AVAILABLE)
}
