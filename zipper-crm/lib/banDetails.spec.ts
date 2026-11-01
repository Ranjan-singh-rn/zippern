/**
 * §5 — a ban records its scope, its category and its evidence, exactly as the
 * server's `Ban` body takes them, from both screens that ban.
 *
 * REAL: `lib/banDetails.ts`, imported and run. The wiring — the account page,
 * the /users row action, the shared fields component and `lib/api.ts` — is
 * checked on their source; the scope pattern and the bounds are compared with
 * `backend/app/routers/users.py`, and the category list with the Android Work
 * hub's, whenever those sit beside this repo.
 *
 *   npm run test:bandetails
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  BAN_CATEGORIES, BAN_SCOPES, BAN_SCOPE_EFFECT, BAN_SCOPE_LABEL, DEFAULT_BAN_DETAILS, DEFAULT_BAN_SCOPE,
  MAX_BAN_EVIDENCE, MAX_CATEGORY_LENGTH, MAX_EVIDENCE_LENGTH,
  banCategoryLabel, banDetailsBody, banDetailsProblem, banDetailsSummary, banScopeLabel, isBanScope,
  parseEvidence,
} from './banDetails'

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

const input = (o: Partial<typeof DEFAULT_BAN_DETAILS> = {}) => ({ ...DEFAULT_BAN_DETAILS, ...o })
const lines = (n: number) => Array.from({ length: n }, (_, i) => `rep-${i + 1}`).join('\n')

// ── 1. scope ─────────────────────────────────────────────────────────────────
eq('exactly the two scopes the server accepts', [...BAN_SCOPES].sort(), ['account', 'account_and_devices'])
eq('the default is what a ban has always done', DEFAULT_BAN_SCOPE, 'account_and_devices')
eq('…and the dialog starts there', DEFAULT_BAN_DETAILS.scope, 'account_and_devices')
ok('each scope has a label and an effect', BAN_SCOPES.every((s) => BAN_SCOPE_LABEL[s].length > 0 && BAN_SCOPE_EFFECT[s].length > 0))
ok('the devices effect says other people on the phone are locked out too', /shares one of those phones/.test(BAN_SCOPE_EFFECT.account_and_devices))
ok('the account effect says the handsets are left alone', /left alone/.test(BAN_SCOPE_EFFECT.account))
eq('an unknown scope is not a scope', [isBanScope('devices'), isBanScope(''), isBanScope('ACCOUNT')], [false, false, false])
eq('labels for a reader', [banScopeLabel('account'), banScopeLabel(''), banScopeLabel('mystery')],
  ['Account only', 'Not recorded', 'mystery'])

// ── 2. category ──────────────────────────────────────────────────────────────
eq('"not stated" is the first choice and the default', [BAN_CATEGORIES[0].value, DEFAULT_BAN_DETAILS.category], ['', ''])
ok('every category value is short enough for the server', BAN_CATEGORIES.every((c) => c.value.length <= MAX_CATEGORY_LENGTH))
eq('labels for a reader', [banCategoryLabel('fraud'), banCategoryLabel(''), banCategoryLabel('custom thing')],
  ['Fraud / scam', 'Not stated', 'custom thing'])

// ── 3. evidence ──────────────────────────────────────────────────────────────
eq('one per line, trimmed, blanks dropped', parseEvidence('  rep-77 \r\n\n appealEvidence/x/1.jpg\n  '),
  ['rep-77', 'appealEvidence/x/1.jpg'])
eq('nothing is nothing', [parseEvidence(''), parseEvidence(undefined)], [[], []])
eq(`${MAX_BAN_EVIDENCE} references pass`, banDetailsProblem(input({ evidenceText: lines(MAX_BAN_EVIDENCE) })), '')
ok(`${MAX_BAN_EVIDENCE + 1} are refused before sending (the server answers 422)`,
  /At most 10/.test(banDetailsProblem(input({ evidenceText: lines(MAX_BAN_EVIDENCE + 1) }))))
ok('blank lines do not count against the limit', banDetailsProblem(input({ evidenceText: `${lines(10)}\n\n\n` })) === '')
ok(`a reference over ${MAX_EVIDENCE_LENGTH} characters is refused`,
  banDetailsProblem(input({ evidenceText: 'x'.repeat(MAX_EVIDENCE_LENGTH + 1) })) !== '')
ok('a category over 80 characters is refused', banDetailsProblem(input({ category: 'c'.repeat(81) })) !== '')
ok('an unknown scope is refused', banDetailsProblem(input({ scope: 'devices' })) !== '')
eq('the defaults pass', banDetailsProblem(input()), '')

// ── 4. the body ──────────────────────────────────────────────────────────────
eq('scope is always sent, the rest only when there is something', banDetailsBody(input()),
  { scope: 'account_and_devices' })
eq('account only, with a category and evidence', banDetailsBody(input({ scope: 'account', category: 'fraud', evidenceText: 'rep-77\nrep-78' })),
  { scope: 'account', category: 'fraud', evidence: ['rep-77', 'rep-78'] })
eq('an unknown scope is never sent as written', banDetailsBody(input({ scope: 'nonsense' })).scope, 'account_and_devices')
ok('the summary names the scope and counts the evidence',
  banDetailsSummary(input({ scope: 'account', evidenceText: 'a\nb' })) === 'Scope: Account only · 2 evidence references.')

// ── 5. compared with the server and with the app ─────────────────────────────
{
  const users = path.join(__dirname, '..', '..', 'backend', 'app', 'routers', 'users.py')
  if (fs.existsSync(users)) {
    const s = fs.readFileSync(users, 'utf8')
    ok('server: the scope pattern is exactly these two',
      s.includes('scope: str = Field(default="account_and_devices", pattern=r"^(account|account_and_devices)$")'))
    ok('server: a category is at most 80', s.includes('category: str = Field(default="", max_length=80)'))
    ok('server: at most 10 evidence references', s.includes('evidence: list[str] = Field(default_factory=list, max_length=10)'))
  } else {
    console.log('  (backend not beside this repo — the Ban body comparison was skipped)')
  }
  const kt = path.join(__dirname, '..', '..', 'zipper-app', 'app', 'src', 'main', 'java', 'com', 'zipper', 'app', 'data', 'work', 'WorkActions.kt')
  if (fs.existsSync(kt)) {
    const k = fs.readFileSync(kt, 'utf8')
    const block = /banCategories = arrayOf\(([\s\S]*?)\n\)/.exec(k)
    const values = block ? Array.from(block[1].matchAll(/"([a-z_]*)" to "/g)).map((m) => m[1]) : []
    eq('the category values are the Android Work hub\'s, in order', BAN_CATEGORIES.map((c) => c.value), values)
  } else {
    console.log('  (Android app not beside this repo — the category comparison was skipped)')
  }
}

// ── 6. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
  const fields = read('components/BanDetailsFields.tsx')
  ok('the shared fields offer every scope, every category and the evidence box',
    fields.includes('BAN_SCOPES.map(') && fields.includes('BAN_CATEGORIES.map(') && fields.includes('MAX_BAN_EVIDENCE'))
  const detail = read('app/users/[uid]/UserActions.tsx')
  ok('the account page asks for the details', detail.includes('<BanDetailsFields'))
  ok('…checks them before sending', detail.includes('banDetailsProblem('))
  ok('…and sends them with the ban', /api\.users\.ban\(uid, why, banDetailsBody\(/.test(detail))
  const list = read('app/users/page.tsx')
  ok('the /users row action asks for them too', list.includes('<BanDetailsFields'))
  ok('…and sends them', /api\.users\.ban\(user\.uid, why, banDetailsBody\(/.test(list))
  const api = read('lib/api.ts')
  ok('lib/api.ts sends scope, category and evidence on a ban',
    api.includes('{ scope: details.scope }') && api.includes('{ category: details.category }') && api.includes('{ evidence: details.evidence }'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} ban-detail checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} ban-detail checks passed.`)
console.log('  · scope (account | account_and_devices, default the latter), category and ≤ 10 evidence references')
console.log('  · checked before sending; scope always explicit; both ban dialogs send them')
