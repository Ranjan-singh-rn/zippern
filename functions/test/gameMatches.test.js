/**
 * B4 (3 Nov 2026) — multiplayer games: entry escrow, turns, settlement, refunds. The SHIPPED callables
 * (lib/games/matches.js) over the in-memory Firestore in optimistic-transaction mode.
 *
 * The owner's example is pinned exactly: Player A enters 100, Player B enters 100, the pool is 200, the winner
 * receives 150 and Zipper keeps 50 — debits 100 + 100 = credit 150 + fee 50, unexplained difference 0, every
 * movement a ledger row on the player's history AND in `gameLedger`.
 *
 * Also: switched off by default; insufficient diamonds; duplicate requests (idempotency keys, stale steps); not your
 * turn; private invite codes; leaving before the start (refund) and during play (forfeit → the other player wins);
 * the sweep refunding a match that never filled and playing an overdue turn; 4 players (400 → 300 / 100); quick
 * match pairing two players.
 *
 * Run:  node --test test/gameMatches.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const G = require('../lib/games/matches')
const R = require('../lib/games/rng')
const L = require('../lib/games/ludoEngine')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let keyN = 0
const key = () => `key-${++keyN}-abcdefgh`

const ON = { enabled: true, games: { ludo: { enabled: true, entryOptions: [100, 500], platformFeePct: 25, modes: [2, 4, 6], turnSeconds: 30, waitMinutes: 10 } } }
const diamonds = (uid) => db.read(`users/${uid}`).diamonds
const match = (id) => db.read(`gameMatches/${id}`)
const ledger = (id) => db.all('gameLedger').filter((r) => r.matchId === id)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  for (const u of ['A', 'B', 'C', 'D']) db.seed(`users/${u}`, { name: u, diamonds: 1000 })
})

/** Make the current player's next roll win the game, using the match's own seed — the die is not chosen, it is read. */
function rigWinningRoll(id) {
  const m = match(id)
  const seed = db.read(`gameMatches/${id}/private/meta`).seed
  const s = m.state
  const die = R.rollDie(seed, `${id}:roll:${s.turnNumber}:${s.step}`)
  const home = L.geometry(s.arms).home
  // The stored state keeps the tokens flat, four per player (Firestore has no arrays inside arrays).
  const tokens = s.armOf.flatMap((_, i) => (i === s.turn ? [home - die, home, home, home] : [-1, -1, -1, -1]))
  db.seed(`gameMatches/${id}`, { ...m, state: { ...s, tokens } })
  return { player: s.turn, uid: m.seats[s.turn].uid }
}

async function twoPlayerMatch(entry = 100) {
  const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry, idempotencyKey: key() })
  await call(G.joinGameMatch, 'B', { matchId: made.matchId, idempotencyKey: key() })
  return made.matchId
}

describe('switched off unless switched on', () => {
  test('no appConfig/games: every game refused', async () => {
    db._docs.delete('appConfig/games')
    const e = await refusal(call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() }))
    expect(e.details.code).toBe('GAME_DISABLED')
    expect(diamonds('A')).toBe(1000)
  })
  test('the catalogue lists only switched-on games', async () => {
    const c = await call(G.gameCatalog, 'A', {})
    expect(c.games.map((g) => g.gameId)).toEqual(['ludo'])
    expect(c.diamonds).toBe(1000)
  })
  test('maintenance refuses new entries', async () => {
    db.seed('appConfig/games', { ...ON, games: { ludo: { ...ON.games.ludo, maintenance: true } } })
    const e = await refusal(call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() }))
    expect(e.details.code).toBe('GAME_MAINTENANCE')
  })
})

describe("the owner's example: 100 + 100 → winner 150, Zipper 50", () => {
  test('entries are debited into the match; it starts when full', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() })
    expect(diamonds('A')).toBe(900)
    expect(match(made.matchId).status).toBe('waiting')
    const j = await call(G.joinGameMatch, 'B', { matchId: made.matchId, idempotencyKey: key() })
    expect(j.started).toBe(true)
    const m = match(made.matchId)
    expect(m.status).toBe('playing')
    expect(m.pool).toBe(200)
    expect(diamonds('B')).toBe(900)
    expect(m.commit).toBe(R.commitOf(db.read(`gameMatches/${made.matchId}/private/meta`).seed))
    expect(m.seed).toBe(undefined)                          // not revealed while playing
  })

  test('the winner gets 150, Zipper 50, and it all balances', async () => {
    const id = await twoPlayerMatch()
    const w = rigWinningRoll(id)
    const r = await call(G.ludoAction, w.uid, { matchId: id, action: 'roll' })
    expect(r.finished).toBe(true)
    const m = match(id)
    expect(m.status).toBe('finished')
    expect(m.winners).toEqual([w.uid])
    expect(m.payouts).toEqual({ [w.uid]: 150 })
    expect(m.fee).toBe(50)
    expect(R.verifyCommit(m.seed, m.commit)).toBe(true)     // revealed, and it matches what was published
    const loser = w.uid === 'A' ? 'B' : 'A'
    expect(diamonds(w.uid)).toBe(900 + 150)
    expect(diamonds(loser)).toBe(900)
    const rows = ledger(id)
    const sum = (k) => rows.filter((x) => x.kind === k).reduce((a, x) => a + x.diamonds, 0)
    expect(sum('entry')).toBe(200)
    expect(sum('payout')).toBe(150)
    expect(sum('fee')).toBe(50)
    expect(sum('entry') - sum('payout') - sum('fee')).toBe(0)
    expect(db.read(`users/${w.uid}/diamondTransactions/game_${id}_payout`).amount).toBe(150)
    expect(db.read(`users/${loser}/diamondTransactions/game_${id}_entry`).amount).toBe(100)
    expect(db.read(`users/${w.uid}/gameHistory/${id}`).result).toBe('won')
    expect(db.read(`users/${loser}/gameHistory/${id}`).result).toBe('lost')
  })

  test('4 players: 400 → winner 300, Zipper 100', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 4, entry: 100, idempotencyKey: key() })
    for (const u of ['B', 'C', 'D']) await call(G.joinGameMatch, u, { matchId: made.matchId, idempotencyKey: key() })
    expect(match(made.matchId).status).toBe('playing')
    const w = rigWinningRoll(made.matchId)
    await call(G.ludoAction, w.uid, { matchId: made.matchId, action: 'roll' })
    expect(match(made.matchId).payouts).toEqual({ [w.uid]: 300 })
    expect(match(made.matchId).fee).toBe(100)
  })
})

describe('refusals and duplicates', () => {
  test('not enough diamonds: refused, nothing moves', async () => {
    db.seed('users/C', { name: 'C', diamonds: 50 })
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() })
    const e = await refusal(call(G.joinGameMatch, 'C', { matchId: made.matchId, idempotencyKey: key() }))
    expect(e.details.code).toBe('INSUFFICIENT_DIAMONDS')
    expect(diamonds('C')).toBe(50)
    expect(match(made.matchId).seats.length).toBe(1)
  })
  test('an entry not on the list is refused', async () => {
    const e = await refusal(call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 77, idempotencyKey: key() }))
    expect(e.details.code).toBe('BAD_ENTRY')
  })
  test('the same create request twice: one match, one debit', async () => {
    const k = key()
    const a = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: k })
    const b = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: k })
    expect(b.matchId).toBe(a.matchId)
    expect(b.replayed).toBe(true)
    expect(diamonds('A')).toBe(900)
  })
  test('joining twice is one seat', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 4, entry: 100, idempotencyKey: key() })
    await call(G.joinGameMatch, 'B', { matchId: made.matchId, idempotencyKey: key() })
    const again = await call(G.joinGameMatch, 'B', { matchId: made.matchId, idempotencyKey: key() })
    expect(again.already).toBe(true)
    expect(diamonds('B')).toBe(900)
  })
  test('not your turn is refused; a stale step changes nothing', async () => {
    const id = await twoPlayerMatch()
    const m = match(id)
    const other = m.seats[1 - m.state.turn].uid
    const e = await refusal(call(G.ludoAction, other, { matchId: id, action: 'roll' }))
    expect(e.message).toContain('not your turn')
    const mine = m.seats[m.state.turn].uid
    const r = await call(G.ludoAction, mine, { matchId: id, action: 'roll', step: m.state.step + 7 })
    expect(r.stale).toBe(true)
    expect(match(id).state.step).toBe(m.state.step)
  })
  test('a stranger cannot act or time out a game', async () => {
    const id = await twoPlayerMatch()
    expect((await refusal(call(G.ludoAction, 'C', { matchId: id, action: 'roll' }))).code).toBe('permission-denied')
    expect((await refusal(call(G.claimGameTimeout, 'C', { matchId: id }))).code).toBe('permission-denied')
  })
})

describe('private matches', () => {
  test('wrong code refused, right code joins', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, visibility: 'private', idempotencyKey: key() })
    expect(made.inviteCode.length).toBe(6)
    expect(match(made.matchId).inviteCode).toBe(undefined)          // never on the readable match document
    const bad = await refusal(call(G.joinGameMatch, 'B', { matchId: made.matchId, inviteCode: '000000' === made.inviteCode ? '111111' : '000000', idempotencyKey: key() }))
    expect(bad.details.code).toBe('BAD_INVITE')
    expect(diamonds('B')).toBe(1000)
    const ok = await call(G.joinGameMatch, 'B', { matchId: made.matchId, inviteCode: made.inviteCode, idempotencyKey: key() })
    expect(ok.started).toBe(true)
  })
})

describe('leaving, timeouts and the sweep', () => {
  test('leaving before the start refunds; the last one out cancels', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 4, entry: 100, idempotencyKey: key() })
    await call(G.joinGameMatch, 'B', { matchId: made.matchId, idempotencyKey: key() })
    await call(G.leaveGameMatch, 'B', { matchId: made.matchId })
    expect(diamonds('B')).toBe(1000)
    expect(match(made.matchId).pool).toBe(100)
    await call(G.leaveGameMatch, 'A', { matchId: made.matchId })
    expect(diamonds('A')).toBe(1000)
    expect(match(made.matchId).status).toBe('cancelled')
  })
  test('leaving during play forfeits: the other player wins 150', async () => {
    const id = await twoPlayerMatch()
    await call(G.leaveGameMatch, 'A', { matchId: id })
    const m = match(id)
    expect(m.status).toBe('finished')
    expect(m.winners).toEqual(['B'])
    expect(diamonds('B')).toBe(1050)
    expect(diamonds('A')).toBe(900)
  })
  test('a match that never fills is refunded by the sweep', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() })
    db.seed(`gameMatches/${made.matchId}`, { ...match(made.matchId), waitUntilMs: Date.now() - 1000 })
    const r = await G.sweepGameMatchesOnce(Date.now())
    expect(r.refunded).toBe(1)
    expect(diamonds('A')).toBe(1000)
    expect(match(made.matchId).status).toBe('cancelled')
    const rows = ledger(made.matchId)
    expect(rows.filter((x) => x.kind === 'refund').reduce((a, x) => a + x.diamonds, 0)).toBe(100)
  })
  test('an overdue turn is played by the server and counted as a miss', async () => {
    const id = await twoPlayerMatch()
    const m = match(id)
    const absent = m.state.turn
    db.seed(`gameMatches/${id}`, { ...m, deadlineMs: Date.now() - 60_000 })
    const r = await G.sweepGameMatchesOnce(Date.now())
    expect(r.timedOut).toBe(1)
    expect(match(id).state.missed[absent]).toBe(1)
  })
  test('claiming a timeout before the deadline does nothing', async () => {
    const id = await twoPlayerMatch()
    const r = await call(G.claimGameTimeout, 'A', { matchId: id })
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('not_yet')
  })
})

describe('quick match and rematch', () => {
  test('two quick-match requests with the same game, size and entry end up in one match', async () => {
    const a = await call(G.quickGameMatch, 'A', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() })
    expect(a.created).toBe(true)
    const b = await call(G.quickGameMatch, 'B', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() })
    expect(b.matchId).toBe(a.matchId)
    expect(b.started).toBe(true)
  })
  test('a rematch is private and the last players join it without a code', async () => {
    const id = await twoPlayerMatch()
    await call(G.leaveGameMatch, 'A', { matchId: id })               // B wins
    const re = await call(G.rematchGameMatch, 'B', { matchId: id, idempotencyKey: key() })
    expect(match(re.matchId).visibility).toBe('private')
    const j = await call(G.joinGameMatch, 'A', { matchId: re.matchId, idempotencyKey: key() })
    expect(j.started).toBe(true)
    const e = await refusal(call(G.joinGameMatch, 'C', { matchId: re.matchId, idempotencyKey: key() }))
    expect(e != null).toBe(true)
  })
})
