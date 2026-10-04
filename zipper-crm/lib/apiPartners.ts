'use client'

/**
 * Partner operations client — onboarding, inventory, credit and commission.
 *
 * `lib/api.ts` owns the session, the error type and the money board. This file
 * owns everything under `/partner-ops`, plus the partner reads the CRM screens
 * need in a fuller shape than the generic client exposes (an overdue seller's
 * due date, a seller's credit due date, a card's raw payload).
 *
 * Two rules carry through every call here:
 *
 *   * Onboarding decisions — approve, reject, deactivate — are a team decision
 *     and take effect immediately. They move no money.
 *   * Everything that moves money raises a **card**. The request functions
 *     below create the card; nothing moves until an owner signs it on /board
 *     and the matching `execute…` call runs. A screen that calls `request…`
 *     has not moved anything, and must say so.
 *
 * Nothing is hidden on the client because it might be refused. The API refuses
 * with a message written to be shown, and the screens show it.
 */

import {
  ApiError, getSessionToken, reportUnauthorized,
  type Appeal, type UserReport,
} from '@/lib/api'

// Mirrors lib/api.ts — in production the API is same-origin via a Hosting
// rewrite, locally it runs on its own port.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

// ── Core request ──────────────────────────────────────────────────────────────

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...((options.headers as Record<string, string>) ?? {}),
      },
    })
  } catch (err) {
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0,
      err,
    )
  }

  if (response.status === 204) return undefined as T

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const detail =
      (body as { detail?: unknown } | null)?.detail ?? body ?? response.statusText
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail
              .map((d: { loc?: string[]; msg?: string }) =>
                `${d.loc?.slice(1).join('.') ?? ''} ${d.msg ?? ''}`.trim(),
              )
              .join('; ')
          : 'Request failed'
    // This client used to do nothing on a 401 — no token clear, no signal — so
    // an expired session first noticed on a partner-ops call left a token in
    // sessionStorage that the server had already rejected, and every later call
    // kept sending it. All three clients now behave identically here.
    if (response.status === 401) reportUnauthorized({ message, path })
    throw new ApiError(message, response.status, detail)
  }

  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

function query(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PartnerKind = 'agency' | 'sub_agency' | 'seller'
export type PartnerStatus = 'pending' | 'approved' | 'rejected' | 'suspended'

/** Spec 4.3.11 — `overdue` blocks the seller from taking new inventory. */
export type CreditStanding =
  | 'none'
  | 'current'
  | 'due_soon'
  | 'overdue'
  | 'written_off'

export interface PartnerCredit {
  outstanding?: number
  due_at?: string | null
  terms?: string
  total_lent?: number
  total_repaid?: number
  total_recovered?: number
  total_penalty?: number
  total_written_off?: number
}

/**
 * A partner's permanent virtual account number. Spec 4.3.4 / 8C.1.
 *
 * Returned by `GET /partner-ops/partners/{id}` and by the list, always, in one
 * of exactly two states — and **never a third**. Either `issued: true` with a
 * number the bank allocated, or `issued: false` with `reason` saying why not.
 * There is no "unknown" and no placeholder: a screen must render the reason, not
 * a blank field or a dash, because a blank reads as "we lost it".
 *
 * `bank_configured` tells the two absences apart. False means Zipper holds no
 * HDFC eCMS collection account — eCMS needs a business current account (8C.8.7)
 * and the owner is on a personal one — which is the live answer today and is
 * true of every seller. True with `issued: false` means the bank exists and
 * this partner has not been given a number yet, which is actionable.
 *
 * `issued_by` is deliberately NOT here. The server strips it before this
 * reaches a partner; who pressed the button is in the audit log.
 */
export interface VirtualAccount {
  issued: boolean
  /** null whenever `issued` is false. Never a stand-in, never an empty string. */
  number: string | null
  ifsc: string
  /** What a payer must see when they add the account as a payee. */
  beneficiary_name: string
  /** "hdfc_ecms" once it exists. Empty while it does not. */
  provider: string
  /** The real current account every VAN maps onto (8C.1.3). */
  collection_account: string
  issued_at: string | null
  /** False means there is no bank yet, not that this partner was skipped. */
  bank_configured: boolean
  /** Only when `issued` is false. Written to be shown — print it verbatim. */
  reason?: string
  /** Only when `issued` is true. What the number means for them. */
  note?: string
}

export interface Partner {
  id: string
  kind: PartnerKind
  status: PartnerStatus
  is_active: boolean
  name?: string
  email?: string
  phone?: string
  crm_id?: string
  /** Set on a sub-agency. Its money is routed through this parent. Spec 4.2.4. */
  parent_id?: string | null

  // ── The second capability ───────────────────────────────────────────────────
  // One login can hold both an agency and a coin-seller record. These name the
  // OTHER record; they never merge anything. `credit`, `total_coins_sold`,
  // `cash_paid_minor`, every balance and every statement above still belong to
  // this record alone.
  //
  //   second_role_of     set on the record that was applied for SECOND. Its
  //                      presence is what marks a row in the pending queue as a
  //                      second capability rather than a new partner.
  //   linked_partner_id  set on the record that was already held.
  //   owner_crm_uid      the single CRM login behind the two.
  second_role_of?: string | null
  linked_partner_id?: string | null
  owner_crm_uid?: string | null
  second_role_reason?: string | null
  credit?: PartnerCredit
  total_coins_sold?: number
  cash_paid_minor?: number
  rejection_reason?: string
  created_at?: string
  updated_at?: string

  /**
   * Always present on both the list and the record. Optional in the type only
   * so a cached response from before this existed does not crash a screen —
   * treat `undefined` as "not read", never as "none issued", and say so.
   */
  virtual_account?: VirtualAccount

  // Attached by GET /partner-ops/partners/{id} only.
  credit_standing?: CreditStanding
  can_take_inventory?: { allowed: boolean; reason: string }
  coins_on_hand?: number
  commission_outstanding?: number
}

export type CardStage =
  | 'requested'
  | 'under_review'
  | 'awaiting_signoff'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'failed'

export interface CardWho {
  uid: string
  name: string
  role: string
  team: string | null
}

/** An earlier card carrying the same payment reference. */
export interface DuplicateRef {
  card_id: string
  type: string
  stage: string
  amount: number
  subject_id: string
  created_at: string
}

/**
 * A card as the partner screens read it.
 *
 * `payload` is left open because each card type carries its own facts; the
 * readers below pull out the ones these screens rely on.
 */
export interface PartnerCard {
  id: string
  type: string
  team: string
  title: string
  amount: number
  currency: string
  reason: string
  subject: { type: string; id: string }
  payload: Record<string, unknown>
  evidence: { kind?: string; label?: string; url?: string }[]
  stage: CardStage
  requested_by: CardWho
  created_at: string
  updated_at: string
  verified_by: CardWho | null
  verified_at: string | null
  verification_note: string | null
  signed_by: CardWho | null
  signed_at: string | null
  executed_at: string | null
  execution_result: Record<string, unknown> | null
  rejected_by: CardWho | null
  rejected_at: string | null
  rejection_reason: string | null
  /** Set by the API when the payment reference has been seen before. */
  warning?: string
}

export interface CreditExposure {
  total_outstanding: number
  sellers_with_credit: number
  total_sellers: number
}

export interface OverdueSeller {
  id: string
  name: string
  outstanding: number
  due_at: string | null
  days_overdue: number | null
}

export interface SellerStatement {
  seller_id: string
  name: string
  coins_purchased: number
  coins_lent: number
  coins_sold: number
  coins_on_hand: number
  cash_paid_minor: number
  credit_outstanding: number
  credit_standing: CreditStanding
  credit_due_at: string | null
  entries: Record<string, unknown>[]
}

/**
 * One movement on a seller's account, whatever kind of movement it is.
 *
 * Transcribed from `backend/app/services/partners.py::_row`. The two numeric
 * columns are deliberately separate and a single "amount" would have to choose
 * between them:
 *
 *   * `coins` is signed against the seller's **stock** — what they hold.
 *   * `owed_delta` is signed against what they **owe** us.
 *
 * A repayment is the case that proves the split, and it is the movement that
 * used to be invisible: `coins` 0, `owed_delta` negative, `amount_minor` real.
 * `execute_repayment` writes no ledger row at all, so it can never appear in
 * the coin statement — the server reads it from the card and the credit
 * history instead.
 *
 * `amount_minor` is **paise** and is never negative; `money` says which way it
 * went, so nothing has to infer a direction from a sign. Divide by 100 exactly
 * once, with `inr()` / `inrExact()` below.
 *
 * `settled` is the difference between a decision and a movement. A card signed
 * and not executed has changed nothing, and rendering it like an executed one
 * tells both sides money has moved that has not. The server excludes unsettled
 * rows from every total for the same reason.
 */
export interface SellerHistoryRow {
  /** ISO. `executed_at` where there is one, else when it was asked for. */
  at: string | null
  kind:
    | 'coin_purchase'
    | 'lending_issue'
    | 'repayment'
    | 'recovery'
    | 'write_off'
    | 'sale'
    | 'movement'
  /** The server's own label for this kind. Print it; do not re-map it. */
  what: string
  /** Signed against stock. Zero on a repayment, which moves none. */
  coins: number
  /** Signed against the debt. Negative clears it. */
  owed_delta: number
  /** Paise, never negative. */
  amount_minor: number
  money: 'seller_paid_zipper' | 'buyer_paid_seller' | 'none'
  /** UTR or transaction id. Empty when the movement genuinely carries none. */
  reference: string
  proof_url: string
  /** The buyer's uid on a sale; "Zipper" on everything between us and them. */
  counterparty: string
  card_id: string | null
  /** A `CardStage` on a card row, a sale status on a sale row. */
  card_stage: string | null
  /** False means nothing has moved yet. Excluded from every total. */
  settled: boolean
  reason: string
  source: 'card' | 'credit_history' | 'sale' | 'ledger'
  /** What the card asked for, which a recovery need not have got. */
  requested_coins?: number
  due_at?: string | null
  penalty_coins?: number
  title?: string
  action?: string
  sale_id?: string
}

/** The period summary — "how much business have I done with this person". */
export interface SellerHistoryTotals {
  coins_bought: number
  /** Paise they paid us for inventory, in this window. */
  rupees_paid_minor: number
  coins_sold: number
  /** Paise they took from buyers, in this window. Never touches us. */
  rupees_taken_minor: number
  coins_lent: number
  coins_repaid: number
  coins_recovered: number
  coins_written_off: number
  movements: number
  settled_movements: number
  /** Raised and not executed. Nothing has moved on these. */
  pending_movements: number
  pending_coins: number
  pending_rupees_minor: number
  /** Rejected or failed — neither business done nor business in flight. */
  refused_movements: number
}

export interface SellerHistory {
  seller_id: string
  name: string
  period_from: string | null
  period_to: string | null
  rows: SellerHistoryRow[]
  totals: SellerHistoryTotals
  /** What was read and whether each source hit its cap. Never hide a cut. */
  sources: {
    ledger_entries: number
    cards: number
    credit_events: number
    sales: number
    fetch_limit: number
    ledger_capped: boolean
    cards_capped: boolean
    sales_capped: boolean
  }
  /** True when more rows matched the window than the limit returned. */
  truncated: boolean
  note: string
}

// ── The commission derivation, exactly as the engine returns it ───────────────
//
// Every shape below is transcribed from the server, not guessed from a name:
//
//   backend/app/services/commission.py:159  Band.as_dict()
//   backend/app/services/commission.py:391  commission_for() → breakdown
//   backend/app/services/commission.py:537  SlabTable.as_dict()
//   backend/app/services/commission.py:823  agency_billing()
//   backend/app/services/commission.py:941  compute_for_period()
//
// Two units live side by side in that payload. `*_minor` is integer paise and is
// what this CRM formats; `*_inr` is the same figure already divided by 100 for
// readers who want it. The screens use the `_minor` fields ONLY, so there is
// exactly one division by 100 in the whole page — `inr()` / `inrExact()` below.
// Mixing the two is how a figure silently becomes a hundred times itself.

/** One slab. Bounds in paise; `to_minor` is null on the open-ended top band. */
export interface CommissionBand {
  index: number
  from_minor: number
  /** null on the top band — it is open-ended whatever its configured `to` says. */
  to_minor: number | null
  from_inr: number
  to_inr: number | null
  /** "7.5", already trimmed for a human. Not a number — do not do maths on it. */
  rate_percent: string
  rate_basis_points: number
  open_ended: boolean
  declared_from_inr: number
  declared_to_inr: number
  /** Server-written, Indian-grouped: "₹25,001.00 – ₹75,000.00 @ 5%". */
  label: string
}

/**
 * Which band was chosen and why.
 *
 * `matched: false` is the floor case and is a REAL answer — billing below the
 * lowest band's lower bound earns nothing. It is not a failure, and it is not
 * the same as `commission_basis_error`.
 */
export interface CommissionBreakdown {
  billing_minor: number
  billing_inr: number
  /** The rule in plain English. Show it verbatim — spec 0.1.5. */
  rule: string
  rounding: string
  floor_minor: number
  floor_inr: number
  bands_considered: CommissionBand[]
  matched: boolean
  band: CommissionBand | null
  rate_percent: string
  rate_basis_points: number
  commission_minor: number
  commission_inr: number
  effective_rate_percent: string
  /** One sentence naming the billing, the band and the result. */
  explanation: string
}

/** One host's contribution to the agency's billing for the period. */
export interface CommissionBillingHost {
  host_id: string
  beans_cashed_out: number
  billing_minor: number
  movements: number
  last_at: string | null
}

/** That host's slice of the one agency-level commission figure. */
export interface CommissionHostShare extends CommissionBillingHost {
  share_minor: number
  share_inr: number
  /** Why this host's share is this size. The band was chosen by the total. */
  share_note: string
}

export interface CommissionBilling {
  agency_id: string
  since: string
  until: string
  /** "[since, until) — start inclusive, end exclusive". */
  bounds: string
  /** What "billing" means here. Cash-outs, not credits. */
  definition: string
  basis: string
  beans_cashed_out: number
  billing_minor: number
  billing_inr: number
  bean_to_inr: number
  bean_rate_note: string
  bean_rate_provisional: boolean
  hosts: CommissionBillingHost[]
  host_count: number
  /** Earned but not yet cashed out — bills in the period it is actually paid. */
  beans_earned_not_cashed_out: number
  warnings: string[]
}

export interface CommissionSlabTable {
  /** "main" | "sub" — a sub-agency has its own table and its own floor. */
  kind: string
  config_key: string
  /** "firestore" | "fallback". */
  source: string
  /** True when the live table could not be read and the documented one was used. */
  provisional: boolean
  note: string
  fetched_at: string
  floor_minor: number
  floor_inr: number
  bands: CommissionBand[]
}

/**
 * The whole derivation for one period: what the hosts cashed out, which band
 * that selects, the rate, the commission, and each host's share.
 *
 * Attached to the statement as `commission_basis`. Null only when the
 * derivation could not be run, in which case `commission_basis_error` says why
 * — see backend/app/services/partners.py:131.
 */
export interface CommissionBasis {
  agency_id: string
  agency_name: string
  agency_kind: string
  /** "custom" when both since and until were given, else an ISO week label. */
  period: string
  since: string
  until: string
  currency_unit: string
  billing: CommissionBilling
  slab_table: CommissionSlabTable
  breakdown: CommissionBreakdown
  commission_minor: number
  commission_inr: number
  hosts: CommissionHostShare[]
  warnings: string[]
  provisional: boolean
}

/**
 * One movement on the commission balance.
 *
 * `entries` is a list of raw ledger documents; these are the fields
 * `apply_movement` writes (backend/app/services/money.py:135). Optional
 * throughout because the statement hands them back untouched, and a screen must
 * not assume a field it did not check for.
 */
export interface LedgerEntry {
  id?: string
  at?: string
  /** Positive credits, negative debits. Minor units for a commission balance. */
  amount?: number
  balance_before?: number
  balance_after?: number
  action?: string
  reason?: string
  actor?: { uid?: string; name?: string; role?: string }
  card_id?: string | null
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface AgencyStatement {
  agency_id: string
  name: string
  /** Minor units (paise). Summed from the entries in the requested window. */
  commission_earned: number
  commission_paid: number
  /** The LIVE balance — always all-time, never scoped to the window. */
  commission_outstanding: number
  host_count: number
  period_from: string | null
  period_to: string | null
  entries: LedgerEntry[]
  /** Null when the derivation could not be run — read the error, never zero. */
  commission_basis: CommissionBasis | null
  commission_basis_error: string | null
  /** commission.RULE — the flat-rate-by-band rule, in plain English. */
  commission_rule: string
}

/** Per-host earnings. Beans CREDITED, which is a different basis from billing. */
export interface AgencyHostRow {
  host_id: string
  beans_earned: number
  movements: number
  last_earned_at: string | null
}

export interface SubAgency {
  id: string
  name: string
  status: PartnerStatus
  /**
   * The sub's own outstanding commission balance, in minor units.
   *
   * It falls to zero the moment leg 1 executes — that debit lands on the SUB's
   * balance (backend/app/services/partner_ops.py:2661), not the parent's. So a
   * zero here means "Zipper has paid the parent", not "the sub has been paid".
   */
  owed_by_parent: number
}

// ── Payload readers ───────────────────────────────────────────────────────────
// A card payload is untyped on the wire. These keep the `unknown` casts in one
// place instead of scattering them through the screens.

export function num(payload: Record<string, unknown>, key: string): number {
  const v = payload[key]
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

export function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** The earlier cards that already used this card's payment reference. */
export function duplicatesOf(card: PartnerCard): DuplicateRef[] {
  const raw = card.payload?.duplicate_of
  if (!Array.isArray(raw)) return []
  return raw.filter((d): d is DuplicateRef => !!d && typeof d === 'object')
}

/** The payment proof image, from the evidence list or the payload. */
export function proofUrl(card: PartnerCard): string {
  const evidence = card.evidence?.find(
    (e) => e.kind === 'payment_proof' || !!e.url,
  )
  return evidence?.url ?? str(card.payload ?? {}, 'evidence_url')
}

// ── Onboarding — team decisions, no owner signature. Spec 3.3.3 / 9.2 ─────────

export const partnerOps = {
  list: (params: { kind?: PartnerKind; status?: PartnerStatus; limit?: number } = {}) =>
    get<Partner[]>(
      `/partner-ops/partners${query({
        kind: params.kind,
        status: params.status,
        limit: params.limit ?? 200,
      })}`,
    ),

  /** One partner, with live credit standing and balance attached. */
  get: (id: string) => get<Partner>(`/partner-ops/partners/${encodeURIComponent(id)}`),

  /**
   * Create the business record behind an agency or seller that exists in
   * Firestore and has none — the retry for a registration that failed.
   *
   * In the normal case nobody calls this from a browser. The Firestore triggers
   * `registerAgencyPartner` / `registerSellerPartner` register every new partner
   * the moment its document is written, and this screen never sees them. This is
   * the manual path for when that call could not be made — the API was
   * unreachable, or the two sides of the credential had drifted — which is
   * recorded as `partnerRecordFailed: true` on the Firestore document and
   * surfaced by `<FailedRegistrations />`.
   *
   * **Creates nothing but an empty record.** Zero coins, zero credit, zero
   * commission, zero cash, status `pending`, inactive. It is not an approval and
   * it grants nothing; the Approve button is still a separate decision with its
   * own mandatory reason. Calling it twice is a no-op — the response says
   * `created: false` and nothing about the existing record is touched.
   *
   * Requires a team admin, the same authority the route has always had.
   */
  create: (id: string, reason: string) =>
    post<Partner & { created: boolean; warnings?: string[]; note?: string }>(
      '/partner-ops/partners',
      { partner_id: id, reason },
    ),

  approve: (id: string, reason: string) =>
    post<Partner>(`/partner-ops/partners/${encodeURIComponent(id)}/approve`, { reason }),

  /**
   * Give an existing partner their second capability — an agency that should
   * also sell coins, or the reverse.
   *
   * **Not the same as creating one on `/agencies/register`.** That refuses an
   * address that already holds a record, and otherwise builds a separate
   * business with a separate login — so the partner's own login gains nothing
   * and they keep being told they are under review. This attaches the new
   * capability to the login they already have.
   *
   * Grants nothing. The record comes back `pending` and is approved through the
   * ordinary queue, which is where somebody checks the documents and the bank
   * account it will be paid into.
   */
  grantCapability: (
    id: string,
    body: { kind: 'agency' | 'seller'; name: string; phone: string; reason: string },
  ) =>
    post<Partner & { note?: string; warnings?: string[] }>(
      `/partner-ops/partners/${encodeURIComponent(id)}/grant-capability`,
      body,
    ),

  /**
   * Issue an approved seller's permanent virtual account number. Spec 4.3.4.
   *
   * **The normal path is approval, not this.** Approving a seller issues one in
   * the same flow, which is what 8C.1.4 says. This is the backfill for sellers
   * approved before the bank account existed — approval is not run twice, so
   * without it they would never get a number.
   *
   * **It refuses today, and the refusal is the answer to show.** Virtual
   * accounts need an HDFC eCMS collection account, and eCMS needs a business
   * current account (8C.8.7) which Zipper does not hold. `ApiError.message`
   * carries that sentence — print it rather than paraphrasing it.
   *
   * Refused too for a partner who already holds one: a VAN is permanent and
   * reissuing would orphan every standing instruction pointing at the first.
   */
  issueVirtualAccount: (id: string, reason: string) =>
    post<VirtualAccount>(
      `/partner-ops/partners/${encodeURIComponent(id)}/virtual-account`,
      { reason },
    ),

  /**
   * Bring an approved partner's application for the OTHER capability into the
   * queue — an agency applying to also sell coins, or a seller to also run an
   * agency.
   *
   * `id` is the record they already hold; `newPartnerId` is the Firestore
   * document id of the one they applied for. The second record is created here
   * **holding nothing** and `pending`, so it appears on this screen like any
   * other application and is approved with the same Approve button, against the
   * same mandatory reason.
   *
   * It has to be filed by staff rather than by the applicant because an
   * external partner holds no API session at all: `sign_in_with_firebase`
   * resolves a role from the Mongo `staff` collection and refuses anyone who is
   * not in it, and nothing writes an agency or seller into that collection.
   */
  requestSecondRole: (id: string, newPartnerId: string, reason: string) =>
    post<Partner & { note?: string; owner_crm_uid?: string }>(
      `/partner-ops/partners/${encodeURIComponent(id)}/second-role`,
      { new_partner_id: newPartnerId, reason },
    ),

  /** The reason is stored on the record and shown to the applicant. */
  reject: (id: string, reason: string) =>
    post<Partner>(`/partner-ops/partners/${encodeURIComponent(id)}/reject`, { reason }),

  /**
   * Apply or refuse a change an agency or seller PROPOSED to their own record.
   *
   * **This is the only way those fields can move, and that is deliberate.** An
   * approved partner used to be able to replace their own bank account from
   * their dashboard: the write went straight onto the live record, `status`
   * stayed `approved`, and every review queue keys off `status` — so the new
   * account was live and nobody ever looked. `firestore.rules` now refuses a
   * partner every payout and identity field; what they may write is a
   * proposal, and the live field does not move until this call is made.
   *
   * Approving writes the proposed values and clears the proposal. Refusing
   * clears it, leaves every live field exactly as it was, and stores the reason
   * on the document so the partner is told why instead of proposing the same
   * change again.
   *
   * **The proposer cannot be the approver** — the API refuses when the two uids
   * match, and says so in a sentence written to be shown.
   *
   * `refused` in the response names anything in the proposal the server would
   * not write. A proposal is data a browser put there and Firestore does not
   * constrain its contents, so the server keeps its own allow-list; the list is
   * normally empty and a non-empty one is worth looking into rather than
   * dismissing.
   */
  decidePendingChanges: (id: string, approve: boolean, reason: string) =>
    post<{
      partner_id: string
      collection: string
      applied?: string[]
      refused: string[]
      audit_id: string
      note: string
    }>(
      `/partner-ops/partners/${encodeURIComponent(id)}/pending-changes/decide`,
      { approve, reason },
    ),

  deactivate: (id: string, reason: string) =>
    post<Partner>(`/partner-ops/partners/${encodeURIComponent(id)}/deactivate`, { reason }),

  reactivate: (id: string, reason: string) =>
    post<Partner>(`/partner-ops/partners/${encodeURIComponent(id)}/reactivate`, { reason }),
}

// ── Seller inventory. Spec 4.3.5 / 4.3.6 ─────────────────────────────────────

export const inventory = {
  /**
   * Raise a coin purchase card. Nothing is credited here — an owner signs on
   * /board, then `executeCoinPurchase` credits the inventory.
   *
   * If the payment reference has been used before the card is still raised,
   * carrying `duplicate_reference` and `duplicate_of` so the owner sees the
   * earlier cards before signing rather than after.
   */
  requestCoinPurchase: (
    sellerId: string,
    body: {
      coins: number
      amount_paid_minor: number
      payment_ref: string
      evidence_url?: string
      reason: string
    },
  ) =>
    post<PartnerCard>(
      `/partner-ops/sellers/${encodeURIComponent(sellerId)}/coin-purchases`,
      { evidence_url: '', ...body },
    ),

  /** Every card already carrying this reference. Run it before raising. */
  paymentReferenceHistory: (paymentRef: string) =>
    get<DuplicateRef[]>(
      `/partner-ops/payment-references/${encodeURIComponent(paymentRef)}`,
    ),

  /** Owner only. This is the call that credits real inventory. */
  executeCoinPurchase: (cardId: string) =>
    post<PartnerCard>(`/partner-ops/coin-purchases/${encodeURIComponent(cardId)}/execute`),
}

// ── Seller credit. Spec 4.3.7 / 4.3.10–4.3.17 ────────────────────────────────

export const lending = {
  /** A due date is required — credit without one is a gift. */
  request: (
    sellerId: string,
    body: { coins: number; due_at: string; terms?: string; reason: string },
  ) =>
    post<PartnerCard>(`/partner-ops/sellers/${encodeURIComponent(sellerId)}/lending`, {
      terms: '',
      ...body,
    }),

  execute: (cardId: string) =>
    post<PartnerCard>(`/partner-ops/lending/${encodeURIComponent(cardId)}/execute`),

  requestRepayment: (
    sellerId: string,
    body: { coins: number; payment_ref?: string; reason: string },
  ) =>
    post<PartnerCard>(`/partner-ops/sellers/${encodeURIComponent(sellerId)}/repayments`, {
      payment_ref: '',
      ...body,
    }),

  executeRepayment: (cardId: string) =>
    post<PartnerCard>(`/partner-ops/repayments/${encodeURIComponent(cardId)}/execute`),

  /**
   * `penalty_coins` is legitimate and may take the total above the original
   * debt (4.3.14). Recovery takes what the balance holds; any shortfall stays
   * an open receivable (4.3.16).
   */
  requestRecovery: (
    sellerId: string,
    body: { coins: number; penalty_coins?: number; reason: string },
  ) =>
    post<PartnerCard>(`/partner-ops/sellers/${encodeURIComponent(sellerId)}/recoveries`, {
      penalty_coins: 0,
      ...body,
    }),

  executeRecovery: (cardId: string) =>
    post<PartnerCard>(`/partner-ops/recoveries/${encodeURIComponent(cardId)}/execute`),

  /** A write-off is a loss, not an adjustment. Owner signature required. */
  requestWriteOff: (partnerId: string, body: { coins: number; reason: string }) =>
    post<PartnerCard>(`/partner-ops/partners/${encodeURIComponent(partnerId)}/write-off`, body),

  executeWriteOff: (cardId: string) =>
    post<PartnerCard>(`/partner-ops/write-offs/${encodeURIComponent(cardId)}/execute`),
}

// ── Agency commission ─────────────────────────────────────────────────────────

export const commission = {
  requestPayout: (agencyId: string, body: { amount_minor: number; reason: string }) =>
    post<PartnerCard>(
      `/partner-ops/agencies/${encodeURIComponent(agencyId)}/commission-payouts`,
      body,
    ),

  executePayout: (cardId: string, paymentRef: string) =>
    post<PartnerCard>(
      `/partner-ops/commission-payouts/${encodeURIComponent(cardId)}/execute`,
      { payment_ref: paymentRef },
    ),

  /** Money reaches a sub-agency through its parent, never directly. Spec 4.2.4. */
  requestSubAgencyPayout: (body: {
    parent_id: string
    sub_id: string
    amount_minor: number
    reason: string
  }) =>
    post<{ card: PartnerCard; payout: Record<string, unknown>; payout_id: string }>(
      '/partner-ops/subagency-payouts',
      body,
    ),

  openSubAgencyPayouts: () =>
    get<Record<string, unknown>[]>('/partner-ops/subagency-payouts/open'),

  /** Leg 2 — the parent confirms it passed the money on. The payout closes. */
  confirmSubAgencyLeg: (payoutId: string, reason: string) =>
    post<Record<string, unknown>>(
      `/partner-ops/subagency-payouts/${encodeURIComponent(payoutId)}/confirm-leg`,
      { reason },
    ),
}

// ── Reads: statements, exposure, the recovery worklist ────────────────────────

/**
 * `me` resolves to the caller's own partner record.
 *
 * `own_partner_id_or_403` (backend/app/core/deps.py:157) accepts the literal
 * `"me"` from an external account and swaps in whatever the session holds. A
 * partner screen should use it rather than an id copied out of Firestore: if
 * the two ever disagree, the id from Firestore is a 403 and `me` is right.
 *
 * Two things about it are not obvious and both matter here:
 *
 *   * It is only unambiguous on a route that declares a `kind`. The three
 *     agency routes under `/partners/agencies/…` pass `kind="agency"`, so `me`
 *     means the agency record even for a login that also sells coins. The
 *     generic `GET /partner-ops/partners/{id}` deliberately leaves `kind` open
 *     — it serves both records — so `me` there is a **400** for a dual-role
 *     login. Fetch that one by the concrete id an agency route resolved.
 *   * A partner whose session carries no approved record at all — an applicant
 *     still under review — is refused with a sentence written to be shown:
 *     "This account has no approved partner record, so there is nothing to show
 *     yet." That refusal is the pending state, and it is the whole answer.
 *
 * Staff must NOT use it: for an internal role the id is passed through as
 * written, and there is no partner called "me".
 */
export const OWN_RECORD = 'me'

export const statements = {
  /**
   * Reports filed against this agency's hosts.
   *
   * A route rather than a security rule, and for a structural reason: a report
   * carries a `targetUid` and nothing about agencies, so "is this one of mine"
   * is a question about the USER document it points at. A rule would need a
   * `get()` per row and would still not satisfy a list query. The server
   * resolves the roster first, then fetches reports by uid — and pins the
   * agency to its own id, so asking for somebody else's is a 403.
   */
  agencyHostReports: (id: string, limit = 200) =>
    get<UserReport[]>(
      `/partners/agencies/${encodeURIComponent(id)}/host-reports?limit=${limit}`,
    ),

  /** Appeals this agency raised, and what became of them. */
  agencyAppeals: (id: string, limit = 100) =>
    get<Appeal[]>(
      `/partners/agencies/${encodeURIComponent(id)}/appeals?limit=${limit}`,
    ),

  seller: (id: string) =>
    get<SellerStatement>(`/partners/sellers/${encodeURIComponent(id)}/statement`),

  /**
   * Every movement involving one seller, in one time-ordered list.
   * backend/app/routers/partners.py → services/partners.py::seller_history.
   *
   * The same route answers the owner looking at a seller and the seller looking
   * at themselves, which is the point of it: two screens reading one endpoint
   * cannot end up disagreeing about what happened. `own_partner_id_or_403`
   * pins a partner to their own record, so a seller may pass `OWN_RECORD`.
   *
   * It is not `seller()` with extra fields — it answers three things that one
   * structurally cannot:
   *
   *   * **repayments.** `execute_repayment` writes no coin movement, so a
   *     repayment is in the coin statement at no limit and in no period. Here
   *     it arrives from the card and the credit history, with its UTR.
   *   * **rupees per movement.** The amount and the reference are on the card;
   *     `cash_paid_minor` on the record is one lifetime counter that cannot be
   *     scoped to a window at all.
   *   * **sales**, with the buyer and what the seller took for the coins.
   *
   * `since` / `until` are ISO and bound both the rows **and** every total —
   * unlike `agency()` beside it, the filter runs on the server before the limit
   * rather than after it, so a window is a window.
   */
  sellerHistory: (
    id: string,
    params: { since?: string; until?: string; limit?: number } = {},
  ) =>
    get<SellerHistory>(
      `/partners/sellers/${encodeURIComponent(id)}/history${query({
        since: params.since,
        until: params.until,
        limit: params.limit,
      })}`,
    ),

  /**
   * Commission earned, paid and outstanding, with the ledger and the derivation.
   * backend/app/routers/partners.py:44 → services/partners.py:82.
   *
   * `since` / `until` filter the entries the earned and paid totals are summed
   * from — but the filter runs AFTER `limit` has already truncated the ledger
   * (services/partners.py:96–104), so a short limit silently understates a busy
   * period. Ask for the maximum and check `entries.length` against it.
   *
   * Passing BOTH bounds is what makes the derivation cover your window; with
   * one or neither the server derives the current ISO week instead and names
   * that period in `commission_basis.period`.
   */
  agency: (id: string, params: { since?: string; until?: string; limit?: number } = {}) =>
    get<AgencyStatement>(
      `/partners/agencies/${encodeURIComponent(id)}/statement${query({
        since: params.since,
        until: params.until,
        limit: params.limit,
      })}`,
    ),

  /**
   * Per-host earnings. backend/app/routers/partners.py:61.
   *
   * Takes `since` and no `until` — the window is always "since X until now".
   * Without `since` it returns lifetime, so a period heading over an unscoped
   * call is simply a false statement.
   */
  agencyHosts: (id: string, params: { since?: string; limit?: number } = {}) =>
    get<AgencyHostRow[]>(
      `/partners/agencies/${encodeURIComponent(id)}/hosts${query({
        since: params.since,
        limit: params.limit,
      })}`,
    ),

  subAgenciesOf: (id: string) =>
    get<SubAgency[]>(`/partners/agencies/${encodeURIComponent(id)}/sub-agencies`),

  canTakeInventory: (id: string) =>
    get<{ allowed: boolean; reason: string }>(
      `/partners/sellers/${encodeURIComponent(id)}/can-take-inventory`,
    ),
}

export const credit = {
  exposure: () => get<CreditExposure>('/partners/credit/exposure'),
  overdue: (limit = 200) => get<OverdueSeller[]>(`/partners/credit/overdue?limit=${limit}`),
}

// ── The board, as these screens read it ───────────────────────────────────────

export const board = {
  list: (limit = 300) => get<PartnerCard[]>(`/cards?limit=${limit}`),
  /** Verifying confirms the facts. It is not approval — an owner still signs. */
  verify: (cardId: string, note: string) =>
    post<PartnerCard>(`/cards/${encodeURIComponent(cardId)}/verify`, { note }),
  reject: (cardId: string, reason: string) =>
    post<PartnerCard>(`/cards/${encodeURIComponent(cardId)}/reject`, { reason }),
}

// ── Live rooms — 8.7.3 / 8.7.4 ───────────────────────────────────────────────
//
// Not partner operations, and here for one reason: `lib/api.ts` is owned
// elsewhere and its default export is a closed object. This client already
// carries the session, the error type and the 401 handling, so a second copy of
// all three would be the cost of putting these two calls in a file of their own.

/** What `POST /users/live-rooms/{id}/end` returns. */
export interface LiveRoomEnded {
  room_id: string
  host_uid: string
  host_name: string
  ended: boolean
  ended_at: string
  reason: string
  audit_id: string
  /**
   * What actually happened, in the server's words. It says the room is flagged
   * ended and the stream stops when the host's client reads the flag — show it,
   * because an End button that implies the video was severed on the click is
   * lying about what it did.
   */
  note: string
}

/** What `POST /users/live-rooms/{id}/mute` returns. */
export interface LiveHostMuted {
  room_id: string
  host_uid: string
  host_name: string
  muted: boolean
  was_muted: boolean
  at: string
  reason: string
  audit_id: string
  /**
   * The limitation, verbatim: `hostMuted` is a flag the **Android app must
   * honour**, and this API is not in the media path. Until the app reads it the
   * host is still audible. Print this every time — a mute button that reports
   * success into a room still making noise is worse than no button.
   */
  app_must_honour: string
}

export const live = {
  /**
   * End a live stream. Ops or an owner; the API refuses anybody else with a
   * message written to be shown.
   *
   * The reason is mandatory and must be at least six characters (8.7.4). It
   * lands in the audit log against your name, and on the room document.
   *
   * This does **not** ban, suspend or warn the host — their account is
   * untouched. That is a separate call with its own reason.
   */
  end: (roomId: string, reason: string) =>
    post<LiveRoomEnded>(
      `/users/live-rooms/${encodeURIComponent(roomId)}/end`,
      { reason },
    ),

  /**
   * Mute or unmute a live host. Same authority, same mandatory reason.
   *
   * Read `app_must_honour` on the response before deciding this worked: the
   * decision is recorded, and it silences nobody until the Android app reads
   * the flag.
   */
  mute: (roomId: string, muted: boolean, reason: string) =>
    post<LiveHostMuted>(
      `/users/live-rooms/${encodeURIComponent(roomId)}/mute`,
      { muted, reason },
    ),
}

// ── Small shared helpers the partner screens all need ─────────────────────────

/** Minor units (paise) as rupees. */
export function inr(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

/**
 * The same conversion, always to the paisa — ₹1,234.50, never ₹1,234.5.
 *
 * For a statement a partner may be reconciling against a bank line, where a
 * dropped trailing zero reads as a different number. Same single division by
 * 100 as `inr`; the difference is only in how it is written.
 */
export function inrExact(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** A date and time, for a money movement where the hour can matter. */
export function whenExact(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function coins(value: number): string {
  return `🪙 ${Math.round(value).toLocaleString('en-IN')}`
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

/**
 * Mirrors `credit_standing` on the server (spec 4.3.11) so a list can be
 * coloured without a round trip per row. The server's answer wins wherever it
 * is attached — this is only for the list view.
 */
export function standingOf(cr: PartnerCredit | undefined): CreditStanding {
  const outstanding = cr?.outstanding ?? 0
  if (outstanding <= 0) return 'none'
  if (!cr?.due_at) return 'current'
  const due = new Date(cr.due_at).getTime()
  if (Number.isNaN(due)) return 'current'
  const now = Date.now()
  if (now > due) return 'overdue'
  if (now > due - 3 * 24 * 60 * 60 * 1000) return 'due_soon'
  return 'current'
}

export function daysOverdue(dueAt: string | null | undefined): number {
  if (!dueAt) return 0
  const due = new Date(dueAt).getTime()
  if (Number.isNaN(due)) return 0
  return Math.max(0, Math.floor((Date.now() - due) / (24 * 60 * 60 * 1000)))
}

export const STANDING_LABEL: Record<CreditStanding, string> = {
  none: 'No credit',
  current: 'Current',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  written_off: 'Written off',
}

export const STANDING_TONE: Record<CreditStanding, string> = {
  none: 'bg-slate-700/60 text-slate-400',
  current: 'bg-green-500/15 text-green-300',
  due_soon: 'bg-amber-500/15 text-amber-300',
  overdue: 'bg-red-500/20 text-red-300',
  written_off: 'bg-slate-700 text-slate-400',
}

export const STATUS_TONE: Record<PartnerStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  rejected: 'bg-red-500/15 text-red-300',
  suspended: 'bg-slate-700 text-slate-400',
}

/**
 * Run a set of per-row lookups without opening one connection per row.
 *
 * The list endpoints do not carry balances, so the screens fill them in
 * afterwards. Six at a time keeps a 200-row list from becoming 200 parallel
 * requests.
 */
export async function inBatches<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  size = 6,
): Promise<(R | null)[]> {
  const out: (R | null)[] = []
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    const done = await Promise.all(
      slice.map((item) => worker(item).catch(() => null)),
    )
    out.push(...done)
  }
  return out
}

const apiPartners = {
  partnerOps,
  inventory,
  lending,
  commission,
  statements,
  credit,
  board,
  live,
}

export default apiPartners
