/**
 * §5 — the public appeal sends the contact on the account, and tells a MISSING
 * contact from a WRONG one.
 *
 * The bug this guards: the backend began refusing every public appeal that did
 * not name the phone number or email on the account (CONTACT_REQUIRED), and
 * `/appeal` never asked for one — so nobody locked out of the app could appeal
 * from the web at all, and the page said only what the server said, with no
 * field to fix.
 *
 * REAL: `lib/publicAppealContact.ts`, imported and run. The wiring in
 * `app/appeal/page.tsx` and `lib/api.ts` is checked on their source, and the
 * two refusal sentences are compared with `backend/app/services/
 * public_appeals.py` when the backend sits beside this repo.
 *
 *   npm run test:appealcontact
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  CONTACT_MISMATCH_MESSAGE, CONTACT_REQUIRED_MESSAGE, MAX_CONTACT,
  classifyPublicAppealRefusal, contactKind, contactProblem, isContactRefusal,
  maskContact, normaliseContact, presentPublicAppealRefusal,
} from './publicAppealContact'

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

/** A Python string constant, joined across implicit concatenation. */
function pyConst(src: string, name: string): string | null {
  const block = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\n\\)`, 'm').exec(src)
  if (block) return Array.from(block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1]).join('')
  const one = new RegExp(`^${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(src)
  return one ? one[1] : null
}

// ── 1. shape checks before any round trip ────────────────────────────────────
eq('an empty contact is refused with the server\'s own sentence', contactProblem(''), CONTACT_REQUIRED_MESSAGE)
eq('whitespace is empty', contactProblem('   '), CONTACT_REQUIRED_MESSAGE)
eq('a non-string is empty', contactProblem(undefined), CONTACT_REQUIRED_MESSAGE)
eq('an email passes', contactProblem('Guest.Y@Example.com'), '')
ok('a broken email is refused before sending', contactProblem('guest@') !== '')
ok('…and so is one with a space', contactProblem('gu est@example.com') !== '')
eq('a 10-digit phone passes', contactProblem('9876543210'), '')
eq('with the country code', contactProblem('+91 98765 43210'), '')
eq('with a trunk zero and punctuation', contactProblem('(098765) 43-210'), '')
ok('fewer than six digits is refused (the server compares at least six)', contactProblem('12345') !== '')
ok('six digits pass', contactProblem('123456') === '')
ok('leading zeros do not count as digits', contactProblem('0001234') !== '')
ok('letters in a phone number are refused', contactProblem('98765abc10') !== '')
ok(`longer than ${MAX_CONTACT} characters is refused (the server's bound)`, contactProblem(`${'9'.repeat(MAX_CONTACT)}1`) !== '')
eq('exactly the bound passes', contactProblem('9'.repeat(MAX_CONTACT)), '')

// The server's normalisation, mirrored (services/public_appeals.normalise_contact).
eq('email lower-cased', normaliseContact(' Guest@Example.COM '), 'guest@example.com')
eq('phone → digits', normaliseContact('+91 98765 43210'), '919876543210')
eq('trunk zero dropped', normaliseContact('098765 43210'), '9876543210')
eq('kinds', [contactKind(''), contactKind('a@b.co'), contactKind('98765')], ['none', 'email', 'phone'])

// What the second step shows: enough to recognise, not the whole thing.
eq('a masked email keeps the domain', maskContact('guest@example.com'), 'g****@example.com')
eq('a masked phone keeps the last four', maskContact('+91 98765 43210'), '••••••••3210')
eq('nothing to mask', maskContact(''), '')

// ── 2. the two refusals are told apart, and from everything else ─────────────
const required = { status: 400, message: CONTACT_REQUIRED_MESSAGE }
const mismatch = { status: 400, message: CONTACT_MISMATCH_MESSAGE }
eq('CONTACT_REQUIRED', classifyPublicAppealRefusal(required), 'contact_required')
eq('CONTACT_MISMATCH', classifyPublicAppealRefusal(mismatch), 'contact_mismatch')
eq('not found', classifyPublicAppealRefusal({ status: 400, message: 'We could not find a restricted account with those details. Check the account ID on your Banned or Suspended screen and try again.' }), 'not_found')
eq('already pending', classifyPublicAppealRefusal({ status: 400, message: 'An appeal for this account is already being reviewed. You will be able to file another once it has been decided.' }), 'already_pending')
eq('a 429 is a rate limit whatever it says', classifyPublicAppealRefusal({ status: 429, message: CONTACT_REQUIRED_MESSAGE }), 'rate_limited')
eq('a 413 is too large', classifyPublicAppealRefusal({ status: 413, message: 'One of the attachments is too large.' }), 'too_large')
eq('anything else is other', classifyPublicAppealRefusal({ status: 500, message: 'boom' }), 'other')
eq('null is other, never a throw', classifyPublicAppealRefusal(null), 'other')
eq('a string is other', classifyPublicAppealRefusal('CONTACT_MISMATCH'), 'other')
eq('only the two contact refusals mark the field',
  (['contact_required', 'contact_mismatch', 'not_found', 'already_pending', 'rate_limited', 'too_large', 'other'] as const)
    .map(isContactRefusal),
  [true, true, false, false, false, false, false])

// ── 3. shown clearly, and verbatim ───────────────────────────────────────────
{
  const v = presentPublicAppealRefusal(mismatch)
  eq('a mismatch marks the contact field', v.contactField, true)
  eq('…keeps the server\'s sentence word for word', v.message, CONTACT_MISMATCH_MESSAGE)
  ok('…has its own heading', /do not match/i.test(v.title))
  ok('…and says a phone works with or without the country code', /country code/i.test(v.hint))
  const r = presentPublicAppealRefusal(required)
  eq('a missing contact marks the field too', [r.contactField, r.message], [true, CONTACT_REQUIRED_MESSAGE])
  ok('…with a different heading from the mismatch', r.title !== v.title && r.title.length > 0)
  const reworded = presentPublicAppealRefusal({ status: 400, message: `${CONTACT_MISMATCH_MESSAGE} (ref 7)` })
  eq('a server sentence with extra words is still shown exactly as sent', reworded.message, `${CONTACT_MISMATCH_MESSAGE} (ref 7)`)
  const other = presentPublicAppealRefusal({ status: 503, message: 'Service unavailable' })
  eq('anything else: no heading, the sentence as sent, the field untouched', [other.title, other.message, other.contactField],
    ['', 'Service unavailable', false])
  eq('no message at all → the fallback, not a blank', presentPublicAppealRefusal({}, 'Try again.').message, 'Try again.')
}

// ── 4. the server's sentences, compared with the server ──────────────────────
{
  const backend = path.join(__dirname, '..', '..', 'backend', 'app')
  const svc = path.join(backend, 'services', 'public_appeals.py')
  const router = path.join(backend, 'routers', 'public_appeals.py')
  if (fs.existsSync(svc) && fs.existsSync(router)) {
    const s = fs.readFileSync(svc, 'utf8')
    eq('CONTACT_REQUIRED is the server\'s sentence', pyConst(s, 'CONTACT_REQUIRED'), CONTACT_REQUIRED_MESSAGE)
    eq('CONTACT_MISMATCH is the server\'s sentence', pyConst(s, 'CONTACT_MISMATCH'), CONTACT_MISMATCH_MESSAGE)
    const r = fs.readFileSync(router, 'utf8')
    ok('the lookup body takes `contact` (≤ 120)', /contact: str = Field\(default="", max_length=120\)/.test(r))
    ok('the filing reads the `contact` form field (0–120)', r.includes('_field(form, "contact", 0, 120)'))
  } else {
    console.log('  (backend not beside this repo — the server-sentence comparison was skipped)')
  }
}

// ── 5. the wiring ────────────────────────────────────────────────────────────
{
  const root = path.join(__dirname, '..')
  const page = fs.readFileSync(path.join(root, 'app', 'appeal', 'page.tsx'), 'utf8')
  ok('the page asks for the contact on the account', page.includes('Phone number or email on the account'))
  ok('…checks its shape before sending', page.includes('contactProblem('))
  ok('…sends it with the lookup', /publicAppeals\.lookup\([^\n]*contact\.trim\(\)\)/.test(page))
  ok('…and with the filing', /publicAppeals\.submit\(\{[\s\S]*?contact[\s\S]*?\}\)/.test(page))
  ok('…presents every refusal through the shared reader', page.includes('presentPublicAppealRefusal('))
  ok('…and marks the field when the contact is what is wrong', page.includes('aria-invalid'))

  const api = fs.readFileSync(path.join(root, 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts: the lookup body carries the contact', api.includes('{ account_id: accountId, display_name: displayName, contact }'))
  ok('lib/api.ts: the multipart filing carries the contact', api.includes("fd.append('contact', form.contact)"))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} public-appeal contact checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} public-appeal contact checks passed.`)
console.log('  · the phone number or email on the account is asked for, checked for shape, and sent with lookup and filing')
console.log('  · CONTACT_REQUIRED and CONTACT_MISMATCH are told apart, shown verbatim, and mark the field')
console.log('  · the copies of both sentences are the server\'s, word for word')
