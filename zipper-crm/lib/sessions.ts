/**
 * B3 / §13 — the sessions a login holds, and "Sign out everywhere else".
 *
 *   GET  /auth/sessions              → { sessions: [...], count }
 *   POST /auth/sessions/revoke-all   { include_current } → { message, revoked,
 *                                                           current_kept, problems }
 *
 * Both are SELF-scoped on the server (`own_session_uid`): no id is sent, so
 * nobody can list or end anybody else's sessions, and both are on the
 * partner-reachable list — an agency and a coin seller use them exactly as
 * staff do. That is why `/sessions` is a shared partner path
 * (`lib/partnerRouting.PARTNER_SHARED_PATHS`) and not a staff screen.
 *
 * Fingerprints only: a session's `id` is the first eight characters of its
 * id — never the token. This module shapes the list for reading; it decides
 * nothing about who may do what (the server already did, by scoping).
 *
 * Pure — no imports — so `npm run test:sessions` runs the shipped module.
 */

export interface SessionView {
  id: string
  current: boolean
  /** "CRM (web)", "Zipper app (Android)", or the raw value. */
  clientLabel: string
  /** "Chrome on macOS" and so on, from the user agent; "Unknown device" when there is none. */
  device: string
  userAgent: string
  /** '' when not recorded. */
  ip: string
  issuedAtMs: number | null
  lastActiveAtMs: number | null
  expiresAtMs: number | null
  /** Owner / Observer second step. `n/a` when the session does not record it. */
  mfa: 'verified' | 'not_verified' | 'n/a'
  renewed: boolean
}

/** Said beside the button — a sign-out does not touch quick login on the phone (§13). */
export const QUICK_LOGIN_NOTE =
  'Quick login on a phone is not removed by this — a sign-out keeps it, by design. ' +
  'A restriction or a security reset removes it.'

const CLIENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  crm: 'CRM (web)',
  android: 'Zipper app (Android)',
  unknown: 'Unknown client',
})

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function millis(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

export function clientLabel(client: unknown): string {
  const c = text(client).toLowerCase()
  if (!c) return CLIENT_LABEL.unknown
  return CLIENT_LABEL[c] ?? c
}

/**
 * A readable name for a user agent. Heuristic and deliberately modest: it
 * names the browser and the system when the string says so plainly, and
 * otherwise admits it does not know. The raw string is kept beside it.
 */
export function describeUserAgent(ua: unknown): string {
  const s = text(ua)
  if (!s) return 'Unknown device'
  let browser = ''
  if (/okhttp/i.test(s)) browser = 'Android app'
  else if (/Edg\//.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera'
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet'
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome'
  else if (/Safari\//.test(s)) browser = 'Safari'
  let system = ''
  if (/Windows/.test(s)) system = 'Windows'
  else if (/iPhone|iPad|iPod/.test(s)) system = 'iOS'
  else if (/Android/.test(s)) system = 'Android'
  else if (/Mac OS X|Macintosh/.test(s)) system = 'macOS'
  else if (/CrOS/.test(s)) system = 'ChromeOS'
  else if (/Linux/.test(s)) system = 'Linux'
  if (browser && system) return `${browser} on ${system}`
  return browser || system || 'Unknown device'
}

/**
 * The sessions in a response, current first and then newest first — the
 * server sorts the same way; this keeps the order if a proxy did not.
 * Tolerant of shape (`{sessions}` or a bare array); a row without an id is
 * dropped, because nothing could be said about it.
 */
export function sessionsFrom(body: unknown): SessionView[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { sessions?: unknown }).sessions)
      ? (body as { sessions: unknown[] }).sessions
      : []
  const out: SessionView[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    const id = text(s.id)
    if (!id) continue
    const ua = text(s.user_agent)
    out.push({
      id,
      current: s.current === true,
      clientLabel: clientLabel(s.client),
      device: describeUserAgent(ua),
      userAgent: ua,
      ip: text(s.ip),
      issuedAtMs: millis(s.issued_at),
      lastActiveAtMs: millis(s.last_active_at),
      expiresAtMs: millis(s.expires_at),
      mfa: s.mfa_verified === true ? 'verified' : s.mfa_verified === false ? 'not_verified' : 'n/a',
      renewed: s.renewed === true,
    })
  }
  return out.sort((a, b) =>
    Number(b.current) - Number(a.current) || (b.issuedAtMs ?? 0) - (a.issuedAtMs ?? 0))
}

/** Every session except the one in this browser — what "everywhere else" ends. */
export function otherSessions(rows: readonly SessionView[]): SessionView[] {
  return rows.filter((r) => !r.current)
}

export interface RevokeAllView {
  /** The server's sentence first, then the count. */
  text: string
  problems: string[]
  /** True when this browser's own session was ended too — sign out locally now. */
  signedOutHere: boolean
}

export function revokeAllSummary(result: unknown): RevokeAllView {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const message = text(r.message) || 'Signed out.'
  const n = typeof r.revoked === 'number' && Number.isFinite(r.revoked) ? r.revoked : null
  const count = n === null
    ? 'The server did not say how many sessions were ended.'
    : n === 0
      ? 'There were no other sessions to end.'
      : `${n} session${n === 1 ? '' : 's'} ended.`
  return {
    text: `${message} ${count}`,
    problems: Array.isArray(r.problems) ? r.problems.map((p) => text(p)).filter(Boolean) : [],
    signedOutHere: r.current_kept === false,
  }
}
