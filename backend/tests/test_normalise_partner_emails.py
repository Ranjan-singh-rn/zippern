"""The partner-email normaliser, held to what it must and must not do.

`firestore.rules` binds an agency's own `crmUsers` create and its `crmUid`
back-link to `ownerEmail == request.auth.token.email`, and the seller side binds
the same two writes to `sellers/{id}.email`. Firebase lower-cases the address on
an ID token, and the registration forms did not lower-case the stored one until
the fix earlier today — so every partner whose owner typed a capital letter has
both writes denied by rule, with nothing on any staff screen to say so.

`scripts/normalise_partner_emails.py` finds them and rewrites that one field.
These tests drive the real script end to end: the same `run()` the owner types,
with `sys.argv` set the same way.

Five things they hold it to:

  * it is **dry-run by default**, and a dry run writes nothing at all — no
    Firestore document, no audit entry;
  * `--confirm` normalises the address and **nothing else on the record** —
    not the status, not the balance, not the login;
  * a record whose lower-cased address would **collide** with another record is
    reported and left alone, in both directions (something already holds it,
    and two mis-cased records normalising onto each other);
  * every write is **audited**, by a named machine actor, with a reason;
  * it **refuses with a reason** rather than half-doing the job — a bad
    `--kind`, and a `--limit` it deliberately does not have.

Run:  python3 -m tests.test_normalise_partner_emails
"""

from __future__ import annotations

import asyncio
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db import mongo  # noqa: E402

import scripts.normalise_partner_emails as script  # noqa: E402

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


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
fs = FakeFirestore()
agencies = fs.collection("agencies")
sellers = fs.collection("sellers")
fb._fs = fs

audit_entries: list[dict] = []


async def fake_audit_record(**kwargs):
    if not (kwargs.get("reason") or "").strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")
    audit_entries.append(kwargs)
    return "audit-id"


async def _noop() -> None:
    return None


audit_mod.record = fake_audit_record
script.audit.record = fake_audit_record
mongo.get_db = lambda: db
mongo.connect = _noop
mongo.disconnect = _noop
fb.init = lambda: None


def seed() -> None:
    # ── Agencies ─────────────────────────────────────────────────────────────
    # The reported bug: filed through the public form with a capital, so its
    # owner is denied their own crmUsers document and their own crmUid.
    agencies.document("agency-capital").set({
        "agencyName": "Skyline Talents",
        "ownerName": "Ravi Menon",
        "ownerEmail": "Ravi@Skyline.example",
        "source": "self_signup",
        "status": "pending",
        "isActive": False,
        "totalHosts": 4,
    })
    # Already correct — must be counted and not written.
    agencies.document("agency-fine").set({
        "agencyName": "Northstar Media",
        "ownerEmail": "priya@northstar.example",
        "source": "crm",
        "status": "approved",
    })
    # Mis-cased, but a login is already attached: the repair still buys it the
    # read of its own record, and the printed line must say which case it is.
    agencies.document("agency-linked").set({
        "agencyName": "Harbour Lights",
        "ownerEmail": "Dev@Harbour.example",
        "crmUid": "crm-uid-harbour",
        "source": "agency_created",
        "status": "pending",
    })
    # Collision, direction one: something already holds the lower-cased address.
    agencies.document("agency-dupe-upper").set({
        "agencyName": "Twin One",
        "ownerEmail": "Twin@Two.example",
        "source": "crm",
    })
    agencies.document("agency-dupe-lower").set({
        "agencyName": "Twin Two",
        "ownerEmail": "twin@two.example",
        "source": "self_signup",
    })
    # Collision, direction two: two mis-cased records normalise onto each other,
    # and nothing holds the lower-cased form yet.
    agencies.document("agency-pair-a").set({
        "agencyName": "Pair A",
        "ownerEmail": "Pair@Case.example",
        "source": "crm",
    })
    agencies.document("agency-pair-b").set({
        "agencyName": "Pair B",
        "ownerEmail": "PAIR@case.example",
        "source": "crm",
    })
    # No address at all. Nothing to normalise, and not an error.
    agencies.document("agency-blank").set({
        "agencyName": "Nameless",
        "ownerEmail": "",
        "source": "crm",
    })

    # ── Sellers — the same binding, on a different field name ────────────────
    sellers.document("seller-capital").set({
        "displayName": "Ganesh Coin Mart",
        "email": "Ganesh@Coins.example",
        "source": "crm_admin",
        "coinBalance": 0,
        "isApproved": False,
    })
    sellers.document("seller-fine").set({
        "displayName": "Harbour Coin Counter",
        "email": "counter@harbour.example",
        "source": "self_signup",
    })


seed()

AGENCIES_BEFORE = {k: dict(v) for k, v in agencies.docs.items()}
SELLERS_BEFORE = {k: dict(v) for k, v in sellers.docs.items()}


def run_script(*argv: str, expect: int = 0) -> str:
    """Run the script exactly as the owner would, and return what it printed."""
    saved = sys.argv
    sys.argv = ["normalise_partner_emails.py", *argv]
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            code = script.main()
    finally:
        sys.argv = saved
    check(f"`{' '.join(argv) or '(no flags)'}` exits {expect}", code, expect)
    return buffer.getvalue()


# ══════════════════════════════════════════════════════════════════════════════
# 1. Dry run — finds everything, writes nothing
# ══════════════════════════════════════════════════════════════════════════════

output = run_script()

ok("the dry run announces itself", "DRY RUN — nothing will be written" in output)
ok("it names the mis-cased agency", "Ravi@Skyline.example" in output)
ok("and what it would become", "ravi@skyline.example" in output)
ok("it names the mis-cased seller too", "Ganesh@Coins.example" in output)
ok("it prints a summary", "── Summary ──" in output)
ok("it says what would happen, not what did", "addresses to normalise" in output)
ok("and how to make it happen", "python -m scripts.normalise_partner_emails --confirm" in output)
ok("it says what each repair unblocks", "crmUid back-link" in output)
ok("naming the agency rule by name", "agencyNamesCaller" in output)
ok("and the seller rule by name", "sellerNamesCaller" in output)

check("a dry run writes no agency document", agencies.docs, AGENCIES_BEFORE)
check("and no seller document", sellers.docs, SELLERS_BEFORE)
check("and no audit entry", audit_entries, [])
check("and deletes nothing", agencies.deleted + sellers.deleted, [])

# ── Per-record state, so the line says what the fix buys ─────────────────────
ok("a record with no login says so", "no login attached" in output)
ok("and one that has a login says that instead", "login already attached" in output)

# ── Collisions, both directions, reported and not resolved ───────────────────
ok("collisions get their own section", "Reported, not touched" in output)
ok("the record whose twin already holds the address is named", "agency-dupe-upper" in output)
ok("both records in the pair are named", "agency-pair-a" in output and "agency-pair-b" in output)
ok("and the reason is stated", "would create a duplicate rather than repair" in output)
ok(
    "and it says the decision is a person's",
    "not a decision a script can make" in output,
)
ok(
    "the record that already held the address is NOT proposed for a write",
    "agency-dupe-lower  twin@two.example" not in output,
)

# ── Counted honestly ─────────────────────────────────────────────────────────
ok("records with no address are reported as such", "with no address at all" in output)
ok("already-correct records are counted", "already lower-case" in output)


# ══════════════════════════════════════════════════════════════════════════════
# 2. --confirm — the address, and only the address
# ══════════════════════════════════════════════════════════════════════════════

output = run_script("--confirm")

ok("the write run announces itself", "WRITING" in output)

after = agencies.docs["agency-capital"]
check("the agency address is now lower-case", after["ownerEmail"], "ravi@skyline.example")
check("its name is untouched", after["agencyName"], "Skyline Talents")
check("its owner is untouched", after["ownerName"], "Ravi Menon")
check("its status is untouched", after["status"], "pending")
check("it was not activated", after["isActive"], False)
check("and its host count is untouched", after["totalHosts"], 4)
check(
    "nothing was added to the record either",
    sorted(after.keys()),
    sorted(AGENCIES_BEFORE["agency-capital"].keys()),
)

check(
    "the seller address is now lower-case",
    sellers.docs["seller-capital"]["email"],
    "ganesh@coins.example",
)
check(
    "and the money on it did not move",
    sellers.docs["seller-capital"]["coinBalance"],
    0,
)
check(
    "nor was it approved",
    sellers.docs["seller-capital"]["isApproved"],
    False,
)

check(
    "the already-correct agency was never written",
    agencies.docs["agency-fine"],
    AGENCIES_BEFORE["agency-fine"],
)
check(
    "the colliding pair is untouched",
    (agencies.docs["agency-pair-a"], agencies.docs["agency-pair-b"]),
    (AGENCIES_BEFORE["agency-pair-a"], AGENCIES_BEFORE["agency-pair-b"]),
)
check(
    "and so is the record that already held the duplicated address",
    agencies.docs["agency-dupe-lower"],
    AGENCIES_BEFORE["agency-dupe-lower"],
)
check(
    "the record that would have duplicated it is untouched too",
    agencies.docs["agency-dupe-upper"],
    AGENCIES_BEFORE["agency-dupe-upper"],
)
check("the blank one is untouched", agencies.docs["agency-blank"], AGENCIES_BEFORE["agency-blank"])
check("nothing anywhere was deleted", agencies.deleted + sellers.deleted, [])

# ── Audited ──────────────────────────────────────────────────────────────────
check("one audit entry per write", len(audit_entries), 3)
check(
    "under its own action",
    sorted({e["action"] for e in audit_entries}),
    ["partner.email_normalised"],
)
ok("every entry carries a reason", all(e["reason"].strip() for e in audit_entries))
ok(
    "the actor is a named machine, not a borrowed person",
    all(e["actor"]["uid"] == "system:normalise_partner_emails" for e in audit_entries),
)
ok(
    "before and after are the address, so the change is legible",
    all(
        list(e["before"].values())[0].lower() == list(e["after"].values())[0]
        for e in audit_entries
    ),
)
ok(
    "and the entry says what the repair unblocked",
    all("unblocks" in e["meta"] for e in audit_entries),
)
check(
    "the subject is the partner record itself",
    sorted(e["subject_id"] for e in audit_entries),
    ["agency-capital", "agency-linked", "seller-capital"],
)

# ── Idempotent ───────────────────────────────────────────────────────────────
audit_entries.clear()
output = run_script("--confirm")
ok("a second run finds nothing left to do", "Nothing needed normalising" in output)
check("and writes no further audit entry", audit_entries, [])
ok("but it still reports the collisions", "Reported, not touched" in output)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Refusals — with a reason, before anything is read
# ══════════════════════════════════════════════════════════════════════════════

output = run_script("--kind", "partners", expect=1)
ok("a --kind it does not have is refused", "--kind must be one of" in output)
ok("and the options are named", "agencies" in output and "sellers" in output)

output = run_script("--limit", "10", expect=1)
ok("--limit is refused rather than ignored", "There is no --limit" in output)
ok(
    "because a partial scan cannot answer the collision question",
    "could only guess" in output,
)

# ── One collection at a time ─────────────────────────────────────────────────
output = run_script("--kind", "sellers")
ok("scanning one collection says so", "Scanning: sellers" in output)
ok("and does not read the other", "agencies" not in output.split("── Summary ──")[0])


# ══════════════════════════════════════════════════════════════════════════════

print()
if failures:
    print(f"  ✗ {len(failures)} of {checks} checks failed\n")
    for line in failures:
        print(f"    · {line}")
    print()
    sys.exit(1)

print(f"  ✓ all {checks} checks passed\n")
