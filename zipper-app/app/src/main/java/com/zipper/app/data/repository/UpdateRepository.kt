package com.zipper.app.data.repository

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.BuildConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads `appConfig/androidUpdate` and decides whether this build is behind.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Builds are hand-shared. Somebody cuts an APK, drops it in a chat, and every
 * tester is on whatever they happened to install. There is no way to tell a
 * handset it is three builds old, and no way at all to stop a build that is
 * known broken from still being used a week later. This is that channel.
 *
 * ── THE DOCUMENT ─────────────────────────────────────────────────────────────
 *
 * One map per channel, written by the publish script:
 *
 *     appConfig/androidUpdate
 *       release: { versionCode, versionName, notes, mandatory,
 *                  minSupportedVersionCode, publishedAt,
 *                  abis: { "arm64-v8a":   { url, sha256, sizeBytes, patches },
 *                          "armeabi-v7a": { url, sha256, sizeBytes, patches } },
 *                  url, sha256, sizeBytes }
 *       debug:   { ...same shape... }
 *
 * ── THE `patches` MAP ────────────────────────────────────────────────────────
 *
 *     patches: { "4": { url, sha256, sizeBytes },     // patch 4 → this build
 *                "3": { url, sha256, sizeBytes } }    // patch 3 → this build
 *
 * The KEY is the SOURCE versionCode as a string; the entry describes a bsdiff
 * patch that rebuilds this release's APK from that one. `patches` may be absent
 * or empty and usually is — that is not an error, it means "download the whole
 * thing", which is what every install did before delta updates existed.
 *
 * It lives inside the per-ABI entry because a patch is only valid against the
 * exact binary it was generated from, and the binary on a given handset is the
 * split for that handset's CPU. A patch keyed only by version would be applied
 * to an arm64 APK on one phone and an armeabi-v7a APK on another, and at most
 * one of those can be right.
 *
 * `sha256` inside a patch entry is the hash of THE PATCH FILE — it proves the
 * download arrived intact and nothing more. What the patch produces is checked
 * separately, against the outer `sha256` of the full APK. See
 * [com.zipper.app.util.ApkInstaller] for why both checks are required.
 *
 * ── WHY THERE IS AN `abis` MAP *AND* FLAT url/sha256/sizeBytes ───────────────
 *
 * The app is built as one APK per architecture (see `splits { abi { … } }` in
 * app/build.gradle.kts). A single APK carried 50.4 MB of arm64-v8a libraries
 * AND 35.3 MB of the identical armeabi-v7a ones; every handset can execute
 * exactly one of those sets, so a third of every download was libraries that
 * device can never run.
 *
 * That saving only exists if this repository hands back the build matching the
 * CPU. Handing back the wrong one is worse than handing back nothing: the APK
 * installs perfectly — same package, same signature, same versionCode — and
 * then dies the first time anything touches the Agora native libraries, with an
 * UnsatisfiedLinkError nobody holding the phone can act on. A failed install at
 * least leaves a working app on the handset.
 *
 * The flat `url`/`sha256`/`sizeBytes` are kept, still written, and still read
 * here. They carry the arm64 build. They are not dead weight: EVERY BUILD
 * ALREADY INSTALLED ON A HANDSET READS ONLY THE FLAT SHAPE. Dropping them from
 * the document would strand every existing install on whatever version it is on
 * — it would see a document with no `url` at all, parse nothing, and report "up
 * to date" for ever, with no route forward except somebody sideloading an APK by
 * hand. The flat fields stay until the estate has moved on, and [selectArtifact]
 * reads them as the fallback for a document that has no `abis` map.
 *
 * ── WHY THERE ARE TWO CHANNELS AT ALL ────────────────────────────────────────
 *
 * This is the constraint the whole feature is built around, so it is written
 * down here rather than left to be rediscovered.
 *
 * A debug APK is signed with the debug keystore. A release APK is signed with
 * `zipper-release.jks`. `applicationId` is `com.zipper.app` for BOTH — there is
 * no `applicationIdSuffix` on the debug build type — so as far as Android is
 * concerned they are the same package, and the same package cannot be installed
 * twice on one device.
 *
 * Android refuses to replace an installed package with an APK signed by a
 * different key. The install fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE, and
 * it fails at the very LAST step: after the document has been read, after tens
 * of megabytes have come down the user's data plan, after the hash has been
 * verified, after they have granted "install unknown apps". The error names no
 * cause a person can act on, and the only fix is uninstalling the app — which,
 * for this app, means losing the account on any handset that signed in as a
 * guest.
 *
 * So the channel is read from [BuildConfig.DEBUG] and the other channel is
 * never touched. Not a preference, not a remote flag, not a field on the
 * document: the one thing that cannot be wrong about which key signed the
 * running build is the build type that produced it.
 *
 * ── A FAILED CHECK IS "UP TO DATE" ───────────────────────────────────────────
 *
 * Every failure path in here returns [UpdateCheck.UpToDate]. No exception
 * escapes, and there is no error state for the UI to render. A missing
 * document, a field of the wrong type, no network, a Firestore rule that
 * changes — none of them may put a dialog between a person and the app. An
 * update check that can lock someone out is a worse outage than the stale build
 * it was meant to replace.
 */
@Singleton
class UpdateRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
    @ApplicationContext private val context: Context,
) {

    /**
     * The versionCode of the APK that is actually installed.
     *
     * ── WHY NOT BuildConfig.VERSION_CODE ────────────────────────────────────
     *
     * Because it lies. `BuildConfig.VERSION_CODE` is a `const`, and Kotlin
     * inlines constants into every call site at compile time. Bumping the
     * version in `build.gradle.kts` regenerates BuildConfig, but incremental
     * compilation only recompiles files it believes changed — so any file that
     * merely READS the constant keeps the value it was last compiled against,
     * indefinitely.
     *
     * This was not theoretical. The login screen displayed `v1.0.4 (5)` while
     * Android's own app settings showed 1.0.7 for the same install, because the
     * file drawing it had not been edited since version 1.0.4. This class was
     * in the same state — which means the updater was comparing the published
     * build against a version the phone stopped being several releases ago. It
     * therefore believed an update was always available, and asked for the
     * patch belonging to a build that was no longer installed: a patch applied
     * to the wrong source APK reconstructs the wrong bytes, fails its hash
     * check, and silently falls back to the full download. Every symptom of
     * that is indistinguishable from a broken network.
     *
     * `PackageManager` reports what is installed, now, on this device. It
     * cannot be stale because it is not compiled into anything.
     */
    private val installedVersionCode: Long by lazy {
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            PackageInfoCompat.getLongVersionCode(info)
        } catch (_: PackageManager.NameNotFoundException) {
            // Cannot happen — this is our own package — but a thrown exception
            // here would break the update check entirely, and the check must
            // never be the thing that stops somebody updating. 0 means "behind
            // everything", so the worst case is offering an update and letting
            // the install decide.
            0L
        }
    }

    /**
     * One channel's published build, after every field has survived parsing.
     *
     * [url], [sha256] and [sizeBytes] describe ONE APK: the one picked for this
     * handset's CPU by [selectArtifact]. They stay flat on this class rather
     * than becoming a map of every architecture, because nothing downstream has
     * any business choosing again — [com.zipper.app.util.ApkInstaller] downloads
     * a url, hashes it against a sha256 and checks a length, and the dialog
     * shows a size. All three are already the right ones by the time they get
     * here, which is also why none of those callers needed changing when the
     * build was split per architecture.
     */
    data class UpdateInfo(
        val versionCode: Long,
        val versionName: String,
        /** Where this handset's APK is. https only — see [artifact]. */
        val url: String,
        /** Lowercase hex, 64 characters, of that APK's bytes. Checked before install. */
        val sha256: String,
        /**
         * That APK's size. The selected architecture's — an arm64 phone is told
         * the arm64 build's size, not some other build's, because this is the
         * number the dialog shows somebody deciding whether to spend it.
         */
        val sizeBytes: Long,
        /** What changed. May be empty; the dialog copes. */
        val notes: String,
        val mandatory: Boolean,
        val minSupportedVersionCode: Long,
        /**
         * The binary patch that turns the build THIS handset is running into the
         * APK above, or null when the publisher did not generate one for this
         * version (the normal case for an old install, and for the first build
         * after the feature shipped).
         *
         * Already resolved, for the same reason [url] is: the document carries a
         * patch per source versionCode, the running versionCode is known here,
         * and nothing downstream has any business choosing again. Defaulted so
         * that every existing construction site still compiles — a caller that
         * does not know about patches gets the full download, which is correct.
         */
        val patch: Patch? = null,
    ) {
        /**
         * One binary patch: where it is, what the PATCH FILE must hash to, how
         * big it is.
         *
         * [sha256] is the hash of the patch itself and proves only that the
         * download arrived intact. It says nothing about what applying it
         * produces — that is checked separately against [UpdateInfo.sha256], the
         * full APK's hash. Both checks are required and neither substitutes for
         * the other.
         */
        data class Patch(
            val url: String,
            val sha256: String,
            val sizeBytes: Long,
        )

        /**
         * What the user is actually asked to spend: the patch when there is one,
         * the whole APK otherwise.
         *
         * The dialog shows this rather than [sizeBytes], because the number on
         * the "Update" button should be the number that leaves their data
         * balance. [sizeBytes] is still the honest worst case — a patch that
         * fails to apply falls back to the full download — so the dialog says so
         * out loud when a patch is on offer.
         */
        val downloadSizeBytes: Long get() = patch?.sizeBytes ?: sizeBytes
    }

    sealed interface UpdateCheck {
        /**
         * Nothing to do — and also what every failure looks like. Deliberately
         * indistinguishable, because nothing downstream should behave
         * differently for the two.
         */
        data object UpToDate : UpdateCheck

        /** Newer build exists. The dialog offers Update and Later. */
        data class Available(val info: UpdateInfo) : UpdateCheck

        /**
         * Newer build exists and this one may not keep running.
         *
         * Either the publisher marked the build `mandatory`, or this build is
         * below `minSupportedVersionCode` — a floor the server raises when an
         * older client starts doing something actively wrong (writing a field
         * the backend no longer accepts, holding a call open that it can no
         * longer bill). The dialog for this has no Later and no way out.
         */
        data class Required(val info: UpdateInfo) : UpdateCheck
    }

    /**
     * Read the document, pick the channel, decide.
     *
     * Suspending and one-shot rather than a snapshot listener, unlike
     * [DailyRewardsConfigRepository]: this is asked once per launch and the
     * answer is acted on immediately. A live listener would mean a release
     * published mid-session could raise a blocking dialog over a video call.
     */
    suspend fun check(): UpdateCheck {
        // The kill switch, checked before anything else — no read, no parse, no
        // dialog. See `OTA_ENABLED` in app/build.gradle.kts for why a Play build
        // must be able to turn this off without touching code.
        if (!BuildConfig.OTA_ENABLED) return UpdateCheck.UpToDate

        return try {
            val doc = firestore.collection("appConfig").document("androidUpdate").get().await()
            if (!doc.exists()) return UpdateCheck.UpToDate

            // THE ONLY PLACE THE CHANNEL IS CHOSEN. See the class comment: a
            // debug build offered the release APK would fail to install after a
            // complete download, with an OS error nobody can act on.
            val channel = if (BuildConfig.DEBUG) CHANNEL_DEBUG else CHANNEL_RELEASE

            @Suppress("UNCHECKED_CAST")
            val map = doc.get(channel) as? Map<String, Any?> ?: return UpdateCheck.UpToDate

            val info = parse(map) ?: return UpdateCheck.UpToDate
            classify(info)
        } catch (_: Exception) {
            // Network, permissions, a malformed document that got past `as?` —
            // all of it is "no update". See the class comment.
            UpdateCheck.UpToDate
        }
    }

    /**
     * Compare against the running build.
     *
     * Internal rather than private so the decision can be exercised by a test
     * without a Firestore instance.
     */
    internal fun classify(info: UpdateInfo): UpdateCheck {
        val running = installedVersionCode
        if (info.versionCode <= running) return UpdateCheck.UpToDate
        val forced = info.mandatory || running < info.minSupportedVersionCode
        return if (forced) UpdateCheck.Required(info) else UpdateCheck.Available(info)
    }

    /**
     * Turn the raw map into an [UpdateInfo], or null if anything at all is off.
     *
     * Null on the first thing that does not make sense, rather than a partial
     * object with defaults filled in. Everything in here feeds either a download
     * or an integrity check, and there is no field whose absence is survivable:
     * a missing `sha256` would mean installing an unverified APK, no usable
     * artifact means there is nothing to install, and a missing `versionCode`
     * means there is no way to know whether this is even an upgrade.
     *
     * That is the opposite of how the other config repositories parse — they
     * degrade to a compiled-in fallback so a screen still renders. There is no
     * sensible fallback for "which binary should this phone install", which is
     * also why [selectArtifact] answers null rather than guessing.
     */
    private fun parse(map: Map<String, Any?>): UpdateInfo? {
        val versionCode = long(map["versionCode"]) ?: return null
        if (versionCode <= 0L) return null

        val versionName = (map["versionName"] as? String)?.trim().orEmpty()
        if (versionName.isEmpty()) return null

        // WHICH BINARY THIS HANDSET GETS. Null when neither the per-ABI map nor
        // the flat fields yielded a complete one, and null here means the whole
        // check reports UpToDate — never an UpdateInfo with a url from one
        // architecture and a hash from another, and never one with a blank url
        // that ApkInstaller would discover at download time.
        val artifact = selectArtifact(map) ?: return null

        val notes = (map["notes"] as? String)?.trim().orEmpty()   // may legitimately be empty
        val mandatory = map["mandatory"] as? Boolean ?: false

        // Absent means "no floor", not "block everyone". A publish that forgot
        // the field must not force every install on the estate.
        val minSupported = long(map["minSupportedVersionCode"]) ?: 0L

        return UpdateInfo(
            versionCode = versionCode,
            versionName = versionName,
            url = artifact.url,
            sha256 = artifact.sha256,
            sizeBytes = artifact.sizeBytes,
            notes = notes,
            mandatory = mandatory,
            minSupportedVersionCode = minSupported,
            // THE OTHER THING THIS HANDSET GETS TO PICK, and the last one. The
            // map is keyed by the SOURCE versionCode, so the only entry that can
            // possibly apply is the one for the build that is running. A missing
            // key is the common case and costs nothing: no patch means the full
            // download, which is what every install did before this existed.
            patch = artifact.patches[installedVersionCode],
        )
    }

    /**
     * One downloadable APK: where it is, what it must hash to, how big it is,
     * and the patches that can produce it.
     *
     * Private and never handed out. By the time anything outside this class sees
     * an [UpdateInfo] the architecture has been decided, and there is nothing a
     * caller could usefully do with the builds it did not pick.
     */
    private data class Artifact(
        val url: String,
        val sha256: String,
        val sizeBytes: Long,
        /**
         * Keyed by SOURCE versionCode — "patch me FROM 4" — so a handset looks
         * up its own installed versionCode and either finds a patch or does
         * not. Empty is normal: absent, malformed, or simply not generated yet.
         */
        val patches: Map<Long, UpdateInfo.Patch> = emptyMap(),
    )

    /**
     * Pick the APK this CPU can actually execute.
     *
     * ── WALKING `Build.SUPPORTED_ABIS` IN ORDER IS THE WHOLE ALGORITHM ───────
     *
     * That array is the device's OWN preference list, most capable first: an
     * arm64 handset reports ["arm64-v8a", "armeabi-v7a", "armeabi"], a 32-bit
     * one reports ["armeabi-v7a", "armeabi"]. Taking the first entry that the
     * document publishes therefore prefers the 64-bit build on a 64-bit phone
     * and falls back, by itself, to the 32-bit build that same phone can also
     * run — without this code ranking anything.
     *
     * A hardcoded preference ("arm64 if present, else armeabi-v7a") was
     * rejected. It would be a second opinion about which architectures exist and
     * which is better, maintained here, in a repository, against a list the OS
     * already publishes and gets right for hardware this code has never heard
     * of. Everything in SUPPORTED_ABIS is by definition executable on this
     * device, so anything this loop returns is safe to install; a list we wrote
     * ourselves has no such guarantee.
     *
     * ── FALLING BACK TO THE FLAT FIELDS ─────────────────────────────────────
     *
     * A document with no `abis` map is one written before the build was split,
     * or by a publish script that was rolled back. Its flat `url`/`sha256`/
     * `sizeBytes` are the only thing it has, and they are read here for the same
     * reason the publish script still writes them: the builds already installed
     * on people's phones read ONLY the flat shape, so both shapes have to stay
     * live until the estate has moved on. See the class comment.
     */
    private fun selectArtifact(channel: Map<String, Any?>): Artifact? {
        @Suppress("UNCHECKED_CAST")
        val abis = channel["abis"] as? Map<String, Any?>

        if (abis != null) {
            for (abi in deviceAbis()) {
                @Suppress("UNCHECKED_CAST")
                val entry = abis[abi] as? Map<String, Any?> ?: continue
                // Validated, not merely present. A matched-but-broken entry
                // keeps walking rather than stopping, because every remaining
                // ABI in the list is one this same device can also execute — so
                // a usable later entry is a real update, where giving up here
                // would be no update at all for a fault in the document.
                artifact(entry)?.let { return it }
            }
        }

        return artifact(channel)
    }

    /**
     * The three fields that describe one APK, or null if any of them is off.
     *
     * Deliberately ONE function called from both sides of [selectArtifact]: a
     * per-ABI entry and the flat fields carry the same three keys and must be
     * held to exactly the same standard. Validating the new shape separately
     * would be the obvious place for the two to drift — an `abis` entry that
     * skipped the hash check would be an unverified APK installed with consent
     * the user gave this app, which is the one thing the whole download path is
     * built to prevent.
     */
    private fun artifact(map: Map<String, Any?>): Artifact? {
        val url = (map["url"] as? String)?.trim().orEmpty()
        // https only, and non-blank by implication. The SHA-256 below is the
        // real defence — a swapped binary fails the hash whatever carried it —
        // but there is no reason to let a plaintext URL leak which of our
        // testers is downloading what, and a cleartext request would need a
        // network-security exception this app does not have anyway.
        if (!url.startsWith("https://")) return null

        val sha256 = (map["sha256"] as? String)?.trim()?.lowercase().orEmpty()
        // Shape-checked here so a truncated or placeholder hash is caught while
        // it still costs nothing, rather than after a 48 MB download.
        if (!SHA256_HEX.matches(sha256)) return null

        val sizeBytes = long(map["sizeBytes"]) ?: return null
        if (sizeBytes <= 0L) return null

        return Artifact(
            url = url,
            sha256 = sha256,
            sizeBytes = sizeBytes,
            patches = patches(map["patches"]),
        )
    }

    /**
     * The `patches` sub-map, keyed by source versionCode.
     *
     * ── A BROKEN ENTRY IS DROPPED, NOT FATAL ────────────────────────────────
     *
     * This is the one place in this file that degrades instead of returning
     * null, and the asymmetry is the point. A missing or malformed `url` on the
     * APK means there is nothing to install; a malformed patch entry means one
     * shortcut is unavailable and the full download — which is the only thing
     * that existed before — still works. Refusing the whole update because a
     * patch for some OTHER version is misspelt would turn an optimisation into
     * an outage.
     *
     * ── HELD TO EXACTLY THE SAME STANDARD AS THE APK ────────────────────────
     *
     * Each entry goes back through [artifact], so https-only, 64-char lowercase
     * hex sha256 and a positive size are checked identically. A patch is
     * decompressed and turned into an APK that is then installed with the
     * user's "install unknown apps" consent, so it is not a lesser object that
     * deserves lesser checking. (The recursion terminates immediately: a patch
     * entry has no `patches` key of its own, and Firestore caps map nesting at
     * 20 levels regardless.)
     *
     * Absent or empty is NORMAL and means "full download" — the first build
     * after this shipped has no patches, and neither does one published from a
     * machine without the bsdiff tool.
     */
    private fun patches(raw: Any?): Map<Long, UpdateInfo.Patch> {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?> ?: return emptyMap()
        if (map.isEmpty()) return emptyMap()

        val out = HashMap<Long, UpdateInfo.Patch>(map.size)
        for ((key, value) in map) {
            // The KEY is the source versionCode, as a string, because Firestore
            // map keys are always strings. A key that is not a number is a
            // publish-side mistake and cannot match any running build anyway.
            val from = key.trim().toLongOrNull() ?: continue
            if (from <= 0L) continue

            @Suppress("UNCHECKED_CAST")
            val entry = value as? Map<String, Any?> ?: continue
            val validated = artifact(entry) ?: continue

            out[from] = UpdateInfo.Patch(
                url = validated.url,
                sha256 = validated.sha256,
                sizeBytes = validated.sizeBytes,
            )
        }
        return out
    }

    /**
     * This device's executable ABIs, most capable first.
     *
     * Wrapped rather than read inline: `SUPPORTED_ABIS` is a Java field with no
     * Kotlin nullability, and on the stub `android.jar` that JVM unit tests link
     * against every `Build` member throws instead of returning a value. Either
     * way this degrades to an empty list, which sends [selectArtifact] down the
     * flat-field path — the same route a pre-split document takes — rather than
     * turning an update check into a crash.
     */
    private fun deviceAbis(): List<String> =
        runCatching { Build.SUPPORTED_ABIS?.filterNotNull().orEmpty() }.getOrDefault(emptyList())

    /**
     * Firestore hands a whole number back as Long, and anything that went
     * through JavaScript on the way in can arrive as Double. Read what turned
     * up rather than assuming — the same bridge [DailyRewardsConfigRepository]
     * makes.
     */
    private fun long(v: Any?): Long? = when (v) {
        is Number -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    companion object {
        const val CHANNEL_DEBUG = "debug"
        const val CHANNEL_RELEASE = "release"
        private val SHA256_HEX = Regex("^[0-9a-f]{64}$")
    }
}
