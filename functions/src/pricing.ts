/**
 * Call pricing — the money math, with no Firebase in it.
 *
 * This lives apart from `calls.ts` for one reason: it is the part that can be
 * WRONG IN A WAY NOBODY NOTICES. A broken transaction throws and somebody files
 * a bug; a split that pays 30% where it should pay 50% just quietly underpays
 * every female host on the platform, forever, and the only signal is hosts
 * drifting to a competitor.
 *
 * `calls.ts` cannot be imported by a test — it calls `admin.firestore()` at
 * module load, which needs a live app. So the arithmetic is here, where a test
 * can put all thirty-six pairings through it in a millisecond and check every
 * cell against the specification.
 *
 * Nothing in this file reads a database, a clock, or an environment variable.
 * Everything it needs arrives as an argument. See `functions/test/pricing.test.js`.
 */

/**
 * The three genders the economy distinguishes.
 *
 * An unrecorded gender — an account from before the field existed, a guest who
 * never finished setup — is read as `transgender`, which is the middle row and
 * the middle column of the table below: it never overpays, never badly
 * underpays, and above all never refuses the call. A pairing with no price is a
 * paying customer turned away at the moment they try to spend.
 */
export type Gender = 'male' | 'female' | 'transgender'

export function genderOf(user: Record<string, any>): Gender {
  const g = String(user.gender ?? '').trim().toLowerCase()
  if (g === 'male') return 'male'
  if (g === 'female') return 'female'
  return 'transgender'
}

/**
 * The earner's share, by PAYER gender and EARNER gender. Nothing else.
 *
 * ── THE RULE, AND WHY IT IS STATED THIS WAY ──────────────────────────────────
 *
 * The split was specified as thirty-six worked examples — every combination of
 * (caller gender × caller kind × receiver gender × receiver kind). All
 * thirty-six reduce, without a single exception, to one 3×3 table read on the
 * two genders alone. Who dialled and who is a host decide WHO PAYS (see
 * `rateFor`); they do not touch the percentage.
 *
 *                 earner
 *   payer     male  female  trans
 *   male       30%    50%    40%
 *   female     40%    30%    40%
 *   trans      40%    40%    40%
 *
 * Worth keeping the two worked examples that make the direction concrete,
 * because they look contradictory until you see which side is paying:
 *
 *   female host calls a male user  → the USER pays, the HOST earns
 *                                  → payer male, earner female → 50%
 *   male host calls a female user  → the USER pays, the HOST earns
 *                                  → payer female, earner male → 40%
 *
 * Same "host calls user", opposite percentages, and the table explains it
 * without a special case.
 *
 * ── WHY THE OLD SHAPE COULD NOT EXPRESS IT ───────────────────────────────────
 *
 * This used to be three numbers — `sameGender`, `oppositeGenderFemaleHost`,
 * `oppositeGenderMaleHost` — keyed on the HOST's gender and whether the caller
 * was a host. That shape has no way to say "male pays female is 50 but female
 * pays male is 40", and no concept of a transgender participant at all: every
 * trans host was silently priced through the `sameGender` fallback. Three
 * numbers cannot hold a nine-cell table, so the config key is new rather than
 * extended, and `SPLIT_DEFAULTS` below is the table the product was specified
 * with.
 */
const SPLIT_DEFAULTS: Record<Gender, Record<Gender, number>> = {
  male:        { male: 30, female: 50, transgender: 40 },
  female:      { male: 40, female: 30, transgender: 40 },
  transgender: { male: 40, female: 40, transgender: 40 },
}

/**
 * One cell, from `appConfig/economy.callSplitMatrix` when the CRM has set it.
 *
 * Shape: `{ payerGender: { earnerGender: percent } }`. A cell that is missing,
 * non-numeric or outside 1–100 falls back to the specified default rather than
 * to zero — a zero here would hand the entire call to the platform and pay the
 * earner nothing, which is the one failure nobody would notice quickly.
 */
export function earnerPct(cfg: Record<string, any>, payer: Gender, earner: Gender): number {
  const matrix = (cfg.callSplitMatrix ?? {}) as Record<string, any>
  const row = (matrix[payer] ?? {}) as Record<string, any>
  const v = row[earner]
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100) return Math.trunc(v)
  return SPLIT_DEFAULTS[payer][earner]
}

/**
 * Who pays, who earns, and what a minute costs.
 *
 * ── THE USER ALWAYS PAYS ─────────────────────────────────────────────────────
 *
 * A host is someone the platform pays; a user is someone who spends. So when
 * the two meet, the direction of the call is irrelevant — the user pays and the
 * host earns, whether the host dialled or answered. This is the half the old
 * implementation got wrong: it derived the payer from `earnerUid` in a way that
 * made the CALLER pay whenever the caller was a host, so a host phoning a user
 * was charged for the privilege of earning.
 *
 * When both sides are the same kind — two users, or two hosts — there is no
 * such asymmetry to resolve, so the ordinary convention applies: the caller
 * pays and the receiver earns.
 *
 * ── AND THE PRICE FOLLOWS FROM THE EARNER'S INCOME ───────────────────────────
 *
 * The earner's bean income per minute is the fixed quantity; the payer's price
 * is derived from it as `income / pct`. Ceiling division, so rounding never
 * favours the payer and short-pays the earner a diamond a minute.
 *
 * Two users have no `callRateBeans` between them, so there is nothing to derive
 * a price from and the flat `userCallRatePerMin` applies instead, with the
 * receiver's share taken out of it. The two are inverses of each other, which
 * is the correct relationship.
 */
export function rateFor(
  cfg: Record<string, any>,
  caller: Record<string, any>,
  receiver: Record<string, any>,
): {
  perMin: number
  pct: number
  /** Which side of the call receives the beans. */
  earner: 'caller' | 'receiver'
  /** Which side is debited. Never assume it is the caller. */
  payer: 'caller' | 'receiver'
} {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const callerIsHost = caller.isHost === true
  const receiverIsHost = receiver.isHost === true
  const defaultIncome = num(cfg.callRateBeansPerMin, 375)

  /**
   * An unverified host earns at the base rate, never their own.
   *
   * They can go live, take calls and receive gifts — the earning is not what is
   * restricted. What is restricted is *scaling*: without this, the cheapest way
   * to make money on the platform is to register a host with someone else's
   * photograph, set the rate to the ceiling, and never complete verification.
   * The badge gates featuring and payouts; this gates price.
   */
  const incomeFor = (host: Record<string, any>) =>
    host.isVerifiedHost === true ? num(host.callRateBeans, defaultIncome) : defaultIncome

  // Exactly one host: the user pays whichever way the call was dialled.
  if (receiverIsHost !== callerIsHost) {
    const earner: 'caller' | 'receiver' = receiverIsHost ? 'receiver' : 'caller'
    const payer: 'caller' | 'receiver' = receiverIsHost ? 'caller' : 'receiver'
    const earnerUser = receiverIsHost ? receiver : caller
    const payerUser = receiverIsHost ? caller : receiver
    const pct = earnerPct(cfg, genderOf(payerUser), genderOf(earnerUser))
    const income = incomeFor(earnerUser)
    return { perMin: Math.ceil((income * 100) / Math.max(pct, 1)), pct, earner, payer }
  }

  // Two hosts: caller pays, receiver earns, price from the receiver's rate.
  if (receiverIsHost && callerIsHost) {
    const pct = earnerPct(cfg, genderOf(caller), genderOf(receiver))
    const income = incomeFor(receiver)
    return {
      perMin: Math.ceil((income * 100) / Math.max(pct, 1)),
      pct,
      earner: 'receiver',
      payer: 'caller',
    }
  }

  // Two users: flat price, receiver's share derived from it.
  const flat = num(cfg.userCallRatePerMin, 1600)
  const pct = earnerPct(cfg, genderOf(caller), genderOf(receiver))
  return { perMin: flat, pct, earner: 'receiver', payer: 'caller' }
}
