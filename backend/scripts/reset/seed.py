"""Step 5 — SEED the Observer and the Owners from the Owner-provided list. Nothing invented.

    cd backend
    .venv/bin/python -m scripts.reset.seed \\
        --project <id> --bucket <bucket> --mongo-db <db> --mongo-uri-env MONGO_URI_RESET \\
        --credentials /path/key.json --seed-file scripts/reset/seed-accounts.json \\
        --out-dir reset-runs/<UTC> [--execute] [--password none|random|reset-link]

`seed-accounts.json` (NOT in git; copy seed-accounts.example.json and fill it
with the Owner's exact list):

    {"observer": {"name": "…", "email": "…", "phone": "+…"},
     "owners":   [{"name": "…", "email": "…", "phone": "+…"}, …]}

── WHAT IS WRITTEN, PER OWNER (the two halves the backend expects) ──────────
  Firebase Auth   one account: email + phone (E.164) + display name,
                  email_verified=True; NO password unless --password random
                  (printed ONCE to this terminal) or --password reset-link
                  (an Admin-SDK set-password link, printed ONCE).
  Mongo staff     {uid, email, name, role:"owner", phone, team:null,
                  field_charge:null, reports_to:null, status:"active",
                  is_active:true, created_at, created_by, updated_at}
                  — the shape `services/staff.invite` writes.
  crmUsers/{uid}  {uid, email, name, role:"superadmin", phone, permissions:
                  <every permission, in roles.ALL_PERMISSIONS order>,
                  isActive:true, createdBy, dept:null, fieldCharge:null,
                  reportsTo:null, crmId, createdAt, lastLoginAt:null}
                  — the shape `services/crm_directory.mirror` writes.
  users/{uid}     {uid, crmRole:"superadmin", isAgent:false, isSeller:false,
                  isOfficial:true, lastSeen, email, phoneNumber, phoneKey,
                  isProfileComplete:false, createdAt, createdVia:"crm", name}
                  — `crm_directory._attach_app_identity` for a created document.
  verifiedIdentities/{phone digits}  {phoneNumbers:[…], emails:[…],
                  roles:["superadmin"], name, updatedAt}
  staffRoster/{uid}  {uid, name, role:"superadmin", dept:null, isActive:true, updatedAt}

── THE OBSERVER ─────────────────────────────────────────────────────────────
  Mongo staff only: {uid:"observer:<email>", role:"observer", …}. NO Firebase
  Auth account and NO crmUsers document, by design (`crm_directory.NOT_MIRRORED`):
  the Observer signs in with a one-time code at /observer. The run REFUSES if
  an Auth account carries the Observer's email. The backend's OBSERVER_EMAIL
  setting must equal this address — check the deployed configuration.

── REFUSALS ─────────────────────────────────────────────────────────────────
  more or fewer than ONE observer · no owners · an invalid email · a phone that
  is not E.164 · a duplicate email/phone · an example/placeholder address · a
  phone already on a DIFFERENT Auth account · a live target that differs from
  what was typed · no data canary · the project id not typed back.

Afterwards `appConfig/economy` is re-read: beanToDiamondRate (>= 1),
giftRates.beanToInrRate and weeklyMinPayoutInr are printed and each missing one
is named; the exit code is 1 until they exist. Owners re-enrol MFA on first login.
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from scripts.reset.common import (SEED_RESULT_KIND, Refused, Target, iso, mask_email, mask_phone, read_json,
                                  require_typed_project, run_main, say, stamp, utc_now, validate_target, write_json)

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")
#: Reserved / documentation domains (RFC 2606, RFC 6761): the example file uses them.
PLACEHOLDER_TLDS = (".invalid", ".example", ".test", ".localhost")
PLACEHOLDER_DOMAINS = ("example.com", "example.org", "example.net")


def is_placeholder_email(email: str) -> bool:
    domain = email.rpartition("@")[2].lower()
    return domain in PLACEHOLDER_DOMAINS or any(domain.endswith(t) for t in PLACEHOLDER_TLDS)
CREATED_BY = "reset-seed"
OWNER_ROLE_MONGO = "owner"
OBSERVER_ROLE_MONGO = "observer"
OWNER_ROLE_CRM = "superadmin"
OWNERS_BY_DESIGN = 3
_CRM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def superadmin_permissions() -> list[str]:
    """Every permission the Owner role holds, in `roles.ALL_PERMISSIONS` order —
    exactly `crm_directory.DEFAULT_PERMISSIONS['superadmin']`, from the same source."""
    from app.core.roles import ALL_PERMISSIONS, Role, permissions_of

    held = permissions_of(Role.OWNER)
    return [str(p) for p in ALL_PERMISSIONS if p in held]


@dataclass(frozen=True)
class Person:
    name: str
    email: str
    phone: str


@dataclass(frozen=True)
class SeedSpec:
    observer: Person
    owners: tuple[Person, ...]


def _person(raw: Any, label: str, *, phone_required: bool) -> Person:
    if not isinstance(raw, dict):
        raise Refused(f"{label}: must be an object with name, email, phone")
    name = str(raw.get("name") or "").strip()
    email = str(raw.get("email") or "").strip().lower()
    phone = str(raw.get("phone") or "").strip().replace(" ", "").replace("-", "")
    if not name or len(name) > 80:
        raise Refused(f"{label}: name is missing or too long")
    if not EMAIL_RE.match(email):
        raise Refused(f"{label}: email is not a valid address")
    if is_placeholder_email(email):
        raise Refused(f"{label}: {mask_email(email)} is a placeholder address — seed-accounts.json was not filled in")
    if phone_required and not phone:
        raise Refused(f"{label}: phone is required for an Owner (the app signs in by phone OTP)")
    if phone and not E164_RE.match(phone):
        raise Refused(f"{label}: phone {mask_phone(phone)} is not E.164 (+<country><number>, digits only)")
    return Person(name=name, email=email, phone=phone)


def validate_seed(data: Any) -> SeedSpec:
    if not isinstance(data, dict):
        raise Refused("seed-accounts.json must hold an object")
    if "observer" in data and "observers" in data:
        raise Refused("seed-accounts.json names both `observer` and `observers`; use one")
    observers_raw = data.get("observers") if "observers" in data else ([data["observer"]] if "observer" in data else [])
    if not isinstance(observers_raw, list):
        raise Refused("`observers` must be a list")
    if len(observers_raw) != 1:
        raise Refused(f"exactly ONE observer must be listed; found {len(observers_raw)}")
    owners_raw = data.get("owners")
    if not isinstance(owners_raw, list) or not owners_raw:
        raise Refused("`owners` must be a non-empty list")
    if len(owners_raw) > OWNERS_BY_DESIGN:
        raise Refused(f"more than {OWNERS_BY_DESIGN} owners listed; the governance model has {OWNERS_BY_DESIGN}")
    observer = _person(observers_raw[0], "observer", phone_required=False)
    owners = tuple(_person(o, f"owners[{i}]", phone_required=True) for i, o in enumerate(owners_raw))
    emails = [observer.email] + [o.email for o in owners]
    if len(set(emails)) != len(emails):
        raise Refused("an email address appears more than once (the Observer must not be an Owner)")
    phones = [p for p in [observer.phone] + [o.phone for o in owners] if p]
    if len(set(phones)) != len(phones):
        raise Refused("a phone number appears more than once")
    unknown_keys = set(data) - {"observer", "observers", "owners", "_comment"}
    if unknown_keys:
        raise Refused(f"unexpected keys in seed-accounts.json: {sorted(unknown_keys)}")
    return SeedSpec(observer=observer, owners=owners)


# ══════════════════════════════════════════════════════════════════════════════
#  The documents (pure)
# ══════════════════════════════════════════════════════════════════════════════

def new_crm_id() -> str:
    return "".join(secrets.choice(_CRM_ID_ALPHABET) for _ in range(8))


def phone_digits(phone: str) -> str:
    return "".join(ch for ch in phone if ch.isdigit())


def owner_documents(p: Person, uid: str, now: datetime, *, permissions: list[str], crm_id: str) -> dict:
    """Every write for one Owner, keyed by destination. Field names are the backend's."""
    ms = int(now.timestamp() * 1000)
    return {
        "staff": {
            "filter": {"email": p.email},
            "set": {"uid": uid, "email": p.email, "name": p.name, "phone": p.phone, "role": OWNER_ROLE_MONGO,
                    "team": None, "field_charge": None, "reports_to": None,
                    "status": "active", "is_active": True, "updated_at": now},
            "set_on_insert": {"created_at": now, "created_by": CREATED_BY},
        },
        f"crmUsers/{uid}": {
            "uid": uid, "email": p.email, "name": p.name, "role": OWNER_ROLE_CRM, "phone": p.phone,
            "permissions": list(permissions), "isActive": True, "createdBy": CREATED_BY,
            "dept": None, "fieldCharge": None, "reportsTo": None,
            "crmId": crm_id, "createdAt": now, "lastLoginAt": None,
        },
        f"verifiedIdentities/{phone_digits(p.phone)}": {
            "phoneNumbers": [p.phone], "emails": [p.email], "roles": [OWNER_ROLE_CRM],
            "name": p.name, "updatedAt": now,
        },
        f"users/{uid}": {
            "uid": uid, "crmRole": OWNER_ROLE_CRM, "isAgent": False, "isSeller": False, "isOfficial": True,
            "lastSeen": ms, "email": p.email, "phoneNumber": p.phone, "phoneKey": phone_digits(p.phone),
            "isProfileComplete": False, "createdAt": now, "createdVia": "crm", "name": p.name,
        },
        f"staffRoster/{uid}": {
            "uid": uid, "name": p.name, "role": OWNER_ROLE_CRM, "dept": None, "isActive": True, "updatedAt": now,
        },
    }


def observer_documents(p: Person, now: datetime) -> dict:
    uid = f"observer:{p.email}"
    return {
        "staff": {
            "filter": {"email": p.email},
            "set": {"uid": uid, "email": p.email, "name": p.name, "phone": p.phone, "role": OBSERVER_ROLE_MONGO,
                    "team": None, "field_charge": None, "reports_to": None,
                    "status": "active", "is_active": True, "updated_at": now},
            "set_on_insert": {"created_at": now, "created_by": CREATED_BY},
        },
    }


ECONOMY_PATH = "appConfig/economy"


def economy_findings(doc: dict | None) -> tuple[dict, list[str]]:
    """(values, missing) for the three rates the spec says to recheck."""
    missing: list[str] = []
    values: dict[str, Any] = {}
    if doc is None:
        return {}, ["appConfig/economy (document missing)"]
    b2d = doc.get("beanToDiamondRate")
    values["beanToDiamondRate"] = b2d
    if not isinstance(b2d, (int, float)) or isinstance(b2d, bool) or b2d < 1:
        missing.append("beanToDiamondRate (must be a number >= 1)")
    gr = doc.get("giftRates")
    b2inr = gr.get("beanToInrRate") if isinstance(gr, dict) else None
    values["giftRates.beanToInrRate"] = b2inr
    if not isinstance(b2inr, (int, float)) or isinstance(b2inr, bool) or b2inr <= 0:
        missing.append("giftRates.beanToInrRate (must be a number > 0)")
    wmin = doc.get("weeklyMinPayoutInr")
    values["weeklyMinPayoutInr"] = wmin
    if not isinstance(wmin, (int, float)) or isinstance(wmin, bool) or wmin <= 0:
        missing.append("weeklyMinPayoutInr (must be a number > 0)")
    return values, missing


# ══════════════════════════════════════════════════════════════════════════════
#  Seeding
# ══════════════════════════════════════════════════════════════════════════════

def ensure_owner_auth(auth: Any, p: Person, *, password: str | None, apply: bool) -> tuple[str, str]:
    """(uid, 'created' | 'existing' | 'would_create'). Refuses on a phone held by another account."""
    by_phone = auth.get_user_by_phone(p.phone)
    existing = auth.get_user_by_email(p.email)
    if by_phone and (not existing or by_phone["uid"] != existing["uid"]):
        raise Refused(f"phone {mask_phone(p.phone)} is already on a different Auth account "
                      f"({by_phone['uid']}); taking a number off a live account is a decision, not a side effect")
    if existing:
        patch: dict[str, Any] = {}
        if not existing.get("phone"):
            patch["phone_number"] = p.phone
        elif existing.get("phone") != p.phone:
            raise Refused(f"the Auth account for {mask_email(p.email)} holds a different phone than the seed list")
        if not existing.get("email_verified", True):
            patch["email_verified"] = True
        if patch and apply:
            auth.update_user(existing["uid"], **patch)
        return existing["uid"], "existing"
    if not apply:
        return f"<new uid for {mask_email(p.email)}>", "would_create"
    uid = auth.create_user(email=p.email, phone=p.phone, display_name=p.name, email_verified=True,
                           password=password)
    return uid, "created"


def seed(spec: SeedSpec, *, target: Target, fs: Any, mongo: Any, auth: Any, apply: bool,
         password_mode: str, now: datetime | None = None, permissions: list[str] | None = None,
         printer: Callable[[str], None] = say) -> dict:
    now = now or utc_now()
    perms = permissions if permissions is not None else superadmin_permissions()
    result: dict[str, Any] = {"kind": SEED_RESULT_KIND, "mode": "executed" if apply else "dry-run",
                              "target": target.as_dict(), "seeded_at": iso(now), "owners": [], "observer": None,
                              "auth_user_count_expected": len(spec.owners)}

    # The Observer must have no Auth account — before anything is written.
    if auth.get_user_by_email(spec.observer.email) is not None:
        raise Refused(f"an Auth account carries the Observer's email {mask_email(spec.observer.email)}; "
                      "the Observer has no Auth account by design")

    printer(f"\n== SEED {'EXECUTE' if apply else 'DRY RUN'} == {target.describe()}")
    printer(f"owners: {len(spec.owners)} of the {OWNERS_BY_DESIGN} the governance model calls for"
            + ("" if len(spec.owners) == OWNERS_BY_DESIGN else "  (short — money sign-off has no spare signer)"))

    for p in spec.owners:
        password = secrets.token_urlsafe(18) if password_mode == "random" else None
        uid, how = ensure_owner_auth(auth, p, password=password, apply=apply)
        docs = owner_documents(p, uid, now, permissions=perms, crm_id=new_crm_id())
        if apply:
            st = docs["staff"]
            mongo.upsert("staff", st["filter"], st["set"], st["set_on_insert"])
            for path, data in docs.items():
                if path != "staff":
                    fs.set_doc(path, data, merge=True)
        printer(f"  owner {p.name!r} {mask_email(p.email)} {mask_phone(p.phone)} → auth {how} uid={uid}; "
                f"staff + {', '.join(k.split('/')[0] for k in docs if k != 'staff')}")
        secret_line = ""
        if apply and how == "created" and password_mode == "random":
            secret_line = f"    PASSWORD (shown once, never stored): {password}"
        elif apply and how == "existing" and password_mode == "random":
            secret_line = "    account already existed: its password is unchanged (use reset-link or 'Forgot password')"
        elif apply and password_mode == "reset-link":
            try:
                secret_line = f"    SET-PASSWORD LINK (shown once, never stored): {auth.generate_password_reset_link(p.email)}"
            except Exception as exc:  # noqa: BLE001
                secret_line = f"    set-password link could not be generated: {exc}"
        elif password_mode == "none":
            secret_line = "    no password set: the person uses 'Forgot password' on the CRM sign-in page"
        if secret_line:
            printer(secret_line)
        result["owners"].append({"uid": uid, "email": p.email, "name": p.name, "auth": how})

    obs = observer_documents(spec.observer, now)
    if apply:
        st = obs["staff"]
        mongo.upsert("staff", st["filter"], st["set"], st["set_on_insert"])
    printer(f"  observer {spec.observer.name!r} {mask_email(spec.observer.email)} → staff row only "
            f"(uid observer:<email>; no Auth account, no crmUsers document, by design)")
    result["observer"] = {"uid": f"observer:{spec.observer.email}", "email": spec.observer.email}

    values, missing = economy_findings(fs.get_doc(ECONOMY_PATH))
    result["economy"] = {"values": values, "missing": missing}
    printer("\nappConfig/economy:")
    for k, v in values.items():
        printer(f"  {k:<28} {v!r}")
    if missing:
        printer("  MISSING / INVALID: " + "; ".join(missing))
        printer("  Enter the approved economy baseline in the CRM (Economy → Config) before reopening.")
    else:
        printer("  all three present — compare them with the approved economy baseline before reopening.")
    printer("\nReminders: the deployed OBSERVER_EMAIL must equal the Observer's address; Owners enrol MFA on first login.")
    return result


def main(argv: list[str] | None = None, input_fn: Callable[[str], str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--mongo-db", required=True)
    ap.add_argument("--mongo-uri-env", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--seed-file", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--password", choices=("none", "random", "reset-link"), default="none")
    ap.add_argument("--validate-only", action="store_true", help="validate the seed file and exit; connects nowhere")
    args = ap.parse_args(argv)

    def go() -> int:
        target = validate_target(args.project, args.bucket, args.mongo_db, allow_demo=True)
        spec = validate_seed(read_json(args.seed_file))
        if args.validate_only:
            say(f"seed file ok: 1 observer ({mask_email(spec.observer.email)}), {len(spec.owners)} owner(s): "
                + ", ".join(f"{mask_email(o.email)} {mask_phone(o.phone)}" for o in spec.owners))
            return 0
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        from scripts.reset.common import mongo_uri_from_env
        from scripts.reset.live import FirebaseSession, LiveMongo, require_canary

        uri = mongo_uri_from_env(args.mongo_uri_env)
        session = FirebaseSession(target, args.credentials)
        mongo = LiveMongo(uri, target)
        try:
            fs, auth = session.firestore(), session.auth()
            if fs.project() != target.project:
                raise Refused(f"live Firestore is project {fs.project()!r}, not {target.project!r}")
            require_canary(mongo, target)
            if args.execute:
                require_typed_project(target.project, input_fn)
            result = seed(spec, target=target, fs=fs, mongo=mongo, auth=auth, apply=args.execute,
                          password_mode=args.password)
        finally:
            mongo.close()
            session.close()
        path = out_dir / (f"seed-result-{stamp()}.json" if args.execute else f"seed-dry-run-{stamp()}.json")
        write_json(path, result)
        say(f"\nseed result: {path}")
        if not args.execute:
            say("DRY RUN — nothing was written. Re-run with --execute.")
        return 1 if (args.execute and result["economy"]["missing"]) else 0

    return run_main(go)


if __name__ == "__main__":
    sys.exit(main())
