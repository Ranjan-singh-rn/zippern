/**
 * lib/qrCode.ts — the QR code on the authenticator set-up screens (/login for an Owner, /observer
 * for the Observer). The code carries the otpauth:// URI, i.e. the TOTP secret, so it is drawn in
 * the browser by this module and never by a remote service.
 *
 * REAL: `lib/qrCode.ts`, imported and called. Anchored on an independent encoder: whole matrices
 * are compared with OpenCV's QRCodeEncoder output (same text, version, level and mask) — byte mode,
 * Reed–Solomon blocks (short and long), interleaving, placement, format and version information.
 * The two screens are checked on their source: they render the QR from the server's otpauth URI and
 * call no image or QR service.
 *
 *   npm run test:qrcode
 */

import * as fs from 'fs'
import * as path from 'path'
import { encodeQr, qrByteCapacity, qrSvgPath, type QrEcc, type QrMatrix } from './qrCode'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

function hexRows(q: QrMatrix): string[] {
  return q.modules.map((row) => {
    let bits = row.map((b) => (b ? '1' : '0')).join('')
    bits += '0'.repeat((4 - (bits.length % 4)) % 4)
    let hex = ''
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
    return hex
  })
}

function readFormat(q: QrMatrix): { first: number; second: number } {
  const m = (x: number, y: number) => (q.modules[y][x] ? 1 : 0)
  const n = q.size
  let first = 0
  for (let i = 0; i <= 5; i++) first |= m(8, i) << i
  first |= m(8, 7) << 6
  first |= m(8, 8) << 7
  first |= m(7, 8) << 8
  for (let i = 9; i < 15; i++) first |= m(14 - i, 8) << i
  let second = 0
  for (let i = 0; i < 8; i++) second |= m(n - 1 - i, 8) << i
  for (let i = 8; i < 15; i++) second |= m(8, n - 15 + i) << i
  return { first, second }
}

// Matrices produced by OpenCV 5.0.0's QRCodeEncoder (an independent implementation) for the same text,
// version, level and mask — one hex string per row, MSB = leftmost module, padded with 0 bits to a nibble.
const KNOWN: { text: string; version: number; ecc: QrEcc; mask: number; rows: string[] }[] = [
  {
    text: "ZIPPER",
    version: 1, ecc: 'M', mask: 2,
    rows: [
      'fe5bf8',
      '821a08',
      'baf2e8',
      'bafae8',
      'babae8',
      '82ea08',
      'feabf8',
      '009800',
      'be2be0',
      'f02900',
      'f354f0',
      '89a1e8',
      'f6b4e8',
      '00ff30',
      'fe0b30',
      '82ffe8',
      'ba8970',
      'baa820',
      'bad420',
      '826060',
      'feb430',
    ],
  },
  {
    text: "otpauth://totp/Zipper%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Zipper&algorithm=SHA1&digits=6&period=30",
    version: 8, ecc: 'M', mask: 7,
    rows: [
      'fe4a16c434bf8',
      '8237bd0597a08',
      'ba5f7bc289ae8',
      'ba7ab281612e8',
      'ba43c3eb582e8',
      '82a2f237fa208',
      'feaaaaaaaabf8',
      '001f5e2860000',
      '96dfeffb4b500',
      'f525e39118478',
      '9397f503cd408',
      '4574a9dd76490',
      '9eac7eb89d3f8',
      '20ee0650ac828',
      '13b1f65407c48',
      '2c5bb4644da88',
      'c316b5a78ddb0',
      '1dd978a0d2488',
      '8ffc9eceb1538',
      'a4648285cdfa0',
      '5e7975d978750',
      'f805214819030',
      'afeebffaedfb8',
      '58a30a2282890',
      '7a94f2bbdfa98',
      'c880f2203c8f8',
      '2fe9d3eb76fa8',
      'b911ee1cfc810',
      '4eee9df6c8610',
      'd080064c833e8',
      'e3e361b9ccb78',
      '80a85b3a0a628',
      '2b66fd159cd58',
      'c949305bb0c58',
      'b75e4aba1c218',
      '3cc2f8f958f80',
      '6ec50affbc218',
      'e977160025370',
      '47349d5c4ebc8',
      '714271ed70690',
      'e34773e2defa8',
      '00bc2e2c578e8',
      'fe16bea2d5ad8',
      '82b24622ed8f0',
      'ba48d3ff2dfd8',
      'baa3f2a910c90',
      'ba4baad9fd280',
      '82103d00c9880',
      'fece8faefd8d8',
    ],
  },
  {
    text: "A known answer for version ten at level H: 0123456789 abcdefghij",
    version: 10, ecc: 'H', mask: 5,
    rows: [
      'feef879e86a73f8',
      '82687af96405208',
      'bad2d337376f2e8',
      'ba6fca77f1792e8',
      'badd4e7f57e52e8',
      '8254e6a32186208',
      'feaaaaaaaaaabf8',
      '00b04e636e80800',
      '0635363f1a78aa8',
      '59cd4a325423770',
      '73ee609ce1186e0',
      '39e5f206bda70e0',
      '175740e0c1a1ad8',
      '51b2c319d42cc28',
      'a699e75803fa770',
      'b0508a36ea5e2b8',
      '3bababc199076f0',
      '206c930becd48c8',
      '2b873458487c858',
      'c14a487613a7a48',
      '5a3a6b99927c0a0',
      'e8efb8732327e48',
      '7328ccbdeb7ea90',
      'c0649899913cf40',
      '06ba362a69bc5f8',
      'd45dc0c98521f30',
      '0fd5793e9b6afa0',
      'b898f5e24ba48f8',
      'ea9eceebdd76aa0',
      '288b92a2916e8b0',
      '8fe7d1be5bcfff8',
      '613093b26e19070',
      'ebdecfbb4af0980',
      '392c9b572c637c8',
      'e2d10fd8f081898',
      'c1b21464294e528',
      '926d15183bfce40',
      '88921abaa92f428',
      'ef4e4d72b51d9f0',
      '3d43779bf23c6a8',
      '3bb42e9f1c27bd0',
      '08f70cc42177778',
      '8e9fe5aa9bde3d8',
      '15af10bb6654a60',
      '2ae9d2cf1202180',
      '143499e95cde9c0',
      'a70875b98126990',
      'f81dcbf3e6a5340',
      '03990bbf0ca3fe8',
      '00c42ba3b7ad8b8',
      'fe580deb80faaf0',
      '82a751e3215e8b8',
      'ba4e21fee601ff0',
      'ba45b23ff6d54a0',
      'ba4f073e0a79fb8',
      '8200a4acaa5c920',
      'fe12bec12c83b70',
    ],
  },
  {
    text: "Quartile, version seven: the quick brown fox",
    version: 7, ecc: 'Q', mask: 4,
    rows: [
      'fe1f6df38bf8',
      '82485ca05208',
      'bafeb57a52e8',
      'ba5daba7dae8',
      'ba80ff8b3ae8',
      '829f38fc4208',
      'feaaaaaaabf8',
      '002108951000',
      '4a9a1fe1a5a0',
      '15be452efb50',
      'ffbdd6a66fa0',
      '650e84947790',
      'e2e1bbb645c8',
      'e8767ee31eb0',
      '3fa870c9aa10',
      '6d3db463d4d8',
      '9a0ae250c278',
      'b4b218155b48',
      '02b35e0c53f0',
      '4075d28ca1a0',
      '9f998fa6cfa0',
      'e89fb8f2c8a8',
      '7ad08ad90a80',
      'd889089cc890',
      '9ff67fbbefd8',
      '113b92ee9398',
      'c29f1e834918',
      '8945b16f1408',
      '8f8292c1a180',
      '04e71232ed30',
      '2b4eee3e76d0',
      '3099c8b27988',
      'ced00f945ec8',
      'dc85ae9f1310',
      '0b9191eba050',
      '79c759c30c40',
      '9b6a8ff1afb0',
      '00f95884f8c0',
      'fe3bca9c7af0',
      '821b489498a8',
      'bac90fd69fb8',
      'ba4c5eabd6b0',
      'ba04bbc84280',
      '82ba531ab4c0',
      'fe236c78a968',
    ],
  },
]

// ── 1. Known answers from the independent encoder ──
console.log('\n1. Whole matrices equal an independent encoder (OpenCV)')
for (const k of KNOWN) {
  const q = encodeQr(k.text, k.ecc, { minVersion: k.version, maxVersion: k.version, mask: k.mask })
  eq(`v${k.version}-${k.ecc} mask ${k.mask}: version`, q.version, k.version)
  eq(`v${k.version}-${k.ecc} mask ${k.mask}: size`, q.size, 17 + 4 * k.version)
  const got = hexRows(q)
  const firstBad = got.findIndex((r, i) => r !== k.rows[i])
  ok(`v${k.version}-${k.ecc} mask ${k.mask}: every module equals the reference${firstBad >= 0 ? ` (first differing row ${firstBad})` : ''}`,
     got.length === k.rows.length && firstBad < 0)
}

// ── 2. The set-up URI: smallest version, readable format information ──
console.log('2. The authenticator set-up URI')
const URI = KNOWN[1].text
const auto = encodeQr(URI, 'M')
eq('the 131-byte set-up URI picks version 8 at level M (smallest that fits)', auto.version, 8)
ok('version 7 at M would not hold it', qrByteCapacity(7, 'M') < 131 && qrByteCapacity(8, 'M') >= 131)
const fmt = readFormat(auto)
eq('both copies of the format information agree', fmt.first, fmt.second)
const data = (fmt.first ^ 0x5412) >> 10
eq('format information says level M (00) and the chosen mask', [data >> 3, data & 7], [0, auto.mask])
ok('the dark module is set', auto.modules[auto.size - 8][8] === true)
ok('timing patterns alternate', Array.from({ length: auto.size - 16 }, (_, i) => i + 8)
  .every((i) => auto.modules[6][i] === (i % 2 === 0) && auto.modules[i][6] === (i % 2 === 0)))
const finderOk = (cx: number, cy: number) => {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy))
    if (auto.modules[cy + dy][cx + dx] !== (d !== 2)) return false
  }
  return true
}
ok('three finder patterns', finderOk(3, 3) && finderOk(auto.size - 4, 3) && finderOk(3, auto.size - 4))
eq('the same text always gives the same code', hexRows(encodeQr(URI, 'M')), hexRows(auto))

// ── 3. Capacity and refusals ──
console.log('3. Capacity and refusals')
eq('byte capacity v1-M / v10-M / v40-L', [qrByteCapacity(1, 'M'), qrByteCapacity(10, 'M'), qrByteCapacity(40, 'L')], [14, 213, 2953])
let threw = false
try { encodeQr('x'.repeat(2954), 'L') } catch (e) { threw = e instanceof RangeError }
ok('text longer than a version-40 code is refused (RangeError), not truncated', threw)
threw = false
try { encodeQr('x', 'M', { mask: 8 }) } catch (e) { threw = e instanceof RangeError }
ok('a mask outside 0–7 is refused', threw)

// ── 4. SVG path ──
console.log('4. SVG path')
const dark = auto.modules.reduce((n, row) => n + row.filter(Boolean).length, 0)
eq('one square per dark module', (qrSvgPath(auto).match(/M/g) || []).length, dark)
ok('offset by the quiet zone', qrSvgPath(auto, 4).startsWith('M4 4h1v1h-1z'))

// ── 5. The two set-up screens ──
console.log('5. The set-up screens')
const root = path.join(__dirname, '..')
const comp = fs.readFileSync(path.join(root, 'components', 'TotpQrCode.tsx'), 'utf8')
ok('the component draws with lib/qrCode (no image, no network)', comp.includes("from '@/lib/qrCode'") && !/<img|fetch\(|https?:\/\//.test(comp.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')))
for (const page of ['app/login/page.tsx', 'app/observer/page.tsx']) {
  const src = fs.readFileSync(path.join(root, page), 'utf8')
  ok(`${page} shows the QR of the server's otpauth URI`, /<TotpQrCode[^>]*uri=\{enrolment\.otpauth_uri\}/.test(src))
  ok(`${page} keeps the setup key as a fallback`, src.includes('enrolment.secret'))
  ok(`${page} calls no QR or image service`, !/api\.qrserver|chart\.googleapis|quickchart|qrcode\.(show|tec)/i.test(src))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} QR-code checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`\nAll ${checks} QR-code checks passed.`)
console.log('  · whole matrices equal OpenCV\'s encoder at v1-M, v7-Q, v8-M (the set-up URI) and v10-H')
console.log('  · the set-up screens draw the otpauth URI in the browser; the key stays as a fallback')
