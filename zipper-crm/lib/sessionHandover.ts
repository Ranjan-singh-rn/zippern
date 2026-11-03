/**
 * QA #26 (3 Nov 2026) — a step that ends this session ON PURPOSE hands over
 * to a new one instead of throwing the person out.
 *
 * When an approved partner verifies their second contact, the API starts the
 * role and revokes the login's live sessions in the same request
 * (`partner_ops._revoke_partner_sessions`): the partner ids a session carries
 * are stamped at sign-in, so only a NEW session holds the role that just
 * started. The server's comment says "the CRM signs them back in". The CRM did
 * not: the next call was refused, renewal was refused (the session is revoked,
 * as intended), and `requireSignIn` sent the person to /login with "Session
 * has been revoked" — while the panel promised to open their dashboard.
 *
 * The handover, in order:
 *
 *   1. HOLD the 401 handler for the whole window, so a request refused because
 *      the server just ended the session is not answered with a renewal (which
 *      the server rightly refuses) and a Firebase sign-out.
 *   2. Run the step (`work`).
 *   3. Only if the step says it changed what the session must carry
 *      (`changed`), sign in again through the ordinary door — `/auth/signin`
 *      with a fresh Firebase ID token, which re-checks everything a sign-in
 *      checks — and adopt that session.
 *   4. RELEASE, always.
 *
 * What this does NOT do: renew a revoked session, or fall back to a sign-in
 * whenever renewal is refused. `api.auth.refresh` still refuses a revoked
 * session and `AuthProvider` still asks for a password when it does; the only
 * sign-in here follows the person's own step, in this tab, on the server's
 * word that the step changed their role.
 *
 * BOUNDED (security review of the QA fixes, 3 Nov 2026). The hold switches the
 * 401 handler and renewal off, so it must not outlive the step: it is released
 * after HANDOVER_HOLD_MS whatever the step is doing (a request that never
 * settles), and released once only. The provider counts holds, so a second
 * handover started while one runs is not ended by the first one's release.
 *
 * No imports: `sessionHandover.spec.ts` runs it with fakes.
 */

/** The longest the 401 handler stays held. The step is one API call. */
export const HANDOVER_HOLD_MS = 60_000

/** Starts a timer; returns its cancel. Injectable so the spec needs no clock. */
export type HandoverTimer = (fire: () => void, ms: number) => () => void

const realTimer: HandoverTimer = (fire, ms) => {
  const t = setTimeout(fire, ms)
  return () => clearTimeout(t)
}

export interface HandoverHooks<U> {
  /** Hold the 401 handler; returns the release. */
  hold: () => () => void
  /** Sign in again through the ordinary door. */
  signIn: () => Promise<U>
  /** Make the new session the one in use. */
  adopt: (user: U) => void
}

/** The step succeeded and changed the role, but the new session could not be made. */
export class SessionHandoverError<T> extends Error {
  readonly result: T
  constructor(result: T, cause: unknown) {
    const why = (cause as { message?: unknown })?.message
    super(
      'Your role has started, but this page could not open it for you. Sign in again to open your dashboard.'
        + (typeof why === 'string' && why.trim() ? ` (${why.trim()})` : ''),
    )
    this.name = 'SessionHandoverError'
    this.result = result
  }
}

/**
 * E2E re-run (3 Nov 2026): the new session opened the dashboard, and the
 * dashboard's uploads were refused by Storage. Storage authorises a partner by
 * a custom claim (`role` agency/seller, and the agency id) that the
 * `syncStorageRoleClaim` trigger writes moments AFTER the role starts — and
 * the forced token refresh in the sign-in had run before it. Before signing
 * in again, the handover waits (briefly) for the claim to reach the token.
 * `read` is `getIdTokenResult(true)` on the Firebase user; never more than
 * `tries` reads; a claim that never comes is not an error (the sign-in goes
 * ahead, and the upload's own message says to sign in again).
 *
 * @return whether the claim arrived.
 */
export async function waitForPartnerClaim(
  read: () => Promise<Record<string, unknown> | null | undefined>,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const tries = Math.max(1, opts.tries ?? 8)
  const delayMs = Math.max(0, opts.delayMs ?? 1000)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let i = 0; i < tries; i++) {
    let claims: Record<string, unknown> | null | undefined = null
    try {
      claims = await read()
    } catch {
      claims = null
    }
    const role = String(claims?.role ?? '')
    if (role === 'agency' || role === 'seller') return true
    if (i < tries - 1) await sleep(delayMs)
  }
  return false
}

export async function handOverSession<T, U>(
  work: () => Promise<T>,
  changed: (result: T) => boolean,
  hooks: HandoverHooks<U>,
  opts: { holdMs?: number; timer?: HandoverTimer } = {},
): Promise<{ result: T; handedOver: boolean }> {
  const releaseHold = hooks.hold()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseHold()
  }
  const cancelTimer = (opts.timer ?? realTimer)(release, opts.holdMs ?? HANDOVER_HOLD_MS)
  try {
    const result = await work()
    if (!changed(result)) return { result, handedOver: false }
    let user: U
    try {
      user = await hooks.signIn()
    } catch (err) {
      throw new SessionHandoverError(result, err)
    }
    hooks.adopt(user)
    return { result, handedOver: true }
  } finally {
    cancelTimer()
    release()
  }
}
