/**
 * Decision 15 (RC) — the CRM's side of "approval is not activation until BOTH
 * contacts are verified". Pure: no imports, no React, so the shipped module is
 * what `contactVerification.spec.ts` compiles and runs.
 *
 * The rule itself lives on the server (`backend/app/services/
 * contact_verification.py`, mirrored by `functions/src/contactProof.ts`):
 * a partner role starts only when the login holds a verified phone AND a
 * verified email, each proved on its own. This file only reads what the API
 * says and turns it into words and next steps — it decides nothing.
 */

/** The machine-readable code on every refusal the rule produces. */
export const CONTACT_VERIFICATION_REQUIRED = 'CONTACT_VERIFICATION_REQUIRED'

export type Contact = 'phone' | 'email'

/** What the API returns for `GET /partner-ops/me/verification` (masked). */
export interface VerificationView {
  complete: boolean
  missing: Contact[]
  phone: { verified: boolean; masked: string }
  email: { verified: boolean; masked: string; unproved: boolean; method: string }
  noAccount: boolean
}

export interface WaitingRole { id: string; kind: string; name?: string; agency_id?: string }

export interface VerificationOverview {
  verification: VerificationView
  waiting: WaitingRole[]
  requirement: 'both'
  started?: Array<{ id: string; kind: string; activated: boolean; refusal?: unknown }>
}

/** A refusal the rule produced, read out of an API error's `detail`. */
export interface VerificationRefusal {
  message: string
  missing: Contact[]
  emailUnproved: boolean
}

function asContacts(value: unknown): Contact[] {
  if (!Array.isArray(value)) return []
  const out: Contact[] = []
  for (const v of value) {
    if ((v === 'phone' || v === 'email') && !out.includes(v)) out.push(v)
  }
  return out
}

/** The structured refusal in an API error detail, or null for any other error. */
export function verificationRefusal(detail: unknown): VerificationRefusal | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const d = detail as Record<string, unknown>
  if (d.code !== CONTACT_VERIFICATION_REQUIRED) return null
  return {
    message: typeof d.message === 'string' ? d.message : '',
    missing: asContacts(d.missing),
    emailUnproved: d.emailUnproved === true,
  }
}

/** "a verified phone number and a verified email address", for what is missing. */
export function missingPhrase(missing: readonly Contact[]): string {
  const words = missing.map((m) => (m === 'phone' ? 'a verified phone number' : 'a verified email address'))
  if (words.length === 0) return ''
  if (words.length === 1) return words[0]
  return `${words[0]} and ${words[1]}`
}

/** One line for staff screens about a record that waits. */
export function awaitingLabel(missing: readonly Contact[]): string {
  const what = missingPhrase(missing)
  return what
    ? `Approved — waiting for ${what} on the login. The role starts by itself once both are verified.`
    : 'Approved — waiting for the role to start. Use “Check and start”.'
}

/** Is this status the waiting state? (Mongo record, Firestore doc or login.) */
export function isAwaitingVerification(status: unknown): boolean {
  return String(status ?? '').trim() === 'awaiting_verification'
}

/**
 * A storable international number for the SMS step, or '' when unusable.
 * A bare national number gets `defaultDial` (the CRM's existing default,
 * India); one with a `+` is kept as typed, digits only.
 */
export function phoneE164(input: string, defaultDial = '+91'): string {
  const raw = String(input ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 15) return ''
  if (raw.startsWith('+')) return `+${digits}`
  const dial = defaultDial.replace(/\D/g, '')
  if (digits.startsWith(dial) && digits.length > 10) return `+${digits}`
  return `+${dial}${digits.replace(/^0+/, '')}`
}

/** What a Firebase Auth error code means for this flow. */
export type PhoneLinkOutcome = 'conflict' | 'already_linked' | 'wrong_code' | 'expired' | 'too_many' | 'invalid_number' | 'other'

export function phoneLinkOutcome(code: unknown): PhoneLinkOutcome {
  switch (String(code ?? '')) {
    case 'auth/credential-already-in-use':
    case 'auth/account-exists-with-different-credential':
    case 'auth/phone-number-already-exists':
      return 'conflict'
    case 'auth/provider-already-linked':
      return 'already_linked'
    case 'auth/invalid-verification-code':
      return 'wrong_code'
    case 'auth/code-expired':
    case 'auth/session-expired':
      return 'expired'
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded':
      return 'too_many'
    case 'auth/invalid-phone-number':
    case 'auth/missing-phone-number':
      return 'invalid_number'
    default:
      return 'other'
  }
}

/** Did a check start anything? */
export function startedAny(o: Pick<VerificationOverview, 'started'> | null | undefined): boolean {
  return Array.isArray(o?.started) && o!.started!.some((s) => s && s.activated === true)
}
