/**
 * Audit C-13 — a user-supplied proof URL is a link only when it is `https://`
 * on a Storage host; otherwise it is text.
 *
 * REAL: `lib/safeLink.ts`, imported and called. The wiring on /recharges and
 * in SellerHistoryPanel is checked on their source.
 *
 *   npm run test:safelink
 */

import * as fs from 'fs'
import * as path from 'path'
import { isStorageLink, storageLink } from './safeLink'

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

const STORAGE = 'https://firebasestorage.googleapis.com/v0/b/zipper-83816.firebasestorage.app/o/proofs%2Fa.jpg?alt=media&token=abc'
const SIGNED = 'https://storage.googleapis.com/zipper-83816.firebasestorage.app/proofs/a.jpg?X-Goog-Signature=deadbeef'

eq('a Storage download URL is a link', storageLink(STORAGE), { kind: 'link', href: STORAGE })
eq('a signed Storage URL is a link', storageLink(SIGNED), { kind: 'link', href: SIGNED })
eq('javascript: is text', storageLink('javascript:alert(1)'), { kind: 'text', text: 'javascript:alert(1)' })
eq('data: is text', storageLink('data:text/html;base64,PHNjcmlwdD4='), { kind: 'text', text: 'data:text/html;base64,PHNjcmlwdD4=' })
eq('http:// on the Storage host is text (not https)', storageLink('http://firebasestorage.googleapis.com/x'), { kind: 'text', text: 'http://firebasestorage.googleapis.com/x' })
eq('https:// on another host is text', storageLink('https://evil.example/x.jpg'), { kind: 'text', text: 'https://evil.example/x.jpg' })
eq('a look-alike host is text', storageLink('https://firebasestorage.googleapis.com.evil.example/x'), { kind: 'text', text: 'https://firebasestorage.googleapis.com.evil.example/x' })
eq('a host with credentials is text', storageLink('https://user:pw@storage.googleapis.com/x'), { kind: 'text', text: 'https://user:pw@storage.googleapis.com/x' })
eq('a bare UTR is text', storageLink('UTR 123456789012'), { kind: 'text', text: 'UTR 123456789012' })
eq('blank is none', [storageLink(''), storageLink('   '), storageLink(null), storageLink(undefined), storageLink(42)],
  [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }])
eq('host matching is case-insensitive', storageLink('https://STORAGE.googleapis.com/b/x').kind, 'link')
eq('isStorageLink', [isStorageLink(STORAGE), isStorageLink('javascript:1')], [true, false])

{
  const recharges = fs.readFileSync(path.join(__dirname, '..', 'app', 'recharges', 'page.tsx'), 'utf8')
  ok('/recharges renders proof_url through storageLink', recharges.includes('storageLink(') && !/href=\{(acting\.)?r\.proof_url\}/.test(recharges))
  const panel = fs.readFileSync(path.join(__dirname, '..', 'components', 'SellerHistoryPanel.tsx'), 'utf8')
  ok('SellerHistoryPanel renders proof_url through storageLink', panel.includes('storageLink(') && !/href=\{row\.proof_url\}/.test(panel))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} safe-link checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} safe-link checks passed.`)
console.log('  · only https:// on a Storage host becomes <a href>; everything else is shown as text')
