/**
 * §5 — ban and suspension appeals: reviewers recommend, the Owner decides,
 * four eyes always; and the restriction and the recommendation are shown
 * beside the appeal.
 *
 * REAL: `lib/appealReview.ts` (with `lib/banDetails.ts`), imported and run.
 * The wiring in `app/operations/appeals/page.tsx` is checked on its source,
 * and the two refusal sentences and the recommend body are compared with the
 * backend when it sits beside this repo.
 *
 *   npm run test:appealreview
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  FOUR_EYES_REFUSAL, MIN_RECOMMENDATION_NOTE, OWNER_ONLY_DECIDE, RECOMMEND_NEEDS_PERMISSION,
  RECOMMENDATION_OUTCOMES,
  appealReviewActions, decidedOnRecommendationLine, decisionReasonProblem, millisOf,
  presentRecommendation, presentRestriction, recommendationProblem, verdictFor, whoLabel,
} from './appealReview'

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
function pyConst(src: string, name: string): string | null {
  const block = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\n\\)`, 'm').exec(src)
  if (block) return Array.from(block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1]).join('')
  return null
}

const OWNER = { isOwner: true, canBan: true, uid: 'owner-1' }
const REVIEWER = { isOwner: false, canBan: true, uid: 'app-admin-1' }
const READER = { isOwner: false, canBan: false, uid: 'ops-1' }
const restriction = (decidedBy = 'mod-9') => ({ decidedBy })
const pick = (a: ReturnType<typeof appealReviewActions>) => [a.recommend, a.decide, a.hint]

// ── 1. who is offered what ───────────────────────────────────────────────────
eq('pending, the Owner → decide only', pick(appealReviewActions({ status: 'pending', restriction: restriction() }, OWNER)),
  [false, true, ''])
eq('pending, a reviewer with the ban permission → recommend, told only the Owner decides',
  pick(appealReviewActions({ status: 'pending', restriction: restriction() }, REVIEWER)), [true, false, OWNER_ONLY_DECIDE])
eq('pending, a reader → neither, and why', pick(appealReviewActions({ status: 'pending' }, READER)),
  [false, false, RECOMMEND_NEEDS_PERMISSION])
for (const status of ['upheld', 'overturned', 'resolved', '', 'withdrawn']) {
  for (const [who, me] of [['Owner', OWNER], ['reviewer', REVIEWER], ['reader', READER]] as const) {
    eq(`${status || 'no status'} × ${who} → nothing`, pick(appealReviewActions({ status, restriction: restriction() }, me)),
      [false, false, ''])
  }
}
// Four eyes: whoever made the decision being appealed neither recommends nor decides.
eq('the Owner who banned the account is not offered Decide',
  pick(appealReviewActions({ status: 'pending', restriction: restriction('owner-1') }, OWNER)), [false, false, FOUR_EYES_REFUSAL])
eq('the reviewer who suspended it is not offered Recommend',
  pick(appealReviewActions({ status: 'pending', restriction: restriction('app-admin-1') }, REVIEWER)), [false, false, FOUR_EYES_REFUSAL])
ok('…and the flag says why', appealReviewActions({ status: 'pending', restriction: restriction('owner-1') }, OWNER).ownDecision)
eq('an unknown actor uid never matches a blank decider',
  pick(appealReviewActions({ status: 'pending', restriction: { decidedBy: '' } }, { ...OWNER, uid: '' })), [false, true, ''])
eq('no restriction on the row → the server decides four eyes',
  pick(appealReviewActions({ status: 'pending', restriction: null }, REVIEWER)), [true, false, OWNER_ONLY_DECIDE])
ok('nobody but the Owner is ever offered Decide', [REVIEWER, READER, { isOwner: false, canBan: true, uid: '' }]
  .every((me) => !appealReviewActions({ status: 'pending' }, me).decide))

// ── 2. the recommendation and the decision, checked before sending ──────────
eq('the two outcomes', [...RECOMMENDATION_OUTCOMES], ['uphold', 'overturn'])
ok('no outcome → refused', recommendationProblem('', 'a long enough note') !== '')
ok('a verdict word is not an outcome', recommendationProblem('overturned', 'a long enough note') !== '')
ok(`${MIN_RECOMMENDATION_NOTE - 1} characters → refused, with the count`,
  /\(9 so far\)/.test(recommendationProblem('uphold', '123456789')))
eq(`${MIN_RECOMMENDATION_NOTE} characters → fine`, recommendationProblem('overturn', '1234567890'), '')
ok('surrounding space does not count', recommendationProblem('uphold', '   12345678   ') !== '')
eq('a decision reason of 10 → fine', decisionReasonProblem('0123456789'), '')
ok('a decision reason of 9 → refused, saying the person reads it', /whole answer they get/.test(decisionReasonProblem('012345678')))
eq('the Owner\'s dialog pre-selects what the recommendation argued for',
  [verdictFor('uphold'), verdictFor('overturn'), verdictFor('upheld'), verdictFor(undefined)], ['upheld', 'overturned', null, null])

// ── 3. the restriction beside the appeal ─────────────────────────────────────
{
  const ban = presentRestriction({
    state: 'banned', reason: 'Fraud ring: fake recharges', category: 'fraud', evidence: ['rep-77', '  ', 'appealEvidence/x/1.jpg'],
    scope: 'account', decidedBy: 'mod-9', decidedByName: 'Asha Rao', decidedByRole: 'app_admin',
    decidedAt: '2026-10-30T10:00:00+00:00', suspendedUntil: null,
  })
  eq('a ban names who decided it, with their role', ban?.decidedBy, 'Asha Rao (app admin)')
  eq('…its category label', ban?.category, 'Fraud / scam')
  eq('…its scope label', ban?.scope, 'Account only')
  eq('…its evidence, blanks dropped', ban?.evidence, ['rep-77', 'appealEvidence/x/1.jpg'])
  eq('…and when', ban?.decidedAtMs, Date.parse('2026-10-30T10:00:00+00:00'))
  eq('a ban has no end date', ban?.untilMs, null)

  const susp = presentRestriction({
    state: 'suspended', reason: 'Spam', category: '', evidence: [], scope: 'account',
    decidedBy: 'mod-2', decidedByName: '', decidedByRole: 'app_member', decidedAt: { seconds: 1700000000 },
    suspendedUntil: '2026-11-07T00:00:00Z',
  })
  eq('a suspension with no name falls back to the uid, never to "a reviewer"', susp?.decidedBy, 'mod-2 (app member)')
  eq('…shows its end date', susp?.untilMs, Date.parse('2026-11-07T00:00:00Z'))
  ok('…says a suspension never bars a device', /never bars a device/.test(susp?.scope ?? ''))
  eq('…and has no ban category or evidence', [susp?.category, susp?.evidence], ['', []])
  eq('a Firestore {seconds} timestamp reads', susp?.decidedAtMs, 1700000000 * 1000)
  eq('no restriction is null (the page says so in words)', [presentRestriction(null), presentRestriction({}), presentRestriction('x')], [null, null, null])
  eq('nobody recorded → "not recorded"', whoLabel('', '', ''), 'not recorded')
  eq('timestamps: garbage is null', [millisOf('not a date'), millisOf(42), millisOf({})], [null, null, null])
}

// ── 4. the recommendation beside the appeal ──────────────────────────────────
{
  const rec = presentRecommendation({ outcome: 'overturn', note: 'The evidence names another handset.', byUid: 'r1', byName: 'Vikram', byRole: 'app_admin', at: '2026-10-31T09:00:00Z' })
  eq('a recommendation reads as what it argues for', rec?.label, 'Recommends overturning')
  eq('…by whom', rec?.by, 'Vikram (app admin)')
  eq('…with the note', rec?.note, 'The evidence names another handset.')
  eq('an unknown outcome is shown as written, never guessed', presentRecommendation({ outcome: 'escalate', note: 'n' })?.label, 'Recommends: escalate')
  eq('none → null', [presentRecommendation(null), presentRecommendation({})], [null, null])
  eq('followed', decidedOnRecommendationLine({ outcome: 'overturn', byUid: 'r1', followed: true }),
    'Decided on a recommendation to overturn — followed.')
  eq('not followed', decidedOnRecommendationLine({ outcome: 'uphold', followed: false }),
    'Decided on a recommendation to uphold — not followed.')
  eq('decided without one → nothing to say', decidedOnRecommendationLine(null), '')
}

// ── 5. compared with the server ──────────────────────────────────────────────
{
  const backend = path.join(__dirname, '..', '..', 'backend', 'app')
  const svc = path.join(backend, 'services', 'appeals.py')
  const router = path.join(backend, 'routers', 'users.py')
  if (fs.existsSync(svc) && fs.existsSync(router)) {
    const s = fs.readFileSync(svc, 'utf8')
    eq('OWNER_ONLY_DECIDE is the server\'s sentence', pyConst(s, 'OWNER_ONLY_DECIDE'), OWNER_ONLY_DECIDE)
    eq('FOUR_EYES_REFUSAL is the server\'s sentence', pyConst(s, 'FOUR_EYES_REFUSAL'), FOUR_EYES_REFUSAL)
    ok('the server puts the restriction beside each appeal', s.includes('row["restriction"] = summaries[uid]'))
    const r = fs.readFileSync(router, 'utf8')
    ok('recommend: uphold | overturn', r.includes('outcome: str = Field(pattern=r"^(uphold|overturn)$")'))
    ok('recommend: a note of at least ten', /class AppealRecommendation[\s\S]*?note: str = Field\(min_length=10/.test(r))
    ok('recommend: the route exists, behind can_ban_users',
      /"\/appeals\/\{appeal_id\}\/recommend",\s*dependencies=\[Depends\(require_permission\(Permission\.CAN_BAN_USERS\)\)\]/.test(r))
  } else {
    console.log('  (backend not beside this repo — the server comparison was skipped)')
  }
}

// ── 6. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const page = fs.readFileSync(path.join(root, 'app', 'operations', 'appeals', 'page.tsx'), 'utf8')
  ok('the queue offers controls from the shared rule', page.includes('appealReviewActions('))
  ok('…files a recommendation through the API', page.includes('api.users.recommendAppeal('))
  ok('…checks the note before sending', page.includes('recommendationProblem('))
  ok('…still decides through the same call', page.includes('api.users.decideAppeal(target.id, verdict, why)'))
  ok('…shows the restriction', page.includes('presentRestriction('))
  ok('…and the recommendation', page.includes('presentRecommendation('))
  ok('…and shows the server\'s refusals verbatim', (page.match(/err instanceof ApiError \? err\.message/g) ?? []).length >= 2)
  const api = fs.readFileSync(path.join(root, 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts posts {outcome, note} to /recommend', api.includes('/recommend`,') && api.includes('{ outcome, note },'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} appeal-review checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} appeal-review checks passed.`)
console.log('  · reviewers with the ban permission recommend (note ≥ 10); only the Owner decides')
console.log('  · whoever made the decision is offered neither — with the server\'s own four-eyes sentence')
console.log('  · the restriction (decider, reason, category, evidence, scope) and the recommendation sit beside the appeal')
