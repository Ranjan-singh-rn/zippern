/**
 * B7 (3 Nov 2026) — Party Pro settings are cleaned and priced exactly as the server does.
 *
 *   npm run test:partypro
 */

import * as fs from 'fs'
import * as path from 'path'
import { mergeSubConfig, priceInDiamonds } from './partyProGuard'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${claim}\n        got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

eq('defaults: on, required, ₹200, level 7, 30 days', mergeSubConfig(undefined),
  { enabled: true, required: true, priceInr: 200, priceDiamonds: 0, minLevel: 7, days: 30 })
eq('₹200 at ₹2390 a lakh = 8369 diamonds (the server\'s own number)', priceInDiamonds(mergeSubConfig(undefined), 2390), 8369)
eq('the Owner\'s diamond price wins', priceInDiamonds(mergeSubConfig({ priceDiamonds: 5000 }), 2390), 5000)
eq('clamped: days 1–366, level 0–100', mergeSubConfig({ days: 9999, minLevel: -3 }).days, 366)
eq('a negative level is 0', mergeSubConfig({ minLevel: -3 }).minLevel, 0)

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'app-config', 'party-pro', 'page.tsx'), 'utf8')
ok("the page is the Owner's", page.includes("canAccess(crmUser, ['superadmin'])"))
ok('the page saves the cleaned config', page.includes('mergeSubConfig(') && page.includes("doc(db, 'appConfig', 'partySubscription')"))
const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
const ownerOnly = (id: string) => new RegExp(`function ownerOnlyConfig\\(\\) \\{\\s*return docId in \\[[^\\]]*'${id}'[^\\]]*\\];`).test(rules) && rules.includes('(ownerOnlyConfig() && isSuperAdmin())')
ok("rules: appConfig/partySubscription is the Owner's alone", ownerOnly('partySubscription'))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} Party Pro checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} Party Pro checks passed.`)
