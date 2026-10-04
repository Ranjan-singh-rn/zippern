I've read the four feature paths end to end. Report below.

---

# ZIPPERN — Calls, Live, Party, Gifting

**Scope note on authority.** Three of the four features are server-owned (callables + Admin SDK, which bypasses `firestore.rules`). **Live is the exception: there is no `startLive`/`endLive` callable anywhere.** The room document is created and mutated directly by the Android client (`zipper-app/.../data/repository/LiveRepository.kt:144`, `:153`), and `firestore.rules` is the only gate. That asymmetry explains most of the broken Live paths below.

---

# 1. CALLS

## 1.1 The state machine

Status strings written by the server, all in `functions/src/calls.ts`:

| status | written at | money |
|---|---|---|
| `ringing` | `calls.ts:184` (startCall) | none |
| `connected` | `calls.ts:252` (acceptCall) — also stamps `startedAt` + `lastTickAt` | clock starts |
| `ending` | `calls.ts:383` / `:417` (tickCall, payer broke) | last affordable tick already taken |
| `ended` | `calls.ts:524` (settleAndClose) | final part-settlement |
| `declined` | `calls.ts:288` (declineCall) | none |
| `missed` | `calls.ts:288` (receiver passes `reason:'missed'`) or `calls.ts:710` (watchdog) | none |

Reachable transitions: `ringing → connected → (ending) → ended`; `ringing → declined`; `ringing → missed`. There is no `ending → connected` recovery and no re-ring.

`endReason` vocabulary: `user_ended`, `receiver_declined`, `caller_cancelled`, `missed`, `diamonds_exhausted`, `watchdog_timeout`, `no_answer`.

Android maps `ending` to the **CONNECTED** UI state deliberately (`VideoCallViewModel.kt:161`) — the call is still billing while it settles.

## 1.2 Who may call whom

`startCall` (`calls.ts:92`) gates, in order:
1. Signed in (`:96`).
2. `peerUid` present, not self (`:99`–`:104`).
3. `idempotencyKey` present (`:105`).
4. Replay: `callIdempotency/{callerUid}_{key}` exists → returns the original result, `replayed: true` (`:120`).
5. Both accounts exist (`:121`–`:122`).
6. **Receiver has not blocked the caller** — `users/{peer}/blocked/{caller}` (`:113`, `:123`). One-directional: a caller who blocked the *receiver* is not stopped.
7. **Both** sides un-banned (`:136`, `:141`).
8. The **payer** can afford one minute (`:160`–`:171`).

There is **no host-only gate, no verification gate, no online/presence gate, no gender gate and no age gate.** Any un-banned user may ring any un-banned user. `OtherUserViewModel.initiateCall` (`:365`) is the only UI entry point, from a profile.

Only the receiver may `acceptCall` (`:238`). Either party may `declineCall` while ringing (`:278`), may `tickCall` (`:345`), and may `endCall` (`:458`).

## 1.3 Billing mechanics

- **Tick interval: 10 seconds.** `const TICK_SECONDS = 10` (`calls.ts:65`). The Android loop matches it (`CallRepository.kt:314`, `VideoCallViewModel.kt:226`).
- **Who drives the tick:** only the paying side's device (`VideoCallViewModel.kt:218`). Either party is *permitted* to tick (`calls.ts:345`) but only one does.
- **Elapsed is server-computed** from `startedAt` (`calls.ts:356`). Nothing from the client is used.
- `ticksDue = floor(elapsedSec / 10)` (`:357`); `outstanding = ticksDue − tickIndex` (`:359`).
- **`tickIndex`** is the server's count of ticks already charged. Initialised `0` at `:196`, advanced at `:412`. `outstanding <= 0` returns `charged: 0` (`:362`) — this is the duplicate-tick guard.
- **Per-tick charge:** `perTick = ceil(perMin × 10 / 60)` = `ceil(perMin / 6)` (`calls.ts:367`, repeated at `:478`).
- **Per-tick beans:** `beans = floor(diamonds × pct / 100)` (`:388`, `:487`).
- **Part-tick at the end: not charged.** `settleAndClose` bills only `floor(durationSeconds / 10) − tickIndex` whole ticks (`:480`–`:486`). Comment at `:475`: *"A partial tick is not charged"*.

`userCallRatePerMin` is the **flat user↔user price**, 1,600 diamonds/min by default (`pricing.ts:178`; CRM default `zipper-crm/lib/economyConfig.ts:283`). It is used **only** when neither party is a host. Host calls derive the price from the earner's bean income instead.

## 1.4 `callSplitMatrix` — reported, not reinterpreted

The table as it stands in `functions/src/pricing.ts:76`–`:80`:

```
SPLIT_DEFAULTS = {
  male:        { male: 30, female: 50, transgender: 40 },
  female:      { male: 40, female: 30, transgender: 40 },
  transgender: { male: 40, female: 40, transgender: 40 },
}
```

**Outer key = PAYER gender. Inner key = EARNER gender.** Stated at `pricing.ts:38`: *"The earner's share, by PAYER gender and EARNER gender."* The ASCII table at `pricing.ts:48`–`:52` has `payer` down the rows, `earner` across the columns. Values are the **earner's percentage**.

Read as a grid:

| payer ↓ / earner → | male | female | transgender |
|---|---|---|---|
| **male** | 30% | **50%** | 40% |
| **female** | **40%** | 30% | 40% |
| **transgender** | 40% | 40% | 40% |

- Three genders only: `male`, `female`, `transgender` (`pricing.ts:28`). **Anything unrecognised — blank, missing, "other", a guest who never finished setup — resolves to `transgender`** (`genderOf`, `pricing.ts:30`–`:35`), which is the all-40% row and column.
- Override lives at `appConfig/economy.callSplitMatrix`, same `{payer:{earner:pct}}` shape (`earnerPct`, `pricing.ts:90`).
- A cell is accepted only if it is a finite number in **1–100 inclusive**, then truncated (`pricing.ts:94`). Anything else — missing, `0`, `101`, a string — falls back to the default cell, **not** to zero.
- The CRM edits it as a 3×3 grid at `zipper-crm/app/economy/config/page.tsx:165`–`:167`, `:518`.
- Only Tech and superadmin may write `appConfig/economy` (`firestore.rules:2562`).

**Which gender indexes which axis is decided by who pays, never by who dialled.** The file's own two examples (`pricing.ts:56`–`:60`): a female host calling a male user → payer male, earner female → **50%**. A male host calling a female user → payer female, earner male → **40%**. Same direction of dial, different percentage.

## 1.5 Who pays, and the price

`rateFor` (`pricing.ts:125`) resolves three cases:

**Exactly one host** (`:155`–`:163`): **the user pays and the host earns, whichever dialled.** `perMin = ceil(earnerIncome × 100 / pct)`.
**Two hosts** (`:166`–`:175`): caller pays, receiver earns, price from the receiver's rate.
**Two users** (`:178`–`:180`): caller pays, receiver earns, `perMin = userCallRatePerMin` (1,600) flat.

`earnerIncome` (`incomeFor`, `pricing.ts:151`): the host's own `callRateBeans` **only if `isVerifiedHost === true`**; otherwise the platform default `callRateBeansPerMin`, 375 beans/min. An unverified host earns at base rate whatever their level — the same rule `setCallRate` (`hosts.ts:408`) and `getHostHome` (`hostStats.ts:253`) enforce.

The call document stores `earner: 'caller' | 'receiver'` (`calls.ts:193`) and **not** the payer — both `tickCall` (`:370`) and `settleAndClose` (`:468`) derive the payer as "the other one". Android mirrors it as a computed property (`ActiveCall.kt:22`).

## 1.6 Worked example

**Verified level-0 female host (`callRateBeans = 700`) ↔ male user. The user pays.**

| step | arithmetic | result |
|---|---|---|
| split cell | payer `male` × earner `female` | **50%** |
| price/min | `ceil(700 × 100 / 50)` | **1,400 diamonds/min** |
| per tick | `ceil(1400 × 10 / 60)` = `ceil(233.33)` | **234 diamonds** |
| beans/tick | `floor(234 × 50 / 100)` | **117 beans** |
| one minute (6 ticks) | 6 × 234 / 6 × 117 | **1,404 diamonds out, 702 beans in** |
| platform keeps | 1,404 − 702 | **702** |

The per-tick ceiling makes the payer pay 1,404 rather than the nominal 1,400 — **+0.29% over the quoted rate**, every minute.

**Unverified host (base 375) ↔ male user, 50% cell:** `perMin = ceil(375×100/50) = 750`; `perTick = ceil(125) = 125`; `beans = floor(62.5) = 62`. One minute = **750 diamonds out, 372 beans in** — the per-tick floor costs the host **3 beans a minute (0.8%)** versus the nominal 375.

**Male user pays a male host at base rate:** `perMin = ceil(375×100/30) = 1,250` — the number hard-coded in the error message at `calls.ts:167`. `perTick = ceil(208.33) = 209`; `beans = floor(62.7) = 62`. One minute = **1,254 out, 372 in, platform keeps 882 (70%)**.

**User↔user, male caller pays female receiver:** `perMin = 1,600` flat; `perTick = ceil(266.67) = 267`; `beans = 133`. One minute = **1,602 out, 798 in, platform keeps 804**.

## 1.7 Host level's effect on the rate

Level never prices a call directly. It sets a **ceiling on what the host may ask**.

`FALLBACK_LADDER` (`hostStats.ts:51`–`:63`), used only when `levelConfig/host/levels` is empty:

| level | beans required | max callRateBeans |
|---|---|---|
| 0 | 0 | 700 |
| 1 | 10,000 | 850 |
| 2 | 100,000 | 1,000 |
| 3 | 300,000 | 1,150 |
| 4 | 600,000 | 1,350 |
| 5 | 1,000,000 | 1,550 |
| 6 | 2,000,000 | 1,750 |
| 7 | 4,000,000 | 1,950 |
| 8 | 8,000,000 | 2,150 |
| 9 | 16,000,000 | 2,300 |
| 10 | 32,000,000 | 2,400 |

- Level = highest rung whose `beansRequired` is met by `hostCallEarnings + hostGiftEarnings` (`hostLevelFor`, `hostStats.ts:108`; lifetime at `:223`).
- Ladder cached **10 minutes** (`LADDER_TTL_MS`, `hostStats.ts:66`). A failed read keeps the previous cache rather than demoting everyone (`:98`–`:101`).
- `setCallRate` (`hosts.ts:382`) clamps: `callRateBeans = min(max(requested, min), max)` (`:429`), floor `cfg.minHostCallRate ?? 100`, ceiling the rung's `maxCallRateBeans`. It **clamps rather than refuses**, and returns `clamped: true`.
- Unverified hosts cannot set a rate at all (`hosts.ts:408`), and `getHostHome` reports their ceiling as `0` (`hostStats.ts:253`).
- Level is written only when it changes (`applyHostLevel`, `hostStats.ts:184`) — because `hostLevel` is in the `publicProfiles` watch list.
- Level is applied **at `endCall`, not per tick** (`calls.ts:512`), and only if `isHost === true` (`:505`). The deliberate reason is at `calls.ts:400`–`:406`: a level check per tick would be a document read per tick per call. `sweepHostLevels` at 02:00 IST is the backstop (`hostStats.ts:280`–`:283`), paging 400 hosts at a time.

Code-level discrepancy: `setCallRate`'s floor fallback is `100` (`hosts.ts:416`) while the CRM's own default `minHostCallRate` is `350` (`economyConfig.ts:286`).

## 1.8 `sweepStaleCalls`

`calls.ts:656`. Cron **`* * * * *` — every minute**, Asia/Kolkata (`:658`–`:659`). Two independent queries against different fields:

**(a) Connected calls whose client went silent.** `status in ['connected','ending']` AND `lastTickAt < now − 2 minutes` (`:664`–`:669`), limit **50**. Each goes through the same `settleAndClose` a tap uses, `endReason: 'watchdog_timeout'` (`:674`). 2 minutes = 12 missed ticks (`:634`).

**(b) Calls nobody answered.** `status == 'ringing'` AND `createdAt < now − 45 seconds` (`RING_TIMEOUT_SECONDS = 45`, `:621`; query `:687`–`:694`), limit **100**. Inside a transaction that re-checks `status === 'ringing'` (`:705`) so a simultaneous Accept wins cleanly. Sets `status: 'missed'`, `endReason: 'no_answer'`, writes a zero-money `callHistory` row (`:716`). **No money moves.**

Why (b) exists, from the file: without it an abandoned `ringing` document re-rings days later via `receiverId == me && status == 'ringing'`, gets answered, and the watchdog then bills the vanished caller ~12 ticks for a conversation neither had (`:640`–`:650`).

## 1.9 What is written where

| document | writer | fields of note |
|---|---|---|
| `calls/{id}` | startCall → endCall | `status`, `startedAt`, `lastTickAt`, `perMinRateDiamonds`, `receiverPct`, `earner`, `tickIndex`, `diamondsCharged`, `beansCredited` |
| `callIdempotency/{callerUid}_{key}` | startCall `:201` | the original `{callId, perMinRateDiamonds, receiverPct}` |
| `users/{payer}.diamonds` | tick `:390`, settle `:494` | decrement |
| `users/{earner}` | tick `:391`, settle `:495` | `beans`, `totalBeansEarned`, `hostCallEarnings` |
| `users/{earner}/weeklyEarnings/{ISTweek}` | `accrueWeeklyEarning` (`payouts.ts:51`) | `beans`, `callBeans`, `released:false` |
| `users/{earner}/dailyStats/{IST date}` | `accrueHostStats` (`hostStats.ts:166`) | `beans`, `callBeans`, `callSeconds`, `calls` |
| `users/{payer}/diamondTransactions` | settle `:536` | `reason:'video_call'`, `balanceAfter`, `callId`, `ratePerMin` |
| `users/{earner}/beanTransactions` | settle `:550` | `reason:'video_call'`, `receiverPct` |
| `platformRevenue` | settle `:569` | `type:'call'`, `grossDiamonds`, `payoutBeans`, `platformCut` |
| `callHistory/{callId}` | settle `:591`, decline `:307`, sweep `:716` | duplicated `callerUid`/`receiverUid`/`beansEarned`/`timestamp` for the app's indexes (`:582`–`:590`) |

`calls/{id}` is read-only to both parties and write-only to admin (`firestore.rules:2481`–`:2485`). In-call chat under `calls/{id}/messages` is writable by either party with a matching `senderUid` (`:2496`). `callHistory` write is `isAdmin()` only (`firestore.rules:1945`).

`platformRevenue.platformCut = grossDiamonds − payoutBeans` (`calls.ts:576`) **subtracts beans from diamonds**. `beanToDiamondRate` defaults to 20 (`zipper-crm/lib/rates.ts:71`), so the two are not the same unit. The same mixing appears in gifting (`gifts.ts:479`). **Business purpose unclear** — nothing states whether these cut figures are meant as a diamond amount or a notional ratio.

## 1.10 Call failure paths

| failure | behaviour |
|---|---|
| **Payer broke mid-call** | `affordableTicks = min(outstanding, floor(balance / perTick))` (`:379`). Partial ticks are charged, `endNow = true` (`:380`), status → `ending`, `endReason: 'diamonds_exhausted'` (`:417`). If even one tick is unaffordable: nothing charged, status → `ending` (`:382`–`:385`). Android sees `endNow` and calls `endCall('diamonds_exhausted')` (`VideoCallViewModel.kt:251`). |
| **Payer broke at `startCall`** | Refused before the phone rings (`:163`). The message differs by side (`:166`–`:169`) — the host is told *their caller* has no diamonds, not that they themselves are broke. |
| **Host (earner) disconnects** | The earner is not the ticker. The payer's device keeps ticking and keeps being charged for a call with nobody on the other end, until the payer hangs up or the Agora layer makes the UI act. **No server-side check that the earner is still present.** |
| **Payer disconnects** | Ticks stop. 2 minutes past `lastTickAt`, the watchdog settles at full rate including the silent gap (`:664`). |
| **Both disconnect** | Same path — `settleAndClose(id, null, 'watchdog_timeout')` with `byUid = null`, which skips the party check (`:458`). |
| **Server dies after the charge** | Each tick is one Firestore transaction. Either all of it commits (balances + `tickIndex` + ledger) or none. A dropped *response* with a committed transaction is covered by `tickIndex`. |
| **Duplicate tick** | `outstanding <= 0` → `charged: 0` and the existing `tickIndex` returned (`:362`). |
| **Duplicate `startCall`** | `callIdempotency` claim returns the original call (`:120`). |
| **Double-tap Accept** | Returns `alreadyConnected: true` without resetting `startedAt` (`:243`). |
| **Double hang-up** | `settleAndClose` short-circuits on `status === 'ended'` (`:461`). `CallRepository.endCall` retries 3× over ~3.6s on transient codes (`CallRepository.kt:105`–`:118`). |
| **Hang-up request fails entirely** | Ticks deliberately keep running until the server agrees (`VideoCallViewModel.kt:263`–`:276`), then the user is told. |

**Contradiction — caller's ring timeout is filed as a decline.** `CallRepository.markMissed` calls `declineCall(callId, "missed")` (`CallRepository.kt:130`), and only the *caller* ever invokes it (`VideoCallViewModel.kt:123` returns early if `!isOutgoing`). But `declineCall` only honours `reason:'missed'` when the actor is the receiver: `call.receiverId === uid ? (reason === 'missed' ? 'missed' : …) : 'caller_cancelled'` (`calls.ts:285`–`:288`). So a call the caller gave up on lands in history as **`declined` / `caller_cancelled`**, while the caller's own screen shows "MISSED" (`VideoCallViewModel.kt:132`). The two sides disagree about what happened.

---

# 2. LIVE

## 2.1 Eligibility to go live

**Server (the only real gate) — `firestore.rules:2060`–`:2065`:**
```
mayGoLive() = isAppUser() && isHost == true && isVerifiedHost == true && isBanned != true
```
It costs one `get()` on the caller's user document per attempt, justified at `:2054` because opening a room is once per stream.

**Client pre-checks**, purely for the error copy (`GoLiveViewModel.kt:213`, `:222`) — the rules comment at `:2046`–`:2052` says a bare `PERMISSION_DENIED` tells an unverified person nothing.

- **No level gate.** Nothing anywhere checks `hostLevel` or `level` before going live.
- **Face detection is not an entry gate.** `FaceDetectionManager.init()` runs *after* the checks (`GoLiveViewModel.kt:232`). It is a **continuity** gate: when the face disappears, a **120-second** countdown starts and `endLive()` fires at zero (`GoLiveViewModel.kt:390`–`:416`). The countdown cancels if the face returns. All client-side, on the host's own device — nothing server-side enforces it.
- Separately, `generateAgoraToken` refuses a banned account a token for **any** channel kind (`index.ts:2182`–`:2189`).

Opening a party room is deliberately the opposite rule — any signed-in account (`party.ts:311`–`:324`).

## 2.2 What a `liveRooms` document holds

Written at `LiveRepository.kt:128`–`:143`: `hostUid`, `hostName`, `hostPhotoUrl`, `hostGender`, `agencyId`, `title`, `category`, `viewerCount: 0`, `isActive: true`, `startedAt`, `totalGiftsReceived: 0`, `totalBeansEarned: 0`. `endedAt` is deliberately **absent** until the end (`:138`) — a `Long 0` then a `Timestamp` later would be two types under one name.

Added later by other writers: `likeCount`, `kickedViewers[]`, `welcomeMessage`, `durationSeconds`, the nine `pk*` fields, and `hostMuted`/`hostMutedAt`/`hostMutedBy`/`hostMuteReason`/`endedBy`/`endedByStaff`/`endReason` from the CRM. Full read model at `zipper-app/.../data/model/LiveRoom.kt:6`–`:35`.

`LiveRoom.from` is a hand parse, not `toObject()`, because `endedAt` is written as **millis by the app and a Python datetime by the CRM** — `toObject` threw and the host's own listener crashed exactly when an operator cut the stream (`LiveRoom.kt:38`–`:46`).

**Viewer / listener tracking — two parallel mechanisms that are not tied together:**

1. **`viewerCount`** — a bare counter. `joinRoom` increments, `leaveRoom` decrements (`LiveRepository.kt:165`–`:175`). Any signed-in user may write it (`firestore.rules:2087`).
2. **`liveRooms/{id}/viewers/{uid}`** — a presence document with `uid`, `name`, `photoUrl`, `level`, `joinedAt` (`LiveRepository.kt:267`). Create/update require `isActiveAppUser() && request.auth.uid == uid && notKickedFromLive()` (`firestore.rules:2119`); delete is the viewer or the host (`:2122`).

Nothing reconciles them. `kickViewer` reads the presence row first and decrements **only if it still exists** (`LiveRepository.kt:359`–`:379`) — the reason is at `:347`: an unconditional decrement double-counted a viewer who had already left, which is precisely when a host reaches for the kick, and enough of those drive the count negative.

**`likeCount`** — `addLike` increments it, unbounded and unrecorded, with the failure deliberately swallowed (`LiveRepository.kt:334`, rationale at `WatchLiveViewModel.kt:382`–`:391`). No per-user cap, no like document, no rate limit.

## 2.3 Comments, likes, follows during a stream

| action | path | who may write |
|---|---|---|
| Comment | `liveRooms/{id}/comments` — `uid`, `name`, `photoUrl`, `message`, `timestamp` (millis), `isJoin:false` (`LiveRepository.kt:182`) | `isActiveAppUser() && notKickedFromLive()` (`firestore.rules:2107`). Not restricted to present viewers, and `uid` is **not** checked against `request.auth.uid`. |
| "X joined" row | same collection, `isJoin:true` (`LiveRepository.kt:193`) | same |
| Like | `likeCount` increment | any signed-in user (`:2087`) |
| Follow | `users/{host}/followers/{me}` + `users/{me}/following/{host}` in one batch (`ProfileRepository.kt:477`–`:491`) | owner-scoped rules at `firestore.rules:1341`, `:1345` |
| Report | `reports` with reporter/target uid **and names** (`LiveRepository.kt:418`) | `reporterUid == request.auth.uid` (`:2322`) |
| Gift | `settleGift` only | server |

The `isJoin` field needed a `@get:PropertyName` pin — Firestore's POJO mapper strips the bean prefix and looked for `join`, so the "X joined" row was dead code until that annotation (`LiveRoom.kt:112`–`:119`).

Moderation reach was the known hole, now closed: `notKickedFromLive()` (`firestore.rules:2099`) was added because *"the comment stream and the presence row were `request.auth != null`"* (`:2094`) — a kicked viewer lost the video but kept typing and re-adding themselves.

## 2.4 PK battles — and who writes the score

**Entirely client-side.** `zipper-app/.../data/repository/PKRepository.kt`. There is no PK code in `functions/` at all; the only server involvement is `generateAgoraToken` recognising the shared channel (`index.ts:2305`–`:2327`).

- **Queue:** `enterPKQueue` (`PKRepository.kt:40`) queries up to 10 rooms with `pkWaiting == true && isActive == true && pkActive == false`, picks the first that is not mine, and tries to claim it in a client transaction. No match → sets my own `pkWaiting = true` and waits (`:93`).
- **Invite:** one `pkInvites` document both hosts see via `array-contains` on `participants` (`:67`–`:83`). Statuses `pending | started | rejected | expired` (`LiveRoom.kt:101`). **`expired` is never written by anything** — invites have no timeout.
- **Duration: exactly 3 minutes.** `const PK_DURATION_MS = 3 * 60 * 1000L` (`PKRepository.kt:17`). `pkEndTime = now + 3min`, written to both rooms on the second acceptance (`:141`, `:151`).
- **Scoring:** `pkScore` on the gifted room and `pkPartnerScore` on the other, incremented by **gift QUANTITY, not diamond value** — `pkRepo.addPKScore(targetRoomId, partnerRoomId, qty.toLong())` (`WatchLiveViewModel.kt:369`; increment at `PKRepository.kt:217`–`:220`). One 5,000-diamond Super Star scores **1**; ten 1-diamond Roses score **10**.
- **WHO WRITES THE SCORE: the gifting VIEWER'S DEVICE**, in a client batch, in a second call after `settleGift` has already returned. Nothing on the server writes, validates or even sees a PK score.

**This path is broken by the rules.** `liveRooms` update permits only two things to a non-host: `isLiveHost() || (isAppUser() && liveChanged().hasOnly(['viewerCount','likeCount']))` (`firestore.rules:2086`–`:2087`). Every PK write fails against it:
- A **viewer** writing `pkScore` is neither the host nor writing one of the two permitted fields → denied. **PK scores can never be recorded.**
- `enterPKQueue` writes `pkWaiting` on the **candidate's** room (`PKRepository.kt:63`) → denied; the whole transaction aborts and the code falls into the catch, re-queueing itself (`:86`–`:90`).
- `acceptInvite` batch-updates **both** rooms (`:154`, `:163`) → denied; a batch is all-or-nothing, so **PK never starts.**
- `endPK` batch-updates both rooms (`:202`–`:205`) → denied.

The feature has a full UI (`PKBattleOverlay.kt`, `PKInviteDialog.kt`, `GoLiveScreen.kt:201`), a queue, a timer and a score model, and the security rules forbid every cross-room write it depends on. **PK is half-built.** The rules' own comment names the class of write it was closing: *"A viewer could rewrite `hostUid`, flip `isActive` to kill somebody's stream"* (`firestore.rules:2079`) — PK was collateral.

Also note `GiftRepository.sendGift` hard-codes `context = if (roomId.isNullOrBlank()) "dm" else "live"` (`:108`), so a PK gift is always settled as `live`.

## 2.5 Staff moderation mid-stream

`backend/app/services/live.py`. Roles: **`OWNER`, `OPS_ADMIN`, `OPS_MEMBER` only** (`INTERVENTION_ROLES`, `live.py:88`–`:90`) — deliberately narrower than who may warn or ban. Every action demands a reason of **≥ 6 characters** (`MIN_REASON = 6`, `:62`; `_require_reason`, `:114`).

**`end_room`** (`live.py:174`): writes `isActive: False`, `endedAt`, `endedBy`, `endedByStaff: True`, `endReason`. Refuses a room that is already ended rather than succeeding silently (`:195`). Audit entry `live.room_ended` written **after** the change, never before (`:228`). The service states plainly that this is a flag, not a cut stream — the file's own words: *"That is a flag, not a network operation"* (`live.py:22`). The Android host app does react, since `roomFlow` watches `isActive`.

**`mute_host`** (`live.py:286`): writes `hostMuted`, `hostMutedAt`, `hostMutedBy`, `hostMuteReason`; audits `live.host_muted` / `live.host_unmuted`; refuses a no-op (`:304`). **This is dead on the app side — `hostMuted` appears in zero Kotlin files.** The service says so itself and returns the sentence verbatim to the CRM: *"Until the app honours it, the host is still audible"* (`live.py:336`). Likewise `endedByStaff` and the staff `endReason` are never read by the Android app.

`generateAgoraToken` also refuses a token when `isActive === false`, host included (`index.ts:2213`), and refuses anyone in `kickedViewers` (`:2204`).

## 2.6 Ending a stream, cleanup, host disconnect

**Host-initiated:** `GoLiveViewModel.endLive()` (`:458`). Cancels the duration and face jobs, flips local state, cancels any in-flight PK channel join (the reason at `:464`–`:469`: a token landing after the leave would reopen the channel and camera for a finished broadcast), leaves Agora, releases face detection, then on a **teardown scope that outlives the ViewModel** (`:485`) ends PK/queue and calls `repo.endLive(roomId, durationSeconds)`.

`LiveRepository.endLive` (`:151`) writes exactly three fields: `isActive: false`, `endedAt`, `durationSeconds`. **Nothing deletes `comments`, `gifts` or `viewers`; `viewerCount` and `likeCount` are not zeroed.** Contrast party rooms, where `closeRoom` deletes seats and clears presence (`party.ts:1384`).

`syncLivePresence` (`profiles.ts:226`) is the server-side consequence, firing on any `liveRooms` write:
- `publicProfiles/{host}`: `isLive`, `liveRoomId`, `presenceRank` (`:245`–`:253`).
- `users/{host}`: `isLive`, `liveRoomId`, and on close `streamedTimeSeconds += floor(durationSeconds)` (`:258`–`:267`) — **taken from the number the host's own app wrote**.
- Short-circuits when `isActive` did not change (`:239`).

Why it exists, from `profiles.ts:217`–`:220`: if the feed ranked on the self-declared `users.isLive`, *"setting it would be a permanent top-of-feed slot"*.

**`LiveSummaryScreen`** (`zipper-app/.../live/LiveSummaryScreen.kt`). Built from `LiveSessionSummary` (`:28`): `durationSeconds`, `totalBeans`, `peakViewers`, `gifterCount`, `topGifters`.
- `totalBeans` is read off the room's `totalBeansEarned` (`GoLiveViewModel.kt:334`), which `settleGift` maintains (`gifts.ts:447`). Beans, never diamonds — *"they differ 20x"* (`LiveSummaryScreen.kt:31`).
- `peakViewers` is the **maximum concurrent**, from `max(peak, viewers.size)` on the presence flow (`GoLiveViewModel.kt:377`), not a session total. The card names it a peak for that reason.
- `gifterCount` is **distinct gifters**, carried separately from `topGifters` because the list stops at 20 (`RoomGifters`, `LiveRepository.kt:29`–`:32`; leaderboard `take(20)` at `:307`).
- The rows travel through a `@Volatile object LiveSummaryGifters` rather than a nav argument, because a `GiftLeaderboardEntry` is not Bundle-able (`:44`–`:57`). Before that, the card was handed an empty list and *"told every host they had 0 gifters"* (`:53`). Worst case now is a missing card, never a wrong number — nothing numeric is derived from it.

**Host disconnect / crash:** nothing server-side closes a live room. `isActive` stays `true` indefinitely. The only cleanup is **the host's own next `startLive`**, which best-effort closes their stale rooms before creating a new one (`LiveRepository.kt:115`–`:126`) — and that is wrapped in a bare catch because *"a rules error here must never stop someone from going live"* (`:114`). **There is no `sweepStaleLiveRooms`** — the party and call equivalents exist (`party.ts:1445`, `calls.ts:656`), the live one does not. A crashed host leaves a ghost room in the browse list (`liveRoomsFlow` filters on `isActive == true`, `LiveRepository.kt:47`) and a permanently `isLive: true` profile at the top of the feed, until that host next goes live.

---

# 3. PARTY

## 3.1 Count check

`functions/src/party.ts` exports **15 callables plus 1 scheduled sweep** (16 functions), not 17. Named at `party.ts:325, 437, 592, 688, 773, 902, 939, 957, 1008, 1050, 1117, 1191, 1257, 1296, 1349` and `:1445`; all re-exported at `index.ts:4233`–`:4241`. The file also exports 7 constants (`:48`–`:67`), which brings the `export const` count to 23.

| # | callable | role required |
|---|---|---|
| 1 | `createPartyRoom` | any un-banned user |
| 2 | `updatePartyRoom` | owner |
| 3 | `joinPartyRoom` | any un-banned, not kicked, + password |
| 4 | `leavePartyRoom` | self |
| 5 | `takePartySeat` | any (free mode); owner/admin in consent mode |
| 6 | `requestPartySeat` | any |
| 7 | `cancelPartySeatRequest` | self |
| 8 | `decidePartySeatRequest` | owner or admin |
| 9 | `invitePartySeat` | owner or admin |
| 10 | `respondPartySeatInvite` | the invitee |
| 11 | `leavePartySeat` | self, or owner/admin on another |
| 12 | `setPartySeatMute` | owner or admin |
| 13 | `setPartySeatLock` | owner or admin |
| 14 | `setPartyAdmin` | owner only |
| 15 | `endPartyRoom` | owner, or anyone once provably empty |
| — | `sweepEmptyPartyRooms` | cron |

## 3.2 Room creation options

`createPartyRoom` (`party.ts:325`). **Any signed-in, un-banned account may open one, audio or video** — deliberately different from going live, argued at `:309`–`:324`: a live room is one person broadcasting and earning, so it carries verification, an agency link and a payout trail; a party room is a room people talk in, and *"gifts go to whichever seat the sender picks rather than to the room owner"* (`:321`). A ban still stops you, because that is conduct rather than status (`requireUser`, `:247`).

- **Modes:** `audio` | `video` (`:48`–`:49`). Anything else coerces to `audio` (`modeOf`, `:75`).
- **Seat counts, enumerated:** audio **[10, 15]**, video **[6, 10]**; first entry is the default (`SEAT_CHOICES`, `:58`–`:61`). `seatsFor` snaps an unrecognised request to the default rather than erroring (`:80`–`:84`).
- **Why enumerated:** stated at `:33`–`:40` — a seat count is *a device budget*, not a preference. An audio seat is one Opus stream; a video seat is a decoded video stream, and the number a budget SoC can composite before dropping frames is small. The failure of getting it wrong is *"a room that takes the phone down"* (`:40`). The ceilings are enforced server-side so neither the client nor the CRM can exceed them. The Android model restates the same two lists (`PartyRoom.kt:102`, `:109`).
- **Seat modes:** `free` | `consent` (`:63`–`:64`). In `consent`, `takePartySeat` refuses a member with `failed-precondition` and the message *"Ask the host for a seat in this room"* (`:794`–`:797`) — a named reason so a stale client cannot quietly seat someone the owner meant to vet.
- **Visibility:** `public` | `private` (`:66`–`:67`). Private requires a **4-digit** password (`validPassword`, `:194`), stored as `sha256(salt + ':' + password)` with a 16-byte random salt (`hashPassword`, `:190`). The hash is not what makes it safe — ten thousand combinations is nothing — it is that `partyRooms` is readable by any signed-in user, so a plaintext field *"would have made every private room public"* (`:187`).
- **Title:** trimmed to 60 chars, defaulting to `"<FirstName>'s room"` using only the first word, because a 4-word display name truncates unreadably in the list (`:372`–`:385`).
- **Welcome message:** default `"welcome to my room have fun"`, max 250 chars (`:69`–`:70`). Validation (`cleanWelcome`, `:147`): **digits are refused outright** — not for tidiness, but because the message is the most valuable advertising space in the room and left free *"it fills with WhatsApp numbers and Telegram handles"* (`:99`), moving people somewhere with no moderation or reporting. Unicode Arabic/Persian/Devanagari digits are covered too (`DIGITS`, `:106`). Plus a blocked-word list: 8 built-ins (`:116`) extended by `appConfig/moderation.blockedWords`, cached 10 minutes, falling back to the built-ins on a read failure so a config outage cannot stop a room opening (`:120`–`:136`). Words of ≤2 chars are ignored (`:167`). Empty is defaulted at create but **refused when editing** (`:148`–`:152`) — the client disables Save on empty, and silently substituting the default would hide that disagreement.
- Stale rooms by the same host are closed first (`:360`–`:369`).
- `emptySince` starts **`null`, not `now`** (`:416`), explained at `:406`–`:415`: every seat starts empty including the owner's, so `now` would qualify the room for auto-close two seconds after creation.

`updatePartyRoom` (`:437`) is **owner only** — an admin moderates, they do not rename or reshape (`:435`). Notable behaviours: shrinking the room **vacates every seat above the new limit** (`:549`–`:565`), because a stranded occupant keeps publishing (the token reads the seat document, not the count) while no client draws a tile for them — *"audible, invisible, and unable to leave"* (`:493`). Turning consent **off deletes the whole pending queue** (`:507`–`:510`). Going private with no existing and no new password is refused: *"a lock with no key"* (`:519`). Going public **erases** salt and hash (`:533`–`:534`).

## 3.3 Seat lifecycle

Seats are **1-based**, every one an ordinary seat — **the owner's included**. The rebuild note at `party.ts:1`–`:17` is explicit about why: modelling the owner as an implicit seat 0 meant their mute state lived only in their own phone's memory, they had no `agoraUid` so other clients found their video *"BY ELIMINATION"*, and they could not stand up because there was no seat to leave.

| action | callable | checks |
|---|---|---|
| **Take** | `takePartySeat` (`:773`) | live room, not kicked, consent-mode refusal, then `seatInTransaction` |
| **Request** | `requestPartySeat` (`:902`) | live, not kicked, index in `1..seatCount`, not in `lockedSeats`. Writes `seatRequests/{uid}` naming the seat (reasoning at `:895`–`:900`: "let me in somewhere" gives the owner nothing to approve) |
| **Withdraw** | `cancelPartySeatRequest` (`:939`) | deletes own request, no other check |
| **Grant** | `decidePartySeatRequest` (`:957`) | owner/admin. **Approval seats them there and then**, not a permission to redeem later — *"A grant the asker still has to act on is a grant that goes stale"* (`:953`) |
| **Invite** | `invitePartySeat` (`:1008`) | owner/admin, target not kicked, index in range, not self (`"Just take the seat"`, `:1022`). Writes `seatInvites/{targetUid}` — an **offer**, because seating a stranger directly puts a live microphone in a room they may have opened by accident (`:1003`–`:1006`) |
| **Accept** | `respondPartySeatInvite` (`:1050`) | if the invited seat filled while the popup was open, **falls through to the lowest free unlocked seat** (`:1081`–`:1097`) rather than failing — which chair was the inviter's detail, not the invitee's |
| **Mute** | `setPartySeatMute` (`:1191`) | see hierarchy below |
| **Lock** | `setPartySeatLock` (`:1257`) | owner/admin; `arrayUnion`/`arrayRemove` on `lockedSeats` (`:1279`–`:1281`) |
| **Leave / remove / kick** | `leavePartySeat` (`:1117`) | three actions one door (`:1108`–`:1114`) |

`seatInTransaction` (`:813`) is the shared body for all three ways onto a seat, because when each path had its own copy *"only the direct path checked `lockedSeats`"* (`:810`) — an invitation could seat someone on a seat the owner had deliberately locked. It enforces: range `1..seatCount` → `out-of-range` (`:823`); lock → `permission-denied` (`:827`); target occupied by someone else → `already-exists` (`:841`); target occupied by **you** → `alreadySeated: true` (`:840`); **one seat per person** — any other seat you hold is deleted (`:845`–`:850`).

A new seat document (`:852`–`:874`): `uid`, `name`, `photoUrl`, `agoraUid: seatIndex`, `isMuted: false`, `mutedBy: ''`, `mutedByRole: ''`, `selfMuted: false`, `cameraOff: (mode === video)`, `joinedAt`, `beansReceived: 0`. A video seat starts camera **off** — *"Opening someone's camera the instant they sit down is not a decision to make on their behalf"* (`:869`).

Room side-effects: `occupantCount += (1 − seatsVacated)` (`:878`), `emptySince: null` (`:880`), presence `{isInParty: true, partyRoomId}` on the user (`:884`), and both the request and invite documents deleted (`:887`–`:888`).

**Mute hierarchy** (`:1170`–`:1176`): the owner may mute anybody and **only the owner may lift an owner's mute**; an admin may mute a member but not the owner or another admin, and that mute lifts for the owner or the admin who placed it; `selfMuted` is a separate field only its occupant may clear. Enforced at `:1216`, `:1231`, `:1237`. Why it cannot be a rule, from `:1178`–`:1186`: *"may you unmute this?" depends on WHO MUTED IT* — a rule can compare a field to `request.auth.uid` but cannot express "the admin who set this, or the owner, but not a different admin".

**Kick vs leave** (`:1131`–`:1151`): removing yourself is **never** a kick — *"a tap on 'leave my seat' would bar you from the room you meant to stay in"* (`:1148`). An admin cannot touch another admin or the owner, or *"the admin tier is a self-destruct button"* (`:1135`). A kick adds to `kickedUsers`, deletes any pending request and invite, and clears the target's presence (`vacateAndDrop`, `:737`–`:743`; presence `:1159`).

`vacateAndDrop` (`:709`) is the single body for every "no longer on a seat" path, because when each caller did its own deletes *"`listenerCount` drifted and the auto-close clock was only ever set by one of the three paths"* (`:705`). It computes `roomEmpty` from the seats read **before** the deletes (`:751`) and stamps `emptySince` when it hits zero.

## 3.4 Why seats are callables, and the Agora link

Stated at `party.ts:18`–`:31`. A seat is two things at once, neither assertable by a client:

**Contention** — one document per seat inside a transaction. Two people tapping the same empty seat resolve as one winner and one `already-exists`, *"where an array field would have produced two writes that each believed they had won"* (`:27`).

**A publisher slot.** `generateAgoraToken` (`index.ts:2134`) reads the seat documents and issues **PUBLISHER only to someone currently sitting on one** — the owner included (`:2279`–`:2286`). Without it, *"'leave the seat' would be a UI state a patched client could ignore"* (`:29`). Specifics:
- Channel naming: `party_<roomId>`, so the branch is reachable without a speculative read on every token request (`index.ts:2217`–`:2219`).
- **The server decides the Agora uid**, overwriting whatever the client sent: `uid = seat.agoraUid ?? seat.id` (`:2291`). The client used to send it and the function signed whatever arrived — *"a client that asked for a token on somebody else's seat index would appear in their tile"* (`:2149`).
- Not seated → `SUBSCRIBER` (`:2286`).
- Room missing → `not-found`; `isActive: false` → `failed-precondition`; in `kickedUsers` → `permission-denied` (`:2228`–`:2240`).
- **Private rooms additionally require a listener row** (`:2250`–`:2261`) — `joinPartyRoom` writes that row only after checking the password, so without this *"skip the join call, ask for a token directly, and you are in the channel"* (`:2248`).
- Token privilege: **3600 seconds** (`:2332`). Returns `{token, appId, expiresAt}`; `appId` is not a secret — every APK carries it in BuildConfig (`:2351`).

`firestore.rules` matches: `seats` `create, delete: if false` (`:2210`); `update` only `hasOnly(['selfMuted','cameraOff'])` on your own seat, or `isOps()` (`:2220`–`:2233`). The whole room document is `create, update, delete: if isOps()` (`:2203`), replacing a rule the file describes as *"`allow update: if isRoomHost()` with NO FIELD RESTRICTION"* (`:2140`) — which had let the owner's client rewrite `seatCount`, `kickedUsers`, `admins`, `passwordHash` and `totalBeansEarned`, the figure the room's own leaderboard is drawn from.

`listeners` are `create, update: if isOps()`, but **`delete` stays open to the person themselves** — *"being unable to LEAVE a room is the one failure here with no recovery"* (`:2249`). Posting to `messages` requires `inRoom()`, an `exists()` on your own listener row, which is what makes a private room's chat actually private (`:2260`–`:2273`).

## 3.5 Gifts in a party, and where the earning lands

**The recipient is a seat holder the sender picked — never the room owner.** `PartyRepository.sendGiftToSeat` (`:400`) passes `context: "party"` and the chosen `receiverUid`; the reason is at `:393`–`:396`: in a party the owner is often not the person being listened to, and *"paying the room owner for someone else's performance is the wrong money movement"*. `giftableSeatHolders` is every seat except mine (`PartyRoomViewModel.kt:132`).

Inside `settleGift`, `context === 'party'` changes two things:
1. **The room collection:** `giftContext === 'party' ? 'partyRooms' : 'liveRooms'` (`gifts.ts:137`). This line is the fix for a long-running defect documented at `:118`–`:136`: it was hard-coded to `liveRooms` for every context, so `liveRooms/{partyRoomId}` never existed, `roomSnap.exists` was false, and the entire mirror block was skipped. The money moved and **the room showed nothing at all** — no animation (the overlay reads the subcollection), no per-seat leaderboard, no room total. The rules concede the same: *"so nothing landed here at all and every party gift appeared to vanish"* (`firestore.rules:2310`).
2. **A seat lookup by uid** (`:158`–`:160`), resolved before the transaction writes, so the seat's `beansReceived` can be incremented (`:462`–`:466`). That field *"has existed on the model since the room was first built and no code has ever incremented it"* (`:453`) — `gifts.ts:463` is its first writer. Skipped without complaint if the recipient stood up between tap and commit.

Earning destinations are identical to any other gift: `users/{receiver}.beans`, `totalBeansEarned`, `hostGiftEarnings`, `totalGiftsReceived` (`:262`–`:267`), plus `weeklyEarnings` and — **only if `isHost === true`** — `dailyStats` and the level ladder (`:276`–`:291`). **A non-host seat holder earns beans but gets no daily stats and no level progression.**

Room aggregates: `partyRooms/{id}.totalGiftsReceived += quantity`, `.totalBeansEarned += beans` (`:445`–`:448`), and a ticker row in `partyRooms/{id}/gifts` (`:430`–`:443`) whose `timestamp` is **`Date.now()` millis, not a serverTimestamp** — because the client's flow orders on it and deserialises into a Long (`:440`).

## 3.6 `sweepEmptyPartyRooms` — grace periods

`party.ts:1445`. Cron **`every 1 minutes`**, Asia/Kolkata. Two cases with deliberately different fuses (`:1432`–`:1443`):

| case | query | grace |
|---|---|---|
| Emptied, last client never closed it | `isActive == true && emptySince < now − 2s` | **`EMPTY_GRACE_MS = 2_000`** (`:73`) |
| **Never** occupied | `isActive == true && occupantCount == 0 && startedAt < now − 10min` | **`NEVER_OCCUPIED_GRACE_MS = 10 * 60 * 1000`** (`:1451`) |

Each limited to 50; duplicates de-duped by id (`:1468`–`:1471`).

The 2-second fuse is really a **client-closes-the-door** mechanism, not a cron one. `endPartyRoom` (`:1349`) lets **anyone** close a room once `emptySince` is ≥2s old (`:1362`–`:1369`), and the argument is at `:1338`–`:1347`: the fastest useful cron is one a minute, and *"An abandoned room lingering in the list for up to sixty seconds is exactly the ghost-room defect this was supposed to fix"*. The cron is only the backstop for when there is no last client.

The 10-minute fuse exists because *"a room can legitimately sit open for a few minutes while its owner invites people"* (`:1442`).

`closeRoom` (`:1384`) deletes **every seat document**, clears `isInParty`/`partyRoomId` on each seat holder, the first **400** listeners and the host, then writes `isActive: false`, `endedAt`, `listenerCount: 0`, `occupantCount: 0` — all in one batch (`:1417`–`:1424`). Listener *documents* are left alone deliberately (`:1406`–`:1413`): a room can hold more listeners than a 500-write batch allows, and nothing reads a closed room's listeners; the presence flag is the part that would otherwise strand someone at the top of the discovery feed.

## 3.7 Room admin powers

Two tiers above member: `owner` (= `hostUid`) and `admin` (= in the `admins[]` array). `roleOf`, `party.ts:206`.

| power | owner | admin |
|---|---|---|
| Rename / reshape / visibility / password / welcome | ✅ | ❌ |
| Appoint or dismiss admins | ✅ | ❌ |
| Approve or refuse seat requests | ✅ | ✅ |
| Invite to a seat | ✅ | ✅ |
| Lock / unlock a seat | ✅ | ✅ |
| Mute a **member** | ✅ | ✅ |
| Mute the owner or another admin | ✅ (owner) | ❌ |
| Lift an **owner's** mute | ✅ | ❌ |
| Lift another admin's mute | ✅ | ❌ |
| Remove from seat / kick a member | ✅ | ✅ |
| Remove the owner or another admin | ✅ (owner) | ❌ |
| Close the room | ✅ | only once empty ≥2s |

**`MAX_ADMINS = 8`** (`:1317`). Two reasons at `:1288`–`:1294`: *"An admin who could appoint admins is an owner"*, and `admins` is an array read by every permission check in the file, so an unbounded one would make those checks expensive. Appointing yourself is refused (`:1311`).

## 3.8 Party failure paths

| failure | behaviour |
|---|---|
| Room closed mid-action | `requireLiveRoom` → `not-found`, *"This room has closed"* (`:226`–`:230`) |
| Banned account | `requireUser` → `permission-denied` (`:247`) |
| Kicked | `refuseIfKicked` on join, take, request, invite, decide, respond (`:232`) |
| Wrong private password | `passwordAttempts += 1` **and the error still throws** (`:639`–`:642`). Deliberately **not a lockout** — *"locking a room because a stranger guessed at it would hand any passer-by the ability to shut it"* (`:636`) |
| Re-join after process death | No password re-prompt if the listener row survives (`:624`) — Android kills and restores this screen freely (`:618`–`:621`) |
| Seat race | One `already-exists` (`:841`) |
| Invited seat filled | Falls to lowest free unlocked seat; `failed-precondition` only if every seat is taken (`:1093`) |
| Room shrunk under you | Seat deleted, `occupantCount` decremented (`:553`–`:563`) |
| Cosmetics lookup fails | Swallowed to empty strings — *"A missing entrance clip costs an animation; an exception here would cost the join"* (`:266`–`:268`) |
| Blocked-word config unreadable | Falls back to the 8 built-ins, not to no filter and not to an error (`:131`–`:135`) |
| `endPartyRoom` on a missing or already-closed room | Returns `{ended: true}` / `{ended: true, already: true}` (`:1358`–`:1359`) |

---

# 4. GIFTING

## 4.1 The catalogue

**Lives in the top-level `gifts/{giftId}` collection.** Configured by the CRM at `zipper-crm/app/gifts/page.tsx`. Writable by **Tech, App or Ops** (`firestore.rules:1464`) — deliberately not `isStaff()`, because *"marketing and support have no gift screen"* (`:1460`). **Read is `if true` — fully public, unauthenticated** (`:1463`), because the app shows gifts before login and `lottie-test.html` needs it.

A gift document, field names from the CRM and read verbatim by the server (`gifts.ts:198`–`:206`):

`name`, `emoji`, `imageUrl`, `lottieAsset`, `diamondCost`, `earningRate`, `category`, `isActive`, `sortOrder`. Accepted fallbacks for hand-seeded docs: `priceDiamonds`, `displayName`, `iconUrl`, `active`.

The field-name sensitivity is called out explicitly: reading `priceDiamonds` would have made `Number(undefined) = NaN` and thrown *"has no usable price"* on **every single gift in the app**, and checking `active` would have let a gift the CRM had switched off keep selling (`gifts.ts:201`–`:205`).

**Categories: `normal`, `exclusive`, `lucky`** (`zipper-crm/app/gifts/page.tsx:21`). Seeded catalogue (`:68`–`:75`):

| gift | diamondCost | earningRate | category |
|---|---|---|---|
| Rose 🌹 | 1 | 50 | normal |
| Heart ❤️ | 10 | 50 | normal |
| Teddy Bear 🧸 | 50 | 50 | normal |
| Crown 👑 | 100 | 52 | exclusive |
| Sports Car 🏎️ | 500 | 54 | exclusive |
| Rocket 🚀 | 1000 | 55 | exclusive |
| Lucky Box 🎲 | 50 | **5** | lucky |
| Super Star ⭐ | 5000 | 55 | exclusive |

The CRM only lets `earningRate` be edited freely for `exclusive`; `normal` and `lucky` are pinned to the config value (`effectiveRate`, `:79`–`:82`; `buildRateRanges`, `:55`–`:66`), and the form rejects a rate outside the range (`:211`).

Animation JSON is mirrored into `giftLottieData` with the same three-team write rule, *"otherwise saving a gift succeeds and its animation silently does not"* (`firestore.rules:1476`).

The app reads `isActive == true` ordered by `sortOrder` (`GiftRepository.kt:187`–`:188`). Quantity chips offered: **1, 10, 77, 177, 520, 1314** (`GiftDrawer.kt:55`) — which does not match the `17 / 37 / 77` combo set named in `GiftRepository.kt:71`.

## 4.2 The send sequence, in order

`settleGift` (`gifts.ts:82`). Validation before anything else: signed in (`:86`); `giftId` (`:92`); `receiverUid` (`:95`); **not self** — self-gifting *"would let a user cycle diamonds into beans at the receiver percentage"* (`:99`); `quantity` an integer **1–9999** (`:103`); `context` one of **`live`, `call`, `dm`, `party`** (`:106`, set at `:58`); `idempotencyKey` present and **≤128 chars** (`:109`).

Then, outside the transaction (both forbidden after a write): the host ladder (`:146`) and the party seat query (`:158`).

Inside one Firestore transaction — *"They commit together or not at all"* (`:55`):

1. **All seven reads in parallel** (`:164`–`:172`): claim, sender, receiver, gift, `appConfig/economy`, room (if any), seat (if party).
2. **Replay check** — claim exists → return the original result with `replayed: true` (`:176`–`:179`).
3. Sender exists (`:181`); **sender not banned** (`:190`) — there was no ban check at all, so a barred account *"could still move money through it with a token they already held"* (`:184`); receiver exists (`:193`); gift exists (`:194`).
4. Gift not switched off (`:207`).
5. **Price read from the server** (`:212`), finite and ≥0 (`:213`); `totalCost = unitPrice × quantity` (`:216`).
6. **Receiver percentage resolved** (`:225`–`:231`) — see below.
7. **Balance check** — `senderDiamonds < totalCost` → `failed-precondition` quoting both numbers (`:236`–`:241`).
8. `beansCredited = Math.floor(totalCost × pct / 100)` — **floor, never round**: *"never credit a bean that was not paid for"* (`:243`–`:244`).
9. `tx.update(sender)`: `diamonds −= totalCost`, `totalGemsSpent += totalCost` (`:258`).
10. `tx.update(receiver)`: `beans`, `totalBeansEarned`, `hostGiftEarnings` `+= beansCredited`; `totalGiftsReceived += quantity` (`:262`).
11. `accrueWeeklyEarning(receiver, beans, 'gift')` (`:271`).
12. **If `isHost === true`:** `accrueHostStats` + `applyHostLevel` (`:276`–`:291`).
13. `giftTransactions/{auto}` — the private record (`:294`).
14. Sender `giftShowcase/{giftId}` — `sentCount += quantity` (`:312`).
15. Receiver `giftShowcase/{giftId}` — `receivedCount += quantity` (`:319`).
16. `giftPairs/{sortedPair}/gifts/{giftId}` — `aToBCount` / `bToACount` (`:329`).
17. Receiver `topFans/{senderUid}` — `totalDiamonds += totalCost`, `lastGiftAt` (`:337`).
18. Sender `diamondTransactions` — ledger debit (`:359`).
19. Receiver `beanTransactions` — ledger credit (`:375`).
20. `giftEvents/{auto}` — the CRM reporting row (`:409`).
21. **If the room exists:** ticker row in `{room}/gifts` (`:430`), room totals (`:445`), seat `beansReceived` (`:462`).
22. `platformRevenue/{auto}` (`:472`).
23. **`giftIdempotency/{senderUid}_{key}` last** (`:495`).

## 4.3 The receiver-share arithmetic

Two sources, with a clear precedence (`gifts.ts:218`–`:231`):

**The per-gift `earningRate` wins** when it is a finite number `> 0 && <= 100`:
```
pct = isFinite(perGiftRate) && perGiftRate > 0 && perGiftRate <= 100
        ? perGiftRate
        : receiverPctFor(category, rates)
```
The reason at `:220`–`:224`: the CRM sets `earningRate` per gift — Rose 50, Crown 52, Rocket 55, Lucky Box 5 — and shows the operator the resulting host cut and Zipper margin on the same screen, so *"That per-gift number is the decision that was actually made"*. The category rate is the fallback for gifts seeded before the field existed.

**`receiverPctFor(category, rates)`** (`gifts.ts:509`–`:524`), reading `appConfig/economy.giftRates`:

| category | formula | defaults |
|---|---|---|
| `exclusive` | `floor((exclusiveReceiverPctMin + exclusiveReceiverPctMax) / 2)` | min **50**, max **55** → `floor(52.5)` = **52%** |
| `lucky` | `luckyReceiverPct` | **50%** |
| anything else (incl. `normal`) | `normalReceiverPct` | **50%** |

Category matching is lowercased, `'normal'` on empty (`:513`).

**Exclusive uses the midpoint, not a roll.** Stated at `:503`–`:507`: *"a per-transaction random share would make a host's earnings unpredictable for no benefit to anyone"*, and the lucky mechanic already exists for gifts meant to be a gamble.

**The `lucky` fallback is contradictory.** `receiverPctFor` defaults `luckyReceiverPct` to **50** (`gifts.ts:520`), while the CRM's own form defaults and seeds it at **5** (`zipper-crm/app/economy/config/page.tsx:339`; Lucky Box `earningRate: 5` at `gifts/page.tsx:74`). The decisive line: `return num(rates.luckyReceiverPct, 50)`. In practice the per-gift `earningRate` of 5 pre-empts it for the seeded gift; a hand-seeded lucky gift with **no** `earningRate` and **no** `luckyReceiverPct` in config pays the receiver **50% instead of 5%** — a tenfold overpay on the category the CRM describes as *"rest goes to prize pool"* (`page.tsx:341`).

## 4.4 Worked examples

**Rocket, 1,000 diamonds, `earningRate: 55`, quantity 1:**

| step | arithmetic | result |
|---|---|---|
| `unitPrice` | from `gift.diamondCost` | 1,000 |
| `totalCost` | 1,000 × 1 | **1,000 diamonds** |
| `pct` | per-gift 55 wins over category 52 | **55%** |
| `beansCredited` | `floor(1000 × 55 / 100)` | **550 beans** |
| sender | `diamonds −1,000`, `totalGemsSpent +1,000` | |
| receiver | `beans +550`, `totalBeansEarned +550`, `hostGiftEarnings +550`, `totalGiftsReceived +1` | |
| `platformCut` | 1,000 − 550 | **450** |

**Same gift ×77:** `totalCost = 77,000`; `beansCredited = floor(42,350) = 42,350`; `platformCut = 34,650`. Showcases `+77`, `topFans.totalDiamonds +77,000`, `totalGiftsReceived +77`, `giftPairs` count `+77`.

**Lucky Box, 50 diamonds, `earningRate: 5`, quantity 1:** `pct = 5`; `beansCredited = floor(2.5) = 2`; **platform keeps 48 of 50 (96%)**. The floor costs the receiver 0.5 beans — 20% of what they were owed on a single send.

**Rose, 1 diamond, 50%:** `beansCredited = floor(0.5) = 0`. **The receiver gets nothing.** A Rose sent 10 at a time yields `floor(10 × 50 / 100) = 5`; sent one at a time ten times yields **0**. The floor is per-transaction, so quantity batching materially changes the host's income on cheap gifts.

## 4.5 Everything else the send writes

| document | fields |
|---|---|
**`giftTransactions/{auto}`** (`:294`) — PRIVATE | `senderUid`, `receiverUid`, `giftId`, `giftName`, `quantity`, `unitPrice`, `diamondCost`, `beansCredited`, `receiverPct`, `category`, `context`, `roomId`, `createdAt`. Readable by the two parties, finance, admin; `write: if false` (`firestore.rules:1524`) |
**`users/{uid}/giftShowcase/{giftId}`** ×2 (`:312`, `:319`) — PUBLIC, **anonymous** | `giftId`, `displayName`, `iconUrl`, `emoji`, and `sentCount` **or** `receivedCount`. Counts only — *"No uid, no timestamp"* (`firestore.rules:1269`). `emoji` matters: a CRM gift saved in emoji mode has no `imageUrl`, and without it the profile *"rendered every gift as the same grey box"* (`gifts.ts:310`) |
**`users/{uid}/topFans/{senderUid}`** (`:337`) — PUBLIC, **named** | `fanUid`, `displayName`, `photoUrl`, `totalDiamonds`, `lastGiftAt`. How much, **never which gift** (`firestore.rules:1276`) |
**`giftPairs/{sortedPair}/gifts/{giftId}`** (`:329`) | `giftId`, `aToBCount`, `bToACount`, `lastAt`. Pair id is the sorted uids, so one document regardless of who sends first (`pairIdOf`, `:78`). Readable only if your uid is in the pair id (`firestore.rules:2918`) |
**`users/{sender}/diamondTransactions`** (`:359`) | `type:'debit'`, `amount`, **`balanceAfter`**, `reason:'gift_sent'`, `reasonLabel`, **`relatedUid`**, `relatedUserName`, `giftId`, `quantity`, **`context`**, `roomId`, `transactionId`, `timestamp` |
**`users/{receiver}/beanTransactions`** (`:375`) | mirror, `reason:'gift_received'`, plus `diamondCost`, `receiverPct` |
**`giftEvents/{auto}`** (`:409`) | `senderUid`, `receiverUid`, `giftId`, `giftName`, `giftType`, `perGiftCost`, `quantity`, `totalCost`, `beansEarned`, `imageUrl`, `lottieAsset`, `roomId`, `timestamp` |
**`{liveRooms\|partyRooms}/{roomId}/gifts/{auto}`** (`:430`) | `uid`, `senderName`, `senderPhotoUrl`, `giftName`, `giftId`, `emoji`, `imageUrl`, `quantity`, `diamondCost`, `timestamp` (**millis**) |
**room document** (`:445`) | `totalGiftsReceived += quantity`, `totalBeansEarned += beansCredited` |
**seat document** (`:463`) | `beansReceived += beansCredited` (party only) |
**`platformRevenue/{auto}`** (`:472`) | `type:'gift'`, `subType: category`, `quantity`, `perGiftCost`, `grossDiamonds`, `payoutBeans`, `platformCut`, `senderUid`, `receiverUid`, `roomId`, `transactionId`, `timestamp` |
**`users/{receiver}/weeklyEarnings/{ISTweek}`** (`:271`) | `beans`, `giftBeans`, `released: false` |
**`users/{receiver}/dailyStats/{IST date}`** (`:276`, hosts only) | `beans`, `giftBeans`, `giftsReceived` |

The ledger rows are explicitly built for a chargeback file, not a history screen (`gifts.ts:345`–`:358`): `relatedUid` because *"a display name is not an identifier"*, `balanceAfter` because *"without a running balance you cannot reconstruct the timeline, only assert it"*, `context` so the gift ties to a real session.

`giftEvents` and `platformRevenue` exist because the FastAPI backend builds **every** gift figure in the weekly and monthly reports from those two collections, not from `giftTransactions` — moving settlement server-side without them *"would have zeroed the CRM's gift revenue while the app carried on working"* (`:393`–`:403`). Field names are verbatim what `backend/app/services/reports.py` reads; renaming one drops it from the report silently rather than erroring.

Read access on `giftEvents` is room-scoped (`firestore.rules:1503`–`:1506`): an in-room gift is public, anything else is private to the two parties. Until 10 Sep 2026 it was `request.auth != null`, so *"any signed-in client could… reconstruct who had gifted whom, across the entire platform"* (`:1495`).

**`users/{uid}/giftsSent` and `giftsReceived` are dead.** They still carry rules (`firestore.rules:1414`–`:1419`), including `allow create: if request.auth != null` on `giftsReceived`. Nothing has ever written them — `GiftRepository` was repointed at `giftShowcase`, and the comment says so: *"which nothing has ever written, so both sections were empty on every profile"* (`GiftRepository.kt:137`).

## 4.6 Idempotency

`giftIdempotency/{senderUid}_{idempotencyKey}` (`gifts.ts:117`). Read first inside the transaction (`:164`); if present, the stored `{transactionId, totalCost, beansCredited, receiverPct, quantity}` is returned with `replayed: true` and **nothing is charged** (`:176`–`:179`). Written **last** in the transaction (`:495`). `read, write: if false` for all clients (`firestore.rules:2925`).

Why it exists, from `gifts.ts:69`–`:74`: mobile networks drop responses, and *"a gift button that has visibly done nothing gets tapped again"*. Without the claim, the second tap is a second gift.

The stated reason for writing the claim last is **not correct as written**: *"Claim last, so a crash mid-transaction leaves nothing claimed"* (`:494`). A Firestore transaction is atomic — write order inside it has no bearing on what survives a crash. The behaviour is right; the rationale is not.

Key generation is the client's responsibility, and the two callers differ:
- **Live:** `"live_{giftId}_{hostUid}_{qty}_" + UUID.randomUUID()` (`WatchLiveViewModel.kt:380`) — a **fresh key per tap**, deliberately, so two taps a second apart are two gifts (`:374`–`:377`). This means the guard only protects against retries of one in-flight call, not against a double tap.
- **Default:** `money.newIdempotencyKey()` (`GiftRepository.kt:95`), with the instruction to generate it on press and reuse it for every retry — *"a fresh key per retry defeats the server's replay guard and charges twice"* (`:93`).

`settleGift` also pins a warm instance behind an env switch: `WARM_INSTANCES=1` → `minInstances: 1`, otherwise zero. Four pinned functions at 256MB came to **$40.14/month** on the first deploy (`gifts.ts:13`), and the note says to turn it on at launch, not before.

## 4.7 Lucky gifts

**Lucky gifts are not implemented as a chance mechanic. Today a `lucky` gift is an ordinary gift with a very low receiver percentage.** `settleGift` has no roll, no RNG, no diamond return, and never touches the sender's balance upward.

- The only `lucky` handling in `functions/` is the one `receiverPctFor` branch (`gifts.ts:519`–`:520`).
- `GiftResult.LuckyWin(multiplier, diamondsBack)` exists in the app (`GiftRepository.kt:33`) and is rendered in three places (`VideoCallViewModel.kt:423`, `OtherUserViewModel.kt:291`, `:317`) and **is never returned**. The decisive line: *"the server does not yet roll lucky gifts, so this never returns it"* (`GiftRepository.kt:78`).
- **The return range is configured and unread.** `luckyReturnMin` default **5×** and `luckyReturnMax` default **20×** the gift cost (`zipper-crm/app/economy/config/page.tsx:342`–`:346`). Grepping `functions/src/` for `luckyReturn` returns nothing. The CRM operator can tune a payout band no code consults.
- The app also carries a client-side `EconomyEngine.luckyGiftOutcome` (`zipper-app/.../util/EconomyEngine.kt:164`) with no caller in the gift path, and `LevelEngine` states *"Lucky gift 1% of diamonds spent"* (`:13`) — a third number, matching `LevelScreen.kt:254` but nothing in `functions/`.
- **The `chance` subsystem is the intended home and is not wired to gifting.** `backend/app/services/chance.py` is a complete provable-fairness implementation (HMAC-SHA256 from a committed seed, `secrets` not `random`, round written before payment, a modelled reserve and three payout ceilings, auto-suspend). Its own opening quotes the spec: *"no chance mechanic should be live"* until it exists (`chance.py:27`). There is **no call path** from `settleGift` or the Android client into it — the app talks to Firebase callables, the chance engine lives in the FastAPI/Mongo backend.
- The unshipping is deliberate and the reason is recorded: chance mechanics *"are what India's Online Gaming Act 2025 reaches"* and need a legal opinion before money rides on a random number (`GiftRepository.kt:79`–`:81`).

So three different lucky-gift economics are described in the codebase — 5% receiver share (CRM), 50% receiver fallback (`gifts.ts:520`), and a 5×–20× sender return (CRM config, unread) — and the one that executes is whichever `earningRate` the CRM happened to save. **Business purpose unclear** for which of the three is intended.

## 4.8 Gifting failure paths

| failure | behaviour |
|---|---|
| **Insufficient balance** | `failed-precondition` quoting both numbers: cost and balance (`gifts.ts:236`–`:241`). Nothing is written. Android maps a `FAILED_PRECONDITION` whose message contains "diamond" to `InsufficientDiamonds` (`GiftRepository.kt:122`–`:124`) — **a string match on the server's prose**; rewording the message silently breaks the branch |
| **Receiver gone** | `not-found`, *"Recipient not found"* (`:193`). Nothing written |
| **Gift deleted or switched off** | `not-found` (`:194`) / `failed-precondition` (`:207`) |
| **Gift has no usable price** | `internal`, naming the gift id (`:214`) |
| **Sender banned** | `permission-denied` (`:190`) |
| **Self-gift** | `invalid-argument` (`:101`) |
| **Host gone / room closed** | The room read happens **inside** the transaction specifically so the mirror can be **skipped** rather than failing the gift (`:138`–`:142`): *"A gift that reaches the host but misses the ticker is a cosmetic loss"*. Money still moves; the ticker, animation, room totals and seat leaderboard are all lost |
| **Recipient left their seat mid-send** | Seat increment skipped without complaint (`:462`); money already landed (`:450`–`:461`) |
| **Mid-transaction crash** | One Firestore transaction across all 23 writes. All or nothing — including the idempotency claim, so a crashed send is retryable with the same key |
| **Duplicate send (retry)** | Claim replay returns the original result, `replayed: true` (`:176`) |
| **Duplicate send (second tap, live)** | **Charged twice**, by design — the live key carries a fresh UUID (`WatchLiveViewModel.kt:380`) |
| **Receiver is not a host** | Beans land; no `dailyStats`, no level progression (`:276`) |
| **Config unreadable** | `configSnap.data() ?? {}` (`:225`) → every category falls back to its hard-coded default |
| **Ladder read fails** | Previous cache kept, so *"a transient Firestore error cannot silently demote every host"* (`hostStats.ts:77`–`:78`) |

---

# 5. FCM pushes — the complete set

`functions/src/push.ts` exports **exactly four**, all re-exported at `index.ts:4334`. **Every one is a DATA message, never a notification message** — a notification message is rendered by the OS with no app code involved, which means no full-screen intent, no ringtone, and no way to suppress it when the user is already looking at that chat (`push.ts:16`–`:20`). Tokens live one-document-per-device at `users/{uid}/fcmTokens/{token}`; the legacy single `fcmToken` string is consulted **only** when the subcollection is empty, because sending to both would post twice (`tokensFor`, `:51`–`:65`). `fcmTokens` is owner-read-only, not part of the world-readable profile surface, because *"an FCM token is enough to ring somebody's phone"* (`firestore.rules:1291`).

| # | function | trigger | recipient | data payload | priority / TTL |
|---|---|---|---|---|---|
| 1 | **`pushIncomingCall`** (`push.ts:128`) | `calls/{callId}` **onCreate**, only if `status === 'ringing'` (`:132`) | `call.receiverId`, **every device** | `type:'INCOMING_CALL'`, `callId`, `callerUid`, `callerName`, `callerPhotoUrl`, `createdAt` | `high`, **TTL 30s**, `directBootOk: true` — *"a call that could not be delivered inside 30s is not a call worth delivering"* (`:87`) |
| 2 | **`pushCallStatus`** (`push.ts:150`) | `calls/{callId}` **onUpdate**, only `ringing → not-ringing` (`:155`) | `after.receiverId` | `type:'CALL_ENDED'`, `callId`, `status` | `high`, TTL 30s |
| 3 | **`pushChatMessage`** (`push.ts:170`) | `conversations/{convoId}/messages/{msgId}` **onCreate** | the other half of the sorted-uid conversation id (`:178`), **suppressed if the recipient has blocked the sender** (`:182`) | `type:'NEW_MESSAGE'`, `convoId`, `senderUid`, `senderName`, `preview` — text truncated to 120 chars, or `"Sent a photo"` / `"Invited you to a live"` / `"Sent a message"` (`:186`–`:190`) | `high`, TTL 24h |
| 4 | **`pushLiveStarted`** (`push.ts:204`) | `liveRooms/{roomId}` **onCreate**, unless `isActive === false` (`:208`) | the host's **followers**, **hard-capped at 2,000** (`:226`) | `type:'LIVE_STARTED'`, `roomId`, `hostUid`, `hostName`, `hostPhotoUrl`, `title` | `high`, TTL 1h |

Push #2 is the counterpart to #1: whatever happened — accepted on another device, cancelled, timed out — *"the ringing notification must go away"* (`:156`).

Push #4's fan-out: followers read in pages of 100 to collect tokens (`:244`–`:250`), then multicast in chunks of **500** — FCM's limit, and *"it is a limit on TOKENS — which is no longer the same number as followers"* (`:253`). Dead tokens are dropped per `(uid, token)` pair so one dead phone cannot unregister another (`:262`–`:271`). The **2,000 cap is an acknowledged half-measure**: beyond it the single invocation would read one token subcollection per follower under one 540s timeout, and a retry repeats all of it. The stated plan — *"needs the fan-out moved to a task queue… which is still to be done"* (`:220`) — is not built. **The 2,001st follower is never notified.**

Dead-token cleanup (`dropDeadToken`, `:72`) deletes the token document and clears the legacy field **only if that field names this exact token** (`:78`), on `registration-token-not-registered`, `invalid-registration-token` or `invalid-argument` (`:103`–`:107`). All other errors are logged and swallowed; `sendToUser` settles either way so one failing device cannot stop the others (`:118`–`:124`).

**Pushes that do not exist for these four features:**
- **No gift push at all.** A host receiving a 5,000-diamond Super Star while backgrounded is told nothing.
- **No party push at all.** A seat **invitation** is a Firestore document the invitee's client renders as a popup (`invitePartySeat`, `party.ts:1037`) — if the app is not open, the invitation is simply not seen, and nothing expires it.
- **No seat-request push** to the owner in consent mode.
- **No PK invite push.**
- **No live-ended push** to viewers.
- **No `partyRooms` onCreate push** to followers, even though the live equivalent exists.

---

# 6. Dead, half-built and contradictory — consolidated

**Broken by security rules**
1. **PK battles cannot start, score or end.** `liveRooms` update is `isLiveHost() || hasOnly(['viewerCount','likeCount']) || isOps()` (`firestore.rules:2086`). Every PK write touches the *partner's* room or writes `pkScore` from a *viewer*: `PKRepository.kt:63`, `:154`, `:163`, `:202`–`:205`, `:217`–`:220`. The score is written by the gifting viewer's device in a client batch (`WatchLiveViewModel.kt:369`) and is denied.
2. `pkInvites.status` includes `expired` (`LiveRoom.kt:101`) — nothing ever writes it. PK invites have no timeout.

**Rules that contradict their own comments**
3. `liveRooms/{id}/gifts` — comment: *"A client create here would be a gift nobody paid for"*, rule immediately below: `allow create: if request.auth != null` (`firestore.rules:2112`–`:2114`). The party equivalent was closed to `isOps()` (`:2314`); the live one was not. A client can forge live ticker rows and top the room leaderboard for free.
4. `platformRevenue` — `allow create: if request.auth != null` (`firestore.rules:1581`). Any signed-in client can insert rows into the revenue collection the CRM's reports scan.
5. `users/{uid}/giftsReceived` — `allow create: if request.auth != null` (`:1417`) on a collection nothing writes and nothing reads.

**Dead code and orphaned config**
6. **`hostMuted` is written and never read.** `backend/app/services/live.py:316` writes it; zero Kotlin files mention it. The service says so itself (`live.py:36`), returning the sentence to the CRM verbatim.
7. `endedByStaff` and the staff `endReason` (`live.py:211`–`:213`) are never read by the Android app.
8. `GiftResult.LuckyWin` is rendered in three UI paths and never returned (`GiftRepository.kt:78`).
9. `luckyReturnMin` / `luckyReturnMax` (5×–20×) are editable in the CRM and read by nothing in `functions/` (`zipper-crm/app/economy/config/page.tsx:342`–`:346`).
10. `EconomyEngine.luckyGiftOutcome` (`EconomyEngine.kt:164`) has no caller in the gift path.
11. `users/{uid}/giftsSent` and `giftsReceived` — rules exist, no writer ever (`GiftRepository.kt:137`).
12. `backend/app/services/chance.py` is a complete chance engine with no call path from the app or from `settleGift`.
13. **No live-room sweep exists.** Calls and party rooms both have one (`calls.ts:656`, `party.ts:1445`); a crashed live host leaves `isActive: true` and `isLive: true` until their own next `startLive`.

**Contradictory numbers**
14. **Lucky receiver share has three values:** 5% (CRM default and seed), 50% (`gifts.ts:520` fallback), 1% (`LevelEngine.kt:13`, `LevelScreen.kt:254`).
15. Quantity chips are `1, 10, 77, 177, 520, 1314` (`GiftDrawer.kt:55`); the documented combo set is `17 / 37 / 77` (`GiftRepository.kt:71`).
16. `setCallRate`'s floor fallback is `100` (`hosts.ts:416`); the CRM default `minHostCallRate` is `350` (`economyConfig.ts:286`).

**Behavioural contradictions**
17. **A caller's own ring timeout is filed as a decline, not a miss.** `markMissed` → `declineCall(id,"missed")` (`CallRepository.kt:130`), but `declineCall` only honours `'missed'` from the receiver (`calls.ts:285`). The caller's screen says MISSED (`VideoCallViewModel.kt:132`); history says `declined` / `caller_cancelled`.
18. **A host who disconnects mid-call keeps earning.** Only the payer ticks (`VideoCallViewModel.kt:218`) and no server check confirms the earner is present.
19. `liveRooms/{id}/comments` does not check `uid == request.auth.uid` (`firestore.rules:2107`), unlike `partyRooms/{id}/messages` which does (`:2271`).
20. **Nothing cleans up a finished live room's subcollections.** `endLive` writes three fields (`LiveRepository.kt:153`); `comments`, `gifts`, `viewers`, `viewerCount` and `likeCount` all persist.
21. The idempotency rationale *"Claim last, so a crash mid-transaction leaves nothing claimed"* (`gifts.ts:494`) describes a property Firestore transactions give regardless of write order.

**Unit ambiguity**
22. `platformCut = grossDiamonds − payoutBeans` (`calls.ts:576`, `gifts.ts:479`) subtracts beans from diamonds while `beanToDiamondRate` defaults to 20 (`zipper-crm/lib/rates.ts:71`). **Business purpose unclear** — nothing states whether the cut figures the CRM reports are a diamond amount or a notional ratio.

**Acknowledged half-measures**
23. `pushLiveStarted` caps at 2,000 followers; the task-queue fan-out is *"still to be done"* (`push.ts:220`).
24. `setStreamQuality` is a no-op — `// TODO: apply via Agora downlink quality config` (`WatchLiveViewModel.kt:446`).