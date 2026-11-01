# ZIPPER — Phase 1 audit: team governance and all roles (2026-10-23)

Read-only discovery. Branch `v5-scratch`, HEAD `1194e55`, 464 uncommitted/untracked paths — all preserved. Nothing was committed, pushed, deployed, migrated, or written to any database or Firebase project. No secrets or real account data appear below.

**How to read this report.** Every finding is marked:
- **Verified**: I read the code path, file and line given.
- **Suspected**: inferred from code, not traced end to end.
- **Unverified**: needs a runtime or emulator I could not safely use.

**Scope and depth.** Team/staff governance and Owner/Observer were traced end to end in the source for this report. The partner (agency, sub-agency, coin seller), host and normal-user rows rely on two things:
1. The earlier inventories (`outputs/inventory/*.md`, built from source in the B3 phase).
2. Fresh spot checks of the key enforcement points, listed with each row.

They are marked accordingly. Money flows are out of scope.

> Process note: the parallel discovery agents planned for this phase failed (usage limit, plus the Mac going to sleep). This report was produced directly from source. That is why the partner, host and user sections are narrower than the staff section.

---

## 1. Repository and subsystem inventory

| Folder / file | Implements | Entry points |
|---|---|---|
| `backend/` | FastAPI business core (Python): the authority for staff, partners, money cards, audit and reports | `app/main.py` mounts 18 routers, 228 routes. `app/core/{roles,deps,security,account_state,audit}.py`, `app/services/*`, `app/db/{mongo,firebase}.py` |
| `zipper-crm/` | Next.js CRM (static export, hosted on the `zipperlive` site, with `/api/**` rewritten to Cloud Run `zipper-api`) | 89 `app/**/page.tsx`, `lib/*.ts` (API clients, auth, Firestore helpers), `components/AuthProvider.tsx` |
| `functions/` | Firebase Cloud Functions (TypeScript): app callables, Firestore triggers, schedulers | `src/index.ts` plus 30 modules (accounts, calls, hosts, identity, mobileSession, roster, social, storageClaims, wallet …). 11 trigger documents and ~16 schedules |
| `zipper-app/` | Android app (Kotlin/Compose, Hilt) | `navigation/ZipperNavGraph.kt`, `data/repository/*`, `data/work/*` + `data/api/*` (the B3 work layer), `ui/screens/*` |
| `firestore.rules`, `storage.rules`, `firestore.indexes.json` | Client-side authority for every browser and app Firestore/Storage access | role helpers `firestore.rules:35-270` |
| `tests/` (root) | Firestore and Storage rules tests (emulator) | `package.json` scripts call `firebase emulators:exec` |
| `backend/scripts/` | Seeding, repair, migration, reset and diagnostics | `seed_accounts.py` (Observer and initial owners), `repair_staff_accounts.py`, `repair_app_role_flags.py`, `reset_*`, `backfill_*` |
| `hosting/` | Static sites, e.g. `applinks` for `assetlinks.json` | `firebase.json` targets `production`, `applinks` |
| Root `*.md`, `docs/` | Design and spec documents: BACKEND-DESIGN, CRM-FLOW, APP-CRM-MISMATCH, ZIPPER_MASTER_ROADMAP … | n/a |

**Data stores**
- **Mongo** (authority): `staff`, `sessions`, `partners`, `cards`, `audit`, `ledger`/`balances`, `money_freezes`, `partner_role_claims`, and others.
- **Firestore**: `crmUsers`, `users`, `publicProfiles`, `agencies` (+ `agencyHosts`), `sellers`, `hostApplications`, `feedbackTickets`, `supportTickets`, `techTickets`, `opsTickets`, `approvalRequests`, `appeals`, `reports`, `liveRooms`, config docs, and others.
- **Firebase Auth**: one uid per human. Custom claims carry `role`/`aid` (`storage_claims.py`, the `syncStorageRoleClaim` trigger).

**Notifications**
- Backend email: `services/email.py`, including `send_staff_invitation` and `send_staff_access_added`.
- Push: functions (`push.ts`).
- In-app: `notifications`, `broadcasts`.

**Tests**
- 82 backend test modules: all **82/82 pass** when run here. The 19 governance-related modules were re-run for this report and all pass.
- 19 CRM spec suites (passed in B1).
- Android: **305 JVM tests pass and `assembleDebug` succeeded on the Mac**. Evidence: `outputs/verify/work-verify-20261023-035839.log`, `gradle exit: 0`; test-result XML shows 0 failures.
- Root Firestore/Storage rules tests: **not run** (they need the emulator; the scripts use the `zipper-83816` project id, emulator-only).

---

## 2. Canonical role model and identity relationships

**Roles in code.**
- Backend `Role` (`backend/app/core/roles.py:21-41`): `observer`, `owner`, `{app,ops,finance,tech,support,marketing}_{admin,member}`, `agency`, `seller`.
- Machine label: `system` (not a role).
- Partner record kinds: `agency`, `sub_agency`, `seller`.
- Teams (`roles.py:12-18`): `app`, `ops`, `finance`, `tech`, `support`, `marketing`.

**CRM spellings.** `superadmin` = owner. `crm_directory.CRM_ROLE` at `crm_directory.py:68-82`. The Observer is deliberately absent: `NOT_MIRRORED`, `:87-101`.

**Legacy role strings still honoured by Firestore rules:** `admin`, `app`, `ops`, `tech`, `finance`, `support` (`firestore.rules:216-243`). The CRM `LEGACY_ROLE_MAP` maps them. The backend cannot create them.

**Status values**
- Staff: `is_active` true/false only.
- Partner: `pending`, `awaiting_verification`, `approved`, `rejected`, `suspended`, `revoked`.
- Host: `active` / `revoked` / `pending`, plus `isVerifiedHost`.
- App account: `accountState` active / suspended / banned / deletion states, plus `isBanned`, `isSuspended`, `accountRestricted`, `payoutHold`.

**Where each identity lives (canonical source in bold)**

| Role | Authority record | Mirrors | Sign-in |
|---|---|---|---|
| Owner, department admin/member | **Mongo `staff` row** (uid, role, team, is_active) | `crmUsers/{uid}`: role, permissions, isActive, read by rules and the CRM shell. Storage claim `role`. `users/{uid}.crmRole/isOfficial` (app badge, via `syncMyRoles`) | Firebase email/password or Google → `POST /api/auth/signin` (`security.py:692-761`) |
| Observer | **Mongo `staff` row** with synthetic uid `observer:<email>` | none, on purpose | Emailed one-time code only (`/api/auth/observer/*`). A Firebase-token Observer session is refused (`security.py:725-732`) |
| Agency / sub-agency / coin seller | **Mongo `partners`** (status, `owner_crm_uid`) | Firestore `agencies`/`sellers` doc, `crmUsers/{uid}` (agencyId/sellerId/roles/roleStatus), `users/{uid}` flags (isAgent, isSeller, ownAgencyId), Storage claim | Firebase → `/api/auth/signin` → partner session with `partner_ids` (`security.py:767-779`, `:1002-`) |
| Host | Firestore `users/{uid}.isHost` + `hostApplications` + roster `agencies/{id}/agencyHosts/{uid}`; verification in `hostVerification` | — | App (Firebase phone/Google) |
| Normal user | Firestore `users/{uid}` + Firebase Auth | `publicProfiles/{uid}` | App |

**Account-state gate on every API call:** `account_state.assert_may_act` (`account_state.py:255-345`). It checks:
- staff: the row exists and is active;
- partners: every partner id on the session is still good;
- then everyone: whether the app account is suspended or banned.

The result is cached per session for `auth_state_recheck_seconds`.

---

## 3. Team and department lifecycle, end to end (verified)

| Step | Source of truth / what is written | Who may (server) | UI | Audit / notice | Evidence |
|---|---|---|---|---|---|
| Departments | `Team` enum. Team derived from role (`team_of`). The CRM `DEPT_NAMES` agree | — | — | — | `roles.py:12-18`; `zipper-crm/lib/auth.ts:105` |
| Invite admin/member | Mongo row, then `crmUsers` mirror, then Storage claim, then email (set-password link for a new account, "access added" for an existing one) | `POST /api/staff`: `require_team_admin` + `can_manage_team`, narrowed by `assignable_roles` (owner → any department role; department admin → own-team **members** only; observer → owner only) | CRM `/team`, `/team-access`; Android Work "Team" (unverified at runtime) | `staff.created`; `staff.mirror_failed` on a half-write; email | `services/staff.py:308-580`, `routers/staff.py:115-140`; tests `test_staff_hierarchy`, `test_staff_directory` |
| Provision owner | Same `invite`, actor = Observer | `POST /api/staff/owners`: Observer only | Observer console only | `staff.created`, with a required reason | `staff.py:170-186`, `routers/staff.py:158-196`; `test_observer_owner` |
| Identity on invite | **Reuses an existing Firebase account with the same email** (intended: "one person, one uid"). Refused if that uid holds a partner role or is a host | — | — | — | `staff.py:389-414` |
| Role change / transfer | Mongo role + team. Sessions revoked. `crmUsers` re-mirrored. Claim updated. `reports_to` left alone | `PATCH /api/staff/{uid}/role`: `can_manage_team` route gate; the service says **owner only**, never self, never to or from owner/observer, department roles only | CRM `/team`; Android | `staff.role_changed` (reason required). **No email to the person** | `staff.py:805-923` |
| Employment fields | Mongo only (salary is never mirrored) | Owner (all fields), or a department admin for their own members (not pay) | CRM `/team` | `staff.employment_changed` | `staff.py:688-802` |
| Visibility of the staff list | Owner/Observer: everyone. Department admin: own-team members. Everyone else: self. Pay stripped except own row or owner | `GET /api/staff` | — | — | `staff.py:583-636` |
| Deactivate | Sessions revoked, Mongo `is_active=false`, **Firebase account disabled**, `crmUsers.isActive=false`, Storage claim cleared | `POST /api/staff/{uid}/deactivate`: `can_manage_team` + `manages()` (an owner manages non-owners; a department admin manages own-team members; owners are managed only by the Observer; never the last active owner; never the Observer; never self) | CRM `/team`, `/team-access`; Android | `staff.deactivated`, `staff.firebase_revoke_failed`. **No email** | `staff.py:926-1055`; `test_staff_revocation` |
| **Reactivate** | **Does not exist**: no route, no CRM button, no script. Re-inviting fails ("An account already exists") | — | — | — | `routers/staff.py` (10 routes, none re-enable); `staff.py:354-371` |
| Suspend (temporary) | **No such state for staff** | — | — | — | — |
| Password reset | Firebase `sendPasswordResetEmail` from the CRM login "Forgot password" (client-side). No server path. Not in Android | anyone with the email | CRM `/login` | none | `zipper-crm/app/login/page.tsx:70-83`, `lib/auth.ts` `sendCrmPasswordReset` |
| Department data visibility | Audit: owner/Observer all, admin own team, others self. Reports: `_scoped_team`. Cards: `board_for`. **Firestore:** role-name helpers (not the permission table) | API; Firestore rules | — | — | `routers/audit.py`; `firestore.rules:207-270` |
| Team tickets | `techTickets` are **browser writes only** (create, move status, reassign). Support routing also writes there | rules: read/create/update = `isCrmUser()` | CRM `/tech/tickets`, `/tickets`; Android "Team tickets" (create/move) | **No server audit, no notification** | `firestore.rules:2464-2468`; `zipper-crm/lib/tech.ts:143-156`; no trigger in `functions/src` |
| Feedback / support tickets | Browser updates (assign, status, response). Actor name is client-supplied | rules: `isOps() \|\| isAdmin() \|\| isSupport()` | CRM `/feedback`, `/tickets`; Android | none server-side | `firestore.rules:2968-2980` |

---

## 4. Role-by-capability matrix

R = read, W = write/decide. The server gate is the dependency or service check that actually enforces it.

| Capability | Owner | Observer | Dept admin | Dept member | Agency / Sub | Coin seller | Host | Normal user | Server gate (evidence) |
|---|---|---|---|---|---|---|---|---|---|
| Sign in to API | ✓ | OTP only | ✓ | ✓ | ✓ (partner session) | ✓ | ✗ ("No account found") | ✗ | `security.py:692-779` |
| Invite staff | department roles | owners only | own-team members | ✗ | ✗ | ✗ | ✗ | ✗ | `assignable_roles` `staff.py:139-192` |
| Change staff role | ✓ (not owner/observer/self) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `staff.py:812-833` |
| Deactivate staff | non-owners | owners (not the last) | own-team members | ✗ | ✗ | ✗ | ✗ | ✗ | `manages()` `staff.py:65-136` |
| Reactivate staff | **nobody** | **nobody** | **nobody** | — | — | — | — | — | missing |
| Read all audit | ✓ | ✓ | own team | own | ✗ | ✗ | ✗ | ✗ | `routers/audit.py` |
| Money signing | ✓ (separation of duties) | ✗ | verify only (own team; finance admin: all) | ✗ | ✗ | ✗ | ✗ | ✗ | `roles.can_sign_money`, `can_verify_money` |
| Partner approve/reject | ✓ | ✗ | ops admin (`can_approve_kyc` / `can_approve_seller`) | ✗ | ✗ | ✗ | ✗ | ✗ | `_APPROVE_PARTNER` (partner_ops router) |
| Own partner records / statements | R (any id) | R | R (view permissions) | R | **own ids only** | **own ids only** | ✗ | ✗ | `own_partner_id_or_403`, `PARTNER_REACHABLE` (`deps.py:92-`) |
| Team tickets (Firestore) | RW | ✗ (no Firebase) | RW | RW | **RW (rules allow)** | **RW (rules allow)** | ✗ | ✗ | `firestore.rules:2464-2468` |
| Read every staff contact (`crmUsers`) | ✓ | ✗ | ✓ | ✓ | own doc only | own doc only | ✗ | ✗ | `firestore.rules:927` |
| App wallet, profile, own data | own | — | own (if same uid) | own | own | own | own | own | `users/{uid}` rules, `ownerProtectedFields` `firestore.rules:~1840-1900` |

**Partner, host and user rows (verified spot checks plus earlier inventory):**
- **Role families and staff exclusion:** `partner_applications.eligible_kinds` (`:526-540`) gives internal accounts no partner role. The role-family lock is in `partner_roles`. Every approval, activation and restore re-checks it (`partner_ops._enforce_role_rules_at_decision`, `:3099-3139`).
- **Partner session limits:** a partner session reaches only the 26 `PARTNER_REACHABLE` routes, scoped to its own ids.
- **Normal users** cannot write role, moderation or money fields on `users/{uid}` (`ownerProtectedFields`).

---

## 5. CRM ↔ backend ↔ Android parity (team and role workflows)

| Workflow | Classification | Notes |
|---|---|---|
| Invite staff | backend ✓, CRM ✓; Android implemented, **unverified** (needs the `/me` deploy and a non-production API) | Android "Team → Invite" calls the same route |
| Change role | backend ✓, CRM ✓; Android implemented, unverified | |
| Employment details | backend ✓, CRM ✓; Android: no salary fields (deliberately) | |
| Deactivate | backend ✓, CRM ✓; Android implemented, unverified | **Side effect on the app account: see D1** |
| Reactivate | **missing entirely** | D2 |
| Owner provisioning / removal | backend ✓, Observer console ✓; Android **intentionally absent** (Observer has no Firebase login) | |
| Password reset | CRM only (client-side Firebase); **missing on Android**; no server path | |
| Owner security gate | **UI only; missing on the backend** | D3 |
| Team tickets | CRM ✓ (browser writes); Android create/move implemented, unverified; **no server audit or notification anywhere** | D5 |
| Ticket assignment / escalation | CRM only (assign, route, escalate); Android missing | |
| Staff who use a phone-only app account | **blocked by identity mismatch**: the API resolves staff by Firebase uid/email, so a phone-OTP app login is a different uid → "No work account" on Android | D6 |
| Partner portals (statements, hosts, sales, recharges) | backend ✓, CRM ✓, Android implemented (B3), compile/unit-verified, runtime **unverified** | |
| Observer read-only | backend ✓ (`require_write` refuses), CRM ✓ (ObserverShell); Android n/a | |

---

## 6. Authorization and account-provisioning findings

### Confirmed defects

**D1 — Removing a staff member also disables their Zipper app account (High, operational and user-visible).**
- **What happens:**
  - `invite` deliberately reuses an existing Firebase account with the same email (`staff.py:389-414`; the comment notes most staff are already app users).
  - `deactivate` disables that Firebase uid (`staff.py:987`, `firebase.set_user_disabled(uid, True)`).
  - So revoking someone's staff access also locks them out of the consumer app, including any diamonds, beans or host earnings on that uid.
  - And no re-enable path exists (D2).
- **Tests:** `test_staff_revocation` asserts the disable; no test covers the app-account effect.
- **Fix (needs decision Q1):** either keep the Firebase account enabled and rely on the Mongo/`crmUsers`/claim revocation, or disable only accounts created for staff use.

**D2 — No way to reactivate staff, including owners (High, operational).**
- **What happens:**
  - Deactivation sets `is_active=false`, disables Firebase, clears `crmUsers.isActive` and the claim.
  - No route, CRM control or script reverses this.
  - Re-inviting is refused because the row still exists (`staff.py:354-371`).
  - A mistaken revocation of a staff member or owner cannot be undone without hand-editing the database.
- **Fix (Q2):** add `POST /api/staff/{uid}/reactivate`, with the same `manages()` authority as deactivate, a required reason and an audit entry. It would re-enable Firebase, re-mirror, re-grant the claim and send a notice.

**D3 — The Owner "three-question" gate is browser-only, and its answers are readable by all staff (High, security).**
- **How the gate works:** it runs in `zipper-crm/app/login/page.tsx:322-349` and compares against `crmUsers.gateAnswers`, which are stored as normalised plaintext. Q2 is a phone number (`lib/auth.ts:1093-1101`).
- **Problem 1 — answers are exposed:** `crmUsers` is readable by **every** staff member (`firestore.rules:927`), so the answers are disclosed to the whole team.
- **Problem 2 — the API does not check it:** an API session is minted on Firebase sign-in (`components/AuthProvider.tsx:497`; `security.py:692-761` has no gate check). An owner's password alone therefore gives a full owner API session; the gate only hides CRM screens.
- **Fix (Q3):** decide whether the gate is a real second factor. If yes, verify it server-side (hashed, in Mongo) before issuing an owner session, or replace it with a proper factor (TOTP or passkey). In either case, move the answers out of `crmUsers`.

**D4 — Partners can read and edit internal team tickets (Medium-High, privacy).**
- **What happens:**
  - `techTickets` read/create/update is `isCrmUser()`, which is true for agency and seller logins (`firestore.rules:35-40`, `:2464-2468`).
  - The rule's own comment says "any CRM staff member".
  - Support routing copies app users' ticket text into `techTickets` (`zipper-crm/lib/firestore.ts:935-952`), so a partner can read other users' support messages by querying Firestore directly. The partner UI never shows them.
- **Tests:** no rules test covers `techTickets`.
- **Fix:** change the rule to `isStaff()` and add a rules test.

**D5 — Team, feedback and support ticket work leaves no server audit and sends no handoff notice (Medium, operational).**
- **What happens:**
  - All ticket mutations are browser Firestore writes.
  - `statusChangedByName` and `assignedToName` are typed by the client.
  - No Cloud Function trigger exists for any ticket collection (`functions/src` triggers: agencies, approvalRequests, calls, conversations, crmUsers, hostApplications, liveRooms, rechargeRequests, sellers, users, weeklyPayoutReports).
- **Consequence:** assignments and escalations are silent, and "who changed what" relies on client-supplied names.
- **Fix (Q7):** move ticket mutations to API routes with audit entries, or add a trigger that audits and notifies.

**D6 — Firestore authority does not follow the permission table (Medium, security consistency).**
- **What happens:**
  - The rules decide by role name (`isAdmin()` = any `*_admin`, `firestore.rules:216-218`).
  - The API decides by `roles.PERMISSIONS`.
  - The permission tables themselves agree across backend, CRM and the mirror (checked programmatically for this report).
  - But Firestore lets, for example, tech or marketing admins update `agencies`, `sellers`, `hostApplications` and `broadcasts`, and tech roles write `appConfig/economy` (earlier inventory, rules lines listed there). The API would refuse them.
- **Fix (Q5):** align each rule with the corresponding permission.

### Suspected defects / risks

- **S1 — staff/partner exclusion lists differ.** `staff._PARTNER_HELD` (`staff.py:284`) excludes `revoked` and `awaiting_verification`, although its comment says it mirrors `partner_applications.HELD_STATUSES` (`:86-93`, which includes them). So a person with an awaiting or revoked partner record can be invited as staff. Starting or restoring that role is then refused (internal accounts hold no partner role), leaving a stuck record. *Low.*
- **S2 — legacy role strings are still honoured by Firestore rules** (`admin`, `ops`, …). The backend cannot create them, but an old `crmUsers` document carrying one would hold Firestore powers with no Mongo row. A `repair_staff_accounts`-style survey is recommended. *Low.*
- **S3 — every staff member can read every colleague's contact details** in `crmUsers` (phone, personal email; `firestore.rules:927`). This is documented as intentional ("staff read the team list"); confirm with Q8.
- **S4 — password reset for a deactivated (disabled) account:** Firebase behaviour not verified here. *Unverified.*

### Verified as working as designed (no change proposed)
- Only the Observer provisions or deactivates owners.
- The last active owner cannot be deactivated.
- Owners cannot change their own role or another owner's.
- The Observer cannot be invited, re-roled or deactivated.
- An Observer session cannot be obtained from a Firebase token.
- The Observer has no `crmUsers` document and no mobile path.
- `require_permission` refuses the Observer and partners even on GET routes.
- Staff can never hold partner roles: refused at invite, and at every partner approval and activation.
- `crmUsers` role, permission and isActive fields cannot be changed from a browser (`firestore.rules:1025-1032`).
- `users/{uid}` role, moderation and money fields are protected from their owner.

---

## 7. Prioritised remediation plan (after owner decisions)

| # | Change | Depends on | Risk |
|---|---|---|---|
| 1 | `techTickets` rule → `isStaff()`, plus a rules test (D4) | none | Low; staff-only usage is already the intent |
| 2 | Staff reactivation route, plus CRM and Android buttons, plus tests (D2) | Q2 | Medium |
| 3 | Decouple staff revocation from the app account (D1) | Q1 (and 2) | Medium |
| 4 | Owner gate: server-side or real second factor; answers moved out of `crmUsers` (D3) | Q3 | Medium-high (sign-in path) |
| 5 | Ticket mutations: server audit and notifications (D5) | Q7 | Medium |
| 6 | Firestore rules aligned with the permission table (D6), with rules tests | Q5; the emulator test run | Medium |
| 7 | Staff identity linking for phone-only app accounts (D6/parity) | Q6 | Product decision |
| 8 | `_PARTNER_HELD` aligned with `HELD_STATUSES` (S1); legacy-role survey (S2) | none / Q9 | Low |
| 9 | Notices to staff on role change / deactivation | Q10 | Low |

Before any change: run the root Firestore rules tests on the local emulator, and finish the Android runtime check against a local backend, as in B3.

---

## 8. Product-owner questions (decisions needed before implementation)

1. **App account on staff removal:** when a staff member is deactivated, should their personal Zipper app account (same login) stay usable? Or should staff use separate, dedicated logins?
2. **Reactivation:** should deactivated staff, and deactivated owners, be restorable? By whom: the same authority that deactivated them, owners only, or the Observer only for owners? Is a reason required?
3. **Owner gate:** is the three-question gate meant to be a real security control? If yes, may it be enforced on the server, or replaced with a standard second factor (authenticator app or passkey)? May the stored answers be removed from the staff-readable directory?
4. **Temporary suspension of staff:** is a reversible "suspended" state needed (e.g. on leave), separate from deactivation?
5. **Firestore vs API authority:** should every Firestore staff write follow the same permissions as the API (e.g. a tech admin must not edit agencies or the economy config directly)? Or do any of the current role-name grants reflect an intended rule?
6. **Staff on the Android app:** should staff be able to use the app's work screens with their phone-number app login? If yes, how should that login be linked to their CRM email login (linking flow, an admin-side link, or not supported)?
7. **Team tickets:** should assignment, escalation and closure be audited on the server and notify the assignee or team? Which channel (in-app, email)?
8. **Staff directory privacy:** may every staff member see every colleague's phone and personal email, or only admins and owners?
9. **Legacy role names** (`admin`, `ops`, …): can they be retired from the rules after a survey confirms no live account uses them?
10. **Notices:** should a staff member be emailed when their role changes or their access is revoked?
11. **Observer resilience:** there is exactly one Observer, and only it can provision or remove owners. What is the agreed recovery if its mailbox is lost? (No change proposed; documenting the dependency.)
12. **Partner records of new staff:** if someone with a pending, awaiting or revoked partner application is hired as staff, should the invitation be refused (as for active partners), or the partner record closed automatically?

*Stopping here for your review. No changes were made in this phase. Once you answer, I will propose the exact implementation plan for the approved items only.*
