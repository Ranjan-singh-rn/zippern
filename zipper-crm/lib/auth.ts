'use client'

import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
  createUserWithEmailAndPassword,
  updatePassword,
  getAuth,
  sendPasswordResetEmail,
  deleteUser,
  GoogleAuthProvider,
  signInWithPopup,
  linkWithCredential,
  linkWithPopup,
  unlink as unlinkProvider,
  getAdditionalUserInfo,
  sendEmailVerification,
  AuthCredential,
} from 'firebase/auth'
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  Timestamp,
  serverTimestamp,
  getFirestore,
} from 'firebase/firestore'
import { initializeApp, deleteApp } from 'firebase/app'
import { auth, db, firebaseConfig, connectEmulators } from './firebase'
import type { PartnerRole, PartnerRoleStatus } from './partnerRouting'
import { runSubAgencyCreation } from './subAgencyCreation'
import { runLoginThenRecord } from './loginThenRecord'
import { CrmDoorRefusal, asksApiWhyInactive, inactiveLoginMessage } from './crmDoor'
import { auth as apiAuth } from './api'

// One login can hold both partner capabilities — agency AND coin seller. The
// model, the routing table and the legacy fallbacks live in ./partnerRouting,
// which imports nothing and is exercised by ./partnerRouting.spec.ts.
export {
  PARTNER_HOME,
  PARTNER_PENDING,
  PARTNER_ROLES,
  PARTNER_ROLE_LABEL,
  allowedPartnerPaths,
  approvedPartnerRoles,
  isDualRolePartner,
  isPartnerRole,
  partnerLanding,
  partnerRecordId,
  partnerRoleStatus,
  partnerRolesOf,
  primaryPartnerRole,
  resolvePartnerRedirect,
} from './partnerRouting'
import { SUPPORT_EMAIL } from './contacts'  // QA #47
export type { PartnerRole, PartnerRoleStatus } from './partnerRouting'

// ── Role definitions ────────────────────────────────────────────────────────

export type CrmRole =
  | 'superadmin'
  // App department
  | 'app_admin'     | 'app_member'
  // Operations department
  | 'ops_admin'     | 'ops_member'
  // Finance department
  | 'finance_admin' | 'finance_member'
  // Tech department
  | 'tech_admin'    | 'tech_member'
  // Support department
  | 'support_admin' | 'support_member'
  // Marketing department (broadcasts, promotions, external comms)
  | 'marketing_admin' | 'marketing_member'
  // External accounts
  | 'agency'
  | 'seller'

// ── Legacy role migration ────────────────────────────────────────────────────
// Maps old generic role strings (pre-dept-system) → nearest new equivalent.
// Used in crmSignIn + getCrmUser to auto-migrate on first login after the
// role system upgrade. Firestore doc is updated in-place so it only runs once.

const LEGACY_ROLE_MAP: Record<string, CrmRole> = {
  admin:   'app_admin',    // old catch-all admin → app dept admin (SA can re-assign)
  ops:     'ops_member',
  tech:    'tech_member',
  finance: 'finance_member',
  support: 'support_member',
}

export function normalizeCrmRole(raw: string): CrmRole {
  if (raw in LEGACY_ROLE_MAP) return LEGACY_ROLE_MAP[raw]
  return raw as CrmRole
}

// ── Department helpers ───────────────────────────────────────────────────────

export const DEPT_NAMES = ['app', 'ops', 'finance', 'tech', 'support', 'marketing'] as const
export type Dept = typeof DEPT_NAMES[number]

/** Returns the department prefix for a role, or null for superadmin/agency/seller */
export function getDeptFromRole(role: CrmRole): Dept | null {
  const match = role.match(/^([^_]+)_(admin|member)$/)
  return match ? (match[1] as Dept) : null
}

/** True for app_admin, ops_admin, finance_admin, tech_admin, support_admin */
export function isDeptAdmin(role: CrmRole): boolean {
  return role.endsWith('_admin') && role !== 'superadmin'
}

/** True for *_member roles */
export function isDeptMember(role: CrmRole): boolean {
  return role.endsWith('_member')
}

/** Returns the *_member counterpart for a *_admin role, or null */
export function getMemberRole(adminRole: CrmRole): CrmRole | null {
  const dept = getDeptFromRole(adminRole)
  if (!dept || !isDeptAdmin(adminRole)) return null
  return `${dept}_member` as CrmRole
}

export const DEPT_LABELS: Record<Dept, string> = {
  app:       'App',
  ops:       'Operations',
  finance:   'Finance',
  tech:      'Tech',
  support:   'Support',
  marketing: 'Marketing',
}

export interface DeptStaffMember {
  uid: string
  name: string
  role: CrmRole
}

/**
 * Active CRM staff (admin + member) belonging to a department — used for ticket
 * assignment pickers. P1-E: read from `staffRoster` (names, roles, department;
 * readable by all staff, written only by the API), not `crmUsers`, which holds
 * contact details and is readable only by owners and a member's own admin.
 */
export async function getDeptStaff(dept: Dept): Promise<DeptStaffMember[]> {
  const q = query(
    collection(db, 'staffRoster'),
    where('role', 'in', [`${dept}_admin`, `${dept}_member`]),
  )
  const snap = await getDocs(q)
  return snap.docs
    .map(d => ({ uid: d.id, name: (d.data().name as string) ?? '', role: d.data().role as CrmRole, isActive: d.data().isActive }))
    .filter(m => m.isActive !== false)
    .map(({ uid, name, role }) => ({ uid, name, role }))
}

// All CRM staff roles (excludes agency & seller)
export const STAFF_ROLES: CrmRole[] = [
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]

export const ROLE_LABELS: Record<CrmRole, string> = {
  superadmin:       'Super Admin',
  app_admin:        'App Admin',
  app_member:       'App Team',
  ops_admin:        'Ops Admin',
  ops_member:       'Ops Team',
  finance_admin:    'Finance Admin',
  finance_member:   'Finance Team',
  tech_admin:       'Tech Admin',
  tech_member:      'Tech Team',
  support_admin:    'Support Admin',
  support_member:   'Support Team',
  marketing_admin:  'Marketing Admin',
  marketing_member: 'Marketing Team',
  agency:           'Agency',
  seller:           'Coin Seller',
}

export const ROLE_COLORS: Record<CrmRole, string> = {
  superadmin:       'bg-pink-500/20 text-pink-300',
  app_admin:        'bg-purple-600/20 text-purple-300',
  app_member:       'bg-purple-500/15 text-purple-400',
  ops_admin:        'bg-blue-600/20 text-blue-300',
  ops_member:       'bg-blue-500/15 text-blue-400',
  finance_admin:    'bg-green-600/20 text-green-300',
  finance_member:   'bg-green-500/15 text-green-400',
  tech_admin:       'bg-cyan-600/20 text-cyan-300',
  tech_member:      'bg-cyan-500/15 text-cyan-400',
  support_admin:    'bg-yellow-600/20 text-yellow-300',
  support_member:   'bg-yellow-500/15 text-yellow-400',
  marketing_admin:  'bg-rose-600/20 text-rose-300',
  marketing_member: 'bg-rose-500/15 text-rose-400',
  agency:           'bg-orange-500/20 text-orange-300',
  seller:           'bg-indigo-500/20 text-indigo-300',
}

export type Permission =
  // ── User management ────────────────────────────────
  | 'can_view_users'          // View user & host profiles
  | 'can_ban_users'           // Ban / unban accounts & devices
  | 'can_adjust_balance'      // Add / deduct diamonds & beans (SA approval required)
  // ── Agency & KYC ──────────────────────────────────
  | 'can_view_agencies'       // View agency list & details
  | 'can_approve_kyc'         // Approve / reject KYC submissions
  // ── Seller management ─────────────────────────────
  | 'can_view_sellers'        // View coin seller list & details
  | 'can_approve_seller'      // Approve seller accounts
  | 'can_coin_operations'     // Verify recharges, mark coin ops
  // ── Finance ───────────────────────────────────────
  | 'can_view_finance'        // View transactions, revenue, net payout
  | 'can_process_payout'      // Process / mark salary & payouts paid
  // ── Config (SA-level; admins can propose) ─────────
  | 'can_economy_config'      // View / propose economy config changes
  | 'can_commission_slabs'    // View / propose commission slab edits
  | 'can_app_config'          // View / propose app config changes
  // ── Tickets ───────────────────────────────────────
  | 'can_create_tickets'      // Create internal tickets
  | 'can_assign_tickets'      // Assign tickets to team members
  | 'can_close_tickets'       // Close / resolve tickets
  // ── Admin ─────────────────────────────────────────
  | 'can_approve_requests'    // Approve requests in SA approval queue
  | 'can_manage_team'         // Invite, edit, deactivate CRM staff
  | 'can_monitor_live'        // Access live room monitor
  // ── Marketing ─────────────────────────────────────
  | 'can_send_broadcasts'     // Send platform-wide broadcast messages

export const DEFAULT_PERMISSIONS: Record<CrmRole, Permission[]> = {
  // ── Super Admin ─ all permissions ────────────────────────────────────────
  superadmin: [
    'can_view_users', 'can_ban_users', 'can_adjust_balance',
    'can_view_agencies', 'can_approve_kyc',
    'can_view_sellers', 'can_approve_seller', 'can_coin_operations',
    'can_view_finance', 'can_process_payout',
    'can_economy_config', 'can_commission_slabs', 'can_app_config',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    'can_approve_requests', 'can_manage_team', 'can_monitor_live',
    'can_send_broadcasts',
  ],

  // ── App Department ────────────────────────────────────────────────────────
  // Users, hosts, KYC, agencies, live monitor, broadcasts, analytics
  app_admin: [
    'can_view_users', 'can_ban_users', 'can_adjust_balance',
    'can_view_agencies', 'can_view_sellers',
    'can_view_finance', 'can_app_config',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    'can_manage_team', 'can_monitor_live',
  ],
  app_member: [
    'can_view_users', 'can_ban_users',
    'can_create_tickets', 'can_monitor_live',
  ],

  // ── Operations Department ─────────────────────────────────────────────────
  // KYC, agency onboarding, seller approvals, operational reports
  ops_admin: [
    'can_view_users', 'can_view_agencies', 'can_approve_kyc',
    'can_view_sellers', 'can_approve_seller',
    'can_view_finance',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    'can_manage_team',
  ],
  ops_member: [
    'can_view_agencies', 'can_view_sellers',
    'can_create_tickets',
  ],

  // ── Finance Department ────────────────────────────────────────────────────
  // Payouts, salary, coin purchases, balance adjustments, revenue
  finance_admin: [
    'can_view_users', 'can_adjust_balance',
    'can_view_agencies', 'can_view_sellers',
    'can_coin_operations', 'can_view_finance', 'can_process_payout',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    // Every department admin runs their own department, Finance included. The
    // server narrows it to `finance_member` and nothing else — see
    // `assignable_roles` — so this grants the button, not the scope.
    'can_manage_team',
  ],
  finance_member: [
    'can_view_agencies', 'can_view_sellers',
    'can_coin_operations', 'can_view_finance', 'can_process_payout',
    'can_create_tickets',
  ],

  // ── Tech Department ───────────────────────────────────────────────────────
  // Economy config, app config, commission slabs, tech tickets
  tech_admin: [
    'can_economy_config', 'can_commission_slabs', 'can_app_config',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    // See finance_admin. Tech is a department and its admin creates
    // `tech_member`, and only `tech_member`.
    'can_manage_team',
  ],
  tech_member: [
    'can_economy_config', 'can_commission_slabs', 'can_app_config',
    'can_create_tickets',
  ],

  // ── Support Department ────────────────────────────────────────────────────
  // User support tickets, ban appeals, user feedback
  support_admin: [
    'can_view_users',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    'can_manage_team',
  ],
  support_member: [
    'can_view_users',
    'can_create_tickets', 'can_assign_tickets',
  ],

  // ── Marketing Department ──────────────────────────────────────────────────
  // Broadcasts, promotions, external comms — split out of App as a light dept
  marketing_admin: [
    'can_send_broadcasts',
    'can_create_tickets', 'can_assign_tickets', 'can_close_tickets',
    'can_manage_team',
  ],
  marketing_member: [
    'can_send_broadcasts',
    'can_create_tickets',
  ],

  // ── External accounts ─────────────────────────────────────────────────────
  agency:  [],
  seller:  [],
}

// ── CrmUser type ────────────────────────────────────────────────────────────

/** Generates a human-readable 8-character uppercase alphanumeric ID, e.g. "A1B2C3D4" */
export function generateCrmId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I to avoid confusion
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

export interface CrmUser {
  uid:          string
  crmId?:       string       // human-readable 8-char ID, e.g. "A1B2C3D4"
  email:        string       // real personal email (gmail, etc.)
  name:         string
  phone:        string
  role:         CrmRole
  // ── Two capabilities on one login ──────────────────────────────────────────
  // `role` above is unchanged and still authoritative: it is the capability the
  // account was created with, and it is what every existing screen and every
  // Firestore rule reads. These two are additive and absent on every account
  // that exists today.
  //
  //   roles       every partner capability the login holds, once it holds more
  //               than one. Read through `partnerRolesOf`, which falls back to
  //               [role] — so a legacy document needs no migration.
  //   roleStatus  per-capability status, because `status` below can only speak
  //               for one of them.
  //
  // A capability appears in `roles` from the moment it is APPLIED for, exactly
  // as `role` does for a fresh signup; `roleStatus` is what says whether it has
  // been approved. Only the backend, through the Admin SDK, ever writes
  // 'approved' — the security rules let a partner file an application and
  // nothing else.
  roles?:       CrmRole[]
  roleStatus?:  Partial<Record<PartnerRole, PartnerRoleStatus>>
  // ── The five fields their holder owns ──────────────────────────────────────
  //
  // Personal contact detail, edited by the person themself on /profile and by
  // nobody else on that screen. They are the ONLY keys the self-service clause
  // in firestore.rules admits, and they are chosen so that nothing reads them
  // to decide anything: no rule, no API route and no Android screen resolves a
  // permission, a balance or an approval from any of them.
  //
  // `displayName` sits alongside `name` rather than replacing it. `name` is the
  // roster name — it is the authoritative Mongo `staff.name`, it is what the
  // audit log records, and it is not self-editable. `displayName` is what the
  // person prefers to be called, and falls back to `name` when unset.
  //
  // `personalEmail` likewise sits alongside `email`. `email` is the sign-in
  // address and the binding a partner application is matched against; changing
  // it is an account change, not a preference.
  displayName?:   string
  personalEmail?: string
  address?:       string
  photoUrl?:      string
  dept?:        Dept         // department derived from role; stored for easy querying
  fieldCharge?: string       // named responsibility, e.g. "User Conduct Officer"
  reportsTo?:   string       // uid of the dept admin this member reports to (members only)
  permissions:  Permission[]
  agencyId?:    string
  sellerUid?:   string       // legacy field
  sellerId?:    string       // sellers collection doc ID
  isActive:     boolean
  // GOV C4 (B06): the human behind this login is suspended or banned in the
  // app. Written by the API alone (`services/users.py`); absent = unrestricted.
  accountRestricted?: boolean
  status?:      'pending' | 'approved'
  createdBy:    string
  createdAt:    Timestamp | null
  lastLoginAt:  Timestamp | null
}

// ── Superadmin seeding lives in the backend, not here ────────────────────────
//
// `seedSuperAdmin()` used to sit at this spot. It created a Firebase account
// from a password hardcoded in this file — which meant the password shipped in
// the browser bundle — and then wrote itself a crmUsers document with
// role 'superadmin', relying on a bootstrap clause in firestore.rules that let
// any authenticated user do exactly that. Both the function and the rule have
// been removed.
//
// Staff and owner accounts are provisioned by backend/scripts/seed_accounts.py
// using the Firebase Admin SDK, which runs on a server with a service-account
// key and bypasses security rules by design. That is the only way an account
// with authority should ever come into existence.

// ── Sign in ─────────────────────────────────────────────────────────────────
// Now accepts a real personal email directly (no username→email mapping)

/** GOV C4: `core/account_state.ACCOUNT_RESTRICTED_MESSAGE`, word for word. */
export const ACCOUNT_RESTRICTED_MESSAGE =
  'This account is suspended or banned. Partner access is closed until it is lifted.'

/**
 * Turn an ALREADY-AUTHENTICATED uid into the CRM user behind it.
 *
 * Shared by every door — password, Google, and the link that joins them — so
 * that "what it means to be signed in to the CRM" is decided in exactly one
 * place. When this was inlined in `crmSignIn`, adding a second door meant
 * copying the deactivation check, the role normalisation and the legacy
 * migration, and the copy is where they drift.
 *
 * THE UID IS THE IDENTITY. This function is given a uid and reads the document
 * with that id. It never searches by email, and there is deliberately no
 * parameter through which an email could be passed in.
 */
async function resolveCrmUser(uid: string, idToken = ''): Promise<CrmUser> {
  const snap = await getDoc(doc(db, 'crmUsers', uid))

  // The superadmin "self-repair" branch that used to sit here has been removed.
  //
  // It minted a full superadmin record for whoever signed in with the address in
  // NEXT_PUBLIC_SUPERADMIN_EMAIL — and NEXT_PUBLIC_* variables are compiled into
  // the browser bundle, so that address was public. Anyone could read it, create
  // an account with it, and be handed the top role on first login. Staff accounts
  // are provisioned by backend/scripts/seed_accounts.py through the Admin SDK; if
  // a record is genuinely missing, that script is where it gets fixed.
  if (!snap.exists()) {
    await firebaseSignOut(auth)
    throw new Error('CRM account not found. Contact your administrator.')
  }

  const raw  = snap.data() as CrmUser & { role: string }
  const data = { ...raw, role: normalizeCrmRole(raw.role) } as CrmUser

  if (!data.isActive) {
    // Decision 16 (RC): a REJECTED partner's login is inactive too, and
    // "deactivated" is untrue for them; QA #44: so is a SUSPENDED member of
    // staff. Ask the API why and show its sentence (lib/crmDoor). No session is
    // opened either way; the browser is signed out below.
    //
    // QA #49: asked with the ID token captured at sign-in, not with whoever is
    // signed in now — AuthProvider's crmUsers listener signs the browser out as
    // soon as it sees `isActive: false`, which used to beat this question to
    // the network, so the API was never asked and every rejected applicant was
    // told "deactivated".
    const apiRefusal = asksApiWhyInactive(data.role)
      ? await (idToken ? apiAuth.refusalForLogin(idToken) : apiAuth.refusalForCurrentLogin()).catch(() => '')
      : ''
    await firebaseSignOut(auth)
    throw new CrmDoorRefusal(inactiveLoginMessage(data.role, apiRefusal))
  }

  // GOV C4 (B06): the API refuses this login a session while the app account is
  // suspended or banned (401 at sign-in, 403 on a live session) and the rules
  // refuse its writes, so it is refused at the door with the API's sentence.
  if (data.accountRestricted === true) {
    await firebaseSignOut(auth)
    throw new CrmDoorRefusal(ACCOUNT_RESTRICTED_MESSAGE)
  }

  // Two writes, not one, and only the first of them may fail loudly.
  //
  // A single combined write used to carry `lastLoginAt` alongside the migrated
  // `role` and `dept`. Firestore rules permit a self-update of `lastLoginAt`
  // only, so for any account still on a legacy role string — 'admin', 'ops',
  // 'tech', 'finance', 'support' — the whole write was denied and the throw
  // propagated out of sign-in. Exactly the staff the legacy mapping exists to
  // support could not log in at all.
  await updateDoc(doc(db, 'crmUsers', uid), {
    lastLoginAt: serverTimestamp(),
  })

  // The role migration is a convenience: it saves the normalisation being redone
  // on every read. A superadmin can do it; anyone else is refused by the rules,
  // and that refusal must not cost them their session. `data.role` below is
  // already normalised in memory either way, so nothing downstream depends on
  // this write landing.
  if (raw.role !== data.role) {
    try {
      await updateDoc(doc(db, 'crmUsers', uid), {
        role: data.role,
        dept: getDeptFromRole(data.role) ?? null,
      })
    } catch {
      /* Not permitted for this role — harmless, and normalised in memory. */
    }
  }

  return { ...data, uid }
}

export async function crmSignIn(email: string, password: string): Promise<CrmUser> {
  const emailLower = email.trim().toLowerCase()
  const cred = await signInWithEmailAndPassword(auth, emailLower, password)
  // QA #49: the token of THIS sign-in, taken before anything else can sign the
  // browser out — see `resolveCrmUser`.
  const idToken = await cred.user.getIdToken().catch(() => '')
  return resolveCrmUser(cred.user.uid, idToken)
}

// ── Google ──────────────────────────────────────────────────────────────────
//
// A second way to prove who you are. NOT a second account.
//
// ── WHY THERE IS A PASSWORD STEP IN A GOOGLE FLOW ─────────────────────────
//
// Every CRM account that exists today was created with email and password by
// the Admin SDK. Firebase's "one account per email address" therefore refuses
// a Google credential for that address outright, with
// `auth/account-exists-with-different-credential`, and hands back the Google
// credential unspent.
//
// That refusal is the feature. Accepting the Google identity because its
// email string matches a staff row would mean anyone who could obtain that
// Gmail could become its owner, which is precisely the "blind email merge"
// this design exists to prevent. So the pending credential is held, the
// person proves they hold the EXISTING account by entering its password, and
// only then is Google linked to that same uid.
//
// It happens once per person. Afterwards the uid carries both providers and
// "Continue with Google" resolves straight to it — in the CRM and, because it
// is the same Firebase account, in the Android app too.

/**
 * The observer. CRM-only, by one-time code, and never a Firebase account.
 *
 * Audit C-18: there is NO literal fallback. `NEXT_PUBLIC_OBSERVER_EMAIL` is
 * required at build time (deploy-crm.command checks the key is set and
 * verify-out checks no mailbox literal reached the bundle); when it is unset
 * `isObserverAddress` matches nothing, so the Google and password doors treat
 * every address as an ordinary one rather than guessing the mailbox.
 */
const OBSERVER_EMAIL = (process.env.NEXT_PUBLIC_OBSERVER_EMAIL ?? '').trim().toLowerCase()

/** Is this the observer's address? Never true when the variable is unset. */
function isObserverAddress(email: string | null | undefined): boolean {
  const e = (email ?? '').trim().toLowerCase()
  return OBSERVER_EMAIL !== '' && e === OBSERVER_EMAIL
}

/**
 * The Google credential that `auth/account-exists-with-different-credential`
 * handed back, waiting for the password that authorises linking it.
 *
 * Module scope rather than React state on purpose: it must survive the
 * re-renders of the password prompt, and it must NOT survive a page load. It
 * is a live credential — putting it in localStorage or a URL would leave it
 * somewhere it can be read.
 */
let pendingGoogleCredential: AuthCredential | null = null

export type GoogleSignInOutcome =
  /** Straight in. The Google identity already belongs to a CRM account. */
  | { kind: 'signed-in'; user: CrmUser }
  /** This address has a CRM account. Prove it with the password, then link. */
  | { kind: 'needs-password'; email: string }
  /** Not a CRM account, or not allowed here. `message` is safe to show. */
  | { kind: 'refused'; message: string }

/**
 * Sign out and, if this popup is what created the account, delete it.
 *
 * Without the delete, every refused Google attempt leaves a real Firebase
 * user behind — an address with no CRM document but a live credential. For
 * the observer that would be worse than untidy: the whole design is that
 * the Observer's address has NO Firebase account, and one popup would have
 * created it.
 */
async function discardGoogleAccount(user: User, wasCreatedNow: boolean): Promise<void> {
  if (wasCreatedNow) {
    try {
      await deleteUser(user)
      return
    } catch {
      /* Needs a recent login, or already gone. Sign out below regardless. */
    }
  }
  try { await firebaseSignOut(auth) } catch { /* nothing to sign out of */ }
}

// ── THE EXCEPTION TO "ONE ACCOUNT PER EMAIL ADDRESS" ────────────────────────
//
// Everything above rests on Firebase refusing a Google credential for an
// address a password account already holds. It has one exception, and it is
// silent.
//
// If the password account's email is **not verified**, Firebase does not raise
// `auth/account-exists-with-different-credential` at all. It reasons that an
// unverified password account may have been planted by somebody who does not
// own the address, so it trusts Google instead: it links Google to that uid and
// **removes the password provider**. No error, no prompt. The person's CRM
// password simply stops working, with nothing on any screen saying why, and the
// only way back is a reset email to an address they may not have proved they
// can read.
//
// That is not a theoretical state here, and it is not fixed by the backend
// having stopped producing it. `backend/scripts/seed_accounts.py` now asserts
// `email_verified=True` when it creates a staff account, and repairs one it
// finds unverified — but that only covers accounts that script creates:
//
//   · every account it seeded BEFORE that change is still unverified until a
//     re-run or `scripts/link_owner_identities.py` repairs it;
//   · every partner login made in this file — `createPartnerLogin`,
//     `createSubAgencyAccount`, and the four public registration forms behind
//     them — is created by `createUserWithEmailAndPassword`, which produces an
//     UNVERIFIED address by definition. Agencies and coin sellers reach both of
//     the doors below: /login offers them Google, /profile offers them Connect
//     Google, and nothing in the browser can assert a flag the Admin SDK owns.
//
// So the browser has to hold this line itself. Both linking paths require a
// verified address BEFORE they touch a provider. The refusal is a dead end with
// a way out of it: nothing is linked, nothing is unlinked, and the screen
// offers the verification email.

/**
 * The refusal both linking paths raise for an address Firebase has not seen
 * confirmed.
 *
 * Exported as a constant, and matched with `isEmailNotVerified` rather than by
 * searching the prose, because /login and /profile have to recognise THIS
 * refusal specifically — it is the one whose answer is a button rather than
 * another attempt at the password.
 */
export const EMAIL_NOT_VERIFIED =
  'Verify your email address before connecting Google. Until it is verified, ' +
  'Firebase treats a Google sign-in on this address as the stronger claim and ' +
  'would remove the password from this account — so CRM password sign-in would ' +
  'stop working. Send yourself the verification email, open the link in it, ' +
  'then start again.'

/** True for the refusal above, and for nothing else. */
export function isEmailNotVerified(err: unknown): boolean {
  return err instanceof Error && err.message === EMAIL_NOT_VERIFIED
}

/**
 * Ask Firebase again whether this account's address is verified.
 *
 * `emailVerified` is a cached property of the `User` object: opening the
 * verification link — in another tab, on a phone, an hour ago — does not update
 * it, and nothing else will. Without this reload a person who HAS verified
 * would keep being refused by a browser that never noticed, which is a dead end
 * with no way out of it.
 */
export async function refreshEmailVerified(): Promise<boolean> {
  const user = auth.currentUser
  if (!user) return false
  await user.reload()
  return user.emailVerified === true
}

/**
 * P0-5 (AUTHN-2): the public partner forms file nothing until the signed-in
 * login's address is CONFIRMED, because `firestore.rules` binds the record, the
 * CRM account and the back-link to a verified email only.
 *
 * Verified → the ID token is refreshed so the rules see `email_verified`, and
 * the form carries on. Not verified → the confirmation email is sent and the
 * applicant is told to open it and submit again; nothing has been written.
 * A failure to check is reported as such, never as "verified".
 */
export async function ensurePartnerEmailVerified(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  const user = auth.currentUser
  if (!user) return { ok: false, message: 'Your login could not be found. Please try again.' }
  let verified: boolean
  try {
    verified = await refreshEmailVerified()
  } catch {
    return {
      ok: false,
      message: 'Your login could not be checked with Firebase, so nothing was submitted. Please try again.',
    }
  }
  if (verified) {
    await user.getIdToken(true)
    return { ok: true }
  }
  let sent = true
  try {
    await sendEmailVerification(user)
  } catch {
    sent = false   // throttled or offline — the instruction below still applies
  }
  const address = user.email ?? 'your address'
  return {
    ok: false,
    message: (sent ? `We have sent a confirmation link to ${address}. ` : '')
      + 'Open the link in that email to confirm your address, then press Submit '
      + 'again. Nothing has been submitted yet.',
  }
}

/**
 * Send the "confirm this is your address" email.
 *
 * Two callers in two different situations, which is why the credentials are
 * optional rather than there being two functions:
 *
 *   /profile  is signed in, so the session itself is the account to send for.
 *   /login    is NOT — `completeGoogleLink` signs out before it refuses, on
 *             purpose — so it hands back the address and password it has
 *             already collected, and this signs in only long enough to send.
 *             The session is closed again either way, including on failure:
 *             the person is standing at a login screen and leaving them
 *             half-signed-in behind it is worse than the refusal.
 */
export async function sendCrmEmailVerification(
  credentials?: { email: string; password: string },
): Promise<void> {
  if (!credentials) {
    const user = auth.currentUser
    if (!user) throw new Error('Sign in first.')
    await sendEmailVerification(user)
    return
  }

  const emailLower = credentials.email.trim().toLowerCase()
  const res = await signInWithEmailAndPassword(auth, emailLower, credentials.password)
  try {
    await sendEmailVerification(res.user)
  } finally {
    await firebaseSignOut(auth)
  }
}

export async function crmSignInWithGoogle(): Promise<GoogleSignInOutcome> {
  const provider = new GoogleAuthProvider()
  // Always ask which account. Without this, a shared machine silently reuses
  // whoever Google saw last, and the person signs in as their colleague.
  provider.setCustomParameters({ prompt: 'select_account' })

  let cred
  try {
    cred = await signInWithPopup(auth, provider)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? ''

    if (code === 'auth/account-exists-with-different-credential') {
      // The address is spoken for by a password account — theirs. Hold the
      // credential and ask them to prove it.
      pendingGoogleCredential = GoogleAuthProvider.credentialFromError(
        err as Parameters<typeof GoogleAuthProvider.credentialFromError>[0],
      )
      const claimed = String(
        (err as { customData?: { email?: string } })?.customData?.email ?? '',
      ).toLowerCase()

      if (isObserverAddress(claimed)) {
        pendingGoogleCredential = null
        return {
          kind: 'refused',
          message:
            'The observer account signs in with a one-time code, not Google.',
        }
      }
      if (!pendingGoogleCredential) {
        return {
          kind: 'refused',
          message: 'Google sign-in could not be completed. Use your password.',
        }
      }
      return { kind: 'needs-password', email: claimed }
    }

    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return { kind: 'refused', message: '' }   // they changed their mind
    }
    if (code === 'auth/popup-blocked') {
      return {
        kind: 'refused',
        message: 'Your browser blocked the Google window. Allow popups and try again.',
      }
    }
    return { kind: 'refused', message: 'Google sign-in failed. Try again.' }
  }

  const isNew = getAdditionalUserInfo(cred)?.isNewUser === true
  const signedInEmail = (cred.user.email ?? '').toLowerCase()

  // ── The observer never signs in here, and never gains an account ─────────
  if (isObserverAddress(signedInEmail)) {
    await discardGoogleAccount(cred.user, isNew)
    return {
      kind: 'refused',
      message: 'The observer account signs in with a one-time code, not Google.',
    }
  }

  // ── A Google identity with no CRM document is not a CRM user ─────────────
  //
  // This is the branch that must never fall back to matching the email
  // against a staff row. If this address does have a CRM account under
  // another uid, Firebase would have raised the collision above; reaching
  // here means the Google identity itself is simply unknown.
  const snap = await getDoc(doc(db, 'crmUsers', cred.user.uid))
  if (!snap.exists()) {
    await discardGoogleAccount(cred.user, isNew)
    return {
      kind: 'refused',
      message:
        'This Google account is not connected to a Zipper CRM account. Sign in ' +
        'with your email and password, then connect Google from Settings.',
    }
  }

  return { kind: 'signed-in', user: await resolveCrmUser(cred.user.uid, await cred.user.getIdToken().catch(() => '')) }
}

/**
 * Finish the link: prove the existing account with its password, then attach
 * the Google credential to that same uid.
 *
 * The order is what makes it safe. `signInWithEmailAndPassword` runs first and
 * must succeed, so the session doing the linking is already the owner of the
 * account being linked to. `linkWithCredential` then adds a provider to it —
 * it cannot move an account, cannot merge two, and cannot create one.
 */
export async function completeGoogleLink(
  email: string,
  password: string,
): Promise<CrmUser> {
  const credential = pendingGoogleCredential
  if (!credential) {
    throw new Error('That Google sign-in expired. Start again.')
  }

  const emailLower = email.trim().toLowerCase()
  if (isObserverAddress(emailLower)) {
    pendingGoogleCredential = null
    throw new Error('The observer account signs in with a one-time code, not Google.')
  }

  // Proof. Any failure here — wrong password, disabled account — throws, and
  // the credential stays pending for another attempt.
  const res = await signInWithEmailAndPassword(auth, emailLower, password)

  // The unverified-address refusal, and it comes first for a reason.
  //
  // `res.user` was resolved by the sign-in a line above, so `emailVerified` is
  // as fresh as Firebase can make it and needs no reload. Placing the check
  // ahead of `resolveCrmUser` means the session that is about to be thrown away
  // never writes its `lastLoginAt` either — the account is left exactly as it
  // was found, with its password provider untouched, which is the whole point.
  //
  // The credential is discarded rather than held: it is the thing that would
  // remove the password if it were spent, and after verifying they will press
  // "Continue with Google" again anyway.
  if (!res.user.emailVerified) {
    pendingGoogleCredential = null
    await firebaseSignOut(auth)
    throw new Error(EMAIL_NOT_VERIFIED)
  }

  // Confirm the CRM record before writing to the auth account, so a password
  // that is right for a Firebase user with no CRM access does not get a
  // Google provider attached as a consolation prize.
  const user = await resolveCrmUser(res.user.uid, await res.user.getIdToken().catch(() => ''))

  try {
    await linkWithCredential(res.user, credential)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? ''
    pendingGoogleCredential = null
    if (code === 'auth/credential-already-in-use') {
      throw new Error(
        'That Google account is already connected to a different Zipper account.',
      )
    }
    if (code === 'auth/provider-already-linked') {
      return user   // someone linked it in another tab. Nothing to do.
    }
    throw new Error('Signed in, but Google could not be connected. Try from Settings.')
  }

  pendingGoogleCredential = null
  return user
}

/** Drop a held credential — the person backed out of the password prompt. */
export function cancelGoogleLink(): void {
  pendingGoogleCredential = null
}

// ── Connecting Google from Settings ─────────────────────────────────────────

/** Which providers the signed-in account carries, e.g. ['password','google.com']. */
export function currentAuthProviders(): string[] {
  return (auth.currentUser?.providerData ?? []).map((p) => p.providerId)
}

/**
 * Attach Google to the account that is ALREADY signed in.
 *
 * The deliberate route, for somebody who would rather connect it than
 * discover the collision. No password prompt: being signed in is the proof.
 */
export async function connectGoogleToCurrentAccount(): Promise<void> {
  const user = auth.currentUser
  if (!user) throw new Error('Sign in first.')

  // The same refusal as `completeGoogleLink`, for the same reason: on an
  // unverified address `linkWithPopup` is the call that takes the password
  // provider away. Refused before the popup opens, so nothing is attached and
  // nothing is detached.
  //
  // Reloaded first, because the cached `emailVerified` on this object is stale
  // for exactly the person this matters to — somebody who has just opened the
  // verification link and come back to press the button.
  //
  // A reload that FAILS is not an unverified address. It is an expired or
  // revoked session, and reporting it as "verify your email" would send them
  // after a message that is already in their inbox.
  let verified: boolean
  try {
    verified = await refreshEmailVerified()
  } catch {
    throw new Error(
      'Your session could not be checked with Firebase. Sign in again, then connect Google.',
    )
  }
  if (!verified) throw new Error(EMAIL_NOT_VERIFIED)

  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })

  let result
  try {
    result = await linkWithPopup(user, provider)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? ''
    if (code === 'auth/credential-already-in-use')
      throw new Error('That Google account is already connected to another Zipper account.')
    if (code === 'auth/provider-already-linked')
      throw new Error('Google is already connected to this account.')
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request')
      throw new Error('')
    if (code === 'auth/popup-blocked')
      throw new Error('Your browser blocked the Google window. Allow popups and try again.')
    throw new Error('Could not connect Google. Try again.')
  }

  // Refuse the observer address even here. An owner linking it would put the
  // CRM-only identity onto an account that CAN reach the Android app, and the
  // app's own observer guard reads the token email — so the two would disagree
  // about who this is.
  const linked = (result.user.email ?? '').toLowerCase()
  const googleEmail = result.user.providerData
    .find((p) => p.providerId === 'google.com')?.email?.toLowerCase() ?? linked
  if (isObserverAddress(googleEmail)) {
    // `unlink` is the standalone modular function, not a method on `User` —
    // `result.user.unlink(...)` compiles under the compat SDK and throws
    // TypeError under this one. That mattered more than a type error: the
    // throw below would still have said "cannot be connected" while the
    // provider stayed attached, so the guard would have reported success at
    // the exact thing it failed to do.
    //
    // A failure to detach is therefore NOT swallowed. Leaving the observer's
    // Google identity on a CRM account is the state this whole check exists
    // to prevent, and somebody has to be told it happened.
    try {
      await unlinkProvider(result.user, 'google.com')
    } catch {
      throw new Error(
        'That address is the observer account. It could not be disconnected ' +
        `automatically — write to ${SUPPORT_EMAIL} before signing in again.`,
      )
    }
    throw new Error('That address is the observer account and cannot be connected.')
  }
}

// ── Sign out ────────────────────────────────────────────────────────────────

export async function crmSignOut(): Promise<void> {
  await firebaseSignOut(auth)
}

// ── Get current CRM user profile ────────────────────────────────────────────

export async function getCrmUser(uid: string): Promise<CrmUser | null> {
  const snap = await getDoc(doc(db, 'crmUsers', uid))
  if (!snap.exists()) return null
  const raw  = snap.data() as CrmUser & { role: string }
  const role = normalizeCrmRole(raw.role)
  // Quietly migrate stale role in Firestore
  if (raw.role !== role) {
    await updateDoc(doc(db, 'crmUsers', uid), {
      role,
      dept: getDeptFromRole(role) ?? null,
    }).catch(() => {/* non-fatal */})
  }
  return { ...raw, role } as CrmUser
}

// ── Auth state change ────────────────────────────────────────────────────────

export function onCrmAuthChange(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb)
}

// ── Creating, changing and revoking staff lives in the API ───────────────────
//
// `createCrmUser`, `updateCrmUser` and `deleteCrmUser` used to sit here, and
// /team called all three. Each one wrote a Firestore `crmUsers` document and
// nothing else — which is one half of a staff account.
//
// The other half is a Mongo `staff` row. `sign_in_with_firebase`
// (backend/app/core/security.py) looks the person up there and raises "No
// account found. Contact your administrator." without it. So an account created
// from this file signed into the CRM shell, resolved its role, rendered every
// tab in the navigation, and then failed to exchange its Firebase token for an
// API session — leaving every API-backed screen reporting that it could not load
// data, while the Firestore-backed ones looked perfectly healthy. That is the
// bug, and it was not a navigation problem.
//
// All three now live behind the API, which holds the Firebase Admin SDK and
// writes **both** halves in one audited call:
//
//   invite       POST   /staff                  →  api.staff.invite
//   change role  PATCH  /staff/{uid}/role       →  api.staff.changeRole
//   revoke       POST   /staff/{uid}/deactivate →  api.staff.deactivate
//
// `deleteCrmUser` has no replacement on purpose. Deleting the record makes every
// audit entry that names the person unresolvable; the API deactivates instead,
// keeping the record so history stays attributable.
//
// The `verifiedIdentities` write that used to accompany a creation moved with
// it, to `backend/app/services/crm_directory.py`, so the Android app still
// auto-detects a new staff member.
//
// Nothing in the browser should create a staff account. If you are reaching for
// one of these, the function you want is in `lib/api.ts`.

// ── The person's own contact details ─────────────────────────────────────────
//
// Written straight to Firestore rather than through the API on purpose: this is
// the one write on a `crmUsers` document that its holder is entitled to make,
// the security rules already say so in one narrow allow-list clause, and routing
// it through an owner-only endpoint would mean nobody could change their own
// phone number without an owner in the room. That is exactly the friction
// /profile exists to remove.
//
// SALARY AND EMPLOYMENT ID ARE NOT HERE, AND NOT ON `CrmUser` EITHER.
//   `crmUsers` is readable by every member of staff — `allow read: if isStaff()
//   || isOwner(uid)` — so a salary stored on this document would publish every
//   person's pay to the whole team. Those fields live on the Mongo `staff` row,
//   are set by an owner through `PATCH /api/staff/{uid}/employment`, and are
//   read back by their holder alone through `GET /api/staff/me`.
//
// The object below is spelled out field by field rather than spread from a
// caller's patch. A spread would let a caller smuggle a sixth key in, the rules
// would refuse the whole write, and the person would be told their phone number
// could not be saved with no indication why.
export interface OwnContactDetails {
  displayName:   string
  phone:         string
  personalEmail: string
  address:       string
  photoUrl:      string
}

export async function updateOwnContactDetails(
  uid: string,
  details: OwnContactDetails,
): Promise<void> {
  await updateDoc(doc(db, 'crmUsers', uid), {
    displayName:   details.displayName.trim(),
    phone:         details.phone.trim(),
    personalEmail: details.personalEmail.trim().toLowerCase(),
    address:       details.address.trim(),
    photoUrl:      details.photoUrl.trim(),
  })
}

// P1-A3: the Owner "security gate" (three questions stored in plain text on
// crmUsers.gateAnswers and checked in the browser) was removed. Owners use
// server-enforced TOTP — see backend/app/services/owner_mfa.py.

// ── Send password reset email to a CRM team member ──────────────────────────

export async function sendCrmPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email)
}

// ── List all CRM users ───────────────────────────────────────────────────────
//
// A read, and only a read. The staff roster the team screens show now comes from
// `GET /staff`, which is scoped by the caller's role; this stays for anything
// that needs the raw Firestore collection, including agency and seller records,
// which never appear in `staff`.

// listCrmUsers — REMOVED (audit C-16): unused, and an unbounded read of every
// colleague's record. The team pages read `GET /staff` instead.

// ── Permission check ─────────────────────────────────────────────────────────

export function hasPermission(user: CrmUser | null, perm: Permission): boolean {
  if (!user) return false
  if (user.role === 'superadmin') return true
  return user.permissions.includes(perm)
}

export function canAccess(user: CrmUser | null, allowedRoles: CrmRole[]): boolean {
  if (!user) return false
  if (user.role === 'superadmin') return true
  return allowedRoles.includes(user.role)
}

// ── The login, created on its own and BEFORE anything is written ─────────────
//
// THIS IS THE ORDERING FIX. Every one of the four registration forms used to
// write its partner document first and create the Firebase Auth account second,
// so `auth/email-already-in-use` — the one failure that is guaranteed to happen
// on a retry — arrived AFTER the record was committed. Each retry therefore left
// an orphan: a seller or agency with no login, which nobody can sign in as, and
// which the Firestore trigger then dutifully gave a Mongo partner row of its
// own. Three of those exist in production for one address.
//
// `createUserWithEmailAndPassword` is an authoritative, server-side uniqueness
// test on the address, and when it refuses **nothing has been written
// anywhere**. Calling it first turns that failure from wreckage into a refusal.
//
// It writes no Firestore document on purpose: on the public forms the
// `crmUsers` create is bound by `partnerSelfRegistration()` to a partner record
// that already names the caller's verified email, so it cannot be written until
// that record exists. Splitting the two lets each form order them the way its
// own rules require.
export async function createPartnerLogin(params: {
  email: string
  password: string
  /** Which secondary Firebase app name to use, for readability in logs. */
  kind: 'agency' | 'seller'
  /** true = secondary app, so an admin's own session is not replaced. */
  adminMode?: boolean
}): Promise<string> {
  const emailLower = params.email.trim().toLowerCase()

  if (!params.adminMode) {
    const cred = await createUserWithEmailAndPassword(auth, emailLower, params.password)
    return cred.user.uid
  }

  const secondaryApp = initializeApp(firebaseConfig, `${params.kind}_${Date.now()}`)
  const secondaryAuth = getAuth(secondaryApp)
  connectEmulators({ auth: secondaryAuth })
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, emailLower, params.password)
    const uid = cred.user.uid
    await firebaseSignOut(secondaryAuth)
    return uid
  } finally {
    await deleteApp(secondaryApp)
  }
}

/**
 * RC — staff registration: the login, then the record, and the login removed
 * again if the record cannot be written (`lib/loginThenRecord.ts`).
 *
 * Same login as `createPartnerLogin({ adminMode: true })` — a secondary app, so
 * the staff member's own session survives — but the secondary session stays
 * signed in until `writeRecord` has finished: the new user can delete only
 * itself, so this is the one moment its removal is possible from a browser.
 * Throws the login's own error (address in use…) when no login was made, and
 * `RecordNotWritten` (with `loginRemoved`) when the record failed.
 */
/**
 * Audit C-17 / CRM-FLOW 2.1.3: the inviter never sets a partner's password.
 *
 * A random, unguessable initial password (192 bits from `crypto.getRandomValues`)
 * is used to create the login and then THROWN AWAY — nobody, the registering
 * staff member included, ever knows it. The partner sets their own through the
 * password-reset email sent right after the record is written.
 */
export function generateInitialPassword(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  // Firebase accepts any string ≥ 6 chars; 48 hex characters is well beyond
  // what the password-strength policy (if enabled) asks for, and it is never
  // typed by anyone.
  return `Z!${out}`
}

export async function createPartnerLoginThen<T>(
  params: { email: string; kind: 'agency' | 'seller' },
  writeRecord: (uid: string) => Promise<T>,
): Promise<{ uid: string; result: T; resetEmailSent: boolean }> {
  const emailLower = params.email.trim().toLowerCase()
  const secondaryApp = initializeApp(firebaseConfig, `${params.kind}_${Date.now()}`)
  const secondaryAuth = getAuth(secondaryApp)
  connectEmulators({ auth: secondaryAuth })
  let resetEmailSent = false
  const out = await runLoginThenRecord({
    createLogin: async () => {
      // C-17: generated here, used once, never shown and never stored.
      const cred = await createUserWithEmailAndPassword(secondaryAuth, emailLower, generateInitialPassword())
      return cred.user.uid
    },
    writeRecord: async (uid) => {
      const result = await writeRecord(uid)
      // The record exists, so the login stays. Hand the partner the means to
      // choose their own password. A failure here must NOT undo the
      // registration: the login page's "Forgot password" sends the same email.
      try {
        await sendPasswordResetEmail(secondaryAuth, emailLower)
        resetEmailSent = true
      } catch {
        resetEmailSent = false
      }
      return result
    },
    deleteLogin: async (uid) => {
      const user = secondaryAuth.currentUser
      if (!user || user.uid !== uid) throw new Error('The new login is no longer signed in, so it cannot be removed.')
      // The secondary session's own new user — the only account it may delete.
      await deleteUser(user)
    },
    finish: async () => {
      try {
        if (secondaryAuth.currentUser) await firebaseSignOut(secondaryAuth)
      } finally {
        await deleteApp(secondaryApp)
      }
    },
  })
  return { ...out, resetEmailSent }
}

// ── The same login, created by Google instead of by a password ───────────────
//
// The other way a partner's canonical account comes into existence. Same
// contract as `createPartnerLogin` above — prove the address, hand back a uid,
// write nothing to Firestore — with the one difference that matters: there is
// no password and there never will be one. The Google identity IS the account
// from birth, so the "connect Google to the password account you already have"
// step /login runs is not part of this flow and is deliberately unreachable
// from it.
//
// ── WHY AN EXISTING ACCOUNT IS REFUSED RATHER THAN ADOPTED ──────────────────
//
// An address that already has a Zipper account is turned away and sent to
// /login. Adopting it is the tempting alternative and it is the blind email
// merge the Google section above exists to refuse: "this Gmail spells the same
// as that account" is not proof that whoever holds the Gmail owns the account.
// `auth/account-exists-with-different-credential` is Firebase telling us the
// address belongs to a password account, and the only thing that may attach
// Google to that account is its own password — which is /login's job, through
// `completeGoogleLink`, and not a registration form's.
//
// Nothing here is looked up by address. The uid returned is whatever Firebase
// gives for the identity that was just proven in the popup, and it is the uid
// the application is then filed against.
export type PartnerGoogleSignUp =
  /** Signed in on a Google-backed login that holds no CRM account. File against `uid`. */
  | { kind: 'ready'; uid: string; email: string }
  /** The address already has an account. Nothing was created; /login is the way in. */
  | { kind: 'account-exists'; email: string }
  /** Not allowed here, or abandoned. `message` is safe to show; blank means say nothing. */
  | { kind: 'refused'; message: string }

export async function partnerSignUpWithGoogle(): Promise<PartnerGoogleSignUp> {
  // Read BEFORE the popup, because afterwards it is the popup's own user.
  //
  // An applicant whose first attempt created the account and then failed —
  // a dropped connection on the Firestore write, a reloaded tab — comes back
  // signed in as that same account, and Firebase reports it as an EXISTING
  // user on the retry. Refusing on "existing" alone would dead-end them on
  // their own half-finished signup, which is precisely the failure the
  // login-first ordering above was written to stop. The same uid as the
  // session already in this browser is a resumption, not somebody else's
  // account, and it is the only "existing" this function accepts.
  const resumedUid = auth.currentUser?.uid ?? ''

  const provider = new GoogleAuthProvider()
  // Always ask which account, exactly as /login does. Without it a shared
  // machine registers the business against whoever Google saw last.
  provider.setCustomParameters({ prompt: 'select_account' })

  let cred
  try {
    cred = await signInWithPopup(auth, provider)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? ''

    if (code === 'auth/account-exists-with-different-credential') {
      // Firebase is what says the address is taken here, not a comparison of
      // strings. The credential it hands back is dropped on purpose: the only
      // thing it is good for is linking, and linking is a decision made at
      // /login against the existing account's password.
      const claimed = String(
        (err as { customData?: { email?: string } })?.customData?.email ?? '',
      ).toLowerCase()
      if (isObserverAddress(claimed)) {
        return {
          kind: 'refused',
          message: 'The observer account signs in with a one-time code, not Google.',
        }
      }
      return { kind: 'account-exists', email: claimed }
    }

    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return { kind: 'refused', message: '' }   // they changed their mind
    }
    if (code === 'auth/popup-blocked') {
      return {
        kind: 'refused',
        message: 'Your browser blocked the Google window. Allow popups and try again.',
      }
    }
    return { kind: 'refused', message: 'Google sign-in failed. Try again.' }
  }

  const isNew = getAdditionalUserInfo(cred)?.isNewUser === true
  const email = (cred.user.email ?? '').toLowerCase()

  // ── The observer never gains a Firebase account, and this is the one door
  // that would cheerfully create one ──────────────────────────────────────
  if (isObserverAddress(email)) {
    await discardGoogleAccount(cred.user, isNew)
    return {
      kind: 'refused',
      message: 'The observer account signs in with a one-time code, not Google.',
    }
  }

  // Google is not obliged to release an address. Both writes this login exists
  // to make are bound to `request.auth.token.email` in firestore.rules, so an
  // account without one could file the partner record and then be denied its
  // own `crmUsers` document — an orphan, by the exact mechanism the forms were
  // rewritten to stop.
  if (!email) {
    await discardGoogleAccount(cred.user, isNew)
    return {
      kind: 'refused',
      message:
        'That Google account did not share an email address, so it cannot be ' +
        'used to register. Sign up with an email and password instead.',
    }
  }

  // Not new, and not this browser's own unfinished attempt: an account that
  // existed before today. Signed out rather than deleted — this flow did not
  // create it, so it is not this flow's to remove.
  if (!isNew && cred.user.uid !== resumedUid) {
    await discardGoogleAccount(cred.user, false)
    return { kind: 'account-exists', email }
  }

  // A resumed login that got as far as its `crmUsers` document last time is
  // already a Zipper account. `partnerSelfRegistration()` in firestore.rules
  // refuses a second document on the same uid, so saying so now is worth more
  // than letting the last step of the form fail with a permission error.
  const snap = await getDoc(doc(db, 'crmUsers', cred.user.uid))
  if (snap.exists()) {
    await discardGoogleAccount(cred.user, false)
    return { kind: 'account-exists', email }
  }

  return { kind: 'ready', uid: cred.user.uid, email }
}

// ── Undo a login this browser just created ───────────────────────────────────
//
// Only ever used on the public forms, and only for an account created moments
// earlier in the same submit: the address turned out to already hold a partner
// record, so the application is refused and the login that was made to run that
// check has to go with it. It holds nothing — no `crmUsers` document, no partner
// record — and leaving it behind would block the real owner from ever
// registering that address.
//
// The same undo covers an applicant backing out of `partnerSignUpWithGoogle`
// to set a password instead: that account is equally empty, and leaving it
// would make their own address read as taken to the route they just switched
// to.
//
// Bound to the signed-in user, because `deleteUser` can only ever act on the
// caller's own account. Throws if the session is not the one named, so a caller
// cannot delete something it did not create.
export async function discardPartnerLogin(uid: string): Promise<void> {
  const current = auth.currentUser
  if (!current || current.uid !== uid) {
    throw new Error(
      'That login is not the one signed in here, so it cannot be removed from this browser.',
    )
  }
  await deleteUser(current)
}

// ── Agency self-signup — creates Firebase Auth + CrmUser from public form ─────
// Called from /agency-signup page (NO admin session — agency fills this themselves).
// Set adminMode: true when called from admin panel to preserve the admin's session.
//
// Pass `uid` when the login was already created by `createPartnerLogin` above —
// which every caller now does — and this writes only the `crmUsers` document.
// `password` is then unused and may be omitted.
export async function createAgencyAccount(params: {
  email: string
  password?: string
  name: string
  phone: string
  agencyId: string
  adminMode?: boolean   // true = use secondary app (preserves superadmin session)
  /** A login created earlier by createPartnerLogin. Skips account creation. */
  uid?: string
}): Promise<string> {
  const emailLower = params.email.trim().toLowerCase()

  let uid: string
  if (params.uid) {
    uid = params.uid
  } else {
    if (!params.password) {
      throw new Error('A password is required when no existing login is supplied.')
    }
    uid = await createPartnerLogin({
      email: emailLower,
      password: params.password,
      kind: 'agency',
      adminMode: params.adminMode,
    })
  }

  await setDoc(doc(db, 'crmUsers', uid), {
    uid,
    email:       emailLower,
    name:        params.name.trim(),
    phone:       params.phone.trim(),
    role:        'agency' as CrmRole,
    permissions: DEFAULT_PERMISSIONS['agency'],
    agencyId:    params.agencyId,
    isActive:    true,
    status:      'pending',   // always pending until superadmin manually approves
    createdBy:   params.adminMode ? 'crm_admin' : 'self_signup',
    createdAt:   serverTimestamp(),
    lastLoginAt: null,
  })
  return uid
}

// Phase 1A: a direct `crmUsers.status` write was removed here. Partner
// approval is a backend operation (POST /api/partner-ops/partners/{id}/approve).

// ── Coin seller self-signup — creates Firebase Auth + CrmUser from public form ──
// Called from /seller-signup page (NO admin session — seller fills this themselves).
// Set adminMode: true when called from admin panel to preserve the admin's session.
//
// Pass `uid` when the login was already created by `createPartnerLogin` — which
// every caller now does — and this writes only the `crmUsers` document and the
// back-link. `password` is then unused and may be omitted.
//
// `linkPartnerDoc: false` skips the `crmUid` write onto `sellers/{sellerId}`,
// for callers that write it themselves in a specific order.
export async function createSellerAccount(params: {
  email: string
  password?: string
  name: string
  phone: string
  sellerId: string
  adminMode?: boolean   // true = use secondary app (preserves superadmin session)
  /** A login created earlier by createPartnerLogin. Skips account creation. */
  uid?: string
  /** Write crmUid back onto the seller document. Default true. */
  linkPartnerDoc?: boolean
}): Promise<string> {
  const emailLower = params.email.trim().toLowerCase()

  let uid: string
  if (params.uid) {
    uid = params.uid
  } else {
    if (!params.password) {
      throw new Error('A password is required when no existing login is supplied.')
    }
    uid = await createPartnerLogin({
      email: emailLower,
      password: params.password,
      kind: 'seller',
      adminMode: params.adminMode,
    })
  }

  await setDoc(doc(db, 'crmUsers', uid), {
    uid,
    email:       emailLower,
    name:        params.name.trim(),
    phone:       params.phone.trim(),
    role:        'seller' as CrmRole,
    permissions: DEFAULT_PERMISSIONS['seller'],
    sellerId:    params.sellerId,
    isActive:    true,
    status:      'pending',   // always pending until superadmin manually approves
    createdBy:   params.adminMode ? 'crm_admin' : 'self_signup',
    createdAt:   serverTimestamp(),
    lastLoginAt: null,
  })
  // Link crmUid back on the sellers doc so Firestore rules can match.
  // Skipped when the caller writes the link itself — see `linkPartnerDoc`.
  if (params.linkPartnerDoc !== false) {
    await updateDoc(doc(db, 'sellers', params.sellerId), { crmUid: uid })
  }
  return uid
}

// Phase 1A: a direct `crmUsers.status` write was removed here. Partner
// approval is a backend operation (POST /api/partner-ops/partners/{id}/approve).

// ── Create sub-agency CRM account from an agency user's session ───────────────
//
// Unlike createAgencyAccount(adminMode: true) — which writes crmUsers via the
// primary DB (blocked for agency-role users by Firestore rules) — this function
// uses a secondary Firebase app for BOTH Auth and Firestore. The new sub-agency
// owner's auth token satisfies the "allow create if auth.uid == uid" rule.
//
// ── GOV B07: AND IT LEAVES THE RECORD WITH ITS OWNER ─────────────────────────
//
// The sub-agency record used to end this flow naming nobody: the parent's
// login may put only its OWN uid on a record it creates (`partnerCreateSafe`
// in firestore.rules), the new login did not exist yet when the record was
// written, and nothing wrote `crmUid` afterwards. So the API's per-person
// rules — one agency-family record per human, Host + Agency refused — could
// not see who held it, and the same human could be approved for a second
// agency or a Host role beside it.
//
// The new login now writes its own `crmUid` back-link, once, with its own
// token, straight after its `crmUsers` document — the narrow arm in the
// `agencies` update rule bound exactly like that document's create. There is
// no backend endpoint an agency login may call to create a sub-agency (attach-
// login is a team-admin route), so the link is written here at creation time.
//
// `linked: false` means the record and the login BOTH exist and only the link
// was refused. That is not a failure to retry — a retry would refuse on the
// address — and the caller says so instead.
//
// ── FX-03: THE LOGIN COMES FIRST ─────────────────────────────────────────────
//
// This used to be called AFTER the dashboard had written the `agencies`
// record, so `auth/email-already-in-use` (the failure a retry is guaranteed to
// hit) arrived after the record was committed: every failed attempt left a
// pending sub-agency nobody owned, which the registration trigger gave a Mongo
// record of its own, and every retry added another. Now the caller passes the
// record write in as `writeRecord`, and `runSubAgencyCreation`
// (lib/subAgencyCreation.ts, with its spec) runs: login → record (the login is
// deleted again if the record write fails) → the login's own crmUsers
// document → the back-link. The crmUsers create is bound by the rules to a
// record that already names the address (`agencyNamesCaller`), which is why it
// still comes after the record.
export interface SubAgencyAccount {
  uid: string
  /** The `agencies` document id the caller's `writeRecord` returned. */
  agencyId: string
  /** True once `agencies/{agencyId}.crmUid` names this login. */
  linked: boolean
  /** True once the login's own `crmUsers` document exists. */
  loginDocWritten: boolean
}

export async function createSubAgencyAccount(params: {
  email: string
  password: string
  name: string
  phone: string
  /**
   * Writes the `agencies` record with the CALLER's (the parent agency's)
   * session and returns its id. Called only once the login exists.
   */
  writeRecord: () => Promise<string>
}): Promise<SubAgencyAccount> {
  const emailLower = params.email.trim().toLowerCase()

  const secondaryApp = initializeApp(firebaseConfig, `subagency_${Date.now()}`)
  const secondaryAuth = getAuth(secondaryApp)
  const secondaryDb = getFirestore(secondaryApp)
  connectEmulators({ auth: secondaryAuth, db: secondaryDb })

  return runSubAgencyCreation({
    createLogin: async () => {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, emailLower, params.password)
      return cred.user.uid
    },
    writeRecord: params.writeRecord,
    deleteLogin: async () => {
      // The new login is the secondary session's own user; deleting it frees
      // the address, so the retry the user will make is not refused on it.
      if (secondaryAuth.currentUser) await deleteUser(secondaryAuth.currentUser)
    },
    writeLoginDoc: async (uid, agencyId) => {
      // Written with the new user's own token — satisfies Firestore rules.
      await setDoc(doc(secondaryDb, 'crmUsers', uid), {
        uid,
        email:       emailLower,
        name:        params.name.trim(),
        phone:       params.phone.trim(),
        role:        'agency' as CrmRole,
        permissions: DEFAULT_PERMISSIONS['agency'],
        agencyId,
        isActive:    true,
        status:      'pending',
        createdBy:   'agency_created',
        createdAt:   serverTimestamp(),
        lastLoginAt: null,
      })
    },
    writeBackLink: async (uid, agencyId) => {
      // GOV B07: the owner link, written by the login it names.
      await updateDoc(doc(secondaryDb, 'agencies', agencyId), { crmUid: uid })
    },
    finish: async () => {
      try {
        await firebaseSignOut(secondaryAuth)
      } finally {
        await deleteApp(secondaryApp)
      }
    },
  })
}
