/**
 * diagnose-referral.mjs
 *
 * Prints the real state behind "that application was not approved", so the
 * answer comes from the documents rather than from reasoning about them.
 *
 * The app shows that message for exactly one reason: `checkReferralCode`
 * returned `rejected`, which it does when the application's `status` field is
 * the string 'rejected'. Approving an `add_host` request is supposed to write
 * 'approved'. This shows which of those two is actually true, and — if the
 * approval never landed — whether the request was approved, is still sitting
 * pending, or failed with a reason recorded on it.
 *
 * Run from functions/:
 *     node scripts/diagnose-referral.mjs ABC123
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const serviceAccount = require('../../serviceAccountKey.json')

const code = (process.argv[2] ?? '').trim().toUpperCase()
if (!code) {
  console.error('Usage: node scripts/diagnose-referral.mjs <REFERRAL_CODE>')
  process.exit(1)
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
const db = admin.firestore()

/** Fields that decide whether a code works. Everything else is noise here. */
const INTERESTING = [
  'status', 'kycStatus', 'isActivated', 'activatedByUid',
  'referralCode', 'agencyId', 'agencyName', 'hostName',
  'applicantPhone', 'applicantEmail', 'callRate', '_approvedAt',
]

function show(label, value) {
  const rendered =
    value === undefined ? '(absent)'
    : value === null ? '(null)'
    : typeof value === 'object' && value?.toDate ? value.toDate().toISOString()
    : typeof value === 'object' ? JSON.stringify(value)
    : `${JSON.stringify(value)}  [${typeof value}]`
  console.log(`    ${label.padEnd(18)} ${rendered}`)
}

async function main() {
  const snap = await db.collection('hostApplications').where('referralCode', '==', code).get()

  if (snap.empty) {
    console.log(`\nNo hostApplications document has referralCode "${code}".`)
    console.log('The app would say "that referral code does not exist".')
    console.log('Codes are compared in UPPERCASE — check for a stored lowercase value.\n')
    return
  }

  console.log(`\n${snap.size} application(s) with referralCode "${code}"\n`)

  for (const doc of snap.docs) {
    console.log(`  hostApplications/${doc.id}`)
    const data = doc.data()
    INTERESTING.forEach((f) => show(f, data[f]))

    const status = data.status
    console.log('')
    if (status === 'rejected') {
      console.log('    >> THIS is what the app is reporting. status is "rejected".')
    } else if (status === 'approved') {
      console.log('    >> The application IS approved. A refusal now is not coming from status.')
    } else {
      console.log(`    >> status is ${JSON.stringify(status)} — neither "approved" nor "rejected".`)
      console.log('       checkReferralCode only refuses on "rejected", so this would still')
      console.log('       let the code through. If the app refused anyway, the DEPLOYED')
      console.log('       function is older than the source in this repo.')
    }
    if (data.isActivated === true) {
      console.log('    >> isActivated is true — the code has already been redeemed.')
    }

    // The approval request that should have flipped the status.
    const reqs = await db
      .collection('approvalRequests')
      .where('targetDocId', '==', doc.id)
      .get()
    console.log('')
    if (reqs.empty) {
      console.log('    No approvalRequests document targets this application.')
      console.log('    The invitation was written but the approval was never filed —')
      console.log('    exactly the orphan the agency-dashboard fix now cleans up.')
    } else {
      reqs.docs.forEach((r) => {
        const rd = r.data()
        console.log(`    approvalRequests/${r.id}`)
        show('type', rd.type)
        show('operation', rd.operation)
        show('status', rd.status)
        show('payload', rd.payload)
        show('error', rd.error ?? rd.failureReason ?? rd.reviewNotes)
        if (rd.status === 'approved' && data.status !== 'approved') {
          console.log('    >> The request was approved but the application did NOT change.')
          console.log('       onApprovalApproved either did not run or threw. Check the')
          console.log('       function logs for that request id.')
        }
      })
    }
    console.log('')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n', err.message)
    process.exit(1)
  })
