/**
 * Zipper's public email identities — the ONE place the CRM reads them from.
 *
 * Owner decision (3 Nov 2026): the official domain is zipperlive.org, and
 * there are exactly three identities.
 *
 *   no-reply@zipperlive.org  automated mail only (OTP, verification, password
 *                            reset, security and system notices). It is a
 *                            SENDER, never a contact: nothing in the CRM tells a
 *                            person to write to it.
 *   info@zipperlive.org      general business enquiries.
 *   support@zipperlive.org   customer support — every "Need help? Contact us".
 *
 * Before this, five addresses on four domains were in use across the product
 * (QA #47 lists them in qa/QA-FINDINGS.md). The same three addresses are in
 * `backend/app/core/contacts.py`, `functions/src/mail.ts` and the app's
 * `com.zipper.app.util.ZipperContacts`; `contacts.spec.ts` checks all four agree.
 *
 * Environment-aware: a deployment may override the two CONTACT addresses with
 * NEXT_PUBLIC_SUPPORT_EMAIL / NEXT_PUBLIC_INFO_EMAIL (a staging CRM pointing at
 * a test mailbox, say). An override that is not an address on the official
 * domain is ignored, so a typo cannot put a stranger's address on the page.
 * No imports, so the spec runs the shipped module standalone.
 */

export const OFFICIAL_EMAIL_DOMAIN = 'zipperlive.org'

const DEFAULT_SUPPORT = `support@${OFFICIAL_EMAIL_DOMAIN}`
const DEFAULT_INFO = `info@${OFFICIAL_EMAIL_DOMAIN}`

/** The sender of automated mail. Never shown as somebody to write to. */
export const NO_REPLY_EMAIL = `no-reply@${OFFICIAL_EMAIL_DOMAIN}`

/** An override is honoured only when it is an address on the official domain. */
export function officialOr(override: string | undefined, fallback: string): string {
  const v = (override ?? '').trim().toLowerCase()
  if (!v) return fallback
  const at = v.lastIndexOf('@')
  if (at <= 0 || /\s/.test(v)) return fallback
  if (v.slice(at + 1) !== OFFICIAL_EMAIL_DOMAIN) return fallback
  if (v === NO_REPLY_EMAIL) return fallback // a sender is not a contact
  return v
}

// Written out literally: Next.js inlines `process.env.NEXT_PUBLIC_*` only when
// the property is named in full, and `process` does not exist in the browser
// otherwise.
function env(name: 'NEXT_PUBLIC_SUPPORT_EMAIL' | 'NEXT_PUBLIC_INFO_EMAIL'): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  return name === 'NEXT_PUBLIC_SUPPORT_EMAIL'
    ? process.env.NEXT_PUBLIC_SUPPORT_EMAIL
    : process.env.NEXT_PUBLIC_INFO_EMAIL
}

/** Customer support — "Need help? Contact us". */
export const SUPPORT_EMAIL = officialOr(env('NEXT_PUBLIC_SUPPORT_EMAIL'), DEFAULT_SUPPORT)

/** General business enquiries. */
export const INFO_EMAIL = officialOr(env('NEXT_PUBLIC_INFO_EMAIL'), DEFAULT_INFO)

/** `mailto:` for one of the contact addresses above. */
export function mailtoHref(address: string, subject = ''): string {
  return `mailto:${address}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`
}
