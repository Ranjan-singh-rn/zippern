# API inventory: cards, partners, reports, capital, expenses, broadcasts, notifications (GET)

Source: `backend/app/routers/{cards,partners,reports,capital,expenses,broadcasts,notifications}.py`, services in `backend/app/services/`, guards in `backend/app/core/deps.py`, session shape in `backend/app/core/security.py::verify_session`, roles in `backend/app/core/roles.py`.
All routers are mounted with `prefix="/api"` in `backend/app/main.py`. This is a read-only inventory: no repo source was changed.

**Endpoints documented in detail: 63** (cards 9, partners 10, reports 18, capital 3, expenses 5, broadcasts 3, notifications GET 15).

Conventions:
- Money is **integer minor units (paise)** unless a key says `_inr` (rupees, float). Floats are refused for amounts (`capital._minor`, `expenses._minor_amount`).
- Error shape is FastAPI's default: `{"detail": "<message>"}`. Service rule refusals (`CardError`, `ExpenseError`, `CapitalError`) come back as **400** with a message meant to be shown to the user. Guard refusals are **401/403**.
- `[S]` marks a sensitive field.

---

## 0. Auth model (deps.py)

### 0.1 Session user dict (what `current_user` returns)
Built by `core/security.py::verify_session` from an HS256 JWT plus a row in Mongo `sessions` (by `jti`, must not be `revoked`):

| key | type | notes |
|---|---|---|
| `uid` | str | JWT `sub` (Firebase uid) |
| `email` | str | |
| `name` | str | |
| `role` | `Role` enum | `observer`, `owner`, `app_admin`, `app_member`, `ops_admin`, `ops_member`, `finance_admin`, `finance_member`, `tech_admin`, `tech_member`, `support_admin`, `support_member`, `marketing_admin`, `marketing_member`, `agency`, `seller` |
| `team` | str or null | `app`, `ops`, `finance`, `tech`, `support`, `marketing`; always `None` for partners |
| `jti` | str | session id |
| `partner_ids` | dict[str,str] | capability -> partner record id, e.g. `{"agency": "...", "seller": "..."}`. **Forced to `{}` for any internal role**, even if the token carries some. Empty for a partner applicant still under review |
| `partner_id` | str | legacy: `partner_ids.agency` or else `partner_ids.seller` or `""` |
| `partner_status` | str | partner record status (`pending`, `approved`, `rejected`, `suspended`, `revoked`, `awaiting_verification`); `""` for staff |

A machine credential (sent as header `X-Service-Key`, accepted only by the `_person_or_service` dependencies) has role `"system"` (`R.SYSTEM_ROLE`). It is neither internal nor external.

### 0.2 Telling a partner session from an internal one
- `R.is_external(role)`: role is `agency` or `seller` (an explicit allowlist, so `"system"` is **not** external).
- `R.is_internal(role)`: role is one of the staff/governance roles (`INTERNAL_ROLES`).
- On the client: `role in {"agency","seller"}` is a partner; otherwise staff. Partners also have `team == None`, and `partner_ids`/`partner_status` are filled in.

### 0.3 Guards
| guard | admits |
|---|---|
| `current_user` | `Authorization: Bearer <token>` required (otherwise 401). Then `account_state.assert_may_act` (403 if the account is disabled or moved). Then **partner allowlist**: an external session is refused (403 `"Not available to partner accounts."`) unless `(METHOD, route template)` is in `PARTNER_REACHABLE` |
| `require_write` | `current_user`, and not external, and not `observer` (`"The observer account is read-only."`) |
| `require_write_or_partner` | external passes through; internal goes to `require_write` (not used by these routers) |
| `require_owner` | `role == owner` (`"Only a business owner can approve this."`) |
| `require_internal` | `R.is_internal(role)` (`"Not available to external accounts."`) |
| `require_team_admin` | any `*_admin` role or `owner` |
| `require_permission(*perms, any_of=False)` | Built on `require_write`. Also refuses `system` or an unknown role, checks `roles.PERMISSIONS`, then re-reads the Mongo `staff` row (must exist, `is_active`, and its role must equal the session role, otherwise `"Your role has changed. Sign in again."`). Goes in the decorator's `dependencies=[...]` and is **added on top of** the route's own guard |
| `own_partner_id_or_403(user, id, kind)` | internal: returns `id` unchanged. External: no ids of that `kind` gives 403 `"This account has no approved partner record..."`. `id` of `""` or `"me"` resolves to the single own id (400 if the login holds several). Anyone else's id gives 403 `"You can only view your own records."` |
| `team_admin_or_reporting_service` | `X-Service-Key` with op `REPORTS_SEND`, **or** `require_team_admin` |
| `team_admin_or_alerts_service` / `team_admin_or_email_sweep_service` | same pattern, ops `ALERTS_SCAN` / `EMAIL_SWEEP` |
| `internal_or_email_events_service` | op `EMAIL_EVENTS`, or `require_internal` |

Role helpers that matter here: `can_read_all` = owner or observer. `is_team_admin` = the six `*_admin` roles. `can_sign_money` = owner only. `can_verify_money(role, card_team)` = owner (any card), `finance_admin` (any card), or a team admin whose team equals the card's `team`.

### 0.4 `PARTNER_REACHABLE`: the deny-by-default partner allowlist (exact, 26 entries)
A partner session reaches **only** these. Any other route returns 403 from inside `current_user`, whatever guard the route declares. A request whose route cannot be identified is refused too.

```
GET  /api/auth/me
POST /api/auth/signout
GET  /api/partner-ops/me/verification
POST /api/partner-ops/me/verification/check
POST /api/partner-ops/me/verification/conflict
GET  /api/partners/agencies/{agency_id}/statement
GET  /api/partners/agencies/{agency_id}/hosts
GET  /api/partners/agencies/{agency_id}/sub-agencies
GET  /api/partners/agencies/{agency_id}/host-reports
GET  /api/partners/agencies/{agency_id}/appeals
GET  /api/partners/sellers/{seller_id}/statement
GET  /api/partner-ops/buyers/lookup
GET  /api/partners/sellers/{seller_id}/history
GET  /api/partners/sellers/{seller_id}/can-take-inventory
GET  /api/documents/{kind}/{record_id}
GET  /api/documents/batch
GET  /api/partner-ops/partners
GET  /api/partner-ops/partners/{partner_id}
GET  /api/partner-ops/sales
GET  /api/partner-ops/recharges
GET  /api/partner-ops/recharges/{recharge_id}
GET  /api/cards
GET  /api/partner-ops/subagency-payouts/open
POST /api/partner-ops/sellers/{seller_id}/coin-purchases
POST /api/partner-ops/sales
POST /api/partner-ops/agencies/{agency_id}/sub-agencies/reapply
```
That is 26 (method, path) pairs: 21 GET and 5 POST. `GET` and `POST /api/partner-ops/sales` count as two separate entries.

Within the scope of this document, partners can reach **8 partner routes plus `GET /api/cards`**. Nothing in reports, capital, expenses, broadcasts or notifications is reachable by a partner. `GET /api/partners/credit/*` and `GET /api/cards/inbox` are not on the list.

### 0.5 `request_rates`
**Correction to the brief: this is defined in `routers/reports.py`, not in `deps.py`.**
```python
async def request_rates() -> Rates:
    return await svc.load_rates()
```
It is a FastAPI dependency that reads the economy rates once per request (FastAPI caches a dependency's result for the life of one request) from Firestore `appConfig/economy`. If that document can't be read, the fallbacks (`FALLBACK_DIAMOND_PACK_PRICE_INR`, `FALLBACK_BEAN_TO_INR`) are used and marked `provisional: true`. Every money report takes it, and it shows up in the report's `rates` key as `Rates.as_dict()`:
`diamond_pack_price_inr_per_lakh`, `seller_wholesale_price_inr_per_lakh`, `seller_margin_inr_per_lakh`, `diamonds_per_lakh`, `bean_to_inr`, `source` (`"fallback"` or the read source), `provisional`, `missing` (list), `note`, `fetched_at`.

---

## 1. Card object (money board), `services/cards.py`

Mongo collection `cards`. Responses use `_public()`: `_id` becomes `id` (str).

**`type` (CardType)**: `balance_credit`, `balance_debit`, `seller_coin_purchase`, `lending_issue`, `lending_repay`, `lending_recover`, `lending_write_off`, `commission_payout`, `subagency_payout`, `host_withdrawal`, `salary_request`, `weekly_payout`, `rate_change`, `pricing_change`, `fx_override`, `promotion`, `refund`, `bad_debt_write_off`, `chance_config_change`, `operating_expense`, `owner_capital_in`, `owner_drawings`.

**`stage` (Stage)**: `requested` -> `under_review` -> `awaiting_signoff` -> `approved` -> `executed`. Also `rejected` and `failed`.
- An auto-verified card (bank or gateway proven) is created directly at `awaiting_signoff`.
- `reject` works from any stage except `executed` and `rejected`. From `awaiting_signoff` only an owner may reject. From `approved` it is blocked once `execution_claimed_at` is set.
- `mark_executed` moves `approved` to `executed`, or to `failed` if execution did not succeed.

**Fields**:

| key | notes |
|---|---|
| `id` | card id |
| `type`, `team`, `title`, `amount` (int, minor units for INR), `currency`, `reason` | |
| `subject` | `{type, id}`. For example `seller`/`agency` with a partner id, `owner` with an owner uid, `expense` with `"YYYY-MM:category"`, or a user uid for balance cards |
| `payload` | Type-specific. **[S]** may hold `payment_ref`/UTR, `duplicate_of` (other sellers' cards), `duplicate_reference`, and for capital `owner_uid`/`reference` |
| `evidence` | list of `{kind, ref, url}`. **[S]** URLs |
| `stage` | |
| `requested_by` | `{uid, name, role, team}` **[S]** staff identity |
| `created_at`, `updated_at` | |
| `verified_by`, `verified_at`, `verification_note` | **[S]** internal note |
| `auto_verified` | bool |
| `signed_by`, `signed_at`, `signature_note` | **[S]** internal note |
| `executed_at`, `execution_result` | |
| `execution_claimed_at`, `execution_claimed_by` | present once an execution has started |
| `rejected_by`, `rejected_at`, `rejection_reason` | |
| `warning` | response-only; set when a duplicate reference was found |

**`partner_view` (applied to every card a partner reads)**:
- `payload.duplicate_of` is filtered to the partner's own `subject_id`s, and `duplicate_reference` and `warning` are recomputed from what remains.
- `requested_by`, `verified_by`, `signed_by` and `rejected_by` that are not the caller become `{"uid":"","name":"Zipper","role":"internal","team":null}`.
- `verification_note` and `signature_note` are set to `null`.
- `reason` and `rejection_reason` are kept.

**Separation of duties (enforced in the service, returned as 400)**:
- **Review/verify** (`_assert_can_verify`): the raiser cannot verify (`"You raised this card. Someone else must verify it."`). The caller must pass `can_verify_money(role, card.team)`: owner, `finance_admin`, or the admin of the card's team.
- **Sign**: owner only. The signer cannot be the raiser (`"You raised this card. Another owner must sign it."`), cannot be the verifier (`"You verified this card. Someone else must sign it."`), and cannot be the card's `subject.id` (`"This card pays you. Another owner must sign it."`). The route also needs `can_approve_requests`.
- **Reject**: a reason is required. Owner only at `awaiting_signoff`. There is **no team or raiser check** at `requested`/`under_review`, so any `require_write` staff member can reject any team's early-stage card, including their own. Flagged.

**Audit (`core/audit.py`)**: `card.raised`, `card.verified`, `card.signed`, `card.rejected`, `card.executed`, `card.execution_failed`. Quirk: `start_review` is audited as **`card.verified`** with reason `"Review started"`.

---

## 2. Cards router, prefix `/cards`

### 2.1 `POST /api/cards`: raise a card
- **Auth:** `require_write` (staff, not the observer). Refuses `type` of `balance_credit`/`balance_debit` with 400 (those are raised from the user's page).
- **Body `RaiseCard`:**
  - `type`: CardType, required
  - `team`: Team, required
  - `title`: str, required, 3-200 characters
  - `amount`: int, required, must be non-zero (service rule)
  - `currency`: str, required
  - `reason`: str, required, 3-1000 characters
  - `subject_type`: str, required
  - `subject_id`: str, required
  - `payload`: dict, default `{}`
  - `evidence`: list[dict], default `[]`
- **Response:** 201 with a card object, `stage` = `requested`.
- **Audit:** `card.raised`.

### 2.2 `GET /api/cards`: the board, scoped to the caller (**partner-reachable**)
- **Auth:** `current_user`.
- **Query:** `stage` (Stage, optional), `limit` (int, default 100, max 500).
- **Scope (`board_for`):**
  - owner/observer: every card
  - team admin: `team == own team`
  - member: own cards or own team's cards
  - partner: cards they raised (`requested_by.uid == uid`), OR cards where `subject.id` is in their `partner_ids` AND `subject.type` is `seller`/`agency` AND `type` is in `PARTNER_SUBJECT_CARD_TYPES` (`seller_coin_purchase`, `lending_issue`, `lending_repay`, `lending_recover`, `lending_write_off`, `bad_debt_write_off`, `commission_payout`, `subagency_payout`). Partners get the `partner_view` form.
- **Response:** a **bare JSON array** of card objects, newest first. Display: `id`, `type`, `title`, `stage`, `amount`, `currency`, `team`, `subject.type`, `subject.id`, `reason`, `requested_by.name`, `created_at`, `verified_at`, `signed_at`, `executed_at`, `rejection_reason`, `warning`.

### 2.3 `GET /api/cards/inbox`: what is waiting on me
- **Auth:** `current_user`, but partners are refused because the route is not on the allowlist.
- **Response:**
  - `to_verify`: requested/under_review cards. Finance admin counts all teams; another team admin counts own team only.
  - `to_sign`: owner only; awaiting_signoff cards not raised by the caller.
  - `mine_pending`: own cards that are requested, under_review or awaiting_signoff.
  - `total` = `to_verify + to_sign`.

### 2.4 `GET /api/cards/awaiting-signature`: owner's signing queue
- **Auth:** `require_owner`.
- **Response:** a bare array of cards (`stage = awaiting_signoff`, `requested_by.uid != me`), oldest first, at most 200. It does **not** exclude cards the owner verified or cards whose subject is the owner, so `sign` can still refuse those with 400.

### 2.5 `POST /api/cards/{card_id}/review`: start review
- **Auth:** `require_write`, plus the verify rule (not the raiser; owner, finance_admin or the card team's admin).
- **Transition:** `requested` -> `under_review`. Any other stage gives 400.
- **Body:** none.
- **Response:** the card.
- **Audit:** `card.verified` ("Review started").

### 2.6 `POST /api/cards/{card_id}/verify`: verify and hand to owners
- **Auth:** `require_write`, plus the verify rule.
- **Body `Note`:** `note` (str, required, 3-1000 characters; what was checked).
- **Transition:** `requested` or `under_review` -> `awaiting_signoff`. Sets `verified_by`, `verified_at`, `verification_note`.
- **Response:** the card.
- **Audit:** `card.verified`.

### 2.7 `POST /api/cards/{card_id}/sign`: owner signature
- **Auth:** `require_owner`, plus `require_permission(can_approve_requests)` (which also implies `require_write` and a staff-row re-check).
- **Body `OptionalNote`:** `note` (str, default `""`, max 1000).
- **Rules:** the card must be `awaiting_signoff`; the signer must not be the raiser, the verifier or the subject.
- **Transition:** -> `approved`. Sets `signed_by`, `signed_at`, `signature_note`.
- **Response:** the card.
- **Audit:** `card.signed` (meta amount, currency).

### 2.8 `POST /api/cards/sign-bulk`: sign many
- **Auth:** same as sign.
- **Body:** a **raw JSON array of card id strings** (`list[str]`); only the first 100 are processed. There is no note.
- **Response:** `{"signed": int, "failed": [{"card_id", "error"}], "cards": [card...]}`. Each card is signed and audited individually.

### 2.9 `POST /api/cards/{card_id}/reject`
- **Auth:** `require_write`. In the service, only an owner may reject an `awaiting_signoff` card.
- **Body `Reason`:** `reason` (str, required, 3-1000 characters).
- **Rules:** cannot reject `executed`/`rejected` cards, or an `approved` card whose execution has started. The update is conditional on the stage (race safe).
- **Transition:** -> `rejected`. Sets `rejected_by`, `rejected_at`, `rejection_reason`.
- **Response:** the card.
- **Audit:** `card.rejected`.

---

## 3. Partners router, prefix `/partners`

Every agency route calls `own_partner_id_or_403(user, agency_id, kind="agency")`. Every seller route calls `own_partner_id_or_403(user, seller_id, kind="seller")`. Staff may pass any id; a partner may pass only their own id or `"me"`. `since`/`until` are `datetime` (ISO-8601).

### 3.1 `GET /api/partners/agencies/{agency_id}/statement` (partner-reachable)
- **Auth:** `current_user` + agency scope.
- **Query:** `since` (datetime, null), `until` (datetime, null), `limit` (int, default 200, max 500).
- **Response (`AgencyStatement`):**
  - `agency_id`, `name`
  - `commission_earned`, `commission_paid`, `commission_outstanding` (paise)
  - `host_count`, `period_from`, `period_to`
  - `entries`: ledger rows
  - `commission_basis` (dict or null), `commission_basis_error` (str or null), `commission_rule`
- **`entries[]` keys:** `id`, `holder_type`, `holder_id`, `currency`, `at`, `amount`, `balance_before`, `balance_after`, `action`, `reason`, `actor`, `card_id`, `meta`, `idempotency_key`.
- **[S] `actor` = `{uid, name, role}` of the staff member who posted the movement. It is returned to partners unredacted, which is inconsistent with `partner_view`.**

### 3.2 `GET /api/partners/agencies/{agency_id}/hosts` (partner-reachable)
- **Query:** `since` (datetime, null), `limit` (int, default 200, max 500).
- **Response:** a bare array of `{host_id, beans_earned, movements, last_earned_at}`, sorted by beans, descending.

### 3.3 `GET /api/partners/agencies/{agency_id}/host-reports` (partner-reachable)
- **Query:** `limit` (int, default 200, max 500).
- **Response:** a bare array of **raw Firestore `reports` documents**: `id` plus every stored field (for example `targetUid`, `reporterUid`, `status`, `actionTaken`, `createdAt`, `deductBeans`). Newest first.
- **[S] `reporterUid` (the person who filed the report) is returned to the agency.**
- AppealError gives 400.

### 3.4 `GET /api/partners/agencies/{agency_id}/appeals` (partner-reachable)
- **Query:** `limit` (int, default 100, max 500).
- **Response:** a bare array of **raw Firestore `appeals` documents**: `id` plus fields such as `kind` (`ban`/`report`), `status` (`pending`/`upheld`/`overturned`/`resolved`), `reportId`, `subjectUid`, `raisedByUid`, `raisedByRole`, `agencyId`, `createdAt`, `source`, `originalDecidedBy`, decision fields.
- **[S]** `originalDecidedBy` and decider uids may be present.
- A missing index gives the `index_unavailable` error.

### 3.5 `GET /api/partners/agencies/{agency_id}/sub-agencies` (partner-reachable)
- **Response:** a bare array of `{id, name, status, owed_by_parent}` (`owed_by_parent` is the commission balance, in paise).

### 3.6 `GET /api/partners/sellers/{seller_id}/statement` (partner-reachable)
- **Query:** `limit` (int, default 200, max 500).
- **Response (`SellerStatement`):**
  - `seller_id`, `name`
  - `coins_purchased`, `coins_lent`, `coins_sold`, `coins_on_hand`
  - `cash_paid_minor`
  - `credit_outstanding`, `credit_standing`, `credit_due_at`
  - `entries`: ledger rows, same keys as 3.1, including **[S] `actor`**
- `credit_standing` is one of `none`, `current`, `due_soon`, `overdue`, `written_off`.

### 3.7 `GET /api/partners/sellers/{seller_id}/history` (partner-reachable)
- **Query:** `since` (datetime, null), `until` (datetime, null), `limit` (int, default 500, max 1000).
- **Response (`SellerHistory`):** `seller_id`, `name`, `period_from`, `period_to`, `rows`, `totals`, `sources`, `truncated`, `note`.
- **`rows[]` keys:** `at`, `kind`, `what`, `coins`, `owed_delta`, `amount_minor`, `money`, `reference`, `proof_url`, `counterparty`, `card_id`, `card_stage`, `settled`, `reason`, `source`.
  - `kind` is one of `coin_purchase`, `lending_issue`, `repayment`, `recovery`, `write_off`, `sale`, `movement`.
  - `money` is the direction of the money; `"none"` when nothing moved.
  - `counterparty` is `"Zipper"` except on sales.
  - Extras depend on the row: `requested_coins`, `due_at`, `penalty_coins`, `title`, `sale_id`, `action`, `balance_after`, `ledger_id`.
  - **[S]** `reference` (UTR) and `proof_url`.
- **`totals` keys:** `coins_bought`, `rupees_paid_minor`, `coins_sold`, `rupees_taken_minor`, `coins_lent`, `coins_repaid`, `coins_recovered`, `coins_written_off`, `movements`, `settled_movements`, `pending_movements`, `pending_coins`, `pending_rupees_minor`, `refused_movements`.
- **`sources` keys:** `ledger_entries`, `cards`, `credit_events`, `sales`, `fetch_limit`, `ledger_capped`, `cards_capped`, `sales_capped`.

### 3.8 `GET /api/partners/sellers/{seller_id}/can-take-inventory` (partner-reachable)
- **Response:** `{"allowed": bool, "reason": str}`. Not allowed when the seller is not found, is not `approved`, or has overdue credit.

### 3.9 `GET /api/partners/credit/exposure` (staff only)
- **Auth:** `require_internal`, plus an in-function check: `can_read_all` or `finance_admin`/`finance_member`/`ops_admin`, otherwise 403.
- **Response:** `{total_outstanding, sellers_with_credit, total_sellers}`.

### 3.10 `GET /api/partners/credit/overdue` (staff only)
- **Auth:** `require_internal`. Any internal role, with no further role check.
- **Query:** `limit` (int, default 100, max 500).
- **Response:** a bare array of `{id, name, outstanding, due_at, days_overdue}`.

---

## 4. Reports router, prefix `/reports`

Every guard is `require_internal`, so no partner can reach any of these.

**Common query params:**
- `since`: datetime, optional, inclusive.
- `until`: datetime, optional, exclusive.
- If both are omitted the window is the last 30 days. If only `since` is given it runs to now. If only `until` is given it covers the 30 days before it. More than 400 days, or `since >= until`, is refused with `ReportError` (status from the exception).
- `format`: `json` (default) or `csv`, pattern `^(json|csv)$`. The query key is `format`.

**Envelope (`Report.as_dict`) for every JSON report:**
- `report` (name), `title`, `generated_at`
- `period`: `{since, until, days, bounds}`
- `currency_unit`, `rates` (see 0.5), `definitions`
- `columns`: `[{key, header}]`
- `rows`: list of dicts keyed by the column keys
- `totals`, `warnings` (list[str]), `empty` (bool)
- `sections` (dashboard only)

**CSV:** `text/csv` streaming attachment with headers `Content-Disposition`, `X-Report-Name`, `X-Report-Rows`, `X-Report-Rates`. It writes audit action `export` (subject_type `report`, subject_id = report name). If that audit write fails, the response is 503 and no file is produced.

**Scope helpers:**
- `_require_business_financials`: owner, observer, or any team admin. Members get 403.
- `_scoped_team`: owner/observer may pick any team or all teams. Others are pinned to their own team; asking for another team is 403; no team is 403.

| # | METHOD path | extra query | scope check | `report` name | `columns` (row keys) | `totals` keys |
|---|---|---|---|---|---|---|
| 4.1 | GET `/api/reports/cash-position` | since, until, format | business financials | `cash_position` | `line, channel, detail, movements, inr_minor, inr` | `receipts_inr_minor, payments_out_inr_minor, net_inr_minor, net_inr, receipts_by_channel, non_cash_credits_excluded` |
| 4.2 | GET `/api/reports/revenue` | + `group_by` (`day` default, `week`, `month`) | business financials | `revenue_{day|week|month}` | `period_label, period_start, channel, movements, revenue_inr_minor, revenue_inr, valuation` | `group_by, revenue_inr_minor, revenue_inr, by_channel, buckets, non_cash_credits_excluded` |
| 4.3 | GET `/api/reports/payouts` | since, until, format | business financials | `payouts` | `card_type, currency, amount_native, cards, inr_minor, inr, rate_applied` | `payouts_inr_minor, payouts_inr, cards_executed, by_card_type` |
| 4.4 | GET `/api/reports/margin` | since, until, format | business financials | `margin` | `metric, value, unit, value_inr, note` | `revenue_inr_minor, payouts_inr_minor, commission_accrued_inr_minor, commission_paid_inr_minor, net_margin_inr_minor, net_margin_inr, net_margin_pct, bean_payout_ratio, bean_payout_ratio_pct, diamonds_consumed, beans_created, beans_paid_out` |
| 4.5 | GET `/api/reports/chance-revenue` | since, until, format | business financials | `chance_gross_gaming_revenue` | `scope, day, mechanic, mechanic_id, kind, country, rounds, players, staked_diamonds, paid_out_diamonds, ggr_diamonds, ggr_inr_minor, ggr_inr, actual_rtp_percent, configured_rtp_percent, rtp_gap_pp, withheld_diamonds, capped_rounds, detail` | key ones: `ggr_inr_minor, ggr_inr, staked_diamonds, paid_out_diamonds, actual_rtp_percent, rounds, players, withheld_diamonds, ggr_by_mechanic_inr_minor, ggr_by_country_inr_minor, ggr_by_kind_inr_minor, host_or_agency_share_*`, among about 28 |
| 4.6 | GET `/api/reports/chance-margin` | since, until, format | business financials | `chance_margin` | `label, mechanic, kind, basis, diamonds_consumed, diamond_value_inr_minor, beans_created, bean_cash_cost_inr_minor, bean_creation_rate_pct, reference_bean_creation_pct, variance_from_reference_pp, bean_payout_ratio_pct, diamonds_per_bean, diamond_value_per_inr_of_bean_payout, store, detail` | `diamonds_consumed, diamond_value_inr_minor, beans_created, bean_cash_cost_inr_minor, bean_cash_cost_inr, bean_creation_rate_pct, bean_payout_ratio_pct_created_basis, bean_payout_ratio_realised, bean_payout_ratio_pct_realised, highest_margin_mechanic, highest_margin_ratio_pct, mechanics_creating_no_bean, reference`, ... |
| 4.7 | GET `/api/reports/cannibalisation` | since, until, format | business financials | `chance_cannibalisation` | `label, metric, value, unit, value_inr, previous, previous_inr, change_pct, spec, detail` | key ones: `host_earnings_inr_minor, host_earnings_change_pct, active_hosts, game_revenue_inr_minor, diamond_spend_share_games_pct, winnings_spent_on_hosts_pct, retained_non_spenders, verdict, verdict_text`, among about 35 |
| 4.8 | GET `/api/reports/channels` | since, until, format | business financials | `channels` | `channel, receipt_count, receipts_inr_minor, receipts_inr, share_of_receipts_pct, attributed_payouts_inr_minor, payout_cards, contribution_inr_minor` (rows also carry `contribution_inr`) | `receipts_inr_minor, unattributed_payouts_inr_minor, non_cash_credits_excluded` |
| 4.9 | GET `/api/reports/agencies/{agency_id}/statement` | since, until, format | business financials (staff only; this is **not** the partner route) | `agency_statement_{agency_id}` | `action, movements, amount_minor, amount_inr, last_at` | `agency_id, name, status, opening_outstanding_minor, commission_earned_minor, commission_paid_minor, commission_outstanding_minor, commission_earned_inr, commission_paid_inr, commission_outstanding_inr, movements, first_movement_at, last_movement_at` |
| 4.10 | GET `/api/reports/sellers/{seller_id}/statement` | since, until, format | business financials | `seller_statement_{seller_id}` | `action, movements, coins, cash_minor, cash_inr, last_at` | `seller_id, name, status, opening_coins, coins_in, coins_out, coins_purchased, coins_lent, coins_on_hand, coins_on_hand_inr_minor, coins_on_hand_valuation, cash_received_minor, cash_received_inr, credit_outstanding_minor, credit_due_at, movements` |
| 4.11 | GET `/api/reports/partners/summary` | + `kind` (`agency` default, or `seller`) | business financials | `partners_{kind}_summary` | `partner_id, name, status, movements, commission_earned_minor, commission_paid_minor, commission_outstanding_minor, commission_earned_inr, commission_paid_inr, commission_outstanding_inr, last_movement_at` | `kind, partners_with_movement, partners_on_file, credits_total, debits_total, closing_total`, plus more spread in |
| 4.12 | GET `/api/reports/liabilities` | format only (point in time) | business financials | `outstanding_liabilities` | `liability, description, counts_as_liability, holders, native_amount, native_currency, inr_minor, inr, rate_applied` (rows also carry `largest_single_holder`) | `total_owed_inr_minor, total_owed_inr, seller_credit_receivable_minor, net_position_inr_minor, sellers_overdue` |
| 4.13 | GET `/api/reports/team-throughput` | + `team` (Team, optional) | `_scoped_team`; members are allowed for their own team | `team_throughput_{team|all}` | `measure, kind, value, unit, detail` | `team, counts, median_hours, open_by_stage, open_total, oldest_open_item`. Medians are null when no data. `oldest_open_item` has `age_days, title, stage` |
| 4.14 | GET `/api/reports/audit-summary` | since, until, format | `R.audit_scope(role)`: `all` covers every team; `team` uses `user.team` (no team gives 403); otherwise 403 | `audit_summary` | `actor_name, actor_role, actor_team, action, count, cards_touched, last_at, actor_uid` **[S] staff identities** | `money_actions, distinct_actors, by_action, by_actor, scope` |
| 4.15 | GET `/api/reports/dashboard` | format only | every internal role. The content is role-shaped: money sections only for `can_read_all`/team admins/Finance; members get a warning instead | `dashboard` | `section, metric, value, unit, note` | `role, team, sees_whole_business`. **`sections`** = `{section: {metric: value}}`. Sections: `scope` (`role`, `team`); `cash` (`receipts_last_7_days_inr_minor`, `payments_out_last_7_days_inr_minor`, `net_last_7_days_inr_minor`, and the same three for `last_30_days`); `liabilities` (`total_owed_inr_minor`, `seller_credit_receivable_minor`, `sellers_overdue`); `queues` (`open_<stage>`, `open_total`, `by_team`); `overdue` (`awaiting_signature_over_3_days`, `unreviewed_over_7_days`, `signed_not_executed_over_3_days`, `execution_failed`, `oldest_open_item_days`); `last_7_days` (`cards_<measure>`). The `period` here is `{as_at, bounds}` |
| 4.16 | POST `/api/reports/jobs/weekly-business` | none | `team_admin_or_reporting_service` (team admin/owner, or `X-Service-Key` with op `REPORTS_SEND`) | n/a | n/a | see below |
| 4.17 | GET `/api/reports/weekly-business/{week}` | path `week`, e.g. `2026-W33` | business financials | n/a | n/a | see below |
| 4.18 | GET `/api/reports/definitions` | none | any internal role | n/a | n/a | see below |

**4.16 `POST /api/reports/jobs/weekly-business`:** builds, stores and emails the owner's weekly business report.
- **Body `WeeklyBusinessRequest`** (optional):
  - `week`: str or null, ISO week such as `2026-W33`; null means the last closed week
  - `force`: bool, default false; stores a new revision
  - `top_n`: int, default 10, range 1-100
- **Response:** 201 with the `scheduling.weekly` summary. Keys include `job`, `week_label`, `report_id`, `revision`, `stored`, `reused_stored_report`, `regenerated`, `failed_sections`, `needs_a_person`, `emails_accepted`, `errors`, `started_at`, `finished_at`.
- **Errors:** 400 for ValueError; ReportError uses its own status; 503 when the report was computed but could not be stored; 500 otherwise. Failures are written to the run log.

**4.17 `GET /api/reports/weekly-business/{week}`:** re-reads a stored week.
- **Response:** `{week, revisions: [doc...], current: revisions[0], note}`. Each doc has `id` (from `_id`), `week_label`, `revision`, `period`, `sections`, `generated_at`, `immutable`, and so on.
- **Errors:** 404 if nothing is stored for that week; 503 if the read fails.

**4.18 `GET /api/reports/definitions`:** what each figure means.
- **Response:** `{definitions, units: {money, commission, diamonds_per_lakh}, window: {default_days, max_days, bounds}, rate_fallbacks: {diamondPackPriceInr, "giftRates.beanToInrRate", note}, export: {format, logged}}`.

---

## 5. Capital router, prefix `/capital` (owner capital in, and drawings out)

The router has no verify or sign routes of its own: those happen at `/api/cards/{id}/verify` and `/api/cards/{id}/sign`. `sign` refuses the owner who is the card's `subject.id`, so **an owner cannot sign their own capital card**.

### 5.1 `POST /api/capital`: record a movement (raises a card; moves no money)
- **Auth:** `require_write`.
- **Body `Movement`:**
  - `direction`: str, required, pattern `^(in|out)$`
  - `owner_uid`: str, required, 1-200 characters
  - `owner_name`: str, default `""`, max 200
  - `amount_minor`: int, required, > 0, integer paise
  - `method`: str, default `"bank"`, max 40
  - `reference`: str, required, 1-200 characters (bank UTR) **[S]**
  - `reason`: str, required, 3-1000 characters
- **Response:** 201 with a card object:
  - `type` = `owner_capital_in` (direction `in`) or `owner_drawings` (direction `out`)
  - `team` = `finance`, `currency` = `INR`
  - `subject` = `{type:"owner", id: owner_uid}`
  - `payload` = `{direction, owner_uid, owner_name, amount_minor, method, reference, excluded_from_profit: true, basis: "cash"}`
  - `evidence` = `[{kind:"transfer", ref, url:""}]`
  - `stage` = `requested` (never auto-verified)
- **Audit:** `card.raised`.

### 5.2 `POST /api/capital/{card_id}/settle`: the transfer happened (stage 5)
- **Auth:** `require_owner`.
- **Body `SettleBody`:** `reason` (str, default `""`, max 1000). This field is **accepted but ignored** by the service.
- **Rules:** the card type must be capital, and its stage must be `approved`.
- **Transition:** -> `executed`, with `execution_result` = `{settled_at}`.
- **Response:** the card.
- **Audit:** `card.executed` twice: once against the card, and once with subject_type `owner_capital` and meta `{direction, amount_minor, reference, card_id}`.

### 5.3 `GET /api/capital`: the capital account
- **Auth:** `require_internal`.
- **Query:** `owner_uid` (str, optional).
- **Response:**
  - `owners[]`: `{owner_uid, owner_name, introduced_minor, drawn_minor, outstanding_minor, movements[]}`. Each movement is `{card_id, direction, amount_minor, reference, method, reason, executed_at}`. Only executed cards count. Sorted by `outstanding_minor`, descending.
  - `totals`: `{owners, introduced_minor, drawn_minor, outstanding_minor, note}`.
- **[S]** bank references.

---

## 6. Expenses router, prefix `/expenses` (operating expenditure)

Expense cards always have `type = operating_expense`, `team = finance`, `currency = "inr_minor"` (note: **not** `INR`), and `subject = {type:"expense", id:"YYYY-MM:<category>"}`. Verify and sign happen at `/api/cards/...`.

`ExpenseCategory`: `staff_salaries`, `infrastructure`, `marketing`, `gateway_fees`, `binance_fees`, `taxes`, `refunds_to_users`, `other`.

`period` is `YYYY-MM` (regex `^\d{4}-(0[1-9]|1[0-2])$`).

### 6.1 `POST /api/expenses`: raise an expense (stage 1)
- **Auth:** `require_write`.
- **Body `NewExpense`:**
  - `category`: ExpenseCategory, required
  - `amount_inr_minor`: int, required, > 0
  - `period`: str, required, exactly 7 characters (`YYYY-MM`)
  - `payee`: str, required, 1-200 characters
  - `invoice_ref`: str, required, 1-200 characters
  - `reason`: str, required, 3-1000 characters
  - `evidence_url`: str, default `""`, max 2000 **[S]**
  - `recurring`: bool, default false
  - `note`: str, default `""`, max 2000
- **Response:** 201 with a card object.
  - `payload` = `{category, period, payee, invoice_ref, recurring, note, basis:"cash", duplicate_reference, duplicate_of[]}`. Each `duplicate_of` entry is `{card_id, stage, amount_inr_minor, category, period, created_at}`.
  - `evidence` = `[{kind:"invoice", ref, url}]`.
  - `warning` is present if the invoice reference has been used before.
- **Audit:** `card.raised` and `expense.raised`.

### 6.2 `POST /api/expenses/{card_id}/repeat`: next period from a previous card
- **Auth:** `require_write`.
- **Body `RepeatExpense`:**
  - `period`: str, required, 7 characters
  - `amount_inr_minor`: int, required, > 0
  - `invoice_ref`: str, required, 1-200
  - `reason`: str, required, 3-1000
  - `payee`: str, default `""` (inherits the source card's payee)
  - `evidence_url`: str, default `""`, max 2000
  - `note`: str, default `""`, max 2000
- **Response:** 201 with a new `requested` card. `payload` also includes `repeats_card_id`, `repeats_period`, `previous_amount_inr_minor`, and `recurring` is true.

### 6.3 `POST /api/expenses/{card_id}/pay`: money left (stage 5)
- **Auth:** `require_owner`.
- **Body `PaidReason`:** `payment_ref` (str, required, 1-200) **[S]**.
- **Rules:** the card must be `approved`. Already `executed` gives 400 (no double payment).
- **Transition:** -> `executed`, with `execution_result` = `{payment_ref, paid_at, amount_inr_minor, category, period_label, payee, invoice_ref, counted_on}`.
- **Audit:** `expense.paid` and `card.executed`.

### 6.4 `GET /api/expenses`: the expense register
- **Auth:** `require_internal`.
- **Query:**
  - `period`: str, optional, `YYYY-MM`
  - `category`: ExpenseCategory, optional
  - `stage`: Stage, optional
  - `limit`: int, default 100, max 500
- **Response:** a bare array of expense cards, newest first. Display: `id`, `title`, `stage`, `amount`, `payload.category`, `payload.period`, `payload.payee`, `payload.invoice_ref`, `payload.recurring`, `payload.duplicate_reference`, `requested_by.name`, `created_at`, `signed_at`, `executed_at`, `execution_result.payment_ref`.

### 6.5 `GET /api/expenses/recurring-due`: recurring costs with no card yet this month
- **Auth:** `require_internal`.
- **Query:** `period` (str, **required**, `YYYY-MM`).
- **Response:** `{period, due[], already_raised[], note}`. Each entry is `{category, category_label, payee, last_period, last_card_id, last_amount_inr_minor, last_stage}`.

---

## 7. Broadcasts router, prefix `/broadcasts` (composed email)

Audiences: `all_agencies`, `all_sellers`, `all_users`, `person:<email>`.

Who may send (`broadcast.check_authority`, enforced in the service; a refusal is a **403** `NotAuthorised`, other problems are 400):
- The caller must be internal, must not be the observer, and must not be `system`.
- `person`: any `*_admin` role or `owner`.
- `all_agencies` and `all_sellers`: `marketing_admin` or `owner`.
- `all_users`: `owner` only.
- Every bulk audience also needs `can_send_broadcasts`.

The address in `person:<email>` must be found on a staff, agency/seller or app-user record.

### 7.1 `GET /api/broadcasts/audiences`: catalogue
- **Auth:** `require_write`.
- **Response:**
  - `audiences[]`: `{audience, label, needs_address, may_send, refusal, allowed_roles[], why}`
  - `sender_identities[]`: `{identity, from, from_name, reply_to, alignment}`
  - `limits`: `{max_recipients, confirm_above, max_subject_chars, max_body_chars, max_attachment_bytes, max_total_attachment_bytes}`
  - `unsubscribe`: `{stream, note}`

### 7.2 `GET /api/broadcasts/audience`: preview (sends nothing)
- **Auth:** `require_write`, plus `check_authority` for the audience.
- **Query:** `audience` (str, required), `sample` (int, default 25, range 1-100).
- **Response:**
  - `audience`, `param`, `label`, `source`
  - `count`: recipients after removing unsubscribed addresses
  - `resolved_count`
  - `sample[]`: `{email, name, role, uid}` **[S] customer emails and uids**
  - `sample_is_all`
  - `no_address`, `no_address_count`, `excluded`, `excluded_count`
  - `unsubscribed_count`, `unsubscribed[]` **[S]**
  - `confirm_required`, `confirm_above`, `max_recipients`
  - `may_send`, `note`

### 7.3 `POST /api/broadcasts/email`: send
- **Auth:** `require_write`, plus `check_authority`.
- **Body `BroadcastIn`:**
  - `audience`: str, required
  - `subject`: str, required (plain text)
  - `body`: str, required (plain text; HTML is escaped)
  - `reason`: str, required (audited)
  - `identity`: str or null; `transactional`, `bulk` or `support`. Anything larger than one person goes out as bulk.
  - `attachments`: list of `AttachmentIn` `{filename: str required, content_type: str default "application/octet-stream", data_base64: str required}`
  - `confirm_recipients`: int or null. Required when the count is above `BROADCAST_CONFIRM_ABOVE`, and must match the count.
- **Validation:** bad base64, a missing filename, or a decoded total over `email_max_total_attachment_bytes` gives 400. A template build failure gives 500.
- **Response (200 means the send ran, not that every message arrived):**
  - `broadcast_id`, `kind`, `spec`, `audit_id`, `subject`
  - `audience`, `audience_label`, `audience_source`
  - `sender_identity`, `sender_identity_note`, `sender`, `bulk`, `unsubscribe`
  - `recipients`, `attempted`, `accepted`, `failed`, `by_outcome`
  - `unsubscribed_skipped`, `no_address`, `excluded`
  - `attachments`, `attachments_omitted`, `attachments_note`
  - `not_attempted`, `stopped_early`, `stop_reason`
  - `warnings`, `delivery_log` (e.g. `/tech/email?kind=broadcast.<id>`), `note`
- **Audit:** `broadcast.email_sent`, which records the resolved audience address by address.

---

## 8. Notifications router, prefix `/notifications` (GET endpoints)

`_require_oversight(user)` admits `can_read_all` or a team admin. It refuses `system` and members with 403, because subject lines carry money figures.

Delivery outcomes (`email.Outcome`): `queued`, `sent`, `delivered`, `failed`, `bounced`, `dropped`, `deferred`, `spam_report`, `unsubscribed`, `no_address`, `not_configured`, `withheld_role`, `unsubscribed_local`, `suppressed_repeat`, `duplicate`.

### 8.1 `GET /api/notifications/deliveries`
- **Auth:** `require_internal` + oversight.
- **Query:**
  - `kind`: str, optional, e.g. `partner.rejected`
  - `outcome`: str, optional
  - `to`: str, optional, exact address
  - `since`: str, optional, ISO-8601 (400 if it doesn't parse)
  - `limit`: int, default 100, range 1-500
- **Response:** `{deliveries[], count, note}`.
- **`deliveries[]` keys (Mongo `email_deliveries`):** `id`, `kind`, `spec`, `to` **[S]**, `to_name`, `to_role`, `to_uid` **[S]**, `subject` **[S], carries figures**, `outcome`, `queued_at`, `sent_at`, `attempts`, `provider`, `provider_status`, `provider_message_id`, `provider_reason`, `provider_error_body`, `dedupe_key`, `sensitivity`, `authorised_by`, `bulk`, `attachments`, `headers_sent`, `error`.

### 8.2 `GET /api/notifications/deliveries/failures`
- **Auth:** `require_internal` + oversight.
- **Query:** `hours` (int, default 24, range 1-720), `limit` (int, default 100, range 1-500).
- **Response:** `{failures[] (same row keys as 8.1), count, window_hours, outcomes_counted_as_failure[]}`.

### 8.3 `GET /api/notifications/deliveries/summary`
- **Auth:** `require_internal` + oversight.
- **Query:** `hours` (int, default 24, range 1-720).
- **Response:** `{since, by_outcome: {outcome: n}, sent, failed, withheld, in_flight}`.

### 8.4 `GET /api/notifications/alerts`: detector catalogue
- **Auth:** `require_internal` + oversight.
- **Response:** `{detectors[], suppression}`. Each detector is `{id, spec, watches, audience[], severity, threshold, threshold_setting, repeat_hours, ...}`.

### 8.5 `GET /api/notifications/alerts/raised`
- **Auth:** `require_internal` + oversight.
- **Query:** `limit` (int, default 200, range 1-500).
- **Response:** `{raised[]}`. These are raw `alert_state` documents without `_id`, sorted by `last_sent_at`, descending. They include `key` and `last_sent_at`.

### 8.6 `GET /api/notifications/alerts/open`: current findings (sends nothing)
- **Auth:** `require_internal` + oversight.
- **Response:** `{findings[], open (count of status ok), did_not_run[], not_applicable[]}`.
- **`findings[]`:** `{id, spec, status, severity, key, headline, action, meta}` or `{id, spec, status, reason}`. `status` is one of `ok`, `failed`, `not_applicable`.

### 8.7 `GET /api/notifications/schedule`
- **Auth:** `require_internal` + oversight.
- **Response:** `{timezone, clock, statement_periods, jobs[], last_run}`. Each job has `job`, `spec`, `endpoint`, `function`, `cron`, `timezone`, `when`, `covers`, and so on.

### 8.8 `GET /api/notifications/runs/last`
- **Auth:** `require_internal` + oversight.
- **Response:** `{jobs[], healthy[], needs_attention[], timezone, note}`.
- **`jobs[]` keys:** `job`, `spec`, `endpoint`, `function`, `cron`, `timezone`, `when`, `covers`, `status`, `ok`, `last_run_at`, `finished_at`, `age_hours`, `trigger`, `triggered_by`, `emails_accepted`, `problems[]`, `recorded`, `stalled`, `detail`, `as_at`.
- `status` is one of `ok`, `degraded`, `failed`, `never`, `unknown`.

### 8.9 `GET /api/notifications/runs`
- **Auth:** `require_internal` + oversight.
- **Query:** `job` (str, optional, e.g. `reports.daily`), `limit` (int, default 50, range 1-200).
- **Response:** `{runs[]}`. These are raw `scheduled_runs` documents without `_id`: `job`, `spec`, `status`, `ok`, `started_at`, `finished_at`, `trigger`, `triggered_by`, `emails_accepted`, `errors`/`problems`, ...

### 8.10 `GET /api/notifications/subscriptions`
- **Auth:** `require_internal` + oversight.
- **Query:** `report` (str, **required**), `cadence` (str, **required**).
- **Response:** `{subscriptions[]}`. Each is `{report, cadence, email [S], name, muted, authorised_by, created_at, updated_at}`.
- **Note:** these are raw Mongo documents, and `_id` is **not** removed. Serialising an `ObjectId` may fail. Flagged.

### 8.11 `GET /api/notifications/unsubscribe`: one-click unsubscribe page
- **Auth:** **none (unauthenticated)**. Protected by an HMAC token.
- **Query:** `e` (address, required), `r` (report key, required), `c` (cadence, default `""`), `t` (signature, required).
- **Response:** `{unsubscribed: true, report, cadence, note}`. A bad token gives 400.
- Same behaviour as `POST /unsubscribe`.

### 8.12 `GET /api/notifications/audiences/{name:path}`
- **Auth:** `require_internal` + oversight.
- **Path:** `name`, e.g. `owners`, `observer`, `finance_admin`, `team_admin:finance`.
- **Response:** `{audience, ...resolution.summary(), addresses[] [S], problem}`. 400 for an unknown name.

### 8.13 `GET /api/notifications/email-templates`
- **Auth:** `require_internal`. There is **no** oversight check.
- **Response:** `{templates[]: {name, spec, goes_to}, preview, note}`.

### 8.14 `GET /api/notifications/email-templates/{name}/preview`
- **Auth:** `require_internal`.
- **Response:** `{template, subject, html, sent: false}`. Rendered with sample data. 404 for an unknown template.

### 8.15 `GET /api/notifications/reconciliation`
- **Auth:** `team_admin_or_reporting_service` (team admin/owner, or the service key).
- **Query:** `limit` (int, default 30, range 1-365).
- **Response:** a bare array of `{id, dayKey, since, until, firestore, ledger, firestoreInr, ledgerInr, gapInr, toleranceInr, agrees, ratePerDiamond, checkedAt}`, newest first. Note that these keys are **camelCase**.

**Job and webhook endpoints (not detailed):**
- `POST /jobs/daily`
- `POST /jobs/monthly?with_statements=true`
- `POST /jobs/partner-statements?period=last-month&since&until&cadence=monthly&kind=both`
- `POST /jobs/alerts?only`
- `POST /jobs/transactional-sweep?only`
- `POST /jobs/reconcile?day=YYYY-MM-DD`
- `POST /provider-events` (SendGrid webhook)

All of these take a team admin/owner session or an `X-Service-Key`.

**Non-GET, non-job endpoints (not detailed):**
- `DELETE /alerts/raised/{key:path}` (owner)
- `POST /subscriptions` (owner; body `SubscriptionIn {report, cadence, email, name="", muted=false}`)
- `POST /unsubscribe` (unauthenticated, HMAC)

---

## 9. Flags and gotchas
1. **Staff identity leaks to partners in ledger entries.** `entries[].actor {uid,name,role}` and `reason` on `/partners/agencies/{id}/statement` and `/partners/sellers/{id}/statement` are not redacted. `partner_view` hides staff identity on cards, but this path is not covered.
2. **The reporter's identity leaks to agencies.** `/partners/agencies/{id}/host-reports` returns raw Firestore report documents, including `reporterUid`. `/appeals` returns raw documents too.
3. **Card reject has no team or raiser check** before `awaiting_signoff`. Any staff member who can write can reject any team's card.
4. **`start_review` is audited as `card.verified`.** Throughput and audit counts may treat it as a verification.
5. **`/cards/awaiting-signature` can include cards the owner cannot sign** (cards they verified, or cards whose subject is them). `sign` returns 400 for those.
6. **`/cards/sign-bulk` takes a raw JSON array body**, not an object, and has no note.
7. **`POST /capital/{id}/settle` accepts `reason` but ignores it.**
8. **Expense cards use `currency = "inr_minor"`**, while capital cards use `"INR"`.
9. **`GET /notifications/subscriptions` returns raw documents that still contain `_id`.**
10. **`request_rates` lives in `routers/reports.py`, not `deps.py`.**
11. **List endpoints return bare arrays** with no envelope: `/cards`, `/cards/awaiting-signature`, `/expenses`, `/partners/agencies/{id}/hosts`, `/host-reports`, `/appeals`, `/sub-agencies`, `/partners/credit/overdue`, `/notifications/reconciliation`.
