/**
 * QA #26 — when verifying the second contact starts an approved partner role,
 * the CRM hands over to a new session and opens the dashboard instead of
 * sending the person to /login with "Session has been revoked".
 *
 * REAL: `lib/sessionHandover.ts`, run with fakes for the three hooks, in the
 * order the AuthProvider supplies them. The provider, the panel and the
 * server's revocation are read from source for the wiring.
 *
 *   npm run test:handover
 */

import * as fs from 'fs'
import * as path from 'path'
import { HANDOVER_HOLD_MS, SessionHandoverError, handOverSession, waitForPartnerClaim } from './sessionHandover'

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

type Out = { waiting: string[]; started: string[] }
const started = (o: Out) => o.started.length > 0

function harness(opts: { signInFails?: boolean } = {}) {
  const log: string[] = []
  let held = false
  const hooks = {
    hold: () => { held = true; log.push('hold'); return () => { held = false; log.push('release') } },
    signIn: async () => {
      log.push(`signIn(held=${held})`)
      if (opts.signInFails) throw new Error('auth/network-request-failed')
      return { uid: 'p1', role: 'agency' }
    },
    adopt: (u: { uid: string }) => { log.push(`adopt(${u.uid}, held=${held})`) },
  }
  return { log, hooks, isHeld: () => held }
}

async function main(): Promise<void> {
  // ── The QA case: the role starts → a new session, then the dashboard ───────
  {
    const h = harness()
    const out = await handOverSession<Out, { uid: string }>(
      async () => { h.log.push('check'); return { waiting: [], started: ['agency'] } }, started, h.hooks)
    eq('the role started: the session is handed over', out.handedOver, true)
    eq('…in order: hold, check, sign in, adopt, release — the 401 handler held throughout',
      h.log, ['hold', 'check', 'signIn(held=true)', 'adopt(p1, held=true)', 'release'])
    eq('…and released afterwards', h.isHeld(), false)
  }

  // ── Nothing started: nobody is signed in again ─────────────────────────────
  {
    const h = harness()
    const out = await handOverSession<Out, { uid: string }>(
      async () => { h.log.push('check'); return { waiting: ['agency'], started: [] } }, started, h.hooks)
    eq('one contact still missing: no handover, no sign-in', [out.handedOver, h.log], [false, ['hold', 'check', 'release']])
  }

  // ── The step fails: released, the error is the step's ──────────────────────
  {
    const h = harness()
    let caught = ''
    try {
      await handOverSession<Out, { uid: string }>(async () => { throw new Error('Could not check just now.') }, started, h.hooks)
    } catch (err) { caught = (err as Error).message }
    eq('a failed check signs nobody in and is reported as itself', [caught, h.log], ['Could not check just now.', ['hold', 'release']])
  }

  // ── The new session cannot be made: released, and the person is told why ───
  {
    const h = harness({ signInFails: true })
    let err: unknown = null
    try {
      await handOverSession<Out, { uid: string }>(async () => ({ waiting: [], started: ['seller'] }), started, h.hooks)
    } catch (e) { err = e }
    ok('a failed sign-in is a SessionHandoverError', err instanceof SessionHandoverError)
    const e = err as SessionHandoverError<Out>
    ok('…which says the role started and to sign in again', e.message.startsWith('Your role has started') && e.message.includes('Sign in again'))
    eq('…carries the check\'s answer', e.result.started, ['seller'])
    eq('…and nothing was adopted; the handler was released', h.log, ['hold', 'signIn(held=true)', 'release'])
  }

  // ── Bounded (security review, 3 Nov 2026): the hold cannot outlive the step ─
  {
    const h = harness()
    const timers: { fire: () => void; ms: number; cancelled: boolean }[] = []
    const timer = (fire: () => void, ms: number) => {
      const t = { fire, ms, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    }
    let finish: (v: Out) => void = () => undefined
    const pending = handOverSession<Out, { uid: string }>(
      () => new Promise<Out>((resolve) => { finish = resolve }), started, h.hooks, { timer })
    eq('the hold is timed at HANDOVER_HOLD_MS (60 s) by default', [timers.length, timers[0]?.ms, HANDOVER_HOLD_MS], [1, 60_000, 60_000])
    eq('…held while the step runs', h.isHeld(), true)
    timers[0].fire()   // the step has not settled in time
    eq('a step that never settles: the 401 handler is released at the deadline', [h.isHeld(), h.log], [false, ['hold', 'release']])
    finish({ waiting: ['agency'], started: [] })
    const out = await pending
    eq('…and released ONCE — the late finish does not release again', [out.handedOver, h.log], [false, ['hold', 'release']])
  }
  {
    const h = harness()
    let cancelled = false
    await handOverSession<Out, { uid: string }>(async () => ({ waiting: [], started: [] }), started, h.hooks,
      { timer: () => () => { cancelled = true } })
    eq('a step that finishes cancels its deadline and releases once', [cancelled, h.log], [true, ['hold', 'release']])
  }

  // ── E2E re-run (3 Nov 2026): the Storage claim reaches the token before the new session ──
  {
    const sleeps: number[] = []
    const sleep = async (ms: number) => { sleeps.push(ms) }
    const answers: (Record<string, unknown> | null)[] = [{}, { role: undefined }, { role: 'agency', aid: 'A1' }]
    let reads = 0
    const ok1 = await waitForPartnerClaim(async () => answers[reads++] ?? null, { sleep })
    eq('the claim written by the trigger a moment later is waited for, then the sign-in goes ahead',
      [ok1, reads, sleeps], [true, 3, [1000, 1000]])
    const seller = await waitForPartnerClaim(async () => ({ role: 'seller' }), { sleep: async () => undefined })
    eq('a coin seller\'s claim counts too', seller, true)
    let tries = 0
    const never = await waitForPartnerClaim(async () => { tries += 1; return { role: 'owner' } }, { sleep: async () => undefined })
    eq('a claim that never comes stops after 8 reads and is not an error', [never, tries], [false, 8])
    let failing = 0
    const broken = await waitForPartnerClaim(async () => { failing += 1; throw new Error('network') },
      { sleep: async () => undefined, tries: 3 })
    eq('…and a failing read is just a miss', [broken, failing], [false, 3])
  }

  // ── The wiring ──────────────────────────────────────────────────────────────
  const root = path.join(__dirname, '..')
  const provider = fs.readFileSync(path.join(root, 'components', 'AuthProvider.tsx'), 'utf8')
  ok('the provider holds the 401 handler (recovering) for the window', provider.includes('recovering.current = held'))
  ok('…and scheduled renewals too, while ANY handover is in progress (a count, not a flag)',
    provider.includes('if (giveUp.current || handovers.current > 0) return null'))
  ok('…and a 401 recovery, even if `recovering` was cleared by one already running',
    provider.includes('if (giveUp.current || recovering.current || handovers.current > 0) return'))
  ok('…each hold counted in and released once',
    provider.includes('handovers.current += 1') && provider.includes('if (done) return')
    && provider.includes('handovers.current = Math.max(0, handovers.current - 1)'))
  ok('…no single flag left that a first release could clear under a second handover', !provider.includes('handingOver'))
  ok('…signs in through the ordinary door', provider.includes('return api.auth.signInWithFirebase()'))
  ok('…after waiting for the started role\'s Storage claim to reach the token',
    provider.indexOf('await waitForPartnerClaim(') >= 0
    && provider.indexOf('await waitForPartnerClaim(') < provider.indexOf('return api.auth.signInWithFirebase()')
    && provider.includes('getIdTokenResult(true)'))
  ok('…and treats old-token stragglers as stragglers', provider.includes('renewedAt.current = Date.now()\n          accept(u)'))
  ok('renewal of a revoked session is NOT papered over: refresh refusal still requires sign-in',
    provider.includes('requireSignIn(message)'))
  const panel = fs.readFileSync(path.join(root, 'components', 'ContactVerificationPanel.tsx'), 'utf8')
  ok('the panel runs the check inside the handover', panel.includes('await handOverSession(() => myVerification.check(), startedAny)'))
  ok('…reloads only after a handover', panel.includes('if (handedOver) {'))
  ok('…and explains a failed handover instead of a dead page', panel.includes('err instanceof SessionHandoverError'))

  const ops = path.join(root, '..', 'backend', 'app', 'services', 'partner_ops.py')
  if (fs.existsSync(ops)) {
    const src = fs.readFileSync(ops, 'utf8')
    ok('server: starting a role still revokes the old sessions (the handover does not weaken that)',
      src.includes('out_sessions = await _revoke_partner_sessions(updated or partner)'))
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} session handover checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} session handover checks passed.`)
  console.log('  · QA #26: verifying the second contact opens the dashboard on a new session, not /login')
}

main().catch((err) => { console.error(err); process.exit(1) })
