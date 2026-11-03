/**
 * B13 — decoration fields on gifts and bag items.
 *
 * REAL: `lib/decorAssets.ts`, imported and called. The wiring checks read the page and the gifts module as text,
 * because they need Firebase and React to run.
 *
 *   npm run test:decor
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  FRAME_SCALE_DEFAULT, assetKindOf, bagItemWrite, frameScaleOf, giftPatch, svgaKeyOk, uploadContentType,
} from './decorAssets'

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

// ── giftPatch: the Firestore SDK refuses undefined ─────────────────────────────
{
  const p = giftPatch({ name: 'Rose', imageUrl: undefined, lottieAsset: undefined, svgaUrl: 'https://x/a.svga', diamondCost: 10 })
  ok('no undefined value survives', Object.values(p).every(v => v !== undefined))
  eq('a cleared asset field is written as empty (cleared), not dropped', [p.imageUrl, p.lottieAsset], ['', ''])
  eq('a set asset field is kept', p.svgaUrl, 'https://x/a.svga')
  eq('ordinary fields pass through', [p.name, p.diamondCost], ['Rose', 10])
  const q = giftPatch({ name: 'Rose', sortOrder: undefined })
  ok('a non-asset undefined field is left out (unchanged), not blanked', !('sortOrder' in q))
}

// ── frame scale ────────────────────────────────────────────────────────────────
eq('blank → the default', frameScaleOf(''), FRAME_SCALE_DEFAULT)
eq('null → the default', frameScaleOf(null), FRAME_SCALE_DEFAULT)
eq('a typed value', frameScaleOf('1.55'), 1.55)
eq('too small is clamped', frameScaleOf('0.4'), 1.0)
eq('too large is clamped', frameScaleOf(9), 2.5)
eq('junk is refused', frameScaleOf('big'), null)

// ── svga keys ──────────────────────────────────────────────────────────────────
ok('a plain key', svgaKeyOk('avatar'))
ok('store-style keys', svgaKeyOk('img_12') && svgaKeyOk('head.png') && svgaKeyOk('user-name'))
ok('empty means "use the default"', svgaKeyOk(''))
ok('no spaces or slashes', !svgaKeyOk('my avatar') && !svgaKeyOk('../x'))
ok('not unbounded', !svgaKeyOk('a'.repeat(65)))

// ── asset kinds ────────────────────────────────────────────────────────────────
eq('svga', assetKindOf('Rocket.SVGA'), 'svga')
eq('mp4', assetKindOf('car.mp4'), 'mp4')
eq('lottie', assetKindOf('rose.json'), 'lottie')
eq('image', assetKindOf('thumb.webp'), 'image')
eq('a storage URL with a query', assetKindOf('https://h/o/a%2Fb.svga?alt=media&token=t'), 'svga')
eq('unknown', assetKindOf('notes.txt'), null)

// ── upload content type (storage.rules admits octet-stream only for .svga) ─────
eq('an SVGA is labelled octet-stream', uploadContentType('Rocket.svga'), 'application/octet-stream')
eq('anything else keeps the browser type', [uploadContentType('a.png'), uploadContentType('a.json'), uploadContentType('a.mp4')], [undefined, undefined, undefined])

// ── bagItemWrite: what a save sends ────────────────────────────────────────────
{
  const base = {
    name: 'Bike', category: 'entrance', previewUrl: '', unlockLevel: 6, minHostLevel: 0, price: 0, source: 'level',
    animationAsset: '', isActive: true,
  }
  const w = bagItemWrite({ ...base, svgaUrl: 'https://s/bike.svga', svgaAvatarKey: 'head', svgaNameKey: 'nick' })
  ok('never writes durations (the server sells from them; this page does not edit them)', !('durations' in w))
  ok('does not blank an MP4 the page never loaded', !('videoUrl' in w))
  eq('entrance keys are written', [w.svgaAvatarKey, w.svgaNameKey], ['head', 'nick'])
  eq('svga url', w.svgaUrl, 'https://s/bike.svga')
  ok('no undefined value', Object.values(w).every(v => v !== undefined))
  const v = bagItemWrite({ ...base, videoUrl: '' })
  eq('an MP4 the editor cleared is cleared', v.videoUrl, '')
  const f = bagItemWrite({ ...base, category: 'frame', frameScale: 1.6 })
  eq('a frame writes its scale', f.frameScale, 1.6)
  ok('a frame writes no entrance keys', !('svgaAvatarKey' in f) && !('svgaNameKey' in f))
}

// ── wiring ─────────────────────────────────────────────────────────────────────
{
  const root = path.resolve(__dirname, '..')
  const page = fs.readFileSync(path.join(root, 'app/app-config/bag-items/page.tsx'), 'utf8')
  const save = page.slice(page.indexOf('async function saveItem'), page.indexOf('async function saveAll'))
  ok('the bag-items save goes through bagItemWrite', save.includes('bagItemWrite('))
  ok('the bag-items save MERGES (a replace deletes durations and videoUrl)', /\{\s*merge:\s*true\s*\}/.test(save))
  ok('the page offers an SVGA upload', page.includes("onChange('svgaUrl'"))
  ok('the page offers an MP4 upload', page.includes("onChange('videoUrl'"))
  const gifts = fs.readFileSync(path.join(root, 'lib/gifts.ts'), 'utf8')
  const upd = gifts.slice(gifts.indexOf('export async function updateGift'))
  ok('updateGift goes through giftPatch', upd.slice(0, 400).includes('giftPatch('))
  const giftsPage = fs.readFileSync(path.join(root, 'app/gifts/page.tsx'), 'utf8')
  ok('the gift editor offers an SVGA upload', giftsPage.includes("uploadGiftAsset(file, 'svga'"))
  ok('the gift upload labels an SVGA (storage.rules refuses an unlabelled one)', giftsPage.includes('uploadContentType('))
  const field = fs.readFileSync(path.join(root, 'components/UploadField.tsx'), 'utf8')
  ok('UploadField labels an SVGA too', field.includes('uploadContentType('))
}

if (failures.length) {
  console.error(`decorAssets: ${failures.length} of ${checks} checks FAILED`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`decorAssets: all ${checks} checks passed`)
