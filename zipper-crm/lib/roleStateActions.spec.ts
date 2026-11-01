/**
 * Spec §10 — state-aware actions on user, partner and role rows.
 *
 * REAL: `lib/roleStateActions.ts` (with `lib/crmRoles.ts` and
 * `lib/backendFeatures.ts`), imported and called. The wiring in
 * `app/users/[uid]/UserActions.tsx`, `app/users/page.tsx` and
 * `app/hosts/page.tsx` is checked on their source.
 *
 *   npm run test:rolestate
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  HOST_ROLE_PERMISSION_HINT, ONLY_ROLE_HINT, UNBAN_HINT, accountActions, roleRowActions, roleRows, roleStateOf,
  type RoleRow,
} from './roleStateActions'
import { BACKEND_FEATURES, NEXT_RELEASE_NOTE } from './backendFeatures'

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

const kinds = (rows: ReturnType<typeof roleRowActions>) => rows.map((a) => a.kind)
const staff = { isOwner: false }
const owner = { isOwner: true }

// ── role state ────────────────────────────────────────────────────────────────
eq('host active → approved', roleStateOf({ role: 'host', status: 'active' }), 'approved')
eq('host pending', roleStateOf({ role: 'host', status: 'pending' }), 'pending')
eq('host revoked', roleStateOf({ role: 'host', status: 'revoked' }), 'revoked')
eq('host suspended (the role on its own)', roleStateOf({ role: 'host', status: 'suspended' }), 'suspended')
eq('host anything else → unknown', roleStateOf({ role: 'host', status: 'weird' }), 'unknown')
eq('partner approved + is_active false → suspended (legacy records)',
  roleStateOf({ role: 'agency', id: 'a1', status: 'approved', is_active: false }), 'suspended')
eq('partner approved', roleStateOf({ role: 'seller', id: 's1', status: 'approved', is_active: true }), 'approved')
for (const s of ['pending', 'awaiting_verification', 'suspended', 'revoked', 'rejected']) {
  eq(`partner ${s} passes through`, roleStateOf({ role: 'agency', id: 'a1', status: s }), s)
}

// ── pending → Review / Approve / Reject ──────────────────────────────────────
{
  const a = roleRowActions({ role: 'agency', id: 'a1', status: 'pending' }, staff)
  eq('pending agency → review, approve, reject', kinds(a), ['review', 'approve', 'reject'])
  eq('…review links to the agency record', a[0].href, '/agencies/a1')
  eq('…approve and reject are API calls', [a[1].via, a[2].via], ['api', 'api'])
  const h = roleRowActions({ role: 'host', status: 'pending', application_id: 'app-9' }, staff)
  eq('pending host → review (/kyc), approve, reject', kinds(h), ['review', 'approve', 'reject'])
  eq('…host review goes to /kyc', h[0].href, '/kyc')
  eq('…and the approve carries the application id', h[1].applicationId, 'app-9')
  const s = roleRowActions({ role: 'seller', id: 's1', status: 'pending' }, staff)
  eq('pending seller review links to the seller record', s[0].href, '/sellers/s1')
}

// ── awaiting_verification → Review / Check and start (never a bypass) ───────
{
  const a = roleRowActions({ role: 'seller', id: 's1', status: 'awaiting_verification' }, staff)
  eq('awaiting verification → review, check_and_start', kinds(a), ['review', 'check_and_start'])
  ok('…and says it never bypasses the contacts', /never bypasses/i.test(a[1].hint))
  ok('…no approve, no activate', !kinds(a).includes('approve'))
}

// ── approved → Suspend role / Revoke role ────────────────────────────────────
{
  const two = roleRowActions({ role: 'agency', id: 'a1', status: 'approved', is_active: true, actions: ['revoke'] }, staff)
  eq('approved agency (2+ roles) → suspend_role, revoke_role', kinds(two), ['suspend_role', 'revoke_role'])
  eq('…both enabled, both API', two.map((x) => [x.via, x.disabled]), [['api', false], ['api', false]])
  const one = roleRowActions({ role: 'agency', id: 'a1', status: 'approved', is_active: true, actions: [] }, staff)
  eq('approved agency (only role) → revoke is shown but disabled', one.map((x) => [x.kind, x.disabled]),
    [['suspend_role', false], ['revoke_role', true]])
  eq('…with the one-role hint', one[1].hint, ONLY_ROLE_HINT)
}

// ── Host role suspension: POST /users/{uid}/suspend-host | resume-host ──────
{
  eq('the flag is on — the routes have shipped', BACKEND_FEATURES.hostRoleSuspension, true)
  const h = roleRowActions({ role: 'host', status: 'active', actions: ['revoke'] }, staff)
  eq('active host → suspend_role, revoke_role', kinds(h), ['suspend_role', 'revoke_role'])
  eq('…the suspend is a live API call', [h[0].via, h[0].disabled], ['api', false])
  ok('…and says the agency is told too', /agency are told/.test(h[0].hint))
  eq('…revoke host is live as before', [h[1].via, h[1].disabled], ['api', false])

  const suspended = roleRowActions({ role: 'host', status: 'suspended', actions: ['revoke'] }, staff)
  eq('a suspended Host role reads as suspended', roleStateOf({ role: 'host', status: 'suspended' }), 'suspended')
  eq('suspended host → resume_role, revoke_role', kinds(suspended), ['resume_role', 'revoke_role'])
  eq('…the resume is a live API call', [suspended[0].via, suspended[0].disabled], ['api', false])

  const noKyc = roleRowActions({ role: 'host', status: 'active', actions: ['revoke'] }, { ...staff, canManageHostRole: false })
  eq('without can_approve_kyc → shown, disabled, with the reason', [noKyc[0].disabled, noKyc[0].hint],
    [true, HOST_ROLE_PERMISSION_HINT])
  const noKycResume = roleRowActions({ role: 'host', status: 'suspended', actions: [] }, { ...staff, canManageHostRole: false })
  eq('…the same for Resume', [noKycResume[0].kind, noKycResume[0].disabled], ['resume_role', true])
  eq('unknown permission → offered; the server answers', roleRowActions({ role: 'host', status: 'active' },
    { ...staff, canManageHostRole: undefined })[0].disabled, false)

  // A rolled-back backend: one line puts the stub back.
  const off = roleRowActions({ role: 'host', status: 'active', actions: ['revoke'] },
    { isOwner: false, features: { hostRoleSuspension: false, departmentVacancy: true } })
  eq('flag off → the disabled stub that says when', [off[0].via, off[0].disabled, off[0].hint], ['stub', true, NEXT_RELEASE_NOTE])
}

// ── suspended → Resume role / Revoke role ────────────────────────────────────
{
  const a = roleRowActions({ role: 'seller', id: 's1', status: 'suspended', actions: ['restore'] }, staff)
  eq('suspended seller → resume_role, revoke_role', kinds(a), ['resume_role', 'revoke_role'])
  eq('…resume is an ordinary API call (not Owner-only)', [a[0].via, a[0].ownerOnly, a[0].disabled], ['api', false, false])
  eq('…revoke is disabled when the server did not allow it', a[1].disabled, true)
}

// ── revoked → Request / Review reinstatement; never an ordinary Activate ────
{
  const unknown = roleRowActions({ role: 'agency', id: 'a1', status: 'revoked', actions: ['restore'] }, staff)
  eq('revoked, requests unknown → review link + request + reinstate (disabled)',
    unknown.map((x) => [x.kind, x.via, x.disabled]),
    [['review_reinstatement', 'link', false], ['request_reinstatement', 'api', false], ['reinstate', 'api', true]])
  ok('…the Owner-only control is marked so', unknown[2].ownerOnly)
  ok('…no ordinary activate/restore/resume on a revoked role',
    !kinds(unknown).some((k) => k === 'resume_role' || k === 'approve' || k === 'check_and_start'))

  const open = roleRowActions({ role: 'agency', id: 'a1', status: 'revoked', actions: ['restore'] },
    { isOwner: false, openReinstatement: { agency: 'ra-1' } })
  eq('revoked with an OPEN request → review only (no second request)', kinds(open), ['review_reinstatement', 'reinstate'])
  eq('…linking to the reinstatement queue', open[0].href, '/role-appeals')

  const none = roleRowActions({ role: 'agency', id: 'a1', status: 'revoked', actions: ['restore'] },
    { isOwner: false, openReinstatement: {} })
  eq('revoked with NO open request → request only', kinds(none), ['request_reinstatement', 'reinstate'])

  const asOwner = roleRowActions({ role: 'agency', id: 'a1', status: 'revoked', actions: ['restore'] },
    { ...owner, openReinstatement: {} })
  eq('the Owner may reinstate (their decision)', asOwner.map((x) => [x.kind, x.disabled]),
    [['request_reinstatement', false], ['reinstate', false]])
  ok('…and the label says whose decision it is', /Owner decision/.test(asOwner[1].label))

  const host = roleRowActions({ role: 'host', status: 'revoked', actions: ['restore'], restorable: false },
    { ...owner, openReinstatement: {} })
  eq('a revoked host that is not restorable is not offered reinstate', kinds(host), ['request_reinstatement'])
  const noRestore = roleRowActions({ role: 'agency', id: 'a1', status: 'revoked', actions: [] }, { ...owner, openReinstatement: {} })
  eq('no server `restore` → no reinstate, even for the Owner', kinds(noRestore), ['request_reinstatement'])
}

// ── rejected → View ──────────────────────────────────────────────────────────
{
  const a = roleRowActions({ role: 'seller', id: 's1', status: 'rejected' }, owner)
  eq('rejected → view only', a.map((x) => [x.kind, x.via, x.href]), [['view', 'link', '/sellers/s1']])
}

// ── every role shows its own status: revoked Agency does not hide active Seller
{
  const rows = roleRows({ roles: [
    { role: 'agency', id: 'a1', status: 'revoked', actions: ['restore'] },
    { role: 'seller', id: 's1', status: 'approved', is_active: true, actions: ['revoke'] },
    { role: 'host', status: 'active', actions: ['revoke'] },
  ] }, { isOwner: false, openReinstatement: {} })
  eq('three rows, three states', rows.map((r) => [r.label, r.state]),
    [['Agency', 'revoked'], ['Coin Seller', 'approved'], ['Host', 'approved']])
  eq('the active seller keeps its own actions beside the revoked agency',
    rows[1].actions.map((a) => a.kind), ['suspend_role', 'revoke_role'])
  eq('a bare array works too', roleRows([{ role: 'host', status: 'pending' }], staff).length, 1)
  eq('nothing → no rows', [roleRows(null, staff), roleRows(undefined, staff), roleRows({}, staff)], [[], [], []])
}

// ── a partner row with no id cannot be acted on ─────────────────────────────
{
  const a = roleRowActions({ role: 'agency', status: 'approved', is_active: true, actions: ['revoke'] } as RoleRow, staff)
  eq('no record id → no suspend/revoke (nothing to address)', kinds(a), [])
}

// ── accounts ─────────────────────────────────────────────────────────────────
{
  const active = accountActions({ uid: 'u1' }, { isOwner: false })
  eq('active → ban, suspend', active.map((a) => a.kind), ['ban', 'suspend'])

  const suspended = accountActions({ uid: 'u1', accountState: 'suspended', isBanned: true }, { isOwner: false })
  eq('suspended → resume, ban', suspended.map((a) => a.kind), ['resume', 'ban'])
  const suspendedAppeal = accountActions({ uid: 'u1', accountState: 'suspended', isBanned: true },
    { isOwner: false, openAppealId: 'ap-1' })
  eq('suspended with an open appeal → + review appeal', suspendedAppeal.map((a) => a.kind), ['resume', 'ban', 'review_appeal'])
  eq('…linking to the appeals queue for this account', suspendedAppeal[2].href, '/operations/appeals?uid=u1')

  const bannedStaff = accountActions({ uid: 'u1', accountState: 'banned', isBanned: true }, { isOwner: false })
  eq('banned, staff, no appeal → unban is shown but disabled', bannedStaff.map((a) => [a.kind, a.disabled, a.ownerOnly]),
    [['unban', true, true]])
  eq('…with the rule as the hint', bannedStaff[0].hint, UNBAN_HINT)
  const bannedOwner = accountActions({ uid: 'u1', accountState: 'banned', isBanned: true }, { isOwner: true })
  eq('banned, Owner → unban enabled, as a decision', bannedOwner.map((a) => [a.kind, a.disabled]), [['unban', false]])
  ok('…and the reason must cite the authority', /cite/i.test(bannedOwner[0].hint))
  const bannedAppeal = accountActions({ uid: 'u1', accountState: 'banned', isBanned: true },
    { isOwner: false, openAppealId: 'ap-2' })
  eq('banned with an open appeal → review the appeal; no direct unban at all',
    bannedAppeal.map((a) => [a.kind, a.via]), [['review_appeal', 'link']])

  eq('an internal identity gets nothing', accountActions({ uid: 'o1', crmRole: 'superadmin', accountState: 'banned', isBanned: true }, { isOwner: true }), [])
  eq('the actor\'s own row gets nothing', accountActions({ uid: 'me', accountState: 'banned', isBanned: true }, { isOwner: true, actorUid: 'me' }), [])
}

// ── the wiring ───────────────────────────────────────────────────────────────
{
  const detail = fs.readFileSync(path.join(__dirname, '..', 'app', 'users', '[uid]', 'UserActions.tsx'), 'utf8')
  ok('the user page renders role rows from the state machine', detail.includes('roleRows(') && detail.includes("from '@/lib/roleStateActions'"))
  ok('…and the account actions from it', detail.includes('accountActions('))
  ok('…reading the person\'s reinstatement requests', detail.includes('roleAppeals.of('))
  ok('…no grant-host or seller-flag call survives', !detail.includes('grantHost') && !detail.includes('setSellerFlag'))
  ok('…Suspend / Resume Host role call the API', detail.includes('api.users.suspendHost(uid, why, ') && detail.includes('api.users.resumeHost(uid, why)'))
  ok('…the "next backend release" refusal is gone', !detail.includes('available after the next backend release'))
  ok('…and the KYC permission is passed to the state machine', detail.includes('canManageHostRole:'))
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts: suspend-host and resume-host', apiSrc.includes('/suspend-host`') && apiSrc.includes('/resume-host`'))

  const list = fs.readFileSync(path.join(__dirname, '..', 'app', 'users', 'page.tsx'), 'utf8')
  ok('the /users list gates Unban through the same policy', list.includes('accountActions('))

  const hosts = fs.readFileSync(path.join(__dirname, '..', 'app', 'hosts', 'page.tsx'), 'utf8')
  ok('the hosts list has no one-click Unban', !hosts.includes('api.users.unban('))

  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.ts'), 'utf8')
  ok('lib/api.ts no longer offers grantHost', !/grantHost:\s*\(/.test(api))
  ok('lib/api.ts no longer offers setSellerFlag', !/setSellerFlag:\s*\(/.test(api))
  const partners = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apiPartners.ts'), 'utf8')
  ok('lib/apiPartners.ts no longer offers grantCapability', !/grantCapability:\s*\(/.test(partners))
  const seller = fs.readFileSync(path.join(__dirname, '..', 'app', 'sellers', '[id]', 'Client.tsx'), 'utf8')
  ok('the seller page has no "Also an agency" control', !/setDecision\('grant_agency'\)/.test(seller) && !/grantCapability\(/.test(seller))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} role-state checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`All ${checks} role-state checks passed.`)
console.log('  · pending → Review/Approve/Reject; approved → Suspend/Revoke; suspended → Resume; revoked → Request/Review reinstatement')
console.log('  · a revoked role is never re-activated as an ordinary action; a ban is lifted only via an appeal or the Owner')
console.log('  · the Host role is suspended / resumed on its own (suspend-host / resume-host); each role row keeps its own status')
