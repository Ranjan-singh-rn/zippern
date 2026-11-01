package com.zipper.app.di

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.firestoreSettings
import com.google.firebase.firestore.persistentCacheSettings
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.storage.FirebaseStorage
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object FirebaseModule {

    @Provides
    @Singleton
    fun provideFirebaseAuth(): FirebaseAuth = FirebaseAuth.getInstance()

    @Provides
    @Singleton
    fun provideFirestore(): FirebaseFirestore {
        return FirebaseFirestore.getInstance().also { db ->
            try {
                db.firestoreSettings = firestoreSettings {
                    setLocalCacheSettings(persistentCacheSettings { })
                }
            } catch (_: IllegalStateException) {
                // Firestore already started (e.g. by Firebase auto-init before Hilt ran).
                // Settings are already applied or defaults are fine — safe to continue.
            }
        }
    }

    @Provides
    @Singleton
    fun provideStorage(): FirebaseStorage = FirebaseStorage.getInstance()

    /**
     * Cloud Functions, pinned to Mumbai.
     *
     * `getInstance()` with no argument talks to **us-central1**. Every callable
     * in this project is deployed to `asia-south1`, so the default instance
     * returns NOT_FOUND for all of them — and the error names the function, not
     * the region, so it reads like a deployment failure rather than a
     * misconfiguration.
     *
     * The region also matters for cost and feel: callers are in India, and
     * us-central1 adds roughly 200ms per round trip. Invisible on a token
     * fetch, material on `tickCall`, which fires every ten seconds for the
     * entire length of a call.
     */
    @Provides
    @Singleton
    fun provideFunctions(): FirebaseFunctions = FirebaseFunctions.getInstance("asia-south1")
}
