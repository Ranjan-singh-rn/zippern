/**
 * GAMES — multiplayer matches: lobby, entry escrow, turns, settlement (B4, 3 Nov 2026).
 *
 * The server owns every match. A client asks; the server decides what that costs, whose turn it is, what the die
 * shows and who won, and moves the diamonds. Nothing a phone sends is trusted except WHICH token it wants to move.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 *
 *   createGameMatch / quickGameMatch   the creator pays the entry (held by the match) and takes seat 1
 *   joinGameMatch                      each joiner pays the same entry; the match starts the moment it is full
 *   ludoAction (roll / move)           the player whose turn it is acts; `step` names the state they saw, so a
 *                                      double tap or a replayed request changes nothing
 *   claimGameTimeout                   anyone in the match, once the turn's deadline has passed: the server plays
 *                                      the turn for the absent player (3 in a row forfeits them)
 *   leaveGameMatch                     before the start: the entry is refunded; after: the player forfeits
 *   sweepGameMatches (every minute)    refunds matches that never filled, plays overdue turns
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 *
 * Entries are debited into the match (`pool`). A finished match pays the pool less the platform fee to the
 * winner, and records the fee; a cancelled match refunds every entry. `checkSettlement` proves Σ entries =
 * Σ payouts + fee + Σ refunds before anything is written. The owner's example — 100 + 100, winner 150, Zipper 50 —
 * is `splitPool(200, 25, 1)`.
 *
 * ── Fairness ────────────────────────────────────────────────────────────────
 *
 * Each match has a secret seed (server-only, `gameMatches/{id}/private/meta`) committed by its SHA-256 on the match
 * at creation and revealed at the end; every die is `HMAC(seed, "<matchId>:roll:<turn>:<step>")`.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
import { assertActiveSession, restrictionVerdict, ACCOUNT_RESTRICTED } from '../mobileSession'
import {
  type GameId, type GamesConfig, type GameSettings, MULTIPLAYER_GAMES,
  mergeGamesConfig, requireGameOpen, validEntry, publicCatalogue,
} from './config'
import { commitOf, drawInt, newSeed, rollDie } from './rng'
import { checkSettlement, creditPlayer, dailyLossOf, debitPlayer, recordFee, splitPool } from './ledger'
import * as Ludo from './ludoEngine'
import * as TP from './teenPattiEngine'
import * as CR from './carromEngine'
import * as BG from './boardGames'

const REGION = 'asia-south1'
const MATCHES = 'gameMatches'

function db(): admin.firestore.Firestore {
  return admin.firestore()
}

function requireAuth(context: functions.https.CallableContext): string {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  return uid
}

const configRef = () => db().collection('appConfig').doc('games')
const matchRef = (id: string) => db().collection(MATCHES).doc(id)
const metaRef = (id: string) => matchRef(id).collection('private').doc('meta')
const idemRef = (uid: string, key: string) => db().collection('gameIdempotency').doc(`${uid}_${key}`)

function idemKey(raw: unknown): string {
  const key = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
    throw new functions.https.HttpsError('invalid-argument', 'This request could not be read. Update the app and try again.')
  }
  return key
}

function requireMultiplayer(raw: unknown): GameId {
  const id = String(raw ?? '') as GameId
  if (!MULTIPLAYER_GAMES.includes(id)) throw new functions.https.HttpsError('invalid-argument', 'Unknown game.')
  return id
}

/** Only games whose rules engine is built may be played. Carrom and Teen Patti join this list as they land. */
const PLAYABLE: readonly GameId[] = ['ludo', 'teen_patti', 'carrom', 'snakes', 'four_row']
/** The most players a game's table holds (the config's `modes` may list more; the table cannot seat them). */
const MAX_PLAYERS: Partial<Record<GameId, number>> = { ludo: 6, teen_patti: 6, carrom: 4, snakes: 4, four_row: 2 }

function requirePlayable(id: GameId): void {
  if (!PLAYABLE.includes(id)) {
    throw new functions.https.HttpsError('failed-precondition', 'This game is coming soon.', { code: 'GAME_NOT_READY' })
  }
}

function playerOk(snap: admin.firestore.DocumentSnapshot): void {
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Finish setting up your profile first.')
  const restricted = restrictionVerdict((f) => snap.get(f))
  if (restricted) {
    throw new functions.https.HttpsError('permission-denied', 'This account cannot play right now.', { code: ACCOUNT_RESTRICTED, state: restricted })
  }
}

function seatOf(snap: admin.firestore.DocumentSnapshot) {
  return {
    uid: snap.id,
    name: String(snap.get('displayName') ?? snap.get('name') ?? '').trim() || 'Player',
    photoUrl: String(snap.get('photoUrl') ?? ''),
    level: Number(snap.get('level') ?? 0) || 0,
  }
}

export interface Seat { uid: string; name: string; photoUrl: string; level: number }

export interface MatchDoc {
  gameId: GameId
  capacity: number
  entry: number
  feePct: number
  pool: number
  visibility: 'public' | 'private'
  status: 'waiting' | 'playing' | 'finished' | 'cancelled'
  seats: Seat[]
  playerUids: string[]
  createdBy: string
  commit: string
  turnSeconds: number
  state: Ludo.StoredLudoState | TP.TeenPattiState | CR.CarromState | BG.SnakesState | BG.FourRowState | null
  deadlineMs: number | null
  winners?: string[]
  payouts?: Record<string, number>
  fee?: number
  seed?: string
  rematchOf?: string
  lastEvent?: unknown
  [k: string]: unknown
}

function inviteCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

async function readConfig(tx: admin.firestore.Transaction): Promise<GamesConfig> {
  const snap = await tx.get(configRef())
  return mergeGamesConfig(snap.exists ? (snap.data() as Record<string, unknown>) : undefined)
}

function startState(m: MatchDoc, seed: string, matchId: string, g: GameSettings, nowMs: number):
  { state: Ludo.StoredLudoState | TP.TeenPattiState | CR.CarromState | BG.SnakesState | BG.FourRowState; deadlineMs: number; meta?: Record<string, unknown> } {
  const players = m.seats.length
  const first = drawInt(seed, `${matchId}:first`, players)
  if (m.gameId === 'snakes') return { state: BG.newSnakes(players, first), deadlineMs: nowMs + m.turnSeconds * 1000 }
  if (m.gameId === 'four_row') return { state: BG.newFourRow(first), deadlineMs: nowMs + m.turnSeconds * 1000 }
  if (m.gameId === 'carrom') {
    const target = Math.max(40, Math.min(320, Math.trunc(Number(g.targetPoints ?? 160)) || 160))
    const shots = Math.max(5, Math.min(60, Math.trunc(Number(g.shotsPerPlayer ?? 25)) || 25))
    return { state: CR.newCarrom(players, first, target, shots), deadlineMs: nowMs + m.turnSeconds * 1000 }
  }
  if (m.gameId === 'teen_patti') {
    const hands = TP.deal(seed, matchId, players)
    const potLimitX = Math.max(8, Math.min(1024, Math.trunc(Number(g.potLimitX ?? 128)) || 128))
    const state = TP.newTeenPatti(players, m.entry, potLimitX, first)
    // The hands never touch the readable match document until the game is over.
    return { state, deadlineMs: nowMs + m.turnSeconds * 1000, meta: { hands: hands.map((h) => ({ cards: h })) } }
  }
  const state = Ludo.toStored(Ludo.newLudo(players, g.tokensToWin, first))
  return { state, deadlineMs: nowMs + m.turnSeconds * 1000 }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Catalogue
// ══════════════════════════════════════════════════════════════════════════════

export const gameCatalog = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context)
  const [cfgSnap, userSnap] = await Promise.all([configRef().get(), db().collection('users').doc(uid).get()])
  const cfg = mergeGamesConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
  return {
    games: publicCatalogue(cfg).map((g) => ({ ...g, playable: PLAYABLE.includes(g.gameId as GameId) || !MULTIPLAYER_GAMES.includes(g.gameId as GameId) })),
    diamonds: Number(userSnap.get('diamonds') ?? 0) || 0,
  }
})

// ══════════════════════════════════════════════════════════════════════════════
//  Create / join / quick match
// ══════════════════════════════════════════════════════════════════════════════

interface CreateArgs { gameId?: string; players?: number; entry?: number; visibility?: string; idempotencyKey?: string }

async function createIn(
  tx: admin.firestore.Transaction, uid: string, a: { gameId: GameId; players: number; entry: number; visibility: 'public' | 'private'; rematchOf?: string },
  cfg: GamesConfig, userSnap: admin.firestore.DocumentSnapshot, nowMs: number,
): Promise<{ matchId: string; inviteCode?: string; match: MatchDoc }> {
  const g = requireGameOpen(cfg, a.gameId)
  const most = MAX_PLAYERS[a.gameId] ?? 6
  if (!g.modes.includes(a.players) || a.players > most) {
    throw new functions.https.HttpsError('invalid-argument', `Choose ${g.modes.filter((n) => n <= most).join(', ')} players.`)
  }
  const entry = validEntry(g, cfg, a.entry)
  const ref = db().collection(MATCHES).doc()
  const seed = newSeed()
  const code = a.visibility === 'private' ? inviteCode() : undefined
  const userRef = db().collection('users').doc(uid)
  debitPlayer(tx, userRef, Number(userSnap.get('diamonds') ?? 0), entry, 'entry', { gameId: a.gameId, matchId: ref.id },
    undefined, dailyLossOf(userSnap, cfg.limits.dailyLossLimit, nowMs))
  const match: MatchDoc = {
    gameId: a.gameId,
    capacity: a.players,
    entry,
    feePct: g.platformFeePct,
    pool: entry,
    visibility: a.visibility,
    status: 'waiting',
    seats: [seatOf(userSnap)],
    playerUids: [uid],
    createdBy: uid,
    commit: commitOf(seed),
    turnSeconds: g.turnSeconds,
    state: null,
    deadlineMs: null,
    waitUntilMs: nowMs + g.waitMinutes * 60_000,
    createdAtMs: nowMs,
    ...(a.rematchOf ? { rematchOf: a.rematchOf } : {}),
  }
  tx.set(ref, { ...match, createdAt: admin.firestore.FieldValue.serverTimestamp() })
  tx.set(metaRef(ref.id), { seed, ...(code ? { inviteCode: code } : {}), rematchPlayers: [] })
  return { matchId: ref.id, inviteCode: code, match }
}

export const createGameMatch = functions.region(REGION).https.onCall(async (data: CreateArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'createGameMatch', context.auth?.token)
  const gameId = requireMultiplayer(data?.gameId)
  requirePlayable(gameId)
  const key = idemKey(data?.idempotencyKey)
  const visibility = data?.visibility === 'private' ? 'private' : 'public'
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [idem, cfg, userSnap] = await Promise.all([
      tx.get(idemRef(uid, key)), readConfig(tx), tx.get(db().collection('users').doc(uid)),
    ])
    if (idem.exists) return { ...idem.data(), replayed: true }
    playerOk(userSnap)
    const made = await createIn(tx, uid, { gameId, players: Math.trunc(Number(data?.players)), entry: Number(data?.entry), visibility }, cfg, userSnap, nowMs)
    const result = { matchId: made.matchId, ...(made.inviteCode ? { inviteCode: made.inviteCode } : {}), replayed: false }
    tx.set(idemRef(uid, key), { ...result, op: 'create', createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return result
  })
})

interface JoinArgs { matchId?: string; inviteCode?: string; idempotencyKey?: string }

/** Seat `uid` in an open match (the transaction has read everything it needs). Starts it if this fills it. */
function seatIn(
  tx: admin.firestore.Transaction, uid: string, matchId: string, m: MatchDoc, cfg: GamesConfig,
  userSnap: admin.firestore.DocumentSnapshot, meta: Record<string, unknown>, nowMs: number,
): { started: boolean } {
  const g = requireGameOpen(cfg, m.gameId)
  const userRef = db().collection('users').doc(uid)
  debitPlayer(tx, userRef, Number(userSnap.get('diamonds') ?? 0), m.entry, 'entry', { gameId: m.gameId, matchId },
    undefined, dailyLossOf(userSnap, cfg.limits.dailyLossLimit, nowMs))
  const seats = [...m.seats, seatOf(userSnap)]
  const update: Record<string, unknown> = {
    seats,
    playerUids: [...m.playerUids, uid],
    pool: m.pool + m.entry,
  }
  let started = false
  if (seats.length === m.capacity) {
    const st = startState({ ...m, seats }, String(meta.seed), matchId, g, nowMs)
    Object.assign(update, {
      status: 'playing', state: st.state, deadlineMs: st.deadlineMs,
      ...(m.gameId === 'teen_patti' ? { pool: (st.state as TP.TeenPattiState).pot } : {}),
      startedAtMs: nowMs, startedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    if (st.meta) tx.set(metaRef(matchId), st.meta, { merge: true })
    started = true
  }
  tx.update(matchRef(matchId), update)
  return { started }
}

export const joinGameMatch = functions.region(REGION).https.onCall(async (data: JoinArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'joinGameMatch', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const key = idemKey(data?.idempotencyKey)
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [idem, cfg, userSnap, mSnap, metaSnap] = await Promise.all([
      tx.get(idemRef(uid, key)), readConfig(tx), tx.get(db().collection('users').doc(uid)),
      tx.get(matchRef(matchId)), tx.get(metaRef(matchId)),
    ])
    if (idem.exists) return { ...idem.data(), replayed: true }
    if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    playerOk(userSnap)
    const m = mSnap.data() as MatchDoc
    if (m.playerUids.includes(uid)) return { matchId, already: true, replayed: false }
    if (m.status !== 'waiting') throw new functions.https.HttpsError('failed-precondition', 'This game has already started.')
    if (m.seats.length >= m.capacity) throw new functions.https.HttpsError('failed-precondition', 'This game is full.')
    const meta = (metaSnap.data() ?? {}) as Record<string, unknown>
    if (m.visibility === 'private') {
      const invited = Array.isArray(meta.rematchPlayers) && (meta.rematchPlayers as string[]).includes(uid)
      if (!invited && String(data?.inviteCode ?? '') !== String(meta.inviteCode ?? '')) {
        throw new functions.https.HttpsError('permission-denied', 'That invite code is not right.', { code: 'BAD_INVITE' })
      }
    }
    const { started } = seatIn(tx, uid, matchId, m, cfg, userSnap, meta, nowMs)
    const result = { matchId, started, replayed: false }
    tx.set(idemRef(uid, key), { ...result, op: 'join', createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return result
  })
})

/** Join the oldest open public match with the same game, size and entry — or open one. */
export const quickGameMatch = functions.region(REGION).https.onCall(async (data: CreateArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'quickGameMatch', context.auth?.token)
  const gameId = requireMultiplayer(data?.gameId)
  requirePlayable(gameId)
  const key = idemKey(data?.idempotencyKey)
  const players = Math.trunc(Number(data?.players))
  const entry = Math.trunc(Number(data?.entry))
  const candidates = await db().collection(MATCHES)
    .where('gameId', '==', gameId).where('status', '==', 'waiting').where('visibility', '==', 'public')
    .where('capacity', '==', players).where('entry', '==', entry)
    .orderBy('createdAtMs').limit(10).get()
  const nowMs = Date.now()
  for (const c of candidates.docs) {
    const d = c.data() as MatchDoc
    if (d.playerUids.includes(uid) || d.seats.length >= d.capacity) continue
    try {
      return await db().runTransaction(async (tx) => {
        const [idem, cfg, userSnap, mSnap, metaSnap] = await Promise.all([
          tx.get(idemRef(uid, key)), readConfig(tx), tx.get(db().collection('users').doc(uid)),
          tx.get(matchRef(c.id)), tx.get(metaRef(c.id)),
        ])
        if (idem.exists) return { ...idem.data(), replayed: true }
        playerOk(userSnap)
        const m = mSnap.data() as MatchDoc
        if (m.status !== 'waiting' || m.seats.length >= m.capacity || m.playerUids.includes(uid)) throw new Error('taken')
        const { started } = seatIn(tx, uid, c.id, m, cfg, userSnap, (metaSnap.data() ?? {}) as Record<string, unknown>, nowMs)
        const result = { matchId: c.id, started, created: false, replayed: false }
        tx.set(idemRef(uid, key), { ...result, op: 'quick', createdAt: admin.firestore.FieldValue.serverTimestamp() })
        return result
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'taken') continue
      throw err
    }
  }
  return db().runTransaction(async (tx) => {
    const [idem, cfg, userSnap] = await Promise.all([tx.get(idemRef(uid, key)), readConfig(tx), tx.get(db().collection('users').doc(uid))])
    if (idem.exists) return { ...idem.data(), replayed: true }
    playerOk(userSnap)
    const made = await createIn(tx, uid, { gameId, players, entry, visibility: 'public' }, cfg, userSnap, nowMs)
    const result = { matchId: made.matchId, started: false, created: true, replayed: false }
    tx.set(idemRef(uid, key), { ...result, op: 'quick', createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return result
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Settlement
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pay a finished match: the pool less the fee to the winner(s), the fee recorded, every player's history written.
 * `users` are the winners' snapshots, read in this transaction. Refuses — writing nothing — if the arithmetic
 * does not balance.
 */
function settleFinished(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, winnerUids: string[],
  winnerSnaps: Map<string, admin.firestore.DocumentSnapshot>, seed: string, extra: Record<string, unknown>,
  /** What each seat put in (Ludo: the entry; Teen Patti: boot + every bet). Must add up to the pool. */
  entries: number[] = m.seats.map(() => m.entry),
): Record<string, number> {
  const pool = entries.reduce((a, b) => a + b, 0)
  const { fee, shares } = splitPool(pool, m.feePct, winnerUids.length)
  checkSettlement(entries, shares, fee)
  const payouts: Record<string, number> = {}
  winnerUids.forEach((w, i) => {
    payouts[w] = shares[i]
    const snap = winnerSnaps.get(w)
    creditPlayer(tx, db().collection('users').doc(w), Number(snap?.get('diamonds') ?? 0), shares[i], 'payout', { gameId: m.gameId, matchId })
  })
  recordFee(tx, fee, { gameId: m.gameId, matchId })
  for (const s of m.seats) {
    const won = winnerUids.includes(s.uid)
    tx.set(db().collection('users').doc(s.uid).collection('gameHistory').doc(matchId), {
      gameId: m.gameId, matchId, result: won ? 'won' : 'lost', entry: entries[m.seats.indexOf(s)] ?? m.entry, payout: payouts[s.uid] ?? 0,
      players: m.capacity, at: admin.firestore.FieldValue.serverTimestamp(),
    })
  }
  tx.update(matchRef(matchId), {
    ...extra,
    status: 'finished',
    winners: winnerUids,
    payouts,
    fee,
    pool,
    seed,
    deadlineMs: null,
    finishedAtMs: Date.now(),
    finishedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return payouts
}

/** Refund every entry of a match that never started (or that the server had to abandon). */
function refundAll(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, snaps: Map<string, admin.firestore.DocumentSnapshot>,
  reason: string, seed: string,
): void {
  checkSettlement(m.seats.map(() => m.entry), [], 0, m.seats.map(() => m.entry))
  for (const s of m.seats) {
    creditPlayer(tx, db().collection('users').doc(s.uid), Number(snaps.get(s.uid)?.get('diamonds') ?? 0), m.entry, 'refund', { gameId: m.gameId, matchId })
    tx.set(db().collection('users').doc(s.uid).collection('gameHistory').doc(matchId), {
      gameId: m.gameId, matchId, result: 'refunded', entry: m.entry, payout: m.entry, players: m.capacity,
      reason, at: admin.firestore.FieldValue.serverTimestamp(),
    })
  }
  tx.update(matchRef(matchId), {
    status: 'cancelled', cancelReason: reason, seed, deadlineMs: null,
    finishedAtMs: Date.now(), finishedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

// ══════════════════════════════════════════════════════════════════════════════
//  Playing Ludo
// ══════════════════════════════════════════════════════════════════════════════

interface ActionArgs { matchId?: string; action?: string; token?: number; step?: number }

/**
 * Run one engine step against a match inside a transaction: reads the winner's wallet if the step ends the game
 * (reads before writes), then writes the new state or settles.
 */
async function commitLudoStep(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, seed: string,
  result: Ludo.StepResult, nowMs: number,
): Promise<{ finished: boolean; winners?: string[] }> {
  const s = result.state
  if (s.winner !== null) {
    const winnerUid = m.seats[s.winner].uid
    const snap = await tx.get(db().collection('users').doc(winnerUid))
    settleFinished(tx, matchId, m, [winnerUid], new Map([[winnerUid, snap]]), seed, { state: Ludo.toStored(s), lastEvent: result.event })
    return { finished: true, winners: [winnerUid] }
  }
  tx.update(matchRef(matchId), { state: Ludo.toStored(s), lastEvent: result.event, deadlineMs: nowMs + m.turnSeconds * 1000 })
  return { finished: false }
}

export const ludoAction = functions.region(REGION).https.onCall(async (data: ActionArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'ludoAction', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  const action = String(data?.action ?? '')
  if (!matchId || !['roll', 'move'].includes(action)) throw new functions.https.HttpsError('invalid-argument', 'Say what to do.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [mSnap, metaSnap] = await Promise.all([tx.get(matchRef(matchId)), tx.get(metaRef(matchId))])
    if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    const m = mSnap.data() as MatchDoc
    if (m.gameId !== 'ludo') throw new functions.https.HttpsError('invalid-argument', 'This is not a Ludo game.')
    if (m.status !== 'playing' || !m.state) throw new functions.https.HttpsError('failed-precondition', 'This game is not being played.')
    const s = Ludo.fromStored(m.state)
    const me = m.seats.findIndex((x) => x.uid === uid)
    if (me < 0) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
    // A tap on a state the player is no longer looking at — a double tap, a retry after a lost answer — does nothing.
    if (Number.isInteger(data?.step) && data!.step !== s.step) return { applied: false, stale: true, step: s.step }
    if (s.turn !== me) throw new functions.https.HttpsError('failed-precondition', 'It is not your turn.')
    const seed = String(metaSnap.get('seed') ?? '')
    let result: Ludo.StepResult
    try {
      if (action === 'roll') {
        if (s.roll !== null) throw new Error('ludo: a roll is waiting to be moved')
        const die = rollDie(seed, `${matchId}:roll:${s.turnNumber}:${s.step}`)
        result = Ludo.applyRoll(s, die)
      } else {
        result = Ludo.applyMove(s, Math.trunc(Number(data?.token)))
      }
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message.replace(/^ludo: /, '') : 'Not allowed.')
    }
    const out = await commitLudoStep(tx, matchId, m, seed, result, nowMs)
    return { applied: true, step: result.state.step, event: result.event, ...out }
  })
})

/** Anyone in the match, once the current turn is overdue: the server plays it for the absent player. */
export const claimGameTimeout = functions.region(REGION).https.onCall(async (data: { matchId?: string; step?: number }, context) => {
  const uid = requireAuth(context)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [mSnap, metaSnap] = await Promise.all([tx.get(matchRef(matchId)), tx.get(metaRef(matchId))])
    if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    const m = mSnap.data() as MatchDoc
    if (!m.playerUids.includes(uid)) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
    return timeoutIn(tx, matchId, m, String(metaSnap.get('seed') ?? ''), nowMs, data?.step)
  })
})

async function timeoutIn(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, seed: string, nowMs: number, step?: number,
): Promise<Record<string, unknown>> {
  if (m.status !== 'playing' || !m.state || m.deadlineMs == null) return { applied: false, reason: 'not_playing' }
  if (nowMs < m.deadlineMs) return { applied: false, reason: 'not_yet', deadlineMs: m.deadlineMs }
  if (Number.isInteger(step) && step !== m.state.step) return { applied: false, stale: true, step: m.state.step }
  if (m.gameId === 'snakes') {
    // The server rolls for the absent player and counts the miss; three in a row and they are out.
    const ss = m.state as BG.SnakesState
    const die = rollDie(seed, `${matchId}:roll:${ss.turnNumber}:${ss.step}`)
    const r = BG.snakesTimeout(ss, die)
    const out = await commitBoardStep(tx, matchId, m, seed, r.state, r.state.winner !== null ? [r.state.winner] : null, r.event, nowMs)
    return { applied: true, step: r.state.step, timedOut: ss.turn, ...out }
  }
  if (m.gameId === 'four_row') {
    // The server drops for the absent player (a column drawn from the seed); a second miss in a row forfeits.
    const fs = m.state as BG.FourRowState
    const pick = drawInt(seed, `${matchId}:auto:${fs.step}`, 7)
    const r = BG.fourRowTimeout(fs, pick)
    const out = await commitBoardStep(tx, matchId, m, seed, r.state, r.state.winners, r.event ?? { player: fs.turn, timedOut: true, forfeited: true }, nowMs)
    return { applied: true, step: r.state.step, timedOut: fs.turn, ...out }
  }
  if (m.gameId === 'carrom') {
    // A shot not taken in time passes (a miss); the third miss in a row puts the player out.
    const cs = m.state as CR.CarromState
    const absent = cs.turn
    const next = CR.timeoutPass(cs)
    const out = await commitCarromStep(tx, matchId, m, seed, next, { player: absent, timedOut: true, missed: next.misses[absent] }, null, nowMs)
    return { applied: true, step: next.step, timedOut: absent, ...out }
  }
  if (m.gameId === 'teen_patti') {
    // A turn not taken in time is a pack: the absent player's cards are never played for them.
    const tp = m.state as TP.TeenPattiState
    const absent = tp.turn
    const next = TP.forfeit(tp, absent)
    const out = await commitTeenPattiStep(tx, matchId, m, seed, next, { action: 'pack', player: absent, timedOut: true }, nowMs)
    return { applied: true, step: next.step, timedOut: absent, ...out }
  }
  const s = Ludo.fromStored(m.state)
  const die = rollDie(seed, `${matchId}:roll:${s.turnNumber}:${s.step}`)
  const result = Ludo.timeoutStep(s, die)
  const out = await commitLudoStep(tx, matchId, m, seed, result, nowMs)
  return { applied: true, step: result.state.step, event: result.event, timedOut: s.turn, ...out }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Playing Teen Patti
// ══════════════════════════════════════════════════════════════════════════════

/** Each seat's total in the pot, for settlement. */
function teenPattiEntries(s: TP.TeenPattiState): number[] {
  return [...s.paid]
}

/**
 * Write one Teen Patti step: the new state, or — when the game is over — the settlement, with every hand
 * revealed on the match document. Reads (the winners' wallets) happen before any write.
 */
async function commitTeenPattiStep(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, seed: string,
  s: TP.TeenPattiState, event: Record<string, unknown>, nowMs: number,
): Promise<{ finished: boolean; winners?: string[] }> {
  if (s.winners) {
    const winnerUids = s.winners.map((i) => m.seats[i].uid)
    const snaps = new Map<string, admin.firestore.DocumentSnapshot>()
    for (const w of winnerUids) snaps.set(w, await tx.get(db().collection('users').doc(w)))
    const meta = await tx.get(metaRef(matchId))
    const hands = ((meta.get('hands') as Array<{ cards: number[] }> | undefined) ?? []).map((h) => h.cards)
    settleFinished(tx, matchId, m, winnerUids, snaps, seed, {
      state: s, lastEvent: event,
      reveal: hands.map((cards, i) => ({ seat: i, cards, hand: cards.length === 3 ? TP.evaluate(cards).name : '' })),
    }, teenPattiEntries(s))
    return { finished: true, winners: winnerUids }
  }
  tx.update(matchRef(matchId), { state: s, lastEvent: event, pool: s.pot, deadlineMs: nowMs + m.turnSeconds * 1000 })
  return { finished: false }
}

interface TPArgs { matchId?: string; action?: string; step?: number }

export const teenPattiAction = functions.region(REGION).https.onCall(async (data: TPArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'teenPattiAction', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  const action = String(data?.action ?? '')
  if (!matchId || !['see', 'chaal', 'raise', 'pack', 'show'].includes(action)) {
    throw new functions.https.HttpsError('invalid-argument', 'Say what to do.')
  }
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [mSnap, metaSnap, userSnap] = await Promise.all([
      tx.get(matchRef(matchId)), tx.get(metaRef(matchId)), tx.get(db().collection('users').doc(uid)),
    ])
    if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    const m = mSnap.data() as MatchDoc
    if (m.gameId !== 'teen_patti') throw new functions.https.HttpsError('invalid-argument', 'This is not a Teen Patti game.')
    if (m.status !== 'playing' || !m.state) throw new functions.https.HttpsError('failed-precondition', 'This game is not being played.')
    const s = m.state as TP.TeenPattiState
    const me = m.seats.findIndex((x) => x.uid === uid)
    if (me < 0) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
    const hands = ((metaSnap.get('hands') as Array<{ cards: number[] }> | undefined) ?? []).map((h) => h.cards)
    if (action === 'see') {
      let next: TP.TeenPattiState
      try {
        next = TP.see(s, me)
      } catch (err) {
        throw new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message.replace(/^teen patti: /, '') : 'Not allowed.')
      }
      if (next !== s) tx.update(matchRef(matchId), { state: next })
      return { applied: true, cards: hands[me] ?? [], hand: hands[me] ? TP.evaluate(hands[me]).name : '' }
    }
    if (Number.isInteger(data?.step) && data!.step !== s.step) return { applied: false, stale: true, step: s.step }
    let result: TP.TPResult
    try {
      result = TP.act(s, me, action as 'chaal' | 'raise' | 'pack' | 'show', hands)
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message.replace(/^teen patti: /, '') : 'Not allowed.')
    }
    // A bet is paid from the player's diamonds now, into the pot — each one its own ledger row.
    let winnersReadFirst: Map<string, admin.firestore.DocumentSnapshot> | null = null
    if (result.state.winners) {
      winnersReadFirst = new Map()
      for (const i of result.state.winners) {
        const w = m.seats[i].uid
        winnersReadFirst.set(w, w === uid ? userSnap : await tx.get(db().collection('users').doc(w)))
      }
    }
    if (result.cost > 0) {
      debitPlayer(tx, db().collection('users').doc(uid), Number(userSnap.get('diamonds') ?? 0), result.cost, 'entry',
        { gameId: 'teen_patti', matchId }, `bet${result.state.step}`)
    }
    if (result.state.winners && winnersReadFirst) {
      const winnerUids = result.state.winners.map((i) => m.seats[i].uid)
      // The bettor's own wallet already moved in this transaction: credit on top of what it now holds.
      const adjusted = new Map(winnersReadFirst)
      if (adjusted.has(uid) && result.cost > 0) {
        const snap = adjusted.get(uid)!
        adjusted.set(uid, { get: (f: string) => (f === 'diamonds' ? Number(snap.get('diamonds') ?? 0) - result.cost : snap.get(f)) } as unknown as admin.firestore.DocumentSnapshot)
      }
      settleFinished(tx, matchId, m, winnerUids, adjusted, String(metaSnap.get('seed') ?? ''), {
        state: result.state, lastEvent: result.event,
        reveal: hands.map((cards, i) => ({ seat: i, cards, hand: cards.length === 3 ? TP.evaluate(cards).name : '' })),
      }, teenPattiEntries(result.state))
      return { applied: true, step: result.state.step, finished: true, winners: winnerUids }
    }
    tx.update(matchRef(matchId), { state: result.state, lastEvent: result.event, pool: result.state.pot, deadlineMs: nowMs + m.turnSeconds * 1000 })
    return { applied: true, step: result.state.step, finished: false, cost: result.cost }
  })
})

/** My three cards — only once I have seen them (or the game is over). */
export const teenPattiMyCards = functions.region(REGION).https.onCall(async (data: { matchId?: string }, context) => {
  const uid = requireAuth(context)
  const matchId = String(data?.matchId ?? '')
  const [mSnap, metaSnap] = await Promise.all([matchRef(matchId).get(), metaRef(matchId).get()])
  if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
  const m = mSnap.data() as MatchDoc
  const me = m.seats.findIndex((x) => x.uid === uid)
  if (me < 0) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
  const s = m.state as TP.TeenPattiState | null
  if (!s || (!s.seen[me] && m.status === 'playing')) return { cards: [], seen: false }
  const hands = ((metaSnap.get('hands') as Array<{ cards: number[] }> | undefined) ?? []).map((h) => h.cards)
  const cards = hands[me] ?? []
  return { cards, seen: true, hand: cards.length === 3 ? TP.evaluate(cards).name : '' }
})

// ══════════════════════════════════════════════════════════════════════════════
//  Playing Carrom
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Write one Carrom step: the new state with the shot's replay frames, or the settlement. Reads (the winners'
 * wallets) come before any write.
 */
async function commitCarromStep(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, seed: string, s: CR.CarromState,
  event: Record<string, unknown>, shot: CR.ShotResult | null, nowMs: number,
): Promise<{ finished: boolean; winners?: string[] }> {
  const lastShot = shot
    ? {
      n: s.shots, player: event.player, frameMs: CR.FRAME_MS, bodies: 1 + s.pieces.length,
      frames: CR.packFrames(shot.frames), pocketed: shot.pocketed,
    }
    : null
  if (s.winners) {
    const winnerUids = s.winners.map((i) => m.seats[i].uid)
    const snaps = new Map<string, admin.firestore.DocumentSnapshot>()
    for (const w of winnerUids) snaps.set(w, await tx.get(db().collection('users').doc(w)))
    settleFinished(tx, matchId, m, winnerUids, snaps, seed, { state: s, lastEvent: event, ...(lastShot ? { lastShot } : {}) })
    return { finished: true, winners: winnerUids }
  }
  tx.update(matchRef(matchId), {
    state: s, lastEvent: event, ...(lastShot ? { lastShot } : {}), deadlineMs: nowMs + m.turnSeconds * 1000,
  })
  return { finished: false }
}

interface ShotArgs { matchId?: string; x?: number; angle?: number; power?: number; step?: number }

export const carromShot = functions.region(REGION).https.onCall(async (data: ShotArgs, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'carromShot', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [mSnap, metaSnap] = await Promise.all([tx.get(matchRef(matchId)), tx.get(metaRef(matchId))])
    if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    const m = mSnap.data() as MatchDoc
    if (m.gameId !== 'carrom') throw new functions.https.HttpsError('invalid-argument', 'This is not a Carrom game.')
    if (m.status !== 'playing' || !m.state) throw new functions.https.HttpsError('failed-precondition', 'This game is not being played.')
    const s = m.state as CR.CarromState
    const me = m.seats.findIndex((x) => x.uid === uid)
    if (me < 0) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
    if (Number.isInteger(data?.step) && data!.step !== s.step) return { applied: false, stale: true, step: s.step }
    let result: CR.ShotResult
    try {
      result = CR.shoot(s, me, { x01: Number(data?.x), angle: Number(data?.angle), power: Number(data?.power) })
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message.replace(/^carrom: /, '') : 'Not allowed.')
    }
    const out = await commitCarromStep(tx, matchId, m, String(metaSnap.get('seed') ?? ''), result.state, result.event, result, nowMs)
    return { applied: true, step: result.state.step, event: result.event, ...out }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Snakes & Ladders, Four in a Row
// ══════════════════════════════════════════════════════════════════════════════

/** Write one step of a board game, or settle it when it has winners (seat indices). Reads come first. */
async function commitBoardStep(
  tx: admin.firestore.Transaction, matchId: string, m: MatchDoc, seed: string,
  state: BG.SnakesState | BG.FourRowState, winners: number[] | null, event: object, nowMs: number,
): Promise<{ finished: boolean; winners?: string[] }> {
  if (winners && winners.length) {
    const winnerUids = winners.map((i) => m.seats[i].uid)
    const snaps = new Map<string, admin.firestore.DocumentSnapshot>()
    for (const w of winnerUids) snaps.set(w, await tx.get(db().collection('users').doc(w)))
    settleFinished(tx, matchId, m, winnerUids, snaps, seed, { state, lastEvent: event })
    return { finished: true, winners: winnerUids }
  }
  tx.update(matchRef(matchId), { state, lastEvent: event, deadlineMs: nowMs + m.turnSeconds * 1000 })
  return { finished: false }
}

/** Shared opening of a board-game move: the match, the seat, the staleness check. */
async function boardMove<T extends BG.SnakesState | BG.FourRowState>(
  tx: admin.firestore.Transaction, uid: string, matchId: string, gameId: GameId, step: unknown,
): Promise<{ m: MatchDoc; s: T; me: number; seed: string } | { stale: true; step: number }> {
  const [mSnap, metaSnap] = await Promise.all([tx.get(matchRef(matchId)), tx.get(metaRef(matchId))])
  if (!mSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
  const m = mSnap.data() as MatchDoc
  if (m.gameId !== gameId) throw new functions.https.HttpsError('invalid-argument', 'This is a different game.')
  if (m.status !== 'playing' || !m.state) throw new functions.https.HttpsError('failed-precondition', 'This game is not being played.')
  const s = m.state as T
  const me = m.seats.findIndex((x) => x.uid === uid)
  if (me < 0) throw new functions.https.HttpsError('permission-denied', 'You are not in this game.')
  if (Number.isInteger(step) && step !== s.step) return { stale: true, step: s.step }
  return { m, s, me, seed: String(metaSnap.get('seed') ?? '') }
}

function refused(err: unknown, prefix: RegExp): functions.https.HttpsError {
  return new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message.replace(prefix, '') : 'Not allowed.')
}

export const snakesRoll = functions.region(REGION).https.onCall(async (data: { matchId?: string; step?: number }, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'snakesRoll', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const b = await boardMove<BG.SnakesState>(tx, uid, matchId, 'snakes', data?.step)
    if ('stale' in b) return { applied: false, stale: true, step: b.step }
    const die = rollDie(b.seed, `${matchId}:roll:${b.s.turnNumber}:${b.s.step}`)
    let r: { state: BG.SnakesState; event: BG.SnakesEvent }
    try { r = BG.snakesRoll(b.s, b.me, die) } catch (err) { throw refused(err, /^snakes: /) }
    const out = await commitBoardStep(tx, matchId, b.m, b.seed, r.state, r.state.winner !== null ? [r.state.winner] : null, r.event, nowMs)
    return { applied: true, step: r.state.step, event: r.event, ...out }
  })
})

export const fourRowDrop = functions.region(REGION).https.onCall(async (data: { matchId?: string; col?: number; step?: number }, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'fourRowDrop', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const b = await boardMove<BG.FourRowState>(tx, uid, matchId, 'four_row', data?.step)
    if ('stale' in b) return { applied: false, stale: true, step: b.step }
    let r: { state: BG.FourRowState; event: BG.FourRowEvent }
    try { r = BG.fourRowDrop(b.s, b.me, Math.trunc(Number(data?.col))) } catch (err) { throw refused(err, /^four in a row: /) }
    const out = await commitBoardStep(tx, matchId, b.m, b.seed, r.state, r.state.winners, r.event, nowMs)
    return { applied: true, step: r.state.step, event: r.event, ...out }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Leaving, and the sweep
// ══════════════════════════════════════════════════════════════════════════════

export const leaveGameMatch = functions.region(REGION).https.onCall(async (data: { matchId?: string }, context) => {
  const uid = requireAuth(context)
  const matchId = String(data?.matchId ?? '')
  if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [mSnap, metaSnap] = await Promise.all([tx.get(matchRef(matchId)), tx.get(metaRef(matchId))])
    if (!mSnap.exists) return { left: true }
    const m = mSnap.data() as MatchDoc
    if (!m.playerUids.includes(uid)) return { left: true }
    const seed = String(metaSnap.get('seed') ?? '')
    if (m.status === 'waiting') {
      // Before the start: the entry comes back. The last one out cancels the match.
      const userSnap = await tx.get(db().collection('users').doc(uid))
      const others = m.seats.filter((s) => s.uid !== uid)
      creditPlayer(tx, db().collection('users').doc(uid), Number(userSnap.get('diamonds') ?? 0), m.entry, 'refund', { gameId: m.gameId, matchId })
      tx.set(db().collection('users').doc(uid).collection('gameHistory').doc(matchId), {
        gameId: m.gameId, matchId, result: 'refunded', entry: m.entry, payout: m.entry, players: m.capacity,
        reason: 'left_before_start', at: admin.firestore.FieldValue.serverTimestamp(),
      })
      if (others.length === 0) {
        tx.update(matchRef(matchId), { seats: [], playerUids: [], pool: 0, status: 'cancelled', cancelReason: 'everyone_left', seed, finishedAtMs: nowMs })
      } else {
        tx.update(matchRef(matchId), { seats: others, playerUids: others.map((s) => s.uid), pool: m.pool - m.entry })
      }
      return { left: true, refunded: m.entry }
    }
    if (m.status === 'playing' && m.state && (m.gameId === 'snakes' || m.gameId === 'four_row')) {
      const me = m.seats.findIndex((s) => s.uid === uid)
      if (m.gameId === 'snakes') {
        const next = BG.snakesForfeit(m.state as BG.SnakesState, me)
        const out = await commitBoardStep(tx, matchId, m, seed, next, next.winner !== null ? [next.winner] : null, { player: me, left: true }, nowMs)
        return { left: true, forfeited: true, ...out }
      }
      const next = BG.fourRowForfeit(m.state as BG.FourRowState, me)
      const out = await commitBoardStep(tx, matchId, m, seed, next, next.winners, { player: me, left: true }, nowMs)
      return { left: true, forfeited: true, ...out }
    }
    if (m.status === 'playing' && m.state && m.gameId === 'carrom') {
      const me = m.seats.findIndex((s) => s.uid === uid)
      const next = CR.forfeit(m.state as CR.CarromState, me)
      const out = await commitCarromStep(tx, matchId, m, seed, next, { player: me, left: true }, null, nowMs)
      return { left: true, forfeited: true, ...out }
    }
    if (m.status === 'playing' && m.state && m.gameId === 'teen_patti') {
      const me = m.seats.findIndex((s) => s.uid === uid)
      const next = TP.forfeit(m.state as TP.TeenPattiState, me)
      const out = await commitTeenPattiStep(tx, matchId, m, seed, next, { action: 'pack', player: me, left: true }, nowMs)
      return { left: true, forfeited: true, ...out }
    }
    if (m.status === 'playing' && m.state) {
      const me = m.seats.findIndex((s) => s.uid === uid)
      const state = Ludo.forfeit(Ludo.fromStored(m.state), me)
      const out = await commitLudoStep(tx, matchId, m, seed, { state, event: { kind: 'rolled', player: me, die: 0, passed: true, forfeitedTurn: true } }, nowMs)
      return { left: true, forfeited: true, ...out }
    }
    return { left: true }
  })
})

/** One pass of the sweep: refund matches that never filled, play overdue turns. Exported for tests. */
export async function sweepGameMatchesOnce(nowMs: number): Promise<{ refunded: number; timedOut: number }> {
  let refunded = 0
  let timedOut = 0
  const stale = await db().collection(MATCHES).where('status', '==', 'waiting').where('waitUntilMs', '<', nowMs).limit(50).get()
  for (const doc of stale.docs) {
    await db().runTransaction(async (tx) => {
      const [mSnap, metaSnap] = await Promise.all([tx.get(doc.ref), tx.get(metaRef(doc.id))])
      const m = mSnap.data() as MatchDoc
      if (!m || m.status !== 'waiting') return
      const snaps = new Map<string, admin.firestore.DocumentSnapshot>()
      for (const s of m.seats) snaps.set(s.uid, await tx.get(db().collection('users').doc(s.uid)))
      refundAll(tx, doc.id, m, snaps, 'not_enough_players', String(metaSnap.get('seed') ?? ''))
      refunded++
    })
  }
  const overdue = await db().collection(MATCHES).where('status', '==', 'playing').where('deadlineMs', '<', nowMs - 5_000).limit(50).get()
  for (const doc of overdue.docs) {
    await db().runTransaction(async (tx) => {
      const [mSnap, metaSnap] = await Promise.all([tx.get(doc.ref), tx.get(metaRef(doc.id))])
      const m = mSnap.data() as MatchDoc
      if (!m) return
      const r = await timeoutIn(tx, doc.id, m, String(metaSnap.get('seed') ?? ''), nowMs)
      if (r.applied) timedOut++
    })
  }
  return { refunded, timedOut }
}

export const sweepGameMatches = functions.region(REGION).pubsub.schedule('every 1 minutes').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const r = await sweepGameMatchesOnce(Date.now())
    if (r.refunded || r.timedOut) functions.logger.info(`sweepGameMatches: ${r.refunded} refunded, ${r.timedOut} turns played`)
    return null
  })

/** A new private match with the same game, size and entry; the last match's players join it without a code. */
export const rematchGameMatch = functions.region(REGION).https.onCall(async (data: { matchId?: string; idempotencyKey?: string }, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'rematchGameMatch', context.auth?.token)
  const matchId = String(data?.matchId ?? '')
  const key = idemKey(data?.idempotencyKey)
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [idem, cfg, userSnap, oldSnap] = await Promise.all([
      tx.get(idemRef(uid, key)), readConfig(tx), tx.get(db().collection('users').doc(uid)), tx.get(matchRef(matchId)),
    ])
    if (idem.exists) return { ...idem.data(), replayed: true }
    if (!oldSnap.exists) throw new functions.https.HttpsError('not-found', 'That game no longer exists.')
    const old = oldSnap.data() as MatchDoc
    if (!old.playerUids.includes(uid)) throw new functions.https.HttpsError('permission-denied', 'You were not in that game.')
    if (old.status !== 'finished') throw new functions.https.HttpsError('failed-precondition', 'That game has not finished.')
    if (typeof old.rematchMatchId === 'string' && old.rematchMatchId) return { matchId: old.rematchMatchId, already: true, replayed: false }
    playerOk(userSnap)
    const made = await createIn(tx, uid, { gameId: old.gameId, players: old.capacity, entry: old.entry, visibility: 'private', rematchOf: matchId }, cfg, userSnap, nowMs)
    tx.set(metaRef(made.matchId), { rematchPlayers: old.playerUids.filter((p) => p !== uid) }, { merge: true })
    tx.update(matchRef(matchId), { rematchMatchId: made.matchId })
    const result = { matchId: made.matchId, inviteCode: made.inviteCode, replayed: false }
    tx.set(idemRef(uid, key), { ...result, op: 'rematch', createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return result
  })
})
