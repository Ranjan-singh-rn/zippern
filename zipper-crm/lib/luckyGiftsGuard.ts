/**
 * Lucky gifts — the odds table and the payout guard, as the SERVER runs them.
 *
 * Pure — no imports, no React, no Firebase — so `npm run test:luckygifts`
 * compiles and runs the shipped module.
 *
 * ── A MIRROR, ON PURPOSE ─────────────────────────────────────────────────────
 *
 * `functions/src/luckyGifts.ts` is the authority: `settleGift` validates the
 * document on every read and REFUSES a table that fails the guard (lucky
 * sends then run on the last version that instance accepted, or are refused).
 * The CRM runs the same validation before it saves, so a table that would be
 * refused on the server is never written. The formulas here are copied from
 * that file, line for line where the language allows; if one changes, both
 * must. `luckyGiftsGuard.spec.ts` pins the numbers from its header.
 *
 * ── The document: `appConfig/luckyGifts` ─────────────────────────────────────
 *
 *   {
 *     enabled:     boolean                       // the Owner's switch; OFF unless exactly true
 *     version:     number                        // bumped by the CRM on every save
 *     combos:      number[]                      // integers ≥ 10; default [10, 17, 25, 77]
 *     receiverPct: number                        // 0–100; default 5
 *     odds:        [{ multiplier, weight }, …]   // multiplier integer 5–100, weight > 0
 *                                                // default 5:84, 10:10, 25:4, 50:1.5, 100:0.5
 *     updatedAt, updatedBy                       // written by the CRM
 *   }
 *
 * `enabled` is not part of the table and the guard below never reads it; see
 * "The Owner's switch" at the end of this file.
 *
 * ── The payout guard ─────────────────────────────────────────────────────────
 *
 * The expected multiplier is `E = Σ(multiplier × weight) / Σ weight`. On the
 * smallest combo the sender pays `minCombo × unit`, the receiver takes
 * `receiverPct` of that, and the expected reward is `E × unit`. The table is
 * REFUSED when the expected reward exceeds ninety percent of what is left
 * after the receiver's share:
 *
 *     E > minCombo × (1 − receiverPct / 100) × 0.9
 *
 * With the defaults E = 7.45 against a ceiling of 10 × 0.95 × 0.9 = 8.55.
 */

export const LUCKY_CONFIG_PATH = 'appConfig/luckyGifts'

export interface LuckyOdds {
  multiplier: number
  weight: number
}

export interface LuckyConfig {
  version: number
  combos: number[]
  receiverPct: number
  odds: LuckyOdds[]
}

export const LUCKY_DEFAULTS: Readonly<LuckyConfig> = Object.freeze({
  version: 0,
  combos: [10, 17, 25, 77],
  receiverPct: 5,
  odds: [
    { multiplier: 5, weight: 84 },
    { multiplier: 10, weight: 10 },
    { multiplier: 25, weight: 4 },
    { multiplier: 50, weight: 1.5 },
    { multiplier: 100, weight: 0.5 },
  ],
})

export const LUCKY_LIMITS = Object.freeze({
  multiplierMin: 5,
  multiplierMax: 100,
  comboMin: 10,
  /** The share of the post-receiver pot the expected reward may not exceed. */
  safety: 0.9,
  /** Weights are scaled by this to integers for `crypto.randomInt` on the server. */
  weightScale: 1000,
})

/** `crypto.randomInt` refuses a range of 2^48 or more. */
const MAX_RANDOM_RANGE = 2 ** 48 - 1

export type LuckyValidation =
  | { ok: true; config: LuckyConfig; expectedMultiplier: number; ceiling: number }
  | { ok: false; code: string; reason: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Σ(multiplier × weight) / Σ weight. */
export function expectedMultiplier(odds: LuckyOdds[]): number {
  let weighted = 0
  let total = 0
  for (const o of odds) {
    weighted += o.multiplier * o.weight
    total += o.weight
  }
  return total > 0 ? weighted / total : Number.POSITIVE_INFINITY
}

/** The most the expected multiplier may be: `minCombo × (1 − receiverPct/100) × 0.9`. */
export function luckyPayoutCeiling(cfg: Pick<LuckyConfig, 'combos' | 'receiverPct'>): number {
  const minCombo = Math.min(...cfg.combos)
  return minCombo * (1 - cfg.receiverPct / 100) * LUCKY_LIMITS.safety
}

/**
 * Normalise one odds entry. Accepts `{ multiplier, weight }` and the `[m, w]`
 * shorthand the defaults are usually written in.
 */
function oddsEntry(raw: unknown): LuckyOdds | null {
  if (Array.isArray(raw) && raw.length === 2) {
    return { multiplier: raw[0] as number, weight: raw[1] as number }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return { multiplier: o.multiplier as number, weight: o.weight as number }
  }
  return null
}

/**
 * Validate a configuration document (or anything the CRM is about to save).
 *
 * Pure. Absent fields take the defaults; present fields must be right. The
 * result either carries a usable `LuckyConfig` with the guard's two numbers,
 * or a code and a sentence saying what is wrong. Identical to the server's.
 */
export function validateLuckyConfig(raw: unknown): LuckyValidation {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const refuse = (code: string, reason: string): LuckyValidation => ({ ok: false, code, reason })

  const version = doc.version === undefined ? LUCKY_DEFAULTS.version : doc.version
  if (!isNum(version) || version < 0) return refuse('LUCKY_VERSION', 'version must be a number ≥ 0.')

  const combosRaw = doc.combos === undefined ? LUCKY_DEFAULTS.combos : doc.combos
  if (!Array.isArray(combosRaw) || combosRaw.length === 0) {
    return refuse('LUCKY_COMBOS', 'combos must be a non-empty list of whole numbers ≥ 10.')
  }
  const combos: number[] = []
  for (const c of combosRaw) {
    if (!isInt(c) || c < LUCKY_LIMITS.comboMin) {
      return refuse('LUCKY_COMBOS', `combo ${String(c)} is not a whole number ≥ ${LUCKY_LIMITS.comboMin}.`)
    }
    if (combos.includes(c)) return refuse('LUCKY_COMBOS', `combo ${c} is listed twice.`)
    combos.push(c)
  }
  combos.sort((a, b) => a - b)

  const receiverPct = doc.receiverPct === undefined ? LUCKY_DEFAULTS.receiverPct : doc.receiverPct
  if (!isNum(receiverPct) || receiverPct < 0 || receiverPct > 100) {
    return refuse('LUCKY_RECEIVER_PCT', 'receiverPct must be a number between 0 and 100.')
  }

  const oddsRaw = doc.odds === undefined ? LUCKY_DEFAULTS.odds : doc.odds
  if (!Array.isArray(oddsRaw) || oddsRaw.length === 0) {
    return refuse('LUCKY_ODDS', 'odds must be a non-empty list of { multiplier, weight }.')
  }
  const odds: LuckyOdds[] = []
  let scaledTotal = 0
  for (const entry of oddsRaw) {
    const o = oddsEntry(entry)
    if (!o) return refuse('LUCKY_ODDS', 'every odds entry must be { multiplier, weight }.')
    if (!isInt(o.multiplier) || o.multiplier < LUCKY_LIMITS.multiplierMin || o.multiplier > LUCKY_LIMITS.multiplierMax) {
      return refuse('LUCKY_ODDS',
        `multiplier ${String(o.multiplier)} must be a whole number between ${LUCKY_LIMITS.multiplierMin} and ${LUCKY_LIMITS.multiplierMax}.`)
    }
    if (!isNum(o.weight) || o.weight <= 0) {
      return refuse('LUCKY_ODDS', `weight for ×${o.multiplier} must be greater than 0.`)
    }
    const scaled = Math.round(o.weight * LUCKY_LIMITS.weightScale)
    if (scaled < 1) {
      return refuse('LUCKY_ODDS', `weight for ×${o.multiplier} is too small to roll (minimum 0.001).`)
    }
    scaledTotal += scaled
    odds.push({ multiplier: o.multiplier, weight: o.weight })
  }
  if (scaledTotal > MAX_RANDOM_RANGE) return refuse('LUCKY_ODDS', 'the weights are too large to roll.')

  const config: LuckyConfig = { version, combos, receiverPct, odds }
  const e = expectedMultiplier(odds)
  const ceiling = luckyPayoutCeiling(config)
  if (e > ceiling) {
    return refuse('LUCKY_PAYOUT_GUARD',
      `expected multiplier ${e.toFixed(3)} exceeds the ceiling ${ceiling.toFixed(3)} ` +
      `(= min combo ${Math.min(...combos)} × (1 − ${receiverPct}/100) × ${LUCKY_LIMITS.safety}). ` +
      'Lower the multipliers or their weights, raise the smallest combo, or lower receiverPct.')
  }
  return { ok: true, config, expectedMultiplier: e, ceiling }
}

// ── What the page shows beside the table ────────────────────────────────────

export interface ComboMargin {
  combo: number
  /** The sender pays `combo` units; the receiver takes this many (per unit, before floor). */
  receiverUnits: number
  /** The expected reward in units: E. */
  expectedRewardUnits: number
  /** `combo − receiverUnits − E`, in units of the gift price. */
  expectedPlatformUnits: number
  /** The same as a percentage of what the sender pays: `(1 − pct/100 − E/combo) × 100`. */
  expectedMarginPct: number
}

/**
 * The platform's expected line per combo, in units of the gift's diamond
 * price (so it holds for every lucky gift in the catalogue). Rounding of the
 * receiver's share (`floor`) is ignored here; it only ever favours the house.
 */
export function comboMargins(cfg: Pick<LuckyConfig, 'combos' | 'receiverPct' | 'odds'>): ComboMargin[] {
  const e = expectedMultiplier(cfg.odds)
  return [...cfg.combos].sort((a, b) => a - b).map((combo) => {
    const receiverUnits = (combo * cfg.receiverPct) / 100
    const expectedPlatformUnits = combo - receiverUnits - e
    return {
      combo,
      receiverUnits,
      expectedRewardUnits: e,
      expectedPlatformUnits,
      expectedMarginPct: combo > 0 ? (expectedPlatformUnits / combo) * 100 : 0,
    }
  })
}

/** Each multiplier's share of the rolls, in percent, for the table. */
export function oddsShares(odds: LuckyOdds[]): Array<LuckyOdds & { pct: number }> {
  const total = odds.reduce((n, o) => n + (Number.isFinite(o.weight) ? o.weight : 0), 0)
  return odds.map((o) => ({ ...o, pct: total > 0 ? (o.weight / total) * 100 : 0 }))
}

/**
 * What the CRM writes: the validated config with `version` bumped past the
 * server's current one — never the number the form happened to hold, so two
 * editors cannot both save "version 4".
 */
export function nextVersion(serverVersion: unknown): number {
  const v = typeof serverVersion === 'number' && Number.isFinite(serverVersion) && serverVersion >= 0
    ? Math.floor(serverVersion) : 0
  return v + 1
}

// ── The Owner's switch ──────────────────────────────────────────────────────
//
// A lucky gift is a chance mechanic — diamonds spent on a random reward — and
// was deliberately left unshipped pending a legal opinion under India's Online
// Gaming Act 2025. The server (functions/src/luckyGifts.ts) therefore refuses
// every lucky send, `failed-precondition` / LUCKY_GIFTS_DISABLED, unless the
// document exists and `enabled` is exactly `true`: an absent document is OFF.
//
// Only the Owner (`superadmin`) turns it on or off. Tech edits the table on
// the same page, and a Tech save writes no `enabled` at all — the write merges,
// so the stored switch stays as it is (firestore.rules D15 refuses a non-Owner
// write that changes it). The Owner's own save of the table alone writes no
// `enabled` either: only a deliberate flip of the toggle is written, so a save
// never undoes a switch somebody else changed after this page loaded.

/** Shown beside the toggle and again in the confirmation. Verbatim. */
export const LUCKY_ENABLE_WARNING =
  'Confirm legal clearance (Online Gaming Act 2025) before enabling. Turning this on lets users spend diamonds on a random reward.'

/** The server's `details.code` while the switch is off, and the sentence the app shows for it. */
export const LUCKY_GIFTS_DISABLED = 'LUCKY_GIFTS_DISABLED'
export const LUCKY_GIFTS_DISABLED_MESSAGE = 'Lucky gifts are not available right now.'

/** Is the switch on in this stored document? Exactly `enabled === true`, as the server reads it; absent is off. */
export function luckyEnabledOf(doc: unknown): boolean {
  return !!doc && typeof doc === 'object' && (doc as Record<string, unknown>).enabled === true
}

/** Only the Owner — CRM role `superadmin` — may turn lucky gifts on or off. */
export function mayToggleLuckyGifts(role: string | null | undefined): boolean {
  return role === 'superadmin'
}

/**
 * What a save writes for `enabled`: the Owner's choice, only when the Owner
 * flipped it from what the page loaded; otherwise nothing (`undefined`), and
 * the merge leaves the stored switch as it is.
 */
export function enabledToWrite(
  role: string | null | undefined,
  loaded: boolean,
  requested: boolean,
): boolean | undefined {
  if (!mayToggleLuckyGifts(role)) return undefined
  return requested === loaded ? undefined : requested
}
