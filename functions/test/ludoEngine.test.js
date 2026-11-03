/**
 * B4 (3 Nov 2026) — Ludo's rules, move by move (lib/games/ludoEngine.js, pure) and the provably-fair draws behind
 * every die (lib/games/rng.js).
 *
 * Run:  node --test test/ludoEngine.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const L = require('../lib/games/ludoEngine')
const R = require('../lib/games/rng')

/** A fresh 2-player game where it is player `turn`'s go, with tokens placed as given. */
function game(tokens, { players = 2, turn = 0, tokensToWin = 4 } = {}) {
  const s = L.newLudo(players, tokensToWin, turn)
  tokens.forEach((t, i) => { s.tokens[i] = [...t] })
  return s
}

describe('the board', () => {
  test('2 players sit opposite on the cross; 4 on all arms; 6 on the hexagon', () => {
    expect(L.seating(2)).toEqual({ arms: 4, armOf: [0, 2] })
    expect(L.seating(4)).toEqual({ arms: 4, armOf: [0, 1, 2, 3] })
    expect(L.seating(6)).toEqual({ arms: 6, armOf: [0, 1, 2, 3, 4, 5] })
    expect(() => L.seating(7)).toThrow()
  })
  test('classic geometry: track 0…50, home column 51…55, home 56; six arms: home 82', () => {
    expect(L.geometry(4)).toEqual({ track: 51, home: 56, ring: 52 })
    expect(L.geometry(6)).toEqual({ track: 77, home: 82, ring: 78 })
  })
  test('start squares and star squares are safe; others are not', () => {
    expect(L.isSafeSquare(4, 0)).toBe(true)
    expect(L.isSafeSquare(4, 8)).toBe(true)
    expect(L.isSafeSquare(4, 13)).toBe(true)
    expect(L.isSafeSquare(4, 21)).toBe(true)
    expect(L.isSafeSquare(4, 5)).toBe(false)
  })
  test('relative positions map onto the shared ring from each player\'s own start', () => {
    const s = L.newLudo(2)
    expect(L.absSquare(s, 0, 0)).toBe(0)
    expect(L.absSquare(s, 1, 0)).toBe(26)       // player 2 sits on arm 2: 2 × 13
    expect(L.absSquare(s, 1, 30)).toBe(4)       // wraps
    expect(L.absSquare(s, 0, 51)).toBe(null)    // home column
    expect(L.absSquare(s, 0, -1)).toBe(null)    // yard
  })
})

describe('rolling and moving', () => {
  test('only a 6 brings a token out; with nothing out and no 6 the turn passes', () => {
    const s = L.newLudo(2)
    const r = L.applyRoll(s, 4)
    expect(r.event.passed).toBe(true)
    expect(r.state.turn).toBe(1)
    expect(r.state.turnNumber).toBe(2)
  })
  test('a 6 with every token in the yard: one move (all yard tokens are the same), made for the player; extra turn', () => {
    const s = L.newLudo(2)
    const r = L.applyRoll(s, 6)
    expect(r.event.move.token).toBe(0)
    expect(r.state.tokens[0]).toEqual([0, -1, -1, -1])
    expect(r.state.turn).toBe(0)                 // a 6 rolls again
    expect(r.state.roll).toBe(null)
  })
  test('two different moves wait for the player to choose', () => {
    const s = game([[5, -1, -1, -1], [-1, -1, -1, -1]])
    const r = L.applyRoll(s, 6)
    expect(r.state.roll).toBe(6)
    expect(L.legalMoves(r.state, 6)).toEqual([0, 1])
    const m = L.applyMove(r.state, 1)
    expect(m.state.tokens[0]).toEqual([5, 0, -1, -1])
  })
  test('a capture sends the opponent home to the yard and earns another turn', () => {
    // Player 1's token at its relative 29 sits on ring square (26 + 29) % 52 = 3. Player 0 moves 0 → 3.
    const s = game([[0, -1, -1, -1], [29, -1, -1, -1]])
    const r = L.applyRoll(s, 3)
    expect(r.event.move.captured).toEqual([{ player: 1, token: 0, from: 29 }])
    expect(r.state.tokens[1]).toEqual([-1, -1, -1, -1])
    expect(r.state.turn).toBe(0)
  })
  test('no capture on a safe square', () => {
    // Player 1's token at relative 34 → ring (26 + 34) % 52 = 8, a star square.
    const s = game([[2, -1, -1, -1], [34, -1, -1, -1]])
    // A 6 offers two moves (token 0 forward, or a new token out): the player chooses token 0.
    const r = L.applyMove(L.applyRoll(s, 6).state, 0)
    expect(r.state.tokens[0][0]).toBe(8)
    expect(r.state.tokens[1][0]).toBe(34)
    expect(r.event.move.captured).toEqual([])
  })
  test('home needs an exact roll; reaching it earns another turn', () => {
    const s = game([[53, 56, 56, -1], [-1, -1, -1, -1]])
    expect(L.target(s, 0, 0, 4)).toBe(null)      // 57 overshoots
    const r = L.applyRoll(s, 3)
    expect(r.event.move.home).toBe(true)
    expect(r.state.turn).toBe(0)
  })
  test('three 6s in a row forfeit the turn without moving', () => {
    let s = game([[10, 20, -1, -1], [-1, -1, -1, -1]])
    s = L.applyMove(L.applyRoll(s, 6).state, 0).state
    s = L.applyMove(L.applyRoll(s, 6).state, 0).state
    const third = L.applyRoll(s, 6)
    expect(third.event.forfeitedTurn).toBe(true)
    expect(third.state.turn).toBe(1)
    expect(third.state.tokens[0]).toEqual([22, 20, -1, -1])
  })
  test('the first player with tokensToWin home wins, and the game is over', () => {
    const s = game([[55, 56, 56, 56], [-1, -1, -1, -1]])
    const r = L.applyRoll(s, 1)
    expect(r.state.winner).toBe(0)
    expect(() => L.applyRoll(r.state, 2)).toThrow()
  })
  test('a quick game: one token home wins', () => {
    const s = game([[50, -1, -1, -1], [-1, -1, -1, -1]], { tokensToWin: 1 })
    expect(L.applyMove(L.applyRoll(s, 6).state, 0).state.winner).toBe(0)
  })
  test('moving out of turn order or an illegal token is refused', () => {
    const s = game([[5, -1, -1, -1], [-1, -1, -1, -1]])
    expect(() => L.applyMove(s, 0)).toThrow()     // no roll yet
    const r = L.applyRoll(s, 6)
    expect(() => L.applyMove(r.state, 9)).toThrow()
  })
})

describe('leaving and timeouts', () => {
  test('a player who leaves forfeits; the last one standing wins', () => {
    const s = L.newLudo(2)
    const f = L.forfeit(s, 0)
    expect(f.out).toEqual([0])
    expect(f.winner).toBe(1)
  })
  test('in a 4-player game a forfeit passes the turn and play goes on', () => {
    const s = L.newLudo(4, 4, 0)
    const f = L.forfeit(s, 0)
    expect(f.turn).toBe(1)
    expect(f.winner).toBe(null)
    expect(L.forfeit(L.forfeit(f, 1), 2).winner).toBe(3)
  })
  test('a timeout plays the turn (most advanced token) and counts a miss; the third miss forfeits', () => {
    let s = game([[10, 30, -1, -1], [-1, -1, -1, -1]])
    let r = L.timeoutStep(s, 2)
    expect(r.state.tokens[0]).toEqual([10, 32, -1, -1])
    expect(r.state.missed[0]).toBe(1)
    s = { ...r.state, turn: 0, roll: null }
    r = L.timeoutStep(s, 2)
    s = { ...r.state, turn: 0, roll: null }
    r = L.timeoutStep(s, 2)
    expect(r.state.out).toEqual([0])
    expect(r.state.winner).toBe(1)
  })
})

describe('provably fair draws', () => {
  test('the published commitment verifies the revealed seed, and nothing else', () => {
    const seed = R.newSeed()
    expect(seed.length).toBe(64)
    expect(R.verifyCommit(seed, R.commitOf(seed))).toBe(true)
    expect(R.verifyCommit(R.newSeed(), R.commitOf(seed))).toBe(false)
  })
  test('the same seed and label give the same die; different labels differ across many draws', () => {
    const seed = 'a'.repeat(64)
    expect(R.rollDie(seed, 'm:roll:1:0')).toBe(R.rollDie(seed, 'm:roll:1:0'))
    const faces = new Set()
    for (let i = 0; i < 60; i++) faces.add(R.rollDie(seed, `m:roll:${i}:0`))
    expect(faces.size).toBe(6)
  })
  test('the die is fair: 60 000 draws, every face within 3% of a sixth', () => {
    const seed = R.newSeed()
    const n = 60000
    const counts = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < n; i++) counts[R.rollDie(seed, `x:${i}`) - 1]++
    for (const c of counts) expect(Math.abs(c - n / 6) < (n / 6) * 0.03).toBe(true)
  })
  test('weighted draws and shuffles stay in range', () => {
    const seed = R.newSeed()
    for (let i = 0; i < 200; i++) {
      const k = R.drawWeighted(seed, `w:${i}`, [0, 5, 0, 1])
      expect(k === 1 || k === 3).toBe(true)
    }
    const sh = R.shuffle(seed, 'deck', 52)
    expect([...sh].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i))
    const f = R.drawFloat(seed, 'f')
    expect(f >= 0 && f < 1).toBe(true)
  })
})

describe('stored on the match document', () => {
  test('the tokens go flat (Firestore has no arrays inside arrays) and come back the same', () => {
    const s = L.newLudo(6, 4, 2)
    s.tokens[3][1] = 17
    const stored = L.toStored(s)
    expect(stored.tokens.length).toBe(24)
    expect(stored.tokens.some((t) => Array.isArray(t))).toBe(false)
    expect(stored.tokens[3 * 4 + 1]).toBe(17)
    expect(L.fromStored(stored)).toEqual(s)
    expect(L.fromStored(s)).toEqual(s)                    // an engine state (as tests build them) reads as is
  })
})
