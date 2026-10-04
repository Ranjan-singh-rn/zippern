I have the full picture. Here is the report.

---

# PART A — STATE MACHINES

## 1. USER ACCOUNT — `users/{uid}`

**Two parallel fields, one canonical.** `accountState` says *why*; `isBanned` is the single gate the Android app, `firestore.rules` and the Cloud Functions all read (`backend/app/services/users.py:99-131`).

`accountState` values are declared **twice**, once per language:
- `functions/src/accounts.ts:111-115` — `active`, `suspended`, `banned`, `recovery_pending`, `permanently_deactivated`
- `backend/app/services/users.py:128-131` (`class AccountState`) — `suspended`, `banned`, plus `ACTIVE` (used at `:655`, `:926`)

The TypeScript file declares all five; the Python enum declares only the three moderation values it writes. Nothing reconciles the two declarations — they are kept in step by convention.

| from | to | written by | evidence |
|---|---|---|---|
| `active` | `suspended` | moderator (`suspend_user`) | `users.py:803-812` — also sets `isBanned: True`, `isSuspended`, `suspendedUntil`, `suspendedBy*` |
| `suspended` | `active` | moderator (`resume_user`) OR nightly job | `users.py:926-936`; job `lift_expired_suspensions` at `users.py:982`, called from `scheduling.py:811` |
| `active`/`suspended` | `banned` | moderator (`ban_user`) | `users.py:487-494` — deletes `suspendedUntil`, clears `isSuspended`, bans every device |
| `banned` | `active` | moderator (`unban_user`) | `users.py:655-660` |
| `active` | `recovery_pending` | the user (`requestAccountDeletion`) | `accounts.ts:287-299` |
| `recovery_pending` | `active` | the user (`recoverAccount`) | `accounts.ts:351-357` |
| `recovery_pending` | `permanently_deactivated` | the user (`purgeMyAccountNow`, `accounts.ts:374`) OR daily sweep | `accounts.ts:199`; sweep `purgeDeletedAccounts` at `accounts.ts:410-436`, cron `30 3 * * *` Asia/Kolkata, bounded at 50/run |

**Cross-transitions are explicitly refused.** `unban_user` refuses a suspended account (`users.py:640`); `resume_user` refuses a banned one (`users.py:910`). `recoverAccount` refuses `permanently_deactivated` (`accounts.ts:343-349`).

`permanently_deactivated` is terminal. The purge releases identity (`phoneKey`, `email`, `phoneNumber`, auth login deleted) and retains seven subcollections listed at `accounts.ts:141-144`.

**Reconciliation function, not a field read.** `restriction_of()` (`users.py:224-258`) exists because documents predate `accountState`: it prefers `isSuspended=True` → suspension, then `accountState`, then `isBanned=True` → ban.

**`isActive` is NOT a user-account field.** It appears on `crmUsers` (`firestore.rules:39`), `bannedDevices` (`users.py:2294`), `agencies`/`sellers` (`partner_ops.py:450`), `liveRooms`, `partyRooms`. Not on `users/{uid}`.

**`deletionDueAt` / recovery window:** set server-side only (`accounts.ts:280-282`), grace from `ACCOUNT_RECOVERY_DAYS`, default 30 (`accounts.ts:80`). Idempotent — asking twice does not shorten it (`accounts.ts:274-278`).

**`isHost`** — boolean. True by `grant_host` (`users.py:1122`) or `activateHost` (`hosts.ts:312`); false by `revoke_host` (`users.py:1237`).

**`isVerifiedHost`** — boolean, deliberately NOT written by any grant path (`users.py:322-326`, `hosts.ts:318` writes explicit `false`). Set true by AI match (`hosts.ts:730`) or manual review (`verification.py:301-314`).

### `payoutHold` — WRITTEN BY NOTHING

Read in four places and written in zero:
- gate: `functions/src/payouts.ts:127` — `if (userSnap.get('payoutHold') === true)` blocks the payout
- surfaced: `payouts.ts:278`, `hostStats.ts:263`
- rendered: `zipper-app/.../EarningsScreen.kt:232` — "Payouts are on hold for this account."

It is on the staff-writable allowlist in `firestore.rules:1006`, `:1049`, `:1229`, but no CRM screen, no API endpoint and no Cloud Function sets it (`grep "payoutHold:"` returns only the two read-and-echo sites). There is no way to put a host on payout hold.

---

## 2. HOST

### `hostApplications.status`
Values: `pending` (born — `zipper-crm/app/agency-dashboard/page.tsx:593`), `approved`, `rejected` (`users.py:1322`).

**One writer of the decision:** `decide_host_application` (`users.py:1336`). `_host_decision_fields` (`users.py:1303-1333`) writes `status` and `kycStatus` **together** so they cannot drift.

Two older writers were deliberately closed:
- `onApprovalApproved` refuses `add_host` with `HOST_DECISION_REFUSAL` (`functions/src/index.ts:2956-2964`, `:2993-2999`)
- the queue that wrote `status: 'approved'` alone is named in the comment at `users.py:1267`

### `hostApplications.kycStatus`
Born `submitted` (`agency-dashboard/page.tsx:589`), then `approved` or `rejected`. `pending` is in the TypeScript union (`zipper-crm/lib/agencies.ts:40`) but `hostApplications` never carries it.

### `hostVerification.status`
Four values:
- `pending_capture` — seeded by `activateHost` (`hosts.ts:326`) and `host_verification_seed` (`users.py:335`). Deliberately NOT reviewable (`verification.py:53`: `REVIEWABLE = ("pending_manual",)`)
- `pending_manual` — AI below threshold, or no agency photo (`hosts.ts:703`, `:737`)
- `verified` — AI match (`hosts.ts:729`, `verifiedBy: 'ai'`) or reviewer (`verification.py:304-314`, `verifiedBy: 'manual'`)
- `rejected` — reviewer only (`verification.py:283`: verdict must be `'verified'` or `'rejected'`)

Reopening: `onAgencyPhotoReplaced` (`hosts.ts:776-805`) resets to `pending_capture` unless already `verified`.

### Becoming / stopping being a host
Two entry paths:
1. **Code redemption** — `activateHost` (`hosts.ts:161`). Requires `app.status === 'approved'`, not merely not-rejected (`hosts.ts:269-272`). Refuses a banned account (`hosts.ts:210`).
2. **Staff escape hatch** — `grant_host` (`users.py:1074`). Opens the verification record too (`users.py:1147`), because `submitHostCapture` refuses when it is missing.

Exit: `revoke_host` (`users.py:1219`) — refuses an account that is not a host (`users.py:1232`).

---

## 3. AGENCY and SUB-AGENCY — two vocabularies, NOT the same

**Mongo `partners.status`** — `PartnerStatus` (`backend/app/services/partners.py:28-32`): `pending`, `approved`, `rejected`, `suspended`. Four values.

**Firestore `agencies.status`** — `zipper-crm/lib/agencies.ts:35`: `'pending' | 'approved' | 'rejected'`. **Three values — no `suspended`.**

So a partner suspended in Mongo has no Firestore vocabulary to express it. `_fs_status_fields` (`partner_ops.py:450`) writes `"status": str(status)` unconditionally, so `suspended` *is* written to the Firestore document — into a field whose TypeScript type does not admit it and which no CRM status badge renders.

**Kind is also split.** Mongo has three kinds (`PartnerKind`: `agency`, `sub_agency`, `seller` — `partners.py:22-25`). Firestore uses `type: 'main' | 'sub'` on the agency document (`agencies.ts:26`) plus `parentAgencyId`. `notify.approved_partners` has to translate: `query["kind"] = {"$in": ["agency", "sub_agency"]}` (`notify.py:457`).

**`kycStatus`** — Firestore only, four values (`agencies.ts:40`): `pending`, `submitted`, `approved`, `rejected`. Written together with `status` by `_fs_status_fields` (`partner_ops.py:425-475`):
- approved + documents → `kycStatus: "approved"` (`:455`)
- approved + no documents → **left at `pending` on purpose** (`:456-469`), because the partner's upload form renders only while `kycStatus` is `pending` or `rejected`
- rejected or suspended → `kycStatus: "pending"`, not `rejected` (`:470-474`)

A seller also carries `isApproved` (`partner_ops.py:452`), written in the same dict so it cannot disagree.

`isActive` is independent of `status` (`partner_ops.py:450`). A partner can be `approved` + `isActive: false`.

---

## 4. COIN SELLER

**Firestore `sellers`** — `status?: 'pending' | 'approved' | 'rejected' | 'suspended'` (`zipper-crm/lib/sellers.ts:43`). **Optional**, and the comment at `:38-42` says why: sellers were approved through `isApproved` alone for a long time, so many documents have no `status` at all and `/kyc` consults both fields.

**Mongo `partners`** — same `PartnerStatus` four values. Here the vocabularies *do* match (seller type includes `suspended`); the agency type is the one that does not.

### `credit` standing — `CreditStanding` (`partners.py:35-40`)
Five values: `none`, `current`, `due_soon`, `overdue`, `written_off`.

**Derived, never stored.** `credit_standing(outstanding, due_at)` (`partners.py:894`) computes it; `partner_ops.py:3340-3342` calls it to populate a response field. The stored facts are `credit.outstanding`, `credit.due_at`, `credit.total_lent`, `credit.total_written_off`, `credit.written_off_at` (`partner_ops.py:3675-3677`, `:4027-4031`).

`overdue` blocks new inventory via `can_take_inventory` (`partners.py:912`).

**`written_off` is unreachable from `credit_standing`.** The write-off path at `partner_ops.py:4027` sets `credit.outstanding` to the remainder and stamps `written_off_at`, but `credit_standing` takes only `(outstanding, due_at)` — it has no way to see the write-off stamp. A fully written-off seller computes as `none`.

---

## 5. STAFF — Mongo `staff`

**No `status` field. One boolean: `is_active`.**

| state | representation | writer |
|---|---|---|
| invited / active | row inserted with `is_active: True` | `staff.py:400`, `invite()` |
| deactivated | `is_active: False` | `staff.py:840`, `deactivate()` |

There is no separate "invited" state. The row is born active (`staff.py:389-405`) and a password-reset link is emailed; the account is usable the moment the row exists. Audit: `before={"is_active": True}, after={"is_active": False, "firebase_login": ...}` (`staff.py:868-869`).

Reactivation: no function. `deactivate` is one-way in this module.

**Three-store write with two partial-failure actions.** Mongo + Firestore `crmUsers` + Firebase Auth. `staff.mirror_failed` (`audit.py:183`) and `staff.firebase_revoke_failed` (`audit.py:197`) exist precisely because a half-created or half-revoked account was previously only an error message the caller could dismiss.

---

## 6. KYC — the whole vocabulary

| field | values | writer |
|---|---|---|
| `agencies.kycStatus` / `sellers.kycStatus` | `pending`, `submitted`, `approved`, `rejected` | `partner_ops._fs_status_fields` (`partner_ops.py:425`); second-capability docs born `pending` (`partner_ops.py:1698`) |
| `hostApplications.kycStatus` | `submitted` (born), `approved`, `rejected` | `agency-dashboard/page.tsx:589`; `users.py:1322-1325` |
| `hostVerification.status` | `pending_capture`, `pending_manual`, `verified`, `rejected` | `hosts.ts:326/703/729/737/796`; `verification.py:304` |
| `kycSubmissions.status` | `pending` is the only value referenced | — |
| `hostKyc` | **NOT FOUND** — no such collection exists anywhere in the repo |

### `kycSubmissions` — read once, written never
`firestore.rules:1425` declares the collection. `zipper-crm/lib/firestore.ts:1068` counts `where('status','==','pending')` for a dashboard tile. No writer exists in any of the four codebases. The tile always reads zero.

---

## 7. APPROVAL CARD — `backend/app/services/cards.py`

**Seven stages** (`cards.py:32-39`): `requested`, `under_review`, `awaiting_signoff`, `approved`, `executed`, `rejected`, `failed`.

Spec line (`cards.py:5`): `Requested → Under Review → Awaiting Sign-off → Approved → Executed`.

| transition | function | who may | guard |
|---|---|---|---|
| ∅ → `requested` | `raise_card` (`:192`) | anyone who may raise for their team | non-empty reason, non-zero amount (`:195-198`) |
| ∅ → `awaiting_signoff` | `raise_card` with `auto_verified` | bank/gateway-proven payment | `:203` — skips review entirely |
| `requested` → `under_review` | `start_review` (`:251`) | owning team's admin, or Finance | `_assert_can_verify` (`:716`) |
| `requested`/`under_review` → `awaiting_signoff` | `verify` (`:261`) | same | mandatory note (`:264`); **not the raiser** (`:720`) |
| `awaiting_signoff` → `approved` | `sign` (`:299`) | business owner only (`:301`) | not the raiser (`:311`), not the verifier (`:316-320`), **not the subject** (`:334-338`) |
| `approved` → `executed` | `mark_executed(succeeded=True)` (`:407`) | the executing service | must be `approved` (`:412`) |
| `approved` → `failed` | `mark_executed(succeeded=False)` | same | `executed_at` left null (`:422`) |
| any pre-execution → `rejected` | `reject` (`:368`) | anyone, **except** from `awaiting_signoff` where owner only (`:377`) | mandatory reason (`:371`); refuses if already `executed`/`rejected` (`:374`) |

**`failed` is a dead end.** No function accepts `failed` as its `from` state. `reject` refuses only `executed` and `rejected` (`:374`), so a failed card can be *rejected* — but it can never be retried or re-executed, because `mark_executed` requires `approved`. A card that failed to execute is permanently stuck, which is stated as the intent (`:7-8`: "visibly stuck rather than silently lost").

**Bug in `_set_stage`.** `start_review` records the move to `under_review` under `audit.Action.CARD_VERIFIED` (`cards.py:752`) — the same action as an actual verification. `/audit` cannot tell "review started" from "verification complete"; only the `reason` string ("Review started") distinguishes them.

**18 card types** (`cards.py:42-113`). Partner-readable subset is an allowlist of 8 (`PARTNER_SUBJECT_CARD_TYPES`, `:147-158`).

---

## 8. APPROVAL REQUESTS

### `approvalRequests.status`
Three values (`zipper-crm/lib/approvals.ts:42`): `pending` (born, `:75`), `approved` (`:121`), `rejected` (`:137`).

`onApprovalApproved` (`functions/src/index.ts:2966`) fires only on the transition *into* `approved` (`:2974`). Three outcomes:
- **money type** → refused, written back as `status: 'rejected'` (`index.ts:2983-2989` → `failApproval`)
- **host decision type** → refused the same way (`:2993-2999`)
- otherwise → applied, stamps `appliedAt` + `appliedNote` (`:3010-3016`)

`failApproval` (`index.ts:3043-3061`) writes `status: 'rejected'`, `applyFailed: true`, `applyError`, `applyFailedAt`, and **deletes `appliedAt`**. The comment at `:3039` is explicit: "'rejected' is used because it is the only non-pending failure state the CRM renders." So **a technical failure and a human refusal are the same value** — `applyFailed` is the only discriminator, and it is not in the CRM status filter.

### `partyRooms/{id}/seatRequests/{uid}` and `seatInvites/{uid}`
**NOT FOUND — no status field.** Existence *is* the state. Created with `uid/name/photoUrl/seatIndex/requestedAt` (`party.ts:927-933`) and `targetUid/seatIndex/byUid/byName/roomTitle/invitedAt` (`party.ts:1037-1044`). Resolved by deletion from four places: `party.ts:508`, `:741-742`, `:887-888`, `:945`, `:1061`. A declined invite and an expired invite are indistinguishable.

---

## 9. WITHDRAWAL — `withdrawalRequests`

Four values (`zipper-crm/lib/firestore.ts:532`): `pending`, `approved`, `rejected`, `paid`.

| transition | writer |
|---|---|
| ∅ → `pending` | **no writer exists** (see below) |
| `pending` → `approved` | `approveWithdrawal` (`firestore.ts:560-567`) |
| `pending` → `rejected` | `rejectWithdrawal` (`firestore.ts:587-594`) |
| `approved` → `paid` | `markWithdrawalPaid` (`firestore.ts:578-585`) |

UI gating: approve shown on `pending`, mark-paid on `approved` (`finance/withdrawals/page.tsx:870`, `:897`).

### The queue has no producer
`firestore.rules:2614-2617` permits a host to create one (`hostUid == request.auth.uid && status == 'pending'`). **No code in any codebase files one** — not the Android app, not the CRM, not a Cloud Function. `/finance/withdrawals` reads a collection nothing populates. Business purpose unclear whether this is pre-wiring or an abandoned path.

### All three writes record `processedBy: 'Admin'` — a literal
`firestore.ts:564`, `:582`, `:592`. Not the actor's uid, not their name. The document never records who approved, rejected or paid. No Mongo audit entry either (see Part C).

The money itself moves separately as a `host_withdrawal` card (`cards.py:54`) executed at `partner_ops.py:4794-4844` with `audit.Action.WITHDRAWAL_PAY` and `idempotency_key=f"card:{card_id}:withdrawal"`. Nothing links the Firestore `paid` flag to the card.

---

## 10. SALARY REQUEST — `salaryRequests`

Five values (`zipper-crm/lib/agencies.ts:89`, `agencies/[id]/salary/Client.tsx:30`): `pending`, `approved`, `paid`, `distributed`, `rejected`.

| transition | who | evidence |
|---|---|---|
| ∅ → `pending` | the agency | `agency-dashboard/page.tsx:970-981` |
| `pending` → `approved` | Finance / superadmin | `salary/Client.tsx:116-118` |
| `approved` → `paid` | Finance / superadmin, UTR required | `salary/Client.tsx:129-131` |
| `paid` → `distributed` | **the agency itself** | `agency-dashboard/page.tsx:2182-2185`; rule `firestore.rules:2678-2679` restricts the agency's update to `hasOnly(['status','distributedAt'])` and `status == 'distributed'` |
| `pending` → `rejected` | Finance / superadmin | `salary/Client.tsx:155` |

`rejected` was added to break a collision: the refusal path used to write `distributed`, making a refusal indistinguishable from a completed payment (`salary/Client.tsx:143-153`).

**No actor and no reason on any transition.** `handleApprove` writes `{status, approvedAt}`; `handleMarkPaid` writes `{status, paidAt, utrNumber}`; `handleReject` writes `{status}` alone. Nothing records who, and nothing records why.

---

## 11. RECHARGE REQUEST — `rechargeRequests`

Three values (`zipper-crm/lib/sellers.ts:72`): `pending`, `approved`, `rejected`.

`onRechargeApproved` (`functions/src/index.ts:1545`) fires on `pending → approved` (`:1572`) and moves real value: seller `coinBalance` down, buyer `diamonds` up, `diamondTransactions` row (`:1622-1640`).

**The retry is a backward transition.** On failure the function writes `status: 'pending'` (`index.ts:1674-1684`) plus `transferError`, `transferFailedAt`, `transferAttempts` (incremented), and `transferErrorReason` in the seller's own words. The guard at `:1572` is deliberately left narrow so the next `pending → approved` fires again (`:1568-1570`). So `approved` is **not terminal** — it can revert.

Approval writer: the seller, from Android — `SellerDashboardScreen.kt:453` → `.update("status", "approved")`. Also CRM-side (`FileSaleDialog.tsx:7`).

---

## 12. COIN PURCHASE REQUEST — `coinPurchaseRequests`

Type declares three (`zipper-crm/lib/coinPurchases.ts:27`): `pending`, `approved`, `rejected`.

**`approved` is declared but unreachable.**

- ∅ → `pending`: Android `BuyCoinScreen.kt:214-228` (`"status" to "pending"`); CRM seller dashboard. Rules pin it: `request.resource.data.get('status','') == 'pending'` (`firestore.rules:2792`) — added because a seller could previously file one already marked `approved` (`:2788-2791`).
- `pending` → `rejected`: `rejectCoinPurchase` (`coinPurchases.ts:112-123`), Finance-admin or owner only (`firestore.rules:2803`).
- `pending` → `approved`: **deleted**. `coinPurchases.ts:88-110` records that `approveCoinPurchase` was removed; approval now goes through `POST /api/partner-ops/sellers/{id}/coin-purchases` → a `seller_coin_purchase` card on the Mongo board. Nothing ever writes `approved` back onto the Firestore document.

Result: a seller whose purchase was approved sees their request sit at `pending` forever.

---

## 13. SUB-AGENCY PAYOUT — `subagency_payouts`

Three values (`backend/app/services/partner_ops.py:121-124`): `pending`, `parent_paid`, `closed`.

**Leg 1** — `execute_subagency_payout` (`partner_ops.py:5015`). Zipper pays the parent agency. Sets `status: parent_paid` and `leg1.status: "paid"` (`:5064-5065`). Audit `subagency.paid_parent` (`:5077`).

**Leg 2** — `confirm_subagency_leg` (`partner_ops.py:5115`). The parent confirms it passed the money on. Requires `status == parent_paid` (`:5130`), refuses if already `closed` (`:5128`). Sets `status: closed` and `leg2.status: "confirmed"` (`:5140-5141`). Audit `subagency.parent_paid_sub` (`:5154`).

Both legs carry their own sub-status (`leg1.status`, `leg2.status`) alongside the top-level `status` — two representations of the same fact, written in the same update so they cannot drift.

`open_subagency_payouts` (`:5170`) queries `{"status": {"$ne": PayoutStatus.CLOSED}}` (`:5185`) — leg 2 is what closes the payout, as `cards.py:136-138` explains: without the card the sub-agency sees its balance fall to zero on leg 1 and cannot tell "Zipper has paid my parent" from "I have been paid".

---

## 14. CALL — `calls/{callId}`

Values found in `functions/src/calls.ts`: `ringing`, `connected`, `ending`, `ended`, `missed`, `declined`.

| transition | trigger | evidence |
|---|---|---|
| ∅ → `ringing` | caller initiates | `calls.ts:184` |
| `ringing` → `connected` | receiver accepts | `calls.ts:256`; idempotent at `:243-244` |
| `connected` → `ending` | diamonds exhausted mid-tick | `calls.ts:383`, `:417` — `endReason: 'diamonds_exhausted'` |
| `ringing` → `missed` | receiver did not answer | `calls.ts:288`, and the sweep at `:709`/`:720` |
| `ringing` → `declined` | receiver declined | `calls.ts:288` (`endReason: 'receiver_declined'`) |
| `connected`/`ending` → `ended` | either party hangs up | `calls.ts:524`, `:595` |

`endReason` is a second, finer vocabulary: `missed`, `receiver_declined`, `diamonds_exhausted`.

Automatic job: a sweep of `status == 'ringing'` (`calls.ts:691`) re-checks and marks `missed` (`:705-720`). `ending` is a transient — it signals the client to tear down; `ended` is written by the hangup path.

---

## 15. LIVE ROOM — `liveRooms`

**No `status` field. One boolean: `isActive`.**

- ∅ → `isActive: true`: host goes live (`GoLiveViewModel.kt:206`)
- `true` → `false`: host ends it, or staff intervene via `end_room` (`backend/app/services/live.py:175`, audit `live.room_ended` at `live.py:72`)

`live.py:192` refuses to end a room that is already inactive. `before={"isActive": True}`, `after={"isActive": False}` (`live.py:205-235`).

Second axis: host mute — `mute_host` (`live.py:273`), audit `live.host_muted` / `live.host_unmuted` (`live.py:75-76`).

Feed ranking follows `isActive` (`profiles.ts:220-228`). `pushLiveStarted` fires on document create and skips when `isActive === false` (`push.ts:208`).

---

## 16. PARTY ROOM — `partyRooms`

**No `status` field.** `isActive: true` at creation (`party.ts:389`), `false` at close (`party.ts:1418`). `requireLiveRoom` refuses an inactive room (`party.ts:227`). `closePartyRoom` is idempotent (`party.ts:1359`).

Auto-close: `sweepEmptyPartyRooms` sets `{isActive: false, endedAt}` (`party.ts:363-367`), driven by `emptySince` — null means the clock has not started (`party.ts:406-416`).

### Seat states — four independent fields, deliberately not collapsed
Seat document `partyRooms/{id}/seats/{index}` (`party.ts:852-874`):
- `isMuted` + `mutedBy` + `mutedByRole` — a moderator's decision
- `selfMuted` — the occupant's own
- `cameraOff` — starts `true` in video mode (`:871`)
- `beansReceived`

`party.ts:859-863` states why the two mutes are separate: collapsing them would let a muted guest unmute themselves. Unmute authority is checked against `mutedByRole` (`party.ts:1229-1240`) — an owner's mute can only be lifted by the owner.

Room-level seat state: `lockedSeats: number[]` (`party.ts:400`, `:1279`), `kickedUsers: []`, `admins: []`. A locked seat is refused on both the direct and invite paths (`party.ts:826-828`, `:922-924`) — only the direct path checked it before (`:810-811`).

---

## 17. CHANCE ROUND — `RoundStatus`

Five values (`backend/app/services/chance.py:265-270`):
- `committed` — seed hash published, nothing staked
- `playing` — claimed for a draw; **"a crash leaves it here"** (`:267`)
- `recorded` — outcome written, payout not yet credited
- `settled`
- `void`

Sibling machine `ConfigStatus` (`chance.py:258-262`): `draft` (card raised, nothing live), `live`, `superseded`, `withdrawn` (the card was rejected).

Audit actions are a local `class Act` (`chance.py:273-300`): `chance.stake`, `chance.payout`, `chance.round_recorded`, `chance.round_void`, `chance.client_claim_ignored`, `chance.external_settlement`, `chance.ceiling_breached`, `chance.mechanic_suspended`, `chance.mechanic_resumed`, `chance.player_frozen`, `chance.player_unfrozen`, `chance.mechanic_created`. `CONFIG_CHANGED` is aliased to `audit.Action.CONFIG_CHANGED` (`chance.py:285`).

---

## 18. TICKET — six collections, four vocabularies

| collection | values | declared at |
|---|---|---|
| `supportTickets` | `open`, `in_progress`, `replied`, `closed` | `zipper-crm/lib/firestore.ts:755` |
| `feedbackTickets` (both CRM screens) | `open`, `assigned`, `in_progress`, `resolved`, `closed` | `app/feedback/page.tsx:53` and `app/operations/feedback/page.tsx:43` |
| `feedbackTickets` (the TypeScript type) | `open`, `in_review`, `resolved` | `zipper-crm/lib/operations.ts:66` |
| `feedbackTickets` (Android) | `open`, `in_progress`, `resolved` rendered | `FeedbackScreen.kt:101`, `:577-580` |
| `techTickets` | `open`, `in_progress`, `review`, `done` | `zipper-crm/lib/tech.ts:29` |
| `opsTickets` | `open` (born), `resolved` (stamps `resolvedAt`) | `zipper-crm/lib/operations.ts:170`, `:181` — `updateTicketStatus(id, status: string)` takes **any** string |
| `reports` | `pending`, `reviewed`, `actioned`, `dismissed` | `backend/app/services/users.py:145-149`; `zipper-crm/lib/operations.ts:29`; `zipper-crm/lib/api.ts:486` |

### Where two screens disagree about the same data — explicitly

**1. `feedbackTickets` — fixed, with the scar tissue visible.** The header of `app/feedback/page.tsx:6-12` says it plainly: two screens read one collection and disagreed about what a status was, so `where('status','==',tab)` ran against a vocabulary that did not contain the value. Both screens now declare the identical five-value `STATUSES` and carry an identical `LEGACY_STATUS` map (`feedback/page.tsx:73-86`, `operations/feedback/page.tsx:63-76`) translating `in_review`/`in-review`/`reviewing`/`inprogress`/`in-progress`/`working` → `in_progress`, `pending`/`new` → `open`, `done`/`complete`/`completed`/`fixed` → `resolved`. Normalisation is read-time (`normalizeStatus`), migration is write-time only (`feedback/page.tsx:313`: "always canonical — this is the migration").

**But the shared type was never updated.** `zipper-crm/lib/operations.ts:66` still declares `status: 'open' | 'in_review' | 'resolved'` — the pre-fix Operations vocabulary — and `getFeedbackTickets()` casts raw documents to it (`operations.ts:193`). `updateFeedbackStatus(id, status: string)` (`:196`) accepts any string. The type is a third vocabulary that agrees with neither screen.

**And the Android app is a fourth.** `FeedbackScreen.kt:577-580` colours `"open"` and `"resolved"` and nothing else; `assigned` and `closed` render with the fallback tint. A ticket an Operations user moves to `assigned` has no colour in the app that filed it.

**2. `supportTickets` vs `feedbackTickets` — the real split, not reconciled.** `firestore.rules:2001-2005` asserts they "point at the same logical data; Android writes to feedbackTickets, CRM reads from supportTickets." That is not what the code does:

- Android `FeedbackScreen` writes **and** reads `feedbackTickets` (`FeedbackScreen.kt:130`, `:225`)
- Android `ChatRepository.ticketsFlow` reads `supportTickets` (`ChatRepository.kt:27`, `:219-220`)
- CRM `/tickets` reads and updates `supportTickets` (`firestore.ts:811`, `:856`)
- CRM `/feedback` and `/operations/feedback` read and update `feedbackTickets`

**Nothing creates a `supportTickets` document.** No `addDoc(collection(db,'supportTickets'))`, no `.add()` from Kotlin. So `respondToTicket` (`firestore.ts:851`), `setSupportTicketStatus`, `assignSupportTicket`, `closeTicket` and `routeSupportTicketToTeam` all operate on a collection with no producer — and a ticket filed from the app's Feedback screen can never receive a reply, because the reply writes to the other collection.

**3. `reports.status: 'reviewed'` is declared in three places and written by nothing.** `action_report` (`users.py:2539-2543`) computes `status_after` as `dismissed` if the action is DISMISS, else `actioned`. There is no branch producing `reviewed`. Yet it is a tab in `zipper-crm/app/operations/reports/page.tsx:142` and a member of both TypeScript unions. The tab is permanently empty.

**4. `crmSupportTickets` — rules only.** `firestore.rules:2024-2031` grants it a full read/create/update/delete surface. The collection appears nowhere else in the repo: no reader, no writer, no type, no status vocabulary. **NOT FOUND** as implemented.

`reports` born `pending` from Android (`LiveRepository.kt:428`).

---

## 19. APPEAL — `appeals`

Three statuses (`backend/app/services/appeals.py:93-98`): `pending`, `upheld`, `overturned`.

Two kinds (`appeals.py:86-90`): `ban`, `report`.

`decide_appeal` (`appeals.py:236`) refuses anything not `pending` (`:262-263`). Audit `appeal.upheld` / `appeal.overturned` (`appeals.py:104-105`).

### The four consequence types, and how each reverses (`appeals.py:26-52`)

| consequence | reversal | audited as |
|---|---|---|
| `ban` | account unbanned; device bans *that ban caused* come off with it | `user.unbanned` (`appeals.py:320-321`) |
| `suspend` | account **resumed** — a different call, and no device touched | `user.resumed` (`appeals.py:311-314`) |
| `warn` | the warning **stays** and is marked overturned | `appeals.py:364-370` — "A deleted warning is a deleted fact" |
| `deduct` | if the card is unsigned it is cancelled; if signed, the beans are gone and a **new credit card** must be raised and signed | `appeals.py:374` |

The suspend/ban split exists because reversing a suspension through unban used to delete device bans belonging to someone else's decision (`appeals.py:36-39`, echoed in `audit.py:99-102`).

`decide_appeal` returns both `reversed_acts` and `outstanding` (`appeals.py:316-338`) so the CRM can show what it could *not* do — an appeal reading "overturned" while beans are still missing is named as the same class of lie as a report marked actioned that banned nobody (`appeals.py:49-52`).

When the appeal names a report, that report is also forced to `status: "dismissed"` (`appeals.py:353`).

---

## 20. EXPENSE / CAPITAL CARD

**NOT FOUND as separate state machines.** Both are card *types*, carrying the seven-stage `Stage` machine from §7 unchanged.

**Expense** — `CardType.OPERATING_EXPENSE` (`cards.py:91`), category in `payload.category`. Eight categories (`expenses.py:121-128`): `staff_salaries`, `infrastructure`, `marketing`, `gateway_fees`, `binance_fees`, `taxes`, `refunds_to_users`, `other`. One type rather than eight is argued at `cards.py:86-90`. Audit: `expense.raised` → `expense.paid` (`expenses.py:159-160`), both carrying the raiser's own reason.

**Capital** — `CardType.OWNER_CAPITAL_IN` and `CardType.OWNER_DRAWINGS` (`cards.py:112-113`). Reason for separate types rather than an expense category is at `cards.py:93-111`: neither is revenue and neither is a cost. `mark_settled` (`capital.py:168`) requires `Stage.APPROVED` (`:184`), then calls `mark_executed(succeeded=True)` and writes a **second** audit entry under `CARD_EXECUTED` with `subject_type="owner_capital"` (`capital.py:197-209`). Two `card.executed` entries for one movement, on different subjects.

**No capital `failed` path.** `mark_settled` passes `succeeded=True` unconditionally (`capital.py:194`) — a capital transfer that fails at the bank cannot be recorded as failed.

---

## 21. EMAIL DELIVERY — `email_deliveries`

Fourteen values, `class Outcome` (`backend/app/services/email.py:87-104`):

`queued`, `sent`, `delivered`, `failed`, `bounced`, `dropped`, `deferred`, `spam_report`, `unsubscribed`, `no_address`, `not_configured`, `withheld_role`, `unsubscribed_local`, `suppressed_repeat`, `duplicate`.

**Reachable from `deliver()`:**
- born `queued` (`email.py:917`)
- `duplicate` on a `dedupe_key` collision (`:1782`)
- `not_configured` when `SENDGRID_API_KEY` is unset (`:1790`)
- `sent` on provider acceptance (`:1825`), `failed` otherwise (`:1832`)

**Reachable only from the SendGrid webhook** `record_provider_events` (`email.py:1916`), via `_EVENT_OUTCOME` (`:1901-1910`): `delivered`, `bounced` (from both `bounce` and `blocked`), `dropped`, `deferred`, `spam_report`, `unsubscribed` (from both `unsubscribe` and `group_unsubscribe`).

`_TERMINAL = {bounced, dropped, spam_report}` (`:1913`) — `delivered` never overwrites a worse later fact (`:1954-1965`).

**Reachable only from `record_withheld`** (`email.py:988`), called by a caller that chose not to send: `no_address`, `withheld_role`, `unsubscribed_local`, `suppressed_repeat`.

`FAILURE_OUTCOMES` (`:109-121`) includes `queued` — a send stuck in `queued` means the process died between recording and the provider answering, and `_close_record` leaves it there on purpose (`:962-971`).

---

## 22. LENDING

**No dedicated status field.** Lending state is carried by two things:

**(a) Four card types** on the `Stage` machine: `LENDING_ISSUE`, `LENDING_REPAY`, `LENDING_RECOVER`, `LENDING_WRITE_OFF` (`cards.py:48-51`), plus `BAD_DEBT_WRITE_OFF` (`:62`). All five are partner-readable (`cards.py:149-154`).

**(b) The `credit` sub-document on the Mongo partner:**
- `credit.outstanding` — `$inc` on issue (`partner_ops.py:3675`), recomputed on repay (`:3781`), recover (`:3931`), write-off (`:4027`)
- `credit.due_at` — set on issue (`:3677`), cleared to `None` when fully repaid (`:3799`)
- `credit.total_lent`, `credit.total_written_off`, `credit.written_off_at`

Derived standing is `CreditStanding` from §4 — five values, computed not stored, with `written_off` unreachable.

Execution functions each refuse an empty position: `request_lending` (`:3601`), `execute_lending` (`:3640`), repay (`:3727-3729`: "This seller has no outstanding credit to repay"), recover (`:3848-3850`), write-off (`:3983`, `:4018`).

Audit: `lending.issue`, `lending.repay`, `lending.recover`, `lending.write_off` (`audit.py:47-50`), each written inside the movement.

---

# PART B — NOTIFICATION INVENTORY

## B1. PUSH (FCM)

All of it is in `functions/src/push.ts`. **No other file in `functions/src` calls `admin.messaging()`** — verified by grep. Four senders.

**Every message is data-only** (`push.ts:16-20`): a notification-type message is rendered by the OS with no app code involved, so no full-screen intent, no ringtone, no suppression when the user is already in that chat. Control goes to `ZipperMessagingService`.

| # | export | trigger | recipient | payload `type` | data-only | deep link / fan-out |
|---|---|---|---|---|---|---|
| 1 | `pushIncomingCall` (`:128`) | `calls/{callId}` onCreate, only when `status === 'ringing'` (`:132`) | `call.receiverId` | `INCOMING_CALL` | yes | `callId` + `callerUid`/`callerName`/`callerPhotoUrl`/`createdAt` (`:138-143`). `call: true` → `priority: 'high'`, `ttl: 30_000`, `directBootOk: true` (`:97-98`) |
| 2 | `pushCallStatus` (`:150`) | `calls/{callId}` onUpdate, only `ringing → anything-else` (`:155`) | `after.receiverId` | `CALL_ENDED` | yes | `callId` + `status` (`:162`). Purpose is to take the ringing notification down |
| 3 | `pushChatMessage` (`:170`) | `conversations/{cid}/messages/{msgId}` onCreate | the other half of the sorted-uid-pair conversation id (`:178`) | `NEW_MESSAGE` | yes | `convoId`, `senderUid`, `senderName`, `preview` (`:192-197`). TTL 24h |
| 4 | `pushLiveStarted` (`:204`) | `liveRooms/{roomId}` onCreate, skipped when `isActive === false` (`:208`) | the host's followers | `LIVE_STARTED` | yes | `roomId`, `hostUid`, `hostName`, `hostPhotoUrl`, `title` (`:231-238`). TTL 1h |

**Suppression:** #3 checks `users/{recipient}/blocked/{senderUid}` and returns silently if present (`push.ts:182-183`).

**Token model:** `users/{uid}/fcmTokens/{token}`, one document per device. Legacy `users/{uid}.fcmToken` is read only when the subcollection is empty (`push.ts:51-65`) — once any device updates, the subcollection wins, specifically so the same token is not sent to twice.

### Retry and failure
**No retry on any push.** `send()` (`push.ts:90-115`) swallows every error:
- dead token (`registration-token-not-registered`, `invalid-registration-token`, `invalid-argument`) → `dropDeadToken` deletes that one device's document, and the legacy field only if it names that exact token (`:72-83`). Logged at info.
- anything else → `logger.warn` and return (`:113`). The message is gone.

`sendToUser` uses `Promise.all` over tokens so one failing device cannot stop the others (`:121-123`).

For #4 the multicast path collects dead tokens per `(uid, token)` pair and drops them (`push.ts:262-271`).

### The documented cap on #4
`push.ts:216-220`: **hard cap at 2000 followers.** Beyond that this single invocation would read one token subcollection per follower under one 540s timeout, and a retry would repeat all of it. "Until then the 2001st follower is not notified, which is a missed notification rather than a timed-out function." The task-queue fan-out is named as still to be done.

---

## B2. EMAIL

Two completely separate email systems with different providers configured, different record-keeping, and no shared template library.

### B2a. The backend system — `backend/app/services/email.py` (3153 lines)

Sender is SendGrid via `settings.sendgrid_api_key`. Three sender identities (`email.py:1050-1063`): `transactional`, `bulk`, `support`. Every send writes a row to Mongo `email_deliveries` **before** the provider is called (`:1702-1705`); if the row cannot be written, `DeliveryNotRecorded` is raised and **nothing is sent** (`:874-880`) — "An email nobody can prove was sent is not a control."

Recipients resolve two ways and no third (`notify.py:9-21`): internal from Mongo `staff` by `role` + `is_active: True` (`notify.py:177-179`); partner-facing from the partner's own Firestore document, fields tried in order `ownerEmail`, `email`, `contactEmail`, `loginEmail` (`notify.py:381`). There is deliberately no hardcoded fallback — an owner-bound report with no owner on the staff record resolves to *nobody* and says so (`notify.py:12-17`).

`email.may_receive(sensitivity, recipient)` (`:810`) is checked inside `deliver()` at the moment of sending, over five sensitivities (`:142-171`): `operational`, `business_money`, `partner_own`, `credential`, `announcement`.

#### Transactional emails

| kind | spec | trigger | recipient | subject | dedupe key shape | cadence |
|---|---|---|---|---|---|---|
| `staff.invitation` | 8A.2.1 | `staff.invite()` when a reset link was generated (`staff.py:463`) | the new staff member | `You have been added to Zipper as {role_label}` (`:2179`) | **none** | immediate, synchronous |
| `staff.access_added` | 8A.2.2 | `staff.invite()` when the address already had a Zipper sign-in (`staff.py:472`) | the new staff member | `You now have Zipper {role_label} access` (`:2220`) | **none** | immediate, synchronous |
| `observer.otp` | 2.2 | observer login (`core/security.py:1176`) | the observer delivery mailbox | `Your Zipper observer sign-in code` (`:2249`) | **none** | immediate, synchronous |
| `partner.application_received` | 8A.2.3 | **NO CALLER** | would be the applicant | `We have your Zipper {kind} application ({ref})` (`:2319`) | `partner.application_received:{partner_id}` | never sent |
| `partner.approved` | 8A.2.4 | **NO CALLER** | would be the partner | `Your Zipper {kind} account is approved` (`:2352`) | `partner.approved:{partner_id}:{when(approved_at)}` | never sent |
| `partner.rejected` | 8A.2.5 | `_sweep_rejections` (`scheduling.py:1311`) | partner `ownerEmail` | `Your Zipper {kind} application was not approved` (`:2431`) | `partner.rejected:{partner_id}:{when(rejected_at)}` | every 15 min |
| `partner.rejected` (no-reason variant) | 8A.2.5 | same, when the record carries no reason | — | `Rejection notice not sent — no reason on the record` (`:2390`) | `partner.rejected.noreason:{partner_id}` | written, not sent |
| `partner.deactivated` | 8A.2.13 | `_sweep_deactivations` (`scheduling.py:1358`) | partner | `Your Zipper account has been deactivated` (`:2483`) | `partner.deactivated:{partner_id}:{when(deactivated_at)}` | every 15 min |
| `payout.approved` | 8A.2.7 | `_sweep_payouts_approved` (`scheduling.py:1404`) | partner | `Payout approved — {money} for {period_label}` (`:2528`) | `payout.approved:{card_id}` | every 15 min |
| `payout.paid` | 8A.2.8 | `_sweep_payouts_paid` (`scheduling.py:1443`) | partner | `Payment sent — {money}` (+UTR) (`:2595`) | `payout.paid:{card_id}` | every 15 min |
| `credit.due_soon` | 8A.2.10 | `_sweep_credit_due` (`scheduling.py:1483`) | seller | `Your credit falls due in {day_text}` (`:2645`) | `credit.due_soon:{seller_id}:{when(due_at, no time)}` | every 15 min |
| `credit.overdue.seller` | 8A.2.11 | `_sweep_credit_overdue` (`scheduling.py:1526`) | seller | `Overdue: {coins} coins, due {date}` (`:2700`) | **`None` on purpose** (`:2707`) — repeat suppression handles cadence, not the key | every 15 min, gated by `CREDIT_OVERDUE_REPEAT_HOURS` |

**The two with no caller.** `send_partner_application_received` and `send_partner_approved` are fully implemented, templated, previewable (`PREVIEWABLE` at `email.py:3140-3141`) and have **zero call sites** anywhere in the repository. The emails a partner actually receives for those two events come from the Cloud Functions in B2b, which write no `email_deliveries` row.

#### Scheduled reports — `scheduling.py`

| report_key | spec | cadence | audience | dedupe prefix |
|---|---|---|---|---|
| `daily_business_summary` | 8A.3.1 | daily 07:00 IST | owners, observer | `{report_key}:{cadence}:{period_key}` (`scheduling.py:453`) |
| `daily_finance_worklist` | 8A.3.2 | daily | Finance admin | same shape |
| `daily_exceptions` | 8A.3.3 | daily | owners | same shape |
| `monthly_pnl` | 8A.3.9 | monthly, 1st 08:00 IST | owners | same shape |
| `monthly_accounting_pack` | 8A.3.11 | monthly | owners, Finance | same shape |
| `monthly_audit_summary` | 8A.3.12 | monthly | owners, observer | same shape |
| `weekly_business` | owner request | Monday 07:30 IST | owners | `scheduling.py:1942` |
| partner statements | 8A.3.6 / 8A.3.7 | weekly Monday 09:00, and monthly | each approved active partner, per `ownerEmail` | `statement:{kind}:{partner_id}:{cadence}:{period_key}` (`scheduling.py:1226`) |

Per-recipient keying is in `deliver_many` (`email.py:1874`): `f"{dedupe_prefix}:{recipient.email.strip().lower()}"` — "one person's send failing or being withheld" must not block another's.

Full cron table at `scheduling.py:2076-2192`, timezone `Asia/Kolkata`:

| job | cron | function |
|---|---|---|
| `transactional-sweep` | `*/15 * * * *` | `scheduledTransactionalSweep` |
| `alerts` | `*/30 * * * *` | `scheduledAlertScan` |
| `reconcile` | `0 3 * * *` | `scheduledReconciliation` |
| `daily` | `0 7 * * *` | `scheduledDailyReports` |
| `weekly-business` | `30 7 * * 1` | `scheduledWeeklyBusinessReport` |
| `partner-statements` | `0 9 * * 1` | `scheduledPartnerStatements` |
| `monthly` | `0 8 1 * *` | `scheduledMonthlyReports` |

The `reconcile` entry carries a note (`scheduling.py:2104-2119`) that it was deployed and running nightly but absent from this table for a period — so it appeared on no jobs board and in no "job has never run" detection, and "could have failed every night for a month in silence."

Reports can be muted per address (`notify.set_subscription`, `notify.py:249`) and outside addresses added by an owner, carried as `authorised_by` (`notify.py:260-264`). **Alerts pass neither `report` nor `cadence` and therefore cannot be muted** (`notify.py:302-305`) — "an alert somebody switched off is not an alert."

#### Alert emails — 16 detectors, `alerts.py:1316-1559`

| detector id | spec | severity | audience | threshold setting |
|---|---|---|---|---|
| `bank_details_changed` | 8A.4.1 | critical | owners, observer | `ALERT_SCAN_MAX_LOOKBACK_HOURS` |
| `rate_feed_failed` | 8A.4.2 | warning | owners, Finance | `ALERT_RATE_STALE_HOURS` |
| `duplicate_payment_ref` | 8A.4.3 | critical | Finance, owners | `ALERT_DUPLICATE_REF_LOOKBACK_DAYS` |
| `large_card_awaiting_signature` | 8A.4.4 / 8A.2.12 | warning | owners | `ALERT_LARGE_AMOUNT_INR` |
| `execution_failed` | 8A.4.5 | critical | Finance, owners | `ALERT_SIGNED_NOT_EXECUTED_HOURS` |
| `settlement_mismatch` | 8A.4.6 | critical | Finance, owners | `ALERT_SETTLEMENT_TOLERANCE_MINOR` |
| `queue_ageing` | 8A.4.7 | warning | owners, overridden per finding by the item's own team | `ALERT_QUEUE_AGE_HOURS` / `ALERT_QUEUE_ESCALATE_HOURS` |
| `staff_access_changed` | 8A.4.8 | warning | owners, observer | `ALERT_SCAN_MAX_LOOKBACK_HOURS` |
| `failed_logins` | 8A.4.9 | critical | owners | `ALERT_FAILED_LOGIN_THRESHOLD` / `_WINDOW_MINUTES` |
| `credit_overdue` | 8A.2.11 | warning | Finance, owners | `CREDIT_OVERDUE_REPEAT_HOURS` |
| `delivery_failures` | 8A.2.15 | critical | owners, observer | `ALERT_DELIVERY_FAILURE_LOOKBACK_HOURS` |
| `chance_mechanic_suspended` | 8B.4.5 | critical | owners, Finance | `CHANCE_PLATFORM_DAILY_PAYOUT_CEILING` |
| `chance_reserve_low` | 8B.4.3 | warning | owners, Finance | `CHANCE_RESERVE_WARNING_PPM` |
| `chance_rtp_divergence` | 8B.5.1 / 8B.5.2 | critical | owners, Finance | `CHANCE_RTP_DAILY_SIGMA_MILLI` / `_WINDOW_SIGMA_MILLI` / `_MIN_ROUNDS` |
| `chance_player_anomaly` | 8B.5.3 | warning | `team_admin:ops`, owners | `CHANCE_PLAYER_SIGMA_MILLI` / `_MIN_ROUNDS` / `_MAX_ROUNDS_PER_HOUR` / `_MIN_ROUND_GAP_MS` |

Plus `raise_now` (`alerts.py:1655`) for ad-hoc alerts, which deliberately reuses the same resolver, suppression store and dedupe key rather than being a second mailer (`:1683-1684`).

Alert dedupe prefix: `f"alert:{detector.id}:{finding.key}:{finding.fingerprint}"` (`alerts.py:1632`), kind `f"alert.{detector.id}"` (`:1621`). The **fingerprint is what stops suppression becoming silence** (`alerts.py:24`, `:86-91`): a condition that gets worse re-alerts rather than being suppressed. Suppression state lives in Mongo `alert_state` keyed uniquely (`mongo.py:262`); `claim()` (`alerts.py:144`) takes the lock, and if the store is unreadable the alert is **sent without dedupe** rather than dropped (`alerts.py:213-220`).

`bank_details_changed` is matched against the audit subject via `_BANKING_SUBJECT` (`alerts.py:325-329`) over `config.changed` and `rate.changed` entries. **Nothing writes those actions** — see Part C. This detector cannot fire.

#### Retry and failure — backend email
**There is no retry.** `deliver()` makes exactly one provider call and writes `attempts: 1` (`email.py:1791`, `:1816`). The `attempts` field is never incremented anywhere.

The failure mode is worse than "no retry": the `dedupe_key` row is inserted **before** the provider call (`email.py:1779`) and is **not removed on failure** (`:1832-1838` only patches the outcome). So on the next 15-minute sweep the same key collides, `_insert_record` returns `duplicate`, and `deliver()` returns early with `"Already sent for this event; nothing re-sent."` (`:1781-1784`). **A failed transactional email is permanently not sent.**

Compensation is detection only: `delivery_failures` (8A.2.15, critical, owners + observer) scans `FAILURE_OUTCOMES` and emails about it (`alerts.py:1001`, `:1457-1470`). `recent_failures` (`email.py:2013`) and `/tech/email` surface the rows. Nothing re-sends.

`_close_record` failing leaves the row in `queued`, which `FAILURE_OUTCOMES` treats as a failure (`email.py:957-971`).

One failing sweep does not stop the others (`scheduling.py:1550-1551`, `:1561-1567`): each is recorded as `failed` rather than as a sweep that found nothing.

### B2b. The Cloud Functions email system — `functions/src/index.ts`

Separate provider instance: `require('@sendgrid/mail')` (`index.ts:4`), key `SG_MAIL_KEY`, hardcoded sender `{ email: '314zipper@gmail.com', name: 'Zipper Team' }` (`index.ts:46`). Inline HTML strings, no template library, **no delivery record of any kind**.

| # | trigger | recipient | subject |
|---|---|---|---|
| 1 | `weeklyPayoutReportGenerator`, Sunday 23:59 IST (`index.ts:931`, `:1493`) | `superadminEmail` | `Zipper Weekly Payout Report — {week} — commission accrued` / `— ACTION NEEDED: commission did NOT accrue` / `— {n} agency(ies) NOT accrued` (`:1486-1490`) |
| 2 | `onAgencyApproved`, `agencies/{id}` onUpdate (`:1762`, `:1882`) | agency `ownerEmail` | `🎉 Your agency is approved — Log in to Zipper Live!` |
| 3 | `onAgencyRegistered`, `agencies/{id}` onCreate (`:2376`, `:2449`) | agency `ownerEmail` | `✅ Registration received — {agencyName} \| Zipper Live` |
| 4 | `onSellerRegistered`, `sellers/{id}` onCreate (`:2480`, `:2547`) | seller email | `✅ Application received — Zipper Coin Seller` |
| 5 | `onSellerApproved`, `sellers/{id}` onUpdate (`:2559`, `:2664`) | seller email | `🎉 You're approved — Start selling Zipper coins!` |
| 6 | `onAgencyResendEmail` — CRM sets `_resendEmail = 'registration'` (`:2678`, `:2733`) | agency | `✅ Registration received — {agencyName} \| Zipper Live` |
| 7 | `onAgencyResendEmail` — `_resendEmail = 'approval'` (`:2770`) | agency | `✅ Your agency "{name}" is approved — Log in now \| Zipper Live` |
| 8 | `onSellerResendEmail` — `'registration'` (`:2782`, `:2836`) | seller | `✅ Application received — Zipper Coin Seller` |
| 9 | `onSellerResendEmail` — `'approval'` (`:2873`) | seller | `🎉 You're approved — Start selling Zipper coins!` |

#1 has one more quirk: ten subject lines of this report use `ALL CAPS` and emoji, which the backend's own `subject_problems()` linter (`email.py:1339-1364`) exists to catch. The linter runs over the backend catalogue only.

`signInHint(uid)` (`index.ts:1746-1760`) reads Firebase Auth providers so an approval email does not tell a Google-signup partner to use a password that does not exist. Falls back to a neutral sentence on any error — "an Auth outage must not stop an approval email going out."

#### Retry and failure — Cloud Functions email
**`sendMail` is fail-open on configuration and fail-loud on provider error.** If `SG_MAIL_KEY` is unset it logs an error and **returns successfully** (`index.ts:38-41`) — the caller cannot tell. On a provider error it logs and **rethrows** (`:51-54`).

Each caller handles that differently. #1 catches and logs (`index.ts:1494-1496`) — the report is lost. The resend functions (#6–#9) **delete `_resendEmail` before sending** (`index.ts:2688`), so a throw loses the request entirely and it must be re-triggered by hand.

**#6–#9 ARE the retry mechanism** for #2–#5 — a manual one, invoked by a CRM staff member setting a field. There is no automatic retry, no delivery record, and no way to know a send failed other than reading function logs.

### B2c. The broadcast email composer — `backend/app/services/broadcast.py`

Four audiences (`broadcast.py:124-145`): `all_agencies`, `all_sellers`, `all_users`, `person:<email>`.

Audit action `broadcast.email_sent` (`broadcast.py:94`) — a local `class Action` with a docstring explaining that `core/audit.py` has no entry for sending mail (`:87-89`).

`AudienceUnresolved` (`:106-113`) is raised **before** the audit entry, specifically to avoid a partial send that nobody can account for afterwards. Authority is per-audience (`authority_for`, `:265`), and `check_authority` (`:289`) refuses machine credentials outright (`:300`) — a broadcast must name a human in the audit log.

---

## B3. IN-APP

### The top-level `notifications` collection — written by four paths, read by nothing

| # | writer | trigger | `type` | recipient field | title |
|---|---|---|---|---|---|
| 1 | `index.ts:1644-1652` | recharge transfer succeeded | `recharge_approved` | `targetUid` | `Recharge Approved!` |
| 2 | `index.ts:1692-1702` | recharge transfer failed | `recharge_delayed` | `targetUid` | `Your recharge is taking longer` |
| 3 | `index.ts:1783-1791` | agency approved | `agency_approved` | `targetUid` | `Agency Approved!` |
| 4 | `index.ts:2065-2075` | weekly payout approved, once per agency not once per host (`:2053`) | `payout_approved` | `targetUid` | `Payout Approved ✅` |

All four write `isRead: false`, `createdAt`, and a correlating id (`rechargeRequestId`, `agencyId`, `weekLabel`).

**Two reasons nothing can read them.**

1. **No reader exists.** `grep` for the collection across `zipper-app/app/src`, `zipper-crm/app`, `zipper-crm/lib`, `zipper-crm/components` and `functions/src` returns only these four writes. The Android app has no notifications screen or repository for it.

2. **The security rule reads a different field.** `firestore.rules:2510` gates user reads on `resource.data.userId == request.auth.uid`. All four writers set **`targetUid`**, never `userId`. Even if a reader were added, every document would be denied to its own recipient — only `isAdmin()` could read them.

`isRead: false` is therefore written by four paths and flipped by none.

### The per-user subcollection `users/{uid}/notifications`

One writer: `respondToTicket` (`zipper-crm/lib/firestore.ts:862-867`) — `{type: 'support_reply', message, timestamp, read: false}`.

**Also has no reader**, and the code says so at `firestore.ts:846-849`: "`users/{uid}/notifications` has no reader in the Android app either. It is written because removing it would lose the record, not because anything sees it."

Note the field names differ from the top-level collection again: `message`/`timestamp`/`read` here vs `body`/`createdAt`/`isRead` there. Three shapes for one concept.

### `broadcasts` — works, after a field-name fix

- **Writer:** CRM `/broadcasts` → `firestore.ts:993` onwards. Rule: `isAdmin() || isMarketing()` (`firestore.rules:2506`).
- **Reader:** Android `ChatRepository.broadcastsFlow` (`ChatRepository.kt:26`, `:189`) → `MessagesViewModel` → `BroadcastsTab` (`MessagesScreen.kt:88`). Rule: any signed-in account (`firestore.rules:2505`).
- **Shape:** `title`, `body`, `imageUrl`, `targetGender`, `senderName`, `createdAt` (`BroadcastRecord` at `firestore.ts:980-989`).

The CRM used to write `message`; the app has only ever read `title`/`body`, so **every broadcast ever sent rendered as an empty card** — an OFFICIAL chip, a timestamp, two blank lines (`firestore.ts:956-978`). The writer was fixed rather than the reader because a writer change ships with a CRM deploy while a reader change waits on an APK release "that the people already holding the old build will never get." Both sides now read `body ?? message`.

`targetGender: 'all'` is written but filters nothing (`firestore.ts:1017-1020`) — it records intent without claiming a filter that does not exist.

### `announcements` — NOT FOUND as implemented

`firestore.rules:2566-2569` declares it: read any signed-in account, write `isAdmin()`. **No reader and no writer exist** in any of the four codebases. The two matches for the word are UI copy on the broadcasts page (`zipper-crm/app/broadcasts/page.tsx:89`, `app/page.tsx:515`) describing the `broadcasts` feature.

### `adminAlerts` — one writer, no reader

`index.ts:1706-1714`, on recharge transfer failure: `{type: 'recharge_transfer_failed', severity: 'warning'|'critical', message, rechargeRequestId, buyerUid, sellerUid, diamondPackage, amountPaid, resolved: false}`. The comment at `:1704-1705` says "Ops needs this in the alert stream, not only in the logs."

**There is no alert stream.** No rule in `firestore.rules`, so every read falls to the catch-all deny. The only other reference is the reset script (`backend/scripts/reset_test_data.py:160`). `resolved: false` is written and never flipped.

### `/alerts` and `/tech/*` in the CRM
These read the **Mongo** alert/delivery/run stores over the API (`zipper-crm/app/alerts/page.tsx:277-279`, `tech/email/page.tsx:409-414`, `tech/jobs/page.tsx:353-355`), gated by `_require_oversight` (`backend/app/routers/notifications.py:61`). Owners, Finance admin and the observer. Unconnected to any Firestore notification collection.

---

## SMS — NOT FOUND
No Twilio, MSG91, Textlocal, Gupshup or any SMS provider. No `sendSms`/`send_sms`. The only hits are vendored Google API discovery JSON inside `backend/.venv/`. Firebase Phone Auth delivers its own OTP SMS for sign-in, but that is Firebase's channel, not one this system sends on; `functions/src/phone.ts` is purely E.164 key normalisation (`:47-60`).

## WhatsApp — NOT FOUND
No WhatsApp Business API, no `wa.me`, no WATI/Interakt. One code comment notes that referral codes are "printed, forwarded on WhatsApp and typed" by humans (`backend/app/services/partner_ops.py:1233`) — a remark about how codes travel, not an integration.

---

# PART C — AUDIT

## `backend/app/core/audit.py` — the central registry

**Append-only by construction.** `audit.py:7-8`: "Nothing in this module updates or deletes. There is deliberately no such function — not even for owners." The module exposes `record`, `query` and `history_for` and nothing else.

### The record shape — `_entry()` (`audit.py:203-253`)

| field | content |
|---|---|
| `at` | `datetime.now(timezone.utc)` |
| `actor.uid` | |
| `actor.name` | |
| `actor.role` | |
| `actor.team` | |
| `actor.is_system` | boolean, present and true only for a machine, "so an owner reading the log can filter on one field instead of pattern-matching a uid" (`:242-244`) |
| `action` | one of the names below |
| `subject.type` | e.g. `card`, `user`, `staff`, `report`, `host_application`, `owner_capital`, `expense` |
| `subject.id` | |
| `before` | arbitrary, usually `{"stage": ...}` or `{"isHost": ..., "agencyId": ...}` |
| `after` | arbitrary |
| `reason` | **mandatory** — `record()` raises `ValueError` on empty (`:275-276`, "Spec 6.1.4") |
| `card_id` | optional cross-link to the money board |
| `meta` | dict, defaults `{}` |

**No `request_id`, no IP, no user agent, no trace id.** The actor block is the only provenance.

**System-actor discipline** (`audit.py:32-36`, `:218-233`): a system actor must have a name and a uid beginning `system:`, or the write is refused rather than producing an entry that reads as a person. Conversely the prefix is reserved — a human actor carrying it is refused.

**Transactional atomicity is opt-in.** `record(session=...)` (`:267`): "Pass the `session` of the transaction performing the change. Without it the entry is not atomic with the change, which defeats the point — so callers that mutate money must always pass one." The parameter has no default enforcement; a caller that forgets it gets a non-atomic entry silently.

**Read scoping** (`query`, `:293-328`): `all` (owners, observer), `team` (`actor.team` match), `self` (`actor.uid` match). System entries behave like any other — `team` does not see them because a machine has no team (`:304-308`).

`history_for(subject_type, subject_id)` (`:331`) is the "reconstruct what happened to this account" query.

---

## Every audit event name, grouped by area

### In `core/audit.py` (`class Action`, `:39-200`) — 62 names

**Money (18):** `balance.credit`, `balance.debit`, `inventory.credit`, `inventory.debit`, `lending.issue`, `lending.repay`, `lending.recover`, `lending.write_off`, `commission.accrue`, `commission.accrue_refused`, `commission.pay`, `payout.execute`, `withdrawal.pay`, `refund`, `expense.raised`, `expense.paid`

**Cards (6):** `card.raised`, `card.verified`, `card.signed`, `card.rejected`, `card.executed`, `card.execution_failed`

**Partners (3):** `partner.approved`, `partner.rejected`, `partner.deactivated`

**Users (18):** `user.banned`, `user.unbanned`, `user.suspended`, `user.resumed`, `user.warned`, `host.granted`, `host.revoked`, `host.application_approved`, `host.application_rejected`, `host.pending_changes_applied`, `host.pending_changes_rejected`, `host.verification_approved`, `host.verification_rejected`, `user.seller_granted`, `user.seller_revoked`, `balance.change_requested`

**Devices and moderation (3):** `device.banned`, `device.unbanned`, `report.actioned`

**Partner operations (5):** `partner.reactivated`, `partner.email_normalised`, `sale.recorded`, `sale.approved`, `subagency.paid_parent`, `subagency.parent_paid_sub`

**Configuration (2):** `rate.changed`, `config.changed`

**Access (11):** `staff.created`, `staff.role_changed`, `staff.deactivated`, `staff.employment_changed`, `staff.mirror_failed`, `staff.mirror_repaired`, `staff.firebase_revoke_failed`, `login.succeeded`, `login.failed`, `export`

### Declared in `core/audit.py` but written from a duplicate local enum — 5 names

`partner.reactivated`, `sale.recorded`, `sale.approved`, `subagency.paid_parent`, `subagency.parent_paid_sub` have **zero `audit.Action.*` call sites**. They are written via `partner_ops.Act` (`partner_ops.py:77-81`), which collides with `audit.Action` **by value** on all five. The same hazard that `users.py:152-166` documents having removed — "the log was written from two enumerations that happened to agree, and the next person to add a value to one of them would have found out they disagreed by reading `/audit`" — is still present in `partner_ops.py`.

### Declared only in local `Act` classes — 31 more names, never in the central registry

| area | names |
|---|---|
| `partner_ops.py:73-112` | `partner.created`, `partner.second_role_requested`, `partner.second_role_approved`, `partner.second_role_rejected`, `partner.van_issued`, `partner.van_not_issued`, `partner.pending_changes_applied`, `partner.pending_changes_rejected`, `partner.login_attached` |
| `appeals.py:101-105` | `appeal.upheld`, `appeal.overturned` |
| `chance.py:273-300` | `chance.mechanic_created`, `chance.stake`, `chance.payout`, `chance.round_recorded`, `chance.round_void`, `chance.client_claim_ignored`, `chance.external_settlement`, `chance.ceiling_breached`, `chance.mechanic_suspended`, `chance.mechanic_resumed`, `chance.player_frozen`, `chance.player_unfrozen` |
| `player_protection.py:297+` | `protection.limit_set`, `protection.limit_increase_scheduled`, `protection.self_excluded`, `protection.self_exclusion_extended`, `protection.exclusion_lift_requested`, `protection.exclusion_lift_decided`, `protection.cooling_off_started`, `protection.play_blocked`, `protection.session_reminder`, `protection.harm_pattern_flagged`, `protection.harm_pattern_reviewed` |
| `live.py:65-76` | `live.room_ended`, `live.host_muted`, `live.host_unmuted` |
| `broadcast.py:84-94` | `broadcast.email_sent` |

`expenses.py:156-160` is the correct pattern: `class Act` aliases `audit.Action.EXPENSE_RAISED` rather than restating the string.

The CRM's audit filter chips (`zipper-crm/app/audit/page.tsx:20-27`) cover 6 groups and 38 action strings. The ~55 names above that are not in those chips have no filter — notably every `chance.*`, every `protection.*`, every `appeal.*`, `user.suspended`/`user.resumed`, all four `host.application_*`/`host.verification_*`, `device.banned`/`device.unbanned`, `report.actioned`, `lending.write_off`, `commission.accrue`, `expense.raised`/`expense.paid`, `subagency.*`, `broadcast.email_sent`.

---

## Money and permission actions that produce NO audit record

### 1. `rate.changed` and `config.changed` are read-only actions

Both are declared (`audit.py:164-165`) and **written by nothing**. The only references in the backend are reads:
- `alerts.py:336` — the `bank_details_changed` detector queries for them
- `reports.py:2619` — a report action filter
- `chance.py:285` — an alias

Meanwhile the configuration that matters is edited by direct browser writes to Firestore with no audit at all:
- **`appConfig/paymentCredentials`** — `zipper-crm/lib/appConfig.ts:62`, `setDoc(doc(db,'appConfig','paymentCredentials'), ...)`. `firestore.rules:2537-2538` describes this document as "the company bank account and Binance UID that every coin seller in the country pays into," and `:2543-2547` explains it was narrowed to superadmin because any department admin "could silently redirect all incoming revenue to another account. Finance would keep approving the payments because the screenshots still look valid."
- **`appConfig/economy`** — the commission slab table, bean rate and diamond price the backend reads to compute what every agency is owed (`firestore.rules:2552-2558`). Tech + owner writable.
- `appConfig/currencySettings` (`appConfig.ts:31`), `appConfig/dailyRewards` (`:97`), `appConfig/profileOptions` (`:270`), `appConfig/control` (`tech/appcontrol/page.tsx:103`).

**Consequence:** the `bank_details_changed` alert — spec 8A.4.1, **critical**, to owners and the observer, with a threshold of "there is no amount below which this is uninteresting" (`alerts.py:1325-1329`) — reads an action nothing writes. Its whole purpose is stated at `alerts.py:358-364`: "A changed beneficiary account is how a payout run is diverted, and it is cheap to verify and expensive not to." It cannot fire. Redirecting the company's incoming revenue account produces no audit entry and no alert.

### 2. Withdrawal decisions — no audit, and no actor on the document either

`approveWithdrawal`, `markWithdrawalPaid`, `rejectWithdrawal` (`zipper-crm/lib/firestore.ts:560-594`) are browser `updateDoc` calls. No Mongo audit entry. And all three write the literal `processedBy: 'Admin'` (`:564`, `:582`, `:592`) — not the actor's uid, not their name. The document itself does not record who.

`firestore.rules:2598-2599` asserts "approving records a decision, and the money itself moves as a signed card on the money board." The card path does audit (`audit.Action.WITHDRAWAL_PAY` at `partner_ops.py:4840`). But the two are unconnected: nothing links `withdrawalRequests/{id}.status: 'paid'` to a `host_withdrawal` card, so a request marked paid with no card behind it is indistinguishable from one with.

### 3. Salary request decisions — no audit, no actor, no reason

`agencies/[id]/salary/Client.tsx`: approve writes `{status, approvedAt}` (`:116-118`); mark-paid writes `{status, paidAt, utrNumber}` (`:129-131`); reject writes `{status}` alone (`:155`). `handleMarkDistributed` writes `{status, distributedAt}` (`agency-dashboard/page.tsx:2182-2185`).

A host's salary is approved and paid with **no record anywhere** of who decided it or why. Contrast `cards.py:371` — a card rejection without a reason is refused outright.

### 4. Coin purchase rejection — no audit

`rejectCoinPurchase` (`zipper-crm/lib/coinPurchases.ts:112-123`) writes `status`, `rejectedReason`, `approvedBy`, `approvedAt`. It does capture an actor uid in `approvedBy` (better than the withdrawal path) but writes no audit entry. The symmetric *approval* was deliberately moved to the audited card board (`coinPurchases.ts:88-110`); the rejection was not.

### 5. Recharge approval — real value moves, nothing is audited

`onRechargeApproved` (`functions/src/index.ts:1545`) decrements seller `coinBalance` and increments buyer `diamonds` inside a transaction (`:1622-1630`). The approval itself is a one-field Firestore update from the seller's phone: `SellerDashboardScreen.kt:453`, `.update("status","approved")`.

Trail: a `diamondTransactions` row on the buyer (`index.ts:1633-1640`) and a `totalCoinsSold` increment. No Mongo audit entry, no `inventory.debit`, no `balance.credit`, no actor, no reason. A Cloud Function cannot reach Mongo — `users.py:1296-1300` makes exactly this argument about host decisions ("a function cannot write the append-only Mongo trail that `/audit` reads. A decision about whether somebody may earn on this platform, recorded somewhere no owner ever looks, is the same failure in a different collection") and the recharge path is the same failure, unaddressed.

### 6. Device bans from the CRM bypass the audited path

`backend/app/services/users.py` has `ban_device` (`:2227`) and `unban_device` (`:2350`) writing `device.banned` / `device.unbanned` with before/after and a mandatory reason.

`zipper-crm/lib/operations.ts:125-155` has a parallel browser implementation. `banDevice` writes `bannedDevices/{deviceId}` directly with `{deviceId, deviceType, reason, userUids, bannedBy, bannedAt, isActive: true}` — no audit. `unbanDevice` **deletes the document** (`:153-154`), so the ban history is destroyed rather than recorded; the comment at `:143-152` explains this is because both Android read paths check only `snap.exists()`.

`audit.py:139-143` states a device ban deserves its own entry "because barring a handset locks out EVERY account on it, including accounts nobody has decided anything about" and that `meta.source` is "what decides, later, whether an unban may lift it." The CRM path writes neither the entry nor `meta.source`.

### 7. CRM role and partner-login grants

`zipper-crm/lib/auth.ts:1326` and `:1392` — `updateDoc(doc(db,'crmUsers',crmUid), {status:'approved'})`. A CRM account's approval, written from a browser, with no audit entry.

`partner_ops._mirror_login_status` (`:1397-1450`) writes `status` and `isActive` onto the `crmUsers` document from the server side; the browser path above has no counterpart entry.

`staff_access_changed` (8A.4.8, owners + observer) watches `staff.role_changed` and `staff.deactivated` in the Mongo log (`alerts.py:843`, `:1420-1429`). A `crmUsers` status flip from the browser is outside that log, so it is outside the alert.

### 8. `payoutHold` has no writer — so nothing to audit, and no way to hold a payout

Covered in §1. Read in four places, written in zero. The one control that stops a host being paid cannot be applied, so the question of auditing it does not arise.

### 9. Chance, protection, live and appeal entries are audited but unreachable in the CRM

Every name in the local-`Act` table above *is* written. But they are absent from the CRM filter chips (`audit/page.tsx:20-27`), so `chance.payout`, `chance.ceiling_breached`, `protection.play_blocked`, `appeal.overturned`, `live.room_ended` and the rest can only be found by scrolling the unfiltered list. For `chance.payout` in particular — a credit of value to a player — there is no way to ask "every chance payout this week."

### 10. `start_review` is logged as a verification

`cards.py:752` records the `requested → under_review` move under `audit.Action.CARD_VERIFIED`, the same action `verify()` writes (`:288`). Two different stage transitions, one action name. Separation of duties depends on knowing who verified a card; `/audit` filtered to `card.verified` returns both "started looking" and "checked and passed" with only the free-text `reason` to tell them apart.

### 11. Firestore-side value movement generally

`functions/src/gifts.ts` (24k), `wallet.ts` (27k), `calls.ts` (33k) and `party.ts` (60k) move diamonds and beans continuously. None can write Mongo. The trails are Firestore subcollections — `diamondTransactions`, `beanTransactions`, `liveRooms/{id}/gifts` — which `accounts.ts:141-144` retains forever as "the audit trail the business runs on." They carry no actor role, no reason, no before/after and no `card_id`, and they are not in `/audit`. `reconcile.py` and the nightly `scheduledReconciliation` job compare the Firestore economy against the Mongo ledger, which is the only bridge between the two records.