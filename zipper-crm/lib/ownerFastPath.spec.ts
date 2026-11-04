/**
 * §8 — the Owner fast path on the money board: the plan the confirmation
 * lists (which stages will run, whether the money moves), what is refused
 * before anything is sent, and how the board reports whether the other
 * Owners were told.
 *
 * REAL: `lib/ownerFastPath.ts`, imported and run. The executor registry, the
 * payment-reference executors and the refusal sentences are compared with
 * `backend/app/services/*.py` when the backend sits beside this repo; the
 * board is checked on its source.
 *
 *   npm run test:fastpath
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  AUTO_EXECUTE_TYPES, EXECUTABLE_TYPES, OWNER_APPROVAL_NOTE, PAYMENT_REF_TYPES, SELF_SUBJECT_REFUSAL,
  VERIFICATION_NOTE_REQUIRED, fastPathOutcome, fastPathPlan, fastPathProblem, ownerApproveBody, ownerApprovePlan,
  ownerNoticeLine, ownerNoticeTally, ownerSignBlock, raisedOutcome,
} from './ownerFastPath'

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

const ME = 'owner-1'
const stages = (p: ReturnType<typeof fastPathPlan>) => p.steps.map((s) => s.stage)
const card = (stage: string, type = 'seller_coin_purchase', subject = 'seller-9') => ({ stage, type, subject: { id: subject } })

// ── 1. the plan, from every stage ────────────────────────────────────────────
eq('requested → review, verify, sign', stages(fastPathPlan(card('requested'), { execute: false, myUid: ME })),
  ['under_review', 'awaiting_signoff', 'approved'])
eq('…and execute when ticked', stages(fastPathPlan(card('requested'), { execute: true, myUid: ME })),
  ['under_review', 'awaiting_signoff', 'approved', 'executed'])
eq('under review → verify, sign', stages(fastPathPlan(card('under_review'), { execute: false, myUid: ME })),
  ['awaiting_signoff', 'approved'])
eq('awaiting sign-off → sign', stages(fastPathPlan(card('awaiting_signoff'), { execute: false, myUid: ME })), ['approved'])
eq('approved + execute → execute only', stages(fastPathPlan(card('approved'), { execute: true, myUid: ME })), ['executed'])
ok('approved without execute has nothing to run, and says so',
  fastPathPlan(card('approved'), { execute: false, myUid: ME }).refusal.includes('Tick Execute'))
for (const s of ['executed', 'rejected', 'failed']) {
  const p = fastPathPlan(card(s), { execute: true, myUid: ME })
  eq(`${s} → refused with the server's sentence, nothing planned`, [p.refusal, p.steps.length, p.executes], [`Card is already ${s}.`, 0, false])
}
ok('an unknown stage is refused rather than guessed', fastPathPlan(card('in_limbo'), { execute: false, myUid: ME }).refusal !== '')
eq('every step carries the audit action the server records',
  fastPathPlan(card('requested'), { execute: true, myUid: ME }).steps.map((s) => s.action),
  ['card.review_started', 'card.verified', 'card.signed', 'card.executed'])

// ── 2. execution only where an executor exists ──────────────────────────────
{
  const generic = fastPathPlan(card('awaiting_signoff', 'rate_change'), { execute: true, myUid: ME })
  eq('a type with no executor is NOT executed (the server would sign, then refuse)', [stages(generic), generic.executes], [['approved'], false])
  ok('…and the Owner is told where it is executed instead', /own screen/.test(generic.note))
  const unticked = fastPathPlan(card('awaiting_signoff'), { execute: false, myUid: ME })
  ok('an executable card left unticked says the money will not move', /does not move/.test(unticked.note))
  eq('balance cards execute here too', fastPathPlan(card('approved', 'balance_credit'), { execute: true, myUid: ME }).executes, true)
}

// ── 3. a payout (and a running cost) needs its bank reference ───────────────
for (const type of ['commission_payout', 'host_withdrawal', 'subagency_payout', 'operating_expense']) {
  const p = fastPathPlan(card('awaiting_signoff', type), { execute: true, myUid: ME })
  ok(`${type}: needs the reference to execute`, p.needsPaymentRef)
  ok(`${type}: refused without it`, /bank reference/.test(fastPathProblem(p, { verificationNote: 'checked UTR', paymentRef: ' ' })))
  eq(`${type}: fine with it`, fastPathProblem(p, { verificationNote: 'checked UTR', paymentRef: 'UTR123' }), '')
  eq(`${type}: no reference needed when not executing`,
    fastPathPlan(card('awaiting_signoff', type), { execute: false, myUid: ME }).needsPaymentRef, false)
}
eq('a coin purchase executes without a reference', fastPathPlan(card('approved'), { execute: true, myUid: ME }).needsPaymentRef, false)

// ── 4. the note, and the card that pays the Owner ────────────────────────────
{
  const p = fastPathPlan(card('requested'), { execute: false, myUid: ME })
  eq('no note → the server\'s sentence', fastPathProblem(p, { verificationNote: '  ' }), VERIFICATION_NOTE_REQUIRED)
  eq('three characters is enough (the server\'s minimum)', fastPathProblem(p, { verificationNote: 'ok!' }), '')
  ok('an over-long note is refused', fastPathProblem(p, { verificationNote: 'x'.repeat(1001) }) !== '')
  ok('an over-long reference is refused', fastPathProblem(
    fastPathPlan(card('approved', 'host_withdrawal'), { execute: true, myUid: ME }),
    { verificationNote: 'checked', paymentRef: 'x'.repeat(129) }) !== '')
  const self = fastPathPlan(card('awaiting_signoff', 'owner_drawings', ME), { execute: true, myUid: ME })
  eq('the card that pays the Owner is refused before anything runs', [self.refusal, self.steps.length], [SELF_SUBJECT_REFUSAL, 0])
  eq('…and the refusal wins over every other check', fastPathProblem(self, { verificationNote: 'checked' }), SELF_SUBJECT_REFUSAL)
  eq('once someone else signed it, executing is not a signature', stages(fastPathPlan(card('approved', 'owner_drawings', ME), { execute: true, myUid: ME })), ['executed'])
  eq('Sign: blocked only on the card that pays the Owner', [
    ownerSignBlock({ subject: { id: ME } }, ME),
    ownerSignBlock({ subject: { id: 'someone' } }, ME),
    ownerSignBlock({ subject: null }, ME),
    ownerSignBlock({ subject: { id: '' } }, ''),
  ], [SELF_SUBJECT_REFUSAL, '', '', ''])
}

// ── 5. were the other Owners told? ───────────────────────────────────────────
eq('sent, with the count', ownerNoticeLine({ status: 'sent', recipients: 2 }), { tone: 'ok', text: 'The other Owners were told (2), in-app and by email.' })
eq('already sent', ownerNoticeLine({ status: 'sent', already: true }).text, 'The other Owners had already been told.')
eq('no other Owner', ownerNoticeLine({ status: 'no_recipients' }).tone, 'ok')
ok('pending says it is retried, and where', /retried every 15 minutes/.test(ownerNoticeLine({ status: 'pending' }).text)
  && /Owner notices/.test(ownerNoticeLine({ status: 'pending' }).text))
eq('failed carries the error and says the action stands', ownerNoticeLine({ status: 'failed', error: 'mongo down' }),
  { tone: 'error', text: 'The other Owners could not be told: mongo down. The action stands; retry it from Money integrity → Owner notices.' })
eq('nothing reported is said, never assumed sent', ownerNoticeLine(undefined).tone, 'unknown')
eq('a bulk signature, tallied', ownerNoticeTally([
  { owner_notice: { status: 'sent', recipients: 1 } }, { owner_notice: { status: 'pending' } }, {},
]), 'Other Owners told for 1 of 3 signatures; 1 not yet — retried every 15 minutes (Money integrity → Owner notices); 1 not reported.')
eq('nothing signed → nothing to say', ownerNoticeTally([]), '')

// ── 6. what the fast path did ────────────────────────────────────────────────
{
  const done = fastPathOutcome({
    id: 'c1', stage: 'executed',
    fast_path: {
      steps: [{ stage: 'under_review', action: 'card.review_started' }, { stage: 'awaiting_signoff', action: 'card.verified' },
        { stage: 'approved', action: 'card.signed' }, { stage: 'executed', action: 'card.executed' }],
      executed: { id: 'c1', stage: 'executed', owner_notice: { status: 'pending' } },
    },
  })
  eq('the stages actually run, by name', done.ran, ['Under review', 'Awaiting sign-off', 'Approved', 'Executed'])
  eq('executed, with the execution\'s notice', [done.executed, done.notice?.tone], [true, 'warn'])
  const signedOnly = fastPathOutcome({ fast_path: { steps: [{ stage: 'approved' }], executed: null } })
  eq('signed only: no execution, no notice claimed', [signedOnly.executed, signedOnly.notice], [false, null])
  eq('an empty answer is empty, never a throw', fastPathOutcome(null), { ran: [], executed: false, notice: null })
}

// ── 7. compared with the server ──────────────────────────────────────────────
{
  const services = path.join(__dirname, '..', '..', 'backend', 'app', 'services')
  const routers = path.join(__dirname, '..', '..', 'backend', 'app', 'routers')
  const cardsPy = path.join(services, 'cards.py')
  if (fs.existsSync(cardsPy) && fs.existsSync(path.join(routers, 'cards.py'))) {
    const cards = fs.readFileSync(cardsPy, 'utf8')
    // CardType NAME → value, then every `register_executor(CardType.NAME, …)` across services.
    const enumBlock = /class CardType\(StrEnum\):([\s\S]*?)\n\n\n/.exec(cards)?.[1] ?? ''
    const values = new Map(Array.from(enumBlock.matchAll(/^\s+([A-Z_]+) = "([a-z_]+)"/gm)).map((m) => [m[1], m[2]] as [string, string]))
    const registered = new Set<string>()
    const payoutRef = new Set<string>()
    for (const f of fs.readdirSync(services).filter((n) => n.endsWith('.py'))) {
      const src = fs.readFileSync(path.join(services, f), 'utf8')
      for (const m of Array.from(src.matchAll(/register_executor\(CardType\.([A-Z_]+),\s*([A-Za-z_]+)\)/g))) {
        const value = values.get(m[1])
        if (!value) continue
        registered.add(value)
        // An executor that hands `payment_ref` on to the execute function needs it.
        const fn = new RegExp(`async def ${m[2]}\\([^)]*\\)[^:]*:\\s*\\n\\s*return await [a-z_]+\\(([^)]*)\\)`).exec(src)
        if (fn && fn[1].includes('payment_ref')) payoutRef.add(value)
      }
    }
    eq('the executable types are exactly the server\'s registered executors', Array.from(EXECUTABLE_TYPES).sort(), Array.from(registered).sort())
    eq('the payment-reference types are exactly the executors that pass one on', Array.from(PAYMENT_REF_TYPES).sort(), Array.from(payoutRef).sort())
    ok('server: "Card is already …" is the terminal refusal', cards.includes('raise CardError(f"Card is already {card[\'stage\']}.")'))
    ok('server: the self-subject refusal is the sentence shown', cards.includes(`"${SELF_SUBJECT_REFUSAL}"`))
    ok('server: the note refusal is the sentence shown', cards.includes(`"${VERIFICATION_NOTE_REQUIRED}"`))
    ok('server: OWNER_ALONE is on (an Owner signs what they raised)', /^OWNER_ALONE = True$/m.test(cards))
    const router = fs.readFileSync(path.join(routers, 'cards.py'), 'utf8')
    ok('server: the route is the Owner\'s', router.includes('@router.post("/{card_id}/owner-fast-path", dependencies=[_APPROVE_REQUESTS])')
      && router.includes('async def owner_fast_path(card_id: str, body: OwnerFastPath, user: dict = Depends(require_owner))'))
  } else {
    console.log('  (backend not beside this repo — the server comparison was skipped)')
  }
}

// ── 8. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const board = fs.readFileSync(path.join(root, 'app', 'board', 'page.tsx'), 'utf8')
  ok('the board plans the fast path before confirming', board.includes('fastPathPlan('))
  ok('…checks it before sending', board.includes('fastPathProblem('))
  ok('…runs it through the API', board.includes('api.cards.ownerFastPath('))
  ok('…lists the amount in the confirmation', /money\(card\.amount, card\.currency\)/.test(board))
  ok('…reports whether the other Owners were told', board.includes('ownerNoticeLine('))
  ok('…after a signature, too', /api\.cards\.sign\(card\.id, note\)/.test(board) && board.includes('owner_notice'))
  ok('…and gates Sign by the §8 rule', board.includes('ownerSignBlock('))
  ok('…and still names the card subject', board.includes('<CardSubject'))
  const api = fs.readFileSync(path.join(root, 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts posts to owner-fast-path', api.includes('/owner-fast-path`'))
}

// ── 9. O6 (Owner decision, 5 Nov 2026): one Owner's approval is final ──────
{
  eq('O6: the signature executes coin and diamond cards only',
    Array.from(AUTO_EXECUTE_TYPES).sort(),
    ['bad_debt_write_off', 'balance_credit', 'balance_debit', 'lending_issue', 'lending_recover', 'lending_repay',
      'seller_coin_purchase'])
  for (const t of ['commission_payout', 'host_withdrawal', 'subagency_payout', 'operating_expense', 'owner_drawings']) {
    ok(`O6: a ${t} is never executed by a signature`, !AUTO_EXECUTE_TYPES.has(t))
  }
  ok('O6: every type the signature executes has an executor', Array.from(AUTO_EXECUTE_TYPES).every((t) => EXECUTABLE_TYPES.has(t)))
  eq('O6: Approve on a requested coin card runs every stage and the execution',
    stages(ownerApprovePlan(card('requested'), ME)), ['under_review', 'awaiting_signoff', 'approved', 'executed'])
  eq('O6: Approve on a requested payout stops at the signature',
    stages(ownerApprovePlan(card('requested', 'commission_payout'), ME)), ['under_review', 'awaiting_signoff', 'approved'])
  eq('O6: Approve on the card that pays the Owner is refused first',
    ownerApprovePlan(card('requested', 'balance_credit', ME), ME).refusal, SELF_SUBJECT_REFUSAL)
  eq('O6: an empty note sends the default verification note', ownerApproveBody(card('requested'), '  ').verification_note,
    OWNER_APPROVAL_NOTE)
  eq('O6: a written note is sent as both notes',
    [ownerApproveBody(card('requested'), 'UTR matched').verification_note,
      ownerApproveBody(card('requested'), 'UTR matched').signature_note], ['UTR matched', 'UTR matched'])
  eq('O6: execute is asked for a coin card', ownerApproveBody(card('requested'), '').execute, true)
  eq('O6: …and not for a payout', ownerApproveBody(card('requested', 'host_withdrawal'), '').execute, false)
  eq('O6: executed → done', raisedOutcome({ stage: 'executed', type: 'lending_issue' }).done, true)
  const refused = raisedOutcome({ stage: 'approved', auto_executed: false, auto_execute_error: 'Frozen.' })
  eq('O6: a refused execution is an error, never "done"', [refused.tone, refused.done], ['error', false])
  ok('O6: …saying why', refused.detail.includes('Frozen.'))
  eq('O6: the card that pays an Owner needs another', raisedOutcome({ stage: 'awaiting_signoff',
    owner_complete_error: SELF_SUBJECT_REFUSAL }).headline, 'Raised — it needs another Owner.')
  eq('O6: a raised card says nothing moved', raisedOutcome({ stage: 'requested' }).headline, 'Raised — no money has moved yet.')
  eq('O6: an approved payout says it is not paid', raisedOutcome({ stage: 'approved', type: 'commission_payout' }).headline,
    'Approved — not paid yet.')
  eq('O6: nothing at all is never "done"', raisedOutcome(undefined).done, false)

  // The server's list, when the backend sits beside this repo.
  const cardsPy = path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'cards.py')
  if (fs.existsSync(cardsPy)) {
    const src = fs.readFileSync(cardsPy, 'utf8')
    const m = src.match(/AUTO_EXECUTE_TYPES: frozenset\[str\] = frozenset\(\{([\s\S]*?)\}\)/)
    const server = m ? (m[1].match(/CardType\.[A-Z_]+/g) ?? []).map((x) => x.slice('CardType.'.length).toLowerCase()).sort() : []
    eq('O6 server: the same types execute on the signature', server, Array.from(AUTO_EXECUTE_TYPES).sort())
    ok('O6 server: the decision is on', /^AUTO_EXECUTE_ON_OWNER_SIGN = True$/m.test(src))
    ok('O6 server: an Owner completes the cards they raise', /^OWNER_COMPLETES_OWN_CARDS = True$/m.test(src))
  }

  // The board offers one Approve to an Owner, and says what it did.
  const board = fs.readFileSync(path.join(__dirname, '..', 'app', 'board', 'page.tsx'), 'utf8')
  ok('O6 board: one Approve for an Owner', board.includes('ownerApproveBody(card, note)'))
  ok('O6 board: …that says what happened', board.includes('raisedOutcome('))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} owner fast-path checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} owner fast-path checks passed.`)
console.log('  · the confirmation lists every stage the server will run, from where the card is, and the amount')
console.log('  · execution only for a type with an executor; a payout needs its bank reference')
console.log('  · the card that pays the Owner is refused first; the other Owners\' notice is reported, never assumed')

