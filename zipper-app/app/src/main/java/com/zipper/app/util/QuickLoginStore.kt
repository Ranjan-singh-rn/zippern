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
 *
 * ── B10: SEVERAL ACCOUNTS (the account switcher) ─────────────────────────────
 *
 * One such entry per account signed in on this device, up to [MAX_ACCOUNTS],
 * each under its own key, plus the single "most recent" entry the login
 * button has always read. All of them are signed for by the same Keystore
 * key, and every rule above holds for each: no cloud backup, useless without
 * the key, rotated on every use, thirty days unused and it is dead. Removing
 * one account removes that account's entry only.
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
        /** B10: whose credential this is — the account switcher lists one row per uid. "" for an old blob. */
        val uid: String = "",
        val savedAtMs: Long = 0L,
    ) {
        /**
         * B10: never the secret. A data class prints every field, so one `Log.d("$saved")` or one crash report
         * with this in it would have carried a live credential off the phone.
         */
        override fun toString(): String =
            "Saved(uid=$uid, displayName=$displayName, photoUrl=$photoUrl, savedAtMs=$savedAtMs, token=<redacted>)"
    }

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
        // B10: every account signed in on this device keeps its own entry (the switcher's list), as well as the
        // single "most recent" one the login screen's button has always used.
        if (saved.uid.isNotBlank()) saveAccount(saved)
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

    /**
     * The most recent saved secret, or null. Block Store first, then the local copy — and (B10) when that single
     * slot has been emptied by removing its account, the most recently used of the accounts still remembered.
     */
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
        val local = try {
            decode(dataStore.data.first()[LOCAL] ?: "")
        } catch (_: Exception) {
            null
        }
        return local ?: loadAll().firstOrNull()
    }

    // ── B10 (3 Nov 2026): every account on this device, for the account switcher ──────────────────────────────
    //
    // One Block Store entry per account (`zq_acct_<uid>`) — retrieved together with `setRetrieveAll` — plus the
    // same list in DataStore for devices without Play Services. Up to [MAX_ACCOUNTS]; adding one more forgets the
    // least recently used. The secrets themselves never reach the UI: the switcher sees names, photos and uids.

    private fun accountKey(uid: String) = "$ACCOUNT_PREFIX$uid"

    private suspend fun saveAccount(saved: Saved) {
        val entry = saved.copy(savedAtMs = if (saved.savedAtMs > 0) saved.savedAtMs else System.currentTimeMillis())
        val others = loadAll().filter { it.uid != entry.uid }.sortedByDescending { it.savedAtMs }
        val keep = others.take(MAX_ACCOUNTS - 1)
        val dropped = others.drop(MAX_ACCOUNTS - 1)
        try {
            client.storeBytes(
                StoreBytesData.Builder().setBytes(encode(entry).toByteArray()).setKey(accountKey(entry.uid))
                    .setShouldBackupToCloud(false).build(),
            ).await()
            if (dropped.isNotEmpty()) {
                client.deleteBytes(DeleteBytesRequest.Builder().setKeys(dropped.map { accountKey(it.uid) }).build()).await()
            }
        } catch (_: Exception) {
        }
        try {
            dataStore.edit { it[ACCOUNTS] = (listOf(entry) + keep).joinToString("\n") { a -> encode(a) } }
        } catch (_: Exception) {
        }
    }

    /** Every account remembered on this device, most recently used first. */
    suspend fun loadAll(): List<Saved> {
        val fromBlockStore = try {
            val res = client.retrieveBytes(RetrieveBytesRequest.Builder().setRetrieveAll(true).build()).await()
            res.blockstoreDataMap.entries
                .filter { (key, _) -> key.startsWith(ACCOUNT_PREFIX) }
                .mapNotNull { (_, data) -> decode(String(data.bytes)) }
        } catch (_: Exception) {
            emptyList()
        }
        val fromDataStore = try {
            (dataStore.data.first()[ACCOUNTS] ?: "").split('\n').mapNotNull { decode(it) }
        } catch (_: Exception) {
            emptyList()
        }
        return mergeAccounts(fromBlockStore + fromDataStore)
    }

    /**
     * B10: forget the one blob saved before B10 (it has no uid to remove it by). Only that slot — every account
     * filed under its uid stays.
     */
    suspend fun forgetUnfiled() {
        val recent = load()
        if (recent != null && recent.uid.isBlank()) clearMostRecent()
    }

    /** One account's credential, or null. */
    suspend fun loadFor(uid: String): Saved? = loadAll().firstOrNull { it.uid == uid }

    /**
     * Forget one account on this device (the switcher's "Remove", or a credential the server refused). The other
     * accounts are untouched; the login screen's single button goes too if it was this account's.
     */
    suspend fun remove(uid: String) {
        if (uid.isBlank()) return
        try { client.deleteBytes(DeleteBytesRequest.Builder().setKeys(listOf(accountKey(uid))).build()).await() } catch (_: Exception) {}
        try {
            dataStore.edit { prefs ->
                val rest = (prefs[ACCOUNTS] ?: "").split('\n').filter { line -> decode(line)?.uid?.let { it != uid } ?: false }
                prefs[ACCOUNTS] = rest.joinToString("\n")
            }
        } catch (_: Exception) {
        }
        val recent = load()
        if (recent != null && recent.uid == uid) clearMostRecent()
    }

    /** The login screen's single "Continue as …" entry only. */
    private suspend fun clearMostRecent() {
        try { client.deleteBytes(DeleteBytesRequest.Builder().setKeys(listOf(KEY)).build()).await() } catch (_: Exception) {}
        try { dataStore.edit { it.remove(LOCAL) } } catch (_: Exception) {}
    }

    /**
     * Forget EVERY saved secret on this device.
     *
     * B10: only for "nothing saved here can be redeemed any more" — the handset has no device key, so no
     * credential on it can be signed for. A deleted account, a refused credential or the switcher's "Remove" is
     * ONE account, and goes through [remove]; the others stay. Never on an ordinary sign-out, because remembering
     * across an ordinary sign-out is the entire feature. (The explicit "sign out and forget this device" row that
     * also called it was removed, UGP-E2.)
     */
    suspend fun clear() {
        val accounts = loadAll()
        try {
            client.deleteBytes(
                DeleteBytesRequest.Builder().setKeys(listOf(KEY) + accounts.map { accountKey(it.uid) }).build(),
            ).await()
        } catch (_: Exception) {
        }
        try {
            dataStore.edit { it.remove(LOCAL); it.remove(ACCOUNTS) }
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
    internal fun encode(s: Saved): String = encodeSaved(s)

    internal fun decode(raw: String): Saved? = decodeSaved(raw)

    companion object {
        /** Block Store is a key/value store shared by the app; the most recent account lives here. */
        private const val KEY = "zipper_quick_login_v1"
        private val LOCAL = stringPreferencesKey("quick_login_v1")
        /** B10: one entry per remembered account. */
        private const val ACCOUNT_PREFIX = "zq_acct_"
        private val ACCOUNTS = stringPreferencesKey("quick_login_accounts_v2")
        /** B10: how many accounts one device remembers (Instagram keeps about this many). */
        const val MAX_ACCOUNTS = 5

        /**
         * Pure, for tests. A blob from before B10 has three fields (token, photo, name) and reads with no uid; the
         * name never contains a tab or a newline (both are replaced on the way in), so the fields after it are safe.
         */
        fun decodeSaved(raw: String): Saved? {
            if (raw.isBlank()) return null
            val parts = raw.split('\t')
            val token = parts.getOrNull(0)?.takeIf { it.length >= 16 } ?: return null
            return Saved(
                token = token,
                photoUrl = parts.getOrNull(1).orEmpty(),
                displayName = parts.getOrNull(2).orEmpty(),
                uid = parts.getOrNull(3).orEmpty(),
                savedAtMs = parts.getOrNull(4)?.toLongOrNull() ?: 0L,
            )
        }

        fun encodeSaved(s: Saved): String =
            listOf(
                s.token,
                s.photoUrl.replace('\t', ' ').replace('\n', ' '),
                s.displayName.replace('\t', ' ').replace('\n', ' '),
                s.uid,
                s.savedAtMs.toString(),
            ).joinToString("\t")

        /**
         * Pure, for tests: one entry per account, the NEWEST copy of each. Block Store and DataStore can disagree
         * when one write failed, and the older copy holds a secret the last redemption already spent — keeping it
         * would make that account's next tap a refusal, and a refusal forgets the account.
         */
        /**
         * Pure, for tests — B10: the saved credential that speaks for [uid] (an appeal, a restriction lookup), or
         * null. Never another account's: with [uid] known, only its own entry, or the single entry saved before
         * B10 when that is all there is (it was always the account last signed out here); with [uid] unknown, only
         * a device that remembers exactly one account can say whose it is.
         */
        fun credentialFor(saved: List<Saved>, uid: String): Saved? {
            if (uid.isNotBlank()) {
                saved.firstOrNull { it.uid == uid }?.let { return it }
                return saved.singleOrNull()?.takeIf { it.uid.isBlank() }
            }
            return saved.singleOrNull()
        }

        fun mergeAccounts(entries: List<Saved>): List<Saved> {
            val newest = linkedMapOf<String, Saved>()
            for (e in entries) {
                if (e.uid.isBlank()) continue
                val have = newest[e.uid]
                if (have == null || e.savedAtMs > have.savedAtMs) newest[e.uid] = e
            }
            return newest.values.sortedByDescending { it.savedAtMs }
        }
    }
}
