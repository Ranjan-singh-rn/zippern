package com.zipper.app.util

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
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
         * C7 (B01/B02): what the SERVER says this account still owes us — a
         * phone number, an email, or neither — as `resolveIdentity` answered it
         * at sign-in.
         *
         * Recorded, never routed on. These two used to travel as
         * `AuthResult.NeedsContactDetails`, which sent a Host, a partner or a
         * member of staff with a finished profile to profile setup on every
         * sign-in — a screen that cannot bind a contact — and skipped starting
         * their session on the way. The verified way to settle either one is
         * the "Add your phone number / Add your email" row in Settings, which
         * binds by OTP or by code; the next sign-in re-reads the answer.
         */
        /**
         * FX-21: the uid of this device's GUEST account, remembered when a
         * guest signs out (see [GuestLinkWarning]). Login reads it to warn
         * before a phone or Google sign-in opens a separate account.
         *
         * NOT removed by [clear] — it describes the device, not the session,
         * and the warning exists for the moment after sign-out. It is a hint
         * for a warning, never a credential: nothing signs in with it.
         */
        private val KEY_DEVICE_GUEST_UID = stringPreferencesKey("device_guest_uid")

        private val KEY_REQUIRES_PHONE = booleanPreferencesKey("session_requires_phone")
        private val KEY_REQUIRES_EMAIL = booleanPreferencesKey("session_requires_email")

        /**
         * APK 20 / spec §8: the CRM role the SERVER answered for this account
         * (`resolveIdentity.crmRole` — `superadmin` for an Owner, a department
         * role, `agency` / `seller`, or "" for an ordinary user), written at
         * every sign-in and every cold start, right before Main is entered.
         *
         * A PRE-FILTER only: `OwnerMfaGateHost` reads it to decide whether to
         * ask the work API who this is, so an ordinary user's launch costs no
         * API sign-in (which the server would refuse and audit as a failed
         * login). It grants nothing — the gate's decision is `GET /api/auth/me`
         * (`role == "owner"`), and every Owner route is refused server-side
         * until the code is verified. Never a role flag for a work screen:
         * those come from `/api/auth/me` alone (`data/work/Caps`).
         */
        private val KEY_CRM_ROLE = stringPreferencesKey("session_crm_role")

        /**
         * LEGACY (UGP-C): where 1.2.3 kept the address an email sign-in LINK
         * was sent to. The link flow is gone — binding is a code typed into
         * the app — so nothing writes this any more. The key is kept only so
         * [clear] can erase an address an older build left on the device.
         */
        private val KEY_PENDING_EMAIL = stringPreferencesKey("pending_email_link")

        fun newToken(): String = UUID.randomUUID().toString()
    }

    val sessionToken: Flow<String> = dataStore.data.map { it[KEY_TOKEN] ?: "" }
    val sessionUid:   Flow<String> = dataStore.data.map { it[KEY_UID]   ?: "" }

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

    /**
     * C7: does this account still owe a phone number / an email? False until
     * the server has said so — the same "ask for nothing until told" default
     * profile setup uses. See [KEY_REQUIRES_PHONE].
     */
    val requiresPhone: Flow<Boolean> = dataStore.data.map { it[KEY_REQUIRES_PHONE] ?: false }
    val requiresEmail: Flow<Boolean> = dataStore.data.map { it[KEY_REQUIRES_EMAIL] ?: false }

    /** The server's last answer for this account's CRM role, "" when none. See [KEY_CRM_ROLE]. */
    val crmRole: Flow<String> = dataStore.data.map { it[KEY_CRM_ROLE] ?: "" }

    /** Record the server's answer (`resolveIdentity.crmRole`). Written beside [setGuest]. */
    suspend fun setCrmRole(crmRole: String) {
        dataStore.edit { prefs -> prefs[KEY_CRM_ROLE] = crmRole.trim() }
    }

    /**
     * Phase 1A (SESSION-001): [payload] with this device's active mobile session
     * id attached as `sessionId`, for every callable. The SERVER decides what it
     * means (`assertActiveSession`); attaching it is the client half only.
     * An explicit `sessionId` already in the payload is left alone.
     */
    suspend fun withSession(payload: Map<String, Any>): Map<String, Any> {
        if (payload.containsKey("sessionId")) return payload
        val sid = try { sessionToken.first() } catch (_: Exception) { "" }
        return if (sid.isBlank()) payload else payload + ("sessionId" to sid)
    }

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

    /** FX-21: this device's remembered guest account, "" when none. See [KEY_DEVICE_GUEST_UID]. */
    val deviceGuestUid: Flow<String> = dataStore.data.map { it[KEY_DEVICE_GUEST_UID] ?: "" }

    suspend fun setDeviceGuestUid(uid: String) {
        dataStore.edit { prefs -> prefs[KEY_DEVICE_GUEST_UID] = uid }
    }

    suspend fun clearDeviceGuestUid() {
        dataStore.edit { prefs -> prefs.remove(KEY_DEVICE_GUEST_UID) }
    }

    /**
     * Record the server's contact requirement (C7). Written by `gateIdentity`
     * beside [setGuest], for the same reason it is separate from [save]: it
     * arrives from `resolveIdentity`, before the session is minted.
     */
    suspend fun setContactRequirement(requiresPhone: Boolean, requiresEmail: Boolean) {
        dataStore.edit { prefs ->
            prefs[KEY_REQUIRES_PHONE] = requiresPhone
            prefs[KEY_REQUIRES_EMAIL] = requiresEmail
        }
    }

    suspend fun clear() {
        dataStore.edit { prefs ->
            prefs.remove(KEY_TOKEN)
            prefs.remove(KEY_UID)
            prefs.remove(KEY_IS_GUEST)
            // A requirement belongs to the account that was signed in, not to
            // the next one on this phone.
            prefs.remove(KEY_REQUIRES_PHONE)
            prefs.remove(KEY_REQUIRES_EMAIL)
            prefs.remove(KEY_CRM_ROLE)
            // An address left by an older build's email-link flow (see
            // KEY_PENDING_EMAIL) — somebody's email has no reason to outlive it.
            prefs.remove(KEY_PENDING_EMAIL)
        }
    }
}
