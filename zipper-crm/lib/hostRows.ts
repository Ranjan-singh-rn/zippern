/**
 * One row per PERSON on the host screens (GOV B08 / contract C5).
 *
 * Pure — no imports, no React, no Firebase — so `npm run test:hostrows`
 * compiles and runs the shipped module, not a copy of it.
 *
 * ── THE BUG THIS ENDS ───────────────────────────────────────────────────────
 *
 * /hosts, the agency roster and the agency dashboard each build their list
 * from two Firestore reads — `users` (people who are Hosts) and
 * `hostApplications` (invitations and self-applications) — and joined them on
 * `activatedByUid` alone, or not at all. A SELF-application never has that
 * field: it carries `applicantUid` from the moment it is filed, and approving
 * it granted the role without stamping `activatedByUid` / `isActivated`. So
 * the same human appeared twice — once as an Active host, once as an
 * "Awaiting Activation" application — and every tab count added both.
 *
 * The rule, from the contract:
 *
 *   * an application whose `activatedByUid || applicantUid` is a CURRENT Host
 *     is not a second row — it is shown on that Host's row ("via application
 *     <id>"), and counts count people;
 *   * an application REDEEMED by somebody who is no longer a Host stays that
 *     same person's history (the roster's existing join), never a new person;
 *   * an invitation nobody has redeemed, whose phone or email is an existing
 *     Host's, is FLAGGED, never hidden — the verified contact on a user
 *     document belongs to one account, and `activateHost` matches an
 *     invitation against exactly that pair, so it can only ever be that
 *     Host's invitation. It is shown, and it is not counted as somebody new.
 *
 * Nothing here drops a row. Every application that goes in comes out, either
 * on its person's row or as a row of its own.
 */

// ── Reading untyped document fields ─────────────────────────────────────────

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// ── Whose application is this ───────────────────────────────────────────────

/** The two fields that tie an application to an account. */
export interface ApplicationLink {
  /** Written by `activateHost` when an invitation code is redeemed. */
  activatedByUid?: unknown
  /** A self-application, filed from the app by the signed-in person. */
  applicantUid?: unknown
}

/**
 * Whose application this is: the account that redeemed it, else the account
 * that filed it. '' for an agency invitation nobody has redeemed yet.
 */
export function applicationPersonUid(app: ApplicationLink): string {
  return text(app.activatedByUid) || text(app.applicantUid)
}

/**
 * What a person row says about the account behind it.
 *
 *   current — holds the Host role now (`users.isHost`).
 *   former  — has a person row but not the role (`isHost === false`): revoked
 *             or removed, kept on the roster because of its earnings history.
 */
export type PersonStatus = 'current' | 'former'

/**
 * `users.isHost`, read the way the roster has always read it: only an
 * explicit `false` means "not a Host". A missing field on a document that is
 * on a host list is not evidence of anything, and reading it as "not a host"
 * would quietly un-count real hosts.
 */
export function personStatusOf(isHost: unknown): PersonStatus {
  return isHost === false ? 'former' : 'current'
}

/**
 * The person row this application belongs to, or '' when it is a row of its
 * own.
 *
 * `statusOf(uid)` answers for the uids that already have a person row on the
 * screen (and `undefined` for any other).
 *
 *   * the person is a CURRENT Host           → their row (C5);
 *   * a FORMER Host who REDEEMED it          → their row — it is that same
 *                                              person's history;
 *   * a former Host's own new application    → its own row: a re-application
 *                                              is decided on its own, and the
 *                                              former row is not counted;
 *   * nobody on the screen / no uid at all   → its own row.
 */
export function linkedPersonUid(
  app: ApplicationLink,
  statusOf: (uid: string) => PersonStatus | undefined,
): string {
  const person = applicationPersonUid(app)
  if (!person) return ''
  const status = statusOf(person)
  if (status === 'current') return person
  if (status === 'former' && text(app.activatedByUid) === person) return person
  return ''
}

// ── Contact matching, for the invitation nobody has redeemed ────────────────

/** Digits only. */
export function phoneDigits(v: unknown): string {
  return text(v).replace(/[^0-9]/g, '')
}

/**
 * The same phone number, however it was typed.
 *
 * Equal digits, or a BARE legacy number (no `+`, at least six digits) and the
 * same number with a one-to-three digit country code in front — the one
 * respelling `ownerContactWriteOk()` in firestore.rules accepts as the same
 * number. Never two different full international numbers.
 */
export function samePhone(a: unknown, b: unknown): boolean {
  const ra = text(a)
  const rb = text(b)
  const da = phoneDigits(ra)
  const db = phoneDigits(rb)
  if (da.length < 6 || db.length < 6) return false
  if (da === db) return true
  const bareInsideFull = (bareRaw: string, bare: string, full: string): boolean =>
    !bareRaw.startsWith('+')
    && full.length > bare.length
    && full.length - bare.length <= 3
    && full.endsWith(bare)
  return bareInsideFull(ra, da, db) || bareInsideFull(rb, db, da)
}

/** The same address, case and surrounding space aside. */
export function sameEmail(a: unknown, b: unknown): boolean {
  const ea = text(a).toLowerCase()
  const eb = text(b).toLowerCase()
  return ea !== '' && ea.includes('@') && ea === eb
}

/** What a person row carries for matching: the account's own contact. */
export interface ContactPerson {
  uid: string
  phoneNumber?: unknown
  email?: unknown
}

/** What an application carries for matching: the contact it was filed for. */
export interface ContactApplication {
  applicantPhone?: unknown
  applicantEmail?: unknown
}

/**
 * The CURRENT Host whose phone or email this application carries, or null.
 * Only hosts are passed in; the caller decides which list that is.
 */
export function contactMatch<H extends ContactPerson>(
  app: ContactApplication,
  hosts: readonly H[],
): H | null {
  for (const h of hosts) {
    if (samePhone(app.applicantPhone, h.phoneNumber)) return h
    if (sameEmail(app.applicantEmail, h.email)) return h
  }
  return null
}

// ── The whole list ──────────────────────────────────────────────────────────

export interface HostRowInput extends ContactPerson {
  /** `users.isHost`. Only an explicit `false` is a former Host. */
  isHost?: unknown
}

export interface ApplicationRowInput extends ApplicationLink, ContactApplication {
  id: string
}

export interface LinkedHostRow<H, A> {
  host: H
  /** Applications that are this same person, in the order they came in. */
  applications: A[]
}

export interface ApplicationRow<H, A> {
  app: A
  /**
   * The current Host this application's contact belongs to — flagged on the
   * row, not hidden, and not counted as another person. Null when none.
   */
  sameContactAs: H | null
}

export interface ReconciledHostRows<H, A> {
  /** Every person row, in input order, with that person's applications. */
  hostRows: LinkedHostRow<H, A>[]
  /** Applications that are no person row's: still shown, never dropped. */
  applicationRows: ApplicationRow<H, A>[]
  /** Distinct people with a row: current Hosts plus separate applicants. */
  people: number
  /** Person rows that are current Hosts. */
  currentHosts: number
  /** Application rows that are a separate person (not a contact match). */
  separateApplicants: number
  /** Application rows flagged as an existing Host's contact. */
  flaggedApplications: number
}

/**
 * Reconcile the two reads into one row per person.
 *
 * `hosts` are the person rows the screen already has (a former Host may be
 * among them on the roster and the agency dashboard; /hosts passes current
 * Hosts only). `applications` are whatever the screen fetched — rejected ones
 * are the caller's to leave out, because a refused application is history and
 * is never counted.
 */
export function reconcileHostRows<H extends HostRowInput, A extends ApplicationRowInput>(
  hosts: readonly H[],
  applications: readonly A[],
): ReconciledHostRows<H, A> {
  const byUid = new Map<string, LinkedHostRow<H, A>>()
  const status = new Map<string, PersonStatus>()
  const hostRows: LinkedHostRow<H, A>[] = []
  for (const host of hosts) {
    const uid = text(host.uid)
    // The first row for a uid wins; a duplicate document id cannot occur in
    // one Firestore read, so this only guards against a caller's own merge.
    if (!uid || byUid.has(uid)) continue
    const row: LinkedHostRow<H, A> = { host, applications: [] }
    byUid.set(uid, row)
    status.set(uid, personStatusOf(host.isHost))
    hostRows.push(row)
  }
  const current = hostRows
    .filter((r) => status.get(text(r.host.uid)) === 'current')
    .map((r) => r.host)

  const applicationRows: ApplicationRow<H, A>[] = []
  for (const app of applications) {
    const linked = linkedPersonUid(app, (uid) => status.get(uid))
    if (linked) {
      byUid.get(linked)?.applications.push(app)
      continue
    }
    // An application filed by an account that is not a current Host on this
    // screen is a person of its own, whoever's contact it carries — the uid
    // says who it is. Only an invitation nobody has redeemed is matched on
    // its contact, because a contact is all it has.
    const sameContactAs = applicationPersonUid(app) ? null : contactMatch(app, current)
    applicationRows.push({ app, sameContactAs })
  }

  const flaggedApplications = applicationRows.filter((r) => r.sameContactAs !== null).length
  const separateApplicants = applicationRows.length - flaggedApplications
  return {
    hostRows,
    applicationRows,
    people: current.length + separateApplicants,
    currentHosts: current.length,
    separateApplicants,
    flaggedApplications,
  }
}

/** The /hosts tabs, counted in people. `all` is always the sum of the other three. */
export interface HostTabCounts {
  all: number
  /** Current Hosts who are not banned. */
  active: number
  /** Current Hosts who are banned. */
  banned: number
  /** Separate applicants — people with an application and no Host row. */
  invited: number
  /** Applications shown flagged as an existing Host's contact; in no count. */
  flagged: number
}

export function hostTabCounts<H extends HostRowInput, A>(
  rows: ReconciledHostRows<H, A>,
  isBanned: (host: H) => boolean,
): HostTabCounts {
  let active = 0
  let banned = 0
  for (const r of rows.hostRows) {
    if (personStatusOf(r.host.isHost) !== 'current') continue
    if (isBanned(r.host)) banned += 1
    else active += 1
  }
  return {
    all: active + banned + rows.separateApplicants,
    active,
    banned,
    invited: rows.separateApplicants,
    flagged: rows.flaggedApplications,
  }
}

/**
 * Which of a person's applications to show as "the" one: a redeemed one
 * first, then an approved one, then a pending one, then whatever is left —
 * in input order within each.
 */
export function primaryApplication<A extends { status?: unknown; isActivated?: unknown }>(
  applications: readonly A[],
): A | undefined {
  const rank = (a: A): number =>
    a.isActivated === true ? 0
      : text(a.status) === 'approved' ? 1
        : text(a.status) === 'pending' ? 2
          : 3
  let best: A | undefined
  for (const a of applications) {
    if (best === undefined || rank(a) < rank(best)) best = a
  }
  return best
}

/** How a linked application reads on its Host's row. */
export function linkedApplicationLabel(app: { id: string; status?: unknown }): string {
  const s = text(app.status)
  if (s === 'pending') return `pending application ${app.id}`
  return `via application ${app.id}`
}

// ── Which agency, by its current name (GOV B20) ─────────────────────────────

export interface AgencyLabel {
  /** What to print: the agency document's current name when it could be read. */
  label: string
  /** True when `label` came from the agency document rather than a copy. */
  current: boolean
  /** The name stored on the application, when it differs from the current one. */
  staleName: string
}

/**
 * The agency a row belongs to, by the agency document's CURRENT name.
 *
 * The name copied onto an application is whatever the applicant's picker
 * showed at the time — a Mongo name set once at creation and never updated
 * when the agency renames itself in Firestore. So the id is the authority,
 * the agency document is where its current name lives, and the copy is a
 * fallback for when that document could not be read (and is named as the
 * name it was filed under when the two differ).
 */
export function resolveAgencyName(
  agencyId: unknown,
  currentNames: ReadonlyMap<string, string>,
  storedName?: unknown,
): AgencyLabel {
  const id = text(agencyId)
  const stored = text(storedName)
  const now = id ? text(currentNames.get(id)) : ''
  if (now) {
    return { label: now, current: true, staleName: stored && stored !== now ? stored : '' }
  }
  return { label: stored || id, current: false, staleName: '' }
}
