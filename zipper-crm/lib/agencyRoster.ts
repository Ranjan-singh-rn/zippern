/**
 * One agency's roster, reconciled from its two sources — pure.
 *
 * Split out of `lib/agencies.ts` (FX-10) so the merge can be specified and run
 * standalone: no Firebase, no React, only `./hostRows`. `getAgencyRoster`
 * still does the two reads and hands their documents here.
 *
 * See the long note above `getAgencyRoster` for WHY the roster is read from
 * `users where agencyId == id` plus `hostApplications where agencyId == id`,
 * and what each state means.
 *
 * ── FX-10 (RF-15): a transferred Host was counted under both agencies ───────
 *
 * An activated invitation keeps saying agency A after its Host is moved to B
 * (`_move_host`). The Host's user document now says B, so B's users read
 * lists them as active — and A's application read listed the same activation
 * as active too, because an activation with no matching person row here was
 * counted as an active host of this agency. One person, two rosters.
 *
 * An activated application now counts as active here only when it can still
 * be this agency's:
 *
 *   * stamped `transferredTo` (by `_move_host`, from FX-10 on) → former;
 *   * redeemed by an account that is NOT on this agency's users list, with
 *     that list read completely (not refused, not capped) → former: that
 *     account's `agencyId` points somewhere else, so it is somebody else's
 *     host now;
 *   * otherwise (no redeemer named, or the users list unknown/partial) →
 *     active, as before: nothing says it is not.
 *
 * A "former" row is still LISTED — the activation is history and the agency's
 * ledger has its earnings — and is in none of the counts.
 */

import {
  applicationPersonUid, contactMatch, linkedPersonUid, type PersonStatus,
} from './hostRows'

/**
 * Where one person on the roster stands. See `RosterState` in lib/agencies.ts
 * (re-exported from here) for the long form.
 */
export type RosterState = 'active' | 'awaiting' | 'pending' | 'former'

export interface RosterMember {
  /** App account uid. Empty on an invitation nobody has redeemed. */
  uid: string
  name: string
  phone: string
  state: RosterState
  /** The invitation this person came from, where there is one. */
  applicationId: string
  /** The referral code, on a row that is waiting for it to be entered. */
  referralCode: string
  /** Agreed beans per minute. `null` when no rate is on record either side. */
  callRateBeans: number | null
  /** Lifetime beans on the user document. `null` when there is no account. */
  beans: number | null
  isVerifiedHost: boolean
  isBanned: boolean
  /**
   * GOV B08: an invitation nobody has redeemed whose phone or email is that
   * of a host already on this roster — the uid of that host, else ''. Such a
   * row is SHOWN, flagged, and not counted: the verified contact belongs to
   * one account, so it can only be that host's invitation.
   */
  sameContactAs: string
  /** That host's name, for the flag. '' when there is none. */
  sameContactName: string
  /**
   * FX-10: the agency this activation's Host is under now, when it is not
   * this one ('' otherwise). Set on a `former` row that is an activation
   * which moved away.
   */
  movedTo: string
}

/** One Firestore document, as plain data. */
export interface RosterDoc {
  id: string
  data: Record<string, unknown>
}

/** One of the two reads: its documents, and whether it hit its cap. Null when refused. */
export interface RosterRead {
  docs: RosterDoc[]
  capped: boolean
}

export interface MergedRoster {
  members: RosterMember[]
  total: number
  active: number
  awaiting: number
  pending: number
  former: number
  flagged: number
}

export function textField(raw: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = raw[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

export function intField(raw: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = raw[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

const STATE_RANK: Record<RosterState, number> = {
  active: 0, awaiting: 1, pending: 2, former: 3,
}

/**
 * Reconcile the two reads into one row per PERSON.
 *
 * `users` / `apps` are null when that read was refused; the caller reports
 * the refusal, and the half that did arrive is still a true (partial) roster.
 */
export function mergeAgencyRoster(users: RosterRead | null, apps: RosterRead | null): MergedRoster {
  /** Keyed on uid for the activated half, and on application id for the rest. */
  const byKey = new Map<string, RosterMember>()

  if (users) {
    users.docs.forEach((d) => {
      const raw = d.data
      byKey.set(d.id, {
        uid: d.id,
        // `phoneNumber` is what a user document spells it. There is no `phone`
        // field on a user — see the note on `Host` in app/agency-dashboard.
        name: textField(raw, 'name', 'displayName') || d.id,
        phone: textField(raw, 'phoneNumber'),
        // Explicit `false` only. See `RosterState` — a missing `isHost` must
        // never be read as "not a host".
        state: raw.isHost === false ? 'former' : 'active',
        applicationId: '',
        referralCode: '',
        callRateBeans: intField(raw, 'callRateBeans'),
        beans: intField(raw, 'beans') ?? 0,
        isVerifiedHost: raw.isVerifiedHost === true,
        isBanned: raw.isBanned === true,
        sameContactAs: '',
        sameContactName: '',
        movedTo: '',
      })
    })
  }

  // FX-10: the users list is only evidence of ABSENCE when it is complete.
  const usersComplete = users !== null && !users.capped

  if (apps) {
    // GOV B08: who already has a row, and whether they hold the role now — the
    // input to `linkedPersonUid` (lib/hostRows.ts). Only the users half has
    // rows at this point, so an application never links to another one.
    const statusOf = (uid: string): PersonStatus | undefined => {
      const member = byKey.get(uid)
      if (!member) return undefined
      return member.state === 'former' ? 'former' : 'current'
    }
    // This agency's current hosts with their own verified contact, for the
    // invitation nobody has redeemed.
    const currentHosts = users
      ? users.docs
          .filter((d) => d.data.isHost !== false)
          .map((d) => ({
            uid: d.id,
            phoneNumber: d.data.phoneNumber,
            email: d.data.email,
            name: textField(d.data, 'name', 'displayName') || d.id,
          }))
      : []

    apps.docs.forEach((d) => {
      const raw = d.data
      const status = textField(raw, 'status').toLowerCase()
      // A refused invitation is not on the roster. The agency's own screen shows
      // it with the reason so they do not resubmit the same application, but it
      // is nobody's host and counting it would overstate every agency that has
      // ever had one turned down.
      if (status === 'rejected') return

      const uid = textField(raw, 'activatedByUid')
      const rate = intField(raw, 'callRate')
      // The redeemer, whatever they are now — the join this function always
      // made — or, new with GOV B08, the SELF-applicant while they are a current
      // host here. A self-application never carries `activatedByUid`, so the
      // old join listed an approved one as a second, "awaiting" person.
      const linked = linkedPersonUid(raw, statusOf)
      const existing = linked ? byKey.get(linked) : undefined
      if (existing) {
        // The same person, seen from the other side. Fill in what the invitation
        // knows and the user document does not, and add no second row: a host
        // counted twice is the mirror image of the bug being fixed here.
        existing.applicationId = d.id
        if (!existing.phone) existing.phone = textField(raw, 'applicantPhone', 'phone')
        if (existing.callRateBeans === null) existing.callRateBeans = rate
        return
      }

      // Not anybody's row. If it is an invitation nobody has redeemed and it
      // carries a current host's own phone or email, it is that host's: shown,
      // flagged, and left out of the counts below.
      const twin = applicationPersonUid(raw) ? null : contactMatch(raw, currentHosts)

      // FX-10: an activation that is not this agency's any more.
      const transferredTo = textField(raw, 'transferredTo')
      const redeemedElsewhere = uid !== '' && usersComplete && !byKey.has(uid)
      const movedAway = transferredTo !== '' || redeemedElsewhere

      byKey.set(`app:${d.id}`, {
        uid,
        name: textField(raw, 'hostName', 'name', 'displayName') || 'Unnamed host',
        phone: textField(raw, 'applicantPhone', 'phone'),
        // `isActivated` with no user document of ours used to be counted as
        // active here — and the same person was active on the agency their
        // user document now names. It is listed as `former` instead when it
        // has moved away (above); with nothing to say so, it stays active.
        state: movedAway
          ? 'former'
          : raw.isActivated === true || uid
            ? 'active'
            : status === 'approved'
              ? 'awaiting'
              : 'pending',
        applicationId: d.id,
        referralCode: textField(raw, 'referralCode'),
        callRateBeans: rate,
        beans: null,
        isVerifiedHost: false,
        isBanned: false,
        sameContactAs: twin?.uid ?? '',
        sameContactName: twin?.name ?? '',
        movedTo: transferredTo,
      })
    })
  }

  // Activated first — they are the part of the roster somebody is being paid
  // for — then alphabetically, which is how the agency's own screen reads.
  // Former hosts last: they are history, not work.
  const members = Array.from(byKey.values()).sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name),
  )

  // People, not rows: a row flagged as an existing host's contact is that host,
  // who is already counted.
  const count = (s: RosterState) =>
    members.filter((m) => m.state === s && !m.sameContactAs).length
  const active = count('active')
  const awaiting = count('awaiting')
  const pending = count('pending')

  return {
    members,
    total: active + awaiting + pending,
    active,
    awaiting,
    pending,
    former: count('former'),
    flagged: members.filter((m) => !!m.sameContactAs).length,
  }
}
