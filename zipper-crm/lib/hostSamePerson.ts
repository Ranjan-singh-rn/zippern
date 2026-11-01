/**
 * FX-12 (RF-05 / DUP-06) — the "same person" badge on /kyc → Hosts.
 *
 * A self-application and an agency invitation for one human used to sit in
 * the queue as two unrelated applications: neither side checked the other,
 * and /kyc had no person matching at all. A reviewer approving one, then
 * refusing the other, is how a Host lost their role (RF-04).
 *
 * Two applications are the same person when they name the same ACCOUNT
 * (`applicantUid` / `activatedByUid`), or carry the same phone or the same
 * email — the matching the roster already uses (`samePhone` / `sameEmail`).
 * Only a PENDING application is badged (it is the one awaiting a decision);
 * the others it is matched against may be in any state but refused.
 *
 * Information for the reviewer, not a decision: nothing is hidden, merged or
 * refused because of it.
 *
 * Pure: imports only `./hostRows`. `hostSamePerson.spec.ts` runs it.
 */

import { sameEmail, samePhone } from './hostRows'

export interface PersonApplication {
  id: string
  /** `activatedByUid || applicantUid`, '' when nobody's account is named yet. */
  uid: string
  phone: unknown
  email: unknown
  /** pending | approved | rejected | suspended, as the queue reads it. */
  status: string
  isActivated: boolean
  name?: string
}

function samePerson(a: PersonApplication, b: PersonApplication): boolean {
  if (a.uid && b.uid && a.uid === b.uid) return true
  return samePhone(a.phone, b.phone) || sameEmail(a.email, b.email)
}

/**
 * For each PENDING application, the other non-refused applications of the same
 * person. Applications with no match are absent from the map.
 */
export function samePersonMatches(apps: readonly PersonApplication[]): Map<string, PersonApplication[]> {
  const live = apps.filter((a) => a.status !== 'rejected')
  const out = new Map<string, PersonApplication[]>()
  for (const a of live) {
    if (a.status !== 'pending') continue
    const others = live.filter((b) => b.id !== a.id && samePerson(a, b))
    if (others.length) out.set(a.id, others)
  }
  return out
}

/** The badge text for one pending application, or '' when it has no match. */
export function samePersonNote(others: readonly PersonApplication[] | undefined): string {
  if (!others || others.length === 0) return ''
  const hostAlready = others.some((o) => o.isActivated || (o.status === 'approved' && o.uid !== ''))
  const list = others.map((o) => (o.name ? `${o.name} (${o.id})` : o.id)).join(', ')
  return (
    `Same person as ${others.length === 1 ? 'another application' : `${others.length} other applications`}: ` +
    `${list}.` +
    (hostAlready
      ? ' One of them already made this person a Host — this one is a duplicate.'
      : ' Decide them together.')
  )
}
