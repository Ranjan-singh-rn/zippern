/**
 * upload-entry-animations.mjs
 * Uploads the real animated entrance Lottie files (from entry-lotties/)
 * to Firebase Storage and updates Firestore animationUrl.
 *
 * Run from functions/:  node upload-entry-animations.mjs
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
const GUARDED_PROJECT = guardKeyScript('upload-entry-animations', {
  keyPath: new URL('../serviceAccountKey.json', import.meta.url),
  writes: true,
})
const serviceAccount = require('../serviceAccountKey.json')

// Folder containing renamed animated Lottie files (en_bike.json, en_horse.json, …)
const LOTTIE_DIR = join(__dirname, 'entry-lotties')

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

  console.log(`\n📦 Found ${entrances.length} entrance bag items\n`)

  let ok = 0, skipped = 0

  for (const item of entrances) {
    // Derive local filename from animationAsset
    // e.g. "lottie/entries/en_bike.json" → "en_bike.json"
    const assetField = item.animationAsset || ''
    const filename   = assetField.split('/').pop()   // "en_bike.json"

    if (!filename || !filename.endsWith('.json')) {
      console.log(`⚠️  ${item.name} — no animationAsset, skipping`)
      skipped++
      continue
    }

    const localPath = join(LOTTIE_DIR, filename)
    if (!existsSync(localPath)) {
      console.log(`⚠️  ${item.name} — ${filename} not found in entry-lotties/, skipping`)
      skipped++
      continue
    }

    const fileBuffer = readFileSync(localPath)
    const json       = JSON.parse(fileBuffer.toString())
    const frames     = (json.op || 0) - (json.ip || 0)
    const sizeMB     = (fileBuffer.length / 1024 / 1024).toFixed(1)

    const safe        = toSafeName(item.name)
    const storagePath = `contentAssets/bag_items/entrances/${safe}/lottie.json`
    const token       = randomUUID()

    process.stdout.write(
      `   ${item.name.padEnd(26)} (${frames} frames, ${sizeMB}MB) → uploading … `
    )

    await bucket.file(storagePath).save(fileBuffer, {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'public, max-age=31536000',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    })

    const url = makeDownloadUrl(storagePath, token)
    await db.collection('bagItems').doc(item.id).update({ animationUrl: url })

    console.log('✅')
    ok++
  }

  console.log(`\n✅ Done — ${ok} uploaded, ${skipped} skipped`)
  console.log('\nRefresh lottie-test.html to see all entrances animating.\n')
}

main().catch(err => {
  console.error('\n❌', err.message)
  process.exit(1)
})
