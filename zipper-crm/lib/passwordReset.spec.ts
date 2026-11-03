/**
 * QA #46 — the "Forgot password" box no longer doubles a typed address, and a
 * refusal says what is wrong.
 *
 * REAL: `lib/passwordReset.ts`, imported and called; the login page is read
 * for the wiring.
 *
 *   npm run test:passwordreset
 */

import * as fs from 'fs'
import * as path from 'path'
import { resetEmailProblem, resetErrorText } from './passwordReset'

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

eq('the QA case: an address typed twice is caught before sending',
  resetEmailProblem('owner2@zipper.testowner2@zipper.test'),
  'That looks like more than one email address. Enter just the one you sign in with.')
eq('one address is fine', resetEmailProblem('  owner2@zipper.test '), null)
eq('empty', resetEmailProblem(''), 'Enter your email address.')
eq('no domain', resetEmailProblem('owner2@zipper'), 'That is not a valid email address. Check it and try again.')

eq('Firebase: invalid email', resetErrorText({ code: 'auth/invalid-email' }), 'That is not a valid email address. Check it and try again.')
eq('Firebase: too many requests', resetErrorText({ code: 'auth/too-many-requests' }),
  'Too many reset requests from this browser. Wait a few minutes, then try again.')
eq('Firebase: offline', resetErrorText({ code: 'auth/network-request-failed' }),
  'Could not reach the server. Check your connection and try again.')
eq('anything else', resetErrorText(new Error('x')), 'Could not send the reset email just now. Try again in a minute.')

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'login', 'page.tsx'), 'utf8')
ok('the carried-over address is selected, so typing replaces it', page.includes('onFocus={(e) => e.currentTarget.select()}'))
ok('the address is checked before sending', page.includes('const problem = resetEmailProblem(emailTrimmed)'))
ok('a refusal is worded by resetErrorText', page.includes('setForgotError(resetErrorText(err))'))
ok('the old catch-all sentence is gone', !page.includes("Could not send reset email. Check the address and try again."))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} password reset checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} password reset checks passed.`)
console.log('  · QA #46: the reset box replaces, not doubles, a typed address; refusals say what is wrong')
