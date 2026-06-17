import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
    alias(libs.plugins.firebase.crashlytics)
}

// Optional release signing: create Datingapp/keystore.properties (gitignored) with:
// storeFile=path/to/release.jks  (relative to project root)
// storePassword=...
// keyAlias=...
// keyPassword=...
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    runCatching {
        keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
    }.onFailure {
        keystoreProperties.clear()
    }
}

// Snap Camera Kit (optional): `snap.cameraKitApiToken` + `snap.lensGroupId` in `local.properties`
val localProperties = Properties()
val localPropertiesFile = rootProject.file("local.properties")
if (localPropertiesFile.exists()) {
    runCatching { localPropertiesFile.inputStream().use { localProperties.load(it) } }
}
val snapCameraKitApiToken: String =
    localProperties.getProperty("snap.cameraKitApiToken", "").trim()
val snapLensGroupId: String =
    localProperties.getProperty("snap.lensGroupId", "").trim()
val agoraAppId: String =
    localProperties.getProperty("agoraAppId", "").trim()

android {
    namespace = "com.zipper.datingapp"
    // Keep in sync with current Play / device matrix (test PiP + live overlay on API 28–36+).
    compileSdk = 35

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    defaultConfig {
        applicationId = "com.zipper.datingapp"
        minSdk = 24
        targetSdk = 35
        versionCode = 3
        versionName = "1.0.2"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
        ndk {
            abiFilters.clear()
            abiFilters.addAll(listOf("armeabi-v7a", "arm64-v8a", "x86_64"))
        }

        val safeLensGroup = snapLensGroupId.replace("\\", "\\\\").replace("\"", "\\\"")
        val safeAgoraAppId = agoraAppId.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("boolean", "SNAP_CAMERA_KIT_CONFIGURED", "${snapCameraKitApiToken.isNotEmpty()}")
        buildConfigField("String", "SNAP_LENS_GROUP_ID", "\"$safeLensGroup\"")
        buildConfigField("String", "AGORA_APP_ID", "\"$safeAgoraAppId\"")
        /** Non-secret HTTPS URL that returns ICE JSON (see [IceConfigRepository]). Empty = STUN-only. */
        buildConfigField("String", "BACKEND_ICE_URL", "\"\"")

        manifestPlaceholders["snapCameraKitApiToken"] =
            snapCameraKitApiToken.ifEmpty { "" }
    }

    packaging {
        jniLibs {
            // All .so files are 16KB ELF-aligned (verified), so legacy packaging is not needed.
            // Removing useLegacyPackaging = true silences the Android 15 16KB page-size popup
            // and enables direct memory-mapping of libs from the APK (smaller RAM footprint).
            useLegacyPackaging = false
        }
    }

    // Prevent TFLite model files from being compressed in the APK (required for memory-mapped inference).
    androidResources {
        noCompress += "tflite"
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = true
        warningsAsErrors = false
    }

    // APK Signature Scheme: V1 (JAR) + V2 (required for reliable install on Android 7+) + V3/V4.
    signingConfigs {
        getByName("debug") {
            enableV1Signing = true
            enableV2Signing = true // v2Signing — required for modern package manager verification (Android 11+ expectations)
            enableV3Signing = true
            enableV4Signing = true
        }
        create("release") {
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            enableV4Signing = true
            if (keystorePropertiesFile.exists()) {
                val storeRelative = keystoreProperties.getProperty("storeFile")?.trim().orEmpty()
                if (storeRelative.isNotEmpty()) {
                    storeFile = rootProject.file(storeRelative)
                    storePassword = keystoreProperties.getProperty("storePassword") ?: ""
                    keyAlias = keystoreProperties.getProperty("keyAlias") ?: ""
                    keyPassword = keystoreProperties.getProperty("keyPassword") ?: ""
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            ndk {
                debugSymbolLevel = "SYMBOL_TABLE"
            }
            val releaseCfg = signingConfigs.getByName("release")
            val storePath = keystoreProperties.getProperty("storeFile")?.trim().orEmpty()
            val storeOk = keystorePropertiesFile.exists() &&
                storePath.isNotEmpty() &&
                rootProject.file(storePath).exists() &&
                releaseCfg.storeFile != null
            signingConfig = if (storeOk) releaseCfg else signingConfigs.getByName("debug")
        }
        debug {
            isMinifyEnabled = false
        }
    }
    
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
        }
    }
}

dependencies {
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.annotation)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.compose.material3.adaptive.navigation.suite)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation("com.google.accompanist:accompanist-permissions:0.36.0")
    // Firebase
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.analytics)
    implementation(libs.firebase.crashlytics)
    implementation("com.google.firebase:firebase-messaging")
    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.storage)
    implementation(libs.firebase.database)
    implementation(libs.firebase.functions)
    implementation(libs.lottie.compose)
    implementation(libs.play.services.coroutines)
    implementation(libs.play.services.auth)
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // WebRTC
    implementation(libs.webrtc)

    // Agora RTC (optional solo live video — disabled when AGORA_APP_ID is empty)
    implementation(libs.agora.rtc.full)

    // ExoPlayer Media3
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)

    // CameraX
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.video)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.camera.extensions)

    // Snap Camera Kit (lenses → WebRTC; requires API token from Snap Developer Portal)
    implementation(libs.snap.camerakit)
    implementation(libs.snap.camerakit.kotlin)
    implementation(libs.snap.camerakit.camerax)
    implementation(libs.snap.camerakit.lenses.bundle)

    // ML Kit Face Detection
    implementation(libs.mlkit.face.detection)
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    // TensorFlow Lite — gender classification model for Phase 4 verification
    implementation("org.tensorflow:tensorflow-lite:2.14.0")
    implementation("org.tensorflow:tensorflow-lite-support:0.4.4")
    
    // Graphics path
    implementation(libs.graphics.path)

    // Image Loading
    implementation(libs.coil.compose)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.cardview:cardview:1.0.0")
    implementation("com.google.android.material:material:1.12.0")

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
