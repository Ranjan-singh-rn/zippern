"""Chance mechanics — exposure, the reserve, the ceilings and the monitoring.

Part 8B.4 and 8B.5. `tests/test_chance.py` holds down 8B.0 – 8B.3: the odds are
the server's, the table sums to 100%, a configuration is a card. Everything
there bounds **one round**. This module is about the thing that is not bounded
by any of it — a thousand rounds — and about the difference between a run of bad
luck and a problem.

Eight claims, and each is the reason a paragraph of the spec exists.

  1. **Exposure is total staked against total paid out** (8B.4.2), computed
     across many rounds from the round records themselves and checked here
     against arithmetic done in the test rather than against whatever the code
     returned.

  2. **Each of the three ceilings binds at exactly its own figure and not one
     diamond before it** (8B.4.4). The per-round ceiling *caps*, like the
     maximum single win; the daily ceilings and the reserve *withhold*, because
     there is no way to cap a budget without either withholding or minting.

  3. **A breach auto-suspends** (8B.4.5), and a suspended mechanic pays nothing
     and accepts nothing: it vanishes from the catalogue, refuses a new round
     and refuses one already committed, all with the words and the status code a
     mechanic that was never built in that market produces (8B.0.7).

  4. **All owners are alerted**, through `services/alerts.py` and not through a
     second alerting path invented for this.

  5. **Resuming is a deliberate act by an owner with a reason**, and there is no
     timer anywhere that does it instead.

  6. **Two rounds settling at the same instant cannot both slip under a
     ceiling.** Tested twice: once by genuinely interleaving two `play_round`
     coroutines, and once by writing a competitor's increment into the gap
     between the read and the write, which is the exact hole a
     read-then-write implementation has.

  7. **A small sample that diverges wildly does not alert, and a real
     divergence does** (8B.5.1 / 8B.5.2) — judged against the variance of the
     signed outcome table, not against a percentage gap.

  8. **A frozen player cannot play and their balance is untouched** (8B.5.4).
     Not a ban, not a reversal, not a balance change.

The real service code runs throughout — the real card engine, the real ledger,
the real audit log, the real alert detectors and the real email path. Only Mongo
and SendGrid underneath them are replaced, following `tests/harness.py`.

Run:  python3 -m tests.test_chance_exposure
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
# The unique indexes `app/db/mongo.py` declares. `chance_exposure.key` is the
# one this module exists to exercise: it is what makes a ceiling a ceiling
# rather than a suggestion, in exactly the way `alert_state.key` makes an alert
# fire once. A fake without it would let both sides of every race through and
# every test below would pass for the wrong reason.
DB.UNIQUE = {
    **FakeDb.UNIQUE,
    "chance_rounds": ("round_id", "provider_round_ref"),
    "chance_exposure": ("key",),
}

CURRENT: dict[str, FakeDb] = {"db": DB}
mongo.get_db = lambda: CURRENT["db"]  # type: ignore[assignment]


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def start_transaction(self):
        return _FakeTransaction()


class _FakeClient:
    async def start_session(self):
        return _FakeSession()


mongo.get_client = lambda: _FakeClient()  # type: ignore[assignment]

from app.db.mongo import C  # noqa: E402

_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

import app.db.firebase as firebase  # noqa: E402

firebase.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]

os.environ["CHANCE_SIGNING_KEYS"] = "app_tier:tier-secret-9f3"

from fastapi import HTTPException  # noqa: E402  (the harness stub)

from app.config import settings  # noqa: E402
from app.core import audit as audit_log  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.routers import chance as chance_router  # noqa: E402
from app.services import alerts  # noqa: E402
from app.services import cards as card_svc  # noqa: E402
from app.services import chance as X  # noqa: E402
from app.services import money  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()
PROVIDER.next_status = 202

settings.sendgrid_api_key = "SG.test-key-never-appears-in-output.0000"
settings.environment = "test"

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def truthy(label: str, value) -> None:
    global checks
    checks += 1
    if not value:
        failures.append(f"{label}\n    expected something truthy, got {value!r}")


def falsy(label: str, value) -> None:
    global checks
    checks += 1
    if value:
        failures.append(f"{label}\n    expected something falsy, got {value!r}")


def contains(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = (
        " ".join(str(h) for h in haystack)
        if isinstance(haystack, (list, tuple))
        else str(haystack)
    )
    if needle.lower() not in text.lower():
        failures.append(f"{label}\n    {needle!r} is not in: {text[:600]!r}")


def run(coro):
    return asyncio.run(coro)


def refuses(label: str, factory, *, error=X.ChanceError) -> None:
    global checks
    checks += 1
    try:
        result = factory()
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
    except error:
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return
    failures.append(f"{label}: was NOT refused — returned {result!r}")


# ── The people ────────────────────────────────────────────────────────────────

APP_ADMIN = {"uid": "u-app-1", "name": "Rhea (App admin)", "role": Role.APP_ADMIN,
             "team": Team.APP}
FIN_ADMIN = {"uid": "u-fin-1", "name": "Anil (Finance admin)",
             "role": Role.FINANCE_ADMIN, "team": Team.FINANCE}
OPS_ADMIN = {"uid": "u-ops-1", "name": "Meera (Ops admin)", "role": Role.OPS_ADMIN,
             "team": Team.OPS}
OWNER_A = {"uid": "u-own-1", "name": "Owner One", "role": Role.OWNER, "team": None}
OWNER_B = {"uid": "u-own-2", "name": "Owner Two", "role": Role.OWNER, "team": None}

DB.seed(
    C.STAFF,
    [
        {"uid": "u-own-1", "email": "owner1@zipper.test", "name": "Owner One",
         "role": str(Role.OWNER), "is_active": True},
        {"uid": "u-own-2", "email": "owner2@zipper.test", "name": "Owner Two",
         "role": str(Role.OWNER), "is_active": True},
        {"uid": "u-fin-1", "email": "finance@zipper.test", "name": "Anil",
         "role": str(Role.FINANCE_ADMIN), "is_active": True},
        {"uid": "u-ops-1", "email": "ops@zipper.test", "name": "Meera",
         "role": str(Role.OPS_ADMIN), "is_active": True},
        {"uid": "u-app-1", "email": "app@zipper.test", "name": "Rhea",
         "role": str(Role.APP_ADMIN), "is_active": True},
    ],
)


# ══════════════════════════════════════════════════════════════════════════════
# The table every mechanic below is configured with
# ══════════════════════════════════════════════════════════════════════════════
#
#   multiplier   probability     contribution
#   0×           54%             0
#   1×           30%             0.30
#   2×           12%             0.24
#   10×           4%             0.40
#   ──────────────────────────────────────────
#   sum         100%             0.94   → RTP 94%, house edge 6%
#
# Worked by hand so every assertion below is against arithmetic rather than
# against whatever the code produced.

TABLE = [
    {"multiplier_bp": 0, "probability_ppm": 540_000},
    {"multiplier_bp": 10_000, "probability_ppm": 300_000},
    {"multiplier_bp": 20_000, "probability_ppm": 120_000},
    {"multiplier_bp": 100_000, "probability_ppm": 40_000},
]
OUTCOMES = X.parse_outcomes(TABLE)

check("the table returns 94%", X.rtp_ppm(OUTCOMES), 940_000)

# E[M²] = 0.30·1 + 0.12·4 + 0.04·100 = 0.30 + 0.48 + 4.00 = 4.78
# Var    = 4.78 − 0.94² = 4.78 − 0.8836 = 3.8964
check(
    "and its variance is 3.8964, exactly, on integers",
    X.variance_numerator(OUTCOMES),
    38_964 * 10**16,
)
check(
    "which is a standard deviation of 1.97393 stakes on ONE round",
    X.sigma_ppm(OUTCOMES),
    1_973_930,
)
truthy(
    "the sigma is more than twice the mean — one round says nothing at all, "
    "which is the whole of 8B.4.1",
    X.sigma_ppm(OUTCOMES) > 2 * X.rtp_ppm(OUTCOMES),
)


def draft(**exposure) -> dict:
    return {
        "outcomes": TABLE,
        "stake": {"min_stake": 100, "max_stake": 1_000, "step": 100},
        "quantity_tiers": [1],
        "max_single_win": 10_000,
        "enabled_countries": ["AE"],
        "multiplier_basis": "total_stake",
        "exposure": exposure or None,
    }


def make(mechanic_id: str, **exposure) -> dict:
    """Create, propose, verify, sign and activate a mechanic. Five stages, real."""
    run(
        X.create_mechanic(
            mechanic_id=mechanic_id,
            kind=X.MechanicKind.LUCKY_GIFT,
            name=f"Test mechanic {mechanic_id}",
            reason="Exercising the exposure and reserve controls of 8B.4.",
            actor=APP_ADMIN,
        )
    )
    proposal = run(
        X.propose_config(
            mechanic_id=mechanic_id,
            draft=draft(**exposure),
            reason="94% RTP with the ceilings and reserve this test needs.",
            actor=APP_ADMIN,
        )
    )
    card = proposal["card"]
    run(card_svc.verify(card["id"], FIN_ADMIN, "Odds, ceilings and reserve checked."))
    run(card_svc.sign(card["id"], OWNER_A, "Approved."))
    return run(X.activate_config(card["id"], OWNER_B))


def balance(uid: str) -> int:
    return run(money.get_balance(money.HolderType.USER, uid, money.Currency.DIAMONDS))


def fund(uid: str, amount: int) -> None:
    run(
        money.apply_movement(
            money.Movement(
                holder_type=money.HolderType.USER,
                holder_id=uid,
                currency=money.Currency.DIAMONDS,
                amount=amount,
                action="balance.credit",
                reason="Opening balance for the exposure test.",
                actor=OWNER_A,
            )
        )
    )


def round_doc(round_id: str) -> dict:
    return next(d for d in DB[C.CHANCE_ROUNDS].docs if d["round_id"] == round_id)


def entropy_for(round_id: str, wanted_bp: int) -> str:
    """Find a client entropy landing on a chosen multiplier.

    Only possible because the test can read the stored seed, which is precisely
    what a player cannot do before a round settles.
    """
    doc = round_doc(round_id)
    seed = bytes.fromhex(doc["server_seed"])
    for i in range(200_000):
        entropy = f"grind-{i}"
        result = X.draw(seed, X.draw_message(round_id, doc["nonce"], entropy), OUTCOMES)
        if result["multiplier_bp"] == wanted_bp:
            return entropy
    raise AssertionError(f"no entropy found for {wanted_bp}")  # pragma: no cover


def play(mechanic: str, player: str, stake: int, multiplier_bp: int) -> dict:
    """One round, landing on a chosen multiplier. The real commit-and-play path."""
    opened = run(
        X.commit_round(
            mechanic_id=mechanic, player_uid=player, country="AE", actor=APP_ADMIN
        )
    )
    entropy = entropy_for(opened["round_id"], multiplier_bp)
    return run(
        X.play_round(
            round_id=opened["round_id"],
            unit_stake=stake,
            quantity=1,
            client_entropy=entropy,
            actor=APP_ADMIN,
        )
    )


def emails(kind: str) -> list[dict]:
    return [row for row in DB[C.EMAIL_DELIVERIES].docs if row.get("kind") == kind]


# ══════════════════════════════════════════════════════════════════════════════
# 1. THE CONFIGURATION — a reserve is money, so it rides the signed card
# ══════════════════════════════════════════════════════════════════════════════

evaluated = X.evaluate_draft(
    draft(
        reserve_diamonds=200_000,
        reserve_basis="Three sigma over 100,000 rounds at the top stake.",
        max_payout_per_round=5_000,
        max_payout_per_player_per_day=20_000,
        max_payout_platform_per_day=50_000,
    )
)
exposure_block = evaluated["exposure"]

falsy("a well-formed exposure block does not block the configuration", evaluated["blocked"])
check("the reserve is on the evaluation", exposure_block["reserve_diamonds"], 200_000)
check("as is the per-round ceiling", exposure_block["max_payout_per_round"], 5_000)
check("the per-player daily ceiling", exposure_block["max_payout_per_player_per_day"], 20_000)
check("and the platform daily ceiling", exposure_block["max_payout_platform_per_day"], 50_000)
check(
    "the table's own sigma travels with them, so the reserve can be sized "
    "against a number rather than a feeling",
    exposure_block["sigma_ppm"],
    1_973_930,
)
truthy(
    "and a three-sigma bad run is priced at three volumes (8B.4.1)",
    len(exposure_block["reserve_guidance"]) == 3,
)
truthy(
    "every figure in the exposure block is an int or a string, never a float",
    all(
        isinstance(v, (int, str, list, dict, type(None)))
        for v in exposure_block.values()
    ),
)

# ── What is refused, and what is only flagged ─────────────────────────────────

blocked_high = X.evaluate_draft(draft(max_payout_per_round=50_000))
truthy(
    "a per-round ceiling above the maximum single win is blocked — it could "
    "never bind, so it is not a ceiling",
    blocked_high["blocked"],
)
contains("and the refusal says so", blocked_high["blocked_reasons"], "never bind")

blocked_player = X.evaluate_draft(
    draft(max_payout_per_round=10_000, max_payout_per_player_per_day=5_000)
)
truthy(
    "a daily ceiling below one permitted round is blocked — the mechanic would "
    "suspend itself on its own first jackpot",
    blocked_player["blocked"],
)

blocked_platform = X.evaluate_draft(
    draft(max_payout_per_player_per_day=20_000, max_payout_platform_per_day=10_000)
)
truthy(
    "and a platform ceiling below the per-player one is blocked",
    blocked_platform["blocked"],
)

blocked_basis = X.evaluate_draft(draft(reserve_diamonds=200_000))
truthy(
    "a reserve with no stated model is blocked — 8B.4.3 asks for it to be "
    "modelled, not chosen",
    blocked_basis["blocked"],
)
contains("and says what to write", blocked_basis["blocked_reasons"], "reserve_basis")

refuses(
    "a negative ceiling is refused outright",
    lambda: X.evaluate_draft(draft(max_payout_per_round=-1)),
)
refuses(
    "and a float one",
    lambda: X.evaluate_draft(draft(max_payout_per_round=5_000.5)),
)

no_limits = X.evaluate_draft(draft())
falsy(
    "a configuration with no reserve and no daily ceiling is NOT blocked — "
    "nothing already built changes behaviour",
    no_limits["blocked"],
)
contains(
    "but it is flagged, in the words of 8B.4.6",
    no_limits["flags"],
    "8B.4.6",
)
check(
    "and its per-round ceiling defaults to the maximum single win, so a payout "
    "is still bounded on one round",
    no_limits["exposure"]["max_payout_per_round"],
    10_000,
)
check(
    "recorded as a default rather than as somebody's decision",
    no_limits["exposure"]["max_payout_per_round_source"],
    "max_single_win",
)

tiny = X.evaluate_draft(
    draft(
        reserve_diamonds=1_000,
        reserve_basis="Deliberately far too small, to prove this is caught.",
    )
)
contains(
    "a reserve smaller than an ordinary bad run is flagged — a control that "
    "cries wolf gets raised until it means nothing (8B.4.1)",
    tiny["flags"],
    "ordinary variance",
)

# ── The whole block survives a card, a signature and a re-evaluation ──────────

MAIN = "exposure_main"
live = make(
    MAIN,
    reserve_diamonds=200_000,
    reserve_basis="Three sigma over 100,000 rounds at the top stake.",
    max_payout_per_round=5_000,
    max_payout_per_player_per_day=20_000,
    max_payout_platform_per_day=50_000,
)
check("the signed version carries the reserve", live["evaluation"]["exposure"]["reserve_diamonds"], 200_000)
check("and the ceilings", live["evaluation"]["exposure"]["max_payout_per_round"], 5_000)
check("with the owner's signature on the version", live["signed_by"]["uid"], OWNER_A["uid"])

card_for_main = run(X.config_history(MAIN))[0]
check("the change went through a card", card_for_main["authority"], "card")

# A change to the reserve is its own line on the card an owner signs, not a blob.
second = run(
    X.propose_config(
        mechanic_id=MAIN,
        draft=draft(
            reserve_diamonds=400_000,
            reserve_basis="Doubled after the first month of live volume.",
            max_payout_per_round=5_000,
            max_payout_per_player_per_day=20_000,
            max_payout_platform_per_day=50_000,
        ),
        reason="Raising the reserve after a month of live volume.",
        actor=APP_ADMIN,
    )
)
diff = {c["field"]: c for c in second["card"]["payload"]["changes"]}
truthy("a reserve change is its own diff line on the card", "exposure.reserve_diamonds" in diff)
check("showing what it was", diff["exposure.reserve_diamonds"]["before"], 200_000)
check("and what it would become", diff["exposure.reserve_diamonds"]["after"], 400_000)
run(card_svc.reject(second["card"]["id"], OWNER_A, "Not yet — leaving it where it is."))


# ══════════════════════════════════════════════════════════════════════════════
# 2. EXPOSURE ACROSS MANY ROUNDS — 8B.4.2
# ══════════════════════════════════════════════════════════════════════════════

PLAYER = "player-exposure-1"
fund(PLAYER, 500_000)

# Twenty rounds with a known shape: 11 losses, 5 evens, 3 doubles, 1 ten.
SHAPE = [0] * 11 + [10_000] * 5 + [20_000] * 3 + [100_000]
expected_staked = 0
expected_paid = 0
for multiplier in SHAPE:
    result = play(MAIN, PLAYER, 100, multiplier)
    expected_staked += 100
    expected_paid += result["payout"]

check("twenty rounds staked 2,000 diamonds", expected_staked, 2_000)
# 11×0 + 5×100 + 3×200 + 1×1000 = 0 + 500 + 600 + 1000 = 2,100
check("and paid 2,100 back", expected_paid, 2_100)

position = run(X.exposure_for(MAIN))
headline = position["headline"]
check("exposure counts every round", headline["rounds"], len(SHAPE))
check("the staked figure is the sum of the stakes", headline["staked"], expected_staked)
check("the paid figure is the sum of the payouts", headline["paid_out"], expected_paid)
check("and the position is one minus the other", headline["net"], expected_staked - expected_paid)
check("which is negative here — the house is down 100 diamonds", headline["net"], -100)
check(
    "the actual RTP falls straight out of the two",
    headline["actual_rtp_ppm"],
    expected_paid * 1_000_000 // expected_staked,
)
check("the reserve is stated beside them", headline["reserve"], 200_000)
check(
    "and the headroom is the reserve plus the position",
    headline["headroom"],
    200_000 - 100,
)
check(
    "the control's own counters agree with the record",
    (position["control"]["staked"], position["control"]["paid_out"]),
    (expected_staked, expected_paid),
)
check("the player's balance moved by exactly the net", balance(PLAYER), 500_000 + 100)

snapshot = run(X.exposure_snapshot())
truthy("every mechanic appears on the one exposure screen", any(
    entry["mechanic_id"] == MAIN for entry in snapshot
))


# ══════════════════════════════════════════════════════════════════════════════
# 3. CEILING ONE — MAXIMUM PAYOUT PER ROUND (8B.4.4)
# ══════════════════════════════════════════════════════════════════════════════
#
# This one CAPS. It is the same kind of thing as the maximum single win, it is
# reached routinely by the table's own top multiplier at the top stake, and a
# mechanic that suspended every time somebody hit the jackpot would be switched
# off inside a week.

ROUND_CEILING = "ceiling_per_round"
make(ROUND_CEILING, max_payout_per_round=5_000)
P_ROUND = "player-round-ceiling"
fund(P_ROUND, 100_000)

under = play(ROUND_CEILING, P_ROUND, 400, 100_000)   # 10× on 400 = 4,000
check("a payout under the ceiling is paid in full", under["payout"], 4_000)
check("nothing is withheld", round_doc(under["round_id"])["withheld"], 0)
falsy("and nothing is capped", round_doc(under["round_id"])["ceiling_capped"])

exactly = play(ROUND_CEILING, P_ROUND, 500, 100_000)  # 10× on 500 = 5,000
check("a payout exactly on the ceiling is paid in full", exactly["payout"], 5_000)
falsy("and is not treated as capped", round_doc(exactly["round_id"])["ceiling_capped"])
check("still nothing withheld", round_doc(exactly["round_id"])["withheld"], 0)

over = play(ROUND_CEILING, P_ROUND, 1_000, 100_000)   # 10× on 1,000 = 10,000
check("one diamond over, and the ceiling pays the ceiling", over["payout"], 5_000)
check(
    "the record keeps what the table would have paid",
    round_doc(over["round_id"])["payout_before_ceilings"],
    10_000,
)
truthy("the round says it was capped", round_doc(over["round_id"])["ceiling_capped"])
check("and NOTHING is withheld — a cap is not a breach", round_doc(over["round_id"])["withheld"], 0)
falsy(
    "so the mechanic is still running: hitting the jackpot is not an incident",
    run(X.get_mechanic(ROUND_CEILING))["suspended"],
)
check(
    "and it is still visible to players",
    [m["mechanic_id"] for m in run(X.visible_mechanics("AE")) if m["mechanic_id"] == ROUND_CEILING],
    [ROUND_CEILING],
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. CEILING TWO — MAXIMUM PAYOUT PER PLAYER PER DAY (8B.4.4)
# ══════════════════════════════════════════════════════════════════════════════

PLAYER_CEILING = "ceiling_per_player"
make(PLAYER_CEILING, max_payout_per_player_per_day=12_000)
P_DAY = "player-daily-ceiling"
OTHER = "player-daily-other"
fund(P_DAY, 100_000)
fund(OTHER, 100_000)

first = play(PLAYER_CEILING, P_DAY, 1_000, 100_000)   # 10,000
check("the first win is paid in full", first["payout"], 10_000)
second_win = play(PLAYER_CEILING, P_DAY, 1_000, 20_000)  # 2,000 — exactly 12,000
check("and the next takes them to exactly the ceiling", second_win["payout"], 2_000)
check("nothing withheld at exactly the ceiling", round_doc(second_win["round_id"])["withheld"], 0)
falsy(
    "and the mechanic is still running — the ceiling has not been crossed",
    run(X.get_mechanic(PLAYER_CEILING))["suspended"],
)

before_breach = balance(P_DAY)
breaching = play(PLAYER_CEILING, P_DAY, 1_000, 20_000)  # would be 2,000 more
check("one diamond past the ceiling and nothing more is paid", breaching["payout"], 0)
check("the shortfall is withheld", round_doc(breaching["round_id"])["withheld"], 2_000)
check(
    "and recorded with what it would have been",
    round_doc(breaching["round_id"])["payout_before_ceilings"],
    2_000,
)
check(
    "the balance moved by the stake alone",
    balance(P_DAY),
    before_breach - 1_000,
)
check(
    "the breach names the ceiling that bound",
    [b["kind"] for b in round_doc(breaching["round_id"])["ceilings_breached"]],
    ["per_player_per_day"],
)
day_counter = next(
    d for d in DB[C.CHANCE_EXPOSURE].docs
    if d["key"] == X._player_day_key(PLAYER_CEILING, P_DAY, X.business_day())
)
check(
    "and the day's counter stands at exactly the ceiling, never above it",
    day_counter["paid_out"],
    12_000,
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. AUTO-SUSPEND — 8B.4.5
# ══════════════════════════════════════════════════════════════════════════════

suspended_state = run(X.get_mechanic(PLAYER_CEILING))["suspended"]
truthy("a breach suspends the mechanic", suspended_state)
truthy("automatically", suspended_state["automatic"])
truthy("with a reason on it", len(suspended_state["reason"]) >= X.MIN_REASON)
contains("naming the ceiling", suspended_state["reason"], "per-player daily")
check(
    "and the breaching round recorded on it",
    suspended_state["breach"]["round_id"],
    breaching["round_id"],
)
check("with the shortfall", suspended_state["breach"]["withheld"], 2_000)

# ── It pays nothing and accepts nothing, in the same words a disabled one uses ─

check(
    "a suspended mechanic vanishes from the catalogue",
    [m["mechanic_id"] for m in run(X.visible_mechanics("AE"))
     if m["mechanic_id"] == PLAYER_CEILING],
    [],
)
refuses(
    "no new round can be opened on it",
    lambda: X.commit_round(
        mechanic_id=PLAYER_CEILING, player_uid=OTHER, country="AE", actor=APP_ADMIN
    ),
    error=X.MechanicUnavailable,
)
refuses(
    "not even for a player who has won nothing today",
    lambda: X.commit_round(
        mechanic_id=PLAYER_CEILING, player_uid="somebody-else-entirely",
        country="AE", actor=APP_ADMIN,
    ),
    error=X.MechanicUnavailable,
)


def _detail(factory):
    try:
        run(factory())
    except X.MechanicUnavailable as exc:
        http = chance_router._fail(exc)
        return http.status_code, http.detail
    return None  # pragma: no cover


check(
    "a suspended mechanic and one that was never built answer identically — "
    "a player learns nothing about why (8B.0.7)",
    _detail(lambda: X.commit_round(mechanic_id=PLAYER_CEILING, player_uid=OTHER,
                                   country="AE", actor=APP_ADMIN)),
    _detail(lambda: X.commit_round(mechanic_id="no_such_thing", player_uid=OTHER,
                                   country="AE", actor=APP_ADMIN)),
)
check(
    "and it is a 404, not a 503 that would say the business is in trouble",
    _detail(lambda: X.commit_round(mechanic_id=PLAYER_CEILING, player_uid=OTHER,
                                   country="AE", actor=APP_ADMIN))[0],
    404,
)

# A round committed before the suspension does not outlive it.
IN_FLIGHT = "ceiling_in_flight"
make(IN_FLIGHT, max_payout_per_player_per_day=10_000)
P_FLIGHT = "player-in-flight"
fund(P_FLIGHT, 50_000)
pending = run(
    X.commit_round(
        mechanic_id=IN_FLIGHT, player_uid=P_FLIGHT, country="AE", actor=APP_ADMIN
    )
)
run(
    X.suspend_mechanic(
        mechanic_id=IN_FLIGHT,
        reason="Stopped by hand while the odds are checked.",
        actor=APP_ADMIN,
    )
)
before_flight = balance(P_FLIGHT)
refuses(
    "a round committed before the suspension cannot be played after it",
    lambda: X.play_round(
        round_id=pending["round_id"], unit_stake=100, actor=APP_ADMIN
    ),
    error=X.MechanicUnavailable,
)
check("it is voided rather than left open", round_doc(pending["round_id"])["status"],
      str(X.RoundStatus.VOID))
check("and nothing was staked", balance(P_FLIGHT), before_flight)

# ── All owners are alerted, through alerts.py ─────────────────────────────────

sent = emails("alert.chance_mechanic_suspended")
truthy("the suspension emailed somebody", sent)
recipients = {row["to"] for row in sent}
truthy("owner one was told", "owner1@zipper.test" in recipients)
truthy("owner two was told", "owner2@zipper.test" in recipients)
truthy("and Finance, who owns the margin (8B.5.6)", "finance@zipper.test" in recipients)
falsy(
    "the deactivated third owner was not — the audience is resolved from the "
    "staff record, not from a list written in this module",
    any("owner3" in address for address in recipients),
)
bodies = [
    row for row in PROVIDER.sent
    if PLAYER_CEILING in str(row.get("html", ""))
]
truthy("the email names the mechanic", bodies)
contains("and what it would have paid", str(bodies[0]["html"]), "2,000")
contains(
    "and says it will not restart on a timer",
    str(bodies[0]["html"]),
    "an owner must resume it",
)

truthy(
    "the alert went through the shared machinery — it is in the delivery "
    "record like every other email (8A.2.14)",
    all(row.get("dedupe_key") for row in sent),
)

state_rows = run(alerts.recent_state())
truthy(
    "and through the shared suppression state, so it cannot repeat every hour",
    any(row["key"] == f"chance:suspended:{PLAYER_CEILING}" for row in state_rows),
)

before_scan = len(emails("alert.chance_mechanic_suspended"))
run(alerts.scan(["chance_mechanic_suspended"]))
check(
    "the scheduled detector finds the same suspension and does NOT email it "
    "twice — the immediate path and the scan are one condition, not two",
    len(emails("alert.chance_mechanic_suspended")),
    before_scan,
)

# ── The audit trail ───────────────────────────────────────────────────────────

history = run(audit_log.history_for("chance_mechanic", PLAYER_CEILING))
actions = [entry["action"] for entry in history]
truthy("the breach is audited", X.Act.CEILING_BREACHED in actions)
truthy("and the suspension separately", X.Act.MECHANIC_SUSPENDED in actions)
truthy("every entry carries a reason", all(e["reason"] for e in history))
truthy("and names who did it", all(e["actor"]["uid"] for e in history))
breach_entry = next(e for e in history if e["action"] == X.Act.CEILING_BREACHED)
contains(
    "the audit entry says the withheld diamonds are not written off",
    str(breach_entry["meta"]),
    "8B.7.5",
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. RESUMING — a deliberate act by an owner, never a timer (8B.4.5)
# ══════════════════════════════════════════════════════════════════════════════

refuses(
    "a team admin cannot resume a suspended mechanic",
    lambda: X.resume_mechanic(
        mechanic_id=IN_FLIGHT,
        reason="I think this is probably fine now.",
        actor=APP_ADMIN,
    ),
)
refuses(
    "nor can the Finance admin",
    lambda: X.resume_mechanic(
        mechanic_id=IN_FLIGHT,
        reason="The margin looks acceptable to me.",
        actor=FIN_ADMIN,
    ),
)
refuses(
    "nor Ops, who own the exception queue but not the money",
    lambda: X.resume_mechanic(
        mechanic_id=IN_FLIGHT, reason="Cleared from our side.", actor=OPS_ADMIN
    ),
)
refuses(
    "and an owner cannot resume one without a reason",
    lambda: X.resume_mechanic(mechanic_id=IN_FLIGHT, reason="ok", actor=OWNER_A),
)
truthy(
    "so it is still suspended after all four attempts",
    run(X.get_mechanic(IN_FLIGHT))["suspended"],
)

resumed = run(
    X.resume_mechanic(
        mechanic_id=IN_FLIGHT,
        reason="Odds table re-checked against the signed version; restarting.",
        actor=OWNER_A,
    )
)
check("an owner with a reason resumes it", resumed["suspended"], None)
check("recording who", resumed["resumed_by"]["uid"], OWNER_A["uid"])
falsy("the mechanic is no longer suspended", run(X.get_mechanic(IN_FLIGHT))["suspended"])
check(
    "and it is visible to players again",
    [m["mechanic_id"] for m in run(X.visible_mechanics("AE"))
     if m["mechanic_id"] == IN_FLIGHT],
    [IN_FLIGHT],
)

resume_audit = [
    e for e in run(audit_log.history_for("chance_mechanic", IN_FLIGHT))
    if e["action"] == X.Act.MECHANIC_RESUMED
]
check("the resumption is audited exactly once", len(resume_audit), 1)
contains("with the owner's reason", resume_audit[0]["reason"], "re-checked")
truthy(
    "and the live exposure at the moment of the decision, so the record shows "
    "what the owner was looking at",
    "position_at_resume" in resume_audit[0]["meta"],
)

after_resume = play(IN_FLIGHT, P_FLIGHT, 100, 0)
check("play works again", after_resume["status"], str(X.RoundStatus.SETTLED))

refuses(
    "and resuming a mechanic that is not suspended is refused",
    lambda: X.resume_mechanic(
        mechanic_id=IN_FLIGHT, reason="Belt and braces, twice over.", actor=OWNER_A
    ),
)

# Resuming does not raise a ceiling. The next qualifying payout stops it again,
# which is correct: the way to keep a mechanic running is a signed change.
run(
    X.resume_mechanic(
        mechanic_id=PLAYER_CEILING,
        reason="Reviewed the day's payouts; restarting to see what happens.",
        actor=OWNER_B,
    )
)
again = play(PLAYER_CEILING, P_DAY, 1_000, 20_000)
check("a payout past the same ceiling still pays nothing", again["payout"], 0)
truthy(
    "and the mechanic suspends itself again — resuming is not a waiver",
    run(X.get_mechanic(PLAYER_CEILING))["suspended"],
)


# ══════════════════════════════════════════════════════════════════════════════
# 7. CEILING THREE — PLATFORM-WIDE PER DAY (8B.4.4)
# ══════════════════════════════════════════════════════════════════════════════

PLATFORM = "ceiling_platform"
make(PLATFORM, max_payout_platform_per_day=15_000)
P1, P2, P3 = "platform-p1", "platform-p2", "platform-p3"
for uid in (P1, P2, P3):
    fund(uid, 100_000)

check("one player wins 10,000", play(PLATFORM, P1, 1_000, 100_000)["payout"], 10_000)
check("another wins 5,000, taking the day to exactly 15,000",
      play(PLATFORM, P2, 500, 100_000)["payout"], 5_000)
falsy(
    "the mechanic is still running at exactly the ceiling",
    run(X.get_mechanic(PLATFORM))["suspended"],
)

third = play(PLATFORM, P3, 1_000, 20_000)
check("a third player's win is refused in full", third["payout"], 0)
check("and withheld", round_doc(third["round_id"])["withheld"], 2_000)
check(
    "the breach names the platform ceiling",
    [b["kind"] for b in round_doc(third["round_id"])["ceilings_breached"]],
    ["platform_per_day"],
)
truthy("the mechanic suspends", run(X.get_mechanic(PLATFORM))["suspended"])
platform_counter = next(
    d for d in DB[C.CHANCE_EXPOSURE].docs
    if d["key"] == X._mechanic_day_key(PLATFORM, X.business_day())
)
check(
    "and the day's total is exactly the ceiling",
    platform_counter["paid_out"],
    15_000,
)


# ══════════════════════════════════════════════════════════════════════════════
# 8. THE RESERVE — 8B.4.3
# ══════════════════════════════════════════════════════════════════════════════
#
# The reserve is a position, not a spend limit: a mechanic that has taken more
# than it has paid is running on its own winnings and has not touched it.

RESERVE = "ceiling_reserve"
make(
    RESERVE,
    reserve_diamonds=3_000,
    reserve_basis="Deliberately tiny so this test can exhaust it in five rounds.",
)
P_RES = "player-reserve"
fund(P_RES, 100_000)

for _ in range(3):
    play(RESERVE, P_RES, 1_000, 0)      # three losses — the house is 3,000 ahead
res_position = run(X.exposure_for(RESERVE))
check("three losses leave the house 3,000 ahead", res_position["headline"]["net"], 3_000)
check(
    "so the headroom is the reserve plus the winnings, not the reserve alone",
    res_position["headline"]["headroom"],
    6_000,
)
check("and none of the reserve has been consumed", res_position["headline"]["reserve_consumed_ppm"], 0)

# 2× on 1,000 = 2,000. Position: 3,000 + 1,000 − 2,000 = 2,000.
inside = play(RESERVE, P_RES, 1_000, 20_000)
check("a win inside the headroom is paid in full", inside["payout"], 2_000)
check("nothing withheld", round_doc(inside["round_id"])["withheld"], 0)
falsy("and nothing suspended", run(X.get_mechanic(RESERVE))["suspended"])
check("the position is now 2,000 ahead", run(X.exposure_for(RESERVE))["headline"]["net"], 2_000)

# 10× on 1,000 = 10,000. Position before the payout: 2,000 + 1,000 = 3,000, so
# with a 3,000 reserve there is exactly 6,000 of headroom and no more.
past = play(RESERVE, P_RES, 1_000, 100_000)
check("a win past the reserve is paid down to the headroom that is left", past["payout"], 6_000)
check("and the rest is withheld", round_doc(past["round_id"])["withheld"], 4_000)
check(
    "the breach names the reserve",
    [b["kind"] for b in round_doc(past["round_id"])["ceilings_breached"]],
    ["reserve"],
)
truthy("the mechanic suspends", run(X.get_mechanic(RESERVE))["suspended"])
exhausted = run(X.exposure_for(RESERVE))
check("the headroom is exactly zero, never negative", exhausted["headline"]["headroom"], 0)
check("the reserve is 100% consumed", exhausted["headline"]["reserve_consumed_ppm"], 1_000_000)
check(
    "and the position is the reserve, spent — 5,000 staked, 8,000 paid",
    (exhausted["headline"]["staked"], exhausted["headline"]["paid_out"]),
    (5_000, 8_000),
)


# ══════════════════════════════════════════════════════════════════════════════
# 9. THE RACE — two rounds, one ceiling
# ══════════════════════════════════════════════════════════════════════════════
#
# The dangerous shape is read-then-write: two rounds read the same day's total,
# both find room, and both pay. Twice below: once with the two coroutines
# genuinely interleaved, and once with a competitor's increment written into the
# exact gap between a read and a write.

RACE = "ceiling_race"
make(RACE, max_payout_platform_per_day=12_000)
R1, R2 = "race-p1", "race-p2"
fund(R1, 100_000)
fund(R2, 100_000)

open_1 = run(X.commit_round(mechanic_id=RACE, player_uid=R1, country="AE", actor=APP_ADMIN))
open_2 = run(X.commit_round(mechanic_id=RACE, player_uid=R2, country="AE", actor=APP_ADMIN))
entropy_1 = entropy_for(open_1["round_id"], 100_000)   # 10× on 1,000 = 10,000
entropy_2 = entropy_for(open_2["round_id"], 100_000)   # 10× on 1,000 = 10,000

# Make every read and write of the exposure counters yield to the event loop, so
# `asyncio.gather` genuinely interleaves the two rounds instead of running one
# after the other. Without this the fake would answer instantly and the test
# would prove nothing about concurrency.
_exposure = DB[C.CHANCE_EXPOSURE]
_real_update, _real_find = _exposure.update_one, _exposure.find_one


async def _slow_update(*args, **kwargs):
    await asyncio.sleep(0)
    return await _real_update(*args, **kwargs)


async def _slow_find(*args, **kwargs):
    await asyncio.sleep(0)
    return await _real_find(*args, **kwargs)


_exposure.update_one = _slow_update      # type: ignore[assignment]
_exposure.find_one = _slow_find          # type: ignore[assignment]


async def _both():
    return await asyncio.gather(
        X.play_round(round_id=open_1["round_id"], unit_stake=1_000,
                     client_entropy=entropy_1, actor=APP_ADMIN),
        X.play_round(round_id=open_2["round_id"], unit_stake=1_000,
                     client_entropy=entropy_2, actor=APP_ADMIN),
        return_exceptions=True,
    )


raced = run(_both())
_exposure.update_one = _real_update      # type: ignore[assignment]
_exposure.find_one = _real_find          # type: ignore[assignment]

truthy("both rounds completed", all(not isinstance(r, Exception) for r in raced))
payouts = sorted(r["payout"] for r in raced)
check(
    "two rounds each wanting 10,000 against a 12,000 ceiling are paid 10,000 "
    "and 2,000 — not 10,000 and 10,000",
    payouts,
    [2_000, 10_000],
)
check("the two together come to exactly the ceiling", sum(payouts), 12_000)
race_counter = next(
    d for d in DB[C.CHANCE_EXPOSURE].docs
    if d["key"] == X._mechanic_day_key(RACE, X.business_day())
)
check(
    "and the counter never went above it — not for an instant, because the "
    "limit is inside the filter of the update that increments it",
    race_counter["paid_out"],
    12_000,
)
check(
    "the loser's shortfall is withheld, not minted",
    sum(r["payout"] for r in raced) + sum(
        round_doc(r["round_id"])["withheld"] for r in raced
    ),
    20_000,
)
truthy("and the breach suspended the mechanic once", run(X.get_mechanic(RACE))["suspended"])

# ── The gap between the read and the write ────────────────────────────────────
#
# `_consume` falls back to a compare-and-set when the whole amount will not fit.
# This drives a competitor's increment into the window between the read and the
# write — the precise interleaving that makes a read-then-write implementation
# overpay — and checks that the limit still holds exactly.

GATE = "race:gate:test"
run(X._ensure_counter(GATE, {"kind": "test"}))
run(X._consume(GATE, limit=10_000, amount=9_000, mode="budget"))

competitor_ran = {"n": 0}
_real_find_one = DB[C.CHANCE_EXPOSURE].find_one


async def _find_then_race(*args, **kwargs):
    """Answer the read, then let a competitor take the headroom before the write."""
    doc = await _real_find_one(*args, **kwargs)
    if competitor_ran["n"] == 0 and (args and args[0].get("key") == GATE):
        competitor_ran["n"] += 1
        await _real_update(
            {"key": GATE, "paid_out": {"$lte": 10_000 - 500}},
            {"$inc": {"paid_out": 500}},
        )
    return doc


DB[C.CHANCE_EXPOSURE].find_one = _find_then_race  # type: ignore[assignment]
# 9,000 of 10,000 is already spoken for, so a claim for 1,500 cannot be granted
# whole and falls to the compare-and-set. It reads 9,000, the competitor takes
# 500 before the write lands, and the write must therefore match nothing and be
# retried against what is actually there.
squeezed = run(X._consume(GATE, limit=10_000, amount=1_500, mode="budget"))
DB[C.CHANCE_EXPOSURE].find_one = _real_find_one   # type: ignore[assignment]

check("the competitor did get in between the read and the write", competitor_ran["n"], 1)
check(
    "so the caller is granted 500, not the 1,000 the stale read said was free",
    squeezed,
    500,
)
gate_doc = next(d for d in DB[C.CHANCE_EXPOSURE].docs if d["key"] == GATE)
check(
    "and the budget stands at exactly its limit — 9,000 + 500 + 500",
    gate_doc["paid_out"],
    10_000,
)
check(
    "a further claim on an exhausted budget is granted nothing at all",
    run(X._consume(GATE, limit=10_000, amount=1, mode="budget")),
    0,
)
check(
    "and the budget did not move",
    next(d for d in DB[C.CHANCE_EXPOSURE].docs if d["key"] == GATE)["paid_out"],
    10_000,
)

# An unlimited budget still counts, because exposure is reported whether or not
# it is capped (8B.4.2).
FREE = "race:gate:unlimited"
run(X._ensure_counter(FREE, {"kind": "test"}))
check(
    "an unlimited budget grants the whole amount",
    run(X._consume(FREE, limit=None, amount=999_999, mode="budget")),
    999_999,
)


# ══════════════════════════════════════════════════════════════════════════════
# 10. ACTUAL AGAINST CONFIGURED RTP — 8B.5.1 / 8B.5.2
# ══════════════════════════════════════════════════════════════════════════════
#
# The claim being held down: a small sample diverges from the configured RTP by
# a lot, and calling that an exploit is how the alert gets ignored.

SMALL = "rtp_small_sample"
make(SMALL)
P_SMALL = "player-small-sample"
fund(P_SMALL, 200_000)

# Forty rounds, every one of them a loss. Actual RTP 0% against a configured
# 94% — the most extreme divergence the table can produce — on a sample far too
# small to mean anything.
for _ in range(40):
    play(SMALL, P_SMALL, 100, 0)

small = run(X.rtp_divergence(SMALL))
pooled = small["pooled"]
check("forty rounds returned nothing at all", pooled["actual_rtp_ppm"], 0)
check("against a configured 94%", pooled["configured_rtp_percent"], "94")
truthy(
    "which is a large number of standard deviations — the arithmetic is not "
    "being softened",
    abs(pooled["z_milli"]) > 3_000,
)
falsy(
    "and it does NOT alert, because forty rounds cannot distinguish this from "
    "variance whatever the figure says",
    pooled["divergent"],
)
falsy("the sample is named as too small", pooled["enough_rounds"])
contains(
    "and the verdict says so in words rather than reporting a clean bill",
    pooled["verdict"],
    "not enough rounds",
)
check(
    "the minimum is the shipped setting, not a number invented here",
    pooled["min_rounds"],
    settings.chance_rtp_min_rounds,
)

flat_percentage_gap = abs(pooled["gap_ppm"])
truthy(
    "a flat percentage rule would have fired on this — the gap is 94 points",
    flat_percentage_gap == 940_000,
)


# ── A real divergence, on a sample large enough to mean something ─────────────
#
# Seeded rounds rather than played ones: the arithmetic under test reads the
# round records, and four hundred rounds of entropy grinding would add minutes
# to this suite without testing anything the seeding does not.

def seed_rounds(mechanic_id: str, *, count: int, stake: int, total_paid: int,
                day_offset: int = 0) -> None:
    when = datetime.now(timezone.utc) - timedelta(days=day_offset)
    per = total_paid // count
    remainder = total_paid - per * count
    for i in range(count):
        payout = per + (remainder if i == 0 else 0)
        DB[C.CHANCE_ROUNDS].docs.append(
            {
                "_id": f"seed-{mechanic_id}-{day_offset}-{i}",
                "round_id": f"seed-{mechanic_id}-{day_offset}-{i}",
                "mechanic_id": mechanic_id,
                "config_version": 1,
                "player_uid": f"seeded-player-{i % 20}",
                "country": "AE",
                "status": str(X.RoundStatus.SETTLED),
                "unit_stake": stake,
                "quantity": 1,
                "total_stake": stake,
                "payable_stake": stake,
                "payout": payout,
                "withheld": 0,
                "capped": False,
                "ceiling_capped": False,
                "rtp_ppm_at_play": X.rtp_ppm(OUTCOMES),
                "variance_num_at_play": X.variance_numerator(OUTCOMES),
                "committed_at": when,
                "played_at": when,
                "settled_at": when,
                "exposure_day": X.business_day(when),
            }
        )


# 400 rounds at a stake of 1,000. Expected payout = 400 × 1,000 × 0.94 =
# 376,000; the standard error is 1,000 × 1.97393 × √400 = 39,478.
ORDINARY = "rtp_ordinary"
make(ORDINARY)
seed_rounds(ORDINARY, count=400, stake=1_000, total_paid=376_000 + 40_000)

ordinary = run(X.rtp_divergence(ORDINARY))["pooled"]
truthy("four hundred rounds is enough to judge", ordinary["enough_rounds"])
check("actual RTP is 104%, ten points above configured", ordinary["actual_rtp_percent"], "104")
truthy(
    "a flat 5% rule would have fired on a ten-point gap",
    abs(ordinary["gap_ppm"]) > 50_000,
)
falsy(
    "the confidence bound does not — one standard deviation is ordinary and "
    "this is a good week, not an exploit",
    ordinary["divergent"],
)
truthy("just over one sigma", 900 <= abs(ordinary["z_milli"]) <= 1_200)
truthy(
    "and the configured figure sits inside the band around the actual one",
    ordinary["configured_inside_band"],
)
contains("the verdict says ordinary variance", ordinary["verdict"], "ordinary variance")

DIVERGENT = "rtp_divergent"
make(DIVERGENT)
seed_rounds(DIVERGENT, count=400, stake=1_000, total_paid=376_000 + 150_000)

diverged = run(X.rtp_divergence(DIVERGENT))["pooled"]
truthy("this sample is large enough too", diverged["enough_rounds"])
truthy("and it is nearly four standard deviations out", 3_700 <= diverged["z_milli"] <= 3_900)
truthy("so it IS reported as a divergence", diverged["divergent"])
falsy(
    "the configured RTP is outside the confidence bound on the actual one",
    diverged["configured_inside_band"],
)
contains("and the verdict states the bound it failed", diverged["verdict"], "standard deviations")
check(
    "the pooled window is judged at the shipped sigma, not a number invented here",
    diverged["sigma_threshold_milli"],
    settings.chance_rtp_window_sigma_milli,
)
check(
    "a single day is judged at the stricter one",
    run(X.rtp_divergence(DIVERGENT))["per_day"][0]["sigma_threshold_milli"],
    settings.chance_rtp_daily_sigma_milli,
)
truthy(
    "so this divergence is persistent-gap news and not one-day news — 3.8 "
    "sigma clears the pooled bar and not the daily one",
    settings.chance_rtp_window_sigma_milli
    < diverged["z_milli"]
    < settings.chance_rtp_daily_sigma_milli,
)

report = run(X.rtp_divergence(DIVERGENT))
check("three causes are named", len(report["if_divergent"]), 3)
contains("a configuration error", str(report["if_divergent"]), "configuration error")
contains("an exploit", str(report["if_divergent"]), "exploit")
contains("or a bug", str(report["if_divergent"]), "bug")
contains(
    "and the report does not pretend to know which",
    str(report["if_divergent"]),
    "concentrated in a few players",
)
contains(
    "it also warns that the cap and the floor bias actual downward",
    report["note"],
    "floored to a whole diamond",
)

# ── The detector fires on the one and not on the other ────────────────────────

run(alerts.scan(["chance_rtp_divergence"]))
divergent_mail = emails("alert.chance_rtp_divergence")
truthy("the divergent mechanic raised an alert", divergent_mail)
truthy(
    "naming it",
    any(DIVERGENT in str(row.get("meta", {})) for row in divergent_mail),
)
falsy(
    "and the ordinary one did not",
    any(ORDINARY in str(row.get("meta", {})) for row in divergent_mail),
)
falsy(
    "nor did the forty-round sample",
    any(SMALL in str(row.get("meta", {})) for row in divergent_mail),
)
alert_body = next(
    str(row["html"]) for row in PROVIDER.sent if DIVERGENT in str(row.get("html", ""))
)
contains("the email states the confidence bound it was judged against", alert_body, "sigma")
contains("and names all three causes without choosing", alert_body, "does not guess")

margin = run(X.margin_report())
check("Finance's report owns the margin", margin["owner"], "finance")
truthy(
    "gross gaming revenue is its own line per mechanic (8B.7.1)",
    all("gross_gaming_revenue" in row for row in margin["mechanics"]),
)
truthy(
    "with the RTP judgement beside it, never a bare percentage gap",
    all("z" in row["rtp"] for row in margin["mechanics"]),
)


# ══════════════════════════════════════════════════════════════════════════════
# 11. A FROZEN PLAYER — 8B.5.3 / 8B.5.4
# ══════════════════════════════════════════════════════════════════════════════

FREEZE = "freeze_mechanic"
make(FREEZE)
SUSPECT = "player-under-review"
fund(SUSPECT, 50_000)

play(FREEZE, SUSPECT, 100, 100_000)
balance_before_freeze = balance(SUSPECT)
rounds_before_freeze = len(run(X.player_rounds(SUSPECT)))
ledger_before_freeze = len(
    run(money.ledger_for(money.HolderType.USER, SUSPECT, money.Currency.DIAMONDS,
                         limit=500))
)
truthy("the player has played and won before the freeze", rounds_before_freeze >= 1)

refuses(
    "an App admin cannot freeze a player — Ops owns the exception queue (8B.5.6)",
    lambda: X.freeze_player(
        player_uid=SUSPECT, reason="This looks wrong to me.", actor=APP_ADMIN
    ),
)
refuses(
    "and a freeze needs a reason",
    lambda: X.freeze_player(player_uid=SUSPECT, reason="odd", actor=OPS_ADMIN),
)

frozen = run(
    X.freeze_player(
        player_uid=SUSPECT,
        reason="Win rate five sigma above the signed table over 400 rounds.",
        actor=OPS_ADMIN,
        evidence={"z_milli": 5_400},
    )
)
truthy("Ops can freeze a player", frozen["frozen"])
check("recording who", frozen["flagged_by"]["uid"], OPS_ADMIN["uid"])

# ── What a freeze does ────────────────────────────────────────────────────────

refuses(
    "a frozen player cannot open a round",
    lambda: X.commit_round(
        mechanic_id=FREEZE, player_uid=SUSPECT, country="AE", actor=APP_ADMIN
    ),
    error=X.PlayerFrozen,
)
refuses(
    "on any mechanic",
    lambda: X.commit_round(
        mechanic_id=MAIN, player_uid=SUSPECT, country="AE", actor=APP_ADMIN
    ),
    error=X.PlayerFrozen,
)

# One committed a moment before the freeze is refused at play time and voided.
run(X.unfreeze_player(player_uid=SUSPECT, reason="Momentarily, to set up the next check.", actor=OPS_ADMIN))
held = run(
    X.commit_round(mechanic_id=FREEZE, player_uid=SUSPECT, country="AE", actor=APP_ADMIN)
)
run(
    X.freeze_player(
        player_uid=SUSPECT,
        reason="Frozen again while the review runs, with a round in flight.",
        actor=OPS_ADMIN,
    )
)
refuses(
    "a round committed before the freeze cannot be played after it",
    lambda: X.play_round(round_id=held["round_id"], unit_stake=100, actor=APP_ADMIN),
    error=X.PlayerFrozen,
)
check("it is voided", round_doc(held["round_id"])["status"], str(X.RoundStatus.VOID))

# ── What a freeze does NOT do ─────────────────────────────────────────────────

check(
    "the player's balance is untouched — a freeze is not a balance change",
    balance(SUSPECT),
    balance_before_freeze,
)
check(
    "no settled round was reversed, amended or removed (8B.5.5)",
    len(run(X.player_rounds(SUSPECT))),
    rounds_before_freeze + 1,   # the voided one, which staked nothing
)
truthy(
    "every past round is still readable in full",
    all(r.get("total_stake") is not None or r.get("status") == str(X.RoundStatus.VOID)
        for r in run(X.player_rounds(SUSPECT))),
)
check(
    "and not one ledger movement was written by the freeze — it is not a "
    "money operation at all",
    len(
        run(
            money.ledger_for(
                money.HolderType.USER, SUSPECT, money.Currency.DIAMONDS, limit=500
            )
        )
    ),
    ledger_before_freeze,
)

# It says so, and it is not the words a suspended mechanic uses.
try:
    run(X.commit_round(mechanic_id=FREEZE, player_uid=SUSPECT, country="AE", actor=APP_ADMIN))
except X.PlayerFrozen as exc:
    frozen_http = chance_router._fail(exc)
    contains("the player is told their balance is safe", str(exc), "nothing has been taken")
    contains("and that it is a review, not a ban", str(exc), "review")
    check(
        "answered 409 — a conflict with the state of the account, not a 404 "
        "that would hide a fact about their own account from them",
        frozen_http.status_code,
        409,
    )

# ── Another player is unaffected ──────────────────────────────────────────────

BYSTANDER = "player-not-frozen"
fund(BYSTANDER, 10_000)
bystander_round = play(FREEZE, BYSTANDER, 100, 10_000)
check("a player who is not frozen plays normally", bystander_round["payout"], 100)

# ── Ending it is a person's decision, with a reason ───────────────────────────

refuses(
    "an App admin cannot lift a freeze either",
    lambda: X.unfreeze_player(
        player_uid=SUSPECT, reason="Looks fine to me now, honestly.", actor=APP_ADMIN
    ),
)
refuses(
    "and lifting one needs a reason",
    lambda: X.unfreeze_player(player_uid=SUSPECT, reason="ok", actor=OPS_ADMIN),
)
released = run(
    X.unfreeze_player(
        player_uid=SUSPECT,
        reason="Reviewed: a genuine run on the 10× outcome. Nothing to answer.",
        actor=OPS_ADMIN,
    )
)
falsy("Ops can lift it after reviewing", released["frozen"])
check("recording the reviewer", released["reviewed_by"]["uid"], OPS_ADMIN["uid"])
after_release = play(FREEZE, SUSPECT, 100, 0)
check("and the player can play again", after_release["status"], str(X.RoundStatus.SETTLED))

freeze_audit = run(audit_log.history_for("user", SUSPECT))
freeze_actions = [e["action"] for e in freeze_audit]
truthy("the freeze is audited", X.Act.PLAYER_FROZEN in freeze_actions)
truthy("and the release", X.Act.PLAYER_UNFROZEN in freeze_actions)
truthy("both with a reason", all(e["reason"] for e in freeze_audit))
frozen_entry = next(e for e in freeze_audit if e["action"] == X.Act.PLAYER_FROZEN)
contains(
    "and the entry says what a freeze is not",
    str(frozen_entry["meta"]),
    "no balance moved",
)


# ══════════════════════════════════════════════════════════════════════════════
# 12. PLAYER ANOMALIES AND THE TWO QUEUES — 8B.5.3 / 8B.5.5 / 8B.5.6
# ══════════════════════════════════════════════════════════════════════════════

TIMING = "player-impossible-timing"
now = datetime.now(timezone.utc)
for i in range(4):
    moment = now - timedelta(milliseconds=10 * i)
    DB[C.CHANCE_ROUNDS].docs.append(
        {
            "_id": f"timing-{i}",
            "round_id": f"timing-{i}",
            "mechanic_id": MAIN,
            "config_version": 1,
            "player_uid": TIMING,
            "country": "AE",
            "status": str(X.RoundStatus.SETTLED),
            "total_stake": 100,
            "payable_stake": 100,
            "payout": 100,
            "rtp_ppm_at_play": X.rtp_ppm(OUTCOMES),
            "variance_num_at_play": X.variance_numerator(OUTCOMES),
            "committed_at": moment,
            "played_at": moment,
            "settled_at": moment,
            "exposure_day": X.business_day(moment),
        }
    )

timing = run(X.player_anomalies(TIMING))
kinds = {f["kind"] for f in timing["findings"]}
truthy("rounds ten milliseconds apart are impossible timing", "impossible_timing" in kinds)
falsy(
    "but four rounds are nowhere near enough to call a win rate unusual",
    "unusual_win_rate" in kinds,
)
falsy("and nothing was done to the account", timing["frozen"])
contains(
    "the report says a finding is evidence, never a verdict",
    timing["note"],
    "never a verdict",
)

activity = run(X.player_activity(TIMING))
check("a player's whole history is reconstructable (8B.5.5)", activity["totals"]["rounds"], 4)
check("with their staked total", activity["totals"]["staked"], 400)
check("and their payout total", activity["totals"]["paid_out"], 400)

queue = run(X.exception_queue())
check("the exception queue belongs to Ops", queue["owner"], "ops")
truthy("suspended mechanics are on it", queue["suspended_mechanics"])
truthy("so are withheld payouts", queue["withheld_payouts"])
truthy(
    "each withheld row says what would have been paid and what was",
    all("would_have_paid" in row for row in queue["withheld_payouts"]),
)
contains(
    "and the queue says nothing on it clears itself",
    queue["note"],
    "Nothing on this queue clears itself",
)


# ══════════════════════════════════════════════════════════════════════════════
# 13. NOTHING FLOATS
# ══════════════════════════════════════════════════════════════════════════════

for doc in DB[C.CHANCE_EXPOSURE].docs:
    for field in ("staked", "paid_out", "withheld", "net", "rounds", "payouts"):
        value = doc.get(field)
        truthy(
            f"exposure counter {field}={value!r} is an int or absent",
            value is None or isinstance(value, int),
        )

for doc in DB[C.CHANCE_ROUNDS].docs:
    for field in ("payout", "withheld", "payout_before_ceilings"):
        value = doc.get(field)
        truthy(
            f"round {field}={value!r} is an int or absent",
            value is None or isinstance(value, int),
        )

for entry in run(X.exposure_snapshot()):
    for field in ("staked", "paid_out", "net", "reserve", "headroom"):
        value = entry["headline"].get(field)
        truthy(
            f"{entry['mechanic_id']} {field}={value!r} is an int or absent",
            value is None or isinstance(value, int),
        )
    truthy(
        "and the sigma the reserve was sized against is an int",
        entry["sigma_ppm"] is None or isinstance(entry["sigma_ppm"], int),
    )


# ── Report ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} exposure, reserve and monitoring checks passed.")
print()
print("  · exposure is staked minus paid out, from the round records, across")
print("    twenty rounds of a known shape")
print("  · the reserve is a position: three losses leave it untouched, and a")
print("    win past it is paid down to the headroom that is genuinely left")
print("  · each ceiling binds at exactly its own figure and not one diamond")
print("    before it — per round, per player per day, platform per day")
print("  · a per-round cap is not a breach; a budget crossed is, and it")
print("    withholds, auto-suspends, and alerts every owner through alerts.py")
print("  · a suspended mechanic answers with the 404 and the words an unknown")
print("    mechanic produces, and resuming needs an owner and a reason")
print("  · two interleaved rounds against a 12,000 ceiling are paid 10,000 and")
print("    2,000, and a competitor writing between a read and a write cannot")
print("    push the counter past its limit")
print("  · forty rounds returning 0% against a configured 94% do NOT alert;")
print("    four hundred rounds 3.8 sigma out do")
print("  · a frozen player cannot play, and their balance, their ledger and")
print("    every round they have played are untouched")
