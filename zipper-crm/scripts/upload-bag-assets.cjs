/**
 * upload-bag-assets.cjs
 * ─────────────────────
 * Uploads entrance Lottie JSON files to Firebase Storage under
 * contentAssets/bag_items/entrances/{id}.json, then writes
 * animationUrl + animationAsset into each bagItems/{id} Firestore doc.
 *
 * Source files: zipper-crm/public/lottie/entrances/ (already populated from the zip)
 *
 * Credentials come from the environment — never from this file:
 *   ZIPPER_ADMIN_EMAIL     admin account used to sign in
 *   ZIPPER_ADMIN_PASSWORD  its password
 *
 * Run from the zipper-crm directory:
 *   ZIPPER_ADMIN_EMAIL=... ZIPPER_ADMIN_PASSWORD=... node scripts/upload-bag-assets.cjs
 */

'use strict'

const { initializeApp }                                = require('firebase/app')
const { getAuth, signInWithEmailAndPassword }          = require('firebase/auth')
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage')
const { getFirestore, doc, setDoc, getDoc }            = require('firebase/firestore')
const { readFileSync, existsSync }                     = require('fs')
const { join }                                         = require('path')

const firebaseConfig = {
  apiKey:            'AIzaSyDi6O6K-ddR8VWdHHz7qmKYhvyVyC_QlZw',
  authDomain:        'zipper-83816.firebaseapp.com',
  projectId:         'zipper-83816',
  storageBucket:     'zipper-83816.firebasestorage.app',
  messagingSenderId: '239458555881',
  appId:             '1:239458555881:web:569a385d93bc1325b55d78',
}

// ── Admin credentials ─────────────────────────────────────────────────────────
// Read from the environment only. There is deliberately no default: a missing
// variable must stop the script, not silently sign in as someone else.
const CRED_HELP = [
  'Set them for this one run, for example:',
  '',
  "  ZIPPER_ADMIN_EMAIL='you@example.com' ZIPPER_ADMIN_PASSWORD='<password>' \\",
  '    node scripts/upload-bag-assets.cjs',
  '',
  'Do not hardcode them in this file and do not commit them.',
].join('\n')

function requireCredentials() {
  const email    = process.env.ZIPPER_ADMIN_EMAIL
  const password = process.env.ZIPPER_ADMIN_PASSWORD
  const missing  = []
  if (!email)    missing.push('ZIPPER_ADMIN_EMAIL')
  if (!password) missing.push('ZIPPER_ADMIN_PASSWORD')
  if (missing.length) {
    console.error(`\n❌  Missing required environment variable(s): ${missing.join(', ')}\n`)
    console.error(CRED_HELP)
    process.exit(1)
  }
  return { email, password }
}

// Source: zipper-crm/public/lottie/entrances/ (files from the zip)
const SRC_DIR = join(__dirname, '../public/lottie/entrances')

const ITEMS = [
  'en_bike', 'en_sports', 'en_lambo', 'en_tiger', 'en_king',
  'en_horse', 'en_ship', 'en_jet', 'en_rocket', 'en_yamraj', 'en_vip',
]

async function main() {
  // Fail before doing any work if credentials are not supplied.
  const { email, password } = requireCredentials()

  const app     = initializeApp(firebaseConfig)
  const auth    = getAuth(app)
  const storage = getStorage(app)
  const db      = getFirestore(app)

  console.log(`🔐  Signing in as ${email}…`)
  await signInWithEmailAndPassword(auth, email, password)
  console.log('✅  Signed in\n')

  let uploaded = 0, skipped = 0, failed = 0

  for (const id of ITEMS) {
    const filePath = join(SRC_DIR, `${id}.json`)
    if (!existsSync(filePath)) {
      console.warn(`⚠️   ${id}: file not found at ${filePath} — skipped`)
      skipped++
      continue
    }

    try {
      const data        = readFileSync(filePath)
      const storagePath = `contentAssets/bag_items/entrances/${id}.json`
      const storageRef  = ref(storage, storagePath)

      process.stdout.write(`⬆️   ${id}  (${Math.round(data.length / 1024)} KB) … `)
      await uploadBytes(storageRef, data, { contentType: 'application/json' })
      const url = await getDownloadURL(storageRef)

      // Patch Firestore doc (merge so other fields are preserved)
      const docRef = doc(db, 'bagItems', id)
      await setDoc(docRef, { animationAsset: storagePath, animationUrl: url }, { merge: true })

      console.log('✓')
      uploaded++
    } catch (err) {
      console.error(`\n  ❌  ${id}: ${err.message}`)
      failed++
    }
  }

  console.log('\n────────────────────────────────')
  console.log(`✅  Uploaded : ${uploaded}`)
  console.log(`⚠️   Skipped  : ${skipped}`)
  console.log(`❌  Failed   : ${failed}`)
  if (uploaded > 0) {
    console.log('\nNext: rebuild CRM + deploy Android APK')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
