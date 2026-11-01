/**
 * RC — staff registration (`/agencies/register`, `/sellers/register`): the
 * login first, the record second, and the login removed again when the record
 * cannot be written — so a failed attempt leaves no orphan login holding the
 * address, and the retry the page offers is not refused on it.
 *
 * REAL: `lib/loginThenRecord.ts`, imported and called, over an in-memory Auth
 * where an address holds ONE login. The pages' wiring is checked on their
 * source (they are React screens; this is not an end-to-end test).
 *
 *   npm run test:loginthenrecord
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  RecordNotWritten,
  isRecordNotWritten,
  recordNotWrittenMessage,
  runLoginThenRecord,
  type LoginThenRecordSteps,
} from './loginThenRecord'

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

interface World {
  logins: Map<string, string> // email → uid
  records: string[]
  finished: number
  nextUid: number
}
const world = (): World => ({ logins: new Map(), records: [], finished: 0, nextUid: 1 })

function steps(w: World, email: string, opts: { recordFails?: boolean; deleteFails?: boolean } = {}): LoginThenRecordSteps<string> {
  return {
    createLogin: async () => {
      if (w.logins.has(email)) throw Object.assign(new Error('in use'), { code: 'auth/email-already-in-use' })
      const uid = `U${w.nextUid++}`
      w.logins.set(email, uid)
      return uid
    },
    writeRecord: async (uid) => {
      if (opts.recordFails) throw new Error('Missing or insufficient permissions.')
      w.records.push(uid)
      return `REC_${uid}`
    },
    deleteLogin: async (uid) => {
      if (opts.deleteFails) throw new Error('requires-recent-login')
      Array.from(w.logins.keys()).forEach((e) => { if (w.logins.get(e) === uid) w.logins.delete(e) })
    },
    finish: async () => { w.finished += 1 },
  }
}

async function attempt<T>(p: Promise<T>): Promise<{ value?: T; err?: unknown }> {
  try { return { value: await p } } catch (err) { return { err } }
}

async function main(): Promise<void> {
  // ── the ordinary case ───────────────────────────────────────────────────────
  {
    const w = world()
    const r = await runLoginThenRecord(steps(w, 'a@x.io'))
    eq('login then record: both exist, the record names the login', [r.uid, r.result, w.records], ['U1', 'REC_U1', ['U1']])
    eq('…and the secondary session is always released', w.finished, 1)
  }

  // ── the record write fails: the login is removed again ─────────────────────
  {
    const w = world()
    const r = await attempt(runLoginThenRecord(steps(w, 'b@x.io', { recordFails: true })))
    ok('a failed record write raises RecordNotWritten', r.err instanceof RecordNotWritten && isRecordNotWritten(r.err))
    const e = r.err as RecordNotWritten
    eq('…saying the login was removed', [e.uid, e.loginRemoved], ['U1', true])
    eq('…and it is: no orphan login holds the address', w.logins.has('b@x.io'), false)
    eq('…no record either', w.records, [])
    eq('…the secondary session released', w.finished, 1)
    const retry = await runLoginThenRecord(steps(w, 'b@x.io'))
    eq('the retry the page offers is NOT refused on the address', [retry.uid, w.records], ['U2', ['U2']])
    ok('the message says nothing was created and to try again',
      recordNotWrittenMessage(e, 'b@x.io', 'agency').includes('removed again. You can try again.'))
  }

  // ── …and when even the removal fails, the page is told so ──────────────────
  {
    const w = world()
    const r = await attempt(runLoginThenRecord(steps(w, 'c@x.io', { recordFails: true, deleteFails: true })))
    const e = r.err as RecordNotWritten
    eq('an undeletable login is reported, not hidden', [isRecordNotWritten(e), e.loginRemoved], [true, false])
    ok('…with what to do about it',
      recordNotWrittenMessage(e, 'c@x.io', 'coin seller').includes('could NOT be removed'))
    eq('…the original reason is kept', e.message, 'Missing or insufficient permissions.')
    eq('…the secondary session still released', w.finished, 1)
  }

  // ── the login itself is refused: nothing to undo, the error is the original ─
  {
    const w = world()
    w.logins.set('d@x.io', 'U0')
    const r = await attempt(runLoginThenRecord(steps(w, 'd@x.io')))
    eq('an address in use propagates as it is (the page words it)',
      [(r.err as { code?: string }).code, isRecordNotWritten(r.err)], ['auth/email-already-in-use', false])
    eq('…the existing login is untouched', w.logins.get('d@x.io'), 'U0')
    eq('…released', w.finished, 1)
  }

  // ── both register pages use it for the record write ────────────────────────
  for (const [page, record] of [
    ['agencies', "addDoc(collection(db, 'agencies')"],
    ['sellers', "addDoc(collection(db, 'sellers')"],
  ] as const) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', page, 'register', 'page.tsx'), 'utf8')
    const call = src.indexOf('createPartnerLoginThen(')
    ok(`/${page}/register creates the login with createPartnerLoginThen`, call > 0)
    ok(`/${page}/register no longer calls createPartnerLogin({ … }) and writes afterwards`,
      !src.includes('await createPartnerLogin({'))
    const writer = src.slice(call, src.indexOf('isRecordNotWritten(', call))
    ok(`/${page}/register: the Owner's record write is inside it`, writer.includes(record))
    ok(`/${page}/register: the approval request is inside it`, writer.includes('await submitApproval('))
    ok(`/${page}/register: a RecordNotWritten is worded with recordNotWrittenMessage`,
      src.includes('recordNotWrittenMessage('))
    // Audit C-17 / CRM-FLOW 2.1.3: staff never type the partner's password.
    ok(`/${page}/register has no password field`, !src.includes('type="password"'))
    ok(`/${page}/register passes no password to the login`, !/password:\s*form\.password/.test(src))
    ok(`/${page}/register tells staff whether the set-password email went out`, src.includes('resetEmailSent'))
  }
  {
    const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8')
    const fn = auth.slice(auth.indexOf('export async function createPartnerLoginThen'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    ok('createPartnerLoginThen deletes the secondary session\'s own new user on failure',
      body.includes('const user = secondaryAuth.currentUser') && body.includes('await deleteUser(user)')
      && body.includes('runLoginThenRecord('))
    // C-17: a generated password, thrown away, and a set-password email after the record.
    ok('createPartnerLoginThen generates the initial password itself', body.includes('generateInitialPassword()'))
    ok('…and takes none from the caller', !/params\.password/.test(body))
    ok('…and sends the set-password email AFTER the record is written',
      body.indexOf('await writeRecord(uid)') > 0
      && body.indexOf('sendPasswordResetEmail(secondaryAuth, emailLower)') > body.indexOf('await writeRecord(uid)'))
    const gen = auth.slice(auth.indexOf('export function generateInitialPassword'), auth.indexOf('export async function createPartnerLoginThen'))
    ok('the generated password comes from crypto.getRandomValues, not Math.random',
      gen.includes('getRandomValues') && !gen.includes('Math.random'))
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} login-then-record checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} login-then-record checks passed.`)
  console.log('  · a failed record write removes the login it just made; the retry is not refused')
  console.log('  · a login that cannot be removed is reported, never hidden')
}

void main()
