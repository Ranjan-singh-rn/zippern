package com.zipper.app.data.repository

import android.net.Uri
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.storage.FirebaseStorage
import com.zipper.app.BuildConfig
import com.zipper.app.data.model.User
import com.zipper.app.util.DeviceKey
import com.zipper.app.util.DeviceSecretStore
import com.zipper.app.util.QuickLoginStore
import com.zipper.app.util.SessionManager
import com.zipper.app.util.UserLanguage
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

sealed class AuthResult {
    object Success : AuthResult()
    data class Error(val message: String) : AuthResult()
    data class CodeSent(val verificationId: String) : AuthResult()
    object ProfileIncomplete : AuthResult()

    /**
     * The identifier belongs to an account that is still somebody's.
     *
     * Not a choice to be offered — a refusal. Passing the OTP proved control of
     * the SIM, not ownership of the account attached to it. See
     * `bindVerifiedIdentity`.
     */
    data class IdentityTaken(val message: String) : AuthResult()

    /**
     * Refused. WHICH refusal matters, because the three read differently to the
     * person holding the phone.
     *
     * A suspension is temporary and the device is untouched, so they may sign
     * in with a different account here. A ban is not, and the device is barred.
     * A device ban is about the handset rather than about them at all. Sending
     * all three to one screen with one word was why a seven-day suspension
     * looked like a permanent ban with no end date.
     */
    data class Banned(
        val reason: String,
        val kind: RestrictionKind = RestrictionKind.Account,
        /** When a suspension ends. 0 for indefinite, or for a ban. */
        val untilMillis: Long = 0L,
    ) : AuthResult()

    /**
     * The observer account. CRM-only, and refused on every mobile path.
     *
     * The Firebase login that was just created has already been deleted by the
     * time this is returned — otherwise a refused sign-in would leave a real
     * auth account for an identity that must not have one.
     */
    object ObserverDenied : AuthResult()

    /**
     * This account was deleted and is still inside its recovery window.
     *
     * The person must choose: restore it, or start a new account. Neither is
     * done for them — silently recovering an account somebody meant to delete
     * is as wrong as silently replacing one they wanted back.
     */
    data class DeletedRecoverable(
        val displayName: String,
        val photoUrl: String,
        val dueAtMs: Long,
    ) : AuthResult()

    /**
     * Signed in, but the role needs something the sign-in method could not
     * supply — a host or a staff member who arrived by Google and has no phone
     * on file, or by phone and has no email.
     *
     * An ordinary user is NEVER returned this. That is the whole point: the app
     * used to demand an email of every phone user and a phone of every Google
     * user, whoever they were.
     */
    data class NeedsContactDetails(
        val requiresPhone: Boolean,
        val requiresEmail: Boolean,
        val crmRole: String,
    ) : AuthResult()
}

/** Which of the three refusals this is. See [AuthResult.Banned]. */
enum class RestrictionKind { Account, Suspension, Device }

/** An account that already exists for a phone or an email somebody just offered. */
data class ExistingAccount(
    val uid: String,
    val name: String,
    val photoUrl: String,
    /** "phone" or "email" — which identifier matched. */
    val via: String,
)

sealed class ReferralResult {
    object NotFound : ReferralResult()
    object AlreadyUsed : ReferralResult()
    object AccountMismatch : ReferralResult()
    /**
     * The code is usable by this account. Carries only the agency's name, for
     * the confirmation line in the form — `agencyId`, `callRate` and
     * `applicationId` were travelling through the UI purely so the client could
     * write them back to Firestore, which it may no longer do.
     */
    data class Valid(val agencyName: String) : ReferralResult()
    data class Error(val message: String) : ReferralResult()
}

@Singleton
class AuthRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
    private val sessionManager: SessionManager,
    private val hostFunctions: HostFunctions,
    private val money: MoneyFunctions,
    private val quickLogin: QuickLoginStore,
    private val deviceSecret: DeviceSecretStore,
    /**
     * The half of quick login that cannot be copied. See [DeviceKey] — the
     * credential in [quickLogin] is only bytes, and this is what makes those
     * bytes mean "this handset".
     */
    private val deviceKey: DeviceKey,
) {
    val currentFirebaseUser get() = auth.currentUser

    // ── Phone OTP ─────────────────────────────────────────────────────────────

    fun sendOtp(
        phoneNumber: String,
        activity: android.app.Activity,
        callbacks: PhoneAuthProvider.OnVerificationStateChangedCallbacks,
    ) {
        val options = PhoneAuthOptions.newBuilder(auth)
            .setPhoneNumber(phoneNumber)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(callbacks)
            .build()
        PhoneAuthProvider.verifyPhoneNumber(options)
    }

    suspend fun verifyOtp(verificationId: String, code: String, deviceId: String = ""): AuthResult {
        return try {
            val credential = PhoneAuthProvider.getCredential(verificationId, code)
            signInWithCredential(credential, deviceId)
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "OTP verification failed")
        }
    }

    // ── Session token ─────────────────────────────────────────────────────────

    // ── Device ban ────────────────────────────────────────────────────────────

    /** Returns the ban reason if this device is banned, null otherwise.
     *  Returns null on any error (PERMISSION_DENIED, network, etc.) — safe to ignore. */
    suspend fun getDeviceBanReason(deviceId: String): String? {
        if (deviceId.isBlank()) return null
        return try {
            val snap = firestore.collection("bannedDevices").document(deviceId).get().await()
            if (snap.exists()) snap.getString("reason") ?: "This device has been banned." else null
        } catch (_: Exception) {
            null
        }
    }

    /*
     * ── REMOVED: banDevice ───────────────────────────────────────────────────
     *
     * A client write into `bannedDevices`, which never worked and could not
     * have. `firestore.rules` allows that collection to `isOps()` only, so
     * every call was refused — and the refusal was swallowed by an empty
     * `catch`, so it looked like it was doing something for as long as anybody
     * cared to look.
     *
     * It was also aimed at the wrong handset. It barred `users/{uid}.deviceId`,
     * written once at profile setup and never refreshed, so a banned person
     * signing in from a new phone had their OLD one barred while the one in
     * their hand stayed clean.
     *
     * `resolveIdentity` does this now, server-side, on the device actually in
     * use, recording which account caused the bar so an unban can lift exactly
     * what it created. See `barDevice` in functions/src/identity.ts.
     */

    /**
     * Claim this device as the account's one active mobile session.
     *
     * ── THE CLIENT NO LONGER MINTS THIS ──────────────────────────────────────
     *
     * It used to generate a random string and write it to
     * `users/{uid}.sessionToken` itself. Two things were wrong with that. The
     * field was client-writable, so a patched app could simply not write it and
     * keep two phones signed in indefinitely — the one-device rule was a
     * request. And a single opaque string could not say WHICH device had taken
     * over, so the phone being signed out had nothing to tell its owner.
     *
     * `startMobileSession` mints it, records the device, and the field is
     * server-only in the rules. The previous phone is watching the same
     * document and loses within a second.
     */
    private suspend fun generateSession(uid: String, deviceId: String = "") {
        when (val res = money.startMobileSession(
            deviceId = deviceId,
            /*
             * "Samsung SM-A546E", not "SM-A546E".
             *
             * This string is shown to the person being signed out — "your
             * account was opened on a …" — so it has to be something they can
             * recognise as a handset they own. A bare model code is not.
             */
            deviceName = listOfNotNull(
                android.os.Build.MANUFACTURER?.takeIf { it.isNotBlank() }
                    ?.replaceFirstChar { c -> c.uppercase() },
                android.os.Build.MODEL?.takeIf { it.isNotBlank() },
            ).joinToString(" ").take(64),
        )) {
            is MoneyFunctions.Result.Ok -> sessionManager.save(uid, res.value.sessionId)
            is MoneyFunctions.Result.Failed -> {
                /*
                 * A session that could not be claimed is not a sign-in that
                 * should fail. The person is authenticated; refusing them the
                 * app because one write did not land would be worse than
                 * letting two devices coexist until the next launch, which the
                 * splash check catches.
                 */
            }
        }
    }

    /**
     * Ask the server for a quick-login credential, registering this handset's
     * device key against it.
     *
     * ── THE KEY IS NOT OPTIONAL ──────────────────────────────────────────────
     *
     * The secret alone is no longer a credential. [DeviceKey] holds an EC P-256
     * pair generated inside the Android Keystore, and the server records the
     * public half here so that redemption can demand a signature from the
     * private one — which never leaves the keystore, is not exportable, and is
     * not in any backup. That is what makes the credential mean "this device"
     * rather than "these bytes".
     *
     * So a handset whose Keystore will not produce a key gets NO quick-login
     * credential. Falling back to the old unbound kind would be worse than not
     * offering the feature: it would reintroduce a transferable bearer secret on
     * exactly the devices least able to protect one.
     *
     * Best-effort otherwise. A device with no Play Services, or a server that
     * refused, must still get a working session; what is lost is the
     * convenience, not the account.
     */
    private suspend fun mintQuickLoginCredential(deviceId: String) {
        try {
            val publicKey = deviceKey.publicKeyPem()
            if (publicKey.isNullOrBlank()) {
                // No binding available, so no credential. Anything already saved
                // is stale and would fail its signature check anyway.
                quickLogin.clear()
                return
            }
            when (val res = money.mintQuickLoginToken(deviceId, publicKey)) {
                is MoneyFunctions.Result.Ok -> quickLogin.save(
                    QuickLoginStore.Saved(
                        token = res.value.token,
                        displayName = res.value.displayName,
                        photoUrl = res.value.photoUrl,
                    ),
                )
                is MoneyFunctions.Result.Failed -> Unit
            }
        } catch (_: Exception) {
        }
    }

    /**
     * What the quick-login button should show, or null when there is nothing to
     * offer.
     *
     * Null also when this handset has no device key. A saved secret with no key
     * to sign for it cannot be redeemed, so offering the button would promise a
     * sign-in that is certain to be refused — and the refusal would then delete
     * the credential, making the button vanish after the tap rather than before
     * it. Checked here so the UI never shows an offer the server will not honour.
     */
    suspend fun savedQuickLogin(): QuickLoginStore.Saved? =
        if (deviceKey.hasKey()) quickLogin.load() else null

    /**
     * Sign in from the saved credential.
     *
     * ── THREE STEPS, AND THE MIDDLE ONE IS THE POINT ─────────────────────────
     *
     *   1. ask the server for a challenge      (random bytes, single-use)
     *   2. sign it with the Keystore key       (private half never leaves)
     *   3. redeem secret + challenge + signature
     *
     * Step 2 is what the secret alone cannot do. A credential lifted off this
     * phone — out of a cloud backup, off a rooted filesystem, by any means at
     * all — arrives at step 3 unable to produce a signature, and authenticates
     * nothing. Before this existed, the bytes WERE the credential.
     *
     * On success the server has already destroyed the credential just spent and
     * returned its replacement, so the replacement is saved before anything else
     * can fail. The old one is dead either way; losing the new one costs the
     * feature until the next sign-out, and losing it SILENTLY is what would make
     * the button look broken.
     *
     * The custom token is what makes this work for a GUEST. An anonymous
     * credential cannot be re-obtained by any other means once the local copy is
     * gone — there is no SMS to receive and no Google account to pick — so
     * without this path a guest who reinstalled was permanently locked out of
     * their own balance, and the app minted them a new account instead. That is
     * the duplicate-document bug at its root.
     */
    suspend fun signInWithQuickLogin(deviceId: String): AuthResult {
        val saved = quickLogin.load() ?: return AuthResult.Error("Nothing saved on this device.")

        getDeviceBanReason(deviceId)?.let { return AuthResult.Banned(it, RestrictionKind.Device) }

        /*
         * ── NO KEY, NO ATTEMPT ───────────────────────────────────────────────
         *
         * A reinstall produces a NEW Keystore key — the old one is gone with the
         * app's keystore entry — so a secret that survived in Block Store can
         * outlive the key that signs for it. That is the legacy case too: every
         * credential minted before this change has no key at all.
         *
         * Either way the server would refuse it, and refusing here instead means
         * saying something true ("sign in once") rather than spending the
         * attempt, burning the rate-limit budget, and reporting a generic
         * failure.
         */
        if (!deviceKey.hasKey()) {
            quickLogin.clear()
            return AuthResult.Error(
                "Please sign in once to re-enable quick sign-in on this device.",
            )
        }

        /*
         * Whether THIS call opened the session, which is not the same question as
         * whether one is open. A session that was already live before this ran
         * must not be torn down by a failure in here.
         */
        var opened = false

        return try {
            // ── 1. Something to sign ─────────────────────────────────────────
            //
            // A failure here is not the credential's fault and must not destroy
            // it: no challenge means the server was unreachable, which is the
            // one case where forgetting the only copy of a guest's way back in
            // would be unforgivable.
            val challenge = when (val res = money.quickLoginChallenge()) {
                is MoneyFunctions.Result.Ok -> res.value
                is MoneyFunctions.Result.Failed -> return AuthResult.Error(res.userMessage)
            }
            if (challenge.challenge.isBlank() || challenge.challengeId.isBlank()) {
                return AuthResult.Error("Could not start quick sign-in. Try again.")
            }

            // ── 2. Prove the device ──────────────────────────────────────────
            //
            // Null means the platform refused to sign — a keystore in a bad
            // state, usually. Not a reason to try without a signature, which the
            // server would refuse; and not a reason to delete the credential,
            // because the key may well sign on the next attempt.
            val signature = deviceKey.sign(challenge.challenge)
                ?: return AuthResult.Error(
                    "This device could not verify itself. Please sign in normally.",
                )

            // ── 3. Spend it ──────────────────────────────────────────────────
            val value = when (
                val res = money.redeemQuickLogin(
                    token = saved.token,
                    challengeId = challenge.challengeId,
                    signature = signature,
                    deviceId = deviceId,
                )
            ) {
                is MoneyFunctions.Result.Ok -> res.value
                is MoneyFunctions.Result.Failed -> return refuseQuickLogin(res)
            }

            /*
             * ── BAN AND SUSPENSION ARE REFUSALS THAT ARE NOT FAILURES ────────
             *
             * The credential was valid and the device proved itself; the answer
             * is "here is what has happened to your account". Neither carries a
             * custom token, so there is no session to be had from either — and
             * the credential is deliberately KEPT in both cases, because it is
             * the only thing left that can prove who is appealing. See
             * `AppealRepository.appealWithoutSession`.
             *
             * Returned as `Banned` with the right `kind` so the nav graph sends
             * each to its own screen — the suspension one with its end date —
             * rather than to a toast that loses the distinction.
             */
            if (value.outcome == "suspended" || value.outcome == "banned") {
                return AuthResult.Banned(
                    reason = value.reason.ifBlank { value.message },
                    kind = if (value.outcome == "suspended") RestrictionKind.Suspension
                           else RestrictionKind.Account,
                    untilMillis = value.suspendedUntilMs ?: 0L,
                )
            }

            /*
             * ── SAVE THE ROTATION BEFORE ANYTHING ELSE CAN FAIL ──────────────
             *
             * The server destroyed the credential just spent in the same breath
             * as it issued this one. `saved.token` is already dead, so if this
             * write is skipped the device holds a secret that will never work
             * again — and the next tap would report a generic refusal rather
             * than the truth.
             */
            if (value.token.isNotBlank()) {
                quickLogin.save(
                    QuickLoginStore.Saved(
                        token = value.token,
                        displayName = value.displayName.ifBlank { saved.displayName },
                        photoUrl = value.photoUrl.ifBlank { saved.photoUrl },
                    ),
                )
            }

            auth.signInWithCustomToken(value.customToken).await()
            opened = true
            val uid = auth.currentUser?.uid ?: return AuthResult.Error("No user ID")

            gateIdentity(deviceId)?.let { return it }

            ensureUserDocument(uid)
            generateSession(uid, deviceId)
            /*
             * Mint again, now that there is a session.
             *
             * Redundant-looking and not redundant: the rotation above is bound
             * to the key the credential was ORIGINALLY minted against, and this
             * re-registers the key this handset holds today. On the ordinary
             * path they are the same and the mint is a no-op in effect. It is
             * also what keeps the credential's thirty days measured from the
             * last time the account was actually used here.
             */
            mintQuickLoginCredential(deviceId)
            syncRoles()

            if (value.isProfileComplete) AuthResult.Success else AuthResult.ProfileIncomplete
        } catch (e: Exception) {
            /*
             * An error here must not leave the account open.
             *
             * `ensureUserDocument` and `generateSession` can both throw after the
             * custom token has already been redeemed, and reporting a failure over
             * a live, documented session is worse than either outcome on its own:
             * the caller shows an error and moves on, while Splash admits that
             * session on the next cold start and goes straight to Home. In the
             * guest flow that also skips `confirmDeviceBinding` — so a quick-login
             * blob restored onto a SECOND handset would get in without ever being
             * checked against that handset's binding, which is the hole this
             * whole change exists to close.
             *
             * Only when this call opened it. A session that was already live is
             * somebody else's business.
             */
            if (opened) {
                try { signOut(deviceId) } catch (_: Exception) {}
            }
            AuthResult.Error(e.message ?: "Quick sign-in failed")
        }
    }

    /**
     * What a refused redemption means, and whether the credential dies with it.
     *
     * ── WHY THE DETAIL CODE AND NOT THE STATUS CODE ──────────────────────────
     *
     * The server answers nearly every refusal with `permission-denied`,
     * deliberately: telling a caller that a secret "expired" rather than "never
     * existed" tells somebody probing secrets which guesses were close. But the
     * device holding the real credential has to tell those cases apart, because
     * the right action differs — and reading the message text to guess is a
     * string comparison against a sentence somebody will reword.
     *
     * So the server attaches its own name for the outcome in the `details`
     * payload, and this reads that. An empty detail falls back to the old
     * status-code rule, which is what an older server would produce.
     *
     * ── WHAT MAY DESTROY THE ONLY COPY ───────────────────────────────────────
     *
     * The secret is the single copy of a credential the server keeps only a hash
     * of, and for a guest it is one of just two routes back to their account. So
     * it is forgotten only when the server has DISOWNED it:
     *
     *   refused / legacy / banned / deleted  → gone, and it is not coming back
     *   device_banned                        → KEPT. The handset is barred, not
     *                                          the credential; a lifted ban
     *                                          should find it still here
     *   rate_limited                         → KEPT. A cool-off that deleted the
     *                                          credential would turn five wrong
     *                                          attempts into a permanent loss
     *   unreachable server                   → KEPT. Obviously
     */
    private suspend fun refuseQuickLogin(res: MoneyFunctions.Result.Failed): AuthResult {
        if (res.detail.isNotBlank()) {
            return when (res.detail) {
                "device_banned" ->
                    AuthResult.Banned(res.userMessage, RestrictionKind.Device)

                /*
                 * A current server returns `banned` as a PAYLOAD, not an error,
                 * and `signInWithQuickLogin` handles it above. This arm is for an
                 * older one — and it deliberately does NOT clear the credential.
                 *
                 * It used to. That was the bug: a ban revokes the Firebase
                 * session, so clearing the credential as well left the person
                 * with no identifier at all, and the appeal form on the ban
                 * screen is an authenticated write. The credential is what the
                 * session-less appeal is proved with.
                 */
                "banned" -> AuthResult.Banned(res.userMessage, RestrictionKind.Account)

                "rate_limited" -> AuthResult.Error(res.userMessage)

                "legacy" -> {
                    // The migration, from the device's side. Nothing can be
                    // salvaged: the credential was minted before device keys
                    // existed, so no proof of possession can be constructed for
                    // it after the fact. One ordinary sign-in replaces it.
                    quickLogin.clear()
                    AuthResult.Error(res.userMessage)
                }

                "deleted", "refused" -> {
                    quickLogin.clear()
                    AuthResult.Error(
                        "That saved sign-in is no longer valid, so it has been " +
                            "removed. Sign in to continue.",
                    )
                }

                // An outcome this build does not know. Report it, keep the
                // credential: a client that deletes on anything unrecognised
                // deletes on every future addition to the server's vocabulary.
                else -> AuthResult.Error(res.userMessage)
            }
        }

        /*
         * No detail — an older server, or an error the SDK synthesised.
         *
         * `MoneyFunctions.call` reports an unreachable server as `unavailable`
         * and an unexpected body as `internal`, and clearing on those destroys
         * the credential because the train went into a tunnel. Same reasoning as
         * `DEFINITIVE_BIND_REFUSALS`, which this list deliberately mirrors.
         */
        if (res.code !in DEFINITIVE_TOKEN_REFUSALS) {
            return AuthResult.Error(res.userMessage)
        }
        quickLogin.clear()
        val generic = res.userMessage.contains("expired", ignoreCase = true) ||
            res.userMessage.isBlank()
        return AuthResult.Error(
            if (generic) "That saved sign-in is no longer valid, so it has been " +
                "removed. Sign in to continue."
            else res.userMessage,
        )
    }

    /**
     * Is there already an account for this phone or email?
     *
     * Asked BEFORE anything is created, which is the step that was missing
     * entirely: the only identity query in the whole client ran at profile-save
     * time, checked email alone, and refused rather than reconciled.
     */
    suspend fun findExistingAccount(phone: String = "", email: String = ""): List<ExistingAccount> =
        when (val res = money.findExistingAccount(phone, email)) {
            is MoneyFunctions.Result.Ok -> res.value
            is MoneyFunctions.Result.Failed -> emptyList()
        }

    /**
     * Bind a phone or an email the user has JUST VERIFIED.
     *
     * ── THE RULE IS THE SERVER'S, AND IT IS NOT A CHOICE ─────────────────────
     *
     * An earlier version of this asked the person which of two accounts to keep
     * and deleted the other. That was wrong. Receiving an OTP proves you are
     * holding that SIM right now; it does not prove the account attached to it
     * is yours. Numbers get recycled by carriers and handsets get sold, so
     * treating the two as the same thing is an account-takeover route with a
     * polite dialog on it.
     *
     *   nobody holds it              → bound
     *   a LIVE account holds it      → refused outright, that account untouched
     *   a DELETED account holds it   → released and bound, its history left
     *                                  exactly where it is
     *
     * An account inside its 30-day recovery window counts as live: it can still
     * be restored in one tap, and giving its number away would break that.
     */
    suspend fun bindVerifiedIdentity(phone: String = "", email: String = ""): AuthResult =
        when (val res = money.bindVerifiedIdentity(phone, email)) {
            is MoneyFunctions.Result.Ok -> AuthResult.Success
            /*
             * `already-exists` is the one refusal that is not a failure.
             *
             * It is the server's second case — a live account holds this
             * identity — and it is final: there is no retry that turns it into a
             * yes, because nothing about the request is wrong. Returning it as
             * `Error`, alongside a dropped connection and a rules violation, left
             * every caller unable to tell "try again in a moment" from "this
             * number is not yours to take", which are the two opposite things a
             * screen has to say. `linkPhone` below is the caller that has to
             * choose between them.
             *
             * The string is `FirebaseFunctionsException.Code.name`, which is what
             * `MoneyFunctions` records — so it is the SDK's spelling of the
             * server's `already-exists`, not a code either side invented.
             *
             * ── WHY THREE CODES AND NOT ONE ──────────────────────────────────
             *
             * `already-exists` was the only one treated as final, and the other
             * two definitive refusals fell into the retryable bucket:
             *
             *   `permission-denied`  — the observer address. Never bindable, by
             *     anyone, ever. Left attached, the next `resolveIdentity` reads
             *     the observer email off the token and DELETES the account.
             *   `failed-precondition` — the token does not carry the identifier
             *     being bound. No amount of retrying changes a token.
             *
             * Both were answered with "could not be confirmed just now, retry",
             * and both left the provider attached to the Auth account with
             * nothing bound in Firestore — the exact divergence the rollback
             * exists to prevent, reached through the branch that exists to
             * avoid it.
             */
            is MoneyFunctions.Result.Failed ->
                if (res.code in DEFINITIVE_BIND_REFUSALS)
                    AuthResult.IdentityTaken(res.userMessage)
                else AuthResult.Error(res.userMessage)
        }

    /**
     * Attach a phone number to the account that is signed in RIGHT NOW.
     *
     * ── WHY LINK RATHER THAN SIGN IN ─────────────────────────────────────────
     *
     * The app had no linking at all — zero uses of `linkWithCredential` — so a
     * guest who later verified a phone number got a brand-new uid and a
     * brand-new document, and everything on the anonymous account was
     * abandoned: the profile, the photo, the diamonds. Linking keeps the uid, so
     * the guest account simply becomes a phone account with its history intact.
     *
     * A collision means the number is already on another Firebase account. That
     * is not a choice to offer — see `bindVerifiedIdentity`, which decides on
     * the STATE of whoever holds it and refuses outright when they are still
     * live.
     */
    /**
     * @param expectedE164 the number the caller just verified, if it knows it.
     *   Used to refuse binding a DIFFERENT number that is still attached from
     *   an abandoned attempt — see the check in the body.
     */
    suspend fun linkPhone(
        credential: PhoneAuthCredential,
        expectedE164: String = "",
    ): AuthResult {
        val user = auth.currentUser ?: return AuthResult.Error("Not signed in.")
        return try {
            /*
             * The link succeeds on the AUTH side first; the server still decides.
             *
             * Firebase only knows whether the number is attached to another
             * Firebase account. It has no idea whether the account holding it is
             * live, inside a recovery window, or long dead — and that is the
             * whole question. So the document write goes through
             * `bindVerifiedIdentity`, which checks the state and either releases
             * the number from a dead account or refuses.
             *
             * And when it refuses, the link above has to be taken back off —
             * see `undoPhoneLink`, which is the whole reason this is not a
             * one-liner.
             */
            /*
             * ── THE LINK STEP IS IDEMPOTENT ──────────────────────────────
             *
             * A phone provider already on this account means a PREVIOUS run of
             * this same flow linked it and then failed to bind — the
             * leave-it-in-place branch below. Calling `linkWithCredential`
             * again throws `provider-already-linked`, which surfaces as a
             * collision and lands on a terminal "that number is taken" screen
             * telling the person their own number belongs to a stranger. There
             * is no way out of that screen, so the retry the branch below
             * promises was impossible and the account stayed wedged: Auth
             * holding a number that Firestore does not, no phone bound, and —
             * because the server computes guest-ness from `providerData` —
             * Settings no longer showing the row that leads back here.
             *
             * So when the provider is already attached, the link is skipped and
             * the BIND is retried, which is the half that actually failed.
             */
            val alreadyLinked =
                user.providerData.any { it.providerId == PhoneAuthProvider.PROVIDER_ID }

            // The task result, not the singleton. The SDK does mutate the
            // cached user in place, but a blank read here sends an empty map to
            // the callable, which throws `invalid-argument` and gets reported
            // as a generic failure straight after a successful OTP.
            val linked = if (alreadyLinked) {
                try { user.reload().await() } catch (_: Exception) {}
                auth.currentUser
            } else {
                user.linkWithCredential(credential).await().user
            }

            /*
             * The number bound is the one on the ACCOUNT, which after a link is
             * also the one on the token — and the server re-checks that they
             * match (`phoneKey(token['phone_number']) === phone`), so a
             * mismatch is refused rather than mis-bound.
             *
             * That is why a blank read is returned early rather than sent: an
             * empty payload makes the callable throw `invalid-argument`, which
             * would take the leave-the-link branch and wedge the account for
             * the reason described above.
             */
            val number = linked?.phoneNumber ?: auth.currentUser?.phoneNumber ?: ""
            if (number.isBlank()) {
                return undoPhoneLink(
                    AuthResult.Error(
                        "That number could not be read back from your account. Try again."
                    )
                )
            }

            /*
             * ── NEVER BIND A NUMBER THEY DID NOT JUST VERIFY ─────────────
             *
             * `alreadyLinked` cannot tell a dangling link from a phone that is
             * already attached and bound, and reusing it is only right when the
             * retry is for the SAME number. If the person moved on to a
             * different one, skipping the link and binding what is on the
             * account means they receive an SMS for B, tap through, and are
             * told the account is secured — with A on it.
             *
             * Checked here rather than left to `useDifferentNumber`'s unlink,
             * because that unlink is a network call and the only way to reach
             * this state is a bad connection: exactly when it fails too.
             *
             * Digits only. `expectedE164` is assembled from a dial code and a
             * typed number, which is not guaranteed byte-identical to what
             * Firebase stores.
             */
            if (alreadyLinked && expectedE164.isNotBlank() &&
                number.filter { it.isDigit() } != expectedE164.filter { it.isDigit() }
            ) {
                return AuthResult.Error(
                    "A different number is still attached to this account. " +
                    "Choose \"use a different number\" and try again."
                )
            }

            /*
             * Force a token refresh before binding.
             *
             * `bindVerifiedIdentity` refuses anything the CALLER'S TOKEN does
             * not already carry — `phoneKey(token['phone_number']) === phone`.
             * On the `alreadyLinked` retry path above, `reload()` refreshes the
             * user RECORD and leaves the cached ID token alone, so the token
             * still carries no phone number and the bind fails
             * `failed-precondition` for ever — on precisely the path the
             * idempotent link step exists to make retryable.
             *
             * Best-effort: a failure here leaves the old token, and the server
             * refuses, which is the same answer as not trying.
             */
            try { user.getIdToken(true).await() } catch (_: Exception) {}

            val bound = bindVerifiedIdentity(phone = number)
            /*
             * ── ROLL BACK ONLY ON A DEFINITIVE REFUSAL ────────────────────
             *
             * `IdentityTaken` is the server saying no and meaning it: a live
             * account holds this number, and no retry turns that into a yes.
             * The link must come back off.
             *
             * Any other failure is UNKNOWN, and unlinking on an unknown is the
             * worse bet. `MoneyFunctions` reports a connection dropped after
             * the call as `unavailable`, and the server's write is not
             * idempotent-guarded — so the bind can have COMMITTED while the
             * response was lost. Unlinking then produces the mirror image of
             * the divergence `undoPhoneLink` exists to prevent: Firestore says
             * the number is this account's, Auth says it is nobody's, and the
             * number is now held by an account that cannot prove it — locking
             * out its rightful owner indefinitely, because the holder's
             * `accountState` is not `permanently_deactivated`.
             *
             * Leaving the link in place is safe to retry: the server filters
             * holders to `d.id !== uid`, so re-binding from this same account
             * skips the refusal and simply succeeds.
             */
            if (bound is AuthResult.IdentityTaken) return undoPhoneLink(bound)
            if (bound !is AuthResult.Success) {
                return AuthResult.Error(
                    "That number could not be confirmed just now. Open this " +
                    "screen again and retry — nothing has been lost."
                )
            }
            syncRoles()
            /*
             * This account is no longer a guest, and Settings has to stop
             * offering to fix that.
             *
             * `gateIdentity` is the only other writer of this flag and it runs
             * at sign-in, so without this line the "Secure your account"
             * section survived the very act that resolved it — inviting the
             * person to add a number they had just added, which is precisely
             * the defect the flag was introduced to remove.
             */
            // Swallowed on purpose. This is a DataStore write, and the bind has
            // already succeeded — letting an IO failure fall into the catch
            // below would report a successful link as "Could not add that
            // number", and their retry would be a retry of something that
            // already worked. A stale cached flag only means Settings keeps
            // offering a row that is now a no-op.
            try { sessionManager.setGuest(false) } catch (_: Exception) {}
            AuthResult.Success
        } catch (e: FirebaseAuthUserCollisionException) {
            /*
             * Firebase refused the link because the number is on a live
             * Firebase account. Nothing has changed on either side.
             */
            AuthResult.IdentityTaken(
                "This number is already used by another Zipper account. " +
                    "Sign in to that account instead.",
            )
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Could not add that number.")
        }
    }

    /**
     * Drop a phone provider that was linked but never bound, so another number
     * can be tried.
     *
     * Needed because `linkPhone`'s link step is idempotent: a dangling link is
     * REUSED on the next attempt, which is right for a retry of the same number
     * and wrong when the person has chosen a different one. Without this, "use a
     * different number" would verify B by SMS and then bind A, because A is
     * what is on the account and on the token.
     *
     * @return true if there is no phone provider left to drop — including the
     *   case where there was never one, or nobody is signed in.
     */
    suspend fun discardPendingPhoneLink(): Boolean {
        val user = auth.currentUser ?: return true
        if (user.providerData.none { it.providerId == PhoneAuthProvider.PROVIDER_ID }) return true
        return try {
            user.unlink(PhoneAuthProvider.PROVIDER_ID).await()
            try { user.reload().await() } catch (_: Exception) {}
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Take the number back off the Firebase account, because the server would
     * not have it.
     *
     * ── THE DIVERGENCE THIS CLOSES ───────────────────────────────────────────
     *
     * Two stores are written in sequence and only the second one can refuse.
     * `linkWithCredential` attaches the number to the Auth account first;
     * `bindVerifiedIdentity` then asks the server, which is the only side that
     * knows whether the account already holding that number is live. When the
     * answer is no, the number is on THIS Auth account while Firestore says it
     * belongs to somebody else — so an SMS to it signs in here, and every
     * document lookup points there. The refusal would have quietly created the
     * takeover it exists to prevent.
     *
     * Called ONLY on a DEFINITIVE refusal — `IdentityTaken`.
     *
     * It used to run on every non-success, on the reasoning that a bind which
     * died on a bad connection leaves the same two stores disagreeing. That is
     * true, and rolling back is still the wrong answer to it: the server's
     * write is not idempotency-guarded, so a lost response can mean the bind
     * COMMITTED. Unlinking then produces the mirror divergence — Firestore says
     * the number is this account's, Auth says it is nobody's — and the number
     * ends up held by an account that cannot prove it, locking out its rightful
     * owner indefinitely. So a transient failure leaves the link alone, and
     * `linkPhone`'s link step is idempotent so that it can be retried.
     *
     * If the unlink ITSELF fails the two are still apart, and the one thing
     * that must not happen then is telling them it worked: they would walk away
     * believing a number is on their account that nothing server-side will
     * honour, with no prompt ever to look again. So that case is reported as
     * the failure it is, with the state it left behind.
     *
     * @param refusal what the server said, returned unchanged once the account
     *   is genuinely back to how it was.
     */
    private suspend fun undoPhoneLink(refusal: AuthResult): AuthResult {
        val user = auth.currentUser
        val unlinked = if (user == null) false else try {
            user.unlink(PhoneAuthProvider.PROVIDER_ID).await()
            /*
             * Re-read the record afterwards, so the local `FirebaseUser` stops
             * reporting a `phoneNumber` the server has just taken back off it.
             * Screens read that field directly, and one of them showing a number
             * this account was refused is the same divergence again, one layer
             * up. Best-effort: the unlink is the part that matters.
             */
            try { user.reload().await() } catch (_: Exception) {}
            true
        } catch (_: Exception) {
            false
        }

        if (unlinked) return refusal
        return AuthResult.Error(
            "That number could not be added, and we could not put your account " +
            "back the way it was either. Sign out and sign in again — if the " +
            "number is still shown on your account after that, contact support.",
        )
    }

    // ── Email link ───────────────────────────────────────────────────────────
    //
    // ── WHY A LINK AND NOT A PASSWORD ────────────────────────────────────────
    //
    // The whole of this section attaches an EMAIL to a guest account, and it
    // does it with Firebase's passwordless email link. There is no password
    // field here and there must never be one: a password is a second secret for
    // the person to lose, a second thing to phish, and a second recovery flow to
    // build — and it buys nothing the link does not already give, because what
    // the server actually wants is proof that this person reads that mailbox.
    //
    // `signInWithEmailAndPassword` and `createUserWithEmailAndPassword` appear
    // NOWHERE in this app, deliberately. If either ever does, this comment is
    // the one that was ignored.
    //
    // ── "password" IS THE PROVIDER ID, NOT A PASSWORD ────────────────────────
    //
    // `EmailAuthProvider.PROVIDER_ID` is the string "password", and an email
    // link credential attaches under exactly that id — Firebase has one email
    // provider with two sign-in methods on it. So `providerData` gains a
    // "password" entry for an account that has no password at all. That is the
    // id to test and the id to unlink, and it is why every use of it below says
    // so: somebody reading `PROVIDER_ID` and deleting it as dead
    // password-login code would delete the email binding with it.

    /**
     * Where the link in the email comes back to.
     *
     * Built from the project id rather than typed out, so a project rename or a
     * second Firebase project cannot leave a dead domain compiled into the app.
     * `<project>.firebaseapp.com` is the default authorised domain every
     * Firebase project has, and the link must be on an authorised domain or the
     * send is refused server-side.
     *
     * The path is ours and is matched by the App Link intent filter in
     * AndroidManifest.xml. It has to be a real path on a real domain — the
     * action handler redirects to it — so a custom scheme (`com.zipper.app://…`,
     * which is what the reCAPTCHA return uses) is not an option here.
     */
    private fun emailLinkSettings(): ActionCodeSettings {
        // `FirebaseApp.getInstance()` rather than `auth.app`: the default app is
        // the one this `FirebaseAuth` was built from (see the Hilt module), it is
        // initialised in `ZipperApp.onCreate` long before any of this can be
        // reached, and it is the accessor that is unambiguously public API.
        val projectId = FirebaseApp.getInstance().options.projectId.orEmpty()
            .ifBlank { "zipper-83816" }
        return ActionCodeSettings.newBuilder()
            .setUrl("https://$projectId.firebaseapp.com$EMAIL_LINK_RETURN_PATH")
            // False would mean "open the web action handler and finish there",
            // which signs somebody in ON THE WEB and leaves the app's account
            // exactly as unbound as it was.
            .setHandleCodeInApp(true)
            .setAndroidPackageName(BuildConfig.APPLICATION_ID, true, null)
            .build()
    }

    /**
     * Send the sign-in link, and remember the address it went to.
     *
     * The address MUST be stored. The link that comes back carries a one-time
     * code and nothing else — `EmailAuthProvider.getCredentialWithLink` needs
     * the address as well, and by the time the link is tapped the person has
     * been in their mail app and the process may have been killed. Firebase's
     * own documentation calls this out for the same reason. It goes to
     * DataStore rather than to a field on a ViewModel precisely because a field
     * does not survive that.
     *
     * Stored lower-cased and trimmed, which is exactly what `emailKey` on the
     * server does. Sending a differently-cased string would bind an address the
     * server then fails to match against the token.
     */
    suspend fun sendEmailSignInLink(email: String): AuthResult {
        val address = email.trim().lowercase()
        if (address.isBlank()) return AuthResult.Error("Enter your email address.")
        return try {
            auth.sendSignInLinkToEmail(address, emailLinkSettings()).await()
            // After the send, not before: an address we failed to send to is not
            // one to complete a binding with.
            sessionManager.setPendingEmailLink(address)
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "We could not send that email. Check the address and try again.")
        }
    }

    /** The address the last link was sent to, or "" if there is not one. */
    suspend fun pendingEmailAddress(): String =
        try { sessionManager.pendingEmailLink.first() } catch (_: Exception) { "" }

    /**
     * Attach an email address to the account that is signed in RIGHT NOW.
     *
     * The email twin of [linkPhone], and deliberately the same shape — read that
     * one first; the reasoning behind every branch is written out there and only
     * the parts that differ are repeated here.
     *
     * @param emailLink the link Firebase sent, as it arrived from the intent.
     * @param expectedEmail the address it was sent to. See [sendEmailSignInLink]
     *   for why this has to be carried rather than read out of the link.
     */
    suspend fun linkEmail(emailLink: String, expectedEmail: String): AuthResult {
        val user = auth.currentUser ?: return AuthResult.Error("Not signed in.")
        val address = expectedEmail.trim().lowercase()
        if (address.isBlank()) {
            return AuthResult.Error(
                "We no longer have the address that link was sent to. " +
                "Enter it again and we will send a new one.",
            )
        }
        /*
         * Asked before anything is attempted, because this is the one failure
         * with a plain cause: the intent that opened the app was not a sign-in
         * link at all — a stale link from a previous attempt, or any other
         * https link the filter happened to match.
         */
        if (!auth.isSignInWithEmailLink(emailLink)) {
            return AuthResult.Error(
                "That link is not a sign-in link, or it has already been used. " +
                "Send yourself a new one.",
            )
        }
        return try {
            /*
             * ── THE LINK STEP IS IDEMPOTENT ──────────────────────────────
             *
             * Same reason as `linkPhone`. A "password" provider already on this
             * account means a previous run linked it and then failed to bind —
             * the leave-it-in-place branch below. Calling `linkWithCredential`
             * again throws `provider-already-linked`, which surfaces as a
             * collision and lands on a terminal "that address is taken" screen
             * about the person's own address, with no way out of it and the
             * account wedged: Auth holding an address Firestore does not, and
             * Settings no longer offering the row that leads back here because
             * the server computes guest-ness from `providerData`.
             *
             * So when it is already attached the link is skipped and the BIND is
             * retried, which is the half that failed.
             */
            val alreadyLinked =
                user.providerData.any { it.providerId == EmailAuthProvider.PROVIDER_ID }

            val linked = if (alreadyLinked) {
                try { user.reload().await() } catch (_: Exception) {}
                auth.currentUser
            } else {
                user.linkWithCredential(
                    EmailAuthProvider.getCredentialWithLink(address, emailLink),
                ).await().user
            }

            val bound = linked?.email?.trim()?.lowercase()
                ?: auth.currentUser?.email?.trim()?.lowercase()
                ?: ""
            if (bound.isBlank()) {
                return undoEmailLink(
                    AuthResult.Error(
                        "That address could not be read back from your account. Try again."
                    )
                )
            }

            /*
             * ── NEVER BIND AN ADDRESS THEY DID NOT JUST PROVE ────────────
             *
             * `alreadyLinked` cannot tell a dangling link from an address that
             * is attached and already bound, and reusing it is only right when
             * the retry is for the SAME address. If they moved on to a
             * different one, skipping the link and binding what is on the
             * account means they open a link for B and are told the account is
             * secured — with A on it.
             */
            if (alreadyLinked && bound != address) {
                return AuthResult.Error(
                    "A different address is still attached to this account. " +
                    "Choose \"use a different address\" and try again."
                )
            }

            /*
             * ── THE TOKEN HAS TO CARRY THE ADDRESS, AND MAY NOT YET ──────
             *
             * `bindVerifiedIdentity` refuses anything the CALLER'S TOKEN does
             * not already hold (`emailKey(token['email']) === email`), and a
             * callable sends whatever ID token is cached — up to an hour old.
             *
             * On the fresh-link branch the SDK has just been handed new tokens
             * by the link response, so that one is fine. On the `alreadyLinked`
             * retry it is NOT: `reload()` refreshes the user record and leaves
             * the token alone, so the cached token is the one minted before the
             * link and carries no email at all. The bind would fail
             * `failed-precondition` for ever, on exactly the retry path the
             * idempotent link step exists to make work.
             *
             * Forced, and best-effort. If the refresh itself fails the cached
             * token may still be good, so the bind is attempted anyway; the
             * worst case is the transient branch below, which is retryable.
             */
            try { user.getIdToken(true).await() } catch (_: Exception) {}

            val result = bindVerifiedIdentity(email = bound)
            /*
             * ── ROLL BACK ONLY ON A DEFINITIVE REFUSAL ────────────────────
             *
             * `IdentityTaken` is the server saying no and meaning it, so the
             * link comes back off. Every other failure is UNKNOWN, and
             * unlinking on an unknown is the worse bet for the reason set out
             * at length in `linkPhone` and `undoPhoneLink`: a dropped
             * connection is reported as `unavailable` while the server's write
             * may have COMMITTED, and unlinking then leaves the address held in
             * Firestore by an account that cannot prove it — locking out the
             * rightful owner. Leaving the link is safe to retry, because the
             * server filters holders to `d.id !== uid`.
             */
            if (result is AuthResult.IdentityTaken) return undoEmailLink(result)
            if (result !is AuthResult.Success) {
                return AuthResult.Error(
                    "That address could not be confirmed just now. Open this " +
                    "screen again and retry — nothing has been lost."
                )
            }
            syncRoles()
            // The binding is done; the stored address has no further use and is
            // a record of somebody's email sitting in DataStore until it does.
            try { sessionManager.clearPendingEmailLink() } catch (_: Exception) {}
            /*
             * No longer a guest, and Settings has to stop offering to fix that.
             * Swallowed for the same reason as in `linkPhone`: this is a
             * DataStore write after a bind that has already succeeded, and
             * letting an IO failure reach the catch below would report a
             * finished binding as a failure and send them to retry something
             * that worked.
             */
            try { sessionManager.setGuest(false) } catch (_: Exception) {}
            AuthResult.Success
        } catch (e: FirebaseAuthUserCollisionException) {
            /*
             * Firebase refused the link because the address is on a live
             * Firebase account. Nothing has changed on either side.
             */
            AuthResult.IdentityTaken(
                "This email is already used by another Zipper account. " +
                    "Sign in to that account instead.",
            )
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Could not add that email address.")
        }
    }

    /**
     * Drop an email provider that was linked but never bound, so another
     * address can be tried.
     *
     * The twin of [discardPendingPhoneLink], and needed for the same reason:
     * [linkEmail]'s link step is idempotent, so a dangling link is REUSED on the
     * next attempt — right for retrying the same address, wrong once the person
     * has chosen a different one.
     *
     * The stored address goes too. It is the input to the next
     * `getCredentialWithLink`, and leaving the old one there is how somebody
     * opens the link for B and has it decoded against A.
     *
     * @return true if there is no email provider left to drop — including the
     *   case where there was never one, or nobody is signed in.
     */
    suspend fun discardPendingEmailLink(): Boolean {
        try { sessionManager.clearPendingEmailLink() } catch (_: Exception) {}
        val user = auth.currentUser ?: return true
        if (user.providerData.none { it.providerId == EmailAuthProvider.PROVIDER_ID }) return true
        return try {
            user.unlink(EmailAuthProvider.PROVIDER_ID).await()
            try { user.reload().await() } catch (_: Exception) {}
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Take the address back off the Firebase account, because the server would
     * not have it.
     *
     * The twin of [undoPhoneLink] — the same two-store divergence, the same
     * rule that it runs ONLY on a definitive refusal, and the same refusal to
     * report a failed rollback as a success. Read that one for the whole
     * argument.
     *
     * @param refusal what the server said, returned unchanged once the account
     *   is genuinely back to how it was.
     */
    private suspend fun undoEmailLink(refusal: AuthResult): AuthResult {
        val user = auth.currentUser
        val unlinked = if (user == null) false else try {
            user.unlink(EmailAuthProvider.PROVIDER_ID).await()
            // So the local `FirebaseUser` stops reporting an `email` the server
            // has just taken back off it.
            try { user.reload().await() } catch (_: Exception) {}
            true
        } catch (_: Exception) {
            false
        }

        if (unlinked) return refusal
        return AuthResult.Error(
            "That address could not be added, and we could not put your account " +
            "back the way it was either. Sign out and sign in again — if the " +
            "address is still shown on your account after that, contact support.",
        )
    }

    private suspend fun signInWithCredential(
        credential: PhoneAuthCredential,
        deviceId: String = "",
    ): AuthResult {
        return try {
            val result = auth.signInWithCredential(credential).await()
            val uid = result.user?.uid ?: return AuthResult.Error("No user ID")
            val isNew = result.additionalUserInfo?.isNewUser == true
            if (isNew) {
                createUserDocument(uid, result.user?.phoneNumber ?: "")
            } else {
                /*
                 * The ban check used to live HERE, and it was wrong twice over.
                 *
                 * It read `isBanned`, which is true for a SUSPENSION as well as
                 * a ban — so a seven-day suspension returned `banned:<reason>`
                 * and landed on the permanent-ban screen with no end date, on
                 * the two commonest sign-in paths in the app.
                 *
                 * And it called `banDevice(...)`, barring the handset for a
                 * suspension, which is precisely the thing a suspension is
                 * defined not to do. It barred the STORED device id at that —
                 * written once at profile setup and never refreshed — so it
                 * barred the phone they signed up on rather than the one in
                 * their hand, and the write was refused by the rules and
                 * swallowed regardless.
                 *
                 * `gateIdentity` below asks the server, which distinguishes
                 * suspended from banned from device-banned and bars the right
                 * device with the Admin SDK. The session is still KEPT either
                 * way: the banned screen is where somebody appeals, an appeal is
                 * a write about their own account, and with no session there is
                 * no appeal.
                 */
            }
            // Asked BEFORE anything is created — observer, deleted account,
            // CRM role, missing contact details. See `gateIdentity`.
            gateIdentity(deviceId)?.let { return it }

            // The document must exist before a session is written to it — see
            // `ensureUserDocument` for the sign-in that was impossible without
            // this.
            if (!isNew) ensureUserDocument(uid)
            generateSession(uid, deviceId)
            mintQuickLoginCredential(deviceId)
            // Agent / seller / official / CRM role badges, read server-side
            // from `crmUsers/{uid}` — the same document `resolveIdentity`
            // reads, so the two can never disagree.
            syncRoles()
            if (isNew) AuthResult.ProfileIncomplete
            else {
                val snap = firestore.collection("users").document(uid).get().await()
                if (snap.getBoolean("isProfileComplete") == true) AuthResult.Success else AuthResult.ProfileIncomplete
            }
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Sign in failed")
        }
    }

    // ── Google Sign-In ────────────────────────────────────────────────────────

    suspend fun signInWithGoogle(idToken: String, deviceId: String = ""): AuthResult {
        return try {
            val credential = GoogleAuthProvider.getCredential(idToken, null)
            val result = auth.signInWithCredential(credential).await()
            val uid = result.user?.uid ?: return AuthResult.Error("No user ID")
            val isNew = result.additionalUserInfo?.isNewUser == true
            if (isNew) {
                createUserDocument(
                    uid = uid,
                    phone = "",
                    name = result.user?.displayName ?: "",
                    photoUrl = result.user?.photoUrl?.toString() ?: "",
                )
            } else {
                // Same as the phone path above: the ban check moved into
                // `gateIdentity`, which can tell a suspension from a ban and
                // bars the device actually in use rather than the one the
                // account was created on.
            }
            // Asked BEFORE anything is created — observer, deleted account,
            // CRM role, missing contact details. See `gateIdentity`.
            gateIdentity(deviceId)?.let { return it }

            // The document must exist before a session is written to it — see
            // `ensureUserDocument` for the sign-in that was impossible without
            // this.
            if (!isNew) ensureUserDocument(uid)
            generateSession(uid, deviceId)
            mintQuickLoginCredential(deviceId)
            // Agent / seller / official / CRM role badges, read server-side
            // from `crmUsers/{uid}` — the same document `resolveIdentity`
            // reads, so the two can never disagree.
            syncRoles()
            if (isNew) AuthResult.ProfileIncomplete
            else {
                val snap = firestore.collection("users").document(uid).get().await()
                if (snap.getBoolean("isProfileComplete") == true) AuthResult.Success else AuthResult.ProfileIncomplete
            }
        } catch (e: FirebaseAuthUserCollisionException) {
            /*
             * This address already has an account, entered some other way.
             *
             * With "one account per email address" on, Firebase refuses the
             * Google credential rather than quietly attaching it to the
             * existing account — because attaching it silently would let
             * anyone holding the Gmail take over an account with the same
             * address. The refusal is the safety property, not the bug.
             *
             * NOTHING IS CREATED HERE. `signInWithCredential` threw, so there
             * is no new uid and no second user document; the `signOut` below
             * only clears whatever partial state the SDK left behind. That is
             * the requirement — a provider conflict must never become a
             * duplicate account.
             *
             * ── WHY THE MESSAGE CHANGED ──────────────────────────────────
             *
             * It used to say "Sign in with your phone number instead, and add
             * this email to your profile." Both halves were wrong for the
             * people who actually hit this. The owners had no phone number on
             * their accounts at all, so the advice sent them to a door that
             * did not open; and adding the email to a profile does nothing —
             * `syncMyRoles` reads `crmUsers/{uid}`, not a profile field, so
             * the advice described a mechanism that had already been removed.
             *
             * The real remedy is to link the two providers onto the one uid,
             * and that is done in the CRM, where the password can be demanded
             * as proof. Once linked, this exception stops happening: the
             * Google credential resolves straight to the canonical account,
             * here and on the web.
             *
             * Phone OTP is offered as the immediate way in because linking
             * makes the number resolve to that same account too.
             */
            try { auth.signOut() } catch (_: Exception) {}
            AuthResult.IdentityTaken(
                "This email already belongs to a Zipper account that signs in a " +
                "different way. Sign in with your phone number, or open the CRM " +
                "and use Settings → Connect Google once — after that, Google " +
                "works here too."
            )
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Google sign-in failed")
        }
    }

    // ── Guest ─────────────────────────────────────────────────────────────────

    /**
     * Continue as a guest.
     *
     * ── THE BUG THIS REPLACES, WHICH WAS THE WORST ONE IN THE APP ────────────
     *
     * This used to call `signInAnonymously()` unconditionally and then
     * `createUserDocument` unconditionally, with no `isNewUser` check anywhere.
     * Combined with `signOut()` — which destroys an anonymous credential
     * permanently, because the locally persisted token IS the entire credential
     * and nothing else in existence proves ownership of that uid — every single
     * guest logout minted a brand-new account and a brand-new document. Tap
     * guest, sign out, tap guest: two accounts. Repeat all afternoon.
     *
     * Three things fix it:
     *
     *   1. REUSE the anonymous session if one is still alive. `signInAnonymously`
     *      on a live anonymous session returns the same user, but the code then
     *      rewrote the document over the top of a real profile — see
     *      `createUserDocument`, which now refuses to.
     *   2. QUICK LOGIN first, in the caller, so a returning guest gets their old
     *      account back rather than a new one even after a reinstall.
     *   3. The document is written only when it is genuinely absent.
     *
     * ── AND WHY THAT WAS STILL NOT ENOUGH ────────────────────────────────────
     *
     * All three are local checks, and every one of them answers "no guest here"
     * when the truthful answer is "I cannot tell". A live session is absent after
     * a reinstall; a quick-login secret is absent when Block Store does not
     * answer. Both then fell through to `signInAnonymously()` — so the fallback
     * for *not knowing* was to create a second account, which is the exact
     * failure the three fixes above were written to stop, still reachable by the
     * one route nobody was testing.
     *
     * The device asks the server now, and `signInAnonymously()` runs ONLY on a
     * positive `no_guest`. Every other answer, including a failure to get one, is
     * a refusal rather than a new account. See `claimGuestIdentity` in
     * functions/src/identity.ts.
     */
    suspend fun signInAsGuest(deviceId: String = ""): AuthResult {
        getDeviceBanReason(deviceId)?.let { return AuthResult.Banned(it, RestrictionKind.Device) }

        return try {
            /*
             * An anonymous session that is still alive is the SAME person. Do
             * not mint a second one on top of it.
             *
             * `isAnonymous` alone is not the test, because it is a one-way
             * door: `linkWithCredential` clears it and `unlink` does not put it
             * back. So a guest who tried to add a phone number and was refused
             * — the rollback path in `undoPhoneLink` — came back here reporting
             * false, `signInAnonymously()` ran on top of their live session,
             * and they got a NEW uid and a NEW document while their profile,
             * diamonds and history stayed on the old one. The duplicate-account
             * bug, reached through the screen built to prevent it.
             *
             * `providerData` is the account rather than the session: no entry
             * other than the synthetic `firebase` one means nothing has ever
             * been attached, which is what "still a guest" actually means.
             */
            val existing = auth.currentUser?.takeIf { u ->
                u.isAnonymous || u.providerData.none { it.providerId != "firebase" }
            }

            /*
             * ── SIGNED OUT IS NOT THE SAME AS GONE ───────────────────────
             *
             * With no live session this used to go straight to
             * `signInAnonymously()`, which mints a NEW uid and a NEW document.
             * So a guest who signed out and tapped "Continue as guest" again
             * got a second account, and a third, and a fourth — their diamonds,
             * level and history stranded on the first one with no way back to
             * it. That is the repeated-signup defect stated plainly: one person,
             * users/123, users/456, users/789.
             *
             * The saved quick-login secret is the FAST way back — no custom-token
             * round trip through the guest binding, and it restores the display
             * name and photo the button already showed. Tried first for that
             * reason only; the device binding below is what guarantees
             * correctness when it is missing, so a failure here is no longer
             * allowed to fall through to a new account.
             */
            val secret = deviceSecret.getOrCreate()
                ?: return AuthResult.Error(
                    "Couldn't check this device's guest account. Check your " +
                    "connection and try again, or sign in with Google or your " +
                    "phone number."
                )

            /*
             * `savedQuickLogin()` rather than `quickLogin.load()`, and the
             * difference matters here more than anywhere.
             *
             * It returns null when this handset has no device key — a reinstall,
             * or a credential minted before device keys existed. On the login
             * screen that only hides a button. HERE, taking the branch with no
             * usable credential would spend the guest's one chance on a
             * redemption certain to be refused, and a failed resume is terminal
             * by design, so they would be told to "sign in once" when they have
             * no other way in.
             *
             * Skipping the branch instead falls through to `claimGuestIdentity`
             * below, which recovers this device's guest from the device secret —
             * the route that does not need a key at all. Legacy quick-login
             * credentials therefore cost a guest nothing.
             */
            if (existing == null && savedQuickLogin() != null) {
                val resumed = signInWithQuickLogin(deviceId)
                /*
                 * Succeeded — but a quick-login credential proves which ACCOUNT
                 * was last signed out HERE, and the device's guest slot is a
                 * separate fact that can disagree with it. So the recovered uid
                 * is checked against this device's binding before it is accepted.
                 *
                 * The disagreement is narrower than it was. Quick login is now
                 * signature-bound and no longer cloud-backed, so a credential
                 * cannot arrive from another handset. The DEVICE SECRET still
                 * can — it is deliberately backed up, because carrying a guest
                 * account across a device transfer is what it is for — so the
                 * two can still name different accounts, and this check is what
                 * decides between them.
                 *
                 * This is also how every guest who already exists acquires a
                 * binding. They have a quick-login credential and no binding, so
                 * the check answers `bound` and records the account they already
                 * have — no migration script, and it happens on their next
                 * sign-in.
                 */
                if (resumed is AuthResult.Success || resumed is AuthResult.ProfileIncomplete) {
                    val recovered = auth.currentUser?.uid.orEmpty()
                    val check =
                        if (recovered.isEmpty()) BindingCheck.Agrees
                        else confirmDeviceBinding(deviceId, secret, recovered)
                    when (check) {
                        BindingCheck.Agrees -> return resumed

                        /*
                         * THE SESSION HAS TO GO WITH THE REFUSAL.
                         *
                         * By now `signInWithQuickLogin` has done everything:
                         * signed in, gated, written the document, claimed the
                         * one-device mobile session and minted a fresh secret.
                         * Returning a refusal on top of that would be a lie —
                         * the account IS open, and `SplashScreen` admits any live
                         * session with a document, so the next cold start walks
                         * straight into it and never asks again.
                         *
                         * `signOut` rather than a bare `auth.signOut()`: the
                         * mobile session and the push token have to be released
                         * too. It re-mints the secret on the way out, so the
                         * saved-account button the refusal points at still works.
                         */
                        is BindingCheck.Refuse -> {
                            signOut(deviceId)
                            return check.result
                        }

                        /*
                         * ── THE SAVED ACCOUNT IS NOT A GUEST ────────────────
                         *
                         * Quick login restores whatever was last signed in on
                         * this handset, and that is often an email or Google
                         * account. Returning it from the GUEST button was wrong
                         * twice over: the person asked for a guest session and
                         * got their real account, and the device's guest slot was
                         * about to be filled with an account that is not a guest
                         * — which would have barred that handset from ever having
                         * one.
                         *
                         * So let go of it and carry on below as if there had been
                         * no saved sign-in at all. `existing` is already null on
                         * this path, so the server is asked the plain question and
                         * either hands back this device's real guest or agrees
                         * that it may have its first.
                         */
                        BindingCheck.NotTheDevicesGuest -> signOut(deviceId)
                    }
                } else {
                    /*
                     * ── A FAILED RESUME IS TERMINAL. IT MUST NOT FALL THROUGH ──
                     *
                     * This used to continue into the create path on an Error, and
                     * that is the stranded-balance bug by a longer route. A saved
                     * sign-in that could not be USED is not evidence that the
                     * device has no guest — it is evidence of the opposite — and
                     * the server cannot know better, because for a guest who
                     * predates the binding this secret was the only record of
                     * them. Asked with no uid it answers `no_guest`, perfectly
                     * correctly, and a new account would be minted and bound.
                     *
                     * So: say what happened and stop. When the token really is
                     * dead `signInWithQuickLogin` forgets it, so the next tap
                     * finds no saved sign-in and takes the create path honestly.
                     *
                     * Banned, suspended and awaiting-a-deletion-choice come
                     * through here too, and all three belong to `gateIdentity`.
                     */
                    return resumed
                }
            }

            /*
             * ── THE DEVICE'S OWN GUEST ACCOUNT ───────────────────────────
             *
             * Asked before anything is created, and asked of the server, because
             * the client cannot answer it. Reached with a live anonymous session
             * too: `existing` proves the session belongs to a guest, not that it
             * belongs to THIS DEVICE's guest, and a session restored from a
             * cloud backup onto a second handset is exactly that case.
             */
            val guest = when (
                val claim = money.claimGuestIdentity(deviceId, secret, uid = existing?.uid.orEmpty())
            ) {
                is MoneyFunctions.Result.Ok -> claim.value
                /*
                 * FAIL CLOSED. The old code's instinct here — carry on and make
                 * an account — is precisely the bug: a network blip becomes a
                 * duplicate account holding none of the person's balance, and
                 * nothing afterwards can tell the two apart or put them back
                 * together. A retry costs a tap.
                 */
                is MoneyFunctions.Result.Failed -> return AuthResult.Error(claim.userMessage)
            }

            when (guest.status) {
                "existing_guest" -> {
                    /*
                     * This device's guest, recovered. Not a new one.
                     *
                     * If we arrived holding a DIFFERENT anonymous session, it is
                     * discarded rather than left behind. The server only answered
                     * `existing_guest` instead of `conflict` because that session
                     * has no document — nothing in it to lose — and an abandoned
                     * Auth record with no document is exactly what
                     * `discardUnboundGuest` exists to stop accumulating.
                     */
                    if (existing != null && existing.uid != guest.uid) {
                        discardUnboundGuest(existing.uid)
                    }
                    adoptBoundGuest(guest)?.let { return it }
                }

                "bound" -> Unit // The live session we arrived with is now this device's guest.

                "no_guest" -> {
                    /*
                     * The one branch permitted to create an account, and only
                     * because the server has just confirmed this device has
                     * never had one.
                     *
                     * Bound immediately afterwards. If that bind is refused, a
                     * guest was created between the two calls — another process
                     * on this handset — and the answer is to use THAT one rather
                     * than keep the account just made, which would be the second
                     * account all over again.
                     */
                    val fresh = auth.signInAnonymously().await().user?.uid
                        ?: return AuthResult.Error("No user ID")
                    val bound = when (
                        val bind = money.claimGuestIdentity(deviceId, secret, uid = fresh)
                    ) {
                        is MoneyFunctions.Result.Ok -> bind.value
                        is MoneyFunctions.Result.Failed -> {
                            /*
                             * KEPT, not discarded, unless the refusal is
                             * definitive.
                             *
                             * The bind is a transaction with no idempotency key,
                             * so a lost response means it may well have
                             * COMMITTED. Deleting `fresh` then leaves the binding
                             * pointing at an Auth record that no longer exists,
                             * and the device is told `unrecoverable` until the
                             * grace window expires. Keeping the session costs
                             * nothing: the next attempt arrives holding `fresh`,
                             * and the server answers `existing_guest` if the
                             * write landed and `bound` if it did not. Either way
                             * the person ends up in the right account.
                             */
                            if (bind.code in DEFINITIVE_CLAIM_REFUSALS) {
                                discardUnboundGuest(fresh)
                            }
                            return AuthResult.Error(bind.userMessage)
                        }
                    }
                    if (bound.status == "existing_guest") {
                        // Another process on this handset won the race. Its
                        // account is the device's guest; this one is discarded.
                        discardUnboundGuest(fresh)
                        adoptBoundGuest(bound)?.let { return it }
                    } else if (bound.status != "bound") {
                        discardUnboundGuest(fresh)
                        return guestRefusal(bound)
                    }
                }

                else -> return guestRefusal(guest)
            }

            val uid = auth.currentUser?.uid ?: return AuthResult.Error("No user ID")

            // A guest cannot be the observer and cannot hold a CRM role, but
            // they CAN be a deleted account coming back through quick login, so
            // the gate runs here too.
            gateIdentity(deviceId)?.let { return it }

            createUserDocument(uid, phone = "", name = "")
            generateSession(uid, deviceId)
            mintQuickLoginCredential(deviceId)

            /*
             * A returning guest whose profile is finished goes Home. The old code
             * returned ProfileIncomplete unconditionally and marched them back
             * through setup every time.
             *
             * It also re-checked `isBanned` here, and that check was WRONG twice
             * over. `gateIdentity` above already refuses a banned, suspended or
             * device-banned account — this ran after it, so it could only ever
             * fire on a restriction the gate had already cleared. And `isBanned`
             * is true for a suspension as well, which it reported as
             * `RestrictionKind.Account` with no end date: a seven-day suspension
             * rendered as a permanent ban, which is the exact defect the three
             * restriction kinds were introduced to remove. The Google and phone
             * paths never had it.
             */
            val snap = firestore.collection("users").document(uid).get().await()
            if (snap.getBoolean("isProfileComplete") == true) AuthResult.Success
            else AuthResult.ProfileIncomplete
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Guest sign-in failed")
        }
    }

    /** What this device's binding says about an account that just signed in. */
    private sealed interface BindingCheck {
        /** It is this device's guest, or has just been recorded as it. Carry on. */
        data object Agrees : BindingCheck
        /**
         * Not a guest at all, so it has no claim on the guest slot and the slot
         * has no claim on it. Let go of the session and ask again without it.
         */
        data object NotTheDevicesGuest : BindingCheck
        /** Stop, and show this. */
        data class Refuse(val result: AuthResult) : BindingCheck
    }

    /**
     * Check a recovered account against this device's guest binding.
     *
     * [BindingCheck.Agrees] also covers the case where there was no binding and
     * this call created one, which is how a guest who predates the binding model
     * acquires one — on their next sign-in, with no migration script.
     *
     * A disagreement between two GUEST accounts is not resolved here and must not
     * be. Two accounts with data in them and one device is a question about whose
     * data matters, and a login flow is the worst possible place to answer it: the
     * losing side is silently abandoned and nothing tells anybody it happened.
     */
    private suspend fun confirmDeviceBinding(
        deviceId: String,
        secret: String,
        uid: String,
    ): BindingCheck {
        val claim = when (val res = money.claimGuestIdentity(deviceId, secret, uid = uid)) {
            is MoneyFunctions.Result.Ok -> res.value
            // The account is already signed in and gated, so this is not worth
            // undoing a good sign-in for. The binding is confirmed next time.
            is MoneyFunctions.Result.Failed -> return BindingCheck.Agrees
        }
        return when (claim.status) {
            // Agreed, or just recorded. Either way this account owns the device.
            // `existing_guest` covers the upgraded-but-same-account case: the
            // server accepts a verified session for the bound uid as proof.
            "existing_guest", "bound" -> BindingCheck.Agrees
            "not_a_guest" -> BindingCheck.NotTheDevicesGuest
            else -> BindingCheck.Refuse(guestRefusal(claim))
        }
    }

    /**
     * Throw away an anonymous account that was created and then not bound.
     *
     * `delete()` rather than `signOut()`, because signing out of an anonymous
     * account leaves an Auth record nothing can ever reach again — the locally
     * persisted token IS the whole credential — and an unbound one has no
     * document, no balance and no route back. Left alone they simply accumulate.
     *
     * The uid and `isAnonymous` are both checked, so this cannot reach an
     * account that matters however it is called. `signOut` is the fallback: the
     * session must not survive either way.
     */
    private suspend fun discardUnboundGuest(uid: String) {
        val doomed = auth.currentUser?.takeIf { it.uid == uid && it.isAnonymous } ?: return
        try {
            doomed.delete().await()
        } catch (_: Exception) {
            try { auth.signOut() } catch (_: Exception) {}
        }
    }

    /**
     * Take up the guest account the server says belongs to this device.
     *
     * Returns null on success, or the failure to hand back.
     *
     * Two shapes of `existing_guest` arrive here and the difference is not an
     * inconsistency. With a custom token there was no session and the token is
     * the way in. Without one, the caller was ALREADY signed in as that account
     * and said so with a verified ID token — which is how it re-keyed a binding
     * whose device secret had been lost. Minting a second credential for a
     * session that is already open would be pointless, so the server does not.
     */
    private suspend fun adoptBoundGuest(claim: MoneyFunctions.GuestClaim): AuthResult? {
        if (auth.currentUser?.uid == claim.uid && claim.uid.isNotBlank()) return null
        if (claim.customToken.isBlank()) {
            return AuthResult.Error("Couldn't restore this device's guest account.")
        }
        auth.signInWithCustomToken(claim.customToken).await()
        return null
    }

    /**
     * What to say when the server will not release this device's guest account.
     *
     * Every branch here refuses. None of them creates a replacement, and that is
     * the point: an empty second account is not a lesser version of getting your
     * balance back, it is a worse outcome than being told plainly, because it
     * looks like success and is not.
     *
     * Google and phone are offered because they genuinely work — they resolve to
     * a real account of their own and do not depend on this device's binding.
     */
    private fun guestRefusal(claim: MoneyFunctions.GuestClaim): AuthResult = when (claim.status) {
        "device_banned" -> AuthResult.Banned(
            claim.reason.ifBlank { "This device has been barred." },
            RestrictionKind.Device,
        )
        "unrecoverable" -> AuthResult.IdentityTaken(
            "This device already has a guest account, but this installation " +
            "can't prove it owns it — that happens when the app's saved key was " +
            "lost. Sign in with Google or your phone number, or contact support " +
            "to have the guest account released."
        )
        /*
         * Two accounts, both with something in them, one handset. Nothing is
         * chosen and nothing is merged — see `decideGuestClaim`. The person is
         * pointed at the two doors that are unambiguous.
         */
        /*
         * Worded for both routes that reach it. One arrives with no session, the
         * other with a session that was already live and is deliberately left
         * alone — so this must not claim that nothing was opened, which was the
         * earlier wording and was false in the second case.
         */
        "conflict" -> AuthResult.IdentityTaken(
            "This device's guest account and the account saved on it are two " +
            "different accounts. Nothing was merged or changed. To use the saved " +
            "one, tap it on the sign-in screen — or sign in with Google or your " +
            "phone number."
        )
        /*
         * The device's account grew up. Its own credentials are the way in now,
         * and the guest button is deliberately not a second one — otherwise
         * anybody holding the handset after a sign-out would reach it.
         */
        "upgraded" -> AuthResult.IdentityTaken(
            "This device's account now signs in with Google or a phone number. " +
            "Use one of those to continue."
        )
        else -> AuthResult.Error("Couldn't start a guest session. Please try again.")
    }

    // ── User document ─────────────────────────────────────────────────────────

    /**
     * Create the user document, or leave an existing one alone.
     *
     * ── THE TWO THINGS THAT WERE WRONG ───────────────────────────────────────
     *
     * It had **no existence guard** and it used `set()` **without merge**. On
     * the guest path it was also called with no `isNewUser` check at all, so
     * tapping "Continue as Guest" a second time on a live anonymous session
     * rewrote the document in place: `name` back to `Guest_xxxxxx`, `photoUrl`
     * back to empty, `isProfileComplete` back to false, `createdAt` moved to
     * now. A profile, erased by pressing the same button twice.
     *
     * And once the document had picked up any server-written field, the same
     * write was REFUSED: `set()` without merge removes the keys it does not
     * name, so `diamonds` and `level` landed in `affectedKeys()` and
     * `ownerProtectedFields()` denied it. The user saw "Guest sign-in failed"
     * and had no way to get in at all.
     *
     * Now it reads first and returns if the document is there. The write stays
     * an explicit map rather than `set(User(...))` for the original reason: the
     * create rule refuses a document naming `diamonds`, `beans`, `level` or any
     * other protected key, because a client that may write `diamonds: 0` at
     * creation may write `diamonds: 999999`. The server reads an absent balance
     * as zero everywhere, so omitting them is not "no balance" — it is "the
     * balance is the server's to write".
     *
     * @return true when a document was created, false when one already existed.
     */
    private suspend fun createUserDocument(
        uid: String,
        phone: String,
        name: String = "",
        photoUrl: String = "",
    ): Boolean {
        val ref = firestore.collection("users").document(uid)
        if (ref.get().await().exists()) return false

        ref.set(
            mapOf(
                "uid" to uid,
                "name" to name,
                "photoUrl" to photoUrl,
                "phoneNumber" to phone,
                "isProfileComplete" to false,
                "createdAt" to com.google.firebase.Timestamp.now(),
                "lastSeen" to System.currentTimeMillis(),
            )
        ).await()
        return true
    }

    /**
     * The gate every sign-in passes through before anything is created.
     *
     * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
     *
     * The client used to decide everything from Firebase's `isNewUser` flag:
     * true meant "write a document", false meant "read one". That one boolean
     * cannot ask any of the questions that actually matter — is this the
     * observer, has this account been deleted, does this person hold a CRM
     * role, do they still owe us a phone number — so none of them were asked.
     * The answers turned up later as duplicate accounts and permission errors
     * nobody could trace back here.
     *
     * Now the app authenticates, asks the server once, and obeys.
     *
     * @return null to carry on, or the [AuthResult] to return immediately.
     */
    private suspend fun gateIdentity(deviceId: String): AuthResult? {
        /*
         * ── FAIL CLOSED, AFTER ONE RETRY ─────────────────────────────────
         *
         * This used to `return null` on any server failure — carry on — and
         * the comment above it claimed the opposite, that it failed closed on
         * the observer question. It did not. Every question this function
         * asks was answered "fine, proceed" whenever the call errored: the
         * observer, a ban, a suspension, a barred device, a deleted account.
         *
         * The old justification was that the rules and the backend refuse the
         * observer independently, so this was only a convenience layer. That
         * is true of the observer and false of everything else. Nothing else
         * re-checks a ban at this point, and a banned user whose call to this
         * function fails is a banned user who is now inside the app.
         *
         * Making it strict outright would hand a Cloud Functions blip to
         * every user as a lockout, so: one retry against a transient failure,
         * then refuse — and refuse as an ERROR, not as a ban. "We could not
         * check" and "you are banned" are different sentences and the person
         * deserves the true one.
         */
        var res = money.resolveIdentity(deviceId)
        if (res is MoneyFunctions.Result.Failed) {
            delay(700)
            res = money.resolveIdentity(deviceId)
        }
        val id = when (res) {
            is MoneyFunctions.Result.Ok -> res.value
            is MoneyFunctions.Result.Failed -> {
                /*
                 * ── DO NOT SIGN OUT AN ANONYMOUS SESSION ─────────────────
                 *
                 * `signOut()` on a guest is not a sign-out, it is a deletion.
                 * An anonymous credential exists only on this handset and
                 * cannot be re-obtained by any means — see `signOut(deviceId)`
                 * below, which mints the recovery secret BEFORE it dares call
                 * it. Signing out here would have run before `mintQuickLogin`
                 * on the guest path, so a guest whose network dropped twice
                 * would have lost their uid, their diamonds and their history
                 * to a failed health check.
                 *
                 * Leaving an unverified session signed in is safe: this
                 * returns an Error, so no screen advances, nothing is written,
                 * and the next launch gates again from the top. Signing out a
                 * real provider account is also unnecessary for the same
                 * reason — but it is free there, and it keeps a half-entered
                 * account from lingering on a shared phone.
                 */
                if (auth.currentUser?.isAnonymous == true) {
                    // Make sure there is a way back in before refusing entry.
                    mintQuickLoginCredential(deviceId)
                } else {
                    try { auth.signOut() } catch (_: Exception) {}
                    sessionManager.clear()
                }
                return AuthResult.Error(
                    "Could not verify your account right now. " +
                    "Check your connection and try again."
                )
            }
        }

        if (id.isObserver) {
            /*
             * Delete the login that was just minted.
             *
             * The observer is CRM-only and deliberately has no Firebase account.
             * A Google sign-in with that address creates one — so refusing
             * without deleting it would leave exactly the account that must not
             * exist, and the next attempt would find it and behave differently.
             */
            try { auth.currentUser?.delete()?.await() } catch (_: Exception) {}
            try { auth.signOut() } catch (_: Exception) {}
            sessionManager.clear()
            quickLogin.clear()
            return AuthResult.ObserverDenied
        }

        /*
         * The server now decides suspended vs banned vs device-banned, so the
         * client stops guessing from `isBanned` — which is true for both a
         * suspension and a ban and therefore cannot tell them apart.
         */
        when (id.decision) {
            "device_banned" -> return AuthResult.Banned(id.reason, RestrictionKind.Device)
            "banned" -> return AuthResult.Banned(id.reason, RestrictionKind.Account)
            "suspended" -> return AuthResult.Banned(
                id.reason, RestrictionKind.Suspension, id.suspendedUntilMs,
            )
        }

        if (id.isRecoverable) {
            return AuthResult.DeletedRecoverable(
                displayName = id.displayName,
                photoUrl = id.photoUrl,
                dueAtMs = id.deletionDueAtMs,
            )
        }

        /*
         * `deleted_permanent` deliberately falls through.
         *
         * The old account's identity has already been released and its history
         * kept; there is nothing to recover and nothing to warn about. This
         * person is starting fresh, and the ordinary new-account path is
         * exactly right.
         */

        if (id.requiresPhone || id.requiresEmail) {
            return AuthResult.NeedsContactDetails(
                requiresPhone = id.requiresPhone,
                requiresEmail = id.requiresEmail,
                crmRole = id.crmRole,
            )
        }

        /*
         * Cache the server's answer to "is this still a guest".
         *
         * Only on the carry-on path: the refusals above either clear the
         * session or send the person somewhere they cannot reach Settings
         * from, so writing it earlier would only leave a stale flag behind on
         * an account nobody got into.
         *
         * Settings reads this to decide whether to offer "add your phone
         * number". It cannot ask Firebase instead — `isAnonymous` is false for
         * a guest who came back through quick sign-in — and it must not call
         * `resolveIdentity` itself, because that call bars a device on a
         * banned account and so is not safe to fire on a screen open.
         */
        sessionManager.setGuest(id.isGuest)

        return null
    }

    /**
     * The document must exist before a session can be written to it.
     *
     * ── THE BUG THIS CLOSES ──────────────────────────────────────────────────
     *
     * The returning-user paths never checked. `isNewUser` false meant "skip
     * creation", and they fell straight through to `generateSession`, which
     * calls `.update("sessionToken", …)` — and `update()` throws NOT_FOUND on a
     * missing document. So anyone whose Firestore document had gone while their
     * Firebase login survived could not sign in AT ALL: every attempt died with
     * a generic error, on every method, forever. That is not a hypothetical
     * state — `purgeMyAccountNow` deletes the login last, on purpose, and a
     * failed purge leaves exactly this.
     *
     * Rebuilding from the auth record is the honest repair: the account is real,
     * the person holds its credential, and the alternative is an unreachable
     * login.
     */
    private suspend fun ensureUserDocument(uid: String) {
        val u = auth.currentUser
        createUserDocument(
            uid = uid,
            phone = u?.phoneNumber ?: "",
            name = u?.displayName ?: "",
            photoUrl = u?.photoUrl?.toString() ?: "",
        )
    }

    suspend fun saveUserProfile(
        name: String,
        gender: String,
        dob: Long,
        age: Int,
        city: String,
        country: String,        // auto-detected from GPS; not shown to users
        deviceId: String,
        photoUri: Uri?,
        languages: List<UserLanguage> = emptyList(),
        email: String = "",     // form-entered email for phone-login users
        /**
         * Form-entered phone for GOOGLE-login users, the mirror of `email`
         * above. A Google account carries no phone number, so without this the
         * user document was written with an empty `phoneNumber` even though the
         * setup form had just required a ten-digit one and validated it.
         */
        phone: String = "",
        /** Optional, and written with the rest of the form rather than alone. */
        bio: String = "",
        /**
         * A default avatar the person kept rather than replacing.
         *
         * Carries a scheme-prefixed id — `avatar:fox` — not a URL, because these
         * are drawables shipped in the APK rather than uploads. A Coil mapper
         * resolves the scheme app-wide, so every screen that renders a photo
         * understands it without knowing the convention. See DefaultAvatars.kt.
         *
         * Ignored when [photoUri] is set: a picked photo always wins.
         */
        defaultAvatar: String = "",
    ): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            // ── Email uniqueness guard ─────────────────────────────────────────
            // The canonical email is the Firebase Auth email (for Google/email-auth users)
            // OR the one the user typed in the profile setup form (for phone-auth users).
            val firebaseEmail = auth.currentUser?.email?.takeIf { it.isNotBlank() }
            val canonicalEmail = (firebaseEmail ?: email).trim().lowercase()
            if (canonicalEmail.isNotBlank()) {
                try {
                    val existing = firestore.collection("users")
                        .whereEqualTo("email", canonicalEmail)
                        .limit(5)
                        .get().await()
                    val takenByOther = existing.documents.any { it.id != uid }
                    if (takenByOther) {
                        return AuthResult.Error(
                            "This email is already linked to another Zipper account. " +
                            "Please use a different email address."
                        )
                    }
                } catch (_: Exception) {
                    // Uniqueness check is best-effort — don't block profile save on a network error.
                }
            }
            // A picked photo overwrites it; otherwise the chosen default avatar
            // is stored as-is, so an account that skipped the photo step still
            // has a face instead of a blank disc.
            var photoUrl = defaultAvatar
            if (photoUri != null) {
                val ref = storage.reference.child("profileMedia/$uid/avatar.jpg")
                ref.putFile(photoUri, com.google.firebase.storage.StorageMetadata.Builder().setContentType("image/jpeg").build()).await()
                photoUrl = ref.downloadUrl.await().toString()
            }
            // Serialize languages as a list of maps (Firestore-safe; supports filtering/queries)
            val languagesMaps = languages.map { mapOf("id" to it.id, "code" to it.code, "name" to it.name) }
            val firebaseUser = auth.currentUser
            val updates = mapOf(
                "name" to name,
                "gender" to gender,
                "dob" to dob,
                "age" to age,
                "city" to city,
                "country" to country,   // hidden from UI; used for CRM/analytics/moderation
                /*
                 * `deviceId` is NOT written here, and that is the fix for a
                 * PERMISSION_DENIED that made profile setup impossible.
                 *
                 * It is on `ownerProtectedFields()` in firestore.rules, and for
                 * a good reason: `ban_user` bans whatever device id is on the
                 * account, so a user who could write it could point their own
                 * ban cascade at a handset that does not exist. The moment it
                 * was protected, this line started denying the whole update —
                 * the rule is a `hasAny` over the changed keys, so one
                 * forbidden field fails the write regardless of the other
                 * fourteen.
                 *
                 * It was invisible for staff accounts until recently, because
                 * the rule is an OR and the staff clause used to protect only
                 * money. Tightening that clause removed the second escape route
                 * and the latent bug surfaced for everyone at once.
                 *
                 * The device is recorded server-side instead, by
                 * `rememberDevice` in functions/src/identity.ts, which runs on
                 * `startMobileSession` with the Admin SDK and writes both the
                 * `users/{uid}/devices` registry and this field.
                 */
                "languages" to languagesMaps,
                "email" to (firebaseUser?.email?.takeIf { it.isNotBlank() } ?: email),
                // The auth token wins where it has one — it is verified, and a
                // typed number is not. The form value fills the gap Auth
                // genuinely has, exactly as `email` does one line above.
                "phoneNumber" to (firebaseUser?.phoneNumber?.takeIf { it.isNotBlank() } ?: phone),
                "bio" to bio,
                "isProfileComplete" to true,
                "isOnline" to true,
                "lastSeen" to System.currentTimeMillis(),
            )
            /*
             * The avatar is added only when a new one was actually chosen.
             *
             * It used to be written unconditionally from a `var photoUrl = ""`,
             * and the setup form never requires a photo — so a Google sign-up,
             * whose avatar was populated from the Google account a moment
             * earlier, landed on Home with an empty circle. Appended here
             * rather than spread into the map above because these values are
             * of mixed types and a same-typed array cannot be spread into a
             * `Map<String, Any>`.
             */
            val patch: Map<String, Any> =
                if (photoUrl.isNotBlank()) updates + ("photoUrl" to photoUrl) else updates

            /*
             * `set(merge)`, not `update`.
             *
             * `update` fails with NOT_FOUND when the document does not exist,
             * and it can genuinely not exist: a `createUserDocument` that was
             * interrupted offline, or a partly-completed account deletion,
             * which removes the Firestore document BEFORE the auth account and
             * leaves a signed-in user with no record if the second half fails.
             *
             * Splash routes exactly that person to profile setup. Every press
             * of Done then failed with "no document to update", forever, on a
             * screen with no back button and no way to sign out. `merge` writes
             * the profile whether the document is there or not, which is the
             * only behaviour that can ever complete.
             */
            firestore.collection("users").document(uid)
                .set(patch, com.google.firebase.firestore.SetOptions.merge())
                .await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Profile save failed")
        }
    }

    // ── Face verification + referral code ─────────────────────────────────────

    // Delete user entirely (account + Firestore doc) — called after 3 failed verifications
    suspend fun deleteCurrentUser(): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            firestore.collection("users").document(uid).delete().await()
            auth.currentUser?.delete()?.await()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Delete failed")
        }
    }

    /** Full cleanup: deletes Firestore doc, Storage files, and Auth account */
    suspend fun clearAllUserData(): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            // Delete Firestore doc
            firestore.collection("users").document(uid).delete().await()
            // Best-effort delete Storage files (ignore errors if they don't exist)
            try { storage.reference.child("profileMedia/$uid/avatar.jpg").delete().await() } catch (_: Exception) {}
            try { storage.reference.child("face_verifications/$uid.jpg").delete().await() } catch (_: Exception) {}
            // Delete Auth account last
            auth.currentUser?.delete()?.await()
            AuthResult.Success
        } catch (e: Exception) {
            // Even if Firestore delete failed, try to delete auth account
            try { auth.currentUser?.delete()?.await() } catch (_: Exception) {}
            AuthResult.Error(e.message ?: "Cleanup failed")
        }
    }


    /**
     * Upload the host's live capture and submit it for verification.
     *
     * This is host-only now. It previously sat in the signup flow for everyone
     * — Splash and ProfileSetup both routed into it — so ordinary users were
     * asked for a liveness check that served no purpose, and were having a
     * photograph of their face stored for no stated reason. Under the DPDP Act
     * that is biometric data collected without a purpose to point at.
     *
     * The client no longer writes `isFaceVerified`. The badge is
     * `users/{uid}.isVerifiedHost`, written only by the verification function,
     * because it is what releases weekly payouts.
     */
    suspend fun submitHostCapture(photoUri: Uri): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            // Path matches storage.rules: owner-write, owner-read, images only.
            val ref = storage.reference.child("hostVerification/$uid/capture.jpg")
            ref.putFile(photoUri, com.google.firebase.storage.StorageMetadata.Builder().setContentType("image/jpeg").build()).await()
            val url = ref.downloadUrl.await().toString()
            when (val res = hostFunctions.submitHostCapture(url)) {
                is HostFunctions.Result.Ok -> AuthResult.Success
                is HostFunctions.Result.Failed -> AuthResult.Error(res.userMessage)
            }
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Could not upload the photo")
        }
    }

    /**
     * Check a referral code before the user commits to it.
     *
     * The lookup moved to `checkReferralCode` on the server. It used to be a
     * direct query on `hostApplications`, which required every app user to be
     * able to read that collection — and it holds bank account numbers, dates
     * of birth and KYC document URLs for every host on the platform.
     *
     * [ReferralResult.Valid] no longer carries `agencyId`, `callRate` or
     * `applicationId`: the client has no use for them now that `activateHost`
     * decides all three, and the rate in particular was being carried through
     * the UI only to be written back to Firestore unchecked.
     */
    suspend fun verifyReferralCode(
        code: String,
        overridePhone: String = "",
        overrideEmail: String = "",
    ): ReferralResult = when (
        val res = hostFunctions.checkReferralCode(code, overridePhone, overrideEmail)
    ) {
        is HostFunctions.CodeCheck.Valid -> ReferralResult.Valid(res.agencyName)
        is HostFunctions.CodeCheck.Invalid -> when (res.reason) {
            HostFunctions.ReferralRefusal.NOT_FOUND       -> ReferralResult.NotFound
            HostFunctions.ReferralRefusal.ALREADY_USED    -> ReferralResult.AlreadyUsed
            HostFunctions.ReferralRefusal.ACCOUNT_MISMATCH -> ReferralResult.AccountMismatch
            HostFunctions.ReferralRefusal.REJECTED        -> ReferralResult.Error("That application was not approved.")
            HostFunctions.ReferralRefusal.NOT_APPROVED    -> ReferralResult.Error(
                "This invitation is still being reviewed. Your agency has sent it for " +
                "approval — the code will work once that is done."
            )
            /*
             * Neither of these is about the code, and saying so is the point.
             * Both used to be reachable only by submitting and being refused by
             * `activateHost`, which read as the code being wrong.
             */
            HostFunctions.ReferralRefusal.RESTRICTED      -> ReferralResult.Error(
                "This account can't become a host at the moment. Contact support " +
                "if you think that is a mistake."
            )
            HostFunctions.ReferralRefusal.OTHER_AGENCY    -> ReferralResult.Error(
                "You are already a host with another agency. To move, ask your " +
                "current agency to release you first."
            )
            HostFunctions.ReferralRefusal.UNKNOWN         -> ReferralResult.Error("That code could not be used.")
        }
        is HostFunctions.CodeCheck.Failed -> ReferralResult.Error(res.message)
    }

    /**
     * Redeem the code: become a host of that agency, at the agreed rate.
     *
     * Was three client writes — `isHost`, `agencyId`, `callRateBeans` — onto the
     * user's own document. Those decide whether the account earns, who is paid
     * commission on it, and what a minute of its time costs.
     *
     * Also opens the host's verification record, which matters more than it
     * looks: the weekly payout release refuses to release a week for a host
     * whose `isVerifiedHost` is not true.
     */
    suspend fun activateHostApplication(
        referralCode: String,
        phone: String = "",
        email: String = "",
    ): AuthResult =
        when (val res = hostFunctions.activateHost(referralCode, phone, email)) {
            is HostFunctions.Result.Ok -> AuthResult.Success
            is HostFunctions.Result.Failed -> AuthResult.Error(res.userMessage)
        }

    /**
     * Whether this session's account is still a guest, as the SERVER answered
     * it at sign-in — or null if it has not been asked on this install. See
     * [gateIdentity] for why the client cannot answer it, and
     * [com.zipper.app.util.SessionManager.isGuest] for why null is a case.
     */
    val isGuest: Flow<Boolean?> get() = sessionManager.isGuest

    // ── Role badges ───────────────────────────────────────────────────────────

    /**
     * Refresh role badges (agent, seller, official, CRM role) after sign-in.
     *
     * This used to run on the device: query `verifiedIdentities` by the user's
     * own phone and email, then write `isAgent` / `isSeller` / `isOfficial` /
     * `crmRole` onto their own user document.
     *
     * Both halves were wrong. The write is a user granting themselves a role,
     * which the rules now refuse. And the query required every app user to be
     * able to read `verifiedIdentities` — the list of who is staff, an agency
     * owner or a coin seller, joined to their phone numbers.
     *
     * `syncMyRoles` now reads `crmUsers/{uid}` — the record keyed on the uid
     * the caller actually authenticated as, which is the authoritative source
     * and the same one `resolveIdentity` reads. It matched on phone and email
     * until recently; that could not tell two people apart, went stale the
     * moment somebody changed their number, and compared against a six-value
     * role list the CRM stopped using when departments gained admin and member
     * tiers — so every `ops_admin` and `finance_member` got no badge at all.
     *
     * Best-effort: a failure here means a missing badge, not a failed login.
     */
    suspend fun syncRoles() {
        hostFunctions.syncMyRoles()
    }

    private companion object {
        /**
         * The three `bindVerifiedIdentity` refusals that no retry can turn into
         * a yes, spelled as `FirebaseFunctionsException.Code.name`.
         *
         * A binding attempt that hits one of these must be ROLLED BACK — the
         * provider comes off the Auth account — because the alternative is an
         * account whose Auth side holds an identifier its Firestore side does
         * not, which is the divergence `undoPhoneLink` / `undoEmailLink` exist
         * to prevent. Anything not on this list is treated as unknown and the
         * link is deliberately left in place, since the server's write is not
         * idempotency-guarded and may have committed with the response lost.
         */
        val DEFINITIVE_BIND_REFUSALS = setOf(
            "ALREADY_EXISTS",       // a live account holds it, or a recoverable one
            "PERMISSION_DENIED",    // the observer address — never bindable
            "FAILED_PRECONDITION",  // the token does not carry this identifier
        )

        /**
         * The refusals that mean a stored credential is DEAD, as opposed to
         * temporarily unreachable.
         *
         * Only these may destroy it. The quick-login secret is the single copy of
         * a credential that the server keeps only the hash of, and for a guest it
         * is one of just two routes back to their account — so deleting it on a
         * dropped connection costs somebody their balance to save them a stale
         * button. `UNAVAILABLE`, `INTERNAL`, `DEADLINE_EXCEEDED` and the
         * lower-case `unavailable`/`internal` that `MoneyFunctions.call`
         * synthesises for an unreachable server are all absent on purpose.
         */
        val DEFINITIVE_TOKEN_REFUSALS = setOf(
            // `redeemQuickLogin` answers every dead-token case with this one:
            // never existed, expired, revoked, account gone.
            "PERMISSION_DENIED",
            "INVALID_ARGUMENT",   // malformed — no retry makes it well-formed
        )

        /**
         * Exactly the two codes `claimGuestIdentity` can throw.
         *
         * Separate from [DEFINITIVE_BIND_REFUSALS] because the two callables do
         * not share a refusal vocabulary, and borrowing one for the other is
         * wrong in both directions: `ALREADY_EXISTS` and `FAILED_PRECONDITION`
         * are unreachable here, while `INVALID_ARGUMENT` — the only code this one
         * actually throws — is absent there, and adding it would make a malformed
         * bind report that somebody else holds the caller's own phone number.
         *
         * Note what is NOT here: a Firestore transaction abort arrives as
         * `INTERNAL`, and the bind write may have committed with the response
         * lost, so that case must keep the session rather than delete it.
         */
        val DEFINITIVE_CLAIM_REFUSALS = setOf(
            "INVALID_ARGUMENT",   // no device id or no secret — the next try is identical
            "PERMISSION_DENIED",  // App Check or IAM; retrying changes nothing
        )

        /**
         * How long a deleted account can still be recovered.
         *
         * Must match `GRACE_DAYS` in functions/src/accounts.ts — the client
         * writes the due date and the server's sweep reads it, so a mismatch
         * here purges accounts early or leaves them pending past the date the
         * app promised.
         */
        const val GRACE_DAYS = 30

        /**
         * The path the email sign-in link comes back to. See
         * [emailLinkSettings].
         *
         * MUST match the `android:pathPrefix` on the App Link intent filter in
         * AndroidManifest.xml. A manifest cannot read a Kotlin constant, so the
         * two are kept in step by this comment and nothing else — change one and
         * the link opens a browser instead of the app, silently, on a flow whose
         * only symptom is "nothing happened when I tapped the email".
         */
        const val EMAIL_LINK_RETURN_PATH = "/secure-account"
    }

    /** A deletion that has been requested and has not happened yet. */
    data class PendingDeletion(val dueAtMillis: Long)

    // ── Soft delete account ───────────────────────────────────────────────────
    //
    // Marks the user as pending deletion. Cloud Function purges data after 30 days.
    // If user logs back in within 30 days the account is recovered (isDeleted flag removed).

    suspend fun softDeleteAccount(): AuthResult {
        val uid = auth.currentUser?.uid ?: return AuthResult.Error("Not logged in")
        return try {
            /*
             * `deletionDueAt` is the field that makes this a real deletion.
             *
             * Without it the flag sat there for ever: nothing purged the
             * account, nothing offered it back, and the only effect was that
             * the person vanished from discovery. The sweep on the server
             * (`purgeDeletedAccounts`) queries exactly this field, so writing
             * it is what schedules the thing the dialog promises.
             *
             * A Firestore Timestamp, not a Long. `deletionRequestedAt` was
             * written as `System.currentTimeMillis()` — a device clock, and a
             * type the server compares against `Timestamp.now()`, which would
             * never match.
             */
            /*
             * A callable, not a client write.
             *
             * `accountState` is a protected field now, and it had to become one:
             * a client that can set it can also set it back to `active`, which
             * would let somebody undo their own deletion after the binding rules
             * had already released their phone number to another account — two
             * accounts holding one number, with nothing to say which owns it.
             *
             * The deadline moved to the server for the same reason call billing
             * did: `now + 30 days` computed on a phone is thirty days after
             * whatever that phone believes the date to be.
             */
            when (val res = money.requestAccountDeletion()) {
                is MoneyFunctions.Result.Ok -> Unit
                is MoneyFunctions.Result.Failed -> return AuthResult.Error(res.userMessage)
            }
            // An account pending deletion must stop ringing this phone. Before
            // the sign-out, while the uid and the auth token still exist.
            com.zipper.app.service.PushNotifications.clearToken(uid)
            sessionManager.clear()
            auth.signOut()
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Delete request failed")
        }
    }

    /**
     * Where a deleted account stands, for the screen that offers it back.
     *
     * `null` when there is nothing pending — the ordinary case, and the one
     * that must not be confused with a failed read: a read that fails returns
     * null too, and the caller treats that as "not deleted" deliberately. Being
     * let into your own account on a bad connection is the right failure; being
     * shown a deletion notice that is not real is not.
     */
    suspend fun pendingDeletion(): PendingDeletion? {
        val uid = auth.currentUser?.uid ?: return null
        return try {
            val snap = firestore.collection("users").document(uid).get().await()
            if (snap.getBoolean("isDeleted") != true) return null
            PendingDeletion(
                dueAtMillis = snap.getTimestamp("deletionDueAt")?.toDate()?.time ?: 0L,
            )
        } catch (_: Exception) {
            null
        }
    }

    /** Undo a deletion request. Restores the account exactly as it was. */
    suspend fun recoverAccount(): AuthResult =
        when (val res = hostFunctions.recoverAccount()) {
            is HostFunctions.Result.Ok -> AuthResult.Success
            is HostFunctions.Result.Failed -> AuthResult.Error(res.userMessage)
        }

    /**
     * Finish the deletion now rather than waiting out the thirty days.
     *
     * ── WHAT THIS ACTUALLY DOES, WHICH IS NOT WHAT IT USED TO SAY ────────────
     *
     * This comment claimed the document was destroyed. It is not, and saying so
     * mattered — the app's own copy repeated it, telling people their messages
     * and history were "removed" when the business keeps them permanently.
     *
     * The IDENTITY is released: name, photo, phone, email and the auth login all
     * go, the uploaded media is deleted, and the phone number becomes free for
     * another account to bind immediately.
     *
     * The RECORD stays for the life of the CRM, marked
     * `permanently_deactivated` — every coin purchase, bean movement, warning
     * and gift, still keyed by this uid and still joinable to the ledger. A
     * person asking to leave is not asking the business to forget that money
     * changed hands.
     *
     * So the number can sign up again and gets a genuinely clean account: none
     * of the old history follows it across.
     */
    suspend fun deleteAccountNow(): AuthResult {
        val uid = auth.currentUser?.uid
        return when (val res = hostFunctions.purgeMyAccountNow()) {
            is HostFunctions.Result.Ok -> {
                // Before the sign-out, while the uid and the token still exist.
                // The server purge removes the `fcmTokens` subcollection with
                // the account, but a token already registered with FCM on this
                // handset keeps receiving pushes for an account that no longer
                // exists until something unregisters it — and the account it
                // belonged to is gone, so nothing else ever will.
                uid?.let { com.zipper.app.service.PushNotifications.clearToken(it) }
                sessionManager.clear()
                auth.signOut()
                AuthResult.Success
            }
            is HostFunctions.Result.Failed -> AuthResult.Error(res.userMessage)
        }
    }

    // ── Realtime user listener ────────────────────────────────────────────────

    fun currentUserFlow(): Flow<User?> = callbackFlow {
        val uid = auth.currentUser?.uid
        if (uid == null) {
            trySend(null)
            close()
            return@callbackFlow
        }
        val listener = firestore.collection("users").document(uid)
            .addSnapshotListener { snap, _ ->
                if (snap != null && snap.exists()) {
                    trySend(User.from(snap))
                } else {
                    trySend(null)
                }
            }
        awaitClose { listener.remove() }
    }

    // ── Misc ──────────────────────────────────────────────────────────────────

    suspend fun updateOnlineStatus(isOnline: Boolean) {
        val uid = auth.currentUser?.uid ?: return
        firestore.collection("users").document(uid)
            .update("isOnline", isOnline, "lastSeen", System.currentTimeMillis())
    }

    suspend fun saveFcmToken(token: String) {
        val uid = auth.currentUser?.uid ?: return
        // One doc per device under users/{uid}/fcmTokens, plus the legacy field.
        com.zipper.app.service.PushNotifications.saveToken(uid, token)
    }

    /**
     * Sign out, but stay recoverable.
     *
     * ── WHY THE QUICK-LOGIN SECRET IS MINTED HERE, BEFORE LEAVING ────────────
     *
     * `FirebaseAuth.signOut()` deletes the locally persisted credential. For a
     * Google or phone account that is harmless — the credential can be obtained
     * again from the Google account or an SMS. For an ANONYMOUS account the
     * local token IS the whole credential, and once it is gone that uid is
     * orphaned forever: no way back in, and the next guest tap mints a new
     * account. That single line was the largest source of duplicate documents in
     * the app.
     *
     * So the last thing done while the session is still valid is to ask the
     * server for a quick-login credential and put it in Block Store, which lives
     * outside the app's data directory. The account survives the sign-out and a
     * factory-new install of the same app on the same phone.
     *
     * NOT across a device transfer, and that is deliberate. The credential is
     * registered against this handset's Keystore key, and the key cannot be
     * exported or backed up — so the bytes alone, restored onto another phone,
     * authenticate nothing. "Quick login" means the account most recently signed
     * out from THIS device, and nothing wider.
     *
     * `quickLogin.clear()` is deliberately NOT called. Remembering across an
     * ordinary sign-out is the entire feature. It is cleared on account
     * deletion, on a server refusal, and on an explicit "forget this device".
     */
    suspend fun signOut(deviceId: String = "", mintQuickLogin: Boolean = true) {
        val uid = auth.currentUser?.uid

        /*
         * ── A DISPLACED DEVICE MUST NOT MINT ITSELF A WAY BACK ───────────────
         *
         * `mintQuickLogin` defaults true because an ORDINARY sign-out is the one
         * moment quick login is supposed to be created: the whole feature is
         * "let me back into the account I just left on this phone".
         *
         * It is false for a FORCED teardown. When Phone B signs in, Phone A is
         * displaced and tears its session down through this same function — and
         * minting there would hand the displaced handset a credential that
         * redeems straight back into the account, which is the single-active-
         * device rule with a door cut into it.
         *
         * See `SessionViewModel.tearDownSession`, which passes false.
         */
        if (uid != null && mintQuickLogin) mintQuickLoginCredential(deviceId)

        /*
         * Close the server's record of this session.
         *
         * Nothing called this before: `activeMobileSession` kept naming the
         * departed handset until the next sign-in overwrote it, so "which device
         * is on this account" answered with one that had signed out days ago.
         *
         * Best-effort and awaited before `auth.signOut()`, because afterwards the
         * callable has no credential to authenticate with. Skipped on a forced
         * teardown: the session being torn down is no longer ours, and
         * `endMobileSession` would refuse it anyway — it only clears a session
         * that still matches.
         */
        if (uid != null && mintQuickLogin) {
            try {
                val sessionId = sessionManager.sessionToken.first()
                if (sessionId.isNotBlank()) money.endMobileSession(sessionId)
            } catch (_: Exception) {
            }
        }

        // Drop the push token — and only THIS phone's, so the same account
        // signed in elsewhere keeps its notifications. Awaited: after signOut()
        // the write would be retried without an auth token and refused.
        uid?.let { com.zipper.app.service.PushNotifications.clearToken(it) }
        sessionManager.clear()
        auth.signOut()
    }

    /**
     * Sign out AND forget this device, so quick login will not offer the account
     * back.
     *
     * The honest version of "log out" for a shared or borrowed phone. Ordinary
     * sign-out deliberately remembers.
     */
    suspend fun signOutAndForget() {
        val token = quickLogin.load()?.token
        if (token != null) {
            try { money.revokeQuickLogin(token) } catch (_: Exception) {}
        }
        quickLogin.clear()
        /*
         * And destroy the device key, which is what makes "forget" honest.
         *
         * Clearing the secret alone leaves the binding alive, so any credential
         * minted on this handset that somehow still exists server-side could
         * still be signed for. Deleting the Keystore entry ends that: no
         * credential minted here is redeemable again, whatever happened to its
         * bytes. The next sign-in generates a new key and a new binding.
         */
        deviceKey.clear()
        auth.currentUser?.uid?.let {
            com.zipper.app.service.PushNotifications.clearToken(it)
        }
        sessionManager.clear()
        auth.signOut()
    }

    /**
     * Throw away a half-finished account.
     *
     * Reached from the Back button on profile setup: somebody signed in, saw
     * what was being asked, and changed their mind. Leaving the account behind
     * would leave a nameless, genderless document in the feed and — for a phone
     * or Google sign-in — would hold that identifier against an account nobody
     * is using, so the same person could not start again cleanly.
     *
     * Deletes the Firestore document first and the auth login second, so a
     * failure part-way leaves a login with no document (recoverable: the next
     * sign-in rebuilds it via `ensureUserDocument`) rather than a document with
     * no login (unreachable forever).
     *
     * REFUSES a completed profile. This is an abandon, not a delete — a real
     * deletion goes through `softDeleteAccount` and its 30-day window.
     */
    suspend fun abandonSignup(): AuthResult {
        val user = auth.currentUser ?: return AuthResult.Error("Not signed in.")
        val uid = user.uid
        return try {
            val snap = firestore.collection("users").document(uid).get().await()
            if (snap.exists() && snap.getBoolean("isProfileComplete") == true) {
                return AuthResult.Error("This account is already set up.")
            }

            /*
             * ── A CRM ACCOUNT IS NOT AN ABANDONED SIGNUP ─────────────────
             *
             * This function deletes the user document AND calls
             * `user.delete()` on the Firebase Auth account. For somebody who
             * signed up thirty seconds ago and changed their mind, that is
             * exactly right: nothing of theirs exists yet and a ghost account
             * helps nobody.
             *
             * For an account the CRM provisioned it is destruction. An owner or
             * a staff member opening the app for the first time lands on
             * profile setup — `_attach_app_identity` creates their
             * `users/{uid}` with `isProfileComplete: false`, so it looks
             * identical to a half-made signup — and one press of Back would
             * delete the Firebase account that IS their CRM login. Their
             * password, their linked Google, the phone number attached for app
             * sign-in: all gone in one tap, leaving `crmUsers/{uid}` and the
             * Mongo `staff` row pointing at a uid that no longer exists.
             *
             * `crmUsers/{uid}` is the test because it is the thing that makes
             * an account CRM-provisioned, and it is readable here. Checking
             * `createdVia == 'crm'` on the user document would miss the case
             * where that document has already been deleted — which is precisely
             * the situation this guard exists to stop happening twice.
             *
             * Signing out is the right answer: they get back to the login
             * screen, and nothing of theirs is touched.
             */
            val isCrmAccount = try {
                firestore.collection("crmUsers").document(uid).get().await().exists()
            } catch (_: Exception) {
                // Unknowable. Treat it as a CRM account: refusing to delete
                // costs a stray document, deleting wrongly costs somebody their
                // login.
                true
            }
            if (isCrmAccount) {
                sessionManager.clear()
                auth.signOut()
                return AuthResult.Success
            }

            quickLogin.clear()
            // The account is being thrown away, so the binding goes with it.
            // Leaving the key behind would let the NEXT account minted on this
            // handset inherit a key the discarded one had already registered.
            deviceKey.clear()
            try { firestore.collection("users").document(uid).delete().await() } catch (_: Exception) {}
            sessionManager.clear()

            try {
                user.delete().await()
            } catch (_: Exception) {
                // Firebase refuses `delete()` on a stale login. Signing out
                // still gets them back to a clean login screen, and the document
                // — the part that would have been visible to other people — is
                // already gone.
                auth.signOut()
            }
            AuthResult.Success
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Could not discard this account.")
        }
    }

    fun isLoggedIn() = auth.currentUser != null
}
