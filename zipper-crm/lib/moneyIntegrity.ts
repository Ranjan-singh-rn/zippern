/**
 * B1 — money integrity, as `/finance/integrity` and `/finance/payouts` read it:
 *
 *   * HELD ITEMS — every pending card, recharge, sale and sub-agency payout of
 *     a revoked partner, held for Finance/Owner review (`held.reason =
 *     'role_revoked'`). Nothing on that list is approved, cancelled or
 *     executed by the machine; releasing the hold lets it be decided through
 *     its ordinary route.
 *   * REPLICA DRIFT — balances whose last Firestore sync failed: the ledger is
 *     right and the app shows an old figure until the delta is replayed.
 *   * OWNER NOTICES — §8 money notifications not yet delivered to every Owner.
 *   * PAYOUT POLICY — the hold between a week closing and its beans becoming
 *     withdrawable (an Owner decision still pending).
 *
 * ── WHO MAY DO WHAT — THE SERVER'S GATES, MIRRORED ──────────────────────────
 *
 *   held items: list     `can_process_payout`            (Owner, Finance admin, Finance member)
 *               release  …and Finance admin or Owner      (`money_freeze.can_decide_held`)
 *   replica drift        `can_process_payout`            (list and repair)
 *   Owner notices        the Owner                        (`require_owner`, list and retry)
 *
 * The server enforces every one of these whatever this module says, and its
 * refusal is shown as written; this only decides what to OFFER, so nobody is
 * handed a button that can only answer 403.
 *
 * Pure — no imports — so `npm run test:moneyintegrity` runs the shipped module.
 */

export type HeldItemTypeValue = 'card' | 'recharge' | 'sale' | 'subagency_payout'

export interface MoneyIntegrityViewer {
  /** The API session's role is `owner`. */
  isOwner: boolean
  /** The API session's role (`finance_admin`, `finance_member`, …). */
  role: string
  /** `can_process_payout` from the CRM's permission helper. */
  canProcessPayout: boolean
}

export interface MoneyIntegrityAccess {
  viewHeld: boolean
  releaseHeld: boolean
  viewDrift: boolean
  repairDrift: boolean
  viewNotices: boolean
  retryNotices: boolean
  /** Anything at all on the page. */
  any: boolean
}

/** `money_freeze.release_hold`'s refusal, verbatim. */
export const RELEASE_NEEDS = 'Only Finance or an Owner may release a held item.'

/** Shown where the Owner-notice section would be, for everybody else. */
export const NOTICES_OWNER_ONLY = 'Owner money notices are the Owners’ own queue.'

export function moneyIntegrityAccess(me: MoneyIntegrityViewer): MoneyIntegrityAccess {
  const payout = me.isOwner || me.canProcessPayout
  const release = payout && (me.isOwner || text(me.role) === 'finance_admin')
  const access = {
    viewHeld: payout,
    releaseHeld: release,
    viewDrift: payout,
    repairDrift: payout,
    viewNotices: me.isOwner,
    retryNotices: me.isOwner,
  }
  return { ...access, any: access.viewHeld || access.viewDrift || access.viewNotices }
}

/** `HeldRelease.reason: min_length=5` — the note is the record of the decision. */
export const MIN_RELEASE_REASON = 5

export function releaseReasonProblem(reason: unknown): string {
  const n = text(reason).length
  if (n >= MIN_RELEASE_REASON) return ''
  return `Say why, in at least ${MIN_RELEASE_REASON} characters — the note is the record of this decision.`
}

// ── formatting, deterministic (no locale data needed) ────────────────────────

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function millis(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** 1234567 → "12,34,567" — Indian grouping. */
export function groupIndian(n: number): string {
  const sign = n < 0 ? '-' : ''
  const s = String(Math.trunc(Math.abs(n)))
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3)
  return sign + (rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3)
}

/** Paise as rupees, to the paisa when there are any: 123450 → "₹1,234.50". */
export function inrMinor(minor: number): string {
  const rounded = Math.round(minor)
  const sign = rounded < 0 ? '-' : ''
  const abs = Math.abs(rounded)
  const paise = abs % 100
  return `${sign}₹${groupIndian(Math.floor(abs / 100))}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`
}

/** A card amount in its own unit: commission is paise, everything else a count. */
export function amountText(amount: unknown, currency: unknown): string {
  const n = num(amount)
  const unit = text(currency).toLowerCase()
  if (n === null) return 'amount not recorded'
  if (unit === 'commission' || unit === 'inr' || unit === 'inr_minor' || unit === 'paise') return inrMinor(n)
  return `${groupIndian(n)} ${unit || 'units'}`
}

// ── Held items ───────────────────────────────────────────────────────────────

export const HELD_TYPE_LABEL: Readonly<Record<HeldItemTypeValue, string>> = Object.freeze({
  card: 'Money card',
  recharge: 'Recharge',
  sale: 'Seller sale',
  subagency_payout: 'Sub-agency payout',
})

export const HELD_REASON_LABEL: Readonly<Record<string, string>> = Object.freeze({
  role_revoked: 'The partner’s role was revoked',
})

export interface HeldRow {
  type: HeldItemTypeValue
  id: string
  /** What the item is, in one line. */
  title: string
  /** Its money and state, in one line. */
  detail: string
  reason: string
  partnerKind: string
  partnerId: string
  note: string
  heldAtMs: number | null
  heldBy: string
  released: boolean
  releasedAtMs: number | null
  releasedBy: string
  releaseReason: string
}

function who(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const o = v as Record<string, unknown>
  return text(o.name) || text(o.uid)
}

function describe(type: HeldItemTypeValue, d: Record<string, unknown>): { title: string; detail: string } {
  const status = text(d.status) || text(d.stage)
  switch (type) {
    case 'card':
      return {
        title: text(d.title) || text(d.type) || 'Card',
        detail: [text(d.type).replace(/_/g, ' '), amountText(d.amount, d.currency), text(d.stage).replace(/_/g, ' ')]
          .filter(Boolean).join(' · '),
      }
    case 'recharge': {
      const minor = num(d.amount_minor)
      return {
        title: `Recharge of ${groupIndian(num(d.diamonds) ?? 0)} diamonds`,
        detail: [`for ${text(d.buyer_uid) || 'an unrecorded buyer'}`, minor === null ? '' : inrMinor(minor), status]
          .filter(Boolean).join(' · '),
      }
    }
    case 'sale': {
      const minor = num(d.amount_paid_minor)
      return {
        title: `Sale of ${groupIndian(num(d.diamonds) ?? 0)} diamonds`,
        detail: [`to ${text(d.buyer_uid) || 'an unrecorded buyer'}`, minor === null ? '' : inrMinor(minor), status]
          .filter(Boolean).join(' · '),
      }
    }
    case 'subagency_payout': {
      const minor = num(d.amount_minor)
      return {
        title: `Sub-agency payout${minor === null ? '' : ` of ${inrMinor(minor)}`}`,
        detail: [`${text(d.parent_id) || '?'} → ${text(d.sub_id) || '?'}`, status].filter(Boolean).join(' · '),
      }
    }
  }
}

const RESPONSE_KEYS: readonly [string, HeldItemTypeValue][] = [
  ['cards', 'card'],
  ['recharges', 'recharge'],
  ['sales', 'sale'],
  ['subagency_payouts', 'subagency_payout'],
]

/**
 * Every held item in a `GET /partner-ops/held-items` answer, as one list,
 * newest hold first. A document without an id is dropped — it could not be
 * released, so offering it would be offering a 404.
 */
export function heldRowsFrom(body: unknown): HeldRow[] {
  if (!body || typeof body !== 'object') return []
  const o = body as Record<string, unknown>
  const out: HeldRow[] = []
  for (const [key, type] of RESPONSE_KEYS) {
    const list = Array.isArray(o[key]) ? (o[key] as unknown[]) : []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const d = raw as Record<string, unknown>
      const id = text(d.id)
      if (!id) continue
      const held = d.held && typeof d.held === 'object' ? (d.held as Record<string, unknown>) : {}
      const { title, detail } = describe(type, d)
      out.push({
        type,
        id,
        title,
        detail,
        reason: HELD_REASON_LABEL[text(held.reason)] ?? (text(held.reason) || 'Held'),
        partnerKind: text(held.partner_kind),
        partnerId: text(held.partner_id),
        note: text(held.note),
        heldAtMs: millis(held.at),
        heldBy: who(held.by),
        released: !!text(held.released_at),
        releasedAtMs: millis(held.released_at),
        releasedBy: who(held.released_by),
        releaseReason: text(held.release_reason),
      })
    }
  }
  return out.sort((a, b) => (b.heldAtMs ?? 0) - (a.heldAtMs ?? 0))
}

// ── Replica drift ────────────────────────────────────────────────────────────

export interface DriftRow {
  id: string
  /** `user/abc123/diamonds` — the balance the ledger and the app disagree on. */
  holder: string
  holderType: string
  holderId: string
  currency: string
  /** The ledger's balance — the true figure. */
  ledgerBalance: number | null
  pendingCount: number
  /** What the app is still missing, summed. */
  pendingDelta: number
  staleSinceMs: number | null
  lastRepairAtMs: number | null
  lastError: string
}

export function driftRowsFrom(body: unknown): DriftRow[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { balances?: unknown }).balances)
    ? (body as { balances: unknown[] }).balances
    : Array.isArray(body) ? body : []
  const out: DriftRow[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const pending = Array.isArray(d.replica_pending) ? d.replica_pending : []
    const holderType = text(d.holder_type)
    const holderId = text(d.holder_id)
    const currency = text(d.currency)
    out.push({
      id: text(d.id) || [holderType, holderId, currency].join('/'),
      holder: [holderType || '?', holderId || '?', currency || '?'].join('/'),
      holderType,
      holderId,
      currency,
      ledgerBalance: num(d.amount),
      pendingCount: pending.length,
      pendingDelta: pending.reduce<number>(
        (sum, e) => sum + (num((e as { delta?: unknown } | null)?.delta) ?? 0), 0),
      staleSinceMs: millis(d.replica_stale_at),
      lastRepairAtMs: millis(d.replica_repair_last_at),
      lastError: text(d.replica_repair_last_error),
    })
  }
  return out
}

/** One sentence for what a repair run did. */
export function repairSummaryLine(summary: unknown): string {
  const s = summary && typeof summary === 'object' ? (summary as Record<string, unknown>) : {}
  const rows = num(s.rows) ?? 0
  if (rows === 0) return 'Nothing was out of step — no balance needed repairing.'
  const repaired = num(s.repaired) ?? 0
  const replayed = num(s.replayed) ?? 0
  const already = num(s.already_applied) ?? 0
  const failed = num(s.failed) ?? 0
  const parts = [
    `${rows} balance${rows === 1 ? '' : 's'} checked`,
    `${repaired} brought back in step`,
    `${replayed} change${replayed === 1 ? '' : 's'} replayed`,
  ]
  if (already) parts.push(`${already} had already landed (not applied twice)`)
  if (failed) parts.push(`${failed} still failing — see each row's error`)
  return `${parts.join(', ')}.`
}

// ── Owner notices ────────────────────────────────────────────────────────────

/** `owner_mail.ACTIONS`, short labels. An action this build does not know is shown as written. */
export const OWNER_NOTICE_ACTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  card_signed: 'Card signed',
  card_executed: 'Card executed',
  recharge_approved: 'Recharge approved',
  refund_approved: 'Refund approved',
  refund_refused: 'Refund refused',
  freeze_release: 'Frozen money released',
  freeze_withhold: 'Frozen money withheld',
  freeze_adjust: 'Frozen money adjusted',
  sale_approved: 'Sale approved',
})

/** The email outcomes that count as "told" (`owner_mail._EMAIL_OK`). */
export const EMAIL_TOLD: ReadonlySet<string> = new Set(['sent', 'delivered', 'duplicate'])

export interface NoticeRow {
  id: string
  action: string
  reference: string
  referenceType: string
  amount: string
  actor: string
  attempts: number
  /** Owners told in full (in-app AND by email) so far. */
  told: string[]
  /** Owners still missing one half or both, with what is missing. */
  untold: string[]
  lastError: string
  createdAtMs: number | null
  lastAttemptAtMs: number | null
}

export function noticeRowsFrom(body: unknown): NoticeRow[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { pending?: unknown }).pending)
    ? (body as { pending: unknown[] }).pending
    : Array.isArray(body) ? body : []
  const out: NoticeRow[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const told: string[] = []
    const untold: string[] = []
    const deliveries = d.deliveries && typeof d.deliveries === 'object'
      ? (d.deliveries as Record<string, unknown>)
      : {}
    for (const [uid, v] of Object.entries(deliveries)) {
      const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
      const name = text(o.name) || uid
      const inApp = o.in_app === true
      const email = text(o.email)
      if (inApp && EMAIL_TOLD.has(email)) told.push(name)
      else {
        const missing = [inApp ? '' : 'in-app', EMAIL_TOLD.has(email) ? '' : `email ${email || 'not sent'}`]
          .filter(Boolean).join(', ')
        untold.push(`${name} (${missing})`)
      }
    }
    const action = text(d.action)
    out.push({
      id: text(d.id) || text(d.event_key),
      action: OWNER_NOTICE_ACTION_LABEL[action] ?? (action.replace(/_/g, ' ') || 'Unknown action'),
      reference: text(d.reference),
      referenceType: text(d.reference_type),
      amount: d.amount === null || d.amount === undefined ? '' : amountText(d.amount, d.currency),
      actor: who(d.actor),
      attempts: num(d.attempts) ?? 0,
      told,
      untold,
      lastError: text(d.last_error),
      createdAtMs: millis(d.created_at),
      lastAttemptAtMs: millis(d.last_attempt_at),
    })
  }
  return out
}

/** One sentence for a retry run. */
export function retrySummaryLine(result: unknown): string {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const rows = Array.isArray(r.rows) ? r.rows : []
  const retried = num(r.retried) ?? rows.length
  if (retried === 0) return 'Nothing was pending — every Owner had been told.'
  const sent = rows.filter((x) => text((x as { outcome?: unknown } | null)?.outcome) === 'sent').length
  const failed = retried - sent
  return `${retried} notice${retried === 1 ? '' : 's'} retried: ${sent} now delivered` +
    (failed ? `, ${failed} still not — they stay on the list and the sweep tries again.` : '.')
}

// ── Payout policy ────────────────────────────────────────────────────────────

export interface PayoutPolicyView {
  /** "A closed ISO week is released …" — the server's own sentence. */
  headline: string
  lines: string[]
  /** The Owner has not decided the settlement policy yet. */
  pending: boolean
}

/** `GET /reports/payout-policy`, ready to print. The server's sentences, as written. */
export function payoutPolicyLines(policy: unknown): PayoutPolicyView | null {
  if (!policy || typeof policy !== 'object') return null
  const p = policy as Record<string, unknown>
  const behaviour = text(p.current_behaviour)
  const weeks = num(p.release_arrears_weeks)
  if (!behaviour && weeks === null) return null
  const lines: string[] = []
  if (weeks !== null) {
    lines.push(`${text(p.setting) || 'Release arrears'} = ${weeks} week${weeks === 1 ? '' : 's'}.`)
  }
  if (text(p.applies_to)) lines.push(`Applies to ${text(p.applies_to)}.`)
  if (text(p.note)) lines.push(text(p.note))
  return {
    headline: behaviour ? `${behaviour.charAt(0).toUpperCase()}${behaviour.slice(1)}.` : '',
    lines,
    pending: p.owner_decision_pending === true,
  }
}
