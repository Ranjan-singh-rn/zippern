/**
 * §5 — the PUBLIC appeal's contact check, as `/appeal` reads it.
 *
 * Pure — no imports, no React — so `npm run test:appealcontact` compiles and
 * runs the shipped module.
 *
 * ── WHY THE PAGE NEEDS THIS AT ALL ──────────────────────────────────────────
 *
 * The backend now refuses to say anything beyond "not found", and refuses to
 * file an appeal, unless the person gives the phone number or the email
 * address that is ON the account (`services/public_appeals.py`
 * `_refuse_unless_contact_matches`, the Firebase Auth record — never the
 * client-written profile). `/appeal` did not collect it, so every lookup of a
 * restricted account came back CONTACT_REQUIRED and nobody could appeal from
 * the web at all. The Android app's "appeal" link opens this page, so it was
 * the only way in for a person whose login is disabled.
 *
 * The two refusals are distinct on purpose (spec: "account-matching contact
 * verification, mismatch error"): a MISSING contact and a WRONG one are
 * different instructions to the person. Both come back as a 400 whose detail
 * is a sentence written for this page; nothing machine-readable is attached,
 * so they are told apart here by the sentence itself — and the spec checks
 * these copies against the backend's text whenever the backend sits beside
 * this repo, so a reworded sentence fails a test instead of silently turning
 * into "something went wrong".
 */

/** `CONTACT_REQUIRED` in `backend/app/services/public_appeals.py`, verbatim. */
export const CONTACT_REQUIRED_MESSAGE =
  'Enter the phone number or the email address that is on the account, so we ' +
  'can match the appeal to it.'

/** `CONTACT_MISMATCH` in `backend/app/services/public_appeals.py`, verbatim. */
export const CONTACT_MISMATCH_MESSAGE =
  'The contact details you entered do not match the ones on this account. ' +
  'Use the phone number or email address the account was registered with.'

/** `Lookup.contact` / `_field(form, "contact", 0, 120)` — the server's bound. */
export const MAX_CONTACT = 120

/** `contact_matches` compares at least six digits of a phone number. */
export const MIN_PHONE_DIGITS = 6

export type ContactKind = 'email' | 'phone' | 'none'

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * One comparable form, exactly as `normalise_contact` makes it: an email is
 * lower-cased; a phone number is reduced to its digits with leading zeros
 * dropped. Used here only to count digits — the matching is the server's.
 */
export function normaliseContact(value: unknown): string {
  const t = text(value)
  if (t.includes('@')) return t.toLowerCase()
  return t.replace(/\D/g, '').replace(/^0+/, '')
}

/** Is this an email, a phone number, or nothing yet? */
export function contactKind(value: unknown): ContactKind {
  const t = text(value)
  if (!t) return 'none'
  return t.includes('@') ? 'email' : 'phone'
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_CHARACTERS = /^[+\d\s().-]+$/

/**
 * '' when the contact may be sent; otherwise the sentence to show BEFORE any
 * round trip. Deliberately only about shape — whether it matches the account
 * is the server's question, and only the server may answer it.
 */
export function contactProblem(value: unknown): string {
  const t = text(value)
  if (!t) return CONTACT_REQUIRED_MESSAGE
  if (t.length > MAX_CONTACT) return `Keep it under ${MAX_CONTACT} characters.`
  if (t.includes('@')) {
    return EMAIL_SHAPE.test(t)
      ? ''
      : 'That does not look like an email address. Check it, or enter the phone number instead.'
  }
  if (!PHONE_CHARACTERS.test(t)) {
    return 'A phone number may only contain digits, spaces, +, ( ), - and dots. Or enter the email address instead.'
  }
  if (normaliseContact(t).length < MIN_PHONE_DIGITS) {
    return `A phone number needs at least ${MIN_PHONE_DIGITS} digits. With or without the country code both work.`
  }
  return ''
}

/**
 * What the person sees back on the second step, so they know which contact
 * the appeal is being matched on — without printing it in full on a screen
 * somebody else may be looking at.
 */
export function maskContact(value: unknown): string {
  const t = text(value)
  if (!t) return ''
  if (t.includes('@')) {
    const [local, domain] = t.split('@', 2)
    const head = local.slice(0, 1)
    return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`
  }
  const digits = t.replace(/\D/g, '')
  if (digits.length <= 4) return '•'.repeat(digits.length)
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

// ── The server's refusals ────────────────────────────────────────────────────

export type PublicAppealRefusal =
  | 'contact_required'
  | 'contact_mismatch'
  | 'not_found'
  | 'already_pending'
  | 'rate_limited'
  | 'too_large'
  | 'other'

/** Stable fragments of the server's sentences (the full copies are above). */
const FRAGMENT = {
  contactRequired: 'phone number or the email address that is on the account',
  contactMismatch: 'do not match the ones on this account',
  notFound: 'could not find a restricted account',
  alreadyPending: 'already being reviewed',
} as const

/**
 * Which refusal this is. Total over anything a `catch` can hold: a non-object,
 * a status with no message, a message with no status — never a throw.
 */
export function classifyPublicAppealRefusal(err: unknown): PublicAppealRefusal {
  if (!err || typeof err !== 'object') return 'other'
  const status = typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : 0
  const message = text((err as { message?: unknown }).message)
  if (status === 429) return 'rate_limited'
  if (status === 413) return 'too_large'
  if (message.includes(FRAGMENT.contactRequired)) return 'contact_required'
  if (message.includes(FRAGMENT.contactMismatch)) return 'contact_mismatch'
  if (message.includes(FRAGMENT.notFound)) return 'not_found'
  if (message.includes(FRAGMENT.alreadyPending)) return 'already_pending'
  return 'other'
}

export function isContactRefusal(kind: PublicAppealRefusal): boolean {
  return kind === 'contact_required' || kind === 'contact_mismatch'
}

export interface RefusalView {
  kind: PublicAppealRefusal
  /** A short heading; '' when the sentence stands alone. */
  title: string
  /** The server's sentence, VERBATIM. Never paraphrased. */
  message: string
  /** True when the contact field is what is wrong — the page marks it. */
  contactField: boolean
  /** What to do about it; '' when the sentence already says. */
  hint: string
}

/**
 * How to show a refusal. The server's sentence is always the message, word
 * for word; this only adds a heading and marks the field at fault, so a wrong
 * contact cannot be mistaken for a missing account or a failed upload.
 */
export function presentPublicAppealRefusal(err: unknown, fallback = 'That did not work. Try again.'): RefusalView {
  const kind = classifyPublicAppealRefusal(err)
  const said = err && typeof err === 'object' ? text((err as { message?: unknown }).message) : ''
  switch (kind) {
    case 'contact_required':
      return {
        kind,
        title: 'The phone number or email on the account is needed',
        message: said || CONTACT_REQUIRED_MESSAGE,
        contactField: true,
        hint: 'It is used to match the appeal to the account.',
      }
    case 'contact_mismatch':
      return {
        kind,
        title: 'Those contact details do not match this account',
        message: said || CONTACT_MISMATCH_MESSAGE,
        contactField: true,
        hint:
          'Use the phone number or email the account was registered with — the one it signs in with. ' +
          'A phone number works with or without the country code.',
      }
    default:
      return { kind, title: '', message: said || fallback, contactField: false, hint: '' }
  }
}
