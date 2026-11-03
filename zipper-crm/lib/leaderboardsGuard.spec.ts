/**
 * B8 (3 Nov 2026) — the reward tiers the Owner saves are cleaned exactly as the settlement job cleans them, nothing
 * is paid by default, and lucky gifters stays off.
 *
 *   npm run test:leaderboards
 */

import * as fs from 'fs'
import * as path from 'path'
import { cleanTiers, defaultLeaderboardsConfig, leaderboardsProblems, mergeLeaderboardsConfig, periodCost } from './leaderboardsGuard'

let checks = 0
const failures: string[] = []
function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${claim}\n        got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

const d = defaultLeaderboardsConfig()
eq('rankings shown by default', d.enabled, true)
eq('lucky gifters off by default', d.boards.lucky.enabled, false)
eq('nothing paid by default', d.boards.hosts.weekly.tiers, [])

eq('tiers cleaned as the server cleans them', cleanTiers([
  { from: 1, to: 1, amount: 5000 }, { from: 2, to: 3, amount: 2000 }, { from: 3, to: 5, amount: 99 },
  { from: 0, to: 1, amount: 1 }, { from: 4, to: 60, amount: 1 }, { from: 11, to: 50, amount: 100 },
]), [{ from: 1, to: 1, amount: 5000 }, { from: 2, to: 3, amount: 2000 }, { from: 11, to: 50, amount: 100 }])

const m = mergeLeaderboardsConfig({ boards: { lucky: { enabled: 1 }, supporters: { daily: { currency: 'beans' } }, hosts: { weekly: { currency: 'beans' } } } })
eq('lucky needs exactly true', m.boards.lucky.enabled, false)
eq('supporters are paid in diamonds', m.boards.supporters.daily.currency, 'diamonds')
eq('hosts may be paid in beans', m.boards.hosts.weekly.currency, 'beans')

eq('a period\'s cost if every rank is filled', periodCost([{ from: 1, to: 1, amount: 5000 }, { from: 2, to: 3, amount: 2000 }, { from: 4, to: 10, amount: 100 }]), 5000 + 4000 + 700)

const blank = { daily: [], weekly: [], monthly: [] }
eq('a clean draft has no problems', leaderboardsProblems({ hosts: blank, supporters: blank, lucky: blank }), [])
ok('an overlap is reported, not silently dropped', leaderboardsProblems({
  hosts: { ...blank, weekly: [{ from: 1, to: 3, amount: 10 }, { from: 2, to: 4, amount: 5 }] }, supporters: blank, lucky: blank,
}).some((p) => p.includes('Top hosts') && p.includes('weekly')))

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'leaderboards', 'page.tsx'), 'utf8')
ok("the page is the Owner's", page.includes("canAccess(crmUser, ['superadmin'])"))
ok('the page saves the merged (cleaned) config', page.includes('mergeLeaderboardsConfig(') && page.includes("doc(db, 'appConfig', 'leaderboards')"))
ok('the page refuses a save with problems', page.includes('leaderboardsProblems('))
const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
const ownerOnly = (id: string) => new RegExp(`function ownerOnlyConfig\\(\\) \\{\\s*return docId in \\[[^\\]]*'${id}'[^\\]]*\\];`).test(rules) && rules.includes('(ownerOnlyConfig() && isSuperAdmin())')
ok("rules: appConfig/leaderboards is the Owner's alone", ownerOnly('leaderboards'))
ok('rules: no client writes a score', /match \/leaderboards\/\{boardId\} \{\s*allow read: if request\.auth != null;\s*allow write: if false;/.test(rules))

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} leaderboard checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} leaderboard checks passed.`)
