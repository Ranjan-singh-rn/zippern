# Zipper — Build Plan

**Sequence:** CRM backend → app changes → publish.
**Companion to:** `CRM-FLOW.md` (the specification). This is the order of work.
**Gap references** in brackets map to Part 10 of the spec.

---

## THE ARCHITECTURE DECISION

**Build a server layer on Cloud Functions. Do not rewrite the backend now.**

- A.1 The problems in Part 10 need a **server layer**, not a different database. Every one of them is solved by moving money and audit writes off the browser.
- A.2 You already have Cloud Functions deployed and the pattern proven — `onRechargeApproved` runs an atomic transaction correctly today. Extend it rather than replace it.
- A.3 A FastAPI + MongoDB migration is a two-to-three month detour that carries roughly 85% of the current problems across unchanged, because they are application-level, not database-level.
- A.4 You are recruiting agencies now. Migrating the datastore while onboarding partners is the worst possible timing.
- A.5 The migration option stays open. Once the server layer exists, every money path is behind a function, and swapping what sits behind that function becomes a contained project rather than an open-heart operation.
- A.6 **Rule from here on: the browser never writes money.** It calls a function. That single rule is what makes the audit log real (10.2).

---

## PHASE 1 — THE MONEY CORE
*Everything else depends on this. Nothing ships without it.*

### 1.1 Audit log
- Append-only collection. No update, no delete, enforced in rules — including for owners.
- Every entry: actor uid + name + role, server timestamp, collection and document touched, before → after values, mandatory reason, originating card id.
- Written **inside the same transaction** as the change it records. Both succeed or neither does.
- Closes: 10.1, 10.2

### 1.2 Money functions
Every balance mutation becomes a callable function. One entry point per operation:
- credit / debit user balance
- seller inventory credit / debit
- lending, repayment, recovery
- commission accrual and payout
- host withdrawal
- payout report execution

Each function: validates the caller's role, validates the amount, writes the balance change and the audit entry atomically, returns a result the UI can show.
- Closes: 10.1, 10.2, 10.3

### 1.3 Lock the rules
Only **after** 1.2 is live and the CRM calls it: remove browser write access to `diamonds`, `beans`, `coinBalance`, `commissionBalance`.
- Doing this before 1.2 breaks the live CRM. It is the last step of Phase 1, not the first.

### 1.4 Verification
- Every existing money path in the CRM is re-pointed at a function.
- Confirm no page still writes a balance directly.
- Confirm audit entries appear for every action.

**Phase 1 delivers:** money cannot move without a record, and the record cannot be bypassed.

---

## PHASE 2 — FIX THE BROKEN FLOWS
*These are live defects. They can start in parallel with Phase 1.*

### 2.1 Payout ledger — highest priority in the entire plan
- Call earnings and live-room gift earnings currently raise `beans` but write **no** `beanTransactions` record.
- The weekly payout sums `beanTransactions`. So those earnings are invisible to payout and **hosts are underpaid**.
- Fix: every bean credit writes a transaction record, from every source.
- **Ship this before the first agency onboards.** Underpaying hosts in week one ends the agency relationships you are recruiting on.
- Closes: the payout half of 10.7

### 2.2 Seller inventory
- Approving a sale does not decrement `coinBalance`, and `totalCoinsSold` is never written.
- Fix: sale approval debits inventory inside the same transaction.
- Without this you cannot answer what any seller holds or owes.
- Closes: 10.6

### 2.3 Payout report shape
- The Cloud Function writes one document per week for all agencies; `lib/finance.ts` expects one per agency.
- Two Finance pages read undefined fields today. The host breakdown modal queries a top-level collection while the function writes a subcollection.
- Fix: settle on one shape — the function's — and correct the readers.
- Closes: 10.7

### 2.4 Report actions execute
- Choosing "ban user" on a report writes a text label and bans nobody.
- Fix: the action executes from the report, logged, with the report linked to the outcome.
- Closes: 10.12

### 2.5 One definition per figure
- Revenue, payout and margin each get a single definition used everywhere.
- Closes: 10.7

**Phase 2 delivers:** the numbers are correct and the buttons do what they say.

---

## PHASE 3 — PARTNER VISIBILITY
*Independent of Phases 1–2. Cheap, high value, run it in parallel.*

### 3.1 Agency commission ledger
- Live balance: earned, paid, outstanding.
- Full ledger: every credit with the host and period that produced it, every payment with date and reference.
- Per-host performance.
- Read-only screens over data that already exists.
- **This is your entire competitive pitch to the agencies you are recruiting** (spec 0.2). It is a few days of work.
- Closes: 10.14

### 3.2 Seller ledger
- One reconciled view: bought, lent, sold, paid, outstanding.
- Credit standing and due dates.
- Closes: 10.16 (partial — recovery mechanics come in Phase 5)

### 3.3 Export and date filtering
- Every list exports to spreadsheet, respecting filters.
- Date range on every money view.
- Closes: 10.8, 10.9, 10.25

**Phase 3 delivers:** partners can see their own money, and Finance can get data out.

---

## PHASE 4 — THE WORK SYSTEM

### 4.1 Approval cards
- Card model and the five stages: Requested → Under Review → Awaiting Sign-off → Approved → Executed.
- Verification step and notes.
- Owner signature, bulk sign for verified cards.
- Self-approval prevention (spec 5.5).
- Approved and Executed separated so a failed transfer is visible.

### 4.2 Inbox
- "Waiting on you" across every board, one place.
- Team admin sees their team; owner sees their signature queue.
- Closes: 10.10

### 4.3 Ageing
- Every card carries an age; breach flags visibly.
- Closes: 10.11

### 4.4 Ticket dependencies
- Blocked-by links, and "what my team is blocking for others".
- Closes: 10.13

**Phase 4 delivers:** teams self-manage and nobody hunts for work.

---

## PHASE 5 — GOVERNANCE AND CREDIT

### 5.1 Observer role
- Read everything, write nothing, enforced in rules. Export allowed and logged.
- Cheap once the audit log exists.

### 5.2 Audit views
- Filter by person, team, date, action type, amount.
- Owners see each other; admins see their team.

### 5.3 Seller credit lifecycle
- Due dates, overdue state, auto-block on new inventory, recovery from balance with penalty, write-off as an explicit owner decision.
- Closes: 10.16

### 5.4 Real permissions or remove them
- Either enforce the permission array or delete it. A control that does nothing is worse than no control.
- Closes: 10.3

**Phase 5 delivers:** the governance model in the spec actually operates.

---

## PHASE 6 — REPORTING AND EMAIL

### 6.1 Transactional email
- The thirteen events in spec 8A.2. Rejections carry reasons.
- Delivery tracked; failures raise exceptions.
- Closes: 10.22, 10.26

### 6.2 Scheduled reports
- Daily business summary and Finance worklist. Weekly business review, payout run, **agency and seller statements sent to partners**. Monthly P&L, partner statements, accounting pack, audit summary.
- Generated server-side from the ledger.
- Closes: 10.20, 10.21, 10.23

### 6.3 Alerts
- The nine immediate alerts in spec 8A.4.
- Closes: 10.24

**Phase 6 delivers:** nobody has to remember to check anything.

---

## PHASE 7 — COLLECTIONS
*Blocked on the business current account. Start the account opening now, in parallel with Phases 1–4.*

### 7.1 Business account
- Company entity, three owners' shareholding documented (spec 8C.9).
- Prerequisite for everything below and for gateway onboarding.
- Typically a few weeks. **Start it now** — it is calendar time, not work.

### 7.2 Virtual accounts — HDFC eCMS
- VAN per seller: HDFC prefix + existing seller CRM ID.
- Bank webhook identifies the payer; cards arrive auto-verified.
- Removes the largest manual workload in Finance.
- Closes: 10.17a

### 7.3 Reconciliation
- Daily statement import, automatic matching, exception queue, daily cash position.
- Closes: 10.17b, 10.5, 10.4

### 7.4 Treasury structure
- Collections, payouts, operating, tax reserve. Inter-account movement logged.
- Closes: 10.17c

### 7.5 Payment gateways
- Razorpay / Stripe. Seller top-up and **direct user purchase**.
- Per-country method toggles.
- Chargeback monitoring from day one.
- Closes: 10.17, 10.18, 10.39

**Phase 7 delivers:** money arrives identified, reconciles itself, and the direct channel opens at full margin.

---

## PHASE 8 — APP CHANGES
*Starts once Phase 1 defines the contracts. This is where the app work lands.*

### 8.1 Server-side RNG
- Lucky gift outcomes and game settlement move to the server.
- The client receives a result; it never decides or reports one.
- **No chance mechanic ships before this.** A modified app currently decides its own payout.
- Closes: 10.27, 10.28, 10.29

### 8.2 Server-side rewards
- Daily rewards, bean conversion, gaming winnings, lucky payback all credited by function.
- Closes: 10.18 (rewards half), and the self-mint hole rules cannot close

### 8.3 Fix the lucky gift curve
- Multiplier applies to total stake, not unit stake.
- Effective RTP flat or improving as stake rises — currently 58% at single, 13% at 77×.
- Closes: 10.30

### 8.4 Ban enforcement
- CRM-issued device bans currently never reach the app; unban never restores access.
- Closes: the enforcement half of 10.12

### 8.5 Config the app actually reads
- Packages, daily rewards, profile options are edited in the CRM and ignored by the app.
- Either wire them up or remove the screens. Staff must not believe they changed something that did nothing.
- Closes: 10.14 (config), 10.15

### 8.6 Level bonuses
- Advertised to users, never granted. Grant them or stop showing them.
- Closes: 10.15

**Phase 8 delivers:** the app and the portal agree, and the economy is not forgeable.

---

## PHASE 9 — GAMES
*Last. Needs Phase 8.1 and Phase 4.*

- Game catalogue, RTP configuration, odds tables, stake tiers.
- Exposure ceilings and auto-suspend.
- Actual vs theoretical RTP monitoring.
- Player protection: loss limits, self-exclusion, cooling-off.
- Per-country enablement.
- Events calendar, rotation, free daily entries.
- Closes: 10.31 – 10.40

---

## CRITICAL PATH

```
Phase 1 (money core) ──┬── Phase 4 (work system) ── Phase 5 (governance)
                       │
                       ├── Phase 8 (app changes) ── PUBLISH
                       │
Phase 2 (broken flows)─┘

Phase 3 (partner visibility) ── independent, start immediately
Phase 6 (reporting) ── needs 1, otherwise independent
Phase 7 (collections) ── blocked on business account, start account now
Phase 9 (games) ── needs 8.1
```

**Run in parallel from day one:** Phase 3 (partner visibility) and the business account application in 7.1. Neither blocks on anything.

---

## MINIMUM TO PUBLISH

If the goal is shipping, this is the floor:

1. **2.1 — payout ledger.** Hosts must be paid correctly or the agencies leave.
2. **2.2 — seller inventory decrement.** Otherwise you cannot tell who owes you what.
3. **3.1 — agency commission ledger.** It is the pitch, and it is read-only screens over existing data.
4. **8.1 — server-side RNG**, if any chance mechanic is live at launch.
5. **1.1 — audit log.** Not strictly required to function, but every month shipped without it is a month of history you can never reconstruct.

Everything else can follow publication.

---

## WHAT I WOULD NOT DO

- **Do not migrate the database now.** It delays shipping, carries 85% of the problems across, and does it while you are onboarding partners.
- **Do not ship games before 8.1.** The outcomes are currently decided by the phone.
- **Do not build Phase 7 before the business account exists.** The work would be wasted.
- **Do not defer 2.1.** Every week it runs is a week of hosts being underpaid, and it is not recoverable once agencies have left.
