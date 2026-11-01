"""Zipper API — the business record and money core.

Firebase keeps identity and real-time app state. Everything that constitutes a
business record — the ledger, the audit log, approval cards, partner records —
lives here, in MongoDB, behind an API no client can bypass.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import assert_secure_configuration, settings
from app.core import isolation
from app.db import firebase, mongo
from app.routers import (
    audit,
    auth,
    broadcasts,
    capital,
    cards,
    chance,
    documents,
    expenses,
    notifications,
    partner_ops,
    partners,
    public_appeals,
    reports,
    role_appeals,
    staff,
    tickets,
    transfer_requests,
    users,
    verification,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("zipper")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Before anything else, and before a single request can be served: refuse to
    # run on a configuration that cannot keep a session token secret. See
    # `app.config.secret_problems` for what is checked and why development is
    # exempt. This raises, which fails the deployment loudly rather than serving
    # traffic signed with a key that is in the repository.
    assert_secure_configuration(settings)

    # Outside production every destination must be on this machine (MongoDB,
    # the Firebase emulators) and no email is sent; in production off Cloud Run
    # the run must be confirmed. Checked here so every problem is named at once
    # — `firebase.init()` and `mongo.connect()` repeat their own half anyway.
    isolation.assert_local_isolation(settings)
    log.info("Isolation: %s", isolation.describe(settings))

    firebase.init()
    await mongo.connect()
    log.info("Zipper API ready (%s)", settings.environment)
    yield
    await mongo.disconnect()


app = FastAPI(
    title="Zipper API",
    description="Business record and money core.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if not settings.is_production else [
        "https://zipperlive.web.app",
        "https://zipperlive.firebaseapp.com",
    ],
    # Bearer tokens only — no cookie auth anywhere — so credentials are never
    # needed, and a wildcard origin must never be paired with them.
    allow_credentials=settings.is_production,
    allow_methods=["*"],
    allow_headers=["*"],
    # P1-A3: lets the CRM tell "finish two-step sign-in" from any other 403.
    expose_headers=["X-Zipper-MFA-Required"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(cards.router, prefix="/api")
app.include_router(audit.router, prefix="/api")
app.include_router(partners.router, prefix="/api")
app.include_router(staff.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(partner_ops.router, prefix="/api")
# C2 — reinstatement of a revoked role: the person asks, a reviewer recommends,
# the Owner decides. `/api/partner-ops/role-appeals`.
app.include_router(role_appeals.router, prefix="/api")
# C3 — transfers between agencies: an admin requests, the Owner decides.
# `/api/partner-ops/transfers`.
app.include_router(transfer_requests.router, prefix="/api")
# Operating expenditure — the other half of the owner's profit definition.
app.include_router(expenses.router, prefix="/api")
# The owners' capital account. Money the owners put in and take back is cash
# but is NOT trading, so it is reported apart from revenue and expenditure and
# never reaches profit — see `app/services/capital.py`.
app.include_router(capital.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
# Part 8A — scheduled reports, exception alerts and the delivery log.
app.include_router(notifications.router, prefix="/api")
# 8A.7.2 — the one email a person composes, rather than one a record generates.
# It goes out through the same `email.deliver` as everything else and lands in
# the same delivery log; what is different is that a human chose the audience,
# which is why authority for it is graded by how many people it reaches.
app.include_router(broadcasts.router, prefix="/api")
# Part 8B — chance mechanics: the server-side RNG and the configuration behind
# it. Nothing here is live until an owner has signed a configuration, and every
# mechanic starts disabled in every country (8B.0.4 / 8B.1.7).
app.include_router(chance.router, prefix="/api")

# Host identity verification review. Lives here rather than in a Cloud Function
# because approving one sets `isVerifiedHost`, which is what releases a host's
# weekly earnings for withdrawal — so it belongs in the same append-only audit
# trail as bans, balance cards and payouts.
app.include_router(verification.router, prefix="/api")

# Short-lived signed links to KYC and identity documents. The CRM used to
# render the permanent `?alt=media&token=` URL stored at upload — a bearer
# credential that never expires and that Storage Rules are never consulted
# for. This route authorises the caller and mints a fifteen-minute URL
# instead; the stored string never leaves the API.
app.include_router(documents.router, prefix="/api")

# UGP-F: the PUBLIC appeal — a person locked out of their account files an
# appeal from a web page, without signing in. Writes the existing `appeals`
# collection (so the CRM inbox and decision are unchanged) and never lifts a
# restriction. See `app/services/public_appeals.py`.
app.include_router(public_appeals.router, prefix="/api")
# P1-D: ticket workflows — the only writer of techTickets / feedbackTickets /
# supportTickets; the Firestore rules refuse client mutations of them.
app.include_router(tickets.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "environment": settings.environment}


@app.get("/api/health/firestore")
async def health_firestore():
    """Can this container actually read Firestore?

    `/api/health` answers "the process is up", which is a much weaker claim than
    it looks. A deploy once passed that check while every Firestore read in the
    API was failing with `400 Invalid database id %28default%29` — the container
    had resolved a different set of Google libraries from the machine the code
    was written on. The API was healthy, and sign-in still told every agency
    their password was wrong.

    So this does the smallest real read there is and reports what came back,
    including the library versions, because that is the thing that differed.
    Deliberately unauthenticated: an outage is exactly when nobody can sign in.
    """
    import asyncio
    from importlib.metadata import PackageNotFoundError, version

    def _versions() -> dict:
        out = {}
        for pkg in ("firebase-admin", "google-cloud-firestore", "google-api-core",
                    "protobuf", "grpcio"):
            try:
                out[pkg] = version(pkg)
            except PackageNotFoundError:
                out[pkg] = "not installed"
        return out

    def _probe() -> None:
        from app.db import firebase
        # One document, existence not required — reaching the server is the test.
        firebase.firestore_client().collection("appConfig").document("economy").get()

    try:
        await asyncio.to_thread(_probe)
    except Exception as exc:  # noqa: BLE001 — reporting the failure IS the job
        return {
            "status": "failed",
            "detail": f"{type(exc).__name__}: {exc}",
            "meaning": (
                "This container cannot read Firestore. Sign-in, the email "
                "composer's audiences and every economy rate are affected. This "
                "is not a configuration problem in the CRM."
            ),
            "versions": _versions(),
        }
    return {"status": "ok", "versions": _versions()}
