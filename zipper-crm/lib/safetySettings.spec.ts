/**
 * O13 (5 Nov 2026) — the Safety page saves exactly what the server would keep (functions/src/safety.ts
 * `sanitizeSafetyConfig`): the AI check and automatic ending OFF unless exactly true, every number clamped, words
 * trimmed, lower-cased, de-duplicated and bounded.
 */
import { SAFETY_DEFAULTS, sanitizeSafety } from './safetySettings'

let checks = 0
const failures: string[] = []
function eq(label: string, got: unknown, want: unknown): void {
  checks += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${label}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
}

eq('nothing stored is the defaults', sanitizeSafety(undefined), SAFETY_DEFAULTS)
eq('the AI check is off by default', SAFETY_DEFAULTS.visionEnabled, false)
eq('automatic ending is off by default', SAFETY_DEFAULTS.autoEndOnAdult, false)
eq('a truthy string is not "on"', sanitizeSafety({ visionEnabled: 'true' }).visionEnabled, false)
eq('the interval is clamped to 30–600', [sanitizeSafety({ snapshotEverySeconds: 1 }).snapshotEverySeconds, sanitizeSafety({ snapshotEverySeconds: 9999 }).snapshotEverySeconds], [30, 600])
eq('strikes 1–20, window 5–1440', [sanitizeSafety({ muteAfterStrikes: 0 }).muteAfterStrikes, sanitizeSafety({ strikeWindowMinutes: 1 }).strikeWindowMinutes], [1, 5])
eq('words: trimmed, lower-cased, de-duplicated, 2–40 characters', sanitizeSafety({ badWords: [' Scam ', 'scam', 'x', 'A'.repeat(41), 'ok word'] }).badWords, ['scam', 'ok word'])
eq('the built-in list stays on unless exactly false', [sanitizeSafety({ useBuiltInWords: 0 }).useBuiltInWords, sanitizeSafety({ useBuiltInWords: false }).useBuiltInWords], [true, false])

const server = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'functions', 'src', 'safety.ts'), 'utf8') as string
eq('the server has the same defaults', ['visionEnabled: false', 'autoEndOnAdult: false', 'snapshotEverySeconds: 60', 'muteAfterStrikes: 3', 'strikeWindowMinutes: 60']
  .every((t) => server.includes(t)), true)

if (failures.length) {
  console.error(`${failures.length} of ${checks} safety settings checks FAILED:`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} safety settings checks passed.`)
