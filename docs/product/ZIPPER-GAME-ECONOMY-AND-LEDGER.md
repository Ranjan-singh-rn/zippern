# ZIPPER — Game economy and ledger

Updated 4 Nov 2026. Source of truth: `functions/src/games/ledger.ts`, `matches.ts`, `instant.ts`, `config.ts`.

## 1. The economy the owner asked for

Players buy diamonds, then spend them on calls, gifts — and games. A friendly match pools the entries; the winner
takes the pool less Zipper's table fee (100 + 100 → 150 to the winner, 50 to Zipper at 25 %). A quick game is a stake
against the house; over many rounds it returns `100 % − house edge` to players. Every game is OFF until the Owner
switches it on.

## 2. Every movement, two rows

| Kind | When | Player row `users/{uid}/diamondTransactions/{id}` | Business row `gameLedger/{id}` |
|---|---|---|---|
| `entry` | joining a match | `game_{match}_entry` (−) | `{match}_{uid}_entry` |
| `refund` | match cancelled / abandoned before start | `game_{match}_refund` (+) | `{match}_{uid}_refund` |
| `payout` | match won (or shared on a draw) | `game_{match}_payout` (+) | `{match}_{uid}_payout` |
| `fee` | match settled | — | `{match}_fee` |
| `stake` | an instant round starts | `game_{round}_stake` (−) | `{round}_{uid}_stake` |
| `win` | an instant round pays (no row for a loss) | `game_{round}_win` (+) | `{round}_{uid}_win` |

Teen Patti's several bets per player carry a sequence suffix (`_{seq}`). Ids are deterministic: a replayed
settlement collides with the first rather than paying twice, and the match/round state machine refuses a second
settlement before any write.

## 3. The invariants

* **Zero difference per match**: Σ entries = Σ payouts + fee (+ Σ refunds when cancelled) — `checkSettlement` runs
  **before** any settlement write; a non-zero difference throws and nothing is paid.
* **Rounding**: `splitPool` gives any remainder to the fee, never to a player (a player can never be paid a fraction
  that was not in the pool).
* **Return to player**: every instant table is built from the edge so its return ≤ 1 − edge (tests check each).
* **No client balance writes**: the wallet moves only inside the server transaction; the history row and the
  business row are written in that same transaction.
* **Idempotency**: every start/entry carries an idempotency key (`gameIdempotency/{uid}_{key}`); a retried tap gets
  the first answer.
* **Fairness**: commit–reveal — the server's seed is committed (SHA-256) before play, draws are HMAC-derived per
  round (`rng.ts`); `rotateGameSeed` reveals the old seed so a player can verify every round it produced
  (`gameFairness` shows the current commitment).

## 4. Limits

`appConfig/games.limits.maxEntryPerRound` (default 100,000) caps any single entry/stake. `dailyLossLimit` (default 0
= off; set on the CRM Games page) caps what a player may lose at games in one IST day, net of wins and refunds: a new
entry or stake past it is refused with `DAILY_LOSS_LIMIT` and nothing moves (counters `gameDayKey` /
`gameDayStaked` / `gameDayWon` on the user document, moved in the same transaction; `gameDailyLimit.test.js`).
Bets inside a Teen Patti hand already joined count toward the day but are not refused mid-hand. Entries outside a
game's options or min–max are refused (`BAD_ENTRY`).

## 5. Reporting and reconciliation

The backend `GET /api/reports/games` (Owner/Finance) totals entries, payouts, fees, stakes, wins and refunds per game
and per day from `gameLedger`, and lists any match whose rows do not reconcile to zero (there should be none).
Unit-tested: `test_b6_games_report` (including Teen Patti's multiple bets).
