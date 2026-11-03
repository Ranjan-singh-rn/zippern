/**
 * /team-access — who may do what on the screen, decided in one pure place.
 *
 * QA #45 (3 Nov 2026): the Observer could not reset an Owner's authenticator
 * from any screen. The reset lived on /team, which is closed to the Observer,
 * although Owners are told "The Observer can reset your two-step sign-in" and
 * the API (`POST /auth/mfa/owners/{uid}/reset`, Observer only) worked. The
 * control now lives here, on the one staff page the Observer can open.
 *
 * QA #40: the headline promised "You can invite members of your own team" to a
 * Support member and to the Observer, with no Invite button to match; and the
 * revoke control was offered on rows the viewer cannot act on.
 *
 * The API stays the authority for every action — these only decide what is
 * OFFERED, so nobody is shown a control the server will refuse.
 *
 * Pure: no imports, no React, no Firebase — `teamAccess.spec.ts` runs it.
 */

/** The reset's reason, as `owner_mfa.reset_by_observer` requires it (≥ 10 characters). */
export const OWNER_MFA_RESET_MIN_REASON = 10

export interface MemberLike {
  uid: string
  role: string
  is_active: boolean
  email?: string
  name?: string
}

/** The line under the page title, true to what this viewer can do. */
export function teamAccessHeadline(myRole: string, assignableCount: number): string {
  if (myRole === 'owner') return 'You can invite anyone, including another owner.'
  if (myRole === 'observer') {
    return 'Read-only. As the Observer you can reset an Owner\'s two-step sign-in when they have lost ' +
      'their authenticator and their recovery codes.'
  }
  if (assignableCount > 0) return 'You can invite members of your own team.'
  return 'You can see who has staff access. Inviting and removing people is for Owners and team admins.'
}

/**
 * Is the Invite button offered? QA #40, found again in the E2E re-run (3 Nov
 * 2026): the API lists one assignable role for the Observer — Owner, for its
 * separate provisioning route (`POST /staff/owners`) — but this page's
 * invitation goes through `POST /staff`, which refuses the read-only Observer.
 * So the button is offered only to somebody whose invitation can succeed here.
 */
export function canOfferInvite(myRole: string, assignableCount: number): boolean {
  return myRole !== 'observer' && assignableCount > 0
}

/** QA #45: the Observer resets an ACTIVE Owner's authenticator. Nobody else is offered it. */
export function canResetOwnerMfa(myRole: string, member: MemberLike): boolean {
  return myRole === 'observer' && member.role === 'owner' && member.is_active === true
}

/**
 * Is the revoke control offered on this row? Only to somebody who manages the
 * row's role: an Owner (any non-Owner, non-Observer member), or an admin whose
 * assignable roles include it. Never to the Observer.
 */
export function canOfferRevoke(myRole: string, member: MemberLike, assignable: readonly string[]): boolean {
  if (!member.is_active) return false
  if (member.role === 'owner' || member.role === 'observer') return false
  if (myRole === 'observer') return false
  if (myRole === 'owner') return true
  return assignable.includes(member.role)
}

/**
 * The confirmation for the reset: a reason long enough for the audit log, and
 * the Owner's email typed back, so a reset is never one stray click on the
 * wrong row.
 */
export function ownerMfaResetReady(member: MemberLike, reason: string, typedEmail: string): boolean {
  const email = String(member.email ?? '').trim().toLowerCase()
  return reason.trim().length >= OWNER_MFA_RESET_MIN_REASON
    && email !== ''
    && typedEmail.trim().toLowerCase() === email
}

/** What the Observer is told the reset does, before confirming. */
export const OWNER_MFA_RESET_EFFECTS = [
  'Their authenticator and every recovery code are removed, so the lost phone and any written-down codes stop working.',
  'Every session they have ends — CRM, API and the app — and they sign in again with their password.',
  'At their next sign-in they set up a new authenticator and receive new recovery codes.',
  'They are told by email and in the app. The reset and your reason are kept in the audit log.',
  'You never see their password, their authenticator key or any recovery code.',
] as const
