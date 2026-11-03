/**
 * FX-12 (RF-18 / DUP-07) — one OPEN invitation per (agency, person).
 *
 * The agency dashboard's Invite Host used `addDoc`: an automatic id, no
 * lookup. Re-inviting after a typo, a second staff member, or a resubmitted
 * modal each wrote another `hostApplications` document for the same person —
 * the same code, phone and email — and every one of them was a live invitation.
 *
 * Two things now stop that:
 *
 *   1. a DUPLICATE CHECK before anything is written: an open invitation of
 *      this agency with the same phone OR the same email is the same person
 *      (`findOpenInvitation`, using the same matching as the roster);
 *   2. a DETERMINISTIC document id — a hash of the agency, the normalised
 *      email and the normalised phone — written with CREATE semantics
 *      (`runInvitationCreate`). Two submits at the same moment both aim at the
 *      same id; the rules allow the first as a create and refuse the second,
 *      which arrives as an update with fields an agency may not change. A
 *      REFUSED invitation keeps its id (it is history), so the next one for the
 *      same person takes the next slot (`…_2`, `…_3`): an agency may still
 *      invite somebody again after a refusal, as before.
 *
 * Pure: no Firebase, no React. The SHA-256 and the reads/writes are passed in
 * (`app/agency-dashboard/page.tsx` uses Web Crypto and Firestore;
 * `hostInvitation.spec.ts` uses Node's crypto and an in-memory store).
 */

import { phoneDigits, sameEmail, samePhone } from './hostRows'

export const INVITATION_ID_PREFIX = 'inv_'
/**
 * Deterministic slots tried before falling back to an automatic id. Not a
 * limit on re-inviting anybody — only on how far the deterministic sequence
 * goes; the duplicate check above it still runs either way.
 */
export const MAX_INVITATION_SLOTS = 50

/** The person part of the key: the email as typed, case and space aside. */
export function normaliseInviteEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/** The phone as digits only, so "+91 98…" and "+9198…" are one key. */
export function normaliseInvitePhone(phone: unknown): string {
  return phoneDigits(phone)
}

/** What the id is derived from. */
export function invitationKey(agencyId: string, email: unknown, phone: unknown): string {
  return `${agencyId.trim()}|${normaliseInviteEmail(email)}|${normaliseInvitePhone(phone)}`
}

/** The document id for slot `n` (1-based), from the key's SHA-256 hex digest. */
export function invitationId(hashHex: string, slot: number): string {
  const base = `${INVITATION_ID_PREFIX}${hashHex.toLowerCase().slice(0, 40)}`
  return slot <= 1 ? base : `${base}_${slot}`
}

/** An invitation as the dashboard holds it. */
export interface InvitationLike {
  id: string
  status?: unknown
  isActivated?: unknown
  applicantPhone?: unknown
  applicantEmail?: unknown
  hostName?: unknown
}

/** Refused is history; everything else (pending, approved, redeemed) occupies the person. */
export function invitationOccupies(inv: { status?: unknown }): boolean {
  return String(inv.status ?? 'pending').toLowerCase() !== 'rejected'
}

/**
 * An OPEN invitation of this agency for the same person: same phone or same
 * email, not refused, not yet redeemed. Null when there is none.
 */
export function findOpenInvitation<T extends InvitationLike>(
  existing: readonly T[],
  email: unknown,
  phone: unknown,
): T | null {
  for (const inv of existing) {
    if (!invitationOccupies(inv) || inv.isActivated === true) continue
    if (samePhone(inv.applicantPhone, phone) || sameEmail(inv.applicantEmail, email)) return inv
  }
  return null
}

/** What the agency is told when the person already has an open invitation. */
export function duplicateInvitationMessage(inv: InvitationLike): string {
  const who = typeof inv.hostName === 'string' && inv.hostName.trim() ? inv.hostName.trim() : 'this person'
  const pending = String(inv.status ?? 'pending').toLowerCase() === 'pending'
  return (
    `You already have an open invitation for ${who} (same phone or email). ` +
    (pending
      ? 'Withdraw it first if its details are wrong, then invite again. Nothing was created.'
      : 'It is approved and waiting for the code to be entered. Nothing was created.')
  )
}

/** One slot's state, as `createIfAbsent` found it. */
export type SlotOutcome =
  | { created: true }
  | { created: false; existing: Record<string, unknown> }

export interface InvitationCreateSteps {
  /** SHA-256 of `key`, as lowercase hex. */
  sha256Hex: (key: string) => Promise<string>
  /** Create the document at `id` if — and only if — none exists there. */
  createIfAbsent: (id: string) => Promise<SlotOutcome>
  /** The old way, for a person with more refused invitations than there are slots. */
  createAuto: () => Promise<string>
}

export type InvitationCreateResult =
  | { ok: true; id: string; slot: number }
  | { ok: false; reason: 'duplicate'; id: string; existing: Record<string, unknown> }

/**
 * Write the invitation at the first deterministic slot that is free, stepping
 * past refused ones. A slot that holds anything else is the same person's live
 * invitation: nothing is written, and the caller says so.
 */
export async function runInvitationCreate(
  agencyId: string,
  email: unknown,
  phone: unknown,
  steps: InvitationCreateSteps,
): Promise<InvitationCreateResult> {
  const hash = await steps.sha256Hex(invitationKey(agencyId, email, phone))
  for (let slot = 1; slot <= MAX_INVITATION_SLOTS; slot += 1) {
    const id = invitationId(hash, slot)
    const outcome = await steps.createIfAbsent(id)
    if (outcome.created) return { ok: true, id, slot }
    if (invitationOccupies(outcome.existing)) {
      return { ok: false, reason: 'duplicate', id, existing: outcome.existing }
    }
  }
  // Every slot holds a refused invitation: invite as before (slot 0).
  return { ok: true, id: await steps.createAuto(), slot: 0 }
}

/**
 * QA #51 — an approved invitation, from the agency's side: still waiting for
 * the code (`approved`), or the code entered by the host whose Host role waits
 * for a contact to be verified (`awaiting_verification`, written by
 * `activateHost` when the host had verified only one of phone and e-mail).
 */
export function isApprovedInvitationStatus(status: unknown): boolean {
  const s = String(status ?? '').trim()
  return s === 'approved' || s === 'awaiting_verification'
}

/** The stage shown on an approved invitation's row. */
export function invitationStageLabel(app: { status?: unknown; activationPending?: unknown }): string {
  if (String(app.status ?? '').trim() !== 'awaiting_verification') return 'Awaiting Activation'
  const missing = Array.isArray(app.activationPending)
    ? app.activationPending.filter((m): m is string => m === 'phone' || m === 'email')
    : []
  const what = missing.length === 2 ? 'phone and email'
    : missing[0] === 'phone' ? 'phone number'
    : missing[0] === 'email' ? 'email'
    : 'contacts'
  return `Code entered — host verifying ${what}`
}

/**
 * RC — may the agency WITHDRAW this row? The same test `firestore.rules`
 * applies to an agency's delete of `hostApplications/{id}`: its own pending,
 * never-redeemed INVITATION. A person's self-filed application under the
 * agency (`applicantUid`, `source: 'self_app'`) is the applicant's, and staff
 * decide it — the dashboard does not offer to delete it. Withdrawing also
 * removes the invitation's KYC uploads (Functions `onHostInvitationWithdrawn`).
 */
export function isWithdrawableInvitation(app: Record<string, unknown> | null | undefined): boolean {
  const a = app ?? {}
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  if (text(a.status) !== 'pending') return false
  if (a.isActivated === true || text(a.activatedByUid) !== '') return false
  if (text(a.applicantUid) !== '' || text(a.source) === 'self_app') return false
  return true
}
