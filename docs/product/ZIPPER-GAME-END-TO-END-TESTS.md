# ZIPPER — Game end-to-end tests

Updated 4 Nov 2026. What is proved today (server unit tests, executed) and the emulator walk each game still needs
(not run: the Mac build channel is stopped and the app is uncompiled).

## 1. Server tests (executed, sandbox, 4 Nov 2026 — all pass; Functions 2127/2127)

| Suite | Tests | Proves |
|---|---|---|
| `ludoEngine` | 22 | moves, captures, safe squares, home stretch, 6-player board, stored (flat) ↔ live state |
| `gameMatches` | 20 | create/join/quick/private/leave/rematch, entries held, refunds before start, forfeit after, settlement 100+100 → 150/50, timeouts and the sweep, idempotent replays |
| `teenPatti` | 25 | hand ranking, deal, blind/seen, chaal/raise/pack/show, pot limit, every bet a ledger row, forfeit, own-cards-only |
| `carrom` | 19 | deterministic physics, pockets, fouls, Freestyle scoring, frames packed for replay |
| `boardGames` | 16 | Snakes & Ladders rolls, snakes/ladders, misses; Four in a Row drops, wins in four directions, draw shares the pool, second miss forfeits |
| `instantGames` | 19 | crash/plinko/slots/fishing/chicken: RTP ≤ 1 − edge, stake/win rows, cash-outs, idempotency, switches |
| `moreGames` | 27 | dice, coin, wheel, keno, limbo, roulette, Dragon Tiger, Andar Bahar, Higher or Lower, Gem Field: tables exact or simulated, flows |
| `gameDailyLimit` | 6 | the daily loss limit: IST day, net of wins/refunds, refused with nothing moved, new day resets, match entries too |
| backend `test_b6_games_report` | — | the CRM money panel totals and the per-match zero-difference list (incl. Teen Patti bets) |
| CRM `gamesConfigGuard.spec` | 30 | Owner-only rule, clamps, defaults OFF, daily loss limit field |

## 2. Emulator walk per game (pending)

For every one of the 20 games, on the LOCAL stack with the seed's switches on:

1. **Switch**: game off in the CRM → it disappears from the hub and a stale screen's entry is refused; back on → it
   returns. Maintenance → new entries refused, a running match/round finishes.
2. **Entry/stake**: a valid entry plays; an amount outside the options/min–max is refused; a short balance is refused
   with nothing moved; a double tap (same idempotency key) moves money once.
3. **Play to the end**: the result screen matches the server's result; the wallet history shows the entry/stake and
   payout/win rows; `gameHistory` has the row.
4. **Multiplayer only**: two (and 4/6 for Ludo) emulator accounts; quick match and private table with invite code;
   a player who leaves before start is refunded; one who leaves during play forfeits; a missed turn is claimed;
   app killed and reopened mid-match → reconnects to the same state; rematch.
5. **Step games** (Zip Flight, Lane Hopper, Higher or Lower, Gem Field): cash out mid-round; network cut before the
   cash-out answer → the round's state on return is the server's.
6. **Ledger and CRM**: the CRM money panel's totals for the session equal the sum of the ledger rows; the
   zero-difference list is empty.
7. **Daily loss limit**: set a small limit in the CRM → play until refused; the refusal names the limit; the next IST
   day plays again.
8. **Fairness**: `gameFairness` commitment shown; `rotateGameSeed` reveals a seed whose SHA-256 equals the old
   commitment.

A game passes only when all of its steps pass on the emulator with the ledger and CRM in agreement.
