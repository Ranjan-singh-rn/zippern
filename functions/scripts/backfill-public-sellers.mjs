/**
 * BACKFILL `publicSellers` — reports by default, writes only when told to.
 *
 * ── WHY A BACKFILL IS NEEDED AT ALL ─────────────────────────────────────────
 *
 * `syncPublicSeller` is an `onWrite` trigger. It fires when a seller document
 * changes, and it has never fired for any seller that existed before it was
 * deployed. So on the day the rules ship, `publicSellers` is EMPTY and
 * `ResellerListScreen` shows nothing — every approved seller on the platform
 * disappears from the directory until something happens to touch their record,
 * which for a settled seller is never.
 *
 * That is the failure this closes. Note which way it fails: a blank list, not a
 * leak. The private collection stays private throughout.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 *   · It will not write anything without `--apply`. The default is a report.
 *   · It will not touch `sellers/{id}`. It opens that collection for READING
 *     and there is no code path in this file that writes, merges or deletes a
 *     private seller document. `test/backfillPublicSellers.test.js` asserts
 *     that against this source text, so adding one later fails a test.
 *   · It will not publish a field outside the allowlist. Every projected
 *     document is checked against `NEVER_PUBLIC` before anything is written, and
 *     a single violation ABORTS THE WHOLE RUN before the first write. A partial
 *     backfill that leaked one seller's KYC would be worse than no backfill.
 *   · It will not merge, guess or repair. A seller missing a display name is
 *     REPORTED, not invented.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * The projection is `toPublicSeller` from `lib/publicSeller.js` — the same
 * function the trigger calls, imported rather than reimplemented, so a
 * backfilled document is byte-identical to a triggered one and a second run is a
 * no-op. The script reports new / changed / unchanged separately so you can see
 * that for yourself.
 *
 * ── ROLLBACK ────────────────────────────────────────────────────────────────
 *
 *   node scripts/backfill-public-sellers.mjs --rollback --apply
 *
 * Deletes every `publicSellers` document and nothing else. The private
 * collection is untouched, so rollback loses no data: re-running the backfill
 * rebuilds the public view exactly. Pair it with reverting the Android app, or
 * the directory will read an empty collection.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *     cd functions && npm run build
 *
 *     node scripts/backfill-public-sellers.mjs              # report only
 *     node scripts/backfill-public-sellers.mjs --verbose     # with per-seller rows
 *     node scripts/backfill-public-sellers.mjs --apply       # write
 *     node scripts/backfill-public-sellers.mjs --rollback --apply
 *
 * Run the report first and read the WARNINGS section. `--apply` prints the same
 * report and then writes.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'
import { guardKeyScript } from './_keyScriptGuard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// P0-10 (OPS-C): this key reaches a REAL project — named, acknowledged and (for
// a run that writes) confirmed before Firebase is initialised. See _keyScriptGuard.mjs.
const GUARDED_PROJECT = guardKeyScript('backfill-public-sellers', {
  keyPath: new URL('../../serviceAccountKey.json', import.meta.url),
  writes: process.argv.includes('--apply'),
})
const keyPath = resolve(here, '../../serviceAccountKey.json')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ROLLBACK = argv.includes('--rollback')
const VERBOSE = argv.includes('--verbose')

const unknown = argv.filter((a) => !['--apply', '--rollback', '--verbose'].includes(a))
if (unknown.length) {
  console.error(`Unrecognised argument: ${unknown.join(' ')}`)
  console.error('Known flags: --apply --rollback --verbose')
  process.exit(2)
}

// ── Connect ──────────────────────────────────────────────────────────────────

let credential
try {
  credential = admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8')))
} catch {
  console.error(`Could not read the service account key at ${keyPath}`)
  process.exit(1)
}
admin.initializeApp({ credential })
const db = admin.firestore()

/*
 * The allowlist and the projection, from the compiled module the trigger uses.
 *
 * Imported, never retyped. A Python or hand-copied version of this list is the
 * one thing that could make a backfilled document differ from a triggered one,
 * and "differ" here means publishing a field the allowlist excludes.
 *
 * `?? mod.default?.x` because this is CommonJS loaded from an ES module: Node
 * usually finds the named export and sometimes puts module.exports on `default`.
 */
const mod = await import('../lib/publicSeller.js')
const toPublicSeller = mod.toPublicSeller ?? mod.default?.toPublicSeller
const isPubliclyVisible = mod.isPubliclyVisible ?? mod.default?.isPubliclyVisible
const PUBLIC_FIELDS = mod.PUBLIC_FIELDS ?? mod.default?.PUBLIC_FIELDS
const NEVER_PUBLIC = mod.NEVER_PUBLIC ?? mod.default?.NEVER_PUBLIC

if (
  typeof toPublicSeller !== 'function' ||
  typeof isPubliclyVisible !== 'function' ||
  !Array.isArray(PUBLIC_FIELDS) ||
  !Array.isArray(NEVER_PUBLIC)
) {
  console.error('Could not load publicSeller.js — run `npm run build` first.')
  process.exit(1)
}

// ── The safety net ───────────────────────────────────────────────────────────

/**
 * Would this projected document publish anything it must not?
 *
 * Redundant by construction: `toPublicSeller` builds a literal from the
 * allowlist and could not emit a forbidden key if it tried. Checked anyway,
 * because the cost of being wrong is somebody's identity document in a
 * world-readable collection, and because this is the assertion that will still
 * be here if the projection is ever rewritten.
 *
 * Both halves matter: a forbidden KEY, and a key outside the allowlist at all.
 * The second catches a field nobody thought to forbid.
 */
function violations(sellerId, pub) {
  const allowed = new Set([...PUBLIC_FIELDS, 'sellerId', 'updatedAt'])
  const found = []
  for (const key of Object.keys(pub)) {
    if (NEVER_PUBLIC.includes(key)) found.push(`${sellerId}: FORBIDDEN field '${key}'`)
    else if (!allowed.has(key)) found.push(`${sellerId}: field '${key}' is not on the allowlist`)
  }
  return found
}

// ── Rollback ─────────────────────────────────────────────────────────────────

async function rollback() {
  const snap = await db.collection('publicSellers').get()
  console.log(`\npublicSellers holds ${snap.size} document(s).`)
  if (!APPLY) {
    console.log('DRY RUN — would delete all of them. Re-run with --apply to do it.')
    console.log('The private `sellers` collection is not read or written by rollback.')
    return 0
  }
  let batch = db.batch()
  let n = 0
  for (const doc of snap.docs) {
    batch.delete(doc.ref)
    if (++n % 400 === 0) {
      await batch.commit()
      batch = db.batch()
    }
  }
  if (n % 400 !== 0) await batch.commit()
  console.log(`Deleted ${n} document(s) from publicSellers. sellers/ untouched.`)
  return 0
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (ROLLBACK) return rollback()

  console.log(APPLY ? '\n*** APPLY — this run writes ***' : '\nDRY RUN — nothing will be written.')

  // READ ONLY. Deliberately unfiltered: `isPubliclyVisible` is the single
  // authority on who qualifies, and a `where()` clause here would be a second,
  // slightly different answer to the same question — which is how the pending
  // sellers got into the directory in the first place.
  const sellers = await db.collection('sellers').get()
  const existing = await db.collection('publicSellers').get()

  const existingById = new Map(existing.docs.map((d) => [d.id, d.data()]))
  const shouldPublish = new Map()

  const warnings = []
  const phoneOwners = new Map()
  let qualifying = 0
  let skipped = 0

  for (const doc of sellers.docs) {
    const data = doc.data()
    if (!isPubliclyVisible(data)) {
      skipped += 1
      // A record that is approved but carries a status this build does not know
      // fails closed and vanishes from the directory. That is the right default
      // and the wrong thing to do silently.
      const status = String(data.status ?? '').trim()
      const known = ['', 'approved', 'pending', 'rejected', 'suspended']
      if (data.isApproved === true && data.isActive === true && !known.includes(status)) {
        warnings.push(`${doc.id}: approved and active but status '${status}' is unrecognised — will NOT appear`)
      }
      continue
    }
    qualifying += 1
    const pub = toPublicSeller(doc.id, data)

    const bad = violations(doc.id, pub)
    if (bad.length) warnings.push(...bad.map((v) => `LEAK: ${v}`))

    // Missing data: reported, never invented. A row with no name and no number
    // is a row a buyer cannot use.
    if (!pub.displayName) warnings.push(`${doc.id}: no displayName — would show a blank row`)
    if (!pub.phone) warnings.push(`${doc.id}: no phone — a buyer cannot reach them`)
    if (!pub.qrCodeUrl) warnings.push(`${doc.id}: no qrCodeUrl — a buyer cannot pay them`)

    // Collision: two live sellers sharing a phone number. Not fatal, and not
    // something to resolve here — but a buyer reading the directory cannot tell
    // them apart, and whoever answers takes the money.
    if (pub.phone) {
      const prior = phoneOwners.get(pub.phone)
      if (prior) warnings.push(`COLLISION: ${doc.id} and ${prior} share the phone ${pub.phone}`)
      else phoneOwners.set(pub.phone, doc.id)
    }

    shouldPublish.set(doc.id, pub)
  }

  // ── Count comparison ──────────────────────────────────────────────────────

  const toCreate = []
  const toUpdate = []
  const unchanged = []
  for (const [id, pub] of shouldPublish) {
    const now = existingById.get(id)
    if (!now) toCreate.push(id)
    // Structural comparison: `paymentMethods` is an array, and `!==` on two
    // equal arrays is always true, which would rewrite every seller every run.
    else if (PUBLIC_FIELDS.some((f) => JSON.stringify(now[f]) !== JSON.stringify(pub[f])) || now.sellerId !== pub.sellerId) toUpdate.push(id)
    else unchanged.push(id)
  }
  // Present in the public collection and no longer entitled to be — a seller
  // suspended while the trigger was not deployed, or a record deleted outright.
  const toDelete = [...existingById.keys()].filter((id) => !shouldPublish.has(id))

  console.log(`\n── Counts ──────────────────────────────────────────────`)
  console.log(`  sellers (private)          ${sellers.size}`)
  console.log(`  qualifying for publication ${qualifying}`)
  console.log(`  not qualifying             ${skipped}`)
  console.log(`  publicSellers now          ${existing.size}`)
  console.log(`  → to create                ${toCreate.length}`)
  console.log(`  → to update                ${toUpdate.length}`)
  console.log(`  → already correct          ${unchanged.length}`)
  console.log(`  → to withdraw              ${toDelete.length}`)
  console.log(`  expected final count       ${qualifying}`)

  if (VERBOSE) {
    for (const id of toCreate) console.log(`    create  ${id}  ${shouldPublish.get(id).displayName}`)
    for (const id of toUpdate) console.log(`    update  ${id}  ${shouldPublish.get(id).displayName}`)
    for (const id of toDelete) console.log(`    withdraw ${id}`)
  }

  if (warnings.length) {
    console.log(`\n── WARNINGS (${warnings.length}) ───────────────────────────────`)
    for (const w of warnings) console.log(`  · ${w}`)
  } else {
    console.log('\nNo warnings.')
  }

  // A leak aborts everything, before the first write. Not "skip that one" — if
  // the projection can emit a forbidden field then the projection is broken, and
  // the rest of the run is not trustworthy either.
  const leaks = warnings.filter((w) => w.startsWith('LEAK:'))
  if (leaks.length) {
    console.error(`\nABORTED: ${leaks.length} document(s) would publish a non-public field.`)
    console.error('Nothing was written. Fix lib/publicSeller.ts and rebuild.')
    return 1
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once the warnings are understood.')
    console.log('`sellers/` was opened for reading only; this script has no write path to it.')
    return 0
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  //
  // Only `publicSellers`. Batched at 400 (the limit is 500) so one oversized
  // batch cannot fail the run halfway.
  let batch = db.batch()
  let ops = 0
  const flush = async () => {
    if (ops) await batch.commit()
    batch = db.batch()
    ops = 0
  }

  let written = 0
  for (const [id, pub] of shouldPublish) {
    if (unchanged.includes(id)) continue
    batch.set(db.collection('publicSellers').doc(id), {
      ...pub,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    written += 1
    if (++ops >= 400) await flush()
  }
  for (const id of toDelete) {
    batch.delete(db.collection('publicSellers').doc(id))
    if (++ops >= 400) await flush()
  }
  await flush()

  const after = await db.collection('publicSellers').get()
  console.log(`\nWrote ${written}, withdrew ${toDelete.length}.`)
  console.log(`publicSellers now holds ${after.size}; expected ${qualifying}.`)
  if (after.size !== qualifying) {
    console.error('COUNT MISMATCH — investigate before trusting the directory.')
    return 1
  }
  console.log('Counts agree. The private `sellers` collection was not modified.')
  return 0
}

process.exit(await main())
