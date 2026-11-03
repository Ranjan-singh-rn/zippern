import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { normaliseCrmRole, OWNER_ROLE } from './crmRoles'
import { ownerMfaVerified, type OwnerMfaToken } from './ownerMfa'
import { serverDurationSeconds } from './live'

const db = admin.firestore()

/**
 * `publicProfiles/{uid}` — what one user may see about another.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * `users/{uid}` is readable by every signed-in account, and the Home feed calls
 * `toObject(User::class.java)` on twenty of them at a time. So every account on
 * the platform could read every other account's `phoneNumber`, `email`, `dob`,
 * `deviceId`, `fcmToken`, `diamonds`, `beans`, `agencyId` and `crmRole`.
 *
 * On a dating app, the phone numbers of every host being one query away from
 * any account that completes signup is not a configuration detail. Under the
 * DPDP Act it is also personal data disclosed with no basis.
 *
 * This collection holds the fields a stranger is meant to see, and nothing
 * else. Once every reader has moved over, `users/{uid}` becomes owner-and-staff
 * only.
 *
 * ── Why it also fixes the feed ───────────────────────────────────────────────
 *
 * The old query had no `orderBy` at all, so Firestore returned documents in
 * document-id order — effectively the same twenty accounts to everybody,
 * forever. Filtering and sorting then happened in Kotlin over just those
 * twenty. A country filter was a filter over an arbitrary sample, not a search.
 *
 * Sorting live-then-online-then-in-call is three fields, which Firestore cannot
 * order across. So the trigger flattens presence into one integer, and the feed
 * orders by that and `lastSeen`.
 */

// ── Presence, flattened ──────────────────────────────────────────────────────
//
// Descending, so a plain `orderBy('presenceRank', 'desc')` gives the order the
// product wants. Gaps left between values on purpose: a future state (say "in
// a party room") slots in without rewriting every stored rank.

const RANK_LIVE = 40
const RANK_ONLINE = 30
const RANK_IN_CALL = 20
const RANK_OFFLINE = 0

const RANK_IN_PARTY = 35

/**
 * `isLive` here is the SERVER's copy, written by [syncLivePresence] from the
 * live room itself — not `users/{uid}.isLive`, which the broadcaster writes.
 *
 * A user who could set their own `isLive` would rank 40 and sit at the top of
 * every feed on the platform without ever streaming. It is the single most
 * valuable field in this document, so it is the one field here that does not
 * come from the user document.
 */
function presenceRankOf(u: Record<string, any>, liveFromRoom: boolean): number {
  if (liveFromRoom) return RANK_LIVE
  if (u.isInParty === true) return RANK_IN_PARTY
  if (u.isInCall === true) return RANK_IN_CALL
  if (u.isOnline === true) return RANK_ONLINE
  return RANK_OFFLINE
}

/**
 * The projection. Every field here is either shown on a profile card or needed
 *
 * Exported so `scripts/backfill-public-profiles.mjs` can use this exact
 * function. A backfill that reimplemented the field list would drift from it,
 * and the drift would show up as profiles missing a field nobody had noticed
 * was missing.
 * to filter or sort the feed — if it is neither, it does not belong.
 *
 * Deliberately absent: phoneNumber, email, dob, deviceId, fcmToken, diamonds,
 * beans, beansAvailable, agencyId, crmRole, callRateBeans, hostCallEarnings,
 * hostGiftEarnings, bank details, and everything under moderation.
 */
export function project(
  uid: string,
  u: Record<string, any>,
  liveFromRoom: boolean,
): Record<string, any> {
  return {
    uid,
    name: u.name ?? '',
    photoUrl: u.photoUrl ?? '',
    bio: u.bio ?? '',
    gender: u.gender ?? '',
    country: u.country ?? '',
    city: u.city ?? '',
    // Age, not date of birth. The feed shows "24"; it has never needed to know
    // which day in 2002.
    age: Number(u.age ?? 0),
    level: Number(u.level ?? 0),
    // F-16 (LEVEL-003): a host level is a HOST's attribute. For anyone who
    // does not hold the role it is 0 here — written as 0, not omitted, because
    // the projection is merged and a stale value would otherwise survive a
    // revocation.
    hostLevel: u.isHost === true ? Number(u.hostLevel ?? 0) : 0,
    isHost: u.isHost === true,
    // FX-10 (RF-15): "verified Host" only while they ARE a Host. `revoke_host`
    // clears `isHost` and leaves `isVerifiedHost` (the verification record is
    // history, not a badge), so the public card kept showing a revoked or
    // purged Host as verified.
    isVerifiedHost: u.isHost === true && u.isVerifiedHost === true,
    isOfficial: u.isOfficial === true,
    isLive: liveFromRoom,
    isOnline: u.isOnline === true,
    isInCall: u.isInCall === true,
    isInParty: u.isInParty === true,
    presenceRank: presenceRankOf(u, liveFromRoom),
    lastSeen: Number(u.lastSeen ?? 0),
    // Filter facets. `languageCodes` is flattened from the `languages` array of
    // maps, because Firestore's array-contains cannot match on a field inside a
    // map element.
    languageCodes: Array.isArray(u.languages)
      ? u.languages.map((l: any) => String(l?.code ?? '')).filter(Boolean)
      : [],
    hobbies: Array.isArray(u.hobbies) ? u.hobbies : [],
    likes: Array.isArray(u.likes) ? u.likes : [],
    // Public counters. Social proof, and nobody's private business.
    totalLikesReceived: Number(u.totalLikesReceived ?? 0),
    followerCount: Number(u.followerCount ?? 0),
    /**
     * A host's per-minute bean income — which is a PRICE, not a balance. The
     * caller's diamond cost is derived from it, so the profile screen cannot
     * show what a call costs without it. Chamet shows the same number.
     *
     * Distinct from `hostCallEarnings` and `beans`, which are totals and stay
     * out of here.
     */
    callRateBeans: Number(u.callRateBeans ?? 0),
    /** Coin sellers are a public directory — the Diamond Shop lists them. */
    isSeller: u.isSeller === true,
    // ── Profile screen ─────────────────────────────────────────────────────
    //
    // Everything a visitor sees on someone's profile. All public by intent:
    // a gallery nobody can open is not a gallery, and Top Fans is a leaderboard.
    coverPhotoUrl: u.coverPhotoUrl ?? '',
    mediaUrls: Array.isArray(u.mediaUrls) ? u.mediaUrls : [],
    mediaThumbs: Array.isArray(u.mediaThumbs) ? u.mediaThumbs : [],
    // Full language objects as well as the flat codes — the codes exist to be
    // queried, these to be rendered with their names.
    languages: Array.isArray(u.languages) ? u.languages : [],
    topSupporters: Array.isArray(u.topSupporters) ? u.topSupporters : [],
    topHosts: Array.isArray(u.topHosts) ? u.topHosts : [],
    totalLikesGiven: Number(u.totalLikesGiven ?? 0),
    isAgent: u.isAgent === true,
    // Where to send someone who taps "join". Public by definition: a room you
    // cannot be told the id of is a room nobody can join.
    liveRoomId: u.liveRoomId ?? '',
    partyRoomId: u.partyRoomId ?? '',
    // Cosmetics the profile card renders.
    equippedFrame: u.equippedFrame ?? '',
    equippedChatBubble: u.equippedChatBubble ?? '',
    equippedProfileCard: u.equippedProfileCard ?? '',
    equippedIdFrame: u.equippedIdFrame ?? '',
    equippedEntrance: u.equippedEntrance ?? '',
    // Feed eligibility. A profile only appears once it is complete, and never
    // while the account is banned, suspended or deleted. (F-16: a suspension
    // writes `isSuspended` and `accountState: 'suspended'`; both are checked,
    // whichever the writer set.)
    isListed:
      u.isProfileComplete === true &&
      u.isBanned !== true &&
      u.isSuspended !== true &&
      String(u.accountState ?? '') !== 'suspended' &&
      u.isDeleted !== true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }
}

/** Fields whose change should cause a reprojection. */
const WATCHED = [
  'name', 'photoUrl', 'bio', 'gender', 'country', 'city', 'age',
  'level', 'hostLevel', 'isHost', 'isVerifiedHost', 'isOfficial',
  // `isLive` is absent on purpose — it is owned by syncLivePresence.
  'isOnline', 'isInCall', 'isInParty', 'lastSeen',
  'languages', 'hobbies', 'likes',
  'totalLikesReceived', 'totalLikesGiven', 'followerCount', 'callRateBeans',
  'isSeller', 'isAgent', 'coverPhotoUrl', 'mediaUrls', 'mediaThumbs',
  'topSupporters', 'topHosts', 'liveRoomId', 'partyRoomId',
  'equippedFrame', 'equippedChatBubble', 'equippedProfileCard',
  'equippedIdFrame', 'equippedEntrance',
  'isProfileComplete', 'isBanned', 'isSuspended', 'accountState', 'isDeleted',
]

export const syncPublicProfile = functions
  .region('asia-south1')
  .firestore.document('users/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid as string
    const publicRef = db.collection('publicProfiles').doc(uid)

    if (!change.after.exists) {
      await publicRef.delete().catch(() => undefined)
      return null
    }

    const after = change.after.data() as Record<string, any>
    const before = change.before.exists
      ? (change.before.data() as Record<string, any>)
      : null

    // RC (confirmed): a PERMANENTLY deleted account has no public profile. The
    // purge deletes the projection and then writes the user document — which
    // fired this trigger and re-created it from the purged fields.
    if (String(after.accountState ?? '') === 'permanently_deactivated') {
      await publicRef.delete().catch(() => undefined)
      return null
    }

    // Every gift, every call tick and every diamond purchase writes the user
    // document. Reprojecting on all of them would roughly double the write cost
    // of the entire economy for a document that did not change.
    if (before) {
      const touched = WATCHED.some(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      )
      if (!touched) return null
    }

    // Read the projection's own isLive rather than the user document's: this
    // write must not clobber what syncLivePresence decided.
    const existing = await publicRef.get()
    const liveFromRoom = existing.get('isLive') === true

    await publicRef.set(project(uid, after, liveFromRoom), { merge: true })
    return null
  })

/**
 * Live presence, from the room rather than from a self-declared flag.
 *
 * `LiveRepository.goLive` writes `users/{uid}.isLive = true` from the phone. If
 * the feed ranked on that, setting it would be a permanent top-of-feed slot for
 * anyone willing to edit one boolean — and the top of the feed is where the
 * money is. So the feed ranks on this, which follows `liveRooms/{id}.isActive`.
 *
 * Still not proof that a stream is running, but a live room is a real object
 * with viewers and a channel, and it is created by a path that can be tightened
 * further without touching the ranking rule again.
 */
export const syncLivePresence = functions
  .region('asia-south1')
  .firestore.document('liveRooms/{roomId}')
  .onWrite(async (change, context) => {
    const roomId = context.params.roomId as string
    const after = change.after.exists ? (change.after.data() as Record<string, any>) : null
    const before = change.before.exists ? (change.before.data() as Record<string, any>) : null

    const hostUid = String(after?.hostUid ?? before?.hostUid ?? '')
    if (!hostUid) return null

    const isActive = after?.isActive === true
    const wasActive = before?.isActive === true
    if (isActive === wasActive && change.after.exists === change.before.exists) return null

    const userSnap = await db.collection('users').doc(hostUid).get()
    if (!userSnap.exists) return null
    const u = userSnap.data() as Record<string, any>

    await db.collection('publicProfiles').doc(hostUid).set(
      {
        isLive: isActive,
        liveRoomId: isActive ? roomId : '',
        presenceRank: presenceRankOf(u, isActive),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    // The user document mirrors presence too (it is owner-protected, so the
    // app cannot write it — this trigger is the only writer). Streamed time is
    // accrued when the room closes.
    //
    // B12 (4 Nov 2026): measured by the SERVER, not taken from the host's app.
    // The room is stamped `serverStartedAt` here when it goes live, and its
    // length at the close is from that stamp to now (`serverDurationSeconds`,
    // written back on the room). A room older than the stamp falls back to the
    // app's figure, capped at the room's own age.
    const userPatch: Record<string, any> = {
      isLive: isActive,
      liveRoomId: isActive ? roomId : '',
    }
    const roomRef = change.after.exists ? change.after.ref : null
    if (isActive && !wasActive && roomRef) {
      await roomRef.update({ serverStartedAt: admin.firestore.FieldValue.serverTimestamp() })
    }
    if (!isActive && wasActive) {
      const secs = serverDurationSeconds(after ?? {}, Date.now())
      if (secs > 0) {
        userPatch.streamedTimeSeconds = admin.firestore.FieldValue.increment(secs)
      }
      if (roomRef) await roomRef.update({ serverDurationSeconds: secs })
    }
    await db.collection('users').doc(hostUid).set(userPatch, { merge: true })
    return null
  })

/**
 * Backfill, for the profiles that existed before the trigger did.
 *
 * Owner-only and idempotent: running it twice writes the same projections. It
 * exists because a trigger only fires on write, so without this every account
 * that never changes again would be missing from the feed entirely.
 */
export const backfillPublicProfiles = functions
  .region('asia-south1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    /*
     * Owners only — and it now actually means that.
     *
     * The test was `['superadmin', 'admin'].includes(role)`, written against a
     * role vocabulary the CRM abandoned when each department gained an admin
     * and a member tier. It was wrong in both directions: it admitted the dead
     * legacy string `admin`, and it excluded every current `*_admin` role — so
     * the comment said "Owners only" while the code let a legacy document
     * through and refused `ops_admin`.
     *
     * `superadmin` IS the owner here: `crm_directory.CRM_ROLE` maps
     * `Role.OWNER` to it, and there is no `owner` string in `crmUsers`.
     * A full backfill rewrites every public profile on the platform, so it
     * stays owner-only rather than widening to department admins.
     */
    const crmSnap = await db.collection('crmUsers').doc(uid).get()
    if (normaliseCrmRole(crmSnap.get('role')) !== OWNER_ROLE) {
      throw new functions.https.HttpsError('permission-denied', 'Owners only.')
    }
    // P1-A3b: the role alone is true for a password-only sign-in. The Owner's
    // CURRENT Firebase sign-in must be bound to an MFA-verified API session.
    if (!(await ownerMfaVerified(db, uid, context.auth?.token as OwnerMfaToken | undefined))) {
      throw new functions.https.HttpsError('permission-denied',
        'Finish two-step sign-in in the CRM first, then try again.')
    }

    let written = 0
    let cursor: admin.firestore.QueryDocumentSnapshot | null = null

    for (;;) {
      let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(400)
      if (cursor) q = q.startAfter(cursor)
      const page = await q.get()
      if (page.empty) break

      const batch = db.batch()
      for (const doc of page.docs) {
        batch.set(
          db.collection('publicProfiles').doc(doc.id),
          // Backfill trusts the user flag for isLive, then the next
          // liveRooms write corrects it. Running this while someone is
          // broadcasting is the only case it gets wrong, and it self-heals.
          project(doc.id, doc.data() as Record<string, any>, (doc.data() as any).isLive === true),
          { merge: true },
        )
        written++
      }
      await batch.commit()

      cursor = page.docs[page.docs.length - 1]
      if (page.size < 400) break
    }

    functions.logger.info(`backfillPublicProfiles: wrote ${written} projections`)
    return { written }
  })
