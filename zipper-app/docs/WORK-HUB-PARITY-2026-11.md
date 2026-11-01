# Work hub parity — APK 20 part 2 (November 2026)

CRM capability → Android Work-hub action → backend route → permission key, for
every function in `zipper-crm/lib/api.ts`, every permission key in
`backend/app/core/roles.py`, and every other route the CRM (or the app) reaches.
Owner / Observer governance is marked **CRM-only**. Also covered: the Owner
two-step gate on the app login (§ E).

## Run on the Mac

```sh
cd ~/Documents/Projects/zippern/zipper-app
./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleProd
```

Only this batch's tests (faster):

```sh
./gradlew --no-daemon :app:testDebugUnitTest \
  --tests 'com.zipper.app.data.work.*' \
  --tests 'com.zipper.app.ui.screens.auth.OwnerMfaGateTest' \
  --tests 'com.zipper.app.util.Apk20WiringTest'
```

Outputs: `app/build/reports/tests/testDebugUnitTest/index.html`,
`app/build/work-hub-role-counts.md` (the per-role table below, recomputed — paste it
here when a module or gate changes) and `app/build/work-parity-matrix.md`
(role × screen). The unit tests read `backend/` and `zipper-crm/` from the
repository, so run them from a full checkout.

## How access is decided (and pinned)

* **Who sees what** comes from `GET /api/auth/me` only: `roles.capability_profile`
  → `Caps.from` → each module's and action's `gate`. No local flag (`isAgent`,
  `crmRole`, `BuildConfig`, DataStore) gates a work screen —
  `WorkParityTest` fails if one appears in `data/work/Modules*.kt`,
  `WorkScreens.kt` or `WorkViewModels.kt`. The server still runs every route's
  own dependency; a gate only decides what is *offered*.
* **Multi-role logins:** the hub header lists every live role with the session's
  status (`Caps.roleSummary`, e.g. "Agency, Coin Seller · Approved"); *My partner
  records* lists each live record with its own status; *Contact verification*
  lists records waiting on contacts. Staff see every role of an account — revoked
  ones included — each with its own status on *User record*
  (`GET /users/{uid}/roles`). A revoked Agency never hides a live Coin Seller.
* **Counted from code, not by hand:** the tables were generated from the sources
  on 1 Nov 2026 (branch `v5-scratch`, HEAD `97204de` + this batch); the per-role
  table is re-derived by `WorkParityTest` from `roles.PERMISSIONS` on every run.

Status legend: **Mobile** (an Android write) · **Mobile — Owner** (an Owner-only
write the Owner makes from the phone) · **Mobile (read)** (a screen, detail or
read action) · **App door** (`ApiClient` / `OwnerMfaGate`, not a screen) ·
**CRM-only · governance** (Owner/Observer governance — never on mobile) ·
**CRM-only** (other reason, given) · **Gap** (not on mobile yet, no governance
reason) · **Not a Work-hub capability** (public form, app edge, machine).

## Summary

| | Count |
|---|---|
| `lib/api.ts` functions | 122 |
| … on mobile | 90 (41 reads, 38 writes, 11 Owner-only writes) |
| … app door (sign-in, renewal, sign-out, Owner two-step) | 9 |
| … CRM-only · Owner / Observer governance | 12 |
| … CRM-only, other reason | 6 |
| … gaps | 2 |
| … not Work-hub capabilities | 3 |
| Other CRM clients + Android-first routes (§ C, the 9 app-edge routes as one row) | 132 rows: 72 mobile (10 Android-first, 7 Owner-only writes), 29 CRM-only (8 governance), 4 gaps, 8 no client yet, 17 not Work-hub, 1 app door, 1 removed everywhere |
| Backend routes | 255 |
| Permission keys / roles | 20 / 16 |
| Work-hub screens / distinct actions | 84 / 154 |

## Per-role counts (pinned by `WorkParityTest`)

Distinct action ids offered by gate, the row's state aside. *Writes* = API
POST/PATCH/DELETE and Firestore writes; *Reads* = API GET actions (screens are
counted separately); *Links* = open another screen or a signed URL;
*CRM-only markers* = read-only buttons that say "Decide in the CRM" and send
nothing (`accountAppeals/appeal.decide`, and `cards.board/card.fastPath`,
which only an Owner sees on an undecided card). Partner sessions: `agency`
holds an agency record, `seller` a seller record, `agency+seller` both,
`pending partner` an application under review (no record ids).

<!-- role-counts:begin -->
| Session | Screens | Writes | Reads | Links | CRM-only markers |
|---|---|---|---|---|---|
| `owner` | 81 | 116 | 13 | 22 | 2 |
| `observer` | 50 | 0 | 8 | 17 | 2 |
| `app_admin` | 65 | 46 | 11 | 18 | 2 |
| `app_member` | 40 | 26 | 8 | 11 | 2 |
| `ops_admin` | 68 | 55 | 11 | 20 | 2 |
| `ops_member` | 43 | 19 | 10 | 18 | 2 |
| `finance_admin` | 69 | 54 | 11 | 20 | 2 |
| `finance_member` | 50 | 28 | 11 | 20 | 2 |
| `tech_admin` | 63 | 33 | 7 | 11 | 2 |
| `tech_member` | 41 | 12 | 7 | 11 | 2 |
| `support_admin` | 61 | 36 | 7 | 11 | 2 |
| `support_member` | 40 | 22 | 7 | 11 | 2 |
| `marketing_admin` | 60 | 29 | 7 | 11 | 2 |
| `marketing_member` | 38 | 12 | 7 | 11 | 2 |
| `agency` | 10 | 3 | 0 | 1 | 0 |
| `seller` | 8 | 5 | 1 | 2 | 0 |
| `agency+seller` | 14 | 5 | 1 | 3 | 0 |
| `pending partner` | 3 | 3 | 0 | 0 | 0 |
<!-- role-counts:end -->

The Observer is offered reads only (also pinned by `WorkModulesTest`); it cannot
sign in to the app at all (§ E), so its row is what the hub *would* offer.

## CRM-only: Owner / Observer governance

| Capability | Route | Guard | On Android |
|---|---|---|---|
| Observer sign-in (emailed code + second factor) | POST `/auth/observer/request-code`, `/auth/observer/verify-code`; the shared `/auth/mfa/*` steps | public; `current_user` | Refused: `observer_denied` → "This account cannot use the app." and signed out |
| Provision an Owner | POST `/staff/owners` | `require_owner_provisioner` | — (no CRM client in this tree yet either) |
| Suspend / reactivate / deactivate an Owner | POST `/staff/owners/{uid}/suspend`, `/reactivate`, `/deactivate` | `require_owner_provisioner` | — |
| Reset an Owner's authenticator | POST `/auth/mfa/owners/{owner_uid}/reset` | `require_owner_provisioner` | — (the gate says "the Observer can reset it") |
| Decide a ban / suspension appeal | POST `/users/appeals/{appeal_id}/decide` | `require_write` · `can_ban_users` · service: Owner only | Read-only marker `accountAppeals/appeal.decide`; reviewers **recommend** on mobile (`appeal.recommend`) |
| Owner fast path (review → verify → sign → execute) | POST `/cards/{card_id}/owner-fast-path` | `require_owner` · `can_approve_requests` | Read-only marker `cards.board/card.fastPath` (Owner, undecided cards) |
| Bulk signature | POST `/cards/sign-bulk` | `require_owner` · `can_approve_requests` | — (one card at a time: `card.sign`) |
| Replace own recovery codes | POST `/auth/mfa/recovery-codes` | `current_user` (verified session + fresh code) | — |
| Owner money notices (list, retry) | GET `/partner-ops/owner-notices`, POST `/owner-notices/retry` | `require_owner` | — |
| Who is emailed what | POST `/notifications/subscriptions` | `require_owner` | — |
| Activate a signed odds table; withdraw a mechanic from a country | POST `/chance/configs/{card_id}/activate`, `/chance/mechanics/{id}/withdraw-country` | `require_owner` · `can_economy_config` | — |

Owner **money** decisions stay on the phone, each behind its own gate and the
server's: card signature and execution, transfer, reinstatement and frozen-money
decisions, recharge approval and refund decision, sale approval, approval
requests, capital settlement, expense payment, chance resume, staff role change,
host / partner role restore.

Note — the CRM in this tree has **no client yet** for the owner fast path, the
appeal *recommend* step, sessions / sign out everywhere, departments, held items,
replica drift, the payout policy, the owner notices, or Owner provisioning and
deactivation (backend B1–B3 routes). The fast-path marker therefore points at a
CRM screen still to be built; appeals are already decided in the CRM
(`users.decideAppeal`).

## A. `zipper-crm/lib/api.ts` → Android → backend → permission

Routes as served (`/api` prefix). Guards are the route's dependencies; keys are
`roles.Permission` values (`any of` = `require_permission(…, any_of=True)`).

| CRM function | Backend route | Guard · permission key | Android Work hub | Status |
|---|---|---|---|---|
| `auth.signInWithFirebase` | POST `/api/auth/signin` | none (public / self-scoped) | ApiClient (client: android) | App door (`ApiClient` / `OwnerMfaGate`) |
| `auth.refresh` | POST `/api/auth/refresh` | none (public / self-scoped) | ApiClient renewal | App door (`ApiClient` / `OwnerMfaGate`) |
| `auth.refusalForCurrentLogin` | POST `/api/auth/signin` | none (public / self-scoped) | ApiClient (client: android) | App door · the app reads refusals from `resolveIdentity` / `ApiClient` |
| `auth.refusalForCurrentLogin` | POST `/api/auth/signout` | `current_user` | ApiClient.signOut | App door · the app reads refusals from `resolveIdentity` / `ApiClient` |
| `auth.requestObserverCode` | POST `/api/auth/observer/request-code` | none (public / self-scoped) | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer sign-in; refused on Android, spec §8) |
| `auth.verifyObserverCode` | POST `/api/auth/observer/verify-code` | none (public / self-scoped) | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer sign-in) |
| `auth.observerMfaStatus` | GET `/api/auth/mfa/status` | `current_user` | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer second factor; the same route serves the Owner gate) |
| `auth.observerMfaEnrolStart` | POST `/api/auth/mfa/enrol/start` | `current_user` | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer second factor) |
| `auth.observerMfaEnrolConfirm` | POST `/api/auth/mfa/enrol/confirm` | `current_user` | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer second factor) |
| `auth.observerMfaVerify` | POST `/api/auth/mfa/verify` | `current_user` | — (the Observer is refused at sign-in: `observer_denied` → "This account cannot use the app.") | CRM-only · Observer governance (Observer second factor) |
| `auth.mfaStatus` | GET `/api/auth/mfa/status` | `current_user` | `owner.mfa` (screen), OwnerMfaGate | App door · `OwnerMfaGate` before Main; `owner.mfa` in the Work hub |
| `auth.mfaEnrolStart` | POST `/api/auth/mfa/enrol/start` | `current_user` | OwnerMfaGate | App door (`ApiClient` / `OwnerMfaGate`) |
| `auth.mfaEnrolConfirm` | POST `/api/auth/mfa/enrol/confirm` | `current_user` | OwnerMfaGate | App door (`ApiClient` / `OwnerMfaGate`) |
| `auth.mfaVerify` | POST `/api/auth/mfa/verify` | `current_user` | `owner.mfa/mfa.verify`, `owner.mfa/mfa.recovery`, OwnerMfaGate | App door · `OwnerMfaGate` before Main; `owner.mfa` in the Work hub |
| `auth.mfaBind` | POST `/api/auth/mfa/bind` | `current_user` | `owner.mfa/mfa.rebind`, OwnerMfaGate (Retry unlock) | App door · `OwnerMfaGate` Retry unlock; `owner.mfa/mfa.rebind` |
| `auth.mfaNewRecoveryCodes` | POST `/api/auth/mfa/recovery-codes` | `current_user` | — | CRM-only · Owner governance (replace own recovery codes; shown once) |
| `auth.mfaResetOwner` | POST `/api/auth/mfa/owners/{owner_uid}/reset` | `require_owner_provisioner` | — | CRM-only · Observer governance (reset an Owner's authenticator) |
| `auth.signOut` | POST `/api/auth/signout` | `current_user` | ApiClient.signOut | App door (`ApiClient` / `OwnerMfaGate`) |
| `cards.list` | GET `/api/cards` | `current_user` | `partner.cards` (screen), `cards.board` (screen), `cards.coinPurchases` (screen) | Mobile (read) |
| `cards.inbox` | GET `/api/cards/inbox` | `current_user` | `cards.inbox` (screen) | Mobile (read) |
| `cards.awaitingSignature` | GET `/api/cards/awaiting-signature` | `require_owner` | `cards.toSign` (screen) | Mobile (read) |
| `cards.raise` | POST `/api/cards` | `require_write` | — | CRM-only · free-form card form; mobile raises cards through the typed actions (balance, lending, payouts, expenses, capital) |
| `cards.startReview` | POST `/api/cards/{card_id}/review` | `require_write` | `expenses/card.review`, `cards.board/card.review`, `cards.coinPurchases/card.review` | Mobile |
| `cards.verify` | POST `/api/cards/{card_id}/verify` | `require_write` | `expenses/card.verify`, `cards.board/card.verify`, `cards.coinPurchases/card.verify` | Mobile |
| `cards.sign` | POST `/api/cards/{card_id}/sign` | `require_owner` · `can_approve_requests` | `expenses/card.sign`, `cards.board/card.sign`, `cards.toSign/card.sign`, `cards.coinPurchases/card.sign` | Mobile — Owner |
| `cards.reject` | POST `/api/cards/{card_id}/reject` | `require_write` | `expenses/card.reject`, `cards.board/card.reject`, `cards.toSign/card.reject`, `cards.coinPurchases/card.reject` | Mobile |
| `cards.signBulk` | POST `/api/cards/sign-bulk` | `require_owner` · `can_approve_requests` | — | CRM-only · Owner governance (bulk signature); single `card.sign` is on mobile |
| `audit.list` | GET `/api/audit` | `require_internal` | `audit` (screen) | Mobile (read) |
| `audit.historyFor` | GET `/api/audit/history/{subject_type}/{subject_id}` | `require_internal` | — | CRM-only · per-record trail; mobile: `users.history` (accounts) and `audit` with a subject filter |
| `staff.list` | GET `/api/staff` | `current_user` | `staff` (screen) | Mobile (read) |
| `staff.me` | GET `/api/staff/me` | `current_user` | `staff/staff.me` | Mobile (read) |
| `staff.assignableRoles` | GET `/api/staff/assignable-roles` | `current_user` | `staff/staff.assignable` | Mobile (read) |
| `staff.overview` | GET `/api/staff/overview` | `current_user` | `staff/staff.overview` | Mobile (read) |
| `staff.invite` | POST `/api/staff` | `require_team_admin` · `can_manage_team` | `staff/staff.invite` | Mobile |
| `staff.changeRole` | PATCH `/api/staff/{uid}/role` | `require_write` · `can_manage_team` · service: Owner only | `staff/staff.role` | Mobile |
| `staff.deactivate` | POST `/api/staff/{uid}/deactivate` | `require_write` · `can_manage_team` | `staff/staff.deactivate` | Mobile |
| `staff.suspend` | POST `/api/staff/{uid}/suspend` | `require_write` · `can_manage_team` | `staff/staff.suspend` | Mobile |
| `staff.reactivate` | POST `/api/staff/{uid}/reactivate` | `require_write` · `can_manage_team` | `staff/staff.reactivate` | Mobile |
| `staff.suspendOwner` | POST `/api/staff/owners/{uid}/suspend` | `require_owner_provisioner` | — | CRM-only · Observer governance (suspend an Owner) |
| `staff.reactivateOwner` | POST `/api/staff/owners/{uid}/reactivate` | `require_owner_provisioner` | — | CRM-only · Observer governance (reactivate an Owner) |
| `staff.setEmployment` | PATCH `/api/staff/{uid}/employment` | `require_team_admin` · `can_manage_team` | `staff/staff.employment` | Mobile |
| `users.ban` | POST `/api/users/{uid}/ban` | `require_write` · `can_ban_users` | `users.record/user.ban`, `live.rooms/live.ban` | Mobile |
| `users.unban` | POST `/api/users/{uid}/unban` | `require_write` · `can_ban_users` | `users.record/user.unban` | Mobile |
| `users.suspend` | POST `/api/users/{uid}/suspend` | `require_write` · `can_ban_users` | `users.record/user.suspend` | Mobile |
| `users.resume` | POST `/api/users/{uid}/resume` | `require_write` · `can_ban_users` | `users.record/user.resume` | Mobile |
| `users.warn` | POST `/api/users/{uid}/warn` | `require_write` · `can_view_users`, `can_adjust_balance` (deduction only) | `users.record/user.warn`, `users.warnings/warnings.warn`, `live.rooms/live.warn` | Mobile |
| `users.roles` | GET `/api/users/{uid}/roles` | `current_user` | `users.record` (screen) | Mobile (read) |
| `users.restoreHost` | POST `/api/users/{uid}/restore-host` | `require_write` · `can_approve_kyc` · service: Owner only | `users.record/user.restoreHost` | Mobile |
| `users.revokeHost` | POST `/api/users/{uid}/revoke-host` | `require_write` · `can_approve_kyc` | `users.record/user.revokeHost` | Mobile |
| `users.decideHostApplication` | POST `/api/users/host-applications/{application_id}/decide` | `require_write` · `can_approve_kyc` | `hosts.applications/hostApp.decide` | Mobile |
| `users.decideHostPendingChanges` | POST `/api/users/host-applications/{application_id}/pending-changes/decide` | `require_write` · `can_approve_kyc` | `hosts.applications/hostApp.changes` | Mobile |
| `users.requestBalanceChange` | POST `/api/users/{uid}/balance-request` | `require_write` · `can_adjust_balance` | `users.record/user.balance` | Mobile |
| `users.executeBalanceCard` | POST `/api/users/balance-cards/{card_id}/execute` | `require_owner` · `can_adjust_balance` | `expenses/card.exec.balance`, `cards.board/card.exec.balance`, `cards.coinPurchases/card.exec.balance` | Mobile — Owner |
| `users.warnings` | GET `/api/users/{uid}/warnings` | `current_user` | `users.warnings` (screen) | Mobile (read) |
| `users.history` | GET `/api/users/{uid}/history` | `current_user` | `users.history` (screen) | Mobile (read) |
| `users.bannedDevices` | GET `/api/users/devices/bans` | `current_user` | `deviceBans` (screen) | Mobile (read) |
| `users.banDevice` | POST `/api/users/devices/bans` | `require_write` · `can_ban_users` | `deviceBans/device.ban` | Mobile |
| `users.unbanDevice` | POST `/api/users/devices/bans/{device_id}/unban` | `require_write` · `can_ban_users` | `deviceBans/device.unban` | Mobile |
| `users.appeals` | GET `/api/users/appeals` | `current_user` | `accountAppeals` (screen) | Mobile (read) |
| `users.decideAppeal` | POST `/api/users/appeals/{appeal_id}/decide` | `require_write` · `can_ban_users` · service: Owner only (four eyes) | — | CRM-only · Owner governance — read-only marker `accountAppeals/appeal.decide`; reviewers recommend on mobile |
| `users.appealEvidence` | GET `/api/users/appeals/{appeal_id}/evidence` | `current_user` · `can_ban_users` | `accountAppeals/appeal.evidence` | Mobile (read) |
| `users.reports` | GET `/api/users/reports` | `current_user` | `userReports` (screen) | Mobile (read) |
| `users.actionReport` | POST `/api/users/reports/{report_id}/action` | `require_write` · `can_view_users` · suspend/ban +`can_ban_users`, deduct +`can_adjust_balance` | `userReports/report.action` | Mobile |
| `documents.forRecord` | GET `/api/documents/{kind}/{record_id}` | `current_user` | `partners.directory/partner.documents`, `partners.one/partner.documents`, `hosts.applications/hostApp.docs` | Mobile (read) |
| `documents.batch` | GET `/api/documents/batch` | `current_user` | — | CRM-only · list-view batch; mobile opens one record's documents |
| `hostVerification.pending` | GET `/api/host-verification/pending` | `require_write` · `can_approve_kyc` | `hostVerification` (screen) | Mobile (read) |
| `hostVerification.get` | GET `/api/host-verification/{uid}` | `require_write` · `can_approve_kyc` | `hostVerification` (detail) | Mobile (read) |
| `hostVerification.review` | POST `/api/host-verification/{uid}/review` | `require_write` · `can_approve_kyc` | `hostVerification/verify.review` | Mobile |
| `partners.agencyStatement` | GET `/api/partners/agencies/{agency_id}/statement` | `current_user` | `agency.statement` (screen) | Mobile (read) |
| `partners.agencyHosts` | GET `/api/partners/agencies/{agency_id}/hosts` | `current_user` | `agency.hosts` (screen) | Mobile (read) |
| `partners.sellerStatement` | GET `/api/partners/sellers/{seller_id}/statement` | `current_user` | `seller.statement` (screen) | Mobile (read) |
| `partners.creditExposure` | GET `/api/partners/credit/exposure` | `require_internal` | `credit.overdue/credit.exposure` | Mobile (read) |
| `partners.overdueSellers` | GET `/api/partners/credit/overdue` | `require_internal` | `credit.overdue` (screen) | Mobile (read) |
| `publicAppeals.lookup` | POST `/api/public/appeals/lookup` | none (public / self-scoped) | — | Not a Work-hub capability (public appeal web form) |
| `publicAppeals.submit` | GET `/api/public/appeals` | — | — | Not a Work-hub capability (public appeal web form) |
| `partnerOps.list` | GET `/api/partner-ops/partners` | `current_user` | `partner.records` (screen), `partners.directory` (screen) | Mobile (read) |
| `partnerOps.get` | GET `/api/partner-ops/partners/{partner_id}` | `current_user` | `partner.records` (detail), `partners.directory` (detail), `partners.one` (screen) | Mobile (read) |
| `partnerOps.approve` | POST `/api/partner-ops/partners/{partner_id}/approve` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `partners.directory/partner.approve`, `partners.one/partner.approve` | Mobile |
| `partnerOps.reject` | POST `/api/partner-ops/partners/{partner_id}/reject` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `partners.directory/partner.reject`, `partners.one/partner.reject` | Mobile |
| `partnerOps.deactivate` | POST `/api/partner-ops/partners/{partner_id}/deactivate` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `partners.directory/partner.deactivate`, `partners.one/partner.deactivate` | Mobile |
| `partnerOps.reactivate` | POST `/api/partner-ops/partners/{partner_id}/reactivate` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` · restoring a REVOKED role: Owner only (service) | `partners.directory/partner.reactivate`, `partners.one/partner.reactivate`, `users.record/role.restorePartner` | Mobile |
| `partnerOps.checkPaymentRef` | GET `/api/partner-ops/payment-references/{payment_ref}` | `current_user` | — | CRM-only · UTR pre-check; the server still flags a reused UTR on the card |
| `partnerOps.requestCoinPurchase` | POST `/api/partner-ops/sellers/{seller_id}/coin-purchases` | `require_write_or_partner` | `seller.statement/seller.buy`, `coinRequests/coinReq.convert` | Mobile |
| `partnerOps.executeCoinPurchase` | POST `/api/partner-ops/coin-purchases/{card_id}/execute` | `require_owner` · `can_coin_operations` | `expenses/card.exec.coin`, `cards.board/card.exec.coin`, `cards.coinPurchases/card.exec.coin` | Mobile — Owner |
| `partnerOps.requestLending` | POST `/api/partner-ops/sellers/{seller_id}/lending` | `require_write` · `can_coin_operations` | `partners.directory/partner.lend`, `partners.one/partner.lend` | Mobile |
| `partnerOps.executeLending` | POST `/api/partner-ops/lending/{card_id}/execute` | `require_owner` · `can_coin_operations` | `expenses/card.exec.lend`, `cards.board/card.exec.lend`, `cards.coinPurchases/card.exec.lend` | Mobile — Owner |
| `partnerOps.requestRepayment` | POST `/api/partner-ops/sellers/{seller_id}/repayments` | `require_write` · `can_coin_operations` | `partners.directory/partner.repay`, `partners.one/partner.repay` | Mobile |
| `partnerOps.executeRepayment` | POST `/api/partner-ops/repayments/{card_id}/execute` | `require_owner` · `can_coin_operations` | `expenses/card.exec.repay`, `cards.board/card.exec.repay`, `cards.coinPurchases/card.exec.repay` | Mobile — Owner |
| `partnerOps.requestRecovery` | POST `/api/partner-ops/sellers/{seller_id}/recoveries` | `require_write` · `can_coin_operations` | `partners.directory/partner.recover`, `partners.one/partner.recover` | Mobile |
| `partnerOps.executeRecovery` | POST `/api/partner-ops/recoveries/{card_id}/execute` | `require_owner` · `can_coin_operations` | `expenses/card.exec.recover`, `cards.board/card.exec.recover`, `cards.coinPurchases/card.exec.recover` | Mobile — Owner |
| `partnerOps.requestWriteOff` | POST `/api/partner-ops/partners/{partner_id}/write-off` | `require_write` · `can_coin_operations` | `partners.directory/partner.writeoff`, `partners.one/partner.writeoff` | Mobile |
| `partnerOps.executeWriteOff` | POST `/api/partner-ops/write-offs/{card_id}/execute` | `require_owner` · `can_coin_operations` | `expenses/card.exec.writeoff`, `cards.board/card.exec.writeoff`, `cards.coinPurchases/card.exec.writeoff` | Mobile — Owner |
| `partnerOps.recordSale` | POST `/api/partner-ops/sales` | `require_write_or_partner` | `sales/sale.new` | Mobile |
| `partnerOps.registrationAvailability` | GET `/api/partner-ops/registration/availability` | none (public / self-scoped) | — | Not a Work-hub capability (public partner sign-up form) |
| `partnerOps.lookupBuyers` | GET `/api/partner-ops/buyers/lookup` | `current_user` | `sales/sale.new` (buyer lookup) | Mobile (read) |
| `partnerOps.listSales` | GET `/api/partner-ops/sales` | `current_user` | `sales` (screen) | Mobile (read) |
| `partnerOps.approveSale` | POST `/api/partner-ops/sales/{sale_id}/approve` | `require_owner` · `can_coin_operations` | `sales/sale.approve` | Mobile — Owner |
| `partnerOps.requestCommissionPayout` | POST `/api/partner-ops/agencies/{agency_id}/commission-payouts` | `require_write` · `can_process_payout` | `partners.directory/partner.commission`, `partners.one/partner.commission` | Mobile |
| `partnerOps.executeCommissionPayout` | POST `/api/partner-ops/commission-payouts/{card_id}/execute` | `require_owner` · `can_process_payout` | `expenses/card.exec.commission`, `cards.board/card.exec.commission`, `cards.coinPurchases/card.exec.commission` | Mobile — Owner |
| `partnerOps.accrueCommission` | POST `/api/partner-ops/agencies/{agency_id}/commission-accruals` | `team_admin_or_accrual_service` · `can_process_payout` · or the accrual service key | — | CRM-only · team-admin / Sunday job accrual |
| `partnerOps.requestHostWithdrawal` | POST `/api/partner-ops/hosts/{host_uid}/withdrawals` | `require_write` · `can_process_payout` | `withdrawals/withdrawal.card`, `salaryRequests/salary.card` | Mobile |
| `partnerOps.executeHostWithdrawal` | POST `/api/partner-ops/host-withdrawals/{card_id}/execute` | `require_owner` · `can_process_payout` | `expenses/card.exec.withdrawal`, `cards.board/card.exec.withdrawal`, `cards.coinPurchases/card.exec.withdrawal` | Mobile — Owner |
| `partnerOps.requestSubAgencyPayout` | POST `/api/partner-ops/subagency-payouts` | `require_write` · `can_process_payout` | — | Gap · mobile confirms leg 2 and executes, but does not raise a sub-agency payout |
| `partnerOps.executeSubAgencyPayout` | POST `/api/partner-ops/subagency-payouts/{card_id}/execute` | `require_owner` · `can_process_payout` | `expenses/card.exec.subagency`, `cards.board/card.exec.subagency`, `cards.coinPurchases/card.exec.subagency` | Mobile — Owner |
| `partnerOps.confirmSubAgencyLeg` | POST `/api/partner-ops/subagency-payouts/{payout_id}/confirm-leg` | `require_write` · `can_process_payout` | `agency.subPayouts/subpayout.confirm` | Mobile |
| `partnerOps.openSubAgencyPayouts` | GET `/api/partner-ops/subagency-payouts/open` | `current_user` | `agency.subPayouts` (screen) | Mobile (read) |
| `reports.cashPosition` | GET `/api/reports/cash-position` | `require_internal` | `reports.cash` (screen) | Mobile (read) |
| `reports.revenue` | GET `/api/reports/revenue` | `require_internal` | `reports.revenue` (screen) | Mobile (read) |
| `reports.payouts` | GET `/api/reports/payouts` | `require_internal` | `reports.payouts` (screen) | Mobile (read) |
| `reports.margin` | GET `/api/reports/margin` | `require_internal` | `reports.margin` (screen) | Mobile (read) |
| `reports.channels` | GET `/api/reports/channels` | `require_internal` | `reports.channels` (screen) | Mobile (read) |
| `reports.agencyStatement` | GET `/api/reports/agencies/{agency_id}/statement` | `require_internal` | `reports.agencyStatement` (screen) | Mobile (read) |
| `reports.sellerStatement` | GET `/api/reports/sellers/{seller_id}/statement` | `require_internal` | `reports.sellerStatement` (screen) | Mobile (read) |
| `reports.partnersSummary` | GET `/api/reports/partners/summary` | `require_internal` | `reports.partners` (screen) | Mobile (read) |
| `reports.liabilities` | GET `/api/reports/liabilities` | `require_internal` | `reports.liabilities` (screen) | Mobile (read) |
| `reports.teamThroughput` | GET `/api/reports/team-throughput` | `require_internal` | `reports.throughput` (screen) | Mobile (read) |
| `reports.auditSummary` | GET `/api/reports/audit-summary` | `require_internal` | `reports.auditSummary` (screen) | Mobile (read) |
| `reports.dashboard` | GET `/api/reports/dashboard` | `require_internal` | `reports.dashboard` (screen) | Mobile (read) |
| `reports.definitions` | GET `/api/reports/definitions` | `require_internal` | `reports.definitions` (screen) | Mobile (read) |
| `reports.downloadCsv` | GET `/api/reports/…?format=csv` | the report route's own guard | — | CRM-only · CSV file export; mobile shows the same report envelopes |
| `tickets.createTeam` | POST `/api/tickets/team` | `require_write` | `team.tickets/ticket.new` | Mobile |
| `tickets.update` | POST `/api/tickets/{kind}/{ticket_id}/update` | `require_write` | `feedback.triage/feedback.claim`, `feedback.triage/feedback.status`, `feedback.triage/feedback.resolve`, `feedback.triage/feedback.priority`, `support.tickets/support.reply`, `support.tickets/support.status`, `support.tickets/support.close`, `team.tickets/ticket.move` | Mobile |
| `tickets.routeSupport` | POST `/api/tickets/support/{ticket_id}/route` | `require_write` | — | Gap · routing a support ticket to a department is CRM-only today |

## B. Permission keys (`roles.py`) → roles → backend routes → Android gates

Roles holding a key are the **staff** roles (`observer`, `agency` and `seller`
hold none; `owner` holds all twenty). A key with no route is a CRM display key or
is enforced by a role predicate instead (tickets: `tickets.may_triage`;
broadcasts: the audience rules; live rooms: Ops or an Owner).

| Key | Staff roles holding it | Backend routes requiring it | Android gates using it |
|---|---|---|---|
| `can_view_users` | owner, app_admin, app_member, ops_admin, finance_admin, support_admin, support_member | 2 — `POST /users/reports/{report_id}/action`; `POST /users/{uid}/warn` | `live.warn`, `report.action`, `user.warn`, `warnings.warn` |
| `can_ban_users` | owner, app_admin, app_member | 10 — `POST /users/devices/bans`; `POST /users/devices/bans/{device_id}/unban`; `GET /users/appeals/{appeal_id}/evidence`; `POST /users/appeals/{appeal_id}/recommend`; `POST /users/appeals/{appeal_id}/decide`; `POST /users/{uid}/ban`; `POST /users/{uid}/unban`; `POST /users/{uid}/suspend`; `POST /users/{uid}/resume`; `POST /users/reports/{id}/action (suspend, ban)` | `appeal.evidence`, `appeal.recommend`, `device.ban`, `device.unban`, `live.ban`, `user.ban`, `user.resume`, `user.suspend`, `user.unban` |
| `can_adjust_balance` | owner, app_admin, finance_admin | 4 — `POST /users/balance-cards/{card_id}/execute`; `POST /users/{uid}/balance-request`; `POST /users/{uid}/warn`; `POST /users/reports/{id}/action (deduct)` | `card.exec.balance`, `user.balance` |
| `can_view_agencies` | owner, app_admin, ops_admin, ops_member, finance_admin, finance_member | 0 — — | `hostApp.docs`, `partner.documents`, `partners.directory (screen)`, `partners.one (screen)` |
| `can_approve_kyc` | owner, ops_admin | 22 — `POST /partner-ops/partners`; `POST /partner-ops/partners/{partner_id}/attach-login`; `POST /partner-ops/partners/{partner_id}/approve`; `POST /partner-ops/partners/{partner_id}/grant-capability`; `POST /partner-ops/partners/{partner_id}/second-role`; `POST /partner-ops/partners/{partner_id}/reject`; `POST /partner-ops/partners/{partner_id}/pending-changes/decide`; `POST /partner-ops/partners/{partner_id}/deactivate`; `POST /partner-ops/partners/{partner_id}/reactivate`; `POST /partner-ops/partners/{partner_id}/revoke`; `POST /partner-ops/partners/{partner_id}/activate`; `GET /partner-ops/role-appeals`; `POST /partner-ops/role-appeals/{appeal_id}/recommend`; `POST /partner-ops/transfers`; `GET /partner-ops/transfers`; `POST /users/host-applications/{application_id}/decide`; `POST /users/host-applications/{application_id}/pending-changes/decide`; `POST /users/{uid}/revoke-host`; `POST /users/{uid}/restore-host`; `GET /host-verification/pending`; `GET /host-verification/{uid}`; `POST /host-verification/{uid}/review` | `hostApp.changes`, `hostApp.decide`, `hostVerification`, `partner.activate`, `partner.approve`, `partner.changes`, `partner.deactivate`, `partner.reactivate`, `partner.reject`, `partner.revoke`, `partner.secondRole`, `partners.directory (screen)`, `partners.one (screen)`, `role.revokePartner`, `roleAppeal.recommend`, `roleAppeals`, `transfer.new`, `transfers`, `user.restoreHost`, `user.revokeHost`, `user.transfer`, `verify.review` |
| `can_view_sellers` | owner, app_admin, ops_admin, ops_member, finance_admin, finance_member | 0 — — | `partner.documents`, `partners.directory (screen)`, `partners.one (screen)`, `recharges`, `sales` |
| `can_approve_seller` | owner, ops_admin | 13 — `POST /partner-ops/partners/{partner_id}/attach-login`; `POST /partner-ops/partners/{partner_id}/virtual-account`; `POST /partner-ops/partners/{partner_id}/approve`; `POST /partner-ops/partners/{partner_id}/grant-capability`; `POST /partner-ops/partners/{partner_id}/second-role`; `POST /partner-ops/partners/{partner_id}/reject`; `POST /partner-ops/partners/{partner_id}/deactivate`; `POST /partner-ops/partners/{partner_id}/reactivate`; `POST /partner-ops/partners/{partner_id}/revoke`; `POST /partner-ops/partners/{partner_id}/activate`; `GET /partner-ops/role-appeals`; `POST /partner-ops/role-appeals/{appeal_id}/recommend`; `POST /users/{uid}/seller-flag` | `partner.activate`, `partner.approve`, `partner.deactivate`, `partner.reactivate`, `partner.reject`, `partner.revoke`, `partner.secondRole`, `partner.van`, `partners.directory (screen)`, `partners.one (screen)`, `role.revokePartner`, `roleAppeal.recommend`, `roleAppeals`, `user.sellerFlag` |
| `can_coin_operations` | owner, finance_admin, finance_member | 14 — `POST /partner-ops/coin-purchases/{card_id}/execute`; `POST /partner-ops/sellers/{seller_id}/lending`; `POST /partner-ops/lending/{card_id}/execute`; `POST /partner-ops/sellers/{seller_id}/repayments`; `POST /partner-ops/repayments/{card_id}/execute`; `POST /partner-ops/sellers/{seller_id}/recoveries`; `POST /partner-ops/recoveries/{card_id}/execute`; `POST /partner-ops/partners/{partner_id}/write-off`; `POST /partner-ops/write-offs/{card_id}/execute`; `POST /partner-ops/sales/{sale_id}/approve`; `POST /partner-ops/recharges/{recharge_id}/approve`; `POST /partner-ops/recharges/{recharge_id}/reject`; `POST /partner-ops/recharges/{recharge_id}/refund`; `POST /partner-ops/recharges/{recharge_id}/refund/decide` | `card.exec.coin`, `card.exec.lend`, `card.exec.recover`, `card.exec.repay`, `card.exec.writeoff`, `cards.coinPurchases`, `coinReq.convert`, `coinRequests`, `partner.lend`, `partner.recover`, `partner.repay`, `partner.writeoff`, `partners.directory (screen)`, `partners.one (screen)`, `recharge.approve`, `recharge.refund`, `recharge.refundDecide`, `recharge.reject`, `recharges`, `sale.approve`, `sales`, `seller.buy` |
| `can_view_finance` | owner, app_admin, ops_admin, finance_admin, finance_member | 0 — — | — (no mobile gate) |
| `can_process_payout` | owner, finance_admin, finance_member | 12 — `POST /partner-ops/agencies/{agency_id}/commission-payouts`; `POST /partner-ops/commission-payouts/{card_id}/execute`; `POST /partner-ops/agencies/{agency_id}/commission-accruals`; `POST /partner-ops/hosts/{host_uid}/withdrawals`; `POST /partner-ops/host-withdrawals/{card_id}/execute`; `POST /partner-ops/subagency-payouts`; `POST /partner-ops/subagency-payouts/{card_id}/execute`; `POST /partner-ops/subagency-payouts/{payout_id}/confirm-leg`; `GET /partner-ops/held-items`; `POST /partner-ops/held-items/{item_type}/{item_id}/release`; `GET /partner-ops/money/replica-drift`; `POST /partner-ops/money/replica-drift/repair` | `card.exec.commission`, `card.exec.subagency`, `card.exec.withdrawal`, `held.release`, `heldItems`, `partner.commission`, `replicaDrift`, `salary.card`, `subpayout.confirm`, `withdrawal.card` |
| `can_economy_config` | owner, tech_admin, tech_member | 5 — `POST /chance/configs/preview`; `POST /chance/mechanics`; `POST /chance/mechanics/{mechanic_id}/configs`; `POST /chance/configs/{card_id}/activate`; `POST /chance/mechanics/{mechanic_id}/withdraw-country` | — (no mobile gate) |
| `can_commission_slabs` | owner, tech_admin, tech_member | 0 — — | — (no mobile gate) |
| `can_app_config` | owner, app_admin, tech_admin, tech_member | 0 — — | — (no mobile gate) |
| `can_create_tickets` | owner, app_admin, app_member, ops_admin, ops_member, finance_admin, finance_member, tech_admin, tech_member, support_admin, support_member, marketing_admin, marketing_member | 0 — — | — (no mobile gate) |
| `can_assign_tickets` | owner, app_admin, ops_admin, finance_admin, tech_admin, support_admin, support_member, marketing_admin | 0 — — | — (no mobile gate) |
| `can_close_tickets` | owner, app_admin, ops_admin, finance_admin, tech_admin, support_admin, marketing_admin | 0 — — | — (no mobile gate) |
| `can_approve_requests` | owner | 3 — `POST /cards/{card_id}/sign`; `POST /cards/sign-bulk`; `POST /cards/{card_id}/owner-fast-path` | `card.sign` |
| `can_manage_team` | owner, app_admin, ops_admin, finance_admin, tech_admin, support_admin, marketing_admin | 6 — `POST /staff`; `PATCH /staff/{uid}/role`; `PATCH /staff/{uid}/employment`; `POST /staff/{uid}/deactivate`; `POST /staff/{uid}/suspend`; `POST /staff/{uid}/reactivate` | `staff.deactivate`, `staff.employment`, `staff.invite`, `staff.reactivate`, `staff.role`, `staff.suspend` |
| `can_monitor_live` | owner, app_admin, app_member | 0 — — | — (no mobile gate) |
| `can_send_broadcasts` | owner, marketing_admin, marketing_member | 0 — — | — (no mobile gate) |

## C. Other CRM clients (`apiPartners`, `apiChance`, `apiCapital`, `apiExpenses`, `apiReports`, `broadcasts`) and Android-first routes

Every backend route not reached through `lib/api.ts`.

| Area | Backend route | Guard · permission key | CRM client | Android Work hub | Status |
|---|---|---|---|---|---|
| Broadcasts | GET `/broadcasts/audience` | `require_write` | `lib/broadcasts.ts` | `broadcasts.email/email.preview` | Mobile (read) |
| Broadcasts | GET `/broadcasts/audiences` | `require_write` | `lib/broadcasts.ts` | `broadcasts.email` (screen) | Mobile (read) |
| Broadcasts | POST `/broadcasts/email` | `require_write` | `app/broadcasts/page.tsx`, `app/layout.tsx` | `broadcasts.email/email.send` | Mobile |
| Chance | POST `/chance/configs/preview` | `require_team_admin` · `can_economy_config` | `lib/apiChance.ts` | — | CRM-only · odds-table editor (structured, ppm-validated) |
| Chance | POST `/chance/configs/{card_id}/activate` | `require_owner` · `can_economy_config` | `lib/apiChance.ts` | — | CRM-only · Owner governance (activate a signed odds table) |
| Chance | POST `/chance/edge/… (9 routes)` | Functions service credential | — | — | Not a Work-hub capability · App edge (the player's app through Functions), not a Work-hub capability |
| Chance | GET `/chance/exceptions` | `require_internal` | `lib/apiChance.ts` | `chance.exceptions` (screen) | Mobile (read) |
| Chance | GET `/chance/exposure` | `require_internal` | `app/chance/monitoring/page.tsx`, `app/chance/page.tsx` | — | CRM-only · read view |
| Chance | GET `/chance/margin` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | GET `/chance/mechanics` | `require_internal` | `lib/apiChance.ts` | `chance.mechanics` (screen) | Mobile (read) |
| Chance | POST `/chance/mechanics` | `require_team_admin` · `can_economy_config` | `lib/apiChance.ts` | — | CRM-only · odds-table editor (structured, ppm-validated) |
| Chance | GET `/chance/mechanics/{mechanic_id}` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | GET `/chance/mechanics/{mechanic_id}/configs` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | POST `/chance/mechanics/{mechanic_id}/configs` | `require_team_admin` · `can_economy_config` | `lib/apiChance.ts` | — | CRM-only · odds-table editor (structured, ppm-validated) |
| Chance | GET `/chance/mechanics/{mechanic_id}/configs/{version}` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | GET `/chance/mechanics/{mechanic_id}/exposure` | `require_internal` | `lib/apiChance.ts` | `chance.mechanics/chance.exposure` | Mobile (read) |
| Chance | POST `/chance/mechanics/{mechanic_id}/resume` | `require_owner` | `lib/apiChance.ts` | `chance.mechanics/chance.resume` | Mobile — Owner |
| Chance | GET `/chance/mechanics/{mechanic_id}/rtp` | `require_internal` | `lib/apiChance.ts` | `chance.mechanics/chance.rtp` | Mobile (read) |
| Chance | POST `/chance/mechanics/{mechanic_id}/suspend` | `require_team_admin` | `lib/apiChance.ts` | `chance.mechanics/chance.suspend` | Mobile |
| Chance | POST `/chance/mechanics/{mechanic_id}/withdraw-country` | `require_owner` · `can_economy_config` | `lib/apiChance.ts` | — | CRM-only · Owner governance (withdraw a mechanic from a country) |
| Chance | GET `/chance/players/{player_uid}/activity` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Chance | GET `/chance/players/{player_uid}/anomalies` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | POST `/chance/players/{player_uid}/freeze` | `require_team_admin` | `lib/apiChance.ts` | `chance.protection/flag.freeze` | Mobile |
| Chance | GET `/chance/players/{player_uid}/rounds` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Chance | POST `/chance/players/{player_uid}/unfreeze` | `require_team_admin` | `lib/apiChance.ts` | `chance.protection/flag.unfreeze` | Mobile |
| Chance | GET `/chance/protection/flags` | `require_internal` | `lib/apiChance.ts` | `chance.protection` (screen) | Mobile (read) |
| Chance | POST `/chance/protection/flags/{flag_id}/review` | `require_team_admin` | `lib/apiChance.ts` | `chance.protection/flag.review` | Mobile |
| Chance | GET `/chance/protection/players/{player_uid}` | `require_internal` | `lib/apiChance.ts` | — | CRM-only · read view |
| Chance | POST `/chance/protection/players/{player_uid}/limits` | `require_team_admin` | `lib/apiChance.ts` | — | Gap · player-protection casework (team admin) |
| Chance | POST `/chance/protection/players/{player_uid}/self-exclusion/decide` | `require_team_admin` | `lib/apiChance.ts` | — | Gap · player-protection casework (team admin) |
| Chance | GET `/chance/rounds/{round_id}` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | GET `/notifications/alerts` | `require_internal` | `lib/apiReports.ts` | — | CRM-only · read view |
| Jobs, alerts & email | GET `/notifications/alerts/open` | `require_internal` | `lib/apiReports.ts` | `alerts` (screen) | Mobile (read) |
| Jobs, alerts & email | GET `/notifications/alerts/raised` | `require_internal` | `lib/apiReports.ts` | `alerts.raised` (screen) | Mobile (read) |
| Jobs, alerts & email | DELETE `/notifications/alerts/raised/{key:path}` | `require_owner` | `lib/apiReports.ts` | `alerts.raised/alert.release` | Mobile — Owner |
| Jobs, alerts & email | GET `/notifications/audiences/{name:path}` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | GET `/notifications/deliveries` | `require_internal` | `lib/apiReports.ts` | `email.log` (screen) | Mobile (read) |
| Jobs, alerts & email | GET `/notifications/deliveries/failures` | `require_internal` | `lib/apiReports.ts` | — | CRM-only · read view |
| Jobs, alerts & email | GET `/notifications/deliveries/summary` | `require_internal` | `lib/apiReports.ts` | — | CRM-only · read view |
| Jobs, alerts & email | GET `/notifications/email-templates` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | GET `/notifications/email-templates/{name}/preview` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | POST `/notifications/jobs/alerts` | `team_admin_or_alerts_service` | `lib/apiReports.ts` | `jobs/job.alerts` | Mobile |
| Jobs, alerts & email | POST `/notifications/jobs/daily` | `team_admin_or_reporting_service` | `lib/apiReports.ts` | `jobs/job.daily` | Mobile |
| Jobs, alerts & email | POST `/notifications/jobs/monthly` | `team_admin_or_reporting_service` | `lib/apiReports.ts` | — | CRM-only · team-admin job re-run |
| Jobs, alerts & email | POST `/notifications/jobs/partner-statements` | `team_admin_or_reporting_service` | `lib/apiReports.ts` | — | CRM-only · team-admin job re-run |
| Jobs, alerts & email | POST `/notifications/jobs/reconcile` | `team_admin_or_reporting_service` | — | — | CRM-only · team-admin job (no client yet) |
| Jobs, alerts & email | POST `/notifications/jobs/transactional-sweep` | `team_admin_or_email_sweep_service` | `lib/apiReports.ts` | `jobs/job.transactional-sweep` | Mobile |
| Jobs, alerts & email | POST `/notifications/provider-events` | `internal_or_email_events_service` | — | — | Not a Work-hub capability · Email provider webhook (machine) |
| Jobs, alerts & email | GET `/notifications/reconciliation` | `team_admin_or_reporting_service` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | GET `/notifications/runs` | `require_internal` | `lib/apiReports.ts` | — | CRM-only · read view |
| Jobs, alerts & email | GET `/notifications/runs/last` | `require_internal` | `lib/apiReports.ts` | `jobs` (screen) | Mobile (read) |
| Jobs, alerts & email | GET `/notifications/schedule` | `require_internal` | `lib/apiReports.ts` | — | CRM-only · read view |
| Jobs, alerts & email | GET `/notifications/subscriptions` | `require_internal` | — | — | No client yet · internal read (neither the CRM nor the app calls it) |
| Jobs, alerts & email | POST `/notifications/subscriptions` | `require_owner` | — | — | CRM-only · Owner governance (who is emailed what; no client yet) |
| Jobs, alerts & email | GET `/notifications/unsubscribe` | none (public / self-scoped) | — | — | Not a Work-hub capability · Email footer link (public) |
| Jobs, alerts & email | POST `/notifications/unsubscribe` | none (public / self-scoped) | — | — | Not a Work-hub capability · Email footer link (public) |
| Money | GET `/capital` | `require_internal` | `lib/apiCapital.ts` | `capital` (screen) | Mobile (read) |
| Money | POST `/capital` | `require_write` | `lib/apiCapital.ts` | `capital/capital.record` | Mobile |
| Money | POST `/capital/{card_id}/settle` | `require_owner` | `lib/apiCapital.ts` | `expenses/card.exec.capital`, `cards.board/card.exec.capital`, `cards.coinPurchases/card.exec.capital` | Mobile — Owner |
| Money | GET `/expenses` | `require_internal` | `lib/apiExpenses.ts` | `expenses` (screen) | Mobile (read) |
| Money | POST `/expenses` | `require_write` | `lib/apiExpenses.ts` | `expenses/expense.new` | Mobile |
| Money | GET `/expenses/recurring-due` | `require_internal` | `lib/apiExpenses.ts` | `expenses/expense.due` | Mobile (read) |
| Money | POST `/expenses/{card_id}/pay` | `require_owner` | `lib/apiExpenses.ts` | `expenses/card.exec.expense`, `cards.board/card.exec.expense`, `cards.coinPurchases/card.exec.expense` | Mobile — Owner |
| Money | POST `/expenses/{card_id}/repeat` | `require_write` | `lib/apiExpenses.ts` | `expenses/expense.repeat` | Mobile |
| Money cards | POST `/cards/{card_id}/owner-fast-path` | `require_owner` · `can_approve_requests` | — | — | CRM-only · Owner governance — read-only marker `cards.board/card.fastPath` (the CRM in this tree has no caller yet) |
| Partners & money ops | GET `/partner-ops/agencies/{agency_id}/commission-preview` | `internal_or_accrual_service` | — | `partners.directory/partner.preview`, `partners.one/partner.preview` | Mobile · Android-first (no CRM caller in this tree) |
| Partners & money ops | POST `/partner-ops/agencies/{agency_id}/sub-agencies/reapply` | `require_write_or_partner` | `lib/apiPartners.ts` | — | Gap · an agency re-filing a rejected sub-agency (CRM agency dashboard) |
| Partners & money ops | POST `/partner-ops/applications` | `team_admin_or_partner_apply_service` | `lib/apiPartners.ts` | — | Not a Work-hub capability · Partner application form (apply service) |
| Partners & money ops | GET `/partner-ops/applications/eligibility/{uid}` | `team_admin_or_partner_apply_service` | — | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | POST `/partner-ops/applications/host` | `team_admin_or_partner_apply_service` | — | — | Not a Work-hub capability · Host application form (apply service) |
| Partners & money ops | GET `/partner-ops/applications/of/{uid}` | `team_admin_or_partner_apply_service` | `lib/apiPartners.ts` | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | GET `/partner-ops/applications/parents` | `team_admin_or_partner_apply_service` | — | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | POST `/partner-ops/applications/verification/check` | `team_admin_or_partner_apply_service` | — | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | POST `/partner-ops/applications/verification/conflict` | `team_admin_or_partner_apply_service` | — | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | GET `/partner-ops/applications/verification/{uid}` | `team_admin_or_partner_apply_service` | `lib/apiPartners.ts` | — | Not a Work-hub capability · Application form helper (apply service) |
| Partners & money ops | GET `/partner-ops/frozen-money` | `require_owner` | `lib/apiPartners.ts`, `lib/backendFeatures.ts` | `frozenMoney` (screen) | Mobile (read) |
| Partners & money ops | POST `/partner-ops/frozen-money/{freeze_key}/decide` | `require_owner` | `lib/apiPartners.ts` | `frozenMoney/freeze.decide` | Mobile — Owner |
| Partners & money ops | GET `/partner-ops/held-items` | `require_internal` · `can_process_payout` | — | `heldItems` (screen) | Mobile · Android-first (no CRM caller in this tree) |
| Partners & money ops | POST `/partner-ops/held-items/{item_type}/{item_id}/release` | `require_internal` · `can_process_payout` | — | `heldItems/held.release` | Mobile · Android-first (no CRM caller in this tree) |
| Partners & money ops | GET `/partner-ops/me/verification` | `current_user` | `lib/apiPartners.ts` | `partner.verification` (screen) | Mobile (read) |
| Partners & money ops | POST `/partner-ops/me/verification/check` | `require_write_or_partner` | `lib/apiPartners.ts` | `partner.verification/verification.check` | Mobile |
| Partners & money ops | POST `/partner-ops/me/verification/conflict` | `require_write_or_partner` | `lib/apiPartners.ts` | — | Gap · a partner reporting a contact that belongs to another account (CRM partner panel) |
| Partners & money ops | GET `/partner-ops/money/replica-drift` | `require_internal` · `can_process_payout` | — | `replicaDrift` (screen) | Mobile · Android-first (no CRM caller in this tree) |
| Partners & money ops | POST `/partner-ops/money/replica-drift/repair` | `require_internal` · `can_process_payout` | — | — | CRM-only · Finance/Owner repair (no client yet; the 15-minute sweep runs it) |
| Partners & money ops | GET `/partner-ops/owner-notices` | `require_owner` | — | — | CRM-only · Owner governance (no client yet on either side) |
| Partners & money ops | POST `/partner-ops/owner-notices/retry` | `require_owner` | — | — | CRM-only · Owner governance (no client yet on either side) |
| Partners & money ops | POST `/partner-ops/partners` | `team_admin_or_partner_registration_service` · `can_approve_kyc` | `lib/agencies.ts`, `lib/apiPartners.ts` | — | Not a Work-hub capability · Partner registration form / Firestore trigger (registration service) |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/activate` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `lib/apiPartners.ts` | `partners.directory/partner.activate`, `partners.one/partner.activate` | Mobile |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/attach-login` | `require_team_admin` · any of `can_approve_kyc` / `can_approve_seller` | — | — | CRM-only · onboarding repair (team admin; no CRM client in this tree yet) |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/grant-capability` | `require_team_admin` · any of `can_approve_kyc` / `can_approve_seller` | — | — | Not offered anywhere — spec §4 removed this staff role-grant (CRM and, now, Android) |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/pending-changes/decide` | `require_write` · `can_approve_kyc` | `lib/apiPartners.ts` | `partners.directory/partner.changes`, `partners.one/partner.changes` | Mobile |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/revoke` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `lib/apiPartners.ts` | `partners.directory/partner.revoke`, `partners.one/partner.revoke`, `users.record/role.revokePartner` | Mobile |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/second-role` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `lib/apiPartners.ts` | `partners.directory/partner.secondRole`, `partners.one/partner.secondRole` | Mobile |
| Partners & money ops | POST `/partner-ops/partners/{partner_id}/virtual-account` | `require_team_admin` · `can_approve_seller` | `lib/apiPartners.ts` | `partners.directory/partner.van`, `partners.one/partner.van` | Mobile |
| Partners & money ops | GET `/partner-ops/recharges` | `current_user` | `lib/apiPartners.ts` | `recharges` (screen) | Mobile (read) |
| Partners & money ops | POST `/partner-ops/recharges` | `team_admin_or_recharge_request_service` | `lib/apiPartners.ts` | — | Not a Work-hub capability · Filed by the buyer from the app (recharge request service) |
| Partners & money ops | GET `/partner-ops/recharges/{recharge_id}` | `current_user` | `lib/apiPartners.ts` | — | CRM-only · read view |
| Partners & money ops | POST `/partner-ops/recharges/{recharge_id}/approve` | `require_owner` · `can_coin_operations` | `lib/apiPartners.ts` | `recharges/recharge.approve` | Mobile — Owner |
| Partners & money ops | POST `/partner-ops/recharges/{recharge_id}/refund` | `require_write` · `can_coin_operations` | `lib/apiPartners.ts` | `recharges/recharge.refund` | Mobile |
| Partners & money ops | POST `/partner-ops/recharges/{recharge_id}/refund/decide` | `require_owner` · `can_coin_operations` | `lib/apiPartners.ts` | `recharges/recharge.refundDecide` | Mobile — Owner |
| Partners & money ops | POST `/partner-ops/recharges/{recharge_id}/reject` | `require_write` · `can_coin_operations` | `lib/apiPartners.ts` | `recharges/recharge.reject` | Mobile |
| Partners & money ops | GET `/partner-ops/role-appeals` | `require_internal` · any of `can_approve_kyc` / `can_approve_seller` | `lib/apiPartners.ts`, `lib/backendFeatures.ts` | `roleAppeals` (screen) | Mobile (read) |
| Partners & money ops | POST `/partner-ops/role-appeals` | `team_admin_or_partner_apply_service` | `lib/apiPartners.ts`, `lib/backendFeatures.ts` | — | Not a Work-hub capability · Filed by the person from the app (partner apply service) |
| Partners & money ops | GET `/partner-ops/role-appeals/of/{uid}` | `team_admin_or_partner_apply_service` | `lib/apiPartners.ts` | — | Not a Work-hub capability · Appeal form helper (apply service) |
| Partners & money ops | POST `/partner-ops/role-appeals/{appeal_id}/decide` | `require_write` | `lib/apiPartners.ts` | `roleAppeals/roleAppeal.decide` | Mobile |
| Partners & money ops | POST `/partner-ops/role-appeals/{appeal_id}/recommend` | `require_write` · any of `can_approve_kyc` / `can_approve_seller` | `lib/apiPartners.ts` | `roleAppeals/roleAppeal.recommend` | Mobile |
| Partners & money ops | GET `/partner-ops/transfers` | `require_internal` · `can_approve_kyc` | `lib/apiPartners.ts`, `lib/backendFeatures.ts` | `transfers` (screen) | Mobile (read) |
| Partners & money ops | POST `/partner-ops/transfers` | `require_write` · `can_approve_kyc` | `lib/apiPartners.ts`, `lib/backendFeatures.ts` | `users.record/user.transfer`, `transfers/transfer.new` | Mobile |
| Partners & money ops | POST `/partner-ops/transfers/{request_id}/decide` | `require_write` | `lib/apiPartners.ts` | `transfers/transfer.decide` | Mobile |
| Partners & money ops | GET `/partners/agencies/{agency_id}/appeals` | `current_user` | `lib/apiPartners.ts` | `agency.appeals` (screen) | Mobile (read) |
| Partners & money ops | GET `/partners/agencies/{agency_id}/host-reports` | `current_user` | `lib/apiPartners.ts` | `agency.reports` (screen) | Mobile (read) |
| Partners & money ops | GET `/partners/agencies/{agency_id}/sub-agencies` | `current_user` | `lib/apiPartners.ts` | `agency.subs` (screen) | Mobile (read) |
| Partners & money ops | GET `/partners/sellers/{seller_id}/can-take-inventory` | `current_user` | `lib/apiPartners.ts` | `seller.statement/seller.canTake` | Mobile (read) |
| Partners & money ops | GET `/partners/sellers/{seller_id}/history` | `current_user` | `lib/apiPartners.ts` | `seller.history` (screen) | Mobile (read) |
| Public | POST `/public/appeals` | none (public / self-scoped) | — | — | Not a Work-hub capability · Public appeal web form |
| Reports | GET `/reports/cannibalisation` | `require_internal` | `lib/apiChance.ts` | `reports.cannibalisation` (screen) | Mobile (read) |
| Reports | GET `/reports/chance-margin` | `require_internal` | `lib/apiChance.ts` | `reports.chanceMargin` (screen) | Mobile (read) |
| Reports | GET `/reports/chance-revenue` | `require_internal` | `lib/apiChance.ts` | `reports.chanceRevenue` (screen) | Mobile (read) |
| Reports | POST `/reports/jobs/weekly-business` | `team_admin_or_reporting_service` | `lib/apiReports.ts` | `reports.weekly/weekly.rerun` | Mobile |
| Reports | GET `/reports/payout-policy` | `require_internal` | — | `reports.payoutPolicy` (screen) | Mobile · Android-first (no CRM caller in this tree) |
| Reports | GET `/reports/weekly-business/{week}` | `require_internal` | `lib/apiReports.ts` | `reports.weekly` (screen) | Mobile (read) |
| Sessions & sign-in | GET `/auth/me` | `current_user` | `components/AuthProvider.tsx` | OwnerMfaGate + Work hub caps | Mobile (read) |
| Sessions & sign-in | POST `/auth/mfa/bind/confirm` | `current_user` | `lib/api.ts` (helper) | ApiClient (ownerWork) | App door · `ApiClient` confirms the `ownerWork` sign-in (CRM: `redeemOwnerBinding`, lib/api.ts) |
| Sessions & sign-in | GET `/auth/sessions` | `current_user` | — | `sessions` (screen) | Mobile · Android-first (no CRM caller in this tree) |
| Sessions & sign-in | POST `/auth/sessions/revoke-all` | `current_user` | — | `sessions/sessions.revokeOthers`, `sessions/sessions.revokeAll` | Mobile · Android-first (no CRM caller in this tree) |
| Team | GET `/staff/departments` | `current_user` | — | `departments` (screen) | Mobile · Android-first (no CRM caller in this tree) |
| Team | POST `/staff/owners` | `require_owner_provisioner` | — | — | CRM-only · Observer governance (provision an Owner; no CRM client in this tree yet) |
| Team | POST `/staff/owners/{uid}/deactivate` | `require_owner_provisioner` | — | — | CRM-only · Observer governance (deactivate an Owner; no CRM client in this tree yet) |
| Users & moderation | POST `/users/appeals/{appeal_id}/recommend` | `require_write` · `can_ban_users` | — | `accountAppeals/appeal.recommend` | Mobile · Android-first (no CRM caller in this tree) |
| Users & moderation | POST `/users/live-rooms/{room_id}/end` | `require_write` | `lib/apiPartners.ts` | `live.rooms/live.end` | Mobile |
| Users & moderation | POST `/users/live-rooms/{room_id}/mute` | `require_write` | `lib/apiPartners.ts` | `live.rooms/live.mute` | Mobile |
| Users & moderation | POST `/users/{uid}/seller-flag` | `require_write` · `can_approve_seller` | — | `users.record/user.sellerFlag` | Mobile · Android-first (no CRM caller in this tree) |

## D. Gaps and deliberate differences

**Gaps (non-governance, CRM-only today):** routing a support ticket to a
department (`tickets.routeSupport`); raising a sub-agency payout
(`partnerOps.requestSubAgencyPayout` — mobile confirms leg 2 and the Owner
executes); a partner reporting a contact that belongs to another account
(`/partner-ops/me/verification/conflict`); an agency re-filing a rejected
sub-agency (`/sub-agencies/reapply`); chance player-protection casework (limits,
self-exclusion decisions).

**Changed on Android to match the CRM (this batch):**
* `grant-capability` — staff filing a second role nobody asked for — was taken out
  of the CRM as a role-grant control (spec §4). Android offered it as "Add second
  capability"; it is replaced by the CRM's bridge `partner.secondRole`
  (`POST /partner-ops/partners/{id}/second-role`, the partner's own application
  brought into the review queue). Pinned: no Work-hub action calls
  `grant-capability`.
* Ban: reason + scope (`account` / `account_and_devices`) + category + evidence
  references, exactly as `routers/users.py Ban` reads them.

**Android-first (no CRM caller in this tree):** sessions / sign out everywhere,
departments, held items (+ release), replica drift, payout policy, appeal
recommendation, commission preview, removing the shop seller flag (the CRM
dropped its client; the server refuses granting it).

**Read-only on mobile by design:** economy, app control, daily rewards, profile
options and payment methods (edited in the CRM, with approval for non-Owners);
odds tables (structured, ppm-validated editor in the CRM).

## E. The Owner two-step gate on the app login

* **Where:** `OwnerMfaGateHost` wraps the Main destination (`ZipperNavGraph`), so
  every way into Main passes it. Pre-filter: the server's last
  `resolveIdentity.crmRole` (`superadmin` / `owner`), cached in DataStore at
  sign-in and at every cold start — it grants nothing; the decision is
  `GET /api/auth/me` `role == "owner"`. Everyone else costs one DataStore read.
* **Sequence (`routers/auth.py`):** `POST /auth/signin {id_token, client: "android"}`
  → PENDING Owner session → `GET /auth/me` → `GET /auth/mfa/status` →
  enrol (`/mfa/enrol/start` → key shown once: text + copy (sensitive) + "Open in
  authenticator app"; `/mfa/enrol/confirm` → recovery codes shown once) or verify
  (`/mfa/verify` code or recovery code). `ApiClient` adds `firebase_id_token` +
  `client: "android"`, adopts the upgraded session, redeems the
  `ownerWork` custom token and calls `/mfa/bind/confirm`; an unbound result is said
  once (Retry unlock = `/mfa/bind`, or Continue). A server with no two-step routes
  (404) gets the CRM's notice, then Continue.
* **Refusals:** the Observer (`observer_denied`, or `role == "observer"`) is signed
  out at once with "This account cannot use the app."; deactivated / not
  configured → the sentence and Sign out; network / 5xx → Try again or Sign out —
  never a bypass. Five wrong codes → the 15-minute lock, counted down on screen.
  A 401 from a code route is never replayed by `ApiClient` (a replay would be
  charged as a second wrong code).
* **Storage and logs:** the API session (pending or verified) is in
  `ApiClient` memory only — never DataStore, preferences or a file; a process
  death asks for the code again. The setup key and recovery codes are never
  stored. No log line carries a token, code, key or password (pinned app-wide).

## Tests that pin this document

| Test | Pins |
|---|---|
| `data/work/WorkParityTest` | capability → modules / actions per role; per-role counts above; sessions row mapping and gates; held items, replica drift, appeal and transfer fields against the backend services; ban / warning bodies; second-role bridge; departments vacancy label; no local role flags in work sources |
| `data/work/WorkModulesTest` | every route exists on the backend; every write confirms; observer reads only; partner allowlist; owner-only decisions; permission names = server's |
| `ui/screens/auth/OwnerMfaGateTest` | the whole MFA state machine; code / recovery normalisation; lock countdown; server answers → events; `client: "android"`; no code replay; session memory-only; Sign out / Continue / Observer sign-out wiring; no credential in any log line |
| `util/Apk20WiringTest` | the gate wraps Main; crm-role pre-filter written at sign-in and cold start |
