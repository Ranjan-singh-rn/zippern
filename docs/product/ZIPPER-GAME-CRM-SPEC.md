# ZIPPER — Game CRM spec

Updated 4 Nov 2026. Page: `zipper-crm/app/app-config/games/page.tsx`; guard `lib/gamesConfigGuard.ts` (+ spec, 27
checks); money panel from the backend `GET /api/reports/games`.

## 1. Who

The **Owner** only (`canAccess(crmUser, ['superadmin'])` on the page, and `firestore.rules` E4: `appConfig/games` is
Owner-only for writes). Finance sees the money panel through the reports API.

## 2. What the Owner controls

| Control | Scope | Limits enforced on save and again on the server |
|---|---|---|
| Master switch | all games | off hides and refuses every game |
| Game switch | per game (20) | default OFF |
| Maintenance | per game | refuses new entries; running matches/rounds finish |
| Entry options / min–max | per game | whole diamonds, 1 … 10,000,000; ≤ the global per-round cap |
| Table sizes (modes) | multiplayer | 2–6, capped per game (Four in a Row 2; Carrom 2/4; Ludo up to 6) |
| Platform fee % | multiplayer | 0–50 |
| Turn time / wait time | multiplayer | 10–120 s / 1–60 min |
| House edge % | instant | 0–20 (0 honoured: an even game) |
| Game settings | per game | e.g. Teen Patti boot / max blinds / pot limit; Carrom target points / shots; Lane Hopper lanes; crash max multiplier |
| Global limits | all | largest entry per round; daily loss limit (0 = off) |

A bad value (a 250 % fee, a negative entry) is not obeyed: the guard refuses the save, and the server clamps anything
stored to the nearest sane value (`mergeGamesConfig`).

## 3. Money panel

Per game and per day: entries, payouts, fees, stakes, wins, refunds, and Zipper's net; plus a list of any match whose
ledger rows do not reconcile to zero (expected: empty).

## 4. Audit

Every save writes `updatedAt` / `updatedBy` on `appConfig/games`; every diamond a game moved is in `gameLedger` with
the match/round id, so a dispute is answered from the ledger, not from a screen.
