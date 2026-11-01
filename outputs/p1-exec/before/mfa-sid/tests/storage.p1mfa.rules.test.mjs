/**
 * storage.rules — P1-A3b Owner MFA boundary (Storage + Firestore emulators, demo-zipper).
 *
 * The `owner` custom claim is account-wide. It counts only when THIS sign-in
 * (auth_time + provider) is bound in Firestore `ownerMfaSessions/{uid}.active`
 * with an unexpired timestamp — a cross-service read evaluated only for an
 * owner claim. Every other claim is unchanged.
 *
 * Run from the repository root (Java + firebase CLI):
 *   firebase emulators:exec --only storage,firestore --project demo-zipper "node tests/storage.p1mfa.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { ref, uploadBytes, getBytes } from 'firebase/storage'
import { doc, setDoc } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES = readFileSync(join(here, '..', 'storage.rules'), 'utf8')
const FS_RULES = readFileSync(join(here, '..', 'firestore.rules'), 'utf8')

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

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  firestore: { rules: FS_RULES, host: '127.0.0.1', port: 8080 },
})
await testEnv.clearStorage()
await testEnv.clearFirestore()

const FUTURE = new Date(Date.now() + 7 * 864e5)
const PAST = new Date(Date.now() - 1000)
await testEnv.withSecurityRulesDisabled(async (c) => {
  const fs = c.firestore()
  await setDoc(doc(fs, 'ownerMfaSessions/ownB'), { active: { '1000:password': FUTURE, '2000:phone': FUTURE } })
  await setDoc(doc(fs, 'ownerMfaSessions/ownX'), { active: { '1000:password': PAST } })
  await setDoc(doc(fs, 'ownerMfaSessions/ownR'), { bindings: {}, active: {} })
  // ownP: no document.
})

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const pdf = { contentType: 'application/pdf' }
const HOST_KYC = 'kyc/AG7/applications/1759_doc1'
const EVIDENCE = 'evidence/withdrawals/1759_slip.pdf'
const SELLER_DOC = 'sellerDocs/S1/id.pdf'
await testEnv.withSecurityRulesDisabled(async (c) => {
  for (const p of [HOST_KYC, EVIDENCE, SELLER_DOC]) await uploadBytes(ref(c.storage(), p), PDF, pdf)
})

const ctx = (uid, claims, auth_time, provider) =>
  testEnv.authenticatedContext(uid, { auth_time, firebase: { sign_in_provider: provider }, ...claims })
const S = (c, p) => ref(c.storage(), p)
const OWNER = { role: 'owner', aid: '' }

const unbound = [
  ['a pending owner (no binding document)', ctx('ownP', OWNER, 1000, 'password')],
  ['an owner whose binding expired', ctx('ownX', OWNER, 1000, 'password')],
  ['an owner whose binding was revoked', ctx('ownR', OWNER, 1000, 'password')],
  ['an owner sign-in with a different auth_time', ctx('ownB', OWNER, 1001, 'password')],
  ['an owner sign-in with a different provider', ctx('ownB', OWNER, 1000, 'google.com')],
]
const crm = ctx('ownB', OWNER, 1000, 'password')
const android = ctx('ownB', OWNER, 2000, 'phone')

console.log('P1-A3b — an owner claim without a bound sign-in reaches nothing')
for (const [who, c] of unbound) {
  await no(`${who} cannot read host KYC`, getBytes(S(c, HOST_KYC)))
  await no(`${who} cannot read money evidence`, getBytes(S(c, EVIDENCE)))
  await no(`${who} cannot read seller documents`, getBytes(S(c, SELLER_DOC)))
  await no(`${who} cannot write host KYC`, uploadBytes(S(c, 'kyc/AG7/applications/x'), PDF, pdf))
}

console.log('P1-A3b — bound owner sign-ins (CRM and Android) keep governance access')
for (const [who, c] of [['the bound CRM sign-in', crm], ['the bound Android sign-in', android]]) {
  await ok(`${who} reads host KYC`, getBytes(S(c, HOST_KYC)))
  await ok(`${who} reads money evidence`, getBytes(S(c, EVIDENCE)))
  await ok(`${who} reads seller documents`, getBytes(S(c, SELLER_DOC)))
}

// Revocation is live: removing the CRM key refuses the CRM sign-in at once,
// with no token refresh, and leaves the Android sign-in alone.
await testEnv.withSecurityRulesDisabled(async (c) => {
  await setDoc(doc(c.firestore(), 'ownerMfaSessions/ownB'), { active: { '2000:phone': FUTURE } })
})
await no('after the CRM session signs out, its sign-in is refused immediately', getBytes(S(crm, HOST_KYC)))
await ok('…and the Android sign-in is unaffected', getBytes(S(android, HOST_KYC)))

console.log('P1-A3b — every other claim is unchanged (no binding needed)')
const opsMember = ctx('om1', { role: 'ops_member', aid: '' }, 0, 'password')
const finAdmin = ctx('fa1', { role: 'finance_admin', aid: '' }, 0, 'password')
const techAdmin = ctx('ta1', { role: 'tech_admin', aid: '' }, 0, 'password')
const sellerA = ctx('S1', { role: 'seller', aid: '' }, 0, 'password')
const agencyA = ctx('agU7', { role: 'agency', aid: 'AG7' }, 0, 'password')
const observer = ctx('obs1', { role: 'observer', aid: '' }, 0, 'password')
await ok('ops_member reads host KYC', getBytes(S(opsMember, HOST_KYC)))
await ok('finance_admin reads money evidence', getBytes(S(finAdmin, EVIDENCE)))
await no('tech_admin still does not read host KYC', getBytes(S(techAdmin, HOST_KYC)))
await ok('a seller reads its own documents', getBytes(S(sellerA, SELLER_DOC)))
await ok('an agency reads its own host KYC', getBytes(S(agencyA, HOST_KYC)))
await ok('an observer claim is unaffected by the owner gate', getBytes(S(observer, HOST_KYC)))
await no('an app user with no claim reads nothing', getBytes(S(ctx('alice', {}, 0, 'phone'), HOST_KYC)))

await testEnv.cleanup()
console.log(`P1MFA-STORAGE-RESULT checks=${checks} failures=${failures}`)
if (failures > 0) {
  console.error(`\n${failures} of ${checks} storage owner-MFA checks FAILED.`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${checks} storage owner-MFA checks passed.`)
}
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
