/**
 * B4 (3 Nov 2026) — Teen Patti: the hand rules (pure engine) and the SHIPPED callables (lib/games/matches.js) over
 * the in-memory Firestore in optimistic-transaction mode.
 *
 * Money is the point: every boot and every bet is a debit row on the player's history AND in `gameLedger`, the pot
 * goes to the best hand less the table fee, and for every match Σ debits = Σ payouts + fee — unexplained difference
 * zero. The hands are dealt from the match seed, kept off the readable match document until the end, and can be
 * re-dealt from the revealed seed by anybody.
 *
 * Run:  node --test test/teenPatti.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const G = require('../lib/games/matches')
const R = require('../lib/games/rng')
const TP = require('../lib/games/teenPattiEngine')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let keyN = 0
const key = () => `key-${++keyN}-abcdefgh`

// Cards: rank index in '23456789TJQKA', suit 0..3 (♠ ♥ ♦ ♣).
const c = (rank, suit) => suit * 13 + TP.RANKS.indexOf(rank)
const hand = (s) => s.split(' ').map((x) => c(x[0], '♠♥♦♣'.indexOf(x[1])))

const ON = {
  enabled: true,
  games: { teen_patti: { enabled: true, entryOptions: [100, 500], platformFeePct: 10, modes: [2, 3, 4, 5, 6], turnSeconds: 30, waitMinutes: 10, potLimitX: 8 } },
}
const diamonds = (uid) => db.read(`users/${uid}`).diamonds
const match = (id) => db.read(`gameMatches/${id}`)
const meta = (id) => db.read(`gameMatches/${id}/private/meta`)
const ledger = (id) => db.all('gameLedger').filter((r) => r.matchId === id)
const sumKind = (id, k) => ledger(id).filter((x) => x.kind === k).reduce((a, x) => a + x.diamonds, 0)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  for (const u of ['A', 'B', 'C', 'D', 'E', 'F']) db.seed(`users/${u}`, { name: u, diamonds: 1000 })
})

async function table(players = 2, boot = 100) {
  const made = await call(G.createGameMatch, 'A', { gameId: 'teen_patti', players, entry: boot, idempotencyKey: key() })
  for (const u of ['B', 'C', 'D', 'E', 'F'].slice(0, players - 1)) {
    await call(G.joinGameMatch, u, { matchId: made.matchId, idempotencyKey: key() })
  }
  return made.matchId
}

/** Replace the dealt hands (tests only — the server deals from the seed). */
function rig(id, hands) {
  db.seed(`gameMatches/${id}/private/meta`, { ...meta(id), hands: hands.map((h) => ({ cards: hand(h) })) })
}

const onTurn = (id) => { const m = match(id); return { i: m.state.turn, uid: m.seats[m.state.turn].uid, step: m.state.step } }

function balances(id) {
  const debits = sumKind(id, 'entry')
  const payouts = sumKind(id, 'payout')
  const fee = sumKind(id, 'fee')
  expect(debits - payouts - fee).toBe(0)
  return { debits, payouts, fee }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('hands, best first', () => {
  const beats = (a, b) => expect(TP.compareHands(hand(a), hand(b)) > 0).toBe(true)
  test('trail > pure sequence > sequence > colour > pair > high card', () => {
    beats('2♠ 2♥ 2♦', 'A♠ K♠ Q♠')
    beats('A♠ K♠ Q♠', 'A♠ K♥ Q♦')
    beats('2♠ 3♥ 4♦', 'A♠ K♠ 9♠')
    beats('5♠ 9♠ 2♠', 'A♠ A♥ K♦')
    beats('2♠ 2♥ 3♦', 'A♠ K♥ 9♦')
  })
  test('sequences: A-K-Q highest, A-2-3 second, then K-Q-J … 4-3-2', () => {
    beats('A♠ K♥ Q♦', 'A♠ 2♥ 3♦')
    beats('A♠ 2♥ 3♦', 'K♠ Q♥ J♦')
    beats('K♠ Q♥ J♦', '4♠ 3♥ 2♦')
    beats('A♥ 2♥ 3♥', 'K♣ Q♣ J♣')           // the same order inside pure sequences
    expect(TP.evaluate(hand('K♠ A♥ 2♦')).name).toBe('High card')   // no wrap-around
  })
  test('trails by rank; pairs by pair then kicker; colour and high card card by card', () => {
    beats('A♠ A♥ A♦', 'K♠ K♥ K♦')
    beats('K♠ K♥ 2♦', 'Q♠ Q♥ A♦')
    beats('K♠ K♥ 5♦', 'K♦ K♣ 4♠')
    beats('A♠ K♠ 9♠', 'A♥ K♥ 8♥')
    beats('A♠ K♥ 9♦', 'A♥ K♦ 8♣')
  })
  test('the same ranks in other suits are equal', () => {
    expect(TP.compareHands(hand('A♠ K♥ 9♦'), hand('A♥ K♦ 9♣'))).toBe(0)
    expect(TP.bestOf([hand('A♠ K♥ 9♦'), hand('A♥ K♦ 9♣'), hand('2♠ 3♥ 7♦')], [0, 1, 2])).toEqual([0, 1])
  })
  test('a deal is three different cards each, the same every time for the same seed', () => {
    const seed = R.newSeed()
    const d = TP.deal(seed, 'm1', 6)
    expect(d.length).toBe(6)
    expect(new Set(d.flat()).size).toBe(18)
    expect(TP.deal(seed, 'm1', 6)).toEqual(d)
    expect(TP.deal(seed, 'm2', 6)).not.toEqual(d)
  })
})

describe('the betting rules', () => {
  const H = [hand('2♠ 3♥ 7♦'), hand('A♠ A♥ 2♦'), hand('K♠ Q♥ 9♦')]
  test('blind pays the stake, seen pays twice; a raise doubles the stake first', () => {
    let s = TP.newTeenPatti(2, 100, 128, 0)
    expect(s.pot).toBe(200)
    let r = TP.act(s, 0, 'chaal', H)
    expect(r.cost).toBe(100)
    s = TP.see(r.state, 1)
    r = TP.act(s, 1, 'chaal', H)
    expect(r.cost).toBe(200)
    r = TP.act(r.state, 0, 'raise', H)
    expect(r.cost).toBe(200)                                  // blind at the doubled stake
    expect(r.state.stake).toBe(200)
    expect(r.state.paid).toEqual([400, 300])
    expect(r.state.pot).toBe(700)
  })
  test('seeing your cards does not make another player\'s tap stale', () => {
    const s = TP.newTeenPatti(3, 100, 128, 0)
    expect(TP.see(s, 2).step).toBe(s.step)
  })
  test('the last player in wins without a show', () => {
    let r = TP.act(TP.newTeenPatti(3, 100, 128, 0), 0, 'pack', H)
    r = TP.act(r.state, 1, 'pack', H)
    expect(r.state.winners).toEqual([2])
    expect(r.state.endedBy).toBe('packed')
  })
  test('a show needs exactly two players; the better hand takes it', () => {
    const s = TP.newTeenPatti(3, 100, 128, 0)
    expect(() => TP.act(s, 0, 'show', H)).toThrow('two players')
    const r = TP.act(TP.act(s, 0, 'pack', H).state, 1, 'show', H)
    expect(r.state.winners).toEqual([1])
    expect(r.state.endedBy).toBe('show')
  })
  test('the pot limit makes everyone still in show', () => {
    let s = TP.newTeenPatti(3, 100, 4, 0)                      // limit 400, pot 300
    const r = TP.act(s, 0, 'chaal', H)
    expect(r.state.winners).toEqual([1])
    expect(r.state.endedBy).toBe('pot_limit')
    s = r.state
    expect(s.pot).toBe(400)
  })
  test('out of turn is refused; a forfeit off-turn keeps the turn where it is', () => {
    const s = TP.newTeenPatti(3, 100, 128, 0)
    expect(() => TP.act(s, 1, 'chaal', H)).toThrow('not your turn')
    const f = TP.forfeit(s, 2)
    expect(f.turn).toBe(0)
    expect(f.packed).toEqual([false, false, true])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a table: boots, cards, and who sees what', () => {
  test('the catalogue offers Teen Patti as playable', async () => {
    const cat = await call(G.gameCatalog, 'A', {})
    expect(cat.games.find((g) => g.gameId === 'teen_patti').playable).toBe(true)
  })
  test('boots are debited; the hands stay off the readable match; cards only after seeing them', async () => {
    const id = await table(2)
    const m = match(id)
    expect(m.status).toBe('playing')
    expect(m.pool).toBe(200)
    expect(m.state.pot).toBe(200)
    expect(diamonds('A')).toBe(900)
    expect(diamonds('B')).toBe(900)
    expect(JSON.stringify(m).includes('hands')).toBe(false)
    expect(meta(id).hands.length).toBe(2)
    const before = await call(G.teenPattiMyCards, 'A', { matchId: id })
    expect(before).toEqual({ cards: [], seen: false })
    const seen = await call(G.teenPattiAction, 'A', { matchId: id, action: 'see' })
    expect(seen.cards.length).toBe(3)
    expect(match(id).state.seen[0]).toBe(true)
    const after = await call(G.teenPattiMyCards, 'A', { matchId: id })
    expect(after.cards).toEqual(seen.cards)
    expect((await refusal(call(G.teenPattiMyCards, 'C', { matchId: id }))).code).toBe('permission-denied')
  })
  test('a packed player cannot look any more: a clear refusal, not a crash', async () => {
    const id = await table(3)
    const t = onTurn(id)
    await call(G.teenPattiAction, t.uid, { matchId: id, action: 'pack', step: t.step })
    const e = await refusal(call(G.teenPattiAction, t.uid, { matchId: id, action: 'see' }))
    expect(e.code).toBe('failed-precondition')
    expect(e.message).toContain('packed')
  })
  test('not your turn, a stale step and a stranger are refused; nothing moves', async () => {
    const id = await table(2)
    const t = onTurn(id)
    const other = match(id).seats[1 - t.i].uid
    const e = await refusal(call(G.teenPattiAction, other, { matchId: id, action: 'chaal' }))
    expect(e.message).toContain('not your turn')
    const stale = await call(G.teenPattiAction, t.uid, { matchId: id, action: 'chaal', step: t.step + 3 })
    expect(stale.stale).toBe(true)
    expect((await refusal(call(G.teenPattiAction, 'C', { matchId: id, action: 'chaal' }))).code).toBe('permission-denied')
    expect(diamonds('A') + diamonds('B')).toBe(1800)
  })
})

describe('the money', () => {
  test('pack: the other player takes the pot less 10% — 200 → 180 + 20', async () => {
    const id = await table(2)
    const t = onTurn(id)
    const other = match(id).seats[1 - t.i].uid
    const r = await call(G.teenPattiAction, t.uid, { matchId: id, action: 'pack', step: t.step })
    expect(r.finished).toBe(true)
    const m = match(id)
    expect(m.winners).toEqual([other])
    expect(m.payouts).toEqual({ [other]: 180 })
    expect(m.fee).toBe(20)
    expect(diamonds(other)).toBe(900 + 180)
    expect(diamonds(t.uid)).toBe(900)
    expect(balances(id)).toEqual({ debits: 200, payouts: 180, fee: 20 })
    expect(R.verifyCommit(m.seed, m.commit)).toBe(true)
    // Anyone can re-deal the hands from the revealed seed and check the reveal.
    expect(m.reveal.map((x) => x.cards)).toEqual(TP.deal(m.seed, id, 2))
  })

  test('chaal, see, show: every bet its own row, the showing player wins and is paid on top of their bet', async () => {
    const id = await table(2)
    const p = onTurn(id)
    const q = match(id).seats[1 - p.i].uid
    const hands = p.i === 0 ? ['2♠ 3♥ 7♦', 'A♠ A♥ 2♦'] : ['A♠ A♥ 2♦', '2♠ 3♥ 7♦']
    rig(id, hands)                                            // q holds the pair of aces
    await call(G.teenPattiAction, p.uid, { matchId: id, action: 'chaal', step: p.step })         // blind: 100
    expect(match(id).state.pot).toBe(300)
    await call(G.teenPattiAction, q, { matchId: id, action: 'see' })
    const s = match(id).state
    const r = await call(G.teenPattiAction, q, { matchId: id, action: 'show', step: s.step })   // seen: 200
    expect(r.finished).toBe(true)
    const m = match(id)
    expect(m.state.endedBy).toBe('show')
    expect(m.pool).toBe(500)
    expect(m.winners).toEqual([q])
    expect(m.payouts).toEqual({ [q]: 450 })
    expect(m.fee).toBe(50)
    expect(diamonds(p.uid)).toBe(1000 - 200)
    expect(diamonds(q)).toBe(1000 - 300 + 450)
    expect(balances(id)).toEqual({ debits: 500, payouts: 450, fee: 50 })
    // The bet rows are distinct; the payout row's balance reflects the bet taken in the same transaction.
    const qRows = db.all(`users/${q}/diamondTransactions`).filter((x) => x.matchId === id)
    expect(qRows.filter((x) => x.type === 'debit').map((x) => x.amount).sort()).toEqual([100, 200])
    expect(qRows.find((x) => x.type === 'credit').balanceAfter).toBe(1150)
    expect(db.read(`users/${p.uid}/gameHistory/${id}`)).toMatchObject({ result: 'lost', entry: 200 })
    expect(db.read(`users/${q}/gameHistory/${id}`)).toMatchObject({ result: 'won', entry: 300, payout: 450 })
    expect(m.reveal.find((x) => x.seat === match(id).seats.findIndex((s2) => s2.uid === q)).hand).toBe('Pair')
  })

  test('an equal show splits the pot', async () => {
    const id = await table(2)
    rig(id, ['A♠ K♥ 9♦', 'A♥ K♦ 9♣'])
    const p = onTurn(id)
    const q = match(id).seats[1 - p.i].uid
    await call(G.teenPattiAction, p.uid, { matchId: id, action: 'chaal', step: p.step })
    await call(G.teenPattiAction, q, { matchId: id, action: 'show', step: match(id).state.step })   // blind: 100
    const m = match(id)
    expect(m.pool).toBe(400)
    expect(m.payouts).toEqual({ [p.uid]: 180, [q]: 180 })
    expect(m.fee).toBe(40)
    expect(balances(id)).toEqual({ debits: 400, payouts: 360, fee: 40 })
    expect(diamonds(p.uid) + diamonds(q)).toBe(2000 - 40)
  })

  test('a bet you cannot afford is refused and nothing moves; you can still pack', async () => {
    const id = await table(2)
    const p = onTurn(id)
    db.seed(`users/${p.uid}`, { ...db.read(`users/${p.uid}`), diamonds: 50 })
    const e = await refusal(call(G.teenPattiAction, p.uid, { matchId: id, action: 'chaal', step: p.step }))
    expect(e.details.code).toBe('INSUFFICIENT_DIAMONDS')
    expect(diamonds(p.uid)).toBe(50)
    expect(match(id).state.pot).toBe(200)
    expect(ledger(id).filter((x) => x.kind === 'entry').length).toBe(2)
    const r = await call(G.teenPattiAction, p.uid, { matchId: id, action: 'pack', step: p.step })
    expect(r.finished).toBe(true)
    balances(id)
  })

  test('three players reach the pot limit: everyone still in shows, the best hand takes 800 less 80', async () => {
    const id = await table(3)
    // potLimitX 8 → limit 800; pot starts at 300.
    rig(id, ['2♠ 3♥ 7♦', 'K♠ K♥ 2♦', 'Q♠ J♠ T♠'])            // seat 2: a pure sequence
    for (let k = 0; k < 5; k++) {
      const t = onTurn(id)
      await call(G.teenPattiAction, t.uid, { matchId: id, action: 'chaal', step: t.step })
    }
    const m = match(id)
    expect(m.status).toBe('finished')
    expect(m.state.endedBy).toBe('pot_limit')
    expect(m.pool).toBe(800)
    expect(m.winners).toEqual([m.seats[2].uid])
    expect(m.payouts).toEqual({ [m.seats[2].uid]: 720 })
    expect(balances(id)).toEqual({ debits: 800, payouts: 720, fee: 80 })
    expect(['A', 'B', 'C'].reduce((a, u) => a + diamonds(u), 0)).toBe(3000 - 80)
  })

  test('six players, five pack in turn: the last one in takes 600 less 60', async () => {
    const id = await table(6)
    for (let k = 0; k < 5; k++) {
      const t = onTurn(id)
      await call(G.teenPattiAction, t.uid, { matchId: id, action: 'pack', step: t.step })
    }
    const m = match(id)
    expect(m.status).toBe('finished')
    expect(m.state.endedBy).toBe('packed')
    expect(Object.values(m.payouts)).toEqual([540])
    expect(balances(id)).toEqual({ debits: 600, payouts: 540, fee: 60 })
  })
})

describe('timeouts and leaving', () => {
  test('a turn not taken in time is a pack — the absent player\'s cards are never played', async () => {
    const id = await table(2)
    const t = onTurn(id)
    const other = match(id).seats[1 - t.i].uid
    const early = await call(G.claimGameTimeout, other, { matchId: id })
    expect(early.reason).toBe('not_yet')
    db.seed(`gameMatches/${id}`, { ...match(id), deadlineMs: Date.now() - 1000 })
    const r = await call(G.claimGameTimeout, other, { matchId: id, step: t.step })
    expect(r.applied).toBe(true)
    expect(r.timedOut).toBe(t.i)
    const m = match(id)
    expect(m.winners).toEqual([other])
    expect(m.lastEvent).toMatchObject({ action: 'pack', timedOut: true })
    balances(id)
  })
  test('the sweep packs an overdue turn in a three-player game and play goes on', async () => {
    const id = await table(3)
    const t = onTurn(id)
    db.seed(`gameMatches/${id}`, { ...match(id), deadlineMs: Date.now() - 60_000 })
    const r = await G.sweepGameMatchesOnce(Date.now())
    expect(r.timedOut).toBe(1)
    const m = match(id)
    expect(m.status).toBe('playing')
    expect(m.state.packed[t.i]).toBe(true)
    expect(m.state.turn).not.toBe(t.i)
  })
  test('leaving during play packs you; with two players the other wins', async () => {
    const id = await table(2)
    const r = await call(G.leaveGameMatch, 'B', { matchId: id })
    expect(r.forfeited).toBe(true)
    const m = match(id)
    expect(m.winners).toEqual(['A'])
    expect(diamonds('A')).toBe(900 + 180)
    balances(id)
  })
  test('leaving before the start returns the boot', async () => {
    const made = await call(G.createGameMatch, 'A', { gameId: 'teen_patti', players: 3, entry: 100, idempotencyKey: key() })
    await call(G.leaveGameMatch, 'A', { matchId: made.matchId })
    expect(diamonds('A')).toBe(1000)
    expect(match(made.matchId).status).toBe('cancelled')
  })
})
