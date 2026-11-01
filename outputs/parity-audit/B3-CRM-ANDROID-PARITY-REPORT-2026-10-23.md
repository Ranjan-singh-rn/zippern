# B3 — CRM → Android role parity: implementation report (2026-10-23)

Branch `v5-scratch`, HEAD `1194e5599eff15205dc5caf16b117da0e77dd34f` (verified). Every existing modified, deleted and untracked file was preserved (452 → 464 status lines, the new lines are this batch's new files). Nothing was committed, pushed, deployed, migrated or written to production; no request was sent to any server from this environment.

## 0. Status vocabulary (used below, honestly)
- **Implemented** — code written for the capability.
- **Unit-tested** — covered by a JVM / backend test. Backend tests were RUN here; **Android JVM tests were written but NOT run** (no Android SDK; the network allowlist blocks Gradle/Kotlin downloads; an attempt to run them on the Mac via Finder failed because the Mac is in a full-screen Space).
- **Build-verified** — `assembleDebug` succeeded. **Not achieved yet** for any Android change in this batch.
- **Runtime-verified** — exercised on a device against a server. **Nothing in this batch is runtime-verified.**

## 1. Architecture (Phase 2)
| Piece | What it does | Why it is safe |
|---|---|---|
| `data/api/ApiClient.kt` | Exchanges the app's Firebase ID token at `POST /api/auth/signin` for an API session (exactly what `zipper-crm/lib/api.ts` does), renews via `/api/auth/refresh`, revokes via `/api/auth/signout` when the Firebase user signs out/changes. Token in memory only. One retry on 401 only. | No new identity system; the server decides who the login is (staff row, partner record, or "No account found"). Observer cannot sign in through Firebase by design (`security.py`) — untouched. |
| `BuildConfig.ZIPPER_API_BASE` (`build.gradle.kts`) | `zipper.apiBase` (local.properties) / `ZIPPER_API_BASE` env. **Release** defaults to the production CRM host; **debug defaults to EMPTY** → work screens say "not configured" and send nothing. | A normal debug build cannot mutate production. Opt in only with a local backend (`backend/LOCAL_DEVELOPMENT.md`). |
| `src/debug/…network_security_config.xml` | Debug-only cleartext for `10.0.2.2`/`localhost`/`127.0.0.1` (local backend). | Release untouched; everything else stays HTTPS-only. |
| `data/work/Caps.kt` | Capabilities from `GET /api/auth/me` (server's `roles.PERMISSIONS`), predicates named after backend dependencies (`requireWrite`, `requireOwner`, `has(perm)` …). | Only decides what is OFFERED; every route re-checks. |
| `data/work/WorkSpec.kt`, `WorkActions.kt`, `Modules*.kt`, `WorkModules.kt` | 78 declared work screens / 129 actions: source (API route or the Firestore collection the CRM reads), fields, filters, params, and actions with the CRM's exact route + body. | Writes always behind a confirmation (test-enforced). Secrets never displayed; bank numbers masked; contacts gated like the CRM (`can_view_users`); reporter identity hidden from agencies. |
| `data/work/WorkRepository.kt` | Runs sources/actions; Firestore only for CRM browser-write collections (same rules, same login); public-name lookups from `publicProfiles` only. | No balance computed client-side; money moves only through cards the server verifies/signs/executes. |
| `ui/screens/work/*` | Work hub (role-aware, grouped), generic list (params, filters, search, load-more, loading/empty/error/denied/retry), detail (fields, all-fields, actions), action dialog (form → validation → confirm → result → refresh), buyer lookup. | — |
| Entry points | "Work" cell on the Me tab for any server-flagged partner/official (`isAgent`, `isSeller`, `isOfficial`, `crmRole`, `ownAgencyId`); Agency dashboard "My hosts → Earnings" opens the operational host view. | Officials no longer land on a blank profile. |

### Backend change (one, small)
`GET /api/auth/me` now also returns `permissions`, `is_internal`, `is_external`, `is_owner`, `is_observer`, `is_team_admin`, `can_write`, `partner_ids`, `partner_status` — computed by new pure `roles.capability_profile()`. **Security:** caller's own facts only; partner ids only for partner sessions (dropped for staff); grants nothing; every route keeps its dependency. Not deployed. Test: `tests/test_me_capabilities.py`.

## 2. Role-by-role parity matrix (Phase 1 inventory → mobile screen)
Inventory sources: `outputs/inventory/{crm-pages,api-users-staff,api-partner-ops,api-cards-reports}.md` (89 CRM pages, 228 API routes, every browser Firestore write).

### 2.1 Mobile screens, gates and sources
| Mobile screen | Group | CRM source | Offered to (gate) | Data source |
|---|---|---|---|---|
| Chance mechanics (`chance.mechanics`) | Config | /chance, /chance/configure (read), /chance/exposure | `chanceReader` | Api `/api/chance/mechanics` |
| Responsible-play queue (`chance.protection`) | Config | /chance/protection | `chanceReader` | Api `/api/chance/protection/flags` |
| Chance exceptions (`chance.exceptions`) | Config | /chance/monitoring | `chanceReader` | Api `/api/chance/exceptions` |
| Gift catalogue (`config.gifts`) | Config | /gifts, /tech/content (gifts) | `{ c -> c.isInternal && !c.isObserver }` | Firestore `gifts` |
| Payment methods by country (`config.paymentMethods`) | Config | /tech/payments | `{ c -> c.isInternal && !c.isObserver }` | Firestore `paymentConfig` |
| Host withdrawals (`withdrawals`) | Money | /finance/withdrawals | `financeReader` | Firestore `withdrawalRequests` |
| Agency salary requests (`salaryRequests`) | Money | /agencies/[id]/salary, /agency-dashboard (salary) | `financeReader` | Firestore `salaryRequests` |
| Weekly payout reports (`payoutReports`) | Money | /finance/payouts | `financeReader` | Firestore `weeklyPayoutReports` |
| Operating costs (`expenses`) | Money | /finance/costs | `{ c -> c.isInternal }` | Api `/api/expenses` |
| Owners' capital (`capital`) | Money | /finance/capital | `{ c -> c.isInternal }` | Api `/api/capital` |
| Support tickets (`support.tickets`) | Support | /tickets | `{ c -> c.isInternal && !c.isObserver && (c.isOwner \|\| c.role.startsWith("support_") \|\| c.role.startsWith("` | Firestore `supportTickets` |
| Team tickets (`team.tickets`) | Support | /tech/tickets | `{ c -> c.isInternal && !c.isObserver }` | Firestore `techTickets` |
| In-app announcements (`broadcasts.inapp`) | Support | /broadcasts | `{ c -> c.isInternal && !c.isObserver }` | Firestore `broadcasts` |
| Email broadcast (`broadcasts.email`) | Support | /broadcasts/email | `{ c -> c.requireWrite }` | Api `/api/broadcasts/audiences` |
| Policies & FAQ (`policies`) | Config | /policies | `{ c -> c.isInternal && !c.isObserver && (c.isOwner \|\| c.role.startsWith("app_")) }` | Firestore `policies` |
| Approval requests (`approvals`) | Queues | /approvals, /approvals/[id] | `{ c -> c.isOwner }` | Firestore `approvalRequests` |
| Alerts (`alerts`) | Team | /alerts | `oversight` | Api `/api/notifications/alerts/open` |
| Alert log (`alerts.raised`) | Team | /alerts (raised) | `oversight` | Api `/api/notifications/alerts/raised` |
| Scheduled jobs (`jobs`) | Team | /tech/jobs | `oversight` | Api `/api/notifications/runs/last` |
| Email delivery log (`email.log`) | Team | /tech/email | `oversight` | Api `/api/notifications/deliveries` |
| Audit log (`audit`) | Team | /audit, /moderation (actions) | `{ c -> c.isInternal }` | Api `/api/audit` |
| Team (`staff`) | Team | /team, /team-access | `{ c -> c.isInternal }` | Api `/api/staff` |
| Commission statement (`agency.statement`) | Mine | /agency-dashboard (statement), /partners (agency tab) | `agencyViewer` | Api `/api/partners/agencies/{param:agency_id}/statement` |
| Host earnings (`agency.hosts`) | Mine | /agency-dashboard (hosts), /agencies/[id] (hosts tab) | `agencyViewer` | Api `/api/partners/agencies/{param:agency_id}/hosts` |
| Sub-agencies (`agency.subs`) | Mine | /agency-dashboard (sub-agencies), /agencies/[id] (subs tab) | `agencyViewer` | Api `/api/partners/agencies/{param:agency_id}/sub-agencies` |
| Reports on my hosts (`agency.reports`) | Mine | /agency-dashboard (HostReports) | `agencyViewer` | Api `/api/partners/agencies/{param:agency_id}/host-reports` |
| Appeals for my hosts (`agency.appeals`) | Mine | /agency-dashboard (appeals) | `agencyViewer` | Api `/api/partners/agencies/{param:agency_id}/appeals` |
| Sub-agency payouts (`agency.subPayouts`) | Mine | /agency-dashboard, /agencies/[id], /agencies | `{ c -> c.isAgencyPartner \|\| c.isInternal }` | Api `/api/partner-ops/subagency-payouts/open` |
| Seller statement (`seller.statement`) | Mine | /seller-dashboard (statement), /partners (seller tab), /sellers/[id] | `sellerViewer` | Api `/api/partners/sellers/{param:seller_id}/statement` |
| Seller history (`seller.history`) | Mine | /seller-dashboard (history), /sellers/[id] (transactions) | `sellerViewer` | Api `/api/partners/sellers/{param:seller_id}/history` |
| Money cards (`partner.cards`) | Mine | /seller-dashboard (cards), /board | `{ c -> c.isExternal && c.partnerIds.isNotEmpty() }` | Api `/api/cards` |
| My partner records (`partner.records`) | Mine | /profile, /agency-pending, /seller-pending | `{ c -> c.isExternal }` | Api `/api/partner-ops/partners` |
| Contact verification (`partner.verification`) | Mine | /agency-pending, /seller-pending (ContactVerificationPanel) | `{ c -> c.isExternal }` | Api `/api/partner-ops/me/verification` |
| Agencies & sellers (`partners.directory`) | Partners | /agencies, /sellers, /kyc (partners), /onboarding | `partnerViewer` | Api `/api/partner-ops/partners` |
| Partner record (`partners.one`) | Partners | /agencies/[id], /sellers/[id] | `partnerViewer` | Api `/api/partner-ops/partners/{param:partner_id}` |
| Recharges (`recharges`) | Money | /recharges, /seller-dashboard (recharges) | `{ c -> c.isSellerPartner \|\| (c.isInternal && (c.readsAll \|\| c.has(Perm.COIN_OPERATIONS) \|\| c.has(Perm.VI` | Api `/api/partner-ops/recharges` |
| Coin sales (`sales`) | Money | /sales, /seller-dashboard (file a sale) | `{ c -> c.isSellerPartner \|\| (c.isInternal && (c.readsAll \|\| c.has(Perm.COIN_OPERATIONS) \|\| c.has(Perm.VI` | Api `/api/partner-ops/sales` |
| Seller credit (`credit.overdue`) | Money | /lending, /partners (exposure) | `{ c -> c.isInternal }` | Api `/api/partners/credit/overdue` |
| Coin purchase requests (legacy) (`coinRequests`) | Money | /coin-purchases (Firestore requests) | `{ c -> c.isInternal && !c.isObserver && (c.has(Perm.COIN_OPERATIONS)) }` | Firestore `coinPurchaseRequests` |
| Find a user (`users.search`) | People | /users | `{ c -> c.isInternal && !c.isObserver }` | Firestore `users` |
| User record (`users.record`) | People | /users/[uid] | `{ c -> c.isInternal }` | Api `/api/users/{param:uid}/roles` |
| Account history (`users.history`) | People | /users/[uid] (activity) | `{ c -> c.isInternal }` | Api `/api/users/{param:uid}/history` |
| Warnings (`users.warnings`) | People | /users/[uid] (warnings) | `{ c -> c.isInternal }` | Api `/api/users/{param:uid}/warnings` |
| Host applications (`hosts.applications`) | People | /kyc (hosts), /hosts (invited) | `{ c -> c.isInternal && !c.isObserver }` | Firestore `hostApplications` |
| Live rooms (`live.rooms`) | Live | /live | `{ c -> c.isInternal && !c.isObserver }` | Firestore `liveRooms` |
| Waiting on me (`cards.inbox`) | Queues | /inbox | `{ c -> c.isInternal }` | Api `/api/cards/inbox` |
| Money board (`cards.board`) | Queues | /board, /coin-purchases, /finance/withdrawals (execute), /finance/costs (pay), /finance/capital (settle) | `{ c -> c.isInternal }` | Api `/api/cards` |
| Awaiting my signature (`cards.toSign`) | Queues | /inbox (signature queue), /board | `{ c -> c.isOwner }` | Api `/api/cards/awaiting-signature` |
| Coin purchases (`cards.coinPurchases`) | Money | /coin-purchases | `{ c -> c.isInternal && (c.readsAll \|\| c.has(Perm.COIN_OPERATIONS)) }` | Api `/api/cards` |
| Reinstatement requests (`roleAppeals`) | Queues | /role-appeals | `{ c -> c.hasAny(Perm.APPROVE_KYC, Perm.APPROVE_SELLER) }` | Api `/api/partner-ops/role-appeals` |
| Transfers (`transfers`) | Queues | /transfers, /users/[uid] (transfer), /agencies/[id] (transfer) | `{ c -> c.has(Perm.APPROVE_KYC) }` | Api `/api/partner-ops/transfers` |
| Frozen money (`frozenMoney`) | Queues | /frozen-money | `{ c -> c.isOwner }` | Api `/api/partner-ops/frozen-money` |
| Host face verification (`hostVerification`) | Queues | /hosts/verification | `{ c -> c.has(Perm.APPROVE_KYC) }` | Api `/api/host-verification/pending` |
| Ban & suspension appeals (`accountAppeals`) | Queues | /operations/appeals | `{ c -> c.isInternal }` | Api `/api/users/appeals` |
| User reports (`userReports`) | Live | /operations/reports, /moderation | `{ c -> c.isInternal }` | Api `/api/users/reports` |
| Device bans (`deviceBans`) | Live | /operations/bans | `{ c -> c.isInternal }` | Api `/api/users/devices/bans` |
| Business dashboard (`reports.dashboard`) | Reports | / (staff dashboard), /analytics | `{ c -> c.isInternal }` | Api `/api/reports/dashboard` |
| Weekly business report (`reports.weekly`) | Reports | /reports/weekly | `businessFinancials` | Api `/api/reports/weekly-business/{param:week}` |
| Report definitions (`reports.definitions`) | Reports | /reports (definitions) | `{ c -> c.isInternal }` | Api `/api/reports/definitions` |
| Cash position (`reports.cash`) | Reports | /finance/cash, /finance, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/cash-position` |
| Revenue (`reports.revenue`) | Reports | /finance/profit, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/revenue` |
| Payouts (`reports.payouts`) | Reports | /finance/payouts, /finance/withdrawals | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/payouts` |
| Margin (`reports.margin`) | Reports | /finance/profit, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/margin` |
| Channels (`reports.channels`) | Reports | /finance/profit, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/channels` |
| Liabilities (`reports.liabilities`) | Reports | /finance/liabilities, /finance | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/liabilities` |
| Partner summary (`reports.partners`) | Reports | /finance/reports, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/partners/summary` |
| Team throughput (`reports.throughput`) | Reports | /throughput, /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/team-throughput` |
| Audit summary (`reports.auditSummary`) | Reports | /reports | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/audit-summary` |
| Chance revenue (`reports.chanceRevenue`) | Reports | /chance/money | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/chance-revenue` |
| Chance margin (`reports.chanceMargin`) | Reports | /chance/money | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/chance-margin` |
| Cannibalisation (`reports.cannibalisation`) | Reports | /chance/money | `business financials (owner/observer/team admin) unless noted` | Api `/api/reports/cannibalisation` |
| Economy configuration (`config.economy`) | Config | /economy, /economy/config | `see module` | Firestore `appConfig/economy` |
| App control (`config.control`) | Config | /tech/appcontrol | `see module` | Firestore `appConfig/control` |
| Daily rewards (`config.dailyRewards`) | Config | /app-config/daily-rewards | `see module` | Firestore `appConfig/dailyRewards` |
| Profile options (`config.profileOptions`) | Config | /app-config/profile-options | `see module` | Firestore `appConfig/profileOptions` |

`R` = can open; actions per role are listed in the generated matrix `zipper-app/app/build/work-parity-matrix.md` (written by `WorkModulesTest` when the tests run on the Mac: Owner, Observer, App admin, Ops member, Finance admin, Support member, Agency, Coin seller, Pending partner × every screen, `R+n` = n write actions offered).

### 2.2 Every CRM page → mobile
| CRM page | Mobile screen(s) |
|---|---|
| `/` | `reports.dashboard` |
| `/agencies` | `agency.subPayouts`, `partners.directory` |
| `/agencies/[id]` | `agency.hosts`, `agency.subs`, `agency.subPayouts`, `partners.one`, `transfers` |
| `/agencies/[id]/salary` | `salaryRequests` |
| `/agencies/register` | **not on mobile** |
| `/agency-dashboard` | `salaryRequests`, `agency.statement`, `agency.hosts`, `agency.subs`, `agency.reports`, `agency.appeals`, `agency.subPayouts` |
| `/agency-pending` | `partner.records`, `partner.verification` |
| `/agency-signup` | **not on mobile** |
| `/alerts` | `alerts`, `alerts.raised` |
| `/analytics` | `reports.dashboard` |
| `/app-config` | **not on mobile** |
| `/app-config/bag-items` | **not on mobile** |
| `/app-config/daily-rewards` | `config.dailyRewards` |
| `/app-config/levels` | **not on mobile** |
| `/app-config/packages` | **not on mobile** |
| `/app-config/payment-creds` | **not on mobile** |
| `/app-config/profile-options` | `config.profileOptions` |
| `/appeal` | **not on mobile** |
| `/approvals` | `approvals` |
| `/approvals/[id]` | `approvals` |
| `/audit` | `audit` |
| `/board` | `partner.cards`, `cards.board`, `cards.toSign` |
| `/broadcasts` | `broadcasts.inapp` |
| `/broadcasts/email` | `broadcasts.email` |
| `/chance` | `chance.mechanics` |
| `/chance/configure` | `chance.mechanics` |
| `/chance/exposure` | `chance.mechanics` |
| `/chance/money` | `reports.chanceRevenue`, `reports.chanceMargin`, `reports.cannibalisation` |
| `/chance/monitoring` | `chance.exceptions` |
| `/chance/protection` | `chance.protection` |
| `/coin-purchases` | `coinRequests`, `cards.board`, `cards.coinPurchases` |
| `/economy` | `config.economy` |
| `/economy/config` | `config.economy` |
| `/economy/currency` | **not on mobile** |
| `/feedback` | `feedback.triage` |
| `/finance` | `reports.cash`, `reports.liabilities` |
| `/finance/capital` | `capital`, `cards.board` |
| `/finance/cash` | `reports.cash` |
| `/finance/costs` | `expenses`, `cards.board` |
| `/finance/liabilities` | `reports.liabilities` |
| `/finance/payouts` | `payoutReports`, `reports.payouts` |
| `/finance/profit` | `reports.revenue`, `reports.margin`, `reports.channels` |
| `/finance/reports` | `reports.partners` |
| `/finance/withdrawals` | `withdrawals`, `cards.board`, `reports.payouts` |
| `/frozen-money` | `frozenMoney` |
| `/gifts` | `config.gifts` |
| `/hosts` | `hosts.applications` |
| `/hosts/verification` | `hostVerification` |
| `/inbox` | `cards.inbox`, `cards.toSign` |
| `/kyc` | `partners.directory`, `hosts.applications` |
| `/lending` | `credit.overdue` |
| `/live` | `live.rooms` |
| `/login` | **not on mobile** |
| `/moderation` | `audit`, `userReports` |
| `/observer` | **not on mobile** |
| `/onboarding` | `partners.directory` |
| `/operations` | **not on mobile** |
| `/operations/appeals` | `accountAppeals` |
| `/operations/bans` | `deviceBans` |
| `/operations/feedback` | `feedback.triage` |
| `/operations/reports` | `userReports` |
| `/partners` | `agency.statement`, `seller.statement`, `credit.overdue` |
| `/policies` | `policies` |
| `/profile` | `partner.records` |
| `/recharges` | `recharges` |
| `/reports` | `reports.definitions`, `reports.cash`, `reports.revenue`, `reports.margin`, `reports.channels`, `reports.partners`, `reports.throughput`, `reports.auditSummary` |
| `/reports/weekly` | `reports.weekly` |
| `/role-appeals` | `roleAppeals` |
| `/sales` | `sales` |
| `/seller-dashboard` | `seller.statement`, `seller.history`, `partner.cards`, `recharges`, `sales` |
| `/seller-pending` | `partner.records`, `partner.verification` |
| `/seller-signup` | **not on mobile** |
| `/sellers` | `partners.directory` |
| `/sellers/[id]` | `seller.statement`, `seller.history`, `partners.one` |
| `/sellers/register` | **not on mobile** |
| `/team` | `staff` |
| `/team-access` | `staff` |
| `/tech` | **not on mobile** |
| `/tech/appcontrol` | `config.control` |
| `/tech/content` | `config.gifts` |
| `/tech/email` | `email.log` |
| `/tech/jobs` | `jobs` |
| `/tech/payments` | `config.paymentMethods` |
| `/tech/tickets` | `team.tickets` |
| `/throughput` | `reports.throughput` |
| `/tickets` | `support.tickets` |
| `/transfers` | `transfers` |
| `/users` | `users.search` |
| `/users/[uid]` | `users.record`, `users.history`, `users.warnings`, `transfers` |

Pages marked **not on mobile**, with the reason:
| Page | Why |
|---|---|
| `/login`, `/observer`, `/agency-signup`, `/seller-signup`, `/appeal` | Sign-in / public pages. The app has its own sign-in, partner applications (Partner hub) and appeals. The Observer is deliberately Firebase-less and OTP-only (`security.py`) — **no mobile Observer mode** (single-account rule preserved). |
| `/agencies/register`, `/sellers/register` | Create a second Firebase Auth account from the device (secondary app) plus KYC uploads. **Blocked:** account creation on behalf of others is not done from the app; needs a server endpoint that creates the login. |
| `/app-config/*` editors (bag items, levels, packages, payment creds), `/economy/currency` editor parts | Structured money/app-wide configuration editors; economy, app control, daily rewards, profile options, gifts and payment methods are **read-only** on mobile (gift on/off toggle is offered). Editing stays on the CRM (owner direct / others via approval request). |
| `/operations`, `/tech`, `/app-config` (landing) | Count-only overview pages; their queues are on mobile individually. |

### 2.3 Partial parity inside covered pages (known gaps, not hidden)
- **Agency portal** (`/agency-dashboard`): statement, host earnings, sub-agencies, host reports, appeals, sub-agency payouts — **done**. Not done: invite host / withdraw invite (Firestore + KYC uploads), salary request create / mark distributed, KYC & payout change proposals, add sub-agency (creates a login), contest a host report (deterministic appeal id rule), second-role card. Need upload support and, for sub-agency creation, a server endpoint.
- **Seller portal**: statement, history, cards, sales (file with buyer lookup), recharges, inventory check, buy inventory (proof as a **link**, no in-app upload yet) — **done**. Online toggle already exists in the app's seller dashboard.
- **Users** (`/users/[uid]`): roles, history, warnings, warn (+deduction), suspend/resume, ban/unban, balance request, revoke/restore host, seller-flag, transfer, partner revoke/restore — **done**. Not done: diamond/bean transaction tabs, CSV export.
- **Board**: verify / review / sign / reject / every type-specific execute — **done**. Not done: bulk sign.
- **Hosts**: applications, decide, proposed-change decide, documents, face verification — **done**. Not done: direct application edit / proposal.
- **Support** (`/tickets`): reply, status, close — **done**. Not done: assign, priority, route to team, in-app notice (the CRM's notice write is refused by the rules today).
- **Email broadcast**: audiences, preview, send — **done** without attachments.
- **Chance**: register, exposure, RTP, suspend/resume, protection decide, freeze/unfreeze, exceptions — **done**. Not done: propose/activate odds tables, withdraw a country, player limits / self-exclusion decisions.
- **Reports**: all 14 report routes + dashboard + weekly + definitions — **done (read)**. No CSV export on mobile.
- **Staff**: list, invite, change role (owner), employment (no salary), revoke, assignable roles, overview, own profile — **done**. Not done: password reset email, owner provisioning (Observer-only by design).
- **Weekly payout reports**: approve / reject as the CRM writes them — done; the data-model problem (parity R12) is unchanged and documented.
- **Live**: list, watch, warn, ban, **end/mute (staff side)**; host side honours them (B2). **Stream quality** now applies to the engine (dual stream published by the host; viewer Auto/High/Low) — Agora constant names unverified until the build runs.

## 3. Files changed
**New (Android):** `data/api/ApiClient.kt`, `data/api/ApiResult.kt`, `data/work/{Caps,WorkSpec,WorkActions,DetailFields,WorkModules,WorkRepository,ModulesPartner,ModulesQueues,ModulesPeople,ModulesPartners,ModulesMoney,ModulesReports,ModulesOps,ModulesChance}.kt`, `ui/screens/work/{WorkViewModels,WorkScreens}.kt`, `util/Json.kt`, `src/debug/AndroidManifest.xml`, `src/debug/res/xml/network_security_config.xml`, tests `data/work/{WorkCoreTest,WorkModulesTest}.kt`, `zipper-app/work-verify.command` (local runner, deletable).
**Edited (Android):** `app/build.gradle.kts` (ZIPPER_API_BASE), `navigation/Screen.kt` + `ZipperNavGraph.kt` (Work routes, Work entry, host earnings link), `ui/screens/main/MainScreen.kt` + `profile/MyProfileScreen.kt` (Work cell), `agency/AgencyDashboardScreen.kt` (Earnings link), `live/AgoraManager.kt` + `WatchLiveViewModel.kt` (stream quality).
**Backend:** `app/core/roles.py` (`capability_profile`), `app/routers/auth.py` (`/me`), new `tests/test_me_capabilities.py`.
Before-copies: session scratch `b3-before/`, `b3-roles.py.before`, `b3-auth.py.before`, `b3-build.gradle.kts.before`.

## 4. Tests actually run
| Command | Result |
|---|---|
| `python3 -m tests.test_me_capabilities` | passed |
| Full backend suite: every `backend/tests/test_*.py` run as a module | **82 / 82 passed** |
| Route cross-check (every `/api/...` literal in the work specs vs backend routers, Python) | 0 real mismatches |
| `PARTNER_REACHABLE` parse (deps.py) | 26 routes |
| Android `:app:testDebugUnitTest` incl. `WorkCoreTest` (18 tests) + `WorkModulesTest` (10 tests) + B1/B2 tests | **NOT RUN** — no SDK here |
| `:app:assembleDebug` | **NOT RUN** |

Run on the Mac (or double-click `zipper-app/work-verify.command`, which writes logs and the role matrix to `outputs/verify/`):
```
cd zipper-app && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```
Expect a first-compile fix round: ~4,800 lines of Kotlin were written without a compiler.

## 5. Blocked / needs your decision
1. **Compile + JVM tests** on the Mac (above).
2. **Runtime**: needs a non-production backend. With no staging project, use the local backend + emulators (`backend/LOCAL_DEVELOPMENT.md`) and set `zipper.apiBase=http://10.0.2.2:8080` for a debug build. Release builds point at production by default — decide before shipping one.
3. **Staff sign-in on the phone**: the API resolves staff by Firebase uid (or proven email). A staff member whose app login (phone OTP) is a different Firebase account from their CRM login gets "No work account for this login" — by design; linking accounts is an identity decision.
4. Uploads (KYC, payment proof), account creation for others, config editors, odds tables — see 2.3.
5. Backend `/me` change must be deployed for the hub to show anything other than "nothing to work on" (old `/me` lacks the capability keys; the app then reads the narrowest session).

## 6. Confirmation
Existing uncommitted, deleted and untracked work preserved. No commits, pushes, deployments, migrations, production reads/writes or financial operations. No authentication, authorization, rules or validation weakened.
