# ZIPPER — End-to-end test report

Updated 4 Nov 2026. Actual results only. Where a suite or journey has not run, it says so.

## 1. Automated suites (sandbox, 4 Nov 2026, on the current working tree)

| Suite | Result | Notes |
|---|---|---|
| Cloud Functions (`node --test`, 377 suites) | **2127 / 2127 pass** | includes the Track B suites: games (ludo, gameMatches, teenPatti, carrom, boardGames, instantGames, moreGames, `gameDailyLimit` 6), leaderboards 13, partyPro, partyPin/lobby, promoCredits, `b10AccountSwitch` 13, `b12Live` 21 |
| Backend (`python -m tests.<module>`, 119 modules) | **111 pass, 8 environment-only** | the 8 need libraries the sandbox lacks (`google-cloud-firestore` ×4, `pydantic_settings` ×2, `pymongo`, `sendgrid`); they ran green on the Mac venv in Track A and run there again with `verify local backend` |
| CRM | typecheck **0 errors**; **46 check scripts pass** + hooks lint clean | Track B specs: games-config 30, leaderboards 15, party-pro 8 |
| Firestore rules — B12 static | **3 / 3** | the 37 emulator checks (`tests/firestore.b12live.rules.test.mjs`) need the Mac (`rules b12`) |
| Android unit tests | **not run on the Track B tree** | last Mac run 474/474 (`qa/verify-20261103T161211Z`, before Track B). Track B added `AccountSwitchTest`, `LiveRoomUiTest`, `TeenPattiCarromUiTest`, `MoreGamesUiTest`, `LeaderboardKeysTest`, updated `QuickLoginNoticeTest`, `SignInRoutingTest` — **all uncompiled** |

## 2. Emulator E2E

| Round | Result |
|---|---|
| Track A, Round 2 (3 Nov 2026) | **29 PASS, 0 FAIL, 0 pending** (`qa/E2E-TEST-LOG.md`) — the baseline for that fix round only |
| Track B journeys | **0 run.** Blocked: the Mac build channel (`~/zipper-release/qa/local-stack.command`) is stopped, so no Track B APK has been built |

## 3. Track B journeys to run (mission §13 and §17.8)

Each with: success, invalid input, insufficient balance, unauthorised user, network interruption, duplicate
request, restart/re-entry, ledger + CRM consistency.

| # | Journey | Server proof today | Emulator | Device |
|---|---|---|---|---|
| 1 | Register / log in | Track A | Track A pass | — |
| 2 | Face capture + verification | existing flow | screen only | **required** (liveness) |
| 3 | Switch between accounts (add, switch, remove, suspended target, expired credential) | `b10AccountSwitch` | pending | — |
| 4 | Buy diamonds (seller) | backend B2b/B9 tests | pending | — |
| 5 | Seller purchase, sale, trade, borrow, self-use, profit | `test_b9_seller_business` 46 | pending | — |
| 6 | 1-to-1 call with deduction | existing billing tests | pending | **required** (real Agora media) |
| 7 | Call interruption / settlement | existing watchdog tests | pending | required |
| 8–12 | Party room: create/join, sit/lock, lobby keeps room alive, private PIN (right/wrong/lockout), official access | partyLobby, partyPin, partyPro | pending | — |
| 13 | Gifts + travel animation + ledger | settleGift suites | pending | — |
| 14 | Room music | setPartyMusic tests | pending (needs a licensed test track) | — |
| 15 | Admin/member permissions, kick, seat removal | party suites | pending | — |
| 16 | Live: broadcaster + viewer (pause, camera off, pin, mute, block, PK match/accept/score/end, end card) | `b12Live` 21 | pending | required for media |
| 17 | Daily rewards + free-call card accounting | promoCredits, test_b2c_promotions | pending | — |
| 18–19 | Ranking settlement + rewards | leaderboards 13 | pending | — |
| 20 | Suspension, bans, appeals | Track A | Track A pass | — |
| G1–G20 | Every game: switch off/on, entry, play, settle, timeout, leave, reconnect, history, CRM report | per-game suites | pending | — |

## 4. What a pass will mean

A journey passes only when the emulator walk completes against the LOCAL stack **and** the ledger rows and CRM
report agree. A screen that opens is not a pass; a unit test is not an E2E pass.
