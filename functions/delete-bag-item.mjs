/**
 * delete-bag-item.mjs
 * Deletes a bagItem by name.
 * Usage: node delete-bag-item.mjs "Standard"
 */

import admin from 'firebase-admin'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
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
