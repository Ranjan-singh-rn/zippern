/**
 * Party Pro settings (B7, 3 Nov 2026) — pure, tested in `partyProGuard.spec.ts`. The shape of
 * `appConfig/partySubscription`, cleaned exactly as functions/src/partySubscription.ts `mergeSubConfig` cleans it,
 * and the diamond price computed the same way (`priceInDiamonds`). The Owner alone writes it (firestore.rules E7).
 */

export interface SubConfig {
  enabled: boolean
  required: boolean
  priceInr: number
  priceDiamonds: number
  minLevel: number
  days: number
}

export const FALLBACK_DIAMOND_PER_LAKH_INR = 2390

export function mergeSubConfig(raw: unknown): SubConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = (v: unknown, d: number, lo: number, hi: number) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
  }
  return {
    enabled: r.enabled !== false,
    required: r.required !== false,
    priceInr: n(r.priceInr, 200, 1, 100_000),
    priceDiamonds: Math.trunc(n(r.priceDiamonds, 0, 0, 100_000_000)),
    minLevel: Math.trunc(n(r.minLevel, 7, 0, 100)),
    days: Math.trunc(n(r.days, 30, 1, 366)),
  }
}

/** The Owner's diamond price if set, else ₹ price at the economy's diamond price (₹ per lakh), rounded up. */
export function priceInDiamonds(cfg: SubConfig, diamondPackPriceInr: unknown): number {
  if (cfg.priceDiamonds > 0) return cfg.priceDiamonds
  const perLakh = Number(diamondPackPriceInr)
  const rupeesPerDiamond = (Number.isFinite(perLakh) && perLakh > 0 ? perLakh : FALLBACK_DIAMOND_PER_LAKH_INR) / 100_000
  return Math.ceil(cfg.priceInr / rupeesPerDiamond - 1e-9)
}

/** The staff roles that may be granted official entry to private rooms (the Owner always has it). */
export const OFFICIAL_ACCESS_ROLES = ['app_admin', 'app_member', 'ops_admin', 'ops_member', 'support_admin', 'support_member',
  'tech_admin', 'tech_member', 'finance_admin', 'finance_member', 'marketing_admin', 'marketing_member'] as const
