/**
 * firestore.rules — Phase 1A regression tests, against the Firestore emulator.
 *
 * One section per finding. Each `no(...)` is an exploit path that worked before
 * Phase 1A; each `ok(...)` is the legitimate flow that must keep working next
 * to it, so a rule that "fixes" a hole by refusing everything fails here too.
 *
 *   IDENTITY-002  users: delete-and-recreate; create is an allowlist
 *   CONTACT-001   users: typed email / phone never land from a client
 *   SECURITY-004  users: staff cannot write role / partner / level state
 *   SECURITY-002  hostApplications: no self-approval, no forged code / agency
 *   SECURITY-003  agencies / sellers: guests cannot create partner records
 *   SECURITY-005  agencies: staff cannot approve or re-point owners from a browser
 *   STAFF-001/2/3 crmUsers: Owner browser cannot mint Owners or change roles
 *   AUTH-001      guestUidBindings: server-only
 *   (role revocation) a revoked agency role loses its rule-level authority
 *   B3 (Phase 1A.2) server-owned data: hostKyc, platformRevenue, platformStats,
 *                 kycSubmissions, users/{uid}/likedBy, liveRooms/{id}/gifts
 *   B4 (Phase 1A.2) partner edits: bank details and governance (GOV-4);
 *                 revoked sellers' own-record edits (FIN-7)
 *   B5 (Phase 1A.2) approvalRequests: only the four filed shapes; decided
 *                 once, by an Owner who did not file it (GOV-1)
 *
 * ZIPPER_RULES_FILE=<path> runs the same checks against another rules file —
 * used once per batch, against a copy of the rules as they were BEFORE the
 * batch (kept outside the repository), to show its new `no(...)` checks fail
 * there. Unset, the suite tests the repository's firestore.rules.
 *
 * Run (needs Java 21 + firebase CLI):
 *     cd tests && npm install          # once
 *     cd .. && firebase emulators:exec --only firestore \
 *                --project zipper-83816 "node tests/firestore.phase1a.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
console.log(`rules under test: ${RULES_PATH}`)

let checks = 0
let failures = 0
const failed = []
async function expect(claim, promise, shouldPass) {
  checks += 1
  try {
    await (shouldPass ? assertSucceeds(promise) : assertFails(promise))
  } catch (err) {
    failures += 1
    failed.push(claim)
    console.error(`  FAIL  ${claim}\n        ${String(err.message ?? err).split('\n')[0]}`)
  }
}
const ok = (c, p) => expect(c, p, true)
const no = (c, p) => expect(c, p, false)

const testEnv = await initializeTestEnvironment({
  projectId: 'zipper-83816',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
})
await testEnv.clearFirestore()

async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), path), data)
  })
}
const handles = new Map()
function fs(ctx) {
  if (!handles.has(ctx)) handles.set(ctx, ctx.firestore())
  return handles.get(ctx)
}
const D = (ctx, path) => doc(fs(ctx), path)
const ctx = (uid, token = {}) => testEnv.authenticatedContext(uid, token)

// ── The cast ────────────────────────────────────────────────────────────────
const PHONE = '+919800000001'
const EMAIL = 'pat@example.test'

// A phone-OTP user (verified phone, no email) and a Google user (verified email).
const phoneUser = ctx('uidPhone', { phone_number: PHONE, firebase: { sign_in_provider: 'phone' } })
const googleUser = ctx('uidGoogle', { email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'google.com' } })
// An anonymous guest: no phone, no email on the token.
const guest = ctx('uidGuest', { firebase: { sign_in_provider: 'anonymous' } })
const bannedUser = ctx('uidBanned', { phone_number: '+919800000009', firebase: { sign_in_provider: 'phone' } })

await seed('crmUsers/uidOps', { uid: 'uidOps', role: 'ops_admin', isActive: true, status: 'approved' })
await seed('crmUsers/uidOwner1', { uid: 'uidOwner1', role: 'superadmin', isActive: true, status: 'approved' })
await seed('crmUsers/uidOwner2', { uid: 'uidOwner2', role: 'superadmin', isActive: true, status: 'approved' })
await seed('crmUsers/uidMember', { uid: 'uidMember', role: 'support_member', isActive: true, status: 'approved' })
const opsAdmin = ctx('uidOps', { email: 'ops@zipper.test', email_verified: true })
const owner1 = ctx('uidOwner1', { email: 'o1@zipper.test', email_verified: true })
const member = ctx('uidMember', { email: 'm@zipper.test', email_verified: true })

// ════════════════════════════════════════════════════════════════════════════
console.log('IDENTITY-002 / CONTACT-001 — users create is an allowlist')
// ════════════════════════════════════════════════════════════════════════════
const BASE = (uid, over = {}) => ({
  uid, name: '', photoUrl: '', phoneNumber: '', isProfileComplete: false,
  createdAt: new Date(), lastSeen: Date.now(), ...over,
})

await ok('createUserDocument shape with the VERIFIED token phone is accepted',
  setDoc(D(phoneUser, 'users/uidPhone'), BASE('uidPhone', { phoneNumber: PHONE })))
await ok('saveUserProfile set(merge) shape on a missing doc, verified email',
  setDoc(D(googleUser, 'users/uidGoogle'), {
    name: 'Pat', gender: 'f', dob: 1, age: 30, city: 'x', country: 'IN', languages: [],
    email: EMAIL, phoneNumber: '', bio: '', isProfileComplete: true, isOnline: true, lastSeen: 1,
  }))
for (const [field, value] of [
  ['accountState', 'active'], ['isSuspended', false], ['crmRole', 'superadmin'],
  ['isOfficial', true], ['credentialsValidAfter', 0], ['activeMobileSession', 'S'],
  ['deviceId', 'D'], ['phoneKey', '919800000001'], ['isBanned', false], ['diamonds', 9],
  ['isHost', true], ['isVerifiedHost', true], ['phone', PHONE],
]) {
  await no(`a client cannot create its user doc carrying ${field}`,
    setDoc(D(guest, 'users/uidGuest'), BASE('uidGuest', { [field]: value })))
}
await no('a TYPED email that is not on the token is refused at create',
  setDoc(D(phoneUser, 'users/uidPhoneB'), BASE('uidPhoneB', { email: 'victim@example.test' })))
await no('a TYPED phone that is not on the token is refused at create',
  setDoc(D(googleUser, 'users/uidGoogleB'), BASE('uidGoogleB', { phoneNumber: '+919811111111' })))
await no('nobody creates somebody else\'s user doc', setDoc(D(guest, 'users/uidOther'), BASE('uidOther')))
await no('staff cannot create a user doc from a browser',
  setDoc(D(opsAdmin, 'users/uidMadeByStaff'), BASE('uidMadeByStaff')))

// ════════════════════════════════════════════════════════════════════════════
console.log('IDENTITY-002 — delete-and-recreate is closed')
// ════════════════════════════════════════════════════════════════════════════
await seed('users/uidBanned', { uid: 'uidBanned', name: 'B', isBanned: true, isProfileComplete: true })
await no('a banned account cannot delete its own user doc', deleteDoc(D(bannedUser, 'users/uidBanned')))
await seed('users/uidSusp', { uid: 'uidSusp', isSuspended: true, isProfileComplete: false })
await no('a suspended half-made account cannot delete it either',
  deleteDoc(D(ctx('uidSusp', { phone_number: '+919800000010' }), 'users/uidSusp')))
await seed('users/uidDel', { uid: 'uidDel', accountState: 'deletion_requested', isProfileComplete: false })
await no('an account in deletion cannot delete its doc to escape the window',
  deleteDoc(D(ctx('uidDel', { phone_number: '+919800000011' }), 'users/uidDel')))
await seed('users/uidDone', { uid: 'uidDone', isProfileComplete: true })
await no('a completed profile cannot be deleted from the client',
  deleteDoc(D(ctx('uidDone', { phone_number: '+919800000012' }), 'users/uidDone')))
await seed('users/uidCrm', { uid: 'uidCrm', isProfileComplete: false })
await seed('crmUsers/uidCrm', { uid: 'uidCrm', role: 'agency', isActive: true })
await no('a CRM-provisioned half-made account cannot be deleted from the app',
  deleteDoc(D(ctx('uidCrm', { email: 'crm@example.test' }), 'users/uidCrm')))
await seed('users/uidAbandon', { uid: 'uidAbandon', isProfileComplete: false, name: '' })
await no('staff cannot delete a user doc', deleteDoc(D(opsAdmin, 'users/uidAbandon')))
await no('an Owner cannot delete a user doc from a browser', deleteDoc(D(owner1, 'users/uidAbandon')))
await ok('abandonSignup: a clean half-made signup may still be discarded by its owner',
  deleteDoc(D(ctx('uidAbandon', { phone_number: '+919800000013' }), 'users/uidAbandon')))

// ════════════════════════════════════════════════════════════════════════════
console.log('CONTACT-001 / IDENTITY-002 — owner updates')
// ════════════════════════════════════════════════════════════════════════════
await seed('users/uidPhone', BASE('uidPhone', { phoneNumber: PHONE, isProfileComplete: true }))
await ok('the owner still edits ordinary profile fields',
  updateDoc(D(phoneUser, 'users/uidPhone'), { name: 'Pat', bio: 'hi', city: 'Pune' }))
await no('the owner cannot write a typed email',
  updateDoc(D(phoneUser, 'users/uidPhone'), { email: 'victim@example.test' }))
await no('the owner cannot change phoneNumber to a number not on the token',
  updateDoc(D(phoneUser, 'users/uidPhone'), { phoneNumber: '+919822222222' }))
await no('the owner cannot write the legacy `phone` field',
  updateDoc(D(phoneUser, 'users/uidPhone'), { phone: '+919822222222' }))
await seed('users/uidGoogle', BASE('uidGoogle', { email: '' }))
await ok('the owner may record the verified email that is on the token',
  updateDoc(D(googleUser, 'users/uidGoogle'), { email: EMAIL }))
for (const [field, value] of [
  ['accountState', 'active'], ['isSuspended', false], ['suspendedUntil', null],
  ['crmRole', 'superadmin'], ['isOfficial', true], ['isVerifiedHost', true],
  ['credentialsValidAfter', 0], ['activeMobileSession', 'X'], ['isDeleted', false],
  ['isHost', true], ['agencyId', 'AG1'], ['uid', 'someoneElse'],
]) {
  await no(`the owner cannot write ${field}`, updateDoc(D(phoneUser, 'users/uidPhone'), { [field]: value }))
}

// ════════════════════════════════════════════════════════════════════════════
console.log('SECURITY-004 / ROLE-001 — staff browser writes to users')
// ════════════════════════════════════════════════════════════════════════════
await seed('users/uidTarget', BASE('uidTarget', { isProfileComplete: true }))
for (const [field, value] of [
  ['isHost', true], ['isSeller', true], ['agencyId', 'AG1'], ['level', 50],
  ['callRateBeans', 2400], ['crmRole', 'superadmin'], ['isOfficial', true],
  ['email', 'x@example.test'], ['phoneNumber', '+919833333333'], ['phone', '+1'],
  ['credentialsValidAfter', 0], ['accountState', 'active'],
]) {
  await no(`an ops admin cannot write ${field} on a user`,
    updateDoc(D(opsAdmin, 'users/uidTarget'), { [field]: value }))
}
await no('an Owner cannot make a host from the browser either',
  updateDoc(D(owner1, 'users/uidTarget'), { isHost: true }))
await ok('staff can still write a non-protected field (warnings)',
  updateDoc(D(opsAdmin, 'users/uidTarget'), { warnings: 1 }))

// ════════════════════════════════════════════════════════════════════════════
console.log('SECURITY-002 — host applications: no self-approval')
// ════════════════════════════════════════════════════════════════════════════
await seed('agencies/AG1', { agencyName: 'One', referralCode: 'ONE111', status: 'approved', isActive: true })
await seed('agencies/AG2', { agencyName: 'Two', referralCode: 'TWO222', status: 'approved', isActive: true })
await seed('hostApplications/HA_SELF', {
  applicantUid: 'uidPhone', agencyId: 'AG1', referralCode: 'ONE111', status: 'pending',
  kycStatus: 'submitted', isActivated: false, photoUrl: 'a', source: 'self_app',
})
await no('the applicant cannot set status approved on their own application',
  updateDoc(D(phoneUser, 'hostApplications/HA_SELF'), { status: 'approved' }))
await no('…nor forge the referral code',
  updateDoc(D(phoneUser, 'hostApplications/HA_SELF'), { referralCode: 'TWO222' }))
await no('…nor move it to another agency',
  updateDoc(D(phoneUser, 'hostApplications/HA_SELF'), { agencyId: 'AG2' }))
await no('…nor write a decision stamp',
  updateDoc(D(phoneUser, 'hostApplications/HA_SELF'), { decidedByUid: 'uidPhone', decidedAt: new Date() }))
await no('…nor even an innocuous field (the applicant arm is gone; the API edits)',
  updateDoc(D(phoneUser, 'hostApplications/HA_SELF'), { photoUrl: 'b' }))
await no('an admin cannot approve from the browser (decision is the API)',
  updateDoc(D(opsAdmin, 'hostApplications/HA_SELF'), { status: 'approved', kycStatus: 'approved' }))
await no('an Owner cannot approve from the browser either',
  updateDoc(D(owner1, 'hostApplications/HA_SELF'), { status: 'approved', decidedByUid: 'uidOwner1' }))
await no('an admin cannot reassign the agency',
  updateDoc(D(opsAdmin, 'hostApplications/HA_SELF'), { agencyId: 'AG2' }))
await ok('an admin can still edit a non-decision field (call rate)',
  updateDoc(D(opsAdmin, 'hostApplications/HA_SELF'), { callRate: 300 }))

// ════════════════════════════════════════════════════════════════════════════
console.log('AUTH-002 / SECURITY-003 — guests cannot create partner records')
// ════════════════════════════════════════════════════════════════════════════
const AGENCY = (over = {}) => ({
  agencyName: 'G', ownerEmail: 'g@example.test', type: 'main', status: 'pending',
  kycStatus: 'pending', isActive: false, source: 'self_app', ...over,
})
// FX-06 / approved contact rule: a client create may carry only the public
// signup's source, `self_signup` (which the registration path holds to the full
// application eligibility). `self_app` — what the API writes for the app's own
// applications, and what the trigger skips — is the Admin SDK's alone. This
// file's fixture is used both for client creates and for admin seeds, so the
// client creates below set the source explicitly.
const SIGNUP = { source: 'self_signup' }
await no('a guest cannot create an agency', setDoc(D(guest, 'agencies/AG_GUEST'), AGENCY({ ownerUid: 'uidGuest', ...SIGNUP })))
await ok('a phone-verified user can apply (pending, naming themselves)',
  setDoc(D(phoneUser, 'agencies/AG_PHONE'), AGENCY({ ownerUid: 'uidPhone', ...SIGNUP })))
await no('FX-06: …but not with the API\'s own `self_app` source (no registration bypass)',
  setDoc(D(phoneUser, 'agencies/AG_PHONE_SELFAPP'), AGENCY({ ownerUid: 'uidPhone' })))
await no('FX-06: …nor with no source at all',
  setDoc(D(phoneUser, 'agencies/AG_PHONE_NOSRC'), AGENCY({ ownerUid: 'uidPhone', source: '' })))
await no('…but not pre-approved',
  setDoc(D(phoneUser, 'agencies/AG_PHONE2'), AGENCY({ ownerUid: 'uidPhone', status: 'approved', isActive: true, ...SIGNUP })))
await no('…nor naming another human as owner',
  setDoc(D(phoneUser, 'agencies/AG_PHONE3'), AGENCY({ ownerUid: 'uidGoogle', ...SIGNUP })))
await no('a guest cannot create a seller',
  setDoc(D(guest, 'sellers/uidGuest'), { displayName: 'G', status: 'pending', isActive: false, isApproved: false, ownerUid: 'uidGuest' }))
await no('a guest cannot file a coin purchase request',
  setDoc(D(guest, 'coinPurchaseRequests/CP1'), { sellerUid: 'uidGuest', status: 'pending', amount: 1 }))

// ════════════════════════════════════════════════════════════════════════════
console.log('SECURITY-005 — staff browser cannot approve partners or re-point owners')
// ════════════════════════════════════════════════════════════════════════════
await seed('agencies/AG_LINKED', AGENCY({ crmUid: 'uidA', ownerUid: 'uidA' }))
await no('admin cannot approve an agency from the browser',
  updateDoc(D(opsAdmin, 'agencies/AG_LINKED'), { status: 'approved', isActive: true }))
await no('admin cannot re-point crmUid', updateDoc(D(opsAdmin, 'agencies/AG_LINKED'), { crmUid: 'uidB' }))
await no('admin cannot re-point ownerUid', updateDoc(D(opsAdmin, 'agencies/AG_LINKED'), { ownerUid: 'uidB' }))
await no('admin cannot rewrite the referral code', updateDoc(D(opsAdmin, 'agencies/AG_LINKED'), { referralCode: 'NEW999' }))

// ════════════════════════════════════════════════════════════════════════════
console.log('STAFF-001/002/003 — crmUsers from an Owner browser')
// ════════════════════════════════════════════════════════════════════════════
await no('an Owner cannot create another Owner from the browser',
  setDoc(D(owner1, 'crmUsers/uidNewOwner'), { uid: 'uidNewOwner', role: 'superadmin', isActive: true }))
await no('an Owner cannot create a department admin from the browser (POST /staff)',
  setDoc(D(owner1, 'crmUsers/uidNewAdmin'), { uid: 'uidNewAdmin', role: 'ops_admin', isActive: true }))
await no('an Owner cannot change another Owner',
  updateDoc(D(owner1, 'crmUsers/uidOwner2'), { isActive: false }))
await no('an Owner cannot change its own role',
  updateDoc(D(owner1, 'crmUsers/uidOwner1'), { role: 'ops_admin' }))
await no('an Owner cannot change a member\'s role from the browser',
  updateDoc(D(owner1, 'crmUsers/uidMember'), { role: 'support_admin' }))
await no('an Owner cannot give a staff member a partner role',
  updateDoc(D(owner1, 'crmUsers/uidMember'), { roles: ['agency'], roleStatus: { agency: 'approved' } }))
await no('an Owner cannot delete an Owner', deleteDoc(D(owner1, 'crmUsers/uidOwner2')))
await no('an Owner cannot delete a member', deleteDoc(D(owner1, 'crmUsers/uidMember')))
await no('a member cannot change its own role',
  updateDoc(D(member, 'crmUsers/uidMember'), { role: 'support_admin' }))
await ok('an Owner can still update its own lastLoginAt',
  updateDoc(D(owner1, 'crmUsers/uidOwner1'), { lastLoginAt: new Date() }))

// Phase 1A validation fix — the Owner's first-login security gate
// (`saveGateAnswers`, zipper-crm/lib/auth.ts) writes the Owner's OWN
// crmUsers.gateAnswers. The tightened superadmin arm had stopped it.
await seed('crmUsers/uidOwnerGate', { uid: 'uidOwnerGate', role: 'superadmin', isActive: true, status: 'approved' })
const ownerGate = ctx('uidOwnerGate', { email: 'og@zipper.test', email_verified: true })
const GATE = { q1: 'full name', q2: '+919800000000', q3: 'called name' }
await no('an Owner cannot set gate answers together with another field',
  updateDoc(D(ownerGate, 'crmUsers/uidOwnerGate'), { gateAnswers: GATE, role: 'superadmin', dept: 'x' }))
await ok('an Owner with no gate answers can set its own (first-login setup)',
  updateDoc(D(ownerGate, 'crmUsers/uidOwnerGate'), { gateAnswers: GATE }))
await no('…but cannot overwrite them once set',
  updateDoc(D(ownerGate, 'crmUsers/uidOwnerGate'), { gateAnswers: { q1: 'a', q2: 'b', q3: 'c' } }))
await no('an Owner cannot set ANOTHER Owner\'s gate answers',
  updateDoc(D(owner1, 'crmUsers/uidOwner2'), { gateAnswers: GATE }))
await no('a department member cannot set its own gate answers',
  updateDoc(D(member, 'crmUsers/uidMember'), { gateAnswers: GATE }))

// ════════════════════════════════════════════════════════════════════════════
console.log('Role revocation — a revoked agency role keeps no rule authority')
// ════════════════════════════════════════════════════════════════════════════
await seed('crmUsers/uidRevoked', {
  uid: 'uidRevoked', role: 'agency', roles: ['agency'], agencyId: 'AG1', isActive: true,
  roleStatus: { agency: 'revoked' },
})
const revoked = ctx('uidRevoked', { email: 'rev@example.test', email_verified: true })
await no('a revoked agency login cannot invite hosts for its old agency',
  setDoc(D(revoked, 'hostApplications/HA_REV'), {
    agencyId: 'AG1', referralCode: 'ONE111', status: 'pending', isActivated: false, kycStatus: 'submitted',
  }))
await no('…nor read its old agency\'s applications',
  getDoc(D(revoked, 'hostApplications/HA_SELF')))

await seed('crmUsers/uidOddStatus', {
  uid: 'uidOddStatus', role: 'agency', roles: ['agency'], agencyId: 'AG1', isActive: true,
  roleStatus: { agency: 'disabled' },
})
await no('an UNKNOWN per-role status (allowlist) also loses agency authority',
  setDoc(D(ctx('uidOddStatus', { email: 'odd@example.test', email_verified: true }), 'hostApplications/HA_ODD'), {
    agencyId: 'AG1', referralCode: 'ONE111', status: 'pending', isActivated: false, kycStatus: 'submitted',
  }))
await seed('crmUsers/uidAgencyLive', {
  uid: 'uidAgencyLive', role: 'agency', roles: ['agency'], agencyId: 'AG1', isActive: true,
  roleStatus: { agency: 'approved' },
})
await ok('a LIVE agency login can still invite a host with its real code',
  setDoc(D(ctx('uidAgencyLive', { email: 'live@example.test', email_verified: true }), 'hostApplications/HA_LIVE'), {
    agencyId: 'AG1', referralCode: 'ONE111', status: 'pending', isActivated: false, kycStatus: 'submitted',
  }))

// Seller capability revoked on a dual login, and a revoked seller record.
await seed('sellers/SL_REV', { crmUid: 'uidSellerRev', status: 'approved', isActive: true })
await seed('crmUsers/uidSellerRev', {
  uid: 'uidSellerRev', role: 'agency', roles: ['agency', 'seller'], isActive: true,
  roleStatus: { agency: 'approved', seller: 'revoked' }, sellerId: 'SL_REV',
})
await no('a login whose SELLER role is revoked cannot file a coin purchase',
  setDoc(D(ctx('uidSellerRev', { email: 'sr@example.test', email_verified: true }), 'coinPurchaseRequests/CP_REV'),
    { sellerUid: 'SL_REV', status: 'pending', amount: 1 }))
await seed('sellers/SL_SUSP', { crmUid: 'uidSellerSusp', status: 'suspended', isActive: false })
await seed('crmUsers/uidSellerSusp', { uid: 'uidSellerSusp', role: 'seller', isActive: true, sellerId: 'SL_SUSP' })
await no('a SUSPENDED seller record files nothing new',
  setDoc(D(ctx('uidSellerSusp', { email: 'ss@example.test', email_verified: true }), 'coinPurchaseRequests/CP_SUSP'),
    { sellerUid: 'SL_SUSP', status: 'pending', amount: 1 }))
await seed('sellers/SL_OK', { crmUid: 'uidSellerOk', status: 'approved', isActive: true })
await seed('crmUsers/uidSellerOk', { uid: 'uidSellerOk', role: 'seller', isActive: true, sellerId: 'SL_OK',
  roleStatus: { seller: 'approved' } })
await ok('an approved seller still can',
  setDoc(D(ctx('uidSellerOk', { email: 'so@example.test', email_verified: true }), 'coinPurchaseRequests/CP_OK'),
    { sellerUid: 'SL_OK', status: 'pending', amount: 1 }))

// ════════════════════════════════════════════════════════════════════════════
console.log('AUTH-001 — guestUidBindings is server-only')
// ════════════════════════════════════════════════════════════════════════════
await seed('guestUidBindings/uidGuest', { deviceId: 'D1' })
await no('a client cannot read the reverse binding', getDoc(D(guest, 'guestUidBindings/uidGuest')))
await no('a client cannot write one', setDoc(D(guest, 'guestUidBindings/uidX'), { deviceId: 'D2' }))

// ════════════════════════════════════════════════════════════════════════════
console.log('SESSION-001/003 — chat and call messages need an active, unrestricted session')
// ════════════════════════════════════════════════════════════════════════════
const MSG = (from) => ({ senderUid: from, text: 'hi', timestamp: new Date() })
await seed('users/uidChatA', { uid: 'uidChatA', credentialsValidAfter: 2000 })
await seed('users/uidChatB', { uid: 'uidChatB', credentialsValidAfter: 0 })
const chatCurrent = ctx('uidChatA', { phone_number: '+919800000101', auth_time: 2000 })
const chatDisplaced = ctx('uidChatA', { phone_number: '+919800000101', auth_time: 1500 })
await ok('the current session can send a chat message',
  setDoc(D(chatCurrent, 'conversations/uidChatA_uidChatB/messages/m1'), MSG('uidChatA')))
await no('a DISPLACED session (older auth_time) cannot',
  setDoc(D(chatDisplaced, 'conversations/uidChatA_uidChatB/messages/m2'), MSG('uidChatA')))
await no('…nor open a new conversation',
  setDoc(D(chatDisplaced, 'conversations/uidChatA_uidChatC'), { participants: ['uidChatA', 'uidChatC'] }))
for (const [label, fields] of [
  ['suspended', { isSuspended: true, isBanned: true, accountState: 'suspended' }],
  ['banned', { isBanned: true, accountState: 'banned' }],
  ['deletion-pending', { isDeleted: true, accountState: 'recovery_pending' }],
]) {
  await seed('users/uidChatR', { uid: 'uidChatR', credentialsValidAfter: 0, ...fields })
  await no(`a ${label} account cannot send chat`,
    setDoc(D(ctx('uidChatR', { phone_number: '+919800000102', auth_time: 3000 }),
      `conversations/uidChatB_uidChatR/messages/${label}`), MSG('uidChatR')))
}
await seed('calls/CALL1', { callerId: 'uidChatA', receiverId: 'uidChatB' })
await ok('a call participant on the current session can message in the call',
  setDoc(D(chatCurrent, 'calls/CALL1/messages/c1'), MSG('uidChatA')))
await no('a displaced device cannot',
  setDoc(D(chatDisplaced, 'calls/CALL1/messages/c2'), MSG('uidChatA')))

// ════════════════════════════════════════════════════════════════════════════
console.log('B3 — server-owned data: clients cannot write it (RULES-1/2/3/4/5)')
// ════════════════════════════════════════════════════════════════════════════
// Every `no` below is a write that SUCCEEDED before B3 — run this file with
// ZIPPER_RULES_FILE pointing at the pre-B3 rules to see each one fail. Every
// `ok` is a read or write the app, the CRM or staff still need.
const stranger = ctx('uidStranger', { phone_number: '+919800000201', firebase: { sign_in_provider: 'phone' } })

// RULES-1 — hostKyc: staff admins write it; a host's agencyId no longer opens
// it to every signed-in account.
// Separate documents for the overwrite, the delete and the create, so that in
// the pre-B3 run (where each of them succeeds) one cannot mask another.
await seed('users/uidKycHost', { uid: 'uidKycHost', agencyId: 'AG_KYC' })
await seed('users/uidKycHost2', { uid: 'uidKycHost2', agencyId: 'AG_KYC' })
await seed('users/uidKycHost3', { uid: 'uidKycHost3', agencyId: 'AG_KYC' })
await seed('hostKyc/uidKycHost', { accountNumber: '000111222', ifscCode: 'ZIPR0000001' })
await seed('hostKyc/uidKycHost3', { accountNumber: '333444555', ifscCode: 'ZIPR0000003' })
const kycHost = ctx('uidKycHost', { phone_number: '+919800000202', firebase: { sign_in_provider: 'phone' } })
await no('RULES-1: any signed-in account cannot overwrite a host\'s KYC/bank document',
  setDoc(D(stranger, 'hostKyc/uidKycHost'), { accountNumber: '999999999' }))
await no('RULES-1: …nor change one field of it',
  updateDoc(D(stranger, 'hostKyc/uidKycHost'), { ifscCode: 'EVIL0000001' }))
await no('RULES-1: …nor delete one',
  deleteDoc(D(stranger, 'hostKyc/uidKycHost3')))
await no('RULES-1: a guest cannot create one for another host with an agency',
  setDoc(D(guest, 'hostKyc/uidKycHost2'), { accountNumber: '123' }))
await no('RULES-1: the host cannot write it from the app either (nothing in the app does)',
  updateDoc(D(kycHost, 'hostKyc/uidKycHost'), { accountNumber: '42' }))
await ok('RULES-1: a staff admin still can — the one writer the rules name',
  updateDoc(D(opsAdmin, 'hostKyc/uidKycHost'), { ifscCode: 'ZIPR0000002' }))
await ok('RULES-1: the host can still read their own (reads are not changed by B3)',
  getDoc(D(kycHost, 'hostKyc/uidKycHost')))

// RULES-2 — platformRevenue / platformStats: Cloud Functions write them with
// the Admin SDK; no client may.
await no('RULES-2: a signed-in client cannot create a platformRevenue row',
  setDoc(D(phoneUser, 'platformRevenue/forged-call'), {
    type: 'call', receiverUid: 'uidPhone', payoutBeans: 1000000, grossDiamonds: 1000000, timestamp: new Date(),
  }))
await no('RULES-2: …nor create a platformStats document',
  setDoc(D(phoneUser, 'platformStats/forged'), { totalRevenue: 1 }))
await seed('platformStats/global', { totalRevenue: 10 })
await no('RULES-2: …nor change one',
  updateDoc(D(phoneUser, 'platformStats/global'), { totalRevenue: 999999 }))
await seed('platformRevenue/2026-10-15', { platformRevenue: 1234, type: 'daily' })
await ok('RULES-2: Finance and admins can still read platformRevenue',
  getDoc(D(opsAdmin, 'platformRevenue/2026-10-15')))
await ok('RULES-2: a signed-in user can still read platformStats (unchanged)',
  getDoc(D(phoneUser, 'platformStats/global')))

// RULES-3 — kycSubmissions: a submission names its own author.
await no('RULES-3: a submission filed in ANOTHER user\'s name is refused',
  setDoc(D(phoneUser, 'kycSubmissions/k-other'), { uid: 'uidGoogle', status: 'pending' }))
await no('RULES-3: …and one that names nobody',
  setDoc(D(phoneUser, 'kycSubmissions/k-none'), { status: 'pending' }))
await ok('RULES-3: a user can still file one in their own name',
  setDoc(D(phoneUser, 'kycSubmissions/k-own'), { uid: 'uidPhone', status: 'pending' }))
await ok('RULES-3: …and read it back',
  getDoc(D(phoneUser, 'kycSubmissions/k-own')))

// RULES-4 — users/{uid}/likedBy: toggleLike writes it, with the counters.
await seed('users/uidLiked', { uid: 'uidLiked' })
await seed('users/uidLiked/likedBy/uidGoogle', { uid: 'uidGoogle', name: 'Real liker', likedAt: new Date() })
const liked = ctx('uidLiked', { phone_number: '+919800000203', firebase: { sign_in_provider: 'phone' } })
await no('RULES-4: a client cannot add itself to someone\'s "who liked me" list directly',
  setDoc(D(phoneUser, 'users/uidLiked/likedBy/uidPhone'), { uid: 'uidPhone', name: 'Me', likedAt: new Date() }))
await no('RULES-4: …nor plant an entry in ANOTHER account\'s name',
  setDoc(D(phoneUser, 'users/uidLiked/likedBy/uidForged'), { uid: 'uidForged', name: 'Somebody famous', likedAt: new Date() }))
await no('RULES-4: …nor delete somebody else\'s real like',
  deleteDoc(D(phoneUser, 'users/uidLiked/likedBy/uidGoogle')))
await ok('RULES-4: the liked person can still read who liked them',
  getDoc(D(liked, 'users/uidLiked/likedBy/uidGoogle')))

// RULES-5 — liveRooms/{id}/gifts: settleGift writes the row after the
// diamonds move; a client row is a gift nobody paid for.
await seed('liveRooms/LR_B3', { hostUid: 'uidLiveHost', isActive: true })
await seed('liveRooms/LR_B3/gifts/g-real', { senderUid: 'uidGoogle', diamondCost: 10, timestamp: new Date() })
await no('RULES-5: a client cannot put a gift on a live room\'s ticker or leaderboard',
  setDoc(D(phoneUser, 'liveRooms/LR_B3/gifts/g-forged'), { senderUid: 'uidPhone', diamondCost: 1000000, timestamp: new Date() }))
await ok('RULES-5: viewers can still read the ticker',
  getDoc(D(phoneUser, 'liveRooms/LR_B3/gifts/g-real')))

// ════════════════════════════════════════════════════════════════════════════
console.log('B4 — partner edits: bank details and governance (GOV-4), revoked sellers (FIN-7)')
// ════════════════════════════════════════════════════════════════════════════
// Every `no` below is a write that SUCCEEDED before B4 — run this file with
// ZIPPER_RULES_FILE pointing at the pre-B4 rules to see each one fail. Every
// `ok` is a write a real screen makes, or an authorised role keeps, and it
// passes on both. Each document is used by one actor's checks where a
// pre-B4 success could otherwise turn a later check into a no-op.
await seed('crmUsers/uidMktAdmin', { uid: 'uidMktAdmin', role: 'marketing_admin', isActive: true, status: 'approved' })
await seed('crmUsers/uidSupAdmin', { uid: 'uidSupAdmin', role: 'support_admin', isActive: true, status: 'approved' })
await seed('crmUsers/uidFinAdmin', { uid: 'uidFinAdmin', role: 'finance_admin', isActive: true, status: 'approved' })
await seed('crmUsers/uidFinMember', { uid: 'uidFinMember', role: 'finance_member', isActive: true, status: 'approved' })
const mktAdmin = ctx('uidMktAdmin', { email: 'mk@zipper.test', email_verified: true })
const supAdmin = ctx('uidSupAdmin', { email: 'sa@zipper.test', email_verified: true })
const finAdmin = ctx('uidFinAdmin', { email: 'fa@zipper.test', email_verified: true })
const finMember = ctx('uidFinMember', { email: 'fm@zipper.test', email_verified: true })

// The payout block an agency carries at the top level (payoutFields()).
const BANK = {
  paymentType: 'bank', accountHolderName: 'Asha Rao', accountNumber: '000011112222',
  ifscCode: 'ZIPR0000040', bankName: 'Zip Bank', branch: 'Main', upiId: 'asha@upi', currency: 'INR',
}
// A seller filed through the app keeps the same details in a `payment` map
// (partner_applications.py) and mirrors its UPI QR to `qrCodeUrl`.
const SELLER_B4 = (over = {}) => ({
  displayName: 'B4 Coins', status: 'approved', isApproved: true, isActive: true,
  city: 'Pune', description: 'Open 9 to 6', qrCodeUrl: 'https://cdn.example.test/qr.png',
  isOnline: false, kycStatus: 'approved', coinBalance: 0, totalCoinsSold: 0,
  payment: { upiId: 'coins@upi', upiQrUrl: 'https://cdn.example.test/qr.png',
    accountNumber: '123412341234', ifscCode: 'ZIPR0000041' },
  ...over,
})
const proposal = (uid, fields) => ({
  pendingChanges: {
    fields, submittedAt: new Date(), note: '', previousKycStatus: 'approved',
    submittedBy: { uid, name: 'Partner', role: 'partner' },
  },
  kycStatus: 'submitted',
  kycSubmittedAt: new Date(),
})

// ── GOV-4: staff — bank details are the Owner's to change from a browser ────
await seed('agencies/AG_B4_BANK', AGENCY({ status: 'approved', isActive: true, kycStatus: 'approved', ...BANK }))
for (const [who, as, change] of [
  ['an ops admin', opsAdmin, { accountNumber: '999988887777' }],
  ['a marketing admin', mktAdmin, { upiId: 'mallory@upi' }],
  ['a support admin', supAdmin, { ifscCode: 'EVIL0000001' }],
  ['a finance admin', finAdmin, { accountHolderName: 'Mallory' }],
  ['an ops admin', opsAdmin, { paymentType: 'foreign', binanceUid: '777000777', currency: 'USD' }],
]) {
  await no(`GOV-4: ${who} cannot rewrite an agency's ${Object.keys(change).join('/')}`,
    updateDoc(D(as, 'agencies/AG_B4_BANK'), change))
}
await seed('sellers/SL_B4_STAFF', SELLER_B4())
await no('GOV-4: a finance MEMBER cannot write a seller\'s upiId',
  updateDoc(D(finMember, 'sellers/SL_B4_STAFF'), { upiId: 'mallory@upi' }))
await no('GOV-4: a finance admin cannot replace a seller\'s payment block',
  updateDoc(D(finAdmin, 'sellers/SL_B4_STAFF'), { payment: { upiId: 'mallory@upi' } }))
await no('GOV-4: …nor change one field inside it (payment.upiId)',
  updateDoc(D(finAdmin, 'sellers/SL_B4_STAFF'), { 'payment.upiId': 'mallory2@upi' }))
await no('GOV-4: an ops admin cannot swap the payment QR buyers are shown',
  updateDoc(D(opsAdmin, 'sellers/SL_B4_STAFF'), { qrCodeUrl: 'https://evil.example.test/qr.png' }))

// ── GOV-4: staff — governance is a server operation, Owner included ────────
await seed('agencies/AG_B4_OTHER', AGENCY({ status: 'approved', isActive: true }))
await seed('agencies/AG_B4_SUBS', AGENCY({ type: 'sub', parentAgencyId: 'AG_B4_BANK', status: 'approved', isActive: true }))
await seed('agencies/AG_B4_SUBS_OWNER', AGENCY({ type: 'sub', parentAgencyId: 'AG_B4_BANK', status: 'approved', isActive: true }))
await seed('agencies/AG_B4_GOV', AGENCY({ status: 'approved', isActive: true, kycStatus: 'approved' }))
await no('GOV-4: an ops admin cannot re-parent a sub-agency (the audited transfer does that)',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_SUBS'), { parentAgencyId: 'AG_B4_OTHER' }))
await no('GOV-4: …nor make a sub-agency a main agency',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_SUBS'), { type: 'main' }))
await no('GOV-4: …nor set an agency\'s kycStatus',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_GOV'), { kycStatus: 'pending' }))
await no('GOV-4: …nor its commissionRate (setAgencyCommissionRate\'s write)',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_GOV'), { commissionRate: 50 }))
await no('GOV-4: a finance admin cannot set a seller\'s commissionRate',
  updateDoc(D(finAdmin, 'sellers/SL_B4_STAFF'), { commissionRate: 50 }))
await no('GOV-4: a finance member cannot set a seller\'s kycStatus',
  updateDoc(D(finMember, 'sellers/SL_B4_STAFF'), { kycStatus: 'pending' }))
await no('GOV-4: the Owner cannot re-parent from the browser either',
  updateDoc(D(owner1, 'agencies/AG_B4_SUBS_OWNER'), { parentAgencyId: 'AG_B4_OTHER' }))

// ── GOV-4: the partner — its parent, type and commission rate are not its own
const agencyLogin = (uid, agencyId, status) => seed(`crmUsers/${uid}`, {
  uid, role: 'agency', roles: ['agency'], agencyId, isActive: true, status, roleStatus: { agency: status },
})
await agencyLogin('uidAgSelfB4', 'AG_B4_SELF', 'approved')
await agencyLogin('uidSubSelfB4', 'AG_B4_SELFSUB', 'approved')
await agencyLogin('uidAgPendB4', 'AG_B4_PEND', 'pending')
const agencySelf = ctx('uidAgSelfB4', { email: 'self4@example.test', email_verified: true })
const subSelf = ctx('uidSubSelfB4', { email: 'sub4@example.test', email_verified: true })
const agencyPend = ctx('uidAgPendB4', { email: 'pend4@example.test', email_verified: true })
const appAgencyOwner = ctx('uidAppAgB4', { phone_number: '+919800000401', firebase: { sign_in_provider: 'phone' } })
await seed('agencies/AG_B4_SELF', AGENCY({ status: 'approved', isActive: true, kycStatus: 'approved', crmUid: 'uidAgSelfB4', ...BANK }))
await seed('agencies/AG_B4_SELFSUB', AGENCY({ type: 'sub', parentAgencyId: 'AG_B4_BANK', status: 'approved', isActive: true, crmUid: 'uidSubSelfB4' }))
await seed('agencies/AG_B4_PEND', AGENCY({ crmUid: 'uidAgPendB4' }))
await seed('agencies/AG_B4_APP', AGENCY({ ownerUid: 'uidAppAgB4' }))
await no('GOV-4: an approved agency cannot set its own commissionRate',
  updateDoc(D(agencySelf, 'agencies/AG_B4_SELF'), { commissionRate: 90 }))
await no('GOV-4: …nor put itself under another agency',
  updateDoc(D(agencySelf, 'agencies/AG_B4_SELF'), { parentAgencyId: 'AG_B4_OTHER' }))
await no('GOV-4: an approved sub-agency cannot detach itself from its parent',
  updateDoc(D(subSelf, 'agencies/AG_B4_SELFSUB'), { parentAgencyId: null }))
await no('GOV-4: …nor declare itself a main agency',
  updateDoc(D(subSelf, 'agencies/AG_B4_SELFSUB'), { type: 'main' }))
await no('GOV-4: a PENDING agency cannot choose a new parent (the pending exemption is for KYC and bank)',
  updateDoc(D(agencyPend, 'agencies/AG_B4_PEND'), { parentAgencyId: 'AG_B4_OTHER' }))
await no('GOV-4: …nor change its type',
  updateDoc(D(agencyPend, 'agencies/AG_B4_PEND'), { type: 'sub' }))
await no('GOV-4: an app owner of a pending agency cannot change its type',
  updateDoc(D(appAgencyOwner, 'agencies/AG_B4_APP'), { type: 'sub' }))
await no('GOV-4: …nor its parent',
  updateDoc(D(appAgencyOwner, 'agencies/AG_B4_APP'), { parentAgencyId: 'AG_B4_OTHER' }))

// ── FIN-7: a revoked seller edits nothing on its own record ────────────────
// The two halves are mirrored separately by the backend, so each is tested
// with the other still saying "live".
await seed('crmUsers/uidSlDualRevB4', {
  uid: 'uidSlDualRevB4', role: 'agency', roles: ['agency', 'seller'], isActive: true, status: 'approved',
  agencyId: 'AG_B4_DUAL', sellerId: 'SL_B4_DUALREV', roleStatus: { agency: 'approved', seller: 'revoked' },
})
await seed('crmUsers/uidSlRecRevB4', {
  uid: 'uidSlRecRevB4', role: 'seller', isActive: true, status: 'approved',
  sellerId: 'SL_B4_RECREV', roleStatus: { seller: 'approved' },
})
await seed('crmUsers/uidSlPendRevB4', {
  uid: 'uidSlPendRevB4', role: 'agency', roles: ['agency', 'seller'], isActive: true, status: 'approved',
  sellerId: 'SL_B4_PENDREV', roleStatus: { agency: 'approved', seller: 'revoked' },
})
await seed('crmUsers/uidSlSuspB4', { uid: 'uidSlSuspB4', role: 'seller', isActive: true, sellerId: 'SL_B4_SUSP' })
const dualRevoked = ctx('uidSlDualRevB4', { email: 'dr4@example.test', email_verified: true })
const recordRevoked = ctx('uidSlRecRevB4', { email: 'rr4@example.test', email_verified: true })
const pendRevoked = ctx('uidSlPendRevB4', { email: 'pr4@example.test', email_verified: true })
const suspendedSeller = ctx('uidSlSuspB4', { email: 'su4@example.test', email_verified: true })
const appSellerRevoked = ctx('uidAppSlRevB4', { phone_number: '+919800000403', firebase: { sign_in_provider: 'phone' } })
await seed('sellers/SL_B4_DUALREV', SELLER_B4({ crmUid: 'uidSlDualRevB4', ownerUid: 'uidSlDualRevB4' }))
await seed('sellers/SL_B4_RECREV', SELLER_B4({
  crmUid: 'uidSlRecRevB4', ownerUid: 'uidSlRecRevB4', status: 'revoked', isApproved: false, isActive: false,
}))
await seed('sellers/uidAppSlRevB4', SELLER_B4({ ownerUid: 'uidAppSlRevB4', status: 'revoked', isApproved: false, isActive: false }))
await seed('sellers/SL_B4_PENDREV', SELLER_B4({
  crmUid: 'uidSlPendRevB4', status: 'pending', isApproved: false, isActive: false, kycStatus: 'submitted',
}))
await seed('sellers/SL_B4_SUSP', SELLER_B4({ crmUid: 'uidSlSuspB4', status: 'suspended', isActive: false }))
await no('FIN-7: a dual-role login whose SELLER role is revoked cannot swap its payment QR',
  updateDoc(D(dualRevoked, 'sellers/SL_B4_DUALREV'), { qrCodeUrl: 'https://evil.example.test/qr.png' }))
await no('FIN-7: …nor change its city',
  updateDoc(D(dualRevoked, 'sellers/SL_B4_DUALREV'), { city: 'Elsewhere' }))
await no('FIN-7: …nor its description',
  updateDoc(D(dualRevoked, 'sellers/SL_B4_DUALREV'), { description: 'Now selling elsewhere' }))
await no('FIN-7: …nor go online (owner arm and CRM arm)',
  updateDoc(D(dualRevoked, 'sellers/SL_B4_DUALREV'), { isOnline: true }))
await no('FIN-7: …nor propose new payout details',
  updateDoc(D(dualRevoked, 'sellers/SL_B4_DUALREV'), proposal('uidSlDualRevB4', { upiId: 'mallory@upi' })))
await no('FIN-7: a REVOKED seller record cannot swap its QR, even while the login still says approved',
  updateDoc(D(recordRevoked, 'sellers/SL_B4_RECREV'), { qrCodeUrl: 'https://evil.example.test/qr.png' }))
await no('FIN-7: …nor go online',
  updateDoc(D(recordRevoked, 'sellers/SL_B4_RECREV'), { isOnline: true }))
await no('FIN-7: an app-only seller whose record is revoked cannot go online (SellerDashboardScreen)',
  updateDoc(D(appSellerRevoked, 'sellers/uidAppSlRevB4'), { isOnline: true }))
await no('FIN-7: a revoked seller role cannot use the pending-record edit either',
  updateDoc(D(pendRevoked, 'sellers/SL_B4_PENDREV'), { displayName: 'Still Here' }))
await no('FIN-7: a SUSPENDED seller record cannot edit its description (same helper as coin purchases)',
  updateDoc(D(suspendedSeller, 'sellers/SL_B4_SUSP'), { description: 'Back soon' }))

// ── Legitimate operations that must keep working ───────────────────────────
await ok('GOV-4: the Owner can still change an agency\'s bank details',
  updateDoc(D(owner1, 'agencies/AG_B4_BANK'), { accountNumber: '555566667777', ifscCode: 'ZIPR0000042' }))
await ok('GOV-4: …and a seller\'s payment block',
  updateDoc(D(owner1, 'sellers/SL_B4_STAFF'), { 'payment.upiId': 'owner-set@upi' }))
await ok('GOV-4: an ops admin can still edit an ordinary agency field',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_BANK'), { notes: 'KYC call done' }))
await ok('GOV-4: …and resend a partner email (resendPartnerEmail)',
  updateDoc(D(opsAdmin, 'agencies/AG_B4_BANK'), { _resendEmail: 'registration' }))
await ok('GOV-4: a finance member can still edit an ordinary seller field',
  updateDoc(D(finMember, 'sellers/SL_B4_STAFF'), { notes: 'called the seller' }))
await ok('GOV-4: …and resend a seller email',
  updateDoc(D(finMember, 'sellers/SL_B4_STAFF'), { _resendEmail: 'approval' }))
await ok('GOV-4: an approved agency still edits its own ordinary fields',
  updateDoc(D(agencySelf, 'agencies/AG_B4_SELF'), { city: 'Pune', description: 'Talent agency' }))
await ok('GOV-4: …and proposes a bank change for review (agency-dashboard KYC form)',
  updateDoc(D(agencySelf, 'agencies/AG_B4_SELF'),
    proposal('uidAgSelfB4', { accountNumber: '999900001111', ifscCode: 'ZIPR0000043' })))
await ok('GOV-4: a pending agency still submits its KYC and bank details directly',
  updateDoc(D(agencyPend, 'agencies/AG_B4_PEND'), {
    kycStatus: 'submitted', kycDocUrls: ['k1', 'k2', 'k3'], kycSubmittedAt: new Date(), ...BANK,
  }))
await ok('GOV-4: an app owner still edits their pending application',
  updateDoc(D(appAgencyOwner, 'agencies/AG_B4_APP'), { ownerPhone: '+919800000444', kycStatus: 'submitted' }))

await seed('crmUsers/uidSlLiveB4', {
  uid: 'uidSlLiveB4', role: 'seller', isActive: true, status: 'approved',
  sellerId: 'SL_B4_LIVE', roleStatus: { seller: 'approved' },
})
await seed('crmUsers/uidSlLegacyB4', { uid: 'uidSlLegacyB4', role: 'seller', isActive: true, status: 'approved', sellerId: 'SL_B4_LEGACY' })
await seed('crmUsers/uidSlPendB4', {
  uid: 'uidSlPendB4', role: 'seller', isActive: true, status: 'pending',
  sellerId: 'SL_B4_PEND', roleStatus: { seller: 'pending' },
})
const sellerLive = ctx('uidSlLiveB4', { email: 'live4@example.test', email_verified: true })
const sellerLegacy = ctx('uidSlLegacyB4', { email: 'leg4@example.test', email_verified: true })
const sellerPend = ctx('uidSlPendB4', { email: 'sp4@example.test', email_verified: true })
const appSeller = ctx('uidAppSlB4', { phone_number: '+919800000402', firebase: { sign_in_provider: 'phone' } })
await seed('sellers/SL_B4_LIVE', SELLER_B4({ crmUid: 'uidSlLiveB4', ownerUid: 'uidSlLiveB4' }))
await seed('sellers/SL_B4_LEGACY', SELLER_B4({ crmUid: 'uidSlLegacyB4' }))
await seed('sellers/SL_B4_PEND', SELLER_B4({
  crmUid: 'uidSlPendB4', status: 'pending', isApproved: false, isActive: false, kycStatus: 'submitted',
}))
await seed('sellers/uidAppSlB4', SELLER_B4({ ownerUid: 'uidAppSlB4' }))
await ok('FIN-7: a live seller still edits city, description and QR',
  updateDoc(D(sellerLive, 'sellers/SL_B4_LIVE'),
    { city: 'Mumbai', description: 'Open 10 to 7', qrCodeUrl: 'https://cdn.example.test/qr-new.png' }))
await ok('FIN-7: …and goes online (seller-dashboard toggle)',
  updateDoc(D(sellerLive, 'sellers/SL_B4_LIVE'), { isOnline: true }))
await ok('FIN-7: …and proposes a profile change',
  updateDoc(D(sellerLive, 'sellers/SL_B4_LIVE'), proposal('uidSlLiveB4', { displayName: 'B4 Coins Two' })))
await ok('FIN-7: a legacy seller login with no roleStatus is still live',
  updateDoc(D(sellerLegacy, 'sellers/SL_B4_LEGACY'), { description: 'Legacy login, still live' }))
await ok('FIN-7: an app-only seller (no crmUsers document) still goes online from the app',
  updateDoc(D(appSeller, 'sellers/uidAppSlB4'), { isOnline: true }))
await ok('FIN-7: a pending seller still edits its pending record directly',
  updateDoc(D(sellerPend, 'sellers/SL_B4_PEND'), { displayName: 'Pending Coins' }))

// ════════════════════════════════════════════════════════════════════════════
console.log('B5 — approvalRequests: the four filed shapes, decided by another Owner (GOV-1)')
// ════════════════════════════════════════════════════════════════════════════
// Every `no` below is a write that SUCCEEDED before B5 — run this file with
// ZIPPER_RULES_FILE pointing at the pre-B5 rules to see each one fail. The
// `ok`s are the CRM's own writes (lib/approvals.ts: submitApproval,
// approveRequest, rejectRequest) and its reads, and pass on both.
await seed('crmUsers/uidTechMemB5', { uid: 'uidTechMemB5', role: 'tech_member', isActive: true, status: 'approved' })
await seed('crmUsers/uidAppAdminB5', { uid: 'uidAppAdminB5', role: 'app_admin', isActive: true, status: 'approved' })
await seed('crmUsers/uidOpsMemB5', { uid: 'uidOpsMemB5', role: 'ops_member', isActive: true, status: 'approved' })
const techMember = ctx('uidTechMemB5', { email: 'tm5@zipper.test', email_verified: true })
const appAdmin = ctx('uidAppAdminB5', { email: 'aa5@zipper.test', email_verified: true })
const opsMember = ctx('uidOpsMemB5', { email: 'om5@zipper.test', email_verified: true })
const owner2 = ctx('uidOwner2', { email: 'o2@zipper.test', email_verified: true })
const agencyLive = ctx('uidAgencyLive', { email: 'live@example.test', email_verified: true })

// What submitApproval writes, for the caller named.
const filing = (uid, role, shape) => ({
  description: 'B5 test', targetLabel: 'B5 test', payload: {},
  requestedBy: { uid, name: uid, role }, status: 'pending', requestedAt: new Date(), ...shape,
})
const ECONOMY = { type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'economy' }
const CONTROL = { type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'control' }
const NEW_AGENCY = (over = {}) => ({
  type: 'create_agency', operation: 'create', targetCollection: 'agencies', targetDocId: '',
  payload: {
    crmId: 'A5A5A5A5', agencyName: 'Queue Agency', ownerName: 'Q', ownerPhone: '+919800000501',
    ownerEmail: 'qa5@example.test', address: 'Pune', type: 'main', parentAgencyId: null,
    referralCode: 'QUEU5555', status: 'pending', kycStatus: 'pending', kycDocUrls: ['a', 'b', 'c'],
    paymentType: 'bank', currency: 'INR', isActive: false, source: 'crm', totalHosts: 0,
    totalSubAgencies: 0, accountNumber: '123456789012', ifscCode: 'ZIPR0000050',
    crmUid: 'uidNewAgencyLoginB5', ...over,
  },
})
const NEW_SELLER = (over = {}) => ({
  type: 'create_seller', operation: 'create', targetCollection: 'sellers', targetDocId: '',
  payload: {
    crmId: 'S5S5S5S5', displayName: 'Queue Coins', phone: '+919800000502', email: 'qs5@example.test',
    city: 'Pune', description: 'Open 9 to 6', idDocUrls: [], isApproved: false, isActive: false,
    status: 'pending', coinBalance: 0, totalCoinsSold: 0, qrCodeUrl: '', source: 'crm_admin',
    crmUid: 'uidNewSellerLoginB5', ...over,
  },
})
const decision = (uid, status, notes = '') =>
  ({ status, reviewedBy: { uid, name: uid }, reviewedAt: new Date(), reviewNotes: notes })

// ── Filing: only the four shapes ───────────────────────────────────────────
await no('GOV-1: staff cannot file a create aimed at an Owner\'s crmUsers record',
  setDoc(D(opsAdmin, 'approvalRequests/AR5_CRMUSERS'), filing('uidOps', 'ops_admin', {
    type: 'create_agency', operation: 'create', targetCollection: 'crmUsers', targetDocId: 'uidOwner1',
    payload: { role: 'superadmin', isActive: true },
  })))
await no('GOV-1: …nor a delete of any document',
  setDoc(D(opsAdmin, 'approvalRequests/AR5_DELETE'), filing('uidOps', 'ops_admin', {
    type: 'remove_host', operation: 'delete', targetCollection: 'users', targetDocId: 'uidPhone',
  })))
await no('GOV-1: …nor a custom partner decision (approve_agency)',
  setDoc(D(opsAdmin, 'approvalRequests/AR5_CUSTOM'), filing('uidOps', 'ops_admin', {
    type: 'approve_agency', operation: 'custom', targetCollection: 'agencies', targetDocId: 'AG1',
    payload: { approvedBy: 'uidOps' },
  })))
await no('GOV-1: …nor a registration that names an existing agency id (an overwrite)',
  setDoc(D(opsAdmin, 'approvalRequests/AR5_OVERWRITE'), filing('uidOps', 'ops_admin',
    { ...NEW_AGENCY(), targetDocId: 'AG1' })))
await no('GOV-1: …nor update_config aimed at appConfig/paymentCredentials',
  setDoc(D(finAdmin, 'approvalRequests/AR5_PAYCREDS'), filing('uidFinAdmin', 'finance_admin', {
    ...ECONOMY, targetDocId: 'paymentCredentials', payload: { upiId: 'mallory@upi' },
  })))
await no('GOV-1: a seller registration cannot open with coin inventory',
  setDoc(D(opsMember, 'approvalRequests/AR5_FUNDED'), filing('uidOpsMemB5', 'ops_member',
    NEW_SELLER({ coinBalance: 1000000 }))))
await no('GOV-1: an agency registration cannot arrive approved and active',
  setDoc(D(appAdmin, 'approvalRequests/AR5_PREAPPROVED'), filing('uidAppAdminB5', 'app_admin',
    NEW_AGENCY({ status: 'approved', isActive: true }))))
await no('GOV-1: a filing cannot carry review or outcome fields',
  setDoc(D(finAdmin, 'approvalRequests/AR5_PREDECIDED'), {
    ...filing('uidFinAdmin', 'finance_admin', { ...ECONOMY, payload: { beansPerRupee: 1 } }),
    appliedAt: new Date(),
  }))
await no('GOV-1: an agency can no longer file into the Owner\'s queue (add_host is retired)',
  setDoc(D(agencyLive, 'approvalRequests/AR5_ADD_HOST'), filing('uidAgencyLive', 'agency', {
    type: 'add_host', operation: 'update', targetCollection: 'hostApplications', targetDocId: 'HA_LIVE',
    payload: { status: 'approved' },
  })))

// ── Deciding: once, by an Owner who did not file it ────────────────────────
const pendingFrom = (uid, role) => filing(uid, role, { ...ECONOMY, payload: { beansPerRupee: 120 } })
await seed('approvalRequests/AR5_OWN', pendingFrom('uidOwner1', 'superadmin'))
await seed('approvalRequests/AR5_EDIT', pendingFrom('uidFinAdmin', 'finance_admin'))
await seed('approvalRequests/AR5_DECIDED', {
  ...pendingFrom('uidFinAdmin', 'finance_admin'), ...decision('uidOwner1', 'rejected', 'no'),
})
await seed('approvalRequests/AR5_IMPERSONATE', pendingFrom('uidFinAdmin', 'finance_admin'))
await seed('approvalRequests/AR5_OUTCOME', pendingFrom('uidFinAdmin', 'finance_admin'))
await seed('approvalRequests/AR5_DEL', pendingFrom('uidFinAdmin', 'finance_admin'))
await no('GOV-1: an Owner cannot approve a request they filed',
  updateDoc(D(owner1, 'approvalRequests/AR5_OWN'), decision('uidOwner1', 'approved')))
await no('GOV-1: an Owner cannot change the payload while approving',
  updateDoc(D(owner2, 'approvalRequests/AR5_EDIT'),
    { ...decision('uidOwner2', 'approved'), payload: { beansPerRupee: 1 } }))
await no('GOV-1: a decided request cannot be decided again',
  updateDoc(D(owner2, 'approvalRequests/AR5_DECIDED'), decision('uidOwner2', 'approved')))
await no('GOV-1: an approval cannot be signed in another Owner\'s name',
  updateDoc(D(owner1, 'approvalRequests/AR5_IMPERSONATE'), decision('uidOwner2', 'approved')))
await no('GOV-1: a browser cannot write the outcome fields',
  updateDoc(D(owner2, 'approvalRequests/AR5_OUTCOME'), { appliedAt: new Date() }))
await no('GOV-1: requests are not deleted from a browser',
  deleteDoc(D(owner2, 'approvalRequests/AR5_DEL')))

// ── Unchanged refusals (controls) ──────────────────────────────────────────
await seed('approvalRequests/AR5_CTRL', pendingFrom('uidFinAdmin', 'finance_admin'))
await no('GOV-1 (unchanged): a department admin cannot approve',
  updateDoc(D(opsAdmin, 'approvalRequests/AR5_CTRL'), decision('uidOps', 'approved')))
await no('GOV-1 (unchanged): a requester cannot edit their own request',
  updateDoc(D(finAdmin, 'approvalRequests/AR5_CTRL'), { payload: { beansPerRupee: 1 } }))
await no('GOV-1 (unchanged): staff cannot read someone else\'s request',
  getDoc(D(member, 'approvalRequests/AR5_CTRL')))
await no('GOV-1 (unchanged): a partner cannot file a staff request',
  setDoc(D(agencyLive, 'approvalRequests/AR5_PARTNER'),
    filing('uidAgencyLive', 'agency', { ...ECONOMY, payload: { beansPerRupee: 1 } })))

// ── The CRM's own writes and reads ─────────────────────────────────────────
await ok('GOV-1: finance_admin files an economy config change (economy/config)',
  setDoc(D(finAdmin, 'approvalRequests/AR5_FIN'),
    filing('uidFinAdmin', 'finance_admin', { ...ECONOMY, payload: { beansPerRupee: 120 } })))
await ok('GOV-1: a tech member files an app control change (tech/appcontrol)',
  setDoc(D(techMember, 'approvalRequests/AR5_TECH'),
    filing('uidTechMemB5', 'tech_member', { ...CONTROL, payload: { maintenanceMode: true } })))
await ok('GOV-1: app_admin files a new agency (agencies/register)',
  setDoc(D(appAdmin, 'approvalRequests/AR5_AGENCY'), filing('uidAppAdminB5', 'app_admin', NEW_AGENCY())))
await ok('GOV-1: an ops member files a new seller (sellers/register)',
  setDoc(D(opsMember, 'approvalRequests/AR5_SELLER'), filing('uidOpsMemB5', 'ops_member', NEW_SELLER())))
await ok('GOV-1: another Owner approves it (approveRequest)',
  updateDoc(D(owner2, 'approvalRequests/AR5_FIN'), decision('uidOwner2', 'approved')))
await ok('GOV-1: …or rejects one with a reason (rejectRequest)',
  updateDoc(D(owner2, 'approvalRequests/AR5_TECH'), decision('uidOwner2', 'rejected', 'not now')))
await seed('approvalRequests/AR5_WITHDRAW', pendingFrom('uidOwner1', 'superadmin'))
await ok('GOV-1: an Owner can still reject (withdraw) a request they filed',
  updateDoc(D(owner1, 'approvalRequests/AR5_WITHDRAW'), decision('uidOwner1', 'rejected', 'withdrawn')))
await ok('GOV-1: Owners read the queue',
  getDoc(D(owner1, 'approvalRequests/AR5_AGENCY')))
await ok('GOV-1: a requester reads their own request',
  getDoc(D(appAdmin, 'approvalRequests/AR5_AGENCY')))

// ════════════════════════════════════════════════════════════════════════════
console.log('P0-5 (AUTHN-2/3) — an unverified email proves nothing; contacts are not replaced')
// ════════════════════════════════════════════════════════════════════════════
const AG5 = (over = {}) => ({
  crmId: 'P5P5P5P5', agencyName: 'Five Talents', ownerName: 'Five', ownerPhone: '+919800000551',
  ownerEmail: 'five@example.test', type: 'main', parentAgencyId: null, status: 'pending',
  kycStatus: 'pending', kycDocUrls: [], isActive: false, totalHosts: 0, totalSubAgencies: 0,
  source: 'self_signup', ...over,
})
const SEL5 = (over = {}) => ({
  crmId: 'S5P5S5P5', displayName: 'Five Coins', phone: '+919800000552', email: 'five@example.test',
  registrationProofUrl: '', idDocUrls: [], isApproved: false, isActive: false, status: 'pending',
  coinBalance: 0, totalCoinsSold: 0, qrCodeUrl: '', source: 'self_signup', ...over,
})
const CRM5 = (uid, over = {}) => ({
  uid, email: 'five@example.test', name: 'Five', phone: '', role: 'agency', permissions: [],
  agencyId: 'AG5_APP', isActive: true, status: 'pending', createdBy: 'self_signup',
  createdAt: new Date(), lastLoginAt: null, ...over,
})
// The same address, before and after Firebase has seen it confirmed.
const unverified5 = ctx('uidUnv5', { email: 'five@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
const verified5 = ctx('uidVer5', { email: 'five@example.test', email_verified: true, firebase: { sign_in_provider: 'password' } })

// ── Partner applications matched by email ───────────────────────────────────
await seed('agencies/AG5_APP', AG5())
await no('P0-5: an UNVERIFIED token cannot read an application (bank, KYC) filed under its address',
  getDoc(D(unverified5, 'agencies/AG5_APP')))
await ok('P0-5: the VERIFIED applicant still reads it back',
  getDoc(D(verified5, 'agencies/AG5_APP')))
await no('P0-5: an UNVERIFIED token cannot write the agency crmUid back-link',
  updateDoc(D(unverified5, 'agencies/AG5_APP'), { crmUid: 'uidUnv5' }))
await seed('agencies/AG5_CLAIM', AG5())
await ok('P0-5: the VERIFIED applicant still writes it (agency-signup step 4)',
  updateDoc(D(verified5, 'agencies/AG5_CLAIM'), { crmUid: 'uidVer5' }))
await no('P0-5: an UNVERIFIED token cannot bind a CRM login to a public application',
  setDoc(D(unverified5, 'crmUsers/uidUnv5'), CRM5('uidUnv5')))
await ok('P0-5: the VERIFIED applicant still creates their pending CRM login',
  setDoc(D(verified5, 'crmUsers/uidVer5'), CRM5('uidVer5')))
await no('P0-5: an UNVERIFIED email is not a contact identity — no agency record from it',
  setDoc(D(unverified5, 'agencies/AG5_NEW_UNV'), AG5({ ownerUid: 'uidUnv5' })))
await ok('P0-5: a VERIFIED one is (agency-signup step 3)',
  setDoc(D(verified5, 'agencies/AG5_NEW_VER'), AG5({ ownerUid: 'uidVer5' })))

await seed('sellers/SL5_APP', SEL5())
await no('P0-5: an UNVERIFIED token cannot write a seller crmUid back-link',
  updateDoc(D(unverified5, 'sellers/SL5_APP'), { crmUid: 'uidUnv5' }))
await seed('sellers/SL5_CLAIM', SEL5())
await ok('P0-5: the VERIFIED applicant still writes it',
  updateDoc(D(verified5, 'sellers/SL5_CLAIM'), { crmUid: 'uidVer5' }))
await no('P0-5: an UNVERIFIED token cannot bind a seller CRM login',
  setDoc(D(unverified5, 'crmUsers/uidUnv5'),
    CRM5('uidUnv5', { role: 'seller', sellerId: 'SL5_APP', agencyId: null })))

// ── A sub-agency's new login binds on WHO MADE the record ────────────────────
await seed('agencies/AG5_PARENT', AG5({ ownerEmail: 'parent5@example.test', status: 'approved', isActive: true }))
await seed('crmUsers/uidParent5', { uid: 'uidParent5', role: 'agency', agencyId: 'AG5_PARENT', isActive: true, status: 'approved' })
const parent5 = ctx('uidParent5', { email: 'parent5@example.test', email_verified: true })
const SUB5 = (over = {}) => AG5({
  type: 'sub', parentAgencyId: 'AG5_PARENT', ownerEmail: 'sub5@example.test',
  source: 'agency_created', kycStatus: 'submitted', ...over,
})
await ok('P0-5: the parent files a sub-agency naming itself as creator (agency-dashboard)',
  setDoc(D(parent5, 'agencies/AG5_SUB_NEW'), SUB5({ createdByUid: 'uidParent5' })))
await no('P0-5: nobody can name ANOTHER login as a record\'s creator',
  setDoc(D(parent5, 'agencies/AG5_SUB_FORGED'), SUB5({ createdByUid: 'uidOps' })))
await seed('agencies/AG5_SUB', SUB5({ createdByUid: 'uidParent5' }))
const subLogin5 = ctx('uidSub5', { email: 'sub5@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
await ok('P0-5: the sub-agency\'s brand-new, unverified login binds to the record its parent made',
  setDoc(D(subLogin5, 'crmUsers/uidSub5'),
    CRM5('uidSub5', { email: 'sub5@example.test', agencyId: 'AG5_SUB', createdBy: 'agency_created' })))
const stranger5 = ctx('uidStranger5', { phone_number: '+919800000559', firebase: { sign_in_provider: 'phone' } })
await seed('agencies/AG5_FAKE_SUB', SUB5({ ownerEmail: 'victim5@example.test', createdByUid: 'uidStranger5' }))
const squatter5 = ctx('uidSquat5', { email: 'victim5@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
await no('P0-5: a "sub-agency" a stranger made cannot bind an unverified login to a victim\'s address',
  setDoc(D(squatter5, 'crmUsers/uidSquat5'),
    CRM5('uidSquat5', { email: 'victim5@example.test', agencyId: 'AG5_FAKE_SUB', createdBy: 'agency_created' })))
await seed('agencies/AG5_OWNED', SUB5({ ownerUid: 'uidStranger5', createdByUid: 'uidStranger5' }))
await no('P0-5: the owner of a pending record cannot rewrite who created it',
  updateDoc(D(stranger5, 'agencies/AG5_OWNED'), { createdByUid: 'uidParent5' }))

// ── Review findings: a self-registered login holds ONE proven capability ─────
await seed('sellers/SL5_INJ', SEL5({ email: 'inj5@example.test' }))
await seed('sellers/SL5_INJ_OK', SEL5({ email: 'injok5@example.test' }))
const inj5 = ctx('uidInj5', { email: 'inj5@example.test', email_verified: true, firebase: { sign_in_provider: 'password' } })
const injOk5 = ctx('uidInjOk5', { email: 'injok5@example.test', email_verified: true, firebase: { sign_in_provider: 'password' } })
await no('P0-5: a seller applicant cannot self-register as an agency too (roles + any agency id)',
  setDoc(D(inj5, 'crmUsers/uidInj5'), CRM5('uidInj5', {
    email: 'inj5@example.test', role: 'seller', sellerId: 'SL5_INJ', agencyId: 'AG5_PARENT', roles: ['seller', 'agency'],
  })))
await no('P0-5: …nor carry another capability\'s link without `roles`',
  setDoc(D(inj5, 'crmUsers/uidInj5'), CRM5('uidInj5', {
    email: 'inj5@example.test', role: 'seller', sellerId: 'SL5_INJ', agencyId: 'AG5_PARENT',
  })))
await ok('P0-5: a seller applicant still self-registers with just the seller capability',
  setDoc(D(injOk5, 'crmUsers/uidInjOk5'), CRM5('uidInjOk5', {
    email: 'injok5@example.test', role: 'seller', sellerId: 'SL5_INJ_OK', agencyId: null,
  })))
await seed('crmUsers/uidNullAg5', { uid: 'uidNullAg5', role: 'agency', agencyId: null, isActive: true })
await seed('agencies/AG5_NULLPARENT', SUB5({ parentAgencyId: null, createdByUid: 'uidNullAg5', ownerEmail: 'nullp5@example.test' }))
const nullp5 = ctx('uidNullP5', { email: 'nullp5@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
await no('P0-5: a "sub-agency" with a null parent cannot bind an unverified login',
  setDoc(D(nullp5, 'crmUsers/uidNullP5'),
    CRM5('uidNullP5', { email: 'nullp5@example.test', agencyId: 'AG5_NULLPARENT', createdBy: 'agency_created' })))
await seed('crmUsers/uidRevoked5', { uid: 'uidRevoked5', role: 'agency', agencyId: 'AG5_PARENT', isActive: true, roleStatus: { agency: 'revoked' } })
await seed('agencies/AG5_REVSUB', SUB5({ createdByUid: 'uidRevoked5', ownerEmail: 'revsub5@example.test' }))
const revsub5 = ctx('uidRevSub5', { email: 'revsub5@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
await no('P0-5: a sub-agency made by a REVOKED parent login cannot bind an unverified login',
  setDoc(D(revsub5, 'crmUsers/uidRevSub5'),
    CRM5('uidRevSub5', { email: 'revsub5@example.test', agencyId: 'AG5_REVSUB', createdBy: 'agency_created' })))

// ── The user document ───────────────────────────────────────────────────────
const unvApp5 = ctx('uidUnvApp5', { email: 'unv5@example.test', email_verified: false, firebase: { sign_in_provider: 'password' } })
await no('P0-5: an UNVERIFIED token email cannot land on a new user document',
  setDoc(D(unvApp5, 'users/uidUnvApp5'), BASE('uidUnvApp5', { email: 'unv5@example.test' })))
await seed('users/uidUnvApp5', BASE('uidUnvApp5', { isProfileComplete: true }))
await no('P0-5: …nor be written onto an existing one',
  updateDoc(D(unvApp5, 'users/uidUnvApp5'), { email: 'unv5@example.test' }))

await seed('users/uidHasPhone5', BASE('uidHasPhone5', { phoneNumber: '+919800000561', isProfileComplete: true }))
const newPhone5 = ctx('uidHasPhone5', { phone_number: '+919800000562', firebase: { sign_in_provider: 'phone' } })
await no('P0-5 (AUTHN-3): a phone on the document is not replaced from a client, even by the token\'s',
  updateDoc(D(newPhone5, 'users/uidHasPhone5'), { phoneNumber: '+919800000562' }))
await seed('users/uidLegacy5', BASE('uidLegacy5', { phoneNumber: '9800000563' }))
const legacy5 = ctx('uidLegacy5', { phone_number: '+919800000563', firebase: { sign_in_provider: 'phone' } })
await ok('P0-5: a legacy bare spelling of the SAME number may become the token\'s spelling',
  updateDoc(D(legacy5, 'users/uidLegacy5'), { phoneNumber: '+919800000563' }))
await seed('users/uidE164_5', BASE('uidE164_5', { phoneNumber: '+19800000564', isProfileComplete: true }))
const e164x5 = ctx('uidE164_5', { phone_number: '+919800000564', firebase: { sign_in_provider: 'phone' } })
await no('P0-5 (AUTHN-3): one full international number cannot "respell" into another',
  updateDoc(D(e164x5, 'users/uidE164_5'), { phoneNumber: '+919800000564' }))
await seed('users/uidHasEmail5', BASE('uidHasEmail5', { email: 'old5@example.test', isProfileComplete: true }))
const newEmail5 = ctx('uidHasEmail5', { email: 'new5@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } })
await no('P0-5 (AUTHN-3): an email on the document is not replaced from a client',
  updateDoc(D(newEmail5, 'users/uidHasEmail5'), { email: 'new5@example.test' }))
await seed('users/uidSameEmail5', BASE('uidSameEmail5', { email: 'Same5@Example.test' }))
const sameEmail5 = ctx('uidSameEmail5', { email: 'same5@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } })
await ok('P0-5: writing the SAME address again (saveUserProfile does) is fine',
  updateDoc(D(sameEmail5, 'users/uidSameEmail5'), { email: 'same5@example.test', bio: 'x' }))
await seed('users/uidNullEmail5', BASE('uidNullEmail5', { email: null }))
const nullEmail5 = ctx('uidNullEmail5', { email: 'n5@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } })
await ok('P0-5: a null email on the document counts as none',
  updateDoc(D(nullEmail5, 'users/uidNullEmail5'), { email: 'n5@example.test' }))

// ════════════════════════════════════════════════════════════════════════════
console.log('P0-7 (FIN-5) — a payout request becomes `paid` only through its executed card')
// ════════════════════════════════════════════════════════════════════════════
const WR7 = (status, over = {}) => ({
  hostUid: 'uidHost7', uid: 'uidHost7', hostName: 'Host Seven', beans: 4000, inrAmount: 400,
  status, requestedAt: new Date(), processedAt: null, ...over,
})
await seed('withdrawalRequests/WR7_APPROVED', WR7('approved'))
await no('P0-7: Finance cannot mark a withdrawal request paid from a browser ("Mark paid")',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_APPROVED'),
    { status: 'paid', processedAt: new Date(), processedBy: 'Admin', utrNumber: 'UTR1' }))
await no('P0-7: …nor can an Owner',
  updateDoc(D(owner1, 'withdrawalRequests/WR7_APPROVED'), { status: 'paid' }))
await no('P0-7: Finance cannot rewrite the amount on a request',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_APPROVED'), { beans: 400000 }))
await no('P0-7: …or whose request it is',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_APPROVED'), { hostUid: 'uidFinAdmin', uid: 'uidFinAdmin' }))
await no('P0-7: a request cannot be BORN paid, even by Finance',
  setDoc(D(finAdmin, 'withdrawalRequests/WR7_BORN_PAID'), WR7('paid')))
await ok('P0-7: Finance still files one as pending',
  setDoc(D(finAdmin, 'withdrawalRequests/WR7_FILED'), WR7('pending')))
await seed('withdrawalRequests/WR7_PENDING', WR7('pending'))
await ok('P0-7: Finance still approves a pending request (approveWithdrawal)',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_PENDING'),
    { status: 'approved', processedAt: new Date(), processedBy: 'Admin', notes: 'ok' }))
await seed('withdrawalRequests/WR7_TO_REJECT', WR7('approved'))
await ok('P0-7: …and rejects one not yet paid (rejectWithdrawal)',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_TO_REJECT'),
    { status: 'rejected', rejectionReason: 'bank details wrong', processedAt: new Date(), processedBy: 'Admin' }))
await seed('withdrawalRequests/WR7_PAID', WR7('paid', { cardId: 'C1', paidVia: 'card' }))
await no('P0-7: a PAID request cannot be re-opened or rejected from a browser',
  updateDoc(D(finAdmin, 'withdrawalRequests/WR7_PAID'), { status: 'rejected', rejectionReason: 'oops' }))

const SR7 = (status, over = {}) => ({
  agencyId: 'AG5_PARENT', hostUid: 'uidHost7', hostName: 'Host Seven', periodStart: '2026-10-01',
  periodEnd: '2026-10-07', beansEarned: 2000, amountInr: 200, notes: '', status, createdAt: new Date(), ...over,
})
await seed('salaryRequests/SR7_APPROVED', SR7('approved'))
await no('P0-7: Finance cannot mark a salary request paid from a browser',
  updateDoc(D(finAdmin, 'salaryRequests/SR7_APPROVED'), { status: 'paid', paidAt: new Date(), utrNumber: 'U' }))
await no('P0-7: Finance cannot rewrite a salary request\'s amount',
  updateDoc(D(finAdmin, 'salaryRequests/SR7_APPROVED'), { amountInr: 99999 }))
await seed('salaryRequests/SR7_PENDING', SR7('pending'))
await ok('P0-7: Finance still approves a pending salary request',
  updateDoc(D(finAdmin, 'salaryRequests/SR7_PENDING'), { status: 'approved', approvedAt: new Date() }))
await no('P0-7: the agency cannot mark an UNPAID salary request distributed',
  updateDoc(D(parent5, 'salaryRequests/SR7_APPROVED'), { status: 'distributed', distributedAt: new Date() }))
await seed('salaryRequests/SR7_PAID', SR7('paid', { cardId: 'C2', paidVia: 'card' }))
await ok('P0-7: the agency marks a PAID one distributed (agency dashboard)',
  updateDoc(D(parent5, 'salaryRequests/SR7_PAID'), { status: 'distributed', distributedAt: new Date() }))

// ── Result ──────────────────────────────────────────────────────────────────
await testEnv.cleanup()
if (failures > 0) {
  console.error(`\n${failures} of ${checks} Phase 1A rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`\nAll ${checks} Phase 1A rule checks passed.`)
