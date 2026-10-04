"""One person, one canonical account — and what happens when that is not true.

`sign_in_with_firebase` used to resolve a staff row like this:

    staff = await db[C.STAFF].find_one({"uid": uid})
    if staff is None and email:
        staff = await db[C.STAFF].find_one({"email": email})

The second line was a hole. The `email` on a Firebase ID token is not a claim to
the ACCOUNT that address belongs to — a Google sign-in, a phone sign-in with a
profile email, and a brand-new password signup can all produce a token carrying
it. So anybody authenticating as uid B, while a staff row recorded uid A for the
same address, was issued a genuine session with A's role. `issue_session` then
stamped it with uid B. Two identities, one role, no record of the swap.

Adding Google to the CRM would have made that routine rather than obscure: a
Google sign-in mints a NEW uid for an address that already has a password
account, so every owner's first Google login took exactly that path.

These tests are the real `_staff_for_authenticated_uid` against a fake Mongo and
a fake Firebase Auth. No database and no network — `tests/harness.py` stubs the
I/O, so everything under `app/` exercised here is the real, unmodified code.

Run:  python3 -m tests.test_identity_resolution
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402

OWNER_UID = "uid_owner_password"
OWNER_EMAIL = "soumyaranjan.singh7@gmail.com"
GOOGLE_UID = "uid_owner_google"
OBSERVER_EMAIL = "314zipper@gmail.com"


# ── Fakes ─────────────────────────────────────────────────────────────────────


class FakeAuthUser:
    def __init__(self, uid: str) -> None:
        self.uid = uid


class FakeFirebase:
    """`app.db.firebase.get_user` — which uids name a LIVE auth account.

    The distinction this whole change rests on. A recorded uid that still names
    an account means two real identities and a decision for a human; one that
    names nothing means an unreachable row, which is a repair.
    """

    def __init__(self, live: set[str]) -> None:
        self.live = live

    def get_user(self, uid: str):
        return FakeAuthUser(uid) if uid in self.live else None


def token(
    *,
    uid: str,
    email: str = "",
    verified: bool = True,
    provider: str = "password",
) -> dict:
    """A decoded Firebase ID token, shaped as `verify_id_token` returns one."""
    out: dict = {"uid": uid, "firebase": {"sign_in_provider": provider}}
    if email:
        out["email"] = email
        out["email_verified"] = verified
    return out


async def staff_db(rows: list[dict]) -> FakeDb:
    db = FakeDb()
    for row in rows:
        await db[C.STAFF].insert_one(dict(row))
    return db


def owner_row(uid: str = OWNER_UID, email: str = OWNER_EMAIL) -> dict:
    return {
        "uid": uid,
        "email": email,
        "name": "Soumya Ranjan Singh",
        "role": str(Role.OWNER),
        "is_active": True,
    }


# ── Harness ───────────────────────────────────────────────────────────────────

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  ok    {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL  {name}" + (f"\n          {detail}" if detail else ""))


async def resolve(rows: list[dict], decoded: dict, live: set[str]):
    """Run the real resolver. Returns (row_or_None, raised_or_None)."""
    db = await staff_db(rows)
    security.get_db = lambda: db                      # type: ignore[assignment]
    security.firebase = FakeFirebase(live)            # type: ignore[assignment]
    try:
        row = await security._staff_for_authenticated_uid(
            decoded.get("uid", ""),
            (decoded.get("email") or "").lower(),
            email_proven=security._proves_email(decoded),
        )
        return row, None
    except Exception as exc:  # noqa: BLE001
        return None, exc
    finally:
        # Leave the row readable to the caller for the adoption assertions.
        security._last_db = db                        # type: ignore[attr-defined]


# ── The tests ─────────────────────────────────────────────────────────────────


async def test_uid_match_is_the_normal_path() -> None:
    print("\nThe uid matches a staff row — nothing clever required")
    row, err = await resolve([owner_row()], token(uid=OWNER_UID, email=OWNER_EMAIL), {OWNER_UID})
    check("resolves", err is None and row is not None, f"raised {err!r}")
    check("is the owner", row is not None and row["role"] == str(Role.OWNER))


async def test_email_match_on_a_live_other_account_is_refused() -> None:
    print("\nSame email, DIFFERENT live uid — the hole this closes")
    # The owner's password account exists and is live. A Google sign-in for the
    # same Gmail arrives as a different uid. This is the case that used to mint
    # an owner session.
    row, err = await resolve(
        [owner_row()],
        token(uid=GOOGLE_UID, email=OWNER_EMAIL, provider="google.com"),
        {OWNER_UID, GOOGLE_UID},
    )
    check("no row is returned", row is None, f"returned {row!r}")
    check(
        "raises IdentityConflictError",
        isinstance(err, security.IdentityConflictError),
        f"raised {err!r}",
    )
    check(
        "is still an AuthError, so routers keep answering 401",
        isinstance(err, security.AuthError),
    )
    check(
        "the message says what to do",
        err is not None and "connect this one" in str(err).lower(),
        f"message was {str(err)!r}",
    )


async def test_orphaned_row_is_never_adopted() -> None:
    print("\nRecorded uid names NO auth account — a repair job, not a sign-in")
    # This used to ADOPT: rewrite `staff.uid` to the caller and hand back the
    # role, on the grounds that proving the mailbox was the whole control.
    #
    # It is not. `_proves_email` accepts `sign_in_provider == "password"`, and
    # the app's guest email-binding gives an ordinary user exactly that —
    # `EmailAuthProvider.PROVIDER_ID` IS the string "password". Bind an email,
    # use the public password-reset form, sign in, and the token satisfies every
    # test on the way here. Rewriting an identity record on an unauthenticated
    # person's say-so, with no reviewer and no audit entry, is the wrong move
    # whoever is asking.
    row, err = await resolve(
        [owner_row(uid="uid_deleted_long_ago")],
        token(uid=GOOGLE_UID, email=OWNER_EMAIL, provider="google.com"),
        {GOOGLE_UID},          # the recorded uid is NOT live
    )
    check("no row is returned", row is None, f"returned {row!r}")
    check(
        "raises IdentityConflictError",
        isinstance(err, security.IdentityConflictError),
        f"raised {err!r}",
    )
    check(
        "and says it must be reconnected rather than blaming the person",
        err is not None and "reconnected" in str(err).lower(),
        f"message was {str(err)!r}",
    )

    db = security._last_db                             # type: ignore[attr-defined]
    stored = await db[C.STAFF].find_one({"email": OWNER_EMAIL})
    check(
        "the row was NOT rewritten",
        stored is not None and stored["uid"] == "uid_deleted_long_ago",
        f"stored uid is {stored and stored.get('uid')!r}",
    )


async def test_orphaned_row_is_not_adopted_without_proof() -> None:
    print("\nUnreachable row, but the sign-in did not prove the address")

    # A phone sign-in carries no email at all, so it never reaches the fallback.
    row, err = await resolve(
        [owner_row(uid="uid_gone")],
        token(uid="uid_phone", provider="phone"),
        {"uid_phone"},
    )
    check("phone sign-in: no row", row is None and err is None, f"{row!r} / {err!r}")

    # An UNVERIFIED address proves nothing: anyone can sign up with a Gmail
    # they do not own and never click the link.
    row, err = await resolve(
        [owner_row(uid="uid_gone")],
        token(uid="uid_new", email=OWNER_EMAIL, verified=False),
        {"uid_new"},
    )
    check("unverified email: no row", row is None and err is None, f"{row!r} / {err!r}")

    # Verified, but entered by phone. `email_verified` is a property of the
    # ACCOUNT; it does not say this sign-in went through the mailbox.
    row, err = await resolve(
        [owner_row(uid="uid_gone")],
        token(uid="uid_ph2", email=OWNER_EMAIL, verified=True, provider="phone"),
        {"uid_ph2"},
    )
    check("verified but phone provider: no row", row is None and err is None, f"{row!r} / {err!r}")

    db = security._last_db                             # type: ignore[attr-defined]
    stored = await db[C.STAFF].find_one({"email": OWNER_EMAIL})
    check(
        "nothing was adopted",
        stored is not None and stored["uid"] == "uid_gone",
        f"stored uid is {stored and stored.get('uid')!r}",
    )


async def test_the_observer_is_never_adopted() -> None:
    print("\nThe observer — the original hole, under a new name")
    # Its row carries the synthetic uid `observer:<email>`, which
    # `firebase.get_user` correctly reports as no account. Without the
    # role check running FIRST, the orphan branch would adopt the observer onto
    # whichever uid just presented that Gmail — which is the hole, restored.
    observer = {
        "uid": f"observer:{OBSERVER_EMAIL}",
        "email": OBSERVER_EMAIL,
        "name": "Observer",
        "role": str(Role.OBSERVER),
        "is_active": True,
    }
    row, err = await resolve(
        [observer],
        token(uid="uid_someone_with_that_gmail", email=OBSERVER_EMAIL, provider="google.com"),
        {"uid_someone_with_that_gmail"},
    )
    check("the row comes back", err is None and row is not None, f"raised {err!r}")
    check("as the observer, for the caller to refuse by role", row is not None and row["role"] == str(Role.OBSERVER))
    check(
        "and its synthetic uid was NOT overwritten",
        row is not None and row["uid"].startswith("observer:"),
        f"uid is {row and row.get('uid')!r}",
    )

    db = security._last_db                             # type: ignore[attr-defined]
    stored = await db[C.STAFF].find_one({"email": OBSERVER_EMAIL})
    check(
        "nothing was written to it",
        stored is not None and stored["uid"] == f"observer:{OBSERVER_EMAIL}",
        f"stored uid is {stored and stored.get('uid')!r}",
    )


async def test_no_row_at_all() -> None:
    print("\nNobody — falls through to the partner path unchanged")
    row, err = await resolve([], token(uid="uid_stranger", email="nobody@example.com"), {"uid_stranger"})
    check("no row, no raise", row is None and err is None, f"{row!r} / {err!r}")


async def test_proves_email_table() -> None:
    print("\n_proves_email — the exact rule, spelled out")
    cases = [
        ("password + verified",      token(uid="u", email="a@b.com", provider="password"),               True),
        ("google + verified",        token(uid="u", email="a@b.com", provider="google.com"),             True),
        ("password + UNverified",    token(uid="u", email="a@b.com", provider="password", verified=False), False),
        ("phone + verified email",   token(uid="u", email="a@b.com", provider="phone"),                  False),
        ("anonymous",               token(uid="u", provider="anonymous"),                                False),
        ("custom token",            token(uid="u", email="a@b.com", provider="custom"),                  False),
        ("no email at all",         token(uid="u", provider="password"),                                 False),
    ]
    for label, decoded, expected in cases:
        check(f"{label} → {expected}", security._proves_email(decoded) is expected)


async def main() -> int:
    print("=" * 74)
    print("  IDENTITY RESOLUTION — the authenticated uid is the canonical one")
    print("=" * 74)

    await test_uid_match_is_the_normal_path()
    await test_email_match_on_a_live_other_account_is_refused()
    await test_orphaned_row_is_never_adopted()
    await test_orphaned_row_is_not_adopted_without_proof()
    await test_the_observer_is_never_adopted()
    await test_no_row_at_all()
    await test_proves_email_table()

    print("\n" + "=" * 74)
    print(f"  {len(PASSED)} passed, {len(FAILED)} failed")
    print("=" * 74 + "\n")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
