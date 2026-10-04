# Zipper Business Portal — Complete Operating Flow

**What this is:** one system serving two purposes — your **business portal** (people, partners, money, governance) and your **app admin portal** (content, economy, configuration, moderation).

**Status:** Recommended design. Every point numbered. Reject or change any point by its number.

---

# PART 1 — WHO EXISTS

### 1.1 Observer (1 person)
Sees the entire business. Writes nothing.

- 1.1.1 Reads every page, record and audit entry.
- 1.1.2 Sees cards **in flight** — pending, under review, rejected — not just finished ones.
- 1.1.3 Sees all money: revenue, payouts, commission, seller ledgers, outstanding credit.
- 1.1.4 Has no action buttons anywhere.
- 1.1.5 **Can export.** An auditor who cannot take data out cannot audit. Exports are logged.
- 1.1.6 Read-only enforced in database rules, not just hidden in the interface.

### 1.2 Business Owner × 3 (superadmin)
Final authority. Every monetary movement ends with one of you.

- 1.2.1 Signs off on all money after a team has verified it.
- 1.2.2 Sees each other's actions in full — who, when, what, why.
- 1.2.3 Configures anything: economy, pricing, roles, policies, app control.
- 1.2.4 Cannot sign a request they raised themselves (5.5.3).

### 1.3 Team Admin (one per department)
Runs their department. Verifies. Does not sign money.

- 1.3.1 Owns their department's board end to end.
- 1.3.2 Verifies monetary requests before they reach owners.
- 1.3.3 Invites, edits and deactivates their own team members.
- 1.3.4 Sees their team's workload, ageing items and throughput.
- 1.3.5 Approves all **non-monetary** work in their domain without escalation.
- 1.3.6 Cannot approve money. Verification is not approval.

### 1.4 Team Member
- 1.4.1 Works their own queue.
- 1.4.2 Raises monetary requests; never verifies or approves them.
- 1.4.3 Sees their team's board and their own assigned items.

### 1.5 Departments
| Team | Owns |
|---|---|
| 1.5.1 **App** | Users, hosts, agencies, KYC, policies |
| 1.5.2 **Ops** | Reports, device bans, feedback, coin sellers, live moderation |
| 1.5.3 **Finance** | Cash in, cash out, payouts, withdrawals, economy rates, pricing |
| 1.5.4 **Tech** | App content, app config, app control, engineering tickets |
| 1.5.5 **Support** | End-user tickets, routing |
| 1.5.6 **Marketing** | Broadcasts, campaigns, promotions |

### 1.6 External accounts
- 1.6.1 **Agency (main)** — recruits hosts, earns commission, may create sub-agencies.
- 1.6.2 **Sub-agency** — created by a main agency, recruits its own hosts, earns its own commission.
- 1.6.3 **Coin Seller** — buys diamond inventory, resells to users.
- 1.6.4 **Host** — a user recruited by an agency; earns beans.

---

# PART 2 — LOGIN AND SESSION

### 2.1 Account creation
- 2.1.1 Internal staff are invited, never self-registered.
- 2.1.2 Invitation creates the account with a temporary password and emails a "set your password" link.
- 2.1.3 The inviter never sees or sets the password.
- 2.1.4 Every account records name, email, phone, role, department, reports-to, and creator.

### 2.2 Login
- 2.2.1 Email + password, one login page for everyone.
- 2.2.2 Role is read on success and determines routing.
- 2.2.3 Deactivated accounts are rejected with a clear message.
- 2.2.4 Deactivation mid-session logs the person out on their next action.

### 2.3 Landing page by role
| Role | Lands on |
|---|---|
| 2.3.1 Observer | Business overview |
| 2.3.2 Owner | Sign-off queue |
| 2.3.3 Team Admin | Their department board |
| 2.3.4 Team Member | Their assigned work |
| 2.3.5 Agency / Sub-agency | Agency portal only |
| 2.3.6 Coin Seller | Seller portal only |
| 2.3.7 Pending partner | Holding page until approved |

- 2.3.8 External accounts can reach no internal page, enforced by rule.

### 2.4 Session
- 2.4.1 Navigation shows only what the role can use.
- 2.4.2 Role resolves before any privileged content renders.
- 2.4.3 Sign-out always available.

---

# PART 3 — INTERNAL DAILY FLOW

### 3.1 Observer
- 3.1.1 Opens to: cash in, cash out, outstanding liability, open queues by team, ageing items.
- 3.1.2 Drills into any record, partner ledger or audit entry.
- 3.1.3 Filters the audit log by person, team, date, action type, amount.
- 3.1.4 Sees rejected and abandoned requests with reasons.
- 3.1.5 Exports any view.

### 3.2 Business Owner
- 3.2.1 Opens to **Awaiting Sign-off** — only team-verified cards.
- 3.2.2 Each card is decidable without leaving it (5.4).
- 3.2.3 Signs individually or bulk-signs verified cards; each logged separately.
- 3.2.4 Rejects with a mandatory reason; the card returns to the team.
- 3.2.5 Secondary views: audit log, all team boards, all configuration, all partner records.
- 3.2.6 Sees what the other two owners approved, when and why.

### 3.3 App team
- 3.3.1 **Queue:** pending agencies, pending KYC, host applications, flagged accounts.
- 3.3.2 Reviews agency applications, KYC documents, identity and bank details.
- 3.3.3 Approves or rejects partner onboarding — **team decision, no owner signature** (9.2).
- 3.3.4 Manages user accounts: ban, unban, warn, make/remove host.
- 3.3.5 Balance corrections are raised as cards, verified by Finance, signed by an owner.
- 3.3.6 Maintains legal policies.

### 3.4 Ops team
- 3.4.1 **Queue:** user reports, device ban requests, app feedback, pending coin sellers, live incidents.
- 3.4.2 Reviews reports and takes action directly from the report — the action executes there, not by hunting for the user.
- 3.4.3 Issues and lifts device bans, each with a reason and an actor.
- 3.4.4 Reviews coin seller applications and documents.
- 3.4.5 Monitors live rooms and intervenes on violations (8.7).
- 3.4.6 Escalates by moving the card, not by messaging.

### 3.5 Finance team
- 3.5.1 **Queue:** exceptions, host withdrawals, agency salary requests, weekly payouts, lending repayments.
- 3.5.2 **Most incoming payments verify themselves.** A seller transfer to their virtual account number is identified by the bank and auto-verified (8C.2); a gateway payment is proven by its settlement record. Neither needs a human.
- 3.5.3 Finance's real work is the **exception queue** (8C.3): amounts that match no pack, partial and over payments, unidentified credits, and mismatched sources.
- 3.5.4 For any residual manual transfer: opens the proof, checks the reference against the statement, confirms the amount, attaches notes, moves the card to Awaiting Sign-off.
- 3.5.5 System auto-flags a payment reference used before.
- 3.5.6 Runs daily reconciliation and resolves breaks the same day (8C.5).
- 3.5.7 Never releases money — owner signs, then execution happens.
- 3.5.8 Owns economy rates and pricing, submitted as cards for owner signature.
- 3.5.9 Maintains reconciliation: coins issued vs cash collected vs credit outstanding.
- 3.5.10 **Verifies the money facts on every card from every team** (9.3).

### 3.6 Tech team
- 3.6.1 **Queue:** engineering tickets, content requests, tickets routed from Support.
- 3.6.2 Manages all app content and configuration (Part 8).
- 3.6.3 Cosmetic changes are team decisions.
- 3.6.4 Anything altering what a user pays or earns becomes a card for owner signature.

### 3.7 Support team
- 3.7.1 **Queue — two kinds of ticket, one board:**
  - **App tickets** raised by end users from inside the app.
  - **Team tickets** raised by any department for any other department — internal work, blockers and dependencies.
- 3.7.2 Every ticket is tagged by source so a team can tell at a glance whether a user is waiting or a colleague is.
- 3.7.3 Replies to users; the user receives the reply in-app.
- 3.7.4 Routes anything not theirs to the owning team **and a named person**, with a note.
- 3.7.5 A routed ticket stays linked to the original so Support sees the outcome.
- 3.7.6 Anything involving money becomes a card and leaves the ticket board.

### 3.7A Dependencies between teams
- 3.7A.1 Any team can raise a ticket against any other team — this is how work crosses departments.
- 3.7A.2 A ticket can be marked **blocked by** another ticket. The blocked ticket cannot move to Done until its blocker closes.
- 3.7A.3 Both teams see the dependency on both cards, so neither side has to chase.
- 3.7A.4 A blocking ticket inherits the highest priority of anything it blocks.
- 3.7A.5 An admin sees, on their board, everything their team is blocking for others — this is the number that stops one team quietly stalling the business.
- 3.7A.6 An end-user ticket that turns out to need engineering becomes a team ticket linked to the original, so Support can still answer the user when it closes.

### 3.8 Marketing team
- 3.8.1 **Queue:** campaign requests, scheduled broadcasts.
- 3.8.2 Composes and sends broadcasts.
- 3.8.3 Anything with a monetary cost becomes a card for owner signature.

---

# PART 4 — EXTERNAL FLOWS

### 4.1 Agency (main)
- 4.1.1 Applies via public signup: company details, owner identity, KYC documents, bank details.
- 4.1.2 Lands on a holding page with visible application status.
- 4.1.3 App team reviews documents and identity.
- 4.1.4 App team approves; the account activates and can log in.
- 4.1.5 Agency receives a referral code.
- 4.1.6 Agency recruits hosts by sharing the code; each application appears in the CRM.
- 4.1.7 A host activates by entering the code in the app and is linked to the agency.
- 4.1.8 Commission accrues on host earnings per the slab table.
- 4.1.9 **Agency sees its own commission balance, ledger, host performance and payout history.**
- 4.1.10 Agency requests a payout.
- 4.1.11 Finance verifies against the ledger, owner signs, payment executes with UTR recorded.
- 4.1.12 Agency confirms receipt, closing the loop.
- 4.1.13 Deactivation is an App team decision and logs the agency out immediately.

### 4.2 Sub-agency
- 4.2.1 Created by a main agency from its own portal.
- 4.2.2 Requires **your** approval — a parent cannot approve its own sub-agency.
- 4.2.3 Once approved, recruits its own hosts and accrues its own commission.
- 4.2.4 **Money flows through the main agency, not around it.** The sub-agency's commission is calculated on its own slab table, then paid by you to the main agency, and the main agency pays the sub. The main agency is your counterparty and carries the responsibility.
- 4.2.5 The sub-agency's earning is calculated and shown separately even though it is paid via the parent — you always know what is owed to whom.
- 4.2.6 The system records both legs: your payment to the parent, and the parent's payment to the sub. A sub-agency payout is not closed until the second leg is confirmed.
- 4.2.7 If a parent does not pass money on, that shows as an unsettled second leg against the parent — visible to owners and the Observer.
- 4.2.8 There is exactly one debit path per sub-agency balance. It is never reduced twice for the same earning.
- 4.2.9 Parent sees its subs' status, headline performance and what it owes them. It does not see their private records.

### 4.3 Coin Seller
- 4.3.1 Applies via public signup with identity and KYC documents.
- 4.3.2 Holding page until approved.
- 4.3.3 Ops reviews and approves; the account activates.
- 4.3.4 **On approval the seller is issued a permanent virtual account number** (8C.1.4), shown in their portal.
- 4.3.5 Seller buys inventory: chooses a pack, transfers to their own virtual account number. The bank identifies them automatically — no proof to upload, no reference to type (8C.2).
- 4.3.6 The card arrives auto-verified. Owner signs, inventory credits, seller receives a receipt.
- 4.3.7 **Credit option:** you lend inventory, recorded as a debt with amount, date and due date. Owner signature required.
- 4.3.8 Seller sells diamonds to users and files a record of each sale.
- 4.3.9 Sale approval **debits the seller's inventory**.
- 4.3.10 Repayment arrives at the same virtual account number and is identified automatically; owner signs to close the debt.
- 4.3.10a One ledger per seller: bought, lent, sold, paid, outstanding.

**Recovery when credit is not repaid**
- 4.3.11 Every lending record carries a due date. Past it, the debt is **overdue** and the seller is flagged.
- 4.3.12 An overdue seller is automatically blocked from taking new inventory until cleared.
- 4.3.13 **You can recover directly from their balance.** A recovery card debits the seller's remaining inventory against the debt — up to and including their full balance.
- 4.3.14 **Recovery may exceed the original amount**, covering a late penalty or recovery cost. The penalty basis is set in economy config and shown on the card before signing.
- 4.3.15 Recovery requires owner signature like any other money movement, with the reason recorded.
- 4.3.16 If the balance does not cover the debt, the shortfall stays as an outstanding receivable against that seller — it is never silently written off.
- 4.3.17 Writing off a bad debt is an explicit owner decision with a reason, and appears in the audit log as a loss.
- 4.3.18 A seller's full credit history — lent, repaid, overdue, recovered, written off — is visible on their record and drives whether they get credit again.

### 4.4 Host
- 4.4.1 Becomes a host via an agency referral code, or by owner designation.
- 4.4.2 Earns beans from gifts and calls.
- 4.4.3 Beans are valued at the configured rate and become payable weekly.
- 4.4.4 A weekly payout report is generated per agency.
- 4.4.5 Agency reviews and submits it.
- 4.4.6 Finance verifies, owner signs, payment executes.
- 4.4.7 Host balances reset only **after** execution, never on approval alone.
- 4.4.8 A host sees their own earning history in the app.

---

# PART 5 — THE MONEY BOARD

### 5.1 Principle
Teams do the work. Owners sign. Nothing moves money without both.

### 5.2 Stages
| Stage | Who acts | What happens |
|---|---|---|
| 5.2.1 **Requested** | Anyone | Raised with a mandatory reason |
| 5.2.2 **Under Review** | Team Admin + Finance | Verification: bank check, proof, amount |
| 5.2.3 **Awaiting Sign-off** | — | Verified, waiting on an owner |
| 5.2.4 **Approved** | Owner | Signed, reason recorded |
| 5.2.5 **Executed** | System | Money actually moved |

- 5.2.6 Approved and Executed are separate. A failed execution leaves the card visibly stuck rather than silently lost.

### 5.3 What goes on this board
Balance credit/debit · seller coin purchases · diamond lending · lending repayment · **credit recovery and penalty (4.3.13)** · agency commission payouts · **sub-agency payouts, both legs (4.2.6)** · host withdrawals · agency salary requests · weekly payout reports · economy rate changes · **FX overrides per country (8.3A.6)** · pricing changes · any promotion with a monetary cost · **refunds and chargebacks (8.11.15)** · writing off bad debt.

- 5.3.1 **Bank-identified and gateway payments skip manual verification.** A transfer to a seller's virtual account number is proven by the bank (8C.2.4); a gateway payment is proven by its settlement record (8.11.11). Both carry an automatic verification stamp and go straight to Awaiting Sign-off — or auto-execute below an owner-set threshold.
- 5.3.2 Only exceptions and residual manual transfers require a person to verify (8C.3).

### 5.4 What a card shows the owner
- 5.4.1 What is being asked, one line, with the amount.
- 5.4.2 Why — the requester's stated reason.
- 5.4.3 Evidence inline — payment proof on the card, not behind a link.
- 5.4.4 Claimed amount vs expected amount at the current rate.
- 5.4.5 Who verified it, when, and their notes.
- 5.4.6 Duplicate-UTR flag if that reference was used before.
- 5.4.7 Balance before → after.
- 5.4.8 Requester's recent history.

### 5.5 Rules
- 5.5.1 A member's request is verified by their own admin.
- 5.5.2 An admin's own request is verified by a different admin.
- 5.5.3 An owner cannot sign a request they raised — another owner signs.
- 5.5.4 Nothing skips Under Review, including an owner's own request.
- 5.5.5 Rejection requires a reason and returns the card to the team.
- 5.5.6 Bulk sign-off is allowed for verified cards; each is logged individually.
- 5.5.7 Small routine corrections are auto-grouped into a single batch card so volume never jams the owner queue (9.4).

### 5.6 What does NOT need owner signature
Replying to a ticket · banning a user for abuse · moving a ticket between teams · approving partner onboarding · editing cosmetic content · sending a broadcast with no monetary cost. All still logged.

---

# PART 6 — AUDIT LOG

### 6.1 Every sensitive action records
- 6.1.1 **Who** — real user id, name, role. Never a generic label.
- 6.1.2 **When** — server time, never device time.
- 6.1.3 **What** — record affected, before → after values.
- 6.1.4 **Why** — mandatory reason.
- 6.1.5 **Which card** it originated from.

### 6.2 Properties
- 6.2.1 Append-only. Nothing can edit or delete an entry, including owners.
- 6.2.2 Written in the same transaction as the change — if one fails, both fail.
- 6.2.3 Cannot be bypassed by acting outside the interface.

### 6.3 Visibility
| Role | Sees |
|---|---|
| 6.3.1 Observer | Everything |
| 6.3.2 Owner | Everything, including other owners |
| 6.3.3 Team Admin | Their own team |
| 6.3.4 Team Member | Their own actions |

### 6.4 What lands in it
Balance changes · lending and repayment · coin purchase approvals · payouts and withdrawals · partner approve/reject/deactivate · bans and unbans · host designation · economy and pricing config · app content and control changes · staff role changes · exports.

---

# PART 7 — QUEUES AND INBOX

### 7.1 Every queue is a board
Same left-to-right model everywhere. Support is To Do → In Progress → Done. Money is the five stages in 5.2. Staff learn one interface.

### 7.2 Every card carries
- 7.2.1 A named owner, not just a team.
- 7.2.2 An age.
- 7.2.3 A priority.
- 7.2.4 A reason for being where it is.

### 7.3 Everyone gets an inbox
- 7.3.1 "Waiting on you" across every board, in one place.
- 7.3.2 Team Admin additionally sees "waiting on my team."
- 7.3.3 Owner additionally sees "waiting on my signature."
- 7.3.4 Nobody visits six pages to discover their work.

### 7.4 Ageing and escalation
- 7.4.1 Cards show how long they have waited.
- 7.4.2 Beyond a set age they flag visibly.
- 7.4.3 Team Admin sees their oldest items first.

---

# PART 8 — APP ADMIN PORTAL

This is the half that controls the product itself. Owned by Tech, with Finance owning anything priced and owners signing anything monetary.

### 8.1 Content — gifts
- 8.1.1 Create, edit, retire gifts: name, artwork, animation, category, price in diamonds.
- 8.1.2 Categories: normal, exclusive, lucky — each with its own earning split.
- 8.1.3 Earning rate determines what the host receives; the remainder is platform margin.
- 8.1.4 Every gift shows its live margin so nobody prices one at a loss.
- 8.1.5 **Price or earning-rate changes require owner signature.** Artwork and naming do not.
- 8.1.6 Retiring a gift hides it from the app but preserves history.

### 8.2 Content — cosmetics
- 8.2.1 Profile frames, entrance animations, chat bubbles, profile cards, ID frames, badges.
- 8.2.2 Each item: artwork, animation file, unlock level, host level requirement, price, availability window.
- 8.2.3 Targeting: by gender, by role (user/host), or to a single named account.
- 8.2.4 Source: level unlock, marketplace purchase, or event drop.
- 8.2.5 Priced items follow the same signature rule as 8.1.5.

### 8.3 Economy rates
- 8.3.1 Diamond price per lakh, in local and foreign currency.
- 8.3.2 Bean-to-currency payout rate.
- 8.3.3 Bean-to-diamond conversion rate.
- 8.3.4 Call rate per minute — default, plus the range an agency may set per host.
- 8.3.5 Gift earning percentages per category.
- 8.3.6 Commission slab tables, main and sub-agency.
- 8.3.7 Minimum payout threshold.
- 8.3.8 Late-payment penalty basis for seller credit recovery (4.3.14).
- 8.3.9 **All of these are money. Every change is a card requiring owner signature.**
- 8.3.10 Rate changes apply forward only. Already-earned balances are never restated.
- 8.3.11 Every rate change is versioned so any historical payout can be explained.

### 8.3A Foreign exchange — automatic, with override
- 8.3A.1 **The FX rate tracks the live market rate automatically**, sourced from the exchange you settle through. Nobody types it in by hand.
- 8.3A.2 Transfer fees and tax percentages are likewise pulled from the settlement source where published.
- 8.3A.3 The portal always shows the live rate, when it was last refreshed, and the source.
- 8.3A.4 **An owner can override the rate for a specific country** — to hold a rate steady for a market, absorb volatility, or match a local agreement.
- 8.3A.5 An override is per country, has an explicit reason, and stays until removed. Countries without an override continue tracking the market.
- 8.3A.6 Every override is a card requiring owner signature and appears in the audit log — this is a pricing decision, not a setting.
- 8.3A.7 The portal shows override versus live rate side by side, with the resulting gain or loss per lakh, so the cost of holding a rate is visible.
- 8.3A.8 If the live feed fails, the last known good rate is held and all three owners plus the Observer are alerted. Rates never silently fall to zero or stale-drift unnoticed.
- 8.3A.9 Every payout records the rate actually applied at the moment it executed, so historical settlements are always explainable.

### 8.4 Pricing and packages
- 8.4.1 User recharge packages: price, base amount, bonus amount, badge, display order.
- 8.4.2 Seller wholesale packs: price and volume tiers.
- 8.4.3 Per-country pricing.
- 8.4.4 Owned by Finance, signed by an owner.
- 8.4.5 A change takes effect in the app immediately — no app release required.

### 8.5 Levels and progression
- 8.5.1 User ladder driven by spend; host ladder driven by earnings.
- 8.5.2 Per level: threshold, frame, entrance animation, profile card, bonus.
- 8.5.3 Level bonuses are a real liability — **bonus values require owner signature**, and bonuses must actually be granted, not merely displayed.
- 8.5.4 Thresholds and cosmetics are Tech decisions.

### 8.6 Rewards and bonuses
- 8.6.1 Daily login streak: reward per day of the cycle.
- 8.6.2 Campaign and event bonuses, with start and end dates.
- 8.6.3 First-purchase and referral incentives.
- 8.6.4 Every reward has a defined cost; the total projected cost is shown before it goes live.
- 8.6.5 All reward values require owner signature.
- 8.6.6 Rewards are granted server-side. A client must never be able to credit itself.

### 8.7 Live operations
- 8.7.1 Real-time view of active rooms: host, title, viewers, gifts received, duration.
- 8.7.2 Click through to the host's account record.
- 8.7.3 Ops can end a stream, mute a host, or force-close a room on violation.
- 8.7.4 Every intervention is logged with a reason.
- 8.7.5 Flagged rooms — sudden gift spikes, reported content — surface at the top.

### 8.8 Moderation
- 8.8.1 User reports queue with reporter, target, reason and evidence.
- 8.8.2 Action executes from the report itself: warn, suspend, ban, dismiss.
- 8.8.3 Device bans to stop a banned user returning on the same hardware.
- 8.8.4 Ban reasons are permanent record and survive an unban.
- 8.8.5 A banned user's balance is frozen, not deleted, pending review.
- 8.8.6 Appeals arrive as support tickets and are visible against the account.

### 8.9 App configuration
- 8.9.1 Profile options: hobbies, interests, languages, maximum selectable.
- 8.9.2 Live categories.
- 8.9.3 Support ticket categories.
- 8.9.4 Tech decisions, no signature needed.
- 8.9.5 **Every configuration screen must be read by the app.** A setting the app ignores is removed from the portal — staff must never believe they changed something that did nothing.

### 8.10 App control
- 8.10.1 Maintenance mode with a user-facing message.
- 8.10.2 Minimum supported version and forced-update prompt.
- 8.10.3 Feature flags to enable or disable modules without a release.
- 8.10.4 Regional availability.
- 8.10.5 Maintenance and forced update require owner signature — they stop revenue.
- 8.10.6 Feature flags are Tech decisions.

### 8.11 Payments configuration

**Today — manual settlement**
- 8.11.1 Company bank and wallet details shown to sellers buying inventory.
- 8.11.2 **Bank details are owner-only, always.** This is where all incoming revenue lands.
- 8.11.3 Any change to bank details alerts all three owners and the Observer immediately.

**Planned — payment gateways (Razorpay, Stripe and others)**
- 8.11.4 Gateways serve **two distinct channels**:
  - **Seller top-up** — a seller buys inventory by card/UPI instead of a manual transfer.
  - **Direct user purchase** — a user buys diamonds from you in-app, with no seller involved.
- 8.11.5 Both channels coexist with the existing reseller network. A user can buy from a seller or direct; a seller can pay manually or by gateway.

**Per-country control**
- 8.11.6 Every payment method has an on/off switch **per country**.
- 8.11.7 A user only ever sees the methods enabled for their country. Nothing else renders.
- 8.11.8 Switching a method on or off takes effect immediately — no app release.
- 8.11.9 If every method is off for a country, that country falls back to the reseller channel.
- 8.11.10 Method availability is a Tech decision; **pricing per country is Finance, signed by an owner** (8.4).

**Why this matters beyond convenience**
- 8.11.11 A gateway payment **reconciles itself.** The settlement record comes from the gateway, not from a screenshot, so there is no proof to eyeball and no UTR to check.
- 8.11.12 Gateway cards therefore skip manual verification and go straight to Awaiting Sign-off with an automatic verification stamp — or auto-execute below a threshold you set, since the money has already provably arrived.
- 8.11.13 This removes the largest manual workload in Finance and closes the duplicate-payment risk on that channel entirely.
- 8.11.14 Direct purchase is also **higher margin** — no reseller markup — so the portal should report the two channels separately: volume, margin and growth per channel.
- 8.11.15 Refunds, chargebacks and failed settlements each need a card and an owner signature, and must reverse the diamonds credited.
- 8.11.16 Gateway keys and secrets are owner-only, stored server-side, never visible in the portal or the app.
- 8.11.17 Every gateway settlement is reconciled against the gateway's own daily statement, automatically, with mismatches raised as exceptions.

### 8.12 User communications
- 8.12.1 Broadcasts to all users, or segmented by role, level, region or activity.
- 8.12.2 Scheduling and history with delivery counts.
- 8.12.3 Legal documents: privacy policy, terms, FAQ — versioned, with draft and publish separated.
- 8.12.4 Marketing owns broadcasts; App owns legal documents.

### 8.13 App analytics
- 8.13.1 Users, hosts, sellers, agencies — totals and growth.
- 8.13.2 Active rooms, call volume, gift volume.
- 8.13.3 Revenue by day, week, month, with period comparison.
- 8.13.4 Top hosts, top spenders, top agencies.
- 8.13.5 Every view filterable by date range and exportable.

---

# PART 0 — FAIRNESS AND TRANSPARENCY CHARTER

This is the commercial proposition, not a feature list. Agencies move for terms and stay for trust. Everything here is published, and the portal is built to prove it.

### 0.1 Principles
- 0.1.1 **Nothing is secret.** Rates, slabs, splits and schedules are published to the people they affect.
- 0.1.2 **Everyone sees their own money, live**, without asking anyone.
- 0.1.3 **No retroactive changes.** A rate change applies forward only; earnings already made are settled at the rate in force when they were made.
- 0.1.4 **Changes are announced before they take effect**, with notice.
- 0.1.5 **Every number is explainable.** Any figure can be traced to the events that produced it.
- 0.1.6 **Rules are written down and applied evenly.** No case-by-case discretion on money.
- 0.1.7 **Mistakes are corrected openly**, with the correction visible in the record.

### 0.2 What an agency is guaranteed
- 0.2.1 The commission slab table, published in full. No private rates that others cannot see.
- 0.2.2 **Live commission balance** — earned, paid, outstanding — at any moment.
- 0.2.3 A **full ledger**: every credit with the host and period that produced it, every payment with date and reference.
- 0.2.4 Per-host performance: who earned what, over which period.
- 0.2.5 A **published payout schedule**, and payment on it.
- 0.2.6 A statement emailed weekly and monthly without being requested (8A.3.6).
- 0.2.7 Any past period reproducible on demand at that period's rates (8A.5.3).
- 0.2.8 Clear rules on host attribution — which hosts count as theirs, from when, and what happens if a host leaves.
- 0.2.9 Written grounds for deactivation, and notice before it happens except for fraud.
- 0.2.10 A dispute route with a named owner and a response commitment.
- 0.2.11 Sub-agency terms stated up front: how the sub earns, how money reaches them, who is responsible (4.2).

### 0.3 What a host is guaranteed
- 0.3.1 Published earning rates — gift splits by category, call rate per minute, and how their rate is set.
- 0.3.2 **Live earnings**, updated as they earn, not once a week.
- 0.3.3 A breakdown by source: gifts, calls, and anything else.
- 0.3.4 The payout schedule and the minimum threshold, stated before they start.
- 0.3.5 **An explanation whenever a payout differs from expectation** — threshold not met, period boundary, correction — never a silent difference.
- 0.3.6 Written conduct rules, and the grounds on which earnings can be withheld.
- 0.3.7 A route to raise a problem that does not depend only on their agency.
- 0.3.8 Their earning history preserved and visible, including after leaving an agency.

### 0.4 What a coin seller is guaranteed
- 0.4.0 **Their own permanent virtual account number** — payments identify themselves, credit without dispute, and never depend on a screenshot being accepted (8C.1.4).
- 0.4.1 Published wholesale pricing and volume tiers.
- 0.4.2 A **single reconciled ledger**: bought, lent, sold, paid, outstanding (4.3.10).
- 0.4.3 Credit terms stated in writing before credit is given — amount, due date, penalty basis (4.3.14).
- 0.4.4 Notice before recovery is taken from their balance.
- 0.4.5 Confirmation of every payment received, with reference.
- 0.4.6 Clear grounds for being blocked from new inventory (4.3.12).

### 0.5 What a user is guaranteed
- 0.5.1 Published pricing before purchase, in their own currency.
- 0.5.2 A visible transaction history.
- 0.5.3 Stated odds for any chance mechanic they participate in.
- 0.5.4 Clear rules on what causes account restriction, and a route to appeal.
- 0.5.5 A ban explanation, and their balance preserved pending review (8.8.5).

### 0.6 How the portal proves it
- 0.6.1 Every guarantee above maps to a screen or an automated statement — a promise with no supporting record is not made.
- 0.6.2 Rate changes are versioned, and the version applied is recorded on every settlement (9.8).
- 0.6.3 Statements are generated server-side from the ledger, never from a browser's view of it (8A.6.4).
- 0.6.4 The Observer can verify any partner's position independently at any time (1.1).
- 0.6.5 Where a figure is disputed, the audit log reconstructs how it was reached, including who changed what and why (Part 6).

### 0.7 Why this is the competitive position
- 0.7.1 Agencies leave platforms over late payment, invisible balances and unexplained deductions — not over features.
- 0.7.2 Every guarantee above is cheap to honour at low volume and becomes credibility as volume grows.
- 0.7.3 Transparency is enforced by the system rather than promised by staff, so it survives growth and staff turnover.
- 0.7.4 It is also the cheapest defence against disputes: most partner conflicts are information gaps, not disagreements about money.

---

# PART 8B — CHANCE MECHANICS: LUCKY GIFTS AND GAMES

Covers anything where a user stakes value on an uncertain outcome — lucky gifts today, games like Aviator later. These share one risk profile and must share one control system.

### 8B.0 Regulatory gate — settle this before building
- 8B.0.1 India's Promotion and Regulation of Online Gaming Act, 2025, with Rules in force from 1 May 2026, prohibits "online money games" — any game played by paying fees or staking value in expectation of winning money **or other forms of enrichment** — irrespective of skill or chance. An Online Gaming Authority regulates classification and compliance.
- 8B.0.2 This potentially reaches the **existing** lucky gift and bet features, not only future games, because diamonds are purchased with real money.
- 8B.0.3 **Obtain Indian gaming law counsel on your specific mechanics before building further.** This is a legal determination, not a product decision.
- 8B.0.4 The portal must support **per-country enablement** of every chance mechanic regardless of the outcome, so a market can be switched off in seconds without an app release.
- 8B.0.5 Jurisdiction rules are owner-controlled and every change is signed and logged.
- 8B.0.6 Age verification and any licence conditions are enforced per market.
- 8B.0.7 If a mechanic is disabled for a country, it must be invisible there — not merely blocked on tap.

### 8B.1 The RNG must be yours
- 8B.1.1 **Every random outcome is generated server-side.** No exceptions.
- 8B.1.2 A client never decides, reports or influences a result. It receives one.
- 8B.1.3 A client never reports a winning amount. The server calculates and credits it.
- 8B.1.4 Third-party games are integrated through a server-to-server settlement callback, signed and verified — never through the app.
- 8B.1.5 Every outcome is recorded before it is paid: stake, result, multiplier, payout, timestamp, player.
- 8B.1.6 Where you want provable fairness, publish a hashed seed before the round and reveal it after, so a player can verify the result was not altered.
- 8B.1.7 **Until this exists, no chance mechanic should be live.** Client-side randomness means the payout is whatever a modified app claims it is.

### 8B.2 Configuration per mechanic
- 8B.2.1 Each mechanic — each lucky gift tier, each game — has its own configuration record.
- 8B.2.2 **Return to player (RTP)** — the percentage returned to players over time. The house edge is the remainder.
- 8B.2.3 The full outcome table: every possible multiplier and its probability. Probabilities must sum to 100%.
- 8B.2.4 The portal computes and displays the resulting RTP from the table, so nobody sets odds without seeing the margin.
- 8B.2.5 Stake denominations: minimum, maximum, and permitted steps.
- 8B.2.6 **Maximum single win**, capped in absolute terms — this bounds your worst case on one round.
- 8B.2.7 Enabled countries.
- 8B.2.8 **Every one of these is money. Changes require owner signature and are versioned** (9.8).

### 8B.3 The combo problem — fix before scaling
- 8B.3.1 Where a mechanic supports multi-quantity plays, **the multiplier must apply to total stake, not unit stake**, unless a lower return on larger plays is deliberate and stated.
- 8B.3.2 The portal shows effective RTP **per quantity tier**, so a mis-set table is visible before it ships.
- 8B.3.3 As currently built, lucky gift returns are 58% for a single, 59% at 17×, 27% at 37% and **13% at 77×** — the largest spenders receive by far the worst value, which is almost certainly unintended.
- 8B.3.4 Any tier whose RTP falls outside an agreed band is flagged in the portal and blocked from going live.

### 8B.4 Exposure and reserve
- 8B.4.1 House edge only works over volume. Short-run losses are certain and must be planned for, not treated as failures.
- 8B.4.2 The portal shows **current exposure** — total staked against total paid out, live.
- 8B.4.3 A **reserve** is modelled explicitly: how much you can pay out before the mechanic is loss-making.
- 8B.4.4 Configurable ceilings: maximum payout per round, per player per day, and platform-wide per day.
- 8B.4.5 On breach, the mechanic **auto-suspends** and alerts all owners. It does not keep paying while someone notices.
- 8B.4.6 Payouts are never minted without limit. Today the lucky gift payback is created on the spot with no reserve and platform cut can go negative — that is the gap this closes.

### 8B.5 Monitoring — actual versus theoretical
- 8B.5.1 Live comparison of **actual RTP against configured RTP**, per mechanic, per day.
- 8B.5.2 A persistent gap means one of three things: a configuration error, an exploit, or a bug. All three need immediate attention.
- 8B.5.3 Player-level anomaly detection: unusual win rate, unusual frequency, impossible timing patterns.
- 8B.5.4 A flagged player's activity is frozen pending review, not reversed automatically.
- 8B.5.5 Every round is retained and queryable — you must be able to reconstruct any player's full history.
- 8B.5.6 Ops owns the exception queue; Finance owns the margin.

### 8B.6 Player protection
- 8B.6.1 Configurable daily and weekly loss limits per player.
- 8B.6.2 Self-exclusion, and a cooling-off period a player can set themselves.
- 8B.6.3 Session reminders after a set duration of continuous play.
- 8B.6.4 Automatic flagging of behaviour patterns associated with harm — escalating stakes after losses, sustained sessions, rapid repeat play.
- 8B.6.5 A flagged player is reviewed by a named person, and the decision is recorded.
- 8B.6.6 These are not optional extras. They protect the business as much as the player.

### 8B.7 Money treatment
- 8B.7.1 **Gross gaming revenue** — total staked minus total paid out — is reported as its own revenue line, separate from gifting and calls.
- 8B.7.2 Reported per mechanic, per country, per day, with actual RTP alongside.
- 8B.7.3 Hosts and agencies earn nothing from chance mechanics unless you deliberately design a share; if you do, it is configured and signed like any other rate.
- 8B.7.4 Stakes and payouts are ledger entries like any other money movement and appear in the audit log.
- 8B.7.5 Any manual adjustment to a game outcome is a money card requiring owner signature, with a reason.
- 8B.7.6 A configuration error that overpays players is recovered through the normal recovery path (4.3.13), never by silent balance edits.

### 8B.8 Margin model — how these mechanics actually make money
- 8B.8.1 **Diamonds returned to a player are not a cost.** They were already sold for cash; returning them recirculates inventory. The only true cash outflow in the system is **beans becoming payouts**.
- 8B.8.2 The real profit measure is therefore **diamonds consumed per unit of bean payout**, not house edge.
- 8B.8.3 By that measure: normal gift creates 50% beans (high cash cost) · lucky gift creates 5% (low) · games create **none**.
- 8B.8.4 **Games are the highest-margin mechanic available**, because no bean is ever created. Every diamond staked and not returned is realised margin.
- 8B.8.5 The portal reports **bean-payout ratio** per mechanic — cash out as a percentage of diamond value consumed. This is the number that governs profitability.

### 8B.9A Games as retention — and how to make them feed hosts
- 8B.9A.1 **Most users will never spend on a host.** Games give them a reason to stay, and a larger retained audience is what makes hosts want to work here. This is a legitimate and important role.
- 8B.9A.2 The failure mode is games becoming a **parallel economy** — users play, hosts see nothing, and the platform is a casino with a chat app attached.
- 8B.9A.3 Design games as a **funnel into** the host economy, not a substitute for it:
  - Diamonds spent on hosts are worth more than diamonds spent on more games — a gifting bonus turns winnings into host income.
  - Game entries can be earned by gifting, so each loop feeds the other.
  - Events and leaderboards reward gifting, not only playing.
- 8B.9A.4 **The governing metric is the share of game winnings subsequently spent on hosts.** If it falls, the funnel is leaking and games are becoming an end in themselves.
- 8B.9A.5 Report per week: winnings recycled into games versus spent on gifting, and the count of players who moved from games to gifting for the first time.
- 8B.9A.6 A non-spending player retained by games has real value — they are audience for hosts and future conversion. Measure them as retained, not as failed monetisation.

### 8B.9 The cannibalisation limit
- 8B.9.1 Games extract value; **hosts create the reason users return**. Gifting is the product, monetisation mechanics ride on top of it.
- 8B.9.2 If games displace gifting, host earnings fall, good hosts leave, and the engagement engine that feeds the games dies with them.
- 8B.9.3 The metric to govern by is **game revenue rising while host earnings hold steady**. Falling host earnings alongside rising game revenue means the ecosystem is being consumed.
- 8B.9.4 The portal tracks, per week: total host earnings, host earnings per active host, share of diamond spend going to games versus gifting, and active host count.
- 8B.9.5 If host earnings per active host decline for a sustained period while game share rises, that is an alert to owners — not a report to read later.
- 8B.9.6 Consider capping the share of a user's spend that games may absorb, or scheduling games so they complement peak host hours rather than competing with them.

### 8B.10 Tuning for profit
- 8B.10.1 **Volume beats edge.** A lower house edge across far more play generally out-earns a heavy edge on thin play — and preserves the players who generate it.
- 8B.10.2 Because winnings cannot be cashed out, players tolerate a lower RTP than regulated gambling. That is headroom, not a licence to take everything.
- 8B.10.3 **Never let higher spend mean worse value.** Effective RTP must be flat or improving as stake size rises. Whales generate most revenue; giving them the worst odds in the product churns them.
- 8B.10.4 The portal blocks any configuration where a larger stake tier returns a lower RTP than a smaller one, unless an owner explicitly overrides with a reason.
- 8B.10.5 Level gating is a profit control, not just a safety one: it requires spend before play, keeps reward diamonds out of games, and filters bots and farmers.
- 8B.10.6 Higher stake tiers should carry higher level requirements, so exposure rises only with demonstrated spend history.
- 8B.10.7 Report **revenue per active player** and **retention after first loss** per mechanic. A mechanic that earns well but kills retention is a loss disguised as a win.

### 8B.11 Margin discipline — the house edge
- 8B.11.1 A house edge must exist or the mechanic is not a business. This is not in tension with fairness; it is the price of the entertainment, and it is stated.
- 8B.11.2 The edge is **set deliberately per mechanic**, computed by the portal from the odds table, and signed by an owner (8B.2.4).
- 8B.11.3 **Many small outcomes beat few large ones**, for margin and for retention. A player remembers how often they win. A flatter distribution sustains longer play at the same edge and produces more total margin than heavy extraction.
- 8B.11.4 The current lucky table returns nothing on 65% of single rolls. That is the profile that produces burnout and complaints. Increase win frequency, reduce win size, hold the edge.
- 8B.11.5 **Lifetime value is the target, not session yield.** A modest edge across many players over years out-earns a heavy edge that exhausts them.
- 8B.11.6 Report per mechanic: margin, actual RTP, average session length, repeat play rate, and **spend trend over a player's lifetime**. A rising margin with falling repeat play is a mechanic consuming its own audience.

### 8B.12 Engagement — events and rotation
- 8B.12.1 **Novelty retains; intensity exhausts.** New content brings players back more reliably than squeezing existing content harder.
- 8B.12.2 An **events calendar** is a first-class part of the portal: what is running, when it starts and ends, its configuration, and its projected cost.
- 8B.12.3 Multiple concurrent events across different mechanics — gifting events, game tournaments, host leaderboards, seasonal content.
- 8B.12.4 Games rotate: featured game of the week, limited-time modes, returning favourites.
- 8B.12.5 Every event carries a **projected cost and a maximum exposure**, signed before it goes live (8B.4).
- 8B.12.6 Post-event reporting: participation, cost, revenue, retention effect. Events that do not earn their cost are not repeated.
- 8B.12.7 **Free daily entries** for every player. Non-spenders get a reason to return, which is the retention this is for, at no extraction. They are audience for your hosts.
- 8B.12.8 Events should be scheduled to **complement peak host hours**, not compete with them (8B.9.6).
- 8B.12.9 Event configuration is Marketing and Tech; anything with a monetary cost is signed by an owner.

### 8B.13 Complaints and disputes
- 8B.13.1 **A complaint is early warning, not an attack.** It surfaces a mis-tuned RTP, a broken game or a confusing interface before it becomes a chargeback or a regulatory question.
- 8B.13.2 Complaints about a mechanic are tracked **per mechanic and per country**, with a rate, not just a count.
- 8B.13.3 A rising complaint rate on a mechanic **auto-flags it for review** and alerts owners. It is a tuning signal.
- 8B.13.4 Every complaint gets a response and a recorded resolution.
- 8B.13.5 Users are never restricted for complaining. Restriction applies to fraud, abuse, exploitation of a bug, or repeated bad-faith disputes — each with written grounds and a recorded decision (8.8).
- 8B.13.6 A restricted user's balance is preserved pending review, never confiscated silently (8.8.5).
- 8B.13.7 **Chargebacks are tracked as a rate against transaction volume.** Above a set threshold, payment processors terminate accounts — this is monitored as an existential risk, not a cost line.
- 8B.13.8 A rising chargeback rate triggers review of the mechanics generating it, before a processor acts.
- 8B.13.9 Refunds and disputes reverse the diamonds credited and require owner signature (8.11.15).

### 8B.14 Regional control
- 8B.14.1 Every mechanic — each game, each lucky tier — is enabled or disabled **per country**, effective immediately, without an app release.
- 8B.14.2 Used for genuine compliance: legal status in a market, licence conditions, age rules, or an owner decision to withdraw.
- 8B.14.3 A disabled mechanic is invisible in that market, not merely blocked on interaction (8B.0.7).
- 8B.14.4 Every enable and disable is signed, dated and logged with a reason.
- 8B.14.5 The portal shows current status per market and the history of changes, so any regulator question can be answered from the record.
- 8B.14.6 **If a market generates a sustained complaint rate, that is a signal to re-tune the mechanic there** — lower edge, better odds, clearer disclosure — not to cycle it out of sight. Concealment leaves the cause in place and converts a fixable issue into an enforcement risk.
- 8B.14.7 Where a mechanic is withdrawn from a market, affected balances are honoured and users are told what happened.

---

# PART 8C — COLLECTIONS AND TREASURY

Replaces manual payment verification with automatic bank-level identification. This is the single largest reduction in Finance workload in the whole system.

### 8C.1 Virtual account numbers
- 8C.1.1 A **virtual account number (VAN)** is a unique account number mapped onto one real, KYC-compliant business account. Banks issue them in unlimited quantity.
- 8C.1.2 To the payer a VAN looks and behaves like an ordinary bank account. It accepts NEFT, RTGS, IMPS and UPI.
- 8C.1.3 All money lands in the single underlying account. The VAN is an identifier, not a separate pot.
- 8C.1.4 **Every coin seller is assigned a permanent VAN on approval.** It is theirs for life and appears in their portal.
- 8C.1.5 Because the account number identifies the payer, the bank tells you **who paid, how much and when** — with no screenshot and no reference number to type.
- 8C.1.6 Available as a standard product from Indian banks and aggregators. No custom build. **Your bank, HDFC, sells it as eCMS** (8C.8).

### 8C.2 The seller payment flow, rebuilt
- 8C.2.1 Seller opens their portal, selects a pack, and sees **their own VAN** and the exact amount due.
- 8C.2.2 Seller transfers from any bank, any method.
- 8C.2.3 The bank notifies the system on credit. The system matches the VAN to the seller automatically.
- 8C.2.4 A card is created **already carrying proof**: payer identity and amount are confirmed by the bank, not asserted by the seller.
- 8C.2.5 The card enters **Awaiting Sign-off directly**, marked auto-verified. Finance performs no manual check (5.3.1).
- 8C.2.6 Owner signs. Inventory credits. Seller is notified with a receipt.
- 8C.2.7 **What disappears:** uploading proof, opening the image, checking the UTR against the statement, matching payer to seller, duplicate-payment risk on this channel. All of it.
- 8C.2.8 What remains: the owner's signature, exactly as specified (9.4).

### 8C.3 Exceptions that still need a person
- 8C.3.1 Amount does not match any pack — held for Finance to allocate.
- 8C.3.2 Partial payment — credited against the intended purchase, balance shown as outstanding.
- 8C.3.3 Overpayment — surplus held as seller credit or refunded, either way a card.
- 8C.3.4 Credit into the underlying account with **no VAN match** — unidentified receipt, raised as an exception, never silently absorbed.
- 8C.3.5 Payment from a source inconsistent with the seller's registered details — flagged for review.
- 8C.3.6 Refunds and reversals — always a card requiring owner signature.
- 8C.3.7 The exception queue is Finance's real work. Everything else is automatic.

### 8C.4 Treasury structure
- 8C.4.1 Accounts are separated **by function**, which is standard practice and makes the books clearer:
  - **Collections** — all inbound. VANs sit on this account.
  - **Payouts** — host, agency and commission payments leave from here.
  - **Operating** — salaries, vendors, infrastructure.
  - **Tax reserve** — set aside as revenue is recognised, not scrambled for later.
- 8C.4.2 Additional collection accounts may be held for genuine reasons: a second currency, a second entity, a second payment aggregator, or to spread counterparty risk if one bank freezes or fails.
- 8C.4.3 As markets are added, per-country settlement accounts follow the same pattern.
- 8C.4.4 Every account is declared in the portal with its purpose and owner.
- 8C.4.5 **Every movement between accounts is recorded** with amount, date, purpose and the person who authorised it.
- 8C.4.6 Transfers between own accounts require owner signature like any other money movement.
- 8C.4.7 The portal shows the live position of every account and the consolidated total.

### 8C.5 Daily reconciliation
- 8C.5.1 The bank statement is imported daily and matched automatically against expected receipts.
- 8C.5.2 Every credit resolves to one of: matched to a seller VAN, matched to a gateway settlement, matched to a known transfer, or **unidentified**.
- 8C.5.3 Unidentified credits and unmatched expectations both raise exceptions. Nothing is written off by silence.
- 8C.5.4 A **daily cash position** is produced: opening balance, receipts by channel, payments out, closing balance, and the reconciliation status of each.
- 8C.5.5 This is the figure that answers "how much money came in this week" (8A.3.1) — actual cash, not imputed diamond consumption.
- 8C.5.6 Reconciliation breaks alert Finance and owners the same day (8A.4).

### 8C.6 Outbound payments
- 8C.6.1 Host and agency payouts are prepared as a **batch file** or through the bank's payout interface, not typed one by one.
- 8C.6.2 The batch is generated from signed cards only. Nothing enters a payment file without a signature.
- 8C.6.3 The bank returns a per-item result; success and failure are written back to each card.
- 8C.6.4 A failed transfer returns the card to Approved-not-Executed and alerts Finance (5.2.6).
- 8C.6.5 Payment references from the bank are stored on the card and included in the partner's receipt (0.2.3).

### 8C.8 Your bank — HDFC, and what it requires
- 8C.8.1 Current setup, from the portal: **HDFC Bank**, a branch in Vadodara, Gujarat. Held in an individual's name. A Binance UID is also configured for foreign payments.
  - The account number, IFSC and Binance UID are deliberately **not written in this document**, which is shared with partners and advisors. The live values are the ones stored in Firestore at `appConfig/paymentCredentials` and surfaced in the CRM's payment-settings screen; that record is the single source of truth. The account itself is unchanged and stays in use — this is about what a circulated document contains, not about switching banks.
- 8C.8.2 HDFC's product for this is **eCMS — Electronic Cash Management Services**. It is exactly the model described above.
- 8C.8.3 An HDFC virtual account number is structured as **corporate prefix + your own code for the payer**. The bank allocates the prefix once; you control the suffix.
- 8C.8.4 **This maps directly onto your existing data.** Every seller already carries a unique CRM ID. That becomes the suffix, so the VAN is `HDFC prefix + seller CRM ID` — no new identifier scheme, and the account number is self-describing.
- 8C.8.5 The same pattern extends later to agencies, and to direct users if you ever want transfer-based purchase.
- 8C.8.6 HDFC also offers a **Regular Collection Account** at SME tier, suitable if eCMS is priced for larger volumes than you currently run. Ask for both and compare.
- 8C.8.7 Collection services can be arranged with or without an existing HDFC current account, but the account underneath must be a **business current account**, not a personal one.

### 8C.9 The prerequisite you need to resolve first
- 8C.9.1 **The collections account is held in an individual's name.** That blocks more than virtual accounts:
  - **eCMS and corporate collection products** require a business current account.
  - **Payment gateways** (Razorpay, Stripe) onboard a registered business entity with matching bank details. A personal account fails onboarding.
  - **Three co-owners have no legal claim** on revenue sitting in one person's personal account. That is a governance exposure for the other two, independent of anyone's intentions.
  - **Company revenue in a personal account** mixes business and personal income, which complicates tax treatment and makes the books harder to defend.
- 8C.9.2 **Action: open a business current account in the company entity's name**, with the three owners' shareholding documented, and move collections to it.
- 8C.9.3 This is a prerequisite for the gateway channel (8.11), the virtual account model (8C.1), the treasury structure (8C.4) and clean partner statements (Part 0).
- 8C.9.4 It is also what makes the audit log meaningful — an owner-signed payout from a company account is an auditable business transaction; the same payment from a personal account is not.
- 8C.9.5 Until this is done, everything in Part 8C is blocked. It is the first item, not a later one.

### 8C.7 How this coexists with gateways
- 8C.7.1 VANs serve **bank transfers** — sellers buying inventory, larger amounts, users who prefer transfer.
- 8C.7.2 Gateways serve **cards and UPI in-app** — direct user purchase, smaller amounts, instant checkout (8.11).
- 8C.7.3 Both settle into the Collections account and both reconcile automatically.
- 8C.7.4 Under RBI rules, aggregator funds arrive from the aggregator's escrow account on a settlement cycle, so gateway receipts reconcile against the **settlement report**, not per transaction.
- 8C.7.5 The portal reports receipts by channel — VAN transfer, gateway, and any residual manual — so the mix is always visible.
- 8C.7.6 Manual transfer with uploaded proof remains only as a fallback for sellers not yet migrated, and is reported separately as the residual risk it is.

---

# PART 8A — REPORTING, EMAIL AND ALERTS

Nothing in this system should require a person to remember to check something. If it matters, it arrives.

### 8A.1 Three channels, used for different things
- 8A.1.1 **In-portal inbox** — your work. Cards waiting on you, tickets assigned to you. Always current, never emailed item by item.
- 8A.1.2 **Email** — things you must act on away from the portal, scheduled reports, and alerts.
- 8A.1.3 **In-app notification** — end users only: ticket replies, payout confirmations, broadcasts.
- 8A.1.4 Nobody is emailed for routine queue movement. Email that becomes noise gets ignored, and then a real alert gets ignored too.

### 8A.2 Transactional email — sent on an event
| Event | Goes to |
|---|---|
| 8A.2.1 Staff invitation | The new staff member — set-your-password link |
| 8A.2.2 Password reset | The account holder |
| 8A.2.3 Partner application received | The applicant — confirmation with reference number |
| 8A.2.4 Partner approved | The partner — welcome, login link, next steps |
| 8A.2.5 Partner rejected | The partner — **with the reason**, and whether they may reapply |
| 8A.2.6 KYC approved or rejected | The partner, with the reason if rejected |
| 8A.2.7 Payout approved | The partner — amount, period, expected date |
| 8A.2.8 Payout paid | The partner — amount, UTR, date. This is their receipt |
| 8A.2.9 Ticket replied | The end user, in-app and by email |
| 8A.2.10 Credit due in 3 days | The seller — amount and due date |
| 8A.2.11 Credit overdue | The seller and the Finance admin |
| 8A.2.12 Card awaiting signature over a set amount | All three owners |
| 8A.2.13 Account deactivated | The account holder, with the reason |

- 8A.2.14 Every transactional email is recorded — what was sent, to whom, when, and whether it delivered.
- 8A.2.15 A failed delivery is an exception someone sees, not a silent loss.

### 8A.3 Scheduled reports — generated and emailed automatically

**Daily**
- 8A.3.1 **Business summary** → 3 owners + Observer. Cash in by channel, cash out, net position, new users/hosts/partners, queue depth per team, anything overdue.
- 8A.3.2 **Finance worklist** → Finance admin. Awaiting verification, awaiting signature, overdue credit, failed executions.
- 8A.3.3 **Exception report** → owners + Observer. Only sent when there is something on it.

**Weekly**
- 8A.3.4 **Business review** → owners + Observer. Revenue and margin by channel, growth against prior week, top agencies, top hosts, top spenders, partner health, credit exposure.
- 8A.3.5 **Payout run** → Finance + owners. Every agency, hosts included, beans, amounts, commission.
- 8A.3.6 **Agency statement** → each agency. Their hosts' performance, their commission earned, what is owed, what was paid.
- 8A.3.7 **Seller statement** → each seller. Bought, lent, sold, paid, outstanding, credit standing.
- 8A.3.8 **Team throughput** → each team admin. Opened, closed, still open, oldest item, what they are blocking for others.

**Monthly**
- 8A.3.9 **Profit and loss** → owners + Observer. Revenue by channel, payouts, commission, write-offs, net margin, month-on-month.
- 8A.3.10 **Partner statements** → every agency and seller — the formal monthly record.
- 8A.3.11 **Accounting pack** → Finance + Observer. Full transaction export in a format the accountant can import.
- 8A.3.12 **Audit summary** → owners + Observer. Every money action for the month by actor and by type.

**Configurable**
- 8A.3.13 Any report can be scheduled to any recipient at any cadence.
- 8A.3.14 Recipients can be internal or external.
- 8A.3.15 Each report can be turned off per recipient — nobody is forced into mail they do not read.

### 8A.4 Immediate alerts — sent the moment they happen
- 8A.4.1 Company bank or gateway details changed → all 3 owners + Observer.
- 8A.4.2 FX feed failed, last known rate held → owners + Finance.
- 8A.4.3 Duplicate payment reference detected → Finance + owners.
- 8A.4.4 Transaction above an owner-set amount raised → all 3 owners.
- 8A.4.5 Execution failed after signature — money did not move → Finance + owners.
- 8A.4.6 Gateway settlement mismatch → Finance + owners.
- 8A.4.7 A queue item breaches its ageing limit → that team's admin, then owners if it persists.
- 8A.4.8 Staff role changed or account deactivated → owners + Observer.
- 8A.4.9 Repeated failed logins on a staff account → owners.

### 8A.5 On-demand reports
- 8A.5.1 Every list in the portal exports to spreadsheet, respecting current filters.
- 8A.5.2 Any report can be run for a chosen date range and emailed on the spot.
- 8A.5.3 Partner statements can be regenerated for any past period — a partner asking about March gets March, calculated at March's rates (9.8).
- 8A.5.4 Exports are logged: who exported what, when (6.4).

### 8A.6 Report standards
- 8A.6.1 Every report states the period, the generation time, and the rates applied.
- 8A.6.2 Money reports state which channel each figure came from — reseller or direct.
- 8A.6.3 The same figure means the same thing in every report. One definition of revenue, one of payout, one of margin.
- 8A.6.4 Reports are generated server-side from the ledger, never from what a browser happened to have loaded.
- 8A.6.5 A report that cannot be generated sends a failure notice. It never sends blank or zero.
- 8A.6.6 Partner-facing statements carry your branding and are safe to forward to their accountant.

### 8A.7 Email infrastructure
- 8A.7.1 Sent from your own domain with proper authentication, so mail reaches the inbox rather than spam.
- 8A.7.2 Templates are managed centrally — Marketing owns the wording, Tech owns the delivery.
- 8A.7.3 Every template is previewable before it goes live.
- 8A.7.4 Partner-facing mail supports the languages of the markets you operate in.
- 8A.7.5 Delivery failures, bounces and unsubscribes are visible in the portal.

---

# PART 9 — DECISIONS TAKEN

These were open. Here is the call and the reasoning.

- 9.1 **Money board scope** — as listed in 5.3. Anything that changes a balance, a rate, a price or a reward cost. Cosmetic and operational work stays with teams.
- 9.2 **Partner onboarding does not need owner signature.** KYC verification is skilled team work, and no money moves at approval. Owners enter at the first payment to that partner, which is where the risk actually is. This keeps you out of paperwork and in control of cash.
- 9.3 **Finance verifies the money facts on every card, regardless of which team raised it.** The raising team's admin verifies business justification. For Finance-domain items this collapses into one step.
- 9.4 **Every rupee is signed, as you specified.** Volume is handled by bulk sign-off and by auto-grouping small routine corrections into one batch card — not by lowering the bar.
- 9.5 **The Observer can export.** Read-only without export is not an audit function. Exports are logged.
- 9.6 **Six departments as listed in 1.5.**
- 9.7 **One interface pattern everywhere** — every queue is a board, every card has an owner, an age and a reason.
- 9.8 **Rate changes are forward-only and versioned.** Historical payouts must always be explainable using the rate in force at the time.
- 9.9 **Sub-agencies are paid through their parent, not around it.** The parent is your counterparty and carries the responsibility; both legs are tracked so an unpaid sub is visible.
- 9.10 **Unrepaid seller credit is recoverable from their balance, with penalty.** Anything not recovered stays an open receivable and is only cleared by an explicit owner write-off.
- 9.11 **FX tracks the market automatically; owners override per country.** Manual rate entry is a source of error and disputes; overrides are deliberate pricing decisions and are signed.
- 9.12 **Gateway payments do not need manual verification.** The settlement is its own proof. This is the single biggest reduction in Finance workload available to you.
- 9.13 **Direct purchase and reseller are reported as separate channels** — different margin, different growth, different risk.
- 9.14 **Work lives in the portal inbox; email is for what you must act on away from it.** Emailing every queue movement trains people to ignore mail, and then they ignore the alert that mattered.
- 9.15 **Reports generate server-side from the ledger and are emailed on a schedule.** Nobody logs in to pull a number, and a report never renders blank — if it cannot generate, it says so.
- 9.16 **Partners get statements automatically.** Agencies and sellers should never have to ask what they are owed; most partner disputes are really information gaps.
- 9.17 **Rejections always carry a reason, in the email.** A partner told "rejected" with no reason reapplies immediately and the work repeats.
- 9.18 **Historical statements recalculate at historical rates**, so any past period can be reproduced exactly.
- 9.19 **No chance mechanic goes live with client-side randomness.** If the phone decides the outcome, a modified app decides your payout. This blocks the existing lucky gift and bet features as much as any future game.
- 9.20 **Lucky gifts and games are one control system, not two.** Same RNG rules, same RTP configuration, same exposure limits, same reporting. Treating lucky gifts as "gifting" hides a gambling risk inside a gifting feature.
- 9.21 **RTP is configured and signed, never implied.** Odds tables are set explicitly, the portal computes the resulting margin, and probabilities must sum to 100 before anything can go live.
- 9.22 **Exposure ceilings auto-suspend the mechanic.** Losing days are certain; unbounded losing days are not acceptable.
- 9.23 **Gross gaming revenue is reported separately** from gifting and calls — different margin, different volatility, different regulatory treatment.
- 9.24 **Country-level enablement is mandatory for every chance mechanic**, whatever the legal outcome, so a market can be switched off immediately without an app release.
- 9.25 **Profit is measured as diamonds consumed per unit of bean payout, not house edge.** Returned diamonds are recirculated inventory; only beans become cash. Games rank highest on this measure because they create no beans at all.
- 9.26 **Effective RTP must never fall as stake size rises.** Whales are most of the revenue; the current 58% single versus 13% at 77× inverts that and is treated as a defect.
- 9.27 **Host earnings are a governed metric, not an outcome.** Game revenue rising while host earnings per active host fall means the ecosystem is being consumed, and alerts owners.
- 9.28 **Level gating stays and extends to stake tiers.** Spend before play; higher stakes require higher levels.
- 9.29 **Games are retention infrastructure, not just margin.** Most users will never gift a host; games keep them present, and their presence is what makes hosting worthwhile. Judged on retention as well as revenue.
- 9.30 **Games must feed the host economy.** Gifting bonuses on winnings, entries earned by gifting, and a tracked share of winnings that reaches hosts (8B.9A.4).
- 9.31 **Transparency is the commercial strategy, not a compliance exercise.** Agencies move for terms and stay for trust; Part 0 is the proposition that wins them from incumbents.
- 9.32 **Every guarantee in Part 0 maps to a screen or an automated statement.** A promise without a supporting record is not made.
- 9.33 **Many small outcomes at a steady edge, not few large extractions.** This produces more total margin over a player's lifetime and is what makes the volume model work. Growth comes from more players, not more taken per player.
- 9.34 **Events and rotation are the retention engine.** Novelty brings players back; intensity burns them out. Every event carries a projected cost and a maximum exposure, signed before launch.
- 9.35 **Free daily entries for everyone.** The users who never spend are the audience that makes hosting worthwhile; retaining them costs nothing and grows the base.
- 9.36 **Complaints are monitored as a rate and treated as a tuning signal.** Users are never restricted for complaining. Restriction requires fraud, abuse or bad faith, with written grounds.
- 9.37 **Chargeback rate is an existential metric.** Processors terminate above threshold, which would end the direct payment channel. Monitored and acted on before a processor acts.
- 9.38 **Regional controls exist for compliance and are logged.** Where a market generates complaints, the mechanic is re-tuned there rather than concealed — concealment leaves the cause in place and raises the stakes.
- 9.39 **Every seller gets a permanent virtual account number.** The bank identifies the payer, so payments verify themselves. This removes the largest manual workload in Finance and eliminates duplicate-payment risk on that channel entirely.
- 9.40 **Screenshots are not evidence.** Where a payment can be proven by the bank or a gateway, that proof is used. Uploaded proof survives only as a fallback for unmigrated sellers, reported separately as residual risk.
- 9.41 **Accounts are separated by function** — collections, payouts, operating, tax reserve — with every inter-account movement authorised and logged. Clear books, and a tax reserve set aside as revenue is recognised rather than found later.
- 9.42 **Daily reconciliation is automatic and every credit must resolve.** Matched, or raised as an exception. Nothing is absorbed by silence.
- 9.43 **The daily cash position is the real revenue number** — actual money received, as distinct from imputed diamond consumption. These are different figures and are reported as such.
- 9.44 **Payouts leave as bank batches generated only from signed cards**, with per-item results written back so a failed transfer is visible rather than lost.
- 9.45 **HDFC eCMS is the implementation**, with the virtual account number formed as HDFC prefix + the seller's existing CRM ID. No new identifier scheme is introduced.
- 9.46 **A business current account in the company's name is the first prerequisite.** It gates virtual accounts, payment gateways, the treasury structure, three-owner governance and clean tax treatment. Nothing in Part 8C proceeds without it.

---

# PART 10 — GAPS IN THE CURRENT BUILD

What the flow above assumes that does not exist today.

**Governance**
- 10.1 No audit log. Balance changes record the literal text "Admin" — with three owners this identifies nobody.
- 10.2 Money is written from the browser, so any log written alongside it can be bypassed. **This blocks everything else in Part 6.**
- 10.3 Permissions are decorative — twenty are stored and editable, none are read.

**Money**
- 10.4 No reconciliation. Nothing proves a claimed payment arrived.
- 10.5 No duplicate detection — the same UTR can be reused indefinitely.
- 10.6 Seller inventory never decrements, so the balance is a purchase total, not live stock.
- 10.7 "Total payout" means four different things on four Finance pages.
- 10.8 No date filtering — no page can answer "this week".
- 10.9 No export anywhere.

**Work management**
- 10.10 No inbox. Staff visit each page to discover work.
- 10.11 No ageing or SLA on any queue.
- 10.12 Report actions are text labels only — choosing "ban user" does not ban anyone.
- 10.13 No dependency or blocked-by link between tickets. A team cannot see what it is blocking for others.

**Partners**
- 10.14 Agencies cannot see their own commission balance or ledger.
- 10.15 Sub-agency payments have two competing debit paths and are not reconciled — a sub balance can be reduced twice for one earning.
- 10.16 Seller credit has no due date, no overdue state, no recovery mechanism and no penalty. Marking a debt repaid records no amount, no proof and no actor — one click clears any sum.

**Money in**
- 10.17 No payment gateway of any kind. Every rupee arrives by manual transfer and is verified by eye.
- 10.17a No virtual account numbers. Payer identity depends on a seller typing a reference and uploading a screenshot, so every payment needs a human and the same proof can be reused.
- 10.17b No bank statement import and no daily reconciliation. Nothing detects an unidentified credit or a missing expected receipt.
- 10.17c No account separation by function and no tax reserve. One account does everything.
- 10.17d Payouts are made manually outside the system, so the portal cannot confirm a transfer succeeded.
- 10.17e **All company revenue collects into a bank account held in one individual's name.** This blocks eCMS, blocks payment gateway onboarding, leaves two of the three owners without legal claim on revenue, and mixes business and personal income. Prerequisite for most of Part 8C (8C.9).
- 10.18 There is no direct user purchase channel — all user revenue flows through resellers at reseller margin.
- 10.19 FX rate is a hardcoded constant. It does not track the market and cannot be set per country.

**Chance mechanics**
- 10.27 **Lucky gift outcomes are rolled on the phone.** A modified app can force a 200× win, and the database rules permit the write. The source itself flags this as must-fix-before-production.
- 10.28 **Bet settlement trusts the game client** — it credits whatever winnings value the WebView reports, verbatim.
- 10.29 The house edge constant is declared and **never used in any calculation**. The real edge sits inside a third-party game client.
- 10.30 Lucky gift combo returns collapse with size — 58% single, 59% at 17×, 27% at 37×, **13% at 77×**. Biggest spenders get worst value, almost certainly unintended.
- 10.31 No prize pool or reserve. Payback is minted on the spot and platform cut can go negative on a large win.
- 10.32 No RTP configuration, no odds table in the portal, no exposure ceiling, no auto-suspend.
- 10.33 No actual-versus-theoretical RTP monitoring, so an exploit would be invisible until the margin moved.
- 10.34 No player protection: no loss limits, no self-exclusion, no cooling-off, no harm flagging.
- 10.35 No country-level gating for chance mechanics, and no age verification gate.
- 10.36 Gaming revenue is not reported as a separate line.
- 10.37 No events calendar, no rotation, no free daily entries — nothing that generates return visits without extraction.
- 10.38 No complaint rate tracking per mechanic or per country, so a mis-tuned game would surface only as churn.
- 10.39 No chargeback monitoring. With no gateway today this is dormant, but it becomes existential the moment direct payment opens.
- 10.40 No per-country enablement for any mechanic, so a market cannot be switched off without an app release.

**Reporting and email**
- 10.20 The only automated email in the entire system is the weekly payout report to one superadmin. There is nothing daily, nothing monthly, and no exception alerting.
- 10.21 Partners receive no statements. An agency cannot see what it is owed, so every question becomes a manual request to staff.
- 10.22 Rejections send no reason, so rejected applicants reapply and the work repeats.
- 10.23 No report generation of any kind — no P&L, no accounting pack, no partner statement, no audit summary.
- 10.24 No exception alerting. A bank detail change, a duplicate payment or a failed execution notifies nobody.
- 10.25 No export anywhere in the portal, so every figure that leaves the system is retyped by hand.
- 10.26 Email delivery is not tracked — a bounced approval notice is lost silently.

**App portal**
- 10.14 Packages, daily rewards and profile options are edited in the CRM and never read by the app.
- 10.15 Level bonuses are advertised to users and never granted.
- 10.16 No live intervention — the monitor is read-only.
- 10.17 No maintenance mode, version control or feature flags.
- 10.18 Rewards are credited client-side, so they can be forged.
