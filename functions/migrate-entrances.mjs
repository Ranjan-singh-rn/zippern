/**
 * migrate-entrances.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time script: uploads bundled entrance Lottie files to Firebase Storage
 * and writes the download URL back into the `bagItems` Firestore documents.
 *
 * Prerequisites
 * ─────────────
 * 1. Download your service account key:
 *    Firebase Console → Project Settings → Service Accounts → Generate new private key
 *    Save it as  zippern/serviceAccountKey.json   (one folder up from functions/)
 *
 * 2. Run from the functions/ folder:
 *    cd functions
 *    node migrate-entrances.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const require   = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────
const STORAGE_BUCKET = 'zipper-83816.firebasestorage.app'

// Service account is one folder up (zippern/serviceAccountKey.json)
const serviceAccount = require('../serviceAccountKey.json')

// Lottie files are in zippern/zipper-crm/public/lottie/entrances/
const LOTTIE_DIR = join(__dirname, '..', 'zipper-crm', 'public', 'lottie', 'entrances')

// ── Init ──────────────────────────────────────────────────────────────────────
admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
})

const db     = admin.firestore()
const bucket = admin.storage().bucket()

// ── Helpers ───────────────────────────────────────────────────────────────────
function toSafeName(name) {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item'
}

function makeDownloadUrl(storagePath, token) {
  const encoded = encodeURIComponent(storagePath)
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encoded}?alt=media&token=${token}`
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const snap = await db.collection('bagItems').get()
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }))

  const entrances = all.filter(
    item => item.category === 'entrance' && !item.animationUrl
  )

  console.log(`\n📦 Found ${all.filter(i => i.category === 'entrance').length} entrance bag items`)
  console.log(`⬆️  ${entrances.length} need a Storage URL\n`)

  if (entrances.length === 0) {
    console.log('Nothing to do — all entrances already have animationUrl set.')
    return
  }

  let ok = 0, skipped = 0

  for (const item of entrances) {
    const assetField = item.animationAsset || ''
    const filename   = assetField.split('/').pop()   // e.g. "en_bike.json"

    if (!filename || !filename.endsWith('.json')) {
      console.log(`⚠️  ${item.name} — no animationAsset, skipping`)
      skipped++
      continue
    }

    const localPath = join(LOTTIE_DIR, filename)
    if (!existsSync(localPath)) {
      console.log(`⚠️  ${item.name} — file not found: ${localPath}`)
      skipped++
      continue
    }

    const safe        = toSafeName(item.name)
    const storagePath = `contentAssets/bag_items/entrances/${safe}/lottie.json`
    const token       = randomUUID()
    const fileBuffer  = readFileSync(localPath)

    process.stdout.write(`   ${item.name.padEnd(24)} → ${storagePath} … `)

    const storageFile = bucket.file(storagePath)
    await storageFile.save(fileBuffer, {
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
    ok++
  }

  console.log(`\n✅ Done — ${ok} uploaded, ${skipped} skipped`)
  console.log('Refresh CRM → Content Management → Entrances to see Preview links.\n')
}

main().catch(err => {
  console.error('\n❌', err.message)
  process.exit(1)
})
