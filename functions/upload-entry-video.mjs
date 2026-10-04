/**
 * upload-entry-video.mjs
 *
 * Uploads the re-encoded entrance animations (H.264 MP4) and their stills to
 * Firebase Storage, and writes `videoUrl` + `previewUrl` onto each `bagItems`
 * document.
 *
 * Replaces `upload-entry-animations.mjs`, which uploaded the image-sequence
 * Lotties from `entry-lotties/`. Those are a full-screen picture per frame
 * base64'd into JSON — 22.3 MB for `en_jet`, and about two gigabytes of bitmap
 * once Lottie decodes them, which is what froze the Bag screen. The MP4s are
 * roughly a twelfth of the size and play on the hardware decoder.
 *
 * `animationUrl` is deliberately left alone. The app prefers `videoUrl` and
 * ignores `animationUrl` entirely, so leaving it in place costs nothing and
 * means rolling the app back does not also need a data migration.
 *
 * Inputs come from `functions/scripts/reencode-entrances.py`:
 *
 *     python3 scripts/reencode-entrances.py --src entry-lotties --out entry-video
 *     node upload-entry-video.mjs
 *
 * Add --dry to list what would happen without uploading or writing anything.
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'
const serviceAccount = require('../serviceAccountKey.json')

const VIDEO_DIR = join(__dirname, 'entry-video', 'mp4')
const THUMB_DIR = join(__dirname, 'entry-video', 'thumb')

const DRY = process.argv.includes('--dry')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
})

const db = admin.firestore()
const bucket = admin.storage().bucket()

function toSafeName(name) {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item'
}

function makeDownloadUrl(storagePath, token) {
  const encoded = encodeURIComponent(storagePath)
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encoded}?alt=media&token=${token}`
}

/**
 * The re-encoder names its output after the SOURCE JSON (`en_jet.mp4`), and the
 * bag item points at the same stem through `animationAsset`
 * ("lottie/entries/en_jet.json"). That is the only join between the two, so a
 * document with no `animationAsset` cannot be matched and is skipped rather
 * than guessed at.
 */
function stemFor(item) {
  const asset = item.animationAsset || ''
  const file = asset.split('/').pop() || ''
  return file.endsWith('.json') ? file.slice(0, -5) : ''
}

async function upload(localPath, storagePath, contentType) {
  const buffer = readFileSync(localPath)
  const token = randomUUID()
  if (!DRY) {
    await bucket.file(storagePath).save(buffer, {
      contentType,
      metadata: {
        // These are immutable once published — a changed entrance gets a new
        // path rather than a new body at the same path — so they can be cached
        // for a year. On a metered Indian data plan that difference is the
        // whole point.
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    })
  }
  return { url: makeDownloadUrl(storagePath, token), bytes: buffer.length }
}

async function main() {
  const snap = await db.collection('bagItems').get()
  const entrances = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((item) => item.category === 'entrance')

  console.log(`\nFound ${entrances.length} entrance bag items${DRY ? ' (dry run)' : ''}\n`)

  let ok = 0
  let skipped = 0
  let totalBytes = 0

  for (const item of entrances) {
    const stem = stemFor(item)
    if (!stem) {
      console.log(`  skip  ${item.name} — no animationAsset to match a file by`)
      skipped++
      continue
    }

    const mp4Path = join(VIDEO_DIR, `${stem}.mp4`)
    const thumbPath = join(THUMB_DIR, `${stem}.webp`)
    if (!existsSync(mp4Path)) {
      console.log(`  skip  ${item.name} — ${stem}.mp4 not found; run scripts/reencode-entrances.py first`)
      skipped++
      continue
    }

    const safe = toSafeName(item.name)
    const patch = {}

    const video = await upload(
      mp4Path,
      `contentAssets/bag_items/entrances/${safe}/entrance.mp4`,
      'video/mp4',
    )
    patch.videoUrl = video.url
    totalBytes += video.bytes

    let thumbNote = 'no thumb'
    if (existsSync(thumbPath)) {
      const thumb = await upload(
        thumbPath,
        `contentAssets/bag_items/entrances/${safe}/thumb.webp`,
        'image/webp',
      )
      patch.previewUrl = thumb.url
      totalBytes += thumb.bytes
      thumbNote = `${(thumb.bytes / 1024).toFixed(1)} KB thumb`
    }

    if (!DRY) await db.collection('bagItems').doc(item.id).update(patch)

    console.log(
      `  ok    ${item.name.padEnd(24)} ${(video.bytes / 1024 / 1024).toFixed(2)} MB mp4, ${thumbNote}`,
    )
    ok++
  }

  console.log(
    `\n${ok} uploaded, ${skipped} skipped — ${(totalBytes / 1024 / 1024).toFixed(2)} MB total\n`,
  )
  if (DRY) console.log('Dry run: nothing was uploaded and no document was written.\n')
}

main().catch((err) => {
  console.error('\n', err.message)
  process.exit(1)
})
