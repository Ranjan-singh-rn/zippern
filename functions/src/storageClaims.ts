/**
 * The custom claim Storage Rules authorise against — and the half of it that
 * Firestore is allowed to decide.
 *
 * ── WHY A CLAIM EXISTS AT ALL ────────────────────────────────────────────────
 *
 * `firestore.rules` answers "is this person staff?" by reading
 * `crmUsers/{uid}`. Storage Rules cannot read Firestore, so that question had
 * no answer there, and `storage.rules` had been standing in a predicate that
 * returned `request.auth != null`. Every KYC document, bank slip and identity
 * proof in the bucket was therefore readable by anybody holding any token —
 * and since anonymous sign-in is enabled for Continue-as-guest and the web
 * config ships in the CRM bundle, "anybody" included a stranger with a script.
 *
 * A custom claim is the only mechanism that puts a role into a token a Storage
 * rule can see. This file provisions the partner half of it.
 *
 * ── WHY ONLY THE PARTNER HALF, AND WHY THAT IS THE WHOLE POINT ───────────────
 *
 * `crmUsers` documents have two origins. Staff documents are written by the
 * API through the Admin SDK (`backend/app/services/crm_directory.py`). Partner
 * documents — agency, sub-agency, coin seller — are written BY THE CLIENT, in
 * the browser, with the new partner's own token.
 *
 * So a trigger that mirrored `crmUsers.role` verbatim would be a privilege
 * escalation waiting to be found:
 *
 *     client writes crmUsers/{own uid} { role: 'owner' }
 *       → trigger mirrors it
 *         → token carries role 'owner'
 *           → Storage hands over every KYC document in the business
 *
 * Today `firestore.rules` prevents the first step: `partnerSelfRegistration()`
 * pins `role` to 'agency' or 'seller', binds the document to a partner record
 * already naming the caller's verified email, and no update clause anywhere
 * lets a holder touch `role`, `agencyId`, `status`, `isActive` or
 * `permissions`. That is good, and it is not enough — it makes Storage
 * authorisation depend on a rules file staying correct forever, in a different
 * language, reviewed by different people.
 *
 * So this module refuses structurally instead. `partnerClaimFrom` can only
 * ever emit 'agency' or 'seller'. There is no input — no role string, no
 * injected config, no future `crmUsers` field — that makes it return an
 * internal role, because the internal roles are not in the map it reads from.
 * Internal claims are set by the API alone, from the Mongo `staff` row, which
 * no client can write. Two authorities, each for the identities it actually
 * owns, and the client-writable one cannot reach the privileged vocabulary.
 *
 * `observer` could not come from here even if we wanted it to:
 * `crm_directory.NOT_MIRRORED` records that an observer deliberately has no
 * `crmUsers` document at all.
 *
 * ── THE VOCABULARY IS THE BACKEND'S ──────────────────────────────────────────
 *
 * The claim carries a `backend/app/core/roles.py` `Role` value, not the CRM's
 * spelling. The two differ: `Role.OWNER` is "owner" there and "superadmin" in
 * `crmUsers` (see `crm_directory.CRM_ROLE`). Having one vocabulary in the
 * token means `storage.rules` never has to know about the mapping, and the
 * two external values — 'agency' and 'seller' — are spelled the same in both,
 * so this file needs no translation table.
 */

/**
 * The only roles this module may ever put in a token.
 *
 * A lookup from the `crmUsers` spelling to the claim spelling, so the emitted
 * value is looked up rather than copied. A role that is not a key here
 * produces no claim — that is the escalation guard, and it is why this is not
 * `role.startsWith(...)` or a denylist.
 *
 * A `Map`, NOT an object literal, and that is not style. With a plain object,
 * `PARTNER_CLAIM_ROLE['constructor']` resolves up the prototype chain and
 * returns `Object` — truthy — so a client writing `role: 'constructor'` into
 * its own `crmUsers` document got a claim emitted with a FUNCTION as the role.
 * `'constructor' in obj` is true for the same reason, which also made
 * `isApiOwnedRole` answer false for it. Caught by the prototype-keys test
 * below. A Map has no prototype keys, so both questions have one answer.
 */
const PARTNER_CLAIM_ROLE: ReadonlyMap<string, string> = new Map([
  ['agency', 'agency'],
  ['seller', 'seller'],
])

/** What a Storage rule reads off the token. */
export interface StorageClaim {
  /** A `backend/app/core/roles.py` Role value. */
  role: string
  /** The agency this login is scoped to, or '' — never undefined. */
  aid: string
}

/** The shape this module needs out of a `crmUsers` document. */
export interface CrmUserDoc {
  role?: unknown
  agencyId?: unknown
  isActive?: unknown
  /**
   * Per-capability decision state on a login that can hold two — written by
   * `partner_ops._mirror_login_status` as `{agency: 'approved', seller: ...}`.
   * Read so that revoking ONE capability withdraws ITS claim even though the
   * login (and its other capability) stays active.
   */
  roleStatus?: unknown
  /** The capabilities this login holds, e.g. `['agency', 'seller']`. */
  roles?: unknown
}

/**
 * Per-capability states that mean the capability is no longer held.
 * `pending` and `approved` keep the claim (a pending applicant must still be
 * able to upload KYC — see `partnerClaimFrom`).
 */
const WITHDRAWN = new Set(['revoked', 'rejected', 'suspended'])

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Is this a role the API owns? Used to decide whether to keep hands off an
 * existing claim, NOT to grant anything — nothing in this file grants these.
 *
 * Covers both vocabularies on purpose. 'superadmin' is how `crmUsers` spells
 * an owner and 'owner' is how the token does; a uid carrying either is one the
 * API is managing, and this trigger must not touch it.
 */
export function isApiOwnedRole(role: string): boolean {
  const r = text(role)
  if (r === '') return false
  return !PARTNER_CLAIM_ROLE.has(r)
}

/**
 * The claim a `crmUsers` document earns, or `null` for "no partner claim".
 *
 * `null` means two different things to the caller and deliberately does not
 * distinguish them: either this is not a partner, or it is a partner whose
 * access has been withdrawn. Both end with the partner claim absent.
 *
 * ── WHY `isActive` AND NOT `status` ──────────────────────────────────────────
 *
 * An agency sits at `status: 'pending'` from signup until a superadmin
 * approves it, and during exactly that window it has to upload its own KYC —
 * that is what the approval is waiting for. Gating on approval would deadlock
 * onboarding. `isActive !== false` is the same test `firestore.rules`'
 * `isCrmUser()` already applies, so this grants no more than Firestore does,
 * and absent reads as active for documents written before the field existed.
 */
export function partnerClaimFrom(doc: CrmUserDoc | null | undefined): StorageClaim | null {
  if (!doc) return null
  if (doc.isActive === false) return null

  // ── ONE CAPABILITY WITHDRAWN, THE OTHER STILL HELD ─────────────────────
  //
  // `isActive` is per LOGIN, and since revocation it stays true while any
  // capability is live — revoking the Agency from an Agency + Coin Seller
  // human must not switch off their seller access. So `isActive` alone can no
  // longer withdraw an agency claim: the per-capability `roleStatus` does.
  // The primary `role` is honoured unless its own status is withdrawn; then
  // the other capability the login holds is used, if IT is still live;
  // otherwise there is no partner claim. `aid` travels only with `agency` —
  // a seller claim never carries an agency scope.
  const statuses = (doc.roleStatus && typeof doc.roleStatus === 'object')
    ? doc.roleStatus as Record<string, unknown>
    : {}
  // Phase 1A (role-revocation leak): an ALLOWLIST. Any explicit per-role
  // status other than approved/pending — including one this build does not
  // know — withdraws the capability, rather than only the three named values.
  const withdrawn = (cap: string) => {
    const st = text(statuses[cap])
    return WITHDRAWN.has(st) || (st !== '' && st !== 'approved' && st !== 'pending')
  }

  const primary = text(doc.role)
  if (!PARTNER_CLAIM_ROLE.has(primary)) return null
  const held = Array.isArray(doc.roles) ? doc.roles.map(text) : []
  const candidates = [primary, ...['agency', 'seller'].filter(
    (c) => c !== primary && (held.includes(c) || text(statuses[c]) !== ''),
  )]

  for (const cap of candidates) {
    const role = PARTNER_CLAIM_ROLE.get(cap)
    if (!role || withdrawn(cap)) continue
    return { role, aid: role === 'agency' ? text(doc.agencyId) : (cap === primary ? text(doc.agencyId) : '') }
  }
  return null
}

/** Do two claims say the same thing? Used to skip no-op `setCustomUserClaims`. */
export function sameClaim(
  a: StorageClaim | null | undefined,
  b: StorageClaim | null | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.role === b.role && a.aid === b.aid
}

/**
 * The decision, as data, so it can be tested without a Firebase app.
 *
 * `existing` is what the token carries now; `doc` is the `crmUsers` document
 * as committed. Returns the action the trigger should take.
 */
export type ClaimAction =
  | { kind: 'none'; why: string }
  | { kind: 'set'; claim: StorageClaim }
  | { kind: 'clear' }

/**
 * The whole handler, minus Firebase.
 *
 * `index.ts` supplies a two-method adapter over `admin.auth()`. Everything
 * else — the decision, the merge that preserves unrelated claims, the
 * no-op skip — happens here, so the behaviour the trigger actually has can be
 * driven through its real code path in a test rather than approximated by
 * calling `decideClaim` and trusting the wiring around it.
 *
 * Returns what it did, for the log and for the test.
 */
export async function syncClaim(
  uid: string,
  doc: CrmUserDoc | null | undefined,
  auth: {
    getClaims(uid: string): Promise<Record<string, unknown> | null>
    setClaims(uid: string, claims: Record<string, unknown>): Promise<void>
  },
): Promise<{ action: string; why?: string; claim?: StorageClaim }> {
  let existing: Record<string, unknown>
  try {
    existing = (await auth.getClaims(uid)) ?? {}
  } catch (err) {
    // No auth account behind this document — a `crmUsers` row whose login was
    // discarded mid-signup. Nothing to stamp, and not an error worth throwing:
    // a throw here would make the trigger retry forever on a row that will
    // never have a user.
    return { action: 'skipped', why: `no auth user (${String(err)})` }
  }

  const decision = decideClaim(doc, existing as { role?: unknown; aid?: unknown })
  if (decision.kind === 'none') return { action: 'none', why: decision.why }

  // Preserve claims this module does not own. `setCustomUserClaims` REPLACES
  // the whole object, so writing `{role, aid}` alone would silently drop a
  // claim set by something else.
  const rest = { ...existing }
  delete rest.role
  delete rest.aid
  // P1-A3b: `mfa_sid` is a per-session developer claim (Owner MFA custom-token
  // sign-in). An account-wide claim of that name would apply to every sign-in
  // of the account, so it is never carried forward here.
  delete (rest as Record<string, unknown>).mfa_sid

  if (decision.kind === 'clear') {
    await auth.setClaims(uid, rest)
    return { action: 'cleared' }
  }
  await auth.setClaims(uid, { ...rest, ...decision.claim })
  return { action: 'set', claim: decision.claim }
}

export function decideClaim(
  doc: CrmUserDoc | null | undefined,
  existing: { role?: unknown; aid?: unknown } | null | undefined,
): ClaimAction {
  const existingRole = text(existing?.role)

  // The API owns this uid. Staff claims are set from the Mongo `staff` row and
  // this trigger has no business overwriting or clearing one — a `crmUsers`
  // write for a member of staff (a phone number edit, a `lastLoginAt` touch)
  // must not cost them their access.
  if (isApiOwnedRole(existingRole)) {
    return { kind: 'none', why: `claim role '${existingRole}' is managed by the API` }
  }

  const wanted = partnerClaimFrom(doc)
  const current: StorageClaim | null = existingRole
    ? { role: existingRole, aid: text(existing?.aid) }
    : null

  if (sameClaim(wanted, current)) {
    return { kind: 'none', why: 'already correct' }
  }
  return wanted ? { kind: 'set', claim: wanted } : { kind: 'clear' }
}
