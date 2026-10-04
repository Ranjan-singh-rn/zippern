'use client'

/**
 * Client for the chance mechanics — `/api/chance/**` and the three chance
 * reports on `/api/reports`.
 *
 * Kept apart from `lib/api.ts`, `lib/apiPartners.ts` and `lib/apiReports.ts`
 * because this half of the API has rules the others do not, and the rules are
 * the reason the screens exist:
 *
 *   * **RTP is never computed in the browser.** The server computes it from the
 *     outcome table (8B.2.4) and there is a draft-evaluation endpoint —
 *     `POST /chance/configs/preview`, `backend/app/routers/chance.py:418` —
 *     whose whole purpose is to answer "what would this table do" before
 *     anything is signed. It is the *same function* that gates the proposal
 *     (`chance.evaluate_draft`, `backend/app/services/chance.py:984`), so what
 *     is previewed is what will be enforced. There is deliberately no local
 *     arithmetic in this module beyond formatting.
 *
 *   * **Units are never mixed and never bare.** `multiplier_bp` is basis points
 *     of the stake (10,000 = 1×). `probability_ppm` is parts per million and
 *     the column must sum to exactly 1,000,000. RTP, house edge and every
 *     "consumed" figure are ppm. Every stake, payout, reserve and ceiling is a
 *     whole number of **diamonds**. Money on the three reports is INR **minor
 *     units** (paise) — `formatInrMinor` from `lib/apiReports` divides once.
 *     Beans are beans and are never added to diamonds.
 *
 *   * **Nothing is live by default.** A mechanic with `live_version: null` has
 *     never been configured and is invisible in every market; a mechanic with
 *     `suspended` set pays nothing and accepts nothing. `live` on a list row is
 *     the only field that means "a player could play this right now", and the
 *     other two facts are kept beside it because "signed but stopped" and
 *     "never configured" are different problems (`chance.list_mechanics`,
 *     `backend/app/services/chance.py:1367`).
 *
 * Every refusal in this file surfaces as an `ApiError` whose `message` is what
 * the server actually said. A blocked configuration is *not* an error: the
 * preview returns 200 with `blocked: true` and `blocked_reasons`, and those
 * sentences are written to be shown.
 */

import { ApiError, getSessionToken, reportUnauthorized, type Card } from './api'
import type { ReportEnvelope } from './apiReports'
import type { CrmRole } from './auth'

// Same derivation as the other three clients: production serves the API from
// this origin through a Hosting rewrite, local development runs it on its own
// port.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

/** Every reason field on this half of the API is `min_length=8`. */
export const MIN_REASON = 8

/** `probability_ppm` must sum to exactly this. `chance.parse_outcomes`. */
export const PROBABILITY_TOTAL = 1_000_000

/** `multiplier_bp` of one whole stake. 10,000 bp = 1×. */
export const MULTIPLIER_ONE = 10_000

// ══════════════════════════════════════════════════════════════════════════════
//  Who may do what — read off the dependencies, not guessed
// ══════════════════════════════════════════════════════════════════════════════
//
// `backend/app/routers/chance.py` uses exactly three guards, and this is the
// CRM's role vocabulary for each of them. A screen that offers a button its
// caller cannot press is the defect these constants exist to prevent.

/**
 * `require_internal` — every read route on the chance router.
 * `backend/app/core/deps.py:347`. The Observer satisfies it too and holds no
 * Firestore `crmUser`, so a screen admits them on `apiUser.role === 'observer'`
 * beside this list.
 */
export const CHANCE_READ_ROLES: CrmRole[] = [
  'superadmin',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]

/**
 * `require_team_admin` — preview a table, create a mechanic, propose a
 * configuration, suspend a mechanic, review a protection flag, impose a limit,
 * decide a lift request. `backend/app/core/deps.py:356` admits a team admin or
 * an owner; a *member* is refused.
 */
export const CHANCE_TEAM_ADMIN_ROLES: CrmRole[] = [
  'superadmin',
  'app_admin', 'ops_admin', 'finance_admin',
  'tech_admin', 'support_admin', 'marketing_admin',
]

/**
 * `require_owner` — activate a signed configuration, resume a suspended
 * mechanic, withdraw a market. `backend/app/core/deps.py:337`. In this CRM the
 * owner role is `superadmin`; the API calls it `owner`.
 */
export const CHANCE_OWNER_ROLES: CrmRole[] = ['superadmin']

/**
 * Freeze and unfreeze a player. **Two guards, and the narrow one wins.** The
 * route is `require_team_admin` (`chance.py:1147`), and the service then
 * refuses anyone who is not Ops or an owner (`chance._require_reviewer`,
 * `backend/app/services/chance.py:4220`). The intersection is an owner or the
 * Ops admin — an Ops *member* fails the route, and a Finance admin fails the
 * service.
 */
export const CHANCE_FREEZE_ROLES: CrmRole[] = ['superadmin', 'ops_admin']

/**
 * The three chance reports go through `_require_business_financials`
 * (`backend/app/routers/reports.py:128`), which admits owners, the Observer and
 * any team admin. This is narrower on purpose: 8B.5.6 gives the margin to
 * Finance, and a page of business-wide money is not Marketing's.
 */
export const CHANCE_MONEY_ROLES: CrmRole[] = ['superadmin', 'finance_admin']

// ══════════════════════════════════════════════════════════════════════════════
//  Transport
// ══════════════════════════════════════════════════════════════════════════════

type QueryParams = Record<string, string | number | boolean | undefined>

function buildQuery(params: QueryParams): string {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

interface ValidationItem {
  loc?: unknown[]
  msg?: unknown
}

/**
 * The sentence the server sent, whatever shape it arrived in.
 *
 * Four shapes reach here and each one matters:
 *   • `{detail: "…"}`                       — a business rule refused (`_fail`)
 *   • `{detail: {message, blocked_reasons}}` — a blocked configuration
 *   • `{detail: {message, kind, …}}`         — a protection block, or a freeze
 *   • `{detail: [{loc, msg}]}`               — FastAPI body validation (422)
 *
 * Nothing is rewritten. `ApiError.message` is what the server said, because the
 * messages on this router are written to be read by the person who caused them.
 */
function messageFrom(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body
  if (!body || typeof body !== 'object') return fallback

  const detail = (body as { detail?: unknown }).detail
  if (typeof detail === 'string' && detail.trim()) return detail

  if (Array.isArray(detail)) {
    const parts = (detail as ValidationItem[])
      .map((item) => {
        const field = Array.isArray(item.loc)
          ? item.loc.filter((p) => p !== 'body').join('.')
          : ''
        const msg = typeof item.msg === 'string' ? item.msg : ''
        return [field, msg].filter(Boolean).join(': ')
      })
      .filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }

  if (detail && typeof detail === 'object') {
    const d = detail as { message?: unknown; blocked_reasons?: unknown }
    const head = typeof d.message === 'string' ? d.message : ''
    const reasons = Array.isArray(d.blocked_reasons)
      ? (d.blocked_reasons as unknown[]).filter((r): r is string => typeof r === 'string')
      : []
    if (head || reasons.length) return [head, ...reasons].filter(Boolean).join('\n')
  }

  const message = (body as { message?: unknown }).message
  if (typeof message === 'string' && message.trim()) return message
  return fallback
}

/** The `blocked_reasons` a refused proposal carries, for listing them apart. */
export function blockedReasonsOf(err: unknown): string[] {
  if (!(err instanceof ApiError)) return []
  const detail = (err.detail as { detail?: unknown })?.detail
  const reasons = (detail as { blocked_reasons?: unknown })?.blocked_reasons
  if (!Array.isArray(reasons)) return []
  return reasons.filter((r): r is string => typeof r === 'string')
}

async function call<T>(
  prefix: string,
  path: string,
  params: QueryParams = {},
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  const method = init.method ?? 'GET'

  let response: Response
  try {
    response = await fetch(`${API_BASE}${prefix}${path}${buildQuery(params)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (err) {
    throw new ApiError(
      'Could not reach the business API. Check your connection and try again.',
      0,
      err,
    )
  }

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message = messageFrom(body, response.statusText || 'The request was refused.')
    // Same behaviour as the other three clients: a rejected token must not be
    // left in place, or a session that died mid-screen stays "signed in".
    if (response.status === 401) reportUnauthorized({ message, path: `${prefix}${path}` })
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

const chanceGet = <T>(path: string, params: QueryParams = {}) =>
  call<T>('/api/chance', path, params)
const chancePost = <T>(path: string, body?: unknown) =>
  call<T>('/api/chance', path, {}, { method: 'POST', body: body ?? {} })

// ══════════════════════════════════════════════════════════════════════════════
//  Shapes — read off the service, not inferred from route names
// ══════════════════════════════════════════════════════════════════════════════

export interface Who {
  uid: string
  name: string
  role: string
}

export type MechanicKind = 'lucky_gift' | 'game' | 'event'
export type MultiplierBasis = 'total_stake' | 'unit_stake'
export type ConfigStatus = 'draft' | 'live' | 'superseded' | 'withdrawn'

/** One row of the table as it is written. Both figures are whole numbers. */
export interface OutcomeRow {
  multiplier_bp: number
  probability_ppm: number
}

/** One row as the server hands it back, already sorted and labelled. */
export interface EvaluatedOutcome extends OutcomeRow {
  index: number
  multiplier: string
  probability_percent: string
  contribution_ppm: number
  label: string
}

/** Stake denominations, in whole diamonds. Spec 8B.2.5. */
export interface StakeRules {
  min_stake: number
  max_stake: number
  step: number
}

export interface RtpBand {
  min_ppm: number
  max_ppm: number
}

export interface EvaluatedRtpBand extends RtpBand {
  min_percent: string
  max_percent: string
}

/** The reserve and the ceilings, as they are written on the draft. Diamonds. */
export interface ExposureDraft {
  reserve_diamonds: number | null
  reserve_basis: string
  max_payout_per_round: number | null
  max_payout_per_player_per_day: number | null
  max_payout_platform_per_day: number | null
}

export interface ReserveGuidanceRow {
  rounds: number
  stake: number
  sigmas: number
  diamonds: number
}

/** The reserve and the ceilings after the server has resolved them. */
export interface ResolvedExposure extends ExposureDraft {
  max_payout_per_round: number
  max_payout_per_round_source: string
  sigma_ppm: number
  sigma_multiplier: string
  variance_numerator: number
  variance_scale: number
  reserve_guidance: ReserveGuidanceRow[]
  note: string
}

/** Effective RTP for one quantity tier. Spec 8B.3.2. */
export interface TierRow {
  quantity: number
  effective_rtp_ppm: number
  effective_rtp_percent: string
  house_edge_ppm: number
  house_edge_percent: string
  in_band: boolean
  min_total_stake: number
  max_total_stake: number
  flags: string[]
}

export interface ProviderRef {
  name: string
  signing_key_id: string
}

export interface RegressionOverride {
  allowed: boolean
  reason: string
}

/** What is sent to the preview and to the proposal. There is no RTP field. */
export interface ConfigDraft {
  outcomes: OutcomeRow[]
  stake: StakeRules
  max_single_win: number
  enabled_countries: string[]
  quantity_tiers: number[]
  multiplier_basis: MultiplierBasis
  rtp_band: RtpBand | null
  deliberate_lower_return_on_larger_plays: boolean
  lower_return_statement: string
  regression_override: RegressionOverride | null
  provider: ProviderRef | null
  exposure: ExposureDraft | null
}

/**
 * What the server says about a draft. `chance.evaluate_draft`.
 *
 * `blocked` is the same flag that refuses the proposal, so a draft that reads
 * blocked here will be refused at `propose` with these exact sentences.
 */
export interface DraftEvaluation {
  outcomes: EvaluatedOutcome[]
  outcome_count: number
  probability_total_ppm: number
  probability_total_percent: string
  rtp_ppm: number
  rtp_percent: string
  rtp_exact: boolean
  rtp_numerator: number
  rtp_scale: number
  house_edge_ppm: number
  house_edge_percent: string
  win_probability_ppm: number
  win_probability_percent: string
  nothing_back_probability_ppm: number
  nothing_back_probability_percent: string
  multiplier_basis: MultiplierBasis
  stake: StakeRules
  quantity_tiers: number[]
  tiers: TierRow[]
  max_single_win: number
  exposure: ResolvedExposure
  enabled_countries: string[]
  rtp_band: EvaluatedRtpBand
  deliberate_lower_return_on_larger_plays: boolean
  lower_return_statement: string
  regression_override: RegressionOverride
  provider: ProviderRef | null
  flags: string[]
  blocked: boolean
  blocked_reasons: string[]
  rounding_note: string
}

export interface ConfigChange {
  field: string
  label?: string
  before: unknown
  after: unknown
  note?: string
}

/** One immutable configuration version. */
export interface ConfigVersion {
  id: string
  mechanic_id: string
  version: number
  status: ConfigStatus
  evaluation: DraftEvaluation
  changes: ConfigChange[]
  card_id: string
  reason: string
  proposed_by: Who
  proposed_at: string
  effective_from: string | null
  signed_by: Who | null
  signed_at: string | null
  superseded_at: string | null
  authority: string
  activated_by?: Who
  activated_at?: string
}

/** The summary a list row carries instead of the whole version. */
export interface ConfigSummary {
  version: number | null
  status: ConfigStatus | null
  rtp_ppm: number | null
  rtp_percent: string | null
  house_edge_percent: string | null
  max_single_win: number | null
  exposure: ResolvedExposure | null
  enabled_countries: string[] | null
  multiplier_basis: MultiplierBasis | null
  tiers: TierRow[] | null
  flags: string[] | null
  effective_from: string | null
  card_id: string | null
  signed_by: Who | null
}

/** One ceiling that bound on a payout. */
export interface BreachedCeiling {
  kind: string
  key: string
  limit: number | null
  label: string
  wanted: number
  granted: number
  day: string | null
}

/** What tripped a suspension, when a ceiling did it. */
export interface SuspensionBreach {
  round_id: string
  player_uid: string
  requested: number
  paid: number
  withheld: number
  day: string
  ceilings: BreachedCeiling[]
}

export interface SuspensionState {
  at: string
  by: Who
  reason: string
  automatic: boolean
  breach: SuspensionBreach | null
}

export interface Mechanic {
  id: string
  kind: MechanicKind
  name: string
  live_version: number | null
  suspended: SuspensionState | null
  created_at: string
  created_by: Who
  updated_at: string
  /** List rows only: a configuration has been signed at some point. */
  configured?: boolean
  /** List rows only: a player could play this right now. */
  live?: boolean
  live_config?: ConfigSummary | null
  /** `GET /mechanics/{id}` only — the last twenty versions. */
  configs?: ConfigVersion[]
  last_resumed?: {
    at: string
    by: Who
    reason: string
    suspension: SuspensionState
    position_at_resume: ExposureHeadline
  }
}

// ── Exposure ──────────────────────────────────────────────────────────────────

export interface ExposureHeadline {
  staked: number
  paid_out: number
  withheld: number
  net: number
  rounds: number
  actual_rtp_ppm: number | null
  reserve: number | null
  headroom: number | null
  reserve_consumed_ppm: number | null
  reserve_consumed_percent: string | null
}

export interface ExposureToday {
  staked: number
  paid_out: number
  withheld: number
  net: number
  rounds: number
  ceiling: number | null
  headroom: number | null
}

export interface ExposureCeilings {
  per_round: number | null
  per_player_per_day: number | null
  platform_per_day: number | null
  all_mechanics_per_day: number | null
}

/**
 * One mechanic's live position. `chance.exposure_for`,
 * `backend/app/services/chance.py:3458`.
 *
 * `headline` is computed from the round records; `control` is the counter the
 * ceilings are actually enforced on. Both are returned side by side so a
 * divergence between the control and the record is visible rather than averaged
 * into one number nobody can check. Every figure is diamonds.
 */
export interface MechanicExposure {
  mechanic_id: string
  name: string
  kind: MechanicKind
  config_version: number | null
  suspended: SuspensionState | null
  day: string
  headline: ExposureHeadline
  today: ExposureToday
  ceilings: ExposureCeilings
  reserve_basis: string | null
  sigma_ppm: number | null
  reserve_guidance: ReserveGuidanceRow[] | null
  control: { staked: number; paid_out: number; net: number; withheld: number }
  still_breached: boolean
}

// ── Monitoring ────────────────────────────────────────────────────────────────

/**
 * One bucket of rounds judged against the exact variance of the signed table.
 * `chance._divergence`, `backend/app/services/chance.py:3673`.
 *
 * Reported as a confidence bound on actual RTP rather than as a percentage gap,
 * and never alerted on below `min_rounds` however extreme it looks.
 */
export interface Divergence {
  rounds: number
  staked: number
  paid_out: number
  net: number
  configured_rtp_ppm: number | null
  configured_rtp_percent: string | null
  actual_rtp_ppm: number | null
  actual_rtp_percent: string | null
  gap_ppm: number | null
  expected_payout: number
  z_milli: number
  z: string
  sigma_threshold_milli: number
  confidence_band_ppm: number
  confidence_low_ppm: number | null
  confidence_high_ppm: number | null
  configured_inside_band: boolean | null
  enough_rounds: boolean
  min_rounds: number
  divergent: boolean
  verdict: string
  /** Per-day rows only. */
  day?: string
  config_versions?: number[]
  capped_rounds?: number
  /** The pooled row only. */
  days?: number
}

export interface RtpDivergenceReport {
  mechanic_id: string
  window_days: number
  since: string
  per_day: Divergence[]
  pooled: Divergence
  /** The three causes 8B.5.2 names. The server does not guess between them. */
  if_divergent: string[]
  note: string
}

export interface AnomalyFinding {
  kind: 'unusual_win_rate' | 'unusual_frequency' | 'impossible_timing' | string
  spec: string
  detail: string
  evidence: Record<string, unknown>
}

export interface PlayerAnomalies {
  player_uid: string
  window_hours: number
  since: string
  rounds: number
  staked: number
  paid_out: number
  net: number
  win_rate: Divergence
  findings: AnomalyFinding[]
  flagged: boolean
  frozen: boolean
  note: string
}

/** The chance freeze flag. `_id` is the player uid, so it arrives as `id`. */
export interface PlayerFreezeFlag {
  id: string
  frozen: boolean
  reason: string
  flagged_at: string
  flagged_by: Who
  evidence: Record<string, unknown> | null
  unfrozen_at: string | null
  unfrozen_by: Who | null
  unfreeze_reason: string | null
  created_at?: string
}

export interface WithheldPayout {
  round_id: string
  mechanic_id: string
  player_uid: string
  withheld: number
  paid: number
  would_have_paid: number | null
  played_at: string
  ceilings_breached: BreachedCeiling[] | null
}

/** Ops' queue. `chance.exception_queue`, `services/chance.py:4276`. */
export interface ExceptionQueue {
  owner: 'ops'
  spec: string
  suspended_mechanics: { mechanic_id: string; name: string; suspended: SuspensionState }[]
  frozen_players: PlayerFreezeFlag[]
  withheld_payouts: WithheldPayout[]
  player_anomalies: PlayerAnomalies[]
  note: string
}

/** Finance's. `chance.margin_report`, `services/chance.py:4326`. */
export interface ChanceMarginRow {
  mechanic_id: string
  name: string
  kind: MechanicKind
  suspended: boolean
  gross_gaming_revenue: number
  staked: number
  paid_out: number
  withheld: number
  reserve: number | null
  headroom: number | null
  reserve_consumed_percent: string | null
  rtp: Divergence
  per_day: Divergence[]
}

export interface ChanceMarginReport {
  owner: 'finance'
  spec: string
  window_days: number
  mechanics: ChanceMarginRow[]
  note: string
}

// ── Player protection ─────────────────────────────────────────────────────────

export type HarmPattern =
  | 'escalating_stakes_after_losses'
  | 'sustained_session'
  | 'rapid_repeat_play'
  | string

export type FlagStatus = 'open' | 'reviewed'

/** The fixed vocabulary a reviewer chooses from. `player_protection.Decision`. */
export type ProtectionDecision =
  | 'no_action'
  | 'contacted_player'
  | 'limit_imposed'
  | 'play_suspended'
  | 'escalated'

export const PROTECTION_DECISIONS: { value: ProtectionDecision; label: string; hint: string }[] = [
  {
    value: 'no_action',
    label: 'No action — looked, and this is ordinary play',
    hint: 'A decision, not a dismissal. It is recorded against your name.',
  },
  {
    value: 'contacted_player',
    label: 'Contacted the player',
    hint: 'Nothing is imposed. Say what was said.',
  },
  {
    value: 'limit_imposed',
    label: 'Limit imposed',
    hint: 'Name the daily or weekly limit below, or nothing was imposed.',
  },
  {
    value: 'play_suspended',
    label: 'Play suspended',
    hint: 'Chance mechanics only, for the number of days below. No balance moves.',
  },
  {
    value: 'escalated',
    label: 'Escalated',
    hint: 'Somebody else decides. Say who, and why.',
  },
]

export interface ProtectionFlag {
  id: string
  flag_id: string
  player_uid: string
  pattern: HarmPattern
  status: FlagStatus
  severity: string
  headline: string
  evidence: Record<string, unknown>
  detected_at: string
  last_seen_at: string
  seen: number
  review: {
    by: Who
    at: string
    decision: ProtectionDecision
    reason: string
    applied: Record<string, unknown>
  } | null
  note: string
  /** Only on the result of `raise_flags`. */
  already_open?: boolean
}

export interface ProtectionWindow {
  window: 'daily' | 'weekly'
  label: string
  limit: number | null
  limit_source: 'house' | 'staff' | 'player' | null
  since: string
  until: string
  resets_at: string
  resets_at_local: string
  timezone: string
  staked: number
  returned: number
  net_loss: number
  rounds: number
  headroom: number | null
}

export type ExclusionStatus = 'none' | 'active' | 'expired' | 'lift_requested' | 'lifted'

export interface SelfExclusion {
  status: ExclusionStatus
  days?: number
  started_at?: string
  minimum_until?: string
  note?: string
  lift_requested_at?: string
  reflection_until?: string
  message: string
  can_be_lifted_by_anyone_now: boolean | null
}

export interface CoolingOff {
  hours?: number
  until: string
  started_at?: string
  note?: string
  until_local: string
}

export interface StaffSuspension {
  until: string
  days: number
  imposed_at: string
  imposed_by: Who
  reason: string
  flag_id: string
  until_local: string
}

export interface SessionState {
  active: boolean
  minutes: number
  rounds: number
  started_at: string | null
  reminder_every_minutes: number
  session_gap_minutes: number
  reminders_sent: number
  reminder_due: { at: string; minutes: number; milestone_minutes: number; message: string } | null
  next_reminder_at: string | null
}

export interface ProtectionRules {
  self_exclusion_minimum_days: number
  self_exclusion_lifts_on_its_own: boolean
  exclusion_reflection_hours: number
  cooling_off_minimum_hours: number
  cooling_off_maximum_days: number
  limit_increase_delay_hours: number
  session_reminder_minutes: number
}

/**
 * One player's protections, as staff see them — the same record the player
 * sees, so a support conversation is about one set of figures.
 * `player_protection.player_status`, `services/player_protection.py:2082`.
 */
export interface ProtectionRecord {
  player_uid: string
  can_play: boolean
  stopped: { message?: string; kind?: string; until?: string; balance_unchanged?: boolean } | null
  daily: ProtectionWindow
  weekly: ProtectionWindow
  limits_apply_to: string
  pending_limit_changes: {
    window?: string
    source?: string
    amount?: number
    effective_from?: string
    effective_from_local: string | null
  }[]
  self_exclusion: SelfExclusion | null
  cooling_off: CoolingOff | null
  staff_suspension: StaffSuspension | null
  session: SessionState
  blocked_plays: number
  timezone: string
  rules: ProtectionRules
  /** Added by `GET /protection/players/{uid}` only. */
  flags?: ProtectionFlag[]
}

// ══════════════════════════════════════════════════════════════════════════════
//  The endpoints
// ══════════════════════════════════════════════════════════════════════════════

export const chance = {
  // ── Reading a configuration — require_internal ──────────────────────────────

  /** Every mechanic, live or not. `chance.py:208`. */
  mechanics: () => chanceGet<Mechanic[]>('/mechanics'),

  /** One mechanic with its last twenty versions attached. `chance.py:221`. */
  mechanic: (id: string) => chanceGet<Mechanic>(`/mechanics/${encodeURIComponent(id)}`),

  /** Every version ever written, newest first. `chance.py:231`. */
  configs: (id: string, limit = 100) =>
    chanceGet<ConfigVersion[]>(`/mechanics/${encodeURIComponent(id)}/configs`, { limit }),

  /** One immutable version. `chance.py:248`. */
  config: (id: string, version: number) =>
    chanceGet<ConfigVersion>(`/mechanics/${encodeURIComponent(id)}/configs/${version}`),

  // ── Writing a configuration ────────────────────────────────────────────────

  /**
   * What this table would do, before anybody signs anything. Writes nothing.
   * `POST /chance/configs/preview`, `chance.py:418` — `require_team_admin`.
   *
   * **This is the only place RTP comes from.** A 200 with `blocked: true` is a
   * draft the server will refuse at proposal; a 400 is a table it cannot read
   * at all (probabilities that do not sum, a stake step that never reaches the
   * maximum, a band that is not a band).
   */
  preview: (draft: ConfigDraft) => chancePost<DraftEvaluation>('/configs/preview', draft),

  /** Create a mechanic. It starts with no configuration and no market. */
  createMechanic: (body: { mechanic_id: string; kind: MechanicKind; name: string; reason: string }) =>
    chancePost<Mechanic>('/mechanics', body),

  /** Stage 1 of 5 — raise the card. `chance.py:457`. */
  propose: (id: string, draft: ConfigDraft, reason: string) =>
    chancePost<{ card: Card; config: ConfigVersion }>(
      `/mechanics/${encodeURIComponent(id)}/configs`,
      { draft, reason },
    ),

  /** Stage 5 of 5 — owners only, and only once the card is signed. */
  activate: (cardId: string) =>
    chancePost<ConfigVersion>(`/configs/${encodeURIComponent(cardId)}/activate`),

  /** Switch one market off now. Owner only, effective immediately. */
  withdrawCountry: (id: string, country: string, reason: string) =>
    chancePost<ConfigVersion>(`/mechanics/${encodeURIComponent(id)}/withdraw-country`, {
      country,
      reason,
    }),

  // ── Exposure and the stops ─────────────────────────────────────────────────

  exposure: () => chanceGet<MechanicExposure[]>('/exposure'),

  mechanicExposure: (id: string) =>
    chanceGet<MechanicExposure>(`/mechanics/${encodeURIComponent(id)}/exposure`),

  /** Team admin. Makes a mechanic less available; can never make one payable. */
  suspend: (id: string, reason: string) =>
    chancePost<{ mechanic_id: string; suspended: SuspensionState | null; already_suspended: boolean }>(
      `/mechanics/${encodeURIComponent(id)}/suspend`,
      { reason },
    ),

  /** Owner only. There is no timer anywhere that does this. */
  resume: (id: string, reason: string) =>
    chancePost<{
      mechanic_id: string
      suspended: null
      resumed_by: Who
      reason: string
      position: ExposureHeadline
      still_breached: boolean
    }>(`/mechanics/${encodeURIComponent(id)}/resume`, { reason }),

  // ── Monitoring ─────────────────────────────────────────────────────────────

  rtp: (id: string, days = 7) =>
    chanceGet<RtpDivergenceReport>(`/mechanics/${encodeURIComponent(id)}/rtp`, { days }),

  exceptions: (hours = 24) => chanceGet<ExceptionQueue>('/exceptions', { hours }),

  margin: (days = 7) => chanceGet<ChanceMarginReport>('/margin', { days }),

  playerAnomalies: (uid: string, hours = 24) =>
    chanceGet<PlayerAnomalies>(`/players/${encodeURIComponent(uid)}/anomalies`, { hours }),

  /**
   * Pause a player's chance activity pending review. **No balance moves, no
   * settled round is reversed, and the account is not banned.** `chance.py:1145`.
   */
  freeze: (uid: string, reason: string, evidence?: Record<string, unknown>) =>
    chancePost<PlayerFreezeFlag & { player_uid: string }>(
      `/players/${encodeURIComponent(uid)}/freeze`,
      { reason, evidence: evidence ?? null },
    ),

  unfreeze: (uid: string, reason: string) =>
    chancePost<{ player_uid: string; frozen: false; reviewed_by: Who; reason: string }>(
      `/players/${encodeURIComponent(uid)}/unfreeze`,
      { reason },
    ),

  // ── Player protection ──────────────────────────────────────────────────────

  flags: (params: { status?: FlagStatus | ''; player_uid?: string; limit?: number } = {}) =>
    chanceGet<ProtectionFlag[]>('/protection/flags', {
      status: params.status || undefined,
      player_uid: params.player_uid || undefined,
      limit: params.limit,
    }),

  protectionRecord: (uid: string) =>
    chanceGet<ProtectionRecord>(`/protection/players/${encodeURIComponent(uid)}`),

  /** A named person records a decision. The reason is mandatory. */
  reviewFlag: (
    flagId: string,
    body: {
      decision: ProtectionDecision
      reason: string
      daily_limit?: number | null
      weekly_limit?: number | null
      suspend_days?: number | null
    },
  ) =>
    chancePost<ProtectionFlag & { applied: Record<string, unknown> }>(
      `/protection/flags/${encodeURIComponent(flagId)}/review`,
      body,
    ),

  /** Staff impose a loss limit. The player can go below it, never above. */
  imposeLimits: (uid: string, body: { daily?: number | null; weekly?: number | null; reason: string }) =>
    chancePost<ProtectionRecord>(`/protection/players/${encodeURIComponent(uid)}/limits`, body),

  /** The only route that can reopen a served self-exclusion. */
  decideLift: (uid: string, approve: boolean, reason: string) =>
    chancePost<ProtectionRecord>(
      `/protection/players/${encodeURIComponent(uid)}/self-exclusion/decide`,
      { approve, reason },
    ),
}

// ══════════════════════════════════════════════════════════════════════════════
//  The board, for the one thing a configuration screen needs from it
// ══════════════════════════════════════════════════════════════════════════════
//
// A configuration change is a card, and the five stages live on the money board
// (Part 5). There is no `GET /cards/{id}` in this API, so the only way to find
// out where a pending change has got to is to read the board and match on the
// id the configuration version carries. `cards.board_for`
// (`backend/app/services/cards.py:409`) scopes that read: owners and the
// Observer see every team, a team admin sees their own team only. A chance
// configuration card is raised on the **App** team's board
// (`chance.propose_config`), so a Finance or Ops admin will not find it — and
// the screen says exactly that rather than showing an empty stage.

/** The board as this caller may read it, newest first. */
export const board = {
  cards: (limit = 200) => call<Card[]>('/api/cards', '', { limit }),
}

export const CARD_STAGES: { stage: string; label: string; blurb: string }[] = [
  { stage: 'requested', label: 'Raised', blurb: 'Written by the team. Nothing is live.' },
  { stage: 'under_review', label: 'Under review', blurb: 'A second person is checking it.' },
  { stage: 'awaiting_signoff', label: 'Verified', blurb: 'Waiting for an owner to sign.' },
  { stage: 'approved', label: 'Signed', blurb: 'An owner signed. Not live until activated.' },
  { stage: 'executed', label: 'Live', blurb: 'Every new round is drawn from this version.' },
]

/** Where a card is in the five stages, or -1 when it was rejected or failed. */
export function stageIndex(stage: string | null | undefined): number {
  if (!stage) return -1
  return CARD_STAGES.findIndex((s) => s.stage === stage)
}

// ══════════════════════════════════════════════════════════════════════════════
//  Formatting — display only, and never arithmetic on a measured figure
// ══════════════════════════════════════════════════════════════════════════════

const COUNT = new Intl.NumberFormat('en-IN')

/** A whole number of diamonds. Null is "—", never 0. */
export function diamonds(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return COUNT.format(n)
}

/** Any whole count. Same refusal on null. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return COUNT.format(n)
}

/**
 * Parts per million as a percentage, for a figure the server did not already
 * render. Where the server sent a `*_percent` string, show that string — it is
 * the one it computed and the one it will quote back.
 */
export function ppmPercent(ppm: number | null | undefined, digits = 2): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return '—'
  return `${(ppm / 10_000).toFixed(digits)}%`
}

/** Basis points as a multiplier: 170000 → "17×". */
export function bpMultiplier(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—'
  const value = bp / MULTIPLIER_ONE
  return `${Number.isInteger(value) ? value : Number(value.toFixed(4))}×`
}

/** A percentage the server sent as a bare number (the reports do this). */
export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

/** A signed percentage change, for the cannibalisation comparison. */
export function signedPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—'
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return value
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const KIND_LABELS: Record<string, string> = {
  lucky_gift: 'Lucky gift',
  game: 'Game',
  event: 'Event',
}

export const PATTERN_LABELS: Record<string, string> = {
  escalating_stakes_after_losses: 'Escalating stakes after losses',
  sustained_session: 'Sustained session',
  rapid_repeat_play: 'Rapid repeat play',
}

/**
 * How a mechanic actually stands, in one word, for a screen that must never
 * let a stopped mechanic look running.
 */
export type MechanicState = 'live' | 'suspended' | 'unconfigured' | 'no_market'

export function mechanicState(m: Mechanic): MechanicState {
  if (m.suspended) return 'suspended'
  if (m.live_version === null || m.live_version === undefined) return 'unconfigured'
  if (!(m.live_config?.enabled_countries?.length ?? 0)) return 'no_market'
  return 'live'
}

export const STATE_TEXT: Record<MechanicState, { label: string; blurb: string }> = {
  live: {
    label: 'Live',
    blurb: 'Playable now in the markets listed. Every new round draws from the live version.',
  },
  suspended: {
    label: 'Suspended',
    blurb:
      'Pays nothing and accepts nothing. A player sees exactly what they would see if it had never been built in their country. Only an owner can resume it, with a reason.',
  },
  unconfigured: {
    label: 'Never configured',
    blurb:
      'No configuration has ever been signed, so it is invisible everywhere. This is not the same as switched off.',
  },
  no_market: {
    label: 'No market',
    blurb:
      'A configuration is live but no country is enabled, so no player can see it. A valid configuration, and the default.',
  },
}

// ══════════════════════════════════════════════════════════════════════════════
//  The three chance reports — /api/reports, Finance's view in rupees
// ══════════════════════════════════════════════════════════════════════════════
//
// `/chance/*` above is Ops' live view in diamonds. These are Finance's, over a
// stated window, in INR minor units, with a CSV that is logged before it is
// issued (`backend/app/routers/reports.py:270-345`).

async function getReport<T>(path: string, params: QueryParams): Promise<T> {
  return call<T>('/api/reports', path, params)
}

export interface ChanceRevenueRow {
  scope:
    | 'mechanic_country_day'
    | 'mechanic_total'
    | 'country_total'
    | 'kind_total'
    | 'gross_gaming_revenue'
    | 'partner_share'
    | 'ledger_evidence'
    | 'withheld_exception'
    | 'manual_adjustment'
  day: string
  mechanic_id: string
  mechanic: string | null
  kind: string | null
  country: string
  rounds: number | null
  players: number | null
  staked_diamonds: number | null
  paid_out_diamonds: number | null
  ggr_diamonds: number | null
  ggr_inr_minor: number | null
  ggr_inr: number | null
  staked_inr_minor: number | null
  paid_out_inr_minor: number | null
  actual_rtp_percent: number | null
  configured_rtp_percent: number | null
  rtp_gap_pp: number | null
  withheld_diamonds: number | null
  capped_rounds: number | null
  config_versions: number[]
  detail: string
}

export interface ChanceRevenueTotals {
  revenue_line: string
  reported_separately_from: string[]
  staked_diamonds: number
  paid_out_diamonds: number
  ggr_diamonds: number
  ggr_inr_minor: number
  ggr_inr: number | null
  staked_inr_minor: number
  paid_out_inr_minor: number
  actual_rtp_percent: number | null
  rounds: number
  players: number | null
  capped_rounds: number
  withheld_diamonds: number
  withheld_unsettled_diamonds: number
  mechanics_reported: string[]
  countries_reported: string[]
  mechanics_sourced: boolean
  host_or_agency_share_movements: number | null
  host_or_agency_share_diamonds: number | null
  host_or_agency_share_configured: boolean | null
  stake_ledger_movements: number | null
  payout_ledger_movements: number | null
  manual_adjustment_cards: number | null
  ggr_sum_of_rows_inr_minor: number
}

export type ChanceRevenueReport = ReportEnvelope<ChanceRevenueRow, ChanceRevenueTotals>

/**
 * One margin line. The two ratios are different numbers and are labelled as the
 * server labels them:
 *
 *   `bean_creation_rate_pct` — "Bean creation rate % (units)". Beans created
 *     per diamond consumed. This is what 8B.8.3's 50% / 5% / none refers to.
 *   `bean_payout_ratio_pct` — "Bean-payout ratio % (value)". The rupee value of
 *     the beans against the rupee value of the diamonds.
 *
 * They are not interchangeable and collapsing them loses the comparison the
 * reference rate exists for.
 */
export interface ChanceMarginRowReport {
  mechanic: string
  label: string
  kind: string
  store: string
  basis: string
  diamonds_consumed: number | null
  diamond_value_inr_minor: number | null
  diamond_value_inr: number | null
  beans_created: number | null
  bean_cash_cost_inr_minor: number | null
  bean_cash_cost_inr: number | null
  bean_creation_rate_pct: number | null
  reference_bean_creation_pct: number | null
  variance_from_reference_pp: number | null
  bean_payout_ratio: number | null
  bean_payout_ratio_pct: number | null
  diamonds_per_bean: number | null
  diamond_value_per_inr_of_bean_payout: number | null
  detail: string
}

export interface ChanceMarginTotals {
  diamonds_consumed: number
  diamond_value_inr_minor: number
  beans_created: number
  bean_cash_cost_inr_minor: number
  bean_cash_cost_inr: number | null
  bean_creation_rate_pct: number | null
  bean_payout_ratio_pct_created_basis: number | null
  bean_payout_ratio_realised: number | null
  bean_payout_ratio_pct_realised: number | null
  realised_basis: Record<string, number> | null
  highest_margin_mechanic: string | null
  highest_margin_mechanic_kind: string | null
  highest_margin_ratio_pct: number | null
  mechanics_creating_no_bean: string[]
  reference: Record<string, number>
  gifts_sourced: boolean
  calls_sourced: boolean
  rounds_sourced: boolean
  mechanics_sourced: boolean
}

export type ChanceMarginReportEnvelope = ReportEnvelope<ChanceMarginRowReport, ChanceMarginTotals>

export interface CannibalisationRow {
  metric: string
  label: string
  value: number | string | null
  unit: string
  value_inr: number | null
  previous: number | string | null
  previous_inr: number | null
  change_pct: number | null
  spec: string
  detail: string
}

export type CannibalisationVerdict =
  | 'ecosystem_being_consumed'
  | 'healthy'
  | 'host_earnings_falling'
  | 'no_displacement'

export interface CannibalisationTotals {
  comparison_period: { since: string; until: string; days: number; note: string }
  host_earnings_inr_minor: number | null
  host_earnings_previous_inr_minor: number | null
  host_earnings_change_pct: number | null
  active_hosts: number | null
  active_hosts_previous: number | null
  host_earnings_per_active_host_inr_minor: number | null
  host_earnings_per_active_host_previous_inr_minor: number | null
  game_revenue_inr_minor: number | null
  game_revenue_previous_inr_minor: number | null
  game_revenue_change_pct: number | null
  game_staked_diamonds: number | null
  game_paid_out_diamonds: number | null
  gift_diamonds: number | null
  call_diamonds: number | null
  diamond_spend_total: number | null
  diamond_spend_share_games_pct: number | null
  diamond_spend_share_gifting_pct: number | null
  game_winnings_diamonds: number | null
  winnings_spent_on_hosts_diamonds: number | null
  winnings_recycled_into_games_diamonds: number | null
  winnings_spent_on_hosts_pct: number | null
  first_time_gifters: number | null
  first_gift_lookback_days: number
  retained_non_spenders: number | null
  retained_non_spenders_no_recharge: number | null
  players_who_played: number | null
  players_who_won: number | null
  /** Null when the preceding period could not be compared. Never "healthy". */
  verdict: CannibalisationVerdict | null
  verdict_text: string
  steady_band_pct: number
  hosts_sourced: boolean
  rounds_sourced: boolean
  players_sourced: boolean
  gifts_sourced: boolean
}

export type CannibalisationReport = ReportEnvelope<CannibalisationRow, CannibalisationTotals>

export interface ChanceRange {
  since?: string
  until?: string
}

export const chanceReports = {
  /** GGR per mechanic, per country, per day, with actual RTP alongside. */
  revenue: (p: ChanceRange = {}) => getReport<ChanceRevenueReport>('/chance-revenue', { ...p }),

  /** Bean-payout ratio per mechanic against the 50% / 5% / none reference. */
  margin: (p: ChanceRange = {}) =>
    getReport<ChanceMarginReportEnvelope>('/chance-margin', { ...p }),

  /** Are the games feeding the host economy or eating it? */
  cannibalisation: (p: ChanceRange = {}) =>
    getReport<CannibalisationReport>('/cannibalisation', { ...p }),
}
