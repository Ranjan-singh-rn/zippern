# ZIPPER — Gaming product spec

Updated 4 Nov 2026. The owner's direction (3 Nov 2026), verbatim in spirit: players buy diamonds and use them for
calls, gifts and games; some rounds they win diamonds, some they lose; friendly matches like Ludo and Carrom for 2,
4 or 6 players where, for example, two players put in 100 each, the winner gets 150 and Zipper keeps 50; plus
Aviator-style, slots, Teen Patti, Chicken Road, Plinko, Fishing and more — 20 games. Every game has an Owner switch.

## 1. Product shape

* **Games tab** appears only when the Owner has switched at least one game on.
* **Friendly matches** (Ludo, Carrom, Teen Patti, Snakes & Ladders, Four in a Row): pick a table size and an entry;
  the lobby shows the prize **before** paying ("Win 150"); quick match or a private table with an invite code;
  rematch after the result.
* **Quick games** (15): pick a stake; the result is decided by the server the moment you play (or step by step for
  Zip Flight, Lane Hopper, Higher or Lower, Gem Field, with a cash-out button); the return to players is shown
  (100 % − edge).
* **History**: every match and round with what it cost and paid.
* **Fairness**: the commitment for the next rounds is shown before play; rotating the seed reveals the old one.

## 2. Rules that protect players and Zipper

| Rule | Why |
|---|---|
| Server-authoritative moves and results | a modified app cannot choose its dice, cards or crash point |
| Entries held by the match; refund before start, forfeit after | nobody loses an entry to a table that never started |
| Turn deadlines with server claims; repeated misses forfeit | a player who walks away cannot freeze the table |
| Pool split with the remainder to the fee | the pool always balances to zero |
| Global per-round cap; daily loss limit (Owner sets it; 0 = off) | bounded exposure per player per day |
| Every game OFF by default; maintenance switch | the Owner decides what is live, instantly |

## 3. What is not in scope

No cash-out from games (winnings are diamonds), no third-party game provider, no real-money deposits through games.

## 4. Status

Server: implemented and unit-tested for all 20 (see `ZIPPER-GAME-END-TO-END-TESTS.md`). App: written, not yet
compiled. CRM: implemented, typecheck clean. All games ship OFF; the local test copy switches them on.
