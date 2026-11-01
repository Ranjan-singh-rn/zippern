import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RtcTokenBuilder, RtcRole } = require('agora-access-token')

admin.initializeApp()

const db = admin.firestore()

// All Firestore triggers must run in the same region as the database.
//
// This said `asia-east1` — the region of the OLD project's database — until the
// move to zipper-83816, whose Firestore is in `asia-south1` (Mumbai). A 1st-gen
// Firestore trigger in the wrong region still *deploys*, reports success and
// then never fires, which would have silently killed agency approval emails,
// seller approval emails, recharge processing and payout notifications with no
// error anywhere. If the database region ever changes again, change this line
// in the same breath.
//
// Scheduled functions run in us-central1 (required for Cloud Scheduler).
import {
  isPubliclyVisible,
  publicViewChanged,
  toPublicSeller,
} from './publicSeller'
import { type CrmUserDoc, syncClaim } from './storageClaims'
import { assertActiveSession } from './mobileSession'
import { activeHostRefusal } from './hostEligibility'
import { rosterRowIsCurrent } from './roster'
import { SENDGRID_KEY_ENV, escapeHtml, mailDomain, sendNotificationMail } from './mail'

const asiaFirestore = functions.region('asia-south1').firestore
// The Firestore triggers that send email: the same region, plus the SendGrid
// key from Secret Manager (see mail.ts). Every other trigger keeps the builder
// above, so no other function is given the key.
const asiaFirestoreMail = functions.region('asia-south1').runWith({ secrets: [SENDGRID_KEY_ENV] }).firestore

// ── Email via SendGrid ────────────────────────────────────────────────────────
// Everything about the provider is in mail.ts. The key is the Secret Manager
// secret ZIPPER_SENDGRID_API_KEY, which only the functions that send email
// declare. The contract is the one this function always had: no key → logged
// and skipped; a failed send throws — now a sanitized error, because the SDK's
// own error for a network failure carries the request headers, key included.

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  await sendNotificationMail(to, subject, html)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. WEEKLY PAYOUT REPORT GENERATOR
//    Scheduled: every Sunday at 23:59 IST (18:29 UTC)
//    Cron: "29 18 * * 0"
//
//    THIS FUNCTION GENERATES THE REPORT **AND** ACCRUES COMMISSION — but it
//    does not compute a single rupee of it. It asks the API, which computes the
//    figure from the ledger. See section 1a below for the call it makes.
//
//    REMOVED — and deliberately not replaced with another local calculation:
//      * `MAIN_AGENCY_SLABS` / `SUB_AGENCY_SLABS`, a hardcoded slab table
//        starting at `from: 0` with rates 5/8/10/12/14/16/18/21/23/25 (main)
//        and 5/8/10/13/16/18/21/23/25 (sub).
//      * `calcProgressiveCommission()`, which walked that table slice by slice.
//      * `agencies/{id}.update({ commissionBalance: increment(commissionInr) })`
//
//    WHY IT IS GONE. Three separate things were wrong, and any one of them on
//    its own would be enough to stop the write:
//
//      * **The rule was wrong.** Commission is *flat rate by band*: the agency's
//        total billing for the period selects one band, and that band's rate
//        applies to the whole amount. It is not progressive — no part of the
//        billing is charged at a lower band's rate. See `RULE` in
//        backend/app/services/commission.py and the cases in
//        backend/tests/test_commission.py.
//      * **The table was wrong.** It began at `from: 0`, so it had no floor, and
//        it carried rates that appear nowhere else in the system. The live table
//        in `appConfig/economy` → `commissionConfig` starts at ₹25,001 (main) /
//        ₹26,001 (sub) and runs 5 / 7.5 / 10 / 14 / 16 / 18 / 21 / 23 / 25.
//        Below the floor an agency earns ₹0; this function paid 5% of ₹10,000.
//      * **The write was wrong.** `increment()` moved a liability straight into
//        Firestore with no ledger entry, no audit entry, no derivation anyone
//        could read back, and no idempotency — so a re-run accrued the same week
//        again.
//
//    WHAT MUST RUN INSTEAD, per approved + active agency, once per week:
//
//      POST /api/partner-ops/agencies/{agencyId}/commission-accruals
//        { "period": "<the weekLabel this report is filed under, e.g. 2026-W33>",
//          "reason": "Weekly accrual" }
//
//      The server derives billing from the ledger for that period, picks the
//      band from the live slab table, applies the band rate to the whole figure,
//      and records the full derivation in the audit log. It is idempotent on
//      agency + host + period, so re-running a week cannot accrue it twice. Any
//      `amount_minor` in the body is a *check*, never a setting — the request is
//      refused if it disagrees with what the ledger says.
//
//      Check a figure first, crediting nothing, with:
//      GET /api/partner-ops/agencies/{agencyId}/commission-preview?period=…
//
//      Note that the period *label* is what the server acts on. `resolve_period`
//      turns "2026-W33" into that ISO week's own [Mon, Mon) window from the
//      ledger — it does not inherit the rolling last-7-days window this report
//      uses for host eligibility. The two need not line up to the second, and
//      the server's window is the one that decides commission.
//
//    HOW IT CALLS IT NOW. The blocker used to be identity: every dependency in
//    backend/app/core/deps.py resolved a person holding a session JWT, and this
//    function cannot mint one. That is no longer true. The backend now carries
//    exactly one machine identity — `WEEKLY_ACCRUAL` in
//    backend/app/core/security.py — and it is deliberately narrow:
//
//      * It is presented as an `X-Service-Key` header, read by exactly two
//        dependencies (`team_admin_or_accrual_service`,
//        `internal_or_accrual_service`) and by nothing else in the API.
//      * It carries an explicit allowlist of two operations,
//        `commission.accrue` and `commission.preview`. It is not a role and it
//        does not widen when a route is added.
//      * It cannot move cash. Every `/execute` and `/approve` route is still
//        `Depends(require_owner)` and no owner route accepts the header. This
//        function can create a liability; only an owner can pay one.
//      * It is audited as itself — `system:weekly-accrual`, role `system` —
//        never under a person's name.
//
//    The key reaches this function's runtime from Google Secret Manager (see
//    DEPLOYMENT.md § 8) and is read from `process.env.ZIPPER_ACCRUAL_KEY`. It is
//    never hardcoded, never written to functions/.env, never logged, never put
//    in the report document and never put in the email. Everything this function
//    writes out of an API response goes through `withoutKey()` first, so even a
//    backend that echoed the header back could not leak it through here.
//
//    SO: accrual RUNS, per agency, every Sunday. Section 1a is the client; the
//    weekly job calls `runWeeklyAccrual()` after the report document is written,
//    then merges the per-agency truth back onto it. Writing the report first is
//    deliberate: a missing key or an unreachable backend must never cost the
//    business its payout report.
// ─────────────────────────────────────────────────────────────────────────────

/** The only call that may create an agency commission liability. */
const ACCRUAL_ENDPOINT =
  'POST /api/partner-ops/agencies/{agencyId}/commission-accruals  { period, reason }'

// Economy thresholds live in Firestore `appConfig/economy`, edited from the CRM
// Economy Config page. They are read, not hardcoded: this function used to
// filter hosts at a hardcoded ₹1,000 while the live config said ₹2,000, so the
// weekly report listed hosts the business does not actually pay.
//
// These two are the documented values from the 2026-08-20 backup and are used
// only when the config cannot be read. A report built on them is marked
// provisional so nobody mistakes a fallback for the live threshold.
const FALLBACK_MIN_HOST_PAYOUT_INR = 2_000   // appConfig/economy.weeklyMinPayoutInr
const FALLBACK_BEAN_TO_INR_RATE = 0.01       // appConfig/economy.giftRates.beanToInrRate

interface EconomySettings {
  minHostPayoutInr: number
  beanToInrRate: number
  /** True when any value below came from the fallback rather than the config. */
  provisional: boolean
  note: string
}

async function readEconomySettings(): Promise<EconomySettings> {
  const fallback = (reason: string): EconomySettings => ({
    minHostPayoutInr: FALLBACK_MIN_HOST_PAYOUT_INR,
    beanToInrRate: FALLBACK_BEAN_TO_INR_RATE,
    provisional: true,
    note: `PROVISIONAL — ${reason} Documented fallbacks were used: ` +
      `≥ ₹${FALLBACK_MIN_HOST_PAYOUT_INR} per host per week, ` +
      `₹${FALLBACK_BEAN_TO_INR_RATE} per bean.`,
  })

  let data: FirebaseFirestore.DocumentData | undefined
  try {
    const snap = await db.collection('appConfig').doc('economy').get()
    data = snap.exists ? snap.data() : undefined
  } catch (err) {
    functions.logger.error('Could not read appConfig/economy:', err)
    return fallback('appConfig/economy could not be read.')
  }
  if (!data) return fallback('appConfig/economy does not exist.')

  const rawMin = data.weeklyMinPayoutInr
  const giftRates = data.giftRates as Record<string, unknown> | undefined
  const rawBean = giftRates?.beanToInrRate

  const minOk = typeof rawMin === 'number' && Number.isFinite(rawMin) && rawMin >= 0
  const beanOk = typeof rawBean === 'number' && Number.isFinite(rawBean) && rawBean > 0

  if (!minOk && !beanOk) {
    return fallback('appConfig/economy holds neither weeklyMinPayoutInr nor giftRates.beanToInrRate.')
  }
  if (!minOk) {
    return {
      minHostPayoutInr: FALLBACK_MIN_HOST_PAYOUT_INR,
      beanToInrRate: rawBean as number,
      provisional: true,
      note: 'PROVISIONAL — appConfig/economy has no usable weeklyMinPayoutInr; ' +
        `₹${FALLBACK_MIN_HOST_PAYOUT_INR} was assumed for host eligibility.`,
    }
  }
  if (!beanOk) {
    return {
      minHostPayoutInr: rawMin as number,
      beanToInrRate: FALLBACK_BEAN_TO_INR_RATE,
      provisional: true,
      note: 'PROVISIONAL — appConfig/economy has no usable giftRates.beanToInrRate; ' +
        `₹${FALLBACK_BEAN_TO_INR_RATE} per bean was assumed.`,
    }
  }

  return {
    minHostPayoutInr: rawMin as number,
    beanToInrRate: rawBean as number,
    provisional: false,
    note: `Read from appConfig/economy — host eligibility ≥ ₹${rawMin as number}/week, ` +
      `₹${rawBean as number} per bean.`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1a. THE ACCRUAL CLIENT
//
//     Everything below talks to the API on behalf of the weekly job. It holds
//     no commission arithmetic of any kind — deliberately. The server derives
//     billing from the ledger, picks the band from the live slab table and
//     applies the rate; this file's entire job is to ask, once per agency, and
//     to record honestly what the answer was.
//
//     Four things it is built around, because nobody is watching on a Sunday
//     night and a job that fails quietly is worse than one that does not run:
//
//       1. **One agency's failure is one agency's failure.** Every call is
//          wrapped; a throw is turned into a recorded outcome and the loop
//          carries on. Fifty agencies do not go unaccrued because the third
//          one 500s.
//       2. **A re-run credits nothing twice.** The API keys each movement
//          `commission:{agency}:{host}:{period}` and, when every host's leg of
//          a period is already on the books, answers `already_accrued` (see
//          `AccrualOutcome` and `ALREADY_ACCRUED_MARKER` in
//          backend/app/routers/partner_ops.py). That is SUCCESS here, not a
//          failure — the week is accrued, and accrued exactly once.
//       3. **Preview before accrue.** Every agency is previewed first, and the
//          figure is checked against a sanity bound and against the API's own
//          "provisional" flag before anything is credited. The server applies
//          the same two checks itself; doing them here as well means an
//          implausible week is refused before a write is even requested.
//       4. **The key never escapes.** It is read from the environment, put in
//          one header, and every string that comes back out is passed through
//          `withoutKey()` before it can reach a log, the report document or the
//          email.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The service key, from Google Secret Manager via `runWith({ secrets })`.
 * Never a literal in this file, never in functions/.env, never logged.
 */
const ACCRUAL_KEY_ENV = 'ZIPPER_ACCRUAL_KEY'

/** Origin of the API — the Cloud Run URL, or the Hosting origin in front of it. */
const API_BASE_ENV = 'ZIPPER_API_BASE_URL'

/** backend/app/core/deps.py → SERVICE_KEY_HEADER. The only header it goes in. */
const SERVICE_KEY_HEADER = 'X-Service-Key'

/**
 * backend/app/core/security.py → MIN_SERVICE_KEY_CHARS. A shorter value is
 * treated as unset *by the API*, so it is treated as unset here too rather
 * than being sent and refused fifty times.
 */
const MIN_SERVICE_KEY_CHARS = 32

/**
 * backend/app/config.py → `service_accrual_max_minor` (₹12,50,000 in paise).
 *
 * The server's bound is the one that governs; this copy exists so an
 * implausible figure is refused *before* a write is requested, and so the email
 * can say which agency and how much. If the two ever disagree the server wins —
 * it refuses with `refused_sanity_bound` and nothing is credited either way.
 */
const SANITY_BOUND_MINOR = 125_000_000

/** One HTTP call gets this long. A hung backend must not eat the whole run. */
const REQUEST_TIMEOUT_MS = 25_000

/**
 * The whole accrual phase gets this long. The function is deployed with a 540s
 * timeout; leaving headroom means agencies that could not be reached in time
 * are *reported as unattempted* rather than lost when the runtime kills us.
 */
const ACCRUAL_BUDGET_MS = 420_000

type AccrualOutcome =
  /** Credited this run. */
  | 'accrued'
  /** Already on the books for this period — a safe re-run. Success. */
  | 'already_accrued'
  /** A real zero: billing below the slab floor. Normal, not a failure. */
  | 'nothing_to_accrue'
  /** Above the sanity bound. Nothing credited; a person must look. */
  | 'refused_sanity_bound'
  /** The slab table could not be read live. Nothing credited; a person must look. */
  | 'refused_provisional_slabs'
  /** The call errored. Nothing credited; a person must look. */
  | 'failed'
  /** The run ran out of its time budget before reaching this agency. */
  | 'not_attempted'

interface AgencyAccrualResult {
  agencyId: string
  agencyName: string
  outcome: AccrualOutcome
  /** Is this period's commission on the books for this agency? */
  accrued: boolean
  /** Does this line need a human before the week can be called done? */
  needsPerson: boolean
  /** What the period is worth, from the preview. Null if the preview failed. */
  commissionMinor: number | null
  /** What this call actually moved. Zero on a re-run — that is correct. */
  creditedMinor: number | null
  /** Who declined: the API, or this function's own pre-check. */
  refusedBy: 'server' | 'cloud-function' | null
  httpStatus: number | null
  /** Plain English, safe to email. Never contains the key. */
  detail: string
}

interface AccrualRun {
  /** Did any accrual call actually happen? */
  ran: boolean
  status:
    | 'completed'
    | 'completed_with_failures'
    | 'skipped_not_configured'
    | 'failed'
  /** Why it was skipped or failed outright. Never contains the key. */
  reason: string
  period: string
  results: AgencyAccrualResult[]
  accruedCount: number
  alreadyAccruedCount: number
  nothingToAccrueCount: number
  needsPersonCount: number
  totalCreditedMinor: number
  /** The API refused the credential itself — the two sides have drifted. */
  credentialRejected: boolean
  ranAt: FirebaseFirestore.Timestamp | null
}

/**
 * Where the API is, and the credential to present to it.
 *
 * Shared by both credentials — the accrual one below and the reporting one in
 * section 12 — because the transport is identical and only the key differs.
 * `callApi` is therefore written once and neither credential can pick up a
 * behaviour (a timeout, a redaction) the other does not have.
 */
interface ServiceApiConfig {
  baseUrl: string
  key: string
}

/**
 * Read the configuration a service credential needs, or say precisely what is
 * missing.
 *
 * The returned `problem` is written to be read — in an email, or in a Cloud
 * Logging entry — by somebody who has to fix it. It names environment
 * variables and says what each one is for; it never contains a value, and in
 * particular it never contains the key, not even a prefix of it.
 *
 * A job that cannot run has to fail on this and say which variable is missing.
 * The alternative — carrying on with an empty header and collecting 401s — is
 * how "the reports stopped arriving" becomes a week of guessing.
 */
function readServiceConfig(
  keyEnv: string,
  purpose: string,
): { config: ServiceApiConfig | null; problem: string } {
  const key = (process.env[keyEnv] || '').trim()
  const base = (process.env[API_BASE_ENV] || '').trim()
  const problems: string[] = []

  if (!key) {
    problems.push(
      `${keyEnv} is not set on this function, so it holds no credential to ` +
      `${purpose} with. Grant it with: firebase functions:secrets:set ${keyEnv}`
    )
  } else if (key.length < MIN_SERVICE_KEY_CHARS) {
    problems.push(
      `${keyEnv} is set but is shorter than ${MIN_SERVICE_KEY_CHARS} ` +
      'characters, which the API treats as unset — every call would be refused'
    )
  }

  if (!base) {
    problems.push(`${API_BASE_ENV} is not set, so there is no backend to call`)
  } else if (!/^https:\/\//i.test(base)) {
    problems.push(
      `${API_BASE_ENV} is '${base}', which is not an https:// URL — a service ` +
      'key is never sent over plain http'
    )
  }

  if (problems.length > 0) {
    return { config: null, problem: problems.join('; ') + '.' }
  }
  return { config: { baseUrl: base.replace(/\/+$/, ''), key }, problem: '' }
}

/** The weekly accrual's own configuration. Section 1a. */
function readAccrualConfig(): { config: ServiceApiConfig | null; problem: string } {
  return readServiceConfig(ACCRUAL_KEY_ENV, 'accrue')
}

/**
 * Scrub the key out of anything on its way to a log, Firestore or an email.
 *
 * Nothing is expected to echo it back. This is the belt to that braces: the one
 * value that must never appear in output is removed from every string that
 * leaves this module, whatever produced it.
 */
function withoutKey(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('[redacted]')
}

interface ApiResult {
  ok: boolean
  status: number | null
  body: Record<string, unknown> | null
  /** Transport-level failure — unreachable, timed out, unparseable. */
  error: string
  /**
   * RF-30: no answer within the timeout. The request may still have been
   * carried out by the API, so for a write the outcome is UNKNOWN, not failed.
   */
  timedOut?: boolean
}

/** One API call, with a timeout, returning a result rather than throwing. */
async function callApi(
  config: ServiceApiConfig,
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>,
): Promise<ApiResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        [SERVICE_KEY_HEADER]: config.key,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    })

    let body: Record<string, unknown> | null = null
    let raw = ''
    try {
      raw = await response.text()
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    } catch {
      body = null
    }

    if (!response.ok && body === null) {
      return {
        ok: false,
        status: response.status,
        body: null,
        error: withoutKey(
          `HTTP ${response.status} with a non-JSON body: ` +
          `${raw.slice(0, 300) || '(empty)'}`,
          config.key,
        ),
      }
    }
    return { ok: response.ok, status: response.status, body, error: '' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: null,
      body: null,
      error: withoutKey(
        timedOut
          ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
          : `the backend could not be reached — ${message}`,
        config.key,
      ),
      timedOut,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** FastAPI puts a refusal in `detail` — a string, or an object with `message`. */
function apiMessage(body: Record<string, unknown> | null): string {
  if (!body) return ''
  const detail = body.detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object') {
    const message = (detail as Record<string, unknown>).message
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(detail)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The machine-readable part of an API refusal, when it carries one — today the
 * approved contact rule's `CONTACT_REQUIRED` (backend `ContactRequired`):
 * `{code, requirement, missing, emailUnverified}`. Only these fields, and only
 * when `code` is a string, so nothing else from the API body reaches the app.
 */
function apiRefusalDetails(body: Record<string, unknown> | null): Record<string, unknown> | null {
  const detail = body?.detail
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (typeof d.code !== 'string' || d.code === '') return null
  return {
    code: d.code,
    requirement: typeof d.requirement === 'string' ? d.requirement : '',
    missing: Array.isArray(d.missing) ? d.missing.map((m) => String(m)) : [],
    emailUnverified: d.emailUnverified === true,
    // Decision 15 (RC): an address on the account that is not PROVED yet
    // (for example a CRM login whose credentials email was only sent).
    emailUnproved: d.emailUnproved === true,
  }
}

/** The `outcome` a 409 refusal classifies itself with, if it carried one. */
function apiRefusalOutcome(body: Record<string, unknown> | null): string {
  const detail = body?.detail
  if (detail && typeof detail === 'object') {
    const outcome = (detail as Record<string, unknown>).outcome
    if (typeof outcome === 'string') return outcome
  }
  return ''
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function inr(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * One agency: preview, check, accrue.
 *
 * Never throws. Every path — a refusal, a 500, a timeout, a malformed body —
 * comes back as an `AgencyAccrualResult` the caller can record and move on from.
 */
async function accrueOneAgency(
  config: ServiceApiConfig,
  agencyId: string,
  agencyName: string,
  period: string,
): Promise<AgencyAccrualResult> {
  const base: AgencyAccrualResult = {
    agencyId,
    agencyName,
    outcome: 'failed',
    accrued: false,
    needsPerson: true,
    commissionMinor: null,
    creditedMinor: null,
    refusedBy: null,
    httpStatus: null,
    detail: '',
  }

  // ── 1. Preview. Credits nothing; this is the figure the checks apply to ────
  const previewPath =
    `/api/partner-ops/agencies/${encodeURIComponent(agencyId)}` +
    `/commission-preview?period=${encodeURIComponent(period)}`
  const preview = await callApi(config, 'GET', previewPath)

  if (!preview.ok) {
    return {
      ...base,
      httpStatus: preview.status,
      detail:
        preview.status === null
          ? `The commission preview could not be fetched: ${preview.error}`
          : `The commission preview was refused with HTTP ${preview.status}: ` +
            `${withoutKey(apiMessage(preview.body) || preview.error, config.key)}`,
    }
  }

  const previewBody = preview.body || {}
  const commissionMinor = numberOr(previewBody.commission_minor, null)
  if (commissionMinor === null) {
    return {
      ...base,
      httpStatus: preview.status,
      detail:
        'The commission preview returned no commission_minor, so there is no ' +
        'figure to check or accrue. Nothing was credited.',
    }
  }

  const billing = previewBody.billing as Record<string, unknown> | undefined
  const billingMinor = numberOr(billing?.billing_minor, null)
  const billingText = billingMinor === null ? 'an unknown amount' : inr(billingMinor)

  // ── 2. A provisional slab table is not accrued unattended ──────────────────
  // The server refuses this itself (`refused_provisional_slabs`); refusing here
  // as well means no write is even requested from a table we know is a fallback.
  if (previewBody.provisional === true) {
    const warnings = Array.isArray(previewBody.warnings)
      ? (previewBody.warnings as unknown[]).filter(w => typeof w === 'string').join(' ')
      : ''
    return {
      ...base,
      outcome: 'refused_provisional_slabs',
      refusedBy: 'cloud-function',
      commissionMinor,
      creditedMinor: 0,
      httpStatus: preview.status,
      detail:
        `NOT ACCRUED. The commission figure (${inr(commissionMinor)} on ` +
        `${billingText} of billing) is provisional — the live economy ` +
        `configuration could not be read, so a fallback slab table was used. ` +
        `${withoutKey(warnings, config.key)} `.trim() +
        ' An unattended run does not create a liability from a fallback table. ' +
        'Confirm appConfig/economy, then accrue by hand as a team admin.',
    }
  }

  // ── 3. The sanity bound ────────────────────────────────────────────────────
  if (commissionMinor > SANITY_BOUND_MINOR) {
    return {
      ...base,
      outcome: 'refused_sanity_bound',
      refusedBy: 'cloud-function',
      commissionMinor,
      creditedMinor: 0,
      httpStatus: preview.status,
      detail:
        `NOT ACCRUED. ${inr(commissionMinor)} on ${billingText} of billing is ` +
        `above the ${inr(SANITY_BOUND_MINOR)} an unattended run may accrue for ` +
        'one agency in one period. Nothing was credited and nothing was ' +
        'truncated. Check the ledger, then accrue it as a team admin — the ' +
        'bound applies to the machine, not to a person who has looked.',
    }
  }

  if (commissionMinor < 0) {
    return {
      ...base,
      commissionMinor,
      creditedMinor: 0,
      httpStatus: preview.status,
      detail:
        `NOT ACCRUED. The preview returned a negative commission ` +
        `(${commissionMinor} paise), which is a ledger problem rather than a ` +
        'commission of zero.',
    }
  }

  // ── 4. Accrue. The server recomputes and re-checks; the period is all we send ─
  const accrual = await callApi(
    config,
    'POST',
    `/api/partner-ops/agencies/${encodeURIComponent(agencyId)}/commission-accruals`,
    { period, reason: `Weekly accrual (automated) — ${period}` },
  )

  if (accrual.ok) {
    const body = accrual.body || {}
    const outcome = typeof body.outcome === 'string' ? body.outcome : ''
    const credited = numberOr(body.credited_minor, 0) as number
    const amount = numberOr(body.amount_minor, commissionMinor) as number

    if (outcome === 'accrued') {
      return {
        ...base,
        outcome: 'accrued',
        accrued: true,
        needsPerson: false,
        commissionMinor: amount,
        creditedMinor: credited,
        httpStatus: accrual.status,
        detail:
          `Accrued ${inr(credited)} for ${period} on ${billingText} of billing.`,
      }
    }

    if (outcome === 'already_accrued') {
      // A retry, a double trigger, or a manual re-run of the same week. The
      // idempotency key did its job. This is success.
      return {
        ...base,
        outcome: 'already_accrued',
        accrued: true,
        needsPerson: false,
        commissionMinor: amount,
        creditedMinor: 0,
        httpStatus: accrual.status,
        detail:
          `${period} was already accrued (${inr(amount)}). Nothing was ` +
          'credited a second time.',
      }
    }

    if (outcome === 'nothing_to_accrue') {
      return {
        ...base,
        outcome: 'nothing_to_accrue',
        accrued: false,
        needsPerson: false,
        commissionMinor: amount,
        creditedMinor: 0,
        httpStatus: accrual.status,
        detail:
          withoutKey(
            typeof body.message === 'string' ? body.message : '',
            config.key,
          ) ||
          `${billingText} of billing is below the slab floor, so this agency ` +
          `earns no commission for ${period}. Its hosts are paid in full.`,
      }
    }

    // A 2xx this client does not recognise. Do not call it a success.
    return {
      ...base,
      commissionMinor: amount,
      creditedMinor: credited,
      httpStatus: accrual.status,
      detail:
        `The accrual returned HTTP ${accrual.status} with an outcome this ` +
        `function does not recognise ('${withoutKey(outcome, config.key)}'). ` +
        'Check the audit log before assuming anything was or was not credited.',
    }
  }

  // ── 5. A refusal, or a failure ─────────────────────────────────────────────
  const refusal = apiRefusalOutcome(accrual.body)
  const message = withoutKey(apiMessage(accrual.body) || accrual.error, config.key)

  if (refusal === 'refused_sanity_bound' || refusal === 'refused_provisional_slabs') {
    return {
      ...base,
      outcome: refusal,
      refusedBy: 'server',
      commissionMinor,
      creditedMinor: 0,
      httpStatus: accrual.status,
      detail: `NOT ACCRUED. ${message}`,
    }
  }

  if (accrual.status === 401) {
    return {
      ...base,
      commissionMinor,
      creditedMinor: 0,
      httpStatus: 401,
      detail:
        'NOT ACCRUED. The API did not recognise the service credential. The ' +
        `value of ${ACCRUAL_KEY_ENV} on this function and of ` +
        'SERVICE_KEY_WEEKLY_ACCRUAL on the backend are not the same. See ' +
        'DEPLOYMENT.md § 8.',
    }
  }

  return {
    ...base,
    commissionMinor,
    creditedMinor: 0,
    httpStatus: accrual.status,
    detail:
      accrual.status === null
        ? `NOT ACCRUED. ${message}`
        : `NOT ACCRUED. The accrual failed with HTTP ${accrual.status}: ${message}`,
  }
}

/**
 * Accrue every agency in the report, one at a time, and come back with the
 * truth about each. Never throws.
 */
async function runWeeklyAccrual(
  period: string,
  agencies: { agencyId: string; agencyName: string }[],
): Promise<AccrualRun> {
  const empty: AccrualRun = {
    ran: false,
    status: 'skipped_not_configured',
    reason: '',
    period,
    results: [],
    accruedCount: 0,
    alreadyAccruedCount: 0,
    nothingToAccrueCount: 0,
    needsPersonCount: 0,
    totalCreditedMinor: 0,
    credentialRejected: false,
    ranAt: null,
  }

  const { config, problem } = readAccrualConfig()
  if (!config) {
    // A missing secret on a first deploy must not lose the payout report. It
    // must, however, be impossible to miss.
    functions.logger.error(
      `Commission accrual for ${period} did NOT run: ${problem} The report was ` +
      'still generated. See DEPLOYMENT.md § 8.'
    )
    return {
      ...empty,
      status: 'skipped_not_configured',
      reason: problem,
      results: agencies.map(a => ({
        agencyId: a.agencyId,
        agencyName: a.agencyName,
        outcome: 'not_attempted' as AccrualOutcome,
        accrued: false,
        needsPerson: true,
        commissionMinor: null,
        creditedMinor: null,
        refusedBy: null,
        httpStatus: null,
        detail:
          'NOT ACCRUED. Accrual is not configured on this function, so no ' +
          'agency was attempted.',
      })),
      needsPersonCount: agencies.length,
    }
  }

  const startedAt = Date.now()
  const results: AgencyAccrualResult[] = []

  for (const agency of agencies) {
    if (Date.now() - startedAt > ACCRUAL_BUDGET_MS) {
      results.push({
        agencyId: agency.agencyId,
        agencyName: agency.agencyName,
        outcome: 'not_attempted',
        accrued: false,
        needsPerson: true,
        commissionMinor: null,
        creditedMinor: null,
        refusedBy: null,
        httpStatus: null,
        detail:
          'NOT ACCRUED. The run reached its time budget before this agency. ' +
          'Re-running the week is safe — anything already accrued will not be ' +
          'accrued again.',
      })
      continue
    }

    try {
      results.push(
        await accrueOneAgency(config, agency.agencyId, agency.agencyName, period),
      )
    } catch (err: unknown) {
      // One agency erroring must not stop the rest. This is the last net.
      const message = withoutKey(
        err instanceof Error ? err.message : String(err),
        config.key,
      )
      functions.logger.error(
        `Accrual for agency ${agency.agencyId} in ${period} threw: ${message}`
      )
      results.push({
        agencyId: agency.agencyId,
        agencyName: agency.agencyName,
        outcome: 'failed',
        accrued: false,
        needsPerson: true,
        commissionMinor: null,
        creditedMinor: null,
        refusedBy: null,
        httpStatus: null,
        detail: `NOT ACCRUED. The accrual threw: ${message}`,
      })
    }
  }

  const accruedCount = results.filter(r => r.outcome === 'accrued').length
  const alreadyAccruedCount = results.filter(r => r.outcome === 'already_accrued').length
  const nothingToAccrueCount = results.filter(r => r.outcome === 'nothing_to_accrue').length
  const needsPerson = results.filter(r => r.needsPerson)
  const credentialRejected = results.some(r => r.httpStatus === 401)

  return {
    ran: true,
    status: needsPerson.length === 0 ? 'completed' : 'completed_with_failures',
    reason: '',
    period,
    results,
    accruedCount,
    alreadyAccruedCount,
    nothingToAccrueCount,
    needsPersonCount: needsPerson.length,
    totalCreditedMinor: results.reduce((sum, r) => sum + (r.creditedMinor || 0), 0),
    credentialRejected,
    ranAt: admin.firestore.Timestamp.now(),
  }
}

/**
 * The window the ISO week label names — `[Monday 00:00 UTC, next Monday 00:00 UTC)`.
 *
 * This is the window the API's `resolve_period` derives from the same label
 * (backend/app/services/commission.py), and it is the window that decides
 * commission. It is computed here only so the report and the email can state
 * it next to their own rolling window, which is a different thing measuring a
 * different question.
 */
function isoWeekWindow(label: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-W(\d{1,2})$/i.exec(label.trim())
  if (!match) return null
  const year = Number(match[1])
  const week = Number(match[2])
  if (!Number.isFinite(year) || week < 1 || week > 53) return null

  // 4 January is always in ISO week 1, so week 1's Monday is the Monday on or
  // before it.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week1Monday = new Date(
    Date.UTC(year, 0, 4 - ((jan4.getUTCDay() || 7) - 1))
  )
  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000)
  return { start, end: new Date(start.getTime() + 7 * 86400000) }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const weeklyPayoutReportGenerator = functions
  .runWith({
    // The credential, from Google Secret Manager. Declaring it here is what
    // puts it in `process.env` at runtime and nowhere else — not in
    // functions/.env, not in the deployed source, not in a config file.
    secrets: [ACCRUAL_KEY_ENV, SENDGRID_KEY_ENV],
    // The report plus two API calls per agency. The default 60s is not enough
    // once there are more than a handful of agencies; `ACCRUAL_BUDGET_MS`
    // leaves headroom inside this so a slow backend is reported rather than
    // killed mid-write.
    timeoutSeconds: 540,
    memory: '512MB',
  })
  .pubsub
  .schedule('29 18 * * 0')
  .timeZone('UTC')
  .onRun(async (_context) => {
    const now = admin.firestore.Timestamp.now()
    const nowMs = now.toMillis()

    // Week window: last 7 days
    const weekStartMs = nowMs - 7 * 24 * 60 * 60 * 1000
    const weekStart = admin.firestore.Timestamp.fromMillis(weekStartMs)

    const weekDate = new Date(weekStartMs)
    const year = weekDate.getUTCFullYear()
    const weekNum = getISOWeekNumber(weekDate)
    const weekLabel = `${year}-W${String(weekNum).padStart(2, '0')}`

    const economy = await readEconomySettings()

    // The two windows this run works with, and which one decides what.
    //
    //   * `weekStart`–`now` is a rolling seven days ending at the moment the
    //     job fires. It decides **host eligibility** only: which hosts cleared
    //     the weekly minimum and appear on the payout list.
    //   * `weekLabel` is an ISO week. The API resolves it to its own
    //     [Monday 00:00 UTC, next Monday 00:00 UTC) window from the ledger and
    //     that window — not this one — decides **commission**.
    //
    // They do not line up to the second and are not meant to. Stated on the
    // report and in the email rather than left for someone to discover.
    const accrualWindow = isoWeekWindow(weekLabel)
    const accrualWindowNote = accrualWindow
      ? `COMMISSION WINDOW (governs): the ISO week ${weekLabel}, ` +
        `${utcDay(accrualWindow.start)} 00:00 UTC to ` +
        `${utcDay(accrualWindow.end)} 00:00 UTC, start inclusive and end ` +
        'exclusive. The API derives it from that label and computes commission ' +
        'from the ledger over it. ' +
        `HOST ELIGIBILITY WINDOW (does not govern commission): the rolling ` +
        `seven days ${utcDay(new Date(weekStartMs))} to ` +
        `${utcDay(new Date(nowMs))}, ending when this job fired. ` +
        'The two do not overlap and are not meant to: this report has always ' +
        `been filed under the label of the last ISO week that had fully ` +
        'closed when it ran, so commission is accrued for a settled week ' +
        'rather than one still in progress. Each ISO week is accrued exactly ' +
        'once, by the run one week after it closes.'
      : `COMMISSION WINDOW (governs): the ISO week ${weekLabel}, resolved by ` +
        'the API from that label and computed from the ledger. The rolling ' +
        'seven days this report lists hosts over governs host eligibility ' +
        'only and does not decide any commission figure.'

    functions.logger.info(
      `Running weekly payout report: ${weekLabel}. ${economy.note} ` +
      `${accrualWindowNote}`
    )

    // Fetch all approved + active agencies
    const agenciesSnap = await db.collection('agencies')
      .where('status', '==', 'approved')
      .where('isActive', '==', true)
      .get()

    if (agenciesSnap.empty) {
      functions.logger.info('No approved agencies found.')
      return null
    }

    const reportRef = db.collection('weeklyPayoutReports').doc(weekLabel)
    const hostPayoutsBatch = db.batch()

    /**
     * One agency's week.
     *
     * There is no locally computed `commissionInr` and no
     * `effectiveCommissionRate` here on purpose. Both used to be computed in
     * this function from a slab table that did not match the live
     * configuration, and a plausible-looking wrong figure on a finance report
     * is worse than no figure. `totalHostPayoutInr` is this report's own
     * billing figure over its own rolling window; the commission fields below
     * are whatever `commission-preview` / `commission-accruals` said, over the
     * API's ISO-week window, and nothing on this line is derived from anything
     * else.
     *
     * `commissionAccrued` is per agency and is the truth for that agency: it is
     * true when this period's commission is on the books for it — whether this
     * run put it there or an earlier run already had. It is never a blanket
     * flag copied across the report.
     */
    interface AgencySummary {
      agencyId: string
      agencyName: string
      agencyType: 'main' | 'sub'
      isForeign: boolean
      hostCount: number
      eligibleHostCount: number
      totalBeansEarned: number
      totalHostPayoutInr: number
      /** Is this period's commission on the books for THIS agency? */
      commissionAccrued: boolean
      /** `accrued` | `already_accrued` | `nothing_to_accrue` | `refused_*` | … */
      commissionOutcome: AccrualOutcome | 'pending'
      /** What the API said the period is worth, in paise. Null if unknown. */
      commissionMinor: number | null
      /** What this run actually moved, in paise. Zero on a safe re-run. */
      commissionCreditedMinor: number | null
      /** Does this line need a human before the week can be called done? */
      commissionNeedsPerson: boolean
      commissionNote: string
    }

    const agencySummaries: AgencySummary[] = []
    let grandTotalHostPayout = 0
    let totalEligibleHosts = 0

    for (const agencyDoc of agenciesSnap.docs) {
      const agency = agencyDoc.data()
      const agencyId = agencyDoc.id
      const agencyName = (agency.agencyName as string) || 'Unknown Agency'
      const agencyType: 'main' | 'sub' = agency.type === 'sub' ? 'sub' : 'main'
      const isForeign: boolean = agency.paymentType === 'foreign'

      // Fetch hosts
      const hostsSnap = await db.collection('agencies').doc(agencyId).collection('agencyHosts').get()

      let agencyBeansTotal = 0
      let agencyHostPayoutTotal = 0
      let eligibleHostCount = 0

      for (const hostDoc of hostsSnap.docs) {
        const host = hostDoc.data()
        // FX-10 (RF-15): a row `revoke_host` or the account purge marked
        // inactive is not one of this agency's hosts any more. It used to be
        // counted, and paid against, because nothing marked it.
        if (!rosterRowIsCurrent(host)) continue
        const hostUid: string = (host.uid as string) || hostDoc.id
        const hostName: string = (host.name as string) || (host.displayName as string) || 'Unknown Host'

        // Aggregate beans earned this week
        let weekBeans = 0
        try {
          const beanSnap = await db
            .collection('users').doc(hostUid).collection('beanTransactions')
            .where('type', '==', 'credit')
            .where('timestamp', '>=', weekStart)
            .where('timestamp', '<=', now)
            .get()
          beanSnap.docs.forEach(tx => { weekBeans += (tx.data().amount as number) || 0 })
        } catch (err) {
          functions.logger.warn(`Bean tx fetch failed for host ${hostUid}:`, err)
        }

        const hostPayoutInr = Math.round(weekBeans * economy.beanToInrRate * 100) / 100

        // Eligibility: the threshold the business actually publishes, read from
        // appConfig/economy.weeklyMinPayoutInr — not a constant in this file.
        if (hostPayoutInr < economy.minHostPayoutInr) continue

        eligibleHostCount++
        agencyBeansTotal += weekBeans
        agencyHostPayoutTotal += hostPayoutInr

        const hostPayoutRef = reportRef.collection('hostPayouts').doc(`${agencyId}_${hostUid}`)
        hostPayoutsBatch.set(hostPayoutRef, {
          agencyId, agencyName, hostUid, hostName,
          weekBeans, hostPayoutInr,
          weekLabel, weekStart, weekEnd: now,
          status: 'pending',
          eligible: true,
          createdAt: now,
        })
      }

      grandTotalHostPayout += agencyHostPayoutTotal
      totalEligibleHosts += eligibleHostCount

      // No commission is computed here and no commissionBalance is written
      // here. The accrual phase below asks the API, which computes it from the
      // ledger, and the answer is merged back onto this line.

      agencySummaries.push({
        agencyId, agencyName, agencyType, isForeign,
        // FX-10: current hosts only — the rows skipped above are not counted either.
        hostCount: hostsSnap.docs.filter((d) => rosterRowIsCurrent(d.data())).length,
        eligibleHostCount,
        totalBeansEarned: agencyBeansTotal,
        totalHostPayoutInr: agencyHostPayoutTotal,
        commissionAccrued: false,
        commissionOutcome: 'pending',
        commissionMinor: null,
        commissionCreditedMinor: null,
        commissionNeedsPerson: true,
        commissionNote:
          `Accrual for ${weekLabel} has not been attempted yet. If this line ` +
          'still reads "pending" the run did not get as far as writing its ' +
          'result back, and this agency must be checked by hand.',
      })
    }

    // Write main report document.
    //
    // This happens BEFORE any accrual is attempted, and it is written again
    // afterwards with the result. The order matters: a missing service key, an
    // unreachable backend or a crash in the accrual phase must not cost the
    // business its payout report. The report is durable first; the accrual is
    // then recorded onto it.
    //
    // `grandTotalCommissionInr` is deliberately absent. It used to be the sum of
    // a locally computed, wrong commission; a field that is missing prompts the
    // question, a field that is present and wrong does not. The commission
    // figures that do appear come from the API and from nowhere else.
    await reportRef.set({
      weekLabel, weekStart, weekEnd: now,
      agencySummaries,
      totalAgencies: agenciesSnap.size,
      totalEligibleAgencies: agencySummaries.filter(a => a.eligibleHostCount > 0).length,
      totalEligibleHosts,
      grandTotalHostPayoutInr: grandTotalHostPayout,
      commissionAccrued: false,
      commissionNote:
        `Commission accrual for ${weekLabel} has not run yet. This document ` +
        'was written before the accrual was attempted so that the report ' +
        'survives an accrual failure. If these fields still say this after ' +
        'the run, the accrual phase did not complete.',
      commissionAccrualEndpoint: ACCRUAL_ENDPOINT,
      accrualPeriodLabel: weekLabel,
      accrualWindowNote,
      accrualWindowStart: accrualWindow
        ? admin.firestore.Timestamp.fromDate(accrualWindow.start)
        : null,
      accrualWindowEnd: accrualWindow
        ? admin.firestore.Timestamp.fromDate(accrualWindow.end)
        : null,
      minHostPayoutInr: economy.minHostPayoutInr,
      beanToInrRate: economy.beanToInrRate,
      economyNote: economy.note,
      provisional: economy.provisional,
      status: 'generated',
      createdAt: now,
    })

    await hostPayoutsBatch.commit()

    // ── Accrue ───────────────────────────────────────────────────────────────
    //
    // Every approved + active agency in the report is attempted, not only the
    // ones with eligible hosts this week. Host eligibility is this report's
    // question, measured over its own rolling window; commission is the API's
    // question, measured over the ISO week from the ledger. An agency with no
    // eligible host here can still have billed in that week, and one with
    // eligible hosts can still bill below the slab floor. Letting this report's
    // filter decide which agencies get accrued would silently reintroduce a
    // local rule about commission.
    let accrual: AccrualRun
    try {
      accrual = await runWeeklyAccrual(
        weekLabel,
        agencySummaries.map(a => ({ agencyId: a.agencyId, agencyName: a.agencyName })),
      )
    } catch (err: unknown) {
      // `runWeeklyAccrual` does not throw. If it somehow does, the report is
      // already safe on disk and the email still goes out saying so.
      const message = err instanceof Error ? err.message : String(err)
      functions.logger.error(`The accrual phase for ${weekLabel} threw: ${message}`)
      accrual = {
        ran: false,
        status: 'failed',
        reason: `The accrual phase failed before it could report per agency: ${message}`,
        period: weekLabel,
        results: [],
        accruedCount: 0,
        alreadyAccruedCount: 0,
        nothingToAccrueCount: 0,
        needsPersonCount: agencySummaries.length,
        totalCreditedMinor: 0,
        credentialRejected: false,
        ranAt: admin.firestore.Timestamp.now(),
      }
    }

    // Merge the per-agency truth back onto the report.
    const resultById = new Map(accrual.results.map(r => [r.agencyId, r]))
    for (const summary of agencySummaries) {
      const result = resultById.get(summary.agencyId)
      if (!result) {
        summary.commissionAccrued = false
        summary.commissionOutcome = 'not_attempted'
        summary.commissionNeedsPerson = true
        summary.commissionMinor = null
        summary.commissionCreditedMinor = null
        summary.commissionNote =
          'NOT ACCRUED. The accrual phase returned no result for this agency. ' +
          `${accrual.reason || 'Check the function logs.'}`
        continue
      }
      summary.commissionAccrued = result.accrued
      summary.commissionOutcome = result.outcome
      summary.commissionMinor = result.commissionMinor
      summary.commissionCreditedMinor = result.creditedMinor
      summary.commissionNeedsPerson = result.needsPerson
      summary.commissionNote = result.detail
    }

    const needsPerson = accrual.results.filter(r => r.needsPerson)

    // The top-level flag is a summary of the lines, never a substitute for
    // them: it is true only when the run happened and every agency came back
    // settled. Anything less and the per-agency fields are where the truth is.
    const runComplete = accrual.ran && needsPerson.length === 0

    const accrualSummaryNote = !accrual.ran
      ? `COMMISSION WAS NOT ACCRUED FOR ${weekLabel}. ${accrual.reason} The ` +
        'report itself is complete and correct; only the accrual did not run. ' +
        'Fix the configuration and re-run the week — re-running is safe, ' +
        'nothing already accrued can be accrued twice.'
      : runComplete
        ? `Commission for ${weekLabel} is accrued. ${accrual.accruedCount} ` +
          `agency(ies) credited this run (${inr(accrual.totalCreditedMinor)}), ` +
          `${accrual.alreadyAccruedCount} were already accrued, ` +
          `${accrual.nothingToAccrueCount} billed below the slab floor and earn ` +
          'nothing for this period.'
        : `Commission for ${weekLabel} is PARTIALLY accrued. ` +
          `${accrual.accruedCount} agency(ies) credited this run ` +
          `(${inr(accrual.totalCreditedMinor)}), ` +
          `${accrual.alreadyAccruedCount} already accrued, ` +
          `${accrual.nothingToAccrueCount} below the floor, and ` +
          `${needsPerson.length} NOT ACCRUED and needing a person. Re-running ` +
          'the week is safe.'

    await reportRef.set(
      {
        agencySummaries,
        commissionAccrued: runComplete,
        commissionNote: accrualSummaryNote,
        commissionAccrual: {
          ran: accrual.ran,
          status: accrual.status,
          reason: accrual.reason,
          period: accrual.period,
          ranAt: accrual.ranAt,
          agenciesAttempted: accrual.results.length,
          accruedCount: accrual.accruedCount,
          alreadyAccruedCount: accrual.alreadyAccruedCount,
          nothingToAccrueCount: accrual.nothingToAccrueCount,
          needsPersonCount: accrual.needsPersonCount,
          totalCreditedMinor: accrual.totalCreditedMinor,
          totalCreditedInr: accrual.totalCreditedMinor / 100,
          credentialRejected: accrual.credentialRejected,
          needsPerson: needsPerson.map(r => ({
            agencyId: r.agencyId,
            agencyName: r.agencyName,
            outcome: r.outcome,
            refusedBy: r.refusedBy,
            httpStatus: r.httpStatus,
            detail: r.detail,
          })),
        },
        // `status` is deliberately NOT touched here. It is the report's
        // approval lifecycle — generated → submitted → approved / rejected —
        // and the CRM's payout queue filters and styles on exactly those four
        // values (zipper-crm/lib/finance.ts). Whether commission accrued is a
        // different question with its own field above; folding it into
        // `status` would hide a report from the queue that still has to be
        // approved.
      },
      { merge: true },
    )

    // ── Email superadmin ──────────────────────────────────────────────────────
    const superadminSnap = await db.collection('crmUsers').where('role', '==', 'superadmin').limit(1).get()
    const superadminEmail = superadminSnap.empty ? '314zipper@gmail.com' : (superadminSnap.docs[0].data().email as string)

    // Everything below that came from Firestore or from an API response is
    // escaped before it goes into the HTML. The service key cannot reach here —
    // it never leaves `callApi`'s header and every string out of a response has
    // already been through `withoutKey()` — but a refusal message is still
    // untrusted text going into a mail body.
    const esc = (value: string): string =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

    const commissionCell = (a: AgencySummary): string => {
      switch (a.commissionOutcome) {
        case 'accrued':
          return `<span style="color:#4ade80">accrued ${esc(inr(a.commissionCreditedMinor || 0))}</span>`
        case 'already_accrued':
          return `<span style="color:#4ade80">already accrued</span>`
        case 'nothing_to_accrue':
          return `<span style="color:#888">below the floor — ₹0</span>`
        case 'refused_sanity_bound':
          return `<span style="color:#f87171">NOT ACCRUED — above the bound</span>`
        case 'refused_provisional_slabs':
          return `<span style="color:#f87171">NOT ACCRUED — provisional slabs</span>`
        case 'not_attempted':
          return `<span style="color:#f87171">NOT ATTEMPTED</span>`
        default:
          return `<span style="color:#f87171">NOT ACCRUED — failed</span>`
      }
    }

    const agencyRows = agencySummaries
      .filter(a => a.eligibleHostCount > 0 || a.commissionAccrued || a.commissionNeedsPerson)
      .map(a => `
        <tr style="border-bottom:1px solid #333">
          <td style="padding:8px 12px">${esc(a.agencyName)}</td>
          <td style="padding:8px 12px;text-align:center">${a.agencyType}</td>
          <td style="padding:8px 12px;text-align:right">${a.eligibleHostCount}/${a.hostCount}</td>
          <td style="padding:8px 12px;text-align:right">₹${a.totalHostPayoutInr.toLocaleString('en-IN')}</td>
          <td style="padding:8px 12px;text-align:center">${commissionCell(a)}</td>
        </tr>`)
      .join('')

    const provisionalBanner = economy.provisional
      ? `<p style="margin:0 0 16px;padding:12px 14px;border-radius:8px;background:#422006;border:1px solid #a16207;color:#fde68a;font-size:13px">
           <strong>These host-eligibility figures are provisional.</strong> ${esc(economy.note)}
           This affects which hosts are listed below. It does not affect commission,
           which the API computes from the ledger and its own live slab table.
         </p>`
      : ''

    // ── The first thing the reader sees ──────────────────────────────────────
    //
    // Three states, and they must not look alike. A week where accrual could
    // not run at all is the one that most needs to stop somebody, so it is red
    // and it is at the top; a week with a few refusals is amber; a clean week
    // is green and short.
    const accrualBanner = !accrual.ran
      ? `<p style="margin:16px 0;padding:16px;border-radius:8px;background:#450a0a;border:2px solid #ef4444;color:#fecaca;font-size:14px;line-height:1.6">
           <strong style="color:#fff;font-size:16px">COMMISSION WAS NOT ACCRUED THIS WEEK. NOTHING RAN.</strong><br>
           <strong>Every agency below is unaccrued for ${weekLabel}, and no agency balance has changed.</strong><br>
           Reason: ${esc(accrual.reason || 'the accrual phase did not complete.')}<br>
           The report itself is complete — only the accrual is missing. Fix the
           configuration (DEPLOYMENT.md § 8) and re-run the week. Re-running is
           safe: the API is idempotent per agency, host and period, so nothing
           already accrued can be accrued twice.
         </p>`
      : accrual.needsPersonCount > 0
        ? `<p style="margin:16px 0;padding:16px;border-radius:8px;background:#422006;border:2px solid #f59e0b;color:#fde68a;font-size:14px;line-height:1.6">
             <strong style="color:#fff;font-size:16px">${accrual.needsPersonCount} agency(ies) were NOT accrued and need a person.</strong><br>
             ${accrual.accruedCount} credited this run (${esc(inr(accrual.totalCreditedMinor))}),
             ${accrual.alreadyAccruedCount} already accrued,
             ${accrual.nothingToAccrueCount} billed below the slab floor.
             The list is below. Re-running the week is safe — nothing already
             accrued can be accrued twice.
           </p>`
        : `<p style="margin:16px 0;padding:14px 16px;border-radius:8px;background:#052e16;border:1px solid #22c55e;color:#bbf7d0;font-size:13px;line-height:1.6">
             <strong style="color:#fff">Commission for ${weekLabel} is accrued.</strong>
             ${accrual.accruedCount} agency(ies) credited this run (${esc(inr(accrual.totalCreditedMinor))}),
             ${accrual.alreadyAccruedCount} were already accrued,
             ${accrual.nothingToAccrueCount} billed below the slab floor and earn
             nothing for this period. Nothing needs a person.
           </p>`

    const credentialBanner = accrual.credentialRejected
      ? `<p style="margin:0 0 16px;padding:14px 16px;border-radius:8px;background:#450a0a;border:2px solid #ef4444;color:#fecaca;font-size:13px;line-height:1.6">
           <strong style="color:#fff">The API refused this job's credential.</strong>
           The key configured on the Cloud Function and the key configured on the
           backend are not the same value. Neither is shown here or anywhere else.
           Re-issue one key and set it on both sides — DEPLOYMENT.md § 8.
         </p>`
      : ''

    const failureRows = needsPerson
      .map(r => `
        <tr style="border-bottom:1px solid #444">
          <td style="padding:8px 12px;vertical-align:top;white-space:nowrap">${esc(r.agencyName)}</td>
          <td style="padding:8px 12px;vertical-align:top;white-space:nowrap;color:#fca5a5">${esc(r.outcome)}</td>
          <td style="padding:8px 12px;vertical-align:top;color:#fde68a">${esc(r.detail)}</td>
        </tr>`)
      .join('')

    const failureBlock = needsPerson.length > 0
      ? `<h3 style="color:#f87171;margin:28px 0 8px">Needs a person — ${needsPerson.length} agency(ies) not accrued</h3>
         <table style="width:100%;border-collapse:collapse;font-size:12px;background:#1a1a1a">
           <thead>
             <tr style="background:#2a1010;color:#fca5a5">
               <th style="padding:8px 12px;text-align:left">Agency</th>
               <th style="padding:8px 12px;text-align:left">Outcome</th>
               <th style="padding:8px 12px;text-align:left">What happened</th>
             </tr>
           </thead>
           <tbody>${failureRows}</tbody>
         </table>
         <p style="color:#888;font-size:12px;margin-top:8px">
           A team admin can accrue any of these by hand with
           <code style="color:#a5b4fc">${ACCRUAL_ENDPOINT}</code>
           and <code style="color:#a5b4fc">period=${weekLabel}</code>, after checking the figure with
           <code style="color:#a5b4fc">GET /api/partner-ops/agencies/{agencyId}/commission-preview?period=${weekLabel}</code>,
           which credits nothing.
         </p>`
      : ''

    const commissionTile = !accrual.ran
      ? `<p style="color:#f87171;font-size:18px;font-weight:bold;margin:0">Not accrued</p>`
      : `<p style="color:#4ade80;font-size:22px;font-weight:bold;margin:0">${esc(inr(accrual.totalCreditedMinor))}</p>
         <p style="color:#888;margin:4px 0 0;font-size:11px">credited this run</p>`

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#111;color:#eee;padding:24px;border-radius:12px">
        <h2 style="color:#ec4899;margin-bottom:4px">Zipper CRM — Weekly Payout Report</h2>
        <p style="color:#888;margin-top:0">Week: <strong style="color:#fff">${weekLabel}</strong></p>

        ${accrualBanner}
        ${credentialBanner}
        ${provisionalBanner}

        <div style="display:flex;gap:16px;margin:20px 0;flex-wrap:wrap">
          <div style="flex:1;min-width:140px;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #333">
            <p style="color:#888;margin:0 0 4px;font-size:12px">Eligible Hosts</p>
            <p style="color:#fff;font-size:24px;font-weight:bold;margin:0">${totalEligibleHosts}</p>
          </div>
          <div style="flex:1;min-width:140px;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #333">
            <p style="color:#888;margin:0 0 4px;font-size:12px">Total Host Payouts</p>
            <p style="color:#fff;font-size:24px;font-weight:bold;margin:0">₹${grandTotalHostPayout.toLocaleString('en-IN')}</p>
          </div>
          <div style="flex:1;min-width:140px;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #333">
            <p style="color:#888;margin:0 0 4px;font-size:12px">Agency Commission</p>
            ${commissionTile}
          </div>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#1e1e1e;color:#888">
              <th style="padding:10px 12px;text-align:left">Agency</th>
              <th style="padding:10px 12px">Type</th>
              <th style="padding:10px 12px">Hosts (eligible/total)</th>
              <th style="padding:10px 12px;text-align:right">Host payouts (this report)</th>
              <th style="padding:10px 12px;text-align:center">Commission (${weekLabel})</th>
            </tr>
          </thead>
          <tbody>${agencyRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#666">No eligible hosts and nothing to accrue this week.</td></tr>'}</tbody>
        </table>

        ${failureBlock}

        <p style="color:#666;font-size:12px;margin-top:24px;line-height:1.6">
          <strong style="color:#999">Two windows, and they are not the same.</strong>
          ${esc(accrualWindowNote)}<br><br>
          Commission is computed by the API from the ledger — flat rate by band,
          floor ₹25,001 (main) / ₹26,001 (sub) — and never by this report.<br>
          Minimum host eligibility: ₹${economy.minHostPayoutInr.toLocaleString('en-IN')}/week ·
          Bean rate: ₹${economy.beanToInrRate}/bean — both read from appConfig/economy.<br>
          View full report in <a href="https://zippercrm.web.app/operations/reports" style="color:#ec4899">Zipper CRM</a>.
        </p>
      </div>`

    const subject = !accrual.ran
      ? `Zipper Weekly Payout Report — ${weekLabel} — ACTION NEEDED: commission did NOT accrue`
      : accrual.needsPersonCount > 0
        ? `Zipper Weekly Payout Report — ${weekLabel} — ${accrual.needsPersonCount} agency(ies) NOT accrued`
        : `Zipper Weekly Payout Report — ${weekLabel} — commission accrued`

    try {
      await sendMail(superadminEmail, subject, emailHtml)
    } catch (mailErr) {
      functions.logger.error('Failed to send weekly report email:', mailErr)
    }

    const logPayload = {
      agencies: agenciesSnap.size,
      eligibleHosts: totalEligibleHosts,
      totalPayout: grandTotalHostPayout,
      accrualRan: accrual.ran,
      accrualStatus: accrual.status,
      accrued: accrual.accruedCount,
      alreadyAccrued: accrual.alreadyAccruedCount,
      nothingToAccrue: accrual.nothingToAccrueCount,
      needsPerson: accrual.needsPersonCount,
      creditedMinor: accrual.totalCreditedMinor,
      economy: economy.note,
    }

    if (!accrual.ran) {
      functions.logger.error(
        `Weekly report ${weekLabel} generated, but COMMISSION DID NOT ACCRUE: ` +
        `${accrual.reason}`,
        logPayload,
      )
    } else if (accrual.needsPersonCount > 0) {
      functions.logger.warn(
        `Weekly report ${weekLabel} generated and partially accrued. ` +
        `${accrual.needsPersonCount} agency(ies) need a person: ` +
        `${needsPerson.map(r => `${r.agencyId} (${r.outcome})`).join(', ')}`,
        logPayload,
      )
    } else {
      functions.logger.info(
        `Weekly report ${weekLabel} generated and commission accrued.`,
        logPayload,
      )
    }

    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 2. COIN TRANSFER ON RECHARGE APPROVAL
//    Triggers on: update to rechargeRequests/{reqId}
//    When status changes to 'approved':
//      - Atomically deduct seller.coinBalance
//      - Credit buyer diamonds
//      - Write diamondTransaction doc for buyer
//      - Write notification for buyer
// ─────────────────────────────────────────────────────────────────────────────

export const onRechargeApproved = asiaFirestore
  .document('rechargeRequests/{reqId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after = change.after.data()
    const reqId = context.params.reqId

    /*
     * Only on the transition INTO approved.
     *
     * ── AND WHY THAT USED TO MAKE A FAILURE PERMANENT ────────────────────────
     *
     * The buyer has already paid the seller, in cash, outside this system. If
     * the transfer below fails, the only honest outcomes are "retry until it
     * works" or "refund" — and the old code offered neither. It wrote
     * `transferError` and stopped: the document was already `approved`, so
     * re-approving was a no-op through this very guard, and writing the error
     * field re-triggered the function straight into `before.status ===
     * after.status`. Meanwhile the seller's dashboard queries
     * `status == 'pending'`, so the request had already left their screen
     * showing "Approved". Money taken, nothing delivered, and no surface
     * anywhere that showed it.
     *
     * A failure now sends the request BACK to `pending` (see the catch below),
     * and this guard deliberately fires again on the next pending → approved.
     * That is the retry, and it is why the guard is not being loosened here.
     */
    if (before.status === after.status || after.status !== 'approved') {
      return null
    }

    /*
     * ── THE CREDIT NO LONGER HAPPENS HERE ─────────────────────────────────
     *
     * Recharges are verified by Zipper staff and credited by the API through
     * the ledger (`backend/app/services/recharges.py`), with idempotency keys,
     * an audit row and a refund model. When the API approves one it writes
     * `creditedByLedger: true` onto this document in the same update that
     * sets `status: 'approved'` — so for a real approval there is nothing
     * left for this function to do, and doing it anyway would credit twice.
     *
     * A status flip WITHOUT that marker is a client: the seller's own tap in
     * the old Android seller dashboard, or anybody the rules still let update
     * the document. That used to mint diamonds on the seller's word alone,
     * non-idempotently. It is now reverted to `pending` with a note the
     * dashboard renders, and ops is told. Nothing moves.
     */
    if (after.creditedByLedger === true) {
      functions.logger.info(`Recharge ${reqId}: approved and credited by the API ledger. Nothing to do here.`)
      return null
    }

    functions.logger.warn(
      `Recharge ${reqId}: status set to 'approved' by a client, not by the API. ` +
      'Reverting to pending — recharges are verified by Zipper staff.',
    )
    await change.after.ref.update({
      status: 'pending',
      transferErrorReason:
        'Recharges are verified by Zipper before diamonds are credited. ' +
        'This request is back in the queue.',
      clientApprovalRevertedAt: admin.firestore.Timestamp.now(),
      clientApprovalAttempts: admin.firestore.FieldValue.increment(1),
    })
    await db.collection('adminAlerts').add({
      type: 'recharge_client_approval_blocked',
      severity: 'warning',
      message: `Recharge ${reqId}: a client set status=approved without staff verification; reverted.`,
      rechargeRequestId: reqId,
      buyerUid: after.buyerUid ?? '',
      sellerUid: after.sellerUid ?? '',
      createdAt: admin.firestore.Timestamp.now(),
      resolved: false,
    })
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 3. AGENCY APPROVAL NOTIFICATION
//    Triggers on: update to agencies/{agencyId}
//    When status changes to 'approved':
//      - Write a notification doc for the agency owner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How this partner actually signs in, as a sentence for the credentials box.
 *
 * Both approval emails printed "The password you set during registration" for
 * everybody, and for a partner who signed up with `partnerSignUpWithGoogle`
 * there is no password and there never will be one — that flow says so in as
 * many words. So the one email telling somebody their account is live was also
 * telling them to use a credential that does not exist, at the exact moment
 * they were trying to get in for the first time.
 *
 * Read from Firebase Auth rather than from a field on the partner document,
 * because the document never recorded it: the signup page writes the record and
 * the credential is created separately, so the only place the answer exists is
 * the provider list on the account itself.
 *
 * Falls back to the neutral sentence. An unknown uid, a deleted account or an
 * Auth outage must not stop an approval email going out, and "the way you signed
 * up" is true of every partner.
 */
async function signInHint(uid: string): Promise<string> {
  const fallback = 'The way you signed up'
  if (!uid) return fallback
  try {
    const rec = await admin.auth().getUser(uid)
    const ids = rec.providerData.map((p) => p.providerId)
    if (ids.includes('google.com') && !ids.includes('password')) {
      return 'Sign in with Google — the account has no password'
    }
    if (ids.includes('password')) return 'The password you set during registration'
    return fallback
  } catch {
    return fallback
  }
}

export const onAgencyApproved = asiaFirestoreMail
  .document('agencies/{agencyId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after = change.after.data()
    const agencyId = context.params.agencyId

    // Only proceed if status changed to 'approved'
    if (before.status === after.status || after.status !== 'approved') {
      return null
    }

    const ownerUid: string   = after.ownerUid    ?? ''
    const agencyName: string = after.agencyName  ?? 'Your Agency'
    const ownerName: string  = after.ownerName   ?? 'Agency Owner'
    const email: string      = after.ownerEmail  ?? ''

    functions.logger.info(`Agency ${agencyId} approved. Notifying owner ${ownerUid}.`)

    // In-app notification: written by the API when it approves the partner
    // (`backend/app/services/notices.partner_approved`, idempotent on the
    // partner id, addressed on `userId`). It used to be written here too — and
    // gated on `ownerUid`, which no agency form ever wrote, so it never fired.
    // Writing it here as well now would be a second message for one event.
    // This trigger keeps the EMAIL, which the API does not send.
    functions.logger.info(`Agency ${agencyId} approved; in-app notice is the API's. Owner ${ownerUid || '(unknown)'}.`)

    // Email notification
    if (email) {
      // Google signups have no password; see `signInHint`.
      const signInWith = await signInHint(String(after.crmUid ?? ownerUid ?? ''))
      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>

  <!-- Card -->
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">

    <!-- Green banner -->
    <div style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:32px;text-align:center;">
      <div style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:50%;width:64px;height:64px;line-height:64px;font-size:36px;margin-bottom:12px;">✅</div>
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;">You're Approved!</h1>
      <p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">Your agency is now live on Zipper</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <p style="color:#cbd5e1;line-height:1.7;font-size:15px;margin:0 0 24px;">
        Hi <strong style="color:#ffffff;">${escapeHtml(ownerName)}</strong>,<br><br>
        Great news! Your agency <strong style="color:#ffffff;">${escapeHtml(agencyName)}</strong> has been
        <strong style="color:#22c55e;">approved</strong>. You can now log in to your CRM dashboard
        and start onboarding hosts.
      </p>

      <!-- Login CTA -->
      <div style="text-align:center;margin:28px 0;">
        <a href="https://zipperlive.web.app/login"
          style="display:inline-block;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:800;font-size:16px;letter-spacing:0.02em;">
          Log In to Dashboard →
        </a>
        <p style="color:#64748b;font-size:12px;margin:10px 0 0;">
          <a href="https://zipperlive.web.app/login" style="color:#94a3b8;text-decoration:none;">https://zipperlive.web.app/login</a>
        </p>
      </div>

      <!-- Credentials box -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">Your Login Credentials</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="color:#64748b;font-size:13px;padding:6px 0;width:80px;">Email</td>
            <td style="color:#ffffff;font-size:14px;font-weight:600;padding:6px 0;">${escapeHtml(email)}</td>
          </tr>
          <tr>
            <td style="color:#64748b;font-size:13px;padding:6px 0;">Password</td>
            <td style="color:#94a3b8;font-size:13px;font-style:italic;padding:6px 0;">${escapeHtml(signInWith)}</td>
          </tr>
        </table>
      </div>

      <!-- What you can do -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What you can do now</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">👥</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Add and manage your hosts</td></tr>
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">💰</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Track beans earned and request payouts</td></tr>
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">📊</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">View your agency's performance dashboard</td></tr>
        </table>
      </div>

      <p style="color:#64748b;font-size:13px;margin:0;line-height:1.6;">
        Need help? Reach us at
        <a href="mailto:314zipper@gmail.com" style="color:#ec4899;text-decoration:none;">314zipper@gmail.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; ${escapeHtml(agencyName)}</p>
    </div>
  </div>

</div>
</body></html>`
      try {
        await sendMail(email, `🎉 Your agency is approved — Log in to Zipper Live!`, html)
      } catch (err) {
        functions.logger.error('Failed to send agency approval email:', err)
      }
    }

    functions.logger.info(`Agency ${agencyId} approval done — notification + email sent.`)
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 4. PLATFORM STATS AGGREGATOR
//    Scheduled: daily at midnight UTC
//    Aggregates today's giftTransactions → writes/updates platformRevenue doc
// ─────────────────────────────────────────────────────────────────────────────

export const dailyPlatformStatsAggregator = functions.pubsub
  .schedule('0 0 * * *')
  .timeZone('UTC')
  .onRun(async (_context) => {
    const now = new Date()

    // "Yesterday" window — by the time this runs at midnight UTC, we aggregate
    // the full previous calendar day
    const dayStart = new Date(now)
    dayStart.setUTCDate(dayStart.getUTCDate() - 1)
    dayStart.setUTCHours(0, 0, 0, 0)

    const dayEnd = new Date(dayStart)
    dayEnd.setUTCHours(23, 59, 59, 999)

    const dayLabel = dayStart.toISOString().split('T')[0] // e.g. "2025-06-30"

    const tsStart = admin.firestore.Timestamp.fromDate(dayStart)
    const tsEnd = admin.firestore.Timestamp.fromDate(dayEnd)

    functions.logger.info(`Aggregating platform stats for ${dayLabel}`)

    // Fetch all gift transactions for the day
    let totalRevenue = 0    // total value of gifts sent (in beans or diamonds)
    let totalGifts = 0
    let totalDiamondSpend = 0
    let totalBeanEarned = 0

    try {
      const giftSnap = await db
        .collection('giftTransactions')
        .where('timestamp', '>=', tsStart)
        .where('timestamp', '<=', tsEnd)
        .get()

      for (const giftDoc of giftSnap.docs) {
        const gift = giftDoc.data()
        const diamondCost: number = (gift.diamondCost as number) || 0
        const beanValue: number = (gift.beanValue as number) || 0

        totalGifts++
        totalDiamondSpend += diamondCost
        totalBeanEarned += beanValue
        // Platform revenue = diamonds spent - beans earned (platform margin)
        totalRevenue += diamondCost - beanValue
      }
    } catch (err) {
      functions.logger.error('Failed to fetch giftTransactions:', err)
    }

    // Platform takes a cut — total diamonds in minus beans out = profit
    const platformProfit = totalDiamondSpend - totalBeanEarned
    const platformPayout = totalBeanEarned

    // Write/update platformRevenue doc for this day
    const revenueRef = db.collection('platformRevenue').doc(dayLabel)
    await revenueRef.set(
      {
        date: dayLabel,
        dayStart: tsStart,
        dayEnd: tsEnd,
        totalGifts,
        totalDiamondSpend,
        totalBeanEarned,
        platformRevenue: totalRevenue,
        platformProfit,
        platformPayout,
        updatedAt: admin.firestore.Timestamp.now(),
      },
      { merge: true }
    )

    functions.logger.info(`Platform stats for ${dayLabel} written.`, {
      totalGifts,
      totalDiamondSpend,
      totalBeanEarned,
      platformProfit,
    })

    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 5. PAYOUT APPROVED — NOTIFY AGENCIES (no balance is touched here)
//    Triggers on: update to weeklyPayoutReports/{weekLabel}
//    When finance approves a payout report (status → 'approved'):
//      - Mark on each host that their payout was *approved* (not paid)
//      - Write a notification for each agency owner
//
//    REMOVED: this trigger used to set `beans: 0` and `weeklyBeansEarned: 0` on
//    every host the moment the report was marked 'approved'. Spec 4.4.7: a
//    balance resets only after the payout is *executed*. A report that is
//    approved but never paid had already wiped what the host earned, with no
//    ledger entry and no way to reconstruct the balance.
//
//    This trigger has no execution signal — `weeklyPayoutReports` docs only ever
//    carry 'generated' | 'approved', written by the CRM client, so there is
//    nothing here that can honestly mean "the money left the building". Rather
//    than invent an 'executed' status that any client could write (the same
//    one-writer bypass in a new costume), the reset is gone from here entirely.
//
//    The reset belongs to the money board in the Python API: the payout is a
//    beans BALANCE_DEBIT card (backend/app/services/cards.py), raised with
//    POST /api/users/{uid}/balance-request, signed by an owner, and executed with
//    POST /api/users/balance-cards/{cardId}/execute — which runs
//    money.apply_movement (backend/app/services/money.py) so the balance change,
//    the ledger entry and the audit entry commit together and Firestore is
//    re-synced from Mongo afterwards.
// ─────────────────────────────────────────────────────────────────────────────

export const onPayoutApproved = asiaFirestore
  .document('weeklyPayoutReports/{weekLabel}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after  = change.after.data()
    const weekLabel: string = context.params.weekLabel

    // Only run when status changes TO 'approved'
    if (before.status === after.status || after.status !== 'approved') {
      return null
    }

    functions.logger.info(`Payout report ${weekLabel} approved. Notifying agencies — balances untouched.`)

    // Fetch all hostPayout docs from the subcollection
    const hostPayoutsSnap = await change.after.ref
      .collection('hostPayouts')
      .get()

    if (hostPayoutsSnap.empty) {
      functions.logger.info(`No host payouts in report ${weekLabel}.`)
      return null
    }

    const now = admin.firestore.Timestamp.now()
    const batch = db.batch()
    const notifiedAgencies = new Set<string>()

    for (const payoutDoc of hostPayoutsSnap.docs) {
      const payout = payoutDoc.data()
      const hostUid: string  = payout.hostUid
      const agencyId: string = payout.agencyId

      if (!hostUid) continue

      const hostRef = db.collection('users').doc(hostUid)

      // Approval markers only — no balance is written here (spec 4.4.7).
      // `beans` / `weeklyBeansEarned` stay exactly as the host earned them until
      // the payout is executed on the money board; see the header note above.
      batch.update(hostRef, {
        lastPayoutApprovedAt:   now,
        lastPayoutApprovedWeek: weekLabel,
      })

      // Notify the agency once (not once per host)
      if (agencyId && !notifiedAgencies.has(agencyId)) {
        notifiedAgencies.add(agencyId)

        try {
          const agencySnap = await db.collection('agencies').doc(agencyId).get()
          const agencyData = agencySnap.data()
          const ownerUid: string   = (agencyData?.ownerUid as string) || ''
          const agencyName: string = (agencyData?.agencyName as string) || 'Your Agency'
          const totalPayout: number = (after.agencyPayouts as Record<string, number>)?.[agencyId] || 0

          if (ownerUid) {
            const notifRef = db.collection('notifications').doc()
            batch.set(notifRef, {
              type:      'payout_approved',
              userId:    ownerUid,   // `userId` — the field the read rule tests
              title:     'Payout Approved ✅',
              body:      `Your agency "${agencyName}" payout for ${weekLabel} has been approved. Total: ₹${totalPayout.toFixed(2)}. Host bean balances stay as they are until the payout is executed.`,
              weekLabel,
              agencyId,
              isRead:    false,
              createdAt: now,
            })
          }
        } catch (err) {
          functions.logger.warn(`Failed to notify agency ${agencyId}:`, err)
        }
      }
    }

    await batch.commit()

    functions.logger.info(
      `Payout ${weekLabel} approval recorded for ${hostPayoutsSnap.size} hosts across ${notifiedAgencies.size} agencies. No balances changed.`
    )
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 6. AGORA RTC TOKEN GENERATOR
//    HTTPS Callable — called by Android before joining any Agora channel.
//    Credentials loaded from functions/.env:
//      AGORA_APP_ID=...
//      AGORA_APP_CERTIFICATE=...
//    Token valid for 1 hour.
// ─────────────────────────────────────────────────────────────────────────────

// Region set 11 Sep 2026. Callables have no region requirement of their own —
// unlike Firestore triggers, which must match the database — but every caller
// is in India, and us-central1 adds roughly 200ms to each round trip. That is
// invisible on a token fetch and material on tickCall, which fires every ten
// seconds for the whole of a call.
//
// Safe to move only because nothing is live yet: an installed app pinned to
// us-central1 would 404 the moment this redeploys.
/**
 * The token IS the access control.
 *
 * This used to hand every caller a PUBLISHER token for any channel name they
 * asked for, which made two things true at once:
 *
 *   1. A kick was a suggestion. `kickedViewers` is read by the client, and a
 *      client that ignores it — or simply asks for another token — walks back
 *      into the room. Agora has no idea anyone was removed.
 *   2. Any viewer could publish. A PUBLISHER token in a live room lets the
 *      holder push their own audio and video into the host's channel; nothing
 *      but the app's own UI was stopping them.
 *
 * So the channel name is now resolved against Firestore before a token is cut:
 *
 *   liveRooms/{channelName}   → the host publishes, everyone else subscribes,
 *                               kicked uids are refused outright
 *   a room's pkChannelId      → only the two PK hosts publish; their viewers
 *                               subscribe (and a kick in either room still
 *                               applies)
 *   calls/{channelName}       → only the two parties, both publishing
 *
 * An unknown channel gets SUBSCRIBER. It cannot be a room or a call, so there
 * is nothing there to publish into, and refusing outright would break any
 * channel shape added later before this function learns about it.
 */
export const generateAgoraToken = functions
  .region('asia-south1')
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  }

  const callerUid: string = context.auth.uid
  await assertActiveSession(callerUid, data, 'generateAgoraToken', context.auth?.token)   // Phase 1A (SESSION-001/003)
  const channelName: string = data.channelName
  /*
   * Mutable, because for a party seat the SERVER decides the Agora uid.
   *
   * The client used to send it and this function signed whatever arrived. For a
   * party that is the one number that must not be self-declared: every other
   * client in the room binds a seat's video tile to `agoraUid`, so a client that
   * asked for a token on somebody else's seat index would appear in their tile.
   * The seat document is the authority, and it is read a few lines below.
   */
  let uid: number = (data.uid as number) || 0

  if (!channelName) {
    throw new functions.https.HttpsError('invalid-argument', 'channelName is required.')
  }

  const appId: string = process.env.AGORA_APP_ID || ''
  const appCertificate: string = process.env.AGORA_APP_CERTIFICATE || ''

  if (!appId || !appCertificate) {
    functions.logger.error('Agora credentials not configured in .env')
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Agora credentials not configured on server.'
    )
  }

  /*
   * A BANNED ACCOUNT GETS NO TOKEN — for any channel, in any role.
   *
   * There was no ban check in this function at all. An Agora token is the
   * permission to publish audio and video into a room, so a banned host could
   * keep going live and a banned user could keep watching and commenting: the
   * ban stopped them writing to Firestore and did nothing about the thing they
   * were actually barred for.
   *
   * Checked here rather than per-branch because it is true of every channel
   * kind — live, party and call alike — and a guard that has to be repeated
   * four times is a guard that will be missed once.
   */
  const callerSnap = await db.collection('users').doc(callerUid).get()
  if (callerSnap.get('isBanned') === true) {
    functions.logger.info('agora: refused a restricted account', { channelName, callerUid })
    throw new functions.https.HttpsError(
      'permission-denied',
      String(callerSnap.get('banReason') ?? 'This account is restricted.'),
    )
  }

  // ── Decide the role ───────────────────────────────────────────────────────
  const kicked = (room: FirebaseFirestore.DocumentSnapshot): boolean => {
    const list = room.get('kickedViewers')
    return Array.isArray(list) && list.includes(callerUid)
  }

  /*
   * B41: the HOST's token — publishing into their own live room or PK — is for
   * a CURRENT Host. Going live checks `isHost` once, when the room document is
   * created, and the document outlives it: a Host revoked or removed since kept
   * getting a publisher token for a room opened before. Refused, not quietly
   * downgraded to a viewer, so the app can say why the stream will not start.
   */
  const refuseUnlessCurrentHost = (): void => {
    const notHost = activeHostRefusal(callerSnap)
    if (notHost) {
      functions.logger.info('agora: refused a host token', { channelName, callerUid, code: notHost.code })
      throw new functions.https.HttpsError('permission-denied', notHost.message, { code: notHost.code })
    }
  }

  let role: number = RtcRole.SUBSCRIBER
  let channelKind = 'unknown'

  const roomSnap = await db.collection('liveRooms').doc(channelName).get()

  if (roomSnap.exists) {
    channelKind = 'live'
    if (kicked(roomSnap)) {
      functions.logger.info('agora: refused kicked viewer', { channelName, callerUid })
      throw new functions.https.HttpsError(
        'permission-denied',
        'You were removed from this live by the host.'
      )
    }
    // A room that has ended keeps its document; nobody should be handed a way
    // back into it, host included.
    if (roomSnap.get('isActive') === false) {
      throw new functions.https.HttpsError('failed-precondition', 'This live has ended.')
    }
    if (roomSnap.get('hostUid') === callerUid) {
      refuseUnlessCurrentHost()
      role = RtcRole.PUBLISHER
    } else {
      role = RtcRole.SUBSCRIBER
    }
  } else if (channelName.startsWith('party_')) {
    // Party channels are named `party_<roomId>` so this branch is reachable
    // without a speculative read on every token request.
    //
    // A seat is a publisher slot, and this is what makes that true. Without it,
    // "leave the seat" is a UI state a patched client could ignore while going
    // on broadcasting into the room, and a listener could publish into a room
    // they were never given a seat in.
    channelKind = 'party'
    const roomId = channelName.slice('party_'.length)
    const partySnap = await db.collection('partyRooms').doc(roomId).get()
    if (!partySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'No such party room.')
    }
    if (partySnap.get('isActive') === false) {
      throw new functions.https.HttpsError('failed-precondition', 'This room has closed.')
    }
    const kickedFromParty: string[] = partySnap.get('kickedUsers') ?? []
    if (kickedFromParty.includes(callerUid)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You were removed from this room by the host.',
      )
    }
    /*
     * A PRIVATE room additionally requires a listener row.
     *
     * `joinPartyRoom` writes that row, and only after checking the password. Any
     * signed-in client can read the `partyRooms` collection and learn a room id,
     * so without this check a private room's password would guard the UI and
     * nothing else: skip the join call, ask for a token directly, and you are in
     * the channel hearing every word.
     */
    if (partySnap.get('visibility') === 'private') {
      const admitted = await db
        .collection('partyRooms').doc(roomId)
        .collection('listeners').doc(callerUid)
        .get()
      if (!admitted.exists && partySnap.get('hostUid') !== callerUid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This room is private. Enter the password to join.',
        )
      }
    }

    /*
     * A SEAT is the only thing that grants PUBLISHER — the owner included.
     *
     * The owner used to get PUBLISHER unconditionally, from a `hostUid ===
     * callerUid` shortcut here. That was the token half of modelling the owner as
     * an implicit seat 0: they published on Agora uid 0, held no seat document,
     * and every other client in the room had to find their stream BY ELIMINATION
     * — take the first publisher whose uid is not a seat index. Which also meant
     * the owner could not stand up, because standing up is releasing a seat and
     * they never had one.
     *
     * Now every seat is an ordinary seat and the owner takes one like anybody
     * else, so this is one query for everyone and the uid is always the seat
     * index. `hostUid` still decides who may close the room and who may mute —
     * it just no longer decides who may speak.
     */
    const seat = await db
      .collection('partyRooms')
      .doc(roomId)
      .collection('seats')
      .where('uid', '==', callerUid)
      .limit(1)
      .get()
    role = seat.empty ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER
    if (!seat.empty) {
      // Publish on the seat index, not on 0. Every client binds that seat's tile
      // to this uid, so a mismatch renders a black rectangle on four other
      // phones.
      uid = Number(seat.docs[0].get('agoraUid') ?? seat.docs[0].id) || 0
    }
  } else {
    const callSnap = await db.collection('calls').doc(channelName).get()
    if (callSnap.exists) {
      channelKind = 'call'
      const isParty =
        callSnap.get('callerId') === callerUid || callSnap.get('receiverId') === callerUid
      if (!isParty) {
        functions.logger.warn('agora: refused non-party on call channel', { channelName, callerUid })
        throw new functions.https.HttpsError('permission-denied', 'Not a party to this call.')
      }
      role = RtcRole.PUBLISHER
    } else {
      // PK: the shared channel is named by `pkChannelId`, not by a document id.
      // At most two rooms carry it, so this is a two-document read at worst.
      const pkRooms = await db
        .collection('liveRooms')
        .where('pkChannelId', '==', channelName)
        .limit(2)
        .get()
      if (!pkRooms.empty) {
        channelKind = 'pk'
        const mine = pkRooms.docs.find((d) => d.get('hostUid') === callerUid)
        if (mine) {
          refuseUnlessCurrentHost()
          role = RtcRole.PUBLISHER
        } else {
          // A viewer watching a PK. A kick from either side keeps them out.
          if (pkRooms.docs.some((d) => kicked(d))) {
            throw new functions.https.HttpsError(
              'permission-denied',
              'You were removed from this live by the host.'
            )
          }
          role = RtcRole.SUBSCRIBER
        }
      }
    }
  }

  const currentTs = Math.floor(Date.now() / 1000)
  const privilegeExpiredTs = currentTs + 3600 // 1 hour

  const token: string = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  )

  functions.logger.info('agora: token issued', {
    channelName,
    channelKind,
    callerUid,
    agoraUid: uid,
    role: role === RtcRole.PUBLISHER ? 'publisher' : 'subscriber',
  })

  // `appId` travels with the token. It is not a secret — every copy of the
  // Android app carries it in BuildConfig — and returning it means a caller
  // that is not the app (the CRM's moderation player) needs no second channel
  // to configure, and cannot drift onto the wrong project's id.
  return { token, appId, expiresAt: privilegeExpiredTs * 1000 }
})

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: ISO week number
// ─────────────────────────────────────────────────────────────────────────────

function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. AGENCY REGISTERED — send "Registration received" email
//    Triggers on: new document in agencies/ collection
//    Requires: SENDGRID_API_KEY environment variable
// ─────────────────────────────────────────────────────────────────────────────

export const onAgencyRegistered = asiaFirestoreMail
  .document('agencies/{agencyId}')
  .onCreate(async (snap) => {
    const data = snap.data()
    const email: string     = data.ownerEmail ?? ''
    const name: string      = data.ownerName  ?? 'Agency Owner'
    const agencyName: string = data.agencyName ?? 'Your Agency'

    if (!email) return null

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>

  <!-- Card -->
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">

    <!-- Icon banner -->
    <div style="background:linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;">Registration Successful!</h1>
      <p style="color:#fce7f3;margin:8px 0 0;font-size:14px;opacity:0.9;">Welcome to Zipper Live, ${escapeHtml(name)}</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <p style="color:#cbd5e1;line-height:1.7;margin:0 0 20px;font-size:15px;">
        Your agency <strong style="color:#ffffff;">${escapeHtml(agencyName)}</strong> has been registered successfully.
        Our team will review your details and KYC documents within <strong style="color:#f8fafc;">1–2 business days</strong>.
      </p>

      <!-- Steps -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What happens next</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🔍</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">Our team verifies your submitted documents</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">📧</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">You'll receive an approval email once reviewed</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🚀</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">After approval, log in to your CRM dashboard and start onboarding hosts</td></tr>
        </table>
      </div>

      <!-- Agency info pill -->
      <div style="display:inline-block;background:#1e1b4b;border:1px solid #312e81;border-radius:8px;padding:10px 16px;margin-bottom:24px;">
        <span style="color:#818cf8;font-size:12px;font-weight:600;">Agency Name &nbsp;•&nbsp; </span>
        <span style="color:#c7d2fe;font-size:14px;font-weight:700;">${escapeHtml(agencyName)}</span>
      </div>

      <p style="color:#64748b;font-size:13px;margin:0;line-height:1.6;">
        Questions? Reply to this email or reach us at
        <a href="mailto:314zipper@gmail.com" style="color:#ec4899;text-decoration:none;">314zipper@gmail.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; You're receiving this because you registered an agency</p>
    </div>
  </div>

</div>
</body></html>`

    try {
      await sendMail(email, `✅ Registration received — ${agencyName} | Zipper Live`, html)
    } catch (err) {
      functions.logger.error('Failed to send agency registration email:', err)
    }
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 9. SELLER REGISTERED — send "Registration received" email
//    Triggers on: new document in sellers/ collection — EVERY one of them
// ─────────────────────────────────────────────────────────────────────────────
//
// This used to open with a gate on `data.source` that returned null unless it
// was a self-signup, so a coin seller registered by staff on /sellers/register
// was never told their application had been filed — and `onSellerApproved`
// carried the same gate, so they were never told it had been approved either.
// The comment on the gate claimed
// the others "were admin-created and already onboarded", which is not what
// happens: /sellers/register takes the applicant's own email and phone, creates
// their CRM login and sends them nothing at all. `onAgencyRegistered` has never
// had such a gate; agencies were told and sellers were not, for no reason.
//
// Both gates are gone. Who filed the application does not change whether the
// applicant is owed an acknowledgement. The self-signup path is untouched — it
// sent this mail before and sends exactly the same mail now.
//
// No double send: /sellers/register writes `_resendEmail: 'registration'` at
// creation time, and `onSellerResendEmail` is an onUpdate that fires only when
// that field *changes*. A field present from the first write never changes, so
// it never fired — which is precisely why those sellers heard nothing.

export const onSellerRegistered = asiaFirestoreMail
  .document('sellers/{sellerId}')
  .onCreate(async (snap) => {
    const data = snap.data()

    const email: string = data.email       ?? ''
    const name: string  = data.displayName ?? 'Seller'

    if (!email) return null

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#f59e0b;letter-spacing:-1px;"> Coins</span>
  </div>

  <!-- Card -->
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">

    <!-- Banner -->
    <div style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🛍️</div>
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;">Application Received!</h1>
      <p style="color:#fef3c7;margin:8px 0 0;font-size:14px;opacity:0.9;">Welcome aboard, ${escapeHtml(name)}</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <p style="color:#cbd5e1;line-height:1.7;margin:0 0 20px;font-size:15px;">
        Your Zipper Coin Seller application has been received successfully.
        Our team will verify your ID proof within <strong style="color:#f8fafc;">1–2 business days</strong>.
      </p>

      <!-- Steps -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What happens next</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">📋</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">Our team reviews your submitted ID proof</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">📧</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">You'll receive an approval email with your login link</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">💰</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;line-height:1.5;">After approval, log in and start selling Zipper coins!</td></tr>
        </table>
      </div>

      <p style="color:#64748b;font-size:13px;margin:0;line-height:1.6;">
        Questions? Reach us at
        <a href="mailto:314zipper@gmail.com" style="color:#f59e0b;text-decoration:none;">314zipper@gmail.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; You're receiving this because you applied as a coin seller</p>
    </div>
  </div>

</div>
</body></html>`

    try {
      await sendMail(email, `✅ Application received — Zipper Coin Seller`, html)
    } catch (err) {
      functions.logger.error('Failed to send seller registration email:', err)
    }
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 10. SELLER APPROVED — send "You're approved, you can login" email
//     Triggers on: update to sellers/{sellerId} where isApproved changes to true
// ─────────────────────────────────────────────────────────────────────────────

export const onSellerApproved = asiaFirestoreMail
  .document('sellers/{sellerId}')
  .onUpdate(async (change) => {
    const before = change.before.data()
    const after  = change.after.data()

    // Only fire when isApproved changes to true
    if (before.isApproved === after.isApproved || after.isApproved !== true) return null
    // No `source` gate. A staff-registered seller is approved by the same people
    // against the same evidence as a self-signed-up one, and is owed the same
    // "you can log in now" email — see the note on `onSellerRegistered`. The
    // self-signup path is unchanged.

    const email: string = after.email       ?? ''
    const name: string  = after.displayName ?? 'Seller'

    if (!email) return null

    // Google signups have no password; see `signInHint`.
    const signInWith = await signInHint(String(after.ownerUid ?? after.crmUid ?? ''))

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#f59e0b;letter-spacing:-1px;"> Coins</span>
  </div>

  <!-- Card -->
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">

    <!-- Green banner -->
    <div style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:32px;text-align:center;">
      <div style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:50%;width:64px;height:64px;line-height:64px;font-size:36px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;">You're Approved!</h1>
      <p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">Your coin seller account is now active</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <p style="color:#cbd5e1;line-height:1.7;font-size:15px;margin:0 0 24px;">
        Hi <strong style="color:#ffffff;">${escapeHtml(name)}</strong>,<br><br>
        Your Zipper Coin Seller account has been <strong style="color:#22c55e;">approved</strong>!
        You can now log in and start selling Zipper coins to users in your area.
      </p>

      <!-- Login CTA -->
      <div style="text-align:center;margin:28px 0;">
        <a href="https://zipperlive.web.app/login"
          style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:800;font-size:16px;letter-spacing:0.02em;">
          Log In to Seller Dashboard →
        </a>
        <p style="color:#64748b;font-size:12px;margin:10px 0 0;">
          <a href="https://zipperlive.web.app/login" style="color:#94a3b8;text-decoration:none;">https://zipperlive.web.app/login</a>
        </p>
      </div>

      <!-- Credentials -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">Your Login Credentials</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="color:#64748b;font-size:13px;padding:6px 0;width:80px;">Email</td>
            <td style="color:#ffffff;font-size:14px;font-weight:600;padding:6px 0;">${escapeHtml(email)}</td>
          </tr>
          <tr>
            <td style="color:#64748b;font-size:13px;padding:6px 0;">Password</td>
            <td style="color:#94a3b8;font-size:13px;font-style:italic;padding:6px 0;">${escapeHtml(signInWith)}</td>
          </tr>
        </table>
      </div>

      <!-- What you can do -->
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What you can do now</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">💰</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Sell Zipper coins to users and earn commission</td></tr>
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">📊</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Track your coin transactions and balance</td></tr>
          <tr><td style="width:24px;padding:4px 0;font-size:15px;">📱</td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Share your seller QR code with customers</td></tr>
        </table>
      </div>

      <p style="color:#64748b;font-size:13px;margin:0;line-height:1.6;">
        Need help? Reach us at
        <a href="mailto:314zipper@gmail.com" style="color:#f59e0b;text-decoration:none;">314zipper@gmail.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; Coin Seller Program</p>
    </div>
  </div>

</div>
</body></html>`

    try {
      await sendMail(email, `🎉 You're approved — Start selling Zipper coins!`, html)
    } catch (err) {
      functions.logger.error('Failed to send seller approval email:', err)
    }
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 10. RESEND AGENCY EMAIL (Firestore-triggered)
//     CRM sets agencies/{id}._resendEmail = 'registration' | 'approval'
//     This function detects the field, sends the email, then clears it.
//     Avoids callable functions (which require IAM invoker policy changes).
// ─────────────────────────────────────────────────────────────────────────────

export const onAgencyResendEmail = asiaFirestoreMail
  .document('agencies/{agencyId}')
  .onUpdate(async (change) => {
    const before = change.before.data()
    const after  = change.after.data()

    const resendType = after._resendEmail as string | undefined
    if (!resendType || before._resendEmail === resendType) return null

    // Clear the flag immediately so it doesn't re-trigger
    await change.after.ref.update({ _resendEmail: admin.firestore.FieldValue.delete() })

    const email:      string = after.ownerEmail  ?? ''
    const ownerName:  string = after.ownerName   ?? 'Agency Owner'
    const agencyName: string = after.agencyName  ?? 'Your Agency'

    if (!email) return null

    if (resendType === 'registration') {
      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;">Registration Successful!</h1>
      <p style="color:#fce7f3;margin:8px 0 0;font-size:14px;">Welcome to Zipper Live, ${escapeHtml(ownerName)}</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#cbd5e1;line-height:1.7;margin:0 0 20px;font-size:15px;">
        Your agency <strong style="color:#ffffff;">${escapeHtml(agencyName)}</strong> has been registered.
        Our team will review your details within <strong style="color:#f8fafc;">1–2 business days</strong>.
      </p>
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What happens next</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🔍</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Our team verifies your documents</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">📧</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">You'll receive an approval email once reviewed</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🚀</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">After approval, log in to the CRM and start onboarding hosts</td></tr>
        </table>
      </div>
    </div>
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live</p>
    </div>
  </div>
</div>
</body></html>`
      await sendMail(email, `✅ Registration received — ${agencyName} | Zipper Live`, html)
      functions.logger.info('Resent registration email for agency', { toDomain: mailDomain(email) })
    }

    if (resendType === 'approval') {
      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;">You're Approved!</h1>
      <p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">Your agency is live on Zipper</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#cbd5e1;line-height:1.7;font-size:15px;margin:0 0 24px;">
        Hi <strong style="color:#ffffff;">${escapeHtml(ownerName)}</strong>,<br><br>
        Your agency <strong style="color:#ffffff;">${escapeHtml(agencyName)}</strong> is <strong style="color:#22c55e;">approved</strong>.
        Log in to the CRM to start onboarding hosts.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://zipperlive.web.app/login"
          style="display:inline-block;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:800;font-size:16px;">
          Log In to CRM →
        </a>
      </div>
    </div>
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live</p>
    </div>
  </div>
</div>
</body></html>`
      await sendMail(email, `✅ Your agency "${agencyName}" is approved — Log in now | Zipper Live`, html)
      functions.logger.info('Resent approval email for agency', { toDomain: mailDomain(email) })
    }

    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
//     CRM sets sellers/{id}._resendEmail = 'registration' | 'approval'
//     This function detects the field, sends the email, then clears it.
// ─────────────────────────────────────────────────────────────────────────────

export const onSellerResendEmail = asiaFirestoreMail
  .document('sellers/{sellerId}')
  .onUpdate(async (change) => {
    const before = change.before.data()
    const after  = change.after.data()

    const resendType = after._resendEmail as string | undefined
    if (!resendType || before._resendEmail === resendType) return null

    // Clear the flag immediately so it doesn't re-trigger
    await change.after.ref.update({ _resendEmail: admin.firestore.FieldValue.delete() })

    const email:       string = after.email       ?? ''
    const sellerName:  string = after.displayName ?? 'Seller'

    if (!email) return null

    if (resendType === 'registration') {
      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;">Application Received!</h1>
      <p style="color:#fce7f3;margin:8px 0 0;font-size:14px;">Welcome to Zipper Live, ${escapeHtml(sellerName)}</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#cbd5e1;line-height:1.7;margin:0 0 20px;font-size:15px;">
        Your Zipper Coin Seller application has been received successfully.
        Our team will review your details within <strong style="color:#f8fafc;">1–2 business days</strong>.
      </p>
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 14px;">What happens next</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🔍</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">Our team verifies your application</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">📧</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">You'll receive an approval email once reviewed</td></tr>
          <tr><td style="width:28px;vertical-align:top;padding:4px 0;"><span style="font-size:16px;">🪙</span></td>
              <td style="color:#cbd5e1;font-size:14px;padding:4px 0 4px 8px;">After approval, start selling Zipper coins</td></tr>
        </table>
      </div>
    </div>
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; You're receiving this because you applied as a coin seller</p>
    </div>
  </div>
</div>
</body></html>`
      await sendMail(email, `✅ Application received — Zipper Coin Seller`, html)
      functions.logger.info('Resent seller registration email', { toDomain: mailDomain(email) })
    }

    if (resendType === 'approval') {
      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0f1e;">
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
  <div style="text-align:center;padding:32px 0 24px;">
    <span style="font-size:32px;font-weight:900;color:#ec4899;letter-spacing:-1px;">Zipper</span>
    <span style="font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;"> Live</span>
  </div>
  <div style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;">You're Approved!</h1>
      <p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">Your coin seller account is now active</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#cbd5e1;line-height:1.7;font-size:15px;margin:0 0 24px;">
        Hi <strong style="color:#ffffff;">${escapeHtml(sellerName)}</strong>,<br><br>
        Your Zipper Coin Seller account has been <strong style="color:#22c55e;">approved</strong>!
        You can now log in and start selling coins.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://zipperlive.web.app/login"
          style="display:inline-block;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:800;font-size:16px;">
          Log In to Seller Dashboard →
        </a>
      </div>
    </div>
    <div style="background:#0f172a;border-top:1px solid #1e293b;padding:16px 32px;text-align:center;">
      <p style="color:#475569;font-size:12px;margin:0;">© Zipper Live &nbsp;·&nbsp; Coin Seller Program</p>
    </div>
  </div>
</div>
</body></html>`
      await sendMail(email, `🎉 You're approved — Start selling Zipper coins!`, html)
      functions.logger.info('Resent seller approval email', { toDomain: mailDomain(email) })
    }

    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
//  APPROVAL WORKFLOW — applies non-money admin changes when superadmin approves
//
//  This queue does NOT move money. It used to: one superadmin flipping a status
//  to 'approved' applied bean, diamond and coin balance changes straight to
//  Firestore — one approver, no verification, no separation of duties, no
//  ledger, no audit entry. That is now refused (see MONEY_APPROVAL_TYPES).
//
//  Money moves on the five-stage board in the Python API
//  (backend/app/services/cards.py):
//      Requested → Under Review → Awaiting Sign-off → Approved → Executed
//  raised by one person, verified by a second, signed by a business owner who
//  raised neither, then executed through money.apply_movement
//  (backend/app/services/money.py), which commits the balance change, the ledger
//  entry and the audit entry in a single Mongo transaction and only then syncs
//  Firestore as a read replica.
// ─────────────────────────────────────────────────────────────────────────────

// Approval types that used to settle balances inside handleCustomApproval.
// They are refused on arrival now so an old client gets a visible refusal
// instead of a request that sits there looking approved.
const MONEY_APPROVAL_TYPES = [
  'credit_beans',
  'debit_beans',
  'credit_diamonds',
  'debit_diamonds',
  'lend_diamonds',
]

const MONEY_TYPE_REFUSAL =
  'This approval queue no longer moves money. A single superadmin approval is ' +
  'not enough to change a balance: the change must be raised as a card on the ' +
  'money board (raise → verify → sign → execute, with a ledger entry and an ' +
  'audit entry). Bean/diamond adjustments: POST /api/users/{uid}/balance-request ' +
  'then POST /api/users/balance-cards/{cardId}/execute. Seller lending: ' +
  'POST /api/partner-ops/sellers/{sellerId}/lending then ' +
  'POST /api/partner-ops/lending/{cardId}/execute.'

// REMOVED: `operation === 'update'` used to run
//   db.collection(targetCollection).doc(targetDocId).update(payload)
// with collection, document id and payload all supplied by the browser — an
// approved request could rewrite any document in any collection. It is replaced
// by this allowlist, which covers the only two callers left that use it:
//   • zipper-crm/app/tech/appcontrol/page.tsx   → appConfig/control
//   • zipper-crm/app/economy/config/page.tsx    → appConfig/economy
// Anything else asking for an update is refused.
//
// `add_host` → hostApplications/{id} used to be the third. See
// HOST_DECISION_TYPES below for why it is not any more.
const UPDATE_ALLOWLIST: Record<string, { collection: string; docIds: string[] }> = {
  // docIds empty = any document in that collection is allowed.
  update_config: { collection: 'appConfig',        docIds: ['control', 'economy'] },
}

// GOV-1 (Phase 1A.2, B5): the `create` branch is held to the same discipline.
// It used to run `db.collection(targetCollection).doc(targetDocId).set(payload)`
// with all three supplied by the browser that filed the request — so one
// approval could write ANY document, `crmUsers/{owner}` with `role:
// 'superadmin'` included, overwriting whatever was there, through the Admin SDK
// and past every rule and audit. The only callers left are the two register
// forms (zipper-crm/app/agencies/register, zipper-crm/app/sellers/register),
// and each creates a NEW record whose id is minted here. A request that names
// a document id is refused, because `.set()` on an existing id is an overwrite.
const CREATE_ALLOWLIST: Record<string, string> = {
  create_agency: 'agencies',
  create_seller: 'sellers',
}

// GOV-1 (B5): the person who filed a request cannot be the one who approves it.
// The queue exists so that a second person looks; an Owner approving their own
// request is one person writing through the Admin SDK with nobody else involved.
const SELF_APPROVAL_REFUSAL =
  'This request was approved by the same person who filed it. The approval ' +
  'queue needs a second person — an Owner other than the requester — so ' +
  'nothing was applied. File it again and have another Owner approve it.'

// Approval types that used to decide a host application from this queue. They
// are refused on arrival, for the same reason MONEY_APPROVAL_TYPES are: this is
// no longer where that decision is made.
//
// `add_host` wrote `status: 'approved'` onto a `hostApplications` document and
// nothing else — never `kycStatus`, which is the other half of the same
// decision, and never a reason, a decider or a time. Two other screens wrote the
// other half, so the fields drifted and no screen agreed with any other about
// whether a host had been approved. A host application now has exactly one
// decision writer, `POST /api/users/host-applications/{id}/decide`, which writes
// both fields together with who decided and why, and which grants the host
// account in the same call.
//
// The invitation itself is unaffected and nothing is lost by refusing this. The
// Invite Host form writes the `hostApplications` document first and that
// document is the invitation — it appears in the host queue on /kyc, and the
// applicant can redeem the referral code while it is pending, because
// `activateHost` and `checkReferralCode` (functions/src/hosts.ts) refuse only
// `status: 'rejected'`. Approving the request added a preference and a field;
// it was never the gate it looked like.
const HOST_DECISION_TYPES = ['add_host']

const HOST_DECISION_REFUSAL =
  'Host applications are no longer decided from this queue. A host has two ' +
  'status fields — `status` and `kycStatus` — and this path wrote only one of ' +
  'them, with no reason and nobody named, so an application could be approved ' +
  'here and still read as pending everywhere else. Decide it on the KYC review ' +
  'screen (/kyc → Hosts) instead: that shows the documents, requires a reason, ' +
  'writes both fields together and grants the host account in the same call. ' +
  'THE INVITATION IS UNAFFECTED — the application is still in the queue and the ' +
  'referral code still works; only this rubber stamp is gone.'

export const onApprovalApproved = asiaFirestore
  .document('approvalRequests/{requestId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after  = change.after.data()
    const requestId: string = context.params.requestId

    // Only trigger when status changes to 'approved'
    if (before.status === after.status || after.status !== 'approved') return null

    const { targetCollection, targetDocId, operation, payload, type } = after

    functions.logger.info(
      `Applying approval ${requestId}: type=${type}, collection=${targetCollection}, doc=${targetDocId}`
    )

    // Money never moves from this queue — refuse before anything is touched.
    if (MONEY_APPROVAL_TYPES.includes(type as string)) {
      functions.logger.warn(
        `Approval ${requestId} refused — '${type}' is a money movement and belongs on the money board.`
      )
      await failApproval(change.after.ref, MONEY_TYPE_REFUSAL, after.reviewNotes as string | undefined)
      return null
    }

    // Nor is a host decided from here any more — refused before the application
    // document is touched, so a half-written decision is not the outcome.
    if (HOST_DECISION_TYPES.includes(type as string)) {
      functions.logger.warn(
        `Approval ${requestId} refused — '${type}' decides a host application, which is done on /kyc.`
      )
      await failApproval(change.after.ref, HOST_DECISION_REFUSAL, after.reviewNotes as string | undefined)
      return null
    }

    // GOV-1 (B5): who approved it. `reviewedBy` is written by the approving
    // browser — the rules bind its uid to the caller — and it is checked again
    // here because this is the step that writes with full authority.
    const approver = await approverRefusal(after)
    if (approver) {
      functions.logger.warn(`Approval ${requestId} refused — ${approver}`)
      await failApproval(change.after.ref, approver, after.reviewNotes as string | undefined)
      return null
    }

    try {
      const note = await applyApproval(
        type as string,
        operation as string,
        targetCollection as string,
        (targetDocId as string) ?? '',
        (payload as Record<string, unknown>) ?? {},
      )

      await change.after.ref.update({
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        // What was done beyond writing the target document — today, whether a
        // CRM account was written for a partner's login. It goes on the request
        // itself so the record of the decision also records its consequence.
        ...(note ? { appliedNote: note } : {}),
      })

      functions.logger.info(
        `Approval ${requestId} applied: ${type}${note ? ` — ${note}` : ''}`,
      )
    } catch (err) {
      functions.logger.error(`Failed to apply approval ${requestId} (${type}):`, err)

      // The request must never be left claiming success it did not have.
      const message = err instanceof Error ? err.message : String(err)
      await failApproval(
        change.after.ref,
        `Approval could not be applied: ${message}`,
        after.reviewNotes as string | undefined,
      )
    }

    return null
  })

/**
 * Mark an approval request as failed and say why, on the document itself.
 *
 * 'rejected' is used because it is the only non-pending failure state the CRM
 * renders (zipper-crm/app/approvals/page.tsx). `applyError` carries the machine
 * readable reason; `reviewNotes` puts it in front of whoever opens the request.
 */
async function failApproval(
  ref: FirebaseFirestore.DocumentReference,
  reason: string,
  existingNotes?: string,
): Promise<void> {
  const notes = [existingNotes?.trim(), reason].filter(Boolean).join(' — ')
  try {
    await ref.update({
      status:        'rejected',
      applyFailed:   true,
      applyError:    reason,
      applyFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes:   notes,
      appliedAt:     admin.firestore.FieldValue.delete(),
    })
  } catch (err) {
    functions.logger.error('Failed to record approval failure on the request:', err)
  }
}

/**
 * GOV-1 (B5): why this approval may not be applied, or '' when it may.
 *
 * The reviewer must be named, must not be the requester, and must be an active
 * Owner — the only role the rules let approve, re-read from `crmUsers` rather
 * than trusted from the request.
 */
async function approverRefusal(request: FirebaseFirestore.DocumentData): Promise<string> {
  const uidOf = (who: unknown): string => {
    const uid = (who as { uid?: unknown } | null | undefined)?.uid
    return typeof uid === 'string' ? uid.trim() : ''
  }
  const reviewer = uidOf(request.reviewedBy)
  const requester = uidOf(request.requestedBy)
  if (!reviewer) return 'The approval does not name who approved it, so nothing was applied.'
  if (!requester) return 'The request does not name who filed it, so nothing was applied.'
  if (reviewer === requester) return SELF_APPROVAL_REFUSAL

  const snap = await db.collection('crmUsers').doc(reviewer).get()
  const reviewerDoc = (snap.exists ? snap.data() : undefined) ?? {}
  if (reviewerDoc.role !== 'superadmin' || reviewerDoc.isActive === false) {
    return 'Only an active Owner may approve a request in this queue, and the ' +
      'approval names someone who is not one, so nothing was applied.'
  }
  return ''
}

/**
 * GOV-1 (B5): what a queued partner registration may contain.
 *
 * `ref.set()` below runs through the Admin SDK, so the `agencies` / `sellers`
 * create rules never see it. Their invariants — `partnerCreateSafe()` and the
 * zero-balance pin — are restated here: an approved request can open a
 * PENDING, inactive, unfunded record and nothing more. Approval, activation,
 * owner links and opening balances are separate, audited operations.
 */
function assertPartnerCreatePayload(type: string, payload: Record<string, unknown>): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Approval type '${type}' carries no record to create.`)
  }
  const refuse = (why: string): never => {
    throw new Error(`Approval type '${type}' would create a record that ${why}. Nothing was created.`)
  }
  const set = (key: string): boolean => payload[key] !== undefined
  if (set('status') && payload.status !== 'pending') refuse(`is already '${String(payload.status)}' (it must start pending)`)
  if (set('isActive') && payload.isActive !== false) refuse('is already active')
  if (set('isApproved') && payload.isApproved !== false) refuse('is already approved')
  if (set('approvedBy') || set('approvedAt')) refuse('carries an approval')
  for (const key of ['coinBalance', 'totalCoinsSold']) {
    if (set(key) && payload[key] !== 0) refuse(`opens with a non-zero ${key}`)
  }
  for (const key of ['ownerUid', 'secondRoleOwnerUid']) {
    if (set(key) && payload[key] !== '' && payload[key] !== null) refuse(`names an owner in ${key}`)
  }
}

/**
 * Keys that are never written out of an approval payload, whatever the browser
 * that filed it put there.
 *
 * `/agencies/register` used to file the agency owner's CRM password on the
 * request as `_password` — under a comment calling it a "password hash hint" —
 * and the create branch below copied the whole payload onto the new `agencies`
 * document. `approvalRequests` is readable by the superadmin AND by the
 * requester, and `agencies` by every admin, so one plaintext credential sat at
 * rest in two collections. Nothing ever read it.
 *
 * The form no longer writes it: the Firebase Auth account is created at
 * registration time and only the resulting uid travels through the queue. But
 * every request filed BEFORE that change is still in this queue carrying the
 * password, and approving one would still copy it onto a live agency record —
 * so it is dropped here too, at the last point before the write.
 *
 * Dropped. Not hashed, not encrypted, not moved somewhere safer: there is
 * nothing useful to do with a credential that should not exist. Rotating the
 * ones already written is a separate, manual job — see
 * backend/scripts/normalise_partner_emails.py's docstring for the sweep.
 */
const NEVER_APPLIED = ['_password', 'password', 'confirmPassword']

/** The payload minus anything in NEVER_APPLIED, saying loudly if it dropped one. */
function withoutCredentials(
  payload: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (NEVER_APPLIED.includes(key)) {
      dropped.push(key)
      continue
    }
    clean[key] = value
  }
  if (dropped.length > 0) {
    functions.logger.warn(
      `Approval ${label} carried ${dropped.join(', ')} — a credential, which was ` +
      'NOT written to the target document. This request predates the fix that ' +
      'stopped the register form filing it. The value is still on the request ' +
      'itself; delete the field and have the owner reset that password.',
    )
  }
  return clean
}

/** Which partner collection maps to which CRM role. */
const PARTNER_LOGIN_ROLE: Record<string, 'agency' | 'seller'> = {
  agencies: 'agency',
  sellers:  'seller',
}

/**
 * Write the `crmUsers` document for a partner whose login already exists.
 *
 * This is the other half of the password fix. `/agencies/register` and
 * `/sellers/register` both create the Firebase Auth account when the form is
 * submitted — while the password is still only in that browser's memory — and
 * put `crmUid` on the approval request. The account it names can authenticate
 * but has no CRM identity until this document exists, and it cannot be written
 * from the browser: the rules bind a partner's own `crmUsers` create to a
 * partner record that names them (`agencyNamesCaller()` / `sellerNamesCaller()`
 * in firestore.rules), and that record does not exist until the approval is
 * applied. The Admin SDK bypasses rules entirely, so it is the only thing that
 * can write this document at this point in the flow.
 *
 * Generic over both partner collections. Mirrors `createAgencyAccount` /
 * `createSellerAccount` in zipper-crm/lib/auth.ts field for field — including
 * the link field, which is `agencyId` for an agency and `sellerId` for a
 * seller, and including `status: 'pending'`: approving the REQUEST creates the
 * records; approving the PARTNER is a separate decision taken on its own
 * screen, with a reason.
 *
 * `crmUid` itself is NOT written here. It stays in the payload, and `ref.set`
 * in applyApproval() puts it on the partner document in the same operation that
 * creates it — which is what the many `crmUid == request.auth.uid` clauses in
 * firestore.rules bind on. A partner holding this document but with no
 * back-link on its record can sign in and reach nothing.
 *
 * A payload with no `crmUid` (every request filed before the register forms
 * created the login themselves) is left exactly as it was: nothing is written
 * and nothing is refused.
 */
async function writePartnerCrmUser(
  targetCollection: string,
  partnerId: string,
  payload: Record<string, unknown>,
): Promise<{ note: string; createdUid: string }> {
  const role = PARTNER_LOGIN_ROLE[targetCollection]
  const uid = typeof payload.crmUid === 'string' ? payload.crmUid.trim() : ''
  if (!role || !uid) return { note: '', createdUid: '' }

  const crmRef = db.collection('crmUsers').doc(uid)
  const existing = await crmRef.get()
  if (existing.exists) {
    // A re-delivered trigger, or an account that already belongs to somebody.
    // Either way this is not the place to overwrite one.
    return { note: `crmUsers/${uid} already existed and was left untouched`, createdUid: '' }
  }

  const field = (agencyKey: string, sellerKey: string): string =>
    String(payload[role === 'agency' ? agencyKey : sellerKey] ?? '').trim()

  const email = field('ownerEmail', 'email').toLowerCase()
  if (!email) {
    throw new Error(
      `The request names a login (${uid}) but the ${targetCollection} payload ` +
      'carries no email address, so no CRM account could be written for it. ' +
      'Nothing was created — an approved partner nobody can sign in as is worse ' +
      'than a refused approval.',
    )
  }

  await crmRef.set({
    uid,
    email,
    name:  field('ownerName', 'displayName'),
    phone: field('ownerPhone', 'phone'),
    role,
    // DEFAULT_PERMISSIONS['agency'] and ['seller'] in zipper-crm/lib/auth.ts are
    // both empty: an external partner holds no CRM permission, and what it may
    // do is decided by firestore.rules from `role` and the partner id below.
    permissions: [],
    ...(role === 'agency' ? { agencyId: partnerId } : { sellerId: partnerId }),
    isActive: true,
    status: 'pending',
    createdBy: 'crm_admin',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLoginAt: null,
  })

  return {
    note: `crmUsers/${uid} written — the ${role} can sign in once it is approved`,
    createdUid: uid,
  }
}

/**
 * Route an approved request to the handler for its operation. Throws on refusal.
 * Returns a short note about anything done beyond the target document itself.
 */
async function applyApproval(
  type: string,
  operation: string,
  targetCollection: string,
  targetDocId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  if (typeof targetCollection !== 'string' || !targetCollection) {
    throw new Error('Approval has no target collection.')
  }

  if (operation === 'update') {
    await applyNarrowUpdate(type, targetCollection, targetDocId, payload)
    return ''
  }

  if (operation === 'create') {
    // GOV-1 (B5): only the two partner registrations, each into its own
    // collection, each a NEW document. See CREATE_ALLOWLIST.
    const collection = CREATE_ALLOWLIST[type]
    if (!collection) {
      throw new Error(
        `Approval type '${type}' may not create documents. This queue creates ` +
        'only new agency and seller records (create_agency, create_seller).'
      )
    }
    if (targetCollection !== collection) {
      throw new Error(`Approval type '${type}' may only create in '${collection}', not '${targetCollection}'.`)
    }
    if (targetDocId) {
      throw new Error(
        `Approval type '${type}' names a document id ('${targetDocId}'). The id is ` +
        'minted here; writing to a named id would overwrite that document.'
      )
    }
    assertPartnerCreatePayload(type, payload)

    // create_agency / create_seller submit an empty targetDocId — the id is
    // minted here rather than passed through db.collection(x).doc(''), which throws.
    const ref = db.collection(collection).doc()

    // The CRM account FIRST, the partner record second, and deliberately that
    // way round. `.doc()` mints the id locally and writes nothing, so nothing
    // exists yet — and `writePartnerCrmUser` throws when it cannot write, which
    // here means the approval is recorded as failed with the reason on it and
    // NOTHING was created. The other order would leave a live agency whose owner
    // cannot sign in beside a request claiming success: the exact half-made
    // state `/agencies` badges "no login attached".
    const login = await writePartnerCrmUser(targetCollection, ref.id, payload)

    try {
      await ref.set({
        ...withoutCredentials(payload, `${type} → ${targetCollection}`),
        _approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    } catch (err) {
      // Undo only what this invocation created, so a pre-existing account is
      // never removed by a failure that has nothing to do with it.
      if (login.createdUid) {
        try {
          await db.collection('crmUsers').doc(login.createdUid).delete()
        } catch (cleanupErr) {
          functions.logger.error(
            `crmUsers/${login.createdUid} was written for a ${targetCollection} ` +
            'document that then failed to write, and could not be removed. It is ' +
            'a CRM account pointing at a partner record that does not exist:',
            cleanupErr,
          )
        }
      }
      throw err
    }

    return login.note
  }

  // REMOVED — GOV-1 (B5): `delete` and `custom`.
  //   • delete  ran `db.collection(targetCollection).doc(targetDocId).delete()`
  //             on whatever the browser named — any document in any collection.
  //   • custom  ran handleCustomApproval: approve / reject / deactivate /
  //             reactivate an agency or seller, as a bare status write on any
  //             document named, skipping partner_ops' eligibility checks,
  //             per-role status, claims and audit entry.
  // Nothing in the CRM files either any more. Partner decisions are the
  // partner-ops API's (POST /api/partner-ops/partners/{id}/approve | reject |
  // reactivate | revoke), which is audited.
  throw new Error(
    `Approval operation '${operation}' is not applied by this queue. It applies ` +
    'only update_config and new agency / seller registrations.'
  )
}

/**
 * The narrow replacement for the old arbitrary-document `update` branch.
 * Only the allowlisted type/collection/document combinations are applied.
 */
async function applyNarrowUpdate(
  type: string,
  targetCollection: string,
  targetDocId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const rule = UPDATE_ALLOWLIST[type]
  if (!rule) {
    throw new Error(
      `Approval type '${type}' may not update documents. This queue no longer ` +
      'applies a browser-supplied collection, document id and payload.'
    )
  }
  if (targetCollection !== rule.collection) {
    throw new Error(
      `Approval type '${type}' may only update '${rule.collection}', not '${targetCollection}'.`
    )
  }
  if (!targetDocId) {
    throw new Error(`Approval type '${type}' needs a target document id.`)
  }
  if (rule.docIds.length > 0 && !rule.docIds.includes(targetDocId)) {
    throw new Error(
      `Approval type '${type}' may only update ${rule.collection}/{${rule.docIds.join('|')}}, not '${targetDocId}'.`
    )
  }

  const targetRef = db.collection(targetCollection).doc(targetDocId)

  // The `add_host` branch that lived here is gone. It wrote `status: 'approved'`
  // onto a host application and nothing else, which is half of a decision —
  // `kycStatus` is the other half. `onApprovalApproved` now refuses the type
  // outright before reaching this function; see HOST_DECISION_TYPES.

  // update_config — the payload is the config document itself. The allowlist has
  // already pinned it to appConfig/control or appConfig/economy, neither of which
  // holds a balance.
  //
  // `appConfig/economy` does, however, hold the commission slab tables the API
  // reads to decide what every agency is owed. A non-superadmin edits them by
  // filing an approval, and that path never passed through the browser-side
  // check in zipper-crm/lib/economyConfig.ts — so this is the second door into
  // the same document, and it gets the same lock.
  if (targetDocId === 'economy') {
    assertSlabTablesAreSane(payload)
  }

  await targetRef.update({
    ...withoutCredentials(payload, `${type} → ${targetCollection}/${targetDocId}`),
    _approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

/**
 * Refuse a commission slab table the API would not accept.
 *
 * Mirrors `parse_slabs` in backend/app/services/commission.py and
 * `validateSlabTable` in zipper-crm/lib/economyConfig.ts. A table with a gap,
 * an overlap or an out-of-range rate makes the server raise
 * `MalformedSlabTable` and compute nothing — every agency's commission stops,
 * with the cause buried in an approval that looked like it succeeded. Refusing
 * here means the approval fails visibly, with the reason attached to it.
 *
 * Note what is *not* checked: a `from` of 0. A zero floor is a policy the owner
 * may choose and the server accepts it. It is simply never what the defaults
 * ship, because the live floors are ₹25,001 (main) and ₹26,001 (sub).
 */
function assertSlabTablesAreSane(payload: Record<string, unknown>): void {
  const cc = payload.commissionConfig as Record<string, unknown> | undefined
  if (!cc || typeof cc !== 'object') return   // this edit does not touch the slabs

  for (const [key, who] of [
    ['mainAgencySlabs', 'Main agency'],
    ['subAgencySlabs', 'Sub-agency'],
  ] as const) {
    const raw = cc[key]
    if (raw === undefined) continue           // this edit does not touch this table
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(
        `${who} commission slab table is missing or empty. An empty table is not ` +
        'the same as a zero rate — nothing can be paid from it, so it is refused.'
      )
    }

    const bands = raw.map((entry, i) => {
      const slab = entry as Record<string, unknown>
      const from = slab?.from
      const to = slab?.to
      const rate = slab?.rate
      const n = i + 1
      if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
        throw new Error(`${who} slab ${n} has an invalid 'from' (${String(from)}). Bounds are whole, non-negative rupees.`)
      }
      if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) {
        throw new Error(`${who} slab ${n} has an invalid 'to' (${String(to)}). Bounds are whole, non-negative rupees.`)
      }
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new Error(`${who} slab ${n} has a rate of ${String(rate)}%, which is outside 0–100%.`)
      }
      if (to < from) {
        throw new Error(`${who} slab ${n} runs from ₹${from} to ₹${to} — its upper bound is below its lower bound.`)
      }
      return { from, to }
    })

    bands.sort((a, b) => (a.from - b.from) || (a.to - b.to))
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1]
      const cur = bands[i]
      if (cur.from <= prev.to) {
        throw new Error(
          `${who} slabs ₹${prev.from}–₹${prev.to} and ₹${cur.from}–₹${cur.to} overlap. ` +
          'Two bands could claim the same billing figure, so nothing is paid until the table is fixed.'
        )
      }
      if (cur.from !== prev.to + 1) {
        throw new Error(
          `${who} slab table has a gap between ₹${prev.to} and ₹${cur.from} — billing of ` +
          `₹${prev.to + 1} falls in no band.`
        )
      }
    }
  }
}

// REMOVED — GOV-1 (B5): handleCustomApproval, the `custom` operation's handler
// (approve_agency, reject_agency, approve_seller, deactivate_agency/_seller,
// reactivate_agency/_seller). It applied each as a bare status write to whatever
// document the request named. See applyApproval() for where those decisions
// live now.
//
// Its money branches had been removed before that, and are still refused on
// arrival (MONEY_APPROVAL_TYPES):
//   • credit_beans / debit_beans / credit_diamonds / debit_diamonds
//       → POST /api/users/{uid}/balance-request,
//         then POST /api/users/balance-cards/{cardId}/execute
//   • lend_diamonds
//       → POST /api/partner-ops/sellers/{sellerId}/lending,
//         then POST /api/partner-ops/lending/{cardId}/execute
// Execution runs through money.apply_movement (backend/app/services/money.py),
// which commits balance + ledger + audit in one Mongo transaction.

// ─────────────────────────────────────────────────────────────────────────────
// 12. THE SCHEDULED REPORTS, ALERTS AND TRANSACTIONAL SWEEP — Part 8A
//
//     WHAT THIS IS. `backend/app/services/scheduling.py` and
//     `backend/app/services/alerts.py` implement the whole of 8A.2 – 8A.4: the
//     daily business summary, the Finance worklist, the exception report, the
//     weekly business report, partner statements, the monthly pack, nine
//     exception detectors and the transactional email sweep. Every one of them
//     already had an HTTP trigger and an identity to call it with. What none of
//     them had was a clock. This section is the clock.
//
//     WHY A FUNCTION RATHER THAN CLOUD SCHEDULER STRAIGHT TO CLOUD RUN.
//     Scheduler → Cloud Run with an OIDC token is the better shape in the
//     abstract: Google signs the token, Cloud Run's IAM verifies it, and there
//     is no shared secret for the two sides to drift on. It is not available
//     here, for a reason that is in this repository rather than a matter of
//     taste:
//
//       * The API is served to the CRM through the Firebase Hosting rewrite in
//         `firebase.json` (`/api/**` → the `zipper-api` Cloud Run service).
//         Hosting invokes Cloud Run anonymously, so the service must keep
//         `--allow-unauthenticated` (DEPLOYMENT.md § 4 says so and says why).
//         With that set, Cloud Run's IAM invoker check is not enforced for
//         anybody — including Cloud Scheduler — so an OIDC token would arrive
//         and be ignored. It would look like authentication and be decoration.
//       * Verifying the token inside FastAPI instead would work, but it would
//         put a second machine-authority model beside the one in
//         `app/core/security.py` — one with no `Op` allowlist, where "Google
//         signed this" is the whole check. The existing model's central claim
//         is that a credential names the exact operations it may perform. A
//         parallel path that cannot express that is not an improvement on it.
//
//     So: Cloud Scheduler fires these functions (that is what
//     `.pubsub.schedule()` deploys — a Scheduler job and a Pub/Sub topic), and
//     they call the API with the reporting service key, exactly as
//     `weeklyPayoutReportGenerator` in section 1 calls it with the accrual key.
//     Same header, same redaction, same "say which variable is missing"
//     failure. One pattern, deployed twice, rather than two.
//
//     THE KEY IS NOT THE ACCRUAL ONE. `SERVICE_KEY_REPORTING` is a separate
//     credential holding `reports.send`, `alerts.scan`, `email.sweep` and
//     `email.events` — and no money operation at all. The two allowlists are
//     disjoint and `backend/tests/test_service_credential.py` fails if they
//     ever stop being. Leaking the ability to email a report must not also
//     grant the ability to create a commission liability, so these functions
//     cannot accrue and `weeklyPayoutReportGenerator` cannot send a report.
//
//     THE CLOCK IS THE OWNER'S. Every schedule below is Asia/Kolkata, and so is
//     every period the jobs cover — `REPORT_TIMEZONE` in `backend/app/config.py`
//     and `scheduling.business_tz()`. A "daily" report fired at 07:00 IST
//     covers 00:00–24:00 IST of the day before, which finished seven hours
//     earlier. Firing on a UTC clock and cutting the day in UTC would have
//     produced a report that dropped every evening — the busiest hours of a
//     live-streaming business — and quietly folded this morning in instead.
//
//     WHAT HAPPENS WHEN ONE FAILS. Nothing here retries by hand and nothing
//     swallows an error. A job that cannot run throws, which marks the Cloud
//     Scheduler execution failed and puts an ERROR in Cloud Logging naming the
//     variable or the permission that is missing. The backend has already
//     written the attempt to `scheduled_runs`, so it is on
//     `GET /api/notifications/runs/last` with `status: "failed"` whether or not
//     anyone reads the function's log. Re-running one is safe and is § 9.7 of
//     DEPLOYMENT.md: every report is stored under its period and every email
//     carries a dedupe key, so a second firing sends nothing twice.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reporting credential, from Google Secret Manager via
 * `runWith({ secrets })`. Never a literal in this file, never in
 * `functions/.env`, never logged.
 *
 * Deliberately a different variable and a different secret from
 * `ZIPPER_ACCRUAL_KEY`. They hold different values; see DEPLOYMENT.md § 9.
 */
const REPORTING_KEY_ENV = 'ZIPPER_REPORTING_KEY'

/**
 * The business timezone. Every schedule below and every window the backend cuts
 * are this one — `REPORT_TIMEZONE` in `backend/app/config.py`.
 *
 * Asia/Kolkata is UTC+05:30 all year, so no schedule here moves twice a year
 * and no report period silently changes length.
 */
const BUSINESS_TIMEZONE = 'Asia/Kolkata'

/** A scheduled job gets this long. Statements to every partner is the slow one. */
const JOB_TIMEOUT_SECONDS = 540

/**
 * One scheduled job's whole HTTP call gets this long. Longer than
 * `REQUEST_TIMEOUT_MS`, because a monthly pack builds several CSVs before it
 * answers, and shorter than the function timeout so a hung backend is reported
 * rather than killed.
 */
const JOB_REQUEST_TIMEOUT_MS = 480_000

interface JobOutcome {
  ran: boolean
  status: number | null
  /** The backend's own verdict: ok | degraded | failed. */
  verdict: string
  emailsAccepted: number | null
  /** Everything the run says did not work. Safe to log; never holds the key. */
  problems: string[]
  detail: string
}

/**
 * One API call for a scheduled job, with its own longer timeout.
 *
 * Deliberately not `callApi`: that one is tuned for the fifty short calls the
 * accrual makes and a 25-second ceiling is right there. A monthly accounting
 * pack is one call that legitimately takes minutes, and giving it the accrual's
 * timeout would abort a run that was working.
 */
async function callJobApi(
  config: ServiceApiConfig,
  path: string,
): Promise<ApiResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JOB_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        [SERVICE_KEY_HEADER]: config.key,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })

    let body: Record<string, unknown> | null = null
    let raw = ''
    try {
      raw = await response.text()
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    } catch {
      body = null
    }

    if (!response.ok && body === null) {
      return {
        ok: false,
        status: response.status,
        body: null,
        error: withoutKey(
          `HTTP ${response.status} with a non-JSON body: ` +
          `${raw.slice(0, 300) || '(empty)'}`,
          config.key,
        ),
      }
    }
    return { ok: response.ok, status: response.status, body, error: '' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: null,
      body: null,
      error: withoutKey(
        timedOut
          ? `no response within ${JOB_REQUEST_TIMEOUT_MS / 1000}s`
          : `the backend could not be reached — ${message}`,
        config.key,
      ),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Everything a run says did not work, flattened for one log line. */
function problemsOf(body: Record<string, unknown> | null): string[] {
  if (!body) return []
  const out: string[] = []
  for (const field of ['problems', 'errors', 'failed_sections', 'failed_sweeps',
                       'failed_detectors']) {
    const value = body[field]
    if (Array.isArray(value)) {
      for (const entry of value) {
        out.push(typeof entry === 'string' ? entry : JSON.stringify(entry))
      }
    }
  }
  return out
}

/**
 * Run one scheduled job. Throws if it could not be run at all.
 *
 * The throw is the point. A Cloud Function that returns null on a failure is a
 * Cloud Scheduler job that reads "succeeded" forever, and the whole reason this
 * section exists is that unattended things fail quietly. Throwing marks the
 * execution failed, and Scheduler's own retry then gets a free attempt at a
 * transient problem — safely, because every one of these endpoints is
 * idempotent for its period.
 *
 * A *partial* failure — a report section that could not be computed, an
 * audience that resolved to nobody — is not a throw. The job ran, the backend
 * recorded it as `degraded` with the reason, and the daily exception report
 * carries it to a person. Retrying it would send the same incomplete report
 * again.
 */
async function runScheduledJob(job: string, path: string): Promise<JobOutcome> {
  const { config, problem } = readServiceConfig(REPORTING_KEY_ENV, 'report')

  if (!config) {
    // Named, not "misconfigured". Whoever reads this at 07:05 on a Monday
    // should not have to go looking for which variable.
    const message =
      `${job} DID NOT RUN. ${problem} Nothing was sent and no report was ` +
      `generated. See DEPLOYMENT.md § 9.`
    functions.logger.error(message)
    throw new Error(message)
  }

  const result = await callJobApi(config, path)

  if (!result.ok) {
    const reason = result.error || apiMessage(result.body) ||
      `HTTP ${result.status ?? 'unknown'}`
    const credentialRejected = result.status === 401
    const message = withoutKey(
      `${job} FAILED: ${reason}.` +
      (credentialRejected
        ? ` The API did not recognise the credential. ${REPORTING_KEY_ENV} on ` +
          'this function and SERVICE_KEY_REPORTING on the backend are not the ' +
          'same value. Rotating one side alone is what causes this — see ' +
          'DEPLOYMENT.md § 9.8.'
        : '') +
      (result.status === 403
        ? ' The credential is valid and is not permitted to do this. Its ' +
          'allowlist is in backend/app/core/security.py → REPORTING.'
        : ''),
      config.key,
    )
    functions.logger.error(message)
    throw new Error(message)
  }

  const body = result.body || {}
  const verdict = typeof body.status === 'string' ? body.status : 'unknown'
  const accepted = numberOr(body.emails_accepted, null)
  const problems = problemsOf(body).map((p) => withoutKey(p, config.key))

  const outcome: JobOutcome = {
    ran: true,
    status: result.status,
    verdict,
    emailsAccepted: accepted,
    problems,
    detail: '',
  }

  if (body.recorded === false) {
    // The job did its work and the run log did not record it. Worth an error:
    // `/notifications/runs/last` will not show this run at all.
    functions.logger.error(
      `${job} ran and could NOT be written to the run log. ` +
      `${String(body.record_error || '')}`
    )
  }

  if (problems.length > 0) {
    outcome.detail =
      `${job} ran and was incomplete (${verdict}): ${problems.join(' | ')}`
    // A warning, not an error: the run happened, what it could send it sent,
    // and the backend has recorded the gaps. Retrying would resend the same
    // incomplete report.
    functions.logger.warn(outcome.detail)
  } else {
    outcome.detail =
      `${job} ran (${verdict}); ${accepted ?? 0} email(s) accepted by the provider.`
    functions.logger.info(outcome.detail)
  }
  return outcome
}

/** Shared deployment settings. The secret declaration is what puts it in env. */
const scheduledJob = functions.runWith({
  secrets: [REPORTING_KEY_ENV],
  timeoutSeconds: JOB_TIMEOUT_SECONDS,
  memory: '512MB',
})

// ── 8A.2 — every transactional email a record says is owed ───────────────────
//
// Every 15 minutes, all day. Frequent on purpose: a partner learning they were
// rejected, or that their payout has been paid, should not wait for a nightly
// batch. Costs nothing to run often — the sweep sends only what the delivery
// log says has not gone out, and `email_deliveries.dedupe_key` is unique.
export const scheduledTransactionalSweep = scheduledJob
  .pubsub
  .schedule('*/15 * * * *')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob(
      'transactional-sweep',
      '/api/notifications/jobs/transactional-sweep',
    )
    return null
  })

// ── 8A.4 — the nine exception detectors ──────────────────────────────────────
//
// Every 30 minutes. Safe to run this often because suppression is on the
// *condition*, not on the scan: `alert_state` holds one row per condition and
// refuses a second email inside the repeat window (ALERT_REPEAT_HOURS, 24h by
// default). A condition that gets worse — a third card on a duplicate payment
// reference, a debt that grows — has a different fingerprint and re-alerts
// immediately rather than waiting the window out.
export const scheduledAlertScan = scheduledJob
  .pubsub
  .schedule('*/30 * * * *')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob('alerts', '/api/notifications/jobs/alerts')
    return null
  })

// ── 8A.3.1 / 8A.3.2 / 8A.3.3 — the daily reports ─────────────────────────────
//
// 07:00 IST. The day it reports on ended at midnight IST, seven hours earlier,
// and is whole — the backend cuts "yesterday" in Asia/Kolkata, not in UTC.
// ── Nightly reconciliation: does the app's economy agree with the books? ─────
//
// 03:00 IST — after the IST day has closed and well before the 07:00 reports,
// so a disagreement is known before anyone reads a number derived from it.
//
// The app's money is written by Cloud Functions into Firestore; the business
// ledger lives in Mongo. Nothing compared them, so they could drift for weeks
// before a month-end figure looked wrong and nobody could say when it started.
// This corrects nothing — it alerts, because the difference is the evidence.
export const scheduledReconciliation = scheduledJob
  .pubsub
  .schedule('0 3 * * *')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob('reconcile', '/api/notifications/jobs/reconcile')
    return null
  })

export const scheduledDailyReports = scheduledJob
  .pubsub
  .schedule('0 7 * * *')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob('daily', '/api/notifications/jobs/daily')
    return null
  })

// ── The owner's weekly business report ───────────────────────────────────────
//
// 07:30 IST on Monday, and Monday rather than Sunday evening on purpose. An ISO
// week ends at 00:00 UTC on Monday, which is 05:30 IST; a Sunday-evening run
// would be inside the week it was trying to report on, so the backend's
// `last_closed_iso_week` would correctly hand it *the week before that* and the
// owner would read a report a week out of date. Firing ninety minutes after the
// week closes gets the week that just finished.
//
// Not the same report as `weeklyPayoutReportGenerator` in section 1, which
// writes the Firestore payout report and accrues commission with the other
// credential. This one is the P&L, hosts, agencies, recharges, credit and
// leaderboards, stored in Mongo and emailed.
export const scheduledWeeklyBusinessReport = scheduledJob
  .pubsub
  .schedule('30 7 * * 1')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob(
      'weekly-business',
      '/api/reports/jobs/weekly-business',
    )
    return null
  })

// ── 8A.3.6 / 8A.3.7 — each agency's and each seller's weekly statement ───────
//
// 09:00 IST on Monday, ninety minutes after the business report, so the owners
// have seen the week before the partners are written to about it.
//
// `period=last-week` is a name, not a date range. The backend resolves it
// through the same call that decides which days agency commission is billed
// over, so a statement and the commission on it cannot cover different days.
// This function does no calendar arithmetic at all, which is the point.
export const scheduledPartnerStatements = scheduledJob
  .pubsub
  .schedule('0 9 * * 1')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob(
      'partner-statements',
      '/api/notifications/jobs/partner-statements?cadence=weekly&period=last-week',
    )
    return null
  })

// ── 8A.3.9 – 8A.3.12 — the monthly pack ──────────────────────────────────────
//
// 08:00 IST on the 1st. The month is a calendar month cut at midnight IST, so
// "August" is 1 August 00:00 IST to 1 September 00:00 IST. Also sends every
// partner their formal monthly statement, which is a different email from
// Monday's weekly one — different cadence, different period, different dedupe
// key — and is the record their accountant files.
export const scheduledMonthlyReports = scheduledJob
  .pubsub
  .schedule('0 8 1 * *')
  .timeZone(BUSINESS_TIMEZONE)
  .onRun(async (_context) => {
    await runScheduledJob('monthly', '/api/notifications/jobs/monthly')
    return null
  })

// ─────────────────────────────────────────────────────────────────────────────
// 13. PARTNER REGISTRATION — put a new agency or coin seller in the queue
//     Triggers on: new document in agencies/ or sellers/
//     Requires: ZIPPER_PARTNER_REGISTRATION_KEY, ZIPPER_API_BASE_URL
// ─────────────────────────────────────────────────────────────────────────────
//
//     THE BUG THIS FIXES. Every creation path in the CRM — /agency-signup,
//     /seller-signup, /agencies/register, /sellers/register and the sub-agency
//     modal on /agency-dashboard — wrote a Firestore document and stopped. The
//     staff queues on /kyc, /agencies and /sellers are built from
//     `partnerOps.list`, which reads Mongo's `partners` collection, and nothing
//     in the browser ever called `POST /partner-ops/partners`. So an applicant
//     existed in Firestore, held a pending CRM login, saw the holding page,
//     received "we have your application" — and appeared on NO STAFF SCREEN.
//     The only way to approve them was `python -m scripts.backfill_partners`.
//
//     WHY IT HAS TO BE HERE AND NOT IN THE BROWSER. The applicant cannot call
//     the API as themselves. `backend/app/core/security.py::sign_in_with_firebase`
//     resolves a role from the Mongo `staff` collection and no agency or seller
//     is ever written into it, so an external partner gets no API session at
//     all — there is nobody at the keyboard with the authority to create the
//     record. An unattended credential is the only thing that can.
//
//     WHAT IT CREATES. Nothing. `ensure_partner_record` opens every partner at
//     zero coins, zero credit, zero commission, zero cash, status `pending`,
//     inactive — and refuses any id that does not name a real Firestore
//     document. Approval stays exactly where it was: a person, on /kyc or
//     /agencies or /sellers, with a mandatory reason. This function moves no
//     money and decides nothing.
//
//     THE CREDENTIAL. A third one (`PARTNER_REGISTRATION`), its own key, and an
//     allowlist of exactly one operation: `partner.register`. It is NOT the
//     accrual key and NOT the reporting key, because this trigger fires on
//     every public signup — the widest-exposure machine path in the system —
//     and must not carry the ability to create a commission liability or to
//     email a business-wide figure. See `app/core/security.py`.
//
//     WHEN IT FAILS. The outcome is written onto the Firestore document, always,
//     before anything else. A partner whose registration failed is worse than
//     one who never applied, because everyone involved believes it worked; so
//     `partnerRecordFailed: true` goes on the document, the CRM's registration
//     banner reads it, and a team admin can retry from the screen. The function
//     then throws, which marks the execution failed in Cloud Logging rather
//     than reporting a lost applicant as a success.

/**
 * The partner-registration credential, from Google Secret Manager via
 * `runWith({ secrets })`. Never a literal in this file, never in
 * `functions/.env`, never logged.
 *
 * Deliberately a different variable and a different secret from both
 * `ZIPPER_ACCRUAL_KEY` and `ZIPPER_REPORTING_KEY`. All three hold different
 * values; see DEPLOYMENT.md § 10.
 */
const PARTNER_REGISTRATION_KEY_ENV = 'ZIPPER_PARTNER_REGISTRATION_KEY'

/** backend/app/routers/partner_ops.py → `POST /partner-ops/partners`. */
const PARTNER_REGISTER_PATH = '/api/partner-ops/partners'

/** `reason` on `NewPartner` is `max_length=1000`. Trimmed, never truncated mid-send. */
const MAX_REASON_CHARS = 1000

/**
 * `source: 'second_role'` — an approved partner applying for the capability they
 * do not have — is NOT registered here, and this is load-bearing.
 *
 * That application is bridged into the queue by staff through
 * `POST /partner-ops/partners/{held}/second-role`, which calls
 * `ensure_partner_record` itself and then stamps `second_role_of` on the new
 * record. If this trigger got there first, the record would already exist
 * WITHOUT `second_role_of`, and `request_second_role` refuses exactly that case
 * ("already exists as a … in its own right"). Registering it here would
 * therefore break the second-capability flow permanently for that applicant,
 * and leave the record unlinked from the login it belongs to.
 *
 * See zipper-crm/components/SecondRoleApplications.tsx and
 * zipper-crm/lib/partnerRoles.ts, which write this value.
 */
const SOURCE_NOT_REGISTERED_HERE = 'second_role'

/**
 * FX-06: `source: 'self_app'` — an application the API wrote and registered
 * itself (backend `submit_partner_application`). See `onPartnerDocumentCreated`.
 * Decision 16 (RC): `reapply` — a fresh Sub-agency application after a
 * rejection, written and registered by the API itself
 * (`partner_applications.reapply_sub_agency`) for the same reason.
 */
const SOURCE_REGISTERED_BY_THE_API = 'self_app'
const SOURCES_REGISTERED_BY_THE_API: ReadonlySet<string> = new Set([SOURCE_REGISTERED_BY_THE_API, 'reapply'])

type PartnerCollection = 'agencies' | 'sellers'

/** What the applicant is called, for the audit reason. Never a figure. */
function partnerDisplayName(
  collection: PartnerCollection,
  data: FirebaseFirestore.DocumentData,
): string {
  const keys = collection === 'sellers'
    ? ['displayName', 'name', 'ownerName']
    : ['agencyName', 'name', 'ownerName']
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The mandatory reason on the audit entry.
 *
 * `audit.record` and `NewPartner` both refuse a blank one, and a creation with
 * no stated reason is not auditable (spec 6.1.4). It says which screen the
 * applicant came through, because that is the one thing a reviewer reading the
 * log later cannot reconstruct.
 */
function registrationReason(
  collection: PartnerCollection,
  data: FirebaseFirestore.DocumentData,
): string {
  const label = collection === 'sellers' ? 'coin seller' : 'agency'
  const name = partnerDisplayName(collection, data)
  const source = typeof data.source === 'string' && data.source ? data.source : 'unknown'
  const reason =
    `Registered in the CRM — a new ${label}${name ? ` (${name})` : ''} was ` +
    `created in Firestore via '${source}'. Creating the business record so the ` +
    'application appears in the approval queue. Created holding nothing and pending.'
  return reason.slice(0, MAX_REASON_CHARS)
}

/**
 * Register one partner with the API, and record the outcome on its document.
 *
 * Never returns quietly on a failure: it either records success or records the
 * failure and throws. Returns the message to throw with, or '' on success —
 * the throw itself is left to the caller so the trigger reads as one thing.
 */
async function registerPartnerRecord(
  collection: PartnerCollection,
  partnerId: string,
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
): Promise<string> {
  const { config, problem } = readServiceConfig(
    PARTNER_REGISTRATION_KEY_ENV,
    'register a partner',
  )

  /**
   * One place that writes the outcome, so no path can forget to.
   *
   * FX-06: an UPDATE, never a merge-set. A merge-set on a document that was
   * deleted meanwhile — the API refuses an app application and deletes its
   * own document while this trigger is still in flight — re-created it as a
   * stub, which fired this trigger again and became a nameless, ownerless
   * partner record (DUP-02). `update` fails on a missing document instead,
   * and a missing document has no outcome to record.
   */
  const record = async (fields: Record<string, unknown>): Promise<void> => {
    try {
      await ref.update({
        partnerRecord: {
          ...fields,
          at: admin.firestore.FieldValue.serverTimestamp(),
        },
        // Top level and boolean so the CRM can find these with a single
        // equality filter and no composite index. This is what puts a failed
        // registration in front of staff.
        partnerRecordFailed: fields.status === 'failed',
      })
    } catch (err) {
      const missing = (await ref.get().catch(() => null))?.exists === false
      if (missing) {
        // Deleted since it was created — by the API refusing the application
        // that wrote it. Nothing to record on, and nothing is re-created.
        functions.logger.warn(
          `${collection}/${partnerId} no longer exists; the registration ` +
          `outcome (${String(fields.status || '')}) was not recorded and the ` +
          'document was not re-created.',
        )
        return
      }
      // Now the failure is invisible on the document too. Loud, and nothing
      // else to be done from here.
      functions.logger.error(
        `Could not record the partner-registration outcome on ` +
        `${collection}/${partnerId}:`,
        err,
      )
    }
  }

  if (!config) {
    const message =
      `${collection}/${partnerId} WAS NOT REGISTERED with the API. ${problem} ` +
      'The applicant exists in Firestore and appears on no staff screen, so ' +
      'nobody can approve them. See DEPLOYMENT.md § 10. Once it is configured, ' +
      'either retry from the CRM or run: python -m scripts.backfill_partners --confirm'
    functions.logger.error(message)
    await record({ status: 'failed', error: message, httpStatus: null })
    return message
  }

  const result = await callApi(
    config,
    'POST',
    PARTNER_REGISTER_PATH,
    {
      partner_id: partnerId,
      // `kind` is a CHECK on the API, never a setting — the partner's own
      // document decides, and a disagreement is refused. It is sent for a
      // seller because that pins the lookup to the `sellers` collection, and
      // NOT for an agency because only the document can say whether it is a
      // main agency or a sub-agency, and asserting either would be refused for
      // half of them.
      ...(collection === 'sellers' ? { kind: 'seller' } : {}),
      reason: registrationReason(collection, data),
    },
  )

  if (!result.ok) {
    const reason = result.error || apiMessage(result.body) ||
      `HTTP ${result.status ?? 'unknown'}`
    const message = withoutKey(
      `${collection}/${partnerId} WAS NOT REGISTERED with the API: ${reason}. ` +
      'The applicant is in Firestore and on no staff screen.' +
      (result.status === 401
        ? ` The API did not recognise the credential. ` +
          `${PARTNER_REGISTRATION_KEY_ENV} on this function and ` +
          'SERVICE_KEY_PARTNER_REGISTRATION on the backend are not the same ' +
          'value. Rotating one side alone is what causes this — DEPLOYMENT.md § 10.6.'
        : '') +
      (result.status === 403
        ? ' The credential is valid and is not permitted to do this. Its ' +
          'allowlist is in backend/app/core/security.py → PARTNER_REGISTRATION.'
        : ''),
      config.key,
    )
    functions.logger.error(message)
    await record({
      status: 'failed',
      error: message,
      httpStatus: result.status ?? null,
    })
    return message
  }

  const body = result.body || {}
  // `created: false` is SUCCESS, not a failure. It means the record was already
  // there — a re-delivered trigger, a retry from the CRM, or a row
  // `scripts/backfill_partners.py` created while this section did not exist.
  // Nothing about the existing record is touched, and no balance is reset.
  const created = body.created === true
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.map((w) => String(w))
    : []

  await record({
    status: 'registered',
    created,
    partnerId: typeof body.id === 'string' ? body.id : partnerId,
    kind: typeof body.kind === 'string' ? body.kind : '',
    // Said out loud on the document: this record holds nothing and is pending.
    partnerStatus: typeof body.status === 'string' ? body.status : '',
    warnings,
    error: '',
    httpStatus: result.status ?? null,
  })

  functions.logger.info(
    `${collection}/${partnerId} ${created ? 'registered' : 'was already registered'} ` +
    `with the API (${String(body.kind || 'partner')}, ${String(body.status || 'pending')})` +
    (warnings.length > 0 ? ` — ${warnings.join(' | ')}` : ''),
  )
  return ''
}

/**
 * Shared deployment settings for the two triggers below. Declaring the secret
 * here is what puts it in `process.env` at runtime and nowhere else.
 *
 * Firestore triggers must be in the database's region — see `asiaFirestore` at
 * the top of this file — so the region is set the same way rather than reusing
 * that helper, which carries no `runWith`.
 */
const partnerRegistrationTrigger = functions
  .region('asia-south1')
  .runWith({
    secrets: [PARTNER_REGISTRATION_KEY_ENV],
    // One HTTP call, bounded by REGISTER_TIMEOUT_MS, plus one Firestore write.
    timeoutSeconds: 60,
    memory: '256MB',
  })
  .firestore

/**
 * Decide whether this document should be registered, then do it.
 *
 * Shared by both collections because the only thing that differs is which
 * collection the id lives in. One body means neither path can pick up a
 * behaviour — a redaction, a recorded failure — that the other does not have.
 */
async function onPartnerDocumentCreated(
  collection: PartnerCollection,
  partnerId: string,
  snap: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<null> {
  const data = snap.data() || {}

  if (String(data.source || '') === SOURCE_NOT_REGISTERED_HERE) {
    functions.logger.info(
      `${collection}/${partnerId} is a second-capability application; staff ` +
      'bridge it with POST /partner-ops/partners/{held}/second-role, which ' +
      'creates the record and links it. Not registering it here.',
    )
    return null
  }
  // FX-06: an application filed from the app is written by the API itself
  // (`submit_partner_application`), which registers it in the same call and
  // deletes the document again if it refuses. Registering it here as well
  // only raced that delete (DUP-02). Only the Admin SDK writes this value:
  // `firestore.rules` pins every client create arm to another source.
  if (SOURCES_REGISTERED_BY_THE_API.has(String(data.source || ''))) {
    functions.logger.info(
      `${collection}/${partnerId} was written by the API (source '${String(data.source)}'), ` +
      'which registered it when it wrote it. Not registering it again here.',
    )
    return null
  }

  const failure = await registerPartnerRecord(collection, partnerId, snap.ref, data)
  if (failure) {
    // Recorded on the document first, and thrown second. Returning null here
    // would report a lost applicant as a healthy invocation, which is the exact
    // class of silent failure this whole section exists to end.
    throw new Error(failure)
  }
  return null
}

/**
 * Every new agency: /agency-signup, /agencies/register (superadmin), the
 * sub-agency modal on /agency-dashboard, and the `create_agency` approval
 * request that `onApprovalApproved` applies with `ref.set(...)` for
 * non-superadmin staff — that set is a create, so it lands here too.
 */
export const registerAgencyPartner = partnerRegistrationTrigger
  .document('agencies/{agencyId}')
  .onCreate(async (snap, context) =>
    onPartnerDocumentCreated('agencies', context.params.agencyId, snap),
  )

/**
 * Every new coin seller: /seller-signup, /sellers/register (superadmin), and the
 * `create_seller` approval request applied by `onApprovalApproved`.
 */
export const registerSellerPartner = partnerRegistrationTrigger
  .document('sellers/{sellerId}')
  .onCreate(async (snap, context) =>
    onPartnerDocumentCreated('sellers', context.params.sellerId, snap),
  )

// ═════════════════════════════════════════════════════════════════════════════
// 13b. APPLYING FOR A PARTNER ROLE FROM THE APP, AND FILING A RECHARGE
// ═════════════════════════════════════════════════════════════════════════════
//
// The Android app has no session with the API and the API has no Firebase
// ID-token dependency, so these callables are the bridge: each verifies the
// caller's Firebase auth, forwards `context.auth.uid` as the applicant, and
// presents the partner-registration service key. They decide NOTHING. Every
// rule — what this person may apply for, which agencies exist and accept,
// whether a parent is a main agency, one agency-family record per human, the
// seller a recharge names — is applied by the API against its own records
// (`backend/app/services/partner_applications.py`, `recharges.py`).
//
// The uid is never taken from `data`. A client that sends `applicant_uid` in
// the payload is ignored; the one on the token is used.
//
// Same key as registration, deliberately (`Op.PARTNER_APPLY`,
// `Op.RECHARGE_REQUEST` in backend/app/core/security.py): one more secret
// would be one more production configuration step, and the blast radius is
// identical — pending records that hold nothing.

const partnerApplicationCallable = functions
  .region('asia-south1')
  .runWith({ secrets: [PARTNER_REGISTRATION_KEY_ENV], timeoutSeconds: 60, memory: '256MB' })
  .https

/**
 * RF-30: the `details.code` of a write whose outcome is not known — the API
 * did not answer in time, or failed after the request reached it. The app
 * re-reads what it filed (or replays the same request id) instead of telling
 * the person it failed.
 */
const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'

const OUTCOME_UNKNOWN_MESSAGE =
  'Zipper did not answer in time, so we cannot tell whether this went through. ' +
  'Check before you try again.'

/**
 * Map an API refusal onto the HttpsError the app's `MoneyFunctions` wrapper reads.
 *
 * RF-30: [write] is true for a POST. A write that timed out, could not be
 * delivered, or met a 5xx may still have been carried out, so it is reported
 * as `deadline-exceeded` with `details.code = OUTCOME_UNKNOWN` — never as
 * "could not be reached", which told a person whose application WAS filed
 * that it was not. A read keeps `unavailable`: it is safe to repeat.
 */
function apiRefusalToHttpsError(
  result: ApiResult,
  fallback: string,
  write = false,
): functions.https.HttpsError {
  const message = apiMessage(result.body) || result.error || fallback
  if (write && (result.status === null || result.timedOut === true || result.status >= 500)) {
    functions.logger.warn(`Partner bridge write outcome unknown: ${result.error || `HTTP ${result.status}`}`)
    return new functions.https.HttpsError('deadline-exceeded', OUTCOME_UNKNOWN_MESSAGE, { code: OUTCOME_UNKNOWN })
  }
  if (result.status === 409) {
    // RF-30: a conflict the API explains ("already filed …") is the API's
    // sentence, not "could not be reached".
    return new functions.https.HttpsError('failed-precondition', message)
  }
  if (result.status === 422) {
    // The request's shape was refused before any rule ran. FastAPI's detail is
    // a list of field errors, not a sentence for a person.
    return new functions.https.HttpsError('invalid-argument', 'Some details were not accepted. Check the form and try again.')
  }
  if (result.status === 400 || result.status === 404) {
    // Approved contact rule: a refusal that carries a machine-readable code
    // (`CONTACT_REQUIRED`) is forwarded in `details`, so the app can route to
    // phone / email verification instead of showing a dead-end sentence.
    const details = apiRefusalDetails(result.body)
    return details
      ? new functions.https.HttpsError('failed-precondition', message, details)
      : new functions.https.HttpsError('failed-precondition', message)
  }
  if (result.status === 401 || result.status === 403) {
    functions.logger.error(`Partner application credential refused by the API: ${message}`)
    return new functions.https.HttpsError('internal', 'Applications are temporarily unavailable. Please try again later.')
  }
  return new functions.https.HttpsError('unavailable', 'Zipper could not be reached. Please try again.')
}

async function viaApi(
  method: 'GET' | 'POST',
  path: string,
  payload: Record<string, unknown> | undefined,
  fallback: string,
): Promise<Record<string, unknown>> {
  const { config, problem } = readServiceConfig(PARTNER_REGISTRATION_KEY_ENV, 'file an application')
  if (!config) {
    functions.logger.error(`Partner application callable is not configured: ${problem}`)
    throw new functions.https.HttpsError('internal', 'Applications are temporarily unavailable. Please try again later.')
  }
  const result = await callApi(config, method, path, payload)
  if (!result.ok) throw apiRefusalToHttpsError(result, fallback, method === 'POST')
  return result.body ?? {}
}

function requireUid(context: functions.https.CallableContext): string {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in to continue.')
  return uid
}

/** What the signed-in user may apply for, from the API's authoritative records. */
export const partnerEligibility = partnerApplicationCallable.onCall(async (_data, context) => {
  const uid = requireUid(context)
  return viaApi('GET', `/api/partner-ops/applications/eligibility/${encodeURIComponent(uid)}`,
    undefined, 'Could not read your eligibility.')
})

// C2 (B05): a reinstatement request for a REVOKED role — the only way back
// from a revocation, decided by an Owner. The same bridge as the applications:
// the uid is the token's and never `data`'s, and the API decides everything —
// whether this person holds a revoked record of that kind, whether the account
// is restricted, and whether one is already open (then it is returned, not
// duplicated). Only the shape of the input is checked here.
const ROLE_APPEAL_KINDS = ['host', 'agency', 'sub_agency', 'seller']
const ROLE_APPEAL_MIN_CHARS = 20
const ROLE_APPEAL_MAX_CHARS = 2000

/** Ask for a revoked role back. Pending; restores nothing. */
export const submitRoleAppeal = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  const kind = String(data?.kind ?? '').trim()
  if (!ROLE_APPEAL_KINDS.includes(kind)) {
    throw new functions.https.HttpsError('invalid-argument', 'Choose the revoked role this request is about.')
  }
  const statement = String(data?.statement ?? '').trim()
  if (statement.length < ROLE_APPEAL_MIN_CHARS || statement.length > ROLE_APPEAL_MAX_CHARS) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Say why the role should be reinstated, in ${ROLE_APPEAL_MIN_CHARS} to ${ROLE_APPEAL_MAX_CHARS} characters.`,
    )
  }
  return viaApi('POST', '/api/partner-ops/role-appeals', {
    uid,                      // from the token, never from `data`
    kind,
    statement,
  }, 'Your request could not be filed.')
})

/** The signed-in user's own reinstatement requests, newest first. */
export const myRoleAppeals = partnerApplicationCallable.onCall(async (_data, context) => {
  const uid = requireUid(context)
  const body = await viaApi('GET', `/api/partner-ops/role-appeals/of/${encodeURIComponent(uid)}`,
    undefined, 'Could not load your requests.')
  const appeals = (body as { appeals?: unknown }).appeals
  return { appeals: Array.isArray(appeals) ? appeals : (Array.isArray(body) ? body : []) }
})

/** Agencies a sub-agency (main only) or a host (main and sub) may join. */
export const partnerParents = partnerApplicationCallable.onCall(async (data, context) => {
  requireUid(context)
  const forKind = String(data?.forKind ?? 'sub_agency') === 'host' ? 'host' : 'sub_agency'
  const body = await viaApi('GET', `/api/partner-ops/applications/parents?for_kind=${forKind}`,
    undefined, 'Could not load agencies.')
  return { parents: Array.isArray(body) ? body : (body as { parents?: unknown }).parents ?? body }
})

/** The signed-in user's own partner applications and their status. */
export const myPartnerApplications = partnerApplicationCallable.onCall(async (_data, context) => {
  const uid = requireUid(context)
  const body = await viaApi('GET', `/api/partner-ops/applications/of/${encodeURIComponent(uid)}`,
    undefined, 'Could not load your applications.')
  return { applications: Array.isArray(body) ? body : [] }
})

/** Apply as Agency, Sub-agency or Coin Seller. Pending; approves nothing. */
export const submitPartnerApplication = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  await assertActiveSession(uid, data, 'submitPartnerApplication', context.auth?.token)   // Phase 1A (SESSION-001/003)
  const kind = String(data?.kind ?? '')
  if (!['agency', 'sub_agency', 'seller'].includes(kind)) {
    throw new functions.https.HttpsError('invalid-argument', 'Choose Agency, Sub-agency or Coin Seller.')
  }
  const form = (data?.form && typeof data.form === 'object') ? data.form as Record<string, unknown> : {}
  const parentId = data?.parentId ? String(data.parentId) : null
  return viaApi('POST', '/api/partner-ops/applications', {
    applicant_uid: uid,       // from the token, never from `data`
    kind,
    form,
    parent_id: parentId,
  }, 'Your application could not be filed.')
})

/** Apply as Host under a chosen agency or sub-agency. Pending; unverified on approval. */
export const submitHostApplication = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  await assertActiveSession(uid, data, 'submitHostApplication', context.auth?.token)   // Phase 1A (SESSION-001/003)
  const parentId = String(data?.parentId ?? '')
  if (!parentId) throw new functions.https.HttpsError('invalid-argument', 'Choose the agency you want to join.')
  const form = (data?.form && typeof data.form === 'object') ? data.form as Record<string, unknown> : {}
  return viaApi('POST', '/api/partner-ops/applications/host', {
    applicant_uid: uid,
    form,
    parent_id: parentId,
  }, 'Your host application could not be filed.')
})

// ── Decision 15 (RC): an approved role waits for BOTH verified contacts ─────
//
// The Owner may approve a partner whose account does not yet hold both a
// verified phone and a verified email; the role then WAITS and starts only
// once both are verified. These three are the app's side of that, on the same
// bridge and with the same discipline as above: the uid is the token's, never
// `data`'s, and the API decides everything — it re-reads the verification
// from Firebase Auth and its own ledger and re-checks the role table, the
// restriction and the parent before it starts anything.

/** What is verified on the caller's account, and which approved roles wait for it. */
export const partnerVerificationState = partnerApplicationCallable.onCall(async (_data, context) => {
  const uid = requireUid(context)
  return viaApi('GET', `/api/partner-ops/applications/verification/${encodeURIComponent(uid)}`,
    undefined, 'Could not read your verification.')
})

/** Re-check the caller's contacts and start every approved role they now allow. */
export const checkPartnerActivation = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  await assertActiveSession(uid, data, 'checkPartnerActivation', context.auth?.token)
  return viaApi('POST', '/api/partner-ops/applications/verification/check', {
    applicant_uid: uid,       // from the token, never from `data`
  }, 'Could not check your verification.')
})

/**
 * The phone or email the caller tried to verify belongs to ANOTHER Zipper
 * account. Nothing is merged (open decision D3); the API audits it and alerts
 * staff. The answer is the same whether or not a holder exists.
 */
export const reportContactConflict = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  const raw = String(data?.contact ?? '')
  const contact = raw === 'phone' || raw === 'email' ? raw : ''
  if (!contact) throw new functions.https.HttpsError('invalid-argument', 'Say whether this is a phone or an email.')
  const value = String(data?.value ?? '').trim()
  if (value.length < 3 || value.length > 320) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter the phone number or email address.')
  }
  await viaApi('POST', '/api/partner-ops/applications/verification/conflict', {
    applicant_uid: uid,       // from the token, never from `data`
    contact,
    value,
  }, 'Could not report this.')
  return { received: true }
})

/** A buyer says they paid a Coin Seller. Pending; staff verify before any credit. */
export const submitRechargeRequest = partnerApplicationCallable.onCall(async (data, context) => {
  const uid = requireUid(context)
  await assertActiveSession(uid, data, 'submitRechargeRequest', context.auth?.token)   // Phase 1A (SESSION-001/003)
  const diamonds = Number(data?.diamonds ?? 0)
  const amountMinor = Number(data?.amountMinor ?? 0)
  if (!Number.isInteger(diamonds) || diamonds <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Say how many diamonds you are buying.')
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Say how much you paid.')
  }
  // RF-30: one id per recharge form, the same on every retry of it. The API
  // answers a repeat with the request it already filed for THIS buyer, so an
  // answer lost to a timeout can be asked for again without filing twice.
  // Older apps send none and keep the old behaviour.
  const requestId = String(data?.requestId ?? '').trim()
  if (requestId && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw new functions.https.HttpsError('invalid-argument', 'This request could not be read. Update the app and try again.')
  }
  return viaApi('POST', '/api/partner-ops/recharges', {
    buyer_uid: uid,           // from the token
    seller_id: String(data?.sellerId ?? ''),
    diamonds,
    amount_minor: amountMinor,
    currency: String(data?.currency ?? 'INR'),
    payment_method: String(data?.paymentMethod ?? ''),
    reference: String(data?.reference ?? ''),
    proof_url: String(data?.proofUrl ?? ''),
    ...(requestId ? { client_request_id: requestId } : {}),
  }, 'Your recharge request could not be filed.')
})

// ── Gift settlement ───────────────────────────────────────────────────────────
// Lives in its own module: index.ts is already 3,800 lines, and money movement
// should be readable without scrolling past every email template.
export { settleGift } from './gifts'

/**
 * Party rooms — seats, and the contention around them.
 *
 * Taking a seat is a callable rather than a client write because a seat is both
 * a contended resource and a publisher slot on an Agora channel. `seats/{index}`
 * as one document per seat turns two people racing for the same empty seat into
 * one winner and one refusal; `generateAgoraToken` reading those documents is
 * what stops a listener publishing into a room they were never seated in.
 */
export {
  createPartyRoom, updatePartyRoom,
  joinPartyRoom, leavePartyRoom,
  takePartySeat, leavePartySeat,
  requestPartySeat, cancelPartySeatRequest, decidePartySeatRequest,
  invitePartySeat, respondPartySeatInvite,
  setPartySeatMute, setPartySeatLock, setPartyAdmin,
  endPartyRoom, sweepEmptyPartyRooms,
} from './party'

// ── Call billing ──────────────────────────────────────────────────────────────
// Server-clocked. The caller's device no longer decides what it owes.
export { startCall, acceptCall, declineCall, tickCall, endCall, sweepStaleCalls } from './calls'

// ── Accounts ──────────────────────────────────────────────────────────────────
// Deleting an account is a thirty-day pause, not a cliff: recoverable until
// the grace period runs out, and only then actually destroyed. The ledger and
// the audit log survive a purge — they are the business's record that money
// moved, not the person's data to delete.
export { recoverAccount, purgeMyAccountNow, purgeDeletedAccounts, requestAccountDeletion } from './accounts'

// ── Wallet ────────────────────────────────────────────────────────────────────
// Bean conversion, daily rewards, cosmetic purchases and expiry.
export { convertBeans, claimDailyReward, purchaseBagItem, equipBagItem, expireCosmetics } from './wallet'

// ── Quick login ───────────────────────────────────────────────────────────────
// Device-bound, rotating, state-aware. The decisions are in `quickLoginPolicy`,
// which imports nothing and is tested directly; `quickLogin` is the plumbing.
//
// `quickLoginChallenge` is new and is what makes the binding checkable: the
// client signs a server-issued nonce with a key held in the Android Keystore,
// so possession of the secret alone no longer authenticates anything.
//
// `submitAccountAppeal` is the A5 appeal path. It is here rather than in its own
// file because it authenticates the same way redemption does — a signature from
// the device's Keystore key over a server-issued challenge — and splitting the
// two would mean two copies of that verification, one of which would rot.
export {
  quickLoginChallenge, mintQuickLoginToken, redeemQuickLogin, revokeQuickLogin,
  submitAccountAppeal,
} from './quickLogin'

export {
  findExistingAccount, syncPhoneKey,
  bindVerifiedIdentity, resolveIdentity,
  // Google sign-in for an email a guest already bound → that same account.
  adoptEmailAccount,
  startMobileSession, endMobileSession,
  sweepQuickLoginTokens,
  // Destroys a quick-login secret the moment an account is banned, suspended
  // or deleted. Without it a ban was a refusal at redeem time and the secret
  // stayed live in Block Store, surviving uninstall and syncing to the next
  // phone — see the function's own note.
  revokeQuickLoginOnRestriction,
  // One device, one guest account — decided here rather than on the handset,
  // because the client asking itself "have I been a guest before?" answers no
  // whenever its own storage is unreadable, and mints a second account holding
  // none of the first one's balance.
  claimGuestIdentity,
} from './identity'

// UGP-C: binding an email by a six-digit code, in the app. Replaces the
// Firebase email link (and its App Link back into the app). Binds through the
// same `bindContactCore` rules as a phone number — see emailOtp.ts.
export { requestEmailBindCode, verifyEmailBindCode } from './emailOtp'
// Decision 15 (RC): a CRM partner login confirms its OWN address by code.
export { requestLoginEmailCode, verifyLoginEmailCode } from './emailOtp'

// ── Payout hold ───────────────────────────────────────────────────────────────
// Earnings release one week in arrears, so a chargeback lands while the money
// is still ours to withhold.
export { releaseBeansForWeek, getPayoutStatus } from './payouts'

/**
 * Host Home's figures and the level ladder.
 *
 * `hostLevel` was written as 0 at signup and never updated by anything, so
 * every host on the platform was stuck at the level-0 rate ceiling with no way
 * to move.
 */
export { getHostHome, sweepHostLevels } from './hostStats'

/**
 * Host activation and identity verification.
 *
 * `activateHost` replaces AuthRepository.activateHostApplication, which set
 * `isHost`, `agencyId` and `callRateBeans` from the client. It also writes the
 * `agencies/{id}/agencyHosts/{uid}` roster row, which nothing wrote before — so
 * every agency's host list, and the weekly payout report built on it, was empty.
 *
 * `setCallRate` takes over the other client write. The security rule it
 * replaces capped every host at the platform-wide 700, because a rule cannot
 * read the level ladder; this reads it, so a level-10 host can finally set the
 * 2,400 their level allows and nobody can set more than theirs.
 *
 * Verification matters beyond the badge: releaseBeansForWeek will not release a
 * week for a host whose `isVerifiedHost` is not true, and nothing else in the
 * product sets that flag.
 */
export {
  activateHost,
  setCallRate,
  checkReferralCode,
  submitHostCapture,
  onAgencyPhotoReplaced,
} from './hosts'

/**
 * RC (confirmed): withdrawing a pending invitation deletes its KYC uploads —
 * the photo and identity documents under the inviting agency's own prefixes,
 * unless something else still references them. See `invitationCleanup.ts`.
 */
export { onHostInvitationWithdrawn } from './invitationCleanup'

/**
 * Cross-user counters and role badges. Both were client writes onto ANOTHER
 * account's document, which required rules that could not tell a real like from
 * a self-awarded one.
 */
export { toggleLike, syncMyRoles } from './social'

/**
 * The public projection of a user, and the feed built on it.
 *
 * `users/{uid}` was readable by every signed-in account, and the Home feed read
 * twenty whole documents at a time — phone numbers, emails, dates of birth,
 * device ids and balances included.
 */
export { syncPublicProfile, syncLivePresence, backfillPublicProfiles } from './profiles'

// ── Push notifications ───────────────────────────────────────────────────────
// Ring the callee, notify chat recipients, tell followers a host went live.
// Data-only FCM messages; the app's messaging service renders them.
export { pushIncomingCall, pushCallStatus, pushChatMessage, pushLiveStarted } from './push'

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC SELLER DIRECTORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Keep `publicSellers/{id}` in step with `sellers/{id}`, and nothing else.
 *
 * ── WHY THIS IS A TRIGGER ──────────────────────────────────────────────────
 *
 * The public document has to be written by something the client cannot reach,
 * or the collection is only as private as the weakest screen that writes it.
 * A trigger runs with the Admin SDK and has no caller, so `publicSellers` can be
 * `allow write: if false` for everybody — there is no path to argue about.
 *
 * It also means every route into a seller record is covered by construction:
 * the signup form, the staff register page, `approve_partner`, `reject_partner`,
 * `deactivate_partner`, `reactivate_partner`, the seller's own `isOnline`
 * toggle and anything added later all end in a write to `sellers/{id}`, and all
 * of them land here. Publishing from the approval path alone would have missed
 * the other six.
 *
 * ── WHAT IT PUBLISHES ──────────────────────────────────────────────────────
 *
 * `toPublicSeller` copies an explicit allowlist — never the document. See
 * ./publicSeller for why that is an allowlist rather than a denylist, and
 * `test/publicSeller.test.js` for the assertion that keeps it one.
 *
 * Visibility follows the record: approved and active publishes, anything else
 * — pending, rejected, suspended, deleted — removes. Removal is a delete rather
 * than a flag, so a rejected seller is not merely hidden behind a query somebody
 * can forget to write.
 */
export const syncPublicSeller = asiaFirestore
  .document('sellers/{sellerId}')
  .onWrite(async (change, context) => {
    const sellerId = context.params.sellerId as string
    const before = change.before.exists ? change.before.data() : undefined
    const after = change.after.exists ? change.after.data() : undefined

    if (!publicViewChanged(before, after)) return null

    const ref = db.collection('publicSellers').doc(sellerId)

    if (!isPubliclyVisible(after)) {
      // Gone from the directory the moment they stop qualifying. A rejected or
      // suspended seller keeps their private record — that is the business
      // history — and loses the public one entirely.
      await ref.delete().catch(() => undefined)
      functions.logger.info('public seller withdrawn', { sellerId })
      return null
    }

    await ref.set(
      {
        ...toPublicSeller(sellerId, after as Record<string, unknown>),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      // `set` without merge, deliberately: the public document is a projection,
      // so it should be REPLACED by the current projection rather than
      // accumulate keys from older versions of this function.
    )
    functions.logger.info('public seller published', { sellerId })
    return null
  })

// ── STORAGE ROLE CLAIM — the partner half ────────────────────────────────────
//
// Mirrors an agency's or coin seller's role onto their Firebase token so
// `storage.rules` can authorise them. See `src/storageClaims.ts` for why only
// the partner half is provisioned here and why that is a security property
// rather than a limitation: partner `crmUsers` documents are written by the
// CLIENT, so a trigger that mirrored `role` verbatim would let a stranger
// write themselves an owner claim. `decideClaim` can only ever emit 'agency'
// or 'seller'.
//
// Internal claims (owner, observer, the twelve department roles) are set by
// the API from the Mongo `staff` row — see
// `backend/app/services/storage_claims.py`. This trigger refuses to touch a
// uid whose token already carries an API-owned role, so an ordinary
// `crmUsers` write for a member of staff (a phone-number edit, a
// `lastLoginAt` touch) cannot cost them their access.
//
// `onWrite` rather than `onCreate`: deactivation, reactivation and an agency
// transfer are all updates, and a deleted document must clear the claim.
//
// TOKEN PROPAGATION. A claim set here reaches the client on its next ID-token
// refresh — within the hour on Firebase's own schedule, or immediately if the
// client calls `getIdToken(true)`. The CRM forces exactly that after sign-in
// (`zipper-crm/lib/auth.ts`), so a partner never waits. Nothing is revoked
// here: withdrawing access clears the claim, and the stale token keeps working
// until it expires. Where that window is unacceptable the API also revokes
// refresh tokens on deactivation.
export const syncStorageRoleClaim = asiaFirestore
  .document('crmUsers/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid as string
    const after = (change.after.exists ? change.after.data() : null) as CrmUserDoc | null

    // The decision, the merge and the no-op skip all live in `syncClaim`, so
    // the behaviour this trigger has is the behaviour the tests drive. All
    // that is here is the adapter over the Admin SDK.
    const result = await syncClaim(uid, after, {
      getClaims: async (u) => (await admin.auth().getUser(u)).customClaims ?? {},
      setClaims: async (u, claims) => { await admin.auth().setCustomUserClaims(u, claims) },
    })

    functions.logger.info('storage claim', { uid, ...result })
    return null
  })
