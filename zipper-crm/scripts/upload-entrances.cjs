/**
 * upload-entrances.cjs
 * ────────────────────
 * For each entrance folder in the zip:
 *   1. Generate a thumbnail JPG from the MP4 (first clear frame at 1s)
 *   2. Upload thumbnail   → contentAssets/bag_items/entrances/{id}/thumbnail.jpg
 *   3. Upload lottie JSON → contentAssets/bag_items/entrances/{id}/lottie.json
 *   4. Upload ALL other JSONs → contentAssets/bag_items/entrances/{id}/{filename}
 *   5. Patch Firestore bagItems/{id} with { previewUrl, animationUrl }
 *   6. Save full URL map to scripts/uploaded-urls.json
 *
 * Credentials come from the environment — never from this file:
 *   ZIPPER_ADMIN_EMAIL     admin account used to sign in
 *   ZIPPER_ADMIN_PASSWORD  its password
 *
 * Run from zipper-crm/:
 *   ZIPPER_ADMIN_EMAIL=... ZIPPER_ADMIN_PASSWORD=... node scripts/upload-entrances.cjs
 */

'use strict'

const { initializeApp }                                = require('firebase/app')
const { getAuth, signInWithEmailAndPassword }          = require('firebase/auth')
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage')
const { getFirestore, doc, setDoc }                    = require('firebase/firestore')
const { execSync, execFileSync } = require('child_process')
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } = require('fs')
const { join, basename, extname } = require('path')
const os = require('os')

// ── Find ffmpeg ───────────────────────────────────────────────────────────────
function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    '/opt/homebrew/bin/ffmpeg',   // Apple Silicon Homebrew
    '/usr/local/bin/ffmpeg',       // Intel Homebrew
    '/usr/bin/ffmpeg',
  ]
  for (const bin of candidates) {
    try { execSync(`"${bin}" -version`, { stdio: 'pipe' }); return bin } catch {}
  }
  return null
}
const FFMPEG = findFfmpeg()

// ── macOS-native thumbnail extraction (qlmanage fallback) ─────────────────────
function extractThumbMac(mp4Path, outJpgPath, tmpDir) {
  try {
    // qlmanage extracts a Quick Look thumbnail into the output dir as <filename>.png
    const qlOutDir = join(tmpDir, 'ql_' + Date.now())
    mkdirSync(qlOutDir, { recursive: true })
    execSync(`qlmanage -t -s 512 -o "${qlOutDir}" "${mp4Path}"`, { stdio: 'pipe' })
    // Find the generated file
    const generated = readdirSync(qlOutDir)[0]
    if (!generated) return false
    const generatedPath = join(qlOutDir, generated)
    // Convert to JPEG using sips (built-in macOS tool)
    execSync(`sips -s format jpeg "${generatedPath}" --out "${outJpgPath}"`, { stdio: 'pipe' })
    return existsSync(outJpgPath)
  } catch { return false }
}

// ── Firebase ──────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
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
  '    node scripts/upload-entrances.cjs',
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

// ── Folder name → bag item ID mapping ────────────────────────────────────────

const FOLDER_TO_ID = {
  'Level 6 entry  bike':        'en_bike',
  'Level 8 entry':               'en_sports',
  'Entry level 10 car lembo':    'en_lambo',
  'Entry tiger':                 'en_tiger',
  'Entry 5 king':                'en_king',
  'Entry horse riding':          'en_horse',
  'Entry ship':                  'en_ship',
  'Enter jet':                   'en_jet',
  'Entry rocket':                'en_rocket',
  'Special entry 1 yamraj':      'en_yamraj',
  'Vip plane entry':             'en_vip',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function upload(storage, storagePath, filePath, mimeType) {
  const data = readFileSync(filePath)
  const r = ref(storage, storagePath)
  await uploadBytes(r, data, { contentType: mimeType })
  return await getDownloadURL(r)
}

function findFile(dir, predicate) {
  for (const f of readdirSync(dir)) {
    if (predicate(f)) return join(dir, f)
  }
  return null
}

function allFiles(dir) {
  return readdirSync(dir)
    .filter(f => statSync(join(dir, f)).isFile())
    .map(f => join(dir, f))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Fail before doing any work if credentials are not supplied.
  requireCredentials()

  const ZIP = join(__dirname, '../../..', 'Entry zipper folder (1).zip')
  const zipPath = existsSync(ZIP)
    ? ZIP
    : (process.argv[2] && existsSync(process.argv[2]) ? process.argv[2] : null)

  if (!zipPath) {
    // Try uploads folder
    const up = '/sessions/upbeat-zen-lovelace/mnt/uploads/Entry zipper folder (1).zip'
    if (!existsSync(up)) {
      console.error('Zip not found. Pass path as argument: node scripts/upload-entrances.cjs /path/to/file.zip')
      process.exit(1)
    }
    return runWith(up)
  }
  return runWith(zipPath)
}

async function runWith(zipPath) {
  const { email, password } = requireCredentials()

  console.log(`\n📦  Zip: ${zipPath}`)

  // Extract
  const tmpDir = join(os.tmpdir(), 'zipper_entrances_' + Date.now())
  mkdirSync(tmpDir, { recursive: true })
  console.log('📂  Extracting…')
  execSync(`unzip -q -o "${zipPath}" -d "${tmpDir}"`)

  // Find root folder inside zip
  const rootDir = join(tmpDir, 'Entry zipper folder')
  if (!existsSync(rootDir)) {
    console.error('Expected "Entry zipper folder" inside zip')
    process.exit(1)
  }

  // Firebase init
  const app     = initializeApp(FIREBASE_CONFIG)
  const auth    = getAuth(app)
  const storage = getStorage(app)
  const db      = getFirestore(app)

  console.log(`🔐  Signing in as ${email}…`)
  await signInWithEmailAndPassword(auth, email, password)
  console.log('✅  Signed in\n')

  const urlMap = {}
  const entranceFolders = readdirSync(rootDir).filter(f =>
    statSync(join(rootDir, f)).isDirectory()
  )

  for (const folderName of entranceFolders) {
    const id = FOLDER_TO_ID[folderName]
    if (!id) {
      console.warn(`⚠️   Unknown folder "${folderName}" — skipping`)
      continue
    }

    const folderPath = join(rootDir, folderName)
    const storagePfx = `contentAssets/bag_items/entrances/${id}`
    console.log(`\n📁  ${folderName}  →  ${id}`)
    urlMap[id] = {}

    // ── 1. Generate thumbnail from MP4 ───────────────────────────────────────
    const mp4 = findFile(folderPath, f => f.toLowerCase().endsWith('.mp4'))
    if (mp4) {
      const thumbPath = join(tmpDir, `${id}_thumb.jpg`)
      process.stdout.write('   🎞️   Generating thumbnail from MP4… ')
      let thumbOk = false
      try {
        if (FFMPEG) {
          // Try at 1s, then frame 0
          try {
            execSync(`"${FFMPEG}" -y -ss 00:00:01 -i "${mp4}" -vframes 1 -q:v 2 "${thumbPath}"`,
              { stdio: 'pipe' })
          } catch {
            execSync(`"${FFMPEG}" -y -i "${mp4}" -vframes 1 -q:v 2 "${thumbPath}"`,
              { stdio: 'pipe' })
          }
          thumbOk = existsSync(thumbPath)
        }
        if (!thumbOk) {
          // Fallback: macOS qlmanage (no ffmpeg needed)
          thumbOk = extractThumbMac(mp4, thumbPath, tmpDir)
        }

        if (thumbOk) {
          const url = await upload(storage, `${storagePfx}/thumbnail.jpg`, thumbPath, 'image/jpeg')
          urlMap[id].thumbnailUrl = url
          // Patch Firestore previewUrl immediately
          await setDoc(doc(db, 'bagItems', id), { previewUrl: url }, { merge: true })
          console.log(`✓  (${Math.round(statSync(thumbPath).size / 1024)}KB)`)
          console.log(`     ${url}`)
        } else {
          console.log('❌  no frame extracted — run: brew install ffmpeg  then re-run this script')
        }
      } catch (e) {
        console.log(`❌  ${e.message.split('\n')[0]}`)
      }
    } else {
      console.log('   ⚠️   No MP4 found — skipping thumbnail')
    }

    // ── 2. Upload Lottie JSON (image2lottie-animation*.json, smallest file) ──
    const lottieFile = findFile(folderPath, f =>
      f.toLowerCase().includes('image2lottie') && f.endsWith('.json')
    )
    if (lottieFile) {
      process.stdout.write(`   🌀  Uploading lottie.json (${Math.round(statSync(lottieFile).size / 1024)}KB)… `)
      try {
        const url = await upload(storage, `${storagePfx}/lottie.json`, lottieFile, 'application/json')
        urlMap[id].animationUrl = url
        console.log('✓')
        console.log(`     ${url}`)
      } catch (e) { console.log(`❌  ${e.message}`) }
    } else {
      console.log('   ⚠️   No image2lottie JSON found')
    }

    // ── 3. Upload ALL other files (raw JSONs; skip MP4 — Storage rules block video/mp4) ──
    for (const filePath of allFiles(folderPath)) {
      const fname = basename(filePath)
      const ext   = extname(fname).toLowerCase()
      // Skip lottie (already uploaded) and MP4s (blocked by Storage rules, not needed for app)
      if (fname.toLowerCase().includes('image2lottie')) continue
      if (ext === '.mp4') { console.log(`   ⏭️   ${fname} — skipping MP4 (Storage rules block video)`); continue }

      const mime = ext === '.json' ? 'application/json'
                 : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : ext === '.png'  ? 'image/png'
                 : 'application/octet-stream'

      const safeName = fname.replace(/\s+/g, '_').replace(/[()]/g, '')
      const storagePath = `${storagePfx}/${safeName}`
      const sizeMb = statSync(filePath).size / 1024 / 1024
      process.stdout.write(`   📤  ${safeName} (${sizeMb.toFixed(1)}MB)… `)
      try {
        const url = await upload(storage, storagePath, filePath, mime)
        urlMap[id][safeName] = url
        console.log('✓')
      } catch (e) { console.log(`❌  ${e.message}`) }
    }

    // ── 4. Patch Firestore bagItems/{id} ─────────────────────────────────────
    const patch = {}
    if (urlMap[id].thumbnailUrl) patch.previewUrl    = urlMap[id].thumbnailUrl
    if (urlMap[id].animationUrl) patch.animationUrl  = urlMap[id].animationUrl
    if (Object.keys(patch).length) {
      try {
        await setDoc(doc(db, 'bagItems', id), patch, { merge: true })
        console.log(`   ✅  Firestore patched: ${JSON.stringify(patch).slice(0, 80)}…`)
      } catch (e) { console.log(`   ❌  Firestore: ${e.message}`) }
    }
  }

  // ── Save URL map ────────────────────────────────────────────────────────────
  const outPath = join(__dirname, 'uploaded-urls.json')
  writeFileSync(outPath, JSON.stringify(urlMap, null, 2))
  console.log(`\n────────────────────────────────────────`)
  console.log(`📄  Full URL map saved to scripts/uploaded-urls.json`)
  console.log(`\n🎉  Done! Refresh the Bag Items CRM page to see thumbnails.`)

  execSync(`rm -rf "${tmpDir}"`)
  process.exit(0)
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1) })
