import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
import { getHostLadder, hostLevelFor } from './hostStats'
// The two eligibility rules live in a file that imports nothing, so they can
// be required from a test without an initialised Firebase app. See the header
// of ./hostEligibility.
import {
  heldByAnotherAgency, restrictionOn, decisionRefusal, agencyCodeRefusal, guestRefusal, AGENCY_NOT_ACCEPTING,
  hostRoleRevoked, hostOfSameAgency, activeHostRefusal, HOST_REVOKED_REFUSAL, ROLE_REVOKED,
  hostRoleSuspension, hostSuspendedMessage, hostSuspensionDetails, refusalDetails,
  HOST_ROLE_SUSPENDED,
} from './hostEligibility'
import { digitsOf, hasCountryCode, sameNumber, sameNumberStrict } from './phone'
import { hostBlockedFor } from './crmRoles'
import { assertActiveSession } from './mobileSession'
import { CONTACT_VERIFICATION_REQUIRED, contactProofFor } from './contactProof'
import { ROSTER_ACTIVE, ROSTER_REMOVED_AT, ROSTER_REMOVED_REASON } from './roster'
import { clientIpOf, enforceRateLimit } from './rateLimit'
import { recordEvent } from './quickLogin'

const db = admin.firestore()

/**
 * Security review of the QA fixes (3 Nov 2026): one budget for the two calls
 * that look an invitation up by code — see `hostInvitationLookup` in
 * rateLimit.ts. Keyed by the signed-in account and the client address.
 */
async function limitInvitationLookups(uid: string, rawRequest: unknown): Promise<void> {
  await enforceRateLimit('hostInvitationLookup', {
    deviceId: `uid:${uid}`,
    ip: clientIpOf(rawRequest as Parameters<typeof clientIpOf>[0]),
  })
}


/**
 * Becoming a host, and proving you are who the agency said you are.
 *
 * ── Why this is server-side ──────────────────────────────────────────────────
 *
 * `AuthRepository.activateHostApplication` wrote `isHost: true`, `agencyId` and
 * `callRateBeans` straight onto the user document from the phone. Those three
 * fields decide whether an account earns beans, which agency is paid commission
 * on them, and what every minute of that account's time costs. Any one of them
 * being client-writable makes the other two irrelevant: an account could simply
 * declare itself a host of any agency at any rate.
 *
 * ── Why verification gates payouts ───────────────────────────────────────────
 *
 * `releaseBeansForWeek` refuses to release a week for a host whose
 * `isVerifiedHost` is not true. Nothing in the product set that flag, so as
 * written, every payout would have been skipped forever and every host would
 * have accrued beans they could never withdraw. This module is what sets it.
 */

// ── The face comparator ──────────────────────────────────────────────────────

/**
 * Result of comparing the host's live capture against the agency's photograph.
 *
 * `null` means "no opinion" — no provider is configured, or it errored. That
 * routes to human review, which is the only safe default: an unavailable
 * comparator must never auto-pass, and must never auto-reject someone who is
 * genuinely themselves.
 */
interface FaceMatch {
  score: number       // 0..1 similarity
  threshold: number   // the threshold in force when it ran
  provider: string
}

/**
 * On-device scoring was the chosen direction ("on-device embedding model for
 * now, later we scale with AWS"). It is the right call for cost and for privacy
 * — the face never leaves the phone — but it cannot be the thing that grants
 * the badge.
 *
 * A similarity score computed on the handset and posted to this function is a
 * number the handset chose. `{"score": 0.99}` is two lines of work for anyone
 * who wants a verified badge, and a verified badge is what releases money. So
 * the on-device model is used for what it is good at — telling the host
 * immediately whether their capture is usable, before they submit — and this
 * function ignores any score the client sends.
 *
 * Until a server-side provider is configured, every submission goes to manual
 * review in the CRM. That is the flow that was agreed anyway for AI failures;
 * this just means it is the flow for everything until AWS Rekognition is wired
 * up. Set `FACE_MATCH_PROVIDER` to switch it on.
 */
async function compareFaces(
  _agencyPhotoUrl: string,
  _captureUrl: string,
): Promise<FaceMatch | null> {
  const provider = process.env.FACE_MATCH_PROVIDER
  if (!provider) return null

  // AWS Rekognition CompareFaces goes here. Deliberately not stubbed with a
  // fake score: a placeholder that returns 0.95 would verify every host on the
  // platform the moment someone set the env var to try it out.
  functions.logger.warn(
    `FACE_MATCH_PROVIDER=${provider} is set but no comparator is implemented — routing to manual review.`,
  )
  return null
}

// ── activateHost ─────────────────────────────────────────────────────────────

interface ActivateRequest {
  referralCode: string
  /** Collected in the setup form when Auth does not already have it. */
  phone?: string
  email?: string
}

/**
 * Record that this host belongs to this agency.
 *
 * `agencies/{agencyId}/agencyHosts/{hostUid}` is the only statement anywhere
 * that an agency has a roster. Nothing wrote it. `activateHost` set
 * `users/{uid}.agencyId` and stopped there, so every reader of the roster saw
 * an agency with no hosts:
 *
 *   * the weekly payout report (`index.ts`) iterates this subcollection to work
 *     out what each agency's hosts earned. An empty roster means a report of
 *     zero for an agency whose hosts were earning all week.
 *   * `AgencyDashboardScreen.kt` and `zipper-crm/lib/agencies.ts` list it as
 *     "my hosts", which was permanently empty.
 *
 * THE SHAPE IS TAKEN FROM THE READERS, NOT INVENTED.
 *   The document id is the host's uid, because `firestore.rules` matches
 *   `/agencyHosts/{hostUid}` and the Android screen falls back to `doc.id`.
 *   `uid` and `name` are the two fields the readers actually pull —
 *   `index.ts` reads `host.uid ?? doc.id` and `host.name ?? host.displayName`.
 *   The rest is provenance: which agency, which application, what rate was
 *   agreed and when they joined, so a roster row can be traced back to the
 *   application it came from without a second query.
 *
 * `merge: true` and no read beforehand, so re-running activation for the same
 * host repairs the row rather than duplicating or clearing it. That repair path
 * is why `joinedAt` is only stamped on a genuine activation: every host
 * activated before this existed has no roster row, and re-entering their code
 * is the one thing that will write one — it should not then claim they joined
 * the agency today.
 *
 * Written inside the caller's transaction, with the user document and the
 * application, because a roster that disagrees with `users/{uid}.agencyId` is
 * the same bug in a different place: one of the two would be paying commission
 * to an agency the other says the host does not belong to.
 */
function writeAgencyMembership(
  tx: admin.firestore.Transaction,
  agencyId: string,
  uid: string,
  fields: {
    name: string
    /**
     * Omitted when the row is repaired from a DUPLICATE invitation (B09): the
     * row keeps naming the application the host actually joined on.
     */
    applicationId?: string
    callRateBeans?: number
    /** False when this is repairing a row for a host activated earlier. */
    joining: boolean
  },
) {
  // A blank agency id is not a path. It happens when an application was created
  // without one, and the honest outcome is a host with no agency rather than a
  // write to `agencies//agencyHosts`, which throws and would take the whole
  // activation down with it.
  if (!agencyId) return

  const doc: Record<string, any> = {
    uid,
    name: fields.name,
    agencyId,
    // FX-10 (RF-15): a membership written here is CURRENT. `revoke_host` and
    // the account purge mark a row `active: false` (with when and why) rather
    // than leaving it to be counted; an activation — or the re-entry repair
    // below, which a revoked Host never reaches — makes it current again.
    [ROSTER_ACTIVE]: true,
    [ROSTER_REMOVED_AT]: admin.firestore.FieldValue.delete(),
    [ROSTER_REMOVED_REASON]: admin.firestore.FieldValue.delete(),
  }
  if (fields.applicationId) doc.applicationId = fields.applicationId
  if (fields.joining) doc.joinedAt = admin.firestore.FieldValue.serverTimestamp()
  if (fields.callRateBeans !== undefined) doc.callRateBeans = fields.callRateBeans

  tx.set(
    db.collection('agencies').doc(agencyId).collection('agencyHosts').doc(uid),
    doc,
    { merge: true },
  )
}

// ── FX-12: superseding the person's other open applications ────────────────

/** The text the backend writes on one (`users.SUPERSEDED_REASON`), kept in step. */
export const SUPERSEDED_REASON =
  'Closed: this person became a Host through another application ({by}), so this ' +
  'one was not decided on its merits. Nothing else changed.'

/**
 * Which of a person's own applications an activation closes: every OTHER one
 * still pending and never redeemed. Pure — `fxHostSupersede.test.js` runs it.
 */
export function supersededApplications(
  own: { id: string; data: Record<string, unknown> }[],
  keepId: string,
): string[] {
  return own
    .filter((a) => a.id !== keepId)
    // Decision 15 (RC): an application the Owner approved that is still
    // WAITING for verified contacts is open too — once the person is a Host
    // through this redemption it can never start, so it is closed with the rest.
    .filter((a) => ['pending', 'awaiting_verification'].includes(String(a.data.status ?? 'pending'))
      && a.data.isActivated !== true)
    .map((a) => a.id)
}

/** The stamp on a superseded application: a refusal in both status fields, saying why. */
export function supersededStamp(byId: string, now: unknown): Record<string, unknown> {
  const note = SUPERSEDED_REASON.replace('{by}', byId)
  return {
    status: 'rejected',
    kycStatus: 'rejected',
    rejectionReason: note,
    decisionReason: note,
    decidedAt: now,
    decidedBy: 'activateHost',
    decidedByUid: '',
    decidedByRole: 'system',
    supersededBy: byId,
    supersededAt: now,
    updatedAt: now,
  }
}

export const activateHost = functions
  .region('asia-south1')
  .https.onCall(async (data: ActivateRequest, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const code = String(data?.referralCode ?? '').trim().toUpperCase()
    if (!code) throw new functions.https.HttpsError('invalid-argument', 'A referral code is required.')

    // Phase 1A (AUTH-002): a guest is refused before anything is looked up.
    const guest = guestRefusal(context.auth?.token)
    if (guest) throw new functions.https.HttpsError('permission-denied', guest)
    // Phase 1A (SESSION-001/003): a protected operation.
    await assertActiveSession(uid, data, 'activateHost', context.auth?.token)
    // Before any invitation is read (security review, 3 Nov 2026).
    await limitInvitationLookups(uid, context.rawRequest)

    // Token first, then what was saved at profile setup, then the form. See
    // `identityFor` — the stored half is what lets somebody redeem a code with
    // nothing but the code, today or in a month.
    const { phone, email } = await identityFor(uid, context.auth?.token, data)

    // Chosen, not taken. See `applicationsFor` — a referral code belongs to an
    // agency, so several applications share it, and `docs[0]` was redeeming
    // whichever one the index happened to return.
    const { anyForCode, mine, claimedByOther } = await applicationsFor(code, { phone, email }, uid)
    if (!anyForCode) {
      throw new functions.https.HttpsError('not-found', 'That referral code does not exist.')
    }
    if (mine.length === 0) {
      // QA #51: another account claimed the invitation for these contacts.
      if (claimedByOther) {
        throw new functions.https.HttpsError('failed-precondition', 'That referral code has already been used.')
      }
      throw new functions.https.HttpsError(
        'permission-denied',
        'This code was issued to a different phone number or email address.',
      )
    }

    const appRef = mine[0].ref
    const userRef = db.collection('users').doc(uid)
    const verRef = db.collection('hostVerification').doc(uid)

    // Decision 15 (RC): read once, before the transaction, and enforced only
    // where a redemption STARTS the Host role (below). `identityFor` already
    // insists on a verified phone and email to match the invitation; this is
    // the stricter question the backend asks as well — an address Firebase
    // marked verified on a password account (a reset link) is not proof
    // without our own code. See contactProof.ts.
    const proof = await contactProofFor(uid)

    // Security review of the QA fixes (3 Nov 2026): a QA #51 claim makes the
    // invitation this account's without starting anything, so no other record
    // of it exists until the role starts. It is recorded once the transaction
    // has committed (`authEvents`, closed to clients — see `recordEvent`). The
    // callback RETURNS that it claimed (`claimedNow`, taken off the answer
    // below) — it changes nothing outside itself (transactionPurity.test.js).
    const outcome = await db.runTransaction(async (tx) => {
      const [appSnap, userSnap, crmSnap] = await Promise.all([
        tx.get(appRef), tx.get(userRef), tx.get(db.collection('crmUsers').doc(uid)),
      ])
      if (!appSnap.exists) throw new functions.https.HttpsError('not-found', 'That referral code does not exist.')
      if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Finish setting up your profile first.')

      const app = appSnap.data() as Record<string, any>
      const agencyId = String(app.agencyId ?? '').trim()

      // The role table, on the one path that grants Host without the backend.
      // RC (confirmed role rule): a Sub-agency of main Agency X may also be a
      // Host directly under X — so the login's own Sub-agency (its main
      // agency) and the inviting agency (main or not) are read to decide.
      const crm = crmSnap.exists ? (crmSnap.data() as Record<string, unknown>) : null
      const ownAgencyId = String(crm?.agencyId ?? '').trim()
      const [ownAgencySnap, invitingSnap] = await Promise.all([
        ownAgencyId ? tx.get(db.collection('agencies').doc(ownAgencyId)) : Promise.resolve(null),
        agencyId ? tx.get(db.collection('agencies').doc(agencyId)) : Promise.resolve(null),
      ])
      const own = ownAgencySnap && ownAgencySnap.exists ? (ownAgencySnap.data() as Record<string, unknown>) : null
      const ownIsSub = String(own?.type ?? '').trim().toLowerCase() === 'sub'
      const inviting = invitingSnap && invitingSnap.exists ? (invitingSnap.data() as Record<string, unknown>) : null
      const invitingIsMain = !!inviting && String(inviting.type ?? 'main').trim().toLowerCase() !== 'sub'
        && !String(inviting.parentAgencyId ?? '').trim()
      const blocked = hostBlockedFor(crm, {
        subParentId: ownIsSub ? String(own?.parentAgencyId ?? '').trim() : '',
        invitationAgencyId: agencyId,
        invitationAgencyIsMain: invitingIsMain,
      })
      if (blocked) throw new functions.https.HttpsError('failed-precondition', blocked)
      const hostName = String(app.hostName ?? userSnap.get('name') ?? '').trim()

      /*
       * ── A RESTRICTED ACCOUNT DOES NOT BECOME A HOST ────────────────────────
       *
       * Checked here and not only at sign-in, because this is reachable long
       * after sign-in: an existing user can redeem a code from their profile at
       * any time, and a ban applied in between would otherwise be stepped
       * around by a screen that was opened before it.
       *
       * Refused outright rather than queued. Granting host status to a banned
       * account would put them on an agency roster and into a weekly payout
       * report, and the money half is far harder to unwind than a refusal.
       */
      const restriction = restrictionOn(userSnap)
      if (restriction) {
        throw new functions.https.HttpsError('permission-denied', restriction)
      }

      /*
       * ── A REVOKED HOST IS NOT A NEW APPLICANT (C1, B04) ────────────────────
       *
       * `hostRevokedAt` used to be ignored here, so a Host removed by staff
       * became a Host again by redeeming any invitation — including their own
       * old one, whose re-entry path below rewrites the roster row. Refused
       * before both: the way back is a reinstatement request, decided by an
       * Owner, not a referral code.
       */
      if (hostRoleRevoked(userSnap)) {
        throw new functions.https.HttpsError('failed-precondition', HOST_REVOKED_REFUSAL, { code: ROLE_REVOKED })
      }

      /*
       * ── A SUSPENDED HOST ROLE IS NOT REDEEMED AROUND (§5) ──────────────────
       *
       * The suspension keeps the role, the record and the agency link; it comes
       * back through Resume (or the end of its term), on the same record. A
       * code — even this host's own agency's, whose re-entry path rewrites the
       * roster row — is not a way round it, and neither is another agency's.
       */
      const suspended = hostRoleSuspension(userSnap)
      if (suspended) {
        throw new functions.https.HttpsError(
          'failed-precondition', hostSuspendedMessage(suspended), hostSuspensionDetails(suspended),
        )
      }

      /*
       * ── ONE HOST, ONE AGENCY ───────────────────────────────────────────────
       *
       * Without this, a host already attached to agency A who redeems a code
       * from agency B is silently moved: `agencyId` is overwritten, the agreed
       * rate is replaced, and a roster row appears under B while the one under
       * A stays behind. Both agencies then show the same host, and commission —
       * which is stamped from the agency recorded at the moment of payment —
       * follows whichever write landed last.
       *
       * Refused, and named, so the person can see it is not a typo on their
       * part. Moving between agencies is a staff operation with a revoke and a
       * re-grant, not something a referral code does on its own.
       */
      if (heldByAnotherAgency(userSnap, agencyId)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'You are already a host with another agency. To move, ask your ' +
          'current agency to release you first.',
        )
      }

      // Both must match. The code alone is a six-character string that can be
      // guessed or shared; tying it to the contact details the agency
      // registered is what makes it a claim about a person.
      //
      // The phone goes through `samePhone`, exactly as the candidate search
      // did — the two must ask the same question or a code goes green in the
      // form and is refused on submit, which is indistinguishable from the app
      // doing nothing at all.
      //
      // Computed here and refused further down, after the decision and the
      // agency, as before — B09 below needs the answer earlier.
      const appEmail = String(app.applicantEmail ?? '').trim().toLowerCase()
      const phoneOk = samePhone(app.applicantPhone, phone)
      const emailOk = appEmail !== '' && email !== '' && appEmail === email

      if (app.isActivated === true) {
        // Re-running it for the same account is harmless; for a different one
        // it is someone else's code.
        if (app.activatedByUid === uid) {
          // Harmless, and now useful: hosts activated before the roster was
          // written have no `agencyHosts` row, and their agency's weekly report
          // counts them as nothing. Re-entering the code repairs it.
          writeAgencyMembership(tx, agencyId, uid, {
            name: hostName,
            applicationId: appRef.id,
            joining: false,
          })
          return { alreadyActivated: true, agencyId }
        }
        throw new functions.https.HttpsError('failed-precondition', 'That referral code has already been used.')
      }

      /*
       * ── QA #51: CLAIMED, WAITING FOR THE OTHER CONTACT ─────────────────────
       *
       * Re-entering the code after an earlier claim. The invitation is this
       * account's and starts through the backend once both contacts are
       * verified (`checkPartnerActivation`); activating it here as well could
       * grant the role twice, so this only reports where it stands. Another
       * account's claim is a spent code.
       */
      if (app.status === AWAITING_VERIFICATION) {
        if (String(app.applicantUid ?? '').trim() !== uid) {
          throw new functions.https.HttpsError('failed-precondition', 'That referral code has already been used.')
        }
        return {
          alreadyActivated: false,
          awaitingVerification: true,
          agencyId,
          missing: proof.missing,
          contactHint: contactHintFor(app, proof.missing),
        }
      }

      /*
       * ── B09: ALREADY A HOST OF THIS AGENCY ─────────────────────────────────
       *
       * An agency that invites one of its own Hosts again — a re-invite after a
       * typo, a second Invite Host from another staff member — leaves a second
       * invitation under the same code, and `candidateRank` puts an unredeemed
       * one AHEAD of the invitation this person already redeemed. Redeeming it
       * ran the full activation below: `isVerifiedHost` back to false, the
       * agreed rate replaced, the verification record reopened at
       * pending_capture — a verified, payable Host reset to unverified by
       * typing their own code.
       *
       * It is a duplicate, not an activation. A server-approved duplicate is
       * marked used and linked to this Host, so the CRM shows one person and
       * not a second "Awaiting Activation" row; a rejected or undecided one is
       * left exactly as it is. The user document (badge, rate, agency), the
       * verification record and the roster's join date and rate are not
       * touched — the roster row is only repaired, as on any re-entry.
       */
      if (hostOfSameAgency(userSnap, agencyId)) {
        if (!phoneOk || !emailOk) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'This code was issued to a different phone number or email address.',
          )
        }
        if (decisionRefusal(app) === '') {
          tx.update(appRef, {
            isActivated: true,
            activatedByUid: uid,
            activatedAt: admin.firestore.FieldValue.serverTimestamp(),
            linkedToExistingHost: true,
          })
        }
        writeAgencyMembership(tx, agencyId, uid, { name: hostName, joining: false })
        return { alreadyActivated: true, agencyId }
      }

      /*
       * APPROVED, not merely "not rejected".
       *
       * This used to refuse only a rejected application, so a code worked from
       * the moment the agency created the invitation — an applicant became a
       * host, linked to an agency and earning at an agreed rate, before anybody
       * had opened their Aadhaar card. The reviewer's approval arrived after
       * the fact and could only ratify it.
       *
       * The decision now comes first (`decide_host_application` marks the
       * application without needing an account) and this is what enforces it.
       */
      // Phase 1A (SECURITY-002): the SERVER's decision stamp, not a status
      // string a client could have written. See `decisionRefusal`.
      const undecided = decisionRefusal(app)
      if (undecided) throw new functions.https.HttpsError('failed-precondition', undecided)

      // Phase 1A (SECURITY-002): the code must be the named agency's real code,
      // and that agency must be live — a forged code or a re-pointed agencyId
      // on the application is refused here.
      const agencySnap = agencyId
        ? await tx.get(db.collection('agencies').doc(agencyId))
        : null
      const badAgency = agencyCodeRefusal(
        agencySnap && agencySnap.exists ? (agencySnap.data() as Record<string, any>) : null,
        code,
      )
      if (badAgency) throw new functions.https.HttpsError('failed-precondition', badAgency)

      // The contact match (see "Both must match" and QA #51 above). A verified
      // contact that names somebody else is refused outright.
      const match = invitationContactMatch(app, { phone, email })
      if (match.mismatch || !match.ok) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This code was issued to a different phone number or email address.',
        )
      }

      /*
       * Decision 15 (RC): the role starts only with BOTH contacts verified on
       * this account, by the definition every service shares — and (QA #51)
       * both equal to the invitation's.
       *
       * When one is still missing, the invitation is CLAIMED instead of refused:
       * it becomes this account's application, approved and waiting, and starts
       * by itself through the backend once the missing contact is verified —
       * the same path as an approved self-application. The claim itself is
       * written only after every check above has passed (restriction, revoked
       * or suspended role, another agency, the server's approval, the agency's
       * real code), so it carries no authority the activation would not have.
       */
      if (match.missing.length > 0) {
        // The account has not verified one of its contacts at all (a new phone
        // sign-up has no e-mail; a Google sign-up no phone): claim and wait.
        const missing: Contact[] = Array.from(new Set<Contact>([...match.missing, ...proof.missing]))
        tx.update(appRef, invitationClaimStamp(uid, missing, admin.firestore.FieldValue.serverTimestamp()))
        return {
          alreadyActivated: false,
          awaitingVerification: true,
          agencyId,
          missing,
          contactHint: contactHintFor(app, missing),
          requirement: 'both',
          code: CONTACT_VERIFICATION_REQUIRED,
          claimedNow: true,   // internal: taken off before the answer is sent
        }
      }
      // Both contacts are present: they must both be the invited ones…
      if (!phoneOk || !emailOk) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This code was issued to a different phone number or email address.',
        )
      }
      // …and both proved by the definition every service shares (an address
      // Firebase marked verified on a password account is not proof without
      // our own code — see contactProof.ts). Unchanged by QA #51.
      if (!proof.complete) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Your Host role starts once both your phone number and your email address are verified on this account.',
          { code: CONTACT_VERIFICATION_REQUIRED, requirement: 'both', missing: proof.missing,
            emailUnproved: proof.emailUnproved },
        )
      }

      // The rate the agency agreed, clamped to the CRM's band. An agency
      // dashboard that accepts any number must not be able to set a rate the
      // economy config forbids.
      const cfgSnap = await tx.get(db.collection('appConfig').doc('economy'))
      const cfg = (cfgSnap.data() ?? {}) as Record<string, any>
      const min = Number(cfg.minHostCallRate ?? 100)
      const max = Number(cfg.maxHostCallRate ?? 700)
      const requested = Number(app.callRate ?? min)
      const callRateBeans = Math.min(Math.max(requested, min), max)

      // FX-12 (RF-05 / DUP-06): the person's own OTHER open host applications
      // — read here, with the rest of the transaction's reads, and closed
      // below in the same write as the activation. A pending self-application
      // left beside a redeemed invitation sat in /kyc as a second application
      // for somebody who was already a Host, and refusing it later was how the
      // role got taken away (RF-04).
      const ownApps = await tx.get(
        db.collection('hostApplications').where('applicantUid', '==', uid),
      )
      const supersede = supersededApplications(
        ownApps.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
        appRef.id,
      )

      const now = admin.firestore.FieldValue.serverTimestamp()

      tx.update(appRef, { isActivated: true, activatedByUid: uid, activatedAt: now })
      for (const otherId of supersede) {
        // The B32 lock on a superseded application is released by the backend
        // the next time it is consulted: a lock whose application is no
        // longer pending is stale by definition (`_host_lock_is_stale`).
        tx.update(db.collection('hostApplications').doc(otherId), supersededStamp(appRef.id, now))
      }
      tx.update(userRef, {
        isHost: true,
        agencyId,
        callRateBeans,
        // Explicitly false, not absent. `isVerifiedHost !== true` is what the
        // payout release checks, and a missing field reads as unverified — but
        // writing it makes the state visible in the CRM rather than implied.
        isVerifiedHost: false,
        hostActivatedAt: now,
      })

      // Open the verification record. The agency's photograph is already on the
      // application; the host supplies the live capture from the app.
      tx.set(verRef, {
        uid,
        status: 'pending_capture',
        agencyPhotoUrl: app.photoUrl ?? '',
        agencyId,
        applicationId: appRef.id,
        hostName: app.hostName ?? '',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      }, { merge: true })

      // The agency's roster. Without this the agency has a host and no way to
      // know it — see writeAgencyMembership.
      writeAgencyMembership(tx, agencyId, uid, {
        name: hostName,
        applicationId: appRef.id,
        callRateBeans,
        joining: true,
      })

      return { alreadyActivated: false, agencyId, callRateBeans, supersededApplications: supersede }
    })

    const { claimedNow, ...answer } = outcome as typeof outcome & { claimedNow?: boolean; missing?: Contact[] }
    if (claimedNow === true) {
      // Ids and which contacts are missing — never the code, a contact or a hint.
      await recordEvent('HOST_INVITATION_CLAIMED', {
        uid, applicationId: appRef.id, agencyId: String(answer.agencyId ?? ''), missing: answer.missing ?? [],
      })
    }
    return answer
  })

// ── setCallRate ──────────────────────────────────────────────────────────────

/**
 * A host sets what a minute of their time costs.
 *
 * ── Why this is a function and not a rule ────────────────────────────────────
 *
 * `callRateBeans` was written straight onto the user document from the phone,
 * with `firestore.rules::callRateWithinBand()` as the only check. That rule read
 * `appConfig/economy.maxHostCallRate`, a single platform-wide number that is
 * 700, and it could not read anything else: a security rule cannot look a host
 * up on the level ladder, find the rung their lifetime earnings put them on and
 * compare the rate against that rung's ceiling. The ladder runs to 2,400.
 *
 * So the rule was wrong in both directions at once. A level-10 host who had
 * earned thirty-two million beans was held at the level-0 ceiling and could not
 * set the rate their level entitles them to — the slider in the app offered it,
 * the write was refused, and nothing explained why. And the ceiling that *was*
 * enforced had nothing to do with the host it was being enforced against.
 *
 * Here the same ladder `getHostHome` shows the host and `sweepHostLevels`
 * maintains is imported rather than restated, so the number the slider is drawn
 * against and the number the write is checked against cannot drift apart. The
 * rules now forbid the field outright, which makes this the only route.
 *
 * ── Clamping rather than refusing ────────────────────────────────────────────
 *
 * A rate above the ceiling comes back clamped, with the ceiling and the level
 * that produced it, instead of an error. The host asked for something they are
 * not entitled to yet; the useful answer is the best rate they can actually
 * have and the reason it is that one. A refusal would leave the slider showing
 * a number the economy does not honour, which is the state this replaces.
 */
export const setCallRate = functions
  .region('asia-south1')
  .https.onCall(async (data: { callRateBeans: number }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    await assertActiveSession(uid, data, 'setCallRate', context.auth?.token)   // Phase 1A
    const requested = Math.floor(Number(data?.callRateBeans))
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'A call rate in beans per minute is required.')
    }

    const userRef = db.collection('users').doc(uid)
    const [userSnap, cfgSnap, ladder] = await Promise.all([
      userRef.get(),
      db.collection('appConfig').doc('economy').get(),
      getHostLadder(),
    ])

    if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')
    if (userSnap.get('isHost') !== true) {
      throw new functions.https.HttpsError('permission-denied', 'This is for hosts only.')
    }
    // §5: the price of a suspended Host's time is not changed while the role is
    // suspended — there are no calls to price; the rate stands for the resume.
    const suspended = hostRoleSuspension(userSnap)
    if (suspended) {
      throw new functions.https.HttpsError(
        'permission-denied', hostSuspendedMessage(suspended), hostSuspensionDetails(suspended),
      )
    }
    // The same rule `startCall` prices on and `getHostHome` reports: an
    // unverified host is charged out at the base rate whatever their level, so
    // letting them set one would only mean the slider showed a number the
    // economy ignores.
    if (userSnap.get('isVerifiedHost') !== true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Finish identity verification before setting your call rate. Until then calls are charged at the base rate.',
      )
    }

    const cfg = (cfgSnap.data() ?? {}) as Record<string, any>
    const min = Number(cfg.minHostCallRate ?? 100)

    // Lifetime earnings decide the level, exactly as in getHostHome — call and
    // gift earnings together, because the ladder is about what a host has
    // brought in and not about how.
    const lifetime =
      Number(userSnap.get('hostCallEarnings') ?? 0) + Number(userSnap.get('hostGiftEarnings') ?? 0)
    const level = hostLevelFor(lifetime, ladder)
    const rung = ladder.find((l) => l.level === level) ?? ladder[0]
    // `Math.max(min, …)` so a misconfigured rung cannot produce a ceiling below
    // the floor, which would clamp every host to an impossible range.
    const max = Math.max(min, Number(rung?.maxCallRateBeans ?? 0))

    const callRateBeans = Math.min(Math.max(requested, min), max)
    await userRef.update({ callRateBeans })

    return {
      callRateBeans,
      level,
      minCallRateBeans: min,
      maxCallRateBeans: max,
      clamped: callRateBeans !== requested,
    }
  })

// ── checkReferralCode ────────────────────────────────────────────────────────

/**
 * Pre-flight check for the code field in profile setup.
 *
 * `verifyReferralCode` in AuthRepository queried `hostApplications` directly.
 * That collection holds bank account numbers, dates of birth and KYC document
 * URLs for every host, and the rule permitting that query permitted reading all
 * of it. This returns the only two things the form needs — is the code usable,
 * and which agency is it — and nothing else.
 */
/**
 * A REFERRAL CODE IDENTIFIES AN AGENCY, NOT AN APPLICATION.
 *
 * Every host an agency invites carries that agency's code, so several
 * `hostApplications` documents legitimately share one `referralCode` — and in
 * practice a lot of them do, because a re-invite after a typo or a failed
 * submission leaves the earlier attempt behind.
 *
 * Both callers used to do `.where('referralCode', '==', code).limit(1)` and
 * take `docs[0]`. Firestore has no obligation to return any particular one of
 * four equal matches, so redemption came down to whichever document the index
 * happened to hand back first. An agency with one approved invitation and one
 * rejected leftover would have its host told "that application was not
 * approved" while the approved invitation sat untouched beside it.
 *
 * So the candidate is CHOSEN rather than taken:
 *
 *   1. It must be this applicant's. Phone and email both have to match, which
 *      is the identity check that was always there — it just used to run
 *      against an arbitrary document instead of being used to find the right
 *      one.
 *   2. Among those, a usable invitation wins: not already redeemed, not
 *      rejected, and approved ahead of still-pending.
 *
 * `reason` describes the BEST candidate, not the first. Somebody holding one
 * rejected and one approved invitation is approved, and somebody holding only
 * rejected ones is rejected.
 */
type Applicant = { phone: string; email: string }

/*
 * ── COMPARING A TYPED NUMBER WITH AN AUTHENTICATED ONE ──────────────────────
 *
 * The agency types the host's number into the CRM; the host arrives holding a
 * Firebase phone credential. The two are rarely spelled the same way: one has a
 * country code and spaces, the other is E.164, and a bare national number typed
 * into a form has no country at all.
 *
 * This used to be settled by keeping the last TEN digits of each, on the
 * reasoning that an Indian mobile is ten digits and anything to the left is a
 * country code. That made `+1 415 555 0100` and `+91 41555 50100` the same
 * number, which is wrong everywhere outside India — see ./phone for what it cost
 * in `identity.ts`, where the same key decided whose record to blank.
 *
 * `sameNumber` keeps the tolerance exactly where it is needed and nowhere else:
 * two full international numbers are compared digit for digit, and a bare
 * national number is allowed to match the tail of a full one. That second case
 * is genuinely ambiguous — `4155550100` is the tail of both a US and an Indian
 * number — and it is safe HERE and only here, because the phone is never
 * sufficient on its own: `applicationsFor` and `activateHost` both require the
 * EMAIL to match as well. A number that collides with another country's still
 * gets nowhere without the address.
 */

/** True only when both sides have a number and it is the same number. */
function samePhone(a: unknown, b: unknown): boolean {
  return sameNumber(a, b)
}

/*
 * ── QA #51: AN INVITED HOST WHO HAS PROVED ONLY ONE CONTACT ─────────────────
 *
 * An agency invites a host by phone AND e-mail; the host arrives with ONE of
 * them proved — a phone OTP sign-up has a verified number and no e-mail, a
 * Google sign-up the reverse. `applicationsFor` used to look the invitation up
 * by the verified e-mail only, so every new phone sign-up found nothing and was
 * told "Details don't match the agency record for this code" — every host an
 * agency invited, at the very first step.
 *
 * The identity rule is unchanged: only VERIFIED contacts count (`identityFor`),
 * and nothing typed into a form is ever compared. What changes is what one
 * proved contact may do:
 *
 *   * it may FIND and CLAIM the invitation when it matches what the agency
 *     registered, and no other verified contact of the account contradicts the
 *     invitation (`invitationContactMatch`);
 *   * it may NOT start the Host role. Decision 15 still holds — the role starts
 *     only when BOTH contacts are verified and BOTH equal the invitation's. The
 *     claimed invitation waits in `awaiting_verification`, owned by this
 *     account, exactly like an approved self-application, and the backend
 *     starts it once the missing contact is verified
 *     (`users.activate_host_if_verified`, which re-checks the invitation's
 *     contacts — see `_invitation_contact_problem`).
 *
 * A phone alone proves the invitation only when the agency's number is
 * unambiguous: international and equal digit for digit. A bare national number
 * matches the tail of several countries' numbers (./phone), so for such an
 * invitation the e-mail has to be the contact that finds it.
 */

/** The contacts a person must still verify, in a fixed order. */
export type Contact = 'phone' | 'email'

export interface InvitationContactMatch {
  /** The invitation may be claimed by this account. */
  ok: boolean
  /** A verified contact of the account names a different phone or e-mail. */
  mismatch: boolean
  /** Both of the invitation's contacts equal verified contacts of the account. */
  full: boolean
  /** Contacts this account has not verified yet. */
  missing: Contact[]
}

export function invitationContactMatch(
  app: Record<string, unknown> | null | undefined,
  who: { phone?: string; email?: string },
): InvitationContactMatch {
  const a = app ?? {}
  const invitedEmail = String(a.applicantEmail ?? '').trim().toLowerCase()
  const invitedPhone = String(a.applicantPhone ?? '').trim()
  const phone = String(who.phone ?? '').trim()
  const email = String(who.email ?? '').trim().toLowerCase()

  const missing: Contact[] = []
  if (!phone) missing.push('phone')
  if (!email) missing.push('email')

  // An invitation names both contacts (the Invite Host form requires both).
  // One that does not cannot be redeemed — as before — so it never matches.
  const complete = invitedEmail !== '' && digitsOf(invitedPhone) !== ''

  const emailMatch = email !== '' && invitedEmail !== '' && email === invitedEmail
  const phoneMatch = phone !== '' && samePhone(invitedPhone, phone)
  const mismatch =
    (email !== '' && invitedEmail !== '' && !emailMatch) ||
    (phone !== '' && digitsOf(invitedPhone) !== '' && !phoneMatch)

  // What a proved phone may claim on its own: an unambiguous invited number.
  const phoneProves = phoneMatch && hasCountryCode(invitedPhone) && sameNumberStrict(invitedPhone, phone)

  return {
    ok: complete && !mismatch && (emailMatch || phoneProves),
    mismatch,
    full: complete && emailMatch && phoneMatch,
    missing,
  }
}

/** `p•••@example.com` — the shape `contact_verification.mask_email` uses. */
export function maskInvitedEmail(email: unknown): string {
  const e = String(email ?? '').trim().toLowerCase()
  const at = e.indexOf('@')
  if (at <= 0) return ''
  return `${e.slice(0, 1)}•••${e.slice(at)}`
}

/** `••••0004` — the shape `contact_verification.mask_phone` uses. */
export function maskInvitedPhone(phone: unknown): string {
  const d = digitsOf(phone)
  if (!d) return ''
  return d.length >= 4 ? `••••${d.slice(-4)}` : '••••'
}

/** The registered (masked) value of each contact the person still has to verify. */
export function contactHintFor(app: Record<string, unknown>, missing: Contact[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (missing.includes('email')) out.email = maskInvitedEmail(app.applicantEmail)
  if (missing.includes('phone')) out.phone = maskInvitedPhone(app.applicantPhone)
  return out
}

/** The stamp a claim writes: the invitation now belongs to this account and waits for its contacts. */
export function invitationClaimStamp(uid: string, missing: Contact[], now: unknown): Record<string, unknown> {
  return {
    applicantUid: uid,
    status: 'awaiting_verification',
    claimedVia: 'invitation_code',
    claimedAt: now,
    activationPending: missing,
    updatedAt: now,
  }
}

/** The status a claimed invitation carries while its contacts are missing. */
export const AWAITING_VERIFICATION = 'awaiting_verification'

/**
 * The phone and email this account is known by, from the best source available.
 *
 * A host application is matched on BOTH, and no sign-in method supplies both:
 * a phone OTP gives a verified `phone_number` and no email, a Google sign-in
 * gives a verified `email` and no phone. The missing half is collected once,
 * during profile setup, and written to `users/{uid}` as `email` and
 * `phoneNumber`.
 *
 * So there are three sources and they are consulted in order of how much they
 * can be trusted:
 *
 *   1. the AUTH TOKEN — verified by Firebase, unforgeable, and therefore always
 *      preferred where it has a value;
 *   2. the USER DOCUMENT — what this person gave us at setup. Not verified, but
 *      it is *stored*, which is what makes the code box work on its own: the
 *      applicant types a code and nothing else, and a retry weeks later still
 *      works without them re-entering anything;
 *   3. the REQUEST — what is typed into the form right now. Last, because it is
 *      the only one somebody can change at will, and it is needed only during
 *      first-time setup, when the profile has not been written yet.
 *
 * None of the three is a grant. Whichever value arrives still has to equal what
 * the agency registered on the application, or the code is refused — so this
 * decides which value we compare, never whether the comparison passes.
 */
async function identityFor(
  uid: string,
  token: Record<string, any> | undefined,
  // Kept in the signature so callers compile; deliberately IGNORED. See below.
  _data?: { phone?: string; email?: string } | undefined,
): Promise<{ phone: string; email: string }> {
  /*
   * ── Phase 1A (SECURITY-002 / CONTACT-001): VERIFIED SOURCES ONLY ─────────
   *
   * This used to fall back to the user document and then to the request body.
   * Both are typed values: anyone could put a victim's phone and email in the
   * request (or, before the rules change, on their own user document) and
   * redeem the invitation addressed to that victim. A claim about a person
   * must come from something that person proved.
   *
   *   1. the ID token — verified by Firebase;
   *   2. the Firebase Auth RECORD for this uid — phone numbers on it were
   *      OTP-verified to get there, and the email is used only when
   *      `emailVerified` is true. This covers a token minted before a
   *      `bindVerifiedIdentity` link.
   *
   * Nothing else. An applicant missing a half adds it through the verified
   * bind flow and tries again.
   */
  let phone = String(token?.phone_number ?? '').trim()
  let email = String(token?.email ?? '').trim().toLowerCase()
  if (email && token?.email_verified === false) email = ''

  if (!phone || !email) {
    try {
      const rec = await admin.auth().getUser(uid)
      if (!phone) phone = String(rec.phoneNumber ?? '').trim()
      if (!email && rec.emailVerified) email = String(rec.email ?? '').trim().toLowerCase()
    } catch {
      // No record: nothing verified to add. The comparison below refuses.
    }
  }
  return { phone, email }
}

/** Lower sorts first — the invitation we would rather redeem. */
function candidateRank(app: Record<string, any>): number {
  if (app.isActivated === true) return 40
  if (app.status === 'rejected') return 30
  if (app.status === 'approved') return 0
  // QA #51: already claimed by this account and waiting for its contacts.
  if (app.status === AWAITING_VERIFICATION) return 5
  return 10 // pending, or anything unrecognised: usable, but not preferred
}

/**
 * QA #51: how many of an agency's invitations a phone-only lookup reads. The
 * phone is stored as the agency typed it, so it cannot be queried directly;
 * the code's invitations are read and compared in memory. Bounded: an agency
 * with more OPEN invitations than this under one code is not a real case, and
 * the e-mail path below has no such limit.
 */
export const PHONE_SCAN_LIMIT = 300

/**
 * Applications for [code] that belong to [who], best first.
 *
 * Queried by EMAIL rather than by referral code, which is the direction that
 * scales. An agency's code is shared by every host it has ever invited, so
 * querying on it and filtering in memory would read the agency's entire
 * invitation history on every keystroke of a code — hundreds of documents full
 * of bank details, for a lookup about one person. An email address belongs to
 * one applicant, so it returns a handful at most.
 *
 * `applicantEmail` is stored already-lowercased by the agency dashboard, so an
 * equality match is reliable. The phone number is not — it is stored however it
 * was typed, spaces and all — so it is compared in memory after normalising.
 *
 * The second query exists only to tell two refusals apart: a code nobody has,
 * and a code that is real but was not issued to this person. Both would
 * otherwise look identical, and "no such code" on a valid code sends people to
 * support for no reason.
 */
async function applicationsFor(code: string, who: Applicant, uid = '') {
  type Snap = admin.firestore.QueryDocumentSnapshot
  const found = new Map<string, Snap>()
  let anyForCode = false

  // By the verified e-mail: an address belongs to one applicant, so this
  // returns a handful at most (see above).
  if (who.email) {
    const byEmail = await db.collection('hostApplications')
      .where('applicantEmail', '==', who.email)
      .limit(25)
      .get()
    for (const d of byEmail.docs) {
      if (String(d.get('referralCode') ?? '').trim().toUpperCase() !== code) continue
      anyForCode = true
      found.set(d.id, d)
    }
  }

  // QA #51: by the verified phone, for the person who has not proved an e-mail
  // yet (a new phone sign-up). The number is stored as the agency typed it, so
  // the code's OPEN invitations are compared in memory.
  if (who.phone) {
    const byCode = await db.collection('hostApplications')
      .where('referralCode', '==', code)
      .where('isActivated', '==', false)
      .limit(PHONE_SCAN_LIMIT)
      .get()
    if (!byCode.empty) anyForCode = true
    if (byCode.size >= PHONE_SCAN_LIMIT) {
      // The agency, not its code: a referral code is what a host types to join
      // an agency, so it stays out of the logs (security review, 3 Nov 2026).
      functions.logger.warn('host invitation phone scan hit its limit', {
        agencyId: String(byCode.docs[0]?.get('agencyId') ?? ''), limit: PHONE_SCAN_LIMIT,
      })
    }
    for (const d of byCode.docs) {
      if (samePhone(d.get('applicantPhone'), who.phone)) found.set(d.id, d)
    }
  }

  // Never another account's: a self-application of somebody else, or an
  // invitation another account has already claimed (QA #51), is not offered.
  let claimedByOther = false
  const candidates = [...found.values()].filter((d) => {
    const owner = String(d.get('applicantUid') ?? '').trim()
    if (owner && owner !== uid) {
      claimedByOther = true
      return false
    }
    return true
  })

  // Each candidate must be this person's by the rule above: no verified
  // contact contradicts it, and at least one proves it.
  let mismatched = false
  const mine = candidates.filter((d) => {
    const m = invitationContactMatch(d.data(), who)
    if (m.mismatch) mismatched = true
    return m.ok
  })

  mine.sort((a, b) => candidateRank(a.data()) - candidateRank(b.data()))
  if (mine.length > 0) return { anyForCode: true, mine, claimedByOther, mismatched }

  if (!anyForCode) {
    const exists = await db
      .collection('hostApplications')
      .where('referralCode', '==', code)
      .limit(1)
      .get()
    anyForCode = !exists.empty
  }
  return { anyForCode, mine, claimedByOther, mismatched }
}

export const checkReferralCode = functions
  .region('asia-south1')
  .https.onCall(async (data: { referralCode: string; phone?: string; email?: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const code = String(data?.referralCode ?? '').trim().toUpperCase()
    if (!code) return { valid: false, reason: 'not_found' }
    if (guestRefusal(context.auth?.token)) return { valid: false, reason: 'guest' }
    // Before any invitation is read (security review, 3 Nov 2026): the answer
    // tells a code nobody has from one issued to somebody else, and a phone
    // caller's lookup reads up to PHONE_SCAN_LIMIT invitations.
    await limitInvitationLookups(uid, context.rawRequest)

    // The same three sources, in the same order, as redemption. If this check
    // resolved the applicant differently from `activateHost` the code would go
    // green and then be refused on submit, which is the one outcome that makes
    // host signup look broken rather than blocked.
    const { phone, email } = await identityFor(uid, context.auth?.token, data)

    const { anyForCode, mine, claimedByOther } = await applicationsFor(code, { phone, email }, uid)
    if (!anyForCode) return { valid: false, reason: 'not_found' }
    if (mine.length === 0) {
      // QA #51: the invitation for these contacts exists but another account
      // has already claimed it — the code is spent for this person.
      if (claimedByOther) return { valid: false, reason: 'already_used' }
      // The code exists but no invitation under it was issued to this person.
      // Deliberately does not say which of phone or email differs: "your email
      // does not match" confirms the phone number does, which turns a guessed
      // code into a way to test whether a given number is registered as a host.
      return { valid: false, reason: 'account_mismatch' }
    }

    const app = mine[0].data() as Record<string, any>

    /*
     * The two refusals `activateHost` adds, asked here as well.
     *
     * The rule this file keeps repeating: the pre-flight must ask exactly what
     * redemption asks. A code that goes green and is then refused on submit is
     * the one outcome that makes host signup look broken rather than blocked —
     * and these two are the most confusing of the lot, because neither is about
     * the code at all.
     */
    const userSnap = await db.collection('users').doc(uid).get()
    if (userSnap.exists) {
      if (restrictionOn(userSnap)) return { valid: false, reason: 'restricted' }
      // C1 (B04): redemption refuses a revoked Host, so the pre-flight does.
      // The sentence travels with the reason; `code` matches the refusal's
      // `details.code` on `activateHost`.
      if (hostRoleRevoked(userSnap)) {
        return { valid: false, reason: 'role_revoked', code: ROLE_REVOKED, message: HOST_REVOKED_REFUSAL }
      }
      // §5: redemption refuses a suspended Host role, so the pre-flight does,
      // with the same sentence and `details.code`.
      const suspended = hostRoleSuspension(userSnap)
      if (suspended) {
        return {
          valid: false, reason: 'host_suspended', code: HOST_ROLE_SUSPENDED,
          message: hostSuspendedMessage(suspended),
        }
      }
      if (heldByAnotherAgency(userSnap, String(app.agencyId ?? ''))) {
        return { valid: false, reason: 'other_agency' }
      }
    }

    if (app.isActivated === true) return { valid: false, reason: 'already_used' }
    if (app.status === 'rejected') return { valid: false, reason: 'rejected' }
    // QA #51: an invitation THIS account claimed earlier was approved before it
    // was claimed; its decision stamp is unchanged. Anything else must carry
    // the server's approval.
    const claimedByMe = app.status === AWAITING_VERIFICATION && String(app.applicantUid ?? '') === uid
    // The check has to ask the same question redemption does, or the code goes
    // green and is then refused on save — which is precisely the mismatch that
    // made host signup look broken for a week.
    if (!claimedByMe && decisionRefusal(app)) return { valid: false, reason: 'not_approved' }
    // Phase 1A: the same agency/code check redemption makes. A code that no
    // longer belongs to the agency (it was changed) or an agency that stopped
    // taking hosts is a code that no longer works — "expired" in the person's
    // terms; invitations themselves carry no expiry date.
    const agencyId = String(app.agencyId ?? '').trim()
    const agencySnap = agencyId ? await db.collection('agencies').doc(agencyId).get() : null
    const badAgency = agencyCodeRefusal(
      agencySnap && agencySnap.exists ? (agencySnap.data() as Record<string, any>) : null, code)
    if (badAgency) {
      return agencySnap && agencySnap.exists && badAgency === AGENCY_NOT_ACCEPTING
        ? { valid: false, reason: 'agency_inactive', message: badAgency }
        : { valid: false, reason: 'not_found' }
    }

    // QA #51: the code is this person's, but the Host role needs BOTH contacts
    // verified. Say which one is missing, and which address or number the
    // agency registered for it (masked), so the right one gets verified.
    const proof = await contactProofFor(uid)
    const needs = proof.missing
    return {
      valid: true,
      agencyName: app.agencyName ?? '',
      ...(needs.length > 0
        ? { needsVerification: needs, contactHint: contactHintFor(app, needs) }
        : {}),
    }
  })

// ── submitHostCapture ────────────────────────────────────────────────────────

/**
 * Where the app uploads the live capture: `AuthRepository.submitHostCapture`,
 * and the owner-write slot in `storage.rules`. The host overwrites it on
 * every try, so it is a scratch slot — never what a decision is made on.
 */
export function captureObjectPath(uid: string): string {
  return `hostVerification/${uid}/capture.jpg`
}

/**
 * Where a submitted attempt is kept: written once, here, with the Admin SDK.
 * `storage.rules` lets no client read or write under `attempts/`.
 */
export function attemptObjectPath(uid: string, attemptId: string): string {
  return `hostVerification/${uid}/attempts/${attemptId}.jpg`
}

/**
 * B24/B41: the capture is the server's, and only a current Host submits one.
 *
 * `captureUrl` from the client used to be stored as sent and shown to the
 * reviewer: any URL at all, and the object behind it overwritable after the
 * comparison ran. It is now IGNORED. The server reads the capture at the one
 * path it knows, copies it to a per-attempt path nothing else can write, and
 * stores THAT path — which the review reads (`verification.py` signs a bare
 * object path as readily as a URL). A repeat while the record is with a human
 * changes nothing: the stored attempt is the one under review.
 *
 * And a revoked or removed Host, or one whose account is restricted, does not
 * submit a face at all.
 */
export const submitHostCapture = functions
  .region('asia-south1')
  .https.onCall(async (data: { captureUrl?: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')
    await assertActiveSession(uid, data, 'submitHostCapture', context.auth?.token)   // Phase 1A (SESSION-001/003)

    const userRef = db.collection('users').doc(uid)
    // §5: a suspended Host role submits no face either (`HOST_ROLE_SUSPENDED`,
    // term and reason in `details`); the record waits for the resume.
    const notHost = activeHostRefusal(await userRef.get())
    if (notHost) {
      throw new functions.https.HttpsError('permission-denied', notHost.message, refusalDetails(notHost))
    }

    const verRef = db.collection('hostVerification').doc(uid)
    const verSnap = await verRef.get()
    if (!verSnap.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verification has not been set up for this account. Ask your agency to register you.',
      )
    }

    const ver = verSnap.data() as Record<string, any>
    if (ver.status === 'verified') {
      return { status: 'verified', alreadyVerified: true }
    }
    if (ver.status === 'pending_manual') {
      return { status: 'pending_manual', alreadyVerified: false }
    }

    // B24: the capture at the path the server knows, not whatever URL was sent.
    const bucket = admin.storage().bucket()
    const capture = bucket.file(captureObjectPath(uid))
    const [uploaded] = await capture.exists()
    if (!uploaded) {
      throw new functions.https.HttpsError('invalid-argument', 'No capture was uploaded.')
    }

    const agencyPhotoUrl = String(ver.agencyPhotoUrl ?? '')
    if (!agencyPhotoUrl) {
      // Nothing to compare against. This is the agency's gap, not the host's,
      // and the host is told exactly that rather than "verification failed".
      await verRef.update({
        status: 'pending_manual',
        manualReason: 'no_agency_photo',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      return { status: 'pending_manual', reason: 'no_agency_photo' }
    }

    // The immutable copy this attempt is decided on. `ifGenerationMatch: 0`
    // means "only if nothing is there yet", so an attempt is never replaced.
    const attemptId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
    const capturePath = attemptObjectPath(uid, attemptId)
    await capture.copy(bucket.file(capturePath), { preconditionOpts: { ifGenerationMatch: 0 } })

    const match = await compareFaces(agencyPhotoUrl, capturePath)
    const now = admin.firestore.FieldValue.serverTimestamp()

    const base: Record<string, any> = {
      // The server's copy, never the client's URL. Field name kept: the review
      // (`verification.py`) and the CRM read `captureUrl`.
      captureUrl: capturePath,
      captureAttemptId: attemptId,
      capturedAt: now,
      updatedAt: now,
      attemptCount: admin.firestore.FieldValue.increment(1),
      aiScore: match?.score ?? null,
      // Stored per attempt, not read from config at review time. Thresholds
      // move, and a decision has to be explicable against the rule that was in
      // force when it was made.
      aiThreshold: match?.threshold ?? null,
      aiProvider: match?.provider ?? null,
      aiRanAt: match ? now : null,
    }

    // Re-read in the transaction: a second submission that raced this one, or
    // a decision that landed meanwhile, keeps what it stored — the attempt
    // under review is never overwritten.
    return db.runTransaction(async (tx) => {
      const current = String((await tx.get(verRef)).get('status') ?? '')
      if (current === 'verified' || current === 'pending_manual') {
        return { status: current, alreadyVerified: current === 'verified' }
      }

      if (match && match.score >= match.threshold) {
        tx.set(verRef, { ...base, status: 'verified', verifiedAt: now, verifiedBy: 'ai' }, { merge: true })
        tx.update(userRef, { isVerifiedHost: true })
        return { status: 'verified', aiScore: match.score }
      }

      // Below threshold, or no comparator. Either way a human decides — an AI
      // that is unsure must not reject someone's livelihood on its own.
      tx.set(verRef, { ...base, status: 'pending_manual' }, { merge: true })
      return { status: 'pending_manual', aiScore: match?.score ?? null }
    })
  })

// ── Manual review lives in the Python backend ────────────────────────────────
//
// There was a `reviewHostVerification` callable here. It has been removed, not
// because a callable could not do the writes, but because it could not write
// the audit trail.
//
// Approving a verification sets `users/{uid}.isVerifiedHost`, and
// `releaseBeansForWeek` will not release a week's earnings without that flag.
// So an approval is the moment a host becomes payable, and it belongs in the
// same append-only log as bans, balance cards and payouts — which is Mongo,
// written by `app.core.audit`, and read by `/audit` in the CRM.
//
// The callable wrote an `auditLog` collection in Firestore instead. Nothing
// reads it. A decision about someone's identity and their ability to be paid,
// recorded where no owner would ever look, is worse than no second trail at
// all, and two review paths writing two different trails is worse again.
//
// The review path is:
//   GET  /api/host-verification/pending      queue, oldest first
//   GET  /api/host-verification/{uid}        both faces, signed URLs, 15 min
//   POST /api/host-verification/{uid}/review verdict + note, audited
//
// backend/app/services/verification.py does the Firestore writes with the
// Admin SDK, which is why the rules here can be `allow write: if isAdmin()`.

// ── Agency re-uploads the photograph ─────────────────────────────────────────

/**
 * When an agency replaces a host's photograph on the application, the previous
 * comparison is about a different picture and the host gets another attempt.
 *
 * A rejected host is told *"ask your agency to re-upload your original photo"*,
 * so this is the other half of that instruction — without it the message sends
 * the host to do something that changes nothing.
 */
export const onAgencyPhotoReplaced = functions
  .region('asia-south1')
  .firestore.document('hostApplications/{appId}')
  .onUpdate(async (change) => {
    const before = change.before.data() as Record<string, any>
    const after = change.after.data() as Record<string, any>
    if (before.photoUrl === after.photoUrl) return null

    /*
     * B38: the Host behind the application, however they got there.
     *
     * `activatedByUid` is stamped by redeeming an invitation. A SELF-applied
     * Host (Join as Host → approval) was granted without one, and their
     * application names them only as `applicantUid` — so a re-uploaded photo
     * reached nobody and the host stayed told to "ask your agency to re-upload"
     * after it had been done.
     */
    const redeemedBy = String(after.activatedByUid ?? '').trim()
    const uid = redeemedBy || String(after.applicantUid ?? '').trim()
    if (!uid) return null

    const verRef = db.collection('hostVerification').doc(String(uid))
    const verSnap = await verRef.get()
    if (!verSnap.exists) return null
    // A verified host does not lose the badge because their agency tidied up a
    // photograph. Re-verification is a deliberate act, not a side effect.
    if (verSnap.get('status') === 'verified') return null

    // `applicantUid` is on every application a person ever filed, including
    // one rejected or superseded since. Only the application the record was
    // opened from (or, for a record naming none, one from the same agency)
    // may replace the photograph the host is compared against.
    if (!redeemedBy) {
      const recordApp = String(verSnap.get('applicationId') ?? '').trim()
      const recordAgency = String(verSnap.get('agencyId') ?? '').trim()
      const linked = recordApp !== ''
        ? recordApp === change.after.id
        : recordAgency !== '' && recordAgency === String(after.agencyId ?? '').trim()
      if (!linked) return null
    }

    await verRef.update({
      agencyPhotoUrl: after.photoUrl ?? '',
      status: 'pending_capture',
      aiScore: null,
      aiThreshold: null,
      aiProvider: null,
      aiRanAt: null,
      manualReason: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    functions.logger.info(`Host ${uid}: agency photo replaced, verification reopened.`)
    return null
  })
