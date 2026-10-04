'use client'

/**
 * The owners' capital account — `/api/capital`.
 *
 * A file of its own, and **not** part of `lib/apiExpenses.ts`, for the reason
 * the whole feature exists: money an owner puts into the business is not
 * revenue, and money an owner takes back out is not a cost. Filing the two
 * clients together would be the first step of the confusion the screen is built
 * to prevent — a reader who finds `drawings` next to `staff_salaries` in the
 * same module has already been told the wrong thing.
 *
 *   ┌─ trading ──────────────────────────────────────────────────────────────┐
 *   │ revenue   cash in from sellers and users        → profit               │
 *   │ costs     payouts, commission, salaries, tax    → profit               │
 *   ├─ capital ──────────────────────────────────────────────────────────────┤
 *   │ capital in    an owner funds the business       → NOT profit, cash up  │
 *   │ drawings out  an owner takes it back            → NOT profit, cash down│
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Counted as revenue, a company funding itself reads as a company earning, and
 * the margin is whatever the owners happened to deposit. Counted as an expense,
 * a repaid founder loan reads as a loss in the very month the business finally
 * afforded to pay its founders back. Both directions are real cash and both are
 * excluded from profit; the card itself carries `excluded_from_profit: true` so
 * no reader has to infer it.
 *
 * Two more facts the shapes below depend on.
 *
 * **Recording moves nothing.** `POST /capital` raises a card in `requested`.
 * Verification is `POST /cards/{id}/verify` and signature is
 * `POST /cards/{id}/sign`, neither of which is here — and an owner cannot sign
 * their own capital card. "How much did I put in" is a question three partners
 * will one day disagree about, and the answer needs two names on it.
 *
 * **`GET /capital` counts executed cards only.** A signed card whose transfer
 * has not happened is not money the business holds, and counting it would
 * overstate both the cash and what is owed. That is correct for the account and
 * useless for a worklist, which is why `capital.movements` below reads the board
 * instead — see its own note.
 */

import {
  ApiError,
  getSessionToken,
  reportUnauthorized,
  type Stage,
  type Who,
} from '@/lib/api'

// Mirrors lib/api.ts — same-origin in production via a Hosting rewrite, its own
// port locally.
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

/**
 * The two directions money moves between the business and the people who own
 * it. `DIRECTIONS` in `backend/app/services/capital.py:63`, kept deliberately
 * short — this is not a second expense taxonomy.
 */
export type CapitalDirection = 'in' | 'out'

export const DIRECTION_LABEL: Record<CapitalDirection, string> = {
  in: 'Capital introduced',
  out: 'Drawings',
}

/** What each direction actually does, in a sentence a reader can act on. */
export const DIRECTION_MEANING: Record<CapitalDirection, string> = {
  in: 'An owner puts their own money into the business. The bank goes up and the business now owes them that much. It is not revenue.',
  out: 'An owner takes money back out. The bank goes down and what the business owes them falls. It is not an expense.',
}

/** The two card types these movements are raised as. `cards.CardType`. */
export const CAPITAL_CARD_TYPES = ['owner_capital_in', 'owner_drawings'] as const

/** `min_length=3` on `reason` in `backend/app/routers/capital.py:54`. */
export const MIN_REASON = 3

/**
 * One executed movement, as `contribution_of` reports it.
 *
 * Executed only — this list is derived from settled cards, so everything in it
 * is money that has actually moved.
 */
export interface CapitalMovement {
  card_id: string
  direction: CapitalDirection
  /** Paise. ₹1,000 is 100000. */
  amount_minor: number
  /** The bank reference. Mandatory in both directions, so never empty. */
  reference: string
  method: string
  reason: string
  executed_at: string | null
}

/**
 * One owner's capital position.
 *
 * `outstanding_minor` is `introduced − drawn`: what the business still **owes**
 * that owner. It is a liability, not a pot to spend, and a positive figure
 * means they have funded the company by that much and have not been repaid.
 * A negative figure means they have taken out more than they put in.
 */
export interface OwnerCapital {
  owner_uid: string
  owner_name: string
  introduced_minor: number
  drawn_minor: number
  outstanding_minor: number
  movements: CapitalMovement[]
}

/** The capital account in one line, for the P&L to declare and exclude. */
export interface CapitalTotals {
  owners: number
  introduced_minor: number
  drawn_minor: number
  outstanding_minor: number
  /** The server's own wording on why none of this is trading. Show it. */
  note: string
}

export interface CapitalAccount {
  owners: OwnerCapital[]
  totals: CapitalTotals
}

/**
 * A capital card as this screen reads it — the same document every other card
 * is. `payload` is untyped on the wire; `capitalPayload` holds the casts.
 */
export interface CapitalCard {
  id: string
  type: string
  team: string
  title: string
  /** Paise, and equal to `payload.amount_minor`. */
  amount: number
  /** `INR` for a capital card — `capital.CURRENCY`. */
  currency: string
  reason: string
  subject: { type: string; id: string }
  payload: Record<string, unknown>
  evidence: { kind?: string; ref?: string; url?: string }[]
  stage: Stage
  requested_by: Who
  created_at: string
  updated_at: string
  verified_by: Who | null
  verified_at: string | null
  verification_note: string | null
  auto_verified?: boolean
  signed_by: Who | null
  signed_at: string | null
  executed_at: string | null
  execution_result: Record<string, unknown> | null
  rejected_by: Who | null
  rejected_at: string | null
  rejection_reason: string | null
}

export interface CapitalPayload {
  /** Empty only on a malformed card. Never defaulted to a direction. */
  direction: CapitalDirection | ''
  owner_uid: string
  owner_name: string
  amount_minor: number
  method: string
  reference: string
  /** Written on the card by the server. Always true; read, never assumed. */
  excluded_from_profit: boolean
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function capitalPayload(card: CapitalCard): CapitalPayload {
  const p = card.payload ?? {}
  const direction = str(p, 'direction')
  const amount = p.amount_minor
  return {
    direction: direction === 'in' || direction === 'out' ? direction : '',
    owner_uid: str(p, 'owner_uid'),
    owner_name: str(p, 'owner_name'),
    amount_minor: typeof amount === 'number' && Number.isFinite(amount) ? amount : card.amount,
    method: str(p, 'method'),
    reference: str(p, 'reference'),
    excluded_from_profit: p.excluded_from_profit === true,
  }
}

/** Who this movement is about, preferring the name and falling back to the id. */
export function ownerLabel(row: { owner_name: string; owner_uid: string }): string {
  return row.owner_name.trim() || row.owner_uid
}

// ── Request bodies ────────────────────────────────────────────────────────────

export interface MovementBody {
  direction: CapitalDirection
  owner_uid: string
  owner_name?: string
  /** Integer paise, greater than zero. Use `paiseFromRupees`. */
  amount_minor: number
  method?: string
  /**
   * The bank reference for the transfer. **Required in both directions** — a
   * movement between the business and an owner that cannot be matched against a
   * statement is exactly the movement that should be easiest to prove.
   */
  reference: string
  reason: string
}

/** The methods the form offers. `method` is free text on the wire; these are
 *  the ones that actually get used, so a person is not typing "bank" by hand. */
export const METHODS = ['bank', 'upi', 'cash', 'cheque', 'binance'] as const

// ── Calls ─────────────────────────────────────────────────────────────────────

export const capital = {
  /**
   * What each owner has put in, taken back and is still owed, plus the totals.
   *
   * `require_internal`, not `require_owner`: the capital account is business
   * record, and Finance and the Observer are entitled to see it. Writing it is
   * not.
   */
  account: (ownerUid?: string) =>
    get<CapitalAccount>(`/capital${query({ owner_uid: ownerUid })}`),

  /**
   * Record that an owner is putting money in, or taking it out. **Moves
   * nothing** — it raises a card, which another person verifies and an owner —
   * not the owner it is about — signs.
   */
  record: (body: MovementBody) =>
    post<CapitalCard>('/capital', { owner_name: '', method: 'bank', ...body }),

  /**
   * Stage 5 of 5 — the transfer happened. **Owners only.**
   *
   * Refuses anything not already signed. There is no balance to update: the
   * business's cash position is derived from executed cards, so executing *is*
   * the record.
   */
  settle: (cardId: string, reason = '') =>
    post<CapitalCard>(`/capital/${encodeURIComponent(cardId)}/settle`, { reason }),

  /**
   * Every capital card on the money board, at whatever stage it reached.
   *
   * There is no `/capital` list of cards, and that is not an oversight —
   * `GET /capital` is the *account*, and an account that counted unsettled
   * movements would overstate both the cash and the debt. But a screen still
   * has to show a movement waiting on a verifier or an owner, or the person who
   * recorded it has no way to see where it got to and no way to settle it.
   *
   * So this reads `GET /cards`, which is scoped server-side in
   * `cards.board_for` — an owner and the Observer see every team, a Finance
   * admin sees the Finance board, and capital cards are raised on Finance. It
   * then keeps the two capital types. The filter is the caller's; the authority
   * is not.
   *
   * `limit` is passed to the board, so a busy board can truncate this list.
   * Callers should compare what came back against the limit rather than
   * treating a short list as a complete one.
   */
  async movements(limit = 300): Promise<CapitalCard[]> {
    const cards = await get<CapitalCard[]>(`/cards${query({ limit })}`)
    const types = new Set<string>(CAPITAL_CARD_TYPES)
    return cards.filter((c) => types.has(c.type))
  },
}

// ── Money in, money out ───────────────────────────────────────────────────────

/**
 * A typed rupee amount as integer paise, or null when it cannot be converted
 * exactly. Null is a refusal, not a zero.
 *
 * `_minor` on the server refuses a float rather than rounding it — "₹1,000 is
 * 100000" — because silently turning `12345.6` into `12346` invents six paise
 * nobody decided on. This is the browser side of that rule.
 *
 * It multiplies. Nothing in this module divides by 100; display goes through
 * `formatInrMinor` in `lib/apiReports`, which is the single division.
 */
export function paiseFromRupees(input: string): number | null {
  const text = input.trim().replace(/[₹,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const paise = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2))
  if (!Number.isSafeInteger(paise) || paise <= 0) return null
  return paise
}

// ── The five stages, in this domain's words ───────────────────────────────────

export const CAPITAL_STAGE_TRACK: Stage[] = [
  'requested',
  'under_review',
  'awaiting_signoff',
  'approved',
  'executed',
]

/**
 * What each stage means for a capital movement. `approved` and `executed` are
 * the pair that gets confused, and here the difference is whether the transfer
 * between the business and the owner has actually happened.
 */
export const CAPITAL_STAGE_LABEL: Record<Stage, string> = {
  requested: 'Recorded — nothing has moved',
  under_review: 'Under review — nothing has moved',
  awaiting_signoff: 'Verified — waiting for an owner to sign',
  approved: 'Signed — not settled yet',
  executed: 'Settled — the transfer happened',
  rejected: 'Rejected — no movement was recorded',
  failed: 'Failed — nothing was transferred',
}

export const CAPITAL_STAGE_SHORT: Record<Stage, string> = {
  requested: 'Recorded',
  under_review: 'In review',
  awaiting_signoff: 'Awaiting sign-off',
  approved: 'Signed, unsettled',
  executed: 'Settled',
  rejected: 'Rejected',
  failed: 'Failed',
}

export const STAGE_TONE: Record<Stage, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
}

const apiCapital = { capital }
export default apiCapital
