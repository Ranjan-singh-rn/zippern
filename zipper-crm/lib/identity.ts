/**
 * How a person or a partner is shown in the CRM — one rule for every screen (B1).
 *
 *   1. The NAME first: a person's display name, or a business/agency name.
 *   2. Email · phone underneath — only where the screen says the viewer is
 *      already authorised to see them, and only the ones that exist.
 *   3. A LABELLED id last: "Account ID", "Partner ID", "Request ID" … so a
 *      record stays traceable and two different kinds of id are never confused.
 *
 * Nothing here is ever invented. A profile that does not exist says
 * "Profile not found"; one that exists with no name says so; a lookup that
 * could not be made (a refused or failed read) says the name is unavailable —
 * three different facts, three different sentences, never a made-up name.
 *
 * No imports on purpose: the spec compiles this file on its own and exercises
 * the shipped code (see package.json `test:identity`).
 */

/** Which id this is. Each kind has exactly one label, used everywhere. */
export type IdKind =
  | 'account'   // a Firebase uid — the person's app/CRM account
  | 'host'      // a Firebase uid, shown in a Host context
  | 'buyer'     // a Firebase uid, shown as the buyer of a sale/recharge
  | 'partner'   // a partner RECORD id (Mongo partners._id = agencies/{id} or sellers/{id})
  | 'agency'    // an agencies/{id} record id
  | 'seller'    // a sellers/{id} record id
  | 'request'   // a request id (reinstatement, transfer, recharge …)
  | 'record'    // any other record id
  | 'freeze'    // a money_freezes key ("user:<uid>" / "partner:<id>")

export const ID_LABEL: Readonly<Record<IdKind, string>> = Object.freeze({
  account: 'Account ID',
  host: 'Host ID',
  buyer: 'Buyer ID',
  partner: 'Partner ID',
  agency: 'Agency ID',
  seller: 'Seller ID',
  request: 'Request ID',
  record: 'Record ID',
  freeze: 'Freeze key',
})

/**
 * What a lookup returned for one id.
 * `found: false` — the read worked and there is no such document.
 * An id with NO entry at all means it was never looked up, or its read failed.
 */
export interface IdentityFacts {
  found: boolean
  name: string
  email: string
  phone: string
  photoUrl: string
}

export type LookupState = 'loading' | 'done' | 'failed'

export const NOT_FOUND = 'Profile not found'
export const NO_NAME = 'No name on profile'
export const UNAVAILABLE = 'Name unavailable'
export const LOADING = 'Loading name…'

export interface IdentityView {
  /** The name, or one of the four sentences above. */
  primary: string
  /** True only when `primary` is a real name taken from a record. */
  named: boolean
  /** "email · phone" — empty unless authorised and present. */
  secondary: string
  /** "Account ID: abc" — always present, so the record stays traceable. */
  reference: string
}

/** A trimmed string, or '' for anything that is not a non-blank string. */
export function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function referenceOf(kind: IdKind, id: unknown): string {
  const text = clean(id)
  return `${ID_LABEL[kind]}: ${text || '—'}`
}

export function identityView(
  facts: IdentityFacts | undefined,
  id: unknown,
  kind: IdKind,
  opts: { showContacts?: boolean; state?: LookupState } = {},
): IdentityView {
  const reference = referenceOf(kind, id)
  if (facts) {
    const secondary = opts.showContacts && facts.found
      ? [clean(facts.email), clean(facts.phone)].filter((v) => v !== '').join(' · ')
      : ''
    if (!facts.found) return { primary: NOT_FOUND, named: false, secondary: '', reference }
    const name = clean(facts.name)
    return name
      ? { primary: name, named: true, secondary, reference }
      : { primary: NO_NAME, named: false, secondary, reference }
  }
  return {
    primary: opts.state === 'loading' ? LOADING : UNAVAILABLE,
    named: false,
    secondary: '',
    reference,
  }
}

/** The name if one is known, else the labelled id — for one-line text (dialog titles, notices). */
export function nameOrReference(facts: IdentityFacts | undefined, id: unknown, kind: IdKind): string {
  const name = facts && facts.found ? clean(facts.name) : ''
  return name ? `${name} (${referenceOf(kind, id)})` : referenceOf(kind, id)
}

/**
 * What a `{type, id}` subject (an audit entry, a money card) refers to.
 *   'person'  — the id is a Firebase uid: resolve it from `users`
 *   'partner' — the id is a partner RECORD id: resolve it from agencies/sellers
 *   null      — not a person or a partner (a card, an expense, a report …):
 *               shown as it always was, never looked up as if it were a person.
 */
export function subjectTarget(type: unknown): { lookup: 'person' | 'partner'; kind: IdKind } | null {
  const t = clean(type).toLowerCase()
  if (t === 'user' || t === 'owner' || t === 'staff' || t === 'host') {
    return { lookup: 'person', kind: t === 'host' ? 'host' : 'account' }
  }
  if (t === 'partner' || t === 'agency' || t === 'sub_agency' || t === 'subagency' || t === 'seller') {
    return { lookup: 'partner', kind: 'partner' }
  }
  return null
}

// ── Lookup plumbing (pure) ───────────────────────────────────────────────────

/** Firestore `documentId() in [...]` takes at most 30 values. */
export const IN_LIMIT = 30

/**
 * Distinct, trimmed, usable document ids. A '/' makes the whole query throw
 * while it is being built, so such an id is simply not looked up (it then
 * renders as "Name unavailable" with its id — never as a name).
 */
export function uniqueIds(ids: Iterable<unknown>): string[] {
  const out = new Set<string>()
  // Array.from, not for…of: the CRM compiles to a target without downlevel iteration.
  for (const raw of Array.from(ids)) {
    const id = clean(raw)
    if (id !== '' && !id.includes('/')) out.add(id)
  }
  return Array.from(out)
}

export function chunks<T>(items: readonly T[], size: number = IN_LIMIT): T[][] {
  const out: T[][] = []
  const step = Math.max(1, Math.floor(size))
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step))
  return out
}

type Doc = Record<string, unknown> | null | undefined

function first(doc: Doc, ...keys: string[]): string {
  if (!doc) return ''
  for (const k of keys) {
    const v = clean(doc[k])
    if (v) return v
  }
  return ''
}

/** `users/{uid}` → facts. The CRM's own `getUser` reads `name`, `email`, `phoneNumber`. */
export function personFacts(doc: Doc): IdentityFacts {
  return {
    found: true,
    name: first(doc, 'name', 'displayName'),
    email: first(doc, 'email'),
    phone: first(doc, 'phoneNumber', 'phone'),
    photoUrl: first(doc, 'photoUrl'),
  }
}

/** `publicProfiles/{uid}` → facts. A public projection: a name and a photo, never a contact. */
export function publicFacts(doc: Doc): IdentityFacts {
  return { found: true, name: first(doc, 'name', 'displayName'), email: '', phone: '', photoUrl: first(doc, 'photoUrl') }
}

/** `agencies/{id}` → facts. Every writer stores the name as `agencyName`; contacts are the owner's. */
export function agencyFacts(doc: Doc): IdentityFacts {
  return {
    found: true,
    name: first(doc, 'agencyName', 'name'),
    email: first(doc, 'ownerEmail', 'email'),
    phone: first(doc, 'ownerPhone', 'phone'),
    photoUrl: first(doc, 'photoUrl'),
  }
}

/** `sellers/{id}` → facts. Sellers are named `displayName`. */
export function sellerFacts(doc: Doc): IdentityFacts {
  return {
    found: true,
    name: first(doc, 'displayName', 'name'),
    email: first(doc, 'email'),
    phone: first(doc, 'phone'),
    photoUrl: first(doc, 'photoUrl'),
  }
}

export const MISSING: IdentityFacts = Object.freeze({ found: false, name: '', email: '', phone: '', photoUrl: '' })

/**
 * Fold one batch read into the map: every id the read covered is either a found
 * document or MISSING. Ids from a batch that FAILED are left out entirely, so
 * they render as "Name unavailable", not as "Profile not found".
 */
export function foldBatch(
  into: Map<string, IdentityFacts>,
  askedIds: readonly string[],
  docs: ReadonlyArray<{ id: string; data: Doc }>,
  toFacts: (doc: Doc) => IdentityFacts,
): void {
  const byId = new Map(docs.map((d) => [d.id, d.data] as const))
  for (const id of askedIds) {
    if (byId.has(id)) into.set(id, toFacts(byId.get(id)))
    else if (!into.has(id)) into.set(id, MISSING)
  }
}

/**
 * Agencies and sellers live in two collections and a partner id can be in
 * either. Found in one → that record. Missing from BOTH (and both reads worked)
 * → MISSING. Anything else (a read failed and the other did not find it) →
 * unknown, i.e. no entry.
 */
export function mergePartner(
  agency: IdentityFacts | undefined,
  seller: IdentityFacts | undefined,
): IdentityFacts | undefined {
  if (agency && agency.found) return agency
  if (seller && seller.found) return seller
  if (agency && seller) return MISSING
  return undefined
}
