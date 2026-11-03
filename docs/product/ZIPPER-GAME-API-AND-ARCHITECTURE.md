# ZIPPER — Game API and architecture

Updated 4 Nov 2026. Code: `functions/src/games/` (Cloud Functions, region `asia-south1`), app
`zipper-app/.../ui/screens/games/` + `data/repository/GameFunctions.kt`, CRM `zipper-crm/app/app-config/games/`,
backend `GET /api/reports/games`.

## 1. Principles

1. **The server decides.** The phone sends an intention (a roll, a shot vector, a bet, a cash-out); the server
   validates it against the match state, computes the outcome and settles. The animation shows the server's result.
2. **Money only in transactions**, two rows per movement (see `ZIPPER-GAME-ECONOMY-AND-LEDGER.md`).
3. **Switches first.** `appConfig/games` is read inside each create/join/start; a game that is off (or the master
   switch) refuses new entries at once; matches and rounds already running finish and settle.
4. **Verifiable randomness.** Commit–reveal seeds; HMAC-labelled draws per round/move (`rng.ts`).

## 2. Callables

| Area | Callables |
|---|---|
| Catalogue | `gameCatalog` (only switched-on games, only player-facing fields) |
| Matches | `createGameMatch` (public or private with invite code), `joinGameMatch`, `quickGameMatch` (matchmaking), `leaveGameMatch` (refund before start / forfeit during play), `rematchGameMatch`, `claimGameTimeout` |
| Moves | `ludoAction`, `teenPattiAction` + `teenPattiMyCards` (own hand only), `carromShot`, `snakesRoll`, `fourRowDrop` |
| Instant | `playPlinko`, `spinSlots`, `castFishing`, `chickenStart` / `chickenStep` / `chickenCashout`, `crashStart` / `crashPoll` / `crashCashout`, `playDice`, `tossCoin`, `spinWheel`, `playKeno`, `playLimbo`, `spinRoulette`, `playDragonTiger`, `playAndarBahar`, `hiloStart` / `hiloGuess` / `hiloCashout`, `minesStart` / `minesReveal` / `minesCashout` |
| Fairness | `gameFairness` (the current commitment), `rotateGameSeed` (reveal the old seed, commit a new one) |
| Housekeeping | `sweepGameMatches` (every minute: timeouts, abandoned waiting tables refunded) |

Every signed-in callable runs the session gate (`assertActiveSession`, cut-off and restriction checks).

## 3. Data

| Path | Who writes | Who reads |
|---|---|---|
| `appConfig/games` | Owner (CRM; rules E4) | everyone (switches, entries) |
| `gameMatches/{id}` | Functions only | any signed-in account (lobby, spectators) |
| `gameMatches/{id}/private/meta` | Functions | nobody (seed, invite code) |
| `gameRounds/{id}` (+ `private/secret`) | Functions | the player |
| `gameSeeds/{uid}` | Functions | nobody directly (`gameFairness`) |
| `gameIdempotency/{uid}_{key}` | Functions | nobody |
| `gameLedger/{id}` | Functions | backend reports (CRM through the API) |
| `users/{uid}/gameHistory/{id}` | Functions | the player, Finance, admins |
| `users/{uid}/diamondTransactions/{id}` | Functions | the player |

Firestore stores no arrays inside arrays: Ludo tokens are stored flat (4 per player) and converted at the boundary;
the slots grid is sent flat (`reels × rows`). The test fake refuses nested arrays and `undefined` exactly as the SDK
does (B6a).

## 4. Match lifecycle (multiplayer)

`waiting` (entries held) → `playing` (turns with a server deadline; a missed turn is claimed by any player or the
sweep; repeated misses forfeit) → `finished` (`checkSettlement` → payout + fee) or `cancelled` (refunds). Leaving
before the start refunds; leaving during play forfeits. Reconnect is a listener on `gameMatches/{id}`.

## 5. App

Games tab (only when at least one game is on) → hub → lobby (prize shown before paying; Teen Patti boot and pot
rules) → table/board screen (Ludo board, Teen Patti table, Carrom board with replayed frames, Snakes, Four in a Row)
or the instant game screen (one composable per game look) → history.
