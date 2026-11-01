"""An external partner's session: how it is resolved, and what it can reach.

Until now no agency and no coin seller could obtain an API session at all —
`sign_in_with_firebase` read the Mongo `staff` collection, and no partner is
ever written there. The whole of `app/routers/partners.py` was unreachable, and
so was the commission balance an agency is promised in Part 0 of CRM-FLOW.md.

That gap is closed, and closing it points a real caller at an API every route of
which was written by somebody who knew the caller was staff. So these tests are
in three parts, and the middle one is the important one:

  * **Resolution** — the real `resolve_partner_login` against a fake Mongo and
    a fake Firestore. Approved agency and seller in; pending given a session
    that holds nothing; rejected and deactivated refused; staff first, always.
  * **Reach** — every route in the API, enumerated from the router source with
    `ast` rather than from a list written here, each one put in front of the
    real dependency with a real external session. A route is either on the
    allowlist or it is refused, and the table is printed so it can be read.
  * **Scope** — `own_partner_id_or_403`, including the dual-role login that has
    an agency record and a seller record and must reach both of its own and
    neither of anybody else's.
  * **The routes that were opened**, each driven end to end with a real partner
    session: the two writes the spec puts in a partner's hands (4.3.5 buying
    inventory, 4.3.8 filing a sale), the board that shows them where their own
    request got to, and the sub-agency payout legs. Reaching a route and being
    allowed to name an id in it are two different permissions, and only the
    second one is interesting, so every one of them is asked for somebody
    else's id and has to refuse — with nothing written when it does.

No database and no network: `tests/harness.py` stubs the I/O, so everything
under `app/` exercised here is the real, unmodified code.

Run:  python3 -m tests.test_partner_session
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, Request, install_stubs  # noqa: E402

install_stubs()


# `jose` is stubbed by the harness with an encoder that returns the literal
# string "token". A session test needs a round trip — the claims that come back
# out of `verify_session` have to be the ones `issue_session` put in, or the
# partner scope on a token is never actually asserted — so it is replaced with
# one that really carries them.
class _RoundTripJwt:
    @staticmethod
    def encode(claims, secret, algorithm=None):  # noqa: ARG004
        return json.dumps(claims)

    @staticmethod
    def decode(token, secret, algorithms=None, issuer=None):  # noqa: ARG004
        return json.loads(token)


sys.modules["jose"] = types.ModuleType("jose")
sys.modules["jose"].JWTError = type("JWTError", (Exception,), {})
sys.modules["jose"].jwt = _RoundTripJwt

from app.core import deps  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core import security as sec  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

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


def forbids(label: str, fn) -> str:
    """This must be a 403, not an answer."""
    global checks
    checks += 1
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        if code == 403:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 403")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ══════════════════════════════════════════════════════════════════════════════
#  The world
# ══════════════════════════════════════════════════════════════════════════════
#
# Field names are the real ones: `partners` documents as
# `partner_ops._new_partner_document` writes them, and `crmUsers` documents as
# `createAgencyAccount` / `createSellerAccount` in `zipper-crm/lib/auth.ts`
# write them. Nothing here is a shape invented for the test.

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)


def partner(pid: str, kind: str, status: str, active: bool, **extra) -> dict:
    return {
        "_id": pid,
        "kind": kind,
        "name": f"{pid} Ltd",
        "status": status,
        "is_active": active,
        "credit": {"outstanding": 0, "due_at": None},
        "cash_paid_minor": 0,
        "total_coins_sold": 0,
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
        "createdBy": "self_signup",
        **extra,
    }


PARTNERS = [
    partner("agency-live", "agency", "approved", True),
    partner("agency-sub", "sub_agency", "approved", True, parent_id="agency-live"),
    partner("seller-live", "seller", "approved", True),
    partner("agency-pending", "agency", "pending", False),
    partner(
        "seller-rejected",
        "seller",
        "rejected",
        False,
        rejection_reason="The PAN on the KYC document does not match the bank account.",
    ),
    partner("agency-suspended", "agency", "suspended", False),
    partner("agency-other", "agency", "approved", True),
    # The dual-role login: one person, two businesses, two records.
    partner("dual-agency", "agency", "approved", True, linked_partner_id="dual-seller"),
    partner(
        "dual-seller",
        "seller",
        "approved",
        True,
        second_role_of="dual-agency",
        owner_crm_uid="uid-dual",
    ),
    # An orphan: a real business record with no login attached anywhere.
    partner("agency-orphan", "agency", "approved", True),
    # A record whose `kind` is nonsense. It must grant nothing.
    partner("partner-corrupt", "wholesaler", "approved", True),
]

CRM_USERS = {
    "uid-agency": crm_user("uid-agency", "agency", agencyId="agency-live"),
    # The same agency record, held by a login that is NOT also in `staff`. Used
    # in section 7, where the point is a real external agency session rather
    # than the staff-wins case `uid-agency` exists to prove.
    "uid-agency-only": crm_user("uid-agency-only", "agency", agencyId="agency-live"),
    "uid-sub": crm_user("uid-sub", "agency", agencyId="agency-sub"),
    "uid-seller": crm_user("uid-seller", "seller", sellerId="seller-live"),
    "uid-pending": crm_user(
        "uid-pending", "agency", agencyId="agency-pending", status="pending"
    ),
    "uid-rejected": crm_user("uid-rejected", "seller", sellerId="seller-rejected"),
    "uid-suspended": crm_user(
        "uid-suspended", "agency", agencyId="agency-suspended"
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
        roleStatus={"agency": "approved", "seller": "approved"},
    ),
    # Holds a sellerId but has never been granted the seller capability. The
    # link must not be read: `partnerRolesOf` would not read it either.
    "uid-unclaimed": crm_user(
        "uid-unclaimed", "agency", agencyId="agency-live", sellerId="seller-live"
    ),
    # A staff document with no staff row — a half-created account. It must not
    # resolve to a partner just because a crmUsers document exists.
    "uid-halfstaff": crm_user("uid-halfstaff", "ops_admin"),
    # Names a partner record that was never registered in Mongo.
    "uid-unregistered": crm_user(
        "uid-unregistered", "agency", agencyId="agency-never-registered"
    ),
    "uid-corrupt": crm_user("uid-corrupt", "agency", agencyId="partner-corrupt"),
}

STAFF = [
    {
        "uid": "uid-staff",
        "email": "priya@zipper.test",
        "name": "Priya",
        "role": "ops_admin",
        "is_active": True,
    },
    # The person who is both: an ops member who also owns an agency.
    {
        "uid": "uid-agency",
        "email": "uid-agency@example.test",
        "name": "Both Hats",
        "role": "finance_member",
        "is_active": True,
    },
    {
        "uid": "uid-gone",
        "email": "gone@zipper.test",
        "name": "Departed",
        "role": "ops_member",
        "is_active": False,
    },
]


def build_world(staff=STAFF) -> FakeDb:
    db = FakeDb()
    db.seed(C.PARTNERS, PARTNERS)
    db.seed(C.STAFF, staff)
    sec.get_db = lambda: db  # type: ignore[assignment]
    return db


def install_firestore(users: dict) -> None:
    """The `crmUsers` half, through `crm_directory`'s own two accessors.

    Patched at the accessor rather than at the Firestore client on purpose: the
    real `resolve_partner_login` calls exactly these, and a test that faked the
    client would also be testing `google.cloud.firestore`.
    """
    crm.read = lambda uid: users.get(uid)  # type: ignore[assignment]
    crm.find_by_email = lambda email: [  # type: ignore[assignment]
        (uid, doc)
        for uid, doc in users.items()
        if str(doc.get("email", "")).lower() == (email or "").lower()
    ]


def sign_in(uid: str, email: str = "") -> tuple[str, object, dict]:
    firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
        "uid": uid,
        "email": email or f"{uid}@example.test",
    }
    return asyncio.run(sec.sign_in_with_firebase("an-id-token"))


def refuses_sign_in(label: str, uid: str, email: str = "") -> str:
    """Signing in as this uid must be refused, and the message is returned."""
    firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
        "uid": uid,
        "email": email or f"{uid}@example.test",
    }
    return refuses(label, lambda: sec.sign_in_with_firebase("an-id-token"))


def session_for(uid: str, email: str = "") -> dict:
    token, _expires, _profile = sign_in(uid, email)
    return asyncio.run(sec.verify_session(token))


build_world()
install_firestore(CRM_USERS)


# ══════════════════════════════════════════════════════════════════════════════
#  1. An approved agency and an approved seller get in
# ══════════════════════════════════════════════════════════════════════════════

_token, _expires, profile = sign_in("uid-seller")
check("approved seller role", profile["role"], "seller")
check("approved seller scope", profile["partner_ids"], {"seller": "seller-live"})
check("approved seller access", profile["access"], "records")
check("approved seller status", profile["partner_status"], "approved")
check("a partner has no team", profile["team"], None)

seller_session = asyncio.run(sec.verify_session(_token))
check("seller session role", seller_session["role"], Role.SELLER)
check("seller session ids", seller_session["partner_ids"], {"seller": "seller-live"})

sub = session_for("uid-sub")
check("a sub-agency signs in as an agency", sub["role"], Role.AGENCY)
check("a sub-agency is scoped to itself", sub["partner_ids"], {"agency": "agency-sub"})

# The resolved role is one of exactly two, whatever the record says. A partner
# whose `kind` is not a partner kind is granted nothing rather than granted
# something derived from the string on the record.
corrupt = asyncio.run(sec.resolve_partner_login("uid-corrupt", "x@example.test"))
check("a corrupt kind resolves to no partner at all", corrupt, None)
for role in (Role.AGENCY, Role.SELLER):
    ok(f"{role} is external", R.is_external(role))
for role in Role:
    if role not in (Role.AGENCY, Role.SELLER):
        ok(f"{role} is not external", not R.is_external(role))
ok("a machine credential is not external", not R.is_external(R.SYSTEM_ROLE))

# A `crmUsers` document naming a partner nobody registered in Mongo is not an
# account. It is answered exactly as a stranger is.
check(
    "an unregistered partner id resolves to nothing",
    asyncio.run(sec.resolve_partner_login("uid-unregistered", "u@example.test")),
    None,
)
check(
    "a login nobody knows is answered as it always was",
    refuses_sign_in("a login nobody knows", "uid-nobody"),
    "No account found. Contact your administrator.",
)

# A half-created staff account resolves to no partner. Answering "you are an
# agency" because a crmUsers document exists would be worse than "no account".
check(
    "a staff crmUsers document is not a partner link",
    asyncio.run(sec.resolve_partner_login("uid-halfstaff", "h@example.test")),
    None,
)


# ══════════════════════════════════════════════════════════════════════════════
#  2. Pending, rejected and deactivated
# ══════════════════════════════════════════════════════════════════════════════

_t, _e, pending_profile = sign_in("uid-pending")
check("a pending applicant gets a session", bool(_t), True)
check("a pending applicant holds no partner id", pending_profile["partner_ids"], {})
check("a pending applicant's access", pending_profile["access"], "none")
check("a pending applicant's status", pending_profile["partner_status"], "pending")

pending_session = asyncio.run(sec.verify_session(_t))
check("pending session carries no scope", pending_session["partner_ids"], {})
check("pending session partner_id is blank", pending_session["partner_id"], "")

# The whole justification for issuing it: it can reach nothing.
forbids(
    "a pending applicant cannot read their own statement",
    lambda: deps.own_partner_id_or_403(pending_session, "agency-pending", "agency"),
)
forbids(
    "a pending applicant cannot read 'me'",
    lambda: deps.own_partner_id_or_403(pending_session, "me", "agency"),
)
forbids(
    "a pending applicant cannot read anybody else",
    lambda: deps.own_partner_id_or_403(pending_session, "agency-live", "agency"),
)

rejected = refuses_sign_in("a rejected applicant", "uid-rejected")
ok(
    "a rejection carries the reason stored on the record",
    "PAN on the KYC document" in rejected,
)

suspended = refuses_sign_in("a deactivated partner", "uid-suspended")
check(
    "a deactivated partner is told so", suspended, "This account has been deactivated."
)

switched_off = refuses_sign_in(
    "an account switched off in the CRM", "uid-switched-off"
)
check(
    "crmUsers.isActive false is honoured",
    switched_off,
    "This account has been deactivated.",
)


# ══════════════════════════════════════════════════════════════════════════════
#  3. Staff takes precedence
# ══════════════════════════════════════════════════════════════════════════════
#
# `uid-agency` is both: a finance_member row in `staff` AND the owner of
# `agency-live` in `crmUsers`. The staff row wins, and the partner collection is
# not consulted — so the session carries an internal role and no partner scope.

both = session_for("uid-agency")
check("both hats resolve to staff", both["role"], Role.FINANCE_MEMBER)
check("a staff session carries no partner scope", both["partner_ids"], {})
check("a staff session's partner_id is blank", both["partner_id"], "")
ok("a staff session is internal", R.is_internal(both["role"]))
check(
    "staff read any partner id unchanged",
    deps.own_partner_id_or_403(both, "agency-other", "agency"),
    "agency-other",
)

deactivated_staff = refuses_sign_in(
    "a deactivated staff member", "uid-gone", "gone@zipper.test"
)
check(
    "staff deactivation is unchanged",
    deactivated_staff,
    "This account has been deactivated.",
)

# ── The observer is not reachable from a Firebase token ──────────────────────
#
# It is a read-only identity with `can_read_all`, and it deliberately has NO
# FIREBASE ACCOUNT (`scripts/seed_accounts.py`: "Deliberately no Firebase
# account and no password"). Its Mongo uid is synthetic — `observer:<email>` —
# so the uid lookup in `sign_in_with_firebase` can never match it.
#
# The EMAIL fallback on the next line could, and that was a live hole: the
# address is unclaimed in Firebase precisely because it has no account, so
# anybody able to sign in with that Gmail minted a token bearing it, fell
# through to the email lookup, and was issued a genuine observer session with
# read access to the whole business. No password required, because there is no
# password to require.
#
# The observer's only door is the one-time code mailed to a separate address.
build_world(
    STAFF
    + [
        {
            "uid": "observer:watch@zipper.test",
            "email": "watch@zipper.test",
            "name": "Observer",
            "role": str(R.Role.OBSERVER),
            "is_active": True,
        }
    ]
)

observer_refused = refuses_sign_in(
    "the observer, holding a Firebase token for its own address",
    "some-fresh-google-uid",
    "watch@zipper.test",
)
# B3 (spec §8): refused BY NAME — `security.ObserverDenied`, code
# `observer_denied` — so the app and the CRM can say "this account is CRM-only"
# instead of a dead end, and the router audits it as `auth.observer_denied`.
# The caller already proved control of the address, so naming it costs nothing.
check(
    "…and is told so by name (B3: observer_denied)",
    observer_refused,
    sec.OBSERVER_DENIED_MESSAGE,
)
check("…with a machine-readable code", sec.ObserverDenied.code, "observer_denied")

# ── The email fallback, as it is now ─────────────────────────────────────────
#
# This used to assert that an arbitrary uid bearing a staff member's address was
# handed that staff member's role, on the reasoning that it lets somebody whose
# Firebase uid changed keep their session. It does — and it let anybody else in
# too. The email on an ID token is not a claim to the ACCOUNT that address
# belongs to: Google, a phone sign-in with a profile email, and a fresh password
# signup all produce one. Adding Google to the CRM would have made that path the
# normal one, since a Google sign-in mints a NEW uid for an address that already
# has a password account.
#
# Three outcomes now, and which one depends on facts rather than on the string.

# 1. The recorded uid still names a live account. Two real identities for one
#    person: refused, and named as such, because resolving it means linking
#    providers or retiring one — decisions with a person attached.
firebase_mod.get_user = lambda uid: types.SimpleNamespace(uid=uid)  # type: ignore[assignment]
conflict = refuses_sign_in(
    "a different uid bearing a staff member's address, while their own account lives",
    "a-different-uid",
    "priya@zipper.test",
)
ok(
    "…and is told to sign in the original way and connect this one",
    "connect this one" in conflict.lower(),
)

# 2. The recorded uid names nothing — the row is unreachable, nobody can ever
#    produce a token for it — but this sign-in did not prove the address, so it
#    is still not adopted. `sign_in()` builds a token with no `email_verified`
#    and no `sign_in_provider`, which is exactly a sign-in that proves nothing.
firebase_mod.get_user = lambda _uid: None  # type: ignore[assignment]
refuses_sign_in(
    "an unreachable row is not adopted by a sign-in that proved no address",
    "a-different-uid",
    "priya@zipper.test",
)

# 3. Unreachable row, and the address IS proved. Still refused — rewriting an
#    identity record is a repair somebody performs, not something a sign-in does
#    on an unauthenticated person's say-so. `_proves_email` accepts the
#    `password` provider, and the app's guest email-binding now hands ordinary
#    users exactly that (`EmailAuthProvider.PROVIDER_ID` is the string
#    "password"), so "proved the mailbox" no longer implies "is staff".
#    `scripts/repair_staff_accounts.py` is the deliberate path.
firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
    "uid": "a-different-uid",
    "email": "priya@zipper.test",
    "email_verified": True,
    "firebase": {"sign_in_provider": "google.com"},
}
unreachable = refuses(
    "an unreachable row is a repair job, not a sign-in",
    lambda: sec.sign_in_with_firebase("an-id-token"),
)
ok(
    "…and the person is told it must be reconnected, not that they are wrong",
    "reconnected" in unreachable.lower(),
)

# Back to the ordinary world for everything after this point.
build_world()

# And a partner cannot acquire staff scope by carrying a partner claim: an
# internal role's claims are dropped rather than trusted.
forged = json.dumps(
    {
        **json.loads(sign_in("uid-staff", "priya@zipper.test")[0]),
        "partners": {"agency": "agency-other"},
    }
)
check(
    "a partner claim on a staff token is dropped",
    asyncio.run(sec.verify_session(forged))["partner_ids"],
    {},
)


# ══════════════════════════════════════════════════════════════════════════════
#  4. A dual-role partner
# ══════════════════════════════════════════════════════════════════════════════
#
# One login, `roles: ['agency','seller']` on the crmUsers document, two partner
# records. The session must reach both of theirs and neither of anybody else's.

dual = session_for("uid-dual")
check(
    "a dual-role login is scoped to both of its records",
    dual["partner_ids"],
    {"agency": "dual-agency", "seller": "dual-seller"},
)
ok("a dual-role login holds one of the two external roles", R.is_external(dual["role"]))

check(
    "the agency route reaches the agency record",
    deps.own_partner_id_or_403(dual, "dual-agency", "agency"),
    "dual-agency",
)
check(
    "the seller route reaches the seller record",
    deps.own_partner_id_or_403(dual, "dual-seller", "seller"),
    "dual-seller",
)
check(
    "'me' on the agency route is the agency record",
    deps.own_partner_id_or_403(dual, "me", "agency"),
    "dual-agency",
)
check(
    "'me' on the seller route is the seller record",
    deps.own_partner_id_or_403(dual, "me", "seller"),
    "dual-seller",
)
check(
    "either of their own records on the kind-agnostic route",
    sorted(deps.partner_ids_of(dual)),
    ["dual-agency", "dual-seller"],
)
forbids(
    "a dual-role partner cannot read their seller record through an agency route",
    lambda: deps.own_partner_id_or_403(dual, "dual-seller", "agency"),
)
forbids(
    "a dual-role partner cannot read their agency record through a seller route",
    lambda: deps.own_partner_id_or_403(dual, "dual-agency", "seller"),
)
for stranger in ("agency-live", "agency-other", "seller-live", "agency-orphan"):
    forbids(
        f"a dual-role partner cannot read {stranger}",
        lambda s=stranger: deps.own_partner_id_or_403(dual, s),
    )

# A `sellerId` on a document that does not hold the seller capability is not a
# link. `partnerRolesOf` in the CRM would not read it either.
unclaimed = session_for("uid-unclaimed")
check(
    "an unclaimed link is not read",
    unclaimed["partner_ids"],
    {"agency": "agency-live"},
)

# The Mongo link resolves a partner whose crmUsers document was never written —
# the orphan case the attach-login endpoint exists for.
orphan_db = build_world()
orphan_db[C.PARTNERS].docs.append(
    partner("agency-attached", "agency", "approved", True, owner_crm_uid="uid-attached")
)
install_firestore({})
attached = asyncio.run(sec.resolve_partner_login("uid-attached", "a@example.test"))
check(
    "a Mongo-only link resolves without Firestore",
    dict(attached.partner_ids) if attached else None,
    {"agency": "agency-attached"},
)
build_world()
install_firestore(CRM_USERS)


# ══════════════════════════════════════════════════════════════════════════════
#  5. Scope — a partner reaching their own record, and refused another's
# ══════════════════════════════════════════════════════════════════════════════

agency_session = session_for("uid-sub")
check(
    "an agency reads its own statement",
    deps.own_partner_id_or_403(agency_session, "agency-sub", "agency"),
    "agency-sub",
)
check(
    "'me' resolves for a single-capability login",
    deps.own_partner_id_or_403(agency_session, "me", "agency"),
    "agency-sub",
)
detail = forbids(
    "an agency cannot read another agency",
    lambda: deps.own_partner_id_or_403(agency_session, "agency-other", "agency"),
)
check("and is told why", detail, "You can only view your own records.")
forbids(
    "an agency cannot read a seller",
    lambda: deps.own_partner_id_or_403(agency_session, "seller-live", "seller"),
)
forbids(
    "a seller cannot read an agency",
    lambda: deps.own_partner_id_or_403(seller_session, "agency-live", "agency"),
)
forbids(
    "a seller cannot read another seller",
    lambda: deps.own_partner_id_or_403(seller_session, "dual-seller", "seller"),
)

# `require_write` is the guard on partner approval, card verification, user bans
# and staff role changes. It refused only the observer.
forbids(
    "a partner cannot satisfy require_write",
    lambda: asyncio.run(deps.require_write(seller_session)),
)
for internal in (Role.OWNER, Role.OPS_ADMIN, Role.FINANCE_MEMBER, Role.TECH_ADMIN):
    check(
        f"{internal} still satisfies require_write",
        asyncio.run(deps.require_write({"role": internal, "uid": "x"}))["role"],
        internal,
    )
forbids(
    "the observer is still refused by require_write",
    lambda: asyncio.run(deps.require_write({"role": Role.OBSERVER, "uid": "x"})),
)
forbids(
    "a partner cannot satisfy require_internal",
    lambda: asyncio.run(deps.require_internal(seller_session)),
)
forbids(
    "a partner cannot satisfy require_team_admin",
    lambda: asyncio.run(deps.require_team_admin(seller_session)),
)
forbids(
    "a partner cannot satisfy require_owner",
    lambda: asyncio.run(deps.require_owner(seller_session)),
)


# ══════════════════════════════════════════════════════════════════════════════
#  6. Every route an external session can reach
# ══════════════════════════════════════════════════════════════════════════════
#
# Enumerated from the router source, not from a list written here — a route
# added tomorrow appears in this table on the next run whether or not anybody
# remembered to add it. Each one is then put in front of the real dependency
# with a real external session, and must be allowlisted or refused.

ROUTERS = ROOT / "app" / "routers"

#: Dependencies that refuse an external role by themselves. Every one of these
#: is asserted above rather than assumed here.
INTERNAL_ONLY = {
    "require_internal",
    "require_owner",
    "require_team_admin",
    "require_write",
    "internal_or_accrual_service",
    "internal_or_email_events_service",
    "team_admin_or_accrual_service",
    "team_admin_or_alerts_service",
    "team_admin_or_email_sweep_service",
    "team_admin_or_partner_registration_service",
    "team_admin_or_reporting_service",
}


def api_prefixes() -> dict[str, str]:
    """`{router module: mounted prefix}` read out of `app/main.py`."""
    tree = ast.parse((ROOT / "app" / "main.py").read_text())
    found: dict[str, str] = {}
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "include_router"
            and node.args
        ):
            continue
        target = node.args[0]
        if not (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)):
            continue
        prefix = ""
        for kw in node.keywords:
            if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                prefix = str(kw.value.value)
        found[target.value.id] = prefix
    return found


#: The names the shared scope check is reachable under. `routers/partner_ops.py`
#: binds `own_partner_id_or_403` to `_own_id_or_403` at module level so its two
#: dozen routes read the same; both names are the same function object, and a
#: route that calls neither has not scoped anything.
SCOPE_CALLS = {"own_partner_id_or_403", "_own_id_or_403"}

#: The guard on a route a partner may WRITE to. There are two, and the pair
#: `require_write_or_partner` + a call to `own_partner_id_or_403` is what makes
#: them safe — the guard alone admits an external session without scoping it,
#: which is stated in its own docstring and asserted below.
PARTNER_WRITE_GUARD = "require_write_or_partner"

#: Decision 15 (RC): the scope of a route that names NO record — it acts on the
#: signed-in person themselves. Accepted in place of `own_partner_id_or_403`
#: only on a route with no path parameter and no id field in its body, which is
#: asserted below; a route with an id in it must scope that id.
SELF_SCOPE_CALLS = {"own_session_uid"}


def _is_id_field(name: str) -> bool:
    name = name.lower()
    return name in {"id", "uid"} or name.endswith("_id") or name.endswith("_uid")


def _model_fields(tree: ast.AST) -> dict[str, set[str]]:
    """Each class in a router module → the names of its annotated fields."""
    out: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            out[node.name] = {
                stmt.target.id
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            }
    return out


def routes_of(module: str, mount: str) -> list[dict]:
    """Every route a router file declares, with the dependency guarding it."""
    tree = ast.parse((ROUTERS / f"{module}.py").read_text())
    models = _model_fields(tree)

    prefix = ""
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "APIRouter"
        ):
            for kw in node.value.keywords:
                if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                    prefix = str(kw.value.value)

    out: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        guards: set[str] = set()
        for default in list(node.args.defaults) + list(node.args.kw_defaults):
            if (
                isinstance(default, ast.Call)
                and isinstance(default.func, ast.Name)
                and default.func.id == "Depends"
                and default.args
                and isinstance(default.args[0], ast.Name)
            ):
                guards.add(default.args[0].id)

        # Does the body pin the id it was handed to the caller's own record?
        # Read out of the source rather than asserted route by route, so a write
        # put on the allowlist tomorrow without one is a failing test today
        # rather than a hole nobody is looking for.
        called = {
            inner.func.id
            for inner in ast.walk(node)
            if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
        }
        scopes = bool(called & SCOPE_CALLS)
        self_scoped = bool(called & SELF_SCOPE_CALLS)
        # Every id the request can carry into this route: its own parameters
        # (path and query) and the fields of any body model it takes.
        request_ids: set[str] = set()
        for arg in list(node.args.args) + list(node.args.kwonlyargs):
            if arg.arg in {"user", "self"}:
                continue
            if _is_id_field(arg.arg):
                request_ids.add(arg.arg)
            annotation = arg.annotation
            if isinstance(annotation, ast.Name) and annotation.id in models:
                request_ids |= {f for f in models[annotation.id] if _is_id_field(f)}

        for decorator in node.decorator_list:
            if not (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and isinstance(decorator.func.value, ast.Name)
                and decorator.func.value.id == "router"
                and decorator.func.attr
                in {"get", "post", "put", "patch", "delete"}
                and decorator.args
                and isinstance(decorator.args[0], ast.Constant)
            ):
                continue
            out.append(
                {
                    "method": decorator.func.attr.upper(),
                    "path": f"{mount}{prefix}{decorator.args[0].value}",
                    "endpoint": f"{module}.{node.name}",
                    "guards": guards,
                    "scopes": scopes,
                    "self_scoped": self_scoped,
                    "request_ids": request_ids,
                }
            )
    return out


ALL_ROUTES: list[dict] = []
for module, mount in sorted(api_prefixes().items()):
    ALL_ROUTES.extend(routes_of(module, mount))
ALL_ROUTES.sort(key=lambda r: (r["path"], r["method"]))

ok("the API has routes to enumerate", len(ALL_ROUTES) > 50)

# Every allowlisted entry names a route that exists. A stale entry is a hole
# nobody would ever notice, because it refuses nothing and nothing points at it.
declared = {(r["method"], r["path"]) for r in ALL_ROUTES}
for entry in sorted(deps.PARTNER_REACHABLE):
    ok(f"PARTNER_REACHABLE entry {entry[0]} {entry[1]} names a real route",
       entry in declared)

# Every allowlisted READ is guarded by a bare `current_user`. One behind
# `require_internal` would be on the list and unreachable, which reads as a
# grant and is not one.
#
# Every allowlisted WRITE is guarded by `require_write_or_partner` **and** calls
# `own_partner_id_or_403` in its body. The two halves are separate claims and
# both matter: the guard is what admits the partner, and the scope call is the
# only thing standing between "a seller may buy inventory" and "a seller may buy
# inventory in another seller's name". A write on the allowlist without one is
# the exact hole this whole module exists to close.
for route in ALL_ROUTES:
    key = (route["method"], route["path"])
    if key not in deps.PARTNER_REACHABLE:
        continue
    if (route["method"] == "GET" or route["path"].endswith("/signout")
            or route["path"].endswith("/sessions/revoke-all")):
        # Sign-out and "sign out everywhere" (B3 / §13) are the two writes a
        # plain session makes about ITSELF: no record is named, nothing of the
        # business moves, and the Observer — refused by `require_write` — must
        # be able to make both. The scope is `own_session_uid`, asserted below.
        ok(
            f"{route['endpoint']} is allowlisted and takes a plain session",
            route["guards"] == {"current_user"},
        )
        if route["path"].endswith("/sessions/revoke-all"):
            ok(
                f"{route['endpoint']} acts on the session's own uid and names nobody",
                route["self_scoped"] and "{" not in route["path"] and not route["request_ids"],
            )
    else:
        ok(
            f"{route['endpoint']} is an allowlisted write and says so in its signature",
            route["guards"] == {PARTNER_WRITE_GUARD},
        )
        if route["self_scoped"] and not route["scopes"]:
            # Decision 15 (RC): a write that names no record at all. Safe only
            # while it really names none — no `{…}` in the path, and no id
            # parameter or id field in its body — so that is what is asserted.
            ok(
                f"{route['endpoint']} is self-scoped and its path carries no id",
                "{" not in route["path"],
            )
            ok(
                f"{route['endpoint']} is self-scoped and its request carries no id "
                f"(found {sorted(route['request_ids'])})",
                not route["request_ids"],
            )
        else:
            ok(
                f"{route['endpoint']} scopes the id it is handed to the caller's own record",
                route["scopes"],
            )

# A route that says "self-scoped" anywhere must mean it, allowlisted or not.
for route in ALL_ROUTES:
    if route["self_scoped"] and not route["scopes"]:
        ok(
            f"{route['endpoint']} calls own_session_uid and names no other account",
            "{" not in route["path"] and not route["request_ids"],
        )

# And the converse: nothing outside the allowlist wears the partner write guard.
# It exists for exactly two routes, and a third wearing it without being on the
# list would be dead weight that reads like a grant.
for route in ALL_ROUTES:
    if PARTNER_WRITE_GUARD in route["guards"]:
        ok(
            f"{route['endpoint']} wears the partner write guard and is allowlisted",
            (route["method"], route["path"]) in deps.PARTNER_REACHABLE,
        )

# The table. Each route is put in front of the real refusal with a real
# external session; nothing here re-implements the decision.
#
# The real code writes a warning naming the session and the route every time it
# turns one away, which is exactly what an operator wants in production and is
# eighty lines of noise in front of the table below. It is silenced here; the
# refusal itself is asserted, not read out of the log.
logging.getLogger("app.core.deps").setLevel(logging.CRITICAL)
logging.getLogger("app.core.security").setLevel(logging.CRITICAL)
table: list[tuple[str, str, str, str]] = []
for route in ALL_ROUTES:
    key = (route["method"], route["path"])
    request = Request(route["method"], route["path"])
    guards = route["guards"]

    if key in deps.PARTNER_REACHABLE:
        verdict = "scoped"
        try:
            deps._refuse_unreachable_route(request, seller_session)
        except Exception as exc:  # noqa: BLE001
            failures.append(
                f"{route['endpoint']} is allowlisted but was refused: {exc}"
            )
    elif not guards:
        # No session at all — sign-in, the observer's two code endpoints, health.
        verdict = "unauthenticated"
    else:
        verdict = "refused"
        allowed_through = True
        try:
            deps._refuse_unreachable_route(request, seller_session)
        except Exception:  # noqa: BLE001
            allowed_through = False
        ok(
            f"{route['method']} {route['path']} refuses an external session",
            not allowed_through,
        )
        if guards & INTERNAL_ONLY:
            verdict = "refused (twice)"

    table.append(
        (route["method"], route["path"], verdict, ",".join(sorted(guards)) or "—")
    )

reachable = [row for row in table if row[2] == "scoped"]
# Seventeen. Fifteen until the appeals work added two, both agency-scoped GETs:
# the reports filed against an agency's own hosts, and what became of the
# appeals it raised about them. An agency could previously see neither — a host
# would be suspended, their earnings would stop, and the agency would find out
# by noticing the beans had gone quiet.
#
# The count is pinned on purpose: a route joining this list is a grant to an
# outside business, and it should cost somebody a deliberate edit here.
# Nineteen. The eighteenth and nineteenth are `GET /api/documents/{kind}/{record_id}`,
# which did not widen anything: a partner could already see its own KYC
# documents on the dashboard, straight from the permanent
# `?alt=media&token=` URL stored at upload. That URL is a bearer
# credential Storage Rules are never consulted for, so the route exists
# to take the dashboard OFF it — refusing partners here would have left
# them on the permanent link.
# Twenty-two: `GET /api/partner-ops/buyers/lookup`, so a coin seller can name
# the buyer of a sale (the CRM may not list `users`). Seller-only, exact match,
# masked contact details.
# Twenty-five since Decision 15 (RC): `GET /api/partner-ops/me/verification`
# and the two self-scoped POSTs beside it, so a person whose approved role is
# waiting for BOTH verified contacts can see what is missing, start the role
# once both are verified, and report a contact held by another account. All
# three act on the session's own uid and take no id (asserted above).
# Twenty-six since Decision 16 (RC): `POST /api/partner-ops/agencies/
# {agency_id}/sub-agencies/reapply`, a parent agency filing a FRESH Sub-agency
# application for a person whose earlier one was rejected. Scoped to the
# caller's own agency id (asserted above), pending, holding nothing.
# Twenty-eight since B3 (spec §13, B-21): `GET /api/auth/sessions` and
# `POST /api/auth/sessions/revoke-all` — the sessions a login holds and "sign
# out everywhere". Both act on the session's OWN uid and take no id (asserted
# above); an agency that sees a session it does not recognise is exactly who
# needs to be able to end it. Nothing of the business is read or moved.
check("exactly twenty-eight routes are partner-reachable", len(reachable), 28)
check(
    "and they are the twenty-eight named in PARTNER_REACHABLE",
    {(row[0], row[1]) for row in reachable},
    set(deps.PARTNER_REACHABLE),
)

# The bare-`current_user` routes that are NOT allowlisted are the ones written
# for a staff caller without saying so. Pinned exactly, so the comment in
# `deps.py` that names them cannot drift away from the code, and so a new one
# appearing is a failing test rather than a line nobody reads.
unlisted = {
    (row[0], row[1])
    for row in table
    if row[2].startswith("refused") and row[3] == "current_user"
}
check(
    "the routes that take a bare session and were never meant for a partner",
    sorted(unlisted),
    [
        # P1-A3 — Owner two-step sign-in. Bare session because a PENDING Owner
        # session (mfa=False) must reach them; `owner_mfa` refuses every role
        # but Owner (403), and a partner is stopped here before that.
        ("GET", "/api/auth/mfa/status"),
        # Counts what is waiting on a verifier and a signer. A partner is
        # neither, and the third figure — their own cards in flight — is already
        # on /cards, scoped, with the stage attached.
        ("GET", "/api/cards/inbox"),
        # Searches EVERY card in the business for one UTR and answers with the
        # subject id of each. That is other sellers' ids by construction.
        ("GET", "/api/partner-ops/payment-references/{payment_ref}"),
        # The seven below scope on team, or on nothing at all.
        ("GET", "/api/staff"),
        ("GET", "/api/staff/assignable-roles"),
        # §9 (B2): the department Admin vacancy state — internal only.
        ("GET", "/api/staff/departments"),
        # The caller's own staff record, for /profile — salary and employment
        # id included, which is precisely why it is not on the allowlist. A
        # partner has no staff row and nothing to read here; more to the point,
        # a route that hands out a pay figure should be reachable by the
        # smallest possible set of sessions, and "internal only" is that set.
        # It takes no uid, so its scoping is structural rather than a filter:
        # there is no id in it for anyone to substitute.
        ("GET", "/api/staff/me"),
        ("GET", "/api/staff/overview"),
        # The appeals QUEUE — every appeal in the business, including other
        # agencies' hosts. An agency reads its own through
        # `/partners/agencies/{id}/appeals`, which is on the allowlist and
        # filters on `agencyId`; this one is for the person deciding them.
        ("GET", "/api/users/appeals"),
        # UGP-F: signed links to an appeal's private attachments — staff only.
        ("GET", "/api/users/appeals/{appeal_id}/evidence"),
        ("GET", "/api/users/devices/bans"),
        ("GET", "/api/users/reports"),
        ("GET", "/api/users/{uid}/history"),
        ("GET", "/api/users/{uid}/roles"),  # UGP-B: the CRM user page's role inventory
        ("GET", "/api/users/{uid}/warnings"),
        # P1-A3 — enrol, confirm, verify (reachable by a pending Owner session)
        # and replace recovery codes (a verified one; `deps` refuses pending).
        # P1-A3b — retry binding a verified Owner's Firebase sign-in.
        ("POST", "/api/auth/mfa/bind"),
        ("POST", "/api/auth/mfa/bind/confirm"),
        ("POST", "/api/auth/mfa/enrol/confirm"),
        ("POST", "/api/auth/mfa/enrol/start"),
        ("POST", "/api/auth/mfa/recovery-codes"),
        ("POST", "/api/auth/mfa/verify"),
    ],
)

# And the count of `require_write` routes, which is the guard that silently
# admitted an external role before today. Two came off it — not by widening it,
# but by moving to a guard that names the exception in the route's own
# signature, so `require_write` still means "no partner, ever".
#
# Forty-six now. Thirty-seven were the original set: two live-room
# interventions (8.7.3), three composed-email routes (8A.7.2), one `POST
# /capital` — an owner recording money put into the business or taken back out
# — and the rest. Every one of those six narrows further inside the route than
# this count can see: the live-room pair to Ops and owners, the broadcast trio
# by audience in `broadcast.check_authority` where writing to every app user is
# an owner's alone, and the capital route to a card another owner has to sign,
# since nobody signs their own.
#
# Nine have been added since, in three batches:
#
#   * Three host identity-verification routes (`/host-verification/pending`,
#     `/{uid}`, `/{uid}/review`). These landed before the count was last
#     touched, so this assertion was already failing by three — worth saying
#     plainly, because a canary that has been red for a while stops being read.
#   * One from appeals: deciding one (`POST /users/appeals/{id}/decide`).
#     Overturning an appeal unbans an account and dismisses the report behind
#     it, so it belongs on this guard for the same reason the four below do —
#     and emphatically no agency may decide the appeal it raised itself.
#   * Four from the partner re-approval work: deciding a host application
#     (`POST /users/host-applications/{id}/decide`), applying or refusing a
#     proposed change to a host's bank or identity details
#     (`.../pending-changes/decide`), the same for an agency or seller
#     (`POST /partner-ops/partners/{id}/pending-changes/decide`), and raising a
#     host bean withdrawal (`POST /partner-ops/hosts/{uid}/withdrawals`).
#   * One from the moderation rebuild: `POST /users/{uid}/resume`. Lifting a
#     SUSPENSION is now its own operation rather than a call to unban — it is
#     audited as `user.resumed`, it refuses a banned account by name, and it
#     touches no device, which unbanning very much does. That difference is
#     why it needs a route of its own rather than a flag on an existing one,
#     and a route of its own is what moved this number. It is an internal
#     moderation write like every other one on this guard: no partner may
#     resume anybody, least of all their own host.
#
# Every one of the four decides something about a partner's money or identity,
# which is precisely why none of them may be reachable BY a partner — an agency
# must not approve its own host's bank change. `require_write` is what says so,
# and the per-route check below is what proves it.
#
# What this count asserts is the property that matters *here*, which is the one
# `require_write` is for: none of them is reachable by a partner. That is
# checked one by one below.
writes = {(row[0], row[1]) for row in table if "require_write" in row[3].split(",")}
# Forty-eight: `POST /users/{uid}/grant-host` is gone (a host comes through an
# application now), and three partner-role lifecycle writes arrived —
# `partners/{id}/revoke`, `recharges/{id}/reject`, `recharges/{id}/refund`.
# Each decides something about a partner's role or money, which is exactly why
# none of them may be reachable by a partner.
# 49 since UGP-B added POST /users/{uid}/restore-host.
# 53 since the governance phase added four Owner-decided writes: recommending
# and deciding a reinstatement of a revoked role (C2,
# `/partner-ops/role-appeals/{id}/recommend|decide`) and filing and deciding a
# transfer (C3, `/partner-ops/transfers`, `/partner-ops/transfers/{id}/decide`).
# Each decides something about a partner's role or relationship, which is
# exactly why none of them may be reachable by a partner.
# 54 since Decision 15 (RC): `POST /partner-ops/partners/{id}/activate`, staff
# starting an Owner-approved role whose contacts are now both verified. It
# re-reads the verification and never bypasses it, and it decides something
# about a partner's role — so it is not partner-reachable either.
# 56 since P1-B2/B3: `POST /staff/{uid}/suspend` and `POST /staff/{uid}/reactivate`,
# staff-only access decisions with the same guard as deactivation.
# 59 since P1-D: `POST /tickets/team`, `POST /tickets/{kind}/{id}/update` and
# `POST /tickets/support/{id}/route` — the server-authoritative ticket writes
# that replace direct client Firestore writes. Staff only; never partner-reachable.
# 60 since B2 (spec §5): `POST /users/appeals/{id}/recommend` — a reviewer's
# written recommendation on a ban / suspension appeal, for the Owner to decide.
# It lifts nothing, but it is a moderation write about an account, so it is
# staff-only like `/decide` beside it: no agency may recommend on its own host's
# appeal.
# 62 since §5 Host role suspension: `POST /users/{uid}/suspend-host` and
# `POST /users/{uid}/resume-host`, on revoke-host's gate (`can_approve_kyc`).
# Each pauses or lifts a Host's role, so — like revoke-host beside them — no
# agency may reach either, least of all for its own host.
check("require_write guards sixty-two routes", len(writes), 62)
# The four moderation operations are four distinct routes on this guard. Named
# rather than counted, so that collapsing resume back into unban — which is the
# defect this pins shut — is a diff somebody reads rather than a number that
# quietly moves.
check(
    "and the four moderation operations are four separate routes",
    sorted(w for w in writes if w[1].startswith("/api/users/{uid}/")
           and w[1].rsplit("/", 1)[-1] in {"ban", "unban", "suspend", "resume"}),
    [
        ("POST", "/api/users/{uid}/ban"),
        ("POST", "/api/users/{uid}/resume"),
        ("POST", "/api/users/{uid}/suspend"),
        ("POST", "/api/users/{uid}/unban"),
    ],
)
check(
    "and the live-room interventions are among them",
    sorted(w for w in writes if "/live-rooms/" in w[1]),
    [
        ("POST", "/api/users/live-rooms/{room_id}/end"),
        ("POST", "/api/users/live-rooms/{room_id}/mute"),
    ],
)
# The composed-email routes. `require_write` establishes only that the caller is
# internal and is not the Observer; which audience they may actually reach is
# decided per audience inside the service, and `tests/test_broadcast.py` is what
# holds that. They are listed here so that adding a fourth one is a diff
# somebody reads rather than a number that quietly moves.
check(
    "and the three composed-email routes are too",
    sorted(w for w in writes if w[1].startswith("/api/broadcasts")),
    [
        ("GET", "/api/broadcasts/audience"),
        ("GET", "/api/broadcasts/audiences"),
        ("POST", "/api/broadcasts/email"),
    ],
)
for method, path in sorted(writes):
    ok(
        f"{method} {path} is refused an external session twice over",
        (method, path) not in deps.PARTNER_REACHABLE,
    )

# Exactly five writes are reachable, and everything else on the list is a read.
# Two are the two the spec puts in a partner's hands (they name a seller record
# and scope it); two are Decision 15's self-scoped verification writes (they
# name no record at all — the subject is the session's own uid); one is
# Decision 16's re-application, scoped to the caller's own agency.
partner_writes = sorted(
    (row[0], row[1])
    for row in reachable
    if row[0] != "GET" and not row[1].endswith("/signout")
    # B3: "sign out everywhere" is a write about the session itself, like
    # sign-out, and is held to the sign-out shape above (plain session,
    # `own_session_uid`, no id anywhere). It is not a business write.
    and not row[1].endswith("/sessions/revoke-all")
)
check(
    "the only five writes a partner may make",
    partner_writes,
    [
        ("POST", "/api/partner-ops/agencies/{agency_id}/sub-agencies/reapply"),
        ("POST", "/api/partner-ops/me/verification/check"),
        ("POST", "/api/partner-ops/me/verification/conflict"),
        ("POST", "/api/partner-ops/sales"),
        ("POST", "/api/partner-ops/sellers/{seller_id}/coin-purchases"),
    ],
)

# Execution stays owner-only, and so does verification, signature and approval.
# Stated as a property of the path rather than a list, so a new `/execute` is
# covered the day it is written.
for row in reachable:
    tail = row[1].rsplit("/", 1)[-1]
    ok(
        f"{row[0]} {row[1]} neither executes nor signs anything",
        tail not in {"execute", "approve", "sign", "verify", "reject", "sign-bulk"},
    )


# ══════════════════════════════════════════════════════════════════════════════
#  7. The four routes that were opened, driven for real
# ══════════════════════════════════════════════════════════════════════════════
#
# Section 6 proves a route is *reachable*. That is half the question and the
# less interesting half: every one of these takes an id out of a URL, a body or
# a session, and reaching a route is not permission to name somebody else's id.
# So each is called — the real route function, the real service under it, a real
# partner session on top — and asked four things:
#
#   * a partner naming their own id gets the answer;
#   * a partner naming another partner's id gets a 403 and nothing is written;
#   * a dual-role login lands on the right one of its two records;
#   * an internal caller behaves exactly as it did before any of this.
#
# The fake Mongo underneath is the one `tests/harness.py` provides, wired into
# each service module by name. Nothing under `app/` is stubbed.
#
# One thing these calls do NOT exercise, and say so rather than pretend: calling
# a route function directly bypasses its `Depends`, because FastAPI is what
# evaluates a default. So the guard is asserted on its own, against the same
# sessions, in 7.0 — and section 6 has already put every route in the API in
# front of the real allowlist refusal.

from app.core import audit as audit_mod  # noqa: E402
from app.routers import cards as cards_router  # noqa: E402
from app.routers import partner_ops as ops_router  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops_svc  # noqa: E402
from app.services import partners as partners_svc  # noqa: E402

WORLD = build_world()
install_firestore(CRM_USERS)
for _svc in (audit_mod, cards_svc, ops_svc, partners_svc):
    _svc.get_db = lambda _db=WORLD: _db  # type: ignore[assignment]


def internal(uid: str, role: Role, team=None) -> dict:
    """An internal session, as `verify_session` returns one: no partner scope."""
    return {"uid": uid, "name": uid, "role": role, "team": team, "partner_ids": {}}


# Fresh sessions against the world the routes will actually read.
SELLER_S = session_for("uid-seller")       # seller-live, seller only
AGENCY_S = session_for("uid-agency-only")  # agency-live, agency only
SUB_S = session_for("uid-sub")             # agency-sub, whose parent is agency-live
DUAL_S = session_for("uid-dual")           # dual-agency + dual-seller
PENDING_S = asyncio.run(sec.verify_session(sign_in("uid-pending")[0]))

#: Finance admin — a writer, and the team every money card below belongs to, so
#: the board assertions are about scope rather than about an empty result.
STAFF_S = internal("uid-staff", Role.FINANCE_ADMIN)
OWNER_S = internal("uid-owner", Role.OWNER)
MEMBER_S = internal("uid-member", Role.FINANCE_MEMBER)
OBSERVER_S = internal("uid-obs", Role.OBSERVER)


def run(coro):
    return asyncio.run(coro)


def docs_in(collection: str) -> list[dict]:
    return WORLD[collection].docs


def coin_purchase(**over):
    body = {
        "coins": 1000,
        "amount_paid_minor": 250_000,
        "payment_ref": "UTR-0001",
        "evidence_url": "",
        "reason": "Paid for 1,000 coins of inventory.",
    }
    body.update(over)
    return ops_router.CoinPurchase(**body)


def sale(**over):
    body = {
        "seller_id": "seller-live",
        "buyer_uid": "buyer-1",
        "diamonds": 500,
        "amount_paid_minor": 49_900,
        "reason": "Diamonds sold to a customer, paid by UPI.",
    }
    body.update(over)
    return ops_router.Sale(**body)


# ── 7.0  The guard on the two writes ─────────────────────────────────────────
#
# `require_write_or_partner` is `require_write` for an internal role and a
# pass-through for an external one. The pass-through is the whole point and is
# also the danger, so it is stated here in one place: this dependency admits a
# partner **unscoped**, and everything below depends on the route scoping them.

check(
    "an internal writer satisfies the partner write guard exactly as before",
    run(deps.require_write_or_partner(STAFF_S))["role"],
    Role.FINANCE_ADMIN,
)
for internal_role in (Role.OWNER, Role.OPS_ADMIN, Role.TECH_MEMBER):
    check(
        f"{internal_role} still writes",
        run(deps.require_write_or_partner(internal("uid-x", internal_role)))["role"],
        internal_role,
    )
forbids(
    "the observer is refused by the partner write guard, as by require_write",
    lambda: run(deps.require_write_or_partner(OBSERVER_S)),
)
check(
    "a partner passes the guard — and is scoped by the route, not by it",
    run(deps.require_write_or_partner(SELLER_S))["uid"],
    "uid-seller",
)


# ── 7.1  POST /partner-ops/sellers/{id}/coin-purchases — spec 4.3.5 ──────────

own_card = run(
    ops_router.request_coin_purchase("seller-live", coin_purchase(), SELLER_S)
)
check("a seller buys their own inventory", own_card["subject"]["id"], "seller-live")
check("…and the card is theirs", own_card["requested_by"]["uid"], "uid-seller")
check("…raised, not signed", own_card["stage"], "requested")
check(
    "…carrying the reason it was raised with",
    own_card["reason"],
    "Paid for 1,000 coins of inventory.",
)
ok(
    "…and audited against the seller who raised it",
    any(
        entry["subject"]["id"] == own_card["id"]
        and entry["actor"]["uid"] == "uid-seller"
        and entry["reason"]
        for entry in docs_in(C.AUDIT)
    ),
)

before = len(docs_in(C.CARDS))
detail = forbids(
    "a seller cannot buy inventory in another seller's name",
    lambda: run(
        ops_router.request_coin_purchase(
            "dual-seller", coin_purchase(payment_ref="UTR-THEFT"), SELLER_S
        )
    ),
)
check("and is told why", detail, "You can only view your own records.")
check("…with nothing written", len(docs_in(C.CARDS)), before)

me_card = run(
    ops_router.request_coin_purchase("me", coin_purchase(payment_ref="UTR-ME"), SELLER_S)
)
check("'me' resolves to their own seller record", me_card["subject"]["id"], "seller-live")

forbids(
    "an agency cannot buy coin inventory at all",
    lambda: run(
        ops_router.request_coin_purchase(
            "seller-live", coin_purchase(payment_ref="UTR-A"), AGENCY_S
        )
    ),
)
forbids(
    "a pending applicant cannot raise a purchase",
    lambda: run(
        ops_router.request_coin_purchase(
            "seller-live", coin_purchase(payment_ref="UTR-P"), PENDING_S
        )
    ),
)

# The dual-role login: the seller half buys, and the agency id is not a seller
# id even though it is theirs.
dual_card = run(
    ops_router.request_coin_purchase(
        "dual-seller", coin_purchase(payment_ref="UTR-DUAL"), DUAL_S
    )
)
check(
    "a dual-role login buys against its seller record",
    dual_card["subject"]["id"],
    "dual-seller",
)
forbids(
    "…and cannot buy coin inventory against its own agency record",
    lambda: run(
        ops_router.request_coin_purchase(
            "dual-agency", coin_purchase(payment_ref="UTR-DUAL-2"), DUAL_S
        )
    ),
)

# Staff raising a card about any seller is the normal case and is untouched.
staff_card = run(
    ops_router.request_coin_purchase(
        "seller-live", coin_purchase(payment_ref="UTR-STAFF"), STAFF_S
    )
)
check(
    "staff still raise a purchase about any seller",
    staff_card["subject"]["id"],
    "seller-live",
)
check("…as themselves", staff_card["requested_by"]["uid"], "uid-staff")


# ── 7.2  The duplicate-reference oracle ──────────────────────────────────────
#
# `find_duplicate_payment_refs` searches EVERY card in the business for a UTR
# and the result is written onto the card so the owner sees the collision before
# signing. Handed back to the seller who typed the reference, it answers "whose
# card already carries this?" — a partner id, an amount and a stage — for any
# string they care to guess. It is narrowed to the caller's own records.

run(
    ops_router.request_coin_purchase(
        "dual-seller", coin_purchase(payment_ref="UTR-SHARED"), DUAL_S
    )
)
probe = run(
    ops_router.request_coin_purchase(
        "seller-live", coin_purchase(payment_ref="UTR-SHARED"), SELLER_S
    )
)
check(
    "probing another seller's payment reference tells the prober nothing",
    probe["payload"]["duplicate_of"],
    [],
)
check("…not even that it collided", probe["payload"]["duplicate_reference"], False)
ok("…and no warning names a count", "warning" not in probe)

# The control itself is intact: the owner who signs still sees the collision.
staff_view = run(
    ops_router.request_coin_purchase(
        "seller-live", coin_purchase(payment_ref="UTR-SHARED"), STAFF_S
    )
)
ok(
    "staff still see every card carrying the reference",
    any(d["subject_id"] == "dual-seller" for d in staff_view["payload"]["duplicate_of"]),
)
ok("…and are warned about it", "warning" in staff_view)

# A seller re-using their OWN reference still gets the useful half.
mine_again = run(
    ops_router.request_coin_purchase(
        "seller-live", coin_purchase(payment_ref="UTR-0001"), SELLER_S
    )
)
check(
    "a seller re-using their own reference is shown their own earlier card",
    [d["subject_id"] for d in mine_again["payload"]["duplicate_of"]],
    ["seller-live"],
)
check("…and the flag says so", mine_again["payload"]["duplicate_reference"], True)
ok(
    "…and the warning counts only their own",
    "1 earlier card(s) of yours" in mine_again["warning"],
)


# ── 7.3  GET /cards — spec 5.2 / 4.3.6 ───────────────────────────────────────

board = run(cards_router.list_cards(user=SELLER_S))
ok("a seller sees cards on the board", len(board) > 0)
ok(
    "…and every one of them is theirs — raised by them, or about them",
    all(
        c["subject"]["id"] == "seller-live"
        or (c["requested_by"] or {}).get("uid") == "uid-seller"
        for c in board
    ),
)
ok(
    "…so no other seller's card is on it",
    not any(c["subject"]["id"] == "dual-seller" for c in board),
)
# A card staff raised ABOUT this seller is now theirs to read — it is their own
# money — and the staff member who raised it is not named on it.
staff_about_them = [
    c for c in board if c["subject"]["id"] == "seller-live" and c["id"] == staff_card["id"]
]
check("a card staff raised about them is on their board", len(staff_about_them), 1)
check(
    "…with the staff member who raised it replaced by 'Zipper'",
    staff_about_them[0]["requested_by"],
    dict(cards_svc.ZIPPER),
)
ok(
    "…and no staff uid anywhere on it",
    not any(
        (staff_about_them[0].get(f) or {}).get("uid")
        for f in ("requested_by", "verified_by", "signed_by", "rejected_by")
    ),
)
check(
    "…while their own card still names them",
    [c["requested_by"]["uid"] for c in board if c["id"] == own_card["id"]],
    ["uid-seller"],
)
ok(
    "the duplicate evidence is narrowed on the board too, not only on the POST",
    all(
        all(d["subject_id"] == "seller-live" for d in c["payload"].get("duplicate_of", []))
        for c in board
    ),
)

dual_board = run(cards_router.list_cards(user=DUAL_S))
ok(
    "a dual-role login sees its own cards and nobody else's",
    bool(dual_board) and all(c["requested_by"]["uid"] == "uid-dual" for c in dual_board),
)
check("an agency that has raised nothing sees nothing", run(cards_router.list_cards(user=AGENCY_S)), [])

# The three internal branches of `board_for`, none of which moved. The member is
# the one worth checking: it reads `$or` on the caller's team, and collapsing it
# to `requested_by.uid` — which is what the external branch does — would have
# blinded every staff member to their own team's board.
every_card = len(docs_in(C.CARDS))
check(
    "an owner still sees every card in the business",
    len(run(cards_router.list_cards(user=OWNER_S))),
    every_card,
)
check(
    "a team admin still sees their team's board, whoever raised it",
    len(run(cards_router.list_cards(user=STAFF_S))),
    every_card,
)
member_board = run(cards_router.list_cards(user=MEMBER_S))
check(
    "a team member still sees their team's board though they raised none of it",
    len(member_board),
    every_card,
)
ok(
    "…with the duplicate evidence intact for the people who verify and sign",
    any(
        d["subject_id"] == "dual-seller"
        for c in member_board
        for d in c["payload"].get("duplicate_of", [])
    ),
)


# ── 7.4  POST /partner-ops/sales — spec 4.3.8 ────────────────────────────────

# M-11: a sale is filed only against a buyer whose `users/{uid}` document
# exists. The buyer here does; Firestore itself is not what 7.4 is about.
firebase_mod.read_host_wallet = lambda uid: {  # type: ignore[assignment]
    "beans": 0, "beans_available": 0, "agency_id": "", "is_verified_host": False, "name": "Buyer",
}
own_sale = run(ops_router.record_sale(sale(), SELLER_S))
check("a seller files their own sale", own_sale["seller_id"], "seller-live")
check("…at pending, moving nothing", str(own_sale["status"]), "pending")
check("…recorded as themselves", own_sale["recorded_by"]["uid"], "uid-seller")

sales_before = len(docs_in(ops_svc.SALES))
forbids(
    "a seller cannot file a sale against another seller's inventory",
    lambda: run(ops_router.record_sale(sale(seller_id="dual-seller"), SELLER_S)),
)
check("…and nothing is written when they try", len(docs_in(ops_svc.SALES)), sales_before)

dual_sale = run(ops_router.record_sale(sale(seller_id="dual-seller"), DUAL_S))
check(
    "a dual-role login files against its seller record",
    dual_sale["seller_id"],
    "dual-seller",
)
forbids(
    "…and not against its own agency record",
    lambda: run(ops_router.record_sale(sale(seller_id="dual-agency"), DUAL_S)),
)
forbids(
    "an agency-only login files no sales",
    lambda: run(ops_router.record_sale(sale(), AGENCY_S)),
)

staff_sale = run(ops_router.record_sale(sale(), STAFF_S))
check("staff still file a sale about any seller", staff_sale["seller_id"], "seller-live")

# What the portal reads back is pinned to the caller's own seller id whatever
# the query string says — unchanged, and asserted here beside the write.
mine = run(ops_router.list_sales(seller_id="dual-seller", user=SELLER_S))
ok(
    "a seller's sales list is their own however they filter it",
    bool(mine) and all(s["seller_id"] == "seller-live" for s in mine),
)


# ── 7.5  GET /partner-ops/subagency-payouts/open — spec 4.2.6 / 4.2.9 ────────

WORLD.seed(
    ops_svc.SUBAGENCY_PAYOUTS,
    [
        {
            "_id": "payout-mine",
            "card_id": "card-1",
            "parent_id": "agency-live",
            "parent_name": "agency-live Ltd",
            "sub_id": "agency-sub",
            "sub_name": "agency-sub Ltd",
            "amount_minor": 500_000,
            "status": ops_svc.PayoutStatus.PARENT_PAID,
            "created_at": NOW,
        },
        {
            "_id": "payout-theirs",
            "card_id": "card-2",
            "parent_id": "agency-other",
            "parent_name": "agency-other Ltd",
            "sub_id": "dual-agency",
            "sub_name": "dual-agency Ltd",
            "amount_minor": 900_000,
            "status": ops_svc.PayoutStatus.PENDING,
            "created_at": NOW,
        },
        {
            "_id": "payout-closed",
            "card_id": "card-3",
            "parent_id": "agency-live",
            "parent_name": "agency-live Ltd",
            "sub_id": "agency-sub",
            "sub_name": "agency-sub Ltd",
            "amount_minor": 100_000,
            "status": ops_svc.PayoutStatus.CLOSED,
            "created_at": NOW,
        },
    ],
)


def payout_ids(session) -> list[str]:
    return sorted(p["id"] for p in run(ops_router.open_subagency_payouts(user=session)))


check(
    "a parent agency sees the payout it owes a second leg on",
    payout_ids(AGENCY_S),
    ["payout-mine"],
)
check(
    "a sub-agency sees the payout that reaches it through its parent",
    payout_ids(SUB_S),
    ["payout-mine"],
)
check(
    "an agency that is somebody else's sub sees only its own",
    payout_ids(DUAL_S),
    ["payout-theirs"],
)
check(
    "staff still see every open payout in the business",
    payout_ids(STAFF_S),
    ["payout-mine", "payout-theirs"],
)
ok(
    "…and a closed payout is on nobody's list",
    "payout-closed" not in payout_ids(STAFF_S) + payout_ids(AGENCY_S),
)
forbids(
    "a seller holds no agency record and is told so rather than shown an empty list",
    lambda: run(ops_router.open_subagency_payouts(user=SELLER_S)),
)
forbids(
    "a pending applicant likewise",
    lambda: run(ops_router.open_subagency_payouts(user=PENDING_S)),
)


# ── 7.6  What stayed shut, and why ───────────────────────────────────────────
#
# The credit flows are raised by *staff about a seller*, never by the seller
# about themselves: 4.3.7 is "**you** lend inventory", 4.3.13 is "**you** can
# recover", 4.3.17 is an explicit owner decision recorded as a loss. Execution
# and approval are owner-only throughout. Each is put in front of the real
# allowlist refusal with a real seller session, and named with the clause that
# keeps it shut — so opening one later is a deliberate edit to this list.

STAYS_SHUT = (
    ("POST", "/api/partner-ops/sellers/{seller_id}/lending", "4.3.7 — we lend, not them"),
    ("POST", "/api/partner-ops/sellers/{seller_id}/repayments", "4.3.10 — we close the debt"),
    ("POST", "/api/partner-ops/sellers/{seller_id}/recoveries", "4.3.13 — we recover"),
    ("POST", "/api/partner-ops/partners/{partner_id}/write-off", "4.3.17 — an owner's loss"),
    ("POST", "/api/partner-ops/coin-purchases/{card_id}/execute", "4.3.6 — an owner credits"),
    ("POST", "/api/partner-ops/sales/{sale_id}/approve", "4.3.9 — an owner debits"),
    ("POST", "/api/partner-ops/lending/{card_id}/execute", "5.1 — owners sign"),
    ("POST", "/api/partner-ops/repayments/{card_id}/execute", "4.3.10 — an owner closes it"),
    ("POST", "/api/partner-ops/recoveries/{card_id}/execute", "4.3.15 — owner signature"),
    ("POST", "/api/partner-ops/write-offs/{card_id}/execute", "4.3.17 — an owner's loss"),
    ("POST", "/api/partner-ops/subagency-payouts/{payout_id}/confirm-leg", "4.2.6 — staff record leg 2"),
    ("GET", "/api/partner-ops/payment-references/{payment_ref}", "every seller's cards, by UTR"),
    ("GET", "/api/cards/inbox", "7.3 — a verifier's and a signer's queue"),
    ("POST", "/api/cards/{card_id}/verify", "5.5.1 — verification is team work"),
    ("POST", "/api/cards/{card_id}/sign", "1.2.1 — only owners sign money"),
)
for _method, _path, _why in STAYS_SHUT:
    ok(
        f"a seller is refused {_method} {_path} ({_why})",
        (_method, _path) not in deps.PARTNER_REACHABLE,
    )
    forbids(
        f"…and the allowlist is what refuses {_method} {_path}",
        lambda m=_method, p=_path: deps._refuse_unreachable_route(Request(m, p), SELLER_S),
    )
ok(
    "every route named as staying shut is a real route",
    {(m, p) for m, p, _ in STAYS_SHUT} <= declared,
)


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\n  ✓ all {checks} partner-session checks passed\n")
print("  Every route in the API, against a real agency/seller session:\n")
print(f"    {'':6} {'route':<58} {'verdict':<17} guard")
for method, path, verdict, guards in table:
    print(f"    {method:<6} {path:<58} {verdict:<17} {guards}")

print()
print("  · an approved agency and an approved seller sign in; a sub-agency")
print("    signs in as an agency, and the role is one of exactly two")
print("  · a pending applicant gets a session holding no partner id, so every")
print("    scoped route refuses it on the same comparison that refuses a")
print("    stranger's id — rejected and deactivated get no session at all")
print("  · staff wins: a person with both records gets an internal session")
print("    and no partner scope, and a partner claim on a staff token is dropped")
print("  · a dual-role login reaches both of its records and neither of")
print("    anybody else's, and cannot cross a seller id into an agency route")
print("  · every route is enumerated from the router source and put in front")
print(f"    of the real dependency — {len(reachable)} are scoped, the rest are refused")
print("  · the two the spec puts in a partner's hands are writes, and each is")
print("    read out of the source to confirm it calls own_partner_id_or_403;")
print("    execution, signature and verification are on nobody's list")
print("  · and each of the four is then driven for real: own id answered,")
print("    another partner's id 403 with nothing written, a dual-role login on")
print("    the right record, an internal caller unchanged — including that a")
print("    seller probing somebody else's payment reference learns nothing")
sys.exit(0)
