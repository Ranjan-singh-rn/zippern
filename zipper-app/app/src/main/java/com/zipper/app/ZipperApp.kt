package com.zipper.app

import android.app.Application
import android.os.Build
import coil.Coil
import coil.ImageLoader
import coil.decode.VideoFrameDecoder
import coil.disk.DiskCache
import coil.memory.MemoryCache
import coil.request.CachePolicy
import coil.util.DebugLogger
import com.google.firebase.FirebaseApp
import com.zipper.app.ui.components.DefaultAvatarMapper
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class ZipperApp : Application() {
    override fun onCreate() {
        // The `emu` build only (a compile-time no-op everywhere else): Firebase on
        // the local emulators, before Hilt creates anything that uses it.
        LocalEmulators.connectIfEmuBuild(this)
        super.onCreate()
        FirebaseApp.initializeApp(this)
        com.zipper.app.service.PushNotifications.createChannels(this)
        registerActivityLifecycleCallbacks(com.zipper.app.service.AppState)
        /*
         * Gift / entrance animations (Owner, 6 Nov 2026): download once, reuse from the phone after that.
         * SVGAPlayer only keeps what it downloads when it is given a FILE cache — its default relies on an
         * HttpResponseCache this app never installed, so every SVGA gift was fetched again each time it played.
         * Lottie URLs are already kept on disk by Lottie's own network cache (and in memory by composition).
         */
        runCatching { com.opensource.svgaplayer.SVGACache.onCreate(this, com.opensource.svgaplayer.SVGACache.Type.FILE) }

        /*
         * Image loading.
         *
         * The default loader keeps a small memory cache sized from the heap and
         * a 2% disk cache, which on a budget phone is a few tens of megabytes
         * shared with everything else — so avatars and gift artwork were being
         * evicted and re-downloaded on nearly every scroll. This app shows the
         * same few hundred images over and over (the feed, the gift drawer, the
         * live grid), which is exactly the case a generous disk cache is for.
         *
         * 25% of the available heap in memory, 256 MB on disk. Disk bytes are
         * cheap; the user's data plan is not.
         *
         * VideoFrameDecoder renders the first frame of a local video URI, used
         * by the gallery picker before anything is uploaded.
         */
        Coil.setImageLoader(
            ImageLoader.Builder(this)
                .components {
                    /*
                     * `photoUrl = "avatar:fox"` — one of the built-in default
                     * avatars handed out at profile setup. See
                     * ui/components/DefaultAvatars.kt.
                     *
                     * It is resolved HERE rather than at each call site on
                     * purpose. Over twenty screens hand a raw `photoUrl` to an
                     * AsyncImage — Discover cards, chat rows, the live grid, the
                     * call screens, the PK overlay — and any one of them that
                     * forgot would try to fetch "avatar:fox" as a URL, fail, and
                     * leave an empty circle. Registered on the shared loader, a
                     * default avatar renders everywhere an uploaded photo does,
                     * with no other file needing to know the convention exists.
                     *
                     * Order matters: user mappers run before Coil's built-ins,
                     * so the Int this returns is picked up by Coil's own
                     * ResourceIntMapper on the next pass.
                     */
                    add(DefaultAvatarMapper(), String::class.java)
                    add(VideoFrameDecoder.Factory())
                }
                .memoryCache {
                    MemoryCache.Builder(this)
                        .maxSizePercent(0.25)
                        .build()
                }
                .diskCache {
                    DiskCache.Builder()
                        .directory(cacheDir.resolve("image_cache"))
                        .maxSizeBytes(256L * 1024 * 1024)
                        .build()
                }
                .memoryCachePolicy(CachePolicy.ENABLED)
                .diskCachePolicy(CachePolicy.ENABLED)
                // Bitmaps at half precision: an avatar does not need 32-bit
                // colour, and RGB_565 halves the memory every image occupies.
                .allowRgb565(Build.VERSION.SDK_INT < 26)
                .crossfade(150)
                .apply { if (BuildConfig.DEBUG) logger(DebugLogger()) }
                .build()
        )
    }
}
