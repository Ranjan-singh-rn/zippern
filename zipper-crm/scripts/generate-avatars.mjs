/**
 * Turn the app's default-avatar VectorDrawables into one CRM module.
 *
 *     cd zipper-crm && npm run gen:avatars
 *
 * ── WHY THIS IS GENERATED AND NOT HAND-WRITTEN ──────────────────────────────
 *
 * `users/{uid}.photoUrl` can hold `avatar:fox` instead of a URL. The app
 * resolves that through a Coil mapper onto a vector drawable; the CRM cannot,
 * because the artwork exists ONLY as Android XML — there is no hosted copy,
 * no Storage object, nothing with a URL. So the CRM has to carry the twelve
 * faces itself.
 *
 * Carrying them means a copy, and a copy means drift: somebody edits
 * `avatar_fox.xml` and the CRM keeps showing last year's fox, with nothing to
 * say so. Deriving them by script makes that a command instead of an
 * archaeology exercise, and the generated file records the source hash so the
 * drift is visible.
 *
 * ── THE CONVERSION ──────────────────────────────────────────────────────────
 *
 * These drawables are deliberately plain — `android:viewportWidth/Height` plus
 * a handful of `<path android:fillColor android:pathData>`. That maps onto SVG
 * one-for-one: viewBox, `d`, `fill`. No gradients, no groups, no clip paths,
 * no transforms. The script REFUSES anything it does not understand rather
 * than dropping it silently, because a half-converted avatar is a worse
 * outcome than a build error.
 *
 * Output is a data: URL per avatar, so an `<img src>` needs no extra file, no
 * extra request and cannot 404.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRAWABLES = join(HERE, '..', '..', 'zipper-app', 'app', 'src', 'main', 'res', 'drawable')
const OUT = join(HERE, '..', 'lib', 'defaultAvatars.generated.ts')

/** `#AARRGGBB` (Android) → `#RRGGBB` / `rgba(...)`. */
function colour(v) {
  const m = /^#([0-9a-fA-F]{8})$/.exec(v)
  if (m) {
    const a = parseInt(m[1].slice(0, 2), 16)
    const rgb = `#${m[1].slice(2)}`
    return a === 255 ? rgb : `${rgb}` // alpha handled by fill-opacity below
  }
  if (/^#([0-9a-fA-F]{6})$/.test(v)) return v
  throw new Error(`unsupported colour ${v}`)
}
function alpha(v) {
  const m = /^#([0-9a-fA-F]{8})$/.exec(v)
  if (!m) return 1
  return parseInt(m[1].slice(0, 2), 16) / 255
}

function convert(xml, file) {
  const vec = /<vector\b([^>]*)>/.exec(xml)
  if (!vec) throw new Error(`${file}: no <vector>`)
  const w = /android:viewportWidth="([\d.]+)"/.exec(xml)
  const h = /android:viewportHeight="([\d.]+)"/.exec(xml)
  if (!w || !h) throw new Error(`${file}: no viewport`)

  // Refuse anything richer than flat filled paths.
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of ['group', 'clip-path', 'gradient', 'aapt:attr']) {
    if (stripped.includes(`<${tag}`)) {
      throw new Error(`${file}: contains <${tag}>, which this converter does not handle`)
    }
  }

  const paths = []
  const re = /<path\b([\s\S]*?)\/>/g
  let m
  while ((m = re.exec(stripped)) !== null) {
    const attrs = m[1]
    const d = /android:pathData="([^"]*)"/.exec(attrs)
    const fill = /android:fillColor="([^"]*)"/.exec(attrs)
    if (!d) throw new Error(`${file}: <path> with no pathData`)
    if (!fill) throw new Error(`${file}: <path> with no fillColor`)
    if (/android:strokeColor|android:fillType/.test(attrs)) {
      throw new Error(`${file}: <path> uses stroke or fillType, not handled`)
    }
    const a = alpha(fill[1])
    paths.push(
      `<path d="${d[1]}" fill="${colour(fill[1])}"${a === 1 ? '' : ` fill-opacity="${a}"`}/>`,
    )
  }
  if (paths.length === 0) throw new Error(`${file}: no paths`)

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w[1]} ${h[1]}">`
    + paths.join('')
    + '</svg>'
  return svg
}

// ── THE ORDER MATTERS, AND IT IS THE ENUM'S, NOT THE FILESYSTEM'S ──────────
//
// `DefaultAvatar.fromPhotoUrl` resolves an UNRECOGNISED id to
// `ALL[(id.hashCode() & 0x7fffffff) % ALL.size]`, and `ALL` is
// `values().toList()` — DECLARATION order. Sorting the drawables
// alphabetically would give the CRM a different list and therefore a
// different face from the app for the same unknown id. So the order is read
// from the enum, and the two sets are cross-checked: a drawable with no enum
// entry, or an enum entry with no drawable, is a build error rather than a
// silently missing avatar.
const KOTLIN = join(
  HERE, '..', '..', 'zipper-app', 'app', 'src', 'main', 'java', 'com', 'zipper',
  'app', 'ui', 'components', 'DefaultAvatars.kt',
)
const kt = readFileSync(KOTLIN, 'utf8')
const enumBody = /enum class DefaultAvatar\([\s\S]*?\)\s*\{([\s\S]*?);/.exec(kt)
if (!enumBody) throw new Error('could not find the DefaultAvatar enum body')
const order = [...enumBody[1].matchAll(/\w+\("([a-z]+)",\s*R\.drawable\.(avatar_[a-z]+)\)/g)]
  .map((m) => ({ id: m[1], drawable: m[2] }))
if (order.length === 0) throw new Error('no enum constants parsed')

const scheme = /const val DEFAULT_AVATAR_SCHEME = "([^"]+)"/.exec(kt)
if (!scheme) throw new Error('could not find DEFAULT_AVATAR_SCHEME')

const onDisk = new Set(
  readdirSync(DRAWABLES).filter((f) => /^avatar_[a-z]+\.xml$/.test(f)).map((f) => f.slice(0, -4)),
)
for (const { id, drawable } of order) {
  if (!onDisk.has(drawable)) throw new Error(`enum lists ${id} but ${drawable}.xml is missing`)
  if (drawable !== `avatar_${id}`) {
    throw new Error(`enum id ${id} does not match drawable ${drawable} — the id is what`
      + ' is stored in photoUrl, so this mapping must be one-to-one')
  }
  onDisk.delete(drawable)
}
if (onDisk.size > 0) {
  throw new Error(`drawables with no enum entry: ${[...onDisk].join(', ')} —`
    + ' add them to DefaultAvatar or they will never be reachable')
}

const files = order.map((o) => `${o.drawable}.xml`)

const entries = []
const sourceHash = createHash('sha256')
sourceHash.update(kt)
for (const f of files) {
  const id = /^avatar_([a-z]+)\.xml$/.exec(f)[1]
  const xml = readFileSync(join(DRAWABLES, f), 'utf8')
  sourceHash.update(f).update(xml)
  const svg = convert(xml, f)
  // encodeURIComponent, not base64: an SVG data URL stays readable in devtools
  // and compresses better over the wire.
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`
  entries.push([id, url])
}

const banner = `/**
 * GENERATED — do not edit. Run \`npm run gen:avatars\` to refresh.
 *
 * The twelve default avatars, converted from the app's VectorDrawables at
 * zipper-app/app/src/main/res/drawable/avatar_*.xml. That XML is the canonical
 * artwork; this file is a derived copy, because the CRM runs in a browser and
 * the originals exist only as Android resources.
 *
 * source files : ${files.length}
 * source sha256: ${sourceHash.digest('hex')}
 *
 * If an avatar is added, renamed or redrawn in the app, regenerate. The id
 * strings are written into \`users/{uid}.photoUrl\` and must never be renamed —
 * see DefaultAvatars.kt.
 */

`

const body =
  `/** The prefix that marks a \`photoUrl\` as a built-in avatar. */\n`
  + `export const DEFAULT_AVATAR_SCHEME = '${scheme[1]}'\n\n`
  + '/**\n'
  + ' * Ids in the enum\'s DECLARATION order, which is what the app indexes an\n'
  + ' * unrecognised id into. Not alphabetical — see the note in the generator.\n'
  + ' */\n'
  + 'export const DEFAULT_AVATAR_ORDER: readonly string[] = Object.freeze([\n'
  + order.map((o) => `  '${o.id}',`).join('\n')
  + '\n])\n\n'
  + 'export const DEFAULT_AVATAR_DATA_URLS: Readonly<Record<string, string>> = Object.freeze({\n'
  + entries.map(([id, url]) => `  ${id}: '${url}',`).join('\n')
  + '\n})\n'

writeFileSync(OUT, banner + body)
console.log(`wrote ${OUT}`)
console.log(`  ${entries.length} avatars: ${entries.map(([i]) => i).join(', ')}`)
console.log(`  total ${entries.reduce((n, [, u]) => n + u.length, 0)} chars of data URL`)
