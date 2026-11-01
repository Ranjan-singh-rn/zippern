# Next phase (Phase 1B) — role restoration, transfers and frozen money

**Status: PLAN ONLY. Nothing in this file is implemented.**

The confirmed business rules are CRM-FLOW.md 9.47–9.49. This file records what they mean for backend authorisation, and where the current code conflicts with them.

**Gate.** Do not start this phase, or the Team/Kanban and Money Board work, until Phase 1A authentication and user-management readiness has been reviewed and accepted. See the Phase 1A report.

---

## 1. Confirmed rules (2026-10-14)

1. **Restoration (9.47).** When an Agency is restored, Hosts and Sub-agencies that were transferred away stay with the new Agency. The Owner may separately authorise transferring them back.
2. **Frozen money (9.48).** Pending money affected by role revocation is frozen and placed in an Owner-review queue. Finance Admin may process it only with the Owner's authorisation.
3. **Transfer authority (9.49).** The Owner has final authority for Host and Sub-agency transfers. Authorised admins may review and recommend. A recommendation needs a mandatory note and triggers an Owner notification. An admin can never finalise a transfer.

## 2. Where the current code conflicts (verified 2026-10-14)

| Rule | Current code | Conflict |
|---|---|---|
| 9.49 | `POST /partner-ops/partners/{id}/revoke` (`partner_ops.revoke_partner`, with `transfer_to`) is guarded by `CAN_APPROVE_KYC` / `CAN_APPROVE_SELLER`, which `ops_admin` holds. `_transfer_dependents` moves Hosts and Sub-agencies in the same call. | **Yes.** An ops admin can finalise a transfer today, as a side effect of revocation. |
| 9.47 | `reactivate_partner` re-approves the record and does **not** move dependents back. | No conflict. Restoration already leaves the roster where it is. A move back needs the 9.49 flow. |
| 9.48 | Revocation keeps "the record, the money and the history". There is no freeze flag and no Owner-review queue. Payout and commission paths do not check for a revoked role's pending money. | **Gap.** Nothing freezes money or routes it to the Owner. |

## 3. Backend authorisation needed (design, not built)

**Transfers**

- Split revocation from transfer.
  - `revoke_partner` keeps revoking.
  - When dependents exist, it does **not** move them. Instead it creates one `transfer_request` per Host and per Sub-agency, in state `awaiting_owner`.
  - **Open question:** while those requests wait, are the dependents left attached to the revoked agency, or parked unassigned? This needs a decision before 1B is built.
- `POST /transfers/{id}/recommend`
  - Allowed for admins with the reviewing permission.
  - The `note` is required and non-empty; the server refuses an empty one.
  - The admin's recommendation is written to the audit log.
  - The Owner is notified (inbox plus `notices`).
- `POST /transfers/{id}/decide`
  - **Owner role only** (`require_owner`), never a permission another role can be granted.
  - This is the only code path that calls `_move_host` or `_transfer_dependents`.
- **Transfer back after restoration.** Same `decide` endpoint, with a new request referencing the restored agency. There is no automatic reversal.
- **Firestore rules.** Clients must not write `users.agencyId`, `agencyHosts`, or `agencies.parentAgencyId`. The first is already staff-protected; the other two need explicit checks.

**Frozen money**

- On revocation, the server finds the money items tied to the revoked role and marks each `frozen: true` with `frozenReason: role_revoked` and `frozenAt`. Each item gets an Owner-review card.
  - **Open question:** the exact list of money kinds (agency commission ledger, pending host payout weeks, seller coin settlements, …) must be confirmed before implementation.
- Every payout, commission-release and settlement path refuses a frozen item unless the item carries an `ownerAuthorization` written by the Owner-only endpoint `POST /money/frozen/{id}/authorize`.
- Finance Admin may process the item **after** that authorisation. Without it, the existing `CAN_PROCESS_PAYOUT` refuses the item.
- Unfreezing, releasing, reassigning or writing off a frozen item is audited with both actors (Owner authoriser and Finance processor).

**Tests required before 1B ships**

- An admin cannot finalise a transfer.
- A recommendation without a note is refused.
- The Owner is notified.
- Restoration leaves the roster unchanged.
- A move back requires the Owner.
- A frozen item cannot be paid by Finance without Owner authorisation, and can be paid with it.

## 4. Open decisions that block parts of 1B

See `OPEN-PRODUCT-DECISIONS.md` (D1–D4). D3, account merging, intersects with frozen money when the account being merged away holds money.
