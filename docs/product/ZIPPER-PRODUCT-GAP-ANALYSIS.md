# ZIPPER — Product gap analysis (Track B, Android)

Updated 4 Nov 2026. Working copy `~/Documents/Projects/zippern`, branch `v5-scratch`, HEAD `cf64145`; nothing
committed, pushed or deployed. Status words as in `ZIPPER-IMPLEMENTATION-TRACKER.md`: **Implemented** (code in the
tree) · **Unit-tested** (automated tests pass) · **Emulator-tested** · **Device-tested** · **Production-verified**.

The mission (sections 1–13, 17) is set against what the code did on 3 Nov 2026 and what it does now. "Gap" is what is
still missing after this round, and why.

## 1. Mission areas

| § | Area | Found (3 Nov) | Now | Remaining gap / blocker |
|---|---|---|---|---|
| 1 | Competitor research | none in repo | `research/competitor-research-20261103.md`, `research/game-catalogue-research-20261103.md`, matrix in `ZIPPER-COMPETITOR-FEATURE-MATRIX.md` | — (no further research by owner direction) |
| 2 | Video calls + face verification | per-minute billing, Agora tokens, face capture flow existed (Track A QA) | free-call cards pay the first minute (B2c); calls refused while the peer hosts a room with calls off (B7) | **Physical device** for genuine liveness and real Agora media; emulator cannot prove either |
| 3 | Party room | seats, sit/lock, admins, PIN (hashed), kick | lobby lifecycle (no close while people listen), Party Pro ₹200/30 days at level 7, PIN lockout per person, access log, official access, 7 themes, calls-off switch, gift travel animation, profile card, licensed music catalogue | App **uncompiled**; **no licensed tracks** in the catalogue yet (Owner) |
| 4 | Party profile card | basic | level, follow, message, gift, report, block | uncompiled |
| 5 | Live streaming | start/end, gifts, kick, PK screens | pause/resume, camera off, pinned message, connection state, chat mute, block, host comment delete, host level, server viewer count + peak, sweep of abandoned rooms, **PK made workable** (server callables), PK score from settled gifts, live-gift checks, server-measured duration, server end card with transactions (B12) | uncompiled; co-host/multi-guest seats not built (PK only) |
| 6 | Rankings + rewards | per-room top supporters only | Top 50 hosts / supporters (lucky gifters off), daily/weekly/monthly IST, Owner reward tiers, idempotent settlement, ledger + promo rows | uncompiled app screen |
| 7 | Coin-seller business | Zipper→seller cards, seller→user sales, staff lending | tiers, seller-to-seller trades (dispute, Finance/Owner), credit limits, borrow requests, self-use switch, profit report; two money bugs fixed (B9) | uncompiled purchase-request fix |
| 8 | Account switching | "Switch account" was a sign-out; one saved credential | up to 5 accounts per device, device-bound credentials, switch without the visual login, Add/Remove, per-account forgetting, per-device-key cap (B10) | uncompiled |
| 9 | Daily rewards + audit | rewards and free cards invisible to Finance | `promoCredits` with deterministic ids, promotions report (B2c), ranking rewards counted (B8) | — |
| 10 | Games | nothing in the app | 20 server-authoritative games, every one behind an Owner switch, **all OFF by default** (B3–B6) | uncompiled app; enabling is the Owner's decision (see legal register) |
| 11 | CRM roles | verified in Track A (29/29 E2E) | new Owner-only pages: Games, Leaderboards, Party Pro, Room music (Tech), Seller trades (Finance/Owner) | CRM typecheck 0, 47 scripts pass |
| 12 | ZIPPER-specific features | — | §2 below | proposals |
| 13 | Mandatory E2E | Track A only | journeys listed in `ZIPPER-END-TO-END-TEST-REPORT.md` | **blocked on the Mac build channel** (local stack stopped) |
| 17 | Gaming module | — | see the `ZIPPER-GAME-*` documents | uncompiled app |

## 2. ZIPPER-specific proposals (§12)

Each is sized against the existing architecture. Implemented ones are marked.

| Proposal | User value | Business value | Cost | Risk | Status |
|---|---|---|---|---|---|
| Party Pro (private rooms) subscription | private rooms with a PIN, access log | recurring ₹200/30 days | done | low | **Implemented (B7)** |
| Seasonal / ranking events with Owner tiers | something to aim for each day/week/month | spend concentration on peaks | done | payouts are real money: Owner sets tiers | **Implemented (B8)** |
| Server end-of-live card with transactions | hosts trust the numbers | fewer earnings disputes | done | none | **Implemented (B12)** |
| Host growth milestones (first 10 h live, first 1 lakh beans) | progress for new hosts | host retention | medium (reuse host stats) | low | proposal |
| Supporter loyalty badges (lifetime gifting tiers) | status for big gifters | retention of whales | medium | low | proposal |
| Scheduled party events (calendar + reminder push) | plan to attend | concentrated traffic | medium | push volume | proposal |
| Clubs / families (persistent groups with a room) | belonging | social lock-in | high | moderation load | proposal |
| Anomaly alerts (gift loops, seller circular trades, sudden bean spikes) | — | fraud loss | medium (backend jobs over existing ledgers) | false positives | partial: circular trades refused (B9) |
| Transparent earnings dashboard for hosts (calls/gifts/rankings per week) | clarity | fewer support tickets | low (data exists) | none | proposal |
| Bundles (Party Pro + diamonds pack) | value | ARPU | low | pricing | proposal |

## 3. What blocks a release (summary)

1. **Every Track B app change is uncompiled.** The Mac build channel (`~/zipper-release/qa/local-stack.command`) is
   stopped; nothing Android can be claimed until `gradle unit` and the emulator build pass.
2. **Emulator E2E** for the Track B journeys has not run (same reason).
3. **Physical device**: face liveness and real Agora calls/lives.
4. **Deployment** (rules E1–E8, the new Functions, indexes) — not done in this phase by instruction.
5. **Owner decisions**: switching games on; music licensing; ranking reward tiers; Party Pro price confirmation.
