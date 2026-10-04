"""Mint a service credential key.

A service key is a standing, unattended secret. Nothing rotates it on a
schedule, nothing expires it, and the job that holds it creates a financial
liability every week. It therefore has to be strong enough that guessing is
never the attack, and it has to be generated somewhere it cannot be
accidentally kept — so this script writes nothing to disk and prints exactly
once.

Run:
    cd backend
    python3 -m scripts.generate_service_key

Or, to pipe it straight into Secret Manager without it ever touching a
terminal scrollback:

    python3 -m scripts.generate_service_key --quiet \\
      | gcloud secrets create SERVICE_KEY_WEEKLY_ACCRUAL --data-file=-

`--quiet` prints the key and nothing else, with no trailing newline, which is
what `gcloud secrets --data-file=-` wants.

There are **three** credentials and they hold different keys on purpose
(`app/core/security.py` → SERVICE_CREDENTIALS). Name the one you are minting:

    python3 -m scripts.generate_service_key --credential reporting --quiet \\
      | gcloud secrets create SERVICE_KEY_REPORTING --data-file=-

    python3 -m scripts.generate_service_key --credential partner-registration \\
      --quiet | gcloud secrets create SERVICE_KEY_PARTNER_REGISTRATION --data-file=-

Each wears its own prefix, so a value found in a log or a shell history says
which credential it is — and therefore which secret version to replace —
without anybody having to compare it against the live one.
"""

from __future__ import annotations

import argparse
import secrets
import sys
from dataclasses import dataclass

# 48 random bytes. `token_urlsafe` base64url-encodes them, giving 64 characters
# of alphabet [A-Za-z0-9_-] and 384 bits of entropy. That is far past the point
# where brute force is the weak link — the realistic risk to this credential is
# that it leaks, not that it is guessed, and `app/core/security.py` is built
# around that assumption. 48 also matches JWT_SECRET in DEPLOYMENT.md, so
# there is one number to remember rather than two.
ENTROPY_BYTES = 48

@dataclass(frozen=True)
class Credential:
    """One credential this script can mint a key for.

    `prefix` is not entropy and is not counted as any. Every key wears its
    purpose so a value found in a log, a shell history or a config file is
    immediately identifiable as a secret rather than an id — and says *which*
    secret, so the right version gets replaced.
    """

    id: str
    prefix: str
    title: str
    backend_secret: str      # Secret Manager name / Cloud Run env var
    functions_secret: str    # the Functions runtime env var holding the same value
    doc_section: str
    unlocks: str


CREDENTIALS: tuple[Credential, ...] = (
    Credential(
        id="weekly-accrual",
        prefix="zpr_wa_",
        title="Weekly accrual service key",
        backend_secret="SERVICE_KEY_WEEKLY_ACCRUAL",
        functions_secret="ZIPPER_ACCRUAL_KEY",
        doc_section="DEPLOYMENT.md § 8",
        unlocks="commission.accrue, commission.preview",
    ),
    Credential(
        id="reporting",
        prefix="zpr_rp_",
        title="Scheduled reporting service key",
        backend_secret="SERVICE_KEY_REPORTING",
        functions_secret="ZIPPER_REPORTING_KEY",
        doc_section="DEPLOYMENT.md § 9",
        unlocks="reports.send, alerts.scan, email.sweep, email.events",
    ),
    Credential(
        id="partner-registration",
        # Deliberately not `zpr_pr_`: that is one transposition away from the
        # reporting prefix `zpr_rp_`, and the entire purpose of a prefix is that
        # somebody reading a value in a log knows *without checking* which
        # secret to replace.
        prefix="zpr_reg_",
        title="Partner registration service key",
        backend_secret="SERVICE_KEY_PARTNER_REGISTRATION",
        functions_secret="ZIPPER_PARTNER_REGISTRATION_KEY",
        doc_section="DEPLOYMENT.md § 10",
        unlocks="partner.register",
    ),
)

CREDENTIALS_BY_ID: dict[str, Credential] = {c.id: c for c in CREDENTIALS}

#: Kept for anything that imported it before there were two credentials.
PREFIX = CREDENTIALS_BY_ID["weekly-accrual"].prefix

#: Every prefix this script can produce. A test that scans the repository for a
#: committed key reads this rather than keeping its own list, so adding a third
#: credential cannot leave a gap in that scan.
PREFIXES: tuple[str, ...] = tuple(c.prefix for c in CREDENTIALS)


def mint(credential: Credential | None = None) -> str:
    chosen = credential or CREDENTIALS_BY_ID["weekly-accrual"]
    return chosen.prefix + secrets.token_urlsafe(ENTROPY_BYTES)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a service credential key for an unattended job."
    )
    parser.add_argument(
        "--credential",
        choices=sorted(CREDENTIALS_BY_ID),
        default="weekly-accrual",
        help=(
            "Which credential this key is for. They are separate keys on "
            "purpose: leaking the ability to email a report must not also "
            "grant the ability to create a commission liability."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Print only the key, with no trailing newline, for piping to gcloud.",
    )
    args = parser.parse_args()

    credential = CREDENTIALS_BY_ID[args.credential]
    key = mint(credential)

    if args.quiet:
        sys.stdout.write(key)
        return 0

    print()
    print(f"  {credential.title}")
    print("  " + "─" * 70)
    print(f"  {key}")
    print("  " + "─" * 70)
    print(f"  {len(key)} characters · {ENTROPY_BYTES * 8} bits of entropy")
    print(f"  Unlocks: {credential.unlocks} — and nothing else.")
    print()
    print("  Next, and only these:")
    print()
    print("    1. Put it in Secret Manager:")
    print("         printf %s '<the key above>' \\")
    print(f"           | gcloud secrets create {credential.backend_secret} --data-file=-")
    print()
    print(f"    2. Give it to Cloud Run as {credential.backend_secret} and to the")
    print(f"       Functions runtime as {credential.functions_secret}.")
    print(f"       See {credential.doc_section}.")
    print()
    print("  Do NOT paste it into backend/.env, functions/.env, a commit, a")
    print("  ticket or a chat. If it leaks, replace the secret version and")
    print("  redeploy both sides — there is no revocation list, the secret's")
    print("  current value IS the credential.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
