/**
 * storage.rules — HOTFIX-1 (2026-11-01) regression tests (Storage emulator).
 *
 * Rules under test: hotfix/rules-20261101/storage.rules — the DEPLOYED text
 * (sha256 9899c24a…) plus ONE change: the `profileMedia/{uid}/{fileName}`
 * image cap goes from `maxSize(5)` to `maxSize(15)`; videos stay at 50.
 *
 * Why: the published app (build 19) uploads the raw gallery photo at profile
 * setup without compressing it, and a 4–10 MB JPEG hit the 5 MB cap, so the
 * sign-up stalled on "User does not have permission to access this object"
 * (audit 04-android §1, F1).
 *
 * What is pinned here: the new window (5 MB < image ≤ 15 MB) is accepted for
 * the owner only; above 15 MB is still refused; the video cap, the owner-only
 * write/delete, the signed-in read and every OTHER image cap in the file are
 * unchanged.
 *
 * Same style as storage.rules.test.mjs (assertSucceeds / assertFails, one
 * HOTFIX1-STORAGE-RESULT line). ZIPPER_STORAGE_RULES_FILE / ZIPPER_RULES_FILE
 * point it at other files. `demo-` project id: never a real project.
 *
 * Run from the repository root (needs Java + firebase CLI):
 *   firebase emulators:exec --only storage,firestore --project demo-zipper "node tests/storage.hotfix1.rules.test.mjs"
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing'
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage'

const here = dirname(fileURLToPath(import.meta.url))
const HOTFIX = join(here, '..', 'hotfix', 'rules-20261101')
const RULES_PATH = process.env.ZIPPER_STORAGE_RULES_FILE || join(HOTFIX, 'storage.rules')
const FS_RULES_PATH = process.env.ZIPPER_RULES_FILE || join(HOTFIX, 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
// The Storage emulator can read Firestore (cross-service rules), so the
// Firestore emulator runs alongside with the matching rules loaded — the
// hotfix text makes no such read, the Owner-MFA candidate does.
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
const img = { contentType: 'image/jpeg' }
const png = { contentType: 'image/png' }
const vid = { contentType: 'video/mp4' }
const pdf = { contentType: 'application/pdf' }

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper',
  storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  firestore: { rules: FS_RULES, host: '127.0.0.1', port: 8080 },
})
await testEnv.clearStorage()
await testEnv.clearFirestore()

// ── The cast ────────────────────────────────────────────────────────────────
const ctx = (uid, claims = {}, provider = 'password') =>
  testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: provider }, ...claims })
const stranger = testEnv.unauthenticatedContext()
const guest = ctx('guest1', {}, 'anonymous')
const appUser = ctx('alice', {}, 'phone')
const otherUser = ctx('mallory', {}, 'phone')
const owner = ctx('own1', { role: 'owner', aid: '' })
const S = (c, path) => ref(c.storage(), path)

// ════════════════════════════════════════════════════════════════════════════
console.log('\nA-1 — profile images up to 15 MB; the window that used to fail sign-up')
// ════════════════════════════════════════════════════════════════════════════
await ok('alice uploads a 2 MB avatar (always worked)',
  uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), jpegOf(2 * MiB), img))
await ok('alice uploads a 9 MB raw gallery photo as her avatar (refused under the 5 MB cap)',
  uploadBytes(S(appUser, 'profileMedia/alice/avatar.jpg'), jpegOf(9 * MiB), img))
await ok('alice uploads a 15 MB image exactly (the new cap is inclusive)',
  uploadBytes(S(appUser, 'profileMedia/alice/cover.jpg'), jpegOf(15 * MiB), img))
await ok('a PNG in the window is an image too',
  uploadBytes(S(appUser, 'profileMedia/alice/gallery_1_0.png'), jpegOf(6 * MiB), png))
await no('one byte over 15 MB is refused',
  uploadBytes(S(appUser, 'profileMedia/alice/too_big.jpg'), jpegOf(15 * MiB + 1), img))
await no('a 20 MB image is refused',
  uploadBytes(S(appUser, 'profileMedia/alice/too_big2.jpg'), jpegOf(20 * MiB), img))
await ok('a guest sets its own avatar in the window too (this path never required a non-guest)',
  uploadBytes(S(guest, 'profileMedia/guest1/avatar.jpg'), jpegOf(7 * MiB), img))

// ════════════════════════════════════════════════════════════════════════════
console.log('Unchanged — owner only, videos at 50, documents refused, reads, deletes')
// ════════════════════════════════════════════════════════════════════════════
await no('mallory cannot upload a 9 MB image into alice\'s prefix',
  uploadBytes(S(otherUser, 'profileMedia/alice/avatar.jpg'), jpegOf(9 * MiB), img))
await no('mallory cannot upload a small one either (owner only, as before)',
  uploadBytes(S(otherUser, 'profileMedia/alice/avatar.jpg'), jpegOf(1 * MiB), img))
await no('a signed-out visitor cannot upload',
  uploadBytes(S(stranger, 'profileMedia/alice/avatar.jpg'), jpegOf(1 * MiB), img))
await no('an owner claim is not staff territory here',
  uploadBytes(S(owner, 'profileMedia/alice/avatar.jpg'), jpegOf(1 * MiB), img))
await ok('alice uploads a 40 MB gallery video (video cap unchanged at 50)',
  uploadBytes(S(appUser, 'profileMedia/alice/gallery_2_0.mp4'), jpegOf(40 * MiB), vid))
await no('a 51 MB video is refused (unchanged)',
  uploadBytes(S(appUser, 'profileMedia/alice/gallery_3_0.mp4'), jpegOf(51 * MiB), vid))
await no('a 9 MB PDF is not profile media (unchanged)',
  uploadBytes(S(appUser, 'profileMedia/alice/notes.pdf'), jpegOf(9 * MiB), pdf))
await no('a 1 MB PDF is not profile media either (unchanged)',
  uploadBytes(S(appUser, 'profileMedia/alice/notes2.pdf'), jpegOf(1 * MiB), pdf))
await ok('any signed-in user can SEE the avatar (unchanged)',
  getBytes(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await no('a signed-out visitor cannot (unchanged)',
  getBytes(S(stranger, 'profileMedia/alice/avatar.jpg')))
await no('mallory cannot delete it (unchanged)',
  deleteObject(S(otherUser, 'profileMedia/alice/avatar.jpg')))
await no('nor can an owner (unchanged)',
  deleteObject(S(owner, 'profileMedia/alice/avatar.jpg')))
await ok('alice deletes her own (unchanged)',
  deleteObject(S(appUser, 'profileMedia/alice/avatar.jpg')))

// ════════════════════════════════════════════════════════════════════════════
console.log('Scoped — every other image cap in the file is what it was')
// ════════════════════════════════════════════════════════════════════════════
await ok('appeal evidence still takes a 4 MB image',
  uploadBytes(S(appUser, 'appealEvidence/alice/1.jpg'), jpegOf(4 * MiB), img))
await no('…and still refuses a 9 MB one (its cap stays 5)',
  uploadBytes(S(appUser, 'appealEvidence/alice/2.jpg'), jpegOf(9 * MiB), img))
await ok('a host verification capture still takes a 3 MB image',
  uploadBytes(S(appUser, 'hostVerification/alice/capture.jpg'), jpegOf(3 * MiB), img))
await no('…and still refuses a 9 MB one (its cap stays 4)',
  uploadBytes(S(appUser, 'hostVerification/alice/capture.jpg'), jpegOf(9 * MiB), img))
await ok('a recharge proof still takes a 9 MB image (its cap is 10)',
  uploadBytes(S(appUser, 'rechargeProofs/alice/utr.jpg'), jpegOf(9 * MiB), img))
await no('…and still refuses an 11 MB one',
  uploadBytes(S(appUser, 'rechargeProofs/alice/utr2.jpg'), jpegOf(11 * MiB), img))

// ── Result ──────────────────────────────────────────────────────────────────
await testEnv.cleanup()

if (failures > 0) {
  console.error(`\n${failures} of ${checks} hotfix-1 storage-rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
} else {
  console.log(`\nAll ${checks} hotfix-1 storage-rule checks passed.`)
}
console.log(`HOTFIX1-STORAGE-RESULT checks=${checks} failures=${failures} rules_sha256=${RULES_SHA256}`)
const code = failures > 0 ? 1 : 0
process.exitCode = code
setTimeout(() => process.exit(code), 2000).unref()
