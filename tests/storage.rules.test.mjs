/**
 * storage.rules, against the Storage emulator, one principal at a time.
 *
 * ── WHAT THESE PIN DOWN ──────────────────────────────────────────────────────
 *
 * `storage.rules` used to authorise on a predicate called `isCrmUser()` whose
 * body was `return request.auth != null`. It was named after staff and
 * answered yes for everybody, so every KYC document, identity proof and bank
 * slip in the bucket was readable by any holder of any token — and with
 * anonymous sign-in enabled for Continue-as-guest and the web config shipping
 * in the public CRM bundle, that meant a stranger with a script.
 *
 * It now authorises on `request.auth.token.role`, a custom claim no client can
 * set. These tests exist because a claim is only as good as the rules reading
 * it, and because the previous audit found TWO bugs of a kind that reading
 * cannot catch — Firebase Security Rules are a permissive union, so a
 * four-segment path like `kyc/agencies/signup/<file>` is also governed by
 * `/kyc/{agencyId}/{hostUid}/{fileName}`, whose `allow write` silently
 * re-granted an overwrite that a `resource == null` guard had just removed.
 *
 * Section 9 is those unions, asserted from the far side.
 *
 * ── RUN ──────────────────────────────────────────────────────────────────────
 *
 *     cd tests && npm install          # once
 *     cd .. && firebase emulators:exec --only storage "node tests/storage.rules.test.mjs"
 *
 * Needs Java. Loads ../storage.rules from disk; nothing touches the real
 * project and every object lives in the emulator.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import { ref, uploadBytes, getBytes, listAll, deleteObject } from 'firebase/storage'
import { doc as fsDoc, setDoc as fsSet } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
// ZIPPER_STORAGE_RULES_FILE=<path> runs the same checks against another
// storage rules file (ZIPPER_RULES_FILE below does the same for the Firestore
// rules the Storage emulator reads); the defaults are unchanged.
const RULES_PATH = process.env.ZIPPER_STORAGE_RULES_FILE || join(here, '..', 'storage.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
console.log(`storage rules under test: ${RULES_PATH}`)

let checks = 0
let failures = 0

async function expect(claim, promise, shouldPass) {
  checks += 1
  try {
    await (shouldPass ? assertSucceeds(promise) : assertFails(promise))
  } catch (err) {
    failures += 1
    console.error(`  FAIL  ${claim}\n        ${String(err.message ?? err).split('\n')[0]}`)
  }
}
const ok = (c, p) => expect(c, p, true)
const no = (c, p) => expect(c, p, false)

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb])
const doc = { contentType: 'application/pdf' }
const img = { contentType: 'image/jpeg' }

// P1-A3b: `storage.rules` reads `ownerMfaSessions/{uid}` from Firestore for an
// owner claim (cross-service rules), so the Firestore emulator runs alongside
// (`--only storage,firestore`) with the real firestore.rules loaded.
const FS_RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const FS_RULES = readFileSync(FS_RULES_PATH, 'utf8')
console.log(`firestore rules loaded: ${FS_RULES_PATH}`)
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  firestore: { rules: FS_RULES, host: '127.0.0.1', port: 8080 },
})
await testEnv.clearStorage()
await testEnv.clearFirestore()
// The owner in this suite (`own1`) acts from the Firebase session made from the
// backend's post-MFA custom token: `mfa_sid` naming an ACTIVE binding for its
// auth_time (0 here), provider 'custom'. Unbound / unconfirmed / replayed /
// expired owners are covered in tests/storage.p1mfa.rules.test.mjs.
await testEnv.withSecurityRulesDisabled(async (c) => {
  await fsSet(fsDoc(c.firestore(), 'ownerMfaSessions/own1'), { bindings: { 'test-owner-mfa-sid': {
    state: 'active', authTime: 0, expiresAt: new Date(Date.now() + 7 * 864e5) } } })
})

// ── The cast ────────────────────────────────────────────────────────────────
//
// `role` and `aid` are the custom claims `storage.rules` authorises on. The
// emulator lets a test set them directly, which is exactly what the Admin SDK
// and the `syncStorageRoleClaim` trigger do in production.
const ctx = (uid, claims = {}, provider = 'password') =>
  testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: provider }, ...claims })

const stranger = testEnv.unauthenticatedContext()
const guest = ctx('guest1', {}, 'anonymous')
const appUser = ctx('alice', {}, 'phone')
const otherUser = ctx('mallory', {}, 'phone')
const hostUser = ctx('hostH', {}, 'phone')

const owner = ctx('own1', { role: 'owner', aid: '', mfa_sid: 'test-owner-mfa-sid', auth_time: 0 }, 'custom')
const observer = ctx('obs1', { role: 'observer', aid: '' })
const appAdmin = ctx('aa1', { role: 'app_admin', aid: '' })
const opsMember = ctx('om1', { role: 'ops_member', aid: '' })
const finAdmin = ctx('fa1', { role: 'finance_admin', aid: '' })
const techAdmin = ctx('ta1', { role: 'tech_admin', aid: '' })
const marketing = ctx('mm1', { role: 'marketing_member', aid: '' })

const agencyA = ctx('agU7', { role: 'agency', aid: 'AG7' })
const agencyB = ctx('agU9', { role: 'agency', aid: 'AG9' })
const subAgency = ctx('subU3', { role: 'agency', aid: 'SUB3' })
const sellerA = ctx('S1', { role: 'seller', aid: '' })
const sellerB = ctx('S2', { role: 'seller', aid: '' })

const S = (c, path) => ref(c.storage(), path)

async function seed(path, bytes, meta) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await uploadBytes(ref(c.storage(), path), bytes, meta)
  })
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. Anonymous signup KYC — the one thing an unauthenticated caller may do')
// ════════════════════════════════════════════════════════════════════════════

const A_SIGNUP = 'kyc/agencies/signup/doc1_3f2a9c7e1b05d4'
const S_SIGNUP = 'sellerDocs/signup/proof_8b1d44ac90f2e6'

await ok('an applicant with no account can upload their Aadhaar',
  uploadBytes(S(stranger, A_SIGNUP), PDF, doc))
await ok('and read it straight back — that is what getDownloadURL() needs',
  getBytes(S(stranger, A_SIGNUP)))
await no('but cannot list the prefix',
  listAll(S(stranger, 'kyc/agencies/signup')))
await no('cannot overwrite a document already submitted',
  uploadBytes(S(stranger, A_SIGNUP), PDF, doc))
await no('and cannot delete one',
  deleteObject(S(stranger, A_SIGNUP)))
await no('a second applicant cannot overwrite the first’s document',
  uploadBytes(S(otherUser, A_SIGNUP), PDF, doc))
await no('a second applicant cannot delete it',
  deleteObject(S(otherUser, A_SIGNUP)))
await no('oversized uploads are refused',
  uploadBytes(S(stranger, 'kyc/agencies/signup/doc9_aa'), new Uint8Array(11 * 1024 * 1024), doc))
await ok('the seller signup path behaves the same',
  uploadBytes(S(stranger, S_SIGNUP), PDF, doc))
await no('…is not listable', listAll(S(stranger, 'sellerDocs/signup')))
await no('…is write-once', uploadBytes(S(sellerB, S_SIGNUP), PDF, doc))

// ════════════════════════════════════════════════════════════════════════════
console.log('2. Internal roles — by department, not by "is signed in"')
// ════════════════════════════════════════════════════════════════════════════

const HOST_KYC = 'kyc/AG7/applications/1759_doc1'
const OWN_KYC = 'kyc/agencies/AG7/1759_doc1'
const EVIDENCE = 'evidence/withdrawals/1759_slip.pdf'
await seed(HOST_KYC, PDF, doc)
await seed(OWN_KYC, PDF, doc)
await seed(EVIDENCE, PDF, doc)

await ok('owner reads host KYC', getBytes(S(owner, HOST_KYC)))
await ok('observer reads host KYC', getBytes(S(observer, HOST_KYC)))
await ok('app_admin reads host KYC', getBytes(S(appAdmin, HOST_KYC)))
await ok('ops_member reads host KYC', getBytes(S(opsMember, HOST_KYC)))
await ok('finance_admin reads host KYC', getBytes(S(finAdmin, HOST_KYC)))
await no('tech_admin does NOT — no screen shows them a KYC document',
  getBytes(S(techAdmin, HOST_KYC)))
await no('marketing_member does NOT', getBytes(S(marketing, HOST_KYC)))
await no('nobody can enumerate the KYC tree', listAll(S(owner, 'kyc/AG7/applications')))

await ok('finance_admin reads money evidence', getBytes(S(finAdmin, EVIDENCE)))
// The two call sites my own breakage sweep caught, pinned so they stay fixed.
await seed('sellerPaymentProofs/1759_p.pdf', PDF, doc)
await ok('ops_member can write a seller registration payment proof — /sellers/register '
  + 'is gated to superadmin|app_admin|ops_admin|ops_member, none of them finance',
  uploadBytes(S(opsMember, 'sellerPaymentProofs/1760_p.pdf'), PDF, doc))
await ok('and app_admin can read one', getBytes(S(appAdmin, 'sellerPaymentProofs/1759_p.pdf')))
await ok('a seller uploads its own inventory purchase proof from /seller-dashboard',
  uploadBytes(S(sellerA, 'coinPurchases/S1/1759_proof'), JPG, img))
await no('but not into another seller\u2019s',
  uploadBytes(S(sellerB, 'coinPurchases/S1/forged'), JPG, img))
await ok('observer reads money evidence', getBytes(S(observer, EVIDENCE)))
await no('app_admin does NOT — evidence is finance-only',
  getBytes(S(appAdmin, EVIDENCE)))
await no('ops_member does NOT', getBytes(S(opsMember, EVIDENCE)))
await no('evidence cannot be deleted by anyone, including an owner',
  deleteObject(S(owner, EVIDENCE)))

// ════════════════════════════════════════════════════════════════════════════
console.log('3. Agency — its own scope and nothing beside it')
// ════════════════════════════════════════════════════════════════════════════

await ok('AG7 reads the KYC of a host it invited', getBytes(S(agencyA, HOST_KYC)))
await ok('AG7 reads its own agency KYC', getBytes(S(agencyA, OWN_KYC)))
await ok('AG7 uploads a host KYC document', uploadBytes(S(agencyA, 'kyc/AG7/applications/1759_doc2'), PDF, doc))
await ok('AG7 re-submits its own KYC over a fixed filename',
  uploadBytes(S(agencyA, 'kyc/agencies/AG7/doc1_aadhaar'), PDF, doc))
await no('AG9 cannot read AG7’s host KYC', getBytes(S(agencyB, HOST_KYC)))
await no('AG9 cannot read AG7’s own KYC', getBytes(S(agencyB, OWN_KYC)))
await no('AG9 cannot write into AG7’s prefix',
  uploadBytes(S(agencyB, 'kyc/AG7/applications/forged'), PDF, doc))
await no('an agency cannot delete its own submitted KYC',
  deleteObject(S(agencyA, OWN_KYC)))
await no('an agency cannot read seller documents',
  getBytes(S(agencyA, 'sellerDocs/S1/id.pdf')))
await no('an agency cannot read money evidence', getBytes(S(agencyA, EVIDENCE)))

await seed('hostPhotos/AG7/1759_photo', JPG, img)
await ok('AG7 reads its own host reference photo', getBytes(S(agencyA, 'hostPhotos/AG7/1759_photo')))
await no('AG9 cannot', getBytes(S(agencyB, 'hostPhotos/AG7/1759_photo')))

// ════════════════════════════════════════════════════════════════════════════
console.log('4. Sub-agency — its OWN id, never its parent’s')
// ════════════════════════════════════════════════════════════════════════════

await seed('kyc/agencies/SUB3/1759_doc1', PDF, doc)
await ok('SUB3 reads its own KYC', getBytes(S(subAgency, 'kyc/agencies/SUB3/1759_doc1')))
await no('SUB3 cannot read its parent AG7’s KYC', getBytes(S(subAgency, OWN_KYC)))
await no('and AG7 cannot read its child SUB3’s KYC — no inheritance either way',
  getBytes(S(agencyA, 'kyc/agencies/SUB3/1759_doc1')))
await ok('a parent may file a NEW sub-agency application',
  uploadBytes(S(agencyA, 'kyc/sub-agencies/1759/doc1_aadhaar'), PDF, doc))
await no('but may not overwrite one already filed',
  uploadBytes(S(agencyB, 'kyc/sub-agencies/1759/doc1_aadhaar'), PDF, doc))
await no('and an app user cannot file one at all',
  uploadBytes(S(appUser, 'kyc/sub-agencies/1760/doc1_aadhaar'), PDF, doc))

// ════════════════════════════════════════════════════════════════════════════
console.log('5. Seller — its own documents only')
// ════════════════════════════════════════════════════════════════════════════

await seed('sellerDocs/S1/id.pdf', PDF, doc)
await ok('S1 reads its own ID proof', getBytes(S(sellerA, 'sellerDocs/S1/id.pdf')))
await ok('S1 uploads its own', uploadBytes(S(sellerA, 'sellerDocs/S1/pan.pdf'), PDF, doc))
await no('S2 cannot read S1’s', getBytes(S(sellerB, 'sellerDocs/S1/id.pdf')))
await no('S2 cannot write into S1’s folder',
  uploadBytes(S(sellerB, 'sellerDocs/S1/forged.pdf'), PDF, doc))
await no('a seller cannot read agency KYC', getBytes(S(sellerA, OWN_KYC)))
await no('a seller cannot read money evidence', getBytes(S(sellerA, EVIDENCE)))
await no('an app user with the same uid shape cannot — the role claim is required',
  getBytes(S(ctx('S1', {}, 'phone'), 'sellerDocs/S1/id.pdf')))

// ════════════════════════════════════════════════════════════════════════════
console.log('6. Host and ordinary app users reach no document at all')
// ════════════════════════════════════════════════════════════════════════════

for (const [who, c] of [['an app user', appUser], ['a host', hostUser], ['a guest', guest]]) {
  await no(`${who} cannot read host KYC`, getBytes(S(c, HOST_KYC)))
  await no(`${who} cannot read agency KYC`, getBytes(S(c, OWN_KYC)))
  await no(`${who} cannot read seller documents`, getBytes(S(c, 'sellerDocs/S1/id.pdf')))
  await no(`${who} cannot read money evidence`, getBytes(S(c, EVIDENCE)))
  await no(`${who} cannot write into the KYC tree`,
    uploadBytes(S(c, 'kyc/AG7/applications/intruder'), PDF, doc))
}

// ════════════════════════════════════════════════════════════════════════════
console.log('7. Profile media — the owner’s, and visible to the app')
// ════════════════════════════════════════════════════════════════════════════

await ok('alice sets her own avatar', uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), JPG, img))
await ok('and replaces it', uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), JPG, img))
await no('mallory cannot overwrite it', uploadBytes(S(otherUser, 'profileMedia/alice/avatar.jpg'), JPG, img))
await no('mallory cannot delete it', deleteObject(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await no('nor can an owner — this is not staff territory',
  deleteObject(S(owner, 'profileMedia/alice/avatar.jpg')))
await ok('any signed-in user can SEE it (avatars are beside every message)',
  getBytes(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await no('a signed-out visitor cannot', getBytes(S(stranger, 'profileMedia/alice/avatar.jpg')))
await ok('alice deletes her own', deleteObject(S(appUser, 'profileMedia/alice/avatar.jpg')))

// ════════════════════════════════════════════════════════════════════════════
console.log('8. Feedback attachments and host verification')
// ════════════════════════════════════════════════════════════════════════════

await ok('alice attaches to her own feedback',
  uploadBytes(S(appUser, 'feedbackAttachments/alice/1_0.jpg'), JPG, img))
await no('mallory cannot write into alice’s feedback folder',
  uploadBytes(S(otherUser, 'feedbackAttachments/alice/1_1.jpg'), JPG, img))
await ok('support reads it', getBytes(S(opsMember, 'feedbackAttachments/alice/1_0.jpg')))
await no('finance does not', getBytes(S(finAdmin, 'feedbackAttachments/alice/1_0.jpg')))
await no('and mallory cannot delete it', deleteObject(S(otherUser, 'feedbackAttachments/alice/1_0.jpg')))

await seed('hostVerification/alice/capture.jpg', JPG, img)
await ok('alice reads her own liveness capture', getBytes(S(appUser, 'hostVerification/alice/capture.jpg')))
await no('mallory cannot', getBytes(S(otherUser, 'hostVerification/alice/capture.jpg')))
await no('an owner cannot either — review goes through a backend signed URL',
  getBytes(S(owner, 'hostVerification/alice/capture.jpg')))

// ════════════════════════════════════════════════════════════════════════════
console.log('9. The permissive union, asserted from the far side')
// ════════════════════════════════════════════════════════════════════════════
//
// Each of these paths is governed by TWO blocks. The narrower block's guard
// only holds if the broader block does not quietly re-grant what it took
// away — which is the bug that was found twice by reading and never by a test.

await no('signup KYC stays write-once against a CRM account (via /kyc/{a}/{h}/{f})',
  uploadBytes(S(appAdmin, A_SIGNUP), PDF, doc))
await no('…and against an agency', uploadBytes(S(agencyA, A_SIGNUP), PDF, doc))
await no('seller signup stays write-once against a CRM account (via /sellerDocs/{s}/{f})',
  uploadBytes(S(appAdmin, S_SIGNUP), PDF, doc))
await no('…and against a seller', uploadBytes(S(sellerA, S_SIGNUP), PDF, doc))
await ok('while real host KYC is still writable by staff — the exclusion is scoped',
  uploadBytes(S(appAdmin, 'kyc/AG7/applications/1759_doc3'), PDF, doc))
await ok('and the staff temp prefix still works',
  uploadBytes(S(appAdmin, 'kyc/agencies/temp/doc1_1759'), PDF, doc))
await no('no prefix anywhere in the KYC tree is listable',
  listAll(S(appAdmin, 'kyc/agencies')))

// ════════════════════════════════════════════════════════════════════════════
console.log('9b. The three dead paths are closed')
// ════════════════════════════════════════════════════════════════════════════
//
// rechargeScreenshots, roomThumbs: no writer or reader exists in any of the
// four codebases, yet both carried live grants reachable by any signed-in
// account — including an anonymous guest. Closed rather than tightened.

await no('a guest cannot write a room thumbnail',
  uploadBytes(S(guest, 'roomThumbs/R1/thumb.jpg'), JPG, img))
await no('nor can any app user', uploadBytes(S(appUser, 'roomThumbs/R1/thumb.jpg'), JPG, img))
await no('and nobody reads one', getBytes(S(appUser, 'roomThumbs/R1/thumb.jpg')))
await no('recharge screenshots are not writable',
  uploadBytes(S(appUser, 'rechargeScreenshots/R1/p.jpg'), JPG, img))
await no('and not readable by an app user',
  getBytes(S(appUser, 'rechargeScreenshots/R1/p.jpg')))

// ════════════════════════════════════════════════════════════════════════════
console.log('9b. Self-application KYC and recharge proofs — owner-scoped, create-only')
// ════════════════════════════════════════════════════════════════════════════

const pdf = { contentType: 'application/pdf' }
await ok('a user uploads their own host-application document',
  uploadBytes(S(appUser, 'kyc/applicants/alice/aadhaar.pdf'), PDF, pdf))
await no('…but not into somebody else\'s prefix',
  uploadBytes(S(appUser, 'kyc/applicants/mallory/aadhaar.pdf'), PDF, pdf))
await no('…and not a second time over the same object (create-only)',
  uploadBytes(S(appUser, 'kyc/applicants/alice/aadhaar.pdf'), PDF, pdf))
await no('a guest cannot', uploadBytes(S(guest, 'kyc/applicants/guest1/x.pdf'), PDF, pdf))
await no('a guest cannot read under their own uid either',
  getBytes(S(guest, 'kyc/applicants/guest1/x.pdf')))
await ok('the applicant reads their own document back',
  getBytes(S(appUser, 'kyc/applicants/alice/aadhaar.pdf')))
await no('another user cannot read it', getBytes(S(otherUser, 'kyc/applicants/alice/aadhaar.pdf')))
await ok('a KYC reviewer can', getBytes(S(opsMember, 'kyc/applicants/alice/aadhaar.pdf')))
await no('an agency cannot read an applicant\'s self-filed document',
  getBytes(S(agencyA, 'kyc/applicants/alice/aadhaar.pdf')))
await no('the prefix is not listable', listAll(S(appUser, 'kyc/applicants/alice')))

await ok('a buyer uploads their payment screenshot',
  uploadBytes(S(appUser, 'rechargeProofs/alice/utr.jpg'), JPG, img))
await no('…not under another buyer', uploadBytes(S(appUser, 'rechargeProofs/mallory/utr.jpg'), JPG, img))
await no('a guest cannot file a recharge proof, even under their own uid',
  uploadBytes(S(guest, 'rechargeProofs/guest1/utr.jpg'), JPG, img))
await no('…and not a PDF (image only)', uploadBytes(S(appUser, 'rechargeProofs/alice/utr.pdf'), PDF, pdf))
await ok('finance reads it to verify', getBytes(S(finAdmin, 'rechargeProofs/alice/utr.jpg')))
await ok('the buyer reads their own', getBytes(S(appUser, 'rechargeProofs/alice/utr.jpg')))
await no('another user cannot', getBytes(S(otherUser, 'rechargeProofs/alice/utr.jpg')))
await no('a seller cannot read a buyer\'s proof directly', getBytes(S(sellerA, 'rechargeProofs/alice/utr.jpg')))

// ════════════════════════════════════════════════════════════════════════════
console.log('10. App builds and the catch-all')
// ════════════════════════════════════════════════════════════════════════════

await seed('appBuilds/release/arm64/app.apk', JPG, { contentType: 'application/octet-stream' })
await ok('DownloadManager carries no credentials, so the APK is public',
  getBytes(S(stranger, 'appBuilds/release/arm64/app.apk')))
await no('no client may publish a build — not even an owner',
  uploadBytes(S(owner, 'appBuilds/release/arm64/evil.apk'), JPG, img))
await no('an unmatched path is denied', getBytes(S(appUser, 'face_verifications/alice.jpg')))
await no('and not writable', uploadBytes(S(owner, 'whatever/x.jpg'), JPG, img))
await no('the bucket root is not listable', listAll(S(owner, '')))

// ════════════════════════════════════════════════════════════════════════════
console.log('Phase 1A (AUTH-002) — a guest uploads no partner or payment evidence')
// ════════════════════════════════════════════════════════════════════════════
await no('a guest cannot upload a coin-purchase proof under its own uid',
  uploadBytes(S(guest, 'coinPurchaseProofs/guest1/p.jpg'), JPG, img))
await ok('a non-guest person still can, under their own uid',
  uploadBytes(S(appUser, 'coinPurchaseProofs/alice/p.jpg'), JPG, img))
await no('a guest cannot upload a seller payment QR',
  uploadBytes(S(guest, 'sellerQr/guest1/qr.jpg'), JPG, img))
await ok('a non-guest owner can',
  uploadBytes(S(appUser, 'sellerQr/alice/qr.jpg'), JPG, img))
await no('a guest cannot upload a payout screenshot at its own uid',
  uploadBytes(S(guest, 'payoutScreenshots/R1/guest1/s.jpg'), JPG, img))

// ════════════════════════════════════════════════════════════════════════════
console.log('GOV B24 — verification attempts are server-only; the capture slot stays the owner’s')
// ════════════════════════════════════════════════════════════════════════════
//
// `capture.jpg` is overwritten on every try, so what a review is decided on is
// the copy the server makes under `attempts/` (Admin SDK). No client writes,
// replaces, deletes or reads an attempt — review is a backend signed URL.

const ATTEMPT = 'hostVerification/alice/attempts/1760_a.jpg'
await seed(ATTEMPT, JPG, img)
await ok('alice still writes her own capture slot (unchanged)',
  uploadBytes(S(appUser, 'hostVerification/alice/capture.jpg'), JPG, img))
await no('alice cannot write an attempt',
  uploadBytes(S(appUser, 'hostVerification/alice/attempts/1761_b.jpg'), JPG, img))
await no('…nor overwrite the attempt the server stored',
  uploadBytes(S(appUser, ATTEMPT), JPG, img))
await no('…nor delete it', deleteObject(S(appUser, ATTEMPT)))
await no('…nor read it — review goes through a backend signed URL',
  getBytes(S(appUser, ATTEMPT)))
await no('…nor list them', listAll(S(appUser, 'hostVerification/alice/attempts')))
await no('…nor park an object AT the folder name itself',
  uploadBytes(S(appUser, 'hostVerification/alice/attempts'), JPG, img))
await ok('alice still reads her own capture slot (unchanged)',
  getBytes(S(appUser, 'hostVerification/alice/capture.jpg')))
await no('mallory cannot plant one under alice',
  uploadBytes(S(otherUser, 'hostVerification/alice/attempts/1762_c.jpg'), JPG, img))
await no('an owner cannot write one either',
  uploadBytes(S(owner, 'hostVerification/alice/attempts/1763_d.jpg'), JPG, img))
await no('…nor read one', getBytes(S(owner, ATTEMPT)))
await no('a deeper path under attempts/ is closed too',
  uploadBytes(S(appUser, 'hostVerification/alice/attempts/1764/e.jpg'), JPG, img))

// ── Result ──────────────────────────────────────────────────────────────────
await testEnv.cleanup()

if (failures > 0) {
  console.error(`\n${failures} of ${checks} storage-rule checks FAILED.\n`)
  process.exit(1)
}
console.log(`\nAll ${checks} storage-rule checks passed.`)
console.log('  · no app user, host or guest reaches any KYC, ID or evidence file')
console.log('  · agency and seller scoping holds; a sub-agency inherits nothing')
console.log('  · tech and marketing are out of KYC; only finance sees money evidence')
console.log('  · both signup prefixes stay write-once and unlistable under the union\n')
