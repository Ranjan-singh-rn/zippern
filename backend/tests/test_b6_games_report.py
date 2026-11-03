"""B6 (3 Nov 2026) — the Games CRM's money view, and the zero-difference check.

Pinned:
  * the owner's example — entries 100 + 100, payout 150, fee 50 — balances and is reported per game;
  * an instant game's net retained is stakes − wins, a multiplayer game's is the fee; neither is called revenue;
  * a cancelled match's refunds balance its entries;
  * a match whose rows do NOT balance is listed (and warned about) — never silently absorbed;
  * Teen Patti's boot and every bet are entries of one match, and the match still balances;
  * the route is behind the business-financials gate.

REAL: `app.services.reports` over `tests.fakes.FakeFirestore` (`gameLedger`).

    python3 -m tests.test_b6_games_report
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.db import firebase as firebase_mod  # noqa: E402
from app.services import reports as R  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


T = datetime(2026, 11, 3, 10, 0, tzinfo=timezone.utc)
rows = [
    # The owner's Ludo example.
    {"kind": "entry", "gameId": "ludo", "matchId": "M1", "uid": "A", "diamonds": 100, "createdAt": T},
    {"kind": "entry", "gameId": "ludo", "matchId": "M1", "uid": "B", "diamonds": 100, "createdAt": T},
    {"kind": "payout", "gameId": "ludo", "matchId": "M1", "uid": "A", "diamonds": 150, "createdAt": T},
    {"kind": "fee", "gameId": "ludo", "matchId": "M1", "diamonds": 50, "createdAt": T},
    # A cancelled table: refunded.
    {"kind": "entry", "gameId": "ludo", "matchId": "M2", "uid": "C", "diamonds": 500, "createdAt": T},
    {"kind": "refund", "gameId": "ludo", "matchId": "M2", "uid": "C", "diamonds": 500, "createdAt": T},
    # Instant rounds.
    {"kind": "stake", "gameId": "plinko", "roundId": "R1", "uid": "A", "diamonds": 100, "createdAt": T},
    {"kind": "win", "gameId": "plinko", "roundId": "R1", "uid": "A", "diamonds": 180, "createdAt": T},
    {"kind": "stake", "gameId": "plinko", "roundId": "R2", "uid": "B", "diamonds": 100, "createdAt": T},
]
s = R.summarise_games(rows)
ludo, plinko = s["games"]["ludo"], s["games"]["plinko"]
eq("ludo entries", ludo["entries"], 700)
eq("ludo payout + fee + refund", (ludo["payouts"], ludo["fees"], ludo["refunds"]), (150, 50, 500))
eq("ludo net retained is the fee", ludo["net_retained"], 50)
eq("ludo sessions / players", (ludo["sessions"], ludo["unique_players"]), (2, 3))
eq("plinko net retained is stakes − wins", plinko["net_retained"], 200 - 180)
eq("every match balances", s["unbalanced_matches"], [])

# Teen Patti: a boot and several bets per player are all `entry` rows of one match; the pot less the fee is paid.
tp = [
    {"kind": "entry", "gameId": "teen_patti", "matchId": "T1", "uid": "A", "diamonds": 100, "createdAt": T},
    {"kind": "entry", "gameId": "teen_patti", "matchId": "T1", "uid": "B", "diamonds": 100, "createdAt": T},
    {"kind": "entry", "gameId": "teen_patti", "matchId": "T1", "uid": "A", "diamonds": 100, "createdAt": T},   # chaal
    {"kind": "entry", "gameId": "teen_patti", "matchId": "T1", "uid": "B", "diamonds": 200, "createdAt": T},   # seen show
    {"kind": "payout", "gameId": "teen_patti", "matchId": "T1", "uid": "B", "diamonds": 450, "createdAt": T},
    {"kind": "fee", "gameId": "teen_patti", "matchId": "T1", "diamonds": 50, "createdAt": T},
]
t = R.summarise_games(rows + tp)
eq("teen patti: every bet counted in", t["games"]["teen_patti"]["entries"], 500)
eq("teen patti: one session, two players", (t["games"]["teen_patti"]["sessions"], t["games"]["teen_patti"]["unique_players"]), (1, 2))
eq("teen patti balances: 500 = 450 + 50", t["unbalanced_matches"], [])

broken = rows + [{"kind": "payout", "gameId": "ludo", "matchId": "M1", "uid": "B", "diamonds": 10, "createdAt": T}]
b = R.summarise_games(broken)
eq("a match paid 10 too many is listed", [(u["matchId"], u["difference"]) for u in b["unbalanced_matches"]], [("M1", -10)])

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
for i, r in enumerate(broken):
    fs.collection("gameLedger").docs[f"row{i}"] = dict(r)
rep = asyncio.run(R.games_summary(datetime(2026, 11, 3, tzinfo=timezone.utc), datetime(2026, 11, 4, tzinfo=timezone.utc))).as_dict()
eq("report rows per game", [r["game"] for r in rep["rows"]], ["ludo", "plinko"])
ok("the imbalance is a warning on the report", any("do not balance" in w for w in rep["warnings"]), str(rep["warnings"]))
ok("never called revenue", "not cash revenue" in rep["definitions"]["net_retained"])

router = (ROOT / "app" / "routers" / "reports.py").read_text()
block = router[router.index('@router.get("/games")'):router.index('@router.get("/promotions")')]
ok("route behind the business-financials gate", "_require_business_financials(user)" in block and "svc.games_summary(" in block)

print()
if failures:
    print(f"{len(failures)} of {checks} games report checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} games report checks passed.")
