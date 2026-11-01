package com.zipper.app.ui.screens.auth

/**
 * FX-15 — one action at a time on the sign-in and binding screens.
 *
 * Every entry point that starts something irreversible — sending an SMS,
 * verifying an OTP (Verify button, keyboard Done, SMS auto-fill), saving the
 * profile (which may also redeem a referral code), linking a phone, unlinking
 * one — asks this first, with whatever flag says "already running". Several of
 * them used to start a second time: a keyboard Done that was not gated on
 * loading, an auto-filled code that re-ran on screen recreation, a 300–500 ms
 * delay before the loading flag was set, SMS auto-retrieval linking while a
 * typed code was already linking (RF-28).
 *
 * Deliberately trivial, and named, so each call site reads as the guard it is
 * and `SubmitGuardTest` pins the meaning. The ViewModel is the authority: the
 * first call sets its in-flight flag synchronously on the main thread, so the
 * second call — however it arrives — sees it.
 */
object SubmitGuard {
    /** May a new action start, given whether one is already in flight? */
    fun mayStart(inFlight: Boolean): Boolean = !inFlight
}
