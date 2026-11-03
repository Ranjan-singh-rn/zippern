/**
 * B6 (3 Nov 2026) — the Games settings the Owner saves are read and clamped exactly as the server reads them, and
 * every game starts switched OFF.
 *
 *   npm run test:games
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  GAME_IDS, defaultGamesConfig, gamesConfigProblems, mergeGamesConfig, parseNumberList, winnerGets,
} from './gamesConfigGuard'

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

// Off by default, every game.
const d = defaultGamesConfig()
eq('master switch off', d.enabled, false)
ok('every game off', GAME_IDS.every((id) => d.games[id].enabled === false))
eq('a missing document is the defaults', mergeGamesConfig(undefined), d)

// The owner's Ludo example, previewed exactly as the server splits it.
eq('100 + 100 at 25%: winner 150, fee 50', winnerGets(100, 2, 25), { pool: 200, fee: 50, winner: 150 })
eq('4 × 100 at 25%: winner 300, fee 100', winnerGets(100, 4, 25), { pool: 400, fee: 100, winner: 300 })

// Clamping: a bad save cannot make a game pay out more than it takes in.
const bad = mergeGamesConfig({
  enabled: true,
  games: { ludo: { enabled: true, platformFeePct: 250, modes: [1, 2, 9], entryOptions: [-5, 100, 'x', 100], turnSeconds: 3 } },
})
eq('fee capped at 50%', bad.games.ludo.platformFeePct, 50)
eq('only 2–6 player tables', bad.games.ludo.modes, [2])
eq('entries: positive, whole, unique', bad.games.ludo.entryOptions, [100])
eq('turn at least 10 s', bad.games.ludo.turnSeconds, 10)
eq('a negative fee is 0', mergeGamesConfig({ games: { ludo: { platformFeePct: -3 } } }).games.ludo.platformFeePct, 0)
eq('house edge capped at 20%', mergeGamesConfig({ games: { crash: { houseEdgePct: 99 } } }).games.crash.houseEdgePct, 20)
eq('enabled must be exactly true', mergeGamesConfig({ enabled: 'yes', games: { slots: { enabled: 1 } } }).enabled, false)

// Game-specific settings and the shared limit: clamped, defaults kept, and a table size the game cannot seat refused.
const extras = mergeGamesConfig({
  limits: { maxEntryPerRound: -4 },
  games: { carrom: { targetPoints: 9999, shotsPerPlayer: 1, waitMinutes: 500 }, teen_patti: { potLimitX: 2 }, ludo: { tokensToWin: 'x' } },
})
eq('carrom target capped at 320', extras.games.carrom.targetPoints, 320)
eq('carrom shots at least 5', extras.games.carrom.shotsPerPlayer, 5)
eq('wait capped at 60 minutes', extras.games.carrom.waitMinutes, 60)
eq('teen patti pot limit at least 8 × boot', extras.games.teen_patti.potLimitX, 8)
eq('ludo tokens: rubbish is the default', extras.games.ludo.tokensToWin, 4)
eq('limit at least 1', extras.limits.maxEntryPerRound, 1)
eq('no daily loss limit by default', defaultGamesConfig().limits.dailyLossLimit, 0)
eq('a negative daily loss limit is no limit', mergeGamesConfig({ limits: { dailyLossLimit: -50 } }).limits.dailyLossLimit, 0)
eq('a daily loss limit is whole diamonds', mergeGamesConfig({ limits: { dailyLossLimit: 2500.7 } }).limits.dailyLossLimit, 2500)
eq('an extra belongs to its own game only', extras.games.slots.targetPoints, undefined)
ok('carrom seats 4 at most', gamesConfigProblems(mergeGamesConfig({ games: { carrom: { modes: [2, 6] } } })).some((p) => p.includes('Carrom') && p.includes('2 to 4')))

// Problems said in words before a save.
const empty = mergeGamesConfig({ games: { ludo: { entryOptions: [] } } })
ok('a multiplayer game with no entry amounts is refused', gamesConfigProblems(empty).some((p) => p.includes('Ludo')))
eq('the defaults have no problems', gamesConfigProblems(d), [])
eq('a list typed by hand', parseNumberList('10, 50 100,,abc 500'), [10, 50, 100, 500])

// The page: Owner only, and it writes through the guard.
const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'app-config', 'games', 'page.tsx'), 'utf8')
ok("the page is the Owner's", page.includes("canAccess(crmUser, ['superadmin'])"))
ok('the page saves the merged (clamped) config', page.includes('mergeGamesConfig(') && page.includes("doc(db, 'appConfig', 'games')"))
ok('the page refuses a save with problems', page.includes('gamesConfigProblems('))
const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
const ownerOnly = (id: string) => new RegExp(`function ownerOnlyConfig\\(\\) \\{\\s*return docId in \\[[^\\]]*'${id}'[^\\]]*\\];`).test(rules) && rules.includes('(ownerOnlyConfig() && isSuperAdmin())')
ok("rules: appConfig/games is the Owner's alone", ownerOnly('games'))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} games-config checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} games-config checks passed.`)
console.log('  · every game off until the Owner switches it on; fees and entries clamped as the server clamps them')
