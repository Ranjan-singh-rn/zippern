/**
 * Commission — **display only**. Nothing here decides what anyone is paid.
 *
 * The commission engine lives in the backend, in
 * `backend/app/services/commission.py`, and it is the only thing that produces
 * a payable figure. It reads the slab table from `appConfig/economy`, derives an
 * agency's billing for the period from the ledger, picks the band and credits
 * the accrual itself. `POST /partner-ops/agencies/{id}/commission-accruals` now
 * takes a **period**, not an amount; an amount sent with the request is checked
 * against the server's figure and the request is refused if they disagree.
 *
 * The rule, as the backend states it: an agency's total billing for the period
 * selects **one** band, and that band's rate applies to the **whole** amount.
 * It is not progressive. Below the lowest band's lower bound (₹25,001 for a
 * main agency, ₹26,001 for a sub-agency, in the live configuration) the agency
 * earns nothing — that floor is deliberate, and the hosts are still paid their
 * own payout in full. The top band has no cap.
 *
 * What used to be here was a progressive, tax-bracket calculation that ran in a
 * browser and was then typed into that endpoint. It was wrong twice over. It
 * ignored `slab.from` — using it only to derive a band width, then consuming
 * from rupee one — so the ₹25,001 floor did not exist in the arithmetic and
 * ₹10,000 of billing was "paid" ₹500. And it treated a band as uncapped only at
 * `to >= 999_999_999`, so above the live top band's ₹50,00,000 ceiling the
 * excess earned nothing and the effective rate *fell*. It has been deleted.
 *
 * Two things are left:
 *
 *   * `describeBreakdown` — formats a breakdown the API returned. It explains a
 *     server figure; it does not produce one.
 *   * `previewCommission` — a labelled **estimate**, for the Economy screen's
 *     interactive slab illustration. It applies the same progressive-by-band
 *     rule in integer paise, but it is a teaching aid: it knows nothing about any
 *     real agency's billing, and any screen showing it must say on screen that
 *     the API is authoritative. `PREVIEW_DISCLAIMER` is that sentence.
 */

import type { CommissionSlab } from '@/lib/economyConfig'
export type { CommissionSlab }

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `calculateCommission`, `CommissionResult`, `SlabBreakdown`
 *
 * The browser-side payable calculation, and the types that existed only to
 * carry its result. What an agency is owed is a money fact about the business,
 * and the spec (0.1.5, 0.6.3) requires every such number to be generated
 * server-side from the ledger and to be explainable. Call
 * `GET /partner-ops/agencies/{id}/commission-preview?period=…` to see a real
 * figure and its derivation without crediting anything, or read
 * `commission_basis` on `GET /partners/agencies/{id}/statement`.
 *
 * DELETED — `MAIN_AGENCY_SLABS`, `SUB_AGENCY_SLABS`
 *
 * Hardcoded "fallback" tables with zero importers, and they no longer matched
 * the live ones in `appConfig/economy`: they started at ₹0 rather than the real
 * ₹25,001 floor, and their rates had drifted (8/12/23% against the live
 * 7.5/14/23%). A stale second copy of the slab table is exactly how a wrong
 * commission survives review — whichever screen you look at appears
 * authoritative. The backend holds the only fallback now, it is the live table,
 * and anything computed from it is marked provisional.
 * ───────────────────────────────────────────────────────────────────────────── */

export const PREVIEW_DISCLAIMER =
  'Estimate only — an illustration of the slab table, calculated in this browser. ' +
  'What an agency is actually paid is computed by the API from the ledger, and ' +
  'the API is authoritative.'

/** The rule, quoted from the backend rather than re-implemented. */
export const COMMISSION_RULE =
  'Progressive by band, like income tax. Each slice of the agency’s billing is ' +
  'charged at the rate of the band it falls in — the first slice at the lowest ' +
  'band’s rate, the next at the next band’s rate, and so on. No single rate is ' +
  'ever applied to the whole amount. Below the lowest band’s lower bound the ' +
  'agency earns nothing, and that part never attracts a rate however large the ' +
  'total. The top band has no cap.'

// ── The shape the API returns ─────────────────────────────────────────────────
// Mirrors `commission_for`'s breakdown in backend/app/services/commission.py.
// Every money field is INR **minor units** (paise).

export interface CommissionBand {
  index: number
  from_minor: number
  to_minor: number | null      // null on the open-ended top band
  from_inr: number
  to_inr: number | null
  rate_percent: string         // "7.5" as text, so it never grows a float tail
  rate_basis_points: number
  open_ended: boolean
  label: string
}

export interface CommissionBreakdown {
  billing_minor: number
  billing_inr: number
  matched: boolean
  band: CommissionBand | null
  rate_percent: string
  commission_minor: number
  commission_inr: number
  effective_rate_percent: string
  floor_minor: number
  floor_inr: number
  rule: string
  rounding: string
  explanation: string
  bands_considered?: CommissionBand[]
}

/**
 * The effective rate as text: `commission ÷ billing × 100`, two decimals.
 *
 * Audit C-10 / M-25: the server sends `effective_rate_percent`
 * (`commission.py` — "always below the top band's rate", because the rule is
 * progressive); an older server that does not is computed here from the two
 * paise figures, so the figure is never missing. '' only when there is no
 * billing to divide by.
 */
export function effectiveRatePercent(b: Pick<CommissionBreakdown, 'billing_minor' | 'commission_minor'> & { effective_rate_percent?: string }): string {
  const sent = (b.effective_rate_percent ?? '').trim()
  if (sent) return sent
  if (!b.billing_minor || b.billing_minor <= 0) return ''
  return ((b.commission_minor / b.billing_minor) * 100).toFixed(2)
}

/**
 * One row per fact, in the order an agency would ask for them.
 *
 * "Rate" is the TOP band's rate — the one the last slice of billing was charged
 * at. The rule is progressive (each slice at its own band's rate), so what the
 * agency actually earned over the whole figure is the **effective rate**, which
 * is always at or below it. Both are shown (audit C-10 / M-25): a partner who
 * reads only the band rate reads a number higher than what they are paid.
 */
export function describeBreakdown(
  b: CommissionBreakdown,
): { label: string; value: string }[] {
  const effective = effectiveRatePercent(b)
  return [
    { label: 'Billing for the period', value: fmtInrMinor(b.billing_minor) },
    {
      label: 'Band',
      value: b.band
        ? b.band.label
        : `none — below the ${fmtInrMinor(b.floor_minor)} floor`,
    },
    { label: 'Rate (top band reached)', value: `${b.rate_percent}%` },
    { label: 'Effective rate', value: effective ? `${effective}% of billing — progressive, each slice at its own band` : '—' },
    { label: 'Commission', value: fmtInrMinor(b.commission_minor) },
  ]
}

// ── Preview (estimate) ────────────────────────────────────────────────────────

export interface CommissionPreview {
  billingMinor: number
  commissionMinor: number
  band: CommissionSlab | null
  ratePercent: number
  /** Always true. This figure is never payable. */
  isEstimate: true
  note: string
  explanation: string
}

/**
 * The progressive-by-band rule, for illustration only. Integer paise throughout.
 * (It was "flat-rate-by-band" in name only — the arithmetic below has been
 * progressive since the backend's was; the name was audit M-25's contradiction.)
 *
 * Bands are matched the way the backend matches them: sorted by `from`, each
 * band running up to the next band's `from` (so the paise between ₹75,000.00
 * and ₹75,001.00 stay in the band below rather than falling into no band), and
 * the last band open-ended whatever its `to` says. Below the lowest band's
 * `from` the result is zero.
 *
 * A slab table this cannot read returns zero **with a note saying so**. It
 * never guesses a band — and nothing is paid from this function in any case.
 */
export function previewCommission(
  billingInr: number,
  slabs: CommissionSlab[],
): CommissionPreview {
  const billingMinor = Math.round((Number(billingInr) || 0) * 100)

  const none = (note: string): CommissionPreview => ({
    billingMinor: Math.max(0, billingMinor),
    commissionMinor: 0,
    band: null,
    ratePercent: 0,
    isEstimate: true,
    note,
    explanation: note,
  })

  if (billingMinor < 0) return none('Billing cannot be negative.')
  if (!slabs?.length) {
    return none('No slab table is configured, so no band can be shown.')
  }

  const ordered = [...slabs].sort((a, b) => a.from - b.from)
  const unreadable = ordered.some(
    s => !Number.isFinite(s.from) || !Number.isFinite(s.rate) || s.from < 0,
  )
  if (unreadable) {
    return none('The slab table could not be read, so no band is shown.')
  }

  const floorMinor = Math.round(ordered[0].from * 100)
  if (billingMinor < floorMinor) {
    return none(
      `Below the ${fmtInrMinor(floorMinor)} floor — the agency earns no ` +
        'commission for this period. Hosts are still paid their own payout in full.',
    )
  }

  let index = ordered.length - 1
  for (let i = 0; i < ordered.length - 1; i++) {
    if (billingMinor < Math.round(ordered[i + 1].from * 100)) {
      index = i
      break
    }
  }

  const band = ordered[index]
  const rateBp = Math.round(band.rate * 100)

  // Progressive: each slice at its own band's rate, summed, rounded once.
  //
  // This preview used to charge the matched band's rate against the whole
  // billing figure. That was correct when the rule was flat and is now simply a
  // different, larger number than the one the agency is actually paid — which
  // is the exact failure this file's own disclaimer warns about, a browser
  // disagreeing with the ledger. Same arithmetic as
  // `backend/app/services/commission.py::commission_for`.
  let raw = 0
  for (let i = 0; i <= index; i++) {
    const b = ordered[i]
    const lowerEdge = Math.round(b.from * 100) - 1
    const ceiling =
      i === ordered.length - 1
        ? billingMinor
        : Math.min(billingMinor, Math.round(ordered[i + 1].from * 100) - 1)
    const slice = ceiling - lowerEdge
    if (slice > 0) raw += slice * Math.round(b.rate * 100)
  }
  // Half-up to the paisa, once on the total — same as the server.
  const commissionMinor = Math.floor((raw + 5000) / 10000)
  const upper =
    index === ordered.length - 1
      ? 'with no upper limit'
      : `up to ${fmtInrMinor(Math.round(ordered[index + 1].from * 100) - 1)}`

  return {
    billingMinor,
    commissionMinor,
    band,
    ratePercent: band.rate,
    isEstimate: true,
    note: PREVIEW_DISCLAIMER,
    explanation:
      `${fmtInrMinor(billingMinor)} is charged slab by slab, up to ` +
      `${band.rate}% on the part above ` +
      `${fmtInrMinor(Math.round(band.from * 100))} (${upper}). ` +
      `That comes to ${fmtInrMinor(commissionMinor)} — an effective rate of ` +
      `${((commissionMinor / billingMinor) * 100).toFixed(2)}%, lower than the ` +
      `top slab because only the top slice is charged at it.`,
  }
}

// ── Binance conversion calculator ─────────────────────────────────────────────
// Shows exactly what INR arrives after all deductions on a USD payment via Binance.

export interface BinanceConversionResult {
  usdAmount:         number   // USD received
  usdToInrRate:      number   // rate used
  grossInr:          number   // USD * rate
  binanceFeeInr:     number   // grossInr * binanceFeePercent / 100
  govtTaxInr:        number   // grossInr * govtTaxPercent / 100
  netInr:            number   // grossInr - binanceFeeInr - govtTaxInr
  totalDeductionPct: number   // combined fee + tax as % of grossInr
}

export function calcBinanceConversion(
  usdAmount: number,
  usdToInrRate: number,
  binanceFeePercent: number,
  govtTaxPercent: number,
): BinanceConversionResult {
  const grossInr     = usdAmount * usdToInrRate
  const binanceFeeInr = (grossInr * binanceFeePercent) / 100
  const govtTaxInr   = (grossInr * govtTaxPercent) / 100
  const netInr       = grossInr - binanceFeeInr - govtTaxInr
  const totalDeductionPct = binanceFeePercent + govtTaxPercent
  return { usdAmount, usdToInrRate, grossInr, binanceFeeInr, govtTaxInr, netInr, totalDeductionPct }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function fmtInr(n: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n)
}

/** Paise → rupees, for a figure the API returned. Money crosses the wire as paise. */
export function fmtInrMinor(minor: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format((Number(minor) || 0) / 100)
}

export function fmtUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  }).format(n)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `inrToUsd` and `usdToInr`
 *
 * Both had zero importers. Both defaulted their `rate` argument to a deleted
 * ₹83 constant, so a caller who omitted it got a wrong answer that looked like
 * a right one. A one-line division is not worth a helper that ships its own
 * stale exchange rate; divide by `(await getRates()).usdToInr` at the call
 * site, where the rate is visible.
 * ───────────────────────────────────────────────────────────────────────────── */
