# ZIPPER — Phase 1 Read-Only Audit
**Scope:** user management, authentication, identity, roles, appeals, staff, levels/tasks, financial safety, security
**Date:** 2026-10-14 · **Branch inspected:** `v5-scratch` (last commit `1194e55`, 2026-10-05) **plus 191 uncommitted working-tree changes**
**Method:** static source inspection of all four codebases, cross-checked; safe local test runs (fakes only). No code, data, rules, credentials or deployments were changed. No production reads or writes were made.

Evidence paths are relative to the repository root `zippern/`. Confidence: **CONFIRMED** = verified in code by direct reading (critical items were re-read by hand); **LIKELY** = code path strongly indicates it, not exercised; **UNVERIFIED** = needs runtime/production evidence.

---

## A. Executive summary

**Overall status: NOT READY.**

The core state machines are better than average: ban vs suspend are distinct, partner statuses (pending/approved/rejected/suspended/revoked) are distinct, role-family uniqueness uses a transactional sentinel, refund clawback is idempotent, quick-login is device-key bound and refuses restricted accounts, and every backend user-management endpoint writes an audit row. But there are several ways to **take over accounts, self-grant roles, or bypass the backend entirely through Firestore rules**, the **role-restoration workflow the business requires does not exist at all**, and **financial drift cannot currently be detected**.

**Top critical issues**
1. **AUTH-001** — `claimGuestIdentity` binds *any* uid the caller names to the caller's device and then hands back a sign-in token for it → takeover of any guest account (and, since the 2026-10-08 "Option B" change, the takeover survives the victim adding an email/phone).
2. **SECURITY-002** — A self-applying host can set their own `hostApplications.status = 'approved'` through Firestore rules, then call `activateHost` → Host without any staff decision.
3. **IDENTITY-002** — A user can delete and recreate their own `users` doc; the create rule omits `accountState`, `isSuspended`, `crmRole`, `isOfficial`, etc. → a suspended user un-suspends themselves and can self-badge as official/staff.
4. **CONTACT-001 / CONTACT-002** — Users can write their own `email`/`phoneNumber`; partner applications push a *typed, unverified* phone onto the applicant's Firebase login → contact squatting and identity confusion.
5. **STAFF-002** — An Owner can change *any* staff record's role (including the Observer's, other Owners', their own, and to `agency`/`seller`) — the Observer can be locked out permanently.
6. **RESTORE-001/002/003** — No role-restoration appeal or Owner decision exists; any ops admin can restore a revoked role with the Approve button or the reactivate API.
7. **SECURITY-001** — Production Agora certificate is in pushed git history, inside older APKs, and deployed as a plaintext env var; never rotated.

**Main identity/authorization risks:** guest takeover (AUTH-001); per-login (not per-human) role eligibility (ROLE-001); direct Firestore role/contact writes by users and by every staff tier (CONTACT-001, SECURITY-004); revoked/suspended Agency on a dual-role login keeps agency data access (SECURITY-005); one-active-session not enforced (SESSION-001); suspension doesn't cut Firebase access (SESSION-002); cold start fails open (AUTH-003).

**Main financial-integrity risks:** reconciliation compares the wrong currency and unrelated quantities, so it can never detect drift (FINANCE-002); `replica_stale` balances are flagged but never repaired (FINANCE-001); a refused refund after partial failure enables a second clawback (FINANCE-003); card executors are not atomic, repayment/write-off can apply twice or erase debt (FINANCE-005); host withdrawal and weekly bean release can double-pay (FINANCE-006/007); commission accrual keys on period label, so overlapping periods double-accrue (FINANCE-008); revoked partners' pending money still executes (FINANCE-011).

**Important missing features:** role-specific restoration appeals with Owner final decision; contact-change workflow (Feedback → authorize → OTP → release); user level computation (level is always 0); user and host daily tasks; staff reactivation; Owner level-adjust tool; appeal contact verification and outcome notifications.

---

## B. Repository and architecture map

| Component | Tech / location | Runtime |
|---|---|---|
| Android app | `zipper-app/` Kotlin + Compose + Hilt + Agora | Talks **only to Firebase** (Auth, Firestore, Storage, callables). Never calls the FastAPI backend directly. |
| CRM | `zipper-crm/` Next.js 14 static export | Firebase Hosting site `zipperlive`; `/api/**` rewritten to Cloud Run (`firebase.json`). Uses both the backend API and **direct Firestore writes**. |
| Backend API | `backend/` FastAPI + Motor (MongoDB) + firebase-admin | Cloud Run `zipper-api`, asia-south1. Mongo is authoritative for partners, staff, sessions, ledger, recharges, cards, audit. Mirrors into Firestore. |
| Cloud Functions | `functions/` TS, Node 22, mostly gen1 | asia-south1 callables/triggers; the `index.ts` scheduled jobs have no `.region()` → us-central1. Gen2 only for gifts, calls, account deletion. |
| Rules | `firestore.rules`, `storage.rules`, `firestore.indexes.json` | Deployed by Firebase CLI. |
| Deploy | `deploy.sh` (Firebase + `gcloud run deploy`), `deploy-crm.command` | Cloud Run secrets via Secret Manager; Functions secrets partly via plain `.env`. |

**Canonical identity:** the Firebase uid keys `users/{uid}`, `crmUsers/{uid}`, Mongo `staff.uid`, `partners.owner_crm_uid`, Firestore `agencies/sellers.crmUid/ownerUid`. A Host is **not** a separate record — it is `users.isHost` + `agencyId`, `isVerifiedHost`, `hostLevel`, with `hostApplications`/`hostVerification` as supporting docs. Agencies/Sellers are Mongo `partners` rows mirrored to Firestore docs with auto ids.

**Money split (confirmed):** Mongo ledger is authoritative for CRM money (recharge, coin purchase, lending, sales, commission, admin cards). Firestore is authoritative for gifts, calls, bean conversion, weekly release, and the debit side of withdrawals and refund clawbacks.

**Scheduled jobs:** `sweepStaleCalls`/`sweepEmptyPartyRooms` (1 min), `scheduledTransactionalSweep` (15 min), `scheduledAlertScan` (30 min), `expireCosmetics` (hourly), `sweepHostLevels` 02:00 IST, `scheduledReconciliation` 03:00 IST, `purgeDeletedAccounts` 03:30 IST, `sweepQuickLoginTokens` 04:30 IST, `releaseBeansForWeek` Mon 00:30 IST, `weeklyPayoutReportGenerator` Sun 18:29 UTC, plus daily/weekly/monthly reports and partner statements.

**Documentation found:** `CRM-FLOW.md` (operating spec), `docs/phase-0/ZIPPER-Phase-0-Documentation.md` (as-is with GAP-xxx), `ECONOMY-CONTRADICTIONS.md`, `APP-CRM-MISMATCH.md`, `HOST-VERIFICATION-AND-GIFT-PRIVACY.md`, `ZIPPER_MASTER_ROADMAP.md`, `backend/ARCHITECTURE.md`, `docs/workstream-0/*`.

---

## C. Requirement compliance matrix

| # | Requirement | Current behaviour | Status | Evidence | Correction |
|---|---|---|---|---|---|
| 1 | Guest returns to same account on same device | Works via device binding + secret; but any uid can be bound to any device | PARTIAL | `functions/src/identity.ts:320,410`; `guestBinding.ts:214-237` | AUTH-001 |
| 2 | One guest identity per device | Enforced per device; no reverse uid→device uniqueness | PARTIAL | same | AUTH-001 |
| 3 | Guests cannot apply for partner roles before binding contact | No guest check in callables, backend, rules, `activateHost` | FAIL | `index.ts:4179-4233`; `partner_applications.py:238-294`; `storage.rules:173-177` | AUTH-002 |
| 4 | Guest → registered binding keeps uid/balance/history | `linkWithCredential` keeps uid | PASS | `AuthRepository.kt` link paths | — |
| 5 | One human = one canonical identity across Google/phone/email | Each method can mint a separate uid; only Google→email-link auto-merges | PARTIAL | `identity.ts:971-1052`; `lib/auth.ts:1085` | AUTH-005, IDENTITY-001 |
| 6 | Bound contact cannot be changed freely; Feedback → authorize → OTP → release | No such flow; contact fields directly writable by owner | FAIL | `firestore.rules:1201-1304`; `EditProfileScreen.kt:249` | CONTACT-001/003 |
| 7 | Contact uniqueness | Enforced only in `bindVerifiedIdentity`; bypassed by direct writes and typed phone attach | PARTIAL | `identity.ts:816-956`; `partner_applications.py:573-584` | CONTACT-001/002 |
| 8 | One active mobile session per account | Written, not enforced (flag off, app never sends sessionId) | FAIL | `mobileSession.ts:139-150`; `MoneyFunctions.kt:610` | SESSION-001 |
| 9 | Logout signs out Firebase, closes session, keeps Quick Login | Yes | PASS | `AuthRepository.kt:2789-2836` | — |
| 10 | Suspended/banned/deleted can't obtain or reuse credentials | Ban: yes (disabled + tokens revoked). Suspend: Firebase stays enabled. Delete-request: stays signed in | PARTIAL | `users.py:659` vs `:929-1059`; `accounts.ts:294-308` | SESSION-002/003 |
| 11 | Cold start rechecks account/device state and fails closed | Rechecks, but device-ban read and generic errors fail open | PARTIAL | `SplashScreen.kt:96-100, 290-291` | AUTH-003 |
| 12 | Suspension blocks account only; ban bans account + device; ban follows to new device | Implemented this way | PASS | `users.py:557-696`; `identity.ts:1306` | (staff-handset caveat SECURITY-011) |
| 13 | Unban restores access without restoring revoked roles | Unban touches no partner records | PASS | `users.py:762-860` | — |
| 14 | Eligibility matrix (Host/Agency/Sub/Seller) | Table matches policy cell-for-cell, but evaluated per login, not per human | PARTIAL | `partner_applications.py:87-96, 183-295` | ROLE-001 |
| 15 | Host + Agency forbidden; one main Agency per human | Reachable via second login / public signup / direct rule writes | FAIL | ROLE-001, SECURITY-003/004 | — |
| 16 | Host+Sub-agency keeps `users.agencyId` separate from own agency | `ownAgencyId` used | PASS | `crm_directory.py:715-733`; `social.ts:153-167` | — |
| 17 | Claims follow `{role, aid}` and don't overwrite other roles | Single claim per login; dual-role loses second capability's storage access | PARTIAL | `storageClaims.ts:149-181` | ROLE-008 |
| 18 | Eligibility enforced server-side, not bypassable by direct writes | Bypassable via rules (agencies/sellers create, `users.isHost` staff writes, hostApplications applicant update) | FAIL | SECURITY-002/003/004 | — |
| 19 | Revoking a role removes only that role's permissions immediately | Backend flags correct; Firestore rules + CRM routing ignore per-role status | PARTIAL | `firestore.rules:67-72`; `partnerRouting.ts:164` | SECURITY-005, CRM-004 |
| 20 | Revocation preserves other roles, history, balances | Mostly yes | PASS (with ROLE-005/006 caveats) | `partner_ops.py:1668-1770` | — |
| 21 | Every revoked role restored only via role-specific appeal → admin recommendation (mandatory note) → Owner final decision | Does not exist | FAIL | `appeals.py` (only `ban`/`report` kinds) | RESTORE-001 |
| 22 | Admin recommendation never auto-restores | Ops admin can restore directly (Approve / reactivate / re-decide / reapply) | FAIL | `partner_ops.py:2875-2914, 3243-3256`; `users.py:1634-1716` | RESTORE-002..005 |
| 23 | Agency/Sub-agency revoke: transfers via separate authorized process | Transfers happen automatically inside the revoke call; host-move failures swallowed | FAIL | `partner_ops.py:3409-3501, 3487` | RESTORE-007/008 |
| 24 | Pending money not auto-cancelled/approved/settled on revoke; reviewed separately | Left live and still executable; no review queue | FAIL | `partner_ops.py:4234, 5021`; `recharges.py:326-404` | FINANCE-011 |
| 25 | Ban appeal: description, image/video evidence, contact that must match account, clear mismatch error | Description + images only; no contact field/verification; no video | PARTIAL | `firestore.rules:2526-2529`; `quickLogin.ts:694+` | APPEAL-003 |
| 26 | Ban appeal: CRM review, notes, notification, audit | Review + audit yes; no outcome notification; note field mismatch; non-atomic; four-eyes broken | PARTIAL | `appeals.py:260-444` | APPEAL-001/004/005 |
| 27 | 60-day deactivation, reactivate or new profile, history retained | Default 60 (env-overridable); reactivate/new works; history retained | PASS | `accounts.ts:89, 150, 206` | doc fix DEACT-003 |
| 28 | Expiry cleanup | Purge job re-selects purged accounts and stalls after 50 | FAIL | `accounts.ts:206-229, 425-430` | DEACT-001 |
| 29 | Exactly one permanent Observer; Owners cannot manage/replace it | Owner can change Observer's role or deactivate it | FAIL | `staff.py:746-783, 859-869` | STAFF-002/003 |
| 30 | Observer CRM-only, cannot open app | Server returns `observer_denied` but leaves the login; enforcement relies on client | PARTIAL | `identity.ts:1214-1239`; `AuthRepository.kt:2093` | AUTH-006 |
| 31 | Only Observer creates/deletes Owners | Owners can invite Owners and deactivate Owners; Observer can't deactivate | FAIL | `staff.py:158-168, 284-289, 859-869` | STAFF-001/003 |
| 32 | Owners manage dept Admin/Member roles | Yes, but with no limits on target/new role | PARTIAL | `staff.py:746` | STAFF-002 |
| 33 | Staff never get partner roles | Blocked on partner paths; role change can set `agency`/`seller` | FAIL | `routers/staff.py:65`; `core/roles.py:41-42` | STAFF-002 |
| 34 | Staff cannot suspend/ban/deactivate/delete own profile | Self-moderation blocked; **app self-delete allowed** and kills CRM login | PARTIAL | `users.py:184-215`; `accounts.ts:270-317` | STAFF-005 |
| 35 | Owner count not hardcoded to 3 | No enforced count; "three" appears in comments/labels and in the reset planner's allowlist check | PASS (code) / note | `roles.py:24`; `scripts/plan_test_data_reset.py` | Q-7 |
| 36 | User Level weights: calls & normal/exclusive gifts 100%, lucky 3%, gaming 1% | Level never computed; `totalGemsSpent` +100% for all gifts incl. lucky; calls/games add nothing; unused client engine uses 1% lucky | FAIL | `gifts.ts:264`; `calls.ts:394,498`; `LevelEngine.kt:44-52` | LEVEL-001/002 |
| 37 | Host Level not shown indiscriminately | `hostLevel` copied to world-readable `publicProfiles` | FAIL | `profiles.ts:97`; `firestore.rules:1117` | LEVEL-003 |
| 38 | Host Level from call+gift gem earnings | `hostCallEarnings + hostGiftEarnings` vs `levelConfig/host` | PASS (formula) / PARTIAL | `hostStats.ts:52-114, 280-319` | LEVEL-004 |
| 39 | 5 CRM-configurable user daily tasks (10–50 💎) | Not implemented | FAIL (missing) | no code | TASK-001 |
| 40 | Host daily tasks with bean rewards | Not implemented | FAIL (missing) | no code | TASK-002 |
| 41 | Recharge reference uniqueness | Unique partial index per seller | PASS | `mongo.py:150-193` | (per-seller only) |
| 42 | Refund retry never double-debits | Retry path idempotent; refuse-after-partial path allows a second clawback | PARTIAL | `firebase.py:401-439`; `recharges.py:543-618` | FINANCE-003 |
| 43 | Ledger divergence detected | Reconciliation broken; no `replica_stale` repair/alert | FAIL | `reconcile.py:52,100`; `money.py:201-221, 303-310` | FINANCE-001/002 |
| 44 | Payment proof belongs to buyer | Server accepts any https URL | FAIL | `recharges.py:224-230` | FINANCE-013 |
| 45 | Commission progressive slabs per documented rules | Progressive/marginal implemented; docstrings say flat; CRM shows top-band rate | PASS (formula) / doc mismatch | `commission.py:296-573`; `CRM-FLOW.md` §4 | FINANCE-010 |
| 46 | Admin balance changes audited | Card workflow + audit + owner execute | PASS | `users.py:2107-2255` | sufficiency bug FINANCE-004 |
| 47 | Credentials not exposed | Agora cert in pushed history/APKs/plain env; SendGrid plain env + prefix logged | FAIL | SECURITY-001 | rotate (separate action) |

---

## D. Findings register

Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO. "Fix" lines are recommendations only.

### AUTH — authentication

**AUTH-001 · Guest account takeover via `claimGuestIdentity`** — CRITICAL · CONFIRMED
- Where: `functions/src/identity.ts:293-500` (`wanted = data.uid` at :320, never compared to `context.auth.uid`; `context.auth` used only for `callerIsBoundUid` at :410); `functions/src/guestBinding.ts:214-237` (unbound device + any non-upgraded uid → `bound`).
- Current: Unauthenticated callable. Caller sends a fresh `deviceId`, own secret, and `uid=<victim guest uid>` → binding written for the victim's uid; second call returns `existing_guest` + `createCustomToken(victim)`.
- Expected: a uid can only be bound by a caller authenticated as that (fresh, anonymous, data-less) uid; one uid ↔ one device.
- Scenario: victim uid harvested from `publicProfiles`, chat, viewer lists → attacker signs in as the victim with their diamonds/history. **Amplified by the 2026-10-08 Option-B change** (`guestBinding.ts` upgraded branch now returns a token when the secret matches), so the takeover persists after the victim binds email/phone.
- Verify safely: unit test in `functions/test/guestBinding.test.js` and an emulator test calling the callable with a mismatched `context.auth`.
- Fix: require `context.auth.uid === wanted` (and anonymous provider) for every bind; add reverse index `guestUidBindings/{uid}`; refuse binding a uid already bound elsewhere.

**AUTH-002 · Guests can apply for partner roles** — HIGH · CONFIRMED
- Where: callables `functions/src/index.ts:4179-4233` (only `requireUid`); `backend/app/services/partner_applications.py:238-294, 465-469, 635-639`; rules `firestore.rules:830-837, 1898-1906`; `functions/src/hosts.ts:162-224, 564-565`; `storage.rules:173-177` (`isNonGuest` treats `custom` sign-in as non-guest).
- Fix: server-side guest check from Auth `providerData` in `eligible_kinds`, callables, `activateHost`, and rules; base `isNonGuest` on a claim.

**AUTH-003 · Cold start/resume fails open** — HIGH · CONFIRMED
- Where: `zipper-app/.../SplashScreen.kt:96-100` (device-ban read error ignored), `:86` (`exists()` ignores `isActive:false`), `:252` (displacement check skipped when local id blank), `:290-291` (any exception → Main). `SplashViewModel` only syncs roles; it does not call `resolveIdentity`.
- Fix: call `resolveIdentity(deviceId)` with the same one-retry-then-refuse logic as `gateIdentity` (`AuthRepository.kt:2052-2090`).

**AUTH-004 · Quick Login shows suspended users the "banned" message** — MEDIUM · CONFIRMED
- Where: `functions/src/quickLoginPolicy.ts:204` checks `isBanned` before `isSuspended` (:208); suspension always sets `isBanned=true` (`users.py:1003`). Test only uses `{isSuspended:true}` (`quickLoginPolicy.test.js:174`). (Token is still refused — correct.)

**AUTH-005 · One human can still end up with several uids** — MEDIUM · CONFIRMED
- Where: phone OTP/Google/email/guest each mint their own uid; only `adoptEmailAccount` (`identity.ts:971-1052`) merges Google→email. `createUserDocument` runs before `gateIdentity` (`AuthRepository.kt:1274, 1351, 1395`) despite comments saying the gate comes first.
- Fix: when a new uid's token carries a phone/email already held by a live account, route to "sign in to existing" (email only, as with adoption — phone needs a policy decision because numbers recycle); move doc creation after the gate.

**AUTH-006 · Observer app-block depends on the client** — MEDIUM · LIKELY
- Where: `identity.ts:1214-1239` returns `observer_denied` but does not delete/disable the login; only Android deletes it (`AuthRepository.kt:2093-2106`). Other callables don't check the Observer email.
- Fix: delete/disable server-side; shared observer guard on money callables.

### SESSION — sessions and invalidation

**SESSION-001 · One-active-mobile-session not enforced** — HIGH · CONFIRMED
- Where: `functions/src/mobileSession.ts:139-150` (no-op when `ENFORCE_MOBILE_SESSION` unset / no `sessionId`); app sends `sessionId` only to `endMobileSession` (`MoneyFunctions.kt:610`); only 4 callables call the check; rules use `sessionCurrent()` only on 3 paths (`firestore.rules:2267, 2279, 2430`); `startMobileSession` lets a displaced device move `credentialsValidAfter` back (`identity.ts:1496-1524`); `mintQuickLoginToken` has no displacement check (`quickLogin.ts:167-230`).
- Fix: monotonic `credentialsValidAfter`; client sends `sessionId`; turn enforcement on for all money/social callables and owner writes.

**SESSION-002 · Suspension doesn't cut Firebase access** — HIGH · CONFIRMED
- Where: `backend/app/services/users.py:929-1059` never disables/revokes; `notBanned()` gates only 3 rules. Combined with IDENTITY-002 the suspension can be erased by the user.
- Fix: revoke refresh tokens + `restricted` claim on suspend; apply a restriction check to all user-originated writes and callables.

**SESSION-003 · Deletion request leaves the account signed in; `isDeleted` is owner-writable** — MEDIUM · CONFIRMED
- Where: `functions/src/accounts.ts:294-310` clears `activeMobileSession` only; no `revokeRefreshTokens`, no `credentialsValidAfter` bump; `isDeleted` absent from owner-protected fields.

**SESSION-004 · Device ids are client-supplied and trusted** — MEDIUM · CONFIRMED
- Where: `identity.ts:1439-1444, 1676-1713` store any `deviceId`; quick-login redeem checks the request's deviceId, not the credential's stored one (`quickLogin.ts:333`); `claimGuestIdentity` likewise. Ban cascades can be aimed or dodged.
- Fix: use credential-bound device id; consider Play Integrity.

**SESSION-005 · Banned partner keeps working CRM session up to 7 days** — MEDIUM · CONFIRMED
- Where: `backend/app/core/account_state.py:236-266` reads only Mongo `partners`/`staff`; renewal doesn't re-check Firebase `disabled`. TTL `backend/app/config.py:50`.

### CONTACT — contact information

**CONTACT-001 · Users can write their own `email` / `phoneNumber`** — CRITICAL · CONFIRMED
- Where: `firestore.rules:1201-1304` (owner-protected list has `phoneKey` but not `email`, `phoneNumber`, `phone`, `isDeleted`); create rule `:1164-1171`; `syncPhoneKey` derives `phoneKey` from the forged number (`identity.ts:745-776`); ProfileSetup writes typed values (`AuthRepository.kt:2308, 2312`).
- Impact: squats victims' contacts (their later `bindVerifiedIdentity` fails as `active_holder`); `activateHost` reads contact from the doc (`hosts.ts:552-561`) so a known invite can be redeemed by the wrong person; `resolveIdentity` treats doc fields as satisfying `requiresPhone/Email`; guest status flips.
- Fix: protect these fields; set only via verified link + `bindVerifiedIdentity`; `identityFor` uses token claims only.

**CONTACT-002 · Partner application attaches an unverified typed phone to the Firebase login** — CRITICAL · CONFIRMED (code path)
- Where: `partner_applications.py:573-584` → `crm_directory.py:1120` `_attach_app_identity` → `firebase.update_user_phone` (`:852-854`), on a *pending* application.
- Impact: token now carries an unproven `phone_number`; satisfies proof checks in `findExistingAccount`/`bindVerifiedIdentity`; a later OTP sign-in with that number lands in the applicant's account.
- Fix: never set Auth phone from form input; require OTP or token-proven phone; don't attach while pending.

**CONTACT-003 · No authorized contact-change workflow** — MEDIUM · CONFIRMED (missing)
- Where: `EditProfileScreen.kt:249-252` says "Contact support"; no Feedback-authorization + new-contact OTP + old-contact release flow exists. `firebase.clear_user_phone` (`backend/app/db/firebase.py:176`) is ad hoc.

**CONTACT-004 · Setup Profile email-uniqueness check is dead code** — MEDIUM · CONFIRMED
- Where: `AuthRepository.kt:2248-2263` runs a `list` query on `users`; `list` is `isStaff()` only (`firestore.rules:1157`); exception swallowed.

### IDENTITY — canonical identity and records

**IDENTITY-001 · Partner signups create a separate email/password identity** — HIGH · CONFIRMED
- Where: `zipper-crm/lib/auth.ts:1085-1110` (`createPartnerLogin`) used by `/agency-signup`, `/seller-signup`, `/agencies/register`, `/sellers/register`; `createSubAgencyAccount` (`lib/auth.ts:1401`); `attach_login` may `create_user` with a random password (`partner_ops.py:1101-1122`). Repair (`attach_phone_to_login`, `crm_directory.py:490`) only logs conflicts.
- Impact: same human = two uids → eligibility evaluated per login (ROLE-001), app and CRM roles diverge (NO_USERS_DOC cases), notices sent to a uid the app never uses.

**IDENTITY-002 · Delete-and-recreate the `users` doc bypasses protected fields** — CRITICAL · CONFIRMED
- Where: `firestore.rules:1158` `allow delete: if isOwner(uid) || isAdmin()`; create denylist `:1164-1171` omits `accountState`, `isSuspended`, `suspendedUntil`, `crmRole`, `isOfficial`, `isAgent`, `phoneKey`, `deviceId`, `credentialsValidAfter`, `activeMobileSession`, `callRateBeans`, `wealthLevel`, etc.
- Scenario: suspended user deletes + recreates doc without restriction fields; can self-set `crmRole`/`isOfficial` (staff/official badge), `credentialsValidAfter:0`.
- Fix: `delete` admin-only (deletion via callable); create as an allowlist.

### SECURITY — access control and credentials

**SECURITY-001 · Agora certificate leaked and unrotated; secrets deployed as plaintext env** — CRITICAL · CONFIRMED
- Locations (no values): `functions/.env` (Agora certificate, SendGrid key; read via `process.env`, deployed as plain function env — visible in `gcloud functions describe`); git history commit `0491f23` on pushed branch `archive/v4-production` (same Agora value); `zipper-app/build/published/debug/*/{12,13,14}.apk` (`classes.dex`); `zipper-app/local.properties:17` and Gradle cache (ignored). `functions/src/index.ts:38` logs the SendGrid key's first 6 characters. Same SendGrid key used by backend and functions. Backend Mongo URI/JWT/SendGrid in `backend/.env` are ignored and deployed via Secret Manager (OK). `serviceAccountKey.json` at repo root is ignored, never committed (keep it that way).
- Fix (separate remediation action, not performed): rotate Agora certificate and SendGrid key; move to `defineSecret`; purge history or make repo private and delete the archive branch; delete published APKs containing the certificate; remove the key-prefix log.

**SECURITY-002 · Applicant can self-approve a host application** — CRITICAL · CONFIRMED
- Where: `firestore.rules:1034-1038` applicant clause blocks only `isActivated`, `activatedByUid` and `reapprovalFields()` (payout + identity fields) — **`status` and `referralCode` are writable**; `activateHost` checks only `app.status === 'approved'` + contact match (`hosts.ts:279`).
- Scenario: self-applicant writes `{status:'approved', referralCode:'X'}` → `activateHost('X')` → Host, roster row, call rate; can also repoint `agencyId` and swap `photoUrl` (re-triggers verification).
- Fix: applicant may write only a whitelist of harmless fields; `activateHost` requires server-stamped decision fields; self-applications activate only via backend decision.

**SECURITY-003 · Unauthenticated / any-CRM agency and seller creation with arbitrary owner and status** — HIGH · CONFIRMED
- Where: `firestore.rules:829-837` (agencies), `~1898-1906` (sellers): `request.auth == null` + `source=='self_signup'` or any `isCrmUser()` with no constraint on `ownerUid`/`crmUid`/`status`; backend takes owner from `ownerUid` (`partner_ops.py:855-859`), claims role family for that uid, and on approval attaches the doc's phone to the victim's login (`:372-373`).
- Fix: pin `ownerUid == request.auth.uid` (or absent), `status == 'pending'`; move creation behind the API.

**SECURITY-004 · Every staff tier can write role fields on `users` directly** — HIGH · CONFIRMED
- Where: `firestore.rules:1361-1410` (`staffProtectedFields` lacks `isHost`, `agencyId`, `isSeller`, `callRateBeans`, `level`, `role`, `isLive`), update at `~1436`; CRM `/hosts` "Remove host" → `lib/firestore.ts:506` `updateDoc({isHost:false})` (`app/hosts/page.tsx:617, 969`); `makeHost` still exported.
- Impact: any `support_member`/`marketing_member` can grant/revoke Host without matrix check, audit, roster, verification or notification.

**SECURITY-005 · `isAgencyCrmUser()` ignores per-role status** — HIGH · CONFIRMED
- Where: `firestore.rules:67-72`; `partner_ops.py:1744-1770` keeps `isActive:true`, `roles` and `agencyId` while another role (Seller) is live.
- Impact: revoked/suspended Agency on an Agency+Seller login keeps reading host KYC/bank/DOB in `hostApplications`, editing its agency doc, creating invitations and appeals.
- Fix: require `roleStatus.agency` approved (pending only for own-KYC paths).

**SECURITY-006 · Seller storage paths keyed on uid; seller docs have auto ids; single claim** — MEDIUM · CONFIRMED
- Where: `storage.rules:152-155, 560-571, 629-635`; `BuyInventoryDialog.tsx:222`; `seller-signup/page.tsx:558`. Tests assume docId==uid (`tests/storage.rules.test.mjs:162`).

**SECURITY-007 · Payment-proof URL not validated** — MEDIUM · CONFIRMED (= FINANCE-013)

**SECURITY-008 · Appeals create rule too loose** — MEDIUM · CONFIRMED
- Where: `firestore.rules:2526-2548`: agency may appeal any `subjectUid`; `raisedByRole`, `raisedByName`, `originalDecidedBy` client-chosen; no pending cap on the rule path.

**SECURITY-009 · Agency claim can overwrite host KYC; unlimited sub-agency KYC files** — LOW · CONFIRMED
- Where: `storage.rules:428-463` (`write` includes overwrite). Pending-agency claim itself is intentional and scoped (`storageClaims.ts:113, 150-180`).

**SECURITY-010 · `publicSellers` publishes phone and UPI to any signed-in user incl. guests** — LOW (by design) · CONFIRMED
- Where: `firestore.rules:1821-1824`; `functions/src/publicSeller.ts:40-65`. Needs product decision (Q-5).

**SECURITY-011 · Staff handset can be device-banned** — HIGH · CONFIRMED
- Where: `backend/app/routers/users.py:197` (`manual` caller-controlled) → `services/users.py:~2609` skips the staff check when `manual=false`; ban cascade from an ordinary account seen on a staff phone bars that phone; Functions also bar the device in use (`identity.ts:1306`).

**SECURITY-012 · Staff can rewrite partner owner links** — MEDIUM · CONFIRMED
- Where: `firestore.rules:~886` agencies `allow update: if isAdmin() || …` with no field restriction (`crmUid`/`ownerUid`).

**SECURITY-013 · Level/config writable by all of Tech** — LOW · CONFIRMED
- Where: `firestore.rules:1658, 1717` use `isTech()` (includes `tech_member`).

### ACCT — account-level actions

**ACCT-001 · Suspending a banned account silently undoes the ban** — HIGH · CONFIRMED
- Where: `backend/app/services/users.py:~978-1017` (no restriction precheck); reachable via API and report actions (`:2880`). CRM hides the button and its comment wrongly claims server refusal (`zipper-crm/lib/crmRoles.ts:166`). Resume then shows "active" while Firebase stays disabled; device bans orphaned.

**ACCT-002 · Ban/suspend overwrite deletion states; resume shows Active on deleted account** — LOW · CONFIRMED (`users.py`; `UserActions.tsx:463`)

**ACCT-003 · Report actions are read-then-write (double action / double audit)** — LOW · CONFIRMED (`users.py:2852-2928`)

**ACCT-004 · Refused attempts are not audited** — LOW · CONFIRMED (`core/audit.py:299`; no audit on `ProtectedTarget`/`StaffError`)

### ROLE — partner roles and eligibility

**ROLE-001 · Eligibility is per login, not per human** — HIGH · CONFIRMED
- Where: `held_roles` reads by login uid (`partner_applications.py:183-235`); IDENTITY-001 creates new logins. Host under Agency X can register Agency Y via `/agency-signup` with another email; approval finds nothing.

**ROLE-002 · `activateHost` checks only `crmUsers/{appUid}` and not the inviting agency's status** — MEDIUM · CONFIRMED (`hosts.ts:196-203`; `crmRoles.ts:176-189`)

**ROLE-003 · Reject works on approved/suspended/revoked partners** — HIGH · CONFIRMED
- Where: `partner_ops.py:3096-3110` refuses only already-rejected; CRM shows Reject whenever `status !== 'rejected'` (`app/agencies/[id]/Client.tsx:458`, `app/sellers/[id]/Client.tsx:347`, `app/agencies/page.tsx:512`). Rejecting a live agency skips dependent transfer, resets `kycStatus`, overwrites revoke history, sends "application rejected".

**ROLE-004 · Suspend→reactivate approves a rejected or pending record** — HIGH · CONFIRMED
- Where: `deactivate_partner` refuses only already-suspended (`partner_ops.py:3184-3190`); `reactivate_partner` refuses only rejected (`:3243-3256`); `_fs_status_fields` defaults `verified_documents=True` (`:3292`). Skips approval steps (referral code, virtual account, second-role grant, session remint).

**ROLE-005 · Revoking a second capability leaves `linked_partner_id`** — MEDIUM · CONFIRMED
- Where: `revoke_partner` never calls `_write_second_role_state` (`:1786`) nor clears the link (reject does, `:2225-2235`) → `grant_second_capability`/`request_second_role` refuse forever (`:1911, :2070`); stale `isSeller`/`linkedSellerId`.

**ROLE-006 · Re-applying for Agency flips a live Seller login to "pending"** — MEDIUM · CONFIRMED (`crm_directory.py:1063-1077`)

**ROLE-007 · Session revocation is per human, not per role** — LOW · CONFIRMED (`partner_ops.py:1659`)

**ROLE-008 · Single storage claim per login; backfill ignores per-role status** — MEDIUM · CONFIRMED
- Where: `storageClaims.ts:173-177`; `backend/scripts/backfill_storage_claims.py:196-258` re-grants `agency` with a revoked `aid`.

**ROLE-009 · "Seller status removed" on user page only flips `users.isSeller`** — LOW · CONFIRMED (`UserActions.tsx:570`; `users.py:2022`; reverted by `syncMyRoles`)

**ROLE-010 · Host revoke is incomplete** — HIGH · CONFIRMED
- Where: `users.py:1507-1555` patches only `isHost` (+ stamps): roster row `agencies/{id}/agencyHosts/{uid}` stays; `isVerifiedHost` stays (badge/VIP ring still shown: `ProfileScreen.kt:114,124`, `OtherUserProfileScreen.kt:228`, `MyProfileScreen.kt:99`); `isLive`/`callRateBeans` not cleared; per-tick accrual has no `isHost` gate (`calls.ts:405`). Weekly report counts revoked hosts (`index.ts:1065-1100`); re-grant under agency B leaves A's roster row → host counted in both reports.

**ROLE-011 · Revoked host: earnings hidden; re-entering code reports false success** — MEDIUM · CONFIRMED
- Where: `getHostHome` refuses non-hosts (`hostStats.ts:217`); earnings entry hidden (`MyProfileScreen.kt:220`); `activateHost` returns `alreadyActivated:true` without setting `isHost` (`hosts.ts:248-260`) and Android maps it to success (`AuthRepository.kt:2484`).

**ROLE-012 · Host notifications not idempotent / duplicated** — LOW · CONFIRMED
- Where: `host_revoked_{uid}_{epochSeconds}` (`notices.py:282`); rejecting an already-Host applicant sends revoke + reject notices (`users.py:1747-1750, 1802-1806`); reactivation re-sends "You're approved" email (`index.ts:1665`, `:2457`); staff-granted second role fires "application received" (`.add()` at `partner_ops.py:2026`).

**ROLE-013 · Legacy partner records without `owner_crm_uid` mishandled** — LOW · LIKELY (`partner_ops.py:1659, 1681, 3568`)

### RESTORE — role restoration and revocation transfers

**RESTORE-001 · Role-specific restoration appeal + Owner final decision does not exist** — CRITICAL (business rule) · CONFIRMED (missing)
- Where: `backend/app/services/appeals.py` supports only `ban`/`report`; no recommendation/Owner-decision state anywhere.

**RESTORE-002 · Approve button restores revoked records** — CRITICAL · CONFIRMED
- Where: CRM shows Approve when `status !== 'approved'` (`app/agencies/[id]/Client.tsx:450`, `app/sellers/[id]/Client.tsx:339`); `approve_partner` (`partner_ops.py:2875-2914`) has no revoked guard; permission `CAN_APPROVE_KYC`/`CAN_APPROVE_SELLER` (ops_admin suffices).

**RESTORE-003 · `reactivate_partner` accepts revoked records** — CRITICAL · CONFIRMED (`partner_ops.py:3243-3256`)

**RESTORE-004 · Re-deciding an old host application re-grants Host** — HIGH · CONFIRMED (`users.py:1634-1716`, no status guard)

**RESTORE-005 · Reapply after revocation is open for every role** — HIGH · CONFIRMED (revoked releases the family slot: `partner_roles.py:381`; `partner_ops.py:3617-3619`)

**RESTORE-006 · Re-granted host is verified immediately** — MEDIUM · CONFIRMED (`users.py:1447-1467` keeps `verified`; `isVerifiedHost` never cleared)

**RESTORE-007 · Dependent transfers are automatic, inside revoke, by one actor** — MEDIUM (business-rule conflict) · CONFIRMED (`partner_ops.py:3409-3501`)

**RESTORE-008 · Failed host moves are swallowed; revoke completes** — HIGH · CONFIRMED (`partner_ops.py:3476-3488`; `_hosts_of` returns `[]` on read failure `:3383`)

### APPEAL — account-ban appeals

**APPEAL-001 · Four-eyes check trusts a client field** — HIGH · CONFIRMED (`originalDecidedBy` written `''` by app `AppealRepository.kt:179` and `quickLogin.ts:834`, client-settable `firestore.rules:2529`, trusted `appeals.py:308`)

**APPEAL-002 · Agency can appeal for any user with any report id** — HIGH · CONFIRMED (`firestore.rules:2546`; `decide_appeal` doesn't validate subject/report)

**APPEAL-003 · No contact field, contact-ownership check, or video evidence** — MEDIUM · CONFIRMED (missing) (`firestore.rules:2526-2529`; evidence URLs unvalidated and rendered as links `operations/appeals/page.tsx:326`)

**APPEAL-004 · Decision not atomic** — MEDIUM · CONFIRMED (`appeals.py:296-444`)

**APPEAL-005 · No outcome notification; note field mismatch; duplicate pending appeals** — MEDIUM · CONFIRMED (no appeal notice in `notices.py`; `quickLogin.ts:929` reads `decisionNote`, backend writes `decisionReason`; pending check read-then-write `quickLogin.ts:811`)

**APPEAL-006 · AI face match can verify a host without CRM decision** — MEDIUM (dormant) · CONFIRMED (`hosts.ts:698-703, 734-739`; currently `compareFaces` returns null so all go manual; a CRM-rejected host can resubmit)

**APPEAL-007 · `app_member` can decide appeals (`CAN_BAN_USERS`)** — LOW · CONFIRMED (`routers/users.py:~480`) — see Q-6

### STAFF — internal staff

**STAFF-001 · Owners can create Owners** — HIGH · CONFIRMED (`backend/app/services/staff.py:158-168` returns `[Role.OWNER, …]` for Owner; invite check `:284-289`)

**STAFF-002 · Role change has no limits on target or new role** — CRITICAL · CONFIRMED
- Where: `staff.py:746-783` checks only actor==Owner; `RoleChange.role: Role` accepts `owner`, `observer`, `agency`, `seller` (`routers/staff.py:65-67`; `core/roles.py:41-42`).
- Scenarios: change Observer record's role → Observer sign-in (`core/security.py:1236` requires role `observer`) locked out permanently; demote self/last Owner; set staff to `agency`/`seller` (loses staff protection, can then be banned).

**STAFF-003 · Owners deactivate Owners and the Observer; Observer cannot deactivate anyone** — HIGH · CONFIRMED (`staff.py:859-869`, `manages()` `:105`; Observer refused by `require_write` `deps.py:376`)

**STAFF-004 · No staff reactivation** — MEDIUM · CONFIRMED (missing in `routers/staff.py`)

**STAFF-005 · Staff (and partners) can self-delete in the app, destroying their CRM login** — HIGH · CONFIRMED (`functions/src/accounts.ts:270-317, 243`; `SettingsScreen.kt:318`)

### DEACT — deactivation

**DEACT-001 · Purge job starves after 50 purged accounts** — HIGH · CONFIRMED (`accounts.ts:206-229` keeps `isDeleted:true`, never clears `deletionDueAt`; query `:425-430` `limit(50)` ordered by due date)

**DEACT-002 · Expired-but-unpurged account treated as new signup on same uid** — HIGH · LIKELY (`identity.ts:1342` returns `deleted_permanent`; app proceeds as normal sign-in `AuthRepository.kt:2131`; old balances/history/contacts still attached)

**DEACT-003 · Grace period docs say 30 days; code defaults to 60 (env-overridable)** — LOW · CONFIRMED (`accounts.ts:89` vs comments `:35-39, 324, 409`, Phase-0 §6)

**DEACT-004 · No audit for deletion/recovery/purge** — LOW · CONFIRMED (logger only)

### LEVEL / TASK

**LEVEL-001 · User level is never computed (always 0)** — HIGH · CONFIRMED (no writer of `totalXp`/`level`; `LevelScreen.kt:105`; CRM note `app/users/[uid]/Client.tsx:219`)

**LEVEL-002 · Spend weights wrong where they exist** — HIGH · CONFIRMED (`gifts.ts:264` +100% for all gifts incl. lucky; calls `calls.ts:394,498` and games `backend/app/services/chance.py` add nothing; unused `LevelEngine.kt:44-52` uses 1% lucky)

**LEVEL-003 · Host level world-readable** — MEDIUM · CONFIRMED (`profiles.ts:97`; `firestore.rules:1117`)

**LEVEL-004 · Host level includes pre-host gift earnings; app uses a different field** — LOW · CONFIRMED (`gifts.ts:269`; `LevelScreen.kt:142` uses `totalBeansEarned`)

**LEVEL-005 · No Owner level-adjust tool** — LOW · CONFIRMED (`setUserLevel` has no caller)

**TASK-001 · User daily tasks not implemented** — HIGH (missing) · CONFIRMED
**TASK-002 · Host daily tasks not implemented** — HIGH (missing) · CONFIRMED (`dailyStats` tracks call seconds/count/beans per IST day — reusable; no live/party minutes)
**TASK-003 · Daily login reward lacks eligibility checks/audit** — LOW · CONFIRMED (`wallet.ts:194-277`: no session, ban/suspend/deleted check; no audit of schedule edits)

### CRM — screens and actions

**CRM-001 · Action buttons shown in wrong states** — HIGH · CONFIRMED (Approve on suspended/revoked; Reject on live; no Reactivate/Restore on revoked; approved+inactive agency has no actions `agencies/[id]/Client.tsx:450-489`; list page lacks `revoked` filter `agencies/page.tsx:760-765`; user page offers Revoke host/Remove seller to non-holders `UserActions.tsx:317-378`; Ban/Suspend offered on deleting accounts `crmRoles.ts:90-97`; no reviewer-permission gating)

**CRM-002 · CRM writes Firestore directly, bypassing backend workflow** — HIGH · CONFIRMED
- `/hosts` remove host (`lib/firestore.ts:506`); host edits `lib/pendingChanges.ts:386-426`; `/agencies/[id]/salary` approve/pay/reject (`Client.tsx:116,129,155`); `/finance/payouts` approve/reject reports (`lib/finance.ts:89-102`); `/finance/withdrawals` legacy approve/markPaid/reject (`lib/firestore.ts:580-608`); `/approvals` (`lib/approvals.ts:115-136`); register pages `addDoc` agencies/sellers; agency-dashboard sub-agency creation (`page.tsx:1750`) and `hostApplications`/`salaryRequests` writes; `requestSecondRole` (`lib/partnerRoles.ts:228-278`).

**CRM-003 · Revoked/suspended primary Agency still routed to `/agency-dashboard`** — HIGH · CONFIRMED (`zipper-crm/lib/partnerRouting.ts:164-166`; dashboard has no status gate)

**CRM-004 · Android shows suspended/revoked agency as "Pending"** — LOW · CONFIRMED (`AgencyDashboardScreen.kt:138-141`)

**CRM-005 · Host page shows "Not a host" for both revoked and never-host** — LOW · CONFIRMED (`HostRecord.tsx:172`; `hostRemovedAt` never read)

### FINANCE — see Section G for the lifecycle map

| ID | Title | Sev · Conf | Where |
|---|---|---|---|
| FINANCE-001 | `replica_stale` is set but never repaired or alerted; approved recharge can leave buyer uncredited permanently | HIGH · CONFIRMED | `money.py:201-221`; `find_replica_drift` (`:303-310`) used only in tests |
| FINANCE-002 | Reconciliation can never detect drift (filters `"diamond"` vs stored `"diamonds"`; compares unrelated quantities) | HIGH · CONFIRMED | `services/reconcile.py:52, 100`; `money.py:31` |
| FINANCE-003 | Refusing a refund after a partial failure strands a clawback; a later refund claws back again | HIGH · CONFIRMED (path) | `recharges.py:543-618` |
| FINANCE-004 | Admin debits checked against Mongo, which never sees gifts/calls/conversion → wrong refusals or negative Firestore balances | HIGH · CONFIRMED | `users.py:2213-2240` |
| FINANCE-005 | Card executors not atomically claimed; post-movement side effects lost; repayment/write-off have no ledger key, `$set` overwrites (double-apply / debt erased) | HIGH · CONFIRMED | `partner_ops.py:222-262, 4262-4396, 4456-4516, 4700-4757, 5704-5760`; `cards.py:407-428` |
| FINANCE-006 | Host withdrawal can debit Firestore beans twice (raw Mongo error / concurrent execute); execute doesn't recheck host status | HIGH · LIKELY | `partner_ops.py:5486-5560`; `firebase.py:306-370` |
| FINANCE-007 | `releaseBeansForWeek` reads `released`/`beans` outside the transaction → double release or release of converted beans | HIGH · LIKELY | `functions/src/payouts.ts:91-140`; `wallet.ts:139-153` |
| FINANCE-008 | Commission accrual keyed on period label → overlapping week/month windows double-accrue; partial re-run mixes shares | HIGH · CONFIRMED | `partner_ops.py:5160`; `commission.py:715-760` |
| FINANCE-009 | ISO week-year bug: week 2026-W53 labelled `2027-W53`, refused → missed commission | MEDIUM · CONFIRMED | `functions/src/index.ts:945-949, 2260` |
| FINANCE-010 | Commission formula progressive (correct per docs) but docstrings say flat; CRM shows top-band rate | LOW · CONFIRMED | `commission.py:8-22, 296-573`; `zipper-crm/lib/commission.ts:118` |
| FINANCE-011 | Revoked/suspended/banned partner or host: pending recharges, purchases, lending, payouts, withdrawals still execute; new cards can be raised | MEDIUM · CONFIRMED | `recharges.py:326-404`; `partner_ops.py:4189, 4234, 4304, 5021, ~5411` |
| FINANCE-012 | Reject after partial approve strands seller coins | MEDIUM · CONFIRMED | `recharges.py:396-404, 450-476` |
| FINANCE-013 | Proof URL not bound to buyer's `rechargeProofs/{uid}/` | MEDIUM · CONFIRMED | `recharges.py:224-230` |
| FINANCE-014 | No submit idempotency; reference not normalised; diamonds not checked against price | MEDIUM · CONFIRMED | `index.ts:4233`; `PartnerFunctions.kt:185` |
| FINANCE-015 | `convertBeans` ignores `payoutHold` and bans | MEDIUM · CONFIRMED | `wallet.ts:58-178` |
| FINANCE-016 | Watchdog bills silent period after dropped call (~12–18 extra ticks) | MEDIUM · LIKELY | `calls.ts:470-480, 667-672` |
| FINANCE-017 | Gifts/calls pay beans to non-hosts and banned receivers | LOW · CONFIRMED | `gifts.ts:262-275`; `pricing.ts:167-179` — see Q-8 |
| FINANCE-018 | No alerts for `replica_stale`, stuck `approving/refunding`, failed sales; alert text advises impossible re-execute | MEDIUM · CONFIRMED | `alerts.py`, `:625`; `partner_ops.py:229` |
| FINANCE-019 | Failed sale unrecoverable; `buyer_uid` unvalidated | LOW · CONFIRMED | `partner_ops.py:4824-4900` |
| FINANCE-020 | Seller history omits refunded/reversed requests | LOW · CONFIRMED | `SellerDashboardScreen.kt:243-245`; `partners.py:459-575` |
| FINANCE-021 | Approval retry after an earlier committed debit can report false "insufficient balance" (balance check precedes duplicate-key detection) | MEDIUM · CONFIRMED (code order) | `money.py:132-139` before `:167-176`; `recharges.py:371-382` |

---

## E. Complete role-action matrix

| Action | Host | Agency | Sub-agency | Coin Seller |
|---|---|---|---|---|
| Apply/request | App callable (self) or agency invitation (`hostApplications`); guests allowed (AUTH-002); applicant can self-approve (SECURITY-002) | App callable; public `/agency-signup`; CRM register (new login, ROLE-001); unauth Firestore create (SECURITY-003) | App callable with parent validation; agency-dashboard direct create | App callable; `/seller-signup`; CRM register; staff second-role |
| Grant/approve | `decide_host_application` → `grant_host` or `activateHost`; matrix rechecked (`users.py:1394`); staff Firestore `isHost` writes bypass all (SECURITY-004) | `approve_partner` + `recheck_at_decision` + family CAS; ops_admin; no Owner | same | same |
| Revoke | `revoke_host`: only `isHost` flipped; roster, verified, live, earnings view issues (ROLE-010/011) | `revoke_partner`: correct flags/sessions/slot; rules & routing ignore it on dual-role (SECURITY-005, CRM-003); auto-transfers dependents (RESTORE-007/008) | same; hosts default to parent; own `parent_id` kept | `revoke_partner`; link left (ROLE-005); balances kept |
| Suspend | No role-level suspend; account suspend only | `deactivate_partner` (no state guard, ROLE-004) | same | same |
| Ban | Account+device ban; role records untouched (PASS) | same | same | same |
| Appeal (role) | None (RESTORE-001) | None | None | None |
| Restoration recommendation | None | None | None | None |
| Owner final decision | None | None | None | None |
| Successful restoration (actual paths) | Re-decide old app (RESTORE-004), new application/invite (RESTORE-005), staff `isHost` write, keeps verification (RESTORE-006) | Approve on revoked (RESTORE-002), reactivate (RESTORE-003), reapply (RESTORE-005) | same | same |
| Rejection | Decide reject + reason + notice | `reject_partner` — works on live records (ROLE-003) | same | same |
| Transfer requirements | Moved with agency; failures swallowed; no release action between agencies | Automatic in revoke, single actor, target must be approved main agency | Hosts → parent by default | n/a |
| Pending money | Withdrawals continue (`isVerifiedHost` kept); weekly release continues | Payout cards still execute | Sub-agency payout cards left open | Purchases/lending still execute; new cards allowed on revoked seller |
| Notification + audit | Audit on backend paths; notices on decide/revoke (revoke key not idempotent); none on Firestore paths | Audit + deterministic notices on every API path; reactivation re-sends approval email | same | same; second-role grant sends "application received" |

---

## F. Identity and CRM consistency report

- **Canonical identity:** Firebase uid. Host is a property of the user doc, not a separate record (so Users and Hosts pages listing the same uid is expected and not a duplicate). Agency/Seller are Mongo partner rows + Firestore mirror docs with auto ids, linked by `owner_crm_uid`/`crmUid`/`ownerUid`.
- **Inventory sources:** Users = Firestore `users`; Hosts = `users where isHost` + `hostApplications`; Agencies/Sellers = Mongo `partnerOps.list` enriched with Firestore; Team = Mongo `staff`.
- **Duplicate-identity paths (confirmed):** partner signups/register (new email/password uid), sub-agency creation from agency dashboard, `attach_login` creating a user, CRM login never opened in app (NO_USERS_DOC) followed by phone-OTP app sign-in, multi-method sign-in (AUTH-005).
- **Duplicate documents from moderation:** none found — suspend/ban/revoke/role assignment patch existing docs; no path creates a second `users` doc for the same uid.
- **Stale/contradictory state (confirmed):** revoked Agency on dual-role still treated as agency by rules and routing; `crmUsers.roles` keeps revoked role; second-capability link left after revoke; `users.isSeller` flip without partner change; revoked host still on roster and verified; Android "Pending" for suspended/revoked agencies; CRM Approve shown on revoked (looks like a normal pending action).
- **Wrong-target risks:** notices go to `owner_crm_uid`/`crmUid`, which is not the app uid when IDENTITY-001 split occurred; unauth/any-CRM partner creation can target a victim's uid (SECURITY-003); staff direct writes can rewrite `crmUid`/`ownerUid` (SECURITY-012).
- **Identity-field mutation by others:** staff tiers can write role fields (SECURITY-004); users can write their own contact fields (CONTACT-001); applicant can write host application status (SECURITY-002).

---

## G. Financial integrity report

**Lifecycle map**

| Operation | Source of truth | Cross-system writes | Idempotency |
|---|---|---|---|
| Recharge submit | Mongo `recharges` | Firestore `rechargeRequests` copy (best effort) | Unique (seller, reference) when reference present; none otherwise |
| Recharge approve | Mongo ledger (seller COINS −, buyer DIAMONDS +) | `users.diamonds` increment + history `recharge_{rid}` | `pending→approving` claim (10-min stale reclaim); ledger keys per rid |
| Refund decide | **Firestore first** (transactional clawback) | Mongo ledger after, `replica_applied_by_caller` | Reversal history doc id per cycle in same transaction |
| Gift / call | Firestore only | users, weeklyEarnings, platformRevenue, giftTransactions | `giftIdempotency`, `callIdempotency`, `tickIndex`, `status=='ended'` |
| convertBeans | Firestore only | beans/beansAvailable/weeklyEarnings | `walletIdempotency` |
| Weekly release | Firestore only | beansAvailable, statements | `released` flag read **outside** transaction (FINANCE-007) |
| Host withdrawal | **Firestore first** (`debit_host_beans`) | Mongo ledger BEANS | Ledger key per card; Firestore debit has none (FINANCE-006) |
| Coin purchase / lend / sale / commission payout / sub-agency payout | Mongo ledger | `sellers.coinBalance` / `agencies.commissionBalance` increments | Card-derived ledger keys; card claim not atomic (FINANCE-005) |
| Repayment / write-off | Mongo `credit.*` fields | none | **none** (FINANCE-005) |
| Commission accrual | Mongo ledger COMMISSION | `agencies.commissionBalance` | key `commission:{agency}:{host}:{label}` (FINANCE-008) |
| Admin balance card | Mongo ledger (sufficiency vs Mongo) | `users.diamonds/beans` increment | card id (FINANCE-004) |

**Verdicts:** recharge reference index PASS; approval claim PASS; refund retry PASS but refuse-after-partial FAIL; gift/call idempotency PASS; divergence detection FAIL; revoked-partner money handling FAIL; proof binding FAIL.

**Partial-failure behaviour:** Mongo-commit/Firestore-fail on approval → `replica_stale` set, request shows approved, buyer uncredited, nothing repairs it. Firestore-clawback/Mongo-fail on refund → status returns to `refund_pending`; a refusal then strands the clawback and a new refund cycle claws back again.

**Commission formula (implemented, progressive/marginal):** bands from `commission.py:296-338`; slice per band = `min(B, to_i) − (from_i − 1)`; commission = `(Σ slice_i × rate_bp_i + 5000) // 10000` paise; B = beans cashed out × `beanToInrRate`. Fallback slabs: main 5% from ₹25,001 rising to 25% above ₹25L; sub-agency 5%→12.5% from ₹26,001. Matches `CRM-FLOW.md` §4 and Phase-0 §20 (progressive, owner-confirmed); module docstring and `index.ts:77` wrongly say flat.

**Safe verification (read-only, not performed):** Mongo counts of `balances{replica_stale:true}`, `recharges{status in [approving, refunding]}`, `cards{stage:'failed'}`, overlapping `commission:*` labels per agency; Firestore queries for `users.diamonds<0` / `beans<0`, duplicate weekly releases per host-week. Race/retry paths: reproduce only with `backend/tests/harness.py` fakes or the Firestore emulator.

---

## H. Security report (summary)

- **Authentication bypass:** AUTH-001 (guest takeover), SECURITY-002 (self-approved host), IDENTITY-002 (self-unsuspend/self-badge), CONTACT-002 (unverified phone on Auth login).
- **Authorization gaps:** STAFF-001/002/003 (Owner/Observer governance), SECURITY-004/012 (staff direct writes), SECURITY-005 + CRM-003 (revoked agency access), RESTORE-002/003 (restore without Owner), ROLE-003/004 (state-machine bypass), APPEAL-001/002.
- **Direct-write paths:** see CRM-002 list plus rules in SECURITY-002/003/004/012, CONTACT-001, IDENTITY-002, SECURITY-008.
- **Session/device-ban weaknesses:** SESSION-001..005, AUTH-003, SECURITY-011.
- **Privacy exposure:** host KYC/bank/DOB reachable by revoked agency (SECURITY-005); `publicSellers` phone/UPI to all incl. guests (SECURITY-010); `hostLevel` public (LEVEL-003); `findExistingAccount` returns other holders' account state (low; gated on proof that CONTACT-002 can forge).
- **Credential exposure (no values disclosed):** SECURITY-001 — Agora certificate (live env, pushed git history `0491f23` on `archive/v4-production`, APKs 12–14, local caches); SendGrid key (plaintext function env, prefix logged, shared with backend); service-account JSON, Mongo URI, JWT secret, keystore passwords present locally but git-ignored and not in history. Rotation is a separate remediation action and was **not** performed.

---

## I. Tests and verification

**Run during this audit (local, fakes only, no external state):**

| Suite | Command | Result | What it proves |
|---|---|---|---|
| Backend (55 script suites) | `python3 -m tests.<suite>` for each `backend/tests/test_*.py` | **55/55 pass** | Unit behaviour against in-memory Mongo/Firebase fakes (partner lifecycle, money, staff, moderation, appeals, sessions, reset planner…) |
| Functions | `node --test "test/**/*.test.js"` | **596/596 pass** | Pure decision functions + fake-Firestore runtime tests (guest binding, quick login, email adoption, storage claims, crmRoles, pricing…) |
| CRM specs + hooks lint | `npm test` in `zipper-crm` | **pass** | Routing table, session gate, appeal status, second-role eligibility, crmRoles action policy, profile photo |

**Not run by me (reported from the operator's own terminal logs earlier in this engagement, 2026-10-07/08):** Firestore rules emulator 109/109, Storage rules emulator 119/119 (require Java 21 + emulators; not available in this sandbox); Android `testDebugUnitTest` BUILD SUCCESSFUL. I cannot independently re-verify those today.

**What passing tests do NOT prove:** the critical findings above are **not covered** by any test — no test for: caller-owns-wantedUid in guest binding; applicant writing `hostApplications.status`; user delete-and-recreate; owner writes to `users.email/phoneNumber`; unauth agency/seller create with foreign `ownerUid`; staff role change to owner/observer/agency; Owner deactivating Observer; suspend-a-banned-account; reject/reactivate on live/revoked records; dual-role revoked-agency rules access; reconciliation currency; refund refuse-after-partial; card double-execute; weekly release race; host revoke roster/verification; purge starvation; level computation. Integration with live Firebase/Mongo, manual UI flows, and deployed behaviour: **not tested**.

---

## J. Deployment status

- **Local source:** branch `v5-scratch`, last commit `1194e55` (2026-10-05); **191 modified, uncommitted files** across backend, functions, rules, indexes, CRM and Android. Any statement about "the code" refers to this working tree.
- **Deployed:** no independent read-only access to production was used. The only evidence is the operator's pasted terminal output in this engagement: API revision `zipper-api-00041-d5q` healthy; full Functions deploy on 2026-10-07 and a targeted deploy of `claimGuestIdentity` + new `adoptEmailAccount` on 2026-10-08; Firestore rules/indexes and Storage rules deployed 2026-10-07; CRM hosting deployed 2026-10-07. Working-tree changes made **after** those deploys (Android fail-closed `confirmDeviceBinding`, reset-planner classifications, app v1.2.2/16) are **not deployed**. Whether every deployed artefact equals the current working tree is **UNKNOWN**.
- **Deployed config evidence:** `gcloud functions describe syncMyRoles` output (operator-run) showed Agora certificate and SendGrid key as plaintext environment variables — consistent with SECURITY-001.

---

## K. Prioritized remediation plan (not implemented)

**1. Critical security and financial-integrity blockers** (do first; mostly rules + small server guards)
1. AUTH-001 guest bind ownership + reverse index (reconsider Option B only after this lands).
2. SECURITY-002 host-application applicant whitelist; `activateHost` requires server decision.
3. IDENTITY-002 users delete admin-only; create allowlist.
4. CONTACT-001/002 protect contact fields; stop attaching typed phones.
5. STAFF-002/001/003 role-change and Owner/Observer governance guards.
6. SECURITY-003/004/012 partner create and staff role-field rules; delete `makeHost/removeHost`.
7. SECURITY-005 + CRM-003 per-role status in rules and routing.
8. SECURITY-001 credential rotation + Secret Manager + history purge (operator action).
9. FINANCE-002/001/018 working reconciliation + `replica_stale` repair + alerts (detection before further money fixes).
10. FINANCE-003/005/006/007 refund refuse-after-partial, atomic card claim, withdrawal marker, weekly-release transaction.

**2. Identity and authorization correctness:** AUTH-002, AUTH-003, SESSION-001/002/003/004/005, SECURITY-011, AUTH-005, AUTH-006, IDENTITY-001 (link partner logins to app identity), ROLE-001, STAFF-005.
*Dependency:* IDENTITY-001 must precede ROLE-001 (eligibility per human needs a human key).

**3. Role lifecycle and appeals:** ROLE-003/004 state guards → RESTORE-001 role-restoration appeal + Owner decision (new entity, endpoints, CRM screens, notifications) → then close RESTORE-002/003/004/005/006 by routing all restoration through it → RESTORE-007/008 separate authorized transfer step → ROLE-010/011 host revoke completeness → ROLE-005/006/008/009 → APPEAL-001..006 → ACCT-001..004.
*Dependency:* RESTORE-001 needs product answers Q-1..Q-3.

**4. CRM consistency and indexes:** CRM-001 single action-policy per role/state with permission gating; CRM-002 move every direct Firestore write behind the API; CRM-004/005; FINANCE-011 freeze/review of pending money on revoke (needs Q-2). Indexes for any new queries (e.g. purge on `accountState`).

**5. Missing product functionality:** LEVEL-001/002 server-side XP with correct weights; LEVEL-003 host-level visibility; TASK-001/002 daily tasks; CONTACT-003 contact-change workflow; STAFF-004 staff reactivation; LEVEL-005 Owner level tool; DEACT-001/002/004.

**6. Testing and release validation:** add tests for every finding above (rules-emulator tests for all rule findings; functions tests for guest binding ownership, weekly release, gifts/calls; backend tests for state guards, governance, money races); Android splash/session tests; a deploy-parity check (deployed rules/functions vs working tree) before release.

---

## L. Questions requiring product-owner decisions

Only questions not answered by the prompt, docs or code.

**Q-1 · What happens to transferred hosts/sub-agencies when a revoked Agency is restored?** — *blocks RESTORE-001 design*
Options: (a) they stay with the new agency; (b) they return automatically; (c) Owner chooses per dependent in the restoration decision. Impact: (a) simplest, may anger the restored agency; (b) can disrupt hosts mid-week; (c) most work, most control.

**Q-2 · Policy for pending money when a partner/host role is revoked.** — *blocks FINANCE-011, RESTORE-007*
Options: (a) freeze all pending items into an Owner review queue; (b) freeze, with Finance Admin able to settle/cancel; (c) let in-flight items finish, block new ones. Impact: (a) safest, slowest; (b) balanced; (c) risk of paying a revoked partner.

**Q-3 · Who authorizes dependent transfers on Agency/Sub-agency revocation?** — *blocks RESTORE-007*
Options: (a) Owner only; (b) Ops Admin with Owner notification; (c) the revoking admin, as today, but as a separate audited step. Impact: governance vs speed.

**Q-4 · Should phone-based duplicate accounts be auto-merged like Google→email?** — *does not block; affects AUTH-005*
Options: (a) never auto-merge on phone (numbers recycle), only refuse and guide; (b) merge only when the existing account is a fresh guest; (c) merge with Owner/support approval. Recommendation: (a).

**Q-5 · Public seller contact exposure.** — *does not block*
Options: (a) keep phone/UPI public to signed-in users; (b) show only to non-guest users; (c) reveal only when a buyer opens a recharge with that seller.

**Q-6 · Who may decide account-ban appeals?** — *does not block; affects APPEAL-007*
Currently `app_member` can. Options: (a) department admins only; (b) admins + Owner; (c) keep members but enforce four-eyes from the ban record.

**Q-7 · Minimum Owner count.** — *does not block STAFF fixes*
No hardcoded count exists (requirement satisfied). Should the system refuse removing/demoting the last remaining Owner (recommended: yes, minimum 1)? Note the test-data reset planner currently requires exactly three Owners — keep or make configurable?

**Q-8 · Should gifts/calls credit beans to non-hosts?** — *does not block; affects FINANCE-017, LEVEL-004*
Options: (a) only Hosts earn beans; (b) everyone earns beans but only Hosts can withdraw; (c) current behaviour (everyone earns and accumulates toward host level once granted).

**Q-9 · Host Level visibility rule.** — *blocks LEVEL-003 fix*
Options: (a) visible only to the host themself and their agency/staff; (b) visible on host profiles to everyone but not on non-host user cards; (c) visible to everyone (current).

**Q-10 · Contact-change authorization owner.** — *blocks CONTACT-003*
Which department approves the Feedback request (Support Admin? Ops Admin?), and must the old contact also confirm (OTP to old number/email) when still reachable?

---
*End of report. No code, data, rules, credentials, or deployments were modified during this audit.*
