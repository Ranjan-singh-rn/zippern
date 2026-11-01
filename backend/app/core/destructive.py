"""P0-10 (OPS-C): the gate every destructive or seeding script passes first.

Phase 0 (`app/core/isolation.py`) already keeps a development process on this
machine and makes a production-mode process off Cloud Run name its project
(`ZIPPER_ALLOW_PRODUCTION_ACCESS`). A reset, purge or seed needs more than
that, because the cost of a mistake is the data itself:

  * LOCAL (development / test): allowed — Phase 0 guarantees the target is the
    emulators and a MongoDB on this machine. Nothing else is required.
  * PRODUCTION MODE, anywhere (Cloud Run's `K_SERVICE` does NOT exempt a
    script):
      1. `ZIPPER_ALLOW_PRODUCTION_ACCESS` must equal `FIREBASE_PROJECT_ID`;
      2. the service-account key must belong to that same project — a key for
         one project with the id of another is how a "staging" run lands in
         production;
      3. a run that WRITES must carry the typed confirmation
         `ZIPPER_CONFIRM_DESTRUCTIVE=<script>:<project>` for that one command;
      4. a run that writes must find the DATA CANARY — MongoDB
         `ops_canary/target` naming the same project — proving the database it
         connected to belongs to that project. Nothing creates one: a target
         without it refuses every destructive write until a person provisions
         it deliberately.
  * The target is printed — "local" or the project id — before anything runs.

Every check runs before a client exists (except the canary, which is the first
read after connecting) and fails closed. Messages never contain a connection
string, a key or a token.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

from app.core import isolation

CONFIRM_ENV = "ZIPPER_CONFIRM_DESTRUCTIVE"
CANARY_COLLECTION = "ops_canary"
CANARY_ID = "target"


class DestructiveRefused(RuntimeError):
    """This script may not run against this target, as configured."""


def _key_project(settings: Any, env: Mapping[str, str]) -> str:
    path = str(getattr(settings, "firebase_credentials_path", "") or "").strip()
    if not path or not os.path.isfile(path):
        path = str(env.get("GOOGLE_APPLICATION_CREDENTIALS", "") or "").strip()
    if not path:
        raise DestructiveRefused(
            "no service-account key is configured, so the target project cannot be "
            "confirmed from the key itself."
        )
    try:
        with open(path, encoding="utf-8") as fh:
            return str(json.load(fh).get("project_id") or "").strip()
    except Exception as exc:  # noqa: BLE001
        raise DestructiveRefused("the service-account key could not be read.") from exc


def require_destructive_target(
    script: str,
    *,
    writes: bool,
    settings: Any = None,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Refuse unless this script may run here. Returns the target line to print."""
    if settings is None:
        from app.config import settings as _settings

        settings = _settings
    env = os.environ if environ is None else environ
    project = str(getattr(settings, "firebase_project_id", "") or "").strip()

    if not isolation.is_production(settings):
        problems = isolation.mongo_problems(settings, env) + isolation.firebase_problems(settings, env)
        if problems:
            raise DestructiveRefused(f"{script}: refusing — " + " ".join(problems))
        return f"{script}: target LOCAL — Firebase emulators (project {project}) and MongoDB on this machine"

    if not project or project.startswith(isolation.DEMO_PROJECT_PREFIX):
        raise DestructiveRefused(f"{script}: refusing — production mode needs a real FIREBASE_PROJECT_ID.")
    if (env.get(isolation.PRODUCTION_ACK_ENV) or "").strip() != project:
        raise DestructiveRefused(
            f"{script}: refusing — set {isolation.PRODUCTION_ACK_ENV} to the target project id "
            "for this one command (Cloud Run does not exempt a script)."
        )
    if _key_project(settings, env) != project:
        raise DestructiveRefused(
            f"{script}: refusing — the service-account key belongs to a different project "
            "than FIREBASE_PROJECT_ID."
        )
    if writes and (env.get(CONFIRM_ENV) or "").strip() != f"{script}:{project}":
        raise DestructiveRefused(
            f"{script}: refusing — a run that writes needs {CONFIRM_ENV}={script}:<project-id> "
            "typed for this one command."
        )
    return f"{script}: target PROJECT {project} (production mode, confirmed{' for writes' if writes else ', read-only'})"


async def require_data_canary(db: Any, script: str, *, settings: Any = None) -> None:
    """After connecting, before the first write: does this database belong to the project?"""
    if settings is None:
        from app.config import settings as _settings

        settings = _settings
    if not isolation.is_production(settings):
        return
    project = str(getattr(settings, "firebase_project_id", "") or "").strip()
    try:
        doc = await db[CANARY_COLLECTION].find_one({"_id": CANARY_ID})
    except Exception as exc:  # noqa: BLE001
        raise DestructiveRefused(f"{script}: refusing — the data canary could not be read.") from exc
    if not doc or str(doc.get("firebase_project_id") or "").strip() != project:
        raise DestructiveRefused(
            f"{script}: refusing — the connected MongoDB has no data canary "
            f"({CANARY_COLLECTION}/{CANARY_ID}) naming this project. A destructive run needs "
            "one, provisioned deliberately by a person, so a database cannot be wiped "
            "under the wrong project's name."
        )
