/**
 * §5 — what a ban records besides its reason: its SCOPE, its CATEGORY and its
 * EVIDENCE. Exactly the server's `Ban` body (`backend/app/routers/users.py`):
 *
 *   scope     `account` | `account_and_devices` — default the latter, which is
 *             what a ban has always done (every handset the account was seen
 *             on is barred)
 *   category  a short label (≤ 80) — the server bounds only the length; the
 *             vocabulary below is the CRM's (and the Android Work hub's) list
 *   evidence  up to ten references — report ids, storage paths, links; never
 *             files. The server keeps each to 500 characters.
 *
 * All three are recorded on the account and on the audit entry, and the
 * appeals queue shows them to whoever reviews an appeal against the ban
 * (`lib/appealReview.ts`).
 *
 * Pure — no imports — so `npm run test:bandetails` runs the shipped module.
 */

export const BAN_SCOPES = ['account_and_devices', 'account'] as const
export type BanScopeValue = (typeof BAN_SCOPES)[number]

/** The server's default, and what every ban before §5 did. */
export const DEFAULT_BAN_SCOPE: BanScopeValue = 'account_and_devices'

export const BAN_SCOPE_LABEL: Readonly<Record<BanScopeValue, string>> = Object.freeze({
  account_and_devices: 'Account and every device it used',
  account: 'Account only',
})

/** What each scope does, said in terms of what the person will experience. */
export const BAN_SCOPE_EFFECT: Readonly<Record<BanScopeValue, string>> = Object.freeze({
  account_and_devices:
    'Every handset this account has been seen on is barred — no account works on those phones, ' +
    'this one or a new one. That is the point, and the cost: anybody who shares one of those ' +
    'phones is locked out too.',
  account:
    'Only the account is banned. Its handsets are left alone, so a different account can still be ' +
    'used on the same phone.',
})

/**
 * The category list. The values are the Android Work hub's (`banCategories`
 * in `WorkActions.kt`) so a ban raised on either surface reads the same on
 * the other; the spec compares the two lists when the app sits beside this
 * repo. `''` is "not stated", which is a real answer and the default.
 */
export const BAN_CATEGORIES: readonly { value: string; label: string }[] = Object.freeze([
  { value: '', label: 'Not stated' },
  { value: 'spam', label: 'Spam' },
  { value: 'fraud', label: 'Fraud / scam' },
  { value: 'harassment', label: 'Harassment or abuse' },
  { value: 'sexual_content', label: 'Sexual content' },
  { value: 'underage', label: 'Underage' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'payment_abuse', label: 'Payment abuse' },
  { value: 'other', label: 'Other' },
])

/** `Ban.evidence: max_length=10` and `services/users.MAX_BAN_EVIDENCE`. */
export const MAX_BAN_EVIDENCE = 10
/** `services/users._ban_details` keeps each reference to 500 characters. */
export const MAX_EVIDENCE_LENGTH = 500
/** `Ban.category: max_length=80`. */
export const MAX_CATEGORY_LENGTH = 80

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isBanScope(v: unknown): v is BanScopeValue {
  return (BAN_SCOPES as readonly string[]).includes(text(v))
}

/** A recorded scope, for a reader. An unknown value is shown as written, never guessed. */
export function banScopeLabel(scope: unknown): string {
  const s = text(scope)
  if (!s) return 'Not recorded'
  return isBanScope(s) ? BAN_SCOPE_LABEL[s] : s
}

/** A recorded category, for a reader. An unknown value is shown as written. */
export function banCategoryLabel(category: unknown): string {
  const c = text(category)
  if (!c) return 'Not stated'
  return BAN_CATEGORIES.find((x) => x.value === c)?.label ?? c
}

/** One reference per line; blank lines and surrounding space dropped. */
export function parseEvidence(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** What the ban dialog is holding. Strings, because the fields are mid-edit. */
export interface BanDetailsInput {
  scope: string
  category: string
  evidenceText: string
}

export const DEFAULT_BAN_DETAILS: Readonly<BanDetailsInput> = Object.freeze({
  scope: DEFAULT_BAN_SCOPE,
  category: '',
  evidenceText: '',
})

/** '' when the details may be sent; otherwise the sentence to show first. */
export function banDetailsProblem(input: BanDetailsInput): string {
  if (!isBanScope(input.scope)) {
    return 'Choose what the ban reaches: the account alone, or the account and every device it used.'
  }
  if (text(input.category).length > MAX_CATEGORY_LENGTH) {
    return `A category is at most ${MAX_CATEGORY_LENGTH} characters.`
  }
  const refs = parseEvidence(input.evidenceText)
  if (refs.length > MAX_BAN_EVIDENCE) {
    return `At most ${MAX_BAN_EVIDENCE} evidence references (${refs.length} given). ` +
      'Put the rest in a report and reference the report.'
  }
  if (refs.some((r) => r.length > MAX_EVIDENCE_LENGTH)) {
    return `Each evidence reference is at most ${MAX_EVIDENCE_LENGTH} characters — a report id, a storage path or a link.`
  }
  return ''
}

/**
 * The `Ban` body's three extra fields. `scope` is ALWAYS sent — the intent is
 * then in the request rather than in a server default nobody reading the
 * screen can see; the other two only when there is something in them.
 */
export function banDetailsBody(input: BanDetailsInput): {
  scope: BanScopeValue
  category?: string
  evidence?: string[]
} {
  const scope = isBanScope(input.scope) ? (text(input.scope) as BanScopeValue) : DEFAULT_BAN_SCOPE
  const category = text(input.category)
  const evidence = parseEvidence(input.evidenceText)
  return {
    scope,
    ...(category ? { category } : {}),
    ...(evidence.length ? { evidence } : {}),
  }
}

/** One sentence for the success panel — what the ban was recorded as. */
export function banDetailsSummary(input: BanDetailsInput): string {
  const body = banDetailsBody(input)
  const parts = [`Scope: ${BAN_SCOPE_LABEL[body.scope]}`]
  if (body.category) parts.push(`category: ${banCategoryLabel(body.category)}`)
  const n = body.evidence?.length ?? 0
  parts.push(n ? `${n} evidence reference${n === 1 ? '' : 's'}` : 'no evidence references')
  return `${parts.join(' · ')}.`
}
