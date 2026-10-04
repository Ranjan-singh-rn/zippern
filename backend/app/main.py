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
from app.db import firebase, mongo
from app.routers import (
    audit,
    auth,
    broadcasts,
    capital,
    cards,
    chance,
    expenses,
    notifications,
    partner_ops,
    partners,
    reports,
    staff,
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(cards.router, prefix="/api")
app.include_router(audit.router, prefix="/api")
app.include_router(partners.router, prefix="/api")
app.include_router(staff.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(partner_ops.router, prefix="/api")
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
