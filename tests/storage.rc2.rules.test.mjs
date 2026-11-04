/**
 * storage.rules — RULES RELEASE CANDIDATE 2 (2026-11-01) regression tests
 * (Storage + Firestore emulators).
 *
 * Rules under test: the repository's top-level storage.rules = DEPLOYED
 * (9899c24a…) → Owner-MFA candidate (395693b0…: `roleClaim()` returns '' for
 * an `owner` claim unless ownerMfaOk(), a cross-service Firestore read) →
 * hotfix-1 (profileMedia images 15 MB). The header block of storage.rules
 * lists both changes (S1, S2) and the IAM grant S1 depends on in production.
 *
 *   S1  an `owner` claim counts only for a BOUND post-MFA session: the bound
 *       Owner holds the governance grants, the same account on a password
 *       sign-in holds none, every other claim is unchanged (the deep suite is
 *       tests/storage.p1mfa.rules.test.mjs — 60 checks on binding states).
 *   S2  profileMedia images up to 15 MB for the owner only; 15 MB + 1 refused;
 *       videos 50 MB; every OTHER image cap in the file unchanged.
 *   R-7 (documented, NOT changed): the two public signup prefixes keep an
 *       anonymous write-once create and a public `get`; `list` is refused.
 *
 * ZIPPER_STORAGE_RULES_FILE / ZIPPER_RULES_FILE point it at other files.
 * `demo-` project id: never a real project.
 *
 * Run from the repository root (needs Java + firebase CLI):
 *   firebase emulators:exec --only storage,firestore --project demo-zipper "node tests/storage.rc2.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import { ref, uploadBytes, getBytes, listAll, deleteObject } from 'firebase/storage'
import { doc as fsDoc, setDoc as fsSet } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_STORAGE_RULES_FILE || join(here, '..', 'storage.rules')
const FS_RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
// The Storage rules read `ownerMfaSessions/{uid}` from Firestore for an owner
// claim, so the Firestore emulator runs alongside with the matching rules.
const FS_RULES = readFileSync(FS_RULES_PATH, 'utf8')
console.log(`storage rules under test: ${RULES_PATH}`)
console.log(`storage rules sha256: ${RULES_SHA256}`)
console.log(`firestore rules loaded: ${FS_RULES_PATH}`)

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

const MiB = 1024 * 1024
// A JPEG header followed by filler — the rules read contentType, not bytes.
function jpegOf(bytes) {
  const b = new Uint8Array(bytes)
  b.set([0xff, 0xd8, 0xff, 0xdb])
  return b
}
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
const img = { contentType: 'image/jpeg' }
const vid = { contentType: 'video/mp4' }
const pdf = { contentType: 'application/pdf' }
const json = { contentType: 'application/json' }

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  firestore: { rules: FS_RULES, host: '127.0.0.1', port: 8080 },
})
await testEnv.clearStorage()
await testEnv.clearFirestore()

// The bound Owner: an ACTIVE binding for mfa_sid 'test-owner-mfa-sid' at
// auth_time 0, unexpired. `ownerUnbound` is the same account on a password
// sign-in (no mfa_sid, provider 'password').
await testEnv.withSecurityRulesDisabled(async (c) => {
  await fsSet(fsDoc(c.firestore(), 'ownerMfaSessions/own1'), { bindings: { 'test-owner-mfa-sid': {
    state: 'active', authTime: 0, expiresAt: new Date(Date.now() + 7 * 864e5) } } })
})

// ── The cast ────────────────────────────────────────────────────────────────
const ctx = (uid, claims = {}, provider = 'password') =>
  testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: provider }, ...claims })
const stranger = testEnv.unauthenticatedContext()
const guest = ctx('guest1', {}, 'anonymous')
const appUser = ctx('alice', {}, 'phone')
const otherUser = ctx('mallory', {}, 'phone')
const owner = ctx('own1', { role: 'owner', aid: '', mfa_sid: 'test-owner-mfa-sid', auth_time: 0 }, 'custom')
const ownerUnbound = ctx('own1', { role: 'owner', aid: '', auth_time: 7000 })
const ownerWrongSid = ctx('own1', { role: 'owner', aid: '', mfa_sid: 'some-other-sid', auth_time: 0 }, 'custom')
const finAdmin = ctx('fa1', { role: 'finance_admin', aid: '' })
const opsAdmin = ctx('oa1', { role: 'ops_admin', aid: '' })
const marketing = ctx('mm1', { role: 'marketing_member', aid: '' })
const agencyA = ctx('agU7', { role: 'agency', aid: 'AG7' })
const S = (c, path) => ref(c.storage(), path)

async function seed(path, bytes, meta) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await uploadBytes(ref(c.storage(), path), bytes, meta)
  })
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nS1 — an owner claim is authority only from a bound post-MFA session')
// ════════════════════════════════════════════════════════════════════════════
await seed('evidence/expense/receipt.pdf', PDF, pdf)
await seed('kyc/AG7/hostX/aadhaar.pdf', PDF, pdf)
await ok('S1: the BOUND Owner reads finance evidence (isFinance via governance)',
  getBytes(S(owner, 'evidence/expense/receipt.pdf')))
await ok('S1: the bound Owner reads a host KYC document (isKycReviewer)',
  getBytes(S(owner, 'kyc/AG7/hostX/aadhaar.pdf')))
await ok('S1: the bound Owner uploads a content asset (isInternal)',
  uploadBytes(S(owner, 'contentAssets/frames/f1.json'), new TextEncoder().encode('{}'), json))
await no('S1: the same account on a PASSWORD sign-in (no binding) cannot read finance evidence',
  getBytes(S(ownerUnbound, 'evidence/expense/receipt.pdf')))
await no('S1: …nor a host KYC document',
  getBytes(S(ownerUnbound, 'kyc/AG7/hostX/aadhaar.pdf')))
await no('S1: …nor upload a content asset',
  uploadBytes(S(ownerUnbound, 'contentAssets/frames/f2.json'), new TextEncoder().encode('{}'), json))
// B13 — SVGA animations: octet-stream, but only for a .svga name and at most 5 MB
const svga = { contentType: 'application/octet-stream' }
await ok('B13: the bound Owner uploads an SVGA gift animation',
  uploadBytes(S(owner, 'contentAssets/gifts/Rose/animation.svga'), new Uint8Array(64 * 1024), svga))
await ok('B13: …and a bag item SVGA',
  uploadBytes(S(owner, 'contentAssets/bag_items/entrance/en_bike/svga/1_bike.svga'), new Uint8Array(64 * 1024), svga))
await no('B13: octet-stream under any other name is still refused (no arbitrary binaries)',
  uploadBytes(S(owner, 'contentAssets/gifts/Rose/payload.bin'), new Uint8Array(1024), svga))
await no('B13: an SVGA over 5 MB is refused',
  uploadBytes(S(owner, 'contentAssets/gifts/Rose/huge.svga'), new Uint8Array(5 * MiB + 1), svga))
await no('B13: an unbound owner cannot upload an SVGA either',
  uploadBytes(S(ownerUnbound, 'contentAssets/gifts/Rose/animation.svga'), new Uint8Array(1024), svga))
await no('B13: an app user cannot upload an SVGA',
  uploadBytes(S(appUser, 'contentAssets/gifts/Rose/animation.svga'), new Uint8Array(1024), svga))
await no('S1: a custom-token session naming a sid with NO binding holds nothing either',
  getBytes(S(ownerWrongSid, 'evidence/expense/receipt.pdf')))
await no('S1: an unbound owner claim is not even a role claim (crmProfilePhotos write needs one)',
  uploadBytes(S(ownerUnbound, 'crmProfilePhotos/own1.jpg'), jpegOf(1 * MiB), img))
await ok('S1: …the bound Owner has one',
  uploadBytes(S(owner, 'crmProfilePhotos/own1.jpg'), jpegOf(1 * MiB), img))
await ok('S1 (unchanged): a finance admin reads finance evidence without any binding',
  getBytes(S(finAdmin, 'evidence/expense/receipt.pdf')))
await ok('S1 (unchanged): an ops admin reads a host KYC document',
  getBytes(S(opsAdmin, 'kyc/AG7/hostX/aadhaar.pdf')))
await ok('S1 (unchanged): the agency reads its own host\'s KYC document',
  getBytes(S(agencyA, 'kyc/AG7/hostX/aadhaar.pdf')))
await no('S1 (unchanged): a marketing member cannot read finance evidence',
  getBytes(S(marketing, 'evidence/expense/receipt.pdf')))
await no('S1 (unchanged): an app user cannot read a KYC document',
  getBytes(S(appUser, 'kyc/AG7/hostX/aadhaar.pdf')))

// ════════════════════════════════════════════════════════════════════════════
console.log('S2 — profile images up to 15 MB (hotfix-1 A-1); everything else about profileMedia unchanged')
// ════════════════════════════════════════════════════════════════════════════
await ok('S2: alice uploads a 2 MB avatar (always worked)',
  uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), jpegOf(2 * MiB), img))
await ok('S2: alice uploads a 9 MB raw gallery photo (refused under the 5 MB cap)',
  uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), jpegOf(9 * MiB), img))
await ok('S2: a 15 MB image exactly (the cap is inclusive)',
  uploadBytes(S(appUser, 'profileMedia/alice/cover.jpg'), jpegOf(15 * MiB), img))
await no('S2: one byte over 15 MB is refused',
  uploadBytes(S(appUser, 'profileMedia/alice/too_big.jpg'), jpegOf(15 * MiB + 1), img))
await ok('S2: a guest sets its own avatar in the window too',
  uploadBytes(S(guest, 'profileMedia/guest1/avatar.jpg'), jpegOf(7 * MiB), img))
await no('S2 (unchanged): mallory cannot upload into alice\'s prefix',
  uploadBytes(S(otherUser, 'profileMedia/alice/avatar.jpg'), jpegOf(1 * MiB), img))
await no('S2 (unchanged): the bound Owner cannot either (owner-only, not staff territory)',
  uploadBytes(S(owner, 'profileMedia/alice/avatar.jpg'), jpegOf(1 * MiB), img))
await ok('S2 (unchanged): a 40 MB gallery video',
  uploadBytes(S(appUser, 'profileMedia/alice/gallery_2_0.mp4'), jpegOf(40 * MiB), vid))
await no('S2 (unchanged): a 51 MB video is refused',
  uploadBytes(S(appUser, 'profileMedia/alice/gallery_3_0.mp4'), jpegOf(51 * MiB), vid))
await no('S2 (unchanged): a PDF is not profile media',
  uploadBytes(S(appUser, 'profileMedia/alice/notes.pdf'), jpegOf(1 * MiB), pdf))
await ok('S2 (unchanged): any signed-in user can SEE the avatar',
  getBytes(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await no('S2 (unchanged): a signed-out visitor cannot',
  getBytes(S(stranger, 'profileMedia/alice/avatar.jpg')))
await no('S2 (unchanged): mallory cannot delete it',
  deleteObject(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await ok('S2 (unchanged): alice deletes her own',
  deleteObject(S(appUser, 'profileMedia/alice/avatar.jpg')))
// Every OTHER image cap in the file is what it was.
await ok('S2 (scoped): appeal evidence still takes a 4 MB image',
  uploadBytes(S(appUser, 'appealEvidence/alice/1.jpg'), jpegOf(4 * MiB), img))
await no('S2 (scoped): …and still refuses a 9 MB one (its cap stays 5)',
  uploadBytes(S(appUser, 'appealEvidence/alice/2.jpg'), jpegOf(9 * MiB), img))
await ok('S2 (scoped): a host verification capture still takes a 3 MB image',
  uploadBytes(S(appUser, 'hostVerification/alice/capture.jpg'), jpegOf(3 * MiB), img))
await no('S2 (scoped): …and still refuses a 9 MB one (its cap stays 4)',
  uploadBytes(S(appUser, 'hostVerification/alice/capture.jpg'), jpegOf(9 * MiB), img))
await ok('S2 (scoped): a recharge proof still takes a 9 MB image (its cap is 10)',
  uploadBytes(S(appUser, 'rechargeProofs/alice/utr.jpg'), jpegOf(9 * MiB), img))
await no('S2 (scoped): …and still refuses an 11 MB one',
  uploadBytes(S(appUser, 'rechargeProofs/alice/utr2.jpg'), jpegOf(11 * MiB), img))
await no('S2 (scoped): a CRM profile photo is still capped at 5 MB',
  uploadBytes(S(finAdmin, 'crmProfilePhotos/fa1.jpg'), jpegOf(6 * MiB), img))

// ════════════════════════════════════════════════════════════════════════════
console.log('R-7 — documented, not changed: the public signup prefixes')
// ════════════════════════════════════════════════════════════════════════════
await ok('R-7 (as documented): an unauthenticated applicant uploads a ≤10 MB document once',
  uploadBytes(S(stranger, 'kyc/agencies/signup/doc1_1700000000000.pdf'), PDF, pdf))
await no('R-7 (as documented): …and cannot overwrite it (write-once)',
  uploadBytes(S(stranger, 'kyc/agencies/signup/doc1_1700000000000.pdf'), PDF, pdf))
await ok('R-7 (as documented): the uploader\'s own getDownloadURL-style get is public',
  getBytes(S(stranger, 'kyc/agencies/signup/doc1_1700000000000.pdf')))
await no('R-7 (as documented): the prefix is NOT listable',
  listAll(S(stranger, 'kyc/agencies/signup')))
await no('R-7 (as documented): …not by a signed-in user either',
  listAll(S(appUser, 'kyc/agencies/signup')))
await no('R-7 (as documented): an 11 MB document is refused',
  uploadBytes(S(stranger, 'kyc/agencies/signup/doc2_1700000000001.pdf'), jpegOf(11 * MiB), pdf))
await ok('R-7 (as documented): the seller signup prefix takes an anonymous document once',
  uploadBytes(S(stranger, 'sellerDocs/signup/1700000000000_id.pdf'), PDF, pdf))
await no('R-7 (as documented): …not twice',
  uploadBytes(S(stranger, 'sellerDocs/signup/1700000000000_id.pdf'), PDF, pdf))
await no('R-7 (as documented): nor is that prefix listable',
  listAll(S(stranger, 'sellerDocs/signup')))

// ════════════════════════════════════════════════════════════════════════════
console.log('O5 — chat photos and voice notes: the two people in the chat, nobody else')
// ════════════════════════════════════════════════════════════════════════════
const m4a = { contentType: 'audio/mp4' }
await ok('O5: alice sends a photo into her chat with mallory',
  uploadBytes(S(appUser, 'chatMedia/alice_mallory/alice/p1.jpg'), jpegOf(2 * MiB), img))
await ok('O5: …and a voice note',
  uploadBytes(S(appUser, 'chatMedia/alice_mallory/alice/v1.m4a'), jpegOf(1 * MiB), m4a))
await ok('O5: mallory, the other person, sees the photo',
  getBytes(S(otherUser, 'chatMedia/alice_mallory/alice/p1.jpg')))
await no('O5: mallory cannot write under alice\'s name',
  uploadBytes(S(otherUser, 'chatMedia/alice_mallory/alice/p2.jpg'), jpegOf(1 * MiB), img))
await no('O5: alice cannot write into a chat she is not in',
  uploadBytes(S(appUser, 'chatMedia/bob_mallory/alice/p3.jpg'), jpegOf(1 * MiB), img))
await no('O5: a stranger to the chat cannot see the photo',
  getBytes(S(guest, 'chatMedia/alice_mallory/alice/p1.jpg')))
await no('O5: …nor list the chat\'s folder',
  listAll(S(guest, 'chatMedia/alice_mallory/alice')))
await no('O5: a photo over 10 MB is refused',
  uploadBytes(S(appUser, 'chatMedia/alice_mallory/alice/p4.jpg'), jpegOf(10 * MiB + 1), img))
await no('O5: a voice note over 5 MB is refused',
  uploadBytes(S(appUser, 'chatMedia/alice_mallory/alice/v2.m4a'), jpegOf(5 * MiB + 1), m4a))
await no('O5: a video is not a chat attachment',
  uploadBytes(S(appUser, 'chatMedia/alice_mallory/alice/x.mp4'), jpegOf(1 * MiB), vid))
await no('O5: mallory cannot delete alice\'s photo',
  deleteObject(S(otherUser, 'chatMedia/alice_mallory/alice/p1.jpg')))
await ok('O5: alice deletes her own',
  deleteObject(S(appUser, 'chatMedia/alice_mallory/alice/p1.jpg')))

// ── Result ──────────────────────────────────────────────────────────────────
await testEnv.cleanup()

if (failures > 0) {
  console.error(`\n${failures} of ${checks} RC2 storage-rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
} else {
  console.log(`\nAll ${checks} RC2 storage-rule checks passed.`)
}
console.log(`RC2-STORAGE-RESULT checks=${checks} failures=${failures} rules_sha256=${RULES_SHA256}`)
const code = failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()
