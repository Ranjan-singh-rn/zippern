import { db } from '@/lib/firebase'
import {
  doc, getDoc, setDoc, serverTimestamp, Timestamp,
  collection, getDocs, query, orderBy, limit, deleteField,
} from 'firebase/firestore'
import { getRates, ratesNow } from '@/lib/rates'

// ── Economy Config (stored in appConfig/economy) ──────────────────────────────

/**
 * One commission band.
 *
 * **A slab table's lowest `from` is the commission floor.** Below it the agency
 * earns nothing — not a smaller percentage, nothing. So `from: 0` on the first
 * slab means *there is no floor*, and every rupee of billing earns commission
 * from the first rupee. That is not the business rule, and a table written that
 * way pays 5% on ₹10,000 of billing that should pay ₹0.
 *
 * The rule the server applies (backend/app/services/commission.py) is **flat
 * rate by band**: the agency's total billing for the period selects one band,
 * charged slab by slab, each slice at its own rate. It is progressive.
 * The top band is open-ended whatever its `to` says.
 */
export interface CommissionSlab {
  from: number    // INR lower bound (inclusive). The first slab's `from` is the floor.
  to: number      // INR upper bound (inclusive); use 999_999_999 for "no cap"
  rate: number    // percentage, e.g. 5 = 5%, 7.5 = 7.5%
}

export interface CommissionConfig {
  mainAgencySlabs:   CommissionSlab[]   // bands for main agencies; floor = first `from`
  subAgencySlabs:    CommissionSlab[]   // bands for sub-agencies; floor = first `from`
  usdToInrRate:      number             // live exchange rate, e.g. 83
  binanceFeePercent: number             // Binance trading/withdrawal fee %, e.g. 1.0
  govtTaxPercent:    number             // TDS/GST on crypto conversion, e.g. 1.0
  weeklyMinPayoutUsd:number             // minimum USD earnings for weekly payout
}

export interface GiftRates {
  normalReceiverPct: number       // % of diamond value that goes to receiver (normal gifts)
  exclusiveReceiverPctMin: number // min % for exclusive gifts
  exclusiveReceiverPctMax: number // max % for exclusive gifts
  luckyReceiverPct: number        // base % for lucky gifts (receiver always earns this in beans)
  luckyReturnMin: number          // minimum return multiplier for lucky gift winner (e.g. 5 = 5× the gift cost)
  luckyReturnMax: number          // maximum return multiplier for lucky gift winner (e.g. 20 = 20× the gift cost)
  beanToInrRate: number           // 1 bean = X INR
}

/**
 * `appConfig/economy.callSplitMatrix` — who keeps what on a call.
 *
 * ── ONE TABLE, READ ON THE TWO GENDERS ───────────────────────────────────────
 *
 * The earner's share depends on the PAYER's gender and the EARNER's gender, and
 * on nothing else. Not on who dialled, not on who is a host — those decide who
 * pays (below), not the percentage.
 *
 *                 earner
 *   payer     male  female  trans
 *   male       30%    50%    40%
 *   female     40%    30%    40%
 *   trans      40%    40%    40%
 *
 * ── WHO PAYS ─────────────────────────────────────────────────────────────────
 *
 * The user always pays. One host and one user → the user pays and the host
 * earns, whichever of them dialled. Two users or two hosts → the caller pays
 * and the receiver earns.
 *
 * That is what makes these two look contradictory until you see the direction:
 *
 *   a female host rings a male user → the user pays → payer male, earner
 *                                     female → 50%
 *   a male host rings a female user → the user pays → payer female, earner
 *                                     male → 40%
 *
 * ── WHICH WAY THE NUMBER BITES ───────────────────────────────────────────────
 *
 * It decides both halves of call pricing, and which half depends on whether a
 * host is involved (`functions/src/calls.ts::rateFor`):
 *
 *   * host on either side — the host's bean income is fixed by their call rate
 *     and the PAYER's price is derived from it, `ceil(income × 100 / pct)`. A
 *     lower share here therefore makes the call **more expensive** for the
 *     payer; it does not pay the host less.
 *   * neither side a host — the price is `userCallRatePerMin` and the
 *     RECEIVER's earnings are derived from it, `floor(diamonds × pct / 100)`.
 *     Here a lower share does pay the receiver less.
 *
 * ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
 *
 * Three numbers — `sameGender`, `oppositeGenderFemaleHost`,
 * `oppositeGenderMaleHost` — keyed on the HOST's gender and whether the caller
 * was a host. That shape cannot express "male pays female is 50 but female pays
 * male is 40", and had no concept of a transgender participant at all: every
 * trans host was silently priced through the `sameGender` fallback. Nine cells
 * do not fit in three numbers, so this is a new key rather than an extension,
 * and `receiverSplit` is left where it is — unread by anything — rather than
 * migrated, so a rollback has something to land on.
 */
export type SplitGender = 'male' | 'female' | 'transgender'

/** `{ payerGender: { earnerGender: percent } }`, whole percentages 1–100. */
export type CallSplitMatrix = Record<SplitGender, Record<SplitGender, number>>

export const SPLIT_GENDERS: SplitGender[] = ['male', 'female', 'transgender']

export const SPLIT_GENDER_LABELS: Record<SplitGender, string> = {
  male: 'Male',
  female: 'Female',
  transgender: 'Transgender',
}

/**
 * The table the product was specified with.
 *
 * Mirrors `SPLIT_DEFAULTS` in functions/src/calls.ts. A cell the CRM has not
 * set, or has set to something outside 1–100, falls back to this rather than to
 * zero — a zero would hand the whole call to the platform and pay the earner
 * nothing, which is the one failure nobody notices quickly.
 */
export const DEFAULT_CALL_SPLIT_MATRIX: CallSplitMatrix = {
  male:        { male: 30, female: 50, transgender: 40 },
  female:      { male: 40, female: 30, transgender: 40 },
  transgender: { male: 40, female: 40, transgender: 40 },
}

/** One cell, defaulted and bounds-checked exactly as the server does it. */
export function splitPct(
  matrix: CallSplitMatrix | undefined,
  payer: SplitGender,
  earner: SplitGender,
): number {
  const v = matrix?.[payer]?.[earner]
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100) return Math.trunc(v)
  return DEFAULT_CALL_SPLIT_MATRIX[payer][earner]
}

export interface LevelEntry {
  level: number
  hostEntriesPerHour: number
  userEntriesPerGift: number
  minGiftValueForEntry: number   // minimum diamond cost to qualify
}

export interface LevelUnlockItem {
  id: string
  name: string
  type: 'crown' | 'profile_card' | 'profile_frame' | 'chat_bubble' | 'bag' | 'badge'
  minUserLevel: number   // 0 = not available for users
  minHostLevel: number   // 0 = not available for hosts
}

export interface EconomyConfig {
  giftRates: GiftRates
  levelEntries: LevelEntry[]
  weeklyMinPayoutInr: number    // minimum host earnings for weekly payout eligibility (INR)

  /**
   * The SECOND host payout condition — "one lakh beans in a week".
   *
   * **Absent means the rule is not configured, and absent is the default.** It
   * is deliberately not filled in by `defaultConfig()` and never invented from a
   * fallback: the owner has described this rule but nobody has set a number for
   * it, and the weekly report says so in as many words
   * (backend/app/services/reports.py:3078 — "NO BEAN THRESHOLD IS CONFIGURED").
   * Writing a plausible 100000 here would silence that warning without anybody
   * having decided anything, and from then on the report would assert a
   * threshold the owner never chose.
   *
   * The server looks for this key first, then `weeklyMinBeans`, then
   * `minWeeklyBeans` (BEAN_THRESHOLD_KEYS, reports.py:2896). This editor writes
   * the first of the three. While it is unset, host eligibility applies the
   * rupee threshold ONLY (`meets_beans` defaults to true, reports.py:3868).
   *
   * A whole, non-negative number of beans. The server refuses anything else and
   * falls back to rupees alone with a warning, so it is refused here too rather
   * than being written and discovered a week later.
   */
  weeklyMinPayoutBeans?: number

  /**
   * Set when `appConfig/economy` holds a `weeklyMinPayoutBeans` that is NOT a
   * usable bean count — the raw value, as stored, for the editor to show.
   *
   * This is a READ-ONLY diagnostic and is stripped before any write. Without it
   * a malformed value would render identically to an absent one, and the editor
   * would tell an owner the rule is unconfigured while the weekly report told
   * them their value was ignored.
   */
  weeklyMinPayoutBeansUnusable?: string

  callRateBeansPerMin: number   // default beans/min for calls

  /**
   * The flat price of a call with **no host on either side**, in diamonds per
   * minute paid by the caller.
   *
   * It is the one call price that is not derived from a host's bean income, and
   * it is the inverse of the host case: here the price is fixed and the
   * receiver's earnings come out of it, `floor(diamonds × pct / 100)` beans at
   * the `callSplitMatrix` share for the pairing.
   *
   * `functions/src/calls.ts:137` reads it and falls back to 1600; the Android
   * app reads it with `getLong`. Whole diamonds, therefore — a fractional value
   * is dropped by the app's parser and falls back to 1600 without saying so.
   */
  userCallRatePerMin: number

  /**
   * Who keeps what on a call, by payer gender × earner gender.
   * See `CallSplitMatrix` — it works two ways round.
   */
  callSplitMatrix: CallSplitMatrix

  minHostCallRate: number       // minimum call rate agency can set for a host (beans/min)
  maxHostCallRate: number       // maximum call rate agency can set for a new host (beans/min)
  diamondPackPriceInr: number   // ₹ price for 1 lakh (100,000) diamonds — Indian users
  /**
   * ₹ a COIN SELLER pays for 1 lakh diamonds — the wholesale price.
   *
   * Their discount, and their entire margin: they buy here and resell at
   * `diamondPackPriceInr`, collecting the difference from the buyer directly.
   * Leave it equal to the retail price to give no discount.
   */
  sellerWholesalePriceInr: number
  diamondPackPriceUsd: number   // USD price for 1 lakh diamonds — foreign users
  beanToDiamondRate: number     // how many beans = 1 diamond (for bean→diamond conversion)
  levelUnlockItems: LevelUnlockItem[]
  commissionConfig: CommissionConfig  // dynamic slabs + FX rates — all editable in CRM
  updatedAt?: Timestamp
  updatedBy?: string
}

/**
 * The defaults used when `appConfig/economy` does not exist yet.
 *
 * Every rate here is taken from `lib/rates.ts` rather than written out again.
 * They used to be a second, independent set of numbers — ₹2,290 per lakh and
 * ₹83 to the dollar against rates.ts's ₹2,390 and ₹95, with the backend
 * agreeing with rates.ts. Two disagreeing sets of "defaults" for the same
 * config document is how a 4% understatement survives review: whichever screen
 * you look at appears authoritative.
 *
 * `ratesNow()` reads the same `appConfig/economy` document, so when it exists
 * these values are the live ones and the merge below is a no-op; when it does
 * not, they are rates.ts's fallbacks. Either way there is exactly one source.
 *
 * This is a function, not a `const`, so it is evaluated per call and picks up
 * live rates once `getRates()` has resolved instead of freezing the fallbacks
 * at module load.
 */
function defaultConfig(): EconomyConfig {
  const r = ratesNow()
  return {
    giftRates: {
      normalReceiverPct:        30,
      exclusiveReceiverPctMin:  30,
      exclusiveReceiverPctMax:  60,
      luckyReceiverPct: 5,
      luckyReturnMin:   5,
      luckyReturnMax:   20,
      beanToInrRate:    r.bean,
    },
    levelEntries: [
      { level: 1, hostEntriesPerHour: 1,  userEntriesPerGift: 1,  minGiftValueForEntry: 10  },
      { level: 2, hostEntriesPerHour: 2,  userEntriesPerGift: 2,  minGiftValueForEntry: 50  },
      { level: 3, hostEntriesPerHour: 3,  userEntriesPerGift: 3,  minGiftValueForEntry: 100 },
      { level: 4, hostEntriesPerHour: 5,  userEntriesPerGift: 5,  minGiftValueForEntry: 200 },
      { level: 5, hostEntriesPerHour: 8,  userEntriesPerGift: 8,  minGiftValueForEntry: 500 },
    ],
    weeklyMinPayoutInr:   r.minPayoutInr,
    callRateBeansPerMin:  375,

    // ── The two call-economy knobs, defaulted to what the readers fall back to
    //
    // 1600 and 50/40/30 are not chosen here; they are copied from the two places
    // that apply them when `appConfig/economy` says nothing —
    // `functions/src/calls.ts::rateFor` / `receiverPct` and
    // `EconomyConfigRepository.fallback()`. A different "default" on this screen
    // would be an editor offering to save a number the live system was never
    // using, which is how a silent repricing happens.
    userCallRatePerMin:   1600,
    callSplitMatrix: DEFAULT_CALL_SPLIT_MATRIX,

    minHostCallRate:      350,
    maxHostCallRate:      700,
    diamondPackPriceInr:  r.diamondPerLakhInr,
    sellerWholesalePriceInr: r.sellerWholesalePerLakhInr,
    diamondPackPriceUsd:  r.diamondPerLakhUsd,
    beanToDiamondRate:    r.beanToDiamond,
    levelUnlockItems:     [],

    // ── Commission config ────────────────────────────────────────────────────
    // Moving these here means SA can edit tiers live without a code deploy.
    commissionConfig: {
      usdToInrRate:       r.usdToInr,
      binanceFeePercent:  1.0,
      govtTaxPercent:     1.0,
      weeklyMinPayoutUsd: 0,
      mainAgencySlabs: DEFAULT_MAIN_AGENCY_SLABS,
      subAgencySlabs:  DEFAULT_SUB_AGENCY_SLABS,
    },
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The slab defaults.
 *
 * **A slab table's lowest `from` is the commission floor. `from: 0` means there
 * is no floor.** These two arrays used to start at `from: 0` and carry rates
 * (8 / 10 / 12 / 13 / 16 / 23 …) that matched nothing else in the system. That
 * mattered more than it looks: `getEconomyConfig()` merges these defaults under
 * whatever Firestore holds, and the Economy Config page can save the merged
 * result straight back to `appConfig/economy` — which is the same document the
 * server reads its slabs from. So a floorless default was one Save away from
 * becoming the live table, and the server would then dutifully pay 5% on
 * ₹10,000 of billing that is owed ₹0. The bug did not need a code change to
 * come back; it could re-enter through configuration.
 *
 * Both tables below are the live ones, copied verbatim from
 * `backend/backups/firestore-2026-08-20-1548/appConfig.json` → economy →
 * commissionConfig. They are the same values the server falls back to
 * (`FALLBACK_MAIN_SLABS` / `FALLBACK_SUB_SLABS` in
 * backend/app/services/commission.py), so a fresh install and a Firestore
 * outage now agree instead of paying two different tables.
 *
 * The floors are deliberate: ₹25,001 for a main agency, ₹26,001 for a sub.
 * Below them the agency earns ₹0 — the hosts are still paid their own payout in
 * full; the floor affects agency commission and nothing else.
 *
 * The top band's ₹50,00,000 `to` is a display bound only. The top band is
 * open-ended: above its lower bound the rate applies with no cap.
 * ───────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_MAIN_AGENCY_SLABS: CommissionSlab[] = [
  { from:   25_001, to:    75_000, rate: 5   },   // ← the floor. Below ₹25,001: ₹0.
  { from:   75_001, to:   150_000, rate: 7.5 },
  { from:  150_001, to:   300_000, rate: 10  },
  { from:  300_001, to:   500_000, rate: 14  },
  { from:  500_001, to:   800_000, rate: 16  },
  { from:  800_001, to: 1_200_000, rate: 18  },
  { from: 1_200_001, to: 1_800_000, rate: 21 },
  { from: 1_800_001, to: 2_500_000, rate: 23 },
  { from: 2_500_001, to: 5_000_000, rate: 25 },   // open-ended in practice
]

export const DEFAULT_SUB_AGENCY_SLABS: CommissionSlab[] = [
  { from:   26_001, to:    75_000, rate: 5    },  // ← the floor. Below ₹26,001: ₹0.
  { from:   75_001, to:   150_000, rate: 6    },
  { from:  150_001, to:   300_000, rate: 7    },
  { from:  300_001, to:   500_000, rate: 8    },
  { from:  500_001, to:   800_000, rate: 9    },
  { from:  800_001, to: 1_200_000, rate: 10   },
  { from: 1_200_001, to: 1_800_000, rate: 11  },
  { from: 1_800_001, to: 2_500_000, rate: 12  },
  { from: 2_500_001, to: 5_000_000, rate: 12.5 }, // open-ended in practice
]

export async function getEconomyConfig(): Promise<EconomyConfig> {
  // Warm the rate cache first so `defaultConfig()` fills its gaps from the live
  // rates rather than from rates.ts's cold fallbacks.
  await getRates().catch(() => undefined)
  const base = defaultConfig()

  const ref = doc(db, 'appConfig', 'economy')
  const snap = await getDoc(ref)
  if (!snap.exists()) return base
  const data = snap.data() as Partial<EconomyConfig>
  // Deep-merge nested maps so new fields added to the defaults are not lost
  // when the Firestore doc was written before those fields existed
  const merged = {
    ...base,
    ...data,
    giftRates:        { ...base.giftRates,        ...(data.giftRates        ?? {}) },
    commissionConfig: { ...base.commissionConfig, ...(data.commissionConfig ?? {}) },
    // Merged row by row, and it has to be: the readers fill a missing CELL from
    // their own fallback individually (`splitPct` / `earnerPct`), so a document
    // carrying four of the nine is a live config with nine values. An editor
    // that showed the other five as blank would write them away on the next
    // save, silently repricing every pairing it did not display.
    callSplitMatrix: {
      male: {
        ...DEFAULT_CALL_SPLIT_MATRIX.male,
        ...((data.callSplitMatrix as Record<string, unknown> | undefined)?.male ?? {}),
      },
      female: {
        ...DEFAULT_CALL_SPLIT_MATRIX.female,
        ...((data.callSplitMatrix as Record<string, unknown> | undefined)?.female ?? {}),
      },
      transgender: {
        ...DEFAULT_CALL_SPLIT_MATRIX.transgender,
        ...((data.callSplitMatrix as Record<string, unknown> | undefined)?.transgender ?? {}),
      },
    } as CallSplitMatrix,
  } as EconomyConfig

  // ── The bean threshold, which is allowed to be absent ──────────────────────
  //
  // `...data` would carry through whatever is stored, including a string or a
  // negative, and the editor would then offer to save it back unchanged. The
  // three states are told apart here instead: set, unset, and set to something
  // unusable. Only the first survives into `weeklyMinPayoutBeans`.
  delete merged.weeklyMinPayoutBeans
  delete merged.weeklyMinPayoutBeansUnusable
  const rawBeans = (snap.data() as Record<string, unknown>).weeklyMinPayoutBeans
  if (rawBeans !== undefined && rawBeans !== null && rawBeans !== '') {
    if (typeof rawBeans === 'number' && Number.isInteger(rawBeans) && rawBeans >= 0) {
      merged.weeklyMinPayoutBeans = rawBeans
    } else {
      merged.weeklyMinPayoutBeansUnusable = String(rawBeans)
    }
  }
  return merged
}

// ── The bean threshold ────────────────────────────────────────────────────────

/**
 * Refuse a bean threshold the server would not apply.
 *
 * `thresholds_from_config` (backend/app/services/reports.py:3062) does
 * `int(data[key])` and, on failure, warns and applies the rupee threshold
 * ALONE. So a bad value here does not fail loudly — it quietly turns the rule
 * off again, a week later, in a report nobody re-reads. Refusing at the point
 * of entry is where it is still a sentence someone can act on.
 *
 * `null` is a legitimate argument and means "leave the rule unconfigured".
 */
export function validateBeanThreshold(value: number | null): void {
  if (value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      'The weekly bean threshold is not a number. Leave it unset to keep the ' +
      'rule off, or enter a whole number of beans.',
    )
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `The weekly bean threshold is ${value}. Beans are whole; the server reads ` +
      'this with int() and would ignore a fractional value, applying the rupee ' +
      'threshold alone. It is refused rather than rounded.',
    )
  }
  if (value < 0) {
    throw new Error(
      `The weekly bean threshold is ${value}. A negative threshold would make ` +
      'every host eligible on beans, which is the same as having no rule — ' +
      'unset it instead, so the report keeps saying it is not configured.',
    )
  }
}

// ── Call economy validation ───────────────────────────────────────────────────

/**
 * Refuse a call price or a receiver share that the readers would not apply.
 *
 * Both readers are unforgiving in the same quiet way. The Android app reads
 * these with `getLong` and `num()` and, on anything that is not a whole number,
 * substitutes its own compiled-in fallback without a word
 * (`EconomyConfigRepository.parse`). `functions/src/calls.ts` does the same with
 * its `num(v, d)` helper. So a fractional or negative value here does not fail:
 * it silently reverts the platform to 1600 and 50/40/30 while this editor goes
 * on showing whatever was typed. Refusing at the point of entry is where it is
 * still a sentence somebody can act on.
 *
 * A zero share is refused separately and for a different reason. `calls.ts`
 * guards the division with `Math.max(pct, 1)`, so a 0% share does not crash —
 * it prices a host call at a hundred times their bean income and pays a
 * non-host receiver nothing at all. Both are catastrophic and neither looks
 * like an error anywhere.
 */
export function validateCallEconomy(config: {
  userCallRatePerMin: number
  callSplitMatrix: CallSplitMatrix
}): void {
  const rate = config.userCallRatePerMin
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(
      'The user-to-user call rate is not a number. It is the price of every ' +
      'call with no host on either side, in diamonds per minute.',
    )
  }
  if (!Number.isInteger(rate)) {
    throw new Error(
      `The user-to-user call rate is ${rate}. Diamonds are whole; the app reads ` +
      'this with getLong() and would ignore a fractional value, falling back to ' +
      '1600 diamonds a minute without saying so. It is refused rather than rounded.',
    )
  }
  if (rate <= 0) {
    throw new Error(
      `The user-to-user call rate is ${rate}. A call that costs nothing pays its ` +
      'receiver nothing, because the receiver earns a percentage of what the ' +
      'caller spends.',
    )
  }

  const matrix = config.callSplitMatrix
  for (const payer of SPLIT_GENDERS) {
    for (const earner of SPLIT_GENDERS) {
      const who =
        `${SPLIT_GENDER_LABELS[payer]} pays, ${SPLIT_GENDER_LABELS[earner]} earns`
      const value = matrix?.[payer]?.[earner]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`The earner share for “${who}” is not a number.`)
      }
      if (!Number.isInteger(value)) {
        throw new Error(
          `The earner share for “${who}” is ${value}%. Shares are whole ` +
          'percentages — the app and the call function both read them as ' +
          'integers and would fall back to the shipped table instead.',
        )
      }
      if (value < 1 || value > 100) {
        throw new Error(
          `The earner share for “${who}” is ${value}%, which is outside 1–100%. ` +
          'A zero share pays a non-host receiver nothing and prices a host call ' +
          'at a hundred times the host\u2019s bean income; above 100% the payer ' +
          'pays less than the earner receives.',
        )
      }
    }
  }
}

// ── Slab validation ───────────────────────────────────────────────────────────
//
// The same checks the server runs in `parse_slabs`
// (backend/app/services/commission.py). The server refuses a malformed table
// anyway — it raises `MalformedSlabTable` and computes nothing rather than
// quietly paying the wrong band — but by then the table has already been saved
// and every accrual is failing with no obvious cause. Refusing at the point of
// entry is where "slabs ₹75,001–₹1,50,000 and ₹1,00,000–₹2,00,000 overlap" is
// still a sentence someone can act on.
//
// Kept deliberately in step with the server. If the server's rules change,
// these change with them; if they ever disagree, the server wins and this is
// the bug.

/** Thrown when a slab table would not be accepted by the server. */
export class SlabTableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlabTableError'
  }
}

const SLAB_LABELS: Record<'main' | 'sub', string> = {
  main: 'Main agency',
  sub:  'Sub-agency',
}

function inr(value: number): string {
  return `₹${value.toLocaleString('en-IN')}`
}

/**
 * Check one slab table, or throw a `SlabTableError` saying exactly what is wrong.
 *
 * Sorted by lower bound first — a table written out of order is a formatting
 * accident, not a different rule — then:
 *
 *   * the table must not be empty
 *   * bounds must be whole, non-negative rupees, with `to >= from`
 *   * the rate must be a number in 0–100 with at most two decimal places
 *     (rates are held as whole basis points; 7.5% is 750bp, 7.555% is not)
 *   * bands must not overlap
 *   * bands must be consecutive: each `from` is the previous `to` + 1, so no
 *     billing figure falls into no band at all
 *
 * It does **not** reject `from: 0`. A zero floor is a policy the owner is
 * allowed to choose, and the server accepts it; it is simply never the default
 * — see the note on the default tables above.
 */
export function validateSlabTable(slabs: CommissionSlab[], kind: 'main' | 'sub'): void {
  const who = SLAB_LABELS[kind]

  if (!Array.isArray(slabs) || slabs.length === 0) {
    throw new SlabTableError(
      `The ${who} slab table is empty. An empty table is not the same as a zero ` +
      'rate — nothing can be paid from it, so it cannot be saved.',
    )
  }

  const parsed = slabs.map((slab, i) => {
    const n = i + 1
    const { from, to, rate } = slab ?? ({} as CommissionSlab)

    for (const [label, value] of [['from', from], ['to', to]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SlabTableError(
          `${who} slab ${n} has a '${label}' of ${String(value)}, which is not a number.`,
        )
      }
      if (!Number.isInteger(value)) {
        throw new SlabTableError(
          `${who} slab ${n} has a '${label}' of ${value}. Slab bounds are whole ` +
          'rupees; a fractional bound is ambiguous and is refused rather than rounded.',
        )
      }
      if (value < 0) {
        throw new SlabTableError(`${who} slab ${n} has a negative '${label}' (${value}).`)
      }
    }

    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new SlabTableError(
        `${who} slab ${n} has a rate of ${String(rate)}, which is not a number.`,
      )
    }
    if (rate < 0 || rate > 100) {
      throw new SlabTableError(
        `${who} slab ${n} has a rate of ${rate}%, which is outside 0–100%.`,
      )
    }
    if (!Number.isInteger(Math.round(rate * 100)) || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-9) {
      throw new SlabTableError(
        `${who} slab ${n} has a rate of ${rate}%. Rates are held as whole basis ` +
        'points (at most two decimal places); a finer rate cannot be applied ' +
        'exactly, so it is refused rather than rounded.',
      )
    }

    if (to < from) {
      throw new SlabTableError(
        `${who} slab ${n} runs from ${inr(from)} to ${inr(to)} — its upper bound ` +
        'is below its lower bound.',
      )
    }

    return { from, to, rate }
  })

  parsed.sort((a, b) => (a.from - b.from) || (a.to - b.to))

  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1]
    const cur  = parsed[i]
    if (cur.from <= prev.to) {
      throw new SlabTableError(
        `${who} slabs ${inr(prev.from)}–${inr(prev.to)} and ${inr(cur.from)}–` +
        `${inr(cur.to)} overlap. Two bands could claim the same billing figure, ` +
        'so no band is chosen and nothing is paid until the table is fixed.',
      )
    }
    if (cur.from !== prev.to + 1) {
      throw new SlabTableError(
        `${who} slab table has a gap between ${inr(prev.to)} and ${inr(cur.from)} — ` +
        `billing of ${inr(prev.to + 1)} falls in no band. Each slab's 'from' must ` +
        "be the previous slab's 'to' plus one.",
      )
    }
  }
}

/** Both tables, checked together. Throws `SlabTableError` on the first problem. */
export function validateCommissionConfig(cc: CommissionConfig): void {
  validateSlabTable(cc?.mainAgencySlabs, 'main')
  validateSlabTable(cc?.subAgencySlabs, 'sub')
}

/**
 * The config as a plain object safe to hand to something that will write it —
 * `setDoc` here, or an approval request payload.
 *
 * Two things are removed. `levelEntries` / `levelUnlockItems` are not managed by
 * this screen and were written by an older version. `weeklyMinPayoutBeansUnusable`
 * is a read-time diagnostic and is not part of the config at all — writing it
 * would put a string describing a bad value into the document beside the bad
 * value.
 *
 * `weeklyMinPayoutBeans` is left OUT when it is unset rather than written as
 * `undefined`, which Firestore refuses outright.
 */
export function economyConfigForWrite(config: EconomyConfig): Record<string, unknown> {
  const {
    levelEntries, levelUnlockItems, weeklyMinPayoutBeans, weeklyMinPayoutBeansUnusable,
    ...rest
  } = config
  void levelEntries; void levelUnlockItems; void weeklyMinPayoutBeansUnusable
  const out: Record<string, unknown> = { ...rest }
  if (typeof weeklyMinPayoutBeans === 'number') {
    out.weeklyMinPayoutBeans = weeklyMinPayoutBeans
  }
  return out
}

export async function saveEconomyConfig(
  config: EconomyConfig,
  updatedBy: string,
): Promise<void> {
  // Refuse a malformed slab table here rather than writing it and discovering
  // it when the next accrual fails. `appConfig/economy` is the document the
  // server reads its commission bands from — saving a broken table into it
  // stops every agency's commission, not just this screen's.
  validateCommissionConfig(config.commissionConfig)
  validateBeanThreshold(config.weeklyMinPayoutBeans ?? null)
  // Same argument as the slab table: these two are read by the Cloud Functions
  // call path and by the app, and a value they refuse is not a visible failure
  // — it is a quiet revert to the compiled-in fallback, which reprices every
  // call on the platform without anybody being told.
  validateCallEconomy(config)

  const ref = doc(db, 'appConfig', 'economy')
  await setDoc(ref, {
    ...economyConfigForWrite(config),
    updatedAt: serverTimestamp(),
    updatedBy,
    // Actively delete stale fields that were written by old versions
    levelEntries:     deleteField(),
    levelUnlockItems: deleteField(),
    // An unset bean threshold is DELETED, not omitted. This is a merge write, so
    // omitting the key would leave a previously-saved number in place while the
    // editor showed the rule as off — the one state that must not be reachable
    // is a threshold nobody can see being applied to real payouts.
    ...(typeof config.weeklyMinPayoutBeans === 'number'
      ? {}
      : { weeklyMinPayoutBeans: deleteField() }),
  }, { merge: true })
}

// ── Bean / Diamond transactions ───────────────────────────────────────────────
//
// These types describe the `beanTransactions` / `diamondTransactions`
// subcollections as the Android app and the API write them. They are a READ
// model. Nothing in this file writes them any more.

export type CurrencyType = 'beans' | 'diamonds'
export type TxDirection  = 'credit' | 'debit'

export interface CurrencyTransaction {
  id: string
  userId: string
  userName: string
  type: TxDirection
  currency: CurrencyType
  amount: number
  reason: string
  addedBy: string
  timestamp: Timestamp
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `applyCurrencyTransaction`
 *
 * WHAT WAS HERE
 *   A browser-side balance writer. It did
 *     updateDoc(users/{id}, { diamonds | beans: increment(±amount) })
 *   and then appended a record to the matching transaction subcollection.
 *
 * WHY IT IS GONE
 *   It moved real money with one click and no second person. The five-stage
 *   card board — raise → verify (someone else) → sign (owner) → execute — was
 *   the entire point of the rebuild, and this function was the hole in it: any
 *   operator who opened /economy/currency instead of the user page bypassed
 *   verification and signature completely. `firestore.rules` now refuses
 *   browser writes to `diamonds` and `beans` outright, so as well as being
 *   unsafe this code was broken — it threw permission-denied.
 *
 * WHAT REPLACES IT
 *   api.users.requestBalanceChange(uid, currency, amount, reason)
 *     → POST /api/users/{uid}/balance-request
 *   It returns a Card. Nothing moves until an owner signs it.
 *
 * DO NOT REINTRODUCE. A balance is not something a browser is allowed to write.
 * ───────────────────────────────────────────────────────────────────────────── */

// ── Diamond lending to coin sellers ──────────────────────────────────────────

export interface DiamondLendingRecord {
  id: string
  sellerId: string
  sellerName: string
  amount: number
  lentBy: string
  notes: string
  status: 'outstanding' | 'repaid'
  lentAt: Timestamp
  repaidAt?: Timestamp
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `lendDiamondsToSeller`
 *
 * WHAT WAS HERE
 *   A browser-side credit writer. It did
 *     updateDoc(sellers/{id}, { coinBalance: increment(amount) })
 *   and wrote an `outstanding` row into sellers/{id}/diamondLending.
 *
 * WHY IT IS GONE
 *   Lending is credit we extend, so it is money leaving the company on trust.
 *   It went out with no verification, no owner signature and — worse — no due
 *   date, so nothing was ever recorded as overdue and the credit exposure
 *   report had nothing to work from. `firestore.rules` now refuses browser
 *   writes to `coinBalance`, so this threw permission-denied.
 *
 * WHAT REPLACES IT
 *   api.partnerOps.requestLending(sellerId, { coins, due_at, terms?, reason })
 *     → POST /api/partner-ops/sellers/{id}/lending
 *   `due_at` is required by the API and is now a required field in the UI.
 *   It returns a Card; execution happens server-side after signature.
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Read-only: the lending history the API writes. Safe — this reads, it does not write. */
export async function getSellerLendingLedger(sellerId: string): Promise<DiamondLendingRecord[]> {
  const snap = await getDocs(
    query(
      collection(db, 'sellers', sellerId, 'diamondLending'),
      orderBy('lentAt', 'desc'),
      limit(50),
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as DiamondLendingRecord))
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `markLendingRepaid`
 *
 * WHAT WAS HERE
 *   updateDoc(sellers/{id}/diamondLending/{loanId}, { status: 'repaid' }).
 *
 * WHY IT IS GONE
 *   One click cleared a debt. No money had to arrive, no payment reference was
 *   recorded, nobody countersigned, and the row that said the seller owed us
 *   simply stopped saying it. That is the cheapest possible way to make an
 *   outstanding balance disappear, and it left no trace anyone could audit.
 *
 * WHAT REPLACES IT
 *   A repayment or a recovery is a card like anything else:
 *     api.partnerOps.requestRepayment(sellerId, { coins, payment_ref?, reason })
 *       → POST /api/partner-ops/sellers/{id}/repayments
 *     api.partnerOps.requestRecovery(sellerId, { coins, penalty_coins?, reason })
 *       → POST /api/partner-ops/sellers/{id}/recoveries
 *   Writing a debt off entirely is its own card, deliberately harder to reach:
 *     api.partnerOps.requestWriteOff(partnerId, { coins, reason })
 *       → POST /api/partner-ops/partners/{id}/write-off
 *
 * DO NOT REINTRODUCE.
 * ───────────────────────────────────────────────────────────────────────────── */
