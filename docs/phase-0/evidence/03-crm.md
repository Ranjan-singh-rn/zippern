Sweep complete. Here is the business-readable map of the Zipper CRM.

Repo root: `/Users/soumyaranjansingh/Documents/Projects/zippern`. CRM app: `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm`. Business API: `/Users/soumyaranjansingh/Documents/Projects/zippern/backend`.

---

# 0. The two role vocabularies (read this first)

There are **two** role systems and they are not the same words for the same thing.

| Where | Role names | Defined at |
|---|---|---|
| CRM / Firestore (`crmUsers.role`) | `superadmin`, `{app,ops,finance,tech,support,marketing}_{admin,member}`, `agency`, `seller` | `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/lib/auth.ts:62-79` |
| Business API / Mongo (`staff.role`) | `owner`, `observer`, same twelve department roles, `agency`, `seller` | `/Users/soumyaranjansingh/Documents/Projects/zippern/backend/app/core/roles.py:21-41` |

`superadmin` is the CRM spelling of `owner`, and `observer` exists only on the API side — it deliberately has **no** `crmUsers` document. Evidence: `/Users/soumyaranjansingh/Documents/Projects/zippern/backend/app/services/crm_directory.py:62` and `:133`; `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/layout.tsx:667-670`.

Consequence for every screen: a page that gates on the CRM role grants the superadmin everything by bypass (`/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/lib/auth.ts:1056`, `:1062`), while a page that gates on the **API** role checks `'owner'` instead. Several screens read both (e.g. `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/live/page.tsx:69-78`).

---

# 1. Login and routing

### How a person signs in
Screen: `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/login/page.tsx`. Three doors, plus two public application forms and an observer door, all advertised on the same page (`:893-923`).

1. **Email + password** — `crmSignIn` (`lib/auth.ts:496`). Firebase authenticates, then `resolveCrmUser` (`lib/auth.ts:441`) reads `crmUsers/{uid}` **by uid, never by email** (`lib/auth.ts:438-440`). No record → signed out with "CRM account not found" (`:454`). `isActive: false` → "This account has been deactivated." (`:462`).
2. **Continue with Google** — `crmSignInWithGoogle` (`lib/auth.ts:674`). A Google identity with no CRM document is refused, not adopted (`:744-752`). If the address already has a password account, Firebase refuses and the person must prove ownership with the existing password once, which then links Google to the same uid (`completeGoogleLink`, `lib/auth.ts:766`). An **unverified** email address blocks linking outright, because Firebase would silently remove the password provider (`lib/auth.ts:613-623`).
3. **Observer one-time code** — `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/observer/page.tsx`. No password exists for this account; each sign-in emails a code to a mailbox that is *not* the observer's own address (`app/observer/page.tsx:3-9`). The observer email is `314zipper@gmail.com` by default (`lib/auth.ts:526-528`) and is refused on every Google path (`lib/auth.ts:696-702`, `:729-735`, `:897-917`, `:1176-1182`).

### Extra gate for the top role
A `superadmin` does not go straight in. They answer three personal questions (full name, phone, nickname) every login; first login sets them. `app/login/page.tsx:143-151` (`afterSignedIn`), `:298-320` (setup), `:323-349` (verification, three attempts then forced sign-out).

### Role determination
`crmUsers/{uid}.role`, normalised through a legacy map (`admin→app_admin`, `ops→ops_member`, etc.) at `lib/auth.ts:85-96`. A live Firestore listener keeps it current and force-signs-out the moment `isActive` goes false: `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/components/AuthProvider.tsx:584-608`. The CRM also exchanges the Firebase session for a separate **API session** (`AuthProvider.tsx:552-568`); money and audit screens need it and gate on `apiReady`.

### There is no middleware
No `middleware.ts` exists anywhere in `zipper-crm`. All routing is client-side in `AppShell` (`app/layout.tsx:747-814`).

### The landing-page map
Two tables, not one.

**Partners** — `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/lib/partnerRouting.ts` (the file you asked about; it exists, has no imports, and has a spec at `lib/partnerRouting.spec.ts`):

| Capability | Approved → lands on | Pending/rejected → lands on | Line |
|---|---|---|---|
| `agency` | `/agency-dashboard` | `/agency-pending` | `:43-52` |
| `seller` | `/seller-dashboard` | `/seller-pending` | `:43-52` |

`/profile` is the one shared path a partner may sit on that belongs to no capability (`:79`, matched on a segment boundary at `:93-97`). `partnerLanding` (`:234`) picks the first **approved** capability, primary first, else the primary's waiting room. `resolvePartnerRedirect` (`:256`) returns `null` for anyone who is not a partner, so staff and the observer are untouched. One login can hold both capabilities (`roles[]` + `roleStatus{}` on `crmUsers`, `lib/auth.ts:374-375`); a capability with nothing recorded is **pending**, never approved (`partnerRouting.ts:155-177`).

**Staff** — there is no table. Every non-superadmin goes to `/` (`app/login/page.tsx:149`); superadmins go to `/` after the gate (`:314`, `:348`); the observer goes to `/inbox` (`app/observer/page.tsx:72`).

**Observer** — a hard allowlist of eleven route prefixes, `OBSERVER_ROUTES` at `app/layout.tsx:682-685`: `/inbox`, `/board`, `/audit`, `/team-access`, `/partners`, `/reports`, `/finance`, `/alerts`, `/tech/email`, `/tech/jobs`. Anything else renders "Not available to the observer" (`:735`). They get their own sidebar entirely (`ObserverShell`, `:687-745`).

### How "are you signed in?" is decided
Deliberately isolated in `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/lib/sessionGate.ts:60-84`, with a spec. The governing rule is at `:24`: `crmUser === null` is **not** evidence of being signed out — it is also the value for "record not arrived yet" and "the read failed". Exactly one fact combination means signed out (`ONLY_SIGNED_OUT`, `:91-96`).

### Public vs gated pages
Public, no sidebar, no auth gate: `/login`, `/observer`, `/agency-signup`, `/seller-signup` (`app/layout.tsx:755-758`). Standalone but requiring a known user: `/agency-pending`, `/seller-pending` (`:760-761`).

---

# 2. Navigation and role gating

The sidebar is `Sidebar()` in `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/layout.tsx:388-567`. Three tiers:

- **Always-visible top-level links** (`:101-132`) — Waiting on you, Money Board, Dashboard, Analytics, Reports, Weekly Report, Alerts, App Tickets, Team Tickets, Team Throughput.
- **Collapsible department groups** (`:136-327`) — Users & Hosts, Sellers & Agencies, Finance, Tech, Economy, Chance, Live & Comms, Marketing, Operations, App Config, Admin.
- **Strict partner links** (`:339-342`) — "My Agency" / "My Sales", capability-matched with **no superadmin bypass** (`:329-331`). A dual-capability partner gets `PartnerRoleSwitcher` instead of two loose links (`:441-448`).

Two named role sets drive most of it: `OVERSIGHT_ROLES` = superadmin + all six `*_admin` (`:79-83`), and `STAFF_ROLES` = all thirteen internal roles (`:87-95`).

**Fail-closed**: until the `crmUsers` document arrives, nothing navigable renders — `roleKnown` at `:435`, `NavSkeleton` at `:378`.

### Which menu items each role sees (by group)

| Group | Items and who sees them | Line |
|---|---|---|
| Users & Hosts | Users: SA, app_*, ops_admin, finance_admin, support_*, tech_admin. Hosts + Host Verification: SA, app_*, ops_* | `:140-147` |
| Sellers & Agencies | Onboarding + Statements: all staff. Coin Sellers: SA, app_admin, ops_*. Coin Purchases: SA, finance_*. Seller Sales: SA, ops_*, finance_*. Agencies + KYC: SA, app_admin, ops_admin | `:157-177` |
| Finance | Overview, Cash, Liabilities, Payouts, Withdrawals, Profit, Costs, Owner Capital, Weekly Reports: **SA + finance_admin only**. Credit Book: SA, finance_admin, finance_member, ops_admin | `:189-206` |
| Tech | Overview, Content, Payments: SA, tech_*. Scheduled Jobs, Email Delivery: `OVERSIGHT_ROLES` | `:212-219` |
| Economy | Gift Economy: SA, app_admin, ops_admin. Overview: SA, finance_*, ops_admin. Config: SA, finance_admin. Beans/Diamonds: SA, finance_* | `:225-228` |
| Chance | Mechanics, Configuration, Exposure, Monitoring, Protection: **all staff**. The Money: SA, finance_admin | `:240-246` |
| Live & Comms | Live Monitor: SA, app_*, ops_*, tech_*, support_admin. Feedback: SA, app_admin, support_*, tech_admin, ops_admin | `:252-259` |
| Marketing | Broadcasts: SA, marketing_*. Email Composer: SA + all six admins + marketing_member | `:265-274` |
| Operations | Overview, Reports, Device Bans: SA, ops_*. Moderation: SA, ops_*, app_admin, support_admin. App Feedback: SA, ops_*, support_* | `:280-284` |
| App Config | All seven items: **superadmin only** | `:290-296` |
| Admin | Approvals: SA only. My Profile, Audit Log, Team Access, Team: all staff. Policies: SA, app_admin | `:302-324` |

### How a page refuses an unauthorised visitor
Three different patterns, inconsistently applied:

1. **`<Denied what="…" />`** — a polite panel. The dominant pattern: `/board` has none, but `/kyc:356`, `/agencies/page.tsx:550`, `/sellers/page.tsx:437`, `/users/page.tsx:417`, `/live:390`, `/lending:235`, `/sales:296`, `/moderation:245`, `/reports:283`, every `/finance/*`, every `/chance/*`, `/tech/jobs:394`, `/tech/email:528`, `/seller-dashboard:353`, `/operations/*`.
2. **Silent redirect to `/`** — `/analytics` (`app/analytics/page.tsx:272-274`, `router.replace('/')`), `/operations` (`app/operations/page.tsx:55-58`), every `/app-config/*` (e.g. `app/app-config/levels/page.tsx:286`), `/tech/appcontrol:71`.
3. **Inline "Access Denied" block** — `/broadcasts:50-58`, `/agencies/register:1337`, `/agencies/[id]/salary:178`, `/agency-dashboard:2199`.

### The permission constant each major page checks

| Page | Constant | File:line |
|---|---|---|
| `/kyc` | `PAGE_ROLES` + permission `can_approve_kyc` | `app/kyc/page.tsx:136`, `:202` |
| `/agencies` | `PAGE_ROLES` + `can_approve_kyc` | `app/agencies/page.tsx:44`, `:130` |
| `/agencies/[id]` | `PAGE_ROLES` | `app/agencies/[id]/Client.tsx:54` |
| `/sellers` | `PAGE_ROLES` + `can_approve_seller` | `app/sellers/page.tsx:43`, `:126` |
| `/sellers/[id]` | `PAGE_ROLES` + API `owner` to execute | `app/sellers/[id]/Client.tsx:60`, `:197` |
| `/users`, `/users/[uid]` | `VIEW_ROLES` | `app/users/page.tsx:47`; `app/users/[uid]/Client.tsx:35` |
| `/hosts/verification` | `VERIFICATION_ROLES` | `app/hosts/verification/page.tsx:76` |
| `/live` | `PAGE_ROLES` / `MODERATOR_ROLES` / `INTERVENE_API_ROLES` | `app/live/page.tsx:52`, `:60`, `:78` |
| `/moderation` | `VIEW_ROLES` | `app/moderation/page.tsx:25` |
| `/operations/{reports,bans,appeals}` | `VIEW_ROLES` | `:26`, `:47`, `:45` |
| `/operations/feedback` | `OPS_ROLES` | `app/operations/feedback/page.tsx:194` |
| `/tickets` | `PAGE_ROLES` | `app/tickets/page.tsx:890` |
| `/feedback` | `PAGE_ROLES` | `app/feedback/page.tsx:221` |
| all `/finance/*` | `FINANCE_ROLES` = `['superadmin','finance_admin']` | e.g. `app/finance/cash/page.tsx:47` |
| `/lending` | `PAGE_ROLES` | `app/lending/page.tsx:40` |
| `/sales` | `PAGE_ROLES` | `app/sales/page.tsx:48` |
| `/coin-purchases` | `PAGE_ROLES` | `app/coin-purchases/page.tsx:63` |
| `/reports` | `REPORT_ROLES` | `app/reports/page.tsx:51` |
| `/reports/weekly`, `/alerts`, `/tech/jobs`, `/tech/email` | local `canRead(apiRole)` = owner, observer, any `*_admin` | `:68`, `:61`, `:66`, `:57` |
| `/economy` | `ECONOMY_DOC_ROLES` | `app/economy/page.tsx:106` |
| `/economy/config` | `ECONOMY_CONFIG_ROLES` | `app/economy/config/page.tsx:146` |
| `/economy/currency` | `CURRENCY_PAGE_ROLES` | `app/economy/currency/page.tsx:51` |
| `/broadcasts` | `BROADCAST_ROLES` | `app/broadcasts/page.tsx:18` |
| `/policies` | `ALLOWED_ROLES` | `app/policies/page.tsx:29` |
| `/chance/*` | `CHANCE_READ_ROLES` / `_TEAM_ADMIN_` / `_OWNER_` / `_FREEZE_` / `_MONEY_` | `lib/apiChance.ts:78`, `:94`, `:105`, `:115`, `:123` |
| `/onboarding` | `PAGE_ROLES`, `AGENCY_REGISTER_ROLES`, `SELLER_REGISTER_ROLES`, `KYC_ROLES` | `app/onboarding/page.tsx:37`, `:49`, `:51`, `:53` |
| `/inbox` | `KYC_ROLES`, `APPROVAL_ROLES` | `app/inbox/page.tsx:63-64` |
| `/throughput`, `/tech/tickets` | `STAFF_ROLES` | `:84`, `:262` |

### Contradictions between nav and page
The sidebar already documents five of these in comments; these are the live ones:

- **`/broadcasts`** — the dashboard offers it to app and ops staff (`app/page.tsx:515`), the nav restricts it to Marketing (`app/layout.tsx:265`), and the page refuses with: "Only Marketing team members can send broadcasts." (`app/broadcasts/page.tsx:55`). A link to a wall from the dashboard.
- **`/agencies` and `/sellers`** — pages admit `finance_admin`/`finance_member` (`app/agencies/page.tsx:45`, `app/sellers/page.tsx:45`) but the nav does not list them (`app/layout.tsx:176`, `:159`). Finance can reach both by URL only.
- **`/moderation`** — page admits `app_member` (`app/moderation/page.tsx:26`); nav does not (`app/layout.tsx:281`).
- **`/tickets`** — page admits `tech_member` (`app/tickets/page.tsx:891`); nav excludes them because Firestore's read rule does not cover them (`app/layout.tsx:124-129`), yet the dashboard quick action still offers it to them (`app/page.tsx:517`).
- **`/gifts`** — has **no read gate at all**. Only `canEdit` exists (`app/gifts/page.tsx:487`), so any staff member reaching the URL can read the full gift economy; only writing is restricted.
- **`/tech/appcontrol`** — the kill switch is **not in the sidebar**. Its only entry point is a card on `/tech` (`app/tech/page.tsx:142`).
- **`/team` vs `/team-access`** — the app says so itself: "This screen and /team-access now do the same job" (`app/team/page.tsx:296`), adding that one should go and that is not a decision the page can make (`:302`).

---

# 3. The money board and cards

**Screens**: `/board` (`app/board/page.tsx`), `/inbox` (`app/inbox/page.tsx`), `/approvals` (`app/approvals/page.tsx`).
**Engine**: `/Users/soumyaranjansingh/Documents/Projects/zippern/backend/app/services/cards.py`, routed at `backend/app/routers/cards.py`.
**Client**: `api.cards` at `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/lib/api.ts:752-783` — `list`, `inbox`, `awaitingSignature`, `raise`, `startReview`, `verify`, `sign`, `reject`, `signBulk`.

### The five stages in business terms
Defined at `backend/app/services/cards.py:32-39`; rendered as seven columns at `app/board/page.tsx:34-42`.

| Stage | What it means to the business | Who moves it there |
|---|---|---|
| **Requested** | Somebody has asked for money to move. Nothing has happened. | Anyone who may write — `raise_card`, `cards.py:192`; route is `require_write`, `routers/cards.py:69` |
| **Under Review** | Picked up and being checked. | The verifier — `start_review`, `cards.py:251` |
| **Awaiting Sign-off** | Checked, with a written note saying what was checked, and now needs an owner. | The verifier — `verify`, `cards.py:261`; a note is mandatory (`:264`) |
| **Approved** | An owner has signed. **The money has still not moved.** | Owner only — `sign`, `cards.py:299`; `require_owner`, `routers/cards.py:130` |
| **Executed** | The money actually moved, with the ledger result recorded. | `mark_executed`, `cards.py:407` |

The board says it plainly: "Signed — money has NOT moved" for Approved versus "Money moved" for Executed (`app/board/page.tsx:38-39`).

**Rejected** = refused at any stage before execution, and nothing moved. A reason is mandatory (`cards.py:368-371`); only an owner may reject a card that is already awaiting signature (`:377`). Partner-facing copy keeps the reason but drops internal notes (`cards.py:596-597`).

**Failed** = an owner signed and the transfer did not go through. The card is left visibly stuck rather than silently lost (`cards.py:8`, `:416`). The board shouts about it (`app/board/page.tsx:219-233`) and the panel states that nothing was transferred so nothing needs unwinding, but the request is unmet (`:572-576`). Before this existed, `failed` had no column and the card simply vanished (`app/board/page.tsx:28-33`).

### Who may do each act
`backend/app/core/roles.py`:
- **Raise**: anybody who may write — i.e. everyone except the observer (`roles.py:162`).
- **Verify**: `can_verify_money` (`roles.py:172-191`) — a Finance admin on any card, a team admin on their own team's cards only, or an owner. A member cannot verify.
- **Sign**: `can_sign_money` (`roles.py:167`) — owners only.
- **Execute**: owner-only on every route reached from the partner screens (`app/sellers/[id]/Client.tsx:194-197`, `:849-853`) and for balance cards (`app/board/page.tsx:418`).

### The separation-of-duties rules (enforced server-side, mirrored in the UI)
`cards.py:10-15` lists them; they are enforced at `cards.py:716-729` and `:299-338`:
- You cannot verify a card you raised (`:720`).
- You cannot sign a card you raised (`:311`) — "You raised this card. Another owner must sign it."
- You cannot sign a card you verified (`:316-320`).
- You cannot sign a card that **pays you** (`:334-338`) — added because an owner could otherwise legally sign their own capital card (`:322-333`).
- Nothing skips Under Review, including an owner's card (`cards.py:14`).
- A bank- or gateway-proven payment is `auto_verified` and starts at Awaiting Sign-off (`:201-203`).

The board computes the same two sign rules client-side so the reason appears *before* the click, in amber rather than as a footnote (`app/board/page.tsx:393-414`, `:701-713`), and hides the bulk-select tick box for cards the server would refuse (`:298-300`).

### What each screen is for

**`/board` — Money Board.** For: every staff member, to see the whole pipeline of money requests. Who: all staff (`app/layout.tsx:103`) plus the observer (`:683`); an observer sees a read-only banner (`app/board/page.tsx:194-199`). Actions: open a card, verify with a note, reject with a reason (min 3 chars, `:24`), sign, bulk-sign everything selected, and execute a balance card. Scope: owners and the observer see every team; a team admin sees their team; a member sees their own cards plus their team's (`cards.py:512-520`). A partner sees only cards they raised plus cards raised **about** them, from an allowlist of eight types, with staff names replaced by "Zipper" (`cards.py:491-510`, `:147-158`, `:169`, `partner_view` at `:558`).

**`/inbox` — "Waiting on you".** For: the one page a person opens first, counting all three kinds of work that can wait on somebody. Who: all staff (`app/layout.tsx:102`) and the observer. The three kinds are named at `app/inbox/page.tsx:20-27`: **Money** (cards to verify/sign, from `/board`), **People** (agency/sub-agency/seller/host applications and changed details, decided on `/kyc`), **Permission** (a staff member wanting something their role does not cover, decided on `/approvals`). It counts; it never decides (`:431-437`). A count that could not be read renders as "—", never 0 (`:466`, `:486`).

**`/approvals` — Approval Queue.** For: the superadmin to grant or refuse requests from staff whose own role does not permit the action. Who: superadmin only (`app/layout.tsx:302`, `app/approvals/page.tsx:151`). Twenty-eight request types across agency / seller / team / host / finance / config (`lib/approvals.ts:9-27`). It also carries the KYC applicant rows so the queue can be worked as one list (`components/KycApprovals.tsx:5-26`), though host decisions are explicitly refused here and belong to `/kyc` (`lib/approvals.ts:51-61`).

### Every card type

From `backend/app/services/cards.py:42-113`:

| Type | One-line business description |
|---|---|
| `balance_credit` | Add diamonds or beans to a user's account. |
| `balance_debit` | Take diamonds or beans off a user's account. |
| `seller_coin_purchase` | A coin seller has paid us for inventory; executing is when the coins appear. |
| `lending_issue` | Coin inventory issued to a seller on credit, with a due date. |
| `lending_repay` | A seller repaying credit they were issued. |
| `lending_recover` | Pulling owed coins back out of a seller's stock; may legitimately exceed the debt because a penalty is part of it. |
| `lending_write_off` | Giving up on recovering issued credit. |
| `commission_payout` | Paying an agency the commission it has earned. |
| `subagency_payout` | Paying a sub-agency, which is paid *through* its parent — two legs, and leg 2 is the parent confirming it passed the money on. |
| `host_withdrawal` | A host cashing out their beans. |
| `salary_request` | A salary payment request. |
| `weekly_payout` | The weekly payout run. |
| `rate_change` | A change to a rate — e.g. an agency's commission slab. |
| `pricing_change` | A change to what something costs, e.g. a diamond pack. |
| `fx_override` | A manual override of a currency conversion rate. |
| `promotion` | A promotional giveaway or discount that costs money. |
| `refund` | Money given back to a customer. |
| `bad_debt_write_off` | Writing off a debt judged unrecoverable. |
| `chance_config_change` | The configuration of a lucky gift or game — odds table, stake sizes, maximum single win, enabled countries. Its own type so "every rate change this quarter" does not start returning probability tables (`:69-81`). |
| `operating_expense` | Money leaving the company to run the company — salary, server bill, gateway fee, tax. Category is data on the card, not a separate type (`:85-90`). |
| `owner_capital_in` | An owner putting their own money into the business. **Not revenue** (`:93-111`). |
| `owner_drawings` | An owner taking that money back out. **Not a cost** (`:112-113`). |

The eight a partner may read about themselves: `PARTNER_SUBJECT_CARD_TYPES` at `cards.py:147-158`. It is an allowlist on purpose — a new type is invisible to partners until it is added there, in a diff (`:120-122`).

---

# 4. Partner management

### `/onboarding` — "How partners join"
For: showing the four ways into the business and handing over the two public URLs in copyable form. Who: every internal role (`app/onboarding/page.tsx:37-45`), because a public signup link is what marketing and support need most and can do least harm with (`:34-35`). Three of the four routes were previously undiscoverable (`:5-11`). Each destination is gated separately: agency register = SA + app_admin (`:49`), seller register = SA + app_admin + ops_* (`:51`), review = SA + app_admin + ops_admin (`:53`).

### `/agencies` — Agencies list
For: answering the two questions an owner actually asks — how many hosts is this agency running, and what do we still owe them (`app/agencies/page.tsx:5-7`). Sub-agencies show their parent attached, because a sub-agency is paid *through* its parent and paying one directly is money leaving against a relationship nobody has on record (`:9-13`). Who: SA, app_admin, ops_admin, finance_admin, finance_member (`:44-46`); nav shows the first three only. Actions: approve / reject / deactivate (reason mandatory, min 3 chars at `:48`), gated on `can_approve_kyc` (`:130`); resend the partner email; see "no login attached" badges for orphaned records; and `<FailedRegistrations />` for applicants whose business record never got created. Key statement at `:14-15`: approve, reject and deactivate are team decisions and move no money — a commission payout is a card an owner signs on `/board`.

### `/agencies/[id]` — one agency
For: what this agency earned, what it was paid, and what is still owed, read from the same commission ledger the business settles against (`app/agencies/[id]/Client.tsx:5-8`). Lifecycle actions at `:439-462`: **approve**, **reject** (reason stays on the record, because an applicant told nothing simply reapplies — `:12-15`), **deactivate**, **reactivate**. Money actions: **raise a commission payout** (`:571`, `:945`) and **raise a sub-agency payout** (`:963`) — both raise cards; nothing leaves the account here (`:16-18`). **Confirm leg 2** (`:1199`, `:1209`) is the parent confirming it passed a sub-agency's money on; between the two legs the sub may not have been paid at all and the screen says so (`:19-22`). Contact, bank and KYC details are read from Firestore, never written (`:24-26`).

### `/agencies/[id]/salary` — Salary management
For: an agency's host salary requests. Who: SA + app_admin for the page (`app/agencies/[id]/salary/Client.tsx:77`); approving/paying needs finance_admin or SA (`:76`). Statuses: pending → approved → paid → distributed, or rejected (`:33`).

### `/agencies/register` and `/sellers/register` — staff-filed applications
Who: agency = SA + app_admin (`app/agencies/register/page.tsx:133`, `:1333`); seller = SA + app_admin + ops_* (`app/sellers/register/page.tsx:197`). Both create the **login first** so a duplicate-address refusal costs nothing, then the business record, then the `crmUsers` document (`app/agencies/register/page.tsx:13-27`). A non-superadmin cannot write the record, so the form files an `approvalRequests` document instead (`:31-33`, `:799`). Two things worth quoting: the plaintext CRM password used to be stored on that approval request and is not any more (`app/agencies/register/page.tsx:29-41`); and a seller is now **always created holding zero** inventory, with any opening load raised as a signed card (`app/sellers/register/page.tsx:6-24`).

### `/sellers` — Coin sellers list
For: what each seller holds and what they owe, on one screen for the first time (`app/sellers/page.tsx:5-7`). Credit standing drives the ordering: an overdue seller is blocked by the API from taking new inventory, so they are lifted to the top as a recovery worklist (`:9-13`). Who: SA, app_admin, ops_*, finance_* (`:43-46`). Actions: approve / reject / deactivate, gated on `can_approve_seller` (`:126`). Stated at `:15-17`: these move no money and need no owner signature; anything that moves money is a card raised from `/lending` or `/coin-purchases`.

### `/sellers/[id]` — one coin seller
For: what they hold, what they owe, and — on the first tab — what has actually passed between the business and this person between two dates, in rupees (`app/sellers/[id]/Client.tsx:10-19`). It reads the **same route the seller's own portal reads**, so what we tell them and what we tell ourselves cannot drift apart (`:16-18`). Rules made visible rather than met as a failed request (`:20-32`): an overdue seller cannot take new inventory and the button says why in the API's own words; lending, repayment, recovery and write-off all raise cards; recovery may exceed the debt and the shortfall stays an open receivable. Execute is owner-only on all five card types (`:849-853`, `:875-896`).

### `/partners` — Partner statements
For: an agency or seller seeing exactly what it earned, what it was paid, and what is outstanding — described as the thing that does not exist in the product today and the reason an agency would move here from somewhere else (`app/partners/page.tsx:5-8`). Three tabs: agency, seller, exposure (`:24`). Who: all staff (`app/layout.tsx:158`) and the observer (`:683`). A partner opening the same screen sees only themselves, enforced by the API (`app/partners/page.tsx:10-11`).

### `/kyc` — KYC review
For: deciding whether an applicant is who they say they are and may trade. Four queues because they are reviewed by different people against different documents: main agency, sub-agency, coin sellers, hosts (`app/kyc/page.tsx:5-7`), plus a fifth, **"Changed details"** — an already-approved partner who has since asked to change their bank account or identity (`lib/reviewQueues.ts:72-78`). Who: SA, app_admin, ops_admin (`app/kyc/page.tsx:136`); deciding needs `can_approve_kyc` (`:202`). Actions: approve, reject, or **register** — creating a missing business record so it can then be approved like any other (`lib/reviewDecisions.ts:36`; `app/kyc/page.tsx:26-30`). An empty queue says which of three things it is: nothing submitted, a source could not be read, or records read but none reviewable (`:32-36`).

### Lifecycle summary, by stage

| Stage | Agency | Coin seller |
|---|---|---|
| Applied (self-service) | `/agency-signup` → record + pending login | `/seller-signup` → record + pending login |
| Applied (staff-filed) | `/agencies/register` (SA/app_admin) | `/sellers/register` (SA/app_admin/ops_*) |
| Under review | `/kyc` main-agency or sub-agency queue; partner sits on `/agency-pending` | `/kyc` coin-seller queue; partner sits on `/seller-pending` |
| Approved | `/agencies/[id]`: commission payouts, sub-agency payouts, salary | `/sellers/[id]`: coin purchases, lending, repayment, recovery, write-off, sales |
| Changed details | `/kyc` "Changed details" queue — live fields stay untouched until decided (`app/kyc/page.tsx:79-98`) | same |
| Deactivated / reactivated | `/agencies/[id]:455-462` | `/sellers/page.tsx` row actions |
| Second capability | `SecondRoleCard` on their own dashboard files an application into the staff queue; nothing is granted until a reviewer approves with a mandatory reason (`components/SecondRoleCard.tsx:12-19`) | same |

---

# 5. User and host management

### `/users` — Every registered user
For: finding any account and acting on it. Who: SA, app_*, ops_*, finance_admin, support_*, tech_admin (`app/users/page.tsx:47-50`). The profile is read from Firestore because that is where the Android app keeps it; everything done *to* an account goes through the audited API (`:5-9`). Three refusals stated up front at `:11-22`: it will not filter a partial fetch and call it an answer, will not search only what is loaded, and will not hide a button that might be refused.

### `/users/[uid]` — one account
For: one account and everything that has been done to it, from the append-only audit log (`app/users/[uid]/Client.tsx:3-10`). Tabs: Activity, Warnings, Diamonds, Beans (`:42-47`). `previousBanReason` is shown so a repeat offender does not look identical to a first-timer (`:11-13`).

**Actions** (`app/users/[uid]/UserActions.tsx`, every one API-audited against a named person, every one requiring a reason — `:12-14`):

| Action | What it does | Line |
|---|---|---|
| Suspend | Account restricted, device **not** barred, other accounts on that phone unaffected | `:221`, `:501` |
| Resume | Lifts a suspension | `:239`, `:508` |
| Ban | Account restricted **and every device it has been seen on is barred** | `:276`, `:481` |
| Unban | Lifts this account's bans | `:257`, `:490` |
| Warn | Records a warning on the account | `:295`, `:515` |
| Grant host | Makes the account a host, optionally against an agency | `:310`, `:518` |
| Revoke host | Removes host status | `:325`, `:521` |
| Make / Remove seller | Toggles the seller flag | `:340`, `:350`, `:524-527` |
| Adjust balance | **Raises a card.** Nothing moves until an owner signs — the panel says so in those words | `:361`, `:531`, `:15-17` |

Ban↔Unban and Suspend↔Resume are two pairs, not one pair and two spellings; the server refuses the wrong one by name, so only the matching lifting action is offered (`:19-34`). Account states shown: active, suspended, banned, deletion pending, deleted (`:119-124`).

### `/users/[uid]` host panel
`app/users/[uid]/HostRecord.tsx` — the host's application, KYC, recruiting agency, agreed rate, who checked the documents, and whether the face capture is done. **It reads; it does not decide** (`:16-22`) — no approve or reject button, because a third surface writing `status` is how the two status fields drifted apart. It links to the queue that owns the decision. "No host application" and "the application could not be read" render differently (`:24-28`).

### `/hosts` — Host Management
For: all verified hosts on the platform (`app/hosts/page.tsx:687-688`). Who: SA, app_*, ops_* (`:500`). Actions: ban (via the audited `api.users.ban`, `:588`), unban (`:605`), grant host (`:618`), revoke host (`:631`), and propose edits to payout/identity fields through `submitPartnerUpdate` — the only shape of write the rules accept (`:9-11`, `:177`). Nothing here writes a host application directly any more.

### `/hosts/verification` — Host identity verification
For: comparing the photograph the agency uploaded at registration against the host's own live capture in the app. Anything the comparison cannot settle waits here for a person (`app/hosts/verification/page.tsx:5-9`). Who: SA, app_*, ops_* (`:76-78`), and **not** the observer (`:474`). Why it matters commercially (`:16-23`): an unverified host's weekly earnings are not released, their own call rate is held at base however high the agency set it, and the badge, featuring and PK battles are gated. The photographs are treated as biometric data under India's DPDP Act — signed URLs are fetched only when a reviewer opens a case, held in component state, dropped when closed, and never logged (`:25-34`). Actions: approve or reject with a note of at least 3 characters (`:80-81`).

### `/moderation` — one moderation queue
For: open reports, recent device bans and recently actioned accounts on one page, newest first, so the shape of a day's work is visible (`app/moderation/page.tsx:5-9`). Who: SA, ops_*, app_*, support_admin (`:25-27`). Read-only — every row links to the screen where the work is done. The accounts column comes from the audit log, so it names the person who acted, not "Admin" (`:11-12`).

### `/live` — Live Monitor
For: watching active rooms and acting on them. Who to watch: SA, app_*, ops_*, tech_*, support_admin (`app/live/page.tsx:52-57`). Who to moderate a host: app_* and ops_* only (`:60`). Who to **end a stream or mute a host**: owner, ops_admin, ops_member only, read off the **API** identity (`:62-78`). Actions: warn, ban, end stream, mute. Nothing on this page writes to Firestore (`:5-10`); ending a stream used to be an unaudited browser write with no actor and no reason, and the control was removed rather than fixed until the API endpoint existed (`:12-18`). Three things it refuses to hide (`:20-29`): the polling interval is visible and pausable; ending a room only flags it, so the stream stops when the host's client reads the flag; and muting is a flag **the Android app must honour** — the API is not in the media path and cannot silence anybody.

---

# 6. Finance

Every page under `/finance` is `FINANCE_ROLES = ['superadmin','finance_admin']` plus the observer. The reason is stated at `app/layout.tsx:183-188`: the API's `_require_business_financials` admits only `can_read_all` or a team admin, so listing `finance_member` put them on screens where every figure came back 403 — "which reads as the CRM being broken rather than as a boundary".

| Page | The financial question it answers | What it lets you do | Evidence |
|---|---|---|---|
| `/finance` | How much came in this week, what do we owe right now, what is waiting on us, what is overdue or stuck | Navigate; nothing is computed in the browser, every figure is a field the API published | `app/finance/page.tsx:4-24` |
| `/finance/cash` | Pick a week, get the receipts. Protects the distinction that **cash received is not diamond-consumption revenue** | Date-range, export CSV | `app/finance/cash/page.tsx:4-15` |
| `/finance/liabilities` | What is owed right now — point in time, so no date range. Net position = seller receivable less everything owed to agencies and hosts | Read, export | `app/finance/liabilities/page.tsx:4-19` |
| `/finance/payouts` | Which weekly agency reports await a decision, and which payout cards were **signed and never executed** | Approve / reject a weekly report with a reason; date-range, search, export | `app/finance/payouts/page.tsx:4-26` |
| `/finance/withdrawals` | Which host cash-outs are pending, and which are **approved but not paid** — money signed off that has not left the business | Approve, reject with a reason, mark paid with UTR/reference/screenshot | `app/finance/withdrawals/page.tsx:4-27`, `:42`, `:124` |
| `/finance/profit` | Margin, bean-payout ratio, revenue over time, reseller vs direct split | Date-range, bucket toggle (day/week/month), export | `app/finance/profit/page.tsx:4-24` |
| `/finance/costs` | What it costs to run the company — the second half of "profit = money received for coin minus all expenditure", which had nowhere to be entered | Raise a cost card (goes to `requested`; a second person verifies, an owner signs, then an owner marks it paid); repeat a recurring cost | `app/finance/costs/page.tsx:4-28`, `:279-282` |
| `/finance/capital` | What each owner has put in, taken back, and is still owed. **Neither is trading and neither reaches profit** | Record a capital movement (raises a card); settle a signed card — owner only | `app/finance/capital/page.tsx:4-29`, `:176`, `:423`, `:611` |
| `/finance/reports` | The weekly payout run, one row per agency, for the week you pick — the same endpoint the CSV renders | Pick a week, expand per-host, export | `app/finance/reports/page.tsx:4-24` |
| `/lending` | The whole credit book on one page: what is out, what is late, and per seller what was lent, repaid and still owed | Raise lending / repayment / recovery / write-off cards — none take effect here | `app/lending/page.tsx:4-19`; who: SA, finance_*, ops_admin (`:40-42`) |
| `/sales` | Whether a seller's inventory has actually come down — "the screen that makes inventory come down" | **File** a sale (records the claim, leaves it pending); **approve** a sale, which is owner-only and where value moves | `app/sales/page.tsx:4-26`, `:282`; who: SA, ops_*, finance_* (`:48-50`) |
| `/coin-purchases` | Where money genuinely enters the business — a seller paying for inventory | Raise and verify a purchase card; run a **live** duplicate-UTR check; work the Firestore seller queue that previously reached nobody | `app/coin-purchases/page.tsx:4-29`; who: SA, finance_* (`:63`) |
| `/economy` | Reference guide to every rate, slab and calculation rule, live from Firestore. **Read-only documentation** | Links out to `/economy/config`, `/economy/currency`, `/finance/reports`, `/approvals` | `app/economy/page.tsx:154-155`, `:158-236`; who: SA, finance_*, ops_admin (`:106`) |
| `/economy/config` | What the rates and commission slabs currently are, and changing them | A superadmin saves directly; everyone else submits for approval — the button literally changes label | `app/economy/config/page.tsx:308`, `:731`; who: SA, finance_admin (`:146`) |
| `/economy/currency` | Beans, diamonds and seller credit for one account | Raise a balance-change, lending, repayment or recovery card. Due date is **required** on lending | `app/economy/currency/page.tsx:4-29`; who: SA, finance_* (`:51`) |

Three things `/finance` screens share and state repeatedly: `empty: true` renders as "no data for this period" and never ₹0, because a confident zero is worse than an error since nobody double-checks a zero (`app/finance/page.tsx:20-24`); `provisional: true` means a rate was missing and a documented fallback was used, said above the number; and a read that failed is never rendered as zero.

`/economy/currency` is worth flagging historically: it used to move money straight from the browser, making the whole approval chain optional for anyone who opened it (`app/economy/currency/page.tsx:5-13`). Firestore rules now refuse those writes outright.

---

# 7. Operations and support

| Page | For | Who | Actions |
|---|---|---|---|
| `/operations` | Ops dashboard: open reports, banned devices, ops tickets, feedback counts | SA, ops_* (`app/operations/page.tsx:24`); unauthorised are silently redirected to `/` (`:55-58`) | Navigate |
| `/operations/reports` | The report queue — deciding what happens to a reported account | SA, ops_*, app_*, support_admin (`:26-28`) | warn / suspend / ban / deduct / dismiss. Every decision calls the API, which **carries it out** — previously the queue recorded decisions that were never enforced and the reporter was told it had been dealt with (`:5-10`) |
| `/operations/bans` | Device bans — "is this device banned?" The replaced page masked every id and had no search, so the one question it exists to answer could not be answered (`:5-9`) | SA, ops_*, app_* (`:47-49`) | Search by full device id; lift a ban (deletes the record, because the app only checks existence). Distinguishes **cascade** bans (from banning an account, lifted only when every source account is unbanned) from **manual** bans (`:15-27`) |
| `/operations/appeals` | The return path — the only queue where a decision is questioned, and the only one whose top row is a person currently locked out | SA, ops_*, app_*, support_admin (`:45-47`) | Uphold or overturn, reason min 10 chars (`:49`). **Oldest first, not a preference** — waiting costs the appellant every day (`:11-17`). Overturning is not one thing: a ban lifts immediately, a warning stays marked overturned, and beans already paid out need a new owner-signed movement — so two lists, `reversed` and `outstanding`, are shown every time (`:19-28`) |
| `/operations/feedback` | App feedback, the Operations view of `feedbackTickets` | ops_*, support_* (`:194`) | Change status, assign |
| `/feedback` | The **support-team** view of the same collection | SA, app_*, support_*, tech_admin, ops_admin (`app/feedback/page.tsx:221-223`) | Same |
| `/tickets` | App support tickets — the queue of things users have asked us for. A kanban, with search, priority/category/assignee filters, and an age against a priority-dependent target | support_*, tech_* (`app/tickets/page.tsx:890-892`) | Move status, assign, close with a mandatory reason recorded on the document (`:14-15`) |
| `/inbox` | See section 3 | all staff + observer | counts only |
| `/alerts` | Exception alerts. Three separate questions kept separate: **Open now** (every detector run live), **Raised** (the suppression record that answers "I was not told"), **Watched** (the catalogue of detectors, thresholds and who is told) | owner, observer, any `*_admin` (`app/alerts/page.tsx:61-63`); nav uses `OVERSIGHT_ROLES` | Release a raised alert so it can fire again — **owners only** (`:50-56`), reason min 8 (`:48`) |
| `/throughput` | Is the team keeping up? Cards raised, verified, signed, executed and rejected in the period, with median time per stage and the oldest item still open | all staff (`app/throughput/page.tsx:84`) | Date range, team filter (scoped by the API, not the page), export. **Medians not averages**, and a stage nobody completed shows "—" not 0 (`:9-17`) |

The `/feedback` vs `/operations/feedback` pair had a real, documented data bug: the two screens read the same collection with **different status vocabularies**, so a ticket support moved to `assigned` vanished from the Ops page (`app/operations/feedback/page.tsx:5-21`). The fuller vocabulary `open → assigned → in_progress → resolved → closed` won, with `in_review` mapped as a legacy alias on read.

---

# 8. Tech

| Page | For | Who |
|---|---|---|
| `/tech` | Tech dashboard — open tickets, gifts, levels. The entry point to App Control | SA, tech_* (`app/tech/page.tsx:37`, `:67`) |
| `/tech/appcontrol` | **The kill switch.** Maintenance mode + message, force update + minimum version, and ten feature flags | SA, tech_* (`app/tech/appcontrol/page.tsx:71`); unauthorised redirected to `/` |
| `/tech/content` | Gifts and bag items — create, edit, toggle, upload Lottie/animation assets | SA, tech_* (`:707`, `:723`) |
| `/tech/payments` | Which payment methods are enabled, per country: offline, Stripe, Razorpay, UPI, Google Play | SA, tech_* (`:75`, `:121`) |
| `/tech/jobs` | **The jobs board** — "is any of this actually running?" | owner, observer, any `*_admin` (`app/tech/jobs/page.tsx:66-68`) |
| `/tech/email` | The email delivery log — "did the agency actually get their rejection reason", and "why has nothing arrived" | owner, observer, any `*_admin` (`app/tech/email/page.tsx:57-59`) |
| `/tech/tickets` | Team tickets — the internal kanban every department shares, with blocking dependencies | all staff (`app/tech/tickets/page.tsx:262`) |

### The kill switch in detail
`app/tech/appcontrol/page.tsx`. Ten feature flags, each one a line of business you can switch off (`:34-45`): Live Streaming, Voice Calls, Gift Sending, Lucky Gifts, Leaderboard, Coin Shop, Bean Withdrawal, Referral Program, Events, Agency Portal. Plus maintenance mode with a customer-facing message, and force-update with a minimum version (`:47-53`).

The important business rule: **a superadmin's Save writes immediately; a tech_admin's or tech_member's Save becomes an approval request.** `:103-120` — `if (isSA)` writes `appConfig/control` directly, else `submitApproval({ type: 'update_config' … })` and the screen reports "Change submitted — awaiting superadmin approval." Flags new to the code are merged in as **enabled** on read (`:88-95`).

### The jobs board in detail
`app/tech/jobs/page.tsx:4-29`. The premise: nothing in this system schedules itself — Cloud Scheduler fires a Cloud Function, the function calls an endpoint, the endpoint records a run, and any one of the three can be missing, in which case the symptom is silence that looks exactly like a quiet week. So five outcomes are kept apart and never collapsed:

- **ok** — it ran and everything in it worked.
- **degraded** — it ran, delivered what it could, and something in it did not. Not a success and not a failure.
- **failed** — it raised and sent nothing.
- **never** — no run has ever been recorded; the schedule was never wired up. The loudest thing on the page, because it is the failure mode nobody notices.
- **unknown** — the run log itself could not be read; says nothing about whether the job ran.

`stalled` is independent: a job whose last run was ok three weeks ago is rendered as loudly as `never`. Re-running is offered behind a confirm with a reason (min 8 chars, `:48`) and states that the run will be recorded as person-triggered. **The observer reads the page in full and is offered no re-run at all** — `canRead` includes them, `canTrigger` does not (`:62-72`).

Email delivery keeps four outcome groups apart for the same reason (`app/tech/email/page.tsx:46-66`): sent/delivered, failed (**including `queued`**, because a stuck row means the outcome is genuinely unknown, which is not the same as delivered), withheld (a deliberate decision not to send — not a failure), and in flight. Failures are shown first because a bounced payout receipt is money the recipient does not know about (`:10-14`).

---

# 9. App configuration

`/app-config` and all six subpages are **superadmin only** (`app/layout.tsx:290-296`; each page e.g. `app/app-config/levels/page.tsx:286`, `:294`). The premise: all hardcoded app data migrated to Firestore so it can be managed without shipping a new APK (`app/app-config/page.tsx:70`).

| Page | What it configures | Evidence |
|---|---|---|
| `/app-config` | Hub listing the six sections | `app/app-config/page.tsx:8-54` |
| `/app-config/bag-items` | Minimum user and host level to unlock each cosmetic item — frames, chat bubbles, profile cards, ID frames, entrances | `:12-14` |
| `/app-config/packages` | User recharge packages (Diamond Shop), seller wholesale diamond packs, seller coin packages, plus local prices per country | `:19-21`, `app/app-config/packages/page.tsx:525-526` |
| `/app-config/daily-rewards` | The 7-day login streak: diamonds and video call cards, resetting if a day is missed | `:26-27`, `app/app-config/daily-rewards/page.tsx:91-92` |
| `/app-config/profile-options` | Hobbies, likes, live categories, support categories, max languages shown in profile setup | `:33-34` |
| `/app-config/levels` | XP and bean thresholds for user levels 0–20 and host levels 0–10, with unlocked frames, entrances and bonus rewards | `:40-41` |
| `/app-config/payment-creds` | The bank account and Binance UID shown to sellers when they buy coins. **Changing these takes effect immediately** | `app/app-config/payment-creds/page.tsx:134-135` |

A note on `payment-creds`: the form deliberately **starts empty** and shows what it actually found, because the live IFSC, account number, holder name and Binance UID used to be written into the source file as defaults, shipping the real account in every bundle (`:13-22`).

### Also configuration, but owned elsewhere

| Page | What it configures | Who | Evidence |
|---|---|---|---|
| `/gifts` — Gift Economy | Every gift: price, category (normal/exclusive/lucky), bean value, Lottie animation, active/inactive | **Editing**: SA, app_admin, ops_admin, ops_member (`app/gifts/page.tsx:487`). **Reading: ungated** — no `Denied`, so any staff URL reaches it | `app/gifts/page.tsx:487`, `:573` |
| `/policies` | Privacy Policy, Terms of Service, FAQ, per locale | SA, app_admin (`app/policies/page.tsx:29`, `:282`) | Save a draft (`:90`), then **Publish** behind a warning (`:104-109`, `:219`) |
| `/broadcasts` | In-app announcements — a Firestore document the Android app reads | SA, marketing_* (`:18`) | Send |
| `/broadcasts/email` | Email broadcasts, through the same delivery layer as payout receipts, so a broadcast appears in `/tech/email` beside them | Nav: SA + all six admins + marketing_member (`app/layout.tsx:274`). Page gates on the **API** identity (`app/broadcasts/email/page.tsx:633`) and greys out what the person cannot do, with the API's reason on each | What it can reach is graded by audience **inside the API**: a support or ops admin may write to one named customer, a marketing admin to every agency or seller, and **only an owner to every app user** (`app/layout.tsx:266-275`) |

Four safety features on the email composer, each for a specific way a mass email goes wrong (`app/broadcasts/email/page.tsx:12-23`): the audience count is loaded live before the send and arrives with a sample; and a large audience must have its **exact number typed back** — not a dialog with an OK button, because those are dismissed by muscle memory — with the server enforcing the same check independently.

---

# 10. Team and governance

| Page | For | Who | Actions |
|---|---|---|---|
| `/team` | Team management, grouped by department, with a search | all staff (`app/layout.tsx:324`) | Invite member, change role, revoke access, send a password reset. Every mutation goes through the API, which writes **both halves** of a staff account — the CRM record and the Mongo `staff` row (`app/team/page.tsx:16-19`). The roles the invite form offers are computed server-side, so it cannot offer one that would be refused (`:30-33`) |
| `/team-access` | Staff access — the smaller screen, same three mutations | all staff (`app/layout.tsx:307`) and the observer (`:683`) | Invite, change role, revoke. "Nobody sets a password here" — the invited person gets a link and sets their own; the inviter never sees it (`app/team-access/page.tsx:10-12`) |
| `/audit` | Who, when, what changed, and why. Append-only — no edit and no delete, **including for owners** | all staff (`app/layout.tsx:306`) and the observer | Filter by action group (Money / Approval / Partners / Users / Config / Access), actor, subject, date; search (`app/audit/page.tsx:20-26`). **Scope narrows by role**: owners and the observer see everything including each other, a team admin sees their team, everyone else sees themselves (`app/audit/page.tsx:6-9`; enforced at `backend/app/core/roles.py:199`) |
| `/observer` | Observer sign-in | public, no Firebase session needed (`app/layout.tsx:754-756`) | Request a one-time code, enter it, land on `/inbox` (`app/observer/page.tsx:40`, `:60`, `:72`) |
| `/profile` | One screen, three audiences — staff, agency owner, coin seller — each seeing their own record | all staff (`app/layout.tsx:305`) and partners, via `PARTNER_SHARED_PATHS` (`lib/partnerRouting.ts:79`) | Edit **yours**: display name, phone, personal email, address, photo (plus a seller's city and desk description). See **theirs** clearly locked with the name of whoever can change it: salary, employment id, field charge, department, role, start date. Connect Google; send yourself a verification email (`app/profile/page.tsx:12-30`, `:537`, `:571`, `:606`) |
| `/analytics` | Growth, retention and revenue trends: user growth over 30 days, revenue by month, top 10 hosts by beans, role distribution | SA, app_*, finance_*, ops_* (`app/analytics/page.tsx:272`); unauthorised **silently redirected** | Refresh (which actually refetches, not re-reads the memo) |
| `/reports` | The reporting hub: one date range applied to eight reports, one Download CSV per report, nothing computed client-side | `REPORT_ROLES` = SA, finance_*, and all five other `*_admin` (`app/reports/page.tsx:51-55`) plus the observer (`:200`). Nav is narrower (`OVERSIGHT_ROLES`) and says why: a finance_member would see seven of eight cards refuse (`app/layout.tsx:112-118`) | Date range, export. Each report is fetched independently so a 403 on one leaves the other seven readable (`app/reports/page.tsx:21-23`) |
| `/reports/weekly` | The owner's Sunday business report, on screen. It reads back the **stored, immutable** document keyed on the ISO week — what was recorded on the day, not a recomputation against a ledger that has moved | owner, observer, any `*_admin` to read (`app/reports/weekly/page.tsx:68-70`); **trigger** excludes the observer (`:74-75`) | Pick any of 52 weeks, re-run the report with a reason (min 8 chars). A failed section says so in its own words; `empty` is not ₹0; and the profit figure carries an upper-bound caveat **above** it whenever an expenditure line is unrecorded (`:13-25`) |

### What the Observer screen shows
Not one screen — a whole alternative shell. `ObserverShell` at `app/layout.tsx:687-745` renders its own eleven-item sidebar: Waiting on you, Money Board, Weekly Report, Reports, Finance, Alerts, Scheduled Jobs, Email Delivery, Audit Log, Statements, Team Access. The footer badge reads "Read only" (`:717-719`). Anything outside `OBSERVER_ROUTES` shows "Not available to the observer" with the explanation that the page reads and writes directly so it is not part of the read-only view (`:732-740`).

Why they are built this way: the observer has no Firestore `crmUsers` record **on purpose**, because the old role vocabulary has no read-only tier and mirroring them there would grant full write access (`app/layout.tsx:667-670`). `/reports` and the whole `/finance` prefix are deliberately included — the observer's whole point is seeing the business including the money, and leaving it out would have hidden the money from the one role that exists to watch it (`:671-678`). `/tech/email` and `/tech/jobs` are listed individually and `/tech` is **not**, because prefix matching would otherwise open Content, Payments and App Control (`:679-681`). The API enforces it independently: `can_write` returns false for the observer (`backend/app/core/roles.py:162`), and `can_read_all` is true (`:194`).

### The chance screens (`/chance/*`)
`lib/apiChance.ts` names the four authority tiers, each traced to the API dependency it mirrors:
- `CHANCE_READ_ROLES` (`:78-86`) = all thirteen internal roles — the endpoints are `require_internal`, so the observer reads them too.
- `CHANCE_TEAM_ADMIN_ROLES` (`:94-98`) = SA + all six admins — preview a table, create a mechanic, propose a configuration, suspend a mechanic, review a protection flag, impose a limit, decide a lift request. A member is refused.
- `CHANCE_OWNER_ROLES` (`:105`) = superadmin only — activate a signed configuration, resume a suspended mechanic, withdraw a market.
- `CHANCE_FREEZE_ROLES` (`:115`) = superadmin + ops_admin — freezing a player has **two guards and the narrow one wins**: the route is `require_team_admin`, the service then refuses anyone who is not Ops or an owner, so an Ops member fails the route and a Finance admin fails the service (`:107-114`).
- `CHANCE_MONEY_ROLES` (`:123`) = superadmin + finance_admin.

| Page | For |
|---|---|
| `/chance` | Every lucky gift tier and every game, and what each one actually is right now. Exists to make it impossible for a mechanic that is stopped, unconfigured or enabled in no country to look like a running one (`app/chance/page.tsx:4-12`) |
| `/chance/configure` | "The screen that decides the margin." The **server** computes RTP while you type — every keystroke re-posts the draft, and the preview function is the same one that gates the proposal, so what is previewed is what will be enforced (`:4-16`) |
| `/chance/exposure` | What each mechanic has taken, what it has paid, and how close it is to the stops the business signed for. Suspend = team admin; **resume = owner**, because a mechanic that stopped by paying past a signed limit is a decision about money (`:18-23`) |
| `/chance/monitoring` | Actual RTP against configured RTP, reported as a confidence bound with the round count, refusing to call anything divergent below a minimum sample (`:4-14`) |
| `/chance/protection` | The player-protection review queue. "A flag is not a conclusion" — it leaves `open` only through a decision from a fixed vocabulary with a reason of at least eight characters, and "no action" is recorded as carefully as the others. Self-exclusions and cooling-off periods are **rendered read-only**, because there is no route that cancels or shortens one (`:6-24`) |
| `/chance/money` | Gross gaming revenue, the margin model, and the cannibalisation report. Gated **narrower than the API** on purpose — business-wide money is not Marketing's (`:17-20`) |

---

# 11. Agency and seller self-service portals

### `/agency-signup` and `/seller-signup` — public application forms
Who uses them: a prospective agency or coin seller with **no account at all**. They are the only two CRM pages with no sidebar and no auth gate (`app/layout.tsx:757-758`), reachable from `/login` (`app/login/page.tsx:908-923`) and handed out as copyable URLs from `/onboarding` (`app/onboarding/page.tsx:12-14`).

Order of operations, and why (`app/agency-signup/page.tsx:20-35`): the **login is created first**, because it is an authoritative server-side uniqueness test on the address that writes nothing when it refuses; then — now signed in — the duplicate query runs, matched against the caller's own verified email, which is the only shape the Firestore read rules allow an applicant; then the business record; then the `crmUsers` document. If the last step fails, the record is left in place deliberately, because it is a real application somebody has to decide about, and `/agencies` badges it "no login attached" for staff (`:36-38`). "Continue with Google" replaces step 1 and nothing else (`:40-46`). Both forms always create the account `status: 'pending'` (`lib/auth.ts:1316`, `:1377`).

### `/agency-pending` and `/seller-pending` — the waiting rooms
Who uses them: an applicant whose capability is not yet approved. They are standalone full-screen pages that still require a known user (`app/layout.tsx:780-784`). Content: "Application Under Review", a 1–2 business day estimate, what happens next, the email address the decision will go to, and a sign-out button (`app/agency-pending/page.tsx:28-56`; `app/seller-pending/page.tsx:25-47`). **No actions beyond signing out.** An approved partner sitting here is *not* bounced off — that is deliberate, preserved behaviour (`lib/partnerRouting.ts:206-208`).

### `/agency-dashboard` — "My Agency"
For: "Manage your hosts and salary requests" (`app/agency-dashboard/page.tsx:2272-2273`). Who: a login holding an **approved** `agency` capability (`app/layout.tsx:340`, matched with no superadmin bypass). An agency account with no linked record gets "Agency Not Linked" (`:2210`).

What a partner can do for themselves:
- **See their own money** — commission earned, paid and outstanding, plus per-host earnings and sub-agency balances (`app/agency-dashboard/AgencyMoney.tsx:3-16`). This did not exist before: the dashboard showed hosts, KYC and sub-agencies and no commission figure at all (`:5-8`). It asks the API for `me` and lets the server resolve which record that is (`:12-16`).
- **Add a host** — files a `hostApplications` document (`:570`).
- **Request salary** for a host (`:970`), and **mark a paid salary distributed** (`:2182`).
- **Create a sub-agency** — writes an `agencies` document and a sub-agency login (`:1757-1759`). This is the one partner action that creates another partner.
- **Propose changes** to their own payout or identity details via `submitPartnerUpdate` (`:1242`); whether a direct write is allowed turns on the *decision* field `status`, not the KYC claim (`:35-43`).
- **Apply for a second capability** — `SecondRoleCard`, which renders only for an approved partner holding exactly one capability with no application outstanding (`components/SecondRoleCard.tsx:7-11`).

What needs staff: approval of the agency itself, approval of each host application, approval of proposed detail changes, approval/payment of each salary request, and every commission or sub-agency payout (which is a card an owner signs).

### `/seller-dashboard` — "My Sales"
Who: a login holding the `seller` capability (`app/seller-dashboard/page.tsx:266`, `:353`). Six tabs: Everything, Purchases, Statement, Credit, Sales, Profile (`:160-166`).

What a seller can do for themselves:
- **Buy inventory** — `BuyInventoryDialog` posts a coin-purchase request to the card board (`:89`, `:720`).
- **File a sale** — `FileSaleDialog` (`:90`, `:736`); filing records the claim and the buyer has nothing until an owner approves it (`app/sales/page.tsx:539`).
- **See their own position** — status, credit, coins on hand, whether they may take inventory **and the reason if not**, the full statement, and every movement on the account in one time-ordered list with a date range (`:19-42`).
- **See their own cards** from the moment they exist — including lending, repayment, recovery and write-off cards raised *about* them, so a debt being created is visible before it is executed (`:36-42`). Staff who raised, verified and signed are not named.
- Apply for a second capability.

What needs staff: approval of the seller account, verification and owner signature on every coin purchase, all lending decisions, and approval of every filed sale.

Two documented bugs this portal was rebuilt around (`:8-21`): its purchase requests went to a Firestore collection no staff screen opened, so a seller who had already paid reached nobody; and a seller could not see their own credit, due date or what they owed.

---

# 12. Department mapping — who actually owns what

Derived from `DEFAULT_PERMISSIONS` (`lib/auth.ts:230-330`), the nav gating (`app/layout.tsx:101-327`), and each page's own constant.

### Evidenced ownership

| Department | CRM areas it owns in practice | Evidence |
|---|---|---|
| **App** | Users and hosts (`/users`, `/users/[uid]`, `/hosts`, `/hosts/verification`), live monitoring, the gift economy, policies, and `can_app_config`. The code's own summary: "Users, hosts, KYC, agencies, live monitor, broadcasts, analytics" (`lib/auth.ts:244`) | `lib/auth.ts:245-255`; `app/layout.tsx:140-147`, `:225`, `:252`, `:308` |
| **Operations** | Moderation and enforcement end to end — `/operations` and its four subpages, `/moderation`, device bans, the report queue, appeals. Plus partner onboarding: `can_approve_kyc` and `can_approve_seller`, and `ops_admin` is **the only non-owner role holding either** (`app/layout.tsx:166-174`). Plus seller sales, the credit book (read), and freezing a chance player | `lib/auth.ts:259-269`; `app/layout.tsx:280-284`, `:164`, `:205`; `lib/apiChance.ts:115` |
| **Finance** | Every `/finance/*` page, coin purchases, the credit book, economy config and currency, chance money, weekly payout runs, and `can_process_payout` + `can_adjust_balance` + `can_coin_operations`. Also the only non-owner role that may verify **any** card whoever raised it | `lib/auth.ts:273-287`; `app/layout.tsx:189-206`, `:160`, `:226-228`, `:246`; `backend/app/core/roles.py:181-182` |
| **Tech** | `/tech` and its subpages: App Control (the kill switch), content, payments, scheduled jobs, email delivery. Holds `can_economy_config`, `can_commission_slabs` and `can_app_config` as *proposal* rights — a tech_admin's App Control save becomes an approval request (`app/tech/appcontrol/page.tsx:103-120`) | `lib/auth.ts:291-301`; `app/layout.tsx:212-219` |
| **Support** | App support tickets (`/tickets`), user feedback (`/feedback`), and read access to user records. Holds only `can_view_users` plus the three ticket permissions — notably **not** `can_ban_users` | `lib/auth.ts:305-313`; `app/layout.tsx:129`, `:259` |
| **Marketing** | In-app broadcasts and the email composer. Holds exactly one substantive permission, `can_send_broadcasts`, and is described in the code as a light department split out of App | `lib/auth.ts:315-325`; `app/layout.tsx:265-274` |
| **Owner / superadmin** | Signs every money card, executes every balance card, is the sole approver in `/approvals`, and is the only role for all seven `/app-config` pages | `backend/app/core/roles.py:167`; `app/layout.tsx:290-302` |
| **Observer** | Reads eleven routes, writes nothing, anywhere | `app/layout.tsx:682-685`; `backend/app/core/roles.py:162` |

### Where the mapping is genuinely unclear

1. **KYC and partner onboarding is split between App and Operations with no stated owner.** `/agencies` and `/kyc` are navigable by `app_admin` and `ops_admin` alike (`app/layout.tsx:176-177`), but only `ops_admin` holds `can_approve_kyc` (`lib/auth.ts:261`) while `app_admin` does not (`:245-251`). So App can open the queue and sees no Approve button. Meanwhile `/agencies/register` is **App-only** (`app/agencies/register/page.tsx:133`) and `/sellers/register` is App **and** Ops (`app/sellers/register/page.tsx:197`). Registering and approving sit in different departments, inconsistently by partner type.

2. **Agency and seller *records* belong to App/Ops but their *money* belongs to Finance, and both can open the same screens.** `/agencies` and `/sellers` pages admit `finance_admin` and `finance_member` (`app/agencies/page.tsx:45`, `app/sellers/page.tsx:45`) while the nav shows them to neither. Which department is responsible for a partner record is not decided anywhere.

3. **Chance is owned by nobody.** Five of the six screens are navigable by **all thirteen staff roles** (`app/layout.tsx:240-244`), the proposal tier is "any team admin" (`lib/apiChance.ts:94-98`), activation is the owner, freezing is Ops, and the money is Finance. No single department owns the product.

4. **`/economy` is read by Finance and Ops but configured by Finance, while Tech holds the `can_economy_config` permission.** `ECONOMY_CONFIG_ROLES` is SA + finance_admin (`app/economy/config/page.tsx:146`), yet `can_economy_config` and `can_commission_slabs` are granted to `tech_admin` and `tech_member` and to **no Finance role** (`lib/auth.ts:291-301` vs `:273-287`). Tech holds the permission for a screen it cannot open.

5. **Broadcasts.** Nav and page say Marketing; the dashboard says App and Ops (`app/page.tsx:515`); the email composer's real authority is graded by audience inside the API across six admin roles plus the owner. Marketing owns the in-app broadcast and co-owns the email one.

6. **`/gifts` has no department.** It is in the Economy nav group, visible to SA + app_admin + ops_admin (`app/layout.tsx:225`), editable by those plus `ops_member` (`app/gifts/page.tsx:487`), and readable by anyone who types the URL. Its sibling editor lives under **Tech** at `/tech/content` (`app/layout.tsx:213`). Two departments edit the same gift catalogue from two screens.

7. **Team management has two owners and two screens.** `/team` and `/team-access` are both open to all staff and perform the same three mutations, which the app states outright (`app/team/page.tsx:296-303`). Separately, `can_manage_team` is granted to every department admin including Finance, Tech, Support and Marketing (`lib/auth.ts:281`, `:296`, `:308`, `:320`), with a comment that this "grants the button, not the scope" because the server narrows each admin to their own department's members (`lib/auth.ts:278-281`).

8. **App Config vs Tech.** All seven `/app-config` pages are superadmin-only, but `can_app_config` is held by `app_admin`, `tech_admin` and `tech_member` (`lib/auth.ts:248`, `:293`, `:299`). Three roles hold a permission that no screen honours — business purpose of that permission unclear.

---

# Appendix: stubs, dead screens, and contradictions

- **No stub pages.** Every one of the 100 route files has real content; the only `@deprecated` marker in the codebase is a helper function (`lib/firestore.ts:720`).
- **`/team` and `/team-access` are redundant by the app's own admission** — `app/team/page.tsx:296`: "This screen and /team-access now do the same job", with `:302` adding that one should go and it is not a decision the page can make. Both are kept in the nav deliberately (`app/layout.tsx:322-324`).
- **`/economy` is read-only documentation**, not an operational screen: "Reference guide for all rates, slabs, and calculation rules." (`app/economy/page.tsx:155`).
- **`/tech/appcontrol` is unreachable from the sidebar** — its only link is a card on `/tech` (`app/tech/page.tsx:142`).
- **`/gifts` has no read gate** — `app/gifts/page.tsx:487` defines `canEdit` and nothing defines `canView`.
- **Dashboard → `/broadcasts` is a link to a wall** for app and ops staff (`app/page.tsx:515` vs `app/broadcasts/page.tsx:55`).
- **Firestore rules and the API disagree about staff creation, resolved in the API's favour** — `app/team/page.tsx:22-33`: the Firestore rule is a blanket superadmin-only write; the API grant is narrower and is what runs.
- **The nav deliberately narrows five links below what the page itself allows**, each with the Firestore rule or API dependency cited inline: `/reports` (`app/layout.tsx:107-119`), `/tickets` (`:124-128`), `/feedback` (`:253-258`), the Finance group (`:183-188`), and `/chance/money` (`:245`). These are intentional and documented, not drift.