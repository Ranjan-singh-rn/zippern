"""Stamp the Storage role claim onto accounts that already exist.

``storage.rules`` now authorises on ``request.auth.token.role``. That claim is
written when a staff account is invited, when a role changes, and by the
``syncStorageRoleClaim`` Firestore trigger when a partner's ``crmUsers``
document is written. None of those has run for anybody who signed up before
the claim existed — so on the day the rules deploy, every current member of
staff and every current partner is refused every document until something
touches their record.

This is that something. It is provisioning, not migration: no document moves
and no stored value changes. Only Firebase custom claims are written.

── WHY STAFF AND PARTNERS ARE READ FROM DIFFERENT PLACES ─────────────────────

The same reason they are provisioned differently at runtime. Internal roles
come from the Mongo ``staff`` collection, which no client can write. Partner
roles come from ``crmUsers``, which is client-written and is therefore read
through the same ``partnerClaimFrom`` allowlist the trigger uses — it can
emit ``agency`` and ``seller`` and nothing else, so a ``crmUsers`` document
carrying ``role: 'owner'`` produces no claim here either.

    python3 -m scripts.backfill_storage_claims            # report only
    python3 -m scripts.backfill_storage_claims --apply    # write them

Dry by default, and it prints every change it would make. Re-running is safe:
``storage_claims`` skips a write when the claim is already correct.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import sys
from pathlib import Path

# ── Run me with the project's interpreter, not the system one ───────────────
#
# This script imports `firebase_admin` three frames down, so running it with
# the wrong Python fails as a bare `ModuleNotFoundError: No module named
# 'firebase_admin'` pointing at app/db/firebase.py — a stack trace about a
# library, for what is actually "you are in the wrong virtualenv". An operator
# running a production backfill under time pressure should not have to work
# that out.
#
# `sys.modules` is consulted first so the test harness, which installs stubs
# before importing this module, passes straight through.
if "firebase_admin" not in sys.modules and importlib.util.find_spec("firebase_admin") is None:
    _venv = Path(__file__).resolve().parents[1] / ".venv"
    _hint = (
        f"    source {_venv}/bin/activate\n"
        f"    python3 -m scripts.backfill_storage_claims\n\n"
        f"  or without activating:\n\n"
        f"    {_venv}/bin/python -m scripts.backfill_storage_claims\n"
    )
    print(
        f"\nWRONG INTERPRETER — this is {sys.executable}\n"
        f"  (Python {sys.version.split()[0]}), which has no `firebase_admin`.\n\n"
        f"  The project pins Python 3.12 (.python-version) and keeps its\n"
        f"  dependencies in backend/.venv. Run:\n\n{_hint}\n"
        f"  If activation fails because python@3.12 is gone, restore it with\n"
        f"  `brew install python@3.12` — the venv symlinks to it. Do NOT rebuild\n"
        f"  the venv on a newer Python just to get past this: firebase-admin\n"
        f"  6.6.0 and google-cloud-firestore 2.28.1 are pinned to versions that\n"
        f"  are known to read this project's Firestore.\n",
        file=sys.stderr,
    )
    raise SystemExit(2)

from app.core.roles import INTERNAL_ROLES, Role
from app.db import firebase, mongo
from app.db.mongo import C, get_db
from app.services import storage_claims

#: The only roles this script will put on a partner. Mirrors
#: `PARTNER_CLAIM_ROLE` in functions/src/storageClaims.ts — deliberately a
#: whitelist, so a `crmUsers` document naming an internal role is ignored
#: rather than honoured.
PARTNER_ROLES = {"agency": "agency", "seller": "seller"}


async def staff_rows() -> list[dict]:
    db = get_db()
    return [r async for r in db[C.STAFF].find({})]


def partner_docs() -> list[tuple[str, dict]]:
    col = firebase.firestore_client().collection("crmUsers")
    return [(d.id, d.to_dict() or {}) for d in col.stream()]


def agency_kinds() -> dict[str, str]:
    """`agencyId -> 'agency' | 'sub_agency'`, for the report only.

    A sub-agency and a main agency get the IDENTICAL claim — role 'agency'
    scoped to their own id — because that is what `storage.rules` needs and a
    sub-agency inherits nothing from its parent. This map exists so the dry
    run can say how many of each it is about to stamp, and is deliberately
    kept out of `plan()`'s claim decision: a classification used for counting
    must not be able to change what gets written.
    """
    col = firebase.firestore_client().collection("agencies")
    out: dict[str, str] = {}
    for d in col.stream():
        data = d.to_dict() or {}
        is_sub = bool(str(data.get("parentAgencyId", "") or "").strip()) \
            or str(data.get("type", "")).strip() == "sub"
        out[d.id] = "sub_agency" if is_sub else "agency"
    return out


def plan(
    staff: list[dict],
    crm: list[tuple[str, dict]],
    kinds: dict[str, str] | None = None,
) -> tuple[list[tuple[str, str, str, str, str]], list[str], list[tuple[str, str, str]]]:
    """What the backfill would do, as data. No I/O, so it is testable.

    Returns `(planned, problems)` where each planned entry is
    `(uid, who, role, aid, note)` and `role == ""` means "clear the claim".

    The two sources are read differently on purpose. Staff roles come from the
    Mongo row and are validated against `Role`; partner roles come from
    `crmUsers`, which is CLIENT-WRITTEN, and are passed through `PARTNER_ROLES`
    — a whitelist of exactly two keys. There is no input to this function that
    produces an internal claim from the Firestore side.
    """
    planned: list[tuple[str, str, str, str, str]] = []
    problems: list[str] = []
    #: (uid, who, why) for every identity examined that earns no claim.
    no_claim: list[tuple[str, str, str]] = []
    staff_uids = {str(r.get("uid", "")).strip() for r in staff}
    #: uids the staff loop has already claimed. Mongo is authoritative for an
    #: internal identity, so the partner loop must not plan over one.
    internal_uids: set[str] = set()

    for row in staff:
        uid = str(row.get("uid", "")).strip()
        if not uid:
            problems.append(
                f"staff row with no uid (email={row.get('email','?')!r}) — skipped"
            )
            no_claim.append(("(no uid)", str(row.get("email", "")), "staff row has no uid"))
            continue
        raw_role = str(row.get("role", ""))
        try:
            role = Role(raw_role)
        except ValueError:
            # An unrecognised role is reported and skipped, never guessed at.
            # Guessing here would be guessing at an authorisation token.
            problems.append(f"staff {uid}: unknown role {raw_role!r} — skipped")
            no_claim.append((uid, str(row.get("email", "")), f"unknown role {raw_role!r}"))
            continue
        if role not in INTERNAL_ROLES:
            problems.append(f"staff {uid}: {raw_role} is not internal — skipped")
            no_claim.append((uid, str(row.get("email", "")), f"{raw_role} is not an internal role"))
            continue
        active = bool(row.get("is_active", True))
        internal_uids.add(uid)

        # ── The observer cannot hold a claim, and that is by design ─────────
        #
        # It has NO FIREBASE ACCOUNT. `scripts/seed_accounts.py` creates it
        # with the synthetic uid `observer:<email>` and no credential, and
        # `core/security.py` REFUSES a Firebase-token observer session
        # outright — that was a live hole once, because the address is
        # unclaimed in Firebase precisely because there is no account, so
        # anyone who could sign in with that Gmail was minting observer
        # sessions. The only door is the emailed code at /observer.
        #
        # A custom claim is a property of a Firebase user, so there is nothing
        # here to stamp. Planning it anyway would call `get_user()` on a uid
        # that cannot exist, print `FAILED`, and exit 1 — turning a correct,
        # expected condition into a red production run that hides any real
        # failure beside it.
        #
        # Nothing is lost. The observer reads documents through
        # `/api/documents/...` on its OTP-derived API session, where
        # `services/documents._may_see` names `Role.OBSERVER` explicitly.
        if role is Role.OBSERVER:
            no_claim.append((
                uid, str(row.get("email", "")),
                "observer has no Firebase account by design — no claim is "
                "possible; it reads documents through the API session",
            ))
            continue

        planned.append((uid, str(row.get("email", "")), "" if not active else str(role),
                        "", f"src=mongo:{raw_role}" + ("" if active else " INACTIVE")))

    for uid, d in crm:
        uid = str(uid).strip()
        if not uid:
            continue
        raw = d.get("role")
        role = PARTNER_ROLES.get(raw) if isinstance(raw, str) else None
        if not role:
            # Internal, unknown, or not a string. Not this script's to grant:
            # an internal role here would come from a client-written document.
            #
            # Said out loud when it LOOKS internal and no staff row covered
            # it. That combination is a real operational fault — a member of
            # staff with a `crmUsers` document and no Mongo row signs into the
            # CRM shell and fails every API call (see the note in
            # zipper-crm/lib/auth.ts) — and it would otherwise leave here
            # silently, with the person simply having no claim and nobody
            # told why. It is NOT granted from here either way.
            no_claim.append((uid, str(d.get("email", "")),
                             f"crmUsers role {raw!r} is not a partner role"))
            if isinstance(raw, str) and raw.strip() and uid not in staff_uids:
                problems.append(
                    f"crmUsers {uid}: role {raw!r} is not a partner role and no "
                    "Mongo staff row covers this uid — no claim granted. If this "
                    "is staff, repair the staff record; a claim must not come "
                    "from a client-written document."
                )
            continue
        # ── Mongo wins. A uid with BOTH a staff row and a partner document
        # would otherwise be planned twice, and `--apply` runs the plan in
        # order — so the partner entry would land second and silently
        # DOWNGRADE a member of staff to an `agency` claim. Not an escalation
        # (the partner claim grants less) but a real loss of access, and
        # exactly the conflict worth refusing rather than resolving by luck
        # of iteration order.
        if uid in internal_uids:
            problems.append(
                f"CONFLICT {uid} ({d.get('email','?')}): has a Mongo staff row AND a "
                f"crmUsers partner role {raw!r}. The internal claim from the staff "
                "row is kept and the partner claim is NOT planned. One identity "
                "cannot be both — decide which this account is and remove the other."
            )
            no_claim.append((uid, str(d.get("email", "")),
                             "partner claim refused — staff row is authoritative"))
            continue

        if d.get("isActive") is False:
            planned.append((uid, str(d.get("email", "")), "", "",
                            f"src=crmUsers:{raw} INACTIVE"))
            continue
        aid = str(d.get("agencyId", "") or "").strip()

        # An agency login with no `agencyId` is a broken record, not a broken
        # claim. `isAgencyFor()` requires `agencyClaim() != ''`, so the claim
        # below grants access to no agency prefix at all — fail-safe, and
        # also useless: that partner cannot upload its own KYC. Reported so
        # the record gets repaired, and still planned, because the claim is
        # harmless and withholding it would take away the one thing it does
        # legitimately grant (their own /profile photo).
        if role == "agency" and not aid:
            problems.append(
                f"crmUsers {uid}: role 'agency' with no agencyId — the claim "
                "will scope to nothing, so this login cannot reach its own KYC. "
                "Repair `agencyId` on the crmUsers document."
            )

        kind = (kinds or {}).get(aid, role) if role == "agency" else role
        planned.append((uid, str(d.get("email", "")), role, aid,
                        f"src=crmUsers:{raw} {kind}"))

    return planned, problems, no_claim


async def main() -> int:
    """Open the two clients the way the application does, then run the plan.

    ── WHY THIS IS NOT JUST `firebase.init()` ──────────────────────────────

    It was, and the script died on its first real run with
    `RuntimeError: Mongo client not initialised — call connect() first`.
    `app/db/mongo.py` holds a module-level `_client` that stays None until
    `connect()` is awaited; `get_db()` refuses rather than quietly building
    one, which is the right design and is exactly what caught this.

    The order and the pairing below are copied from `app/main.py`'s
    `lifespan` and from the seven sibling scripts that already do it —
    `backfill_partners`, `inspect_identity`, `link_owner_identities`,
    `list_access`, `normalise_partner_emails`, `purge_app_balances`,
    `repair_partner_logins`. This script was the only one in `scripts/`
    missing it.

    `disconnect()` in a `finally`: Motor keeps the event loop alive with its
    monitoring tasks, so a script that returns without closing the client can
    hang on exit or emit "Task was destroyed but it is pending" — and the
    failure path, where the operator most wants a clean exit, is the one that
    skips a plain trailing call.

    ── WHAT `connect()` WRITES, SAID PLAINLY ───────────────────────────────

    `mongo.connect()` ends with `ensure_indexes()`, which issues about thirty
    `create_index` commands. That is DDL, and it is not nothing — so the
    honest claim is not "this process writes zero bytes". It is:

      * no DOCUMENT is created, updated or deleted, in Mongo or Firestore;
      * no Firebase custom claim is touched — `setCustomUserClaims` is
        unreachable without `--apply`;
      * `create_index` is idempotent ("Safe to run repeatedly") and is
        already run by every API start and every sibling script, so on a
        live system it matches existing indexes and rebuilds nothing.

    Skipping `ensure_indexes()` to make the claim tidier would mean building
    a second, bespoke Mongo client for this script — a different
    initialisation path from the application's, which is the thing most
    likely to behave differently from production on the day it matters.
    """
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the claims")
    args = ap.parse_args()

    firebase.init()
    await mongo.connect()
    try:
        return await _run(args)
    finally:
        await mongo.disconnect()


async def _run(args: argparse.Namespace) -> int:
    staff = await staff_rows()
    crm = partner_docs()
    kinds = agency_kinds()
    planned, problems, no_claim = plan(staff, crm, kinds)

    # Two logins scoped to one agency. Legitimate in principle (a handover),
    # worth seeing before stamping both.
    seen_aid: dict[str, str] = {}
    for uid, who, role, aid, note in planned:
        if role == "agency" and aid:
            if aid in seen_aid:
                problems.append(
                    f"DUPLICATE agency scope {aid}: claimed by both {seen_aid[aid]} "
                    f"and {uid} ({who}). Both will be stamped — confirm this is "
                    "a deliberate shared login and not a stale account."
                )
            else:
                seen_aid[aid] = uid

    print("\n" + "=" * 78)
    print("REAL PRODUCTION DRY-RUN — read only, nothing written")
    print("=" * 78)
    print(f"Staff examined             : {len(staff)}")
    print(f"Partner identities examined: {len(crm)}")
    print(f"Planned mutations          : {len(planned)}")

    grants = [r for r in planned if r[2]]
    clears = [r for r in planned if not r[2]]

    print(f"\n── PLANNED MUTATIONS ({len(grants)} grants) " + "─" * 30)
    for uid, who, role, aid, note in grants:
        print(f"  {uid:30} {who:30} {note:34} -> role={role:16} aid={aid or '(empty)'}")

    print(f"\n── CLAIMS CLEARED ({len(clears)}) " + "─" * 40)
    for uid, who, role, aid, note in clears:
        print(f"  {uid:30} {who:30} {note:34} -> claim REMOVED")
    if not clears:
        print("  (none)")

    print(f"\n── NO PRIVILEGED CLAIM ({len(no_claim)}) " + "─" * 36)
    for uid, who, why in no_claim:
        print(f"  {uid:30} {who:30} {why}")
    if not no_claim:
        print("  (none)")

    # ── The summary, broken out the way the claim itself is ─────────────────
    #
    # Counted from the PLAN, not re-derived from the sources, so these numbers
    # describe exactly what `--apply` would do and cannot drift from it.
    def count(pred) -> int:
        return sum(1 for row in planned if pred(row))

    internal = count(lambda r: r[2] not in ("", "agency", "seller"))  # noqa: E501
    # `in`, not `startswith`: the note now leads with the source
    # (`src=crmUsers:agency sub_agency`), and a counter keyed on the prefix
    # silently reported zero sub-agencies.
    agency = count(lambda r: r[2] == "agency" and "sub_agency" not in r[4])
    sub = count(lambda r: r[2] == "agency" and "sub_agency" in r[4])
    seller = count(lambda r: r[2] == "seller")
    cleared = count(lambda r: r[2] == "")
    print("\n── SUMMARY " + "─" * 60)
    print(f"  internal (owner/observer/dept)  : {internal}")
    print(f"  agency                          : {agency}")
    print(f"  sub-agency                      : {sub}")
    print(f"  coin seller                     : {seller}")
    print(f"  claims CLEARED (inactive)       : {cleared}")
    print(f"  no privileged claim granted     : {len(no_claim)}")
    print(f"  warnings                        : {len(problems)}")

    print(f"\n── WARNINGS ({len(problems)}) " + "─" * 48)
    for p in problems:
        print(f"  ! {p}")
    if not problems:
        print("  (none)")

    if not args.apply:
        print(
            "\n" + "=" * 78
            + "\nDRY RUN COMPLETE — ZERO WRITES."
            "\n  setCustomUserClaims was NOT called."
            "\n  No Firestore document was written. No Mongo document was written."
            "\n  The only operations performed were staff.find({}), crmUsers.stream()"
            "\n  and agencies.stream() — all reads."
            "\nRe-run with --apply to write these claims.\n" + "=" * 78 + "\n"
        )
        return 0

    print("\nwriting…")
    failed = 0
    for uid, who, role, aid, note in planned:
        if role in PARTNER_ROLES:
            problem = await asyncio.to_thread(
                storage_claims.apply_partner, uid, role, aid
            )
        elif role:
            problem = await asyncio.to_thread(storage_claims.apply_for_role, uid, role)
        else:
            problem = await asyncio.to_thread(storage_claims.clear, uid)

        if problem:
            failed += 1
            print(f"  FAILED {uid}: {problem}")

    print(f"\n{len(planned) - failed} written, {failed} failed.")
    print(
        "Claims reach a client on its next ID-token refresh — within the hour, "
        "or immediately when the CRM calls getIdToken(true) at sign-in.\n"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
