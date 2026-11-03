/**
 * GAMES — every diamond a game moves, with a row on both sides (B3, 3 Nov 2026).
 *
 * The rule of this codebase holds here too: no client writes a balance, and every movement writes a ledger row. A
 * game moves diamonds in exactly these ways, each with its own kind:
 *
 *   entry    a player's entry into a multiplayer match (held by the match until it ends)
 *   refund   an entry returned (match cancelled before it started, or abandoned by the server)
 *   payout   the pool, less the platform fee, to the winner(s)
 *   fee      Zipper's share of a finished match's pool
 *   stake    a player's stake on an instant round
 *   win      what an instant round paid back (0 for a loss — no row is written for nothing)
 *
 * Two rows per movement, written in the caller's transaction:
 *   * `users/{uid}/diamondTransactions/{rowId}` — the player's own history (the wallet screen streams it);
 *   * `gameLedger/{globalId}` — the business record the CRM reports and reconciles (server-only).
 * Both ids are deterministic, so a replayed settlement cannot write a second row: the same transaction that would
 * pay twice would collide on the id, and Firestore `create` semantics are not needed because the match/round state
 * machine already refuses the second settlement before any write.
 *
 * Arithmetic invariant, checked by `checkSettlement`: for a match, Σ entries = Σ payouts + fee (+ Σ refunds when
 * cancelled). Unexplained difference: zero, always.
 */

import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { INSUFFICIENT_DIAMONDS } from './config'

/** Refusal code: today's game losses would pass the Owner's daily loss limit (`appConfig/games.limits`). */
export const DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT'

/**
 * B6 (4 Nov 2026) — the daily loss limit, per player per IST day. Counters live on the user document as flat
 * fields (`gameDayKey`, `gameDayStaked`, `gameDayWon`), moved in the same transaction as the diamonds, so no extra
 * read is needed: the caller already read the user document.
 */
export interface DailyLoss {
  /** The Owner's limit in diamonds; 0 = no limit. */
  limit: number
  /** Today's IST day key, `yyyy-mm-dd`. */
  today: string
  /** What the user document says: its day key and that day's staked / won (refunds count as won). */
  dayKey: string
  staked: number
  won: number
}

/** The IST calendar day of [ms], `yyyy-mm-dd`. */
export function istDayKey(ms: number): string {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

/** The daily-loss state of a user, as read in this transaction. */
export function dailyLossOf(user: { get(field: string): unknown }, limit: number, nowMs: number): DailyLoss {
  return {
    limit: Math.max(0, Math.trunc(Number(limit) || 0)),
    today: istDayKey(nowMs),
    dayKey: String(user.get('gameDayKey') ?? ''),
    staked: Math.trunc(Number(user.get('gameDayStaked') ?? 0) || 0),
    won: Math.trunc(Number(user.get('gameDayWon') ?? 0) || 0),
  }
}

/** Pure — today's net loss so far (never negative), and whether [amount] more may be put in. */
export function dailyLossRoom(d: DailyLoss, amount: number): { netLoss: number; allowed: boolean } {
  const netLoss = d.dayKey === d.today ? Math.max(0, d.staked - d.won) : 0
  return { netLoss, allowed: d.limit <= 0 || netLoss + amount <= d.limit }
}

export type GameMoneyKind = 'entry' | 'refund' | 'payout' | 'fee' | 'stake' | 'win'

export interface GameMoneyContext {
  gameId: string
  matchId?: string
  roundId?: string
}

const inc = (n: number) => admin.firestore.FieldValue.increment(n)
const now = () => admin.firestore.FieldValue.serverTimestamp()

function db(): admin.firestore.Firestore {
  return admin.firestore()
}

function refOf(ctx: GameMoneyContext): string {
  const ref = ctx.matchId ?? ctx.roundId
  if (!ref) throw new Error('game money movement without a match or round')
  return ref
}

/** The player's history row id and the business ledger id for one movement. */
export function rowIds(ctx: GameMoneyContext, kind: GameMoneyKind, uid: string, seq?: string): { history: string; ledger: string } {
  const ref = refOf(ctx)
  // `seq` distinguishes several movements of one kind by one player in one match (Teen Patti's bets).
  const tail = seq ? `_${seq}` : ''
  return {
    history: `game_${ref}_${kind}${tail}`,
    ledger: kind === 'fee' ? `${ref}_fee` : `${ref}_${uid}_${kind}${tail}`,
  }
}

function label(gameName: string, kind: GameMoneyKind): string {
  switch (kind) {
    case 'entry': return `${gameName} — entry`
    case 'refund': return `${gameName} — entry returned`
    case 'payout': return `${gameName} — won`
    case 'stake': return `${gameName} — play`
    case 'win': return `${gameName} — won`
    default: return gameName
  }
}

export const GAME_NAMES: Record<string, string> = {
  ludo: 'Ludo', carrom: 'Carrom', teen_patti: 'Teen Patti', snakes: 'Snakes & Ladders', four_row: 'Four in a Row',
  crash: 'Zip Flight', slots: 'Mela Reels', chicken_road: 'Lane Hopper', plinko: 'Peg Drop', fishing: 'Lucky Catch',
  dice: 'Lucky Dice', coin_toss: 'Toss Up', wheel: 'Fortune Wheel', keno: 'Number Draw', limbo: 'Sky High',
  roulette: 'Roulette', dragon_tiger: 'Dragon Tiger', andar_bahar: 'Andar Bahar', hilo: 'Higher or Lower', mines: 'Gem Field',
}

/**
 * Take diamonds from a player (entry or stake). The caller has READ the user document in this transaction and
 * passes its balance; nothing here reads, so it can sit after the reads Firestore requires to come first.
 * Refuses — writing nothing — when the balance is short.
 */
export function debitPlayer(
  tx: admin.firestore.Transaction,
  userRef: admin.firestore.DocumentReference,
  balanceBefore: number,
  amount: number,
  kind: 'entry' | 'stake',
  ctx: GameMoneyContext,
  seq?: string,
  /** The daily loss limit to apply (a new entry or stake); omitted for bets inside a hand already joined. */
  daily?: DailyLoss,
): number {
  const amt = Math.trunc(amount)
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`debitPlayer: bad amount ${amount}`)
  const before = Math.trunc(Number(balanceBefore) || 0)
  if (before < amt) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `You need ${amt} diamonds for this. You have ${before}.`,
      { code: INSUFFICIENT_DIAMONDS, needed: amt, have: before },
    )
  }
  if (daily) {
    const room = dailyLossRoom(daily, amt)
    if (!room.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `You've reached today's game limit (${daily.limit} diamonds net). Games open again tomorrow.`,
        { code: DAILY_LOSS_LIMIT, limit: daily.limit, netLoss: room.netLoss },
      )
    }
  }
  const after = before - amt
  const ids = rowIds(ctx, kind, userRef.id, seq)
  // Flat fields, not a nested map: a dotted update path and a nested increment behave differently between
  // the SDK and the test fake, and these are read by the profile and the daily limit.
  const day = daily && daily.dayKey !== daily.today
    ? { gameDayKey: daily.today, gameDayStaked: amt, gameDayWon: 0 }
    : { gameDayStaked: inc(amt) }
  tx.update(userRef, { diamonds: inc(-amt), gameStaked: inc(amt), gameLastPlayedAt: now(), ...day })
  tx.set(userRef.collection('diamondTransactions').doc(ids.history), {
    type: 'debit',
    amount: amt,
    balanceAfter: after,
    reason: `game_${kind}`,
    reasonLabel: label(GAME_NAMES[ctx.gameId] ?? ctx.gameId, kind),
    context: 'game',
    gameId: ctx.gameId,
    ...(ctx.matchId ? { matchId: ctx.matchId } : {}),
    ...(ctx.roundId ? { roundId: ctx.roundId } : {}),
    timestamp: now(),
  })
  tx.set(db().collection('gameLedger').doc(ids.ledger), {
    kind, gameId: ctx.gameId, uid: userRef.id, diamonds: amt,
    ...(ctx.matchId ? { matchId: ctx.matchId } : {}),
    ...(ctx.roundId ? { roundId: ctx.roundId } : {}),
    createdAt: now(),
  })
  return after
}

/** Give diamonds to a player (refund, payout or win). `balanceBefore` as read in this transaction. */
export function creditPlayer(
  tx: admin.firestore.Transaction,
  userRef: admin.firestore.DocumentReference,
  balanceBefore: number,
  amount: number,
  kind: 'refund' | 'payout' | 'win',
  ctx: GameMoneyContext,
): number {
  const amt = Math.trunc(amount)
  if (!Number.isFinite(amt) || amt < 0) throw new Error(`creditPlayer: bad amount ${amount}`)
  const before = Math.trunc(Number(balanceBefore) || 0)
  if (amt === 0) return before
  const after = before + amt
  const ids = rowIds(ctx, kind, userRef.id)
  const stat = kind === 'refund' ? 'gameRefunded' : 'gameWon'
  // The day's "won" also takes refunds: an entry handed back is not a loss (see DailyLoss).
  tx.update(userRef, { diamonds: inc(amt), [stat]: inc(amt), gameDayWon: inc(amt) })
  tx.set(userRef.collection('diamondTransactions').doc(ids.history), {
    type: 'credit',
    amount: amt,
    balanceAfter: after,
    reason: `game_${kind}`,
    reasonLabel: label(GAME_NAMES[ctx.gameId] ?? ctx.gameId, kind),
    context: 'game',
    gameId: ctx.gameId,
    ...(ctx.matchId ? { matchId: ctx.matchId } : {}),
    ...(ctx.roundId ? { roundId: ctx.roundId } : {}),
    timestamp: now(),
  })
  tx.set(db().collection('gameLedger').doc(ids.ledger), {
    kind, gameId: ctx.gameId, uid: userRef.id, diamonds: amt,
    ...(ctx.matchId ? { matchId: ctx.matchId } : {}),
    ...(ctx.roundId ? { roundId: ctx.roundId } : {}),
    createdAt: now(),
  })
  return after
}

/** Zipper's fee from a finished match — a business ledger row only (no player's balance moves). */
export function recordFee(tx: admin.firestore.Transaction, amount: number, ctx: GameMoneyContext): void {
  const amt = Math.trunc(amount)
  if (amt <= 0) return
  tx.set(db().collection('gameLedger').doc(rowIds(ctx, 'fee', '').ledger), {
    kind: 'fee', gameId: ctx.gameId, diamonds: amt,
    ...(ctx.matchId ? { matchId: ctx.matchId } : {}),
    createdAt: now(),
  })
}

/**
 * Split a pool: the platform fee is `round(pool × pct / 100)`, the rest goes to the winners in equal shares, any
 * indivisible remainder to the platform — so the parts always add back to the pool exactly.
 *
 *   pool 200, 25 %, 1 winner  → fee 50, [150]                (the owner's Ludo example)
 *   pool 400, 25 %, 1 winner  → fee 100, [300]
 *   pool 300, 10 %, 2 winners → fee 30, [135, 135]
 *   pool 101, 25 %, 2 winners → fee 25 + 0 remainder, [38, 38] → fee 25, remainder 0 … see the tests
 */
export function splitPool(pool: number, feePct: number, winners: number): { fee: number; shares: number[] } {
  const p = Math.max(0, Math.trunc(pool))
  const pct = Math.min(50, Math.max(0, Number(feePct) || 0))
  const w = Math.max(1, Math.trunc(winners))
  let fee = Math.round((p * pct) / 100)
  const distributable = p - fee
  const share = Math.floor(distributable / w)
  const remainder = distributable - share * w
  fee += remainder
  return { fee, shares: Array.from({ length: w }, () => share) }
}

/** The zero-difference check every settlement runs before it writes: entries = payouts + fee + refunds. */
export function checkSettlement(entries: number[], payouts: number[], fee: number, refunds: number[] = []): void {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const diff = sum(entries) - (sum(payouts) + fee + sum(refunds))
  if (diff !== 0) {
    throw new Error(`game settlement does not balance: entries ${sum(entries)} ≠ payouts ${sum(payouts)} + fee ${fee} + refunds ${sum(refunds)} (difference ${diff})`)
  }
}
