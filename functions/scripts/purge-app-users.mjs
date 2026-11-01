/**
 * purge-app-users.mjs — delete app users and hosts, keeping staff and partners.
 *
 * DRY RUN BY DEFAULT. It prints what it would delete and changes nothing until
 * you pass --confirm. There is no undo, so the default had to be the safe one.
 *
 *     node scripts/purge-app-users.mjs                          # show what would go
 *     node scripts/purge-app-users.mjs --confirm                # actually delete
 *     node scripts/purge-app-users.mjs --invitations --confirm  # …and clear
 *                                                               # un-redeemed host
 *                                                               # invitations too
 *
 * ── WHO SURVIVES ─────────────────────────────────────────────────────────────
 *
 * Anybody holding a `crmUsers` document: your owner login, every member of
 * staff, every agency owner and every coin seller. That is the same test
 * `isAppUser()` used to apply in the rules, and it is checked per account
 * rather than by role, so an account that is both a host and an agency owner is
 * KEPT — deleting it would take the agency's login with it.
 *
 * ── WHAT GOES, PER ACCOUNT ───────────────────────────────────────────────────
 *
 * The auth account, `users/{uid}` and its seven subcollections, the public
 * profile, host verification and application records, the agency roster row,
 * their live and party rooms, their calls and conversations, their uploaded
 * media, and their Mongo balances.
 *
 * The Firebase Auth account matters as much as the document: leave it and the
 * person signs straight back in, lands on profile setup, and writes a fresh
 * `users/{uid}` — so a "cleared" database refills itself.
 *
 * The Mongo `ledger` and `audit` collections are NOT touched. They are
 * append-only on purpose; a row referring to an account that no longer exists
 * is harmless, and a missing audit row is not.
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import readline from 'readline'
import { guardKeyScript, requireDataCanary } from './_keyScriptGuard.mjs'

const require = createRequire(import.meta.url)
// P0-10 (OPS-C): this key reaches a REAL project — named, acknowledged and (for
// a run that writes) confirmed before Firebase is initialised. See _keyScriptGuard.mjs.
const GUARDED_PROJECT = guardKeyScript('purge-app-users', {
  keyPath: new URL('../../serviceAccountKey.json', import.meta.url),
  writes: process.argv.includes('--confirm'),
})
const serviceAccount = require('../../serviceAccountKey.json')

const CONFIRM = process.argv.includes('--confirm')
/** Also clear un-redeemed invitations and orphaned verification records. */
const INVITATIONS = process.argv.includes('--invitations')
const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
})

const db = admin.firestore()
const auth = admin.auth()
const bucket = admin.storage().bucket()

/** Subcollections that hang off `users/{uid}`. */
const USER_SUBCOLLECTIONS = [
  'fcmTokens', 'diamondTransactions', 'beanTransactions',
  'blocked', 'followers', 'giftShowcase', 'notifications',
]

async function deleteQuery(query, label, counts) {
  const snap = await query.get()
  if (snap.empty) return
  counts[label] = (counts[label] ?? 0) + snap.size
  if (!CONFIRM) return
  // Batched in 400s — a batch caps at 500 writes and a recursive delete of a
  // document with subcollections costs more than one.
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch()
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref))
    await batch.commit()
  }
}

async function purgeUser(uid, counts, agencyIds) {
  const userRef = db.collection('users').doc(uid)

  for (const sub of USER_SUBCOLLECTIONS) {
    await deleteQuery(userRef.collection(sub), `users/*/${sub}`, counts)
  }

  // Keyed by uid, so addressed directly. These were queries filtering on
  // documentId(), which works but pays for a query to find one known document.
  for (const col of ['publicProfiles', 'hostVerification']) {
    const ref = db.collection(col).doc(uid)
    const snap = await ref.get()
    if (snap.exists) {
      counts[col] = (counts[col] ?? 0) + 1
      if (CONFIRM) await ref.delete().catch(() => undefined)
    }
  }

  await deleteQuery(db.collection('hostApplications').where('activatedByUid', '==', uid), 'hostApplications', counts)
  await deleteQuery(db.collection('liveRooms').where('hostUid', '==', uid), 'liveRooms', counts)
  await deleteQuery(db.collection('partyRooms').where('hostUid', '==', uid), 'partyRooms', counts)
  await deleteQuery(db.collection('calls').where('callerId', '==', uid), 'calls', counts)
  await deleteQuery(db.collection('calls').where('receiverId', '==', uid), 'calls', counts)
  await deleteQuery(db.collection('conversations').where('participants', 'array-contains', uid), 'conversations', counts)
  await deleteQuery(db.collection('withdrawalRequests').where('uid', '==', uid), 'withdrawalRequests', counts)
  await deleteQuery(db.collection('rechargeRequests').where('buyerUid', '==', uid), 'rechargeRequests', counts)

  /*
   * The agency roster row, under whichever agency recruited them.
   *
   * Addressed by path rather than searched for. A collection-group query
   * filtering on `documentId()` is rejected outright — inside a group query
   * that value has to be a full document path, and a bare uid is one segment
   * where Firestore wants an even number. Filtering on the `uid` FIELD would
   * work, but only for rows written since `writeAgencyMembership` started
   * setting it; a roster row predating that carries the uid in its id alone
   * and would be missed.
   *
   * The document id IS the host uid, so every agency is asked for that one
   * path. There are few agencies and this runs once, by hand.
   */
  for (const agency of agencyIds) {
    const ref = db.collection('agencies').doc(agency).collection('agencyHosts').doc(uid)
    const snap = await ref.get().catch(() => null)
    if (snap?.exists) {
      counts['agencyHosts'] = (counts['agencyHosts'] ?? 0) + 1
      if (CONFIRM) await ref.delete().catch(() => undefined)
    }
  }

  // Counted only when there IS one. Ten of these twelve are Firestore
  // documents whose auth account was already gone, and reporting twelve auth
  // deletions would have claimed work that did not happen.
  const hasAuth = await auth.getUser(uid).then(() => true).catch(() => false)

  if (CONFIRM) {
    await bucket.deleteFiles({ prefix: `profileMedia/${uid}/` }).catch(() => undefined)
    await userRef.delete().catch(() => undefined)
    if (hasAuth) await auth.deleteUser(uid).catch(() => undefined)
  }
  counts['users'] = (counts['users'] ?? 0) + 1
  if (hasAuth) counts['authAccounts'] = (counts['authAccounts'] ?? 0) + 1
}

/**
 * The path inside the bucket that a Firebase download URL points at.
 *
 * A KYC document is stored as `kyc/{agencyId}/applications/{file}` and handed
 * out as `…/o/kyc%2F{agencyId}%2F…?alt=media&token=…`. The object itself is not
 * deleted by removing the document that links to it, so without this the
 * Aadhaar card, PAN card and bank passbook stay in Storage after the
 * application is gone — readable by anyone holding the URL, because that token
 * never expires.
 */
function storagePathOf(url) {
  const m = /\/o\/([^?]+)/.exec(String(url ?? ''))
  return m ? decodeURIComponent(m[1]) : ''
}

/**
 * Invitations nobody redeemed, and the verification records behind them.
 *
 * Separate from the per-account purge on purpose. An un-redeemed invitation
 * belongs to the AGENCY that created it, not to any user account — that is why
 * deleting a user leaves it standing, and why `/hosts` still lists it under
 * "Invited" when every user document is gone. Removing somebody's outstanding
 * invitation is a different decision from removing an account, so it takes its
 * own flag.
 */
async function purgeInvitations(counts) {
  const apps = await db.collection('hostApplications').get()
  const unredeemed = apps.docs.filter((d) => !String(d.get('activatedByUid') ?? '').trim())

  if (unredeemed.length === 0) {
    console.log('\nNo un-redeemed host invitations.\n')
  } else {
    console.log(`\n${CONFIRM ? 'Deleting' : 'Would delete'} ${unredeemed.length} un-redeemed invitation(s):`)
    for (const d of unredeemed) {
      console.log(`  ${d.get('hostName') ?? '(no name)'}  ${d.get('applicantEmail') ?? ''}  code ${d.get('referralCode') ?? '—'}`)

      // The uploaded documents go with the record that pointed at them.
      const urls = [
        ...((d.get('kycDocUrls') ?? [])),
        d.get('photoUrl'),
      ].filter(Boolean)
      for (const url of urls) {
        const path = storagePathOf(url)
        if (!path) continue
        counts['kyc files'] = (counts['kyc files'] ?? 0) + 1
        if (CONFIRM) await bucket.file(path).delete().catch(() => undefined)
      }

      counts['hostApplications'] = (counts['hostApplications'] ?? 0) + 1
      if (CONFIRM) await d.ref.delete().catch(() => undefined)
    }
  }

  // Verification records whose account no longer exists.
  const vers = await db.collection('hostVerification').get()
  for (const v of vers.docs) {
    const user = await db.collection('users').doc(v.id).get()
    if (user.exists) continue
    counts['hostVerification'] = (counts['hostVerification'] ?? 0) + 1
    if (CONFIRM) await v.ref.delete().catch(() => undefined)
  }

  /*
   * `add_host` approval requests pointing at an application that is gone.
   *
   * A different collection, which is why deleting the invitation left one
   * behind reading "rejected" on the approvals queue — it looks like a host was
   * turned down, and there is no longer a host or an application for it to be
   * about. They are doubly dead: nothing creates them any more, and
   * `onApprovalApproved` refuses the type outright, so one can never be acted
   * on either.
   *
   * Only the ORPHANED ones. A request whose application still exists is left
   * alone — it is a record of something an agency asked for about a record that
   * is still there, and this flag is for clearing what the invitation left
   * behind, not for pruning the queue.
   */
  const reqs = await db.collection('approvalRequests').where('type', '==', 'add_host').get()
  for (const r of reqs.docs) {
    const target = String(r.get('targetDocId') ?? '').trim()
    if (target) {
      const app = await db.collection('hostApplications').doc(target).get()
      if (app.exists) continue
    }
    counts['approvalRequests (add_host)'] = (counts['approvalRequests (add_host)'] ?? 0) + 1
    if (CONFIRM) await r.ref.delete().catch(() => undefined)
  }
}

async function main() {
  console.log(CONFIRM
    ? '\n*** LIVE RUN — this deletes data permanently ***\n'
    : '\nDRY RUN — nothing will be changed. Re-run with --confirm to delete.\n')
  // P0-10: a live run needs this project's data canary before anything is read for deletion.
  if (CONFIRM) await requireDataCanary('purge-app-users', db, GUARDED_PROJECT)

  // Everybody with a CRM login is spared, checked by uid rather than by role.
  const crmSnap = await db.collection('crmUsers').select().get()
  const spared = new Set(crmSnap.docs.map((d) => d.id))
  console.log(`${spared.size} account(s) hold a crmUsers document and will be KEPT.`)

  const usersSnap = await db.collection('users').select('name', 'isHost').get()
  const targets = usersSnap.docs.filter((d) => !spared.has(d.id))

  console.log(`${usersSnap.size} user document(s) total; ${targets.length} to delete.\n`)

  // The sign-in identifier for each, so this list can be read straight against
  // the Firebase console's Authentication tab. A uid alone is unreadable, and
  // "which of these six is my owner account" is exactly the question somebody
  // needs answered before typing DELETE.
  const KEPT = []
  for (const uid of spared) {
    const rec = await auth.getUser(uid).catch(() => null)
    if (rec) KEPT.push(`  KEEP    ${rec.email ?? rec.phoneNumber ?? '(no identifier)'}`)
  }
  if (KEPT.length) {
    console.log('Kept — these hold a crmUsers document:')
    KEPT.sort().forEach((l) => console.log(l))
    console.log('')
  }

  if (targets.length === 0) {
    console.log('No user documents to delete.')
    if (INVITATIONS) {
      const counts = {}
      await purgeInvitations(counts)
      Object.entries(counts).sort().forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`))
    } else {
      console.log('Pass --invitations to also clear un-redeemed host invitations.')
    }
    console.log('')
    return
  }

  console.log('To be deleted:')
  for (const d of targets.slice(0, 50)) {
    const rec = await auth.getUser(d.id).catch(() => null)
    const who = rec?.email ?? rec?.phoneNumber ?? '(no auth account)'
    console.log(`  DELETE  ${who.padEnd(32)} ${d.get('isHost') === true ? '[host] ' : ''}${d.get('name') ?? ''}`)
  }
  if (targets.length > 50) console.log(`  …and ${targets.length - 50} more`)

  if (CONFIRM) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((r) =>
      rl.question(`\nType DELETE to remove these ${targets.length} accounts permanently: `, r))
    rl.close()
    if (answer.trim() !== 'DELETE') {
      console.log('Not confirmed. Nothing was deleted.\n')
      return
    }
  }

  // Read once, not per account: the roster row is looked up by path under
  // every agency, and there is no reason to re-list them twelve times.
  const agenciesSnap = await db.collection('agencies').select().get()
  const agencyIds = agenciesSnap.docs.map((d) => d.id)

  const counts = {}
  let done = 0
  for (const d of targets) {
    await purgeUser(d.id, counts, agencyIds)
    if (++done % 25 === 0) console.log(`  …${done}/${targets.length}`)
  }

  if (INVITATIONS) await purgeInvitations(counts)

  console.log(`\n${CONFIRM ? 'Deleted' : 'Would delete'}:`)
  Object.entries(counts).sort().forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`))
  console.log(
    CONFIRM
      ? '\nFirebase done. Now run the Mongo half:\n' +
        '  cd backend && .venv/bin/python -m scripts.purge_app_balances --confirm\n'
      : '\nRe-run with --confirm to apply, then do the Mongo half.\n',
  )
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\n', err)
  process.exit(1)
})
