/**
 * reupload-entrances.mjs
 * Re-uploads all entrance Lottie files from zipper-crm/public/lottie/entrances/
 * to Firebase Storage, updates animationUrl in Firestore, then deletes local files.
 *
 * Run from functions/:  node reupload-entrances.mjs
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { readFileSync, existsSync, unlinkSync, readdirSync, rmdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'
const serviceAccount = require('../serviceAccountKey.json')
const LOTTIE_DIR     = join(__dirname, '..', 'zipper-crm', 'public', 'lottie', 'entrances')

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
    // Derive filename from animationAsset e.g. "lottie/entries/en_bike.json" → "en_bike.json"
    const assetField = item.animationAsset || ''
    const filename   = assetField.split('/').pop()

    if (!filename || !filename.endsWith('.json')) {
      console.log(`⚠️  ${item.name} — no animationAsset, skipping`)
      skipped++
      continue
    }

    const localPath = join(LOTTIE_DIR, filename)
    if (!existsSync(localPath)) {
      console.log(`⚠️  ${item.name} — ${filename} not found locally, skipping`)
      skipped++
      continue
    }

    const fileBuffer = readFileSync(localPath)
    const json       = JSON.parse(fileBuffer.toString())
    const frames     = (json.op || 0) - (json.ip || 0)

    const safe        = toSafeName(item.name)
    const storagePath = `contentAssets/bag_items/entrances/${safe}/lottie.json`
    const token       = randomUUID()

    process.stdout.write(`   ${item.name.padEnd(26)} (${String(frames).padStart(3)} frames) → uploading … `)

    await bucket.file(storagePath).save(fileBuffer, {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'public, max-age=31536000',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    })

    await db.collection('bagItems').doc(item.id).update({
      animationUrl: makeDownloadUrl(storagePath, token),
    })

    console.log('✅')

    // Delete local file after successful upload
    unlinkSync(localPath)
    console.log(`   🗑  Deleted ${filename}`)
    ok++
  }

  // Clean up empty directory
  try {
    const remaining = readdirSync(LOTTIE_DIR)
    if (remaining.length === 0) {
      rmdirSync(LOTTIE_DIR)
      console.log('\n🗑  Removed empty public/lottie/entrances/ directory')
      // Also remove parent lottie/ if empty
      const parent = join(LOTTIE_DIR, '..')
      if (readdirSync(parent).length === 0) {
        rmdirSync(parent)
        console.log('🗑  Removed empty public/lottie/ directory')
      }
    } else {
      console.log(`\n⚠️  ${remaining.length} file(s) remain in public/lottie/entrances/:`, remaining)
    }
  } catch {}

  console.log(`\n✅ Done — ${ok} uploaded & local files deleted, ${skipped} skipped`)
  console.log('\nNext step: deploy so lottie-test.html fetches from Firebase only.')
  console.log('  cd ../zipper-crm && firebase deploy --only hosting\n')
}

main().catch(err => {
  console.error('\n❌', err.message)
  process.exit(1)
})
