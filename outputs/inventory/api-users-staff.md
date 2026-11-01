# API inventory — users, verification, role appeals, transfers, audit, documents, staff

Source: `backend/app/routers/{users,verification,role_appeals,transfer_requests,audit,documents,staff}.py` + the services they call. All routers are mounted with `prefix="/api"` (`backend/app/main.py`). **50 endpoints.**

---

## 0. Conventions shared by every endpoint

### Auth dependencies (`backend/app/core/deps.py`)
| Dependency | Who passes |
|---|---|
| `current_user` | Any valid `Authorization: Bearer <session>` that passes `assert_may_act`. **External partner sessions (agency/seller) are refused 403 "Not available to partner accounts." on any route not in `PARTNER_REACHABLE`.** Of the routes here, only `GET /api/documents/batch` and `GET /api/documents/{kind}/{record_id}` are partner-reachable. So `current_user` here = any internal role incl. observer. |
| `require_write` | `current_user` + not external + not observer ("The observer account is read-only."). |
| `require_internal` | `current_user` + role in INTERNAL_ROLES (owner, observer, all 12 department roles). |
| `require_team_admin` | owner or any `*_admin` role. |
| `require_owner` | owner only ("Only a business owner can approve this."). |
| `require_owner_provisioner` | observer only. |
| `require_permission(P...)` (in `dependencies=[...]`) | **Internally depends on `require_write`** — so it also refuses observer and partners, even on GET routes. Then checks the role's permission set (`core/roles.PERMISSIONS`) and re-confirms the role on the staff record. `any_of=True` = at least one. |
| `team_admin_or_partner_apply_service` | Either header `X-Service-Key: <key>` valid for op `PARTNER_APPLY` (used by Cloud Functions callables), **or** a session passing `require_team_admin`. |
| `enforce_permission(user, P)` | in-function check, same semantics as `require_permission`. |

### Permission holders (`core/roles.PERMISSIONS`) — the ones used here
| Permission | Roles holding it (owner holds all; observer holds none) |
|---|---|
| `can_view_users` | app_admin, app_member, ops_admin, finance_admin, support_admin, support_member |
| `can_ban_users` | app_admin, app_member |
| `can_adjust_balance` | app_admin, finance_admin |
| `can_approve_kyc` | ops_admin |
| `can_approve_seller` | ops_admin |
| `can_manage_team` | app_admin, ops_admin, finance_admin, tech_admin, support_admin, marketing_admin |
| `can_view_agencies` | app_admin, ops_admin, ops_member, finance_admin, finance_member |
| `can_view_sellers` | app_admin, ops_admin, ops_member, finance_admin, finance_member |
| `can_coin_operations` | finance_admin, finance_member |

Roles: `observer, owner, app_admin, app_member, ops_admin, ops_member, finance_admin, finance_member, tech_admin, tech_member, support_admin, support_member, marketing_admin, marketing_member` (+ external `agency`, `seller`).

### Errors
`HTTPException` → `{"detail": "<sentence>"}` (safe to show). Exceptions:
- `/api/users/*` `_fail`: `ProtectedTarget`/`OwnerOnly` → 403; `UserNotFound` → 404; other `UserError` → 400; HT-2 errors carry 409 ("not applied, resend") or 503 ("outcome unknown"). `HostContactVerificationRequired` returns a **structured** detail: `{"detail": {"message", "code", "requirement": "both", "missing": [...], "emailUnproved"}}`.
- `ensure_ordinary_target` (applied by ban/unban/suspend/resume/warn/revoke-host/restore-host/seller-flag/balance-request): refuses **self-target** and any **internal staff uid** with 403.
- Pydantic validation → 422 with FastAPI's standard `{"detail": [ ... ]}`.

### Common moderation result shape (`services/users._result`)
`{"uid", "before", "after", "audit_id", ...extra}` — `before`/`after` are small dicts of the changed Firestore fields.

### Audit
Every write below records an entry in Mongo `audit` (`core/audit.record`). An audit entry (as returned by the audit/history reads):
`id, at, actor{uid,name,role,team,is_system}, action, subject{type,id}, before, after, reason, card_id, meta`.

### Signed URLs
All document/face/evidence URLs are v4 signed GCS URLs valid **15 minutes**; each entry is `url` (string|null) + `error` (string, "" when OK).

---

## 1. `/api/users` (routers/users.py) — 25 endpoints

### 1.1 POST /api/users/live-rooms/{room_id}/end
- **Auth:** `require_write` + in-route `_require_intervener`: role must be `owner`, `ops_admin` or `ops_member` (else 403 "Ending or muting a live stream is done by Ops or a business owner...").
- **Query:** none.
- **Body `LiveReason`:** `reason: str` required, min_length=6, max_length=1000.
- **Response:** `{room_id, host_uid, host_name, ended: true, ended_at, reason, audit_id, note}`.
- **State:** Firestore `liveRooms/{room_id}.isActive` true → false (+ who/when/why). Refused (400) if room missing or already ended. Host account untouched.
- **Audit:** yes, `live.room_ended` (subject `live_room`).
- **Description:** End a live stream.

### 1.2 POST /api/users/live-rooms/{room_id}/mute
- **Auth:** same as 1.1 (`require_write` + owner/ops_admin/ops_member).
- **Body `MuteHost`:** `muted: bool` required; `reason: str` required, min 6, max 1000.
- **Response:** `{room_id, host_uid, host_name, muted, was_muted, at, reason, audit_id, app_must_honour}` (`app_must_honour` is a sentence to display verbatim).
- **State:** writes `hostMuted` on the room doc (only advisory; app must honour).
- **Audit:** yes, `live.host_muted` / `live.host_unmuted`.
- **Description:** Mute/unmute a live host.

### 1.3 GET /api/users/devices/bans
- **Auth:** `current_user` (any internal incl. observer).
- **Query:** `limit: int = 100` (le=500).
- **Response:** **bare JSON array** of Firestore `bannedDevices` docs, newest first (ordered by `bannedAt`). Item id: `id` (== device id). Fields: `deviceId, deviceType ("android_id"|"imei"), reason, isActive, userUids[], sourceAccounts[], manualBan, bannedBy, bannedByName, bannedByRole, bannedAt`.
- **Audit:** no.
- **Description:** List currently banned devices.

### 1.4 POST /api/users/devices/bans  (201)
- **Auth:** `require_write` + `can_ban_users`.
- **Body `DeviceBan`:** `device_id: str` required (1–200); `device_type: "android_id"|"imei"` required; `reason: str` required (3–1000); `user_uids: list[str]` optional default `[]`; `manual: bool` optional default `true`.
- **Response:** `{device_id, before (doc|null), after (doc), audit_id}`.
- **State:** creates/merges `bannedDevices/{device_id}` with `isActive: true`, `manualBan`.
- **Audit:** yes, `device.banned`.
- **Description:** Ban a handset.

### 1.5 POST /api/users/devices/bans/{device_id}/unban
- **Auth:** `require_write` + `can_ban_users`.
- **Body `Reason`:** `reason: str` required (3–1000).
- **Response:** `{device_id, before (deleted doc), after: null, audit_id}`. 404 if no ban.
- **State:** deletes the `bannedDevices` doc (unconditional, even manual bans).
- **Audit:** yes, `device.unbanned`.
- **Description:** Lift a device ban.

### 1.6 GET /api/users/reports
- **Auth:** `current_user`.
- **Query:** `status: "pending"|"reviewed"|"actioned"|"dismissed"` optional (alias of `report_status`); `limit: int = 100` (le=500).
- **Response:** **bare array** of Firestore `reports` docs, newest first (`createdAt`). Item id `id`. Display fields: `reporterUid, reporterName, targetUid, targetName, targetType, reason, description, status, actionTaken, reviewReason, reviewedBy, reviewedByName, reviewedAt, outcomeAuditId, outcomeUid, outcomeCardId, suspensionDays, deductBeans, createdAt` (app-written fields are best-effort; review fields written by 1.7).
- **Audit:** no.
- **Description:** Reports queue.

### 1.7 POST /api/users/reports/{report_id}/action
- **Auth:** `require_write` + `can_view_users`; plus in-route by action: `suspend`/`ban` → `can_ban_users`; `deduct` → `can_adjust_balance`; `warn`/`dismiss` nothing extra.
- **Body `ReportDecision`:** `action: "warn"|"suspend"|"ban"|"deduct"|"dismiss"` required; `reason: str` required (3–1000); `days: int|null` optional (1–365, only with `suspend`); `beans: int|null` optional (ge=1, required for `deduct`, only with `deduct`).
- **Response:** `{report_id, action, status, target_uid, enforced (bool; false for deduct/dismiss), card_id (deduct only, else null), outcome (moderation result of the warn/suspend/ban, or the raised card for deduct, or null), audit_id}`.
- **State:** report `pending|reviewed` → `actioned` (or `dismissed`). Refused if already actioned/dismissed. Underlying action applies the user transition (see 1.15–1.19); deduct raises a `balance_debit` card (stage `requested`) — nothing moves.
- **Audit:** yes, `report.actioned` + the outcome's own entry.
- **Description:** Decide a report and enforce it.

### 1.8 GET /api/users/appeals
- **Auth:** `current_user`.
- **Query:** `status: "pending"|"upheld"|"overturned"|"resolved"` optional; `limit: int = 100` (le=500).
- **Response:** **bare array** of Firestore `appeals` docs, **oldest first** (`createdAt`). Item id `id`. Fields: `subjectUid, subjectName, raisedByUid, raisedByName, raisedByRole ("self"|"agency"|"public"), agencyId, kind ("ban"|"report"), reportId, statement, status, createdAt, decisionReason, decidedByName, decidedAt, resolvedByName, resolvedAt, resolvedTrigger, autoResolved, reversed[], outstanding[], source ("public_web"), reference, evidence[{path,contentType,kind,size}], evidenceUrls[]`. 503 if the Firestore index is missing.
- **Audit:** no.
- **Description:** Appeals queue.

### 1.9 GET /api/users/appeals/{appeal_id}/evidence
- **Auth:** `can_ban_users` (→ implies `require_write`; observer refused) + `current_user`.
- **Response:** `{"evidence": [{url, error, kind, contentType, size}]}`. 404 if appeal missing.
- **Audit:** yes, `appeal.evidence_viewed` (best effort).
- **Sensitive:** signed URLs to private attachments.
- **Description:** Signed links to an appeal's attachments.

### 1.10 POST /api/users/appeals/{appeal_id}/decide
- **Auth:** `require_write` + `can_ban_users`. **Separation of duties:** refused (400) if the caller is one of the original deciders (`originalDecidedBy`, the `bannedBy`/`suspendedBy` on the user, or the report's `reviewedBy`).
- **Body `AppealDecision`:** `verdict: AppealStatus` required — only `"upheld"|"overturned"` accepted by the service (`pending`/`resolved` → 400); `reason: str` required (10–2000).
- **Response:** `{appeal_id, status, subject_uid, reversed: [str], outstanding: [str], audit_id, also_resolved?: [ids]}`.
- **State:** appeal `pending` → `upheld` | `overturned`. Overturn reverses ban (unban) / suspension (resume) / report (→ `dismissed`); money already moved stays in `outstanding`. 409/503 for unconfirmed write.
- **Audit:** yes.
- **Description:** Decide an appeal.

### 1.11 POST /api/users/balance-cards/{card_id}/execute
- **Auth:** `require_owner` + `can_adjust_balance`.
- **Body:** none.
- **Response:** the card document (`_public`): `id, type ("balance_credit"|"balance_debit"), team, title, amount, currency, reason, subject{type,id}, payload{uid,name,currency,amount,balance_before_request}, evidence[], stage, requested_by{uid,name,role,team}, created_at, updated_at, verified_by, verified_at, verification_note, auto_verified, signed_by, signed_at, executed_at, execution_result{uid,currency,amount,ledger_id,balance_before,balance_after,replica_synced | error,message,available,requested}, rejected_by, rejected_at, rejection_reason`.
- **State:** card `approved` → `executed` (or `failed` on insufficient balance). Refused unless stage `approved`.
- **Audit:** yes (`balance.credit`/`balance.debit` ledger, `card.executed`/`card.execution_failed`).
- **Description:** Move money for a signed balance card.

### 1.12 POST /api/users/host-applications/{application_id}/decide
- **Auth:** `require_write` + `can_approve_kyc`. Extra: if applicant's phone+email are not both verified, **only owner** may approve (else 400/structured detail `HostContactVerificationRequired`); approval then waits for verification.
- **Body `HostDecision`:** `approve: bool` required; `reason: str` required (3–1000).
- **Response:** `{application_id, uid ('' if code not redeemed), before{status,kycStatus}, after{status,kycStatus}, audit_id, account (moderation result of host grant/revoke or null), note, notified (bool)}`.
- **State:** `hostApplications.status` and `kycStatus` together: `pending` → `approved`|`rejected`. Refuses rejecting an approved app ("use Revoke host") and re-rejecting. Approve may grant host (`users.isHost` true, agency roster row).
- **Audit:** yes, `host.application_approved`/`host.application_rejected` (+ `host.granted`).
- **Description:** Approve or refuse a host application.

### 1.13 POST /api/users/host-applications/{application_id}/pending-changes/decide
- **Auth:** `require_write` + `can_approve_kyc`. **Four-eyes:** the proposer of the change cannot decide it (400).
- **Body `HostDecision`:** `approve: bool`; `reason: str` (3–1000).
- **Response:** `{application_id, approved, applied: [field names], refused: [field names], audit_id, note}`.
- **State:** clears `pendingChanges`; approve writes allow-listed payout/identity fields and resets `kycStatus` (approved if docs present, else previous); reject restores previous `kycStatus`. Application `status` untouched.
- **Audit:** yes, `host.pending_changes_applied`/`_rejected`.
- **Sensitive:** concerns bank/identity fields (names only in response).
- **Description:** Apply/refuse a proposed host payout/identity change.

### 1.14 POST /api/users/{uid}/balance-request  (201)
- **Auth:** `require_write` + `can_adjust_balance`; target policy (not self, not staff).
- **Body `BalanceRequest`:** `currency: "diamonds"|"beans"|"coins"|"commission"` (enum `Currency`; service accepts only `diamonds`/`beans`); `amount: int` required (non-zero; positive credit, negative debit); `reason: str` (3–1000).
- **Response:** the raised card (same keys as 1.11), `stage: "requested"`, `team: "finance"`.
- **State:** new card `requested`; nothing moves.
- **Audit:** yes, `card.raised` + `balance.change_requested`.
- **Description:** Raise a balance credit/debit card.

### 1.15 POST /api/users/{uid}/ban
- **Auth:** `require_write` + `can_ban_users`; target policy.
- **Body `Reason`:** `reason: str` (3–1000).
- **Response:** `{uid, before{isBanned,isSuspended,accountState,banReason}, after{accountState:"banned",isBanned:true,isSuspended:false,banReason}, audit_id, device_banned (bool), devices_barred [ids], device_failures [{device_id,error}], crm_access{crm_sessions_revoked,crm_login_flagged,seller_listings_hidden}, note}`.
- **State:** account → `banned`; every known device → banned; Firebase sessions revoked; CRM partner access closed.
- **Audit:** yes, `user.banned` (+ `device.banned` per device).
- **Description:** Ban an account and its devices.

### 1.16 POST /api/users/{uid}/unban
- **Auth:** `require_write` + `can_ban_users`; target policy. Refuses a suspended account ("Use Resume") and a non-banned one.
- **Body `Reason`:** `reason` (3–1000).
- **Response:** `{uid, before, after{accountState:"active",isBanned:false,isSuspended:false,banReason:"",previousBanReason}, audit_id, device_unbanned, devices_released [ids], device_bans_kept [{device_id,because}], device_failures, crm_access{crm_login_flagged,seller_listings_unflagged}, note, appeal_resolved?{appeal_id,status:"resolved",subject_uid,audit_id,also_resolved?}}`.
- **State:** `banned` → `active`; releases device bans this account caused; pending appeal → `resolved`.
- **Audit:** yes, `user.unbanned` (+ `device.unbanned`, `appeal.auto_resolved`).
- **Description:** Lift a ban.

### 1.17 POST /api/users/{uid}/suspend
- **Auth:** `require_write` + `can_ban_users`; target policy. Refuses a banned account.
- **Body `Suspend`:** `reason: str` (3–1000); `days: int|null` optional (1–365; omit = indefinite).
- **Response:** `{uid, before, after{accountState:"suspended",isBanned:true,isSuspended:true,banReason,suspendedUntil (ISO or "")}, audit_id, suspended_until, crm_access, note}`.
- **State:** → `suspended` (no device barred); money frozen; sessions revoked. Auto-lifted by sweep when `days` set.
- **Audit:** yes, `user.suspended`.
- **Description:** Suspend an account.

### 1.18 POST /api/users/{uid}/resume
- **Auth:** `require_write` + `can_ban_users`; target policy. Refuses banned ("Use Unban") / not suspended.
- **Body `Reason`:** `reason` (3–1000).
- **Response:** `{uid, before, after{accountState:"active",isBanned:false,isSuspended:false,banReason:"",previousBanReason}, audit_id, device_unbanned:false, devices_released:[], crm_access, note, appeal_resolved?}`.
- **State:** `suspended` → `active`; pending appeal → `resolved`.
- **Audit:** yes, `user.resumed`.
- **Description:** Lift a suspension.

### 1.19 POST /api/users/{uid}/warn
- **Auth:** `require_write` + `can_view_users`; if `deduction` present also `can_adjust_balance` and `request_id` required (422 otherwise); target policy.
- **Body `Warn`:** `reason: str` (3–1000) required; `deduction: {currency: "diamonds"|"beans", amount: int strict 1..10_000_000} | null` optional; `request_id: str|null` optional (8–80, `^[A-Za-z0-9_-]+$`; idempotency key).
- **Response:** `{uid, before{warnings:n}, after{warnings:n+1}, audit_id, warning_id, replayed? (true on retry), deduction: null | {currency, amount, card_id, card_stage, moved:false, note}}`.
- **State:** adds `users/{uid}/warnings/{id}`, increments `warnings`; deduction raises a `balance_debit` card (`requested`). Delivers an in-app notice.
- **Audit:** yes, `user.warned` (+ `balance.change_requested` with deduction).
- **Description:** Issue a formal warning (optionally with deduction).

### 1.20 POST /api/users/{uid}/revoke-host
- **Auth:** `require_write` + `can_approve_kyc`; target policy. Refused if not a host or if Host is the person's only role (single-role rule → suspend instead).
- **Body `Reason`:** `reason` (3–1000).
- **Response:** `{uid, before{isHost:true,agencyId}, after{isHost:false,agencyId}, audit_id}`.
- **State:** `isHost` true → false; roster row marked removed; host money frozen.
- **Audit:** yes, `host.revoked`.
- **Description:** Remove Host role.

### 1.21 POST /api/users/{uid}/restore-host
- **Auth:** `require_write` + `can_approve_kyc`; **service: owner only** (403 `OwnerOnly` "Only the Owner can restore a revoked role. Recommend it on the person's reinstatement request instead."); target policy. Refuses if already host, nothing revoked, restricted account, pending re-application, dead agency.
- **Body `Reason`:** `reason` (3–1000).
- **Response:** `{uid, before, after{isHost:true,agencyId}, audit_id, closed_requests: [role-appeal ids]}`.
- **State:** revoked host → active host; open role appeal for host → `restored`.
- **Audit:** yes, `host.restored` (+ `role_appeal.restored`).
- **Description:** Restore a revoked Host from the existing approved application.

### 1.22 GET /api/users/{uid}/roles
- **Auth:** `current_user`.
- **Response:** `{uid, held_count, roles: [...], deduction_currencies: ["beans"|"diamonds"...], verified_contact: bool}`. Role item: partner roles `{role ("agency"|"sub_agency"|"seller"), label, id, name, status, is_active, parent_id, actions[]}`; host `{role:"host", label, status ("active"|"revoked"|"pending"), verified, agency_id, application_id, restorable?, pending_application_id?, actions[]}`. `actions` ⊂ `["revoke","restore"]`.
- **Audit:** no.
- **Description:** Roles held and allowed role actions.

### 1.23 POST /api/users/{uid}/seller-flag
- **Auth:** `require_write` + `can_approve_seller`; target policy. `is_seller: true` always refused (400). Clearing refused if the person holds an approved Coin Seller record.
- **Body `SellerFlag`:** `is_seller: bool` required; `reason: str` (3–1000).
- **Response:** `{uid, before{isSeller}, after{isSeller:false}, audit_id}`.
- **State:** `users.isSeller` true → false.
- **Audit:** yes, `user.seller_revoked`.
- **Description:** Remove the shop display seller flag.

### 1.24 GET /api/users/{uid}/warnings
- **Auth:** `current_user`.
- **Query:** `limit: int = 100` (le=500).
- **Response:** **bare array**, newest first. Item id `id`. Fields: `reason, issuedAt, issuedBy, issuedByName, issuedByRole, deduction?{currency,amount,balanceAtRequest,status}, report_id?, reported_reason?`.
- **Description:** Warnings on an account.

### 1.25 GET /api/users/{uid}/history
- **Auth:** `current_user` (no scoping).
- **Query:** `limit: int = 200` (le=500).
- **Response:** **bare array** of audit entries (subject `user`/uid), newest first — keys per §0.
- **Description:** Audit history of an account.

---

## 2. `/api/host-verification` (routers/verification.py) — 3 endpoints

All three: `require_write` + `can_approve_kyc` (owner, ops_admin). Partners and observer refused — deliberately (conflict of interest / biometric data).

### 2.1 GET /api/host-verification/pending
- **Query:** `limit: int = 50` (1–200).
- **Response:** **bare array**, oldest `capturedAt` first; only `status == "pending_manual"`. Item id `uid`. Fields: `hostName, agencyId, status, attemptCount, aiScore, aiThreshold, aiProvider, manualReason ("below_threshold"|"no_ai"|...), capturedAt, lastRejectedAt`.
- **Description:** Manual face-verification queue.

### 2.2 GET /api/host-verification/{uid}
- **Response:** `{uid, hostName, agencyId, applicationId, status, attemptCount, aiScore, aiThreshold, aiProvider, capturedAt, agencyPhotoSignedUrl, captureSignedUrl, agencyPhotoMissing, captureMissing, signingError, previousNote, lastRejectedAt}`. 404 if none.
- **Sensitive:** `agencyPhotoSignedUrl`, `captureSignedUrl` — biometric face images (15-min links).
- **Description:** One verification case.

### 2.3 POST /api/host-verification/{uid}/review
- **Body `Verdict`:** `verdict: str` pattern `^(verified|rejected)$`; `reason: str` (3–500).
- **Response:** `{uid, before{status,isVerifiedHost}, after{status,isVerifiedHost}, audit_id, beansHeldNotLost (bool), notified (bool)}`.
- **State:** `hostVerification.status` `pending_manual` → `verified`|`rejected`; `users.isVerifiedHost` set accordingly (unlocks withdrawals). 400 if not pending/changed; 409/503 if unconfirmed.
- **Audit:** yes, `host.verification_approved`/`_rejected`.
- **Description:** Approve or reject a host's identity.

---

## 3. `/api/partner-ops/role-appeals` (routers/role_appeals.py) — 5 endpoints

Status lifecycle: `pending` → `recommended` → `restored` | `kept_revoked` (decide may happen straight from `pending`). Kinds: `host, agency, sub_agency, seller`. Errors carry their own code (400/403/404/409).

View shapes (`services/role_appeals`):
- **public_view:** `id, uid, kind, record_id, status, statement, created_at, updated_at, decision{outcome,note,at}|null`.
- **staff_view:** public_view + `revoked_at, revoked_reason, filed_by{uid,role}, recommendation{by_uid,by_role,outcome,note,at}|null, decision{by_uid,outcome,note,at,via?}|null`.

### 3.1 POST /api/partner-ops/role-appeals
- **Auth:** `team_admin_or_partner_apply_service` (Cloud Function with `X-Service-Key`, or a team admin/owner on someone's behalf).
- **Body `NewRoleAppeal`:** `uid: str` (1–128); `kind: str` pattern `^(host|agency|sub_agency|seller)$`; `statement: str` (20–2000).
- **Response:** `{appeal: public_view, existing: bool}` (idempotent: existing open request returned).
- **Checks:** account not restricted; a revoked role of that kind must exist; re-appeal policy vs. previous kept_revoked statements.
- **State:** new → `pending`.
- **Audit:** yes, `role_appeal.submitted`.
- **Description:** File a reinstatement request.

### 3.2 GET /api/partner-ops/role-appeals/of/{uid}
- **Auth:** `team_admin_or_partner_apply_service`.
- **Response:** `{appeals: [public_view]}` newest first. Item id `id`.
- **Description:** A person's own requests.

### 3.3 GET /api/partner-ops/role-appeals
- **Auth:** `require_internal` + `require_permission(can_approve_kyc OR can_approve_seller)`; service filters kinds the caller may review (kyc → host/agency/sub_agency; seller → seller; owner → all), 403 if none.
- **Query:** `status: "open"|"all"` default `"open"` (open = pending+recommended).
- **Response:** `{appeals: [staff_view]}` oldest first. Item id `id`; display: `uid, kind, record_id, status, statement, created_at, revoked_at, revoked_reason, recommendation.outcome, decision.outcome`.
- **Description:** Reviewer queue.

### 3.4 POST /api/partner-ops/role-appeals/{appeal_id}/recommend
- **Auth:** `require_write` + (`can_approve_kyc` OR `can_approve_seller`); service: reviewer must match kind (403).
- **Body `AppealVerdict`:** `outcome: str` pattern `^(restore|keep_revoked)$`; `note: str` (10–2000).
- **Response:** `{appeal: staff_view, owner_notified: {audit: "role_appeal.recommended", email: {sent, outcomes[], note?}}}`.
- **State:** `pending|recommended` → `recommended` (can be re-recommended). 409 if decided.
- **Audit:** yes, `role_appeal.recommended`; Owners emailed.
- **Description:** Recommend restore/keep_revoked.

### 3.5 POST /api/partner-ops/role-appeals/{appeal_id}/decide
- **Auth:** `require_write`; **service: owner only** (403 "Only the Owner can decide a reinstatement."). No check that recommender ≠ decider (owner may both recommend and decide).
- **Body `AppealVerdict`:** `outcome` (`restore`|`keep_revoked`); `note` (10–2000).
- **Response:** `{appeal: staff_view, restored: {kind, record_id}|null, notified: bool}`.
- **State:** `pending|recommended` → `restored` (calls `restore_host` / `reactivate_partner` on the same record) or `kept_revoked`. 409 if decided/in progress.
- **Audit:** yes, `role_appeal.restored`/`role_appeal.kept_revoked`.
- **Description:** Owner decides a reinstatement.

---

## 4. `/api/partner-ops/transfers` (routers/transfer_requests.py) — 3 endpoints

Status: `pending` → `approved` | `rejected`. Kinds: `host`, `sub_agency`. Nothing moves balances.

**view:** `id, kind, subject_id, from_agency_id, to_agency_id, note, status, requested_by{uid,role}, requested_at, decision{by_uid,note,at}|null`.

### 4.1 POST /api/partner-ops/transfers  (201)
- **Auth:** `require_write` + `can_approve_kyc`.
- **Body `NewTransfer`:** `kind: str` pattern `^(host|sub_agency)$`; `subject_id: str` (1–128; host uid or sub-agency partner id); `to_agency_id: str` (1–128); `note: str` (10–2000).
- **Validation:** host must be active, unrestricted, have a current agency; target must be a live agency, not the same/own; sub-agency must be approved; one open transfer per subject (409).
- **Response:** `{request: view, owner_notified: {audit: "transfer.requested", email}}`.
- **Audit:** yes, `transfer.requested`.
- **Description:** File a transfer for the Owner.

### 4.2 POST /api/partner-ops/transfers/{request_id}/decide
- **Auth:** `require_write`; **service: owner only** (403 "Only the Owner can decide a transfer."). No requester≠decider check.
- **Body `TransferDecision`:** `approve: bool`; `note: str` (10–2000).
- **Response:** `{request: view, moved: {kind, subject_id, from, to, recorded_after_unconfirmed_move?} | null}`.
- **State:** `pending` → `approved` (re-validated then moved) | `rejected`. 409/503 on conflict/unknown.
- **Audit:** yes, `transfer.approved`/`transfer.rejected`.
- **Description:** Owner approves/rejects a transfer.

### 4.3 GET /api/partner-ops/transfers
- **Auth:** `require_internal` + `can_approve_kyc`.
- **Query:** `status: "open"|"all"` default `"open"`.
- **Response:** `{requests: [view]}` oldest first. Item id `id`.
- **Description:** Transfer queue.

---

## 5. `/api/audit` (routers/audit.py) — 2 endpoints

### 5.1 GET /api/audit
- **Auth:** `require_internal`. Scope by role: owner/observer = all; `*_admin` = entries whose `actor.team` is theirs; everyone else = own entries only.
- **Query:** `action: str|null`; `actor_uid: str|null` (honoured only for owner/observer); `subject_type: str|null`; `subject_id: str|null`; `since: datetime|null`; `until: datetime|null`; `limit: int = 100` (le=500); `skip: int = 0` (ge=0).
- **Response:** **bare array** of audit entries, newest first. Item id `id`; fields `at, actor{uid,name,role,team,is_system}, action, subject{type,id}, before, after, reason, card_id, meta`.
- **Sensitive:** `before`/`after` on `staff.employment_changed` contain salary figures.
- **Description:** Read the audit log.

### 5.2 GET /api/audit/history/{subject_type}/{subject_id}
- **Auth:** `require_internal`. Owner/observer: everything. Team admin: allowed, but for `subject_type == "staff"` only if they `manage()` that person, else `[]`. Others: `[]`.
- **Query:** `limit: int = 200` (le=500).
- **Response:** **bare array** of audit entries (same keys).
- **Description:** Full history of one record.

---

## 6. `/api/documents` (routers/documents.py) — 2 endpoints

Both `current_user` and **partner-reachable**. Per-record authorisation (`services/documents._may_see`):
- `agency`/`host`: observer or `can_view_agencies`; agency partner only its own agency id (host: staff only).
- `seller`: observer or `can_view_sellers`; seller partner only own seller id.
- `coin_purchase`: observer or `can_coin_operations`; seller partner if record `sellerUid` is one of its seller ids.

Document entry: `{slot, label, url, error}`. Slots: `doc1..docN` (labels "Aadhaar", "PAN", "Bank passbook", "Document N"), `id1..N` (seller ID docs, label from record), `photo` ("Reference photo"), `proof` ("Registration proof"/"Payment proof"), `qr` ("Payment QR").

### 6.1 GET /api/documents/batch
- **Query:** `ref: list[str]` repeated, each `"<kind>:<id>"` (max 100); `slot: list[str]` repeated, optional filter applied to all refs.
- **Response:** `{documents: {"<kind>:<id>": [ {slot,label,url,error} ]}, expires_in_seconds: 900}`. Unauthorised/missing refs silently omitted.
- **Sensitive:** KYC (Aadhaar/PAN/bank passbook), payment proofs, QR.
- **Description:** Signed doc URLs for many records.

### 6.2 GET /api/documents/{kind}/{record_id}
- **Path:** `kind` pattern `^(agency|seller|host|coin_purchase)$`; `record_id` 1–200.
- **Response:** `{kind, id, documents: [ {slot,label,url,error} ], expires_in_seconds: 900}`. 404 missing, 403 forbidden.
- **Sensitive:** as above.
- **Description:** Signed doc URLs for one record.

---

## 7. `/api/staff` (routers/staff.py) — 10 endpoints

Staff record (Mongo `staff`) keys: `uid, email, name, phone, role, team, field_charge, reports_to, is_active, created_at, created_by{uid,name}, updated_at, employment_id, salary_minor, salary_currency, joined_at`. Errors: all `StaffError` → 400.

`manages(actor, person)`: owner manages everyone except owners/observer; observer manages owners only; a department admin manages only **members** of their own department (not fellow admins).

### 7.1 GET /api/staff/me
- **Auth:** `current_user` (partners refused by allowlist).
- **Response:** caller's full staff record (incl. `salary_minor`, `salary_currency`, `employment_id`), or `{}` if none.
- **Sensitive:** salary, phone.
- **Description:** Own staff profile.

### 7.2 GET /api/staff/assignable-roles
- **Auth:** `current_user`.
- **Response:** `{roles: [str]}` — observer → `["owner"]`; owner → all 12 department roles; `*_admin` → member roles of own team; else `[]`.
- **Description:** Roles the caller may assign (invite form).

### 7.3 POST /api/staff  (201)
- **Auth:** `require_team_admin` + `can_manage_team`; service: `role` must be in `assignable_roles(caller)`; email must not exist; email must not hold a partner role.
- **Body `InviteBody`:** `email: EmailStr` required; `name: str` (2–120); `role: Role` enum required; `phone: str` optional default "" (max 30); `field_charge: str` optional default "" (max 120).
- **Response:** staff record + `crm_user_document, crm_role, notification (sentence), reused_existing_account, email_already_verified, storage_role_claim`.
- **State:** creates staff row `is_active: true` + Firestore `crmUsers` + storage claim; sends set-password email.
- **Audit:** yes, `staff.created` (+ `staff.mirror_failed` on half-write).
- **Description:** Invite a staff member.

### 7.4 POST /api/staff/owners  (201)
- **Auth:** `require_owner_provisioner` (observer only). Role hardcoded `owner`.
- **Body `ProvisionOwnerBody`:** `email: EmailStr`; `name: str` (2–120); `phone: str` default "" (max 30); `reason: str` (3–500).
- **Response:** same as 7.3.
- **Audit:** yes, `staff.created`.
- **Description:** Observer provisions an owner.

### 7.5 GET /api/staff
- **Auth:** `current_user`. Scope: owner/observer all; `*_admin` → member roles of own team; others → only self.
- **Query:** `include_inactive: bool = false`.
- **Response:** **bare array** of staff records, newest `created_at` first. Item id `uid`. Display: `name, email, phone, role, team, field_charge, is_active, created_at, reports_to, employment_id, joined_at`. `salary_minor`/`salary_currency` stripped for non-owner/observer callers (except own row).
- **Sensitive:** email, phone, salary (owners/observer).
- **Description:** Staff roster.

### 7.6 GET /api/staff/overview
- **Auth:** `current_user`; returns `[]` unless owner/observer.
- **Response:** **bare array** `[{team ("no team" if null), headcount, roles: [str]}]` (active staff only).
- **Description:** Headcount per department.

### 7.7 PATCH /api/staff/{uid}/role
- **Auth:** `require_write` + `can_manage_team`; **service: owner only**; not self; target not owner/observer; new role must be a department role.
- **Body `RoleChange`:** `role: Role` enum; `reason: str` (3–500).
- **Response:** updated staff record + `crm_user_document, crm_role, storage_role_claim`.
- **State:** `role`/`team` changed; all sessions of the target revoked.
- **Audit:** yes, `staff.role_changed`.
- **Description:** Change a staff member's role.

### 7.8 PATCH /api/staff/{uid}/employment
- **Auth:** `require_team_admin` + `can_manage_team`; service: non-owner may not set `salary_minor`/`salary_currency`; team admin only for people they `manage()`.
- **Body `EmploymentChange`:** all optional (null = leave alone): `employment_id: str` (max 40); `salary_minor: int` (ge=0, minor units); `salary_currency: str` (exactly 3); `joined_at: str` (max 40); `field_charge: str` (max 120); plus required `reason: str` (3–500). At least one field required ("Nothing to change.").
- **Response:** updated staff record.
- **Audit:** yes, `staff.employment_changed` (before/after include salary).
- **Sensitive:** salary.
- **Description:** Set employment details.

### 7.9 POST /api/staff/{uid}/deactivate
- **Auth:** `require_write` + `can_manage_team`; service: not self; not observer; owner only by observer (and never last active owner); else must `manage()` target.
- **Body `Reason`:** `reason: str` (3–500).
- **Response:** staff record with `is_active: false` + `crm_user_document, storage_role_claim, firebase_login ("disabled" or error text), fully_revoked (bool)`.
- **State:** `is_active` true → false; sessions revoked; Firebase login disabled; crmUsers deactivated.
- **Audit:** yes, `staff.deactivated` (+ `staff.firebase_revoke_failed`).
- **Description:** Revoke a staff member's access.

### 7.10 POST /api/staff/owners/{uid}/deactivate
- **Auth:** `require_owner_provisioner` (observer only); route verifies target role is `owner` ("That account is not an owner."); last active owner refused.
- **Body `Reason`:** `reason: str` (3–500).
- **Response:** same as 7.9.
- **Audit:** yes, `staff.deactivated`.
- **Description:** Observer removes an owner.

---

## 8. Sensitive response fields (summary)
| Endpoint | Sensitive fields |
|---|---|
| GET /api/host-verification/{uid} | `agencyPhotoSignedUrl`, `captureSignedUrl` (biometric faces) |
| GET /api/documents/batch, /api/documents/{kind}/{id} | `documents[].url` — Aadhaar, PAN, bank passbook, seller ID docs, payment proof, payment QR |
| GET /api/users/appeals/{id}/evidence | `evidence[].url` (private attachments) |
| GET /api/users/appeals | `evidence[].path`, `evidenceUrls`, `statement` |
| POST /api/users/host-applications/{id}/pending-changes/decide | `applied`/`refused` name payout/bank/identity fields (values not returned) |
| GET /api/staff/me, GET /api/staff, PATCH employment, staff writes | `email`, `phone`, `salary_minor`, `salary_currency`, `employment_id` |
| GET /api/audit, /api/audit/history/... , /api/users/{uid}/history | `before`/`after`/`meta` may contain salaries (staff), ban reasons, balances, device ids |
| GET /api/users/devices/bans | `deviceId`, `userUids` |
| Balance cards (1.11, 1.14) | `payload.balance_before_request`, `execution_result.balance_before/after` |
| POST /api/staff, /api/staff/owners | `notification` may mention set-password link status (link itself not returned) |
No endpoint here returns auth tokens.
