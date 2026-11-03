/**
 * QA #45 / #40 — /team-access offers each viewer exactly what the API allows.
 *
 * REAL: `lib/teamAccess.ts`, imported and called. The page wiring and the
 * server's own rule (`owner_mfa.reset_by_observer`: Observer only, reason of at
 * least 10 characters, every session revoked, audited) are checked on their
 * source when the backend sits beside this repo.
 *
 *   npm run test:teamaccess
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  OWNER_MFA_RESET_EFFECTS, OWNER_MFA_RESET_MIN_REASON, canOfferInvite, canOfferRevoke, canResetOwnerMfa,
  ownerMfaResetReady, teamAccessHeadline,
} from './teamAccess'

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

const OWNER = { uid: 'o1', role: 'owner', is_active: true, email: 'owner2@zipper.test', name: 'Test Owner Two' }
const OWNER_OFF = { ...OWNER, uid: 'o9', is_active: false }
const SUPPORT = { uid: 's1', role: 'support_member', is_active: true, email: 's@x.test' }
const OBSERVER = { uid: 'observer:1', role: 'observer', is_active: true, email: 'obs@x.test' }

// ── QA #45: the reset, Observer only ──────────────────────────────────────────
eq('the Observer is offered the reset on an active Owner', canResetOwnerMfa('observer', OWNER), true)
eq('…not on an Owner with no access', canResetOwnerMfa('observer', OWNER_OFF), false)
eq('…not on staff or on the Observer row', [canResetOwnerMfa('observer', SUPPORT), canResetOwnerMfa('observer', OBSERVER)], [false, false])
eq('nobody else is offered it — not an Owner, not an admin',
  ['owner', 'ops_admin', 'support_member', 'app_admin', ''].map((r) => canResetOwnerMfa(r, OWNER)), [false, false, false, false, false])

eq('the confirmation needs the reason AND the Owner\'s email typed back',
  [ownerMfaResetReady(OWNER, 'Phone stolen, codes lost.', 'owner2@zipper.test'),
    ownerMfaResetReady(OWNER, 'Phone stolen, codes lost.', ''),
    ownerMfaResetReady(OWNER, 'short', 'owner2@zipper.test'),
    ownerMfaResetReady(OWNER, 'Phone stolen, codes lost.', 'owner3@zipper.test')],
  [true, false, false, false])
eq('…the email is compared without case or spaces', ownerMfaResetReady(OWNER, 'Phone stolen, codes lost.', '  OWNER2@zipper.TEST '), true)
eq('the reason minimum is the server\'s', OWNER_MFA_RESET_MIN_REASON, 10)
ok('the effects say the old factor and codes stop working, sessions end, a new set-up follows, and no secret is shown',
  OWNER_MFA_RESET_EFFECTS.some((l) => l.includes('recovery code')) &&
  OWNER_MFA_RESET_EFFECTS.some((l) => l.includes('session')) &&
  OWNER_MFA_RESET_EFFECTS.some((l) => l.includes('new authenticator')) &&
  OWNER_MFA_RESET_EFFECTS.some((l) => l.includes('never see')))

// ── QA #40: the Observer stays read-only; the headline tells the truth ────────
eq('the Observer is never offered revoke', [canOfferRevoke('observer', SUPPORT, []), canOfferRevoke('observer', SUPPORT, ['support_member'])], [false, false])
eq('an Owner may revoke staff, never another Owner or the Observer',
  [canOfferRevoke('owner', SUPPORT, []), canOfferRevoke('owner', OWNER, []), canOfferRevoke('owner', OBSERVER, [])], [true, false, false])
eq('an admin only for roles they manage', [canOfferRevoke('support_admin', SUPPORT, ['support_member']), canOfferRevoke('support_admin', SUPPORT, ['ops_member'])], [true, false])
eq('a member with nothing to manage sees no revoke', canOfferRevoke('support_member', SUPPORT, []), false)
eq('an inactive row offers nothing', canOfferRevoke('owner', { ...SUPPORT, is_active: false }, []), false)

ok('the Observer is told it is read-only and what it CAN do', teamAccessHeadline('observer', 0).startsWith('Read-only') && teamAccessHeadline('observer', 0).includes('reset an Owner'))
eq('a Support member with no Invite button is not told they can invite',
  teamAccessHeadline('support_member', 0), 'You can see who has staff access. Inviting and removing people is for Owners and team admins.')
eq('an admin who can invite is told so', teamAccessHeadline('support_admin', 1), 'You can invite members of your own team.')
eq('an Owner', teamAccessHeadline('owner', 5), 'You can invite anyone, including another owner.')

// QA #40, found again in the E2E re-run: the API lists Owner as assignable for the Observer
// (its separate provisioning route), but this page invites through POST /staff, which refuses it.
eq('the Observer is not offered Invite, whatever the API lists', [canOfferInvite('observer', 1), canOfferInvite('observer', 0)], [false, false])
eq('an Owner and an admin with roles to hand out are', [canOfferInvite('owner', 5), canOfferInvite('support_admin', 1)], [true, true])
eq('a member with nothing to hand out is not', canOfferInvite('support_member', 0), false)

// ── the wiring ────────────────────────────────────────────────────────────────
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'team-access', 'page.tsx'), 'utf8')
  ok('the page offers the reset only through canResetOwnerMfa', page.includes('{canResetOwnerMfa(myRole, m) && ('))
  ok('…calls the Observer-only API', page.includes('await api.auth.mfaResetOwner(m.uid, reason.trim())'))
  ok('…behind a confirmation panel', page.includes('<ResetOwnerMfaPanel') && page.includes('disabled={busy || !ready}'))
  ok('revoke is offered only through canOfferRevoke', page.includes('{canOfferRevoke(myRole, m, assignable) && ('))
  ok('the headline comes from teamAccessHeadline', page.includes('{teamAccessHeadline(myRole, assignable.length)}'))
  ok('Invite is offered only through canOfferInvite', page.includes('{canOfferInvite(myRole, assignable.length) && (')
    && !page.includes('{assignable.length > 0 && ('))

  const layout = fs.readFileSync(path.join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')
  const routes = layout.slice(layout.indexOf('const OBSERVER_ROUTES'), layout.indexOf(']', layout.indexOf('const OBSERVER_ROUTES')))
  ok('the Observer can open /team-access (so the control is reachable)', routes.includes("'/team-access'"))

  const backend = path.join(__dirname, '..', '..', 'backend', 'app', 'services', 'owner_mfa.py')
  if (fs.existsSync(backend)) {
    const src = fs.readFileSync(backend, 'utf8')
    const fn = src.slice(src.indexOf('async def reset_by_observer('), src.indexOf('async def _notify('))
    ok('server: Observer only', fn.includes('if str(observer.get("role")) != str(Role.OBSERVER):'))
    ok('server: the reason minimum is 10', fn.includes('if len(reason) < 10:'))
    ok('server: the factor and its recovery codes are deleted', fn.includes('await db[C.OWNER_MFA].delete_one({"uid": owner_uid})'))
    ok('server: every session revoked, mobile included', fn.includes('mobile=True'))
    ok('server: audited', fn.includes('action=audit.Action.OWNER_MFA_RESET'))
  }
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checks} team access checks FAILED\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} team access checks passed.`)
console.log('  · QA #45: the Observer resets an Owner\'s authenticator from /team-access, with a reason and a typed confirmation')
console.log('  · QA #40: the Observer stays read-only; nobody is offered a control the API refuses')
