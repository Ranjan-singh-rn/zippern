# ZIPPER — Competitor feature matrix

Updated 4 Nov 2026. The competitor columns are summarised from `research/competitor-research-20261103.md` (desk
research of public sources on 3 Nov 2026; every cell there carries its source tag). No further research was done, by
the owner's direction. "Yes / Partial / Unknown" are the research's own words; "Unknown" means not publicly
documented, not absent.

ZIPPER's column says what the code does now: **Impl** = implemented and server-tested, app written but **not yet
compiled**; **Had** = existed before Track B (verified in Track A); **—** = not built.

| Feature | Chamet | HiClub | Recho | Crush | Tango | Bigo | ZIPPER |
|---|---|---|---|---|---|---|---|
| **Live** | | | | | | | |
| Solo video live | Yes | Partial† | Yes | Yes | Yes | Yes | Had |
| PK battles | Yes | Unknown | Yes | Yes | Yes | Yes | **Impl** — server-run (B12; it could not start before) |
| Co-host / guest seats | Partial | Unknown | Partial† | Partial | Yes | Yes | — |
| Moderation (kick / mute / block) | Yes | Unknown | Partial | Partial | Yes | Yes | Kick had; **mute, block, comment delete Impl** (B12) |
| Pause / camera off / pinned message | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | **Impl** (B12) |
| **1-to-1 calls** | | | | | | | |
| Paid per-minute video calls | Yes | Partial† | Yes | Partial | Partial | No | Had |
| Free trial / free-call cards | Yes (90 s) | Unknown | Unknown | Unknown | Unknown | No | **Impl** — a card pays the first minute (B2c) |
| **Party rooms** | | | | | | | |
| Voice + video rooms | Yes | Unknown | Yes | Yes | Yes | Yes | Had |
| Seat lock / close | Partial | Unknown | Unknown | Unknown | Unknown | Yes | Had |
| Private / password rooms | Unknown | Unknown | Unknown | Unknown | Yes | Unknown | **Impl** — Party Pro, PIN lockout, access log (B7) |
| Themes | Partial | Unknown | Unknown | Partial | Unknown | Partial | **Impl** — 7 themes (B7) |
| Room music | Unknown | Unknown | Yes | Unknown | Unknown | Yes | **Impl** — licensed catalogue only (B7) |
| Admin roles | Unknown | Unknown | Unknown | Unknown | Yes | Yes | Had |
| Membership / subscription | Unknown | Unknown | Unknown | Yes | Yes | Yes | **Impl** — Party Pro ₹200/30 days, level 7 (B7) |
| **Gifts** | | | | | | | |
| Animated gifts | Yes | Partial | Partial | Yes | Yes | Yes | Had (static art + motion; SVGA pending) |
| Gift travelling sender → receiver | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | **Impl** in party rooms (B7) |
| Lucky gifts | Unknown | Unknown | Unknown | Partial | Unknown | Partial | Built earlier, **switched off** (standing instruction) |
| **Rankings** | | | | | | | |
| Host leaderboards | Partial | Unknown | Partial | Partial† | Yes | Yes | **Impl** — Top 50, D/W/M (B8) |
| Top supporters | Partial | Unknown | Unknown | Partial† | Unknown | Yes | **Impl** (B8) |
| Event reward tiers | Unknown | Unknown | Partial | Unknown | Yes | Unknown | **Impl** — Owner tiers, auto-settled (B8) |
| **Social** | | | | | | | |
| Profile card in rooms | Partial | Unknown | Unknown | Unknown | Partial | Yes | **Impl** (B7) |
| Follow / block / report | Yes | Unknown | Partial | Unknown | Partial | Yes | Had (+ block from live, B12) |
| Account switching | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | **Impl** — up to 5 per device (B10) |
| **Business** | | | | | | | |
| Reseller / coin-seller programme | Unknown | Partial† | Partial† | Unknown | Yes (tiered) | Partial | Had + **tiers, trades, credit, profit Impl** (B9) |
| In-app games | Yes (room games) | Unknown | Unknown | Partial | Yes | Partial | **Impl** — 20 games, Owner switches, all off by default (B3–B6) |

† only an unofficial source supports the competitor cell (see the research file).
