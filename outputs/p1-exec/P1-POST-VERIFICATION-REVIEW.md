# ZIPPER Phase 1 — Post-Verification Review and Department/Role Audit

24 Oct 2026 · branch `v5-scratch` · working tree: 481 modified/untracked paths, preserved · nothing committed, pushed, deployed, migrated or written to production.

**Evidence labels.** **[RAN]** = I executed it this session and saw the output. **[YOU]** = you reported the result; I did not see it. **[CODE]** = read in the current working tree (file:line). **[INF]** = inference, not verified.

**The only code changes in this review:**
- I fixed a write bug in my own survey script (§3).
- I added a test proving that script is read-only.

No role, permission, rule or data was changed.

---

## 1. Verified results and test evidence

| What | Result | Evidence |
|---|---|---|
| Firestore governance rules (`tests/firestore.p1gov.rules.test.mjs`, `demo-zipper`) | 95 checks, 0 failures | [YOU] |
| Android `./work-verify.command` | Gradle exit 0 | [YOU]. I have not seen the test count. |
| Backend, every module (`python3 -m tests.<module>`, sandbox, fakes) | **86/86 modules pass** | [RAN] today, after the §3 fix |
| New: `tests/test_p1_survey_readonly.py` | passes. **Against the previous script version it fails 3 checks**, so the test discriminates. | [RAN] |
| CRM `tsc --noEmit` | exit 0 | [RAN] last phase. No CRM files changed since. |
| `test:phase1a`, `test:firestore`, `test:storage`, `test:ugp` | **Not run by me** | `test:phase1a` and `test:firestore` use `--project zipper-83816` (not `demo-`). They are emulator-only, but I won't run them until you approve switching to `demo-zipper`. |

**Emulator safety of the suite you ran [CODE]:**
- `test:p1gov` = `firebase emulators:exec --only firestore --project demo-zipper`.
- The harness pins `127.0.0.1:8080` and `projectId: 'demo-zipper'`.
- A `demo-` project exists only in the emulator.

---

## 2. Owner MFA boundary — findings

### 2.1 Verdict: **bypass exists**

An Owner holding a valid Firebase ID token, but without completed MFA, can read and write in Firestore everything the rules grant to `superadmin`, without touching the API. The API refuses that session; the rules never ask about MFA.

**How [CODE]:**
- **The CRM signs into Firebase first.** It does this before the MFA step (`crmSignIn` → Firebase email/password; `login/page.tsx` then calls `beginMfa`). A live Firebase session exists on the MFA screen, so the Firestore SDK in the browser console works.
- **Every staff helper honours `superadmin`.** `isSuperAdmin()` (`firestore.rules:207`) = `isCrmUser() && crmRole() == 'superadmin'`. Every department helper includes it too: `isAdmin` 216, `isApp` 221, `isOps` 226, `isTech` 231, `isFinance` 236, `isSupport` 241, `isMarketing` 246, `isStaff` 260. So do `hasPerm()` (308) and `canDecideCoinOps()` (329).
- **The rules have no MFA input.** Nowhere do they read anything MFA-related. The only custom-claim reads are in `storage.rules` (`role`, `aid`).
- **Scale.** At least **119 of 242** single-line `allow` statements grant through one of those helpers (counted mechanically; multi-line grants not included). The helper call counts: `isAdmin` 66, `isSuperAdmin` 31, `isStaff` 28, `isOps` 27, `isFinance` 23, `isTech` 10, `isSupport` 6, `isApp` 4, `isMarketing` 2, `hasPerm` 2, `canDecideCoinOps` 2.

**Affected data includes [CODE]:**
- every `crmUsers` document (contacts);
- financial reads: `diamondTransactions`/`beanTransactions` (including collection-group reads at 4039/4043), `withdrawalRequests`, `salaryRequests`, `hostPayouts`, `weeklyPayoutReports` (update included), `coinPurchaseRequests`, `rechargeRequests`, `platformRevenue`;
- `agencies` updates;
- `appConfig`/`paymentConfig` writes;
- `broadcasts` and `announcements` writes;
- moderation collections;
- `kycSubmissions`/`hostKyc`.

**Storage [CODE]:** the backend gives an Owner the claim `role: 'owner'` (`storage_claims.claim_for`). `isGovernance()` (`storage.rules:78`) feeds every read tier: KYC documents, seller documents, payout and recharge evidence. That claim is also MFA-independent.

### 2.2 Token and claim lifecycle today [CODE]

| Event | API session | Firestore access | Storage claim | Firebase refresh token |
|---|---|---|---|---|
| Owner password sign-in | issued, `mfa=false` (pending) | **full Owner** immediately | `role:owner` (persists on the account) | valid |
| MFA verified | replaced, `mfa=true` | unchanged (already full) | unchanged | unchanged |
| CRM sign-out | that `jti` revoked | ends in *that* browser (client `signOut`) | unchanged | **not revoked**. A copied refresh token keeps working |
| Observer MFA reset | all of that Owner's sessions revoked | **unchanged: full Owner** | unchanged | not revoked |
| Suspend / deactivate | all sessions revoked | **ends at once.** `isCrmUser()` re-reads `crmUsers.isActive` on every request | cleared, but **stale for up to 1h** in ID tokens already minted | **not revoked** (decision 1: the personal app account is untouched) |
| Reactivate | new sign-in required | restored | re-applied | n/a |
| Role change away from Owner | sessions revoked | changes at once (role re-read) | re-applied, ≤1h stale | not revoked |

**Stale claims:**
- **Firestore can't go stale.** It reads `crmUsers` live.
- **Storage can go stale.** The `role` claim stays valid for up to an hour after suspension, deactivation or demotion, because Firebase tokens are not revoked and claims refresh only when the ID token does.
- **MFA has no claim at all,** so there is nothing to go stale. It simply isn't enforced outside the API.

**A second, pre-existing defect (not MFA) [CODE]:**
- `hostKyc` read (`firestore.rules:2346-2350`) admits **any signed-in account** when the host's `users` document has an `agencyId`.
- The file's own comment (2351-2356) says this was knowingly left open.
- No code reads `hostKyc` today [INF, from the audit's search].
- Recommend `false` or `isSuperAdmin()` (§6, step 1).

### 2.3 Minimal proposed fix (not implemented — documented first, as you asked)

**Idea:** bind the Owner's Firestore authority to the *specific Firebase sign-in* that passed MFA. This reuses the `auth_time` pattern the rules already use for mobile sessions (`sessionCurrent()`, `firestore.rules:574-598`).

1. **Backend.** On `/auth/mfa/verify` and `/enrol/confirm`, the CRM also sends its current Firebase ID token. The server:
   - verifies that token and checks `uid` matches the API session;
   - writes the claim `mfa_at = <that token's auth_time>`;
   - merges it the same way `storage_claims._apply` does: read existing claims, keep `role` and `aid`, set `mfa_at`.

   The Cloud Function `syncStorageRoleClaim` only touches `role`/`aid` and already spreads the rest (`functions/src/storageClaims.ts:246-254`). **Storage claims are preserved.**
2. **Rules.** One choke point: `crmRole()` returns `superadmin` only if `request.auth.token.get('mfa_at', -1) == request.auth.token.auth_time`, and returns `superadmin_pending` otherwise.
   - Every helper then denies a pending Owner, and no individual grant needs editing.
   - `isOwner(uid)` is uid-based, so the Owner can still read their own `crmUsers` document, which the login screen needs.
   - A new password sign-in has a new `auth_time`, so a claim left over from an earlier session is useless.
3. **`storage.rules`.** In `roleClaim()`, apply the same test to `role == 'owner'`.
4. **Clear `mfa_at`** on Observer reset, suspension, deactivation and API sign-out.
5. **CRM.** After verifying, call `getIdToken(true)` so the new claim is in the token before the first Firestore read.

**Impact, to approve before implementation:**

| Who / what | Effect |
|---|---|
| **Existing Owners** | No Firestore or Storage access until they complete MFA in that browser sign-in. Owners who haven't enrolled can't use Owner screens until they do, which matches the API today. |
| **Owners on Android** | Their Firestore-backed work screens need MFA bound to the app's own `auth_time`. Without an extra step on Android (send the app's ID token to verify), those screens are refused. Their personal app use is unaffected (`isOwner`/`isAppUser` arms). |
| **Rules** | One extra `get` is avoided because `auth_time` is a token field. No new reads. |
| **Race** | `_apply` is read-modify-write and not atomic. A role change that coincides with a verify could drop `mfa_at` (the Owner re-verifies) or `role` (that claim's next sync restores it). Acceptable, but noted. |
| **Observer** | Unaffected: it has no Firebase login. |

**Regression tests required** (emulator, `demo-zipper`, `authenticatedContext(uid, {auth_time, mfa_at, role})`):
- An Owner with no `mfa_at`, or with `mfa_at != auth_time`, is refused:
  - reading another person's `crmUsers` document;
  - reading `withdrawalRequests`;
  - the collection-group read of `diamondTransactions`;
  - updating `agencies`;
  - writing `appConfig`;
  - writing `broadcasts`;
  - Storage KYC reads.
- With matching `mfa_at`, all of the above are allowed.
- The Owner can always read their own `crmUsers` document.
- Department roles are unaffected, before and after (this guards the shared helpers).
- Backend tests:
  - claims are merged (`role`/`aid` survive);
  - `mfa_at` is cleared on reset, suspend, deactivate and sign-out;
  - verify refuses an ID token for a different uid;
  - the function trigger preserves `mfa_at`.

---

## 3. Legacy-role survey — safety and results

**A defect in my own script, now fixed:**
- `scripts/survey_legacy_roles.py` called `mongo.connect()` with its default `ensure=True`, which runs `ensure_indexes()`. That is DDL: a write against whichever MongoDB it reached.
- It now calls `connect(ensure=False)`.
- I also added the requested orphan counts:
  - staff-role `crmUsers` documents with no Mongo `staff` row;
  - Mongo `staff` rows with no `crmUsers` document (Observer excluded by design).
- The pre-fix copy is at `outputs/p1-exec/before/survey_legacy_roles.py.v1`.

**Proof it is read-only [RAN].** `tests/test_p1_survey_readonly.py` runs the real `_run()` against fakes that raise on any Firestore or Mongo write and on index creation. It checks:
- zero write attempts;
- `connect(ensure=False)`;
- legacy roles, orphan and missing-document counts are correct;
- no uid, name, email or phone appears in the output.

Run against the old version, it fails the DDL and orphan checks.

**Which targets it can reach [CODE]:**
- It loads settings from exactly one dotenv file: `ZIPPER_ENV_FILE`, else `.env.local` if present, else `.env` (`config.py:11-24`). I did not open either; both exist in `backend/`.
- `app/core/isolation.py` decides, before any client is built:
  - **Outside production:** MongoDB only on localhost (`mongodb+srv` refused), and Firebase only a `demo-` project with all three emulator hosts local. No credentials are read.
  - **`ENVIRONMENT=production` off Cloud Run:** refused unless `ZIPPER_ALLOW_PRODUCTION_ACCESS` equals the project id.

**Run status: not run against real data.** Real staff and role data exists only in production, which you ruled out, and the sandbox has no local MongoDB or emulator. So there are **no aggregate counts to report yet.** When you choose to, the safe invocation is your call:

```
# against your local emulator + local Mongo (isolation enforces this):
cd backend && .venv/bin/python -m scripts.survey_legacy_roles
```

A production read needs the explicit acknowledgement variable and your decision.

**Known legacy categories from code [CODE]:**

| String | CRM and API read it as | `firestore.rules` grants it |
|---|---|---|
| `admin` | `app_admin` | `isAdmin()` plus every department helper except `isMarketing` |
| `ops`, `tech`, `finance`, `support` | `*_member` | that department's helper plus `isStaff()` |
| `app` | `app_member` | `isApp()`, but **not** `isStaff()`. An inconsistency in the rules |

---

## 4. A2 — classification of the broad `isAdmin()` grants

Checked against current rules, CRM, Android and backend [CODE; the per-line table is in the audit notes].

**Totals (from a delegated line-by-line review; I spot-checked `hostKyc`, the helper definitions, the ban guards and the permission table, not all 55 rows):**
- 55 rows in the matrix: **5 required**, **45 overly broad**, **4 unclear**, **1 false positive** (line 2226 is a comment).
- The matrix **missed 10 multi-line grants**, including a financial **create** on `salaryRequests` (line 3742) and the `giftTransactions` read (2439).
- `isAdmin()` matches the regex `.*_admin`, so any made-up `x_admin` string passes.

**Required:**
- `agencies` read (1196): the `/agencies` screens for app, ops and finance admins.
- `platformRevenue` read (2508): the `/analytics` screen.
- `crmUsers` own-department read (947).

**Unclear — product decision needed:**
- `diamondTransactions` / `beanTransactions` reads (2270, 2315): support and tech admins see user balance history only through `isAdmin`.
- `salaryRequests` read (3731): the page lets `app_admin` in, but not `finance_admin`.
- `calls/messages` read (3549): should moderation read private call chat?
- `announcements` write (3623): no code uses it.

**Financial-path grants (24 in the matrix, plus 2 missed): flagged only, no change proposed to financial logic.**
- Most are **overly broad**: a marketing, tech or support admin can read payouts, withdrawals, coin purchases, recharges and transaction history.
- Some are **writes that no client uses**: `hostPayouts` create/update, `weeklyPayoutReports` create, `giftsSent`, `giftsReceived` update/delete, `salaryRequests` delete/create.
- `weeklyPayoutReports` **update** is used by the CRM (`lib/finance.ts:90,102` approve/reject) with no field limit.
- One is **too narrow at the same time**: `finance_member` is refused `sellers/diamondLending`, which `/economy/currency` reads.

**Staged remediation (each stage is its own approval and rules deploy, with emulator tests first):**
1. **Holes and dead writes (lowest risk):**
   - `hostKyc` read and write → `false`, or `isSuperAdmin()`.
   - Dead staff writes → `false`: `callHistory`, `calls`, `calls/messages` update, `notifications`, `platformStats` delete, `giftsSent`/`giftsReceived`, `hostApplications` staff update/delete, `kycSubmissions` update/delete.
   - Tests: each refused for every department admin, and server (Admin SDK) paths unaffected.
2. **Redundant broad arms (a narrower helper on the same line already covers the real users):**
   - `opsTickets` → `isOps()`.
   - `broadcasts` → `isMarketing()`.
   - `crmSupportTickets` update → `isSupport()`.
   - `live comments/messages/reports/pkInvites` → `isOps()`.
   - Tests: the named screen roles allowed, other admins refused.
3. **Financial reads → `isFinance()` or `hasPerm('can_view_finance')`.** No business logic changes; access only. Needs your sign-off per collection. Tests: finance admin and member allowed where their pages need it; tech, support and marketing admins refused.
4. **Unclear items, after your decisions** (the four above, plus the `agencies` update field limit).
5. **Remove legacy strings and the `.*_admin` regex** (with plan G), replacing it with an explicit list of six.

---

## 5. Role verification — what has actually run

| Area | Ran | Written, not yet run | Not covered at all |
|---|---|---|---|
| Backend permissions / guards | [RAN] `test_permissions` (250), `test_partner_session` (541), lifecycle/MFA/tickets/directory/survey | — | End-to-end against a real Mongo |
| Firestore rules | [YOU] p1gov 95/95 | phase1a/firestore/storage/ugp not run by me (project id) | All 12 department roles across the 55 + 10 `isAdmin` grants; Owner without MFA; Storage per role |
| CRM | [RAN] type-check only | — | **No UI/e2e test of any role's navigation or buttons.** The nav-vs-permission mismatches below (§7.5) were found by reading code only |
| Android | [YOU] Gradle exit 0 (unit tests, including the work-module guards) | — | Runtime by role; Owner MFA screen on a device; staff phone-login linking |
| Notifications | [RAN] backend tests assert in-app and email calls for staff lifecycle and tickets | — | Delivery (no email is sent outside production by design); the vacancy and no-admin cases notify nobody (§7.4) |
| Partner roles | existing backend suites | — | Combination rules end-to-end through the CRM UI; dual agency + seller Storage access |

---

## 6. Department, role and organisational model audit

### 6.1 Role and capability inventory [CODE]

| Kind | Items | Where defined |
|---|---|---|
| Governance identities | Observer (one account, `observer_email` setting, synthetic uid, code sign-in); Owner (≥1, not capped: last-active-owner rule only) | `roles.py:21-42`, `config.py:145`, `staff.py:1083-1091` |
| Department roles (12) | `{app, ops, finance, tech, support, marketing}_{admin, member}` | `roles.py:62-86` |
| Partner session roles | `agency` (covers main and sub-agency), `seller` | `roles.py:141-159` |
| Partner entities | Mongo `partners` kinds `agency`, `sub_agency`, `seller`; statuses pending, awaiting_verification, approved, rejected, suspended, revoked | `partners.py:22-40` |
| App capabilities (not roles) | App User (default), Host (`users.isHost` + `agencyId` + `hostApplications`) | `user_roles.py`, `functions/src/roster.ts` |
| Permissions (20) | `can_*`, identical in CRM and backend (`auth.ts:239-339` = `roles.py:310-456`) | live table printed this session [RAN] |
| Unused permissions (7) | `can_view_finance`, `can_commission_slabs`, `can_app_config`, `can_create_tickets`, `can_assign_tickets`, `can_close_tickets`, `can_monitor_live` | no route, service or CRM check [CODE] |

**Is each concept modelled correctly?**
- **Host:** an app capability plus a relationship to one agency. ✔ Correct; not a staff identity.
- **Sub-agency:** its own partner entity and family-lock member, but session role `agency`. ✔ Reasonable.
- **App User:** the default (absence of any role). ✔
- **Department:** derived from the role prefix and duplicated in `staff.team` and `crmUsers.dept`. ✔ Fine, but it is three representations.
- **`reports_to`:** a set-once relationship that is **not** authority. ⚠ It becomes stale on vacancy or replacement (§7.4).
- **Ticket permissions** exist as permissions but are **enforced by role prefix** (`tickets.py:86-100`). ✘ Modelled twice.
- **`can_monitor_live`** exists, but live end/mute is **role-gated to Ops** (`live.py:88-90`). ✘
- **Legacy role strings** act as hidden super-roles in the rules (§3). ✘

### 6.2 Department / role matrix

`[A]` = admin-only differences. Permission lists are the live backend table [RAN].

| Department | Role | Business responsibilities | Screens/workflows (CRM nav) | Backend permissions (used) | Firestore/Storage access | Admin-vs-Member | Excessive | Missing | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| App | Admin | App users: moderation, bans/suspensions, reports, balance-correction requests, team | /users /hosts /hosts/verification /sellers /agencies /kyc /live /moderation /policies /gifts /feedback /analytics /reports … | ban_users, view_users, adjust_balance (request), manage_team, view_agencies/sellers (docs) | `isApp` + `isAdmin` (all 55 broad grants; financial reads); Storage KYC reviewer, support | [A] staff management, balance requests, report "deduct" | `app_config` (unused; app-config screens are owner-only), `view_finance`, `monitor_live`, ticket perms (all unused); broad `isAdmin` financial reads | — | **KEEP BUT FIX PERMISSIONS** |
| App | Member | Moderation casework | /users /hosts /hosts/verification /live /analytics | ban_users, view_users | `isApp`, `isStaff`; Storage support | — | `ban_users` on a member (can ban and suspend app users) | host verification shown but `approve_kyc` absent → 403 | **PRODUCT DECISION** (should members ban?) + fix nav |
| Ops | Admin | KYC/host verification, partner and seller lifecycle, transfers and role-appeal recommendations, live intervention, team | /operations/* /moderation /kyc /role-appeals /transfers /sales /recharges /lending /live … | approve_kyc, approve_seller, view_users, manage_team | `isOps` + `isAdmin`; Storage KYC reviewer | [A] approvals, team | broad `isAdmin` financial reads | **Can't ban, suspend or device-ban** (no `ban_users`, `users.py:344,372,735-814`), yet Moderation and Device Bans are shown | **PRODUCT DECISION** (who owns bans: App or Ops?) |
| Ops | Member | Queue work: live, reports, ops tickets | /hosts/verification /sales /recharges /operations/* /moderation /live | view_agencies/sellers (docs only); live end/mute by role | `isOps`; Storage KYC reviewer | — | — | Most shown screens 403 (verification list needs `approve_kyc`; bans need `ban_users`) | **KEEP BUT FIX PERMISSIONS** (trim nav or grant a member tier) |
| Finance | Admin | Verify cards, raise payouts and coin operations, finance reports, team. Signing and execution are owner-only | /finance/* (9) /coin-purchases /sales /recharges /lending /economy/config … | coin_operations, process_payout, adjust_balance, view_users, manage_team; card verify (`roles.py:172-191`) | `isFinance` + `isAdmin`; `canDecideCoinOps`; Storage finance | [A] verify, payouts pages, team | `/economy/config` open without `economy_config` (it goes through approval) | — | **KEEP BUT FIX PERMISSIONS** (align economy-config gate) |
| Finance | Member | Raise coin operations and payout requests | /coin-purchases /sales /recharges /lending /economy /economy/currency | coin_operations, process_payout | `isFinance`; refused `sellers/diamondLending` (only `isAdmin`); refused coin-op decisions | can't verify | — | Holds `process_payout` but /finance/payouts and /withdrawals are admin-only | **PRODUCT DECISION** (do members raise payouts?) then fix nav or perm |
| Tech | Admin | App and payment config, content, chance configuration proposals, jobs, team | /tech /tech/content /tech/payments /tech/jobs /tech/email /tickets /users … | economy_config (chance, with team admin), manage_team | `isTech` writes `appConfig`/`paymentConfig`; `isAdmin` broad; Storage support | [A] chance proposals, team | `app_config`, `commission_slabs` (unused); /users via Firestore without `view_users`; `isAdmin` financial reads | — | **KEEP BUT FIX PERMISSIONS** |
| Tech | Member | Config and content upkeep | /tech /tech/content /tech/payments /live | (economy_config etc. held but **no reachable route**) | `isTech` → **writes `appConfig`/`paymentConfig` directly** | — | `app_config`/`commission_slabs`/`economy_config` (dead); direct payment-config write power | — | **PRODUCT DECISION** (should members write payment config?) |
| Support | Admin | Ticket triage, user help, team | /tickets /feedback /users /moderation /operations/feedback … | view_users, manage_team; triage by role prefix | `isSupport` + `isAdmin` (balance history); Storage support | [A] team, email one user | /users shows phone, email, diamonds, beans **and CSV export** (`users/page.tsx:173-178, 363-372`) | — | **PRODUCT DECISION** (contact/balance visibility, export) |
| Support | Member | Ticket work | /tickets /feedback /users /operations/feedback | view_users, assign_tickets; triage by prefix | `isSupport`, `isStaff` | — | same /users exposure and export | — | **PRODUCT DECISION** |
| Marketing | Admin | Broadcasts; email agencies and sellers | /broadcasts /broadcasts/email /reports … | send_broadcasts (email audiences in service), manage_team | `isMarketing` + `isAdmin` (broad) | [A] email audiences, team | `isAdmin` financial reads | — | **KEEP BUT FIX PERMISSIONS** |
| Marketing | Member | In-app broadcasts | /broadcasts /broadcasts/email | send_broadcasts (no email audience reachable) | `isMarketing` → **writes `broadcasts` directly** | — | email composer shown, every audience refused | — | **PRODUCT DECISION** (in-app allowed, email refused — intended?) |
| Governance | Owner | Final decisions: sign, execute money, activate, reinstate, configuration | all 71 nav entries | all 20; `require_owner` routes | every helper accepts `superadmin`; Storage governance | — | **Firestore/Storage without MFA** (§2) | — | **KEEP BUT FIX** (MFA claim, §2.3) |
| Governance | Observer | Read-only oversight; provisions Owners | OBSERVER_ROUTES (10) | none; `require_owner_provisioner` (create/suspend/reactivate/deactivate Owner, MFA reset) | none (no Firebase login) | — | — | **No CRM UI to create or deactivate Owners** (API only; `api.ts` has suspend/reactivate only); no Owner delete anywhere | **MISSING — ADD** (Owner create/deactivate UI); delete is a **PRODUCT DECISION** |

**Cross-cutting [CODE]:**
- **MERGE / SIMPLIFY:**
  - The 3 ticket permissions: either enforce them in `tickets.may_triage`, or delete them. Today they are decorative.
  - `can_monitor_live` versus the role-gated live routes: same choice.
- **CONSIDER REMOVING:** `can_app_config`, `can_commission_slabs`, `can_view_finance`. They are unused, but `can_view_finance` is the natural helper for stage 3 of A2, so **keep that one and start using it**.

### 6.3 Conflicts between sources (not silently resolved)

| # | Conflict | Sources |
|---|---|---|
| 1 | Host + main Agency: docs say yes, code forbids. Host + Sub-agency is allowed only under the same main agency. | Phase-0 §5.3 vs `partner_applications.py:107-125` |
| 2 | Sub-agency "not a separate entity" (docs) vs its own `partners` kind and family lock (code) | §5.2 vs `partners.py:24`, `partner_roles.py:81-85` |
| 3 | A revoked partner role frees the slot in the CRM, but is still held by the API | `secondRoleRule.ts:66-67` vs `partner_roles.py:599` |
| 4 | The header of `partner_applications.py` says "Sub-agency → Coin Seller" only; its table allows `seller` + `host` | `partner_applications.py:26` vs `:123` |
| 5 | CRM `PartnerRoleStatus` lacks `suspended`/`revoked`, which the functions handle | `partnerRouting.ts:43` vs `crmRoles.ts:113-139` |
| 6 | Docs GAP-SA-002 (sub-agency depth) and GAP-006 (no cascade) are outdated | docs vs `partner_ops.py` |
| 7 | Docs GAP-002 ("no way to deactivate an Owner") is fixed in the API, still true in the UI | docs vs `routers/staff.py:279-352`, `api.ts` |
| 8 | Nav shows Ops the ban, device-ban and host-verification screens that the API refuses | `layout.tsx:151,298,300` vs `users.py:344-814`, `verification.py:41` |
| 9 | Legacy `admin` is `app_admin` in the CRM and API, but a super-role in the rules | `auth.ts:89`, `crm_directory.py:185` vs `firestore.rules:216-260` |
| 10 | Legacy `app` is in `isApp()` but not in `isStaff()` | `firestore.rules:221` vs `:260` |
| 11 | Dual agency + seller login: the Storage token carries one role, so seller files are refused [INF] | `storageClaims.ts:149-187`, `storage.rules:152` |
| 12 | `repair_staff_accounts` tells users to "ask an existing owner to invite them", but Owners can no longer invite Owners | `crm_directory.py:171-176` vs `staff.py:183-186` |

### 6.4 Hierarchy and lifecycle [CODE]

| Requirement | Status |
|---|---|
| Members supervised only within their own department | ✔ `manages()` (`staff.py:118-136`). The list scope matches (`:651-666`) |
| Department Admins report to Owners | ✔ in authority (Owners manage every department role); `reports_to` records the inviter only, set once |
| Vacancy state when an Admin is suspended or deactivated | ✘ **none.** Members untouched, nothing detected or shown |
| Members can escalate to an Owner during a vacancy | ✘ **none.** An unassigned team ticket notifies that team's *active* admins only, so nobody when there are none (`tickets.py:128-134, 534-536`). Only money/queue cards escalate (`alerts.py:787-805`) |
| A replacement Admin restores reporting | Partly. Authority is restored through the department match; `reports_to` is never re-pointed |
| Suspend / deactivate / reactivate / role change update server state and audit | ✔ mirror, Storage claim (cleared first), sessions, audit, email and in-app (`staff.py` §, backend tests [RAN]). Exceptions: employment edits send no notice; the Owner/Observer alert `staff_access_changed` covers role change and deactivation, **not suspension or reactivation** |
| Personal app account never disabled | ✔ No Firebase disable or revoke; audit records `personal_app_account: unchanged` (tested [RAN]) |

### 6.5 Proposed clean organisational model (for approval)

1. **Governance:** Observer (exactly one), Owners (N ≥ 1, configurable). Unchanged, plus:
   - Owner create/deactivate UI for the Observer (**MISSING — ADD**). It reuses the existing API.
   - Owner Firestore/Storage authority bound to MFA (§2.3, **KEEP BUT FIX**).
2. **Departments:** keep 6 × {Admin, Member}. No role is redundant, because each holds a distinct workflow. Three member roles currently have **no working permissioned route** (tech_member, marketing_member, and mostly ops_member). Decide their real job before trimming anything (**PRODUCT DECISION**).
3. **One authority vocabulary.**
   - Every check, whether route, CRM nav or rules, should read a permission that is actually enforced.
   - Replace role-prefix checks (tickets, live) with their permissions, or delete those permissions (**MERGE / SIMPLIFY**).
   - Rules move from `isAdmin()` to `hasPerm(...)` or a department helper, in A2 stages.
4. **Nav derived from permissions:** a screen is shown only to roles that hold the permission its API needs (fixes conflict #8 and the finance-member payouts gap).
5. **Vacancy handling (MISSING — ADD):**
   - a department with no active admin shows a vacancy banner on /team for Owners;
   - unassigned team tickets and `team_admin` alerts fall back to Owners;
   - members see "your department has no admin — escalate to an Owner".
6. **Partners:** keep entities and capabilities as they are. Fix the CRM/API disagreements (#3–5) to follow the API, which is authoritative. Fix the dual-role Storage claim (#11) after a product check.
7. **Legacy strings:** retire them via plan G (survey → repair → rules).

### 6.6 Regression tests per recommendation

| Recommendation | Tests |
|---|---|
| MFA claim (§2.3) | listed in §2.3 |
| A2 stages 1–5 | per stage, in §4: department-role × grant emulator matrix, allow and deny |
| Nav ↔ permission parity | a unit test that parses `layout.tsx` roles and asserts each screen's required API permission is held by every listed role (fails today for conflict #8) |
| Ticket/live permission simplification | `test_p1_tickets` and `test_live_ops` extended: a role without the permission is refused even with the right prefix (or the permission is removed and `test_permissions` updated) |
| Vacancy | backend: deactivate the only ops_admin → overview reports a vacancy; an unassigned ops ticket notifies Owners; reactivate or appoint → the vacancy clears; audit plus notices |
| Owner provisioning UI | CRM type-check plus an API test that only the Observer reaches `POST /staff/owners` and `/owners/{uid}/deactivate` (existing guard test extended) |
| Partner rule consistency | a shared fixture of (held roles → allowed additions) run against both `partner_applications.eligible_kinds` and `secondRoleRule.ts` |
| Legacy retirement | survey exit 0; rules test that each legacy string grants nothing |
| `hostKyc` hole | emulator: a random signed-in user is refused `hostKyc` read |

---

## 7. Minimal next steps (each needs your go-ahead; none started)

1. **Approve and implement the Owner MFA claim (§2.3)** with its tests. It is the highest-impact fix and changes one helper plus the backend.
2. **A2 stage 1:** close the `hostKyc` read hole and the dead staff writes.
3. **Product decisions** listed in §6.2 (bans owner, member tiers, support data exposure, marketing member scope, finance member payouts) and §4 (four unclear grants).
4. **Switch `test:phase1a` / `test:firestore` to `demo-zipper`,** then run every rules suite locally.
5. **Run the legacy survey** in an environment you choose; then plan G.
6. **Vacancy handling and the Observer's Owner-management UI.**
