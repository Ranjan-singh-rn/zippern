# ZIPPER Games area: game catalogue research (Pragmatic Play, BGaming, plus the original crash and chicken titles)

**Research date:** 3 November 2026. Every source in section 9 was opened, or attempted, on this date.
**Prepared for:** ZIPPER product owner and product team.
**Scope:** the 8 requested games, plus 12 proposed ZIPPER-original concepts (20 in total). Every concept is grounded in a real category or title published by Pragmatic Play or BGaming. ZIPPER will build its own games, with original art, names, maths and code. It will not integrate either provider; no contract or API exists. This file covers mechanics and categories only.
**Method:** desk research of public web pages only: provider game pages, category listings, sitemaps, news releases, terms pages, app-store listings and Indian government text.
- No demo game was played or recorded and no account was created.
- Nothing behind a login was accessed, and no block was bypassed.
- Pages were read with an automated fetch tool, partly by parallel research sub-tasks working to the same rules.
- Catalogue coverage was checked against the providers' category listings [P1][P6][P13][B2][B4][B5][B6][B7][B8][B9] and sitemaps [P12][B3].

**How to read this file**

- **Source tags:**
  - `[P#]` Pragmatic Play
  - `[B#]` BGaming
  - `[O#]` the original titles (Spribe, InOut) and other market references
  - `[L#]` legal sources
  - `[R#]` ZIPPER repo files

  Section 9 lists each one with its URL and fetch status.
- **Figures** (RTP, volatility, max win, release date) are copied exactly as the provider's page prints them. "n.p." means not published on the page we read. Pragmatic Play pages print an RTP but no volatility.
- **`UNVERIFIED`** means we could not confirm a claim from the publisher's own page. **`†`** means the figure appears only on unofficial or third-party pages.
- **Mechanics:** every mechanic description is our own summary, not provider text.
- **Working titles** (Zip Flight, Lane Hopper, and so on) are placeholders. Run trademark clearance before using any of them.
- **This is not legal advice.**

## Contents

1. Summary
2. The 20-game shortlist
3. The 8 requested games and their real comparables
4. The 12 proposed additional games
5. Per-game notes
6. India: provider availability, licensing and the 2025 Act
7. Common build rules (server authority, fairness, naming)
8. Considered but not selected
9. Sources
10. Gaps, unverified items and fetch problems
11. Appendix A: evidence table (every real title cited)

---

## 1. Summary

- **Five of the eight requested games have direct equivalents in the two catalogues.**

  | Requested game | Pragmatic Play | BGaming |
  |---|---|---|
  | Crash | Spaceman, High Flyer, Big Bass Crash | Dragon's Crash, Space XY |
  | Slots | Sweet Bonanza, Gates of Olympus | Elvis Frog in Vegas |
  | Chicken lane-crossing | Chicken+ | Chicken Rush 2 |
  | Plinko | Plinko+ | Plinko, Plinko 2 |
  | Fishing-themed | Big Bass Crash | Fishing Club 1 and 2 |

  Sources: [P2][P3][P4][P5][P7][P8][P14][P15][B10][B11][B13][B14][B15][B16][B17][B28].
- **Neither provider publishes Teen Patti, Ludo or Carrom.**
  - Nearest for Teen Patti: Pragmatic's live Andar Bahar, Casino Hold'em and Dragon Tiger.
  - Nearest for Ludo: Pragmatic's Snakes & Ladders Live and Dice City.
  - Carrom: nothing comparable.
  - Market references outside the two catalogues: Ezugi's Teen Patti [O5], Gametion's Ludo King [O6] and Miniclip's Carrom Pool [O7].
- **"Fishing" is ambiguous.** Both catalogues offer only these kinds of fishing game:
  - cast-and-catch instant games
  - a fishing-themed crash game or slot
  - a fishing-themed wheel game

  We found no fish-shooting arcade game. The product owner should confirm which kind is meant.
- **Among RNG and instant games, crash is the only category where the providers document social features.** Those features are chat, leaderboards, round statistics across all players and shared rounds [P2][P4][B11]. Every arcade and instant game we read is single-player. Pragmatic's live game shows and its bingo rooms (which have a chat host) are shared by design [P24][P34].
- **Best social fits for ZIPPER:**
  - shared-round tables that can run inside live/party rooms: Andar Bahar, Dragon Tiger, the money wheel, Tambola (bingo) and roulette
  - player-vs-player games: Ludo, Carrom, Teen Patti, Snakes & Ladders, Dice Duel and Toss Up
- **16 of the 20 games are pure chance.** Teen Patti, Ludo and Blackjack mix chance and skill; Carrom is mostly skill. But the skill/chance split does **not** decide legality in India:
  - The Promotion and Regulation of Online Gaming Act, 2025 has been in force since 1 May 2026.
  - It prohibits any online game played by paying money or "other stakes" in expectation of winnings, "irrespective of whether such game is based on skill, chance, or both".
  - "Other stakes" expressly includes virtual coins bought with money [L1].
  - ZIPPER's own `APP_KNOWLEDGE.md` says users' diamonds, bought for rupees, "are their chips directly" in the casino games [R1]. That design needs legal review before any game in this file launches (section 6.4).
- **No public restricted-territory list.** Neither provider publishes one on its website.
  - Pragmatic Play launched two India-focused live products in 2021: Andar Bahar and Roulette India [P29].
  - BGaming's catalogue filter of certified markets does not list India [B2].
  - We found no public statement from either provider about India or the 2025 Act. That is a negative search result, not proof.
- **Compliance note on this research.**
  - BGaming's Terms of Use (effective 1 November 2025) forbid two things that apply here:
    - using "bots, scrapers, or automation tools to collect data"
    - using demo games or website content "for benchmarking, competitor analysis, or development of derivative works" [B33]
  - Pragmatic Play's Terms of Use license its service for non-commercial use only. They also bar obtaining information by methods Pragmatic has not permitted [P35].
  - This research read public pages with an automated tool. We stopped all further automated access to bgaming.com once we saw these terms.
  - **Ask legal whether this file can be used as it is.**

---

## 2. The 20-game shortlist

Games 1 to 8 were requested by the product owner; games 9 to 20 are proposed here.

| # | Working title | Category | Players | Chance or skill | Pure chance? | Complexity |
|---|---|---|---|---|---|---|
| 1 | Zip Flight (requested: Aviator/Crash) | Crash, shared round | Many players, one shared round | Chance; the player only picks when to cash out | **YES** | L |
| 2 | Mela Reels (requested: Slots) | Slots | Single | Chance | **YES** | M |
| 3 | Teen Patti (requested) | 3-card table game | Multi-seat table, PvP | Mixed (chance + betting decisions) | NO | L |
| 4 | Lane Hopper (requested: Chicken Road) | Lane-crossing step game | Single | Chance; stop-or-continue choice | **YES** | S |
| 5 | Peg Drop (requested: Plinko) | Peg-board drop | Single | Chance | **YES** | S |
| 6 | Lucky Catch (requested: Fishing) | Fishing, cast-and-catch | Single | Chance | **YES** | S (L if fish-shooting) |
| 7 | Ludo (requested) | Dice board race | 2–4 PvP | Mixed (dice + move choice) | NO | L |
| 8 | Carrom (requested) | Physics board game | 1v1 (2v2 option) | Mostly skill | NO | L |
| 9 | Andar Bahar | Indian card game, shared round | Shared round | Chance | **YES** | M |
| 10 | Dragon Tiger | Two-card comparison, shared round | Shared round | Chance | **YES** | S |
| 11 | Zip Wheel | Money wheel | Shared round | Chance | **YES** | S |
| 12 | Tambola | 90-ball bingo (housie) rooms | Room multiplayer | Chance | **YES** | L |
| 13 | Gem Grid | Mines | Single | Chance; stop choice | **YES** | S |
| 14 | Dice Duel | Dice | Single or 1v1 | Chance | **YES** | S |
| 15 | Roulette | Roulette | Single or shared table | Chance | **YES** | M |
| 16 | Blackjack 21 | Card game vs dealer | Single, optional shared dealer table | Mixed (decisions change expected return) | NO | M |
| 17 | Zip Scratch | Scratch card | Single | Chance | **YES** | S |
| 18 | Toss Up | Coin flip | 1v1 or vs house | Chance | **YES** | S |
| 19 | Snakes & Ladders | Dice board race | 2–4 PvP | Chance | **YES** | M |
| 20 | Super Over | Cricket-themed instant pick | Single | Chance | **YES** | S |

**Complexity key** (relative effort, not a time estimate):
- **S:** single-player, one server draw and one settlement, light UI.
- **M:** multi-step rules or a timed shared round, more UI and maths work.
- **L:** real-time multiplayer state or turn sync, hidden information, physics, or a room-and-ticket system that needs anti-cheat.

**Integration approach for all 20:** an original in-house build. ZIPPER owns the art, names, maths and code, and integrates no provider. A server-side outcome service and wallet ledger decide every result (section 7). The Android client only renders. This fits the current pattern of WebView games hosted on Firebase, whose results are written server-side [R1].

---

## 3. The 8 requested games and their real comparables

| Requested game, ZIPPER title | Real comparables (provider: title) [source] | Core mechanic (our summary) | Players | Round lifecycle | Published RTP / volatility (as printed) | Must be server-authoritative |
|---|---|---|---|---|---|---|
| **1. Aviator/Crash: Zip Flight** | Spribe: **Aviator** [O1][O2]<br>Pragmatic Play: **High Flyer** [P4], **Spaceman** [P3] (also Big Bass Crash [P5])<br>BGaming: **Dragon's Crash** [B11] (also Space XY [B10]) | A multiplier climbs during a live round and stops at a random moment (the "crash"). Players cash out before then to lock in the current multiplier; anything not cashed out is lost. Variants: two bets per round (High Flyer, Dragon's Crash), auto cash-out, and cashing out 50% while the rest rides (Spaceman). | Shared round for all players. Pragmatic documents chat, leaderboards and all-player round statistics [P2][P4]. Dragon's Crash shows every player's bets and results [B11]. Aviator's multiplayer features are UNVERIFIED from a Spribe page. | Betting window → launch → rising multiplier with manual or auto cash-outs → crash → settle, then history/stats → next round | Aviator: UNVERIFIED (Spribe's page renders no text; 97% only in third-party reviews †)<br>High Flyer 97.00% [P4]<br>Spaceman 95% [P3]<br>Big Bass Crash 95.50% [P5]<br>Dragon's Crash 97%, volatility High [B11]<br>Space XY 97% [B10] | Crash point fixed before betting closes, ideally hash-committed. Round phases on the server clock. Bets accepted only inside the window. A cash-out counts only if the server receives it before the crash time; the multiplier shown on the phone is cosmetic. Auto cash-out runs on the server. Wallet debits/credits and the max-win cap. Live-bets feed and leaderboard built from server data. |
| **2. Slots: Mela Reels** | Pragmatic Play: **Sweet Bonanza** [P14], **Gates of Olympus** [P15]<br>BGaming: **Elvis Frog in Vegas** [B28] | Stake and spin. Symbols land on a grid and pay on lines (Elvis Frog: 25 lines) or "anywhere" clusters with tumbling refills (Sweet Bonanza, Gates of Olympus). Scatters start free spins with multipliers. | Single-player | Stake → spin → evaluate → cascades → bonus or free spins → settle | Sweet Bonanza 96.48% [P14]<br>Gates of Olympus 96.50% [P15]<br>Elvis Frog in Vegas 95.3%, Medium-high [B28] | Reel strips, pay table and RTP config live on the server. The server picks every stop, including cascades and bonus rounds; the client only animates. Each spin is one atomic wallet transaction. Bonus and free-spin state is stored server-side. Maths checked by large-scale simulation before release. |
| **3. Teen Patti: Teen Patti** | **None in either catalogue.** Not found in Pragmatic's live index and sitemaps [P24] or in BGaming's ~350-game sitemap [B3].<br>Nearest, Pragmatic Play: **Andar Bahar** (live, Indian card game) [P24][P29], **Casino Hold'em** (live poker against the dealer) [P32], **Dragon Tiger** [P24]<br>Market reference: Ezugi **Teen Patti** / **Bet on Teen Patti** [O5] | ZIPPER concept: each seat gets 3 cards, ranked like three-card poker (Ezugi's "Bet on Teen Patti" is also based on the best three-card hand [O5]). Players bet in turn, fold, or call a show; the best hand wins the pot. | Multi-seat PvP table (seat count is a design choice) | Sit down → boot/ante → deal → timed betting turns → fold or show → showdown → pot settles | Not applicable (PvP; no comparable publishes one) | Shuffle and deal with a CSPRNG. Each hand goes only to its owner; no one else's cards reach a client before the show. The server validates turn order, timers and every action. Pot accounting. Showdown evaluation. Collusion and bot detection. Rules for reconnecting and auto-fold. |
| **4. Chicken Road: Lane Hopper** | InOut Games: **Chicken Road** [O3: site unreachable][O4]<br>Pragmatic Play: **Chicken+** [P7]<br>BGaming: **Chicken Rush 2** [B15] | Pick a difficulty and a stake, then cross lanes one step at a time. Each safe step raises the multiplier, and after each step you cash out or continue. A hit ends the round and the stake is lost. Reaching the far side pays the top multiplier. Chicken Rush 2 adds random multi-lane jumps and multiplier boosts. | Single-player | Choose level and stake → step → safe (cash out / continue) or hit (lose) → end | Chicken Road: UNVERIFIED (official site timed out; 98% only on unofficial pages †)<br>Chicken+ 97.50% [P7]<br>Chicken Rush 2 97.00%, Medium-low, max x2,505 [B15] | Every lane's outcome is generated on the server, committed per round or per step. Multiplier ladder per difficulty comes from server config. Future lanes are never sent to the client. Cash-out and settlement on the server, with idempotent step requests. |
| **5. Plinko: Peg Drop** | BGaming: **Plinko** [B13], **Plinko 2** [B14]<br>Pragmatic Play: **Plinko+** [P8] | Choose the number of rows (8–16) and a risk level, then drop one or more balls through a peg pyramid. The bucket each ball lands in sets its multiplier; edges pay most. | Single-player | Set rows, risk and stake → drop → land → pay; auto mode repeats | Plinko 99%, max x1,000 [B13]<br>Plinko 2 99%, Low, max x10,000 [B14]<br>Plinko+ 97.50%, max 1,000x on high risk [P8] | The server picks each ball's final bucket from the odds table for those rows and that risk. The client animation must end in that bucket; physics on the phone never decides the result. Pay table on the server; each ball settled separately. |
| **6. Fishing: Lucky Catch** | BGaming: **Fishing Club** [B16], **Fishing Club 2** [B17]<br>Pragmatic Play: **Big Bass Crash** [P5] (fishing-themed crash)<br>(Also BGaming Fishing Time [B18], a wheel game, and Pragmatic's Big Bass Bonanza slot [P16]) | Cast-and-catch: pick a risk level (shown as bait) and a stake, then cast. You either catch a fish worth a multiplier or catch nothing. Big Bass Crash is a crash round with a fishing theme. **Neither catalogue has a fish-shooting arcade game.** | BGaming: single-player. Big Bass Crash: shared round with leaderboards and chat [P5]. | Choose risk and stake → cast → outcome → pay | Fishing Club 97.16%, Medium Low, max x3,000 [B16]<br>Fishing Club 2 97.16%, Medium (intro text says Medium-low) [B17]<br>Big Bass Crash 95.50% [P5] | Catch result and multiplier decided on the server. For a fish-shooting version, the server also decides hits and kills, per-fish odds and shot costs, and blocks auto-clickers. |
| **7. Ludo: Ludo** | **None in either catalogue** [B3][P24].<br>Nearest board/dice, Pragmatic Play: **Snakes & Ladders Live** [P27], **Dice City** [P28]<br>BGaming: **Dice Clash** [B21] (dice vs dice)<br>Market reference: Gametion **Ludo King** [O6] | ZIPPER concept: roll a die, move one of your tokens, capture opponents; first to bring all tokens home wins. Ludo King offers 2–6 player online games, a Snakes & Ladders mode, tournaments and text/voice chat [O6]. | 2–4 PvP (Ludo King allows up to 6) | Matchmaking → timed turns (roll → choose token → move/capture) → finishing order → result | Not applicable | Dice rolls. Legal-move checks. Full game state. Turn timers and auto-move. Disconnect and rejoin. Bots must be disclosed. Match result and rewards. |
| **8. Carrom: Carrom** | **None in either catalogue.**<br>BGaming's tap-to-shoot casual games (**Kicker Mania** [B30], **Penalty Duel** [B29]) match only the theme: their outcomes come from stated odds, not physics or aim.<br>Market reference: Miniclip **Carrom Pool: Disc Game** [O7] | ZIPPER concept: place the striker, aim, set power and flick to pocket your pieces. Foul and queen rules apply; first to clear the board wins. Carrom Pool offers 1v1 matches with friends in Freestyle, Carrom and Disc Pool modes [O7]. | 1v1 (2v2 option) | Match → turns (place → aim → shoot → pieces settle → score or foul) → win | Not applicable | Physics is authoritative: the server simulates each shot, or replays it deterministically from the shot inputs. Scoring and fouls. Turn timers. Results reported by the client are never trusted. Reconnect handling. |

---

## 4. The 12 proposed additional games

**Selection rules:**
- Each game must appear in Pragmatic Play's or BGaming's **live** catalogue (checked 3 Nov 2026).
- Social or quick-round formats are preferred, and overlap with the 8 requested games is kept low.
- Integration for all of them: **an original in-house build** (section 2).

| # | Working title | Grounded in (provider: real title) [source] | Mechanic (our summary) | Players | Integration notes | Complexity | Chance / skill | Pure chance? |
|---|---|---|---|---|---|---|---|---|
| 9 | **Andar Bahar** | Pragmatic Play: **Andar Bahar** (live) [P24][P29] | A joker card is shown. Players bet whether the matching card turns up first on the Andar (inside) pile or the Bahar (outside) pile, and cards are dealt to the two piles until it does. | Shared timed round for everyone at the table | Shared-round table service; can run in live/party rooms with the host as "dealer" | M | Chance. Pragmatic itself calls it a game of pure chance [P24]. | **YES** |
| 10 | **Dragon Tiger** | Pragmatic Play: **Dragon Tiger** (live) [P24][P30] and **Dragon Tiger** (RNG) [P20] | One card goes to Dragon and one to Tiger. Bet on the higher card, or on a tie. | Shared round | Reuses the #9 table service; fastest card round | S | Chance | **YES** |
| 11 | **Zip Wheel** | Pragmatic Play: **Mega Wheel** (live) [P24][P25]<br>BGaming: **Fortune Spin** [B23] | Back one or more number values on a big wheel; when the wheel stops on a number you backed, that number's multiplier pays. Pragmatic adds a random boosted "lucky number" each round. BGaming's version is a single-player multiplier wheel. | Shared round, e.g. a host-triggered spin in a party room (design choice) | Shared-round service | S | Chance | **YES** |
| 12 | **Tambola** (housie) | Pragmatic Play: **Bingo** product (90/80/75/50/30-ball and Speed Bingo; Chat Host feature) [P34]; **The Bingo Spot** (live) [P26] | Each player holds number tickets. Numbers are called and marked automatically, and prizes go to set patterns (for example early five, lines and full house; the prize set is a design choice). | Room-based multiplayer with scheduled games | Room scheduler, ticket generator, claim validator, host/caller role | L | Chance | **YES** |
| 13 | **Gem Grid** | Pragmatic Play: **Mines+** [P9]<br>BGaming: **Minesweeper** [B19] | Choose how many hidden hazards sit on a grid, then reveal tiles one at a time. Each safe tile raises the multiplier and you can cash out at any point; a hazard ends the round. | Single-player | Shares the step-ladder engine with #4 | S | Chance; the only choice is when to stop | **YES** |
| 14 | **Dice Duel** | BGaming: **Dice Clash** [B21], **Rocket Dice** [B22]<br>Pragmatic Play: **Mega Sic Bo** (live) [P24][P31] | Two sides roll dice and the higher total wins (Dice Clash), or you bet over/under a chosen number (Rocket Dice). | Single vs house, or 1v1 challenge with a friend (design choice) | Challenges sent from chat | S | Chance | **YES** |
| 15 | **Roulette** | Pragmatic Play: **Roulette** (RNG, single zero) [P18]<br>BGaming: **European Roulette** [B24] (+ French/American/Royal 500X [B9]) | Place chips on numbers or groups of numbers; one spin of a single-zero wheel decides. | Single, or a shared table round | Shared-round option | M (many bet types) | Chance | **YES** |
| 16 | **Blackjack 21** | Pragmatic Play: **Multihand Blackjack** [P17]<br>BGaming: **Speed Blackjack Pro** [B25] | Play one or more hands against the dealer. Hit, stand, double or split to beat the dealer's total without going over 21. | Single (several hands); optional shared dealer table with seats | Rules engine and card shoe | M | Mixed: player decisions change the expected return | NO |
| 17 | **Zip Scratch** | Pragmatic Play: scratchcards, e.g. **Panda Gold**, **7 Piggies**, **Wolf Gold** [P21][P22][P23]<br>BGaming: **Ice Scratch Gold** [B27] + Scratch category [B8] | Get a card, scratch 9 cells; three matching values win. | Single-player | Could double as a daily-reward drop | S | Chance | **YES** |
| 18 | **Toss Up** | BGaming: **Heads and Tails** [B20] | Call heads or tails and the coin is flipped; a correct call pays a fixed multiple (BGaming's pays 1.98x). | 1v1 PvP or vs house (design choice) | Challenge from chat or profile | S | Chance | **YES** |
| 19 | **Snakes & Ladders** | Pragmatic Play: **Snakes & Ladders Live** [P27] | ZIPPER concept: roll a die and move along a numbered board. Ladders lift you, snakes drop you, and the first to reach the end wins. Pragmatic's live game is a wheel show with a snakes-and-ladders board bonus; Ludo King has a Snakes & Ladders mode [O6]. | 2–4 PvP | Shares the board/turn engine with Ludo (#7) | M | Chance; no player decisions | **YES** |
| 20 | **Super Over** | BGaming: **Penalty Duel** [B29], **Kicker Mania** [B30] | A cricket version of BGaming's penalty duel. Choose batter or bowler, then pick a target showing its multiplier and odds; one server draw decides. | Single (leaderboards optional) | Simple instant round | S | Chance: BGaming describes no aim or timing skill [B29] | **YES** |

**Of the 12 proposals, 11 are pure chance; only Blackjack 21 is not.** The providers' catalogues are almost entirely chance games, so a skill-led line-up would have to come from outside them, as Ludo and Carrom do.

---

## 5. Per-game notes

### 1. Zip Flight (crash)
- **What the comparables show:**
  - Pragmatic's crash games offer optional chat, statistics from past rounds, biggest-bet leaderboards, autoplay and auto cash-out [P2].
  - High Flyer adds two bet spots and shows round details across all players, plus the multiplier distribution of the last 500 rounds [P4].
  - Spaceman added the 50% cash-out [P3].
  - BGaming's Dragon's Crash shows every player's bets and results in the shared round [B11].
  - Space XY plots the flight on X/Y axes and allows several bets per round [B10].
- **Aviator** was first introduced in 2019. Its multiplier rises as the plane takes off, and players decide when to cash out by pressing "Cashout" [O2]. Its RTP and social features are UNVERIFIED because Spribe's page renders no readable text [O1].
- **ZIPPER angle:** run one shared flight per live/party room, so everyone sees each other's cash-outs as they happen. The host can commentate.
- **Watch-outs:**
  - Do not use the name "Aviator", a red-plane look, or any provider layout.
  - Cash-out timing must be judged by the server; show a "pending" state while it confirms.
  - Publish the round history and fairness hashes.

### 2. Mela Reels (slots)
- Start with a minimum viable product: a 5x3 line slot with one free-spins feature. A "pay anywhere" cascade variant can follow; Pragmatic's best-known titles use that format [P14][P15].
- RTP is a configuration choice. Verify it by simulation, and show players a clear help screen.
- **Do not engineer near-misses.** `APP_KNOWLEDGE.md` §2.7 lists "near-misses, streak bonuses" as a design intent [R1]. The 2025 Act's preamble names "manipulative design features, addictive algorithms" as a harm [L1].

### 3. Teen Patti
- **Neither provider has it.**
  - Pragmatic's nearest products are live Andar Bahar (one of two India-focused products released on 6 Oct 2021) [P29], live Casino Hold'em (poker against the dealer, launched 18 Jun 2025) [P32] and Dragon Tiger [P24].
  - Ezugi (a separate studio) launched a live Teen Patti in November 2019 and "Bet on Teen Patti" in June 2020, with Hindi and Tamil support [O5].
- **ZIPPER angle:** private tables with friends, public tables with spectators, and gifting to players at the table, which ties into ZIPPER's existing gift system.
- **Watch-outs:**
  - Hidden-information security: never send another player's cards to a client.
  - Collusion detection (same device or network, chip dumping).
  - Disclose any bots.
- **Classification:** mixed chance and skill. The legal position depends on stakes (section 6).

### 4. Lane Hopper (Chicken Road style)
- **Comparables:**
  - Pragmatic Chicken+ has four risk levels (Easy, Medium, Hard, Daredevil), each with a different number of lanes and crash odds [P7].
  - BGaming Chicken Rush 2 has Easy/Medium/Hard/Hardcore plus random "rush" jumps and egg boosts [B15].
- InOut Games is publicly described as the studio behind Chicken Road, which press coverage calls a crash game [O4]. Its own site could not be reached [O3], so the game's parameters are UNVERIFIED.
- **BGaming's other "chicken" titles are not lane-crossing games** [B32]:
  - Chicken Rush and Chicken Fire are reel slots.
  - Chicken Shot and Chicken Halloween are tap-to-shoot games with stated odds.

  Use Chicken Rush 2 as the BGaming comparable.
- **ZIPPER angle:** an original mascot and setting (not a chicken or a road look-alike), such as a monsoon street.
- **Build:** shares the step-ladder engine with Gem Grid (#13).

### 5. Peg Drop (Plinko style)
- **Comparables:**
  - BGaming Plinko: 8–16 lines, three risk levels, manual or auto play, a record table, and a provably fair claim in the page FAQ [B13].
  - BGaming Plinko 2: 1–100 balls per drop plus paid extras [B14].
  - Pragmatic Plinko+: 8–16 lines, three risk levels, max 1,000x [P8].
- **Use an original name.** "Plinko" is used as a game title by several publishers.
- The client draws a path seeded by the server so that it ends in the bucket the server already picked.

### 6. Lucky Catch (fishing)
- **Confirm with the product owner which kind of fishing game is meant:**
  - **(a) Cast-and-catch.** BGaming Fishing Club offers five risk levels shown as bait [B16]; Fishing Club 2 adds locations and paid bonus games [B17].
  - **(b) Fishing-themed crash.** Pragmatic's Big Bass Crash has leaderboards and chat [P5].
  - **(c) Fish-shooting arcade.** Not found in either catalogue; complexity L, and hit resolution must be server-side.
- BGaming's Fishing Time is a wheel game with a fishing theme [B18].

### 7. Ludo
- **No provider equivalent.** The main market reference is Ludo King [O6]: 2–6 player online games, a Snakes & Ladders mode, 8-player tournaments, text/voice chat and offline play against the computer.
- **ZIPPER angle:** voice in the room, spectators, gifts, friend invites from the chat list.
- **Build:** a shared board/turn engine with Snakes & Ladders (#19). Plan for disconnects (auto-move after timeout) and disclose bots.

### 8. Carrom
- **No provider equivalent.** The market reference is Carrom Pool: Disc Game (Miniclip) [O7]:
  - 1v1 multiplayer, play with friends, three modes and offline practice
  - unlockable strikers
  - the App Store lists "Loot Boxes" and says the game includes random paid items
- **Avoid paid random items that can be converted to value** (see the definition of "other stakes" in section 6.3).
- **The hardest build here.** Use deterministic physics with the server validating each shot (aim, power, striker position), and never trust results reported by the client.

### 9. Andar Bahar
- Pragmatic's live index describes Andar Bahar as one of the most popular games in India and a game of pure chance with 50/50 odds [P24]. The 2021 release added poker-style side bets [P29].
- **ZIPPER angle:** an animated dealer with timed betting windows inside party rooms. It is a strong cultural fit for India.

### 10. Dragon Tiger
- Pragmatic describes it as a two-card version of baccarat [P24] and a "multi-player card game" [P30]. Its RNG version prints an RTP of 96.27% [P20].
- It is the fastest card round, so it suits short rooms. It shares the table service with Andar Bahar.

### 11. Zip Wheel
- Pragmatic's Mega Wheel has 54 segments showing the numbers 1, 2, 5, 8, 10, 15, 20, 30 and 40 [P24], plus a random "Mega Lucky Number" boost of up to 500x [P25].
- BGaming's Fortune Spin offers four wheels (easy to daredevil) on which empty sectors are removed until a win [B23].
- The ZIPPER competitor research notes that party-room wheel, number and race rounds are common in rival apps (see `competitor-research-20261103.md` §1) [R2].

### 12. Tambola
- Pragmatic's Bingo product [P34]:
  - 90-, 80-, 75-, 50- and 30-ball games and Speed Bingo
  - a mobile-first fast format (Bingo Blast)
  - a multilingual Chat Host feature, and mini-games playable inside the bingo room
- The Bingo Spot is Pragmatic's live bingo game show [P26].
- **ZIPPER angle:** "Tambola nights" in party rooms, with the host calling numbers, automatic marking and automatic checking of claims. Keep prizes non-monetary (section 6.4).

### 13. Gem Grid
- Pragmatic Mines+ uses a 5x5 grid with 1–24 mines. Its printed RTP is 97.50%, and the page says some combinations of player choices return up to 98.28% [P9].
- BGaming's Minesweeper is a column-by-column variant, 98.4% [B19].

### 14. Dice Duel
- **Comparables:**
  - BGaming Dice Clash: the chosen volatility sets how many dice each side rolls [B21].
  - BGaming Rocket Dice: over/under a number from 2 to 12, with an optional double-or-nothing step [B22].
  - Pragmatic's live Mega Sic Bo: three dice with random "Mega Multipliers" of up to x1000 [P24][P31].
- **ZIPPER angle:** "challenge a friend" from chat.

### 15. Roulette
- Pragmatic's RNG Roulette uses a single-zero wheel at 97.30% [P18]. BGaming has European (97.3%), French, American and Royal Roulette 500X [B9][B24].
- Keep a simple bet layout for a minimum viable product, and add a shared-table mode for rooms.

### 16. Blackjack 21
- Pragmatic Multihand Blackjack: up to four hands from an 8-deck shoe; RTP printed as "99.62% (3/10)" with no explanation [P17].
- BGaming Speed Blackjack Pro: 1–3 hands, side bets, optional strategy hints, 99.38% [B25].
- This is the only proposal in which player decisions change the outcome.

### 17. Zip Scratch
- Pragmatic's seven scratchcards are match-3 games whose pages show an empty RTP field [P21][P22][P23].
- BGaming's Ice Scratch Gold prints 90%, Very high, max x100,000 [B27]. Its scratch listing shows mostly 90% / Very high titles [B8].
- **Turbo mode skips the scratching entirely** [B27], so the scratching is purely presentation.

### 18. Toss Up
- BGaming Heads and Tails prints 99% RTP and a 1.98x payout [B20].
- It fits a light "toss for it" challenge between friends, ideally with nothing of value at stake (section 6.4).

### 19. Snakes & Ladders
- Pragmatic's Snakes & Ladders Live page describes a 54-segment wheel with "Board" bonus rolls on an 8x8 snakes-and-ladders board and a "Totem" climbing bonus [P27].
- 2023 trade coverage described a four-dice format; that format is UNVERIFIED (section 10).
- Ludo King includes a Snakes & Ladders mode [O6].
- Build it on the Ludo engine.

### 20. Super Over
- Adapted from BGaming's Penalty Duel (96.14%; choose kicker or goalkeeper, then pick a multiplier target) [B29] and Kicker Mania (97.00%; each ball shows its chance to win) [B30].
- A cricket theme suits India. It remains pure chance.

---

## 6. India: provider availability, licensing and the 2025 Act

### 6.1 Pragmatic Play
- **Terms of Use** (Version 1.0, 19 Feb 2021; page modified 22 Apr 2026) [P35]:
  - no list of restricted territories
  - use of the service "is void where prohibited under local legislation"
  - players must be 18, or the local legal gambling age if higher
  - governed by Malta law
- **Licences shown:**
  - The Live Casino page shows UK and MGA licences, plus certifications for the UK, MGA, Italy, Sweden, Denmark, Romania and Bulgaria [P24].
  - The About Us page says Pragmatic is certified or licensed in over 30 jurisdictions [P36].
- **India-focused products:** a release dated 6 Oct 2021 rolled out **Andar Bahar** and **Roulette India**, described as Indian-focused live products [P29]. Roulette India is not listed on the current live index [P24]; its current status is unknown.
- **No public restricted-territory list** was found on pragmaticplay.com (terms, about, live and bingo pages checked).
- **No public Pragmatic statement on India or the 2025 Act** was found by web search on 3 Nov 2026. This negative result is UNVERIFIED.

### 6.2 BGaming
- **Operator:** Stable Games Ltd (Malta). It holds MGA B2B Critical Gaming Supply Licence MGA/B2B/785/2020, issued 18 Mar 2021, and says it supplies only business-to-business, not consumer gambling [B2][B33].
- **Terms of Use** (effective 1 Nov 2025; page modified 24 Apr 2026) [B33]:
  - no territory list, and India is not mentioned
  - lawful use only
  - governed by Malta law
  - demo games may not reflect real-money odds or RTP (§8.2)
- **Catalogue "Certified" filter:** it lists the following markets, and **India is not among them** [B2]:
  - Africa, Asia, Belarus, Brazil, Bulgaria, Colombia, Denmark, Estonia, Europe
  - Georgia, Greece, IO, Italy, Latam, Lithuania, MGA, Netherlands, Peru
  - Portugal, Romania, Slovakia, Spain, Sweden, Switzerland, Worldwide
- **Integration page:** game availability and market rules are configured per market, and operators supply their target markets and licensing/geo rules before launch [B35]. No India mention.
- **No public BGaming statement on India** was found.

### 6.3 Indian law: the Act and the Rules
- **The Act:** Act No. 32 of 2025, assented 22 Aug 2025, **in force since 1 May 2026** (notification S.O. 1994(E), 22 Apr 2026) [L1].
- **Reach:** it applies to online money gaming services offered in India, including those operated from outside India (s.1(2)) [L1].
- **Key definitions** (s.2(1)) [L1]:
  - **Online money game** (g): an online game, "irrespective of whether such game is based on skill, chance, or both", played by paying fees or depositing money or other stakes in expectation of winning money or other enrichment. E-sports are excluded.
  - **Other stakes** (j): anything equivalent or convertible to money, which "includes credits, coins, token or objects … whether it is real or virtual, which is purchased by paying money directly or by indirect means", or as part of or in relation to an online game.
  - **Online social game** (i): involves no staking and no expectation of monetary gain. It may charge a subscription or one-time access fee as long as that fee is not a stake, and it is offered for entertainment, recreation or skill development.
- **Prohibitions and penalties** [L1]:
  - prohibited: offering online money games (s.5), advertising them (s.6) and facilitating payments for them (s.7)
  - offering one carries up to 3 years in prison and/or a fine of up to ₹1 crore (s.9(1))
  - offences under s.5 and s.7 are cognizable and non-bailable (s.10)
  - the Authority can decide whether a particular game is an online money game (s.8(2)(a))
- **The Rules:** the Promotion and Regulation of Online Gaming Rules, 2026 also came into force on 1 May 2026. Government news describes a complete ban on online money games, plus a registration system for certain categories of games with age verification, time limits and parental controls [L2]. We did not review the full text of the Rules (section 10).

### 6.4 What this means for the 20 games (not legal advice)
- **The chance/skill flags in this file are design and risk labels only.** The Act prohibits skill-based and chance-based money games alike.
- **The diamonds-as-chips design is the main risk.** `APP_KNOWLEDGE.md` prices diamonds in rupees (₹2,290 = 1,00,000 diamonds, sold through coin sellers) and says "User's diamonds are their chips directly" for casino games [R1]. If that is still the design, staking diamonds to win diamonds in any of the 20 games appears to fit the Act's definition of an online money game. That file was last modified in Aug 2026; confirm the current economy.
- **A free-to-play design is closer to the Act's "online social game"**, for example:
  - nothing bought with money is staked
  - there is no cash-out or conversion to money
  - rewards are cosmetic or otherwise non-convertible

  Confirm this with counsel, and check whether ZIPPER must register its games under the 2026 Rules.
- The sibling file `competitor-research-20261103.md` §4 has more on India's regulatory history and app blocking [R2].

---

## 7. Common build rules (all 20 games)

1. **Outcomes come from the server.**
   - What the server decides: every random outcome, using a CSPRNG. That covers crash points, lanes and tiles, buckets, reel stops, shuffles, dice, wheel stops and number draws.
   - What the client does: only render. It never decides an outcome.
2. **Fairness you can show (recommended).** Commit to a hash of each round's server seed before the round and reveal the seed afterwards, so players can verify results. BGaming's provably-fair page describes the same pattern: a SHA-256 hash of the round result plus a secret is published in advance and combined with a seed the player sets [B34].
3. **Wallet ledger.** Every stake and settlement is a server-side, idempotent, append-only ledger entry. Reject any amount or outcome sent by the client. `APP_KNOWLEDGE.md` already requires game results to be written server-side [R1].
4. **Clock and state.** Round phases, betting windows and turn timers all run on the server clock. Bets that arrive late are rejected.
5. **Configuration.** Pay tables, odds, RTP targets and win caps are versioned server config with an audit trail, and are simulated before release.
6. **Multiplayer.**
   - authoritative state on the server
   - private information (cards) goes only to its owner
   - reconnect and timeout rules
   - bots disclosed
   - collusion and multi-account detection
7. **Responsible design.**
   - Odds and multipliers shown truthfully; no engineered near-misses ([R1] vs [L1]).
   - Session and time limits, and age checks; the 2026 Rules reportedly require these for registered games [L2], UNVERIFIED in detail.
8. **Names and IP.**
   - Do not reuse provider titles (Aviator, Chicken Road, Plinko+, Mega Wheel and so on), art, sounds, UI layouts or text.
   - Both providers' terms assert rights over titles, characters, artwork and site content [P35][B33].
   - We assume traditional game names (Ludo, Carrom, Teen Patti, Andar Bahar, Dragon Tiger, Roulette, Blackjack, Tambola, Snakes & Ladders) are generic. Confirm this in trademark clearance.

---

## 8. Considered but not selected

| Candidate | Where it is (verified) | Why not selected |
|---|---|---|
| Limbo (set a target multiplier, single reveal) | Pragmatic Limbo+ [P10]; BGaming Limbo XY [B31] | Overlaps with crash; no social element |
| Tower climb | Pragmatic Spire+ [P11] | Third step-ladder game after Lane Hopper and Gem Grid |
| Baccarat | Pragmatic Baccarat 98.76% [P19]; BGaming Classic Baccarat 98.76% [B26] | Dragon Tiger covers the same "bet on the winning hand" idea and is faster |
| Colour-and-dice game | Pragmatic Color Game Bonanza (live) [P37] | Overlaps with Dice Duel and Zip Wheel |
| Live poker (Casino Hold'em) | Pragmatic Casino Hold'em (live) [P32] | Teen Patti covers poker hands for India; kept as its reference |
| Balloon pump | BGaming Balloon Mania [B36] | Overlaps with crash and step games |
| Animal/number lottery | BGaming Jogo do Bicho [B37] | Lottery format; poor social fit; separate legal questions |
| Aviamasters | BGaming [B12] | Marketed as a crash game, but the page describes no mid-round cash-out; Dragon's Crash is the better comparable |
| **Keno, Hi-Lo, Pump** | Pragmatic **Keno+, HiLo+, Pump+** were announced for its arcade in the Q4 2026 roadmap (24 Sep 2026) [P33], but are absent from the arcade sitemap [P12] | **Not yet in the live catalogue**, so excluded under the rules for this research |
| Keno, Hi-Lo, Video poker, Bingo, Andar Bahar, Dragon Tiger, Teen Patti, Ludo, Carrom (BGaming) | No matching slugs in BGaming's ~350-game HTML sitemap [B3] | Not published by BGaming |

---

## 9. Sources (all checked 3 Nov 2026)

Status key: **opened** = page fetched and read; **opened, no text** = the page loaded but its content is rendered in the browser, so no text came back; **not fetched** = timed out or returned empty.

**Pragmatic Play**

- [P1] https://www.pragmaticplay.com/en/games/ (slots listing): opened
- [P2] https://www.pragmaticplay.com/en/home/crash-games/: opened
- [P3] https://www.pragmaticplay.com/en/games/spaceman/: opened
- [P4] https://www.pragmaticplay.com/en/games/high-flyer/: opened
- [P5] https://www.pragmaticplay.com/en/games/big-bass-crash/: opened
- [P6] https://www.pragmaticplay.com/en/arcade/: opened
- [P7] https://www.pragmaticplay.com/en/arcade/chicken/: opened
- [P8] https://www.pragmaticplay.com/en/arcade/plinko/: opened
- [P9] https://www.pragmaticplay.com/en/arcade/mines/: opened
- [P10] https://www.pragmaticplay.com/en/arcade/limbo/: opened
- [P11] https://www.pragmaticplay.com/en/arcade/spire/: opened
- [P12] https://www.pragmaticplay.com/arcades-sitemap.xml (5 arcade titles; last updated 2026-07-23): opened
- [P13] https://www.pragmaticplay.com/en/other-rng/: opened (only the first page of titles is listed)
- [P14] https://www.pragmaticplay.com/en/games/sweet-bonanza-slot/: opened. /en/games/sweet-bonanza/ returned empty.
- [P15] https://www.pragmaticplay.com/en/games/gates-of-olympus/: opened
- [P16] https://www.pragmaticplay.com/en/games/big-bass-bonanza/: opened
- [P17] https://www.pragmaticplay.com/en/games/multihand-blackjack/: opened
- [P18] https://www.pragmaticplay.com/en/games/roulette/: opened
- [P19] https://www.pragmaticplay.com/en/games/baccarat/: opened
- [P20] https://www.pragmaticplay.com/en/games/dragon-tiger-rng/: opened
- [P21] https://www.pragmaticplay.com/en/games/panda-gold-scratchcard/: opened
- [P22] https://www.pragmaticplay.com/en/games/7-piggies-scratchcard/: opened
- [P23] https://www.pragmaticplay.com/en/games/wolf-gold-scratchcard/: opened
- [P24] https://www.pragmaticplay.com/en/live-casino/ (index, with the Andar Bahar, Dragon Tiger, Mega Wheel and Mega Sic Bo descriptions): opened
- [P25] https://www.pragmaticplay.com/en/live-casino/mega-wheel/: opened
- [P26] https://www.pragmaticplay.com/en/live-casino/the-bingo-spot/: opened
- [P27] https://www.pragmaticplay.com/en/live-casino/snakes-ladders-live/: opened
- [P28] https://www.pragmaticplay.com/en/live-casino/dice-city/: opened
- [P29] https://www.pragmaticplay.com/en/news/pragmatic-play-rolls-out-two-new-indian-focused-live-casino-products/ (6 Oct 2021): opened
- [P30] https://www.pragmaticplay.com/en/news/pragmatic-play-welcomes-a-new-live-casino-title-dragon-tiger/ (27 Apr 2021): opened
- [P31] https://www.pragmaticplay.com/en/news/pragmatic-play-launches-a-new-live-casino-game-mega-sic-bo/ (13 Jul 2020): opened
- [P32] https://www.pragmaticplay.com/en/news/pragmatic-play-launches-first-in-a-series-of-live-poker-games/ (18 Jun 2025): opened
- [P33] https://www.pragmaticplay.com/en/news/pragmatic-play-unveils-star-studded-q4-content-lineup/ (24 Sep 2026): opened
- [P34] https://www.pragmaticplay.com/en/bingo/: opened
- [P35] https://www.pragmaticplay.com/en/terms-of-use/ (Version 1.0, 19 Feb 2021): opened
- [P36] https://www.pragmaticplay.com/en/about-us/: opened
- [P37] https://www.pragmaticplay.com/en/live-casino/color-game-bonanza/: opened

**BGaming**

- [B1] https://bgaming.com/ (homepage): **not fetched**. It timed out after 180 s and was not retried after we read §6.1 of BGaming's terms.
- [B2] https://bgaming.com/games (catalogue, filters, licence footer): opened on the second attempt
- [B3] https://bgaming.com/sitemap (HTML sitemap, about 350 game URLs): opened. https://bgaming.com/sitemap_index.xml returned empty.
- [B4] https://bgaming.com/game-type/casual?types=casual: opened
- [B5] https://bgaming.com/game-type/cards?types=cards: opened
- [B6] https://bgaming.com/game-type/dice?types=dice: opened
- [B7] https://bgaming.com/game-type/lottery?types=lottery: opened
- [B8] https://bgaming.com/game-type/scratch?types=scratch: opened on the second attempt
- [B9] https://bgaming.com/game-type/roulette?types=roulette: opened
- [B10] https://bgaming.com/games/space-xy: opened
- [B11] https://bgaming.com/games/dragons-crash: opened
- [B12] https://bgaming.com/games/aviamasters: opened
- [B13] https://bgaming.com/games/plinko: opened
- [B14] https://bgaming.com/games/plinko-2: opened
- [B15] https://bgaming.com/games/chicken-rush-2: opened
- [B16] https://bgaming.com/games/fishing-club: opened
- [B17] https://bgaming.com/games/fishing-club-2: opened
- [B18] https://bgaming.com/games/fishing-time: opened
- [B19] https://bgaming.com/games/minesweeper: opened
- [B20] https://bgaming.com/games/heads-and-tails: opened
- [B21] https://bgaming.com/games/dice-clash: opened
- [B22] https://bgaming.com/games/rocket-dice: opened
- [B23] https://bgaming.com/games/fortune-spin: opened
- [B24] https://bgaming.com/games/european-roulette: opened
- [B25] https://bgaming.com/games/speed-blackjack-pro: opened
- [B26] https://bgaming.com/games/classic-baccarat: opened (listing data only)
- [B27] https://bgaming.com/games/ice-scratch-gold: opened
- [B28] https://bgaming.com/games/elvis-frog-in-vegas: opened
- [B29] https://bgaming.com/games/penalty-duel: opened
- [B30] https://bgaming.com/games/kicker-mania: opened
- [B31] https://bgaming.com/games/limbo-xy: opened
- [B32] https://bgaming.com/games/chicken-rush , https://bgaming.com/games/chicken-shot , https://bgaming.com/games/chicken-halloween , https://bgaming.com/games/chicken-fire: opened
- [B33] https://bgaming.com/terms-of-use (effective 1 Nov 2025): opened
- [B34] https://bgaming.com/provably-fair: opened
- [B35] https://bgaming.com/games-integration: opened
- [B36] https://bgaming.com/games/balloon-mania: opened
- [B37] https://bgaming.com/games/jogo-do-bicho: opened

**Original titles and market references**

- [O1] https://spribe.co/games/aviator: **opened, no text** (the content is rendered in the browser)
- [O2] https://igamingbusiness.com/company-news/a-long-awaited-takeoff-spribes-popular-aviator-game-now-available-on-totogaming-am/ (iGB company news, 14 Jan 2026): opened
- [O3] https://inout.games/ , https://www.inout.games/ , https://inout.games/games/chicken-road: **not fetched** (all three timed out)
- [O4] https://affpapa.com/inout-games-drop-their-first-ever-slot-meet-chicken-royal/ (press release, 29 Sep 2025): opened
- [O5] https://casinobeats.com/2020/06/17/ezugi-expansion-plans-in-full-swing-with-20-20-teen-patti-launch/ (17 Jun 2020): opened
- [O6] https://play.google.com/store/apps/details?id=com.ludo.king&hl=en (Ludo King, Gametion): opened. https://ludoking.com/ was **not fetched** (timeout).
- [O7] https://apps.apple.com/us/app/carrom-pool-disc-game/id1420551478 (Carrom Pool: Disc Game, Miniclip): opened

**Legal**

- [L1] https://www.indiacode.nic.in/bitstream/123456789/22148/1/a2025-32.pdf (The Promotion and Regulation of Online Gaming Act, 2025, text as on 5 May 2026): opened
- [L2] https://newsonair.gov.in/promotion-regulation-of-online-gaming-rules-2026-comes-into-force/ (All India Radio, 1 May 2026): opened

**ZIPPER repo**

- [R1] `APP_KNOWLEDGE.md` (repo root; §2.2 diamond pricing, §2.7 casino game logic; last modified 21 Aug 2026): read
- [R2] `docs/product/research/competitor-research-20261103.md` (§1 summary, §4 India regulatory notes): read

---

## 10. Gaps, unverified items and fetch problems

**Could not be fetched**

- **bgaming.com homepage [B1]:** timed out. We used the /games catalogue, category pages, game pages and HTML sitemap instead.
- **inout.games [O3]:** timed out three times. Chicken Road details come only from press coverage [O4].
- **spribe.co Aviator page [O1]:** loaded but returned no text. Aviator details come from iGB [O2].
- **ludoking.com:** timed out. We used the Google Play listing [O6].
- **Other empty responses:**
  - the gamblinginsider.com Spribe profile, and the sigma.world and europeangaming.eu press-release pages
  - Pragmatic URLs /en/games/sweet-bonanza/, /en/live-casino/andar-bahar/, /en/live-casino/mega-sic-bo/ and /en/games/keno/, for which we used alternative pages or the index plus press releases

**Unverified**

- Aviator's RTP (97% †) and its chat and live-bets features, from a Spribe-owned page.
- Chicken Road's RTP (98% †) and its difficulty names.
- Snakes & Ladders Live format. Pragmatic's page describes a wheel with a board bonus [P27], while 2023 trade coverage (InterGame) described a four-dice format; unresolved.
- Whether Roulette India is still available.
- The full Pragmatic "Other RNG" list. The "Load More" button could not be enumerated; Dragon Tiger RNG [P20] exists, but whether it is listed under Other RNG is unconfirmed.
- The BGaming listing pages show only their first page; hidden counts are higher (for example, "38" for scratch). Negative findings (no Teen Patti, Ludo or Carrom) rely on BGaming's HTML sitemap and Pragmatic's live index and sitemaps. They are strong evidence but not proof.
- The detailed content of the 2026 Rules (we used a government news summary [L2]).
- No public statement from either provider on India or the 2025 Act was found.

**Inconsistencies on provider pages** (reported as printed)

- BGaming Aviamasters 2: volatility "Medium" vs "medium-low" in its FAQ.
- BGaming Fishing Club 2: "Medium" vs "Medium-low".
- BGaming Always Up!: max multiplier x559 vs x599.
- Pragmatic Multihand Blackjack: RTP printed as "99.62% (3/10)" with no explanation.
- Pragmatic scratchcard pages: the RTP field is printed but empty.

**Research-method caveat:** see the compliance note in section 1, which covers BGaming ToU §6.1 and Pragmatic's ToU licence limits [B33][P35].

---

## 11. Appendix A: evidence table (every real title cited)

| Provider | Title | Section on provider site | Source | RTP (printed) | Volatility (printed) | Max win / multiplier (printed) | Release (printed) | Social signals on page |
|---|---|---|---|---|---|---|---|---|
| Spribe | Aviator | Crash | [O1][O2] | UNVERIFIED (97% †) | n.p. | n.p. | First introduced 2019 [O2] | UNVERIFIED |
| Pragmatic Play | Spaceman | Crash; Other RNG | [P3][P2] | 95% | n.p. | up to 5,000x [P2] | n.p. | Statistics, leaderboards, game history |
| Pragmatic Play | High Flyer | Crash; Other RNG | [P4] | 97.00% | n.p. | up to 1,000,000x | n.p. | Round stats across all players, leaderboard, optional chat |
| Pragmatic Play | Big Bass Crash | Crash | [P5][P2] | 95.50% | n.p. | up to €500,000 [P2] | n.p. | Leaderboards, multiplayer chat |
| BGaming | Dragon's Crash | Casual | [B11] | 97% | High | x10000; €250,000 | Mar 07, 2024 | Shared round: all players' bets and results |
| BGaming | Space XY | Casual | [B10] | 97% | n.p. | x10000; €250,000 | Jan 13, 2022 | Multiple bets per round; auto cash-out |
| Pragmatic Play | Sweet Bonanza | Slots | [P14] | 96.48% | n.p. | n.p. | n.p. | Single-player |
| Pragmatic Play | Gates of Olympus | Slots | [P15] | 96.50% | n.p. | n.p. | n.p. | Single-player |
| Pragmatic Play | Big Bass Bonanza | Slots | [P16] | 96.71% | n.p. | n.p. | n.p. | Single-player |
| BGaming | Elvis Frog in Vegas | Slots | [B28] | 95.3% | Medium-high | x2500; €250,000 | May 13, 2020 | Single-player |
| Pragmatic Play | Andar Bahar | Live Casino | [P24][P29] | n.p. | n.p. | n.p. | Released 6 Oct 2021 | Live table |
| Pragmatic Play | Casino Hold'em | Live Casino | [P32] | n.p. | n.p. | Jackpot side bet up to 20,000x | Launched 18 Jun 2025 | Live table vs dealer |
| Pragmatic Play | Dragon Tiger (live) | Live Casino | [P24][P30] | n.p. | n.p. | n.p. | Released 27 Apr 2021 | "Multi-player card game" |
| Pragmatic Play | Dragon Tiger (RNG) | /en/games/ | [P20] | 96.27% | n.p. | n.p. | n.p. | Single-player |
| Ezugi (not PP/BG) | Teen Patti; Bet on Teen Patti | Live | [O5] | n.p. | n.p. | n.p. | Nov 2019; Jun 2020 | Live; Hindi and Tamil |
| InOut Games | Chicken Road | Crash/step | [O3][O4] | UNVERIFIED (98% †) | n.p. | n.p. | n.p. | UNVERIFIED |
| Pragmatic Play | Chicken+ | Arcade | [P7] | 97.50% | n.p. | n.p. | n.p. | Single-player |
| BGaming | Chicken Rush 2 | Casual | [B15] | 97.00% | Medium-low | x2505; €250,500 | Jul 30, 2026 | Single-player |
| BGaming | Plinko | Casual | [B13] | 99% | n.p. | x1000 | Jan 28, 2019 | Single-player; record table |
| BGaming | Plinko 2 | Casual | [B14] | 99% | Low | x10000; €250,000 | Jan 08, 2025 | Single-player |
| Pragmatic Play | Plinko+ | Arcade | [P8] | 97.50% | n.p. | 1,000x (high risk) | n.p. | Single-player |
| BGaming | Fishing Club | Casual | [B16] | 97.16% | Medium Low | x3000; €240,000 | Jun 11, 2024 | Single-player |
| BGaming | Fishing Club 2 | Casual | [B17] | 97.16% | Medium (also "Medium-low") | x3000; €255.000 (as printed) | Apr 07, 2026 | Single-player |
| BGaming | Fishing Time | Casual | [B18] | 96.00% | Low-high | x1000 | Jun 11, 2026 | Single-player |
| Pragmatic Play | Snakes & Ladders Live | Live Casino | [P27] | n.p. | n.p. | 10,000x | n.p. | Live game show |
| Pragmatic Play | Dice City | Live Casino | [P28] | n.p. | n.p. | Bonus games up to 10,000x | n.p. | Shared round implied |
| BGaming | Dice Clash | Dice | [B21] | 98.05% | Medium-low | x46; €230,000 | Nov 05, 2024 | Single-player |
| Gametion (not PP/BG) | Ludo King | Google Play | [O6] | n/a | n/a | n/a | Updated Nov 2, 2026 | 2–6 online players, tournaments, text/voice chat |
| BGaming | Kicker Mania | Casual | [B30] | 97.00% | Low | x64; €256,000 | Jun 30, 2026 | Single-player |
| BGaming | Penalty Duel | Casual | [B29] | 96.14% | Medium | x4860; €243,000 | Jul 03, 2025 | Single-player |
| Miniclip (not PP/BG) | Carrom Pool: Disc Game | App Store | [O7] | n/a | n/a | n/a | n.p. | 1v1 multiplayer, play with friends |
| Pragmatic Play | Mega Wheel | Live Casino | [P24][P25] | n.p. | n.p. | Up to 500x | n.p. | Live game show |
| BGaming | Fortune Spin | Casual | [B23] | 98% | Medium | x10000; €250,000 | Sep 02, 2025 | Single-player |
| Pragmatic Play | Bingo (product) | Bingo | [P34] | n.p. | n.p. | n.p. | n.p. | Multiplayer rooms; Chat Host |
| Pragmatic Play | The Bingo Spot | Live Casino | [P26] | n.p. | n.p. | Up to 20,000x per ticket | n.p. | Live game show |
| Pragmatic Play | Mines+ | Arcade | [P9] | 97.50% (up to 98.28% for some choices) | n.p. | n.p. | n.p. | Single-player |
| BGaming | Minesweeper | Casual | [B19] | 98.4% | n.p. (FAQ: low) | n.p. (FAQ: up to x15.11) | Apr 02, 2016 | Single-player |
| BGaming | Rocket Dice | Dice | [B22] | 99% | Low | €3530 (FAQ: up to x35.30) | Oct 22, 2018 | Single-player |
| Pragmatic Play | Mega Sic Bo | Live Casino | [P24][P31] | n.p. | n.p. | Up to x1000 | Released 13 Jul 2020 | Live table |
| Pragmatic Play | Roulette | Other RNG | [P18] | 97.30% | n.p. | n.p. | n.p. | Single-player |
| BGaming | European Roulette | Roulette | [B24] | 97.3% | n.p. | n.p. (FAQ: up to x35) | Apr 02, 2016 | Single-player |
| Pragmatic Play | Multihand Blackjack | Other RNG | [P17] | 99.62% (3/10) | n.p. | n.p. | n.p. | Single-player |
| BGaming | Speed Blackjack Pro | Cards | [B25] | 99.38% | n.p. | x101; €252,500 | Oct 29, 2026 | Single-player |
| Pragmatic Play | Panda Gold / 7 Piggies / Wolf Gold Scratchcard | Other RNG | [P21][P22][P23] | Field empty | n.p. | Top prize 10,000 / 5,000 / 1,000,000 (unit not stated) | n.p. | Single-player |
| BGaming | Ice Scratch Gold | Scratch | [B27] | 90% | Very high | x100000; €250000 | Dec 14, 2023 | Single-player |
| BGaming | Heads and Tails | Casual | [B20] | 99% | n.p. | Pays 1.98x | Apr 02, 2016 | Single-player |
