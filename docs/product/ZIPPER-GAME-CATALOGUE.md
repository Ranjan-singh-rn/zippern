# ZIPPER — Game catalogue (20 games)

Updated 4 Nov 2026. Every game is server-authoritative (the phone sends a move; the server decides and settles),
ships **switched off**, and is switched on per game by the Owner in the CRM (`appConfig/games`). Defaults below are
`functions/src/games/config.ts`; every number is editable in the CRM within safe limits (fee 0–50 %, house edge
0–20 %, 2–6 players, 10–120 s turns).

Status for every game: **Implemented, unit-tested (server)**; app screen written, **not yet compiled**; emulator
E2E pending.

## Friendly matches (multiplayer — entries pooled, winner paid, Zipper keeps the table fee)

| Game | Id | Players | Entries (diamonds) | Fee | Rules in one line | Tests |
|---|---|---|---|---|---|---|
| Ludo | `ludo` | 2 / 4 / 6 | 10, 50, 100, 500, 1000 | 25 % | classic race, 4 tokens home to win (CRM may set 1–4); server dice | ludoEngine 22, gameMatches 20 |
| Carrom | `carrom` | 2 / 4 | same | 25 % | Freestyle scoring to 160 points or 25 shots each; deterministic server physics, frames replayed on the phone | carrom 19 |
| Teen Patti | `teen_patti` | 2–6 | boot 10 | 10 % | boot, blind/seen, chaal/raise/pack/show, pot limit 128× boot, max 4 blinds; hands kept server-side until show | teenPatti 25 |
| Snakes & Ladders | `snakes` | 2 / 3 / 4 | 10 … 1000 | 25 % | Zipper's own board; server dice; first to 100 | boardGames 16 |
| Four in a Row | `four_row` | 2 | 10 … 1000 | 25 % | 7 × 6 grid; a draw shares the pool; a second missed turn forfeits | boardGames |

Worked example (owner's): Ludo, 2 players × 100 → pool 200 → winner **150**, Zipper **50**.

## Quick games (instant rounds — stake against the house, return = 100 % − house edge)

| Game | Id | Stake | Edge | How it plays |
|---|---|---|---|---|
| Zip Flight | `crash` | 10–10,000 | 3 % | the multiplier climbs; cash out before it flies away (max 1000×) |
| Mela Reels | `slots` | 10, 20, 50, 100, 200, 500 | (RTP from table) | 3 × 3 reels, Indian festival symbols, fixed lines |
| Lane Hopper | `chicken_road` | 10–5000 | 3 % | step across 20 lanes; each safe step raises the multiplier; cash out any time |
| Peg Drop | `plinko` | 10–5000 | (RTP from table) | 8 / 12 / 16 rows, three risk levels |
| Lucky Catch | `fishing` | 10, 20, 50, 100, 200 | 4 % | cast a line; the catch table sets the multiplier |
| Lucky Dice | `dice` | 10–10,000 | 3 % | pick a chance and over/under; multiplier = (100 − edge) / chance |
| Toss Up | `coin_toss` | 10–10,000 | 3 % | heads or tails |
| Fortune Wheel | `wheel` | 10–5000 | 3 % | segments by risk level |
| Number Draw | `keno` | 10–5000 | 3 % | pick numbers; paytable by hits |
| Sky High | `limbo` | 10–10,000 | 3 % | pick a target multiplier; win if the result reaches it |
| Roulette | `roulette` | 10–10,000 | 2.7 % | single zero: 36× / 3× / 2× at the zero's own edge |
| Dragon Tiger | `dragon_tiger` | 10–10,000 | 2.94 % | Dragon or Tiger pays 2×; a tie returns half |
| Andar Bahar | `andar_bahar` | 10–10,000 | 3 % | joker card; which side matches first |
| Higher or Lower | `hilo` | 10–5000 | 3 % | guess the next card; each right guess multiplies; cash out any time |
| Gem Field | `mines` | 10–5000 | 3 % | reveal tiles avoiding mines; cash out any time |

Every table's return is checked ≤ 1 − edge by `instantGames` (19) and `moreGames` (27) — exactly where the maths is
closed-form, by simulation where it is not.

## Names

The working titles (Zip Flight, Mela Reels, Lane Hopper, Peg Drop, Lucky Catch, …) are ZIPPER's own; trademark
clearance before launch is listed in the research file.
