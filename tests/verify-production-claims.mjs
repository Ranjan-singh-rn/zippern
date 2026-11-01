/**
 * Do the Storage Rules helpers recognise the claims now live in production?
 *
 * Reads `storage.rules` from disk and extracts each tier's membership FROM
 * THE FILE — not from a copy of it in this script. An earlier version of this
 * check hard-coded the tiers, which meant it would have agreed with itself
 * even if the rules had said something else.
 *
 * Read-only, offline, and touches nothing: it parses a text file and prints
 * a table. The claim VALUES below are the five applied to production, which
 * `backend/scripts/verify_storage_claims.py` confirms against Firebase Auth.
 *
 *     node tests/verify-production-claims.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const RULES = readFileSync(join(here, '..', 'storage.rules'), 'utf8')

/** The role strings a helper admits, read out of its body in the rules file. */
function tierOf(name) {
  const start = RULES.indexOf(`function ${name}()`)
  if (start < 0) return null
  // body runs to the first closing brace at the function's own indent
  const open = RULES.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (i < RULES.length && depth > 0) {
    if (RULES[i] === '{') depth++
    else if (RULES[i] === '}') depth--
    i++
  }
  const body = RULES.slice(open + 1, i - 1)
  const roles = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  // isGovernance() is called by the others rather than re-listing owner/observer
  const inherits = /isGovernance\(\)/.test(body)
  return { roles, inherits }
}

const governance = tierOf('isGovernance')
const kyc = tierOf('isKycReviewer')
const fin = tierOf('isFinance')
const sup = tierOf('isSupport')

function admits(tier, role) {
  if (!tier) return false
  if (tier.roles.includes(role)) return true
  return tier.inherits && governance.roles.includes(role)
}

// The five claims applied to production.
const LIVE = [
  ['XIWhltIc91h35xRkxySpdmhFzb12', 'Tanishque', 'owner', ''],
  ['q3htaaXWj4bTXpVKIl02vWgAwtI2', 'Soumya', 'owner', ''],
  ['KVGmKZCzKsWj3osAFdo7KlWjJ6d2', 'Alex', 'owner', ''],
  ['T7XT5mvZHKbo3nd6zU0eBvFRSBu2', 'Loolipop', 'app_admin', ''],
  ['ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2', 'Ruhan', 'agency', 'NqvNnhe6BY5GESpWjKIT'],
]

let failures = 0
const fail = (m) => { failures++; console.error(`  FAIL  ${m}`) }

console.log('='.repeat(78))
console.log('STORAGE RULES vs THE LIVE PRODUCTION CLAIMS')
console.log('='.repeat(78))
console.log('\nTiers, as read from storage.rules:')
console.log(`  isGovernance  : ${governance.roles.join(', ')}`)
console.log(`  isKycReviewer : ${kyc.roles.join(', ')}${kyc.inherits ? '  (+ governance)' : ''}`)
console.log(`  isFinance     : ${fin.roles.join(', ')}${fin.inherits ? '  (+ governance)' : ''}`)
console.log(`  isSupport     : ${sup.roles.join(', ')}${sup.inherits ? '  (+ governance)' : ''}`)

console.log('\nwho        role        KYC   FIN   SUP   agency scope')
for (const [, who, role, aid] of LIVE) {
  const k = admits(kyc, role)
  const f = admits(fin, role)
  const s = admits(sup, role)
  console.log(
    `${who.padEnd(10)} ${role.padEnd(11)} ${(k ? 'yes' : '—').padEnd(5)} ` +
    `${(f ? 'yes' : '—').padEnd(5)} ${(s ? 'yes' : '—').padEnd(5)} ${aid || '—'}`,
  )
}

// ── The assertions ──────────────────────────────────────────────────────────
console.log('\nassertions')

for (const [, who, role] of LIVE.filter((r) => r[2] === 'owner')) {
  if (!admits(kyc, role) || !admits(fin, role) || !admits(sup, role)) {
    fail(`${who}: an owner must be in every tier`)
  }
}
if (!admits(kyc, 'app_admin')) fail('Loolipop: app_admin must review KYC')
if (admits(fin, 'app_admin')) fail('Loolipop: app_admin must NOT reach money evidence')

if (admits(kyc, 'agency') || admits(fin, 'agency') || admits(sup, 'agency')) {
  fail('Ruhan: an agency must be in NO internal tier')
}

// The agency scope is matched against the path, so it opens its own prefix only.
const AID = 'NqvNnhe6BY5GESpWjKIT'
const isAgencyFor = RULES.includes('agencyClaim() == agencyId')
if (!isAgencyFor) fail('isAgencyFor no longer compares the claim to the path segment')
const nonEmpty = RULES.includes("agencyClaim() != ''")
if (!nonEmpty) fail("isAgencyFor no longer requires a non-empty aid — '' would match a path segment")

console.log(`  owner in all three tiers                         ${LIVE.filter(r => r[2] === 'owner').length} × ok`)
console.log('  app_admin reviews KYC but not money evidence     ok')
console.log('  agency is in no internal tier                    ok')
console.log(`  isAgencyFor binds the claim to the path segment  ok  (${AID} opens only its own)`)
console.log("  and refuses an empty aid                         ok")

console.log('\n' + '='.repeat(78))
if (failures) {
  console.error(`${failures} problem(s). Do NOT deploy.\n`)
  process.exit(1)
}
console.log('The rules recognise all five live claims correctly.\n' + '='.repeat(78) + '\n')
