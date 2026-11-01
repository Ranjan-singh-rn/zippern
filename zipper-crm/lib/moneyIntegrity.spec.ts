/**
 * B1 — money integrity for Finance and the Owners: held items (and their
 * release), replica drift (and its repair), Owner notices (and their retry),
 * and the payout release policy on /finance/payouts.
 *
 * REAL: `lib/moneyIntegrity.ts`, imported and run. Who is offered what is
 * asserted for every CRM role against the server's gates, which are read out
 * of `backend/app/routers/partner_ops.py` and `services/money_freeze.py` when
 * the backend sits beside this repo. The pages are checked on their source.
 *
 *   npm run test:moneyintegrity
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  MIN_RELEASE_REASON, OWNER_NOTICE_ACTION_LABEL, RELEASE_NEEDS,
  amountText, driftRowsFrom, groupIndian, heldRowsFrom, inrMinor, moneyIntegrityAccess, noticeRowsFrom,
  payoutPolicyLines, releaseReasonProblem, repairSummaryLine, retrySummaryLine,
} from './moneyIntegrity'

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

// ── 1. who is offered what — every role ──────────────────────────────────────
//
// `can_process_payout` per `roles.PERMISSIONS` (and the CRM's DEFAULT_PERMISSIONS):
// the Owner, finance_admin and finance_member. Release additionally needs the
// Finance admin seat or the Owner; Owner notices are the Owner's alone.
const PAYOUT_HOLDERS = new Set(['owner', 'finance_admin', 'finance_member'])
const ROLES = [
  'owner', 'observer', 'app_admin', 'app_member', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member',
  'tech_admin', 'tech_member', 'support_admin', 'support_member', 'marketing_admin', 'marketing_member',
  'agency', 'seller',
]
for (const role of ROLES) {
  const a = moneyIntegrityAccess({ isOwner: role === 'owner', role, canProcessPayout: PAYOUT_HOLDERS.has(role) })
  const payout = PAYOUT_HOLDERS.has(role)
  eq(`${role}: held items and drift`, [a.viewHeld, a.viewDrift, a.repairDrift], [payout, payout, payout])
  eq(`${role}: release`, a.releaseHeld, role === 'owner' || role === 'finance_admin')
  eq(`${role}: Owner notices`, [a.viewNotices, a.retryNotices], [role === 'owner', role === 'owner'])
  eq(`${role}: the page at all`, a.any, payout)
}
eq('a finance admin WITHOUT the permission is offered nothing (the server checks both)',
  moneyIntegrityAccess({ isOwner: false, role: 'finance_admin', canProcessPayout: false }).releaseHeld, false)

// ── 2. release reason ────────────────────────────────────────────────────────
ok(`${MIN_RELEASE_REASON - 1} characters → refused`, releaseReasonProblem('abcd') !== '')
eq(`${MIN_RELEASE_REASON} → fine`, releaseReasonProblem('abcde'), '')
ok('space does not count', releaseReasonProblem('  ab  ') !== '')

// ── 3. formatting ────────────────────────────────────────────────────────────
eq('Indian grouping', [groupIndian(0), groupIndian(999), groupIndian(1000), groupIndian(1234567), groupIndian(-12345678)],
  ['0', '999', '1,000', '12,34,567', '-1,23,45,678'])
eq('paise to rupees', [inrMinor(0), inrMinor(100), inrMinor(123450), inrMinor(-5)], ['₹0', '₹1', '₹1,234.50', '-₹0.05'])
eq('commission is paise; diamonds are a count', [amountText(250000, 'commission'), amountText(1500, 'diamonds'), amountText(null, 'beans')],
  ['₹2,500', '1,500 diamonds', 'amount not recorded'])

// ── 4. held items ────────────────────────────────────────────────────────────
{
  const held = (at: string, extra: Record<string, unknown> = {}) => ({
    reason: 'role_revoked', partner_kind: 'seller', partner_id: 'S1', note: 'Revoked for fraud', at,
    by: { uid: 'o1', name: 'Owner A' }, ...extra,
  })
  const rows = heldRowsFrom({
    cards: [{ id: 'c1', type: 'seller_coin_purchase', title: 'Coin purchase', amount: 5000, currency: 'coins', stage: 'awaiting_signoff', held: held('2026-10-30T10:00:00Z') }],
    recharges: [{ id: 'r1', diamonds: 1200, amount_minor: 120000, buyer_uid: 'B1', status: 'pending', held: held('2026-10-31T10:00:00Z') }],
    sales: [{ id: 's1', diamonds: 300, amount_paid_minor: 30000, buyer_uid: 'B2', status: 'pending', held: held('2026-10-29T10:00:00Z', { released_at: '2026-10-29T12:00:00Z', released_by: { name: 'Fin A' }, release_reason: 'Checked; proceed' }) }],
    subagency_payouts: [{ id: 'p1', amount_minor: 99900, parent_id: 'A1', sub_id: 'SA1', status: 'leg1_pending', held: held('2026-10-28T10:00:00Z') }, { amount_minor: 1 }],
    total: 5,
  })
  eq('all four kinds, newest hold first; a row without an id dropped', rows.map((r) => `${r.type}:${r.id}`),
    ['recharge:r1', 'card:c1', 'sale:s1', 'subagency_payout:p1'])
  eq('a card reads as its title and its money', [rows[1].title, rows[1].detail], ['Coin purchase', 'seller coin purchase · 5,000 coins · awaiting signoff'])
  eq('a recharge', [rows[0].title, rows[0].detail], ['Recharge of 1,200 diamonds', 'for B1 · ₹1,200 · pending'])
  eq('a sub-agency payout', [rows[3].title, rows[3].detail], ['Sub-agency payout of ₹999', 'A1 → SA1 · leg1_pending'])
  eq('the hold says why, for whom, by whom', [rows[1].reason, rows[1].partnerKind, rows[1].partnerId, rows[1].heldBy, rows[1].note],
    ['The partner’s role was revoked', 'seller', 'S1', 'Owner A', 'Revoked for fraud'])
  eq('a released hold is history, with who and why', [rows[2].released, rows[2].releasedBy, rows[2].releaseReason],
    [true, 'Fin A', 'Checked; proceed'])
  eq('nothing → nothing', [heldRowsFrom(null), heldRowsFrom({})], [[], []])
}

// ── 5. replica drift ─────────────────────────────────────────────────────────
{
  const rows = driftRowsFrom({
    count: 1,
    balances: [{
      id: 'b1', holder_type: 'user', holder_id: 'U1', currency: 'diamonds', amount: 900, replica_stale: true,
      replica_stale_at: '2026-10-31T08:00:00Z',
      replica_pending: [{ delta: 500, ledger_id: 'L1' }, { delta: -100, ledger_id: 'L2' }],
      replica_repair_last_error: 'FailedPrecondition: busy',
    }],
  })
  eq('the balance named holder/id/currency', rows[0].holder, 'user/U1/diamonds')
  eq('the ledger figure is the true one', rows[0].ledgerBalance, 900)
  eq('what the app is missing, counted and summed', [rows[0].pendingCount, rows[0].pendingDelta], [2, 400])
  eq('the last repair error is shown', rows[0].lastError, 'FailedPrecondition: busy')
  eq('a repair that found nothing says so', repairSummaryLine({ rows: 0 }), 'Nothing was out of step — no balance needed repairing.')
  eq('a repair run, counted', repairSummaryLine({ rows: 3, repaired: 2, replayed: 4, already_applied: 1, failed: 1 }),
    '3 balances checked, 2 brought back in step, 4 changes replayed, 1 had already landed (not applied twice), 1 still failing — see each row\'s error.')
}

// ── 6. Owner notices ─────────────────────────────────────────────────────────
{
  const rows = noticeRowsFrom({
    count: 1,
    pending: [{
      id: 'owner_money:c1:card_signed', action: 'card_signed', reference: 'c1', reference_type: 'card',
      amount: 250000, currency: 'commission', actor: { uid: 'o1', name: 'Owner A' }, attempts: 2,
      deliveries: {
        o2: { in_app: true, email: 'sent', name: 'Owner B' },
        o3: { in_app: true, email: 'failed', name: 'Owner C' },
        o4: { in_app: false, email: 'duplicate' },
      },
      last_error: 'sendgrid 503', created_at: '2026-10-31T07:00:00Z',
    }],
  })
  eq('the action by its label', rows[0].action, 'Card signed')
  eq('the amount in its unit', rows[0].amount, '₹2,500')
  eq('who was told, in full', rows[0].told, ['Owner B'])
  eq('who was not, and which half is missing', rows[0].untold, ['Owner C (email failed)', 'o4 (in-app)'])
  eq('an unknown action is shown as written', noticeRowsFrom([{ id: 'x', action: 'new_thing' }])[0].action, 'new thing')
  eq('a retry that found nothing', retrySummaryLine({ retried: 0, rows: [] }), 'Nothing was pending — every Owner had been told.')
  eq('a retry with one still failing',
    retrySummaryLine({ retried: 2, rows: [{ event_key: 'a', outcome: 'sent' }, { event_key: 'b', outcome: 'failed' }] }),
    '2 notices retried: 1 now delivered, 1 still not — they stay on the list and the sweep tries again.')
}

// ── 7. payout policy ─────────────────────────────────────────────────────────
{
  const v = payoutPolicyLines({
    release_arrears_weeks: 0, setting: 'PAYOUT_RELEASE_ARREARS_WEEKS', owner_decision_pending: true,
    current_behaviour: 'a closed ISO week is released on the Monday after it closes (00:30 IST)',
    applies_to: 'functions/src/payouts.ts releaseBeansForWeek cutoff',
    note: 'Changing the figure here changes nothing until the Function reads it; the owner decides the policy and both are moved together.',
  })
  eq('the server\'s sentence is the headline', v?.headline, 'A closed ISO week is released on the Monday after it closes (00:30 IST).')
  eq('the setting and its value', v?.lines[0], 'PAYOUT_RELEASE_ARREARS_WEEKS = 0 weeks.')
  eq('still an Owner decision', v?.pending, true)
  eq('nothing usable → null', [payoutPolicyLines(null), payoutPolicyLines({})], [null, null])
}

// ── 8. compared with the server ──────────────────────────────────────────────
{
  const backend = path.join(__dirname, '..', '..', 'backend', 'app')
  const router = path.join(backend, 'routers', 'partner_ops.py')
  const freeze = path.join(backend, 'services', 'money_freeze.py')
  const mail = path.join(backend, 'services', 'owner_mail.py')
  const reports = path.join(backend, 'routers', 'reports.py')
  if ([router, freeze, mail, reports].every((f) => fs.existsSync(f))) {
    const r = fs.readFileSync(router, 'utf8')
    const block = (route: string) => {
      const i = r.indexOf(route)
      return i < 0 ? '' : r.slice(i, r.indexOf('@router.', i + route.length))
    }
    for (const route of ['@router.get("/held-items")', '@router.post("/held-items/{item_type}/{item_id}/release")',
      '@router.get("/money/replica-drift")', '@router.post("/money/replica-drift/repair")']) {
      ok(`server: ${route} is behind can_process_payout`, block(route).includes('await enforce_permission(user, Permission.CAN_PROCESS_PAYOUT)'))
    }
    for (const route of ['@router.get("/owner-notices")', '@router.post("/owner-notices/retry")']) {
      ok(`server: ${route} is the Owner's`, block(route).includes('Depends(require_owner)'))
    }
    ok('server: release takes a reason of at least five', /class HeldRelease[\s\S]*?reason: str = Field\(min_length=5/.test(r))
    const f = fs.readFileSync(freeze, 'utf8')
    ok('server: release is Finance admin or the Owner',
      f.includes('return R.is_owner_value(role) or role == str(R.Role.FINANCE_ADMIN)'))
    ok('server: its refusal is the sentence shown', f.includes(`raise PermissionError("${RELEASE_NEEDS}")`))
    const m = fs.readFileSync(mail, 'utf8')
    const actions = /ACTIONS: dict\[str, tuple\[str, str\]\] = \{([\s\S]*?)\n\}/.exec(m)
    const keys = actions ? Array.from(actions[1].matchAll(/^\s*"([a-z_]+)":/gm)).map((x) => x[1]) : []
    eq('every server notice action has a label here', keys.filter((k) => !OWNER_NOTICE_ACTION_LABEL[k]), [])
    ok('server: GET /reports/payout-policy', fs.readFileSync(reports, 'utf8').includes('@router.get("/payout-policy")'))
  } else {
    console.log('  (backend not beside this repo — the server comparison was skipped)')
  }
}

// ── 9. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
  const page = read('app/finance/integrity/page.tsx')
  for (const call of ['heldItems(', 'releaseHeld(', 'replicaDrift(', 'repairReplicaDrift(', 'ownerNotices(', 'retryOwnerNotices(']) {
    ok(`the money-integrity page calls ${call}`, page.includes(`api.moneyIntegrity.${call}`))
  }
  ok('…offers each section by the shared rule', page.includes('moneyIntegrityAccess('))
  ok('…checks the release reason first', page.includes('releaseReasonProblem('))
  ok('the payouts page shows the payout policy', read('app/finance/payouts/page.tsx').includes('api.reports.payoutPolicy()')
    && read('app/finance/payouts/page.tsx').includes('payoutPolicyLines('))
  ok('the Finance nav has the page', /href: '\/finance\/integrity'/.test(read('app/layout.tsx')))
  ok('the export check requires the page', read('scripts/verify-out.mjs').includes("'finance/integrity/index.html'"))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} money-integrity checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} money-integrity checks passed.`)
console.log('  · held items and replica drift for can_process_payout; release for the Finance admin or the Owner')
console.log('  · Owner notices for the Owner; the payout release policy on /finance/payouts')
