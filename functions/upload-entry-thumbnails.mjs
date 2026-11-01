/**
 * upload-entry-thumbnails.mjs
 * Extracts WebP thumbnails from entry-thumbnails/ and uploads to Firebase Storage.
 * Updates Firestore `previewUrl` for each entrance bag item.
 *
 * Run from functions/:  node upload-entry-thumbnails.mjs
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { guardKeyScript } from './scripts/_keyScriptGuard.mjs'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'
// P0-10 (OPS-C): this key reaches a REAL project — named, acknowledged and (for
// a run that writes) confirmed before Firebase is initialised. See _keyScriptGuard.mjs.
const GUARDED_PROJECT = guardKeyScript('upload-entry-thumbnails', {
  keyPath: new URL('../serviceAccountKey.json', import.meta.url),
  writes: true,
})
const serviceAccount = require('../serviceAccountKey.json')
const THUMB_DIR      = join(__dirname, 'entry-thumbnails')

admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
})

const db     = admin.firestore()
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

async function main() {
  const snap = await db.collection('bagItems').get()
  const entrances = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(item => item.category === 'entrance')

  console.log(`\n🖼️  Uploading thumbnails for ${entrances.length} entrance bag items\n`)

  let ok = 0, skipped = 0

  for (const item of entrances) {
    // Derive slug from animationAsset: "/lottie/entrances/en_bike.json" → "en_bike"
    const assetField = item.animationAsset || ''
    const slug = assetField.split('/').pop().replace(/\.json$/i, '')  // "en_bike"

    if (!slug) {
      console.log(`⚠️  ${item.name} — no animationAsset, skipping`)
      skipped++
      continue
    }

    // Find the thumbnail file (try .webp first, then .jpg)
    const webpPath = join(THUMB_DIR, `${slug}.webp`)
    const jpgPath  = join(THUMB_DIR, `${slug}.jpg`)
    const localPath = existsSync(webpPath) ? webpPath : existsSync(jpgPath) ? jpgPath : null

    if (!localPath) {
      console.log(`⚠️  ${item.name} — no thumbnail file for "${slug}", skipping`)
      skipped++
      continue
    }

    const imgBuffer  = readFileSync(localPath)
    const isWebp     = localPath.endsWith('.webp')
    const ext        = isWebp ? 'webp' : 'jpg'
    const mimeType   = isWebp ? 'image/webp' : 'image/jpeg'
    const safe       = toSafeName(item.name)
    const storagePath = `contentAssets/bag_items/entrances/${safe}/thumbnail.${ext}`
    const token      = randomUUID()
    const sizeKB     = (imgBuffer.length / 1024).toFixed(0)

    process.stdout.write(`   ${item.name.padEnd(26)} (${sizeKB}KB) → uploading … `)

    await bucket.file(storagePath).save(imgBuffer, {
      contentType: mimeType,
      metadata: {
        cacheControl: 'public, max-age=31536000',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    })

    const url = makeDownloadUrl(storagePath, token)
    await db.collection('bagItems').doc(item.id).update({ previewUrl: url })

    console.log('✅')
    ok++
  }

  console.log(`\n✅ Done — ${ok} thumbnails uploaded, ${skipped} skipped\n`)
}

main().catch(err => {
  console.error('\n❌', err.message)
  process.exit(1)
})
