# ZIPPER — Game competitor research (summary)

Updated 4 Nov 2026. A summary of `research/game-catalogue-research-20261103.md` (desk research of public pages on
3 Nov 2026 — sources, fetch status and caveats are in that file). No new research was done after the owner's
direction to build.

## 1. What the research found

* **Five of the eight requested games have direct catalogue equivalents** at Pragmatic Play and BGaming: crash,
  slots, chicken lane-crossing, plinko and fishing-themed instant games. ZIPPER built its **own** versions (own names,
  art, maths and code) — no provider integration, no contract.
* **Teen Patti, Ludo and Carrom are not in either catalogue**; the market references are Ezugi's Teen Patti, Ludo King
  and Carrom Pool. ZIPPER built all three server-side (Carrom with deterministic server physics).
* **"Fishing" was ambiguous** (cast-and-catch vs fish-shooting arcade). ZIPPER built cast-and-catch (Lucky Catch); a
  fish-shooting arcade would be a separate, larger build.
* **Social fit**: crash is the instant category with documented shared-round social features; Andar Bahar, Dragon
  Tiger, a money wheel and roulette suit shared tables inside rooms; Ludo, Carrom, Teen Patti, Snakes & Ladders and a
  dice duel are the player-vs-player set.

## 2. How the shortlist became the catalogue

| Research shortlist | Built as | Note |
|---|---|---|
| Zip Flight (crash) | `crash` | single-player rounds with cash-out (shared rounds are a later step) |
| Mela Reels (slots) | `slots` | 3 × 3, festival symbols |
| Teen Patti | `teen_patti` | 2–6 seats, server-held hands |
| Lane Hopper (chicken road) | `chicken_road` | 20 lanes |
| Peg Drop (plinko) | `plinko` | 8 / 12 / 16 rows, three risks |
| Lucky Catch (fishing) | `fishing` | cast-and-catch |
| Ludo | `ludo` | 2 / 4 / 6 players (owner's request: 6 as well) |
| Carrom | `carrom` | 2 / 4 players, Freestyle |
| Andar Bahar, Dragon Tiger | `andar_bahar`, `dragon_tiger` | single-player rounds |
| Zip Wheel | `wheel` (Fortune Wheel) | |
| Gem Grid | `mines` (Gem Field) | |
| Dice Duel | `dice` (Lucky Dice) + `coin_toss` (Toss Up) | |
| Roulette | `roulette` | single zero |
| — | `snakes`, `four_row`, `keno`, `limbo`, `hilo` | ZIPPER's own picks for the 20 (two more friendly matches, three quick games) |
| Tambola, Blackjack 21, Zip Scratch | not built | candidates for a later round |

## 3. Carried over from the research

* Working titles need trademark clearance before launch.
* The research notes its own compliance caveat about provider terms of use (see the file).
* The legal background is summarised in `ZIPPER-LEGAL-RISK-REGISTER.md`; every game ships switched off.
