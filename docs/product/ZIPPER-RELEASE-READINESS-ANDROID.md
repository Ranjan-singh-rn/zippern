# ZIPPER — Release readiness (Android)

Updated 4 Nov 2026. **Verdict: not ready.** The Track B Android code has not been compiled. Nothing here was
committed, pushed, merged or deployed.

## 1. Gates

| Gate | State | What closes it |
|---|---|---|
| Android compiles (`gradle build emu`) | **open** — Track B app code uncompiled | owner double-clicks `~/zipper-release/qa/local-stack.command`; I then run `gradle unit`, fix, `gradle build emu` |
| Android unit tests | open (last green 474/474 before Track B) | `gradle unit` on the Mac |
| Android lint (0 errors, no suppression) | open for the Track B tree (0 errors before) | `gradle lint` |
| Emulator E2E (Track B journeys) | open — 0 run | walk `ZIPPER-END-TO-END-TEST-REPORT.md` §3 on the local stack |
| Physical device | open | face liveness; real Agora call / live / PK media; push on a real phone |
| Functions tests | **green** 2127/2127 | — |
| Backend tests | **green** in the sandbox except 8 environment-only modules (green on the Mac before) | `verify local backend` |
| CRM | **green** typecheck 0, 46 scripts | — |
| Rules emulator tests | static green; B12 emulator checks pending | `rules b12` (own emulator, port 8085) |
| Signing | the existing release keystore and process (Track A); no signing change in Track B | build prod APK/AAB after the gates above |

## 2. Deployment needed for Track B (none done — needs the owner's approval)

| Piece | Contents |
|---|---|
| Firestore rules | header entries E1–E8 (games, game history, ledger/idempotency/promo deny-all, Owner-only games/leaderboards/partySubscription config, party access log, leaderboards, live rooms/comments/presence/PK invites) |
| Cloud Functions (new) | games (`gameCatalog`, `createGameMatch`, `joinGameMatch`, `quickGameMatch`, `ludoAction`, `teenPattiAction`, `teenPattiMyCards`, `carromShot`, `snakesRoll`, `fourRowDrop`, `claimGameTimeout`, `leaveGameMatch`, `rematchGameMatch`, `sweepGameMatches`, the 15 instant-game callables, `gameFairness`, `rotateGameSeed`), `settleLeaderboards`, Party Pro (`privateRoomSubscriptionStatus`, `subscribePrivateRooms`, `cancelPrivateRoomSubscription`, `renewPrivateRoomSubscriptions`), `setPartyMusic`, `forgetQuickLogin`, `liveViewerCount`, `sweepLiveRooms`, `pkMatch`, `pkRespond`, `pkEnd` |
| Cloud Functions (changed) | `settleGift` (rankings accrual, PK score, live checks), call billing (rankings accrual, calls-off refusal), `joinPartyRoom`/`updatePartyRoom`/`createPartyRoom`/`leavePartyRoom`, `mintQuickLoginToken` (per-device cap), `generateAgoraToken` (host-blocked viewers), `syncLivePresence` (server duration) |
| Backend | seller business routes (tiers, credit, borrow, trades, self-use, profit), promotions and games reports |
| CRM | Games, Leaderboards, Party Pro, Room music, Seller trades pages; seller business panel; seller tiers editor |
| Config (Owner) | games stay OFF until switched on; ranking tiers; Party Pro on/price; music tracks with licences |

**Coupling:** the B12 rules (E8) and the B12 app go together — the app no longer writes `viewerCount` or PK fields,
and the rules no longer accept them. Old app builds keep working for viewers (±1 steps are still accepted) but
their PK screens stay broken as they always were.

## 3. Known limits shipped as-is

* Live co-host / multi-guest seats are not built (PK is).
* Gift art is static with motion until SVGA files exist (`GiftAnimationOverlay` `TODO(svga)`).
* The music catalogue is empty until licensed tracks are added.
