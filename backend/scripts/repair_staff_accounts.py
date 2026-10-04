"""Put half-created staff accounts back together.

    python -m scripts.repair_staff_accounts              # dry run
    python -m scripts.repair_staff_accounts --confirm    # write the repairs
    python -m scripts.repair_staff_accounts --only crm   # one direction only
    python -m scripts.repair_staff_accounts --only mongo

A working staff account is two records:

  * Mongo `staff`            — what the API reads to authorise every call
  * Firestore `crmUsers/{uid}` — what the CRM shell reads to resolve a role

Until `app/services/crm_directory.py` existed, no creation path wrote both. The
CRM's own /team screen wrote Firestore only, so the account opened the shell,
rendered every tab and then reported that it could not load data on every
API-backed screen. `POST /staff` wrote Mongo only, so the account could not get
past the CRM login at all. Both kinds are already out there. This finds them and
writes the missing half:

  * a staff row with no `crmUsers` document → the document is written, from the
    role the staff row already holds;
  * a `crmUsers` document with no staff row → the row is created, **preserving
    the role the document already carries**. No role is promoted, demoted or
    invented here; this script makes an identity exist in both places and
    changes nothing about what it may do.

Anything it cannot repair is reported rather than guessed at — a document whose
id names no Firebase Auth account, a role with no counterpart, an account whose
two halves disagree about which uid it is.

**The observer is never written to.** It deliberately holds no `crmUsers`
document (see `NOT_MIRRORED` in app/services/crm_directory.py), so "missing" is
the correct state for it and repairing it would hand a read-only account full
write access on every Firestore-backed page. This script verifies that the
observer still has no document and says so out loud, and it is the seed script —
not this one — that removes a stray one.

Dry run by default. Nothing is written without `--confirm`.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.core import audit  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase, mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

# The unattended credential this script wears in the audit log. `system` is
# deliberately not a `Role` (see app/core/roles.py) — it is a label, not an
# identity that can sign in, and every authority predicate answers "no" for it.
ACTOR = {
    "uid": "system:repair_staff_accounts",
    "name": "scripts/repair_staff_accounts.py",
    "role": "system",
    "team": None,
}

REASON = (
    "Repair — this account existed in one of the two places a staff account has "
    "to exist in, so it could sign in to one half of the CRM and was refused by "
    "the other. The missing half was written from the record that already "
    "existed; no role was changed."
)

DIRECTIONS = ("both", "crm", "mongo")


# ══════════════════════════════════════════════════════════════════════════════
#  What the survey found
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Repair:
    """One account that is missing a half, and which half."""

    kind: str          # "write_crm_document" | "create_staff_row"
    uid: str
    email: str
    name: str
    role: Role
    note: str = ""
    #: The Firestore document, when the repair is in the Mongo direction.
    source: dict = field(default_factory=dict)

    @property
    def line(self) -> str:
        where = "crmUsers" if self.kind == "write_crm_document" else "staff"
        tail = f"  — {self.note}" if self.note else ""
        return f"{self.email:<36} {str(self.role):<17} → {where}{tail}"


@dataclass(slots=True)
class Blocked:
    """One account this script will not guess at."""

    email: str
    where: str         # where the half that does exist lives
    why: str


@dataclass(slots=True)
class Survey:
    repairs: list[Repair] = field(default_factory=list)
    blocked: list[Blocked] = field(default_factory=list)
    healthy: list[str] = field(default_factory=list)
    external: list[str] = field(default_factory=list)
    #: (email, has a document?, what the document said) for every observer.
    observers: list[tuple[str, bool, str]] = field(default_factory=list)
    staff_rows: int = 0
    crm_documents: int = 0


# ══════════════════════════════════════════════════════════════════════════════
#  Survey — reads both sides, writes nothing
# ══════════════════════════════════════════════════════════════════════════════


def _role_of(row: dict) -> Role | None:
    try:
        return Role(str(row.get("role", "")))
    except ValueError:
        return None


async def survey(direction: str = "both") -> Survey:
    """Compare the two halves. This never writes."""
    found = Survey()

    documents = await asyncio.to_thread(crm.all_documents)
    found.crm_documents = len(documents)
    by_uid: dict[str, dict] = {doc_id: data for doc_id, data in documents}
    by_email: dict[str, tuple[str, dict]] = {}
    for doc_id, data in documents:
        email = str(data.get("email", "")).strip().lower()
        if email:
            by_email.setdefault(email, (doc_id, data))

    rows: list[dict] = []
    async for row in mongo.get_db()[C.STAFF].find({}):
        rows.append(row)
    found.staff_rows = len(rows)
    staff_by_email = {
        str(r.get("email", "")).strip().lower(): r for r in rows if r.get("email")
    }

    # ── Direction one: a staff row with no crmUsers document ─────────────────
    for row in rows:
        email = str(row.get("email", "")).strip().lower()
        uid = str(row.get("uid", ""))
        role = _role_of(row)

        if role is None:
            found.blocked.append(
                Blocked(
                    email or uid,
                    "staff",
                    f"its role is {row.get('role')!r}, which is not a role this "
                    "system has. Nothing can be written for it.",
                )
            )
            continue

        if role is Role.OBSERVER:
            # Never written to. Verified, and reported either way.
            existing = await asyncio.to_thread(crm.find_by_email, email)
            found.observers.append(
                (
                    email,
                    bool(existing),
                    ", ".join(
                        f"crmUsers/{doc_id} role={data.get('role')!r}"
                        for doc_id, data in existing
                    ),
                )
            )
            continue

        if role in crm.NOT_MIRRORED:
            found.external.append(f"{email} ({role}) — {crm.NOT_MIRRORED[role]}")
            continue

        if direction == "mongo":
            continue

        if uid and uid in by_uid:
            found.healthy.append(email)
            continue

        # No document under the staff uid. Is there one under another id?
        elsewhere = by_email.get(email)
        if elsewhere is not None:
            found.blocked.append(
                Blocked(
                    email,
                    "both",
                    f"the staff row says uid {uid!r} and the CRM document is "
                    f"crmUsers/{elsewhere[0]}. A document is reachable only "
                    "under the uid its holder signs in with, so one of these is "
                    "wrong and picking is not this script's decision.",
                )
            )
            continue

        # The document has to be written under the Firebase uid, or nobody can
        # ever reach it.
        auth_user = await asyncio.to_thread(firebase.get_user_by_email, email)
        if auth_user is None:
            found.blocked.append(
                Blocked(
                    email,
                    "staff",
                    "there is no Firebase Auth account for this address, so "
                    "there is no uid to file a CRM document under and nobody "
                    "could sign in with it. Invite them again, or create the "
                    "auth account in the Firebase console first.",
                )
            )
            continue

        note = ""
        if auth_user.uid != uid:
            note = (
                f"filed under the Firebase uid {auth_user.uid}, not the "
                f"staff row's {uid!r}"
            )

        found.repairs.append(
            Repair(
                kind="write_crm_document",
                uid=auth_user.uid,
                email=email,
                name=str(row.get("name", "")),
                role=role,
                note=note,
            )
        )

    # ── Direction two: a crmUsers document with no staff row ─────────────────
    if direction == "crm":
        return found

    for doc_id, data in documents:
        email = str(data.get("email", "")).strip().lower()
        raw_role = str(data.get("role", ""))
        crm_role = crm.normalise_crm_role(raw_role)

        if not email:
            found.blocked.append(
                Blocked(
                    f"crmUsers/{doc_id}",
                    "crmUsers",
                    "the document carries no email address, so it cannot be "
                    "matched to a staff record or given one.",
                )
            )
            continue

        if email in staff_by_email:
            continue  # handled above, in whichever state it is in

        refused = crm.MONGO_ROLE_REFUSED.get(crm_role)
        if refused is not None:
            if crm_role in ("agency", "seller"):
                found.external.append(f"{email} ({crm_role}) — {refused}")
            else:
                found.blocked.append(Blocked(email, "crmUsers", refused))
            continue

        role = crm.mongo_role_for(crm_role)
        if role is None:
            found.blocked.append(
                Blocked(
                    email,
                    "crmUsers",
                    f"its role is {raw_role!r}, which corresponds to no role in "
                    "the API. Nothing can be created from it without guessing "
                    "what authority it was meant to have.",
                )
            )
            continue

        if await asyncio.to_thread(firebase.get_user, doc_id) is None:
            found.blocked.append(
                Blocked(
                    email,
                    "crmUsers",
                    f"crmUsers/{doc_id} names no Firebase Auth account, so "
                    "nobody can hold a token for it. It is a leftover document, "
                    "not an account — delete it rather than give it a staff row.",
                )
            )
            continue

        note = ""
        if raw_role != crm_role:
            note = f"legacy role {raw_role!r} read as {crm_role!r}, as the CRM does"

        found.repairs.append(
            Repair(
                kind="create_staff_row",
                uid=doc_id,
                email=email,
                name=str(data.get("name", "")),
                role=role,
                note=note,
                source=data,
            )
        )

    return found


# ══════════════════════════════════════════════════════════════════════════════
#  Apply
# ══════════════════════════════════════════════════════════════════════════════


async def apply(repair: Repair) -> str:
    """Write one missing half. Returns a line describing what was written."""
    if repair.kind == "write_crm_document":
        outcome = await crm.amirror(
            uid=repair.uid,
            email=repair.email,
            name=repair.name,
            role=repair.role,
            created_by=ACTOR["uid"],
            is_active=True,
        )
        await audit.record(
            actor=ACTOR,
            action=audit.Action.STAFF_MIRROR_REPAIRED,
            subject_type="staff",
            subject_id=repair.uid,
            reason=REASON,
            before={"crm_user_document": "missing"},
            after={"crm_user_document": "written", "crm_role": outcome.crm_role},
            meta={"email": repair.email, "role": str(repair.role)},
        )
        return f"crmUsers/{repair.uid} written — {outcome.detail}"

    data = repair.source
    now = datetime.now(timezone.utc)
    team = R.team_of(repair.role)
    row = {
        "uid": repair.uid,
        "email": repair.email,
        "name": repair.name,
        "phone": str(data.get("phone", "") or ""),
        "role": str(repair.role),
        "team": str(team) if team else None,
        "field_charge": data.get("fieldCharge") or None,
        "reports_to": data.get("reportsTo") or None,
        # Whatever the CRM document says. A document marked inactive is an
        # account somebody revoked; creating it active would restore access
        # nobody asked to restore.
        "is_active": bool(data.get("isActive", True)),
        "created_at": now,
        "created_by": {"uid": ACTOR["uid"], "name": ACTOR["name"]},
        "updated_at": now,
    }
    await mongo.get_db()[C.STAFF].update_one(
        {"email": repair.email}, {"$setOnInsert": row}, upsert=True
    )
    await audit.record(
        actor=ACTOR,
        action=audit.Action.STAFF_MIRROR_REPAIRED,
        subject_type="staff",
        subject_id=repair.uid,
        reason=REASON,
        before={"staff_record": "missing"},
        after={"staff_record": "created", "role": str(repair.role)},
        meta={"email": repair.email, "crm_role": str(data.get("role", ""))},
    )
    state = "" if row["is_active"] else " (inactive, as the CRM document says)"
    return f"staff row created — {repair.email} → {repair.role}{state}"


# ══════════════════════════════════════════════════════════════════════════════
#  Command line
# ══════════════════════════════════════════════════════════════════════════════


def arg(flag: str, default: str = "") -> str:
    """`--flag value` or `--flag=value`."""
    for i, item in enumerate(sys.argv):
        if item == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if item.startswith(f"{flag}="):
            return item.split("=", 1)[1]
    return default


def report(found: Survey, confirm: bool, written: list[str]) -> None:
    print("\n  ── Summary ──")
    print(f"    Mongo staff rows                 {found.staff_rows}")
    print(f"    Firestore crmUsers documents     {found.crm_documents}")
    print(f"    accounts already in both         {len(found.healthy)}")

    missing_crm = [r for r in found.repairs if r.kind == "write_crm_document"]
    missing_row = [r for r in found.repairs if r.kind == "create_staff_row"]

    if confirm:
        print(f"    crmUsers documents written       {len(missing_crm)}")
        print(f"    staff rows created               {len(missing_row)}")
    else:
        print(f"    crmUsers documents to write      {len(missing_crm)}")
        print(f"    staff rows to create             {len(missing_row)}")
    print(f"    reported, not repaired           {len(found.blocked)}")

    # ── The observer, every time, whether or not anything else happened ──────
    print("\n  Observer")
    if not found.observers:
        print(
            f"    no observer row in `staff`. The configured address is "
            f"{settings.observer_email} — run scripts.seed_accounts to create it."
        )
    for email, has_document, detail in found.observers:
        if has_document:
            print(f"    ✗ {email} HAS a crmUsers document: {detail}")
            print(
                "      That grants a read-only account write access on every\n"
                "      Firestore-backed page. This script does not touch the\n"
                "      observer; remove it with:  python -m scripts.seed_accounts"
            )
        else:
            print(f"    ✓ {email} has no crmUsers document — correct, and untouched.")

    if found.external:
        print("\n  Not staff — left alone")
        for line in found.external:
            print(f"    · {line}")

    if found.blocked:
        print("\n  Reported, not repaired")
        for item in found.blocked:
            print(f"    ✗ {item.email}  (exists in: {item.where})")
            print(f"        {item.why}")

    if written:
        print("\n  Written")
        for line in written:
            print(f"    + {line}")

    if confirm:
        print(
            f"\n  Repaired {len(written)} account(s). Each now exists in both "
            "places and\n  can sign in to the CRM and be authorised by the API. "
            "No role was changed.\n  Running this again is safe: everything "
            "above is now skipped.\n"
        )
    else:
        total = len(found.repairs)
        print(f"\n  {total} account(s) would be repaired. Nothing has been written.")
        print("\n  To write them:")
        print("    python -m scripts.repair_staff_accounts --confirm\n")


async def run() -> int:
    confirm = "--confirm" in sys.argv
    direction = (arg("--only") or "both").lower()
    if direction not in DIRECTIONS:
        print(f"\n  ✗ --only must be one of {', '.join(DIRECTIONS)}\n")
        return 1

    print("\n  Repairing staff accounts that exist in only one of the two places")
    print(f"  {'WRITING' if confirm else 'DRY RUN — nothing will be written'}")
    if direction != "both":
        print(
            "  Direction: "
            + (
                "staff rows missing a CRM document only"
                if direction == "crm"
                else "CRM documents missing a staff row only"
            )
        )
    print()

    firebase.init()
    await mongo.connect()

    try:
        found = await survey(direction)
    except crm.DirectoryError as exc:
        print(f"    ✗ Firestore could not be read: {exc}")
        print("      Nothing was repaired.\n")
        await mongo.disconnect()
        return 1

    for repair in found.repairs:
        print(f"    {'+' if confirm else '·'} {repair.line}")

    written: list[str] = []
    if confirm:
        for repair in found.repairs:
            try:
                written.append(await apply(repair))
            except crm.DirectoryError as exc:
                found.blocked.append(
                    Blocked(repair.email, "staff", f"the repair failed: {exc}")
                )

    report(found, confirm, written)

    await mongo.disconnect()
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
