/**
 * The redirect table, case by case.
 *
 * `resolvePartnerRedirect` decides where a partner login may sit. It runs on
 * every render of the CRM shell, and it decides whether page content mounts at
 * all — so a wrong answer is either a signed-in partner staring at /login or a
 * pair of pages bouncing off each other forever.
 *
 * Three claims are checked:
 *
 *   1. **A legacy document routes identically.** The old predicate is
 *      reproduced verbatim below as `legacyRedirect`, and every single-role
 *      case is asserted against it rather than against a number written here.
 *      If the new resolver ever disagrees with the old one on an account that
 *      exists today, this fails.
 *   2. **Every combination terminates.** For every capability set, every status
 *      pairing and every path in the CRM, the resolver is re-run on its own
 *      answer. A path that does not settle in one hop is a redirect loop.
 *   3. **Nobody who is not a partner is affected.** Staff, superadmin and a
 *      login with a malformed role all get null.
 *
 * Run:  npx tsc lib/partnerRouting.ts lib/partnerRouting.spec.ts \
 *         --outDir .routing-test --module commonjs --target ES2020 --strict
 *       node .routing-test/partnerRouting.spec.js
 */

import {
  PARTNER_HOME,
  PARTNER_PENDING,
  allowedPartnerPaths,
  approvedPartnerRoles,
  isDualRolePartner,
  partnerLanding,
  partnerRoleStatus,
  partnerRolesOf,
  resolvePartnerRedirect,
  type PartnerRole,
  type PartnerRoleHolder,
} from './partnerRouting'

const failures: string[] = []
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`,
    )
  }
}

function ok(label: string, condition: boolean): void {
  checks += 1
  if (!condition) failures.push(label)
}

// ── The old rule, copied out of app/layout.tsx before it was replaced ─────────
//
// Not a paraphrase. This is the code that shipped, so "byte-identical for a
// single-role partner" is a thing the test can actually decide.

function legacyRedirect(
  crmUser: { role: string; status?: string },
  pathname: string,
): string | null {
  if (crmUser.role === 'agency') {
    const isPending = !crmUser.status || crmUser.status === 'pending'
    if (isPending && !pathname.startsWith('/agency-pending')) return '/agency-pending'
    if (
      !isPending &&
      !pathname.startsWith('/agency-dashboard') &&
      !pathname.startsWith('/agency-pending')
    ) {
      return '/agency-dashboard'
    }
  }

  if (crmUser.role === 'seller') {
    const isPending = !crmUser.status || crmUser.status === 'pending'
    if (isPending && !pathname.startsWith('/seller-pending')) return '/seller-pending'
    if (
      !isPending &&
      !pathname.startsWith('/seller-dashboard') &&
      !pathname.startsWith('/seller-pending')
    ) {
      return '/seller-dashboard'
    }
  }

  return null
}

// Every route the shell can be sitting on when the resolver runs, plus a couple
// of deep paths to prove the match is by prefix.
const PATHS = [
  '/',
  '/inbox',
  '/board',
  '/partners',
  '/finance/cash',
  '/agency-dashboard',
  '/agency-dashboard/hosts',
  '/seller-dashboard',
  '/seller-dashboard/recharges',
  '/agency-pending',
  '/seller-pending',
  '/login',
  '/team-access',
]

// ══════════════════════════════════════════════════════════════════════════════
// 1. Legacy documents — one capability, one `role`, one `status`
// ══════════════════════════════════════════════════════════════════════════════

const LEGACY: Array<{ role: string; status?: string }> = [
  { role: 'agency' },                        // signed up, no status written yet
  { role: 'agency', status: 'pending' },
  { role: 'agency', status: 'approved' },
  { role: 'seller' },
  { role: 'seller', status: 'pending' },
  { role: 'seller', status: 'approved' },
]

for (const user of LEGACY) {
  for (const path of PATHS) {
    check(
      `legacy ${user.role}/${user.status ?? 'no status'} on ${path}`,
      resolvePartnerRedirect(user as PartnerRoleHolder, path),
      legacyRedirect(user, path),
    )
  }
}

// The same six documents written in the NEW shape must route the same way. This
// is what "handle both shapes on read" has to mean.
for (const user of LEGACY) {
  const modern: PartnerRoleHolder = {
    role: user.role,
    roles: [user.role],
    roleStatus: {
      [user.role as PartnerRole]:
        !user.status || user.status === 'pending' ? 'pending' : 'approved',
    },
  }
  for (const path of PATHS) {
    check(
      `new shape ${user.role}/${user.status ?? 'no status'} on ${path}`,
      resolvePartnerRedirect(modern, path),
      legacyRedirect(user, path),
    )
  }
}

// ── Named cases, spelled out ─────────────────────────────────────────────────

const agencyPending: PartnerRoleHolder = { role: 'agency', status: 'pending' }
const agencyApproved: PartnerRoleHolder = { role: 'agency', status: 'approved' }
const sellerApproved: PartnerRoleHolder = { role: 'seller', status: 'approved' }

check('one role, pending, on the dashboard → its waiting room',
  resolvePartnerRedirect(agencyPending, '/agency-dashboard'), '/agency-pending')
check('one role, pending, already waiting → stays',
  resolvePartnerRedirect(agencyPending, '/agency-pending'), null)
check('one role, pending, on the other waiting room → its own',
  resolvePartnerRedirect(agencyPending, '/seller-pending'), '/agency-pending')
check('one role, approved, anywhere else → its dashboard',
  resolvePartnerRedirect(agencyApproved, '/'), '/agency-dashboard')
check('one role, approved, on its dashboard → stays',
  resolvePartnerRedirect(agencyApproved, '/agency-dashboard'), null)
check('one role, approved, on its waiting room → stays (unchanged)',
  resolvePartnerRedirect(agencyApproved, '/agency-pending'), null)
check('one role, approved, on the OTHER dashboard → its own',
  resolvePartnerRedirect(agencyApproved, '/seller-dashboard'), '/agency-dashboard')
check('a seller behaves the same way, mirrored',
  resolvePartnerRedirect(sellerApproved, '/agency-dashboard'), '/seller-dashboard')

check('one role never sees a switcher', isDualRolePartner(agencyApproved), false)
check('and holds exactly one capability', partnerRolesOf(agencyApproved), ['agency'])

// ══════════════════════════════════════════════════════════════════════════════
// 2. Two capabilities
// ══════════════════════════════════════════════════════════════════════════════

const bothApproved: PartnerRoleHolder = {
  role: 'agency',
  status: 'approved',
  roles: ['agency', 'seller'],
  roleStatus: { agency: 'approved', seller: 'approved' },
}

check('both approved → holds two capabilities',
  partnerRolesOf(bothApproved), ['agency', 'seller'])
check('both approved → a switcher',
  isDualRolePartner(bothApproved), true)
check('both approved → lands on the primary capability',
  resolvePartnerRedirect(bothApproved, '/'), '/agency-dashboard')
check('both approved → may sit on the agency dashboard',
  resolvePartnerRedirect(bothApproved, '/agency-dashboard'), null)
check('both approved → may sit on the seller dashboard',
  resolvePartnerRedirect(bothApproved, '/seller-dashboard'), null)
check('both approved → may sit on either waiting room',
  [
    resolvePartnerRedirect(bothApproved, '/agency-pending'),
    resolvePartnerRedirect(bothApproved, '/seller-pending'),
  ],
  [null, null])
check('both approved → still cannot wander into staff screens',
  resolvePartnerRedirect(bothApproved, '/finance/cash'), '/agency-dashboard')
check('both approved → four allowed paths and no more',
  allowedPartnerPaths(bothApproved).sort(),
  ['/agency-dashboard', '/agency-pending', '/seller-dashboard', '/seller-pending'])

// A seller who became an agency: the primary capability is 'seller', so that is
// where they land — the switcher moves them, nothing else.
const sellerFirstBoth: PartnerRoleHolder = {
  role: 'seller',
  status: 'approved',
  roles: ['seller', 'agency'],
  roleStatus: { seller: 'approved', agency: 'approved' },
}
check('a seller who became an agency lands on the seller dashboard',
  resolvePartnerRedirect(sellerFirstBoth, '/'), '/seller-dashboard')
check('and its capabilities read primary first',
  partnerRolesOf(sellerFirstBoth), ['seller', 'agency'])

// ── One approved, one pending ────────────────────────────────────────────────

const agencyApprovedSellerPending: PartnerRoleHolder = {
  role: 'agency',
  status: 'approved',
  roles: ['agency', 'seller'],
  roleStatus: { agency: 'approved', seller: 'pending' },
}
check('approved + pending → lands on the approved dashboard',
  resolvePartnerRedirect(agencyApprovedSellerPending, '/'), '/agency-dashboard')
check('approved + pending → the pending capability has no dashboard',
  resolvePartnerRedirect(agencyApprovedSellerPending, '/seller-dashboard'),
  '/agency-dashboard')
check('approved + pending → but its waiting room is reachable',
  resolvePartnerRedirect(agencyApprovedSellerPending, '/seller-pending'), null)
check('approved + pending → only the approved capability is approved',
  approvedPartnerRoles(agencyApprovedSellerPending), ['agency'])

// The reverse: the capability they signed up with is still under review, and the
// second one has been approved. They land on the one that works.
const agencyPendingSellerApproved: PartnerRoleHolder = {
  role: 'agency',
  status: 'pending',
  roles: ['agency', 'seller'],
  roleStatus: { agency: 'pending', seller: 'approved' },
}
check('pending + approved → lands on the capability that works',
  resolvePartnerRedirect(agencyPendingSellerApproved, '/'), '/seller-dashboard')
check('pending + approved → the pending one still has no dashboard',
  resolvePartnerRedirect(agencyPendingSellerApproved, '/agency-dashboard'),
  '/seller-dashboard')
check('pending + approved → its waiting room is still reachable',
  resolvePartnerRedirect(agencyPendingSellerApproved, '/agency-pending'), null)

// ── Both pending ─────────────────────────────────────────────────────────────

const bothPending: PartnerRoleHolder = {
  role: 'agency',
  status: 'pending',
  roles: ['agency', 'seller'],
  roleStatus: { agency: 'pending', seller: 'pending' },
}
check('both pending → the primary capability’s waiting room',
  resolvePartnerRedirect(bothPending, '/'), '/agency-pending')
check('both pending → no dashboard at all',
  resolvePartnerRedirect(bothPending, '/agency-dashboard'), '/agency-pending')
check('both pending → and not the other one either',
  resolvePartnerRedirect(bothPending, '/seller-dashboard'), '/agency-pending')
check('both pending → either waiting room is fine',
  [
    resolvePartnerRedirect(bothPending, '/agency-pending'),
    resolvePartnerRedirect(bothPending, '/seller-pending'),
  ],
  [null, null])
check('both pending → nothing is approved',
  approvedPartnerRoles(bothPending), [])

// ── A refused second capability ──────────────────────────────────────────────

const sellerRefused: PartnerRoleHolder = {
  role: 'agency',
  status: 'approved',
  roles: ['agency'],
  roleStatus: { agency: 'approved', seller: 'rejected' },
}
check('a refused capability is not held',
  partnerRolesOf(sellerRefused), ['agency'])
check('so it gets no dashboard',
  resolvePartnerRedirect(sellerRefused, '/seller-dashboard'), '/agency-dashboard')
check('and no switcher appears',
  isDualRolePartner(sellerRefused), false)

// A capability still listed but recorded as refused: held, and not approved.
const refusedButListed: PartnerRoleHolder = {
  role: 'agency',
  status: 'approved',
  roles: ['agency', 'seller'],
  roleStatus: { agency: 'approved', seller: 'rejected' },
}
check('a listed-but-refused capability reads as rejected',
  partnerRoleStatus(refusedButListed, 'seller'), 'rejected')
check('and opens no dashboard',
  resolvePartnerRedirect(refusedButListed, '/seller-dashboard'), '/agency-dashboard')

// ── A capability with nothing recorded about it ──────────────────────────────

const unrecorded: PartnerRoleHolder = {
  role: 'agency',
  status: 'approved',
  roles: ['agency', 'seller'],
}
check('an unrecorded capability is pending, never approved',
  partnerRoleStatus(unrecorded, 'seller'), 'pending')
check('and opens no dashboard',
  resolvePartnerRedirect(unrecorded, '/seller-dashboard'), '/agency-dashboard')

// ══════════════════════════════════════════════════════════════════════════════
// 3. Nobody else is touched
// ══════════════════════════════════════════════════════════════════════════════

const NON_PARTNERS: PartnerRoleHolder[] = [
  { role: 'superadmin' },
  { role: 'ops_admin' },
  { role: 'finance_member' },
  { role: '' },
  // A staff document that somehow carries a partner capability. `role` is the
  // authority field, so this must still be staff — `roles` can only add a
  // capability to an account that is already a partner.
  { role: 'ops_admin', roles: ['agency', 'seller'], roleStatus: { agency: 'approved' } },
]

for (const user of NON_PARTNERS) {
  for (const path of PATHS) {
    check(`non-partner '${user.role}' on ${path} is never redirected`,
      resolvePartnerRedirect(user, path), null)
  }
  check(`non-partner '${user.role}' holds no capability`, partnerRolesOf(user), [])
  check(`non-partner '${user.role}' has no landing`, partnerLanding(user), null)
  check(`non-partner '${user.role}' sees no switcher`, isDualRolePartner(user), false)
}

check('a null user is never redirected', resolvePartnerRedirect(null, '/'), null)
check('and holds nothing', partnerRolesOf(null), [])

// ══════════════════════════════════════════════════════════════════════════════
// 3b. The shared screens — /profile
// ══════════════════════════════════════════════════════════════════════════════
//
// /profile belongs to no capability, so every partner may sit on it whatever
// their statuses are. Deliberately NOT added to `PATHS` above: the legacy
// comparison in section 1 asserts byte-identical behaviour against the code
// that shipped, and that code knew nothing about /profile. This is the one
// place partner routing intentionally differs from it, so it is asserted here,
// on its own, where the divergence is visible.

for (const user of [
  agencyPending,
  agencyApproved,
  sellerApproved,
  bothApproved,
  bothPending,
  agencyApprovedSellerPending,
  agencyPendingSellerApproved,
]) {
  for (const path of ['/profile', '/profile/', '/profile/security']) {
    check(
      `partner ${JSON.stringify(user.roleStatus ?? user.status)} may sit on ${path}`,
      resolvePartnerRedirect(user, path),
      null,
    )
  }
}

// …and it is not a place anybody is ever SENT. A landing must be a dashboard or
// a waiting room, so /profile must not appear in the capability path set that
// `partnerLanding` chooses from.
check('/profile is not a capability path',
  allowedPartnerPaths(bothApproved).includes('/profile'), false)
check('both approved → still four allowed paths and no more',
  allowedPartnerPaths(bothApproved).sort(),
  ['/agency-dashboard', '/agency-pending', '/seller-dashboard', '/seller-pending'])
check('nobody is ever landed on /profile',
  [
    partnerLanding(bothPending),
    partnerLanding(agencyApproved),
    partnerLanding(agencyPendingSellerApproved),
  ].includes('/profile'),
  false)

// A partner sitting on /profile is still refused every staff screen — the
// shared-path check is an exception for one prefix, not a hole in the gate.
check('the shared path grants nothing else',
  resolvePartnerRedirect(agencyApproved, '/profiles'), '/agency-dashboard')
check('nor a route that merely starts with the same letters',
  resolvePartnerRedirect(agencyApproved, '/profile-export'), '/agency-dashboard')
check('nor anything that merely mentions it',
  resolvePartnerRedirect(agencyApproved, '/team/profile'), '/agency-dashboard')

// ══════════════════════════════════════════════════════════════════════════════
// 4. Every combination terminates
// ══════════════════════════════════════════════════════════════════════════════
//
// Exhaustive: both primaries × both capability sets × every status pairing ×
// every path. The resolver is applied to its own answer; one more hop must
// settle, or the shell would push the router forever.

const STATUSES = ['pending', 'approved', 'rejected', undefined] as const
let combinations = 0

for (const primary of ['agency', 'seller'] as const) {
  const other: PartnerRole = primary === 'agency' ? 'seller' : 'agency'
  for (const roles of [[primary], [primary, other]]) {
    for (const primaryStatus of STATUSES) {
      for (const otherStatus of STATUSES) {
        for (const legacyStatus of STATUSES) {
          const roleStatus: Partial<Record<PartnerRole, string>> = {}
          if (primaryStatus) roleStatus[primary] = primaryStatus
          if (otherStatus) roleStatus[other] = otherStatus

          const user: PartnerRoleHolder = {
            role: primary,
            status: legacyStatus,
            roles,
            roleStatus,
          }
          combinations += 1

          for (const path of PATHS) {
            const first = resolvePartnerRedirect(user, path)
            if (first === null) continue

            const second = resolvePartnerRedirect(user, first)
            if (second !== null) {
              failures.push(
                `redirect loop: ${JSON.stringify(user)} on ${path} → ${first} → ${second}`,
              )
            }
            checks += 1

            // Whatever it settles on must be a place this login is entitled to,
            // and a dashboard is only ever offered for an APPROVED capability.
            const allowed = allowedPartnerPaths(user)
            if (!allowed.some((p) => first.startsWith(p))) {
              failures.push(
                `landed somewhere not allowed: ${JSON.stringify(user)} → ${first}`,
              )
            }
            checks += 1

            for (const role of ['agency', 'seller'] as const) {
              if (
                first === PARTNER_HOME[role] &&
                partnerRoleStatus(user, role) !== 'approved'
              ) {
                failures.push(
                  `sent to an unapproved dashboard: ${JSON.stringify(user)} → ${first}`,
                )
              }
            }
            checks += 1
          }

          // A login with nothing approved is never handed a dashboard.
          if (approvedPartnerRoles(user).length === 0) {
            const landing = partnerLanding(user)
            const waiting: string[] = [
              PARTNER_PENDING.agency,
              PARTNER_PENDING.seller,
            ]
            ok(
              `nothing approved → a waiting room, not a dashboard (${JSON.stringify(user)})`,
              landing !== null && waiting.includes(landing),
            )
          }
        }
      }
    }
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}

console.log(`\nAll ${checks} partner-routing checks passed.`)
console.log('  · every legacy crmUsers document routes exactly as it did before')
console.log('  · the same document in the new shape routes identically')
console.log('  · one role, both roles, one approved and one pending, and both pending')
console.log('  · a refused or unrecorded capability opens no dashboard')
console.log('  · staff, superadmin and a malformed role are never redirected')
console.log(`  · ${combinations} capability/status combinations × ${PATHS.length} paths all terminate in one hop`)
process.exit(0)
