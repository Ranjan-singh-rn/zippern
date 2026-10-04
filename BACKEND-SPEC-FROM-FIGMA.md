# Backend specification — derived from the 94 Figma screens

Every collection, function and CRM screen the designs require. Written before
the UI so the app is built against a real contract rather than a guess.

**Status key** — ✅ exists and is used · ⚠️ exists but incomplete · ❌ missing

Existing collections were inventoried from the app, the CRM and
`firestore.rules` rather than assumed. Two useful finds: **`verifiedIdentities`
and `hostKyc` already exist** and should be reused for host verification rather
than replaced.

---

## A. Gifts — Figma page 12, profile pages

| Collection | Status | Notes |
|---|---|---|
| `gifts` | ⚠️ | catalogue exists; needs `tier`, `sortOrder` per category, `availableFrom/Until`, `minUserLevel`, `isLucky` + odds, artwork slots |
| `giftTransactions` | ⚠️ | rule fixed 10 Sep; now written by `settleGift` |
| `giftEvents` | ⚠️ | room-scoped read; still written client-side until step 2 |
| `giftPairs/{pair}/gifts` | ❌ | powers the "you sent this ×2" highlight |
| `users/{uid}/giftShowcase` | ❌ | public anonymous totals |
| `users/{uid}/topFans` | ❌ | public named totals |
| `giftsSent` / `giftsReceived` | ⚠️ | legacy; superseded by the above — migrate then drop |

**Functions:** `settleGift` ✅ built.
**CRM:** gift catalogue editor — price, category, tier, ordering, availability
window, level gates, lucky odds, four artwork slots (thumb, preview, animation,
audio). Price changes must be **versioned, never overwritten**: a gift sent
yesterday at 900 must still reconcile at 900.

---

## B. Calls — Figma page 04

| Collection | Status | Notes |
|---|---|---|
| `calls` / `callHistory` | ⚠️ | no ledger rows, no server clock |
| `activeCalls` | ❌ | server-authoritative call state, `tickIndex` |

**Functions:** `startCall`, `tickCall`, `endCall`, `sweepStaleCalls` — all ❌.
**CRM:** the user↔user rate (1,600 💎/min) has **no config field at all**; add
`userCallRatePerMin`. Gender split percentages likewise — add `receiverSplit`.

---

## C. Host — Figma page 09

| Collection | Status | Notes |
|---|---|---|
| `hostApplications` | ✅ | agency-entered; add `agencyPhotoUrl` |
| `verifiedIdentities` | ⚠️ | **already exists** — extend rather than replace |
| `hostKyc` | ⚠️ | already in rules |
| `hostVerification/{uid}` | ❌ | AI score, threshold, provider, manual verdict |
| `users/{uid}` rollups | ❌ | `beansToday`, `secondsLiveToday`, `callsToday`, `weekBeans`, `weekStartAt` — Host Home cannot be built without these |
| `hostPayouts/{uid}/weeks/{weekId}` | ❌ | per-week statement, status, reference |

`users/{uid}` also needs `beansPendingPayout` and `beansAvailable` for the
one-week-in-arrears hold.

**Functions:** `submitHostCapture`, `onHostCaptureSubmitted`,
`reviewHostVerification`, `rollupHostDay`, `releaseBeansForWeek` — all ❌.
**CRM:** manual verification queue (both images side by side), agency photo
upload, per-level `maxCallRateBeans`.

**`hostLevel` is written once as 0 and never updated.** Until a function
maintains it, every level gate in the designs is decorative.

---

## D. Economy — Figma page 05

| Collection | Status | Notes |
|---|---|---|
| `appConfig/economy` | ✅ | app now reads it via `EconomyConfigRepository` |
| `diamondTransactions` / `beanTransactions` | ⚠️ | **calls and games write none** |
| `rechargeRequests`, `coinPurchaseRequests` | ✅ | |
| `sellers` | ⚠️ | needs `retailRatePerLakh` — the reseller list cannot be compared without it |

**Functions:** `convertBeans`, `purchaseBagItem`, `claimDailyReward` — all ❌.

---

## E. Games — Figma page 10 · deferred, gated on level ≥ 1

| Collection | Status |
|---|---|
| `gamingBets` | ⚠️ exists; `settleBet` trusts a client-supplied `winnings` |
| `games`, `gameCategories`, `gameProviders` | ❌ |
| `gameSessions`, `userGameLimits`, `userGameDailyRollup` | ❌ |
| `gameRankings`, `gameRoundHistory` | ❌ |

**Settlement must come provider-server → your server, never through the
WebView.** The JS bridge is not yet built; when it is, it must not touch a
balance.

**CRM:** game catalogue, launch URLs, provider keys *by reference* (Secret
Manager path, never the key itself), per-game bet limits, **RTP with a
second-approver gate** — it is displayed to users on five screens, so a wrong
value is a consumer-protection claim with a screenshot attached.

---

## F. Events and rankings — Figma page 11

Nothing exists. `GiftLeaderboardEntry` is four fields and cannot build six of
the eight screens.

| Collection | Purpose |
|---|---|
| `campaigns/{id}` + `/tiers` `/prizes` `/entries` `/rooms` | campaign definition and standings |
| `campaignEvents` | append-only source of truth, idempotent on `sourceTxnId` |
| `campaignFulfilment` | reward delivery, idempotent |
| `userCampaignState` | "my progress" without reading a whole board |
| `weeklyRank/{IST-week}/...` | Top Gifters / Hosts / Earners |
| `liveRooms/{id}/hourlyRank/{hour}` | in-room hourly |
| `monthlyCp/{month}/charm` `/chosen` | Monthly CP |

**Functions:** `onGiftSettled` fan-out, `aggregateCampaignBoards` (60s),
`closeHourlyRank` (hourly IST), `closeWeeklyRank`, `closeMonthlyCp`,
`freezeCampaign`, `settleCampaign` (+72h chargeback window), `getMyRank`.

**Firestore cannot answer "#1,284 of 42,190" cheaply.** Budget a Redis or RTDB
sorted set per board, or the "your position" card does not ship.

**Two crons disagree today:** the agency payout is `0 0 * * 0` **UTC** = 05:30
Sunday IST, while every ranking resets 23:59:59 IST. Reconcile before build.

---

## G. Cosmetics, VIP, rewards — Figma page 13

| Collection | Status |
|---|---|
| `bagItems` | ⚠️ needs `tier`, a duration/price matrix, `renewable`, four artwork slots |
| `ownedItems` | ⚠️ flat; **no time concept at all** |
| `users/{uid}/inventory/{itemId}` | ❌ `expiresAt`, `isEquipped`, `renewCount`, notify flags |
| `subscriptionPlans`, `users/{uid}.svip` | ❌ SVIP does not exist in the codebase |
| `users/{uid}.monthlyCard` | ❌ |
| `signInSchedule`, `taskConfig`, `taskProgress` | ❌ |

**Expiry is server-authoritative.** `expiresAt` is a Timestamp; the client
renders days-remaining and never writes it. Purchase extends from
`max(now, existing expiresAt)` — **in the function, not the client**, or the
renewal maths on screen is a lie.

**Functions:** `purchaseCosmetic`, `expireCosmeticsCron` (hourly — must also
clear the equipped pointer, or an expired frame keeps rendering),
`expiryWarningCron`, `claimMonthlyCardDaily`, `renewSvip`, `claimSignIn`,
`claimTask`.

---

## H. Social — Figma page 14

| Collection | Status |
|---|---|
| `intimacy/{pairId}` | ❌ |
| `closeFriends/{uid}/slots` | ❌ |
| `users/{uid}.charmCp` | ❌ — **separate field from `hostLevel`**, which is beans-based |
| `users/{uid}.geo` | ❌ store the **cell**, never lat/lng |

**Nearby is a safety surface.** Store a truncated geohash, return a band
("within ~5 km") computed server-side, never a metre value. Hosts opt out by
default. Rate-limit and log reads per account — trilateration from two accounts
defeats any client-side blurring.

---

## I. Party rooms — Figma page 15

Nothing exists. Routes render a blank placeholder.

`partyRooms/{id}` + `/seats` `/queue` `/messages` `/moderationLog`.

**The real work is Agora role handling.** `AgoraManager` has only
`joinAsHost` / `joinAsAudience` with no mid-session switch. A party room needs
`setClientRole` at runtime. Host mute must call `muteRemoteAudioStream` **and**
persist the flag, enforced on every client — otherwise a muted guest is muted
only for the person who muted them.

**Agora token generation is still `null`.** An unauthenticated channel with open
mics is a room anyone can join and broadcast into.

---

## J. Moderation — cross-cutting

`kickedViewers` is currently the entire safety model. A room with eight open
mics needs mute, remove, ban, report-with-audio-window, an auto-close on N
reports, and a Trust & Safety queue in the CRM. None exist.

---

## Build order

**Phase 1 — money is safe** (blocks everything)
1. Point the app at `settleGift`
2. `startCall` / `tickCall` / `endCall` + watchdog
3. `convertBeans`, `claimDailyReward`, `purchaseBagItem`
4. **Close the `users/{uid}` write rule** — only safe after 1–3
5. Payout hold: `beansPendingPayout` / `beansAvailable` + release job

**Phase 2 — the app becomes buildable**
6. Host rollups and `hostPayouts` — Host Home and Payout need them
7. Host verification + the unverified gating
8. Gift privacy collections populated by `settleGift`
9. `hostLevel` maintenance — every level gate depends on it

**Phase 3 — engagement**
10. Cosmetics with expiry, SVIP, monthly card, sign-in, tasks
11. Rankings: hourly, weekly, Monthly CP
12. Campaign engine
13. Intimacy, Close Friends, charm

**Phase 4 — deferred**
14. Party rooms (Agora roles first)
15. Games (legal opinion first)

UI can start on any domain once its phase lands. Phase 1 blocks nothing visual —
it can be built while the UI work begins on screens whose data already exists:
onboarding, settings, profile, messages, diamond shop.
