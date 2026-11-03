"""Security review of the QA fixes (3 Nov 2026) — revoking sessions also cuts off
the ID tokens already issued.

`firebase.revoke_sessions` used to revoke the Firebase refresh tokens only and
leave `users/{uid}.credentialsValidAfter` to the caller. The security reset
(`security.revoke_sessions_for_uid(..., mobile=True)`: an Observer resetting the
Owner's authenticator, "sign out everywhere" with a reset) never moved it — so
an ID token already on a stolen phone kept working against the rules and the
protected callables for up to an hour after the reset (QA #45 made that reset
reachable from Team access).

Pinned here:

  * a revocation moves `credentialsValidAfter` past now, for every caller;
  * never backwards — a later cut-off (a suspension's) is kept;
  * an account with no app document (a CRM-only login) gets no document;
  * the cut-off is made even when the refresh-token revocation fails (a
    refreshed ID token keeps the original `auth_time`, so the cut-off stops it);
  * every failure is a sentence, never swallowed; no uid is refused as such.

REAL: `app.db.firebase.revoke_sessions` / `cut_off_issued_tokens`, over the
in-memory Firestore (tests/fakes.py) and the stubbed Admin SDK (tests/harness.py).

    python3 -m tests.test_qa_session_cutoff
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import AUTH_CALLS, install_stubs, reset_auth_calls  # noqa: E402

install_stubs()

import logging  # noqa: E402

from app.db import firebase as firebase_mod  # noqa: E402
from tests.fakes import FakeFirestore  # noqa: E402

FS = FakeFirestore()
firebase_mod.firestore_client = lambda: FS  # type: ignore[assignment]
logging.disable(logging.CRITICAL)
USERS = FS.collection("users")

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


# ── A revocation cuts off the tokens already issued ───────────────────────────
reset_auth_calls()
USERS.docs["u-phone"] = {"name": "Stolen phone", "credentialsValidAfter": 0}
before = int(time.time())
problem = firebase_mod.revoke_sessions("u-phone")
after = int(time.time())
eq("a revocation reports nothing wrong", problem, "")
eq("…revokes the refresh tokens", AUTH_CALLS["revoked"], ["u-phone"])
cut = USERS.docs["u-phone"].get("credentialsValidAfter")
ok("…and moves credentialsValidAfter past now (every token signed in before now is refused)",
   isinstance(cut, int) and before + 1 <= cut <= after + 1, f"cut={cut!r} now={before}..{after}")

# ── Never backwards ───────────────────────────────────────────────────────────
later = int(time.time()) + 3600
USERS.docs["u-suspended"] = {"credentialsValidAfter": later}
eq("a later cut-off already on the account is kept", (firebase_mod.revoke_sessions("u-suspended"),
                                                      USERS.docs["u-suspended"]["credentialsValidAfter"]), ("", later))
USERS.docs["u-garbage"] = {"credentialsValidAfter": None}
firebase_mod.cut_off_issued_tokens("u-garbage")
ok("a missing or empty value is replaced", isinstance(USERS.docs["u-garbage"]["credentialsValidAfter"], int)
   and USERS.docs["u-garbage"]["credentialsValidAfter"] > before)

# ── No app document: nothing to cut off, nothing created ──────────────────────
reset_auth_calls()
eq("a CRM-only login: revoked, and no users document is created",
   (firebase_mod.revoke_sessions("crm-only"), AUTH_CALLS["revoked"], "crm-only" in USERS.docs), ("", ["crm-only"], False))

# ── The cut-off is made even when the revocation fails ────────────────────────
real_revoke = firebase_mod.fb_auth.revoke_refresh_tokens


def _auth_down(uid):
    raise RuntimeError("Firebase Auth unreachable")


firebase_mod.fb_auth.revoke_refresh_tokens = _auth_down
USERS.docs["u-auth-down"] = {"credentialsValidAfter": 0}
problem = firebase_mod.revoke_sessions("u-auth-down")
ok("a failed revocation is reported", problem.startswith("The live sessions could not be revoked:")
   and "Firebase Auth unreachable" in problem, problem)
ok("…and the issued tokens are cut off all the same", USERS.docs["u-auth-down"]["credentialsValidAfter"] > before)


def _no_user(uid):
    raise firebase_mod.fb_auth.UserNotFoundError("no such user")


firebase_mod.fb_auth.revoke_refresh_tokens = _no_user
USERS.docs["u-gone"] = {"credentialsValidAfter": 0}
eq("an account Firebase does not know has no sessions: nothing to report",
   (firebase_mod.revoke_sessions("u-gone"), USERS.docs["u-gone"]["credentialsValidAfter"]), ("", 0))
firebase_mod.fb_auth.revoke_refresh_tokens = real_revoke

# ── Firestore failing: a sentence, never swallowed ────────────────────────────
USERS.docs["u-fs-down"] = {"credentialsValidAfter": 0}
USERS.fail_on("get", "u-fs-down")
problem = firebase_mod.revoke_sessions("u-fs-down")
USERS.clear_failures()
ok("an unreadable users document is reported, not swallowed",
   problem.startswith("The sign-ins already issued could not be cut off:"), problem)
USERS.fail_on("update", "u-fs-down")
problem = firebase_mod.cut_off_issued_tokens("u-fs-down")
USERS.clear_failures()
ok("…and so is an unwritable one", problem.startswith("The sign-ins already issued could not be cut off:"), problem)

# ── Both failing: both reported, in one sentence each ─────────────────────────
firebase_mod.fb_auth.revoke_refresh_tokens = _auth_down
USERS.fail_on("get", "u-fs-down")
problem = firebase_mod.revoke_sessions("u-fs-down")
USERS.clear_failures()
firebase_mod.fb_auth.revoke_refresh_tokens = real_revoke
ok("both failing: both are reported", "could not be revoked" in problem and "could not be cut off" in problem, problem)

eq("no account id: refused with a sentence", firebase_mod.revoke_sessions("  "), "No account id was given.")

# ── Every caller goes through it ──────────────────────────────────────────────
security_src = (ROOT / "app" / "core" / "security.py").read_text()
ok("the security reset revokes through firebase.revoke_sessions (so it now cuts off too)",
   "firebase.revoke_sessions, uid" in security_src)

print()
if failures:
    print(f"{len(failures)} of {checks} session cut-off checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} session cut-off checks passed.")
print("  · security review: revoking sessions cuts off the ID tokens already issued — never backwards, even if")
print("    the refresh-token revocation fails; every failure is reported")
