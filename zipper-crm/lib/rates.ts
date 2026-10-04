'use client'

/**
 * Live economy rates.
 *
 * These were hardcoded in lib/finance.ts, which meant every revenue figure in
 * the CRM was computed at a rate nobody had set — ₹2,290 per lakh while the
 * configured price was ₹2,390. Roughly a 4% understatement on every number,
 * and invisible, because the config screen appeared to be in charge.
 *
 * Rates now come from `appConfig/economy`, cached for the life of the page.
 * Editing them on the Economy Config screen changes what the finance pages
 * compute, which is what a config screen is supposed to do.
 *
 * Forward-only, deliberately: this affects how figures are *displayed*, never
 * what was already written to the ledger. A payout settled last week keeps the
 * rate it settled at.
 */

import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'

export interface Rates {
  /** ₹ per diamond. Derived from the price of one lakh diamonds. */
  diamond: number
  /** ₹ per bean. */
  bean: number
  /** ₹ per lakh diamonds — the number actually entered in the CRM. Retail:
   *  what a USER pays. */
  diamondPerLakhInr: number
  /**
   * ₹ per lakh diamonds that a COIN SELLER pays us. The wholesale price.
   *
   * A seller buys at this and resells at retail, keeping the difference
   * directly from the buyer — Zipper never handles that money, so it is not a
   * payout and never reaches the money board.
   *
   * Falls back to the retail price when unset, which is a discount of zero.
   * There was previously only one diamond price in the product, so a seller
   * paying an agreed wholesale rate was checked against what their own
   * customers pay and refused for the mismatch that was the whole arrangement.
   */
  sellerWholesalePerLakhInr: number
  /** ₹ per diamond at the wholesale rate. */
  sellerWholesalePerDiamond: number
  /** USD per lakh diamonds. */
  diamondPerLakhUsd: number
  /** Beans required for one diamond, when a host converts. */
  beanToDiamond: number
  /** Minimum weekly earnings before a host is paid, in ₹. */
  minPayoutInr: number
  usdToInr: number
  /** True when config was missing and these are fallbacks. */
  isFallback: boolean
}

// Used only when appConfig/economy does not exist yet — a fresh project, or
// immediately after a reset. Every one of these should be replaced by a real
// value on the Economy Config screen.
const FALLBACK: Rates = {
  diamond: 2390 / 100000,
  bean: 0.01,
  diamondPerLakhInr: 2390,
  sellerWholesalePerLakhInr: 2390,
  sellerWholesalePerDiamond: 2390 / 100000,
  diamondPerLakhUsd: 23.9,
  // 20 beans = 1 diamond. Deliberate friction: without it,
  // gift -> convert -> re-gift is a closed loop that mints diamonds
  // nobody paid for. Was 0.5, which the editor's own min={1} could not
  // even accept, so the shipped default was unenterable.
  beanToDiamond: 20,
  minPayoutInr: 2000,
  usdToInr: 95,
  isFallback: true,
}

let cached: Rates | null = null
let inFlight: Promise<Rates> | null = null

export async function getRates(): Promise<Rates> {
  if (cached) return cached
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const snap = await getDoc(doc(db, 'appConfig', 'economy'))
      if (!snap.exists()) {
        console.warn(
          'appConfig/economy is missing — using fallback rates. ' +
            'Set them on Economy Config so revenue figures reflect reality.',
        )
        cached = FALLBACK
        return cached
      }

      const d = snap.data() as Record<string, unknown>
      const gift = (d.giftRates ?? {}) as Record<string, unknown>
      const comm = (d.commissionConfig ?? {}) as Record<string, unknown>

      const perLakhInr = num(d.diamondPackPriceInr, FALLBACK.diamondPerLakhInr)
      const beanInr = num(gift.beanToInrRate, FALLBACK.bean)

      // Unset, zero, or above retail all mean "no discount". Above retail is a
      // typo rather than a price, and charging a seller more than their own
      // customers pay is never the intended reading of it.
      const rawWholesale = num(d.sellerWholesalePriceInr, perLakhInr)
      const wholesalePerLakh =
        rawWholesale > 0 && rawWholesale <= perLakhInr ? rawWholesale : perLakhInr

      cached = {
        diamond: perLakhInr / 100000,
        bean: beanInr,
        diamondPerLakhInr: perLakhInr,
        sellerWholesalePerLakhInr: wholesalePerLakh,
        sellerWholesalePerDiamond: wholesalePerLakh / 100000,
        diamondPerLakhUsd: num(d.diamondPackPriceUsd, FALLBACK.diamondPerLakhUsd),
        beanToDiamond: num(d.beanToDiamondRate, FALLBACK.beanToDiamond),
        minPayoutInr: num(d.weeklyMinPayoutInr, FALLBACK.minPayoutInr),
        usdToInr: num(comm.usdToInrRate, FALLBACK.usdToInr),
        isFallback: false,
      }
      return cached
    } catch (err) {
      console.error('Could not read economy config — using fallback rates.', err)
      cached = FALLBACK
      return cached
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Drop the cache — call after saving Economy Config so figures update. */
export function invalidateRates(): void {
  cached = null
  inFlight = null
}

/**
 * Rates without awaiting, for render paths that cannot be async.
 *
 * Returns the fallback until the first `getRates()` resolves, so any component
 * using this should call `getRates()` in an effect and re-render.
 */
export function ratesNow(): Rates {
  return cached ?? FALLBACK
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}
