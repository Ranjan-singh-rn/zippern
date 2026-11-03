# ZIPPER — Legal risk register

Updated 4 Nov 2026. **Not legal advice.** By the owner's direction (3 Nov 2026) no further legal or regulatory
research was done in this round; the background is the desk research already in
`research/india-legal-research-20261103.md` (sources and dates there). This register only records which switches
exist, what state they ship in, and whose decision turns each one on.

| # | Item | Shipped state | Control | Decision needed before it is switched on |
|---|---|---|---|---|
| L1 | Instant games with diamond stakes (Zip Flight/crash, Mela Reels/slots, Lane Hopper, Peg Drop, Lucky Catch, Dice, Toss Up, Wheel, Keno, Limbo, Roulette, Dragon Tiger, Andar Bahar, Higher or Lower, Gem Field) | **OFF** (each game and the master switch) | `appConfig/games` — Owner-only rule (E4), CRM Games page | Owner; the research file rates staked chance games as the highest exposure |
| L2 | Multiplayer matches with diamond entries and a platform fee (Ludo, Teen Patti, Carrom, Snakes & Ladders, Four in a Row) | **OFF** | same | Owner (Teen Patti is a card game with betting rounds — the same class as L1 in the research) |
| L3 | Lucky gifts | **OFF** | `appConfig/luckyGifts.enabled` — Owner-only (D15) | Owner (standing instruction: keep off) |
| L4 | Ranking rewards paid in diamonds / beans | ON when the Owner sets tiers (default: nothing paid) | `appConfig/leaderboards` — Owner-only | Owner sets tiers; lucky-gifters board stays off with lucky gifts |
| L5 | Party Pro subscription paid in diamonds (₹200 / 30 days) | ON, Owner can switch off | `appConfig/partySubscription` — Owner-only | Owner (pricing and refund wording) |
| L6 | Room music | ON for tracks in the catalogue only | `musicTracks` kept in the CRM (Tech/Owner) | **Licences** for every track added (none in the catalogue yet) |
| L7 | Coin-seller trades, lending and self-use | trades and lending need Finance/Owner action per case; self-use OFF | backend routes + Owner switch | Owner |
| L8 | No cash-out from games | enforced: game winnings are diamonds; nothing converts game diamonds to money directly | ledger kinds `payout` / `win` credit diamonds only | — |

Everything in L1–L3 can be switched off again instantly from the CRM; a switch-off refuses new entries and stakes
on the next request (matches already running finish and settle).
