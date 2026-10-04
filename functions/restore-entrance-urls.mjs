/**
 * restore-entrance-urls.mjs
 * Finds the original entry_*.json files in Firebase Storage and updates
 * Firestore animationUrl to point back to those working files.
 *
 * Run from functions/:  node restore-entrance-urls.mjs
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'

const require   = createRequire(import.meta.url)
const __dirname = (await import('path')).dirname((await import('url')).fileURLToPath(import.meta.url))

const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'
const serviceAccount = require('../serviceAccountKey.json')

admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
})

const db     = admin.firestore()
const bucket = admin.storage().bucket()

function makeDownloadUrl(storagePath, token) {
  const encoded = encodeURIComponent(storagePath)
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encoded}?alt=media&token=${token}`
}

async function getOrCreateToken(storagePath) {
  const file = bucket.file(storagePath)
  const [meta] = await file.getMetadata()
  const existing = meta.metadata?.firebaseStorageDownloadTokens
  if (existing) return existing
  // Create a new token
  const token = randomUUID()
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } })
  return token
}

async function main() {
  const snap = await db.collection('bagItems').get()
  const entrances = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(item => item.category === 'entrance')

  console.log(`\n📦 Found ${entrances.length} entrance bag items\n`)

  // List all existing files under contentAssets/bag_items/entrances/ to find old uploads
  const [allFiles] = await bucket.getFiles({ prefix: 'contentAssets/bag_items/entrances/' })

  // Build a map: folderName → array of file paths
  const folderMap = {}
  for (const f of allFiles) {
    const parts = f.name.split('/')
    // contentAssets/bag_items/entrances/{folder}/{file}
    if (parts.length === 5) {
      const folder = parts[3]
      const file   = parts[4]
      if (!folderMap[folder]) folderMap[folder] = []
      folderMap[folder].push({ path: f.name, file })
    }
  }
  console.log('Storage folders found:', Object.keys(folderMap).join(', '), '\n')

  let ok = 0, skipped = 0

  for (const item of entrances) {
    // Derive expected folder name from animationAsset
    // e.g. "lottie/entries/en_bike.json" → "en_bike"
    const assetField = item.animationAsset || ''
    const assetFile  = assetField.split('/').pop()            // "en_bike.json"
    const folderName = assetFile.replace(/\.json$/i, '')       // "en_bike"

    const candidates = folderMap[folderName]
    if (!candidates || candidates.length === 0) {
      console.log(`⚠️  ${item.name} — no Storage folder "${folderName}", skipping`)
      skipped++
      continue
    }

    // Pick the .json file (not thumbnail.jpg)
    const jsonFile = candidates.find(c => c.file.endsWith('.json'))
    if (!jsonFile) {
      console.log(`⚠️  ${item.name} — no .json in folder "${folderName}", skipping`)
      skipped++
      continue
    }

    process.stdout.write(`   ${item.name.padEnd(26)} ← ${jsonFile.path} … `)

    try {
      const token = await getOrCreateToken(jsonFile.path)
      const url   = makeDownloadUrl(jsonFile.path, token)

      await db.collection('bagItems').doc(item.id).update({ animationUrl: url })
      console.log('✅')
      ok++
    } catch (err) {
      console.log('❌', err.message)
      skipped++
    }
  }

  console.log(`\n✅ Done — ${ok} restored, ${skipped} skipped`)
  console.log('\nRefresh lottie-test.html to verify.\n')
}

main().catch(err => {
  console.error('\n❌', err.message)
  process.exit(1)
})
