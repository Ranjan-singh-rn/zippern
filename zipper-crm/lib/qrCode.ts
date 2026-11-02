/**
 * QR Code encoder — ISO/IEC 18004, byte mode, versions 1–40, error correction L / M / Q / H.
 *
 * Why it exists: the authenticator set-up screens (an Owner on /login, the Observer on /observer)
 * show the otpauth:// URI as a QR code, so nobody has to type a 32-character key. That URI carries
 * the TOTP secret, so the code is drawn here, in the browser: never by a remote QR service, and
 * without adding an npm dependency to a page that handles a credential.
 *
 * Checked against an independent implementation: lib/qrCode.spec.ts compares whole matrices with
 * ones produced by OpenCV's QRCodeEncoder (same text, version, level and mask), and the release
 * review decoded codes of every version and level with OpenCV's QRCodeDetector.
 *
 * Pure: no DOM, no randomness. `encodeQr(text)` → `QrMatrix` (modules[y][x], true = dark).
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  /** 1–40 */
  version: number
  ecc: QrEcc
  /** 0–7 */
  mask: number
  /** Modules per side: 17 + 4 × version (no quiet zone). */
  size: number
  /** modules[y][x] — true = dark. */
  modules: boolean[][]
}

export interface QrOptions {
  minVersion?: number
  maxVersion?: number
  /** Force a mask (0–7); by default the one with the lowest penalty is chosen. */
  mask?: number
}

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 }
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 }

// Per version (index 0 unused), for L, M, Q, H.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

/** Modules available for data and ECC codewords (everything but the function patterns). */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver: number, ecc: QrEcc): number {
  const e = ECC_INDEX[ecc]
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver]
}

function charCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16 // byte mode
}

/** Bytes that fit, in byte mode, at (version, level). */
export function qrByteCapacity(ver: number, ecc: QrEcc): number {
  return Math.floor((numDataCodewords(ver, ecc) * 8 - 4 - charCountBits(ver)) / 8)
}

// ── Reed–Solomon over GF(2^8) with the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ──

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

/** Generator polynomial (x − 2^0)(x − 2^1)…(x − 2^(degree−1)) without its leading 1, highest power first. */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor)
  }
  return result
}

// ── Data codewords ──

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

function dataCodewords(bytes: readonly number[], ver: number, ecc: QrEcc): number[] {
  const capacityBits = numDataCodewords(ver, ecc) * 8
  const bits: number[] = []
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0x4, 4) // byte mode
  put(bytes.length, charCountBits(ver))
  for (const b of bytes) put(b, 8)
  if (bits.length > capacityBits) throw new RangeError('Data too long for this version')
  put(0, Math.min(4, capacityBits - bits.length)) // terminator
  put(0, (8 - (bits.length % 8)) % 8) // to a byte boundary
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    out.push(v)
  }
  return out
}

/** Split into blocks, append each block's ECC, interleave. */
function withEccInterleaved(data: readonly number[], ver: number, ecc: QrEcc): number[] {
  const e = ECC_INDEX[ecc]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const eccBytes = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0) // placeholder, skipped below
    blocks.push(dat.concat(eccBytes))
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i])
    }
  }
  if (result.length !== rawCodewords) throw new Error('QR interleave length mismatch')
  return result
}

// ── The matrix ──

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

class Grid {
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      g.setFunction(x, y, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) g.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
}

function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function drawFormat(g: Grid, ecc: QrEcc, mask: number) {
  const bits = formatBits(ecc, mask)
  const bit = (i: number) => ((bits >>> i) & 1) !== 0
  const n = g.size
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, bit(i))
  g.setFunction(8, 7, bit(6))
  g.setFunction(8, 8, bit(7))
  g.setFunction(7, 8, bit(8))
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) g.setFunction(n - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) g.setFunction(8, n - 15 + i, bit(i))
  g.setFunction(8, n - 8, true) // the dark module
}

function drawVersion(g: Grid, ver: number) {
  if (ver < 7) return
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (ver << 12) | rem
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    g.setFunction(a, b, dark)
    g.setFunction(b, a, dark)
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecc: QrEcc) {
  for (let i = 0; i < g.size; i++) {
    g.setFunction(6, i, i % 2 === 0)
    g.setFunction(i, 6, i % 2 === 0)
  }
  drawFinder(g, 3, 3)
  drawFinder(g, g.size - 4, 3)
  drawFinder(g, 3, g.size - 4)
  const pos = alignmentPositions(ver, g.size)
  const last = pos.length - 1
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      drawAlignment(g, pos[i], pos[j])
    }
  }
  drawFormat(g, ecc, 0) // reserves the area; redrawn with the real mask
  drawVersion(g, ver)
}

function drawCodewords(g: Grid, codewords: readonly number[]) {
  let i = 0
  const total = codewords.length * 8
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? g.size - 1 - vert : vert
        if (!g.isFunction[y][x] && i < total) {
          g.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default: throw new RangeError('mask must be 0–7')
  }
}

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y][x] && maskHit(mask, x, y)) g.modules[y][x] = !g.modules[y][x]
    }
  }
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
]

/** The standard penalty (runs, 2×2 blocks, finder-like patterns, dark balance); lower is better. */
function penalty(m: boolean[][]): number {
  const n = m.length
  let score = 0
  const line = (get: (i: number) => boolean) => {
    let run = 1
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) { run++; continue }
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
    for (let s = 0; s + 11 <= n; s++) {
      for (const p of FINDER_LIKE) {
        let hit = true
        for (let k = 0; k < 11 && hit; k++) if (get(s + k) !== p[k]) hit = false
        if (hit) score += 40
      }
    }
  }
  for (let y = 0; y < n; y++) line((x) => m[y][x])
  for (let x = 0; x < n; x++) line((y) => m[y][x])
  let dark = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++
      if (y + 1 < n && x + 1 < n) {
        const c = m[y][x]
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3
      }
    }
  }
  const total = n * n
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
  return score
}

/** Encode `text` (UTF-8, byte mode) at level `ecc` in the smallest version that fits. */
export function encodeQr(text: string, ecc: QrEcc = 'M', options: QrOptions = {}): QrMatrix {
  const bytes = utf8(text)
  const minVersion = Math.max(1, options.minVersion ?? 1)
  const maxVersion = Math.min(40, options.maxVersion ?? 40)
  let version = -1
  for (let v = minVersion; v <= maxVersion; v++) {
    if (bytes.length <= qrByteCapacity(v, ecc)) { version = v; break }
  }
  if (version < 0) throw new RangeError(`Text too long for a QR code (${bytes.length} bytes at level ${ecc})`)
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) {
    throw new RangeError('mask must be 0–7')
  }
  const size = version * 4 + 17
  const g = new Grid(size)
  drawFunctionPatterns(g, version, ecc)
  drawCodewords(g, withEccInterleaved(dataCodewords(bytes, version, ecc), version, ecc))
  let mask = options.mask ?? -1
  if (mask < 0) {
    let best = Infinity
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(g, candidate)
      drawFormat(g, ecc, candidate)
      const p = penalty(g.modules)
      if (p < best) { best = p; mask = candidate }
      applyMask(g, candidate) // XOR again: undo
    }
  }
  applyMask(g, mask)
  drawFormat(g, ecc, mask)
  return { version, ecc, mask, size, modules: g.modules }
}

/** One SVG path ("M x y h1 v1 h-1 z" per dark module), offset by a quiet zone of `margin` modules. */
export function qrSvgPath(qr: QrMatrix, margin = 4): string {
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`
    }
  }
  return d
}
