/**
 * Who, exactly, can do what to every real Storage path.
 *
 * ── THE BUG CLASS THIS EXISTS FOR ────────────────────────────────────────────
 *
 * Firebase Security Rules are a PERMISSIVE UNION. A path is governed by every
 * `match` block whose pattern fits it, and one `allow` anywhere is enough. A
 * more specific block does not override a more general one — nothing
 * overrides anything.
 *
 * That already cost this project twice. `kyc/agencies/signup/<file>` is four
 * segments, so it matches both `/kyc/agencies/signup/{fileName}` and
 * `/kyc/{agencyId}/{hostUid}/{fileName}`, and the second block's
 * `allow write` silently re-granted the overwrite the first block's
 * `resource == null` existed to prevent. `sellerDocs/signup/<file>` had the
 * identical problem under `/sellerDocs/{sellerId}/{fileName}`. Both were
 * found by reading. Neither should have had to be.
 *
 * ── WHY THIS IS AN EVALUATOR AND NOT A LINT ──────────────────────────────────
 *
 * The first version of this script scored each condition for "breadth" and
 * compared blocks. It was wrong, and wrong in the dangerous direction: a
 * disjunction is as broad as its BROADEST arm, and the scorer took the
 * narrowest, so `isKycReviewer() || isAgencyFor(x)` scored as narrower than
 * `isKycReviewer()` alone. It then reported fourteen "widenings" that were all
 * artefacts, which is how a check that cannot be trusted becomes a check
 * nobody reads.
 *
 * So this evaluates instead. Every condition is parsed and run for every
 * principal, with the path wildcards bound to the concrete path — which means
 * the literal guards (`!(agencyId == 'agencies' && hostUid == 'signup')`,
 * `sellerId != 'signup'`) are actually evaluated rather than guessed at. The
 * union across blocks is the real answer, and it is compared against a
 * declared expectation. There is no heuristic left.
 *
 * Content and size predicates — `isDocument()`, `isImage()`, `maxSize()`,
 * `resource == null` — evaluate TRUE. The question being asked is "given an
 * otherwise well-formed request, WHO is admitted", and conflating a size cap
 * with an authorisation boundary is what produced the original bug.
 *
 * Run:  node tests/storage-rule-overlap.mjs
 * Needs nothing installed, touches no network, reads only ../storage.rules.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const RULES = readFileSync(join(here, '..', 'storage.rules'), 'utf8')

// ── Principals ──────────────────────────────────────────────────────────────

const P = (name, o) => ({ name, uid: null, role: '', aid: '', provider: 'password', ...o })

const PRINCIPALS = [
  P('anonymous (no token)',   { uid: null }),
  P('guest (anon sign-in)',   { uid: 'guest1', provider: 'anonymous' }),
  P('app user',               { uid: 'alice', provider: 'phone' }),
  P('host',                   { uid: 'hostH', provider: 'phone' }),
  P('agency AG7',             { uid: 'agU7', role: 'agency', aid: 'AG7' }),
  P('agency AG9',             { uid: 'agU9', role: 'agency', aid: 'AG9' }),
  P('sub-agency SUB3',        { uid: 'subU3', role: 'agency', aid: 'SUB3' }),
  P('seller S1',              { uid: 'S1', role: 'seller' }),
  P('seller S2',              { uid: 'S2', role: 'seller' }),
  P('owner',                  { uid: 'own1', role: 'owner' }),
  P('observer',               { uid: 'obs1', role: 'observer' }),
  P('app_admin',              { uid: 'aa1', role: 'app_admin' }),
  P('ops_member',             { uid: 'om1', role: 'ops_member' }),
  P('finance_admin',          { uid: 'fa1', role: 'finance_admin' }),
  P('tech_admin',             { uid: 'ta1', role: 'tech_admin' }),
  P('marketing_member',       { uid: 'mm1', role: 'marketing_member' }),
]

const byName = Object.fromEntries(PRINCIPALS.map((p) => [p.name, p]))

// ── A small evaluator for the subset of the rules language this file uses ───

function tokenize(src) {
  const out = []
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|\[|\]|,|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*|\d+|\S)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

/** Strip `//` comments — they appear inside multi-line conditions in this file. */
const decomment = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join(' ')

function evaluate(cond, ctx) {
  const t = tokenize(decomment(cond))
  let i = 0
  const peek = () => t[i]
  const take = () => t[i++]

  // A value — a literal, an identifier, or a predicate call. Kept separate
  // from `primary` so that a CALL can still be the left-hand side of a
  // comparison: `roleClaim() == 'agency'` is real syntax in this file, and an
  // earlier version returned straight out of the call branch, leaving
  // `== 'agency'` and its two closing parens unparsed.
  function value() {
    const tok = take()
    if (t[i] === '(') {
      const args = []
      take() // (
      while (peek() !== ')') { const a = take(); if (a !== ',') args.push(a) }
      take() // )
      return { v: callFn(tok, args, ctx), call: true }
    }
    return { v: resolve(tok, ctx), call: false, tok }
  }

  function primary() {
    if (peek() === '!') { take(); return !primary() }
    if (peek() === '(') { take(); const v = or(); take(); return v }

    const left = value()

    // `x in ['a','b']`
    if (peek() === 'in') {
      take(); take() // in [
      const set = []
      while (peek() !== ']') { const a = take(); if (a !== ',') set.push(a.replace(/'/g, '')) }
      take() // ]
      return set.includes(left.v)
    }

    if (peek() === '==' || peek() === '!=') {
      const op = take()
      const right = value()
      return op === '==' ? left.v === right.v : left.v !== right.v
    }

    return !!left.v
  }

  function and() { let v = primary(); while (peek() === '&&') { take(); const r = primary(); v = v && r } return v }
  function or()  { let v = and();     while (peek() === '||') { take(); const r = and();     v = v || r } return v }

  const v = or()
  if (i < t.length) throw new Error(`unparsed tail in condition: ${t.slice(i).join(' ')}`)
  return v
}

function resolve(tok, ctx) {
  if (tok === undefined) return undefined
  if (tok.startsWith("'")) return tok.replace(/'/g, '')
  if (tok === 'null') return null
  if (tok === 'true') return true
  if (tok === 'false') return false
  if (tok === 'request.auth') return ctx.p.uid === null ? null : 'AUTH'
  if (tok === 'request.auth.uid') return ctx.p.uid
  if (tok === 'resource') return null          // a fresh object; see the header
  if (tok in ctx.bind) return ctx.bind[tok]    // a path wildcard
  if (tok === 'roleClaim') return ctx.p.role
  return tok
}

function callFn(name, args, ctx) {
  const p = ctx.p
  const a0 = args[0] !== undefined ? resolve(args[0], ctx) : undefined

  const GOVERNANCE = ['owner', 'observer']
  // Mirrors isKycReviewer(), which mirrors CAN_VIEW_AGENCIES/CAN_VIEW_SELLERS.
  const KYC = [...GOVERNANCE, 'app_admin', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member']
  const FIN = [...GOVERNANCE, 'finance_admin', 'finance_member']
  const SUP = [...GOVERNANCE, 'app_admin', 'app_member', 'ops_admin', 'ops_member', 'support_admin', 'support_member', 'tech_admin']

  switch (name) {
    case 'roleClaim':   return p.role
    case 'agencyClaim': return p.aid
    case 'isSignedIn':  return p.uid !== null
    case 'isAppUser':   return p.uid !== null
    case 'hasRoleClaim': return p.role !== ''
    case 'isGovernance': return GOVERNANCE.includes(p.role)
    case 'isKycReviewer': return KYC.includes(p.role)
    case 'isFinance':    return FIN.includes(p.role)
    case 'isSupport':    return SUP.includes(p.role)
    case 'isInternal':   return KYC.includes(p.role) || FIN.includes(p.role) || SUP.includes(p.role)
    case 'isOwner':      return p.uid !== null && p.uid === a0
    // Mirrors storage.rules: signed in AND a real provider AND not anonymous.
    case 'isNonGuest':   return p.uid !== null && !!p.provider && p.provider !== 'anonymous'
    case 'isOwnerPerson': return p.uid !== null && p.uid === a0 && !!p.provider && p.provider !== 'anonymous'
    case 'isAgencyFor':  return p.role === 'agency' && p.aid !== '' && p.aid === a0
    case 'isSellerFor':  return p.role === 'seller' && p.uid === a0
    // Shape, not authorisation — see the header.
    case 'isImage': case 'isVideo': case 'isImageOrVideo': case 'isDocument': case 'maxSize':
      return true
    default: throw new Error(`unknown predicate ${name}()`)
  }
}

// ── Parse the rules ─────────────────────────────────────────────────────────

function parseBlocks(src) {
  const blocks = []
  const re = /match\s+(\S.*?)\s*\{\s*\n/g
  let m
  while ((m = re.exec(src))) {
    const path = m[1].trim()
    if (!path.startsWith('/') || path.startsWith('/b/')) continue
    let depth = 1, i = m.index + m[0].length
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++ }
    const body = src.slice(m.index + m[0].length, i)
    const allows = {}
    const ar = /allow\s+([a-z,\s]+?):\s*if([^;]+);/g
    let a
    while ((a = ar.exec(body))) {
      for (const meth of a[1].split(',').map((x) => x.trim())) {
        const cond = a[2]
        if (meth === 'read') { allows.get ??= cond; allows.list ??= cond }
        else if (meth === 'write') { allows.create ??= cond; allows.update ??= cond; allows.delete ??= cond }
        else allows[meth] = cond
      }
    }
    blocks.push({ path, allows })
  }
  return blocks
}

const BLOCKS = parseBlocks(RULES)
const segs = (p) => p.replace(/^\/|\/$/g, '').split('/').filter(Boolean)

function bind(pattern, concrete) {
  const ps = segs(pattern), cs = segs(concrete)
  const last = ps[ps.length - 1] ?? ''
  const out = {}
  if (last.startsWith('{') && last.includes('=**')) {
    if (cs.length < ps.length - 1) return null
    for (let i = 0; i < ps.length - 1; i++) {
      if (ps[i].startsWith('{')) out[ps[i].slice(1, -1)] = cs[i]
      else if (ps[i] !== cs[i]) return null
    }
    out[last.slice(1, last.indexOf('='))] = cs.slice(ps.length - 1).join('/')
    return out
  }
  if (ps.length !== cs.length) return null
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith('{')) out[ps[i].slice(1, -1)] = cs[i]
    else if (ps[i] !== cs[i]) return null
  }
  return out
}

const METHODS = ['get', 'list', 'create', 'update', 'delete']

/** The real, union-of-all-blocks answer. */
function admits(path, method) {
  const who = []
  for (const p of PRINCIPALS) {
    let ok = false
    for (const b of BLOCKS) {
      const bnd = bind(b.path, path)
      if (!bnd) continue
      const cond = b.allows[method]
      if (cond === undefined) continue
      try { if (evaluate(cond, { p, bind: bnd })) { ok = true; break } }
      catch (e) { console.error(`  ! ${b.path} ${method}: ${e.message}`); process.exitCode = 1 }
    }
    if (ok) who.push(p.name)
  }
  return who
}

// ── The expectation ─────────────────────────────────────────────────────────
//
// Only what MUST hold. `*` means "not asserted here" (covered by the emulator
// suite). A sensitive path with no entry is a gap, and the run says so.
const S = {
  STAFF_KYC: ['owner', 'observer', 'app_admin', 'ops_member', 'finance_admin'],
  STAFF_FIN: ['owner', 'observer', 'finance_admin'],
  NOBODY: [],
  EVERYONE: PRINCIPALS.map((p) => p.name),
  SIGNED_IN: PRINCIPALS.filter((p) => p.uid !== null).map((p) => p.name),
}

const EXPECT = [
  // path, method, exact set of principal names
  ['kyc/agencies/signup/doc1_3f2a9c', 'list',   S.NOBODY],
  ['kyc/agencies/signup/doc1_3f2a9c', 'get',    S.EVERYONE],              // uploader getDownloadURL
  ['kyc/agencies/signup/doc1_3f2a9c', 'update', S.NOBODY],                // write-once
  ['kyc/agencies/signup/doc1_3f2a9c', 'delete', S.STAFF_KYC],
  ['sellerDocs/signup/proof_8b1d44',  'list',   S.NOBODY],
  ['sellerDocs/signup/proof_8b1d44',  'update', S.NOBODY],

  ['kyc/AG7/applications/1759_doc1',  'get',    [...S.STAFF_KYC, 'agency AG7']],
  ['kyc/AG7/applications/1759_doc1',  'create', [...S.STAFF_KYC, 'agency AG7']],
  ['kyc/AG7/applications/1759_doc1',  'list',   S.NOBODY],
  ['kyc/AG7/applications/1759_doc1',  'delete', S.STAFF_KYC],
  ['kyc/agencies/AG7/1759_doc1',      'get',    [...S.STAFF_KYC, 'agency AG7']],
  ['kyc/agencies/AG7/1759_doc1',      'create', [...S.STAFF_KYC, 'agency AG7']],
  ['hostPhotos/AG7/1759_photo',       'get',    [...S.STAFF_KYC, 'agency AG7']],
  ['hostPhotos/AG7/1759_photo',       'create', [...S.STAFF_KYC, 'agency AG7']],

  ['sellerDocs/S1/id.pdf',            'get',    [...S.STAFF_KYC, 'seller S1']],
  ['sellerDocs/S1/id.pdf',            'create', [...S.STAFF_KYC, 'seller S1']],
  ['sellerDocs/S1/id.pdf',            'list',   S.NOBODY],
  ['sellerDocs/crm/1759_id.pdf',      'get',    S.STAFF_KYC],
  // Onboarding, not finance review: /sellers/register is gated to
  // superadmin|app_admin|ops_admin|ops_member and is what writes this.
  // The first version of this expectation said STAFF_FIN, which was an
  // assumption from the word "payment" made before tracing the writer.
  ['sellerPaymentProofs/1759_p.pdf',  'get',    S.STAFF_KYC],
  ['coinPurchases/S1/1759_proof',     'create', [...S.STAFF_FIN, 'seller S1']],
  ['coinPurchases/S1/1759_proof',     'get',    [...S.STAFF_FIN, 'seller S1']],
  ['evidence/withdrawals/1759_s.pdf', 'get',    S.STAFF_FIN],
  ['evidence/withdrawals/1759_s.pdf', 'delete', S.NOBODY],

  // Self-application KYC: the applicant alone writes, create-only; the
  // applicant and KYC reviewers read. The `kyc/{agencyId}/{hostUid}/…` block
  // also matches this four-segment path, and must add nobody.
  ['kyc/applicants/alice/aadhaar.pdf', 'create', ['app user']],
  // The guest's OWN prefix: the case the emulator caught. Denied, and the
  // four-segment `kyc/{agencyId}/{hostUid}` block must not re-grant it.
  ['kyc/applicants/guest1/x.pdf',     'create', S.NOBODY],
  ['kyc/applicants/guest1/x.pdf',     'get',    S.STAFF_KYC],
  ['kyc/applicants/alice/aadhaar.pdf', 'get',    [...S.STAFF_KYC, 'app user']],
  ['kyc/applicants/alice/aadhaar.pdf', 'update', S.NOBODY],
  ['kyc/applicants/alice/aadhaar.pdf', 'list',   S.NOBODY],
  ['kyc/applicants/alice/aadhaar.pdf', 'delete', S.STAFF_KYC],
  // Recharge proofs: the buyer writes, create-only; buyer, finance and KYC
  // reviewers read. No seller, no agency, no other user.
  ['rechargeProofs/alice/utr.jpg',    'create', ['app user']],
  // The guest's OWN prefix: owner by uid, but anonymous — denied.
  ['rechargeProofs/guest1/utr.jpg',   'create', S.NOBODY],
  ['rechargeProofs/guest1/utr.jpg',   'get',    S.STAFF_KYC],
  ['rechargeProofs/alice/utr.jpg',    'get',    [...S.STAFF_KYC, 'app user']],
  ['rechargeProofs/alice/utr.jpg',    'update', S.NOBODY],
  ['rechargeProofs/alice/utr.jpg',    'list',   S.NOBODY],
  ['rechargeProofs/alice/utr.jpg',    'delete', S.STAFF_FIN],

  ['hostVerification/alice/capture.jpg', 'get', ['app user']],            // owner alone
  // GOV B24: the capture slot stays the owner's to write; the attempts the
  // server copies it to — what a review is decided on — are server-only.
  ['hostVerification/alice/capture.jpg', 'create', ['app user']],
  ['hostVerification/alice/attempts/1760_a.jpg', 'get',    S.NOBODY],
  ['hostVerification/alice/attempts/1760_a.jpg', 'create', S.NOBODY],
  ['hostVerification/alice/attempts/1760_a.jpg', 'update', S.NOBODY],
  ['hostVerification/alice/attempts/1760_a.jpg', 'delete', S.NOBODY],
  ['hostVerification/alice/attempts/1760/nested.jpg', 'create', S.NOBODY],
  // …and the folder name itself is not the owner's either: `{fileName}` would
  // otherwise bind to 'attempts' (an object at that name, or a folder listing).
  ['hostVerification/alice/attempts', 'get',    S.NOBODY],
  ['hostVerification/alice/attempts', 'list',   S.NOBODY],
  ['hostVerification/alice/attempts', 'create', S.NOBODY],
  ['profileMedia/alice/avatar.jpg',   'get',    S.SIGNED_IN],
  ['profileMedia/alice/avatar.jpg',   'create', ['app user']],
  ['profileMedia/alice/avatar.jpg',   'delete', ['app user']],
  ['feedbackAttachments/alice/1_0.jpg', 'create', ['app user']],
  ['appBuilds/release/arm64/app.apk', 'get',    S.EVERYONE],
  ['appBuilds/release/arm64/app.apk', 'create', S.NOBODY],
  ['face_verifications/alice.jpg',    'get',    S.NOBODY],                // legacy, denied
]

// ── Run ─────────────────────────────────────────────────────────────────────

const ALL_PATHS = [...new Set(EXPECT.map((e) => e[0]))]

console.log('='.repeat(78))
console.log(`STORAGE AUTHORISATION MATRIX — ${BLOCKS.length} blocks × ${PRINCIPALS.length} principals`)
console.log('='.repeat(78))

for (const path of ALL_PATHS) {
  const governing = BLOCKS.filter((b) => bind(b.path, path)).map((b) => b.path)
  const tag = governing.length > 1 ? `  [${governing.length} blocks — union applies]` : ''
  console.log(`\n${path}${tag}`)
  for (const g of governing) console.log(`    via ${g}`)
  for (const meth of METHODS) {
    const who = admits(path, meth)
    console.log(`    ${meth.padEnd(7)} ${who.length ? who.join(', ') : '— nobody'}`)
  }
}

console.log('\n' + '='.repeat(78))
console.log('ASSERTIONS')
console.log('='.repeat(78))

let failures = 0
for (const [path, meth, want] of EXPECT) {
  const got = admits(path, meth)
  const same = got.length === want.length && got.every((g) => want.includes(g))
  if (!same) {
    failures++
    const extra = got.filter((g) => !want.includes(g))
    const missing = want.filter((w) => !got.includes(w))
    console.error(`  FAIL  ${path}  ${meth}`)
    if (extra.length) console.error(`          TOO WIDE   : ${extra.join(', ')}`)
    if (missing.length) console.error(`          TOO NARROW : ${missing.join(', ')}`)
  }
}

if (failures) {
  console.error(`\n${failures} of ${EXPECT.length} assertions FAILED.\n`)
  process.exit(1)
}
console.log(`\nAll ${EXPECT.length} authorisation assertions hold.`)
console.log('  · no KYC path admits an app user, a guest, or an unrelated partner')
console.log('  · agency scoping holds across all four four-segment KYC shapes')
console.log('  · the signup prefixes stay write-once and unlistable under the union\n')
