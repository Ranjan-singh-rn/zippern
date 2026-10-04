I have what I need. Here are the findings.

---

# 1. SCHEDULED / BACKGROUND JOBS

There are **14 scheduled jobs across two codebases**, and they are not all in one registry. The backend has a self-describing `SCHEDULE` table that covers only **7** of them; the other 7 live only in Cloud Functions and appear on no jobs board.

### A. Backend-registered jobs (visible on `/tech/jobs`)

Declared in `/Users/soumyaranjansingh/Documents/Projects/zippern/backend/app/services/scheduling.py:2076-2192` (`SCHEDULE` tuple, `SCHEDULE_TIMEZONE = "Asia/Kolkata"` at :2074). Each row names the Cloud Function that fires it.

| Function | file:line | Cron (IST) | What it does |
|---|---|---|---|
| `scheduledTransactionalSweep` | `functions/src/index.ts:3775` | `*/15 * * * *` | Sends every transactional email a record says is owed and that `email_deliveries` says has not gone out. |
| `scheduledAlertScan` | `functions/src/index.ts:3795` | `*/30 * * * *` | Runs ~15 exception detectors (see §7). Repeat email suppressed per-condition by `alert_state`. |
| `scheduledReconciliation` | `functions/src/index.ts:3817` | `0 3 * * *` | Compares yesterday's Firestore diamond/bean movement against the Mongo ledger. **Corrects nothing — alerts only.** |
| `scheduledDailyReports` | `functions/src/index.ts:3826` | `0 7 * * *` | Business summary, Finance worklist, exception report for the whole previous IST day. |
| `scheduledWeeklyBusinessReport` | `functions/src/index.ts:3848` | `30 7 * * 1` | The owner's P&L: hosts, agency commission, recharges, seller credit, gross gaming revenue, game margin model, cannibalisation guard, leaderboards. |
| `scheduledPartnerStatements` | `functions/src/index.ts:3869` | `0 9 * * 1` | Weekly statement to every approved agency and seller. |
| `scheduledMonthlyReports` | `functions/src/index.ts:3888` | `0 8 1 * *` | Monthly P&L, accounting pack, audit summary, plus every partner's formal monthly statement. |

Note the comment at `scheduling.py:2104-2119`: `scheduledReconciliation` was deployed and running nightly but **was missing from this table**, so it appeared in no "job has never run" detection. Two canary tests caught it.

### B. Cloud-Functions-only jobs (in NO registry)

| Function | file:line | Cron | What it does |
|---|---|---|---|
| `weeklyPayoutReportGenerator` | `functions/src/index.ts:931`, schedule at `:945` | `29 18 * * 0` **UTC** | Generates the Firestore weekly payout report *and* calls the API to accrue agency commission. Uses two different windows on purpose: a rolling 7 days for host eligibility, the ISO week label for commission (`:962-991`). |
| `dailyPlatformStatsAggregator` | `functions/src/index.ts:1898` | `0 0 * * *` **UTC** | Scans a day of `giftTransactions`, writes `platformRevenue/{YYYY-MM-DD}`. Computes `platformProfit = totalDiamondSpend - totalBeanEarned` (`:1949`). |
| `releaseBeansForWeek` | `functions/src/payouts.ts:82`, schedule `:85` | `30 0 * * 1` IST | Moves a closed week's `weeklyEarnings.beans` into `users/{uid}.beansAvailable`. Skips (leaves `released:false`) if `isVerifiedHost !== true` or `payoutHold === true` (`:124-129`). |
| `sweepStaleCalls` | `functions/src/calls.ts:656`, schedule `:658` | `* * * * *` IST | Two queries: connected/ending calls whose `lastTickAt` is >2 min old get `settleAndClose(..., 'watchdog_timeout')`; `ringing` calls older than the ring timeout become `missed`. |
| `sweepHostLevels` | `functions/src/hostStats.ts:280`, schedule `:283` | `0 2 * * *` IST | Pages every `isHost == true` user and recomputes `hostLevel` against the ladder in `levelConfig/host/levels`. |
| `purgeDeletedAccounts` | `functions/src/accounts.ts:410`, schedule `:413` | `30 3 * * *` IST | Hard-purges accounts past `deletionDueAt`, **max 50 per run**. Retains 7 subcollections (`accounts.ts:141-144`). |
| `sweepQuickLoginTokens` | `functions/src/identity.ts:1135`, schedule `:1137` | `30 4 * * *` IST | Deletes expired/orphaned `quickLoginTokens` (500/run). These are login credentials. |
| `expireCosmetics` | `functions/src/wallet.ts:567`, schedule `:569` | `0 * * * *` IST | Hourly. Expires `ownedItems` past `expiresAt` *and* clears the `users/{uid}.equippedFrame`-style pointers. Comment at `:573-581` records that the original `!=` query matched nothing, forever. |
| `sweepEmptyPartyRooms` | `functions/src/party.ts:1445`, schedule `:1447` | `every 1 minutes` IST | Closes `partyRooms` empty past `EMPTY_GRACE_MS`, plus rooms never occupied after a 10-minute grace (`:1451`). |

Also note `scheduling.py:812-821` registers a system actor `system:suspension_sweep`, and `scheduling.py:58` sets `SWEEP_WINDOW_DAYS = 30` for the transactional sweep lookback.

---

# 2. THE `chance` SUBSYSTEM

**The single most significant undiscussed thing in the repo.** It is a complete, regulated-gambling control plane: 4,739 lines of service (`backend/app/services/chance.py`), 1,227 lines of router, 2,165 lines of player protection, and six CRM screens — and **nothing in the Android app calls it.** A grep for `chance` across `zipper-app/app/src/main/java` returns one unrelated comment (`PartyRoomScreen.kt:333`). The CRM touches only `/chance/` and `/chance/configs/preview` via `zipper-crm/lib/apiChance.ts`.

### Mechanics

Three entity types, Mongo-backed (`backend/app/db/mongo.py:69-103`): `chance_mechanics`, `chance_configs`, `chance_rounds`, `chance_exposure`, `chance_player_flags`.

- A **mechanic** is the thing that exists. `MechanicKind` (`chance.py:236-239`): `lucky_gift`, `game` ("Aviator and anything like it"), `event` ("a limited-time mechanic").
- A **config version** is immutable: outcome table, stake denominations, max single win, enabled countries, RTP band. A change is a new version, raised as a card on the money board, verified by a second person, signed by an owner (`propose_config` :1512, `activate_config` :1746).
- A **round** (`RoundStatus`, `chance.py:265-270`): `committed → playing → recorded → settled | void`.

The draw is commit-reveal: seed hash published before the round, seed revealed after, outcome derived by HMAC-SHA256 so it is reproducible (`new_seed` :624, `draw` :659, `verify_round_outcome` :703). The design note at `chance.py:42-54` explains why `secrets` and never `random`.

Decisive lines:
> `chance.py:33` — "only then is a diamond credited (8B.1.5)."
> `chance.py:34` — "**Stake and payout are ledger movements**"
> `chance.py:149` — `PROBABILITY_TOTAL = 1_000_000          # ppm; 100%`
> `chance.py:150` — `MULTIPLIER_ONE = 10_000                # basis points; 1×`

### What money moves

Diamonds only, through the real Mongo ledger:
- Stake: `chance.py:2347-2356`, `apply_movement(... Currency.DIAMONDS ... idempotency_key=f"chance:{rid}:stake")`
- Payout: `chance.py:2499-2513`, `idempotency_key=f"chance:{rid}:payout"`
- External provider settlement: `chance.py:4700-4709`, same payout key.

### Protection limits and their units

`backend/app/services/player_protection.py`. **Every limit is a whole number of diamonds** — `_amount()` at :522 refuses anything else. Windows are `daily` / `weekly` (`Window`, :229), cut in `REPORT_TIMEZONE` not UTC (the reason is written out at :320-335).

Rule: **lowest positive limit wins** across three sources (`Source`, :234-239): `house` (env), `staff` (imposed on review, player cannot loosen), `player`.

> `player_protection.py:545` — "**The lowest positive limit wins**, and that is the whole rule."

Blocks (`Block`, :218-226): `self_excluded`, `cooling_off`, `staff_suspension`, `daily_loss_limit`, `weekly_loss_limit`, `protection_unavailable`.

Harm patterns auto-detected (`Pattern`, :250-255): `escalating_stakes_after_losses`, `sustained_session`, `rapid_repeat_play`.

### Three payout ceilings + a reserve

`_apply_ceilings` (`chance.py:2984`). Per-round ceiling **caps** silently; the three daily budgets and the reserve **trim the payout, withhold the shortfall, and auto-suspend the mechanic**.

- `per_player_per_day` → `max_payout_per_player_per_day`
- `platform_per_day` (per mechanic) → `max_payout_platform_per_day`
- `all_mechanics_per_day` → `CHANCE_PLATFORM_DAILY_PAYOUT_CEILING` env
- Reserve: `headroom = reserve + (staked − paid_out)` (`chance.py:2696`)

Enforced by atomic compare-and-increment, not read-then-write: `update_one({"key": k, "paid_out": {"$lte": limit - amount}}, {"$inc": {"paid_out": amount}})` (`chance.py:2735-2736`). `_CAS_ATTEMPTS = 5` (:2761).

### Configurable knobs

**Per config version** (signed): outcome table (ppm × bp), `min_stake`/`max_stake`/`step` (`_stake_rules` :781-801), `max_single_win`, `rtp_band_min_ppm`/`max_ppm`, enabled countries, `multiplier_basis` (`total_stake` | `unit_stake`, :242-255), `max_payout_per_round`, `max_payout_per_player_per_day`, `max_payout_platform_per_day`, `reserve_diamonds`, and a **mandatory** `reserve_basis` prose field (`chance.py:856-902`).

**Environment knobs** (`backend/app/config.py`):
- `chance_platform_daily_payout_ceiling: int = 0` (:396)
- `chance_reserve_warning_ppm: int = 800_000` (:402)
- `chance_rtp_daily_sigma_milli: int = 4_000` (:419), `chance_rtp_window_sigma_milli: int = 3_000` (:425), `chance_rtp_window_days: int = 7` (:426), `chance_rtp_min_rounds: int = 200` (:433)
- `chance_player_sigma_milli: int = 5_000` (:441), `chance_player_min_rounds: int = 30` (:443), `chance_player_max_rounds_per_hour: int = 240` (:447), `chance_player_min_round_gap_ms: int = 250` (:454), `chance_player_min_commit_to_play_ms: int = 50` (:455), `chance_anomaly_lookback_hours: int = 24` (:458)
- `protection_default_daily_loss_limit: int = 0` / `..._weekly_... = 0` (:485-486) — **both default to zero, meaning no house limit is set**
- `protection_max_loss_limit: int = 10_000_000` (:491), `protection_limit_increase_delay_hours: int = 24` (:501)
- `protection_min_self_exclusion_days: int = 180` (:510), `protection_exclusion_reflection_hours: int = 72` (:517)
- `protection_min_cooling_off_hours: int = 24` (:523), `protection_max_cooling_off_days: int = 90` (:524)
- `protection_session_reminder_minutes: int = 60` (:528), `protection_session_gap_minutes: int = 30` (:532)
- `protection_harm_escalation_rounds: int = 5` (:538), `..._multiple: int = 3` (:539), `..._harm_session_minutes: int = 180` (:541), `..._harm_rapid_rounds: int = 20` (:545), `..._harm_rapid_window_minutes: int = 10` (:546)
- Defaults `DEFAULT_RTP_BAND_MIN_PPM = 850_000` / `MAX = 960_000` (`chance.py:160-161`); `RESERVE_GUIDANCE_SIGMAS = 3`, `RESERVE_GUIDANCE_ROUNDS = (1_000, 10_000, 100_000)` (:817-818)

Intent note: whether this subsystem is meant to go live, or is a control plane built ahead of a game that does not exist yet, is **not stated anywhere in the code**. `chance.py:20-21` quotes the spec — "Until this exists, no chance mechanic should be live" — which reads as a prerequisite, not a launch.

---

# 3. VIRTUAL CURRENCIES

**Four ledgered currencies plus four non-ledgered assets.**

### Ledgered (Mongo `Currency` enum, `backend/app/services/money.py:30-34`)

| Asset | Balance lives | Created by | Consumed by |
|---|---|---|---|
| **diamonds** | `users/{uid}.diamonds` (Firestore) + Mongo `balances` (holder `user`) | seller recharge (`index.ts:1628`), daily reward (`wallet.ts:264`), bean conversion (`wallet.ts:127`), chance payout (`chance.py:2499`) | gifts (`gifts.ts:259`), call ticks (`calls.ts:390`, `:494`), bag purchases (`wallet.ts:413`), chance stake (`chance.py:2347`) |
| **beans** | `users/{uid}.beans`; withdrawable subset in `users/{uid}.beansAvailable`; per-week in `users/{uid}/weeklyEarnings/{weekKey}.beans` | gift receipt (`gifts.ts:263`), call earnings (`calls.ts:392`, `:496`) | bean→diamond conversion (`wallet.ts:126`), withdrawal (balance card on the money board) |
| **coins** | `sellers/{id}.coinBalance` | coin purchase, lending | recharge fulfilment (`index.ts:1623`), sales, repayment/recovery |
| **commission** | `agencies/{id}.commissionBalance`, in **paise** | API accrual only | commission payout card |

Firestore↔Mongo field map: `backend/app/db/firebase.py:189` — `("agency", "commission"): ("agencies", "commissionBalance")`.

### Non-ledgered assets (no ledger, no card, no audit)

- **`videoCards`** — `users/{uid}.videoCards`. "consumable free-call cards earned from daily rewards" (`zipper-app/.../data/model/User.kt:43`). Created **only** by `claimDailyReward` (`functions/src/wallet.ts:269`). I found **no consumer** anywhere — `MyBagScreen.kt:294` renders a `VideoCardSection(videoCards)` tab and nothing decrements the field. Intent unclear.
- **`totalGemsSpent`** — `users/{uid}.totalGemsSpent`, incremented by gift spend in diamonds (`functions/src/gifts.ts:260`). Commented "drives user level" (`User.kt:42`).
- **`totalXp`** — the Android `LevelEngine` documents it as the user ladder's input (`zipper-app/.../util/LevelEngine.kt:24`), it is in the `firestore.rules:1005` create-denylist, and the CRM states flatly: *"`level` is the USER ladder, scored on `totalXp`. NOTHING ON THE PLATFORM WRITES IT"* (`zipper-crm/app/users/[uid]/Client.tsx:213-215`). **A dead currency with two readers and no writer.**
- **`totalBeansEarned`** — monotonic lifetime counter, the real input to the *host* ladder.

### Authoritative conversion constants

Single source: Firestore `appConfig/economy`, read by `zipper-crm/lib/rates.ts:80-130` and `functions/src/wallet.ts:82`.

- `beanToDiamondRate` — **20 beans = 1 diamond**. `zipper-crm/lib/rates.ts:71`, with the reason at `:67-70`: *"Deliberate friction: without it, gift -> convert -> re-gift is a closed loop that mints diamonds nobody paid for."* Was once `0.5`, below the editor's own `min={1}`, so the shipped default was unenterable.
- `DIAMONDS_PER_LAKH = 100_000` — `backend/app/services/reports.py:155`
- `diamondPackPriceInr` retail / `sellerWholesalePriceInr` wholesale, both ₹ per lakh. Fallback `2390` (`rates.ts:63-65`). Wholesale above retail is clamped to retail (`rates.ts:106-108`).
- `beanToInrRate` fallback `0.01` (`rates.ts:62`)
- `usdToInrRate` fallback `95`, `diamondPackPriceUsd` fallback `23.9` (`rates.ts:66,73`)
- `userCallRatePerMin` default `1600` diamonds/min (`economyConfig.ts:283`)
- `callSplitMatrix` — a **gender × gender** payer/earner split table, `economyConfig.ts:122-126`: male→male 30, male→female 50, male→trans 40, female→male 40, female→female 30, trans→any 40. Server arithmetic isolated in `functions/src/pricing.ts` precisely so it is testable (`pricing.ts:1-14`).
- Gift category receiver shares: `normalReceiverPct: 30`, `exclusiveReceiverPctMin/Max: 30/60`, `luckyReceiverPct: 5`, `luckyReturnMin/Max: 5/20` (`economyConfig.ts:256-263`); applied by `receiverPctFor` (`functions/src/gifts.ts:509-520`) — note its `lucky` branch falls back to **50**, not the config default of 5.

---

# 4. CAPITAL / EXPENSES / LIABILITIES / PROFIT

### Capital (`backend/app/services/capital.py`)

A three-way split the owner may not have named: trading revenue, trading costs, and **capital**, which is neither.

> `capital.py:9` — "Both movements are real cash and both must be visible. **Neither is profit.**"

Two card types: `OWNER_CAPITAL_IN` ("Capital introduced") and `OWNER_DRAWINGS` ("Drawings") — `capital.py:65-68`. `DIRECTIONS = ("in", "out")` (:63), `CURRENCY = "INR"` (:58), amounts in paise via `_minor()` (:79).

A **capital contribution** is an owner funding the business from their own pocket. It is raised as a card on the same five-stage money board, and an owner **cannot sign their own** — `capital.py:38-40`: *"'how much did I put in' is a question three partners will one day disagree about, and the answer needs two names on it."* `record()` (:96) moves nothing; `mark_settled()` (:168) is owner-only and is the money actually moving.

`contribution_of()` (:213) reports per owner `introduced_minor`, `drawn_minor`, `outstanding_minor` — **executed cards only**. `outstanding` is explicitly *"a **liability**, not a pot to spend"* (:220-222).

### Expenses (`backend/app/services/expenses.py`)

Denominated `inr_minor` (paise), `CURRENCY = "inr_minor"` (:100). Eight categories (`ExpenseCategory`, :121-128): `staff_salaries`, `infrastructure`, `marketing`, `gateway_fees`, `binance_fees`, `taxes`, `refunds_to_users`, `other`. Seven are `REPORTED_CATEGORIES` (:134-142) — `other` is excluded because *"an empty `other` is genuinely no information, whereas an empty `staff_salaries` means nobody entered the payroll"* (:131-133).

Each expense carries a `period` label `YYYY-MM` (:104), a mandatory reason, duplicate-invoice-reference detection (`find_duplicate_invoice_refs` :292), a `repeat()` path for recurring costs (:433) and a `recurring_worklist(period)` (:567). Execution requires a `payment_ref` (`execute_expense` :493).

A trap worth flagging: `reports.py:4944-4949` warns `staff_salaries` is **not** the card type `salary_request`, which pays *hosts* and is already in host payouts.

### Liabilities

Three distinct liabilities, in three different places:
1. **Agency commission** — `commission_liability_change = accrued - paid` (`reports.py:1407`)
2. **Beans created** — `reports.py:1472-1476`, `_metric("beans_created", ..., "Future cash liability created this period")`
3. **Owner capital outstanding** — `capital.py:220`

Report endpoint: `GET /api/reports/liabilities` → `svc.outstanding_liabilities(rates)` (`backend/app/routers/reports.py:431-443`, service at `reports.py:2146`).

### Profit — two different formulas

**(a) `margin_report`** (`reports.py:1386`):
```
net_margin = revenue - payouts - liability_change      # reports.py:1419
margin_pct = net_margin / revenue * 100                 # :1434, null when revenue == 0
bean_payout_ratio = bean_value / diamond_value          # :1423, null never zero
```
`reports.py:436` restates it: `net_margin = revenue − payouts − (commission accrued − commission paid)`.

**(b) `profit_statement`** (`reports.py:4893`) — the owner's definition:
```
expenditure = sum(known lines)
profit      = revenue_minor - expenditure               # reports.py:4909
```
Its design point is honesty about gaps: an unknown expenditure line has `inr_minor = None`, **never zero** (`ExpenditureLine`, :4882-4890). With anything missing, `complete` is `False` and the profit is explicitly *"an **upper bound**"* (:4903).

`profit_and_loss()` at `reports.py:5024` is the composed report. CRM screens: `zipper-crm/app/finance/{capital,cash,costs,liabilities,payouts,profit,reports,withdrawals}`.

---

# 5. LENDING

**The business extends coin credit to coin sellers on trust.** Record: `sellers/{sellerId}/diamondLending/{lendId}` (`firestore.rules:1861`), shape at `zipper-crm/lib/economyConfig.ts:772-782` (`amount`, `lentBy`, `notes`, `status: 'outstanding' | 'repaid'`, `lentAt`, `repaidAt?`).

**Who lends what to whom:** the business lends **coins** (seller inventory) to an approved coin seller. Terms are a required `due_at` plus optional free-text `terms`.

Four card types, all on the money board (`backend/app/services/partner_ops.py`):

| Act | Service fn | Card type |
|---|---|---|
| Lend | `request_lending` :3601 / `execute_lending` :3640 | `LENDING_ISSUE` (:3622) |
| Repay | `request_repayment` :3710 / `execute_repayment` :3767 | `LENDING_REPAY` (:3741) |
| Recover | `request_recovery` :3830 / `execute_recovery` :3883 | `LENDING_RECOVER` (:3857) |
| Write off | `write_off_debt` :3971 / `execute_write_off` :4011 | audit `LENDING_WRITE_OFF` (:4046) |

**Recovery carries a penalty.** `penalty_coins` is *"a legitimate addition — a late penalty or recovery cost"* (`partner_ops.py:3839`). The arithmetic: `target = coins + penalty_coins` (:3853), then `remaining = max(0, outstanding + penalty - recovered)` (:3923), and the penalty is written to `credit.total_penalty` (:3937).

Seller credit state lives on the Mongo partner document as `credit.{outstanding, due_at, total_penalty}` (see `zipper-crm/app/lending/page.tsx:105-117`). Standing is derived: `overdue` / `due_soon` / current (`page.tsx:47-48`, `daysOverdue`, `standingOf`). Exposure reports: `creditApi.exposure()` and `creditApi.overdue()` (`page.tsx:87-88`).

**The deleted browser-side version is documented in place and is the real finding.** `zipper-crm/lib/economyConfig.ts:784-806` and `:820-843`:
> `:793-796` — "Lending is credit we extend, so it is money leaving the company on trust. It went out with no verification, no owner signature and — worse — no due date"
> `:827-830` — "One click cleared a debt. No money had to arrive, no payment reference was recorded, nobody countersigned"

Both blocks end `DO NOT REINTRODUCE.` The Firestore rules now refuse browser writes to `coinBalance`.

---

# 6. UNDISCUSSED ACTORS / SPECIAL PRINCIPALS

### Service credentials (machine identities in the backend)

`backend/app/core/security.py`. Three, each deliberately narrow, presented as `X-Service-Key`, and each resolving to a `system:`-prefixed actor that `backend/app/core/audit.py:32` reserves (`SYSTEM_UID_PREFIX = "system:"`; `audit.py:222-231` *refuses* a non-prefixed system actor and vice versa).

| Credential | uid | file:line | Can do |
|---|---|---|---|
| `weekly-accrual` | `system:weekly-accrual` | `security.py:1343-1350` | Create agency commission liability (two routes only) |
| `reporting` | `system:reporting` | `security.py:1374-1379` | Send reports. `security.py:1292` — "the worst a leaked reporting key can do is send a report" |
| `partner-registration` | `system:partner-registration` | `security.py:1424-1429` | Enqueue a new agency/seller into Mongo `partners` |

### Automated (non-credentialed) system actors

- `system:player_protection` — "Player protection (8B.6)" — `backend/app/services/player_protection.py:138-143`. Writes limit maturities, pattern flags, and refusal records nobody pressed a button for.
- `system:suspension_sweep` — `backend/app/services/scheduling.py:821`
- `system:chance:{caller}` — per signed external caller, `backend/app/services/chance.py:4484`

### Third-party chance providers — an actor that can move money

`settle_external_round` (`chance.py:4492`) lets an outside game operator settle a round. HMAC-SHA256 over a canonical string (`canonical_string` :4424, `sign_request` :4428, `verify_signed_caller` :4436), freshness window `CALLBACK_MAX_AGE_SECONDS = 300` (:166), keys from `SIGNING_KEYS_ENV`. The payout is **recomputed on this side** and the settlement refused if the provider's figure disagrees (:4502-4506). Endpoint `POST /chance/edge/settlements` (`backend/app/routers/chance.py:652`). An eight-item integration contract is written out at `chance.py:4508-4530`.

### Third-party integrations

| Integration | Purpose | Configured at |
|---|---|---|
| **Agora RTC** (`full-sdk` 4.5.0) | All voice/video — calls, live, party rooms | `AGORA_APP_ID`/`AGORA_APP_CERTIFICATE` in functions env; token minted by `generateAgoraToken` (`functions/src/index.ts:2134-2159`, `RtcTokenBuilder` at `:6`, `:2334`). Client: `zipper-app/.../ui/screens/live/AgoraManager.kt`, `di/AgoraModule.kt`, `data/repository/AgoraTokenRepository.kt` |
| **SendGrid** | Every email, plus inbound bounce/drop/spam webhook | `PROVIDER = "sendgrid"` (`backend/app/services/email.py:79`), `sendgrid_api_key` (`backend/app/config.py:90`). Event Webhook ingested by `record_provider_events()` (`email.py:21-23`) |
| **FCM** | Push: ring, chat, live-started. All **data** messages, never notification messages | `functions/src/push.ts` (header :1-30). Tokens at `users/{uid}/fcmTokens/{token}`, one doc per device |
| **Firebase Storage** | Host verification photos, OTA APKs | `firebase_storage_bucket = "zipper-83816.firebasestorage.app"` (`config.py:26`), `storage.rules`, `storage-cors.json` |
| **Firebase Crashlytics + Analytics** | Crash/usage telemetry | `zipper-app/gradle/libs.versions.toml:67-68`, plugin `:148` |
| **Google ML Kit face detection** | Liveness/face checks | `libs.versions.toml:113`; used in `zipper-app/.../auth/FaceVerificationScreen.kt`, `live/FaceDetectionManager.kt`, `live/GoLiveViewModel.kt` |
| **TensorFlow Lite + Firebase ML Model Downloader** | On-device model, downloaded at runtime | `libs.versions.toml:114-115`; `FaceVerificationScreen.kt` |
| **Google Play Services Block Store** | Keeps the quick-login secret inside Play Services so it survives clear-data, uninstall and device transfer | `libs.versions.toml:123` with the rationale at `:119-122`; `zipper-app/.../util/DeviceSecretStore.kt`, `util/QuickLoginStore.kt` |
| **Play Services Location** | Geolocation | `libs.versions.toml:118` |
| **GPUImage** | Beauty filters | `libs.versions.toml:112` |
| **Credential Manager + Google ID** | Google sign-in | `libs.versions.toml:70-72` |
| **Media3 / ExoPlayer + Transformer** | Playback and media transcode | `libs.versions.toml:85-89` |
| **Lottie** | Animated gifts (`giftLottieData`) | `libs.versions.toml:92` |
| **CameraX** | Capture | `libs.versions.toml:95-99` |
| **Apache Commons Compress** | Exactly one class, `BZip2CompressorInputStream`, for OTA binary patching | `libs.versions.toml:131` |
| **Google Cloud service-account token minting** | Server-side signed URLs / verification | `backend/app/services/verification.py:168-174` returns `{service_account_email, access_token}` |

**Payout rails are manual, not integrated.** `paymentMode` is a free-text field: `'NEFT | IMPS | UPI | Binance | USDT'` (`zipper-crm/lib/firestore.ts:549`), with UTR/transaction-ref/proof-URL captured by hand (`:545-548`). Bank and Binance account details live in `appConfig/paymentCredentials`, edited from `zipper-crm/app/app-config/payment-creds/page.tsx` — whose header records that the live IFSC, account number, holder name and Binance UID were previously **hardcoded as `DEFAULTS` in that source file** (`:14-23`). There is no payment gateway SDK anywhere in the repo; `gateway_fees` and `binance_fees` are expense categories, and `alerts.py:684` defines a `gateway_settlements` collection the settlement-mismatch detector reads.

---

# 7. UNDISCUSSED MODULES

All of the candidates are real. Plus several you did not list.

### Live / social product surface

- **Party rooms** — `functions/src/party.ts` (1,450 lines), 17 callables (`createPartyRoom` :325 → `endPartyRoom` :1349). Multi-seat audio/video rooms: `partyRooms/{id}/seats/{seatIndex}`, `/seatRequests/{uid}`, `/seatInvites/{uid}`, `/listeners/{uid}`, `/messages`, `/gifts` (`firestore.rules:2163-2320`). Seats are callables, not client writes, for two stated reasons: contention (one winner per transaction) and the fact that `generateAgoraToken` issues PUBLISHER *only* to someone on a seat — otherwise "leave the seat" is a UI state a patched client can ignore while still broadcasting (`party.ts:19-31`). Seat counts are an enumerated **device budget**, not a preference: a video seat is a decoded stream and the failure mode is "a room that takes the phone down" (`party.ts:33-40`, `SEAT_CHOICES` :58). Modes `audio`/`video`, seat modes `free`/`consent`, visibility `public`/`private` (:48-67). Room-level roles: `setPartyAdmin` (:1296), `setPartySeatMute` (:1191), `setPartySeatLock` (:1257).
- **PK battles** — `zipper-app/.../data/repository/PKRepository.kt`, `pkInvites` collection (`firestore.rules:2036`). Host-vs-host matchmaking queue (`enterPKQueue`), 3-minute rounds (`PK_DURATION_MS` :17), scored on gift value into `liveRooms.pkScore` / `.pkPartnerScore` (`:217-219`). **The score increment is written client-side from the Android app** and the rule at `firestore.rules:2039` permits any participant to update. No prize mechanic found.
- **Top Fans** — `users/{uid}/topFans/{fanUid}` (`firestore.rules:1278`), written server-side at `functions/src/gifts.ts:337-343` with `totalDiamonds` incremented. "PUBLIC, named — how much, never which gift" (`gifts.ts:336`).
- **Gift Showcase** — `users/{uid}/giftShowcase/{giftId}` (`firestore.rules:1271`), written at `gifts.ts:250-251`. Privacy-aware: `profiles.ts:132` — "a gallery nobody can open is not a gallery".
- **Gift pairs** — `giftPairs/{pairId}` with `aToBCount`/`bToACount` (`gifts.ts:248`, `:331-332`; `firestore.rules:2918`). A per-relationship reciprocity counter.
- **Gift Lottie data** — `giftLottieData/{docId}` (`firestore.rules:1473`), animation payloads split off the gift catalogue.
- **Likes / follow graph** — `functions/src/social.ts` (`toggleLike`, `syncMyRoles`). Header :8-15: counters were client-written, so a rule had to permit any account to modify `totalLikesReceived` on any other, and *"both are the same write"*. Also `users/{uid}/{followers,following,liked,likedBy,blocked}`.
- **Public profile projection** — `functions/src/profiles.ts` (`syncPublicProfile`, `syncLivePresence`, `backfillPublicProfiles`). Exists because `users/{uid}` was readable by every signed-in account and the Home feed deserialised 20 at a time, exposing `phoneNumber`, `email`, `dob` (`:7-14`).
- **Calls** — `functions/src/calls.ts`, `callHistory`, `calls/{id}/messages`. 10-second tick billing with a 1-minute watchdog.

### Economy / app config

- **Levels** — two separate ladders. `levelConfig/host/levels` is real: `applyHostLevel` + nightly `sweepHostLevels` maintain `users/{uid}.hostLevel`, scored on lifetime beans, and the rung sets the host's max call rate (`functions/src/hostStats.ts:32-110`, fallback ladder `:41-48` — the previous one went to "12,000 beans/min"). `levelConfig/user/levels` is scored on `totalXp`, which nothing writes (see §3). Thresholds in `zipper-app/.../util/LevelEngine.kt:63-80` (L0→L20+, 1 lakh to 90,000 lakh diamonds). XP rules at `LevelEngine.kt:6-18`: calls and normal/special gifts 100%, **lucky gifts and gaming bets 1%**. CRM: `zipper-crm/app/app-config/levels`.
- **Bag items / MyBag** — `bagItems/{itemId}` catalogue (`firestore.rules:1486`), `users/{uid}/ownedItems/{itemId}` inventory (`:1335`). Rentable cosmetics: `purchaseBagItem` (`wallet.ts:~380`) charges diamonds and **extends** from `max(now, existing expiry)` so an early renewal does not discard paid days (`:399-408`); `equipBagItem` writes category→pointer; hourly `expireCosmetics` reaps both row and pointer. Categories include `crown`, `profile_card`, `profile_frame`, `chat_bubble`, `bag`, `badge` (`economyConfig.ts:149`). CRM: `app-config/bag-items`, `tech/content`.
- **Daily rewards** — `claimDailyReward` (`functions/src/wallet.ts:~190-286`). 7-day streak, IST day keys, idempotent on `users/{uid}/dailyClaims/{today}` (:198). Default schedule `wallet.ts:211-214`. A documented field-name mismatch: the CRM writes `callCards`, the app's old table said `freeCallMinutes`, so *"every claim granted zero cards while the CRM and the app both displayed 'x1 / x2'"* (`:252-256`). CRM: `app-config/daily-rewards`.
- **Content config** — `contentConfig/levels/items` and `contentConfig/profileCards/items` (`zipper-crm/lib/tech.ts:167-184`; `firestore.rules:1535`).
- **App control / feature flags + kill switch** — `appConfig/control`. `maintenanceMode`, `maintenanceMessage`, `forceUpdate`, `minVersion`, and 10 feature flags: `live_streaming`, `voice_calls`, `gifts`, `lucky_gifts`, `leaderboard`, `coin_shop`, `bean_withdrawal`, `referrals`, `events`, `agency_portal` (`zipper-crm/app/tech/appcontrol/page.tsx:24-45`). Superadmin-only. This is the global kill switch.
- **Economy config** — `appConfig/economy` (`zipper-crm/lib/economyConfig.ts`, `app/economy/config`). Two dead sub-objects explicitly deleted on save: `levelEntries` and `levelUnlockItems` (`economyConfig.ts:668-712`, `deleteField()` at `:712`). `levelEntries` carried `hostEntriesPerHour`, `userEntriesPerGift`, `minGiftValueForEntry` (`:139-143`) — the shape of a **raffle/prize-draw entry system that was designed and removed**.
- **Packages** — `rechargePackages`, `diamondPacks`, `coinPackages` (`firestore.rules:2826-2838`); CRM `app-config/packages`.
- **Profile options** — `app-config/profile-options`.

### Identity & access (beyond phone/E.164 and guest binding)

- **Quick-login tokens** — `quickLoginTokens/{sha256(secret)}`, *the document id IS the hash* (`functions/src/identity.ts:596`). Mint/redeem/revoke at `:636-759`, nightly sweep at `:1135`. Backed by Play Services Block Store on the device, so the secret survives uninstall.
- **Banned devices** — `bannedDevices/{deviceId}` (`firestore.rules:452`). A ban document is keyed by device id "because that is the path the Android app reads", and lifting it **deletes** the document because the app only checks existence (`zipper-crm/app/operations/bans/page.tsx:1-16`). Two creation paths with different release rules.
- **Identity resolutions** — `identityResolutions/{id}` (`firestore.rules:517`)
- **Verified identities** — `verifiedIdentities/{docId}` (`:525`); `bindVerifiedIdentity` is the authoritative uniqueness check (`firestore.rules:989`)
- **CRM role derivation** — `functions/src/crmRoles.ts` (`deriveRoleFlags`, `normaliseCrmRole`), deliberately import-free so it is testable
- **Account deletion & recovery** — `functions/src/accounts.ts`: `requestAccountDeletion`, `recoverAccount`, `purgeMyAccountNow`, `purgeDeletedAccounts`. Grace period, then hard purge — but **seven subcollections are retained on purpose**: `RETAINED_SUBCOLLECTIONS = ['diamondTransactions','beanTransactions','dailyStats','weeklyEarnings','warnings','giftShowcase','blocked']` (`accounts.ts:141-144`), because *"A user tapping 'delete my account' is asking to leave, not asking the business to forget that money changed hands"* (`:136-139`).

### Moderation / operations

- **Appeals** — `backend/app/services/appeals.py`, `appeals/{appealId}` (`firestore.rules:2365`), CRM `operations/appeals`. The **return path** against a moderation decision; before it existed the honest answer was "email support and hope" (`appeals.py:5-6`). Two raiser types: the banned account itself (still signed in — `isBanned` gates the product, not the session) and **their agency** (`:10-21`). Four consequence types reverse differently: `ban` → unban + lift the device bans that ban caused; `suspend` → `user.resumed`, no device touched; `warn` → marked overturned, never deleted; `deduct` → if signed, returning beans is a **new movement an owner must sign** (`:31-45`).
- **Warnings** — `users/{uid}/warnings/{warningId}` (`firestore.rules:1350`), retained through purge.
- **Live intervention** — `backend/app/services/live.py`. End a stream / mute a host with a **mandatory reason**, through the Admin SDK. The CRM used to set `isActive: false` directly — *"a browser writing app state directly is a change with no actor, no reason and no audit entry"* (`live.py:8-18`).
- **Reports / ticketing — five separate collections**: `reports/{reportId}` (user reports), `feedbackTickets`, `supportTickets`, `crmSupportTickets`, `techTickets`, `opsTickets` (`firestore.rules:2321`, `2007-2036`, `1560-1570`). CRM: `feedback`, `tickets`, `tech/tickets`, `operations/{reports,feedback}`. Two screens disagreed about the status vocabulary — one wrote `open/assigned/in_progress/resolved/closed`, the other `open/in_review/resolved` — so tickets were mutually invisible (`zipper-crm/app/feedback/page.tsx:4-16`).

### Comms

- **Alerts** — `backend/app/services/alerts.py`, `alert_state` suppression, CRM `app/alerts`. **~15 detectors**: bank details changed (:332), rate feed failed (:376), duplicate payment refs (:461), large card awaiting signature (:527), execution failed (:596), gateway settlement mismatch (:693), queue ageing (:759), staff access changed (:843), failed logins (:890), credit overdue (:952), email delivery failures (:1001), chance suspended (:1077), chance reserve low (:1118), chance RTP divergence (:1171), chance player anomaly (:1247). Keeps `failed` and `not_applicable` distinct from "clear" (`zipper-crm/app/alerts/page.tsx:6-16`).
- **Broadcasts — two unrelated things under one word.** (a) In-app: `broadcasts/{broadcastId}` + `announcements/{docId}` (`firestore.rules:2504`, `:2566`), CRM `app/broadcasts`. (b) Composed email: `backend/app/services/broadcast.py` + `backend/app/routers/broadcasts.py`, CRM `app/broadcasts/email` and `tech/email`. Explicitly **not a second delivery path** — it hands off to `email.deliver_many` so the delivery log stays the truth (`broadcast.py:9-15`).
- **Notify / subscriptions** — `backend/app/services/notify.py`. Two address sources and *"no third"*: Mongo `staff` by role for internal, the partner's own Firestore `ownerEmail` for partner-facing, **with no constant fallback anywhere** — so a missing owner resolves to *nobody* and says so (`notify.py:9-22`). Per-report/per-cadence mute and unsubscribe.
- **Email delivery log** — Mongo `email_deliveries` with a unique `dedupe_key`, status machine `queued/sent/delivered/failed/dropped/deferred/unsubscribed/not_configured` (`email.py:90-100`). Provider rejections keep the provider's own words (`:27-31`).
- **Policies** — `policies/{docType}` (`firestore.rules:2585`), CRM `app/policies` + `lib/policies.ts`. Three doc types: `privacy_policy`, `terms_of_service`, `faq`. App-facing legal text, editable without a deploy.

### Staff workflow

- **Board** — the five-stage money board, `zipper-crm/app/board`. Shows `rejected` and `failed`; `failed` is the state an execution lands in *after* an owner signed and the transfer did not go through, and it was previously invisible (`page.tsx:26-33`).
- **Inbox** — `zipper-crm/app/inbox`. Cross-board "waiting on you". It previously read only money cards, so it showed "Nothing is waiting on you" while partner documents and staff permission requests sat for weeks (`page.tsx:7-16`).
- **Throughput** — `zipper-crm/app/throughput`, `/reports/team-throughput`. Cards raised/verified/signed/executed/rejected, **medians not averages**, oldest open item named; an uncompleted stage reports `null` not `0` because *"A zero would read as 'instant'"* (`page.tsx:11-14`).
- **Jobs board** — `zipper-crm/app/tech/jobs`, five outcomes `ok/degraded/failed/never/…`. `degraded` exists because collapsing it is *"how a report that has been missing a section for a month goes unnoticed"* (`page.tsx:18-22`).
- **Onboarding** — `zipper-crm/app/onboarding`. Exists because three of the four partner entry paths were linked from nowhere (`page.tsx:3-11`).
- **Sales** — `zipper-crm/app/sales`, `POST /partner-ops/sales`. The missing half of the seller inventory book: the endpoints existed and were audited for as long as the API has, *"Nothing in the CRM called any of them, so no sale was ever filed, and a seller's inventory only ever went up"* (`page.tsx:3-9`). Filing moves nothing; approving is owner-only and is where value moves.
- Also: `app/analytics`, `app/observer`, `app/team-access`, `app/approvals`.

### A whole distribution channel: self-hosted OTA app updates

Not on your list and not a small thing. The app side-loads its own updates outside Google Play.

- `backend/scripts/publish_apk.py` — reads `versionCode`/`versionName` **out of each APK binary** rather than a flag, uploads per-ABI to Storage `appBuilds/{channel}/{abi}/`, writes `appConfig/androidUpdate.{channel}`. Channels `debug`/`release`. One APK per ABI because a single fat APK carried 50.4 MB of arm64 and 35.3 MB of identical 32-bit libraries out of 125 MB.
- `zipper-app/.../util/BsPatch.kt` — a from-scratch **BSDIFF40 binary patcher**, so build N→N+1 ships single-digit MB instead of ~90 MB (`:17-23`).
- `zipper-app/.../util/ApkInstaller.kt` — downloads over plain HTTP (deliberately **not** `DownloadManager`, which can be silently disabled by battery-saver apps and still returns an id — observed three times, `:30-45`), SHA-verifies against the published digest, hands to the system installer via `FileProvider`, requires the install-unknown-apps permission.
- `zipper-app/.../data/repository/UpdateRepository.kt`, `util/AppVersion.kt`.

---

# 8. EVENTS

**Partially present, mostly absent — and the gaps are specific.**

What exists:
1. **`MechanicKind.EVENT = "event"`** — `backend/app/services/chance.py:239`, *"a limited-time mechanic (8B.12)"*. A first-class chance mechanic kind. Nothing in the repo creates one, and spec 8B.12 is referenced but not implemented here.
2. **An `events` feature flag** — `zipper-crm/app/tech/appcontrol/page.tsx:43`, `{ key: 'events', label: 'Events', description: 'In-app event system' }`, default enabled. There is **no `events` collection** in `firestore.rules`, no events router, no events service, no Android screen. The flag gates nothing that exists.
3. **A deleted raffle-entry design** — `levelEntries` (`zipper-crm/lib/economyConfig.ts:139-143, 265-271`): `hostEntriesPerHour`, `userEntriesPerGift`, `minGiftValueForEntry` per level. Explicitly removed from config management and `deleteField()`-ed on every save (`:668-712`).

**Leaderboards do exist, in two unrelated forms:**
- **Reporting leaderboards** (no prizes, email only): `reports.leaderboards()` at `backend/app/services/reports.py:4606`, report `weekly_leaderboards` titled *"Leaderboards — recharges, gifts received, lucky-gift spend"* (:4772-4773). Row cap at `:3008` — *"The owner asked for 'highest', not 'all'."* Rendered in `zipper-crm/app/reports/weekly/page.tsx:132,177,626`.
- **In-room live leaderboards** (real-time, no prizes): `liveRooms/{roomId}/gifts` ticker and `partyRooms/.../seats.beansReceived`. Both moved server-side because the client used to write its own `diamondCost`, so *"a modified app could top the board for free"* (`functions/src/gifts.ts:424-428`); `PartySeat.beansReceived` *"has existed on the model since the room was first built and no code has ever incremented it, so every seat has always shown zero"* (`:453-455`).

**No scheduled competitions, no campaigns with prizes, no contests, no tournaments.** PK battles (§7) are the closest thing to a competition and have no prize mechanic. "Campaign" appears only as expense-category prose (`backend/app/services/expenses.py:147`, `reports.py:4953-4957`).

---

# 9. MONEY MOVEMENTS WITH NO LEDGER ENTRY

**There are two different kinds of gap here, and the second is architectural.**

### 9a. The architectural gap: no Cloud Function write ever reaches the Mongo ledger

Every app-side money movement is written by Cloud Functions into Firestore. The business ledger is Mongo `ledger` (`backend/app/db/mongo.py:43`, unique sparse index on `idempotency_key` at `:177`), written **only** by `money.apply_movement` (`backend/app/services/money.py:171`). No Cloud Function calls it.

This is stated in the code, not inferred:
> `backend/app/services/money.py:193-196` — "The app spends diamonds through Cloud Functions that Mongo never hears about, so `after` is only ever a lower bound on the truth, and writing it over the live balance refunded every gift and call charge since the CRM last touched this holder."
> `backend/app/services/reconcile.py:10-12` — "Nothing has ever compared the two... every gift and every minute of call time now lands in Firestore and nowhere else."

`scheduledReconciliation` detects divergence nightly and **corrects nothing** (`functions/src/index.ts:3816`). The Firestore-side substitute for a ledger is the per-user `diamondTransactions` / `beanTransactions` subcollections plus `platformRevenue`.

### 9b. Sites that mutate a balance with no transaction row at all

| # | Site | Balance moved | Finding |
|---|---|---|---|
| 1 | `functions/src/index.ts:1622-1625` | `sellers/{id}.coinBalance` (direct set, not increment) + `totalCoinsSold` | **The clearest single gap.** `onRechargeApproved` writes a `diamondTransactions` row for the *buyer* (`:1633-1640`) and writes **nothing at all on the seller side**. No `coinTransactions` collection exists anywhere in the repo. A seller's coin inventory is decremented with no per-movement record in either store. |
| 2 | `functions/src/calls.ts:390` | payer `users/{uid}.diamonds` | `tickCall` charges every 10 seconds with no transaction row. Mitigated: `endCall` writes one rollup row for the whole call at `:536-563`, and the tick is idempotent via `tickIndex`. But a call that never reaches `endCall` moves diamonds with no row. |
| 3 | `functions/src/calls.ts:392-394` | earner `beans`, `totalBeansEarned`, `hostCallEarnings` | Same: credited per tick, rolled up only at `endCall` (`:550-563`). |
| 4 | `functions/src/calls.ts:494` | payer `diamonds` (final part-tick) | Inside `endCall`, so covered by the `:536` row. |
| 5 | `functions/src/calls.ts:496-498` | earner `beans`, `totalBeansEarned`, `hostCallEarnings` | Covered by `:550`. |
| 6 | `functions/src/payouts.ts:63-64` | `users/{uid}/weeklyEarnings/{weekKey}.beans` and `.{gift|call}Beans` | `accrueWeeklyEarning` — no transaction row of its own. It commits inside the caller's transaction, which is the point (`:47-49`), but the accrual bucket itself is unlogged. |
| 7 | `functions/src/wallet.ts:144-145` | `weeklyEarnings.beans` ↓ / `.convertedBeans` ↑ | Bean conversion draws down unreleased weeks. The user-level rows at `:151` and `:161` exist; the per-week redistribution has no row. |
| 8 | `functions/src/gifts.ts:447` | `liveRooms/{roomId}.totalBeansEarned` | Room aggregate, not an account. |
| 9 | `functions/src/gifts.ts:464` | `partyRooms/.../seats/{i}.beansReceived` | Seat aggregate. Written best-effort and **skipped silently** if the seat is gone (`:457-460`). |
| 10 | `functions/src/gifts.ts:341` | `users/{uid}/topFans/{fanUid}.totalDiamonds` | Public aggregate. |
| 11 | `functions/src/gifts.ts:260` | `users/{uid}.totalGemsSpent` | Lifetime counter that drives the user level; no row, no reconciliation. |
| 12 | `functions/src/wallet.ts:269` | `users/{uid}.videoCards` | **A consumable asset created with no transaction row and no reconciliation.** The adjacent `diamondTransactions` row at `:274` records the diamonds only; `videoCards` is minted silently. |
| 13 | `zipper-crm/lib/firestore.ts:560-594` | nothing (status only) | `approveWithdrawal` / `markWithdrawalPaid` / `rejectWithdrawal` are plain `updateDoc`s from the **browser**, with `processedBy: 'Admin'` hardcoded (`:564`, `:582`, `:592`). They move no balance — the bean debit is a money-board card — but the payment-proof record (UTR, mode, proof URL) is written client-side with no actor identity and no audit entry. |

### Android: clean

I found **no** Android write to any balance field. Every `diamonds`/`beans`/`coinBalance` reference in `zipper-app/app/src/main/java` is a `getLong` read or a callable result (`User.kt:229-232`, `MoneyFunctions.kt:132-554`, `HomeViewModel.kt:140`, `BuyCoinScreen.kt:168`). The Android `FieldValue.increment` calls are non-money only: `unreadCount` (`ChatRepository.kt:126,173`), `viewerCount`/`likeCount` (`LiveRepository.kt:167,173,335,372`), `pkScore`/`pkPartnerScore` (`PKRepository.kt:217-219`).

`firestore.rules:1001-1008` blocks balance fields at **create** as well as update, closing the "new account holding any number of diamonds" path (`:997-1000`).

### Previously-existing paths now explicitly removed (documented in place)

Worth knowing because each describes a real past exposure:
- `functions/src/index.ts:71,87-90` — `agencies/{id}.update({ commissionBalance: increment(commissionInr) })`, with *"no ledger entry, no audit entry, no derivation anyone could read back, and no idempotency — so a re-run accrued the same week again."* Also removed: a hardcoded slab table starting at `from: 0` with rates found nowhere else, charged progressively where the real rule is flat-by-band.
- `functions/src/index.ts:2883-2886` — the approval queue used to apply bean/diamond/coin changes on one superadmin's status flip: *"one approver, no verification, no separation of duties, no ledger, no audit entry."* Now refused via `MONEY_APPROVAL_TYPES` (`:2901-2907`).
- `functions/src/index.ts:1987-1991` — `onPayoutApproved` used to set `beans: 0` on every host at *approval*: *"A report that is approved but never paid had already wiped what the host earned, with no ledger entry and no way to reconstruct the balance."*
- `functions/src/index.ts:2918-2921` — `operation === 'update'` took collection, doc id and payload all from the browser: *"an approved request could rewrite any document in any collection."*
- `zipper-crm/app/economy/currency/page.tsx:3-11` and `zipper-crm/lib/economyConfig.ts:784-843` — browser-side `increment()` on user diamonds and seller `coinBalance`, plus one-click debt clearing.
- `functions/src/calls.ts:49` — *"Eleven balance writes across two files produced ZERO ledger rows."*

---

# 10. IDEMPOTENCY

### Where keys exist

| Guard | Shape | file:line |
|---|---|---|
| Mongo ledger | **unique sparse index** on `idempotency_key` | `backend/app/db/mongo.py:177`; `DuplicateKeyError` → `DuplicateMovement` at `money.py:174-177` |
| Gifts | `giftIdempotency/{senderUid}_{idempotencyKey}` | `functions/src/gifts.ts:117`; rule `firestore.rules:2925`. Claim written **last** so a mid-transaction crash leaves nothing claimed (`gifts.ts:494-495`) |
| Calls | `callIdempotency/{callerUid}_{idempotencyKey}` | `functions/src/calls.ts:112` |
| Wallet | `walletIdempotency/{uid}_{idempotencyKey}` | `functions/src/wallet.ts:52` (convertBeans), `:316` (purchaseBagItem) |
| Daily reward | `users/{uid}/dailyClaims/{istDateKey}` — natural key | `functions/src/wallet.ts:198` |
| Chance stake | `chance:{rid}:stake` | `backend/app/services/chance.py:2356` |
| Chance payout | `chance:{rid}:payout` | `chance.py:2513`; external settlement reuses the same key at `:4709` |
| Chance exposure counters | unique index on `key` + atomic CAS | `mongo.py:344`; `chance.py:2735-2736` |
| Chance rounds | unique index on `round_id` | `mongo.py:314` |
| Chance configs | unique on `(mechanic_id, version)` | `mongo.py:299` |
| Email | `email_deliveries.dedupe_key` unique; prefix `f"{report_key}:{cadence}:{period_key}"` | `functions/src/index.ts:3774`; `scheduling.py:453`, `:1226` |
| Commission accrual | idempotent on **agency + host + period** | `functions/src/index.ts:100-101` |
| External provider | *"a settlement reference unique per round and **stable across retries**, so their retry is our idempotency key rather than our second payout"* | `chance.py:4515-4516` |

### Where money moves WITHOUT one

1. **`onRechargeApproved` — `functions/src/index.ts:1545`.** The highest-value one. Its only guard is the status transition `before.status === after.status || after.status !== 'approved'` (`:1572`), and the code **deliberately keeps that guard loose enough to re-fire**: a failure sends the request back to `pending` so the next `pending → approved` retries (`:1568-1570`). There is no idempotency key on the transfer. Two approvals of the same request, or a double transition, transfer coins and credit diamonds twice. The comment explains why the retry is needed (the buyer already paid cash outside the system) but does not pair it with a dedupe key. The diamond credit and coin debit are each a read-then-direct-set inside one Firestore transaction (`:1622-1630`), which is atomic but not idempotent.

2. **`tickCall` — `functions/src/calls.ts:390-395`.** No idempotency key. Guarded instead by `tickIndex` arithmetic: a replayed tick finds `outstanding <= 0` and charges nothing (`:361-364`). Effectively idempotent, but by state comparison rather than a key.

3. **`releaseBeansForWeek` — `functions/src/payouts.ts:131-133`.** No key. Guarded by the `released: false` flag flipped in the same transaction (`:134-138`).

4. **`expireCosmetics` — `functions/src/wallet.ts:567`.** No key. Guarded by `expired == false`, and the comment at `:573-581` records that the original `!=` form *"would have matched nothing, forever, while appearing to run fine every hour."* No money moves (no refund), so the exposure is a user keeping an item they stopped paying for.

5. **`accrueWeeklyEarning` — `functions/src/payouts.ts:51-70`.** No key of its own. It is a `tx.set(..., {merge:true})` with `increment`, so it inherits the caller's idempotency (gift or call claim). Safe only as long as every caller holds one.

6. **`weeklyPayoutReportGenerator` — `functions/src/index.ts:931`.** The commission accrual it triggers is idempotent server-side on agency+host+period, but the Firestore report write itself has no key.

7. **`dailyPlatformStatsAggregator` — `functions/src/index.ts:1898`.** Writes `platformRevenue/{dayLabel}` with `.set(..., merge)` — a natural key, so a re-run overwrites rather than doubles. The `platformRevenue` rows written per-gift (`gifts.ts:472`) and per-call (`calls.ts:569`) use `.doc()` with an **auto-id**, so a retried settlement that got past the claim check would double-count revenue; in practice the gift/call claim guards upstream.

8. **Withdrawal status writes — `zipper-crm/lib/firestore.ts:560-594`.** No key, no actor, no audit. `markWithdrawalPaid` can be called repeatedly, each time overwriting the payment proof.

9. **`videoCards` minting — `functions/src/wallet.ts:269`.** Covered by the `dailyClaims/{today}` natural key, but the asset itself has no transaction row to reconcile against (see §9b #12).