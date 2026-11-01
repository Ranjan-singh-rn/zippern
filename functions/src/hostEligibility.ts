/**
 * Who may become a host — the decision, with no Firestore in it.
 *
 * ── WHY IT IS A SEPARATE FILE ───────────────────────────────────────────────
 *
 * `hosts.ts` calls `admin.firestore()` at module load, so requiring it from a
 * test needs an initialised Firebase app and a credential. That is why the two
 * other rules worth testing in this codebase — `crmRoles.ts` and
 * `guestBinding.ts` — live in files that import nothing: a rule that cannot be
 * required cannot be tested, and this one guards money.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * Until recently a referral code could only be redeemed during first-run profile
 * setup, so every caller was an account seconds old: not banned, not suspended,
 * not attached to an agency. Opening the same redemption to an account that
 * already exists — the point of the Join an Agency screen, since most people an
 * agency invites already have the app — makes those states reachable for the
 * first time.
 *
 * A banned account that became a host would land on an agency roster and in a
 * weekly payout report. Unwinding that is far harder than refusing it.
 */

/** A user document, as a Firestore snapshot or anything that answers `get`. */
export interface FieldReader {
  get(field: string): unknown
}

/**
 * Why this account may not become a host, or '' when there is no reason.
 *
 * Returns the SENTENCE rather than a boolean, because the three states read
 * completely differently to whoever is holding the phone: a suspension ends, a
 * ban does not, and a pending deletion is undone by restoring the account. One
 * flat "not allowed" would send a suspended person to support asking about a
 * ban nobody gave them.
 *
 * Deliberately NOT a copy of the restriction policy. `resolveIdentity` owns what
 * a restricted account is told at sign-in and what happens next; this only
 * refuses to add host status on top of a state that already refuses. The fields
 * it reads are the ones the moderation service writes, so a state that holds a
 * payout also stops the activation that would have produced one.
 *
 * Every test is `=== true`, never truthiness. `isBanned: 'false'` — a string, as
 * a bad client write or a CSV import can produce — is truthy, and a loose check
 * would refuse an innocent account with nothing on screen to explain it.
 *
 * C9 (B25): SUSPENSION IS CHECKED BEFORE BAN. `suspend_user` writes
 * `accountState: 'suspended'` AND `isBanned: true` (the app's one gate) AND
 * `isSuspended: true`, so reading `isBanned` first told every suspended person
 * they were banned. Same order as the backend's `restriction_of`: `accountState`
 * when it names a moderation state, then `isSuspended`, then `isBanned`. A ban
 * that left a stale `isSuspended` behind still says `accountState: 'banned'`,
 * and stays a ban.
 */
export function restrictionOn(snap: FieldReader): string {
  const state = snap.get('accountState')
  if (state === 'suspended' || (state !== 'banned' && snap.get('isSuspended') === true)) {
    return 'This account is suspended. You can become a host once the suspension ends.'
  }
  if (snap.get('isBanned') === true) {
    return 'This account has been banned and cannot become a host.'
  }
  if (snap.get('isDeleted') === true || snap.get('accountState') === 'permanently_deactivated') {
    return 'This account is scheduled for deletion. Restore it first, then try again.'
  }
  return ''
}

/**
 * Is this caller already a host of some OTHER agency?
 *
 * Without this, a host attached to agency A who redeems a code from agency B is
 * moved silently: `agencyId` is overwritten, the agreed rate is replaced, and a
 * roster row appears under B while the one under A stays behind. Both agencies
 * then show the same host, and commission — stamped from the agency recorded at
 * the moment of payment — follows whichever write landed last.
 *
 * The same agency is allowed: that is a re-invitation, and it repairs a missing
 * roster row rather than moving anybody.
 */
export function heldByAnotherAgency(
  snap: FieldReader,
  applicationAgencyId: string,
): boolean {
  const held = String(snap.get('agencyId') ?? '').trim()
  return snap.get('isHost') === true && held !== '' && held !== applicationAgencyId.trim()
}

// ── Phase 1A (SECURITY-002) ─────────────────────────────────────────────────

/**
 * Is this application APPROVED BY THE SERVER?
 *
 * `status === 'approved'` alone was the gate, and `status` was a field the
 * applicant could write on their own application (and any admin from a
 * browser). Only `decide_host_application` in the API stamps `decidedByUid` and
 * `decidedAt` together with the verdict; the rules now refuse those fields from
 * every client. So the stamp, not the status string, is what proves a decision.
 *
 * Returns the refusal sentence, or '' when the application may be redeemed.
 */
export function decisionRefusal(app: Record<string, any>): string {
  if (app.status === 'rejected') return 'That application was not approved.'
  const stamped =
    String(app.decidedByUid ?? '').trim() !== '' && app.decidedAt != null
  if (app.status !== 'approved' || !stamped) {
    return (
      'This invitation has not been approved yet. Your agency has sent it ' +
      'for review — you will be able to use the code once it is approved.'
    )
  }
  if (app.kycStatus !== undefined && app.kycStatus !== 'approved') {
    return 'This invitation has not been approved yet.'
  }
  return ''
}

/**
 * Does the code belong to the agency the application names, and is that
 * agency live? A forged `referralCode` or a re-pointed `agencyId` on the
 * application fails here even if both were somehow written.
 */
export function agencyCodeRefusal(
  agency: Record<string, any> | null | undefined,
  code: string,
): string {
  if (!agency) return 'That referral code does not exist.'
  const own = String(agency.referralCode ?? '').trim().toUpperCase()
  if (own === '' || own !== String(code ?? '').trim().toUpperCase()) {
    return 'That referral code does not belong to this agency.'
  }
  const status = String(agency.status ?? '')
  if (status !== 'approved' || agency.isActive === false) {
    return 'This agency is not currently accepting hosts.'
  }
  return ''
}

/**
 * A guest is not a host applicant (AUTH-002). Decided from the VERIFIED token
 * only: an anonymous sign-in, or a token carrying neither a phone number nor
 * a verified email, is refused.
 */
export function guestRefusal(token: Record<string, any> | undefined): string {
  const provider = String(token?.firebase?.sign_in_provider ?? '')
  const hasPhone = String(token?.phone_number ?? '').trim() !== ''
  // P0-5 (AUTHN-2): an email counts only once Firebase has seen it confirmed.
  const hasEmail = String(token?.email ?? '').trim() !== '' && token?.email_verified === true
  if (provider === 'anonymous' || (!hasPhone && !hasEmail)) {
    return 'Guest accounts cannot become hosts. Add your phone number or email first.'
  }
  return ''
}

// ── C1 (B04): a revoked Host role still counts ──────────────────────────────

/**
 * C1's REVOKED_REFUSAL for the Host kind, word for word: the backend, the CRM
 * and the app show this one sentence for this one state.
 */
export const HOST_REVOKED_REFUSAL =
  'Your Host role was revoked. Request reinstatement instead of applying again.'

/** `HttpsError.details.code` on a refusal because the role was revoked. */
export const ROLE_REVOKED = 'ROLE_REVOKED'

/** `HttpsError.details.code` when the caller is not a Host at all. */
export const NOT_A_HOST = 'NOT_A_HOST'

/** What `revoke_host` stamps (backend/app/services/users.py). */
const HOST_REVOKED_STAMPS = ['hostRevokedAt', 'hostRemovedAt']

/**
 * Everything that makes somebody a Host (again): `restore_host`, `grant_host`
 * (`hostGrantedAt` and `hostAddedAt`) and `activateHost`. `restore_host` never
 * clears the revocation stamps, so a revocation only stops counting once one
 * of these is LATER than it.
 */
const HOST_REINSTATED_STAMPS = ['hostRestoredAt', 'hostGrantedAt', 'hostAddedAt', 'hostActivatedAt']

/** A stored stamp in epoch milliseconds; 0 when it is set but cannot be read. */
function stampMillis(value: unknown): number {
  const ts = value as { toMillis?: () => number }
  if (typeof ts?.toMillis === 'function') return Number(ts.toMillis()) || 0
  if (value instanceof Date) return value.getTime() || 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** The latest of [fields] that is set, in ms, or null when none of them is. */
function latestStamp(snap: FieldReader, fields: readonly string[]): number | null {
  let latest: number | null = null
  for (const field of fields) {
    const value = snap.get(field)
    if (value == null || value === '' || value === false) continue
    const ms = stampMillis(value)
    latest = latest === null ? ms : Math.max(latest, ms)
  }
  return latest
}

/**
 * Was this account's Host role revoked, with no later restore?
 *
 * `HELD_STATUSES` used to leave revoked out, so a revoked Host read exactly
 * like somebody who had never applied: `activateHost` would make them a Host
 * again from any invitation, past the decision that removed them. C1 makes the
 * revocation stand until it is reversed — by an Owner, through a reinstatement
 * request — never by redeeming a code.
 *
 * Read from the stamps alone, so it holds whatever `isHost` says. A stamp that
 * is set but unreadable dates to 0: an unreadable revocation is lifted by any
 * readable restore, and an unreadable restore lifts nothing.
 */
export function hostRoleRevoked(snap: FieldReader): boolean {
  const revoked = latestStamp(snap, HOST_REVOKED_STAMPS)
  if (revoked === null) return false
  const reinstated = latestStamp(snap, HOST_REINSTATED_STAMPS)
  return reinstated === null || reinstated <= revoked
}

/**
 * B09: is this caller ALREADY a Host of the agency this invitation names?
 *
 * The other half of `heldByAnotherAgency`. A second invitation from the same
 * agency is a duplicate, not an activation — redeeming it must not reset the
 * verification, the badge or the agreed rate of a Host who already has them.
 */
export function hostOfSameAgency(snap: FieldReader, applicationAgencyId: string): boolean {
  const held = String(snap.get('agencyId') ?? '').trim()
  return snap.get('isHost') === true && held !== '' && held === applicationAgencyId.trim()
}

// ── §5 Partner role suspension, for the Host role ────────────────────────────
//
// "Temporary restriction of only the selected capability … keep the role slot /
// record while suspended … resume the same record." `users.suspend_host` in the
// backend writes `hostSuspended: true` (+ `hostSuspendedUntil` when the term
// has an end, `hostSuspendedReason`) and leaves `isHost`, the verification, the
// agency link, the roster row and the earnings exactly as they were; `resume_host`
// (by a person, or the backend's daily sweep once the term is over) writes it
// back to false. So every Host-only path asks the flag — strictly `=== true`,
// and ONLY the flag: an end date that has passed is lifted by the sweep, not
// guessed here, so the server, the CRM and the app never disagree about it.

/**
 * `HttpsError.details.code` when the caller's own Host role is suspended.
 *
 * Deliberately NOT `ACCOUNT_RESTRICTED`: the account is untouched — the person
 * still uses the app, their other roles and their wallet — and the app signs a
 * device out on that code.
 */
export const HOST_ROLE_SUSPENDED = 'HOST_ROLE_SUSPENDED'

/**
 * `HttpsError.details.code` a THIRD party gets when the host they are calling
 * is suspended. The reason and the term are the host's business, not theirs.
 */
export const HOST_UNAVAILABLE = 'HOST_UNAVAILABLE'

/** What that third party is told — no reason, no date. */
export const HOST_UNAVAILABLE_REFUSAL = 'This host is not taking calls right now.'

/** A standing Host-role suspension, as the gates and the refusals need it. */
export interface HostSuspension {
  /** The end of the term as ISO-8601 (UTC), or null — until resumed, or unreadable. */
  until: string | null
  untilMs: number | null
  reason: string
}

/**
 * The Host role's own suspension, or null when there is none. Pure.
 *
 * Null unless `hostSuspended` is exactly `true` (a string `'true'` from a bad
 * write is not a suspension, as everywhere in this file). `hostSuspendedUntil`
 * absent means "until resumed"; one that cannot be read is reported as no end
 * date rather than guessed — the refusal still stands, because the flag does.
 */
export function hostRoleSuspension(snap: FieldReader): HostSuspension | null {
  if (snap.get('hostSuspended') !== true) return null
  const raw = snap.get('hostSuspendedUntil')
  const ms = raw == null || raw === '' || raw === false ? 0 : stampMillis(raw)
  const untilMs = ms > 0 ? ms : null
  return {
    until: untilMs === null ? null : new Date(untilMs).toISOString(),
    untilMs,
    reason: String(snap.get('hostSuspendedReason') ?? '').trim(),
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `04 Nov 2026, 10:15 UTC` — the backend's `email.when`, so the date the host
 * reads on the phone is the one in their email and in-app notice.
 */
export function whenUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/**
 * The sentence the suspended host is shown, word for word the one the backend
 * and the app use: `Your Host role is suspended until <when> — reason: <reason>`,
 * `<when>` being "it is resumed" for a suspension with no end date; with no
 * reason on record the `— reason:` part is left off rather than left empty.
 */
export function hostSuspendedMessage(s: HostSuspension): string {
  const when = s.untilMs === null ? 'it is resumed' : whenUtc(s.untilMs)
  return `Your Host role is suspended until ${when}` + (s.reason ? ` — reason: ${s.reason}` : '')
}

/** `HttpsError.details` for the suspended host's own refusal. */
export function hostSuspensionDetails(s: HostSuspension): { code: string; until: string | null; reason: string } {
  return { code: HOST_ROLE_SUSPENDED, until: s.until, reason: s.reason }
}

/** Why the caller may not act as a Host right now, for `HttpsError.details`. */
export interface HostRefusal {
  code: string
  message: string
  /** `HOST_ROLE_SUSPENDED` only: the end of the term (ISO, UTC) or null. */
  until?: string | null
  /** `HOST_ROLE_SUSPENDED` only: the reason staff gave. */
  reason?: string
}

/**
 * `HttpsError.details` for a refusal: its code, and — for a suspended Host
 * role — the term and the reason, so the app can show the same sentence the
 * server wrote without parsing it.
 */
export function refusalDetails(r: HostRefusal): Record<string, unknown> {
  return r.code === HOST_ROLE_SUSPENDED
    ? { code: r.code, until: r.until ?? null, reason: r.reason ?? '' }
    : { code: r.code }
}

/**
 * B41: may this account act AS a Host right now — submit a face capture, take
 * the publisher token for its own live room? `null` when it may.
 *
 * Current (`isHost` exactly true), not revoked (`hostRoleRevoked`), not
 * restricted (`restrictionOn`), and — §5 — the Host role not suspended
 * (`hostRoleSuspension`). Those callables also pass the session gate,
 * which refuses a restricted account first; the restriction is asked again
 * here so this decision is complete on its own. `ACCOUNT_RESTRICTED` is the
 * session gate's code (`mobileSession.ts`), spelt out because this file
 * imports nothing.
 *
 * Order: restricted → revoked → not a host → suspended. A suspension is a
 * state OF a held Host role, so somebody who holds no Host role is told that,
 * not about a suspension left on a document.
 */
export function activeHostRefusal(snap: FieldReader): HostRefusal | null {
  if (restrictionOn(snap)) {
    return { code: 'ACCOUNT_RESTRICTED', message: 'This account is restricted and cannot do that right now.' }
  }
  if (hostRoleRevoked(snap)) return { code: ROLE_REVOKED, message: HOST_REVOKED_REFUSAL }
  if (snap.get('isHost') !== true) return { code: NOT_A_HOST, message: 'This is for hosts only.' }
  const suspension = hostRoleSuspension(snap)
  if (suspension) {
    return {
      code: HOST_ROLE_SUSPENDED,
      message: hostSuspendedMessage(suspension),
      until: suspension.until,
      reason: suspension.reason,
    }
  }
  return null
}
