/**
 * Is `out/` actually built from the source that is on disk right now?
 *
 *     cd zipper-crm && npm run verify:out
 *
 * READ ONLY. Reads `out/` and the source tree, writes nothing, deploys nothing.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `firebase.json` points hosting target `production` at `zipper-crm/out`, so a
 * hosting deploy ships whatever is in that directory — not whatever is in git,
 * and not whatever `npm run build` last printed. Those three can disagree, and
 * on 2026-10-05 they did: `out/` was sixteen hours older than the source and
 * still contained the fail-open duplicate check that had been deleted, while a
 * `.next/` directory with a recent timestamp made it look as though a build had
 * just run. A deploy at that moment would have published the old code and
 * reported success.
 *
 * Nothing in the build is at fault. `output: 'export'` in `next.config.js` plus
 * plain `next build` is correct and complete for Next 14 — `next export` was
 * removed in that major and no separate step exists. The failure mode is simply
 * that a build which does not finish leaves `out/` untouched, and an unfinished
 * build is easy to miss in a scrollback.
 *
 * So this asserts the three things a human cannot see by looking at the folder:
 *
 *   1. FRESHNESS   every source file is older than the export.
 *   2. CONTENT     strings that were deleted are gone; strings that were added
 *                  are present. Timestamps can be fooled by `touch`; the
 *                  bundle's own text cannot.
 *   3. IDENTITY    the sha256 of each artifact, so the directory that was
 *                  verified can be matched against the one that was deployed.
 *
 * ── ADDING A PROBE ──────────────────────────────────────────────────────────
 *
 * Only ever use a CONTIGUOUS string literal from the source. A message built
 * from a template literal is split into several literals by the compiler, so
 * `'One person holds ' + \`one of each…\`` never appears as one run of text in
 * the bundle. Each probe below is a single unbroken literal, checked against
 * the source as well as the bundle so a renamed message fails loudly here
 * instead of silently passing for ever.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out')

let checks = 0
const failures = []

function ok(claim, cond, detail = '') {
  checks += 1
  if (cond) return
  failures.push(detail ? `${claim}\n        ${detail}` : claim)
}

// ── Strings that must have LEFT the bundle ──────────────────────────────────
//
// The fail-open duplicate check: a lookup that could not be completed was
// reported to the applicant as "your application was submitted", and the
// create proceeded. Deleted from both public signup pages.
const MUST_BE_GONE = [
  'We could not check whether an application already exists under this',
]

// ── Strings that must have ARRIVED ──────────────────────────────────────────
//
// Deliberately NOT probing the agency-signup message: the identical sentence
// has always existed in `/agencies/register`, so its presence proves nothing.
// A probe that cannot fail is worse than no probe.
const MUST_BE_PRESENT = [
  ['seller-signup fails closed',
   'The check for an existing coin seller under this address could not '],
  ['second-capability check fails closed',
   'The check for businesses you already hold could not be run, so nothing '],
  ['second capability refused when both are held',
   'This account already holds both an agency and a coin seller, so '],
  ['second capability refused when the family is held',
   'one of each, so nothing was created.'],
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function newestSource() {
  const roots = ['app', 'lib', 'components']
    .map((d) => join(ROOT, d))
    .filter(existsSync)
  let newest = { path: '', mtime: 0 }
  for (const r of roots) {
    for (const f of walk(r)) {
      if (!/\.(ts|tsx|js|jsx|css)$/.test(f)) continue
      if (/\.spec\.ts$/.test(f)) continue        // tests are not shipped
      const m = statSync(f).mtimeMs
      if (m > newest.mtime) newest = { path: relative(ROOT, f), mtime: m }
    }
  }
  for (const f of ['next.config.js', 'package.json']) {
    const p = join(ROOT, f)
    if (!existsSync(p)) continue
    const m = statSync(p).mtimeMs
    if (m > newest.mtime) newest = { path: f, mtime: m }
  }
  return newest
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

console.log('\n' + '='.repeat(78))
console.log('zipper-crm/out — is it built from the source on disk right now?')
console.log('='.repeat(78))

if (!existsSync(OUT)) {
  console.error('\n  out/ does not exist. Run `npm run build` first.\n')
  process.exit(1)
}

const files = walk(OUT)
const oldestExport = Math.min(...files.map((f) => statSync(f).mtimeMs))
const newestExport = Math.max(...files.map((f) => statSync(f).mtimeMs))
const src = newestSource()

console.log(`\nfiles in out/        : ${files.length}`)
console.log(`export written       : ${when(oldestExport)} .. ${when(newestExport)} UTC`)
console.log(`newest source file   : ${when(src.mtime)} UTC  (${src.path})`)

// ── 1. Freshness ────────────────────────────────────────────────────────────
console.log('\n1. Freshness')
ok('every source file is older than the export',
  src.mtime <= newestExport,
  `${src.path} is newer than out/ — the export does not contain it`)

// ── 2. Content ──────────────────────────────────────────────────────────────
console.log('2. Content')

const bundle = files
  .filter((f) => f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.txt'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

const source = ['app', 'lib', 'components']
  .map((d) => join(ROOT, d))
  .filter(existsSync)
  .flatMap(walk)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

for (const s of MUST_BE_GONE) {
  ok(`the deleted fail-open string is absent from the bundle`,
    !bundle.includes(s), `still present: ${JSON.stringify(s.slice(0, 60))}…`)
  ok(`  (and from the source, so the probe still means something)`,
    !source.includes(s), 'the string is back in the source — update this probe')
}

for (const [what, s] of MUST_BE_PRESENT) {
  // Guard the probe itself first. If the message was reworded, this fails
  // here with a clear reason rather than reporting a stale bundle.
  ok(`PROBE VALID — source still contains the ${what} message`,
    source.includes(s),
    `no source file contains ${JSON.stringify(s.slice(0, 60))}… — reword the probe`)
  ok(`${what} is in the bundle`,
    bundle.includes(s), 'present in source, missing from out/ — out/ is stale')
}

// ── 3. Identity ─────────────────────────────────────────────────────────────
console.log('3. Artifact hashes')

const interesting = files
  .filter((f) => /\/_next\/static\/chunks\/app\/(agency-signup|seller-signup|agency-dashboard)\/page-[^/]+\.js$/.test(f)
               || /\/_next\/static\/chunks\/(main-app|webpack)-[^/]+\.js$/.test(f))
  .sort()

for (const f of interesting) {
  console.log(`  ${sha(readFileSync(f)).slice(0, 16)}  ${relative(OUT, f)}`)
}

// One hash over the whole directory: filename + content, sorted, so two
// machines building the same source can be compared, and so the directory
// that was verified can be matched against the one that was deployed.
const tree = createHash('sha256')
for (const f of files.sort()) {
  tree.update(relative(OUT, f))
  tree.update(readFileSync(f))
}
const treeHash = tree.digest('hex')
console.log(`\n  out/ tree sha256   : ${treeHash}`)
console.log(`  html pages         : ${files.filter((f) => f.endsWith('.html')).length}`)

// ── 4. The guards, against the REACHABLE chunk set ──────────────────────────
//
// Next.js code-splits. The internal-role Set and the photo resolver are
// imported by several routes, so webpack hoists them OUT of
// `app/users/page-*.js` and into a shared chunk — on this build,
// `1279-*.js`. Asserting against the route's own page chunk therefore failed
// while the protection was present and working.
//
// The fix is not to force the modules back into the page chunk, and not to
// search the whole of `out/` either: `marketing_member` appears in eight
// chunks, because /team, /team-access, /broadcasts, /onboarding and the root
// layout all carry their own role lists. A bundle-wide grep for it passes
// whether or not /users is guarded, which is exactly the kind of check that
// reads as green and proves nothing.
//
// So: parse each route's emitted HTML for the chunks it actually loads, and
// assert against THAT set. It is the real dependency graph, it is what the
// browser executes, and it survives any amount of re-splitting.
console.log('4. Reachable dependency graph')

/** Every chunk the emitted HTML for a route loads, in reference order. */
function chunksFor(htmlPath) {
  const html = readFileSync(join(OUT, htmlPath), 'utf8')
  const refs = [...html.matchAll(/\/_next\/static\/chunks\/[^"')\s]+?\.js/g)].map((m) => m[0])
  const seen = []
  for (const r of refs) {
    const rel = decodeURIComponent(r.replace('/_next/static/chunks/', ''))
    if (!seen.includes(rel)) seen.push(rel)
  }
  return seen
}

/** The concatenated source of those chunks — what the route actually runs. */
function codeFor(htmlPath) {
  return chunksFor(htmlPath)
    .map((c) => {
      const f = join(OUT, '_next', 'static', 'chunks', c)
      return existsSync(f) ? readFileSync(f, 'utf8') : ''
    })
    .join('\n')
}

const ROUTES = {
  'LIST   /users/': 'users/index.html',
  'DETAIL /users/[uid]': 'users/_/index.html',
}

for (const [label, html] of Object.entries(ROUTES)) {
  ok(`${label} — emitted HTML exists`, existsSync(join(OUT, html)), html)
}

const INTERNAL_14 = [
  'superadmin', 'observer',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]

/** The internal-role Set literal as webpack emitted it, parsed back out. */
function emittedRoleSet(code) {
  for (const m of code.matchAll(/new Set\(\[((?:"[a-z_]+",?)+)\]\)/g)) {
    const ids = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])
    if (ids.includes('superadmin')) return ids
  }
  return null
}

for (const [label, html] of Object.entries(ROUTES)) {
  const code = codeFor(html)
  const where = chunksFor(html).find((c) => {
    const f = join(OUT, '_next', 'static', 'chunks', c)
    return existsSync(f) && emittedRoleSet(readFileSync(f, 'utf8'))
  })

  const ids = emittedRoleSet(code)
  ok(`${label} — reaches the internal-role Set`, Boolean(ids),
    'no new Set([...superadmin...]) in any chunk this route loads')
  if (ids) {
    ok(`${label} — it is EXACTLY the 14 internal roles`,
      ids.length === INTERNAL_14.length && INTERNAL_14.every((r) => ids.includes(r)),
      `emitted ${ids.length}: ${ids.join(',')}`)
    ok(`${label} — agency is NOT internal`, !ids.includes('agency'))
    ok(`${label} — seller is NOT internal`, !ids.includes('seller'))
    console.log(`     ${label} role set in ${where}`)
  }
}

// The self guard, in the emitted code rather than in the source. Minified to
// `…&&e.uid===a)return[]`, so the shape is matched rather than a string.
{
  const code = codeFor(ROUTES['LIST   /users/'])
  // The self guard used to be matched here as `.uid===<actor>)return[]`.
  // That regex described ONE minified spelling of it: once the check moved
  // into `isOrdinaryTarget`, the emitted form became `C.uid!==e` returning a
  // boolean and the pattern stopped matching while the guard was present and
  // working. Matching a shape is guessing; section 5 RUNS the function and
  // asserts the actor's own row comes back empty, which is the property
  // itself and survives any spelling. The structural check here is only that
  // the uid is consulted at all in the code this route loads.
  ok('LIST — the reachable code consults the target uid',
    /\.uid\s*[!=]==/.test(code),
    'nothing compares a uid — the self guard cannot be present')
  for (const key of ['"ban"', '"unban"', '"suspend"', '"resume"']) {
    ok(`LIST — ordinary-user action ${key} is still emitted`, code.includes(key))
  }
  // And the role grant is GONE from the list's reachable code: a host comes
  // through an application decided on /kyc, and the route behind the old
  // button no longer exists. A bundle that still emits it is a stale build.
  ok('LIST — no "grant_host" action is emitted any more', !code.includes('"grant_host"'),
    'the bundle still offers Make host — out/ predates the lifecycle change')
}

// ── 5. The emitted action function, EXECUTED ────────────────────────────────
//
// Strings prove the code is present; they do not prove it behaves. This lifts
// the minified function and its Set straight out of the shipped chunk and
// runs them, so the assertions below are about what the browser will actually
// do on /users — not about what the source says.
//
// If the minifier ever emits a shape this cannot lift, that is a FAILURE and
// not a skip: a verifier that quietly stops checking is worse than one that
// is occasionally wrong out loud. Update the extractor, do not delete it.
console.log('5. The emitted function, executed')

/** The body of the function starting at `from`, by brace matching. */
function functionAt(code, from) {
  const open = code.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(from, i + 1)
    }
  }
  return null
}

/**
 * Lift the action policy out of the shipped chunk so it can be RUN.
 *
 * ── IDENTIFIED BY WHAT IT CONTAINS, NOT BY WHERE IT SITS ────────────────────
 *
 * The first version took "the first two-argument function after the role
 * Set". That broke the moment the policy grew: `isOrdinaryTarget(u, actorUid)`
 * is also two arguments, is emitted first, and returns a BOOLEAN — so the
 * verifier lifted the wrong function, every behavioural assertion was asking
 * a predicate for an array, and the run died on `.join is not a function`.
 *
 * Position is not identity. A candidate now has to CONTAIN the action keys it
 * is supposed to return, and then has to pass a smoke test before any
 * assertion trusts it. Both are things only the real function can do.
 */
function liftActionFn(code) {
  const setAt = [...code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*new Set\(\[((?:"[a-z_]+",?)+)\]\)/g)]
    .find((m) => m[2].includes('superadmin'))
  if (!setAt) return null
  const setVar = setAt[1]
  const preamble = `const ${setVar}=new Set([${setAt[2]}]);`

  // ── THE POLICY DOES NOT STAND ALONE ──────────────────────────────────────
  //
  // Webpack emits, consecutively after the Set:
  //
  //     let l=new Set([…]);
  //     function e(C,a){ …l.has(…)… }        ← isOrdinaryTarget
  //     function F(C,a){ if(!e(C,a))return[]; switch(…) }   ← the policy
  //
  // Lifting `F` on its own and evaluating it throws `e is not defined`, so an
  // earlier version silently rejected every candidate and reported that the
  // function could not be found — while it was sitting right there. Collect
  // the whole run of declarations after the Set and evaluate them together.
  const decls = []
  let cursor = code.indexOf('}', setAt.index) >= 0 ? setAt.index : -1
  cursor = code.indexOf(';', setAt.index)
  cursor = cursor < 0 ? setAt.index : cursor + 1
  while (code.startsWith('function', cursor)) {
    const body = functionAt(code, cursor)
    if (!body) break
    const named = /^function\s+([A-Za-z_$][\w$]*)/.exec(body)
    decls.push({ body, name: named ? named[1] : null })
    cursor += body.length
  }

  for (const d of decls) {
    const { body, name } = d
    // It must be able to RETURN these. A predicate cannot.
    if (!body.includes('"unban"') || !body.includes('"resume"')
      || !body.includes('"suspend"')) continue
    const header = /function[^(]*\(([^)]*)\)/.exec(body)
    if (!header || header[1].split(',').filter(Boolean).length !== 2) continue
    if (!name) continue

    let candidate
    try {
      // Every sibling declaration comes along, so the policy's own helpers
      // resolve. Then hand back the one that actually is the policy.
      // eslint-disable-next-line no-new-func
      candidate = new Function(
        `${preamble}${decls.map((x) => x.body).join('\n')}\nreturn ${name};`,
      )()
    } catch { continue }

    // ── SMOKE TEST ────────────────────────────────────────────────────────
    // Prove it behaves like the policy before anything relies on it: an
    // ordinary active account must come back as an array containing 'ban',
    // and an internal one must come back empty.
    try {
      const probe = candidate({ uid: 'a', crmRole: '', accountState: 'active' }, 'b')
      const staff = candidate({ uid: 'a', crmRole: 'superadmin', accountState: 'active' }, 'b')
      if (!Array.isArray(probe) || !probe.includes('ban')) continue
      if (!Array.isArray(staff) || staff.length !== 0) continue
    } catch { continue }
    return candidate
  }
  return null
}

const listCode = codeFor(ROUTES['LIST   /users/'])
const fn = liftActionFn(listCode)
ok('the action function could be lifted out of the shipped chunk', Boolean(fn),
  'no emitted two-argument function returns the action keys and passes the '
  + 'smoke test — update liftActionFn, do not remove this check')

// A throw in here must become a FAILURE, not a stack trace: a verifier that
// dies prints no report at all, so you cannot tell which of the other fifty
// checks passed. That is how the last run ended.
if (fn) try {
  const ACTOR = 'actor-uid'
  const row = (o = {}) => ({ uid: 'ordinary-uid', crmRole: '', accountState: 'active',
    isBanned: false, isSuspended: false, isHost: false, ...o })

  let internalBad = 0
  for (const role of INTERNAL_14) {
    for (const st of ['active', 'suspended', 'banned']) {
      const got = fn(row({
        crmRole: role, accountState: st,
        isBanned: st === 'banned', isSuspended: st === 'suspended',
      }), ACTOR)
      if (!Array.isArray(got) || got.length !== 0) internalBad += 1
    }
  }
  ok(`all 14 internal roles × 3 states return [] (${INTERNAL_14.length * 3} cases)`,
    internalBad === 0, `${internalBad} combinations returned actions`)

  ok('the signed-in actor gets nothing on their own row',
    fn(row({ uid: ACTOR }), ACTOR).length === 0)
  ok('an unknown actor does not blank every row',
    fn(row(), '').length > 0)

  const as = (o, a = ACTOR) => fn(row(o), a).join(',')
  ok('agency keeps ordinary actions', as({ crmRole: 'agency' }) === 'ban,suspend')
  ok('seller keeps ordinary actions', as({ crmRole: 'seller' }) === 'ban,suspend')

  // THE AGREED POLICY, asserted against the shipped function. /users and
  // /users/[uid] both derive their buttons from this, so these six lines
  // cover both screens. Moderation only — no state is offered a role grant.
  ok('active, not a host → ban, suspend',
    as({}) === 'ban,suspend')
  ok('active host        → ban, suspend',
    as({ isHost: true }) === 'ban,suspend')
  ok('suspended          → resume, ban',
    as({ accountState: 'suspended', isSuspended: true }) === 'resume,ban')
  ok('suspended host     → resume, ban',
    as({ accountState: 'suspended', isSuspended: true, isHost: true }) === 'resume,ban')
  ok('banned             → unban',
    as({ accountState: 'banned', isBanned: true }) === 'unban')
  ok('banned host        → unban',
    as({ accountState: 'banned', isBanned: true, isHost: true }) === 'unban')
  // What the policy withholds, named so a regression says why.
  ok('suspended is not offered Suspend or Make host',
    !as({ accountState: 'suspended', isSuspended: true }).includes('suspend')
    && !as({ accountState: 'suspended', isSuspended: true }).includes('grant_host'))
  ok('nobody is offered Make host',
    ![{}, { isHost: true }, { accountState: 'suspended', isSuspended: true },
      { accountState: 'banned', isBanned: true }].some((o) => as(o).includes('grant_host')))
  ok('banned is not offered Ban, Suspend or Make host',
    as({ accountState: 'banned', isBanned: true }) === 'unban')
} catch (err) {
  ok('the lifted action function ran without throwing', false,
    `${err && err.message} — the lifted function is not the policy`)
}

// ── 6. Default-avatar artwork, in the reachable code ────────────────────────
console.log('6. Default avatars')

const AVATAR_IDS = [
  'fox', 'panda', 'cat', 'owl', 'frog', 'penguin',
  'bear', 'bunny', 'tiger', 'horse', 'bird', 'monkey',
]

for (const [label, html] of Object.entries(ROUTES)) {
  const code = codeFor(html)
  const urls = [...code.matchAll(/data:image\/svg\+xml,%3Csvg[^"']+/g)].map((m) => m[0])
  const unique = new Set(urls)
  ok(`${label} — reaches at least 12 inline avatars`, unique.size >= AVATAR_IDS.length,
    `found ${unique.size} distinct data URLs`)
  ok(`${label} — reaches the avatar: scheme`, /["']avatar:["']/.test(code),
    'the scheme literal is missing, so nothing resolves avatar:<id>')
  const decoded = [...unique].map((u) => decodeURIComponent(u))
  ok(`${label} — every avatar decodes to an SVG with a viewBox`,
    decoded.length > 0 && decoded.every((d) => d.includes('<svg') && d.includes('viewBox=')))
  ok(`${label} — the artwork is colour, not a black silhouette`,
    decoded.some((d) => /fill="#(?!000000)[0-9A-Fa-f]{6}"/.test(d)),
    'every fill is #000000 — invisible on the dark CRM rows')
}

// The original symptom, asserted from the far side: no emitted page may hand
// a browser `src="avatar:…"`, which is what drew the broken-image icon.
{
  const offenders = files
    .filter((f) => f.endsWith('.html') || f.endsWith('.js'))
    .filter((f) => /src=\\?["']avatar:/.test(readFileSync(f, 'utf8')))
  ok('no emitted file sets src="avatar:…"', offenders.length === 0,
    offenders.map((f) => relative(OUT, f)).join(', '))
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(78))
if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error(
    '\nIf the freshness and content checks failed together, out/ predates the\n'
    + 'current source: run `npm run build` and verify again. `next build` is\n'
    + 'the whole export — there is no separate `next export` in Next 14.\n',
  )
  process.exit(1)
}
console.log(`All ${checks} checks passed.`)
console.log('  · out/ is newer than every source file it is built from')
console.log('  · the deleted fail-open duplicate check is gone from the bundle')
console.log('  · this session\'s fail-closed checks are present in the bundle')
console.log('  · /users and /users/[uid] both REACH the 14-role set, exactly')
console.log('  · the shipped function was executed: 42 internal cases return []')
console.log('  · self guard holds; agency and seller keep ordinary actions')
console.log('  · the agreed action policy holds in the shipped function')
console.log('  · twelve distinct colour avatars reachable; no src="avatar:" anywhere')
console.log(`  · tree sha256 ${treeHash.slice(0, 32)}…`)
console.log('='.repeat(78) + '\n')
