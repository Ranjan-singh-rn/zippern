/**
 * Lucky gifts — the CRM runs the SAME payout guard as the server before it
 * saves `appConfig/luckyGifts`.
 *
 * REAL: `lib/luckyGiftsGuard.ts`, imported and called. The numbers below are
 * the ones `functions/test/luckyGifts.test.js` pins for the server module
 * (E = 7.45 against a ceiling of 8.55 on the defaults, 52.500 for the losing
 * table…), so the two cannot drift apart without one of the suites noticing.
 * When the Functions source is present beside this repo, the guard's three
 * formulas are also compared textually.
 *
 *   npm run test:luckygifts
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  LUCKY_CONFIG_PATH, LUCKY_DEFAULTS, LUCKY_LIMITS, comboMargins, expectedMultiplier,
  luckyPayoutCeiling, nextVersion, oddsShares, validateLuckyConfig,
} from './luckyGiftsGuard'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}
const r3 = (n: number) => Math.round(n * 1000) / 1000

// ── the defaults, as the server's header states them ─────────────────────────
eq('the document path', LUCKY_CONFIG_PATH, 'appConfig/luckyGifts')
eq('default combos', LUCKY_DEFAULTS.combos, [10, 17, 25, 77])
eq('default receiver share', LUCKY_DEFAULTS.receiverPct, 5)
eq('default odds', LUCKY_DEFAULTS.odds.map((o) => [o.multiplier, o.weight]), [[5, 84], [10, 10], [25, 4], [50, 1.5], [100, 0.5]])
eq('limits', [LUCKY_LIMITS.multiplierMin, LUCKY_LIMITS.multiplierMax, LUCKY_LIMITS.comboMin, LUCKY_LIMITS.safety, LUCKY_LIMITS.weightScale],
  [5, 100, 10, 0.9, 1000])

// ── the payout guard (numbers pinned by functions/test/luckyGifts.test.js) ───
{
  const v = validateLuckyConfig(undefined)
  ok('the default table is accepted', v.ok)
  if (v.ok) {
    eq('E = 7.45 on the defaults', r3(v.expectedMultiplier), 7.45)
    eq('ceiling = 8.55 on the defaults', r3(v.ceiling), 8.55)
    eq('combos sorted', v.config.combos, [10, 17, 25, 77])
    eq('version 0 when absent', v.config.version, 0)
  }
}
eq('ceiling = minCombo × (1 − pct/100) × 0.9', luckyPayoutCeiling({ combos: [10, 17], receiverPct: 5 }), 10 * 0.95 * 0.9)
eq('…the smallest combo, wherever it is in the list', luckyPayoutCeiling({ combos: [77, 20], receiverPct: 50 }), 20 * 0.5 * 0.9)
eq('E = Σ(m×w)/Σw', expectedMultiplier([{ multiplier: 5, weight: 1 }, { multiplier: 15, weight: 1 }]), 10)
eq('E with no weight is infinite (refused downstream)', expectedMultiplier([]), Number.POSITIVE_INFINITY)
{
  const v = validateLuckyConfig({ version: 3, odds: [{ multiplier: 5, weight: 50 }, { multiplier: 100, weight: 50 }] })
  eq('a losing table is refused by the guard', v.ok ? 'ok' : v.code, 'LUCKY_PAYOUT_GUARD')
  ok('…naming E = 52.500 and the ceiling 8.550', !v.ok && v.reason.includes('52.500') && v.reason.includes('8.550'))
}
eq('receiverPct 20 on the defaults → ceiling 7.2 < 7.45 → refused',
  (() => { const v = validateLuckyConfig({ receiverPct: 20 }); return v.ok ? 'ok' : v.code })(), 'LUCKY_PAYOUT_GUARD')
ok('…smallest combo 11 at 20% → 7.92 → accepted', validateLuckyConfig({ receiverPct: 20, combos: [11, 77] }).ok)
{
  const v = validateLuckyConfig({ combos: [10], receiverPct: 0, odds: [{ multiplier: 9, weight: 1 }] })
  ok('exactly AT the ceiling passes (not above)', v.ok && v.ceiling === 9)
}

// ── field rules: multipliers integers 5–100, weights > 0, combos integers ≥ 10 unique, pct 0–100
{
  const bad = (doc: unknown, code: string, label: string) => {
    const v = validateLuckyConfig(doc)
    eq(`refused: ${label}`, v.ok ? 'ok' : v.code, code)
  }
  bad({ odds: [{ multiplier: 4, weight: 1 }] }, 'LUCKY_ODDS', 'multiplier 4')
  bad({ odds: [{ multiplier: 101, weight: 1 }] }, 'LUCKY_ODDS', 'multiplier 101')
  bad({ odds: [{ multiplier: 5.5, weight: 1 }] }, 'LUCKY_ODDS', 'multiplier 5.5')
  bad({ odds: [{ multiplier: 5, weight: 0 }] }, 'LUCKY_ODDS', 'weight 0')
  bad({ odds: [{ multiplier: 5, weight: -1 }] }, 'LUCKY_ODDS', 'weight −1')
  bad({ odds: [{ multiplier: 5, weight: 0.0001 }] }, 'LUCKY_ODDS', 'weight too small to roll')
  bad({ odds: [] }, 'LUCKY_ODDS', 'no odds')
  bad({ odds: 'nope' }, 'LUCKY_ODDS', 'odds not a list')
  bad({ odds: [{ multiplier: 5 }] }, 'LUCKY_ODDS', 'odds entry without weight')
  bad({ combos: [9, 17] }, 'LUCKY_COMBOS', 'combo 9')
  bad({ combos: [10.5] }, 'LUCKY_COMBOS', 'combo 10.5')
  bad({ combos: [10, 10] }, 'LUCKY_COMBOS', 'duplicate combo')
  bad({ combos: [] }, 'LUCKY_COMBOS', 'no combos')
  bad({ receiverPct: 101 }, 'LUCKY_RECEIVER_PCT', 'pct 101')
  bad({ receiverPct: -1 }, 'LUCKY_RECEIVER_PCT', 'pct −1')
  bad({ version: -1 }, 'LUCKY_VERSION', 'version −1')
}
{
  const v = validateLuckyConfig({ version: 2, combos: [77, 10, 25], odds: [[5, 84], [10, 10], [25, 4], [50, 1.5], [100, 0.5]] })
  ok('the [m, w] shorthand is accepted', v.ok)
  if (v.ok) {
    eq('…combos come back sorted', v.config.combos, [10, 25, 77])
    eq('…and the odds normalised', v.config.odds[3], { multiplier: 50, weight: 1.5 })
    eq('…version kept', v.config.version, 2)
  }
}

// ── what the page shows ──────────────────────────────────────────────────────
{
  const m = comboMargins(LUCKY_DEFAULTS)
  eq('one margin row per combo, sorted', m.map((x) => x.combo), [10, 17, 25, 77])
  eq('combo 10: receiver 0.5 units, reward 7.45, platform 2.05 units = 20.5%',
    [r3(m[0].receiverUnits), r3(m[0].expectedRewardUnits), r3(m[0].expectedPlatformUnits), r3(m[0].expectedMarginPct)],
    [0.5, 7.45, 2.05, 20.5])
  eq('combo 77: platform 65.7 units = 85.32%', [r3(m[3].expectedPlatformUnits), r3(m[3].expectedMarginPct)], [65.7, 85.325])
  const shares = oddsShares(LUCKY_DEFAULTS.odds)
  eq('shares of the roll, in percent', shares.map((s) => r3(s.pct)), [84, 10, 4, 1.5, 0.5])
  eq('shares with no weight are 0, not NaN', oddsShares([{ multiplier: 5, weight: 0 }]).map((s) => s.pct), [0])
}

// ── the version is bumped past the SERVER's, never taken from the form ───────
eq('nextVersion from 0', nextVersion(0), 1)
eq('nextVersion from 7', nextVersion(7), 8)
eq('nextVersion from a float floors first', nextVersion(7.9), 8)
eq('nextVersion from nothing', [nextVersion(undefined), nextVersion(null), nextVersion('x'), nextVersion(-3)], [1, 1, 1, 1])

// ── parity with the server module, when it is beside this repo ───────────────
{
  const server = path.join(__dirname, '..', '..', 'functions', 'src', 'luckyGifts.ts')
  if (fs.existsSync(server)) {
    const s = fs.readFileSync(server, 'utf8')
    const c = fs.readFileSync(path.join(__dirname, '..', 'lib', 'luckyGiftsGuard.ts'), 'utf8')
    const between = (src: string, from: string, to: string) => {
      const a = src.indexOf(from)
      const b = src.indexOf(to, a)
      return a >= 0 && b > a ? src.slice(a, b) : ''
    }
    const guardS = between(s, 'export function validateLuckyConfig(', '\n}\n')
    const guardC = between(c, 'export function validateLuckyConfig(', '\n}\n')
    ok('validateLuckyConfig is textually identical to the server\'s', guardS.length > 0 && guardS === guardC)
    const eS = between(s, 'export function expectedMultiplier(', '\n}\n')
    const eC = between(c, 'export function expectedMultiplier(', '\n}\n')
    ok('expectedMultiplier is textually identical to the server\'s', eS.length > 0 && eS === eC)
    const cS = between(s, 'export function luckyPayoutCeiling(', '\n}\n')
    const cC = between(c, 'export function luckyPayoutCeiling(', '\n}\n')
    ok('luckyPayoutCeiling is textually identical to the server\'s', cS.length > 0 && cS === cC)
    const dS = between(s, 'export const LUCKY_DEFAULTS', '\n})\n')
    const dC = between(c, 'export const LUCKY_DEFAULTS', '\n})\n')
    ok('LUCKY_DEFAULTS are identical to the server\'s', dS.length > 0 && dS === dC)
    const lS = between(s, 'export const LUCKY_LIMITS', '\n})\n')
    const lC = between(c, 'export const LUCKY_LIMITS', '\n})\n')
    ok('LUCKY_LIMITS are identical to the server\'s', lS.length > 0 && lS.replace(/\s+/g, ' ') === lC.replace(/\s+/g, ' ').replace(' on the server', ''))
  } else {
    console.log('  (functions/src/luckyGifts.ts not beside this repo — textual parity not checked)')
  }
}

// ── the page wiring ──────────────────────────────────────────────────────────
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'app-config', 'lucky-gifts', 'page.tsx'), 'utf8')
  ok('the page runs the guard before saving', page.includes('validateLuckyConfig('))
  ok('…bumps the version past the server\'s on every save', page.includes('nextVersion('))
  ok('…and shows the expected multiplier and the per-combo margin', page.includes('comboMargins(') && page.includes('expectedMultiplier'))
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appConfig.ts'), 'utf8')
  ok('the save writes updatedAt and updatedBy', cfg.includes("'luckyGifts'") && cfg.includes('updatedBy'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} lucky-gift checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} lucky-gift checks passed.`)
console.log('  · E = Σ(m×w)/Σw must not exceed minCombo × (1 − pct/100) × 0.9 — the server\'s guard, run before the save')
console.log('  · multipliers whole 5–100, weights > 0, combos whole ≥ 10 and unique, pct 0–100; version bumped past the server\'s')
