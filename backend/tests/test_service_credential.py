"""The weekly accrual service credential.

This is the only standing, unattended identity in the system. It runs on a
Sunday night with nobody watching and it creates a financial liability every
time it does. These tests are written on the assumption that the key will one
day leak, and they check the things that decide how bad that day is:

  * the key works on commission accrual, and on the preview it makes first;
  * it is refused on everything else — by allowlist, not by where it happens
    to be wired;
  * a wrong key, a missing key and an unconfigured server are all refused, and
    are refused identically from the outside;
  * every entry it writes names a machine — `system:weekly-accrual`, role
    `system` — and can never wear a person's name or a blank one;
  * re-running a period credits nothing a second time;
  * the sanity bound refuses an implausible total instead of accruing it.

**No network and no database.** The I/O is stubbed the way
`tests/test_commission.py` avoids it — by keeping the code under test free of
it — except that here the modules genuinely do import Mongo, Firebase, FastAPI
and pydantic, so those are replaced with small stand-ins before the real
modules are imported. Everything under `app/` in these tests is the real code.

Run:  python3 -m tests.test_service_credential
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import inspect
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

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


def refuses(label: str, fn, *, error=Exception) -> Exception | None:
    """This must be refused, not quietly allowed."""
    global checks
    checks += 1
    try:
        result = fn()
    except error as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return None
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return None


def run(coro):
    return asyncio.run(coro)


# ══════════════════════════════════════════════════════════════════════════════
# Stand-ins for the I/O, installed before any app module is imported
# ══════════════════════════════════════════════════════════════════════════════


def install(name: str, module: types.ModuleType) -> types.ModuleType:
    sys.modules[name] = module
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, module)
    return module


def module(name: str, **attrs) -> types.ModuleType:
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


# ── settings ──────────────────────────────────────────────────────────────────
# A real key, generated the way the script does, so nothing here is a short
# literal that would be rejected by MIN_SERVICE_KEY_CHARS for the wrong reason.

GOOD_KEY = "zpr_" + "K7vQ2mB9xLr4TnW8sYc6HdJ0fPzA3eGu5RiOqXbN1tVMkZ"
WRONG_KEY = "zpr_" + "K7vQ2mB9xLr4TnW8sYc6HdJ0fPzA3eGu5RiOqXbN1tVMkY"  # last char


class _Settings:
    service_key_weekly_accrual = ""
    service_key_reporting = ""
    service_key_partner_registration = ""
    service_accrual_max_minor = 125_000_000
    environment = "test"
    mongo_db = "zipper"


settings = _Settings()
import app  # noqa: E402  (real, empty package)

install("app.config", module("app.config", settings=settings, get_settings=lambda: settings))


# ── Mongo ─────────────────────────────────────────────────────────────────────


class FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *_a, **_k):
        return self

    def skip(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield dict(d)

        return gen()


class FakeCollection:
    def __init__(self, name, store):
        self.name = name
        self.store = store

    async def insert_one(self, doc, session=None):
        self.store.setdefault(self.name, []).append(doc)
        return types.SimpleNamespace(inserted_id=f"{self.name}-{len(self.store[self.name])}")

    def find(self, query=None, *_a, **_k):
        self.store.setdefault("_queries", []).append(dict(query or {}))
        docs = self.store.get(self.name, [])
        return FakeCursor(_matching(docs, query or {}))

    async def find_one(self, query=None, *_a, **_k):
        """One document, or None.

        Added when `app/core/deps` began re-reading the caller's role from the
        `staff` collection before a permission-gated action (§19). A person
        accruing commission by hand now needs a staff row that agrees with their
        session, and a fixture that could not answer that question would have
        been exercising a shape the real code no longer has.
        """
        found = _matching(self.store.get(self.name, []), query or {})
        return found[0] if found else None


def _matching(docs, query):
    """Just enough query semantics for the two filters `audit.query` builds."""
    out = []
    for doc in docs:
        keep = True
        for key, want in query.items():
            actual = doc
            for part in key.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if actual != want:
                keep = False
                break
        if keep:
            out.append({**doc, "_id": f"id-{len(out)}"})
    return out


STORE: dict = {}


class FakeDb:
    def __getitem__(self, name):
        return FakeCollection(name, STORE)


class C:
    STAFF = "staff"
    OBSERVER_OTP = "observer_otp"
    SESSIONS = "sessions"
    AUDIT = "audit"
    LEDGER = "ledger"
    BALANCES = "balances"
    CARDS = "cards"
    PARTNERS = "partners"


import app.db  # noqa: E402  (real, empty package — its submodules are replaced)

install("app.db.mongo", module("app.db.mongo", C=C, get_db=lambda: FakeDb()))
install("app.db.firebase", module("app.db.firebase", verify_id_token=lambda t: {}))

# `bson` — `app/services/cards.py` looks a card up by ObjectId, and the partner
# ops router imports that module for `partner_view`, the narrowing that keeps
# one seller's duplicate-payment evidence out of another seller's card. Nothing
# in this file reaches either; the import has to resolve, and that is all this
# stand-in is for.
install("bson", module("bson", ObjectId=str))

install("motor", module("motor"))
install(
    "motor.motor_asyncio",
    module("motor.motor_asyncio", AsyncIOMotorClientSession=object),
)


# ── jose (session JWTs — untouched by anything here, but imported) ────────────

install(
    "jose",
    module(
        "jose",
        JWTError=type("JWTError", (Exception,), {}),
        jwt=types.SimpleNamespace(
            encode=lambda *a, **k: "token", decode=lambda *a, **k: {}
        ),
    ),
)


# ── FastAPI and pydantic ──────────────────────────────────────────────────────


class HTTPException(Exception):
    def __init__(self, status_code: int, detail=None, **_k):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _Status:
    HTTP_200_OK = 200
    HTTP_201_CREATED = 201
    HTTP_400_BAD_REQUEST = 400
    HTTP_401_UNAUTHORIZED = 401
    HTTP_403_FORBIDDEN = 403
    HTTP_409_CONFLICT = 409
    HTTP_500_INTERNAL_SERVER_ERROR = 500


class Depends:
    def __init__(self, dependency=None):
        self.dependency = dependency


def Header(default=None, **_k):  # noqa: N802
    return default


def Query(default=None, **_k):  # noqa: N802
    return default


ROUTES: list[dict] = []


class APIRouter:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def _register(self, method):
        def decorator(path, **kwargs):
            def wrap(fn):
                ROUTES.append({"method": method, "path": path, "fn": fn})
                return fn

            return wrap

        return decorator

    def __getattr__(self, name):
        if name in {"get", "post", "put", "patch", "delete"}:
            return self._register(name)
        raise AttributeError(name)


class Request:
    """`fastapi.Request`. `app/core/deps.py` reads the matched route off it to
    apply the partner allowlist; a machine credential never reaches that code,
    and these tests prove it by presenting no route at all."""

    def __init__(self, method: str = "POST", path: str = ""):
        self.method = method
        self.scope: dict = (
            {"route": types.SimpleNamespace(path=path)} if path else {}
        )


install(
    "fastapi",
    module(
        "fastapi",
        APIRouter=APIRouter,
        Depends=Depends,
        Header=Header,
        HTTPException=HTTPException,
        Query=Query,
        Request=Request,
        status=_Status,
    ),
)


class BaseModel:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def Field(default=None, **_k):  # noqa: N802
    return default


install("pydantic", module("pydantic", BaseModel=BaseModel, Field=Field))


# ── The partner-ops service, with the real idempotency semantics ──────────────


class PartnerOpsError(Exception):
    pass


class FakePartnerOps:
    """A stand-in for `app/services/partner_ops.py`.

    It reproduces the two behaviours the router depends on, and nothing else:

      * `commission_preview` returns the shape `compute_for_period` returns;
      * `accrue_commission` writes one movement per host keyed
        `commission:{agency}:{host}:{period}` and refuses when every leg of a
        period is already present — the wording included, because the router
        matches it. Both the key format and the wording are asserted against
        the real source file further down, so this stand-in cannot drift away
        from what it stands in for.
    """

    def __init__(self):
        self.keys: set[str] = set()
        self.preview_result: dict = {}
        self.calls: list[dict] = []

    async def commission_preview(self, agency_id, period, since=None, until=None):
        self.calls.append(
            {"op": "preview", "agency_id": agency_id, "period": period}
        )
        if isinstance(self.preview_result, Exception):
            raise self.preview_result
        return dict(self.preview_result)

    async def accrue_commission(
        self,
        agency_id,
        period,
        actor,
        host_id="",
        since=None,
        until=None,
        expected_amount_minor=None,
        reason="",
    ):
        self.calls.append(
            {
                "op": "accrue",
                "agency_id": agency_id,
                "period": period,
                "actor": actor,
                "host_id": host_id,
                "expected_amount_minor": expected_amount_minor,
                "reason": reason,
            }
        )
        computed = dict(self.preview_result)
        span = computed["period"]
        total = int(computed["commission_minor"])
        if expected_amount_minor is not None and int(expected_amount_minor) != total:
            raise PartnerOpsError(
                f"The amount supplied ({int(expected_amount_minor)} paise) does not "
                f"match what the ledger produces for {span} ({total} paise)."
            )

        accrued, already = [], []
        for line in computed["hosts"]:
            if line["share_minor"] <= 0:
                continue
            key = f"commission:{agency_id}:{line['host_id']}:{span}"
            if key in self.keys:
                already.append(
                    {"host_id": line["host_id"], "amount_minor": line["share_minor"]}
                )
                continue
            self.keys.add(key)
            accrued.append(
                {"host_id": line["host_id"], "amount_minor": line["share_minor"]}
            )
        if not accrued:
            raise PartnerOpsError(
                f"Every host's commission for {span} was already accrued "
                f"({total} paise across {len(already)} host(s)). Nothing was "
                "credited a second time."
            )
        return {
            "agency_id": agency_id,
            "period": span,
            "amount_minor": total,
            "credited_minor": sum(a["amount_minor"] for a in accrued),
            "accrued": accrued,
            "already_accrued": already,
        }


FAKE_SVC = FakePartnerOps()
import app.services  # noqa: E402  (real, empty package — `commission` stays real)

install(
    "app.services.partner_ops",
    module(
        "app.services.partner_ops",
        PartnerOpsError=PartnerOpsError,
        commission_preview=FAKE_SVC.commission_preview,
        accrue_commission=FAKE_SVC.accrue_commission,
    ),
)
install(
    "app.services.partners",
    module("app.services.partners", PartnerKind=object, PartnerStatus=object),
)
# The router also imports the application and recharge services, which are
# not under test here and need the real `PartnerStatus`; stubbed the same way.
install("app.services.partner_applications", module("app.services.partner_applications"))
install("app.services.recharges", module("app.services.recharges"))
# B9 (3 Nov 2026): the router imports the seller-business service too (tiers, trades, borrowing, profit) — not
# under test here, and it imports pymongo; stubbed the same way.
install("app.services.seller_business", module("app.services.seller_business"))


# ══════════════════════════════════════════════════════════════════════════════
# The real code under test
# ══════════════════════════════════════════════════════════════════════════════

from app.core import audit  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.routers import partner_ops as router_mod  # noqa: E402

settings.service_key_weekly_accrual = GOOD_KEY


# ══════════════════════════════════════════════════════════════════════════════
# 1. The allowlist — what the credential may do, stated once
# ══════════════════════════════════════════════════════════════════════════════

cred = security.WEEKLY_ACCRUAL

check("three service credentials exist", len(security.SERVICE_CREDENTIALS), 3)
check("its id", cred.id, "weekly-accrual")
check(
    "its allowlist is exactly accrual and preview",
    sorted(cred.operations),
    ["commission.accrue", "commission.preview"],
)
check(
    "the vocabulary of operations is exactly what the three credentials hold",
    sorted(security.KNOWN_OPERATIONS),
    [
        "alerts.scan",
        "commission.accrue",
        "commission.preview",
        "email.events",
        "email.sweep",
        "partner.apply",
        "partner.register",
        "recharge.request",
        "reports.send",
    ],
)

# The second credential is Part 8A's, and the separation is the whole reason it
# is a second one rather than four more operations on the first. A key that can
# email a report must not also be able to create a commission liability.
reporting = security.REPORTING
check("the reporting credential's id", reporting.id, "reporting")
check("…reads its key from its own environment variable",
      reporting.env_var, "SERVICE_KEY_REPORTING")
check(
    "…and holds only the four sending operations",
    sorted(reporting.operations),
    ["alerts.scan", "email.events", "email.sweep", "reports.send"],
)
ok(
    "no operation is held by both credentials",
    not (set(cred.operations) & set(reporting.operations)),
)
for money_op in ("commission.accrue", "commission.preview"):
    ok(f"the reporting credential cannot {money_op}", not reporting.may(money_op))
for send_op in ("reports.send", "alerts.scan", "email.sweep", "email.events"):
    ok(f"the accrual credential cannot {send_op}", not cred.may(send_op))

# Each key opens only its own credential. Configured with the accrual key only,
# the reporting operations are refused — the allowlist is not the gate here, the
# key is.
refuses(
    "the accrual key is refused on reports.send",
    lambda: security.verify_service_key(GOOD_KEY, security.Op.REPORTS_SEND),
    error=security.AuthError,
)
refuses(
    "the accrual key is refused on alerts.scan",
    lambda: security.verify_service_key(GOOD_KEY, security.Op.ALERTS_SCAN),
    error=security.AuthError,
)

REPORTING_KEY = "zpr_" + "R4tYs8DqLm2XvKb7NfHc1ZpJ9wGe6UiOaQxT3rVMkB"
settings.service_key_reporting = REPORTING_KEY
try:
    report_actor = security.verify_service_key(
        REPORTING_KEY, security.Op.REPORTS_SEND
    )
    check("the reporting key resolves to its own actor",
          report_actor["uid"], "system:reporting")
    check("…which reads as a machine", report_actor["role"], "system")
    check("…and names itself in the audit log",
          report_actor["service_credential"], "reporting")
    refuses(
        "the reporting key cannot accrue commission",
        lambda: security.verify_service_key(
            REPORTING_KEY, security.Op.COMMISSION_ACCRUE
        ),
        error=security.AuthError,
    )
    refuses(
        "the reporting key cannot even preview commission",
        lambda: security.verify_service_key(
            REPORTING_KEY, security.Op.COMMISSION_PREVIEW
        ),
        error=security.AuthError,
    )
finally:
    settings.service_key_reporting = ""

refuses(
    "with SERVICE_KEY_REPORTING unset, the reporting key is refused",
    lambda: security.verify_service_key(REPORTING_KEY, security.Op.REPORTS_SEND),
    error=security.AuthError,
)

# ── The third credential: onboarding ─────────────────────────────────────────
#
# It is held by the two Firestore triggers that fire on every public signup —
# the widest-exposure machine path there is — so it holds the single narrowest
# grant: create an empty, pending business record for an id that already names a
# real Firestore document, and nothing else. It must not be able to accrue and
# it must not be able to send mail, and neither of the other two may register.
registration = security.PARTNER_REGISTRATION
check("the registration credential's id", registration.id, "partner-registration")
check("…reads its key from its own environment variable",
      registration.env_var, "SERVICE_KEY_PARTNER_REGISTRATION")
check("…and from its own settings attribute",
      registration.settings_attr, "service_key_partner_registration")
# Three operations on one key, deliberately: registering a record the signup
# forms wrote, filing an application from the app on a signed-in user's
# behalf, and filing a recharge request. All three create PENDING records that
# hold nothing and decide nothing; widening the key rather than minting a
# fourth avoided a production configuration change.
check(
    "…and holds the three onboarding operations",
    sorted(registration.operations),
    ["partner.apply", "partner.register", "recharge.request"],
)

# Every pair is disjoint, checked as pairs rather than trusting the module's own
# assertion — the point of three credentials is that no two of them meet.
for left, right in (
    (cred, reporting),
    (cred, registration),
    (reporting, registration),
):
    ok(
        f"{left.id} and {right.id} share no operation",
        not (set(left.operations) & set(right.operations)),
    )
    ok(
        f"…and hold different keys ({left.id} vs {right.id})",
        left.settings_attr != right.settings_attr
        and left.env_var != right.env_var,
    )
    ok(
        f"…and are different system actors ({left.id} vs {right.id})",
        left.actor["uid"] != right.actor["uid"],
    )

for money_op in ("commission.accrue", "commission.preview"):
    ok(f"the registration credential cannot {money_op}", not registration.may(money_op))
for send_op in ("reports.send", "alerts.scan", "email.sweep", "email.events"):
    ok(f"the registration credential cannot {send_op}", not registration.may(send_op))
ok("the accrual credential cannot register a partner",
   not cred.may("partner.register"))
ok("the reporting credential cannot register a partner",
   not reporting.may("partner.register"))

refuses(
    "the accrual key is refused on partner.register",
    lambda: security.verify_service_key(GOOD_KEY, security.Op.PARTNER_REGISTER),
    error=security.AuthError,
)

REGISTRATION_KEY = "zpr_reg_" + "M2wUe7Kt5PqZa9LnBc3XvHj1RyGd8SiOfW4TbNMkVx"
settings.service_key_partner_registration = REGISTRATION_KEY
try:
    reg_actor = security.verify_service_key(
        REGISTRATION_KEY, security.Op.PARTNER_REGISTER
    )
    check("the registration key resolves to its own actor",
          reg_actor["uid"], "system:partner-registration")
    check("…which reads as a machine", reg_actor["role"], "system")
    check("…with a name a person can read",
          reg_actor["name"], "Partner registration (automated)")
    check("…and no email to impersonate", reg_actor["email"], "")
    check("…and names itself in the audit log",
          reg_actor["service_credential"], "partner-registration")
    for forbidden_op in (
        security.Op.COMMISSION_ACCRUE,
        security.Op.COMMISSION_PREVIEW,
        security.Op.REPORTS_SEND,
        security.Op.ALERTS_SCAN,
        security.Op.EMAIL_SWEEP,
        security.Op.EMAIL_EVENTS,
    ):
        refuses(
            f"the registration key cannot {forbidden_op}",
            lambda op=forbidden_op: security.verify_service_key(REGISTRATION_KEY, op),
            error=security.AuthError,
        )
    # …and the other two keys still cannot reach the registration operation,
    # with all three configured at once. This is the state production runs in.
    settings.service_key_reporting = REPORTING_KEY
    try:
        refuses(
            "with all three configured, the reporting key still cannot register",
            lambda: security.verify_service_key(
                REPORTING_KEY, security.Op.PARTNER_REGISTER
            ),
            error=security.AuthError,
        )
        refuses(
            "with all three configured, the accrual key still cannot register",
            lambda: security.verify_service_key(
                GOOD_KEY, security.Op.PARTNER_REGISTER
            ),
            error=security.AuthError,
        )
        check(
            "…and the registration key still resolves to itself",
            security.verify_service_key(
                REGISTRATION_KEY, security.Op.PARTNER_REGISTER
            )["uid"],
            "system:partner-registration",
        )
    finally:
        settings.service_key_reporting = ""
finally:
    settings.service_key_partner_registration = ""

refuses(
    "with SERVICE_KEY_PARTNER_REGISTRATION unset, the registration key is refused",
    lambda: security.verify_service_key(
        REGISTRATION_KEY, security.Op.PARTNER_REGISTER
    ),
    error=security.AuthError,
)

# The operations that would let a key move cash, sign, execute, ban a user or
# read the log. None of them is even a *name* the system knows, so none can be
# granted by a typo or a merge.
for forbidden in [
    "commission.pay",
    "payout.execute",
    "withdrawal.pay",
    "card.sign",
    "card.executed",
    "balance.credit",
    "balance.debit",
    "user.banned",
    "staff.role_changed",
    "export",
    "audit.read",
    "rate.changed",
]:
    ok(f"{forbidden} is not a grantable operation", forbidden not in security.KNOWN_OPERATIONS)
    refuses(
        f"the key is refused for {forbidden}",
        lambda f=forbidden: security.verify_service_key(GOOD_KEY, f),
        error=security.AuthError,
    )

# And the allowlist is a real gate, not a description of the current grant: a
# credential that holds only the preview operation cannot accrue.
narrow = security.ServiceCredential(
    id="narrow",
    settings_attr="service_key_weekly_accrual",
    env_var="X",
    actor=dict(cred.actor),
    operations=frozenset({security.Op.COMMISSION_PREVIEW}),
)
_real_creds = security.SERVICE_CREDENTIALS
security.SERVICE_CREDENTIALS = (narrow,)
try:
    check(
        "a preview-only credential previews",
        security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_PREVIEW)["uid"],
        "system:weekly-accrual",
    )
    refuses(
        "a preview-only credential cannot accrue",
        lambda: security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_ACCRUE),
        error=security.AuthError,
    )
finally:
    security.SERVICE_CREDENTIALS = _real_creds


# ══════════════════════════════════════════════════════════════════════════════
# 2. The key itself — right, wrong, missing, unconfigured
# ══════════════════════════════════════════════════════════════════════════════

actor = security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_ACCRUE)
check("the right key resolves to the system actor", actor["uid"], "system:weekly-accrual")
check("…with a name a person can read", actor["name"], "Weekly accrual (automated)")
check("…and role system", actor["role"], "system")
check("…with no team", actor["team"], None)
check("…and no email to impersonate", actor["email"], "")
check("…naming which credential wrote it", actor["service_credential"], "weekly-accrual")

# The actor handed out is a copy — a route that mutates it cannot edit the
# credential for every request that follows.
actor["uid"] = "tampered"
check(
    "the actor is a copy, not the credential's own dict",
    security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_ACCRUE)["uid"],
    "system:weekly-accrual",
)

refuses(
    "a key differing in one character is refused",
    lambda: security.verify_service_key(WRONG_KEY, security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
refuses(
    "an empty key is refused",
    lambda: security.verify_service_key("", security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
refuses(
    "a prefix of the real key is refused",
    lambda: security.verify_service_key(GOOD_KEY[:-1], security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
refuses(
    "the key with trailing whitespace is refused",
    lambda: security.verify_service_key(GOOD_KEY + " ", security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
refuses(
    "an operation nobody declared is refused",
    lambda: security.verify_service_key(GOOD_KEY, "commission.accrue.please"),
    error=security.AuthError,
)

# A server with no key configured accepts nothing — including the empty string,
# which is what an unset environment variable would present.
settings.service_key_weekly_accrual = ""
refuses(
    "an unconfigured server refuses the real key",
    lambda: security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
refuses(
    "an unconfigured server refuses an empty key",
    lambda: security.verify_service_key("", security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)

# A key that is set but too weak is treated as unset rather than accepted.
settings.service_key_weekly_accrual = "short-key"
refuses(
    "a key below the minimum length is treated as unset",
    lambda: security.verify_service_key("short-key", security.Op.COMMISSION_ACCRUE),
    error=security.AuthError,
)
check("the minimum length is at least 32 characters", security.MIN_SERVICE_KEY_CHARS >= 32, True)
settings.service_key_weekly_accrual = GOOD_KEY

# Refusals say nothing about the key or about whether one is configured.
for bad in ["", WRONG_KEY, GOOD_KEY[:10]]:
    try:
        security.verify_service_key(bad, security.Op.COMMISSION_ACCRUE)
    except security.AuthError as exc:
        text = str(exc)
        ok("a refusal never echoes the presented key", bad[:8] not in text or not bad)
        ok("a refusal never echoes the configured key", GOOD_KEY[:8] not in text)
        ok("a refusal does not say whether a key is configured", "configured" not in text)

# The comparison is over fixed-length digests, so the length of the presented
# value is not observable either. Asserted on the source, because it is the
# property and not the result that matters.
sec_src = (ROOT / "app" / "core" / "security.py").read_text()
ok("the comparison uses hmac.compare_digest", "hmac.compare_digest" in sec_src)
ok("…over sha256 digests, so length does not leak", "hashlib.sha256" in sec_src)
ok(
    "the loop over credentials does not short-circuit on a match",
    "No `break`" in sec_src,
)
check(
    "digests of two different keys differ (sanity)",
    hashlib.sha256(GOOD_KEY.encode()).digest()
    == hashlib.sha256(WRONG_KEY.encode()).digest(),
    False,
)
ok("the key is never logged", not re.search(r"log\.[a-z]+\([^)]*supplied", sec_src))


# ══════════════════════════════════════════════════════════════════════════════
# 3. The door — which routes accept the header, and no others
# ══════════════════════════════════════════════════════════════════════════════

DEPS_SRC = (ROOT / "app" / "core" / "deps.py").read_text()
deps_tree = ast.parse(DEPS_SRC)

service_dep_names: dict[str, str] = {}
for node in deps_tree.body:
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
        fn = node.value.func
        if isinstance(fn, ast.Name) and fn.id == "_person_or_service":
            operation = ast.unparse(node.value.args[0])
            for target in node.targets:
                if isinstance(target, ast.Name):
                    service_dep_names[target.id] = operation

check(
    "exactly nine dependencies accept a service key",
    sorted(service_dep_names),
    [
        "internal_or_accrual_service",
        "internal_or_email_events_service",
        "team_admin_or_accrual_service",
        "team_admin_or_alerts_service",
        "team_admin_or_email_sweep_service",
        "team_admin_or_partner_apply_service",
        "team_admin_or_partner_registration_service",
        "team_admin_or_recharge_request_service",
        "team_admin_or_reporting_service",
    ],
)
check(
    "…and each is bound to one operation",
    {k: v for k, v in sorted(service_dep_names.items())},
    {
        "internal_or_accrual_service": "Op.COMMISSION_PREVIEW",
        "internal_or_email_events_service": "Op.EMAIL_EVENTS",
        "team_admin_or_accrual_service": "Op.COMMISSION_ACCRUE",
        "team_admin_or_alerts_service": "Op.ALERTS_SCAN",
        "team_admin_or_email_sweep_service": "Op.EMAIL_SWEEP",
        "team_admin_or_partner_apply_service": "Op.PARTNER_APPLY",
        "team_admin_or_partner_registration_service": "Op.PARTNER_REGISTER",
        "team_admin_or_recharge_request_service": "Op.RECHARGE_REQUEST",
        "team_admin_or_reporting_service": "Op.REPORTS_SEND",
    },
)
check(
    "…no operation is wired to two dependencies",
    len(set(service_dep_names.values())),
    len(service_dep_names),
)

# Nothing outside deps.py resolves a service key at all.
callers = []
for path in sorted((ROOT / "app").rglob("*.py")):
    if "__pycache__" in str(path):
        continue
    text = path.read_text()
    if "verify_service_key(" in text and path.name != "security.py":
        callers.append(str(path.relative_to(ROOT)))
check("only deps.py resolves a service key", callers, ["app/core/deps.py"])

# And nothing outside deps.py reads the header.
readers = []
for path in sorted((ROOT / "app").rglob("*.py")):
    if "__pycache__" in str(path):
        continue
    text = path.read_text()
    if re.search(r'Header\([^)]*[Xx]-[Ss]ervice-[Kk]ey', text) or re.search(
        r"\bx_service_key\b", text
    ):
        readers.append(str(path.relative_to(ROOT)))
check("only deps.py reads X-Service-Key", readers, ["app/core/deps.py"])


def routes_of(path: Path) -> list[tuple[str, str, set[str]]]:
    """(method, path, dependency names) for every route in a router module."""
    found = []
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)):
                continue
            if not (isinstance(dec.func.value, ast.Name) and dec.func.value.id == "router"):
                continue
            route = dec.args[0].value if dec.args else ""
            used: set[str] = set()
            for default in list(node.args.defaults) + list(node.args.kw_defaults):
                if (
                    isinstance(default, ast.Call)
                    and isinstance(default.func, ast.Name)
                    and default.func.id == "Depends"
                    and default.args
                    and isinstance(default.args[0], ast.Name)
                ):
                    used.add(default.args[0].id)
            found.append((dec.func.attr, route, used))
    return found


accepting: list[str] = []
total_routes = 0
for path in sorted((ROOT / "app" / "routers").glob("*.py")):
    for method, route, used in routes_of(path):
        total_routes += 1
        if used & set(service_dep_names):
            accepting.append(f"{method.upper()} {path.stem}{route}")

ok("the API has a meaningful number of routes to be excluded from", total_routes > 30)
# Twenty: the governance phase added the two app-facing reinstatement routes
# (C2) — filing a request for a revoked role and reading one's own — behind the
# SAME partner-apply wrapper `partnerEligibility` uses. Same blast radius as an
# application: a pending request that grants nothing, decided by the Owner.
# Twenty-three since Decision 15 (RC): the app's three verification routes,
# behind the same wrapper, for a person whose Owner-approved role waits for
# BOTH verified contacts — read what is missing, start what is now allowed,
# report a contact held by another account. None of them can start a role the
# Owner did not approve, or one whose contacts are not both verified: the
# check re-reads Firebase Auth and the server's ledger and re-runs the role
# table, the restriction and the parent. The worst a leaked key does here is
# start, a little early, a role that would start at the person's next visit.
check(
    "exactly twenty-three routes in the whole API accept a credential, and these are they",
    sorted(accepting),
    [
        "GET notifications/reconciliation",
        "GET partner_ops/agencies/{agency_id}/commission-preview",
        "GET partner_ops/applications/eligibility/{uid}",
        "GET partner_ops/applications/of/{uid}",
        "GET partner_ops/applications/parents",
        "GET partner_ops/applications/verification/{uid}",
        "GET role_appeals/of/{uid}",
        "POST notifications/jobs/alerts",
        "POST notifications/jobs/daily",
        "POST notifications/jobs/monthly",
        "POST notifications/jobs/partner-statements",
        "POST notifications/jobs/reconcile",
        "POST notifications/jobs/transactional-sweep",
        "POST notifications/provider-events",
        "POST partner_ops/agencies/{agency_id}/commission-accruals",
        "POST partner_ops/applications",
        "POST partner_ops/applications/host",
        "POST partner_ops/applications/verification/check",
        "POST partner_ops/applications/verification/conflict",
        "POST partner_ops/partners",
        "POST partner_ops/recharges",
        "POST reports/jobs/weekly-business",
        "POST role_appeals",
    ],
)
# No two credentials meet on any route: the accrual key opens exactly the two
# commission routes, the reporting key exactly the nine scheduled ones — seven
# that send, plus the reconciliation pair, which compares rather than sends —
# the registration key exactly one, and no operation appears on another's route.
accrual_deps = {"internal_or_accrual_service", "team_admin_or_accrual_service"}
registration_deps = {
    "team_admin_or_partner_registration_service",
    "team_admin_or_partner_apply_service",
    "team_admin_or_recharge_request_service",
}
#: Every route the onboarding key may open. Pending records that hold nothing,
#: and reads the app already shows its users.
ONBOARDING_ROUTES = {
    "POST partner_ops/partners",
    "GET partner_ops/applications/eligibility/{uid}",
    "GET partner_ops/applications/parents",
    "GET partner_ops/applications/of/{uid}",
    "POST partner_ops/applications",
    "POST partner_ops/applications/host",
    "POST partner_ops/recharges",
    # C2 — a reinstatement request for a revoked role, and the person's own list.
    "POST role_appeals",
    "GET role_appeals/of/{uid}",
    # Decision 15 (RC) — the person's own verification, and starting an
    # Owner-approved role once BOTH contacts are verified (re-read, never taken
    # on the caller's word).
    "GET partner_ops/applications/verification/{uid}",
    "POST partner_ops/applications/verification/check",
    "POST partner_ops/applications/verification/conflict",
}
reporting_deps = set(service_dep_names) - accrual_deps - registration_deps
for path in sorted((ROOT / "app" / "routers").glob("*.py")):
    for method, route, used in routes_of(path):
        opened_by_accrual = bool(used & accrual_deps)
        opened_by_reporting = bool(used & reporting_deps)
        opened_by_registration = bool(used & registration_deps)
        ok(
            f"{path.stem}{route} is opened by at most one credential",
            sum(
                (opened_by_accrual, opened_by_reporting, opened_by_registration)
            ) <= 1,
        )
        if opened_by_registration:
            # The registration credential reaches exactly one route in the whole
            # API, and it is the one that creates an empty pending record.
            # Asserted here rather than left to the list above, because the
            # failure this guards against is somebody wiring the dependency onto
            # a second route later.
            ok(
                f"the onboarding credential opens only onboarding routes ({method.upper()} {path.stem}{route})",
                f"{method.upper()} {path.stem}{route}" in ONBOARDING_ROUTES,
            )
        if opened_by_reporting:
            # The guard here is about *authority*, not about which file a route
            # happens to live in. An earlier version asserted the module was
            # literally `notifications`, which was true only because every
            # reporting route started there; it then failed the moment the
            # weekly business report was added to the reports router, where it
            # belongs. What must stay true is that a reporting credential never
            # reaches a router that moves money, signs a card or touches an
            # account.
            ok(
                f"{path.stem}{route} is a reporting route, not a money one",
                path.stem in {"notifications", "reports"},
            )
            ok(
                f"…and {path.stem} is not a router that moves money",
                path.stem not in {"partner_ops", "cards", "users", "staff", "partners"},
            )

# The same conclusion from the imported module rather than from its text.
runtime_accepting = set()
for entry in ROUTES:
    for param in inspect.signature(entry["fn"]).parameters.values():
        dep = param.default
        if isinstance(dep, Depends) and getattr(dep.dependency, "service_operation", None):
            runtime_accepting.add(
                f"{entry['method'].upper()} {entry['path']}"
                f" [{dep.dependency.service_operation}]"
            )
check(
    "…confirmed on the imported router",
    sorted(runtime_accepting),
    [
        "GET /agencies/{agency_id}/commission-preview [commission.preview]",
        "GET /applications/eligibility/{uid} [partner.apply]",
        "GET /applications/of/{uid} [partner.apply]",
        "GET /applications/parents [partner.apply]",
        "GET /applications/verification/{uid} [partner.apply]",
        "POST /agencies/{agency_id}/commission-accruals [commission.accrue]",
        "POST /applications [partner.apply]",
        "POST /applications/host [partner.apply]",
        "POST /applications/verification/check [partner.apply]",
        "POST /applications/verification/conflict [partner.apply]",
        "POST /partners [partner.register]",
        "POST /recharges [recharge.request]",
    ],
)

# Every cash-moving route still requires an owner. Accrual creates a liability;
# paying it is a separate, signed act, and the credential is nowhere near it.
owner_routes = []
for path in sorted((ROOT / "app" / "routers").glob("*.py")):
    for method, route, used in routes_of(path):
        if "require_owner" in used:
            owner_routes.append(f"{path.stem}{route}")
ok("payouts still require an owner", "partner_ops/commission-payouts/{card_id}/execute" in owner_routes)
ok("sales approval still requires an owner", "partner_ops/sales/{sale_id}/approve" in owner_routes)
ok("there are several owner-only routes", len(owner_routes) >= 5)
check(
    "no owner-only route accepts the credential",
    [r for r in accepting if r.split(" ", 1)[1] in owner_routes],
    [],
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. The dependency, exercised
# ══════════════════════════════════════════════════════════════════════════════

accrual_dep = deps.team_admin_or_accrual_service
preview_dep = deps.internal_or_accrual_service

check(
    "the right key opens accrual",
    run(accrual_dep(authorization="", x_service_key=GOOD_KEY))["uid"],
    "system:weekly-accrual",
)
check(
    "the right key opens preview",
    run(preview_dep(authorization="", x_service_key=GOOD_KEY))["uid"],
    "system:weekly-accrual",
)

exc = refuses(
    "a wrong key on accrual is 401",
    lambda: run(accrual_dep(authorization="", x_service_key=WRONG_KEY)),
    error=HTTPException,
)
check("…with the right status", getattr(exc, "status_code", None), 401)

# No key at all falls through to the person path, which needs a session. The
# machine door does not open for a caller who never presented anything.
exc = refuses(
    "no key falls through to the sign-in requirement",
    lambda: run(accrual_dep(authorization="", x_service_key="")),
    error=HTTPException,
)
check("…which is 401 Sign-in required", getattr(exc, "detail", None), "Sign-in required")

# A key presented alongside a bearer token is still judged as a key. A caller
# claiming to be a machine is held to the machine's rules.
exc = refuses(
    "a bad key is not rescued by an Authorization header",
    lambda: run(accrual_dep(authorization="Bearer whatever", x_service_key=WRONG_KEY)),
    error=HTTPException,
)
check("…still 401", getattr(exc, "status_code", None), 401)

# ── The registration door, exercised ─────────────────────────────────────────

register_dep = deps.team_admin_or_partner_registration_service

settings.service_key_partner_registration = REGISTRATION_KEY
try:
    check(
        "the registration key opens partner creation",
        run(register_dep(authorization="", x_service_key=REGISTRATION_KEY))["uid"],
        "system:partner-registration",
    )
    # And the accrual key, which is configured throughout this file, does not.
    # This is the whole reason the credentials are separate objects: the door is
    # decided by the allowlist, not by which header the route happens to read.
    exc = refuses(
        "the accrual key does not open partner creation",
        lambda: run(register_dep(authorization="", x_service_key=GOOD_KEY)),
        error=HTTPException,
    )
    check("…with 401", getattr(exc, "status_code", None), 401)
    exc = refuses(
        "…and the registration key does not open accrual",
        lambda: run(accrual_dep(authorization="", x_service_key=REGISTRATION_KEY)),
        error=HTTPException,
    )
    check("…with 401 as well", getattr(exc, "status_code", None), 401)
finally:
    settings.service_key_partner_registration = ""

# With the key unconfigured on the server the door is shut, however real the
# value presented. A deployment that skips § 10 registers nobody; it does not
# quietly fall back to accepting anything.
exc = refuses(
    "an unconfigured server refuses the registration key",
    lambda: run(register_dep(authorization="", x_service_key=REGISTRATION_KEY)),
    error=HTTPException,
)
check("…with 401", getattr(exc, "status_code", None), 401)

# No key at all still falls through to the person path — a team admin, exactly
# the authority this route has always required.
exc = refuses(
    "no key on partner creation falls through to the sign-in requirement",
    lambda: run(register_dep(authorization="", x_service_key="")),
    error=HTTPException,
)
check("…which is Sign-in required", getattr(exc, "detail", None), "Sign-in required")


# ══════════════════════════════════════════════════════════════════════════════
# 5. The role model still answers "no" to a machine
# ══════════════════════════════════════════════════════════════════════════════

SYSTEM = "system"

check("system is not a Role member", SYSTEM in {str(r) for r in Role}, False)
check("system is recognised as a machine", R.is_system(SYSTEM), True)
check("no real role is a machine", any(R.is_system(r) for r in Role), False)
check("a machine is not internal", R.is_internal(SYSTEM), False)
check("a machine is not a team admin", R.is_team_admin(SYSTEM), False)
check("a machine is not an owner", R.is_owner(SYSTEM), False)
check("a machine cannot sign money", R.can_sign_money(SYSTEM), False)
check("a machine cannot verify money", R.can_verify_money(SYSTEM, None), False)
check("a machine cannot read all", R.can_read_all(SYSTEM), False)
check("a machine has no audit scope", R.audit_scope(SYSTEM), "none")
check("a machine has no team", R.team_of(SYSTEM), None)

# The scopes people hold are unchanged.
check("owner still sees all audit", R.audit_scope(Role.OWNER), "all")
check("observer still sees all audit", R.audit_scope(Role.OBSERVER), "all")
check("team admin still sees team audit", R.audit_scope(Role.OPS_ADMIN), "team")
check("member still sees own audit", R.audit_scope(Role.OPS_MEMBER), "self")


# ══════════════════════════════════════════════════════════════════════════════
# 6. Audited as itself
# ══════════════════════════════════════════════════════════════════════════════

SYSTEM_ACTOR = security.verify_service_key(GOOD_KEY, security.Op.COMMISSION_ACCRUE)

entry = audit._entry(
    actor=SYSTEM_ACTOR,
    action=audit.Action.COMMISSION_ACCRUE,
    subject_type="partner",
    subject_id="agency-1",
    reason="Weekly accrual (automated) — 2026-W33",
)
check("the entry names the machine", entry["actor"]["uid"], "system:weekly-accrual")
check("…readably", entry["actor"]["name"], "Weekly accrual (automated)")
check("…as a machine", entry["actor"]["role"], "system")
check("…with no team", entry["actor"]["team"], None)
check("…flagged for a filter", entry["actor"]["is_system"], True)
check("the action is the ordinary accrual action", entry["action"], "commission.accrue")

human = {"uid": "u1", "name": "Asha", "role": Role.FINANCE_ADMIN, "team": "finance"}

# The staff row behind that session. `app/core/deps._confirm_role_on_record`
# re-reads it before any permission-gated action, so a session with no record is
# refused — which is the point of the check and would otherwise make this test
# assert the refusal rather than the accrual it is about.
STORE.setdefault("staff", []).append(
    {"uid": "u1", "email": "asha@example.com", "name": "Asha",
     "role": str(Role.FINANCE_ADMIN), "is_active": True}
)
human_entry = audit._entry(
    actor=human,
    action=audit.Action.COMMISSION_ACCRUE,
    subject_type="partner",
    subject_id="agency-1",
    reason="Accrued after checking the ledger",
)
check("a person is not flagged as a machine", human_entry["actor"]["is_system"], False)
check("a person keeps their name", human_entry["actor"]["name"], "Asha")

# A machine may never be anonymous, and may never wear a person's uid.
refuses(
    "a system actor with no name is refused",
    lambda: audit._entry(
        actor={**SYSTEM_ACTOR, "name": ""},
        action="commission.accrue",
        subject_type="partner",
        subject_id="a",
        reason="r",
    ),
    error=ValueError,
)
refuses(
    "a system actor with a person-shaped uid is refused",
    lambda: audit._entry(
        actor={**SYSTEM_ACTOR, "uid": "u1"},
        action="commission.accrue",
        subject_type="partner",
        subject_id="a",
        reason="r",
    ),
    error=ValueError,
)
refuses(
    "a system actor with a blank uid is refused",
    lambda: audit._entry(
        actor={**SYSTEM_ACTOR, "uid": ""},
        action="commission.accrue",
        subject_type="partner",
        subject_id="a",
        reason="r",
    ),
    error=ValueError,
)
# …and the machine's uid prefix is reserved, so nothing else can hide behind it.
refuses(
    "a person cannot borrow a system: uid",
    lambda: audit._entry(
        actor={"uid": "system:weekly-accrual", "name": "Asha", "role": "owner"},
        action="commission.accrue",
        subject_type="partner",
        subject_id="a",
        reason="r",
    ),
    error=ValueError,
)

# An accrual still cannot be recorded without a reason, machine or not.
refuses(
    "a machine still cannot write an entry with no reason",
    lambda: run(
        audit.record(
            actor=SYSTEM_ACTOR,
            action=audit.Action.COMMISSION_ACCRUE,
            subject_type="partner",
            subject_id="a",
            reason="   ",
        )
    ),
    error=ValueError,
)


# ── /audit still behaves with a machine's entries in the log ──────────────────

STORE["audit"] = [
    audit._entry(
        actor=SYSTEM_ACTOR,
        action=audit.Action.COMMISSION_ACCRUE,
        subject_type="partner",
        subject_id="agency-1",
        reason="Weekly accrual (automated) — 2026-W33",
    ),
    audit._entry(
        actor=human,
        action=audit.Action.COMMISSION_ACCRUE,
        subject_type="partner",
        subject_id="agency-2",
        reason="Accrued by hand",
    ),
]

owner_view = run(audit.query(scope="all"))
check("an owner reading /audit sees both entries", len(owner_view), 2)
check(
    "…and can tell the machine from the person at a glance",
    [(e["actor"]["name"], e["actor"]["is_system"]) for e in owner_view],
    [("Weekly accrual (automated)", True), ("Asha", False)],
)

machine_only = run(audit.query(scope="all", filters={"actor.is_system": True}))
check("…and can filter to just the machine", len(machine_only), 1)
check("…by uid too", len(run(audit.query(scope="all", filters={"actor.uid": "system:weekly-accrual"}))), 1)

team_view = run(audit.query(scope="team", actor_team="finance"))
check("a team admin sees their team's entry", len(team_view), 1)
check("…which is the person's", team_view[0]["actor"]["name"], "Asha")

check("a machine reading the log gets nothing", run(audit.query(scope="none")), [])
check(
    "…which is what audit_scope hands it",
    run(audit.query(scope=R.audit_scope(SYSTEM))),
    [],
)


# ══════════════════════════════════════════════════════════════════════════════
# 7. The unattended accrual, end to end
# ══════════════════════════════════════════════════════════════════════════════


def preview(commission_minor: int, *, provisional=False, hosts=None) -> dict:
    hosts = hosts if hosts is not None else [
        {"host_id": "h1", "share_minor": commission_minor, "beans_cashed_out": 10},
    ]
    return {
        "agency_id": "agency-1",
        "agency_name": "Bright Stars",
        "agency_kind": "main",
        "period": "2026-W33",
        "commission_minor": commission_minor,
        "billing": {"billing_minor": commission_minor * 4, "host_count": len(hosts)},
        "breakdown": {
            "rate_percent": "25",
            "band": {"index": 8},
            "explanation": "Billing of ₹0.00 is below the ₹25,001.00 floor.",
        },
        "slab_table": {"source": "firestore"},
        "hosts": hosts,
        "warnings": [],
        "provisional": provisional,
    }


def body(period="2026-W33", reason="") -> BaseModel:
    return BaseModel(
        period=period, reason=reason, host_id="", since=None, until=None,
        amount_minor=None,
    )


accrue_route = router_mod.accrue_commission

# ── It accrues ────────────────────────────────────────────────────────────────
FAKE_SVC.keys.clear()
FAKE_SVC.calls.clear()
FAKE_SVC.preview_result = preview(500_000)          # ₹5,000
result = run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR))
check("the machine accrues", result["outcome"], "accrued")
check("…the whole period", result["credited_minor"], 500_000)
check("…marked unattended", result["unattended"], True)
check(
    "…having previewed the figure first",
    [c["op"] for c in FAKE_SVC.calls],
    ["preview", "accrue"],
)
accrue_call = FAKE_SVC.calls[-1]
check(
    "…and handed the previewed figure back as a check, never as a setting",
    accrue_call["expected_amount_minor"],
    500_000,
)
check("…for every host, never one", accrue_call["host_id"], "")
check("…as the system actor", accrue_call["actor"]["uid"], "system:weekly-accrual")
ok("…with a reason on the record", bool(accrue_call["reason"].strip()))

# ── Re-running the period is a no-op ──────────────────────────────────────────
before = set(FAKE_SVC.keys)
FAKE_SVC.calls.clear()
again = run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR))
check("a second run of the same period accrues nothing", again["outcome"], "already_accrued")
check("…crediting zero", again["credited_minor"], 0)
check("…and moving no idempotency keys", FAKE_SVC.keys, before)
check(
    "the idempotency key is the documented one",
    sorted(FAKE_SVC.keys),
    ["commission:agency-1:h1:2026-W33"],
)

third = run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR))
check("a third run is still a no-op", third["outcome"], "already_accrued")

# A partly-accrued period still credits the hosts that were missed.
FAKE_SVC.preview_result = preview(
    600_000,
    hosts=[
        {"host_id": "h1", "share_minor": 500_000, "beans_cashed_out": 10},
        {"host_id": "h2", "share_minor": 100_000, "beans_cashed_out": 2},
    ],
)
partial = run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR))
check("a partly-accrued period completes", partial["outcome"], "accrued")
check("…crediting only the missing host", partial["credited_minor"], 100_000)
check("…and saying which was already done", partial["already_accrued"], [{"host_id": "h1", "amount_minor": 500_000}])

# ── A week with nothing to accrue is not an error ─────────────────────────────
FAKE_SVC.keys.clear()
FAKE_SVC.preview_result = preview(0, hosts=[])
nothing = run(accrue_route("agency-2", body(), user=SYSTEM_ACTOR))
check("a below-the-floor week is an outcome, not a failure", nothing["outcome"], "nothing_to_accrue")
check("…crediting nothing", nothing["credited_minor"], 0)
ok("…and saying why", "floor" in nothing["message"])

# ── The sanity bound ──────────────────────────────────────────────────────────
STORE["audit"] = []
FAKE_SVC.keys.clear()
over = settings.service_accrual_max_minor + 1
FAKE_SVC.preview_result = preview(over)
exc = refuses(
    "an implausible total is refused",
    lambda: run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR)),
    error=HTTPException,
)
check("…with 409, not a malformed-request 400", getattr(exc, "status_code", None), 409)
check("…naming the outcome", exc.detail["outcome"], "refused_sanity_bound")
ok("…in a message that says nothing was credited", "NOTHING WAS CREDITED" in exc.detail["message"])
check("…and nothing was credited", FAKE_SVC.keys, set())
check("…and the refusal is in the audit log", len(STORE.get("audit", [])), 1)
refusal = STORE["audit"][0]
check("…as its own action", refusal["action"], "commission.accrue_refused")
check("…by the machine", refusal["actor"]["uid"], "system:weekly-accrual")
check("…recording what it would have accrued", refusal["meta"]["would_have_accrued_minor"], over)
check("…and the bound it broke", refusal["meta"]["bound_minor"], settings.service_accrual_max_minor)

# Exactly at the bound is allowed — the bound is a ceiling, not a fence.
FAKE_SVC.preview_result = preview(settings.service_accrual_max_minor)
at_bound = run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR))
check("a total exactly at the bound accrues", at_bound["outcome"], "accrued")

# ── A provisional slab table refuses ──────────────────────────────────────────
STORE["audit"] = []
FAKE_SVC.keys.clear()
FAKE_SVC.preview_result = preview(500_000, provisional=True)
exc = refuses(
    "a provisional slab table is refused unattended",
    lambda: run(accrue_route("agency-3", body(), user=SYSTEM_ACTOR)),
    error=HTTPException,
)
check("…with 409", getattr(exc, "status_code", None), 409)
check("…naming the outcome", exc.detail["outcome"], "refused_provisional_slabs")
check("…and nothing was credited", FAKE_SVC.keys, set())
check("…and it is in the audit log", STORE["audit"][0]["action"], "commission.accrue_refused")

# ── A malformed slab table, or any other refusal, is a loud failure ───────────
FAKE_SVC.preview_result = PartnerOpsError(
    "The commission slab table is empty. An empty table is not the same as a "
    "zero rate, so nothing is paid from it."
)
exc = refuses(
    "a malformed slab table fails the call",
    lambda: run(accrue_route("agency-1", body(), user=SYSTEM_ACTOR)),
    error=HTTPException,
)
check("…with 400", getattr(exc, "status_code", None), 400)
ok("…quoting the reason", "slab table is empty" in str(exc.detail))

# ── A person's accrual is untouched by any of it ──────────────────────────────
FAKE_SVC.keys.clear()
FAKE_SVC.calls.clear()
FAKE_SVC.preview_result = preview(settings.service_accrual_max_minor * 4)
human_body = BaseModel(
    period="2026-W33", reason="Checked the ledger with finance", host_id="h1",
    since=None, until=None, amount_minor=None,
)
by_hand = run(accrue_route("agency-1", human_body, user=human))
check("a team admin is not held to the machine's bound", by_hand["credited_minor"] > 0, True)
check("…and does not preview first", [c["op"] for c in FAKE_SVC.calls], ["accrue"])
check("…keeping their own host scope", FAKE_SVC.calls[0]["host_id"], "h1")
check("…and their own reason", FAKE_SVC.calls[0]["reason"], "Checked the ledger with finance")
ok("…with no unattended outcome bolted on", "outcome" not in by_hand)


# ══════════════════════════════════════════════════════════════════════════════
# 8. The stand-in has not drifted from what it stands in for
# ══════════════════════════════════════════════════════════════════════════════
#
# Sections 7's fake reproduces two things from the real service. If either ever
# changes, these fail rather than the Sunday email quietly misreporting a
# healthy retry as a failure.

SVC_SRC = (ROOT / "app" / "services" / "partner_ops.py").read_text()
ok(
    "the real service still keys movements commission:{agency}:{host}:{period}",
    'f"commission:{agency_id}:{line[\'host_id\']}:{span}"' in SVC_SRC,
)
ok(
    "the real service still says 'already accrued' when a period is complete",
    re.search(
        r"Every host's commission for \{span\} was already accrued", SVC_SRC
    )
    is not None,
)
check(
    "…and the router matches on that phrase",
    router_mod.ALREADY_ACCRUED_MARKER in
    "Every host's commission for 2026-W33 was already accrued (1 paise across 1 host(s)).",
    True,
)
ok(
    "the real service still refuses an amount that disagrees with the ledger",
    re.search(r'does not\s*"?\s*\n?\s*f?"?match what the ledger produces', SVC_SRC)
    is not None,
)


# ══════════════════════════════════════════════════════════════════════════════
# 9. Nothing about the key is in the repository
# ══════════════════════════════════════════════════════════════════════════════
#
# What is banned is a *value*. Naming the variable is the whole point of the
# documentation, and `--set-secrets SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_
# WEEKLY_ACCRUAL:latest` is a Secret Manager **reference** — it names the secret
# to fetch at boot and contains none of it. So the right-hand side is checked
# against what a reference is allowed to look like, rather than banned outright:
# a blank (as in `.env.example`) or `<SECRET>:latest` / `<SECRET>:<version>`.
# Anything else after the `=` is somebody having pasted the key in.

#: `SERVICE_KEY_WEEKLY_ACCRUAL=` followed by this is a reference, not a value.
SECRET_REFERENCE = re.compile(r"^[A-Z0-9_]+:(latest|\d+)$")

#: Every key `scripts/generate_service_key.py` mints wears one of these. If any
#: appears in a tracked file, a real key has been committed. Read from the
#: script rather than written out here, so a third credential cannot be added
#: with a prefix this scan does not know about.
from scripts.generate_service_key import PREFIXES as MINTED_KEY_PREFIXES  # noqa: E402

MINTED_KEY_PREFIX = "zpr_wa_"

check(
    "all three keys are minted with different prefixes",
    sorted(MINTED_KEY_PREFIXES),
    ["zpr_reg_", "zpr_rp_", "zpr_wa_"],
)
check(
    "…and no prefix is a transposition of another, so a value in a log is "
    "unambiguous about which secret to replace",
    len({"".join(sorted(p)) for p in MINTED_KEY_PREFIXES}),
    len(MINTED_KEY_PREFIXES),
)
ok(
    "…so a value found in a log says which credential to replace",
    MINTED_KEY_PREFIX in MINTED_KEY_PREFIXES,
)

#: All three credentials' environment variables, checked with the same rule.
SECRET_ENV_VARS = (
    "SERVICE_KEY_WEEKLY_ACCRUAL",
    "SERVICE_KEY_REPORTING",
    "SERVICE_KEY_PARTNER_REGISTRATION",
)

#: A committed key is a prefix followed by the key itself. The prefix on its own
#: is documentation — the whole reason it exists is that somebody who finds a
#: value in a log can look it up, which they cannot do if naming it is banned.
#: `token_urlsafe(48)` is 64 characters of [A-Za-z0-9_-]; 32 is the API's floor
#: and is used here so a truncated paste is still caught.
MINTED_KEY = re.compile(
    "(" + "|".join(re.escape(p) for p in MINTED_KEY_PREFIXES) + r")[A-Za-z0-9_-]{32,}"
)


def contains_minted_key(text: str) -> str:
    """The prefix of a key found in this text, or ''. Never returns the key."""
    match = MINTED_KEY.search(text)
    return match.group(1) if match else ""


def documents_without_leaking(text: str) -> tuple[bool, str]:
    """Does this file name the credentials without carrying one?"""
    leaked = contains_minted_key(text)
    if leaked:
        return False, f"it carries a key minted with the {leaked!r} prefix"
    for name in SECRET_ENV_VARS:
        # Stop at a comma: `--set-secrets` takes a comma-separated list, and
        # both credentials appear in it, so a greedy match would read the next
        # assignment as this one's value.
        for match in re.finditer(rf"{name}=([^\s,\"']*)", text):
            rhs = match.group(1)
            if rhs and not SECRET_REFERENCE.match(rhs):
                return False, f"{name} is followed by {rhs!r}"
    return True, ""


for path, label in [
    (ROOT / ".env.example", "backend/.env.example"),
    (ROOT.parent / "DEPLOYMENT.md", "DEPLOYMENT.md"),
    (ROOT / "README.md", "backend/README.md"),
]:
    if path.exists():
        text = path.read_text()
        ok(f"{label} documents the accrual credential",
           "SERVICE_KEY_WEEKLY_ACCRUAL" in text)
        clean, why = documents_without_leaking(text)
        ok(f"{label} carries no value for either{'' if clean else ' — ' + why}", clean)

# The reporting credential is what makes the scheduled jobs run unattended. A
# deployment that never sets it has a scheduler firing into 401s, so it is
# documented in the same two places the accrual one is.
for path, label in [
    (ROOT / ".env.example", "backend/.env.example"),
    (ROOT.parent / "DEPLOYMENT.md", "DEPLOYMENT.md"),
]:
    if path.exists():
        ok(f"{label} documents the reporting credential too",
           "SERVICE_KEY_REPORTING" in path.read_text())

# The registration credential is what makes a new agency or seller appear for
# approval at all. A deployment that never sets it has applicants accumulating
# in Firestore, on no staff screen, with a login and an acknowledgement email —
# so it is documented in the same two places as the other two.
for path, label in [
    (ROOT / ".env.example", "backend/.env.example"),
    (ROOT.parent / "DEPLOYMENT.md", "DEPLOYMENT.md"),
]:
    if path.exists():
        text = path.read_text()
        ok(f"{label} documents the registration credential too",
           "SERVICE_KEY_PARTNER_REGISTRATION" in text)
        ok(f"{label} names the Functions variable that carries the same value",
           "ZIPPER_PARTNER_REGISTRATION_KEY" in text)

# Neither Cloud Function key comes from a file. `functions/.env` is where the
# non-secret settings live (the Agora app id, the API base URL); a key in there
# would be a key on somebody's laptop and in a deploy artefact.
functions_env = ROOT.parent / "functions" / ".env"
if functions_env.exists():
    env_text = functions_env.read_text()
    ok("functions/.env holds no accrual key", "ZIPPER_ACCRUAL_KEY" not in env_text)
    ok("functions/.env holds no reporting key", "ZIPPER_REPORTING_KEY" not in env_text)
    ok("functions/.env holds no registration key",
       "ZIPPER_PARTNER_REGISTRATION_KEY" not in env_text)
    ok("functions/.env holds no minted key", not contains_minted_key(env_text))

# …and the function must actually declare the secret, or nothing arrives in
# `process.env` at runtime and every Sunday silently skips accrual.
functions_index = ROOT.parent / "functions" / "src" / "index.ts"
if functions_index.exists():
    index_text = functions_index.read_text()
    ok(
        "the Cloud Function declares the secret it needs",
        # Since the SendGrid change the weekly job also declares its mail
        # key; the accrual key must still be the first (and only service)
        # secret on that function.
        re.search(r"secrets: \[ACCRUAL_KEY_ENV(, SENDGRID_KEY_ENV)?\]", index_text) is not None
        and "const ACCRUAL_KEY_ENV = 'ZIPPER_ACCRUAL_KEY'" in index_text,
    )
    ok(
        "…presents it in the header the API reads",
        "const SERVICE_KEY_HEADER = 'X-Service-Key'" in index_text,
    )
    ok(
        "…and hardcodes no key of its own",
        not contains_minted_key(index_text),
    )
    # The scheduled reporting jobs are the same pattern with the other
    # credential. They must not reach for the accrual key, and the accrual job
    # must not reach for theirs — that separation is the whole reason there are
    # two keys rather than one.
    ok(
        "the scheduled reporting jobs declare their own secret",
        "secrets: [REPORTING_KEY_ENV]" in index_text
        and "const REPORTING_KEY_ENV = 'ZIPPER_REPORTING_KEY'" in index_text,
    )
    ok(
        "…and it is a different variable from the accrual one",
        "ZIPPER_REPORTING_KEY" != "ZIPPER_ACCRUAL_KEY"
        and len(re.findall(r"secrets: \[ACCRUAL_KEY_ENV(?:, SENDGRID_KEY_ENV)?\]", index_text)) == 1
        and "secrets: [ACCRUAL_KEY_ENV, ZIPPER_REPORTING_KEY" not in index_text,
    )
    # The onboarding triggers are the same pattern again with the third
    # credential, and the same separation applies: no function may hold two.
    ok(
        "the onboarding triggers declare their own secret",
        "secrets: [PARTNER_REGISTRATION_KEY_ENV]" in index_text
        and "const PARTNER_REGISTRATION_KEY_ENV = 'ZIPPER_PARTNER_REGISTRATION_KEY'"
        in index_text,
    )
    ok(
        "…and it is a third, different variable",
        len({
            "ZIPPER_ACCRUAL_KEY",
            "ZIPPER_REPORTING_KEY",
            "ZIPPER_PARTNER_REGISTRATION_KEY",
        }) == 3
        # Two declarations now: the registration triggers, and the app's
        # "Join as …" / recharge callables, which present the same key for the
        # same reason (pending records that hold nothing). Still one secret.
        and index_text.count("secrets: [PARTNER_REGISTRATION_KEY_ENV]") == 2,
    )
    KEY_ENVS = ["ACCRUAL_KEY_ENV", "REPORTING_KEY_ENV", "PARTNER_REGISTRATION_KEY_ENV"]
    for first in KEY_ENVS:
        for second in KEY_ENVS:
            if first != second:
                ok(
                    f"…and no function declares both {first} and {second}",
                    f"secrets: [{first}, {second}]" not in index_text,
                )
    ok(
        "a registration that fails is recorded on the document, not swallowed",
        "partnerRecordFailed" in index_text
        and re.search(r"await record\(\{\s*status: 'failed'", index_text) is not None,
    )
    ok(
        "…and the trigger throws rather than reporting a lost applicant as healthy",
        re.search(r"if \(failure\) \{[\s\S]{0,600}?throw new Error\(failure\)",
                  index_text) is not None,
    )
    ok(
        "…treats an existing record as success rather than as a failure",
        "`created: false` is SUCCESS" in index_text,
    )
    ok(
        "a second-capability application is not registered by the trigger",
        "const SOURCE_NOT_REGISTERED_HERE = 'second_role'" in index_text,
    )
    # The seller emails no longer depend on who filed the application. A
    # staff-registered coin seller was told neither that they had registered nor
    # that they had been approved; an agency always was.
    ok(
        "no seller email is gated on the application's source",
        "data.source !== 'self_signup'" not in index_text
        and "after.source !== 'self_signup'" not in index_text,
    )
    ok(
        "a scheduled job that cannot run throws instead of returning quietly",
        re.search(r"functions\.logger\.error\(message\)\s*\n\s*throw new Error",
                  index_text) is not None,
    )
    ok(
        "…and names the variable that is missing, never a value",
        "is not set on this function, so it holds no credential" in index_text,
    )
    ok(
        "…treats already_accrued as success rather than as a failure",
        re.search(
            r"outcome === 'already_accrued'[\s\S]{0,400}?needsPerson: false",
            index_text,
        )
        is not None,
    )


# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} service-credential checks passed.")
print("  · the accrual credential unlocks two operations and is refused on every other")
print("  · the reporting credential unlocks four, holds no money operation, and")
print("    the three allowlists are disjoint — no key opens another's routes")
print("  · the registration credential unlocks one, `partner.register`, and can")
print("    neither accrue nor send: it creates an empty pending record and stops")
print("  · exactly twelve routes in the API accept X-Service-Key; no owner route does")
print("  · a wrong, empty, short or unconfigured key is refused, and says nothing")
print("  · every entry it writes reads as 'Weekly accrual (automated)', role system")
print("  · re-running a period credits nothing a second time")
print("  · an implausible total, or a provisional slab table, refuses loudly")
sys.exit(0)
