/**
 * Appeal statuses, and the one sentence this module exists to prevent.
 *
 * The bug being fixed was not a crash. The page asked `status === 'pending'`,
 * and everything that was not pending fell into an `else` that rendered
 *
 *     {a.decidedByName || 'A reviewer'} said: {a.decisionReason}
 *
 * `resolved` has no `decidedByName`, on purpose — the backend refuses to invent
 * a reviewer for a restriction an admin lifted directly, because a fabricated
 * one would also pass the four-eyes check next time. So the fallback fired and
 * the CRM told staff that a reviewer had decided an appeal nobody had read.
 *
 * Four claims:
 *
 *   1. **`resolved` is never attributed to a reviewer, and never selectable.**
 *      The whole point, asserted directly rather than via the page.
 *   2. **Unknown is not refused.** A status this build has never heard of must
 *      come out neutral — same rule as `AppealStatus.kt` on Android, where
 *      `UNRECOGNISED` is deliberately not `REFUSED`. A fifth status added
 *      server-side must not silently inherit whichever branch was the `else`.
 *   3. **The existing three are untouched.** Their tone strings are asserted
 *      literally, so adding a fourth status cannot restyle the first three.
 *   4. **Statuses and verdicts are different sets.** Exactly one status is
 *      actionable and exactly two are selectable, asserted over the full list
 *      rather than by example.
 *
 * Run:  npm run test:appeals
 */

import {
  APPEAL_STATUSES,
  APPEAL_VERDICTS,
  AppealStatusValue,
  isActionable,
  isKnownAppealStatus,
  isReviewerDecision,
  isSelectableVerdict,
  presentAppealStatus,
} from './appealStatus'

let failures = 0
let checks = 0

function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) {
    failures += 1
    console.error(`  FAIL  ${claim}`)
  }
}

function eq<T>(claim: string, got: T, want: T): void {
  checks += 1
  if (got !== want) {
    failures += 1
    console.error(`  FAIL  ${claim}\n        got ${String(got)}, want ${String(want)}`)
  }
}

/**
 * Strings the server might one day send that this build does not know.
 *
 * Includes the upper- and mixed-case forms of statuses it *does* know. Case is
 * deliberately not normalised: Firestore stores these lowercase and the backend
 * enum is lowercase, so `UPHELD` arriving means something upstream changed, and
 * quietly folding it to `upheld` would present a guess as a fact. Neutral is
 * the honest answer. These belong in this list, not beside the known ones.
 */
const UNKNOWNS: (string | null | undefined)[] = [
  '', '   ', null, undefined,
  'withdrawn', 'expired', 'escalated', 'RESOLVED_BY_SYSTEM', 'closed',
  'pending_review', 'overturn', 'uphold', 'resolve',
  '0', 'null', 'undefined', 'true', '[object Object]',
  ...APPEAL_STATUSES.map((s) => s.toUpperCase()),
  ...APPEAL_STATUSES.map((s) => s[0].toUpperCase() + s.slice(1)),
]

// ── 1. `resolved`, the reason this module exists ────────────────────────────
console.log('\n1. `resolved` is not a reviewer decision')

eq('resolved is a status this build knows', isKnownAppealStatus('resolved'), true)
eq('resolved is NOT a reviewer decision', isReviewerDecision('resolved'), false)
eq('resolved is NOT actionable — it is not work', isActionable('resolved'), false)
eq('resolved is NOT selectable as a verdict', isSelectableVerdict('resolved'), false)
eq('resolved is not in the verdict list', (APPEAL_VERDICTS as readonly string[]).includes('resolved'), false)

const resolved = presentAppealStatus('resolved')

eq(
  'the copy is exactly the agreed sentence',
  resolved.note,
  'The restriction was removed administratively without an appeal decision.',
)
eq('its badge says resolved', resolved.label, 'resolved')

// The badge must not borrow either decision colour. Green reads as "the appeal
// succeeded" and the upheld slate reads as "it was refused"; it was neither.
const pendingTone = presentAppealStatus('pending').tone
const upheldTone = presentAppealStatus('upheld').tone
const overturnedTone = presentAppealStatus('overturned').tone

ok('its tone is not the overturned tone', resolved.tone !== overturnedTone)
ok('its tone is not the upheld tone', resolved.tone !== upheldTone)
ok('its tone is not the pending tone', resolved.tone !== pendingTone)
ok('its tone is not empty — the badge is styled, not bare', resolved.tone.trim().length > 0)
ok('nothing green is used to say "resolved"', !resolved.tone.includes('green'))

// The page used to ask one question — `status === 'pending'` — and treat every
// other answer as a reviewer's decision. Re-deriving that branch here proves
// two things at once: that the three-way split was necessary, and that it
// changed the outcome for `resolved` and for nothing else. If a later edit
// quietly restores the old behaviour, the first assertion fails; if it changes
// what `upheld` or `overturned` render, the second does.
const oldBranchSaysReviewerDecided = (status: string): boolean => status !== 'pending'

const changed = APPEAL_STATUSES.filter(
  (s) => oldBranchSaysReviewerDecided(s) !== isReviewerDecision(s),
)

eq('the fix changed exactly one status', changed.length, 1)
eq('and that status is resolved', changed[0], 'resolved')
ok(
  'the old branch would have called it a reviewer decision',
  oldBranchSaysReviewerDecided('resolved'),
)
eq('this module does not', isReviewerDecision('resolved'), false)

// ── 2. Unknown is neutral, never refused ────────────────────────────────────
console.log('2. An unrecognised status is neutral')

for (const raw of UNKNOWNS) {
  const label = JSON.stringify(raw)
  const p = presentAppealStatus(raw)

  eq(`${label} is not claimed as known`, isKnownAppealStatus(raw), false)
  eq(`${label} is never a reviewer decision`, isReviewerDecision(raw), false)
  eq(`${label} is never actionable`, isActionable(raw), false)
  eq(`${label} is never a selectable verdict`, isSelectableVerdict(raw), false)
  ok(`${label} still gets a styled badge`, p.tone.trim().length > 0)
  ok(`${label} is not shown in the overturned colour`, p.tone !== overturnedTone)
  ok(`${label} is not shown in the upheld colour`, p.tone !== upheldTone)
  ok(`${label} says something rather than nothing`, p.label.length > 0)
  ok(`${label} explains itself instead of guessing`, p.note.length > 0)
}

// ── 3. The existing three are byte-for-byte unchanged ───────────────────────
console.log('3. Adding a fourth status restyled nothing')

eq('pending keeps its amber', pendingTone, 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30')
eq('upheld keeps its slate', upheldTone, 'bg-slate-700 text-slate-300 border-slate-600')
eq('overturned keeps its green', overturnedTone, 'bg-green-500/15 text-green-300 border-green-500/30')

eq('pending still reads as the only open state', isActionable('pending'), true)
eq('pending is still not a decision', isReviewerDecision('pending'), false)
eq('pending is still not selectable as a verdict', isSelectableVerdict('pending'), false)
eq('upheld is still a reviewer decision', isReviewerDecision('upheld'), true)
eq('overturned is still a reviewer decision', isReviewerDecision('overturned'), true)
eq('upheld is still not actionable', isActionable('upheld'), false)
eq('overturned is still not actionable', isActionable('overturned'), false)
eq('upheld is still selectable', isSelectableVerdict('upheld'), true)
eq('overturned is still selectable', isSelectableVerdict('overturned'), true)

// The three that existed before carry no extra note; only the new state needs
// explaining. A note appearing on `upheld` would be a silent copy change.
eq('pending adds no explanatory line', presentAppealStatus('pending').note, '')
eq('upheld adds no explanatory line', presentAppealStatus('upheld').note, '')
eq('overturned adds no explanatory line', presentAppealStatus('overturned').note, '')

// ── 4. Statuses and verdicts are different sets ─────────────────────────────
console.log('4. A status is a fact; a verdict is a choice')

eq('there are exactly four statuses', APPEAL_STATUSES.length, 4)
eq('there are exactly two verdicts', APPEAL_VERDICTS.length, 2)

ok(
  'every verdict is also a status',
  APPEAL_VERDICTS.every((v) => (APPEAL_STATUSES as readonly string[]).includes(v)),
)
ok(
  'but not every status is a verdict',
  APPEAL_STATUSES.some((s) => !(APPEAL_VERDICTS as readonly string[]).includes(s)),
)

const actionable = APPEAL_STATUSES.filter((s) => isActionable(s))
eq('exactly one status is actionable, so Waiting stays the work queue', actionable.length, 1)
eq('and it is pending', actionable[0], 'pending')

const decisions = APPEAL_STATUSES.filter((s) => isReviewerDecision(s))
eq('exactly two statuses are reviewer decisions', decisions.length, 2)
ok(
  'and they are precisely the two verdicts',
  decisions.every((d) => (APPEAL_VERDICTS as readonly string[]).includes(d)),
)

const selectable = APPEAL_STATUSES.filter((s) => isSelectableVerdict(s))
eq('exactly two statuses may be chosen in the decide modal', selectable.length, 2)

// Nothing may be both "still open" and "already decided".
for (const s of APPEAL_STATUSES) {
  ok(`${s} is never both actionable and a decision`, !(isActionable(s) && isReviewerDecision(s)))
}

// Anything a reviewer can pick must be a decision once picked, and vice versa.
for (const s of APPEAL_STATUSES) {
  eq(
    `${s}: selectable and reviewer-decided agree`,
    isSelectableVerdict(s),
    isReviewerDecision(s),
  )
}

// Every known status is distinguishable on screen — no two share a badge.
const tones = new Set(APPEAL_STATUSES.map((s) => presentAppealStatus(s).tone))
eq('all four statuses look different', tones.size, APPEAL_STATUSES.length)
const labels = new Set(APPEAL_STATUSES.map((s) => presentAppealStatus(s).label))
eq('all four statuses read differently', labels.size, APPEAL_STATUSES.length)

// ── 5. Pure, total, and forgiving of transport noise ────────────────────────
console.log('5. Pure and total')

for (const s of APPEAL_STATUSES) {
  const padded: string = `  ${s}  `
  eq(`"${padded}" trims to ${s}`, presentAppealStatus(padded).label, s)
  eq(`"${padded}" is recognised`, isKnownAppealStatus(padded), true)
}

// Case is NOT normalised here, deliberately: Firestore stores these lowercase
// and the backend enum is lowercase, so `RESOLVED` arriving would mean
// something upstream changed. Neutral-unknown is the honest answer, not a
// guess that it meant `resolved`.
eq('RESOLVED is treated as unknown, not assumed', isKnownAppealStatus('RESOLVED'), false)
eq('and an unknown is still never a refusal', isReviewerDecision('RESOLVED'), false)

const once = presentAppealStatus('resolved')
ok(
  'the same status gives the same answer every time',
  [...Array(50)].every(() => presentAppealStatus('resolved').note === once.note),
)

// The shared table must not be editable through a returned object.
const grabbed = presentAppealStatus('upheld') as { tone: string }
try {
  grabbed.tone = 'tampered'
} catch {
  /* frozen in strict mode — also fine */
}
eq(
  'mutating a returned presentation cannot corrupt the next read',
  presentAppealStatus('upheld').tone,
  'bg-slate-700 text-slate-300 border-slate-600',
)

const statusList: readonly AppealStatusValue[] = APPEAL_STATUSES
eq('the status list is the one the UI iterates', statusList.length, 4)

// ── Result ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks FAILED.\n`)
  process.exit(1)
}
console.log(`\nAll ${checks} appeal-status checks passed.`)
console.log('  · `resolved` is never shown as a reviewer decision, and never selectable')
console.log('  · an unrecognised status is neutral — unknown is not "not accepted"')
console.log('  · pending, upheld and overturned are byte-for-byte unchanged')
console.log('  · exactly one status is work; exactly two are decisions\n')
