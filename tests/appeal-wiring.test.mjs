/**
 * The appeal screen's rule exists in exactly one place, and the user can see it.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────
 *
 * It is NOT a substitute for `AppealStatementTest.kt`. That file is the real
 * test of the rule's boundaries and it runs under `./gradlew
 * testDebugUnitTest`, which needs the Android SDK.
 *
 * What this adds, and what a Kotlin unit test structurally cannot: the
 * guarantee that a SECOND copy of the rule has not reappeared somewhere else
 * in the app. The defect was never a wrong comparison — every one of the three
 * copies was individually correct. It was that there were three, that only one
 * of them was visible to the user, and that the one the user hit had no way of
 * explaining itself. A unit test of the rule passes happily while a fourth
 * copy drifts in a Compose file it never imports.
 *
 * So this reads the Kotlin as text and asserts the shape:
 *
 *   1. one object owns the minimum, and it imports nothing;
 *   2. nothing else in the app spells the comparison out for itself;
 *   3. the number is on the screen, next to the field, while they type;
 *   4. the repository refuses with a message that names it.
 *
 * ── WHY IT LIVES HERE ────────────────────────────────────────────────────────
 *
 * `tests/` is the repo's home for checks that span codebases. This one reads
 * Kotlin from `zipper-app/` and has no Android toolchain of its own.
 *
 *     node tests/appeal-wiring.test.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(REPO, 'zipper-app', 'app', 'src')

let checks = 0
const failures = []

function ok(claim, cond, detail = '') {
  checks += 1
  if (!cond) failures.push(detail ? `${claim}\n        ${detail}` : claim)
}

function read(...parts) {
  return readFileSync(join(APP, ...parts), 'utf8')
}

/** Every .kt file under app/src, so "nowhere else" means nowhere else. */
function kotlinFiles(dir = APP, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) kotlinFiles(full, out)
    else if (name.endsWith('.kt')) out.push(full)
  }
  return out
}

// ── 1. One object owns the rule, and it depends on nothing ──────────────────
console.log('\n1. The rule has one home')

const STATEMENT = 'main/java/com/zipper/app/data/repository/AppealStatement.kt'
const statement = read(STATEMENT)

ok('AppealStatement exists', statement.includes('object AppealStatement'))
ok('it declares the minimum', /const val MIN = \d+/.test(statement))
ok('it exposes a trimmed length', statement.includes('fun length(raw: String)'))
ok('…and the single gate', statement.includes('fun isSendable(raw: String)'))
ok('the gate is defined in terms of the length, not a second measurement',
  /fun isSendable\(raw: String\): Boolean = length\(raw\) >= MIN/.test(statement))

// The property that makes it unit-testable without a device, asserted rather
// than hoped for. One `import` line here and `AppealStatementTest` needs
// Robolectric, which this project does not have.
const imports = statement
  .split('\n')
  .filter((l) => l.startsWith('import '))
ok('it imports nothing at all', imports.length === 0,
  `imports found: ${imports.join(', ')}`)

const min = Number(statement.match(/const val MIN = (\d+)/)?.[1])
ok('the minimum is a real number', Number.isInteger(min) && min > 0)
ok('…short enough for one honest sentence', min >= 1 && min <= 60,
  `MIN is ${min}; a minimum that works as a hurdle loses real appeals`)

// ── 2. Nowhere else measures it ─────────────────────────────────────────────
console.log('2. No second copy')

// The three shapes the old code used, in any file other than the object
// itself: a bare comparison against the constant, a hard-coded 20, or a
// `.trim().length` measurement of a statement.
const copies = []
for (const file of kotlinFiles()) {
  const rel = relative(REPO, file)
  if (rel.endsWith('AppealStatement.kt')) continue
  // The test file quotes the old expressions in its own prose, deliberately.
  if (rel.includes('/test/')) continue

  const src = readFileSync(file, 'utf8')
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  if (/statement[A-Za-z]*\s*\.trim\(\)\s*\.length/.test(code)) {
    copies.push(`${rel}: measures a statement itself instead of calling AppealStatement.length`)
  }
  if (/\.length\s*[<>]=?\s*20\b/.test(code)) {
    copies.push(`${rel}: compares against a hard-coded 20`)
  }
  if (/MIN_STATEMENT/.test(code)) {
    copies.push(`${rel}: references the old AppealRepository.MIN_STATEMENT`)
  }
}
ok('no file measures or compares the statement for itself', copies.length === 0,
  copies.join('\n        '))

// ── 3. The number is on the screen ──────────────────────────────────────────
console.log('3. The user can see it')

const screen = read('main/java/com/zipper/app/ui/screens/auth/BannedScreen.kt')

ok('the screen reads the shared object', screen.includes('AppealStatement.'))
ok('it shows a live count against the minimum',
  screen.includes('"$typed / ${AppealStatement.MIN}"'),
  'the count is the remedy — without it the grey button explains nothing')
ok('it says what is still needed in words',
  screen.includes('"At least ${AppealStatement.MIN} characters"'))
ok('the count is derived from the same function as the gate',
  screen.includes('AppealStatement.length(state.statement)'))
ok('the Send button is gated by that same function',
  screen.includes('AppealStatement.isSendable(state.statement)'))
ok('…and not by a comparison of its own',
  !/enabled\s*=\s*state\.statement\.trim\(\)\.length/.test(screen))

// The hint only turns red once they have started: an untouched field is not
// an error, and a form that is red before it is touched reads as broken.
ok('the warning colour waits until they have typed something',
  /if \(short && typed > 0\)/.test(screen))

// ── 4. The repository refuses with a message that names the number ──────────
console.log('4. The backstop still explains itself')

const repo = read('main/java/com/zipper/app/data/repository/AppealRepository.kt')

ok('the repository gates on the shared object',
  repo.includes('AppealStatement.isSendable(statement)'))
ok('…and returns the shared message',
  repo.includes('Result.Failed(AppealStatement.TOO_SHORT)'))
ok('the message names the minimum',
  statement.includes('at least $MIN characters'))
ok('the evidence cap comes from the same place too',
  repo.includes('AppealStatement.MAX_EVIDENCE'))

// A dropped screenshot is reported. The appeal is still filed — losing
// somebody's written account because a photograph failed is the wrong trade —
// but it was previously swallowed in silence.
ok('a dropped screenshot is counted, not swallowed',
  repo.includes('dropped += 1') && repo.includes('Result.Ok(dropped)'))
ok('…and the screen says so', screen.includes('state.evidenceDropped > 0'))

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.error('  ✗', f)
  console.error(
    '\nThe appeal statement rule must live in AppealStatement and nowhere else,\n' +
    'and the minimum must be visible on the screen while the person types.\n'
  )
  process.exit(1)
}
console.log(`\nAll ${checks} appeal-wiring checks passed.`)
console.log('  · one dependency-free object owns the rule')
console.log('  · no file measures or compares the statement for itself')
console.log('  · the minimum and a live count are on the screen')
console.log('  · the repository backstop and the dropped-evidence notice are wired\n')
