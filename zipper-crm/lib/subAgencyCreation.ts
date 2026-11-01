/**
 * FX-03 — creating a sub-agency from the agency dashboard: the ORDER of the
 * writes, and the duplicate check, as a pure module (no Firebase, no React) so
 * the spec runs the shipped code.
 *
 * ── THE BUG THIS ENCODES ────────────────────────────────────────────────────
 *
 * The modal wrote `agencies/{auto}` FIRST and created the sub-agency's login
 * SECOND. `createUserWithEmailAndPassword` refuses an address that already has
 * an account — the one failure guaranteed on a retry — so every failed attempt
 * left a pending sub-agency with no owner, which the registration trigger gave
 * a Mongo partner record of its own, and every retry added another (DUP-01).
 * The four registration forms were fixed by creating the login first
 * (`lib/auth.ts → createPartnerLogin`); this modal was not.
 *
 * Now:
 *   1. the login is created first — if that refuses, NOTHING is written;
 *   2. the record second — if that fails, the login just created is deleted
 *      again, so the address is free for the retry;
 *   3. the login's own `crmUsers` document and the record's `crmUid` back-link
 *      last — a failure there leaves both the record and its login (staff
 *      finish it with Attach login), and is reported as `linked: false`, never
 *      as "failed", because a retry would refuse on the address anyway.
 *
 * And before any of it, the parent's existing sub-agencies are checked for the
 * same owner email or phone (rejected ones aside), so an orphan left by the
 * old order — or a second click in another tab — is caught by name.
 */

import { sameEmail, samePhone } from './hostRows'

export interface ExistingSubAgency {
  id: string
  ownerEmail?: unknown
  ownerPhone?: unknown
  status?: unknown
}

export interface DuplicateSubAgency {
  id: string
  field: 'email' | 'phone'
}

/**
 * A sub-agency of this parent that already names the same owner email or phone.
 * A REJECTED one is history and does not block a new application.
 */
export function findDuplicateSubAgency(
  existing: readonly ExistingSubAgency[],
  email: string,
  phone: string,
): DuplicateSubAgency | null {
  for (const row of existing) {
    if (String(row.status ?? '').trim().toLowerCase() === 'rejected') continue
    if (sameEmail(row.ownerEmail, email)) return { id: row.id, field: 'email' }
    if (samePhone(row.ownerPhone, phone)) return { id: row.id, field: 'phone' }
  }
  return null
}

/** The sentence the modal shows for a duplicate. */
export function duplicateSubAgencyMessage(dup: DuplicateSubAgency): string {
  const what = dup.field === 'email' ? 'owner email' : 'owner phone number'
  return (
    `A sub-agency with this ${what} already exists under your agency (${dup.id}). ` +
    'Nothing was created. If it was left unfinished by an earlier attempt, ask ZIPPER staff ' +
    'to attach its login rather than creating it again.'
  )
}

/** What each step does, injected so the order can be tested without Firebase. */
export interface SubAgencyCreationSteps {
  /** Create the new login. Throws (e.g. address in use) → nothing is written. */
  createLogin: () => Promise<string>
  /** Write the `agencies` record. Returns its id. */
  writeRecord: () => Promise<string>
  /** Undo step 1 when step 2 fails. Best effort. */
  deleteLogin: (uid: string) => Promise<void>
  /** The login's own `crmUsers` document, bound to the record by the rules. */
  writeLoginDoc: (uid: string, agencyId: string) => Promise<void>
  /** The record's `crmUid` back-link, written by the login it names. */
  writeBackLink: (uid: string, agencyId: string) => Promise<void>
  /** Always last: sign the secondary session out, release it. */
  finish: () => Promise<void>
}

export interface SubAgencyCreationResult {
  uid: string
  agencyId: string
  /** True once the record's `crmUid` names the login. */
  linked: boolean
  /** True once the login's `crmUsers` document exists. */
  loginDocWritten: boolean
}

export async function runSubAgencyCreation(steps: SubAgencyCreationSteps): Promise<SubAgencyCreationResult> {
  let uid = ''
  try {
    // 1. Login first: an address that is already in use stops everything here.
    uid = await steps.createLogin()

    // 2. The record. On failure the login is removed again and the error raised.
    let agencyId = ''
    try {
      agencyId = await steps.writeRecord()
    } catch (err) {
      try {
        await steps.deleteLogin(uid)
      } catch {
        // The record was not written, so nothing is orphaned in Firestore; an
        // undeletable login only keeps the address taken. Surface the original.
      }
      throw err
    }

    // 3. The login document and the back-link. The record and the login both
    // exist by now, so a failure is reported, never thrown: "failed to create"
    // would invite a retry, and a retry would refuse on the address.
    let loginDocWritten = false
    let linked = false
    try {
      await steps.writeLoginDoc(uid, agencyId)
      loginDocWritten = true
      await steps.writeBackLink(uid, agencyId)
      linked = true
    } catch {
      // reported through the result
    }
    return { uid, agencyId, linked, loginDocWritten }
  } finally {
    await steps.finish().catch(() => undefined)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Decision 16 (RC) — a fresh application after a rejection
// ══════════════════════════════════════════════════════════════════════════════
//
// Rejection releases the registration slot, and the person may apply again —
// including under the same Agency. From this dashboard that used to be
// impossible: the person's login already exists from the rejected attempt, so
// step 1 above (`createUserWithEmailAndPassword`) refuses the address every
// time. When it does, the dashboard asks the API to file the NEW application
// for the existing login instead (`POST /partner-ops/agencies/{id}/sub-
// agencies/reapply`). The API decides whether this is one: only a login whose
// agency-family records are ALL rejected, including a Sub-agency, qualifies;
// anything else is refused with a sentence that says why. The rejected record
// is kept as it is.

/** Did step 1 refuse because the address already has a login? */
export function isAddressInUse(err: unknown): boolean {
  return String((err as { code?: unknown })?.code ?? '') === 'auth/email-already-in-use'
}

/** The application fields the API's re-application accepts, from the modal's record. */
const REAPPLY_FIELDS = [
  'agencyName', 'ownerName', 'ownerPhone', 'ownerEmail', 'paymentType', 'binanceUid',
  'accountHolderName', 'accountNumber', 'ifscCode', 'bankName', 'branch', 'upiId', 'currency',
] as const

export function reapplyFormFrom(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const form: Record<string, unknown> = {}
  for (const key of REAPPLY_FIELDS) {
    const v = record[key]
    if (typeof v === 'string' && v.trim() !== '') form[key] = v.trim()
  }
  const docs = Array.isArray(record.kycDocUrls)
    ? record.kycDocUrls.filter((u): u is string => typeof u === 'string' && u !== '')
    : []
  form.kycDocUrls = docs.slice(0, 3)
  return form
}

/** The sentence after a re-application was filed. */
export function reappliedMessage(email: string, previousId: string): string {
  return (
    `${email} had an earlier Sub-agency application${previousId ? ` (${previousId})` : ''} that was ` +
    'rejected. A NEW application has been filed for the same login and is with ZIPPER staff. ' +
    'The earlier one is kept, with its decision, in the history.'
  )
}
