package com.zipper.datingapp

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.StrictMode
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import coil.Coil
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.PersistentCacheSettings
import com.zipper.datingapp.BuildConfig
import com.zipper.datingapp.webrtc.IceConfigRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Process [Application] entry. Debug builds enable [StrictMode] to surface main-thread I/O.
 * WebRTC / PeerConnectionFactory init is deferred until go-live (see [WebRTCInitializer]).
 */
class DatingApp : Application() {

    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    companion object {
        /** [Application] context — set from [DatingApp.onCreate] for prefs / services without AndroidViewModel. */
        @Volatile
        var applicationContext: Context? = null
            private set

        /**
         * On-disk cap for remote lens content (not RAM). A larger value keeps more lenses on
         * device and avoids repeat downloads. Used when building
         * [com.snap.camerakit.Session] — see
         * [com.snap.camerakit.lenses.LensesComponent.Cache.Configuration.lensContentMaxSize].
         */
        const val SNAP_LENS_DISK_CACHE_MAX_BYTES: Long = 256L * 1024L * 1024L

        private const val GL_ES_3_0_HEX = 0x00030000

        /**
         * Camera Kit documents GLES 3.0+ for lens rendering. Call at startup so logs surface
         * devices that may show blank/white lens output.
         */
        fun logCameraKitGlesSupport(context: Context) {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
            val req = am.deviceConfigurationInfo.reqGlEsVersion
            val major = (req and 0xffff0000.toInt()) shr 16
            val minor = req and 0xffff
            if (req < GL_ES_3_0_HEX) {
                Log.w("DatingApp", "OpenGL ES on this device is below 3.0 (reported $major.$minor). Snap lenses may not render correctly.")
            } else {
                Log.d("DatingApp", "OpenGL ES $major.$minor (>= 3.0) — suitable for Camera Kit lens pipeline.")
            }
        }
    }

    override fun onCreate() {
        if (BuildConfig.DEBUG) {
            StrictMode.setThreadPolicy(
                StrictMode.ThreadPolicy.Builder()
                    .detectDiskReads()
                    .detectDiskWrites()
                    .detectNetwork()
                    .penaltyLog()
                    .build(),
            )
            StrictMode.setVmPolicy(
                StrictMode.VmPolicy.Builder()
                    .detectLeakedSqlLiteObjects()
                    .detectLeakedClosableObjects()
                    .penaltyLog()
                    .build(),
            )
        }
        super.onCreate()
        DatingApp.applicationContext = applicationContext

        // Enable Firestore disk persistence — data is served from cache instantly on subsequent
        // app starts and updated from the network in the background. Without this, every launch
        // fetches all profiles / messages / live-streams fresh from the network (slow cold start).
        try {
            FirebaseFirestore.getInstance().firestoreSettings =
                FirebaseFirestoreSettings.Builder()
                    .setLocalCacheSettings(PersistentCacheSettings.newBuilder().build())
                    .build()
        } catch (e: Exception) {
            Log.w("DatingApp", "Firestore persistence init failed", e)
        }
        // Production crash reports; disable in debug to keep the Crashlytics dashboard clean during development.
        runCatching {
            FirebaseCrashlytics.getInstance().isCrashlyticsCollectionEnabled = !BuildConfig.DEBUG
        }.onFailure { Log.w("DatingApp", "Crashlytics init", it) }
        logCameraKitGlesSupport(this)

        // Last-resort private-call signaling cleanup when the last Activity is destroyed (does not run on all kill paths).
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_DESTROY) {
                    LiveStreamActivity.onApplicationProcessLifecycleDestroyed()
                }
            },
        )

        Coil.setImageLoader(
            ImageLoader.Builder(this)
                .memoryCache {
                    MemoryCache.Builder(this)
                        .maxSizePercent(0.22)
                        .build()
                }
                .diskCache {
                    DiskCache.Builder()
                        .directory(cacheDir.resolve("coil_disk"))
                        .maxSizeBytes(384L * 1024 * 1024)
                        .build()
                }
                .build(),
        )

        applicationScope.launch {
            IceConfigRepository.refresh(applicationContext)
        }
    }
}