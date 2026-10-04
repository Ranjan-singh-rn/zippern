package com.zipper.app.util

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import java.security.SecureRandom
import android.util.Base64
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The proof that this install is the same install that owns this device's guest
 * account.
 *
 * ── WHY A SECRET AND NOT JUST THE DEVICE ID ──────────────────────────────────
 *
 * `claimGuestIdentity` hands out a custom token — a full session — for the guest
 * account bound to a device. If the device id alone were enough to ask for one,
 * anyone holding a device id could take that account, and the device id is not
 * remotely secret to us: it is stored on `users/{uid}.deviceId`, and
 * `users/{uid}` is readable by any signed-in account. Every guest balance in the
 * app would be one document read away from a stranger.
 *
 * So the device id says WHICH guest, and this says PROVE IT. The server keeps
 * only `sha256(secret)`, so the value here is the only copy in existence.
 *
 * ── WHERE IT LIVES, AND WHAT THAT COSTS ──────────────────────────────────────
 *
 * Block Store, alongside the quick-login secret but under its own key, because
 * the two have different lifetimes: quick login is destroyed when the server
 * refuses a token or the person deletes their account, and this must outlive all
 * of that — it is how the handset is recognised at all.
 *
 * On a device with no working Play Services, DataStore is the fallback and it
 * does not survive an uninstall. That has one honest consequence, and it is the
 * only case where a person loses reach of their guest balance: the binding
 * remains, this install cannot prove it owns it, and the app says so and offers
 * Google or phone instead. It does NOT quietly hand out a second empty guest
 * account, which is the bug this whole mechanism exists to remove. Ops can clear
 * `guestDeviceBindings/{deviceId}` for someone who asks, and that is deliberately
 * a manual, auditable act rather than something the client can trigger.
 *
 * There is a repair in the other direction too. A secret that ended up local-only
 * because Play Services was broken is promoted into Block Store by the next
 * [load] that Block Store answers, so a handset only stays in the weak state for
 * as long as it is actually broken.
 *
 * ── THE TRAP IN "JUST GENERATE ONE IF THERE ISN'T ONE" ───────────────────────
 *
 * Block Store failing to ANSWER and Block Store answering EMPTY look identical
 * to a `try`/`catch` that returns null — and treating the first as the second is
 * how a transient Play Services error permanently destroys a guest account:
 * generate a replacement secret, store it over the top, and the old binding can
 * never be proved again. [Load] keeps the two apart. A secret minted after an
 * unreadable Block Store is written LOCALLY ONLY for that reason: it is enough to
 * work with, and it cannot overwrite what may still be there.
 */
@Singleton
class DeviceSecretStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val dataStore: DataStore<Preferences>,
) {

    sealed interface Load {
        /** A secret exists, and this is it. */
        data class Found(val secret: String) : Load
        /** Storage answered and holds nothing. Safe to mint a first secret. */
        data object Absent : Load
        /**
         * Storage could not be read. NOT the same as empty: minting here would
         * overwrite a secret that may still be there.
         */
        data object Unavailable : Load
    }

    private val client by lazy { Blockstore.getClient(context) }
    private val mint = Mutex()

    /**
     * The device secret, minting one on first run.
     *
     * Returns null only when storage could not be read at all, which the caller
     * must treat as "I do not know whether this device has a guest" and refuse
     * to create one.
     */
    suspend fun getOrCreate(): String? = mint.withLock {
        when (val found = load()) {
            is Load.Found -> found.secret
            Load.Absent -> generate().let { if (save(it)) it else null }
            Load.Unavailable -> {
                /*
                 * Asked again, because "Play Services is busy" and "this device
                 * has no Play Services" arrive as the same failure and deserve
                 * opposite answers. A second empty reading is taken as the
                 * second case.
                 */
                when (val again = load()) {
                    is Load.Found -> again.secret
                    Load.Absent -> generate().let { if (save(it)) it else null }
                    Load.Unavailable -> {
                        /*
                         * Minted LOCALLY ONLY, and that restraint is the whole
                         * point: if Block Store is in fact holding a secret it
                         * simply could not read out, writing over it would
                         * destroy the one copy of the credential for an account
                         * that still exists. Left alone, the next reading that
                         * succeeds finds the real secret and wins, because
                         * [load] prefers Block Store.
                         *
                         * Until then this device can create and keep a guest,
                         * which is what a handset with no Play Services at all
                         * needs — for that one the local copy is the only copy,
                         * and it does not survive an uninstall. The class
                         * comment says what that costs.
                         */
                        val fresh = generate()
                        /*
                         * Nowhere to keep it means no secret at all. Fail closed:
                         * one that is not persisted would bind a guest account on
                         * this launch that no later launch could prove it owned.
                         */
                        if (saveLocal(fresh)) fresh else null
                    }
                }
            }
        }
    }

    /**
     * Read without minting, keeping "empty" and "could not read" apart.
     *
     * Private on purpose: [getOrCreate] is the only entry point, so there is no
     * way for a caller to obtain [Load.Unavailable] and quietly treat it as
     * nothing-stored — the mistake this whole class is shaped around.
     */
    private suspend fun load(): Load {
        var blockStoreAnswered = false
        try {
            val res = client.retrieveBytes(
                RetrieveBytesRequest.Builder().setKeys(listOf(KEY)).build(),
            ).await()
            blockStoreAnswered = true
            val bytes = res.blockstoreDataMap[KEY]?.bytes
            if (bytes != null && bytes.size >= MIN_CHARS) {
                val durable = String(bytes)
                /*
                 * Mirrored down as well as up, so the two copies converge.
                 *
                 * Without this the repair runs one way only, and a device that
                 * minted a local-only secret during an outage keeps that stale
                 * value for ever beside the real one. The next time Block Store
                 * cannot answer, the stale copy is returned as authoritative and
                 * the server refuses the account — the outcome this class is
                 * built to avoid, arrived at from the other direction.
                 */
                saveLocal(durable)
                return Load.Found(durable)
            }
        } catch (_: Exception) {
            // Play Services missing, disabled, or busy. Distinguished below.
        }

        val local = try {
            dataStore.data.first()[LOCAL].orEmpty()
        } catch (_: Exception) {
            /*
             * Both stores unreadable. `Unavailable`, never `Absent` — a DataStore
             * read that throws is a corrupt or locked file, not an empty one, and
             * the difference is a guest account.
             */
            return Load.Unavailable
        }
        if (local.length >= MIN_CHARS) {
            /*
             * Found locally but not in Block Store. Re-store it, so a device
             * whose Play Services was broken on first run gets the durable copy
             * as soon as it works again. Writing the SAME value is safe; this is
             * the one repair path that cannot lose anything.
             */
            if (blockStoreAnswered) storeDurable(local)
            return Load.Found(local)
        }

        // DataStore is definitely empty. Block Store must also have answered, or
        // "empty" is only an assumption.
        return if (blockStoreAnswered) Load.Absent else Load.Unavailable
    }

    /**
     * Both copies.
     *
     * @return whether it is on disk at all. Block Store failing is survivable —
     *   the secret still works for this install and [load] promotes it later. A
     *   failed DataStore write with Block Store also refusing is not: the caller
     *   would hand out a secret that no later launch can produce, and the guest
     *   account bound with it would be unreachable for ever.
     */
    private suspend fun save(secret: String): Boolean {
        storeDurable(secret)
        return saveLocal(secret)
    }

    /** @return true when it is actually on disk. The caller acts on the answer. */
    private suspend fun saveLocal(secret: String): Boolean = try {
        dataStore.edit { it[LOCAL] = secret }
        true
    } catch (_: Exception) {
        false
    }

    private suspend fun storeDurable(secret: String) {
        try {
            client.storeBytes(
                StoreBytesData.Builder()
                    .setBytes(secret.toByteArray())
                    .setKey(KEY)
                    // Carries the guest account across a device transfer, which is
                    // the same promise quick login already makes.
                    .setShouldBackupToCloud(true)
                    .build(),
            ).await()
        } catch (_: Exception) {
        }
    }

    private fun generate(): String {
        val raw = ByteArray(32)
        SecureRandom().nextBytes(raw)
        // URL-safe and unpadded: it travels as a callable string and must not
        // collide with the tab separator the quick-login blob uses.
        return Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private companion object {
        /** Its own key. Quick login's is cleared on events that must not touch this. */
        const val KEY = "zipper_device_secret_v1"
        val LOCAL = stringPreferencesKey("device_secret_v1")

        /** 32 random bytes, base64url, unpadded — 43 chars. The server demands 32+. */
        const val MIN_CHARS = 32
    }
}
