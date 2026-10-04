/**
 * upload-assets.cjs
 * ─────────────────
 * Extracts a zip and uploads all images + Lottie JSON files to Firebase Storage.
 * Prints a URL map and saves it to uploaded-urls.json.
 *
 * Credentials come from the environment — never from this file:
 *   ZIPPER_ADMIN_EMAIL     admin account used to sign in
 *   ZIPPER_ADMIN_PASSWORD  its password
 *
 * Usage (from zipper-crm/):
 *   ZIPPER_ADMIN_EMAIL=... ZIPPER_ADMIN_PASSWORD=... \
 *     node scripts/upload-assets.cjs /path/to/your-file.zip [storage-folder]
 *
 * Examples:
 *   ZIPPER_ADMIN_EMAIL=you@example.com ZIPPER_ADMIN_PASSWORD='…' \
 *     node scripts/upload-assets.cjs ~/Downloads/frames.zip
 *   ZIPPER_ADMIN_EMAIL=you@example.com ZIPPER_ADMIN_PASSWORD='…' \
 *     node scripts/upload-assets.cjs ~/Downloads/entrances.zip bag_items/lottie/entrances
 *
 * Output file: zipper-crm/scripts/uploaded-urls.json
 */

'use strict'

const { initializeApp }                          = require('firebase/app')
const { getAuth, signInWithEmailAndPassword }    = require('firebase/auth')
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage')
const { execSync }  = require('child_process')
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } = require('fs')
const { join, extname, basename, dirname } = require('path')

// ── Config ────────────────────────────────────────────────────────────────────

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
  '    node scripts/upload-assets.cjs /path/to/file.zip',
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

// File types to upload
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const JSON_EXTS  = new Set(['.json'])

// Content types
function contentType(ext) {
  const map = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.json': 'application/json',
  }
  return map[ext] || 'application/octet-stream'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function walkDir(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkDir(full, files)
    } else {
      const ext = extname(entry).toLowerCase()
      if (IMAGE_EXTS.has(ext) || JSON_EXTS.has(ext)) {
        // Skip huge files (>2MB for JSON = likely raw video export, not lottie)
        const sizeMb = statSync(full).size / 1024 / 1024
        if (ext === '.json' && sizeMb > 2) {
          console.log(`  ⏭️   Skipping ${entry} (${sizeMb.toFixed(1)}MB — too large, likely raw video export)`)
        } else {
          files.push(full)
        }
      }
    }
  }
  return files
}

function sanitize(name) {
  // Remove spaces, special chars; keep alphanumeric, dash, underscore, dot
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Fail before doing any work if credentials are not supplied.
  const { email, password } = requireCredentials()

  const zipPath = process.argv[2]
  if (!zipPath || !existsSync(zipPath)) {
    console.error('Usage: node scripts/upload-assets.cjs /path/to/file.zip [storage-folder]')
    console.error('Example: node scripts/upload-assets.cjs ~/Downloads/frames.zip')
    process.exit(1)
  }

  // Storage folder — default based on zip name
  const defaultFolder = 'contentAssets/bag_items/' + basename(zipPath, extname(zipPath)).replace(/\s+/g, '_')
  const storageFolder = process.argv[3] || defaultFolder

  console.log(`\n📦  Zip:     ${zipPath}`)
  console.log(`☁️   Folder:  ${storageFolder}\n`)

  // Extract zip to temp dir
  const tmpDir = join(require('os').tmpdir(), 'zipper_upload_' + Date.now())
  mkdirSync(tmpDir, { recursive: true })
  console.log('📂  Extracting…')
  execSync(`unzip -q -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'inherit' })

  // Collect files
  const files = walkDir(tmpDir)
  console.log(`\n🔍  Found ${files.length} uploadable file(s)\n`)
  if (!files.length) { console.log('No images or JSON files found.'); process.exit(0) }

  // Firebase
  const app     = initializeApp(FIREBASE_CONFIG)
  const auth    = getAuth(app)
  const storage = getStorage(app)

  console.log(`🔐  Signing in as ${email}…`)
  await signInWithEmailAndPassword(auth, email, password)
  console.log('✅  Signed in\n')

  const urlMap = {}   // filename → { url, storagePath }
  let ok = 0, fail = 0

  for (const filePath of files) {
    const ext      = extname(filePath).toLowerCase()
    const name     = sanitize(basename(filePath))
    const storagePath = `${storageFolder}/${name}`

    const sizekb = Math.round(statSync(filePath).size / 1024)
    process.stdout.write(`⬆️   ${name} (${sizekb}KB) … `)

    try {
      const data = readFileSync(filePath)
      const storageRef = ref(storage, storagePath)
      await uploadBytes(storageRef, data, { contentType: contentType(ext) })
      const url = await getDownloadURL(storageRef)
      urlMap[name] = { url, storagePath }
      console.log('✓')
      ok++
    } catch (err) {
      console.error(`❌  ${err.message}`)
      fail++
    }
  }

  // Save URL map
  const outPath = join(__dirname, 'uploaded-urls.json')
  const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {}
  writeFileSync(outPath, JSON.stringify({ ...existing, ...urlMap }, null, 2))

  console.log(`\n────────────────────────────────────────`)
  console.log(`✅  Uploaded : ${ok}`)
  console.log(`❌  Failed   : ${fail}`)
  console.log(`\n📄  URLs saved to: scripts/uploaded-urls.json`)
  console.log(`\n── URL Map ──────────────────────────────`)
  for (const [name, { url }] of Object.entries(urlMap)) {
    console.log(`  ${name}`)
    console.log(`    ${url}`)
  }

  // Clean up temp dir
  execSync(`rm -rf "${tmpDir}"`)
  process.exit(0)
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1) })
