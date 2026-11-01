"""Local isolation: outside production, this process reaches only this machine.

── WHY THIS EXISTS ───────────────────────────────────────────────────────────

`backend/.env` on the owner's machine held the production MongoDB connection
string, the production Firebase project and a path to the production service-
account key, with `ENVIRONMENT=development`. Every `uvicorn app.main:app`, every
`python -m scripts.…` and every local experiment therefore ran against live
data — and `mongo.connect()` ends with `ensure_indexes()`, which is DDL.

Nothing in the code said "a development process must not do that". This module
is that rule, enforced at the three places a process leaves the machine:

  * MongoDB      `mongo.connect()` and the email recorder's sync client;
  * Firebase     `firebase.init()`, before any credential is read;
  * email        the SendGrid key is discarded outside production (config).

── THE RULE ──────────────────────────────────────────────────────────────────

Outside production (`ENVIRONMENT` = development or test):

  * MongoDB must be `mongodb://` on localhost / 127.0.0.1 / ::1. `mongodb+srv://`
    is refused outright: it is how a remote cluster is named.
  * Firebase must be a `demo-` project — Firebase's reserved prefix for projects
    that exist only in the emulators — with the Firestore, Auth and Storage
    emulator hosts all set and all on this machine. No service-account key and
    no Application Default Credentials are read: the SDK is given anonymous
    credentials, so even a missing emulator host cannot authenticate anywhere.
  * No email is sent. Deliveries are recorded as `not_configured`.

In production (`ENVIRONMENT=production`):

  * On Cloud Run (`K_SERVICE` is set by the platform on every service
    container) nothing here changes behaviour.
  * Anywhere else — an operator's laptop — the run must be confirmed
    explicitly: `ZIPPER_ALLOW_PRODUCTION_ACCESS` must equal `FIREBASE_PROJECT_ID`.
    A shell that happens to have `ENVIRONMENT=production` exported is not a
    decision to touch production.

Every check fails closed and runs BEFORE a client, credential or connection
exists. Messages never contain a connection string, host name, key or token.

Pure and import-light on purpose (stdlib only, no `app.*` imports), so the tests
can exercise every branch without a database, an emulator or a network.
"""

from __future__ import annotations

import ipaddress
import logging
import os
from typing import Any, Mapping, MutableMapping
from urllib.parse import unquote, urlsplit

log = logging.getLogger("zipper.isolation")

#: Set this to the production project id to let a production-mode process run
#: somewhere other than Cloud Run. Deliberately long and specific.
PRODUCTION_ACK_ENV = "ZIPPER_ALLOW_PRODUCTION_ACCESS"

#: Cloud Run sets this on every service container. Nothing else should.
CLOUD_RUN_ENV = "K_SERVICE"

#: Firebase's reserved prefix: a project id starting with this exists only in
#: the emulators, and the emulators refuse to reach any real resource for it.
DEMO_PROJECT_PREFIX = "demo-"

#: (environment variable the SDK reads, Settings field that may carry it).
#: Firestore and Auth take `host:port`; Storage (google-cloud-storage) takes a
#: URL with its scheme.
EMULATOR_VARS: tuple[tuple[str, str], ...] = (
    ("FIRESTORE_EMULATOR_HOST", "firestore_emulator_host"),
    ("FIREBASE_AUTH_EMULATOR_HOST", "firebase_auth_emulator_host"),
    ("STORAGE_EMULATOR_HOST", "storage_emulator_host"),
)

_LOCAL_NAMES = frozenset({"localhost"})


class IsolationError(RuntimeError):
    """This process would reach a destination its environment does not allow."""


# ── Small, total helpers ─────────────────────────────────────────────────────


def is_production(settings: Any) -> bool:
    env = str(getattr(settings, "environment", "") or "").strip().lower()
    return env in {"production", "prod"}


def is_loopback_host(host: str) -> bool:
    """localhost, 127.0.0.0/8 or ::1. Anything else — including '' — is not."""
    h = (host or "").strip().lower().rstrip(".")
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h in _LOCAL_NAMES:
        return True
    try:
        return ipaddress.ip_address(h.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def host_of(value: str) -> str:
    """The host in `host:port`, `[::1]:port` or `http://host:port`. Never raises."""
    v = (value or "").strip()
    if not v:
        return ""
    if "://" in v:
        try:
            return urlsplit(v).hostname or ""
        except ValueError:
            return ""
    if v.startswith("["):
        return v[1 : v.find("]")] if "]" in v else ""
    if v.count(":") == 1:
        return v.split(":", 1)[0]
    return v  # bare host, or a bare IPv6 literal


def mongo_hosts(uri: str) -> tuple[str, list[str]]:
    """(scheme, hosts) of a MongoDB connection string.

    Credentials are cut off before anything is returned, and nothing here is
    ever put into a message: the callers report counts, not names.
    """
    u = (uri or "").strip()
    scheme, sep, rest = u.partition("://")
    if not sep:
        return "", []
    netloc = rest.split("/", 1)[0].split("?", 1)[0]
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]
    hosts: list[str] = []
    for part in netloc.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("["):
            hosts.append(part[1 : part.find("]")] if "]" in part else part)
        elif part.count(":") <= 1:
            hosts.append(part.split(":", 1)[0])
        else:
            hosts.append(part)
    return scheme.strip().lower(), hosts


def _is_unix_socket(host: str) -> bool:
    decoded = unquote(host or "")
    return decoded.startswith("/") and decoded.endswith(".sock")


def emulator_value(settings: Any, var: str, field: str, environ: Mapping[str, str]) -> str:
    """The emulator setting: from Settings (env or env file), else the environment."""
    return str(getattr(settings, field, "") or environ.get(var, "") or "").strip()


# ── The checks. Each returns sentences; [] means allowed. ────────────────────


def production_problems(settings: Any, environ: Mapping[str, str] | None = None) -> list[str]:
    """A production-mode process off Cloud Run must be confirmed explicitly."""
    env = os.environ if environ is None else environ
    if (env.get(CLOUD_RUN_ENV) or "").strip():
        return []
    project = str(getattr(settings, "firebase_project_id", "") or "").strip()
    ack = (env.get(PRODUCTION_ACK_ENV) or "").strip()
    if project and not project.startswith(DEMO_PROJECT_PREFIX) and ack == project:
        return []
    return [
        "ENVIRONMENT is 'production' but this process is not running on Cloud Run. "
        "Production data is never reached by default from another machine. To run "
        "a deliberate production operation from here, set FIREBASE_PROJECT_ID and "
        f"{PRODUCTION_ACK_ENV} to the same project id for that one command."
    ]


def mongo_problems(settings: Any, environ: Mapping[str, str] | None = None) -> list[str]:
    if is_production(settings):
        return production_problems(settings, environ)
    scheme, hosts = mongo_hosts(str(getattr(settings, "mongo_uri", "") or ""))
    if scheme == "mongodb+srv":
        return [
            "MONGO_URI is a mongodb+srv:// address, which names a remote cluster. "
            "Outside production only a MongoDB on this machine is allowed, e.g. "
            "mongodb://127.0.0.1:27017/?directConnection=true."
        ]
    if scheme != "mongodb":
        return ["MONGO_URI is not a mongodb:// connection string."]
    if not hosts:
        return ["MONGO_URI names no host."]
    remote = [h for h in hosts if not (is_loopback_host(h) or _is_unix_socket(h))]
    if remote:
        return [
            f"MONGO_URI names {len(remote)} host(s) that are not on this machine. "
            "Outside production only localhost, 127.0.0.1 or ::1 is allowed."
        ]
    return []


def firebase_problems(settings: Any, environ: Mapping[str, str] | None = None) -> list[str]:
    env = os.environ if environ is None else environ
    if is_production(settings):
        return production_problems(settings, env)
    problems: list[str] = []
    project = str(getattr(settings, "firebase_project_id", "") or "").strip()
    if not project.startswith(DEMO_PROJECT_PREFIX):
        problems.append(
            "FIREBASE_PROJECT_ID must be a demo- project outside production (for "
            "example demo-zipper). A demo project exists only in the emulators."
        )
    for var, field in EMULATOR_VARS:
        value = emulator_value(settings, var, field, env)
        if not value:
            problems.append(
                f"{var} is not set. Outside production every Firebase service must "
                "go to its emulator on this machine."
            )
        elif not is_loopback_host(host_of(value)):
            problems.append(f"{var} does not point at this machine.")
    for var in ("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"):
        other = (env.get(var) or "").strip()
        if other and other != project:
            problems.append(f"{var} names a different project from FIREBASE_PROJECT_ID.")
    bucket = str(getattr(settings, "firebase_storage_bucket", "") or "").strip()
    if bucket and project.startswith(DEMO_PROJECT_PREFIX) and not bucket.startswith(project + "."):
        problems.append(
            "FIREBASE_STORAGE_BUCKET must belong to the demo project "
            f"(for example {project}.appspot.com)."
        )
    return problems


def _raise(what: str, problems: list[str]) -> None:
    if problems:
        raise IsolationError(
            f"Refusing to {what}. " + " ".join(problems)
            + " See backend/LOCAL_DEVELOPMENT.md."
        )


def assert_mongo_allowed(settings: Any, environ: Mapping[str, str] | None = None) -> None:
    _raise("connect to MongoDB", mongo_problems(settings, environ))


def assert_firebase_allowed(settings: Any, environ: Mapping[str, str] | None = None) -> None:
    _raise("initialise Firebase", firebase_problems(settings, environ))


def assert_local_isolation(settings: Any, environ: Mapping[str, str] | None = None) -> None:
    """Every destination at once, so a misconfiguration is reported in one go."""
    _raise("start", mongo_problems(settings, environ) + firebase_problems(settings, environ))


# ── What the SDKs are told ───────────────────────────────────────────────────


def export_emulator_environment(
    settings: Any, environ: MutableMapping[str, str] | None = None
) -> None:
    """Put the approved emulator hosts where the SDKs read them (os.environ).

    A value that came from `.env.local` exists only on the Settings object;
    firebase_admin, google-cloud-firestore and google-cloud-storage read the
    process environment. Called only after `firebase_problems()` returned [].
    """
    env = os.environ if environ is None else environ
    for var, field in EMULATOR_VARS:
        value = emulator_value(settings, var, field, env)
        if value:
            env[var] = value


def disable_outbound_email_outside_production(settings: Any) -> bool:
    """Outside production no email leaves this process. True if a key was dropped.

    The delivery code already treats an empty SENDGRID_API_KEY as "record the
    message as not_configured, send nothing". Dropping the key here, once, when
    settings are loaded, makes that the only possible outcome for a local run —
    whatever `.env` happens to contain. Tests that exercise the provider path
    assign a key and a fake SendGrid module explicitly, after this has run.
    """
    if is_production(settings):
        return False
    if str(getattr(settings, "sendgrid_api_key", "") or "").strip():
        settings.sendgrid_api_key = ""
        log.warning(
            "ENVIRONMENT=%s: SENDGRID_API_KEY ignored — outbound email is disabled "
            "outside production; deliveries are recorded as not_configured.",
            getattr(settings, "environment", "?"),
        )
        return True
    return False


def describe(settings: Any) -> str:
    """One log line saying which world this process is in. No values."""
    if is_production(settings):
        where = "Cloud Run" if (os.environ.get(CLOUD_RUN_ENV) or "").strip() else "OFF Cloud Run (confirmed)"
        return f"production ({where})"
    return (
        "local isolation: MongoDB on this machine, Firebase emulators "
        f"(project {getattr(settings, 'firebase_project_id', '')}), outbound email disabled"
    )
