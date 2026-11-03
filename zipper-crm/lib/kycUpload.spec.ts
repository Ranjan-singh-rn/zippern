/**
 * QA #29 / #32 — KYC uploads: an oversized or wrong-type file is refused with
 * the reason before uploading; a Storage refusal is worded as what it is; a
 * retry that works clears the old error.
 *
 * REAL: `lib/kycUpload.ts`, imported and called. The limits are compared with
 * `storage.rules` (when it sits beside this repo) and the five upload screens
 * are read for the wiring.
 *
 *   npm run test:kycupload
 */

import * as fs from 'fs'
import * as path from 'path'
import { KYC_CONTENT_TYPES, KYC_MAX_MB, kycFileProblem, kycUploadErrorText } from './kycUpload'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

const MB = 1024 * 1024

// ── Size and type, before uploading ──────────────────────────────────────────
eq('a 12.4 MB photo is refused with its size and the limit',
  kycFileProblem({ size: Math.round(12.4 * MB), type: 'image/jpeg' }),
  'That file is 12.4 MB. The limit is 10 MB — choose a smaller file, or take a photo of the document instead.')
eq('exactly 10 MB is allowed (the rule is ≤)', kycFileProblem({ size: 10 * MB, type: 'image/jpeg' }), null)
eq('a JPG, PNG or PDF under the limit is fine',
  ['image/jpeg', 'image/png', 'application/pdf', 'image/jpg'].map((type) => kycFileProblem({ size: 2 * MB, type })),
  [null, null, null, null])
eq('a HEIC or WebP is refused before it is sent (the rules would refuse it)',
  [kycFileProblem({ size: MB, type: 'image/heic' }), kycFileProblem({ size: MB, type: 'image/webp' })],
  ['That file type cannot be used. Upload a JPG, PNG or PDF.', 'That file type cannot be used. Upload a JPG, PNG or PDF.'])
eq('a browser that reports no type is not refused for it', kycFileProblem({ size: MB, type: '' }), null)

// ── Storage's refusals, in words ──────────────────────────────────────────────
ok('storage/unauthorized no longer reads as an account problem',
  kycUploadErrorText({ code: 'storage/unauthorized', message: 'User does not have permission to access this object.' })
    .startsWith('The file was refused. Upload a JPG, PNG or PDF under 10 MB.'))
eq('a cancelled upload', kycUploadErrorText({ code: 'storage/canceled' }), 'The upload was cancelled.')
eq('a network failure', kycUploadErrorText({ code: 'storage/retry-limit-exceeded' }),
  'The upload could not finish. Check your connection and try again.')
eq('anything else keeps its own message', kycUploadErrorText(new Error('boom')), 'Upload failed: boom')

// ── The limits are the rules' ─────────────────────────────────────────────────
const rulesPath = path.join(__dirname, '..', '..', 'storage.rules')
if (fs.existsSync(rulesPath)) {
  const rules = fs.readFileSync(rulesPath, 'utf8')
  const doc = rules.slice(rules.indexOf('function isDocument()'), rules.indexOf('function maxSize('))
  for (const t of KYC_CONTENT_TYPES) ok(`rules: isDocument() admits ${t}`, doc.includes(`'${t}'`))
  for (const p of ['/kyc/agencies/signup/{fileName}', '/sellerDocs/signup/{fileName}', '/kyc/applicants/{uid}/{fileName}']) {
    const at = rules.indexOf(`match ${p}`)
    ok(`rules: ${p} caps at ${KYC_MAX_MB} MB`, at > 0 && rules.slice(at, at + 400).includes(`maxSize(${KYC_MAX_MB})`))
  }
}

// ── Wiring: every KYC upload screen checks first and clears on retry ─────────
const root = path.join(__dirname, '..')
for (const page of ['agencies/register', 'agency-signup', 'seller-signup']) {
  const src = fs.readFileSync(path.join(root, 'app', page, 'page.tsx'), 'utf8')
  ok(`/${page}: checks the file before uploading`, src.includes('const problem = kycFileProblem(file)'))
  ok(`/${page}: words a failure with kycUploadErrorText`, src.includes('setError(kycUploadErrorText(err))'))
  ok(`/${page}: a new attempt clears the old error (QA #29)`, /setError\(''\)\s*\n\s*(\/\/[^\n]*\n\s*)*const problem = kycFileProblem\(file\)/.test(src)
    || src.includes("// QA #29: a new attempt clears the last one's error"))
  ok(`/${page}: a successful upload clears it too`, /setUrl\([^)]*\)\)?\s*\n\s*setError\(''\)/.test(src))
  ok(`/${page}: Firebase's raw "Upload failed: " + err.message is gone`, !src.includes("'Upload failed: ' + (err.message"))
}
{
  const src = fs.readFileSync(path.join(root, 'app', 'sellers', 'register', 'page.tsx'), 'utf8')
  ok('/sellers/register: checks documents before uploading', src.includes('const problem = kycFileProblem(file)'))
  const dash = fs.readFileSync(path.join(root, 'app', 'agency-dashboard', 'page.tsx'), 'utf8')
  ok('agency dashboard (Add Sub-Agency): checks, and SAYS a failure instead of resetting silently',
    dash.includes('error: kycUploadErrorText(err)') && dash.includes('{state.error && !state.uploading && !done && ('))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} KYC upload checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} KYC upload checks passed.`)
console.log('  · QA #32: an oversized or wrong-type document is refused with the reason, before uploading')
console.log('  · QA #29: a retry that works clears the previous error')
