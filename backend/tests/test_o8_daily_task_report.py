"""O8 (5 Nov 2026) — daily tasks and daily rewards in the CRM's numbers and audit.

The Owner: "daily task, daily reward — those should be considered for audit, and in the CRM dashboard we should get
the numbers: someone who collects a daily reward of 50 diamonds should show in the dashboard's diamonds."

  * `summarise_promotions` counts `daily_task` grants (claims, diamonds, host beans) next to daily rewards and
    ranking rewards, and no longer reports them as an unrecognised kind;
  * `promotions_summary` adds the day columns, the bean cost and `promotional_diamonds_total`;
  * `promotion_claims` is the audit list: one row per grant, newest first, narrowed by kind and uid, capped;
  * the dashboard's money-only promotions block carries the daily-task and total promotional figures;
  * `/api/reports/promotions/claims` sits behind the business-financials gate, like the report.

REAL: `app.services.reports` over `tests.fakes.FakeFirestore`.

    python3 -m tests.test_o8_daily_task_report
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


T0 = datetime(2026, 11, 5, 6, 0, tzinfo=timezone.utc)
ROWS = [
    {"kind": "daily_reward", "uid": "u1", "day": 3, "dateKey": "2026-11-05", "diamonds": 50, "videoCards": 0,
     "historyRow": "users/u1/diamondTransactions/a", "createdAt": T0},
    {"kind": "daily_task", "uid": "u1", "taskId": "gifts5", "title": "Send 5 gifts", "dateKey": "2026-11-05",
     "diamonds": 20, "beans": 0, "historyRow": "users/u1/diamondTransactions/b", "createdAt": T0 + timedelta(minutes=5)},
    {"kind": "daily_task", "uid": "h1", "taskId": "live30", "title": "Go live 30 minutes", "dateKey": "2026-11-05",
     "diamonds": 0, "beans": 300, "historyRow": None, "beanHistoryRow": "users/h1/beanTransactions/c",
     "createdAt": T0 + timedelta(minutes=9)},
    {"kind": "leaderboard_reward", "uid": "u2", "diamonds": 100, "beans": 0, "board": "supporters_daily",
     "createdAt": T0 + timedelta(minutes=1)},
    {"kind": "free_call_card_redeemed", "uid": "u3", "cards": 1, "minutes": 1, "createdAt": T0},
]

s = R.summarise_promotions(ROWS)
eq("daily-task claims are counted", s["daily_task_claims"], 2)
eq("daily-task diamonds are added up", s["daily_task_diamonds"], 20)
eq("daily-task host beans are added up", s["daily_task_beans"], 300)
eq("the daily reward of 50 diamonds is still counted", s["promo_diamonds_issued"], 50)
eq("daily_task is a known kind now", s["other_kinds"], {})
eq("claimants include task claimants", s["claimants"], 2)
eq("nothing negative leaks in", R.summarise_promotions([{"kind": "daily_task", "diamonds": -5, "beans": -1}])["daily_task_diamonds"], 0)

audit = R.promotion_claims(ROWS)
eq("the audit list keeps grants a person collected (not card use)", [r["kind"] for r in audit],
   ["daily_task", "daily_task", "leaderboard_reward", "daily_reward"])
eq("newest first", audit[0]["uid"], "h1")
eq("a task row names the task", audit[0]["what"], "Go live 30 minutes")
eq("a host task points at its bean history row", audit[0]["historyRow"], "users/h1/beanTransactions/c")
eq("a daily reward row names its day", audit[-1]["what"], "Day 3")
eq("…and carries its 50 diamonds", audit[-1]["diamonds"], 50)
eq("narrowed by kind", [r["kind"] for r in R.promotion_claims(ROWS, kind="daily_reward")], ["daily_reward"])
eq("narrowed by uid", len(R.promotion_claims(ROWS, uid="u1")), 2)
eq("capped", len(R.promotion_claims(ROWS, limit=1)), 1)
eq("a silly limit is clamped", len(R.promotion_claims(ROWS, limit=99999)), 4)


async def window() -> None:
    fs = FakeFirestore()
    promo = fs.collection("promoCredits")
    for i, r in enumerate(ROWS):
        promo.docs[f"p{i}"] = dict(r)
    promo.docs["old"] = {"kind": "daily_task", "uid": "u9", "diamonds": 999, "createdAt": T0 - timedelta(days=40)}
    firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
    rates = R.Rates(diamond_pack_price_inr_per_lakh=2390.0, seller_wholesale_price_inr_per_lakh=2390.0,
                    bean_to_inr=0.01, source="firestore", provisional=False, missing=(), note="",
                    fetched_at=T0)
    rep = await R.promotions_summary(T0 - timedelta(days=1), T0 + timedelta(days=1), rates)
    eq("the report totals the window only", rep.totals["daily_task_diamonds"], 20)
    eq("promotional diamonds in total = rewards + tasks + rankings", rep.totals["promotional_diamonds_total"], 170)
    eq("host task beans valued at the bean rate (paise)", rep.totals["daily_task_bean_cost_inr_minor"], 300)
    ok("the day row carries the task columns", any(r.get("daily_task_claims") == 2 for r in rep.rows), str(rep.rows))
    lst = await R.promotion_claims_list(T0 - timedelta(days=1), T0 + timedelta(days=1))
    eq("the audit list reads the window only", lst["count"], 4)
    eq("…with totals", lst["totals"], {"diamonds": 170, "beans": 300, "claims": 4})


try:
    asyncio.run(window())
except Exception as exc:  # noqa: BLE001
    failures.append(f"window run raised {type(exc).__name__}: {exc}")

route_src = (ROOT / "app" / "routers" / "reports.py").read_text()
block = route_src[route_src.index('@router.get("/promotions/claims")'):]
block = block[: block.index("\n\n\n") if "\n\n\n" in block else len(block)]
ok("the audit route is behind the business-financials gate", "_require_business_financials(user)" in block
   and "svc.promotion_claims_list(" in block)
svc_src = (ROOT / "app" / "services" / "reports.py").read_text()
dash = svc_src[svc_src.index("async def dashboard("):]
dash = dash[: dash.index("# ── Queue depth")]
ok("the dashboard shows daily-task diamonds", 'add("promotions", "daily_task_diamonds_last_30_days"' in dash)
ok("…and all promotional diamonds together", 'add("promotions", "promotional_diamonds_last_30_days"' in dash)

print()
if failures:
    print(f"{len(failures)} of {checks} O8 report checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} O8 report checks passed.")
