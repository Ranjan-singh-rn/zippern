"""The wholesale price, and the two things it must never break.

A coin seller buys diamonds from Zipper at a discount and resells them at the
retail price, keeping the difference — which they collect from the buyer
directly, so it never touches this business.

That gives the product two diamond prices where it previously had one, and the
distinction decides what every money report says:

  * Zipper's cash from a lakh of diamonds is the **wholesale** price. That is
    what a seller transferred and what landed in the bank.
  * The **retail** price is what the seller's customer paid the seller. Zipper
    never receives it.

Valuing consumed diamonds at retail therefore claims income that was never
collected, and it flows into revenue, profit, margin and the bean-payout ratio.

Every other test in this suite constructs `Rates` with wholesale equal to
retail, because none of them is about the discount — which means none of them
would notice if the wholesale path were wrong, or silently reverted. This file
is the one that sets the two apart and asserts the difference.

Run:  python3 -m tests.test_wholesale_price
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.services import reports as R  # noqa: E402
from app.services.money import Currency  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


NOW = datetime(2026, 8, 26, tzinfo=timezone.utc)

#: The owner's own worked example: users pay ₹2,390 a lakh, sellers pay ₹2,000.
DISCOUNTED = R.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    seller_wholesale_price_inr_per_lakh=2000.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="test",
    fetched_at=NOW,
)

#: No discount configured — the state every existing deployment is in.
NO_DISCOUNT = R.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    seller_wholesale_price_inr_per_lakh=2390.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="test",
    fetched_at=NOW,
)

LAKH = 100_000


# ══════════════════════════════════════════════════════════════════════════════
# 1. The margin, and that it is never negative
# ══════════════════════════════════════════════════════════════════════════════

check("a seller keeps the spread", DISCOUNTED.seller_margin_inr_per_lakh, 390.0)
check("no discount means no margin", NO_DISCOUNT.seller_margin_inr_per_lakh, 0.0)

# A wholesale price above retail is a typo, not a price. `load_rates` clamps it,
# but the property must not produce a negative margin even if one gets through —
# a negative here would be reported as Zipper paying the seller to take stock.
inverted = R.Rates(2000.0, 2390.0, 0.01, "firestore", False, [], "", NOW)
check("an inverted pair never yields a negative margin",
      inverted.seller_margin_inr_per_lakh, 0.0)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Diamonds are valued at wholesale — that is Zipper's money
# ══════════════════════════════════════════════════════════════════════════════

wholesale_minor, rule = R.to_inr_minor(LAKH, str(Currency.DIAMONDS), DISCOUNTED)
check("a lakh of diamonds is worth what Zipper was paid for it",
      wholesale_minor, 200_000)
ok("and the rule says which price was applied", "wholesale" in rule)

retail_minor, retail_rule = R.to_inr_minor(
    LAKH, str(Currency.DIAMONDS), DISCOUNTED, retail=True
)
check("retail is available where the question is what a user paid",
      retail_minor, 239_000)
ok("and it says so too", "retail" in retail_rule)

ok("the two differ by exactly the seller's margin",
   retail_minor - wholesale_minor == int(DISCOUNTED.seller_margin_inr_per_lakh * 100))

# Coins are the seller-side name for the same thing and must value identically.
coins_minor, _ = R.to_inr_minor(LAKH, str(Currency.COINS), DISCOUNTED)
check("coins value the same as diamonds", coins_minor, wholesale_minor)

# The magnitude of the error this replaces, asserted so nobody re-introduces it
# thinking it is small.
overstatement = (retail_minor - wholesale_minor) / wholesale_minor
ok("valuing at retail would overstate by more than 19%", overstatement > 0.19)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Nothing changes for a business with no discount configured
# ══════════════════════════════════════════════════════════════════════════════
# This is the safety property. Every existing report, every stored weekly
# document and every other test in this suite was computed with one price; with
# no discount set, the new code must produce exactly what the old code did.

for currency in (Currency.DIAMONDS, Currency.COINS):
    plain, _ = R.to_inr_minor(LAKH, str(currency), NO_DISCOUNT)
    as_retail, _ = R.to_inr_minor(LAKH, str(currency), NO_DISCOUNT, retail=True)
    check(f"{currency}: wholesale and retail agree when no discount is set",
          (plain, as_retail), (239_000, 239_000))

# Beans are a payout, not a purchase. The diamond discount must not touch them.
beans_a, _ = R.to_inr_minor(10_000, str(Currency.BEANS), DISCOUNTED)
beans_b, _ = R.to_inr_minor(10_000, str(Currency.BEANS), NO_DISCOUNT)
check("beans are unaffected by the diamond discount", (beans_a, beans_b), (10_000, 10_000))
check("and they use the bean rate", beans_a, int(10_000 * 0.01 * 100))


# ══════════════════════════════════════════════════════════════════════════════
# 4. The bean-payout ratio moves in the honest direction
# ══════════════════════════════════════════════════════════════════════════════
# "Of every rupee of diamonds consumed, this much left as host payouts", and
# the definition says lower is better. Retail inflates the denominator, so the
# old figure flattered the business on its own headline profitability measure.

diamonds_consumed = LAKH
beans_paid = 10_000

bean_value, _ = R.to_inr_minor(beans_paid, str(Currency.BEANS), DISCOUNTED)
honest_den, _ = R.to_inr_minor(diamonds_consumed, str(Currency.DIAMONDS), DISCOUNTED)
flattering_den, _ = R.to_inr_minor(
    diamonds_consumed, str(Currency.DIAMONDS), DISCOUNTED, retail=True
)

honest = bean_value / honest_den
flattering = bean_value / flattering_den

ok("the honest ratio is HIGHER than the retail-valued one", honest > flattering)
check("and the wholesale ratio is 5.00%", round(honest * 100, 2), 5.0)
check("where retail would have reported 4.18%", round(flattering * 100, 2), 4.18)


# ══════════════════════════════════════════════════════════════════════════════
# 5. A rate outage gives no discount rather than inventing one
# ══════════════════════════════════════════════════════════════════════════════

fallback = R._fallback_rates("the test asked for it.", ["diamondPackPriceInr"])
check("a fallback never discounts",
      fallback.seller_wholesale_price_inr_per_lakh,
      fallback.diamond_pack_price_inr_per_lakh)
check("so a fallback margin is zero", fallback.seller_margin_inr_per_lakh, 0.0)
ok("and it is still marked provisional", fallback.provisional)


# ══════════════════════════════════════════════════════════════════════════════
# 6. Both prices are published, so a reader can see which was applied
# ══════════════════════════════════════════════════════════════════════════════

published = DISCOUNTED.as_dict()
for key in (
    "diamond_pack_price_inr_per_lakh",
    "seller_wholesale_price_inr_per_lakh",
    "seller_margin_inr_per_lakh",
):
    ok(f"the rate block publishes {key}", key in published)
check("and the margin it publishes is the real one",
      published["seller_margin_inr_per_lakh"], 390.0)


# ── Result ────────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"\nAll {checks} wholesale-price checks passed.")
print("  · a seller's margin is retail minus wholesale, never negative")
print("  · diamonds are valued at what Zipper was paid, not at what a user paid")
print("  · a business with no discount configured is bit-for-bit unchanged")
print("  · the bean-payout ratio no longer flatters the business")
print("  · a rate outage discounts nothing\n")
