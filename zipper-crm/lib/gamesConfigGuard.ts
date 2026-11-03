/**
 * Games settings (B6, 3 Nov 2026) — pure, so it is tested without Firestore (`gamesConfigGuard.spec.ts`).
 *
 * The shape of `appConfig/games`, which the game functions read on every action
 * (functions/src/games/config.ts — `mergeGamesConfig` clamps the same way on the server, so a bad save here can
 * never make a game pay more than it takes in). Every game defaults to OFF: nothing is playable until the Owner
 * switches it on. Writing the document is the Owner's alone (firestore.rules E4).
 */

export const GAME_IDS = [
  'ludo', 'carrom', 'teen_patti', 'snakes', 'four_row',
  'crash', 'slots', 'chicken_road', 'plinko', 'fishing',
  'dice', 'coin_toss', 'wheel', 'keno', 'limbo', 'roulette', 'dragon_tiger', 'andar_bahar', 'hilo', 'mines',
] as const
export type GameId = (typeof GAME_IDS)[number]

export const GAME_LABELS: Record<GameId, string> = {
  ludo: 'Ludo', carrom: 'Carrom', teen_patti: 'Teen Patti', snakes: 'Snakes & Ladders', four_row: 'Four in a Row',
  crash: 'Zip Flight (crash)', slots: 'Mela Reels (slots)', chicken_road: 'Lane Hopper (chicken road)',
  plinko: 'Peg Drop (plinko)', fishing: 'Lucky Catch (fishing)',
  dice: 'Lucky Dice', coin_toss: 'Toss Up (coin)', wheel: 'Fortune Wheel', keno: 'Number Draw (keno)',
  limbo: 'Sky High (limbo)', roulette: 'Roulette', dragon_tiger: 'Dragon Tiger', andar_bahar: 'Andar Bahar',
  hilo: 'Higher or Lower', mines: 'Gem Field (mines)',
}

export const MULTIPLAYER: readonly GameId[] = ['ludo', 'carrom', 'teen_patti', 'snakes', 'four_row']

/** The most players each table seats (functions/src/games/matches.ts MAX_PLAYERS). */
export const MAX_PLAYERS: Partial<Record<GameId, number>> = { ludo: 6, teen_patti: 6, carrom: 4, snakes: 4, four_row: 2 }

/** Game-specific settings, each with its range and default — clamped here exactly as the server clamps them. */
export const GAME_EXTRAS: Partial<Record<GameId, Array<{ key: ExtraKey; label: string; min: number; max: number; def: number }>>> = {
  ludo: [{ key: 'tokensToWin', label: 'Tokens home to win', min: 1, max: 4, def: 4 }],
  teen_patti: [{ key: 'potLimitX', label: 'Pot limit (× boot)', min: 8, max: 1024, def: 128 }],
  carrom: [
    { key: 'targetPoints', label: 'Points to win', min: 40, max: 320, def: 160 },
    { key: 'shotsPerPlayer', label: 'Shots per player', min: 5, max: 60, def: 25 },
  ],
}
export type ExtraKey = 'tokensToWin' | 'potLimitX' | 'targetPoints' | 'shotsPerPlayer'

export interface GameSettings {
  enabled: boolean
  maintenance: boolean
  entryOptions: number[]
  minEntry: number
  maxEntry: number
  platformFeePct: number
  modes: number[]
  turnSeconds: number
  houseEdgePct: number
  /** Minutes a table waits to fill before every entry is refunded. */
  waitMinutes: number
  tokensToWin?: number
  potLimitX?: number
  targetPoints?: number
  shotsPerPlayer?: number
}

export interface GamesConfig {
  enabled: boolean
  games: Record<GameId, GameSettings>
  /**
   * The most one entry or stake may be, in any game; and (B6, 4 Nov 2026) the most a player may lose at games in one
   * IST day, net of wins and refunds — 0 is no limit. The server refuses a new entry or stake past it.
   */
  limits: { maxEntryPerRound: number; dailyLossLimit: number }
}

function base(over: Partial<GameSettings> = {}): GameSettings {
  return {
    enabled: false, maintenance: false, entryOptions: [10, 50, 100, 500, 1000], minEntry: 10, maxEntry: 10_000,
    platformFeePct: 25, modes: [2, 4], turnSeconds: 30, houseEdgePct: 3, waitMinutes: 10, ...over,
  }
}

export function defaultGamesConfig(): GamesConfig {
  return {
    enabled: false,
    games: {
      ludo: base({ modes: [2, 4, 6], tokensToWin: 4 }),
      carrom: base({ turnSeconds: 45, targetPoints: 160, shotsPerPlayer: 25 }),
      teen_patti: base({ modes: [2, 3, 4, 5, 6], platformFeePct: 10, potLimitX: 128 }),
      crash: base({ entryOptions: [], houseEdgePct: 3 }),
      slots: base({ entryOptions: [10, 20, 50, 100, 200, 500], houseEdgePct: 4 }),
      chicken_road: base({ entryOptions: [], maxEntry: 5000 }),
      plinko: base({ entryOptions: [], maxEntry: 5000 }),
      fishing: base({ entryOptions: [10, 20, 50, 100, 200], houseEdgePct: 4 }),
      snakes: base({ modes: [2, 3, 4], turnSeconds: 20 }),
      four_row: base({ modes: [2] }),
      dice: base({ entryOptions: [] }),
      coin_toss: base({ entryOptions: [] }),
      wheel: base({ entryOptions: [], maxEntry: 5000 }),
      keno: base({ entryOptions: [], maxEntry: 5000 }),
      limbo: base({ entryOptions: [] }),
      roulette: base({ entryOptions: [], houseEdgePct: 2.7 }),
      dragon_tiger: base({ entryOptions: [], houseEdgePct: 2.94 }),
      andar_bahar: base({ entryOptions: [] }),
      hilo: base({ entryOptions: [], maxEntry: 5000 }),
      mines: base({ entryOptions: [], maxEntry: 5000 }),
    },
    limits: { maxEntryPerRound: 100_000, dailyLossLimit: 0 },
  }
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

function wholeList(v: unknown, fallback: number[], lo: number, hi: number): number[] {
  if (!Array.isArray(v)) return fallback
  const out = v.map((x) => Math.trunc(Number(x))).filter((x) => Number.isFinite(x) && x >= lo && x <= hi)
  return Array.from(new Set(out)).sort((a, b) => a - b)
}

/** "10, 50, 100" → [10, 50, 100]; rubbish dropped. */
export function parseNumberList(text: string): number[] {
  return text.split(/[\s,]+/).map((x) => Math.trunc(Number(x))).filter((x) => Number.isFinite(x) && x > 0)
}

/** The stored document read over the defaults, clamped exactly as the server clamps it. */
export function mergeGamesConfig(raw: unknown): GamesConfig {
  const d = defaultGamesConfig()
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const games = (r.games && typeof r.games === 'object' ? r.games : {}) as Record<string, Record<string, unknown>>
  const limits = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>
  const out: GamesConfig = {
    enabled: r.enabled === true,
    games: { ...d.games },
    limits: {
      maxEntryPerRound: Math.trunc(clamp(limits.maxEntryPerRound, 1, 10_000_000, d.limits.maxEntryPerRound)),
      dailyLossLimit: Math.trunc(clamp(limits.dailyLossLimit, 0, 100_000_000, d.limits.dailyLossLimit)),
    },
  }
  for (const id of GAME_IDS) {
    const g = games[id] && typeof games[id] === 'object' ? games[id] : {}
    const dg = d.games[id]
    const minEntry = Math.trunc(clamp(g.minEntry, 1, 10_000_000, dg.minEntry))
    out.games[id] = {
      enabled: g.enabled === true,
      maintenance: g.maintenance === true,
      entryOptions: wholeList(g.entryOptions, dg.entryOptions, 1, 10_000_000),
      minEntry,
      maxEntry: Math.trunc(clamp(g.maxEntry, minEntry, 10_000_000, Math.max(minEntry, dg.maxEntry))),
      platformFeePct: clamp(g.platformFeePct, 0, 50, dg.platformFeePct),
      modes: wholeList(g.modes, dg.modes, 2, 6),
      turnSeconds: Math.trunc(clamp(g.turnSeconds, 10, 120, dg.turnSeconds)),
      houseEdgePct: clamp(g.houseEdgePct, 0, 20, dg.houseEdgePct),
      waitMinutes: Math.trunc(clamp(g.waitMinutes, 1, 60, dg.waitMinutes)),
    }
    for (const x of GAME_EXTRAS[id] ?? []) {
      out.games[id][x.key] = Math.trunc(clamp(g[x.key], x.min, x.max, x.def))
    }
  }
  return out
}

/** Problems that block a save — said in words, before anything is written. */
export function gamesConfigProblems(cfg: GamesConfig): string[] {
  const out: string[] = []
  for (const id of GAME_IDS) {
    const g = cfg.games[id]
    const name = GAME_LABELS[id]
    if (MULTIPLAYER.includes(id)) {
      const most = MAX_PLAYERS[id] ?? 6
      if (g.entryOptions.length === 0) out.push(`${name}: list at least one entry amount.`)
      if (g.modes.length === 0) out.push(`${name}: choose at least one table size.`)
      if (g.modes.some((m) => m < 2 || m > most)) out.push(`${name}: tables are 2 to ${most} players.`)
    }
    if (g.entryOptions.length === 0 && g.minEntry > g.maxEntry) out.push(`${name}: the minimum entry is above the maximum.`)
  }
  return out
}

/** What the winner of a full table receives, as the server splits it (functions/src/games/ledger.ts splitPool). */
export function winnerGets(entry: number, players: number, feePct: number): { pool: number; fee: number; winner: number } {
  const pool = Math.max(0, Math.trunc(entry)) * Math.max(1, Math.trunc(players))
  const fee = Math.round((pool * Math.min(50, Math.max(0, feePct))) / 100)
  return { pool, fee, winner: pool - fee }
}
