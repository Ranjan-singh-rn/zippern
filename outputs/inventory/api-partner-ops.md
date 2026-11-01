# API inventory: `/api/partner-ops` (partner operations)

Source: `backend/app/routers/partner_ops.py` (router `prefix="/partner-ops"`, mounted with `prefix="/api"` in `backend/app/main.py`).
Services read: `services/partner_ops.py`, `services/cards.py`, `services/recharges.py`, `services/money_freeze.py`, `services/partner_applications.py`, `services/partner_activation.py`, `services/contact_verification.py`, `services/commission.py`, `services/users.py` (`lookup_buyers`, `registration_availability`), `core/deps.py`.

**Endpoint count: 61** (all 61 `@router.*` decorators are listed below, in source order).

---

## 0. Conventions that apply to every endpoint

### 0.1 Auth guards (from `core/deps.py`)

| Guard | Who passes |
|---|---|
| `current_user` | Any valid `Authorization: Bearer <session>`. Also checks the account is still allowed (403 if not). **An external (partner) session is refused with 403 "Not available to partner accounts." on every route that is not in `PARTNER_REACHABLE`**, whatever else the route declares. |
| `require_write` | Internal, non-observer. Refuses partners (403 "Not available to partner accounts.") and the observer (403 "The observer account is read-only."). |
| `require_write_or_partner` | Partner session passes as-is (the route then scopes it). Internal: same as `require_write`. |
| `require_owner` | Owner role only (403 "Only a business owner can approve this."). |
| `require_internal` | Any internal role (403 "Not available to external accounts."). |
| `require_team_admin` | Team admin or owner (403 "Requires a team admin."). |
| `require_permission(P...)` | Built on `require_write` (so it also refuses partners and the observer), then requires the capability (403 "Your account does not have the '...' permission ..."). Re-confirms the role against the `staff` record (403 "Your role has changed. Sign in again."). |
| `team_admin_or_<x>_service` / `internal_or_accrual_service` | Either `X-Service-Key: <key>` whose credential allowlist contains the operation (bad key: 401), or a person session passing the named person guard. |
| `deny_service_actor` | In-body: 403 "This action requires a person." for a service key. |
| `enforce_permission` | In-body capability check; a service actor passes automatically. |

Router-level permission shorthands:
- `_APPROVE_PARTNER` = `require_permission(can_approve_kyc OR can_approve_seller)` (any_of).
- `_COIN_OPS` = `require_permission(can_coin_operations)`.
- `_PROCESS_PAYOUT` = `require_permission(can_process_payout)`.

Because all three are built on `require_write`, **no partner session can reach any route that carries one of them.**

Service-key operations used here (`core/security.py`): `commission.accrue`, `commission.preview` (weekly accrual credential); `partner.register`, `partner.apply`, `recharge.request` (partner-registration credential, one key holds all three).

### 0.2 Partner-reachable routes in this router (`PARTNER_REACHABLE`)
Only these 12 of the 61 are callable with a partner (agency/seller) session:

| Method | Path | Scoping |
|---|---|---|
| GET | `/api/partner-ops/me/verification` | session uid only |
| POST | `/api/partner-ops/me/verification/check` | session uid only |
| POST | `/api/partner-ops/me/verification/conflict` | session uid only |
| GET | `/api/partner-ops/buyers/lookup` | must hold a seller id on the session |
| GET | `/api/partner-ops/partners` | returns only the session's own partner records |
| GET | `/api/partner-ops/partners/{partner_id}` | `own_partner_id_or_403(user, id)` (no kind; either own record) |
| GET | `/api/partner-ops/sales` | pinned to session's seller id; none gives `[]` |
| GET | `/api/partner-ops/recharges` | pinned to session's own partner ids |
| GET | `/api/partner-ops/recharges/{recharge_id}` | 404 unless `seller_id` is one of the session's ids |
| GET | `/api/partner-ops/subagency-payouts/open` | payouts where session's agency is parent or sub |
| POST | `/api/partner-ops/sellers/{seller_id}/coin-purchases` | `own_partner_id_or_403(user, seller_id, kind="seller")` |
| POST | `/api/partner-ops/sales` | `own_partner_id_or_403(user, body.seller_id, kind="seller")` |
| POST | `/api/partner-ops/agencies/{agency_id}/sub-agencies/reapply` | `own_partner_id_or_403(user, agency_id, kind="agency")` |

`own_partner_id_or_403` rules: internal callers pass any id. A partner session's allowed ids come from the session claim `partner_ids` (map kind -> id, written at sign-in). No ids: 403 "This account has no approved partner record, so there is nothing to show yet." `""` or `"me"` resolves to the single allowed id. If there are 2 allowed ids and no `kind`: 400 "This login holds more than one partner record. Name the one you want rather than 'me'.". An id outside the set: 403 "You can only view your own records.".

### 0.3 Error shape
`PartnerOpsError` gives `HTTPException(status, detail)`. The default is 400 with `detail` = a plain sentence. Exceptions to that:
- `PartnerOpsForbidden` (revoked restore by non-owner, revocation moving dependents by non-owner): **403**.
- `MoneyFrozenError` (card execution or sale approval for a frozen subject): **409**.
- `WithdrawalDebitNotConfirmed` / `RefundStepNotConfirmed`: **409** (aborted) or **503** (outcome unknown). Retry the SAME card or decision.
- Structured `detail` (an object, not a string) when the exception has `api_detail()`:
  - `ContactVerificationRequired` (approve, activate, restore-revoked): `{"message", "code": "CONTACT_VERIFICATION_REQUIRED", "requirement": "both", "missing": ["phone"|"email"...], "emailUnproved": bool}`.
  - `ContactRequired` (applications): `{"message", "code": "CONTACT_REQUIRED", "requirement": "one_of", "missing": [...], "emailUnverified": bool}`.
- Unattended accrual refusals: **409** with `detail = {"outcome", "message", ...common}` (see endpoint 33).

### 0.4 Units
`*_minor` = INR paise (divide by 100 once). Coins and diamonds are integers. Beans are integers. Datetimes are ISO-8601 UTC.

---

## 1. Shared response objects

### 1.1 `Partner` (Mongo `partners` doc via `_public()`: `_id` is renamed to `id`)
Every key the service writes (keys only appear once their lifecycle step has happened):

- Identity: `id` (= the Firestore agencies/sellers doc id), `kind` (`agency`|`sub_agency`|`seller`), `name`, `parent_id` (sub-agency only, else null), `parent_name` (sub-agency, set at creation), `crm_id` (optional; omitted when absent), `source` `{firestore_collection, firestore_id, declared_type}`.
- Status: `status` (`pending`|`approved`|`rejected`|`suspended`|`revoked`|`awaiting_verification`), `is_active` (bool).
- Ownership: `owner_crm_uid` (Firebase uid of the login), `login_email` **[SENSITIVE: contact]**, `second_role_of`, `linked_partner_id`, `second_role_requested_at`, `second_role_requested_by`, `second_role_reason`.
- Money counters: `cash_paid_minor`, `total_coins_sold`, `credit` `{outstanding, due_at, terms, total_lent, total_repaid, total_recovered, total_penalty, total_written_off, history[], last_issued_at?, last_repaid_at?, last_recovered_at?, written_off_at?}`. Each `credit.history[]` item is `{at, event: issued|repaid|recovered|written_off, coins, due_at?, penalty_coins?, shortfall?, card_id, by}`.
- Lifecycle: `created_at`, `updated_at`, `created_by`, `creation_reason`, `approved_at`, `approved_by`, `approval_reason`, `rejection_reason`, `rejected_at`, `rejected_by`, `rejection_history[] {at, reason, by}`, `activation` `{state, missing[], approved_at?, approved_by?, started_at?, held_at?, held_by?, held_reason?}`, `activated_at`, `activated_by`, `deactivated_at`, `deactivated_by`, `deactivation_reason`, `reactivated_at`, `reactivated_by`, `reactivation_reason`, `revoked_at`, `revoked_by`, `revocation_reason`, `revocation_history[] {at, reason, by}`, `dependents_transfer` `{to, to_name, complete, failed_sub_agencies[], failed_hosts[], at}`.
- `virtual_account`: **replaced by `VirtualAccountView`** (1.2) in list/get responses. Action responses that return `_public(updated)` carry the raw Mongo sub-doc instead, if one exists: `{number, ifsc, beneficiary_name, provider, collection_account, issued_at, issued_by, issue_reason, last_attempt_at?, last_failure?}`.
- Every `*_by` block is `{uid, name, role, team}`. **[SENSITIVE: staff identities. These are NOT redacted on `GET /partners*` for a partner session.]**
- Bank, UPI and KYC document URLs are **not** stored in Mongo. They live on the Firestore agencies/sellers doc.

Recommended display fields: `id`, `name`, `kind`, `status`, `is_active`, `parent_id`, `parent_name`, `created_at`, `approved_at`, `rejection_reason`, `revocation_reason`, `credit.outstanding`, `credit.due_at`, `total_coins_sold`, `cash_paid_minor`, `owner_crm_uid`.

### 1.2 `VirtualAccountView` (`virtual_account_view`)
`{issued: bool, number: str|null, ifsc, beneficiary_name, provider, collection_account, issued_at, bank_configured: bool, note? (issued) | reason? (not issued)}`. When it comes from `_ensure_virtual_account` it can also carry `already_held`, `replica_synced`. **[SENSITIVE: bank collection details]**

### 1.3 `Card` (Mongo `cards` via `cards._public`/raise_card: `id`)
`{id, type, team, title, amount, currency, reason, subject: {type, id}, payload: {...type-specific}, evidence: [{kind, url}], stage, requested_by, created_at, updated_at, verified_by, verified_at, verification_note, auto_verified, signed_by, signed_at, executed_at, execution_result, rejected_by, rejected_at, rejection_reason}`. Optional `warning` (str) or `warnings` (list) are added on raise. Optional `execution_claimed_at` and `execution_claimed_by` appear on host-withdrawal cards.
- `stage`: `requested` -> `under_review` -> `awaiting_signoff` -> `approved` -> `executed` | `failed`; also `rejected`. The routes here only **raise** (stage `requested`) and **execute** (needs stage `approved`). Verify and sign happen on `/api/cards/*` (not in this router).
- Separation of duties (in `cards.sign` and `cards._assert_can_verify`, outside this router): the raiser cannot verify, the raiser cannot sign, the verifier cannot sign, and the subject cannot sign.
- `type` values here: `seller_coin_purchase`, `lending_issue`, `lending_repay`, `lending_recover`, `bad_debt_write_off`, `commission_payout`, `host_withdrawal`, `subagency_payout`.
- Execute responses return the card after `mark_executed`, with `stage` = `executed`|`failed` and `execution_result` = the type-specific result listed per endpoint.
- Partner view (`cards.partner_view`, used only on POST coin-purchases for a partner session): `requested_by`, `verified_by`, `signed_by` and `rejected_by` become `{"uid":"","name":"Zipper","role":"internal","team":null}` unless they are the caller. `verification_note` and `signature_note` become null. `payload.duplicate_of` is narrowed to the caller's own cards, and `duplicate_reference` and `warning` are recomputed.
- Audit: `card.raised` on raise. `card.executed` or `card.execution_failed` on execute.
- Idempotency: execution is idempotent on the card. Ledger keys are `card:{card_id}:<leg>`. A second execute gives 400 "This card has already been executed.".

Display fields: `id`, `type`, `title`, `amount`, `currency`, `stage`, `reason`, `subject.id`, `payload.payment_ref`, `payload.duplicate_reference`, `created_at`, `requested_by.name`, `signed_at`, `executed_at`, `execution_result`, `rejection_reason`, `warning`.

### 1.4 `Sale` (Mongo `partner_sales`)
`{id, seller_id, buyer_uid, diamonds, amount_paid_minor, status: pending|approved|failed, reason, recorded_by, created_at, updated_at, approved_by, approved_at, approval_reason?, failure?}`.

### 1.5 `SubagencyPayout` (Mongo `subagency_payouts`)
`{id, card_id, parent_id, parent_name, sub_id, sub_name, amount_minor, status: pending|parent_paid|closed, reason, leg1: {description, status: pending|paid, paid_at, payment_ref, by}, leg2: {description, status: pending|confirmed, confirmed_at, reason, by}, created_at, updated_at, requested_by, closed_at?}`.

### 1.6 `Recharge` (Mongo `recharges`; `_id` is the Firestore `rechargeRequests` id; `_public` gives `id`)
`{id, buyer_uid, seller_id, seller_owner_uid, seller_name, diamonds, amount_minor, currency, payment_method, reference? (omitted when blank), client_request_id? (omitted when blank), proof_url, status, credited_diamonds, refunded_diamonds, unrecoverable_diamonds, created_at, updated_at, created_by, source: "app", history: [{at, status, by, reason?, outstanding?, available_before?, taken?, unrecoverable?}], claimed_at?, shortfall? {available, needed, at}, approved_at?, approved_by?, approval_reason?, reviewed_at?, reviewed_by?, rejection_reason?, refund_reason?, refund_cycle?, refund_requested_at?, refund_requested_by?, refund_rejection_reason?, refund_decided_at?, refund_decided_by?, refund_decision_reason?}`.
- `status`: `pending` | `approving` (transient claim) | `approved` | `rejected` | `refund_pending` | `refunding` (transient) | `refunded` | `reversed`.
- `payment_method` enum: `upi`, `bank`, `binance`, `cash`, `international`, `other`.
- **[SENSITIVE: `proof_url` (payment screenshot), `reference` (UTR), `buyer_uid`]**

Display fields: `id`, `status`, `buyer_uid`, `seller_name`, `seller_id`, `diamonds`, `amount_minor`, `currency`, `payment_method`, `reference`, `proof_url`, `created_at`, `credited_diamonds`, `refunded_diamonds`, `unrecoverable_diamonds`, `rejection_reason`, `shortfall`.

### 1.7 `Freeze` (Mongo `money_freezes`)
`{id (= "user:{uid}" | "partner:{id}"), subject: {type: user|partner, id}, owner_uid, kinds: [host_earnings|agency_money|seller_money|pending_transfers], status: frozen|withheld|released|adjusted, causes: [{action, label, reason, at, by}], snapshot: {cards: [{id, type, amount, currency, stage}], beans?, beansAvailable?, balance?, kind?}, frozen_at, decisions: [{at, by, decision, note, adjustment?}], updated_at, decided_at?, decided_by?}`. Blocking statuses are `frozen` and `withheld`.

---

## 2. Endpoints

### A. Onboarding and partner lifecycle

#### 1. `GET /api/partner-ops/partners`
- Auth: `current_user`. **Partner-reachable.** A partner session gets its own records only (`partner_ids_of(user)`, sorted). The filters are ignored for a partner. An applicant with no ids gets `[]`.
- Query: `kind` (`agency`|`sub_agency`|`seller`, optional), `status` (alias of `partner_status`; `pending`|`approved`|`rejected`|`suspended`|`revoked`|`awaiting_verification`, optional), `limit` (int, default 100, max 500).
- Body: none.
- Response: a JSON **array** of `Partner` (1.1), each with `virtual_account` = `VirtualAccountView`. Staff are sorted `created_at` desc. A partner's items come from `get_partner` and also carry `credit_standing`, plus `can_take_inventory` / `coins_on_hand` (seller) or `commission_outstanding` (agency), as in endpoint 4.
- Item id: `id`.
- Description: onboarding queue and partner directory.
- Sensitive: `login_email`, staff `*_by` blocks, VAN details.

#### 2. `POST /api/partner-ops/partners` (201)
- Auth: `team_admin_or_partner_registration_service` (**service key `partner.register`**, used by the Firestore triggers `registerAgencyPartner` / `registerSellerPartner`), or a team admin/owner. In-body: `enforce_permission(can_approve_kyc OR can_approve_seller)` (service passes).
- Body `NewPartner`: `partner_id` str required (1..200), the Firestore doc id. `kind` enum `agency|sub_agency|seller` optional; it is a check only and a mismatch is refused. `reason` str required (3..1000).
- Checks: the Firestore doc must exist. For a sub-agency the parent must be an approved, active MAIN agency not owned by the applicant. One-agency-family-per-human claim. A revoked role of the same kind is refused. A service actor with no owner and no source on the doc is refused. Client-created (`self_signup`) docs are held to application eligibility. Duplicate `crm_id` is refused.
- Response: `Partner` plus `created` (bool), `warnings` [str], `note` (str).
- Idempotent: an existing record is returned with `created:false`, unchanged.
- Status: creates `pending`, `is_active:false`, all balances zero.
- Audit: `partner.created`.
- Description: create the Mongo business record for an existing Firestore agency or seller.

#### 3. `POST /api/partner-ops/partners/{partner_id}/attach-login` (201)
- Auth: `_APPROVE_PARTNER` + `require_team_admin`. `deny_service_actor`.
- Body `AttachLogin`: `email` str required (3..320), `name` str default "" (max 200), `phone` str default "" (max 40), `reason` str required (3..1000).
- Refused if: the partner is missing or Firestore is unreadable; a login is already attached on either side; the address is a staff account; the address has a `crmUsers` doc naming another partner; the human already holds a record in the same role family.
- Response: `Partner` plus `owner_crm_uid`, `login_email`, `firebase_account_created` (bool), `crm_user_document_written` (bool), `crm_user_document_note`, `replica_synced` (bool), `set_password_link` (str, may be ""), `note`, and `warning` when the directory write failed.
- **[SENSITIVE: `set_password_link` is a credential-setting link; `login_email`]**
- Status unchanged (grants sign-in only). Audit: `partner.login_attached`.
- Description: create or attach a Firebase login to a partner record that has none.

#### 4. `GET /api/partner-ops/partners/{partner_id}`
- Auth: `current_user`. **Partner-reachable**, scoped by `own_partner_id_or_403(user, partner_id)` (no kind, so either own record).
- Response: `Partner` plus `virtual_account` (`VirtualAccountView`), `credit_standing` (`none`|`current`|`due_soon`|`overdue`|`written_off`). Seller: `can_take_inventory` `{allowed: bool, reason: str}` and `coins_on_hand` (int). Agency/sub-agency: `commission_outstanding` (int, minor).
- Description: one partner with live standing and balances.
- Sensitive: as endpoint 1.

#### 5. `POST /api/partner-ops/partners/{partner_id}/virtual-account` (201)
- Auth: `require_permission(can_approve_seller)` + `require_team_admin`. `deny_service_actor`.
- Body `Reason`: `reason` str required (3..1000).
- Checks: must be an approved **seller**. Refused if a VAN already exists (never reissued). Refused if the bank is not configured or there is no allocator. **Today it always refuses (no eCMS bank account).**
- Response: `VirtualAccountView` plus `replica_synced`.
- Audit: `partner.van_issued`, or `partner.van_not_issued` on a configured-but-failed attempt.
- Description: issue a permanent VAN for a seller approved before VANs existed.
- **[SENSITIVE: bank details]**

#### 6. `POST /api/partner-ops/partners/{partner_id}/approve`
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `Reason`: `reason` (3..1000).
- Logic: creates the Mongo record if missing (`partner_record_created`). Refused if already approved and active. `awaiting_verification` delegates to activate (endpoint 47 logic). `suspended`/`revoked` delegate to reactivate (endpoint 13 logic) and add `restored: true`. A first approval needs a login attached and an unrestricted owner, and re-checks the role table, the role-family lock and a live parent for a sub-agency. **Decision 15: if the login lacks a verified phone AND email, only an Owner may approve.** The result is then `awaiting_verification`; a non-owner gets a structured `ContactVerificationRequired` 400.
- Response (started): `Partner` plus `replica_synced`, `login_synced`, `referral_code?`, `partner_record_created`, `warnings[]`, `virtual_account` (`VirtualAccountView`), `second_role?` `{held_partner_id, owner_crm_uid, granted_kind, replica_synced}`, `notified` (bool).
- Response (owner, contacts missing): `Partner` plus `replica_synced`, `login_synced`, `awaiting_verification: true`, `missing[]`, `partner_record_created`, `warnings[]`, `notified`.
- Transitions: `pending` -> `approved` + active, or `pending` -> `awaiting_verification`. Compare-and-set on status. Partner sessions are revoked.
- Audit: `partner.approved`, `partner.approved_pending_verification`, `partner.second_role_approved`, `partner.van_*`.
- Description: approve an agency or seller application (no money moves).

#### 7. `POST /api/partner-ops/partners/{partner_id}/grant-capability` (201)
- Auth: `_APPROVE_PARTNER` + `require_team_admin`.
- Body `GrantCapability`: `kind` str required, pattern `^(agency|seller)$`. `name` str required (1..200). `phone` str default "" (max 40). `reason` str required (3..1000).
- Checks: the held partner must be approved and must not already be that kind. It must not already have a `linked_partner_id`. It must have a CRM login. The server creates the Firestore doc (`source: second_role`; KYC doc URLs carried over, bank details NOT carried over), then runs endpoint 8's logic.
- Response: same as endpoint 8.
- Status: the new record is `pending`. Audit: `partner.second_role_requested` and `partner.created`.
- Description: staff create a partner's second capability (agency<->seller) as a pending application.

#### 8. `POST /api/partner-ops/partners/{partner_id}/second-role` (201)
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `SecondRole`: `new_partner_id` str required (1..200; the Firestore doc id of the counterpart kind). `reason` str required (3..1000).
- Checks: the ids differ; the held partner is approved and has no existing link; the held doc has a `crmUid`; the new doc's owner (if any) is the same login; the new record is not an unrelated existing partner.
- Response: `Partner` (the new record) plus `created`, `warnings[]`, `owner_crm_uid`, `replica_synced`, `note`.
- Status: `pending`. Sets `second_role_of` on the new record and `linked_partner_id` on the held one. Audit: `partner.second_role_requested`.
- Description: file a second-capability application for the same login.

#### 9. `POST /api/partner-ops/partners/{partner_id}/reject`
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `Reason`: `reason` (3..1000), stored on the record.
- Checks: only `pending` can be rejected ("already rejected" or "Only a pending application can be rejected").
- Response: `Partner` plus `replica_synced`, `login_synced`, `sessions_revoked` (int), `second_role?` (when rejecting a second capability), `notified`.
- Transition: `pending` -> `rejected` (compare-and-set). Pushes `rejection_history`. Releases the role-family slot (Decision 16). Audit: `partner.rejected` (and `partner.second_role_rejected`).
- Description: reject an application with a reason the applicant sees.

#### 10. `POST /api/partner-ops/partners/{partner_id}/pending-changes/decide`
- Auth: `require_permission(can_approve_kyc)` + `require_write`.
- Body `PendingDecision`: `approve` bool required. `reason` str required (3..1000).
- Checks: reads the Firestore agencies/sellers doc `pendingChanges` (no Mongo record needed). **Separation of duties: refused if `pendingChanges.submittedBy.uid` == caller uid.** Only allow-listed fields are applied (payout: `accountHolderName`, `accountNumber`, `bankAccount`, `ifscCode`, `bankName`, `branch`, `upiId`, `binanceUid`, `paymentType`, `currency`; identity: `kycDocUrls`, `idDocUrls`, `dob`, `country`, `agencyName`, `displayName`, `hostName`, `ownerName`, `phone`, `applicantPhone`, `email`, `applicantEmail`, `ownerEmail`, `ownerPhone`, `address`). Others are listed in `refused`.
- Response (approve): `{partner_id, collection, applied: [field], refused: [field], before: {field: oldValue}, after: {field: newValue}, audit_id, note}`. **[SENSITIVE: `before`/`after` carry bank account numbers, IFSC, UPI, KYC doc URLs, contacts]**
- Response (reject): `{partner_id, collection, refused: [field], kyc_status, audit_id, note}`.
- Effect: Firestore `kycStatus` -> `approved` (if documents exist) or back to `previousKycStatus`. Audit: `partner.pending_changes_applied` or `partner.pending_changes_rejected`.
- Description: apply or refuse a partner's proposed bank/identity change (four-eyes).

#### 11. `POST /api/partner-ops/partners/{partner_id}/deactivate`
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `Reason`: `reason` (3..1000).
- Checks: only `approved` can be suspended.
- **Freeze:** `money_freeze.freeze_partner(cause="role_suspended")` runs first.
- Response: `Partner` plus `replica_synced`, `login_synced`, `sessions_revoked`, `notified`.
- Transition: `approved` -> `suspended`, `is_active:false`. Audit: `partner.deactivated` and `money.frozen`.
- Description: suspend a partner (temporary).

#### 12. `POST /api/partner-ops/partners/{partner_id}/reactivate`
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `Reason`: `reason` (3..1000).
- Checks: refused if already active, `rejected` or `pending`. `awaiting_verification` delegates to the activation check. **`revoked` -> Owner only (403 `PartnerOpsForbidden`)** and also needs both contacts verified (structured 400). The owner account must be unrestricted. Role rules and a live sub-agency parent are re-checked. **Restoring does NOT release a money freeze.**
- Response: `Partner` plus `replica_synced`, `login_synced`, `sessions_revoked`, `notified`, `closed_requests` (list; reinstatement requests closed when restoring a revoked role).
- Transition: `suspended`|`revoked` -> `approved` + active. Audit: `partner.reactivated`.
- Description: lift a suspension, or (Owner) restore a revoked role.

#### 13. `POST /api/partner-ops/partners/{partner_id}/revoke`
- Auth: `_APPROVE_PARTNER` + `require_write`.
- Body `Revoke`: `reason` str required (3..1000). `transfer_to` str|null optional (max 128), a live main agency to receive sub-agencies and hosts.
- Checks: refused for `rejected` or `pending`. Refused if this is the person's only held role (suspend instead). **If there are dependents (sub-agencies/hosts) and the caller is not the Owner: 403.** A `transfer_to` target is validated. On an already-revoked record with dependents left, the Owner resumes the transfer.
- **Freeze:** `freeze_partner(cause="role_revoked")` runs first.
- Response: `Partner` plus `replica_synced`, `login_synced`, `sessions_revoked`, `dependents_moved` `{sub_agencies[], hosts[], to, to_name, failed_sub_agencies[], failed_hosts[], skipped_sub_agencies[], skipped_hosts[], complete}`, `role_family_released: false`, `notified`, `note`. On resume: `Partner` plus `resumed: true`, `dependents_moved`, `note`.
- Transition: `approved`|`suspended`|`awaiting_verification` -> `revoked`. The role-family slot is KEPT. Audit: `partner.revoked` and `money.frozen`.
- Description: take the role away (record, money and history kept).

### B. Seller inventory and credit

#### 14. `POST /api/partner-ops/sellers/{seller_id}/coin-purchases` (201)
- Auth: `require_write_or_partner`. **Partner-reachable**: a partner is pinned with `own_partner_id_or_403(user, seller_id, kind="seller")`.
- Body `CoinPurchase`: `coins` int required (>0). `amount_paid_minor` int required (>=0). `payment_ref` str required (1..200; UTR). `evidence_url` str default "" (max 2000). `reason` str required (3..1000).
- Checks: the amount must match the wholesale price within ±100 paise, unless the reason explains it (>=12 chars and contains an amount word). The seller must be able to take inventory (approved and not overdue). A duplicate UTR does not block; it sets `payload.duplicate_reference` and adds `warning`.
- Response: `Card` (type `seller_coin_purchase`, stage `requested`, `currency: "coins"`, `team: "finance"`). `payload` = `{coins, amount_paid_minor, payment_ref, evidence_url, duplicate_reference, duplicate_of: [{card_id, type, stage, amount, subject_id, created_at}]}`, `evidence` = `[{kind:"payment_proof", url}]`, optional `warning`. A partner session gets the `partner_view` redaction.
- Audit: `card.raised`.
- Description: raise a coin purchase card (moves nothing).
- **[SENSITIVE: `evidence_url` (payment proof), `payment_ref`; staff `duplicate_of` is redacted for partners]**

#### 15. `GET /api/partner-ops/payment-references/{payment_ref}`
- Auth: `current_user` plus an in-function `is_internal` check (403 "Not available to external accounts."). Not partner-reachable.
- Response: array (max 20) of `{card_id, type, stage, amount, subject_id, created_at}`.
- Description: duplicate-UTR lookup across all cards.

#### 16. `POST /api/partner-ops/coin-purchases/{card_id}/execute`
- Auth: `_COIN_OPS` + `require_owner`. Body: none.
- Checks: the card is `seller_coin_purchase` with stage `approved`, and the subject is not frozen (409).
- Effect: credits seller coins (key `card:{id}:coins`) and `$inc cash_paid_minor`.
- Response: `Card` with `execution_result` = `{coins_credited, amount_paid_minor, ledger_id, balance_before, balance_after, replica_synced}`. A failure gives stage `failed` with `{error}`, plus a 400.
- Audit: `inventory.credit` (ledger) and `card.executed`. Idempotent on the card.
- Description: credit seller inventory after owner signature.

#### 17. `POST /api/partner-ops/sellers/{seller_id}/lending` (201)
- Auth: `_COIN_OPS` + `require_write`.
- Body `Lending`: `coins` int required (>0). `due_at` datetime required. `terms` str default "" (max 2000). `reason` str required (3..1000).
- Checks: the seller exists and can take inventory.
- Response: `Card` (type `lending_issue`, `payload {coins, due_at, terms}`).
- Description: raise a lending (credit) card.

#### 18. `POST /api/partner-ops/lending/{card_id}/execute`
- Auth: `_COIN_OPS` + `require_owner`. Body: none.
- Checks: stage `approved`; not frozen (409).
- Effect: credits coins (key `card:{id}:lend`), `credit.outstanding += coins`, sets `due_at`/`terms`, and pushes history `issued`.
- Response: `Card` with `execution_result` = `{coins_lent, due_at, outstanding_after, ledger_id, balance_before, balance_after, replica_synced}`.
- Audit: `lending.issue` and `card.executed`.
- Description: issue the loan and record the debt.

#### 19. `POST /api/partner-ops/sellers/{seller_id}/repayments` (201)
- Auth: `_COIN_OPS` + `require_write`.
- Body `Repayment`: `coins` int required (>0). `payment_ref` str default "" (max 200). `reason` str required (3..1000).
- Checks: outstanding must be > 0 and `coins` <= outstanding. A duplicate ref gives `warning`.
- Response: `Card` (type `lending_repay`, `payload {coins, payment_ref, outstanding_before, duplicate_reference, duplicate_of}`).
- Description: raise a credit repayment card.

#### 20. `POST /api/partner-ops/repayments/{card_id}/execute`
- Auth: `_COIN_OPS` + `require_owner`. Body: none. Repayments are not blocked by a freeze (`lending_repay` is not a blocked type).
- Effect: no coin movement. Reduces `credit.outstanding` by min(coins, outstanding). Clears `due_at` when it reaches 0.
- Response: `Card` with `execution_result` = `{coins_repaid, outstanding_before, outstanding_after, cleared}`.
- Audit: `lending.repay` and `card.executed`.
- Description: close debt by the repaid amount.

#### 21. `POST /api/partner-ops/sellers/{seller_id}/recoveries` (201)
- Auth: `_COIN_OPS` + `require_write`.
- Body `Recovery`: `coins` int required (>0). `penalty_coins` int default 0 (>=0). `reason` str required (3..1000).
- Checks: outstanding must be > 0.
- Response: `Card` (type `lending_recover`, `amount` = coins + penalty, `payload {coins, penalty_coins, target, outstanding_before, balance_at_request, expected_shortfall}`).
- Description: raise a recovery-from-stock card.

#### 22. `POST /api/partner-ops/recoveries/{card_id}/execute`
- Auth: `_COIN_OPS` + `require_owner`. Body: none.
- Effect: debits min(balance, target) coins (key `card:{id}:recover`). Outstanding becomes outstanding + penalty - recovered.
- Response: `Card` with `execution_result` = `{target, recovered, shortfall, penalty_coins, outstanding_before, outstanding_after, note, ledger_id, balance_before, balance_after, replica_synced?}`.
- Audit: `lending.recover` and `card.executed`.
- Description: recover what the balance holds; the shortfall stays receivable.

#### 23. `POST /api/partner-ops/partners/{partner_id}/write-off` (201)
- Auth: `_COIN_OPS` + `require_write`.
- Body `WriteOff`: `coins` int required (>0). `reason` str required (3..1000).
- Checks: outstanding must be > 0 and `coins` <= outstanding.
- Response: `Card` (type `bad_debt_write_off`, subject type `seller`, `payload {coins, outstanding_before, is_loss: true}`).
- Description: raise a bad-debt write-off card.

#### 24. `POST /api/partner-ops/write-offs/{card_id}/execute`
- Auth: `_COIN_OPS` + `require_owner`. Body: none.
- Effect: reduces outstanding by min(coins, outstanding) and pushes history `written_off`.
- Response: `Card` with `execution_result` = `{written_off, outstanding_before, outstanding_after, is_loss: true}`.
- Audit: `lending.write_off` and `card.executed`.
- Description: book the loss.

### C. Sales

#### 25. `POST /api/partner-ops/sales` (201)
- Auth: `require_write_or_partner`. **Partner-reachable**: `body.seller_id` is pinned with `own_partner_id_or_403(..., kind="seller")`.
- Body `Sale`: `seller_id` str required (1..200). `buyer_uid` str required (1..200). `diamonds` int required (>0). `amount_paid_minor` int default 0 (>=0). `reason` str required (3..1000).
- Checks: the buyer is not the seller id; the seller is approved.
- Response: `Sale` (1.4) with `status: "pending"`.
- Audit: `sale.recorded`. No idempotency key: each call files a new sale.
- Description: seller files a diamond sale (moves nothing).

#### 26. `GET /api/partner-ops/registration/availability`
- Auth: **NONE (public, no session)**. Note that this route is not in `PARTNER_REACHABLE`, but it does not use `current_user`, so no session check runs at all.
- Query: `email` str default "" (max 254). `phone` str default "" (max 32). `kind` str default "", pattern `^(|agency|seller)$`.
- Response: `{email: "agency"|"seller"|null, phone: "agency"|"seller"|null}`.
- Description: signup-form duplicate check (role kind only, no ids or names).

#### 27. `GET /api/partner-ops/buyers/lookup`
- Auth: `current_user`. **Partner-reachable.** Internal callers, or a session holding a seller id (403 "Only a coin seller can look up a buyer.").
- Query: `q` str required (3..128), an exact uid, email or phone.
- Response: array (max 5) of `{uid, name, email (masked), phone (masked)}`.
- Description: resolve a buyer for a sale.

#### 28. `GET /api/partner-ops/sales`
- Auth: `current_user`. **Partner-reachable.** A partner is pinned to its seller id; with none it gets `[]`.
- Query: `seller_id` str optional (ignored for partners). `status` (alias of `sale_status`) str optional (`pending`|`approved`|`failed`). `limit` int default 100, max 500.
- Response: array of `Sale`, sorted `created_at` desc. Item id `id`.
- Description: list sales.

#### 29. `POST /api/partner-ops/sales/{sale_id}/approve`
- Auth: `_COIN_OPS` + `require_owner`.
- Body `Reason`: `reason` (3..1000).
- Checks: the sale exists and is not already approved. The seller must not be frozen (409).
- Effect: debits seller coins (key `sale:{id}:coins`), then credits buyer diamonds (key `sale:{id}:diamonds`). If the credit fails, the sale becomes `failed` and the call returns 400. `$inc total_coins_sold`.
- Response: `Sale` plus `seller_coins_after`, `buyer_diamonds_after`, `total_coins_sold`, `replica_synced`.
- Transition: `pending` -> `approved` (or `failed`). Audit: `sale.approved`, `inventory.debit` and `balance.credit`.
- Description: owner approves a sale.

### D. Agency commission

#### 30. `POST /api/partner-ops/agencies/{agency_id}/commission-payouts` (201)
- Auth: `_PROCESS_PAYOUT` + `require_write`.
- Body `CommissionPayout`: `amount_minor` int required (>0). `reason` str required (3..1000).
- Checks: the agency is approved and `amount_minor` <= outstanding commission.
- Response: `Card` (type `commission_payout`, `currency: "commission"`, `payload {amount_minor, outstanding_before}`).
- Description: raise a commission payout card.

#### 31. `POST /api/partner-ops/commission-payouts/{card_id}/execute`
- Auth: `_PROCESS_PAYOUT` + `require_owner`.
- Body `PaidReason`: `payment_ref` str required (1..200; bank reference).
- Checks: stage `approved`; not frozen (409).
- Effect: debits commission (key `card:{id}:commission`) and sets `payload.payment_ref` / `payload.paid_at`.
- Response: `Card` with `execution_result` = `{amount_minor, payment_ref, ledger_id, balance_before, balance_after, replica_synced}`.
- Audit: `commission.pay` and `card.executed`.
- Description: pay agency commission.

#### 32. `GET /api/partner-ops/agencies/{agency_id}/commission-preview`
- Auth: `internal_or_accrual_service` (**service key `commission.preview`**, or any internal session).
- Query: `period` str required (1..64; e.g. ISO week `2026-W42` or `custom`). `since` datetime optional. `until` datetime optional.
- Response: `{agency_id, agency_name, agency_kind, period, since, until, currency_unit, billing: {agency_id, since, until, bounds, definition, basis, beans_cashed_out, billing_minor, billing_inr, bean_to_inr, bean_rate_note, bean_rate_provisional, hosts: [{host_id, beans_cashed_out, billing_minor, movements, last_at}], host_count, beans_earned_not_cashed_out, warnings[]}, slab_table, breakdown: {band, rate_percent, rate_basis_points?, slices?, bands_crossed?, untaxed_minor?, commission_minor?, effective_rate_percent?, explanation, matched?, ...}, commission_minor, commission_inr, hosts: [{host_id, beans_cashed_out, billing_minor, movements, last_at, share_minor, share_inr, share_note}], warnings[], provisional: bool}`.
- Description: read-only commission derivation for a period.

#### 33. `POST /api/partner-ops/agencies/{agency_id}/commission-accruals` (201)
- Auth: `team_admin_or_accrual_service` (**service key `commission.accrue`**, the Sunday job, or a team admin/owner). Person: in-body `enforce_permission(can_process_payout)`.
- Body `CommissionAccrual`: `period` str required (1..64). `reason` str default "" (max 1000). `host_id` str default "" (max 200; narrows to one host, person path only). `since` datetime|null. `until` datetime|null. `amount_minor` int|null (>0; a CHECK only, refused if it disagrees).
- Checks: the agency is approved, and the computed total must be > 0.
- Response (person): `{agency_id, agency_name, agency_kind, period, since, until, amount_minor, amount_inr, credited_minor, credited_inr, already_accrued: [{host_id, amount_minor}], host_id, scope, accrued: [{host_id, amount_minor, beans_cashed_out, ledger_id, balance_before, balance_after, replica_synced}], billing, breakdown, slab_table, hosts, warnings, provisional, computed_by}`.
- Service path: success returns the same plus `outcome: "accrued"` and `unattended: true`. A zero week gives `{agency_id, agency_name, period, amount_minor, amount_inr, billing_minor, provisional, unattended, outcome:"nothing_to_accrue", credited_minor:0, message, breakdown}`. An already-accrued week gives `outcome:"already_accrued"` (200/201). Refusals are **409** `detail {outcome: "refused_provisional_slabs"|"refused_sanity_bound", message, ...common}` and are audited as `commission.accrue_refused`.
- Idempotency: ledger key `commission:{agency}:{host}:{period}`. Every host already accrued gives 400 "already accrued" (person).
- Audit: `commission.accrue`.
- Description: credit earned commission for a period (server computes the amount).

### E. Host withdrawals

#### 34. `POST /api/partner-ops/hosts/{host_uid}/withdrawals` (201)
- Auth: `_PROCESS_PAYOUT` + `require_write`. `host_uid` = Firebase uid.
- Body `HostWithdrawal`: `beans` int required (>0). `reason` str required (3..1000). `request_collection` str default "" (max 40; `withdrawalRequests`|`salaryRequests`). `request_id` str default "" (max 200).
- Checks: beans <= live Firestore `beansAvailable`. If a request is named: it exists, is this host's, has status `pending`|`approved`, the beans match exactly, a salary request belongs to the host's agency, and no other live card exists for it.
- Response: `Card` (type `host_withdrawal`, subject type `user`, `payload {beans, host_id, host_name, agency_id, beans_available_at_request, is_verified_host, request_collection?, request_id?}`) plus optional `warnings[]`.
- Description: raise a host bean withdrawal card.

#### 35. `POST /api/partner-ops/host-withdrawals/{card_id}/execute`
- Auth: `_PROCESS_PAYOUT` + `require_owner`.
- Body `PaidReason`: `payment_ref` (1..200).
- Checks: stage `approved`; not frozen (409). Claims execution (the card can no longer be rejected).
- Effect: Firestore transactional debit keyed `card_{id}`, and marks the queued request `paid`. Then the ledger row (key `card:{id}:withdrawal`).
- Errors: 409/503 when the debit is not confirmed (retry the SAME card). 400 for already-settled, not-payable, or insufficient beans (card failed). A failed ledger write after the debit sets `needs_manual_correction`.
- Response: `Card` with `execution_result` = `{beans, payment_ref, host_id, agency_id, beans_available_before, beans_available_after, settled_request?, ledger_id, balance_before, balance_after, replica_synced}`.
- Audit: `withdrawal.pay` and `card.executed`.
- Description: pay the host and debit beans.

### F. Sub-agency payouts

#### 36. `GET /api/partner-ops/subagency-payouts/open`
- Auth: `current_user`. **Partner-reachable.** Staff get all. A partner needs an agency id on the session (otherwise 403) and is filtered to payouts where `parent_id` or `sub_id` is in its ids.
- Query: `limit` int default 100, max 500.
- Response: array of `SubagencyPayout` with status != `closed`, sorted `created_at` asc. Item id `id`.
- Description: payouts with leg 2 not yet confirmed.

#### 37. `POST /api/partner-ops/subagency-payouts` (201)
- Auth: `_PROCESS_PAYOUT` + `require_write`.
- Body `SubAgencyPayout`: `parent_id` str required (1..200). `sub_id` str required (1..200). `amount_minor` int required (>0). `reason` str required (3..1000).
- Checks: the sub is an approved `sub_agency`, the parent is approved, `sub.parent_id == parent_id`, and amount <= the sub's outstanding commission.
- Response: `{card: Card(type subagency_payout, payload {parent_id, sub_id, amount_minor, outstanding_before, legs}), payout: SubagencyPayout, payout_id}`.
- Description: raise a sub-agency payout (two legs).

#### 38. `POST /api/partner-ops/subagency-payouts/{card_id}/execute`
- Auth: `_PROCESS_PAYOUT` + `require_owner`. Path param is the **card id**.
- Body `PaidReason`: `payment_ref` (1..200).
- Checks: stage `approved`; not frozen (409; checks the sub and `parent_id`).
- Effect: debits the sub's commission (key `card:{id}:subagency`) and sets payout `parent_paid` with `leg1` paid.
- Response: `{payout: SubagencyPayout|null, note}`. Note: this does NOT return the card.
- Audit: `subagency.paid_parent`, `commission.pay` and `card.executed`.
- Description: leg 1, Zipper pays the main agency.

#### 39. `POST /api/partner-ops/subagency-payouts/{payout_id}/confirm-leg`
- Auth: `_PROCESS_PAYOUT` + `require_write` (staff only, despite the docstring "main agency confirms"). Path param is the **payout id**.
- Body `Reason`: `reason` (3..1000).
- Checks: status must be `parent_paid`.
- Response: `SubagencyPayout` (status `closed`, `leg2.status: "confirmed"`).
- Audit: `subagency.parent_paid_sub`.
- Description: leg 2 confirmed, payout closed.

### G. Applications from the app (service-only by design)

The service-key callers are the Cloud Function callables. Their person fallback is `require_team_admin`. **Partner sessions cannot reach these.**

#### 40. `GET /api/partner-ops/applications/eligibility/{uid}`
- Auth: **service-only `team_admin_or_partner_apply_service`** (key op `partner.apply`), or a team admin.
- Response: `{options: [kind], blocked: {kind: reason}, parent_for: {kind: parent_id}, held: {uid, internal, guest, partners: [{id, kind, status, name, parent_id, revoked_at, revoked_reason}], host: {agency_id, parent_kind, verified, status, revoked_at}|null, pending_host_application: {id, agency_id, parent_kind, status}|null, revoked: [...]}, revoked: [{kind, record_id, revoked_at, reason, appeal}], contact: {required, code, requirement, missing[], emailUnverified, message?}, activation: {requirement: "both", complete, missing[], emailUnproved}}`. The kinds are `host`, `agency`, `sub_agency`, `seller`.
- Description: what this user may apply for.

#### 41. `GET /api/partner-ops/applications/parents`
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Query: `for_kind` str default `sub_agency`, pattern `^(sub_agency|host)$`.
- Response: array of `{id, name, kind, parent_id, parent_name}`. Agencies come first, then by name.
- Description: approved, active agencies a sub-agency or host may join.

#### 42. `GET /api/partner-ops/applications/of/{uid}`
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Response: array of `{id, kind, status, name, parent_id, created_at, rejection_reason, revocation_reason}`. Partner records and host applications are mixed, sorted `created_at` desc.
- Description: every partner-role application of a user.

#### 43. `POST /api/partner-ops/applications` (201)
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Body `PartnerApplication`: `applicant_uid` str required (1..128). `kind` str required, pattern `^(agency|sub_agency|seller)$`. `form` dict default {}. `parent_id` str|null (max 128; required for `sub_agency`).
- `form` keys are free-form and validated server-side:
  - seller: `displayName` (required), `phone`, `email`, `city`, `description`, `idDocUrls[]` or `registrationProofUrl[]` (1 https URL required), and `payment` `{accountHolderName, accountNumber, ifscCode, bankName, branch, upiId, upiQrUrl, binanceUid, internationalMethod, internationalDetails, currency}` (at least one of upiId/upiQrUrl/binanceUid/accountNumber/internationalDetails).
  - agency/sub_agency: `agencyName` (required), `ownerName`, `ownerPhone`, `ownerEmail`, `address`, `paymentType` (`foreign` requires `binanceUid`; otherwise `accountNumber`+`ifscCode`+`bankName` are required), `country`, `binanceUid`, `accountHolderName`, `accountNumber`, `ifscCode`, `bankName`, `branch`, `upiId`, `currency`, and `kycDocUrls[]` (exactly 3 https URLs).
  - **[SENSITIVE input: bank/UPI/Binance and KYC docs]**
- Checks: account restriction, eligibility table (structured `CONTACT_REQUIRED` refusal), parent validation and pin, role-family lock.
- Response: `{id, kind, status: "pending", parent_id, created, warnings[], notified}`.
- Audit: `partner.applied` and `partner.created`.
- Description: apply as Agency, Sub-agency or Coin Seller.

#### 44. `GET /api/partner-ops/applications/verification/{uid}`
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Response: `{verification: {complete, missing[], phone: {verified, masked}, email: {verified, masked, unproved, method}, noAccount}, waiting: [{id, kind, name} | {id, kind:"host", agency_id}], requirement: "both"}`.
- Description: verification state and the roles waiting on it.

#### 45. `POST /api/partner-ops/applications/verification/check`
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Body `VerificationCheck`: `applicant_uid` str required (1..128).
- Response: endpoint 44's shape plus `started: [{id, kind, activated, refusal?, recorded?, pending_completion?, busy?, conflict?, detail?}]`.
- Actor: system `system:contact-verification`. Audit: `partner.activated` per started role.
- Description: re-read verification and start the waiting roles.

#### 46. `POST /api/partner-ops/applications/verification/conflict`
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Body `ContactConflict`: `applicant_uid` str required (1..128). `contact` str required, pattern `^(phone|email)$`. `value` str required (3..320).
- Response: always `{"received": true}`, whether or not there was a conflict.
- Audit: `contact.conflict_reported` (only on a real conflict) plus an owner email.
- Description: report that a contact belongs to another account.

### H. Partner self-service (Decision 15)

#### 47. `GET /api/partner-ops/me/verification`
- Auth: `current_user`. **Partner-reachable**, scoped to the session's own uid (`own_session_uid`).
- Response: same as endpoint 44.
- Description: own login's verification status and waiting roles.

#### 48. `POST /api/partner-ops/me/verification/check`
- Auth: `require_write_or_partner`. **Partner-reachable**, own uid. No body, no id.
- Response: same as endpoint 45.
- Description: re-check own verification and start approved roles.

#### 49. `POST /api/partner-ops/me/verification/conflict`
- Auth: `require_write_or_partner`. **Partner-reachable**, own uid.
- Body `MyContactConflict`: `contact` str required (`^(phone|email)$`). `value` str required (3..320).
- Response: `{"received": true}`.
- Description: report that one's own contact is held by another account.

### I. Decision 16: sub-agency reapply

#### 50. `POST /api/partner-ops/agencies/{agency_id}/sub-agencies/reapply` (201)
- Auth: `require_write_or_partner`. **Partner-reachable**: a partner is pinned with `own_partner_id_or_403(user, agency_id, kind="agency")`. **Internal callers additionally need team admin or owner** (403 "Filing a partner application for somebody needs a team admin or an Owner.").
- Body `SubAgencyReapply`: `email` str required (3..320). `form` dict default {} (the same agency `form` keys as endpoint 43; `agencyName` required, 3 `kycDocUrls` required, bank or Binance required). `reason` str default "" (max 2000).
- Checks: a Firebase login exists for the email; it is not staff; it has no live/revoked agency-family record; it has at least one rejected sub-agency record. Also the role table, a valid parent and the pin.
- Response: `{id, kind: "sub_agency", status: "pending", reapplication_of, owner_uid, parent_id, record_created, warnings[], notified}`.
- Audit: `partner.reapplied` and `partner.created`. Concurrency: the `_id` lock (the loser's doc is deleted).
- Description: file a fresh sub-agency application after a rejection.
- **[SENSITIVE input: bank and KYC docs]**

### J. Frozen money (Owner)

#### 51. `GET /api/partner-ops/frozen-money`
- Auth: `require_owner`.
- Query: `status` str optional (`frozen`|`withheld`|`released`|`adjusted`).
- Response: `{freezes: [Freeze]}`, sorted `frozen_at` desc, max 200. Item id `id` (e.g. `partner:abc`, `user:uid`).
- Description: the Owner's queue of frozen subjects.

#### 52. `POST /api/partner-ops/frozen-money/{freeze_key}/decide`
- Auth: `require_owner` (the service re-checks owner: 403 PermissionError).
- Body `FreezeDecision`: `decision` str required, pattern `^(release|withhold|adjust)$`. `note` str required (5..2000). `adjustment` dict|null, required for `adjust`: `{amount: int>0, direction: "increase"|"decrease", currency?: str}`.
- Errors: 404 for an unknown key. 400 if already decided, for a bad adjustment, or for a concurrent change.
- Response: the `Freeze` doc (raw, includes `_id` and `id`). Transitions: `frozen`|`withheld` -> `released`|`withheld`|`adjusted`. Releasing or adjusting a user lifts the Firestore `payoutHold`. The adjustment itself is NOT executed here.
- Audit: `money.freeze_decided`.
- Description: release, withhold or adjust frozen money.

#### 53. `POST /api/partner-ops/partners/{partner_id}/activate`
- Auth: `_APPROVE_PARTNER` + `require_write`. Body: none.
- Checks: already active returns `activated:false, already_active:true`. The status must be `awaiting_verification` (else 400). Both contacts must be verified (structured 400), the owner unrestricted, role rules OK and the parent live.
- Response: `Partner` plus endpoint 6's started-shape keys plus `activated: true`. Or `Partner` plus `activated: false, already_active: true`.
- Transition: `awaiting_verification` -> `approved`. Audit: `partner.activated`.
- Description: staff start an Owner-approved role once contacts are verified (never bypasses verification).

#### 54. `POST /api/partner-ops/applications/host` (201)
- Auth: **service-only `team_admin_or_partner_apply_service`**.
- Body `HostApplication`: `applicant_uid` str required (1..128). `form` dict default {}. `parent_id` str required (1..128).
- `form` keys: `hostName` (required, or taken from the user's name), `age`, `dob`, `country`, `callRate`, `paymentType`, `binanceUid`, `accountHolderName`, `accountNumber`, `ifscCode`, `bankName`, `branch`, `upiId`, `currency`, `kycDocUrls[]` (3 https URLs required), `photoUrl[]` (1 https URL required). **[SENSITIVE input]**
- Checks: account restriction, eligibility, a live parent (main or sub; a sub needs a live main), not own agency, parent pin. A per-person lock means only one pending application at a time.
- Response: `{id, kind: "host", status: "pending", agency_id, agency_kind, notified}`.
- Audit: `partner.applied` (subject `host_application`).
- Description: apply as Host under an agency.

### K. Manual recharge via a Coin Seller

#### 55. `POST /api/partner-ops/recharges` (201)
- Auth: **service-only `team_admin_or_recharge_request_service`** (key op `recharge.request`, the app callable), or a team admin.
- Body `RechargeRequest`: `buyer_uid` str required (1..128). `seller_id` str required (1..128). `diamonds` int required (>0, <=1,000,000). `amount_minor` int required (>0, <=1,000,000,000). `currency` str default "INR" (max 8). `payment_method` str required (2..24; the service accepts `upi|bank|binance|cash|international|other`). `reference` str default "" (max 128). `proof_url` str default "" (max 2048; must start with `https://` if there is no reference). `client_request_id` str default "" (max 64; must match `[A-Za-z0-9_-]{8,64}`).
- Checks: the seller is an approved, active seller; the buyer is not the seller's own login; `(seller_id, reference)` is unique.
- **Idempotency:** `client_request_id` is unique per buyer. A repeat with identical `seller_id, diamonds, amount_minor, currency, payment_method, proof_url, reference` returns the stored request with `replayed: true`. Different details give 400.
- Response: `Recharge` plus `replica_synced`, `notified: {buyer: bool, seller: bool}`, and `replayed?`.
- Status: `pending`. Audit: `recharge.requested`.
- Description: a buyer files that they paid a seller (nothing moves).

#### 56. `GET /api/partner-ops/recharges`
- Auth: `current_user`. **Partner-reachable.** A partner is scoped to its own partner ids: a `seller_id` outside them gives `[]`; the default is its first id; `buyer_uid` is ignored.
- Query: `status` (alias of `recharge_status`) str optional. `seller_id` str optional. `buyer_uid` str optional. `limit` int default 200 (1..500).
- Response: array of `Recharge`, sorted `created_at` desc. Item id `id`.
- Description: the recharge queue.
- Sensitive: `proof_url`, `reference`, `buyer_uid`.

#### 57. `GET /api/partner-ops/recharges/{recharge_id}`
- Auth: `current_user`. **Partner-reachable.** A partner gets 404 unless `seller_id` is one of its ids.
- Response: `Recharge`.
- Description: one recharge request.

#### 58. `POST /api/partner-ops/recharges/{recharge_id}/approve`
- Auth: `_COIN_OPS` + `require_owner`.
- Body `Reason`: `reason` (3..1000).
- Checks: status `pending` (or a stale `approving`). The seller must not be frozen (returned as **400** here, not 409). Compare-and-set claim `approving`.
- Effect: debits seller coins (key `recharge:{id}:coins`), then credits buyer diamonds (key `recharge:{id}:diamonds`). Insufficient coins put it back to `pending` with `shortfall` and return 400.
- Response: `Recharge` plus `replica_synced`, `notified`.
- Transition: `pending` -> `approved`. Audit: `recharge.approved`.
- Description: payment verified; seller coins become buyer diamonds, once.

#### 59. `POST /api/partner-ops/recharges/{recharge_id}/reject`
- Auth: `_COIN_OPS` + `require_write`.
- Body `Reason`: `reason` (3..1000).
- Response: `Recharge` plus `replica_synced`, `notified`.
- Transition: `pending` -> `rejected` (compare-and-set). Audit: `recharge.rejected`.
- Description: refuse a recharge request.

#### 60. `POST /api/partner-ops/recharges/{recharge_id}/refund`
- Auth: `_COIN_OPS` + `require_write`.
- Body `Reason`: `reason` (3..1000).
- Response: `Recharge` plus `replica_synced`, `notified`.
- Transition: `approved` -> `refund_pending`, and `refund_cycle += 1` (the idempotency basis). Audit: `recharge.refund_requested`.
- Description: open a refund review.

#### 61. `POST /api/partner-ops/recharges/{recharge_id}/refund/decide`
- Auth: `_COIN_OPS` + `require_owner`.
- Body `RefundDecision`: `reason` str required (3..1000). `approve` bool required.
- Refuse: `refund_pending` -> `approved`. Response: `Recharge` plus `replica_synced`, `notified`. Audit: `recharge.refund_rejected`.
- Approve: claim `refunding` (resumable). Firestore clawback of min(outstanding, live balance) (history id `recharge_{id}_reversal_{cycle}`). Ledger keys `recharge:{id}:refund:{cycle}:diamonds` / `:coins`. Status becomes `refunded` (all recovered) or `reversed` (partial).
- Response: `Recharge` plus `taken`, `unrecoverable`, `available_before`, `replica_synced`, `notified`. 409/503 when a step is not confirmed (approve again).
- Audit: `recharge.refunded`.
- Description: decide a refund (takes back only what remains).

---

## 3. Separation-of-duties and safety summary
- Raise (team, `require_write` + capability) and execute (`require_owner` + the same capability) are always split. Verify and sign happen on `/api/cards`, where the raiser cannot verify or sign, the verifier cannot sign, and the subject cannot sign.
- `pending-changes/decide`: the proposer cannot decide.
- Approving without both verified contacts is Owner-only. Restoring a revoked role is Owner-only. A revocation that moves dependents is Owner-only. Frozen-money decisions are Owner-only.
- Freeze checks (409, or 400 on recharge approve) apply on execution of `seller_coin_purchase`, `lending_issue`, `commission_payout`, `subagency_payout` and `host_withdrawal` cards, on sale approval and on recharge approval. Repayment, recovery and write-off are not blocked.
- Suspension and revocation create the freeze. Reactivation does not release it.

## 4. Sensitive-field index
- Contacts: `Partner.login_email`; attach-login `login_email`; `buyers/lookup` (masked); verification `masked` values; the Recharge `buyer_uid`.
- Credentials: attach-login `set_password_link`.
- Bank/UPI/VAN: `VirtualAccountView` (number, ifsc, beneficiary_name, collection_account); `pending-changes/decide` `before`/`after`; application `form` inputs (endpoints 43, 50, 54).
- KYC docs: `pending-changes/decide` `before`/`after` (`kycDocUrls`, `idDocUrls`); application form inputs.
- Payment proof: Card `payload.evidence_url` / `evidence[].url` / `payload.payment_ref`; Recharge `proof_url` / `reference`.
- Staff identities: every `*_by` block on Partner and Recharge. These are **not redacted** on partner-reachable `GET /partners`, `GET /partners/{id}` or `GET /recharges*`. Cards are redacted for partners via `partner_view`.
- Cross-partner data: `payment-references/{ref}` (internal only); `payload.duplicate_of` (redacted for partners).
