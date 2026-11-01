import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { deriveRoleFlags } from './crmRoles'
import { assertActiveSession } from './mobileSession'

const db = admin.firestore()

/**
 * Counters that one account changes on another.
 *
 * Likes and role badges were written straight from the client onto someone
 * else's user document. That required a rule permitting any signed-in account
 * to modify `totalLikesReceived` on any other — and a rule shaped like that
 * cannot distinguish "Priya liked Anil" from "Anil gave himself 40,000 likes",
 * because both are the same write.
 *
 * These are not money, but likes drive the Hot tab and the recommendation
 * order, which decide who earns. A forgeable like count is a forgeable ranking.
 */

// ── toggleLike ───────────────────────────────────────────────────────────────

export const toggleLike = functions
  .region('asia-south1')
  .https.onCall(async (data: { targetUid: string; like: boolean }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')
    await assertActiveSession(uid, data, 'toggleLike', context.auth?.token)   // Phase 1A (SESSION-001/003)

    const targetUid = String(data?.targetUid ?? '')
    const like = data?.like !== false
    if (!targetUid) throw new functions.https.HttpsError('invalid-argument', 'targetUid is required.')
    if (targetUid === uid) {
      throw new functions.https.HttpsError('invalid-argument', 'You cannot like yourself.')
    }

    const meRef = db.collection('users').doc(uid)
    const targetRef = db.collection('users').doc(targetUid)
    const likedRef = meRef.collection('liked').doc(targetUid)
    const likedByRef = targetRef.collection('likedBy').doc(uid)

    return db.runTransaction(async (tx) => {
      const [meSnap, targetSnap, likedSnap] = await Promise.all([
        tx.get(meRef), tx.get(targetRef), tx.get(likedRef),
      ])
      if (!targetSnap.exists) throw new functions.https.HttpsError('not-found', 'That account no longer exists.')

      // The edge document is the source of truth, so the counter cannot drift.
      // The client version incremented unconditionally: tapping like twice —
      // or tapping it on a slow connection — added two.
      const alreadyLiked = likedSnap.exists
      if (like === alreadyLiked) {
        return { liked: alreadyLiked, changed: false }
      }

      const now = admin.firestore.FieldValue.serverTimestamp()
      const delta = like ? 1 : -1

      if (like) {
        const me = meSnap.data() ?? {}
        tx.set(likedRef, {
          uid: targetUid,
          name: targetSnap.get('name') ?? '',
          photoUrl: targetSnap.get('photoUrl') ?? '',
          likedAt: now,
        })
        tx.set(likedByRef, {
          uid,
          name: me.name ?? '',
          photoUrl: me.photoUrl ?? '',
          city: me.city ?? '',
          gender: me.gender ?? '',
          likedAt: now,
        })
      } else {
        tx.delete(likedRef)
        tx.delete(likedByRef)
      }

      tx.update(targetRef, { totalLikesReceived: admin.firestore.FieldValue.increment(delta) })
      tx.update(meRef, { totalLikesGiven: admin.firestore.FieldValue.increment(delta) })

      return { liked: like, changed: true }
    })
  })

// ── syncMyRoles ──────────────────────────────────────────────────────────────

/**
 * Stamp the caller's CRM role onto their user document, from `crmUsers/{uid}`.
 *
 * ── WHY THIS READS A DOCUMENT ID AND NOT A QUERY ─────────────────────────
 *
 * It used to query `verifiedIdentities` by the phone number and email on the
 * auth token, and match the result against a six-value list —
 * `['superadmin','admin','ops','tech','finance','support']`. Both halves were
 * wrong by the time anyone noticed.
 *
 * The list was three years stale. The CRM has had twelve department roles for
 * most of that time, so `ops_admin`, `finance_member`, `marketing_admin` and
 * nine others matched NOTHING: every one of those people opened the app as an
 * ordinary user with no badge, and `resolveIdentity` — which reads
 * `crmUsers/{uid}` and sees the real role — disagreed with this function on
 * every call.
 *
 * And matching on a phone string is not identity. `verifiedIdentities` is a
 * join table keyed on contact details, so it went stale the moment somebody
 * changed their number, and two people could not be told apart by it at all.
 *
 * `crmUsers/{uid}` is the authoritative record and it is keyed on the uid the
 * caller actually authenticated as. One source, one vocabulary, and it now
 * agrees with `resolveIdentity` by construction because they read the same
 * document.
 *
 * ── WHY THIS CAN NOW REVOKE ──────────────────────────────────────────────
 *
 * The old version was additive on the grounds that revoking a role is a CRM
 * action rather than a side effect of opening the app. That reasoning held
 * only because its source could not be trusted to mean "no role" — a query
 * that returned nothing might mean the person was demoted, or might mean
 * their phone number had changed.
 *
 * Reading the record by uid removes the ambiguity: an absent or inactive
 * `crmUsers/{uid}` IS the CRM saying this person has no role. Leaving a stale
 * OWNER badge on a departed owner's profile because only the CRM may remove
 * it was never the safer failure.
 */
export const syncMyRoles = functions
  .region('asia-south1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const [crmSnap, userSnap] = await Promise.all([
      db.collection('crmUsers').doc(uid).get(),
      db.collection('users').doc(uid).get(),
    ])

    const flags = deriveRoleFlags(
      crmSnap.get('role'),
      crmSnap.get('roles'),
      crmSnap.get('isActive') !== false,
      crmSnap.exists,
      crmSnap.get('roleStatus'),
      crmSnap.get('status'),
    )
    const { crmRole, isAgent, isSeller, isOfficial, held } = flags

    const next: Record<string, any> = { crmRole, isAgent, isSeller, isOfficial }

    // The person's OWN agency goes in `ownAgencyId`. `agencyId` means one
    // thing — the agency a HOST works under — and is never written with the
    // owner's own agency (that overload overwrote a Host's parent when they
    // became a Sub-agency). Identical to `crm_directory.app_role_patch`.
    const ownAgency = String(crmSnap.get('agencyId') ?? '').trim()
    const del = admin.firestore.FieldValue.delete()
    const currentOwn = String(userSnap.get('ownAgencyId') ?? '').trim()
    let ownChanged = false
    if (isAgent && ownAgency) {
      if (currentOwn !== ownAgency) { next.ownAgencyId = ownAgency; ownChanged = true }
    } else if (userSnap.get('ownAgencyId') !== undefined) {
      next.ownAgencyId = del; ownChanged = true
    }
    // One-off cleanup of the old overload: the person's own agency sitting in
    // `agencyId` on someone who is NOT a Host. A Host's agencyId is untouched.
    if (ownAgency && String(userSnap.get('agencyId') ?? '').trim() === ownAgency
        && userSnap.get('isHost') !== true) {
      next.agencyId = del; ownChanged = true
    }

    // Write only on a real difference. This runs on every sign-in, and an
    // unconditional write would fire the `users/{uid}` onWrite triggers —
    // `syncPhoneKey` among them — once per login for no reason.
    const changed = ownChanged || ['crmRole', 'isAgent', 'isSeller', 'isOfficial'].some((k) => {
      const before = userSnap.get(k)
      const v = next[k]
      return k === 'crmRole' ? String(before ?? '') !== v : (before === true) !== (v === true)
    })
    if (!changed) return { roles: held, changed: false }

    await db.collection('users').doc(uid).set(next, { merge: true })
    return { roles: held, changed: true }
  })
