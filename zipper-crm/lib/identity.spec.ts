/**
 * B1 — readable identity display.
 *
 * REAL: `lib/identity.ts`, imported and called (no copy of the rules), plus a
 * source check that every B1 screen uses the shared helpers the way the rule
 * requires: names first, contacts only where the screen is authorised, a
 * LABELLED id always, and partner-facing screens on the public profile only.
 *
 *   npm run test:identity
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  ID_LABEL, LOADING, MISSING, NO_NAME, NOT_FOUND, UNAVAILABLE,
  agencyFacts, chunks, foldBatch, identityView, mergePartner, nameOrReference, personFacts,
  publicFacts, referenceOf, sellerFacts, subjectTarget, uniqueIds, type IdentityFacts,
} from './identity'

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

const RAHUL: IdentityFacts = { found: true, name: 'Rahul Sharma', email: 'r@example.test', phone: '+911234567890', photoUrl: '' }

// ── 1. The display rule ───────────────────────────────────────────────────────
{
  const v = identityView(RAHUL, 'uid123', 'account', { showContacts: true })
  eq('name first', v.primary, 'Rahul Sharma')
  ok('…marked as a real name', v.named)
  eq('email · phone when authorised', v.secondary, 'r@example.test · +911234567890')
  eq('labelled account id', v.reference, 'Account ID: uid123')

  const hidden = identityView(RAHUL, 'uid123', 'account')
  eq('contacts hidden by default (not authorised)', hidden.secondary, '')
  eq('contacts hidden when showContacts is false', identityView(RAHUL, 'u', 'account', { showContacts: false }).secondary, '')

  eq('only the contact that exists is shown (email only)',
    identityView({ ...RAHUL, phone: '' }, 'u', 'account', { showContacts: true }).secondary, 'r@example.test')
  eq('only the contact that exists is shown (phone only)',
    identityView({ ...RAHUL, email: '  ' }, 'u', 'account', { showContacts: true }).secondary, '+911234567890')

  const missing = identityView(MISSING, 'gone1', 'account', { showContacts: true })
  eq('missing profile says Profile not found', missing.primary, NOT_FOUND)
  ok('…not a name', !missing.named)
  eq('…keeps the labelled id', missing.reference, 'Account ID: gone1')
  eq('…and shows no contact', missing.secondary, '')

  eq('a profile with no name says so, never invents one',
    identityView({ ...RAHUL, name: ' ' }, 'u', 'account').primary, NO_NAME)
  eq('a failed / refused read says the name is unavailable',
    identityView(undefined, 'u', 'account', { state: 'failed' }).primary, UNAVAILABLE)
  eq('while loading it says so', identityView(undefined, 'u', 'account', { state: 'loading' }).primary, LOADING)
  eq('an empty id is still labelled', referenceOf('request', ''), 'Request ID: —')
}

// ── 2. Different ids are never confused ───────────────────────────────────────
{
  eq('account label', referenceOf('account', 'A'), 'Account ID: A')
  eq('partner label', referenceOf('partner', 'P'), 'Partner ID: P')
  eq('host label', referenceOf('host', 'H'), 'Host ID: H')
  eq('request label', referenceOf('request', 'R'), 'Request ID: R')
  eq('buyer label', referenceOf('buyer', 'B'), 'Buyer ID: B')
  eq('agency label', referenceOf('agency', 'G'), 'Agency ID: G')
  eq('seller label', referenceOf('seller', 'S'), 'Seller ID: S')
  const labels = Object.values(ID_LABEL)
  ok('every id kind has its own label', new Set(labels).size === labels.length)

  eq('nameOrReference: name + labelled id', nameOrReference(RAHUL, 'u1', 'buyer'), 'Rahul Sharma (Buyer ID: u1)')
  eq('nameOrReference: no facts → labelled id only', nameOrReference(undefined, 'u1', 'buyer'), 'Buyer ID: u1')
  eq('nameOrReference: missing → labelled id only, no invented name', nameOrReference(MISSING, 'u1', 'host'), 'Host ID: u1')

  eq('audit/card subject: user → a person (account)', subjectTarget('user'), { lookup: 'person', kind: 'account' })
  eq('…owner → a person', subjectTarget('owner'), { lookup: 'person', kind: 'account' })
  eq('…partner → a partner record', subjectTarget('partner'), { lookup: 'partner', kind: 'partner' })
  eq('…seller → a partner record', subjectTarget('seller'), { lookup: 'partner', kind: 'partner' })
  eq('…a card is NOT looked up as a person', subjectTarget('card'), null)
  eq('…an expense is not either', subjectTarget('expense'), null)
}

// ── 3. Which field is which, per collection ───────────────────────────────────
{
  eq('users: name / email / phoneNumber', personFacts({ name: 'A', email: 'e', phoneNumber: 'p' }),
    { found: true, name: 'A', email: 'e', phone: 'p', photoUrl: '' })
  eq('publicProfiles never carries a contact, whatever the doc holds',
    publicFacts({ name: 'A', email: 'leak@x', phone: '1' }), { found: true, name: 'A', email: '', phone: '', photoUrl: '' })
  eq('agencies are named by agencyName (not name)', agencyFacts({ agencyName: 'Star Agency', name: 'wrong' }).name, 'Star Agency')
  eq('agency contacts are the owner\'s', agencyFacts({ ownerEmail: 'o@x', ownerPhone: '9' }).email + '|' + agencyFacts({ ownerPhone: '9' }).phone, 'o@x|9')
  eq('sellers are named by displayName', sellerFacts({ displayName: 'Coin Co' }).name, 'Coin Co')
}

// ── 4. Batched lookups ────────────────────────────────────────────────────────
{
  eq('ids are trimmed, de-duplicated, blanks and paths dropped', uniqueIds([' a ', 'a', '', 'b/c', 7, 'b']), ['a', 'b'])
  eq('30 per query (Firestore `in` limit)', chunks(Array.from({ length: 61 }, (_, i) => i)).map((c) => c.length), [30, 30, 1])

  const m = new Map<string, IdentityFacts>()
  foldBatch(m, ['x', 'y'], [{ id: 'x', data: { name: 'X' } }], personFacts)
  eq('a found doc becomes its facts', m.get('x')?.name, 'X')
  eq('an asked-for id with no doc is MISSING (Profile not found)', m.get('y')?.found, false)
  ok('an id never asked for stays unknown (Name unavailable)', !m.has('z'))

  eq('partner: found as an agency', mergePartner(agencyFacts({ agencyName: 'A' }), MISSING)?.name, 'A')
  eq('partner: found as a seller', mergePartner(MISSING, sellerFacts({ displayName: 'S' }))?.name, 'S')
  eq('partner: missing from both reads → MISSING', mergePartner(MISSING, MISSING)?.found, false)
  eq('partner: one read failed and the other did not find it → unknown', mergePartner(MISSING, undefined), undefined)
}

// ── 5. The screens use it the right way (source checks) ──────────────────────
{
  const root = path.join(__dirname, '..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  const frozen = read('app/frozen-money/page.tsx')
  ok('frozen money: subject named through the shared block', frozen.includes('<IdentityBlock'))
  ok('frozen money: an account freeze and a partner-record freeze are told apart', frozen.includes("'Account freeze'") && frozen.includes('record freeze'))
  ok('frozen money: the partner\'s owner is named', frozen.includes('Owned by'))
  ok('frozen money: contacts only with can_view_users', frozen.includes("hasPermission(crmUser, 'can_view_users')"))
  ok('frozen money: decide still posts the same freeze key', frozen.includes('frozenMoney.decide(deciding.row.id'))
  ok('frozen money: no raw subject id as the title any more', !frozen.includes("'Account' : 'Partner'} {r.subject.id}"))

  const appeals = read('app/role-appeals/page.tsx')
  ok('role appeals: the person is named', appeals.includes('facts={who.people.get(a.uid)}'))
  ok('role appeals: account id, host/partner id and request id are labelled separately',
    appeals.includes('kind="account"') && appeals.includes('ID_LABEL.host') && appeals.includes('ID_LABEL.partner') && appeals.includes('ID_LABEL.request'))
  ok('role appeals: the record is looked up as a PARTNER, not as a person',
    appeals.includes("partners: rows.filter((a) => a.kind !== 'host').map((a) => a.record_id)"))
  ok('role appeals: contacts only with can_view_users', appeals.includes("hasPermission(crmUser, 'can_view_users')"))
  ok('role appeals: recommend / decide unchanged', appeals.includes('roleAppeals.recommend(target.appeal.id') && appeals.includes('roleAppeals.decide(target.appeal.id'))

  for (const [rel, what] of [
    ['app/transfers/page.tsx', 'transfers host subject'],
    ['app/sales/page.tsx', 'sales buyer'],
    ['app/recharges/page.tsx', 'recharge buyer'],
  ] as const) {
    const src = read(rel)
    ok(`${what}: named via useIdentities`, src.includes('useIdentities('))
    ok(`${what}: contacts only with can_view_users`, src.includes("hasPermission(crmUser, 'can_view_users')"))
  }
  ok('board: card subject named, other subjects untouched', read('app/board/page.tsx').includes('<CardSubject'))
  ok('device bans: holders named', read('app/operations/bans/page.tsx').includes("nameOrReference(names.get(uid), uid, 'account')"))
  ok('audit: only the subjects the API returned are named', read('app/audit/page.tsx').includes('subjectTarget(e.subject.type)'))

  // Partner-facing screens: the PUBLIC profile only — a name, never a contact.
  const sellerDash = read('app/seller-dashboard/page.tsx')
  ok('seller portal: buyers named from the public profile', sellerDash.includes('publicPeople: sales?.ok'))
  ok('seller portal: never reads `users` for a buyer', !/useIdentities\(\{\s*people:/.test(sellerDash))
  const history = read('components/SellerHistoryPanel.tsx')
  ok('seller history: buyers named from the public profile only', history.includes('publicPeople:') && !history.includes('people: history'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} identity checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} identity checks passed.`)
console.log('  · name first; email/phone only when authorised and present; a labelled id always')
console.log('  · Profile not found / No name / Name unavailable are three different facts, never a made-up name')
console.log('  · account, partner, host, buyer and request ids are labelled apart; partner screens use public names only')
