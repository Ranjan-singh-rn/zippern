/**
 * GAMES — configuration and switches (B3, 3 Nov 2026).
 *
 * One document, `appConfig/games`, written by the CRM (Game settings) and read by every game action — one read per
 * action, inside its transaction, so a switch flipped in the CRM takes effect on the very next move.
 *
 *   {
 *     enabled: boolean,                 // master switch: false hides and refuses every game
 *     games: {
 *       <gameId>: {
 *         enabled: boolean,             // this game's on/off switch — the owner's
 *         maintenance: boolean,         // temporarily closed (in-progress matches still finish and settle)
 *         entryOptions: number[],       // the entry amounts a player may choose (diamonds)
 *         minEntry / maxEntry,          // for games with a free entry amount
 *         platformFeePct,               // multiplayer: Zipper's share of the pool
 *         modes: number[],              // multiplayer: player counts offered
 *         ...                           // game-specific (turnSeconds, rows, risk …)
 *       }
 *     },
 *     limits: { maxEntryPerRound?, dailyLossLimit? }
 *   }
 *
 * Every field has a default here, so a missing or partial document is a working configuration — but the defaults
 * have every game SWITCHED OFF: nothing is playable until somebody with CRM access switches it on. The local test
 * copy's seed switches them on.
 */

import * as functions from 'firebase-functions'

export type GameId =
  | 'ludo' | 'carrom' | 'teen_patti' | 'snakes' | 'four_row'
  | 'crash' | 'slots' | 'chicken_road' | 'plinko' | 'fishing'
  | 'dice' | 'coin_toss' | 'wheel' | 'keno' | 'limbo' | 'roulette' | 'dragon_tiger' | 'andar_bahar' | 'hilo' | 'mines'

export const MULTIPLAYER_GAMES: readonly GameId[] = ['ludo', 'carrom', 'teen_patti', 'snakes', 'four_row']
export const INSTANT_GAMES: readonly GameId[] = [
  'crash', 'slots', 'chicken_road', 'plinko', 'fishing',
  'dice', 'coin_toss', 'wheel', 'keno', 'limbo', 'roulette', 'dragon_tiger', 'andar_bahar', 'hilo', 'mines',
]
export const ALL_GAMES: readonly GameId[] = [...MULTIPLAYER_GAMES, ...INSTANT_GAMES]

export interface GameSettings {
  enabled: boolean
  maintenance: boolean
  entryOptions: number[]
  minEntry: number
  maxEntry: number
  platformFeePct: number
  modes: number[]
  turnSeconds: number
  waitMinutes: number
  tokensToWin: number
  [k: string]: unknown
}

export interface GamesConfig {
  enabled: boolean
  games: Record<GameId, GameSettings>
  limits: { maxEntryPerRound: number; dailyLossLimit: number }
}

const base = (over: Partial<GameSettings> = {}): GameSettings => ({
  enabled: false,
  maintenance: false,
  entryOptions: [10, 50, 100, 500, 1000],
  minEntry: 10,
  maxEntry: 10_000,
  platformFeePct: 25,
  modes: [2, 4],
  turnSeconds: 30,
  waitMinutes: 10,
  tokensToWin: 4,
  ...over,
})

/** The shipped defaults: every game present and OFF. */
export function defaultGamesConfig(): GamesConfig {
  return {
    enabled: false,
    games: {
      // The owner's example: 100 + 100 → winner 150, Zipper 50 (25% of the pool).
      ludo: base({ modes: [2, 4, 6], platformFeePct: 25, turnSeconds: 30, tokensToWin: 4 }),
      carrom: base({ modes: [2, 4], platformFeePct: 25, turnSeconds: 45, targetPoints: 160, shotsPerPlayer: 25 }),
      teen_patti: base({ modes: [2, 3, 4, 5, 6], platformFeePct: 10, turnSeconds: 30, bootAmount: 10, maxBlinds: 4, potLimitX: 128 }),
      crash: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3, maxMultiplier: 1000 }),
      slots: base({ entryOptions: [10, 20, 50, 100, 200, 500], theme: 'mela' }),
      chicken_road: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3, lanes: 20 }),
      plinko: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, rows: [8, 12, 16] }),
      fishing: base({ entryOptions: [10, 20, 50, 100, 200], houseEdgePct: 4 }),
      // Friendly matches, second set.
      snakes: base({ modes: [2, 3, 4], platformFeePct: 25, turnSeconds: 20 }),
      four_row: base({ modes: [2], platformFeePct: 25, turnSeconds: 30 }),
      // Quick games, second set: any entry between min and max; the house edge sets every table (moreMath.ts).
      dice: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3 }),
      coin_toss: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3 }),
      wheel: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3 }),
      keno: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3 }),
      limbo: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3 }),
      // At the zero's own 2.70 % the table is the familiar 36× / 3× / 2×.
      roulette: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 2.7 }),
      // At 2.94 % Dragon or Tiger pays exactly 2× and a tie returns half.
      dragon_tiger: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 2.94 }),
      andar_bahar: base({ entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3 }),
      hilo: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3 }),
      mines: base({ entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3 }),
    },
    limits: { maxEntryPerRound: 100_000, dailyLossLimit: 0 },
  }
}

function num(v: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function wholeList(v: unknown, fallback: number[], min = 1, max = 10_000_000): number[] {
  if (!Array.isArray(v)) return fallback
  const out = v.map((x) => Math.trunc(Number(x))).filter((x) => Number.isFinite(x) && x >= min && x <= max)
  return Array.from(new Set(out)).sort((a, b) => a - b)
}

/**
 * Merge a stored document over the defaults. Everything is clamped: a fee of 250% or a negative entry typed into
 * the CRM is not obeyed — it falls back to the nearest sane value — because a bad save must not let a game pay
 * out more than it took in, or take what nobody agreed to.
 */
export function mergeGamesConfig(raw: Record<string, unknown> | undefined): GamesConfig {
  const d = defaultGamesConfig()
  if (!raw || typeof raw !== 'object') return d
  const games = (raw.games && typeof raw.games === 'object' ? raw.games : {}) as Record<string, Record<string, unknown>>
  const out: GamesConfig = {
    enabled: raw.enabled === true,
    games: { ...d.games },
    limits: {
      maxEntryPerRound: Math.trunc(num((raw.limits as Record<string, unknown> | undefined)?.maxEntryPerRound,
        d.limits.maxEntryPerRound, 1, 10_000_000)),
      dailyLossLimit: Math.trunc(num((raw.limits as Record<string, unknown> | undefined)?.dailyLossLimit,
        d.limits.dailyLossLimit, 0, 100_000_000)),
    },
  }
  for (const id of ALL_GAMES) {
    const dg = d.games[id]
    const g = games[id] && typeof games[id] === 'object' ? games[id] : {}
    const merged: GameSettings = { ...dg, ...g } as GameSettings
    merged.enabled = g.enabled === true
    merged.maintenance = g.maintenance === true
    merged.entryOptions = wholeList(g.entryOptions, dg.entryOptions)
    merged.minEntry = Math.trunc(num(g.minEntry, dg.minEntry, 1, 10_000_000))
    merged.maxEntry = Math.trunc(num(g.maxEntry, dg.maxEntry, merged.minEntry, 10_000_000))
    merged.platformFeePct = num(g.platformFeePct, dg.platformFeePct, 0, 50)
    merged.modes = wholeList(g.modes, dg.modes, 2, 6)
    merged.turnSeconds = Math.trunc(num(g.turnSeconds, dg.turnSeconds, 10, 120))
    merged.waitMinutes = Math.trunc(num(g.waitMinutes, dg.waitMinutes, 1, 60))
    merged.tokensToWin = Math.trunc(num(g.tokensToWin, dg.tokensToWin, 1, 4))
    out.games[id] = merged
  }
  return out
}

export const GAME_DISABLED = 'GAME_DISABLED'
export const GAME_MAINTENANCE = 'GAME_MAINTENANCE'
export const INSUFFICIENT_DIAMONDS = 'INSUFFICIENT_DIAMONDS'
export const BAD_ENTRY = 'BAD_ENTRY'

/** Refuse unless this game is switched on, and not closed for maintenance (new entries only). */
export function requireGameOpen(cfg: GamesConfig, gameId: GameId, opts: { forNewEntry: boolean } = { forNewEntry: true }): GameSettings {
  const g = cfg.games[gameId]
  if (!cfg.enabled || !g || !g.enabled) {
    throw new functions.https.HttpsError('failed-precondition', 'This game is not available right now.', { code: GAME_DISABLED })
  }
  if (opts.forNewEntry && g.maintenance) {
    throw new functions.https.HttpsError('unavailable', 'This game is closed for maintenance. Try again later.', { code: GAME_MAINTENANCE })
  }
  return g
}

/** An entry amount this game accepts: one of its options when it lists them, else within min…max. */
export function validEntry(g: GameSettings, cfg: GamesConfig, raw: unknown): number {
  const entry = Math.trunc(Number(raw))
  const ok = Number.isFinite(entry) && entry > 0 && entry <= cfg.limits.maxEntryPerRound
    && (g.entryOptions.length > 0 ? g.entryOptions.includes(entry) : entry >= g.minEntry && entry <= g.maxEntry)
  if (!ok) {
    const allowed = g.entryOptions.length > 0 ? g.entryOptions.join(', ') : `${g.minEntry}–${g.maxEntry}`
    throw new functions.https.HttpsError('invalid-argument', `Choose an entry of ${allowed} diamonds.`, { code: BAD_ENTRY })
  }
  return entry
}

/** What the catalogue screen may show: only switched-on games, and only the fields a player needs. */
export function publicCatalogue(cfg: GamesConfig): Array<Record<string, unknown>> {
  if (!cfg.enabled) return []
  return ALL_GAMES.filter((id) => cfg.games[id].enabled).map((id) => {
    const g = cfg.games[id]
    return {
      gameId: id,
      kind: MULTIPLAYER_GAMES.includes(id) ? 'multiplayer' : 'instant',
      maintenance: g.maintenance,
      entryOptions: g.entryOptions,
      minEntry: g.minEntry,
      maxEntry: g.maxEntry,
      platformFeePct: g.platformFeePct,
      modes: g.modes,
      turnSeconds: g.turnSeconds,
      // The return to player is shown to players: (100 − edge) %. Multiplayer games take the table fee instead.
      ...(MULTIPLAYER_GAMES.includes(id) ? {} : { houseEdgePct: Number.isFinite(Number(g.houseEdgePct)) ? Number(g.houseEdgePct) : 3 }),
    }
  })
}
