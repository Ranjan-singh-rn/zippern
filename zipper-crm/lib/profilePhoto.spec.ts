/**
 * Resolving a stored `photoUrl` into something a browser can render.
 *
 * ── THE BUG THIS ENCODES ────────────────────────────────────────────────────
 *
 * `users/{uid}.photoUrl` is not always a URL. Skip the photo step at signup
 * and the app writes one of twelve built-in avatars as `avatar:fox`, resolving
 * it through a Coil mapper onto a vector drawable. There is no Storage object
 * and no URL — that is the point of the convention.
 *
 * Every CRM surface put the field straight into `<img src>`. Browsers have no
 * `avatar:` scheme, so `/users` drew the broken-image icon next to anybody who
 * had not uploaded a photo.
 *
 * ── WHAT MUST NOT MOVE ──────────────────────────────────────────────────────
 *
 * Only the `avatar:` prefix may be rewritten. An uploaded photo, a signed
 * Storage URL, a Google avatar and a gs:// path must come back byte-for-byte,
 * because the ONLY branch that changes anything is the one matching the
 * prefix. Most of the checks below are about that, not about the avatars.
 *
 * REAL: `lib/profilePhoto.ts` and the generated `lib/defaultAvatars.generated.ts`.
 * FAKE: nothing.
 *
 *   npm run test:photo
 */

import {
  DEFAULT_AVATAR_ORDER,
  DEFAULT_AVATAR_SCHEME,
  defaultAvatarDataUrl,
  isDefaultAvatar,
  profilePhotoSrc,
} from './profilePhoto'
import { DEFAULT_AVATAR_DATA_URLS } from './defaultAvatars.generated'

let checks = 0
const failures: string[] = []

function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  if (got !== want) {
    const s = (v: unknown) => {
      const t = String(v)
      return t.length > 70 ? `${t.slice(0, 70)}…(${t.length})` : t
    }
    failures.push(`${claim}\n        got ${s(got)}\n        want ${s(want)}`)
  }
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

// ── 1. The twelve ids, from the canonical enum order ────────────────────────
console.log('\n1. Every known default-photo ID resolves')

// Pinned explicitly as well as driven from the module, so a regenerate that
// silently dropped one is caught rather than quietly shrinking the loop.
const EXPECTED_IDS = [
  'fox', 'panda', 'cat', 'owl', 'frog', 'penguin',
  'bear', 'bunny', 'tiger', 'horse', 'bird', 'monkey',
]
eq('the scheme is the app\'s', DEFAULT_AVATAR_SCHEME, 'avatar:')
eq('twelve avatars', DEFAULT_AVATAR_ORDER.length, 12)
eq('in the enum\'s declaration order, not alphabetical',
  DEFAULT_AVATAR_ORDER.join(','), EXPECTED_IDS.join(','))

for (const id of EXPECTED_IDS) {
  const src = profilePhotoSrc(`${DEFAULT_AVATAR_SCHEME}${id}`)
  ok(`avatar:${id} → a data URL`, src.startsWith('data:image/svg+xml,'))
  ok(`avatar:${id} → renderable SVG`, decodeURIComponent(src).includes('<svg'))
  ok(`avatar:${id} → has a viewBox`, decodeURIComponent(src).includes('viewBox="0 0 96 96"'))
  ok(`avatar:${id} → at least one path`, decodeURIComponent(src).includes('<path'))
  eq(`avatar:${id} → the ${id} artwork specifically`, src, DEFAULT_AVATAR_DATA_URLS[id])
}

// Twelve DISTINCT faces. A mapping bug that pointed every id at the same
// drawable would satisfy every check above.
const distinct = new Set(EXPECTED_IDS.map((id) => profilePhotoSrc(`avatar:${id}`)))
eq('all twelve are different images', distinct.size, 12)

// No Android XML leaked through the conversion.
for (const id of EXPECTED_IDS) {
  const svg = decodeURIComponent(profilePhotoSrc(`avatar:${id}`))
  ok(`avatar:${id} carries no android: attributes`, !svg.includes('android:'))
  ok(`avatar:${id} is not a <vector>`, !svg.includes('<vector'))
  ok(`avatar:${id} has a real fill`, /fill="#[0-9A-Fa-f]{6}"/.test(svg))
}

// Case and padding, the way a sloppy writer might store it.
eq('AVATAR:FOX is not matched — the scheme is lower-case as the app writes it',
  profilePhotoSrc('AVATAR:FOX'), 'AVATAR:FOX')
eq('avatar:FOX resolves — the ID is lower-cased, as the app does',
  profilePhotoSrc('avatar:FOX'), DEFAULT_AVATAR_DATA_URLS.fox)
eq('avatar: fox  (padded id) resolves',
  profilePhotoSrc('avatar:  fox  '), DEFAULT_AVATAR_DATA_URLS.fox)
eq('  avatar:fox  (padded value) resolves',
  profilePhotoSrc('  avatar:fox  '), DEFAULT_AVATAR_DATA_URLS.fox)

// ── 2. Real URLs pass through untouched ─────────────────────────────────────
console.log('2. Ordinary photos are not altered')

const UNTOUCHED = [
  'https://firebasestorage.googleapis.com/v0/b/zipper-83816.firebasestorage.app/o/profilePhotos%2Fabc.jpg?alt=media&token=1234',
  'https://storage.googleapis.com/zipper-83816.firebasestorage.app/profilePhotos/abc.jpg?X-Goog-Signature=deadbeef',
  'https://lh3.googleusercontent.com/a/ACg8ocK_abcdef=s96-c',
  'http://example.test/photo.png',
  'gs://zipper-83816.firebasestorage.app/profilePhotos/abc.jpg',
  'profilePhotos/abc.jpg',
  '/relative/path.png',
  'data:image/png;base64,iVBORw0KGgo=',
]
for (const v of UNTOUCHED) {
  eq(`unchanged: ${v.slice(0, 48)}`, profilePhotoSrc(v), v)
  ok(`  …and not treated as an avatar`, !isDefaultAvatar(v))
  eq(`  …and yields no avatar artwork`, defaultAvatarDataUrl(v), null)
}

// The nastiest confusion: a REAL url that merely contains the word avatar.
for (const v of [
  'https://cdn.example.test/avatar:fox.png',
  'https://example.test/avatars/fox.svg',
  'avatarfox',
  'avatar',
  'avatar/fox',
]) {
  eq(`not an avatar id: ${v}`, profilePhotoSrc(v), v)
  ok(`  …isDefaultAvatar is false for ${v}`, !isDefaultAvatar(v))
}

// ── 3. Missing and invalid values keep the existing fallback ────────────────
console.log('3. Nothing to show')

eq('null → empty, so the caller draws initials', profilePhotoSrc(null), '')
eq('undefined → empty', profilePhotoSrc(undefined), '')
eq('empty string → empty', profilePhotoSrc(''), '')
eq('whitespace only → empty', profilePhotoSrc('   '), '')
// This one is why the helper trims before deciding: the raw value is truthy,
// so a call site branching on the RAW field would render <img src="   ">.
ok('a whitespace value is falsy after resolution', !profilePhotoSrc('  \t '))
eq('a non-string → empty', profilePhotoSrc(123 as unknown as string), '')

// ── 4. An avatar the CRM has never heard of ─────────────────────────────────
console.log('4. Unknown avatar ids')

// The app resolves these to ALL[(id.hashCode() & 0x7fffffff) % ALL.size]
// rather than to nothing, so an older client never shows an empty circle for
// an avatar a newer one wrote. The CRM reproduces that, which means the same
// face in both places.
function javaHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
for (const unknown of ['dragon', 'axolotl', 'whateverComesNext', 'z', '']) {
  // The app hashes the TRIMMED, LOWER-CASED id — `removePrefix(...).trim().lowercase()`
  // — not the raw one. An earlier draft of this test hashed the raw string and
  // failed on 'whateverComesNext', which is the resolver being right and the
  // expectation being wrong.
  const normalised = unknown.trim().toLowerCase()
  const want = DEFAULT_AVATAR_DATA_URLS[
    DEFAULT_AVATAR_ORDER[(javaHash(normalised) & 0x7fffffff) % DEFAULT_AVATAR_ORDER.length]
  ]
  eq(`avatar:${unknown || '(empty id)'} → a deterministic member of the set`,
    profilePhotoSrc(`avatar:${unknown}`), want)
  ok(`  …and it is a data URL, never the raw string`,
    profilePhotoSrc(`avatar:${unknown}`).startsWith('data:'))
}
eq('an unknown id is matched case-insensitively, like the app',
  profilePhotoSrc('avatar:Dragon'), profilePhotoSrc('avatar:dragon'))
eq('…and with padding',
  profilePhotoSrc('avatar:  DRAGON '), profilePhotoSrc('avatar:dragon'))
eq('the same unknown id is the same face twice',
  profilePhotoSrc('avatar:dragon'), profilePhotoSrc('avatar:dragon'))
ok('an unknown id never comes back as "avatar:…"',
  !profilePhotoSrc('avatar:dragon').startsWith('avatar:'))

// ── 5. Nothing that is an avatar escapes as a URL ───────────────────────────
console.log('5. No avatar value ever reaches the DOM as a URL')

for (const id of [...EXPECTED_IDS, 'dragon', 'UNKNOWN', ' spaced ']) {
  const src = profilePhotoSrc(`avatar:${id}`)
  ok(`avatar:${id} does not reach src as the raw scheme`, !src.includes('avatar:'))
  ok(`avatar:${id} is not an http(s) request`, !/^https?:/i.test(src))
  ok(`avatar:${id} is not a gs:// request`, !src.startsWith('gs://'))
  ok(`avatar:${id} is non-empty`, src.length > 0)
}

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log(`\nAll ${checks} profile-photo checks passed.`)
console.log('  · all twelve avatar ids resolve to twelve distinct inline SVGs')
console.log('  · storage, signed, Google, gs:// and relative values pass through untouched')
console.log('  · null/empty/whitespace fall through to the existing placeholder')
console.log('  · an unknown avatar id gets the same face the app would show')
console.log('  · no avatar: value can ever reach <img src> as a URL\n')
