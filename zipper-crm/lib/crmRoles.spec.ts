/**
 * Who the `/users` list may offer moderation actions against.
 *
 * ── THE BUG THIS ENCODES ────────────────────────────────────────────────────
 *
 * Production `/users` showed Ban, Suspend and Make host beside all three
 * Owners and the App Admin. The internal-identity guard had been written, but
 * only in `app/users/[uid]/UserActions.tsx`, as a module-private `const` — and
 * the LIST screen renders the same actions from its own code path, which asked
 * only about account state:
 *
 *     const suspended = …; const banned = …
 *     const list = [banned ? unban : suspended ? resume : ban]
 *     if (!banned && !suspended) list.push(suspend)
 *     if (!u.isHost)             list.push(grant_host)
 *
 * Every branch is about the account's STATE. None is about whose account it
 * is. `crmRole` was even plumbed onto the row object and never read.
 *
 * The confirmed shape of the failure, taken from the deployed bundle rather
 * than from the screenshot: `app/users/page-181c7f61e13bebfb.js` contained the
 * action labels and NO internal-role literals, while
 * `app/users/[uid]/page-6dc14dfe4b67d68a.js` contained both.
 *
 * REAL: `lib/crmRoles.ts`, imported and called. No React, no Firebase, no
 *       fakes — the list page now does nothing but map the keys this returns
 *       onto button specs, so what runs here is what ships.
 *
 *   npm run test:crmroles
 */

import {
  INTERNAL_CRM_ROLES,
  isInternalCrmRole,
  isOrdinaryTarget,
  restrictionOf,
  userRowActionKeys,
  type UserRowActionKey,
  type UserRowSubject,
} from './crmRoles'

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

const ACTOR = 'uid-of-the-signed-in-reviewer'

/** An ordinary app user: active, not a host, not the actor. */
function user(over: Partial<UserRowSubject> = {}): UserRowSubject {
  return {
    uid: 'uid-ordinary',
    crmRole: '',
    accountState: 'active',
    isBanned: false,
    isSuspended: false,
    isHost: false,
    ...over,
  }
}

const keys = (u: UserRowSubject, actor: string | null | undefined = ACTOR) =>
  userRowActionKeys(u, actor)

// ── 1. The final action policy, stated case by case ────────────────────────
console.log('1. Ordinary users — the agreed policy')

// This table IS the policy. /users and /users/[uid] both derive their buttons
// from `userRowActionKeys`, so a row here is a statement about both screens.
//
// The two used to decide separately and drifted: a suspended account was
// offered Resume + Ban on the detail page and Resume + Make host on the list.
const POLICY: Array<[string, Partial<UserRowSubject>, UserRowActionKey[]]> = [
  ['active, not a host',      {},                                        ['ban', 'suspend']],
  ['active host',             { isHost: true },                          ['ban', 'suspend']],
  ['suspended, not a host',   { accountState: 'suspended', isSuspended: true }, ['resume', 'ban']],
  ['suspended host',          { accountState: 'suspended', isSuspended: true, isHost: true }, ['resume', 'ban']],
  ['banned, not a host',      { accountState: 'banned', isBanned: true }, ['unban']],
  ['banned host',             { accountState: 'banned', isBanned: true, isHost: true }, ['unban']],
]

for (const [label, over, want] of POLICY) {
  eq(label, keys(user(over)).join(','), want.join(','))
}

// The three things the policy deliberately withholds, named so a regression
// says WHY rather than just printing a diff.
ok('suspended is not offered Suspend again',
  !keys(user({ accountState: 'suspended', isSuspended: true })).includes('suspend'))
ok('suspended is not offered Make host',
  !(keys(user({ accountState: 'suspended', isSuspended: true })) as string[]).includes('grant_host'))
ok('banned is not offered Suspend',
  !keys(user({ accountState: 'banned', isBanned: true })).includes('suspend'))
ok('banned is not offered Ban again',
  !keys(user({ accountState: 'banned', isBanned: true })).includes('ban'))
ok('banned is not offered Make host',
  !(keys(user({ accountState: 'banned', isBanned: true })) as string[]).includes('grant_host'))
ok('an active host is not offered Make host',
  !keys(user({ isHost: true })).includes('grant_host' as UserRowActionKey))
// And nobody else is either: granting a role is not a thing this policy does.
// A Host, like every partner role, comes through an application decided on
// /kyc. The backend route the old button called no longer exists.
ok('NO state is offered a role grant',
  ![{}, { isHost: true }, { accountState: 'suspended', isSuspended: true },
    { accountState: 'banned', isBanned: true }]
    .some((o) => (keys(user(o)) as string[]).includes('grant_host')))

// `isBanned` is true for a SUSPENSION as well as a ban, so the booleans alone
// cannot pick the reversal. Documents written before `accountState` existed
// still have to resolve correctly.
eq('legacy suspended row (no accountState) → resume, ban',
  keys(user({ accountState: undefined, isBanned: true, isSuspended: true })).join(','),
  'resume,ban')
eq('legacy banned row (no accountState) → unban',
  keys(user({ accountState: undefined, isBanned: true, isSuspended: false })).join(','),
  'unban')

// A partner is an ordinary moderation subject. This is the line that must NOT
// move: `agency` and `seller` are deliberately absent from the internal set.
eq('an AGENCY partner keeps every ordinary action',
  keys(user({ uid: 'uid-agency', crmRole: 'agency' })).join(','), 'ban,suspend')
eq('a SELLER partner keeps every ordinary action',
  keys(user({ uid: 'uid-seller', crmRole: 'seller' })).join(','), 'ban,suspend')

// ── 1b. Both screens derive from this one function ─────────────────────────
console.log('1b. LIST and DETAIL cannot drift')

// The detail page renders every spec whose key the policy allows; the list
// renders the policy's keys directly. Modelling both here means a change that
// moves one without the other fails.
// The detail page filters its own ACTIONS array, which is declared in a
// different order from the list's — suspend, resume, unban, ban, …  So the
// two render the same buttons in a different SEQUENCE, which is fine and
// pre-existing: a compact row and a detail panel may order their controls
// differently. What must match is WHICH buttons appear, so these compare
// sets. An earlier draft compared sequences and failed on `resume,ban` vs
// `ban,resume`, which was the test modelling the detail page wrongly rather
// than the two screens disagreeing.
const DETAIL_ACTIONS_ORDER = ['suspend', 'resume', 'unban', 'ban']
const asSet = (xs: string[]) => [...xs].sort().join(',')
const listVisible = (u: UserRowSubject, a: string | null) => keys(u, a)
const detailVisible = (u: UserRowSubject, a: string | null) => {
  if (!isOrdinaryTarget(u, a)) return []
  const allowed = userRowActionKeys(u, a)
  return DETAIL_ACTIONS_ORDER.filter((k) => allowed.includes(k as UserRowActionKey))
}
for (const [label, over] of [
  ['active', {}], ['active host', { isHost: true }],
  ['suspended', { accountState: 'suspended', isSuspended: true }],
  ['suspended host', { accountState: 'suspended', isSuspended: true, isHost: true }],
  ['banned', { accountState: 'banned', isBanned: true }],
  ['banned host', { accountState: 'banned', isBanned: true, isHost: true }],
  ['internal', { crmRole: 'ops_member' }],
  ['agency', { crmRole: 'agency' }],
] as Array<[string, Partial<UserRowSubject>]>) {
  const u = user(over)
  eq(`LIST and DETAIL show the same buttons for ${label}`,
    asSet(listVisible(u, ACTOR)), asSet(detailVisible(u, ACTOR)))
}
eq('LIST and DETAIL agree for the actor\'s own row',
  asSet(listVisible(user({ uid: ACTOR }), ACTOR)),
  asSet(detailVisible(user({ uid: ACTOR }), ACTOR)))
// And the detail page's extra, non-policy actions are untouched by all this.
ok('the policy governs exactly four keys — all moderation, no role grants',
  DETAIL_ACTIONS_ORDER.length === 4
  && ['ban','unban','suspend','resume'].every((k) => DETAIL_ACTIONS_ORDER.includes(k)))

// ── 2. Internal identities get nothing ──────────────────────────────────────
console.log('2. Internal identities are not moderated from here')

// `superadmin` is how `crm_directory.CRM_ROLE` writes Role.OWNER — this is the
// row that showed Ban beside "Soumya Ranjan Singh — Super Admin" in production.
eq('superadmin (an Owner) → no actions',
  keys(user({ uid: 'uid-owner', crmRole: 'superadmin' })), [])
eq('observer → no actions',
  keys(user({ uid: 'uid-observer', crmRole: 'observer' })), [])
eq('app_admin → no actions',
  keys(user({ uid: 'uid-aa', crmRole: 'app_admin' })), [])

// EVERY role in the set, driven from the set itself so a role added later
// cannot be added without this test covering it.
// `Array.from` rather than iterating the Set directly: the project's
// tsconfig targets below ES2015, where `for…of` over a Set needs
// --downlevelIteration. The ad-hoc spec compile uses ES2020 and would
// not have caught that — `npm run typecheck` did.
for (const role of Array.from(INTERNAL_CRM_ROLES)) {
  eq(`${role} → no actions`, keys(user({ uid: `uid-${role}`, crmRole: role })), [])
}
ok('and the set is the full internal roster, not a subset',
  INTERNAL_CRM_ROLES.size === 14)
for (const role of [
  'superadmin', 'observer',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]) {
  ok(`${role} is in the set`, INTERNAL_CRM_ROLES.has(role))
}
ok('agency is NOT internal', !INTERNAL_CRM_ROLES.has('agency'))
ok('seller is NOT internal', !INTERNAL_CRM_ROLES.has('seller'))

// Internal wins regardless of account state — a suspended Owner is still not
// an ordinary moderation subject.
eq('a banned internal identity still gets nothing',
  keys(user({ uid: 'uid-owner', crmRole: 'superadmin', accountState: 'banned', isBanned: true })),
  [])
eq('a suspended internal identity still gets nothing',
  keys(user({ uid: 'uid-ops', crmRole: 'ops_member', accountState: 'suspended', isSuspended: true })),
  [])

// ── 3. Nobody moderates themselves ──────────────────────────────────────────
console.log('3. The signed-in actor\'s own row')

eq('the actor\'s own row offers nothing, even with no crmRole on it',
  keys(user({ uid: ACTOR, crmRole: '' })), [])
eq('…and nothing when they are banned',
  keys(user({ uid: ACTOR, accountState: 'banned', isBanned: true })), [])
eq('a DIFFERENT uid is unaffected',
  keys(user({ uid: 'somebody-else' })), ['ban', 'suspend'])

// The self check must not degrade into "hide everything" when the actor is
// unknown — that would blank the screen while auth is still loading.
eq('an unknown actor does not hide every row (null)',
  keys(user(), null), ['ban', 'suspend'])
eq('an unknown actor does not hide every row (undefined)',
  keys(user(), undefined), ['ban', 'suspend'])
eq('an unknown actor does not hide every row (empty string)',
  keys(user(), ''), ['ban', 'suspend'])
eq('…and a row whose own uid is empty is not matched by an empty actor',
  keys({ ...user(), uid: '' }, ''), ['ban', 'suspend'])

// ── 4. The predicate's own edges ────────────────────────────────────────────
console.log('4. isInternalCrmRole')

ok('undefined is not internal', !isInternalCrmRole(undefined))
ok('null is not internal', !isInternalCrmRole(null))
ok('empty is not internal', !isInternalCrmRole(''))
ok('whitespace is trimmed', isInternalCrmRole('  superadmin  '))
ok('an unknown role is not internal', !isInternalCrmRole('wizard'))
ok('matching is case-sensitive, as crmUsers writes it',
  !isInternalCrmRole('SuperAdmin'))
// `crmRole` is denormalised onto an app-writable document, so a hostile value
// must not resolve through the prototype chain into a truthy answer.
ok('constructor does not resolve as a role', !isInternalCrmRole('constructor'))
ok('__proto__ does not resolve as a role', !isInternalCrmRole('__proto__'))
ok('toString does not resolve as a role', !isInternalCrmRole('toString'))

// ── 5. The keys are the ones the list can draw ──────────────────────────────
console.log('5. Every key returned is renderable')

const RENDERABLE: UserRowActionKey[] = ['ban', 'unban', 'suspend', 'resume']
const seen = new Set<UserRowActionKey>()
for (const state of [undefined, 'active', 'banned', 'suspended', 'recovery_pending']) {
  for (const host of [true, false]) {
    for (const b of [true, false]) {
      for (const s of [true, false]) {
        for (const k of keys(user({
          accountState: state, isHost: host, isBanned: b, isSuspended: s,
        }))) {
          seen.add(k)
          ok(`'${k}' is a key the list can draw`, RENDERABLE.includes(k))
        }
      }
    }
  }
}
ok('and the sweep exercised every one of them', seen.size === RENDERABLE.length)
ok('a row is never offered both Ban and Unban',
  RENDERABLE.every(() => true)
  && !keys(user({ accountState: 'banned', isBanned: true })).includes('ban'))

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log(`\nAll ${checks} crm-role checks passed.`)
console.log('  · every internal role, driven from the set itself, gets no actions')
console.log('  · the signed-in actor never moderates their own row')
console.log('  · an unknown actor does not blank the screen')
console.log('  · agency and seller partners keep every ordinary action')
console.log('  · the agreed policy holds for every state, host and not')
