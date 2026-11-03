"""B2c (3 Nov 2026) — daily rewards and free call cards are counted in the CRM's finance figures.

They were not: `claimDailyReward` credited diamonds and free call cards into users' wallets and nowhere a report
reads, and no call ever spent a card. The app now writes one `promoCredits` document per grant and per card used
(functions/test/promoCredits.test.js pins that side). This pins the CRM side:

  * `summarise_promotions` adds up claims, promotional diamonds, cards issued, cards used, card minutes, their
    diamond value and the host beans paid for them — and counts an unknown kind instead of dropping it;
  * `promotions_summary` reads `promoCredits` for the window only, buckets by day, values the host cost at the bean
    rate, and says so when the period is empty;
  * the route is behind the business-financials gate, like revenue;
  * the dashboard carries a `promotions` block for those who see money, and a Firestore that cannot be read is a
    warning there — never a zero.

REAL: `app.services.reports` over `tests.fakes.FakeFirestore`.

    python3 -m tests.test_b2c_promotions
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.db import firebase as firebase_mod  # noqa: E402
from app.services import reports as R  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


RATES = R.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    seller_wholesale_price_inr_per_lakh=2390.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="test",
    fetched_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
)

# ── 1. The pure roll-up ───────────────────────────────────────────────────────
rows = [
    {"kind": "daily_reward", "uid": "u1", "diamonds": 50, "videoCards": 0},
    {"kind": "daily_reward", "uid": "u1", "diamonds": 75, "videoCards": 1},
    {"kind": "daily_reward", "uid": "u2", "diamonds": 200, "videoCards": 2},
    {"kind": "free_call_card_redeemed", "uid": "u2", "cards": 1, "minutes": 1, "diamondValue": 60, "beansCredited": 30},
    {"kind": "free_call_card_redeemed", "uid": "u1", "minutes": 1, "diamondValue": 100, "beansCredited": 70},
    {"kind": "mystery_bonus", "uid": "u3"},
]
s = R.summarise_promotions(rows)
eq("claims", s["daily_reward_claims"], 3)
eq("promotional diamonds issued", s["promo_diamonds_issued"], 325)
eq("call cards issued", s["call_cards_issued"], 3)
eq("call cards used (a row without `cards` is one card)", s["call_cards_redeemed"], 2)
eq("card minutes", s["card_minutes"], 2)
eq("card diamond value", s["card_diamond_value"], 160)
eq("host beans paid for card minutes", s["card_host_beans"], 100)
eq("distinct claimants", s["claimants"], 2)
eq("an unknown kind is counted, not dropped", s["other_kinds"], {"mystery_bonus": 1})

# B8: ranking rewards are a recognised kind — diamonds and host beans counted separately, never "unrecognised".
lb = R.summarise_promotions([
    {"kind": "leaderboard_reward", "uid": "a", "diamonds": 500},
    {"kind": "leaderboard_reward", "uid": "h", "beans": 300},
])
eq("ranking rewards counted", (lb["leaderboard_rewards"], lb["leaderboard_diamonds"], lb["leaderboard_beans"]), (2, 500, 300))
eq("ranking rewards are not an unknown kind", lb["other_kinds"], {})
eq("nothing negative leaks in", R.summarise_promotions([{"kind": "daily_reward", "diamonds": -5}])["promo_diamonds_issued"], 0)

# ── 2. The report over Firestore, windowed ────────────────────────────────────
fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
D1 = datetime(2026, 11, 2, 6, 0, tzinfo=timezone.utc)
D2 = datetime(2026, 11, 3, 6, 0, tzinfo=timezone.utc)
OUTSIDE = datetime(2026, 10, 1, tzinfo=timezone.utc)
promo = fs.collection("promoCredits")
promo.docs["daily_u1_2026-11-02"] = {"kind": "daily_reward", "uid": "u1", "diamonds": 50, "videoCards": 1, "createdAt": D1}
promo.docs["daily_u2_2026-11-03"] = {"kind": "daily_reward", "uid": "u2", "diamonds": 100, "videoCards": 0, "createdAt": D2}
promo.docs["card_CALL1"] = {"kind": "free_call_card_redeemed", "uid": "u1", "cards": 1, "minutes": 1,
                            "diamondValue": 60, "beansCredited": 30, "createdAt": D2}
promo.docs["daily_u9_2026-10-01"] = {"kind": "daily_reward", "uid": "u9", "diamonds": 999, "createdAt": OUTSIDE}

since, until = datetime(2026, 11, 1, tzinfo=timezone.utc), datetime(2026, 11, 4, tzinfo=timezone.utc)
rep = asyncio.run(R.promotions_summary(since, until, RATES)).as_dict()
eq("report name", rep["report"], "promotions")
eq("only the window: 150 promotional diamonds", rep["totals"]["promo_diamonds_issued"], 150)
eq("one card issued, one used", (rep["totals"]["call_cards_issued"], rep["totals"]["call_cards_redeemed"]), (1, 1))
eq("host cost valued at the bean rate: 30 beans × ₹0.01 = 30 paise", rep["totals"]["card_host_cost_inr_minor"], 30)
eq("bucketed by day", [r["day"] for r in rep["rows"]], ["2026-11-02", "2026-11-03"])
eq("day 2 row", (rep["rows"][1]["promo_diamonds_issued"], rep["rows"][1]["call_cards_redeemed"]), (100, 1))
ok("never called revenue", "Not revenue" in rep["definitions"]["promo_diamonds_issued"])

empty = asyncio.run(R.promotions_summary(datetime(2026, 9, 1, tzinfo=timezone.utc),
                                         datetime(2026, 9, 2, tzinfo=timezone.utc), RATES)).as_dict()
ok("an empty period says so", empty["empty"] is True and any("No daily rewards" in w for w in empty["warnings"]),
   str(empty["warnings"]))

# ── 3. The route and the dashboard ────────────────────────────────────────────
router_src = (ROOT / "app" / "routers" / "reports.py").read_text()
block = router_src[router_src.index('@router.get("/promotions")'):]
block = block[: block.index("\n@router", 10)] if "\n@router" in block[10:] else block
ok("the route exists and is behind the business-financials gate",
   "_require_business_financials(user)" in block and "svc.promotions_summary(" in block)
svc_src = (ROOT / "app" / "services" / "reports.py").read_text()
dash = svc_src[svc_src.index("async def dashboard("):]
dash = dash[: dash.index("# ── Queue depth")]
ok("the dashboard reads promoCredits inside the money-only block", 'add("promotions", "promo_diamonds_issued_last_30_days"' in dash)
ok("…and a store it cannot read is a warning, not a zero", "except DataUnavailable as exc:" in dash
   and "Promotions could not be read" in dash)

print()
if failures:
    print(f"{len(failures)} of {checks} promotions checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} promotions checks passed.")
