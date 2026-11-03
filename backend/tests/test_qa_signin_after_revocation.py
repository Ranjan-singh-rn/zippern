"""E2E round 2 (3 Nov 2026, QA #45) — a sign-in made before a revocation cannot
come back through a refreshed ID token.

Found on the local copy: the Observer reset Test Owner Three's authenticator
(every session ended, refresh tokens revoked, the cut-off written). The browser
Owner Three had been signed in on still held its Firebase refresh token. The
local Auth emulator minted a new ID token from it — new `iat`, the ORIGINAL
`auth_time` — and `/api/auth/signin` accepted that token: Firebase's
`check_revoked` compares `iat` only, trusting Firebase to refuse the refresh
(production does; the emulator does not, and a production revocation can fail).
The result was a fresh pending Owner session, the step a new authenticator is
enrolled from.

`firebase.verify_id_token` now also compares the token's `auth_time` with the
account's `tokensValidAfterTime`. Pinned here:

  * a sign-in made after the last revocation is accepted (same second too);
  * a refreshed token whose sign-in predates the revocation is refused, even
    though its `iat` is new;
  * the old token itself is still refused by Firebase's own check
    (`check_revoked=True` is still asked for);
  * a token naming an account that no longer exists, or with no sign-in time,
    is refused; an account with no revocation recorded is unaffected;
  * both callers that turn an ID token into a session go through it, and the
    sign-in route reports the refusal as an ordinary failed sign-in.

REAL: `app.db.firebase.verify_id_token`, over the stubbed Admin SDK
(tests/harness.py) with the two Admin calls it makes replaced per case.

    python3 -m tests.test_qa_signin_after_revocation
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.db import firebase as firebase_mod  # noqa: E402

fb_auth = firebase_mod.fb_auth

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


# Times from the local run (UTC seconds): Owner Three signed in at 13:05:09, the
# Observer's reset revoked the sessions at 13:07:30, the refresh ran at 13:08:17.
SIGNED_IN = 1793711109      # 2026-11-03T13:05:09Z
REVOKED = 1793711250        # 2026-11-03T13:07:30Z
REFRESHED = 1793711297      # 2026-11-03T13:08:17Z

calls: dict[str, list] = {"verify": [], "get_user": []}
ACCOUNTS: dict[str, object] = {}


def _verify(token, check_revoked=False):
    calls["verify"].append((token, check_revoked))
    if token == "revoked-by-iat":
        # What the real Admin SDK does for an ID token issued before the revocation.
        raise RuntimeError("The Firebase ID token has been revoked.")
    return dict(TOKENS[token])


def _get_user(uid):
    calls["get_user"].append(uid)
    if uid not in ACCOUNTS:
        raise fb_auth.UserNotFoundError(f"No user record found for the provided user ID: {uid}.")
    return ACCOUNTS[uid]


fb_auth.verify_id_token = _verify
fb_auth.get_user = _get_user

ACCOUNTS["owner3"] = types.SimpleNamespace(uid="owner3", tokens_valid_after_timestamp=REVOKED * 1000)
ACCOUNTS["never-revoked"] = types.SimpleNamespace(uid="never-revoked", tokens_valid_after_timestamp=None)
TOKENS = {
    # The token a refresh token kept from before the reset mints: new iat, original sign-in.
    "minted-from-old-refresh": {"uid": "owner3", "iat": REFRESHED, "auth_time": SIGNED_IN, "exp": REFRESHED + 3600},
    # Owner Three signing in again with the password after the reset.
    "fresh-sign-in": {"uid": "owner3", "iat": REFRESHED + 60, "auth_time": REFRESHED + 60, "exp": REFRESHED + 3660},
    # Signed in within the very second of the revocation (Firebase keeps whole seconds).
    "same-second": {"uid": "owner3", "iat": REVOKED, "auth_time": REVOKED, "exp": REVOKED + 3600},
    "no-sign-in-time": {"uid": "owner3", "iat": REFRESHED},
    "bool-sign-in-time": {"uid": "owner3", "iat": REFRESHED, "auth_time": True},
    "deleted-account": {"uid": "gone", "iat": REFRESHED, "auth_time": REFRESHED},
    "never-revoked": {"uid": "never-revoked", "iat": REFRESHED, "auth_time": SIGNED_IN},
    "names-no-account": {"iat": REFRESHED, "auth_time": REFRESHED},
}


def refused(token: str) -> str:
    try:
        firebase_mod.verify_id_token(token)
    except firebase_mod.SignedInBeforeRevocation as exc:
        return f"refused: {exc}"
    except Exception as exc:  # noqa: BLE001 — the Admin SDK's own refusal
        return f"refused by Firebase: {exc}"
    return "accepted"


# ── The case found on the local copy ──────────────────────────────────────────
eq("a token minted after the reset from a refresh token kept from BEFORE it is refused (new iat, old sign-in)",
   refused("minted-from-old-refresh"),
   "refused: This sign-in was made before the account's sessions were ended. Sign in again.")
eq("…the account's revocation time was read for it", calls["get_user"][-1:], ["owner3"])

# ── Sign-ins after the revocation are not affected ────────────────────────────
eq("the Owner signing in again with the password after the reset is accepted", refused("fresh-sign-in"), "accepted")
eq("a sign-in in the very second of the revocation is accepted (whole seconds, not refused by rounding)",
   refused("same-second"), "accepted")
eq("an account with no revocation recorded is unaffected", refused("never-revoked"), "accepted")
eq("a token that names no account is passed back for the caller to refuse (nothing to compare)",
   refused("names-no-account"), "accepted")

# ── Firebase's own check is still asked for ───────────────────────────────────
calls["verify"].clear()
eq("the ID token issued before the reset is still refused by Firebase's own check",
   refused("revoked-by-iat"), "refused by Firebase: The Firebase ID token has been revoked.")
eq("…which is asked for on every verification (check_revoked=True)", calls["verify"], [("revoked-by-iat", True)])

# ── Anything that cannot be compared is refused ───────────────────────────────
eq("no sign-in time on the token: refused", refused("no-sign-in-time"),
   "refused: The ID token does not say when its sign-in was made.")
eq("a sign-in time that is not a number: refused", refused("bool-sign-in-time"),
   "refused: The ID token does not say when its sign-in was made.")
eq("an account that no longer exists: refused", refused("deleted-account"),
   "refused: The account this ID token names no longer exists.")

# ── Both doors from an ID token to a session go through it ────────────────────
security_src = (ROOT / "app" / "core" / "security.py").read_text()
mfa_src = (ROOT / "app" / "services" / "owner_mfa.py").read_text()
ok("/auth/signin verifies through firebase.verify_id_token…",
   "decoded = firebase.verify_id_token(id_token)" in security_src)
ok("…and reports any refusal as a failed sign-in (a new password sign-in is the way back)",
   'raise AuthError("Could not verify sign-in") from exc' in security_src)
ok("the Owner MFA binding verifies its ID token through firebase.verify_id_token too",
   "return firebase.verify_id_token(id_token)" in mfa_src)
fb_src = (ROOT / "app" / "db" / "firebase.py").read_text()
ok("verify_id_token keeps check_revoked=True", "fb_auth.verify_id_token(token, check_revoked=True)" in fb_src)
ok("the comparison is against Firebase's revocation time, not credentialsValidAfter (which a new phone "
   "session moves — comparing it here would sign CRM tabs out whenever the app is opened)",
   "tokens_valid_after_timestamp" in fb_src
   and "credentialsValidAfter" not in fb_src.split("def _refuse_sign_in_older_than_revocation", 1)[1].split("\ndef ", 1)[0])

print()
if failures:
    print(f"{len(failures)} of {checks} sign-in-after-revocation checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} sign-in-after-revocation checks passed.")
print("  · QA #45 (E2E round 2): a refresh token kept from before a reset cannot open a new API session;")
print("    sign-ins made after the revocation are unaffected")
