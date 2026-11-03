/**
 * QA #41 — the user record offers Ban / Suspend / Adjust balance only to staff
 * whose permissions reach the route behind them.
 *
 * REAL: `lib/moderationAccess.ts`, imported and called, over the permission
 * lists `lib/auth.ts` really grants each role (read from its source, so a role
 * gaining or losing a permission is tested as it ships). The routes' own
 * decorators are read from `backend/app/routers/users.py` when the backend
 * sits beside this repo, so the map cannot drift from the server.
 *
 *   npm run test:moderation
 */

import * as fs from 'fs'
import * as path from 'path'
import { CONTROL_PERMISSION, mayOffer, offeredControls, type ModerationControl } from './moderationAccess'

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

// ── The permission lists each role really holds (lib/auth.ts) ─────────────────
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8')
const tableStart = authSrc.indexOf('export const DEFAULT_PERMISSIONS')
const table = authSrc.slice(tableStart, authSrc.indexOf('\n}\n', tableStart))
const GRANTS: Record<string, string[]> = {}
{
  const roleRe = /(\w+):\s*\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = roleRe.exec(table)) !== null) {
    const perms: string[] = []
    const permRe = /'([a-z_]+)'/g
    let p: RegExpExecArray | null
    while ((p = permRe.exec(m[2])) !== null) perms.push(p[1])
    GRANTS[m[1]] = perms
  }
}
ok('the role table was read from lib/auth.ts', Object.keys(GRANTS).length >= 10)

/** `hasPermission` as lib/auth.ts writes it: superadmin holds everything. */
function holder(role: string): (permission: string) => boolean {
  return (permission) => role === 'superadmin' || (GRANTS[role] ?? []).includes(permission)
}

const ALL: ModerationControl[] = ['ban', 'unban', 'suspend', 'resume', 'review_appeal', 'warn', 'balance']
const offered = (role: string) => offeredControls(ALL, holder(role))

// ── The QA case: Support saw Ban / Suspend / Adjust balance and was refused ──
eq('a Support member is offered Warn only', offered('support_member'), ['warn'])
eq('…so is a Support admin', offered('support_admin'), ['warn'])
eq('an App member moderates but cannot ask for money', offered('app_member'),
  ['ban', 'unban', 'suspend', 'resume', 'review_appeal', 'warn'])
eq('a Finance admin may warn and raise a balance request, never ban', offered('finance_admin'), ['warn', 'balance'])
eq('an App admin is offered all of it', offered('app_admin'), ALL)
eq('the Owner (superadmin) is offered all of it', offered('superadmin'), ALL)
for (const role of ['ops_member', 'tech_admin', 'tech_member', 'marketing_admin', 'marketing_member', 'finance_member']) {
  eq(`${role} is offered nothing on the user record`, offered(role), [])
}
eq('the Observer (no permissions) is offered nothing', offeredControls(ALL, () => false), [])

// ── The map is the routes' map ────────────────────────────────────────────────
eq('ban / unban / suspend / resume / appeals need can_ban_users',
  (['ban', 'unban', 'suspend', 'resume', 'review_appeal'] as ModerationControl[]).map((k) => CONTROL_PERMISSION[k]),
  ['can_ban_users', 'can_ban_users', 'can_ban_users', 'can_ban_users', 'can_ban_users'])
eq('warn needs can_view_users; balance needs can_adjust_balance',
  [CONTROL_PERMISSION.warn, CONTROL_PERMISSION.balance], ['can_view_users', 'can_adjust_balance'])
eq('a key this module does not govern passes through (role rows carry their own gates)',
  mayOffer('role', () => false), true)
ok('the map cannot be changed at run time', Object.isFrozen(CONTROL_PERMISSION))

// ── The screens use it ────────────────────────────────────────────────────────
{
  const actions = fs.readFileSync(path.join(__dirname, '..', 'app', 'users', '[uid]', 'UserActions.tsx'), 'utf8')
  ok('the user record filters the account actions by permission', actions.includes('.filter((a) => mayOffer(a.kind, can))'))
  ok('…and Warn / Adjust balance too', actions.includes('&& mayOffer(spec.key, can)'))
  ok('…and explains balance requests only to somebody offered one', actions.includes('{canAdjustBalance && ('))
  const list = fs.readFileSync(path.join(__dirname, '..', 'app', 'users', 'page.tsx'), 'utf8')
  ok('the /users list filters its row actions the same way', list.includes('.filter((a) => mayOffer(a.kind, (p) => hasPermission(crmUser, p as Permission)))'))
}

const router = path.join(__dirname, '..', '..', 'backend', 'app', 'routers', 'users.py')
if (fs.existsSync(router)) {
  const src = fs.readFileSync(router, 'utf8')
  ok('server: _BAN_USERS is can_ban_users', src.includes('_BAN_USERS = Depends(require_permission(Permission.CAN_BAN_USERS))'))
  for (const verb of ['ban', 'unban', 'suspend', 'resume']) {
    ok(`server: POST /{uid}/${verb} is behind _BAN_USERS`, src.includes(`@router.post("/{uid}/${verb}", dependencies=[_BAN_USERS])`))
  }
  const warn = src.slice(src.indexOf('"/{uid}/warn"') - 40, src.indexOf('async def warn_user('))
  ok('server: POST /{uid}/warn needs can_view_users', warn.includes('Permission.CAN_VIEW_USERS'))
  const bal = src.slice(src.indexOf('"/{uid}/balance-request"'), src.indexOf('async def request_balance_change('))
  ok('server: POST /{uid}/balance-request needs can_adjust_balance', bal.includes('Permission.CAN_ADJUST_BALANCE'))
  const rec = src.slice(src.indexOf('async def recommend_appeal(') - 220, src.indexOf('async def recommend_appeal('))
  ok('server: recommending an appeal needs can_ban_users', rec.includes('Permission.CAN_BAN_USERS'))
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} moderation access checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} moderation access checks passed.`)
console.log('  · QA #41: Ban, Suspend and Adjust balance are offered only to staff whose permissions reach them; the API still checks')
