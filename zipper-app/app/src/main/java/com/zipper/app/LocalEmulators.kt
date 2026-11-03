package com.zipper.app

import android.app.Application
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.storage.FirebaseStorage

/**
 * The `emu` build type's wiring to the LOCAL test copy of Zipper — nothing else.
 *
 * `BuildConfig.USE_FIREBASE_EMULATORS` is a compile-time `false` in debug,
 * release and prod, so [connectIfEmuBuild] returns on its first line there and
 * R8 removes the rest from the prod APK. Only `./gradlew :app:assembleEmu`
 * produces a build that runs it.
 *
 * In that build:
 *  * the default FirebaseApp is created HERE (src/emu/AndroidManifest.xml removes
 *    FirebaseInitProvider) from google-services.json's values with the project
 *    id replaced by `demo-zipper` — the id the local Firebase emulators, the
 *    local Functions and the local backend all use. A demo- project exists only
 *    inside the emulators, so a request that missed an emulator could not reach
 *    a real project either;
 *  * Auth, Firestore, Storage and Functions (Mumbai and default region) are
 *    pointed at the emulators on the Android emulator's host alias.
 *
 * Must run before anything touches Firebase: ZipperApp calls it before
 * `super.onCreate()`, i.e. before Hilt creates a single repository.
 */
object LocalEmulators {
    private const val TAG = "LocalEmulators"

    fun connectIfEmuBuild(app: Application) {
        if (!BuildConfig.USE_FIREBASE_EMULATORS) return
        val host = BuildConfig.EMULATOR_HOST
        val project = BuildConfig.EMULATOR_PROJECT_ID
        if (FirebaseApp.getApps(app).isEmpty()) {
            val fromJson = FirebaseOptions.fromResource(app)
                ?: error("google-services values missing — cannot build the emulator FirebaseOptions")
            val options = FirebaseOptions.Builder(fromJson)
                .setProjectId(project)
                .setStorageBucket("$project.appspot.com")
                .build()
            FirebaseApp.initializeApp(app, options)
        }
        FirebaseAuth.getInstance().useEmulator(host, 9099)
        // The Auth emulator issues phone codes itself (readable from its REST API); no
        // reCAPTCHA / Play Integrity round trip, which a test emulator cannot pass anyway.
        FirebaseAuth.getInstance().firebaseAuthSettings.setAppVerificationDisabledForTesting(true)
        FirebaseFirestore.getInstance().useEmulator(host, 8080)
        FirebaseStorage.getInstance().useEmulator(host, 9199)
        FirebaseFunctions.getInstance("asia-south1").useEmulator(host, 5001)
        FirebaseFunctions.getInstance().useEmulator(host, 5001)
        Log.w(TAG, "LOCAL TEST COPY: Firebase emulators on $host (project $project), API ${BuildConfig.ZIPPER_API_BASE}")
    }
}
