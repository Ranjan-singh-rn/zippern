"""How long a session lasts, how it renews itself, and when it refuses to.

The complaint this module exists for is the owner's, verbatim:

    "when checking seller or try to view seller or agency details or refresh it
    comes back to login page ask to login again which is not correct. token at
    least go for a week then expire. and if expire also shouldn't show crm user
    it expired if they are regularly visiting. asking relogin to those if auto
    refresh token getting error or that crm user is long time no see in crm."

Three claims, and the third is the one that has to be right:

  * **A week.** `settings.session_ttl_minutes` was 720 — twelve hours — and a
    session issued at nine in the morning was refused by nine that evening.
    Section 1 signs somebody in and moves the clock: thirteen hours later the
    session is still good, which is the exact case that used to fail, and eight
    days later it is not.

  * **Renewal is silent.** Section 2 renews a live session for staff, for an
    agency, for a coin seller and for a dual-role login, and checks what comes
    back: a working token, the same person, and — for a partner — a scope that
    was **re-resolved from Mongo** rather than copied off the old claim. The
    forged-claim case is here too, because "re-resolved" is only a real
    property if a claim naming somebody else's partner id is ignored.

  * **Renewal refuses, and a refusal is final.** Section 3 puts a deactivated
    staff member, a demoted one, a deactivated partner, a rejected one, an
    account switched off in the CRM and a departed owner in front of the real
    `renew_session`, and each one is refused with a message. Section 4 revokes
    a session and presents it again — and again, and again — because "a revoked
    session stays revoked" is worth nothing if it only holds the first time.
    Section 6 draws the "long time no see" line and stands on both sides of it.
    Section 7 shows a refusal is a fixed point: repeating it produces the same
    answer forever and never issues a session, so nothing that retries can
    eventually be let through by retrying.

And section 5 is the one that asserts nothing *changed*: the observer's session
is still twelve hours, is still un-renewable, and their one-time code rules are
untouched. A week-long, self-renewing credential minted from a code emailed to a
third mailbox would have quietly undone the control that code exists to be.

No database and no network: `tests/harness.py` stubs the I/O, so everything
under `app/` exercised here is the real, unmodified code. The clock is the one
thing that is not real — `app.core.security.datetime` is replaced with a
subclass whose `now()` can be moved — because every claim in this file is about
what happens after time passes, and a test that cannot move time can only
assert the arithmetic it already wrote down.

Run:  python3 -m tests.test_session_lifetime
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()


# ══════════════════════════════════════════════════════════════════════════════
#  A clock that can be moved, and a JWT that really carries claims
# ══════════════════════════════════════════════════════════════════════════════
#
# The harness stubs `jose` with an encoder that returns the literal string
# "token". Nothing about session lifetime can be tested through that: the whole
# subject is what a token says, whether the signature holds, and whether the
# expiry has passed. So it is replaced with an envelope that round-trips the
# claims, carries a real digest over them, and enforces `exp` — including
# honouring `options={"verify_exp": False}`, which is the flag `renew_session`
# passes and the reason it can look at a session that has already lapsed.

#: One mutable cell, so `travel()` can move time without rebinding anything.
CLOCK: list[timedelta] = [timedelta(0)]


class Clock(datetime):
    """`datetime`, with a `now()` the test can move. Everything else is real."""

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return datetime.now(tz) + CLOCK[0]


def travel(**delta) -> None:
    """Move the world forward. `travel(hours=13)`."""
    CLOCK[0] += timedelta(**delta)


def rewind() -> None:
    CLOCK[0] = timedelta(0)


class JWTError(Exception):
    pass


def _digest(claims: dict, secret: str) -> str:
    canonical = json.dumps(claims, sort_keys=True, default=str)
    return hashlib.sha256(f"{canonical}|{secret}".encode()).hexdigest()


class RealishJwt:
    """Enough of a JWT to test one: claims, a signature, an issuer and an expiry."""

    @staticmethod
    def encode(claims, secret, algorithm=None):  # noqa: ARG004
        return json.dumps({"claims": claims, "sig": _digest(claims, secret)})

    @staticmethod
    def decode(token, secret, algorithms=None, issuer=None, options=None):  # noqa: ARG004
        try:
            envelope = json.loads(token)
            claims = envelope["claims"]
        except Exception as exc:  # noqa: BLE001
            raise JWTError("not a token") from exc
        if envelope.get("sig") != _digest(claims, secret):
            raise JWTError("signature does not verify")
        if issuer is not None and claims.get("iss") != issuer:
            raise JWTError("wrong issuer")
        if (options or {}).get("verify_exp", True):
            if int(claims.get("exp") or 0) < int(Clock.now(timezone.utc).timestamp()):
                raise JWTError("expired")
        return claims


sys.modules["jose"] = types.ModuleType("jose")
sys.modules["jose"].JWTError = JWTError
sys.modules["jose"].jwt = RealishJwt

from app.config import settings  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import security as sec  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.routers import auth as auth_router  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

sec.datetime = Clock  # type: ignore[assignment]

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


def refuses(label: str, factory, *, error=sec.AuthError) -> str:
    """This must be refused with a message, not quietly given a session."""
    global checks
    checks += 1
    try:
        result = asyncio.run(factory())
    except error as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def rejects_401(label: str, factory) -> str:
    """The endpoint must answer 401 with the reason on it."""
    global checks
    checks += 1
    try:
        result = asyncio.run(factory())
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        if code == 401:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 401")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ══════════════════════════════════════════════════════════════════════════════
#  The world
# ══════════════════════════════════════════════════════════════════════════════
#
# The same shapes `tests/test_partner_session.py` uses, because they are the
# shapes the real writers write: `partners` documents as
# `partner_ops._new_partner_document` builds them, `crmUsers` documents as
# `zipper-crm/lib/auth.ts` builds them, `staff` rows as `services/staff.py`
# does. Nothing here is invented for the test.

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)


def partner(pid: str, kind: str, status: str, active: bool, **extra) -> dict:
    return {
        "_id": pid,
        "kind": kind,
        "name": f"{pid} Ltd",
        "status": status,
        "is_active": active,
        "credit": {"outstanding": 0, "due_at": None},
        "created_at": NOW,
        **extra,
    }


def crm_user(uid: str, role: str, **extra) -> dict:
    return {
        "uid": uid,
        "email": f"{uid}@example.test",
        "name": f"{uid} owner",
        "role": role,
        "permissions": [],
        "isActive": True,
        "status": "approved",
        **extra,
    }


PARTNERS = [
    partner("agency-live", "agency", "approved", True),
    partner("agency-other", "agency", "approved", True),
    partner("seller-live", "seller", "approved", True),
    # Approved between sign-in and renewal, to prove the scope is re-read.
    partner("seller-waiting", "seller", "pending", False),
    # Switched off between sign-in and renewal.
    partner("agency-doomed", "agency", "approved", True),
    partner("seller-doomed", "seller", "approved", True),
    # One login, two businesses. The seller half is withdrawn mid-session.
    partner("dual-agency", "agency", "approved", True),
    partner("dual-seller", "seller", "approved", True),
]

CRM_USERS = {
    "uid-agency": crm_user("uid-agency", "agency", agencyId="agency-live"),
    "uid-seller": crm_user("uid-seller", "seller", sellerId="seller-live"),
    "uid-waiting": crm_user(
        "uid-waiting", "seller", sellerId="seller-waiting", status="pending"
    ),
    "uid-doomed-agency": crm_user(
        "uid-doomed-agency", "agency", agencyId="agency-doomed"
    ),
    "uid-doomed-seller": crm_user(
        "uid-doomed-seller", "seller", sellerId="seller-doomed"
    ),
    "uid-switched-off": crm_user(
        "uid-switched-off", "agency", agencyId="agency-live", isActive=False
    ),
    "uid-dual": crm_user(
        "uid-dual",
        "agency",
        agencyId="dual-agency",
        sellerId="dual-seller",
        roles=["agency", "seller"],
    ),
}

STAFF = [
    {
        "uid": "uid-owner",
        "email": "owner@zipper.test",
        "name": "Owner",
        "role": "owner",
        "is_active": True,
    },
    {
        "uid": "uid-ops",
        "email": "priya@zipper.test",
        "name": "Priya",
        "role": "ops_admin",
        "is_active": True,
    },
    {
        "uid": "uid-fired",
        "email": "fired@zipper.test",
        "name": "Departed",
        "role": "finance_member",
        "is_active": True,
    },
    {
        "uid": "uid-demoted",
        "email": "demoted@zipper.test",
        "name": "Demoted",
        "role": "finance_admin",
        "is_active": True,
    },
    {
        "uid": "uid-observer",
        "email": settings.observer_email,
        "name": "Observer",
        "role": str(Role.OBSERVER),
        "is_active": True,
    },
]

WORLD = FakeDb()


def build_world() -> FakeDb:
    global WORLD
    WORLD = FakeDb()
    WORLD.seed(C.PARTNERS, [dict(p) for p in PARTNERS])
    WORLD.seed(C.STAFF, [dict(s) for s in STAFF])
    sec.get_db = lambda: WORLD  # type: ignore[assignment]
    audit_mod.get_db = lambda: WORLD  # type: ignore[assignment]
    crm.read = lambda uid: CRM_USERS.get(uid)  # type: ignore[assignment]
    crm.find_by_email = lambda email: [  # type: ignore[assignment]
        (uid, doc)
        for uid, doc in CRM_USERS.items()
        if str(doc.get("email", "")).lower() == (email or "").lower()
    ]
    return WORLD


def sign_in(uid: str, email: str = "") -> tuple[str, datetime, dict]:
    firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
        "uid": uid,
        "email": email or f"{uid}@example.test",
    }
    return asyncio.run(sec.sign_in_with_firebase("an-id-token"))


def token_for(uid: str, email: str = "") -> str:
    return sign_in(uid, email)[0]


def session_of(token: str) -> dict:
    return asyncio.run(sec.verify_session(token))


def renew(token: str) -> tuple[str, datetime, dict]:
    return asyncio.run(sec.renew_session(token))


def claims_of(token: str) -> dict:
    return json.loads(token)["claims"]


def resign(claims: dict) -> str:
    """A token with these claims, signed with the API's real secret.

    Used once, to stand in for a claim that has been tampered with by somebody
    who *does* hold the signing key. Renewal must still not honour it, because
    renewal does not read authority off a claim at all.
    """
    return RealishJwt.encode(claims, settings.jwt_secret)


def sessions() -> list[dict]:
    return WORLD[C.SESSIONS].docs


def live_sessions(uid: str) -> list[dict]:
    return [s for s in sessions() if s["uid"] == uid and not s["revoked"]]


def minutes_of_life(issued_at: datetime, expires: datetime) -> int:
    return round((expires - issued_at).total_seconds() / 60)


build_world()
logging.getLogger("app.core.security").setLevel(logging.CRITICAL)


# ══════════════════════════════════════════════════════════════════════════════
#  1. A week, not twelve hours
# ══════════════════════════════════════════════════════════════════════════════

OLD_TTL_MINUTES = 720  # what shipped before this change

check("a session lasts a week", settings.session_ttl_minutes, 7 * 24 * 60)
ok(
    "which is longer than the twelve hours that produced the complaint",
    settings.session_ttl_minutes > OLD_TTL_MINUTES,
)
ok("and every part of it is configurable", all(
    isinstance(getattr(settings, name), int)
    for name in (
        "session_ttl_minutes",
        "observer_session_ttl_minutes",
        "session_renewal_grace_minutes",
        "session_renew_before_minutes",
    )
))

start = Clock.now(timezone.utc)
ops_token, ops_expires, ops_profile = sign_in("uid-ops", "priya@zipper.test")
check(
    "a staff session is issued for exactly that long",
    minutes_of_life(start, ops_expires),
    settings.session_ttl_minutes,
)
check("and the token works immediately", session_of(ops_token)["uid"], "uid-ops")

# The exact hour the complaint is about. Under the old ceiling this token was
# already dead and the CRM's only answer was to ask for a password.
travel(hours=13)
check(
    "thirteen hours later — where the old session had already expired — it works",
    session_of(ops_token)["role"],
    Role.OPS_ADMIN,
)

travel(days=6)  # 6 days 13 hours in
check("six and a half days in, still working", session_of(ops_token)["uid"], "uid-ops")

travel(hours=12)  # 7 days 1 hour in
refused = refuses("a session past a week", lambda: sec.verify_session(ops_token))
check("and past the week it is refused", refused, "Session is invalid or has expired")

# The session *record* deliberately outlives the token it belongs to, by the
# renewal grace, so the revocation flag is still readable while a lapsed token
# is being considered for renewal. Reaping it at `exp` would make "revoked" and
# "expired an hour ago" indistinguishable, which is the one thing that must not
# blur.
record = asyncio.run(WORLD[C.SESSIONS].find_one({"jti": claims_of(ops_token)["jti"]}))
check(
    "the record's own expiry is the token's plus the renewal grace",
    minutes_of_life(record["token_expires_at"], record["expires_at"]),
    settings.session_renewal_grace_minutes,
)
check(
    "and the token's expiry is recorded as itself",
    int(record["token_expires_at"].timestamp()),
    claims_of(ops_token)["exp"],
)
rewind()


# ══════════════════════════════════════════════════════════════════════════════
#  2. Renewal, for somebody who is simply still here
# ══════════════════════════════════════════════════════════════════════════════
#
# Nobody active should ever meet section 1's refusal, because the browser renews
# a day before it. What renewal has to produce is a working session for the same
# person — and, for a partner, a scope read out of Mongo rather than copied.

build_world()

# ── Staff ────────────────────────────────────────────────────────────────────
old_token = token_for("uid-ops", "priya@zipper.test")
old_jti = claims_of(old_token)["jti"]

travel(days=6, hours=1)  # past `renew_at`, well inside the week
new_token, new_expires, profile = renew(old_token)

check("renewal answers with the same person", profile["uid"], "uid-ops")
check("…and the same role", profile["role"], str(Role.OPS_ADMIN))
check("…and their team", profile["team"], "ops")
check("the renewed session verifies", session_of(new_token)["uid"], "uid-ops")
check(
    "…for a full week from now, not from the original sign-in",
    minutes_of_life(Clock.now(timezone.utc), new_expires),
    settings.session_ttl_minutes,
)
ok("…so it is a different token", new_token != old_token)
check("…carrying a different jti", claims_of(new_token)["jti"] != old_jti, True)

# Rotation. The point of it is that exactly one token is live, so a copy taken
# from a machine yesterday is worth nothing once the real holder's browser has
# renewed.
check(
    "the session it replaced is revoked",
    asyncio.run(WORLD[C.SESSIONS].find_one({"jti": old_jti}))["revoked"],
    True,
)
check(
    "…so the old token no longer verifies",
    refuses("the replaced token", lambda: sec.verify_session(old_token)),
    "Session has been revoked",
)
check("…and exactly one session is live for them", len(live_sessions("uid-ops")), 1)
check(
    "…with the chain recorded",
    asyncio.run(WORLD[C.SESSIONS].find_one({"jti": claims_of(new_token)["jti"]}))[
        "renewed_from"
    ],
    old_jti,
)

# Renewal is repeatable — this is what "a week, renewed while you keep using it"
# actually means over months.
chained = new_token
for _ in range(5):
    chained = renew(chained)[0]
check("a session renews again and again", session_of(chained)["uid"], "uid-ops")
check("…leaving one live session, not seven", len(live_sessions("uid-ops")), 1)

check(
    "renew_at is a day before expiry, and is served rather than assumed",
    minutes_of_life(sec.renew_at(new_expires, Role.OPS_ADMIN), new_expires),
    settings.session_renew_before_minutes,
)
ok(
    "…which is inside the session, so an active person renews before expiry",
    settings.session_renew_before_minutes < settings.session_ttl_minutes,
)

# `renew_at` must never land before the session was issued. The lead time and
# the TTL are independent settings and nothing stops the first exceeding the
# second — the observer is exactly that shape today, a twelve-hour session with
# a one-day lead. Unclamped, that told a browser to renew *before* the sign-in
# that created the session, so the CRM renewed on the first frame, was refused,
# and threw the person straight back to the login screen. Which is the bug.
for ttl_minutes in (5, 60, 720, 1440, 10_080, 100_000):
    fake_expiry = Clock.now(timezone.utc) + timedelta(minutes=ttl_minutes)
    original = settings.session_ttl_minutes
    settings.session_ttl_minutes = ttl_minutes
    lead = minutes_of_life(sec.renew_at(fake_expiry, Role.OWNER), fake_expiry)
    settings.session_ttl_minutes = original
    ok(
        f"a {ttl_minutes}-minute session renews inside its own life, not before it",
        0 < lead <= ttl_minutes,
    )
rewind()

# ── An agency and a coin seller, under the same rules ────────────────────────
build_world()

agency_token = token_for("uid-agency")
check(
    "an agency signs in scoped to its own record",
    session_of(agency_token)["partner_ids"],
    {"agency": "agency-live"},
)
renewed_agency = renew(agency_token)[0]
check(
    "and renews with that scope re-resolved",
    session_of(renewed_agency)["partner_ids"],
    {"agency": "agency-live"},
)
check("…still an agency", session_of(renewed_agency)["role"], Role.AGENCY)

seller_token = token_for("uid-seller")
renewed_seller, _e, seller_profile = renew(seller_token)
check(
    "a coin seller renews the same way",
    session_of(renewed_seller)["partner_ids"],
    {"seller": "seller-live"},
)
check("…and is told what it is", seller_profile["access"], "records")

# Re-resolved, not carried. An applicant approved *after* they signed in gets
# their scope on renewal — no sign-out, no second login.
waiting_token = token_for("uid-waiting")
check(
    "a pending applicant's session holds nothing",
    session_of(waiting_token)["partner_ids"],
    {},
)
asyncio.run(
    WORLD[C.PARTNERS].update_one(
        {"_id": "seller-waiting"}, {"$set": {"status": "approved", "is_active": True}}
    )
)
approved_token, _e, approved_profile = renew(waiting_token)
check(
    "…and once approved, renewal is what grants it — nobody signs in again",
    session_of(approved_token)["partner_ids"],
    {"seller": "seller-waiting"},
)
check("…with the status re-read too", approved_profile["partner_status"], "approved")

# The other direction: one capability of two withdrawn mid-session.
dual_token = token_for("uid-dual")
check(
    "a dual-role login is scoped to both records",
    session_of(dual_token)["partner_ids"],
    {"agency": "dual-agency", "seller": "dual-seller"},
)
asyncio.run(
    WORLD[C.PARTNERS].update_one(
        {"_id": "dual-seller"}, {"$set": {"status": "suspended", "is_active": False}}
    )
)
dual_renewed = renew(dual_token)[0]
check(
    "a capability withdrawn mid-session is gone from the renewed one",
    session_of(dual_renewed)["partner_ids"],
    {"agency": "dual-agency"},
)

# "Re-resolved" is only a real property if a claim cannot assert scope. This
# token is signed with the API's own secret and names another agency's id — the
# shape a leaked signing key would produce — and renewal still answers with the
# records Mongo says are theirs.
forged = resign({**claims_of(token_for("uid-agency")), "partners": {"agency": "agency-other"}})
check(
    "a claim naming somebody else's record verifies…",
    session_of(forged)["partner_ids"],
    {"agency": "agency-other"},
)
check(
    "…and renewal drops it for the scope Mongo actually holds",
    session_of(renew(forged)[0])["partner_ids"],
    {"agency": "agency-live"},
)
rewind()


# ══════════════════════════════════════════════════════════════════════════════
#  3. What renewal refuses
# ══════════════════════════════════════════════════════════════════════════════
#
# Every refusal below is decided by re-reading the account, never by re-signing
# what the token already said. That is the whole difference between a renewal
# and a rubber stamp: a session that renews on the strength of its own claims
# cannot notice that the person behind it was dismissed this morning.

build_world()

# ── A staff account deactivated mid-session ──────────────────────────────────
# `services/staff.deactivate` revokes every session for the uid before it
# writes anything else, so the ordinary path is caught by section 4. This is
# the other one: the flag flipped by a script, a migration or a hand edit, with
# no revocation behind it. It must still be refused, and it is — because the
# `staff` row is read again.
fired_token = token_for("uid-fired", "fired@zipper.test")
check("a live staff session works", session_of(fired_token)["role"], Role.FINANCE_MEMBER)
asyncio.run(WORLD[C.STAFF].update_one({"uid": "uid-fired"}, {"$set": {"is_active": False}}))
check(
    "a deactivated account cannot renew",
    refuses("a deactivated staff member", lambda: sec.renew_session(fired_token)),
    "This account has been deactivated.",
)
check("…and no session was issued for them", len(live_sessions("uid-fired")), 1)
ok(
    "…the one live session being the original, untouched",
    live_sessions("uid-fired")[0]["jti"] == claims_of(fired_token)["jti"],
)

# ── A role change ────────────────────────────────────────────────────────────
demoted_token = token_for("uid-demoted", "demoted@zipper.test")
asyncio.run(
    WORLD[C.STAFF].update_one({"uid": "uid-demoted"}, {"$set": {"role": "finance_member"}})
)
check(
    "a changed role cannot renew",
    refuses("a demoted staff member", lambda: sec.renew_session(demoted_token)),
    "Your role has changed. Sign in again.",
)
ok(
    "…and renewal never issues the old role a fresh week",
    all(s["role"] == "finance_admin" for s in sessions() if s["uid"] == "uid-demoted"),
)

# The dangerous direction, stated separately: renewal must not read the role
# off the token. A token claiming `owner`, correctly signed, is refused because
# the `staff` row says ops_admin.
escalated = resign({**claims_of(token_for("uid-ops", "priya@zipper.test")), "role": "owner"})
check(
    "a claim promoting itself verifies as the claim…",
    session_of(escalated)["role"],
    Role.OWNER,
)
check(
    "…and renewal refuses it against the staff record",
    refuses("a self-promoted claim", lambda: sec.renew_session(escalated)),
    "Your role has changed. Sign in again.",
)

# ── A staff member whose row has gone entirely ───────────────────────────────
asyncio.run(WORLD[C.STAFF].update_one({"uid": "uid-fired"}, {"$set": {"is_active": True}}))
ghost_token = token_for("uid-fired", "fired@zipper.test")
asyncio.run(WORLD[C.STAFF].delete_one({"uid": "uid-fired"}))
check(
    "an internal session whose staff row has gone is refused, not re-resolved",
    refuses("a departed staff member", lambda: sec.renew_session(ghost_token)),
    "This account no longer has access. Sign in again.",
)

# ── A partner deactivated mid-session ────────────────────────────────────────
build_world()

doomed_agency = token_for("uid-doomed-agency")
check(
    "an approved agency holds a live session",
    session_of(doomed_agency)["partner_ids"],
    {"agency": "agency-doomed"},
)
asyncio.run(
    WORLD[C.PARTNERS].update_one(
        {"_id": "agency-doomed"}, {"$set": {"status": "suspended", "is_active": False}}
    )
)
check(
    "a deactivated partner cannot renew",
    refuses("a suspended agency", lambda: sec.renew_session(doomed_agency)),
    "This account has been deactivated.",
)
check("…and holds no new session", len(live_sessions("uid-doomed-agency")), 1)

doomed_seller = token_for("uid-doomed-seller")
asyncio.run(
    WORLD[C.PARTNERS].update_one(
        {"_id": "seller-doomed"},
        {
            "$set": {
                "status": "rejected",
                "is_active": False,
                "rejection_reason": "The PAN on the KYC document does not match.",
            }
        },
    )
)
rejected = refuses("a rejected seller", lambda: sec.renew_session(doomed_seller))
ok("a rejected partner is refused with the reason on the record", "PAN" in rejected)

# The CRM's own switch, honoured on renewal exactly as on sign-in.
switched_token = token_for("uid-agency")
CRM_USERS["uid-agency"] = dict(CRM_USERS["uid-agency"], isActive=False)
check(
    "an account switched off in the CRM cannot renew",
    refuses("a CRM-deactivated agency", lambda: sec.renew_session(switched_token)),
    "This account has been deactivated.",
)
CRM_USERS["uid-agency"] = dict(CRM_USERS["uid-agency"], isActive=True)

# ── A token that is not ours ─────────────────────────────────────────────────
tampered = json.dumps({**json.loads(agency_token), "sig": "0" * 64})
check(
    "a tampered token cannot renew",
    refuses("a tampered token", lambda: sec.renew_session(tampered)),
    "Session is invalid. Sign in again.",
)
check(
    "nor can something that is not a token at all",
    refuses("a nonsense token", lambda: sec.renew_session("not-a-token")),
    "Session is invalid. Sign in again.",
)
# A session whose record was never written, or has been reaped: the claim alone
# grants nothing, because the record is where revocation lives.
orphan = resign({**claims_of(token_for("uid-ops", "priya@zipper.test")), "jti": "no-such-jti"})
check(
    "a session with no record cannot renew",
    refuses("an unrecorded session", lambda: sec.renew_session(orphan)),
    "Session not found. Sign in again.",
)
rewind()


# ══════════════════════════════════════════════════════════════════════════════
#  4. A revoked session stays revoked
# ══════════════════════════════════════════════════════════════════════════════
#
# This is the property a longer session rests on. Seven days of validity is only
# acceptable because a session can be killed inside it — by a sign-out, by
# `staff.deactivate`, by `staff.change_role` — and killed means killed, however
# many times the dead token is presented and whatever else changes afterwards.

build_world()

revoked_token = token_for("uid-ops", "priya@zipper.test")
jti = claims_of(revoked_token)["jti"]
asyncio.run(sec.revoke_session(jti))

check(
    "a revoked session does not verify",
    refuses("a revoked session", lambda: sec.verify_session(revoked_token)),
    "Session has been revoked",
)
check(
    "and cannot be renewed back to life",
    refuses("renewing a revoked session", lambda: sec.renew_session(revoked_token)),
    "This session has been ended. Sign in again.",
)
# Presenting it again is the interesting part: nothing about being refused makes
# the next attempt any more likely to work.
for attempt in range(4):
    check(
        f"…still refused on attempt {attempt + 2}",
        refuses("a revoked session, again", lambda: sec.renew_session(revoked_token)),
        "This session has been ended. Sign in again.",
    )
check("…and nothing was ever issued from it", len(live_sessions("uid-ops")), 0)

# Time does not launder it either — not inside the grace window, not outside it.
travel(days=6)
check(
    "a revoked session is still revoked days later",
    refuses("a revoked session much later", lambda: sec.renew_session(revoked_token)),
    "This session has been ended. Sign in again.",
)
rewind()

# The two services that revoke on the caller's behalf write exactly the flag
# read above. Asserted here rather than assumed, because `services/staff.py` is
# where deactivation and role changes are carried out and it is not this
# module's file to change.
staff_source = (ROOT / "app" / "services" / "staff.py").read_text()
check(
    "staff.py revokes every session for a uid, in two places",
    staff_source.count('update_many({"uid": uid}, {"$set": {"revoked": True}})'),
    2,
)

# And a sign-out is the same revocation, so signing out on a shared machine
# genuinely ends the week rather than leaving six days of it on the desk.
#
# `signout` takes a Request now, because the sign-out is audited and the entry
# records the caller's address the way every other auth event in this router
# does. The namespace stands in for it — the handler reads `.client` and nothing
# else off it.
signed_out = token_for("uid-ops", "priya@zipper.test")
asyncio.run(
    auth_router.signout(
        types.SimpleNamespace(client=None), user=session_of(signed_out)
    )
)
check(
    "signing out ends the session for good",
    refuses("a signed-out session", lambda: sec.renew_session(signed_out)),
    "This session has been ended. Sign in again.",
)
ok(
    # `audit_entries` is defined further down, so this reads the collection
    # directly rather than moving the helper for one assertion.
    "…and it is recorded, which it never used to be",
    any(e["action"] == "session.ended" for e in WORLD[C.AUDIT].docs),
)


# ══════════════════════════════════════════════════════════════════════════════
#  5. The observer, unchanged
# ══════════════════════════════════════════════════════════════════════════════
#
# The observer has no password and no Firebase login. Every sign-in is a
# one-time code, generated fresh, stored hashed, expiring, single-use, rate
# limited, and delivered to a mailbox that is deliberately **not** the account
# address — so holding the observer's email is not enough to sign in.
#
# A week-long session that renews itself would have quietly converted all of
# that into a standing credential: one code, then months of access with nothing
# ever asked again. So the observer keeps the twelve hours everybody used to
# have, and `renew_session` refuses them by name.

build_world()

check(
    "the observer's session is still twelve hours",
    settings.observer_session_ttl_minutes,
    OLD_TTL_MINUTES,
)
check("…which is what session_ttl_for answers for them", sec.session_ttl_for(Role.OBSERVER), OLD_TTL_MINUTES)
for role in (Role.OWNER, Role.OPS_ADMIN, Role.FINANCE_MEMBER, Role.AGENCY, Role.SELLER):
    check(
        f"…while {role} gets the week",
        sec.session_ttl_for(role),
        settings.session_ttl_minutes,
    )

issued_at = Clock.now(timezone.utc)
observer_token, observer_expires = asyncio.run(
    sec.issue_session(
        uid="uid-observer",
        email=settings.observer_email,
        name="Observer",
        role=Role.OBSERVER,
    )
)
check(
    "an observer session is issued for twelve hours",
    minutes_of_life(issued_at, observer_expires),
    OLD_TTL_MINUTES,
)
check("…and works", session_of(observer_token)["role"], Role.OBSERVER)
check(
    "…and cannot be renewed",
    refuses("renewing the observer", lambda: sec.renew_session(observer_token)),
    "Observer access is granted one sign-in at a time. Request a new code to continue.",
)
ok("…which one predicate says, for all three readers", not sec.is_renewable(Role.OBSERVER))
for role in (Role.OWNER, Role.OPS_ADMIN, Role.AGENCY, Role.SELLER):
    ok(f"…and {role} renews", sec.is_renewable(role))

# The browser is told not to come back early, because there is nothing to come
# back for. Their session simply ends when it ends, and the CRM finds out then
# — rather than renewing on the first frame, being refused, and bouncing the
# observer to the login screen seconds after they used their code.
check(
    "an observer is told to renew at the expiry itself, which is to say never",
    sec.renew_at(observer_expires, Role.OBSERVER),
    observer_expires,
)
ok(
    "…which is not what anybody else is told",
    sec.renew_at(observer_expires, Role.OWNER) < observer_expires,
)
travel(hours=13)
check(
    "…and after twelve hours it is simply over",
    refuses("an expired observer session", lambda: sec.verify_session(observer_token)),
    "Session is invalid or has expired",
)
check(
    "…still un-renewable inside what would be anybody else's grace",
    refuses("renewing a lapsed observer", lambda: sec.renew_session(observer_token)),
    "Observer access is granted one sign-in at a time. Request a new code to continue.",
)
rewind()

# The code rules themselves are untouched — asserted so a later edit to session
# lifetime cannot drift into them without this failing.
check("a code still expires in ten minutes", settings.otp_ttl_minutes, 10)
check("still five attempts", settings.otp_max_attempts, 5)
check("still a sixty second cooldown", settings.otp_resend_cooldown_seconds, 60)
ok(
    "and is still delivered somewhere other than the observer's own address",
    settings.observer_otp_delivery_email.lower() != settings.observer_email.lower(),
)


# ══════════════════════════════════════════════════════════════════════════════
#  6. Long time no see
# ══════════════════════════════════════════════════════════════════════════════
#
# "and if expire also shouldn't show crm user it expired if they are regularly
# visiting. asking relogin to those if auto refresh token getting error or that
# crm user is long time no see in crm."
#
# So an expired token is not automatically a password prompt: inside the grace
# window it is renewed in silence, which is what covers a laptop closed on a
# Friday and opened after a holiday. Outside it, the person is asked — and this
# is the ONLY refusal in the whole module that somebody who has done nothing
# wrong will ever see, so it is the one whose message has to read like an
# explanation rather than an accusation.

build_world()

grace_minutes = settings.session_renewal_grace_minutes
check("the grace window is three days", grace_minutes, 3 * 24 * 60)
check(
    "so a session can be renewed up to ten days after it was issued",
    (settings.session_ttl_minutes + grace_minutes) // (24 * 60),
    10,
)

away_token = token_for("uid-ops", "priya@zipper.test")

travel(days=7, hours=1)  # expired an hour ago
check(
    "an hour past expiry, the session is genuinely dead",
    refuses("an expired session", lambda: sec.verify_session(away_token)),
    "Session is invalid or has expired",
)
back_token = renew(away_token)[0]
check("…and renewal quietly brings it back", session_of(back_token)["uid"], "uid-ops")
ok("…as a new session, not the old one", back_token != away_token)

# Two days later — still inside the window, still silent.
travel(days=2)
check(
    "two days past expiry is still inside the window",
    session_of(renew(back_token)[0])["uid"],
    "uid-ops",
)
rewind()

build_world()
gone_token = token_for("uid-ops", "priya@zipper.test")
travel(days=7)
travel(minutes=grace_minutes + 1)
long_gone = refuses("somebody long gone", lambda: sec.renew_session(gone_token))
check(
    "past the window, they are asked to sign in — and told why",
    long_gone,
    "It has been a while since you last used the CRM. Sign in again to continue.",
)
ok("…in words that describe an absence, not a fault", "deactivated" not in long_gone)
check("…and nothing was issued", len(live_sessions("uid-ops")), 1)

# The boundary is checked before the database is touched, so a very old token
# costs a signature check and one comparison. Proven by the answer, not by
# timing: a token this old for an account that no longer exists still gets the
# absence message rather than "no account found".
asyncio.run(WORLD[C.STAFF].delete_one({"uid": "uid-ops"}))
check(
    "the absence check comes first, before anything is looked up",
    refuses("a very old token for a deleted account", lambda: sec.renew_session(gone_token)),
    "It has been a while since you last used the CRM. Sign in again to continue.",
)
rewind()


# ══════════════════════════════════════════════════════════════════════════════
#  7. A refusal is a fixed point — nothing loops
# ══════════════════════════════════════════════════════════════════════════════
#
# The browser's rule is in `components/AuthProvider.tsx`: one renewal in flight
# at a time, a 401 arriving within fifteen seconds of a *successful* renewal is
# treated as a refusal rather than answered with a third token, and once
# renewal has been refused nothing tries again until somebody signs in.
#
# What can be asserted here is the property that makes any of that safe: on the
# server, a refusal is stable. Repeating it produces the same answer, changes
# nothing, and issues nothing — so a client that retries can never be let
# through by retrying, and a client that retries forever can never accumulate
# sessions by doing it.

build_world()

before_sessions = len(sessions())
messages = set()
for _ in range(25):
    messages.add(
        refuses("a hopeless renewal", lambda: sec.renew_session("not-a-token"))
    )
check("twenty-five refusals give one answer", len(messages), 1)
check("…and write nothing", len(sessions()), before_sessions)

deactivated_token = token_for("uid-fired", "fired@zipper.test")
asyncio.run(WORLD[C.STAFF].update_one({"uid": "uid-fired"}, {"$set": {"is_active": False}}))
answers = {
    refuses("a deactivated account, repeatedly", lambda: sec.renew_session(deactivated_token))
    for _ in range(25)
}
check("a deactivated account is refused identically every time", answers, {"This account has been deactivated."})
check("…and never accumulates a session", len(live_sessions("uid-fired")), 1)

# The one place renewal *does* succeed repeatedly is the honest one, and even
# there it does not accumulate: each success revokes its predecessor, so a
# hundred renewals leave one live session and not a hundred.
build_world()
loop_token = token_for("uid-ops", "priya@zipper.test")
chain = [loop_token]
for _ in range(20):
    loop_token = renew(loop_token)[0]
    chain.append(loop_token)

check("twenty renewals leave exactly one live session", len(live_sessions("uid-ops")), 1)
check(
    "…and twenty revoked ones, each pointing at the one before it",
    len([s for s in sessions() if s["uid"] == "uid-ops" and s["revoked"]]),
    20,
)
ok(
    "…linked into a single chain, oldest to newest",
    [s["renewed_from"] for s in sessions() if s["uid"] == "uid-ops"][1:]
    == [claims_of(t)["jti"] for t in chain[:-1]],
)
# Every superseded token in that chain is dead, not merely the first one. A
# copy taken at any point in a long-running session is worth nothing after the
# next renewal — which is most of what makes a week-long token acceptable.
for index, superseded in enumerate(chain[:-1]):
    check(
        f"…and link {index} is refused for good",
        refuses("a superseded token", lambda t=superseded: sec.renew_session(t)),
        "This session has been ended. Sign in again.",
    )
check(
    "…while the newest one is the live session",
    session_of(chain[-1])["uid"],
    "uid-ops",
)


# ══════════════════════════════════════════════════════════════════════════════
#  8. The endpoint, driven for real
# ══════════════════════════════════════════════════════════════════════════════
#
# `POST /api/auth/refresh`. Sections 1–7 exercise `renew_session`; this drives
# the route on top of it, because the route is where the answer becomes a 401
# with a message on it, and where a renewal becomes an audit entry.
#
# It takes no `Depends(current_user)` and that is not an oversight — it is what
# lets an agency and a coin seller renew through the identical path as staff
# (`current_user` refuses an external session on any route not named in
# `PARTNER_REACHABLE`), and what lets an already-lapsed token be presented at
# all. Both are asserted below.

build_world()

REQUEST = types.SimpleNamespace(client=None)


def call_refresh(token: str):
    return auth_router.refresh(auth_router.SessionRefresh(token=token), REQUEST)


def audit_entries(action: str) -> list[dict]:
    return [e for e in WORLD[C.AUDIT].docs if e["action"] == action]


staff_token = token_for("uid-owner", "owner@zipper.test")
travel(days=6, hours=2)
response = asyncio.run(call_refresh(staff_token))

check("the endpoint answers with a session", session_of(response.token)["uid"], "uid-owner")
check("…naming the person", response.user["role"], str(Role.OWNER))
ok("…with an expiry on it", bool(response.expires_at))
check(
    "…and a renew_at a day before it, so the browser holds no copy of the number",
    minutes_of_life(
        datetime.fromisoformat(response.renew_at),
        datetime.fromisoformat(response.expires_at),
    ),
    settings.session_renew_before_minutes,
)
renewals = audit_entries("login.succeeded")
check("a renewal is one audit entry", len(renewals), 1)
check("…recorded as a renewal, not a sign-in", renewals[0]["meta"]["method"], "refresh")
check("…against the person it renewed", renewals[0]["actor"]["uid"], "uid-owner")
check("…saying what happened", renewals[0]["reason"], "Session renewed")
rewind()

# A partner renews through this route exactly as staff do — the case the
# owner's complaint names, since "seller or agency details" is a partner
# portal screen as often as it is a staff one.
build_world()
partner_token = token_for("uid-seller")
partner_response = asyncio.run(call_refresh(partner_token))
check(
    "an external partner renews through the same endpoint",
    session_of(partner_response.token)["partner_ids"],
    {"seller": "seller-live"},
)
ok(
    "…and the route carries no session dependency, which is what makes that work",
    "current_user" not in auth_router.refresh.__code__.co_names,
)

# Refusals, through the route.
build_world()
build_token = token_for("uid-fired", "fired@zipper.test")
asyncio.run(WORLD[C.STAFF].update_one({"uid": "uid-fired"}, {"$set": {"is_active": False}}))
detail = rejects_401(
    "a deactivated account at the endpoint", lambda: call_refresh(build_token)
)
check("the endpoint answers 401 with the reason", detail, "This account has been deactivated.")
refusals = audit_entries("login.failed")
check("…and records the refusal", len(refusals), 1)
check("…as a refused renewal", refusals[0]["meta"]["method"], "refresh")
check("…with the reason on it", refusals[0]["reason"], "This account has been deactivated.")

rejects_401("garbage at the endpoint", lambda: call_refresh("not-a-token"))
check("…which is also recorded", len(audit_entries("login.failed")), 2)

# And the whole point: the endpoint accepts a token that has already expired,
# which no route behind `current_user` could.
build_world()
lapsed = token_for("uid-ops", "priya@zipper.test")
travel(days=7, hours=6)
refuses("an expired token on a normal route", lambda: sec.verify_session(lapsed))
lapsed_response = asyncio.run(call_refresh(lapsed))
check(
    "an expired token inside the grace window is renewed by the endpoint",
    session_of(lapsed_response.token)["uid"],
    "uid-ops",
)
rewind()


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\n  ✓ all {checks} session-lifetime checks passed\n")
print(f"    {'session':<34} {'minutes':>9}   {'':<4}")
for label, value in (
    ("staff, owners and partners", settings.session_ttl_minutes),
    ("the observer", settings.observer_session_ttl_minutes),
    ("renewal grace after expiry", settings.session_renewal_grace_minutes),
    ("renew this long before expiry", settings.session_renew_before_minutes),
):
    print(f"    {label:<34} {value:>9}   ({value / 1440:g} days)")

print()
print("  · a session lasts a week, not the twelve hours that produced the")
print("    complaint — checked by moving the clock thirteen hours and finding")
print("    the token that used to be dead still working")
print("  · an active session renews before it expires, and a renewal re-reads")
print("    the account: a partner's scope is resolved again from Mongo, so an")
print("    approval lands without a second sign-in and a withdrawal lands too")
print("  · renewal refuses a deactivated account, a changed role, a deactivated")
print("    or rejected partner, a departed staff row, a tampered token and a")
print("    session with no record — each against the server's state, never")
print("    against what the token claims, including a correctly signed claim")
print("    that promotes itself to owner or names another agency's records")
print("  · a revoked session stays revoked: presented five times, and again six")
print("    days later, and it is refused identically every time")
print("  · the observer is untouched — twelve hours, un-renewable, one code at")
print("    a time, still delivered to a mailbox that is not their own")
print("  · an absence of more than the grace window is the one refusal an")
print("    innocent person meets, and it is checked before anything is read")
print("  · a refusal is a fixed point: twenty-five attempts, one answer, no")
print("    session written — and twenty successful renewals leave one live")
print("    session rather than twenty")
sys.exit(0)
