/**
 * Which user-supplied URLs the CRM will render as a clickable link.
 *
 * Pure — no imports — so `npm run test:safelink` runs the shipped module.
 *
 * Audit C-13: `proof_url` on a recharge request is typed by an app user and
 * accepted by the API without a scheme check when a reference is given
 * (`services/recharges.py`). Rendering it as `<a href>` put a `javascript:`
 * or phishing link in front of the staff member who reviews the payment. A
 * link is rendered only for an `https://` URL on one of the Storage hosts the
 * app uploads to; anything else is shown as plain text, which is still the
 * evidence, just not a thing to click.
 */

/** The hosts the app's uploads live on. Exact host matches only. */
export const STORAGE_LINK_HOSTS: ReadonlySet<string> = new Set([
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
])

export type SafeLink =
  | { kind: 'link'; href: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' }

/** `https://` on a Storage host → a link; anything else → text; blank → none. */
export function storageLink(raw: unknown): SafeLink {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { kind: 'none' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'text', text: value }
  }
  if (url.protocol !== 'https:') return { kind: 'text', text: value }
  if (!STORAGE_LINK_HOSTS.has(url.hostname.toLowerCase())) return { kind: 'text', text: value }
  if (url.username || url.password) return { kind: 'text', text: value }
  return { kind: 'link', href: url.toString() }
}

/** True when `storageLink` would render a link. */
export function isStorageLink(raw: unknown): boolean {
  return storageLink(raw).kind === 'link'
}
