package com.zipper.app.util

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SessionManager @Inject constructor(
    private val dataStore: DataStore<Preferences>,
) {
    companion object {
        private val KEY_TOKEN  = stringPreferencesKey("session_token")
        private val KEY_UID    = stringPreferencesKey("session_uid")

        /**
         * Whether this session's account is still a guest, as the SERVER
         * answered it at sign-in.
         *
         * Cached rather than asked again because the only question it settles
         * is whether Settings offers to attach a phone number, and the honest
         * source — `resolveIdentity` — is a call with side effects: it bars a
         * device on a banned account. Re-asking it every time somebody opened
         * Settings would make a read into a write.
         *
         * It cannot be derived on the device. `FirebaseUser.isAnonymous` is
         * false for a guest who returned through quick sign-in, because that
         * path redeems a custom token.
         */
        private val KEY_IS_GUEST = booleanPreferencesKey("session_is_guest")

        /**
         * The address a Firebase email sign-in link was last sent to, while
         * that link is still out there unopened.
         *
         * ── WHY THIS HAS TO BE ON DISK ───────────────────────────────────
         *
         * The link that comes back carries a one-time code and nothing else;
         * `EmailAuthProvider.getCredentialWithLink` needs the address too. And
         * the person leaves the app to fetch it — into a mail client, on a
         * phone that is free to kill this process while they are gone — so a
         * field on a ViewModel, or on the Activity, is exactly the thing that
         * will not be there when the link is tapped.
         *
         * Cleared by `AuthRepository` the moment the binding succeeds or the
         * person chooses a different address: this is somebody's email address
         * and it has no reason to outlive the attempt.
         */
        private val KEY_PENDING_EMAIL = stringPreferencesKey("pending_email_link")

        fun newToken(): String = UUID.randomUUID().toString()
    }

    val sessionToken: Flow<String> = dataStore.data.map { it[KEY_TOKEN] ?: "" }
    val sessionUid:   Flow<String> = dataStore.data.map { it[KEY_UID]   ?: "" }

    /** The address an unopened email sign-in link went to, or "". */
    val pendingEmailLink: Flow<String> = dataStore.data.map { it[KEY_PENDING_EMAIL] ?: "" }

    /**
     * The server's answer, or **null** when it has never been asked on this
     * install.
     *
     * Nullable deliberately. A plain `Boolean` defaulting to false would be
     * indistinguishable from "the server said this is not a guest", and the
     * flag is only ever written by `gateIdentity` — which runs at sign-in.
     * Everyone already signed in when this shipped would therefore have read
     * false forever, and they are precisely the population the flag exists to
     * serve: long-standing guests, who by definition have never had a reason
     * to sign out. The one way to switch the feature on for them would have
     * been to sign out, which is the exact act that risks the account it is
     * meant to protect.
     *
     * Null means "fall back to what the client can see" — see the Settings
     * destination in `ZipperNavGraph`.
     */
    val isGuest: Flow<Boolean?> = dataStore.data.map { it[KEY_IS_GUEST] }

    suspend fun save(uid: String, token: String) {
        dataStore.edit { prefs ->
            prefs[KEY_TOKEN] = token
            prefs[KEY_UID]   = uid
        }
    }

    /**
     * Record the server's verdict. Written separately from [save] because it
     * arrives from a different call at a different moment — `resolveIdentity`
     * runs BEFORE the session is minted, so folding it into `save` would
     * either delay the gate or leave the flag a step behind the account.
     */
    suspend fun setGuest(isGuest: Boolean) {
        dataStore.edit { prefs -> prefs[KEY_IS_GUEST] = isGuest }
    }

    /** See [KEY_PENDING_EMAIL]. Written when the link is sent, not before. */
    suspend fun setPendingEmailLink(email: String) {
        dataStore.edit { prefs -> prefs[KEY_PENDING_EMAIL] = email }
    }

    suspend fun clearPendingEmailLink() {
        dataStore.edit { prefs -> prefs.remove(KEY_PENDING_EMAIL) }
    }

    suspend fun clear() {
        dataStore.edit { prefs ->
            prefs.remove(KEY_TOKEN)
            prefs.remove(KEY_UID)
            prefs.remove(KEY_IS_GUEST)
            // A half-finished binding belongs to the session that started it.
            // Left behind, it is one person's address waiting to be decoded
            // against the next person's link on a shared handset.
            prefs.remove(KEY_PENDING_EMAIL)
        }
    }
}
