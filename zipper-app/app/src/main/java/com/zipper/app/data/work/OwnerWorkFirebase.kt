package com.zipper.app.data.work

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * P1-A3b — a SEPARATE Firebase app for an Owner's work, so the personal app's
 * phone sign-in, `startMobileSession`, `credentialsValidAfter` and every
 * app-user rule (`sessionCurrent()`) are never touched.
 *
 * After Owner MFA the backend mints a custom token carrying `mfa_sid`; it is
 * redeemed HERE (never on the default auth) and confirmed with the backend.
 * Only then does [WorkFirestore] route the work layer's Firestore through this
 * app. The session never survives the process: it is signed out at every cold
 * start (approved: Owner MFA again on each launch), on sign-out, and whenever
 * the personal account changes.
 *
 * Never logs custom tokens or ID tokens.
 */
@Singleton
class OwnerWorkFirebase @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val app: FirebaseApp by lazy {
        FirebaseApp.getApps(context).firstOrNull { it.name == APP_NAME }
            ?: FirebaseApp.initializeApp(context, FirebaseApp.getInstance().options, APP_NAME)
    }
    val auth: FirebaseAuth by lazy { FirebaseAuth.getInstance(app) }
    val firestore: FirebaseFirestore by lazy { FirebaseFirestore.getInstance(app) }

    /** The uid whose `ownerWork` session the backend confirmed in THIS process. */
    @Volatile private var confirmedUid: String? = null

    init {
        // Cold start: a persisted ownerWork session from an earlier process is
        // discarded — its API session lived only in memory.
        runCatching { auth.signOut() }
    }

    /** Sign the ownerWork app in with the custom token; returns its ID token. */
    suspend fun redeem(customToken: String): String? {
        confirmedUid = null
        auth.signInWithCustomToken(customToken).await()
        return auth.currentUser?.getIdToken(false)?.await()?.token
    }

    fun markConfirmed(uid: String) {
        if (auth.currentUser?.uid == uid) confirmedUid = uid
    }

    /** True only when this process confirmed an ownerWork session for `uid`. */
    fun isConfirmedFor(uid: String?): Boolean =
        selects(uid, confirmedUid, auth.currentUser?.uid)

    fun signOut() {
        confirmedUid = null
        runCatching { auth.signOut() }
    }

    companion object {
        const val APP_NAME = "ownerWork"

        /** Pure: the work layer uses ownerWork only for a confirmed session of the same person. */
        fun selects(personalUid: String?, confirmedUid: String?, ownerWorkUid: String?): Boolean =
            personalUid != null && personalUid == confirmedUid && personalUid == ownerWorkUid
    }
}

/** The Firestore the work layer uses: ownerWork for a confirmed Owner, the default otherwise. */
@Singleton
class WorkFirestore @Inject constructor(
    private val defaultFirestore: FirebaseFirestore,
    private val defaultAuth: FirebaseAuth,
    private val ownerWork: OwnerWorkFirebase,
) {
    fun current(): FirebaseFirestore =
        if (ownerWork.isConfirmedFor(defaultAuth.currentUser?.uid)) ownerWork.firestore else defaultFirestore
}
