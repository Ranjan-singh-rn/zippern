/**
 * GAMES — server randomness, provably fair (B3, 3 Nov 2026).
 *
 * Every random outcome in every game is drawn HERE, on the server, from a secret seed made with the OS CSPRNG
 * (`crypto.randomBytes`), never on a phone. The seed is committed before play (its SHA-256 is published on the
 * match/round document) and revealed after it, so anybody can recompute every draw and see nothing moved:
 *
 *   draw(label) = HMAC-SHA256(serverSeed, label)  → uniform integers by rejection sampling
 *
 * Labels are unique per draw (`<matchId>:roll:<turn>:<n>`), so the same seed never produces the same draw twice and
 * a replayed request cannot re-roll. Pure — no Firestore — and tested directly.
 */

import * as crypto from 'crypto'

/** A fresh 32-byte secret seed, hex. */
export function newSeed(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** What is published before play: the SHA-256 of the seed. */
export function commitOf(seed: string): string {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex')
}

/** Does this revealed seed match the published commitment? */
export function verifyCommit(seed: string, commit: string): boolean {
  return commitOf(seed) === commit
}

function hmac(seed: string, label: string, counter: number): Buffer {
  return crypto.createHmac('sha256', seed).update(`${label}#${counter}`, 'utf8').digest()
}

/**
 * A uniform integer in [0, n). Rejection sampling over 32-bit words, so there is no modulo bias — a die that
 * favoured one face by a fraction of a percent is still a loaded die.
 */
export function drawInt(seed: string, label: string, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new Error(`drawInt: bad range ${n}`)
  const limit = Math.floor(0x100000000 / n) * n
  for (let counter = 0; counter < 1000; counter++) {
    const buf = hmac(seed, label, counter)
    for (let i = 0; i + 4 <= buf.length; i += 4) {
      const v = buf.readUInt32BE(i)
      if (v < limit) return v % n
    }
  }
  throw new Error('drawInt: rejection sampling did not converge')
}

/** A uniform float in [0, 1) with 52 bits of precision. */
export function drawFloat(seed: string, label: string): number {
  const buf = hmac(seed, label, 0)
  // 52 bits: 20 from the first word, 32 from the second.
  const hi = buf.readUInt32BE(0) & 0x000fffff
  const lo = buf.readUInt32BE(4)
  return (hi * 0x100000000 + lo) / 0x10000000000000
}

/** A die: 1…6. */
export function rollDie(seed: string, label: string): number {
  return drawInt(seed, label, 6) + 1
}

/** Pick an index by integer weights (all ≥ 0, at least one > 0). */
export function drawWeighted(seed: string, label: string, weights: readonly number[]): number {
  const total = weights.reduce((a, w) => a + Math.max(0, Math.trunc(w)), 0)
  if (total <= 0) throw new Error('drawWeighted: no positive weight')
  let r = drawInt(seed, label, total)
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, Math.trunc(weights[i]))
    if (r < w) return i
    r -= w
  }
  return weights.length - 1
}

/** A Fisher–Yates shuffle of 0…n-1, every swap a separate labelled draw. */
export function shuffle(seed: string, label: string, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = drawInt(seed, `${label}:${i}`, i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
