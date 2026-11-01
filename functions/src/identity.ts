/**
 * Identity — who this person is, across sign-in methods, devices and surfaces.
 *
 * ── THE FOUR PROBLEMS THIS FILE EXISTS FOR ───────────────────────────────────
 *
 * 1. ONE HUMAN, MANY DOCUMENTS. Sign in with Google, sign out, sign in with the
 *    phone number you just typed into your own profile — two Firebase accounts,
 *    two `users/{uid}` documents, and nothing anywhere notices they are the same
 *    person. Guests were worse: `signOut()` destroys an anonymous credential
 *    permanently, so every guest logout minted a brand-new account.
 *
 * 2. QUICK LOGIN. The competitor behaviour: log out, tap one button, you are
 *    back in. It has to survive clearing app data and reinstalling, which means
 *    the credential cannot live in app storage. It lives in Google's Block Store
 *    on the device and is redeemed here for a custom token.
 *
 * 3. TWO SURFACES, ONE PERSON. The CRM is email and password; the app is phone,
 *    Google or guest. Those are different Firebase accounts, so a CRM admin
 *    signing into the app arrived as a stranger — and `isCrmUser()` keys on uid,
 *    so they had no authority under the uid they were actually holding. The fix
 *    is to attach their phone number to the SAME Firebase account, so phone OTP
 *    in the app resolves to the uid the CRM already knows.
 *
 * 4. COLLISIONS. A guest with a balance binds a phone that already has an
 *    account. Somebody has to choose, and the one not chosen has to go somewhere
 *    recoverable rather than being destroyed on the spot.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * No balance merging. When two accounts collide, one is kept and the other goes
 * into the ordinary 30-day deletion window; nothing moves between them. Merging
 * two ledgers is a different and much more dangerous piece of work than
 * choosing between them, and doing it silently inside a login flow is how money
 * goes missing.
 */
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import {
  nextValidAfter, restrictionVerdict, ACCOUNT_RESTRICTED, SESSION_DISPLACED, DISPLACED_MESSAGE,
  assertActiveSession,
} from './mobileSession'
import * as crypto from 'crypto'
import { STATE_ACTIVE, STATE_PERMANENTLY_DEACTIVATED, STATE_RECOVERY_PENDING, recoveryExpired } from './accounts'
import { normaliseCrmRole, deriveRoleFlags, PARTNER_ROLES } from './crmRoles'
import { bindingPayload, decideGuestClaim, GuestClaimStatus } from './guestBinding'
import { AdoptionCandidate, decideEmailAdoption } from './emailAdoption'

/**
 * AUTH-001 reverse index: guest uid → the one device it belongs to. Written only
 * by `claimGuestIdentity` inside the binding transaction; closed to clients.
 */
export const GUEST_UID_BINDINGS = 'guestUidBindings'
import { legacyPhoneKey, phoneE164Key, sameNumber, sameNumberStrict } from './phone'

const db = admin.firestore()

/**
 * How long a quick-login secret is good for.
 *
 * Long, because the whole point is surviving a reinstall weeks later — a token
 * that expired in a week would fail exactly when someone came back to the app
 * after a gap, which is the case it was built for. Every sign-in mints a fresh
 * one, so an active user's token never ages.
 */

/**
 * The observer account, which must never reach the app.
 *
 * It is a read-only CRM identity with no Firebase account of its own, and the
 * backend used to hand out a session for it on an EMAIL match alone — so anyone
 * able to sign in with that Gmail got read access to the whole business. Refused
 * here as well as in the backend, because the app is the easiest place to get a
 * token for it.
 */
const OBSERVER_EMAIL = (process.env.OBSERVER_EMAIL || '314zipper@gmail.com').toLowerCase()

/** UGP-C: the same refusal for the email one-time code (`emailOtp.ts`). */
export function isObserverEmail(email: string): boolean {
  return String(email ?? '').trim().toLowerCase() === OBSERVER_EMAIL
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  }
  return context.auth.uid
}

/**
 * The last ten digits, which is what two spellings of one number have in common.
 *
 * Identical to `phoneKey` in hosts.ts, and duplicated rather than imported
 * because importing would drag that module's Firestore handle into every caller.
 * If one changes the other must: they are answering the same question.
 */
/**
 * Is this account still a GUEST — an anonymous account with no provider on it?
 *
 * ── WHY THIS CANNOT READ `sign_in_provider` ALONE ────────────────────────
 *
 * The obvious check, `token.firebase.sign_in_provider === 'anonymous'`, is
 * wrong in both directions.
 *
 * Too narrow: quick sign-in redeems a secret for a Firebase CUSTOM token, so a
 * returning guest arrives as `'custom'`. That is a statement about how they
 * got back in, not about what their account is — and it made every guest who
 * had ever used quick sign-in look like a permanent user.
 *
 * Too wide: `sign_in_provider` records how THIS SESSION began and does not
 * change when a provider is linked mid-session. A guest who has just attached
 * their phone number still reports `'anonymous'` until the session ends, so
 * they would be invited to add a number they had already added.
 *
 * `providerData` is the account itself: empty means nothing has ever been
 * attached, which is exactly what "still a guest" means. Auth is asked only
 * when the token leaves the question open — a `phone` or `google.com` sign-in
 * settles it without a round trip.
 */
export async function isGuestAccount(
  uid: string,
  token: Record<string, unknown>,
): Promise<boolean> {
  const fb = token['firebase'] as { sign_in_provider?: string } | undefined
  const provider = String(fb?.sign_in_provider ?? '')
  if (provider !== 'anonymous' && provider !== 'custom') return false
  try {
    const rec = await admin.auth().getUser(uid)
    /*
     * UGP-C: an email bound by one-time code is set on the Auth record by the
     * server (`updateUser({email, emailVerified: true})`) and attaches NO
     * provider — so `providerData` stays empty for it, and reading only that
     * would call the person a guest for ever. A verified email or a phone on
     * the record counts as "something attached"; the document below still has
     * to say it was actually bound.
     */
    const verifiedOnRecord =
      String(rec.phoneNumber ?? '').trim() !== '' ||
      (emailKey(rec.email) !== '' && rec.emailVerified === true)
    if ((rec.providerData ?? []).length === 0 && !verifiedOnRecord) return true

    /*
     * A provider is attached — but is anything BOUND?
     *
     * `linkPhone` and `linkEmail` attach the provider first and ask the server
     * second, and on a transient failure they deliberately LEAVE the link in
     * place so the bind can be retried (unlinking on an unknown risks the
     * mirror divergence — see their comments). Judging guest-ness on
     * `providerData` alone therefore flipped these people to "not a guest" on
     * the strength of a binding that never completed.
     *
     * That was not cosmetic. Settings hides "Secure your account" for a
     * non-guest, and it is the only route to the binding screen — so the
     * failure state removed the retry the error message had just promised, and
     * left them with nothing bound and no way back to bind it.
     *
     * The document is the record of what was actually bound, so it decides.
     */
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return true
    return phoneKey(snap.get('phoneNumber') ?? snap.get('phone')) === '' &&
      emailKey(snap.get('email')) === ''
  } catch {
    // Unknowable. Say "not a guest": the only thing that answer gates is an
    // invitation to add a phone number, and wrongly offering it to somebody
    // who has one is a worse look than wrongly withholding it.
    return false
  }
}

/**
 * Destroy every quick-login credential for an account the moment it is DELETED.
 *
 * ── WHY THIS IS NARROWER THAN IT LOOKS, AND WHY IT HAD TO BE ────────────────
 *
 * It fired on ban and suspension too. Both are gone from here, and the reason is
 * the same for both: the credential is the only thing left that can prove who is
 * appealing.
 *
 * `set_user_disabled(uid, True)` in `backend/app/db/firebase.py` disables the
 * Firebase login and revokes its refresh tokens, so a restricted account's
 * session is dead within the second. Destroying the quick-login credential as
 * well left the person with no identifier at all — and the appeal form on the
 * banned screen is an authenticated write, so it died with the session.
 *
 * What the credential buys in that state is exactly one thing: an appeal, via
 * `submitAccountAppeal`, authenticated by a signature from the device's Keystore
 * key. `grantsSession` is false for both states, no custom token is ever minted,
 * and the Firebase login stays disabled regardless. Nothing about keeping it
 * admits anyone to the product.
 *
 * ── WHAT REVOCATION STILL MEANS ────────────────────────────────────────────
 *
 * Sessions and application access, both of which are gone the moment the CRM
 * acts. The narrowing is from "every credential" to "every credential that could
 * produce a session", and the set of credentials that can produce a session for
 * a restricted account is empty either way.
 *
 * Deletion keeps nothing: recovery is its own flow with its own proof, and there
 * is no appeal against a deletion the person asked for.
 *
 * ── AND A BAN THAT IS LIFTED SIMPLY WORKS ──────────────────────────────────
 *
 * Nothing is stamped on the credential. The outcome is recomputed from the
 * account's current state on every call, so a lifted ban restores quick login
 * with no second write to remember.
 *
 * Fires on the TRANSITION only. Re-running on every write to a deleted user's
 * document would re-scan the collection on every trailing write to it.
 */
export const revokeQuickLoginOnRestriction = functions
  .region('asia-south1')
  .firestore.document('users/{uid}')
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null

    const before = change.before.exists ? change.before.data() ?? {} : {}
    const after = change.after.data() ?? {}

    /*
     * Deletion only — the exact set `destroysCredential` names. Ban and
     * suspension are not here, and the note above says why.
     */
    const restricted = (d: Record<string, unknown>): boolean =>
      d.isDeleted === true ||
      String(d.accountState ?? '') === 'permanently_deactivated'

    // Only the edge into restriction. Leaving it alone on the way out is
    // deliberate: the credentials are gone, and the person signs in normally.
    if (!restricted(after) || restricted(before)) return null

    const uid = String(context.params.uid)
    try {
      const tokens = await db
        .collection('quickLoginTokens')
        .where('uid', '==', uid)
        .limit(100)
        .get()
      if (tokens.empty) return null
      await Promise.all(tokens.docs.map((d) => d.ref.delete().catch(() => undefined)))
      functions.logger.info(
        'Revoked quick-login credentials for a deleted account.',
        { uid, revoked: tokens.size },
      )
    } catch (err) {
      // Reported, not thrown. The redeem-time check still refuses this account,
      // so a failure here costs defence in depth rather than admitting anyone.
      functions.logger.error('Could not revoke quick-login credentials.', { uid, err })
    }
    return null
  })

/**
 * ONE DEVICE, ONE GUEST ACCOUNT — and the server is what makes that true.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `signInAsGuest` used to fall through to `signInAnonymously()` whenever the
 * local Firebase session and the quick-login secret were both unavailable. That
 * is a new Firebase uid, and it is the wrong answer to "I could not read my own
 * storage": the old guest account keeps its diamonds, its beans, its level and
 * its history, and the person holding the phone is looking at an empty one. The
 * balance is not lost — it is stranded, which is worse, because nothing on
 * either side says so.
 *
 * A guest identity therefore belongs to the DEVICE, and the record of that
 * lives here rather than on the handset. Local state is a cache; this is the
 * fact.
 *
 * ── HOW OWNERSHIP IS PROVED ────────────────────────────────────────────────
 *
 * Two different things, deliberately kept apart:
 *
 *   `deviceId`     — `Settings.Secure.ANDROID_ID`. Client-supplied and NOT
 *                    attested. It answers "which device is this" well enough
 *                    for the ban model, which already keys on it, and it is
 *                    what makes this one-guest-per-DEVICE rather than
 *                    one-guest-per-app-install.
 *
 *   `deviceSecret` — 256 random bits the client generates once and keeps in
 *                    Block Store. Only its SHA-256 is stored here. It answers
 *                    "prove it", and it is the ONLY thing that will buy a
 *                    custom token for an existing guest.
 *
 * A custom token is a full session for that account. Minting one on `deviceId`
 * alone would mean anybody who learned a device id could take the account —
 * and a device id is not a secret, it is an identifier. So the binding is
 * looked up by device id and released only against the secret.
 *
 * The consequence is stated plainly rather than hidden: a device that loses its
 * Block Store entry, and has no live session for the account either, can no
 * longer reach its own guest account. It is told so. It does NOT get a
 * replacement, because a replacement is the stranded-balance bug wearing a
 * friendlier face. A caller that still holds a verified session for the bound
 * account can re-key the binding, which is the one way back.
 *
 * The only binding that may be replaced is one whose account has been PURGED.
 * That is a dead pointer, not an account, and refusing to replace it would mean
 * deleting a guest account bars the handset from ever having another one.
 *
 * ── UNIQUENESS ─────────────────────────────────────────────────────────────
 *
 * The binding is read and written inside one transaction. Two simultaneous
 * first-launches on one device therefore produce exactly one binding; the loser
 * is handed the winner's uid and signs into that, and the anonymous account it
 * had already created is discarded with nothing in it. Without the transaction
 * the race writes twice and the invariant this whole function exists for is
 * broken on the very first use.
 *
 * ── WHAT THIS DOES NOT DECIDE ──────────────────────────────────────────────
 *
 * Bans, suspensions and the deletion window belong to `resolveIdentity`, which
 * every sign-in already passes through. Duplicating them here would put the same
 * policy in two places, and the copy that went stale would be this one. The only
 * restriction read here is the device ban, and only to refuse CREATING a guest
 * on a barred handset — which is this collection's own business.
 *
 * `decideGuestClaim` in ./guestBinding holds the rule itself, with no Firestore
 * in it, so that every branch can be tested.
 */
export const claimGuestIdentity = functions
  .region('asia-south1')
  .https.onCall(async (data: {
    deviceId?: string
    /** The raw secret. Only its SHA-256 is stored. */
    deviceSecret?: string
    /**
     * A uid the caller has just created anonymously and wants bound.
     *
     * Absent on the first call, which is a question rather than a claim: the
     * client asks what this device already owns BEFORE creating anything. That
     * ordering is the entire fix.
     */
    uid?: string
  }, context) => {
    const deviceId = String(data?.deviceId ?? '').slice(0, 128).trim()
    const secret = String(data?.deviceSecret ?? '').trim()
    if (deviceId === '' || secret.length < 32) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'A device id and a device secret are required.',
      )
    }

    const secretHash = hashToken(secret)
    const ref = db.collection('guestDeviceBindings').doc(deviceId)
    const wanted = String(data?.uid ?? '').trim()

    /*
     * A device ban blocks CREATING a guest here; it does not block recovering
     * the one that already exists.
     *
     * The split is deliberate. Refusing to create is this function's own
     * business — a new Auth record and a new document for a barred handset is
     * the abuse this collection exists to stop. Refusing to recover is not:
     * `resolveIdentity` is the one place that decides what a restricted account
     * or a barred device is told, and it bars the device again on the way past.
     * Duplicating that policy here would mean two places deciding, and the one
     * that is wrong would be this one.
     */
    let deviceBanReason = ''
    const devSnap = await db.collection('bannedDevices').doc(deviceId).get()
    if (devSnap.exists && devSnap.get('isActive') !== false) {
      deviceBanReason = String(devSnap.get('reason') ?? 'This device has been barred.')
    }

    /*
     * ── HAS THE BOUND ACCOUNT OUTGROWN THE BINDING ───────────────────────────
     *
     * Read here, before the transaction, because Auth cannot be read inside one.
     * The uid is re-checked inside the transaction, so a binding that changed in
     * between is never released on a stale reading of the old one.
     *
     * `decideGuestClaim` says what this means.
     */
    let upgradedUid = ''
    const preSnap = await ref.get()
    const preUid = preSnap.exists ? String(preSnap.get('uid') ?? '') : ''
    if (preUid !== '') {
      try {
        const rec = await admin.auth().getUser(preUid)
        if (rec.providerData.length > 0) upgradedUid = preUid
      } catch (_err) {
        // No Auth record. The document test inside the transaction decides.
      }
    }

    /*
     * And the same question about the CALLER's account, which is the one that
     * matters for writing. A uid with a provider on it is not a guest and must
     * never be recorded as this device's — see `decideGuestClaim`.
     */
    let wantedIsUpgraded = false
    if (wanted !== '') {
      try {
        const rec = await admin.auth().getUser(wanted)
        wantedIsUpgraded = rec.providerData.length > 0
      } catch (_err) {
        // No Auth record for a uid the caller claims to hold. Not bindable
        // either way; the transaction refuses it on the document checks.
      }
    }

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const boundUid = snap.exists ? String(snap.get('uid') ?? '') : ''

      // All reads before any write — Firestore requires it, and the account
      // document has to be read in the SAME transaction as the binding, or two
      // launches could each decide the other's binding was dead.
      const boundUser = boundUid === ''
        ? null
        : await tx.get(db.collection('users').doc(boundUid))

      // Does the CALLER's own account hold anything. Separates a real conflict
      // between two accounts with data from a client that merely lost a race.
      const wantedUser = wanted === '' || wanted === boundUid
        ? null
        : await tx.get(db.collection('users').doc(wanted))

      const createdAt = snap.get('createdAt') as admin.firestore.Timestamp | undefined

      /*
       * AUTH-001 reverse index: `guestUidBindings/{uid}` → the device it is the
       * guest of. Read inside the transaction so two devices racing to bind the
       * same uid cannot both win. A reverse entry only counts while the device
       * binding it names still points back at this uid; otherwise it is stale.
       */
      let wantedBoundElsewhere = false
      if (wanted !== '' && wanted !== boundUid) {
        const rev = await tx.get(db.collection(GUEST_UID_BINDINGS).doc(wanted))
        const otherDevice = rev.exists ? String(rev.get('deviceId') ?? '') : ''
        if (otherDevice !== '' && otherDevice !== deviceId) {
          const other = await tx.get(db.collection('guestDeviceBindings').doc(otherDevice))
          wantedBoundElsewhere = other.exists && String(other.get('uid') ?? '') === wanted
        }
      }

      const callerUid = context.auth?.uid ?? ''

      /*
       * P0-9 (AUTH-001-R): a CUSTOM-token session proves nothing about who owns
       * this binding. This very function mints custom tokens from the device
       * secret — so a binding written by an attacker before Phase 1A yields the
       * attacker a custom-token session for the victim's uid, and counting that
       * session as "signed in as the bound uid" let it promote its own binding
       * to owner-verified, re-key the secret, and open an upgraded account.
       * Only a session the account began itself (anonymous, phone, Google,
       * email) counts.
       */
      const callerProvider = String(
        (context.auth?.token as { firebase?: { sign_in_provider?: string } } | undefined)
          ?.firebase?.sign_in_provider ?? '',
      )
      const callerOwnsBoundUid = boundUid !== '' && context.auth?.uid === boundUid
        && callerProvider !== 'custom'

      const decision = decideGuestClaim({
        deviceBanned: deviceBanReason !== '',
        boundUid,
        secretMatches: secretHash === String(snap.get('secretHash') ?? ''),
        boundUserExists: boundUser?.exists === true,
        // Only when it is this binding's uid, not the one read a moment ago.
        boundIsUpgraded: boundUid !== '' && boundUid === upgradedUid,
        bindingAgeMs: createdAt == null ? null : Date.now() - createdAt.toMillis(),
        wantedUid: wanted,
        wantedUserExists: wantedUser?.exists === true,
        wantedIsUpgraded,
        // Verified by Firebase before this function ran. The call is otherwise
        // unauthenticated by design — the caller has no session yet, which is
        // what it is asking for — so this is empty on most paths. P0-9: and a
        // custom-token session does not count (see `callerOwnsBoundUid`).
        callerIsBoundUid: callerOwnsBoundUid,
        callerUid,
        wantedBoundElsewhere,
        bindingVerified: snap.get('ownerVerified') === true,
      })

      /*
       * P0-9 (AUTH-001-R): before a token is issued for an existing binding,
       * the reverse index has to agree that this device is the uid's ONE
       * device. Read here, before any write, as a transaction requires.
       *
       *   quarantined entry          → no token (a person resolves it);
       *   entry names another device → if any other binding still points at
       *                                the uid, it is bound twice: quarantine,
       *                                no token. Otherwise the entry is stale or
       *                                missing (a legacy binding) and is pointed
       *                                at this device.
       *
       * `scripts/migrate-guest-bindings.mjs` builds the index for every legacy
       * binding ahead of this; this is the backstop for any it has not seen.
       */
      let tokenRefusal: '' | 'quarantined' | 'multi_device' = ''
      let otherDevices: string[] = []
      let indexThisDevice = false
      if (decision.status === 'existing_guest' && decision.write === 'touch') {
        const rev = await tx.get(db.collection(GUEST_UID_BINDINGS).doc(boundUid))
        if (rev.exists && rev.get('quarantined') === true) {
          tokenRefusal = 'quarantined'
        } else if (!rev.exists || String(rev.get('deviceId') ?? '') !== deviceId) {
          const sameUid = await tx.get(
            db.collection('guestDeviceBindings').where('uid', '==', boundUid),
          )
          otherDevices = sameUid.docs.map((d) => d.id).filter((id) => id !== deviceId)
          if (otherDevices.length > 0) tokenRefusal = 'multi_device'
          else indexThisDevice = true
        }
      }

      if (decision.write === 'bind') {
        /*
         * `set`, not `create`: this path may be overwriting a released binding,
         * and `create` would throw on it. `decideGuestClaim` is what keeps it
         * from ever reaching a live one.
         *
         * The replacement keys are OMITTED rather than deleted, and that is not
         * a stylistic choice. `FieldValue.delete()` is only legal in `update()`
         * or in `set()` with `{merge: true}`; in a plain `set` the SDK throws,
         * the callable framework wraps a non-HttpsError as the opaque code
         * INTERNAL, and the person tapping "Continue as guest" on a device with
         * no binding — the FIRST guest on every new handset, the commonest path
         * there is — sees "internal error" with nothing to say what is wrong.
         *
         * A `set` without merge replaces the whole document anyway, so leaving
         * a key out does exactly what deleting it was meant to do.
         */
        tx.set(ref, {
          ...bindingPayload(decision, boundUid),
          secretHash,
          deviceId,
          // AUTH-001: `decideGuestClaim` only returns `bind` for a caller signed
          // in as this very uid, so this binding is owner-proven.
          ownerVerified: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        tx.set(db.collection(GUEST_UID_BINDINGS).doc(decision.uid), {
          deviceId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      } else if (decision.write === 'rekey') {
        // The uid is untouched. Only the proof changes, and only for a caller
        // that already holds a verified session for this exact account.
        tx.update(ref, {
          secretHash,
          ownerVerified: true,
          rekeyedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        tx.set(db.collection(GUEST_UID_BINDINGS).doc(decision.uid), {
          deviceId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      } else if (decision.write === 'touch') {
        // A caller signed in as the bound uid upgrades a pre-Phase-1A binding to
        // owner-proven on the way past; nobody else can. P0-9: "signed in as"
        // excludes a custom-token session (`callerOwnsBoundUid`).
        const proven = callerOwnsBoundUid
        tx.update(ref, {
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(proven && tokenRefusal === '' ? { ownerVerified: true } : {}),
        })
        if (tokenRefusal === 'multi_device') {
          tx.set(db.collection(GUEST_UID_BINDINGS).doc(boundUid), {
            quarantined: true,
            quarantineReason: 'bound_on_multiple_devices',
            quarantinedDeviceIds: [deviceId, ...otherDevices],
            quarantinedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true })
        } else if (tokenRefusal === '' && (proven || indexThisDevice)) {
          tx.set(db.collection(GUEST_UID_BINDINGS).doc(boundUid), {
            deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true })
        }
      }

      return { ...decision, tokenRefusal }
    })

    if (result.status === 'device_banned') {
      return { status: result.status, reason: deviceBanReason }
    }
    if (result.status === 'conflict') {
      /*
       * Logged because it is the one outcome nobody can diagnose from the
       * handset: two accounts with data, one device, and a person who will say
       * only that the app would not let them in.
       */
      functions.logger.warn('guest device binding conflict', {
        deviceId, boundUid: result.uid, callerUid: wanted,
      })
    }
    if (result.status !== 'existing_guest') {
      return { status: result.status, uid: result.uid }
    }

    if (result.tokenRefusal !== '') {
      // P0-9: logged because, like a conflict, it is undiagnosable from the
      // handset — and a quarantined uid needs a person to decide which device
      // keeps it.
      functions.logger.warn('guest token refused by the reverse index', {
        deviceId, uid: result.uid, reason: result.tokenRefusal,
      })
      return { status: 'unrecoverable' as GuestClaimStatus, uid: result.uid }
    }

    if (result.write === 'rekey') {
      functions.logger.info('guest binding re-keyed from a live session', {
        deviceId, uid: result.uid,
      })
      // No token: the caller is already signed in as this account, which is how
      // it proved ownership. Minting one would be a second credential for a
      // session that is already open.
      return { status: 'existing_guest' as GuestClaimStatus, uid: result.uid }
    }

    /*
     * The Auth record has to exist or the custom token buys a session that
     * fails on its first authenticated call. Checked outside the transaction
     * because Auth cannot be read inside one; a uid that is missing here but
     * present as a document is an inconsistency, not a recovery case, so it is
     * refused rather than papered over with a new account.
     */
    try {
      await admin.auth().getUser(result.uid)
    } catch (err) {
      functions.logger.error('guest binding points at a missing auth record', {
        deviceId, uid: result.uid, err,
      })
      return { status: 'unrecoverable' as GuestClaimStatus, uid: result.uid }
    }

    return {
      status: 'existing_guest' as GuestClaimStatus,
      uid: result.uid,
      customToken: await admin.auth().createCustomToken(result.uid),
    }
  })

/**
 * The canonical identity key — every digit, country code included.
 *
 * It used to be the last TEN digits, so `+14155550100` and `+914155550100` were
 * one identity. Two consequences, the second serious: a legitimate foreign
 * sign-up was refused as "already used by another Zipper account", and
 * `bindVerifiedIdentity` would BLANK the `phoneKey`, `phoneNumber` and `email`
 * of an unrelated account in another country. See ./phone for the full note.
 *
 * Re-exported under the old name so the twelve call sites in this file keep
 * reading as they did; what changed is what the key means.
 */
const phoneKey = phoneE164Key
// Re-exported under the old name: `hosts.ts` and the Android-facing callables
// import `phoneKey` from here, and the name is still the right one — what
// changed is what the key means, not what it is for.
export { phoneE164Key as phoneKey }

/**
 * Every account that might hold this number, old key and new.
 *
 * ── WHY TWO QUERIES ────────────────────────────────────────────────────────
 *
 * Every `users.phoneKey` already in the database is a ten-digit legacy value.
 * Querying only the new full-length key would miss all of them, and a miss here
 * reads as "nobody holds this number" — which is how a returning Indian user
 * would be handed a second account and a stale record would escape release.
 *
 * So the legacy key is tried as a fallback, and every legacy hit must then pass
 * `sameNumberStrict` against the candidate's STORED number before it counts.
 * That is what stops the fallback reintroducing the collision it exists to
 * tolerate: a ten-digit key shared by a `+1` and a `+91` number matches the
 * query and fails the comparison.
 *
 * A record whose stored `phoneNumber` is itself bare — written before country
 * codes were kept — cannot be told apart from a foreign number sharing its
 * digits, and is deliberately NOT returned. Refusing to act is the safe answer
 * when the alternative is blanking somebody else's identity; the survey script
 * lists these for a human.
 */
async function holdersOfPhone(
  canonical: string,
  raw: unknown,
): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  const out: admin.firestore.QueryDocumentSnapshot[] = []
  const seen = new Set<string>()

  const exact = await db
    .collection('users')
    .where('phoneKey', '==', canonical)
    .limit(5)
    .get()
  for (const d of exact.docs) {
    seen.add(d.id)
    out.push(d)
  }

  const legacy = legacyPhoneKey(raw)
  if (legacy === '' || legacy === canonical) return out

  const older = await db
    .collection('users')
    .where('phoneKey', '==', legacy)
    .limit(5)
    .get()
  for (const d of older.docs) {
    if (seen.has(d.id)) continue
    const stored = d.get('phoneNumber') ?? d.get('phone')
    if (sameNumberStrict(stored, raw)) {
      seen.add(d.id)
      out.push(d)
    } else {
      functions.logger.warn(
        'legacy phoneKey hit did not confirm as the same number; ignored',
        { candidate: d.id, canonical },
      )
    }
  }
  return out
}

/** Lower-cased and trimmed. Gmail dots are NOT normalised — see the note below. */
export function emailKey(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase()
}

/** P0-5 (AUTHN-2): the token's address, only once Firebase has seen it confirmed. */
export function tokenEmailVerified(token: Record<string, unknown> | undefined): boolean {
  return emailKey(token?.['email']) !== '' && token?.['email_verified'] === true
}

/*
 * A note on Gmail dot-folding, deliberately not done.
 *
 * `s.o.u.m.y.a@gmail.com` and `soumya@gmail.com` deliver to the same mailbox, so
 * folding dots would catch more duplicates. It would also silently merge two
 * accounts on providers where dots ARE significant, and the app does not know
 * which provider an address belongs to beyond its domain. Matching fewer
 * duplicates is the safer error.
 */

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// ── Quick login ──────────────────────────────────────────────────────────────
//
// MOVED, and deliberately not re-exported from here.
//
// `mintQuickLoginToken`, `redeemQuickLogin` and `revokeQuickLogin` now live in
// `quickLogin.ts`, with the decisions they apply in `quickLoginPolicy.ts`.
//
// The versions that stood here were a 400-day bearer secret redeemed by an
// unauthenticated callable that took no `context` at all, recorded a `deviceId`
// it never compared with anything, and on success stamped `lastUsedAt` — so the
// same secret worked again, from anywhere, for over a year. The replacement
// binds redemption to a signature from a key held in the device's Keystore,
// rotates the credential on every use, and reads account state before it mints
// anything.
//
// `hashToken` stays below: `revokeQuickLoginOnRestriction` and
// `sweepQuickLoginTokens` are still here and still operate on the same
// collection, by design — one collection, one id scheme, two writers.
// ── Identity lookup, before an account is created ────────────────────────────

/**
 * Does an account already exist for this phone or email?
 *
 * Called by the app BEFORE it creates anything, which is the step that was
 * missing: the only identity query in the whole client ran at profile-save
 * time, checked email only, and *rejected* rather than reconciled.
 *
 * Returns no personal data beyond a display name and photo — enough to say
 * "you already have an account, is this you?" and nothing an enumeration
 * attack could harvest. The caller must be signed in, so this is not an open
 * lookup endpoint.
 */
export const findExistingAccount = functions
  .region('asia-south1')
  .https.onCall(async (data: { phone?: string; email?: string }, context) => {
    const callerUid = requireAuth(context)

    const phone = phoneKey(data?.phone)
    const email = emailKey(data?.email)
    if (!phone && !email) {
      throw new functions.https.HttpsError('invalid-argument', 'A phone or an email is required.')
    }

    if (email === OBSERVER_EMAIL) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'That address cannot be used in the app.',
      )
    }

    /*
     * ── YOU MAY ONLY ASK ABOUT AN IDENTIFIER YOU HAVE PROVED ─────────────
     *
     * This was gated on `requireAuth` alone, which made it an account-
     * enumeration endpoint. Any signed-in user — one throwaway guest account is
     * enough — could post arbitrary phone numbers and get back the holder's
     * name, photograph and whether they are banned or suspended. Walk a number
     * range and you have a directory of real people joined to their moderation
     * status.
     *
     * The proof required is the same one `bindVerifiedIdentity` already
     * demands: the identifier has to be on the CALLER'S OWN token, which means
     * they passed an OTP for that number or signed in with that address. That
     * is exactly the legitimate use — "I verified this number and it turned out
     * to be taken, who has it?" — and nothing else.
     */
    const token = (context.auth?.token ?? {}) as Record<string, unknown>
    const provedPhone = phone !== '' && phoneKey(token['phone_number']) === phone
    // P0-5 (AUTHN-2): an address proves nothing until Firebase has seen it
    // confirmed — an email/password sign-up can put any unclaimed address on
    // a token.
    const provedEmail = email !== '' && tokenEmailVerified(token) &&
      emailKey(token['email']) === email
    if (!provedPhone && !provedEmail) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Verify that number or address before asking about it.',
      )
    }

    const found: Array<{
      uid: string
      name: string
      photoUrl: string
      via: string
      /** Why it is held — so the caller can say so rather than guess. */
      accountState: string
    }> = []

    const consider = (doc: admin.firestore.QueryDocumentSnapshot, via: string) => {
      if (doc.id === callerUid) return
      if (found.some((f) => f.uid === doc.id)) return
      /*
       * Skip only the PERMANENTLY deactivated, which is the same line
       * `bindVerifiedIdentity` draws — and that agreement is the point.
       *
       * This used to skip anything with `isDeleted === true`, so an account
       * inside its 30-day recovery window was invisible here while the binder
       * counted it as somebody's and refused. The app therefore asked "is this
       * number taken?", was told no, attempted the bind, and was refused —
       * two callables giving opposite answers about the same number, with the
       * person in the middle reading a contradiction.
       */
      if (doc.get('accountState') === STATE_PERMANENTLY_DEACTIVATED) return
      found.push({
        uid: doc.id,
        name: String(doc.get('name') ?? '').trim(),
        photoUrl: String(doc.get('photoUrl') ?? ''),
        via,
        /** 'active' | 'suspended' | 'banned' | 'recovery_pending' — why it is held. */
        accountState: String(doc.get('accountState') ?? STATE_ACTIVE),
      })
    }

    // Each identifier is queried only if THAT one was proved. Passing a proved
    // phone alongside an unproved email would otherwise have answered both.
    if (provedEmail) {
      const byEmail = await db.collection('users').where('email', '==', email).limit(5).get()
      byEmail.docs.forEach((d) => consider(d, 'email'))
    }

    if (provedPhone) {
      /*
       * Queried on `phoneKey`, not on `phoneNumber`.
       *
       * `phoneNumber` holds whatever the sign-in produced — `+919876543210`
       * from a Firebase phone token, a bare ten digits typed into the profile
       * form. An equality query on that field matches one spelling and misses
       * the other, which is precisely how the same human ended up with two
       * accounts and nothing noticed. `syncPhoneKey` below keeps the normalised
       * copy in step.
       */
      const byPhone = await db.collection('users').where('phoneKey', '==', phone).limit(5).get()
      byPhone.docs.forEach((d) => consider(d, 'phone'))
    }

    return { accounts: found }
  })

/**
 * Keep `users/{uid}.phoneKey` in step with `phoneNumber`.
 *
 * A denormalised, normalised copy of the number, because Firestore cannot index
 * a computed value and an equality query is the only affordable way to ask "who
 * else is this person". Written by a trigger rather than by the client so it
 * cannot drift or be forged.
 */
export const syncPhoneKey = functions
  .region('asia-south1')
  .firestore.document('users/{uid}')
  .onWrite(async (change) => {
    if (!change.after.exists) return null
    const after = change.after.data() as Record<string, any>
    const before = change.before.exists ? (change.before.data() as Record<string, any>) : {}

    const nextKey = phoneKey(after.phoneNumber ?? after.phone)
    const nextEmail = emailKey(after.email)

    // Only write when something actually changed, or this trigger answers its
    // own write forever.
    if (after.phoneKey === nextKey && after.email === nextEmail) return null
    if (
      phoneKey(before.phoneNumber ?? before.phone) === nextKey &&
      emailKey(before.email) === nextEmail &&
      after.phoneKey === nextKey
    ) {
      return null
    }

    const patch: Record<string, any> = {}
    if (after.phoneKey !== nextKey) patch.phoneKey = nextKey
    // Normalise the stored email in place, so the equality query above and the
    // one in AuthRepository agree about what "the same address" means.
    if (typeof after.email === 'string' && after.email !== nextEmail) patch.email = nextEmail
    if (Object.keys(patch).length === 0) return null

    await change.after.ref.update(patch).catch(() => undefined)
    return null
  })

// ── Binding a verified identity ──────────────────────────────────────────────

/**
 * Bind a phone or an email that the caller has JUST PROVEN they control.
 *
 * ── THE RULE, AND WHY IT IS NOT A CHOICE ─────────────────────────────────────
 *
 * An earlier version of this asked the user which of two accounts to keep and
 * soft-deleted the other. That was wrong, and dangerously so. Passing an OTP
 * proves control of a phone number; it does not prove authority over an account
 * that number is attached to. Phone numbers are recycled by carriers, handsets
 * are sold, SIMs are swapped — so "I received the code" and "this account is
 * mine" are different claims, and treating the first as the second is an
 * account-takeover mechanism with a friendly dialog on top.
 *
 * Three cases, decided by the STATE of whatever already holds the identity:
 *
 *   NOTHING HOLDS IT          → bind. The ordinary case.
 *
 *   AN ACTIVE ACCOUNT HOLDS IT → refuse, flatly. No merge, no transfer, no
 *                               choice offered. The active account is
 *                               untouched and the caller is told to sign into
 *                               it instead. This is the case that used to be a
 *                               dialog.
 *
 *   A DELETED ACCOUNT HOLDS IT → release it and bind. A deleted account is no
 *                               longer an identity anybody can act as, so the
 *                               number is genuinely free. Its history stays
 *                               with it — nothing is merged into the caller's
 *                               account, ever.
 *
 * ── RECOVERY_PENDING IS NOT "DELETED" FOR THIS PURPOSE ───────────────────────
 *
 * An account inside its grace window can still be recovered in one tap, and
 * recovering it must give back a working sign-in. Releasing its phone number to
 * somebody else would make that impossible, so it is treated as ACTIVE here.
 * Only `permanently_deactivated` — grace elapsed, login already deleted —
 * releases its identity.
 */
export const bindVerifiedIdentity = functions
  .region('asia-south1')
  .https.onCall(async (data: { phone?: string; email?: string }, context) => {
    const uid = requireAuth(context)

    const phone = phoneKey(data?.phone)
    const email = emailKey(data?.email)
    if (!phone && !email) {
      throw new functions.https.HttpsError('invalid-argument', 'A phone or an email is required.')
    }
    if (email === OBSERVER_EMAIL) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'That address cannot be used in the app.',
      )
    }

    /*
     * The CALLER'S OWN verification is the precondition, and it is checked
     * against the auth token rather than against what the request claims.
     *
     * `linkWithCredential` on the client is what actually attaches the
     * credential to the Firebase account, so by the time this is called the
     * token already carries the verified value. A request naming a number the
     * token does not hold is a client asking to bind something it never proved.
     */
    const token = (context.auth?.token ?? {}) as Record<string, unknown>
    if (phone && phoneKey(token['phone_number']) !== phone) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify that number before binding it.',
      )
    }
    if (email && (emailKey(token['email']) !== email || !tokenEmailVerified(token))) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify that address before binding it.',
      )
    }

    const result = await bindContactCore(uid, { phone, rawPhone: data?.phone, email }, token)

    // UGP (D21): a session that began anonymously keeps saying so — see
    // `sameUidSessionToken` — so it is handed a token for the SAME uid.
    //
    // ONLY for a session that is current. The bind itself stays ungated, as it
    // always was; the token is not. A minted token is a brand-new sign-in with a
    // fresh `auth_time`, so handing one to a displaced device (whose ID token
    // stays valid for up to an hour) or to a restricted account would let a
    // re-bind of an already-bound number walk straight past the session cut-off.
    let sessionCurrent = true
    try {
      await assertActiveSession(uid, data, 'bindVerifiedIdentity', context.auth?.token)
    } catch {
      sessionCurrent = false
    }
    const customToken = sessionCurrent ? await sameUidSessionToken(uid, token) : ''
    return customToken ? { ...result, customToken } : result
  })

/**
 * The binding itself — every rule after "the caller has proven this contact".
 *
 * UGP-C: extracted unchanged from `bindVerifiedIdentity` so that the email
 * one-time code (`emailOtp.ts`) binds through EXACTLY the same rules as the
 * phone path: no replacement of a contact already on the account, a refusal
 * for a live or recoverable holder, release only from permanently deactivated
 * holders, the same records. Two copies of these rules would be two identity
 * systems; there is one.
 *
 * Throws `HttpsError` on every refusal and writes nothing in that case.
 *
 * @param rawPhone the number as the caller sent it (for the legacy-key check)
 * @param token    the caller's verified token, used for the stored number's
 *                 spelling and recorded on a refusal
 */
export async function bindContactCore(
  uid: string,
  contact: { phone?: string; rawPhone?: unknown; email?: string },
  token: Record<string, unknown>,
): Promise<{ bound: true; releasedFrom: string[] }> {
  const phone = contact.phone ?? ''
  const rawPhone = contact.rawPhone
  const email = contact.email ?? ''
  /*
   * P0-5 (AUTHN-3, interim): a contact already on this account is never
   * REPLACED here. Binding the same one again (or the same number in another
   * spelling) is fine. Changing it is a decision for the contact-change
   * workflow (D1/D2), which does not exist yet; until it does the attempt is
   * refused and recorded, and nothing is written.
   */
  const own = await db.collection('users').doc(uid).get()
  const ownPhone = own.exists ? (own.get('phoneNumber') ?? own.get('phone') ?? '') : ''
  const ownEmail = own.exists ? emailKey(own.get('email')) : ''
  const replacing: string[] = []
  if (phone && phoneKey(ownPhone) !== '' && phoneKey(ownPhone) !== phone &&
      !sameNumber(ownPhone, token['phone_number'])) {
    replacing.push('phone')
  }
  if (email && ownEmail !== '' && ownEmail !== email) replacing.push('email')
  if (replacing.length > 0) {
    await db.collection('identityChangeRefusals').add({
      uid,
      fields: replacing,
      reason: 'contact_replacement_refused',
      signInProvider: String((token['firebase'] as { sign_in_provider?: string } | undefined)
        ?.sign_in_provider ?? ''),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    throw new functions.https.HttpsError(
      'failed-precondition',
      replacing.includes('phone')
        ? 'This account already has a phone number. Changing it needs support — contact us.'
        : 'This account already has an email address. Changing it needs support — contact us.',
      { reason: 'contact_replacement_refused' },
    )
  }

  const holders: Array<admin.firestore.QueryDocumentSnapshot> = []
  if (phone) {
    holders.push(...(await holdersOfPhone(phone, rawPhone)))
  }
  if (email) {
    const byEmail = await db.collection('users').where('email', '==', email).limit(5).get()
    holders.push(...byEmail.docs)
  }

  const others = holders.filter((d) => d.id !== uid)

  const stillHeld = others.filter(
    (d) => d.get('accountState') !== STATE_PERMANENTLY_DEACTIVATED,
  )

  /*
   * CASE C-recoverable — the holder is DELETED but still inside its window.
   *
   * Split out of the blanket refusal below. Both answers are "no", but they
   * are different noes and the person can act on only one of them. "Already
   * used by another Zipper account. Sign in to that account instead." is
   * false comfort when the account in question is their own, deleted last
   * week, and sitting in a 30-day recovery window — they read it as somebody
   * else having taken their number and have no idea the way back is to sign
   * in with it.
   *
   * Nothing is released and nothing is bound. The recovery flow is the
   * existing one: signing in with this identity reaches `resolveIdentity`,
   * which answers `deleted_recoverable`, and the app offers Recover Account.
   * This only makes the refusal point at it.
   */
  const recoverable = stillHeld.find((d) => d.get('isDeleted') === true)
  if (recoverable) {
    const dueAt = recoverable.get('deletionDueAt') as
      | admin.firestore.Timestamp
      | null
      | undefined
    throw new functions.https.HttpsError(
      'already-exists',
      phone
        ? 'This phone number belongs to a Zipper account that was deleted and ' +
          'can still be recovered. Sign in with this number to restore it.'
        : 'This email belongs to a Zipper account that was deleted and can ' +
          'still be recovered. Sign in with this address to restore it.',
      {
        reason: 'deleted_recoverable',
        deletionDueAtMs: dueAt ? dueAt.toMillis() : 0,
      },
    )
  }

  // CASE B — an account that is still somebody's. Refuse and change nothing.
  if (stillHeld.length > 0) {
    throw new functions.https.HttpsError(
      'already-exists',
      phone
        ? 'This phone number is already used by another Zipper account. ' +
          'Sign in to that account instead.'
        : 'This email is already used by another Zipper account. ' +
          'Sign in to that account instead.',
      { reason: 'active_holder' },
    )
  }

  // CASE C — only permanently deactivated accounts hold it. Release and bind.
  const released: string[] = []
  for (const stale of others) {
    /*
     * Cleared on the OLD document, not moved to the new one.
     *
     * The old account keeps every transaction, every warning and every gift
     * it ever had — see accounts.ts. What it loses is the claim on this phone
     * number, which is the only thing standing between the caller and an
     * identity nobody is using.
     */
    await stale.ref.set({ phoneKey: '', phoneNumber: '', email: '' }, { merge: true })
    released.push(stale.id)
  }

  const patch: Record<string, any> = {}
  if (phone) {
    patch.phoneKey = phone
    patch.phoneNumber = String(token['phone_number'] ?? rawPhone ?? '')
  }
  if (email) patch.email = email
  await db.collection('users').doc(uid).set(patch, { merge: true })

  if (released.length > 0) {
    // A released identity is worth a record. Support will be asked about it:
    // "my old number signs into somebody else's account now".
    await db.collection('identityReleases').add({
      boundTo: uid,
      releasedFrom: released,
      phoneKey: phone,
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  }

  return { bound: true, releasedFrom: released }
}

/**
 * UGP (D21): a same-uid custom token for a session that began ANONYMOUSLY.
 *
 * `sign_in_provider` records how a session began and does not change when a
 * contact is bound mid-session (see `isGuestAccount`). Two checks read it
 * rather than the account: Storage `isNonGuest()` (a host applicant's own KYC
 * upload) and Functions `guestRefusal` (redeeming a host invitation). So a
 * guest who has just bound a phone or an email was still refused both until
 * they happened to sign in again.
 *
 * Signing in with a custom token for the SAME uid ends the anonymous session
 * without touching the account: same uid, same data, no new identity — the
 * token is minted only for the caller, only for their own uid. It is what
 * `claimGuestIdentity` already does for every returning guest. Best effort:
 * no token means the old session simply carries on, as it did before.
 */
export async function sameUidSessionToken(
  uid: string,
  token: Record<string, unknown>,
): Promise<string> {
  const provider = String((token['firebase'] as { sign_in_provider?: string } | undefined)
    ?.sign_in_provider ?? '')
  if (provider !== 'anonymous') return ''
  try {
    return await admin.auth().createCustomToken(uid)
  } catch (err) {
    functions.logger.warn('same-uid session token not minted', { err: String(err) })
    return ''
  }
}

// ── Google sign-in for an email that already has an account ──────────────────

/**
 * Called by the app right after a Google sign-in CREATED a new uid.
 *
 * If exactly one other live account already holds that address as a verified
 * email (a guest that bound it with a one-time code, say), the new empty uid is
 * removed, Google is linked onto the existing account, and a custom token for
 * that account is returned. The rule — and why it is email-only — is in
 * ./emailAdoption. Anything that does not qualify returns `none` and the app
 * carries on with the new account exactly as before.
 */
export const adoptEmailAccount = functions
  .region('asia-south1')
  .https.onCall(async (_data: unknown, context) => {
    const callerUid = requireAuth(context)
    const token = (context.auth?.token ?? {}) as Record<string, any>
    const email = emailKey(token['email'])
    if (email === '' || email === OBSERVER_EMAIL) return { status: 'none', reason: 'no_email' }

    const callerRec = await admin.auth().getUser(callerUid)
    const callerDoc = await db.collection('users').doc(callerUid).get()
    const created = Date.parse(callerRec.metadata.creationTime ?? '')
    const callerHasData = callerDoc.exists && (
      callerDoc.get('isProfileComplete') === true ||
      Number(callerDoc.get('diamonds') ?? 0) > 0 ||
      Number(callerDoc.get('beans') ?? 0) > 0
    )

    const candidates: AdoptionCandidate[] = []
    const byEmail = await db.collection('users').where('email', '==', email).limit(5).get()
    for (const d of byEmail.docs) {
      if (d.id === callerUid) continue
      try {
        const r = await admin.auth().getUser(d.id)
        candidates.push({
          uid: d.id,
          authEmail: emailKey(r.email),
          authEmailVerified: r.emailVerified === true,
          disabled: r.disabled === true,
          accountState: String(d.get('accountState') ?? STATE_ACTIVE),
        })
      } catch (_err) {
        // No Auth record behind the document: not an account anybody can use.
      }
    }

    const decision = decideEmailAdoption({
      callerUid,
      signInProvider: String(token['firebase']?.['sign_in_provider'] ?? ''),
      email,
      emailVerified: token['email_verified'] === true,
      callerProviders: callerRec.providerData.map((p) => p.providerId),
      callerAgeMs: Number.isFinite(created) ? Date.now() - created : Number.MAX_SAFE_INTEGER,
      callerHasData,
      // FX-08: a Google-only login with no users document is adoptable at any
      // age (see emailAdoption.ts).
      callerHasDocument: callerDoc.exists,
      candidates,
    })
    if (decision.action !== 'adopt') return { status: 'none', reason: decision.reason }

    const target = decision.targetUid
    const google = callerRec.providerData.find((p) => p.providerId === 'google.com')

    // The duplicate goes first: a provider uid can belong to one account only,
    // so Google cannot be linked to the target while the new uid still holds it.
    await db.collection('users').doc(callerUid).delete().catch(() => undefined)
    await db.collection('publicProfiles').doc(callerUid).delete().catch(() => undefined)
    await admin.auth().deleteUser(callerUid)

    let linked = false
    if (google) {
      try {
        await admin.auth().updateUser(target, {
          providerToLink: {
            providerId: 'google.com',
            uid: google.uid,
            email,
            displayName: google.displayName,
            photoURL: google.photoURL,
          },
        })
        linked = true
      } catch (err) {
        // The person still gets their account; Google simply is not attached
        // yet and this path runs again next time.
        functions.logger.warn('adoptEmailAccount: could not link Google', { target, err })
      }
    }

    functions.logger.info('adoptEmailAccount: Google sign-in resolved to existing account', {
      discarded: callerUid, target, linked,
    })
    const customToken = await admin.auth().createCustomToken(target)
    return { status: 'adopted', uid: target, customToken, linked }
  })

// ── The CRM and the app, as one account ──────────────────────────────────────

/*
 * ── WHERE THE CRM-AND-APP JOIN ACTUALLY LIVES ────────────────────────────────
 *
 * Not here. An `attachAppIdentity` callable was written in this file and then
 * removed, because the place a CRM account is CREATED is Python —
 * `backend/app/services/crm_directory.py`, `mirror()`, which already writes
 * `crmUsers` and `verifiedIdentities` in the same breath. Adding a second
 * implementation in TypeScript would have meant the phone attach and the app
 * document being written from two runtimes that have to agree about role names,
 * phone normalisation and merge semantics — which is exactly the kind of
 * duplicated-logic drift that produced half the defects in this codebase.
 *
 * See `_attach_app_identity` in that file. `phoneKey` above is duplicated there
 * as `_phone_key` out of necessity — three runtimes, no shared module — and both
 * say so.
 */

// ── Housekeeping ─────────────────────────────────────────────────────────────

/**
 * Sweep the three collections quick login leaves behind.
 *
 * `quickLoginTokens` holds CREDENTIALS. A collection of them that only ever
 * grows is a collection of keys to accounts, including accounts that have since
 * been deleted, and there is no reason to keep one past its expiry.
 *
 * `quickLoginChallenges` is the one that grows fastest: one document per
 * quick-login tap, alive for two minutes, consumed on first use. Nothing reads a
 * used or expired challenge — the whole point is that it is single-use — so
 * every one of them is litter the moment it is spent.
 *
 * `quickLoginRate` holds failure counters. A counter whose cool-off has long
 * passed is not protecting anything; keeping it would eventually mean a
 * credential carrying a failure from last month towards this month's ceiling.
 *
 * Batched, because one `limit(500)` per day is not a sweep when the collection
 * grows per tap. [BATCH] documents per pass and [MAX_PASSES] passes, so the run
 * is bounded and a backlog drains over consecutive days rather than timing out
 * in one.
 */
const SWEEP_BATCH = 400
const SWEEP_MAX_PASSES = 10

async function sweepExpired(
  collection: string,
  field: string,
  cutoff: admin.firestore.Timestamp,
): Promise<number> {
  let removed = 0
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass++) {
    const stale = await db
      .collection(collection)
      .where(field, '<=', cutoff)
      .limit(SWEEP_BATCH)
      .get()
    if (stale.empty) break

    const batch = db.batch()
    stale.docs.forEach((doc) => batch.delete(doc.ref))
    try {
      await batch.commit()
      removed += stale.size
    } catch (err) {
      functions.logger.error(`sweep ${collection}`, err)
      break
    }
    // A short page means the end of the backlog; another query would be a
    // round trip for nothing.
    if (stale.size < SWEEP_BATCH) break
  }
  return removed
}

export const sweepQuickLoginTokens = functions
  .region('asia-south1')
  .pubsub.schedule('30 4 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now()
    // Rate records outlive their cool-off by a day, so a sweep running between
    // two attempts cannot wipe a counter that is still doing its job.
    const rateCutoff = admin.firestore.Timestamp.fromMillis(
      now.toMillis() - 24 * 60 * 60 * 1000,
    )

    const credentials = await sweepExpired('quickLoginTokens', 'expiresAt', now)
    const challenges = await sweepExpired('quickLoginChallenges', 'expiresAt', now)
    const rate = await sweepExpired('quickLoginRate', 'updatedAt', rateCutoff)

    if (credentials + challenges + rate > 0) {
      functions.logger.info(
        `sweepQuickLoginTokens removed ${credentials} credentials, ` +
        `${challenges} challenges, ${rate} rate records.`,
      )
    }
    return null
  })

// ── The one question every sign-in asks ──────────────────────────────────────

/** What the app should do with the person who just authenticated. */
type Decision =
  /** Ordinary. Carry on into the app or into profile setup. */
  | 'allow'
  /** The observer. Refuse, and delete the login that was just made. */
  | 'observer_denied'
  /** Deleted, still inside the grace window. Offer Recover or Start fresh. */
  | 'deleted_recoverable'
  /** Deleted and past the window. The identity is released; this is a new start. */
  | 'deleted_permanent'
  /** Temporarily restricted. The DEVICE is clean — another account may sign in here. */
  | 'suspended'
  /** Banned. The account and this device are both barred. */
  | 'banned'
  /** This device is barred, whoever is holding it. */
  | 'device_banned'

/**
 * Resolve who just signed in, before a single document is created.
 *
 * ── WHY THIS IS ONE CALL AND NOT SIX CHECKS ON THE CLIENT ────────────────────
 *
 * The client used to decide everything from `isNewUser`: true meant "make a
 * document", false meant "read one". That single boolean cannot express any of
 * the questions that actually matter — is this the observer, is this account
 * deleted, does this person hold a CRM role, do they still owe us a phone
 * number — so none of them were asked, and the answers leaked out later as
 * duplicate accounts and permission errors.
 *
 * Every one of those is a server question. The CRM role lives in a collection
 * the app cannot read; whether an account is recoverable depends on a deadline
 * the client must not be trusted to compare; and refusing the observer has to
 * happen somewhere a modified app cannot skip. So the app authenticates, calls
 * this once, and does what it is told.
 *
 * ── THE ORDER IS THE SPECIFICATION'S ORDER ───────────────────────────────────
 *
 * Observer first, because that one is a refusal and nothing after it should
 * run. Then the account's state, because a deleted account must be offered
 * recovery rather than quietly replaced. Then the role, because the role
 * decides what is still missing. Then what is missing.
 */
/**
 * D18 (staged rollout) — which build an account runs.
 *
 * The restrictive rules (pinned appeal ids) refuse what builds older than the
 * RC send, so they ship only once enough of the active population runs a
 * build that pins. Nothing reported the running build, so adoption could not
 * be measured. The app now sends its installed `versionCode` to this gate,
 * which runs on every cold start and every sign-in, and it is kept as
 * `appBuildReports/{uid} = { versionCode, seenAt }` — that and nothing else: no
 * device, no name, no contact. `backend/scripts/d18_adoption_report.py`
 * turns it into COUNTS per versionCode; an active account with no recent
 * record is running a build older than the first that reports.
 *
 * Server-only (no rule matches `appBuildReports`, so every client read and write is
 * refused), a separate collection so no `users/{uid}` trigger or listener
 * fires on it, and best-effort: it never changes a decision, and a failed
 * write is only logged.
 */
export const APP_BUILD_REPORTS = 'appBuildReports'

/** The record to keep for a reported versionCode, or null when the report is unusable. */
export function appBuildRecord(reported: unknown): { versionCode: number } | null {
  const code = typeof reported === 'number' ? reported
    : typeof reported === 'string' && /^\d+$/.test(reported.trim()) ? Number(reported.trim())
      : NaN
  if (!Number.isInteger(code) || code <= 0 || code > 1_000_000) return null
  return { versionCode: code }
}

async function recordAppBuild(uid: string, reported: unknown): Promise<void> {
  const record = appBuildRecord(reported)
  if (record === null) return
  try {
    await db.collection(APP_BUILD_REPORTS).doc(uid).set({
      ...record,
      seenAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  } catch (err) {
    functions.logger.warn('could not record the app build', { uid, err: String(err) })
  }
}

export const resolveIdentity = functions
  .region('asia-south1')
  .https.onCall(async (data: { deviceId?: string; appVersionCode?: number }, context) => {
    const uid = requireAuth(context)
    const token = (context.auth?.token ?? {}) as Record<string, unknown>

    const tokenEmail = emailKey(token['email'])
    const tokenPhone = phoneKey(token['phone_number'])

    // ── 1. The observer never reaches the app ────────────────────────────────
    //
    // Checked on the token FIRST, before any document is read, because at this
    // point the observer may have no document at all — they are CRM-only and
    // deliberately have no Firebase account of their own, so a Google sign-in
    // with that address mints a brand-new uid with nothing behind it. The
    // address on the token is the only thing there is to check.
    if (tokenEmail !== '' && tokenEmail === OBSERVER_EMAIL) {
      logger_warnObserver(uid, tokenEmail)
      return { decision: 'observer_denied' as Decision, uid }
    }

    const [userSnap, crmSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('crmUsers').doc(uid).get(),
    ])

    // And again on the record, for the case the token has no email: a phone
    // sign-in onto an account that IS the observer.
    /*
     * Normalised, like `syncMyRoles`.
     *
     * This returned the raw stored string while `syncMyRoles` — reading the
     * same document on the same sign-in — returned the normalised one. For a
     * record still carrying a pre-department role the two disagreed: this said
     * `ops`, that wrote `ops_member`, and whichever the caller happened to read
     * decided what the app believed. One vocabulary, one answer.
     */
    const crmRole = crmSnap.exists ? normaliseCrmRole(crmSnap.get('role')) : ''
    if (crmRole === 'observer' || emailKey(crmSnap.get('email')) === OBSERVER_EMAIL) {
      logger_warnObserver(uid, tokenEmail || emailKey(crmSnap.get('email')))
      return { decision: 'observer_denied' as Decision, uid }
    }

    // D18: the build this account runs — whatever the decision below, because
    // a restricted account on an old build is exactly who the appeal-id cutoff
    // affects. Best-effort; see `recordAppBuild`.
    if (userSnap.exists) await recordAppBuild(uid, data?.appVersionCode)

    // ── 2. Is this DEVICE barred, whoever is holding it ──────────────────────
    //
    // Asked before anything about the account, because a banned device is
    // barred for every account — that is the whole point of a device ban. It
    // is what stops somebody signing out, making a second account and carrying
    // on from the same handset.
    /*
     * ── WHAT THIS CHECK IS, AND WHAT IT IS NOT ───────────────────────────
     *
     * `deviceId` is `Settings.Secure.ANDROID_ID`, sent by the client. It is
     * NOT attested. A patched build can send a different string, an empty one,
     * or somebody else's, and this branch believes it — so a device ban stops
     * an ordinary person reusing a barred handset and does not stop a
     * determined one.
     *
     * Three things limit the damage, and they are the reason this is still
     * worth having:
     *
     *   * The ACCOUNT ban below does not consult the device id at all, so
     *     forging one buys nothing for the banned account itself.
     *   * Every device an account is seen on is recorded server-side by
     *     `rememberDevice`, and `ban_user` bars all of them — so the handset
     *     is barred from whatever ids it has actually presented.
     *   * `barDevice` below bars the id in use the moment a banned account
     *     turns up on it, so a new id gets added to the list rather than
     *     escaping it.
     *
     * Closing the remaining gap — a NEW account on a barred handset presenting
     * a fresh id — needs hardware attestation (Play Integrity), which is a
     * dependency, a quota and a failure mode of its own. It is the right next
     * step and it is deliberately not smuggled into an auth change.
     */
    const deviceId = String(data?.deviceId ?? '').slice(0, 128)
    if (deviceId !== '') {
      // The same reading `startMobileSession` refuses on (C6) — see `barredDeviceReason`.
      const barred = await barredDeviceReason(deviceId)
      if (barred !== null) {
        return {
          decision: 'device_banned' as Decision,
          uid,
          reason: barred,
        }
      }
    }

    // ── 3. What state is the account in ──────────────────────────────────────
    const exists = userSnap.exists
    const state = exists ? String(userSnap.get('accountState') ?? STATE_ACTIVE) : STATE_ACTIVE
    const isDeleted = exists && (userSnap.get('isDeleted') === true)
    const dueAt = userSnap.get('deletionDueAt') as admin.firestore.Timestamp | null | undefined

    /*
     * BANNED — and the device this is happening on gets barred too.
     *
     * This is the propagation rule, and it is the half that was missing. The
     * client used to attempt it and ban `users/{uid}.deviceId` — the STORED
     * device, not the one in front of the person — so signing in from a new
     * phone re-banned the old one and left the new one clean. The write was
     * refused by the rules regardless and the failure was swallowed.
     *
     * Done here, with the Admin SDK, on the device actually being used.
     */
    /*
     * RF-27: ONE precedence for every reader — `restrictionVerdict`, the
     * backend's `restriction_of` order (`accountState` when it names a
     * moderation state, then `isSuspended`, then `isBanned`). This read the two
     * flags alone, so an account whose `accountState` said suspended or banned
     * without the flags walked straight in, a stale `isSuspended` beside a ban
     * showed the suspension screen (and never barred the handset), and a stale
     * `isBanned` beside a suspension barred the handset for a suspension.
     */
    const verdict = exists ? restrictionVerdict((field) => userSnap.get(field)) : ''
    const banned = verdict === 'banned'
    const suspended = verdict === 'suspended'

    if (banned) {
      if (deviceId !== '') await barDevice(deviceId, uid, userSnap)
      return {
        decision: 'banned' as Decision,
        uid,
        reason: String(userSnap.get('banReason') ?? 'Your account has been banned.'),
      }
    }

    /*
     * SUSPENDED — the account only. The device stays clean.
     *
     * That distinction is the entire difference between the two operations: a
     * suspended person may go back to the login screen and sign in with a
     * different, eligible account on the same phone. A banned one may not.
     */
    if (suspended) {
      const until = userSnap.get('suspendedUntil') as admin.firestore.Timestamp | null | undefined
      return {
        decision: 'suspended' as Decision,
        uid,
        reason: String(userSnap.get('banReason') ?? 'Your account has been suspended.'),
        suspendedUntilMs: until ? until.toMillis() : 0,
      }
    }

    let decision: Decision = 'allow'
    // RF-27: a deletion state without `isDeleted` (no current writer produces
    // one, but every other reader treats it as deleting) is deleting here too.
    const deleting = isDeleted ||
      verdict === 'deletion_requested' || verdict === STATE_RECOVERY_PENDING || verdict === STATE_PERMANENTLY_DEACTIVATED
    if (deleting) {
      /*
       * Recoverable, or permanently gone?
       *
       * Decided on the deadline rather than on the state string alone, because
       * the sweep that flips the state runs daily — so for up to a day an
       * account can be past its window and still say `recovery_pending`.
       * Offering recovery there would promise something `recoverAccount` then
       * refuses.
       */
      // `recoveryExpired` is the test `recoverAccount` refuses on (C8), so the
      // two cannot disagree about the boundary: due exactly now is past.
      const past = state === STATE_PERMANENTLY_DEACTIVATED || recoveryExpired(dueAt, Date.now())
      decision = past ? 'deleted_permanent' : 'deleted_recoverable'
    }

    // ── 3. The CRM role, and what it still owes us ───────────────────────────
    //
    // Email and phone are NOT universally mandatory. A person signing in with
    // Google to watch a stream is asked for neither; a host or a member of
    // staff is asked for whichever one their sign-in method could not supply,
    // because the business needs both to reach them and to pay them.
    const isHost = exists && userSnap.get('isHost') === true
    /*
     * C7 (B14): a partner owes us both contacts only while a capability is
     * APPROVED. This read the raw `crmUsers.role` (and the `isAgent`/`isSeller`
     * copies on the user document), so a pending, rejected or revoked Agency
     * or Seller was asked for a phone and an email it had no use for. It is
     * now `deriveRoleFlags` over the same document, exactly as `syncMyRoles`
     * reads it. Hosts and staff are unchanged: staff is any CRM role that is
     * not a partner capability, whatever that capability's status.
     */
    const partner = deriveRoleFlags(
      crmSnap.get('role'),
      crmSnap.get('roles'),
      crmSnap.get('isActive') !== false,
      crmSnap.exists,
      crmSnap.get('roleStatus'),
      crmSnap.get('status'),
    )
    const isPartner = partner.isAgent || partner.isSeller
    const isStaff = crmRole !== '' && !PARTNER_ROLES.has(crmRole)

    const needsBoth = isHost || isPartner || isStaff

    const hasPhone = tokenPhone !== '' ||
      (exists && phoneKey(userSnap.get('phoneNumber') ?? userSnap.get('phone')) !== '')
    // P0-5 (AUTHN-2): the token's address counts once it is confirmed.
    const hasEmail = (tokenEmail !== '' && tokenEmailVerified(token)) ||
      (exists && emailKey(userSnap.get('email')) !== '')

    return {
      decision,
      uid,
      exists,
      accountState: state,
      isProfileComplete: exists && userSnap.get('isProfileComplete') === true,
      displayName: exists ? String(userSnap.get('name') ?? '') : String(token['name'] ?? ''),
      photoUrl: exists ? String(userSnap.get('photoUrl') ?? '') : String(token['picture'] ?? ''),

      // Role, carried back so the app can show the badge and so profile setup
      // knows which rules apply. The exact existing role string — `ops_admin`,
      // `finance_member`, `agency` — never a flattened one.
      crmRole,
      isHost,

      /**
       * Still a guest: an anonymous account with nothing attached to it.
       *
       * The client cannot work this out for itself. `FirebaseUser.isAnonymous`
       * reads false after a quick sign-in, because that path redeems a custom
       * token — so the app hid "add your phone number" from exactly the
       * returning guests who most needed it, leaving them no way to keep an
       * account they may have been building for weeks. See `isGuestAccount`.
       */
      isGuest: await isGuestAccount(uid, token),

      /** Ask for these, and only these. Empty for an ordinary user. */
      requiresPhone: needsBoth && !hasPhone,
      requiresEmail: needsBoth && !hasEmail,

      deletionDueAtMs: dueAt ? dueAt.toMillis() : 0,
    }
  })

/** One place to log a refused observer, so the two call sites cannot diverge. */
function logger_warnObserver(uid: string, email: string): void {
  functions.logger.warn(
    'Refused the observer account on a mobile sign-in. It is CRM-only.',
    { uid, email },
  )
}

// ── The one active mobile device ─────────────────────────────────────────────

/**
 * Claim this device as the account's active mobile session.
 *
 * ── WHY THE SERVER MINTS IT ──────────────────────────────────────────────────
 *
 * The old rule was a random string the CLIENT generated and wrote to
 * `users/{uid}.sessionToken`, which the other device compared against a copy in
 * its own storage. Two problems. A patched client could simply not write it, and
 * keep two devices alive for ever. And a single opaque string could not say
 * WHICH device held the session — so "you were signed out" had no "…because your
 * account was opened on a Motorola" to go with it, and support had nothing to
 * look at.
 *
 * The session is a record now, minted here, and the field is server-only in the
 * rules. The previous device loses within a second because it is watching the
 * same document.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT TOUCH ────────────────────────────────────
 *
 * The CRM. A person can hold the CRM in a browser and the app on a phone at the
 * same time, and changing phones must not sign them out of the website they are
 * working in. Nothing in the CRM reads or writes this field — its session lives
 * in its own token, in `backend/app/core/security.py`, on a different clock.
 */
export const startMobileSession = functions
  .region('asia-south1')
  .https.onCall(async (data: { deviceId?: string; platform?: string; deviceName?: string }, context) => {
    const uid = requireAuth(context)

    /*
     * ── B3 (spec §8): THE OBSERVER NEVER HOLDS A MOBILE SESSION ─────────────
     *
     * `resolveIdentity` refuses the observer, but a client that skips the
     * gate — a modified build, or an old one — could come straight here and
     * hold the account's one mobile session on a device, with the backend
     * (`/api/auth/signin`) refusing it separately. The same reading as
     * `resolveIdentity`'s first check, before anything is read or written:
     * the address on the token. A phone sign-in carries no email and the
     * observer has no phone on any account, so the token is the whole test.
     */
    const observerEmail = emailKey((context.auth?.token as Record<string, unknown> | undefined)?.['email'])
    if (observerEmail !== '' && isObserverEmail(observerEmail)) {
      logger_warnObserver(uid, observerEmail)
      throw new functions.https.HttpsError(
        'permission-denied',
        'The Observer account is CRM-only and cannot sign in on a phone.',
        { code: OBSERVER_DENIED, reason: 'observer' },
      )
    }

    const sessionId = crypto.randomBytes(16).toString('base64url')
    const deviceId = String(data?.deviceId ?? '').slice(0, 128)
    const platform = String(data?.platform ?? 'android').slice(0, 32)
    const deviceName = String(data?.deviceName ?? '').slice(0, 64)

    /*
     * ── C6 (B31): NO SESSION ON AN UNNAMED OR A BARRED DEVICE ────────────────
     *
     * A device ban was advisory: `resolveIdentity` skips the check for an
     * empty id, and nothing here checked at all — so a client that skipped the
     * gate, or sent no id, held the account's one session on a barred handset.
     * Both are refused here, from the same `bannedDevices` record
     * `resolveIdentity` reads, before the device is recorded or the session
     * and cut-off are written.
     */
    if (deviceId.trim() === '') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This device could not be identified, so a session cannot be started on it.',
        { code: DEVICE_BARRED, reason: 'missing_device_id' },
      )
    }
    const barred = await barredDeviceReason(deviceId)
    if (barred !== null) {
      throw new functions.https.HttpsError('failed-precondition', barred, { code: DEVICE_BARRED, reason: 'barred' })
    }

    // Every device this account has been seen on, so a ban can bar all of them.
    await rememberDevice(uid, deviceId, platform, deviceName)

    /*
     * ── THE REPLACEMENT IS ATOMIC, AND IT IS NOW A CONTROL ───────────────────
     *
     * Read and write in one transaction. Two phones signing in within the same
     * moment used to race: both read the previous session, both wrote, and the
     * loser's id survived on the document while the winner believed it held the
     * session. The last commit now wins deterministically, and the one it
     * replaced is reported back so the displaced device can name it.
     *
     * `credentialsValidAfter` is what makes displacement enforceable against
     * the direct Firestore writes the app makes without a callable. The rules
     * compare it with `request.auth.token.auth_time`: a token minted by an
     * earlier sign-in carries an earlier `auth_time` and is refused; this
     * device's is equal or later and is not. See `firestore.rules::sessionCurrent`
     * and `functions/src/mobileSession.ts` for why Firebase token revocation
     * cannot be used here.
     *
     * ── IT IS A NUMBER, NOT A TIMESTAMP, AND THAT IS NOT A STYLE CHOICE ─────
     *
     * `request.auth.token.auth_time` in a security rule is an INTEGER: seconds
     * since the Unix epoch. Comparing it against a Firestore `Timestamp` is a
     * type mismatch, and a rule whose comparison raises denies the write — so
     * storing this as a `Timestamp` would have locked out every account that
     * signed in, which is the opposite of the intent and would have looked like
     * a Firestore outage.
     *
     * ── IT IS THE CALLER'S OWN auth_time, NOT "NOW MINUS SLACK" ─────────────
     *
     * The first version stamped `now - 5s`, because `auth_time` is set when
     * Firebase minted the credential and that is a moment or two before this
     * function runs — without slack a device would race its own stamp and be
     * refused its first write.
     *
     * But slack is a window, and the window was the bug: for five seconds after
     * Phone B signed in, Phone A's older token still satisfied `auth_time >=
     * validAfter` and kept writing. Two sign-ins a second apart is not an
     * contrived case; it is what a person switching phones actually does.
     *
     * The caller's own `auth_time` is the exact right value and is on the token
     * in front of us. Phone B's token satisfies `>=` by equality; every token
     * minted earlier — including Phone A's — falls below it. No window.
     *
     * RESIDUAL LIMIT, stated rather than hidden: `auth_time` has ONE-SECOND
     * granularity. Two devices that authenticate inside the same clock second
     * are indistinguishable at this layer, and the displaced one would pass this
     * particular gate. The mobile-session check in `mobileSession.ts` has no such
     * resolution limit and is what covers that case for every callable.
     */
    const ref = db.collection('users').doc(uid)
    const now = admin.firestore.Timestamp.now()
    const callerAuthTime = Number(
      (context.auth?.token as Record<string, unknown> | undefined)?.auth_time ?? 0,
    )
    const previous = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const prior = snap.get('activeMobileSession') as Record<string, unknown> | undefined

      // Phase 1A (SESSION-002/003): never LOWER the cut-off, and never start a
      // session for a restricted account. See `nextValidAfter`.
      const restricted = restrictionVerdict((f) => snap.get(f))
      if (restricted === 'banned' || restricted === 'suspended') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This account is restricted and cannot sign in right now.',
          { code: ACCOUNT_RESTRICTED, state: restricted },
        )
      }
      const next = nextValidAfter(
        snap.get('credentialsValidAfter'), callerAuthTime, Math.floor(now.toMillis() / 1000),
      )
      if (!next.ok) {
        throw new functions.https.HttpsError(
          'permission-denied',
          DISPLACED_MESSAGE,
          { code: SESSION_DISPLACED },
        )
      }
      const stamped = next.value

      tx.set(
        ref,
        {
          activeMobileSession: {
            sessionId,
            deviceId,
            platform,
            deviceName,
            createdAt: now,
            lastActiveAt: now,
          },
          credentialsValidAfter: stamped,
          sessionToken: sessionId,
        },
        { merge: true },
      )
      return prior
    })

    /*
     * ── THE DISPLACED DEVICE LOSES ITS WAY BACK ──────────────────────────────
     *
     * Declining to MINT a credential on the displaced handset is not enough: it
     * may already hold one from an earlier ordinary sign-out, and redeeming that
     * would walk straight back into the account it was just removed from. One
     * active device would then mean "one at a time, and whoever taps last wins",
     * which is not the rule.
     *
     * So the previous holder's credentials are revoked here, by the device that
     * displaced it. Scoped to that `deviceId`: this handset's own credential,
     * and any other device's, are untouched.
     *
     * Best-effort. A failure costs the revocation, not the sign-in that is in
     * progress — and the credential it missed is still bounded by its own TTL
     * and by every account-state gate at redemption.
     */
    const priorDevice = String(previous?.deviceId ?? '')
    if (priorDevice && priorDevice !== deviceId) {
      try {
        const stale = await db
          .collection('quickLoginTokens')
          .where('uid', '==', uid)
          .where('deviceId', '==', priorDevice)
          .limit(20)
          .get()
        await Promise.all(stale.docs.map((d) => d.ref.delete().catch(() => undefined)))
        if (stale.size > 0) {
          functions.logger.info('quick-login revoked on displacement', {
            uid,
            revoked: stale.size,
          })
        }
      } catch (err) {
        functions.logger.warn('could not revoke the displaced device\'s quick login', {
          uid,
          err: String(err),
        })
      }
    }

    if (previous?.sessionId && previous.sessionId !== sessionId) {
      functions.logger.info('mobile session displaced', {
        uid,
        replacedDevice: String(previous?.deviceName ?? ''),
      })
    }

    return {
      sessionId,
      /** What the device being kicked should say it was replaced by. */
      replacedDeviceName: String(previous?.deviceName ?? ''),
    }
  })


/**
 * Give up this device's claim, on an ordinary sign-out.
 *
 * Only if it is still OURS: a device that was kicked an hour ago and is only
 * now getting round to signing out must not clear the session belonging to the
 * phone that replaced it.
 */
export const endMobileSession = functions
  .region('asia-south1')
  .https.onCall(async (data: { sessionId?: string }, context) => {
    const uid = requireAuth(context)
    const sessionId = String(data?.sessionId ?? '')
    if (!sessionId) return { ended: false }

    const ref = db.collection('users').doc(uid)
    const current = (await ref.get()).get('activeMobileSession') as Record<string, unknown> | undefined
    if (String(current?.sessionId ?? '') !== sessionId) return { ended: false, notOurs: true }

    await ref.set(
      {
        activeMobileSession: admin.firestore.FieldValue.delete(),
        sessionToken: '',
      },
      { merge: true },
    )
    return { ended: true }
  })

/** `HttpsError.details.code` when a session is refused for the device (C6). */
export const DEVICE_BARRED = 'DEVICE_BARRED'

/**
 * `HttpsError.details.code` when a mobile session is refused because the token
 * names the observer (B3, spec §8). The same word the backend answers on
 * `/api/auth/signin` (`detail.code === 'observer_denied'`) and `resolveIdentity`
 * returns as its decision, so one client branch covers all three.
 */
export const OBSERVER_DENIED = 'OBSERVER_DENIED'

/**
 * Is this device barred? The reason to show, or null when it is not.
 *
 * The ONE reading of `bannedDevices`, shared by `resolveIdentity` and
 * `startMobileSession` so the two cannot disagree: a record that exists and
 * has not been switched off (`isActive: false`) bars the device.
 */
async function barredDeviceReason(deviceId: string): Promise<string | null> {
  const devSnap = await db.collection('bannedDevices').doc(deviceId).get()
  if (devSnap.exists && devSnap.get('isActive') !== false) {
    return String(devSnap.get('reason') ?? 'This device has been barred.')
  }
  return null
}

/**
 * Bar a device because the account using it is banned.
 *
 * ── WHY THE SOURCE IS RECORDED ───────────────────────────────────────────────
 *
 * `sourceAccounts` is what makes an unban surgical. Without it a device ban is
 * just `banned: true`, and lifting a ban has only two options — leave every
 * device barred for ever, or delete the record and release a handset that Ops
 * barred separately for reasons of their own. The old `unban_user` took the
 * second option, unconditionally.
 *
 * With the source list, unbanning account A removes A from every device it put
 * itself on, and the record only disappears when nothing is holding it up any
 * more. An independent Ops ban has `manualBan: true` and survives regardless.
 *
 * Idempotent and merge-only: a device barred by three different accounts
 * accumulates three entries rather than the last one overwriting the others.
 */
async function barDevice(
  deviceId: string,
  sourceUid: string,
  userSnap: admin.firestore.DocumentSnapshot,
): Promise<void> {
  try {
    await db.collection('bannedDevices').doc(deviceId).set(
      {
        deviceId,
        deviceType: 'android_id',
        isActive: true,
        reason: String(userSnap.get('banReason') ?? 'Device of a banned account.'),
        // Why this record exists. One entry per account that caused it.
        sourceAccounts: admin.firestore.FieldValue.arrayUnion(sourceUid),
        // Kept in step with the legacy field the CRM's ban list renders.
        userUids: admin.firestore.FieldValue.arrayUnion(sourceUid),
        bannedAt: admin.firestore.FieldValue.serverTimestamp(),
        bannedByName: 'Automatic',
        bannedByRole: 'system',
        lastSeenUid: sourceUid,
      },
      { merge: true },
    )
    functions.logger.info('device barred by ban propagation', { deviceId, sourceUid })
  } catch (err) {
    // A failed device bar must not turn into a successful sign-in. The caller
    // refuses on the ACCOUNT ban regardless; this only widens the net.
    functions.logger.error('could not bar device', { deviceId, sourceUid, err })
  }
}

/**
 * Record that this account has been seen on this device.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 *
 * `users/{uid}.deviceId`, a single value written ONCE at profile setup and
 * never refreshed. So "ban the device this account uses" banned the handset
 * they signed up on, possibly years ago and possibly sold since — while the
 * phone they are actually using stayed clean. And the field was client-
 * writable, so anyone expecting a ban could point it somewhere harmless.
 *
 * A subcollection instead: every device, server-written, with a timestamp. A
 * ban can then bar all of them, which is what the propagation rule asks for.
 */
async function rememberDevice(
  uid: string,
  deviceId: string,
  platform: string,
  deviceName: string,
): Promise<void> {
  if (deviceId === '') return
  try {
    await db.collection('users').doc(uid).collection('devices').doc(deviceId).set(
      {
        deviceId,
        platform,
        deviceName,
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      // `firstSeenAt` is only right on a create, so merge and let the first
      // write win. An update rewrites it, which is wrong but harmless — it is
      // a diagnostic, not a decision input.
      { merge: true },
    )

    /*
     * The legacy top-level field, kept in step from the server.
     *
     * `_devices_of` in backend/app/services/users.py reads the subcollection
     * above and falls back to `users/{uid}.deviceId` for accounts that predate
     * it — so a ban cascade still needs the field populated.
     *
     * The CLIENT used to write it, from profile setup. That stopped working
     * the day it went onto `ownerProtectedFields()` (a user who can write it
     * can aim their own ban cascade at a handset that does not exist), and
     * because the rule fails the whole update on any one forbidden key, it
     * took the entire profile save down with it. Writing it here keeps the
     * fallback fed without handing the field back to the person it is meant to
     * constrain.
     */
    await db.collection('users').doc(uid).set({ deviceId }, { merge: true })
  } catch (err) {
    functions.logger.warn('could not record device', { uid, deviceId, err })
  }
}
