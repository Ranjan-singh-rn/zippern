package com.zipper.app.ui.screens.auth

import androidx.lifecycle.ViewModel
import com.zipper.app.util.SessionManager
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/** Thin ViewModel whose only job is to expose SessionManager to SplashScreen.
 *  SessionManager is a Hilt singleton and cannot be injected directly into a Composable. */
@HiltViewModel
class SplashViewModel @Inject constructor(
    val sessionManager: SessionManager,
) : ViewModel()
