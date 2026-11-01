import * as crypto from 'crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import * as logger from 'firebase-functions/logger'

/**
 * Lucky gifts — the combo, the odds table and the roll. No Firestore in here:
 * `settleGift` reads the document inside its transaction and hands the data
 * to `resolveLuckyConfig`; everything else is arithmetic a test can run.
 *
 * ── The mechanic ─────────────────────────────────────────────────────────────
 *
 * A lucky gift is never sent singly. The sender picks a COMBO (10, 17, 25 or
 * 77 by default) and pays `unit × combo` diamonds, where `unit` is the gift's
 * `diamondCost` from the catalogue — a price the client never sends. The
 * receiver earns `floor(unit × combo × receiverPct / 100)` beans into the same
 * earnings paths as any other gift. The sender's REWARD is a multiplier drawn
 * server-side over the weighted table, paid as `multiplier × unit` diamonds in
 * the same transaction as the charge: a failure credits nothing and charges
 * nothing. Zipper's line is `unit × combo − receiverBeans − reward`, and on a
 * big win it is negative — recorded as it is, because the aggregate is what
 * the table is tuned on.
 *
 * ── The document: `appConfig/luckyGifts` ─────────────────────────────────────
 *
 *   {
 *     version:     number                        // bumped by the CRM on every save
 *     combos:      number[]                      // integers ≥ 10; default [10, 17, 25, 77]
 *     receiverPct: number                        // 0–100; default 5
 *     odds:        [{ multiplier, weight }, …]   // multiplier integer 5–100, weight > 0
 *                                                // default 5:84, 10:10, 25:4, 50:1.5, 100:0.5
 *     updatedAt, updatedBy                       // written by the CRM, read by nobody here
 *   }
 *
 * Absent fields take the defaults above. The CRM writes the document; this
 * module only reads it.
 *
 * ── The payout guard ─────────────────────────────────────────────────────────
 *
 * The expected multiplier is `E = Σ(multiplier × weight) / Σ weight`. On the
 * smallest combo the sender pays `minCombo × unit`, the receiver takes
 * `receiverPct` of that, and the expected reward is `E × unit`. The table is
 * REFUSED when the expected reward exceeds ninety percent of what is left
 * after the receiver's share:
 *
 *     E × unit > minCombo × unit × (1 − receiverPct / 100) × 0.9
 *     ⇔   E   >  minCombo × (1 − receiverPct / 100) × 0.9
 *
 * With the defaults E = 7.45 against a ceiling of 10 × 0.95 × 0.9 = 8.55. The
 * guard runs every time the configuration is READ, and `validateLuckyConfig`
 * is exported for the CRM to run before it saves. A table that fails the guard
 * is never used: lucky sends fall back to the last version this instance
 * accepted, or are refused with a clear error. There is no silent fall-back to
 * a built-in table.
 *
 * ── The roll ─────────────────────────────────────────────────────────────────
 *
 * `crypto.randomInt(0, Σ weight)` over the weights scaled to integers (a weight
 * of 1.5 is 1 500 of 100 000), walked cumulatively. The transaction row keeps
 * `roll` and `rollTotal` with the multiplier and `rollSeedHash =
 * sha256("lucky:" + transactionId + ":" + version + ":" + roll + ":" + total)`,
 * so a row whose multiplier was edited after the fact no longer matches its
 * own hash, and anyone with the row can recompute which bucket the roll fell
 * in from the table version named on it.
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
  /** Weights are scaled by this to integers for `crypto.randomInt`. */
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
 * or a code and a sentence saying what is wrong.
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

/**
 * The last configuration this instance accepted. A document that later fails
 * the guard is not used; this is what lucky sends run on instead, with a
 * warning on every read, until the CRM saves a valid one.
 */
let lastValid: LuckyConfig | null = null
let warnedMissing = false

/** Test seam: forget the last accepted version. */
export function resetLuckyConfigCache(): void {
  lastValid = null
  warnedMissing = false
}

/**
 * The configuration a lucky send runs on, from the document as read inside
 * the settlement transaction.
 *
 *   document absent          → the defaults (version 0), logged once
 *   document valid           → that document
 *   document invalid         → the last valid version this instance saw, with
 *                              a warning; or, with none, a `failed-precondition`
 *                              the sender can read. Never a built-in table.
 */
export function resolveLuckyConfig(data: Record<string, unknown> | undefined, exists: boolean): LuckyConfig {
  if (!exists || data === undefined) {
    if (!warnedMissing) {
      warnedMissing = true
      logger.warn('luckyGifts: appConfig/luckyGifts is absent; lucky gifts run on the documented defaults (version 0)')
    }
    const v = validateLuckyConfig(undefined)
    if (!v.ok) throw new HttpsError('failed-precondition', 'Lucky gifts are unavailable right now.', { code: v.code })
    lastValid = v.config
    return v.config
  }
  const v = validateLuckyConfig(data)
  if (v.ok) {
    lastValid = v.config
    return v.config
  }
  logger.error('luckyGifts: appConfig/luckyGifts refused by the payout guard', {
    code: v.code, reason: v.reason, version: data.version ?? null,
    fallbackVersion: lastValid ? lastValid.version : null,
  })
  if (lastValid) return lastValid
  throw new HttpsError(
    'failed-precondition',
    'Lucky gifts are unavailable right now.',
    { code: v.code, reason: v.reason },
  )
}

/** The catalogue flag: `category: 'lucky'` is what the CRM and the app use; the aliases are tolerated. */
export function isLuckyGift(gift: Record<string, unknown>): boolean {
  return String(gift.category ?? '').toLowerCase() === 'lucky'
    || gift.isLucky === true
    || String(gift.type ?? '').toLowerCase() === 'lucky'
}

export interface LuckyRoll {
  multiplier: number
  /** The number drawn, 0 ≤ roll < total. */
  roll: number
  /** Σ weight × weightScale. */
  total: number
}

/**
 * Draw a multiplier. `randomInt` is `crypto.randomInt` unless a test passes
 * its own; the odds must already have passed `validateLuckyConfig`.
 */
export function rollLuckyMultiplier(
  odds: LuckyOdds[],
  randomInt: (min: number, max: number) => number = crypto.randomInt,
): LuckyRoll {
  const scaled = odds.map((o) => Math.round(o.weight * LUCKY_LIMITS.weightScale))
  const total = scaled.reduce((n, w) => n + w, 0)
  if (total <= 0) throw new Error('luckyGifts: the odds table has no weight')
  const roll = randomInt(0, total)
  if (!Number.isInteger(roll) || roll < 0 || roll >= total) {
    throw new Error('luckyGifts: the roll fell outside the table')
  }
  let upTo = 0
  for (let i = 0; i < odds.length; i++) {
    upTo += scaled[i]
    if (roll < upTo) return { multiplier: odds[i].multiplier, roll, total }
  }
  // Unreachable: the loop covers [0, total).
  return { multiplier: odds[odds.length - 1].multiplier, roll, total }
}

/** The hash recorded beside the roll. See the header. */
export function luckyRollHash(p: { transactionId: string; configVersion: number; roll: number; total: number }): string {
  return crypto.createHash('sha256')
    .update(`lucky:${p.transactionId}:${p.configVersion}:${p.roll}:${p.total}`)
    .digest('hex')
}

export interface LuckySettlement {
  /** What the sender pays: unit × combo. */
  charge: number
  /** floor(unit × combo × receiverPct / 100). */
  receiverBeans: number
  /** multiplier × unit, credited to the sender. */
  reward: number
  /** charge − receiverBeans − reward; negative on a big win. */
  platformCut: number
}

/** The four numbers of a lucky send, from the four inputs. */
export function luckySettlement(p: { unit: number; combo: number; receiverPct: number; multiplier: number }): LuckySettlement {
  const charge = p.unit * p.combo
  const receiverBeans = Math.floor((charge * p.receiverPct) / 100)
  const reward = p.multiplier * p.unit
  return { charge, receiverBeans, reward, platformCut: charge - receiverBeans - reward }
}
