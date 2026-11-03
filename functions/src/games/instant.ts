/**
 * INSTANT GAMES — single-player rounds, server-decided (B5, 3 Nov 2026).
 *
 *   Peg Drop (plinko)        playPlinko               one call: stake → drop → win
 *   Mela Reels (slots)       spinSlots                one call: stake → spin → win
 *   Lucky Catch (fishing)    castFishing              one call: stake → cast → win
 *   Lane Hopper (chicken)    chickenStart / chickenStep / chickenCashout
 *   Zip Flight (crash)       crashStart / crashPoll / crashCashout
 *   Lucky Dice               playDice                 one call
 *   Toss Up                  tossCoin                 one call
 *   Fortune Wheel            spinWheel                one call
 *   Number Draw (keno)       playKeno                 one call
 *   Sky High (limbo)         playLimbo                one call
 *   Roulette                 spinRoulette             one call
 *   Dragon Tiger             playDragonTiger          one call
 *   Andar Bahar              playAndarBahar           one call
 *   Higher or Lower          hiloStart / hiloGuess / hiloCashout
 *   Gem Field (mines)        minesStart / minesReveal / minesCashout
 *
 * ── Provably fair, per player ──────────────────────────────────────────────
 *
 * Each player has a server seed (`gameSeeds/{uid}`, server-only) whose SHA-256 they can see before they play
 * (`gameFairness`), an optional client seed of their own, and a nonce that counts their rounds. A round's draws are
 * HMAC(serverSeed, "<game>:<clientSeed>:<nonce>…"). `rotateGameSeed` reveals the old seed — every past round can
 * then be recomputed — and starts a new one. The server decides the hidden part of a multi-step round (the lane
 * that is lost, the crash point) when the round starts, and keeps it in `gameRounds/{id}/private/secret` until the
 * round ends.
 *
 * ── Money ──────────────────────────────────────────────────────────────────
 *
 * The stake is debited (ledger `stake`) before anything is drawn; a win is credited (ledger `win`) in the same
 * transaction that settles the round. A round settles exactly once: its status moves `open → settled` inside the
 * transaction, so a repeated cash-out finds it settled and pays nothing.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { assertActiveSession, restrictionVerdict, ACCOUNT_RESTRICTED } from '../mobileSession'
import { type GameId, mergeGamesConfig, requireGameOpen, validEntry } from './config'
import { commitOf, newSeed } from './rng'
import { creditPlayer, dailyLossOf, debitPlayer } from './ledger'
import * as M from './instantMath'
import * as X from './moreMath'

const REGION = 'asia-south1'

function db(): admin.firestore.Firestore {
  return admin.firestore()
}

function requireAuth(context: functions.https.CallableContext): string {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  return uid
}

function idemKey(raw: unknown): string {
  const key = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
    throw new functions.https.HttpsError('invalid-argument', 'This request could not be read. Update the app and try again.')
  }
  return key
}

const configRef = () => db().collection('appConfig').doc('games')
const seedRef = (uid: string) => db().collection('gameSeeds').doc(uid)
const roundRef = (id: string) => db().collection('gameRounds').doc(id)
const secretRef = (id: string) => roundRef(id).collection('private').doc('secret')
const idemRef = (uid: string, key: string) => db().collection('gameIdempotency').doc(`${uid}_${key}`)
const userRef = (uid: string) => db().collection('users').doc(uid)

function playerOk(snap: admin.firestore.DocumentSnapshot): void {
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Finish setting up your profile first.')
  const restricted = restrictionVerdict((f) => snap.get(f))
  if (restricted) {
    throw new functions.https.HttpsError('permission-denied', 'This account cannot play right now.', { code: ACCOUNT_RESTRICTED, state: restricted })
  }
}

interface SeedState { seed: string; commit: string; clientSeed: string; nonce: number; fresh: boolean }

function seedStateOf(snap: admin.firestore.DocumentSnapshot): SeedState {
  if (snap.exists && typeof snap.get('seed') === 'string') {
    return {
      seed: String(snap.get('seed')), commit: String(snap.get('commit')),
      clientSeed: String(snap.get('clientSeed') ?? ''), nonce: Number(snap.get('nonce') ?? 0) || 0, fresh: false,
    }
  }
  const seed = newSeed()
  return { seed, commit: commitOf(seed), clientSeed: '', nonce: 0, fresh: true }
}

function label(gameId: GameId, s: SeedState): string {
  return `${gameId}:${s.clientSeed}:${s.nonce}`
}

function writeSeedAdvance(tx: admin.firestore.Transaction, uid: string, s: SeedState): void {
  tx.set(seedRef(uid), {
    seed: s.seed, commit: s.commit, clientSeed: s.clientSeed, nonce: s.nonce + 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true })
}

function history(tx: admin.firestore.Transaction, uid: string, roundId: string, gameId: GameId, entry: number, payout: number, extra: Record<string, unknown> = {}): void {
  tx.set(userRef(uid).collection('gameHistory').doc(roundId), {
    gameId, roundId, result: payout > 0 ? 'won' : 'lost', entry, payout, at: admin.firestore.FieldValue.serverTimestamp(), ...extra,
  })
}

interface Ctx {
  tx: admin.firestore.Transaction
  uid: string
  gameId: GameId
  settings: Record<string, unknown>
  edgePct: number
  entry: number
  roundId: string
  seed: SeedState
  balanceAfterStake: number
}

/**
 * The shared shape of starting any instant round: idempotency, config, account, entry, stake, seed — then the
 * game's own `play`, which returns what to write. Everything is read before anything is written.
 */
async function startRound(
  uid: string, gameId: GameId, data: Record<string, unknown>,
  play: (c: Ctx) => { status: 'settled' | 'open'; multiplier?: number; outcome: Record<string, unknown>; secret?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const key = idemKey(data.idempotencyKey)
  return db().runTransaction(async (tx) => {
    const [idem, cfgSnap, userSnap, seedSnap] = await Promise.all([
      tx.get(idemRef(uid, key)), tx.get(configRef()), tx.get(userRef(uid)), tx.get(seedRef(uid)),
    ])
    if (idem.exists) return { ...idem.data(), replayed: true }
    const cfg = mergeGamesConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
    const g = requireGameOpen(cfg, gameId)
    playerOk(userSnap)
    const entry = validEntry(g, cfg, data.entry)
    const ref = db().collection('gameRounds').doc()
    const seed = seedStateOf(seedSnap)
    const balanceAfterStake = debitPlayer(tx, userRef(uid), Number(userSnap.get('diamonds') ?? 0), entry, 'stake', { gameId, roundId: ref.id },
      undefined, dailyLossOf(userSnap, cfg.limits.dailyLossLimit, Date.now()))
    // The Owner's house edge, 0–20 % (0 is a choice, not a missing value).
    const edgeRaw = Number(g.houseEdgePct)
    const edgePct = Number.isFinite(edgeRaw) ? Math.min(20, Math.max(0, edgeRaw)) : 3
    const c: Ctx = { tx, uid, gameId, settings: g as unknown as Record<string, unknown>, edgePct, entry, roundId: ref.id, seed, balanceAfterStake }
    const r = play(c)
    let payout = 0
    if (r.status === 'settled') {
      payout = M.payoutFor(entry, r.multiplier ?? 0)
      creditPlayer(tx, userRef(uid), balanceAfterStake, payout, 'win', { gameId, roundId: ref.id })
      history(tx, uid, ref.id, gameId, entry, payout, { multiplier: r.multiplier ?? 0 })
    }
    tx.set(ref, {
      gameId, uid, entry, status: r.status, outcome: r.outcome,
      ...(r.status === 'settled' ? { multiplier: r.multiplier ?? 0, payout, settledAtMs: Date.now() } : {}),
      fairness: { commit: seed.commit, clientSeed: seed.clientSeed, nonce: seed.nonce },
      createdAtMs: Date.now(), createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    if (r.secret) tx.set(secretRef(ref.id), r.secret)
    writeSeedAdvance(tx, uid, seed)
    const result = {
      roundId: ref.id, gameId, entry, status: r.status, outcome: r.outcome,
      ...(r.status === 'settled' ? { multiplier: r.multiplier ?? 0, payout } : {}),
      balance: balanceAfterStake + payout,
      fairness: { commit: seed.commit, clientSeed: seed.clientSeed, nonce: seed.nonce },
      replayed: false,
    }
    tx.set(idemRef(uid, key), { ...result, createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return result
  })
}

/**
 * Settle an open round: pay `multiplier` × entry (0 for a loss) exactly once. Reads first; refuses a round that is
 * not the caller's or is already settled (and then returns the settled result, so a repeat is harmless).
 */
async function settleOpen(
  uid: string, roundId: string, gameId: GameId,
  decide: (round: Record<string, unknown>, secret: Record<string, unknown>, nowMs: number) =>
    { settle: false; reply: Record<string, unknown> } | { settle: true; multiplier: number; outcome: Record<string, unknown>; reveal: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  if (!roundId) throw new functions.https.HttpsError('invalid-argument', 'roundId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [rSnap, sSnap, uSnap] = await Promise.all([tx.get(roundRef(roundId)), tx.get(secretRef(roundId)), tx.get(userRef(uid))])
    if (!rSnap.exists) throw new functions.https.HttpsError('not-found', 'That round no longer exists.')
    const round = rSnap.data() as Record<string, unknown>
    if (round.uid !== uid || round.gameId !== gameId) throw new functions.https.HttpsError('permission-denied', 'That is not your round.')
    if (round.status === 'settled') {
      return { roundId, status: 'settled', outcome: round.outcome, multiplier: round.multiplier, payout: round.payout, already: true }
    }
    const d = decide(round, (sSnap.data() ?? {}) as Record<string, unknown>, nowMs)
    if (!d.settle) return { roundId, status: 'open', ...d.reply }
    const entry = Number(round.entry) || 0
    const payout = M.payoutFor(entry, d.multiplier)
    const balance = creditPlayer(tx, userRef(uid), Number(uSnap.get('diamonds') ?? 0), payout, 'win', { gameId, roundId })
    history(tx, uid, roundId, gameId, entry, payout, { multiplier: d.multiplier })
    const outcome = { ...(round.outcome as Record<string, unknown>), ...d.outcome, ...d.reveal }
    tx.update(roundRef(roundId), { status: 'settled', outcome, multiplier: d.multiplier, payout, settledAtMs: nowMs })
    return { roundId, status: 'settled', outcome, multiplier: d.multiplier, payout, balance }
  })
}

// ══════════════════════════════════════════════════════════════════════════════
//  One-call games
// ══════════════════════════════════════════════════════════════════════════════

export const playPlinko = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playPlinko', context.auth?.token)
  return startRound(uid, 'plinko', data ?? {}, (c) => {
    const allowedRows = Array.isArray(c.settings.rows) ? (c.settings.rows as number[]) : [8, 12, 16]
    const rows = Math.trunc(Number(data?.rows))
    if (!allowedRows.includes(rows)) throw new functions.https.HttpsError('invalid-argument', `Choose ${allowedRows.join(', ')} rows.`)
    const risk = ['low', 'medium', 'high'].includes(String(data?.risk)) ? String(data.risk) : 'medium'
    const table = M.plinkoTable(rows, risk, 1 - c.edgePct / 100)
    const drop = M.plinkoDrop(c.seed.seed, label('plinko', c.seed), rows)
    return { status: 'settled', multiplier: table[drop.bin], outcome: { rows, risk, path: drop.path, bin: drop.bin, table } }
  })
})

export const spinSlots = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'spinSlots', context.auth?.token)
  return startRound(uid, 'slots', data ?? {}, (c) => {
    const pays = M.slotPaytable(1 - c.edgePct / 100)
    const spin = M.slotSpin(c.seed.seed, label('slots', c.seed), pays)
    // Firestore stores no array inside an array: the grid goes flat, reel by reel (index = reel × rows + row).
    return {
      status: 'settled', multiplier: spin.multiplier,
      outcome: { grid: spin.grid.flat(), reels: spin.grid.length, rows: spin.grid[0]?.length ?? 3, wins: spin.wins, symbols: M.SLOT_SYMBOLS },
    }
  })
})

export const castFishing = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'castFishing', context.auth?.token)
  return startRound(uid, 'fishing', data ?? {}, (c) => {
    const table = M.catchTable(1 - c.edgePct / 100)
    const caught = M.castLine(c.seed.seed, label('fishing', c.seed), table)
    return { status: 'settled', multiplier: caught.multiplier, outcome: { catch: caught.id, name: caught.name } }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Lane Hopper (chicken road)
// ══════════════════════════════════════════════════════════════════════════════

export const chickenStart = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'chickenStart', context.auth?.token)
  return startRound(uid, 'chicken_road', data ?? {}, (c) => {
    const difficulty = Object.keys(M.CHICKEN_DIFFICULTY).includes(String(data?.difficulty)) ? String(data.difficulty) : 'easy'
    const p = M.CHICKEN_DIFFICULTY[difficulty]
    const lanes = Math.min(30, Math.max(5, Math.trunc(Number(c.settings.lanes ?? 20)) || 20))
    const deathLane = M.chickenDeathLane(c.seed.seed, label('chicken_road', c.seed), p, lanes)
    const ladder = Array.from({ length: lanes }, (_, i) => M.chickenMultiplier(i + 1, p, c.edgePct))
    return { status: 'open', outcome: { difficulty, lanes, ladder, crossed: 0 }, secret: { deathLane } }
  })
})

export const chickenStep = functions.region(REGION).https.onCall(async (data: { roundId?: string; lane?: number }, context) => {
  const uid = requireAuth(context)
  const roundId = String(data?.roundId ?? '')
  const nowMs = Date.now()
  // A step either survives (the round stays open, one lane further) or is lost (settled at 0).
  return db().runTransaction(async (tx) => {
    const [rSnap, sSnap, uSnap] = await Promise.all([tx.get(roundRef(roundId)), tx.get(secretRef(roundId)), tx.get(userRef(uid))])
    if (!rSnap.exists) throw new functions.https.HttpsError('not-found', 'That round no longer exists.')
    const round = rSnap.data() as Record<string, unknown>
    if (round.uid !== uid || round.gameId !== 'chicken_road') throw new functions.https.HttpsError('permission-denied', 'That is not your round.')
    const out = round.outcome as { crossed: number; lanes: number; ladder: number[] }
    if (round.status === 'settled') return { roundId, status: 'settled', outcome: round.outcome, payout: round.payout, already: true }
    // `lane` names the lane the player is stepping onto: a repeated tap for the same lane does nothing twice.
    const lane = out.crossed + 1
    if (Number.isInteger(data?.lane) && data!.lane !== lane) return { roundId, status: 'open', outcome: out, stale: true }
    const deathLane = Number(sSnap.get('deathLane'))
    const entry = Number(round.entry) || 0
    if (lane === deathLane) {
      history(tx, uid, roundId, 'chicken_road', entry, 0, { multiplier: 0 })
      const outcome = { ...out, crossed: out.crossed, lostAt: lane, deathLane }
      tx.update(roundRef(roundId), { status: 'settled', outcome, multiplier: 0, payout: 0, settledAtMs: nowMs })
      return { roundId, status: 'settled', outcome, multiplier: 0, payout: 0 }
    }
    const crossed = lane
    if (crossed >= out.lanes) {
      // The far side: collected automatically at the top of the ladder.
      const multiplier = out.ladder[out.lanes - 1]
      const payout = M.payoutFor(entry, multiplier)
      const balance = creditPlayer(tx, userRef(uid), Number(uSnap.get('diamonds') ?? 0), payout, 'win', { gameId: 'chicken_road', roundId })
      history(tx, uid, roundId, 'chicken_road', entry, payout, { multiplier })
      const outcome = { ...out, crossed, deathLane }
      tx.update(roundRef(roundId), { status: 'settled', outcome, multiplier, payout, settledAtMs: nowMs })
      return { roundId, status: 'settled', outcome, multiplier, payout, balance }
    }
    const outcome = { ...out, crossed }
    tx.update(roundRef(roundId), { outcome })
    return { roundId, status: 'open', outcome, multiplier: out.ladder[crossed - 1] }
  })
})

export const chickenCashout = functions.region(REGION).https.onCall(async (data: { roundId?: string }, context) => {
  const uid = requireAuth(context)
  return settleOpen(uid, String(data?.roundId ?? ''), 'chicken_road', (round, secret) => {
    const out = round.outcome as { crossed: number; ladder: number[] }
    if (out.crossed <= 0) return { settle: false, reply: { outcome: out, refused: 'Cross at least one lane first.' } }
    return { settle: true, multiplier: out.ladder[out.crossed - 1], outcome: {}, reveal: { deathLane: secret.deathLane } }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Zip Flight (crash)
// ══════════════════════════════════════════════════════════════════════════════

/** Seconds of countdown before the flight starts, so the player sees the take-off. */
export const CRASH_COUNTDOWN_MS = 1500

export const crashStart = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'crashStart', context.auth?.token)
  const auto = Number(data?.autoCashout ?? 0)
  const autoCashout = Number.isFinite(auto) && auto >= 1.01 ? Math.floor(auto * 100) / 100 : 0
  return startRound(uid, 'crash', data ?? {}, (c) => {
    const max = Math.min(10_000, Math.max(2, Number(c.settings.maxMultiplier ?? 1000) || 1000))
    const crashAt = M.crashPoint(c.seed.seed, label('crash', c.seed), c.edgePct, max)
    const startsAtMs = Date.now() + CRASH_COUNTDOWN_MS
    return {
      status: 'open',
      outcome: { startsAtMs, autoCashout, growthPerSecond: M.CRASH_K },
      secret: { crashAt, crashesAtMs: startsAtMs + M.crashFlightMs(crashAt) },
    }
  })
})

/**
 * Where the flight is now. Settles a round the moment it is over — crashed (a loss, or the auto cash-out if it was
 * reached first) — and only then reveals the crash point.
 */
export const crashPoll = functions.region(REGION).https.onCall(async (data: { roundId?: string }, context) => {
  const uid = requireAuth(context)
  return settleOpen(uid, String(data?.roundId ?? ''), 'crash', (round, secret, nowMs) => crashDecision(round, secret, nowMs, false))
})

export const crashCashout = functions.region(REGION).https.onCall(async (data: { roundId?: string }, context) => {
  const uid = requireAuth(context)
  return settleOpen(uid, String(data?.roundId ?? ''), 'crash', (round, secret, nowMs) => crashDecision(round, secret, nowMs, true))
})

export function crashDecision(round: Record<string, unknown>, secret: Record<string, unknown>, nowMs: number, cashingOut: boolean):
  { settle: false; reply: Record<string, unknown> } | { settle: true; multiplier: number; outcome: Record<string, unknown>; reveal: Record<string, unknown> } {
  const out = round.outcome as { startsAtMs: number; autoCashout: number }
  const crashAt = Number(secret.crashAt)
  const elapsed = nowMs - out.startsAtMs
  const reveal = { crashAt }
  if (elapsed < 0) {
    // Not taken off: a cash-out now is too early to mean anything — it waits.
    return { settle: false, reply: { phase: 'countdown', startsAtMs: out.startsAtMs, serverNowMs: nowMs } }
  }
  const now = M.crashMultiplierAt(elapsed)
  // An auto cash-out the flight reached before crashing pays at that multiplier, whenever the server learns of it.
  if (out.autoCashout >= 1.01 && crashAt > out.autoCashout && now >= out.autoCashout) {
    return { settle: true, multiplier: out.autoCashout, outcome: { cashedOutAt: out.autoCashout, auto: true }, reveal }
  }
  if (now >= crashAt) return { settle: true, multiplier: 0, outcome: { crashed: true }, reveal }
  if (cashingOut) {
    return { settle: true, multiplier: now, outcome: { cashedOutAt: now }, reveal }
  }
  return { settle: false, reply: { phase: 'flying', startsAtMs: out.startsAtMs, serverNowMs: nowMs, multiplier: now } }
}

// ══════════════════════════════════════════════════════════════════════════════
//  The second set (B5, 3 Nov 2026) — odds and payouts in moreMath.ts
// ══════════════════════════════════════════════════════════════════════════════

const bad = (msg: string) => new functions.https.HttpsError('invalid-argument', msg)

export const playDice = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playDice', context.auth?.token)
  return startRound(uid, 'dice', data ?? {}, (c) => {
    const chance = Math.trunc(Number(data?.chance))
    if (!(chance >= 2 && chance <= 95)) throw bad('Choose a win chance from 2 to 95.')
    const direction = data?.direction === 'over' ? 'over' : 'under'
    const roll = X.diceRoll(c.seed.seed, label('dice', c.seed))
    const won = X.diceWins(roll, chance, direction)
    const pays = X.diceMultiplier(chance, c.edgePct)
    return { status: 'settled', multiplier: won ? pays : 0, outcome: { roll: roll / 100, chance, direction, pays, won } }
  })
})

export const tossCoin = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'tossCoin', context.auth?.token)
  return startRound(uid, 'coin_toss', data ?? {}, (c) => {
    const side = data?.side === 'tails' ? 'tails' : data?.side === 'heads' ? 'heads' : null
    if (!side) throw bad('Choose heads or tails.')
    const landed = X.coinFlip(c.seed.seed, label('coin_toss', c.seed))
    const pays = X.coinMultiplier(c.edgePct)
    return { status: 'settled', multiplier: landed === side ? pays : 0, outcome: { side, landed, pays } }
  })
})

export const spinWheel = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'spinWheel', context.auth?.token)
  return startRound(uid, 'wheel', data ?? {}, (c) => {
    const risk = X.WHEEL_RISKS.includes(String(data?.risk)) ? String(data.risk) : 'medium'
    const table = X.wheelTable(risk, c.edgePct)
    const segment = X.wheelSpin(c.seed.seed, label('wheel', c.seed), table.length)
    return { status: 'settled', multiplier: table[segment], outcome: { risk, table, segment } }
  })
})

export const playKeno = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playKeno', context.auth?.token)
  return startRound(uid, 'keno', data ?? {}, (c) => {
    const raw = Array.isArray(data?.picks) ? (data.picks as unknown[]) : []
    const picks = Array.from(new Set(raw.map((x) => Math.trunc(Number(x))))).filter((x) => x >= 1 && x <= X.KENO_NUMBERS)
    if (picks.length < 1 || picks.length > 10 || picks.length !== raw.length) throw bad('Pick 1 to 10 different numbers from 1 to 40.')
    picks.sort((a, b) => a - b)
    const table = X.kenoTable(picks.length, c.edgePct)
    const drawn = X.kenoDraw(c.seed.seed, label('keno', c.seed))
    const hits = picks.filter((p) => drawn.includes(p))
    return { status: 'settled', multiplier: table[hits.length], outcome: { picks, drawn, hits, table } }
  })
})

export const playLimbo = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playLimbo', context.auth?.token)
  return startRound(uid, 'limbo', data ?? {}, (c) => {
    const target = X.floor2(Number(data?.target))
    if (!(target >= 1.01 && target <= X.LIMBO_MAX)) throw bad(`Choose a target from ×1.01 to ×${X.LIMBO_MAX}.`)
    const result = X.limboResult(c.seed.seed, label('limbo', c.seed), c.edgePct)
    return { status: 'settled', multiplier: result >= target ? target : 0, outcome: { target, result } }
  })
})

export const spinRoulette = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'spinRoulette', context.auth?.token)
  return startRound(uid, 'roulette', data ?? {}, (c) => {
    const bet = X.ROULETTE_BETS.includes(data?.bet as X.RouletteBet) ? (data.bet as X.RouletteBet) : null
    if (!bet) throw bad('Choose a bet.')
    const pick = Math.trunc(Number(data?.pick ?? 0))
    if (bet === 'straight' && !(pick >= 0 && pick <= 36)) throw bad('Choose a number from 0 to 36.')
    if ((bet === 'dozen' || bet === 'column') && !(pick >= 1 && pick <= 3)) throw bad('Choose 1, 2 or 3.')
    const pocket = X.roulettePocket(c.seed.seed, label('roulette', c.seed))
    const pays = X.rouletteMultiplier(bet, c.edgePct)
    const won = X.rouletteWins(pocket, bet, pick)
    return { status: 'settled', multiplier: won ? pays : 0, outcome: { bet, pick, pocket, red: X.RED.has(pocket), pays } }
  })
})

export const playDragonTiger = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playDragonTiger', context.auth?.token)
  return startRound(uid, 'dragon_tiger', data ?? {}, (c) => {
    const side = ['dragon', 'tiger', 'tie'].includes(String(data?.side)) ? String(data.side) : null
    if (!side) throw bad('Choose Dragon, Tiger or Tie.')
    const { dragon, tiger } = X.dragonTigerDeal(c.seed.seed, label('dragon_tiger', c.seed))
    const d = X.dtValue(dragon)
    const t = X.dtValue(tiger)
    const winner = d > t ? 'dragon' : t > d ? 'tiger' : 'tie'
    const pays = X.dragonTigerMultipliers(c.edgePct)
    const multiplier = side === 'tie'
      ? (winner === 'tie' ? pays.tie : 0)
      : winner === 'tie' ? pays.tieRefund : winner === side ? pays.side : 0
    return { status: 'settled', multiplier, outcome: { side, dragon, tiger, winner, pays } }
  })
})

export const playAndarBahar = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'playAndarBahar', context.auth?.token)
  return startRound(uid, 'andar_bahar', data ?? {}, (c) => {
    const side = data?.side === 'andar' ? 'andar' : data?.side === 'bahar' ? 'bahar' : null
    if (!side) throw bad('Choose Andar or Bahar.')
    const deal = X.andarBaharDeal(c.seed.seed, label('andar_bahar', c.seed))
    const pays = X.andarBaharMultipliers(c.edgePct)
    return {
      status: 'settled', multiplier: deal.winner === side ? pays[side] : 0,
      outcome: { side, joker: deal.joker, dealt: deal.dealt, winner: deal.winner, pays },
    }
  })
})

// ── Multi-step rounds: one step at a time, settled exactly once ───────────────

type Advance =
  | { kind: 'continue'; outcome: Record<string, unknown>; reply?: Record<string, unknown> }
  | { kind: 'settle'; multiplier: number; outcome: Record<string, unknown> }
  | { kind: 'stale' }

async function advanceOpen(
  uid: string, roundId: string, gameId: GameId,
  step: (round: Record<string, unknown>, secret: Record<string, unknown>) => Advance,
): Promise<Record<string, unknown>> {
  if (!roundId) throw new functions.https.HttpsError('invalid-argument', 'roundId is required.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [rSnap, sSnap, uSnap] = await Promise.all([tx.get(roundRef(roundId)), tx.get(secretRef(roundId)), tx.get(userRef(uid))])
    if (!rSnap.exists) throw new functions.https.HttpsError('not-found', 'That round no longer exists.')
    const round = rSnap.data() as Record<string, unknown>
    if (round.uid !== uid || round.gameId !== gameId) throw new functions.https.HttpsError('permission-denied', 'That is not your round.')
    if (round.status === 'settled') {
      return { roundId, status: 'settled', outcome: round.outcome, multiplier: round.multiplier, payout: round.payout, already: true }
    }
    const a = step(round, (sSnap.data() ?? {}) as Record<string, unknown>)
    if (a.kind === 'stale') return { roundId, status: 'open', outcome: round.outcome, stale: true }
    if (a.kind === 'continue') {
      tx.update(roundRef(roundId), { outcome: a.outcome })
      return { roundId, status: 'open', outcome: a.outcome, ...(a.reply ?? {}) }
    }
    const entry = Number(round.entry) || 0
    const payout = M.payoutFor(entry, a.multiplier)
    const balance = creditPlayer(tx, userRef(uid), Number(uSnap.get('diamonds') ?? 0), payout, 'win', { gameId, roundId })
    history(tx, uid, roundId, gameId, entry, payout, { multiplier: a.multiplier })
    tx.update(roundRef(roundId), { status: 'settled', outcome: a.outcome, multiplier: a.multiplier, payout, settledAtMs: nowMs })
    return { roundId, status: 'settled', outcome: a.outcome, multiplier: a.multiplier, payout, balance }
  })
}

const HILO_CAP = 10_000

export const hiloStart = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'hiloStart', context.auth?.token)
  return startRound(uid, 'hilo', data ?? {}, (c) => {
    const cards = X.hiloCards(c.seed.seed, label('hilo', c.seed))
    return {
      status: 'open',
      outcome: { edgePct: c.edgePct, index: 0, current: cards[0], multiplier: 1, raw: 1, guesses: 0, trail: [{ card: cards[0], guess: 'start' }] },
      secret: { cards },
    }
  })
})

export const hiloGuess = functions.region(REGION).https.onCall(async (data: { roundId?: string; guess?: string; step?: number }, context) => {
  const uid = requireAuth(context)
  const guess = String(data?.guess ?? '')
  if (!['higher', 'lower', 'skip'].includes(guess)) throw bad('Guess higher, lower, or skip.')
  return advanceOpen(uid, String(data?.roundId ?? ''), 'hilo', (round, secret) => {
    const o = round.outcome as { edgePct: number; index: number; current: number; multiplier: number; raw: number; guesses: number; trail: Array<Record<string, unknown>> }
    if (Number.isInteger(data?.step) && data!.step !== o.index) return { kind: 'stale' }
    const cards = secret.cards as number[]
    const next = cards[o.index + 1]
    const trail = [...o.trail]
    if (guess === 'skip') {
      trail.push({ card: next, guess: 'skip' })
      const out = { ...o, index: o.index + 1, current: next, trail }
      // The shoe is long, not endless: at its end the round pays what it stands at (or returns the entry).
      if (o.index + 2 >= cards.length) return { kind: 'settle', multiplier: o.guesses > 0 ? o.multiplier : 1, outcome: out }
      return { kind: 'continue', outcome: out }
    }
    const g = guess as 'higher' | 'lower'
    if (X.hiloChance(o.current, g) >= 1) throw new functions.https.HttpsError('failed-precondition', 'That guess cannot lose — skip the card instead.')
    if (!X.hiloCorrect(o.current, next, g)) {
      trail.push({ card: next, guess: g, correct: false })
      return { kind: 'settle', multiplier: 0, outcome: { ...o, index: o.index + 1, current: next, trail, lost: true } }
    }
    const raw = Math.min(HILO_CAP, o.raw * X.hiloFactor(o.current, g, o.edgePct))
    const multiplier = X.floor2(raw)
    trail.push({ card: next, guess: g, correct: true })
    const out = { ...o, index: o.index + 1, current: next, raw, multiplier, guesses: o.guesses + 1, trail }
    if (raw >= HILO_CAP || o.index + 2 >= cards.length) return { kind: 'settle', multiplier, outcome: out }
    return { kind: 'continue', outcome: out }
  })
})

export const hiloCashout = functions.region(REGION).https.onCall(async (data: { roundId?: string }, context) => {
  const uid = requireAuth(context)
  return advanceOpen(uid, String(data?.roundId ?? ''), 'hilo', (round) => {
    const o = round.outcome as { guesses: number; multiplier: number }
    if (o.guesses <= 0) throw new functions.https.HttpsError('failed-precondition', 'Guess at least once first.')
    return { kind: 'settle', multiplier: o.multiplier, outcome: { ...o, cashedOut: true } }
  })
})

export const minesStart = functions.region(REGION).https.onCall(async (data: Record<string, unknown>, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'minesStart', context.auth?.token)
  return startRound(uid, 'mines', data ?? {}, (c) => {
    const mines = Math.trunc(Number(data?.mines))
    if (!(mines >= 1 && mines <= 24)) throw bad('Choose 1 to 24 mines.')
    const layout = X.minesLayout(c.seed.seed, label('mines', c.seed), mines)
    return {
      status: 'open',
      outcome: { edgePct: c.edgePct, mineCount: mines, revealed: [], multiplier: 1, next: X.minesMultiplier(mines, 1, c.edgePct) },
      secret: { minePositions: layout },
    }
  })
})

export const minesReveal = functions.region(REGION).https.onCall(async (data: { roundId?: string; tile?: number }, context) => {
  const uid = requireAuth(context)
  const tile = Math.trunc(Number(data?.tile))
  if (!(tile >= 0 && tile < X.MINES_TILES)) throw bad('Choose a tile.')
  return advanceOpen(uid, String(data?.roundId ?? ''), 'mines', (round, secret) => {
    const o = round.outcome as { edgePct: number; mineCount: number; revealed: number[]; multiplier: number }
    if (o.revealed.includes(tile)) return { kind: 'stale' }
    const minePositions = secret.minePositions as number[]
    if (minePositions.includes(tile)) {
      return { kind: 'settle', multiplier: 0, outcome: { ...o, hit: tile, minePositions } }
    }
    const revealed = [...o.revealed, tile]
    const multiplier = X.minesMultiplier(o.mineCount, revealed.length, o.edgePct)
    if (revealed.length >= X.MINES_TILES - o.mineCount) {
      return { kind: 'settle', multiplier, outcome: { ...o, revealed, multiplier, minePositions, cleared: true } }
    }
    return { kind: 'continue', outcome: { ...o, revealed, multiplier, next: X.minesMultiplier(o.mineCount, revealed.length + 1, o.edgePct) } }
  })
})

export const minesCashout = functions.region(REGION).https.onCall(async (data: { roundId?: string }, context) => {
  const uid = requireAuth(context)
  return advanceOpen(uid, String(data?.roundId ?? ''), 'mines', (round, secret) => {
    const o = round.outcome as { revealed: number[]; multiplier: number }
    if (o.revealed.length <= 0) throw new functions.https.HttpsError('failed-precondition', 'Find at least one gem first.')
    return { kind: 'settle', multiplier: o.multiplier, outcome: { ...o, cashedOut: true, minePositions: secret.minePositions } }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  Fairness
// ══════════════════════════════════════════════════════════════════════════════

/** The commitment for the player's NEXT rounds — shown before they play. */
export const gameFairness = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context)
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(seedRef(uid))
    const s = seedStateOf(snap)
    if (s.fresh) tx.set(seedRef(uid), { seed: s.seed, commit: s.commit, clientSeed: '', nonce: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() })
    return { commit: s.commit, clientSeed: s.clientSeed, nonce: s.nonce }
  })
})

/** Reveal the current seed (so every past round can be checked) and start a new one, with a new client seed. */
export const rotateGameSeed = functions.region(REGION).https.onCall(async (data: { clientSeed?: string }, context) => {
  const uid = requireAuth(context)
  const clientSeed = String(data?.clientSeed ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(seedRef(uid))
    const old = seedStateOf(snap)
    const seed = newSeed()
    tx.set(seedRef(uid), { seed, commit: commitOf(seed), clientSeed, nonce: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() })
    return { revealed: old.fresh ? null : { seed: old.seed, commit: old.commit, clientSeed: old.clientSeed, rounds: old.nonce }, next: { commit: commitOf(seed), clientSeed, nonce: 0 } }
  })
})
