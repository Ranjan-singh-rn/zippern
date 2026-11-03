/**
 * QA #47 — one email domain (zipperlive.org), three addresses, the same in the
 * CRM, the backend, the Functions and the app; no old address left in the CRM.
 *
 * REAL: `lib/contacts.ts`, imported and called. The other three codebases are
 * read from source when they sit beside this repo.
 *
 *   npm run test:contacts
 */

import * as fs from 'fs'
import * as path from 'path'
import { INFO_EMAIL, NO_REPLY_EMAIL, OFFICIAL_EMAIL_DOMAIN, SUPPORT_EMAIL, mailtoHref, officialOr } from './contacts'

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

// ── The three ─────────────────────────────────────────────────────────────────
eq('the official domain', OFFICIAL_EMAIL_DOMAIN, 'zipperlive.org')
eq('the three addresses', [NO_REPLY_EMAIL, INFO_EMAIL, SUPPORT_EMAIL],
  ['no-reply@zipperlive.org', 'info@zipperlive.org', 'support@zipperlive.org'])
eq('a mailto', mailtoHref(SUPPORT_EMAIL), 'mailto:support@zipperlive.org')
eq('…with a subject', mailtoHref(SUPPORT_EMAIL, 'Appeal ZA-1'), 'mailto:support@zipperlive.org?subject=Appeal%20ZA-1')

// ── Environment overrides: only on the domain, never the sender ──────────────
eq('an override on the domain is used (tidied)', officialOr(' Help@ZipperLive.org ', SUPPORT_EMAIL), 'help@zipperlive.org')
eq('an override elsewhere is ignored', officialOr('someone@gmail.com', SUPPORT_EMAIL), SUPPORT_EMAIL)
eq('a look-alike domain is ignored', officialOr('support@zipperlive.org.evil.test', SUPPORT_EMAIL), SUPPORT_EMAIL)
eq('the no-reply sender is never a contact', officialOr('no-reply@zipperlive.org', SUPPORT_EMAIL), SUPPORT_EMAIL)
eq('nothing set is the default', officialOr(undefined, INFO_EMAIL), INFO_EMAIL)

// ── No old address anywhere in the CRM's source ──────────────────────────────
const root = path.join(__dirname, '..')
const OLD = /314zipper@gmail\.com|@zipperlive\.(?:com|app)\b|@zipper\.app\b/
const offenders: string[] = []
function walk(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full)
    else if (/\.(tsx?|jsx?|json|html|md)$/.test(name) && !name.endsWith('.spec.ts')) {
      if (OLD.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full))
    }
  }
}
for (const d of ['app', 'components', 'lib']) walk(path.join(root, d))
eq('no CRM source names an old address', offenders, [])

// ── The other three codebases agree ───────────────────────────────────────────
const repo = path.join(root, '..')
const sources: [string, RegExp[]][] = [
  ['backend/app/core/contacts.py', [/OFFICIAL_DOMAIN = "zipperlive\.org"/, /NO_REPLY = f"no-reply@\{OFFICIAL_DOMAIN\}"/,
    /INFO = f"info@\{OFFICIAL_DOMAIN\}"/, /SUPPORT = f"support@\{OFFICIAL_DOMAIN\}"/]],
  ['backend/app/config.py', [/mail_from: str = "no-reply@zipperlive\.org"/, /contact_support_email: str = "support@zipperlive\.org"/,
    /contact_info_email: str = "info@zipperlive\.org"/, /email_identity_info_enabled: bool = False/,
    /email_identity_support_enabled: bool = False/]],
  ['functions/src/mail.ts', [/const DEFAULT_FROM_EMAIL = 'no-reply@zipperlive\.org'/, /export const OFFICIAL_EMAIL_DOMAIN = 'zipperlive\.org'/,
    /export const SUPPORT_EMAIL = `support@\$\{OFFICIAL_EMAIL_DOMAIN\}`/, /export const INFO_EMAIL = `info@\$\{OFFICIAL_EMAIL_DOMAIN\}`/]],
  ['zipper-app/app/src/main/java/com/zipper/app/util/ZipperContacts.kt', [/const val DOMAIN = "zipperlive\.org"/,
    /const val NO_REPLY = "no-reply@\$DOMAIN"/, /const val SUPPORT = "support@\$DOMAIN"/, /const val INFO = "info@\$DOMAIN"/]],
]
for (const [file, patterns] of sources) {
  const full = path.join(repo, file)
  if (!fs.existsSync(full)) continue
  const src = fs.readFileSync(full, 'utf8')
  for (const p of patterns) ok(`${file}: ${p.source}`, p.test(src))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} contact checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} contact checks passed.`)
console.log('  · QA #47: zipperlive.org — no-reply@ sends, support@ and info@ are contacts; the four codebases agree')
