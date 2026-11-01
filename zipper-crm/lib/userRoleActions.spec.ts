/**
 * The user page's ROLE actions and warning-deduction checks (UGP-B / UGP-D).
 *
 * ── THE BUG THIS ENCODES ────────────────────────────────────────────────────
 *
 * Screenshot S1: a guest with no role at all was offered "Revoke host" and
 * "Remove seller". The two specs had no `states` and were not policy keys, so
 * `!spec.states` let them through for every ordinary account, and no role
 * record was read. The page now renders role buttons ONLY from the server's
 * role inventory, through this module.
 *
 * REAL: `lib/userRoleActions.ts`, imported and called.
 *
 *   npm run test:userroles
 */

import {
  deductionProblem,
  deductionSummary,
  heldSummary,
  roleButtons,
  type UserRoles,
} from './userRoleActions'

let checks = 0
const failures: string[] = []

function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}

function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

const roles = (r: Partial<UserRoles>): UserRoles => ({
  uid: 'u', held_count: 0, roles: [], deduction_currencies: ['diamonds'], verified_contact: true, ...r,
})

// ── S1: a guest with no role ────────────────────────────────────────────────
eq('a guest with no role gets NO role button', roleButtons(roles({})), [])
eq('…nor while the inventory is loading', roleButtons(null), [])
eq('…nor when it failed', roleButtons(undefined), [])
ok('…and the page says so', heldSummary(roles({})) === 'No partner or host role.')

// ── One active role → suspend only ─────────────────────────────────────────
const hostOnly = roles({
  held_count: 1,
  roles: [{ role: 'host', label: 'Host', status: 'active', actions: [] }],
})
eq('one role → no revoke button (suspend the account instead)', roleButtons(hostOnly), [])
ok('…and the page names the rule', heldSummary(hostOnly).includes('only role') && heldSummary(hostOnly).includes('suspend'))

// ── Several roles → revoke one specific role ───────────────────────────────
const two = roles({
  held_count: 2,
  roles: [
    { role: 'host', label: 'Host', status: 'active', actions: ['revoke'] },
    { role: 'seller', label: 'Coin Seller', id: 'S1', status: 'approved', actions: ['revoke'] },
  ],
})
const b = roleButtons(two)
eq('two roles → one revoke button per role', b.map((x) => x.label), ['Revoke Host', 'Revoke Coin Seller'])
eq('…the seller button targets its own record', b[1].targetId, 'S1')
eq('…the host button targets no partner record', b[0].targetId, '')
ok('…and says the other roles stay', b[1].effect.includes('other roles'))
ok('the summary lists both', heldSummary(two) === 'Holds Host + Coin Seller.')

// ── Restore ────────────────────────────────────────────────────────────────
const revoked = roles({
  roles: [
    { role: 'host', label: 'Host', status: 'revoked', actions: ['restore'], restorable: true },
    { role: 'agency', label: 'Agency', id: 'A1', status: 'suspended', actions: ['restore'] },
  ],
})
eq('restore buttons for a restorable Host and a suspended Agency',
  roleButtons(revoked).map((x) => x.label), ['Restore Host', 'Restore Agency'])
ok('…restoring re-activates the EXISTING record', roleButtons(revoked)[0].effect.includes('EXISTING'))

// A partner record with no id cannot be acted on — no button rather than a broken call.
eq('a partner role with no id yields no button',
  roleButtons(roles({ roles: [{ role: 'seller', label: 'Coin Seller', status: 'approved', actions: ['revoke'] }] })), [])
// ── GOV C2: restoring a REVOKED role is the Owner's decision ───────────────
eq('the REVOKED Host\'s restore is Owner-only; the SUSPENDED Agency\'s keeps its permission',
  roleButtons(revoked).map((x) => x.ownerOnly), [true, false])
eq('a revoked partner record\'s restore is Owner-only too',
  roleButtons(roles({ roles: [{ role: 'seller', label: 'Coin Seller', id: 'S9', status: 'revoked', actions: ['restore'] }] }))
    .map((x) => x.ownerOnly), [true])
eq('a revoke is never Owner-only here (the server decides the dependents case)',
  roleButtons(two).map((x) => x.ownerOnly), [false, false])

// An unknown action string from a newer server is ignored rather than rendered.
eq('unknown actions are ignored',
  roleButtons(roles({ roles: [{ role: 'host', label: 'Host', status: 'active', actions: ['transfer' as never] }] })), [])

// ── Warning deduction ──────────────────────────────────────────────────────
const bal = { diamonds: 120, beansAvailable: 40 }
eq('a deduction within the live balance is fine', deductionProblem('50', 'diamonds', ['diamonds'], bal), '')
ok('…more than the balance is refused, saying what is there',
  deductionProblem('121', 'diamonds', ['diamonds'], bal).includes('120'))
ok('…beans are checked against RELEASED beans',
  deductionProblem('41', 'beans', ['beans'], bal).includes('released beans'))
ok('…a currency the roles do not allow is refused',
  deductionProblem('5', 'beans', ['diamonds'], bal).includes('diamonds'))
ok('…zero, negatives and fractions are refused',
  ['0', '-3', '2.5', '', 'abc'].every((v) => deductionProblem(v, 'diamonds', ['diamonds'], bal) !== ''))
const s = deductionSummary('Guest yrfdp', '50', 'diamonds', bal)
ok('the confirmation names amount, currency, person and balance',
  s.includes('50') && s.includes('diamonds') && s.includes('Guest yrfdp') && s.includes('120'))
ok('…and says an owner signs before anything is taken', s.includes('owner signs'))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} user-role checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} user-role checks passed.`)
console.log('  · role buttons come only from the server inventory — none for a guest')
console.log('  · one role → no revoke; several → one revoke per role; restore re-uses the record')
console.log('  · a deduction is validated against the role currency and the live balance')
