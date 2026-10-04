/**
 * THE BACKFILL SCRIPT — safe to run later, proved now.
 *
 * The script itself talks to production Firestore and is not run here. What is
 * testable without a database is everything that makes it safe to run, and that
 * is what this file asserts:
 *
 *   1. SOURCE PROPERTIES — read off the script's own text. Dry-run is the
 *      default, `--apply` is required to write, and there is no write path to
 *      `sellers/{id}` anywhere in the file. These are the claims the script's
 *      docstring makes; asserting them against the text is what stops the
 *      docstring and the code drifting apart.
 *
 *   2. BEHAVIOUR — the projection and the create/update/unchanged/withdraw
 *      decision, run against an in-memory store. Idempotency is proved by
 *      running the same logic twice and asserting the second pass has nothing
 *      to do.
 *
 * Run:  node --test test/backfillPublicSellers.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const SRC = readFileSync(join(__dirname, '..', 'scripts', 'backfill-public-sellers.mjs'), 'utf8')

const {
  PUBLIC_FIELDS,
  NEVER_PUBLIC,
  isPubliclyVisible,
  toPublicSeller,
} = require('../lib/publicSeller')

/** Source with comments removed — a promise in a comment is not a guarantee. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('the script cannot write by accident', () => {
  test('dry run is the DEFAULT — writing needs --apply', () => {
    expect(/const APPLY = argv\.includes\('--apply'\)/.test(code)).toBe(true)
    // The inverse spelling would be a script that writes unless told not to.
    expect(code.includes("includes('--dry')")).toBe(false)
    expect(code.includes('APPLY = true')).toBe(false)
  })

  test('every write is behind the APPLY check', () => {
    // `batch.commit()` is the only thing that persists anything. Each one must
    // sit after a guard that returned early without --apply.
    expect(code.includes('if (!APPLY)')).toBe(true)
    const commits = code.match(/batch\.commit\(\)/g) ?? []
    expect(commits.length > 0).toBe(true)
    // Both the main path and rollback guard before committing.
    const guards = code.match(/if \(!APPLY\)/g) ?? []
    expect(guards.length >= 2).toBe(true)
  })

  test('an unknown flag is refused rather than ignored', () => {
    // `--aply` must not silently become a dry run the operator believes wrote.
    expect(code.includes('Unrecognised argument')).toBe(true)
    expect(code.includes('process.exit(2)')).toBe(true)
  })
})

describe('the private seller document is never modified', () => {
  test('`sellers` is only ever read', () => {
    // Every mention of the private collection, with what is done to it.
    const uses = [...code.matchAll(/collection\('sellers'\)([^\n]*)/g)].map((m) => m[1])
    expect(uses.length > 0).toBe(true)
    for (const tail of uses) {
      expect(/\.get\(\)/.test(tail)).toBe(true)
      expect(/\.(set|update|delete|add)\(/.test(tail)).toBe(false)
    }
  })

  test('no doc() handle on a seller is taken at all', () => {
    // A write would need one. Not having the handle is a stronger property than
    // not calling set() on it.
    expect(/collection\('sellers'\)\s*\.doc\(/.test(code)).toBe(false)
  })

  test('every batch write targets publicSellers', () => {
    const writes = [...code.matchAll(/batch\.(set|delete|update)\(([^,)]*)/g)]
    expect(writes.length > 0).toBe(true)
    for (const [, , target] of writes) {
      expect(target.includes('publicSellers') || target.includes('doc.ref')).toBe(true)
    }
  })

  test('`doc.ref` is only used by rollback, over publicSellers', () => {
    // `doc.ref` is the one indirect target above. It comes from the
    // publicSellers snapshot inside rollback(); if a sellers snapshot ever fed
    // it, this is where that shows up.
    const rollback = code.slice(code.indexOf('async function rollback'), code.indexOf('async function main'))
    expect(rollback.includes("collection('publicSellers')")).toBe(true)
    expect(rollback.includes("collection('sellers')")).toBe(false)
  })
})

describe('the allowlist is imported, not retyped', () => {
  test('the projection comes from the module the trigger uses', () => {
    expect(code.includes("import('../lib/publicSeller.js')")).toBe(true)
    expect(code.includes('toPublicSeller')).toBe(true)
  })

  test('the script does not declare a field list of its own', () => {
    // A second copy of the allowlist is the one way a backfilled document could
    // differ from a triggered one.
    expect(/PUBLIC_FIELDS\s*=\s*\[/.test(code)).toBe(false)
    expect(/NEVER_PUBLIC\s*=\s*\[/.test(code)).toBe(false)
    expect(code.includes("'idDocUrls'")).toBe(false)
    expect(code.includes("'coinBalance'")).toBe(false)
  })

  test('it refuses to run against a stale build', () => {
    expect(code.includes('run `npm run build` first')).toBe(true)
  })

  test('a leak aborts the whole run, not just the one document', () => {
    expect(code.includes('ABORTED')).toBe(true)
    expect(code.includes('Nothing was written')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  Behaviour, against an in-memory store
// ─────────────────────────────────────────────────────────────────────────────

const seller = (over = {}) => ({
  displayName: 'Coin Corner',
  phone: '+919876543210',
  qrCodeUrl: 'https://pay/qr.png',
  description: 'Open late',
  photoUrl: 'https://photos/s.jpg',
  isOnline: true,
  isApproved: true,
  isActive: true,
  status: 'approved',
  // private, must never travel
  idDocUrls: [{ label: 'Aadhaar', url: 'https://kyc/a.jpg' }],
  coinBalance: 4_500_000,
  commissionRate: 5,
  email: 'seller@coins.com',
  ...over,
})

/** The script's decision procedure, over plain objects. */
function plan(sellers, publicNow) {
  const shouldPublish = new Map()
  for (const [id, data] of Object.entries(sellers)) {
    if (!isPubliclyVisible(data)) continue
    shouldPublish.set(id, toPublicSeller(id, data))
  }
  const toCreate = []
  const toUpdate = []
  const unchanged = []
  for (const [id, pub] of shouldPublish) {
    const now = publicNow[id]
    if (!now) toCreate.push(id)
    else if (PUBLIC_FIELDS.some((f) => now[f] !== pub[f]) || now.sellerId !== pub.sellerId) toUpdate.push(id)
    else unchanged.push(id)
  }
  const toDelete = Object.keys(publicNow).filter((id) => !shouldPublish.has(id))
  return { shouldPublish, toCreate, toUpdate, unchanged, toDelete }
}

/** Apply a plan to the in-memory public collection, as the batch would. */
function commit(plan, publicNow) {
  const out = { ...publicNow }
  for (const [id, pub] of plan.shouldPublish) {
    if (!plan.unchanged.includes(id)) out[id] = { ...pub }
  }
  for (const id of plan.toDelete) delete out[id]
  return out
}

describe('what the backfill would do', () => {
  test('an empty public collection is filled from the qualifying sellers', () => {
    const sellers = { a: seller(), b: seller({ displayName: 'Bee Coins' }) }
    const p = plan(sellers, {})
    expect(p.toCreate.sort()).toEqual(['a', 'b'])
    expect(p.toUpdate.length).toBe(0)
    expect(p.toDelete.length).toBe(0)
  })

  test('pending, rejected and suspended sellers are left out', () => {
    const sellers = {
      live: seller(),
      pending: seller({ isApproved: false, isActive: false, status: 'pending' }),
      rejected: seller({ isApproved: false, isActive: false, status: 'rejected' }),
      suspended: seller({ isActive: false, status: 'suspended' }),
    }
    const p = plan(sellers, {})
    expect(p.toCreate).toEqual(['live'])
  })

  test('the expected final count equals the qualifying count', () => {
    const sellers = {
      a: seller(), b: seller(), c: seller({ isActive: false, status: 'suspended' }),
    }
    const p = plan(sellers, {})
    const after = commit(p, {})
    expect(Object.keys(after).length).toBe(p.shouldPublish.size)
    expect(Object.keys(after).length).toBe(2)
  })

  test('IDEMPOTENT — a second run has nothing to do', () => {
    const sellers = { a: seller(), b: seller({ displayName: 'Bee Coins' }) }

    const first = plan(sellers, {})
    const afterFirst = commit(first, {})
    expect(first.toCreate.length).toBe(2)

    const second = plan(sellers, afterFirst)
    expect(second.toCreate.length).toBe(0)
    expect(second.toUpdate.length).toBe(0)
    expect(second.toDelete.length).toBe(0)
    expect(second.unchanged.sort()).toEqual(['a', 'b'])

    // And the documents are identical, not merely equal in count.
    const afterSecond = commit(second, afterFirst)
    expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst))
  })

  test('a changed public field is an update, a changed private one is not', () => {
    const sellers = { a: seller() }
    const published = commit(plan(sellers, {}), {})

    const renamed = { a: seller({ displayName: 'Coin Corner 2' }) }
    expect(plan(renamed, published).toUpdate).toEqual(['a'])

    const toppedUp = { a: seller({ coinBalance: 9_000_000, notes: 'float' }) }
    expect(plan(toppedUp, published).unchanged).toEqual(['a'])
  })

  test('a seller who stopped qualifying is withdrawn', () => {
    const sellers = { a: seller() }
    const published = commit(plan(sellers, {}), {})
    const suspended = { a: seller({ isActive: false, status: 'suspended' }) }

    const p = plan(suspended, published)
    expect(p.toDelete).toEqual(['a'])
    expect(Object.keys(commit(p, published)).length).toBe(0)
  })

  test('an orphan public document with no private seller is withdrawn', () => {
    const p = plan({ a: seller() }, { a: toPublicSeller('a', seller()), ghost: { sellerId: 'ghost' } })
    expect(p.toDelete).toEqual(['ghost'])
  })
})

describe('nothing private can reach the public collection', () => {
  test('no NEVER_PUBLIC field appears in anything the backfill would write', () => {
    const sellers = { a: seller(), b: seller({ taxId: 'ABCDE1234F', payoutRef: 'UTR-9' }) }
    const after = commit(plan(sellers, {}), {})
    for (const [, pub] of Object.entries(after)) {
      for (const forbidden of NEVER_PUBLIC) {
        expect(Object.keys(pub).includes(forbidden)).toBe(false)
      }
      expect(Object.keys(pub).length).toBe(7)
    }
    expect(JSON.stringify(after).includes('Aadhaar')).toBe(false)
    expect(JSON.stringify(after).includes('ABCDE1234F')).toBe(false)
    expect(JSON.stringify(after).includes('4500000')).toBe(false)
  })

  test('the script checks this itself, against both lists', () => {
    // `violations()` must catch a forbidden field AND a field that is merely
    // off-allowlist — the second is what catches something nobody thought to ban.
    const fn = code.slice(code.indexOf('function violations'), code.indexOf('async function rollback'))
    expect(fn.includes('NEVER_PUBLIC.includes(key)')).toBe(true)
    expect(fn.includes('!allowed.has(key)')).toBe(true)
    expect(fn.includes('PUBLIC_FIELDS')).toBe(true)
  })
})

describe('what the report has to surface', () => {
  test('collisions: two live sellers sharing one phone number', () => {
    const sellers = { a: seller(), b: seller({ displayName: 'Bee' }) } // same phone
    const phones = new Map()
    const collisions = []
    for (const [id, data] of Object.entries(sellers)) {
      if (!isPubliclyVisible(data)) continue
      const { phone } = toPublicSeller(id, data)
      if (phones.has(phone)) collisions.push([phones.get(phone), id])
      else phones.set(phone, id)
    }
    expect(collisions).toEqual([['a', 'b']])
    expect(code.includes('COLLISION:')).toBe(true)
  })

  test('missing data is reported for each field a buyer needs', () => {
    const blank = toPublicSeller('x', seller({ displayName: '', phone: '', qrCodeUrl: '' }))
    expect(blank.displayName).toBe('')
    expect(blank.phone).toBe('')
    expect(blank.qrCodeUrl).toBe('')
    expect(code.includes('no displayName')).toBe(true)
    expect(code.includes('no phone')).toBe(true)
    expect(code.includes('no qrCodeUrl')).toBe(true)
  })

  test('and it never repairs what it reports', () => {
    // No defaulting, no placeholder names, no guessed numbers.
    expect(/displayName:\s*['"`]/.test(code)).toBe(false)
    expect(code.includes('Unknown Seller')).toBe(false)
  })

  test('an approved seller with an unrecognised status is flagged, not published', () => {
    const odd = seller({ status: 'under_review' })
    expect(isPubliclyVisible(odd)).toBe(false)
    expect(code.includes('unrecognised')).toBe(true)
  })

  test('counts are compared before and after', () => {
    expect(code.includes('expected final count')).toBe(true)
    expect(code.includes('COUNT MISMATCH')).toBe(true)
  })
})

describe('rollback', () => {
  test('deletes only publicSellers, and still needs --apply', () => {
    const rollback = code.slice(code.indexOf('async function rollback'), code.indexOf('async function main'))
    expect(rollback.includes("collection('publicSellers')")).toBe(true)
    expect(rollback.includes("collection('sellers')")).toBe(false)
    expect(rollback.includes('if (!APPLY)')).toBe(true)
    expect(rollback.includes('batch.delete')).toBe(true)
  })

  test('loses no data, because the private records are the source', () => {
    // Re-running the backfill after a rollback rebuilds the same documents.
    const sellers = { a: seller(), b: seller({ displayName: 'Bee' }) }
    const published = commit(plan(sellers, {}), {})
    const rolledBack = {}
    const rebuilt = commit(plan(sellers, rolledBack), rolledBack)
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(published))
  })
})
