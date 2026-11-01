import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
    alias(libs.plugins.google.services)
    alias(libs.plugins.firebase.crashlytics)
}

// ── Agora credentials ────────────────────────────────────────────────────────
// Nothing secret is stored in this file. Values come from
// zipper-app/local.properties (gitignored — the same file that holds sdk.dir):
//
//     agora.appId=<app id>
//     agora.appCertificate=<primary certificate>
//
// or, for CI, from the AGORA_APP_ID / AGORA_APP_CERTIFICATE environment
// variables. If a value is absent the build still succeeds with an empty
// string and a warning — it is never replaced by a baked-in default.
//
// The Primary Certificate signs RTC tokens. Tokens are minted server-side by
// Cloud Functions (AGORA_APP_CERTIFICATE in the functions runtime config), so a
// normal app build does not need it and it should not be shipped in a release
// APK — anything in BuildConfig is readable by anyone who unpacks the APK.
val localPropertiesFile = rootProject.file("local.properties")
val localProperties = Properties().apply {
    if (localPropertiesFile.exists()) localPropertiesFile.inputStream().use { load(it) }
}

fun agoraSecret(propertyKey: String, envKey: String): String =
    (localProperties.getProperty(propertyKey) ?: System.getenv(envKey) ?: "").trim()

val agoraAppId: String = agoraSecret("agora.appId", "AGORA_APP_ID")

if (agoraAppId.isEmpty()) {
    logger.warn(
        "WARNING: Agora App ID is not set. BuildConfig.AGORA_APP_ID will be empty and " +
            "live video will not connect. Set agora.appId in zipper-app/local.properties " +
            "or the AGORA_APP_ID environment variable."
    )
}

// ── Zipper API (the CRM's business core) — mobile parity ────────────────────
//
// The app's partner and staff work screens call the same permission-checked
// API the CRM calls, with a session exchanged from the Firebase sign-in.
//
//     zipper.apiBase=https://<host>          (zipper-app/local.properties)
//     ZIPPER_API_BASE=https://<host>          (environment, for CI)
//
// There is no staging project and the default host IS production, so the
// build types differ on purpose (A-18):
//   * release and prod — default to the production API host when nothing is
//               set. That host is the Hosting origin, `https://zipperlive.web.app`:
//               firebase.json rewrites `/api/**` to the Cloud Run service
//               `zipper-api` (asia-south1), the same origin the CRM calls
//               (DEPLOYMENT.md §8.5, `ZIPPER_API_BASE_URL`). The Cloud Run URL
//               itself would work too and skip the Hosting hop; the Hosting
//               origin is used because it is the stable, named one.
//   * debug   — defaults to EMPTY: the work screens say the API is not
//               configured and make no request. A developer opts in by setting
//               the property — to a local backend (backend/LOCAL_DEVELOPMENT.md)
//               for anything that writes.
// `zipper.apiBase` / `ZIPPER_API_BASE` override every build type.
val zipperApiBase: String =
    (localProperties.getProperty("zipper.apiBase") ?: System.getenv("ZIPPER_API_BASE") ?: "").trim().trimEnd('/')
val zipperApiBaseProduction = "https://zipperlive.web.app"
val zipperApiBaseRelease: String = zipperApiBase.ifEmpty { zipperApiBaseProduction }

android {
    namespace = "com.zipper.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.zipper.app"
        minSdk = 26
        targetSdk = 34

        // ── BUMP THIS ON EVERY OTA RELEASE ───────────────────────────────────
        //
        // It has been 1 since the first commit and has never been incremented,
        // because until now nothing read it. The OTA updater does: it compares
        // BuildConfig.VERSION_CODE against `versionCode` in
        // `appConfig/androidUpdate` and there is no other signal. A build cut
        // without bumping this is a build that:
        //
        //   * cannot be published — the publish script REFUSES a versionCode that
        //     is not strictly greater than the one already in the document, so
        //     the release stops there rather than silently replacing it, and
        //   * would be invisible if it somehow were — every handset already on
        //     versionCode 1 would compare 1 <= 1 and report "up to date".
        //
        // Deliberately still a manual number rather than derived from git or from
        // a CI counter. A local `assembleDebug` must produce the same versionCode
        // twice in a row so that installing over yesterday's build is testing the
        // change and not the updater, and a derived value makes every working-tree
        // build look like a new release to every device that has one.
        //
        // `versionName` is what the user reads (and what the dialog shows). This
        // is what the machine compares. Move both.
        //
        // 19 / 1.2.5 — the release candidate (2026-10-20). 18 / 1.2.4 is already
        // on testers' handsets as a debug build, so nothing at or below 18 could
        // replace it. 19 is also the first build that pins appeal ids and
        // reports its versionCode to the sign-in gate (D18): the forced-update
        // cutoff `minSupportedVersionCode` is set to it, never lower.
        //
        // 20 / 1.2.6 — APK 20 (2026-11-01): avatar compression + readable
        // errors (A-1/A-2), Agora uid + token renewal (A-6/A-7), per-minute
        // call UI, lucky combos, publicProfiles reads (A-8), level visibility,
        // the `prod` build type, updater verification (A-5/A-23) and the
        // session cut-off (A-9). Publish with `minSupportedVersionCode: 20` —
        // 19 still runs the ten-second tick loop against a server that bills
        // whole minutes and shows a price that no longer matches.
        versionCode = 20
        versionName = "1.2.6"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        // Agora credentials — supplied above from local.properties / environment.
        buildConfigField("String", "AGORA_APP_ID", "\"$agoraAppId\"")
        // The Primary Certificate is deliberately NOT a BuildConfig field: anything
        // in BuildConfig ships in the APK. Tokens are minted by Cloud Functions.

        // ── THE ABI RESTRICTION MOVED TO `splits` ────────────────────────────
        //
        // There was an `ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }`
        // here, and it is gone because AGP refuses to accept both:
        //
        //     Conflicting configuration : 'armeabi-v7a,arm64-v8a' in ndk
        //     abiFilters cannot be present when splits abi filters are set
        //
        // It is a rejection at configuration time, not a warning — the build
        // does not reach Kotlin compilation.
        //
        // Nothing is lost for the APK. `splits.abi` below does `reset()` then
        // `include("arm64-v8a", "armeabi-v7a")`, so exactly the same two
        // architectures are built and x86/x86_64 are still excluded — the
        // reason the filter existed. What changes is that they now land in two
        // APKs instead of one, which is the point.
        //
        // The one real difference is the .aab: `splits` does not govern a
        // bundle, so one built now would carry x86/x86_64 again. That costs
        // upload size and nothing else — `bundle { abi { enableSplit = true } }`
        // below means Play delivers a single matching ABI to each device, so no
        // user downloads a library their CPU cannot run. We do not ship a
        // bundle today. If that changes and the upload size matters, the answer
        // is to drop `splits` for that build and put `abiFilters` back, not to
        // try to have both.
    }

    // ── ONE APK PER ARCHITECTURE ─────────────────────────────────────────────
    //
    // `bundle { }` below only governs the .aab, which is Play. Everything here
    // is distributed as a sideloaded APK through the in-app updater, so the
    // bundle block does nothing for the people actually installing this.
    //
    // A single APK carried BOTH architectures: 50.4 MB of arm64 libraries and
    // 35.3 MB of the identical armeabi-v7a ones, out of 125 MB total. Every
    // phone can execute exactly one of those sets, so a third of every download
    // was libraries that device can never run — paid for on the user's data
    // plan, and again on every update.
    //
    // Splitting produces `app-arm64-v8a-<type>.apk` and
    // `app-armeabi-v7a-<type>.apk`. Nobody loses support: a 32-bit handset
    // still gets a build, it is simply no longer bundled with the 64-bit one.
    //
    // `isUniversalApk = false` on purpose. A universal APK is the old
    // everything-for-everyone artefact, and leaving it on means it is the one
    // somebody grabs by habit — reintroducing the whole problem silently.
    //
    // ── THE VERSION CODE IS DELIBERATELY NOT OFFSET ──────────────────────────
    //
    // The usual recipe adds an ABI-dependent offset (arm64 = base*10+2, and so
    // on) because the Play Store needs every uploaded APK to carry a distinct
    // code. Nothing here goes to Play, and the OTA updater compares the
    // device's VERSION_CODE against one number in `appConfig/androidUpdate`.
    // Offsetting would make an arm64 phone and a v7a phone disagree about
    // whether they are on the same release, for a constraint that does not
    // apply. The version is the RELEASE; the architecture is not part of it.
    //
    // If this ever does go to Play, use the .aab — `bundle { }` below already
    // handles the split properly and Play assigns the codes itself.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = false
        }
    }

    // Play delivers one ABI, one density and one language set per device from
    // an App Bundle. Without this the user installs every variant of everything.
    bundle {
        abi { enableSplit = true }
        density { enableSplit = true }
        language {
            // Keep every language in the base APK: the app ships Hindi, Tamil,
            // Telugu and more, and per-language splits arrive only after the
            // first launch — which is exactly when a new user picks a language.
            enableSplit = false
        }
    }

    // ── Release signing ──────────────────────────────────────────────────────
    //
    // There was no signingConfig at all, so `assembleRelease` produced an
    // unsigned APK — installable nowhere and uploadable nowhere. It also meant
    // there was no release SHA-1 to register in Firebase, which is what phone
    // OTP and Google Sign-In are verified against on a production build.
    //
    // The keystore is read from `local.properties` or the environment, the same
    // way the Agora credentials already are, and never from a file in the repo.
    // A signing key in version control is a key anybody who clones it can
    // publish an update with.
    //
    // Absent, the block is simply not created and `release` falls back to being
    // unsigned rather than failing the build — so a debug build on a machine
    // with no keystore still works.
    signingConfigs {
        val storePath = (localProperties.getProperty("release.storeFile")
            ?: System.getenv("RELEASE_STORE_FILE") ?: "").trim()
        if (storePath.isNotEmpty() && rootProject.file(storePath).exists()) {
            create("release") {
                storeFile = rootProject.file(storePath)
                storePassword = (localProperties.getProperty("release.storePassword")
                    ?: System.getenv("RELEASE_STORE_PASSWORD") ?: "").trim()
                keyAlias = (localProperties.getProperty("release.keyAlias")
                    ?: System.getenv("RELEASE_KEY_ALIAS") ?: "").trim()
                keyPassword = (localProperties.getProperty("release.keyPassword")
                    ?: System.getenv("RELEASE_KEY_PASSWORD") ?: "").trim()
            }
        } else {
            logger.warn(
                "WARNING: no release keystore configured, so `assembleRelease` will be " +
                    "UNSIGNED and cannot be installed or uploaded. Set release.storeFile, " +
                    "release.storePassword, release.keyAlias and release.keyPassword in " +
                    "zipper-app/local.properties — see the README section on release signing."
            )
        }
    }

    // ── OTA kill switch ──────────────────────────────────────────────────────
    //
    // One boolean guards the whole in-app updater: the Firestore read, the
    // download, the dialog and the Settings row. `UpdateRepository.check()`
    // returns UpToDate without touching the network when it is false, so nothing
    // downstream can run.
    //
    // WHY IT HAS TO EXIST RATHER THAN BEING DELETED LATER
    // GOOGLE PLAY POLICY FORBIDS AN APP UPDATING OR MODIFYING ITSELF BY ANY
    // METHOD OTHER THAN PLAY'S OWN UPDATE MECHANISM. This feature is for the
    // hand-shared team builds that exist because the app is not on Play yet. The
    // day a build is submitted, that build must be able to ship with the updater
    // inert — and "must be able to" means a one-line flag flip, not a revert of
    // several files under time pressure with a submission deadline.
    //
    // Declared per build type rather than once in defaultConfig on purpose: a new
    // build type then fails to compile with "OTA_ENABLED is not defined" instead
    // of silently inheriting true, which is the failure mode that matters here.
    //
    // Note that flipping this to false does NOT remove REQUEST_INSTALL_PACKAGES
    // from the merged manifest. A Play submission needs that line in
    // AndroidManifest.xml dealt with as well — see the comment on it there.
    //
    // ── OTA_CHANNEL — WHICH MAP OF `appConfig/androidUpdate` THIS BUILD READS ──
    //
    // The channel used to be derived from `BuildConfig.DEBUG`
    // (UpdateRepository.kt): debug → "debug", anything else → "release". That
    // was right while the only non-debug build was the release-keystore one.
    // The `prod` build type below is NOT debuggable and IS minified, but it is
    // signed with the DEBUG key — the fleet's only authenticity root, which
    // every installed handset already trusts and which cannot be changed
    // without `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on every phone (A-4) — so
    // it must keep reading the "debug" channel, where the publish script puts
    // debug-signed APKs. A string per build type says which, explicitly, and
    // a new build type fails to compile rather than inheriting a guess.
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }

            // True today because a release APK is still something a human mails
            // to a tester. Set false for anything going to Play.
            buildConfigField("boolean", "OTA_ENABLED", "true")
            buildConfigField("String", "OTA_CHANNEL", "\"release\"")
            buildConfigField("String", "ZIPPER_API_BASE", "\"$zipperApiBaseRelease\"")
        }
        debug {
            isMinifyEnabled = false
            buildConfigField("boolean", "OTA_ENABLED", "true")
            buildConfigField("String", "OTA_CHANNEL", "\"debug\"")
            // Opt-in only — see `zipperApiBase` above.
            buildConfigField("String", "ZIPPER_API_BASE", "\"$zipperApiBase\"")
        }
        /*
         * ── prod: WHAT THE FLEET SHOULD ACTUALLY RUN (A-4 / A-17 / A-18) ────
         *
         * Build 19 and everything before it went to the fleet as `debug`:
         * `debuggable=true` (so `adb run-as` reads the Firebase refresh token
         * and prefs, and Frida/JDWP can instrument the economy client without
         * root), unminified, FLAG_SECURE off. The reason was the key — the
         * fleet trusts the debug keystore and switching keys would strand every
         * guest account — not the build type.
         *
         * `prod` keeps the key and drops everything else: it inherits `release`
         * (minify, shrink, the proguard rules, OTA on, the production API
         * host), is explicitly NOT debuggable, and is signed with the DEBUG
         * signing config — the same `~/.android/debug.keystore` the debug build
         * uses, resolved by name so nothing about the identity changes here.
         * `BuildConfig.DEBUG` is therefore false in this build, which is also
         * what turns FLAG_SECURE on (MainActivity) and the diagnostic lines off.
         *
         * Publish `assembleProd` output to the "debug" channel of
         * `appConfig/androidUpdate` — see OTA_CHANNEL above — with
         * `publish_apk.py`, which accepts the debug CN. `versionCode` must be
         * bumped for every build that leaves the Mac (A-17); a prod build with
         * the number of an installed debug build is indistinguishable to the
         * updater.
         *
         * Verify on the Mac: `./gradlew :app:assembleProd`, then on the APK:
         * `apksigner verify --print-certs` must show the debug certificate,
         * `aapt dump badging` must NOT show `application-debuggable`, and the
         * app must run through sign-in, a live room, a call and a gift under
         * R8 before it is published — minification has never been exercised on
         * this app.
         */
        create("prod") {
            initWith(getByName("release"))
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // The DEBUG key, on purpose — see above. Never the release keystore.
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")

            buildConfigField("boolean", "OTA_ENABLED", "true")
            // The channel debug-signed APKs are published to.
            buildConfigField("String", "OTA_CHANNEL", "\"debug\"")
            // Production host by default; `zipper.apiBase` still overrides.
            buildConfigField("String", "ZIPPER_API_BASE", "\"$zipperApiBaseRelease\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false

            // Agora's full SDK ships every optional extension whether or not the
            // app initialises it — roughly 26 MB per ABI of native code that is
            // dead weight here. Excluded below; the beauty/enhancement extension
            // (clear_vision) is deliberately KEPT because hosts use it.
            //
            // If any of these features is ever built, delete its line and the
            // extension comes back. Nothing else needs to change.
            excludes += listOf(
                "**/libagora_lip_sync_extension.so",          // avatar lip-sync
                "**/libagora_spatial_audio_extension.so",     // 3D positional audio
                "**/libagora_segmentation_extension.so",      // virtual background
                "**/libagora_face_capture_extension.so",      // face tracking for avatars
                "**/libagora_audio_beauty_extension.so",      // voice changer
                "**/libagora_content_inspect_extension.so",   // Agora-side moderation
                "**/libagora_video_av1_encoder_extension.so",
                "**/libagora_video_av1_decoder_extension.so",
                "**/libagora_face_detection_extension.so",    // ML Kit does this
                "**/libagora_video_quality_analyzer_extension.so",
                "**/libagora_ai_echo_cancellation_ll_extension.so",
                "**/libagora_drm_loader_extension.so",
                "**/libagora_screen_capture_extension.so",
            )
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Core
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.profileinstaller)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)

    // Compose
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)

    // Navigation
    implementation(libs.androidx.navigation.compose)

    // Hilt
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    // Firebase
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.storage)
    implementation(libs.firebase.messaging)
    implementation(libs.firebase.crashlytics)
    implementation(libs.firebase.analytics)
    implementation(libs.firebase.functions)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services.auth)
    implementation(libs.googleid)

    // Agora
    implementation(libs.agora.rtc)

    // Coil
    implementation(libs.coil.compose)
    implementation(libs.coil.gif)
    implementation(libs.coil.video)

    // Media3 / ExoPlayer + video compression via Transformer
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.session)
    implementation(libs.media3.transformer)
    implementation(libs.media3.effect)

    // Lottie
    implementation(libs.lottie.compose)

    // CameraX
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.camerax.extensions)

    // DataStore
    implementation(libs.datastore.preferences)

    // bzip2, for the compressed blocks inside a bsdiff OTA patch (util/BsPatch.kt).
    implementation(libs.commons.compress)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    // GPUImage

    // Accompanist
    implementation(libs.accompanist.permissions)

    // Play Services Location
    implementation(libs.play.services.location)
    implementation(libs.play.services.auth.blockstore)

    // ML Kit
    implementation(libs.mlkit.face.detection)  // Play-Services variant: model downloaded on demand

    // ── Unit tests ────────────────────────────────────────────────────────────
    // Pure-JVM tests only. The economy arithmetic has no Android dependency, so
    // it runs on `./gradlew test` in seconds without an emulator.
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    // Firebase ML Model Downloader + TFLite
    implementation(libs.firebase.ml.modeldownloader)
    implementation(libs.tensorflow.lite)
}
