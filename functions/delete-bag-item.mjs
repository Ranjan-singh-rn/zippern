/**
 * delete-bag-item.mjs
 * Deletes a bagItem by name.
 * Usage: node delete-bag-item.mjs "Standard"
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'
import { guardKeyScript } from './scripts/_keyScriptGuard.mjs'

const require = createRequire(import.meta.url)
// P0-10 (OPS-C): this key reaches a REAL project — named, acknowledged and (for
// a run that writes) confirmed before Firebase is initialised. See _keyScriptGuard.mjs.
const GUARDED_PROJECT = guardKeyScript('delete-bag-item', {
  keyPath: new URL('../serviceAccountKey.json', import.meta.url),
  writes: true,
})
const serviceAccount = require('../serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db   = admin.firestore()
const name = process.argv[2]

if (!name) {
  console.error('Usage: node delete-bag-item.mjs "<name>"')
  process.exit(1)
}

const snap = await db.collection('bagItems').where('name', '==', name).get()

if (snap.empty) {
  console.log(`No bagItem found with name "${name}"`)
  process.exit(0)
}

for (const doc of snap.docs) {
  await doc.ref.delete()
  console.log(`✅ Deleted "${name}" (${doc.id})`)
}
