/**
 * One-off: build `publicProfiles` for accounts that already exist.
 *
 * The `syncPublicProfile` trigger only fires when a user document is written.
 * Every account created before it was deployed is therefore absent from the
 * feed, and will stay absent until something happens to touch it — which for a
 * dormant account is never.
 *
 * Run once after deploying. Safe to run again: it writes the same projection
 * each time, so a second run is a no-op rather than a duplicate.
 *
 *   cd functions
 *   npm run build
 *   node scripts/backfill-public-profiles.mjs
 *
 * Uses the Admin SDK with the service account key at the repo root, rather than
 * the `backfillPublicProfiles` callable — invoking a callable needs a signed-in
 * owner's ID token, which is a lot of ceremony for something run twice in the
 * project's life.
 *
 * Pass `--dry` to see what it would write without writing it.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'

const here = dirname(fileURLToPath(import.meta.url))
const keyPath = resolve(here, '../../serviceAccountKey.json')
const dry = process.argv.includes('--dry')

let credential
try {
  credential = admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8')))
} catch (err) {
  console.error(`Could not read the service account key at ${keyPath}`)
  console.error('This script writes to production Firestore and needs it.')
  process.exit(1)
}

admin.initializeApp({ credential })
const db = admin.firestore()

// The compiled projection — the same function the trigger uses, so a backfilled
// profile is byte-identical to a triggered one.
//
// Imported AFTER initializeApp: profiles.js calls admin.firestore() at module
// scope, and that throws if the default app does not exist yet.
//
// `?? mod.default?.project` because this is a CommonJS module loaded from an
// ES one — Node usually detects the named export, but falls back to putting
// module.exports on `default`, and which one you get is not worth guessing.
const mod = await import('../lib/profiles.js')
const project = mod.project ?? mod.default?.project
if (typeof project !== 'function') {
  console.error('Could not load project() from ../lib/profiles.js — run `npm run build` first.')
  process.exit(1)
}

const BATCH = 400
let written = 0
let skipped = 0
let cursor = null

console.log(dry ? 'DRY RUN — nothing will be written\n' : 'Backfilling publicProfiles…\n')

for (;;) {
  let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(BATCH)
  if (cursor) q = q.startAfter(cursor)
  const page = await q.get()
  if (page.empty) break

  const batch = db.batch()
  for (const doc of page.docs) {
    const u = doc.data()
    // `isLive` is owned by syncLivePresence, which reads it from the live room
    // rather than the user's own flag. Here there is no room to consult, so the
    // user flag is used and the next liveRooms write corrects it. Only wrong
    // for someone broadcasting during the backfill, and it self-heals.
    const projected = project(doc.id, u, u.isLive === true)
    if (dry) {
      skipped++
    } else {
      batch.set(db.collection('publicProfiles').doc(doc.id), projected, { merge: true })
      written++
    }
  }
  if (!dry) await batch.commit()

  cursor = page.docs[page.docs.length - 1]
  process.stdout.write(`\r  ${dry ? skipped : written} accounts…`)
  if (page.size < BATCH) break
}

console.log(
  dry
    ? `\n\nWould write ${skipped} projections. Re-run without --dry to apply.`
    : `\n\nDone. ${written} projections written.`,
)
process.exit(0)
