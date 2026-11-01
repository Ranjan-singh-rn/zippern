package com.zipper.app.util

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.core.DataStore
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Where the quick-login secret lives.
 *
 * ── THE REQUIREMENT ──────────────────────────────────────────────────────────
 *
 * "you logout tap on quick signin it open the same logged in user what you
 * recently logged out even you clear of app data or try uninstall and reinstall
 * the app". That rules out every place an app can normally put something.
 * DataStore, SharedPreferences, the Firestore disk cache and Firebase's own
 * token store are all inside the app's data directory, and all four are erased
 * by "clear data" and by uninstall — which is exactly why a guest who
 * reinstalled came back as a stranger with a brand-new account.
 *
 * ── BLOCK STORE ──────────────────────────────────────────────────────────────
 *
 * Google Play Services keeps a small blob on the app's behalf, outside the app's
 * data directory, keyed to the app's signing certificate. It survives clearing
 * data, and survives uninstall and reinstall. Nothing else on Android does that
 * for an app that is not a device admin.
 *
 * ── CLOUD BACKUP IS NOW OFF, AND THAT IS THE POINT ──────────────────────────
 *
 * This used to pass `setShouldBackupToCloud(true)`, so the blob came across on a
 * device transfer. For a guest-recovery secret that was the feature. For a
 * quick-login credential it was a hole: the credential was a bearer secret, so
 * carrying its bytes to a new handset carried the ability to sign in as that
 * account.
 *
 * It is `false` now. The credential is meant to mean "the account most recently
 * signed out FROM THIS DEVICE", and a credential that rides a cloud backup to
 * the next phone does not mean that.
 *
 * The bytes are additionally no longer sufficient on their own: redemption
 * requires a signature from `DeviceKey`, whose private half lives in the Android
 * Keystore and cannot be exported or backed up at all. Turning cloud backup off
 * is therefore defence in depth rather than the whole defence — a blob that
 * somehow reached another handset would arrive without the key that signs for
 * it, and would authenticate nothing.
 *
 * ── WHY THERE IS A FALLBACK, AND WHAT IT IS WORTH ────────────────────────────
 *
 * Block Store needs Play Services, and some devices this ships to do not have a
 * working copy. DataStore is the fallback and it is honest about what it buys:
 * quick login across a sign-out, and nothing across an uninstall. Better than
 * refusing the feature on those handsets; not a substitute for the real thing.
 * [isDurable] says which one answered, so the UI never promises more than it can
 * deliver.
 *
 * ── WHAT IS ACTUALLY STORED ──────────────────────────────────────────────────
 *
 * A random 32-byte secret minted by `mintQuickLoginToken`, and the display name
 * and photo that go with it so the button can say "Continue as Rahul" without a
 * network call. The server holds only `sha256(secret)`, so this blob is the only
 * copy of the credential in existence — and losing it costs a convenience, not
 * an account: every other sign-in method still works.
 */
@Singleton
class QuickLoginStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val dataStore: DataStore<Preferences>,
) {

    data class Saved(
        val token: String,
        val displayName: String,
        val photoUrl: String,
    )

    private val client by lazy { Blockstore.getClient(context) }

    /**
     * True when Block Store is usable, i.e. when the secret will outlive an
     * uninstall.
     *
     * Checked rather than assumed: `isEndToEndEncryptionAvailable` is the
     * cheapest call that proves Play Services is present and answering.
     */
    suspend fun isDurable(): Boolean = try {
        client.isEndToEndEncryptionAvailable.await()
        true
    } catch (_: Exception) {
        false
    }

    /** Store the secret. Best-effort: a failure here costs a convenience, never a session. */
    suspend fun save(saved: Saved) {
        val blob = encode(saved)
        var stored = false
        try {
            client.storeBytes(
                StoreBytesData.Builder()
                    .setBytes(blob.toByteArray())
                    .setKey(KEY)
                    /*
                     * Cloud backup OFF. Deliberate, and the reason is in the
                     * class note: the credential must mean "the account most
                     * recently signed out from THIS device". A blob that rides a
                     * cloud backup onto the next handset does not mean that, and
                     * before the Keystore binding existed it was enough on its
                     * own to sign in as the account.
                     */
                    .setShouldBackupToCloud(false)
                    .build(),
            ).await()
            stored = true
        } catch (_: Exception) {
            // No Play Services, or Block Store refused. Fall through.
        }
        // Written to DataStore as well, always. On a device where Block Store
        // works this is a redundant copy that makes the common case (sign out,
        // sign back in, same install) answer without an IPC round trip.
        try {
            dataStore.edit { it[LOCAL] = blob }
        } catch (_: Exception) {
        }
        if (!stored) {
            // Nothing to do but note it. `isDurable()` is what the UI asks.
        }
    }

    /** The saved secret, or null. Block Store first, then the local copy. */
    suspend fun load(): Saved? {
        try {
            val req = RetrieveBytesRequest.Builder().setKeys(listOf(KEY)).build()
            val res = client.retrieveBytes(req).await()
            val bytes = res.blockstoreDataMap[KEY]?.bytes
            if (bytes != null && bytes.isNotEmpty()) {
                decode(String(bytes))?.let { return it }
            }
        } catch (_: Exception) {
        }
        return try {
            decode(dataStore.data.first()[LOCAL] ?: "")
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Forget the secret on this device.
     *
     * Called when the person deletes their account and when the server refuses
     * a token — NOT on an ordinary sign-out, because remembering across an
     * ordinary sign-out is the entire feature. (The explicit "sign out and
     * forget this device" row that also called it was removed, UGP-E2.)
     */
    suspend fun clear() {
        try {
            client.deleteBytes(
                DeleteBytesRequest.Builder().setKeys(listOf(KEY)).build(),
            ).await()
        } catch (_: Exception) {
        }
        try {
            dataStore.edit { it.remove(LOCAL) }
        } catch (_: Exception) {
        }
    }

    /*
     * A tab-separated triple rather than JSON.
     *
     * Block Store caps the blob at a few kilobytes and this has to stay well
     * inside that, but the real reason is that a parse failure here must never
     * throw — [decode] returns null and the user simply sees no quick-login
     * button. Tabs cannot appear in a base64url token, and the name and photo
     * are the last two fields, so a name containing anything at all is safe.
     */
    private fun encode(s: Saved): String =
        listOf(s.token, s.photoUrl, s.displayName.replace('\t', ' ')).joinToString("\t")

    private fun decode(raw: String): Saved? {
        if (raw.isBlank()) return null
        val parts = raw.split('\t')
        val token = parts.getOrNull(0)?.takeIf { it.length >= 16 } ?: return null
        return Saved(
            token = token,
            photoUrl = parts.getOrNull(1).orEmpty(),
            displayName = parts.getOrNull(2).orEmpty(),
        )
    }

    private companion object {
        /** Block Store is a key/value store shared by the app; one key is enough. */
        const val KEY = "zipper_quick_login_v1"
        val LOCAL = stringPreferencesKey("quick_login_v1")
    }
}
