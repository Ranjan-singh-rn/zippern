"""Sign in and get a session token, from the terminal.

Every authenticated endpoint needs a Bearer token. Owners and staff sign in
through Firebase, which normally happens in a browser — this does the same
exchange from the command line so the API can be tested before the CRM front
end exists.

    python -m scripts.signin tanishque50@gmail.com

It asks for the password, gets a Firebase ID token, exchanges it with our API,
and prints a session token ready to paste into the /docs Authorize box.
"""

from __future__ import annotations

import getpass
import os
import re
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402

FIREBASE_SIGNIN = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={key}"
)


def firebase_web_api_key() -> str:
    """Read the web API key the CRM already uses."""
    if key := os.getenv("FIREBASE_WEB_API_KEY"):
        return key

    env_local = Path(__file__).resolve().parents[2] / "zipper-crm" / ".env.local"
    if env_local.exists():
        match = re.search(
            r"^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$",
            env_local.read_text(),
            re.MULTILINE,
        )
        if match:
            return match.group(1).strip()

    raise SystemExit(
        "Could not find the Firebase web API key.\n"
        "Set FIREBASE_WEB_API_KEY, or make sure zipper-crm/.env.local exists."
    )


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        print("Example:  python -m scripts.signin tanishque50@gmail.com\n")
        return 1

    email = sys.argv[1].strip()
    password = getpass.getpass(f"Password for {email}: ")
    api_base = os.getenv("API_BASE", f"http://127.0.0.1:{settings.api_port}")

    # 1 — Firebase: email + password → ID token
    print("\n  Signing in to Firebase...")
    try:
        fb = httpx.post(
            FIREBASE_SIGNIN.format(key=firebase_web_api_key()),
            json={"email": email, "password": password, "returnSecureToken": True},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        print(f"  ✗ Could not reach Firebase: {exc}")
        return 1

    if fb.status_code != 200:
        reason = fb.json().get("error", {}).get("message", fb.text)
        print(f"  ✗ Firebase rejected the sign-in: {reason}")
        if reason in {"INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD"}:
            print(
                "\n  If this account has never set a password, use the link in the\n"
                "  invitation email first. Or send a fresh one:\n"
                "    Firebase console → Authentication → the user → Reset password"
            )
        return 1

    id_token = fb.json()["idToken"]
    print("  ✓ Firebase ID token obtained")

    # 2 — Our API: ID token → session token
    print(f"  Exchanging with {api_base} ...")
    try:
        api = httpx.post(
            f"{api_base}/api/auth/signin", json={"id_token": id_token}, timeout=30
        )
    except httpx.HTTPError as exc:
        print(f"  ✗ Could not reach the API: {exc}")
        print("    Is uvicorn running?")
        return 1

    if api.status_code != 200:
        print(f"  ✗ API rejected it: {api.status_code} {api.text}")
        return 1

    data = api.json()
    user = data["user"]

    print(f"\n  Signed in as {user['name'] or user['email']}")
    print(f"    role:    {user['role']}")
    print(f"    team:    {user['team'] or '—'}")
    print(f"    expires: {data['expires_at']}")
    print("\n  ── Session token ───────────────────────────────────────────")
    print(f"\n{data['token']}\n")
    print("  ────────────────────────────────────────────────────────────")
    print("\n  To use it in the docs page:")
    print(f"    open {api_base}/docs → Authorize → paste the token above")
    print("\n  Or with curl:")
    print(f'    curl -H "Authorization: Bearer $TOKEN" {api_base}/api/cards/inbox\n')
    return 0


if __name__ == "__main__":
    sys.exit(main())
